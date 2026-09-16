package app.nabz.net;

import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import org.json.JSONObject;

import app.nabz.NabzConfig;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

/**
 * Realtime WebSocket client for the Nabz backend.
 *
 * Protocol (server = Nabz RealtimeHub Durable Object):
 *   client -> {t:"auth", token}, {t:"typing", conversation_id, state},
 *             {t:"signal", call_id, to, data}, {t:"heartbeat"}, raw "ping"
 *   server -> {t:"ready", user_id, online[]}, {t:"presence", user_id, online},
 *             {t:"message.new"|"message.edited"|"message.deleted"|"reaction"|"read"|"typing"},
 *             {t:"call.ringing"|"call.accepted"|"call.rejected"|"call.ended"},
 *             {t:"signal", call_id, from, data}, {t:"pong"}
 *
 * Resilience: automatic reconnect with exponential backoff + jitter, resubscribe
 * on ready, and a listener surface designed for optimistic UI (dedupe by message id).
 */
public final class RealtimeClient {

    public interface Listener {
        void onReady(String userId, org.json.JSONArray onlineUserIds);
        void onEvent(String type, JSONObject event);
        void onConnectionStateChange(boolean connected);
    }

    private static volatile RealtimeClient sInstance;
    public static RealtimeClient get() {
        if (sInstance == null) {
            synchronized (RealtimeClient.class) {
                if (sInstance == null) sInstance = new RealtimeClient();
            }
        }
        return sInstance;
    }

    private static final String TAG = "NabzRealtime";
    private static final long MAX_BACKOFF_MS = 30_000;

    private final OkHttpClient client = new OkHttpClient.Builder()
            .pingInterval(30, java.util.concurrent.TimeUnit.SECONDS)
            .build();
    private final Handler main = new Handler(Looper.getMainLooper());

    private volatile WebSocket socket;
    private volatile Listener listener;
    private volatile boolean wantConnected;
    private int attempt;
    private String pendingToken;

    private RealtimeClient() {}

    public void setListener(Listener l) {
        listener = l;
    }

    public boolean isConnected() {
        return socket != null;
    }

    public void connect() {
        String token = AuthRepository.get().getAccessToken();
        if (token == null) return;
        pendingToken = token;
        wantConnected = true;
        openSocket(token);
    }

    private synchronized void openSocket(String token) {
        if (socket != null) return;
        Request req = new Request.Builder().url(NabzConfig.WS_URL).build();
        socket = client.newWebSocket(req, new WebSocketListener() {
            @Override public void onOpen(WebSocket webSocket, Response response) {
                attempt = 0;
                try {
                    webSocket.send(new JSONObject().put("t", "auth").put("token", token).toString());
                } catch (Exception e) {
                    Log.w(TAG, "auth send failed", e);
                }
                main.post(() -> {
                    if (listener != null) listener.onConnectionStateChange(true);
                });
            }

            @Override public void onMessage(WebSocket webSocket, String text) {
                try {
                    JSONObject msg = new JSONObject(text);
                    String t = msg.optString("t");
                    if ("ready".equals(t)) {
                        if (listener != null) {
                            main.post(() -> {
                                if (listener != null) listener.onReady(msg.optString("user_id"), msg.optJSONArray("online"));
                            });
                        }
                    } else {
                        if (listener != null) {
                            main.post(() -> {
                                if (listener != null) listener.onEvent(t, msg);
                            });
                        }
                    }
                } catch (Exception e) {
                    Log.w(TAG, "bad frame", e);
                }
            }

            @Override public void onFailure(WebSocket webSocket, Throwable t, Response response) {
                socket = null;
                main.post(() -> {
                    if (listener != null) listener.onConnectionStateChange(false);
                });
                scheduleReconnect();
            }

            @Override public void onClosed(WebSocket webSocket, int code, String reason) {
                socket = null;
                main.post(() -> {
                    if (listener != null) listener.onConnectionStateChange(false);
                });
                if (code != 1000 && wantConnected) scheduleReconnect();
            }
        });
    }

    private void scheduleReconnect() {
        if (!wantConnected) return;
        attempt += 1;
        long backoff = (long) Math.min(MAX_BACKOFF_MS, 1000L * Math.pow(2, Math.min(attempt, 6)));
        long jitter = (long) (Math.random() * Math.min(2000, backoff / 4));
        main.postDelayed(this::reconnectNow, backoff + jitter);
    }

    private void reconnectNow() {
        String token = AuthRepository.get().getAccessToken();
        if (token == null || !wantConnected) return;
        openSocket(token);
    }

    public void disconnect() {
        wantConnected = false;
        if (socket != null) {
            socket.close(1000, "bye");
            socket = null;
        }
    }

    /** Typing indicator via the realtime path (preferred over REST). */
    public void sendTyping(String conversationId, boolean typing) {
        WebSocket s = socket;
        if (s == null) return;
        try {
            s.send(encodeSafe(new JSONObject()
                    .put("t", "typing")
                    .put("conversation_id", conversationId)
                    .put("state", typing ? "typing" : "stop")));
        } catch (Exception ignored) {}
    }

    /** WebRTC signaling passthrough. */
    public void sendSignal(String callId, String toUserId, JSONObject data) {
        WebSocket s = socket;
        if (s == null) return;
        try {
            s.send(encodeSafe(new JSONObject()
                    .put("t", "signal")
                    .put("call_id", callId)
                    .put("to", toUserId)
                    .put("data", data)));
        } catch (Exception ignored) {}
    }

    private static String encodeSafe(JSONObject o) {
        return o.toString();
    }
}
