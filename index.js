/**
 * يلا ديلفري (Yalla Delivery) - WhatsApp Delivery Bot
 * -----------------------------------------------------
 * Node.js + @whiskeysockets/baileys + express + qrcode-terminal
 *
 * بوت خدمة عملاء وتوجيه إلى تطبيق Yalla Delivery.
 * إنشاء طلبات التوصيل مباشرةً عبر واتساب معطّل؛ جميع الطلبات تتم من التطبيق فقط.
 *
 * المزايا التقنية:
 *  - إدارة جلسات محلية (useMultiFileAuthState) => لا يطلب QR في كل تشغيل
 *  - إعادة اتصال تلقائي (Auto Reconnect) عبر DisconnectReason
 *  - ذاكرة محادثة خفيفة لكل رقم للمساعد الذكي
 *  - سيرفر express لإبقاء الاستضافة نشطة (Oracle Cloud) + عرض QR على الويب
 *  - لا يجمع بيانات الطلب ولا يحفظ طلبات محلياً
 */

const express = require('express');
const qrcodeTerminal = require('qrcode-terminal');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} = require('@whiskeysockets/baileys');

// تحميل متغيّرات البيئة من ملف .env إن وُجد (ميزة أصلية في Node ≥ 20.6،
// بلا أي مكتبة خارجية). على الاستضافة تُضبط المتغيّرات من لوحة التحكم مباشرةً،
// فلا يضرّ غياب الملف.
try {
  const envPath = path.join(__dirname, '.env');
  if (typeof process.loadEnvFile === 'function' && fs.existsSync(envPath)) {
    process.loadEnvFile(envPath);
  }
} catch (e) {
  console.error('⚠️ تعذّر تحميل ملف .env:', e?.message || e);
}

// ==========================================================
//  الإعدادات العامة
// ==========================================================
const PORT = process.env.PORT || 3000;
// نثبّت مسار جلسة الواتساب على مسار مطلق مرتبط بمجلد المشروع، حتى لا تُفقد
// الجلسة إذا شغّل systemd العملية من دليل عمل مختلف (سبب شائع لطلب ربط جديد).
const AUTH_FOLDER = path.resolve(__dirname, process.env.AUTH_FOLDER || 'auth_info');
// روابط تحميل تطبيق يلا ديلفري (عدّلها لروابطك الحقيقية)
const APP_ANDROID_URL = process.env.APP_ANDROID_URL || 'https://play.google.com/apps/testing/com.mohammedemad333.yalla';
const APP_WEB_URL = process.env.APP_WEB_URL || 'https://yalla.mohammedelrefy28.workers.dev/';

// ===== تسعير التوصيل (مطابق لتطبيق يلا ديلفري — pricing.service.js) =====
// النموذج الفعلي في الخادم: كل 250 متر = 1 شيكل، المسافة بين حي الاستلام
// وحي التسليم (Haversine) × معامل انحناء طرق 1.3 (بدقة رقمين)، وحدّ أدنى 5 شيكل.
// الخادم يعيد حساب السعر من الإحداثيات نفسها التي يرسلها البوت، فيتطابق التقدير.
const CURRENCY = process.env.CURRENCY || '₪';
const METERS_PER_SHEKEL = 250; // كل هذا القدر من الأمتار = 1 شيكل (مطابق للتطبيق)
const ROAD_FACTOR = 1.3;        // معامل تعويض انحناء الطرق مقابل الخط المستقيم
const MIN_FARE = 5;             // أقل أجرة (مطابق للتطبيق)

// أحياء مدينة غزة — لكل حي إحداثيّة تمثيلية [lng, lat] قرب مركزه (مطابقة للتطبيق)
const GAZA_NEIGHBORHOODS = [
  { name: 'الرمال', coordinates: [34.4450, 31.5250] },
  { name: 'الرمال الجنوبي', coordinates: [34.4400, 31.5150] },
  { name: 'تل الهوا', coordinates: [34.4350, 31.5050] },
  { name: 'الشيخ عجلين', coordinates: [34.4250, 31.4950] },
  { name: 'الصبرة', coordinates: [34.4550, 31.5100] },
  { name: 'الزيتون', coordinates: [34.4650, 31.5000] },
  { name: 'الشجاعية', coordinates: [34.4800, 31.5050] },
  { name: 'التفاح', coordinates: [34.4700, 31.5150] },
  { name: 'الدرج', coordinates: [34.4600, 31.5080] },
  { name: 'الجلاء', coordinates: [34.4550, 31.5200] },
  { name: 'الوحدة', coordinates: [34.4500, 31.5150] },
  { name: 'الشيخ رضوان', coordinates: [34.4550, 31.5350] },
  { name: 'النصر', coordinates: [34.4450, 31.5350] },
  { name: 'الكرامة', coordinates: [34.4400, 31.5450] },
  { name: 'السلام', coordinates: [34.4500, 31.5400] },
  { name: 'الجديدة', coordinates: [34.4650, 31.5300] },
  { name: 'الزرقا', coordinates: [34.4700, 31.5450] },
  { name: 'الشاطئ', coordinates: [34.4300, 31.5300] },
  { name: 'الميناء', coordinates: [34.4250, 31.5200] },
  { name: 'المنطقة الصناعية', coordinates: [34.4800, 31.4900] },
];

// طريقة الربط: رمز اقتران (Pairing Code) بدل مسح QR.
// فعّلها بوضع USE_PAIRING_CODE=true ورقم واتساب الأعمال (أرقام فقط بدون + أو مسافات).
const USE_PAIRING_CODE = String(process.env.USE_PAIRING_CODE || 'true').toLowerCase() === 'true';
// رقم واتساب الأعمال: +970593456405  (بصيغة دولية بدون علامة +)
const BUSINESS_NUMBER = (process.env.BUSINESS_NUMBER || '970593456405').replace(/\D/g, '');

