package app.nabz.net;

import app.nabz.NabzConfig;
import org.json.JSONObject;

import app.nabz.model.NabzModels;

/**
 * Authentication repository: register / login / token rotation / logout.
 * Replaces Telegram-specific authentication (phone codes, MTProto auth keys).
 *
 * Tokens are kept in-memory here and persisted by the session store chosen by
 * the app shell (SharedPreferences is acceptable for v1; Keystore-wrapped
 * storage is the documented upgrade path).
 */
public final class AuthRepository {

    private static volatile AuthRepository sInstance;
    public static AuthRepository get() {
        if (sInstance == null) {
            synchronized (AuthRepository.class) {
                if (sInstance == null) sInstance = new AuthRepository();
            }
        }
        return sInstance;
    }

    private String accessToken, refreshToken;
    private NabzModels.User currentUser;
    private NabzApiClient.TokenProvider provider;

    private final NabzApiClient api = NabzApiClient.get();

    private AuthRepository() {}

    /** Wire the client to this repository for token injection + auto-refresh. */
    public void install() {
        provider = new NabzApiClient.TokenProvider() {
            @Override public String getAccessToken() {
                return accessToken;
            }

            @Override public boolean refreshIfNeeded(int responseStatus) {
                if (refreshToken == null) return false;
                return refreshBlocking();
            }
        };
        api.setTokenProvider(provider);
    }

    public boolean isLoggedIn() {
        return accessToken != null;
    }

    public NabzModels.User currentUser() {
        return currentUser;
    }

    public String getAccessToken() {
        return accessToken;
    }

    public interface SessionCallback {
        void onSession(NabzModels.User user, String access, String refresh);
        void onError(NabzApiClient.ApiException error);
    }

    public void register(String username, String password, String displayName, String inviteCode, SessionCallback cb) {
        try {
            JSONObject body = new JSONObject()
                    .put("username", username)
                    .put("password", password)
                    .put("display_name", displayName);
            if (inviteCode != null) body.put("invite_code", inviteCode);
            api.post(NabzConfig.apiV1() + "/auth/register", body, new NabzApiClient.JsonCallback() {
                @Override public void onSuccess(JSONObject data) { cb.onSession(null, null, null); }
                @Override public void onError(NabzApiClient.ApiException error) { cb.onError(error); }
            });
        } catch (Exception e) {
            cb.onError(new NabzApiClient.ApiException(0, "LOCAL", e.getMessage()));
        }
    }

    public void login(String username, String password, String deviceUid, String deviceName, SessionCallback cb) {
        try {
            JSONObject body = new JSONObject()
                    .put("username", username)
                    .put("password", password)
                    .put("device_uid", deviceUid)
                    .put("device_name", deviceName)
                    .put("device_platform", "android");
            api.post(NabzConfig.apiV1() + "/auth/login", body, new NabzApiClient.JsonCallback() {
                @Override public void onSuccess(JSONObject data) {
                    accessToken = data.optString("access_token");
                    refreshToken = data.optString("refresh_token");
                    currentUser = NabzModels.User.fromJson(data.optJSONObject("user"));
                    cb.onSession(currentUser, accessToken, refreshToken);
                }
                @Override public void onError(NabzApiClient.ApiException error) { cb.onError(error); }
            });
        } catch (Exception e) {
            cb.onError(new NabzApiClient.ApiException(0, "LOCAL", e.getMessage()));
        }
    }

    /** Restore a persisted session at app start. */
    public void restore(String access, String refresh, String userJson) {
        this.accessToken = access;
        this.refreshToken = refresh;
        try {
            this.currentUser = NabzModels.User.fromJson(new JSONObject(userJson));
        } catch (Exception ignored) {}
    }

    public void logout(Runnable done) {
        api.post(NabzConfig.apiV1() + "/auth/logout", new JSONObject(), new NabzApiClient.JsonCallback() {
            @Override public void onSuccess(JSONObject data) {
                clear();
                done.run();
            }
            @Override public void onError(NabzApiClient.ApiException error) {
                clear();
                done.run();
            }
        });
    }

    public void logoutAll(Runnable done) {
        api.post(NabzConfig.apiV1() + "/auth/logout-all", new JSONObject(), new NabzApiClient.JsonCallback() {
            @Override public void onSuccess(JSONObject data) { clear(); done.run(); }
            @Override public void onError(NabzApiClient.ApiException error) { clear(); done.run(); }
        });
    }

    /** Blocking refresh used on 401; returns true when a new access token is available. */
    private boolean refreshBlocking() {
        try {
            okhttp3.Request req = new okhttp3.Request.Builder()
                    .url(NabzConfig.apiV1() + "/auth/refresh")
                    .post(okhttp3.RequestBody.create(
                            new JSONObject().put("refresh_token", refreshToken).toString(),
                            okhttp3.MediaType.parse("application/json; charset=utf-8")))
                    .build();
            okhttp3.Response resp = api.raw().newCall(req).execute();
            if (resp.code() != 200) {
                resp.close();
                clear(); // refresh failed or reuse detected: session dead
                return false;
            }
            JSONObject data = new JSONObject(resp.body() != null ? resp.body().string() : "{}");
            resp.close();
            accessToken = data.optString("access_token");
            refreshToken = data.optString("refresh_token");
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private void clear() {
        accessToken = null;
        refreshToken = null;
        currentUser = null;
    }
}
