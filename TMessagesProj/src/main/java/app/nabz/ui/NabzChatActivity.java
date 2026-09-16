package app.nabz.ui;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.media.MediaPlayer;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.inputmethod.InputMethodManager;
import android.widget.BaseAdapter;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ListView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.Date;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

import app.nabz.model.NabzModels;
import app.nabz.net.AuthRepository;
import app.nabz.net.MediaRepository;
import app.nabz.net.MessageRepository;
import app.nabz.net.NabzApiClient;
import app.nabz.net.RealtimeClient;

/**
 * Nabz chat screen: text messages, reply, edit, delete, reactions, read
 * receipts, typing indicators, presence and hold-to-record voice messages -
 * all through the Nabz backend (REST + realtime WebSocket).
 */
public class NabzChatActivity extends Activity {

    private static final int MAX_HISTORY = 50;
    private static final String[] REACTIONS = {
            "\uD83D\uDC4D", // thumbs up
            "\u2764",       // heart
            "\uD83D\uDE02", // face with tears of joy
            "\uD83D\uDE2E", // surprised
            "\uD83D\uDE22", // crying
    };

    private String conversationId, conversationTitle, myId;
    private final List<NabzModels.Message> messages = new ArrayList<>();
    private final Set<String> messageIds = new HashSet<>();
    private ChatAdapter adapter;
    private ListView listView;
    private EditText inputField;
    private TextView statusText;
    private LinearLayout replyBar;
    private TextView replyText;
    private String replyToId;

    private boolean sending;
    private boolean loading;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable typingOffRunnable = () -> RealtimeClient.get().sendTyping(conversationId, false);
    private long lastTypingSent;
    private final Runnable typingIndicatorOff = () -> {
        if (statusText != null) statusText.setText("");
    };
    private final Runnable reloadRunnable = this::reloadHistory;

    // voice recording
    private MediaRecorder recorder;
    private File recordFile;
    private long recordStartMs;
    private final List<Integer> amplitudeSamples = new ArrayList<>();
    private final Runnable amplitudeRunnable = new Runnable() {
        @Override public void run() {
            if (recorder != null) {
                try {
                    int max = 0;
                    try { max = recorder.getMaxAmplitude(); } catch (Exception ignored) {}
                    amplitudeSamples.add(max);
                } catch (Exception ignored) {}
                handler.postDelayed(this, 120);
            }
        }
    };
    private TextView micButton;
    private TextView recordStatus;
    private boolean recording;

    // playback
    private MediaPlayer player;
    private String playingAttachmentId;
    private final MediaPlayer.OnCompletionListener completionListener = mp -> {
        playingAttachmentId = null;
        if (adapter != null) adapter.notifyDataSetChanged();
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        NabzUi.applyWindowBackground(this);
        if (!AuthRepository.get().installAppSession(getApplicationContext())) {
            startActivity(new Intent(this, NabzAuthActivity.class));
            finish();
            return;
        }
        conversationId = getIntent().getStringExtra("conv_id");
        conversationTitle = getIntent().getStringExtra("conv_title");
        NabzModels.User me = AuthRepository.get().currentUser();
        myId = me != null ? me.id : "";
        if (conversationId == null || conversationId.isEmpty()) {
            finish();
            return;
        }
        buildUi();
        reloadHistory();
    }

    private void buildUi() {
        float d = getResources().getDisplayMetrics().density;
        int pad = (int) (12 * d + 0.5f);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);

        // --- header ---
        LinearLayout header = new LinearLayout(this);
        header.setOrientation(LinearLayout.HORIZONTAL);
        header.setBackgroundColor(NabzUi.BG_HEADER);
        header.setGravity(Gravity.CENTER_VERTICAL);
        header.setPadding(pad / 2, pad, pad, pad);

        TextView back = new TextView(this);
        back.setText("←");
        back.setTextColor(NabzUi.ACCENT);
        back.setTextSize(22);
        back.setPadding(pad, 0, pad, 0);
        back.setOnClickListener(v -> finish());
        header.addView(back);

