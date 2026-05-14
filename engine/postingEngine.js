/**
 * HyperPost — Posting Engine v3.0
 * ─────────────────────────────────
 * Core logic:
 *   1. User selects pages + shared content folder → creates a session
 *   2. Engine processes pages one by one sequentially
 *   3. ALL pages pull from the SAME shared content folder (no sub-folders)
 *   4. Each page: pick first available file → upload → delete file
 *   5. Configurable gap between pages
 *   6. Full crash recovery from SQLite state
 *   7. Multi-round support with rest periods between rounds
 *   8. Auto-idle after all rounds complete
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { runQuery, getQuery, allQuery } = require('../database/db');
const { postToPage } = require('../services/facebookService');
const { getProxyForPage, createProxyAgent } = require('../services/proxyService');
const { generateCaption } = require('../services/aiCaptionService');

const MEDIA_EXTENSIONS = [
  '.mp4', '.mov', '.avi', '.mkv', '.webm', '.flv', '.wmv', '.m4v',
  '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'
];

let GAP_MINUTES = 5; // configurable from settings
const MAX_RETRIES = 3;

function setGapMinutes(val) {
  GAP_MINUTES = Math.max(1, Math.min(60, parseInt(val) || 5));
  console.log(`[Engine] ⏱️ Gap set to ${GAP_MINUTES} minutes`);
}

let engine = {
  isRunning: false,
  stopRequested: false,
  status: 'idle',        // idle | waiting | posting | resting | completed | stopped | scheduled
  sessionId: null,
  currentPageIndex: 0,
  totalPages: 0,
  currentPageName: '',
  currentFileName: '',
  scheduleTicker: null,
  nextPostTime: null,
  // Rounds & rest
  totalRounds: 1,
  currentRound: 1,
  restMinutes: 0,
  restUntil: null,
  // Persisted selections
  contentFolder: '',
  selectedPages: [],
  // Enhanced tracking
  completedPageNames: [],   // last done page names
  upcomingPageNames: [],     // next upcoming page names
  allPageNames: [],          // all page names in order
  lastPostResult: null,      // last post result for error display
  lastCaption: '',           // most recent caption posted (for live display)
  lastCaptionSource: ''      // 'filename' or 'ai:<provider>:<model>'
};

// ══════════════════════════════════════
// UTILITIES
// ══════════════════════════════════════

const sleep = ms => new Promise(r => setTimeout(r, ms));

function getBDTDate() {
  const now = new Date();
  return new Date(now.getTime() + (now.getTimezoneOffset() * 60000) + (6 * 3600000));
}

/**
 * Scan a folder for media files (excluding posted/ and failed/ subdirs)
 * This scans the shared content folder directly — all pages use the same pool.
 */
function scanForContent(folderPath) {
  if (!folderPath || !fs.existsSync(folderPath)) return [];
  const files = [];
  try {
    for (const entry of fs.readdirSync(folderPath, { withFileTypes: true })) {
      if (entry.name === 'posted' || entry.name === 'failed') continue;
      if (entry.isFile() && !entry.name.startsWith('.')) {
        const ext = path.extname(entry.name).toLowerCase();
        if (MEDIA_EXTENSIONS.includes(ext)) {
          files.push(path.join(folderPath, entry.name));
        }
      }
    }
  } catch (e) { console.error('[Engine] Scan error:', e.message); }
  files.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  return files;
}

/**
 * Delete a file after successful posting
 */
function deleteFile(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`[Engine] 🗑️ Deleted: ${path.basename(filePath)}`);
    }
  } catch (e) { console.error('[Engine] Delete error:', e.message); }
}

/**
 * Move file to failed/ subfolder
 */
function moveToFailed(filePath) {
  try {
    const failedDir = path.join(path.dirname(filePath), 'failed');
    if (!fs.existsSync(failedDir)) fs.mkdirSync(failedDir, { recursive: true });
    const dest = path.join(failedDir, path.basename(filePath));
    fs.renameSync(filePath, dest);
    console.log(`[Engine] ⚠️ Moved to failed: ${path.basename(filePath)}`);
  } catch (e) { console.error('[Engine] Move error:', e.message); }
}

