# گزارش نهایی — Nabz Private Messenger (فاز ۲۷)

> تاریخ: 2026-09-16 | مخزن: `nayrasolcr-arch/nabz-messenger` | Branch: `feature/nabz-v1`

## ۱) قابلیت‌هایی که حذف شد / غیرفعال شد

| قابلیت | وضعیت | روش |
|--------|-------|-----|
| Telegram Authentication (کد تلفن، MTProto auth) | حذف از مسیر product | جایگزین کامل با Auth اختصاصی (username/password + session) در Backend؛ حذف فیزیکی `tgnet` طبق REMOVAL-PLAN مرحله ۶ (بعد از مهاجرت کامل UI) |
| Channels / Channel Management | غیرفعال (flag) + playbook حذف | `NabzFeatureFlags.CHANNELS=false`، نقشه‌ی وابستگی در `docs/REMOVAL-PLAN.md` |
| Stories | غیرفعال (flag) + playbook | همان بالا (۴۹ فایل، نقشه موجود) |
| Telegram Stars / Payments | غیرفعال (flag) + playbook | ۲۱ فایل Stars + PaymentFormActivity |
| Bots / Mini Apps | غیرفعال (flag) + playbook | ۲۳ فایل bots |
| Sponsored / Ads | غیرفعال (flag) | ۶ ارجاع شناسایی‌شده — اولین مرحله‌ی حذف فیزیکی |
| Telegram Cloud Sync / Discovery | غیرفعال (flag) + playbook | مهاجرت به sync اختصاصی |

**دلیل صادقانه‌ی عدم حذف فیزیکی کامل:** هر حذف فیزیکی در این کدبیس (۳۰۰۰ فایل Java با کوپلینگ سنگین) بدون build+test اندروید نقض قانون ۵ مأموریت است؛ محیط این جلسه رم/دیسک کافی برای build Telegram نداشت (۴GB رم). روش جایگزین (gating + playbook + CI verification) امن و قابل ادامه است.

## ۲) قابلیت‌هایی که حفظ شد / پیاده شد

- Chat UI/UX کامل Telegram (انیمیشن، ژست، swipe-to-reply، message grouping، unread counter، دارک/لایت)
- Voice Message (ضبط/پخش/seek/waveform — کد موجود Telegram حفظ شد + مسیر آپلود/دانلود جدید)
- Voice Call (WebRTC/Opus — `messenger/voip` حفظ شد + `NabzCallClient` جدید با signaling سرور خودمان)
- Notifications، Media UI، Search، Profile، Groups، Local caching

## ۳) چه چیزهایی rewrite شد

- **کل Backend از صفر** (TypeScript/Hono/D1/DO) — هیچ وابستگی به Telegram Server
- **Authentication** از صفر: PBKDF2-SHA256 (50k iter، salt per-user)، access/refresh با rotation، **reuse-detection** (استفاده‌ی مجدد refresh ⇒ ابطال کل خانواده‌ی session)، device registry، logout-all
- **Realtime**: WebSocket با Durable Object + Hibernation API (presence، typing، fan-out رویدادها، signaling تماس)
- **Storage پیوست‌ها**: abstraction لایه — امروز KV، فردا R2 بدون تغییر کد
- **Branding**: applicationId `app.nabz.messenger`، نام «Nabz» در ۱۵ لوکال، آیکون جدید (موتив نبض)، نسخه 1.0.0

## ۴) Backend چگونه کار می‌کند

Hono روی Workers؛ ‏`/api/v1/*` با ۲۰+ endpoint (لیست کامل در ARCHITECTURE.md)؛ middleware زنجیره‌ای: security headers → rate limit → zod validation → requireAuth → requireMembership. خطاها همیشه envelope استاندارد `{error:{code,message}}` بدون leak داخلی.

## ۵) منابع Cloudflare

| Resource | نام/شناسه | وضعیت |
|----------|-----------|-------|
| Worker | `nabz-backend` → https://nabz-backend.nayrasolcr-nabz.workers.dev | ✅ Deployed |
| D1 | `nabz-db` = `a8a27ce1-aab1-41c0-8503-9a006f617c3b` | ✅ + ۲ migration اعمال‌شده |
| Durable Objects | RealtimeHub, RateLimiter (SQLite classes - Free-compatible) | ✅ |
| KV | `ATTACHMENTS` | ⚠️ **ساخته نشد — توکن شما دسترسی KV ندارد** (کد و wrangler.toml آماده؛ دو دستور در SETUP.md) |
| workers.dev subdomain | `nayrasolcr-nabz` | ✅ از طریق API ساخته شد |
| Workers AI | binding `AI` → `@cf/meta/llama-3.1-8b-instruct-fp8` | ✅ زنده (پاسخ فارسی تست شد) |

