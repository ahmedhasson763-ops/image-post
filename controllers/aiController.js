/**
 * AI Captions REST controller.
 *
 * Exposes CRUD over `ai_providers` + `ai_settings` and a single
 * `test caption` endpoint that runs the live fallback chain against
 * a sample image (or filename-only) so the user can verify their
 * keys before enabling AI for real posts.
 */

const fs = require('fs');
const path = require('path');
const { runQuery, getQuery, allQuery } = require('../database/db');
const {
  generateCaption,
  listProvidersCatalog,
  PROVIDERS,
  buildPrompt,
  isImageFile
} = require('../services/aiCaptionService');

const VALID_PROVIDERS = Object.keys(PROVIDERS);

// ════════════════════════════════════════
// SETTINGS
// ════════════════════════════════════════

exports.getAISettings = async (req, res) => {
  try {
    const row = await getQuery(`SELECT * FROM ai_settings WHERE id=1`);
    res.json({
      enabled: row?.enabled ? true : false,
      language: row?.language || 'es-MX',
      niche: row?.niche || '',
      tool_name: row?.tool_name || 'imagestool1',
      use_vision: row?.use_vision === undefined ? true : !!row.use_vision,
      fallback_to_filename: row?.fallback_to_filename === undefined ? true : !!row.fallback_to_filename,
      custom_prompt: row?.custom_prompt || '',
      default_content_folder: row?.default_content_folder || '',
      catalog: listProvidersCatalog()
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load AI settings: ' + err.message });
  }
};

exports.updateAISettings = async (req, res) => {
  try {
    const {
      enabled,
      language,
      niche,
      tool_name,
      use_vision,
      fallback_to_filename,
      custom_prompt,
      default_content_folder
    } = req.body || {};

    const cleanToolName = (tool_name || 'imagestool1').toString().trim().replace(/[^a-zA-Z0-9_-]/g, '');
    await runQuery(
      `UPDATE ai_settings SET
         enabled=?, language=?, niche=?, tool_name=?, use_vision=?,
         fallback_to_filename=?, custom_prompt=?, default_content_folder=?
       WHERE id=1`,
      [
        enabled ? 1 : 0,
        (language || 'es-MX').toString().slice(0, 32),
        (niche || '').toString().slice(0, 500),
        cleanToolName || 'imagestool1',
        use_vision ? 1 : 0,
        fallback_to_filename === false ? 0 : 1,
        (custom_prompt || '').toString().slice(0, 4000),
        (default_content_folder || '').toString().slice(0, 500)
      ]
    );
    const row = await getQuery(`SELECT * FROM ai_settings WHERE id=1`);
    res.json({ success: true, settings: row });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save AI settings: ' + err.message });
  }
};

// ════════════════════════════════════════
// PROVIDERS (CRUD)
// ════════════════════════════════════════

exports.getAIProviders = async (req, res) => {
  try {
    const rows = await allQuery(`SELECT * FROM ai_providers ORDER BY priority ASC, id ASC`);
    // Never echo the full key — only first 6 and last 4 chars
    const masked = rows.map(r => ({
      ...r,
      api_key: r.api_key ? `${r.api_key.slice(0, 6)}…${r.api_key.slice(-4)}` : '',
      has_key: !!r.api_key
    }));
    res.json({ providers: masked, catalog: listProvidersCatalog() });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list AI providers: ' + err.message });
  }
};

exports.addAIProvider = async (req, res) => {
  try {
    const { provider, api_key, model, supports_vision, priority, enabled, label } = req.body || {};
    if (!VALID_PROVIDERS.includes(provider)) {
      return res.status(400).json({ error: `Invalid provider. Must be one of: ${VALID_PROVIDERS.join(', ')}` });
    }
    if (!api_key || !api_key.trim()) return res.status(400).json({ error: 'api_key is required' });
    if (!model || !model.trim()) return res.status(400).json({ error: 'model is required' });

    const result = await runQuery(
      `INSERT INTO ai_providers (provider, api_key, model, supports_vision, priority, enabled, label)
       VALUES (?,?,?,?,?,?,?)`,
      [
        provider,
        api_key.trim(),
        model.trim(),
        supports_vision ? 1 : 0,
        Number.isFinite(parseInt(priority)) ? parseInt(priority) : 100,
        enabled === false ? 0 : 1,
        (label || '').toString().slice(0, 64)
      ]
    );
    res.json({ success: true, id: result.id });
  } catch (err) {
    res.status(500).json({ error: 'Failed to add AI provider: ' + err.message });
  }
};

exports.updateAIProvider = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await getQuery(`SELECT * FROM ai_providers WHERE id=?`, [id]);
    if (!existing) return res.status(404).json({ error: 'Provider not found' });

    const { provider, api_key, model, supports_vision, priority, enabled, label } = req.body || {};
    if (provider !== undefined && !VALID_PROVIDERS.includes(provider)) {
      return res.status(400).json({ error: `Invalid provider` });
    }

    // Empty api_key in the PUT means "don't change" — protects against UI sending the masked value
    const nextApiKey = (api_key === undefined || api_key === '' || /…/.test(api_key))
      ? existing.api_key
      : api_key.trim();

    await runQuery(
      `UPDATE ai_providers SET
         provider=?, api_key=?, model=?, supports_vision=?, priority=?, enabled=?, label=?
       WHERE id=?`,
      [
        provider || existing.provider,
        nextApiKey,
        (model !== undefined ? model : existing.model).toString().trim(),
        supports_vision === undefined ? existing.supports_vision : (supports_vision ? 1 : 0),
        priority === undefined ? existing.priority : (Number.isFinite(parseInt(priority)) ? parseInt(priority) : 100),
        enabled === undefined ? existing.enabled : (enabled ? 1 : 0),
        label === undefined ? existing.label : (label || '').toString().slice(0, 64),
        id
      ]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update AI provider: ' + err.message });
  }
};

exports.deleteAIProvider = async (req, res) => {
  try {
    await runQuery(`DELETE FROM ai_providers WHERE id=?`, [parseInt(req.params.id)]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete AI provider: ' + err.message });
  }
};

exports.toggleAIProvider = async (req, res) => {
  try {
    await runQuery(
      `UPDATE ai_providers SET enabled = CASE WHEN enabled=1 THEN 0 ELSE 1 END WHERE id=?`,
      [parseInt(req.params.id)]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to toggle AI provider: ' + err.message });
  }
};

// ════════════════════════════════════════
// TEST CAPTION
// ════════════════════════════════════════

/**
 * POST /api/ai/test
 * Body: { image_path?: string, filename?: string, provider_id?: number }
 *
 * When image_path is set, the caption is generated against that specific
 * image. When omitted but `filename` is set, we synthesize a fake filename
 * (text-only path). When provider_id is set, we test ONLY that provider
 * (single-shot) instead of the configured fallback chain.
 */
exports.testAICaption = async (req, res) => {
  try {
    const { image_path, filename, provider_id } = req.body || {};

    let imagePath = null;
    if (image_path && image_path.trim()) {
      if (!fs.existsSync(image_path)) {
        return res.status(400).json({ error: `Image not found: ${image_path}` });
      }
      imagePath = image_path;
    }

    const settings = await getQuery(`SELECT * FROM ai_settings WHERE id=1`);
    if (!settings) return res.status(400).json({ error: 'AI settings not initialized' });

    // For the test endpoint we always run, even if `enabled=0`.
    const effectiveSettings = { ...settings, enabled: 1 };

    let providersOverride = null;
    if (provider_id) {
      const row = await getQuery(`SELECT * FROM ai_providers WHERE id=?`, [parseInt(provider_id)]);
      if (!row) return res.status(404).json({ error: 'Provider not found' });
      if (!row.api_key) return res.status(400).json({ error: 'Provider has no API key configured' });
      providersOverride = [row];
    }

    const result = await generateCaption({
      imagePath,
      filename: filename || (imagePath ? path.basename(imagePath) : 'example.jpg'),
      settings: effectiveSettings,
      providersOverride
    });

    res.json({
      success: !!result.caption,
      caption: result.caption,
      used: result.used,
      error: result.error,
      attempts: result.attempts,
      prompt: buildPrompt({
        language: settings.language,
        niche: settings.niche,
        customPrompt: settings.custom_prompt,
        filename: filename || (imagePath ? path.basename(imagePath) : 'example.jpg'),
        hasImage: !!imagePath && isImageFile(imagePath)
      })
    });
  } catch (err) {
    res.status(500).json({ error: 'AI test failed: ' + err.message });
  }
};

// ════════════════════════════════════════
// SAMPLE IMAGE PICKER (helper for the "Test" button)
// ════════════════════════════════════════

/**
 * GET /api/ai/sample?folder=/path/to/content
 * Picks one image from the folder (first alphabetical match) so the user
 * can test the caption pipeline against a real file without uploading.
 */
exports.pickSampleImage = async (req, res) => {
  try {
    const folder = (req.query.folder || '').toString();
    if (!folder || !fs.existsSync(folder)) return res.json({ image: null });
    const exts = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'];
    const entries = fs.readdirSync(folder, { withFileTypes: true });
    const images = entries
      .filter(e => e.isFile() && exts.includes(path.extname(e.name).toLowerCase()))
      .map(e => e.name)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (!images.length) return res.json({ image: null });
    res.json({ image: path.join(folder, images[0]), name: images[0] });
  } catch (err) {
    res.status(500).json({ error: 'Sample lookup failed: ' + err.message });
  }
};
