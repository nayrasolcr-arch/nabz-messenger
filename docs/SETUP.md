# راه‌اندازی (Setup)

این سند دقیقاً مراحل لازم برای راه‌اندازی از صفر را توضیح می‌دهد.

## ۱) پیش‌نیازها

- Node.js 20+ و npm
- یک اکانت Cloudflare (Free Plan کافی است)
- یک اکانت GitHub (برای CI/CD)
- برای build اندروید: JDK 17 + Android SDK + NDK 27.2.12479018 (یا استفاده از GitHub Actions)

## ۲) ایجاد منابع Cloudflare

```bash
cd backend
npm install

# ورود
npx wrangler login

# ساخت دیتابیس D1 و اعمال schema
npx wrangler d1 create nabz-db
# -> database_id خروجی را در backend/wrangler.toml جای PLACEHOLDER_SET_BY_DEPLOY بگذارید

# ساخت namespace مربوط به attachments (KV)
npx wrangler kv namespace create ATTACHMENTS
# -> id خروجی را در wrangler.toml جایگزین کنید

# اعمال مهاجرت‌ها روی دیتابیس ریموت
npx wrangler d1 migrations apply nabz-db --remote
```

## ۳) Secrets سمت سرور

```bash
# کد دعوت اختیاری - اگر ست شود، رجیستری بدون آن رد می‌شود (برای ۲۰ کاربر توصیه می‌شود)
npx wrangler secret put INVITE_CODE

# فقط در صورت استفاده از TURN (اختیاری - از یک provider خریداری/خودمیزبان)
npx wrangler secret put TURN_URLS
npx wrangler secret put TURN_USERNAME
npx wrangler secret put TURN_CREDENTIAL

# فقط در صورت استفاده از Push واقعی (سرویس‌اکانت Firebase - رایگان)
npx wrangler secret put FCM_SERVICE_ACCOUNT_JSON

# فقط در صورت استفاده از Provider خارجی AI به‌جای Workers AI
npx wrangler secret put AI_API_KEY
```

## ۴) Deploy

```bash
npx wrangler deploy
# خروجی یک URL مثل https://nabz-backend.<subdomain>.workers.dev می‌دهد
curl https://nabz-backend.<subdomain>.workers.dev/health
```

## ۵) اتصال کلاینت اندروید

در `TMessagesProj/src/main/java/app/nabz/NabzConfig.java` مقدار
`API_BASE_URL` را به URL بالا تغییر دهید و مجدداً build بگیرید.

## ۶) اولین کاربر

```bash
curl -X POST https://.../api/v1/auth/register \
  -H 'content-type: application/json' \
  -d '{"username":"alice","password":"<strong-password>","display_name":"Alice"}'
```

کلاینت با همان username/password وارد می‌شود (Login screen فعلی Telegram در فاز بعدی به این صفحه‌ی لاگین جدید متصل می‌شود؛ تا آن زمان API با curl/Postman قابل استفاده است).

## ۷) Secrets در GitHub

در Settings → Secrets and variables → Actions مخزن:

| Secret | توضیح |
|--------|-------|
| `CLOUDFLARE_API_TOKEN` | توکن با حداقل دسترسی: Workers Scripts:Edit، D1:Edit، KV:Edit |
| `CLOUDFLARE_ACCOUNT_ID` | شناسه‌ی اکانت Cloudflare |

هر دو workflow ‏`deploy-backend.yml` و `test.yml` از این‌ها استفاده می‌کنند.

## ۸) ساخت APK

```bash
# به‌صورت لوکال:
./gradlew :TMessagesProj_App:assembleDebug

# یا از GitHub Actions:
# Actions → build-apk → Run workflow → artifact «nabz-debug-apk»
```

## ۹) فعال‌سازی Push (اختیاری، رایگان)

1. در Firebase Console یک پروژه بسازید و اپ اندروید را با package `app.nabz.messenger` اضافه کنید
2. یک Service Account با نقش «Firebase Cloud Messaging API Admin» بسازید و JSON آن را در `FCM_SERVICE_ACCOUNT_JSON` قرار دهید
3. در کلاینت، توکن FCM را با `POST /api/v1/push/register` ثبت کنید

## ۱۰) فعال‌سازی AI

پیش‌فرض: Workers AI (رایگان - Llama 3.1 8B) با binding `[ai]` در wrangler.toml.
چیزی لازم نیست جز deploy. اگر provider دیگری خواستید `AI_API_KEY` (+ اختیاری `AI_BASE_URL`) را ست کنید.
