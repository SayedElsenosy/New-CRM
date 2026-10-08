# Google Maps للترشيح الجغرافي للـ Agent

الربط اختياري (off by default). من غير Google Maps API Key يستمر النظام الحالي المبني على إحداثيات القاهرة المعروفة؛ لا تتعطل المحادثة أو الـQualification.

## Google Cloud (مرة واحدة)

1. افتح https://console.cloud.google.com/ وأنشئ Google Cloud project مرتبط بحساب Billing.
2. فعّل **Geocoding API**. لو عايز ترتيب المرشحين حسب مسافة القيادة فعّل **Routes API** كمان.
3. أنشئ **API key** من Credentials، وقيد المفتاح باستخدام API restrictions على الخدمتين فقط. استخدمه على **الخادم فقط**، ولا تضفه لواجهة Vite أو أي `VITE_*`.
4. من Google Maps Platform > Quotas حط quotas منخفضة في البداية، وأنشئ Budget alerts في Billing. تنبيهات الميزانية **مش سقف إنفاق حاسم**، لكن Quotas تقلل الاستهلاك.
5. أضف المتغيرات الآتية في Railway (خدمة whatsapp-bot)، ثم اعمل redeploy:

```env
GOOGLE_MAPS_API_KEY=YOUR_SERVER_SIDE_KEY
GOOGLE_MAPS_ROUTES_ENABLED=true
GOOGLE_MAPS_MAX_REQUESTS_PER_DAY=75
GOOGLE_MAPS_MAX_AREA_LOOKUPS_PER_TURN=8
GOOGLE_MAPS_REQUEST_TIMEOUT_MS=2400
```

ابدأ بـ `GOOGLE_MAPS_ROUTES_ENABLED=false` لو عايز Geocoding فقط. عند true: Google Routes Compute Route Matrix يرتب المرشحين بمسافة القيادة (Traffic Unaware)، من دون احتساب زحمة الوقت الفعلي. تكلفة Routes Matrix تُحسب **لكل عنصر** (عدد نقاط البداية × عدد الوجهات) وليست لكل طلب فقط. يبدأ النظام بحد أقصى **8 وجهات جغرافية فريدة** للبحث الواحد حتى لو نفس المكان فيه تشغيل ماركت ومطاعم. حالة REST/API فاشلة أو timeouts ترجع للترشيح التقريبي الموجود بدل وقف المتقدم.

## منطق الترشيح

- المستخدم: «أنا ساكن في عزبة النخل، أقرب منطقة شغل إيه؟».
- يستخرج النظام «عزبة النخل» فقط من الرسالة ويطلب من Google الإحداثيات داخل مصر (لو المنطقة مش في القاموس المحلي).
- يجمع مناطق الشغل المفعلة والمؤهلة من المكتب الحالي فقط، ويحدد الإحداثيات من `latitude/longitude` (إذا كانت موجودة) أو قاموس الأماكن المعروف أو Geocoding لمناطق غير معروفة.
- يُصنّف مبدئيًا بمسافة الخط المستقيم. عند تفعيل Routes API يحسب طرق القيادة لأقرب 8 وجهات فريدة ويعيد الترتيب بالمسافة على الطريق إن أعاد API نتائج كافية.
- عند نقص بيانات مواقع المناطق غير المعروفة، الحد `GOOGLE_MAPS_MAX_AREA_LOOKUPS_PER_TURN` يحمي من فاتورة كبيرة؛ بعض المناطق قد لا تظهر في أول ترشيح حتى يتم توفير إحداثيات لها. لتغطية كل منطقة بدقة، سجّل إحداثيات مركز كل منطقة من مصدر تملكه/مسموح باستخدامه في قاعدة البيانات إذا كانت أعمدة `latitude` و`longitude` متاحة بعد تطوير بيانات المناطق.
- لو سأل المتقدم «طب الأقرب فين؟» يتم الاحتفاظ باسم **المنطقة المدخلة** وليس إحداثيات Google في ملف المتقدم، ويعاد استخدامه في السؤال التالي.
- المسافة من السكن للترشيح فقط. **لا تعيّن `preferred_work_area` ولا `geo_qualified` آليًا**؛ تأكيد المستخدم بعد عرض تفاصيل المنطقة يظل إلزاميًا.

## الخصوصية وحدود التكلفة

- يتم إرسال **اسم منطقة السكن المستخرج فقط** إلى Google Geocoding (وليس اسم المتقدم أو رقمه أو المحادثة الكاملة).
- إحداثيات Google المخزنة مؤقتًا في **ذاكرة العملية فقط لمدة ساعة** لتقليل الاستدعاءات، ونتائج الطرق لمدة 10 دقائق. تُمسح عند Restart ولا تُخزن في Supabase. تحقّق من الالتزام بشروط Google Maps Platform قبل التشغيل التجاري.
- `GOOGLE_MAPS_MAX_REQUESTS_PER_DAY` حد وقائي **داخل كل عملية Node**؛ يعاد ضبطه عند إعادة التشغيل، ولا يمنع تجاوز فواتير Google بمفرده أو عبر تعدد النسخ. نفّذ ضبط Quotas وBilling من Google Cloud.
- لو عرضت نتائج Google على خريطة، استخدم Google Map واتبع متطلبات نسب المصدر/الشعار. رسائل واتساب تذكر «Google Maps» بوضوح.
- عند عرض الرسائل للمستخدم، تأكد من توافر شروط الاستخدام وسياسة الخصوصية المناسبة لتكامل Google.
- بمجرد انتهاء حصة التجربة يمكن ضبط `GOOGLE_MAPS_ROUTES_ENABLED=false` أو حذف المفتاح فيعود النظام للترشيح المحلي.

المراجع الرسمية:
- https://developers.google.com/maps/documentation/geocoding/guides-v3/requests-geocoding
- https://developers.google.com/maps/documentation/routes/compute_route_matrix
- https://developers.google.com/maps/documentation/routes/usage-and-billing
- https://developers.google.com/maps/documentation/geocoding/policies
