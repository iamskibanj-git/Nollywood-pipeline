const fs = require('fs');
const path = require('path');

/**
 * HiggsfieldHistory
 *
 * Scrapes Higgsfield's Assets/All page (https://higgsfield.ai/asset/all) to find
 * recently-generated videos that exist on Higgsfield's side but are missing locally.
 * Used by:
 *   - Inline auto-recovery (orchestrator video catch block) — single-asset lookup
 *   - CLI recovery script (scripts/recover-from-history.js) — batch recovery
 *
 * Reuses the existing Playwright session from the parent HiggsFieldAutomation.
 *
 * Discovery notes (from screenshots, April 2026):
 *   - Page auto-groups by date (Today / Yesterday / X days ago)
 *   - Left sidebar has Video filter (cuts to videos only)
 *   - Each thumbnail links to /asset/all/<uuid>
 *   - Click thumbnail → right-side detail panel shows PROMPT + Created date + Download button
 *   - Likely has a JSON API at /api/asset/<uuid> (verify in DevTools during first live test)
 *
 * Selectors live in config/higgsfield-selectors.json under "assetHistory".
 * Update them as we learn more from real DOM inspection.
 */
class HiggsfieldHistory {
  /**
   * @param {Object} opts
   * @param {Object} opts.automation - The HiggsFieldAutomation instance (provides this.page + this.selectors)
   * @param {Object} [opts.logger] - Optional logger function (defaults to console.log)
   */
  constructor({ automation, logger } = {}) {
    if (!automation) throw new Error('HiggsfieldHistory requires automation');
    this.automation = automation;
    this.log = logger || ((msg) => console.log(`[HISTORY] ${msg}`));

    // In-memory scrape cache: { videos, ts }
    // Multiple inline-recovery attempts in a short window share one scrape.
    this._cache = null;
    this.CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
  }

  // ══════════════════════════════════════════════════════════
  // PUBLIC API
  // ══════════════════════════════════════════════════════════

