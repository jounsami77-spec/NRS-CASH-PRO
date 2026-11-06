package dz.nrs.cashpro;

import android.Manifest;
import android.app.Activity;
import android.print.PrintDocumentAdapter;
import android.print.PrintAttributes;
import android.print.PrintManager;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
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
        status.setText("cash.pro.S.M.G.R • Android");
        status.setTextSize(16);
        status.setTextColor(Color.WHITE);
        status.setBackgroundColor(Color.rgb(16, 88, 62));
        status.setPadding(16, 14, 16, 14);
        status.setGravity(Gravity.CENTER_VERTICAL);
        layout.addView(status);

// NRS_GITHUB_UPDATE_BUTTON_V1
Button updateButton = new Button(this);
updateButton.setText("فحص التحديث");
updateButton.setAllCaps(false);
updateButton.setTextSize(14);
updateButton.setTextColor(Color.WHITE);
updateButton.setBackgroundTintList(
    android.content.res.ColorStateList.valueOf(Color.rgb(31, 93, 145))
);
layout.addView(updateButton, new LinearLayout.LayoutParams(
    LinearLayout.LayoutParams.MATCH_PARENT,
    LinearLayout.LayoutParams.WRAP_CONTENT
));
updateButton.setOnClickListener(v -> nrsCheckForUpdate(updateButton));

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

        // NRS_WEBVIEW_HARDWARE_RENDERING_V1
        // استخدام تسريع Android العتادي لتحسين WebView والكاميرا.
        web.setLayerType(android.view.View.LAYER_TYPE_HARDWARE, null);
        android.util.Log.i("NRS_STARTUP",
            "WebView hardware rendering enabled");

