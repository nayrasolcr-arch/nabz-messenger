# امنیت (Security)

## ۱) احراز هویت

- **هش پسورد:** PBKDF2-HMAC-SHA256، ‏50k iteration پیش‌فرض (قابل تنظیم)، salt تصادفی ۱۶ بایتی per-user، خروجی ۲۵۶ بیتی، مقایسه‌ی timing-safe.
  - نکته‌ی صادقانه: Workers Free برای هر درخواست سقف CPU دارد؛ PBKDF2 native با 50k حدود چند میلی‌ثانیه است. مسیر ارتقا: Argon2id (WASM) روی پلن پولی یا iteration بالاتر.
- **جلوگیری از user enumeration:** ورود کاربر ناموجود هم یک عملیات هش dummy انجام می‌دهد تا زمان پاسخ یکسان باشد؛ پیام خطا یکسان است.
- **Session model:** access token (۲۴h) + refresh token (۳۰d)، هر دو opaque ۲۵۶-bit random؛ در DB فقط SHA-256 hash ذخیره می‌شود (leak دیتابیس = دزدی نشست مستقیم نیست).
- **Rotation:** هر refresh جفت توکن را عوض می‌کند و hash قبلی به `revoked_refresh_tokens` منتقل می‌شود.
- **Reuse detection:** استفاده‌ی مجدد از refresh token قبلی ⇒ ابطال همه‌ی sessionهای همان کاربر (پاسخ `REFRESH_REUSE`).
- **Logout / Logout-all:** revoke نرم (`revoked_at`)؛ توکن‌های ابطال‌شده بلافاصله 401 می‌دهند.

## ۲) Authorization (ضد IDOR)

- هر endpoint مکالمه اول `requireMembership` را صدا می‌زند؛ عضو نبودن ⇒ 403 (بدون افشای وجود منبع).
- پیوست‌ها فقط برای اعضای مکالمه‌ی مربوطه (یا owner) سرو می‌شوند — تست IDOR دارد.
- ویرایش پیام فقط توسط فرستنده؛ حذف: فرستنده یا admin/owner گروه؛ pin در گروه فقط owner/admin.
- نقش‌ها: `owner / admin / member`.

## ۳) Rate Limiting

Durable Object با sliding window:

| مسیر | سقف پیش‌فرض |
|------|-------------|
| register | ۵ / ساعت / IP |
| login | ۲۰ / ۱۰ دقیقه / IP و ۱۰ / ۱۰ دقیقه / username |
| refresh | ۶۰ / ۱۰ دقیقه / IP |
| ارسال پیام | ۶۰ / دقیقه / کاربر |
| search | ۳۰ / دقیقه / کاربر |
| AI | ۲۰ / دقیقه / کاربر |

خطا fail-open است (در دسترس‌بودن سرویس اولویت دارد) و در مستندات ذکر شده.

## ۴) ورودی‌ها (Input validation)

- همه‌ی bodyها با zod (سقف طول، الگوی username، فرمت ایموجی، سقف سایز فایل، allowlist MIME).
- JSON نامعتبر ⇒ 400؛ هیچ‌وقت 500 با جزئیات داخلی.
- خطاهای داخلی بدون stack trace به کلاینت برمی‌گردند (فقط `INTERNAL`).

## ۵) امنیت لایه‌ی حمل و سوکت

- همه‌چیز HTTPS/WSS روی دامنه‌ی Cloudflare (workers.dev).
- WS: پیام اول باید auth باشد (timeout alarm ۱۰s)؛ پیام‌های ناشناس close(4001).
- Signal routing تماس فقط بین کاربران عضو همان deployment و پس از auth.
- Headerها: `nosniff`, `DENY frame`, `no-referrer`, `no-store`.

## ۶) مدیریت Secrets

- سرور: فقط `wrangler secret` / environment binding؛ هرگز در کد یا wrangler.toml.
- CI: GitHub Secrets با `permissions: contents: read`؛ لاگ‌ها مقدار secret را چاپ نمی‌کنند (GitHub به‌طور خودکار mask می‌کند + ما هیچ echoی روی secretها نداریم).
- APK: هیچ secretی embed نشده (بخش ۴ ENVIRONMENT.md).

## ۷) ترازنامه‌ی شناخته‌شده (Honest limitations)

1. E2EE پیاده نشده — پیام‌ها روی سرور رمز شده در حالت transport (TLS) اما plaintext در D1. برای ۲۰ کاربر خصوصی قابل قبول است؛ E2EE واقعی به طراحی کلید برای گروه نیاز دارد (roadmap).
2. بدون TURN، برخی شبکه‌های سخت‌گیر تماس P2P برقرار نمی‌کنند.
3. Push تا زمان اتصال Firebase ارسال واقعی ندارد (realtime درون‌اپ کامل است).
4. Username enumeration از طریق register (پیام `USERNAME_TAKEN`) غیرقابل‌حذف است (طبیعی ثبت‌نام)؛ login ایمن شده است.
5. آیکون‌های تم جایگزین (icon_2..icon_5) هنوز Telegram-motif هستند و در فاز بعدی جایگزین می‌شوند.

## ۸) مجوز و Trademark

- Fork تحت GPLv2 و حفظ LICENSE؛ تغییرات این مخزن نیز GPLv2 منتشر می‌شود.
- نام و آیکون «Nabz» اختصاصی است؛ از نام/لوگوی Telegram در branding نهایی استفاده نشده تا سردرگمی با Telegram ایجاد نکند.
