package app.nabz;

/**
 * Nabz feature switches for the Telegram-derived codebase.
 *
 * Phase-5 strategy: rather than physically deleting large, tightly-coupled
 * subsystems (channels/stories/payments/bots/stars) in one risky step, entry
 * points are gated through these flags and each subsystem is then removed
 * incrementally with compile verification (see docs/REMOVAL-PLAN.md for the
 * per-feature dependency map and ordered playbook).
 *
 * Everything messaging-critical (voice messages, calls, chat UI, media,
 * notifications, caching) must stay ON.
 */
public final class NabzFeatureFlags {

    private NabzFeatureFlags() {}

    // ---- disabled Telegram-ecosystem features ------------------------------
    public static final boolean CHANNELS = false;
    public static final boolean CHANNEL_DISCOVERY_AND_RECOMMENDATIONS = false;
    public static final boolean STORIES = false;
    public static final boolean TELEGRAM_STARS = false;
    public static final boolean PAYMENTS = false;
    public static final boolean SPONSORED_MESSAGES_ADS = false;
    public static final boolean BOTS = false;
    public static final boolean TELEGRAM_MINI_APPS = false;
    public static final boolean TELEGRAM_PREMIUM_UPSELL = false;
    public static final boolean TELEGRAM_ACCOUNT_SYNC = false;

    // ---- core product features (must remain enabled) -----------------------
    public static final boolean PRIVATE_CHAT = true;
    public static final boolean GROUP_CHAT = true;
    public static final boolean VOICE_MESSAGES = true;
    public static final boolean VOICE_CALLS = true;
    public static final boolean GROUP_VOICE_CHAT = true;   // architecture note: docs/ARCHITECTURE.md
    public static final boolean MEDIA_SUPPORT = true;
    public static final boolean AI_ASSISTANT = true;
    public static final boolean PUSH_NOTIFICATIONS = true;
    public static final boolean LOCAL_CACHE = true;
}
