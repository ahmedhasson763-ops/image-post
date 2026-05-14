/**
 * Folder2Page API Controller
 * All REST endpoints for the dashboard
 */

const { runQuery, getQuery, allQuery } = require('../database/db');
const { fetchAllPages } = require('../services/facebookService');
const { startEngine, stopEngine, getEngineState, scanForContent, refreshPageTokens } = require('../engine/postingEngine');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const MEDIA_EXTENSIONS = [
  '.mp4', '.mov', '.avi', '.mkv', '.webm', '.flv', '.wmv', '.m4v',
  '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'
];

// ═══════════════════════════════════════
// AUTH & TOKEN MANAGEMENT
// ═══════════════════════════════════════

exports.authenticate = async (req, res) => {
  const { access_token } = req.body;
  if (!access_token) return res.status(400).json({ error: 'Access token is required' });

  try {
    // Fetch user name from Facebook
    let userName = '';
    try {
      const meResp = await axios.get(`https://graph.facebook.com/v19.0/me?access_token=${access_token}&fields=name`);
      userName = meResp.data?.name || '';
    } catch (e) {
      console.log('[Auth] Could not fetch user name:', e.message);
    }

    // Save token with name
    const existing = await getQuery(`SELECT id FROM users WHERE access_token=?`, [access_token]);
    if (!existing) {
      await runQuery(`INSERT INTO users (access_token, name) VALUES (?, ?)`, [access_token, userName]);
    } else {
      // Update name if we got one
      if (userName) {
        await runQuery(`UPDATE users SET name=? WHERE access_token=?`, [userName, access_token]);
      }
    }

    // Sync pages
    const pages = await syncPages(access_token);

    res.json({
      message: 'Token authenticated & pages synced!',
      total_pages: pages.length,
      user_name: userName,
      pages: pages.map(p => ({ id: p.id, name: p.name, category: p.category }))
    });
  } catch (error) {
    console.error('[Auth] Error:', error.message);
    res.status(500).json({ error: 'Authentication failed: ' + error.message });
  }
};

async function syncPages(token) {
  // Clear old pages for this token
  await runQuery(`DELETE FROM pages WHERE user_token=?`, [token]);

  // Fetch directly from Facebook API
  let url = `https://graph.facebook.com/v19.0/me/accounts?access_token=${token}&fields=id,name,access_token,category&limit=100`;
  const pages = [];

  while (url) {
    try {
      const resp = await axios.get(url);
      if (resp.data?.data) {
        for (const p of resp.data.data) {
          pages.push(p);
          await runQuery(
            `INSERT OR REPLACE INTO pages (id, name, access_token, category, user_token, enabled) VALUES (?,?,?,?,?,1)`,
            [p.id, p.name, p.access_token || '', p.category || 'Page', token]
          );
        }
      }
      url = resp.data?.paging?.next || null;
    } catch (err) {
      console.error('[Sync] Error:', err.response?.data?.error?.message || err.message);
      break;
    }
  }

  // Also try business pages
  try {
    let bizUrl = `https://graph.facebook.com/v19.0/me/businesses?access_token=${token}&limit=100`;
    let businesses = [];
    while (bizUrl) {
      const bizRes = await axios.get(bizUrl);
      if (bizRes.data?.data) businesses = businesses.concat(bizRes.data.data);
      bizUrl = bizRes.data?.paging?.next || null;
    }

    for (const biz of businesses) {
      let ownedUrl = `https://graph.facebook.com/v19.0/${biz.id}/owned_pages?access_token=${token}&fields=id,name,access_token,category&limit=100`;
      while (ownedUrl) {
        const res2 = await axios.get(ownedUrl);
        if (res2.data?.data) {
          for (const p of res2.data.data) {
            if (!pages.find(x => x.id === p.id)) {
              pages.push(p);
              await runQuery(
                `INSERT OR REPLACE INTO pages (id, name, access_token, category, user_token, enabled) VALUES (?,?,?,?,?,1)`,
                [p.id, p.name, p.access_token || '', p.category || 'Business Page', token]
              );
            }
          }
        }
        ownedUrl = res2.data?.paging?.next || null;
      }
    }
  } catch (e) {}

  console.log(`[Sync] ✅ Saved ${pages.length} pages`);
  return pages;
}

exports.syncPagesAPI = async (req, res) => {
  const token = req.headers['authorization'];
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    const pages = await syncPages(token);
    res.json({ message: 'Pages synced!', total: pages.length });
  } catch (error) {
    res.status(500).json({ error: 'Sync failed: ' + error.message });
  }
};

