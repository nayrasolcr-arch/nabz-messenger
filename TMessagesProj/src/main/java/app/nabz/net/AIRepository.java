package app.nabz.net;

import app.nabz.NabzConfig;
import org.json.JSONObject;

/**
 * AI assistant repository. The user's AI key (if any) NEVER reaches the client:
 * the backend proxies to Workers AI / the configured provider server-side.
 */
public final class AIRepository {

    private static volatile AIRepository sInstance;
    public static AIRepository get() {
        if (sInstance == null) {
            synchronized (AIRepository.class) {
                if (sInstance == null) sInstance = new AIRepository();
            }
        }
        return sInstance;
    }

    private final NabzApiClient api = NabzApiClient.get();
    private AIRepository() {}

    public void chat(String content, NabzApiClient.JsonCallback cb) {
        try {
            api.post(NabzConfig.apiV1() + "/ai/chat", new JSONObject().put("content", content), cb);
        } catch (Exception e) {
            cb.onError(new NabzApiClient.ApiException(0, "LOCAL", e.getMessage()));
        }
    }

    public void history(NabzApiClient.JsonCallback cb) {
        api.get(NabzConfig.apiV1() + "/ai/history", cb);
    }

    public void clear(NabzApiClient.JsonCallback cb) {
        api.delete(NabzConfig.apiV1() + "/ai/history", cb);
    }
}
