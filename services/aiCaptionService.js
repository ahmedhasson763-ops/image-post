/**
 * AI Caption Service — Multi-provider with fallback chain
 *
 * Supported providers:
 *   - openrouter  (https://openrouter.ai)
 *   - gemini      (Google AI Studio / Generative Language API)
 *   - groq        (https://console.groq.com)
 *
 * Behavior:
 *   1. Load enabled providers ordered by `priority` (lower = tried first).
 *   2. For each, attempt one request. On failure (network / rate-limit / etc.),
 *      log the error to the provider row and try the next one.
 *   3. Return the first successful caption + which provider/model produced it.
 *   4. If all providers fail, return { caption: null, error: '...' }.
 *
 * Each provider talks the OpenAI-compatible chat-completions schema except
 * Gemini, which uses Google's native generateContent endpoint.
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { runQuery, getQuery, allQuery } = require('../database/db');

// ════════════════════════════════════════
// PROVIDER DEFINITIONS
// ════════════════════════════════════════

function readImageAsDataURL(imagePath) {
  if (!imagePath || !fs.existsSync(imagePath)) return null;
  const buf = fs.readFileSync(imagePath);
  const extRaw = path.extname(imagePath).slice(1).toLowerCase() || 'jpeg';
  const ext = extRaw === 'jpg' ? 'jpeg' : extRaw;
  const mime = `image/${ext}`;
  return { mime, base64: buf.toString('base64'), dataUrl: `data:${mime};base64,${buf.toString('base64')}` };
}

function isImageFile(filePath) {
  if (!filePath) return false;
  const ext = path.extname(filePath).toLowerCase();
  return ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'].includes(ext);
}

const PROVIDERS = {
  openrouter: {
    name: 'OpenRouter',
    defaultModels: [
      { id: 'google/gemini-2.0-flash-exp:free', vision: true },
      { id: 'meta-llama/llama-3.2-11b-vision-instruct:free', vision: true },
      { id: 'mistralai/mistral-7b-instruct:free', vision: false },
      { id: 'meta-llama/llama-3.1-8b-instruct:free', vision: false }
    ],
    async generate({ apiKey, model, prompt, imagePath, useVision }) {
      const content = [{ type: 'text', text: prompt }];
      if (useVision && isImageFile(imagePath)) {
        const img = readImageAsDataURL(imagePath);
        if (img) content.push({ type: 'image_url', image_url: { url: img.dataUrl } });
      }
      const resp = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        { model, messages: [{ role: 'user', content }], max_tokens: 300, temperature: 0.7 },
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://github.com/ahmedhasson763-ops/image-post',
            'X-Title': 'Folder2Page Image Tool'
          },
          timeout: 60000
        }
      );
      const text = resp.data?.choices?.[0]?.message?.content;
      if (!text) throw new Error('Empty response from OpenRouter');
      return String(text).trim();
    }
  },

  gemini: {
    name: 'Google Gemini',
    defaultModels: [
      { id: 'gemini-2.0-flash-exp', vision: true },
      { id: 'gemini-1.5-flash-8b', vision: true },
      { id: 'gemini-1.5-flash', vision: true }
    ],
    async generate({ apiKey, model, prompt, imagePath, useVision }) {
      const parts = [{ text: prompt }];
      if (useVision && isImageFile(imagePath)) {
        const img = readImageAsDataURL(imagePath);
        if (img) parts.push({ inline_data: { mime_type: img.mime, data: img.base64 } });
      }
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const resp = await axios.post(
        url,
        {
          contents: [{ role: 'user', parts }],
          generationConfig: { maxOutputTokens: 300, temperature: 0.7 }
        },
        { headers: { 'Content-Type': 'application/json' }, timeout: 60000 }
      );
      const text = resp.data?.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join('').trim();
      if (!text) {
        const reason = resp.data?.promptFeedback?.blockReason || resp.data?.candidates?.[0]?.finishReason || 'unknown';
        throw new Error(`Empty response from Gemini (${reason})`);
      }
      return text;
    }
  },

  groq: {
    name: 'Groq',
    defaultModels: [
      { id: 'llama-3.2-11b-vision-preview', vision: true },
      { id: 'llama-3.2-90b-vision-preview', vision: true },
      { id: 'llama-3.3-70b-versatile', vision: false },
      { id: 'llama-3.1-8b-instant', vision: false }
    ],
    async generate({ apiKey, model, prompt, imagePath, useVision }) {
      const content = [{ type: 'text', text: prompt }];
      if (useVision && isImageFile(imagePath)) {
        const img = readImageAsDataURL(imagePath);
        if (img) content.push({ type: 'image_url', image_url: { url: img.dataUrl } });
      }
      // Groq quirk: vision models reject the array-of-parts format when there's no image;
      // collapse to plain string when text-only.
      const messages = content.length === 1
        ? [{ role: 'user', content: content[0].text }]
        : [{ role: 'user', content }];

      const resp = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        { model, messages, max_tokens: 300, temperature: 0.7 },
        {
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          timeout: 60000
        }
      );
      const text = resp.data?.choices?.[0]?.message?.content;
      if (!text) throw new Error('Empty response from Groq');
      return String(text).trim();
    }
  }
};

// ════════════════════════════════════════
// PROMPT BUILDER
// ════════════════════════════════════════

const LANGUAGE_LABELS = {
  'es-MX': 'Mexican Spanish (español mexicano natural, casual, no formal)',
  es: 'Neutral international Spanish',
  'es-ES': 'Castilian Spanish (España)',
  en: 'Casual English',
  'en-US': 'American English',
  'en-GB': 'British English',
  'pt-BR': 'Brazilian Portuguese',
  pt: 'European Portuguese',
  fr: 'French',
  de: 'German',
  it: 'Italian',
  hi: 'Hindi',
  bn: 'Bengali',
  ar: 'Arabic',
  ja: 'Japanese',
  ko: 'Korean'
};

function buildPrompt({ language, niche, customPrompt, filename, hasImage }) {
  if (customPrompt && customPrompt.trim()) {
    return customPrompt
      .replace(/\{language\}/g, language || 'es-MX')
      .replace(/\{niche\}/g, niche || 'general lifestyle content')
      .replace(/\{filename\}/g, filename || '')
      .replace(/\{has_image\}/g, hasImage ? 'yes' : 'no');
  }
  const langName = LANGUAGE_LABELS[language] || language || 'Mexican Spanish';
  const nicheLine = niche ? `\nThe Facebook page niche / brand context is: ${niche}.` : '';
  const imageLine = hasImage
    ? '\nLook at the image carefully and describe what is happening in it, focused on what would interest a casual scroller.'
    : '\nYou cannot see the image. Use the filename hint to infer the topic.';
  const fileLine = filename ? `\nFilename of the content for hints: ${filename}` : '';

  return `You are a senior social-media copywriter. Write ONE engaging Facebook post in ${langName}.${nicheLine}${imageLine}${fileLine}

Strict rules — follow ALL of them:
- 1 to 3 short sentences. Sound human and casual, not formal.
- End with ONE open-ended question (for organic engagement, NOT clickbait).
- Use 1-2 emojis maximum, placed naturally. No emoji spam.
- No clickbait, no ALL CAPS, no "click here", no engagement-bait phrases.
- No misleading or sensational claims. Respect Facebook Community Standards.
- Max 3 relevant hashtags at the very end (optional). No hashtags at the start.
- Reply with ONLY the post text. No preamble, no explanation, no quotes, no labels.`;
}

// ════════════════════════════════════════
// PUBLIC API
// ════════════════════════════════════════

async function getEnabledProviders() {
  return allQuery(
    `SELECT * FROM ai_providers
     WHERE enabled=1 AND api_key != '' AND model != ''
     ORDER BY priority ASC, id ASC`
  );
}

async function getSettings() {
  return getQuery(`SELECT * FROM ai_settings WHERE id=1`);
}

/**
 * Generate a caption for a single piece of content.
 *
 * @returns {Promise<{ caption: string|null, used: { provider: string, model: string }|null, error: string|null, attempts: Array }>}
 */
