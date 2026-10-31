package dz.nrs.cashpro.nativeapp;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.DatabaseUtils;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import android.database.sqlite.SQLiteStatement;

import org.bouncycastle.crypto.generators.SCrypt;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.TimeZone;

public final class Database extends SQLiteOpenHelper {

    // اسم جديد حتى لا تختلط بيانات الاختبار السابقة بالقاعدة الجديدة.
    private static final String DB_NAME = "nrs_cash_pro_fresh.db";
    private static final int DB_VERSION = 1;

    public Database(Context context) {
        super(context, DB_NAME, null, DB_VERSION);
        setWriteAheadLoggingEnabled(true);
    }

    @Override
    public void onConfigure(SQLiteDatabase db) {
        super.onConfigure(db);
        db.setForeignKeyConstraintsEnabled(true);
    }

    @Override
    public void onCreate(SQLiteDatabase db) {

        db.execSQL(
            "CREATE TABLE stores (" +
            "id INTEGER PRIMARY KEY AUTOINCREMENT," +
            "name TEXT NOT NULL," +
            "status TEXT NOT NULL DEFAULT 'active'," +
            "business_type TEXT NOT NULL DEFAULT 'grocery'," +
            "created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
        );

        db.execSQL(
            "CREATE TABLE users (" +
            "id INTEGER PRIMARY KEY AUTOINCREMENT," +
            "store_id INTEGER NOT NULL," +
            "username TEXT NOT NULL UNIQUE," +
            "password_hash TEXT NOT NULL," +
            "role TEXT NOT NULL DEFAULT 'store_owner'," +
            "active INTEGER NOT NULL DEFAULT 1," +
            "created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP," +
            "FOREIGN KEY(store_id) REFERENCES stores(id))"
        );

        db.execSQL(
            "CREATE TABLE subscriptions (" +
            "id INTEGER PRIMARY KEY AUTOINCREMENT," +
            "store_id INTEGER NOT NULL," +
            "plan TEXT NOT NULL DEFAULT 'trial'," +
            "status TEXT NOT NULL DEFAULT 'active'," +
            "starts_at TEXT," +
            "expires_at TEXT," +
            "created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP," +
            "FOREIGN KEY(store_id) REFERENCES stores(id))"
        );

        db.execSQL(
            "CREATE TABLE products (" +
            "id INTEGER PRIMARY KEY AUTOINCREMENT," +
            "name TEXT NOT NULL," +
            "barcode TEXT," +
            "price REAL NOT NULL DEFAULT 0," +
            "stock REAL NOT NULL DEFAULT 0," +
            "category TEXT NOT NULL DEFAULT 'عام'," +
            "created_at TEXT DEFAULT CURRENT_TIMESTAMP," +
            "store_id INTEGER NOT NULL," +
            "brand TEXT NOT NULL DEFAULT ''," +
            "purchase_price REAL NOT NULL DEFAULT 0," +
            "unit TEXT NOT NULL DEFAULT 'piece'," +
            "pack_size REAL NOT NULL DEFAULT 1," +
            "FOREIGN KEY(store_id) REFERENCES stores(id))"
        );

        db.execSQL(
            "CREATE UNIQUE INDEX idx_products_store_barcode " +
            "ON products(store_id,barcode) " +
            "WHERE barcode IS NOT NULL AND barcode<>''"
        );

        db.execSQL(
            "CREATE INDEX idx_products_store " +
            "ON products(store_id)"
        );

        db.execSQL(
            "CREATE TABLE sales (" +
            "id INTEGER PRIMARY KEY AUTOINCREMENT," +
            "total REAL NOT NULL," +
            "created_at TEXT DEFAULT CURRENT_TIMESTAMP," +
            "store_id INTEGER NOT NULL," +
            "FOREIGN KEY(store_id) REFERENCES stores(id))"
        );

        db.execSQL(
            "CREATE TABLE sale_items (" +
            "id INTEGER PRIMARY KEY AUTOINCREMENT," +
            "sale_id INTEGER NOT NULL," +
            "product_id INTEGER," +
            "name TEXT NOT NULL," +
            "price REAL NOT NULL," +
            "quantity REAL NOT NULL," +
            "subtotal REAL NOT NULL," +
            "store_id INTEGER NOT NULL," +
            "unit TEXT NOT NULL DEFAULT 'piece'," +
            "base_quantity REAL NOT NULL DEFAULT 0," +
            "FOREIGN KEY(sale_id) REFERENCES sales(id)," +
            "FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE SET NULL)"
        );

        db.execSQL(
            "CREATE TABLE daily_closures (" +
            "id INTEGER PRIMARY KEY AUTOINCREMENT," +
            "store_id INTEGER NOT NULL," +
            "period_start_sale_id INTEGER NOT NULL DEFAULT 0," +
            "last_sale_id INTEGER NOT NULL," +
            "sale_count INTEGER NOT NULL," +
            "total REAL NOT NULL," +
            "sale_ids TEXT NOT NULL," +
            "closed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP," +
            "UNIQUE(store_id,last_sale_id)," +
            "FOREIGN KEY(store_id) REFERENCES stores(id))"
        );

        db.execSQL(
            "CREATE TABLE app_settings (" +
            "store_id INTEGER NOT NULL," +
            "key TEXT NOT NULL," +
            "value TEXT NOT NULL DEFAULT ''," +
            "updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP," +
            "PRIMARY KEY(store_id,key))"
        );

        db.execSQL(
            "CREATE TABLE sessions (" +
            "id INTEGER PRIMARY KEY AUTOINCREMENT," +
            "user_id INTEGER NOT NULL," +
            "token_hash TEXT NOT NULL UNIQUE," +
            "expires_at TEXT NOT NULL," +
            "created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP," +
            "FOREIGN KEY(user_id) REFERENCES users(id))"
        );
    }

