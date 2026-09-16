package app.nabz.net;

import org.json.JSONObject;

import app.nabz.model.NabzModels;

/**
 * Call repository: REST lifecycle (create/accept/reject/end) + ICE config.
 * The media path is WebRTC peer-to-peer; signaling travels over RealtimeClient.
 */
public final class CallRepository {

    private static volatile CallRepository sInstance;
    public static CallRepository get() {
        if (sInstance == null) {
            synchronized (CallRepository.class) {
                if (sInstance == null) sInstance = new CallRepository();
            }
        }
        return sInstance;
    }

    private final NabzApiClient api = NabzApiClient.get();
    private CallRepository() {}

    public void startCall(String conversationId, NabzApiClient.JsonCallback cb) {
        try {
            api.post(NabzConfig.apiV1() + "/calls",
                    new JSONObject().put("conversation_id", conversationId).put("kind", "audio"), cb);
        } catch (Exception e) {
            cb.onError(new NabzApiClient.ApiException(0, "LOCAL", e.getMessage()));
        }
    }

    public void accept(String callId, NabzApiClient.JsonCallback cb) {
        api.post(NabzConfig.apiV1() + "/calls/" + callId + "/accept", new JSONObject(), cb);
    }

    public void reject(String callId, NabzApiClient.JsonCallback cb) {
        api.post(NabzConfig.apiV1() + "/calls/" + callId + "/reject", new JSONObject(), cb);
    }

    public void end(String callId, String reason, NabzApiClient.JsonCallback cb) {
        try {
            api.post(NabzConfig.apiV1() + "/calls/" + callId + "/end",
                    new JSONObject().put("reason", reason), cb);
        } catch (Exception e) {
            cb.onError(new NabzApiClient.ApiException(0, "LOCAL", e.getMessage()));
        }
    }

    /** Fetches ICE server config (STUN now, TURN when configured server-side). */
    public void iceServers(NabzApiClient.JsonCallback cb) {
        api.get(NabzConfig.apiV1() + "/calls/ice-servers", cb);
    }
}