// ===== المساعد الذكي (Google Gemini — مجاني) =====
// عند تعذّر تطابق رسالة العميل مع أمر معروف، تُحال إلى المساعد الذكي ليجيب
// بلغة طبيعية عن الأسئلة العامة ويوجّه العميل لإنشاء طلب. مجاني عبر مفتاح من
// https://aistudio.google.com/apikey — فعّله بضبط GEMINI_API_KEY.
const AI_ENABLED = String(process.env.AI_ENABLED ?? 'true').toLowerCase() === 'true';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
// نموذج احتياطي يُجرَّب تلقائياً إذا كان النموذج الأساسي غير موجود/غير مدعوم (404).
const GEMINI_FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || 'gemini-1.5-flash';

// ===== مزوّد بديل: Groq (مجاني وسريع، مفتاح بسيط gsk_...) =====
// مفيد إذا كانت مفاتيح Gemini مقيّدة بسياسة مؤسسة (تُصدَر بصيغة AQ. غير مدعومة).
// احصل على مفتاح مجاني من: https://console.groq.com/keys
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-20b';
// نموذج Groq احتياطي يُجرَّب تلقائياً إذا كان الأساسي غير متاح (404).
const GROQ_FALLBACK_MODEL = process.env.GROQ_FALLBACK_MODEL || 'openai/gpt-oss-120b';
// اختيار المزوّد: 'gemini' | 'groq' | 'auto' (الافتراضي: يختار أول مفتاح متوفّر).
const AI_PROVIDER = String(process.env.AI_PROVIDER || 'auto').toLowerCase();

// يحدّد المزوّد النشط بناءً على الإعداد والمفاتيح المتوفّرة (يرجّع null إن لا مفتاح).
function activeProvider() {
  if (AI_PROVIDER === 'gemini') return GEMINI_API_KEY ? 'gemini' : null;
  if (AI_PROVIDER === 'groq') return GROQ_API_KEY ? 'groq' : null;
  if (GEMINI_API_KEY) return 'gemini';
  if (GROQ_API_KEY) return 'groq';
  return null;
}
// أقصى عدد من الرسائل (سؤال+جواب) نحتفظ به لكل عميل لسياق المحادثة.
const AI_MEMORY_TURNS = Math.max(0, parseInt(process.env.AI_MEMORY_TURNS || '6', 10) || 0);
// حدّ لعدد أسئلة المساعد الذكي لكل عميل خلال نافذة زمنية (حماية للحصة المجانية).
const AI_RATE_MAX = Math.max(0, parseInt(process.env.AI_RATE_MAX || '8', 10) || 0); // 0 = بلا حدّ
const AI_RATE_WINDOW_MS = Math.max(1, parseInt(process.env.AI_RATE_WINDOW_SEC || '60', 10) || 60) * 1000;

// إحصاءات حيّة لحالة المساعد الذكي — تُعرض في أمر التشخيص و/ai-status.
const aiStats = {
  totalCalls: 0,
  failures: 0,
  lastOkAt: null,
  lastError: null,
  lastErrorAt: null,
  activeModel: GEMINI_MODEL, // نموذج Gemini النشط (قد يتحوّل للاحتياطي تلقائياً)
  activeGroqModel: GROQ_MODEL, // نموذج Groq النشط (قد يتحوّل للاحتياطي تلقائياً)
  groqLimits: null, // آخر لقطة لحدود Groq من ترويسات الاستجابة (الاستخدام المتبقي)
};

// يقرأ ترويسات حدود المعدّل من استجابة Groq (المتوافقة مع OpenAI) ويحفظ لقطة
// بالمتبقّي (طلبات/رموز) لعرضها في تقرير التشخيص. الترويسات غير حسّاسة.
function captureGroqLimits(res) {
  try {
    const h = (name) => res.headers.get(name);
    const snap = {
      limitRequests: h('x-ratelimit-limit-requests'),
      remainingRequests: h('x-ratelimit-remaining-requests'),
      resetRequests: h('x-ratelimit-reset-requests'),
      limitTokens: h('x-ratelimit-limit-tokens'),
      remainingTokens: h('x-ratelimit-remaining-tokens'),
      resetTokens: h('x-ratelimit-reset-tokens'),
      capturedAt: new Date().toISOString(),
    };
    // نحفظ فقط إذا وُجدت أي معلومة مفيدة.
    if (snap.limitRequests || snap.remainingRequests || snap.remainingTokens) {
      aiStats.groqLimits = snap;
    }
  } catch (_) {
    /* الترويسات اختيارية — نتجاهل أي خطأ بأمان */
  }
}

const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });

// حواجز أمان: لا يتوقف البوت بسبب خطأ عابر
process.on('uncaughtException', (e) => console.error('⚠️ خطأ غير متوقع:', e?.message || e));
process.on('unhandledRejection', (e) => console.error('⚠️ وعد مرفوض:', e?.message || e));

let latestQR = null;
let connectionStatus = 'disconnected';

// حرّاس لمنع الاتصالات المتوازية وتكرار طلب رمز الاقتران
let currentSock = null;
let reconnectScheduled = false;
let pairingRequested = false;
let pairingAttempts = 0;
const MAX_PAIRING_ATTEMPTS = 3; // عدد محاولات الاقتران قبل التوقف وطلب الانتظار

// جدولة إعادة اتصال واحدة فقط (لا تتراكم)
function scheduleReconnect(delayMs = 5000) {
  if (reconnectScheduled) return;
  reconnectScheduled = true;
  console.log(`🔄 إعادة الاتصال بعد ${delayMs / 1000} ثانية...`);
  setTimeout(() => {
    reconnectScheduled = false;
    startBot().catch((e) => console.error('فشل إعادة الاتصال:', e.message));
  }, delayMs);
}