        LinearLayout titleBox = new LinearLayout(this);
        titleBox.setOrientation(LinearLayout.VERTICAL);
        TextView title = new TextView(this);
        title.setText(conversationTitle != null ? conversationTitle : "گفتگو");
        title.setTextColor(NabzUi.TEXT);
        title.setTextSize(17);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setMaxLines(1);
        titleBox.addView(title);
        statusText = new TextView(this);
        statusText.setTextColor(NabzUi.TEXT_DIM);
        statusText.setTextSize(12);
        statusText.setMaxLines(1);
        titleBox.addView(statusText);
        header.addView(titleBox, new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        root.addView(header, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        // --- messages ---
        listView = new ListView(this);
        listView.setDivider(null);
        listView.setStackFromBottom(true);
        listView.setTranscriptMode(ListView.TRANSCRIPT_MODE_NORMAL);
        listView.setBackgroundColor(NabzUi.BG);
        adapter = new ChatAdapter();
        listView.setAdapter(adapter);
        listView.setOnItemLongClickListener((parent, view, position, id) -> {
            if (position >= 0 && position < messages.size()) {
                showMessageOptions(messages.get(position));
                return true;
            }
            return false;
        });
        root.addView(listView, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        // --- reply bar ---
        replyBar = new LinearLayout(this);
        replyBar.setOrientation(LinearLayout.HORIZONTAL);
        replyBar.setBackgroundColor(NabzUi.BG_HEADER);
        replyBar.setPadding(pad, pad / 2, pad, pad / 2);
        replyBar.setGravity(Gravity.CENTER_VERTICAL);
        replyText = new TextView(this);
        replyText.setTextColor(NabzUi.ACCENT);
        replyText.setTextSize(13);
        replyText.setMaxLines(1);
        replyBar.addView(replyText, new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        TextView cancelReply = new TextView(this);
        cancelReply.setText("×");
        cancelReply.setTextColor(NabzUi.TEXT_DIM);
        cancelReply.setTextSize(20);
        cancelReply.setPadding(pad, 0, pad, 0);
        cancelReply.setOnClickListener(v -> clearReply());
        replyBar.addView(cancelReply);
        replyBar.setVisibility(View.GONE);
        root.addView(replyBar, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        // --- input bar ---
        LinearLayout inputBar = new LinearLayout(this);
        inputBar.setOrientation(LinearLayout.HORIZONTAL);
        inputBar.setBackgroundColor(NabzUi.BG_HEADER);
        inputBar.setGravity(Gravity.BOTTOM);
        inputBar.setPadding(pad / 2, pad / 2, pad / 2, pad / 2);

        inputField = new EditText(this);
        inputField.setHint("پیام");
        inputField.setTextColor(NabzUi.TEXT);
        inputField.setHintTextColor(NabzUi.TEXT_DIM);
        inputField.setTextSize(15);
        inputField.setMaxLines(4);
        inputField.setBackground(NabzUi.rounded(NabzUi.BG, 20, inputField));
        inputField.setPadding(pad, pad, pad, pad);
        inputField.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int a, int b, int c) {}
            @Override public void onTextChanged(CharSequence s, int a, int b, int c) {}
            @Override public void afterTextChanged(Editable s) { onTypingActivity(); }
        });
        LinearLayout.LayoutParams inputLp = new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        inputBar.addView(inputField, inputLp);

        micButton = new TextView(this);
        micButton.setText("●");
        micButton.setTextColor(NabzUi.TEXT_DIM);
        micButton.setTextSize(22);
        micButton.setGravity(Gravity.CENTER);
        micButton.setBackground(NabzUi.rounded(NabzUi.BG_ROW_PRESSED, 24, micButton));
        micButton.setOnTouchListener((v, event) -> {
            switch (event.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                    tryStartRecording();
                    return true;
                case MotionEvent.ACTION_UP:
                case MotionEvent.ACTION_CANCEL:
                    stopRecordingAndSend();
                    return true;
                default:
                    return false;
            }
        });
        LinearLayout.LayoutParams micLp = new LinearLayout.LayoutParams((int) (46 * d), (int) (46 * d));
        micLp.leftMargin = (int) (6 * d);
        inputBar.addView(micButton, micLp);

        TextView send = new TextView(this);
        send.setText("ارسال");
        send.setTextColor(Color.WHITE);
        send.setTextSize(14);
        send.setGravity(Gravity.CENTER);
        send.setBackground(NabzUi.rounded(NabzUi.ACCENT, 20, send));
        send.setPadding(pad, 0, pad, 0);
        send.setOnClickListener(v -> sendCurrentText());
        LinearLayout.LayoutParams sendLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, (int) (46 * d));
        sendLp.leftMargin = (int) (6 * d);
        inputBar.addView(send, sendLp);

        root.addView(inputBar, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        recordStatus = new TextView(this);
        recordStatus.setTextColor(NabzUi.TEXT_DIM);
        recordStatus.setTextSize(12);
        recordStatus.setGravity(Gravity.CENTER);
        recordStatus.setVisibility(View.GONE);
        root.addView(recordStatus, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        setContentView(root);
    }

    @Override
    protected void onStart() {
        super.onStart();
        RealtimeClient.get().setListener(realtimeListener);
        RealtimeClient.get().connect();
    }

    @Override
    protected void onStop() {
        RealtimeClient.get().setListener(null);
        if (recording) {
            recorder.stop();
            releaseRecorder();
            recording = false;
        }
        super.onStop();
    }

    @Override
    protected void onDestroy() {
        stopPlayback();
        releaseRecorder();
        super.onDestroy();
    }

    // --- history & realtime ---

    private void reloadHistory() {
        if (loading) return;
        loading = true;
        MessageRepository.get().history(conversationId, null, MAX_HISTORY,
                new NabzApiClient.JsonCallback() {
                    @Override public void onSuccess(JSONObject data) {
                        loading = false;
                        messages.clear();
                        messageIds.clear();
                        JSONArray items = data.optJSONArray("items");
                        if (items != null) {
                            for (int i = 0; i < items.length(); i++) {
                                JSONObject o = items.optJSONObject(i);
                                if (o == null) continue;
                                NabzModels.Message m = NabzModels.Message.fromJson(o);
                                m.reactionsJson = o.optJSONArray("reactions");
                                if (!messageIds.contains(m.id)) {
                                    messageIds.add(m.id);
                                    messages.add(m);
                                }
                            }
                        }
                        sortMessages();
                        adapter.notifyDataSetChanged();
                        listView.post(() -> {
                            if (messages.size() > 0) {
                                listView.setSelection(messages.size() - 1);
                                NabzModels.Message last = messages.get(messages.size() - 1);
                                MessageRepository.get().markRead(conversationId, last.id,
                                        new NabzApiClient.JsonCallback() {
                                            @Override public void onSuccess(JSONObject d) {}
                                            @Override public void onError(NabzApiClient.ApiException e) {}
                                        });
                            }
                        });
                    }
                    @Override public void onError(NabzApiClient.ApiException error) {
                        loading = false;
                        NabzUi.toast(NabzChatActivity.this, "دریافت پیام‌ها ناموفق بود");
                    }
                });
    }

    private void sortMessages() {
        java.util.Collections.sort(messages, (a, b) -> Long.compare(a.createdAt, b.createdAt));
    }

    private void appendOrReplace(NabzModels.Message m) {
        if (messageIds.contains(m.id)) {
            for (int i = 0; i < messages.size(); i++) {
                if (messages.get(i).id.equals(m.id)) messages.set(i, m);
            }
        } else {
            messageIds.add(m.id);
            messages.add(m);
            sortMessages();
        }
        adapter.notifyDataSetChanged();
    }

    private final RealtimeClient.Listener realtimeListener = new RealtimeClient.Listener() {
        @Override public void onReady(String userId, JSONArray onlineUserIds) {}

        @Override public void onEvent(String type, JSONObject event) {
            String convId = event.optString("conversation_id");
            if (!conversationId.equals(convId)) return;
            switch (type == null ? "" : type) {
                case "message.new": {
                    JSONObject payload = event.optJSONObject("message");
                    if (payload == null) payload = event;
                    NabzModels.Message m = NabzModels.Message.fromJson(payload);
                    m.reactionsJson = payload.optJSONArray("reactions");
                    appendOrReplace(m);
                    if (!myId.equals(m.senderId)) {
                        MessageRepository.get().markRead(conversationId, m.id,
                                new NabzApiClient.JsonCallback() {
                                    @Override public void onSuccess(JSONObject d) {}
                                    @Override public void onError(NabzApiClient.ApiException e) {}
                                });
                    }
                    break;
                }
                case "typing": {
                    String uid = event.optString("user_id");
                    if (!myId.equals(uid) && "typing".equals(event.optString("state"))) {
                        statusText.setText("در حال نوشتن…");
                        handler.removeCallbacks(typingIndicatorOff);
                        handler.postDelayed(typingIndicatorOff, 4000);
                    }
                    break;
                }
                default:
                    // edited / deleted / reaction: refresh to stay consistent
                    handler.removeCallbacks(reloadRunnable);
                    handler.postDelayed(reloadRunnable, 300);
                    break;
            }
        }

        @Override public void onConnectionStateChange(boolean connected) {}
    };

    private void onTypingActivity() {
        long now = System.currentTimeMillis();
        if (now - lastTypingSent > 3000) {
            lastTypingSent = now;
            RealtimeClient.get().sendTyping(conversationId, true);
        }
        handler.removeCallbacks(typingOffRunnable);
        handler.postDelayed(typingOffRunnable, 3000);
    }

    // --- sending ---

    private void sendCurrentText() {
        if (sending) return;
        final String text = inputField.getText().toString().trim();
        if (text.isEmpty()) return;
        sending = true;
        final String replyId = replyToId;
        MessageRepository.get().sendText(conversationId, text, replyId,
                new NabzApiClient.JsonCallback() {
                    @Override public void onSuccess(JSONObject data) {
                        sending = false;
                        inputField.setText("");
                        clearReply();
                        JSONObject message = data.optJSONObject("message");
                        if (message != null) {
                            NabzModels.Message m = NabzModels.Message.fromJson(message);
                            m.reactionsJson = message.optJSONArray("reactions");
                            appendOrReplace(m);
                        } else {
                            reloadHistory();
                        }
                    }
                    @Override public void onError(NabzApiClient.ApiException error) {
                        sending = false;
                        NabzUi.toast(NabzChatActivity.this, prettyError(error));
                    }
                });
    }

    private String prettyError(NabzApiClient.ApiException error) {
        if (error == null) return "خطا";
        if ("NETWORK".equals(error.code)) return "پیام ارسال نشد - اتصال را بررسی کنید";
        return "ارسال پیام ناموفق بود";
    }

    // --- message actions ---

    private void showMessageOptions(final NabzModels.Message m) {
        if (m.deleted) return;
        final List<String> options = new ArrayList<>();
        final List<Integer> actions = new ArrayList<>();
        options.add("پاسخ");
        actions.add(0);
        options.add("کپی متن");
        actions.add(1);
        options.add("واکنش");
        actions.add(2);
        if (myId.equals(m.senderId) && "text".equals(m.type) && m.body != null) {
            options.add("ویرایش");
            actions.add(3);
            options.add("حذف");
            actions.add(4);
        }

        new AlertDialog.Builder(this)
                .setTitle("پیام")
                .setItems(options.toArray(new String[0]), (dialog, which) -> {
                    switch (actions.get(which)) {
                        case 0: startReply(m); break;
                        case 1: copyToClipboard(m); break;
                        case 2: showReactionDialog(m); break;
                        case 3: showEditDialog(m); break;
                        case 4: confirmDelete(m); break;
                    }
                })
                .show();
    }

    private void startReply(NabzModels.Message m) {
        replyToId = m.id;
        String who = myId.equals(m.senderId) ? "خودتان" :
                (m.senderName != null ? m.senderName : "");
        String body = m.type != null && "voice".equals(m.type) ? "پیام صوتی"
                : (m.body != null ? m.body : "");
        replyText.setText("پاسخ به " + who + ": " + body);
        replyBar.setVisibility(View.VISIBLE);
        inputField.requestFocus();
        InputMethodManager imm = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
        if (imm != null) imm.showSoftInput(inputField, InputMethodManager.SHOW_IMPLICIT);
    }

    private void clearReply() {
        replyToId = null;
        if (replyBar != null) replyBar.setVisibility(View.GONE);
    }

    private void copyToClipboard(NabzModels.Message m) {
        if (m.body == null) return;
        ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
        if (cm != null) {
            cm.setPrimaryClip(new ClipData("nabz", new String[]{"text/plain"},
                    new ClipData.Item(m.body)));
            NabzUi.toast(this, "کپی شد");
        }
    }

    private void showReactionDialog(final NabzModels.Message m) {
        new AlertDialog.Builder(this)
                .setTitle("واکنش")
                .setItems(REACTIONS, (dialog, which) ->
                        MessageRepository.get().react(m.id, REACTIONS[which],
                                new NabzApiClient.JsonCallback() {
                                    @Override public void onSuccess(JSONObject data) {
                                        JSONArray reactions = data.optJSONArray("reactions");
                                        m.reactionsJson = reactions;
                                        adapter.notifyDataSetChanged();
                                    }
                                    @Override public void onError(NabzApiClient.ApiException e) {
                                        NabzUi.toast(NabzChatActivity.this, "ثبت واکنش ناموفق بود");
                                    }
                                }))
                .show();
    }

    private void showEditDialog(final NabzModels.Message m) {
        final EditText input = new EditText(this);
        input.setText(m.body);
        input.setTextColor(NabzUi.TEXT);
        new AlertDialog.Builder(this)
                .setTitle("ویرایش پیام")
                .setView(input)
                .setPositiveButton("ذخیره", (dialog, which) -> {
                    String newBody = input.getText().toString().trim();
                    if (newBody.isEmpty()) return;
                    MessageRepository.get().edit(m.id, newBody, new NabzApiClient.JsonCallback() {
                        @Override public void onSuccess(JSONObject data) {
                            JSONObject message = data.optJSONObject("message");
                            if (message != null) {
                                NabzModels.Message edited = NabzModels.Message.fromJson(message);
                                edited.reactionsJson = message.optJSONArray("reactions");
                                appendOrReplace(edited);
                            }
                        }
                        @Override public void onError(NabzApiClient.ApiException e) {
                            NabzUi.toast(NabzChatActivity.this, "ویرایش ناموفق بود");
                        }
                    });
                })
                .setNegativeButton("انصراف", null)
                .show();
    }

    private void confirmDelete(final NabzModels.Message m) {
        new AlertDialog.Builder(this)
                .setTitle("حذف پیام")
                .setMessage("این پیام برای همه حذف شود؟")
                .setPositiveButton("حذف", (dialog, which) ->
                        MessageRepository.get().delete(m.id, new NabzApiClient.JsonCallback() {
                            @Override public void onSuccess(JSONObject data) {
                                messageIds.remove(m.id);
                                messages.remove(m);
                                adapter.notifyDataSetChanged();
                            }
                            @Override public void onError(NabzApiClient.ApiException e) {
                                NabzUi.toast(NabzChatActivity.this, "حذف ناموفق بود");
                            }
                        }))
                .setNegativeButton("انصراف", null)
                .show();
    }

    // --- voice recording ---

    private void tryStartRecording() {
        if (recording || sending) return;
        if (Build.VERSION.SDK_INT >= 23
                && checkSelfPermission(Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, 100);
            return;
        }
        try {
            recorder = new MediaRecorder();
            recorder.setAudioSource(MediaRecorder.AudioSource.MIC);
            recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
            recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);
            recorder.setAudioSamplingRate(44100);
            recorder.setAudioEncodingBitRate(48000);
            recordFile = new File(getCacheDir(), "nabz_voice_" + System.currentTimeMillis() + ".m4a");
            recorder.setOutputFile(recordFile.getAbsolutePath());
            recorder.prepare();
            recorder.start();
            recording = true;
            recordStartMs = System.currentTimeMillis();
            amplitudeSamples.clear();
            handler.post(amplitudeRunnable);
            micButton.setTextColor(0xFFFF5C5C);
            recordStatus.setVisibility(View.VISIBLE);
            recordStatus.setText("در حال ضبط… برای ارسال رها کنید");
        } catch (Exception e) {
            releaseRecorder();
            NabzUi.toast(this, "ضبط صدا ممکن نشد");
        }
    }

    private void stopRecordingAndSend() {
        if (!recording) return;
        recording = false;
        long durationMs = System.currentTimeMillis() - recordStartMs;
        micButton.setTextColor(NabzUi.TEXT_DIM);
        recordStatus.setVisibility(View.GONE);
        try {
            recorder.stop();
        } catch (Exception ignored) {
            releaseRecorder();
            return;
        }
        releaseRecorder();
        if (durationMs < 600) {
            if (recordFile != null) recordFile.delete();
            NabzUi.toast(this, "ضبط خیلی کوتاه بود");
            return;
        }
        final File file = recordFile;
        final int[] waveform = buildWaveform();
        recordFile = null;
        final long dur = durationMs;
        new Thread(() -> {
            try {
                byte[] bytes = readAll(file);
                String attachmentId = MediaRepository.get().uploadBlocking(
                        conversationId, "voice", "audio/mp4", bytes, dur, waveform);
                file.delete();
                handler.post(() -> MessageRepository.get().sendVoice(conversationId, attachmentId,
                        replyToId, new NabzApiClient.JsonCallback() {
                            @Override public void onSuccess(JSONObject data) {
                                clearReply();
                                JSONObject message = data.optJSONObject("message");
                                if (message != null) {
                                    NabzModels.Message m = NabzModels.Message.fromJson(message);
                                    m.reactionsJson = message.optJSONArray("reactions");
                                    appendOrReplace(m);
                                }
                            }
                            @Override public void onError(NabzApiClient.ApiException e) {
                                NabzUi.toast(NabzChatActivity.this, "ارسال پیام صوتی ناموفق بود");
                            }
                        }));
            } catch (Exception e) {
                handler.post(() -> NabzUi.toast(NabzChatActivity.this, "آپلود پیام صوتی ناموفق بود"));
            }
        }, "nabz-voice-upload").start();
    }

    private void releaseRecorder() {
        if (recorder != null) {
            try { recorder.release(); } catch (Exception ignored) {}
            recorder = null;
        }
        handler.removeCallbacks(amplitudeRunnable);
    }

    private int[] buildWaveform() {
        int bins = 32;
        int[] out = new int[bins];
        if (amplitudeSamples.isEmpty()) return out;
        int per = Math.max(1, amplitudeSamples.size() / bins);
        for (int b = 0; b < bins; b++) {
            int start = b * per;
            int max = 0;
            for (int i = start; i < start + per && i < amplitudeSamples.size(); i++) {
                max = Math.max(max, amplitudeSamples.get(i));
            }
            // normalize 32767 -> 1..9 bars
            int level = (int) Math.ceil(Math.min(1.0, max / 26000.0) * 9);
            out[b] = Math.max(1, Math.min(9, level));
        }
        return out;
    }

    private static byte[] readAll(File file) throws Exception {
        FileInputStream in = new FileInputStream(file);
        try {
            java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            return bos.toByteArray();
        } finally {
            in.close();
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == 100 && grantResults.length > 0
                && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            // permission granted; user can press the mic again
        }
    }

    // --- playback ---

    private void togglePlayback(final NabzModels.Message m) {
        if (m.attachment == null || m.attachment.id == null) return;
        if (m.attachment.id.equals(playingAttachmentId)) {
            stopPlayback();
            adapter.notifyDataSetChanged();
            return;
        }
        stopPlayback();
        final String attachmentId = m.attachment.id;
        new Thread(() -> {
            try {
                byte[] bytes = MediaRepository.get().downloadBlocking(attachmentId);
                File outFile = new File(getCacheDir(), "nabz_dl_" + attachmentId + ".m4a");
                java.io.FileOutputStream fos = new java.io.FileOutputStream(outFile);
                fos.write(bytes);
                fos.close();
                handler.post(() -> {
                    try {
                        player = new MediaPlayer();
                        player.setDataSource(outFile.getAbsolutePath());
                        player.prepare();
                        player.setOnCompletionListener(completionListener);
                        player.start();
                        playingAttachmentId = attachmentId;
                        adapter.notifyDataSetChanged();
                    } catch (Exception e) {
                        NabzUi.toast(NabzChatActivity.this, "پخش ناموفق بود");
                    }
                });
            } catch (Exception e) {
                handler.post(() -> NabzUi.toast(NabzChatActivity.this, "دانلود پیام صوتی ناموفق بود"));
            }
        }, "nabz-voice-play").start();
    }

    private void stopPlayback() {
        if (player != null) {
            try { player.stop(); } catch (Exception ignored) {}
            try { player.release(); } catch (Exception ignored) {}
            player = null;
        }
        playingAttachmentId = null;
    }

    // --- adapter ---

    private String fmtClock(long ms) {
        if (ms <= 0) return "";
        return new SimpleDateFormat("HH:mm", Locale.getDefault()).format(new Date(ms));
    }

    private String fmtDuration(long ms) {
        long s = ms / 1000;
        return (s / 60) + ":" + String.format(Locale.US, "%02d", s % 60);
    }

    private class ChatAdapter extends BaseAdapter {
        @Override public int getCount() { return messages.size(); }
        @Override public Object getItem(int position) { return messages.get(position); }
        @Override public long getItemId(int position) { return position; }

        @Override
        public View getView(int position, View convertView, ViewGroup parent) {
            final NabzModels.Message m = messages.get(position);
            float d = NabzUi.density(parent);
            boolean mine = myId.equals(m.senderId);

            LinearLayout row = convertView instanceof LinearLayout
                    ? (LinearLayout) convertView : new LinearLayout(NabzChatActivity.this);
            row.removeAllViews();
            row.setOrientation(LinearLayout.HORIZONTAL);
            row.setPadding((int) (10 * d), (int) (4 * d), (int) (10 * d), (int) (4 * d));
            row.setBackgroundColor(NabzUi.BG);

            LinearLayout bubble = new LinearLayout(NabzChatActivity.this);
            bubble.setOrientation(LinearLayout.VERTICAL);
            bubble.setPadding((int) (12 * d), (int) (8 * d), (int) (12 * d), (int) (8 * d));
            bubble.setBackground(NabzUi.rounded(mine ? NabzUi.BUBBLE_OUT : NabzUi.BUBBLE_IN, 14, bubble));

            if (!mine && m.senderName != null && !m.senderName.isEmpty()) {
                TextView sender = new TextView(NabzChatActivity.this);
                sender.setText(m.senderName);
                sender.setTextColor(NabzUi.ACCENT);
                sender.setTextSize(13);
                sender.setTypeface(Typeface.DEFAULT_BOLD);
                bubble.addView(sender);
            }

            if (m.replyToId != null) {
                TextView reply = new TextView(NabzChatActivity.this);
                reply.setText("پاسخ به پیام قبلی");
                reply.setTextColor(NabzUi.ACCENT);
                reply.setTextSize(12);
                bubble.addView(reply);
            }

            if ("voice".equals(m.type) && m.attachment != null) {
                LinearLayout voiceRow = new LinearLayout(NabzChatActivity.this);
                voiceRow.setGravity(Gravity.CENTER_VERTICAL);
                TextView play = new TextView(NabzChatActivity.this);
                boolean isPlaying = m.attachment.id != null && m.attachment.id.equals(playingAttachmentId);
                play.setText(isPlaying ? "توقف" : "پخش");
                play.setTextColor(NabzUi.ACCENT);
                play.setTextSize(14);
                play.setOnClickListener(v -> togglePlayback(m));
                voiceRow.addView(play);

                LinearLayout bars = new LinearLayout(NabzChatActivity.this);
                bars.setPadding((int) (10 * d), 0, (int) (10 * d), 0);
                bars.setGravity(Gravity.CENTER_VERTICAL);
                if (m.attachment.waveform != null) {
                    for (int i = 0; i < m.attachment.waveform.length && i < 32; i++) {
                        View bar = new View(NabzChatActivity.this);
                        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                                (int) (2.5f * d), (int) (2 + m.attachment.waveform[i] * 1.8f * d));
                        lp.rightMargin = (int) (1.5f * d);
                        bar.setLayoutParams(lp);
                        bar.setBackgroundColor(NabzUi.TEXT_DIM);
                        bars.addView(bar);
                    }
                }
                voiceRow.addView(bars);

                TextView dur = new TextView(NabzChatActivity.this);
                dur.setText(fmtDuration(m.attachment.durationMs));
                dur.setTextColor(NabzUi.TEXT_DIM);
                dur.setTextSize(12);
                voiceRow.addView(dur);
                bubble.addView(voiceRow);
            } else if (m.body != null) {
                TextView body = new TextView(NabzChatActivity.this);
                body.setText(m.body);
                body.setTextColor(NabzUi.TEXT);
                body.setTextSize(15);
                if (parent.getWidth() > 0) {
                    body.setMaxWidth((int) (parent.getWidth() * 0.72f));
                }
                bubble.addView(body);
            }

            LinearLayout metaRow = new LinearLayout(NabzChatActivity.this);
            metaRow.setGravity(Gravity.END);
            TextView time = new TextView(NabzChatActivity.this);
            String meta = fmtClock(m.createdAt);
            if (m.editedAt > 0) meta += " - ویرایش شده";
            time.setText(meta);
            time.setTextColor(NabzUi.TEXT_DIM);
            time.setTextSize(10);
            metaRow.addView(time);
            bubble.addView(metaRow);

            if (m.reactionsJson != null && m.reactionsJson.length() > 0) {
                StringBuilder sb = new StringBuilder();
                for (int i = 0; i < m.reactionsJson.length(); i++) {
                    JSONObject r = m.reactionsJson.optJSONObject(i);
                    if (r == null) continue;
                    JSONArray users = r.optJSONArray("user_ids");
                    int count = users != null ? users.length() : 0;
                    if (count <= 0) continue;
                    if (sb.length() > 0) sb.append(' ');
                    sb.append(r.optString("emoji")).append(' ').append(count);
                }
                if (sb.length() > 0) {
                    TextView reactions = new TextView(NabzChatActivity.this);
                    reactions.setText(sb.toString());
                    reactions.setTextColor(NabzUi.ACCENT);
                    reactions.setTextSize(12);
                    reactions.setBackground(NabzUi.rounded(NabzUi.withAlpha(NabzUi.ACCENT, 0.12f), 8, reactions));
                    reactions.setPadding((int) (8 * d), (int) (2 * d), (int) (8 * d), (int) (2 * d));
                    LinearLayout.LayoutParams rlp = new LinearLayout.LayoutParams(
                            ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
                    rlp.topMargin = (int) (4 * d);
                    bubble.addView(reactions, rlp);
                }
            }

            LinearLayout.LayoutParams bubbleLp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            if (mine) {
                row.setGravity(Gravity.END);
                bubbleLp.leftMargin = (int) (48 * d);
            } else {
                row.setGravity(Gravity.START);
                bubbleLp.rightMargin = (int) (48 * d);
            }
            row.addView(bubble, bubbleLp);
            return row;
        }
    }
}
