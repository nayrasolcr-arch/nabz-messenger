package app.nabz.net;

import org.json.JSONObject;

import java.io.IOException;

import app.nabz.NabzConfig;
import okhttp3.MediaType;
import okhttp3.MultipartBody;
import okhttp3.RequestBody;
import okhttp3.Request;
import okhttp3.Response;

/**
 * Media repository: upload/download attachments (voice messages, images, files)
 * through the backend storage abstraction (KV today, R2 tomorrow - identical API).
 *
 * Voice messages are recorded by the caller (existing Telegram recorder can be
 * reused; output OGG/Opus preferred, AAC/M4A accepted) and pushed here with
 * duration + waveform metadata.
 */
public final class MediaRepository {

    private static volatile MediaRepository sInstance;
    public static MediaRepository get() {
        if (sInstance == null) {
            synchronized (MediaRepository.class) {
                if (sInstance == null) sInstance = new MediaRepository();
            }
        }
        return sInstance;
    }

    private final NabzApiClient api = NabzApiClient.get();
    private MediaRepository() {}

    public interface UploadCallback {
        void onSuccess(String attachmentId);
        void onError(NabzApiClient.ApiException error);
    }

    /** Synchronous upload - call from a background thread. */
    public String uploadBlocking(String conversationId, String kind, String mimeType,
                                 byte[] bytes, long durationMs, int[] waveform) throws NabzApiClient.ApiException, IOException {
        if (bytes != null && bytes.length > NabzConfig.MAX_ATTACHMENT_BYTES) {
            throw new NabzApiClient.ApiException(0, "FILE_TOO_LARGE", "Attachment exceeds " + NabzConfig.MAX_ATTACHMENT_BYTES);
        }
        String token = AuthRepository.get().getAccessToken();
        if (token == null) throw new NabzApiClient.ApiException(0, "NO_SESSION", "Not logged in");

        MultipartBody.Builder mb = new MultipartBody.Builder().setType(MultipartBody.FORM)
                .addFormDataPart("kind", kind)
                .addFormDataPart("file", "attachment." + extFor(mimeType),
                        RequestBody.create(bytes, MediaType.parse(mimeType)));
        if (conversationId != null) mb.addFormDataPart("conversation_id", conversationId);
        if (durationMs > 0) mb.addFormDataPart("duration_ms", String.valueOf(durationMs));
        if (waveform != null) {
            StringBuilder sb = new StringBuilder("[");
            for (int i = 0; i < waveform.length; i++) {
                if (i > 0) sb.append(',');
                sb.append(waveform[i]);
            }
            sb.append(']');
            mb.addFormDataPart("waveform", sb.toString());
        }

        Request req = new Request.Builder()
                .url(NabzConfig.apiV1() + "/attachments")
                .header("Authorization", "Bearer " + token)
                .post(mb.build())
                .build();

        Response resp = api.raw().newCall(req).execute();
        try {
            String bodyStr = resp.body() != null ? resp.body().string() : "{}";
            JSONObject json = new JSONObject(bodyStr.isEmpty() ? "{}" : bodyStr);
            if (resp.code() == 201) {
                return json.optJSONObject("attachment") != null
                        ? json.optJSONObject("attachment").optString("id") : "";
            }
            JSONObject err = json.optJSONObject("error");
            throw new NabzApiClient.ApiException(resp.code(),
                    err != null ? err.optString("code") : "HTTP_" + resp.code(),
                    err != null ? err.optString("message") : "upload failed");
        } catch (org.json.JSONException e) {
            throw new NabzApiClient.ApiException(resp.code(), "BAD_RESPONSE", "malformed upload response");
        } finally {
            resp.close();
        }
    }

    /** Synchronous download of attachment bytes - call from a background thread. */
    public byte[] downloadBlocking(String attachmentId) throws NabzApiClient.ApiException, IOException {
        String token = AuthRepository.get().getAccessToken();
        if (token == null) throw new NabzApiClient.ApiException(0, "NO_SESSION", "Not logged in");
        Request req = new Request.Builder()
                .url(NabzConfig.apiV1() + "/attachments/" + attachmentId)
                .header("Authorization", "Bearer " + token)
                .get()
                .build();
        Response resp = api.raw().newCall(req).execute();
        if (resp.code() != 200) {
            int code = resp.code();
            resp.close();
            throw new NabzApiClient.ApiException(code, "DOWNLOAD_FAILED", "HTTP " + code);
        }
        byte[] bytes = resp.body() != null ? resp.body().bytes() : new byte[0];
        resp.close();
        return bytes;
    }

    private static String extFor(String mime) {
        if (mime == null) return "bin";
        switch (mime) {
            case "audio/ogg": return "ogg";
            case "audio/aac":
            case "audio/mp4": return "m4a";
            case "image/jpeg": return "jpg";
            case "image/png": return "png";
            case "image/webp": return "webp";
            case "video/mp4": return "mp4";
            case "application/pdf": return "pdf";
            default: return "bin";
        }
    }
}