// حذف جلسة فاسدة عند تسجيل الخروج (تُعاد توليدها عند الربط من جديد)
function clearAuth() {
  try {
    fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
    console.log('🧹 تم حذف الجلسة القديمة، سيُطلب رمز اقتران جديد.');
  } catch (e) {
    console.error('تعذّر حذف مجلد الجلسة:', e.message);
  }
}

// ==========================================================
/* خدمة العملاء عبر واتساب — الطلبات تتم من التطبيق فقط */
// ==========================================================
const STATES = { IDLE: 'IDLE' };

// نحتفظ بجلسة خفيفة فقط لذاكرة المساعد الذكي وحدّ المعدّل.
// لا توجد آلة حالات لإنشاء طلبات عبر واتساب.
const sessions = {};

function getSession(jid) {
  if (!sessions[jid]) {
    sessions[jid] = { state: STATES.IDLE };
  }
  return sessions[jid];
}

function resetSession(jid) {
  sessions[jid] = { state: STATES.IDLE };
}

// ==========================================================
//  رسائل ثابتة
// ==========================================================
const APP_DOWNLOAD_MESSAGE =
  '📲 *الطلبات متاحة عبر تطبيق يلا ديلفري فقط*\n\n' +
  'افتح التطبيق لإنشاء الطلب، معرفة السعر، ومتابعة حالة التوصيل:\n\n' +
  `🤖 أندرويد: ${APP_ANDROID_URL}\n` +
  `🌐 تطبيق الويب: ${APP_WEB_URL}`;

const WELCOME_MESSAGE =
  'أهلاً بك في يلا ديلفري! 🛵\n\n' +
  'لضمان تسجيل الطلب وتتبع حالته بشكل صحيح، *لا نستقبل طلبات توصيل مباشرة عبر واتساب*.\n' +
  'يمكنك إنشاء طلبك من التطبيق فقط.\n\n' +
  APP_DOWNLOAD_MESSAGE +
  '\n\nكيف يمكننا مساعدتك؟ اختر رقماً:\n\n' +
  '1️⃣ فتح / تحميل التطبيق 📲\n' +
  '2️⃣ استفسار عن الأسعار والمناطق 💰\n' +
  '3️⃣ التحدث مع الدعم الفني 📞';

const PRICING_MESSAGE =
  '💰 *الأسعار*\n\n' +
  '• سعر التوصيل يُحسب *حسب المسافة* بين حي الاستلام وحي التسليم.\n' +
  `• كل ${METERS_PER_SHEKEL} متراً = 1 ${CURRENCY} تقريباً.\n` +
  `• أقل سعر توصيل: ${MIN_FARE} ${CURRENCY}.\n\n` +
  '📲 لمعرفة السعر الدقيق وإنشاء الطلب، استخدم تطبيق يلا ديلفري:\n' +
  `${APP_WEB_URL}`;

const SUPPORT_NUMBER = process.env.SUPPORT_NUMBER || '+970593456405';

// أرقام الإدارة: تُميَّز لعرض أوامر التشخيص (مثل "/حالة") التي لا يراها العملاء.
const ADMIN_NUMBERS = Array.from(
  new Set(
    [
      ...(process.env.ADMIN_NUMBERS || '').split(','),
      BUSINESS_NUMBER,
      SUPPORT_NUMBER,
    ]
      .map((value) => (value || '').replace(/\D/g, ''))
      .filter((value) => value.length >= 8),
  ),
);

function isAdmin(phone) {
  const normalizedPhone = (phone || '').replace(/\D/g, '');
  if (!normalizedPhone) return false;
  const tail = normalizedPhone.slice(-9);
  return ADMIN_NUMBERS.some(
    (admin) => admin === normalizedPhone || admin.slice(-9) === tail,
  );
}

const SUPPORT_MESSAGE =
  '📞 *الدعم الفني*\n\n' +
  'فريقنا جاهز لمساعدتك:\n' +
  `• واتساب/اتصال: ${SUPPORT_NUMBER}\n` +
  '• أوقات العمل: يومياً 9 صباحاً - 11 مساءً.\n\n' +
  '📲 إنشاء الطلبات يتم من تطبيق يلا ديلفري فقط.';

const GREETING_KEYWORDS = [
  'مرحبا', 'مرحباً', 'السلام عليكم', 'اهلا', 'أهلا', 'هلا',
  'hi', 'hello', 'start', 'بدء', 'القائمة', 'menu',
];
const ORDER_KEYWORDS = [
  'طلب', 'طلب جديد', 'توصيل', 'اطلب', 'أطلب', 'اريد طلب',
  'بدي اطلب', 'بدي أطلب', 'order',
];
const PRICING_KEYWORDS = ['اسعار', 'أسعار', 'سعر', 'مناطق', 'استفسار'];
const SUPPORT_KEYWORDS = ['دعم', 'مساعدة', 'مساعده', 'support'];
const QUESTION_WORDS = [
  'كم', 'بكم', 'كيف', 'وين', 'فين', 'اين', 'أين', 'متى', 'امتى',
  'إمتى', 'ليش', 'ليه', 'لماذا', 'هل', 'شو', 'ايش', 'إيش', 'ايه', 'وش',
];

function normalize(text) {
  return (text || '').trim().toLowerCase();
}

function includesAny(text, list) {
  const normalized = normalize(text);
  return list.some(
    (keyword) =>
      normalized === normalize(keyword) || normalized.includes(normalize(keyword)),
  );
}

function looksLikeQuestion(text) {
  const normalized = normalize(text);
  if (!normalized) return false;
  if (normalized.includes('؟') || normalized.includes('?')) return true;
  return QUESTION_WORDS.some((word) => {
    const keyword = normalize(word);
    return (
      normalized === keyword ||
      normalized.startsWith(keyword + ' ') ||
      normalized.endsWith(' ' + keyword) ||
      normalized.includes(' ' + keyword + ' ')
    );
  });
}