storeHomeButton.setOnClickListener(v ->
    web.loadUrl("http://127.0.0.1:3001/index.html")
);

        // NRS_NATIVE_PRINT_BRIDGE_V3
        web.addJavascriptInterface(new Object() {

            // NRS_PRINT_JOB_MONITOR_V1
            private void notifyPagePrintFinished(boolean success) {
                try {
                    web.evaluateJavascript(
                        "if(window.NRSAndroidPrintFinished){" +
                        "window.NRSAndroidPrintFinished(" +
                        (success ? "true" : "false") +
                        ");}",
                        null
                    );
                } catch (Throwable error) {
                    android.util.Log.e("NRS_PRINT",
                        "Unable to notify WebView about print completion",
                        error);
                }
            }

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
                            notifyPagePrintFinished(false);
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
                                    notifyPagePrintFinished(false);
                                    return;
                                }

                                PrintDocumentAdapter adapter =
                                    web.createPrintDocumentAdapter(
                                        "cash-pro-S-M-G-R-Receipt"
                                    );

                                if (adapter == null) {
                                    android.util.Log.e("NRS_PRINT",
                                        "WebView print adapter is null");
                                    Toast.makeText(MainActivity.this,
                                        "تعذر إنشاء مستند الطباعة",
                                        Toast.LENGTH_LONG).show();
                                    notifyPagePrintFinished(false);
                                    return;
                                }

                                PrintAttributes attributes =
                                    new PrintAttributes.Builder()
                                        .setMediaSize(
                                            PrintAttributes.MediaSize.ISO_A4)
                                        .build();

                                android.print.PrintJob job = manager.print(
                                    "cash.pro.S.M.G.R - Invoice",
                                    adapter,
                                    attributes
                                );

                                if (job == null) {
                                    android.util.Log.e("NRS_PRINT",
                                        "PrintManager.print returned null");
                                    Toast.makeText(MainActivity.this,
                                        "لم ينشئ Android مهمة الطباعة",
                                        Toast.LENGTH_LONG).show();
                                    notifyPagePrintFinished(false);
                                    return;
                                }

                                android.util.Log.i("NRS_PRINT",
                                    "Print job created: " + job.getId());

                                // NRS_PRINT_JOB_MONITOR_V1
                                final android.print.PrintJob monitoredJob = job;
                                final Handler printHandler =
                                    new Handler(Looper.getMainLooper());

                                final Runnable[] printMonitor =
                                    new Runnable[1];

                                printMonitor[0] = new Runnable() {
                                    @Override
                                    public void run() {
                                        try {
                                            if (monitoredJob.isCompleted()) {
                                                android.util.Log.i("NRS_PRINT",
                                                    "Print job completed: " +
                                                    monitoredJob.getId());
                                                notifyPagePrintFinished(true);
                                                return;
                                            }

                                            if (monitoredJob.isCancelled()) {
                                                android.util.Log.i("NRS_PRINT",
                                                    "Print job cancelled: " +
                                                    monitoredJob.getId());
                                                notifyPagePrintFinished(false);
                                                return;
                                            }

                                            if (monitoredJob.isFailed()) {
                                                android.util.Log.e("NRS_PRINT",
                                                    "Print job failed: " +
                                                    monitoredJob.getId());
                                                notifyPagePrintFinished(false);
                                                return;
                                            }

                                            printHandler.postDelayed(this, 500);

                                        } catch (Throwable monitorError) {
                                            android.util.Log.e("NRS_PRINT",
                                                "Print job monitoring failed",
                                                monitorError);
                                            notifyPagePrintFinished(false);
                                        }
                                    }
                                };

                                printHandler.postDelayed(printMonitor[0], 500);

                                Toast.makeText(MainActivity.this,
                                    "أنشأ Android مهمة الطباعة. ستبقى الملصقات جاهزة حتى انتهاء المهمة.",
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
                                notifyPagePrintFinished(false);
                            }
                        }, 1000);

                    } catch (Throwable e) {
                        android.util.Log.e("NRS_PRINT",
                            "Print bridge failed", e);
                        Toast.makeText(MainActivity.this,
                            "فشل جسر الطباعة: " +
                                e.getClass().getSimpleName(),
                            Toast.LENGTH_LONG).show();
                        notifyPagePrintFinished(false);
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


    // NRS_GITHUB_UPDATER_IMPLEMENTATION_V1
    private void nrsCheckForUpdate(final Button button) {
        if (!"dz.nrs.cashpro".equals(BuildConfig.APPLICATION_ID)) {
            Toast.makeText(this,
                "التحديث الرسمي مخصص لنسخة المالك الرسمية.",
                Toast.LENGTH_LONG).show();
            return;
        }

        button.setEnabled(false);
        button.setText("جارٍ فحص التحديث...");

        new Thread(() -> {
            java.io.File downloaded = null;

            try {
                final String api =
                    "https://api.github.com/repos/jounsami77-spec/"
                    + "NRS-CASH-PRO/releases/latest";

                java.net.HttpURLConnection apiConnection = null;
                org.json.JSONObject release;

                try {
                    apiConnection = (java.net.HttpURLConnection)
                        new java.net.URL(api).openConnection();
                    apiConnection.setRequestMethod("GET");
                    apiConnection.setConnectTimeout(15000);
                    apiConnection.setReadTimeout(20000);
                    apiConnection.setUseCaches(false);
                    apiConnection.setInstanceFollowRedirects(true);
                    apiConnection.setRequestProperty(
                        "Accept", "application/vnd.github+json");
                    apiConnection.setRequestProperty(
                        "User-Agent", "cash-pro-S-M-G-R-Android-Updater");

                    int code = apiConnection.getResponseCode();
                    if (code != 200) {
                        throw new java.io.IOException(
                            "GitHub API HTTP " + code);
                    }

                    java.io.ByteArrayOutputStream jsonBytes =
                        new java.io.ByteArrayOutputStream();
                    try (java.io.InputStream in =
                             apiConnection.getInputStream()) {
                        byte[] buffer = new byte[8192];
                        int count;
                        int total = 0;
                        while ((count = in.read(buffer)) != -1) {
                            total += count;
                            if (total > 2 * 1024 * 1024) {
                                throw new java.io.IOException(
                                    "Release metadata is too large");
                            }
                            jsonBytes.write(buffer, 0, count);
                        }
                    }

                    release = new org.json.JSONObject(
                        jsonBytes.toString("UTF-8"));
                } finally {
                    if (apiConnection != null) {
                        apiConnection.disconnect();
                    }
                }

                if (release.optBoolean("draft", true)
                        || release.optBoolean("prerelease", true)) {
                    throw new java.io.IOException(
                        "Latest GitHub release is not a stable release");
                }

                String tag = release.optString("tag_name", "");
                if (!tag.matches("v[0-9]+\\.[0-9]+\\.[0-9]+")) {
                    throw new java.io.IOException(
                        "Invalid release tag");
                }

                String version = tag.substring(1);
                String expectedName =
                    "cash.pro.S.M.G.R-" + version + ".apk";

                org.json.JSONArray assets =
                    release.optJSONArray("assets");

                if (assets == null) {
                    throw new java.io.IOException(
                        "Release has no APK assets");
                }

                String assetUrl = null;
                String expectedDigest = null;

                for (int i = 0; i < assets.length(); i++) {
                    org.json.JSONObject asset = assets.getJSONObject(i);
                    if (!expectedName.equals(
                            asset.optString("name", ""))) {
                        continue;
                    }

                    assetUrl = asset.optString("browser_download_url", "");
                    expectedDigest = asset.optString("digest", "");
                    break;
                }

                if (assetUrl == null || assetUrl.isEmpty()) {
                    throw new java.io.IOException(
                        "Official owner APK was not found");
                }

                if (!assetUrl.startsWith(
                        "https://github.com/jounsami77-spec/"
                        + "NRS-CASH-PRO/releases/download/")) {
                    throw new java.io.IOException(
                        "APK download URL is not trusted");
                }

                if (expectedDigest == null
                        || !expectedDigest.matches("sha256:[0-9a-fA-F]{64}")) {
                    throw new java.io.IOException(
                        "GitHub release does not provide a valid SHA-256 digest");
                }

                String digestHex = expectedDigest.substring(7)
                    .toLowerCase(java.util.Locale.ROOT);

                java.io.File updateDir =
                    new java.io.File(getCacheDir(), "updates");

                if (!updateDir.exists() && !updateDir.mkdirs()) {
                    throw new java.io.IOException(
                        "Cannot create update cache");
                }

                downloaded = new java.io.File(
                    updateDir, expectedName + ".download");

                java.net.HttpURLConnection apkConnection = null;
                java.security.MessageDigest sha =
                    java.security.MessageDigest.getInstance("SHA-256");

                try {
                    apkConnection = (java.net.HttpURLConnection)
                        new java.net.URL(assetUrl).openConnection();
                    apkConnection.setRequestMethod("GET");
                    apkConnection.setConnectTimeout(20000);
                    apkConnection.setReadTimeout(90000);
                    apkConnection.setUseCaches(false);
                    apkConnection.setInstanceFollowRedirects(true);
                    apkConnection.setRequestProperty(
                        "User-Agent", "cash-pro-S-M-G-R-Android-Updater");

                    int code = apkConnection.getResponseCode();
                    if (code != 200) {
                        throw new java.io.IOException(
                            "APK download HTTP " + code);
                    }

                    if (apkConnection.getURL() == null
                            || !"https".equalsIgnoreCase(
                                apkConnection.getURL().getProtocol())) {
                        throw new java.io.IOException(
                            "APK download did not remain on HTTPS");
                    }

                    long total = 0;
                    try (java.io.InputStream in =
                             apkConnection.getInputStream();
                         java.io.FileOutputStream out =
                             new java.io.FileOutputStream(downloaded)) {
                        byte[] buffer = new byte[16384];
                        int count;
                        while ((count = in.read(buffer)) != -1) {
                            total += count;
                            if (total > 250L * 1024L * 1024L) {
                                throw new java.io.IOException(
                                    "APK exceeds maximum allowed size");
                            }
                            sha.update(buffer, 0, count);
                            out.write(buffer, 0, count);
                        }
                        out.getFD().sync();
                    }
                } finally {
                    if (apkConnection != null) {
                        apkConnection.disconnect();
                    }
                }

                byte[] actualHash = sha.digest();
                byte[] expectedHash = new byte[32];
                for (int i = 0; i < expectedHash.length; i++) {
                    expectedHash[i] = (byte) Integer.parseInt(
                        digestHex.substring(i * 2, i * 2 + 2), 16);
                }

                if (!java.security.MessageDigest.isEqual(
                        actualHash, expectedHash)) {
                    throw new java.io.IOException(
                        "APK SHA-256 verification failed");
                }

                android.content.pm.PackageInfo archive =
                    getPackageManager().getPackageArchiveInfo(
                        downloaded.getAbsolutePath(), 0);

                if (archive == null || archive.applicationInfo == null) {
                    throw new java.io.IOException(
                        "Downloaded file is not a valid Android APK");
                }

                if (!"dz.nrs.cashpro".equals(archive.packageName)) {
                    throw new java.io.IOException(
                        "APK package ID does not match this application");
                }

                if (archive.versionCode <= BuildConfig.VERSION_CODE) {
                    downloaded.delete();
                    runOnUiThread(() -> {
                        button.setEnabled(true);
                        button.setText("فحص التحديث");
                        Toast.makeText(this,
                            "أنت تستخدم أحدث إصدار متاح.",
                            Toast.LENGTH_LONG).show();
                    });
                    return;
                }

                java.io.File finalApk = new java.io.File(
                    updateDir, expectedName);

                if (finalApk.exists() && !finalApk.delete()) {
                    throw new java.io.IOException(
                        "Cannot replace cached update");
                }

                if (!downloaded.renameTo(finalApk)) {
                    throw new java.io.IOException(
                        "Cannot finalize downloaded APK");
                }

                downloaded = finalApk;

                final java.io.File verifiedApk = finalApk;
                runOnUiThread(() -> {
                    try {
                        if (Build.VERSION.SDK_INT >= 26
                                && !getPackageManager()
                                    .canRequestPackageInstalls()) {
                            Intent settingsIntent = new Intent(
                                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                                Uri.parse("package:" + getPackageName())
                            );
                            startActivity(settingsIntent);
                            Toast.makeText(this,
                                "اسمح بتثبيت تحديثات هذا التطبيق، ثم اضغط فحص التحديث مرة أخرى.",
                                Toast.LENGTH_LONG).show();
                            return;
                        }

                        Uri apkUri = FileProvider.getUriForFile(
                            this,
                            getPackageName() + ".fileprovider",
                            verifiedApk
                        );

                        Intent install = new Intent(Intent.ACTION_VIEW);
                        install.setDataAndType(
                            apkUri, "application/vnd.android.package-archive");
                        install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        install.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        startActivity(install);

                        Toast.makeText(this,
                            "تم التحقق من الملف. أكمل التحديث من مثبت Android.",
                            Toast.LENGTH_LONG).show();

                    } catch (Throwable error) {
                        android.util.Log.e("NRS_UPDATER",
                            "Unable to open Android installer", error);
                        Toast.makeText(this,
                            "تعذر فتح مثبت Android: "
                                + error.getClass().getSimpleName(),
                            Toast.LENGTH_LONG).show();
                    } finally {
                        button.setEnabled(true);
                        button.setText("فحص التحديث");
                    }
                });

            } catch (Throwable error) {
                android.util.Log.e("NRS_UPDATER",
                    "Update check failed", error);

                if (downloaded != null && downloaded.getName().endsWith(
                        ".download")) {
                    // Delete only this updater's incomplete temporary file.
                    downloaded.delete();
                }

                final String message =
                    error.getMessage() == null
                    ? error.getClass().getSimpleName()
                    : error.getMessage();

                runOnUiThread(() -> {
                    button.setEnabled(true);
                    button.setText("إعادة فحص التحديث");
                    Toast.makeText(this,
                        "لم يكتمل التحديث: " + message,
                        Toast.LENGTH_LONG).show();
                });
            }
        }, "NRS-Official-Updater").start();
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

        final String edition = BuildConfig.NRS_APP_EDITION;
        final String password;
        try {
            nrsCopyAssetTree("nrs-server", root);
            password = "owner".equals(edition)
                ? nrsGetOrCreateInitialPassword() : "";
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
                            password,
                            edition
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
                        if ("owner".equals(edition)) {
                            nrsShowFirstCredentials(password);
                        }
                    }
                }, 3000);
            });
        }, "NRS-Server-Readiness").start();
    }

}
