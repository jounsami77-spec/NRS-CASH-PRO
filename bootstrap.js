const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA, { recursive: true });

const db = new DatabaseSync(path.join(DATA, 'cashier.db'));

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(password, salt, 64).toString('hex');
}

try {
  db.exec('PRAGMA foreign_keys=ON');

  // السماح بإنشاء المدير الأول دون وجود متجر.
  db.exec(`
    CREATE TABLE IF NOT EXISTS stores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK(status IN ('active','suspended')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      business_type TEXT NOT NULL DEFAULT 'grocery'
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      store_id INTEGER,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL
        CHECK(role IN ('super_admin','store_owner','cashier')),
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(store_id) REFERENCES stores(id)
    );
  `);

  const existing = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;

  // لا نغيّر حسابات موجودة عند إعادة تشغيل Railway.
  if (existing > 0) {
    console.log('توجد حسابات بالفعل؛ لم يتم تغيير أي حساب.');
  } else {
    const password = process.env.INITIAL_ADMIN_PASSWORD;

    if (!password || password.length < 10) {
      throw new Error(
        'يلزم ضبط INITIAL_ADMIN_PASSWORD بطول 10 أحرف على الأقل.'
      );
    }

    db.prepare(`
      INSERT INTO users (store_id, username, password_hash, role, active)
      VALUES (NULL, 'admin', ?, 'super_admin', 1)
    `).run(hashPassword(password));

    console.log('تم إنشاء حساب المدير العام الأول.');
    console.log('اسم المستخدم: admin');
    console.log('لم تُنشأ متاجر؛ يستطيع المدير إنشاؤها من لوحة الإدارة.');
    console.log('لم تتم طباعة كلمة المرور أو حفظها في ملف.');
  }
} finally {
  db.close();
}
