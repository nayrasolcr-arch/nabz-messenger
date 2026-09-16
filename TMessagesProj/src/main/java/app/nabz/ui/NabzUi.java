package app.nabz.ui;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.GradientDrawable;
import android.view.View;
import android.widget.Toast;

/**
 * Minimal shared UI helpers for the Nabz shell (framework-only, no androidx).
 * Palette follows a Telegram-like dark scheme so the shell feels familiar
 * while remaining a distinct, Nabz-branded experience.
 */
public final class NabzUi {

    public static final int BG = 0xFF0E1621;         // window background
    public static final int BG_HEADER = 0xFF17212B;  // header / input bars
    public static final int BG_ROW_PRESSED = 0xFF202B36;
    public static final int BUBBLE_OUT = 0xFF2B5278; // my messages
    public static final int BUBBLE_IN = 0xFF182533;  // their messages
    public static final int ACCENT = 0xFF64B5EF;
    public static final int TEXT = 0xFFFFFFFF;
    public static final int TEXT_DIM = 0xFF8FA6BD;
    public static final int ONLINE = 0xFF4DCD5E;

    private NabzUi() {}

    public static float density(View v) {
        return v.getResources().getDisplayMetrics().density;
    }

    public static int dp(float value, View v) {
        return (int) (value * density(v) + 0.5f);
    }

    public static int dp(float value, Activity a) {
        return (int) (value * a.getResources().getDisplayMetrics().density + 0.5f);
    }

    /** Rounded rectangle used for bubbles and chips. */
    public static GradientDrawable rounded(int color, float radiusDp, View v) {
        GradientDrawable d = new GradientDrawable();
        d.setColor(color);
        d.setCornerRadius(radiusDp * density(v));
        return d;
    }

    public static GradientDrawable rounded(int color, float radiusDp, Activity a) {
        GradientDrawable d = new GradientDrawable();
        d.setColor(color);
        d.setCornerRadius(radiusDp * a.getResources().getDisplayMetrics().density);
        return d;
    }

    public static void applyWindowBackground(Activity a) {
        a.getWindow().setBackgroundDrawable(new ColorDrawable(BG));
        a.getWindow().setStatusBarColor(BG_HEADER);
        a.getWindow().setNavigationBarColor(BG_HEADER);
    }

    public static void toast(Activity a, String msg) {
        if (a == null || a.isFinishing()) return;
        try {
            Toast toast = Toast.makeText(a, msg, Toast.LENGTH_SHORT);
            toast.show();
        } catch (Exception ignored) {}
    }

    /** Circle avatar with the first letter of a display name. */
    public static GradientDrawable avatarDrawable(int color) {
        GradientDrawable d = new GradientDrawable();
        d.setColor(color);
        d.setShape(GradientDrawable.OVAL);
        return d;
    }

    public static int avatarColor(String seed) {
        int[] palette = {
                0xFFE17076, 0xFF7BC862, 0xFF65AADD, 0xFFA695E7, 0xFFEE7AAE,
                0xFF6EC9CB, 0xFFFAA774, 0xFF9EE196
        };
        if (seed == null || seed.isEmpty()) return palette[0];
        return palette[Math.abs(seed.hashCode()) % palette.length];
    }

    public static int withAlpha(int color, float alpha) {
        return Color.argb((int) (alpha * 255), Color.red(color), Color.green(color), Color.blue(color));
    }
}
