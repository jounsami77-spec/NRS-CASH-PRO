package dz.nrs.cashpro.nativeapp;

import android.app.Activity;
import android.app.AlertDialog;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.inputmethod.InputMethodManager;
import android.content.Context;
import android.text.InputType;
import android.widget.*;

import android.database.Cursor;

import java.util.LinkedHashMap;
import java.util.Locale;

public class MainActivity extends Activity {

    private Database db;
    private LinearLayout root;

    private long userId = -1;
    private long storeId = -1;

    private final LinkedHashMap<Long, Double> cart =
        new LinkedHashMap<>();

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);

        getWindow().getDecorView().setLayoutDirection(
            View.LAYOUT_DIRECTION_RTL);

        db = new Database(this);

        if (db.hasUsers()) {
            showLogin();
        } else {
            showSetup();
        }
    }

    private void base(String title) {
        ScrollView scroll = new ScrollView(this);

        root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(22, 24, 22, 24);
        root.setLayoutDirection(View.LAYOUT_DIRECTION_RTL);

        scroll.addView(root);
        setContentView(scroll);

        TextView heading = new TextView(this);
        heading.setText(title);
        heading.setTextSize(25);
        heading.setGravity(Gravity.CENTER);
        heading.setPadding(8, 12, 8, 24);
        heading.setTextColor(0xff105b38);

        root.addView(heading);
    }

    private EditText field(String hint, int type) {
        EditText e = new EditText(this);
        e.setHint(hint);
        e.setInputType(type);
        e.setSingleLine(true);
        e.setTextSize(16);
        e.setPadding(12, 8, 12, 8);
        root.addView(e);
        return e;
    }

    private void button(String label, Runnable action) {
        Button b = new Button(this);
        b.setText(label);
        b.setAllCaps(false);
        b.setTextSize(16);
        b.setOnClickListener(v -> action.run());
        root.addView(b);
    }

    private void message(String text) {
        new AlertDialog.Builder(this)
            .setMessage(text)
            .setPositiveButton("حسناً", null)
            .show();
    }

    private void hideKeyboard(View view) {
        try {
            InputMethodManager imm =
                (InputMethodManager) getSystemService(
                    Context.INPUT_METHOD_SERVICE);
            imm.hideSoftInputFromWindow(view.getWindowToken(), 0);
        } catch (Exception ignored) {}
    }

    private double number(EditText e, String label) {
        String value = e.getText().toString().trim()
            .replace(',', '.');

        if (value.isEmpty()) {
            throw new IllegalArgumentException(
                "أدخل " + label);
        }

        double result = Double.parseDouble(value);

        if (!Double.isFinite(result)) {
            throw new IllegalArgumentException(
                "قيمة غير صحيحة: " + label);
        }

        return result;
    }

    private void showSetup() {
        base("N.R.S. CASH PRO");

        TextView info = new TextView(this);
        info.setText(
            "إنشاء محل جديد وقاعدة بيانات فارغة.\n" +
            "لن يتم استيراد أي منتج أو سعر قديم."
        );
        info.setTextSize(16);
        root.addView(info);

        EditText shop = field("اسم المحل", InputType.TYPE_CLASS_TEXT);
        EditText username = field(
            "اسم المستخدم", InputType.TYPE_CLASS_TEXT);

        EditText password = field(
            "كلمة المرور - 8 أحرف على الأقل",
            InputType.TYPE_CLASS_TEXT |
            InputType.TYPE_TEXT_VARIATION_PASSWORD
        );

        button("إنشاء المحل والحساب", () -> {
            try {
                String n = shop.getText().toString().trim();
                String u = username.getText().toString().trim();
                String p = password.getText().toString();

                if (n.length() < 2 || u.length() < 3 || p.length() < 8) {
                    message("تحقق من اسم المحل والمستخدم وكلمة المرور");
                    return;
                }

                storeId = db.createLocalStore(n, u, p);
                userId = db.login(u, p);

                showDashboard();

            } catch (Exception e) {
                message("تعذر إنشاء الحساب: " + e.getMessage());
            }
        });
    }

    private void showLogin() {
        base("تسجيل الدخول");

        EditText username = field(
            "اسم المستخدم", InputType.TYPE_CLASS_TEXT);

        EditText password = field(
            "كلمة المرور",
            InputType.TYPE_CLASS_TEXT |
            InputType.TYPE_TEXT_VARIATION_PASSWORD
        );

        button("دخول", () -> {
            long id = db.login(
                username.getText().toString().trim(),
                password.getText().toString()
            );

            if (id < 1) {
                message("اسم المستخدم أو كلمة المرور غير صحيحة");
                return;
            }

            userId = id;
            storeId = db.storeForUser(id);

            if (storeId < 1) {
                message("الحساب غير مرتبط بمحل");
                return;
            }

            showDashboard();
        });
    }

    private void showDashboard() {
        base("N.R.S. CASH PRO");

        button("إضافة منتج جديد", this::addProduct);
        button("المنتجات والأسعار والمخزون", this::showProducts);
        button("بدء عملية بيع", this::showProductsForSale);
        button("السلة وإتمام البيع", this::showCart);
        button("سجل الفواتير", this::showSales);
        button("ملخص المبيعات", () ->
            message(db.dailySummary(storeId)));

        button("إغلاق الفترة الحالية", () ->
            new AlertDialog.Builder(this)
                .setTitle("تأكيد الإغلاق")
                .setMessage(
                    "سيتم حفظ تقرير للفواتير الجديدة فقط. " +
                    "لن يتم حذف أي فاتورة.")
                .setNegativeButton("إلغاء", null)
                .setPositiveButton("تأكيد", (d, w) -> {
                    try {
                        db.closeDay(storeId);
                        message("تم حفظ تقرير الإغلاق بنجاح");
                    } catch (Exception e) {
                        message(e.getMessage());
                    }
                })
                .show()
        );

        button("تسجيل الخروج", () -> {
            userId = -1;
            storeId = -1;
            cart.clear();
            showLogin();
        });
    }

    private void addProduct() {
        base("إضافة منتج جديد");

        EditText name = field(
            "اسم المنتج", InputType.TYPE_CLASS_TEXT);

        EditText barcode = field(
            "الباركود - اختياري", InputType.TYPE_CLASS_TEXT);

        EditText price = field(
            "سعر البيع بالدينار",
            InputType.TYPE_CLASS_NUMBER |
            InputType.TYPE_NUMBER_FLAG_DECIMAL
        );

        EditText purchase = field(
            "سعر الشراء بالدينار",
            InputType.TYPE_CLASS_NUMBER |
            InputType.TYPE_NUMBER_FLAG_DECIMAL
        );

        EditText stock = field(
            "الكمية في المخزون",
            InputType.TYPE_CLASS_NUMBER |
            InputType.TYPE_NUMBER_FLAG_DECIMAL
        );

        EditText unit = field(
            "الوحدة: piece أو kg أو liter",
            InputType.TYPE_CLASS_TEXT);

        EditText category = field(
            "التصنيف", InputType.TYPE_CLASS_TEXT);

        button("حفظ المنتج", () -> {
            try {
                String n = name.getText().toString().trim();

                if (n.isEmpty()) {
                    throw new IllegalArgumentException(
                        "اسم المنتج مطلوب");
                }

                double p = number(price, "سعر البيع");
                double pp = number(purchase, "سعر الشراء");
                double s = number(stock, "المخزون");

                String u = unit.getText().toString().trim();
                String cat = category.getText().toString().trim();

                if (u.isEmpty()) u = "piece";
                if (cat.isEmpty()) cat = "عام";

                db.addProduct(
                    storeId, n,
                    barcode.getText().toString(),
                    p, pp, s, u, cat
                );

                message("تم حفظ المنتج بنجاح");
                showProducts();

            } catch (Exception e) {
                message("تعذر الحفظ: " + e.getMessage());
            }
        });

        button("رجوع", this::showDashboard);
    }

    private void showProducts() {
        base("المنتجات والأسعار");

        try (Cursor c = db.products(storeId)) {
            if (c.getCount() == 0) {
                TextView empty = new TextView(this);
                empty.setText("لا توجد منتجات. أضف أول منتج.");
                empty.setTextSize(17);
                root.addView(empty);
            }

            while (c.moveToNext()) {
                long id = c.getLong(0);
                String name = c.getString(1);
                String barcode = c.getString(2);
                double price = c.getDouble(3);
                double purchase = c.getDouble(4);
                double stock = c.getDouble(5);
                String unit = c.getString(6);
                String category = c.getString(7);

                TextView row = new TextView(this);

                row.setText(
                    name +
                    "\nسعر البيع: " + price + " دج" +
                    "\nسعر الشراء: " + purchase + " دج" +
                    "\nالمخزون: " + stock + " " + unit +
                    "\nالباركود: " + barcode +
                    "\nالتصنيف: " + category +
                    "\nرقم المنتج: " + id
                );

                row.setTextSize(16);
                row.setPadding(10, 18, 10, 18);
                root.addView(row);

                row.setOnClickListener(v ->
                    productActions(id, name));
            }
        }

        button("إضافة منتج", this::addProduct);
        button("رجوع", this::showDashboard);
    }

    private void productActions(long id, String name) {
        String[] options = {
            "تعديل المنتج والسعر والمخزون",
            "حذف المنتج",
            "إضافة المنتج إلى السلة"
        };

        new AlertDialog.Builder(this)
            .setTitle(name)
            .setItems(options, (dialog, which) -> {
                if (which == 0) editProduct(id);
                if (which == 1) confirmDelete(id, name);
                if (which == 2) promptQuantity(id, name);
            })
            .show();
    }

    private void editProduct(long id) {
        try (Cursor c = db.product(storeId, id)) {
            if (!c.moveToFirst()) {
                message("المنتج غير موجود");
                return;
            }

            String oldName = c.getString(1);
            String oldBarcode = c.getString(2);
            double oldPrice = c.getDouble(3);
            double oldPurchase = c.getDouble(4);
            double oldStock = c.getDouble(5);
            String oldUnit = c.getString(6);
            String oldCategory = c.getString(7);

            LinearLayout layout = new LinearLayout(this);
            layout.setOrientation(LinearLayout.VERTICAL);
            layout.setPadding(24, 8, 24, 8);
            layout.setLayoutDirection(View.LAYOUT_DIRECTION_RTL);

            EditText name = dialogField(layout, "اسم المنتج", oldName);
            EditText barcode = dialogField(
                layout, "الباركود", oldBarcode);
            EditText price = dialogField(
                layout, "سعر البيع", String.valueOf(oldPrice));
            EditText purchase = dialogField(
                layout, "سعر الشراء", String.valueOf(oldPurchase));
            EditText stock = dialogField(
                layout, "المخزون", String.valueOf(oldStock));
            EditText unit = dialogField(layout, "الوحدة", oldUnit);
            EditText category = dialogField(
                layout, "التصنيف", oldCategory);

            new AlertDialog.Builder(this)
                .setTitle("تعديل المنتج")
                .setView(layout)
                .setNegativeButton("إلغاء", null)
                .setPositiveButton("حفظ", (d, w) -> {
                    try {
                        db.updateProduct(
                            storeId, id,
                            name.getText().toString(),
                            barcode.getText().toString(),
                            number(price, "سعر البيع"),
                            number(purchase, "سعر الشراء"),
                            number(stock, "المخزون"),
                            unit.getText().toString(),
                            category.getText().toString()
                        );

                        message("تم تحديث المنتج");
                        showProducts();

                    } catch (Exception e) {
                        message("تعذر التعديل: " + e.getMessage());
                    }
                })
                .show();
        }
    }

    private EditText dialogField(
        LinearLayout layout, String hint, String value
    ) {
        EditText e = new EditText(this);
        e.setHint(hint);
        e.setText(value);
        e.setSingleLine(true);
        layout.addView(e);
        return e;
    }

    private void confirmDelete(long id, String name) {
        new AlertDialog.Builder(this)
            .setTitle("حذف المنتج")
            .setMessage("هل تريد حذف " + name + "؟")
            .setNegativeButton("إلغاء", null)
            .setPositiveButton("حذف", (d, w) -> {
                try {
                    boolean deleted = db.deleteProduct(storeId, id);

                    if (!deleted) {
                        message(
                            "لا يمكن حذف منتج مرتبط بفواتير سابقة.");
                    } else {
                        message("تم حذف المنتج");
                    }

                    showProducts();

                } catch (Exception e) {
                    message(e.getMessage());
                }
            })
            .show();
    }

    private void showProductsForSale() {
        base("اختر منتجاً للبيع");

        try (Cursor c = db.products(storeId)) {
            while (c.moveToNext()) {
                long id = c.getLong(0);
                String name = c.getString(1);
                double price = c.getDouble(3);
                double stock = c.getDouble(5);
                String unit = c.getString(6);

                Button b = new Button(this);
                b.setAllCaps(false);
                b.setText(
                    name + " | " + price + " دج" +
                    " | المتوفر: " + stock + " " + unit
                );

                b.setOnClickListener(v -> promptQuantity(id, name));
                root.addView(b);
            }
        }

        button("عرض السلة", this::showCart);
        button("رجوع", this::showDashboard);
    }

    private void promptQuantity(long id, String name) {
        EditText quantity = new EditText(this);
        quantity.setHint("الكمية");
        quantity.setInputType(
            InputType.TYPE_CLASS_NUMBER |
            InputType.TYPE_NUMBER_FLAG_DECIMAL
        );

        new AlertDialog.Builder(this)
            .setTitle("إضافة: " + name)
            .setView(quantity)
            .setNegativeButton("إلغاء", null)
            .setPositiveButton("إضافة", (d, w) -> {
                try {
                    String value = quantity.getText().toString()
                        .trim().replace(',', '.');

                    double q = Double.parseDouble(value);

                    if (!Double.isFinite(q) || q <= 0) {
                        throw new IllegalArgumentException(
                            "الكمية غير صحيحة");
                    }

                    double old = cart.containsKey(id)
                        ? cart.get(id) : 0;

                    cart.put(id, old + q);

                    message("تمت إضافة الكمية إلى السلة");

                } catch (Exception e) {
                    message(e.getMessage());
                }
            })
            .show();
    }

    private void showCart() {
        base("سلة البيع");

        if (cart.isEmpty()) {
            TextView empty = new TextView(this);
            empty.setText("السلة فارغة");
            root.addView(empty);
        }

        for (Long id : cart.keySet()) {
            TextView line = new TextView(this);
            line.setText(
                "المنتج رقم " + id +
                " — الكمية: " + cart.get(id)
            );
            line.setTextSize(16);
            line.setPadding(8, 12, 8, 12);
            root.addView(line);
        }

        button("تأكيد البيع وحفظ الفاتورة", () -> {
            try {
                long saleId = db.createSale(storeId, cart);
                cart.clear();

                String invoice = db.saleDetails(storeId, saleId);

                new AlertDialog.Builder(this)
                    .setTitle("تم البيع بنجاح")
                    .setMessage(invoice)
                    .setPositiveButton("حسناً", (d, w) ->
                        showDashboard())
                    .show();

            } catch (Exception e) {
                message("فشل البيع: " + e.getMessage());
            }
        });

        button("إفراغ السلة", () -> {
            cart.clear();
            showCart();
        });

        button("رجوع", this::showDashboard);
    }

    private void showSales() {
        base("سجل الفواتير");

        try (Cursor c = db.sales(storeId)) {
            if (c.getCount() == 0) {
                TextView empty = new TextView(this);
                empty.setText("لا توجد فواتير حتى الآن");
                root.addView(empty);
            }

            while (c.moveToNext()) {
                long id = c.getLong(0);
                double total = c.getDouble(1);
                String date = c.getString(2);

                Button b = new Button(this);
                b.setAllCaps(false);
                b.setText(
                    "فاتورة رقم " + id +
                    "\n" + total + " دج" +
                    "\n" + date
                );

                b.setOnClickListener(v ->
                    message(db.saleDetails(storeId, id)));

                root.addView(b);
            }
        }

        button("رجوع", this::showDashboard);
    }

    @Override
    protected void onDestroy() {
        if (db != null) {
            db.closeDatabase();
        }
        super.onDestroy();
    }
}
