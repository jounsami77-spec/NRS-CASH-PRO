package dz.nrs.cashpro;

import android.Manifest;
import android.app.Activity;
import android.print.PrintDocumentAdapter;
import android.print.PrintAttributes;
import android.print.PrintManager;
import android.content.Context;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.PermissionRequest;
import android.webkit.WebView;
import android.webkit.JavascriptInterface;
import android.webkit.WebViewClient;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;
import android.widget.Button;
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

// NRS_NATIVE_STORE_RETURN_BUTTON_V1
Button storeHomeButton = new Button(this);
storeHomeButton.setVisibility(android.view.View.GONE);
storeHomeButton.setText("← العودة إلى واجهة المتاجر");
storeHomeButton.setAllCaps(false);
storeHomeButton.setTextSize(15);
storeHomeButton.setTextColor(Color.WHITE);
storeHomeButton.setBackgroundTintList(
    android.content.res.ColorStateList.valueOf(Color.rgb(16, 108, 67))
);
layout.addView(storeHomeButton, new LinearLayout.LayoutParams(
    LinearLayout.LayoutParams.MATCH_PARENT,
    LinearLayout.LayoutParams.WRAP_CONTENT
));

        WebView web = new WebView(this);

storeHomeButton.setOnClickListener(v ->
    web.loadUrl("http://127.0.0.1:3001/index.html")
);

        // NRS_NATIVE_PRINT_BRIDGE_V3
        web.addJavascriptInterface(new Object() {
            @JavascriptInterface
            public void printPage() {
                runOnUiThread(() -> {
                    try {
                        Uri current = Uri.parse(
                            web.getUrl() == null ? "" : web.getUrl()
                        );

                        if (!"127.0.0.1".equals(current.getHost()) ||
                            current.getPort() != 3001) {
                            Toast.makeText(MainActivity.this,
                                "تعذرت الطباعة: عنوان التطبيق المحلي غير صحيح",
                                Toast.LENGTH_LONG).show();
                            return;
                        }

                        Toast.makeText(MainActivity.this,
                            "وصل طلب الطباعة؛ جارٍ الاتصال بخدمة Android...",
                            Toast.LENGTH_SHORT).show();

                        web.postDelayed(() -> {
                            try {
                                PrintManager manager = (PrintManager)
                                    getSystemService(Context.PRINT_SERVICE);

                                if (manager == null) {
                                    android.util.Log.e("NRS_PRINT",
                                        "PrintManager service is null");
                                    Toast.makeText(MainActivity.this,
                                        "خدمة الطباعة غير متاحة على الهاتف",
                                        Toast.LENGTH_LONG).show();
                                    return;
                                }

                                PrintDocumentAdapter adapter =
                                    web.createPrintDocumentAdapter(
                                        "NRS-CASH-PRO-Receipt"
                                    );

                                if (adapter == null) {
                                    android.util.Log.e("NRS_PRINT",
                                        "WebView print adapter is null");
                                    Toast.makeText(MainActivity.this,
                                        "تعذر إنشاء مستند الفاتورة",
                                        Toast.LENGTH_LONG).show();
                                    return;
                                }

                                PrintAttributes attributes =
                                    new PrintAttributes.Builder()
                                        .setMediaSize(
                                            PrintAttributes.MediaSize.ISO_A4)
                                        .build();

                                android.print.PrintJob job = manager.print(
                                    "N.R.S. CASH PRO - Invoice",
                                    adapter,
                                    attributes
                                );

                                if (job == null) {
                                    android.util.Log.e("NRS_PRINT",
                                        "PrintManager.print returned null");
                                    Toast.makeText(MainActivity.this,
                                        "لم ينشئ Android مهمة الطباعة",
                                        Toast.LENGTH_LONG).show();
                                    return;
                                }

                                android.util.Log.i("NRS_PRINT",
                                    "Print job created: " + job.getId());

                                Toast.makeText(MainActivity.this,
                                    "أنشأ Android مهمة الطباعة. إذا لم تظهر المعاينة، افحص خدمة الطباعة بالنظام.",
                                    Toast.LENGTH_LONG).show();

                            } catch (Throwable e) {
                                android.util.Log.e("NRS_PRINT",
                                    "PrintManager.print failed", e);
                                String detail = e.getMessage();
                                if (detail == null || detail.trim().isEmpty()) {
                                    detail = e.getClass().getSimpleName();
                                }
                                Toast.makeText(MainActivity.this,
                                    "فشل PrintManager: " + detail,
                                    Toast.LENGTH_LONG).show();
                            }
                        }, 1000);

                    } catch (Throwable e) {
                        android.util.Log.e("NRS_PRINT",
                            "Print bridge failed", e);
                        Toast.makeText(MainActivity.this,
                            "فشل جسر الطباعة: " +
                                e.getClass().getSimpleName(),
                            Toast.LENGTH_LONG).show();
                    }
                });
            }
        }, "AndroidPrinter");

        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                view.evaluateJavascript(
                    "(function() {" +
                    "var path = location.pathname;" +
                    "var adminPage = (path === '/admin' || path === '/admin.html');" +
                    "var hasPassword = !!document.querySelector('input[type=password]');" +
                    "return adminPage && hasPassword;" +
                    "})()",
                    result -> runOnUiThread(() -> {
                        boolean show = "true".equals(result);
                        storeHomeButton.setVisibility(
                            show ? android.view.View.VISIBLE : android.view.View.GONE
                        );
                    })
                );
            }
        });

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
