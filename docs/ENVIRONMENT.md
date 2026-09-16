# متغیرهای محیطی و Secrets

## قاعده‌ی طلایی

هیچ Secretی در source، commit، log، APK یا artifact قرار نمی‌گیرد. مقادیر فقط از طریق `wrangler secret put` (سمت سرور) و GitHub Secrets (سمت CI) ست می‌شوند.

## ۱) Vars غیرمحرمانه (`backend/wrangler.toml`)

| نام | پیش‌فرض | توضیح |
|-----|---------|-------|
| `ENVIRONMENT` | production | برچسب محیط |
| `PBKDF2_ITERATIONS` | 50000 | تعداد iteration هش پسورد (بالاتر = کندتر/امن‌تر) |
| `SESSION_TTL_HOURS` | 24 | عمر access token |
| `REFRESH_TTL_DAYS` | 30 | عمر refresh token |
| `MAX_MESSAGE_LENGTH` | 4096 | سقف طول پیام |
| `MAX_ATTACHMENT_BYTES` | 24000000 | سقف حجم پیوست (KV: 25MB) |
| `ALLOW_REGISTRATION` | true | باز/بسته بودن ثبت‌نام |
| `MAX_GROUP_MEMBERS` | 50 | سقف اعضای گروه |
| `AI_MODEL` | @cf/meta/llama-3.1-8b-instruct | مدل Workers AI یا مدل provider |
| `STUN_URLS` | google/twilio STUN | سرورهای STUN عمومی |
| Rate-limit overrides (`REGISTER_RL_LIMIT` …) | - | فقط برای تست‌ها؛ پیش‌فرض‌ها در کد |

## ۲) Secrets سمت سرور (`wrangler secret put`)

| نام | لازم؟ | توضیح |
|-----|-------|-------|
| `INVITE_CODE` | توصیه‌شده | اگر ست شود، ثبت‌نام فقط با این کد |
| `AI_API_KEY` | اختیاری | فقط برای provider خارجی؛ Workers AI به آن نیاز ندارد |
| `AI_BASE_URL` | اختیاری | مثل `https://api.openai.com/v1` |
| `TURN_URLS` / `TURN_USERNAME` / `TURN_CREDENTIAL` | اختیاری | فعال‌سازی TURN برای NAT متقارن |
| `FCM_SERVICE_ACCOUNT_JSON` | اختیاری | کلید سرویس‌اکانت Firebase برای Push (تک‌خطی JSON) |

## ۳) GitHub Secrets

| نام | استفاده |
|-----|---------|
| `CLOUDFLARE_API_TOKEN` | deploy-backend.yml — توکن با حداقل دسترسی: `Workers Scripts:Edit`، `D1:Edit`، `KV Storage:Edit` |
| `CLOUDFLARE_ACCOUNT_ID` | deploy-backend.yml |

`GITHUB_TOKEN` به‌صورت خودکار تزریق می‌شود و در همه‌ی workflowها با `permissions: contents: read` (least privilege) استفاده شده است.

## ۴) کلاینت اندروید

در APK فقط مقادیر **عمومی** وجود دارد (`NabzConfig.java`): آدرس API، آدرس WS، لیست STUN.
هیچ کلید AI، کلید FCM، credential TURN یا secret دیگری در APK/embedded resources نیست.

## ۵) چرخش (Rotation)

- Cloudflare: Dashboard → API Tokens → Roll، سپس به‌روزرسانی GitHub Secret
- GitHub: Settings → Developer settings → Personal access tokens → Regenerate (توکن‌های افشاشده در چت را حتماً revoke کنید)
- `INVITE_CODE`: با `wrangler secret put INVITE_CODE` مجدداً ست کنید
