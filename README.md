# Nabz — پیام‌رسان خصوصی (حداکثر ۲۰ کاربر)

Nabz («نبض» به معنی ضربان) یک پیام‌رسان خصوصی کوچک است که از سورس‌باز Telegram Android به‌عنوان مرجع UI/UX و پایه‌ی کد شروع می‌شود، اما **Backend کاملاً مستقل** روی Cloudflare دارد و به سرورهای Telegram هیچ وابستگی‌ای ندارد.

## معماری در یک نگاه

```
Android Client (fork of Telegram Android, applicationId: app.nabz.messenger)
   │
   ├── HTTPS REST  /api/v1/*        (Hono on Cloudflare Workers)
   ├── WebSocket    /ws              (RealtimeHub Durable Object - hibernation)
   └── WebRTC P2P   (Opus)           (signaling via the same WebSocket)
        ▼
   Cloudflare
   ├── Workers  (nabz-backend)
   ├── D1       (nabz-db - SQLite, versioned migrations)
   ├── KV       (attachments storage - R2-ready abstraction)
   ├── Durable Objects (RealtimeHub, RateLimiter)
   └── Workers AI (Llama 3.1 - گزینه پیش‌فرض AI، کلیدها فقط سمت سرور)
```

## قابلیت‌ها

- چت خصوصی و گروهی، Reply، ویرایش، حذف، Reactions، Pin، جست‌وجو
- Typing indicator، Presence (آنلاین/آفلاین)، Read receipts، شمارنده‌ی پیام خوانده‌نشده
- Voice Message (آپلود/دانلود + waveform) و Voice Call (WebRTC/Opus) + Missed call
- AI Assistant داخلی (چت اختصاصی AI؛ کلید مدل فقط سمت سرور)
- Push notifications (معماری FCM HTTP v1 آماده؛ پیش‌فرض خاموش تا Firebase وصل شود)
- دارک/لایت مود، انیمیشن‌ها و ژست‌های به‌ارث‌رسیده از Telegram

## ساختار مخزن

| مسیر | توضیح |
|------|-------|
| `TMessagesProj/` | سورس اندروید (fork از Telegram Android - GPLv2) |
| `TMessagesProj/src/main/java/app/nabz/` | لایه‌ی جدید Nabz: Config، FeatureFlags، Repositories، Realtime، WebRTC |
| `backend/` | Backend کامل روی Cloudflare Workers (TypeScript + Hono + D1 + DO) |
| `backend/migrations/` | مهاجرت‌های version-controlled دیتابیس D1 |
| `backend/test/` | ۳۵ تست یکپارچه (auth/messaging/security/realtime/calls/AI) |
| `docs/` | SETUP، ARCHITECTURE، ENVIRONMENT، SECURITY، REMOVAL-PLAN، REPORT |
| `.github/workflows/` | test.yml، build-apk.yml، deploy-backend.yml |

## شروع سریع

1. راه‌اندازی Backend: [docs/SETUP.md](docs/SETUP.md)
2. ساخت APK: workflow ‏`build-apk.yml` را اجرا کنید و artifact را دانلود کنید
3. متصل کردن کلاینت: مقدار `NabzConfig.API_BASE_URL` را به آدرس Worker خودتان تغییر دهید

## License و Branding

- کد اندروید تحت **GPLv2** از Telegram Android fork شده؛ فایل `LICENSE` حفظ شده است.
- نام، لوگو، applicationId و هویت بصری «Nabz» اختصاصی است و ربطی به Telegram trademark ندارد.
