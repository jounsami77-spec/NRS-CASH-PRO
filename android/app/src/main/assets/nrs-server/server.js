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

// NRS_INVOICE_LIFECYCLE_V1
addColumn('sales','customer_name',"TEXT NOT NULL DEFAULT ''");
addColumn('sales','customer_phone',"TEXT NOT NULL DEFAULT ''");
addColumn('sales','status',"TEXT NOT NULL DEFAULT 'sold'");
addColumn('sale_items','is_cancelled','INTEGER NOT NULL DEFAULT 0');
addColumn('sale_items','cancelled_at','TEXT');

db.exec(`
CREATE TABLE IF NOT EXISTS invoice_audit (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 store_id INTEGER NOT NULL,
 sale_id INTEGER NOT NULL,
 action TEXT NOT NULL,
 details TEXT NOT NULL DEFAULT '{}',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_invoice_audit_sale
 ON invoice_audit(store_id,sale_id,id);
CREATE INDEX IF NOT EXISTS idx_sales_customer_name
 ON sales(store_id,customer_name);
CREATE INDEX IF NOT EXISTS idx_sales_customer_phone
 ON sales(store_id,customer_phone);
`);
// END NRS_INVOICE_LIFECYCLE_V1


// NRS_CLOUD_SYNC_LOCAL_SCHEMA_V1
// Local-first synchronization foundation.
// Existing numeric IDs and customer records are preserved.

addColumn('stores', 'sync_uuid', 'TEXT');
addColumn('stores', 'cloud_store_id', 'TEXT');

addColumn('products', 'sync_uuid', 'TEXT');
addColumn('sales', 'sync_uuid', 'TEXT');
addColumn('sale_items', 'sync_uuid', 'TEXT');

db.exec(`
CREATE TABLE IF NOT EXISTS sync_outbox (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 event_uuid TEXT NOT NULL UNIQUE,
 store_id INTEGER NOT NULL,
 entity_type TEXT NOT NULL,
 entity_uuid TEXT NOT NULL,
 operation TEXT NOT NULL,
 payload_json TEXT NOT NULL,
 created_at TEXT NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0,
 last_error TEXT,
 synced_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_sync_outbox_pending
 ON sync_outbox(store_id, synced_at, id);

CREATE INDEX IF NOT EXISTS idx_sync_outbox_entity
 ON sync_outbox(store_id, entity_type, entity_uuid);

CREATE TABLE IF NOT EXISTS sync_state (
 store_id INTEGER PRIMARY KEY,
 cloud_store_id TEXT,
 device_id TEXT,
 device_token TEXT,
 pull_cursor INTEGER NOT NULL DEFAULT 0,
 last_sync_at TEXT,
 last_error TEXT,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sync_applied_events (
 event_uuid TEXT PRIMARY KEY,
 store_id INTEGER NOT NULL,
 server_seq INTEGER,
 source_device_id TEXT,
 entity_type TEXT NOT NULL,
 entity_uuid TEXT NOT NULL,
 operation TEXT NOT NULL,
 applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_applied_store_seq
 ON sync_applied_events(store_id,server_seq)
 WHERE server_seq IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sync_applied_store_time
 ON sync_applied_events(store_id,applied_at);
`);

function nrsEnsureUuid(value) {
 return value || crypto.randomUUID();
}

// Stable UUIDs are assigned once and never derived from local numeric IDs.
db.exec('BEGIN IMMEDIATE');
try {
 const stores = db.prepare(
  'SELECT id,sync_uuid FROM stores ORDER BY id'
 ).all();

 const setStore = db.prepare(
  'UPDATE stores SET sync_uuid=? WHERE id=? AND sync_uuid IS NULL'
 );

 for (const row of stores) {
  setStore.run(nrsEnsureUuid(row.sync_uuid), row.id);
 }

 const products = db.prepare(
  'SELECT id,sync_uuid FROM products WHERE sync_uuid IS NULL ORDER BY id'
 ).all();

 const setProduct = db.prepare(
  'UPDATE products SET sync_uuid=? WHERE id=? AND sync_uuid IS NULL'
 );

 for (const row of products) {
  setProduct.run(crypto.randomUUID(), row.id);
 }

 const sales = db.prepare(
  'SELECT id,sync_uuid FROM sales WHERE sync_uuid IS NULL ORDER BY id'
 ).all();

 const setSale = db.prepare(
  'UPDATE sales SET sync_uuid=? WHERE id=? AND sync_uuid IS NULL'
 );

 for (const row of sales) {
  setSale.run(crypto.randomUUID(), row.id);
 }

 const items = db.prepare(
  'SELECT id,sync_uuid FROM sale_items WHERE sync_uuid IS NULL ORDER BY id'
 ).all();

 const setItem = db.prepare(
  'UPDATE sale_items SET sync_uuid=? WHERE id=? AND sync_uuid IS NULL'
 );

 for (const row of items) {
  setItem.run(crypto.randomUUID(), row.id);
 }

 // Create local sync state without enrolling or contacting the cloud.
 db.prepare(`
  INSERT OR IGNORE INTO sync_state(store_id)
  SELECT id FROM stores
 `).run();

 db.exec('COMMIT');
} catch (e) {
 try { db.exec('ROLLBACK'); } catch (_) {}
 throw e;
}

// UUID lookup helpers for subsequent transactional event capture.
function nrsProductSyncUuid(productId, currentStoreId) {
 const row = db.prepare(
  'SELECT sync_uuid FROM products WHERE id=? AND store_id=?'
 ).get(productId, currentStoreId);

 return row?.sync_uuid || null;
}

function nrsEnqueueSyncEvent(currentStoreId, entityType, entityUuid,
                             operation, payload, eventUuid) {
 if (!Number.isSafeInteger(Number(currentStoreId)) ||
     Number(currentStoreId) < 1) {
  throw new Error('Invalid local store ID for sync event');
 }

 if (!['product', 'sale'].includes(entityType)) {
  throw new Error('Unsupported sync entity type');
 }

 if (typeof entityUuid !== 'string' ||
     !/^[0-9a-f-]{36}$/i.test(entityUuid)) {
  throw new Error('Invalid sync entity UUID');
 }

 if (!payload || typeof payload !== 'object' ||
     Array.isArray(payload)) {
  throw new Error('Invalid sync event payload');
 }

 const id = eventUuid || crypto.randomUUID();

 db.prepare(`
  INSERT INTO sync_outbox
   (event_uuid,store_id,entity_type,entity_uuid,operation,
    payload_json,created_at)
  VALUES(?,?,?,?,?,?,?)
 `).run(
  id,
  Number(currentStoreId),
  entityType,
  entityUuid,
  operation,
  JSON.stringify(payload),
  new Date().toISOString()
 );

 return id;
}

// Build a complete sale snapshot compatible with the cloud Worker.
function nrsEnqueueSaleSnapshot(currentStoreId, saleId, stockDeltas) {
 const sale = db.prepare(`
  SELECT sync_uuid,total,status,created_at,customer_name,customer_phone
  FROM sales WHERE id=? AND store_id=?
 `).get(saleId, currentStoreId);

 if (!sale || !sale.sync_uuid) {
  throw new Error('Sale sync identity is missing');
 }

 const lines = db.prepare(`
  SELECT si.sync_uuid AS line_sync_uuid,
         si.name,si.quantity,si.base_quantity,si.unit,
         si.price,si.subtotal,si.is_cancelled,si.cancelled_at,
         p.sync_uuid AS product_sync_uuid
  FROM sale_items si
  LEFT JOIN products p
    ON p.id=si.product_id AND p.store_id=si.store_id
  WHERE si.sale_id=? AND si.store_id=?
  ORDER BY si.id
 `).all(saleId, currentStoreId);

 if (!lines.length || lines.length > 200) {
  throw new Error('Sale snapshot line count is invalid');
 }

 const items = lines.map(line => {
  if (!line.line_sync_uuid) {
   throw new Error('Sale line sync identity is missing');
  }

  return {
   line_sync_uuid: line.line_sync_uuid,
   product_sync_uuid: line.product_sync_uuid || null,
   name: String(line.name),
   quantity: Number(line.quantity),
   base_quantity: Number(line.base_quantity || 0),
    unit: String(line.unit || 'piece').slice(0,40),
   price: Number(line.price),
   subtotal: Number(line.subtotal),
   is_cancelled: Number(line.is_cancelled) === 1,
   cancelled_at: line.cancelled_at || null
  };
 });

 const payload = {
  sync_uuid: sale.sync_uuid,
  total: Number(sale.total),
  status: sale.status,
  created_at: sale.created_at || new Date().toISOString(),
  customer_name: sale.customer_name || '',
  customer_phone: sale.customer_phone || '',
  items,
  stock_deltas: stockDeltas
 };

 return nrsEnqueueSyncEvent(
  currentStoreId,
  'sale',
  sale.sync_uuid,
  'snapshot',
  payload
 );
}

