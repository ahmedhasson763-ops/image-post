const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const mime = require('mime-types');

/**
 * Fetch all Facebook pages the user manages (personal + business)
 */
async function fetchAllPages(accessToken) {
  const pagesMap = new Map();

  async function paginate(url, cb) {
    while (url) {
      try {
        const res = await axios.get(url);
        if (res.data?.data) cb(res.data.data);
        url = res.data?.paging?.next || null;
      } catch (e) {
        console.error('[FB] Pagination error:', e.response?.data?.error?.message || e.message);
        break;
      }
    }
  }

  // Personal pages
  await paginate(
    `https://graph.facebook.com/v19.0/me/accounts?access_token=${accessToken}&fields=id,name,access_token,category&limit=100`,
    (pages) => pages.forEach(p => pagesMap.set(p.id, {
      id: p.id, name: p.name, access_token: p.access_token, category: p.category || 'Page'
    }))
  );

  // Business pages
  let businesses = [];
  try {
    await paginate(
      `https://graph.facebook.com/v19.0/me/businesses?access_token=${accessToken}&limit=100`,
      (data) => { businesses = businesses.concat(data); }
    );
  } catch (e) {}

  for (const biz of businesses) {
    await paginate(
      `https://graph.facebook.com/v19.0/${biz.id}/owned_pages?access_token=${accessToken}&limit=100`,
      (pages) => pages.forEach(p => pagesMap.set(p.id, {
        id: p.id, name: p.name, access_token: p.access_token, category: p.category || 'Business Page'
      }))
    );
    await paginate(
      `https://graph.facebook.com/v19.0/${biz.id}/client_pages?access_token=${accessToken}&limit=100`,
      (pages) => pages.forEach(p => pagesMap.set(p.id, {
        id: p.id, name: p.name, access_token: p.access_token, category: p.category || 'Client Page'
      }))
    );
  }

  return Array.from(pagesMap.values());
}

/**
 * Post content (image/video/text) to a Facebook page
 * @param {string} pageId
 * @param {string} pageAccessToken
 * @param {string} caption
 * @param {string|null} mediaPath
 * @param {object|null} proxyAgent - Optional HTTPS proxy agent for routing through proxy
 */
async function postToPage(pageId, pageAccessToken, caption, mediaPath = null, proxyAgent = null) {
  try {
    // Base axios config with optional proxy
    const baseConfig = {
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      timeout: 300000 // 5 min timeout for large uploads
    };
    if (proxyAgent) {
      baseConfig.httpsAgent = proxyAgent;
    }

    if (mediaPath && fs.existsSync(mediaPath)) {
      const mimeType = mime.lookup(mediaPath) || 'application/octet-stream';
      const form = new FormData();
      form.append('access_token', pageAccessToken);

      let url = '';
      if (mimeType.startsWith('image/')) {
        url = `https://graph.facebook.com/v19.0/${pageId}/photos`;
        if (caption) form.append('message', caption);
        form.append('source', fs.createReadStream(mediaPath));
      } else if (mimeType.startsWith('video/')) {
        url = `https://graph.facebook.com/v19.0/${pageId}/videos`;
        if (caption) form.append('description', caption);
        form.append('source', fs.createReadStream(mediaPath));
      } else {
        throw new Error(`Unsupported media type: ${mimeType}`);
      }

      const response = await axios.post(url, form, {
        ...baseConfig,
        headers: form.getHeaders()
      });
      return response.data;
    } else {
      // Text-only post
      const url = `https://graph.facebook.com/v19.0/${pageId}/feed`;
      const response = await axios.post(url, {
        message: caption,
        access_token: pageAccessToken
      }, baseConfig);
      return response.data;
    }
  } catch (error) {
    const msg = error.response?.data?.error?.message || error.message || 'Unknown FB API error';
    console.error(`[FB] ❌ Post failed for page ${pageId}:`, msg);
    throw new Error(msg);
  }
}

module.exports = { fetchAllPages, postToPage };

