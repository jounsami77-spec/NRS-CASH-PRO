package dz.nrs.cashpro;

import android.Manifest;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.PermissionRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.graphics.Color;
import android.view.Gravity;

public class MainActivity extends Activity {
    private static final int CAMERA_REQUEST = 501;
    private PermissionRequest pendingCameraRequest;

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

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> {
                    Uri origin = request.getOrigin();
                    String host = origin == null ? "" : origin.getHost();
                    int port = origin == null ? -1 : origin.getPort();

                    // لا نمنح الكاميرا إلا لواجهة التطبيق المحلية المتوقعة.
                    if (!"127.0.0.1".equals(host) ||
                        (port != 3001 && port != -1)) {
                        request.deny();
                        return;
                    }

                    boolean wantsCamera = false;
                    for (String resource : request.getResources()) {
                        if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) {
                            wantsCamera = true;
                        }
                    }

                    if (!wantsCamera) {
                        request.deny();
                        return;
                    }

                    if (checkSelfPermission(Manifest.permission.CAMERA)
                            == PackageManager.PERMISSION_GRANTED) {
                        request.grant(new String[] {
                            PermissionRequest.RESOURCE_VIDEO_CAPTURE
                        });
                    } else {
                        if (pendingCameraRequest != null) {
                            pendingCameraRequest.deny();
                        }
                        pendingCameraRequest = request;
                        requestPermissions(
                            new String[] { Manifest.permission.CAMERA },
                            CAMERA_REQUEST
                        );
                    }
                });
            }
        });

        layout.addView(web, new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, 0, 1
        ));

        setContentView(layout);
        web.loadUrl("http://127.0.0.1:3001/");
    }

    @Override
    public void onRequestPermissionsResult(
            int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);

        if (requestCode == CAMERA_REQUEST && pendingCameraRequest != null) {
            PermissionRequest request = pendingCameraRequest;
            pendingCameraRequest = null;

            if (grantResults.length > 0 &&
                grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                request.grant(new String[] {
                    PermissionRequest.RESOURCE_VIDEO_CAPTURE
                });
            } else {
                request.deny();
            }
        }
    }

    @Override
    protected void onDestroy() {
        if (pendingCameraRequest != null) {
            pendingCameraRequest.deny();
            pendingCameraRequest = null;
        }
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        super.onBackPressed();
    }
}
