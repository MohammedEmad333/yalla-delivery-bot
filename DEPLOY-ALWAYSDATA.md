# 🚀 نشر بوت يلا ديلفري على Alwaysdata

Alwaysdata يوفّر قرصاً دائماً، فتبقى جلسة الواتساب (`auth_info`) والطلبات (`orders.json`)
محفوظة بعد إعادة التشغيل. الخطة: إنشاء موقع Node.js + سحب الكود من GitHub + إدخال رمز الاقتران عبر SSH.

---

## 1) إنشاء حساب
- سجّل في https://www.alwaysdata.com (الخطة المجانية 100MB تكفي هذا البوت).
- بعد التفعيل تدخل لوحة التحكم `admin.alwaysdata.com`.

## 2) تفعيل SSH
- من اللوحة: **Remote access → SSH** وفعّل الوصول (اسم المستخدم يكون مثل `account`).
- بيانات الدخول: `ssh account@ssh-account.alwaysdata.net`

## 3) سحب الكود وتثبيت الحزم (عبر SSH)
```bash
cd ~
git clone https://github.com/ibrhiemqandeel/yalla-delivery-bot.git
cd yalla-delivery-bot
npm install
```

## 4) إنشاء موقع Node.js
من اللوحة: **Web → Sites → Add a site**:
- **Type:** Node.js
- **Command:** `node index.js`
- **Working directory:** `/home/<account>/yalla-delivery-bot`
- **Node.js version:** 18 أو أحدث
- **Addresses:** اربط دومين alwaysdata المجاني (مثل `yourname.alwaysdata.net`).

> Alwaysdata يمرّر المنفذ تلقائياً عبر متغيّر البيئة `PORT`، والكود يستمع عليه بالفعل.

## 5) متغيّرات البيئة (Environment)
في إعداد الموقع → **Environment variables** أضف:
```
USE_PAIRING_CODE = true
BUSINESS_NUMBER  = 972593456405
SUPPORT_NUMBER   = +970593456405
APP_ANDROID_URL  = <رابط أندرويد الحقيقي>
APP_IOS_URL      = <رابط آيفون الحقيقي>
LOG_LEVEL        = warn
```

## 6) الربط بالواتساب (مرة واحدة) — عبر SSH
شغّل البوت يدوياً أول مرة لرؤية رمز الاقتران وإتمام الربط:
```bash
cd ~/yalla-delivery-bot
node index.js
```
سيظهر رمز من 8 خانات. على هاتف رقم الأعمال **+972593456405**:
> واتساب ← الأجهزة المرتبطة ← ربط جهاز ← **ربط برقم الهاتف بدلاً من ذلك** ← أدخل الرمز.

بعد ظهور "تم الاتصال بواتساب بنجاح" تُحفظ الجلسة في `auth_info/`.
أوقف العملية اليدوية بـ `Ctrl+C` (الجلسة محفوظة).

## 7) تشغيل دائم
ارجع للوحة → الموقع → **Restart**. سيعمل البوت 24/7 ويستخدم الجلسة المحفوظة بلا رمز جديد.

## 8) التحقق
- افتح `https://yourname.alwaysdata.net/` → يعرض حالة الخدمة.
- `‏/orders` لعرض الطلبات — `/health` لفحص الصحة.
- راقب **Logs** من اللوحة عند أي مشكلة.

---

### تحديث الكود لاحقاً
```bash
cd ~/yalla-delivery-bot
git pull
npm install
```
ثم **Restart** من اللوحة.

### ملاحظات
- لا تحذف مجلد `auth_info/` وإلا ستحتاج رمز اقتران جديد.
- إن غيّرت رقم الأعمال: احذف `auth_info/` ثم أعد خطوة الربط.
