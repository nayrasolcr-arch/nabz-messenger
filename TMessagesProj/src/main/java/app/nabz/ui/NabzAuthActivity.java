package app.nabz.ui;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Bundle;
import android.text.InputType;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.regex.Pattern;

import app.nabz.net.AuthRepository;
import app.nabz.net.NabzApiClient;
import app.nabz.net.RealtimeClient;

/**
 * Nabz authentication: username + password only. No phone numbers, no SMS
 * codes, no invite codes - the user picks a username, sets a password and is
 * in. This replaces Telegram's phone-code login flow entirely.
 */
public class NabzAuthActivity extends Activity {

    private static final Pattern USERNAME = Pattern.compile("^[a-z0-9_]{3,32}$");

    private boolean registerMode = false;
    private boolean busy = false;

    private EditText usernameField, passwordField, nameField;
    private View nameRow;
    private Button primaryButton;
    private TextView toggleButton, statusText;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        NabzUi.applyWindowBackground(this);

        float d = getResources().getDisplayMetrics().density;
        int pad = (int) (24 * d + 0.5f);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(pad, (int) (56 * d), pad, pad);
        root.setGravity(Gravity.CENTER_HORIZONTAL);

        TextView logo = new TextView(this);
        logo.setText("نبض");
        logo.setTextColor(NabzUi.ACCENT);
        logo.setTextSize(40);
        logo.setTypeface(Typeface.DEFAULT_BOLD);
        logo.setGravity(Gravity.CENTER);
        root.addView(logo, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        TextView tagline = new TextView(this);
        tagline.setText("پیام‌رسان خصوصی شما");
        tagline.setTextColor(NabzUi.TEXT_DIM);
        tagline.setTextSize(14);
        tagline.setGravity(Gravity.CENTER);
        tagline.setPadding(0, (int) (6 * d), 0, (int) (40 * d));
        root.addView(tagline, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        nameField = new EditText(this);
        nameField.setHint("نام نمایشی");
        nameField.setTextColor(NabzUi.TEXT);
        nameField.setHintTextColor(NabzUi.TEXT_DIM);
        nameField.setMaxLines(1);
        nameRow = wrapField(nameField, d);

        usernameField = new EditText(this);
        usernameField.setHint("نام کاربری (حروف انگلیسی کوچک)");
        usernameField.setTextColor(NabzUi.TEXT);
        usernameField.setHintTextColor(NabzUi.TEXT_DIM);
        usernameField.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_NORMAL);
        usernameField.setMaxLines(1);
        root.addView(wrapField(usernameField, d), margin(d));

        passwordField = new EditText(this);
        passwordField.setHint("رمز عبور (حداقل ۸ کاراکتر)");
        passwordField.setTextColor(NabzUi.TEXT);
        passwordField.setHintTextColor(NabzUi.TEXT_DIM);
        passwordField.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        passwordField.setMaxLines(1);
        root.addView(wrapField(passwordField, d), margin(d));

        root.addView(nameRow, margin(d));
        nameRow.setVisibility(registerMode ? View.VISIBLE : View.GONE);

        primaryButton = new Button(this);
        primaryButton.setText("ورود");
        primaryButton.setTextColor(Color.WHITE);
        primaryButton.setTextSize(16);
        primaryButton.setBackground(NabzUi.rounded(NabzUi.ACCENT, 12, this));
        primaryButton.setOnClickListener(v -> submit());
        root.addView(primaryButton, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, (int) (52 * d + 0.5f)));// margin below

        statusText = new TextView(this);
        statusText.setTextColor(NabzUi.TEXT_DIM);
        statusText.setTextSize(13);
        statusText.setGravity(Gravity.CENTER);
        statusText.setPadding(0, (int) (16 * d), 0, 0);
        root.addView(statusText, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        toggleButton = new TextView(this);
        toggleButton.setTextColor(NabzUi.ACCENT);
        toggleButton.setTextSize(14);
        toggleButton.setGravity(Gravity.CENTER);
        toggleButton.setPadding(0, (int) (20 * d), 0, 0);
        toggleButton.setOnClickListener(v -> setMode(!registerMode));
        root.addView(toggleButton, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        setMode(false);

        ScrollView scroller = new ScrollView(this);
        scroller.setFillViewport(true);
        scroller.addView(root);
        setContentView(scroller);
    }

    private LinearLayout wrapField(EditText field, float d) {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setBackground(NabzUi.rounded(NabzUi.BG_HEADER, 10, this));
        int pad = (int) (14 * d);
        box.setPadding(pad, pad / 2, pad, pad / 2);
        box.addView(field, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, (int) (44 * d + 0.5f)));
        return box;
    }

