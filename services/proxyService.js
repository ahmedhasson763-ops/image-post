/**
 * Proxy Service — Parse, validate, check, and manage proxies
 * Supports formats:
 *   ip:port:user:pass
 *   user:pass@ip:port
 *   http://user:pass@ip:port
 *   https://user:pass@ip:port
 *   socks5://user:pass@ip:port
 *   ip:port (no auth)
 */

const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { runQuery, getQuery, allQuery } = require('../database/db');

// ══════════════════════════════════════
// PROXY PARSING
// ══════════════════════════════════════

function parseProxy(line) {
  line = line.trim();
  if (!line || line.startsWith('#')) return null;

  // URL format: protocol://user:pass@host:port
  const urlMatch = line.match(/^(https?|socks5):\/\/(?:([^:]+):([^@]+)@)?([^:]+):(\d+)/i);
  if (urlMatch) {
    return {
      protocol: urlMatch[1].toLowerCase(),
      username: urlMatch[2] || '',
      password: urlMatch[3] || '',
      host: urlMatch[4],
      port: parseInt(urlMatch[5])
    };
  }

  // user:pass@host:port
  const atMatch = line.match(/^([^:]+):([^@]+)@([^:]+):(\d+)/);
  if (atMatch) {
    return {
      protocol: 'http',
      username: atMatch[1],
      password: atMatch[2],
      host: atMatch[3],
      port: parseInt(atMatch[4])
    };
  }

  const parts = line.split(':');

  // host:port:user:pass
  if (parts.length === 4 && !isNaN(parseInt(parts[1]))) {
    return {
      protocol: 'http',
      host: parts[0],
      port: parseInt(parts[1]),
      username: parts[2],
      password: parts[3]
    };
  }

  // host:port (no auth)
  if (parts.length === 2 && !isNaN(parseInt(parts[1]))) {
    return {
      protocol: 'http',
      host: parts[0],
      port: parseInt(parts[1]),
      username: '',
      password: ''
    };
  }

  return null;
}

function parseBulkProxies(text) {
  const lines = text.split(/[\r\n]+/).filter(l => l.trim());
  const results = [];
  for (const line of lines) {
    const parsed = parseProxy(line);
    if (parsed) results.push({ ...parsed, raw: line.trim() });
  }
  return results;
}

// ══════════════════════════════════════
// PROXY AGENT CREATION
// ══════════════════════════════════════

function buildProxyUrl(proxy) {
  const auth = proxy.username ? `${proxy.username}:${proxy.password}@` : '';
  return `${proxy.protocol || 'http'}://${auth}${proxy.host}:${proxy.port}`;
}

function createProxyAgent(proxy) {
  const url = buildProxyUrl(proxy);
  if (proxy.protocol === 'socks5') {
    return new SocksProxyAgent(url);
  }
  return new HttpsProxyAgent(url);
}

// ══════════════════════════════════════
// PROXY HEALTH CHECK
// ══════════════════════════════════════

