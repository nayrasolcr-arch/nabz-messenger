package app.nabz.net;

import app.nabz.NabzConfig;
import org.json.JSONObject;

import app.nabz.model.NabzModels;

/**
 * Message operations: send (text/voice/media/file), edit, delete, reply,
 * reactions, read receipts, pins, typing, search, history paging.
 */
public final class MessageRepository {

    private static volatile MessageRepository sInstance;
    public static MessageRepository get() {
        if (sInstance == null) {
            synchronized (MessageRepository.class) {
                if (sInstance == null) sInstance = new MessageRepository();
            }
        }
        return sInstance;
    }

    private final NabzApiClient api = NabzApiClient.get();
    private MessageRepository() {}

    private String conv(String id, String suffix) {
        return NabzConfig.apiV1() + "/conversations/" + id + (suffix == null ? "" : suffix);
    }

    public void sendText(String conversationId, String body, String replyToId, NabzApiClient.JsonCallback cb) {
        api.post(conv(conversationId, "/messages"), NabzModels.textMessageBody(body, replyToId), cb);
    }

    public void sendVoice(String conversationId, String attachmentId, String replyToId, NabzApiClient.JsonCallback cb) {
        try {
            JSONObject body = new JSONObject()
                    .put("type", "voice")
                    .put("attachment_id", attachmentId);
            if (replyToId != null) body.put("reply_to_message_id", replyToId);
            api.post(conv(conversationId, "/messages"), body, cb);
        } catch (Exception e) {
            cb.onError(new NabzApiClient.ApiException(0, "LOCAL", e.getMessage()));
        }
    }

    public void history(String conversationId, String beforeCursor, int limit, NabzApiClient.JsonCallback cb) {
        String url = conv(conversationId, "/messages?limit=" + Math.min(Math.max(limit, 1), 100));
        if (beforeCursor != null) url += "&before=" + beforeCursor;
        api.get(url, cb);
    }

    public void edit(String messageId, String newBody, NabzApiClient.JsonCallback cb) {
        try {
            api.patch(NabzConfig.apiV1() + "/messages/" + messageId, new JSONObject().put("body", newBody), cb);
        } catch (Exception e) {
            cb.onError(new NabzApiClient.ApiException(0, "LOCAL", e.getMessage()));
        }
    }

    public void delete(String messageId, NabzApiClient.JsonCallback cb) {
        api.delete(NabzConfig.apiV1() + "/messages/" + messageId, cb);
    }

    public void react(String messageId, String emoji, NabzApiClient.JsonCallback cb) {
        try {
            api.put(NabzConfig.apiV1() + "/messages/" + messageId + "/reactions",
                    new JSONObject().put("emoji", emoji), cb);
        } catch (Exception e) {
            cb.onError(new NabzApiClient.ApiException(0, "LOCAL", e.getMessage()));
        }
    }

    public void markRead(String conversationId, String messageId, NabzApiClient.JsonCallback cb) {
        try {
            api.post(conv(conversationId, "/read"), new JSONObject().put("message_id", messageId), cb);
        } catch (Exception e) {
            cb.onError(new NabzApiClient.ApiException(0, "LOCAL", e.getMessage()));
        }
    }

    public void pin(String messageId, NabzApiClient.JsonCallback cb) {
        api.post(NabzConfig.apiV1() + "/messages/" + messageId + "/pin", new JSONObject(), cb);
    }

    public void unpin(String messageId, NabzApiClient.JsonCallback cb) {
        api.delete(NabzConfig.apiV1() + "/messages/" + messageId + "/pin", cb);
    }

    public void typing(String conversationId, boolean typing, NabzApiClient.JsonCallback cb) {
        try {
            api.post(conv(conversationId, "/typing"),
                    new JSONObject().put("state", typing ? "typing" : "stop"), cb);
        } catch (Exception e) {
            cb.onError(new NabzApiClient.ApiException(0, "LOCAL", e.getMessage()));
        }
    }

    public void search(String query, NabzApiClient.JsonCallback cb) {
        String url = NabzConfig.apiV1() + "/search?q=" + android.net.Uri.encode(query);
        api.get(url, cb);
    }
}
