# معماری (Architecture)

## ۱) نمای کلی

```
┌────────────────────────────┐
│      Android Client        │
│  (Telegram Android fork)   │
│  app.nabz.messenger        │
│                            │
│  app.nabz.net.*            │
│   ├─ AuthRepository        │
│   ├─ ChatRepository        │
│   ├─ MessageRepository     │
│   ├─ MediaRepository       │
│   ├─ CallRepository        │
│   ├─ AIRepository          │
│   └─ RealtimeClient (WS)   │
│  app.nabz.call.*           │
│   └─ NabzCallClient (RTC)  │
└───────────┬────────────────┘
            │ HTTPS / WSS / WebRTC(Opus, P2P)
            ▼
┌─────────────────────────────────────────────────────────┐
│                 Cloudflare (Free Tier)                  │
│                                                         │
│  Worker: nabz-backend (Hono + TypeScript)               │
│   ├─ /api/v1/auth|users|conversations|messages|...      │
│   ├─ /api/v1/attachments  → StorageProvider             │
│   ├─ /api/v1/calls/ice-servers (STUN/TURN config)       │
│   ├─ /api/v1/ai  → Workers AI  (یا AI_API_KEY خارجی)    │
│   └─ /ws → RealtimeHub (DO)                             │
│                                                         │
│  D1 (nabz-db): 13 جدول + 2 migration                    │
│  KV (ATTACHMENTS): bytes پیوست‌ها (≤24MB)                │
│  Durable Objects: RealtimeHub, RateLimiter              │
└─────────────────────────────────────────────────────────┘
```

**اصل کلیدی:** UI هرگز مستقیم به HTTP/WS وابسته نیست؛ همه‌چیز از طریق Repositoryها (فاز ۱۲) عبور می‌کند و MTProto/`tgnet` فقط تا زمان مهاجرت کامل UI از network path قدیمی استفاده می‌شود.

## ۲) REST API (نسخه‌بندی‌شده `/api/v1`)

| Endpoint | متد | کار |
|----------|-----|-----|
| `/auth/register` | POST | ثبت‌نام (کد دعوت اختیاری) |
| `/auth/login` | POST | ورود + ساخت device + session |
| `/auth/refresh` | POST | چرخش توکن + تشخیص reuse |
| `/auth/logout`, `/auth/logout-all` | POST | خروج |
| `/users/me`, `/users` | GET/PATCH | پروفایل و دایرکتوری کاربران |
| `/conversations` | GET/POST | لیست/ساخت (private با dedupe) |
| `/conversations/:id/messages` | GET/POST | تاریخچه (cursor) / ارسال |
| `/messages/:id` | PATCH/DELETE | ویرایش / حذف نرم |
| `/messages/:id/reactions` | PUT | toggle reaction |
| `/conversations/:id/read` | POST | read receipt |
| `/messages/:id/pin` | POST/DELETE | سنجاق |
| `/conversations/:id/typing` | POST | typing (fallback REST) |
| `/attachments` | POST | آپلود multipart (voice/media/file) |
| `/attachments/:id` | GET/DELETE | دانلود auth-gated / حذف |
| `/calls` | POST | شروع تماس (ringing) |
| `/calls/:id/accept|reject|end` | POST | lifecycle تماس |
| `/calls/ice-servers` | GET | STUN/TURN (TURN فقط از سرور) |
| `/search` | GET | جست‌وجو در مکالمات خود کاربر |
| `/ai/chat|history` | POST/GET | دستیار AI |
| `/push/register` | POST | ثبت توکن FCM |
| `/health` | GET | سلامت سرویس (public) |

## ۳) Realtime — Durable Object + WebSocket

یک Durable Object واحد (`RealtimeHub`) با **WebSocket Hibernation API**:

- هر کلاینت یک WS می‌سازد؛ اولین پیام باید `{t:"auth", token}` باشد (در غیر این صورت close(4001)؛ alarm ۱۰ ثانیه‌ای سوکت‌های authنشده را می‌بندد).
- بعد از auth، لیست مکالمات کاربر از D1 خوانده و در `serializeAttachment` سوکت ذخیره می‌شود (subscribe).
- Mutationهای REST با `ctx.waitUntil` رویدادها را به `RealtimeHub/publish` می‌فرستند و hub به سوکت‌های عضو همان مکالمه fan-out می‌کند.
- Presence در سطح deployment broadcast می‌شود (برای ۲۰ کاربر بهینه).
- Keepalive: `setWebSocketAutoResponse("ping"→"pong")` بدون بیدار کردن DO (هزینه‌ی duration تقریباً صفر).
- Reconnect در کلاینت: exponential backoff + jitter؛ بعد از `ready` مجدد، کلاینت از REST resync می‌کند.