// ==========================================================
//  المساعد الذكي (Google Gemini)
// ==========================================================
// تعليمات النظام: تعرّف المساعد كموظف خدمة عملاء ليلا ديلفري، وتزوّده
// بالحقائق (الأسعار، المناطق، خطوات الطلب) ليجيب بدقة ولا يخترع معلومات.
function buildAISystemPrompt() {
  return [
    'أنت "مساعد يلا ديلفري" الذكي، موظف خدمة عملاء ودود لخدمة توصيل في مدينة غزة.',
    'ردّ دائماً باللغة العربية (باللهجة التي يكتب بها العميل)، وبإيجاز ووضوح، واستخدم إيموجي باعتدال.',
    '',
    'معلومات الخدمة التي يجب أن تعتمد عليها فقط (لا تخترع معلومات غير مذكورة):',
    `- سعر التوصيل يُحسب حسب المسافة: كل ${METERS_PER_SHEKEL} متر ≈ 1 ${CURRENCY}، وأقل أجرة ${MIN_FARE} ${CURRENCY}.`,
    '- السعر النهائي وإنشاء الطلب يتمان من تطبيق يلا ديلفري فقط.',
    `- المناطق المخدومة (أحياء غزة): ${GAZA_NEIGHBORHOODS.map((n) => n.name).join('، ')}.`,
    '- أوقات عمل الدعم: يومياً 9 صباحاً حتى 11 مساءً.',
    `- رقم الدعم للتواصل المباشر: ${SUPPORT_NUMBER}.`,
    `- روابط التطبيق — أندرويد: ${APP_ANDROID_URL} | الويب: ${APP_WEB_URL}.`,
    '',
    'قواعد مهمة:',
    '- لا تستقبل ولا تنشئ طلب توصيل داخل واتساب، ولا تطلب من العميل الاسم أو العنوان أو تفاصيل الطلب أو الدفع.',
    '- إذا أراد العميل إنشاء طلب، وجّهه مباشرة إلى تطبيق يلا ديلفري وأرسل له رابط التطبيق.',
    '- إذا سُئلت عن أمر خارج نطاق الخدمة أو لا تعرف إجابته، اعتذر بلطف واقترح التواصل مع الدعم.',
    '- لا تَعِد بأسعار أو أوقات محددة رقمياً؛ وجّه العميل للتطبيق لمعرفة التفاصيل الفعلية.',
    '- اجعل الرد قصيراً (بضعة أسطر) ومناسباً لمحادثة واتساب.',
  ].join('\n');
}

// ذاكرة محادثة قصيرة لكل عميل (للسياق فقط) — لا تُحفظ على القرص.
// تُخزَّن بصيغة محايدة { role: 'user' | 'model', text } وتُحوَّل لكل مزوّد عند الاستدعاء.
function pushAIHistory(session, role, text) {
  if (!AI_MEMORY_TURNS) return;
  if (!Array.isArray(session.aiHistory)) session.aiHistory = [];
  session.aiHistory.push({ role, text });
  // نُبقي آخر (AI_MEMORY_TURNS × 2) رسالة كحدّ أقصى.
  const max = AI_MEMORY_TURNS * 2;
  if (session.aiHistory.length > max) {
    session.aiHistory = session.aiHistory.slice(-max);
  }
}

// يترجم رمز حالة خطأ Gemini إلى رسالة عربية مفهومة (لسجلّات التشخيص).
function classifyGeminiError(status, data) {
  const msg = data?.error?.message || '';
  if (status === 429) return 'انتهت الحصة المجانية مؤقتاً (rate limit / quota) — أعد المحاولة لاحقاً.';
  if (status === 400 && /api key not valid|api_key_invalid/i.test(msg)) return 'مفتاح GEMINI_API_KEY غير صالح.';
  if (status === 403) return 'المفتاح غير مصرّح له (403) — تأكد من تفعيل Generative Language API للمفتاح.';
  if (status === 404) return `النموذج "${aiStats.activeModel}" غير موجود/غير مدعوم (404).`;
  if (status >= 500) return `خطأ مؤقت من خادم Gemini (${status}).`;
  return `خطأ ${status}: ${msg || 'غير معروف'}`;
}

// يحوّل تنسيق ماركداون الذي قد يعيده النموذج إلى تنسيق واتساب المدعوم.
function toWhatsAppText(s) {
  if (!s) return s;
  return String(s)
    .replace(/\*\*(.+?)\*\*/g, '*$1*') // **عريض** → *عريض*
    .replace(/^#{1,6}\s*/gm, '') // إزالة رؤوس الماركداون (#)
    .replace(/^\s*[-*]\s+/gm, '• ') // توحيد النقاط
    .replace(/\n{3,}/g, '\n\n') // تقليص الأسطر الفارغة المتتالية
    .trim();
}

// يترجم خطأ Groq إلى رسالة عربية مفهومة.
function classifyGroqError(status, data) {
  const msg = data?.error?.message || '';
  if (status === 429) return 'انتهت حصة Groq المجانية مؤقتاً (rate limit) — أعد المحاولة لاحقاً.';
  if (status === 401) return 'مفتاح GROQ_API_KEY غير صالح (401).';
  if (status === 404) return `نموذج Groq "${aiStats.activeGroqModel}" غير موجود (404).`;
  if (status >= 500) return `خطأ مؤقت من خادم Groq (${status}).`;
  return `خطأ Groq ${status}: ${msg || 'غير معروف'}`;
}

// نداء Gemini (generativelanguage REST). يحوّل السجلّ المحايد لصيغة contents.
// عند 404 على النموذج الأساسي، يُجرَّب النموذج الاحتياطي تلقائياً مرة واحدة.
async function callGemini({ system, history = [], prompt, temperature = 0.6, maxOutputTokens = 512, timeoutMs = 20000 }) {
  const contents = [
    ...history.map((h) => ({ role: h.role === 'model' ? 'model' : 'user', parts: [{ text: h.text }] })),
    { role: 'user', parts: [{ text: prompt }] },
  ];

  const models = [aiStats.activeModel];
  if (GEMINI_FALLBACK_MODEL && GEMINI_FALLBACK_MODEL !== aiStats.activeModel) {
    models.push(GEMINI_FALLBACK_MODEL);
  }

  let last = { ok: false, status: 0, text: '', error: 'no attempt' };
  for (const model of models) {
    // المفتاح يُمرَّر عبر ترويسة x-goog-api-key (لا يظهر في سجلّات الرابط).
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const body = {
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      contents,
      generationConfig: { temperature, maxOutputTokens },
    };
    try {
      const res = await fetchWithTimeout(
        url,
        { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY }, body: JSON.stringify(body) },
        timeoutMs,
      );
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        const text = (data?.candidates?.[0]?.content?.parts || []).map((p) => p?.text || '').join('').trim();
        if (model !== aiStats.activeModel) {
          console.log(`ℹ️ تحوّل المساعد الذكي إلى النموذج الاحتياطي: ${model}`);
          aiStats.activeModel = model;
        }
        return { ok: true, status: 200, text, error: null };
      }
      last = { ok: false, status: res.status, text: '', error: classifyGeminiError(res.status, data) };
      if (res.status !== 404) return last; // النموذج الاحتياطي يفيد فقط مع 404
    } catch (err) {
      return { ok: false, status: 0, text: '', error: `تعذّر الاتصال: ${err?.message || err}` };
    }
  }
  return last;
}

