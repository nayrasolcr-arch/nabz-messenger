package app.nabz.model;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Lightweight model parsers for the Nabz API. Deliberately dependency-free:
 * org.json ships with Android. Field names mirror the JSON returned by the
 * Nabz backend (see backend/src/routes/*).
 */
public final class NabzModels {

    private NabzModels() {}

    public static class User {
        public String id, username, displayName, bio;
        public String avatarAttachmentId;
        public long lastSeenAt;

        public static User fromJson(JSONObject o) {
            User u = new User();
            u.id = o.optString("id");
            u.username = o.optString("username");
            u.displayName = o.optString("display_name");
            u.bio = o.optString("bio", null);
            u.avatarAttachmentId = o.optString("avatar_attachment_id", null);
            u.lastSeenAt = o.optLong("last_seen_at", 0);
            return u;
        }
    }

    public static class Attachment {
        public String id, kind, mimeType;
        public long sizeBytes, durationMs;
        public int[] waveform;

        public static Attachment fromJson(JSONObject o) {
            Attachment a = new Attachment();
            a.id = o.optString("id");
            a.kind = o.optString("kind");
            a.mimeType = o.optString("mime_type");
            a.sizeBytes = o.optLong("size_bytes");
            a.durationMs = o.optLong("duration_ms", 0);
            JSONArray w = o.optJSONArray("waveform");
            if (w != null) {
                a.waveform = new int[w.length()];
                for (int i = 0; i < w.length(); i++) a.waveform[i] = w.optInt(i);
            }
            return a;
        }
    }

    public static class Message {
        public String id, conversationId, type, body;
        public String replyToId;
        public String senderId, senderName;
        public Attachment attachment;
        public long createdAt, editedAt;
        public boolean deleted;

        public static Message fromJson(JSONObject o) {
            Message m = new Message();
            m.id = o.optString("id");
            m.conversationId = o.optString("conversation_id");
            m.type = o.optString("type", "text");
            m.body = o.optString("body", null);
            m.deleted = o.optLong("deleted_at", 0) > 0;
            m.createdAt = o.optLong("created_at");
            m.editedAt = o.optLong("edited_at", 0);
            JSONObject sender = o.optJSONObject("sender");
            if (sender != null) {
                m.senderId = sender.optString("id");
                m.senderName = sender.optString("display_name");
            }
            JSONObject att = o.optJSONObject("attachment");
            if (att != null) m.attachment = Attachment.fromJson(att);
            JSONObject reply = o.optJSONObject("reply_to");
            if (reply != null) m.replyToId = reply.optString("id");
            return m;
        }
    }

    public static class Conversation {
        public String id, type, title;
        public int unreadCount;
        public long lastMessageAt;
        public String myRole;

        public static Conversation fromJson(JSONObject o) {
            Conversation c = new Conversation();
            c.id = o.optString("id");
            c.type = o.optString("type");
            c.title = o.optString("title", null);
            c.unreadCount = o.optInt("unread_count");
            c.myRole = o.optString("my_role", "member");
            c.lastMessageAt = o.optLong("last_message_at", 0);
            return c;
        }
    }

    public static class Call {
        public String id, conversationId, status, kind;
        public long createdAt, answeredAt, endedAt;

        public static Call fromJson(JSONObject o) {
            Call c = new Call();
            c.id = o.optString("id");
            c.conversationId = o.optString("conversation_id");
            c.status = o.optString("status");
            c.kind = o.optString("kind", "audio");
            c.createdAt = o.optLong("created_at");
            c.answeredAt = o.optLong("answered_at", 0);
            c.endedAt = o.optLong("ended_at", 0);
            return c;
        }
    }

    /** Builds JSON bodies for text message sending. */
    public static JSONObject textMessageBody(String body, String replyTo) {
        try {
            JSONObject o = new JSONObject();
            o.put("type", "text");
            o.put("body", body);
            if (replyTo != null) o.put("reply_to_message_id", replyTo);
            return o;
        } catch (Exception e) {
            return new JSONObject();
        }
    }
}
