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
 *  - سيرفر express لإبقاء الاستضافة نشطة (Render/Alwaysdata) + عرض QR على الويب
 *  - بوت مستقل: يحفظ الطلبات محلياً في orders.json (بلا أي API خارجي)
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

// ==========================================================
//  الإعدادات العامة
// ==========================================================
const PORT = process.env.PORT || 3000;
const AUTH_FOLDER = process.env.AUTH_FOLDER || 'auth_info';
const ORDERS_FILE = process.env.ORDERS_FILE || path.join(__dirname, 'orders.json');

// روابط تحميل تطبيق يلا ديلفري (عدّلها لروابطك الحقيقية)
const APP_ANDROID_URL = process.env.APP_ANDROID_URL || 'https://play.google.com/store/apps/details?id=com.yalladelivery';
const APP_IOS_URL = process.env.APP_IOS_URL || 'https://apps.apple.com/app/yalla-delivery';

// طريقة الربط: رمز اقتران (Pairing Code) بدل مسح QR.
// فعّلها بوضع USE_PAIRING_CODE=true ورقم واتساب الأعمال (أرقام فقط بدون + أو مسافات).
const USE_PAIRING_CODE = String(process.env.USE_PAIRING_CODE || 'true').toLowerCase() === 'true';
// رقم واتساب الأعمال: +972593456405  (بصيغة دولية بدون علامة +)
const BUSINESS_NUMBER = (process.env.BUSINESS_NUMBER || '972593456405').replace(/\D/g, '');

const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });

let latestQR = null;
let connectionStatus = 'disconnected';

// ==========================================================
//  آلة الحالات (State Machine) لكل مستخدم
// ==========================================================
const STATES = {
  IDLE: 'IDLE',
  AWAITING_SERVICE: 'AWAITING_SERVICE',
  AWAITING_NAME: 'AWAITING_NAME',
  AWAITING_SOURCE: 'AWAITING_SOURCE', // المطعم/المتجر أو عنوان الاستلام
  AWAITING_DETAILS: 'AWAITING_DETAILS', // الأصناف/قائمة الشراء/وصف الطرد
  AWAITING_DROPOFF: 'AWAITING_DROPOFF', // عنوان التسليم
  AWAITING_PHONE: 'AWAITING_PHONE',
  AWAITING_PAYMENT: 'AWAITING_PAYMENT',
  AWAITING_TIME: 'AWAITING_TIME',
  CONFIRMATION: 'CONFIRMATION',
};

// أنواع الخدمة
const SERVICE_TYPES = {
  1: { key: 'food', label: '🍔 توصيل طعام' },
  2: { key: 'parcel', label: '📦 توصيل طرود' },
  3: { key: 'grocery', label: '🛒 توصيل بقالة/متاجر' },
};

// نصوص المطالبات حسب الخدمة (خطوة المصدر + التفاصيل)
const SERVICE_PROMPTS = {
  food: {
    source: 'من أي *مطعم* تريد الطلب؟ 🍔 (اكتب اسم المطعم والفرع إن وُجد)',
    details: 'ما الأصناف التي تريدها؟ 📝 (مثال: 2 برجر دجاج + بطاطس كبير + كولا)',
  },
  parcel: {
    source: 'من أين *نستلم* الطرد؟ 📍 (عنوان الاستلام كاملاً)',
    details: 'ما محتوى الطرد؟ 📦 (مثال: مستندات، ملابس، هدية صغيرة)',
  },
  grocery: {
    source: 'من أي *متجر/بقالة* نشتري؟ 🛒 (اكتب اسم المتجر إن رغبت أو "أي متجر قريب")',
    details: 'اكتب *قائمة المشتريات* المطلوبة 📝 (مثال: حليب 2، خبز، بيض، أرز 1كجم)',
  },
};

