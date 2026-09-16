package app.nabz.ui;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.BaseAdapter;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ListView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.Date;
import java.util.List;
import java.util.Locale;

import app.nabz.model.NabzModels;
import app.nabz.net.AuthRepository;
import app.nabz.net.ChatRepository;
import app.nabz.net.NabzApiClient;
import app.nabz.net.RealtimeClient;
import app.nabz.net.UserRepository;

/**
 * Nabz conversation list: private chats + groups backed by the Nabz backend.
 * Refreshes from realtime events (message.new) and shows connection state.
 */
public class NabzMainActivity extends Activity {

    private static class Row {
        String conversationId;
        String title;
        String subtitle;
        String time;
        int unread;
    }

    private final List<Row> rows = new ArrayList<>();
    private ListView listView;
    private TextView emptyView, statusDot, statusText;
    private ListAdapter adapter;
    private boolean loading;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable reloadRunnable = this::reloadList;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        NabzUi.applyWindowBackground(this);
        if (!AuthRepository.get().installAppSession(getApplicationContext())) {
            goToAuth();
            return;
        }
        buildUi();
    }

    private void buildUi() {
        float d = getResources().getDisplayMetrics().density;

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);

        // --- header ---
        LinearLayout header = new LinearLayout(this);
        header.setOrientation(LinearLayout.HORIZONTAL);
        header.setBackgroundColor(NabzUi.BG_HEADER);
        header.setGravity(Gravity.CENTER_VERTICAL);
        int pad = (int) (14 * d + 0.5f);
        header.setPadding(pad, pad, pad, pad);

        TextView title = new TextView(this);
        title.setText("نبض");
        title.setTextColor(NabzUi.TEXT);
        title.setTextSize(20);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        header.addView(title);

        LinearLayout statusBox = new LinearLayout(this);
        statusBox.setOrientation(LinearLayout.HORIZONTAL);
        statusBox.setGravity(Gravity.CENTER_VERTICAL);
        statusBox.setPadding((int) (12 * d), 0, 0, 0);
        statusDot = new TextView(this);
        statusDot.setText("●");
        statusDot.setTextColor(NabzUi.TEXT_DIM);
        statusDot.setTextSize(11);
        statusBox.addView(statusDot);
        statusText = new TextView(this);
        statusText.setText("در حال اتصال");
        statusText.setTextColor(NabzUi.TEXT_DIM);
        statusText.setTextSize(11);
        statusText.setPadding((int) (4 * d), 0, 0, 0);
        statusBox.addView(statusText);
        header.addView(statusBox, new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        TextView newChat = headerButton("گفتگوی جدید", d);
        newChat.setOnClickListener(v -> showNewChatDialog());
        header.addView(newChat);

        TextView logout = headerButton("خروج", d);
        logout.setOnClickListener(v -> confirmLogout());
        header.addView(logout);

        root.addView(header, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        // --- list ---
        listView = new ListView(this);
        listView.setDivider(null);
        listView.setBackgroundColor(NabzUi.BG);
        adapter = new ListAdapter();
        listView.setAdapter(adapter);
        listView.setOnItemClickListener((parent, view, position, id) -> {
            if (position < 0 || position >= rows.size()) return;
            Row row = rows.get(position);
            Intent intent = new Intent(this, NabzChatActivity.class);
            intent.putExtra("conv_id", row.conversationId);
            intent.putExtra("conv_title", row.title);
            startActivity(intent);
        });

        emptyView = new TextView(this);
        emptyView.setText("هنوز گفتگویی ندارید.\nبا «گفتگوی جدید» شروع کنید.");
        emptyView.setTextColor(NabzUi.TEXT_DIM);
        emptyView.setTextSize(15);
        emptyView.setGravity(Gravity.CENTER);
        emptyView.setPadding(0, (int) (80 * d), 0, 0);

        FrameLayout content = new FrameLayout(this);
        content.addView(listView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        content.addView(emptyView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.CENTER_HORIZONTAL));
        root.addView(content, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        setContentView(root);
    }

    private TextView headerButton(String label, float d) {
        TextView b = new TextView(this);
        b.setText(label);
        b.setTextColor(NabzUi.ACCENT);
        b.setTextSize(14);
        b.setPadding((int) (10 * d), (int) (8 * d), (int) (10 * d), (int) (8 * d));
        b.setBackground(NabzUi.rounded(NabzUi.BG_ROW_PRESSED, 8, b));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.leftMargin = (int) (8 * d);
        b.setLayoutParams(lp);
        return b;
    }

    @Override
    protected void onStart() {
        super.onStart();
        RealtimeClient.get().setListener(realtimeListener);
        RealtimeClient.get().connect();
        reloadList();
    }

    @Override
    protected void onStop() {
        RealtimeClient.get().setListener(null);
        super.onStop();
    }

    private final RealtimeClient.Listener realtimeListener = new RealtimeClient.Listener() {
        @Override public void onReady(String userId, JSONArray onlineUserIds) {
            setConnected(true);
        }
        @Override public void onEvent(String type, JSONObject event) {
            if ("message.new".equals(type) || "message.deleted".equals(type)
                    || "message.edited".equals(type)) {
                handler.removeCallbacks(reloadRunnable);
                handler.postDelayed(reloadRunnable, 400);
            }
        }
        @Override public void onConnectionStateChange(boolean connected) {
            setConnected(connected);
        }
    };

    private void setConnected(boolean connected) {
        if (statusDot == null || statusText == null) return;
        statusDot.setTextColor(connected ? NabzUi.ONLINE : NabzUi.TEXT_DIM);
        statusText.setText(connected ? "متصل" : "در حال اتصال");
    }

    private void reloadList() {
        if (loading) return;
        loading = true;
        ChatRepository.get().listConversations(new NabzApiClient.JsonCallback() {
            @Override public void onSuccess(JSONObject data) {
                loading = false;
                rows.clear();
                JSONArray items = data.optJSONArray("items");
                String myId = AuthRepository.get().currentUser() != null
                        ? AuthRepository.get().currentUser().id : "";
                if (items != null) {
                    for (int i = 0; i < items.length(); i++) {
                        JSONObject conv = items.optJSONObject(i);
                        if (conv == null) continue;
                        rows.add(parseRow(conv, myId));
                    }
                }
                adapter.notifyDataSetChanged();
                emptyView.setVisibility(rows.isEmpty() ? View.VISIBLE : View.GONE);
            }
            @Override public void onError(NabzApiClient.ApiException error) {
                loading = false;
                emptyView.setVisibility(rows.isEmpty() ? View.VISIBLE : View.GONE);
            }
        });
    }

    private Row parseRow(JSONObject conv, String myId) {
        Row row = new Row();
        row.conversationId = conv.optString("id");
        row.unread = conv.optInt("unread_count", 0);
        String type = conv.optString("type", "private");
        String otherName = null;
        JSONArray members = conv.optJSONArray("members");
        if (members != null) {
            for (int i = 0; i < members.length(); i++) {
                JSONObject m = members.optJSONObject(i);
                JSONObject user = m != null ? m.optJSONObject("user") : null;
                if (user != null && !myId.equals(user.optString("id"))) {
                    otherName = user.optString("display_name");
                    if (otherName == null || otherName.isEmpty()) otherName = user.optString("username");
                    break;
                }
            }
        }
        if ("group".equals(type)) {
            row.title = conv.optString("title", null);
            if (row.title == null || row.title.isEmpty()) row.title = "گروه";
        } else {
            row.title = otherName != null && !otherName.isEmpty() ? otherName : "گفتگو";
        }

        JSONObject last = conv.optJSONObject("last_message");
        if (last != null) {
            String body = last.optString("body", null);
            String type2 = last.optString("type", "text");
            if (body == null || body.isEmpty()) {
                row.subtitle = "voice".equals(type2) ? "پیام صوتی" : "پیام حذف شد";
            } else {
                row.subtitle = body;
            }
            row.time = fmtTime(last.optLong("created_at", 0));
        } else {
            row.subtitle = "بدون پیام";
            row.time = "";
        }
        return row;
    }

    private String fmtTime(long ms) {
        if (ms <= 0) return "";
        try {
            Calendar now = Calendar.getInstance();
            Calendar then = Calendar.getInstance();
            then.setTimeInMillis(ms);
            if (now.get(Calendar.YEAR) == then.get(Calendar.YEAR)
                    && now.get(Calendar.DAY_OF_YEAR) == then.get(Calendar.DAY_OF_YEAR)) {
                return new SimpleDateFormat("HH:mm", Locale.getDefault()).format(new Date(ms));
            }
            return new SimpleDateFormat("MM/dd", Locale.getDefault()).format(new Date(ms));
        } catch (Exception e) {
            return "";
        }
    }

    // --- new chat / new group ---

    private void showNewChatDialog() {
        UserRepository.get().directory(new UserRepository.ListCallback() {
            @Override public void onSuccess(List<NabzModels.User> users) {
                String myId = AuthRepository.get().currentUser() != null
                        ? AuthRepository.get().currentUser().id : "";
                final List<NabzModels.User> others = new ArrayList<>();
                for (NabzModels.User u : users) {
                    if (!u.id.equals(myId)) others.add(u);
                }
                if (others.isEmpty()) {
                    NabzUi.toast(NabzMainActivity.this, "کاربر دیگری ثبت‌نام نکرده است");
                    return;
                }
                final String[] names = new String[others.size()];
                for (int i = 0; i < others.size(); i++) {
                    names[i] = others.get(i).displayName != null && !others.get(i).displayName.isEmpty()
                            ? others.get(i).displayName : others.get(i).username;
                }
                new AlertDialog.Builder(NabzMainActivity.this)
                        .setTitle("گفتگو با چه کسی؟")
                        .setItems(names, (dialog, which) -> openPrivateWith(others.get(which)))
                        .setNeutralButton("گروه جدید", (dialog, which) -> showNewGroupDialog(others))
                        .setNegativeButton("انصراف", null)
                        .show();
            }
            @Override public void onError(NabzApiClient.ApiException error) {
                NabzUi.toast(NabzMainActivity.this, "دریافت فهرست کاربران ناموفق بود");
            }
        });
    }

    private void showNewGroupDialog(final List<NabzModels.User> users) {
        final boolean[] checked = new boolean[users.size()];
        final String[] names = new String[users.size()];
        for (int i = 0; i < users.size(); i++) {
            names[i] = users.get(i).displayName != null && !users.get(i).displayName.isEmpty()
                    ? users.get(i).displayName : users.get(i).username;
        }
        new AlertDialog.Builder(this)
                .setTitle("انتخاب اعضای گروه")
                .setMultiChoiceItems(names, checked, (dialog, which, isChecked) -> checked[which] = isChecked)
                .setPositiveButton("ادامه", (dialog, which) -> {
                    final List<String> memberIds = new ArrayList<>();
                    for (int i = 0; i < users.size(); i++) {
                        if (checked[i]) memberIds.add(users.get(i).id);
                    }
                    if (memberIds.isEmpty()) {
                        NabzUi.toast(this, "حداقل یک عضو انتخاب کنید");
                        return;
                    }
                    final EditText input = new EditText(this);
                    input.setHint("نام گروه");
                    input.setTextColor(NabzUi.TEXT);
                    new AlertDialog.Builder(this)
                            .setTitle("نام گروه")
                            .setView(input)
                            .setPositiveButton("ساخت", (d2, w2) -> {
                                String title = input.getText().toString().trim();
                                if (title.isEmpty()) return;
                                ChatRepository.get().createGroup(title, memberIds,
                                        new ChatRepository.ConvCallback() {
                                            @Override public void onSuccess(String conversationId) {
                                                openChat(conversationId, title);
                                            }
                                            @Override public void onError(NabzApiClient.ApiException error) {
                                                NabzUi.toast(NabzMainActivity.this, "ساخت گروه ناموفق بود");
                                            }
                                        });
                            })
                            .setNegativeButton("انصراف", null)
                            .show();
                })
                .setNegativeButton("انصراف", null)
                .show();
    }

    private void openPrivateWith(final NabzModels.User user) {
        ChatRepository.get().createPrivate(user.id, new ChatRepository.ConvCallback() {
            @Override public void onSuccess(String conversationId) {
                String name = user.displayName != null && !user.displayName.isEmpty()
                        ? user.displayName : user.username;
                openChat(conversationId, name);
            }
            @Override public void onError(NabzApiClient.ApiException error) {
                NabzUi.toast(NabzMainActivity.this, "ساخت گفتگو ناموفق بود");
            }
        });
    }

    private void openChat(String conversationId, String title) {
        Intent intent = new Intent(this, NabzChatActivity.class);
        intent.putExtra("conv_id", conversationId);
        intent.putExtra("conv_title", title);
        startActivity(intent);
    }

    private void confirmLogout() {
        new AlertDialog.Builder(this)
                .setTitle("خروج از حساب")
                .setMessage("مطمئنید می‌خواهید خارج شوید؟")
                .setPositiveButton("خروج", (dialog, which) ->
                        AuthRepository.get().logout(() -> goToAuth()))
                .setNegativeButton("انصراف", null)
                .show();
    }

    private void goToAuth() {
        RealtimeClient.get().disconnect();
        startActivity(new Intent(this, NabzAuthActivity.class));
        finish();
    }

    private class ListAdapter extends BaseAdapter {
        @Override public int getCount() { return rows.size(); }
        @Override public Object getItem(int position) { return rows.get(position); }
        @Override public long getItemId(int position) { return position; }

        @Override
        public View getView(int position, View convertView, ViewGroup parent) {
            Row row = rows.get(position);
            float d = NabzUi.density(parent);

            LinearLayout cell = convertView instanceof LinearLayout
                    ? (LinearLayout) convertView : new LinearLayout(NabzMainActivity.this);
            cell.removeAllViews();
            cell.setOrientation(LinearLayout.HORIZONTAL);
            cell.setGravity(Gravity.CENTER_VERTICAL);
            int pad = (int) (12 * d + 0.5f);
            cell.setPadding(pad, pad, pad, pad);
            cell.setBackgroundColor(NabzUi.BG);

            TextView avatar = new TextView(NabzMainActivity.this);
            avatar.setText(row.title != null && !row.title.isEmpty()
                    ? row.title.substring(0, 1) : "?");
            avatar.setTextColor(Color.WHITE);
            avatar.setTextSize(18);
            avatar.setGravity(Gravity.CENTER);
            avatar.setBackground(NabzUi.avatarDrawable(NabzUi.avatarColor(row.title)));
            cell.addView(avatar, new LinearLayout.LayoutParams((int) (46 * d), (int) (46 * d)));

            LinearLayout texts = new LinearLayout(NabzMainActivity.this);
            texts.setOrientation(LinearLayout.VERTICAL);
            texts.setPadding((int) (12 * d), 0, (int) (8 * d), 0);

            TextView title = new TextView(NabzMainActivity.this);
            title.setText(row.title);
            title.setTextColor(NabzUi.TEXT);
            title.setTextSize(16);
            title.setTypeface(Typeface.DEFAULT_BOLD);
            title.setMaxLines(1);
            texts.addView(title);

            TextView subtitle = new TextView(NabzMainActivity.this);
            subtitle.setText(row.subtitle);
            subtitle.setTextColor(NabzUi.TEXT_DIM);
            subtitle.setTextSize(13);
            subtitle.setMaxLines(1);
            texts.addView(subtitle);

            cell.addView(texts, new LinearLayout.LayoutParams(0,
                    ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

            LinearLayout side = new LinearLayout(NabzMainActivity.this);
            side.setOrientation(LinearLayout.VERTICAL);
            side.setGravity(Gravity.END | Gravity.CENTER_VERTICAL);

            TextView time = new TextView(NabzMainActivity.this);
            time.setText(row.time);
            time.setTextColor(NabzUi.TEXT_DIM);
            time.setTextSize(11);
            side.addView(time);

            if (row.unread > 0) {
                TextView badge = new TextView(NabzMainActivity.this);
                badge.setText(String.valueOf(row.unread));
                badge.setTextColor(Color.WHITE);
                badge.setTextSize(12);
                badge.setGravity(Gravity.CENTER);
                badge.setBackground(NabzUi.rounded(NabzUi.ACCENT, 12, badge));
                LinearLayout.LayoutParams blp = new LinearLayout.LayoutParams(
                        (int) (22 * d), (int) (22 * d));
                blp.topMargin = (int) (6 * d);
                side.addView(badge, blp);
            }
            cell.addView(side, new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));

            return cell;
        }
    }
}