async function testProxy(proxy) {
  const agent = createProxyAgent(proxy);
  const start = Date.now();
  try {
    const resp = await axios.get('https://api.ipify.org?format=json', {
      httpsAgent: agent,
      timeout: 20000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    const speed = Date.now() - start;
    const ip = resp.data?.ip || '';

    // Fetch geolocation for the IP
    let country = '', city = '', countryCode = '';
    if (ip) {
      try {
        const geoResp = await axios.get(`http://ip-api.com/json/${ip}?fields=country,city,countryCode`, { timeout: 5000 });
        country = geoResp.data?.country || '';
        city = geoResp.data?.city || '';
        countryCode = geoResp.data?.countryCode || '';
      } catch (e) { /* geo lookup is optional */ }
    }

    return { working: true, speed, ip, country, city, countryCode };
  } catch (e) {
    return { working: false, speed: 0, ip: '', country: '', city: '', countryCode: '', error: e.message };
  }
}

// ══════════════════════════════════════
// DATABASE OPERATIONS
// ══════════════════════════════════════

async function addProxies(text) {
  const parsed = parseBulkProxies(text);
  let added = 0, skipped = 0;
  for (const p of parsed) {
    try {
      const exists = await getQuery(
        `SELECT id FROM proxies WHERE host=? AND port=?`, [p.host, p.port]
      );
      if (exists) { skipped++; continue; }
      await runQuery(
        `INSERT INTO proxies (host, port, username, password, protocol, label, status) VALUES (?,?,?,?,?,?,?)`,
        [p.host, p.port, p.username, p.password, p.protocol, `${p.host}:${p.port}`, 'unchecked']
      );
      added++;
    } catch (e) { skipped++; }
  }
  return { added, skipped, total: parsed.length };
}

async function getProxies() {
  return allQuery(`SELECT p.*, 
    (SELECT COUNT(*) FROM proxy_page_map m WHERE m.proxy_id = p.id) as assigned_pages
    FROM proxies p ORDER BY p.id ASC`);
}

async function deleteProxy(id) {
  await runQuery(`DELETE FROM proxy_page_map WHERE proxy_id=?`, [id]);
  await runQuery(`DELETE FROM proxies WHERE id=?`, [id]);
}

async function toggleProxy(id) {
  await runQuery(`UPDATE proxies SET enabled = CASE WHEN enabled=1 THEN 0 ELSE 1 END WHERE id=?`, [id]);
}

async function checkSingleProxy(id) {
  const proxy = await getQuery(`SELECT * FROM proxies WHERE id=?`, [id]);
  if (!proxy) return { error: 'Proxy not found' };

  const result = await testProxy(proxy);
  const status = result.working ? (result.speed > 5000 ? 'slow' : 'active') : 'dead';
  await runQuery(
    `UPDATE proxies SET status=?, speed_ms=?, external_ip=?, last_checked=?, country=?, city=?, country_code=? WHERE id=?`,
    [status, result.speed, result.ip, Date.now(), result.country || '', result.city || '', result.countryCode || '', id]
  );
  return { ...result, status };
}

async function checkAllProxies() {
  const proxies = await allQuery(`SELECT * FROM proxies`);
  const results = [];
  for (const proxy of proxies) {
    console.log(`[Proxy] Checking ${proxy.host}:${proxy.port}...`);
    const result = await testProxy(proxy);
    const status = result.working ? (result.speed > 5000 ? 'slow' : 'active') : 'dead';
    await runQuery(
      `UPDATE proxies SET status=?, speed_ms=?, external_ip=?, last_checked=?, country=?, city=?, country_code=? WHERE id=?`,
      [status, result.speed, result.ip, Date.now(), result.country || '', result.city || '', result.countryCode || '', proxy.id]
    );
    results.push({ id: proxy.id, host: proxy.host, port: proxy.port, ...result, status });
  }
  return results;
}

// ══════════════════════════════════════
// PROXY-PAGE MAPPING
// ══════════════════════════════════════

async function getProxyMap() {
  const rows = await allQuery(`SELECT proxy_id, page_id FROM proxy_page_map`);
  const map = {};
  for (const r of rows) {
    if (!map[r.proxy_id]) map[r.proxy_id] = [];
    map[r.proxy_id].push(r.page_id);
  }
  return map;
}

async function saveProxyMap(map) {
  // map = { proxyId: [pageId, ...], ... }
  await runQuery(`DELETE FROM proxy_page_map`);
  let total = 0;
  for (const [proxyId, pageIds] of Object.entries(map)) {
    for (const pageId of pageIds) {
      await runQuery(
        `INSERT INTO proxy_page_map (proxy_id, page_id) VALUES (?,?)`,
        [parseInt(proxyId), pageId]
      );
      total++;
    }
  }
  return { total };
}

async function autoDistribute(pagesPerProxy) {
  const proxies = await allQuery(`SELECT id FROM proxies WHERE enabled=1 ORDER BY id ASC`);
  const pages = await allQuery(`SELECT id FROM pages ORDER BY name ASC`);

  if (!proxies.length) return { error: 'No active proxies found' };
  if (!pages.length) return { error: 'No pages found' };

  const perProxy = pagesPerProxy || Math.ceil(pages.length / proxies.length);
  const map = {};
  let pageIdx = 0;

  for (let i = 0; i < proxies.length && pageIdx < pages.length; i++) {
    const proxyId = proxies[i].id;
    map[proxyId] = [];

    // Last proxy gets all remaining pages
    const count = (i === proxies.length - 1) ? (pages.length - pageIdx) : Math.min(perProxy, pages.length - pageIdx);
    for (let j = 0; j < count && pageIdx < pages.length; j++) {
      map[proxyId].push(pages[pageIdx].id);
      pageIdx++;
    }
  }

  await saveProxyMap(map);
  return { message: `Distributed ${pages.length} pages across ${Object.keys(map).length} proxies`, map };
}

async function getProxyForPage(pageId) {
  const row = await getQuery(
    `SELECT p.* FROM proxies p JOIN proxy_page_map m ON p.id = m.proxy_id 
     WHERE m.page_id = ? AND p.enabled = 1 AND p.status != 'dead'`, [pageId]
  );
  return row || null;
}

module.exports = {
  parseProxy, parseBulkProxies, buildProxyUrl, createProxyAgent, testProxy,
  addProxies, getProxies, deleteProxy, toggleProxy,
  checkSingleProxy, checkAllProxies,
  getProxyMap, saveProxyMap, autoDistribute, getProxyForPage
};
