# تشغيل مسار 24/7 مجاناً على Oracle Cloud

الهدف من هذا الوضع: تجربة السيستم الحقيقي على سيرفر سحابي بدون إبقاء جهازك مفتوحاً وبدون دفع استضافة قبل التأكد من نجاحه.

## التركيبة

- Oracle Cloud Always Free VM لتشغيل البوت وChromium.
- Supabase Free لقاعدة البيانات والمصادقة.
- Tailscale Funnel لإعطاء السيرفر رابط HTTPS عام بدون شراء دومين.
- الفهم الذكي للردود يعمل محلياً داخل الكود بدون Gemini أو OpenAI API.

## قبل البداية

تحتاج:
1. حساب Oracle Cloud.
2. حساب Tailscale مجاني.
3. مشروع Supabase بعد تنفيذ `supabase/001_masar.sql`.

> Oracle قد يطلب بطاقة للتحقق من الهوية عند إنشاء الحساب، لكن موارد Always Free لا تُحاسب طالما اخترت الموارد المجانية والتزمت بحدودها.

## 1) إنشاء VM مجانية على Oracle

أنشئ Compute Instance باستخدام Ubuntu على Ampere A1 ضمن Always Free.

اختيار مناسب للتجربة:
- 1 OCPU
- 6 GB RAM
- Boot volume ضمن المساحة المجانية

نزّل مفتاح SSH عند إنشاء السيرفر واحتفظ به.

## 2) دخول السيرفر

من Windows PowerShell:

```powershell
ssh -i C:\path\to\your-key.key ubuntu@PUBLIC_IP
```

## 3) تنزيل المشروع

على السيرفر:

```bash
git clone https://github.com/SayedElsenosy/New-CRM.git
cd New-CRM
git checkout free-local-bot
```

## 4) تثبيت Docker وTailscale

```bash
sudo bash oracle/install.sh
```

بعدها:

```bash
sudo tailscale up
```

سيظهر لك رابط تسجيل دخول. افتحه من متصفحك وسجل بحساب Tailscale.

## 5) إعداد Supabase

أنشئ الملف:

```bash
nano whatsapp-bot/.env
```

واكتب:

```env
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVICE_ROLE_KEY
DASHBOARD_ORIGIN=https://YOUR-TAILSCALE-NAME.ts.net
PORT=3001
SESSION_PATH=/data/whatsapp
```

استبدل `YOUR-TAILSCALE-NAME.ts.net` باسم الجهاز الذي سيظهر في Tailscale.

مهم: `SUPABASE_SERVICE_ROLE_KEY` يبقى على السيرفر فقط.

## 6) إعداد الواجهة

أنشئ:

```bash
nano admin-dashboard/.env
```

واكتب:

```env
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR_ANON_KEY
```

لا تحتاج `VITE_BOT_API_URL` في وضع Oracle لأن الواجهة والـAPI يعملان من نفس الرابط.

## 7) تشغيل السيستم

```bash
sudo bash oracle/start.sh
```

سيبني Docker الصورة، يشغّل البوت، ثم يفتح Tailscale Funnel على HTTPS.

## 8) فتح الـCRM

الرابط يكون بالشكل:

`https://YOUR-TAILSCALE-NAME.ts.net`

سجل الدخول بحساب Supabase الذي أضفته إلى `masar_staff`.

## 9) ربط واتساب

من صفحة **ربط واتساب**:
1. اضغط **ربط واتساب**.
2. افتح واتساب على الهاتف.
3. الأجهزة المرتبطة.
4. ربط جهاز.
5. امسح QR.

جلسة واتساب محفوظة في Docker volume باسم `masar_whatsapp`. إعادة تشغيل السيرفر أو الحاوية لا يفترض أن يطلب QR من جديد ما لم تعمل Logout/Disconnect أو تحذف الـvolume.

## 10) التأكد أن كل شيء شغال

اختبر:
- استقبال رسالة من رقم آخر.
- ظهور الرقم الحقيقي وليس LID إن كان WhatsApp يتيح mapping.
- تسجيل المحادثة.
- سؤال الاسم والعمر والمنطقة.
- نعم/لا بصيغة مصرية غير مباشرة.
- استفسار عن تفاصيل منطقة أثناء سؤال آخر.
- تعطيل وتشغيل البوت لمتقدم.
- التقارير.
- فصل وربط واتساب.
- إعادة تشغيل السيرفر ثم التأكد أن جلسة واتساب رجعت.

## تحديث المشروع لاحقاً

```bash
sudo bash oracle/update.sh
```

## مراقبة اللوج

```bash
docker logs -f masar
```

## إعادة تشغيل

```bash
docker restart masar
```

## ملاحظات مهمة

- لا تفتح بورت 3001 للعالم؛ Tailscale Funnel هو الواجهة العامة.
- لا تشغل أكثر من instance واحدة لنفس حساب واتساب.
- لا تحذف Docker volume الخاص بالجلسة إلا لو تريد ربط QR من جديد.
- لو Oracle أوقفت VM خاملة حسب سياساتها، شغّلها من لوحة Oracle وراجع الموارد المجانية المتاحة.