    @Override
    public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        // لا نحذف بيانات العملاء عند التحديث.
    }

    private static double money(double value) {
        return BigDecimal.valueOf(value)
            .setScale(2, RoundingMode.HALF_UP)
            .doubleValue();
    }

    private static String nowUtc() {
        SimpleDateFormat f = new SimpleDateFormat(
            "yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US);
        f.setTimeZone(TimeZone.getTimeZone("UTC"));
        return f.format(new Date());
    }

    private static String futureUtc(long milliseconds) {
        SimpleDateFormat f = new SimpleDateFormat(
            "yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US);
        f.setTimeZone(TimeZone.getTimeZone("UTC"));
        return f.format(new Date(System.currentTimeMillis() + milliseconds));
    }

    // Node-compatible scrypt: N=16384, r=8, p=1, dkLen=64.
    public static String passwordHash(String password) throws Exception {
        byte[] salt = new byte[16];
        new SecureRandom().nextBytes(salt);

        String saltHex = hex(salt);

        byte[] result = SCrypt.generate(
            password.getBytes(StandardCharsets.UTF_8),
            saltHex.getBytes(StandardCharsets.UTF_8),
            16384, 8, 1, 64
        );

        return saltHex + ":" + hex(result);
    }

    public static boolean verifyPassword(String password, String stored) {
        try {
            String[] parts = stored.split(":", 2);

            if (parts.length != 2 ||
                parts[0].length() != 32 ||
                parts[1].length() != 128) {
                return false;
            }

            byte[] actual = SCrypt.generate(
                password.getBytes(StandardCharsets.UTF_8),
                parts[0].getBytes(StandardCharsets.UTF_8),
                16384, 8, 1, 64
            );

            return MessageDigest.isEqual(actual, unhex(parts[1]));
        } catch (Exception e) {
            return false;
        }
    }

    private static String hex(byte[] bytes) {
        StringBuilder out = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) {
            out.append(String.format(Locale.ROOT, "%02x", b & 255));
        }
        return out.toString();
    }

    private static byte[] unhex(String value) {
        if ((value.length() & 1) != 0) {
            throw new IllegalArgumentException("Invalid hex");
        }

        byte[] out = new byte[value.length() / 2];

        for (int i = 0; i < out.length; i++) {
            int p = i * 2;
            out[i] = (byte) Integer.parseInt(
                value.substring(p, p + 2), 16);
        }

        return out;
    }

    public long createLocalStore(
        String storeName,
        String username,
        String password
    ) throws Exception {

        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();

        try {
            ContentValues store = new ContentValues();
            store.put("name", storeName);
            store.put("status", "active");
            store.put("business_type", "grocery");

            long storeId = db.insertOrThrow("stores", null, store);

            ContentValues user = new ContentValues();
            user.put("store_id", storeId);
            user.put("username", username);
            user.put("password_hash", passwordHash(password));
            user.put("role", "store_owner");
            user.put("active", 1);

            db.insertOrThrow("users", null, user);

            ContentValues sub = new ContentValues();
            sub.put("store_id", storeId);
            sub.put("plan", "trial");
            sub.put("status", "active");
            sub.put("starts_at", nowUtc());
            sub.put("expires_at", futureUtc(7L * 86400000L));

            db.insertOrThrow("subscriptions", null, sub);

            db.setTransactionSuccessful();
            return storeId;

        } finally {
            db.endTransaction();
        }
    }

    public boolean hasUsers() {
        return DatabaseUtils.longForQuery(
            getReadableDatabase(),
            "SELECT COUNT(*) FROM users", null
        ) > 0;
    }

    public long login(String username, String password) {
        try (Cursor c = getReadableDatabase().rawQuery(
            "SELECT id,password_hash,active FROM users WHERE username=?",
            new String[]{username}
        )) {
            if (!c.moveToFirst() || c.getInt(2) != 1) {
                return -1;
            }

            return verifyPassword(password, c.getString(1))
                ? c.getLong(0) : -1;
        }
    }

    public long storeForUser(long userId) {
        try (Cursor c = getReadableDatabase().rawQuery(
            "SELECT store_id FROM users WHERE id=?",
            new String[]{String.valueOf(userId)}
        )) {
            return c.moveToFirst() ? c.getLong(0) : -1;
        }
    }

    public long addProduct(
        long storeId,
        String name,
        String barcode,
        double price,
        double purchasePrice,
        double stock,
        String unit,
        String category
    ) {
        if (name.trim().isEmpty() || price < 0 ||
            purchasePrice < 0 || stock < 0) {
            throw new IllegalArgumentException("بيانات المنتج غير صحيحة");
        }

        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();

        try {
            ContentValues v = new ContentValues();
            v.put("name", name.trim());
            v.put("price", money(price));
            v.put("purchase_price", money(purchasePrice));
            v.put("stock", stock);
            v.put("unit", unit);
            v.put("category", category);
            v.put("store_id", storeId);
            v.put("pack_size", 1);

            if (barcode != null && !barcode.trim().isEmpty()) {
                v.put("barcode", barcode.trim());
            }

            long id = db.insertOrThrow("products", null, v);

            if (barcode == null || barcode.trim().isEmpty()) {
                ContentValues generated = new ContentValues();
                generated.put(
                    "barcode",
                    String.format(Locale.ROOT, "DZ%03d%08d", storeId, id)
                );

                db.update(
                    "products", generated,
                    "id=? AND store_id=?",
                    new String[]{String.valueOf(id), String.valueOf(storeId)}
                );
            }

            db.setTransactionSuccessful();
            return id;

        } finally {
            db.endTransaction();
        }
    }

    public void updateProduct(
        long storeId,
        long productId,
        String name,
        String barcode,
        double price,
        double purchasePrice,
        double stock,
        String unit,
        String category
    ) {
        if (name.trim().isEmpty() || price < 0 ||
            purchasePrice < 0 || stock < 0) {
            throw new IllegalArgumentException("بيانات غير صحيحة");
        }

        ContentValues v = new ContentValues();
        v.put("name", name.trim());
        v.put("barcode", barcode == null ? "" : barcode.trim());
        v.put("price", money(price));
        v.put("purchase_price", money(purchasePrice));
        v.put("stock", stock);
        v.put("unit", unit);
        v.put("category", category);

        int changed = getWritableDatabase().update(
            "products", v,
            "id=? AND store_id=?",
            new String[]{
                String.valueOf(productId),
                String.valueOf(storeId)
            }
        );

        if (changed != 1) {
            throw new IllegalStateException("لم يتم العثور على المنتج");
        }
    }

    public boolean deleteProduct(long storeId, long productId) {
        SQLiteDatabase db = getWritableDatabase();

        long used = DatabaseUtils.longForQuery(
            db,
            "SELECT COUNT(*) FROM sale_items WHERE product_id=?",
            new String[]{String.valueOf(productId)}
        );

        if (used > 0) {
            return false;
        }

        return db.delete(
            "products",
            "id=? AND store_id=?",
            new String[]{
                String.valueOf(productId),
                String.valueOf(storeId)
            }
        ) == 1;
    }

    public Cursor products(long storeId) {
        return getReadableDatabase().rawQuery(
            "SELECT id,name,barcode,price,purchase_price,stock,unit,category " +
            "FROM products WHERE store_id=? ORDER BY name",
            new String[]{String.valueOf(storeId)}
        );
    }

    public Cursor product(long storeId, long productId) {
        return getReadableDatabase().rawQuery(
            "SELECT id,name,barcode,price,purchase_price,stock,unit,category " +
            "FROM products WHERE store_id=? AND id=?",
            new String[]{
                String.valueOf(storeId),
                String.valueOf(productId)
            }
        );
    }

    public long createSale(
        long storeId,
        LinkedHashMap<Long, Double> cart
    ) {
        if (cart.isEmpty()) {
            throw new IllegalArgumentException("السلة فارغة");
        }

        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();

        try {
            ArrayList<ContentValues> lines = new ArrayList<>();
            double total = 0;

            // نجمع الكميات حسب المنتج، فلا يتكرر المنتج كسطرين.
            for (Long productId : cart.keySet()) {
                double quantity = cart.get(productId);

                if (!Double.isFinite(quantity) || quantity <= 0) {
                    throw new IllegalArgumentException("كمية غير صحيحة");
                }

                try (Cursor c = db.rawQuery(
                    "SELECT name,price,stock,unit FROM products " +
                    "WHERE id=? AND store_id=?",
                    new String[]{
                        String.valueOf(productId),
                        String.valueOf(storeId)
                    }
                )) {
                    if (!c.moveToFirst()) {
                        throw new IllegalArgumentException("منتج غير موجود");
                    }

                    String name = c.getString(0);
                    double price = c.getDouble(1);
                    double stock = c.getDouble(2);
                    String unit = c.getString(3);

                    if (stock + 0.000001 < quantity) {
                        throw new IllegalArgumentException(
                            "المخزون غير كافٍ: " + name);
                    }

                    double subtotal = money(price * quantity);
                    total = money(total + subtotal);

                    ContentValues row = new ContentValues();
                    row.put("product_id", productId);
                    row.put("name", name);
                    row.put("price", price);
                    row.put("quantity", quantity);
                    row.put("subtotal", subtotal);
                    row.put("unit", unit);
                    row.put("base_quantity", quantity);
                    lines.add(row);
                }
            }

            ContentValues sale = new ContentValues();
            sale.put("total", total);
            sale.put("store_id", storeId);

            long saleId = db.insertOrThrow("sales", null, sale);

            SQLiteStatement updateStock = db.compileStatement(
                "UPDATE products SET stock=stock-? " +
                "WHERE id=? AND store_id=? AND stock>=?"
            );

            for (ContentValues row : lines) {
                long productId = row.getAsLong("product_id");
                double quantity = row.getAsDouble("quantity");

                updateStock.clearBindings();
                updateStock.bindDouble(1, quantity);
                updateStock.bindLong(2, productId);
                updateStock.bindLong(3, storeId);
                updateStock.bindDouble(4, quantity);

                int changed = updateStock.executeUpdateDelete();

                if (changed != 1) {
                    throw new IllegalStateException(
                        "فشل تحديث المخزون؛ ألغيت العملية بالكامل");
                }

                row.put("sale_id", saleId);
                row.put("store_id", storeId);

                db.insertOrThrow("sale_items", null, row);
            }

            db.setTransactionSuccessful();
            return saleId;

        } finally {
            db.endTransaction();
        }
    }

    public String saleDetails(long storeId, long saleId) {
        StringBuilder out = new StringBuilder();

        try (Cursor sale = getReadableDatabase().rawQuery(
            "SELECT total,created_at FROM sales WHERE id=? AND store_id=?",
            new String[]{
                String.valueOf(saleId),
                String.valueOf(storeId)
            }
        )) {
            if (!sale.moveToFirst()) {
                return "الفاتورة غير موجودة";
            }

            out.append("N.R.S. CASH PRO\n");
            out.append("الفاتورة رقم: ").append(saleId).append("\n");
            out.append("التاريخ: ").append(sale.getString(1)).append("\n");
            out.append("----------------------\n");

            try (Cursor items = getReadableDatabase().rawQuery(
                "SELECT name,quantity,price,subtotal,unit " +
                "FROM sale_items WHERE sale_id=? AND store_id=?",
                new String[]{
                    String.valueOf(saleId),
                    String.valueOf(storeId)
                }
            )) {
                while (items.moveToNext()) {
                    out.append(items.getString(0)).append("\n");
                    out.append(items.getDouble(1)).append(" ")
                        .append(items.getString(4))
                        .append(" × ")
                        .append(items.getDouble(2))
                        .append(" = ")
                        .append(items.getDouble(3))
                        .append(" دج\n");
                }
            }

            out.append("----------------------\n");
            out.append("الإجمالي: ")
                .append(sale.getDouble(0)).append(" دج");

        }

        return out.toString();
    }

    public Cursor sales(long storeId) {
        return getReadableDatabase().rawQuery(
            "SELECT id,total,created_at FROM sales " +
            "WHERE store_id=? ORDER BY id DESC LIMIT 200",
            new String[]{String.valueOf(storeId)}
        );
    }

    public String dailySummary(long storeId) {
        SQLiteDatabase db = getReadableDatabase();

        long lastId = 0;

        try (Cursor c = db.rawQuery(
            "SELECT last_sale_id FROM daily_closures " +
            "WHERE store_id=? ORDER BY id DESC LIMIT 1",
            new String[]{String.valueOf(storeId)}
        )) {
            if (c.moveToFirst()) {
                lastId = c.getLong(0);
            }
        }

        try (Cursor c = db.rawQuery(
            "SELECT COUNT(*),COALESCE(SUM(total),0) FROM sales " +
            "WHERE store_id=? AND id>?",
            new String[]{
                String.valueOf(storeId),
                String.valueOf(lastId)
            }
        )) {
            if (!c.moveToFirst()) {
                return "لا توجد بيانات";
            }

            return "الفواتير الجديدة: " + c.getLong(0) +
                "\nإجمالي المبيعات: " +
                money(c.getDouble(1)) + " دج";
        }
    }

    public void closeDay(long storeId) {
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();

        try {
            long previous = 0;

            try (Cursor c = db.rawQuery(
                "SELECT last_sale_id FROM daily_closures " +
                "WHERE store_id=? ORDER BY id DESC LIMIT 1",
                new String[]{String.valueOf(storeId)}
            )) {
                if (c.moveToFirst()) {
                    previous = c.getLong(0);
                }
            }

            long count = 0;
            long last = previous;
            double total = 0;
            StringBuilder ids = new StringBuilder("[");

            try (Cursor c = db.rawQuery(
                "SELECT id,total FROM sales " +
                "WHERE store_id=? AND id>? ORDER BY id",
                new String[]{
                    String.valueOf(storeId),
                    String.valueOf(previous)
                }
            )) {
                while (c.moveToNext()) {
                    if (count > 0) {
                        ids.append(",");
                    }

                    last = c.getLong(0);
                    ids.append(last);
                    total += c.getDouble(1);
                    count++;
                }
            }

            if (count == 0) {
                throw new IllegalStateException(
                    "لا توجد فواتير جديدة للإغلاق");
            }

            ids.append("]");

            ContentValues closure = new ContentValues();
            closure.put("store_id", storeId);
            closure.put("period_start_sale_id", previous);
            closure.put("last_sale_id", last);
            closure.put("sale_count", count);
            closure.put("total", money(total));
            closure.put("sale_ids", ids.toString());

            db.insertOrThrow("daily_closures", null, closure);

            db.setTransactionSuccessful();

        } finally {
            db.endTransaction();
        }
    }

    public void closeDatabase() {
        close();
    }
}