// طرق الدفع
const PAYMENT_METHODS = {
  1: 'كاش عند الاستلام 💵',
  2: 'تحويل بنكي 🏦',
  3: 'محفظة إلكترونية 📱',
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
  `🍏 آيفون: ${APP_IOS_URL}`;

const WELCOME_MESSAGE =
  'أهلاً بك في يلا ديلفري! 🛵 نصلك أينما كنت.\n\n' +
  APP_DOWNLOAD_MESSAGE +
  '\n\nأو أكمل طلبك من هنا مباشرةً. كيف يمكننا خدمتك؟ اختر رقماً:\n\n' +
  '1️⃣ طلب توصيل جديد 📦\n' +
  '2️⃣ استفسار عن الأسعار/المناطق 💰\n' +
  '3️⃣ التحدث مع الدعم الفني 📞\n\n' +
  '💡 يمكنك كتابة "إلغاء" في أي وقت للعودة للبداية.';

const SERVICE_MENU =
  'اختر *نوع الخدمة* التي تريدها:\n\n' +
  '1️⃣ 🍔 توصيل طعام من مطعم\n' +
  '2️⃣ 📦 توصيل طرد/غرض\n' +
  '3️⃣ 🛒 توصيل بقالة/مشتريات من متجر\n\n' +
  'اكتب رقم الخدمة (1 / 2 / 3).';

const PRICING_MESSAGE =
  '💰 *الأسعار والمناطق*\n\n' +
  '• 🍔 توصيل طعام: تبدأ من 15 وحدة داخل المدينة.\n' +
  '• 📦 توصيل طرود: حسب المسافة والحجم.\n' +
  '• 🛒 توصيل بقالة: رسوم التوصيل + قيمة المشتريات.\n' +
  '• التوصيل السريع متاح خلال 60 دقيقة.\n\n' +
  'اكتب "طلب" لبدء طلب جديد، أو "إلغاء" للعودة للقائمة.';

const SUPPORT_NUMBER = process.env.SUPPORT_NUMBER || '+970593456405';
const SUPPORT_MESSAGE =
  '📞 *الدعم الفني*\n\n' +
  'فريقنا جاهز لمساعدتك:\n' +
  `• واتساب/اتصال: ${SUPPORT_NUMBER}\n` +
  '• أوقات العمل: يومياً 9 صباحاً - 11 مساءً.\n\n' +
  'اكتب "إلغاء" للعودة إلى القائمة الرئيسية.';

const PAYMENT_MENU =
  'اختر *طريقة الدفع* 💳:\n\n' +
  '1️⃣ كاش عند الاستلام 💵\n' +
  '2️⃣ تحويل بنكي 🏦\n' +
  '3️⃣ محفظة إلكترونية 📱\n\n' +
  'اكتب رقم الطريقة (1 / 2 / 3).';

const TIME_MENU =
  'متى تريد التوصيل؟ ⏰\n\n' +
  '1️⃣ في أسرع وقت (الآن)\n' +
  '2️⃣ وقت محدد لاحقاً\n\n' +
  'اكتب 1 للتوصيل الفوري، أو اكتب الوقت المطلوب مباشرة (مثال: الساعة 8 مساءً).';

// كلمات مفتاحية
const GREETING_KEYWORDS = ['مرحبا', 'مرحباً', 'السلام عليكم', 'اهلا', 'أهلا', 'هلا', 'hi', 'hello', 'start', 'بدء', 'القائمة', 'menu'];
const NEW_ORDER_KEYWORDS = ['طلب', 'طلب جديد', 'توصيل'];
const CANCEL_KEYWORDS = ['إلغاء', 'الغاء', 'تراجع', 'cancel', 'رجوع', 'خروج'];
const YES_KEYWORDS = ['نعم', 'اكيد', 'أكيد', 'تأكيد', 'تاكيد', 'موافق', 'ok', 'yes', 'y'];
const NO_KEYWORDS = ['لا', 'الغاء', 'إلغاء', 'no', 'n'];

function normalize(text) {
  return (text || '').trim().toLowerCase();
}

function includesAny(text, list) {
  const t = normalize(text);
  return list.some((k) => t === normalize(k) || t.includes(normalize(k)));
}

function generateOrderRef() {
  const ts = Date.now().toString().slice(-6);
  const rand = Math.floor(100 + Math.random() * 900);
  return `YD-${ts}${rand}`;
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
//  منطق المحادثة
// ==========================================================
function buildSummary(order) {
  return (
    '📋 *ملخص طلبك:*\n\n' +
    `🔧 الخدمة: ${order.serviceLabel}\n` +
    `👤 الاسم: ${order.customerName}\n` +
    `🏬 المصدر: ${order.source}\n` +
    `📝 التفاصيل: ${order.details}\n` +
    `🎯 التسليم إلى: ${order.dropoff}\n` +
    `📱 جوال التواصل: ${order.contactPhone}\n` +
    `💳 الدفع: ${order.paymentMethod}\n` +
    `⏰ وقت التوصيل: ${order.deliveryTime}\n\n` +
    'هل البيانات صحيحة؟ اكتب *نعم* للتأكيد أو *لا* للإلغاء.'
  );
}

/**
 * يعالج رسالة نصية واردة ويعيد نص الرد (أو مصفوفة ردود).
 */
async function handleMessage(jid, phone, text) {
  const session = getSession(jid);
  const raw = (text || '').trim();

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
      if (raw === '1' || includesAny(raw, NEW_ORDER_KEYWORDS)) {
        session.state = STATES.AWAITING_SERVICE;
        session.order = {};
        return SERVICE_MENU;
      }
      if (raw === '2' || includesAny(raw, ['اسعار', 'أسعار', 'سعر', 'مناطق', 'استفسار'])) {
        return PRICING_MESSAGE;
      }
      if (raw === '3' || includesAny(raw, ['دعم', 'مساعدة', 'مساعده', 'support'])) {
        return SUPPORT_MESSAGE;
      }
      return WELCOME_MESSAGE;
    }

    case STATES.AWAITING_SERVICE: {
      const service = SERVICE_TYPES[raw];
      if (!service) {
        return 'من فضلك اختر رقماً صحيحاً:\n\n' + SERVICE_MENU;
      }
      session.order.serviceType = service.key;
      session.order.serviceLabel = service.label;
      session.state = STATES.AWAITING_NAME;
      return `اخترت: ${service.label} ✅\n\n*الخطوة 1:* ما اسمك الكريم؟`;
    }

    case STATES.AWAITING_NAME: {
      if (!raw) return 'من فضلك اكتب اسمك للمتابعة. 🙏';
      session.order.customerName = raw;
      session.state = STATES.AWAITING_SOURCE;
      const prompts = SERVICE_PROMPTS[session.order.serviceType];
      return `تشرفنا يا ${raw} 🌟\n\n*الخطوة 2:* ${prompts.source}`;
    }

    case STATES.AWAITING_SOURCE: {
      if (!raw) return 'من فضلك أكمل هذه الخطوة للمتابعة. 🙏';
      session.order.source = raw;
      session.state = STATES.AWAITING_DETAILS;
      const prompts = SERVICE_PROMPTS[session.order.serviceType];
      return `*الخطوة 3:* ${prompts.details}`;
    }

    case STATES.AWAITING_DETAILS: {
      if (!raw) return 'من فضلك اكتب التفاصيل للمتابعة. 📝';
      session.order.details = raw;
      session.state = STATES.AWAITING_DROPOFF;
      return '*الخطوة 4:* أين نوصّل الطلب؟ 🎯 (عنوان التسليم بالتفصيل: الحي/الشارع/أقرب معلم)';
    }

    case STATES.AWAITING_DROPOFF: {
      if (!raw) return 'من فضلك اكتب عنوان التسليم. 🎯';
      session.order.dropoff = raw;
      session.state = STATES.AWAITING_PHONE;
      return '*الخطوة 5:* اكتب *رقم جوال* للتواصل معك بخصوص الطلب 📱';
    }

    case STATES.AWAITING_PHONE: {
      const digits = raw.replace(/[^\d+]/g, '');
      if (digits.replace(/\D/g, '').length < 8) {
        return 'الرقم غير واضح. من فضلك اكتب رقم جوال صحيحاً 📱 (مثال: 09xxxxxxxx).';
      }
      session.order.contactPhone = digits;
      session.state = STATES.AWAITING_PAYMENT;
      return '*الخطوة 6:* ' + PAYMENT_MENU;
    }

    case STATES.AWAITING_PAYMENT: {
      const method = PAYMENT_METHODS[raw];
      if (!method) {
        return 'من فضلك اختر رقماً صحيحاً:\n\n' + PAYMENT_MENU;
      }
      session.order.paymentMethod = method;
      session.state = STATES.AWAITING_TIME;
      return '*الخطوة 7:* ' + TIME_MENU;
    }

    case STATES.AWAITING_TIME: {
      if (!raw) return 'من فضلك حدّد وقت التوصيل. ⏰';
      session.order.deliveryTime = raw === '1' ? 'في أسرع وقت (الآن) ⚡' : raw;
      session.state = STATES.CONFIRMATION;
      return buildSummary(session.order);
    }

    case STATES.CONFIRMATION: {
      if (includesAny(raw, YES_KEYWORDS)) {
        const ref = generateOrderRef();
        const order = {
          ref,
          whatsapp: phone,
          serviceType: session.order.serviceType,
          serviceLabel: session.order.serviceLabel,
          customerName: session.order.customerName,
          source: session.order.source,
          details: session.order.details,
          dropoff: session.order.dropoff,
          contactPhone: session.order.contactPhone,
          paymentMethod: session.order.paymentMethod,
          deliveryTime: session.order.deliveryTime,
          status: 'new',
          createdAt: new Date().toISOString(),
        };

        saveOrder(order);
        resetSession(jid);

        return (
          'شكراً لك! تم استلام طلبك بنجاح ✅\n\n' +
          `🔖 رقمك المرجعي: *${ref}*\n\n` +
          'سيتواصل معك مندوبنا قريباً لتأكيد التفاصيل. يلا ديلفري 🛵💨\n\n' +
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
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    browser: ['Yalla Delivery', 'Chrome', '1.0.0'],
    markOnlineOnConnect: false,
  });

  sock.ev.on('creds.update', saveCreds);

  // الربط برمز اقتران (Pairing Code) لرقم الأعمال — بديل مسح QR
  if (USE_PAIRING_CODE && !sock.authState.creds.registered) {
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(BUSINESS_NUMBER);
        const pretty = code?.match(/.{1,4}/g)?.join('-') || code;
        console.log('\n============================================');
        console.log(`🔑 رمز اقتران واتساب الأعمال (${BUSINESS_NUMBER}):`);
        console.log(`   >>>  ${pretty}  <<<`);
        console.log('👉 على هاتف رقم الأعمال: واتساب ← الأجهزة المرتبطة ← ربط جهاز');
        console.log('   ← ربط برقم الهاتف بدلاً من ذلك ← أدخل الرمز أعلاه.');
        console.log('============================================\n');
      } catch (e) {
        console.error('⚠️ فشل توليد رمز الاقتران:', e.message, '— سيتم استخدام QR بدلاً منه.');
      }
    }, 3000);
  }

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQR = qr;
      connectionStatus = 'waiting_qr';
      console.log('\n📱 امسح الـ QR Code التالي من واتساب (الأجهزة المرتبطة):\n');
      qrcodeTerminal.generate(qr, { small: true });
      console.log(`\n🌐 أو افتح الرابط لعرض الـ QR على المتصفح: http://localhost:${PORT}/qr\n`);
    }

    if (connection === 'open') {
      latestQR = null;
      connectionStatus = 'connected';
      console.log('✅ تم الاتصال بواتساب بنجاح! البوت جاهز لاستقبال الطلبات.');
    }

    if (connection === 'close') {
      connectionStatus = 'disconnected';
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      console.log(`⚠️ انقطع الاتصال (code: ${statusCode}).`);

      if (loggedOut) {
        console.log('🚪 تم تسجيل الخروج من الجهاز. احذف مجلد الجلسة (' + AUTH_FOLDER + ') ثم أعد التشغيل لمسح QR جديد.');
      } else {
        console.log('🔄 إعادة الاتصال تلقائياً...');
        setTimeout(() => startBot().catch((e) => console.error('فشل إعادة الاتصال:', e)), 3000);
      }
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
        if (!text) continue;

        const phone = jid.split('@')[0];

        await sock.sendPresenceUpdate('composing', jid).catch(() => {});

        const reply = await handleMessage(jid, phone, text);

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
    time: new Date().toISOString(),
  });
});

app.get('/health', (_req, res) => res.status(200).send('OK'));

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

app.listen(PORT, () => {
  console.log(`🌐 السيرفر يعمل على المنفذ ${PORT}`);
  startBot().catch((err) => console.error('فشل تشغيل البوت:', err));
});