// Aggregate stock movements by stable product UUID.
// Positive delta restores stock; negative delta deducts stock.
function nrsBuildStockDeltas(currentStoreId, movements) {
 const totals = new Map();

 for (const movement of movements) {
  const productId = Number(movement.product_id);
  const delta = Number(movement.delta);

  if (!Number.isSafeInteger(productId) || productId < 1 ||
      !Number.isFinite(delta) || delta === 0) {
   throw new Error('Invalid invoice stock movement');
  }

  const productUuid = nrsProductSyncUuid(productId, currentStoreId);
  if (!productUuid) {
   throw new Error('Product sync identity is missing: ' + productId);
  }

  const next = (totals.get(productUuid) || 0) + delta;
  totals.set(productUuid, Math.round(next * 1000) / 1000);
 }

 const result = [...totals.entries()]
  .filter(([, delta]) => delta !== 0)
  .map(([product_sync_uuid, delta]) => ({product_sync_uuid, delta}));

 if (result.length > 200) {
  throw new Error('Invoice stock movement count exceeds sync limit');
 }

 return result;
}

// END NRS_CLOUD_SYNC_LOCAL_SCHEMA_V1

// NRS_CLOUD_SYNC_URL_MIGRATION_V1
{
 const columns = db.prepare("PRAGMA table_info(sync_state)").all();
 if (!columns.some(c => c.name === 'cloud_url')) {
  db.exec("ALTER TABLE sync_state ADD COLUMN cloud_url TEXT NOT NULL DEFAULT ''");
 }
}
// END NRS_CLOUD_SYNC_URL_MIGRATION_V1




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
    store_id INTEGER NOT NULL DEFAULT 1,
    brand TEXT NOT NULL DEFAULT '',
    purchase_price REAL NOT NULL DEFAULT 0,
    unit TEXT NOT NULL DEFAULT 'piece',
    pack_size REAL NOT NULL DEFAULT 1,
    sync_uuid TEXT
   );
   INSERT INTO products(
    id,name,barcode,price,stock,category,created_at,store_id,
    brand,purchase_price,unit,pack_size,sync_uuid
   )
   SELECT
    id,name,barcode,price,stock,category,created_at,store_id,
    brand,purchase_price,unit,pack_size,sync_uuid
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
if (process.env.NODE_ENV !== 'production' && db.prepare('SELECT COUNT(*) n FROM products').get().n === 0) {
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


/* NRS_CLOUD_SYNC_ENGINE_V2 */
const nrsCloudSyncLocks = new Set();

function nrsSyncUrl(base, suffix) {
  const u = new URL(base);
  if (u.protocol !== 'https:') throw new Error('Worker يجب أن يستخدم HTTPS');
  return u.origin + suffix;
}

async function nrsSyncFetch(url, token, options={}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(25000),
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  let data;
  try { data = await response.json(); }
  catch { throw new Error('استجابة Worker غير صالحة'); }
  if (!response.ok || data?.ok !== true)
    throw new Error(String(data?.error || ('Worker HTTP ' + response.status)).slice(0,400));
  return data;
}

function nrsSyncApplyEvent(storeId, event) {
  const eventUuid = String(event.event_uuid || '');
  const entityType = String(event.entity_type || '');
  const entityUuid = String(event.entity_uuid || '');
  const operation = String(event.operation || '');
  const seq = Number(event.seq);
  const payload = typeof event.payload === 'string'
    ? JSON.parse(event.payload)
    : (event.payload ?? (event.payload_json ? JSON.parse(event.payload_json) : null));

  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  if (!uuidPattern.test(eventUuid) ||
      !uuidPattern.test(entityUuid) ||
      !Number.isSafeInteger(seq) || seq < 1 ||
      !payload || typeof payload !== 'object' || Array.isArray(payload))
    throw new Error('حدث سحابي غير صالح');

  if (db.prepare(
    'SELECT 1 FROM sync_applied_events WHERE event_uuid=? AND store_id=?'
  ).get(eventUuid, storeId)) return;

  if (entityType === 'product') {
    if (payload.sync_uuid !== entityUuid)
      throw new Error('هوية المنتج غير متطابقة');

    if (operation === 'create') {
      const existing = db.prepare(
        'SELECT id FROM products WHERE store_id=? AND sync_uuid=?'
      ).get(storeId, entityUuid);

      if (!existing) {
        const name = String(payload.name || '').trim();
        const price = Number(payload.price);
        const stock = Number(payload.initial_stock ?? 0);
        const purchase = Number(payload.purchase_price || 0);
        const pack = Number(payload.pack_size || 1);

        if (!name || name.length > 200 ||
            !Number.isFinite(price) || price < 0 ||
            !Number.isFinite(stock) || stock < 0 ||
            !Number.isFinite(purchase) || purchase < 0 ||
            !Number.isFinite(pack) || pack <= 0)
          throw new Error('بيانات إنشاء المنتج غير سليمة');

        db.prepare(
          'INSERT INTO products (name,barcode,price,stock,category,store_id,purchase_price,unit,pack_size,sync_uuid) VALUES(?,?,?,?,?,?,?,?,?,?)'
        ).run(
          name,
          payload.barcode ? String(payload.barcode) : null,
          price, stock,
          String(payload.category || 'عام'),
          storeId, purchase,
          String(payload.unit || 'piece'), pack,
          entityUuid
        );
      }
    } else if (operation === 'update') {
      const product = db.prepare(
        'SELECT id FROM products WHERE store_id=? AND sync_uuid=?'
      ).get(storeId, entityUuid);
      if (!product) throw new Error('المنتج غير موجود لتطبيق التعديل');

      const name = String(payload.name || '').trim();
      const price = Number(payload.price);
      const purchase = Number(payload.purchase_price || 0);
      const pack = Number(payload.pack_size || 1);

      if (!name || name.length > 200 ||
          !Number.isFinite(price) || price < 0 ||
          !Number.isFinite(purchase) || purchase < 0 ||
          !Number.isFinite(pack) || pack <= 0)
        throw new Error('بيانات تعديل المنتج غير سليمة');

      db.prepare(
        'UPDATE products SET name=?,barcode=?,price=?,category=?,purchase_price=?,unit=?,pack_size=? WHERE store_id=? AND sync_uuid=?'
      ).run(
        name,
        payload.barcode ? String(payload.barcode) : null,
        price, String(payload.category || 'عام'),
        purchase, String(payload.unit || 'piece'), pack,
        storeId, entityUuid
      );
    } else if (operation === 'stock.adjust') {
      const delta = Number(payload.delta);
      if (!Number.isFinite(delta) || delta === 0)
        throw new Error('حركة مخزون غير صالحة');

      const product = db.prepare(
        'SELECT id,stock FROM products WHERE store_id=? AND sync_uuid=?'
      ).get(storeId, entityUuid);
      if (!product) throw new Error('المنتج غير موجود لحركة المخزون');

      const next = Math.round((Number(product.stock) + delta) * 1000) / 1000;
      if (!Number.isFinite(next) || next < 0)
        throw new Error('حركة المخزون ستنتج كمية سالبة');

      db.prepare(
        'UPDATE products SET stock=? WHERE id=? AND store_id=?'
      ).run(next, product.id, storeId);
    } else if (operation === 'delete') {
      const product = db.prepare(
        'SELECT id FROM products WHERE store_id=? AND sync_uuid=?'
      ).get(storeId, entityUuid);

      if (product) {
        db.prepare(
          'UPDATE sale_items SET product_id=NULL WHERE product_id=? AND store_id=?'
        ).run(product.id, storeId);
        db.prepare(
          'DELETE FROM products WHERE id=? AND store_id=?'
        ).run(product.id, storeId);
      }
    } else {
      throw new Error('عملية المنتج غير مدعومة: ' + operation);
    }

  } else if (entityType === 'sale' && operation === 'snapshot') {
    if (payload.sync_uuid !== entityUuid ||
        !Array.isArray(payload.items) ||
        payload.items.length < 1 || payload.items.length > 200)
      throw new Error('لقطة الفاتورة غير صالحة');

    if (!['sold','exchanged','returned','cancelled'].includes(payload.status))
      throw new Error('حالة الفاتورة غير صالحة');

    const total = Number(payload.total);
    if (!Number.isFinite(total) || total < 0)
      throw new Error('مجموع الفاتورة غير صالح');

    let sale = db.prepare(
      'SELECT id FROM sales WHERE store_id=? AND sync_uuid=?'
    ).get(storeId, entityUuid);

    if (!sale) {
      const result = db.prepare(
        'INSERT INTO sales (total,created_at,store_id,customer_name,customer_phone,status,sync_uuid) VALUES(?,?,?,?,?,?,?)'
      ).run(
        total,
        String(payload.created_at || new Date().toISOString()),
        storeId,
        String(payload.customer_name || '').slice(0,120),
        String(payload.customer_phone || '').slice(0,40),
        payload.status, entityUuid
      );
      sale = { id: Number(result.lastInsertRowid) };
    } else {
      db.prepare(
        'UPDATE sales SET total=?,customer_name=?,customer_phone=?,status=? WHERE id=? AND store_id=?'
      ).run(
        total,
        String(payload.customer_name || '').slice(0,120),
        String(payload.customer_phone || '').slice(0,40),
        payload.status, sale.id, storeId
      );
    }

    const existingLines = db.prepare(
      'SELECT id,sync_uuid FROM sale_items WHERE sale_id=? AND store_id=?'
    ).all(sale.id, storeId);

    const incoming = new Set();

    const insertLine = db.prepare(
      'INSERT INTO sale_items (sale_id,product_id,name,price,quantity,subtotal,store_id,unit,base_quantity,sync_uuid,is_cancelled,cancelled_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)'
    );

    const updateLine = db.prepare(
      'UPDATE sale_items SET product_id=?,name=?,price=?,quantity=?,subtotal=?,unit=?,base_quantity=?,is_cancelled=?,cancelled_at=? WHERE id=? AND sale_id=? AND store_id=?'
    );

    for (const item of payload.items) {
      const lineUuid = String(item.line_sync_uuid || '');
      if (!uuidPattern.test(lineUuid) || incoming.has(lineUuid))
        throw new Error('معرّف بند الفاتورة مكرر أو غير صالح');
      incoming.add(lineUuid);

      const quantity = Number(item.quantity);
      const base = Number(item.base_quantity);
      const price = Number(item.price);
      const subtotal = Number(item.subtotal);

      if (!Number.isFinite(quantity) || quantity <= 0 ||
          !Number.isFinite(base) || base < 0 ||
          !Number.isFinite(price) || price < 0 ||
          !Number.isFinite(subtotal) || subtotal < 0)
        throw new Error('قيم بند الفاتورة غير صالحة');

      let productId = null;
      if (item.product_sync_uuid) {
        const product = db.prepare(
          'SELECT id FROM products WHERE store_id=? AND sync_uuid=?'
        ).get(storeId, String(item.product_sync_uuid));
        if (product) productId = product.id;
      }

      const oldLine = existingLines.find(x => x.sync_uuid === lineUuid);

      const values = [
        productId,
        String(item.name || '').slice(0,200),
        price, quantity, subtotal,
        String(item.unit || 'piece'), base,
        item.is_cancelled ? 1 : 0,
        item.cancelled_at || null
      ];

      if (oldLine) {
        updateLine.run(...values, oldLine.id, sale.id, storeId);
      } else {
        insertLine.run(
          sale.id,
          ...values.slice(0,5),
          storeId,
          values[5],
          values[6],
          lineUuid,
          values[7],
          values[8]
        );
      }
    }

    for (const oldLine of existingLines) {
      if (!incoming.has(oldLine.sync_uuid)) {
        db.prepare(
          'DELETE FROM sale_items WHERE id=? AND sale_id=? AND store_id=?'
        ).run(oldLine.id, sale.id, storeId);
      }
    }

    if (!Array.isArray(payload.stock_deltas) || payload.stock_deltas.length > 200)
      throw new Error('حركات مخزون الفاتورة غير صالحة');

    const seenProducts = new Set();

    for (const movement of payload.stock_deltas) {
      const productUuid = String(movement.product_sync_uuid || '');
      const delta = Number(movement.delta);

      if (!uuidPattern.test(productUuid) ||
          !Number.isFinite(delta) || delta === 0 ||
          seenProducts.has(productUuid))
        throw new Error('حركة مخزون مكررة أو غير صالحة');

      seenProducts.add(productUuid);

      const product = db.prepare(
        'SELECT id,stock FROM products WHERE store_id=? AND sync_uuid=?'
      ).get(storeId, productUuid);

      if (!product) throw new Error('منتج حركة الفاتورة غير موجود');

      const next = Math.round((Number(product.stock) + delta) * 1000) / 1000;
      if (!Number.isFinite(next) || next < 0)
        throw new Error('حركة الفاتورة ستنتج مخزوناً سالباً');

      db.prepare(
        'UPDATE products SET stock=? WHERE id=? AND store_id=?'
      ).run(next, product.id, storeId);
    }

  } else {
    throw new Error('نوع حدث غير مدعوم');
  }

  db.prepare(
    'INSERT INTO sync_applied_events (event_uuid,store_id,server_seq,source_device_id,entity_type,entity_uuid,operation) VALUES(?,?,?,?,?,?,?)'
  ).run(
    eventUuid, storeId, seq,
    event.source_device_id || null,
    entityType, entityUuid, operation
  );
}

async function nrsRunCloudSync(storeId) {
  if (nrsCloudSyncLocks.has(storeId))
    throw new Error('المزامنة جارية بالفعل');

  nrsCloudSyncLocks.add(storeId);

  try {
    const state = db.prepare(
      'SELECT * FROM sync_state WHERE store_id=?'
    ).get(storeId);

    if (!state || !state.cloud_store_id || !state.device_id ||
        !state.device_token || !state.cloud_url)
      throw new Error('المحل غير مقترن بالسحابة');

    const base = String(state.cloud_url).replace(/\/+$/, '');
    const token = String(state.device_token);

    const resultSummary = {
      pushed: 0,
      pulled: 0,
      cursor: Number(state.pull_cursor || 0)
    };

    const pending = db.prepare(
      'SELECT event_uuid,entity_type,entity_uuid,operation,payload_json,created_at FROM sync_outbox WHERE store_id=? AND synced_at IS NULL ORDER BY id LIMIT 100'
    ).all(storeId);

    if (pending.length) {
      const events = pending.map(row => ({
        event_uuid: row.event_uuid,
        entity_type: row.entity_type,
        entity_uuid: row.entity_uuid,
        operation: row.operation,
        payload: JSON.parse(row.payload_json),
        created_at: row.created_at
      }));

      try {
        const pushResponse = await nrsSyncFetch(
          nrsSyncUrl(base, '/v1/sync/push'),
          token,
          { method: 'POST', body: JSON.stringify({ events }) }
        );

        // Accept the push only when every submitted event has an exact acknowledgement.
        const acknowledgements = pushResponse?.acknowledgements;
        if (!Array.isArray(acknowledgements) ||
            acknowledgements.length !== pending.length ||
            Number(pushResponse.accepted) !== pending.length) {
          throw new Error('إقرار المزامنة السحابية ناقص أو غير صالح؛ لم يتم اعتماد أي حدث');
        }

        const expectedIds = new Set(pending.map(row => row.event_uuid));
        const acknowledgedIds = new Set();

        for (const ack of acknowledgements) {
          if (!ack || typeof ack.event_uuid !== 'string' ||
              ack.accepted !== true ||
              typeof ack.duplicate !== 'boolean' ||
              !expectedIds.has(ack.event_uuid) ||
              acknowledgedIds.has(ack.event_uuid)) {
            throw new Error('إقرار حدث سحابي غير صالح أو مكرر؛ لم يتم اعتماد الأحداث');
          }
          acknowledgedIds.add(ack.event_uuid);
        }

        if (acknowledgedIds.size !== expectedIds.size) {
          throw new Error('لم يتم تأكيد جميع أحداث المزامنة؛ بقيت الأحداث معلّقة');
        }

        db.exec('BEGIN IMMEDIATE');
        try {
          const mark = db.prepare(
            'UPDATE sync_outbox SET synced_at=?,last_error=NULL WHERE store_id=? AND event_uuid=? AND synced_at IS NULL'
          );
          const now = new Date().toISOString();

          for (const row of pending) {
            const result = mark.run(now, storeId, row.event_uuid);
            if (Number(result.changes) !== 1) {
              throw new Error('تعذر اعتماد حدث المزامنة محلياً: ' + row.event_uuid);
            }
            resultSummary.pushed++;
          }

          db.exec('COMMIT');
        } catch (e) {
          try { db.exec('ROLLBACK'); } catch {}
          throw e;
        }
      } catch (e) {
        db.prepare(
          'UPDATE sync_outbox SET attempts=attempts+1,last_error=? WHERE store_id=? AND synced_at IS NULL'
        ).run(String(e.message || e).slice(0,500), storeId);
        throw e;
      }
    }

    for (let page = 0; page < 10; page++) {
      const current = Number(db.prepare(
        'SELECT pull_cursor FROM sync_state WHERE store_id=?'
      ).get(storeId)?.pull_cursor || 0);

      const url = nrsSyncUrl(
        base,
        '/v1/sync/pull?after=' + encodeURIComponent(current) + '&limit=200'
      );

      const response = await nrsSyncFetch(url, token, { method: 'GET' });

      if (!Array.isArray(response.events))
        throw new Error('قائمة أحداث السحابة غير صالحة');

      const next = Number(response.next_cursor);
      if (!Number.isSafeInteger(next) || next < current)
        throw new Error('مؤشر المزامنة غير صالح');

      db.exec('BEGIN IMMEDIATE');
      try {
        let previous = current;

        for (const event of response.events) {
          const seq = Number(event.seq);
          if (!Number.isSafeInteger(seq) || seq <= previous || seq > next)
            throw new Error('ترتيب أحداث السحابة غير صحيح');

          previous = seq;
          nrsSyncApplyEvent(storeId, event);
          resultSummary.pulled++;
        }

        db.prepare(
          'UPDATE sync_state SET pull_cursor=?,last_sync_at=?,last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE store_id=?'
        ).run(next, new Date().toISOString(), storeId);

        db.exec('COMMIT');
        resultSummary.cursor = next;
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch {}
        throw e;
      }

      if (next === current || response.events.length === 0) break;
    }

    db.prepare(
      'UPDATE sync_state SET last_sync_at=?,last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE store_id=?'
    ).run(new Date().toISOString(), storeId);

    return resultSummary;

  } catch (e) {
    try {
      db.prepare(
        'UPDATE sync_state SET last_error=?,updated_at=CURRENT_TIMESTAMP WHERE store_id=?'
      ).run(String(e.message || e).slice(0,500), storeId);
    } catch {}
    throw e;
  } finally {
    nrsCloudSyncLocks.delete(storeId);
  }
}
/* END NRS_CLOUD_SYNC_ENGINE_V2 */

async function api(req,res,url) {
 const p = url.pathname;
 if (process.env.NRS_APP_EDITION === 'customer' && p.startsWith('/api/admin/'))
  return send(res,404,{error:'هذه الواجهة غير متاحة في نسخة الزبون'});
 if (req.method === 'OPTIONS') return send(res,200,{ok:true});

 if (p === '/api/status' && req.method === 'GET')
  return send(res,200,{ok:true,app:'cash.pro.S.M.G.R',version:'2.0',edition:process.env.NRS_APP_EDITION || 'owner'});

 if (p === '/api/login' && req.method === 'POST') {
  try {
   const data=await bodyJSON(req);
   const username=String(data.username||'').trim();
   const password=String(data.password||'');
   if (!username || !password) return send(res,400,{error:'أدخل اسم المستخدم وكلمة المرور'});
   const user=db.prepare('SELECT * FROM users WHERE username=?').get(username);
   if (process.env.NRS_APP_EDITION === 'customer' && user?.role === 'super_admin')
    return send(res,403,{error:'حساب الإدارة غير مسموح في نسخة الزبون'});
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

 // Unified application: store owners can use store operations.
 // The super_admin account remains restricted to administration below.

 if (user.role === 'super_admin') {
  return send(res,403,{error:'حساب المدير العام مخصص لواجهة الإدارة'});
 }
 const storeId=user.store_id;


 // NRS_CLOUD_DEVICE_ENROLL_V1

 if (p === '/api/cloud-sync/run' && req.method === 'POST') {
  if (!user || user.role === 'super_admin')
   return send(res,403,{error:'المزامنة متاحة لحسابات المحلات فقط'});
  try {
   const result = await nrsRunCloudSync(storeId);
   return send(res,200,{ok:true,...result});
  } catch(e) {
   return send(res,502,{ok:false,error:String(e.message || e)});
  }
 }

 if (p === '/api/cloud-sync/enroll' && req.method === 'POST') {
  if (process.env.NRS_APP_EDITION === 'customer') {
   return send(res,403,{error:'إقران المحل متاح من نسخة المالك فقط'});
  }

  if (user.role !== 'store_owner') {
   return send(res,403,{error:'يجب تسجيل الدخول بحساب مالك المحل'});
  }

  let data;
  try {
   data = await bodyJSON(req);
  } catch (e) {
   return send(res,400,{error:e.message});
  }

  const workerUrl = String(data.workerUrl || '').trim().replace(/\/+$/,'');
  const pairingCode = String(data.pairingCode || '').trim();
  const deviceName = String(data.deviceName || 'NRS Owner Device').trim();

  if (!workerUrl || !pairingCode) {
   return send(res,400,{error:'أدخل عنوان Worker ورمز الاقتران'});
  }

  let parsed;
  try {
   parsed = new URL(workerUrl);
  } catch {
   return send(res,400,{error:'عنوان Worker غير صالح'});
  }

  if (
   parsed.protocol !== 'https:' ||
   parsed.username ||
   parsed.password ||
   parsed.search ||
   parsed.hash ||
   parsed.pathname !== '/' ||
   parsed.hostname === 'localhost' ||
   parsed.hostname.endsWith('.local')
  ) {
   return send(res,400,{error:'يجب إدخال عنوان HTTPS صحيح لـ Cloudflare Worker'});
  }

  if (pairingCode.length < 12 || pairingCode.length > 256) {
   return send(res,400,{error:'رمز الاقتران غير صالح'});
  }

  if (deviceName.length < 2 || deviceName.length > 80) {
   return send(res,400,{error:'اسم الجهاز يجب أن يكون بين حرفين و80 حرفًا'});
  }

  try {
   const endpoint = workerUrl + '/v1/device/enroll';

   const response = await fetch(endpoint,{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({
     pairing_code:pairingCode,
     device_name:deviceName
    }),
    signal:AbortSignal.timeout(20000)
   });

   let result;
   try {
    result = await response.json();
   } catch {
    result = {};
   }

   if (!response.ok || !result.ok || !result.device_token) {
    const message = String(result.error || result.message || 'رفض Worker تسجيل الجهاز');
    return send(res,response.status >= 400 && response.status < 500 ? response.status : 502,{
     error:message.slice(0,300)
    });
   }

   const cloudStoreId = String(result.store_id || result.storeId || '').trim();
   const deviceId = String(result.device_id || result.deviceId || '').trim();
   const deviceToken = String(result.device_token || '').trim();

   if (!cloudStoreId || !deviceId || !deviceToken) {
    return send(res,502,{
     error:'استجابة Worker ناقصة: يلزم store_id وdevice_id وdevice_token. لم يتم حفظ الاقتران.'
    });
   }

   // Preserve existing enrollment identity and cursor.
   const existingSyncState = db.prepare(
    'SELECT cloud_store_id,device_id,cloud_url FROM sync_state WHERE store_id=?'
   ).get(storeId);

   if (existingSyncState) {
    const sameEnrollment =
     String(existingSyncState.cloud_store_id || '') === cloudStoreId &&
     String(existingSyncState.device_id || '') === deviceId &&
     String(existingSyncState.cloud_url || '').replace(/\/+$/, '') === workerUrl;

    if (!sameEnrollment) {
     return send(res,409,{
      error:'هوية الجهاز أو الخادم السحابي مختلفة. يلزم ترحيل آمن قبل إعادة الاقتران.'
     });
    }
   }

   // Save enrollment without resetting the local synchronization cursor.
   db.prepare(`
    INSERT INTO sync_state(
     store_id,cloud_store_id,device_id,device_token,
     cloud_url,pull_cursor,last_sync_at,last_error,updated_at
    )
    VALUES(?,?,?,?,?,0,NULL,NULL,CURRENT_TIMESTAMP)
    ON CONFLICT(store_id) DO UPDATE SET
     cloud_store_id=excluded.cloud_store_id,
     device_id=excluded.device_id,
     device_token=excluded.device_token,
     cloud_url=excluded.cloud_url,
     pull_cursor=sync_state.pull_cursor,
     last_sync_at=sync_state.last_sync_at,
     last_error=NULL,
     updated_at=CURRENT_TIMESTAMP
   `).run(
    storeId,
    cloudStoreId,
    deviceId,
    deviceToken,
    workerUrl
   );

   return send(res,200,{
    ok:true,
    paired:true,
    cloudStoreId,
    deviceId,
    message:'تم تسجيل هذا الجهاز في المحل السحابي. لم تُنقل البيانات القديمة بعد.'
   });

  } catch(e) {
   console.error('[NRS cloud enrollment]',String(e.message || e).slice(0,300));
   return send(res,502,{
    error:'تعذر الاتصال بخدمة الاقتران. تحقق من الإنترنت وعنوان Worker وصلاحية الرمز.'
   });
  }
 }
 // END NRS_CLOUD_DEVICE_ENROLL_V1

 // NRS_CLOUD_DEVICE_STATUS_V1
 if (p === '/api/cloud-sync/status' && req.method === 'GET') {
  const state = db.prepare(`
   SELECT cloud_store_id,device_id,cloud_url,pull_cursor,last_sync_at,last_error
   FROM sync_state WHERE store_id=?
  `).get(storeId);

  return send(res,200,{
   ok:true,
   paired:!!(state && state.cloud_store_id && state.device_id && state.cloud_url),
   cloudStoreId:state?.cloud_store_id || null,
   deviceId:state?.device_id || null,
   cloudUrl:state?.cloud_url || null,
   pullCursor:Number(state?.pull_cursor || 0),
   lastSyncAt:state?.last_sync_at || null,
   lastError:state?.last_error || null
  });
 }
 // END NRS_CLOUD_DEVICE_STATUS_V1

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


// NRS_BULK_ENSURE_PRODUCT_BARCODES_V1
if (p==='/api/products/ensure-barcodes' && req.method==='POST') {
  let transactionOpen = false;

  try {
    db.exec('BEGIN IMMEDIATE');
    transactionOpen = true;

    const missing = db.prepare(`
      SELECT id
      FROM products
      WHERE store_id=?
        AND (barcode IS NULL OR trim(barcode)='')
      ORDER BY id
    `).all(storeId);

    let nextId = Number(
      db.prepare(
        'SELECT COALESCE(MAX(id),0)+1 AS n FROM products'
      ).get().n
    );

    const exists = db.prepare(
      'SELECT 1 FROM products WHERE store_id=? AND barcode=? LIMIT 1'
    );

    const update = db.prepare(`
      UPDATE products
      SET barcode=?
      WHERE id=?
        AND store_id=?
        AND (barcode IS NULL OR trim(barcode)='')
    `);

    for (const product of missing) {
      let barcode;

      do {
        barcode =
          'DZ' +
          String(storeId).padStart(3,'0') +
          String(nextId).padStart(8,'0');
        nextId++;
      } while (exists.get(storeId, barcode));

      const result = update.run(
        barcode,
        product.id,
        storeId
      );

      if (result.changes !== 1) {
        throw new Error(
          'تعذر حفظ باركود المنتج رقم ' + product.id
        );
      }
    }

    const rows = db.prepare(`
      SELECT *
      FROM products
      WHERE store_id=?
      ORDER BY name
    `).all(storeId);

    db.exec('COMMIT');
    transactionOpen = false;

    return send(res, 200, {
      ok: true,
      updatedCount: missing.length,
      products: rows
    });

  } catch (e) {
    if (transactionOpen) {
      try { db.exec('ROLLBACK'); } catch (_) {}
    }

    return send(res, 500, {
      error: e.message || 'تعذر إنشاء باركودات المنتجات'
    });
  }
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
  let transactionOpen = false;
  try {
   const d=await bodyJSON(req);
   const name=String(d.name||'').trim(), price=Number(d.price);
   const stock=Math.round(Number(d.stock||0)*1000)/1000;
   const purchasePrice=Number(d.purchase_price||0);
   const packSize=Number(d.pack_size||1);
   const unit=String(d.unit||'piece');
   const businessType=db.prepare('SELECT business_type FROM stores WHERE id=?').get(storeId)?.business_type||'grocery';
   const unitsByActivity={
    grocery:['piece','carton'],food_wholesale:['piece','carton','kg','ton'],
    oils:['piece','carton','liter'],metal_work:['meter','shape','piece','kg','ton'],
    clothing:['piece','pair'],fabrics:['meter','piece'],
    electronics:['piece','box'],computers:['piece','box'],
    auto_parts:['piece','box'],tires:['piece','pair'],
    cosmetics:['piece','box','carton'],perfumes:['piece','box','carton'],
    restaurant:['piece','kg','liter'],bakery:['piece','kg'],
    vegetables:['piece','kg','carton'],butcher:['kg','piece'],
    fish:['kg','piece'],building:['piece'],hardware:['piece','box','meter'],
    quincaillerie:['piece','box','meter'],furniture:['piece'],
    home_appliances:['piece','box'],pharmacy:['piece','box'],
    medical:['piece','box'],books:['piece'],barber:['piece'],
    laundry:['piece','kg'],agriculture:['kg','ton','piece','bag'],
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

   const syncUuid=crypto.randomUUID();
   db.exec('BEGIN IMMEDIATE');
   transactionOpen=true;

   const result=db.prepare(`INSERT INTO products
    (name,barcode,price,stock,category,store_id,purchase_price,unit,pack_size,sync_uuid)
    VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(name,barcode,price,stock,category,storeId,purchasePrice,unit,packSize,syncUuid);

   nrsEnqueueSyncEvent(storeId,'product',syncUuid,'create',{
    sync_uuid:syncUuid,name,price,initial_stock:stock,pack_size:packSize,
    barcode,category,purchase_price:purchasePrice,unit
   });

   const created=db.prepare(
    'SELECT * FROM products WHERE id=? AND store_id=?'
   ).get(Number(result.lastInsertRowid),storeId);

   db.exec('COMMIT');
   transactionOpen=false;
   return send(res,201,created);
  } catch(e) {
   if(transactionOpen) {
    try { db.exec('ROLLBACK'); } catch(_) {}
   }
   return send(res,400,{
    error:String(e.message).includes('UNIQUE')
     ? 'هذا الباركود مسجل في هذا المحل من قبل' : e.message
   });
  }
 }

 const productEditMatch = p.match(/^\/api\/products\/(\d+)$/);
 if (productEditMatch && req.method === 'PUT') {
  let transactionOpen=false;
  try {
   const id=Number(productEditMatch[1]);
   const d=await bodyJSON(req);

   db.exec('BEGIN IMMEDIATE');
   transactionOpen=true;

   const old=db.prepare(
    'SELECT * FROM products WHERE id=? AND store_id=?'
   ).get(id,storeId);

   if(!old) {
    db.exec('ROLLBACK');
    transactionOpen=false;
    return send(res,404,{error:'المنتج غير موجود في متجرك'});
   }

   const name=String(d.name ?? old.name).trim();
   const price=Number(d.price ?? old.price);
   const stock=Math.round(Number(d.stock ?? old.stock)*1000)/1000;
   const purchasePrice=Number(d.purchase_price ?? old.purchase_price ?? 0);
   const packSize=Number(d.pack_size ?? old.pack_size ?? 1);
   const unit=String(d.unit ?? old.unit ?? 'piece');
   const category=String(d.category ?? old.category ?? 'عام').trim();
   const barcodeText=String(d.barcode ?? old.barcode ?? '').trim();
   const barcode=barcodeText || null;
   const units=['piece','carton','kg','ton','liter','meter','shape',
                'pair','box','bag','g'];

   if(!name || name.length>200 || !Number.isFinite(price) || price<0 ||
      !Number.isFinite(stock) || stock<0 || stock>100000000 ||
      !Number.isFinite(purchasePrice) || purchasePrice<0 ||
      !Number.isFinite(packSize) || packSize<=0 || !units.includes(unit))
    throw new Error('تحقق من الاسم والسعر والكمية والوحدة وسعر الشراء');

   if(barcode && db.prepare(
    'SELECT 1 FROM products WHERE store_id=? AND barcode=? AND id<>?'
   ).get(storeId,barcode,id))
    throw new Error('هذا الباركود مستخدم لمنتج آخر في متجرك');

   const syncUuid=old.sync_uuid || crypto.randomUUID();
   const oldStock=Number(old.stock||0);
   const stockDelta=Math.round((stock-oldStock)*1000)/1000;

   db.prepare(`UPDATE products
    SET sync_uuid=?,name=?,barcode=?,price=?,stock=?,category=?,
        purchase_price=?,unit=?,pack_size=?
    WHERE id=? AND store_id=?`)
    .run(syncUuid,name,barcode,price,stock,category,
         purchasePrice,unit,packSize,id,storeId);

   nrsEnqueueSyncEvent(storeId,'product',syncUuid,'update',{
    sync_uuid:syncUuid,name,price,barcode,category,
    purchase_price:purchasePrice,unit,pack_size:packSize
   });

   if(stockDelta!==0) {
    nrsEnqueueSyncEvent(storeId,'product',syncUuid,'stock.adjust',{
     sync_uuid:syncUuid,delta:stockDelta,reason:'product_edit'
    });
   }

   const updated=db.prepare(
    'SELECT * FROM products WHERE id=? AND store_id=?'
   ).get(id,storeId);

   db.exec('COMMIT');
   transactionOpen=false;
   return send(res,200,updated);
  } catch(e) {
   if(transactionOpen) {
    try { db.exec('ROLLBACK'); } catch(_) {}
   }
   return send(res,400,{error:String(e.message).includes('UNIQUE')
    ? 'هذا الباركود مستخدم لمنتج آخر في متجرك' : e.message});
  }
 }


 if (productEditMatch && req.method === 'DELETE') {
  const id=Number(productEditMatch[1]);
  let transactionOpen=false;
  try {
   db.exec('BEGIN IMMEDIATE');
   transactionOpen=true;

   const existing=db.prepare(
    'SELECT id,sync_uuid FROM products WHERE id=? AND store_id=?'
   ).get(id,storeId);

   if(!existing) {
    db.exec('ROLLBACK');
    transactionOpen=false;
    return send(res,404,{error:'المنتج غير موجود في متجرك'});
   }

   const syncUuid=existing.sync_uuid || crypto.randomUUID();

   nrsEnqueueSyncEvent(storeId,'product',syncUuid,'delete',{
    sync_uuid:syncUuid,local_id:id
   });

   db.prepare(
    'UPDATE sale_items SET product_id=NULL WHERE product_id=? AND store_id=?'
   ).run(id,storeId);

   const result=db.prepare(
    'DELETE FROM products WHERE id=? AND store_id=?'
   ).run(id,storeId);

   if(result.changes!==1)
    throw new Error('لم يتم حذف المنتج؛ أعد المحاولة');

   db.exec('COMMIT');
   transactionOpen=false;
   return send(res,200,{ok:true,deleted:true,id});
  } catch(e) {
   if(transactionOpen) {
    try { db.exec('ROLLBACK'); } catch(_) {}
   }
   return send(res,500,{error:e.message});
  }
 }


 if (p==='/api/daily-summary' && req.method==='GET') {
  const latest=db.prepare(
   'SELECT * FROM daily_closures WHERE store_id=? ORDER BY id DESC LIMIT 1'
  ).get(storeId);

  let rows;
  if(latest) {
   rows=db.prepare(
    'SELECT id,total,status,created_at FROM sales WHERE store_id=? AND id>? ORDER BY id DESC'
   ).all(storeId,latest.last_sale_id);
  } else {
   rows=db.prepare(
    "SELECT id,total,status,created_at FROM sales WHERE store_id=? AND date(created_at,'localtime')=date('now','localtime') ORDER BY id DESC"
   ).all(storeId);
  }

  const count=rows.length;
  const total=Math.round(rows.filter(x=>!['cancelled','returned'].includes(x.status)).reduce((sum,x)=>sum+Number(x.total||0),0)*100)/100;
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
      'SELECT id,total,status FROM sales WHERE store_id=? AND id>? ORDER BY id'
     ).all(storeId,latest.last_sale_id);
    } else {
     rows=db.prepare(
      "SELECT id,total,status FROM sales WHERE store_id=? AND date(created_at,'localtime')=date('now','localtime') ORDER BY id"
     ).all(storeId);
    }

    if(!rows.length) {
     db.exec('ROLLBACK');
     return send(res,409,{error:'لا توجد فواتير جديدة لإغلاقها. لم يُنشأ تقرير مكرر.'});
    }

    const lastId=Math.max(...rows.map(x=>Number(x.id)));
    const total=Math.round(rows.filter(x=>!['cancelled','returned'].includes(x.status)).reduce((sum,x)=>sum+Number(x.total||0),0)*100)/100;
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
  const q=String(url.searchParams.get('q')||'').trim().slice(0,120);
  let sales;
  if(q) {
   sales=db.prepare(`SELECT * FROM sales WHERE store_id=? AND
    (CAST(id AS TEXT)=? OR customer_name LIKE ? OR customer_phone LIKE ?)
    ORDER BY id DESC LIMIT 100`)
    .all(storeId,q,'%'+q+'%','%'+q+'%');
  } else {
   sales=db.prepare('SELECT * FROM sales WHERE store_id=? ORDER BY id DESC LIMIT 100').all(storeId);
  }
  const getItems=db.prepare(`SELECT id,product_id,name,price,quantity,subtotal,
    unit,base_quantity,is_cancelled,cancelled_at
    FROM sale_items WHERE sale_id=? AND store_id=? ORDER BY id`);
  for(const sale of sales) sale.items=getItems.all(sale.id,storeId);
  return send(res,200,sales);
 }



 // NRS_INVOICE_SOFT_CANCEL_V1
 const invoiceDeleteMatch = p.match(/^\/api\/sales\/(\d+)$/);
 if (invoiceDeleteMatch && req.method==='DELETE') {
  const saleId=Number(invoiceDeleteMatch[1]);
  if(!Number.isSafeInteger(saleId)||saleId<1)
   return send(res,400,{error:'رقم الفاتورة غير صالح'});
  try {
   db.exec('BEGIN IMMEDIATE');
   const sale=db.prepare('SELECT * FROM sales WHERE id=? AND store_id=?')
    .get(saleId,storeId);
   if(!sale) throw new Error('الفاتورة غير موجودة');
   if(sale.status==='cancelled'||sale.status==='returned')
    throw new Error('الفاتورة ملغاة أو مسترجعة سابقاً');
   const closed=db.prepare('SELECT sale_ids FROM daily_closures WHERE store_id=?')
    .all(storeId);
   for(const c of closed) {
    let ids;
    try { ids=JSON.parse(c.sale_ids); } catch { throw new Error('تعذر التحقق من تقارير الإغلاق'); }
    if(!Array.isArray(ids)) throw new Error('بيانات تقرير الإغلاق غير سليمة');
    if(ids.some(x=>Number(x)===saleId))
     throw new Error('لا يمكن تعديل فاتورة مشمولة في تقرير إغلاق');
   }
   const lines=db.prepare(`SELECT * FROM sale_items
    WHERE sale_id=? AND store_id=? AND is_cancelled=0 ORDER BY id`)
    .all(saleId,storeId);
   // لا نلغي الفاتورة إذا تعذر ضمان إعادة مخزون أي بند.
   // يشمل ذلك المنتج المحذوف والكمية الأساسية المفقودة أو غير الصالحة.
   for(const x of lines) restoreInvoiceLine(x);
   db.prepare(`UPDATE sale_items SET is_cancelled=1,cancelled_at=CURRENT_TIMESTAMP
    WHERE sale_id=? AND store_id=? AND is_cancelled=0`).run(saleId,storeId);
   db.prepare("UPDATE sales SET status='cancelled',total=0 WHERE id=? AND store_id=?")
    .run(saleId,storeId);
   db.prepare('INSERT INTO invoice_audit(store_id,sale_id,action,details) VALUES(?,?,?,?)')
    .run(storeId,saleId,'cancel',JSON.stringify({restoredLines:lines.length,previousTotal:sale.total}));
   const stockDeltas = nrsBuildStockDeltas(storeId,
    lines.map(x => ({product_id:x.product_id, delta:Number(x.base_quantity)})));
   nrsEnqueueSaleSnapshot(storeId,saleId,stockDeltas);
   db.exec('COMMIT');
   return send(res,200,{ok:true,cancelled:true,saleId,
    message:'تم إلغاء الفاتورة وحفظ سجلها وإعادة المخزون'});
  } catch(e) {
   try{db.exec('ROLLBACK')}catch{}
   return send(res,409,{error:e.message});
  }
 }
 // END NRS_INVOICE_SOFT_CANCEL_V1


 // NRS_INVOICE_OPERATIONS_V1
 function invoiceIsClosed(id) {
  const rows=db.prepare('SELECT sale_ids FROM daily_closures WHERE store_id=?').all(storeId);
  for(const row of rows) {
   let ids;
   try { ids=JSON.parse(row.sale_ids); } catch { throw new Error('تعذر قراءة تقارير الإغلاق'); }
   if(!Array.isArray(ids)) throw new Error('بيانات الإغلاق غير سليمة');
   if(ids.some(x=>Number(x)===Number(id))) return true;
  }
  return false;
 }
 function eligibleReturns() {
  const type=db.prepare('SELECT business_type FROM stores WHERE id=?').get(storeId)?.business_type||'grocery';
  return ['auto_parts','hardware','quincaillerie'].includes(type);
 }
 function addAudit(saleId,action,details) {
  db.prepare('INSERT INTO invoice_audit(store_id,sale_id,action,details) VALUES(?,?,?,?)')
   .run(storeId,saleId,action,JSON.stringify(details||{}));
 }
 function restoreInvoiceLine(line) {
  if(line.product_id==null) throw new Error('المنتج الأصلي محذوف؛ لا يمكن ضمان إرجاع المخزون: '+line.name);
  const qty=Number(line.base_quantity);
  if(!Number.isFinite(qty)||qty<=0) throw new Error('الكمية الأساسية غير صالحة: '+line.name);
  const r=db.prepare('UPDATE products SET stock=stock+? WHERE id=? AND store_id=?')
   .run(qty,line.product_id,storeId);
  if(r.changes!==1) throw new Error('تعذر إعادة مخزون '+line.name);
 }
 function saleProduct(productId,quantity,saleUnit) {
  const product=db.prepare('SELECT * FROM products WHERE id=? AND store_id=?').get(productId,storeId);
  if(!product) throw new Error('المنتج غير موجود في هذا المحل');
  let unit=product.unit||'piece', price=Number(product.price), stockUnits=quantity;
  const pack=Number(product.pack_size||1);
  if(unit==='piece'&&pack>1) {
   if(!['piece','carton'].includes(saleUnit)) throw new Error('اختر الحبة أو الكرتونة للمنتج '+product.name);
   unit=saleUnit;
   if(unit==='carton'){stockUnits=quantity*pack;price*=pack;}
  }
  if(!Number.isFinite(stockUnits)||stockUnits<=0) throw new Error('كمية غير صالحة');
  if(Number(product.stock)<stockUnits) throw new Error('المخزون غير كافٍ للمنتج '+product.name);
  return {...product,quantity,unit,price,stockUnits,subtotal:Math.round(price*quantity*100)/100};
 }

 // إلغاء بند واحد وإرجاع مخزونه مرة واحدة
 const itemCancel=p.match(/^\/api\/sales\/(\d+)\/items\/(\d+)\/cancel$/);
 if(itemCancel&&req.method==='POST') {
  const saleId=Number(itemCancel[1]), itemId=Number(itemCancel[2]);
  try {
   if(!eligibleReturns()) return send(res,403,{error:'إلغاء بند الفاتورة متاح لمحلات قطع الغيار والخردوات فقط'});
   db.exec('BEGIN IMMEDIATE');
   const sale=db.prepare('SELECT * FROM sales WHERE id=? AND store_id=?').get(saleId,storeId);
   if(!sale) throw new Error('الفاتورة غير موجودة');
   if(!['sold','exchanged'].includes(sale.status)) throw new Error('لا يمكن تعديل حالة هذه الفاتورة');
   if(invoiceIsClosed(saleId)) throw new Error('الفاتورة مشمولة في تقرير إغلاق');
   const line=db.prepare('SELECT * FROM sale_items WHERE id=? AND sale_id=? AND store_id=? AND is_cancelled=0')
    .get(itemId,saleId,storeId);
   if(!line) throw new Error('بند الفاتورة غير موجود أو ملغى سابقاً');
   restoreInvoiceLine(line);
   db.prepare('UPDATE sale_items SET is_cancelled=1,cancelled_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(itemId);
   const active=db.prepare('SELECT COALESCE(SUM(subtotal),0) total,COUNT(*) n FROM sale_items WHERE sale_id=? AND store_id=? AND is_cancelled=0')
    .get(saleId,storeId);
   const status=Number(active.n)===0?'returned':(sale.status==='exchanged'?'exchanged':'sold');
   db.prepare('UPDATE sales SET total=?,status=? WHERE id=? AND store_id=?')
    .run(Math.round(Number(active.total)*100)/100,status,saleId,storeId);
   addAudit(saleId,'partial_return',{itemId,line,restored:Number(line.base_quantity)});
   const stockDeltas = nrsBuildStockDeltas(storeId, [
    {product_id:line.product_id, delta:Number(line.base_quantity)}
   ]);
   nrsEnqueueSaleSnapshot(storeId,saleId,stockDeltas);
   db.exec('COMMIT');
   return send(res,200,{ok:true,saleId,status,total:active.total,message:'تم إلغاء المنتج وإعادة مخزونه'});
  } catch(e){try{db.exec('ROLLBACK')}catch{} return send(res,409,{error:e.message});}
 }

 // استرجاع كامل — حصرياً لأنواع المحلات المؤهلة
 const returnMatch=p.match(/^\/api\/sales\/(\d+)\/return$/);
 if(returnMatch&&req.method==='POST') {
  const saleId=Number(returnMatch[1]);
  try {
   if(!eligibleReturns()) return send(res,403,{error:'الاسترجاع متاح لمحلات قطع الغيار والخردوات فقط'});
   db.exec('BEGIN IMMEDIATE');
   const sale=db.prepare('SELECT * FROM sales WHERE id=? AND store_id=?').get(saleId,storeId);
   if(!sale) throw new Error('الفاتورة غير موجودة');
   if(!['sold','exchanged'].includes(sale.status)) throw new Error('الفاتورة ليست في حالة بيع أو استبدال');
   if(invoiceIsClosed(saleId)) throw new Error('الفاتورة مشمولة في تقرير إغلاق');
   const lines=db.prepare('SELECT * FROM sale_items WHERE sale_id=? AND store_id=? AND is_cancelled=0')
    .all(saleId,storeId);
   for(const line of lines) restoreInvoiceLine(line);
   db.prepare('UPDATE sale_items SET is_cancelled=1,cancelled_at=CURRENT_TIMESTAMP WHERE sale_id=? AND store_id=? AND is_cancelled=0')
    .run(saleId,storeId);
   db.prepare("UPDATE sales SET total=0,status='returned' WHERE id=? AND store_id=?").run(saleId,storeId);
   addAudit(saleId,'full_return',{lines:lines.length,previousTotal:sale.total});
   const stockDeltas = nrsBuildStockDeltas(storeId,
    lines.map(x => ({product_id:x.product_id, delta:Number(x.base_quantity)})));
   nrsEnqueueSaleSnapshot(storeId,saleId,stockDeltas);
   db.exec('COMMIT');
   return send(res,200,{ok:true,saleId,status:'returned',message:'تم استرجاع الفاتورة وإعادة المخزون'});
  } catch(e){try{db.exec('ROLLBACK')}catch{} return send(res,409,{error:e.message});}
 }

 // استبدال بند بمنتج آخر مع احتساب فرق السعر
 const exchangeMatch=p.match(/^\/api\/sales\/(\d+)\/items\/(\d+)\/exchange$/);
 if(exchangeMatch&&req.method==='POST') {
  const saleId=Number(exchangeMatch[1]), itemId=Number(exchangeMatch[2]);
  try {
   if(!eligibleReturns()) return send(res,403,{error:'الاستبدال متاح لمحلات قطع الغيار والخردوات فقط'});
   const d=await bodyJSON(req);
   const newId=Number(d.productId), qty=Number(d.quantity), unit=String(d.saleUnit||'');
   if(!Number.isSafeInteger(newId)||newId<1||!Number.isFinite(qty)||qty<=0)
    return send(res,400,{error:'بيانات المنتج البديل غير صالحة'});
   db.exec('BEGIN IMMEDIATE');
   const sale=db.prepare('SELECT * FROM sales WHERE id=? AND store_id=?').get(saleId,storeId);
   if(!sale||!['sold','exchanged'].includes(sale.status)) throw new Error('الفاتورة غير موجودة أو غير قابلة للاستبدال');
   if(invoiceIsClosed(saleId)) throw new Error('الفاتورة مشمولة في تقرير إغلاق');
   const old=db.prepare('SELECT * FROM sale_items WHERE id=? AND sale_id=? AND store_id=? AND is_cancelled=0')
    .get(itemId,saleId,storeId);
   if(!old) throw new Error('المنتج الأصلي غير موجود أو مستبدل سابقاً');
   restoreInvoiceLine(old);
   const replacement=saleProduct(newId,qty,unit);
   const deduct=db.prepare('UPDATE products SET stock=stock-? WHERE id=? AND store_id=? AND stock>=?')
    .run(replacement.stockUnits,newId,storeId,replacement.stockUnits);
   if(deduct.changes!==1) throw new Error('تعذر خصم مخزون المنتج البديل');
   db.prepare('UPDATE sale_items SET is_cancelled=1,cancelled_at=CURRENT_TIMESTAMP WHERE id=?').run(itemId);
   const replacementLineUuid = crypto.randomUUID();
   if (!replacement.sync_uuid) throw new Error('Replacement product sync identity is missing');
   db.prepare(`INSERT INTO sale_items(sale_id,product_id,name,price,quantity,subtotal,store_id,unit,base_quantity,sync_uuid)
    VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(saleId,newId,replacement.name,replacement.price,qty,replacement.subtotal,storeId,replacement.unit,replacement.stockUnits,replacementLineUuid);
   const active=db.prepare('SELECT COALESCE(SUM(subtotal),0) total FROM sale_items WHERE sale_id=? AND store_id=? AND is_cancelled=0')
    .get(saleId,storeId);
   const difference=Math.round((replacement.subtotal-Number(old.subtotal))*100)/100;
   db.prepare("UPDATE sales SET total=?,status='exchanged' WHERE id=? AND store_id=?")
    .run(Math.round(Number(active.total)*100)/100,saleId,storeId);
   addAudit(saleId,'exchange',{oldItem:old,newProductId:newId,newProductName:replacement.name,newQuantity:qty,newSubtotal:replacement.subtotal,priceDifference:difference});
   const stockDeltas = nrsBuildStockDeltas(storeId, [
    {product_id:old.product_id, delta:Number(old.base_quantity)},
    {product_id:newId, delta:-Number(replacement.stockUnits)}
   ]);
   nrsEnqueueSaleSnapshot(storeId,saleId,stockDeltas);
   db.exec('COMMIT');
   return send(res,200,{ok:true,saleId,status:'exchanged',priceDifference:difference,
    customerOwes:Math.max(0,difference),refund:Math.max(0,-difference),
    message:difference>0?'المنتج البديل أغلى؛ المبلغ المستحق على الزبون '+difference:
     difference<0?'المنتج البديل أرخص؛ المبلغ المرجع للزبون '+(-difference):'لا يوجد فرق في السعر'});
  } catch(e){try{db.exec('ROLLBACK')}catch{} return send(res,409,{error:e.message});}
 }

 // تعديل كامل لبنود فاتورة غير مغلقة: إعادة القديم ثم التحقق والخصم الجديد داخل معاملة واحدة
 const editMatch=p.match(/^\/api\/sales\/(\d+)$/);
 if(editMatch&&req.method==='PUT') {
  const saleId=Number(editMatch[1]);
  try {
   const d=await bodyJSON(req);
   if(!Array.isArray(d.items)||!d.items.length||d.items.length>100)
    return send(res,400,{error:'قائمة المنتجات غير صالحة'});
   db.exec('BEGIN IMMEDIATE');
   const sale=db.prepare('SELECT * FROM sales WHERE id=? AND store_id=?').get(saleId,storeId);
   if(!sale||!['sold','exchanged'].includes(sale.status)) throw new Error('الفاتورة غير موجودة أو غير قابلة للتعديل');
   if(invoiceIsClosed(saleId)) throw new Error('الفاتورة مشمولة في تقرير إغلاق');
   const oldLines=db.prepare('SELECT * FROM sale_items WHERE sale_id=? AND store_id=? AND is_cancelled=0')
    .all(saleId,storeId);
   for(const line of oldLines) restoreInvoiceLine(line);
   const newLines=d.items.map(x=>{
    const id=Number(x.id), quantity=Number(x.quantity);
    if(!Number.isSafeInteger(id)||id<1||!Number.isFinite(quantity)||quantity<=0) throw new Error('كمية أو منتج غير صالح');
    return saleProduct(id,quantity,String(x.saleUnit||x.unit||''));
   });
   const upd=db.prepare('UPDATE products SET stock=stock-? WHERE id=? AND store_id=? AND stock>=?');
   for(const x of newLines) if(upd.run(x.stockUnits,x.id,storeId,x.stockUnits).changes!==1)
    throw new Error('تعذر خصم مخزون '+x.name);
   db.prepare('UPDATE sale_items SET is_cancelled=1,cancelled_at=CURRENT_TIMESTAMP WHERE sale_id=? AND store_id=? AND is_cancelled=0')
    .run(saleId,storeId);
   const ins=db.prepare(`INSERT INTO sale_items(sale_id,product_id,name,price,quantity,subtotal,store_id,unit,base_quantity,sync_uuid)
    VALUES(?,?,?,?,?,?,?,?,?,?)`);
   let total=0;
   for(const x of newLines){
    if(!x.sync_uuid) throw new Error('Product sync identity is missing: '+x.name);
    ins.run(saleId,x.id,x.name,x.price,x.quantity,x.subtotal,storeId,x.unit,x.stockUnits,crypto.randomUUID());
    total+=x.subtotal;
   }
   const customerName=String(d.customerName??sale.customer_name??'').trim().slice(0,120);
   const customerPhone=String(d.customerPhone??sale.customer_phone??'').trim().slice(0,40);
   db.prepare("UPDATE sales SET total=?,customer_name=?,customer_phone=?,status=? WHERE id=? AND store_id=?")
    .run(Math.round(total*100)/100,customerName,customerPhone,sale.status==='exchanged'?'exchanged':'sold',saleId,storeId);
   addAudit(saleId,'edit',{oldLines,newLines,previousTotal:sale.total,newTotal:total});
   const stockMovements = [
    ...oldLines.map(x => ({product_id:x.product_id, delta:Number(x.base_quantity)})),
    ...newLines.map(x => ({product_id:x.id, delta:-Number(x.stockUnits)}))
   ];
   const stockDeltas = nrsBuildStockDeltas(storeId,stockMovements);
   nrsEnqueueSaleSnapshot(storeId,saleId,stockDeltas);
   db.exec('COMMIT');
   return send(res,200,{ok:true,saleId,total:Math.round(total*100)/100,message:'تم تعديل الفاتورة والمخزون'});
  } catch(e){try{db.exec('ROLLBACK')}catch{} return send(res,409,{error:e.message});}
 }
 // END NRS_INVOICE_OPERATIONS_V1

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
    const customerName=String(data.customerName||'').trim().slice(0,120);
    const customerPhone=String(data.customerPhone||'').trim().slice(0,40);
    const saleUuid=crypto.randomUUID();
    const sale=db.prepare("INSERT INTO sales(total,store_id,customer_name,customer_phone,status,sync_uuid) VALUES(?,?,?,?,'sold',?)")
     .run(total,storeId,customerName,customerPhone,saleUuid);
    const saleId=Number(sale.lastInsertRowid);
    const ins=db.prepare(`INSERT INTO sale_items(sale_id,product_id,name,price,quantity,subtotal,store_id,unit,base_quantity,sync_uuid)
      VALUES(?,?,?,?,?,?,?,?,?,?)`);
    const upd=db.prepare('UPDATE products SET stock=stock-? WHERE id=? AND store_id=? AND stock>=?');
    for(const x of saleItems) {
     const lineUuid=crypto.randomUUID();
     if (!x.sync_uuid) throw new Error('Product sync identity is missing: '+x.name);
     ins.run(saleId,x.id,x.name,x.price,x.quantity,x.subtotal,storeId,x.unit||'piece',x.stockUnits,lineUuid);
     const r=upd.run(x.stockUnits,x.id,storeId,x.stockUnits);
     if(!r.changes) throw new Error('تعذر تحديث المخزون');
    }
    const deltaMap=new Map();
    for (const x of saleItems) {
     const productUuid=x.sync_uuid;
     const next=(deltaMap.get(productUuid)||0)-Number(x.stockUnits);
     deltaMap.set(productUuid,Math.round(next*1000)/1000);
    }
    const stockDeltas=[...deltaMap.entries()]
     .filter(([,delta])=>delta!==0)
     .map(([product_sync_uuid,delta])=>({product_sync_uuid,delta}));

    nrsEnqueueSaleSnapshot(storeId,saleId,stockDeltas);

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
     'SELECT id,total,status FROM sales WHERE store_id=? AND id>? ORDER BY id'
    ).all(storeId,currentLatest.last_sale_id);
   } else {
    currentRows=db.prepare(
     "SELECT id,total,status FROM sales WHERE store_id=? AND date(created_at,'localtime')=date('now','localtime') ORDER BY id"
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
   const total=Math.round(currentRows.filter(x=>!['cancelled','returned'].includes(x.status)).reduce((a,x)=>a+Number(x.total||0),0)*100)/100;
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
 if (process.env.NRS_APP_EDITION === 'customer' &&
     (url.pathname === '/admin' || url.pathname === '/admin/')) {
   res.writeHead(404, {'Content-Type':'text/plain; charset=utf-8'});
   return res.end('Not found');
 }
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

server.listen(Number(process.env.PORT||3001),process.env.NRS_HOST||'127.0.0.1',()=>{
 console.log('cash.pro.S.M.G.R: http://127.0.0.1:'+(process.env.PORT||3001));
 console.log('Admin panel: http://127.0.0.1:'+(process.env.PORT||3001)+'/admin');
 console.log('SQLite: '+path.join(DATA,'cashier.db'));
});