// ══════════════════════════════════════
// TOKEN REFRESH — Fix for deactivated/republished pages
// ══════════════════════════════════════

/**
 * Re-fetch fresh page access tokens from Facebook using stored user tokens.
 * This fixes the issue where pages were deactivated when the token was first taken,
 * then later republished — the stored page access token would be stale/invalid.
 */
async function refreshPageTokens() {
  console.log('[Engine] 🔄 Refreshing page access tokens from Facebook...');
  try {
    const users = await allQuery(`SELECT DISTINCT access_token FROM users`);
    let totalUpdated = 0;
    let totalFailed = 0;

    for (const user of users) {
      const userToken = user.access_token;
      if (!userToken) continue;

      try {
        // Fetch fresh page tokens from Facebook
        let url = `https://graph.facebook.com/v19.0/me/accounts?access_token=${userToken}&fields=id,name,access_token,category&limit=100`;
        
        while (url) {
          try {
            const resp = await axios.get(url);
            if (resp.data?.data) {
              for (const p of resp.data.data) {
                if (p.access_token) {
                  // Update the page's access token in our DB
                  const result = await runQuery(
                    `UPDATE pages SET access_token=? WHERE id=? AND user_token=?`,
                    [p.access_token, p.id, userToken]
                  );
                  if (result.changes > 0) totalUpdated++;
                }
              }
            }
            url = resp.data?.paging?.next || null;
          } catch (pageErr) {
            console.error('[Engine] Token refresh page error:', pageErr.response?.data?.error?.message || pageErr.message);
            break;
          }
        }

        // Also try business pages
        try {
          let bizUrl = `https://graph.facebook.com/v19.0/me/businesses?access_token=${userToken}&limit=100`;
          let businesses = [];
          while (bizUrl) {
            const bizRes = await axios.get(bizUrl);
            if (bizRes.data?.data) businesses = businesses.concat(bizRes.data.data);
            bizUrl = bizRes.data?.paging?.next || null;
          }

          for (const biz of businesses) {
            let ownedUrl = `https://graph.facebook.com/v19.0/${biz.id}/owned_pages?access_token=${userToken}&fields=id,name,access_token,category&limit=100`;
            while (ownedUrl) {
              const res2 = await axios.get(ownedUrl);
              if (res2.data?.data) {
                for (const p of res2.data.data) {
                  if (p.access_token) {
                    const result = await runQuery(
                      `UPDATE pages SET access_token=? WHERE id=? AND user_token=?`,
                      [p.access_token, p.id, userToken]
                    );
                    if (result.changes > 0) totalUpdated++;
                  }
                }
              }
              ownedUrl = res2.data?.paging?.next || null;
            }
          }
        } catch (bizErr) {
          // Business pages are optional
        }
      } catch (userErr) {
        totalFailed++;
        console.error(`[Engine] Token refresh failed for user token ${userToken.substring(0, 10)}...:`, userErr.message);
      }
    }

    console.log(`[Engine] ✅ Token refresh complete: ${totalUpdated} pages updated, ${totalFailed} errors`);
    return { updated: totalUpdated, failed: totalFailed };
  } catch (e) {
    console.error('[Engine] Token refresh error:', e.message);
    return { updated: 0, failed: 1, error: e.message };
  }
}

// ══════════════════════════════════════
// STATE PERSISTENCE
// ══════════════════════════════════════

async function saveEngineState() {
  try {
    await runQuery(`UPDATE engine_state SET 
      status=?, active_session_id=?, current_page_index=?, last_activity=?,
      total_rounds=?, current_round=?, rest_minutes=?, rest_until=?,
      content_folder=?, selected_pages=?
      WHERE id=1`, [
      engine.status, engine.sessionId, engine.currentPageIndex, Date.now(),
      engine.totalRounds, engine.currentRound, engine.restMinutes, engine.restUntil,
      engine.contentFolder, JSON.stringify(engine.selectedPages)
    ]);
  } catch (e) { console.error('[Engine] State save error:', e.message); }
}

