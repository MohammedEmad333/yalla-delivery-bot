/**
 * يلا ديلفري (Yalla Delivery) - WhatsApp Delivery Bot
 * -----------------------------------------------------
 * Node.js + @whiskeysockets/baileys + express + qrcode-terminal
 *
 * خدمات مدعومة: 🍔 توصيل طعام | 📦 توصيل طرود | 🛒 توصيل بقالة/متاجر
 * بيانات مجمّعة: الاسم، تفاصيل الطلب، الاستلام، التسليم، الجوال، طريقة الدفع، وقت التوصيل.
 *
 * المزايا التقنية:
 *  - إدارة جلسات محلية (useMultiFileAuthState) => لا يطلب QR في كل تشغيل
 *  - إعادة اتصال تلقائي (Auto Reconnect) عبر DisconnectReason
 *  - آلة حالات في الذاكرة لكل رقم (In-Memory State Machine)
 *  - أوامر إلغاء/تراجع للعودة إلى IDLE
 *  - سيرفر express لإبقاء الاستضافة نشطة (Oracle Cloud) + عرض QR على الويب
 *  - بوت مستقل: يحفظ الطلبات محلياً في orders.json (بلا أي API خارجي)
 */

const express = require('express');
const qrcodeTerminal = require('qrcode-terminal');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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
const ORDERS_FILE = process.env.ORDERS_FILE
  ? path.resolve(__dirname, process.env.ORDERS_FILE)
  : path.join(__dirname, 'orders.json');

// ===== الربط بتطبيق يلا ديلفري (Yalla API) لإنشاء الطلب جاهزاً للإسناد =====
// عند تأكيد الطلب يُرسل إلى الـ API فيُنشأ طلب بحالة pending يظهر في لوحة
// التحكم جاهزاً للإسناد لكابتن. البوت يصادق كأدمن عبر /auth/login ويخزّن
// الـ JWT ويجدّده تلقائياً عند انتهائه (401).
const YALLA_API_URL = (process.env.YALLA_API_URL || '').replace(/\/+$/, ''); // مثال: https://yalla-api-z6t0.onrender.com/api
const YALLA_ADMIN_PHONE = process.env.YALLA_ADMIN_PHONE || '';
const YALLA_ADMIN_PASSWORD = process.env.YALLA_ADMIN_PASSWORD || '';

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

// ===== الوقت التقديري (ETA) حسب نوع المركبة — مطابق للتطبيق =====
const VEHICLE_SPEEDS = { bicycle: 12, motorcycle: 25 }; // كم/ساعة داخل المدينة
const PREP_MINUTES = 5; // وقت تجهيز/استلام ثابت (دقائق)

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
//  آلة الحالات (State Machine) لكل مستخدم
// ==========================================================
const STATES = {
  IDLE: 'IDLE',
  AWAITING_NAME: 'AWAITING_NAME',
  AWAITING_OWNER_PHONE: 'AWAITING_OWNER_PHONE', // رقم جوال صاحب الطلب
  // نقطة الاستلام (عنوان كامل مطابق للتطبيق)
  AWAITING_PICKUP_HOOD: 'AWAITING_PICKUP_HOOD',
  AWAITING_PICKUP_STREET: 'AWAITING_PICKUP_STREET',
  AWAITING_PICKUP_DETAILS: 'AWAITING_PICKUP_DETAILS',
  AWAITING_PICKUP_NOTE: 'AWAITING_PICKUP_NOTE',
  // نقطة التسليم (عنوان كامل مطابق للتطبيق)
  AWAITING_DROPOFF_HOOD: 'AWAITING_DROPOFF_HOOD',
  AWAITING_DROPOFF_STREET: 'AWAITING_DROPOFF_STREET',
  AWAITING_DROPOFF_DETAILS: 'AWAITING_DROPOFF_DETAILS',
  AWAITING_DROPOFF_NOTE: 'AWAITING_DROPOFF_NOTE',
  // وصف الشحنة
  AWAITING_PACKAGE_NOTE: 'AWAITING_PACKAGE_NOTE',
  // الدفع (نظامنا الحالي: تحويل + إشعار)
  AWAITING_PAYMENT: 'AWAITING_PAYMENT',
  AWAITING_PAYMENT_PROOF: 'AWAITING_PAYMENT_PROOF',
  // الجدولة (الآن/لاحقاً = scheduledAt)
  AWAITING_SCHEDULE: 'AWAITING_SCHEDULE',
  CONFIRMATION: 'CONFIRMATION',
};

// نوع خدمة واحد ثابت (أُزيل اختيار نوع الخدمة من المحادثة).
const DEFAULT_SERVICE = { key: 'delivery', label: '🛵 خدمة توصيل' };
// نوع مركبة افتراضي (أُزيل اختيار المركبة — يؤثّر على الوقت التقديري فقط).
const DEFAULT_VEHICLE = { key: 'motorcycle', label: '🏍️ دراجة نارية' };
// مطالبة وصف الشحنة (عامة بلا نوع خدمة).
const PACKAGE_PROMPT = 'اكتب *تفاصيل الطلب / محتوى الشحنة* 📦 (مثال: مستندات، طعام، مشتريات، غرض...)';

