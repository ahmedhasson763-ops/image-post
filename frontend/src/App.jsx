import React, { useState, useEffect, useRef, useCallback } from 'react';

const API = '/api';

// Theme definitions
const THEMES = {
  light: { label: '☀️ Light', key: 'light' },
  mid: { label: '🌗 Mid Dark', key: 'mid' },
  dark: { label: '🌑 Dark', key: 'dark' }
};

function App() {
  const [activeTab, setActiveTab] = useState('dashboard');
  const [theme, setTheme] = useState(() => localStorage.getItem('f2p_theme') || 'light');

  // Dashboard state
  const [token, setToken] = useState('');
  const [tokens, setTokens] = useState([]);
  const [pages, setPages] = useState([]);
  const [selectedPages, setSelectedPages] = useState([]);
  const [contentFolder, setContentFolder] = useState('');
  const [folderStats, setFolderStats] = useState(null);
  const [scheduleMode, setScheduleMode] = useState('manual');
  const [scheduleTime, setScheduleTime] = useState('');
  const [engineStatus, setEngineStatus] = useState(null);
  const [logs, setLogs] = useState([]);
  const [alert, setAlert] = useState(null);
  const [loading, setLoading] = useState({});
  const [countdown, setCountdown] = useState('');
  const [restCountdown, setRestCountdown] = useState('');

  const [rounds, setRounds] = useState(1);
  const [restMinutes, setRestMinutes] = useState(0);
  const [pageSearch, setPageSearch] = useState('');
  const [analytics, setAnalytics] = useState(null);
  const [gapMinutes, setGapMinutesState] = useState(5);
  const [settingsRounds, setSettingsRounds] = useState(1);

  // Proxy state
  const [proxies, setProxies] = useState([]);
  const [proxyInput, setProxyInput] = useState('');
  const [proxyMap, setProxyMap] = useState({});
  const [assignMode, setAssignMode] = useState('auto');
  const [pagesPerProxy, setPagesPerProxy] = useState(10);
  const [activeProxyId, setActiveProxyId] = useState(null);
  const [settingsRestMinutes, setSettingsRestMinutes] = useState(0);
  const [settingsUseProxies, setSettingsUseProxies] = useState(true);
  const [serverInfo, setServerInfo] = useState(null);

  const restoredRef = useRef(false);
  const pollRef = useRef(null);
  const countdownRef = useRef(null);
  const restCountdownRef = useRef(null);

  // Apply theme to body
  useEffect(() => {
    document.body.setAttribute('data-theme', theme);
    localStorage.setItem('f2p_theme', theme);
  }, [theme]);

  // ═══════════════════════════════════════
  // API HELPERS
  // ═══════════════════════════════════════

  const api = useCallback(async (method, path, body = null) => {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${API}${path}`, opts);
    return res.json();
  }, []);

  const showAlert = useCallback((type, msg) => {
    setAlert({ type, msg });
    setTimeout(() => setAlert(null), 5000);
  }, []);

  // ═══════════════════════════════════════
  // DATA LOADING
  // ═══════════════════════════════════════

  const loadTokens = useCallback(async () => {
    const data = await api('GET', '/tokens');
    setTokens(data.tokens || []);
  }, [api]);

  const loadPages = useCallback(async () => {
    const data = await api('GET', '/pages');
    setPages(data.pages || []);
  }, [api]);

  const loadStatus = useCallback(async () => {
    try {
      const data = await api('GET', '/status');
      const prevStatus = engineStatus?.status;
      setEngineStatus(data);
      if (prevStatus && ['posting', 'waiting', 'resting'].includes(prevStatus) && data.status === 'idle') {
        showAlert('success', '✅ All rounds completed! Engine is now idle.');
      }
    } catch (e) {}
  }, [api, engineStatus?.status, showAlert]);

  const loadLogs = useCallback(async () => {
    const data = await api('GET', '/logs?limit=50');
    setLogs(data.logs || []);
  }, [api]);

  const loadAnalytics = useCallback(async () => {
    try {
      const data = await api('GET', '/analytics');
      setAnalytics(data);
    } catch (e) {}
  }, [api]);

  const loadSettings = useCallback(async () => {
    try {
      const data = await api('GET', '/settings');
      if (data.gap_minutes) setGapMinutesState(data.gap_minutes);
      if (data.total_rounds !== undefined) { setSettingsRounds(data.total_rounds); setRounds(data.total_rounds); }
      if (data.rest_minutes !== undefined) { setSettingsRestMinutes(data.rest_minutes); setRestMinutes(data.rest_minutes); }
      if (data.use_proxies !== undefined) setSettingsUseProxies(data.use_proxies);
    } catch (e) {}
  }, [api]);

  const loadProxies = useCallback(async () => {
    try { const data = await api('GET', '/proxies'); setProxies(data.proxies || []); } catch (e) {}
  }, [api]);

  const loadProxyMap = useCallback(async () => {
    try { const data = await api('GET', '/proxy-map'); setProxyMap(data.map || {}); } catch (e) {}
  }, [api]);

  const loadServerInfo = useCallback(async () => {
    try { const data = await api('GET', '/server-info'); setServerInfo(data); } catch (e) {}
  }, [api]);


  const restoreFromBackend = useCallback(async () => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    try {
      const status = await api('GET', '/status');
      setEngineStatus(status);
      if (status.contentFolder) {
        setContentFolder(status.contentFolder);
        const scanData = await api('POST', '/scan-folder', { folder_path: status.contentFolder });
        if (!scanData.error) setFolderStats(scanData);
      }
      if (status.selectedPages?.length > 0) setSelectedPages(status.selectedPages);
      if (status.totalRounds !== undefined) setRounds(status.totalRounds);
      if (status.restMinutes !== undefined) setRestMinutes(status.restMinutes);
    } catch (e) { console.error('Restore error:', e); }
  }, [api]);

  useEffect(() => {
    loadTokens(); loadPages(); loadLogs(); loadSettings(); loadProxies(); loadProxyMap(); loadServerInfo(); restoreFromBackend();
    pollRef.current = setInterval(() => { loadStatus(); loadLogs(); loadServerInfo(); }, 5000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (countdownRef.current) clearInterval(countdownRef.current);
      if (restCountdownRef.current) clearInterval(restCountdownRef.current);
    };
  }, [loadTokens, loadPages, loadLogs, loadSettings, loadProxies, loadProxyMap, restoreFromBackend]);

  useEffect(() => { if (activeTab === 'analytics') loadAnalytics(); }, [activeTab, loadAnalytics]);
  useEffect(() => { if (activeTab === 'proxy') { loadProxies(); loadProxyMap(); loadPages(); } }, [activeTab, loadProxies, loadProxyMap, loadPages]);

  // Countdown timers
  useEffect(() => {
    if (countdownRef.current) clearInterval(countdownRef.current);
    if (engineStatus?.nextPostTime && engineStatus.status === 'waiting') {
      countdownRef.current = setInterval(() => {
        const remaining = engineStatus.nextPostTime - Date.now();
        if (remaining <= 0) { setCountdown('Starting...'); return; }
        const mins = Math.floor(remaining / 60000);
        const secs = Math.floor((remaining % 60000) / 1000);
        setCountdown(`${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`);
      }, 1000);
    } else { setCountdown(''); }
    return () => { if (countdownRef.current) clearInterval(countdownRef.current); };
  }, [engineStatus?.nextPostTime, engineStatus?.status]);

  useEffect(() => {
    if (restCountdownRef.current) clearInterval(restCountdownRef.current);
    if (engineStatus?.restUntil && engineStatus.status === 'resting') {
      restCountdownRef.current = setInterval(() => {
        const remaining = engineStatus.restUntil - Date.now();
        if (remaining <= 0) { setRestCountdown('Starting next round...'); return; }
        const hrs = Math.floor(remaining / 3600000);
        const mins = Math.floor((remaining % 3600000) / 60000);
        const secs = Math.floor((remaining % 60000) / 1000);
        setRestCountdown(hrs > 0 ? `${hrs}h ${String(mins).padStart(2, '0')}m ${String(secs).padStart(2, '0')}s` : `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`);
      }, 1000);
    } else { setRestCountdown(''); }
    return () => { if (restCountdownRef.current) clearInterval(restCountdownRef.current); };
  }, [engineStatus?.restUntil, engineStatus?.status]);

  // ═══════════════════════════════════════
  // ACTIONS
  // ═══════════════════════════════════════

  const handleAuth = async () => {
    if (!token.trim()) return showAlert('error', 'Please enter an access token.');
    setLoading(l => ({ ...l, auth: true }));
    try {
      const data = await api('POST', '/auth', { access_token: token.trim() });
      if (data.error) throw new Error(data.error);
      showAlert('success', `✅ ${data.total_pages} pages synced for ${data.user_name || 'account'}!`);
      setToken('');
      loadTokens(); loadPages();
    } catch (e) { showAlert('error', e.message); }
    setLoading(l => ({ ...l, auth: false }));
  };

  const handleDeleteToken = async (id) => {
    await api('DELETE', `/tokens/${id}`);
    loadTokens(); loadPages();
    showAlert('info', 'Token removed');
  };

  const handleDeletePage = async (e, pageId) => {
    e.stopPropagation();
    await api('DELETE', `/pages/${pageId}`);
    setSelectedPages(prev => prev.filter(id => id !== pageId));
    loadPages();
  };

  const handleClearSessions = async () => {
    if (!window.confirm('Clear ALL session history, logs and progress data?')) return;
    setLoading(l => ({ ...l, clearSessions: true }));
    try {
      const result = await api('POST', '/clear-sessions');
      console.log('[Clear Sessions] Response:', result);
      if (result.error) throw new Error(result.error);
      // Force refresh analytics data
      setAnalytics(prev => ({
        ...prev,
        sessions: [],
        totals: { total: 0, success: 0, failed: 0, skipped: 0 },
        perPage: [],
        todayStats: { total: 0, success: 0, failed: 0 }
      }));
      setLogs([]);
      showAlert('success', '✅ All session history cleared!');
      // Also reload from server to confirm
      setTimeout(() => loadAnalytics(), 500);
    } catch (e) {
      console.error('[Clear Sessions] Error:', e);
      showAlert('error', 'Failed to clear: ' + e.message);
    }
    setLoading(l => ({ ...l, clearSessions: false }));
  };

  const handleResetSystem = async () => {
    if (!window.confirm('⚠️ DELETE ALL DATA? This cannot be undone!\n\nThis will delete:\n- All posting logs\n- All session history\n- All progress data')) return;
    setLoading(l => ({ ...l, reset: true }));
    try {
      const result = await api('POST', '/reset');
      console.log('[Reset] Response:', result);
      if (result.error) throw new Error(result.error);
      // Force clear all local state
      setAnalytics({ sessions: [], totals: { total: 0, success: 0, failed: 0, skipped: 0 }, perPage: [], todayStats: { total: 0, success: 0, failed: 0 } });
      setLogs([]);
      showAlert('success', '✅ System reset complete! All data deleted.');
      setTimeout(() => loadAnalytics(), 500);
    } catch (e) {
      console.error('[Reset] Error:', e);
      showAlert('error', 'Reset failed: ' + e.message);
    }
    setLoading(l => ({ ...l, reset: false }));
  };

  const handleBrowseFolder = async () => {
    setLoading(l => ({ ...l, browse: true }));
    const data = await api('POST', '/browse-folder');
    if (data.path) { setContentFolder(data.path); handleScanFolder(data.path); }
    setLoading(l => ({ ...l, browse: false }));
  };

  const handleScanFolder = async (folder) => {
    if (!folder) return;
    setLoading(l => ({ ...l, scan: true }));
    const data = await api('POST', '/scan-folder', { folder_path: folder });
    if (data.error) showAlert('error', data.error);
    else setFolderStats(data);
    setLoading(l => ({ ...l, scan: false }));
  };

  const togglePage = (pageId) => setSelectedPages(prev => prev.includes(pageId) ? prev.filter(id => id !== pageId) : [...prev, pageId]);
  const selectAllPages = () => setSelectedPages(pages.map(p => p.id));
  const deselectAll = () => setSelectedPages([]);

  const selectGroup = (tokenStr) => {
    const ids = pages.filter(p => p.user_token === tokenStr).map(p => p.id);
    setSelectedPages(prev => { const s = new Set(prev); ids.forEach(id => s.add(id)); return [...s]; });
  };
  const deselectGroup = (tokenStr) => {
    const ids = new Set(pages.filter(p => p.user_token === tokenStr).map(p => p.id));
    setSelectedPages(prev => prev.filter(id => !ids.has(id)));
  };

  const handleStart = async () => {
    if (!selectedPages.length) return showAlert('error', 'Please select at least one page.');
    if (!contentFolder) return showAlert('error', 'Please select a content folder.');
    setLoading(l => ({ ...l, start: true }));
    try {
      const session = await api('POST', '/sessions', {
        content_folder: contentFolder, selected_pages: selectedPages,
        mode: scheduleMode, schedule_time: scheduleMode === 'scheduled' ? scheduleTime : null
      });
      if (session.error) throw new Error(session.error);
      const result = await api('POST', '/start', { session_id: session.session_id, rounds, rest_minutes: restMinutes });
      if (result.error) throw new Error(result.error);
      showAlert('success', `🚀 ${result.message}`);
      loadStatus();
    } catch (e) { showAlert('error', e.message); }
    setLoading(l => ({ ...l, start: false }));
  };

  const handleStop = async () => { await api('POST', '/stop'); showAlert('info', '🛑 Engine stopped'); loadStatus(); };
  const handleClearLogs = async () => { await api('POST', '/clear-logs'); setLogs([]); showAlert('info', 'Logs cleared'); };

  const handleRefreshTokens = async () => {
    setLoading(l => ({ ...l, refreshTokens: true }));
    try {
      const result = await api('POST', '/refresh-tokens');
      if (result.error) throw new Error(result.error);
      showAlert('success', `🔄 ${result.message}`);
      loadPages();
    } catch (e) { showAlert('error', 'Token refresh failed: ' + e.message); }
    setLoading(l => ({ ...l, refreshTokens: false }));
  };

  const handleSaveSettings = async () => {
    setLoading(l => ({ ...l, settings: true }));
    try {
      const result = await api('POST', '/settings', { gap_minutes: gapMinutes, total_rounds: settingsRounds, rest_minutes: settingsRestMinutes, use_proxies: settingsUseProxies });
      if (result.error) throw new Error(result.error);
      setRounds(result.total_rounds); setRestMinutes(result.rest_minutes);
      showAlert('success', `✅ Settings saved!`);
    } catch (e) { showAlert('error', e.message); }
    setLoading(l => ({ ...l, settings: false }));
  };

  // ═══════════════════════════════════════
  // PROXY ACTIONS
  // ═══════════════════════════════════════

  const handleAddProxies = async () => {
    if (!proxyInput.trim()) return showAlert('error', 'Paste your proxy list first');
    setLoading(l => ({ ...l, addProxy: true }));
    try {
      const data = await api('POST', '/proxies', { proxies_text: proxyInput });
      if (data.error) throw new Error(data.error);
      showAlert('success', `✅ ${data.message}`);
      setProxyInput('');
      loadProxies();
    } catch (e) { showAlert('error', e.message); }
    setLoading(l => ({ ...l, addProxy: false }));
  };

  const handleCheckProxy = async (id) => {
    setLoading(l => ({ ...l, [`checkProxy_${id}`]: true }));
    await api('POST', `/proxies/${id}/check`);
    await loadProxies();
    setLoading(l => ({ ...l, [`checkProxy_${id}`]: false }));
  };

  const handleCheckAllProxies = async () => {
    setLoading(l => ({ ...l, checkAll: true }));
    try {
      const data = await api('POST', '/proxies/check-all');
      showAlert('success', `✅ ${data.message}`);
      loadProxies();
    } catch (e) { showAlert('error', e.message); }
    setLoading(l => ({ ...l, checkAll: false }));
  };

  const handleDeleteProxy = async (id) => {
    await api('DELETE', `/proxies/${id}`);
    loadProxies(); loadProxyMap();
  };

  const handleToggleProxy = async (id) => {
    await api('POST', `/proxies/${id}/toggle`);
    loadProxies();
  };

  const handleAutoDistribute = async () => {
    setLoading(l => ({ ...l, autoDistribute: true }));
    try {
      const data = await api('POST', '/proxy-map/auto', { pages_per_proxy: pagesPerProxy });
      if (data.error) throw new Error(data.error);
      showAlert('success', `✅ ${data.message}`);
      loadProxyMap();
    } catch (e) { showAlert('error', e.message); }
    setLoading(l => ({ ...l, autoDistribute: false }));
  };

  const handleSaveProxyMap = async () => {
    setLoading(l => ({ ...l, saveMap: true }));
    try {
      const data = await api('POST', '/proxy-map', { map: proxyMap });
      if (data.error) throw new Error(data.error);
      showAlert('success', `✅ ${data.message}`);
    } catch (e) { showAlert('error', e.message); }
    setLoading(l => ({ ...l, saveMap: false }));
  };

  const assignPageToProxy = (proxyId, pageId) => {
    setProxyMap(prev => {
      const updated = { ...prev };
      // Remove from any existing proxy
      for (const pid of Object.keys(updated)) {
        updated[pid] = (updated[pid] || []).filter(id => id !== pageId);
      }
      // Add to new proxy
      if (!updated[proxyId]) updated[proxyId] = [];
      updated[proxyId].push(pageId);
      return updated;
    });
  };

  const unassignPage = (pageId) => {
    setProxyMap(prev => {
      const updated = { ...prev };
      for (const pid of Object.keys(updated)) {
        updated[pid] = (updated[pid] || []).filter(id => id !== pageId);
      }
      return updated;
    });
  };

  const getAssignedPageIds = () => {
    const all = new Set();
    for (const ids of Object.values(proxyMap)) (ids || []).forEach(id => all.add(id));
    return all;
  };

  const getUnassignedPages = () => {
    const assigned = getAssignedPageIds();
    return pages.filter(p => !assigned.has(p.id));
  };

  // ═══════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════

  const isEngineActive = engineStatus?.isRunning || ['posting', 'waiting', 'scheduled', 'resting'].includes(engineStatus?.status);
  const getProgressPercent = () => { if (!engineStatus?.session) return 0; const { total_pages, completed_pages } = engineStatus.session; return total_pages ? Math.round((completed_pages / total_pages) * 100) : 0; };
  const formatTime = (ts) => ts ? new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
  const formatDate = (ts) => ts ? new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
  const roundsLabel = (val) => val === 0 ? '∞' : val;
  const getFlag = (cc) => cc ? String.fromCodePoint(...[...cc.toUpperCase()].map(c => 0x1F1E6 - 65 + c.charCodeAt(0))) : '🌐';

  const formatETA = (ts) => {
    if (!ts) return '';
    const remaining = ts - Date.now();
    if (remaining <= 0) return 'Almost done...';
    const hrs = Math.floor(remaining / 3600000);
    const mins = Math.floor((remaining % 3600000) / 60000);
    if (hrs > 0) return `~${hrs}h ${mins}m remaining`;
    return `~${mins}m remaining`;
  };

  const openFBPage = (pageId, e) => {
    if (e) e.stopPropagation();
    window.open(`https://facebook.com/${pageId}`, '_blank');
  };
  const getSuccessRate = () => { const t = analytics?.totals?.total || 0; const s = analytics?.totals?.success || 0; return t === 0 ? '0' : Math.round((s / t) * 100); };

  const getPageGroups = () => {
    const tokenMap = {};
    for (const t of tokens) tokenMap[t.access_token] = t;
    const grouped = {};
    for (const page of pages) { const key = page.user_token || '_unknown'; if (!grouped[key]) grouped[key] = []; grouped[key].push(page); }
    return Object.entries(grouped).map(([tokenStr, groupPages]) => ({
      tokenStr, name: tokenMap[tokenStr]?.name || 'Account', pageCount: groupPages.length, pages: groupPages
    }));
  };

  // Page search filter
  const searchTerm = pageSearch.trim().toLowerCase();
  const pageMatchesSearch = (page) => {
    if (!searchTerm) return true;
    const terms = searchTerm.split(/\s+/);
    const haystack = `${page.name} ${page.category} ${page.id}`.toLowerCase();
    return terms.every(term => haystack.includes(term));
  };
  const filteredPageCount = searchTerm ? pages.filter(pageMatchesSearch).length : 0;

  const selectFiltered = () => {
    const matchingIds = pages.filter(pageMatchesSearch).map(p => p.id);
    setSelectedPages(prev => { const s = new Set(prev); matchingIds.forEach(id => s.add(id)); return [...s]; });
  };
  const deselectFiltered = () => {
    const matchingIds = new Set(pages.filter(pageMatchesSearch).map(p => p.id));
    setSelectedPages(prev => prev.filter(id => !matchingIds.has(id)));
  };

  // ═══════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════

  const pageGroups = getPageGroups();

  return (
    <div className="app-container">
      {/* HEADER */}
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon">📁</div>
          <div className="logo-text">
            <h1>Folder2Page</h1>
            <p>Auto Content Engine</p>
          </div>
        </div>
        <div className="header-right">
          {/* SERVER INFO */}
          {serverInfo && (
            <div className="server-info-badge" style={{ display: 'flex', alignItems: 'center', gap: '8px', background: 'var(--surface-light)', padding: '6px 12px', borderRadius: '20px', border: '1px solid var(--border)', fontSize: '12px', fontWeight: '500', color: 'var(--text-muted)' }}>
              <span title={serverInfo.country}>{getFlag(serverInfo.countryCode)}</span>
              <span>{serverInfo.ip}</span>
              <span style={{opacity: 0.5}}>|</span>
              <span style={{fontFamily: 'monospace'}}>{serverInfo.time}</span>
            </div>
          )}
          {/* THEME SWITCHER */}
          <div className="theme-switcher">
            {Object.values(THEMES).map(t => (
              <button key={t.key} className={`theme-btn ${theme === t.key ? 'active' : ''}`} onClick={() => setTheme(t.key)} title={t.label}>
                {t.label.split(' ')[0]}
              </button>
            ))}
          </div>
          <div className={`status-badge ${engineStatus?.status || 'idle'}`}>
            <span className={`status-dot ${isEngineActive ? 'active' : ''}`}></span>
            {engineStatus?.status === 'resting' ? 'RESTING' : (engineStatus?.status?.toUpperCase() || 'IDLE')}
            {isEngineActive && engineStatus?.currentRound > 0 && (
              <span className="round-badge">R{engineStatus.currentRound}/{roundsLabel(engineStatus.totalRounds)}</span>
            )}
          </div>
        </div>
      </header>

      {/* TAB NAV */}
      <nav className="tab-nav">
        {[{ id: 'dashboard', label: '🏠 Dashboard' }, { id: 'proxy', label: '🛡️ Proxy' }, { id: 'analytics', label: '📊 Analytics' }, { id: 'settings', label: '⚙️ Settings' }].map(tab => (
          <button key={tab.id} className={`tab-btn ${activeTab === tab.id ? 'active' : ''}`} onClick={() => setActiveTab(tab.id)}>{tab.label}</button>
        ))}
      </nav>

      {alert && <div className={`alert ${alert.type}`}>{alert.msg}</div>}

      {/* ═══ TAB: DASHBOARD ═══ */}
      {activeTab === 'dashboard' && (
        <div className="tab-content">
          {/* LIVE STATUS */}
          {isEngineActive && engineStatus && (
            <div className="live-status section">
              <div className="section-title"><span className="icon">📡</span> Live Status</div>
              {engineStatus.status === 'resting' ? (
                <div className="rest-panel">
                  <div className="rest-icon">😴</div>
                  <div className="rest-label">Resting between rounds...</div>
                  <div className="rest-info">Round {engineStatus.currentRound}/{roundsLabel(engineStatus.totalRounds)} completed</div>
                  {restCountdown && <div className="countdown-timer rest">{restCountdown}</div>}
                  <div className="rest-sublabel">Next round starts automatically</div>
                </div>
              ) : (
                <>
                  <div className="status-row"><span className="status-label">Status</span><span className="status-value">{engineStatus.status?.toUpperCase()}</span></div>
                  {(engineStatus.totalRounds > 1 || engineStatus.totalRounds === 0) && (
                    <div className="status-row"><span className="status-label">Round</span><span className="status-value round-indicator">🔄 {engineStatus.currentRound} / {roundsLabel(engineStatus.totalRounds)}</span></div>
                  )}
                  {engineStatus.currentPageName && <div className="status-row"><span className="status-label">Current Page</span><span className="status-value" style={{color:'var(--accent)', cursor:'pointer'}} onClick={() => openFBPage(engineStatus.allPageNames?.find(p => p.name === engineStatus.currentPageName)?.id)}>📄 {engineStatus.currentPageName}</span></div>}
                  {engineStatus.currentFileName && <div className="status-row"><span className="status-label">Current File</span><span className="status-value">🎬 {engineStatus.currentFileName}</span></div>}
                  <div className="status-row"><span className="status-label">Progress</span><span className="status-value">{engineStatus.currentPageIndex || 0} / {engineStatus.totalPages || 0} pages</span></div>
                  <div className="progress-bar-container"><div className="progress-bar" style={{ width: `${getProgressPercent()}%` }}></div></div>

                  {/* ESTIMATED FINISH TIME */}
                  {engineStatus.estimatedFinishTime && (
                    <div className="status-row" style={{marginTop:'6px'}}>
                      <span className="status-label">⏱️ Est. Finish</span>
                      <span className="status-value" style={{color:'var(--accent)', fontWeight:600, fontSize:'13px'}}>{formatETA(engineStatus.estimatedFinishTime)}</span>
                    </div>
                  )}

                  {engineStatus.status === 'waiting' && countdown && <div><div style={{textAlign:'center',fontSize:'12px',color:'var(--text-muted)',marginTop:'8px'}}>Next page in</div><div className="countdown-timer">{countdown}</div></div>}

                  {/* COMPLETED PAGES (Last done) */}
                  {engineStatus.completedPageNames?.length > 0 && (
                    <div className="engine-page-list" style={{marginTop:'12px'}}>
                      <div className="engine-page-list-title">✅ Last Completed</div>
                      <div className="engine-page-chips">
                        {engineStatus.completedPageNames.slice().reverse().map((p, idx) => (
                          <span key={idx} className={`engine-page-chip ${p.status}`} onClick={() => openFBPage(p.id)} title={p.status === 'failed' ? `Failed: ${p.error}` : 'Success'}>
                            {p.status === 'success' ? '✅' : '❌'} {p.name} {p.proxy && <span style={{marginLeft: '6px', fontSize: '11px', opacity: 0.9, background: 'var(--surface)', padding: '2px 6px', borderRadius: '4px', border: '1px solid var(--border)'}}>📍 {p.proxy}</span>}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* UPCOMING PAGES (Next in queue) */}
                  {engineStatus.upcomingPageNames?.length > 0 && (
                    <div className="engine-page-list" style={{marginTop:'8px'}}>
                      <div className="engine-page-list-title">⏭️ Next in Queue</div>
                      <div className="engine-page-chips">
                        {engineStatus.upcomingPageNames.map((p, idx) => (
                          <span key={idx} className="engine-page-chip upcoming" onClick={() => openFBPage(p.id)}>
                            {idx + 1}. {p.name}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
              <div style={{ marginTop: '16px', textAlign: 'center' }}><button className="btn btn-danger" onClick={handleStop}>🛑 Stop Engine</button></div>
            </div>
          )}

          {/* TOKEN */}
          <div className="section">
            <div className="section-title"><span className="icon">🔑</span> Facebook Token</div>
            <div className="input-group">
              <input type="password" placeholder="Paste your Facebook User Access Token here..." value={token} onChange={e => setToken(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleAuth()} />
              <button className="btn btn-primary" onClick={handleAuth} disabled={loading.auth}>{loading.auth ? <span className="loading-spinner"></span> : '🔗'} Connect</button>
            </div>
            {tokens.length > 0 && (
              <>
                <div className="token-list">
                  {tokens.map(t => (
                    <div key={t.id} className="token-item">
                      <div className="token-info">
                        <span className="token-name">{t.name || 'Unknown Account'}</span>
                        <span className="token-hash">{t.access_token?.substring(0, 16)}...</span>
                        <span className="page-count">{t.pageCount} pages</span>
                      </div>
                      <button className="btn btn-outline btn-sm" onClick={() => handleDeleteToken(t.id)}>🗑️</button>
                    </div>
                  ))}
                </div>
                <button className="btn btn-outline" onClick={handleRefreshTokens} disabled={loading.refreshTokens} style={{marginTop:'10px', width:'100%'}}>
                  {loading.refreshTokens ? <span className="loading-spinner"></span> : '🔄'} Refresh All Page Tokens
                </button>
                <p className="section-desc" style={{marginTop:'6px', fontSize:'11px', color:'var(--text-muted)'}}>If you republished deactivated pages, click this to update their tokens.</p>
              </>
            )}
          </div>

          {/* CONTENT FOLDER */}
          <div className="section">
            <div className="section-title"><span className="icon">📁</span> Content Folder</div>
            <p className="section-desc">Select a folder with your media files. All selected pages will post from this shared pool.</p>
            <div className="folder-display" style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <span style={{fontSize:'20px'}}>📂</span>
              <input 
                type="text" 
                style={{ flex: 1, padding: '10px 14px', border: '2px solid var(--border)', borderRadius: '8px', background: 'var(--surface)', color: 'var(--text)', fontSize: '14px', fontFamily: 'monospace' }}
                placeholder="Type folder path here (e.g., /root/videos)"
                value={contentFolder || ''}
                onChange={e => setContentFolder(e.target.value)}
                onBlur={() => contentFolder && handleScanFolder(contentFolder)}
              />
              <button className="btn btn-primary btn-sm" onClick={() => handleScanFolder(contentFolder)} disabled={!contentFolder}>🔍 Scan</button>
            </div>
            {folderStats && (
              <div className="folder-stats">
                <div className="folder-stat-item"><span className="folder-stat-icon">📄</span><span className="folder-stat-value">{folderStats.total_files}</span><span className="folder-stat-label">Total</span></div>
                <div className="folder-stat-item"><span className="folder-stat-icon">🎬</span><span className="folder-stat-value">{folderStats.video_count}</span><span className="folder-stat-label">Videos</span></div>
                <div className="folder-stat-item"><span className="folder-stat-icon">🖼️</span><span className="folder-stat-value">{folderStats.image_count}</span><span className="folder-stat-label">Images</span></div>
                <button className="btn btn-outline btn-sm" onClick={() => handleScanFolder(contentFolder)} style={{marginLeft:'auto'}}>🔄 Refresh</button>
              </div>
            )}
          </div>

          {/* PAGE SELECTION */}
          {pages.length > 0 && (
            <div className="section">
              <div className="page-selection-header">
                <div className="section-title" style={{marginBottom:0}}><span className="icon">📋</span> Select Pages ({selectedPages.length}/{pages.length})</div>
                <div className="select-actions">
                  <button className="btn btn-outline btn-sm" onClick={selectAllPages}>✅ Select All</button>
                  <button className="btn btn-outline btn-sm" onClick={deselectAll}>❌ Deselect</button>
                </div>
              </div>

              {/* SEARCH BAR */}
              <div className="page-search-bar">
                <span className="page-search-icon">🔍</span>
                <input
                  type="text"
                  className="page-search-input"
                  placeholder="Search pages... (type name, category, or ID)"
                  value={pageSearch}
                  onChange={e => setPageSearch(e.target.value)}
                />
                {pageSearch && (
                  <button className="page-search-clear" onClick={() => setPageSearch('')}>✕</button>
                )}
              </div>

              {/* Search results info */}
              {searchTerm && (
                <div className="search-results-bar">
                  <span className="search-results-count">
                    {filteredPageCount === 0 ? '❌ No pages found' : `✨ ${filteredPageCount} page${filteredPageCount !== 1 ? 's' : ''} found`}
                  </span>
                  {filteredPageCount > 0 && (
                    <div className="search-results-actions">
                      <button className="btn btn-primary btn-sm" onClick={selectFiltered}>✅ Select Matched ({filteredPageCount})</button>
                      <button className="btn btn-outline btn-sm" onClick={deselectFiltered}>❌ Deselect Matched</button>
                    </div>
                  )}
                </div>
              )}

              {pageGroups.map((group, gIdx) => {
                const visiblePages = searchTerm ? group.pages.filter(pageMatchesSearch) : group.pages;
                if (searchTerm && visiblePages.length === 0) return null;
                const groupSelectedCount = group.pages.filter(p => selectedPages.includes(p.id)).length;
                const allGroupSelected = groupSelectedCount === group.pages.length;
                return (
                  <div key={gIdx} className="page-group">
                    <div className="page-group-header">
                      <div className="page-group-info">
                        <span className="page-group-icon">🔑</span>
                        <span className="page-group-name">{group.name}</span>
                        <span className="page-group-count">{searchTerm ? `${visiblePages.length}/${group.pageCount}` : group.pageCount} Pages</span>
                      </div>
                      <div className="page-group-actions">
                        {!allGroupSelected
                          ? <button className="btn btn-outline btn-sm" onClick={() => selectGroup(group.tokenStr)}>✅ Select Group</button>
                          : <button className="btn btn-outline btn-sm" onClick={() => deselectGroup(group.tokenStr)}>❌ Deselect Group</button>
                        }
                      </div>
                    </div>
                    <div className="page-grid">
                      {visiblePages.map(page => {
                        const isSelected = selectedPages.includes(page.id);
                        return (
                          <div key={page.id} className={`page-card ${isSelected ? 'selected' : ''}`} onClick={() => togglePage(page.id)}>
                            <div className="page-card-top">
                              <div className="checkbox">{isSelected && <span>✓</span>}</div>
                              <div className="page-name">{page.name}</div>
                              <button className="btn btn-outline btn-sm page-delete-btn" onClick={(e) => handleDeletePage(e, page.id)}>✕</button>
                            </div>
                            <div className="page-card-bottom"><span className="page-category">{page.category}</span></div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* SCHEDULE & START */}
          {pages.length > 0 && (
            <div className="section">
              <div className="section-title"><span className="icon">⏰</span> Schedule & Start</div>
              <div className="schedule-options">
                <div className={`schedule-option ${scheduleMode === 'manual' ? 'active' : ''}`} onClick={() => setScheduleMode('manual')}>
                  <div className="option-icon">▶️</div><div className="option-label">Start Now</div><div className="option-desc">Begin posting immediately</div>
                </div>
                <div className={`schedule-option ${scheduleMode === 'scheduled' ? 'active' : ''}`} onClick={() => setScheduleMode('scheduled')}>
                  <div className="option-icon">🕐</div><div className="option-label">Schedule</div><div className="option-desc">Set a time for auto-start</div>
                </div>
              </div>
              {scheduleMode === 'scheduled' && <div className="input-group" style={{marginBottom:'16px'}}><input type="datetime-local" value={scheduleTime} onChange={e => setScheduleTime(e.target.value)} style={{maxWidth:'300px'}} /></div>}

              <div className="config-row">
                <div className="config-label"><span className="config-icon">🔄</span><div><div className="config-title">Rounds</div><div className="config-desc">How many complete passes through all pages</div></div></div>
                <div className="preset-buttons">{[1,2,3,5,10,0].map(val => <button key={val} className={`btn btn-sm preset-btn ${rounds === val ? 'btn-primary' : 'btn-outline'}`} onClick={() => setRounds(val)}>{val === 0 ? '∞' : val}</button>)}</div>
              </div>

              <div className="config-row" style={{flexDirection:'column',alignItems:'stretch'}}>
                <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:'16px',flexWrap:'wrap'}}>
                  <div className="config-label"><span className="config-icon">😴</span><div><div className="config-title">Rest Between Rounds</div><div className="config-desc">Pause duration between each round</div></div></div>
                  <div className="preset-buttons">
                    {[{label:'None',val:0},{label:'15m',val:15},{label:'30m',val:30},{label:'1h',val:60},{label:'2h',val:120},{label:'4h',val:240}].map(({label,val}) => (
                      <button key={val} className={`btn btn-sm preset-btn ${restMinutes === val ? 'btn-primary' : 'btn-outline'}`} onClick={() => setRestMinutes(val)}>{label}</button>
                    ))}
                  </div>
                </div>
                <div className="custom-rest-row">
                  <span className="custom-rest-label">⏱️ Custom:</span>
                  <div className="custom-rest-inputs">
                    <div className="time-spinner">
                      <button className="spinner-btn" onClick={() => setRestMinutes(p => p + 60)}>▲</button>
                      <div className="spinner-value">{Math.floor(restMinutes / 60)}</div><div className="spinner-unit">hr</div>
                      <button className="spinner-btn" onClick={() => setRestMinutes(p => Math.max(0, p - 60))}>▼</button>
                    </div>
                    <span className="time-separator">:</span>
                    <div className="time-spinner">
                      <button className="spinner-btn" onClick={() => setRestMinutes(p => p + 5)}>▲</button>
                      <div className="spinner-value">{restMinutes % 60}</div><div className="spinner-unit">min</div>
                      <button className="spinner-btn" onClick={() => setRestMinutes(p => Math.max(0, p - 5))}>▼</button>
                    </div>
                  </div>
                  <span className="custom-rest-total">= {restMinutes === 0 ? 'No rest' : `${Math.floor(restMinutes/60) > 0 ? `${Math.floor(restMinutes/60)}h ` : ''}${restMinutes%60 > 0 ? `${restMinutes%60}m` : ''}`}</span>
                </div>
              </div>

              <div className="config-summary" style={{ display: 'flex', flexDirection: 'column', gap: '8px', background: 'var(--surface-light)', padding: '16px', borderRadius: '8px', border: '1px solid var(--border)', fontSize: '13px' }}>
                <div style={{ fontWeight: '600', color: 'var(--text)', marginBottom: '4px' }}>⏱️ Time Calculator</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px' }}>
                  <div className="calc-stat">
                    <div style={{ color: 'var(--text-muted)' }}>1 Round Takes</div>
                    <div style={{ fontWeight: '600', color: 'var(--primary)' }}>~{selectedPages.length * gapMinutes} minutes</div>
                  </div>
                  <div className="calc-stat">
                    <div style={{ color: 'var(--text-muted)' }}>Round + Rest</div>
                    <div style={{ fontWeight: '600', color: 'var(--primary)' }}>~{Math.floor(((selectedPages.length * gapMinutes) + restMinutes)/60)}h {((selectedPages.length * gapMinutes) + restMinutes)%60}m</div>
                  </div>
                  <div className="calc-stat">
                    <div style={{ color: 'var(--text-muted)' }}>In 24 Hours</div>
                    <div style={{ fontWeight: '600', color: 'var(--success)' }}>~{((selectedPages.length * gapMinutes) + restMinutes) > 0 ? (1440 / ((selectedPages.length * gapMinutes) + restMinutes)).toFixed(1) : 0} rounds</div>
                  </div>
                </div>
              </div>
              <div className="action-bar">
                <button className="btn btn-success btn-lg" onClick={handleStart} disabled={loading.start || isEngineActive || !selectedPages.length || !contentFolder}>
                  {loading.start ? <span className="loading-spinner"></span> : '🚀'}
                  {scheduleMode === 'manual' ? 'Start Posting Now' : 'Schedule & Start'}
                  {rounds !== 1 && <span className="btn-badge">{rounds === 0 ? '∞' : `×${rounds}`}</span>}
                </button>
                {isEngineActive && <button className="btn btn-danger btn-lg" onClick={handleStop}>🛑 Stop</button>}
              </div>
            </div>
          )}

          {/* POSTING HISTORY */}
          <div className="section">
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:'14px'}}>
              <div className="section-title" style={{marginBottom:0}}><span className="icon">📜</span> Posting History</div>
              {logs.length > 0 && <button className="btn btn-outline btn-sm" onClick={handleClearLogs}>🗑️ Clear</button>}
            </div>
            {logs.length === 0 ? (
              <div className="empty-state"><div className="empty-icon">📭</div><div className="empty-text">No posting history yet.</div></div>
            ) : (
              <div className="log-list">
                {logs.map((log, idx) => (
                  <div key={log.id || idx} className={`log-item ${log.status === 'failed' ? 'log-failed' : ''}`}>
                    <span className="log-status">{log.status === 'success' ? '✅' : log.status === 'failed' ? '❌' : '⏭️'}</span>
                    <span className="log-page log-page-link" onClick={() => openFBPage(log.page_id)} title={`Open ${log.page_name} on Facebook`}>{log.page_name}</span>
                    <span className="log-file">{log.content_name || '—'}</span>
                    {log.proxy_info && (
                      <span className="log-proxy" title={`IP/Proxy used: ${log.proxy_info}`}>🛡️ {log.proxy_info}</span>
                    )}
                    {log.status === 'failed' && log.error_msg && (
                      <span className="log-error" title={log.error_msg}>⚠️ {log.error_msg.length > 40 ? log.error_msg.substring(0, 40) + '...' : log.error_msg}</span>
                    )}
                    <span className="log-time">{formatTime(log.created_at)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ═══ TAB: PROXY ═══ */}
      {activeTab === 'proxy' && (
        <div className="tab-content">
          {!settingsUseProxies && (
            <div className="alert" style={{backgroundColor: 'var(--danger)', color: 'white', marginBottom: '16px'}}>
              ⚠️ <strong>Proxies are globally DISABLED!</strong> All posts will be made directly without any proxy. Turn them back on in the Settings tab.
            </div>
          )}
          {/* ADD PROXIES */}
          <div className="section">
            <div className="section-title"><span className="icon">🛡️</span> Add Proxies</div>
            <p className="section-desc">Paste your proxy list below. Supports: <code>ip:port:user:pass</code> • <code>user:pass@ip:port</code> • <code>http://user:pass@ip:port</code> • <code>socks5://user:pass@ip:port</code></p>
            <textarea
              className="proxy-textarea"
              placeholder={'Paste proxies here, one per line...\n\nExamples:\n192.168.1.1:8080:myuser:mypass\nhttp://user:pass@1.2.3.4:3128\nsocks5://user:pass@5.6.7.8:1080'}
              value={proxyInput}
              onChange={e => setProxyInput(e.target.value)}
              rows={5}
            />
            <div className="proxy-actions-row">
              <button className="btn btn-primary" onClick={handleAddProxies} disabled={loading.addProxy}>
                {loading.addProxy ? <span className="loading-spinner"></span> : '➕'} Add Proxies
              </button>
              <button className="btn btn-outline" onClick={handleCheckAllProxies} disabled={loading.checkAll || !proxies.length}>
                {loading.checkAll ? <span className="loading-spinner"></span> : '🔍'} Check All
              </button>
            </div>
          </div>

          {/* PROXY LIST */}
          <div className="section">
            <div className="section-title"><span className="icon">📡</span> Proxy List ({proxies.length})</div>
            {proxies.length === 0 ? (
              <div className="empty-state"><div className="empty-icon">🛡️</div><div className="empty-text">No proxies added yet. Paste your proxy list above.</div></div>
            ) : (
              <div className="proxy-grid">
                {proxies.map(px => (
                  <div key={px.id} className={`proxy-card ${px.enabled ? '' : 'disabled'} ${px.status}`}>
                    <div className="proxy-card-header">
                      <span className={`proxy-status-dot ${px.status}`}></span>
                      <span className="proxy-host">{px.host}:{px.port}</span>
                      <span className={`proxy-status-badge ${px.status}`}>{px.status.toUpperCase()}</span>
                    </div>
                    {(px.country || px.city) && (
                      <div className="proxy-location">
                        <span className="proxy-flag">{getFlag(px.country_code)}</span>
                        <span className="proxy-country">{px.country}{px.city ? `, ${px.city}` : ''}</span>
                      </div>
                    )}
                    <div className="proxy-card-details">
                      {px.external_ip && <div className="proxy-detail"><span className="proxy-detail-label">IP:</span> {px.external_ip}</div>}
                      {px.speed_ms > 0 && <div className="proxy-detail"><span className="proxy-detail-label">Speed:</span> <span className={`proxy-speed ${px.speed_ms > 5000 ? 'slow' : px.speed_ms > 2000 ? 'medium' : 'fast'}`}>{px.speed_ms}ms</span></div>}
                      <div className="proxy-detail"><span className="proxy-detail-label">Pages:</span> {px.assigned_pages || 0}</div>
                      {px.username && <div className="proxy-detail"><span className="proxy-detail-label">Auth:</span> ✅</div>}
                      {px.protocol !== 'http' && <div className="proxy-detail"><span className="proxy-detail-label">Type:</span> {px.protocol.toUpperCase()}</div>}
                    </div>
                    <div className="proxy-card-actions">
                      <button className="btn btn-outline btn-sm" onClick={() => handleCheckProxy(px.id)} disabled={loading[`checkProxy_${px.id}`]}>
                        {loading[`checkProxy_${px.id}`] ? <span className="loading-spinner"></span> : '🔍'} Check
                      </button>
                      <button className="btn btn-outline btn-sm" onClick={() => handleToggleProxy(px.id)}>
                        {px.enabled ? '⏸️ Disable' : '▶️ Enable'}
                      </button>
                      <button className="btn btn-outline btn-sm btn-danger-text" onClick={() => handleDeleteProxy(px.id)}>🗑️</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* PAGE ASSIGNMENT */}
          {proxies.length > 0 && pages.length > 0 && (
            <div className="section">
              <div className="section-title"><span className="icon">🔗</span> Proxy ↔ Page Assignment</div>
              <p className="section-desc">Assign pages to proxies. Each page's Facebook API call will route through its assigned proxy.</p>

              {/* MODE SWITCHER */}
              <div className="assign-mode-switch">
                <button className={`assign-mode-btn ${assignMode === 'auto' ? 'active' : ''}`} onClick={() => setAssignMode('auto')}>
                  🤖 Auto Distribute
                </button>
                <button className={`assign-mode-btn ${assignMode === 'manual' ? 'active' : ''}`} onClick={() => setAssignMode('manual')}>
                  ✋ Manual Assign
                </button>
              </div>

              {/* AUTO MODE */}
              {assignMode === 'auto' && (
                <div className="auto-distribute-panel">
                  <div className="auto-distribute-row">
                    <span className="auto-label">Pages per proxy:</span>
                    <div className="auto-spinner">
                      <button className="spinner-btn" onClick={() => setPagesPerProxy(p => Math.max(1, p - 1))}>−</button>
                      <div className="spinner-value">{pagesPerProxy}</div>
                      <button className="spinner-btn" onClick={() => setPagesPerProxy(p => p + 1)}>+</button>
                    </div>
                    <div className="gap-presets" style={{flex:1}}>
                      {[5,10,15,20,25].map(v => (
                        <button key={v} className={`btn btn-sm ${pagesPerProxy === v ? 'btn-primary' : 'btn-outline'}`} onClick={() => setPagesPerProxy(v)}>{v}</button>
                      ))}
                    </div>
                  </div>
                  <div className="auto-distribute-info">
                    📊 {proxies.filter(p=>p.enabled).length} active proxies × {pagesPerProxy} pages = {proxies.filter(p=>p.enabled).length * pagesPerProxy} pages covered (you have {pages.length} total pages)
                  </div>
                  <button className="btn btn-success" onClick={handleAutoDistribute} disabled={loading.autoDistribute} style={{width:'100%'}}>
                    {loading.autoDistribute ? <span className="loading-spinner"></span> : '🔄'} Auto Distribute {pages.length} Pages
                  </button>
                </div>
              )}

              {/* MANUAL MODE */}
              {assignMode === 'manual' && (
                <div className="manual-assign-panel">
                  <p className="section-desc" style={{marginBottom:'8px'}}>Click a proxy to select it, then click unassigned pages to add. Click assigned pages to remove.</p>

                  {/* PROXY ASSIGNMENT CARDS */}
                  {proxies.filter(p => p.enabled).map(px => {
                    const assignedIds = proxyMap[px.id] || [];
                    const assignedPages = assignedIds.map(id => pages.find(p => p.id === id)).filter(Boolean);
                    const isActive = activeProxyId === px.id;
                    return (
                      <div key={px.id} className={`proxy-assign-card ${isActive ? 'active' : ''}`} onClick={() => setActiveProxyId(isActive ? null : px.id)}>
                        <div className="proxy-assign-header">
                          <span className={`proxy-status-dot ${px.status}`}></span>
                          <span className="proxy-assign-name">{px.host}:{px.port}</span>
                          <span className="proxy-assign-count">{assignedPages.length} pages</span>
                          {isActive && <span className="proxy-assign-active-label">✏️ EDITING</span>}
                          {!isActive && <button className="btn btn-outline btn-sm" style={{marginLeft: 'auto'}} onClick={(e) => { e.stopPropagation(); setActiveProxyId(px.id); }}>➕ Select Pages</button>}
                        </div>
                        {assignedPages.length > 0 && (
                          <div className="proxy-assign-pages">
                            {assignedPages.map(pg => (
                              <span key={pg.id} className="proxy-page-chip assigned" onClick={(e) => { e.stopPropagation(); unassignPage(pg.id); }}>
                                {pg.name} ✕
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {/* UNASSIGNED PAGES */}
                  <div className="unassigned-section">
                    <div className="unassigned-header">
                      📋 Unassigned Pages ({getUnassignedPages().length})
                      {!activeProxyId && <span className="unassigned-hint">👆 Select a proxy above first</span>}
                      {activeProxyId && <span className="unassigned-hint" style={{color: 'var(--success)'}}>👇 Click pages below to add them to proxy</span>}
                    </div>
                    <div className="unassigned-pages-grid">
                      {getUnassignedPages().map(pg => (
                        <span
                          key={pg.id}
                          className={`proxy-page-chip unassigned ${activeProxyId ? 'clickable' : ''}`}
                          onClick={() => activeProxyId && assignPageToProxy(activeProxyId, pg.id)}
                        >
                          {pg.name}
                        </span>
                      ))}
                      {getUnassignedPages().length === 0 && <span className="all-assigned-label">✅ All pages assigned!</span>}
                    </div>
                  </div>

                  <button className="btn btn-success" onClick={handleSaveProxyMap} disabled={loading.saveMap} style={{width:'100%', marginTop:'16px'}}>
                    {loading.saveMap ? <span className="loading-spinner"></span> : '💾'} Save Assignment
                  </button>
                </div>
              )}

              {/* ASSIGNMENT SUMMARY */}
              {Object.keys(proxyMap).length > 0 && (
                <div className="assign-summary">
                  <div className="assign-summary-title">📊 Current Assignment Summary</div>
                  <div className="assign-summary-grid">
                    {proxies.filter(p => p.enabled).map(px => {
                      const count = (proxyMap[px.id] || []).length;
                      return (
                        <div key={px.id} className="assign-summary-item">
                          <span className={`proxy-status-dot ${px.status}`}></span>
                          <span className="assign-summary-flag">{getFlag(px.country_code)}</span>
                          <span className="assign-summary-host">{px.host}:{px.port}</span>
                          <span className="assign-summary-count">{count} pages</span>
                          <div className="assign-summary-bar"><div className="assign-summary-fill" style={{width: `${Math.min(100, (count / Math.max(1, pages.length)) * 100)}%`}}></div></div>
                        </div>
                      );
                    })}
                    <div className="assign-summary-item unassigned-row">
                      <span className="proxy-status-dot unchecked"></span>
                      <span className="assign-summary-host">Unassigned (direct)</span>
                      <span className="assign-summary-count">{getUnassignedPages().length} pages</span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ═══ TAB: ANALYTICS ═══ */}
      {activeTab === 'analytics' && (
        <div className="tab-content">
          <div className="stats-grid">
            <div className="stat-card accent"><div className="stat-number">{analytics?.totals?.total || 0}</div><div className="stat-label">Total Posts</div></div>
            <div className="stat-card success"><div className="stat-number">{analytics?.totals?.success || 0}</div><div className="stat-label">Successful</div></div>
            <div className="stat-card info"><div className="stat-number">{analytics?.todayStats?.total || 0}</div><div className="stat-label">Today</div></div>
            <div className="stat-card rate"><div className="stat-number">{getSuccessRate()}%</div><div className="stat-label">Success Rate</div></div>
          </div>

          <div className="section">
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:'14px'}}>
              <div className="section-title" style={{marginBottom:0}}><span className="icon">📊</span> Per-Page Stats</div>
              <button className="btn btn-outline btn-sm" onClick={loadAnalytics}>🔄 Refresh</button>
            </div>
            {(!analytics?.perPage || analytics.perPage.length === 0) ? (
              <div className="empty-state"><div className="empty-icon">📊</div><div className="empty-text">No analytics data yet.</div></div>
            ) : (
              <div className="analytics-table-wrap">
                <table className="analytics-table">
                  <thead><tr><th>Page Name</th><th>Total</th><th>Success</th><th>Failed</th><th>Last Post</th><th>Last Failed</th></tr></thead>
                  <tbody>{analytics.perPage.map((row, idx) => (
                    <tr key={idx} className={row.failed_count > 0 ? 'row-has-failed' : ''}>
                      <td className="page-name-cell">
                        <span className="page-dot"></span>
                        <span className="page-name-link" onClick={() => openFBPage(row.page_id)} title={`Open ${row.page_name} on Facebook`}>{row.page_name}</span>
                      </td>
                      <td><span className="table-badge total">{row.total_posts}</span></td>
                      <td><span className="table-badge success">{row.success_count}</span></td>
                      <td><span className={`table-badge ${row.failed_count > 0 ? 'failed' : 'success'}`}>{row.failed_count || 0}</span></td>
                      <td className="time-cell">{formatDate(row.last_post_at)}</td>
                      <td className="time-cell failed-time">{row.last_failed_at ? formatDate(row.last_failed_at) : '—'}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          </div>

          <div className="section">
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:'14px'}}>
              <div className="section-title" style={{marginBottom:0}}><span className="icon">📋</span> Session History</div>
              {analytics?.sessions?.length > 0 && (
                <button className="btn btn-danger btn-sm" onClick={handleClearSessions} disabled={loading.clearSessions}>
                  {loading.clearSessions ? <span className="loading-spinner"></span> : '🗑️'} Clear All
                </button>
              )}
            </div>
            {(!analytics?.sessions || analytics.sessions.length === 0) ? (
              <div className="empty-state"><div className="empty-icon">📋</div><div className="empty-text">No sessions yet.</div></div>
            ) : (
              <div className="log-list" style={{maxHeight:'400px'}}>
                {analytics.sessions.map((s, idx) => (
                  <div key={idx} className="log-item session-item">
                    <span className="log-status">{s.status === 'completed' ? '✅' : s.status === 'running' ? '🔄' : s.status === 'paused' ? '⏸️' : '⏳'}</span>
                    <div style={{flex:1}}><div style={{fontWeight:600,fontSize:'13px'}}>Session #{s.id}</div><div style={{fontSize:'11px',color:'var(--text-muted)'}}>{s.completed_pages}/{s.total_pages} pages • {s.mode}</div></div>
                    <div style={{textAlign:'right'}}><div className={`session-status ${s.status}`}>{s.status}</div><div style={{fontSize:'11px',color:'var(--text-muted)'}}>{formatDate(s.created_at)}</div></div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ═══ TAB: SETTINGS ═══ */}
      {activeTab === 'settings' && (
        <div className="tab-content">
          {/* Theme Selection */}
          <div className="section">
            <div className="section-title"><span className="icon">🎨</span> Theme</div>
            <div className="theme-options">
              {Object.values(THEMES).map(t => (
                <div key={t.key} className={`theme-option ${theme === t.key ? 'active' : ''}`} onClick={() => setTheme(t.key)}>
                  <div className={`theme-preview ${t.key}`}></div>
                  <div className="theme-option-label">{t.label}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="section">
            <div className="section-title"><span className="icon">⏱️</span> Posting Gap (Minutes)</div>
            <p className="section-desc">Wait time between each page's content post.</p>
            <div className="gap-control">
              <button className="btn btn-outline gap-btn" onClick={() => setGapMinutesState(Math.max(1, gapMinutes - 1))} disabled={gapMinutes <= 1}>−</button>
              <div className="gap-display"><div className="gap-number">{gapMinutes}</div><div className="gap-unit">min</div></div>
              <button className="btn btn-outline gap-btn" onClick={() => setGapMinutesState(Math.min(60, gapMinutes + 1))} disabled={gapMinutes >= 60}>+</button>
            </div>
            <div className="gap-presets">{[1,2,3,5,10,15,20,30].map(val => <button key={val} className={`btn btn-sm ${gapMinutes === val ? 'btn-primary' : 'btn-outline'}`} onClick={() => setGapMinutesState(val)}>{val} min</button>)}</div>
          </div>

          <div className="section">
            <div className="section-title"><span className="icon">🔄</span> Rounds & Rest (Default)</div>
            <div className="config-row">
              <div className="config-label"><span className="config-icon">🔄</span><div><div className="config-title">Default Rounds</div></div></div>
              <div className="preset-buttons">{[1,2,3,5,10,0].map(val => <button key={val} className={`btn btn-sm preset-btn ${settingsRounds === val ? 'btn-primary' : 'btn-outline'}`} onClick={() => setSettingsRounds(val)}>{val === 0 ? '∞' : val}</button>)}</div>
            </div>
            <div className="config-row">
              <div className="config-label"><span className="config-icon">😴</span><div><div className="config-title">Default Rest</div></div></div>
              <div className="preset-buttons">{[{label:'None',val:0},{label:'15m',val:15},{label:'30m',val:30},{label:'1h',val:60},{label:'2h',val:120},{label:'4h',val:240}].map(({label,val}) => <button key={val} className={`btn btn-sm preset-btn ${settingsRestMinutes === val ? 'btn-primary' : 'btn-outline'}`} onClick={() => setSettingsRestMinutes(val)}>{label}</button>)}</div>
            </div>
            <div className="config-row" style={{borderTop: '1px solid var(--border)', paddingTop: '16px'}}>
              <div className="config-label"><span className="config-icon">🛡️</span><div><div className="config-title">Enable Proxies globally</div><div className="config-desc">If ON, posting will route through assigned proxies. If OFF, direct connection will be used.</div></div></div>
              <div className="preset-buttons">
                <button className={`btn btn-sm preset-btn ${settingsUseProxies ? 'btn-primary' : 'btn-outline'}`} onClick={() => setSettingsUseProxies(true)}>On (With Proxy)</button>
                <button className={`btn btn-sm preset-btn ${!settingsUseProxies ? 'btn-primary' : 'btn-outline'}`} onClick={() => setSettingsUseProxies(false)}>Off (Direct/Without Proxy)</button>
              </div>
            </div>
          </div>

          <button className="btn btn-success btn-lg" onClick={handleSaveSettings} disabled={loading.settings} style={{width:'100%',marginBottom:'20px'}}>
            {loading.settings ? <span className="loading-spinner"></span> : '💾'} Save All Settings
          </button>

          <div className="section">
            <div className="section-title"><span className="icon">ℹ️</span> System Info</div>
            <div className="info-grid">
              <div className="info-row"><span className="info-label">Connected Pages</span><span className="info-value">{pages.length}</span></div>
              <div className="info-row"><span className="info-label">Backend Port</span><span className="info-value">5002</span></div>
              <div className="info-row"><span className="info-label">Engine Status</span><span className={`info-value status-text ${engineStatus?.status || 'idle'}`}>{engineStatus?.status?.toUpperCase() || 'IDLE'}</span></div>
            </div>
          </div>

          <div className="section danger-zone">
            <div className="section-title"><span className="icon">⚠️</span> Danger Zone</div>
            <p style={{fontSize:'12px',color:'var(--danger)',marginBottom:'14px'}}>Permanently delete ALL logs, sessions, and progress data!</p>
            <button className="btn btn-danger" onClick={handleResetSystem} disabled={loading.reset}>
              {loading.reset ? <span className="loading-spinner"></span> : '🗑️'} Reset All Data
            </button>
          </div>
        </div>
      )}

      <footer className="app-footer">📁 Folder2Page v3.0 — Auto Content Engine</footer>
    </div>
  );
}

export default App;
