# Saber Jo Snack — بوت واتساب + داشبورد إدارة

مشروع بوت ذكاء اصطناعي لمطعم Saber Jo Snack (عمّان) يرد على الزباين، يسحب الطلبات، ويرسل الصور — مع داشبورد كامل للتحكم.

## هيكلة المشروع

```
saber-jo-bot/
├── src/
│   ├── server.js
│   ├── config/env.js
│   ├── routes/
│   │   ├── webhook.js         # استقبال رسائل Green/UltraMsg/Cloud (بوت "default" فقط)
│   │   ├── auth.js
│   │   ├── dashboard.js       # موظفين + محادثات موقوفة
│   │   └── bots.js            # CRUD كامل للبوتات: إنشاء، منيو، إعدادات، توصيل، QR
│   ├── services/
│   │   ├── ai.js
│   │   ├── whatsapp.js        # Green API / UltraMsg / Cloud API (بوت واحد)
│   │   ├── selfHostedWhatsapp.js  # اتصال مباشر متعدد البوتات (Baileys)
│   │   ├── botStore.js        # إدارة سجل البوتات والقوالب المشتركة
│   │   ├── messageHandler.js  # منطق الرد المشترك بين كل المزودين
│   │   ├── promptBuilder.js
│   │   └── mailer.js
│   ├── middleware/auth.js
│   └── data/
│       ├── bots.json                    # سجل كل البوتات
│       ├── configs/{configId}/          # منيو + توصيل + برومبت — ممكن يشاركه أكتر من بوت
│       │   ├── menu.json
│       │   ├── deliveryFees.json
│       │   └── settings.json
│       ├── bots/{botId}/                # بيانات خاصة بكل بوت لحاله
│       │   ├── conversations.json
│       │   ├── pausedConversations.json
│       │   ├── orders.json
│       │   └── wa-auth/                 # جلسة واتساب (لا تُرفع لـ GitHub أبداً)
│       └── employees.json
└── docs/architecture.md
```

## تعدد البوتات

كل بوت إله سجل مستقل (`bots/{id}/`) لمحادثاته وطلباته، وإله "قالب إعدادات" (`configId`) فيه المنيو والتوصيل والبرومبت. لما تنشئ بوت جديد، تقدر:
- تعطيه قالب جديد مستقل (منيو وتعليمات خاصة فيه)، أو
- تخليه يشارك **نفس** قالب بوت موجود — فأي تعديل عالمنيو أو التعليمات بينعكس على كل البوتات يلي عم تشاركه.

الربط بواتساب لكل بوت مستقل تماماً (رقم مختلف، جلسة مختلفة)، حتى لو شاركوا نفس المنيو.

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
