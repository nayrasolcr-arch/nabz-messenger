# نقشه‌ی حذف قابلیت‌های Telegram (فاز ۵) — Dependency Map + Playbook

## وضعیت فعلی (صادقانه)

در این نسخه، **حذف فیزیکی کد** برای همه‌ی زیرسیستم‌ها انجام نشد چون هر حذف بدون build+test اندروید (که به SDK/NDK و build طولانی نیاز دارد و در محیط این جلسه مقدور نبود) نقض قانون «هر مرحله باید build و تست شود» است. به‌جای آن:

1. **مکانیزم gating** با `NabzFeatureFlags` ایجاد شد (single source of truth برای خاموش‌کردن entry pointها).
2. **branding** کامل شد (applicationId، نام، آیکون، نسخه).
3. **این playbook** با dependency map واقعی ارائه می‌شود تا حذف فیزیکی مرحله‌به‌مرحله با CI انجام شود.

## Dependency Map (از audit واقعی مخزن)

| Feature | محل اصلی (فایل‌ها/پکیج) | وابستگی‌های کلیدی | ریسک حذف |
|---------|--------------------------|--------------------|-----------|
| Stories | `ui/Stories/` (۴۹ فایل)، `StoriesController`، `MessagesController.getStories*`، `SharedMediaLayout` (tab stories)، `ProfileActivitiesView` | MessagesController، Notifications، MediaDataController | بالا |
| Channels | `ui/Channel*` (۶+ فایل)، `ChannelCreateActivity`، `ChannelAdminLogActivity`، `ChatActivity` (flags isChannel)، `MessagesController` (TL_channel*) | tgnet TL objects، Chat object مشترک با گروه‌ها | بسیار بالا (chat object مشترک) |
| Stars / Payments | `ui/Stars/` (۲۱ فایل)، `BotStarsController`، `ui/PaymentFormActivity`، `StarsController` | TLRPC.payments*، InvoiceArgs در ChatActivity | متوسط |
| Bots / Mini Apps | `ui/bots/` (۲۳ فایل)، `BotWebViewContainer`، `MessagesController` bot hooks | keyboard buttons، inline results در ChatUI | بالا (inline UI مشترک) |
| Sponsored/Ads | ۶ ارجاع `SponsoredMessages` (MessagesController، ChatActivity، Notifications) | TL messages.sponsored | کم |
| Telegram Auth | `tgnet/` (MTProto)، `ui/LoginActivity`، `ApplicationLoader` (connection state) | تقریباً همه‌ی `MessagesController` | **بسیار بالا — آخرین مرحله** |
| Cloud Sync TG | `SharedConfig`، `MessagesController.processUpdates` | هسته‌ی sync | بسیار بالا |

## ترتیب پیشنهادی حذف (هر مرحله = یک PR با build/test سبز)

1. **Sponsored/Ads** — حذف نمایش و fetch (کم‌ترین وابستگی)
2. **Stars/Payments** — حذف UI + TL handlers مربوطه
3. **Stories** — حذف پکیج + جداسازی از SharedMediaLayout/Profile
4. **Bots/Mini Apps** — حذف webview + inline (نگه‌داشتن keyboard buttons پایه برای UI عمومی)
5. **Channels** — شروع از UI (Channel*Activity) و سپس flags در ChatActivity؛ TLRPC کلاس‌ها را نگه دارید (Chat مشترک است)
6. **Telegram Auth + tgnet** — تنها پس از آنکه همه‌ی UI به `app.nabz.net.*` مهاجرت کرد؛ tgnet را کامل حذف و ConnectionsManager را با stub جایگزین کنید
7. **Resource cleanup** — strings/layoutهای یتیم (rg برای نام resource پیش از حذف هر res)

## چک‌لیست هر مرحله (طبق بند ۱۶ مأموریت)

- [ ] rg برای importها/references/نام resource
- [ ] بررسی navigation routes (LaunchActivity / navbar)
- [ ] بررسی DB (MessageObject types)، network (TL)، tests، build deps
- [ ] compile + lint + unit + assembleDebug در CI (build-apk.yml)
- [ ] در صورت شکست: fix یا revert به checkpoint قبلی