// طرق الدفع
const PAYMENT_METHODS = {
  1: 'بنك فلسطين 🏦',
  2: 'محفظة بال بي 📱',
  3: 'جوال بي 📲',
};

// اسم صاحب الحساب ورقمه لكل طرق الدفع (عدّلها عند الحاجة)
const PAYEE_NAME = process.env.PAYEE_NAME || 'إبراهيم محمد عطا قنديل';
const PAYEE_NUMBER = process.env.PAYEE_NUMBER || '0593456405';

// تفاصيل التحويل لكل طريقة دفع
const PAYMENT_DETAILS = {
  1: `🏦 *بنك فلسطين*\n👤 الاسم: ${PAYEE_NAME}\n🔢 الرقم: ${PAYEE_NUMBER}`,
  2: `📱 *محفظة بال بي*\n👤 الاسم: ${PAYEE_NAME}\n🔢 الرقم: ${PAYEE_NUMBER}`,
  3: `📲 *جوال بي*\n👤 الاسم: ${PAYEE_NAME}\n🔢 الرقم: ${PAYEE_NUMBER}`,
};

// sessions[jid] = { state, order: {...} }
const sessions = {};

function getSession(jid) {
  if (!sessions[jid]) {
    sessions[jid] = { state: STATES.IDLE, order: {} };
  }
  return sessions[jid];
}

function resetSession(jid) {
  sessions[jid] = { state: STATES.IDLE, order: {} };
}

// ==========================================================
//  رسائل ثابتة
// ==========================================================
// رسالة تحميل التطبيق (تُعرض في الترحيب وبعد إتمام الطلب)
const APP_DOWNLOAD_MESSAGE =
  '📲 *حمّل تطبيق يلا ديلفري* لتجربة أسرع وأسهل، وتتبّع طلبك مباشرةً وعروض حصرية:\n\n' +
  `🤖 أندرويد: ${APP_ANDROID_URL}\n` +
  `🌐 تطبيق الويب: ${APP_WEB_URL}`;

const WELCOME_MESSAGE =
  'أهلاً بك في يلا ديلفري! 🛵 نصلك أينما كنت.\n\n' +
  APP_DOWNLOAD_MESSAGE +
  '\n\nأو أكمل طلبك من هنا مباشرةً. كيف يمكننا خدمتك؟ اختر رقماً:\n\n' +
  '1️⃣ طلب توصيل جديد 📦\n' +
  '2️⃣ استفسار عن الأسعار/المناطق 💰\n' +
  '3️⃣ التحدث مع الدعم الفني 📞\n\n' +
  '💡 يمكنك كتابة "إلغاء" في أي وقت للعودة للبداية.';

const PRICING_MESSAGE =
  '💰 *الأسعار*\n\n' +
  '• سعر التوصيل يُحسب *حسب المسافة* بين حي الاستلام وحي التسليم.\n' +
  `• كل ${METERS_PER_SHEKEL} متراً = 1 ${CURRENCY} تقريباً.\n` +
  `• أقل سعر توصيل: ${MIN_FARE} ${CURRENCY}.\n\n` +
  'ابدأ طلباً واختر الحيّين لتعرف السعر التقريبي فوراً.\n' +
  'اكتب "طلب" لبدء طلب جديد، أو "إلغاء" للعودة للقائمة.';

const SUPPORT_NUMBER = process.env.SUPPORT_NUMBER || '+970593456405';

// أرقام الإدارة: تُميَّز لعرض أوامر التشخيص (مثل "/حالة") التي لا يراها العملاء.
// افتراضياً: رقم الأعمال + رقم الدعم. أضِف أرقاماً بفاصلة في ADMIN_NUMBERS.
const ADMIN_NUMBERS = Array.from(
  new Set(
    [
      ...(process.env.ADMIN_NUMBERS || '').split(','),
      BUSINESS_NUMBER,
      SUPPORT_NUMBER,
    ]
      .map((s) => (s || '').replace(/\D/g, ''))
      .filter((s) => s.length >= 8),
  ),
);

// هل الرقم المُرسِل ضمن أرقام الإدارة؟ (نطابق آخر 9 خانات لتجاوز اختلاف رمز الدولة)
function isAdmin(phone) {
  const p = (phone || '').replace(/\D/g, '');
  if (!p) return false;
  const tail = p.slice(-9);
  return ADMIN_NUMBERS.some((a) => a === p || a.slice(-9) === tail);
}

const SUPPORT_MESSAGE =
  '📞 *الدعم الفني*\n\n' +
  'فريقنا جاهز لمساعدتك:\n' +
  `• واتساب/اتصال: ${SUPPORT_NUMBER}\n` +
  '• أوقات العمل: يومياً 9 صباحاً - 11 مساءً.\n\n' +
  'اكتب "إلغاء" للعودة إلى القائمة الرئيسية.';

