# Speed CRM Mobile

تطبيق موبايل React Native / Expo لنفس نظام CRM. يستخدم نفس Supabase Auth ونفس API الموجودة في `whatsapp-bot`، لذلك أي تعديل في الويب أو التطبيق يظهر على نفس البيانات.

## النسخة الأولى

- تسجيل دخول بنفس حسابات الموظفين.
- Dashboard سريع.
- مركز تنبيهات التدخل البشري.
- قائمة المتقدمين والبحث والتصفية حسب المرحلة.
- ملف المتقدم والمحادثة والإجابات.
- رد بشري من التطبيق.
- تشغيل/إيقاف البوت للمتقدم.
- تغيير مرحلة المتقدم إلى حضر المحاضرة / بدأ شغل / تلقائي.
- Push Notifications لتنبيهات التدخل البشري بعد تفعيل EAS وملف SQL رقم 010.

## التشغيل

1. شغّل `supabase/010_mobile_push.sql` مرة واحدة في Supabase SQL Editor.
2. انسخ `.env.example` إلى `.env` وضع نفس Supabase URL وAnon Key المستخدمين في الويب، ورابط الـBackend العام HTTPS.
3. من هذا المجلد:
   ```bash
   npm install
   npx expo start
   ```
4. لتفعيل Push Notifications على Android استخدم Development Build أو EAS Build، لأن Remote Push لا يعمل داخل Expo Go على Android:
   ```bash
   npx eas-cli@latest login
   npx eas-cli@latest init
   npx eas-cli@latest build -p android --profile preview
   ```

بعد `eas init` سيصبح Project ID متاحاً للبناء. ويمكن وضعه يدوياً في `EXPO_PUBLIC_EAS_PROJECT_ID` عند الحاجة.

## الأمان

التطبيق لا يحتوي على Service Role Key ولا مفاتيح واتساب. الدخول يتم بـSupabase Auth، وكل قراءة أو تعديل يمر على نفس API وصلاحيات الموظف المستخدمة في لوحة الويب.
