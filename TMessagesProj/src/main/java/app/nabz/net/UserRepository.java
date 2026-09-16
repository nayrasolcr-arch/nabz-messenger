package app.nabz.net;

import org.json.JSONArray;
import app.nabz.NabzConfig;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

import app.nabz.model.NabzModels;

/** User directory + profile management. */
public final class UserRepository {

    private static volatile UserRepository sInstance;
    public static UserRepository get() {
        if (sInstance == null) {
            synchronized (UserRepository.class) {
                if (sInstance == null) sInstance = new UserRepository();
            }
        }
        return sInstance;
    }

    private final NabzApiClient api = NabzApiClient.get();
    private UserRepository() {}

    public interface ListCallback {
        void onSuccess(List<NabzModels.User> items);
        void onError(NabzApiClient.ApiException error);
    }

    public void directory(ListCallback cb) {
        api.get(NabzConfig.apiV1() + "/users", new NabzApiClient.JsonCallback() {
            @Override public void onSuccess(JSONObject data) {
                List<NabzModels.User> out = new ArrayList<>();
                JSONArray items = data.optJSONArray("items");
                if (items != null) {
                    for (int i = 0; i < items.length(); i++) {
                        out.add(NabzModels.User.fromJson(items.optJSONObject(i)));
                    }
                }
                cb.onSuccess(out);
            }
            @Override public void onError(NabzApiClient.ApiException error) { cb.onError(error); }
        });
    }

    public void updateProfile(String displayName, String bio, NabzApiClient.JsonCallback cb) {
        try {
            JSONObject body = new JSONObject();
            if (displayName != null) body.put("display_name", displayName);
            if (bio != null) body.put("bio", bio);
            api.patch(NabzConfig.apiV1() + "/users/me", body, cb);
        } catch (Exception e) {
            cb.onError(new NabzApiClient.ApiException(0, "LOCAL", e.getMessage()));
        }
    }
}