const PAYMENT_MENU =
  'اختر *طريقة الدفع* 💳:\n\n' +
  '1️⃣ بنك فلسطين 🏦\n' +
  '2️⃣ محفظة بال بي 📱\n' +
  '3️⃣ جوال بي 📲\n\n' +
  'اكتب رقم الطريقة (1 / 2 / 3).';

const TIME_MENU =
  'متى تريد التوصيل؟ ⏰\n\n' +
  '1️⃣ في أسرع وقت (الآن)\n' +
  '2️⃣ وقت محدد لاحقاً\n\n' +
  'اكتب 1 للتوصيل الفوري، أو اكتب الوقت المطلوب مباشرة (مثال: الساعة 8 مساءً).';

// كلمات مفتاحية
const GREETING_KEYWORDS = ['مرحبا', 'مرحباً', 'السلام عليكم', 'اهلا', 'أهلا', 'هلا', 'hi', 'hello', 'start', 'بدء', 'القائمة', 'menu'];
const NEW_ORDER_KEYWORDS = ['طلب', 'طلب جديد', 'توصيل'];
const PRICING_KEYWORDS = ['اسعار', 'أسعار', 'سعر', 'مناطق', 'استفسار'];
const SUPPORT_KEYWORDS = ['دعم', 'مساعدة', 'مساعده', 'support'];
const CANCEL_KEYWORDS = ['إلغاء', 'الغاء', 'تراجع', 'cancel', 'رجوع', 'خروج'];
const YES_KEYWORDS = ['نعم', 'اكيد', 'أكيد', 'تأكيد', 'تاكيد', 'موافق', 'ok', 'yes', 'y'];
const NO_KEYWORDS = ['لا', 'الغاء', 'إلغاء', 'no', 'n'];
// كلمات استفهام: عند ظهورها نعامل الرسالة كسؤال ونحيلها للمساعد الذكي، بدل
// التقاطها بالخطأ كأمر (مثال: "كم سعر التوصيل" سؤال وليس طلباً جديداً).
const QUESTION_WORDS = ['كم', 'بكم', 'كيف', 'وين', 'فين', 'اين', 'أين', 'متى', 'امتى', 'إمتى', 'ليش', 'ليه', 'لماذا', 'هل', 'شو', 'ايش', 'إيش', 'ايه', 'وش'];

function normalize(text) {
  return (text || '').trim().toLowerCase();
}

function includesAny(text, list) {
  const t = normalize(text);
  return list.some((k) => t === normalize(k) || t.includes(normalize(k)));
}

// هل الرسالة سؤال؟ (تحوي "؟" أو كلمة استفهام ككلمة مستقلة). نستخدمها لتوجيه
// الأسئلة للمساعد الذكي بدل التقاطها كأمر بسبب كلمة مشتركة مثل "توصيل"/"سعر".
function looksLikeQuestion(text) {
  const t = normalize(text);
  if (!t) return false;
  if (t.includes('؟') || t.includes('?')) return true;
  return QUESTION_WORDS.some((w) => {
    const k = normalize(w);
    return t === k || t.startsWith(k + ' ') || t.endsWith(' ' + k) || t.includes(' ' + k + ' ');
  });
}

function generateOrderRef() {
  const ts = Date.now().toString().slice(-6);
  const rand = Math.floor(100 + Math.random() * 900);
  return `YD-${ts}${rand}`;
}

// فهرس: رقم الحي (1..N) → بياناته
const _hoodByIndex = GAZA_NEIGHBORHOODS;

// قائمة الأحياء المرقّمة لعرضها للعميل
const NEIGHBORHOOD_MENU = GAZA_NEIGHBORHOODS
  .map((n, i) => `${i + 1}. ${n.name}`)
  .join('\n');

// المسافة بين نقطتين [lng, lat] بمعادلة Haversine (خط مستقيم) — مطابق للتطبيق
function haversineKm(a, b) {
  const EARTH_RADIUS_KM = 6371;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const [lng1, lat1] = a;
  const [lng2, lat2] = b;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.asin(Math.sqrt(h));
}

// المسافة التقديرية بالكيلومتر (خط مستقيم × معامل الطرق) — مطابق للتطبيق
function estimateDistanceKm(pickup, dropoff) {
  const straight = haversineKm(pickup, dropoff);
  return +(straight * ROAD_FACTOR).toFixed(2);
}

// السعر التقريبي: كل 160 متر = 1 شيكل، بحدٍّ أدنى MIN_FARE — مطابق للتطبيق (Card 27)
function calculatePrice(distanceKm) {
  const meters = Math.max(0, Number(distanceKm) || 0) * 1000;
  const raw = Math.round(meters / METERS_PER_SHEKEL);
  return Math.max(MIN_FARE, raw);
}

// تسعيرة كاملة (مسافة + سعر) بين حيّين
function quote(pickupCoords, dropoffCoords) {
  const distanceKm = estimateDistanceKm(pickupCoords, dropoffCoords);
  const price = calculatePrice(distanceKm);
  return { distanceKm, price };
}

