const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// ══════════════════════════════════════════════════════════
// UPLOAD TIMING CONFIG (tunable without code changes via env vars)
// ══════════════════════════════════════════════════════════
//
// These control the cumulative wait before clicking Generate after references/
// start frames have been uploaded. The cost of waiting too little is CATASTROPHIC
// (credits burned on generations with missing references → random output), while
// the cost of waiting too long is only time (~30s per image × N images).
//
// Tune down as confidence in the pipeline grows:
//   REFERENCE_SETTLE_TIMEOUT_MS  — how long to wait for CDN URLs to appear
//   REFERENCE_SETTLE_EXTRA_MS    — belt-and-suspenders wait AFTER CDN URLs are all present
//   START_FRAME_SETTLE_TIMEOUT_MS — same as above but for video start frame
//   START_FRAME_SETTLE_EXTRA_MS  — same as above but for video
//
// Defaults are conservative for MVP stability. Read from env for easy tuning.
const REFERENCE_SETTLE_TIMEOUT_MS = Number(process.env.REFERENCE_SETTLE_TIMEOUT_MS) || 180000; // 3 min
const REFERENCE_SETTLE_EXTRA_MS   = Number(process.env.REFERENCE_SETTLE_EXTRA_MS)   || 30000;  // 30s buffer

// Generation timeouts — Higgsfield job processing can be slow during peak hours.
// Previously 300s (5 min) which was too tight — Veo clips can take 3-6 min during load.
// 300s → 600s doubles headroom without sacrificing too much time on actually-stuck jobs.
const VIDEO_GEN_TIMEOUT_MS = Number(process.env.VIDEO_GEN_TIMEOUT_MS) || 600000; // 10 min
const IMAGE_GEN_TIMEOUT_MS = Number(process.env.IMAGE_GEN_TIMEOUT_MS) || 420000; // 7 min
const START_FRAME_SETTLE_TIMEOUT_MS = Number(process.env.START_FRAME_SETTLE_TIMEOUT_MS) || 180000; // 3 min
const START_FRAME_SETTLE_EXTRA_MS   = Number(process.env.START_FRAME_SETTLE_EXTRA_MS)   || 30000;  // 30s buffer

/**
 * HiggsFieldAutomation
 *
 * Drives Higgsfield AI through Playwright in headed (visible) mode.
 * Selectors mapped from the live Higgsfield interface (April 2026).
 *
 * Key findings from UI inspection:
 * - Prompt inputs are contenteditable divs (role="textbox"), NOT textareas
 * - File inputs are hidden 1x1px elements — use setInputFiles() directly
 * - Image page: model pre-selected via query param (/ai/image?model=nano-banana-pro)
 * - Video page: model requires submenu navigation (Model > Google Veo > Veo 3.1 Lite)
 * - Aspect ratio / resolution / duration use native <select> elements
 * - Audio on Veo 3.1 Lite is a checkbox that defaults to ON
 *
 * Upload/Download workflows (mapped April 2026):
 *
 * IMAGE REFERENCE UPLOAD:
 *   - 3 hidden file inputs (1x1px) wrapped in label > button containers
 *   - Each slot is a 56x56 rounded-xl container with:
 *     - Empty state: SVG upload icon, label wrapping hidden input
 *     - Filled state: img thumbnail + close/delete button (24x24, top-right)
 *   - Use setInputFiles() directly on input[type="file"] elements
 *   - After upload, wait for thumbnail img to appear in the slot container
 *   - To clear: click the close button (button with SVG, positioned at top-right of slot)
 *
 * IMAGE DOWNLOAD:
 *   - Click on history card → opens lightbox/detail view
 *   - Lightbox right panel has: Animate, Publish, Open in, Reference, Download buttons
 *   - Download button selector: button with text "Download" in the detail panel
 *   - Alternative: images served from images.higgs.ai with query params (url, w, q)
 *   - Hover buttons on history card: heart, download (arrow), copy, three-dot menu
 *   - Hover download button class: "button button-sm button-primary-reverted rounded-full w-8"
 *
 * VIDEO START FRAME UPLOAD:
 *   - Single hidden file input accepting image/jpeg, image/jpg, image/png, image/webp
 *   - Wrapped in label (259x119) with text "Upload image or generate it"
 *   - Use setInputFiles() directly on the input element
 *   - After upload, wait for image preview to appear in the upload area
 *
 * VIDEO DOWNLOAD:
 *   - Videos in History tab play inline (no lightbox like images)
 *   - Video served from d8j0ntlcm91z4.cloudfront.net
 *   - Hover reveals same button pattern: heart, download, copy, menu
 *   - Can also extract video src directly from <video> element
 *   - Bottom row has: Rerun, copy, trash buttons
 */
class HiggsFieldAutomation {
  constructor(browserView, projectDir) {
    // browserView parameter kept for API compatibility but no longer used
    this.projectDir = projectDir;
    this.browser = null;
    this.page = null;
    this.cancelled = false;

    // Throttle detection: when Higgsfield slows down Unlimited (free) generations,
    // we switch to credits for the rest of the session. At 2 credits per image, the
    // cost is negligible compared to the time wasted waiting for throttled gens.
    this.throttled = false;

    // Load selectors config
    const selectorsPath = path.join(__dirname, '..', '..', '..', 'config', 'higgsfield-selectors.json');
    try {
      this.selectors = JSON.parse(fs.readFileSync(selectorsPath, 'utf-8'));
    } catch (e) {
      throw new Error(`Cannot load selectors config: ${e.message}. Run the app once and update config/higgsfield-selectors.json.`);
    }
  }

  async ensureBrowser() {
    // Check if existing page is still alive — a closed page needs full reinit
    if (this.page) {
      try {
        if (!this.page.isClosed()) return;
        console.warn('[BROWSER] Existing page is CLOSED — reinitializing...');
        this.page = null;
      } catch (_) {
        this.page = null;
      }
    }

    // If browser is still alive but page is gone, try creating just a new page+context
    if (this.browser) {
      try {
        const sessionPath = this.getSessionPath();
        const contextOpts = { viewport: null }; // null = use actual window size (maximized)
        if (sessionPath && fs.existsSync(sessionPath)) {
          contextOpts.storageState = sessionPath;
        }
        const context = await this.browser.newContext(contextOpts);
        this.page = await context.newPage();
        this.page.on('download', (download) => { this._lastDownload = download; });
        console.log('[BROWSER] Reused existing browser with new context+page');
        return;
      } catch (e) {
        console.warn(`[BROWSER] Could not reuse browser (${e.message.split('\n')[0]}) — full relaunch`);
        try { await this.browser.close(); } catch (_) {}
        this.browser = null;
      }
    }

    // Launch headed Chromium — the operator watches automation happen.
    // --start-maximized ensures the window fills the screen; viewport: null
    // (below) tells Playwright not to override the viewport size, so it
    // matches the actual maximized window dimensions. This prevents
    // responsive layout shifts that caused missing toolbar elements at 1400x850.
    this.browser = await chromium.launch({
      headless: false,
      args: [
        '--start-maximized',
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',            // Stability on Windows
        '--disable-gpu',           // Prevents GPU rendering issues
      ],
    });

    // Detect user manually closing the browser window.
    // When they close the Chromium window (X button), we flip a flag so the
    // pipeline can fail gracefully rather than hitting cascade-closed-page errors.
    this.browser.on('disconnected', () => {
      console.warn('[BROWSER] Browser disconnected (user closed window, crashed, or quit)');
      this._userClosedBrowser = true;
      this.browser = null;
      this.page = null;
    });

    // Try loading saved session cookies
    const sessionPath = this.getSessionPath();
    let context;
    if (sessionPath && fs.existsSync(sessionPath)) {
      try {
        context = await this.browser.newContext({
          viewport: null,
          storageState: sessionPath,
        });
      } catch {
        context = await this.browser.newContext({ viewport: null });
      }
    } else {
      context = await this.browser.newContext({ viewport: null });
    }

    this.page = await context.newPage();

    // Intercept downloads
    this.page.on('download', async (download) => {
      this._lastDownload = download;
    });
  }