// نداء Groq (واجهة متوافقة مع OpenAI). مفتاح بسيط عبر ترويسة Authorization.
// عند 404 على النموذج الأساسي، يُجرَّب النموذج الاحتياطي تلقائياً مرة واحدة.
async function callGroq({ system, history = [], prompt, temperature = 0.6, maxOutputTokens = 512, timeoutMs = 20000 }) {
  const messages = [
    ...(system ? [{ role: 'system', content: system }] : []),
    ...history.map((h) => ({ role: h.role === 'model' ? 'assistant' : 'user', content: h.text })),
    { role: 'user', content: prompt },
  ];

  const models = [aiStats.activeGroqModel];
  if (GROQ_FALLBACK_MODEL && GROQ_FALLBACK_MODEL !== aiStats.activeGroqModel) {
    models.push(GROQ_FALLBACK_MODEL);
  }

  let last = { ok: false, status: 0, text: '', error: 'no attempt' };
  for (const model of models) {
    try {
      const res = await fetchWithTimeout(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GROQ_API_KEY}` },
          body: JSON.stringify({ model, messages, temperature, max_tokens: maxOutputTokens }),
        },
        timeoutMs,
      );
      captureGroqLimits(res); // نلتقط الاستخدام المتبقي من الترويسات (متاح حتى مع الخطأ)
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        const text = (data?.choices?.[0]?.message?.content || '').trim();
        if (model !== aiStats.activeGroqModel) {
          console.log(`ℹ️ تحوّل المساعد الذكي إلى نموذج Groq الاحتياطي: ${model}`);
          aiStats.activeGroqModel = model;
        }
        return { ok: true, status: 200, text, error: null };
      }
      last = { ok: false, status: res.status, text: '', error: classifyGroqError(res.status, data) };
      if (res.status !== 404) return last; // النموذج الاحتياطي يفيد فقط مع 404
    } catch (err) {
      return { ok: false, status: 0, text: '', error: `تعذّر الاتصال بـ Groq: ${err?.message || err}` };
    }
  }
  return last;
}

// موزّع: يستدعي المزوّد النشط (gemini | groq). يرجّع { ok, text, error, provider }.
async function callAI(opts) {
  const provider = activeProvider();
  if (!provider) return { ok: false, provider: null, error: 'لا يوجد مزوّد مضبوط (GEMINI_API_KEY أو GROQ_API_KEY).' };
  const r = provider === 'groq' ? await callGroq(opts) : await callGemini(opts);
  return { ...r, provider };
}

// وصف النموذج النشط للعرض في التشخيص.
function activeModelLabel(provider) {
  if (provider === 'groq') return `groq:${aiStats.activeGroqModel}`;
  if (provider === 'gemini') return `gemini:${aiStats.activeModel}`;
  return '—';
}

// فحص حيّ سريع لحالة المساعد الذكي (نداء صغير للتأكد أنه يردّ فعلاً).
async function pingAI() {
  if (!AI_ENABLED) return { ok: false, reason: 'معطّل (AI_ENABLED=false)' };
  const provider = activeProvider();
  if (!provider) return { ok: false, reason: 'لا يوجد مفتاح مضبوط (GEMINI_API_KEY أو GROQ_API_KEY)' };
  const r = await callAI({ prompt: 'قل "جاهز" فقط.', maxOutputTokens: 16, timeoutMs: 12000 });
  return r.ok ? { ok: true, provider, model: activeModelLabel(provider) } : { ok: false, provider, reason: r.error };
}

// حدّ معدّل بسيط لكل عميل: نافذة منزلقة على طوابع الأسئلة الزمنية.
function isAIRateLimited(session) {
  if (!AI_RATE_MAX) return false;
  const now = Date.now();
  if (!Array.isArray(session.aiCallTimes)) session.aiCallTimes = [];
  session.aiCallTimes = session.aiCallTimes.filter((t) => now - t < AI_RATE_WINDOW_MS);
  if (session.aiCallTimes.length >= AI_RATE_MAX) return true;
  session.aiCallTimes.push(now);
  return false;
}

// استدعاء المساعد والحصول على ردّ نصي. يرجّع null عند أي فشل ليعود البوت
// لسلوكه الافتراضي (رسالة الترحيب) بلا أعطال.
async function askAI(session, userText) {
  if (!AI_ENABLED || !activeProvider()) return null;
  const prompt = (userText || '').trim();
  if (!prompt) return null;

  const history = Array.isArray(session.aiHistory) ? session.aiHistory : [];
  aiStats.totalCalls += 1;

  const r = await callAI({
    system: buildAISystemPrompt(),
    history,
    prompt,
    temperature: 0.6,
    maxOutputTokens: 512,
  });

  if (!r.ok) {
    aiStats.failures += 1;
    aiStats.lastError = r.error;
    aiStats.lastErrorAt = new Date().toISOString();
    console.error(`⚠️ المساعد الذكي: ${r.error}`);
    return null;
  }

  const reply = toWhatsAppText(r.text);
  if (!reply) return null;

  aiStats.lastOkAt = new Date().toISOString();
  pushAIHistory(session, 'user', prompt);
  pushAIHistory(session, 'model', reply);
  return reply;
}

// أوامر التشخيص الإدارية (لا يراها العملاء) — للاطمئنان على المساعد الذكي.
const ADMIN_STATUS_COMMANDS = ['/حالة', '/الحالة', '/status', '/ai', 'حالة المساعد', 'فحص المساعد', 'ai status'];
function isAdminStatusCommand(raw) {
  const t = normalize(raw);
  return ADMIN_STATUS_COMMANDS.some((c) => t === normalize(c));
}

// يبني تقرير حالة المساعد الذكي (يشمل فحصاً حيّاً) لأرقام الإدارة.
async function buildAdminStatusMessage() {
  const provider = activeProvider();
  const geminiKey = GEMINI_API_KEY ? `✅ (…${GEMINI_API_KEY.slice(-4)})` : '❌ غير مضبوط';
  const groqKey = GROQ_API_KEY ? `✅ (…${GROQ_API_KEY.slice(-4)})` : '❌ غير مضبوط';
  const lines = [
    '🩺 *حالة المساعد الذكي*',
    '',
    `• مُفعّل (AI_ENABLED): ${AI_ENABLED ? 'نعم ✅' : 'لا ❌'}`,
    `• المزوّد النشط: ${provider ? provider : '❌ لا يوجد'}`,
    `• مفتاح Gemini: ${geminiKey}`,
    `• مفتاح Groq: ${groqKey}`,
    `• النموذج النشط: ${provider ? activeModelLabel(provider) : '—'}`,
    `• ذاكرة السياق: ${AI_MEMORY_TURNS} دور`,
    `• حدّ المعدّل: ${AI_RATE_MAX ? `${AI_RATE_MAX} سؤال/${AI_RATE_WINDOW_MS / 1000}ث` : 'بلا حدّ'}`,
    `• عدّاد النداءات: ${aiStats.totalCalls} (فشل: ${aiStats.failures})`,
  ];
  if (aiStats.lastError) {
    lines.push(`• آخر خطأ: ${aiStats.lastError} (${aiStats.lastErrorAt || '?'})`);
  }

  // فحص حيّ فعلي (يُحدّث كذلك لقطة حدود Groq من ترويسات الاستجابة).
  const ping = await pingAI();
  lines.push('', ping.ok ? `🟢 فحص حيّ: يعمل الآن (${ping.model}).` : `🔴 فحص حيّ: لا يعمل — ${ping.reason}`);

  // الاستخدام المتبقّي (Groq فقط — من ترويسات آخر نداء).
  if (provider === 'groq') {
    const g = aiStats.groqLimits;
    if (g && (g.remainingRequests || g.remainingTokens)) {
      lines.push('', '📊 *الاستخدام المتبقّي (Groq):*');
      if (g.remainingRequests) {
        const limit = g.limitRequests ? `/${g.limitRequests}` : '';
        const reset = g.resetRequests ? ` — تتجدّد بعد ${g.resetRequests}` : '';
        lines.push(`• الطلبات: ${g.remainingRequests}${limit}${reset}`);
      }
      if (g.remainingTokens) {
        const limit = g.limitTokens ? `/${g.limitTokens}` : '';
        const reset = g.resetTokens ? ` — تتجدّد بعد ${g.resetTokens}` : '';
        lines.push(`• الرموز (tokens): ${g.remainingTokens}${limit}${reset}`);
      }
    } else {
      lines.push('', 'ℹ️ الاستخدام المتبقّي غير متوفّر بعد (يظهر بعد أول ردّ فعلي).');
    }
  }

  if (!provider) {
    lines.push(
      '',
      'ℹ️ للتشغيل اختر أحد الخيارين وأضِف المفتاح في بيئة الاستضافة ثم أعد التشغيل:',
      '• Gemini (مفتاح AIzaSy… فقط، ليس AQ.): https://aistudio.google.com/apikey',
      '• Groq (مجاني وبسيط gsk_…): https://console.groq.com/keys',
    );
  }
  return lines.join('\n');
}

async function handleMessage(jid, phone, text, hasMedia = false) {
  const session = getSession(jid);
  const raw = (text || '').trim();

  // أوامر تشخيص إدارية — تُعالَج قبل كل شيء وتُتاح لأرقام الإدارة فقط.
  if (isAdminStatusCommand(raw)) {
    if (isAdmin(phone)) return await buildAdminStatusMessage();
    console.log(`ℹ️ [تشخيص] أمر حالة من رقم غير مُدرج بالإدارة: "${phone}"`);
    return (
      '⚠️ هذا الأمر مخصّص للإدارة فقط.\n\n' +
      `🆔 مُعرّفك كما يستقبله البوت: *${phone}*\n\n` +
      'لتفعيل الأمر لك: أضِف هذا الرقم بالضبط إلى ADMIN_NUMBERS في ملف .env ثم أعد تشغيل الخدمة.'
    );
  }

  // أي طلب صريح أو اختيار رقم 1 يفتح مسار التطبيق فقط.
  const isQuestion = looksLikeQuestion(raw);
  const wantsApp =
    raw === '1' ||
    includesAny(raw, ['تطبيق', 'التطبيق', 'تحميل', 'حمل', 'app', 'download', 'رابط']) ||
    (!isQuestion && includesAny(raw, ORDER_KEYWORDS));
  if (wantsApp) return APP_DOWNLOAD_MESSAGE;

  const wantsPricing =
    raw === '2' || (!isQuestion && includesAny(raw, PRICING_KEYWORDS));
  if (wantsPricing) return PRICING_MESSAGE;

  const wantsSupport =
    raw === '3' || (!isQuestion && includesAny(raw, SUPPORT_KEYWORDS));
  if (wantsSupport) return SUPPORT_MESSAGE;

  if (!raw || includesAny(raw, GREETING_KEYWORDS)) {
    return WELCOME_MESSAGE;
  }

  // الصور والملفات لم تعد تُستخدم لإثبات الدفع أو إنشاء طلب.
  if (hasMedia && !raw) {
    return (
      '📎 تم استلام الملف، لكن إنشاء الطلبات وإرسال تفاصيلها لا يتم عبر واتساب.\n\n' +
      APP_DOWNLOAD_MESSAGE
    );
  }

  // الأسئلة الحرة تبقى للمساعد الذكي، مع منع أي مسار طلب داخل واتساب.
  if (AI_ENABLED && activeProvider()) {
    if (isAIRateLimited(session)) {
      return (
        'وصلت لحدّ الأسئلة السريعة 🙏 انتظر لحظات ثم أعد المحاولة.\n\n' +
        '📲 لإنشاء طلب استخدم تطبيق يلا ديلفري:\n' +
        APP_WEB_URL
      );
    }
    const aiReply = await askAI(session, raw);
    if (aiReply) return aiReply;
  }

  if (includesAny(raw, PRICING_KEYWORDS)) return PRICING_MESSAGE;
  if (includesAny(raw, SUPPORT_KEYWORDS)) return SUPPORT_MESSAGE;
  if (includesAny(raw, ORDER_KEYWORDS)) return APP_DOWNLOAD_MESSAGE;
  return WELCOME_MESSAGE;
}

// ==========================================================
//  استخراج نص الرسالة من كائن Baileys
// ==========================================================
// هل الرسالة تحوي وسائط (صورة/مستند) — لاستقبال إشعار الحوالة؟
function hasMediaMessage(msg) {
  const m = msg.message;
  if (!m) return false;
  return !!(m.imageMessage || m.documentMessage || m.documentWithCaptionMessage);
}

function extractText(msg) {
  const m = msg.message;
  if (!m) return '';
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.buttonsResponseMessage?.selectedButtonId ||
    m.listResponseMessage?.singleSelectReply?.selectedRowId ||
    ''
  );
}

// ==========================================================
//  اتصال WhatsApp (Baileys)
// ==========================================================
async function startBot() {
  // إغلاق أي اتصال قديم قبل فتح واحد جديد (يمنع الاتصالات المتوازية)
  if (currentSock) {
    try { currentSock.ev.removeAllListeners(); currentSock.end(); } catch (_) {}
    currentSock = null;
  }

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
  const { version } = await fetchLatestBaileysVersion();
  const usePairing = USE_PAIRING_CODE && !state.creds.registered;

  const sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    // أثناء الربط برمز الاقتران نُعطّل QR حتى لا يتنافس الأسلوبان
    qrTimeout: usePairing ? undefined : 60000,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    browser: ['Yalla Delivery', 'Chrome', '120.0.0'],
    markOnlineOnConnect: false,
    keepAliveIntervalMs: 30000,
  });
  currentSock = sock;

  // حفظ الاعتماد مع حماية من الانهيار لو حُذف المجلد أثناء الكتابة
  sock.ev.on('creds.update', async () => {
    try {
      await saveCreds();
    } catch (e) {
      /* المجلد قد يكون حُذف أثناء تنظيف جلسة غير صالحة — نتجاهل بأمان */
    }
  });

  // الربط برمز اقتران (Pairing Code) — يُطلب رمز جديد لكل محاولة اتصال غير مربوطة
  if (usePairing && !pairingRequested) {
    pairingRequested = true;
    pairingAttempts += 1;
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(BUSINESS_NUMBER);
        const pretty = code?.match(/.{1,4}/g)?.join('-') || code;
        console.log('\n============================================');
        console.log(`🔑 رمز اقتران واتساب (${BUSINESS_NUMBER}) — محاولة ${pairingAttempts}/${MAX_PAIRING_ATTEMPTS}:`);
        console.log(`   >>>  ${pretty}  <<<`);
        console.log('⏱️ أدخله بسرعة (خلال ~دقيقة) من الهاتف:');
        console.log('   واتساب ← الأجهزة المرتبطة ← ربط جهاز');
        console.log('   ← ربط برقم الهاتف بدلاً من ذلك ← أدخل الرمز أعلاه.');
        console.log('============================================\n');
      } catch (e) {
        console.error('⚠️ فشل توليد رمز الاقتران:', e.message);
      }
    }, 4000);
  }

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !usePairing) {
      latestQR = qr;
      connectionStatus = 'waiting_qr';
      console.log('\n📱 امسح الـ QR Code التالي من واتساب (الأجهزة المرتبطة):\n');
      qrcodeTerminal.generate(qr, { small: true });
      console.log(`\n🌐 أو افتح الرابط لعرض الـ QR على المتصفح: http://localhost:${PORT}/qr\n`);
    }

    if (connection === 'open') {
      latestQR = null;
      connectionStatus = 'connected';
      pairingRequested = false; // تم الربط بنجاح
      console.log('✅ تم الاتصال بواتساب بنجاح! البوت جاهز لخدمة العملاء وتوجيههم للتطبيق.');
    }

    if (connection === 'close') {
      connectionStatus = 'disconnected';
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const alreadyRegistered = sock.authState?.creds?.registered;

      console.log(`⚠️ انقطع الاتصال (code: ${statusCode}).`);

      // أغلق الاتصال الحالي دائماً قبل أي إعادة (يمنع التوازي)
      try { sock.ev.removeAllListeners(); sock.end(); } catch (_) {}
      currentSock = null;

      if (statusCode === DisconnectReason.restartRequired) {
        // طبيعي بعد إدخال رمز الاقتران بنجاح — أعد الاتصال فوراً
        scheduleReconnect(1000);
        return;
      }

      // حالة جلسة مربوطة سابقاً ثم سُجّل خروجها فعلياً
      if (statusCode === DisconnectReason.loggedOut && alreadyRegistered) {
        console.log('🚪 تم تسجيل الخروج من الجهاز المرتبط.');
        setTimeout(() => {
          clearAuth();
          console.log('⛔ يلزم ربط جديد. شغّل من جديد:  npm start');
          process.exit(0);
        }, 500);
        return;
      }

      // ما زلنا في مرحلة الربط (لم يُربط بعد) — أعد طلب رمز جديد ضمن حد المحاولات
      if (!alreadyRegistered) {
        if (pairingAttempts >= MAX_PAIRING_ATTEMPTS) {
          console.log(`\n⛔ فشل الربط بعد ${MAX_PAIRING_ATTEMPTS} محاولات.`);
          console.log('⏳ الأرجح تهدئة مؤقتة من واتساب. انتظر 30–60 دقيقة ثم: npm start');
          console.log('   وتأكد أنك تُدخل الرمز بسرعة فور ظهوره.\n');
          setTimeout(() => { clearAuth(); process.exit(0); }, 500);
          return;
        }
        pairingRequested = false; // اسمح بطلب رمز جديد للمحاولة القادمة
        scheduleReconnect(5000);
        return;
      }

      // أي انقطاع عابر بعد الربط — أعد الاتصال
      scheduleReconnect(5000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      try {
        if (!msg.message || msg.key.fromMe) continue;

        const jid = msg.key.remoteJid;
        if (!jid || jid.endsWith('@g.us') || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) continue;

        const text = extractText(msg);
        const hasMedia = hasMediaMessage(msg);
        if (!text && !hasMedia) continue; // نتعامل مع النص والصور (إشعار الحوالة)

        const phone = jid.split('@')[0];

        await sock.sendPresenceUpdate('composing', jid).catch(() => {});

        const reply = await handleMessage(jid, phone, text, hasMedia);

        const replies = Array.isArray(reply) ? reply : [reply];
        for (const r of replies) {
          if (r) await sock.sendMessage(jid, { text: r });
        }

        await sock.sendPresenceUpdate('paused', jid).catch(() => {});
      } catch (err) {
        console.error('خطأ في معالجة الرسالة:', err);
      }
    }
  });

  return sock;
}