// الوقت التقديري بالدقائق من المسافة ونوع المركبة — مطابق للتطبيق
function estimateEtaMinutes(distanceKm, vehicleKey = 'motorcycle') {
  const speed = VEHICLE_SPEEDS[vehicleKey] || VEHICLE_SPEEDS.motorcycle;
  const d = Number(distanceKm) || 0;
  const travelMinutes = (d / speed) * 60;
  return Math.max(1, Math.round(travelMinutes + PREP_MINUTES));
}

// رمز تسليم عشوائي من 4 أرقام (Card 20) — يُعطى لصاحب الطلب لتأكيد الاستلام
function generateDeliveryCode() {
  return String(crypto.randomInt(0, 10000)).padStart(4, '0');
}

// ==========================================================
//  حفظ الطلب محلياً في ملف orders.json (بوت مستقل)
// ==========================================================
function saveOrder(order) {
  console.log('\n===== 📦 طلب جديد (Yalla Delivery) =====');
  console.log(JSON.stringify(order, null, 2));
  console.log('========================================\n');

  try {
    let orders = [];
    if (fs.existsSync(ORDERS_FILE)) {
      const raw = fs.readFileSync(ORDERS_FILE, 'utf8').trim();
      if (raw) orders = JSON.parse(raw);
      if (!Array.isArray(orders)) orders = [];
    }

    orders.push(order);
    fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2), 'utf8');

    console.log(`✅ تم حفظ الطلب في ${ORDERS_FILE} (الإجمالي: ${orders.length}).`);
    return { ok: true, total: orders.length };
  } catch (err) {
    console.error('⚠️ فشل حفظ الطلب في الملف:', err.message);
    return { ok: false, error: err.message };
  }
}

// ==========================================================
//  إرسال الطلب إلى تطبيق يلا ديلفري (Yalla API) — يظهر جاهزاً للإسناد
// ==========================================================
// توكن أدمن مخزّن مؤقتاً (JWT). يُجدَّد بالدخول عند غيابه أو انتهائه (401).
let _adminToken = null;

// fetch مع مهلة زمنية (قد يستيقظ خادم الـ API ببطء بعد خمول).
async function fetchWithTimeout(url, options = {}, ms = 60000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

// تسجيل دخول الأدمن للحصول على JWT (POST /auth/login بـ phone+password).
async function loginYalla() {
  const res = await fetchWithTimeout(`${YALLA_API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ phone: YALLA_ADMIN_PHONE, password: YALLA_ADMIN_PASSWORD }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.token) {
    throw new Error(`login failed (${res.status}): ${body?.message || 'no token'}`);
  }
  _adminToken = body.token;
  console.log(`🔐 تسجيل دخول الأدمن ناجح (role: ${body.user?.role || '?'}).`);
  return _adminToken;
}

// تحويل نقطة عنوان من صيغة البوت إلى الصيغة التي يتوقّعها الـ API.
function toApiLocation(loc = {}) {
  const out = {
    neighborhood: loc.neighborhood,
    street: loc.street,
    details: loc.details,
    note: loc.note || '',
    contactName: loc.contactName,
    contactPhone: loc.contactPhone,
  };
  // الإحداثيات مخزّنة بصيغة [lng, lat] — مطابقة لصيغة GeoJSON Point.
  if (Array.isArray(loc.coordinates) && loc.coordinates.length === 2) {
    out.location = { type: 'Point', coordinates: loc.coordinates };
  }
  return out;
}

// بناء حمولة POST /orders/admin من طلب البوت.
function buildAdminOrderPayload(order) {
  const payload = {
    contactName: order.customerName,
    contactPhone: order.customerPhone || order.whatsapp,
    pickup: toApiLocation(order.pickup),
    dropoff: toApiLocation(order.dropoff),
    packageNote: order.packageNote,
    vehicleType: order.vehicleType, // 'bicycle' | 'motorcycle'
  };

  // الجدولة: نرسل scheduledAt فقط لو تاريخ صالح؛ وإلا نُبقي نص الوقت المطلوب
  // ضمن ملاحظة الشحنة حتى لا يضيع (البوت يخزّنه أحياناً كنص حرّ).
  const sched = order.scheduledAt;
  if (sched && !Number.isNaN(Date.parse(sched))) {
    payload.scheduledAt = new Date(sched).toISOString();
  } else if (sched) {
    payload.packageNote = `${payload.packageNote || ''}\n⏰ وقت مطلوب: ${sched}`.trim();
  }
  return payload;
}

// يرسل الطلب للـ API؛ يعيد المحاولة مرة واحدة بعد إعادة الدخول عند 401.
async function pushOrderToAdmin(order) {
  if (!YALLA_API_URL || !YALLA_ADMIN_PHONE || !YALLA_ADMIN_PASSWORD) {
    console.log('ℹ️ لم تُضبط إعدادات Yalla (YALLA_API_URL/PHONE/PASSWORD) — تم تخطي الإرسال (حُفظ محلياً فقط).');
    return { ok: false, skipped: true };
  }

  const payload = buildAdminOrderPayload(order);

  const attempt = async () => {
    if (!_adminToken) await loginYalla();
    return fetchWithTimeout(`${YALLA_API_URL}/orders/admin`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${_adminToken}`,
        // مفتاح عدم التكرار: يمنع ازدواج الطلب لو أُعيدت المحاولة.
        'Idempotency-Key': order.ref,
      },
      body: JSON.stringify(payload),
    });
  };

  try {
    let res = await attempt();
    // التوكن منتهٍ/غير صالح → أعد الدخول وحاول مرة أخرى.
    if (res.status === 401) {
      _adminToken = null;
      res = await attempt();
    }

    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      const id = body?._id || body?.id || body?.order?._id || '?';
      console.log(`✅ أُنشئ الطلب في تطبيق Yalla (id: ${id}) جاهزاً للإسناد.`);
      return { ok: true, orderId: id };
    }
    console.error(`⚠️ رفض الـ API الطلب (${res.status}):`, body?.message || JSON.stringify(body).slice(0, 200));
    return { ok: false, status: res.status, error: body?.message };
  } catch (err) {
    console.error('⚠️ فشل إرسال الطلب لتطبيق Yalla:', err?.message || err);
    return { ok: false, error: err?.message };
  }
}

