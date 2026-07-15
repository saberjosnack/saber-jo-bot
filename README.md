# Saber Jo Snack — بوت واتساب + داشبورد إدارة

مشروع بوت ذكاء اصطناعي لمطعم Saber Jo Snack (عمّان) يرد على الزباين، يسحب الطلبات، ويرسل الصور — مع داشبورد كامل للتحكم.

## هيكلة المشروع

```
saber-jo-bot/
├── src/
│   ├── server.js              # نقطة تشغيل السيرفر
│   ├── config/env.js          # قراءة متغيرات البيئة
│   ├── routes/
│   │   ├── webhook.js         # استقبال رسائل واتساب/ميتا
│   │   ├── auth.js            # تسجيل الدخول + نسيت كلمة المرور
│   │   └── dashboard.js       # API الداشبورد (منيو، توصيل، إعدادات، موظفين)
│   ├── services/
│   │   ├── ai.js              # الاتصال بموديل Claude
│   │   ├── whatsapp.js        # إرسال الرسائل (Green API أو Meta Cloud API)
│   │   ├── promptBuilder.js   # يبني البرومبت النهائي من الإعدادات
│   │   └── mailer.js          # إرسال إيميلات (استرجاع كلمة مرور، دعوات موظفين)
│   ├── middleware/auth.js     # حماية الـ API بالتوكن + الصلاحيات
│   └── data/                  # تخزين مبدئي (JSON) — يتبدّل لقاعدة بيانات حقيقية لاحقاً
│       ├── menu.json
│       ├── deliveryFees.json
│       ├── settings.json
│       ├── employees.json
│       └── orders.json
└── docs/architecture.md
```

## التشغيل محلياً

```bash
npm install
cp .env.example .env    # وعبّي القيم
npm run dev
```

## رفعه على GitHub (أول مرة)

```bash
cd saber-jo-bot
git init
git add .
git commit -m "Initial project structure"
git branch -M main
git remote add origin <رابط الريبو الفاضي يلي عملته على GitHub>
git push -u origin main
```

## النشر على Render

1. سجل دخول على Render واختار "New Web Service".
2. اربطه مع الريبو يلي رفعناه.
3. Build Command: `npm install` — Start Command: `npm start`
4. ضيف كل المتغيرات يلي بـ `.env.example` من تبويب Environment.
5. أي Push جديد على GitHub بيعمل Deploy تلقائي.

## ربط واتساب

- **مبدئياً (تجريبي):** حط `WA_PROVIDER=green` واملأ `GREEN_API_*` — بيشتغل بمسح QR.
- **لاحقاً (رسمي وآمن أكتر):** حط `WA_PROVIDER=cloud` واملأ `WHATSAPP_*` من Meta for Developers. الكود ما بيتغير — بس بتبدّل المزود من `.env`.

نقطة الـ Webhook يلي تحطها بإعدادات ميتا:
`https://<اسم-تطبيقك-على-Render>.onrender.com/webhook`

## ملاحظة مهمة

هاي نسخة MVP بتخزن البيانات بملفات JSON عشان نبلش سريع بدون تعقيد. قبل ما تزيد حجم الطلبات، لازم ننقل التخزين لقاعدة بيانات حقيقية (Postgres على Render) — الكود مصمم بحيث النقلة سهلة (كل التخزين مركز بـ `src/data/` ومعزول عن باقي المنطق).
