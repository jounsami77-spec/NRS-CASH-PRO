const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DATA = process.env.DATA_DIR || path.join(__dirname,'data');
fs.mkdirSync(DATA,{recursive:true});
const db = new DatabaseSync(path.join(DATA,'cashier.db'));
const hash = password => {
 const salt=crypto.randomBytes(16).toString('hex');
 return salt+':'+crypto.scryptSync(password,salt,64).toString('hex');
};
const randomPassword=()=>crypto.randomBytes(12).toString('base64url');

try {
 const count=db.prepare('SELECT COUNT(*) n FROM users').get().n;
 if(count) {
  console.error('توقف: توجد حسابات بالفعل. لم يتم إنشاء أو تغيير أي حساب.');
  process.exitCode=1;
 } else {
  const stores=db.prepare('SELECT id,name FROM stores ORDER BY id').all();
  if(!stores.length) throw new Error('لا توجد محلات في قاعدة البيانات');
  const credentials=[];
  const adminPassword=randomPassword();
  db.prepare('INSERT INTO users(store_id,username,password_hash,role) VALUES(NULL,?,?,?)')
   .run('admin',hash(adminPassword),'super_admin');
  credentials.push({role:'مدير عام',store:'كل المحلات',username:'admin',password:adminPassword});

  const insert=db.prepare('INSERT INTO users(store_id,username,password_hash,role) VALUES(?,?,?,?)');
  for(const store of stores) {
   let username='store'+String(store.id).padStart(2,'0');
   while(db.prepare('SELECT 1 FROM users WHERE username=?').get(username)) username+='x';
   const password=randomPassword();
   insert.run(store.id,username,hash(password),'store_owner');
   credentials.push({role:'صاحب محل',store:store.name,username,password});
   const sub=db.prepare('SELECT id FROM subscriptions WHERE store_id=? ORDER BY id DESC LIMIT 1').get(store.id);
   if(!sub) db.prepare("INSERT INTO subscriptions(store_id,plan,status) VALUES(?,'monthly','pending')").run(store.id);
  }
  const dir=path.join(DATA,'private');
  fs.mkdirSync(dir,{recursive:true});
  const file=path.join(dir,'initial-credentials-'+new Date().toISOString().replace(/[:.]/g,'-')+'.txt');
  const lines=[
   'S.N.R-CASH.PRO — بيانات الدخول الأولية',
   'احتفظ بهذا الملف في مكان آمن، ولا تشاركه علنًا.',
   'تجربة صاحب المحل تبدأ عند أول تسجيل دخول ناجح لمدة 7 أيام.',
   'اشتراك الشهر: 1500 دج.',
   '',
   ...credentials.map(c=>`الدور: ${c.role}\nالمحل: ${c.store}\nاسم المستخدم: ${c.username}\nكلمة المرور: ${c.password}\n`)
  ];
  fs.writeFileSync(file,lines.join('\n'),{mode:0o600,flag:'wx'});
  console.log('تم إنشاء '+credentials.length+' حسابًا.');
  console.log('ملف بيانات الدخول محفوظ بصلاحية خاصة هنا: '+file);
  console.log('\n========== بيانات المدير العام ==========');
  console.log('الرابط: http://127.0.0.1:3001/admin');
  console.log('اسم المستخدم: admin');
  console.log('كلمة المرور: '+adminPassword);
  console.log('\nبيانات أصحاب المحلات موجودة في ملف النسخة الاحتياطية المذكور أعلاه.');
 }
} finally { db.close(); }
