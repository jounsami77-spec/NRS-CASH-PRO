package dz.nrs.cashpro;

import android.app.Activity;
import android.os.Bundle;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.graphics.Color;
import android.view.Gravity;

public class MainActivity extends Activity {
    @Override
    public void onCreate(Bundle state) {
        super.onCreate(state);

        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setBackgroundColor(Color.WHITE);

        TextView status = new TextView(this);
        status.setText("N.R.S. CASH PRO • Android");
        status.setTextSize(16);
        status.setTextColor(Color.WHITE);
        status.setBackgroundColor(Color.rgb(16, 88, 62));
        status.setPadding(16, 14, 16, 14);
        status.setGravity(Gravity.CENTER_VERTICAL);
        layout.addView(status);

        WebView web = new WebView(this);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        web.setWebViewClient(new WebViewClient());
        web.setWebChromeClient(new WebChromeClient());
        layout.addView(web, new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, 0, 1
        ));

        setContentView(layout);
        web.loadUrl("http://127.0.0.1:3001/");
    }

    @Override
    public void onBackPressed() {
        super.onBackPressed();
    }
}
