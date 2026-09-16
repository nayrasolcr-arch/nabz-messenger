package app.nabz.net;

import org.json.JSONArray;
import app.nabz.NabzConfig;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

import app.nabz.model.NabzModels;

/** Conversation management: private chats, groups, listing, membership. */
public final class ChatRepository {

    private static volatile ChatRepository sInstance;
    public static ChatRepository get() {
        if (sInstance == null) {
            synchronized (ChatRepository.class) {
                if (sInstance == null) sInstance = new ChatRepository();
            }
        }
        return sInstance;
    }

    private final NabzApiClient api = NabzApiClient.get();
    private ChatRepository() {}

    public interface ConvCallback {
        void onSuccess(String conversationId);
        void onError(NabzApiClient.ApiException error);
    }

    public void createPrivate(String otherUserId, ConvCallback cb) {
        try {
            JSONObject body = new JSONObject()
                    .put("type", "private")
                    .put("member_ids", new JSONArray().put(otherUserId));
            api.post(NabzConfig.apiV1() + "/conversations", body, new NabzApiClient.JsonCallback() {
                @Override public void onSuccess(JSONObject data) { cb.onSuccess(data.optString("conversation_id")); }
                @Override public void onError(NabzApiClient.ApiException error) { cb.onError(error); }
            });
        } catch (Exception e) {
            cb.onError(new NabzApiClient.ApiException(0, "LOCAL", e.getMessage()));
        }
    }

    public void createGroup(String title, List<String> memberIds, ConvCallback cb) {
        try {
            JSONArray ids = new JSONArray();
            for (String id : memberIds) ids.put(id);
            JSONObject body = new JSONObject()
                    .put("type", "group")
                    .put("title", title)
                    .put("member_ids", ids);
            api.post(NabzConfig.apiV1() + "/conversations", body, new NabzApiClient.JsonCallback() {
                @Override public void onSuccess(JSONObject data) { cb.onSuccess(data.optString("conversation_id")); }
                @Override public void onError(NabzApiClient.ApiException error) { cb.onError(error); }
            });
        } catch (Exception e) {
            cb.onError(new NabzApiClient.ApiException(0, "LOCAL", e.getMessage()));
        }
    }

    public void listConversations(NabzApiClient.JsonCallback cb) {
        api.get(NabzConfig.apiV1() + "/conversations", cb);
    }

    public void conversationDetails(String conversationId, NabzApiClient.JsonCallback cb) {
        api.get(NabzConfig.apiV1() + "/conversations/" + conversationId, cb);
    }

    public void deleteConversation(String conversationId, NabzApiClient.JsonCallback cb) {
        api.delete(NabzConfig.apiV1() + "/conversations/" + conversationId, cb);
    }

    public void addMember(String conversationId, String userId, NabzApiClient.JsonCallback cb) {
        try {
            api.post(NabzConfig.apiV1() + "/conversations/" + conversationId + "/members",
                    new JSONObject().put("user_id", userId), cb);
        } catch (Exception e) {
            cb.onError(new NabzApiClient.ApiException(0, "LOCAL", e.getMessage()));
        }
    }
}
