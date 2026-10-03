# التشغيل المجاني على Windows

هذا الوضع يشغّل **لوحة مسار + بوت واتساب + QR** على جهازك بدون Gemini وبدون OpenAI API وبدون Render.

## التكلفة

- فهم الردود: محلي داخل الكود، بدون تكلفة لكل رسالة.
- واتساب: عبر WhatsApp Web و QR.
- قاعدة البيانات: يمكن استخدام Supabase Free طالما استخدامك داخل حدود الخطة.
- الاستضافة: جهازك نفسه، لذلك لا توجد تكلفة استضافة للبوت.

> لكي يرد البوت 24/7 يجب أن يظل الكمبيوتر شغالاً ومتصلاً بالإنترنت.

## 1) المطلوب مرة واحدة

ثبّت Node.js 22 أو أحدث.

## 2) إعداد قاعدة البيانات

نفّذ ملف `supabase/001_masar.sql` في Supabase كما هو موضح في `DEPLOY_AR.md`.

## 3) إعداد خدمة البوت

انسخ:

`whatsapp-bot/.env.example`

إلى:

`whatsapp-bot/.env`

وضع:

```env
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVICE_ROLE_KEY
DASHBOARD_ORIGIN=http://localhost:5173
PORT=3001
SESSION_PATH=./sessions
```

لا يوجد `GEMINI_API_KEY` ولا `OPENAI_API_KEY`.

## 4) إعداد لوحة التحكم

انسخ:

`admin-dashboard/.env.example`

إلى:

`admin-dashboard/.env`

واكتب:

```env
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR_ANON_KEY
VITE_BOT_API_URL=http://localhost:3001
```

## 5) التشغيل

اضغط مرتين على:

`START_FREE_WINDOWS.bat`

في أول مرة سيقوم بتثبيت المكتبات ثم يفتح خدمتين:
- Masar WhatsApp Bot
- Masar Dashboard

ثم تفتح اللوحة على:

`http://localhost:5173`

## 6) ربط واتساب

من اللوحة افتح صفحة **ربط واتساب** ثم اضغط **ربط واتساب**. امسح QR من:
واتساب > الأجهزة المرتبطة > ربط جهاز.

جلسة واتساب تُحفظ داخل مجلد `whatsapp-bot/sessions` على جهازك، فلا تحتاج QR كل مرة إلا إذا فصلت الجلسة أو حذف المجلد.

## الفهم الذكي المحلي

البوت يفهم بدون خدمة AI خارجية الحالات المطلوبة لمسار التوظيف، ومنها:
- نعم / لا بصيغ مصرية مباشرة وغير مباشرة.
- مثال: «لسه مجبتش موتوسيكل» = لا.
- العمر حتى لو مكتوب بأرقام عربية.
- المنطقة المسجلة في لوحة المناطق.
- سؤال مثل «تفاصيل الشغل في أكتوبر؟».
- اسم بصيغة «اسمي ...».

لو الرد غامض فعلاً، البوت لا يخمّن؛ يطلب من المتقدم توضيح الإجابة.

## ملاحظة عن ChatGPT Plus

اشتراك ChatGPT Plus ليس OpenAI API credit. لذلك هذه النسخة لا تحتاجه أصلاً، ولا تحتاج دفع API لكل رسالة. تشغيل البوت المحلي بهذه الطريقة هو المسار الأبسط لتجنب التكلفة المتكررة.
