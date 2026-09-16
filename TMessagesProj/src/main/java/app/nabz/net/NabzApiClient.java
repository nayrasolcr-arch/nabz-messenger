package app.nabz.net;

import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;

import org.json.JSONObject;

import java.io.IOException;
import java.util.concurrent.TimeUnit;

import app.nabz.NabzConfig;
import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

/**
 * Central HTTP client for the Nabz backend.
 *
 * - Attaches the Bearer access token to every request.
 * - Single-flight token refresh handled by AuthRepository (see its refresh()).
 * - All responses are parsed to org.json objects; error envelopes are surfaced
 *   as ApiException with the backend's error code.
 *
 * UI code must never use this class directly; use the repository classes.
 */
public final class NabzApiClient {

    public static class ApiException extends Exception {
        public final int status;
        public final String code;

        public ApiException(int status, String code, String message) {
            super(message);
            this.status = status;
            this.code = code;
        }
    }

    public interface JsonCallback {
        void onSuccess(JSONObject data);
        void onError(ApiException error);
    }

    private static volatile NabzApiClient sInstance;
    private final OkHttpClient client;
    private final Handler main = new Handler(Looper.getMainLooper());

    private NabzApiClient() {
        client = new OkHttpClient.Builder()
                .connectTimeout(15, TimeUnit.SECONDS)
                .readTimeout(60, TimeUnit.SECONDS)
                .writeTimeout(120, TimeUnit.SECONDS) // voice uploads
                .retryOnConnectionFailure(true)
                .build();
    }

    public static NabzApiClient get() {
        if (sInstance == null) {
            synchronized (NabzApiClient.class) {
                if (sInstance == null) sInstance = new NabzApiClient();
            }
        }
        return sInstance;
    }

    /** Session store injects the current access token. */
    public interface TokenProvider {
        String getAccessToken();
        /** Returns true if a refresh was performed and the request should be retried. */
        boolean refreshIfNeeded(int responseStatus);
    }

    private volatile TokenProvider tokenProvider;

    public void setTokenProvider(TokenProvider provider) {
        this.tokenProvider = provider;
    }

    private Request.Builder base(String url) {
        Request.Builder b = new Request.Builder().url(url);
        String token = tokenProvider != null ? tokenProvider.getAccessToken() : null;
        if (!TextUtils.isEmpty(token)) b.header("Authorization", "Bearer " + token);
        return b;
    }

    public void get(String url, JsonCallback cb) {
        enqueue(client.newCall(base(url).get()), cb, url, "GET", null);
    }

    public void delete(String url, JsonCallback cb) {
        enqueue(client.newCall(base(url).delete()), cb, url, "DELETE", null);
    }

    public void post(String url, JSONObject body, JsonCallback cb) {
        RequestBody rb = RequestBody.create(body.toString(), MediaType.parse("application/json; charset=utf-8"));
        enqueue(client.newCall(base(url).post(rb)), cb, url, "POST", body);
    }

    public void put(String url, JSONObject body, JsonCallback cb) {
        RequestBody rb = RequestBody.create(body.toString(), MediaType.parse("application/json; charset=utf-8"));
        enqueue(client.newCall(base(url).put(rb)), cb, url, "PUT", body);
    }

    public void patch(String url, JSONObject body, JsonCallback cb) {
        RequestBody rb = RequestBody.create(body.toString(), MediaType.parse("application/json; charset=utf-8"));
        enqueue(client.newCall(base(url).patch(rb)), cb, url, "PATCH", body);
    }

    public OkHttpClient raw() {
        return client;
    }

    private void enqueue(Call call, JsonCallback cb, String url, String method, JSONObject retryBody) {
        call.enqueue(new Callback() {
            @Override public void onFailure(Call c, IOException e) {
                // offline: surface as NETWORK code so repositories can queue/retry
                main.post(() -> cb.onError(new ApiException(0, "NETWORK", String.valueOf(e.getMessage()))));
            }

            @Override public void onResponse(Call c, Response resp) throws IOException {
                int status = resp.code();
                String bodyStr = resp.body() != null ? resp.body().string() : "{}";
                resp.close();

                if (status == 401 && tokenProvider != null && tokenProvider.refreshIfNeeded(status)) {
                    // token rotated; retry once with the fresh token
                    Request.Builder rb2 = base(url).method(method,
                            retryBody != null
                                    ? RequestBody.create(retryBody.toString(), MediaType.parse("application/json; charset=utf-8"))
                                    : null);
                    enqueue(client.newCall(rb2.build()), cb, url, method, retryBody);
                    return;
                }

                JSONObject json;
                try { json = new JSONObject(bodyStr.isEmpty() ? "{}" : bodyStr); }
                catch (Exception parse) { json = new JSONObject(); }

                if (status >= 200 && status < 300) {
                    final JSONObject okJson = json;
                    main.post(() -> cb.onSuccess(okJson));
                } else {
                    JSONObject err = json.optJSONObject("error");
                    String code = err != null ? err.optString("code", "ERROR") : "HTTP_" + status;
                    String msg = err != null ? err.optString("message", "Request failed") : "HTTP " + status;
                    main.post(() -> cb.onError(new ApiException(status, code, msg)));
                }
            }
        });
    }
}