async function generateCaption({ imagePath, filename, settings = null, providersOverride = null } = {}) {
  const cfg = settings || (await getSettings());
  if (!cfg || !cfg.enabled) return { caption: null, used: null, error: 'AI captions disabled in settings', attempts: [] };

  const providers = providersOverride || (await getEnabledProviders());
  if (!providers.length) return { caption: null, used: null, error: 'No enabled AI providers configured', attempts: [] };

  const hasImage = isImageFile(imagePath);
  const prompt = buildPrompt({
    language: cfg.language,
    niche: cfg.niche,
    customPrompt: cfg.custom_prompt,
    filename,
    hasImage: hasImage && !!cfg.use_vision
  });

  const attempts = [];
  for (const provider of providers) {
    const def = PROVIDERS[provider.provider];
    if (!def) {
      attempts.push({ provider: provider.provider, model: provider.model, error: 'Unknown provider' });
      continue;
    }
    const useVision = !!provider.supports_vision && !!cfg.use_vision && hasImage;
    try {
      const caption = await def.generate({
        apiKey: provider.api_key,
        model: provider.model,
        prompt,
        imagePath,
        useVision
      });
      if (!caption) throw new Error('Empty caption');
      // Success — clear last_error and stamp last_used
      try {
        await runQuery(`UPDATE ai_providers SET last_used=?, last_error=NULL WHERE id=?`, [Date.now(), provider.id]);
      } catch (_) {}
      attempts.push({ provider: provider.provider, model: provider.model, ok: true });
      return {
        caption,
        used: { provider: provider.provider, model: provider.model, label: provider.label || '' },
        error: null,
        attempts
      };
    } catch (e) {
      const errMsg = extractErrorMessage(e);
      attempts.push({ provider: provider.provider, model: provider.model, error: errMsg });
      try {
        await runQuery(`UPDATE ai_providers SET last_error=? WHERE id=?`, [errMsg.slice(0, 500), provider.id]);
      } catch (_) {}
      // Continue to next provider in the chain
    }
  }
  return {
    caption: null,
    used: null,
    error: `All ${providers.length} AI provider(s) failed`,
    attempts
  };
}

function extractErrorMessage(e) {
  if (!e) return 'Unknown error';
  const r = e.response;
  if (r) {
    const data = r.data;
    if (typeof data === 'string') return `HTTP ${r.status}: ${data.slice(0, 300)}`;
    const apiMsg = data?.error?.message || data?.error || data?.message;
    if (apiMsg) return `HTTP ${r.status}: ${typeof apiMsg === 'string' ? apiMsg : JSON.stringify(apiMsg)}`;
    return `HTTP ${r.status}`;
  }
  return e.message || String(e);
}

/**
 * Return the list of supported providers and their default model catalog,
 * for the UI dropdowns.
 */
function listProvidersCatalog() {
  return Object.entries(PROVIDERS).map(([key, def]) => ({
    key,
    name: def.name,
    models: def.defaultModels
  }));
}

module.exports = {
  PROVIDERS,
  generateCaption,
  buildPrompt,
  getEnabledProviders,
  getSettings,
  listProvidersCatalog,
  isImageFile
};