  /**
   * Scrape recent video assets from Higgsfield's history page.
   *
   * @param {Object} options
   * @param {number} [options.maxAgeHours=24] - Only return assets newer than this
   * @param {number} [options.maxItems=100] - Cap on items returned
   * @param {boolean} [options.bypassCache=false] - Force a fresh scrape
   * @returns {Promise<Array<{uuid, prompt, createdAt, cdnUrl?, thumbnailUrl?, model?}>>}
   */
  async scrapeRecentVideos(options = {}) {
    const { maxAgeHours = 24, maxItems = 100, bypassCache = false } = options;

    if (!bypassCache && this._cache && Date.now() - this._cache.ts < this.CACHE_TTL_MS) {
      this.log(`Using cached scrape (${this._cache.videos.length} items, age ${Math.round((Date.now() - this._cache.ts) / 1000)}s)`);
      return this._cache.videos;
    }

    const page = this.automation.page;
    if (!page || page.isClosed()) {
      throw new Error('No active Playwright page — automation not initialized');
    }

    const sel = this.automation.selectors.assetHistory;
    if (!sel) {
      throw new Error('assetHistory selectors missing in higgsfield-selectors.json');
    }

    this.log('Navigating to Higgsfield Assets page...');
    await page.goto(sel.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    // Reuse parent's ad dismissal — an ad over the Assets page would block clicks
    if (typeof this.automation._dismissPromoAd === 'function') {
      try { await this.automation._dismissPromoAd(); } catch (_) {}
    }

    // Click the "Video" filter in the left sidebar
    await this._clickVideoFilter(page, sel);

    // Scrape thumbnails. We try the "structured" path first (find UUID via href);
    // if that fails, fall back to a broader DOM walk.
    let videos = await this._scrapeStructured(page, sel, { maxItems });

    if (videos.length === 0) {
      this.log('Structured scrape returned 0 — falling back to broad DOM walk');
      videos = await this._scrapeBroad(page, sel, { maxItems });
    }

    // Filter by age if we have createdAt timestamps. Skip items where createdAt
    // is missing (we can't tell if they're stale, so include them — matcher will
    // sort it out via prompt similarity).
    const cutoff = Date.now() - maxAgeHours * 3600 * 1000;
    const filtered = videos.filter(v => !v.createdAtMs || v.createdAtMs >= cutoff);

    this.log(`Scraped ${filtered.length} video(s) (${videos.length - filtered.length} filtered out by age)`);

    this._cache = { videos: filtered, ts: Date.now() };
    return filtered;
  }

  /**
   * Open one asset's detail panel (or hit JSON API if discovered) to get the full
   * prompt, CDN URL, and metadata. Used by both single-asset matching and download.
   *
   * @param {string} uuid
   * @returns {Promise<{uuid, prompt, createdAt, cdnUrl, model, quality} | null>}
   */
  async getAssetDetails(uuid) {
    const page = this.automation.page;
    const sel = this.automation.selectors.assetHistory;

    if (!uuid) throw new Error('getAssetDetails: missing uuid');

    // Approach 1: try direct API endpoint (TBD during Phase 1 live testing).
    // For now we navigate to the asset's deep URL and scrape the detail panel.
    const detailUrl = `${sel.url}/${uuid}`;
    this.log(`Loading asset details: ${uuid}`);

    // Capture any /api/asset/<uuid> JSON response that fires on navigation
    let apiResponse = null;
    const respHandler = async (resp) => {
      try {
        const url = resp.url();
        if (url.includes(`/asset/${uuid}`) || url.includes(`/api/asset/${uuid}`)) {
          if (resp.headers()['content-type']?.includes('json')) {
            apiResponse = await resp.json().catch(() => null);
          }
        }
      } catch (_) {}
    };
    page.on('response', respHandler);

    try {
      await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(1500);

      // If we got JSON from the API, prefer it
      if (apiResponse) {
        return this._normalizeApiResponse(apiResponse, uuid);
      }

      // Fallback: scrape DOM
      const domDetails = await page.evaluate((selectors) => {
        const promptEl = document.querySelector(selectors.detailPromptText);
        const createdEl = document.querySelector(selectors.detailCreatedAt);
        const modelEl = document.querySelector(selectors.detailModelLabel);
        // CDN URL might live in a <video src> or be derivable from a download link
        const videoEl = document.querySelector('video[src]');
        const downloadLink = document.querySelector(selectors.detailDownloadButton);
        return {
          prompt: promptEl ? (promptEl.textContent || '').trim() : null,
          created: createdEl ? (createdEl.textContent || '').trim() : null,
          model: modelEl ? (modelEl.textContent || '').trim() : null,
          videoSrc: videoEl ? videoEl.src : null,
          downloadHref: downloadLink ? downloadLink.href : null,
        };
      }, sel);

      return {
        uuid,
        prompt: domDetails.prompt || '',
        createdAt: domDetails.created || null,
        createdAtMs: this._parseCreatedDate(domDetails.created),
        cdnUrl: domDetails.videoSrc || domDetails.downloadHref || null,
        model: domDetails.model || null,
      };
    } finally {
      page.off('response', respHandler);
    }
  }

  /**
   * Find a single match for a specific pending DB asset.
   * Used by inline auto-recovery in the video catch block.
   *
   * @param {Object} asset - DB row { id, chapter, line, prompt_used, created_at, ... }
   * @param {Object} options
   * @param {number} [options.timestampWindowMs=600000] - ±10 min default
   * @param {number} [options.minPromptSimilarity=85] - 0-100; below this = no match
   * @param {number} [options.scrapeTimeoutMs=30000]
   * @returns {Promise<{uuid, cdnUrl, prompt, score, confidence} | null>}
   */
  async findMatchForAsset(asset, options = {}) {
    const {
      timestampWindowMs = 10 * 60 * 1000,
      minPromptSimilarity = 85,
      scrapeTimeoutMs = 30000,
    } = options;

    const expectedPrompt = asset.prompt_used || '';
    if (!expectedPrompt) {
      this.log(`Cannot match asset id=${asset.id}: no prompt_used recorded`);
      return null;
    }

    // Scrape Today's videos (cached if possible)
    const scrapePromise = this.scrapeRecentVideos({ maxAgeHours: 24 });
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Scrape timeout')), scrapeTimeoutMs)
    );
    const videos = await Promise.race([scrapePromise, timeoutPromise]);

    // Match using clipMatcher (Phase 3 module)
    const { scoreMatch } = require('../recovery/clipMatcher');
    const assetCreatedMs = asset.created_at ? new Date(asset.created_at).getTime() : Date.now();

    let best = null;
    for (const video of videos) {
      const result = scoreMatch(
        { prompt: video.prompt, createdAtMs: video.createdAtMs },
        { prompt: expectedPrompt, createdAtMs: assetCreatedMs },
        { timestampWindowMs }
      );
      if (result.score > (best?.score || 0)) {
        best = { ...video, ...result };
      }
    }

    if (!best || best.score < minPromptSimilarity) {
      this.log(`No high-confidence match for asset id=${asset.id} (best=${best?.score ?? 0}%)`);
      return null;
    }

    // If the matched video doesn't have a cdnUrl yet (DOM scrape might miss it),
    // fetch full details now.
    if (!best.cdnUrl) {
      const details = await this.getAssetDetails(best.uuid);
      if (details?.cdnUrl) best.cdnUrl = details.cdnUrl;
    }

    if (!best.cdnUrl) {
      this.log(`Match found for asset id=${asset.id} but no CDN URL extractable from ${best.uuid}`);
      return null;
    }

    return best;
  }