// ==========================================================
//  منطق المحادثة
// ==========================================================
function fmtLocation(loc) {
  const parts = [loc.neighborhood, loc.street, loc.details].filter(Boolean).join('، ');
  let s = parts;
  if (loc.note) s += `\n   📝 ملاحظة: ${loc.note}`;
  return s;
}

function buildSummary(o) {
  return (
    '📋 *ملخص طلبك:*\n\n' +
    `🔧 الخدمة: ${o.serviceLabel}\n` +
    `👤 الاسم: ${o.customerName}\n` +
    `📱 جوال صاحب الطلب: ${o.customerPhone}\n\n` +
    `📍 *الاستلام:*\n   ${fmtLocation(o.pickup)}\n\n` +
    `🎯 *التسليم:*\n   ${fmtLocation(o.dropoff)}\n\n` +
    `📦 الشحنة: ${o.packageNote}\n` +
    `🚗 المسافة التقريبية: ${o.distanceKm} كم\n` +
    `⏱️ الوقت التقديري: ${o.etaMinutes} دقيقة\n` +
    `💵 سعر التوصيل التقريبي: ${o.deliveryPrice} ${CURRENCY}\n` +
    `💳 الدفع: ${o.paymentMethod}\n` +
    `⏰ وقت التوصيل: ${o.deliveryTime}\n\n` +
    'هل البيانات صحيحة؟ اكتب *نعم* للتأكيد أو *لا* للإلغاء.'
  );
}

// تطبيع رقم جوال بسيط
function normPhone(raw) {
  const digits = (raw || '').replace(/[^\d+]/g, '');
  return digits.replace(/\D/g, '').length >= 8 ? digits : null;
}

// هل يريد المستخدم تخطّي حقل اختياري؟
function isSkip(raw) {
  const t = normalize(raw);
  return t === '-' || t === 'لا' || t === 'تخطي' || t === 'تخطى' || t === 'skip' || t === 'لا يوجد';
}

