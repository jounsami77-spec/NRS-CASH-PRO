'use strict';

const fs = require('node:fs');
const path = require('node:path');

const dataDir = process.env.DATA_DIR;
if (!dataDir) throw new Error('DATA_DIR is not configured');

fs.mkdirSync(dataDir, { recursive: true });

const probe = path.join(dataDir, '.nrs-sqlite-smoke.db');
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(probe);
db.exec('CREATE TABLE IF NOT EXISTS nrs_runtime_smoke (ok INTEGER)');
db.close();

for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(probe + suffix); } catch (_) {}
}

console.log('[NRS] node:sqlite smoke test passed');

// Initializes a fresh installation if bootstrap.js supports it.
// Existing databases are kept in DATA_DIR and are not copied into the APK.
require('./bootstrap.js');
require('./server.js');