  /**
   * Download a Higgsfield video by UUID to a local path.
   *
   * Two strategies:
   *   1. If we have a CDN URL, fetch it directly (fast, cheap)
   *   2. Otherwise navigate to detail page + click Download (uses persistent
   *      filechooser pattern from main automation)
   *
   * @param {string} uuid
   * @param {string} destPath - Absolute local path to write
   * @param {string} [knownCdnUrl] - Skip detail lookup if you already have it
   * @returns {Promise<{path: string, sizeBytes: number}>}
   */
  async downloadAsset(uuid, destPath, knownCdnUrl = null) {
    const page = this.automation.page;
    let cdnUrl = knownCdnUrl;

    if (!cdnUrl) {
      const details = await this.getAssetDetails(uuid);
      cdnUrl = details?.cdnUrl;
    }

    if (!cdnUrl) {
      throw new Error(`Cannot download asset ${uuid} — no CDN URL available`);
    }

    this.log(`Fetching CDN URL: ${cdnUrl.slice(0, 80)}...`);

    // Use page.evaluate to fetch via the browser context (auth cookies included).
    // This avoids needing to replicate auth in a separate node-level fetch.
    const data = await page.evaluate(async (url) => {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const blob = await resp.blob();
      const buffer = await blob.arrayBuffer();
      return Array.from(new Uint8Array(buffer));
    }, cdnUrl);

    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, Buffer.from(data));
    const stat = fs.statSync(destPath);
    if (stat.size < 10000) {
      throw new Error(`Downloaded file too small (${stat.size} bytes) — likely a stub or error page`);
    }