## ۶) WebSocket چگونه کار می‌کند

`/ws` → RealtimeHub DO؛ auth اولین پیام (alarm ۱۰s)، subscribe خودکار به مکالمات کاربر، auto ping/pong بدون بیدار شدن DO، fan-out رویدادهای REST، presence سراسری، reconnect کلاینت با backoff+resync.

## ۷) Voice Call چگونه کار می‌کند

REST lifecycle (`ringing→active→ended/missed/rejected` + پیام سیستمی در تاریخچه) + signaling passthrough روی WS (`offer/answer/ICE`) + رسانه‌ی P2P با Opus. STUN عمومی؛ TURN فقط وقتی secret ست شود (کلید هرگز در APK نیست). Missed-call sweep با پیام سیستمی + push.

## ۸) Voice Chat گروهی — تحلیل صادقانه

- **روی Cloudflare اجرا می‌شود:** signaling، state، presence — بله.
- **روی Cloudflare اجرا نمی‌شود:** SFU/media server (Cloudflare چنین سرویسی در Free ندارد).
- انتخاب فعلی: WebRTC Mesh تا ۴ نفر همزمان (برای ۲۰ کاربر واقع‌بینانه). برای بیشتر: SFU خودمیزبان (مثل LiveKit روی VPS — هزینه دارد) — معماری به‌گونه‌ای طراحی شده که اضافه‌شدنش کلاینت/سرور را نمی‌شکند.

## ۹) AI چگونه کار می‌کند

`/api/v1/ai/chat` → auth → rate limit → ذخیره پیام → Workers AI (`llama-3.1-8b-instruct-fp8`) → ذخیره پاسخ. fallback: `AI_API_KEY` برای OpenAI-compatible. کلید فقط سمت سرور. پاسخ فارسی زنده تأیید شد.

## ۱۰) هزینه — چه چیزهایی Free است

✅ رایگان: Workers (100k req/day)، D1 (5GB)، DO+KV (سهمیه رایگان)، Workers AI (neurons رایگان)، GitHub Actions (repo عمومی = رایگان)، STUN عمومی
💰 ممکن در آینده: TURN provider (برای NAT متقارن — Cloudflare Calls TURN پولی است)، SFU برای voice chat بزرگ، دامنه اختصاصی، R2 در صورت حجم بالا

## ۱۱) APK — کجا و چطور

- **ساخته شد**: `BUILD SUCCESSFUL in 43m 15s` روی GitHub Actions (ubuntu-latest، NDK 27.2.12479018، submodules کامل)
- دریافت: GitHub → Actions → Build APK (روی commit `95dd8e4b`) → artifact **`nabz-debug-apk`** (~114MB، شامل `afat/debug/app.apk`)
- کپی محلی: `download/nabz-debug.apk`
- نکته: قبل از استفاده‌ی واقعی، `NabzConfig.API_BASE_URL` را به `https://nabz-backend.nayrasolcr-nabz.workers.dev` تغییر دهید و build جدید بگیرید (الان placeholder دارد)

## ۱۲) وضعیت‌ها

| مورد | وضعیت |
|------|-------|
| آخرین commit | `95dd8e4b` (branch feature/nabz-v1) |
| Backend tests | 35/35 ✅ لوکال + ✅ CI |
| typecheck | ✅ |
| Live smoke test | ✅ (register/login/conv/message/react/read/IDOR 403/search/AI) |
| Deployment | ✅ Workers + D1 زنده؛ ⚠️ KV منتظر دسترسی |
| CI | test.yml ✅ سبز؛ **build-apk.yml ✅ BUILD SUCCESSFUL (43m) — artifact `nabz-debug-apk` (114MB) منتشر و صحت‌سنجی شد**؛ deploy-backend آماده (dispatch پس از merge به master) |
| APK | ✅ دانلود و verify شد (11520 entry، manifest موجود) |

## ۱۳) Security reminders (مهم!)

1. **هر دو توکنی که در چت paste کردید را حتماً Revoke کنید** (GitHub: Settings→Developer settings→Tokens؛ Cloudflare: Dashboard→API Tokens). آن‌ها در چت لو رفته‌اند.
2. Secretهای جدید (CLOUDFLARE_API_TOKEN/ACCOUNT_ID) در GitHub Secrets تنظیم شدند — با least-privilege توکن جدید بسازید (Workers Scripts:Edit + D1:Edit + KV:Edit).
3. کد دعوت (INVITE_CODE) روی سرور ست شده — مقدارش در فایل لوکال `nabz-invite-code.txt` تحویل داده شده؛ با `wrangler secret put INVITE_CODE` قابل تغییر است.
