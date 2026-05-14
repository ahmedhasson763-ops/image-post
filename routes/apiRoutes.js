const express = require('express');
const router = express.Router();
const api = require('../controllers/apiController');
const ai = require('../controllers/aiController');

// Auth & Tokens
router.post('/auth', api.authenticate);
router.get('/tokens', api.getTokens);
router.delete('/tokens/:id', api.deleteToken);
router.post('/sync-pages', api.syncPagesAPI);

// Pages
router.get('/pages', api.getPages);
router.delete('/pages/:id', api.deletePage);

// Folder
router.post('/browse-folder', api.browseFolder);
router.post('/scan-folder', api.scanFolder);
router.get('/list-dir', api.listDir);


// Sessions & Engine
router.post('/sessions', api.createSession);
router.get('/sessions', api.getSessions);
router.post('/start', api.startPosting);
router.post('/stop', api.stopPosting);
router.get('/status', api.getStatus);
router.get('/progress', api.getProgress);

// Logs
router.get('/logs', api.getLogs);
router.post('/clear-logs', api.clearLogs);
router.post('/clear-sessions', api.clearSessions);
router.post('/reset', api.resetSystem);

// Analytics
router.get('/analytics', api.getAnalytics);

// Settings & System
router.get('/settings', api.getSettings);
router.post('/settings', api.updateSettings);
router.get('/server-info', api.getServerInfo);

// Token Refresh
router.post('/refresh-tokens', api.refreshTokens);

// Proxy Management
router.post('/proxies/check-all', api.checkAllProxies);
router.post('/proxies', api.addProxies);
router.get('/proxies', api.getProxies);
router.delete('/proxies/:id', api.deleteProxy);
router.post('/proxies/:id/toggle', api.toggleProxy);
router.post('/proxies/:id/check', api.checkProxy);

// Proxy-Page Mapping
router.get('/proxy-map', api.getProxyMap);
router.post('/proxy-map/auto', api.autoDistributeProxies);
router.post('/proxy-map', api.saveProxyMap);

// AI Captions
router.get('/ai/settings', ai.getAISettings);
router.post('/ai/settings', ai.updateAISettings);
router.get('/ai/providers', ai.getAIProviders);
router.post('/ai/providers', ai.addAIProvider);
router.put('/ai/providers/:id', ai.updateAIProvider);
router.delete('/ai/providers/:id', ai.deleteAIProvider);
router.post('/ai/providers/:id/toggle', ai.toggleAIProvider);
router.post('/ai/test', ai.testAICaption);
router.get('/ai/sample', ai.pickSampleImage);

module.exports = router;