  /**
   * Navigate to a Higgsfield page and ensure the generation UI is loaded.
   * If the prompt element doesn't appear after the initial goto, falls back
   * to the logo → menu → model click flow that reliably loads the generation bar.
   *
   * @param {string} type - 'image' or 'video'
   * @param {object} sel - Selectors object (imageGeneration or videoGeneration)
   * @returns {Promise<void>}
   */
  async _navigateWithFailsafe(type, sel) {
    const page = this.page;
    const label = type === 'image' ? 'IMG' : 'VID';
    const promptSelector = sel.promptInput;
    const promptFallback = sel.promptInputFallback || "div[role='textbox']";

    // ── VIDEO: Use UI nav clicks (Video → Veo 3.1 Lite) ──
    // Video navigation is handled entirely by selectVideoModel() which uses
    // the correct click path. Just ensure we're on Higgsfield first.
    if (type === 'video') {
      const currentUrl = page.url();
      if (!currentUrl.includes('higgsfield.ai')) {
        console.log('[VID] Not on Higgsfield — navigating to home first...');
        await page.goto('https://higgsfield.ai/', { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(2000);
      }
      // selectVideoModel() will handle the rest (Video nav → Veo 3.1 Lite)
      console.log('[VID] On Higgsfield — selectVideoModel() will handle navigation');
      return;
    }

    // ── IMAGE: Direct URL navigation ──
    // Known URL history: /image/nano_banana_2 → /image/nano-banana-pro → /ai/image?model=nano-banana-pro
    // Old path-based URLs redirect to /ai-image landing page (no gen UI).
    const targetUrl = sel.url;
    console.log(`[${label}] Navigating to ${targetUrl}...`);
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2500);

    // Detect landing page redirect (old URLs redirect to /ai-image)
    const currentUrl = page.url();
    if (currentUrl.includes('/ai-image') && !currentUrl.includes('/ai/image')) {
      console.warn(`[${label}] Redirected to landing page (${currentUrl}) — URL may be stale. Trying /ai/image?model=nano-banana-pro`);
      await page.goto('https://higgsfield.ai/ai/image?model=nano-banana-pro', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2500);
    }

    // Check if prompt element appeared
    let promptEl = await page.$(promptSelector) || await page.$(promptFallback);
    if (promptEl) {
      console.log(`[${label}] Generation UI loaded on first attempt`);
      return;
    }

    // Wait a bit longer — page might be slow
    console.log(`[${label}] Prompt element not found, waiting 3s more...`);
    await page.waitForTimeout(3000);
    promptEl = await page.$(promptSelector) || await page.$(promptFallback);
    if (promptEl) {
      console.log(`[${label}] Generation UI loaded after extended wait`);
      return;
    }

    // Attempt 2: Failsafe — logo click → go home → direct URL retry
    console.log(`[${label}] Generation UI still missing — failsafe: logo click → home → retry direct URL`);

    try {
      await this._clickHiggsLogo(page);
      await page.waitForTimeout(2000);
    } catch (e) {
      console.warn(`[${label}] Logo click failed: ${e.message} — trying direct home nav`);
    }

    // Go home first to reset page state
    try {
      await page.goto('https://higgsfield.ai/', { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(2000);
    } catch (_) { /* ignore — we'll retry the model URL next */ }

    // Retry direct URL (often works after going home first)
    console.log(`[${label}] Retrying direct URL: ${sel.url}`);
    await page.goto(sel.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    promptEl = await page.$(promptSelector) || await page.$(promptFallback);
    if (promptEl) {
      console.log(`[${label}] Generation UI loaded via home → direct URL retry`);
      return;
    }

    // Attempt 3: Try Image nav menu path (button dropdown → "Nano Banana Pro" or "Create Image Now" link)
    console.log(`[${label}] Direct URL retry failed — trying nav menu path`);
    try {
      await this._clickHiggsLogo(page);
      await page.waitForTimeout(1500);
    } catch (_) {}

    // Nav has "Image" as a button (dropdown) or a link — try both
    const navBtn = await page.$('button:has-text("Image"), nav a:has-text("Image"), header a:has-text("Image")');
    if (navBtn) {
      await navBtn.click();
      await page.waitForTimeout(1500);
    }

    // Look for model link in dropdown or page
    const modelLink = await page.$('a:has-text("Nano Banana Pro"), button:has-text("Nano Banana Pro"), a[href*="nano-banana-pro"]');
    if (modelLink) {
      await modelLink.click();
      await page.waitForTimeout(3000);
    } else {
      // Fallback: look for "Create Image Now" CTA that links to the gen page
      const ctaLink = await page.$('a[href*="/ai/image?model=nano-banana-pro"], a:has-text("Create Image Now")');
      if (ctaLink) {
        await ctaLink.click();
        await page.waitForTimeout(3000);
      }
    }

    promptEl = await page.$(promptSelector) || await page.$(promptFallback);
    if (promptEl) {
      console.log(`[${label}] Generation UI loaded via nav menu path`);
      return;
    }

    // Attempt 4: Nuclear — full context recreate + direct URL
    console.log(`[${label}] All nav attempts failed — nuclear: recreate context + fresh navigation`);
    try {
      await this.recreateContext();
      const freshUrl = targetUrl.includes('/ai/image') ? targetUrl : 'https://higgsfield.ai/ai/image?model=nano-banana-pro';
      await this.page.goto(freshUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await this.page.waitForTimeout(3000);

      promptEl = await this.page.$(promptSelector) || await this.page.$(promptFallback);
      if (promptEl) {
        console.log(`[${label}] Generation UI loaded via nuclear context recreate`);
        return;
      }
    } catch (nuclearErr) {
      console.warn(`[${label}] Nuclear recovery failed: ${nuclearErr.message}`);
    }

    throw new Error(`NAVIGATION_FAILED: Could not load ${type} generation UI after 4 attempts (direct URL, home+retry, nav menu, nuclear recreate). The Higgsfield page layout may have changed.`);
  }

  getSessionPath() {
    return path.join(this.projectDir, '..', '..', 'higgsfield-session.json');
  }

  async saveSession() {
    try {
      const sessionPath = this.getSessionPath();
      const dir = path.dirname(sessionPath);
      fs.mkdirSync(dir, { recursive: true });
      const storage = await this.page.context().storageState();
      fs.writeFileSync(sessionPath, JSON.stringify(storage, null, 2));
    } catch (e) {
      console.warn('[SESSION] Could not save:', e.message);
    }
  }

  /**
   * Tear down the current page + context and create a fresh one with the same
   * cookies/auth state. This is the ONLY guaranteed way to clear all React state
   * (in-memory, localStorage, sessionStorage, file inputs, blob URLs).
   *
   * Use this between video clip generations to avoid cross-contamination.
   * Cookies are preserved so login persists.
   */
  async recreateContext() {
    console.log('[CTX] Recreating browser context for clean state...');

    let storageState = null;
    // Capture current cookies/auth before tearing down (if page is still alive)
    try {
      if (this.page && !this.page.isClosed()) {
        storageState = await this.page.context().storageState();
        if (storageState && storageState.origins) {
          storageState.origins = storageState.origins.map(o => ({ ...o, localStorage: [] }));
        }
      }
    } catch (e) {
      console.warn(`[CTX] Could not capture storage state: ${e.message.split('\n')[0]}`);
    }

    // Fall back to disk-saved session if in-memory capture failed
    if (!storageState) {
      const sessionPath = this.getSessionPath();
      if (fs.existsSync(sessionPath)) {
        try {
          storageState = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
          if (storageState && storageState.origins) {
            storageState.origins = storageState.origins.map(o => ({ ...o, localStorage: [] }));
          }
        } catch (_) {}
      }
    }

    // Close the old page + context (best effort)
    try {
      const oldContext = this.page && !this.page.isClosed() ? this.page.context() : null;
      if (this.page && !this.page.isClosed()) {
        await this.page.close().catch(() => {});
      }
      if (oldContext) {
        await oldContext.close().catch(() => {});
      }
    } catch (e) {
      console.warn(`[CTX] Error closing old context: ${e.message.split('\n')[0]}`);
    }

    // ── SELF-HEALING: ensure browser is alive, relaunch if dead ──
    // This fixes the "Target page, context or browser has been closed" cascade
    // that happened on resume when the previous session's browser was dead
    // but this.browser reference was stale.
    let browserAlive = false;
    if (this.browser) {
      try {
        // isConnected() returns false if the browser process died
        browserAlive = this.browser.isConnected();
      } catch (_) {
        browserAlive = false;
      }
    }

    if (!browserAlive) {
      console.warn('[CTX] Browser is dead or missing — relaunching...');
      try {
        if (this.browser) await this.browser.close().catch(() => {});
      } catch (_) {}
      this.browser = null;
      this.page = null;

      this.browser = await chromium.launch({
        headless: false,
        args: ['--start-maximized', '--disable-blink-features=AutomationControlled'],
      });
      console.log('[CTX] ✓ Browser relaunched');
    }

    // Create a fresh context with the captured cookies (no localStorage)
    let newContext;
    try {
      newContext = await this.browser.newContext({
        viewport: null,
        storageState: storageState || undefined,
      });
    } catch (e) {
      console.warn(`[CTX] Failed to create context with storage state: ${e.message.split('\n')[0]}`);
      // One more retry without storage state in case the state file is corrupt
      try {
        newContext = await this.browser.newContext({ viewport: null });
      } catch (e2) {
        // Browser must be truly dead — full relaunch + retry
        console.warn(`[CTX] Context create failed again — doing full browser relaunch`);
        try { await this.browser.close().catch(() => {}); } catch (_) {}
        this.browser = await chromium.launch({
          headless: false,
          args: ['--start-maximized', '--disable-blink-features=AutomationControlled'],
        });
        newContext = await this.browser.newContext({
          viewport: null,
          storageState: storageState || undefined,
        });
      }
    }

    this.page = await newContext.newPage();

    // Validate the new page is alive
    if (!this.page || this.page.isClosed()) {
      throw new Error('Context recreation failed — new page is null or already closed');
    }

    // Re-attach download interceptor
    this.page.on('download', async (download) => {
      this._lastDownload = download;
    });

    console.log('[CTX] ✓ Fresh context created');
  }

  // ══════════════════════════════════════════════════════════
  // IMAGE GENERATION — Nano Banana Pro
  // ══════════════════════════════════════════════════════════

  async generateImage({ prompt, outputPath, references = [], useUnlimited = true, aspectRatio = '16:9', referenceCdnUrl = '', onGenClicked = null }) {
    // Reset per-call state — _lastDetectedUrl must NOT bleed across calls.
    // Without this, a previous portrait's CDN URL would be attached to the
    // next portrait's error, causing wrong-portrait-on-recovery bugs.
    this._lastDetectedUrl = null;

    // Normalize aspect ratio — only these are valid for Nano Banana Pro in this pipeline
    const _aspect = ['1:1', '16:9', '9:16'].includes(aspectRatio) ? aspectRatio : '16:9';
    // If throttled in this session, force credits (override useUnlimited)
    if (this.throttled) {
      useUnlimited = false;
    }

    const genStartTime = Date.now();

    // ── SERVER-SIDE FAILURE RETRY ──
    // Higgsfield sometimes fails with "Failed — Credits refunded" (server-side error).
    // Since credits are refunded, retrying is free. We retry up to 2 times with a
    // fresh context + re-navigation before giving up.
    const MAX_SERVER_RETRIES = 2;
    let serverRetries = 0;

    while (true) { // eslint-disable-line no-constant-condition

    await this.ensureBrowser();
    const sel = this.selectors.imageGeneration;
    let page = this.page;

    try {
      // ── FRESH CONTEXT PER SCENE ──
      // Higgsfield persists reference images in React state + localStorage between
      // generations, so even clearImageReferences() can't reliably clear them.
      // Tearing down the browser context and rebuilding with just cookies is the
      // only guaranteed clean slate. Same pattern as video generation.
      // Cost: ~3-5s per scene. Worth it to avoid stale refs and replace-loop bugs.
      console.log('[IMG] Recreating browser context for clean scene generation...');
      await this.recreateContext();
      page = this.page; // Refresh local ref after context recreate

      // Navigate to Nano Banana Pro on the fresh page
      await this._navigateWithFailsafe('image', sel);

      // Check login
      if (!(await this.isLoggedIn())) {
        throw new Error('SESSION_EXPIRED: Please log into Higgsfield AI in the browser, then click Resume.');
      }

      // Dismiss any preview overlay (last generated image shown as modal/lightbox)
      // BEFORE ad detection, so the preview doesn't get falsely classified.
      // Use Escape only — no force-navigation (which would lose context state).
      try {
        const hasPreview = await page.evaluate(() => {
          // Look for a large image overlay (lightbox showing a generated result)
          for (const img of document.querySelectorAll('img')) {
            const rect = img.getBoundingClientRect();
            if (rect.width > window.innerWidth * 0.5 && rect.height > window.innerHeight * 0.5) {
              const style = window.getComputedStyle(img.closest('div') || img);
              if (style.position === 'fixed' || style.position === 'absolute') return true;
            }
          }
          return !!document.querySelector('img[data-asset-preview]');
        });
        if (hasPreview) {
          console.log('[IMG] Asset preview overlay detected — pressing Escape');
          await page.keyboard.press('Escape');
          await page.waitForTimeout(500);
          await page.keyboard.press('Escape'); // double-tap in case nested
          await page.waitForTimeout(500);
        }
      } catch (_) {}

      // ── AD DISMISSAL with patience (3 rounds) ──
      // Higgsfield's ads appear asynchronously 1-3s after page load. Proceeding
      // too fast causes ads to pop mid-click, navigating us off the page.
      console.log('[IMG] Waiting 3s for any ads to render before dismissing...');
      await page.waitForTimeout(3000);
      await this._dismissPromoAd();
      await page.waitForTimeout(2500);
      await this._dismissPromoAd();
      await page.waitForTimeout(2000);
      await this._dismissPromoAd();
      await page.waitForTimeout(1500);
      console.log('[IMG] Ad dismissal complete, proceeding');

      // Deselect any history grid items that may have been selected (checkmark visible).
      // Higgsfield's history grid lets you multi-select items for batch operations;
      // an accidental click on a history thumbnail toggles its selected state.
      await this._deselectHistoryItems();

      // Wait for the generation form to be ready
      await page.waitForSelector('form.image-form, form', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(1000);

      // Fresh context means no existing refs — skip the clear step.
      // Verify the form truly is empty as a sanity check before we start uploading.
      const freshCheck = await page.evaluate(() => {
        const form = document.querySelector('form.image-form') || document.querySelector('form');
        if (!form) return { slots: 0, filled: 0 };
        const slots = form.querySelectorAll('.size-14');
        let filled = 0;
        for (const slot of slots) {
          const img = slot.querySelector('img');
          if (img && img.src && (img.src.startsWith('blob:') || img.src.startsWith('data:') || img.src.startsWith('http'))) filled++;
        }
        return { slots: slots.length, filled };
      });
      if (freshCheck.filled > 0) {
        console.warn(`[IMG] ⚠ Fresh context still shows ${freshCheck.filled} filled slot(s) — server-side persistence? Attempting clear...`);
        await this.clearImageReferences();
      } else {
        console.log(`[IMG] ✓ Fresh context confirmed clean (${freshCheck.slots} empty slot(s))`);
      }

      // Upload image references (character portraits for face consistency + previous scene)
      if (references.length > 0) {
        console.log(`[IMG] Uploading ${references.length} reference image(s):`);
        const validRefs = [];
        for (let i = 0; i < references.length; i++) {
          const exists = fs.existsSync(references[i]);
          console.log(`[IMG]   ref[${i}]: ${path.basename(references[i])} (${exists ? 'exists' : 'MISSING'})`);
          if (exists) validRefs.push(references[i]);
        }
        if (validRefs.length > 0) {
          await this.uploadImageReferences(validRefs);

          // ── HARD GATE: Verify reference thumbnails are visible (local preview) ──
          await this.verifyReferenceThumbnails(validRefs.length, validRefs);

          // ── POST-UPLOAD SPINNER-WAIT GATE ──
          // Each upload is already network-confirmed inside uploadImageReferences()
          // via HTTP response listener, so we don't need to re-check CDN URLs here
          // (Higgsfield often keeps the img src as blob: even after backend upload).
          //
          // Just wait for all visible upload spinners to disappear as a secondary
          // sanity check. If spinners never clear, log it but don't hard-fail since
          // the network-level confirmation already happened.
          console.log(`[IMG] Post-upload: waiting for any remaining spinners to clear...`);
          const SETTLE_POLL_MS = 500;
          const SPINNER_TIMEOUT_MS = 20000; // 20s max; network already confirmed
          const startSettle = Date.now();
          let lastSpinnerCount = -1;

          while (Date.now() - startSettle < SPINNER_TIMEOUT_MS) {
            const spinnerInfo = await page.evaluate(() => {
              const spinners = document.querySelectorAll(
                '[role="progressbar"], [class*="spin"], [class*="loader"], [class*="loading"], ' +
                '[class*="progress"], svg[class*="animate-spin"], .animate-spin'
              );
              let visibleSpinners = 0;
              for (const s of spinners) {
                const rect = s.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) visibleSpinners++;
              }
              return { spinners: visibleSpinners };
            });

            if (spinnerInfo.spinners !== lastSpinnerCount) {
              console.log(`[IMG]   spinners=${spinnerInfo.spinners}`);
              lastSpinnerCount = spinnerInfo.spinners;
            }

            if (spinnerInfo.spinners === 0) {
              const elapsed = Math.round((Date.now() - startSettle) / 1000);
              console.log(`[IMG] ✓ Spinners cleared after ${elapsed}s`);
              break;
            }

            await page.waitForTimeout(SETTLE_POLL_MS);
          }

          // ── BELT-AND-SUSPENDERS EXTRA WAIT ──
          // Even after all CDN URLs are present in the DOM, there's an async gap
          // before Higgsfield's React form state registers those references as
          // "attached to form submission". Waiting an extra buffer closes that gap.
          // Tunable via REFERENCE_SETTLE_EXTRA_MS env var (default 30000ms).
          if (REFERENCE_SETTLE_EXTRA_MS > 0) {
            console.log(`[IMG] Extra settle wait: ${REFERENCE_SETTLE_EXTRA_MS / 1000}s buffer before Generate (insurance against form-state lag)...`);
            await page.waitForTimeout(REFERENCE_SETTLE_EXTRA_MS);

            // Re-verify the ref slot count didn't drop (React shouldn't unmount
            // slots after upload, but just in case). Use blob/data/http detection
            // since Higgsfield often keeps blob: src even after backend upload.
            const postExtraCheck = await page.evaluate(() => {
              const form = document.querySelector('form.image-form') || document.querySelector('form');
              if (!form) return { filled: 0, total: 0 };
              const slots = form.querySelectorAll('.size-14');
              let filled = 0;
              let total = slots.length;
              for (const slot of slots) {
                const img = slot.querySelector('img');
                if (img && img.src && (img.src.startsWith('blob:') || img.src.startsWith('data:') || img.src.startsWith('http'))) {
                  filled++;
                }
              }
              return { filled, total };
            });
            if (postExtraCheck.filled < validRefs.length) {
              throw new Error(
                `REFERENCE_REGRESSION: After ${REFERENCE_SETTLE_EXTRA_MS / 1000}s extra wait, only ${postExtraCheck.filled}/${validRefs.length} reference slots still filled. Slot may have been removed.`
              );
            }
            console.log(`[IMG] ✓ Post-extra-wait verification passed (${postExtraCheck.filled}/${validRefs.length} slots still filled)`);
          }
        } else {
          console.warn('[IMG] All reference files missing — proceeding without references');
        }
      } else {
        console.log('[IMG] No references provided for this generation');
      }

      // Set aspect ratio — dynamic, driven by caller (portraits=1:1, scenes=project aspect).
      //
      // Hardening rationale: a prior run produced mixed aspects (9:16, 9:16, 16:9)
      // for 3 consecutive location gens when the project was set to 9:16. Root cause
      // hypotheses: (a) React-controlled <select> where selectOption fires the native
      // change event but the component's internal state doesn't always accept it,
      // (b) Higgsfield re-rendering the select on reference-image attach and
      // resetting to the default, (c) the hidden <select> visible to Playwright not
      // being the one actually wired to generation.
      //
      // Fix: select → verify value → if mismatch, dispatch React-friendly events
      // and retry up to 3 times. Log the final DOM value so we can audit in
      // post-mortem if an unexpected aspect still slips through.
      console.log(`[IMG] Setting aspect ratio to ${_aspect}...`);
      const aspectSelectIdx = sel.aspectRatioSelectIndex || 0;
      let aspectSetOk = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        const aspectSelects = await page.$$(sel.aspectRatioSelect);
        const target = aspectSelects[aspectSelectIdx];
        if (!target) {
          console.warn(`[IMG] No <select> found at index ${aspectSelectIdx} for aspect ratio (attempt ${attempt})`);
          break;
        }
        try {
          await target.selectOption(_aspect);
        } catch (e) {
          console.warn(`[IMG] selectOption failed on attempt ${attempt}: ${e.message}`);
        }
        await page.waitForTimeout(300);
        // Read back the DOM value to verify React accepted the change
        const actualValue = await target.evaluate((el) => el.value).catch(() => null);
        if (actualValue === _aspect) {
          console.log(`[IMG] Aspect ratio confirmed ${_aspect} (attempt ${attempt})`);
          aspectSetOk = true;
          break;
        }
        console.warn(`[IMG] Aspect mismatch after attempt ${attempt}: wanted ${_aspect}, got ${actualValue}. Retrying with React-friendly events…`);
        // Dispatch both input+change events so React picks up the value.
        // Some controlled selects need the value-setter called on the prototype.
        await target.evaluate((el, val) => {
          const setter = Object.getOwnPropertyDescriptor(
            window.HTMLSelectElement.prototype, 'value'
          )?.set;
          if (setter) setter.call(el, val);
          else el.value = val;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }, _aspect).catch(() => {});
        await page.waitForTimeout(400);
        const afterDispatch = await target.evaluate((el) => el.value).catch(() => null);
        if (afterDispatch === _aspect) {
          console.log(`[IMG] Aspect ratio confirmed ${_aspect} via event dispatch (attempt ${attempt})`);
          aspectSetOk = true;
          break;
        }
      }
      if (!aspectSetOk) {
        console.warn(`[IMG] WARNING: aspect ratio ${_aspect} could not be confirmed on <select>. Higgsfield may use its default — generation will proceed but output aspect may not match.`);
      }

      // Set resolution to 2K
      console.log('[IMG] Setting resolution to 2K...');
      const resSelects = await page.$$(sel.resolutionSelect);
      if (resSelects[sel.resolutionSelectIndex || 1]) {
        await resSelects[sel.resolutionSelectIndex || 1].selectOption(sel.resolutionValue);
        await page.waitForTimeout(300);
      }

      // Toggle Unlimited mode based on throttle state
      if (useUnlimited) {
        console.log('[IMG] Enabling Unlimited mode...');
        await this.enableUnlimited();
      } else {
        console.log('[IMG] Using credits (Unlimited OFF)...');
        await this.disableUnlimited();
      }

      // Disable "Extra free" toggle — generates lower-quality bonus images we don't want
      console.log('[IMG] Disabling Extra free generations...');
      await this.disableExtraFree();

      // Enter prompt into contenteditable div
      console.log('[IMG] Entering prompt...');

      // Safety: dismiss any lingering tooltip/overlay from toggle clicks
      // (the "Unlimited runs go to the standard queue" popup blocks pointer events)
      await page.evaluate(() => {
        const overlays = document.querySelectorAll('[data-overlay-container="true"]');
        overlays.forEach(o => { o.style.display = 'none'; });
      });
      await page.waitForTimeout(200);

      const promptEl = await page.$(sel.promptInput) || await page.$(sel.promptInputFallback);
      if (!promptEl) throw new Error('Could not find prompt input element');

      // ── DISABLE GENERATE BUTTON during typing to prevent mis-click generations ──
      // Stray clicks (overlay dismissal, reference uploads) can accidentally hit
      // the GENERATE button while the prompt is being typed, burning credits on
      // a half-typed prompt. Disable the button before typing, re-enable before
      // our intentional click.
      await page.evaluate(() => {
        const btns = document.querySelectorAll('button[type="submit"], button');
        for (const b of btns) {
          const text = (b.textContent || '').trim().toLowerCase();
          if ((text.includes('generate') || b.type === 'submit') && b.getBoundingClientRect().width > 0) {
            b.disabled = true;
            b.dataset._pipelineDisabled = '1';
          }
        }
      });
      console.log('[IMG] Generate button disabled during prompt typing');

      // Clear existing content and type new prompt with proper settling delays
      await promptEl.click({ force: true });
      await page.waitForTimeout(500); // wait for focus to register
      await page.keyboard.press('Control+A');
      await page.waitForTimeout(150);
      await page.keyboard.press('Backspace');
      await page.waitForTimeout(300);

      // ── SEGMENTED TYPING: detect @element references and use autocomplete ──
      // Reuses parsePromptSegments from kling-automation (same Higgsfield UI).
      const { parsePromptSegments } = require('./kling-automation');
      const segments = parsePromptSegments(prompt);
      const hasAtRef = segments.some(s => s && s.at);

      if (hasAtRef) {
        console.log(`[IMG] Prompt contains @element reference(s) — using autocomplete typing`);
        for (const seg of segments) {
          if (typeof seg === 'string') {
            await page.keyboard.type(seg, { delay: 25 });
          } else if (seg && seg.at) {
            const name = seg.at.toLowerCase().replace(/^@+/, '');
            console.log(`[IMG] Typing @mention: "@${name}" (slow autocomplete)`);

            // Ensure @ follows whitespace (autocomplete only triggers after space/newline)
            const lastChar = await page.evaluate(() => {
              const tb = document.querySelector('[role="textbox"][contenteditable="true"]');
              const text = tb ? (tb.innerText || tb.textContent || '') : '';
              return text.slice(-1);
            }).catch(() => '');
            if (lastChar && lastChar !== ' ' && lastChar !== '\n') {
              await page.keyboard.type(' ');
              await page.waitForTimeout(50);
            }

            // Type @ + full name slowly for autocomplete to resolve
            await page.keyboard.type('@', { delay: 0 });
            await page.waitForTimeout(400);
            await page.keyboard.type(name, { delay: 80 });
            await page.waitForTimeout(1500);

            // Check for autocomplete dropdown
            const dropdownInfo = await page.evaluate(() => {
              const options = document.querySelectorAll('[role="option"]');
              const visibleOptions = [...(options || [])].filter(o => o.getBoundingClientRect().width > 0);
              return {
                found: visibleOptions.length > 0,
                optionCount: visibleOptions.length,
                firstOptionText: visibleOptions[0]?.textContent?.trim()?.slice(0, 50) || '',
              };
            }).catch(() => ({ found: false, optionCount: 0 }));

            if (dropdownInfo.found) {
              await page.keyboard.press('Enter');
              await page.waitForTimeout(300);
              console.log(`[IMG] @mention resolved: @${name} → "${dropdownInfo.firstOptionText}"`);
            } else {
              // Retry with longer wait
              console.log(`[IMG] No dropdown for "@${name}" — retrying...`);
              await page.waitForTimeout(2000);
              await page.keyboard.press('Enter');
              await page.waitForTimeout(300);
            }
          }
        }
        await page.waitForTimeout(800);
      } else {
        // No @element references — simple fast typing
        // 25ms delay — slow enough to avoid React contenteditable dropping keystrokes
        await page.keyboard.type(prompt, { delay: 25 });
        await page.waitForTimeout(800);
      }

      // Verify the prompt was typed — whitespace-tolerant comparison
      // (contenteditable divs normalize whitespace, so strict equality always fails)
      const typedPrompt = await promptEl.evaluate(el => (el.textContent || el.innerText || '').trim());
      const stripWs = s => s.replace(/\s+/g, '');
      const typedStripped = stripWs(typedPrompt);
      const expectedStripped = stripWs(prompt.trim());
      const diffChars = Math.abs(typedStripped.length - expectedStripped.length);
      const acceptableDiff = Math.max(5, expectedStripped.length * 0.05);

      if (typedStripped === expectedStripped) {
        console.log(`[IMG] ✓ Prompt typed correctly (${typedPrompt.length} chars, whitespace-normalized match)`);
      } else if (diffChars <= acceptableDiff) {
        console.warn(`[IMG] ⚠ Prompt typed with ${diffChars}-char diff (threshold ${Math.round(acceptableDiff)}): expected ${expectedStripped.length} chars, got ${typedStripped.length}`);
        if (typedStripped.length < expectedStripped.length) {
          console.warn(`[IMG]   TRUNCATED — last 40 chars expected: "...${expectedStripped.slice(-40)}"`);
          console.warn(`[IMG]   TRUNCATED — last 40 chars got:      "...${typedStripped.slice(-40)}"`);
        }
      } else {
        console.warn(`[IMG] ⚠ Significant prompt mismatch — expected ~${expectedStripped.length}, got ${typedStripped.length} (diff=${diffChars}). Retyping...`);
        await promptEl.click();
        await page.waitForTimeout(500);
        await page.keyboard.press('Control+A');
        await page.waitForTimeout(150);
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(300);
        await page.keyboard.type(prompt, { delay: 50 });
        await page.waitForTimeout(800);
      }

      // ── PRE-GENERATE GATE ──
      // Verify no generation is already in-flight (from a mis-click during typing)
      // and that the prompt box still contains the intended prompt.
      const preGenCheck = await page.evaluate(() => {
        // Check for any "Generating" tiles that appeared while we were typing
        const tiles = document.querySelectorAll('[class*="tile"], [class*="card"], [class*="item"]');
        let generatingCount = 0;
        for (const t of tiles) {
          const text = (t.textContent || '').toLowerCase();
          if (text.includes('generating') && t.getBoundingClientRect().width > 0) generatingCount++;
        }
        // Also check the prompt box content
        const tb = document.querySelector('[role="textbox"][contenteditable="true"]');
        const currentPrompt = tb ? (tb.textContent || tb.innerText || '').trim() : '';
        return { generatingCount, currentPromptLength: currentPrompt.length };
      }).catch(() => ({ generatingCount: 0, currentPromptLength: 0 }));

      if (preGenCheck.generatingCount > 0) {
        console.warn(`[IMG] PRE-GEN GATE: ${preGenCheck.generatingCount} generation(s) already in-flight (mis-click?) — waiting for completion before proceeding`);
        // A mis-click already triggered a gen. Wait for it to finish, then
        // check if the result matches our prompt. If not, we'll need to re-submit.
        await page.waitForTimeout(5000);
      }

      // Final prompt verification: re-read the textbox and compare to intended prompt
      const finalPromptCheck = await page.evaluate(() => {
        const tb = document.querySelector('[role="textbox"][contenteditable="true"]');
        return tb ? (tb.textContent || tb.innerText || '').trim() : '';
      }).catch(() => '');

      const finalStripped = finalPromptCheck.replace(/\s+/g, '');
      const intentStripped = prompt.trim().replace(/\s+/g, '');
      const finalDiff = Math.abs(finalStripped.length - intentStripped.length);

      if (finalDiff > Math.max(10, intentStripped.length * 0.1)) {
        console.warn(`[IMG] PRE-GEN GATE: Prompt changed since typing (diff=${finalDiff} chars) — retyping before Generate`);
        const pe = await page.$(sel.promptInput) || await page.$(sel.promptInputFallback);
        if (pe) {
          await pe.click({ force: true });
          await page.waitForTimeout(500);
          await page.keyboard.press('Control+A');
          await page.waitForTimeout(150);
          await page.keyboard.press('Backspace');
          await page.waitForTimeout(300);
          await page.keyboard.type(prompt, { delay: 25 });
          await page.waitForTimeout(800);
          console.log('[IMG] PRE-GEN GATE: Prompt retyped successfully');
        }
      } else {
        console.log(`[IMG] PRE-GEN GATE: Prompt verified (${finalStripped.length} chars) — ready to Generate`);
      }

      // ── RE-ENABLE GENERATE BUTTON — typing is done, ready for intentional click ──
      await page.evaluate(() => {
        const btns = document.querySelectorAll('button');
        for (const b of btns) {
          if (b.dataset._pipelineDisabled === '1') {
            b.disabled = false;
            delete b.dataset._pipelineDisabled;
          }
        }
      });
      console.log('[IMG] Generate button re-enabled — ready for intentional click');
      await page.waitForTimeout(300); // let React reconcile the disabled state

      // Set up job UUID interceptor BEFORE clicking Generate
      const jobIdPromise = this._interceptJobId();

      // Click Generate (submit button — NOT the Unlimited toggle wrapper)
      console.log('[IMG] Submitting generation...');
      const genBtn = await page.$(sel.generateButton) || await page.$(sel.generateButtonFallback);
      if (!genBtn) throw new Error('Could not find Generate button');

      // Parse credit cost from button text (e.g. "GENERATE ✦ 2" → 2.0)
      let creditCost = null;
      try {
        const btnText = await genBtn.textContent();
        if (btnText) {
          const costMatch = btnText.match(/([\d,.]+)\s*$/);
          if (costMatch) {
            creditCost = parseFloat(costMatch[1].replace(/,/g, ''));
            if (isNaN(creditCost)) creditCost = null;
          }
        }
        // Unlimited mode = 0 credits
        if (creditCost === null && useUnlimited && !this.throttled) {
          creditCost = 0;
        }
        console.log(`[IMG] Generate button cost: ${creditCost ?? 'unknown'} credits`);
      } catch (_) { /* non-critical */ }

      try {
        await genBtn.click({ timeout: 5000 });
      } catch (clickErr) {
        // If normal click fails (overlay interception), try force click
        console.warn('[IMG] Generate button click blocked, retrying with force...');
        await this._dismissPreviewOverlay();
        const retryBtn = await page.$(sel.generateButton) || await page.$(sel.generateButtonFallback);
        if (retryBtn) {
          await retryBtn.click({ force: true, timeout: 10000 });
        } else {
          throw new Error('Could not click Generate button after overlay dismissal');
        }
      }

      // Notify caller that Generate was clicked (credits are now committed)
      if (typeof onGenClicked === 'function') {
        try { onGenClicked(creditCost); } catch (_) {}
      }

      // Wait for generation — API job tracking (primary) + CDN diffing (fallback)
      console.log('[IMG] Waiting for generation...');
      const detectedUrl = await this.waitForGeneration('image', IMAGE_GEN_TIMEOUT_MS, prompt, jobIdPromise);
      this._lastDetectedUrl = detectedUrl; // Save for error recovery

      // Download the result using the detected URL (avoids grabbing wrong image from history)
      console.log('[IMG] Downloading result...');
      const genMeta = await this.downloadLatestResult(outputPath, 'image', detectedUrl, prompt, referenceCdnUrl);

      // Generation succeeded — reset throttle flag so next generation tries Unlimited first
      if (this.throttled) {
        console.log('[IMG] Generation succeeded — resetting throttle flag');
        this.throttled = false;
      }

      // Attach generation context for traceability
      genMeta.referencesUsed = references;
      genMeta.generationDurationMs = Date.now() - genStartTime;

      await this.saveSession();
      console.log(`[IMG] Saved: ${outputPath} (${genMeta.generationDurationMs}ms, ${references.length} refs)`);
      return genMeta;

    } catch (err) {
      if (err.message.includes('SESSION_EXPIRED')) throw err;

      // Attach CDN URL for recovery (before any re-throw)
      if (this._lastDetectedUrl) {
        err.detectedCdnUrl = this._lastDetectedUrl;
      }

      // ── Last-chance recovery: if the job timed out, the image may have
      // finished on Higgsfield's servers moments after our deadline expired.
      // Wait 30s, then scan the Asset library for a prompt match.
      // This avoids requiring a full restart just to recover a slow generation.
      const isTimeout = err.message.includes('timed out');
      const isCancelled = this.cancelled || (err.message.includes('Target') && err.message.includes('closed'));

      if (isTimeout && !isCancelled && prompt) {
        console.log('[IMG] ══════════════════════════════════════════════════════');
        console.log('[IMG] Job timed out — starting last-chance recovery (30s grace + Asset library scan)');
        console.log('[IMG] ══════════════════════════════════════════════════════');
        try {
          // Grace period: the job may be completing right now on Higgsfield's side.
          // 30s gives it time to finish and appear in the Asset library grid.
          await this.page.waitForTimeout(30000);

          const recovered = await this.recoverTimedOutImage(prompt, outputPath, {
            minSimilarity: 75,
            maxTilesToCheck: 8,
            timeoutMs: 60000, // 60s budget for the scan itself
          });

          if (recovered) {
            console.log(`[IMG] ✓ LAST-CHANCE RECOVERY SUCCESS — found image in Asset library (uuid=${recovered.assetUuid}, similarity=${recovered.similarity}%)`);
            // Reset throttle flag if it was set — the gen DID complete, just slowly
            if (this.throttled) {
              console.log('[IMG] Resetting throttle flag — generation completed (late but successful)');
              this.throttled = false;
            }
            // Return genMeta-compatible object so the caller treats it as a normal success
            return {
              model: 'nano-banana-pro',
              sourceGenId: recovered.sourceGenId || recovered.assetUuid,
              cdnUrl: recovered.cdnUrl || null,
              recovered: true,
              generationDurationMs: Date.now() - genStartTime,
            };
          }
          // Recovery found no match — clear detectedCdnUrl so the orchestrator
          // does NOT save a stale/wrong URL for this asset.  Without this, the
          // URL from _lastDetectedUrl (set earlier) would persist on the error
          // and get written to DB, causing the wrong portrait to be downloaded
          // on the next restart.
          delete err.detectedCdnUrl;
          console.warn('[IMG] Last-chance recovery found no match — cleared detectedCdnUrl, throwing original timeout error');
        } catch (recoveryErr) {
          delete err.detectedCdnUrl;
          console.warn(`[IMG] Last-chance recovery failed: ${recoveryErr.message} — cleared detectedCdnUrl, throwing original timeout error`);
        }
      }

      // ── NSFW REJECTION: propagate immediately (no retry — same prompt will fail again) ──
      if (err.nsfwRejected) {
        console.error(`[IMG] NSFW rejection — character description must be rewritten before retrying`);
        throw err;
      }

      // ── SERVER-SIDE FAILURE: auto-retry (credits refunded) ──
      // Higgsfield sometimes fails with "Failed — Credits refunded". Since there's
      // no cost, retry immediately with a fresh context instead of waiting 450+s
      // polling for something that will never appear.
      if (err.serverFailed && err.retryable && serverRetries < MAX_SERVER_RETRIES) {
        serverRetries++;
        console.warn(`[IMG] ══════════════════════════════════════════════════════`);
        console.warn(`[IMG] Server-side failure (credits refunded) — auto-retry ${serverRetries}/${MAX_SERVER_RETRIES}`);
        console.warn(`[IMG] ══════════════════════════════════════════════════════`);
        // Fresh context to avoid stale state from the failed generation
        try {
          await this.recreateContext();
        } catch (ctxErr) {
          console.warn(`[IMG] Context recreate failed on retry: ${ctxErr.message}`);
        }
        continue; // re-enter the while loop → full generation flow again
      }

      console.error(`[IMG] Error: ${err.message}`);
      throw err;
    }

    } // end while (server retry loop)
  }

  // ══════════════════════════════════════════════════════════
  // VIDEO GENERATION — Google Veo 3.1 Lite
  // ══════════════════════════════════════════════════════════

  async generateVideo({ startFramePath, animationPrompt, outputPath, duration = 8, audioOn = true, aspectRatio = '16:9' }) {
    // Reset per-call state — prevent previous generation's CDN URL from bleeding into errors
    this._lastDetectedUrl = null;

    await this.ensureBrowser();
    const sel = this.selectors.videoGeneration;
    let page = this.page;
    // Normalize aspect ratio — Veo 3.1 Lite reliably supports these two
    const _aspect = ['16:9', '9:16'].includes(aspectRatio) ? aspectRatio : '16:9';

    try {
      // Navigate to video creation page with failsafe
      await this._navigateWithFailsafe('video', sel);

      // Close any popup overlays
      const closeBtn = await page.$('button:has-text("×"), [aria-label="Close"]');
      if (closeBtn) {
        await closeBtn.click().catch(() => {});
        await page.waitForTimeout(500);
      }

      // Check login
      if (!(await this.isLoggedIn())) {
        throw new Error('SESSION_EXPIRED: Please log into Higgsfield AI in the browser, then click Resume.');
      }

      // Select Veo 3.1 Lite model
      console.log('[VID] Selecting Google Veo 3.1 Lite model...');
      await this.selectVideoModel(sel);

      // Clear any existing start frame from previous generation.
      // NOTE: clearVideoStartFrame() may recreate the entire browser context
      // (the only reliable way to nuke React state). After this call,
      // this.page is a NEW page object — must refresh our local `page` variable.
      console.log('[VID] Clearing any existing start frame...');
      await this.clearVideoStartFrame();
      page = this.page; // Refresh page reference after potential context recreate

      // ── AD DISMISSAL with patience ──
      // Higgsfield's ads (e.g. "Get 7-Day Unlimited Seedance", "Soul Cinema",
      // promo banners) appear ASYNCHRONOUSLY 1-3 seconds after page load.
      // If we proceed too fast, an ad pops up MID-UPLOAD and clicks land wrong,
      // navigating us off the Veo page.
      //
      // Strategy: give ads time to appear, dismiss them, then wait again to
      // confirm no new ads. Repeat up to 3 rounds.

      // Wait for initial ad to render (ads often fade in 1-2s after load)
      console.log('[VID] Waiting 3s for any ads to render before dismissing...');
      await page.waitForTimeout(3000);

      // Round 1: dismiss
      try {
        await page.keyboard.press('Escape');
        await page.waitForTimeout(400);
      } catch (_) {}
      await this._dismissPromoAd();

      // Round 2: wait for any LATE-arriving ads, then dismiss again
      await page.waitForTimeout(2500);
      await this._dismissPromoAd();

      // Round 3: final check with longer wait for any stragglers
      await page.waitForTimeout(2000);
      await this._dismissPromoAd();

      // Final settle — let the page DOM stabilize before we start clicking
      await page.waitForTimeout(1500);
      console.log('[VID] Ad dismissal complete, proceeding to upload');

      // Upload start frame image with hard gate verification
      // CRITICAL: Must use filechooser interception — setInputFiles() bypasses React state
      // (same root cause as reference upload failures: DOM shows preview but form state empty)
      if (startFramePath && fs.existsSync(startFramePath)) {
        console.log('[VID] Uploading start frame...');

        // ── DIAGNOSTIC: Find all upload area candidates and log them ──
        const candidates = await page.evaluate(() => {
          const results = [];
          // Find all labels that contain a file input
          document.querySelectorAll('label').forEach((label, i) => {
            const input = label.querySelector('input[type="file"]');
            if (input) {
              const rect = label.getBoundingClientRect();
              results.push({
                kind: 'label-with-input',
                idx: i,
                x: Math.round(rect.x),
                y: Math.round(rect.y),
                w: Math.round(rect.width),
                h: Math.round(rect.height),
                visible: rect.width > 0 && rect.height > 0,
                text: (label.textContent || '').trim().slice(0, 60),
              });
            }
          });
          // Also find divs that look like upload zones (have file input as child)
          document.querySelectorAll('div').forEach((div, i) => {
            const directInput = Array.from(div.children).find(c => c.tagName === 'INPUT' && c.type === 'file');
            if (directInput) {
              const rect = div.getBoundingClientRect();
              if (rect.width > 50 && rect.height > 30) {
                results.push({
                  kind: 'div-with-input-child',
                  idx: i,
                  x: Math.round(rect.x),
                  y: Math.round(rect.y),
                  w: Math.round(rect.width),
                  h: Math.round(rect.height),
                  text: (div.textContent || '').trim().slice(0, 60),
                });
              }
            }
          });
          return results;
        });
        console.log(`[VID] Upload area candidates: ${JSON.stringify(candidates)}`);

        // Pick the FIRST visible candidate (start frame slot, leftmost)
        const target = candidates.find(c => c.visible !== false && c.w > 50 && c.h > 30);
        if (!target) {
          throw new Error('REFERENCE_GATE_FAILED: Could not find any visible upload area on page.');
        }
        console.log(`[VID] Target upload area: ${target.kind} at (${target.x}, ${target.y}) ${target.w}x${target.h} text="${target.text}"`);

        let uploaded = false;
        let uploadMethod = '';

        // ── PERSISTENT FILECHOOSER HANDLER ──
        // Catches ANY filechooser event that fires during this upload, regardless
        // of when or how. Prevents OS-native picker dialogs from leaking to the user.
        // Same pattern used in uploadImageReferences() to eliminate race conditions.
        let vidLastFileChooserAt = 0;
        const vidFileChooserHandler = async (chooser) => {
          try {
            console.log(`[VID]   [FC] Filechooser fired — attaching ${path.basename(startFramePath)}`);
            await chooser.setFiles(startFramePath);
            vidLastFileChooserAt = Date.now();
          } catch (e) {
            console.warn(`[VID]   [FC] Handler error: ${e.message.split('\n')[0]}`);
          }
        };
        page.on('filechooser', vidFileChooserHandler);

        // Helper: wait for filechooser to fire after our click
        const fcAtBeforeClick = vidLastFileChooserAt;
        const waitForVidFcFire = async (timeoutMs) => {
          const startWait = Date.now();
          while (Date.now() - startWait < timeoutMs) {
            if (vidLastFileChooserAt > fcAtBeforeClick) return true;
            await page.waitForTimeout(200);
          }
          return false;
        };

        // ── PRIMARY: Real mouse click at center of the upload area ──
        // Uses page.mouse.click() which dispatches a TRUSTED click event.
        const clickX = target.x + target.w / 2;
        const clickY = target.y + target.h / 2;

        try {
          console.log(`[VID] Real mouse click at (${Math.round(clickX)}, ${Math.round(clickY)})...`);
          await page.mouse.move(clickX, clickY);
          await page.waitForTimeout(150);
          await page.mouse.click(clickX, clickY);

          if (await waitForVidFcFire(12000)) {
            uploadMethod = 'real mouse click → persistent handler';
            uploaded = true;
          }
        } catch (e) {
          console.warn(`[VID] Real mouse click failed: ${e.message.split('\n')[0]}`);
        }

        // ── FALLBACK 1: Locator-based click (Playwright actionability) ──
        if (!uploaded) {
          try {
            console.log('[VID] Trying locator-based click...');
            const locator = page.locator('label:has(input[type="file"])').first();
            await locator.click();
            if (await waitForVidFcFire(10000)) {
              uploadMethod = 'locator click → persistent handler';
              uploaded = true;
            }
          } catch (e) {
            console.warn(`[VID] Locator click failed: ${e.message.split('\n')[0]}`);
          }
        }

        // ── FALLBACK 2: Direct input click ──
        if (!uploaded) {
          try {
            console.log('[VID] Trying direct input click...');
            const fileInputs = await page.$$(sel.startFrameFileInput);
            const fileInput = fileInputs[0];
            if (fileInput) {
              await fileInput.evaluate(el => el.click());
              if (await waitForVidFcFire(8000)) {
                uploadMethod = 'input.click() → persistent handler';
                uploaded = true;
              }
            }
          } catch (e) {
            console.warn(`[VID] Direct input click failed: ${e.message.split('\n')[0]}`);
          }
        }

        // Remove persistent handler now that upload attempt is complete.
        // If an OS picker still fires after this (unlikely), the bounty is lost —
        // but at this point the upload phase is done either way.
        page.off('filechooser', vidFileChooserHandler);

        if (!uploaded) {
          throw new Error('REFERENCE_GATE_FAILED: Could not upload start frame — all approaches failed.');
        }
        console.log(`[VID] Start frame uploaded via ${uploadMethod} — waiting for preview...`);

        // ── BROADER GATE: Wait up to 8 seconds for preview to render ──
        // React component may take a moment to render the preview.
        // Check for ANY indicator: blob/data URL img, http img near upload area,
        // or any new img element on the page.
        let frameVisible = false;
        let detectedSrc = null;
        for (let attempt = 0; attempt < 16; attempt++) {
          const result = await page.evaluate(() => {
            // Check 1: blob:/data: previews (most common)
            const blobPreviews = document.querySelectorAll('img[src^="blob:"], img[src^="data:"], video[src^="blob:"]');
            if (blobPreviews.length > 0) {
              return { found: true, count: blobPreviews.length, src: blobPreviews[0].src.slice(0, 80), kind: 'blob' };
            }
            // Check 2: any img tag inside the upload zone area (label/div containing file input)
            const labels = document.querySelectorAll('label, div');
            for (const el of labels) {
              if (el.querySelector('input[type="file"]')) {
                const img = el.querySelector('img');
                if (img && img.src) {
                  return { found: true, count: 1, src: img.src.slice(0, 80), kind: 'inside-upload-zone' };
                }
              }
            }
            return { found: false, count: 0 };
          });
          if (result.found) {
            frameVisible = true;
            detectedSrc = result.src;
            console.log(`[GATE] ✓ Start frame visible after ${(attempt + 1) * 500}ms — kind=${result.kind} src=${result.src}`);
            break;
          }
          await page.waitForTimeout(500);
        }

        if (!frameVisible) {
          // Final diagnostic: dump what's actually on the page
          const debug = await page.evaluate(() => {
            const allImgs = Array.from(document.querySelectorAll('img')).slice(0, 20).map(img => ({
              src: (img.src || '').slice(0, 60),
              w: Math.round(img.getBoundingClientRect().width),
              h: Math.round(img.getBoundingClientRect().height),
            }));
            const fileInputs = Array.from(document.querySelectorAll('input[type="file"]')).map(fi => ({
              hasFiles: fi.files && fi.files.length > 0,
              fileCount: fi.files ? fi.files.length : 0,
              fileName: fi.files && fi.files[0] ? fi.files[0].name : null,
            }));
            return { imgCount: document.querySelectorAll('img').length, sampleImgs: allImgs, fileInputs };
          });
          console.warn(`[GATE] Diagnostic — imgs on page: ${debug.imgCount}, file inputs: ${JSON.stringify(debug.fileInputs)}`);
          console.warn(`[GATE] Sample imgs: ${JSON.stringify(debug.sampleImgs.slice(0, 5))}`);
          throw new Error('REFERENCE_GATE_FAILED: Start frame not visible in UI after upload. Aborting video generation.');
        }

        // ── STRICT UPLOAD SETTLE GATE ──
        // blob: thumbnail = LOCAL preview only. The actual file is still uploading
        // to Higgsfield's backend. Clicking Generate before that completes means
        // the video generates WITHOUT the start frame (random output).
        //
        // STRICT criteria: the preview's src must transition from blob:/data: to
        // an https:// CDN URL. That's the only reliable proof the backend has
        // the file. Timeout + extra wait configurable via env vars.
        console.log(`[VID] Waiting for start frame upload to finish on Higgsfield backend (timeout: ${START_FRAME_SETTLE_TIMEOUT_MS / 1000}s)...`);
        const SETTLE_POLL_MS = 500;
        const maxAttempts = Math.ceil(START_FRAME_SETTLE_TIMEOUT_MS / SETTLE_POLL_MS);

        let uploadSettled = false;
        let lastLoggedState = '';
        const startSettle = Date.now();

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          const status = await page.evaluate(() => {
            // Check all visible images — we're looking for the preview src
            const imgs = document.querySelectorAll('img');
            let blobPreview = null;
            let cdnPreview = null;
            for (const img of imgs) {
              const src = img.src || '';
              const rect = img.getBoundingClientRect();
              // Only consider visible previews (not tiny icons)
              if (rect.width < 50 || rect.height < 30) continue;
              if (src.startsWith('blob:') || src.startsWith('data:')) {
                blobPreview = src.slice(0, 60);
              } else if (src.startsWith('https://')) {
                cdnPreview = src.slice(0, 60);
              }
            }

            const spinners = document.querySelectorAll(
              '[role="progressbar"], [class*="spin"], [class*="loader"], [class*="loading"], ' +
              '[class*="progress"], svg[class*="animate-spin"], .animate-spin'
            );
            let visibleSpinners = 0;
            for (const s of spinners) {
              const rect = s.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) visibleSpinners++;
            }

            return { blobPreview, cdnPreview, visibleSpinners };
          });

          // Log progress every 2s or on state change
          const stateKey = `${status.blobPreview ? 'B' : '-'}${status.cdnPreview ? 'C' : '-'}${status.visibleSpinners}`;
          if (stateKey !== lastLoggedState || attempt % 4 === 0) {
            const elapsed = Math.round((Date.now() - startSettle) / 1000);
            console.log(`[VID]   Settle ${elapsed}s: blob=${!!status.blobPreview} cdn=${!!status.cdnPreview} spinners=${status.visibleSpinners}`);
            lastLoggedState = stateKey;
          }

          // STRICT settled: CDN URL detected AND no spinners
          if (status.cdnPreview && status.visibleSpinners === 0) {
            const elapsed = Math.round((Date.now() - startSettle) / 1000);
            console.log(`[VID] ✓ Start frame confirmed on backend (CDN URL: ${status.cdnPreview}) after ${elapsed}s`);
            uploadSettled = true;
            break;
          }

          await page.waitForTimeout(SETTLE_POLL_MS);
        }

        if (!uploadSettled) {
          console.error(`[VID] ⚠ Start frame did NOT settle within ${START_FRAME_SETTLE_TIMEOUT_MS / 1000}s — aborting rather than wasting credits`);
          throw new Error(
            `REFERENCE_GATE_FAILED: Start frame upload did not reach Higgsfield CDN within ${START_FRAME_SETTLE_TIMEOUT_MS / 1000}s. ` +
            `Aborting to prevent video generation without start frame.`
          );
        }

        // ── BELT-AND-SUSPENDERS EXTRA WAIT ──
        // Even after the CDN URL is present in the DOM, there's an async gap before
        // Higgsfield's React form state registers the frame as "attached to submission".
        // Tunable via START_FRAME_SETTLE_EXTRA_MS env var (default 30000ms).
        if (START_FRAME_SETTLE_EXTRA_MS > 0) {
          console.log(`[VID] Extra settle wait: ${START_FRAME_SETTLE_EXTRA_MS / 1000}s buffer before Generate (insurance against form-state lag)...`);
          await page.waitForTimeout(START_FRAME_SETTLE_EXTRA_MS);

          // Re-verify the CDN URL is still present
          const postExtraCheck = await page.evaluate(() => {
            const imgs = document.querySelectorAll('img');
            let cdnPreview = null;
            for (const img of imgs) {
              const src = img.src || '';
              const rect = img.getBoundingClientRect();
              if (rect.width < 50 || rect.height < 30) continue;
              if (src.startsWith('https://')) cdnPreview = src.slice(0, 60);
            }
            return { cdnPreview };
          });
          if (!postExtraCheck.cdnPreview) {
            throw new Error(
              `REFERENCE_REGRESSION: After ${START_FRAME_SETTLE_EXTRA_MS / 1000}s extra wait, start frame CDN URL is no longer visible. Form state may have regressed.`
            );
          }
          console.log(`[VID] ✓ Post-extra-wait verification passed (CDN URL still present)`);
        }
      }

      // ── PAGE STATE GUARD: ensure we're still on Veo 3.1 Lite before typing ──
      // Sometimes a click during start-frame upload or ad dismissal accidentally
      // navigates us away (e.g., to homepage or Motion Control page). Detect this
      // and recover BEFORE attempting to type into a prompt that isn't there.
      const preTypeState = await page.evaluate(() => {
        const url = location.pathname;
        const bodyText = (document.body.innerText || '').toLowerCase();
        // STRICT markers — only phrases unique to OTHER pages, not nav tab text
        const wrongMarkers = [
          'generate ai videos from', // homepage
          'turn any product into a video ad', // marketing studio
          'describe what happens in the ad', // marketing studio
          'kling 3.0 motion control', // motion control sub-page content
          'add motion to copy', // motion control
        ];
        const onWrongPage = wrongMarkers.some(m => bodyText.includes(m));
        const urlOk = /\/create\/video/.test(url) && !/\/create\/edit/.test(url) && !/motion.control/i.test(url);
        return { url, urlOk, onWrongPage, bodyHasPromptTextbox: !!document.querySelector("div[role='textbox']") };
      });

      if (!preTypeState.urlOk || preTypeState.onWrongPage || !preTypeState.bodyHasPromptTextbox) {
        console.warn(`[VID] ⚠ Wrong page before typing — url=${preTypeState.url} urlOk=${preTypeState.urlOk} onWrongPage=${preTypeState.onWrongPage} hasPromptBox=${preTypeState.bodyHasPromptTextbox}`);
        console.warn('[VID] Attempting recovery: Logo → Video → Veo 3.1 Lite...');
        await this._clickHiggsLogo(page);
        await page.waitForTimeout(2000);
        await this.selectVideoModel(sel);
        // After recovery, we've lost our start frame upload — throw to skip this clip
        // (the clip will be marked failed and can be retried via redo-videos.js)
        throw new Error('PAGE_NAVIGATED_AWAY: Got redirected off Veo page before Generate — clip needs redo. Run: node scripts/redo-videos.js all-failed');
      }

      // Enter animation prompt
      console.log('[VID] Entering animation prompt...');
      const promptEl = await page.$(sel.promptInput);
      if (!promptEl) throw new Error('Could not find prompt input');

      // Click to focus, then wait for focus to actually settle before typing
      await promptEl.click();
      await page.waitForTimeout(500); // Wait for focus to register
      await page.keyboard.press('Control+A');
      await page.waitForTimeout(150);
      await page.keyboard.press('Backspace');
      await page.waitForTimeout(300);
      // Slower typing delay (25ms vs 5ms) — random characters in output suggest
      // the editor was dropping/reordering keystrokes at high speed
      await page.keyboard.type(animationPrompt, { delay: 25 });
      await page.waitForTimeout(800);

      // Verify the prompt was typed — tolerant of whitespace normalization.
      // Contenteditable divs normalize whitespace (collapse double spaces, insert
      // <br> for newlines, etc.), so strict equality ALWAYS fails even on a
      // correct typing. We only retry if the character count differs significantly
      // (>5% off), which indicates actual dropped/extra keystrokes.
      const typedText = await promptEl.evaluate(el => (el.textContent || el.innerText || '').trim());
      const expected = animationPrompt.trim();
      // Normalize both: strip all whitespace for comparison
      const normStripped = s => s.replace(/\s+/g, '');
      const typedNorm = normStripped(typedText);
      const expectedNorm = normStripped(expected);
      const lengthDiff = Math.abs(typedNorm.length - expectedNorm.length);
      const tolerancePct = 0.05; // 5%
      const exceedsTolerance = lengthDiff > Math.max(5, expectedNorm.length * tolerancePct);

      if (typedNorm === expectedNorm) {
        console.log(`[VID] ✓ Prompt typed correctly (${typedText.length} chars, whitespace-normalized match)`);
      } else if (!exceedsTolerance) {
        // Minor whitespace/formatting difference — acceptable
        console.log(`[VID] ✓ Prompt typed with minor whitespace diff (${typedText.length} vs ${expected.length} chars, within tolerance)`);
      } else {
        console.warn(`[VID] ⚠ Significant prompt mismatch — expected ~${expectedNorm.length} non-ws chars, got ${typedNorm.length} (diff=${lengthDiff}). Re-typing...`);
        await promptEl.click();
        await page.waitForTimeout(500);
        await page.keyboard.press('Control+A');
        await page.waitForTimeout(150);
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(300);
        await page.keyboard.type(animationPrompt, { delay: 50 });
        await page.waitForTimeout(800);
        const retypedText = await promptEl.evaluate(el => (el.textContent || el.innerText || '').trim());
        const retypedNorm = normStripped(retypedText);
        const retryDiff = Math.abs(retypedNorm.length - expectedNorm.length);
        if (retryDiff > Math.max(5, expectedNorm.length * tolerancePct)) {
          console.warn(`[VID] ⚠ Prompt still mismatched after retry (diff=${retryDiff} chars). Proceeding anyway.`);
        } else {
          console.log('[VID] ✓ Prompt typed correctly on retry');
        }
      }

      // Verify audio is ON
      if (audioOn) {
        console.log('[VID] Verifying audio is ON...');
        const audioCb = await page.$(sel.audioCheckbox);
        if (audioCb) {
          const isChecked = await audioCb.isChecked().catch(() => true);
          if (!isChecked) {
            await audioCb.click();
            await page.waitForTimeout(300);
          }
        }
      }

      // Set duration via button dropdown (options: 4s, 6s, 8s)
      console.log(`[VID] Setting duration to ${duration}s...`);
      await this.setVideoDropdownOption('Duration', `${duration}s`);

      // Set aspect ratio via the underlying native <select>.
      // The dark custom popup in the UI is cosmetic — Higgsfield wraps a real
      // <select> element that accepts selectOption() directly. Confirmed end-to-end
      // in Session 8 DevTools inspection: dispatching input+change events on the
      // hidden select updates both the DOM value and the visible chip text via React.
      // Aspect select is the FIRST <select> on the video page; resolution is second.
      console.log(`[VID] Setting aspect ratio to ${_aspect}...`);
      try {
        const videoSelects = await page.$$('select');
        if (videoSelects[0]) {
          await videoSelects[0].selectOption(_aspect);
          await page.waitForTimeout(300);
        } else {
          console.warn(`[VID] No <select> found for aspect ratio — falling back to button dropdown`);
          await this.setVideoDropdownOption('Ratio', _aspect);
        }
      } catch (e) {
        console.warn(`[VID] Native select failed (${e.message}) — falling back to button dropdown`);
        await this.setVideoDropdownOption('Ratio', _aspect);
      }

      // Set up job UUID interceptor BEFORE clicking Generate
      const jobIdPromise = this._interceptJobId();

      // Click Generate
      console.log('[VID] Submitting generation...');
      const genBtn = await page.$(sel.generateButton);
      if (!genBtn) throw new Error('Could not find Generate button');
      await genBtn.click();

      // Wait for generation — API job tracking (primary) + CDN diffing (fallback)
      console.log('[VID] Waiting for generation...');
      const detectedUrl = await this.waitForGeneration('video', VIDEO_GEN_TIMEOUT_MS, animationPrompt, jobIdPromise);
      this._lastDetectedUrl = detectedUrl; // Save for error recovery

      // Download the result — video uses detectedUrl for future proofing
      console.log('[VID] Downloading result...');
      const genMeta = await this.downloadLatestResult(outputPath, 'video', detectedUrl, animationPrompt);

      await this.saveSession();
      console.log(`[VID] Saved: ${outputPath}`);
      return genMeta;

    } catch (err) {
      if (err.message.includes('SESSION_EXPIRED')) throw err;

      // Attach the detected CDN URL to the error so the orchestrator can save it
      // for retry on restart (generation succeeded but download may have failed)
      if (this._lastDetectedUrl) {
        err.detectedCdnUrl = this._lastDetectedUrl;
      }

      console.error(`[VID] Error: ${err.message}`);
      throw err;
    }
  }

  /**
   * Navigate to Veo 3.1 Lite video creation page using UI clicks.
   *
   * Correct navigation path (per user testing):
   *   1. Click "Video" in the Higgsfield top nav bar → dropdown appears
   *   2. Click "Google Veo 3.1 Lite" in the dropdown
   *
   * When stuck or page is in a bad state:
   *   1. Click the Higgsfield logo to reset to home
   *   2. Then Video → Veo 3.1 Lite
   *
   * This replaces the old approach of using direct URL navigation + model picker,
   * which often failed because the URL didn't always land on the correct page.
   */
  async selectVideoModel(sel) {
    let page = this.page;

    // Dismiss any ads that may be covering the nav. Ads can appear asynchronously
    // (1-3s after page load), so we wait for them to render before dismissing.
    // If we skip this, the nav click can land on an ad and navigate us away.
    try {
      await page.waitForTimeout(2500);
      await this._dismissPromoAd();
      await page.waitForTimeout(1500);
      await this._dismissPromoAd();
      await page.waitForTimeout(800);
    } catch (e) {
      console.warn(`[VID] Ad dismissal in selectVideoModel failed: ${e.message.split('\n')[0]}`);
    }

    // Helper: strict check for "we are on the Veo 3.1 Lite creation page"
    // Rejects edit/motion-control/other pages even if they happen to mention Veo.
    const isOnVeoCreationPage = async () => {
      try {
        const state = await page.evaluate(() => {
          const url = location.pathname;
          // PRIMARY CHECK: URL path. Must be /create/video.
          // Reject /create/edit, /create/motion-control. /create/video/* variations OK.
          const urlOk = /\/create\/video/.test(url) &&
                        !/\/create\/edit/.test(url) &&
                        !/motion.control/i.test(url);

          // Explicit wrong-URL markers (unambiguous)
          const wrongUrlMarkers = [
            '/marketing', '/explore', '/asset', '/chat', '/character',
            '/cinema', '/audio',
          ];
          const onWrongUrl = wrongUrlMarkers.some(m => url.includes(m)) ||
                             /\/create\/edit/.test(url);
          const onHomepage = url === '/' || url === '';

          // Check the ACTIVE TAB in the left sidebar (not all sidebar text —
          // the sidebar shows Create Video / Edit Video / Motion Control as tabs
          // on the Veo page too, so simple text inclusion isn't sufficient).
          // Look for which tab has an "active" class or underline styling.
          let activeTab = '';
          for (const el of document.querySelectorAll('button, a, div[role="tab"], [class*="tab"]')) {
            const text = (el.textContent || '').trim().toLowerCase();
            if (!text) continue;
            if (text.length > 30) continue;
            // Tab text patterns we care about
            if (!['create video', 'edit video', 'motion control'].includes(text)) continue;
            const cls = (el.className || '').toString().toLowerCase();
            const style = window.getComputedStyle(el);
            // "active" typically: has underline, bold, or selected-class
            const isActive = cls.includes('active') || cls.includes('selected') ||
                             el.getAttribute('aria-selected') === 'true' ||
                             el.getAttribute('data-state') === 'active' ||
                             style.borderBottomStyle === 'solid' ||
                             style.textDecorationLine === 'underline' ||
                             parseInt(style.fontWeight, 10) >= 600;
            if (isActive) { activeTab = text; break; }
          }

          // If we can detect an active tab that's NOT "Create Video", we're on wrong sub-page
          const onWrongSubTab = activeTab && activeTab !== 'create video';

          // Look for Veo 3.1 Lite label in the form area (the model display card)
          const form = document.querySelector('form') || document.body;
          const formText = (form.innerText || '').toLowerCase();
          const hasVeoLabel = formText.includes('veo 3.1 lite') || formText.includes('veo 3.1');

          // STRICT body-text wrong-page markers — only phrases UNIQUE to other pages,
          // NOT words like "motion control" or "edit video" that appear as nav tabs
          // on the Veo page itself.
          const wrongPageMarkers = [
            // Marketing studio hero text
            'turn any product into a video ad',
            'describe what happens in the ad',
            'generate across formats',
            // Motion Control page content (not just nav tab)
            'kling 3.0 motion control',
            'add motion to copy',
            'scene control mode',
          ];
          const bodyText = (document.body.innerText || '').toLowerCase();
          const hasWrongMarker = wrongPageMarkers.some(m => bodyText.includes(m));

          const onWrongPage = hasWrongMarker || onWrongUrl || onHomepage || onWrongSubTab;

          return { url, urlOk, hasVeoLabel, onWrongPage, onWrongUrl, onHomepage, activeTab, onWrongSubTab };
        });
        return state;
      } catch (_) {
        return { url: '', urlOk: false, hasVeoLabel: false, onWrongPage: false, onWrongUrl: false, onHomepage: false, activeTab: '', onWrongSubTab: false };
      }
    };

    // Nuclear recovery: tear down context, rebuild fresh, navigate Logo → Video → Veo.
    // Used when we're detected on a wrong page and the normal logo-click recovery
    // can't get us out (e.g., stuck in /marketing-studio, a subscription flow, etc.)
    const nuclearRecovery = async (reason) => {
      console.warn(`[VID] 🚨 Nuclear recovery triggered: ${reason}`);
      try {
        await this.recreateContext();
        // After recreate, this.page is a new page — update our local ref
        const newPage = this.page;
        console.log('[VID] Navigating fresh context to higgsfield.ai home...');
        await newPage.goto('https://higgsfield.ai/', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await newPage.waitForTimeout(3000);
        // Dismiss any ads on the fresh homepage
        await this._dismissPromoAd();
        await newPage.waitForTimeout(2000);
        await this._dismissPromoAd();
        await newPage.waitForTimeout(1500);
        // Now navigate via UI clicks
        await this._clickNavToVeo(newPage);
        await newPage.waitForTimeout(2000);
        console.log('[VID] ✓ Nuclear recovery complete');
      } catch (e) {
        console.error(`[VID] Nuclear recovery failed: ${e.message}`);
        throw e;
      }
    };

    // Wait for page to be interactive
    await page.waitForTimeout(1500);

    // Check if we're already on the right page (quick skip)
    const initialCheck = await isOnVeoCreationPage();
    console.log(`[VID] Page state: url=${initialCheck.url} urlOk=${initialCheck.urlOk} hasVeo=${initialCheck.hasVeoLabel} onWrongPage=${initialCheck.onWrongPage}`);

    if (initialCheck.urlOk && initialCheck.hasVeoLabel && !initialCheck.onWrongPage) {
      const promptEl = await page.$(sel.promptInput || "div[role='textbox']");
      if (promptEl) {
        console.log('[VID] Already on Veo 3.1 Lite creation page');
        return;
      }
    }

    // ── Recovery: FORCE home first if we're on the wrong page ──
    // This handles the case where Higgsfield redirects to /create/edit (Motion Control)
    // or other pages. Logo click resets us cleanly.
    if (initialCheck.onWrongPage || !initialCheck.urlOk) {
      console.log('[VID] Wrong page detected — clicking Higgsfield logo to reset to home...');
      await this._clickHiggsLogo(page);
      await page.waitForTimeout(2000);
    }

    console.log('[VID] Navigating to Veo 3.1 Lite via Video nav → Veo 3.1 Lite...');

    // ── Attempt 1: Click "Video" nav → "Veo 3.1 Lite" in dropdown ──
    let success = await this._clickNavToVeo(page);

    // Verify attempt 1 worked by checking we're actually on Veo page
    if (success) {
      await page.waitForTimeout(1500);
      const check = await isOnVeoCreationPage();
      if (!check.urlOk || check.onWrongPage) {
        console.warn(`[VID] Nav click reported success but we're on wrong page (${check.url}) — will retry`);
        success = false;
      }
    }

    if (!success) {
      // ── Attempt 2: Logo → Video → Veo 3.1 Lite (full reset) ──
      console.log('[VID] Nav attempt 1 failed — full reset via Higgsfield logo...');
      await this._clickHiggsLogo(page);
      await page.waitForTimeout(2000);
      success = await this._clickNavToVeo(page);

      if (success) {
        await page.waitForTimeout(1500);
        const check = await isOnVeoCreationPage();
        if (!check.urlOk || check.onWrongPage) {
          console.warn(`[VID] Attempt 2 landed on wrong page (${check.url})`);
          success = false;
        }
      }
    }

    if (!success) {
      // ── Attempt 3: NUCLEAR RECOVERY — context recreate + fresh nav ──
      // Normal logo-click recovery can fail when Higgsfield's React state
      // is corrupted (stuck in marketing-studio, subscription flow, etc).
      // Tearing down the entire browser context guarantees a clean slate.
      await nuclearRecovery(`Two nav attempts failed on ${initialCheck.url}`);
      page = this.page; // Nuclear recovery creates a new page
      await page.waitForTimeout(1500);

      const nukeCheck = await isOnVeoCreationPage();
      if (nukeCheck.urlOk && nukeCheck.hasVeoLabel && !nukeCheck.onWrongPage) {
        success = true;
        console.log('[VID] ✓ Nuclear recovery landed on Veo page');
      }
    }

    if (!success) {
      // ── Attempt 4: Direct URL as last resort after nuclear ──
      console.log('[VID] Nuclear recovery didn\'t land on Veo — trying direct URL fallback...');
      await page.goto(sel.url || 'https://higgsfield.ai/create/video', {
        waitUntil: 'domcontentloaded', timeout: 20000
      });
      await page.waitForTimeout(3000);

      const check = await isOnVeoCreationPage();
      if (!check.hasVeoLabel || check.onWrongPage) {
        console.log('[VID] Direct URL didn\'t land on Veo — trying model picker...');
        await this._tryModelPicker(page, sel);
      }
    }

    // Final verification
    await page.waitForTimeout(1500);
    const finalCheck = await isOnVeoCreationPage();
    const promptEl = await page.$(sel.promptInput || "div[role='textbox']");

    if (finalCheck.urlOk && finalCheck.hasVeoLabel && !finalCheck.onWrongPage && promptEl) {
      console.log(`[VID] ✓ Veo 3.1 Lite creation page confirmed (${finalCheck.url})`);
    } else if (promptEl && finalCheck.hasVeoLabel && !finalCheck.onWrongPage) {
      console.warn(`[VID] Prompt found and Veo text visible — proceeding (url=${finalCheck.url})`);
    } else {
      throw new Error(
        `MODEL_SELECT_FAILED: Could not navigate to Veo 3.1 Lite. ` +
        `url=${finalCheck.url} urlOk=${finalCheck.urlOk} hasVeo=${finalCheck.hasVeoLabel} wrongPage=${finalCheck.onWrongPage} promptEl=${!!promptEl}. ` +
        `Please click Video → Veo 3.1 Lite manually in the browser, then resume.`
      );
    }
  }

  /**
   * Click "Video" in the top nav, then "Google Veo 3.1 Lite" in the dropdown.
   * Returns true if successful (prompt input appears), false otherwise.
   */
  async _clickNavToVeo(page) {
    try {
      // Find and click "Video" in the nav bar
      // Try multiple selectors — Higgsfield nav structure may vary
      const videoNav = await page.$('nav a:has-text("Video")')
        || await page.$('header a:has-text("Video")')
        || await page.$('a:text-is("Video")')
        || await page.$('[class*="nav"] a:has-text("Video")')
        || await page.$('button:has-text("Video")');

      if (!videoNav) {
        console.warn('[VID] Could not find "Video" nav link');
        return false;
      }

      await videoNav.click();
      await page.waitForTimeout(1500);

      // Now look for "Veo 3.1 Lite" or "Google Veo 3.1 Lite" in the dropdown/submenu
      let veoClicked = false;

      // Strategy 1: Playwright getByText (short timeout)
      try {
        const veoLink = page.getByText('Veo 3.1 Lite', { exact: false }).first();
        await veoLink.click({ timeout: 3000 });
        veoClicked = true;
      } catch (_) { /* fall through */ }

      // Strategy 2: DOM search for any clickable element with the text
      if (!veoClicked) {
        veoClicked = await page.evaluate(() => {
          const els = document.querySelectorAll('a, button, div[role="menuitem"], li, span');
          for (const el of els) {
            const t = el.textContent.trim();
            if (t.includes('Veo 3.1 Lite') && el.offsetHeight > 0) {
              el.click();
              return true;
            }
          }
          return false;
        });
      }

      // Strategy 3: Google Veo category first, then Veo 3.1 Lite
      if (!veoClicked) {
        try {
          const googleVeo = page.getByText('Google Veo', { exact: false }).first();
          await googleVeo.click({ timeout: 3000 });
          await page.waitForTimeout(800);

          const veoLite = page.getByText('Veo 3.1 Lite', { exact: false }).first();
          await veoLite.click({ timeout: 3000 });
          veoClicked = true;
        } catch (_) { /* fall through */ }
      }

      if (!veoClicked) {
        console.warn('[VID] Could not click Veo 3.1 Lite in dropdown');
        return false;
      }

      // Wait for the creation page to load
      await page.waitForTimeout(3000);

      // Verify prompt input appeared (confirms we're on the creation page)
      const promptEl = await page.$("div[role='textbox']") || await page.$('textarea');
      if (promptEl) {
        console.log('[VID] Veo 3.1 Lite creation page loaded via nav click');
        return true;
      }

      console.warn('[VID] Clicked Veo 3.1 Lite but prompt input not found');
      return false;

    } catch (e) {
      console.warn(`[VID] Nav click failed: ${e.message.slice(0, 80)}`);
      return false;
    }
  }

  /**
   * Click the Higgsfield logo to return to the home page.
   * Used as a "reset" when the page is stuck.
   */
  async _clickHiggsLogo(page) {
    console.log('[VID] Clicking Higgsfield logo to reset...');
    const logo = await page.$('a[href="/"] svg')
      || await page.$('a[href="/"] img')
      || await page.$('header a:first-child')
      || await page.$('a[href="/"]')
      || await page.$('[class*="logo"]');

    if (logo) {
      await logo.click();
      await page.waitForTimeout(2000);
    } else {
      // Fallback: navigate to home
      await page.goto('https://higgsfield.ai/', { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(2000);
    }
  }

  /**
   * Fallback: try the on-page model picker (Change button → model list).
   * Used only when UI nav clicks completely failed.
   */
  async _tryModelPicker(page, sel) {
    console.log('[VID] Trying on-page model picker as fallback...');

    // Try "Change" button
    const changeBtn = await page.$('button:has-text("Change")');
    if (changeBtn) {
      await changeBtn.click();
      await page.waitForTimeout(1000);
    } else {
      const modelBtn = await page.$(sel.modelButton || 'button:has-text("Model")');
      if (modelBtn) {
        await modelBtn.click({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(1000);
      }
    }

    // Try clicking Veo 3.1 Lite in whatever picker opened
    try {
      const veoLite = page.getByText('Veo 3.1 Lite', { exact: false }).first();
      await veoLite.click({ timeout: 5000 });
      await page.waitForTimeout(1000);
    } catch (_) {
      // DOM fallback
      await page.evaluate(() => {
        const els = document.querySelectorAll('div, span, button, li, a');
        for (const el of els) {
          if (el.textContent.trim().includes('Veo 3.1 Lite') && el.offsetHeight > 0) {
            el.click();
            return;
          }
        }
      });
    }
  }

  /**
   * Clear any existing start frame from the video generation page.
   * Higgsfield retains the previous start frame between generations.
   * If not cleared, uploading a new one can result in 2 frames being sent.
   *
   * Looks for close/remove/delete buttons near the start frame preview area.
   */
  /**
   * Clear ALL fields on the Veo 3.1 Lite video creation page:
   * - Start frame (left image)
   * - End frame (right image)
   * - Prompt text
   * - All file inputs
   *
   * Higgsfield retains previous generation's data between clips.
   * Must clear everything before each new clip to avoid cross-contamination.
   */
  async clearVideoStartFrame() {
    const page = this.page;
    const sel = this.selectors.videoGeneration;

    try {
      // ── Step 1: Check if there's anything to clear ──
      // If page is already clean (fresh context just created), skip the recreate.
      let needsRecreate = true;
      try {
        const state = await page.evaluate((promptSelector) => {
          const previews = document.querySelectorAll('img[src^="blob:"], img[src^="data:"], video[src^="blob:"]');
          let promptText = '';
          try {
            const p = document.querySelector(promptSelector);
            if (p) promptText = (p.textContent || p.innerText || '').trim();
          } catch (_) {}
          return { previewCount: previews.length, promptText };
        }, sel.promptInput);

        if (state.previewCount === 0 && !state.promptText) {
          console.log('[VID] Page already clean — skipping context recreate');
          needsRecreate = false;
        } else {
          console.log(`[VID] Page dirty: ${state.previewCount} preview(s), prompt=${state.promptText ? `"${state.promptText.slice(0, 40)}..."` : 'empty'}`);
        }
      } catch (e) {
        console.warn(`[VID] State check failed (${e.message.split('\n')[0]}) — recreating context anyway`);
      }

      if (!needsRecreate) return;

      // ── Step 2: Recreate browser context (the only reliable clear) ──
      // Tear down the page + context, build a new one with the same cookies.
      // This guarantees a fresh React tree, no localStorage, no in-memory state.
      console.log('[VID] Recreating browser context for guaranteed clean state...');
      await this.recreateContext();

      // ── Step 3: Navigate to Veo 3.1 Lite on the fresh page ──
      // Go to higgsfield.ai first so the Video nav appears, then click through.
      console.log('[VID] Navigating to Higgsfield home on fresh context...');
      await this.page.goto('https://higgsfield.ai/', { waitUntil: 'domcontentloaded', timeout: 30000 });

      // ── Wait for ads to render on the fresh homepage, then dismiss them ──
      // Ads appear asynchronously 1-3s after page load. If selectVideoModel
      // tries to click "Video" nav while an ad is covering it, click hits the
      // ad and navigates us off page. Must dismiss BEFORE clicking.
      console.log('[VID] Waiting 3s for homepage ads to render...');
      await this.page.waitForTimeout(3000);
      await this._dismissPromoAd();
      await this.page.waitForTimeout(2000);
      await this._dismissPromoAd();
      await this.page.waitForTimeout(1500);
      console.log('[VID] Homepage ad dismissal complete');

      // Use selectVideoModel which handles Logo → Video → Veo 3.1 Lite
      console.log('[VID] Selecting Veo 3.1 Lite on fresh context...');
      await this.selectVideoModel(sel);
      await this.page.waitForTimeout(1500);

      // Dismiss any ads that appeared on the Veo page after navigation
      await this._dismissPromoAd();
      await this.page.waitForTimeout(1500);

      // ── Step 4: Verify the new page is clean ──
      const afterState = await this.page.evaluate((promptSelector) => {
        const previews = document.querySelectorAll('img[src^="blob:"], img[src^="data:"], video[src^="blob:"]');
        let promptText = '';
        try {
          const p = document.querySelector(promptSelector);
          if (p) promptText = (p.textContent || p.innerText || '').trim();
        } catch (_) {}
        return { previewCount: previews.length, promptText };
      }, sel.promptInput);

      if (afterState.previewCount > 0 || afterState.promptText) {
        throw new Error(`CLEAR_FAILED: Fresh context still shows ${afterState.previewCount} preview(s), prompt="${afterState.promptText.slice(0, 40)}". The state is being restored from cookies/server.`);
      }
      console.log('[VID] ✓ Fresh context confirmed clean (0 previews, empty prompt)');
    } catch (e) {
      console.warn(`[VID] Error during clearVideoStartFrame: ${e.message}`);
      throw e; // Re-throw — can't proceed without a clean page
    }
  }

  // ══════════════════════════════════════════════════════════
  // IMAGE REFERENCE UPLOAD HELPERS
  // ══════════════════════════════════════════════════════════

  /**
   * Wait for reference slot file inputs to appear in the DOM.
   * After page navigation or preview overlay dismissal, React needs time
   * to render the generation bar including reference slots.
   * Polls for up to 15 seconds, then tries clicking the prompt area
   * (which may trigger lazy rendering of the reference bar).
   */
  async _waitForReferenceSlots() {
    console.log('[REF] Waiting for reference slots to appear in DOM...');
    const page = this.page;
    const sel = this.selectors.imageGeneration;

    const findSlots = async () => {
      // Try primary selector
      let inputs = await page.$$(sel.imageReferenceFileInputs);
      if (inputs.length > 0) return inputs.length;

      // Try fallback filtered by size
      if (sel._imageReferenceFileInputsFallback) {
        const fallback = await page.$$(sel._imageReferenceFileInputsFallback);
        for (const input of fallback) {
          const isRef = await input.evaluate(el => {
            const slot = el.closest('label')?.parentElement?.parentElement;
            if (!slot) return false;
            const rect = slot.getBoundingClientRect();
            return rect.width <= 80 && rect.height <= 80;
          }).catch(() => false);
          if (isRef) return 1; // At least one found
        }
      }

      // Try broadest possible: any sr-only file input inside a label > button > div chain
      // (but verify it's actually a reference slot, not some other upload input)
      const srInputs = await page.$$('input.sr-only[type="file"]');
      for (const input of srInputs) {
        const isRefSlot = await input.evaluate(el => {
          const label = el.closest('label');
          const btn = label?.parentElement;
          const slot = btn?.parentElement;
          if (!slot) return false;
          // Reference slots have the size-14 class
          return slot.classList.contains('size-14') || slot.className.includes('size-14');
        }).catch(() => false);
        if (isRefSlot) return 1;
      }

      return 0;
    };

    // Phase 1: Quick poll — slots may already be there
    const startTime = Date.now();
    for (let i = 0; i < 20; i++) {
      const count = await findSlots();
      if (count > 0) {
        console.log(`[REF] Reference slots ready: ${count} input(s) found (${Math.round((Date.now() - startTime) / 1000)}s)`);
        return;
      }
      await page.waitForTimeout(500);
    }

    // Phase 2: Click the prompt area — may trigger lazy rendering of the reference bar
    console.log('[REF] Reference slots not found after 10s — clicking prompt area to trigger render...');
    const promptEl = await page.$(sel.promptInput) || await page.$(sel.promptInputFallback);
    if (promptEl) {
      await promptEl.click().catch(() => {});
      await page.waitForTimeout(2000);
    }

    // Phase 3: Final check
    for (let i = 0; i < 6; i++) {
      const count = await findSlots();
      if (count > 0) {
        console.log(`[REF] Reference slots ready after prompt click: ${count} input(s) (${Math.round((Date.now() - startTime) / 1000)}s)`);
        return;
      }
      await page.waitForTimeout(500);
    }

    console.warn(`[REF] Reference slots NOT found after ${Math.round((Date.now() - startTime) / 1000)}s — uploads may fail`);
  }

  /**
   * Diagnostic: dump ALL file inputs on the page with their context.
   * Helps debug why selectors fail in Playwright but work in Chrome.
   */
  async _dumpFileInputDiagnostics() {
    const page = this.page;
    const sel = this.selectors.imageGeneration;

    try {
      // Save a screenshot for visual debugging
      const diagPath = path.join(this.projectDir || '.', 'diag_reference_slots.png');
      await page.screenshot({ path: diagPath, fullPage: false });
      console.log(`[DIAG] Screenshot saved: ${diagPath}`);

      const diag = await page.evaluate((primarySel) => {
        const allInputs = document.querySelectorAll('input[type="file"]');
        const primaryInputs = document.querySelectorAll(primarySel);
        const srOnlyInputs = document.querySelectorAll('input.sr-only[type="file"]');

        // Check for size-14 containers (reference slots) even without file inputs inside
        const sizeContainers = document.querySelectorAll('.size-14');
        const roundedSlots = document.querySelectorAll('[class*="rounded-xl"][class*="size-14"]');

        // Check for the prompt bar area
        const promptInput = document.querySelector('[role="textbox"]') || document.querySelector('[contenteditable]');
        const promptRect = promptInput?.getBoundingClientRect();

        // Walk the DOM near the prompt for any file-related elements
        const promptParent = promptInput?.closest('form') || promptInput?.closest('[class*="flex"]');
        const nearbyInputs = promptParent ? promptParent.querySelectorAll('input[type="file"]') : [];

        const details = [];
        for (const input of allInputs) {
          // Walk up the full ancestor chain to understand structure
          const ancestors = [];
          let el = input.parentElement;
          for (let i = 0; i < 6 && el; i++) {
            ancestors.push({
              tag: el.tagName,
              cls: (el.className || '').slice(0, 60),
              w: Math.round(el.getBoundingClientRect().width),
              h: Math.round(el.getBoundingClientRect().height),
            });
            el = el.parentElement;
          }

          details.push({
            accept: (input.accept || '').slice(0, 50),
            className: (input.className || '').slice(0, 30),
            ancestors,
          });
        }

        return {
          url: window.location.href,
          viewportW: window.innerWidth,
          viewportH: window.innerHeight,
          totalFileInputs: allInputs.length,
          primarySelectorCount: primaryInputs.length,
          srOnlyCount: srOnlyInputs.length,
          sizeContainers: sizeContainers.length,
          roundedSlots: roundedSlots.length,
          hasPromptInput: !!promptInput,
          promptRect: promptRect ? `${Math.round(promptRect.width)}x${Math.round(promptRect.height)} @ (${Math.round(promptRect.left)},${Math.round(promptRect.top)})` : 'N/A',
          nearbyInputsCount: nearbyInputs.length,
          inputs: details,
        };
      }, sel.imageReferenceFileInputs);

      console.log(`[DIAG] Page URL: ${diag.url}`);
      console.log(`[DIAG] Viewport: ${diag.viewportW}x${diag.viewportH}`);
      console.log(`[DIAG] Total file inputs: ${diag.totalFileInputs} | Primary: ${diag.primarySelectorCount} | sr-only: ${diag.srOnlyCount}`);
      console.log(`[DIAG] .size-14 containers: ${diag.sizeContainers} | rounded-xl+size-14: ${diag.roundedSlots}`);
      console.log(`[DIAG] Prompt input: ${diag.hasPromptInput} at ${diag.promptRect} | Nearby file inputs: ${diag.nearbyInputsCount}`);
      for (let i = 0; i < diag.inputs.length; i++) {
        const d = diag.inputs[i];
        console.log(`[DIAG]   input[${i}]: accept="${d.accept}" class="${d.className}"`);
        for (let j = 0; j < d.ancestors.length; j++) {
          const a = d.ancestors[j];
          console.log(`[DIAG]     ↑${j}: <${a.tag}> ${a.w}x${a.h} class="${a.cls}"`);
        }
      }
    } catch (e) {
      console.warn(`[DIAG] Diagnostic dump failed: ${e.message}`);
    }
  }

  /**
   * Clear all existing reference images from the Nano Banana Pro form.
   * Reference slots only exist when images have been uploaded — each filled
   * slot has a close button (24x24) at its top-right corner.
   */
  async clearImageReferences() {
    const page = this.page;

    // Repeatedly clear filled reference slots until none remain.
    // Each clear pass clicks close buttons, then waits for the UI to update.
    // We loop because the DOM changes after each removal (slots shift/re-render).
    let totalCleared = 0;

    for (let pass = 0; pass < 15; pass++) {
      const filledCount = await page.evaluate(() => {
        const form = document.querySelector('form.image-form') || document.querySelector('form');
        if (!form) return 0;
        const slots = form.querySelectorAll('.size-14');
        let count = 0;
        for (const slot of slots) {
          const img = slot.querySelector('img');
          if (img && img.src && (img.src.startsWith('blob:') || img.src.startsWith('data:') || img.src.startsWith('http'))) {
            count++;
          }
        }
        return count;
      });

      if (filledCount === 0) break;

      // Click the FIRST filled slot's close button (one at a time, since
      // the DOM shifts after each removal)
      const clicked = await page.evaluate(() => {
        const form = document.querySelector('form.image-form') || document.querySelector('form');
        if (!form) return false;
        const slots = form.querySelectorAll('.size-14');
        for (const slot of slots) {
          const img = slot.querySelector('img');
          if (!img || !img.src) continue;
          if (!(img.src.startsWith('blob:') || img.src.startsWith('data:') || img.src.startsWith('http'))) continue;

          // Find close/delete button — check all buttons in the slot (not just direct children)
          const buttons = slot.querySelectorAll('button');
          for (const btn of buttons) {
            const rect = btn.getBoundingClientRect();
            // Close buttons are small (≤30px) and NOT the full-size upload button
            if (rect.width <= 30 && rect.height <= 30 && rect.width > 0) {
              btn.click();
              return true;
            }
          }
          // Also try SVG-based close icons inside buttons
          const svgBtn = slot.querySelector('button svg')?.closest('button');
          if (svgBtn) {
            const rect = svgBtn.getBoundingClientRect();
            if (rect.width <= 30 && rect.height <= 30) {
              svgBtn.click();
              return true;
            }
          }
          break; // Only try the first filled slot per pass
        }
        return false;
      });

      if (clicked) {
        totalCleared++;
        await page.waitForTimeout(600); // Wait for UI to update after removal
      } else {
        // Couldn't find a close button — stop trying
        console.warn(`[IMG] Could not find close button for filled slot (pass ${pass + 1})`);
        break;
      }
    }

    if (totalCleared > 0) {
      console.log(`[IMG] Cleared ${totalCleared} reference slot(s)`);
      await page.waitForTimeout(500);
    }

    // Verify all cleared
    const remaining = await page.evaluate(() => {
      const form = document.querySelector('form.image-form') || document.querySelector('form');
      if (!form) return 0;
      const slots = form.querySelectorAll('.size-14');
      let count = 0;
      for (const slot of slots) {
        const img = slot.querySelector('img');
        if (img && img.src && (img.src.startsWith('blob:') || img.src.startsWith('data:') || img.src.startsWith('http'))) count++;
      }
      return count;
    });
    if (remaining > 0) {
      console.warn(`[IMG] WARNING: ${remaining} filled slot(s) remain — force-navigating to clear`);
      // Nuclear option: reload the page to clear all stale references
      const currentUrl = page.url();
      await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForSelector('form.image-form, form', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(1500);

      const afterReload = await page.evaluate(() => {
        const form = document.querySelector('form.image-form') || document.querySelector('form');
        if (!form) return 0;
        const slots = form.querySelectorAll('.size-14');
        let count = 0;
        for (const slot of slots) {
          const img = slot.querySelector('img');
          if (img && img.src && (img.src.startsWith('blob:') || img.src.startsWith('data:') || img.src.startsWith('http'))) count++;
        }
        return count;
      });
      if (afterReload > 0) {
        console.warn(`[IMG] Still ${afterReload} filled slot(s) after reload — Higgsfield may persist refs in session`);
      } else {
        console.log(`[IMG] All reference slots cleared after page reload`);
      }
    }
  }

  /**
   * Upload reference images using Playwright's filechooser interception.
   *
   * Higgsfield's reference upload works through a native file picker triggered
   * by clicking the upload button (+). The .size-14 reference slot containers
   * only appear AFTER the first upload — on a fresh page, only the + trigger
   * and its hidden file input exist inside the prompt form.
   *
   * Approach:
   * 1. Find the upload trigger (file input or its parent button/label)
   * 2. Set up filechooser listener BEFORE clicking the trigger
   * 3. Click → intercept filechooser → set files programmatically
   * 4. Wait for thumbnail confirmation
   * 5. After first upload, new upload slots appear dynamically
   *
   * @param {string[]} references - Array of absolute file paths to upload
   * @returns {number} Number of successfully confirmed uploads
   */
  async uploadImageReferences(references) {
    const page = this.page;
    const maxSlots = 14;
    const INTER_UPLOAD_WAIT_MS = 2500;

    let successCount = 0;
    const toUpload = references.slice(0, maxSlots);

    // ── NETWORK RESPONSE TRACKER ──
    // Higgsfield's React component may not swap the img src from blob: to https://
    // after backend upload (it keeps the local blob for display performance).
    // So the only ground-truth signal for "upload actually completed" is a
    // successful HTTP response from an upload-related endpoint.
    // We track all upload-ish responses and match them to our upload attempts.
    const uploadResponses = []; // { url, status, ts }
    const responseListener = (response) => {
      try {
        const url = response.url();
        const status = response.status();
        const method = response.request().method();

        // Match upload-related endpoints:
        // - POST requests
        // - URLs containing upload/asset/media/images keywords
        // - OR PUT requests to S3/CloudFront presigned URLs
        const isUploadish =
          (method === 'POST' && (
            url.includes('/upload') ||
            url.includes('/asset') ||
            url.includes('/media') ||
            url.includes('/image') ||
            url.includes('/file') ||
            url.includes('/reference')
          )) ||
          (method === 'PUT' && (
            url.includes('amazonaws') ||
            url.includes('cloudfront') ||
            url.includes('s3') ||
            url.includes('storage') ||
            url.includes('higgs')
          ));

        if (isUploadish) {
          uploadResponses.push({ url: url.slice(0, 120), status, method, ts: Date.now() });
          // Log only successful uploads to reduce noise
          if (status >= 200 && status < 300) {
            console.log(`[REF]   [NET] ${method} ${status} ${url.slice(0, 80)}`);
          }
        }
      } catch (_) {}
    };
    page.on('response', responseListener);

    // Helper: count filled thumbnails in .size-14 slots
    const countFilledThumbnails = async () => {
      return page.evaluate(() => {
        const form = document.querySelector('form.image-form') || document.querySelector('form');
        if (!form) return 0;
        let count = 0;
        for (const slot of form.querySelectorAll('.size-14')) {
          const img = slot.querySelector('img');
          if (img && img.src && (img.src.startsWith('blob:') || img.src.startsWith('data:') || img.src.startsWith('http'))) count++;
        }
        return count;
      });
    };

    // Helper: count successful upload responses since a timestamp
    const countSuccessfulUploadsSince = (ts) => {
      return uploadResponses.filter(r => r.ts >= ts && r.status >= 200 && r.status < 300).length;
    };

    // ── PERSISTENT FILECHOOSER HANDLER ──
    // Catches ANY filechooser event that fires during this function, regardless
    // of when or why. The handler attaches the CURRENT upload's file to whatever
    // picker opens. This prevents any OS-native picker from leaking through to
    // the user, even if our click logic mis-detects the modal flow.
    let currentUploadFile = null;
    let lastFileChooserAt = 0;
    const fileChooserHandler = async (chooser) => {
      try {
        if (!currentUploadFile) {
          // No upload in progress — accept the picker but cancel it (don't leak to OS)
          console.warn(`[REF]   [FC] Unexpected filechooser fired with no active upload — dismissing`);
          await chooser.setFiles([]).catch(() => {});
          return;
        }
        const file = currentUploadFile;
        console.log(`[REF]   [FC] Filechooser fired — attaching ${path.basename(file)}`);
        await chooser.setFiles(file);
        lastFileChooserAt = Date.now();
      } catch (e) {
        console.warn(`[REF]   [FC] Handler error: ${e.message.split('\n')[0]}`);
      }
    };
    page.on('filechooser', fileChooserHandler);

    for (let i = 0; i < toUpload.length; i++) {
      if (!fs.existsSync(toUpload[i])) {
        console.warn(`[REF] Reference file not found, skipping: ${toUpload[i]}`);
        continue;
      }

      console.log(`[REF] Upload ${i + 1}/${toUpload.length}: ${path.basename(toUpload[i])}`);

      // Tell the persistent filechooser handler which file to attach.
      // ANY picker that opens from this point until we clear this will get this file.
      currentUploadFile = toUpload[i];
      const fileChooserAtBeforeClick = lastFileChooserAt;

      // Timestamp: network responses after this count toward this upload
      const uploadStartTs = Date.now();

      // Snapshot the current thumbnail count BEFORE upload attempt
      const beforeCount = await countFilledThumbnails();

      // Find the upload trigger
      const trigger = await this._findReferenceUploadTrigger();
      if (!trigger) {
        console.warn(`[REF] No upload trigger found for ref ${i + 1} — stopping uploads`);
        break;
      }

      let uploaded = false;
      let uploadMethod = '';

      // ── FILECHOOSER-ONLY UPLOADS ──
      // CRITICAL: setInputFiles() and el.click() via JS bypass React's user-gesture
      // check. The blob thumbnail shows (DOM-level file attach) but Higgsfield's
      // React component never triggers the backend upload → file stays as blob:
      // forever, never reaches CDN.
      //
      // Fix: use page.mouse.click() with real coordinates — that dispatches a
      // TRUSTED click event React accepts, triggering the actual upload flow.

      // Approach 0: Pre-obtained filechooser (from clicking the "+" add button)
      if (trigger.fileChooser) {
        try {
          await trigger.fileChooser.setFiles(toUpload[i]);
          uploadMethod = 'pre-obtained filechooser (add button)';
          uploaded = true;
        } catch (e) {
          console.warn(`[REF]   Pre-obtained filechooser failed: ${e.message.split('\n')[0]}`);
        }
      }

      // ── CLICK STRATEGY (persistent filechooser handler does the rest) ──
      // We just need to click the right element. The persistent fileChooserHandler
      // (set up at function entry) will catch ANY filechooser event and attach
      // currentUploadFile to it — no race conditions, no abandoned promises.
      //
      // Helper: wait up to N ms for a filechooser to fire after our click.
      const waitForFcFire = async (timeoutMs) => {
        const startWait = Date.now();
        while (Date.now() - startWait < timeoutMs) {
          if (lastFileChooserAt > fileChooserAtBeforeClick) return true;
          await page.waitForTimeout(200);
        }
        return false;
      };

      // Approach 1: Real mouse click on clickable
      if (!uploaded && trigger.clickable) {
        try {
          const box = await trigger.clickable.boundingBox();
          const tag = await trigger.clickable.evaluate(el => ({
            tag: el.tagName,
            cls: (el.className || '').substring(0, 80),
          })).catch(() => null);
          console.log(`[REF]   Clickable: ${tag ? `<${tag.tag}> .${tag.cls}` : 'unknown'}, box=${box ? `${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}x${Math.round(box.height)}` : 'none'}`);

          if (box && box.width > 0 && box.height > 0) {
            await trigger.clickable.scrollIntoViewIfNeeded().catch(() => {});
            await page.waitForTimeout(200);
            const box2 = await trigger.clickable.boundingBox();
            const finalX = box2 ? box2.x + box2.width / 2 : box.x + box.width / 2;
            const finalY = box2 ? box2.y + box2.height / 2 : box.y + box.height / 2;

            console.log(`[REF]   Real mouse click at (${Math.round(finalX)}, ${Math.round(finalY)})...`);
            await page.mouse.move(finalX, finalY);
            await page.waitForTimeout(200);
            await page.mouse.click(finalX, finalY);

            // The persistent handler attaches files automatically when fc fires.
            // Wait briefly for fc to fire.
            if (await waitForFcFire(3000)) {
              uploadMethod = 'real mouse click → persistent handler';
              uploaded = true;
            } else {
              // No fc yet — maybe a modal appeared. Try clicking an Upload option in any visible modal.
              const uploadOption = await page.evaluate(() => {
                const containers = document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="lightbox"], [class*="popup"]');
                const keywords = ['upload', 'device', 'computer', 'browse', 'local', 'choose file', 'from my', 'my files'];
                for (const container of containers) {
                  const cRect = container.getBoundingClientRect();
                  if (cRect.width < 100 || cRect.height < 80) continue;
                  const clickables = container.querySelectorAll('button, [role="button"], a, label, li, [class*="option"], [class*="item"]');
                  for (const el of clickables) {
                    const rect = el.getBoundingClientRect();
                    if (rect.width < 20 || rect.height < 20) continue;
                    const text = (el.textContent || '').trim().toLowerCase();
                    if (!text || text.length > 60) continue;
                    if (keywords.some(kw => text.includes(kw))) {
                      el.setAttribute('data-ref-upload-option', 'true');
                      return { text: text.slice(0, 50), x: rect.x, y: rect.y, w: rect.width, h: rect.height };
                    }
                  }
                }
                return null;
              });
              if (uploadOption) {
                console.log(`[REF]   Modal upload option "${uploadOption.text}" — clicking`);
                const optX = uploadOption.x + uploadOption.w / 2;
                const optY = uploadOption.y + uploadOption.h / 2;
                await page.mouse.move(optX, optY);
                await page.waitForTimeout(200);
                await page.mouse.click(optX, optY);
                await page.evaluate(() => {
                  const el = document.querySelector('[data-ref-upload-option="true"]');
                  if (el) el.removeAttribute('data-ref-upload-option');
                });
                if (await waitForFcFire(8000)) {
                  uploadMethod = 'modal → upload option → persistent handler';
                  uploaded = true;
                }
              } else {
                // Wait longer for a late filechooser
                if (await waitForFcFire(10000)) {
                  uploadMethod = 'late filechooser → persistent handler';
                  uploaded = true;
                }
              }
            }
          } else {
            console.warn(`[REF]   Clickable has no visible bounding box — falling through`);
          }
        } catch (e) {
          console.warn(`[REF]   Real mouse click approach failed: ${e.message.split('\n')[0]}`);
        }
      }

      // Approach 2: elementHandle.click as fallback
      if (!uploaded && trigger.clickable) {
        try {
          await trigger.clickable.click({ force: true });
          if (await waitForFcFire(8000)) {
            uploadMethod = 'elementHandle click → persistent handler';
            uploaded = true;
          }
        } catch (e) {
          console.warn(`[REF]   elementHandle.click() failed: ${e.message.split('\n')[0]}`);
        }
      }

      // Approach 3: Real mouse click on file input's parent
      if (!uploaded && trigger.fileInput) {
        try {
          const labelBox = await trigger.fileInput.evaluate(el => {
            let parent = el.parentElement;
            let depth = 0;
            while (parent && depth < 5) {
              const rect = parent.getBoundingClientRect();
              if (rect.width > 20 && rect.height > 20) {
                return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
              }
              parent = parent.parentElement;
              depth++;
            }
            return null;
          });
          if (labelBox) {
            const clickX = labelBox.x + labelBox.width / 2;
            const clickY = labelBox.y + labelBox.height / 2;
            console.log(`[REF]   Real mouse click on input parent at (${Math.round(clickX)}, ${Math.round(clickY)})...`);
            await page.mouse.move(clickX, clickY);
            await page.waitForTimeout(150);
            await page.mouse.click(clickX, clickY);
            if (await waitForFcFire(8000)) {
              uploadMethod = 'parent click → persistent handler';
              uploaded = true;
            }
          }
        } catch (e) {
          console.warn(`[REF]   Real mouse click on input parent failed: ${e.message.split('\n')[0]}`);
        }
      }

      // NOTE: We intentionally do NOT fall back to setInputFiles() or
      // fileInput.evaluate(el => el.click()). Those paths attach the file to the
      // DOM input (blob preview appears) but DO NOT trigger Higgsfield's backend
      // upload, so the file stays local forever — we end up timing out waiting
      // for a CDN URL that will never come.
      // Better to fail loudly here and abort than generate without references.

      if (!uploaded) {
        console.error(`[REF]   ALL trusted-click upload approaches failed for ref ${i + 1}`);
        currentUploadFile = null;
        page.off('response', responseListener);
        page.off('filechooser', fileChooserHandler);
        throw new Error(
          `REFERENCE_UPLOAD_FAILED: Could not upload reference ${i + 1}/${toUpload.length} ` +
          `(${path.basename(toUpload[i])}). All trusted-click approaches failed. ` +
          `Aborting to prevent generation without face consistency.`
        );
      }

      console.log(`[REF]   File set via ${uploadMethod}`);

      // ── Wait for BLOB thumbnail (local preview) ──
      // Compare against beforeCount — detect ANY new thumbnail
      let thumbnailConfirmed = false;
      for (let t = 0; t < 40; t++) {
        const currentCount = await countFilledThumbnails();
        if (currentCount > beforeCount) {
          thumbnailConfirmed = true;
          break;
        }
        await page.waitForTimeout(250);
      }

      if (thumbnailConfirmed) {
        console.log(`[REF] Reference ${i + 1} blob preview visible`);
      } else {
        console.warn(`[REF] Reference ${i + 1} uploaded but thumbnail NOT confirmed (count unchanged from ${beforeCount})`);
      }

      // ── WAIT FOR UPLOAD COMPLETION (network-based) ──
      // Higgsfield may keep the img src as blob: even after backend upload,
      // so we CAN'T rely on DOM src to confirm. Instead, watch network responses
      // for a successful upload-related HTTP response since this upload began.
      // If we see 200/201 on an upload-ish endpoint → confirmed.
      // If no network response but the DOM DOES show a CDN URL → also confirmed.
      // If neither after 90s → treat as failure.
      const perUploadStart = uploadStartTs; // already set above when click fired
      const beforeCdnCount = await page.evaluate(() => {
        const form = document.querySelector('form.image-form') || document.querySelector('form');
        if (!form) return 0;
        let cdn = 0;
        for (const slot of form.querySelectorAll('.size-14')) {
          const img = slot.querySelector('img');
          if (img && img.src && img.src.startsWith('https://')) cdn++;
        }
        return cdn;
      });

      const PER_UPLOAD_TIMEOUT_MS = 90000;
      let confirmedBy = null;
      while (Date.now() - perUploadStart < PER_UPLOAD_TIMEOUT_MS) {
        // Signal A: Successful network response since upload started
        const netHits = countSuccessfulUploadsSince(perUploadStart);
        if (netHits > 0) {
          confirmedBy = `network (${netHits} successful upload response(s))`;
          break;
        }
        // Signal B: DOM img src transitioned to https:// (if React swaps it)
        const cdnNow = await page.evaluate(() => {
          const form = document.querySelector('form.image-form') || document.querySelector('form');
          if (!form) return 0;
          let cdn = 0;
          for (const slot of form.querySelectorAll('.size-14')) {
            const img = slot.querySelector('img');
            if (img && img.src && img.src.startsWith('https://')) cdn++;
          }
          return cdn;
        });
        if (cdnNow > beforeCdnCount) {
          confirmedBy = `DOM (CDN URL appeared in slot)`;
          break;
        }
        await page.waitForTimeout(500);
      }

      if (!confirmedBy) {
        // Dump diagnostic: what network traffic DID we see?
        console.error(`[REF] Upload confirmation FAILED for ref ${i + 1}.`);
        console.error(`[REF]   Network hits since upload start: ${uploadResponses.filter(r => r.ts >= perUploadStart).length}`);
        for (const r of uploadResponses.filter(r => r.ts >= perUploadStart).slice(0, 10)) {
          console.error(`[REF]     ${r.method} ${r.status} ${r.url}`);
        }
        currentUploadFile = null;
        page.off('response', responseListener);
        page.off('filechooser', fileChooserHandler);
        throw new Error(
          `REFERENCE_UPLOAD_UNCONFIRMED: Reference ${i + 1}/${toUpload.length} (${path.basename(toUpload[i])}) ` +
          `did not register on backend within ${PER_UPLOAD_TIMEOUT_MS / 1000}s. ` +
          `No successful upload response AND no CDN URL swap. Aborting.`
        );
      }

      successCount++;
      const elapsed = Math.round((Date.now() - perUploadStart) / 1000);
      console.log(`[REF] Reference ${i + 1} upload CONFIRMED via ${confirmedBy} after ${elapsed}s`);

      // Clear current upload file so any spurious filechooser doesn't get this file
      currentUploadFile = null;

      // ── MANDATORY WAIT between uploads ──
      if (i < toUpload.length - 1) {
        console.log(`[REF]   Waiting ${INTER_UPLOAD_WAIT_MS}ms for next empty slot to appear before next upload...`);
        await page.waitForTimeout(INTER_UPLOAD_WAIT_MS);
      }
    }

    console.log(`[REF] Upload complete: ${successCount}/${toUpload.length} confirmed`);

    if (successCount === 0 && toUpload.length > 0) {
      console.error('[REF] WARNING: No references confirmed! Scene may generate without face consistency.');
    }

    // Clean up listeners
    currentUploadFile = null;
    page.off('response', responseListener);
    page.off('filechooser', fileChooserHandler);

    return successCount;
  }

  /**
   * Find the clickable trigger AND file input for the NEXT reference upload.
   *
   * Returns { clickable, fileInput } where:
   * - clickable: ElementHandle for the button/label to click (triggers filechooser)
   * - fileInput: ElementHandle for the <input type="file"> (for setInputFiles fallback)
   * Either may be null; the caller tries clickable first, then fileInput.
   *
   * If no empty slot exists (all filled, UI hasn't rendered the new + yet),
   * polls up to 4s for a new empty slot to appear before falling back.
   *
   * @returns {{ clickable: ElementHandle|null, fileInput: ElementHandle|null }|null}
   */
  async _findReferenceUploadTrigger() {
    const page = this.page;

    // Log current DOM state for debugging.
    // DOM structure (from live inspection):
    //   form.image-form > fieldset > div.flex-1 > div.flex.gap-3 (reference row)
    //     > DIV.touch-none.cursor-grab  (drag wrapper for slot 1)
    //         > DIV.size-14 (slot — filled or empty)
    //     > DIV.touch-none.cursor-grab  (drag wrapper for slot 2)
    //         > DIV.size-14 (slot)
    //     > ??? (the "+" add button — NOT inside .size-14, sibling of drag wrappers)
    const slotState = await page.evaluate(() => {
      const form = document.querySelector('form.image-form') || document.querySelector('form');
      if (!form) return { formFound: false };
      const slots = form.querySelectorAll('.size-14');
      let filled = 0, empty = 0;
      for (const slot of slots) {
        const img = slot.querySelector('img');
        if (img && img.src && (img.src.startsWith('blob:') || img.src.startsWith('data:') || img.src.startsWith('http'))) {
          filled++;
        } else {
          empty++;
        }
      }
      const fileInputs = form.querySelectorAll('input[type="file"]');

      // Dump the reference row (grandparent of .size-14: parent = drag wrapper, grandparent = flex row)
      let refRowInfo = null;
      if (slots.length > 0) {
        // .size-14 → drag wrapper (touch-none) → flex row container
        const dragWrapper = slots[0].parentElement;
        const refRow = dragWrapper.classList.contains('size-14') ? dragWrapper.parentElement : dragWrapper.parentElement;
        const rowContainer = dragWrapper.querySelector('.size-14') ? dragWrapper.parentElement : dragWrapper;
        // Use the actual grandparent if the parent is a drag wrapper
        const container = (dragWrapper !== slots[0]) ? dragWrapper.parentElement : dragWrapper;
        const siblings = [];
        for (const child of container.children) {
          const hasSlot14 = child.classList.contains('size-14') || !!child.querySelector('.size-14');
          const tag = child.tagName;
          const classes = Array.from(child.classList).join(' ');
          const hasFileInput = !!child.querySelector('input[type="file"]');
          const hasSvg = !!child.querySelector('svg');
          const hasImg = !!child.querySelector('img');
          const rect = child.getBoundingClientRect();
          siblings.push({
            tag, classes: classes.substring(0, 100), hasSlot14, hasFileInput, hasSvg, hasImg,
            w: Math.round(rect.width), h: Math.round(rect.height)
          });
        }
        refRowInfo = { containerTag: container.tagName, containerClasses: Array.from(container.classList).join(' ').substring(0, 100), childCount: container.children.length, children: siblings };
      }
      return { formFound: true, totalSlots: slots.length, filled, empty, fileInputCount: fileInputs.length, refRowInfo };
    });
    console.log(`[REF]   Slot state: ${JSON.stringify(slotState)}`);

    // ── Strategy 1: Empty .size-14 slot ──
    const emptySlotResult = await page.evaluate(() => {
      const form = document.querySelector('form.image-form') || document.querySelector('form');
      if (!form) return null;
      const slots = form.querySelectorAll('.size-14');
      let lastEmpty = null;
      for (const slot of slots) {
        const img = slot.querySelector('img');
        const hasImage = img && img.src && (img.src.startsWith('blob:') || img.src.startsWith('data:') || img.src.startsWith('http'));
        if (!hasImage) lastEmpty = slot;
      }
      if (lastEmpty) {
        lastEmpty.setAttribute('data-ref-target', 'true');
        return true;
      }
      return null;
    });

    if (emptySlotResult) {
      const clickable = await page.evaluateHandle(() => {
        const slot = document.querySelector('[data-ref-target="true"]');
        if (!slot) return null;
        return slot.querySelector('button.size-full') || slot.querySelector('button') || slot.querySelector('label');
      });
      const fileInput = await page.evaluateHandle(() => {
        const slot = document.querySelector('[data-ref-target="true"]');
        if (!slot) return null;
        const input = slot.querySelector('input[type="file"]');
        if (input) return input;
        const label = slot.querySelector('label');
        return label?.querySelector('input[type="file"]') || null;
      });
      await page.evaluate(() => {
        const el = document.querySelector('[data-ref-target="true"]');
        if (el) el.removeAttribute('data-ref-target');
      });

      const clickableEl = clickable.asElement();
      const fileInputEl = fileInput.asElement();
      if (clickableEl || fileInputEl) {
        console.log(`[REF]   Trigger: empty .size-14 slot (clickable: ${!!clickableEl}, fileInput: ${!!fileInputEl})`);
        return { clickable: clickableEl, fileInput: fileInputEl };
      }
    }

    // ── Strategy 2: "+" add button — sibling of DRAG WRAPPERS (grandparent level) ──
    // Each .size-14 is wrapped in a drag wrapper (div.touch-none.cursor-grab).
    // The "+" button is a sibling of these drag wrappers, NOT inside any .size-14.
    // We go UP two levels: .size-14 → drag wrapper → flex row container.
    if (slotState.totalSlots > 0 && slotState.empty === 0) {
      console.log(`[REF]   All ${slotState.filled} slots filled — looking for "+" add button...`);

      // ── DEEP DOM WALK: map every level from .size-14 up to form ──
      // This tells us exactly where the + button lives relative to the slots.
      const ancestry = await page.evaluate(() => {
        const form = document.querySelector('form.image-form') || document.querySelector('form');
        if (!form) return { error: 'no form' };
        const slot = form.querySelector('.size-14');
        if (!slot) return { error: 'no .size-14' };

        const levels = [];
        let el = slot;
        while (el && el !== form.parentElement) {
          const siblings = [];
          if (el.parentElement) {
            for (const sib of el.parentElement.children) {
              const rect = sib.getBoundingClientRect();
              siblings.push({
                tag: sib.tagName,
                cls: Array.from(sib.classList).join(' ').substring(0, 100),
                hasSlot: sib.classList.contains('size-14') || !!sib.querySelector('.size-14'),
                hasFileInput: !!sib.querySelector('input[type="file"]'),
                hasSvg: !!sib.querySelector('svg'),
                hasImg: !!sib.querySelector('img'),
                hasLabel: !!sib.querySelector('label') || sib.tagName === 'LABEL',
                hasBtn: !!sib.querySelector('button') || sib.tagName === 'BUTTON',
                w: Math.round(rect.width),
                h: Math.round(rect.height),
                isCurrent: sib === el,
              });
            }
          }
          levels.push({
            tag: el.tagName,
            cls: Array.from(el.classList).join(' ').substring(0, 100),
            siblingCount: el.parentElement ? el.parentElement.children.length : 0,
            siblings,
          });
          el = el.parentElement;
        }
        return { levels };
      });
      console.log(`[REF]   DOM ancestry from .size-14 to form:`);
      if (ancestry.levels) {
        for (let lvl = 0; lvl < ancestry.levels.length; lvl++) {
          const l = ancestry.levels[lvl];
          console.log(`[REF]     Level ${lvl}: <${l.tag}> .${l.cls} (${l.siblingCount} siblings)`);
          for (const s of l.siblings) {
            const marker = s.isCurrent ? ' ◄ CURRENT' : '';
            const flags = [
              s.hasSlot ? 'SLOT' : '',
              s.hasFileInput ? 'FILE' : '',
              s.hasSvg ? 'SVG' : '',
              s.hasImg ? 'IMG' : '',
              s.hasLabel ? 'LABEL' : '',
              s.hasBtn ? 'BTN' : '',
            ].filter(Boolean).join(',');
            console.log(`[REF]       <${s.tag}> .${s.cls.substring(0, 60)} ${s.w}x${s.h} [${flags}]${marker}`);
          }
        }
      }

      // ── Now search for the + button at EVERY level of the ancestry ──
      // Walk up from .size-14 and at each level, look for a non-slot sibling
      // that has a file input, label, button, or SVG (the + add button).
      const addBtnResult = await page.evaluateHandle(() => {
        const form = document.querySelector('form.image-form') || document.querySelector('form');
        if (!form) return null;
        const firstSlot = form.querySelector('.size-14');
        if (!firstSlot) return null;

        let el = firstSlot;
        while (el && el !== form) {
          const parent = el.parentElement;
          if (!parent) break;

          for (const sibling of parent.children) {
            // Skip elements that contain a .size-14 (those are slots or slot wrappers)
            if (sibling.classList.contains('size-14') || sibling.querySelector('.size-14')) continue;
            // Skip the current element itself
            if (sibling === el) continue;

            const rect = sibling.getBoundingClientRect();
            // The add button should be visible and reasonably sized
            if (rect.width <= 0 || rect.height <= 0) continue;
            if (rect.width > 200 || rect.height > 200) continue;

            // Check if this sibling looks like an add button
            const hasFileInput = !!sibling.querySelector('input[type="file"]');
            const hasLabel = !!sibling.querySelector('label') || sibling.tagName === 'LABEL';
            const hasBtn = !!sibling.querySelector('button') || sibling.tagName === 'BUTTON';
            const hasSvg = !!sibling.querySelector('svg');

            if (hasFileInput || hasLabel || hasBtn || hasSvg) {
              // Found the add button! Return the best clickable element.
              const label = sibling.querySelector('label') || (sibling.tagName === 'LABEL' ? sibling : null);
              const btn = sibling.querySelector('button') || (sibling.tagName === 'BUTTON' ? sibling : null);
              if (label) return label;
              if (btn) return btn;
              return sibling;
            }
          }

          el = parent;
        }
        return null;
      });

      const addBtnEl = addBtnResult.asElement();
      if (addBtnEl) {
        console.log('[REF]   Found "+" add button at grandparent level — clicking...');

        // Try filechooser interception
        try {
          const [fileChooser] = await Promise.all([
            page.waitForEvent('filechooser', { timeout: 5000 }),
            addBtnEl.click({ force: true }),
          ]);
          console.log('[REF]   Add button triggered filechooser directly');
          return { clickable: null, fileInput: null, fileChooser };
        } catch {
          // Clicking may have created a new empty slot — wait for it
          console.log('[REF]   Filechooser not triggered, waiting for new empty slot...');
          for (let w = 0; w < 25; w++) {
            await page.waitForTimeout(200);
            const hasEmpty = await page.evaluate(() => {
              const form = document.querySelector('form.image-form') || document.querySelector('form');
              if (!form) return false;
              for (const slot of form.querySelectorAll('.size-14')) {
                const img = slot.querySelector('img');
                if (!img || !img.src || !(img.src.startsWith('blob:') || img.src.startsWith('data:') || img.src.startsWith('http'))) {
                  return true;
                }
              }
              return false;
            });
            if (hasEmpty) {
              console.log('[REF]   New empty slot appeared after clicking add button');
              return this._findReferenceUploadTrigger();
            }
          }
          console.warn('[REF]   No new slot appeared after clicking add button');
        }
      } else {
        console.warn('[REF]   Could not find "+" add button at grandparent level');
      }

      // Sub-strategy: find any file input NOT inside .size-14 anywhere in form
      const addFileInput = await page.evaluateHandle(() => {
        const form = document.querySelector('form.image-form') || document.querySelector('form');
        if (!form) return null;
        for (const input of form.querySelectorAll('input[type="file"]')) {
          if (input.closest('.size-14')) continue;
          return input;
        }
        return null;
      });
      const addFileInputEl = addFileInput.asElement();
      if (addFileInputEl) {
        const addClickable = await addFileInputEl.evaluateHandle(el => {
          const label = el.closest('label');
          if (label) return label.closest('button') || label;
          return el.closest('button') || el.parentElement;
        });
        console.log('[REF]   Trigger: non-slot file input (add button\'s hidden input)');
        return { clickable: addClickable.asElement(), fileInput: addFileInputEl };
      }
    }

    // ── Strategy 3: Fresh page — no .size-14 slots at all ──
    // Higgsfield's fresh image page has the file input as a BARE <input>, not
    // wrapped in a label or button. The actual click trigger (+ button with SVG
    // icon) is a SIBLING of the input's ancestors, not an ancestor itself.
    if (slotState.totalSlots === 0) {
      const freshInfo = await page.evaluate(() => {
        const form = document.querySelector('form.image-form') || document.querySelector('form');
        if (!form) return { error: 'no form' };

        // Find the image-accepting file input NOT inside a .size-14 slot
        let fileInput = null;
        for (const input of form.querySelectorAll('input[type="file"]')) {
          const accept = (input.getAttribute('accept') || '').toLowerCase();
          if (!accept.includes('image')) continue;
          if (input.closest('.size-14')) continue;
          fileInput = input;
          break;
        }
        if (!fileInput) return { error: 'no fresh file input' };

        const candidates = [];

        // --- Priority 1: <label for="..."> that points to this input's id ---
        if (fileInput.id) {
          const labelFor = document.querySelector(`label[for="${fileInput.id}"]`);
          if (labelFor) {
            const rect = labelFor.getBoundingClientRect();
            candidates.push({ el: labelFor, tag: 'LABEL-FOR', w: rect.width, h: rect.height, x: rect.x, y: rect.y, priority: 100 });
          }
        }

        // --- Priority 2: <label> ancestor wrapping the input ---
        const labelAnc = fileInput.closest('label');
        if (labelAnc) {
          const rect = labelAnc.getBoundingClientRect();
          candidates.push({ el: labelAnc, tag: 'LABEL-ANC', w: rect.width, h: rect.height, x: rect.x, y: rect.y, priority: 90 });
        }

        // --- Priority 3: Sibling BUTTONS at each level walking up from input ---
        // The + add button is typically a sibling of the input's ancestors,
        // not an ancestor. Walk up and inspect siblings at each level.
        let el = fileInput;
        let depth = 0;
        while (el && el.parentElement && depth < 6) {
          const parent = el.parentElement;
          for (const sib of parent.children) {
            if (sib === el) continue;
            // Find visible buttons in this sibling tree
            const btns = [];
            if (sib.tagName === 'BUTTON') btns.push(sib);
            for (const b of sib.querySelectorAll('button')) btns.push(b);

            for (const btn of btns) {
              const rect = btn.getBoundingClientRect();
              if (rect.width < 20 || rect.height < 20) continue;
              if (rect.width > 300 || rect.height > 300) continue; // skip huge things
              // CRITICAL: Skip buttons in the upper history-grid area.
              // The Higgsfield image gen page has History grid in the top half;
              // the prompt/upload form is always in the bottom half of viewport.
              // Buttons in the top half are likely grid item controls (select, etc).
              if (rect.y < window.innerHeight * 0.55) continue;
              // Skip the Generate/Submit button
              const type = (btn.getAttribute('type') || '').toLowerCase();
              const text = (btn.textContent || '').trim().toLowerCase();
              if (type === 'submit') continue;
              if (text.includes('generate') || text.includes('submit')) continue;
              if (btn.id && btn.id.includes('submit')) continue;
              // Skip if button is inside a thumbnail/grid item (selection control)
              if (btn.closest('[class*="grid"], [class*="thumbnail"], [class*="card"], [class*="history"], [class*="overflow-x-hidden"]')) {
                // Allow if also inside a form (the form may have its own grid layout)
                if (!btn.closest('form')) continue;
              }

              const hasSvg = !!btn.querySelector('svg');
              const hasOnlyIcon = btn.children.length >= 1 && text.length < 15;
              const prio = 80 - depth * 10 + (hasSvg ? 5 : 0) + (hasOnlyIcon ? 3 : 0);
              candidates.push({
                el: btn,
                tag: `SIBLING-BTN-d${depth}${hasSvg ? '-SVG' : ''}`,
                w: rect.width, h: rect.height, x: rect.x, y: rect.y,
                priority: prio,
                text: text.slice(0, 30),
              });
            }

            // Also find visible LABELS in siblings (might be click targets)
            const lbls = [];
            if (sib.tagName === 'LABEL') lbls.push(sib);
            for (const l of sib.querySelectorAll('label')) lbls.push(l);
            for (const lbl of lbls) {
              const rect = lbl.getBoundingClientRect();
              if (rect.width < 20 || rect.height < 20) continue;
              if (rect.width > 300 || rect.height > 300) continue;
              // Same upper-grid filter
              if (rect.y < window.innerHeight * 0.55) continue;
              if (lbl.closest('[class*="grid"], [class*="thumbnail"], [class*="card"], [class*="history"], [class*="overflow-x-hidden"]')) {
                if (!lbl.closest('form')) continue;
              }
              const prio = 75 - depth * 10;
              candidates.push({
                el: lbl,
                tag: `SIBLING-LBL-d${depth}`,
                w: rect.width, h: rect.height, x: rect.x, y: rect.y,
                priority: prio,
              });
            }
          }
          el = parent;
          depth++;
        }

        // Sort candidates by priority (highest first)
        candidates.sort((a, b) => b.priority - a.priority);

        // Pick the highest priority visible candidate
        const best = candidates.find(c => c.w > 20 && c.h > 20) || null;

        if (best) best.el.setAttribute('data-ref-target-clickable', 'true');
        fileInput.setAttribute('data-ref-target-input', 'true');

        return {
          candidates: candidates.slice(0, 8).map(c => ({
            tag: c.tag,
            w: Math.round(c.w), h: Math.round(c.h),
            x: Math.round(c.x), y: Math.round(c.y),
            p: c.priority,
            t: c.text || undefined,
          })),
          chosen: best ? { tag: best.tag, w: Math.round(best.w), h: Math.round(best.h), x: Math.round(best.x), y: Math.round(best.y) } : null,
          inputAccept: fileInput.getAttribute('accept') || '',
          inputId: fileInput.id || null,
        };
      });

      console.log(`[REF]   Fresh page candidates: ${JSON.stringify(freshInfo)}`);

      if (freshInfo.error || !freshInfo.chosen) {
        console.warn(`[REF]   Fresh page: no visible click target found (${freshInfo.error || 'no chosen candidate'})`);
        const inputOnly = await page.evaluateHandle(() =>
          document.querySelector('[data-ref-target-input="true"]')
        );
        await page.evaluate(() => {
          const i = document.querySelector('[data-ref-target-input="true"]');
          if (i) i.removeAttribute('data-ref-target-input');
        });
        return { clickable: null, fileInput: inputOnly.asElement() };
      }

      const clickableHandle = await page.evaluateHandle(() =>
        document.querySelector('[data-ref-target-clickable="true"]')
      );
      const inputHandle = await page.evaluateHandle(() =>
        document.querySelector('[data-ref-target-input="true"]')
      );
      await page.evaluate(() => {
        const c = document.querySelector('[data-ref-target-clickable="true"]');
        if (c) c.removeAttribute('data-ref-target-clickable');
        const i = document.querySelector('[data-ref-target-input="true"]');
        if (i) i.removeAttribute('data-ref-target-input');
      });

      console.log(`[REF]   Trigger: fresh page ${freshInfo.chosen.tag} (${freshInfo.chosen.w}x${freshInfo.chosen.h}) at (${freshInfo.chosen.x},${freshInfo.chosen.y})`);
      return { clickable: clickableHandle.asElement(), fileInput: inputHandle.asElement() };
    }

    // ── NO broadest fallback ── hitting a filled slot's input causes replace-loop
    console.warn('[REF]   No upload trigger found in any strategy — skipping');
    return null;
  }

  /**
   * HARD GATE: Verify that the expected number of reference thumbnails
   * are actually visible in the Higgsfield UI reference slots.
   *
   * This is called AFTER uploadImageReferences() and BEFORE clicking Generate.
   * If fewer thumbnails are visible than expected, it retries the upload once.
   * If still mismatched after retry, throws an error to abort generation.
   *
   * @param {number} expectedCount - How many reference thumbnails should be visible
   * @param {string[]} references - The reference file paths (for retry)
   * @returns {number} Actual count of visible thumbnails
   */
  async verifyReferenceThumbnails(expectedCount, references = []) {
    const page = this.page;
    const sel = this.selectors.imageGeneration;

    // Count visible thumbnails in 56x56 reference slots
    // Count reference thumbnails in .size-14 containers inside the form
    const countThumbnails = async () => {
      return await page.evaluate(() => {
        const form = document.querySelector('form.image-form') || document.querySelector('form');
        if (!form) return 0;
        const slots = form.querySelectorAll('.size-14');
        let count = 0;
        for (const slot of slots) {
          const img = slot.querySelector('img');
          if (img && img.src && (img.src.startsWith('blob:') || img.src.startsWith('data:') || img.src.startsWith('http'))) {
            count++;
          }
        }
        return count;
      });
    };

    // First check
    let actual = await countThumbnails();
    console.log(`[GATE] Reference verification: ${actual}/${expectedCount} thumbnails visible`);

    if (actual >= expectedCount) {
      console.log('[GATE] ✓ All references confirmed in UI');
      return actual;
    }

    // Mismatch — wait a moment for late-loading thumbnails
    console.warn(`[GATE] Thumbnail mismatch (${actual}/${expectedCount}), waiting 3s for late loads...`);
    await page.waitForTimeout(3000);
    actual = await countThumbnails();
    console.log(`[GATE] After wait: ${actual}/${expectedCount} thumbnails visible`);

    if (actual >= expectedCount) {
      console.log('[GATE] ✓ All references confirmed after wait');
      return actual;
    }

    // Still mismatched — retry the full upload once
    console.warn(`[GATE] Still mismatched (${actual}/${expectedCount}). Clearing and re-uploading references...`);
    await this.clearImageReferences();
    await page.waitForTimeout(1000);
    await this.uploadImageReferences(references);
    await page.waitForTimeout(2000);

    // Final check after retry
    actual = await countThumbnails();
    console.log(`[GATE] After retry: ${actual}/${expectedCount} thumbnails visible`);

    if (actual >= expectedCount) {
      console.log('[GATE] ✓ All references confirmed after retry');
      return actual;
    }

    // Hard fail — do NOT proceed with generation
    throw new Error(
      `REFERENCE_GATE_FAILED: Expected ${expectedCount} reference thumbnails but only ${actual} visible in UI. ` +
      `References may not be uploading correctly. Aborting generation to prevent images without face consistency.`
    );
  }

  // ══════════════════════════════════════════════════════════
  // SHARED UTILITIES
  // ══════════════════════════════════════════════════════════

  /**
   * Set a video page dropdown option (Duration, Ratio, Resolution).
   * These are button-based dropdowns, not native <select> elements.
   * Click the setting button to open dropdown → click the desired option.
   */
  async setVideoDropdownOption(settingLabel, value) {
    const page = this.page;
    try {
      // Find and click the setting button (e.g., "Duration", "Ratio", "Resolution")
      const settingBtn = await page.getByText(settingLabel, { exact: false }).first();
      if (settingBtn) {
        await settingBtn.click();
        await page.waitForTimeout(500);

        // Click the desired option in the dropdown
        const option = await page.getByText(value, { exact: true }).first();
        if (option) {
          await option.click();
          await page.waitForTimeout(300);
          console.log(`[VID] Set ${settingLabel} to ${value}`);
        } else {
          console.warn(`[VID] Could not find option "${value}" in ${settingLabel} dropdown`);
        }
      } else {
        // Try finding by current value (e.g., button showing "8s" instead of "Duration")
        const currentBtn = await page.getByText(value, { exact: true }).first();
        if (currentBtn) {
          console.log(`[VID] ${settingLabel} already set to ${value}`);
        } else {
          console.warn(`[VID] Could not find ${settingLabel} button`);
        }
      }
    } catch (e) {
      console.warn(`[VID] Could not set ${settingLabel}: ${e.message}`);
    }
  }

  /**
   * Enable Unlimited mode to save credits (no credit cost for image generation).
   *
   * DOM (confirmed via Chrome inspection 2026-04-18):
   *   form#image-form contains TWO [role="switch"] elements:
   *     1st: Unlimited toggle (parent DIV textContent includes "Unlimited")
   *     2nd: Extra free gens toggle (parent DIV textContent includes "Extra free gens")
   *   State: data-state="on"|"off", aria-checked="true"|"false"
   */
  async enableUnlimited() {
    const page = this.page;
    try {
      const switches = await page.$$('form#image-form [role="switch"]');
      if (switches.length === 0) {
        console.warn('[IMG] No [role="switch"] found in form#image-form — Unlimited toggle missing');
        return;
      }
      // First switch is Unlimited
      const switchEl = switches[0];
      const state = await switchEl.getAttribute('data-state');
      const isOn = state === 'on' || (await switchEl.getAttribute('aria-checked')) === 'true';

      if (isOn) {
        console.log('[IMG] Unlimited already ON');
        return;
      }

      // ── Click target: the react-aria wrapper <button> PARENT of the switch ──
      // As of April 2026, the [role="switch"] is nested inside a react-aria
      // <button id="react-aria..."> wrapper. Clicking the switch element itself
      // does NOT toggle state — the React event handler lives on the parent.
      // IMPORTANT: After each click attempt, React may re-render the switch,
      // making old element handles stale. We re-query after each attempt.

      // Attempt 1: Playwright click on parent wrapper
      try {
        const clickTarget = await switchEl.evaluateHandle(el => el.parentElement);
        await clickTarget.asElement().click({ force: true });
      } catch (e1) {
        console.log(`[IMG] Attempt 1 (parent Playwright click) error: ${e1.message.split('\n')[0]}`);
      }
      await page.mouse.move(10, 10); // dismiss hover tooltip that blocks pointer events
      await page.waitForTimeout(500);

      // Re-query switch (React may have re-rendered)
      let freshSwitch = (await page.$$('form#image-form [role="switch"]'))[0];
      let newState = freshSwitch ? await freshSwitch.getAttribute('data-state') : 'off';
      if (newState === 'on') {
        console.log('[IMG] Unlimited toggled ON');
        return;
      }

      // Attempt 2: JS .click() on parent wrapper (re-query to avoid stale handle)
      console.log(`[IMG] Unlimited still off after Playwright click — retrying via JS evaluate on parent...`);
      freshSwitch = (await page.$$('form#image-form [role="switch"]'))[0];
      if (freshSwitch) {
        try { await freshSwitch.evaluate(el => el.parentElement.click()); } catch (_) {}
      }
      await page.mouse.move(10, 10);
      await page.waitForTimeout(500);

      freshSwitch = (await page.$$('form#image-form [role="switch"]'))[0];
      newState = freshSwitch ? await freshSwitch.getAttribute('data-state') : 'off';
      if (newState === 'on') {
        console.log('[IMG] Unlimited toggled ON (via JS parent click)');
        return;
      }

      // Attempt 3: direct Playwright click on re-queried switch (legacy fallback)
      console.log(`[IMG] Unlimited still off — trying direct switch click...`);
      freshSwitch = (await page.$$('form#image-form [role="switch"]'))[0];
      if (freshSwitch) {
        try { await freshSwitch.click({ force: true }); } catch (_) {}
      }
      await page.mouse.move(10, 10);
      await page.waitForTimeout(500);

      freshSwitch = (await page.$$('form#image-form [role="switch"]'))[0];
      newState = freshSwitch ? await freshSwitch.getAttribute('data-state') : 'off';

      if (newState === 'on') {
        console.log('[IMG] Unlimited toggled ON (via direct switch click)');
      } else {
        console.warn(`[IMG] Unlimited toggle FAILED after 3 attempts — data-state="${newState}". Will proceed but credits may be spent.`);
      }
    } catch (e) {
      console.warn(`[IMG] Could not toggle Unlimited: ${e.message}`);
    }
  }

  /**
   * Disable Unlimited mode — switch to credit-based generation.
   * Called when throttle is detected (generation taking >180s on free tier).
   */
  async disableUnlimited() {
    const page = this.page;
    try {
      const switches = await page.$$('form#image-form [role="switch"]');
      if (switches.length === 0) return;
      const switchEl = switches[0];
      const state = await switchEl.getAttribute('data-state');
      const isOn = state === 'on' || (await switchEl.getAttribute('aria-checked')) === 'true';

      if (!isOn) {
        console.log('[IMG] Unlimited already OFF');
        return;
      }

      // Click the react-aria parent wrapper (see enableUnlimited for rationale)
      await switchEl.evaluate(el => el.parentElement.click());
      await page.mouse.move(10, 10); // dismiss hover tooltip
      await page.waitForTimeout(500);

      let newState = await switchEl.getAttribute('data-state');
      if (newState === 'on') {
        // Still on — retry with Playwright click on parent
        const clickTarget = await switchEl.evaluateHandle(el => el.parentElement);
        await clickTarget.asElement().click({ force: true });
        await page.mouse.move(10, 10);
        await page.waitForTimeout(500);
        newState = await switchEl.getAttribute('data-state');
      }
      console.log(`[IMG] Unlimited toggled OFF (data-state="${newState}")`);
    } catch (e) {
      console.warn(`[IMG] Could not toggle Unlimited off: ${e.message}`);
    }
  }

  /**
   * Disable "Extra free gens" toggle in image generation.
   * Generates bonus lower-quality images we don't want.
   *
   * DOM: 2nd [role="switch"] in form#image-form.
   * State: data-state="on"|"off"
   */
  async disableExtraFree() {
    const page = this.page;
    try {
      const switches = await page.$$('form#image-form [role="switch"]');
      if (switches.length < 2) {
        console.log('[IMG] Extra free gens toggle not found (need 2 switches, found ' + switches.length + ')');
        return;
      }
      // Second switch is Extra free gens
      const switchEl = switches[1];
      const state = await switchEl.getAttribute('data-state');
      const isOn = state === 'on' || (await switchEl.getAttribute('aria-checked')) === 'true';

      if (!isOn) {
        console.log('[IMG] Extra free gens already OFF');
        return;
      }

      // Click the react-aria parent wrapper (see enableUnlimited for rationale)
      await switchEl.evaluate(el => el.parentElement.click());
      await page.mouse.move(10, 10); // dismiss hover tooltip
      await page.waitForTimeout(500);

      let newState = await switchEl.getAttribute('data-state');
      if (newState === 'on') {
        // Retry with Playwright click on parent
        const clickTarget = await switchEl.evaluateHandle(el => el.parentElement);
        await clickTarget.asElement().click({ force: true });
        await page.mouse.move(10, 10);
        await page.waitForTimeout(500);
        newState = await switchEl.getAttribute('data-state');
      }
      console.log(`[IMG] Extra free gens toggled OFF (data-state="${newState}")`);
    } catch (e) {
      console.warn(`[IMG] Could not toggle Extra free gens off: ${e.message}`);
    }
  }

  /**
   * Dismiss any image/video preview overlay that Higgsfield shows after generation.
   * The preview is a full-screen overlay with `data-asset-preview` images that
   * blocks clicks on the Generate button and other page elements.
   * Strategies: Escape key, click X button, click outside, or force-remove via JS.
   */
  /**
   * Dismiss Higgsfield promo/ad overlays that cover the prompt + upload area.
   *
   * These ads are shown on fresh page loads and typically:
   * - Are positioned with high z-index (>50)
   * - Cover a central portion of the viewport
   * - Have an X/close button at their top-right corner
   *
   * We find the ad by scanning for visible high-z-index elements, then look for
   * and click the X button at its top-right corner. Repeats up to 5 times since
   * dismissing one ad may reveal another.
   */
  async _dismissPromoAd() {
    const page = this.page;

    for (let pass = 0; pass < 5; pass++) {
      const adInfo = await page.evaluate(() => {
        // ── Strategy A: Find any sizeable panel that is NOT our upload form ──
        // Scan all elements, find candidates that look like promo panels.
        const allEls = document.querySelectorAll('div, section, aside, article, [role="dialog"], [role="alertdialog"]');
        const candidates = [];

        for (const el of allEls) {
          const rect = el.getBoundingClientRect();
          // Minimum size: must be a meaningful panel
          if (rect.width < 150 || rect.height < 150) continue;
          // Must be visible in viewport
          if (rect.x > window.innerWidth || rect.y > window.innerHeight) continue;
          if (rect.right < 0 || rect.bottom < 0) continue;

          // ── Skip viewport-sized containers (those are page content, not ads) ──
          // A genuine ad is significantly smaller than the viewport.
          const widthRatio = rect.width / window.innerWidth;
          const heightRatio = rect.height / window.innerHeight;
          if (widthRatio > 0.85 && heightRatio > 0.7) continue;

          const style = window.getComputedStyle(el);
          const z = parseInt(style.zIndex, 10) || 0;
          const pos = style.position;

          // Skip inline-flow elements (normal content)
          if (pos !== 'fixed' && pos !== 'absolute' && z === 0) continue;

          // Skip scrollable content containers (page content, not ads)
          const cls = (el.className || '').toString();
          if (cls.includes('overflow-auto') || cls.includes('overflow-y-auto') ||
              cls.includes('hide-scrollbar') || cls.includes('scroll')) continue;

          // Skip if this element contains our upload form
          if (el.querySelector('form.image-form')) continue;
          if (el.querySelector('input[type="file"][accept*="image"]')) continue;
          // Skip the generate button / main nav
          if (el.querySelector('button[type="submit"]')) continue;

          // Skip the <body> and <html>
          if (el === document.body || el === document.documentElement) continue;

          // Find ANY small X/close button inside this panel (no position constraint)
          const closeBtns = [];
          const btnSelectors = 'button, [role="button"], [aria-label*="close" i], [aria-label*="dismiss" i], [class*="close"]';
          for (const btn of el.querySelectorAll(btnSelectors)) {
            const bRect = btn.getBoundingClientRect();
            if (bRect.width > 60 || bRect.height > 60) continue;
            if (bRect.width < 8 || bRect.height < 8) continue;
            // Must be in top-right quadrant of the panel
            const relX = (bRect.x + bRect.width / 2) - rect.x;
            const relY = (bRect.y + bRect.height / 2) - rect.y;
            const isTopRight = relX > rect.width * 0.5 && relY < rect.height * 0.5;
            if (!isTopRight) continue;
            closeBtns.push({
              x: bRect.x + bRect.width / 2,
              y: bRect.y + bRect.height / 2,
              w: bRect.width,
              h: bRect.height,
              aria: btn.getAttribute('aria-label') || '',
              tag: btn.tagName,
            });
          }

          // Also check: does panel text contain ad-like phrases?
          const text = (el.textContent || '').toLowerCase();
          const adLikeText = text.includes('cinema') || text.includes('new model') ||
                             text.includes('introducing') || text.includes('try now') ||
                             text.includes('unleashed') || text.includes('upgrade');

          const lcls = (el.className || '').toString().toLowerCase();
          const classOverlay = lcls.includes('overlay') || lcls.includes('modal') || lcls.includes('popup') ||
                               lcls.includes('promo') || lcls.includes('banner');

          candidates.push({
            rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
            zIndex: z,
            position: pos,
            cls: lcls.slice(0, 80),
            closeBtns,
            hasCloseBtn: closeBtns.length > 0,
            adLikeText,
            classOverlay,
          });
        }

        // Prefer panels that: have a close button + ad-like text + overlay class
        candidates.sort((a, b) => {
          const scoreA = (a.hasCloseBtn ? 10 : 0) + (a.adLikeText ? 5 : 0) + (a.classOverlay ? 3 : 0) + a.zIndex / 100;
          const scoreB = (b.hasCloseBtn ? 10 : 0) + (b.adLikeText ? 5 : 0) + (b.classOverlay ? 3 : 0) + b.zIndex / 100;
          return scoreB - scoreA;
        });

        return {
          chosen: candidates[0] || null,
          totalCandidates: candidates.length,
        };
      });

      if (!adInfo.chosen || !adInfo.chosen.hasCloseBtn) {
        // ── Strategy B: Fallback — find small X button, but ONLY if an overlay exists ──
        // Previously this fired on ANY small X-looking button even when no ad was present,
        // which could click legitimate nav icons and cause navigation loops.
        // Now it requires evidence of an overlay/backdrop BEFORE firing.
        const hasOverlay = await page.evaluate(() => {
          // Look for a dark backdrop (common ad/modal pattern: bg-black with opacity)
          for (const el of document.querySelectorAll('div, section')) {
            const rect = el.getBoundingClientRect();
            // Must cover most of the viewport
            if (rect.width < window.innerWidth * 0.7 || rect.height < window.innerHeight * 0.5) continue;
            const style = window.getComputedStyle(el);
            if (style.position !== 'fixed' && style.position !== 'absolute') continue;
            const bg = style.backgroundColor;
            // rgba(0,0,0,0.5) type backdrops, or any class with backdrop/blur
            const hasBackdrop = bg.includes('rgba(0, 0, 0') ||
                                (el.className || '').toString().toLowerCase().match(/bg-black|backdrop|blur/);
            if (hasBackdrop) return true;
          }
          // Also check for explicit [role=dialog] that is large AND visible
          for (const el of document.querySelectorAll('[role="dialog"], [role="alertdialog"]')) {
            const rect = el.getBoundingClientRect();
            if (rect.width >= 300 && rect.height >= 200) return true;
          }
          return false;
        });

        if (!hasOverlay) {
          if (pass === 0) console.log(`[IMG] No promo/ad overlay detected (scanned ${adInfo.totalCandidates} candidates, no backdrop either)`);
          return;
        }

        const freeXBtn = await page.evaluate(() => {
          const btnSelectors = 'button, [role="button"]';
          for (const btn of document.querySelectorAll(btnSelectors)) {
            const bRect = btn.getBoundingClientRect();
            if (bRect.width < 15 || bRect.height < 15) continue;
            if (bRect.width > 50 || bRect.height > 50) continue;
            if (bRect.x < 0 || bRect.y < 0) continue;
            if (bRect.x > window.innerWidth || bRect.y > window.innerHeight) continue;

            // Skip buttons inside nav bars (they're legitimate navigation)
            if (btn.closest('nav, header, [class*="nav"], [class*="Nav"], [class*="header"], [class*="Header"]')) continue;

            const text = (btn.textContent || '').trim();
            const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
            const cls = (btn.className || '').toString().toLowerCase();

            const looksLikeClose = (
              text === '×' || text === 'x' || text === '✕' || text === '⨯' ||
              aria.includes('close') || aria.includes('dismiss') ||
              cls.includes('close') || cls.includes('dismiss')
            );

            // STRICTER: only match if explicitly close-looking. No more SVG+position guess.
            if (!looksLikeClose) continue;

            // Skip submit buttons
            if ((btn.getAttribute('type') || '').toLowerCase() === 'submit') continue;
            btn.setAttribute('data-ad-close-target', 'true');
            return {
              x: bRect.x + bRect.width / 2,
              y: bRect.y + bRect.height / 2,
              w: bRect.width,
              h: bRect.height,
              aria,
              text: text.slice(0, 20),
              matched: 'explicit-close-marker',
            };
          }
          return null;
        });

        if (freeXBtn) {
          console.log(`[IMG] Pass ${pass + 1}: Fallback — clicking X-looking button at (${Math.round(freeXBtn.x)}, ${Math.round(freeXBtn.y)}) matched=${freeXBtn.matched} text="${freeXBtn.text}" aria="${freeXBtn.aria}"`);
          await page.mouse.move(freeXBtn.x, freeXBtn.y);
          await page.waitForTimeout(150);
          await page.mouse.click(freeXBtn.x, freeXBtn.y);
          await page.waitForTimeout(800);
          await page.evaluate(() => {
            const el = document.querySelector('[data-ad-close-target="true"]');
            if (el) el.removeAttribute('data-ad-close-target');
          });
          continue;
        }

        if (pass === 0) console.log(`[IMG] Overlay detected but no explicit close button found — leaving it alone`);
        return;
      }

      const a = adInfo.chosen;
      console.log(`[IMG] Pass ${pass + 1}: Ad panel detected — z=${a.zIndex}, pos=${a.position}, size=${a.rect.w}x${a.rect.h}, adText=${a.adLikeText}, class="${a.cls}"`);

      // Click the smallest top-right close button (most likely the real X)
      a.closeBtns.sort((x, y) => (x.w * x.h) - (y.w * y.h));
      const target = a.closeBtns[0];
      console.log(`[IMG] Clicking close button at (${Math.round(target.x)}, ${Math.round(target.y)}) — <${target.tag}> aria="${target.aria}" size=${Math.round(target.w)}x${Math.round(target.h)}`);

      await page.mouse.move(target.x, target.y);
      await page.waitForTimeout(150);
      await page.mouse.click(target.x, target.y);
      await page.waitForTimeout(1000);
    }

    console.warn('[IMG] Ad dismissal loop exhausted — proceeding anyway');
  }

  /**
   * Deselect any history grid items that are currently selected (checkmark visible).
   * Higgsfield's history grid supports multi-select for batch operations. An accidental
   * click on a history thumbnail toggles a checkbox state. We need to unselect to
   * avoid downstream confusion (e.g., "Reference" button targeting the selected item).
   *
   * Strategy:
   *   - Find any visible checkboxes/checkmark indicators in the history grid area
   *   - For each selected one, click its container to toggle off
   *   - Or click the deselect-all button if Higgsfield provides one
   */
  async _deselectHistoryItems() {
    const page = this.page;
    try {
      const result = await page.evaluate(() => {
        // Look for SELECTED indicators in the history grid:
        // - Checked checkboxes (input type="checkbox" :checked)
        // - Visible checkmark icons inside grid items
        // - Elements with aria-selected="true" or data-selected attributes
        const selectedItems = [];

        // Strategy 1: Find checked checkboxes
        for (const cb of document.querySelectorAll('input[type="checkbox"]')) {
          if (cb.checked) {
            const rect = cb.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              selectedItems.push({ kind: 'checkbox', x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
            }
          }
        }

        // Strategy 2: Find elements with aria-selected="true" or data-selected="true"
        for (const el of document.querySelectorAll('[aria-selected="true"], [data-selected="true"], [class*="selected"]')) {
          const rect = el.getBoundingClientRect();
          // Must be a grid-item-sized element (not the whole grid)
          if (rect.width < 100 || rect.height < 100) continue;
          if (rect.width > window.innerWidth * 0.7) continue;
          // Find a checkmark/icon inside it to click
          const checkmark = el.querySelector('[class*="check"], svg, button');
          if (checkmark) {
            const cRect = checkmark.getBoundingClientRect();
            if (cRect.width > 0 && cRect.height > 0) {
              selectedItems.push({ kind: 'aria-selected', x: cRect.x + cRect.width / 2, y: cRect.y + cRect.height / 2 });
            }
          }
        }

        // Strategy 3: Look for visible checkmark icons (the white-circle-with-check pattern)
        for (const svg of document.querySelectorAll('svg')) {
          const rect = svg.getBoundingClientRect();
          if (rect.width < 16 || rect.height < 16) continue;
          if (rect.width > 40 || rect.height > 40) continue;
          // Check if this SVG is in a grid item position (not the form area)
          // Form is at the bottom; history grid is at the top
          if (rect.y > window.innerHeight * 0.7) continue;
          // Check if SVG path looks like a check (M ... L ... pattern with checkmark shape)
          const paths = svg.querySelectorAll('path');
          let looksLikeCheck = false;
          for (const p of paths) {
            const d = p.getAttribute('d') || '';
            // Common checkmark patterns
            if (d.includes('5 13l4 4L19 7') || d.includes('20 6L9 17l-5-5') ||
                d.match(/M\d+\s+\d+\s*[lL]\s*-?\d+\s+-?\d+\s*[lL]\s*-?\d+\s+-?\d+/)) {
              looksLikeCheck = true;
              break;
            }
          }
          if (looksLikeCheck) {
            // Walk up to find the clickable parent (button or div with click handler)
            let parent = svg.parentElement;
            for (let depth = 0; depth < 4 && parent; depth++) {
              const pRect = parent.getBoundingClientRect();
              if (pRect.width >= 16 && pRect.height >= 16 && pRect.width <= 50 && pRect.height <= 50) {
                selectedItems.push({ kind: 'check-svg', x: pRect.x + pRect.width / 2, y: pRect.y + pRect.height / 2 });
                break;
              }
              parent = parent.parentElement;
            }
          }
        }

        return { count: selectedItems.length, items: selectedItems.slice(0, 10) };
      });

      if (result.count === 0) return;

      console.log(`[IMG] Found ${result.count} selected history item(s) — deselecting`);
      for (const item of result.items) {
        try {
          await page.mouse.move(item.x, item.y);
          await page.waitForTimeout(100);
          await page.mouse.click(item.x, item.y);
          await page.waitForTimeout(300);
          console.log(`[IMG]   Deselected ${item.kind} at (${Math.round(item.x)}, ${Math.round(item.y)})`);
        } catch (e) {
          console.warn(`[IMG]   Deselect click failed: ${e.message.split('\n')[0]}`);
        }
      }
    } catch (e) {
      console.warn(`[IMG] _deselectHistoryItems error: ${e.message.split('\n')[0]}`);
    }
  }

  async _dismissPreviewOverlay() {
    const page = this.page;
    try {
      // Check if there's a blocking preview overlay
      const hasPreview = await page.evaluate(() => {
        const preview = document.querySelector('img[data-asset-preview]');
        if (!preview) return false;
        // Check if it's actually covering the page (visible and large)
        const rect = preview.getBoundingClientRect();
        return rect.width > 200 && rect.height > 200;
      });

      if (!hasPreview) return;

      console.log('[IMG] Dismissing image preview overlay...');

      // Strategy 1: Press Escape to close any overlay/modal
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);

      // Check if it's gone
      const stillThere = await page.$('img[data-asset-preview]');
      if (!stillThere) {
        console.log('[IMG] Preview dismissed via Escape');
        return;
      }

      // Strategy 2: Click any close/X button in the overlay area
      const closeBtn = await page.$('[class*="close"], button:has(svg[class*="close"]), [aria-label="Close"]');
      if (closeBtn) {
        await closeBtn.click({ force: true });
        await page.waitForTimeout(500);
        console.log('[IMG] Preview dismissed via close button');
        return;
      }

      // Strategy 3: Navigate back to the generation page to force-reset
      console.log('[IMG] Force-navigating to clear preview...');
      const sel = this.selectors.imageGeneration;
      await page.goto(sel.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2500);

      console.log('[IMG] Preview cleared via navigation');
    } catch (e) {
      console.warn(`[IMG] Preview dismiss failed: ${e.message}`);
    }
  }

  async isLoggedIn() {
    try {
      const page = this.page;
      if (!page) return true; // No page = can't check, assume logged in

      // Two-signal check: positive (Assets link = logged in) AND negative
      // (Login/Sign up buttons = logged out). Either signal is definitive.
      // The Assets link only appears when authenticated. The Login/Sign up
      // buttons only appear when NOT authenticated. Check both because
      // different pages may render one signal before the other.
      const authState = await page.evaluate(() => {
        // Signal 1: Assets link — only visible when logged in
        // Note: cannot use Playwright's :has-text() inside evaluate — use standard CSS only
        const hasAssets = !!document.querySelector('a[href="/asset/all"], a[href*="/asset"]')
          || Array.from(document.querySelectorAll('a, button')).some(el => (el.textContent || '').trim() === 'Assets');

        // Signal 2: Login/Sign up buttons — only visible when logged out
        // Check nav/header area for these specific buttons
        const allLinks = Array.from(document.querySelectorAll('a, button'));
        const hasLoginBtn = allLinks.some(el => {
          const text = (el.textContent || '').trim().toLowerCase();
          return text === 'login' || text === 'log in';
        });
        const hasSignUpBtn = allLinks.some(el => {
          const text = (el.textContent || '').trim().toLowerCase();
          return text === 'sign up' || text === 'signup';
        });

        // Signal 3: Login page redirect
        const isLoginPage = window.location.pathname.includes('/login') || window.location.pathname.includes('/signin');

        return { hasAssets, hasLoginBtn, hasSignUpBtn, isLoginPage };
      });

      // Definitive logged-out signals
      if (authState.isLoginPage || (authState.hasLoginBtn && authState.hasSignUpBtn)) {
        console.log(`[SESSION] isLoggedIn: FALSE — ${authState.isLoginPage ? 'on login page' : 'Login/Sign up buttons visible'}`);
        return false;
      }

      // Definitive logged-in signal
      if (authState.hasAssets) {
        console.log('[SESSION] isLoggedIn: TRUE — Assets link visible');
        return true;
      }

      // Neither signal found — wait for page to render and retry
      console.log('[SESSION] Login state ambiguous on first check, waiting 3s...');
      await page.waitForTimeout(3000);

      const retry = await page.evaluate(() => {
        const hasAssets = !!document.querySelector('a[href="/asset/all"], a[href*="/asset"]');
        const allLinks = Array.from(document.querySelectorAll('a, button'));
        const hasLoginBtn = allLinks.some(el => (el.textContent || '').trim().toLowerCase() === 'login' || (el.textContent || '').trim().toLowerCase() === 'log in');
        const hasSignUpBtn = allLinks.some(el => (el.textContent || '').trim().toLowerCase() === 'sign up' || (el.textContent || '').trim().toLowerCase() === 'signup');
        return { hasAssets, hasLoginBtn, hasSignUpBtn };
      });

      if (retry.hasLoginBtn && retry.hasSignUpBtn) {
        console.log('[SESSION] isLoggedIn: FALSE — Login/Sign up buttons visible (retry)');
        return false;
      }
      if (retry.hasAssets) {
        console.log('[SESSION] isLoggedIn: TRUE — Assets link visible (retry)');
        return true;
      }

      console.log('[SESSION] isLoggedIn: AMBIGUOUS — assuming true (no definitive signal)');
      return true;
    } catch (e) {
      console.warn(`[SESSION] isLoggedIn check error: ${e.message}`);
      return true; // Assume logged in if check fails
    }
  }

  /**
   * Wait for generation to complete. Returns the CDN URL of our generated asset.
   *
   * STRATEGY (layered combo):
   *   Layer 1 — API job tracking (primary, 100% reliable):
   *     Intercept job UUID from network → poll /jobs/{id} API → extract results.raw.url
   *   Layer 2 — Timestamp-gated CDN URL diffing (fallback):
   *     Scan History tab for new URLs → parse embedded timestamp from CDN filename
   *     → reject if timestamp predates our Generate click
   *
   * @param {string} type - 'image' or 'video'
   * @param {number} timeout - Max wait time in ms
   * @param {string} submittedPrompt - The prompt we submitted (for logging)
   * @param {Promise<string|null>} jobIdPromise - From _interceptJobId(), started before Generate click
   * @returns {string|null} The CDN URL of our generated asset
   */
  async waitForGeneration(type, timeout = 300000, submittedPrompt = '', jobIdPromise = null) {
    const page = this.page;
    const generateClickTime = Date.now();

    // ══════════════════════════════════════════════════════════
    // LAYER 1: API-based job tracking (primary)
    // ══════════════════════════════════════════════════════════
    if (jobIdPromise) {
      try {
        // Wait up to 15s for the job UUID to appear in network traffic
        const jobId = await Promise.race([
          jobIdPromise,
          new Promise(resolve => setTimeout(() => resolve(null), 15000)),
        ]);

        if (jobId) {
          console.log(`[WAIT] Layer 1 (API): Job UUID captured — ${jobId}`);
          const result = await this._pollJobCompletion(jobId, timeout);
          if (result && result.rawUrl) {
            console.log(`[WAIT] Layer 1 SUCCESS — returning API-confirmed CDN URL`);
            return result.rawUrl;
          }
        } else {
          console.warn('[WAIT] Layer 1: No job UUID captured — falling back to Layer 2');
        }
      } catch (err) {
        // Timeouts, cancellations, and server failures must propagate — don't fall to Layer 2
        if (err.message === 'Cancelled' || (err.message.includes('Target') && err.message.includes('closed'))) {
          throw err;
        }
        // Server-side generation failure (e.g. "Failed — Credits refunded") — nothing to find in Layer 2
        if (err.serverFailed || err.message.includes('GENERATION_FAILED')) {
          throw err;
        }
        console.warn(`[WAIT] Layer 1 failed: ${err.message} — falling back to Layer 2`);
      }
    } else {
      console.log('[WAIT] No jobIdPromise provided — using Layer 2 directly');
    }

    // ══════════════════════════════════════════════════════════
    // LAYER 2: Timestamp-gated CDN URL diffing (fallback)
    // ══════════════════════════════════════════════════════════
    console.log('[WAIT] Layer 2 (fallback): Timestamp-gated CDN URL diffing');

    const startTime = Date.now();
    const pollInterval = 5000;
    let wasGenerating = false;
    let promptCheckAttempts = 0;
    const maxPromptChecks = 5;

    // Click History tab to watch for new results
    const historyTab = await page.$('button:has-text("History")');
    if (historyTab) {
      await historyTab.click().catch(() => {});
      await page.waitForTimeout(1500);
    }

    // Snapshot existing CDN URLs
    const initialUrls = await this._getHistoryCdnUrls(type);
    let initialCount = await this.countHistoryItems(type);
    console.log(`[WAIT] L2 Initial: ${initialCount} items, ${initialUrls.size} CDN URLs`);

    while (Date.now() - startTime < timeout) {
      if (this.cancelled) throw new Error('Cancelled');

      await page.waitForTimeout(pollInterval);

      // Check for error messages
      const errorEl = await page.$('.error-message, [data-testid="generation-error"]');
      if (errorEl) {
        const errorText = await errorEl.textContent().catch(() => 'Unknown generation error');
        throw new Error(`Generation failed: ${errorText}`);
      }

      const statusText = await page.evaluate(() => {
        const body = document.body.innerText;
        if (body.includes('Queued')) return 'queued';
        if (body.includes('Generating')) return 'generating';
        return 'unknown';
      }).catch(() => 'unknown');

      if (statusText === 'generating') wasGenerating = true;
      const elapsed = Math.round((Date.now() - startTime) / 1000);

      // === Detect new CDN URLs ===
      const currentUrls = await this._getHistoryCdnUrls(type);
      const newUrls = [...currentUrls].filter(url => !initialUrls.has(url));

      if (newUrls.length > 0) {
        // TIMESTAMP GATE: check if this URL was created after our Generate click
        const cdnDate = this._parseCdnTimestamp(newUrls[0]);
        const clickDate = new Date(generateClickTime);

        if (cdnDate) {
          // CDN timestamps are UTC; allow 2-minute tolerance for clock skew
          const twoMinBefore = new Date(clickDate.getTime() - 120000);
          if (cdnDate < twoMinBefore) {
            console.log(`[WAIT] L2 REJECTED: CDN timestamp ${cdnDate.toISOString()} predates Generate click ${clickDate.toISOString()} — stale image`);
            for (const u of newUrls) initialUrls.add(u);
            continue;
          }
        }

        console.log(`[WAIT] L2 ACCEPTED: New ${type} CDN URL, timestamp OK (${elapsed}s)`);
        console.log(`[WAIT] URL: ${newUrls[0].slice(0, 120)}...`);
        return newUrls[0];
      }

      // === Count-based detection ===
      const currentCount = await this.countHistoryItems(type);
      if (currentCount > initialCount) {
        console.log(`[WAIT] L2: Count increased (${initialCount} -> ${currentCount}) — waiting for URL (${elapsed}s)`);
        await page.waitForTimeout(1500);
        const finalUrls = await this._getHistoryCdnUrls(type);
        const finalNew = [...finalUrls].filter(url => !initialUrls.has(url));
        if (finalNew.length > 0) {
          const cdnDate = this._parseCdnTimestamp(finalNew[0]);
          const clickDate = new Date(generateClickTime);
          if (cdnDate && cdnDate < new Date(clickDate.getTime() - 120000)) {
            console.log(`[WAIT] L2 REJECTED after count change: stale timestamp`);
            for (const u of finalNew) initialUrls.add(u);
            initialCount = currentCount;
            continue;
          }
          console.log(`[WAIT] L2 ACCEPTED after count change (${elapsed}s)`);
          return finalNew[0];
        }
        // Count increased but URL not captured — generation likely completed.
        // Return null so download falls back to card-click methods, but log a clear warning.
        console.warn(`[WAIT] L2 WARNING: History count up (${initialCount} → ${currentCount}) but no CDN URL extracted. Download will use card-click fallback.`);
        return null;
      }

      // === Status transition detection ===
      if (wasGenerating && statusText === 'unknown') {
        promptCheckAttempts++;
        if (promptCheckAttempts >= maxPromptChecks) {
          console.log(`[WAIT] L2: Status 'unknown' for ${promptCheckAttempts} checks — assuming complete (${elapsed}s)`);
          return null;
        }
      }

      console.log(`[WAIT] L2: ${statusText} | items: ${currentCount}/${initialCount} | urls: ${currentUrls.size}/${initialUrls.size} | ${elapsed}s`);
    }

    throw new Error(`Generation timed out after ${timeout / 1000}s`);
  }

  /**
   * Collect all CDN image/video URLs currently visible in the History grid.
   * Used to detect new items by diffing before/after generation.
   */
  async _getHistoryCdnUrls(type = 'image') {
    try {
      const urls = await this.page.evaluate((mediaType) => {
        const result = [];
        if (mediaType === 'video') {
          document.querySelectorAll('video[src]').forEach(v => {
            if (v.src) result.push(v.src);
          });
        } else {
          // Collect all image src URLs from history grid that look like CDN assets
          document.querySelectorAll('img[src]').forEach(img => {
            const src = img.src;
            // Only CDN/asset images — filter out UI icons, logos, avatars
            if ((src.includes('higgs') || src.includes('cloudfront') || src.includes('cdn')) &&
                img.naturalWidth > 50) {
              result.push(src);
            }
          });
        }
        return result;
      }, type);
      return new Set(urls);
    } catch {
      return new Set();
    }
  }

  /**
   * Verify a detected CDN URL belongs to our generation by opening the card lightbox
   * and comparing the prompt text against our submitted prompt.
   *
   * @param {string} detectedUrl - The CDN URL of the image to verify
   * @param {string} submittedPrompt - The prompt we submitted for generation
   * @returns {Promise<boolean>} true if prompts match, false if not our image
   */
  async _verifyPromptMatch(detectedUrl, submittedPrompt) {
    if (!submittedPrompt || submittedPrompt.length < 20) {
      console.log('[VERIFY] No submitted prompt to compare — skipping verification');
      return true; // Can't verify without a prompt
    }

    const page = this.page;
    try {
      // Find the img element with this CDN URL (or partial match)
      // CDN URLs get wrapped by images.higgs.ai proxy, so match on the cloudfront portion
      const urlFragment = detectedUrl.includes('cloudfront.net')
        ? detectedUrl.match(/cloudfront\.net[^&]*/)?.[0] || detectedUrl.slice(0, 80)
        : detectedUrl.slice(0, 80);

      const clicked = await page.evaluate((fragment) => {
        const imgs = document.querySelectorAll('img[src]');
        for (const img of imgs) {
          if (img.src.includes(fragment) && img.naturalWidth > 50) {
            img.click();
            return true;
          }
        }
        return false;
      }, urlFragment);

      if (!clicked) {
        console.log('[VERIFY] Could not find card for detected URL — skipping verification');
        return true; // Can't find card, don't block
      }

      // Wait for lightbox to open
      await page.waitForTimeout(2000);

      // Extract prompt text from the lightbox details panel
      const lightboxPrompt = await page.evaluate(() => {
        // The prompt is in a textbox/contenteditable element in the details panel
        // Look for text content after "PROMPT" heading
        const allEls = document.querySelectorAll('div, span, p');
        let foundPrompt = false;
        for (const el of allEls) {
          const text = el.textContent.trim();
          if (text === 'PROMPT') { foundPrompt = true; continue; }
          if (text === 'INFORMATION' || text === 'Comments') break;
          if (foundPrompt && text.length > 15 && !text.includes('Copy')) {
            return text;
          }
        }
        // Fallback: look for textbox in the right panel
        const textbox = document.querySelector('[role="textbox"], textarea');
        if (textbox) {
          const t = textbox.textContent || textbox.value || '';
          if (t.length > 15) return t;
        }
        return '';
      });

      // Close lightbox
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);

      if (!lightboxPrompt || lightboxPrompt.length < 10) {
        console.log('[VERIFY] Could not extract prompt from lightbox — skipping verification');
        return true; // Can't verify, don't block
      }

      // Fuzzy match: extract distinctive words from our prompt (3+ chars, not common)
      const commonWords = new Set(['the', 'and', 'with', 'for', 'from', 'that', 'this', 'are', 'was', 'has', 'not', 'but', 'all', 'can', 'her', 'his', 'she', 'him', 'its']);
      const ourWords = submittedPrompt.toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 3 && !commonWords.has(w));
      const distinctiveWords = [...new Set(ourWords)].slice(0, 20);

      const lightboxLower = lightboxPrompt.toLowerCase();
      const matchCount = distinctiveWords.filter(w => lightboxLower.includes(w)).length;
      const matchRatio = distinctiveWords.length > 0 ? matchCount / distinctiveWords.length : 0;

      console.log(`[VERIFY] Prompt match: ${matchCount}/${distinctiveWords.length} distinctive words (${(matchRatio * 100).toFixed(0)}%)`);
      console.log(`[VERIFY] Our prompt snippet: "${submittedPrompt.substring(0, 60)}..."`);
      console.log(`[VERIFY] Lightbox prompt snippet: "${lightboxPrompt.substring(0, 60)}..."`);

      // Require at least 40% match (accounts for Higgsfield potentially truncating)
      if (matchRatio >= 0.4) {
        console.log('[VERIFY] MATCH — this is our generation');
        return true;
      } else {
        console.log('[VERIFY] NO MATCH — this is NOT our generation, will keep polling');
        return false;
      }
    } catch (err) {
      console.warn(`[VERIFY] Verification failed: ${err.message} — skipping`);
      // Close lightbox if open
      await page.keyboard.press('Escape').catch(() => {});
      return true; // Don't block on verification errors
    }
  }

  // ══════════════════════════════════════════════════════════
  // API-BASED JOB TRACKING (Primary detection strategy)
  // ══════════════════════════════════════════════════════════

  /**
   * Set up a network response listener to capture the Higgsfield job UUID.
   * Call this BEFORE clicking Generate — the first /jobs/{uuid}/status poll
   * from the frontend reveals the job ID.
   *
   * @returns {Promise<string|null>} Resolves with the job UUID, or null on timeout
   */
  _interceptJobId() {
    return new Promise((resolve) => {
      let resolved = false;
      const handler = (response) => {
        if (resolved) return;
        const url = response.url();
        const match = url.match(/fnf\.higgsfield\.ai\/jobs\/([a-f0-9-]{36})\/status/);
        if (match) {
          resolved = true;
          this.page.removeListener('response', handler);
          console.log(`[API] Intercepted job UUID: ${match[1]}`);
          resolve(match[1]);
        }
      };
      this.page.on('response', handler);
      // Timeout after 30s — if no job ID captured, resolve null
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          this.page.removeListener('response', handler);
          console.warn('[API] Job UUID interception timed out (30s)');
          resolve(null);
        }
      }, 30000);
    });
  }

  /**
   * Poll the Higgsfield jobs API until generation completes.
   * Uses fetch() from within the page context so auth cookies are included.
   *
   * @param {string} jobId - The UUID of the generation job
   * @param {number} timeout - Max wait time in ms
   * @returns {Promise<{url: string, prompt: string, createdAt: number}>}
   */
  async _pollJobCompletion(jobId, timeout = 300000) {
    const startTime = Date.now();
    const pollInterval = 3000;

    // ── Progressive Wait Configuration ──
    // Instead of hard-throwing GENERATION_THROTTLED at 180s, we use progressive
    // extensions. At 90% of the base threshold, extend by 10% of the original.
    // This gives slow Unlimited generations a chance to complete (many finish at
    // 190-240s under load) without burning credits on a re-submission.
    const THROTTLE_BASE_MS = 180000;          // 3 min — baseline "likely throttled" threshold
    const EXTENSION_TRIGGER_PCT = 0.90;       // Trigger extension at 90% of current deadline
    const EXTENSION_AMOUNT_PCT = 0.10;        // Each extension adds 10% of THROTTLE_BASE_MS
    const MAX_EXTENSIONS = 3;                 // Cap: max 3 extensions (180 + 54 = 234s max)

    let currentDeadline = THROTTLE_BASE_MS;
    let extensionsUsed = 0;
    let throttleWarned = false;

    let pollCount = 0;

    while (Date.now() - startTime < timeout) {
      if (this.cancelled) throw new Error('Cancelled');
      pollCount++;

      const elapsed = Date.now() - startTime;

      // ── Progressive Wait: extend deadline at 90% threshold ──
      if (!this.throttled && elapsed > currentDeadline * EXTENSION_TRIGGER_PCT && extensionsUsed < MAX_EXTENSIONS) {
        extensionsUsed++;
        const extension = THROTTLE_BASE_MS * EXTENSION_AMOUNT_PCT;
        currentDeadline += extension;
        console.warn(`[THROTTLE] ⏳ Progressive wait: ${Math.round(elapsed / 1000)}s elapsed, extending deadline by ${Math.round(extension / 1000)}s → new deadline ${Math.round(currentDeadline / 1000)}s (extension ${extensionsUsed}/${MAX_EXTENSIONS})`);
      }

      // ── Soft Throttle: all extensions exhausted, flag for next gen ──
      // Don't throw GENERATION_THROTTLED (which triggers context nuke + re-submit).
      // Instead, set the throttle flag and let the current job time out normally.
      // The recovery system (CDN URL / Asset library) handles the orphaned job.
      // Next generation will use credits from the start.
      if (!throttleWarned && !this.throttled && elapsed > currentDeadline) {
        throttleWarned = true;
        this.throttled = true;
        console.warn(`[THROTTLE] ══════════════════════════════════════════════════════`);
        console.warn(`[THROTTLE] Unlimited tier throttled — generation exceeded ${Math.round(currentDeadline / 1000)}s (${extensionsUsed} extensions used)`);
        console.warn(`[THROTTLE] Soft flag set — next generation will use credits. Current job continues polling until hard timeout.`);
        console.warn(`[THROTTLE] ══════════════════════════════════════════════════════`);
        // DON'T throw — keep polling. The job might still complete.
        // If it doesn't complete by the hard timeout, a normal timeout error fires
        // and the recovery system picks it up on next restart.
      }

      const result = await this.page.evaluate(async (id) => {
        try {
          const resp = await fetch(`https://fnf.higgsfield.ai/jobs/${id}`);
          if (!resp.ok) return { status: 'fetch_error', code: resp.status, body: await resp.text().catch(() => '') };
          const data = await resp.json();
          return {
            status: data.status || 'unknown',
            rawUrl: data.results?.raw?.url || null,
            minUrl: data.results?.min?.url || null,
            prompt: data.params?.prompt || '',
            createdAt: data.created_at || null,
            // Failure details (credits refunded scenario)
            error: data.error || data.message || data.reason || null,
            refunded: data.refunded || data.credits_refunded || null,
            // Diagnostic: capture all top-level keys and results on first polls
            _keys: Object.keys(data).join(','),
            _resultsType: typeof data.results,
            _resultsKeys: data.results ? Object.keys(data.results).join(',') : 'null',
            _raw: data.results ? JSON.stringify(data.results).slice(0, 300) : 'null',
          };
        } catch (e) {
          return { status: 'fetch_error', error: e.message };
        }
      }, jobId);

      const elapsedSec = Math.round((Date.now() - startTime) / 1000);

      // Diagnostic logging on first poll — see full response structure
      if (pollCount === 1) {
        console.log(`[API] First poll response keys: ${result._keys}`);
        console.log(`[API] Results type: ${result._resultsType}, keys: ${result._resultsKeys}`);
        console.log(`[API] Results raw: ${result._raw}`);
      }

      // Check for completion — status "completed" OR results.raw.url present
      if ((result.status === 'completed' || result.rawUrl) && result.rawUrl) {
        console.log(`[API] Job ${jobId} completed in ${elapsedSec}s (status: ${result.status})`);
        console.log(`[API] CDN URL: ${result.rawUrl.slice(0, 120)}...`);
        console.log(`[API] Prompt: "${result.prompt.slice(0, 80)}..."`);
        // If we set throttle flag during this wait, reset it — the gen actually completed
        if (throttleWarned) {
          console.log(`[THROTTLE] ✓ Generation completed at ${elapsedSec}s despite slow start — resetting throttle flag`);
          this.throttled = false;
        }
        return result;
      }

      if (result.status === 'failed') {
        const reason = result.error || 'unknown reason';
        const refunded = result.refunded;
        console.error(`[API] Job ${jobId} FAILED: ${reason} (${elapsedSec}s)${refunded ? ' — credits refunded' : ''}`);

        // ── Check if this is an NSFW/restricted content rejection ──
        // The API error field is the authoritative source for NSFW status.
        // We do NOT scan the page UI for NSFW text — the history panel shows
        // NSFW badges from PREVIOUS generations, which causes false positives
        // on unrelated prompts (e.g. empty location shots like "Corporate boardroom").
        // See: Session 14 bug — location prompts flagged NSFW because innerText
        // scan picked up residual NSFW badges from earlier portrait rejections.
        const reasonLower = reason.toLowerCase();
        const isNsfw = reasonLower.includes('nsfw') || reasonLower.includes('restricted') || reasonLower.includes('content policy') || reasonLower.includes('safety');

        if (isNsfw) {
          console.error(`[API] ═══ NSFW/RESTRICTED CONTENT DETECTED ═══`);
          console.error(`[API] The character description likely resembles a real person too closely.`);
          console.error(`[API] The description must be rewritten with more fictional/stylized traits.`);
          const err = new Error(`NSFW_REJECTED: Restricted content detected — character description must be rewritten (job ${jobId})`);
          err.nsfwRejected = true;
          err.serverFailed = true;
          err.retryable = false; // NOT retryable with the same prompt
          err.failedJobId = jobId;
          throw err;
        }

        const err = new Error(`GENERATION_FAILED: Server-side failure (job ${jobId}): ${reason}`);
        err.retryable = true;  // Credits refunded — safe to retry
        err.serverFailed = true;
        err.failedJobId = jobId;
        throw err;
      }

      if (result.status === 'fetch_error') {
        console.warn(`[API] Fetch error polling job ${jobId}: ${result.error || result.code || result.body?.slice(0, 100)} (${elapsedSec}s)`);
      } else {
        // Log extra detail every 10th poll to track if results field changes
        if (pollCount % 10 === 0) {
          console.log(`[API] Job ${jobId}: ${result.status} | results: ${result._raw?.slice(0, 100)} (${elapsedSec}s)`);
        } else {
          console.log(`[API] Job ${jobId}: ${result.status} (${elapsedSec}s)`);
        }
      }

      await this.page.waitForTimeout(pollInterval);
    }

    throw new Error(`Job ${jobId} timed out after ${timeout / 1000}s`);
  }

  /**
   * Parse the timestamp embedded in a Higgsfield CDN filename.
   * Format: hf_YYYYMMDD_HHMMSS_{uuid}.png
   *
   * @param {string} cdnUrl - The CDN URL
   * @returns {Date|null} The parsed date, or null if parsing fails
   */
  _parseCdnTimestamp(cdnUrl) {
    const match = cdnUrl.match(/hf_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})_/);
    if (!match) return null;
    const [, y, mo, d, h, mi, s] = match;
    return new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`);
  }

  async countHistoryItems(type = 'image') {
    try {
      if (type === 'video') {
        // Video history items contain <video> elements
        const items = await this.page.$$('video[src]');
        return items.length;
      }
      // Image history: count images visible in the history grid
      // Try multiple selectors to handle UI changes
      const count = await this.page.evaluate(() => {
        // Strategy 1: grid container with direct div children (original layout)
        const grid1 = document.querySelector('.overflow-x-hidden.grid');
        if (grid1 && grid1.children.length > 0) return grid1.children.length;

        // Strategy 2: any grid with image thumbnails
        const imgs = document.querySelectorAll('[class*="grid"] img[src*="higgs"]');
        if (imgs.length > 0) return imgs.length;

        // Strategy 3: history tab image cards — look for img elements inside divs with cursor pointer
        const cards = document.querySelectorAll('div[style*="cursor: pointer"] img, div[class*="cursor-pointer"] img');
        if (cards.length > 0) return cards.length;

        // Strategy 4: count all substantial images on page (exclude icons/logos < 100px)
        const allImgs = document.querySelectorAll('img[src*="higgs"], img[src*="cloudfront"]');
        let count = 0;
        for (const img of allImgs) {
          if (img.naturalWidth > 100 || img.width > 100) count++;
        }
        return count;
      });
      return count;
    } catch {
      return 0;
    }
  }

  // ══════════════════════════════════════════════════════════
  // DOWNLOAD — Images
  // ══════════════════════════════════════════════════════════

  /**
   * Download the most recently generated image.
   *
   * Strategy (ordered by reliability):
   * 1. Click first history card → lightbox opens → click "Download" button
   * 2. Extract image src from lightbox and fetch it directly
   * 3. Hover over first card → click download button in hover overlay
   * 4. Screenshot fallback
   *
   * Image lightbox structure:
   * - Large image display on left
   * - Right panel: Details/Comments tabs, PROMPT section, INFORMATION section
   * - Action buttons: Animate, Publish, Open in, Reference, Download
   * - Download button: "button button-md button-secondary-reverted" with text "Download"
   * - Close: Escape key or X button at top-right
   *
   * Images served from: images.higgs.ai (CDN with ?url=, ?w=, ?q= params)
   */
  /**
   * Download a generated image.
   *
   * @param {string} outputPath - Where to save the image
   * @param {string|null} detectedUrl - The specific CDN URL detected during generation.
   *   When provided, we download THIS exact image (not "first card in history").
   *   When null, falls back to clicking the first history card (legacy behavior).
   */
  async downloadLatestImage(outputPath, detectedUrl = null) {
    const page = this.page;

    // ── Method 1: Direct fetch of the specific CDN URL we detected ──
    // This is the most reliable — we know exactly which image is ours
    if (detectedUrl) {
      try {
        // The detected URL might be a CDN thumbnail URL — extract the full-res original
        let fetchUrl = detectedUrl;
        try {
          const parsed = new URL(detectedUrl);
          const originalUrl = parsed.searchParams.get('url');
          if (originalUrl) fetchUrl = originalUrl;
        } catch { /* not a parameterized URL, use as-is */ }

        console.log(`[DL] Fetching detected image URL: ${fetchUrl.slice(0, 120)}...`);

        const imgData = await page.evaluate(async (url) => {
          const resp = await fetch(url);
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const blob = await resp.blob();
          const buffer = await blob.arrayBuffer();
          return Array.from(new Uint8Array(buffer));
        }, fetchUrl);

        fs.writeFileSync(outputPath, Buffer.from(imgData));
        console.log(`[DL] Downloaded image via detected URL: ${outputPath} (${imgData.length} bytes)`);
        return;
      } catch (e) {
        console.warn(`[DL] Direct URL fetch failed: ${e.message} — falling back to card click`);
      }
    }

    // ── Method 2: Click the card containing our specific URL ──
    // If we have the URL but direct fetch failed, find the card with matching src
    if (detectedUrl) {
      try {
        const historyTab = await page.$('button:has-text("History")');
        if (historyTab) {
          await historyTab.click().catch(() => {});
          await page.waitForTimeout(1000);
        }

        // Find the img element whose src matches our detected URL
        const matchingCard = await page.evaluate((targetUrl) => {
          const imgs = document.querySelectorAll('img[src]');
          for (const img of imgs) {
            if (img.src === targetUrl || img.src.includes(targetUrl) || targetUrl.includes(img.src)) {
              return true; // Found it
            }
          }
          return false;
        }, detectedUrl);

        if (matchingCard) {
          // Click the matching image to open lightbox
          const target = await page.$(`img[src="${detectedUrl}"]`)
            || await page.$(`img[src*="${detectedUrl.split('?')[0].split('/').pop()}"]`);

          if (target) {
            await target.click({ force: true, timeout: 5000 });
            await page.waitForTimeout(2000);

            const dlBtn = await page.getByText('Download', { exact: true }).first();
            if (dlBtn) {
              const [download] = await Promise.all([
                page.waitForEvent('download', { timeout: 15000 }),
                dlBtn.click(),
              ]);
              await download.saveAs(outputPath);
              console.log(`[DL] Downloaded image via matched card lightbox: ${outputPath}`);
              await page.keyboard.press('Escape');
              await page.waitForTimeout(500);
              return;
            }
          }
        }
      } catch (e) {
        console.warn(`[DL] Matched card method failed: ${e.message}`);
        await page.keyboard.press('Escape').catch(() => {});
      }
    }

    // ── Method 3: Fallback — click first card in history ──
    // Only used when we have no detected URL at all
    console.warn('[DL] No detected URL — falling back to first history card (may be wrong image!)');

    const historyTab = await page.$('button:has-text("History")');
    if (historyTab) {
      await historyTab.click().catch(() => {});
      await page.waitForTimeout(1000);
    }

    try {
      const firstCard = await page.$('img[data-asset-preview]')
        || await page.$('.overflow-x-hidden.grid > div:first-child img')
        || await page.$('.overflow-x-hidden.grid > div:first-child');

      if (!firstCard) throw new Error('No history card found');
      await firstCard.click({ force: true, timeout: 5000 });
      await page.waitForTimeout(2000);

      const dlBtn = await page.getByText('Download', { exact: true }).first();
      if (dlBtn) {
        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout: 15000 }),
          dlBtn.click(),
        ]);
        await download.saveAs(outputPath);
        console.log(`[DL] Downloaded image via first card fallback: ${outputPath}`);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(500);
        return;
      }
    } catch (e) {
      console.warn(`[DL] First card fallback failed: ${e.message}`);
      await page.keyboard.press('Escape').catch(() => {});
    }

    // ── Method 4: Screenshot last resort ──
    try {
      const img = await page.$('img[data-asset-preview]')
        || await page.$('.overflow-x-hidden.grid > div:first-child img');
      if (img) {
        await img.screenshot({ path: outputPath });
        console.log(`[DL] Downloaded image via screenshot fallback: ${outputPath}`);
        return;
      }
    } catch (e) {
      console.warn(`[DL] Screenshot method failed: ${e.message}`);
    }

    throw new Error('Could not download image result. Try downloading manually from the browser.');
  }

  // ══════════════════════════════════════════════════════════
  // DOWNLOAD — Videos
  // ══════════════════════════════════════════════════════════

  /**
   * Download the most recently generated video.
   *
   * Strategy (ordered by reliability):
   * 1. Extract video src from <video> element and fetch directly
   * 2. Hover over video card → click download button in hover overlay
   * 3. Use the Playwright download event
   *
   * Video structure:
   * - Videos play inline in History (no lightbox like images)
   * - Video served from d8j0ntlcm91z4.cloudfront.net
   * - Hover overlay: same pattern as images (heart, download, copy, menu)
   * - Bottom row: Rerun, copy, trash buttons
   */
  async downloadLatestVideo(outputPath, detectedUrl = null) {
    const page = this.page;

    // ── Method 0: Direct fetch of the CDN URL detected during generation ──
    // This is the most reliable — we know exactly which video is ours
    if (detectedUrl) {
      try {
        let fetchUrl = detectedUrl;
        // Extract original URL if wrapped in a CDN proxy
        try {
          const parsed = new URL(detectedUrl);
          const originalUrl = parsed.searchParams.get('url');
          if (originalUrl) fetchUrl = originalUrl;
        } catch (_) { /* use as-is */ }

        console.log(`[DL] Fetching detected video URL: ${fetchUrl.slice(0, 120)}...`);
        const videoData = await page.evaluate(async (url) => {
          const resp = await fetch(url);
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const blob = await resp.blob();
          const buffer = await blob.arrayBuffer();
          return Array.from(new Uint8Array(buffer));
        }, fetchUrl);

        fs.writeFileSync(outputPath, Buffer.from(videoData));
        console.log(`[DL] Downloaded video via detected URL: ${outputPath} (${videoData.length} bytes)`);
        return;
      } catch (e) {
        console.warn(`[DL] Detected URL video fetch failed: ${e.message} — falling back...`);
      }
    }

    // Ensure we're on the History tab
    const historyTab = await page.$('button:has-text("History")');
    if (historyTab) {
      await historyTab.click().catch(() => {});
      await page.waitForTimeout(1500);
    }

    // ── Method 1: Extract video src from DOM and fetch directly ──
    try {
      // Wait a moment for the video element to load in history
      await page.waitForSelector('video[src]', { timeout: 10000 }).catch(() => {});

      const videoSrc = await page.evaluate(() => {
        // Find the latest video element (largest one, not the model preview)
        const videos = document.querySelectorAll('video[src]');
        let bestVideo = null;
        let bestArea = 0;
        for (const v of videos) {
          const rect = v.getBoundingClientRect();
          const area = rect.width * rect.height;
          if (area > bestArea && rect.y > 100) {
            bestArea = area;
            bestVideo = v;
          }
        }
        return bestVideo?.src || null;
      });

      if (videoSrc) {
        // Fetch via page context to include cookies/auth
        const videoData = await page.evaluate(async (url) => {
          const resp = await fetch(url);
          const blob = await resp.blob();
          const buffer = await blob.arrayBuffer();
          return Array.from(new Uint8Array(buffer));
        }, videoSrc);

        fs.writeFileSync(outputPath, Buffer.from(videoData));
        console.log(`[DL] Downloaded video via DOM video src: ${outputPath} (${videoData.length} bytes)`);
        return;
      }
    } catch (e) {
      console.warn(`[DL] Video DOM src fetch failed: ${e.message}`);
    }

    // Method 2: Hover over video card and click download button
    try {
      // Find the video container in history
      const videoContainer = await page.evaluate(() => {
        const videos = document.querySelectorAll('video[src]');
        for (const v of videos) {
          const rect = v.getBoundingClientRect();
          if (rect.width > 300 && rect.y > 100) {
            // Get the closest card/group container
            const card = v.closest('[class*="group"], [class*="container"]');
            return card ? true : false;
          }
        }
        return false;
      });

      // Hover to reveal overlay buttons
      const videoEl = await page.$('video[src]');
      if (videoEl) {
        const box = await videoEl.boundingBox();
        if (box) {
          // Hover near the right side of the video to trigger overlay
          await page.mouse.move(box.x + box.width - 50, box.y + 80);
          await page.waitForTimeout(800);

          // Find and click download button in hover overlay
          const hoverBtns = await page.$$('.button.button-sm.button-primary-reverted.rounded-full');
          for (const btn of hoverBtns) {
            const visible = await btn.isVisible();
            if (!visible) continue;
            const svgPath = await btn.$eval('svg path', el => el.getAttribute('d')).catch(() => '');
            if (svgPath.startsWith('M3.75 14')) {
              const [download] = await Promise.all([
                page.waitForEvent('download', { timeout: 30000 }),
                btn.click(),
              ]);
              await download.saveAs(outputPath);
              console.log(`[DL] Downloaded video via hover button: ${outputPath}`);
              return;
            }
          }
        }
      }
    } catch (e) {
      console.warn(`[DL] Video hover button failed: ${e.message}`);
    }

    throw new Error('Could not download video result. Try downloading manually from the browser.');
  }

  /**
   * Legacy download router — calls the appropriate method based on type.
   * Returns { model, sourceGenId, cdnUrl, promptText, referenceUrls } extracted from the detail page.
   *
   * @param {string} submittedPrompt - The prompt we originally submitted. Used to verify
   *   we downloaded the correct image by comparing against the prompt shown in the
   *   Higgsfield detail panel. If mismatch, throws so the pipeline doesn't proceed
   *   with a wrong asset.
   * @param {string} submittedReferenceCdnUrl - CDN URL of the reference image we uploaded.
   *   For grids, all prompts are identical — the differentiator is which portrait reference
   *   was used. If provided, we verify the lightbox shows this reference URL.
   */
  async downloadLatestResult(outputPath, type, detectedUrl = null, submittedPrompt = '', submittedReferenceCdnUrl = '') {
    if (type === 'video') {
      await this.downloadLatestVideo(outputPath, detectedUrl);
    } else {
      await this.downloadLatestImage(outputPath, detectedUrl);
    }

    // ── VERIFY: file was actually written and is a real asset (not a tiny screenshot) ──
    const fs = require('fs');
    if (!fs.existsSync(outputPath)) {
      throw new Error(`Download failed — file not written to disk: ${outputPath}`);
    }
    const fileSize = fs.statSync(outputPath).size;
    const minSize = type === 'video' ? 100000 : 50000; // 100KB for video, 50KB for image
    if (fileSize < minSize) {
      console.warn(`[DL] ⚠ Downloaded file is suspiciously small (${fileSize} bytes, min ${minSize}). May be a thumbnail screenshot, not the real asset.`);
    }

    // Extract generation metadata from the detail lightbox
    const meta = await this._extractGenMetadata();

    // Attach the CDN URL we used to download (more reliable than what's in the lightbox)
    if (detectedUrl && !meta.cdnUrl) {
      meta.cdnUrl = detectedUrl;
    }

    // ── PROMPT-MATCH VALIDATION ──
    // Verify the downloaded image's prompt matches what we submitted.
    // This catches wrong-image downloads (e.g., clicking the wrong history card,
    // race condition with gallery ordering, or stale CDN URL).
    if (submittedPrompt && meta.promptText) {
      const normalize = s => s.replace(/\s+/g, ' ').trim().toLowerCase();
      const submitted = normalize(submittedPrompt);
      const retrieved = normalize(meta.promptText);

      // Check if the first 80 chars match (prompts may be truncated in UI)
      const subSnippet = submitted.slice(0, 80);
      const retSnippet = retrieved.slice(0, 80);

      if (subSnippet === retSnippet) {
        console.log(`[DL] ✓ Prompt match confirmed (first 80 chars identical)`);
      } else {
        // Fuzzy match — count shared words
        const subWords = new Set(submitted.split(' ').filter(w => w.length > 3));
        const retWords = new Set(retrieved.split(' ').filter(w => w.length > 3));
        let overlap = 0;
        for (const w of subWords) { if (retWords.has(w)) overlap++; }
        const similarity = subWords.size > 0 ? overlap / subWords.size : 0;

        if (similarity >= 0.5) {
          console.log(`[DL] ✓ Prompt fuzzy match OK (${Math.round(similarity * 100)}% word overlap)`);
        } else {
          console.error(`[DL] ✗ PROMPT MISMATCH — downloaded image is likely WRONG`);
          console.error(`[DL]   Submitted: "${submitted.slice(0, 120)}..."`);
          console.error(`[DL]   Retrieved: "${retrieved.slice(0, 120)}..."`);
          console.error(`[DL]   Similarity: ${Math.round(similarity * 100)}% (threshold 50%)`);

          // Delete the wrong file so the pipeline doesn't use it
          try { fs.unlinkSync(outputPath); } catch (_) {}
          throw new Error(`PROMPT_MISMATCH: Downloaded image prompt doesn't match submitted prompt (${Math.round(similarity * 100)}% similarity). Wrong image was downloaded and deleted.`);
        }
      }
    } else if (submittedPrompt && !meta.promptText) {
      console.warn(`[DL] ⚠ Could not extract prompt from detail panel — skipping prompt-match validation`);
    }

    // ── REFERENCE IMAGE VALIDATION ──
    // For grids (and any generation with references), verify the reference image
    // shown in the lightbox matches the one we submitted. This catches wrong-character
    // grid downloads where prompts are identical but references differ.
    if (submittedReferenceCdnUrl && meta.referenceUrls && meta.referenceUrls.length > 0) {
      // Extract a unique identifier from both URLs for comparison
      // CDN URLs look like: https://d8j0ntlcm91z4.cloudfront.net/user_xxx/hf_20260418_xxx_UUID...
      // or https://images.higgs.ai/...?url=ORIGINAL_URL
      const extractId = (url) => {
        if (!url) return '';
        // Try UUID pattern
        const uuid = url.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
        if (uuid) return uuid[1];
        // Try the filename/hash portion after the last /
        const parts = url.split('?')[0].split('/');
        return parts[parts.length - 1] || url.slice(-40);
      };

      const submittedId = extractId(submittedReferenceCdnUrl);
      const matched = meta.referenceUrls.some(refUrl => {
        const refId = extractId(refUrl);
        return refId && submittedId && (refUrl.includes(submittedId) || submittedReferenceCdnUrl.includes(refId));
      });

      if (matched) {
        console.log(`[DL] ✓ Reference image match confirmed`);
      } else {
        console.warn(`[DL] ⚠ Reference image mismatch — could be wrong character's grid`);
        console.warn(`[DL]   Submitted ref ID: ${submittedId}`);
        console.warn(`[DL]   Lightbox refs: ${meta.referenceUrls.map(u => extractId(u)).join(', ')}`);
        // Warn but don't throw — reference URL formats may not match exactly
        // (CDN proxies, thumbnails vs originals, etc). The prompt-match above
        // provides the primary gate. This is an extra signal for grids.
      }
    } else if (submittedReferenceCdnUrl && (!meta.referenceUrls || meta.referenceUrls.length === 0)) {
      console.warn(`[DL] ⚠ No reference images found in lightbox — cannot verify reference match`);
    }

    return meta;
  }

  /**
   * Extract generation metadata (model name, generation ID) from the
   * Higgsfield detail lightbox. Should be called while the lightbox is open,
   * or will open the first history card.
   *
   * Higgsfield detail page structure:
   * - Right panel has "INFORMATION" section with model name, dimensions, etc.
   * - URL or data attributes may contain the generation/asset ID
   * - PROMPT section shows the prompt used
   *
   * @returns {{ model: string|null, sourceGenId: string|null, cdnUrl: string|null }}
   */
  async _extractGenMetadata() {
    const page = this.page;
    const meta = { model: null, sourceGenId: null, cdnUrl: null };

    try {
      // Ensure History tab is active and open the first card
      const historyTab = await page.$('button:has-text("History")');
      if (historyTab) {
        await historyTab.click().catch(() => {});
        await page.waitForTimeout(1000);
      }

      const firstCard = await page.$('img[data-asset-preview]')
        || await page.$('.overflow-x-hidden.grid > div:first-child img')
        || await page.$('.overflow-x-hidden.grid > div:first-child')
        || await page.$('[class*="grid"] > div:first-child');

      if (firstCard) {
        await firstCard.click({ force: true, timeout: 5000 });
        await page.waitForTimeout(2000);
      }

      // Expand "See all" to get full prompt text (truncated by default)
      try {
        const seeAllBtn = await page.$('button:has-text("See all")');
        if (seeAllBtn) {
          await seeAllBtn.click({ timeout: 3000 });
          await page.waitForTimeout(500);
        }
      } catch (_) { /* See all button may not exist for short prompts */ }

      // Extract model name, generation ID, prompt text, reference images, and CDN URL
      const extracted = await page.evaluate(() => {
        const result = { model: null, sourceGenId: null, cdnUrl: null, promptText: null, referenceUrls: [] };

        // === Prompt text ===
        // The prompt lives in div.attribute-text-value inside the lightbox right panel
        const promptDiv = document.querySelector('.attribute-text-value');
        if (promptDiv) {
          result.promptText = (promptDiv.textContent || '').trim();
        }

        // === Reference images ===
        // When a reference image was used, a small clickable thumbnail (~40x40)
        // appears near the PROMPT section with a green "+" badge overlay.
        // The lightbox section is the right panel inside .fixed.top-0
        const section = document.querySelector('.fixed.top-0 section');
        if (section) {
          const imgs = section.querySelectorAll('img');
          imgs.forEach(img => {
            const r = img.getBoundingClientRect();
            // Reference thumbnails are small (20-60px), near the prompt area,
            // and NOT the profile picture (which has alt="profile picture")
            if (r.width >= 20 && r.width <= 80 && r.height >= 20 && r.height <= 80 &&
                img.alt !== 'profile picture' && img.src) {
              // Check if parent/grandparent is clickable (reference imgs are interactive)
              const parent = img.parentElement;
              const gp = parent ? parent.parentElement : null;
              const clickable = (parent && getComputedStyle(parent).cursor === 'pointer') ||
                                (gp && getComputedStyle(gp).cursor === 'pointer');
              if (clickable || img.alt.includes('ref') || img.alt === '') {
                result.referenceUrls.push(img.src);
              }
            }
          });
        }

        // === Model name ===
        // Look in the INFORMATION section for model/tool text
        const allText = document.body.innerText;

        // Common model names on Higgsfield
        const knownModels = [
          'Nano Banana Pro', 'Nano Banana', 'Seedance 2.0', 'Seedance',
          'Veo 3.1 Lite', 'Veo 3.1', 'Veo 3', 'Veo',
          'Flux', 'DALL-E', 'Midjourney'
        ];
        for (const model of knownModels) {
          if (allText.includes(model)) {
            result.model = model;
            break;
          }
        }

        // Also try: look for text near "Model" or "Tool" labels
        if (!result.model) {
          const labels = document.querySelectorAll('span, div, p, h4');
          for (const el of labels) {
            const t = el.textContent.trim();
            if (t === 'Model' || t === 'Tool' || t === 'MODEL') {
              const next = el.nextElementSibling || el.parentElement?.nextElementSibling;
              if (next) {
                result.model = next.textContent.trim();
                break;
              }
            }
          }
        }

        // === Generation/Asset ID ===
        // Check URL for asset ID (Higgsfield URLs often contain /asset/<id> or ?id=<id>)
        const url = window.location.href;
        const assetMatch = url.match(/\/asset\/([a-zA-Z0-9_-]+)/) ||
                          url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
        if (assetMatch) {
          result.sourceGenId = assetMatch[1];
        }

        // Also check for data attributes on the lightbox/modal
        if (!result.sourceGenId) {
          const modal = document.querySelector('[role="dialog"], [class*="modal"], [class*="lightbox"]');
          if (modal) {
            const id = modal.getAttribute('data-id') ||
                       modal.getAttribute('data-asset-id') ||
                       modal.getAttribute('data-generation-id');
            if (id) result.sourceGenId = id;
          }
        }

        // Try extracting from image src URL (Higgsfield CDN URLs contain asset hashes)
        if (!result.sourceGenId) {
          const mainImg = document.querySelector('[class*="lightbox"] img[src*="higgs"], [role="dialog"] img[src*="higgs"]');
          if (mainImg) {
            const src = mainImg.src;
            // Extract the unique part from CDN URL
            const cdnMatch = src.match(/\/([a-f0-9-]{36})\//i) || // UUID
                            src.match(/\/([a-zA-Z0-9_-]{20,})\./); // Long hash
            if (cdnMatch) result.sourceGenId = cdnMatch[1];
          }
        }

        // === CDN URL ===
        // Grab the full-resolution image URL from the lightbox for re-download capability
        const lightboxImg = document.querySelector(
          '[class*="lightbox"] img[src*="http"], [role="dialog"] img[src*="http"], ' +
          '[class*="modal"] img[src*="http"]'
        );
        if (lightboxImg && lightboxImg.src) {
          result.cdnUrl = lightboxImg.src;
        }

        return result;
      });

      meta.model = extracted.model;
      meta.sourceGenId = extracted.sourceGenId;
      meta.cdnUrl = extracted.cdnUrl || meta.cdnUrl;
      meta.promptText = extracted.promptText;
      meta.referenceUrls = extracted.referenceUrls || [];

      // Close lightbox
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);

      console.log(`[META] model: ${meta.model || 'unknown'} | genId: ${meta.sourceGenId || 'unknown'} | cdnUrl: ${meta.cdnUrl ? 'captured' : 'none'}`);
    } catch (e) {
      console.warn(`[META] Could not extract generation metadata: ${e.message}`);
      await page.keyboard.press('Escape').catch(() => {});
    }

    return meta;
  }

  cancel() {
    this.cancelled = true;
    // Actively abort any in-flight Playwright operations by closing the context.
    // This makes all pending awaits throw "Target closed" immediately, letting
    // the pipeline actually stop instead of waiting for the current generation
    // to finish (which could take 2-10 min for Veo).
    // Run the close in the background — don't await, cancel() should return fast.
    (async () => {
      try {
        if (this.page && !this.page.isClosed()) {
          console.log('[CANCEL] Closing active page to abort in-flight Playwright operations');
          await this.saveSession().catch(() => {});
          await this.page.context().close().catch(() => {});
        }
      } catch (e) {
        console.warn(`[CANCEL] Error during forced abort: ${e.message.split('\n')[0]}`);
      }
    })();
  }

  async close() {
    if (this.browser) {
      try {
        await this.saveSession().catch(() => {});
      } catch (_) {}
      try {
        await this.browser.close().catch(() => {});
      } catch (_) {}
      this.browser = null;
      this.page = null;
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // IMAGE RECOVERY — from Higgsfield Asset library (/asset/image)
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Recover a previously-generated image from the Higgsfield Asset library.
   * Used when portrait generation was submitted (gen_clicked_at set) but the
   * process crashed/closed before the result could be downloaded.
   *
   * Mirrors cinema-studio-automation's recoverTimedOutImage() exactly —
   * same Assets page, same selectors, same prompt-matching flow.
   *
   * Flow:
   *   1. Recreate browser context (page may be in unknown state)
   *   2. Navigate to /asset/image (all generated images, most recent first)
   *   3. Scan figure[data-asset-id] tiles
   *   4. For each tile: navigate to /asset/image/{uuid}, scrape PROMPT text
   *   5. Compare against submitted prompt (Jaccard word similarity)
   *   6. On match (≥threshold): click Download → save → return success
   *
   * @param {string} submittedPrompt - the exact prompt submitted to Nano Banana Pro
   * @param {string} outputPath      - where to save the recovered image
   * @param {Object} [opts]
   * @param {number} [opts.minSimilarity=80] - minimum prompt similarity (0-100)
   * @param {number} [opts.maxTilesToCheck=8] - max tiles to check before giving up
   * @param {number} [opts.timeoutMs=90000]   - total recovery timeout
   * @returns {Promise<{path, sourceGenId, assetUuid, similarity}|null>}
   */
  async recoverTimedOutImage(submittedPrompt, outputPath, opts = {}) {
    const fs = require('fs');
    const minSimilarity = opts.minSimilarity || 80;
    const maxTilesToCheck = opts.maxTilesToCheck || 8;
    const timeoutMs = opts.timeoutMs || 90000;
    const startedAt = Date.now();

    console.log('[IMG RECOVERY] Starting image recovery from Asset library...');

    // ── 1. Recreate context for clean navigation ──
    try {
      await this.recreateContext();
    } catch (e) {
      console.warn(`[IMG RECOVERY] Context recreate failed: ${e.message}`);
      return null;
    }
    const page = this.page;
    if (!page) {
      console.warn('[IMG RECOVERY] No page after context recreate');
      return null;
    }

    // ── 2. Navigate to Asset/Image grid ──
    try {
      await page.goto('https://higgsfield.ai/asset/image', {
        waitUntil: 'domcontentloaded',
        timeout: 20000,
      });
    } catch (navErr) {
      console.warn(`[IMG RECOVERY] Navigation failed: ${navErr.message.split('\n')[0]}`);
      return null;
    }
    await page.waitForTimeout(3000);
    console.log(`[IMG RECOVERY] Asset/image page loaded. URL: ${page.url()}`);

    // ── 3. Scan for image tiles (figure[data-asset-id]) ──
    let imageTiles = [];
    for (let poll = 0; poll < 4; poll++) {
      imageTiles = await page.evaluate(() => {
        const results = [];
        const figures = document.querySelectorAll('figure[data-asset-id]');
        for (const fig of figures) {
          const r = fig.getBoundingClientRect();
          if (r.width < 80 || r.height < 80 || r.width === 0) continue;
          const uuid = fig.getAttribute('data-asset-id') || null;
          results.push({
            uuid,
            x: Math.round(r.x + r.width / 2),
            y: Math.round(r.y + r.height / 2),
          });
        }
        return results;
      }).catch(() => []);
      if (imageTiles.length > 0) break;
      console.log(`[IMG RECOVERY] No image tiles yet (poll ${poll + 1}/4) — waiting 2s...`);
      await page.waitForTimeout(2000);
    }

    if (imageTiles.length === 0) {
      console.warn('[IMG RECOVERY] No image tiles found on asset page — giving up');
      return null;
    }
    console.log(`[IMG RECOVERY] Found ${imageTiles.length} image tile(s) — checking up to ${Math.min(maxTilesToCheck, imageTiles.length)}`);

    // ── 4. Check each tile: navigate to detail, scrape prompt, compare ──
    const tilesToCheck = imageTiles.slice(0, maxTilesToCheck);

    for (let i = 0; i < tilesToCheck.length; i++) {
      if (Date.now() - startedAt > timeoutMs) {
        console.warn(`[IMG RECOVERY] Timeout (${timeoutMs / 1000}s) — giving up after ${i} tiles`);
        return null;
      }

      const tile = tilesToCheck[i];
      if (!tile.uuid) {
        console.log(`[IMG RECOVERY] Tile ${i + 1} has no UUID — skipping`);
        continue;
      }
      console.log(`[IMG RECOVERY] Checking tile ${i + 1}/${tilesToCheck.length} (uuid=${tile.uuid})...`);

      try {
        // Navigate directly to the detail page
        await page.goto(`https://higgsfield.ai/asset/image/${tile.uuid}`, {
          waitUntil: 'domcontentloaded', timeout: 15000,
        });
        await page.waitForTimeout(2000);

        // Wait for detail panel to load (PROMPT + INFORMATION sections)
        let detailReady = false;
        for (let wait = 0; wait < 8; wait++) {
          detailReady = await page.evaluate(() => {
            const bodyText = document.body?.innerText || '';
            return bodyText.includes('PROMPT') &&
                   (bodyText.includes('Copy') || bodyText.includes('INFORMATION'));
          }).catch(() => false);
          if (detailReady) break;
          await page.waitForTimeout(1000);
        }

        if (!detailReady) {
          console.log(`[IMG RECOVERY] Detail panel didn't load for tile ${i + 1} — skipping`);
          continue;
        }

        // Scrape prompt text from DOM (between "PROMPT" and "INFORMATION" headings)
        let tilePrompt = await page.evaluate(() => {
          const body = document.body?.innerText || '';
          const promptIdx = body.indexOf('PROMPT');
          const infoIdx = body.indexOf('INFORMATION');
          if (promptIdx >= 0 && infoIdx > promptIdx) {
            let section = body.substring(promptIdx + 6, infoIdx).trim();
            section = section.replace(/^Copy\s*/i, '').replace(/\s*See all\s*$/i, '').trim();
            return section;
          }
          return '';
        }).catch(() => '');

        if (!tilePrompt || tilePrompt.length < 20) {
          console.log(`[IMG RECOVERY] No prompt text for tile ${i + 1} — skipping`);
          continue;
        }

        // Compare prompts using normalized word-overlap similarity
        const similarity = this._promptSimilarity(submittedPrompt, tilePro