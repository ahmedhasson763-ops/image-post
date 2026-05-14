const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

// Persistent data folder
const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, 'easymotion.sqlite');
const db = new sqlite3.Database(dbPath);

// DB ready promise — all modules can await this before querying
let _resolveReady;
const dbReady = new Promise(resolve => { _resolveReady = resolve; });

db.on('open', () => {
  console.log('[DB] ✅ Connected to SQLite');
  initDB();
});

db.on('error', (err) => {
  console.error('[DB] ❌ Connection error:', err);
});

function initDB() {
  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      access_token TEXT UNIQUE,
      name TEXT DEFAULT '',
      added_at INTEGER DEFAULT (strftime('%s','now')*1000)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS pages (
      id TEXT PRIMARY KEY,
      name TEXT,
      access_token TEXT,
      category TEXT,
      user_token TEXT,
      enabled INTEGER DEFAULT 1
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content_folder TEXT NOT NULL,
      selected_pages TEXT NOT NULL DEFAULT '[]',
      schedule_time INTEGER,
      mode TEXT DEFAULT 'manual',
      status TEXT DEFAULT 'pending',
      total_pages INTEGER DEFAULT 0,
      completed_pages INTEGER DEFAULT 0,
      started_at INTEGER,
      finished_at INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')*1000)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS progress (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      page_id TEXT NOT NULL,
      page_name TEXT,
      content_file TEXT,
      content_name TEXT,
      status TEXT DEFAULT 'pending',
      error_msg TEXT,
      posted_at INTEGER,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS engine_state (
      id INTEGER PRIMARY KEY DEFAULT 1,
      status TEXT DEFAULT 'idle',
      active_session_id INTEGER,
      current_page_index INTEGER DEFAULT 0,
      gap_minutes INTEGER DEFAULT 5,
      total_rounds INTEGER DEFAULT 1,
      current_round INTEGER DEFAULT 0,
      rest_minutes INTEGER DEFAULT 0,
      rest_until INTEGER,
      content_folder TEXT,
      selected_pages TEXT,
      last_activity INTEGER
    )`);

    db.run(`INSERT OR IGNORE INTO engine_state (id, status, gap_minutes) VALUES (1, 'idle', 5)`);
    // Backward compat — add columns if they don't exist yet
    db.run(`ALTER TABLE users ADD COLUMN name TEXT DEFAULT ''`, () => {});
    db.run(`ALTER TABLE engine_state ADD COLUMN gap_minutes INTEGER DEFAULT 5`, () => {});
    db.run(`ALTER TABLE engine_state ADD COLUMN total_rounds INTEGER DEFAULT 1`, () => {});
    db.run(`ALTER TABLE engine_state ADD COLUMN current_round INTEGER DEFAULT 0`, () => {});
    db.run(`ALTER TABLE engine_state ADD COLUMN rest_minutes INTEGER DEFAULT 0`, () => {});
    db.run(`ALTER TABLE engine_state ADD COLUMN rest_until INTEGER`, () => {});
    db.run(`ALTER TABLE engine_state ADD COLUMN content_folder TEXT`, () => {});
    db.run(`ALTER TABLE engine_state ADD COLUMN selected_pages TEXT`, () => {});
    db.run(`ALTER TABLE engine_state ADD COLUMN use_proxies INTEGER DEFAULT 1`, () => {});

    db.run(`CREATE TABLE IF NOT EXISTS posting_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER,
      page_id TEXT,
      page_name TEXT,
      content_file TEXT,
      content_name TEXT,
      caption TEXT,
      status TEXT,
      error_msg TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now')*1000)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS proxies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host TEXT NOT NULL,
      port INTEGER NOT NULL,
      username TEXT DEFAULT '',
      password TEXT DEFAULT '',
      protocol TEXT DEFAULT 'http',
      label TEXT DEFAULT '',
      status TEXT DEFAULT 'unchecked',
      speed_ms INTEGER DEFAULT 0,
      external_ip TEXT DEFAULT '',
      country TEXT DEFAULT '',
      city TEXT DEFAULT '',
      country_code TEXT DEFAULT '',
      enabled INTEGER DEFAULT 1,
      last_checked INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')*1000)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS proxy_page_map (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      proxy_id INTEGER NOT NULL,
      page_id TEXT NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s','now')*1000),
      FOREIGN KEY (proxy_id) REFERENCES proxies(id),
      UNIQUE(proxy_id, page_id)
    )`);

    // Backward-compat migrations: add new columns to existing tables
    db.run(`ALTER TABLE proxies ADD COLUMN country TEXT DEFAULT ''`, () => {});
    db.run(`ALTER TABLE proxies ADD COLUMN city TEXT DEFAULT ''`, () => {});
    db.run(`ALTER TABLE proxies ADD COLUMN country_code TEXT DEFAULT ''`, () => {});
    db.run(`ALTER TABLE posting_logs ADD COLUMN proxy_info TEXT DEFAULT ''`, () => {});
    db.run(`ALTER TABLE posting_logs ADD COLUMN caption_source TEXT DEFAULT ''`, () => {});

    // ════════════════════════════════════════
    // AI caption generator tables
    // ════════════════════════════════════════
    db.run(`CREATE TABLE IF NOT EXISTS ai_providers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      api_key TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      supports_vision INTEGER DEFAULT 0,
      priority INTEGER DEFAULT 100,
      enabled INTEGER DEFAULT 1,
      last_error TEXT,
      last_used INTEGER,
      label TEXT DEFAULT '',
      created_at INTEGER DEFAULT (strftime('%s','now')*1000)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS ai_settings (
      id INTEGER PRIMARY KEY DEFAULT 1,
      enabled INTEGER DEFAULT 0,
      language TEXT DEFAULT 'es-MX',
      niche TEXT DEFAULT '',
      tool_name TEXT DEFAULT 'imagestool1',
      use_vision INTEGER DEFAULT 1,
      fallback_to_filename INTEGER DEFAULT 1,
      custom_prompt TEXT,
      default_content_folder TEXT DEFAULT ''
    )`);

    db.run(`INSERT OR IGNORE INTO ai_settings (id, enabled, language, niche, tool_name, use_vision, fallback_to_filename)
            VALUES (1, 0, 'es-MX', '', 'imagestool1', 1, 1)`, () => {
      // This callback fires after ALL statements — DB is fully ready
      console.log('[DB] ✅ All tables ready (proxy + geo + AI captions).');
      _resolveReady();
    });
  });
}

// Promise wrappers
function runQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

function getQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function allQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

module.exports = { db, dbReady, runQuery, getQuery, allQuery };