// ==========================================================
//  سيرفر Express (Keep-Alive + عرض QR + حالة المساعد)
// ==========================================================
const app = express();
app.use(express.json());

app.get('/', (_req, res) => {
  res.json({
    service: 'Yalla Delivery WhatsApp Bot 🛵',
    status: connectionStatus,
    ai: { enabled: AI_ENABLED, provider: activeProvider(), model: activeProvider() ? activeModelLabel(activeProvider()) : null },
    time: new Date().toISOString(),
  });
});

app.get('/health', (_req, res) => res.status(200).send('OK'));

// حالة المساعد الذكي (تشخيص) — يشمل فحصاً حيّاً لخادم Gemini.
app.get('/ai-status', async (_req, res) => {
  try {
    const ping = await pingAI();
    const provider = activeProvider();
    res.json({
      enabled: AI_ENABLED,
      provider,
      geminiKeyConfigured: !!GEMINI_API_KEY,
      groqKeyConfigured: !!GROQ_API_KEY,
      model: provider ? activeModelLabel(provider) : null,
      memoryTurns: AI_MEMORY_TURNS,
      rateLimit: AI_RATE_MAX ? { max: AI_RATE_MAX, windowSec: AI_RATE_WINDOW_MS / 1000 } : null,
      stats: {
        totalCalls: aiStats.totalCalls,
        failures: aiStats.failures,
        lastOkAt: aiStats.lastOkAt,
        lastError: aiStats.lastError,
        lastErrorAt: aiStats.lastErrorAt,
      },
      groqLimits: provider === 'groq' ? aiStats.groqLimits : null,
      ping,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/qr', async (_req, res) => {
  if (connectionStatus === 'connected') {
    return res.send('<h2 style="font-family:sans-serif">✅ البوت متصل بالفعل بواتساب.</h2>');
  }
  if (!latestQR) {
    return res.send('<h2 style="font-family:sans-serif">⏳ لا يوجد QR حالياً. حدّث الصفحة بعد لحظات...</h2>');
  }
  const encoded = encodeURIComponent(latestQR);
  res.send(
    `<div style="text-align:center;font-family:sans-serif;padding:20px">
      <h2>📱 امسح الـ QR من واتساب</h2>
      <img src="https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encoded}" alt="QR" />
      <p>الأجهزة المرتبطة ← ربط جهاز</p>
      <p><small>حدّث الصفحة إذا انتهت صلاحية الرمز.</small></p>
    </div>`
  );
});

const HOST = process.env.HOST || '0.0.0.0';

// لا نشغّل السيرفر/الاتصال إلا عند التشغيل المباشر (وليس عند الاستيراد للاختبار)
if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(`🌐 السيرفر يعمل على ${HOST}:${PORT}`);
    startBot().catch((err) => console.error('فشل تشغيل البوت:', err));
  });
}

// تصدير منطق المحادثة لاختباره محلياً بلا واتساب (test-flow.js)
module.exports = { handleMessage, resetSession, STATES, isAdmin, pingAI, toWhatsAppText };