async function logPost(sessionId, pageId, pageName, filePath, fileName, caption, status, errorMsg = null, proxyInfo = '', captionSource = '') {
  try {
    await runQuery(`INSERT INTO posting_logs
      (session_id, page_id, page_name, content_file, content_name, caption, status, error_msg, proxy_info, caption_source, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [sessionId, pageId, pageName, filePath, fileName, caption, status, errorMsg, proxyInfo, captionSource, Date.now()]
    );
  } catch (e) {}
}

/**
 * Build the caption for a content file.
 * 1. If AI captions are enabled and at least one provider succeeds → use AI caption.
 * 2. Otherwise (AI off, no providers, or all fail) → fall back to the filename
 *    (without extension), preserving the original behavior of the tool.
 */
async function buildCaptionForFile(contentPath) {
  const filenameCaption = path.parse(contentPath).name;
  try {
    const result = await generateCaption({
      imagePath: contentPath,
      filename: path.basename(contentPath)
    });
    if (result.caption) {
      const src = `ai:${result.used.provider}:${result.used.model}`;
      console.log(`[Engine] 🤖 AI caption ready via ${src}`);
      return { caption: result.caption, source: src };
    }
    if (result.error && !/disabled|No enabled/i.test(result.error)) {
      console.log(`[Engine] ⚠️ AI caption failed (${result.error}). Falling back to filename.`);
    }
  } catch (e) {
    console.log(`[Engine] ⚠️ AI caption exception: ${e.message}. Falling back to filename.`);
  }
  return { caption: filenameCaption, source: 'filename' };
}

// ══════════════════════════════════════
// POST WITH RETRY (3x)
// ══════════════════════════════════════

async function postWithRetry(pageId, token, caption, filePath, proxyAgent = null) {
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (attempt > 1) {
        console.log(`[Engine] 🔄 Retry ${attempt}/${MAX_RETRIES}...`);
        await sleep(10000); // 10s wait between retries
      }
      const result = await postToPage(pageId, token, caption, filePath, proxyAgent);
      return { success: true, result };
    } catch (e) {
      lastError = e;
      console.error(`[Engine] ❌ Attempt ${attempt}/${MAX_RETRIES} failed:`, e.message);
    }
  }
  return { success: false, error: lastError?.message || 'Unknown error' };
}

/**
 * Get randomized gap with ±30% variation (anti-ban)
 */
function getRandomizedGapMs() {
  const baseMs = GAP_MINUTES * 60 * 1000;
  const variation = 0.3;
  const factor = 1 - variation + (Math.random() * variation * 2);
  return Math.round(baseMs * factor);
}

// ══════════════════════════════════════
// CORE POSTING EXECUTION
// ══════════════════════════════════════

async function executeSession(sessionId, startFromIndex = 0) {
  if (engine.stopRequested) return;

  const session = await getQuery(`SELECT * FROM sessions WHERE id=?`, [sessionId]);
  if (!session) { console.error('[Engine] Session not found:', sessionId); return; }

  let selectedPages;
  try { selectedPages = JSON.parse(session.selected_pages); }
  catch (e) { console.error('[Engine] Invalid selected_pages JSON'); return; }

  if (!selectedPages.length) {
    console.log('[Engine] No pages selected.');
    await resetToIdle();
    return;
  }

  // ═══ AUTO-REFRESH PAGE TOKENS ═══
  // This fixes the issue where pages deactivated at token-creation time
  // have stale/invalid tokens even after being republished
  if (startFromIndex === 0) {
    console.log('[Engine] 🔄 Auto-refreshing page tokens before posting...');
    await refreshPageTokens();
  }

  // Get full page details from DB (AFTER token refresh!)
  const allPages = await allQuery(`SELECT * FROM pages`);
  const pageMap = {};
  for (const p of allPages) pageMap[p.id] = p;

  // Filter to only selected pages that exist in DB
  const pagesToProcess = selectedPages
    .map(pid => pageMap[pid])
    .filter(Boolean);

  engine.totalPages = pagesToProcess.length;
  engine.status = 'posting';
  engine.sessionId = sessionId;

  // Build all page names for upcoming display
  engine.allPageNames = pagesToProcess.map(p => ({ id: p.id, name: p.name }));
  engine.completedPageNames = [];

  // Update upcoming pages list
  engine.upcomingPageNames = pagesToProcess.slice(startFromIndex, startFromIndex + 5).map(p => ({ id: p.id, name: p.name }));

  // Update session as started
  await runQuery(`UPDATE sessions SET status='running', started_at=? WHERE id=?`, [Date.now(), sessionId]);
  await saveEngineState();

  console.log(`\n═══════════════════════════════════════════`);
  console.log(`🚀 [HyperPost] Session #${sessionId} — Round ${engine.currentRound}/${engine.totalRounds} — ${pagesToProcess.length} pages`);
  console.log(`📁 Shared content folder: ${session.content_folder}`);
  console.log(`═══════════════════════════════════════════\n`);

  for (let i = startFromIndex; i < pagesToProcess.length; i++) {
    if (engine.stopRequested) {
      console.log('[Engine] 🛑 Stop requested. Saving state...');
      break;
    }

    const page = pagesToProcess[i];
    engine.currentPageIndex = i;
    engine.currentPageName = page.name;

    // Update upcoming pages (next 5 from current position)
    engine.upcomingPageNames = pagesToProcess.slice(i + 1, i + 6).map(p => ({ id: p.id, name: p.name }));

    // ═══ SHARED FOLDER: All pages use the same content folder ═══
    const contentFiles = scanForContent(session.content_folder);
    
    if (!contentFiles.length) {
      console.log(`[Engine] 📭 [${i + 1}/${pagesToProcess.length}] No content left in shared folder for "${page.name}" — skipping`);
      await runQuery(`INSERT INTO progress (session_id, page_id, page_name, status, error_msg, posted_at)
        VALUES (?,?,?,?,?,?)`, [sessionId, page.id, page.name, 'skipped', 'No content files available', Date.now()]);
      await logPost(sessionId, page.id, page.name, null, null, null, 'skipped', 'No content');
      
      await runQuery(`UPDATE sessions SET completed_pages=completed_pages+1 WHERE id=?`, [sessionId]);
      engine.currentPageIndex = i + 1;
      await saveEngineState();
      continue;
    }

    // Pick the FIRST content file from the shared pool
    const contentPath = contentFiles[0];
    const contentName = path.basename(contentPath);

    engine.currentFileName = contentName;
    await saveEngineState();

    // Build caption — AI if configured, otherwise filename fallback
    const { caption, source: captionSource } = await buildCaptionForFile(contentPath);
    engine.lastCaption = caption;
    engine.lastCaptionSource = captionSource;

    // Look up proxy for this page (if globally enabled)
    let proxyAgent = null;
    let proxyLabel = 'direct';
    let countryCode = '';
    
    try {
      const state = await getQuery(`SELECT use_proxies FROM engine_state WHERE id=1`);
      const useProxies = state?.use_proxies !== undefined ? state.use_proxies : 1;
      
      if (useProxies) {
        const proxyData = await getProxyForPage(page.id);
        if (proxyData) {
          proxyAgent = createProxyAgent(proxyData);
          proxyLabel = `${proxyData.external_ip || proxyData.host}`;
          countryCode = proxyData.country_code || '';
        }
      }
      
      // If no proxy, fetch direct IP
      if (!proxyAgent) {
        try {
          const resp = await require('axios').get('http://ip-api.com/json/?fields=query,countryCode', { timeout: 3000 });
          proxyLabel = `${resp.data?.query || 'Unknown'} (Direct)`;
          countryCode = resp.data?.countryCode || '';
        } catch(e) {
          proxyLabel = 'Direct IP';
        }
      }
      
      // Append country flag if we have it
      if (countryCode) {
        const flag = String.fromCodePoint(...[...countryCode.toUpperCase()].map(c => c.charCodeAt() + 127397));
        proxyLabel = `${flag} ${proxyLabel}`;
      }
    } catch (e) { console.log('[Engine] Proxy lookup skip:', e.message); }

    console.log(`[Engine] 📤 [${i + 1}/${pagesToProcess.length}] "${contentName}" → "${page.name}" via ${proxyLabel}`);

    // Post with retry (through proxy if assigned)
    const result = await postWithRetry(page.id, page.access_token, caption, contentPath, proxyAgent);

    if (result.success) {
      console.log(`[Engine] ✅ Success! Posted to "${page.name}"`);
      
      // DELETE the file after successful post (consumed from shared pool)
      deleteFile(contentPath);
      
      await runQuery(`INSERT INTO progress (session_id, page_id, page_name, content_file, content_name, status, posted_at)
        VALUES (?,?,?,?,?,?,?)`, [sessionId, page.id, page.name, contentPath, contentName, 'success', Date.now()]);
      await logPost(sessionId, page.id, page.name, contentPath, contentName, caption, 'success', null, proxyLabel, captionSource);

      // Track completed page
      engine.completedPageNames.push({ id: page.id, name: page.name, status: 'success', time: Date.now(), proxy: proxyLabel, captionSource });
      engine.lastPostResult = { page: page.name, status: 'success', captionSource };
    } else {
      console.log(`[Engine] ❌ Failed for "${page.name}": ${result.error}`);

      // Move to failed folder
      moveToFailed(contentPath);

      await runQuery(`INSERT INTO progress (session_id, page_id, page_name, content_file, content_name, status, error_msg, posted_at)
        VALUES (?,?,?,?,?,?,?,?)`, [sessionId, page.id, page.name, contentPath, contentName, 'failed', result.error, Date.now()]);
      await logPost(sessionId, page.id, page.name, contentPath, contentName, caption, 'failed', result.error, proxyLabel, captionSource);

      // Track completed page (even failed ones)
      engine.completedPageNames.push({ id: page.id, name: page.name, status: 'failed', error: result.error, time: Date.now(), proxy: proxyLabel, captionSource });
      engine.lastPostResult = { page: page.name, status: 'failed', error: result.error, captionSource };
    }

    // Update session progress
    await runQuery(`UPDATE sessions SET completed_pages=completed_pages+1 WHERE id=?`, [sessionId]);
    engine.currentPageIndex = i + 1;
    await saveEngineState();

    // Wait gap minutes before next page (unless it's the last one or stop requested)
    // Uses ±30% random variation to appear more human-like (anti-ban)
    if (i < pagesToProcess.length - 1 && !engine.stopRequested) {
      const waitMs = getRandomizedGapMs();
      engine.nextPostTime = Date.now() + waitMs;
      engine.status = 'waiting';
      await saveEngineState();
      
      const waitMins = (waitMs / 60000).toFixed(1);
      console.log(`[Engine] ⏳ Waiting ${waitMins} min (randomized from ${GAP_MINUTES} min) before next page...`);
      
      // Sleep in small chunks so we can respond to stop requests
      const chunkMs = 5000; // check every 5 seconds
      let waited = 0;
      while (waited < waitMs && !engine.stopRequested) {
        await sleep(Math.min(chunkMs, waitMs - waited));
        waited += chunkMs;
      }
      
      engine.status = 'posting';
      engine.nextPostTime = null;
      await saveEngineState();
    }
  }

  // Session/round complete
  if (!engine.stopRequested) {
    await runQuery(`UPDATE sessions SET status='completed', finished_at=? WHERE id=?`, [Date.now(), sessionId]);
    
    console.log(`\n═══════════════════════════════════════════`);
    console.log(`✅ [HyperPost] Round ${engine.currentRound}/${engine.totalRounds} COMPLETED!`);
    console.log(`═══════════════════════════════════════════\n`);

    // Check if more rounds are needed
    if (engine.totalRounds === 0 || engine.currentRound < engine.totalRounds) {
      // totalRounds === 0 means infinite rounds
      await startRestPeriod();
    } else {
      // All rounds done — auto-reset to idle
      console.log(`[Engine] 🏁 All ${engine.totalRounds} rounds completed! Going idle.`);
      await resetToIdle();
    }
  } else {
    await runQuery(`UPDATE sessions SET status='paused' WHERE id=?`, [sessionId]);
    console.log(`[Engine] 🛑 Session #${sessionId} paused at page ${engine.currentPageIndex}`);
  }
}

// ══════════════════════════════════════
// REST BETWEEN ROUNDS
// ══════════════════════════════════════

async function startRestPeriod() {
  if (engine.restMinutes <= 0) {
    // No rest — start next round immediately
    console.log(`[Engine] ⚡ No rest configured. Starting next round immediately...`);
    await startNextRound();
    return;
  }

  const restMs = engine.restMinutes * 60 * 1000;
  engine.status = 'resting';
  engine.restUntil = Date.now() + restMs;
  engine.currentPageName = '';
  engine.currentFileName = '';
  engine.nextPostTime = null;
  await saveEngineState();

  console.log(`[Engine] 😴 Resting for ${engine.restMinutes} minutes before round ${engine.currentRound + 1}...`);

  // Sleep in chunks so we can respond to stop requests
  const chunkMs = 5000;
  let waited = 0;
  while (waited < restMs && !engine.stopRequested) {
    await sleep(Math.min(chunkMs, restMs - waited));
    waited += chunkMs;
  }

  if (!engine.stopRequested) {
    engine.restUntil = null;
    await startNextRound();
  }
}

async function startNextRound() {
  if (engine.stopRequested) return;

  engine.currentRound++;
  engine.currentPageIndex = 0;
  engine.currentPageName = '';
  engine.currentFileName = '';
  engine.nextPostTime = null;

  console.log(`[Engine] 🔄 Starting round ${engine.currentRound}/${engine.totalRounds || '∞'}...`);

  // Create a new session for this round with same config
  const state = await getQuery(`SELECT * FROM engine_state WHERE id=1`);
  if (!state || !state.content_folder || !state.selected_pages) {
    console.error('[Engine] Cannot start next round — no persisted config');
    await resetToIdle();
    return;
  }

  const result = await runQuery(`
    INSERT INTO sessions (content_folder, selected_pages, mode, status, total_pages, completed_pages)
    VALUES (?,?,?,?,?,0)
  `, [state.content_folder, state.selected_pages, 'manual', 'pending', JSON.parse(state.selected_pages).length]);

  engine.sessionId = result.id;
  engine.status = 'posting';
  await saveEngineState();

  await executeSession(result.id, 0);
}

async function resetToIdle() {
  engine.isRunning = false;
  engine.status = 'idle';
  engine.sessionId = null;
  engine.currentPageIndex = 0;
  engine.totalPages = 0;
  engine.currentPageName = '';
  engine.currentFileName = '';
  engine.nextPostTime = null;
  engine.restUntil = null;
  engine.stopRequested = false;

  await runQuery(`UPDATE engine_state SET 
    status='idle', active_session_id=NULL, current_page_index=0, 
    current_round=0, rest_until=NULL, last_activity=?
    WHERE id=1`, [Date.now()]);

  console.log('[Engine] 💤 Engine is now IDLE');
}

// ══════════════════════════════════════
// SCHEDULED MODE
// ══════════════════════════════════════

function startScheduleWatcher(sessionId, scheduleTime) {
  if (engine.scheduleTicker) clearInterval(engine.scheduleTicker);
  
  engine.isRunning = true;
  engine.status = 'scheduled';
  engine.sessionId = sessionId;
  
  console.log(`[Engine] ⏰ Scheduled for: ${new Date(scheduleTime).toLocaleString()}`);
  
  engine.scheduleTicker = setInterval(async () => {
    if (Date.now() >= scheduleTime) {
      clearInterval(engine.scheduleTicker);
      engine.scheduleTicker = null;
      console.log('[Engine] ⏰ Schedule time reached! Starting...');
      engine.status = 'posting';
      await saveEngineState();
      executeSession(sessionId, 0).catch(e => console.error('[Engine] Error:', e));
    }
  }, 10000); // Check every 10 seconds
  
  saveEngineState();
}

// ══════════════════════════════════════
// PUBLIC API
// ══════════════════════════════════════

/**
 * Start a new posting session
 */
async function startEngine(sessionId, opts = {}) {
  if (engine.isRunning && !['completed', 'idle', 'stopped'].includes(engine.status)) {
    throw new Error('Engine is already running! Stop it first.');
  }

  const session = await getQuery(`SELECT * FROM sessions WHERE id=?`, [sessionId]);
  if (!session) throw new Error('Session not found.');

  // Load gap setting from DB
  try {
    const st = await getQuery(`SELECT gap_minutes FROM engine_state WHERE id=1`);
    if (st?.gap_minutes) GAP_MINUTES = st.gap_minutes;
  } catch(e) {}

  // Set rounds/rest config (0 = infinite, so don't use || which kills 0)
  engine.totalRounds = (opts.totalRounds !== undefined && opts.totalRounds !== null) ? opts.totalRounds : 1;
  engine.currentRound = 1;
  engine.restMinutes = opts.restMinutes || 0;
  engine.restUntil = null;

  // Persist selections for refresh recovery
  engine.contentFolder = session.content_folder;
  try { engine.selectedPages = JSON.parse(session.selected_pages); } catch(e) { engine.selectedPages = []; }

  engine.isRunning = true;
  engine.stopRequested = false;
  engine.sessionId = sessionId;
  engine.currentPageIndex = opts.resumeIndex || 0;
  engine.totalPages = 0;
  engine.currentPageName = '';
  engine.currentFileName = '';
  engine.nextPostTime = null;

  // Persist rounds/rest/selections to DB
  await runQuery(`UPDATE engine_state SET 
    total_rounds=?, current_round=?, rest_minutes=?,
    content_folder=?, selected_pages=?
    WHERE id=1`, [
    engine.totalRounds, engine.currentRound, engine.restMinutes,
    engine.contentFolder, JSON.stringify(engine.selectedPages)
  ]);

  if (session.mode === 'scheduled' && session.schedule_time && Date.now() < session.schedule_time) {
    // Scheduled mode — wait until the time
    startScheduleWatcher(sessionId, session.schedule_time);
    return { message: `Scheduled for ${new Date(session.schedule_time).toLocaleString()}` };
  } else {
    // Manual / immediate mode
    engine.status = 'posting';
    await saveEngineState();
    
    // Run asynchronously
    executeSession(sessionId, opts.resumeIndex || 0)
      .catch(e => console.error('[Engine] Execution error:', e));
    
    return { message: 'HyperPost engine started!' };
  }
}

/**
 * Stop the engine
 */
async function stopEngine() {
  engine.stopRequested = true;
  if (engine.scheduleTicker) {
    clearInterval(engine.scheduleTicker);
    engine.scheduleTicker = null;
  }
  engine.status = 'stopped';
  engine.isRunning = false;
  engine.nextPostTime = null;
  engine.restUntil = null;
  await saveEngineState();
  
  // Also reset to idle in DB so next refresh shows idle
  await runQuery(`UPDATE engine_state SET status='idle', active_session_id=NULL, current_page_index=0, current_round=0, rest_until=NULL WHERE id=1`);
  
  console.log('[Engine] 🛑 Engine STOPPED');
  return { message: 'Engine stopped.' };
}

/**
 * Get current engine state
 */
function getEngineState() {
  // Calculate estimated finish time
  let estimatedFinishTime = null;
  if (engine.isRunning && engine.totalPages > 0 && engine.currentPageIndex < engine.totalPages) {
    const remainingPages = engine.totalPages - engine.currentPageIndex;
    const remainingMs = remainingPages * GAP_MINUTES * 60 * 1000;
    estimatedFinishTime = Date.now() + remainingMs;
  }

  return {
    isRunning: engine.isRunning,
    status: engine.status,
    sessionId: engine.sessionId,
    currentPageIndex: engine.currentPageIndex,
    totalPages: engine.totalPages,
    currentPageName: engine.currentPageName,
    currentFileName: engine.currentFileName,
    nextPostTime: engine.nextPostTime,
    gapMinutes: GAP_MINUTES,
    // Rounds & rest
    totalRounds: engine.totalRounds,
    currentRound: engine.currentRound,
    restMinutes: engine.restMinutes,
    restUntil: engine.restUntil,
    // Persisted selections
    contentFolder: engine.contentFolder,
    selectedPages: engine.selectedPages,
    // Enhanced tracking
    completedPageNames: engine.completedPageNames.slice(-5),  // last 5 completed
    upcomingPageNames: engine.upcomingPageNames,               // next 5 upcoming
    allPageNames: engine.allPageNames,
    estimatedFinishTime,
    lastPostResult: engine.lastPostResult,
    lastCaption: engine.lastCaption,
    lastCaptionSource: engine.lastCaptionSource
  };
}

/**
 * Resume after crash/restart
 */
async function resumeIfNeeded() {
  try {
    const state = await getQuery(`SELECT * FROM engine_state WHERE id=1`);
    if (!state || !state.active_session_id) return;
    if (!['posting', 'waiting', 'scheduled', 'resting'].includes(state.status)) return;

    const session = await getQuery(`SELECT * FROM sessions WHERE id=?`, [state.active_session_id]);
    if (!session) return;

    console.log(`[Engine] 🔋 Detected unfinished session #${state.active_session_id}`);
    console.log(`[Engine] 🔋 Last status: ${state.status}, page index: ${state.current_page_index}, round: ${state.current_round}/${state.total_rounds}`);

    // Restore engine state (0 = infinite rounds, so don't use || which kills 0)
    engine.totalRounds = (state.total_rounds !== undefined && state.total_rounds !== null) ? state.total_rounds : 1;
    engine.currentRound = state.current_round || 1;
    engine.restMinutes = state.rest_minutes || 0;
    engine.contentFolder = state.content_folder || '';
    try { engine.selectedPages = JSON.parse(state.selected_pages || '[]'); } catch(e) { engine.selectedPages = []; }

    const resumeIdx = state.current_page_index || 0;

    setTimeout(async () => {
      try {
        if (state.status === 'resting') {
          // Was resting between rounds — check if rest period is over
          if (state.rest_until && Date.now() >= state.rest_until) {
            console.log('[Engine] 🔋 Rest period over. Starting next round...');
            engine.isRunning = true;
            engine.stopRequested = false;
            await startNextRound();
          } else if (state.rest_until) {
            // Still need to rest
            const remainingMs = state.rest_until - Date.now();
            console.log(`[Engine] 🔋 Resuming rest. ${Math.ceil(remainingMs / 60000)} minutes left...`);
            engine.isRunning = true;
            engine.stopRequested = false;
            engine.status = 'resting';
            engine.restUntil = state.rest_until;
            await saveEngineState();
            
            const chunkMs = 5000;
            let waited = 0;
            while (waited < remainingMs && !engine.stopRequested) {
              await sleep(Math.min(chunkMs, remainingMs - waited));
              waited += chunkMs;
            }
            if (!engine.stopRequested) {
              engine.restUntil = null;
              await startNextRound();
            }
          }
        } else if (session.mode === 'scheduled' && session.schedule_time && Date.now() < session.schedule_time) {
          // Still waiting for schedule
          await startEngine(state.active_session_id, {
            totalRounds: engine.totalRounds,
            currentRound: engine.currentRound,
            restMinutes: engine.restMinutes
          });
          console.log('[Engine] 🔋 Resumed schedule watcher.');
        } else {
          // Resume posting from where it stopped
          engine.isRunning = true;
          engine.stopRequested = false;
          engine.sessionId = state.active_session_id;
          engine.currentPageIndex = resumeIdx;
          engine.status = 'posting';
          await saveEngineState();

          console.log(`[Engine] 🔋 RESUMING from page index ${resumeIdx}...`);
          await executeSession(state.active_session_id, resumeIdx);
        }
      } catch (e) {
        console.error('[Engine] Resume error:', e.message);
      }
    }, 3000); // 3 second delay to let DB fully initialize
  } catch (e) {
    console.error('[Engine] Resume check error:', e.message);
  }
}

module.exports = {
  startEngine,
  stopEngine,
  getEngineState,
  resumeIfNeeded,
  scanForContent,
  setGapMinutes,
  refreshPageTokens
};