/**
 * يعالج رسالة نصية واردة ويعيد نص الرد (أو مصفوفة ردود).
 */
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
    '- السعر الدقيق يظهر تلقائياً بعد اختيار حي الاستلام وحي التسليم أثناء الطلب.',
    `- المناطق المخدومة (أحياء غزة): ${GAZA_NEIGHBORHOODS.map((n) => n.name).join('، ')}.`,
    '- طرق الدفع: بنك فلسطين، محفظة بال بي، جوال بي (يُطلب إشعار الحوالة بعد التحويل).',
    '- أوقات عمل الدعم: يومياً 9 صباحاً حتى 11 مساءً.',
    `- رقم الدعم للتواصل المباشر: ${SUPPORT_NUMBER}.`,
    `- روابط التطبيق — أندرويد: ${APP_ANDROID_URL} | الويب: ${APP_WEB_URL}.`,
    '',
    'خطوات إنشاء الطلب داخل هذا البوت (وجّه العميل إليها عند الحاجة):',
    'الاسم ← جوال صاحب الطلب ← عنوان الاستلام (حي/شارع/تفاصيل) ← عنوان التسليم ← وصف الشحنة ← الدفع ← وقت التوصيل ← تأكيد.',
    '',
    'قواعد مهمة:',
    '- لبدء طلب فعلي، وجّه العميل لكتابة كلمة "طلب" بالضبط (أنت لا تستطيع إنشاء الطلب بنفسك).',
    '- إذا سُئلت عن أمر خارج نطاق الخدمة أو لا تعرف إجابته، اعتذر بلطف واقترح التواصل مع الدعم أو كتابة "طلب".',
    '- لا تَعِد بأسعار أو أوقات محددة رقمياً؛ اذكر أن السعر التقريبي يظهر بعد اختيار الحيّين.',
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
    // ليس أدمن: نكشف للمُرسِل مُعرّفه الفعلي (كما يستقبله البوت) ليضيفه بدقّة.
    console.log(`ℹ️ [تشخيص] أمر حالة من رقم غير مُدرج بالإدارة: "${phone}"`);
    return (
      '⚠️ هذا الأمر مخصّص للإدارة فقط.\n\n' +
      `🆔 مُعرّفك كما يستقبله البوت: *${phone}*\n\n` +
      'لتفعيل الأمر لك: أضِف هذا الرقم بالضبط إلى `ADMIN_NUMBERS` في ملف `.env` ' +
      '(مفصولاً بفاصلة عن غيره) ثم أعد تشغيل الخدمة.'
    );
  }

  // أوامر الإلغاء/التراجع تعمل في أي مرحلة
  if (includesAny(raw, CANCEL_KEYWORDS) && session.state !== STATES.IDLE) {
    resetSession(jid);
    return 'تم إلغاء العملية والعودة للبداية. ✅\n\n' + WELCOME_MESSAGE;
  }

  // طلب رابط التطبيق في أي وقت
  if (includesAny(raw, ['تطبيق', 'التطبيق', 'تحميل', 'حمل', 'app', 'download', 'رابط'])) {
    return APP_DOWNLOAD_MESSAGE;
  }

  switch (session.state) {
    case STATES.IDLE: {
      // الأرقام أوامر صريحة دائماً. أما الكلمات المفتاحية فلا نلتقطها إن كانت
      // الرسالة سؤالاً (مثال: "كم سعر التوصيل") حتى تصل للمساعد الذكي.
      const isQuestion = looksLikeQuestion(raw);
      const wantsOrder = raw === '1' || (!isQuestion && includesAny(raw, NEW_ORDER_KEYWORDS));
      const wantsPricing = raw === '2' || (!isQuestion && includesAny(raw, PRICING_KEYWORDS));
      const wantsSupport = raw === '3' || (!isQuestion && includesAny(raw, SUPPORT_KEYWORDS));

      if (wantsOrder) {
        // نوع خدمة واحد ثابت — نبدأ الطلب مباشرةً من الاسم.
        session.order = {
          serviceType: DEFAULT_SERVICE.key,
          serviceLabel: DEFAULT_SERVICE.label,
        };
        session.state = STATES.AWAITING_NAME;
        return '*الخطوة 1:* ما اسمك الكريم؟';
      }
      if (wantsPricing) return PRICING_MESSAGE;
      if (wantsSupport) return SUPPORT_MESSAGE;

      // التحية والقوائم الفارغة → رسالة الترحيب مباشرةً (بلا استهلاك للمساعد الذكي).
      if (!raw || includesAny(raw, GREETING_KEYWORDS)) {
        return WELCOME_MESSAGE;
      }

      // سؤال/كلام حر → المساعد الذكي يجيب بلغة طبيعية ثم نلحق تلميحاً للطلب.
      if (AI_ENABLED && activeProvider()) {
        if (isAIRateLimited(session)) {
          return 'وصلت لحدّ الأسئلة السريعة 🙏 انتظر لحظات ثم أعد المحاولة، أو اكتب "طلب" لبدء طلب توصيل.';
        }
        const aiReply = await askAI(session, raw);
        if (aiReply) {
          return aiReply + '\n\n💡 اكتب "طلب" لبدء طلب توصيل جديد.';
        }
      }

      // احتياطي عند تعذّر المساعد (غياب المفتاح/انقطاع): وجّه حسب أقرب نيّة.
      if (includesAny(raw, PRICING_KEYWORDS)) return PRICING_MESSAGE;
      if (includesAny(raw, SUPPORT_KEYWORDS)) return SUPPORT_MESSAGE;
      return WELCOME_MESSAGE;
    }

    case STATES.AWAITING_NAME: {
      if (!raw) return 'من فضلك اكتب اسمك للمتابعة. 🙏';
      session.order.customerName = raw;
      session.state = STATES.AWAITING_OWNER_PHONE;
      return `تشرفنا يا ${raw} 🌟\n\n*رقم جوال صاحب الطلب* 📱`;
    }

    case STATES.AWAITING_OWNER_PHONE: {
      const p = normPhone(raw);
      if (!p) return 'الرقم غير واضح. اكتب رقم جوال صحيحاً 📱 (مثال: 059xxxxxxx).';
      session.order.customerPhone = p;
      session.order.pickup = {};
      session.order.dropoff = {};
      session.state = STATES.AWAITING_PICKUP_HOOD;
      return `لنبدأ بعنوان *الاستلام* 📍\n\n*حي الاستلام:*\n${NEIGHBORHOOD_MENU}\n\nاكتب رقم الحي.`;
    }

    // ===== نقطة الاستلام =====
    case STATES.AWAITING_PICKUP_HOOD: {
      const idx = parseInt(raw, 10);
      const hood = Number.isInteger(idx) ? _hoodByIndex[idx - 1] : null;
      if (!hood) return 'من فضلك اكتب رقم حي صحيحاً:\n\n' + NEIGHBORHOOD_MENU;
      session.order.pickup.neighborhood = hood.name;
      session.order.pickup.coordinates = hood.coordinates;
      session.state = STATES.AWAITING_PICKUP_STREET;
      return 'اكتب اسم *الشارع* لنقطة الاستلام 🛣️';
    }

    case STATES.AWAITING_PICKUP_STREET: {
      if (!raw) return 'من فضلك اكتب اسم الشارع. 🛣️';
      session.order.pickup.street = raw;
      session.state = STATES.AWAITING_PICKUP_DETAILS;
      return 'اكتب *تفاصيل عنوان الاستلام* 🏠 (بناية/طابق/أقرب معلم)';
    }

    case STATES.AWAITING_PICKUP_DETAILS: {
      if (!raw) return 'من فضلك اكتب تفاصيل العنوان. 🏠';
      session.order.pickup.details = raw;
      session.state = STATES.AWAITING_PICKUP_NOTE;
      return 'أي *ملاحظة* لنقطة الاستلام؟ 📝 (اكتب "-" للتخطي)';
    }

    case STATES.AWAITING_PICKUP_NOTE: {
      session.order.pickup.note = isSkip(raw) ? '' : raw;
      session.state = STATES.AWAITING_DROPOFF_HOOD;
      return `✅ تم حفظ عنوان الاستلام.\n\nالآن عنوان *التسليم* 🎯\n\n*حي التسليم:*\n${NEIGHBORHOOD_MENU}\n\nاكتب رقم الحي.`;
    }

    // ===== نقطة التسليم =====
    case STATES.AWAITING_DROPOFF_HOOD: {
      const idx = parseInt(raw, 10);
      const hood = Number.isInteger(idx) ? _hoodByIndex[idx - 1] : null;
      if (!hood) return 'من فضلك اكتب رقم حي صحيحاً:\n\n' + NEIGHBORHOOD_MENU;
      session.order.dropoff.neighborhood = hood.name;
      session.order.dropoff.coordinates = hood.coordinates;
      // نحسب المسافة والسعر بمجرد توفّر الحيّين (يُعرَض مع المركبة لاحقاً)
      const q = quote(session.order.pickup.coordinates, session.order.dropoff.coordinates);
      session.order.distanceKm = q.distanceKm;
      session.order.deliveryPrice = q.price;
      session.state = STATES.AWAITING_DROPOFF_STREET;
      return 'اكتب اسم *الشارع* لنقطة التسليم 🛣️';
    }

    case STATES.AWAITING_DROPOFF_STREET: {
      if (!raw) return 'من فضلك اكتب اسم الشارع. 🛣️';
      session.order.dropoff.street = raw;
      session.state = STATES.AWAITING_DROPOFF_DETAILS;
      return 'اكتب *تفاصيل عنوان التسليم* 🏠 (بناية/طابق/أقرب معلم)';
    }

    case STATES.AWAITING_DROPOFF_DETAILS: {
      if (!raw) return 'من فضلك اكتب تفاصيل العنوان. 🏠';
      session.order.dropoff.details = raw;
      session.state = STATES.AWAITING_DROPOFF_NOTE;
      return 'أي *ملاحظة* لنقطة التسليم؟ 📝 (اكتب "-" للتخطي)';
    }

    case STATES.AWAITING_DROPOFF_NOTE: {
      session.order.dropoff.note = isSkip(raw) ? '' : raw;
      session.state = STATES.AWAITING_PACKAGE_NOTE;
      return `✅ تم حفظ عنوان التسليم.\n\n*وصف الشحنة:* ${PACKAGE_PROMPT}`;
    }

    // ===== وصف الشحنة =====
    case STATES.AWAITING_PACKAGE_NOTE: {
      if (!raw) return 'من فضلك اكتب وصف الشحنة/الطلب. 📦';
      session.order.packageNote = raw;
      // مركبة افتراضية (بلا اختيار) — تؤثّر على الوقت التقديري فقط.
      session.order.vehicleType = DEFAULT_VEHICLE.key;
      session.order.vehicleLabel = DEFAULT_VEHICLE.label;
      session.order.etaMinutes = estimateEtaMinutes(session.order.distanceKm, DEFAULT_VEHICLE.key);
      session.state = STATES.AWAITING_PAYMENT;
      return (
        '✅ تم حساب طلبك:\n\n' +
        `📍 ${session.order.pickup.neighborhood}  ←  🎯 ${session.order.dropoff.neighborhood}\n` +
        `🚗 المسافة: *${session.order.distanceKm} كم*\n` +
        `⏱️ الوقت التقديري: *${session.order.etaMinutes} دقيقة*\n` +
        `💵 سعر التوصيل: *${session.order.deliveryPrice} ${CURRENCY}*\n\n` +
        PAYMENT_MENU
      );
    }

    case STATES.AWAITING_PAYMENT: {
      const method = PAYMENT_METHODS[raw];
      if (!method) {
        return 'من فضلك اختر رقماً صحيحاً:\n\n' + PAYMENT_MENU;
      }
      session.order.paymentMethod = method;
      session.state = STATES.AWAITING_PAYMENT_PROOF;
      return (
        `اخترت: ${method} ✅\n\n` +
        'يرجى تحويل المبلغ إلى:\n\n' +
        PAYMENT_DETAILS[raw] +
        `\n\n💵 سعر التوصيل: *${session.order.deliveryPrice} ${CURRENCY}*\n\n` +
        '📸 بعد إتمام التحويل، أرسل *صورة إشعار الحوالة* هنا لتأكيد الدفع.'
      );
    }

    case STATES.AWAITING_PAYMENT_PROOF: {
      // نقبل صورة إشعار الحوالة، أو تأكيداً نصياً (تم/حولت...)
      const confirmedByText = includesAny(raw, ['تم', 'حولت', 'حولت المبلغ', 'أرسلت', 'ارسلت', 'دفعت', 'done', 'ok']);
      if (!hasMedia && !confirmedByText) {
        return (
          '📸 بانتظار *صورة إشعار الحوالة*.\n' +
          'أرسل صورة الإشعار بعد التحويل، أو اكتب "تم" إن حوّلت بالفعل.'
        );
      }
      session.order.paymentProof = hasMedia ? 'image' : 'text_confirmation';
      session.state = STATES.AWAITING_SCHEDULE;
      return 'تم استلام إشعار الحوالة ✅ شكراً لك.\n\n*الخطوة الأخيرة:* ' + TIME_MENU;
    }

    case STATES.AWAITING_SCHEDULE: {
      if (!raw) return 'من فضلك حدّد وقت التوصيل. ⏰';
      if (raw === '1') {
        session.order.scheduledAt = null;
        session.order.deliveryTime = 'في أسرع وقت (الآن) ⚡';
      } else {
        session.order.scheduledAt = raw; // نص الوقت كما أدخله العميل
        session.order.deliveryTime = raw;
      }
      session.state = STATES.CONFIRMATION;
      return buildSummary(session.order);
    }

    case STATES.CONFIRMATION: {
      if (includesAny(raw, YES_KEYWORDS)) {
        const ref = generateOrderRef();
        const deliveryCode = generateDeliveryCode();
        const s = session.order;
        const order = {
          ref,
          whatsapp: phone,
          serviceType: s.serviceType,
          serviceLabel: s.serviceLabel,
          customerName: s.customerName,
          customerPhone: s.customerPhone,
          pickup: s.pickup,
          dropoff: s.dropoff,
          packageNote: s.packageNote,
          vehicleType: s.vehicleType,
          vehicleLabel: s.vehicleLabel,
          distanceKm: s.distanceKm,
          etaMinutes: s.etaMinutes,
          price: s.deliveryPrice,
          currency: CURRENCY,
          deliveryCode,
          paymentMethod: s.paymentMethod,
          paymentProof: s.paymentProof || 'none',
          scheduledAt: s.scheduledAt || null,
          deliveryTime: s.deliveryTime,
          status: 'pending', // مطابق للتطبيق: بانتظار الإسناد
          createdAt: new Date().toISOString(),
        };

        saveOrder(order);
        // إرسال الطلب إلى تطبيق Yalla ليظهر جاهزاً للإسناد.
        // لا نُفشل الطلب على العميل لو تعذّر الإرسال؛ يبقى محفوظاً محلياً.
        await pushOrderToAdmin(order);
        resetSession(jid);

        return (
          'شكراً لك! تم استلام طلبك بنجاح ✅\n\n' +
          `🔖 رقمك المرجعي: *${ref}*\n` +
          `🔐 كود التسليم: *${deliveryCode}*\n` +
          `💵 سعر التوصيل التقريبي: *${order.price} ${CURRENCY}*\n` +
          `⏱️ الوقت التقديري: *${order.etaMinutes} دقيقة*\n\n` +
          '⚠️ احتفظ بـ*كود التسليم* وأعطه للكابتن عند استلامك الطلب لتأكيد التسليم.\n\n' +
          'سيتواصل معك الكابتن قريباً. يلا ديلفري 🛵💨\n\n' +
          APP_DOWNLOAD_MESSAGE +
          '\n\nاكتب "طلب" لإنشاء طلب جديد في أي وقت.'
        );
      }

      if (includesAny(raw, NO_KEYWORDS)) {
        resetSession(jid);
        return 'تم إلغاء الطلب. ❌\n\n' + WELCOME_MESSAGE;
      }

      return 'من فضلك اكتب *نعم* للتأكيد أو *لا* للإلغاء. 🙏';
    }

    default: {
      resetSession(jid);
      return WELCOME_MESSAGE;
    }
  }
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
      console.log('✅ تم الاتصال بواتساب بنجاح! البوت جاهز لاستقبال الطلبات.');
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
//  سيرفر Express (Keep-Alive + عرض QR + عرض الطلبات)
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

// عرض الطلبات المحفوظة (اختياري — للاطلاع السريع)
app.get('/orders', (_req, res) => {
  try {
    if (!fs.existsSync(ORDERS_FILE)) return res.json([]);
    const raw = fs.readFileSync(ORDERS_FILE, 'utf8').trim();
    res.json(raw ? JSON.parse(raw) : []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