exports.getTokens = async (req, res) => {
  try {
    const tokens = await allQuery(`
      SELECT u.id, u.access_token, u.name, COUNT(p.id) as pageCount 
      FROM users u LEFT JOIN pages p ON u.access_token = p.user_token 
      GROUP BY u.id ORDER BY u.id DESC
    `);
    res.json({ tokens });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get tokens' });
  }
};

exports.deleteToken = async (req, res) => {
  try {
    const user = await getQuery(`SELECT access_token FROM users WHERE id=?`, [req.params.id]);
    if (user) {
      await runQuery(`DELETE FROM pages WHERE user_token=?`, [user.access_token]);
      await runQuery(`DELETE FROM users WHERE id=?`, [req.params.id]);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete token' });
  }
};

// ═══════════════════════════════════════
// PAGES — now includes user_token for grouping
// ═══════════════════════════════════════

exports.getPages = async (req, res) => {
  try {
    const pages = await allQuery(`SELECT id, name, category, enabled, user_token FROM pages ORDER BY name ASC`);
    res.json({ pages, total: pages.length });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get pages' });
  }
};

exports.deletePage = async (req, res) => {
  try {
    await runQuery(`DELETE FROM pages WHERE id=?`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete page' });
  }
};

// ═══════════════════════════════════════
// FOLDER OPERATIONS
// ═══════════════════════════════════════

/**
 * Cross-platform folder picker.
 *
 * - Windows: shells out to PowerShell's Shell.Application BrowseForFolder dialog.
 * - Linux/macOS: there's no equivalent system dialog from a headless server, so we
 *   return the default content path from AI settings (`default_content_folder`),
 *   falling back to `/root/<tool_name>content`. The user can still edit the path
 *   manually in the UI text input.
 */
exports.browseFolder = async (req, res) => {
  if (process.platform === 'win32') {
    const { exec } = require('child_process');
    const script = `$app = New-Object -com Shell.Application; $folder = $app.BrowseForFolder(0, 'Select Content Folder for Folder2Page', 0, 0); if($folder) { $folder.Self.Path }`;
    return exec(`powershell.exe -Command "${script}"`, (err, stdout) => {
      if (stdout && stdout.trim().length > 0) res.json({ path: stdout.trim() });
      else res.json({ path: null });
    });
  }

  // Linux / macOS: derive a suggestion from AI settings
  try {
    const row = await getQuery(`SELECT default_content_folder, tool_name FROM ai_settings WHERE id=1`);
    const suggested = (row?.default_content_folder && row.default_content_folder.trim())
      || (row?.tool_name ? `/root/${row.tool_name}content` : '/root/imagestool1content');
    res.json({
      path: fs.existsSync(suggested) ? suggested : null,
      suggested,
      message: fs.existsSync(suggested)
        ? `Using default folder: ${suggested}`
        : `Suggested folder "${suggested}" does not exist yet. Create it via FileZilla (mkdir) or edit the path manually.`
    });
  } catch (e) {
    res.json({ path: null, error: e.message });
  }
};

/**
 * List immediate subdirectories of a given path. Used by the UI folder picker
 * modal so the user can navigate visually on the VPS without an OS dialog.
 *
 * Hardening:
 *   - Path must be absolute.
 *   - Path must exist and be a directory.
 *   - We do NOT follow symlinks outside the target (no recursion either).
 */
exports.listDir = async (req, res) => {
  try {
    let dir = (req.query.path || '').toString();
    if (!dir) {
      // Default: on Linux start at /root, on Windows show drives
      if (process.platform === 'win32') {
        // Crude drive listing
        const drives = [];
        for (let c = 67; c < 91; c++) {  // C-Z
          const d = String.fromCharCode(c) + ':\\';
          try { if (fs.existsSync(d)) drives.push({ name: d, path: d, isDir: true }); } catch (_) {}
        }
        return res.json({ path: '', parent: null, entries: drives });
      }
      dir = '/root';
      if (!fs.existsSync(dir)) dir = '/home';
      if (!fs.existsSync(dir)) dir = '/';
    }
    if (!path.isAbsolute(dir)) return res.status(400).json({ error: 'Path must be absolute' });
    if (!fs.existsSync(dir)) return res.status(404).json({ error: 'Path does not exist' });
    const stat = fs.statSync(dir);
    if (!stat.isDirectory()) return res.status(400).json({ error: 'Path is not a directory' });

    const entries = [];
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        // Skip hidden files starting with a dot (typical Unix convention)
        if (e.name.startsWith('.')) continue;
        if (e.isDirectory()) entries.push({ name: e.name, path: path.join(dir, e.name), isDir: true });
      }
    } catch (e) {
      return res.status(403).json({ error: `Cannot read directory: ${e.message}` });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const parent = path.dirname(dir);
    res.json({
      path: dir,
      parent: parent === dir ? null : parent,
      entries
    });
  } catch (err) {
    res.status(500).json({ error: 'List dir failed: ' + err.message });
  }
};

/**
 * Scan a shared content folder — just count media files
 */
exports.scanFolder = async (req, res) => {
  const { folder_path } = req.body;
  if (!folder_path || !fs.existsSync(folder_path)) {
    return res.status(400).json({ error: 'Invalid folder path' });
  }

  try {
    const files = [];
    const entries = fs.readdirSync(folder_path, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'posted' || entry.name === 'failed') continue;
      if (entry.isFile() && !entry.name.startsWith('.')) {
        const ext = path.extname(entry.name).toLowerCase();
        if (MEDIA_EXTENSIONS.includes(ext)) {
          files.push({
            name: entry.name,
            path: path.join(folder_path, entry.name),
            size: fs.statSync(path.join(folder_path, entry.name)).size
          });
        }
      }
    }

    files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

    const videoExts = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.flv', '.wmv', '.m4v'];
    const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'];
    let videoCount = 0;
    let imageCount = 0;
    for (const f of files) {
      const ext = path.extname(f.name).toLowerCase();
      if (videoExts.includes(ext)) videoCount++;
      else if (imageExts.includes(ext)) imageCount++;
    }

    res.json({
      total_files: files.length,
      video_count: videoCount,
      image_count: imageCount,
      files: files.slice(0, 20).map(f => f.name),
      folder_path
    });
  } catch (err) {
    res.status(500).json({ error: 'Scan failed: ' + err.message });
  }
};

