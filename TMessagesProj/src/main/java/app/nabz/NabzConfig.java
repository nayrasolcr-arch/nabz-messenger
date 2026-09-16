package app.nabz;

/**
 * Nabz client configuration.
 *
 * Base URLs point at the Nabz backend (Cloudflare Workers). These are public
 * configuration values, NOT secrets: all credentials (sessions, AI keys, TURN
 * credentials) stay server-side or are issued per-user at login.
 */
public final class NabzConfig {

    private NabzConfig() {}

    /** HTTPS base URL of the Nabz backend (versioned API). */
    public static final String API_BASE_URL = "https://nabz-backend.nayrasolcr-nabz.workers.dev";

    /** WebSocket endpoint of the same worker (realtime hub). */
    public static final String WS_URL = API_BASE_URL.replace("https://", "wss://") + "/ws";

    /** Versioned API prefix. */
    public static final String API_V1 = API_BASE_URL + "/api/v1";

    public static String apiV1() {
        return API_V1;
    }

    /** STUN servers are public; TURN (if any) is fetched at runtime from /calls/ice-servers. */
    public static final String[] FALLBACK_STUN = {
            "stun:stun.l.google.com:19302",
            "stun:stun1.l.google.com:19302"
    };

    /** Max bytes for a voice message upload (matches backend MAX_ATTACHMENT_BYTES). */
    public static final int MAX_ATTACHMENT_BYTES = 24_000_000;
}
