const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
fs.mkdirSync(DATA, { recursive: true });

const db = new DatabaseSync(path.join(DATA, 'cashier.db'));
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS stores (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 name TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'active'
 CHECK(status IN ('active','suspended')),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS users (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 store_id INTEGER,
 username TEXT NOT NULL UNIQUE,
 password_hash TEXT NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('super_admin','store_owner','cashier')),
 active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(store_id) REFERENCES stores(id)
);
CREATE TABLE IF NOT EXISTS sessions (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user_id INTEGER NOT NULL,
 token_hash TEXT NOT NULL UNIQUE,
 expires_at TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS subscriptions (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 store_id INTEGER NOT NULL,
 plan TEXT NOT NULL DEFAULT 'monthly',
 status TEXT NOT NULL DEFAULT 'pending'
 CHECK(status IN ('pending','active','expired','cancelled')),
 starts_at TEXT,
 expires_at TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(store_id) REFERENCES stores(id)
);
CREATE TABLE IF NOT EXISTS app_settings (
 store_id INTEGER NOT NULL,
 key TEXT NOT NULL,
 value TEXT NOT NULL DEFAULT '',
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(store_id,key),
 FOREIGN KEY(store_id) REFERENCES stores(id)
);
CREATE TABLE IF NOT EXISTS products (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 name TEXT NOT NULL,
 barcode TEXT,
 price REAL NOT NULL DEFAULT 0,
 stock INTEGER NOT NULL DEFAULT 0,
 category TEXT DEFAULT 'عام',
 created_at TEXT DEFAULT CURRENT_TIMESTAMP,
 store_id INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS sales (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 total REAL NOT NULL,
 created_at TEXT DEFAULT CURRENT_TIMESTAMP,
 store_id INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS sale_items (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 sale_id INTEGER NOT NULL,
 product_id INTEGER,
 name TEXT NOT NULL,
 price REAL NOT NULL,
 quantity INTEGER NOT NULL,
 subtotal REAL NOT NULL,
 store_id INTEGER NOT NULL DEFAULT 1
);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS daily_closures (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 store_id INTEGER NOT NULL,
 period_start_sale_id INTEGER NOT NULL DEFAULT 0,
 last_sale_id INTEGER NOT NULL,
 sale_count INTEGER NOT NULL,
 total REAL NOT NULL,
 sale_ids TEXT NOT NULL,
 closed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(store_id,last_sale_id)
);
CREATE INDEX IF NOT EXISTS idx_daily_closures_store
 ON daily_closures(store_id,id DESC);
`);

function columns(table) {
 return db.prepare(`PRAGMA table_info(${table})`).all().map(x => x.name);
}
function addColumn(table, name, definition) {
 if (!columns(table).includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
}
addColumn('stores','business_type',"TEXT NOT NULL DEFAULT 'grocery'");
addColumn('products','store_id','INTEGER NOT NULL DEFAULT 1');
addColumn('sales','store_id','INTEGER NOT NULL DEFAULT 1');
addColumn('sale_items','store_id','INTEGER NOT NULL DEFAULT 1');
addColumn('products','brand',"TEXT NOT NULL DEFAULT ''");
addColumn('products','purchase_price','REAL NOT NULL DEFAULT 0');
addColumn('products','unit',"TEXT NOT NULL DEFAULT 'piece'");
addColumn('products','pack_size','REAL NOT NULL DEFAULT 1');
addColumn('sale_items','unit',"TEXT NOT NULL DEFAULT 'piece'");
addColumn('sale_items','base_quantity','REAL NOT NULL DEFAULT 0');

db.exec(`
CREATE INDEX IF NOT EXISTS idx_users_store_id ON users(store_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sales_store_id ON sales(store_id);
CREATE INDEX IF NOT EXISTS idx_sales_store_created ON sales(store_id,created_at);
CREATE INDEX IF NOT EXISTS idx_sale_items_store_id ON sale_items(store_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_store_id ON subscriptions(store_id);
`);

/* Safe migration: barcode uniqueness is per store, not global. */
const productSQL = db.prepare(
 "SELECT sql FROM sqlite_master WHERE type='table' AND name='products'"
).get()?.sql || '';
if (/barcode\s+TEXT\s+UNIQUE/i.test(productSQL)) {
 db.exec('DROP INDEX IF EXISTS idx_products_store_id');
 db.exec('BEGIN IMMEDIATE');
 try {
  db.exec(`
   ALTER TABLE products RENAME TO products_legacy_migration;
   CREATE TABLE products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    barcode TEXT,
    price REAL NOT NULL DEFAULT 0,
    stock INTEGER NOT NULL DEFAULT 0,
    category TEXT DEFAULT 'عام',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    store_id INTEGER NOT NULL DEFAULT 1
   );
   INSERT INTO products(id,name,barcode,price,stock,category,created_at,store_id)
   SELECT id,name,barcode,price,stock,category,created_at,store_id
   FROM products_legacy_migration;
   DROP TABLE products_legacy_migration;
   CREATE INDEX idx_products_store_id ON products(store_id);
   CREATE UNIQUE INDEX idx_products_store_barcode
    ON products(store_id,barcode) WHERE barcode IS NOT NULL AND barcode<>'';
  `);
  db.exec('COMMIT');
 } catch (e) {
  try { db.exec('ROLLBACK'); } catch {}
  throw e;
 }
} else {
 db.exec(`
  CREATE INDEX IF NOT EXISTS idx_products_store_id ON products(store_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_products_store_barcode
   ON products(store_id,barcode) WHERE barcode IS NOT NULL AND barcode<>'';
 `);
}

/* Keep existing demo products only when the database is empty. */
if (db.prepare('SELECT COUNT(*) n FROM products').get().n === 0) {
 const add = db.prepare(
  'INSERT INTO products(name,barcode,price,stock,category,store_id) VALUES(?,?,?,?,?,1)'
 );
 for (const p of [
  ['ماء معدني','9900000000001',30,50,'مشروبات'],
  ['حليب','9900000000002',30,40,'ألبان'],
  ['خبز','9900000000003',15,30,'مواد غذائية'],
  ['عصير','9900000000004',80,20,'مشروبات']
 ]) add.run(...p);
}

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const passwordHash = password => {
 const salt = crypto.randomBytes(16).toString('hex');
 return salt + ':' + crypto.scryptSync(password, salt, 64).toString('hex');
};
const verifyPassword = (password, stored) => {
 try {
  const [salt, hex] = stored.split(':');
  const expected = Buffer.from(hex, 'hex');
  const actual = crypto.scryptSync(password, salt, 64);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
 } catch { return false; }
};
const cookieToken = req => {
 const cookies = String(req.headers.cookie || '').split(';');
 for (const c of cookies) {
  const i = c.trim().indexOf('=');
  if (i > 0 && c.trim().slice(0, i) === 'dzvora_session') {
   try { return decodeURIComponent(c.trim().slice(i + 1)); } catch {}
  }
 }
 return '';
};
const cookieHeader = (req, value, maxAge) => {
 const secure = req.headers['x-forwarded-proto'] === 'https';
 return `dzvora_session=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}` +
  (secure ? '; Secure' : '');
};
function send(res, status, data, headers={}) {
 res.writeHead(status, {
  'Content-Type':'application/json; charset=utf-8',
  'Cache-Control':'no-store',
  'X-Content-Type-Options':'nosniff',
  ...headers
 });
 res.end(JSON.stringify(data));
}
function bodyJSON(req) {
 return new Promise((resolve,reject)=>{
  let raw='';
  req.on('data',chunk=>{
   raw+=chunk;
   if(raw.length>12*1024*1024) {
    reject(new Error('الطلب كبير جدًا'));
    req.destroy();
   }
  });
  req.on('end',()=>{
   try { resolve(JSON.parse(raw || '{}')); }
   catch { reject(new Error('بيانات JSON غير صالحة')); }
  });
  req.on('error',reject);
 });
}
function sessionUser(req) {
 const token = cookieToken(req);
 if (!token) return null;
 const row = db.prepare(`
  SELECT u.id,u.store_id,u.username,u.role,u.active,
         s.status AS store_status,
         se.expires_at AS session_expires
  FROM sessions se JOIN users u ON u.id=se.user_id
  LEFT JOIN stores s ON s.id=u.store_id
  WHERE se.token_hash=?
 `).get(sha(token));
 if (!row || !row.active || row.session_expires <= new Date().toISOString()) return null;
 if (row.role !== 'super_admin' && row.store_status !== 'active') return null;
 return row;
}
function subInfo(storeId) {
 return db.prepare(`
  SELECT plan,status,starts_at,expires_at FROM subscriptions
  WHERE store_id=? ORDER BY id DESC LIMIT 1
 `).get(storeId) || null;
}
function trialExpired(storeId) {
 const sub = subInfo(storeId);
 if (!sub || sub.status !== 'active') return true;
 if (!sub.expires_at) return true;
 const expires = new Date(sub.expires_at).getTime();
 return !Number.isFinite(expires) || expires <= Date.now();
}
function publicUser(user) {
 if (!user) return null;
 return {
  id:user.id,username:user.username,role:user.role,storeId:user.store_id,
  storeName:user.store_id ? db.prepare('SELECT name FROM stores WHERE id=?').get(user.store_id)?.name : 'DZVORA ADMIN',
  subscription:user.store_id ? subInfo(user.store_id) : null
 };
}
function requireAuth(user,res) {
 if (!user) { send(res,401,{error:'سجّل الدخول أولاً'}); return false; }
 if (user.role !== 'super_admin' && trialExpired(user.store_id)) {
  send(res,402,{error:'انتهت التجربة أو الاشتراك. تواصل مع الإدارة لتفعيل الحساب.'});
  return false;
 }
 return true;
}
function requireAdmin(user,res) {
 if (!user) { send(res,401,{error:'سجّل الدخول أولاً'}); return false; }
 if (user.role !== 'super_admin') { send(res,403,{error:'هذه الصفحة خاصة بالمدير العام'}); return false; }
 return true;
}
function startTrialIfNeeded(storeId) {
 const sub = subInfo(storeId);
 if (!sub || sub.status === 'cancelled') return;
 if (!sub.starts_at && !sub.expires_at) {
  const start = new Date();
  const end = new Date(start.getTime() + 7*24*60*60*1000);
  db.prepare(`
   UPDATE subscriptions SET status='active',starts_at=?,expires_at=?
   WHERE id=(SELECT id FROM subscriptions WHERE store_id=? ORDER BY id DESC LIMIT 1)
  `).run(start.toISOString(),end.toISOString(),storeId);
 }
}

async function api(req,res,url) {
 const p = url.pathname;
 if (req.method === 'OPTIONS') return send(res,200,{ok:true});

 if (p === '/api/status' && req.method === 'GET')
  return send(res,200,{ok:true,app:'N.R.S.-CASH.PRO',version:'2.0'});

 if (p === '/api/login' && req.method === 'POST') {
  try {
   const data=await bodyJSON(req);
   const username=String(data.username||'').trim();
   const password=String(data.password||'');
   if (!username || !password) return send(res,400,{error:'أدخل اسم المستخدم وكلمة المرور'});
   const user=db.prepare('SELECT * FROM users WHERE username=?').get(username);
   if (!user || !user.active || !verifyPassword(password,user.password_hash))
    return send(res,401,{error:'اسم المستخدم أو كلمة المرور غير صحيحة'});
   if (user.role !== 'super_admin') {
    const store=db.prepare('SELECT status FROM stores WHERE id=?').get(user.store_id);
    if (!store || store.status !== 'active')
     return send(res,403,{error:'هذا المحل موقوف. تواصل مع الإدارة.'});
    const sub=subInfo(user.store_id);
    if (sub?.status === 'cancelled' || sub?.status === 'expired')
     return send(res,402,{error:'الاشتراك غير نشط. تواصل مع الإدارة.'});
    startTrialIfNeeded(user.store_id);
   }
   const token=crypto.randomBytes(32).toString('base64url');
   const expires=new Date(Date.now()+7*24*60*60*1000).toISOString();
   db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(new Date().toISOString());
   db.prepare('INSERT INTO sessions(user_id,token_hash,expires_at) VALUES(?,?,?)')
    .run(user.id,sha(token),expires);
   return send(res,200,{ok:true,user:publicUser(user)},
    {'Set-Cookie':cookieHeader(req,token,7*24*60*60)});
  } catch(e) { return send(res,400,{error:e.message}); }
 }

 if (p === '/api/logout' && req.method === 'POST') {
  const token=cookieToken(req);
  if(token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha(token));
  return send(res,200,{ok:true},{'Set-Cookie':cookieHeader(req,'',0)});
 }

 const user=sessionUser(req);
 if (p === '/api/me' && req.method === 'GET')
  return user ? send(res,200,{ok:true,user:publicUser(user)}) :
   send(res,401,{error:'غير مسجل الدخول'});

 if (p.startsWith('/api/admin/')) {
  if (!requireAdmin(user,res)) return;

  if (p === '/api/admin/password' && req.method === 'POST') {
   try {
    const data = await bodyJSON(req);
    const currentPassword = String(data.currentPassword || '');
    const newPassword = String(data.newPassword || '');
    const confirmPassword = String(data.confirmPassword || '');

    const admin = db.prepare(
      "SELECT id,password_hash FROM users " +
      "WHERE id=? AND role='super_admin' AND active=1"
    ).get(user.id);

    if (!admin)
      return send(res,403,{error:'حساب المدير العام غير نشط'});

    if (!verifyPassword(currentPassword,admin.password_hash))
      return send(res,400,{error:'كلمة المرور الحالية غير صحيحة'});

    if (newPassword.length < 8)
      return send(res,400,{error:'كلمة المرور الجديدة يجب ألا تقل عن 8 أحرف'});

    if (newPassword !== confirmPassword)
      return send(res,400,{error:'تأكيد كلمة المرور غير مطابق'});

    db.prepare('UPDATE users SET password_hash=? WHERE id=?')
      .run(passwordHash(newPassword),admin.id);

    db.prepare('DELETE FROM sessions WHERE user_id=?').run(admin.id);

    return send(res,200,{
      ok:true,
      message:'تم تغيير كلمة المرور. سجّل الدخول مجددًا.'
    },{'Set-Cookie':cookieHeader(req,'',0)});
   } catch(e) {
    return send(res,400,{error:e.message});
   }
  }

  if (p === '/api/admin/overview' && req.method === 'GET') {
   const stores=db.prepare(`
    SELECT st.id,st.name,st.status,st.business_type,st.created_at,
      (SELECT username FROM users u WHERE u.store_id=st.id AND u.role='store_owner' LIMIT 1) owner,
      (SELECT status FROM subscriptions s WHERE s.store_id=st.id ORDER BY id DESC LIMIT 1) subscription_status,
      (SELECT starts_at FROM subscriptions s WHERE s.store_id=st.id ORDER BY id DESC LIMIT 1) starts_at,
      (SELECT expires_at FROM subscriptions s WHERE s.store_id=st.id ORDER BY id DESC LIMIT 1) expires_at,
      (SELECT COUNT(*) FROM products p WHERE p.store_id=st.id) products_count,
      (SELECT COUNT(*) FROM sales sa WHERE sa.store_id=st.id) sales_count,
      (SELECT COALESCE(SUM(total),0) FROM sales sa WHERE sa.store_id=st.id) sales_total
    FROM stores st ORDER BY st.id
   `).all();
   const stats={
    stores:stores.length,
    active:stores.filter(s=>s.status==='active').length,
    suspended:stores.filter(s=>s.status==='suspended').length,
    revenue:stores.reduce((n,s)=>n+Number(s.sales_total||0),0)
   };
   return send(res,200,{ok:true,stats,stores});
  }
  if (p === '/api/admin/stores' && req.method === 'POST') {
   try {
    const data=await bodyJSON(req);
    const name=String(data.name||'').trim();
    const businessType=String(data.businessType||'grocery');
    const allowedTypes=['grocery','food_wholesale','oils','metal_work','clothing','fabrics','electronics','computers','auto_parts','tires','cosmetics','perfumes','restaurant','bakery','vegetables','butcher','fish','building','hardware','quincaillerie','furniture','home_appliances','pharmacy','medical','books','barber','laundry','agriculture','repair','other'];
    if(name.length<2 || name.length>100) return send(res,400,{error:'اسم المحل مطلوب (2 إلى 100 حرف)'});
    if(!allowedTypes.includes(businessType)) return send(res,400,{error:'نوع النشاط غير صالح'});
    const username='store'+String(Date.now()).slice(-8);
    const password=crypto.randomBytes(9).toString('base64url');
    db.exec('BEGIN IMMEDIATE');
    let storeId;
    try {
     storeId=Number(db.prepare("INSERT INTO stores(name,status,business_type) VALUES(?,'active',?)").run(name,businessType).lastInsertRowid);
       db.prepare("INSERT INTO subscriptions(store_id,plan,status) VALUES(?,'monthly','pending')").run(storeId);
       db.prepare("INSERT INTO users(store_id,username,password_hash,role) VALUES(?,?,?,'store_owner')")
      .run(storeId,username,passwordHash(password));
     db.exec('COMMIT');
    } catch(e) { db.exec('ROLLBACK'); throw e; }
    return send(res,201,{ok:true,storeId,username,password,message:'احفظ كلمة المرور الآن؛ لن تُعرض مرة أخرى.'});
   } catch(e) { return send(res,400,{error:e.message}); }
  }
  const storeMatch=p.match(/^\/api\/admin\/stores\/(\d+)\/(status|subscription|rename|password|delete)$/);
  if(storeMatch && req.method==='POST') {
   try {
    const id=Number(storeMatch[1]), action=storeMatch[2], data=await bodyJSON(req);
    const store=db.prepare('SELECT * FROM stores WHERE id=?').get(id);
    if(!store) return send(res,404,{error:'المحل غير موجود'});


  if(action==='delete') {
    if(String(data.confirmName||'').trim()!==String(store.name).trim())
      return send(res,400,{error:'اسم المحل غير مطابق؛ لم يتم الحذف'});
    const ownerAdmin=db.prepare(
      "SELECT id FROM users WHERE store_id=? AND role='super_admin' LIMIT 1"
    ).get(id);
    if(ownerAdmin)
      return send(res,400,{error:'رفض الحذف: يوجد حساب مدير أعلى مرتبط بهذا المحل'});
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('DELETE FROM sale_items WHERE store_id=? OR sale_id IN (SELECT id FROM sales WHERE store_id=?)').run(id,id);
      db.prepare('DELETE FROM daily_closures WHERE store_id=?').run(id);
      db.prepare('DELETE FROM sales WHERE store_id=?').run(id);
      db.prepare('DELETE FROM products WHERE store_id=?').run(id);
      db.prepare('DELETE FROM app_settings WHERE store_id=?').run(id);
      db.prepare('DELETE FROM subscriptions WHERE store_id=?').run(id);
      db.prepare('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE store_id=?)').run(id);
      db.prepare('DELETE FROM users WHERE store_id=?').run(id);
      db.prepare('DELETE FROM stores WHERE id=?').run(id);
      db.exec('COMMIT');
      return send(res,200,{ok:true,message:'تم حذف المحل وبياناته نهائيًا'});
    } catch(err) {
      try { db.exec('ROLLBACK'); } catch {}
      throw err;
    }
  }

  if(action==='password') {
      const owner=db.prepare(
        "SELECT id,username FROM users WHERE store_id=? AND role='store_owner' ORDER BY id LIMIT 1"
      ).get(id);
      if(!owner) return send(res,404,{error:'لا يوجد حساب مالك لهذا المحل'});
      const password=String(data.password || '');
    if(password.trim().length < 6)
      return send(res,400,{error:'كلمة المرور يجب ألا تقل عن 6 أحرف'});
    db.prepare('UPDATE users SET password_hash=? WHERE id=?')
      .run(passwordHash(password),owner.id);
    db.prepare('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE store_id=?)')
      .run(id);
    return send(res,200,{
      ok:true,storeId:id,storeName:store.name,username:owner.username,
      message:'تم تغيير كلمة المرور بنجاح.'
    });
    }
    if(action==='status') {
     const status=String(data.status||'');
     if(!['active','suspended'].includes(status)) return send(res,400,{error:'حالة غير صحيحة'});
     db.prepare('UPDATE stores SET status=? WHERE id=?').run(status,id);
     if(status==='suspended')
      db.prepare('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE store_id=?)').run(id);
     return send(res,200,{ok:true});
    }
    if(action==='rename') {
     const name=String(data.name||'').trim();
     if(name.length<2 || name.length>100) return send(res,400,{error:'اسم المحل غير صالح'});
     db.prepare('UPDATE stores SET name=? WHERE id=?').run(name,id);
     return send(res,200,{ok:true});
    }
    if(action==='subscription') {
     const actionName=String(data.action||'');
     const latest=db.prepare(
      'SELECT id FROM subscriptions WHERE store_id=? ORDER BY id DESC LIMIT 1'
     ).get(id);
     if(!latest) return send(res,409,{error:'لا يوجد سجل اشتراك لهذا المحل'});
     let result;
     if(actionName==='trial') {
      const start=new Date(), end=new Date(start.getTime()+7*86400000);
      result=db.prepare(
       "UPDATE subscriptions SET status='active',starts_at=?,expires_at=? WHERE id=?"
      ).run(start.toISOString(),end.toISOString(),latest.id);
     } else if(['activate','activate_monthly','activate_yearly'].includes(actionName)) {
      const plan = actionName === 'activate_yearly' ? 'yearly' : 'monthly';
      const durationDays = plan === 'yearly' ? 365 : 30;
      const start = new Date();
      const end = new Date(start.getTime() + durationDays * 86400000);
      result = db.prepare(
       "UPDATE subscriptions SET plan=?,status='active',starts_at=?,expires_at=? WHERE id=?"
      ).run(plan,start.toISOString(),end.toISOString(),latest.id);
     } else if(actionName==='cancel') {
      result=db.prepare(
       "UPDATE subscriptions SET status='cancelled' WHERE id=?"
      ).run(latest.id);
     } else {
      return send(res,400,{error:'إجراء اشتراك غير معروف'});
     }
     if(!result || result.changes !== 1)
      return send(res,500,{error:'لم يتم تحديث الاشتراك؛ أعد المحاولة'});
     const updated=db.prepare(
      'SELECT plan,status,starts_at,expires_at FROM subscriptions WHERE id=?'
     ).get(latest.id);
     return send(res,200,{ok:true,subscription:updated});
    }
   } catch(e) { return send(res,400,{error:e.message}); }
  }
  return send(res,404,{error:'مسار الإدارة غير موجود'});
 }

 if (!requireAuth(user,res)) return;
 if (user.role === 'super_admin') {
  return send(res,403,{error:'حساب المدير العام مخصص لواجهة الإدارة'});
 }
 const storeId=user.store_id;

 if (p==='/api/settings' && req.method==='GET') {
  const rows=db.prepare('SELECT key,value FROM app_settings WHERE store_id=?').all(storeId);
  return send(res,200,Object.fromEntries(rows.map(x=>[x.key,x.value])));
 }
 if (p==='/api/settings' && req.method==='POST') {
  try {
   const d=await bodyJSON(req);
   const allowed=['shopName','phone','address','footer','manager','theme','autoCloseEnabled','autoCloseHours'];
   const save=db.prepare(`INSERT INTO app_settings(store_id,key,value,updated_at)
    VALUES(?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(store_id,key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`);
   for(const key of allowed) {
    let value=String(d[key]??'');
    if(value.length>500) return send(res,400,{error:'أحد الحقول طويل جدًا'});
    if(key==='theme' && !['green','blue','purple','amber','rose'].includes(value)) value='green';
    if(key==='autoCloseEnabled' && !['true','false'].includes(value)) value='false';
    if(key==='autoCloseHours' && !['8','10','12'].includes(value)) value='8';
    save.run(storeId,key,value);
   }
   const rows=db.prepare('SELECT key,value FROM app_settings WHERE store_id=?').all(storeId);
   return send(res,200,{ok:true,settings:Object.fromEntries(rows.map(x=>[x.key,x.value]))});
  } catch(e) { return send(res,400,{error:e.message}); }
 }

 if (p==='/api/business-profile' && req.method==='GET') {
  const store=db.prepare('SELECT id,name,business_type FROM stores WHERE id=?').get(storeId);
  if(!store) return send(res,404,{error:'المحل غير موجود'});
  return send(res,200,{ok:true,storeId:store.id,name:store.name,businessType:store.business_type||'grocery'});
 }

 if (p==='/api/products' && req.method==='GET') {
  const q=(url.searchParams.get('q')||'').trim();
  const rows=q ? db.prepare(`SELECT * FROM products WHERE store_id=? AND
   (name LIKE ? OR barcode LIKE ? OR category LIKE ?) ORDER BY name LIMIT 100`)
   .all(storeId,`%${q}%`,`%${q}%`,`%${q}%`) :
   db.prepare('SELECT * FROM products WHERE store_id=? ORDER BY name LIMIT 500').all(storeId);
  return send(res,200,rows);
 }
 if (p==='/api/products' && req.method==='POST') {
  try {
   const d=await bodyJSON(req);
   const name=String(d.name||'').trim(), price=Number(d.price);
   const stock=Math.round(Number(d.stock||0)*1000)/1000;
   const purchasePrice=Number(d.purchase_price||0);
   const packSize=Number(d.pack_size||1);
   const unit=String(d.unit||'piece');
   const businessType=db.prepare('SELECT business_type FROM stores WHERE id=?').get(storeId)?.business_type||'grocery';
   const unitsByActivity={
    grocery:['piece','carton'],
    food_wholesale:['piece','carton','kg','ton'],
    oils:['piece','carton','liter'],
    metal_work:['meter','shape','piece','kg','ton'],
    clothing:['piece','pair'],
    fabrics:['meter','piece'],
    electronics:['piece','box'],
    computers:['piece','box'],
    auto_parts:['piece','box'],
    tires:['piece','pair'],
    cosmetics:['piece','box','carton'],
    perfumes:['piece','box','carton'],
    restaurant:['piece','kg','liter'],
    bakery:['piece','kg'],
    vegetables:['piece','kg','carton'],
    butcher:['kg','piece'],
    fish:['kg','piece'],
    building:['piece'],
    hardware:['piece','box','meter'],
    quincaillerie:['piece','box','meter'],
    furniture:['piece'],
    home_appliances:['piece','box'],
    pharmacy:['piece','box'],
    medical:['piece','box'],
    books:['piece'],
    barber:['piece'],
    laundry:['piece','kg'],
    agriculture:['kg','ton','piece','bag'],
    repair:['piece','meter'],
    other:['piece','carton','meter','kg','g','liter','box','pair','bag','ton','shape']
   };
   const allowedUnits=unitsByActivity[businessType]||unitsByActivity.other;
   let barcode=String(d.barcode||'').trim()||null;
   const category=String(d.category||'عام').trim();
   if(!name || name.length>200 || !Number.isFinite(price) || price<0 ||
      !Number.isFinite(stock) || stock<0 || stock>100000000 ||
      !Number.isFinite(purchasePrice) || purchasePrice<0 ||
      !Number.isFinite(packSize) || packSize<=0 || !allowedUnits.includes(unit))
    return send(res,400,{error:'تحقق من الاسم والسعر والكمية والوحدة وسعر الشراء'});
   if(!barcode) {
    let nextId=Number(db.prepare('SELECT COALESCE(MAX(id),0)+1 AS n FROM products').get().n);
    barcode=`DZ${String(storeId).padStart(3,'0')}${String(nextId).padStart(8,'0')}`;
    while(db.prepare('SELECT 1 FROM products WHERE store_id=? AND barcode=? LIMIT 1').get(storeId,barcode)) {
     nextId++;
     barcode=`DZ${String(storeId).padStart(3,'0')}${String(nextId).padStart(8,'0')}`;
    }
   }
   const result=db.prepare(`INSERT INTO products
    (name,barcode,price,stock,category,store_id,purchase_price,unit,pack_size)
    VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(name,barcode,price,stock,category,storeId,purchasePrice,unit,packSize);
   return send(res,201,db.prepare('SELECT * FROM products WHERE id=? AND store_id=?').get(Number(result.lastInsertRowid),storeId));
  } catch(e) {
   return send(res,400,{error:e.message.includes('UNIQUE')?'هذا الباركود مسجل في هذا المحل من قبل':e.message});
  }
 }

 const productEditMatch = p.match(/^\/api\/products\/(\d+)$/);
 if (productEditMatch && req.method === 'PUT') {
  try {
   const id = Number(productEditMatch[1]);
   const d = await bodyJSON(req);
   const old = db.prepare(
    'SELECT * FROM products WHERE id=? AND store_id=?'
   ).get(id, storeId);
   if (!old) return send(res,404,{error:'المنتج غير موجود في متجرك'});

   const name = String(d.name ?? old.name).trim();
   const price = Number(d.price ?? old.price);
   const stock = Number(d.stock ?? old.stock);
   const purchasePrice = Number(d.purchase_price ?? old.purchase_price ?? 0);
   const packSize = Number(d.pack_size ?? old.pack_size ?? 1);
   const unit = String(d.unit ?? old.unit ?? 'piece');
   const category = String(d.category ?? old.category ?? 'عام').trim();
   const barcodeText = String(d.barcode ?? old.barcode ?? '').trim();
   const barcode = barcodeText || null;
   const units = ['piece','carton','kg','ton','liter','meter','shape',
                  'pair','box','bag','g'];

   if (!name || name.length > 200 ||
       !Number.isFinite(price) || price < 0 ||
       !Number.isFinite(stock) || stock < 0 || stock > 100000000 ||
       !Number.isFinite(purchasePrice) || purchasePrice < 0 ||
       !Number.isFinite(packSize) || packSize <= 0 ||
       !units.includes(unit)) {
    return send(res,400,{error:'تحقق من الاسم والسعر والكمية والوحدة وسعر الشراء'});
   }

   if (barcode && db.prepare(
       'SELECT 1 FROM products WHERE store_id=? AND barcode=? AND id<>?'
      ).get(storeId, barcode, id)) {
    return send(res,400,{error:'هذا الباركود مستخدم لمنتج آخر في متجرك'});
   }

   db.prepare(`UPDATE products
      SET name=?, barcode=?, price=?, stock=?, category=?,
          purchase_price=?, unit=?, pack_size=?
      WHERE id=? AND store_id=?`)
    .run(name,barcode,price,stock,category,purchasePrice,unit,packSize,id,storeId);

   return send(res,200,db.prepare(
    'SELECT * FROM products WHERE id=? AND store_id=?'
   ).get(id,storeId));
  } catch(e) {
   return send(res,400,{error:e.message.includes('UNIQUE')
    ? 'هذا الباركود مستخدم لمنتج آخر في متجرك' : e.message});
  }
 }


 if (p==='/api/daily-summary' && req.method==='GET') {
  const latest=db.prepare(
   'SELECT * FROM daily_closures WHERE store_id=? ORDER BY id DESC LIMIT 1'
  ).get(storeId);

  let rows;
  if(latest) {
   rows=db.prepare(
    'SELECT id,total,created_at FROM sales WHERE store_id=? AND id>? ORDER BY id DESC'
   ).all(storeId,latest.last_sale_id);
  } else {
   rows=db.prepare(
    "SELECT id,total,created_at FROM sales WHERE store_id=? AND date(created_at,'localtime')=date('now','localtime') ORDER BY id DESC"
   ).all(storeId);
  }

  const count=rows.length;
  const total=Math.round(rows.reduce((sum,x)=>sum+Number(x.total||0),0)*100)/100;
  const closures=db.prepare(
   'SELECT id,period_start_sale_id,last_sale_id,sale_count,total,sale_ids,closed_at FROM daily_closures WHERE store_id=? ORDER BY id DESC LIMIT 20'
  ).all(storeId).map(c=>({
   id:c.id,
   period_start_sale_id:c.period_start_sale_id,
   last_sale_id:c.last_sale_id,
   sale_count:c.sale_count,
   total:c.total,
   closed_at:c.closed_at,
   details:db.prepare(
    'SELECT id,total,created_at FROM sales WHERE store_id=? AND id IN ('+
    JSON.parse(c.sale_ids).map(()=>'?').join(',')+') ORDER BY id DESC'
   ).all(storeId,...JSON.parse(c.sale_ids))
  }));

  return send(res,200,{
   ok:true,count,total,
   latestSale:rows[0]||null,
   lastClosure:latest?{id:latest.id,closed_at:latest.closed_at}:null,
   closures
  });
 }

 if (p==='/api/daily-close' && req.method==='POST') {
  try {
   db.exec('BEGIN IMMEDIATE');
   try {
    const latest=db.prepare(
     'SELECT * FROM daily_closures WHERE store_id=? ORDER BY id DESC LIMIT 1'
    ).get(storeId);

    let rows;
    if(latest) {
     rows=db.prepare(
      'SELECT id,total FROM sales WHERE store_id=? AND id>? ORDER BY id'
     ).all(storeId,latest.last_sale_id);
    } else {
     rows=db.prepare(
      "SELECT id,total FROM sales WHERE store_id=? AND date(created_at,'localtime')=date('now','localtime') ORDER BY id"
     ).all(storeId);
    }

    if(!rows.length) {
     db.exec('ROLLBACK');
     return send(res,409,{error:'لا توجد فواتير جديدة لإغلاقها. لم يُنشأ تقرير مكرر.'});
    }

    const lastId=Math.max(...rows.map(x=>Number(x.id)));
    const total=Math.round(rows.reduce((sum,x)=>sum+Number(x.total||0),0)*100)/100;
    const ids=JSON.stringify(rows.map(x=>Number(x.id)));

    const result=db.prepare(
     'INSERT INTO daily_closures(store_id,period_start_sale_id,last_sale_id,sale_count,total,sale_ids) VALUES(?,?,?,?,?,?)'
    ).run(storeId,latest?latest.last_sale_id:0,lastId,rows.length,total,ids);

    db.exec('COMMIT');
    return send(res,201,{
     ok:true,
     closureId:Number(result.lastInsertRowid),
     count:rows.length,total,lastSaleId:lastId,
     message:'تم حفظ تقرير الإغلاق وبدء فترة مبيعات جديدة.'
    });
   } catch(e) {
    try{db.exec('ROLLBACK')}catch{}
    throw e;
   }
  } catch(e) {
   if(String(e.message).includes('UNIQUE'))
    return send(res,409,{error:'هذه الفترة مغلقة بالفعل.'});
   console.error('daily-close:',e);
   return send(res,500,{error:'تعذر حفظ تقرير الإغلاق'});
  }
 }

 if (p==='/api/sales' && req.method==='GET') {
  const sales=db.prepare('SELECT * FROM sales WHERE store_id=? ORDER BY id DESC LIMIT 100').all(storeId);
  const getItems=db.prepare('SELECT name,price,quantity,subtotal,unit,base_quantity FROM sale_items WHERE sale_id=? AND store_id=? ORDER BY id');
  for(const sale of sales) sale.items=getItems.all(sale.id,storeId);
  return send(res,200,sales);
 }

 if (p==='/api/sales' && req.method==='POST') {
  try {
   const data=await bodyJSON(req);
   if(!Array.isArray(data.items)||!data.items.length||data.items.length>100)
    return send(res,400,{error:'السلة فارغة أو تحتوي عددًا كبيرًا من المنتجات'});
   const items=data.items.map(x=>({
    id:Number(x.id),
    quantity:Math.round(Number(x.quantity)*1000)/1000,
    saleUnit:String(x.saleUnit||x.unit||'')
   }));
   if(items.some(x=>!Number.isSafeInteger(x.id)||x.id<1||!Number.isFinite(x.quantity)||x.quantity<=0||x.quantity>100000))
    return send(res,400,{error:'تحقق من المنتجات والكميات'});
   db.exec('BEGIN IMMEDIATE');
   try {
    const saleItems=[];
    let total=0;
    for(const x of items) {
     const product=db.prepare('SELECT * FROM products WHERE id=? AND store_id=?').get(x.id,storeId);
     if(!product) throw new Error('أحد المنتجات غير موجود في هذا المحل');

     let saleUnit=product.unit||'piece';
     let salePrice=Number(product.price);
     let stockUnits=x.quantity;

     // فقط المنتجات المسجلة بالحبة ذات العبوة المتعددة يمكن بيعها بالحبة أو بالكرتونة.
     // المنتجات القديمة المسجلة بوحدة carton لا تتغير طريقة حسابها.
     const packSize=Number(product.pack_size||1);
     if(saleUnit==='piece' && Number.isFinite(packSize) && packSize>1) {
      if(!['piece','carton'].includes(x.saleUnit))
       throw new Error('اختر البيع بالحبة أو بالكرتونة للمنتج: '+product.name);
      saleUnit=x.saleUnit;
      if(saleUnit==='carton') {
       stockUnits=x.quantity*packSize;
       salePrice=Number(product.price)*packSize;
      }
     }

     if(!Number.isFinite(stockUnits)||stockUnits<=0)
      throw new Error('كمية المخزون غير صحيحة للمنتج: '+product.name);
     if(Number(product.stock)<stockUnits)
      throw new Error('المخزون غير كافٍ للمنتج: '+product.name);

     const subtotal=Math.round(salePrice*x.quantity*100)/100;
     total+=subtotal;
     saleItems.push({
      ...product,quantity:x.quantity,subtotal,unit:saleUnit,
      price:salePrice,stockUnits
     });
    }
    total=Math.round(total*100)/100;
    const sale=db.prepare('INSERT INTO sales(total,store_id) VALUES(?,?)').run(total,storeId);
    const saleId=Number(sale.lastInsertRowid);
    const ins=db.prepare(`INSERT INTO sale_items(sale_id,product_id,name,price,quantity,subtotal,store_id,unit,base_quantity)
      VALUES(?,?,?,?,?,?,?,?,?)`);
    const upd=db.prepare('UPDATE products SET stock=stock-? WHERE id=? AND store_id=? AND stock>=?');
    for(const x of saleItems) {
     ins.run(saleId,x.id,x.name,x.price,x.quantity,x.subtotal,storeId,x.unit||'piece',x.stockUnits);
     const r=upd.run(x.stockUnits,x.id,storeId,x.stockUnits);
     if(!r.changes) throw new Error('تعذر تحديث المخزون');
    }
    db.exec('COMMIT');
    return send(res,201,{ok:true,saleId,total});
   } catch(e) { db.exec('ROLLBACK'); throw e; }
  } catch(e) { return send(res,400,{error:e.message}); }
 }

 if (p==='/api/recognize' && req.method==='POST') {
  const key=process.env.GEMINI_API_KEY;
  if(!key) return send(res,503,{error:'التعرف الذكي يحتاج إعداد GEMINI_API_KEY على الخادم.'});
  try {
   const d=await bodyJSON(req);
   const image=String(d.image||'');
   const m=image.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
   if(!m) return send(res,400,{error:'اختر صورة JPEG أو PNG أو WEBP'});
   const model=process.env.GEMINI_MODEL||'gemini-2.5-flash';
   const response=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,{
    method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':key},
    body:JSON.stringify({contents:[{parts:[
     {text:'حلل صورة منتج بقالة. أعد JSON فقط بهذا الشكل: {"name":"اسم محتمل بالعربية","category":"التصنيف","barcode":"الباركود المقروء أو فارغ","confidence":"منخفض أو متوسط أو مرتفع"}. لا تخمّن السعر ولا تؤكد العلامة التجارية إن لم تكن واضحة.'},
     {inline_data:{mime_type:m[1],data:m[2]}}
    ]}],generationConfig:{responseMimeType:'application/json'}})
   });
   const result=await response.json();
   if(!response.ok) return send(res,502,{error:result.error?.message||'تعذر الاتصال بـ Gemini'});
   return send(res,200,{ok:true,product:JSON.parse(result.candidates?.[0]?.content?.parts?.[0]?.text||'{}')});
  } catch(e) { return send(res,502,{error:e.message||'فشل التعرف على الصورة'}); }
 }
 return send(res,404,{error:'المسار غير موجود'});
}


// NRS_AUTO_DAILY_CLOSE_V1
function autoCloseDuePeriods() {
 const stores=db.prepare('SELECT DISTINCT store_id FROM sales').all();
 for (const item of stores) {
  const storeId=Number(item.store_id);
  const opts=Object.fromEntries(
   db.prepare("SELECT key,value FROM app_settings WHERE store_id=? AND key IN ('autoCloseEnabled','autoCloseHours')")
    .all(storeId).map(x=>[x.key,x.value])
  );
  if(opts.autoCloseEnabled!=='true') continue;
  const hours=[8,10,12].includes(Number(opts.autoCloseHours)) ? Number(opts.autoCloseHours) : 8;

  const latest=db.prepare(
   'SELECT * FROM daily_closures WHERE store_id=? ORDER BY id DESC LIMIT 1'
  ).get(storeId);
  let rows;
  if(latest) {
   rows=db.prepare(
    'SELECT id,total,created_at FROM sales WHERE store_id=? AND id>? ORDER BY id'
   ).all(storeId,latest.last_sale_id);
  } else {
   rows=db.prepare(
    "SELECT id,total,created_at FROM sales WHERE store_id=? AND date(created_at,'localtime')=date('now','localtime') ORDER BY id"
   ).all(storeId);
  }
  if(!rows.length) continue;

  // SQLite CURRENT_TIMESTAMP is stored in UTC; compare the first sale with UTC now.
  const firstText=String(rows[0].created_at||'');
  const firstMs=Date.parse(firstText.includes('T') ? firstText : firstText.replace(' ','T')+'Z');
  if(!Number.isFinite(firstMs) || Date.now()-firstMs < hours*60*60*1000) continue;

  try {
   db.exec('BEGIN IMMEDIATE');
   const currentLatest=db.prepare(
    'SELECT * FROM daily_closures WHERE store_id=? ORDER BY id DESC LIMIT 1'
   ).get(storeId);
   let currentRows;
   if(currentLatest) {
    currentRows=db.prepare(
     'SELECT id,total FROM sales WHERE store_id=? AND id>? ORDER BY id'
    ).all(storeId,currentLatest.last_sale_id);
   } else {
    currentRows=db.prepare(
     "SELECT id,total FROM sales WHERE store_id=? AND date(created_at,'localtime')=date('now','localtime') ORDER BY id"
    ).all(storeId);
   }
   if(!currentRows.length) {
    db.exec('ROLLBACK');
    continue;
   }
   const lastId=Math.max(...currentRows.map(x=>Number(x.id)));
   // A concurrent/manual closure may have changed the open period; re-check its age.
   const firstSale=db.prepare(
    'SELECT created_at FROM sales WHERE store_id=? AND id=?'
   ).get(storeId,Number(currentRows[0].id));
   const t=Date.parse(String(firstSale?.created_at||'').replace(' ','T')+'Z');
   if(!Number.isFinite(t) || Date.now()-t < hours*60*60*1000) {
    db.exec('ROLLBACK');
    continue;
   }
   const total=Math.round(currentRows.reduce((a,x)=>a+Number(x.total||0),0)*100)/100;
   const ids=JSON.stringify(currentRows.map(x=>Number(x.id)));
   db.prepare(
    'INSERT INTO daily_closures(store_id,period_start_sale_id,last_sale_id,sale_count,total,sale_ids) VALUES(?,?,?,?,?,?)'
   ).run(storeId,currentLatest?currentLatest.last_sale_id:0,lastId,currentRows.length,total,ids);
   db.exec('COMMIT');
   console.log('[auto-daily-close] store='+storeId+' invoices='+currentRows.length+' total='+total);
  } catch(e) {
   try { db.exec('ROLLBACK'); } catch {}
   if(!String(e.message).includes('UNIQUE')) console.error('[auto-daily-close]',e.message);
  }
 }
}
// END NRS_AUTO_DAILY_CLOSE_V1

const server=http.createServer(async(req,res)=>{
 let url;
 try { url=new URL(req.url,'http://localhost'); }
 catch { return send(res,400,{error:'عنوان غير صالح'}); }
 if(url.pathname.startsWith('/api/')) {
  try { return await api(req,res,url); }
  catch(e) { console.error(e); return send(res,500,{error:'حدث خطأ داخلي في الخادم'}); }
 }
 let file;
 if(url.pathname==='/admin' || url.pathname==='/admin/') file=path.join(PUBLIC,'admin.html');
 else {
  let pathname;
  try { pathname=decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname); }
  catch { return send(res,400,{error:'مسار غير صالح'}); }
  file=path.resolve(PUBLIC,'.'+pathname);
 }
 if(!file.startsWith(PUBLIC+path.sep)) return send(res,403,{error:'ممنوع'});
 fs.readFile(file,(err,content)=>{
  if(err) { res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'}); return res.end('Not found'); }
  const ext=path.extname(file);
  const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.webmanifest':'application/manifest+json; charset=utf-8','.json':'application/json; charset=utf-8'};
  res.writeHead(200,{'Content-Type':types[ext]||'application/octet-stream','X-Content-Type-Options':'nosniff','Cache-Control':'no-store'});
  res.end(content);
 });
});
const autoCloseTimer=setInterval(()=>{
 try { autoCloseDuePeriods(); } catch(e) { console.error('[auto-daily-close]',e.message); }
},60*1000);
if(autoCloseTimer.unref) autoCloseTimer.unref();
try { autoCloseDuePeriods(); } catch(e) { console.error('[auto-daily-close]',e.message); }

server.listen(Number(process.env.PORT||3001),'0.0.0.0',()=>{
 console.log('N.R.S.-CASH.PRO: http://127.0.0.1:'+(process.env.PORT||3001));
 console.log('Admin panel: http://127.0.0.1:'+(process.env.PORT||3001)+'/admin');
 console.log('SQLite: '+path.join(DATA,'cashier.db'));
});
