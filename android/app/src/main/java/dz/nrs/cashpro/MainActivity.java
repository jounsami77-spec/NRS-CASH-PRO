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

    // NRS_EMBEDDED_NODE_V1
    private native int startNodeWithArguments(String[] arguments);
    private static volatile boolean nrsNodeStarted = false;
    private static volatile boolean nrsNativeLoaded = false;

    private static final int CAMERA_REQUEST = 501;
    private PermissionRequest pendingCameraRequest;
    private boolean nrsPrintCacheRefreshDone = false;

    @Override
    public void onCreate(Bundle state) {
        super.onCreate(state);

        try {
            if (!nrsNativeLoaded) {
                System.loadLibrary("c++_shared");
                System.loadLibrary("node");
                System.loadLibrary("nrsnode");
                nrsNativeLoaded = true;
            }
        } catch (Throwable error) {
            android.util.Log.e("NRS_STARTUP",
                "Native library loading failed", error);

            TextView failure = new TextView(this);
            failure.setText(
                "تعذر تشغيل محرك التطبيق.\\n\\n" +
                "نوع الخطأ: " + error.getClass().getSimpleName() +
                "\\nالتفاصيل: " + String.valueOf(error.getMessage()) +
                "\\n\\nأرسل هذه الرسالة للدعم الفني."
            );
            failure.setTextSize(16);
            failure.setTextColor(Color.RED);
            failure.setPadding(24, 32, 24, 32);
            failure.setTextIsSelectable(true);
            setContentView(failure);
            return;
        }

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

        // NRS_WEBVIEW_SOFTWARE_RENDERING_TEST_V1
        // اختبار تشخيصي قابل للتراجع: العرض البرمجي بدل تسريع WebView.
        web.setLayerType(android.view.View.LAYER_TYPE_SOFTWARE, null);
        android.util.Log.i("NRS_STARTUP",
            "WebView software rendering test enabled");

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

        // NRS_PRINT_NO_CACHE_V1
        web.clearCache(true);
        WebSettings settings = web.getSettings();
        settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean onRenderProcessGone(
                    WebView view,
                    android.webkit.RenderProcessGoneDetail detail) {
                android.util.Log.e("NRS_WEBVIEW",
                    "Renderer process gone; didCrash=" +
                    detail.didCrash() + ", priority=" +
                    detail.rendererPriorityAtExit());

                runOnUiThread(() ->
                    android.widget.Toast.makeText(
                        MainActivity.this,
                        "تعطلت واجهة WebView. أغلق التطبيق وأرسل تقرير الأخطاء.",
                        android.widget.Toast.LENGTH_LONG
                    ).show()
                );
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);

                // NRS_PRINT_SERVICE_WORKER_REFRESH_V1
                // إزالة نسخة الواجهة القديمة من Service Worker مرة واحدة.
                if (!nrsPrintCacheRefreshDone) {
                    nrsPrintCacheRefreshDone = true;
                    view.evaluateJavascript(
                        "(function(){try{" +
                        "if(!navigator.serviceWorker||!navigator.serviceWorker.getRegistrations)" +
                        "return Promise.resolve('unsupported');" +
                        "return navigator.serviceWorker.getRegistrations().then(function(rs){" +
                        "return Promise.all(rs.map(function(r){return r.unregister();}));" +
                        "});" +
                        "}catch(e){return Promise.resolve('error');}})()",
                        result -> runOnUiThread(() -> {
                            view.clearCache(true);
                            view.loadUrl(
                                "http://127.0.0.1:3001/index.html?nrs_print_refresh=1"
                            );
                        })
                    );
                    return;
                }

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
        startEmbeddedServerAndLoad(web);
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

    private String nrsGetOrCreateInitialPassword() throws java.io.IOException {
        java.io.File f = new java.io.File(
            getNoBackupFilesDir(), "nrs-first-admin-password");
        if (f.isFile()) {
            return new String(java.nio.file.Files.readAllBytes(f.toPath()),
                              java.nio.charset.StandardCharsets.UTF_8).trim();
        }

        final String alphabet =
            "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
        java.security.SecureRandom random = new java.security.SecureRandom();
        StringBuilder b = new StringBuilder();
        for (int i=0; i<22; i++) b.append(alphabet.charAt(
            random.nextInt(alphabet.length())));
        String password = b.toString();

        try (java.io.FileOutputStream out = new java.io.FileOutputStream(f)) {
            out.write(password.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        }
        return password;
    }

    private void nrsCopyAssetTree(String assetPath, java.io.File dest)
            throws java.io.IOException {
        String[] children = getAssets().list(assetPath);
        if (children != null && children.length > 0) {
            if (!dest.exists() && !dest.mkdirs())
                throw new java.io.IOException("Cannot create " + dest);
            for (String child : children)
                nrsCopyAssetTree(assetPath + "/" + child,
                    new java.io.File(dest, child));
            return;
        }

        java.io.File parent = dest.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs())
            throw new java.io.IOException("Cannot create " + parent);

        try (java.io.InputStream in = getAssets().open(assetPath);
             java.io.FileOutputStream out = new java.io.FileOutputStream(dest)) {
            byte[] buffer = new byte[16384];
            int n;
            while ((n = in.read(buffer)) != -1) out.write(buffer, 0, n);
        }
    }

    private void nrsShowFirstCredentials(String password) {
        android.content.SharedPreferences prefs =
            getSharedPreferences("nrs_first_setup", MODE_PRIVATE);
        if (prefs.getBoolean("credentials_acknowledged", false)) return;

        new android.app.AlertDialog.Builder(this)
            .setTitle("إعداد حساب الإدارة")
            .setMessage("اسم المستخدم: admin\n\nكلمة المرور الأولية:\n"
                + password
                + "\n\nانسخ كلمة المرور واحفظها في مكان آمن. لن نعرضها مرة أخرى بعد نسخها.")
            .setCancelable(false)
            .setPositiveButton("نسخ كلمة المرور", (dialog, which) -> {
                android.content.ClipboardManager cm =
                    (android.content.ClipboardManager)
                    getSystemService(CLIPBOARD_SERVICE);
                if (cm != null) cm.setPrimaryClip(
                    android.content.ClipData.newPlainText(
                        "NRS initial admin password", password));
                prefs.edit().putBoolean("credentials_acknowledged", true).apply();
                new java.io.File(getNoBackupFilesDir(),
                    "nrs-first-admin-password").delete();
                android.widget.Toast.makeText(this,
                    "تم نسخ كلمة المرور", android.widget.Toast.LENGTH_LONG).show();
            })
            .show();
    }

    private void startEmbeddedServerAndLoad(final android.webkit.WebView target) {
        final java.io.File root = new java.io.File(getFilesDir(), "nrs-server");
        final java.io.File data = new java.io.File(getNoBackupFilesDir(), "data");
        final java.io.File tmp = getCacheDir();
        final java.io.File home = getFilesDir();

        final String password;
        try {
            nrsCopyAssetTree("nrs-server", root);
            password = nrsGetOrCreateInitialPassword();
            if (!new java.io.File(root, "server.js").isFile()
                    || !new java.io.File(root, "mobile-entry.js").isFile()) {
                throw new java.io.IOException("Server assets are incomplete");
            }
            if (!data.exists() && !data.mkdirs())
                throw new java.io.IOException("Cannot create private database folder");
        } catch (Exception e) {
            android.widget.Toast.makeText(this,
                "تعذر تجهيز الخادم المحلي: " + e.getMessage(),
                android.widget.Toast.LENGTH_LONG).show();
            return;
        }

        synchronized (MainActivity.class) {
            if (!nrsNodeStarted) {
                nrsNodeStarted = true;

                new Thread(() -> {
                    try {
                        android.util.Log.i("NRS_STARTUP",
                            "Starting embedded Node runtime");

                        int result = startNodeWithArguments(new String[] {
                            "node",
                            new java.io.File(root, "mobile-entry.js").getAbsolutePath(),
                            data.getAbsolutePath(),
                            tmp.getAbsolutePath(),
                            home.getAbsolutePath(),
                            root.getAbsolutePath(),
                            password
                        });

                        android.util.Log.e("NRS_STARTUP",
                            "Embedded Node returned: " + result);

                    } catch (Throwable error) {
                        android.util.Log.e("NRS_STARTUP",
                            "Embedded Node startup failed", error);

                    } finally {
                        synchronized (MainActivity.class) {
                            nrsNodeStarted = false;
                        }
                        android.util.Log.w("NRS_STARTUP",
                            "Embedded Node execution ended; restart is permitted");
                    }
                }, "NRS-Embedded-Node").start();
            }
        }

        new Thread(() -> {
            boolean ready = false;
            for (int i=0; i<60 && !ready; i++) {
                java.net.HttpURLConnection c = null;

                try {
                    c = (java.net.HttpURLConnection)
                        new java.net.URL("http://127.0.0.1:3001/api/status")
                            .openConnection();

                    c.setConnectTimeout(1200);
                    c.setReadTimeout(1200);
                    c.setUseCaches(false);

                    int responseCode = c.getResponseCode();
                    ready = responseCode == 200;

                    if (!ready) {
                        android.util.Log.w("NRS_STARTUP",
                            "Readiness attempt " + (i + 1) +
                            " returned HTTP " + responseCode);
                    }

                } catch (Exception error) {
                    android.util.Log.w("NRS_STARTUP",
                        "Readiness attempt " + (i + 1) +
                        " failed: " + error.getClass().getSimpleName());

                } finally {
                    if (c != null) c.disconnect();
                }

                if (!ready && i < 59) {
                    try {
                        Thread.sleep(1000);
                    } catch (InterruptedException error) {
                        Thread.currentThread().interrupt();
                        break;
                    }
                }
            }

            final boolean serverReady = ready;
            target.post(() -> {
                if (!serverReady) {
                    android.widget.Toast.makeText(this,
                        "الخادم المحلي لم يبدأ. لم يتم اعتبار التطبيق جاهزًا.",
                        android.widget.Toast.LENGTH_LONG).show();
                    return;
                }
                android.util.Log.i("NRS_STARTUP",
                    "Server ready; loading WebView before first-credentials dialog");
                target.loadUrl("http://127.0.0.1:3001/");

                // NRS_DELAY_FIRST_CREDENTIALS_DIAGNOSTIC_V1
                // اختبار: فصل نافذة الإعداد عن لحظة بدء تحميل WebView.
                target.postDelayed(() -> {
                    if (!isFinishing() && !isDestroyed()) {
                        nrsShowFirstCredentials(password);
                    }
                }, 3000);
            });
        }, "NRS-Server-Readiness").start();
    }

}