    this.log(`Downloaded ${stat.size} bytes → ${path.basename(destPath)}`);
    return { path: destPath, sizeBytes: stat.size };
  }

  /**
   * Invalidate the in-memory scrape cache. Call when you know the cache is stale
   * (e.g., after a regen succeeded, scraping next time should pick it up).
   */
  invalidateCache() {
    this._cache = null;
  }

  // ══════════════════════════════════════════════════════════
  // INTERNAL — selector clicking
  // ══════════════════════════════════════════════════════════

  async _clickVideoFilter(page, sel) {
    try {
      const link = await page.$(sel.videoFilterLink);
      if (!link) {
        this.log('Video filter link not found — assets page may already be filtered or selector is stale');
        return;
      }
      await link.click();
      await page.waitForTimeout(1500);
    } catch (e) {
      this.log(`Could not click Video filter: ${e.message}`);
    }
  }

  // ══════════════════════════════════════════════════════════
  // INTERNAL — scraping strategies
  // ══════════════════════════════════════════════════════════

  /**
   * Structured scrape: rely on /asset/all/<uuid> hrefs to find each thumbnail.
   * This is the cleanest approach if Higgsfield consistently renders thumbnails
   * as <a href="/asset/all/<uuid>"> elements.
   */
  async _scrapeStructured(page, sel, { maxItems }) {
    return page.evaluate((selectors, max) => {
      const links = Array.from(document.querySelectorAll(selectors.thumbnailLink || 'a[href*="/asset/all/"]'));
      const seen = new Set();
      const items = [];
      for (const a of links) {
        const href = a.getAttribute('href') || '';
        const match = href.match(/\/asset\/all\/([0-9a-f-]{36})/i);
        if (!match) continue;
        const uuid = match[1];
        if (seen.has(uuid)) continue;
        seen.add(uuid);

        // Try to find a date label nearby (Today / Yesterday / X days ago)
        let dateLabel = null;
        let dateNode = a.closest('section, div')?.previousElementSibling;
        for (let i = 0; i < 5 && dateNode; i++) {
          const text = (dateNode.textContent || '').trim();
          if (/today|yesterday|days ago|hours ago/i.test(text) && text.length < 50) {
            dateLabel = text;
            break;
          }
          dateNode = dateNode.previousElementSibling;
        }

        items.push({
          uuid,
          dateLabel,
          // We don't have prompt/cdnUrl from the grid alone — populated later via getAssetDetails
          prompt: '',
          cdnUrl: null,
          createdAtMs: null,
        });
        if (items.length >= max) break;
      }
      return items;
    }, sel, maxItems);
  }

  /**
   * Broad scrape fallback: walk the DOM looking for ANY element with a UUID-like
   * data attribute or text. Used if structured scrape returns 0 (e.g., Higgsfield
   * UI changes the href pattern).
   */
  async _scrapeBroad(page, sel, { maxItems }) {
    return page.evaluate((max) => {
      const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
      const seen = new Set();
      const items = [];

      // Look for data-* attributes containing UUIDs
      for (const el of document.querySelectorAll('[data-asset-id], [data-asset-uuid], [data-id]')) {
        for (const attr of ['data-asset-id', 'data-asset-uuid', 'data-id']) {
          const val = el.getAttribute(attr);
          if (val && uuidPattern.test(val)) {
            uuidPattern.lastIndex = 0; // reset regex
            if (seen.has(val)) continue;
            seen.add(val);
            items.push({ uuid: val, prompt: '', cdnUrl: null, createdAtMs: null });
            if (items.length >= max) return items;
          }
        }
      }

      return items;
    }, maxItems);
  }

  // ══════════════════════════════════════════════════════════
  // INTERNAL — utilities
  // ══════════════════════════════════════════════════════════

  /**
   * Normalize a /api/asset/<uuid> JSON response into our standard shape.
   * The exact field names will need verification during Phase 1 — for now we
   * try common patterns and fall through.
   */
  _normalizeApiResponse(apiResp, uuid) {
    if (!apiResp) return null;
    const result = apiResp.result || apiResp.data || apiResp.asset || apiResp;
    return {
      uuid,
      prompt: result.prompt || result.params?.prompt || result.input?.prompt || '',
      createdAt: result.created_at || result.createdAt || null,
      createdAtMs: result.created_at ? new Date(result.created_at).getTime() : null,
      cdnUrl: result.url || result.cdn_url || result.video_url || result.results?.[0]?.url || null,
      model: result.model || result.model_name || null,
      quality: result.quality || result.resolution || null,
    };
  }

  /**
   * Parse a Higgsfield-displayed "Created" date into millis since epoch.
   * Higgsfield seems to show dates like "April 14, 2026" — we don't have time
   * precision unless the API gives us ISO timestamps.
   */
  _parseCreatedDate(text) {
    if (!text) return null;
    // ISO format from API
    const iso = Date.parse(text);
    if (!isNaN(iso)) return iso;
    // "April 14, 2026" — try Date.parse, will give midnight of that day
    const parsed = Date.parse(text.trim());
    if (!isNaN(parsed)) return parsed;
    return null;
  }
}

module.exports = { HiggsfieldHistory };