    private LinearLayout.LayoutParams margin(float d) {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = (int) (10 * d + 0.5f);
        return lp;
    }

    private void setMode(boolean register) {
        registerMode = register;
        nameRow.setVisibility(register ? View.VISIBLE : View.GONE);
        primaryButton.setText(register ? "ساخت حساب" : "ورود");
        toggleButton.setText(register ? "حساب دارید؟ وارد شوید" : "حساب ندارید؟ حساب بسازید");
        statusText.setText("");
    }

    private void submit() {
        if (busy) return;
        String username = usernameField.getText().toString().trim().toLowerCase();
        String password = passwordField.getText().toString();
        String displayName = nameField.getText().toString().trim();

        if (!USERNAME.matcher(username).matches()) {
            statusText.setText("نام کاربری باید ۳ تا ۳۲ حرف انگلیسی کوچک، عدد یا _ باشد");
            return;
        }
        if (password.length() < 8) {
            statusText.setText("رمز عبور باید حداقل ۸ کاراکتر باشد");
            return;
        }
        if (registerMode && TextUtils.isEmpty(displayName)) {
            statusText.setText("نام نمایشی را وارد کنید");
            return;
        }

        busy = true;
        statusText.setText(registerMode ? "در حال ساخت حساب…" : "در حال ورود…");
        primaryButton.setEnabled(false);

        AuthRepository auth = AuthRepository.get();
        if (registerMode) {
            auth.register(username, password, displayName, null, new AuthRepository.SessionCallback() {
                @Override public void onSession(app.nabz.model.NabzModels.User u, String a, String r) {
                    // registration returns no tokens: log in with the new credentials
                    loginNow(username, password);
                }
                @Override public void onError(NabzApiClient.ApiException error) {
                    fail(prettyError(error));
                }
            });
        } else {
            loginNow(username, password);
        }
    }

    private void loginNow(String username, String password) {
        String deviceUid = android.provider.Settings.Secure.getString(
                getContentResolver(), android.provider.Settings.Secure.ANDROID_ID);
        if (TextUtils.isEmpty(deviceUid)) deviceUid = "device-" + username;

        AuthRepository.get().login(username, password, deviceUid,
                android.os.Build.MODEL, new AuthRepository.SessionCallback() {
                    @Override public void onSession(app.nabz.model.NabzModels.User user, String access, String refresh) {
                        busy = false;
                        RealtimeClient.get().connect();
                        startActivity(new android.content.Intent(NabzAuthActivity.this, NabzMainActivity.class));
                        finish();
                    }
                    @Override public void onError(NabzApiClient.ApiException error) {
                        fail(prettyError(error));
                    }
                });
    }

    private String prettyError(NabzApiClient.ApiException error) {
        if (error == null) return "خطای ناشناخته";
        if ("NETWORK".equals(error.code)) return "اتصال به سرور ممکن نشد - اینترنت را بررسی کنید";
        if ("USERNAME_TAKEN".equals(error.code)) return "این نام کاربری قبلاً گرفته شده";
        if ("BAD_CREDENTIALS".equals(error.code)) return "نام کاربری یا رمز عبور اشتباه است";
        if ("RATE_LIMITED".equals(error.code)) return "تلاش بیش از حد - کمی صبر کنید";
        if ("VALIDATION_ERROR".equals(error.code) || "HTTP_400".equals(error.code)) {
            return "اطلاعات وارد شده معتبر نیست";
        }
        return error.getMessage() != null ? error.getMessage() : "خطا در انجام عملیات";
    }

    private void fail(String message) {
        busy = false;
        primaryButton.setEnabled(true);
        statusText.setText(message);
    }
}