// ═══════════════════════════════════════
// SESSION & ENGINE CONTROL
// ═══════════════════════════════════════

exports.createSession = async (req, res) => {
  try {
    const { content_folder, selected_pages, schedule_time, mode } = req.body;

    if (!content_folder || !fs.existsSync(content_folder)) {
      return res.status(400).json({ error: 'Invalid content folder' });
    }
    if (!selected_pages || !Array.isArray(selected_pages) || !selected_pages.length) {
      return res.status(400).json({ error: 'Select at least one page' });
    }

    const pagesJson = JSON.stringify(selected_pages);
    const schedTime = schedule_time ? new Date(schedule_time).getTime() : null;
    const sessionMode = mode || 'manual';

    const result = await runQuery(`
      INSERT INTO sessions (content_folder, selected_pages, schedule_time, mode, status, total_pages, completed_pages)
      VALUES (?,?,?,?,?,?,0)
    `, [content_folder, pagesJson, schedTime, sessionMode, 'pending', selected_pages.length]);

    res.json({ success: true, session_id: result.id, message: 'Session created!' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create session: ' + err.message });
  }
};

exports.startPosting = async (req, res) => {
  try {
    const { session_id, rounds, rest_minutes } = req.body;
    if (!session_id) return res.status(400).json({ error: 'session_id is required' });

    const opts = {};
    if (rounds !== undefined) {
      const parsed = parseInt(rounds);
      opts.totalRounds = isNaN(parsed) ? 1 : parsed;
    }
    if (rest_minutes !== undefined) opts.restMinutes = parseInt(rest_minutes) || 0;

    const result = await startEngine(session_id, opts);
    const state = getEngineState();

    res.json({ success: true, ...result, state });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.stopPosting = async (req, res) => {
  try {
    const result = stopEngine();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getStatus = async (req, res) => {
  try {
    const state = getEngineState();

    const pagesCount = await getQuery(`SELECT COUNT(*) as cnt FROM pages`);
    state.connectedPages = pagesCount?.cnt || 0;

    if (state.sessionId) {
      const progress = await allQuery(
        `SELECT * FROM progress WHERE session_id=? ORDER BY id ASC`,
        [state.sessionId]
      );
      state.progress = progress;

      const session = await getQuery(`SELECT * FROM sessions WHERE id=?`, [state.sessionId]);
      state.session = session;
    }

    res.json(state);
  } catch (err) {
    res.status(500).json({ error: 'Failed to get status' });
  }
};

exports.getProgress = async (req, res) => {
  try {
    const sessionId = req.query.session_id;
    if (!sessionId) return res.status(400).json({ error: 'session_id required' });

    const progress = await allQuery(
      `SELECT * FROM progress WHERE session_id=? ORDER BY id ASC`,
      [sessionId]
    );
    const session = await getQuery(`SELECT * FROM sessions WHERE id=?`, [sessionId]);

    res.json({ progress, session });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get progress' });
  }
};

// ═══════════════════════════════════════
// LOGS & HISTORY
// ═══════════════════════════════════════

exports.getLogs = async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const logs = await allQuery(
      `SELECT id, session_id, page_id, page_name, content_file, content_name, caption, status, error_msg, created_at FROM posting_logs ORDER BY created_at DESC LIMIT ?`, [limit]
    );
    res.json({ logs });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get logs' });
  }
};

exports.clearLogs = async (req, res) => {
  try {
    await runQuery(`DELETE FROM posting_logs`);
    await runQuery(`DELETE FROM progress`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to clear logs' });
  }
};

exports.getSessions = async (req, res) => {
  try {
    const sessions = await allQuery(`SELECT * FROM sessions ORDER BY created_at DESC LIMIT 50`);
    res.json({ sessions });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get sessions' });
  }
};

exports.clearSessions = async (req, res) => {
  try {
    await runQuery(`DELETE FROM sessions`);
    await runQuery(`DELETE FROM progress`);
    await runQuery(`DELETE FROM posting_logs`);
    res.json({ success: true, message: 'All session history cleared.' });
  } catch (err) {
    console.error('[Clear Sessions] Error:', err.message);
    res.status(500).json({ error: 'Failed to clear sessions: ' + err.message });
  }
};

exports.resetSystem = async (req, res) => {
  try {
    await runQuery(`DELETE FROM posting_logs`);
    await runQuery(`DELETE FROM progress`);
    await runQuery(`DELETE FROM sessions`);
    await runQuery(`UPDATE engine_state SET status='idle', active_session_id=NULL, current_page_index=0 WHERE id=1`);
    res.json({ success: true, message: 'System reset complete.' });
  } catch (err) {
    res.status(500).json({ error: 'Reset failed' });
  }
};

// ═══════════════════════════════════════
// ANALYTICS
// ═══════════════════════════════════════

exports.getAnalytics = async (req, res) => {
  try {
    const perPage = await allQuery(`
      SELECT 
        page_id, page_name,
        COUNT(*) as total_posts,
        SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) as success_count,
        SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) as failed_count,
        SUM(CASE WHEN status='skipped' THEN 1 ELSE 0 END) as skipped_count,
        MAX(created_at) as last_post_at,
        MAX(CASE WHEN status='failed' THEN created_at ELSE NULL END) as last_failed_at
      FROM posting_logs
      GROUP BY page_id
      ORDER BY total_posts DESC
    `);

    const totals = await getQuery(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) as success,
        SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN status='skipped' THEN 1 ELSE 0 END) as skipped
      FROM posting_logs
    `);

    const sessions = await allQuery(`
      SELECT id, content_folder, mode, status, total_pages, completed_pages, 
             started_at, finished_at, created_at
      FROM sessions ORDER BY created_at DESC LIMIT 20
    `);

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayStats = await getQuery(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) as success,
        SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) as failed
      FROM posting_logs WHERE created_at >= ?
    `, [todayStart.getTime()]);

    res.json({ perPage, totals: totals || {}, sessions, todayStats: todayStats || {} });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get analytics: ' + err.message });
  }
};

// ═══════════════════════════════════════
// SETTINGS
// ═══════════════════════════════════════

exports.getSettings = async (req, res) => {
  try {
    const state = await getQuery(`SELECT * FROM engine_state WHERE id=1`);
    res.json({
      gap_minutes: state?.gap_minutes || 5,
      total_rounds: (state?.total_rounds !== undefined && state?.total_rounds !== null) ? state.total_rounds : 1,
      rest_minutes: state?.rest_minutes || 0,
      use_proxies: state?.use_proxies !== undefined ? !!state.use_proxies : true
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get settings' });
  }
};

exports.updateSettings = async (req, res) => {
  try {
    const { gap_minutes, total_rounds, rest_minutes, use_proxies } = req.body;
    const gap = Math.max(1, Math.min(60, parseInt(gap_minutes) || 5));
    const parsedRounds = parseInt(total_rounds);
    const rounds = isNaN(parsedRounds) ? 1 : Math.max(0, parsedRounds);
    const rest = Math.max(0, parseInt(rest_minutes) || 0);
    const useProxiesInt = use_proxies === false ? 0 : 1;
    
    await runQuery(`UPDATE engine_state SET gap_minutes=?, total_rounds=?, rest_minutes=?, use_proxies=? WHERE id=1`, [gap, rounds, rest, useProxiesInt]);
    
    const { setGapMinutes } = require('../engine/postingEngine');
    setGapMinutes(gap);
    
    res.json({ success: true, gap_minutes: gap, total_rounds: rounds, rest_minutes: rest, use_proxies: !!useProxiesInt });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update settings: ' + err.message });
  }
};

// ═══════════════════════════════════════
// TOKEN REFRESH
// ═══════════════════════════════════════

exports.refreshTokens = async (req, res) => {
  try {
    const result = await refreshPageTokens();
    res.json({ success: true, ...result, message: `Token refresh complete: ${result.updated} pages updated.` });
  } catch (err) {
    res.status(500).json({ error: 'Token refresh failed: ' + err.message });
  }
};

// ═══════════════════════════════════════
// PROXY MANAGEMENT
// ═══════════════════════════════════════

const proxyService = require('../services/proxyService');

exports.addProxies = async (req, res) => {
  try {
    const { proxies_text } = req.body;
    if (!proxies_text || !proxies_text.trim()) {
      return res.status(400).json({ error: 'Please paste proxy list' });
    }
    const result = await proxyService.addProxies(proxies_text);
    res.json({ success: true, ...result, message: `Added ${result.added} proxies (${result.skipped} skipped)` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to add proxies: ' + err.message });
  }
};

exports.getProxies = async (req, res) => {
  try {
    const proxies = await proxyService.getProxies();
    res.json({ proxies });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get proxies' });
  }
};

exports.deleteProxy = async (req, res) => {
  try {
    await proxyService.deleteProxy(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete proxy' });
  }
};

exports.toggleProxy = async (req, res) => {
  try {
    await proxyService.toggleProxy(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to toggle proxy' });
  }
};

exports.checkProxy = async (req, res) => {
  try {
    const result = await proxyService.checkSingleProxy(req.params.id);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: 'Check failed: ' + err.message });
  }
};

exports.checkAllProxies = async (req, res) => {
  try {
    const results = await proxyService.checkAllProxies();
    res.json({ success: true, results, message: `Checked ${results.length} proxies` });
  } catch (err) {
    res.status(500).json({ error: 'Check failed: ' + err.message });
  }
};

exports.getProxyMap = async (req, res) => {
  try {
    const map = await proxyService.getProxyMap();
    res.json({ map });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get proxy map' });
  }
};

exports.saveProxyMap = async (req, res) => {
  try {
    const { map } = req.body;
    if (!map) return res.status(400).json({ error: 'Map data required' });
    const result = await proxyService.saveProxyMap(map);
    res.json({ success: true, ...result, message: `Saved ${result.total} page assignments` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save map: ' + err.message });
  }
};

exports.autoDistributeProxies = async (req, res) => {
  try {
    const { pages_per_proxy } = req.body;
    const result = await proxyService.autoDistribute(parseInt(pages_per_proxy) || 10);
    if (result.error) return res.status(400).json({ error: result.error });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: 'Auto-distribute failed: ' + err.message });
  }
};

// ═══════════════════════════════════════
// SERVER INFO (IP & LOCATION)
// ═══════════════════════════════════════

let cachedServerInfo = null;
let lastServerInfoFetch = 0;

exports.getServerInfo = async (req, res) => {
  try {
    const now = Date.now();
    // Cache for 1 hour to prevent rate limits
    if (!cachedServerInfo || now - lastServerInfoFetch > 3600000) {
      try {
        const resp = await axios.get('http://ip-api.com/json/?fields=status,query,country,city,countryCode', { timeout: 5000 });
        if (resp.data && resp.data.status === 'success') {
          cachedServerInfo = {
            ip: resp.data.query,
            country: resp.data.country,
            city: resp.data.city,
            countryCode: resp.data.countryCode
          };
          lastServerInfoFetch = now;
        } else {
          throw new Error('IP API failed');
        }
      } catch (e) {
        // Fallback to basic IP if geo fails
        const ipResp = await axios.get('https://api.ipify.org?format=json', { timeout: 3000 });
        cachedServerInfo = {
          ip: ipResp.data?.ip || '127.0.0.1',
          country: 'Local',
          city: 'Server',
          countryCode: 'US'
        };
      }
    }
    
    // Add current server time
    const serverTime = new Date().toLocaleString('en-US', { 
      timeZone: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
      hour12: true,
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit'
    });

    res.json({ ...cachedServerInfo, time: serverTime });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch server info' });
  }
};