رویدادها: `message.new/edited/deleted`, `reaction`, `read`, `typing`, `presence`, `conversation.new`, `member.added`, `call.ringing/accepted/rejected/ended`, `signal`.

## ۴) تماس صوتی (Voice Call)

```
Client A ──(offer/answer/ICE via WS signal)──▶ Client B
   └───────────── RTP/SRTP (Opus, P2P) ─────────────┘
```

- Signaling: passthrough در RealtimeHub (`{t:"signal", call_id, to, data}`) + احراز هویت عضویت.
- Lifecycle در D1: `ringing → active → ended | missed | rejected` + پیام سیستمی `call` در تاریخچه.
- Missed: تماس ringing قدیمی‌تر از ۶۰ ثانیه → sweep به missed + پیام سیستمی + push.
- ICE: STUN عمومی پیش‌فرض؛ **TURN** فقط در صورت ست شدن secretها سرو می‌شود (کلیدها هرگز وارد APK نمی‌شوند). بدون TURN، ~۱۰-۲۰٪ شبکه‌های NAT متقارن fail می‌شوند — این محدودیت صادقانه مستند است.

## ۵) Voice Chat گروهی — تحلیل صادقانه

- **روی Cloudflare فقط signaling ممکن است؛ نه media server.** Cloudflare Workers/SFU مخصوص media ارائه نمی‌دهد.
- WebRTC Mesh برای ۳-۴ نفر همزمان قابل قبول است (۲۰ کاربر کل، معمولاً ≤۴ نفر همزمان در یک گروه خانوادگی/دوستان) → انتخاب فعلی: Mesh با سقف همزمانی ۴ نفر.
- برای بیش از ۴-۵ نفر همزمان: نیاز به **SFU** (مثل LiveKit self-host روی یک VPS — رایگان نیست؛ مدار معماری برای آن آماده است چون signaling جدا از media طراحی شده). این آگاهانه به آینده موکول شد تا در Free Tier بمانیم.

## ۶) Storage پیوست‌ها (Abstraction)

`backend/src/lib/storage.ts` اینترفیس `StorageProvider` را تعریف می‌کند:

- **امروز:** `KvStorageProvider` (Workers KV - 25MB/value، 1GB رایگان) — برای voice message و عکسِ ۲۰ کاربر کافی است.
- **فردا:** `R2StorageProvider` آماده است؛ با اضافه کردن binding `ATTACHMENTS_R2` + `STORAGE_PROVIDER=r2` بدون تغییر کد کلاینت/سرور سوئیچ می‌شود.

## ۷) AI Assistant

`User → Worker (auth + rate limit + ذخیره تاریخچه در ai_messages) → Provider → Reply`

ترتیب Provider: `AI_MOCK=1` (تست) → Workers AI binding (رایگان، `@cf/meta/llama-3.1-8b-instruct`) → OpenAI-compatible (`AI_API_KEY` + `AI_BASE_URL`). کلید فقط server-side است و در APK هیچ رشته‌ای از آن وجود ندارد.

## ۸) دیتابیس (D1/SQLite)

۱۳ جدول الزامی کاربر + جدول کمکی `revoked_refresh_tokens`:

`users, sessions, devices, conversations, conversation_members, messages, message_reactions, message_reads, attachments, calls, call_participants, ai_conversations, ai_messages`

- تمام timestampها epoch-ms، کلیدها TEXT (uuid)
- FKها با CASCADE/SET NULL؛ دو استثنا (avatar و last_message_id) به‌خاطر چرخه‌ی درج، app-enforced هستند و در schema کامنت شده‌اند
- Indexهای پرتکرار: `(conversation_id, created_at DESC)` برای history، `token_hash/refresh_hash` برای احراز هویت، partial index برای pinها، `(conversation_id, status)` برای تماس‌های live
- مهاجرت‌ها: `backend/migrations/0001_init.sql`، `0002_revoked_tokens.sql` (version-controlled، همان فایل‌ها در CI و deploy اعمال می‌شوند)
