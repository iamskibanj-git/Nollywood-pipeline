/**
 * cinema-studio-automation.js — Phase 3 of the cinematic workflow.
 *
 * Generates blocked scene images via Higgsfield Cinema Studio 3.5
 * using the "Cinematic Cameras" model (a.k.a. Studio Digital S35).
 *
 * DOM structure (verified via live Playwright DevTools, April 2026):
 *
 *   PROMPT ROW (y ≈ 723):
 *     button[0] (32×32, no text/aria)  ← the "+" reference picker
 *     div[role="textbox"][contenteditable="true"]
 *       placeholder: "Describe your scene - use @ to add characters & locations"
 *       NOTE: This is a **Lexical editor** <div>, NOT a <textarea>.
 *             getByPlaceholder() won't work; use getByRole('textbox').
 *             Playwright's keyboard.type() does NOT reliably insert text.
 *             MUST use document.execCommand('insertText') to type text.
 *             DO NOT walk React fibers — causes cross-origin crash.
 *     button "Studio Digital S35..." (120×80, camera selector)
 *     button "GENERATE ✦ 2" (type="submit", 147×80)
 *
 *   TOOLBAR ROW (y ≈ 775, below prompt):
 *     button "Cinematic Cameras" (152×32)
 *     button[aria-label="Decrement"] (16×16)   ← image count -
 *     button[aria-label="Increment"] (16×16)   ← image count +
 *     button "16:9" (53×32)                    ← aspect ratio
 *     combobox "2K" (select: 1K/2K/4K)        ← resolution
 *     button "1x1" (48×32)                     ← grid toggle
 *     button (24×32, no text)                  ← @ / Elements
 *
 *   LEFT SIDEBAR (x < 50):
 *     button "My Generations" (y ≈ 112)
 *     button "New project" (y ≈ 176)           ← creates new project
 *     button "Project Name + N assets" ...      ← existing projects
 *     button "+" (y ≈ bottom)                  ← also creates project
 *
 *   TOP CENTER:
 *     "Generations" / "Elements" tabs appear ONLY inside a project view,
 *     NOT in the "My Generations" default view.
 *
 *   PROJECT CONTEXT MENU (right-click sidebar icon):
 *     "Edit"    ← opens rename / edit dialog
 *     "Move to" ← submenu
 *     "Pin"
 *     "Delete"  ← red, destructive
 *
 *   PROJECT URL: /generate?projectId=<UUID>
 *     This UUID is the authoritative project identifier. After creating a
 *     project, we capture the UUID from the URL and navigate back to it
 *     directly — no fragile sidebar name matching needed.
 */

const path = require('path');

class CinemaStudioAutomation {
  constructor({ automation, logger, projectId }) {
    this.automation = automation;
    this.log = logger || ((msg) => console.log(`[CINEMA-STUDIO] ${msg}`));
    this._projectCreated = !!projectId; // If we already have an ID, skip creation
    this._projectName = null;
    this._projectId = projectId || null; // UUID from URL: projectId=
    this._abortRequested = false;  // Set when user closes browser — stops cascade
    this._lastSceneReferenceProof = null;
  }

  /**
   * Signal the automation to stop trying. Called when user closes browser
   * or the pipeline is cancelled. Prevents cascading retries.
   */
  abort() {
    this._abortRequested = true;
  }

  /**
   * Check whether the page is alive and the user hasn't requested abort.
   * Throws a descriptive error if conditions aren't met.
   */
  _ensurePageAlive() {
    if (this._abortRequested) {
      throw new Error('Automation aborted (user closed browser or pipeline cancelled)');
    }
    const page = this.automation.page;
    if (!page) {
      throw new Error('Playwright page not ready');
    }
    // Playwright page objects have isClosed()
    if (typeof page.isClosed === 'function' && page.isClosed()) {
      throw new Error('Playwright page is closed');
    }
    // Also check the _userClosedBrowser flag on the automation instance
    if (this.automation._userClosedBrowser) {
      this._abortRequested = true;
      throw new Error('User closed browser — aborting automation');
    }
    return page;
  }

  // ═══════════════════════════════════════════════════════════
  // NAVIGATION + PROJECT MANAGEMENT
  // ═══════════════════════════════════════════════════════════

  /**
   * INTER-GENERATION RESET: After completing a scene generation + download,
   * nuke the page by navigating to the base Cinema Studio URL with no project.
   * This is the ONLY reliable way to get a clean form — Higgsfield persists
   * references and prompts at the project level, and there's no UI control
   * to remove a reference image once attached.
   *
   * The next generateSceneImage() call will re-run ensureProject() which
   * creates/finds the project, giving a fresh form within that new context.
   */
  async resetFormForNextGeneration() {
    this.log('[INTER-GEN RESET] Tearing down browser context for clean state...');

    // Full context teardown — the ONLY way to clear Higgsfield's persisted
    // references, prompts, and in-memory state. page.goto() is NOT enough.
    // Same pattern as clearVideoStartFrame() in staged workflow.
    await this.automation.recreateContext();

    // this.automation.page is now the fresh page
    const page = this.automation.page;

    // Keep _projectId — the project lives server-side on Higgsfield.
    // ensureProject() will navigate to it on the fresh context.
    // Only clear _projectCreated so ensureProject() re-validates.
    this._projectCreated = false;

    // Navigate to Cinema Studio on the fresh context
    this.log('[INTER-GEN RESET] Navigating fresh context to Cinema Studio...');
    await page.goto(this._projectUrl(), {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    }).catch(() => {});

    await page.waitForTimeout(3000);

    // Wait for GENERATE button (confirms page is ready)
    for (let i = 0; i < 10; i++) {
      const hasGenerate = await page.evaluate(() => {
        return [...document.querySelectorAll('button')].some(b =>
          b.textContent?.includes('GENERATE') || b.textContent?.includes('Generate')
        );
      }).catch(() => false);

      if (hasGenerate) {
        this.log(`[INTER-GEN RESET] ✓ Fresh page ready (${i + 1}s)`);
        return;
      }
      await page.waitForTimeout(1000);
    }

    this.log('[INTER-GEN RESET] ✓ Context recreated (GENERATE not visible yet — ensureProject will handle setup)');
  }

  /**
   * TOOLBAR RESTART NUKE: Tear down the entire browser context and create a
   * fresh one. Just navigating to a new URL doesn't work — Higgsfield persists
   * references and state in the browser context (localStorage, session, React
   * in-memory state). recreateContext() closes the page + context, preserves
   * cookies for auth, opens a new context with no localStorage, and gives us
   * a brand new page. Same pattern used by clearVideoStartFrame() in staged.
   */
  async _nukePageForToolbarReset() {
    this.log('[TOOLBAR-NUKE] Tearing down browser context for clean state...');

    await this.automation.recreateContext();

    // this.automation.page is now the fresh page
    const page = this.automation.page;

    // Keep _projectId — project lives server-side. ensureProject() will
    // navigate to it after the toolbar setup succeeds on the fresh context.
    this._projectCreated = false;

    // Navigate to Cinema Studio on the fresh context
    this.log('[TOOLBAR-NUKE] Navigating fresh context to Cinema Studio...');
    await page.goto(this._projectUrl(), {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    }).catch(() => {});

    await page.waitForTimeout(3000);

    // Wait for GENERATE button (confirms page loaded enough to interact)
    for (let i = 0; i < 12; i++) {
      const hasGenerate = await page.evaluate(() => {
        return [...document.querySelectorAll('button')].some(b =>
          b.textContent?.includes('GENERATE') || b.textContent?.includes('Generate')
        );
      }).catch(() => false);

      if (hasGenerate) {
        this.log(`[TOOLBAR-NUKE] ✓ Fresh page ready (${i + 1}s)`);
        return;
      }
      await page.waitForTimeout(1000);
    }
    this.log('[TOOLBAR-NUKE] ✓ Context recreated (GENERATE not visible yet — setup will handle it)');
  }

  /**
   * STUCK RECOVERY: Click "Generations" tab to escape Elements panel or any
   * stuck state. This is the ONLY way out of the Elements panel — going home
   * does NOT dismiss it.
   *
   * Returns true if Generations was clicked and GENERATE button appeared.
   */
  async _clickGenerationsReset() {
    const page = this._ensurePageAlive();

    // Dismiss any open dropdowns/popovers FIRST — leftover dropdowns from
    // a stuck model selector contaminate the next toolbar scan.
    try {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      await page.keyboard.press('Escape'); // Double-tap in case nested
      await page.waitForTimeout(300);
    } catch (_) { /* ignore if page is dead */ }

    this.log('[RESET] Clicking Generations tab...');

    for (let attempt = 0; attempt < 5; attempt++) {
      const clicked = await page.evaluate(() => {
        const btns = document.querySelectorAll('button');
        for (const b of btns) {
          const text = b.textContent?.trim();
          const r = b.getBoundingClientRect();
          if (text === 'Generations' && r.width > 0 && r.height > 0 && r.y < window.innerHeight * 0.25) {
            b.click();
            return true;
          }
        }
        return false;
      }).catch(() => false);

      if (clicked) {
        await page.waitForTimeout(2000);
        // Verify we see GENERATE button or Image/Video tabs
        const ok = await page.evaluate(() => {
          const btns = [...document.querySelectorAll('button')];
          const hasGen = btns.some(b => /^GENERATE|^Generate/.test(b.textContent?.trim() || '') && /\d/.test(b.textContent));
          const hasTabs = !!document.querySelector('button[role="tab"]');
          return hasGen || hasTabs;
        }).catch(() => false);
        if (ok) {
          this.log('[RESET] ✓ Generations view restored');
          return true;
        }
      }
      await page.waitForTimeout(1500);
    }
    this.log('[RESET] WARN: Could not restore Generations view after 5 attempts');
    return false;
  }

  /**
   * Run a setup step with a 5-second stuck guard.
   * If the step doesn't complete within timeoutMs, click Generations and throw
   * so the caller can restart the whole sequence.
   *
   * @param {string} label - Step name for logging
   * @param {Function} stepFn - Async function to run (receives page)
   * @param {number} timeoutMs - Max time before considering stuck (default 5000)
   */
  async _runStepWithStuckGuard(label, stepFn, timeoutMs = 5000) {
    const page = this._ensurePageAlive();
    const start = Date.now();

    try {
      await Promise.race([
        stepFn(page),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`STUCK: ${label} took >${timeoutMs}ms`)), timeoutMs)),
      ]);
    } catch (e) {
      const elapsed = Date.now() - start;
      if (elapsed >= timeoutMs - 100) {
        // Timed out — stuck
        this.log(`[STUCK] ${label} stuck after ${elapsed}ms — clicking Generations to reset`);
        await this._clickGenerationsReset();
        throw new Error(`STUCK_RESET: ${label}`);
      }
      // Regular error — not a timeout, just re-throw
      throw e;
    }
  }

  /**
   * Navigate to Cinema Studio and ensure we're on the correct page.
   * Does NOT set toolbar settings — that's done in _setupToolbarSequence().
   */
  async _ensureCinemaStudioActive() {
    if (typeof this.automation.ensureBrowser === 'function') {
      await this.automation.ensureBrowser();
    }
    const page = this._ensurePageAlive();

    await this._dismissOverlays();

    // ── STEP 0: Navigate ──
    if (this._projectId && !page.url().includes(this._projectId)) {
      this.log(`Navigating to project ${this._projectId}...`);
      await page.goto(`https://higgsfield.ai/generate?projectId=${this._projectId}`, { waitUntil: 'domcontentloaded' });
    } else if (!page.url().includes('/generate')) {
      this.log('Navigating to Cinema Studio...');
      await page.goto('https://higgsfield.ai/generate', { waitUntil: 'domcontentloaded' });
    }

    // ── STEP 1: Wait for page to fully render ──
    this.log('[SETUP] Step 1: Waiting for page to fully render...');
    for (let wait = 0; wait < 10; wait++) {
      await page.waitForTimeout(1000);
      const rendered = await page.evaluate(() => {
        const hasTextbox = !!document.querySelector('[role="textbox"]');
        const hasGenerate = [...document.querySelectorAll('button')].some(b =>
          /^GENERATE|^Generate/.test(b.textContent?.trim() || '') && /\d/.test(b.textContent));
        return hasTextbox || hasGenerate;
      }).catch(() => false);
      if (rendered) {
        this.log(`[SETUP] Page rendered after ${wait + 1}s`);
        break;
      }
    }
    await page.waitForTimeout(1500);

    // ── STEP 2: Ensure viewport is tall enough for full toolbar ──
    // Cinema Studio's responsive layout hides the + (reference picker) and @
    // (element mention) buttons when the viewport height is too small (~730px).
    // On Windows with DPI scaling, --start-maximized can produce a window that's
    // too short. We use CDP to force a minimum 1080px window height.
    await this._ensureMinimumViewport(1920, 1080);
  }

  /**
   * Use CDP to ensure the browser window is at least minWidth x minHeight.
   * Cinema Studio's prompt toolbar hides the + and @ buttons when viewport
   * height is below ~850px (responsive breakpoint). This forces a tall enough
   * window so all toolbar elements render.
   *
   * Only resizes if the current viewport is smaller than the minimum.
   * After resizing, waits for the page to re-layout.
   */
  async _ensureMinimumViewport(minWidth = 1920, minHeight = 1080) {
    const page = this._ensurePageAlive();

    const dims = await page.evaluate(() => ({
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      screenWidth: window.screen.width,
      screenHeight: window.screen.height,
      dpr: window.devicePixelRatio || 1,
    }));

    this.log(`[VIEWPORT] Current: ${dims.innerWidth}x${dims.innerHeight} (screen: ${dims.screenWidth}x${dims.screenHeight}, dpr: ${dims.dpr})`);

    // Cinema Studio renders all toolbar buttons at ANY viewport size (verified
    // via Chrome DevTools inspection April 2026). The previous assumption that
    // buttons hide below vh=850 was wrong — the real issue was overlapping
    // duplicate toolbars causing clicks to hit the wrong element.
    //
    // We still CDP-resize to maximize the window for best user experience,
    // but no CSS injection or device metrics override is needed.
    try {
      const cdp = await page.context().newCDPSession(page);
      const { windowId } = await cdp.send('Browser.getWindowForTarget');

      // Un-maximize first (setWindowBounds can't resize a maximized window)
      await cdp.send('Browser.setWindowBounds', {
        windowId,
        bounds: { windowState: 'normal' },
      });
      await page.waitForTimeout(300);

      // Request as large as possible
      await cdp.send('Browser.setWindowBounds', {
        windowId,
        bounds: { width: minWidth, height: minHeight },
      });
      await page.waitForTimeout(500);

      const after = await page.evaluate(() => ({
        w: window.innerWidth,
        h: window.innerHeight,
      }));
      this.log(`[VIEWPORT] After CDP resize: ${after.w}x${after.h}`);

      // Give Cinema Studio time to re-render with new dimensions
      await page.waitForTimeout(1000);
    } catch (e) {
      this.log(`[VIEWPORT] Resize failed: ${e.message.split('\n')[0]} — continuing with current size`);
    }
  }

  /**
   * Scroll the toolbar/prompt area into the visible viewport.
   * Called before interacting with + button, @ button, or GENERATE.
   * On short viewports the toolbar can be partially below the fold.
   *
   * Cinema Studio is a single-page app with flex layout. The toolbar may
   * be outside the physical viewport if the app uses vh-based layout and
   * the viewport is shorter than expected. We try:
   *   1. scrollIntoView on the textbox (works if any ancestor scrolls)
   *   2. Walk parent chain and scroll any overflow containers
   *   3. As last resort, scroll the whole page to bottom
   */
  async _scrollToolbarIntoView() {
    const page = this._ensurePageAlive();
    await page.evaluate(() => {
      const tb = document.querySelector('[role="textbox"][contenteditable="true"]');
      if (!tb) {
        window.scrollTo(0, document.body.scrollHeight);
        return;
      }

      // First try standard scrollIntoView
      tb.scrollIntoView({ block: 'center', behavior: 'instant' });

      // Also walk up the parent chain and scroll any overflow containers
      // so the textbox row is visible within each scrollable ancestor
      let el = tb.parentElement;
      while (el && el !== document.body) {
        const style = window.getComputedStyle(el);
        const overflow = style.overflow + style.overflowY;
        if (overflow.includes('auto') || overflow.includes('scroll') || overflow.includes('hidden')) {
          // If this container clips, scroll it to show the toolbar
          const containerRect = el.getBoundingClientRect();
          const tbRect = tb.getBoundingClientRect();
          if (tbRect.bottom > containerRect.bottom) {
            el.scrollTop += (tbRect.bottom - containerRect.bottom) + 20;
          }
        }
        el = el.parentElement;
      }
    });
    await page.waitForTimeout(300);
  }

  /**
   * THE MASTER TOOLBAR SETUP SEQUENCE.
   *
   * Follows this exact order (verified from manual Cinema Studio usage):
   *   1. Click Generations tab (exit Elements panel if stuck)
   *   2. Click Image tab
   *   3. Click Cinematic Cameras model
   *   4. Set 1/4 image count
   *   5. Set aspect ratio (16:9 or 9:16)
   *   6. Set 2K resolution
   *   7. Set 1x1 grid
   *
   * ANY misclick or 5 seconds of stuck → click Generations tab → restart
   * from step 1. Up to 3 full restart attempts.
   *
   * @param {string} aspectRatio - Target aspect ratio ('16:9' or '9:16')
   * @returns {boolean} true if all settings confirmed
   */
  async _setupToolbarSequence(aspectRatio = '16:9') {
    // ─────────────────────────────────────────────────────────
    // SINGLE-PASS SETUP: set each value once, no nuke loop.
    // Only Image mode + Cinematic Cameras get retry (they're
    // prerequisites). Everything else (aspect, res, grid) is
    // set once here — the Phase 2 hard gate before GENERATE
    // is the single point of truth. If a value didn't stick,
    // Phase 2 catches it.
    // ─────────────────────────────────────────────────────────

    // ── PRE-STEP: Wait for toolbar to render ──
    {
      const page = this._ensurePageAlive();

      // Scroll toolbar into view — on short viewports (< 850px) the toolbar
      // may be partially below the visible area.
      await this._scrollToolbarIntoView();

      this.log('[TOOLBAR] Waiting for toolbar to render...');
      let toolbarReady = false;
      for (let wait = 0; wait < 15; wait++) {
        const indicators = await page.evaluate(() => {
          const vh = window.innerHeight;
          const btns = [...document.querySelectorAll('button')];
          const found = { video: [], image: [], generate: false };
          for (const b of btns) {
            const r = b.getBoundingClientRect();
            if (r.y < vh * 0.55 || r.width === 0) continue;
            const t = b.textContent?.trim() || '';
            if (t === '8s' || t === '15s' || t === '5s' || t === '10s') found.video.push(t);
            if (t === '1080p' || t === '720p' || t === '480p') found.video.push(t);
            if (t.includes('Cinema Studio 3.5') || t.includes('Cinema Studio 3.0')) found.video.push(t);
            if (t.includes('Cinematic Cameras') || t.includes('Nano Banana') || t.includes('Soul Cinema')) found.image.push(t);
            if (/^[124]k$/i.test(t) || t === '1x1') found.image.push(t);
            if (/^GENERATE|^Generate/.test(t)) found.generate = true;
          }
          return found;
        }).catch(() => ({ video: [], image: [], generate: false }));

        if (indicators.video.length > 0 || indicators.image.length > 0) {
          const mode = indicators.video.length > 0 ? 'Video' : 'Image';
          this.log(`[TOOLBAR] ✓ Toolbar rendered in ${wait + 1}s — detected ${mode} mode [${[...indicators.video, ...indicators.image].join(', ')}]`);
          toolbarReady = true;
          break;
        }
        if (indicators.generate && wait >= 5) {
          this.log(`[TOOLBAR] ✓ GENERATE visible but no mode indicators after ${wait + 1}s — proceeding`);
          toolbarReady = true;
          break;
        }
        await page.waitForTimeout(1000);
      }
      if (!toolbarReady) {
        this.log('[TOOLBAR] WARN: Toolbar did not render in 15s — proceeding with setup (may fail)');
      }
    }

    const page = this._ensurePageAlive();

    // ── Step 1: Click Generations tab ──
    this.log('[TOOLBAR] Step 1: Clicking Generations tab...');
    await this._runStepWithStuckGuard('Generations tab', async (p) => {
      await this._ensureGenerationsView();
    });
    await page.waitForTimeout(1000);

    // ── Step 2: Click Image tab (CRITICAL — nuke-worthy if stuck) ──
    this.log('[TOOLBAR] Step 2: Clicking Image tab...');
    await this._runStepWithStuckGuard('Image tab', async (p) => {
      await this._ensureImageMode();
    });
    await page.waitForTimeout(2500);

    // VERIFY Step 2: Image mode must be confirmed.
    const imageConfirmed = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button')];
      const vh = window.innerHeight;

      const hasVideoDuration = btns.some(b => { const t = b.textContent?.trim(); return (t === '8s' || t === '15s') && b.getBoundingClientRect().y > vh * 0.65; });
      const hasVideoRes = btns.some(b => { const t = b.textContent?.trim(); return (t === '1080p' || t === '720p') && b.getBoundingClientRect().y > vh * 0.65; });
      if (hasVideoDuration || hasVideoRes) return { ok: false, reason: 'video-guns' };

      const hasResBtn = btns.some(b => /^[124]k$/i.test(b.textContent?.trim() || '') && b.getBoundingClientRect().y > vh * 0.65);
      const has1x1 = btns.some(b => b.textContent?.trim() === '1x1' && b.getBoundingClientRect().y > vh * 0.65);
      if (hasResBtn || has1x1) return { ok: true, reason: 'image-indicators' };

      const hasImageModel = btns.some(b => {
        const t = b.textContent?.trim() || '';
        const r = b.getBoundingClientRect();
        return r.y > vh * 0.65 && r.width > 0 && (
          t.includes('Cinematic Cameras') || t.includes('Nano Banana') ||
          t.includes('Soul Cinema') || t.includes('Cinematic Characters') ||
          t.includes('Cinematic Locations')
        );
      });
      if (hasImageModel) return { ok: true, reason: 'image-model-name' };

      const allTabs = document.querySelectorAll('button[role="tab"], button');
      const imageTabs = [];
      for (const tab of allTabs) {
        const text = tab.textContent?.trim();
        const r = tab.getBoundingClientRect();
        if (text === 'Image' && r.y > vh * 0.55 && r.width > 0) {
          imageTabs.push({ el: tab, x: r.x, selected: tab.getAttribute('aria-selected') === 'true' });
        }
      }
      if (imageTabs.length > 0) {
        imageTabs.sort((a, b) => a.x - b.x);
        if (imageTabs[0].selected) return { ok: true, reason: 'aria-selected' };
      }

      for (const b of btns) {
        const t = b.textContent?.trim() || '';
        if (/^GENERATE|^Generate/.test(t)) {
          const m = t.match(/([\d,.]+)\s*$/);
          if (m) {
            const cost = parseFloat(m[1].replace(/,/g, ''));
            return cost < 20 ? { ok: true, reason: 'low-cost' } : { ok: false, reason: 'high-cost' };
          }
        }
      }
      return { ok: false, reason: 'no-indicators-toolbar-not-ready' };
    }).catch(() => ({ ok: false, reason: 'error' }));

    if (!imageConfirmed.ok) {
      this.log(`[TOOLBAR] Step 2 FAILED: ${imageConfirmed.reason} — cannot proceed without Image mode`);
      throw new Error(`SETUP FAILED: Image mode not confirmed (${imageConfirmed.reason})`);
    }
    this.log(`[TOOLBAR] Step 2 ✓ Image mode confirmed (${imageConfirmed.reason})`);

    // ── Step 3: Click Cinematic Cameras model ──
    // Activation signals vary by project state:
    //   - EMPTY projects: background text "CINEMA STUDIO 2.5" is visible
    //   - Projects WITH history: no background text, image grid replaces it
    // In BOTH cases, the @ button (SVG icon, no text, width 20-60px in bottom
    // toolbar) appears when Cinematic Cameras is truly active. The @ button is
    // the reliable universal signal. NOTE: Do NOT use the + button as a signal —
    // it's ambiguous with the project creation + button elsewhere in the UI.
    this.log('[TOOLBAR] Step 3: Selecting Cinematic Cameras...');

    let modelActivated = false;
    for (let modelAttempt = 0; modelAttempt < 3; modelAttempt++) {
      if (modelAttempt > 0) {
        this.log(`[TOOLBAR] Step 3 retry ${modelAttempt + 1}/3 — re-selecting Image mode + Cinematic Cameras...`);
        // Re-click Image mode first, then model
        await this._runStepWithStuckGuard('Image tab (retry)', async (p) => {
          await this._ensureImageMode();
        });
        await page.waitForTimeout(2000);
      }

      await this._runStepWithStuckGuard('Cinematic Cameras', async (p) => {
        await this._ensureCinematicCamerasModel();
      }, 8000);
      await page.waitForTimeout(2000);

      // VERIFY activation:
      // 1st scene (empty project): background text "CINEMA STUDIO 2.5" → confirmed
      // Subsequent scenes (has history): @ button (SVG, no text, w=20-60px in
      //   bottom toolbar) + model button text "Cinematic Cameras" → confirmed
      const activation = await page.evaluate(() => {
        const vh = window.innerHeight;

        // Check background text (only present on empty projects)
        const pageText = document.body?.innerText || '';
        const hasBackgroundText = pageText.includes('CINEMA STUDIO 2.5') ||
                                  pageText.includes('Cinema Studio 2.5') ||
                                  pageText.includes('What would you shoot');

        // Check for @ button: no-text SVG button in the bottom toolbar (width 20-60px)
        // This matches _readToolbarState() detection logic.
        const btns = [...document.querySelectorAll('button')];
        let hasAtButton = false;
        let hasModelBtn = false;
        for (const b of btns) {
          const r = b.getBoundingClientRect();
          const text = b.textContent?.trim() || '';
          if (r.y > vh * 0.65 && r.width > 0) {
            // @ button: SVG icon, no text content, width 20-60px
            if (!text && b.querySelector('svg') && r.width >= 20 && r.width <= 60) {
              hasAtButton = true;
            }
            // Model button: shows "Cinematic Cameras" text
            if (text.includes('Cinematic Cameras')) {
              hasModelBtn = true;
            }
          }
        }

        return { hasBackgroundText, hasAtButton, hasModelBtn };
      }).catch(() => ({ hasBackgroundText: false, hasAtButton: false, hasModelBtn: false }));

      this.log(`[TOOLBAR] Step 3 activation check: ${JSON.stringify(activation)}`);

      // Primary check (empty project): background text visible
      if (activation.hasBackgroundText) {
        modelActivated = true;
        this.log('[TOOLBAR] Step 3 ✓ Cinematic Cameras active (background text — empty project)');
        break;
      }

      // Secondary check (project with history): @ button + model button text
      if (activation.hasAtButton && activation.hasModelBtn) {
        modelActivated = true;
        this.log('[TOOLBAR] Step 3 ✓ Cinematic Cameras active (@ button + model button confirmed)');
        break;
      }

      // Tertiary: @ button alone is sufficient (model text might be obscured)
      if (activation.hasAtButton) {
        modelActivated = true;
        this.log('[TOOLBAR] Step 3 ✓ Cinematic Cameras active (@ button confirmed)');
        break;
      }

      this.log(`[TOOLBAR] Step 3: Model NOT truly activated — bg=${activation.hasBackgroundText}, @btn=${activation.hasAtButton}, modelBtn=${activation.hasModelBtn}`);
    }

    if (!modelActivated) {
      // Last-resort check: read full toolbar state
      const modelState = await this._readToolbarState();
      if (modelState.hasAtButton) {
        this.log(`[TOOLBAR] Step 3 ✓ Model confirmed via _readToolbarState @ button (fallback)`);
      } else {
        this.log(`[TOOLBAR] Step 3 FAILED after 3 attempts: model=${modelState?.model}, @btn=${modelState?.hasAtButton}`);
        throw new Error('SETUP FAILED: Cinematic Cameras not truly activated after 3 attempts');
      }
    }

    // ── Step 4: Set 1/4 image count ──
    this.log('[TOOLBAR] Step 4: Setting 1/4 count...');
    await this._runStepWithStuckGuard('1/4 count', async (p) => {
      await this._setImageCount(p);
    });
    await page.waitForTimeout(500);

    // ── Step 5: Set aspect ratio ──
    this.log(`[TOOLBAR] Step 5: Setting aspect ratio ${aspectRatio}...`);
    await this._runStepWithStuckGuard('Aspect ratio', async (p) => {
      await this._setAspectRatio(aspectRatio);
    });
    await page.waitForTimeout(500);

    // ── Step 6: Set 4K resolution (best-effort, not gated) ──
    this.log('[TOOLBAR] Step 6: Setting 4K resolution...');
    try {
      await this._runStepWithStuckGuard('4K resolution', async (p) => {
        await this._setResolution4K(p);
      });
    } catch (e) {
      this.log(`[TOOLBAR] Step 6: 4K selection failed (${e.message}) — continuing with default`);
    }
    await page.waitForTimeout(500);

    // ── Step 7: Set 1x1 grid ──
    this.log('[TOOLBAR] Step 7: Setting 1x1 grid...');
    await this._runStepWithStuckGuard('1x1 grid', async (p) => {
      await this._setGrid1x1(p);
    });
    await page.waitForTimeout(500);

    // ── Log current state (informational only — NO nuke on failure) ──
    const state = await this._readToolbarState();
    this.log(`[TOOLBAR] State after setup: mode=${state.mode}, model=${state.model}, aspect=${state.aspect}, res=${state.resolution}, grid=${state.grid}, @btn=${state.hasAtButton}, generate=${state.hasGenerate}, cost=${state.generateCost}`);
    this.log('[TOOLBAR] ✓ Setup sequence complete — Phase 2 gate will verify before GENERATE');
    return true;
  }

  /**
   * Set image count to 1/4 (click decrement until it shows 1/4).
   * The count is between the model selector and aspect ratio buttons.
   */
  async _setImageCount(page) {
    // The count shows as "1/4", "2/4", "3/4", "4/4" with -/+ buttons
    // We want 1/4. Click decrement until we see it.
    const current = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button')];
      for (const b of btns) {
        const text = b.textContent?.trim();
        if (/^\d+\/\d+$/.test(text) && b.getBoundingClientRect().y > window.innerHeight * 0.65) {
          return text;
        }
      }
      // Also check for standalone text between buttons
      const spans = document.querySelectorAll('span, div');
      for (const s of spans) {
        const text = s.textContent?.trim();
        const r = s.getBoundingClientRect();
        if (/^\d+\/\d+$/.test(text) && r.y > window.innerHeight * 0.65 && r.width < 60) {
          return text;
        }
      }
      return null;
    }).catch(() => null);

    if (current === '1/4') {
      this.log('[COUNT] Already 1/4');
      return;
    }

    // Click the "-" (decrement) button repeatedly
    for (let i = 0; i < 4; i++) {
      const clicked = await page.evaluate(() => {
        // Find decrement button (aria-label or "-" text, in bottom toolbar)
        const btns = document.querySelectorAll('button');
        for (const b of btns) {
          const r = b.getBoundingClientRect();
          if (r.y > window.innerHeight * 0.65 && r.width > 0) {
            const label = b.getAttribute('aria-label') || '';
            const text = b.textContent?.trim();
            if (label.toLowerCase().includes('decrement') || text === '−' || text === '-') {
              b.click();
              return true;
            }
          }
        }
        return false;
      }).catch(() => false);

      if (!clicked) break;
      await page.waitForTimeout(300);
    }
    this.log(`[COUNT] Set to 1/4 (was ${current || 'unknown'})`);
  }

  /**
   * Set resolution to 4K via the resolution dropdown/combobox.
   */
  async _setResolution4K(page) {
    // The resolution shows as "1K", "2K", or "4K" in the toolbar
    // Use y-based controlling-set filter to avoid clicking duplicate toolbar
    const current = await page.evaluate(() => {
      const vh = window.innerHeight;
      const toolbarZone = vh * 0.65;
      const btns = [...document.querySelectorAll('button, select, [role="combobox"]')];
      const modelNames = ['Cinematic Cameras', 'Soul Cinema', 'Nano Banana', 'Cinema Studio', 'Higgsfield Soul'];
      let controllingY = -1, minX = Infinity;
      for (const b of btns) {
        const r = b.getBoundingClientRect();
        const t = b.textContent?.trim() || '';
        if (r.y > toolbarZone && r.width > 0 && modelNames.some(n => t.includes(n))) {
          if (r.x < minX) { minX = r.x; controllingY = r.y; }
        }
      }
      for (const el of btns) {
        const text = el.textContent?.trim();
        const r = el.getBoundingClientRect();
        if (r.y > toolbarZone && r.width > 0 && /^[124]k$/i.test(text)) {
          if (controllingY < 0 || Math.abs(r.y - controllingY) < 3) {
            return text;
          }
        }
      }
      return null;
    }).catch(() => null);

    if (/^4k$/i.test(current)) {
      this.log('[RES] Already 4K');
      return;
    }

    // Click the resolution control from the CONTROLLING set, then select 4K
    const clicked = await page.evaluate(() => {
      const vh = window.innerHeight;
      const toolbarZone = vh * 0.65;
      const btns = [...document.querySelectorAll('button, select, [role="combobox"]')];
      const modelNames = ['Cinematic Cameras', 'Soul Cinema', 'Nano Banana', 'Cinema Studio', 'Higgsfield Soul'];
      let controllingY = -1, minX = Infinity;
      for (const b of btns) {
        const r = b.getBoundingClientRect();
        const t = b.textContent?.trim() || '';
        if (r.y > toolbarZone && r.width > 0 && modelNames.some(n => t.includes(n))) {
          if (r.x < minX) { minX = r.x; controllingY = r.y; }
        }
      }
      for (const el of btns) {
        const text = el.textContent?.trim();
        const r = el.getBoundingClientRect();
        if (r.y > toolbarZone && r.width > 0 && /^[124]k$/i.test(text)) {
          if (controllingY < 0 || Math.abs(r.y - controllingY) < 3) {
            el.click();
            return true;
          }
        }
      }
      return false;
    }).catch(() => false);

    if (clicked) {
      await page.waitForTimeout(500);
      // Select "4K" from dropdown — items have subtitles like
      // "4K Ultra · Highest Detail, Longer Processing"
      // so match elements whose text STARTS with "4K", and pick
      // the smallest (most specific) element to avoid clicking
      // a parent container.
      const selected = await page.evaluate(() => {
        const allEls = document.querySelectorAll('[role="option"], [role="listbox"] *, div, li, span, button');
        let best = null;
        let bestArea = Infinity;
        for (const el of allEls) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          const text = el.textContent?.trim() || '';
          if (/^4K/i.test(text) && r.y > window.innerHeight * 0.2) {
            const area = r.width * r.height;
            if (area < bestArea) { best = el; bestArea = area; }
          }
        }
        if (best) { best.click(); return true; }
        return false;
      }).catch(() => false);

      if (selected) {
        this.log('[RES] Set to 4K');
      } else {
        this.log('[RES] Could not select 4K from dropdown');
        await page.keyboard.press('Escape').catch(() => {});
      }
    } else {
      this.log('[RES] Resolution control not found — may already be 2K');
    }
  }

  /**
   * Set grid to 1x1 by clicking the grid toggle button.
   */
  async _setGrid1x1(page) {
    // Use y-based controlling-set filter to avoid clicking duplicate toolbar
    const current = await page.evaluate(() => {
      const vh = window.innerHeight;
      const toolbarZone = vh * 0.65;
      const btns = [...document.querySelectorAll('button')];
      const modelNames = ['Cinematic Cameras', 'Soul Cinema', 'Nano Banana', 'Cinema Studio', 'Higgsfield Soul'];
      let controllingY = -1, minX = Infinity;
      for (const b of btns) {
        const r = b.getBoundingClientRect();
        const t = b.textContent?.trim() || '';
        if (r.y > toolbarZone && r.width > 0 && modelNames.some(n => t.includes(n))) {
          if (r.x < minX) { minX = r.x; controllingY = r.y; }
        }
      }
      for (const b of btns) {
        const text = b.textContent?.trim();
        const r = b.getBoundingClientRect();
        if (r.y > toolbarZone && r.width > 0 && /^\d+x\d+$/.test(text)) {
          if (controllingY < 0 || Math.abs(r.y - controllingY) < 3) return text;
        }
      }
      return null;
    }).catch(() => null);

    if (current === '1x1') {
      this.log('[GRID] Already 1x1');
      return;
    }

    // Click the grid button to toggle (controlling set only). Cycles: 1x1 → 2x2 → 1x1
    for (let i = 0; i < 3; i++) {
      const result = await page.evaluate(() => {
        const vh = window.innerHeight;
        const toolbarZone = vh * 0.65;
        const btns = [...document.querySelectorAll('button')];
        const modelNames = ['Cinematic Cameras', 'Soul Cinema', 'Nano Banana', 'Cinema Studio', 'Higgsfield Soul'];
        let controllingY = -1, minX = Infinity;
        for (const b of btns) {
          const r = b.getBoundingClientRect();
          const t = b.textContent?.trim() || '';
          if (r.y > toolbarZone && r.width > 0 && modelNames.some(n => t.includes(n))) {
            if (r.x < minX) { minX = r.x; controllingY = r.y; }
          }
        }
        for (const b of btns) {
          const text = b.textContent?.trim();
          const r = b.getBoundingClientRect();
          if (r.y > toolbarZone && r.width > 0 && /^\d+x\d+$/.test(text)) {
            if (controllingY < 0 || Math.abs(r.y - controllingY) < 3) {
              if (text === '1x1') return { text, done: true };
              b.click();
              return { text, done: false };
            }
          }
        }
        return { text: null, done: false };
      }).catch(() => ({ text: null, done: false }));

      if (result.done) {
        this.log('[GRID] Already 1x1');
        return;
      }
      if (result.text) {
        await page.waitForTimeout(500);
      } else {
        break;
      }
    }

    this.log(`[GRID] Set to 1x1 (was ${current || 'unknown'})`);
  }

  /**
   * RECOVERY: If the Elements panel is open (no prompt textbox / no GENERATE button visible),
   * click the "Generations" tab to get back to the generation view.
   * If that fails, navigate home and back to the project.
   *
   * This handles a common stuck state where the UI shows the Elements list
   * instead of the prompt/generate area.
   */
  async _ensureGenerationsView() {
    const page = this._ensurePageAlive();

    // ── Detection: Are we on the Elements panel or the Generations (prompt) view? ──
    // Elements panel signals (from real DOM dumps):
    //   - "Add to Project" buttons scattered everywhere
    //   - "Delete" + "Save" buttons (element editing)
    //   - "Advanced settings" text
    //   - "Create Element" button
    //   - "Project elements" / "Personal elements" headings
    //   - NO "GENERATE" button with a credit number
    //   - NO Image/Video role="tab" buttons
    //
    // Generations view signals:
    //   - prompt textbox: [role="textbox"][contenteditable="true"]
    //   - "GENERATE" or "Generate" button with a credit number
    //   - Image/Video tabs with role="tab"
    //   - Model selector button (e.g. "Cinematic Cameras", "Nano Banana Pro")

    const viewState = await page.evaluate(() => {
      const allBtns = [...document.querySelectorAll('button')];
      const allText = allBtns.map(b => b.textContent?.trim() || '');

      // ── Positive signals for Generations view ──
      const hasTextbox = !!document.querySelector('[role="textbox"][contenteditable="true"]');
      const hasGenerate = allText.some(t => /^GENERATE|^Generate/.test(t) && /\d/.test(t));
      const hasImageVideoTabs = !!document.querySelector('button[role="tab"]');

      // ── Positive signals for Elements panel ──
      const addToProjectCount = allText.filter(t => t === 'Add to Project').length;
      const hasDeleteSave = allText.some(t => t === 'Delete') && allText.some(t => t === 'Save');
      const hasCreateElement = allText.some(t => t === 'Create Element');
      const hasAdvancedSettings = allText.some(t => t === 'Advanced settings');

      // Check for "Project elements" or "Personal elements" headings anywhere in the page
      const pageText = document.body?.innerText || '';
      const hasProjectElements = pageText.includes('Project elements') || pageText.includes('Personal elements');

      // Elements panel score: how many signals match
      const elemScore = (addToProjectCount >= 2 ? 2 : 0) +
                        (hasDeleteSave ? 2 : 0) +
                        (hasCreateElement ? 1 : 0) +
                        (hasAdvancedSettings ? 1 : 0) +
                        (hasProjectElements ? 2 : 0);

      // If we have GENERATE button and Image/Video tabs, we're good
      if (hasGenerate && hasImageVideoTabs) {
        return { view: 'generations', ok: true, elemScore };
      }

      // If strong Elements signals and no GENERATE button — we're stuck on Elements
      if (elemScore >= 2 && !hasGenerate) {
        // Find and click the Generations tab (top of page, near "Elements" tab)
        let clicked = false;
        for (const b of allBtns) {
          const text = b.textContent?.trim();
          const r = b.getBoundingClientRect();
          // Generations tab is in the top area of the page
          if (text === 'Generations' && r.y < window.innerHeight * 0.25 && r.width > 0 && r.height > 0) {
            b.click();
            clicked = true;
            break;
          }
        }
        return { view: 'elements', action: clicked ? 'clicked-generations' : 'no-generations-btn', elemScore, addToProjectCount };
      }

      // Ambiguous — might be loading or in a weird state
      return { view: 'unknown', hasTextbox, hasGenerate, hasImageVideoTabs, elemScore, addToProjectCount };
    }).catch(e => ({ view: 'error', error: e.message }));

    this.log(`[VIEW-CHECK] Current view: ${JSON.stringify(viewState)}`);

    if (viewState.ok) {
      return; // Already in generations view
    }

    // ── Recovery: keep clicking Generations tab until we're out ──
    // The ONLY way out of the Elements panel is clicking "Generations".
    // Going home does NOT work — the Elements panel persists across navigation.
    for (let retry = 0; retry < 5; retry++) {
      if (viewState.action === 'clicked-generations' || retry > 0) {
        if (retry === 0) {
          this.log('[VIEW-CHECK] Was on Elements panel — clicked Generations to recover');
        } else {
          this.log(`[VIEW-CHECK] Retry ${retry + 1}/5 — clicking Generations tab...`);
        }
        await page.waitForTimeout(3000);

        // Verify we're now in generations view
        const recovered = await page.evaluate(() => {
          const hasGenerate = [...document.querySelectorAll('button')].some(b =>
            /^GENERATE|^Generate/.test(b.textContent?.trim() || '') && /\d/.test(b.textContent));
          const hasTabs = !!document.querySelector('button[role="tab"]');
          return hasGenerate || hasTabs;
        }).catch(() => false);

        if (recovered) {
          this.log('[VIEW-CHECK] ✓ Recovered to Generations view');
          return;
        }

        // Try clicking Generations tab again
        const clicked = await page.evaluate(() => {
          const btns = document.querySelectorAll('button');
          for (const b of btns) {
            const text = b.textContent?.trim();
            const r = b.getBoundingClientRect();
            if (text === 'Generations' && r.width > 0 && r.height > 0 && r.y < window.innerHeight * 0.25) {
              b.click();
              return true;
            }
          }
          return false;
        }).catch(() => false);

        if (!clicked) {
          this.log('[VIEW-CHECK] Generations tab not found — waiting for it to appear');
          await page.waitForTimeout(2000);
        }
      } else {
        // First attempt wasn't a Generations click (e.g. no-generations-btn or unknown state)
        // Try finding and clicking the Generations tab
        const clicked = await page.evaluate(() => {
          const btns = document.querySelectorAll('button');
          for (const b of btns) {
            const text = b.textContent?.trim();
            const r = b.getBoundingClientRect();
            if (text === 'Generations' && r.width > 0 && r.height > 0 && r.y < window.innerHeight * 0.25) {
              b.click();
              return true;
            }
          }
          return false;
        }).catch(() => false);

        if (clicked) {
          this.log('[VIEW-CHECK] Found and clicked Generations tab');
        } else {
          this.log('[VIEW-CHECK] Generations tab not found at all');
          await page.waitForTimeout(2000);
        }
      }
    }

    this.log('[VIEW-CHECK] WARN: Could not switch to Generations view after 5 attempts');
  }

  /**
   * Read the current toolbar state to verify settings.
   * Returns { mode, model, hasAtButton, aspect, hasGenerate, generateCost }
   */
  async _readToolbarState() {
    const page = this._ensurePageAlive();
    return page.evaluate(() => {
      const vh = window.innerHeight;
      const vw = window.innerWidth;
      const btns = [...document.querySelectorAll('button')];
      const result = {
        mode: 'unknown',   // 'image' or 'video'
        model: 'unknown',
        hasAtButton: false,
        aspect: null,
        resolution: null,
        grid: null,
        hasGenerate: false,
        generateCost: null,
      };

      // Detect Image/Video mode from MULTIPLE signals (not just role="tab"):
      //
      // Signal 1: aria-selected on role="tab" elements (may not exist)
      // Signal 2: Toolbar button indicators:
      //   Video mode: "8s" duration, "1080p" res, "Cinema Studio 3.5" model, "Off" audio
      //   Image mode: "2K" res, "1x1" grid, "Cinematic Cameras"/"Nano Banana" model
      // Signal 3: GENERATE cost: Image = 2-4 credits, Video = 9680 credits
      //
      // Priority: toolbar indicators > aria-selected > cost inference

      // Try aria-selected first
      const allTabs = document.querySelectorAll('button[role="tab"], button');
      let imageTabSelected = false;
      let videoTabSelected = false;
      for (const tab of allTabs) {
        const text = tab.textContent?.trim();
        const r = tab.getBoundingClientRect();
        if (r.width === 0) continue;
        const selected = tab.getAttribute('aria-selected') === 'true';
        if (text === 'Image' && selected) imageTabSelected = true;
        if (text === 'Video' && selected) videoTabSelected = true;
      }

      // Scan toolbar for smoking-gun indicators
      let hasVideoGuns = false; // "8s", "1080p", "Cinema Studio 3.5"
      let hasImageGuns = false; // "2K", "1x1"
      for (const b of btns) {
        const r = b.getBoundingClientRect();
        const t = b.textContent?.trim() || '';
        if (r.y > vh * 0.65 && r.width > 0) {
          if (t === '8s' || t === '15s' || t === '1080p' || t === '720p') hasVideoGuns = true;
          if (/^2k$/i.test(t) || t === '1x1') hasImageGuns = true;
        }
      }

      // Determine mode
      if (hasImageGuns && !hasVideoGuns) result.mode = 'image';
      else if (hasVideoGuns && !hasImageGuns) result.mode = 'video';
      else if (imageTabSelected) result.mode = 'image';
      else if (videoTabSelected) result.mode = 'video';

      // ── DUAL TOOLBAR FIX (revised April 2026) ──
      // The DOM renders TWO duplicate toolbar sets at slightly different positions.
      // Only the LEFTMOST model button's set actually controls the UI.
      //
      // KEY INSIGHT: The two sets differ by Y position (~4px apart), NOT x.
      // Within each set, buttons span a wide x range (model at x=373, aspect
      // at x=592, resolution at x=653). Using x-proximity to the model button
      // would filter out aspect/resolution/grid.
      //
      // Strategy: Find the leftmost model button → get its y → all toolbar
      // buttons within ±5px of that y belong to the controlling set.
      const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const panelFor = (el) => {
        for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
          const r = n.getBoundingClientRect();
          const text = norm(n.innerText || n.textContent || '');
          if (r.x >= 550 && r.y > vh * 0.55 && r.width >= 450 && r.height >= 60 &&
              text.includes('Cinematic Cameras') &&
              !text.includes('Nano Banana') &&
              !text.includes('Cinema Studio 3.5') &&
              !text.includes('1080p') &&
              !text.includes('720p') &&
              !/\b(8s|15s)\b/.test(text)) {
            return { x: r.x, y: r.y, w: r.width, h: r.height, text };
          }
        }
        return null;
      };

      const activeCinematicButtons = btns
        .map((b) => ({ el: b, panel: panelFor(b) }))
        .filter((item) => item.panel);

      if (activeCinematicButtons.length > 0) {
        result.mode = 'image';
        result.model = 'cinematic-cameras';
        for (const { el } of activeCinematicButtons) {
          const r = el.getBoundingClientRect();
          const text = el.textContent?.trim() || '';
          if (/^(9:16|16:9|1:1|3:4|4:3|2:3|3:2|21:9)$/.test(text)) {
            result.aspect = text;
          } else if (/^(1k|2k|4k)$/i.test(text)) {
            result.resolution = text.toUpperCase();
          } else if (/^(1x1|2x2|1x2|2x1)$/.test(text)) {
            result.grid = text;
          } else if (!text && el.querySelector('svg') && r.width >= 20 && r.width <= 60) {
            result.hasAtButton = true;
          } else if (text.includes('GENERATE') || /^Generate\d/.test(text)) {
            result.hasGenerate = true;
            const costMatch = text.match(/([\d,.]+)\s*$/);
            if (costMatch) result.generateCost = parseFloat(costMatch[1].replace(/,/g, ''));
          }
        }
        return result;
      }

      const modelNames = [
        'Cinematic Cameras', 'Cinematic Characters', 'Cinematic Locations',
        'Soul Cinema', 'Cinema Studio', 'Higgsfield Soul', 'Nano Banana',
        'Kling', 'Auto',
      ];
      const modelBtns = [];
      for (const b of btns) {
        const r = b.getBoundingClientRect();
        const text = b.textContent?.trim() || '';
        if (r.y > vh * 0.65 && r.width > 0) {
          for (const name of modelNames) {
            if (text.includes(name) || (name === 'Auto' && text === 'Auto')) {
              modelBtns.push({ el: b, x: r.x, y: r.y, text });
              break;
            }
          }
        }
      }
      // The controlling set is the leftmost model button — use its Y to identify the set
      let controllingY = -1;
      let controllingModelRight = -1;
      let controllingRowRight = Infinity;
      if (modelBtns.length > 0) {
        const cinematicBtns = modelBtns.filter(b => b.text.includes('Cinematic Cameras'));
        const controlling = (cinematicBtns.length > 0 ? cinematicBtns : modelBtns)
          .reduce((a, b) => a.x < b.x ? a : b);
        controllingY = controlling.y;
        const modelRect = controlling.el.getBoundingClientRect();
        controllingModelRight = modelRect.x + modelRect.width;
        const sameYNextModel = modelBtns
          .filter(b => b.x > controlling.x && Math.abs(b.y - controllingY) < 3)
          .sort((a, b) => a.x - b.x)[0];
        controllingRowRight = sameYNextModel ? sameYNextModel.x - 2 : Infinity;
      }

      for (const b of btns) {
        const r = b.getBoundingClientRect();
        const text = b.textContent?.trim() || '';

        // Toolbar buttons (bottom area)
        // DUAL TOOLBAR FIX: Only read from buttons at the same Y as the controlling
        // (leftmost) model button. The duplicate set is ~4px offset in Y.
        if (r.y > vh * 0.65 && r.width > 0) {
          const isControllingSet = (controllingY < 0 || Math.abs(r.y - controllingY) < 3) &&
            r.x < controllingRowRight;

          if (isControllingSet) {
            if (text.includes('Cinematic Cameras')) result.model = 'cinematic-cameras';
            else if (text.includes('Cinematic Characters')) result.model = 'cinematic-characters';
            else if (text.includes('Cinematic Locations')) result.model = 'cinematic-locations';
            else if (text.includes('Cinema Studio')) result.model = 'cinema-studio-3.5';
            else if (text.includes('Soul Cinema')) result.model = 'soul-cinema';
            else if (text.includes('Higgsfield Soul')) result.model = 'higgsfield-soul';
            else if (text.includes('Nano Banana')) result.model = 'nano-banana-pro';
            else if (text.includes('Kling')) result.model = 'kling';
            else if (text === 'Auto') result.model = 'auto';
          }

          // Aspect ratio (read from controlling set only)
          if (isControllingSet &&
              (controllingModelRight < 0 || r.x >= controllingModelRight - 2) &&
              /^(9:16|16:9|1:1|3:4|4:3|2:3|3:2|21:9)$/.test(text)) {
            result.aspect = text;
          }

          // Resolution (read from controlling set only)
          if (isControllingSet &&
              (controllingModelRight < 0 || r.x >= controllingModelRight - 2) &&
              /^(1k|2k|4k)$/i.test(text)) {
            result.resolution = text.toUpperCase().replace('K', 'K'); // normalize to "2K"
          }

          // Grid (read from controlling set only)
          if (isControllingSet &&
              (controllingModelRight < 0 || r.x >= controllingModelRight - 2) &&
              /^(1x1|2x2|1x2|2x1)$/.test(text)) {
            result.grid = text;
          }

          // @ button: no-text SVG button after the grid controls
          if (!text && b.querySelector('svg') && r.width >= 20 && r.width <= 60) {
            result.hasAtButton = true;
          }
        }

        // GENERATE button (can be "GENERATE ✦ 2" or "Generate2" depending on viewport/mode)
        if (text.includes('GENERATE') || /^Generate\d/.test(text)) {
          result.hasGenerate = true;
          // Extract credit cost from text like "GENERATE ✦ 0.125" or "GENERATE ✦ 4840" or "Generate2"
          const costMatch = text.match(/([\d,.]+)\s*$/);
          if (costMatch) result.generateCost = parseFloat(costMatch[1].replace(/,/g, ''));
        }
      }

      // If mode is still unknown, infer from toolbar indicators
      // Video mode shows: duration (8s), resolution (720p), Audio
      // Image mode shows: model name, aspect ratio (16:9), 2K, 1x1, @
      if (result.mode === 'unknown') {
        const allText = document.body.innerText || '';
        if (allText.includes('720p') || allText.includes('1080p') || allText.includes(' 8s')) {
          result.mode = 'video';
        } else if (result.hasAtButton || result.model === 'cinematic-cameras' ||
                   result.model === 'soul-cinema' || result.model === 'cinematic-characters' ||
                   result.model === 'cinematic-locations') {
          result.mode = 'image';
        }
      }

      return result;
    }).catch(() => ({ mode: 'unknown', model: 'unknown', hasAtButton: false }));
  }

  /**
   * Ensure Image mode is active (not Video).
   *
   * The Image/Video toggle is in the LEFT SIDEBAR (not bottom toolbar).
   * Two stacked buttons with icons + text "Image" and "Video".
   * Clicking Image switches the entire toolbar layout.
   *
   * Retries up to 3 times with waits — the sidebar may not be rendered yet.
   */
  /**
   * Ensure Image mode is active (not Video).
   *
   * KEY FINDING (April 2026 live testing):
   *   The Image/Video toggle is a pair of tab buttons (role="tab") in the
   *   bottom-left of the viewport. They use aria-selected="true"/"false".
   *
   *   CRITICAL: There are TWO duplicate sets of Image/Video tabs in the DOM
   *   (overlapping at slightly different x positions). Only ONE set actually
   *   controls the UI. The controlling set is the one whose tab at the
   *   LEFTMOST x position. Clicking the wrong set does nothing visually.
   *
   *   Reliable identification:
   *     - role="tab" + text="Image" or "Video"
   *     - Check aria-selected to know current state
   *     - Group by x position, pick the leftmost group
   *     - The tabs are at y > 700 (near bottom of 847px viewport)
   */
  async _ensureImageMode() {
    const page = this._ensurePageAlive();

    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        await page.waitForTimeout(2000);
        this.log(`[IMAGE-MODE] Retry ${attempt + 1}/3...`);
      }

      try {
        // Find the Image/Video mode toggle button in the BOTTOM area only.
        // CRITICAL: There are TWO "Image" texts in the DOM:
        //   1. Top navigation bar (Explore, Image, Video, Audio, Chat...) at y < 50px
        //   2. Bottom mode toggle near the prompt area at y > 80% viewport height (~x 390-420)
        // We MUST only target #2 — the bottom mode toggle.
        // From screenshot: Image btn at ~(400, 655), Video btn at ~(400, 695), viewport 1920x847
        // Top nav "Image" is at ~(125, 22). So y > 55% safely excludes the top nav.
        const result = await page.evaluate(() => {
          const vh = window.innerHeight;
          const allBtns = document.querySelectorAll('button, [role="tab"]');
          const imageBtns = [];
          const videoBtns = [];

          for (const btn of allBtns) {
            const text = btn.textContent?.trim();
            const r = btn.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;

            // POSITION FILTER: Only match buttons in the bottom area of the screen.
            // The Image/Video mode toggle lives at approximately:
            //   y > 55% of viewport height (bottom half — around y=655 in 847px viewport)
            //   x can be anywhere from ~380 to ~500 (left of the prompt box)
            // The top nav "Image" is at y ~22px — well above 55% threshold.
            // NO x constraint — the y threshold alone is sufficient and robust.
            const isBottom = r.y > vh * 0.55;

            if (text === 'Image' && isBottom) {
              imageBtns.push({
                el: btn,
                x: Math.round(r.x), y: Math.round(r.y),
                w: Math.round(r.width), h: Math.round(r.height),
                selected: btn.getAttribute('aria-selected') === 'true',
                hasRole: btn.getAttribute('role') === 'tab',
              });
            }
            if (text === 'Video' && isBottom) {
              videoBtns.push({
                el: btn,
                x: Math.round(r.x), y: Math.round(r.y),
                selected: btn.getAttribute('aria-selected') === 'true',
              });
            }
          }

          // If no bottom-left Image button found, also report what we DID find for debugging
          if (imageBtns.length === 0) {
            const allImageBtns = [];
            for (const btn of allBtns) {
              const text = btn.textContent?.trim();
              const r = btn.getBoundingClientRect();
              if (r.width > 0 && r.height > 0 && text === 'Image') {
                allImageBtns.push({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
              }
            }
            return { status: 'no-image-btn', btnCount: allBtns.length, allImagePositions: allImageBtns, vh: Math.round(vh) };
          }

          // Pick the leftmost Image button (controlling set if duplicates exist)
          imageBtns.sort((a, b) => a.x - b.x);
          const target = imageBtns[0];

          // Check if already selected
          if (target.selected) {
            return { status: 'already-image', x: target.x, y: target.y };
          }

          // Also check: if Video button exists and is NOT selected,
          // Image might already be active (no aria-selected on either sometimes)
          // In that case, check the bottom toolbar for Image-mode indicators
          const toolbarBtns = [...document.querySelectorAll('button')];
          const hasImageIndicators = toolbarBtns.some(b => {
            const t = b.textContent?.trim() || '';
            const br = b.getBoundingClientRect();
            return br.y > window.innerHeight * 0.65 && (
              t.includes('Cinematic Cameras') || /^2k$/i.test(t) || t === '1x1' ||
              t.includes('Nano Banana') || t.includes('Soul Cinema')
            );
          });
          const hasVideoIndicators = toolbarBtns.some(b => {
            const t = b.textContent?.trim() || '';
            const br = b.getBoundingClientRect();
            return br.y > window.innerHeight * 0.65 && (
              t.includes('Cinema Studio 3.5') || t === '8s' || t === '15s' || t === '1080p' || t === '720p' ||
              t.includes('Cinema Studio 3.0') || t.includes('Cinema Studio 2.5') || t.includes('Kling')
            );
          });

          if (hasImageIndicators && !hasVideoIndicators) {
            return { status: 'already-image', x: target.x, y: target.y, viaToolbar: true };
          }

          // Return coordinates — we'll click with page.mouse.click() for isTrusted events.
          // CRITICAL: dispatchEvent(new PointerEvent/MouseEvent) is NOT isTrusted.
          // Only CDP Input.dispatchMouseEvent (via page.mouse.click) produces isTrusted
          // events that Cinema Studio's React/Radix handlers accept.
          return {
            status: 'need-click',
            x: target.x, y: target.y, w: target.w, h: target.h,
            cx: Math.round(target.el.getBoundingClientRect().x + target.el.getBoundingClientRect().width / 2),
            cy: Math.round(target.el.getBoundingClientRect().y + target.el.getBoundingClientRect().height / 2),
          };
        });

        if (result.status === 'already-image') {
          this.log(`[IMAGE-MODE] ✓ Already in Image mode (x=${result.x}, y=${result.y}${result.viaToolbar ? ', detected via toolbar' : ''})`);
          return;
        }

        if (result.status === 'need-click') {
          // Click with REAL mouse (isTrusted) via CDP Input.dispatchMouseEvent
          await page.mouse.click(result.cx, result.cy);
          this.log(`[IMAGE-MODE] Image button clicked at (${result.cx}, ${result.cy}) via real mouse, size ${result.w}x${result.h}`);
          await page.waitForTimeout(2000);

          // Verify: toolbar should now show Image-mode indicators
          // (no "Cinema Studio 3.5", no "8s", no "1080p" — instead shows "Cinematic Cameras" or "2K" or "1x1")
          const verified = await page.evaluate(() => {
            const btns = [...document.querySelectorAll('button')];
            // Video-mode smoking guns: "8s" duration, "1080p", Cinema Studio 3.5 model
            const videoGuns = btns.some(b => {
              const t = b.textContent?.trim() || '';
              const r = b.getBoundingClientRect();
              return r.y > window.innerHeight * 0.65 && (t === '8s' || t === '15s' || t === '1080p' || t === '720p');
            });
            if (videoGuns) return false;

            // Positive check: GENERATE cost should be small (2-4 for image, 9680 for video)
            for (const b of btns) {
              const t = b.textContent?.trim() || '';
              if (/^GENERATE|^Generate/.test(t)) {
                const m = t.match(/([\d,.]+)\s*$/);
                if (m) {
                  const cost = parseFloat(m[1].replace(/,/g, ''));
                  return cost < 20; // Image mode = 2 credits, Video = 9680
                }
              }
            }
            return false; // No GENERATE button found — toolbar not ready, can't confirm Image mode
          }).catch(() => false);

          if (verified) {
            this.log('[IMAGE-MODE] ✓ Image mode confirmed (no video indicators in toolbar)');
            return;
          }
          this.log('[IMAGE-MODE] Clicked Image but video indicators still present — retrying');
        } else {
          const posInfo = result.allImagePositions?.length
            ? ` — found ${result.allImagePositions.length} "Image" btn(s) outside bottom zone (y>${Math.round(result.vh*0.55)}): ${JSON.stringify(result.allImagePositions)} (vh=${result.vh})`
            : '';
          this.log(`[IMAGE-MODE] ${result.status} (${result.btnCount || 0} buttons scanned${posInfo}) — waiting for Image button to render`);
        }
      } catch (e) {
        this.log(`[IMAGE-MODE] Error: ${e.message.split('\n')[0]}`);
      }
    }

    this.log('[IMAGE-MODE] FAILED: Could not confirm Image mode after 3 attempts');
    throw new Error('Image mode switch failed after 3 attempts');
  }

  /**
   * Ensure the Cinematic Cameras model is selected (not Cinema Studio 3.5).
   *
   * Cinema Studio 3.5 is a VIDEO model — it generates videos at 720p/8s.
   * Cinematic Cameras is the IMAGE model — it generates stills at 2K.
   * If the toolbar shows "Cinema Studio 3.5", we need to switch to "Cinematic Cameras".
   *
   * The model selector button is in the bottom toolbar. Clicking it opens a dropdown
   * with model options. We look for and click "Cinematic Cameras".
   *
   * KEY INDICATOR: If the @ button is NOT visible in the toolbar, the wrong model
   * is selected. The @ button only appears with Cinematic Cameras.
   */
  async _ensureCinematicCamerasModel() {
    const page = this._ensurePageAlive();

    // ── BOUNDARY CHECK: Where are we? ──
    // Before anything, read toolbar to understand current state.
    // Log ALL buttons in the bottom toolbar, marking which belong to the controlling (leftmost) set.
    const toolbarDebug = await page.evaluate(() => {
      const vh = window.innerHeight;
      const btns = [...document.querySelectorAll('button')];
      const modelNames = [
        'Cinematic Cameras', 'Cinematic Characters', 'Cinematic Locations',
        'Soul Cinema', 'Cinema Studio', 'Higgsfield Soul', 'Nano Banana', 'Kling',
      ];
      const bottomBtns = btns.filter(b => {
        const r = b.getBoundingClientRect();
        return r.y > vh * 0.65 && r.width > 0 && r.height > 0;
      });
      // Find controlling set by leftmost model button → use its Y
      let controllingY = -1;
      let controllingX = Infinity;
      for (const b of bottomBtns) {
        const text = b.textContent?.trim() || '';
        const r = b.getBoundingClientRect();
        if (modelNames.some(n => text.includes(n)) && r.x < controllingX) {
          controllingX = r.x;
          controllingY = r.y;
        }
      }
      return bottomBtns.map(b => {
        const r = b.getBoundingClientRect();
        const text = (b.textContent?.trim() || '(no text)').slice(0, 40);
        const isModel = modelNames.some(n => text.includes(n));
        return {
          text,
          x: Math.round(r.x),
          y: Math.round(r.y),
          w: Math.round(r.width),
          h: Math.round(r.height),
          hasSvg: !!b.querySelector('svg'),
          ...(isModel ? { controlling: controllingY > 0 && Math.abs(r.y - controllingY) < 3 } : {}),
        };
      });
    }).catch(() => []);
    this.log(`[MODEL] Bottom toolbar buttons: ${JSON.stringify(toolbarDebug)}`);

    // ALWAYS re-select Cinematic Cameras even if toolbar already shows it.
    // Cinema Studio can show "Cinematic Cameras" in the toolbar text without
    // the model being truly activated (the + and @ buttons won't appear until
    // the user explicitly clicks the option in the dropdown). So we never
    // skip — we always open the dropdown and click Cinematic Cameras.
    const currentState = await this._readToolbarState();
    this.log(`[MODEL] Current model: ${currentState.model} — will (re)select Cinematic Cameras`);

    // ── Find and click the model selector button ──
    // The model button shows the model name text: "Cinema Studio 3.5",
    // "Cinematic Cameras", "Soul Cinema", etc. It's in the bottom toolbar.
    // CRITICAL: Don't fall back to "first wide button" — that hits the wrong element.
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) {
        await page.waitForTimeout(2500);
        this.log(`[MODEL] Retry ${attempt + 1}/4...`);
      }

      try {
        // Step A: FIND the model selector button (don't click via JS — need isTrusted)
        //
        // CRITICAL (April 2026): Cinema Studio uses React/Radix components that
        // ONLY respond to isTrusted browser events. el.click() from page.evaluate()
        // is NOT isTrusted and the dropdown silently ignores it. We MUST use
        // page.mouse.click(x, y) which goes through CDP Input.dispatchMouseEvent
        // and produces isTrusted events.
        //
        // DUAL TOOLBAR FIX: Only target the model button from the LEFTMOST
        // (controlling) set. The duplicate set at higher x shows a different
        // model and clicking it does nothing.
        const modelBtnInfo = await page.evaluate(() => {
          const vh = window.innerHeight;
          const btns = document.querySelectorAll('button');
          const modelNames = [
            'Cinematic Cameras', 'Cinematic Characters', 'Cinematic Locations',
            'Soul Cinema', 'Cinema Studio 3.5', 'Cinema Studio',
            'Higgsfield Soul', 'Nano Banana Pro', 'Nano Banana',
            'Kling 3.0', 'Kling',
          ];

          // First pass: collect all model-name buttons and find the leftmost x
          const modelBtnCandidates = [];
          for (const b of btns) {
            const r = b.getBoundingClientRect();
            const text = b.textContent?.trim() || '';
            if (r.y > vh * 0.65 && r.width > 0) {
              for (const name of modelNames) {
                if (text.includes(name)) {
                  modelBtnCandidates.push({ x: r.x, y: r.y, w: r.width, h: r.height, text });
                  break;
                }
              }
            }
          }

          // Find the controlling (leftmost) x among model buttons
          const controllingX = modelBtnCandidates.length > 0
            ? Math.min(...modelBtnCandidates.map(m => m.x))
            : -1;

          // Priority 1: Model button from the controlling (leftmost) set only
          // ALWAYS click it to open the dropdown — even if it already shows
          // "Cinematic Cameras" — because the model may not be truly activated
          // until the user explicitly selects it from the dropdown.
          for (const candidate of modelBtnCandidates) {
            if (controllingX >= 0 && Math.abs(candidate.x - controllingX) < 3) {
              return {
                method: 'model-name-leftmost',
                text: candidate.text,
                cx: Math.round(candidate.x + candidate.w / 2),
                cy: Math.round(candidate.y + candidate.h / 2),
              };
            }
          }

          // Priority 2: Wide text button in bottom toolbar (not GENERATE, not element rows)
          const allTexts = [...btns].map(b => b.textContent?.trim() || '');
          const onElementsPanel = allTexts.filter(t => t === 'Add to Project').length >= 2;
          if (!onElementsPanel) {
            for (const b of btns) {
              const r = b.getBoundingClientRect();
              if (r.y > vh * 0.65 && r.width > 100 && r.height > 20 && r.height < 50) {
                const text = b.textContent?.trim() || '';
                if (text.length > 5 && text.length < 40 && !text.match(/^\d/) && !text.includes('GENERATE') && !text.includes('Add to Project')) {
                  return {
                    method: 'wide-text-btn',
                    text,
                    cx: Math.round(r.x + r.width / 2),
                    cy: Math.round(r.y + r.height / 2),
                  };
                }
              }
            }
          }

          return false;
        });

        if (!modelBtnInfo) {
          this.log('[MODEL] Model selector button not found in toolbar');
          await page.waitForTimeout(2000);
          continue;
        }

        // Click with REAL mouse (isTrusted) — NOT el.click()
        await page.mouse.click(modelBtnInfo.cx, modelBtnInfo.cy);
        this.log(`[MODEL] Model selector clicked at (${modelBtnInfo.cx}, ${modelBtnInfo.cy}) via real mouse: ${JSON.stringify(modelBtnInfo)}`);
        await page.waitForTimeout(3000); // Wait for dropdown to fully appear

        // Step B: Click "Cinematic Cameras" in the dropdown using Playwright
        // locators — they automatically find the right clickable element and
        // produce isTrusted events via CDP. The previous evaluate approach
        // was hitting parent containers instead of the actual option row.
        //
        // From the Cinema Studio UI, the dropdown option row shows:
        //   [icon] Cinematic Cameras
        //          Image generation with camera controls  [✓]
        //
        // Strategy: Try multiple approaches to click the right option.
        let optionClicked = false;

        // Approach 1: Find "Image generation with camera controls" subtitle
        // — this text is UNIQUE to the dropdown option (not in the toolbar).
        try {
          const subtitle = page.getByText('Image generation with camera controls').first();
          if (await subtitle.isVisible({ timeout: 2000 }).catch(() => false)) {
            await subtitle.click({ timeout: 3000 });
            this.log('[MODEL] Clicked "Image generation with camera controls" (subtitle)');
            optionClicked = true;
          }
        } catch (_) {}

        // Approach 2: Use Playwright getByText for exact "Cinematic Cameras" text
        // — filter to elements NOT in the bottom toolbar area.
        if (!optionClicked) {
          try {
            const options = page.getByText('Cinematic Cameras', { exact: true });
            const count = await options.count();
            this.log(`[MODEL] Found ${count} "Cinematic Cameras" text elements`);
            for (let i = 0; i < count; i++) {
              const box = await options.nth(i).boundingBox().catch(() => null);
              if (box && box.y < (await page.evaluate(() => window.innerHeight)) * 0.60) {
                await options.nth(i).click({ timeout: 3000 });
                this.log(`[MODEL] Clicked "Cinematic Cameras" option #${i} at y=${Math.round(box.y)}`);
                optionClicked = true;
                break;
              }
            }
          } catch (e) {
            this.log(`[MODEL] getByText approach failed: ${e.message.split('\n')[0]}`);
          }
        }

        // Approach 3: Find smallest element with "Cinematic Cameras" in dropdown zone
        if (!optionClicked) {
          const fallbackInfo = await page.evaluate(() => {
            let best = null;
            let bestArea = Infinity;
            const vh = window.innerHeight;
            for (const el of document.querySelectorAll('div, span, button, li, a, [role="option"]')) {
              const text = el.textContent?.trim() || '';
              const r = el.getBoundingClientRect();
              if (r.width < 30 || r.height < 15 || r.y > vh * 0.60) continue;
              if (text === 'Cinematic Cameras' || text.startsWith('Cinematic Cameras')) {
                const area = r.width * r.height;
                // Prefer the SMALLEST element (most specific / actual clickable row)
                if (area < bestArea && area > 500) {
                  best = { cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2), area: Math.round(area), text: text.slice(0, 50) };
                  bestArea = area;
                }
              }
            }
            return best;
          }).catch(() => null);

          if (fallbackInfo) {
            await page.mouse.click(fallbackInfo.cx, fallbackInfo.cy);
            this.log(`[MODEL] Cinematic Cameras fallback click at (${fallbackInfo.cx}, ${fallbackInfo.cy}), area=${fallbackInfo.area}: "${fallbackInfo.text}"`);
            optionClicked = true;
          }
        }

        if (optionClicked) {
          await page.waitForTimeout(2500); // Wait for model switch

          // ALWAYS dismiss the dropdown — it may still be open even after
          // clicking an option. If it stays open, subsequent typing goes into
          // the dropdown's search box instead of the prompt textbox.
          await this._dismissModelDropdown();

          // Verify: check for @ button (SVG, no text, w=20-60px in bottom toolbar)
          // + model button text. Background text only on empty projects.
          // Do NOT use + button — ambiguous with project creation + button.
          const postSwitch = await page.evaluate(() => {
            const vh = window.innerHeight;
            const btns = [...document.querySelectorAll('button')];
            let hasAtButton = false;
            let hasModelBtn = false;
            const pageText = document.body?.innerText || '';
            const hasBackgroundText = pageText.includes('CINEMA STUDIO 2.5') ||
                                      pageText.includes('What would you shoot');
            for (const b of btns) {
              const r = b.getBoundingClientRect();
              const text = b.textContent?.trim() || '';
              if (r.y > vh * 0.65 && r.width > 0) {
                if (!text && b.querySelector('svg') && r.width >= 20 && r.width <= 60) hasAtButton = true;
                if (text.includes('Cinematic Cameras')) hasModelBtn = true;
              }
            }
            return { hasBackgroundText, hasAtButton, hasModelBtn };
          }).catch(() => ({ hasBackgroundText: false, hasAtButton: false, hasModelBtn: false }));

          if (postSwitch.hasBackgroundText) {
            this.log('[MODEL] ✓ Cinematic Cameras confirmed (background text — empty project)');
            return;
          }
          if (postSwitch.hasAtButton) {
            this.log('[MODEL] ✓ Cinematic Cameras confirmed (@ button visible)');
            return;
          }
          this.log(`[MODEL] Post-switch: bg=${postSwitch.hasBackgroundText}, @btn=${postSwitch.hasAtButton}, modelBtn=${postSwitch.hasModelBtn} — retrying`);
        } else {
          this.log('[MODEL] Cinematic Cameras option not found in dropdown — closing');
          await this._dismissModelDropdown();
        }
      } catch (e) {
        this.log(`[MODEL] Error: ${e.message.split('\n')[0]}`);
      }
    }

    this.log('[MODEL] FAILED: Could not confirm Cinematic Cameras after 4 attempts');
    await this._dismissModelDropdown();
    throw new Error('Cinematic Cameras model switch failed after 4 attempts');
  }

  /**
   * Dismiss the model selector dropdown if it's still open.
   * Presses Escape, then clicks the prompt textbox to ensure focus
   * returns to the prompt area (not the dropdown search box).
   */
  async _dismissModelDropdown() {
    const page = this._ensurePageAlive();
    try {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
      // Click the prompt textbox to steal focus from the dropdown
      const clicked = await page.evaluate(() => {
        const tb = document.querySelector('[role="textbox"][contenteditable="true"]');
        if (tb) {
          tb.focus();
          return true;
        }
        return false;
      }).catch(() => false);
      if (clicked) {
        // Also do a real mouse click on the textbox for good measure
        const tbBox = await page.evaluate(() => {
          const tb = document.querySelector('[role="textbox"][contenteditable="true"]');
          if (!tb) return null;
          const r = tb.getBoundingClientRect();
          return { cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2) };
        }).catch(() => null);
        if (tbBox) {
          await page.mouse.click(tbBox.cx, tbBox.cy);
        }
      }
      await page.waitForTimeout(500);
      this.log('[MODEL] Dropdown dismissed, focus returned to textbox');
    } catch (_) {}
  }

  /**
   * Extract the Cinema Studio project id from the current page URL.
   */
  _extractProjectIdFromUrl(page) {
    try {
      const url = page.url();
      const parsed = new URL(url);
      return parsed.searchParams.get('projectId') ||
        parsed.searchParams.get('cinematic-project-id') ||
        null;
    } catch (_) {
      return null;
    }
  }

  _projectUrl(projectId = this._projectId) {
    return projectId
      ? `https://higgsfield.ai/generate?projectId=${projectId}`
      : 'https://higgsfield.ai/generate';
  }

  /**
   * Create/select a Cinema Studio project.
   *
   * Strategy (in order):
   *   1. If we already have a project ID from a previous create, navigate directly
   *   2. Search sidebar for a matching project name
   *   3. Create a new project and capture its UUID from the URL
   *   4. Rename via right-click → "Edit" context menu option
   */
  async ensureProject(projectName) {
    // If we already have a project ID (from a prior stage in the SAME pipeline run,
    // or from DB on resume), navigate directly to it. This is NOT reusing a stale
    // project — it's the same project the pipeline already created for this run.
    if (this._projectId) {
      const page = this._ensurePageAlive();
      if (!page.url().includes(this._projectId)) {
        this.log(`Navigating to pipeline's project ${this._projectId}...`);
        await page.goto(this._projectUrl(), { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2000);
      }
      this._projectCreated = true;
      this._projectName = projectName;
      return;
    }

    const page = this._ensurePageAlive();

    await this._ensureCinemaStudioActive();

    // ALWAYS create a new project — never reuse an existing one from the sidebar.
    // Each pipeline run gets its own dedicated project. This prevents element
    // collisions between runs and keeps assets cleanly separated.
    this.log('Creating new Cinema Studio project...');
    let created = false;

    // Strategy 1: click "New project" sidebar button
    try {
      const newProjBtn = await page.evaluate(() => {
        const btns = document.querySelectorAll('button');
        for (const b of btns) {
          if (b.textContent?.trim().startsWith('New project') && b.getBoundingClientRect().x < 80) {
            b.click();
            return true;
          }
        }
        return false;
      });
      if (newProjBtn) {
        created = true;
        this.log('Clicked "New project" sidebar button');
      }
    } catch (_) {}

    // Strategy 2: click "+" at sidebar bottom
    if (!created) {
      try {
        const plusBtn = await page.evaluate(() => {
          const btns = document.querySelectorAll('button');
          let best = null, bestY = 0;
          for (const b of btns) {
            const r = b.getBoundingClientRect();
            if (r.x < 80 && r.y > bestY && r.width > 0 && r.width < 60) {
              best = b;
              bestY = r.y;
            }
          }
          if (best) { best.click(); return true; }
          return false;
        });
        if (plusBtn) {
          created = true;
          this.log('Clicked sidebar "+" button');
        }
      } catch (_) {}
    }

    if (!created) {
      throw new Error('[PROJECT GATE] Could not create Cinema Studio project — both "New project" button and "+" button failed. Cannot proceed without a project.');
    }

    await page.waitForTimeout(1500);

    const createResult = await this._fillAndSubmitNewProjectDialog(projectName);
    if (!createResult.ok) {
      throw new Error(`[PROJECT GATE] New project dialog did not complete: ${createResult.reason}`);
    }

    // Capture the project ID from the URL — this is the authoritative handle
    this._projectId = createResult.projectId || this._extractProjectIdFromUrl(page);
    if (!this._projectId) {
      throw new Error('[PROJECT GATE] New project dialog completed but no projectId was available');
    }
    this.log(`New project created — ID: ${this._projectId}`);

    this.log(`Navigating to new project URL: ${this._projectUrl()}`);
    await page.goto(this._projectUrl(), { waitUntil: 'domcontentloaded', timeout: 30000 });
    await this._waitForCurrentProjectUrl(this._projectId, 20000);
    await page.waitForTimeout(2500);

    // Rename skipped — the project ID from the URL is the authoritative
    // handle. We navigate via projectId=<UUID> so the sidebar
    // display name doesn't matter. Rename was fragile (context menu → Edit
    // dialog → Save) and caused more issues than it solved.

    this._projectCreated = true;
    this._projectName = projectName;
  }

  async _fillAndSubmitNewProjectDialog(projectName) {
    const page = this._ensurePageAlive();
    const name = String(projectName || 'Untitled Project').trim() || 'Untitled Project';

    const dialogReady = await page.waitForFunction(() => {
      const body = document.body.innerText || '';
      return body.includes('New project') && body.includes('Create');
    }, { timeout: 10000 }).then(() => true).catch(() => false);
    if (!dialogReady) return { ok: false, reason: 'New project dialog did not appear' };

    const nameField = await page.evaluate(() => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
      };
      const candidates = [...document.querySelectorAll('input, textarea, [contenteditable="true"]')]
        .filter(visible)
        .sort((a, b) => a.getBoundingClientRect().y - b.getBoundingClientRect().y);
      const target = candidates[0];
      if (!target) return null;
      const r = target.getBoundingClientRect();
      return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
    }).catch(() => null);
    if (!nameField) return { ok: false, reason: 'Could not find writable project name field' };

    this.log('Typing Cinema Studio project name into New project dialog...');
    await page.mouse.click(nameField.cx, nameField.cy);
    await page.keyboard.press('Control+A').catch(() => {});
    await page.keyboard.type(name, { delay: 15 });
    await page.waitForTimeout(500);

    let typed = await page.evaluate((projectNameArg) => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
      };
      const candidates = [...document.querySelectorAll('input, textarea, [contenteditable="true"]')]
        .filter(visible);
      return candidates.some((el) => {
        const value = el.isContentEditable ? (el.textContent || '') : (el.value || '');
        return value.trim() === projectNameArg;
      });
    }, name).catch(() => false);

    if (!typed) {
      typed = await page.evaluate((projectNameArg) => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
      };
      const candidates = [...document.querySelectorAll('input, textarea, [contenteditable="true"]')]
        .filter(visible)
        .sort((a, b) => a.getBoundingClientRect().y - b.getBoundingClientRect().y);
      const target = candidates[0];
      if (!target) return false;
      target.focus();
      if (target.isContentEditable) {
        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, projectNameArg);
        target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: projectNameArg }));
      } else {
        target.value = projectNameArg;
        target.dispatchEvent(new Event('input', { bubbles: true }));
        target.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return true;
      }, name).catch(() => false);
      await page.waitForTimeout(500);
    }
    if (!typed) return { ok: false, reason: 'Could not find writable project name field' };

    this.log('Waiting for New project Create button to enable...');
    const createButton = await page.waitForFunction(() => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
      };
      const buttons = [...document.querySelectorAll('button')].filter(visible);
      const create = buttons
        .filter((b) => (b.textContent || '').trim() === 'Create')
        .sort((a, b) => b.getBoundingClientRect().y - a.getBoundingClientRect().y)[0];
      if (!create) return null;
      const r = create.getBoundingClientRect();
      const disabled = create.disabled ||
        create.getAttribute('aria-disabled') === 'true' ||
        getComputedStyle(create).pointerEvents === 'none' ||
        getComputedStyle(create).opacity < 0.6;
      if (disabled) return false;
      return { cx: r.x + r.width / 2, cy: r.y + r.height / 2, disabled: false };
    }, { timeout: 20000, polling: 250 }).then(handle => handle.jsonValue()).catch(() => null);
    if (!createButton) return { ok: false, reason: 'Create button not found or did not enable after naming project' };
    if (createButton.disabled) return { ok: false, reason: 'Create button stayed disabled after naming project' };

    this.log('Create button enabled; submitting new project...');
    await page.mouse.click(createButton.cx, createButton.cy);
    const projectId = await this._waitForProjectIdInUrl(30000);
    if (!projectId) return { ok: false, reason: `Create did not navigate to project URL; url=${page.url()}` };
    return { ok: true, projectId };
  }

  async _waitForProjectIdInUrl(timeoutMs = 30000) {
    const page = this._ensurePageAlive();
    const deadline = Date.now() + timeoutMs;
    let lastUrl = page.url();
    this.log('Waiting for new projectId in URL...');

    while (Date.now() < deadline) {
      lastUrl = page.url();
      const projectId = this._extractProjectIdFromUrl(page);
      if (projectId) {
        this.log(`Project URL ready with projectId=${projectId}`);
        return projectId;
      }
      await page.waitForTimeout(500);
    }

    this.log(`Timed out waiting for projectId in URL; last URL: ${lastUrl}`, 'warn');
    return null;
  }

  async _waitForCurrentProjectUrl(projectId, timeoutMs = 20000) {
    const page = this._ensurePageAlive();
    const deadline = Date.now() + timeoutMs;
    const expected = String(projectId || '');
    let lastUrl = page.url();

    while (Date.now() < deadline) {
      lastUrl = page.url();
      if (expected && lastUrl.includes(expected)) return true;
      await page.waitForTimeout(500);
    }

    throw new Error(`[PROJECT GATE] Did not settle on project URL for ${projectId}; last URL=${lastUrl}`);
  }

  /**
   * Find a project in the sidebar by matching button text.
   */
  async _findProjectInSidebar(projectName) {
    const page = this._ensurePageAlive();
    const normalized = projectName.toLowerCase().trim();

    try {
      const btns = await page.locator('button').all();
      for (const btn of btns) {
        const rect = await btn.boundingBox().catch(() => null);
        if (!rect || rect.x > 80 || rect.width === 0) continue;

        const text = (await btn.textContent().catch(() => '')).toLowerCase();
        if (text.includes(normalized) && !text.includes('new project') && !text.includes('my generations')) {
          this.log(`Found project "${projectName}" in sidebar`);
          return btn;
        }
      }
    } catch (e) {
      this.log(`Sidebar scan error: ${e.message.split('\n')[0]}`);
    }
    return null;
  }

  // ═══════════════════════════════════════════════════════════
  // OVERLAY DISMISSAL
  // ═══════════════════════════════════════════════════════════

  async _dismissOverlays() {
    const page = this.automation.page;
    if (!page) return;
    try {
      const underlays = await page.locator('[data-testid="underlay"]').all();
      for (const u of underlays) {
        const visible = await u.isVisible({ timeout: 300 }).catch(() => false);
        if (visible) {
          await u.click({ force: true, timeout: 1000 }).catch(() => {});
          this.log('Dismissed stale underlay');
        }
      }
    } catch (_) {}
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(150);
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(150);
  }

  // ═══════════════════════════════════════════════════════════
  // REFERENCE IMAGE ATTACHMENT (+ button)
  // ═══════════════════════════════════════════════════════════

  /**
   * Click the "+" button (left of textbox) → open picker → select location tile.
   */
  /**
   * Attach a location reference image by uploading the local file via the
   * picker's "Uploads" tab.
   *
   * Flow:
   *   1. Click the + button (reference picker) next to the prompt textbox
   *   2. Click "Uploads" tab in the picker popup
   *   3. Upload the local location image via Playwright fileChooser
   *   4. Wait for upload to finish (thumbnail appears in picker)
   *   5. Click the uploaded image tile to select it as reference
   *   6. Wait for the + button to transform into a thumbnail (reference loaded)
   *   7. HARD STOP if reference not confirmed — refuse to generate
   *
   * @param {string} locationImagePath - Absolute path to the location image on disk
   * @throws {Error} If reference image could not be attached and confirmed
   */

  // ═══════════════════════════════════════════════════════════
  // ELEMENT VERIFICATION VIA @ BUTTON
  // ═══════════════════════════════════════════════════════════

  /**
   * Click the @ button in the toolbar to verify that elements (characters/locations)
   * are loaded and accessible in the current project.
   *
   * The @ button ONLY exists in Image mode with Cinematic Cameras model.
   * Clicking it opens a dropdown showing available elements for @mention.
   *
   * This is a PRE-PROMPT verification step:
   *   1. Confirm @ button exists (proves Image + Cinematic Cameras mode)
   *   2. Click @ button → dropdown opens
   *   3. Read dropdown items → verify expected character names appear
   *   4. Dismiss dropdown (Escape)
   *   5. Return list of available element names
   *
   * @param {string[]} expectedNames - Character/element names we expect to find
   * @returns {{ available: string[], missing: string[] }}
   * @throws {Error} If @ button not found (wrong mode) or no elements at all
   */
  async _verifyElementsViaAtButton(expectedNames = []) {
    const page = this._ensurePageAlive();
    await this._dismissOverlays();

    // Scroll toolbar into view — on short viewports the textbox may be
    // partially below the visible area.
    await this._scrollToolbarIntoView();

    this.log(`[ELEMENT-CHECK] Verifying ${expectedNames.length} element(s) by typing @name in prompt...`);

    // ── CLEAR TEXTBOX ──
    // Ensure textbox is empty before we start typing test @mentions.
    await this._clearTextbox();

    // ── DISMISS ANY OPEN DROPDOWNS / POPUPS ──
    // Press Escape to close any open dropdown (e.g. resolution picker, model
    // selector) that could be stealing focus from the prompt textbox.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // ── FOCUS PROMPT TEXTAREA ──
    // Explicitly click the prompt textbox to ensure keyboard input goes there.
    // Without this, typing goes nowhere if focus landed on another element
    // (e.g. a resolution dropdown or overlay).
    const promptBox = page.locator('[role="textbox"][contenteditable="true"]').first();
    if (await promptBox.isVisible({ timeout: 2000 }).catch(() => false)) {
      await promptBox.click({ timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(300);
    } else {
      this.log('[ELEMENT-CHECK] Warning: prompt textbox not visible — typing may fail', 'warn');
    }

    // ── TYPE EACH @name AND CHECK IF IT RESOLVES (batched in groups of 3) ──
    // The prompt textbox can only hold ~3 resolved element chips before the
    // autocomplete stops triggering. Process in batches of 3, clearing the
    // textbox between batches.
    const BATCH_SIZE = 3;
    const available = [];
    const missing = [];

    for (let batchStart = 0; batchStart < expectedNames.length; batchStart += BATCH_SIZE) {
      const batch = expectedNames.slice(batchStart, batchStart + BATCH_SIZE);

      // Clear textbox at the start of each batch (first batch already cleared above)
      if (batchStart > 0) {
        await this._clearTextbox();
        await page.waitForTimeout(300);
      }

      for (const name of batch) {
        const cleanName = name.toLowerCase().replace(/^@+/, '');
        const fullAtName = '@' + cleanName;

        // Re-focus prompt textbox before each element — dropdowns, overlays,
        // or Enter presses can steal focus between iterations.
        await promptBox.click({ timeout: 2000 }).catch(() => {});
        await page.waitForTimeout(200);

        // Type full @name slowly to trigger Lexical autocomplete
        await page.keyboard.type(fullAtName, { delay: 80 });
        await page.waitForTimeout(2000); // wait for autocomplete dropdown

        // Check if autocomplete dropdown appeared with a matching entry
        const resolved = await page.evaluate((expectedName) => {
          const dropdowns = document.querySelectorAll(
            '[role="listbox"], [role="option"], [data-radix-popper-content-wrapper]'
          );
          if (dropdowns.length === 0) return false;
          const cleanExpected = expectedName.toLowerCase().replace(/^@+/, '');
          for (const d of dropdowns) {
            const text = d.textContent?.toLowerCase() || '';
            if (text.includes(cleanExpected)) return true;
          }
          return false;
        }, name).catch(() => false);

        if (resolved) {
          await page.keyboard.press('Enter');
          await page.waitForTimeout(400);
          available.push(name);
          this.log(`[ELEMENT-CHECK] ✓ @${cleanName} resolved`);
        } else {
          missing.push(name);
          this.log(`[ELEMENT-CHECK] ✗ @${cleanName} — no autocomplete dropdown`);
        }

        // Space between elements so chips don't merge
        await page.keyboard.type(' ', { delay: 50 });
        await page.waitForTimeout(300);
      }
    }

    // ── CLEAR TEXTBOX after verification ──
    await this._clearTextbox();

    this.log(`[ELEMENT-CHECK] Result: ${available.length} found, ${missing.length} missing`);
    if (available.length > 0) {
      this.log(`[ELEMENT-CHECK] ✓ Verified: ${available.join(', ')}`);
    }
    if (missing.length > 0) {
      this.log(`[ELEMENT-CHECK] Missing: ${missing.join(', ')}`);
    }

    return { available, missing, allItems: available };
  }

  /**
   * Clear the prompt textbox completely.
   * Uses multiple strategies: Ctrl+A → Backspace → execCommand delete.
   */
  async _clearTextbox() {
    const page = this._ensurePageAlive();

    for (let attempt = 0; attempt < 3; attempt++) {
      const text = await page.evaluate(() => {
        const tb = document.querySelector('[role="textbox"][contenteditable="true"]');
        return tb?.textContent?.trim() || '';
      }).catch(() => '');

      if (text.length === 0) return;

      // Focus textbox
      const tb = page.locator('[role="textbox"][contenteditable="true"]').first();
      if (await tb.isVisible({ timeout: 1000 }).catch(() => false)) {
        await tb.click({ timeout: 2000 }).catch(() => {});
        await page.waitForTimeout(200);
      }

      // Ctrl+A → Backspace
      await page.keyboard.press('Control+a');
      await page.waitForTimeout(150);
      await page.keyboard.press('Backspace');
      await page.waitForTimeout(200);

      // execCommand fallback
      await page.evaluate(() => {
        const tb = document.querySelector('[role="textbox"][contenteditable="true"]');
        if (tb) {
          tb.focus();
          const sel = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(tb);
          sel.removeAllRanges();
          sel.addRange(range);
          document.execCommand('delete', false);
        }
      }).catch(() => {});
      await page.waitForTimeout(200);
    }
  }

  /**
   * Clear any previously attached reference images from the prompt area.
   *
   * Higgsfield persists references at the project level server-side.
   * After inter-gen reset, navigating back to the project re-attaches the
   * previous scene's reference. This method removes all reference thumbnails
   * from the prompt area so the next scene gets a clean slate.
   *
   * Reference thumbnails appear as small images near the + button at the
   * bottom of the screen. Each has an X/close button overlay to remove it.
   */
  async _clearAttachedReferences() {
    const page = this._ensurePageAlive();
    await this._dismissOverlays();

    // Find and remove all reference thumbnails near the prompt area
    const removed = await page.evaluate(() => {
      const vh = window.innerHeight;
      let count = 0;

      // Reference thumbnails are small img elements in the bottom prompt area
      // Each has a close/X button (typically a sibling or parent button with an SVG)
      const promptArea = vh * 0.65; // Bottom 35% of viewport

      // Strategy: find small image containers in the prompt area that have
      // a close/remove button, and click the close button
      const allImgs = document.querySelectorAll('img');
      for (const img of allImgs) {
        const r = img.getBoundingClientRect();
        // Reference thumbnails: 30-80px, in the bottom prompt area
        if (r.width < 20 || r.width > 100 || r.height < 20 || r.height > 100) continue;
        if (r.y < promptArea) continue;

        // Walk up to find a close button (X, ×, SVG close icon)
        let container = img.parentElement;
        for (let i = 0; i < 4 && container; i++) {
          // Look for close buttons within this container
          const btns = container.querySelectorAll('button, [role="button"], div[class*="close"], div[class*="remove"]');
          for (const btn of btns) {
            const br = btn.getBoundingClientRect();
            // Close button is usually small and near the image
            if (br.width > 30 || br.height > 30) continue;
            if (br.width === 0 || br.height === 0) continue;
            // Must be near the image (within 60px)
            const dist = Math.sqrt(
              Math.pow((br.x + br.width / 2) - (r.x + r.width / 2), 2) +
              Math.pow((br.y + br.height / 2) - (r.y + r.height / 2), 2)
            );
            if (dist > 80) continue;

            // Check if it has an SVG (X icon) or close-like attributes
            const hasSvg = !!btn.querySelector('svg');
            const text = btn.textContent?.trim() || '';
            const label = (btn.getAttribute('aria-label') || '').toLowerCase();
            if (hasSvg || text === '×' || text === '✕' || text === 'X' ||
                label.includes('close') || label.includes('remove') || label.includes('delete')) {
              btn.click();
              count++;
              break;
            }
          }
          container = container.parentElement;
        }
      }

      // Fallback: try clicking any small X/close buttons in the prompt area
      // that might be overlaid on reference thumbnails
      if (count === 0) {
        const allBtns = document.querySelectorAll('button, [role="button"]');
        for (const btn of allBtns) {
          const r = btn.getBoundingClientRect();
          if (r.y < promptArea) continue;
          if (r.width > 25 || r.height > 25 || r.width === 0) continue;
          const hasSvg = !!btn.querySelector('svg');
          const label = (btn.getAttribute('aria-label') || '').toLowerCase();
          if (hasSvg || label.includes('close') || label.includes('remove')) {
            // Check if there's an img nearby (within 50px)
            const nearbyImg = [...allImgs].some(img => {
              const ir = img.getBoundingClientRect();
              return ir.y > promptArea && ir.width >= 20 && ir.width <= 100 &&
                Math.abs(ir.x - r.x) < 60 && Math.abs(ir.y - r.y) < 60;
            });
            if (nearbyImg) {
              btn.click();
              count++;
            }
          }
        }
      }

      return count;
    }).catch(() => 0);

    if (removed > 0) {
      this.log(`[REF-CLEAR] Removed ${removed} stale reference(s) from prompt area`);
      await page.waitForTimeout(1000);
    } else {
      this.log('[REF-CLEAR] No existing references found — clean slate');
    }
  }

  _normalizeElementOptionText(text) {
    return String(text || '').trim().toLowerCase().replace(/^@+/, '');
  }

  _optionMatchesElementName(optionText, cleanName) {
    const target = this._normalizeElementOptionText(cleanName);
    const normalized = this._normalizeElementOptionText(optionText);
    if (!target || !normalized) return false;
    if (normalized === target) return true;
    const tokens = normalized.split(/[^a-z0-9_-]+/).filter(Boolean);
    return tokens.includes(target);
  }

  _isStartFrameProofValid(uploadProof, refCheck) {
    return !!(
      uploadProof &&
      (uploadProof.finalizeOk || (uploadProof.batchOk && uploadProof.putOk)) &&
      refCheck &&
      refCheck.attached
    );
  }

  async _checkSceneReferenceAttached() {
    const page = this._ensurePageAlive();
    return page.evaluate(() => {
      const vh = window.innerHeight;
      const tb = document.querySelector('[role="textbox"][contenteditable="true"], [role="textbox"], textarea');
      if (!tb) return { attached: false, debug: 'no textbox' };
      const tbRect = tb.getBoundingClientRect();
      const validSrc = (src) =>
        /^https?:|^blob:|^data:image\//i.test(src || '') ||
        /images\.higgs\.ai|cloudfront\.net|cdn\.higgsfield|higgs/i.test(src || '');
      const imageInfo = (img, method) => {
        const r = img.getBoundingClientRect();
        return {
          attached: true,
          method,
          x: Math.round(r.x),
          y: Math.round(r.y),
          w: Math.round(r.width),
          h: Math.round(r.height),
          srcHint: String(img.currentSrc || img.src || '').slice(0, 120),
        };
      };

      const nearbyCandidates = [];
      const composerImgs = [...document.querySelectorAll('img')].filter(i => {
        const r = i.getBoundingClientRect();
        const src = i.currentSrc || i.src || '';
        const centerX = r.x + r.width / 2;
        const centerY = r.y + r.height / 2;
        const thumbnailSized = r.width >= 24 && r.width <= 180 && r.height >= 24 && r.height <= 180;
        const nearTextbox = centerX >= tbRect.x - 180 &&
          centerX <= tbRect.x + tbRect.width + 180 &&
          centerY >= tbRect.y - 260 &&
          centerY <= tbRect.y + tbRect.height + 140;
        const lowerComposer = centerY > vh * 0.35;
        if (validSrc(src) && thumbnailSized && nearTextbox && lowerComposer) return true;
        if (validSrc(src) && thumbnailSized && Math.abs(centerY - (tbRect.y + tbRect.height / 2)) < 360) {
          nearbyCandidates.push({
            x: Math.round(r.x),
            y: Math.round(r.y),
            w: Math.round(r.width),
            h: Math.round(r.height),
            centerX: Math.round(centerX),
            centerY: Math.round(centerY),
            srcHint: String(src).slice(0, 90),
          });
        }
        return false;
      });
      if (composerImgs.length > 0) return imageInfo(composerImgs[0], 'composer-thumbnail');

      for (const b of document.querySelectorAll('button')) {
        const r = b.getBoundingClientRect();
        const centerX = r.x + r.width / 2;
        const centerY = r.y + r.height / 2;
        if (
          r.width > 0 && r.width <= 80 && r.height <= 80 &&
          centerX >= tbRect.x - 180 && centerX <= tbRect.x + tbRect.width + 80 &&
          centerY >= tbRect.y - 260 && centerY <= tbRect.y + tbRect.height + 140
        ) {
          const img = b.querySelector('img');
          if (img && validSrc(img.currentSrc || img.src || '')) return imageInfo(img, 'plus-has-img');
        }
      }

      const nearImgs = [...document.querySelectorAll('img')].filter(i => {
        const r = i.getBoundingClientRect();
        const src = i.currentSrc || i.src || '';
        const centerX = r.x + r.width / 2;
        const centerY = r.y + r.height / 2;
        return validSrc(src) &&
               r.width > 24 && r.width <= 180 && r.height > 24 && r.height <= 180 &&
               centerX >= tbRect.x - 220 && centerX <= tbRect.x + tbRect.width + 220 &&
               centerY >= tbRect.y - 300 && centerY <= tbRect.y + tbRect.height + 180;
      });
      if (nearImgs.length > 0) return imageInfo(nearImgs[0], 'img-near-textbox');

      return {
        attached: false,
        debug: 'no reference thumbnail found in composer',
        textbox: {
          x: Math.round(tbRect.x),
          y: Math.round(tbRect.y),
          w: Math.round(tbRect.width),
          h: Math.round(tbRect.height),
        },
        candidates: nearbyCandidates.slice(0, 8),
      };
    }).catch(e => ({ attached: false, debug: e.message || 'error' }));
  }

  async _selectExactMentionOption(cleanName) {
    const page = this._ensurePageAlive();
    const match = await page.evaluate((target) => {
      const normalize = (text) => String(text || '').trim().toLowerCase().replace(/^@+/, '');
      const matches = (text) => {
        const wanted = normalize(target);
        const normalized = normalize(text);
        if (!wanted || !normalized) return false;
        if (normalized === wanted) return true;
        if (normalized.replace(/\s+/g, '') === wanted.replace(/\s+/g, '')) return true;
        return normalized.split(/[^a-z0-9_-]+/).filter(Boolean).includes(wanted);
      };
      const visible = [...document.querySelectorAll('[role="option"], [role="menuitem"]')]
        .filter(o => {
          const r = o.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        })
        .map((o, index) => {
          const r = o.getBoundingClientRect();
          return {
            index,
            text: (o.textContent || '').trim(),
            x: r.x + r.width / 2,
            y: r.y + r.height / 2,
          };
        });
      const exact = visible.find(o => matches(o.text));
      return {
        found: !!exact,
        option: exact || null,
        options: visible.slice(0, 8).map(o => o.text.slice(0, 80)),
      };
    }, cleanName).catch(e => ({ found: false, options: [], error: e.message }));

    if (!match.found || !match.option) {
      return match;
    }

    await page.mouse.click(match.option.x, match.option.y);
    await page.waitForTimeout(500);
    return match;
  }

  async _readMentionDropdownState(cleanName) {
    const page = this._ensurePageAlive();
    return page.evaluate((target) => {
      const normalize = (text) => String(text || '').trim().toLowerCase().replace(/^@+/, '');
      const wanted = normalize(target);
      const matches = (text) => {
        const normalized = normalize(text);
        if (!wanted || !normalized) return false;
        if (normalized === wanted) return true;
        if (normalized.replace(/\s+/g, '') === wanted.replace(/\s+/g, '')) return true;
        return normalized.split(/[^a-z0-9_-]+/).filter(Boolean).includes(wanted);
      };
      const visibleOptions = [...document.querySelectorAll('[role="option"], [role="menuitem"]')]
        .filter(o => {
          const r = o.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        })
        .map(o => (o.textContent || '').trim());
      const hasListbox = !!document.querySelector('[role="listbox"]');
      const hasMenu = !!document.querySelector('[role="menu"]');
      const hasRadixPop = !!document.querySelector('[data-radix-popper-content-wrapper]');
      return {
        hasListbox,
        hasMenu,
        hasRadixPop,
        hasDropdownShell: hasListbox || hasMenu || hasRadixPop,
        optionCount: visibleOptions.length,
        exactFound: visibleOptions.some(matches),
        firstOptionText: visibleOptions[0]?.slice(0, 50) || '',
        allOptions: visibleOptions.slice(0, 8).map(o => o.toLowerCase().slice(0, 80)),
      };
    }, cleanName).catch(e => ({
      hasListbox: false,
      hasMenu: false,
      hasRadixPop: false,
      hasDropdownShell: false,
      optionCount: 0,
      exactFound: false,
      firstOptionText: '',
      allOptions: [],
      error: e.message,
    }));
  }

  async _waitForMentionDropdownState(cleanName, { timeoutMs = 9000, pollMs = 500, label = 'mention' } = {}) {
    const started = Date.now();
    let lastState = null;
    let poll = 0;

    while (Date.now() - started <= timeoutMs) {
      poll++;
      lastState = await this._readMentionDropdownState(cleanName);
      this.log(`[PROMPT] @mention poll ${label} #${poll}: ${JSON.stringify(lastState)}`);
      if (lastState.exactFound || lastState.optionCount > 0) return lastState;
      await this._ensurePageAlive().waitForTimeout(pollMs);
    }

    return lastState || await this._readMentionDropdownState(cleanName);
  }

  async _inspectPromptMentionDom(expectedNames = [], context = 'prompt') {
    const page = this._ensurePageAlive();
    const names = [...new Set(expectedNames.map(n => this._normalizeElementOptionText(n)).filter(Boolean))];
    return page.evaluate((expected) => {
      const tb = document.querySelector('[role="textbox"][contenteditable="true"]');
      if (!tb) return { ok: false, context: 'no-textbox' };

      const normalize = (text) => String(text || '').trim().toLowerCase().replace(/^@+/, '');
      const compact = (text, max = 240) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);
      const attr = (el, name) => el?.getAttribute?.(name) || '';
      const rectOf = (el) => {
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
      };
      const pathOf = (node) => {
        const parts = [];
        let cur = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
        while (cur && cur !== tb && parts.length < 6) {
          parts.push({
            tag: cur.tagName?.toLowerCase?.() || '',
            role: attr(cur, 'role'),
            className: compact(cur.className, 90),
            contenteditable: attr(cur, 'contenteditable'),
            text: compact(cur.textContent, 80),
          });
          cur = cur.parentElement;
        }
        return parts;
      };
      const looksLikeChip = (node) => {
        let cur = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
        while (cur && cur !== tb) {
          const role = attr(cur, 'role').toLowerCase();
          const cls = String(cur.className || '').toLowerCase();
          const ce = attr(cur, 'contenteditable').toLowerCase();
          const aria = attr(cur, 'aria-label').toLowerCase();
          if (ce === 'false') return true;
          if (/button|link|option/.test(role)) return true;
          if (/mention|token|chip|pill|tag|element/.test(cls)) return true;
          if (/mention|element|character/.test(aria)) return true;
          cur = cur.parentElement;
        }
        return false;
      };

      const text = tb.textContent || '';
      const html = tb.innerHTML || '';
      const rawAtPattern = /@[a-z0-9][a-z0-9_-]*_[a-z0-9]+_\d{4}\b/gi;
      const textNodes = [];
      const walker = document.createTreeWalker(tb, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const value = node.nodeValue || '';
        const rawMatches = value.match(rawAtPattern) || [];
        const expectedMatches = expected.filter(name => normalize(value).includes(name));
        if (rawMatches.length || expectedMatches.length) {
          textNodes.push({
            text: compact(value),
            rawMatches,
            expectedMatches,
            chipLikeAncestor: looksLikeChip(node),
            path: pathOf(node),
          });
        }
      }

      const candidateElements = [];
      for (const el of tb.querySelectorAll('*')) {
        const elText = normalize(el.textContent || '');
        if (!expected.some(name => elText.includes(name))) continue;
        const childWithSame = [...el.children].some(ch => expected.some(name => normalize(ch.textContent || '').includes(name)));
        if (childWithSame) continue;
        candidateElements.push({
          tag: el.tagName.toLowerCase(),
          role: attr(el, 'role'),
          className: compact(el.className, 140),
          ariaLabel: compact(attr(el, 'aria-label'), 140),
          contenteditable: attr(el, 'contenteditable'),
          text: compact(el.textContent, 140),
          chipLike: looksLikeChip(el),
          rect: rectOf(el),
          html: compact(el.outerHTML, 300),
        });
      }

      const byName = {};
      for (const name of expected) {
        byName[name] = {
          rawTextNodes: textNodes.filter(n => n.rawMatches.some(m => normalize(m) === name) && !n.chipLikeAncestor).length,
          chipLikeTextNodes: textNodes.filter(n => n.expectedMatches.includes(name) && n.chipLikeAncestor).length,
          chipLikeElements: candidateElements.filter(e => normalize(e.text).includes(name) && e.chipLike).length,
          candidateElements: candidateElements.filter(e => normalize(e.text).includes(name)).slice(0, 5),
        };
      }

      return {
        ok: true,
        rawText: compact(text, 500),
        rawAtMatches: [...new Set(text.match(rawAtPattern) || [])],
        htmlSnippet: compact(html, 1000),
        textNodes: textNodes.slice(0, 12),
        byName,
      };
    }, names).then(result => ({ context, ...result })).catch(e => ({ context, ok: false, error: e.message }));
  }

  async _attachLocationReference(locationImagePath) {
    const page = this._ensurePageAlive();
    await this._dismissOverlays();

    // ─────────────────────────────────────────────────────────
    // UPLOAD FLOW (primary — guarantees correct image):
    // Upload the specific location image from local disk via
    // the picker's "Uploads" tab. This is the only way to
    // ensure we reference the RIGHT location (Image Generations
    // has hundreds of mixed images with no reliable way to
    // identify the correct one programmatically).
    //
    // Steps:
    //   1. Click + button → opens reference picker
    //   2. Click "Uploads" tab
    //   3. Click "Upload Images" → fileChooser → set local file
    //   4. Click the newly uploaded tile (first tile)
    //   5. Click textbox to dismiss picker
    //   6. Verify thumbnail on + button
    // ─────────────────────────────────────────────────────────
    await this._attachLocationReferenceViaUpload(locationImagePath);
  }

  /**
   * Upload a location image from local disk via the picker's "Uploads" tab.
   * This guarantees the correct image is attached (unlike Image Generations
   * which has hundreds of mixed images with no way to identify the right one).
   */
  async _attachLocationReferenceViaUpload(localPath) {
    const page = this._ensurePageAlive();
    const fs = require('fs');

    if (!localPath || !fs.existsSync(localPath)) {
      throw new Error(`HARD STOP: Upload failed — file not found: ${localPath}`);
    }

    // ══════════════════════════════════════════════════════════════════════
    const uploadProof = {
      batchOk: false,
      putOk: false,
      finalizeOk: false,
      responses: [],
    };
    const onUploadResponse = (response) => {
      try {
        const url = response.url();
        const status = response.status();
        const method = response.request()?.method?.() || '';
        const success = status >= 200 && status < 300;
        const isBatch = /\/media\/batch\b/i.test(url);
        const isFinalize = /\/media\/[^/]+\/upload\b/i.test(url);
        const isRemotePut = method === 'PUT' && /cloudfront|amazonaws|\/user_/i.test(url);
        if (!isBatch && !isFinalize && !isRemotePut) return;
        const entry = { method, status, kind: isBatch ? 'batch' : isFinalize ? 'finalize' : 'put' };
        uploadProof.responses.push(entry);
        if (!success) return;
        if (isBatch) uploadProof.batchOk = true;
        if (isRemotePut) uploadProof.putOk = true;
        if (isFinalize) uploadProof.finalizeOk = true;
        this.log(`[REF] Upload network proof: ${entry.kind} ${status}`);
      } catch (_) {}
    };
    page.on('response', onUploadResponse);
    const detachUploadListener = () => {
      try { page.off('response', onUploadResponse); } catch (_) {}
    };

    // REFERENCE IMAGE UPLOAD — + button click → Uploads tab → fileChooser
    //
    // The + button (reference picker) renders when Cinematic Cameras model
    // is properly selected.  We click it with page.mouse.click() for
    // isTrusted events (Radix UI requires this).
    //
    // DUAL TOOLBAR: Cinema Studio renders two overlapping toolbars (active
    // and inactive model). Both have identical + buttons at nearly the same
    // position. We identify the correct one by ancestor proximity to the
    // textbox, disable duplicates with pointer-events:none, then click.
    // ══════════════════════════════════════════════════════════════════════

    await this._scrollToolbarIntoView();

    // ── Step 1: Find the + button ─────────────────────────────────────
    this.log('[REF] Finding + button for reference picker...');

    const plusResult = await page.evaluate(() => {
      // Clean up any leftover state from previous attempts
      document.querySelectorAll('[data-cs-btn-hidden]').forEach(el => {
        el.style.removeProperty('pointer-events');
        el.removeAttribute('data-cs-btn-hidden');
      });

      const tb = document.querySelector('[role="textbox"][contenteditable="true"]');
      if (!tb) return { ok: false, reason: 'no textbox' };
      const tbRect = tb.getBoundingClientRect();
      const tbLeftEdge = tbRect.x + 15;

      // Find ALL small no-text SVG buttons to the left of the textbox
      // (the + button candidates from both toolbars)
      const allCandidates = [];
      for (const b of document.querySelectorAll('button')) {
        const r = b.getBoundingClientRect();
        if (r.width > 0 && r.width <= 60 && r.height <= 60 &&
            r.x <= tbLeftEdge && !b.textContent?.trim() && b.querySelector('svg') &&
            r.y > window.innerHeight * 0.40) {
          // Determine ancestor proximity to the textbox
          let depth = 0;
          let ancestor = b.parentElement;
          while (ancestor && depth < 15) {
            if (ancestor.contains(tb)) break;
            ancestor = ancestor.parentElement;
            depth++;
          }
          allCandidates.push({ btn: b, depth, r });
        }
      }

      if (allCandidates.length === 0) {
        return { ok: false, reason: 'no + button candidates found', tbX: Math.round(tbRect.x), tbY: Math.round(tbRect.y) };
      }

      // The correct button has the SMALLEST ancestor depth with the textbox
      allCandidates.sort((a, b) => a.depth - b.depth);
      const correct = allCandidates[0];

      // Disable pointer-events on ALL other candidates so they can't intercept
      const duplicatesDisabled = [];
      for (const c of allCandidates.slice(1)) {
        c.btn.style.setProperty('pointer-events', 'none', 'important');
        c.btn.setAttribute('data-cs-btn-hidden', 'true');
        duplicatesDisabled.push({ x: Math.round(c.r.x), y: Math.round(c.r.y), depth: c.depth });
      }

      const cx = correct.r.x + correct.r.width / 2;
      const cy = correct.r.y + correct.r.height / 2;
      return {
        ok: true,
        x: Math.round(cx),
        y: Math.round(cy),
        w: Math.round(correct.r.width),
        depth: correct.depth,
        totalCandidates: allCandidates.length,
        duplicatesDisabled,
      };
    }).catch(e => ({ ok: false, reason: `evaluate error: ${e.message}` }));

    this.log(`[REF] + button search: ${JSON.stringify(plusResult)}`);

    if (!plusResult.ok) {
      throw new Error(`HARD STOP: Could not find reference picker + button (${plusResult.reason})`);
    }

    // ── Step 2: Click + button with real mouse (isTrusted) ────────────
    await page.mouse.click(plusResult.x, plusResult.y);
    this.log(`[REF] + button clicked at (${plusResult.x}, ${plusResult.y}) via real mouse (${plusResult.duplicatesDisabled.length} duplicates disabled)`);
    await page.waitForTimeout(3000);

    // Restore pointer-events on disabled duplicates
    await page.evaluate(() => {
      document.querySelectorAll('[data-cs-btn-hidden]').forEach(el => {
        el.style.removeProperty('pointer-events');
        el.removeAttribute('data-cs-btn-hidden');
      });
    }).catch(() => {});

    // ── DIAGNOSTIC: What appeared after clicking + ? ──
    const postClickState = await page.evaluate(() => {
      const popovers = document.querySelectorAll(
        '[data-radix-popper-content-wrapper], [role="dialog"], [role="listbox"], ' +
        '[class*="popover" i], [class*="modal" i], [class*="picker" i], ' +
        '[class*="panel" i], [class*="dropdown" i], [class*="overlay" i]'
      );
      const popoverInfo = [...popovers].filter(p => p.getBoundingClientRect().width > 0).map(p => {
        const r = p.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), text: (p.textContent || '').slice(0, 80) };
      });
      const tabs = [...document.querySelectorAll('[role="tab"]')].filter(t => t.getBoundingClientRect().width > 0).map(t => ({
        text: (t.textContent || '').slice(0, 30), x: Math.round(t.getBoundingClientRect().x)
      }));
      return { popovers: popoverInfo.slice(0, 5), tabs: tabs.slice(0, 10) };
    }).catch(e => ({ error: e.message }));
    this.log(`[REF] After + click: ${JSON.stringify(postClickState)}`);

    // If no popup found after first click, retry once
    const hasPopup = (postClickState.popovers?.length || 0) > 0 || (postClickState.tabs?.length || 0) > 0;
    if (!hasPopup) {
      this.log('[REF] No popup detected — retrying + click...');
      await page.mouse.click(plusResult.x, plusResult.y);
      await page.waitForTimeout(3000);
    }

    // ── Step 3: Click "Uploads" tab ───────────────────────────────────
    let uploadsTabFound = false;
    for (const label of ['Uploads', 'Upload', 'uploads', 'UPLOADS']) {
      try {
        const tab = page.getByText(label, { exact: true }).first();
        if (await tab.isVisible({ timeout: 3000 }).catch(() => false)) {
          await tab.click({ timeout: 3000 });
          this.log(`[REF] Tab "${label}" clicked`);
          uploadsTabFound = true;
          break;
        }
      } catch (_) {}
    }
    if (!uploadsTabFound) {
      const tabClickResult = await page.evaluate(() => {
        for (const el of document.querySelectorAll('[role="tab"], button, div, span, a')) {
          const t = (el.textContent?.trim() || '').toLowerCase();
          const r = el.getBoundingClientRect();
          if (r.width > 0 && (t === 'uploads' || t === 'upload') && r.width < 200) {
            el.click();
            return { found: true, text: el.textContent?.trim(), x: Math.round(r.x), y: Math.round(r.y) };
          }
        }
        return { found: false };
      }).catch(() => ({ found: false }));
      this.log(`[REF] Uploads tab fallback: ${JSON.stringify(tabClickResult)}`);
    }
    await page.waitForTimeout(1500);

    const preUploadImageSrcs = await page.evaluate(() => {
      return [...document.querySelectorAll('img')]
        .map((img) => img.currentSrc || img.src || '')
        .filter(Boolean);
    }).catch(() => []);

    // ── Step 4: Upload via fileChooser ─────────────────────────────────
    try {
      const [fileChooser] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: 20000 }),
        (async () => {
          for (const label of ['Upload Images', '+ Upload Images', 'Upload Image', 'Upload images']) {
            try {
              const btn = page.getByText(label, { exact: true }).first();
              if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
                await btn.click({ timeout: 3000 });
                this.log(`[REF] Clicked "${label}"`);
                return;
              }
            } catch (_) {}
          }
          this.log('[REF] No Upload Images button found via getByText — trying evaluate fallback...');
          const evalResult = await page.evaluate(() => {
            for (const el of document.querySelectorAll('button, div, label, span, a, input[type="file"]')) {
              const t = (el.textContent?.trim() || '');
              const r = el.getBoundingClientRect();
              if (r.width > 0 && r.height > 0) {
                if (el.tagName === 'INPUT' && el.type === 'file') {
                  el.click();
                  return { clicked: 'file-input' };
                }
                if (t && /upload/i.test(t) && !/^uploads?$/i.test(t) && r.width < 300) {
                  el.click();
                  return { clicked: t.slice(0, 40) };
                }
              }
            }
            return { clicked: false };
          });
          this.log(`[REF] Upload evaluate fallback: ${JSON.stringify(evalResult)}`);
        })(),
      ]);
      await fileChooser.setFiles(localPath);
      this.log('[REF] File uploaded via fileChooser');
    } catch (e) {
      // ── DIAGNOSTIC: What's on screen when filechooser failed? ──
      const failState = await page.evaluate(() => {
        const allText = [];
        for (const el of document.querySelectorAll('button, [role="tab"], label, span, a, h1, h2, h3')) {
          const t = el.textContent?.trim();
          const r = el.getBoundingClientRect();
          if (t && r.width > 0 && r.height > 0 && t.length < 50) {
            allText.push({ text: t.slice(0, 40), tag: el.tagName, x: Math.round(r.x), y: Math.round(r.y) });
          }
        }
        const fileInputs = [...document.querySelectorAll('input[type="file"]')].map(i => ({
          name: i.name, accept: i.accept, visible: i.getBoundingClientRect().width > 0,
        }));
        return { visibleElements: allText.slice(0, 20), fileInputs };
      }).catch(() => ({ error: 'evaluate failed' }));
      this.log(`[REF] Upload FAILED — page state: ${JSON.stringify(failState)}`);

      const fallbackResult = await this._uploadReferenceViaHiddenImageInput(localPath).catch((fallbackError) => ({
        ok: false,
        reason: fallbackError.message,
      }));
      if (!fallbackResult.ok) {
        await page.keyboard.press('Escape').catch(() => {});
        detachUploadListener();
        throw new Error(`HARD STOP: Upload failed — ${e.message.split('\n')[0]}; hidden input fallback: ${fallbackResult.reason}`);
      }
      this.log(`[REF] Hidden file input fallback accepted file: ${JSON.stringify(fallbackResult)}`);
    }

    // ── Step 5: Wait for upload to process ────────────────────────────
    this.log('[REF] Waiting for upload to process (hard gate — backend proof required)...');
    let uploadReady = false;
    const uploadStart = Date.now();
    const uploadMaxWaitMs = 240000;
    let lastStatusLog = '';
    let lastProgressLogAt = 0;
    while (Date.now() - uploadStart < uploadMaxWaitMs) {
      const status = await page.evaluate(() => {
        const hasSpinner = [...document.querySelectorAll('*')].some(el => {
          const t = el.textContent?.trim();
          return t === 'Uploading...' || t === 'Uploading';
        });
        if (hasSpinner) return 'uploading';
        const imgs = [...document.querySelectorAll('img')].filter(i => {
          const r = i.getBoundingClientRect();
          return r.width >= 60 && r.height >= 60 && r.y > 50 && r.y < window.innerHeight * 0.80;
        });
        return imgs.length > 0 ? 'ready' : 'waiting';
      }).catch(() => 'error');

      const backendReady = uploadProof.finalizeOk || (uploadProof.batchOk && uploadProof.putOk);
      if (status === 'ready' && backendReady) {
        uploadReady = true;
        this.log(`[REF] Upload processed — backend confirmed (${uploadProof.responses.map(r => `${r.kind}:${r.status}`).join(', ')})`);
        break;
      }
      const proofSummary = `batch=${uploadProof.batchOk}, put=${uploadProof.putOk}, finalize=${uploadProof.finalizeOk}`;
      const logLine = `${status} (${proofSummary})`;
      if (logLine !== lastStatusLog || Date.now() - lastProgressLogAt > 30000) {
        this.log(`[REF] Upload status: ${logLine}...`);
        lastStatusLog = logLine;
        lastProgressLogAt = Date.now();
      }
      await page.waitForTimeout(2000);
    }

    if (!uploadReady) {
      detachUploadListener();
      throw new Error(`START_FRAME_UPLOAD_NOT_SETTLED: reference upload did not finish within ${Math.round(uploadMaxWaitMs / 1000)}s (proof: ${JSON.stringify(uploadProof.responses.slice(-8))})`);
    }

    // Extra settle time for auto-selection
    await page.waitForTimeout(2000);

    // ── Step 6: Dismiss picker ────────────────────────────────────────
    const selectedUploadedTile = await this._selectNewlyUploadedReferenceTile(preUploadImageSrcs);
    if (!selectedUploadedTile.ok) {
      detachUploadListener();
      throw new Error(`START_FRAME_UPLOAD_NOT_SELECTABLE: ${selectedUploadedTile.reason}`);
    }
    this.log(`[REF] Selected uploaded reference tile: ${JSON.stringify(selectedUploadedTile)}`);

    const tbClicked = await page.evaluate(() => {
      const tb = document.querySelector('[role="textbox"]');
      if (tb) { tb.click(); return true; }
      return false;
    }).catch(() => false);
    if (tbClicked) {
      this.log('[REF] Textbox clicked — picker dismissing');
    } else {
      await page.keyboard.press('Escape').catch(() => {});
      this.log('[REF] Escape pressed to close picker');
    }
    await page.waitForTimeout(2000);

    // ── Step 7: Verify attached composer thumbnail ────────────────────
    let finalRefCheck = { attached: false, debug: 'not checked' };
    const verifyStart = Date.now();
    while (Date.now() - verifyStart < 10000) {
      finalRefCheck = await this._checkSceneReferenceAttached();
      if (finalRefCheck.attached) break;
      await page.waitForTimeout(500);
    }

    if (!finalRefCheck.attached) {
      detachUploadListener();
      throw new Error(`HARD STOP: Upload - reference thumbnail not confirmed after dismiss (${JSON.stringify(finalRefCheck)})`);
    }
    const proofOk = this._isStartFrameProofValid(uploadProof, finalRefCheck);
    detachUploadListener();
    if (!proofOk) {
      throw new Error(`START_FRAME_UPLOAD_UNCONFIRMED: thumbnail=${JSON.stringify(finalRefCheck)}, proof=${JSON.stringify(uploadProof.responses.slice(-8))}`);
    }
    this._lastSceneReferenceProof = { ...uploadProof, attached: true, attachedMethod: finalRefCheck.method, attachedDebug: finalRefCheck };
    this.log('[REF] ✓ Reference image attached via + button upload and backend-confirmed');
  }

  // ═══════════════════════════════════════════════════════════
  // ASPECT RATIO
  // ═══════════════════════════════════════════════════════════
  async _uploadReferenceViaHiddenImageInput(localPath) {
    const page = this._ensurePageAlive();
    const inputs = page.locator('input[type="file"]');
    const count = await inputs.count().catch(() => 0);
    const attempts = [];

    for (let i = count - 1; i >= 0; i--) {
      const input = inputs.nth(i);
      const accept = await input.getAttribute('accept').catch(() => '');
      const isImageInput = !accept ||
        /image/i.test(accept) ||
        /\.(jpg|jpeg|png|webp|heic|heif)/i.test(accept) ||
        /image\/(jpeg|jpg|png|webp|heic|heif)/i.test(accept);
      attempts.push({ index: i, accept: accept || '', image: isImageInput });
      if (!isImageInput) continue;

      await input.setInputFiles(localPath);
      await page.waitForTimeout(2000);
      return { ok: true, index: i, accept: accept || '', attempts };
    }

    return { ok: false, reason: `no image file input found (${JSON.stringify(attempts)})`, attempts };
  }

  async _selectNewlyUploadedReferenceTile(preUploadImageSrcs = []) {
    const page = this._ensurePageAlive();
    const before = new Set(preUploadImageSrcs || []);

    const tile = await page.evaluate((beforeList) => {
      const beforeSrcs = new Set(beforeList || []);
      const images = [...document.querySelectorAll('img')]
        .map((img) => {
          const r = img.getBoundingClientRect();
          const src = img.currentSrc || img.src || '';
          return {
            src,
            cx: r.x + r.width / 2,
            cy: r.y + r.height / 2,
            x: r.x,
            y: r.y,
            w: r.width,
            h: r.height,
            isNew: !!src && !beforeSrcs.has(src),
          };
        })
        .filter((img) =>
          img.isNew &&
          img.w >= 60 &&
          img.h >= 60 &&
          img.x > 300 &&
          img.y > 50 &&
          img.y < window.innerHeight * 0.85
        )
        .sort((a, b) => a.y - b.y || a.x - b.x);

      const chosen = images[0];
      if (!chosen) return { ok: false, reason: 'no new uploaded image tile found' };
      return {
        ok: true,
        cx: Math.round(chosen.cx),
        cy: Math.round(chosen.cy),
        x: Math.round(chosen.x),
        y: Math.round(chosen.y),
        w: Math.round(chosen.w),
        h: Math.round(chosen.h),
        srcHint: chosen.src.slice(0, 120),
      };
    }, [...before]).catch((e) => ({ ok: false, reason: e.message }));

    if (!tile.ok) return tile;

    await page.mouse.click(tile.cx, tile.cy);
    await page.waitForTimeout(1500);

    const selected = await page.evaluate(() => {
      const body = document.body.innerText || '';
      return body.includes('Added to prompt box') || body.includes('Added');
    }).catch(() => false);

    return { ...tile, selected };
  }

  async _setAspectRatio(targetAspect) {
    const page = this._ensurePageAlive();
    await this._dismissOverlays();

    let aspectClickResult = null;
    try {
      aspectClickResult = await page.evaluate(() => {
        const vh = window.innerHeight;
        const toolbarZone = vh * 0.65;
        const btns = [...document.querySelectorAll('button')];
        const aspectPattern = /^(9:16|16:9|1:1|3:4|2:3|4:3|21:9|3:2)$/;
        const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const panelFor = (el) => {
          for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
            const r = n.getBoundingClientRect();
            const text = norm(n.innerText || n.textContent || '');
            if (r.x >= 550 && r.y > window.innerHeight * 0.55 && r.width >= 450 && r.height >= 60 &&
                text.includes('Cinematic Cameras') &&
                !text.includes('Nano Banana') &&
                !text.includes('Cinema Studio 3.5') &&
                !text.includes('1080p') &&
                !text.includes('720p') &&
                !/\b(8s|15s)\b/.test(text)) {
              return { x: r.x, y: r.y, w: r.width, h: r.height, text };
            }
          }
          return null;
        };

        const panelCandidates = btns
          .map((b) => {
            const r = b.getBoundingClientRect();
            return {
              el: b,
              panel: panelFor(b),
              x: r.x,
              y: r.y,
              text: b.textContent?.trim() || '',
            };
          })
          .filter((item) => item.panel && aspectPattern.test(item.text))
          .sort((a, b) => a.x - b.x);
        if (panelCandidates.length > 0) {
          const target = panelCandidates[0];
          target.el.click();
          return {
            clicked: true,
            method: 'active-cinematic-panel',
            controllingY: target.y,
            btnY: target.y,
            btnText: target.text,
            panel: target.panel,
          };
        }

        // ── DUAL TOOLBAR FIX: find controlling set by leftmost model button's Y ──
        const modelNames = ['Cinematic Cameras', 'Soul Cinema', 'Nano Banana', 'Cinema Studio', 'Higgsfield Soul'];
        const modelBtns = [];
        let controllingY = -1;
        let controllingModelRight = -1;
        let controllingRowRight = Infinity;
        for (const b of btns) {
          const r = b.getBoundingClientRect();
          const text = b.textContent?.trim() || '';
          if (r.y > toolbarZone && r.width > 0 && modelNames.some(n => text.includes(n))) {
            modelBtns.push({ x: r.x, y: r.y, w: r.width, text });
          }
        }
        if (modelBtns.length > 0) {
          const cinematicBtns = modelBtns.filter(b => b.text.includes('Cinematic Cameras'));
          const controlling = (cinematicBtns.length > 0 ? cinematicBtns : modelBtns)
            .reduce((a, b) => a.x < b.x ? a : b);
          controllingY = controlling.y;
          controllingModelRight = controlling.x + controlling.w;
          const sameYNextModel = modelBtns
            .filter(b => b.x > controlling.x && Math.abs(b.y - controllingY) < 3)
            .sort((a, b) => a.x - b.x)[0];
          controllingRowRight = sameYNextModel ? sameYNextModel.x - 2 : Infinity;
        }

        // Find aspect button from controlling set (same Y ±3px)
        for (const b of btns) {
          const r = b.getBoundingClientRect();
          const text = b.textContent?.trim();
          if (r.y > toolbarZone && r.width > 0 && aspectPattern.test(text)) {
            if ((controllingY < 0 || Math.abs(r.y - controllingY) < 3) &&
                (controllingModelRight < 0 || r.x >= controllingModelRight - 2) &&
                r.x < controllingRowRight) {
              b.click();
              return { clicked: true, controllingY, btnY: r.y, btnText: text, rowRight: controllingRowRight };
            }
          }
        }
        return { clicked: false, controllingY };
      });
    } catch (_) {}

    if (!aspectClickResult || !aspectClickResult.clicked) {
      this.log(`Warn: couldn't find aspect-ratio button — proceeding with current setting`);
      return;
    }
    const toolbarBandY = aspectClickResult.controllingY;
    this.log(`Aspect-ratio button clicked (current setting) — toolbar band Y=${toolbarBandY}`);
    await page.waitForTimeout(800);

    // ── Debug: dump dropdown options so we know what labels Higgsfield uses ──
    const dropdownOptions = await page.evaluate(() => {
      // Look for dropdown/popover/listbox that appeared after clicking the aspect button
      const candidates = document.querySelectorAll('[role="listbox"], [role="option"], [data-radix-popper-content-wrapper], [class*="dropdown"], [class*="popover"], [class*="menu"]');
      const options = [];
      for (const container of candidates) {
        const items = container.querySelectorAll('[role="option"], li, button, div');
        for (const item of items) {
          const r = item.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            const text = item.textContent?.trim();
            if (text && text.length < 30) options.push(text);
          }
        }
      }
      // Also scan for any visible elements containing aspect ratio patterns
      const allEls = document.querySelectorAll('div, span, button, li');
      for (const el of allEls) {
        const r = el.getBoundingClientRect();
        if (r.width === 0) continue;
        const text = el.textContent?.trim();
        if (text && /^\d+:\d+/.test(text) && text.length < 20 && r.y > window.innerHeight * 0.3) {
          if (!options.includes(text)) options.push(text);
        }
      }
      return [...new Set(options)].slice(0, 20);
    }).catch(() => []);
    this.log(`[ASPECT] Dropdown options visible: ${JSON.stringify(dropdownOptions)}`);

    const optionVariants = targetAspect === '9:16'
      ? ['9:16', '9:16 Vertical', 'Vertical 9:16', '9:16 Portrait']
      : ['16:9 Cinematic', '16:9', '16:9 Horizontal', 'Cinematic 16:9'];

    // Try to click a dropdown option by exact text — but EXCLUDE toolbar-band
    // elements (±15px of controllingY) to avoid clicking duplicate toolbar buttons
    let optionClicked = false;
    const primaryClick = await page.evaluate(({ variants, bandY }) => {
      const els = document.querySelectorAll('div, span, button, li, [role="option"]');
      for (const variant of variants) {
        for (const el of els) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          const text = el.textContent?.trim();
          if (text !== variant) continue;
          // Skip toolbar-band elements
          if (bandY > 0 && Math.abs(r.y - bandY) < 15) continue;
          if (r.height < 80 && r.y > window.innerHeight * 0.3) {
            el.click();
            return { clicked: true, text, x: Math.round(r.x), y: Math.round(r.y) };
          }
        }
      }
      return { clicked: false };
    }, { variants: optionVariants, bandY: toolbarBandY }).catch(() => ({ clicked: false }));

    if (primaryClick.clicked) {
      this.log(`Aspect option "${primaryClick.text}" selected at (${primaryClick.x}, ${primaryClick.y})`);
      optionClicked = true;
    }

    // Fallback: click via evaluate — find any visible element whose text contains
    // the target aspect ratio string (handles varied label formats)
    // CRITICAL: exclude toolbar-band elements (±10px of controllingY) — those are
    // duplicate-toolbar buttons, NOT dropdown options.
    if (!optionClicked) {
      const targetRatio = targetAspect; // e.g. "9:16"
      const fallbackClicked = await page.evaluate(({ target, bandY }) => {
        const els = document.querySelectorAll('div, span, button, li, [role="option"]');
        for (const el of els) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          const text = el.textContent?.trim();
          if (!text) continue;
          // Skip elements in the toolbar band (these are toolbar buttons, not dropdown options)
          if (bandY > 0 && Math.abs(r.y - bandY) < 15) continue;
          // Match elements that START with the target ratio (e.g. "9:16" or "9:16 Vertical")
          if (text.startsWith(target) || text === target) {
            if (r.height < 80 && r.y > window.innerHeight * 0.3) {
              el.click();
              return { clicked: true, text, x: Math.round(r.x), y: Math.round(r.y) };
            }
          }
        }
        return { clicked: false };
      }, { target: targetRatio, bandY: toolbarBandY }).catch(() => ({ clicked: false }));

      if (fallbackClicked.clicked) {
        this.log(`[ASPECT] Fallback clicked: "${fallbackClicked.text}" at (${fallbackClicked.x}, ${fallbackClicked.y})`);
        optionClicked = true;
      }
    }

    if (!optionClicked) {
      this.log(`Warn: couldn't select aspect option for "${targetAspect}" — dropdown had: ${JSON.stringify(dropdownOptions)}`);
      await page.keyboard.press('Escape').catch(() => {});
    }
    await page.waitForTimeout(400);
  }

  // ═══════════════════════════════════════════════════════════
  // PROMPT COMPOSITION
  // ═══════════════════════════════════════════════════════════

  /**
   * Type text into the Cinema Studio prompt textbox.
   *
   * KEY FINDING (April 2026 live testing):
   *   The prompt textbox is a **Lexical editor** — a contenteditable <div>
   *   with role="textbox". Playwright's keyboard.type() and fill() do NOT
   *   reliably insert text. The ONLY working approach is:
   *
   *     1. Click the textbox to focus it
   *     2. Use document.execCommand('insertText', false, text) to insert text
   *        This creates proper Lexical <p><span data-lexical-text="true"> nodes
   *
   *   DO NOT use React fiber tricks (walking __reactFiber$ tree) — this crashes
   *   the page with a cross-origin SecurityError from Higgsfield's iframe setup.
   *
   *   For @mentions, we still use keyboard.type('@prefix') because the Lexical
   *   editor needs real keystroke events to trigger the autocomplete dropdown.
   */
  async _typeBlockingPrompt(segments) {
    const page = this._ensurePageAlive();
    await this._dismissOverlays();

    // Scroll toolbar into view before typing — on short viewports
    // the textbox may be below the visible area.
    await this._scrollToolbarIntoView();

    let textbox = null;

    // Primary: getByRole('textbox') filtered by bottom area (bottom 35% of viewport)
    const viewportHeight = await page.evaluate(() => window.innerHeight).catch(() => 850);
    const bottomThreshold = viewportHeight * 0.65;
    try {
      const candidates = await page.getByRole('textbox').all();
      for (const c of candidates) {
        const box = await c.boundingBox().catch(() => null);
        if (box && box.y > bottomThreshold) {
          textbox = c;
          this.log('Prompt textbox located via getByRole("textbox") at y=' + Math.round(box.y));
          break;
        }
      }
    } catch (_) {}

    // Fallback: direct CSS selector
    if (!textbox) {
      try {
        textbox = page.locator('[role="textbox"][contenteditable="true"]').first();
        const visible = await textbox.isVisible({ timeout: 1000 }).catch(() => false);
        if (!visible) textbox = null;
        else this.log('Prompt textbox located via CSS selector');
      } catch (_) {}
    }

    if (!textbox) {
      throw new Error('Couldn\'t locate Cinema Studio prompt textbox');
    }

    // Focus the textbox
    await textbox.click({ timeout: 5000 });
    await page.waitForTimeout(500);

    // ── CLEAR existing content ──
    // The Lexical editor ignores direct DOM manipulation (innerHTML = '').
    // Must use keyboard shortcuts and execCommand to trigger Lexical's internal state update.
    //
    // Strategy: Ctrl+A (select all) → Backspace → verify empty → repeat if needed.
    // This is more reliable than Range/Selection API because it goes through
    // the browser's input event pipeline which Lexical listens to.
    this.log('[PROMPT] Clearing existing prompt text...');
    for (let clearAttempt = 0; clearAttempt < 3; clearAttempt++) {
      // Select all via Ctrl+A
      await page.keyboard.press('Control+a');
      await page.waitForTimeout(200);
      // Delete selected content
      await page.keyboard.press('Backspace');
      await page.waitForTimeout(300);

      // Also try execCommand as fallback
      await page.evaluate(() => {
        const tb = document.querySelector('[role="textbox"][contenteditable="true"]');
        if (tb) {
          tb.focus();
          const selection = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(tb);
          selection.removeAllRanges();
          selection.addRange(range);
          document.execCommand('delete', false);
        }
      });
      await page.waitForTimeout(300);

      // Verify the textbox is empty
      const remaining = await page.evaluate(() => {
        const tb = document.querySelector('[role="textbox"][contenteditable="true"]');
        return tb?.textContent?.trim() || '';
      }).catch(() => '');

      if (remaining.length === 0) {
        this.log(`[PROMPT] ✓ Prompt cleared (attempt ${clearAttempt + 1})`);
        break;
      }
      this.log(`[PROMPT] Still has text after clear attempt ${clearAttempt + 1}: "${remaining.slice(0, 40)}..." — retrying`);
    }
    await page.waitForTimeout(300);

    for (const seg of segments) {
      if (typeof seg === 'string') {
        // Use execCommand('insertText') for plain text — this is the ONLY
        // reliable way to insert text into the Lexical editor
        const inserted = await page.evaluate((text) => {
          const tb = document.querySelector('[role="textbox"][contenteditable="true"]');
          if (!tb) return false;
          tb.focus();
          return document.execCommand('insertText', false, text);
        }, seg);
        if (!inserted) {
          this.log(`Warn: execCommand('insertText') returned false for "${seg.slice(0, 30)}..."`);
          // Fallback: try keyboard.type() (may not work but worth trying)
          await page.keyboard.type(seg);
        }
      } else if (seg && seg.at) {
        // For @mentions, we MUST use keyboard events to trigger the Lexical
        // autocomplete dropdown. execCommand won't trigger the @ listener.
        //
        // SLOW TYPING IS CRITICAL: Cinema Studio's autocomplete needs time
        // to process each keystroke, query the element database, and render
        // the dropdown. Typing too fast causes elements to not resolve.
        const cleanName = seg.at.toLowerCase().replace(/^@+/, '');

        this.log(`[PROMPT] Typing @mention: "@${cleanName}"`);

        // Type '@' first, then pause to let autocomplete listener activate
        await page.keyboard.type('@', { delay: 0 });
        await page.waitForTimeout(800); // let the @ trigger the autocomplete system

        // Type the FULL element name SLOWLY — 120ms per character gives
        // the autocomplete time to search and filter after each keystroke.
        // We type the full name (not a short prefix) to avoid cross-project
        // element collisions where names share a prefix (e.g. adanna vs adaora).
        await page.keyboard.type(cleanName, { delay: 120 });
        await page.waitForTimeout(3500); // wait for autocomplete dropdown to populate

        // Check if an autocomplete dropdown appeared with options
        let dropdownState = await page.evaluate(() => {
          const listbox = document.querySelector('[role="listbox"]');
          const options = document.querySelectorAll('[role="option"]');
          const radixPop = document.querySelector('[data-radix-popper-content-wrapper]');
          // Count visible options
          const visibleOptions = [...(options || [])].filter(o => o.getBoundingClientRect().width > 0);
          return {
            hasListbox: !!listbox,
            hasRadixPop: !!radixPop,
            optionCount: visibleOptions.length,
            firstOptionText: visibleOptions[0]?.textContent?.trim()?.slice(0, 50) || '',
            allOptions: visibleOptions.slice(0, 5).map(o => (o.textContent || '').trim().toLowerCase().slice(0, 50)),
          };
        }).catch(() => ({ hasListbox: false, hasRadixPop: false, optionCount: 0, allOptions: [] }));

        this.log(`[PROMPT] @mention dropdown: ${JSON.stringify(dropdownState)}`);

        if (dropdownState.optionCount === 0) {
          dropdownState = await this._waitForMentionDropdownState(cleanName, {
            timeoutMs: dropdownState.hasListbox || dropdownState.hasRadixPop ? 9000 : 5000,
            pollMs: 500,
            label: dropdownState.hasListbox || dropdownState.hasRadixPop ? 'empty-shell' : 'no-shell',
          });
          this.log(`[PROMPT] @mention dropdown after poll: ${JSON.stringify(dropdownState)}`);
        }

        if (dropdownState.optionCount > 0) {
          const exactSelection = await this._selectExactMentionOption(cleanName);
          if (!exactSelection.found) {
            throw new Error(`[PRE-GEN] HARD GATE: Exact @mention option not found for @${cleanName}. Options: ${JSON.stringify(exactSelection.options || dropdownState.allOptions || [])}`);
          }
          this.log(`[PROMPT] @mention resolved exactly: @${cleanName} → "${exactSelection.option.text}"`);
        } else {
          // Retry: backspace everything, try with extra wait
          this.log(`[PROMPT] No dropdown for "@${cleanName}" — retrying with longer wait`);
          const typed = '@' + cleanName;
          for (let i = 0; i < typed.length; i++) await page.keyboard.press('Backspace');
          await page.waitForTimeout(800);

          await page.keyboard.type('@', { delay: 0 });
          await page.waitForTimeout(800);
          await page.keyboard.type(cleanName, { delay: 180 }); // even slower
          await page.waitForTimeout(4000); // longer wait

          const retryDropdown = await this._waitForMentionDropdownState(cleanName, {
            timeoutMs: 12000,
            pollMs: 500,
            label: 'retry',
          });

          if (retryDropdown.optionCount > 0) {
            const retryExactSelection = await this._selectExactMentionOption(cleanName);
            if (!retryExactSelection.found) {
              throw new Error(`[PRE-GEN] HARD GATE: Exact @mention option not found on retry for @${cleanName}. Options: ${JSON.stringify(retryExactSelection.options || retryDropdown.allOptions || [])}`);
            }
            this.log(`[PROMPT] @mention resolved exactly on retry: @${cleanName} → "${retryExactSelection.option.text}"`);
          } else {
            throw new Error(`[PRE-GEN] HARD GATE: @mention unresolved for @${cleanName} — refusing to insert plain text`);
          }
        }
        await page.waitForTimeout(1000); // post-selection settle — let Lexical update its state
        const mentionDom = await this._inspectPromptMentionDom([cleanName], `after @${cleanName}`);
        this.log(`[PROMPT-DOM] ${JSON.stringify(mentionDom).slice(0, 3000)}`);
      }
    }

    const expectedMentions = [...new Set(segments
      .filter(seg => seg && typeof seg === 'object' && seg.at)
      .map(seg => seg.at.toLowerCase().replace(/^@+/, '')))];
    const finalMentionDom = await this._inspectPromptMentionDom(expectedMentions, 'final prompt');
    this.log(`[PROMPT-DOM] ${JSON.stringify(finalMentionDom).slice(0, 5000)}`);

    // Verify text was inserted
    const promptText = await page.evaluate(() => {
      const tb = document.querySelector('[role="textbox"][contenteditable="true"]');
      return tb?.textContent?.trim() || '';
    }).catch(() => '');
    this.log(`Prompt text (${promptText.length} chars): "${promptText.slice(0, 80)}${promptText.length > 80 ? '...' : ''}"`);
    const unresolvedRawMentions = expectedMentions.filter(name =>
      (finalMentionDom.byName?.[name]?.rawTextNodes || 0) > 0
    );
    if (unresolvedRawMentions.length > 0) {
      throw new Error(`[PRE-GEN] HARD GATE: Raw unresolved @element mention(s) remain in plain text nodes: ${unresolvedRawMentions.map(n => '@' + n).join(', ')}. No credits burned.`);
    }
    const missingMentionChips = expectedMentions.filter(name => {
      const info = finalMentionDom.byName?.[name] || {};
      return (info.chipLikeTextNodes || 0) === 0 && (info.chipLikeElements || 0) === 0;
    });
    if (missingMentionChips.length > 0) {
      throw new Error(`[PRE-GEN] HARD GATE: Expected @element chip(s) missing from prompt DOM: ${missingMentionChips.map(n => '@' + n).join(', ')}. No credits burned.`);
    }
    if (promptText.length === 0) {
      throw new Error('[PRE-GEN] HARD GATE: Prompt textbox is EMPTY after typing — refusing to click GENERATE. No credits burned.');
    }
    // Minimum viable prompt: at least "WIDE SHOT" opener should be present
    if (promptText.length < 30) {
      throw new Error(`[PRE-GEN] HARD GATE: Prompt too short (${promptText.length} chars) — likely incomplete. No credits burned.`);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // SCENE IMAGE GENERATION
  // ═══════════════════════════════════════════════════════════

  async generateSceneImage({ locationImagePath, characters, lighting, outputPath, aspectRatio = '16:9', projectName, onGenClicked = null, propContract = null }) {
    if (!characters || characters.length === 0) {
      throw new Error('generateSceneImage: at least one character required');
    }

    // ── ENSURE BROWSER + PAGE: create if needed, then verify alive ──
    await this.automation.ensureBrowser();
    this._ensurePageAlive();

    if (projectName) {
      await this.ensureProject(projectName);
    }

    await this._ensureCinemaStudioActive();

    // ── PRE-GENERATE VERIFICATION ──
    // Verify we're in a project view (Generations/Elements tabs visible)
    // This prevents generating into the wrong context.
    const page = this._ensurePageAlive();
    const inProject = await page.evaluate(() => {
      // Generations/Elements tabs are in the top area (top 15% of viewport)
      const topZone = window.innerHeight * 0.15;
      const btns = document.querySelectorAll('button');
      for (const b of btns) {
        const r = b.getBoundingClientRect();
        if (r.y < topZone && r.y > 30 && r.width > 0 &&
            (b.textContent?.trim().includes('Generations') || b.textContent?.trim().includes('Elements'))) {
          return true;
        }
      }
      return false;
    }).catch(() => false);

    if (!inProject) {
      this.log('Warn: not in project view — Generations/Elements tabs not found. Attempting to select project...');
      // Try navigating to saved project ID
      if (this._projectId) {
        await page.goto(this._projectUrl(), { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2500);
      }
    }

    // ══════════════════════════════════════════════════════════
    // PHASE 1: SETUP TOOLBAR (single pass — set all values)
    // Exact sequence: Generations → Image → Cinematic Cameras →
    //   1/4 → aspect ratio → 4K → 1x1
    // Phase 2 hard gate checks everything before GENERATE.
    // ══════════════════════════════════════════════════════════
    this.log('[PHASE1] Running toolbar setup sequence...');
    const setupOk = await this._setupToolbarSequence(aspectRatio);
    if (!setupOk) {
      throw new Error('SETUP FAILED: Could not configure toolbar');
    }

    // ══════════════════════════════════════════════════════════
    // PHASE 1b: VERIFY ELEMENTS via @ button
    // Runs RIGHT AFTER toolbar setup confirms Image + Cinematic Cameras.
    // The @ button ONLY exists in this mode — its presence proves we're
    // in the right state. Clicking it shows the element dropdown.
    //
    // *** HARD GUARD ***: Direct DOM scan for video smoking guns.
    // If ANY of these exist in the bottom toolbar, we are NOT in
    // Image + Cinematic Cameras — skip the @ check entirely.
    // This guard does NOT rely on _readToolbarState().
    // ══════════════════════════════════════════════════════════
    this._ensurePageAlive();

    const videoSmokeCheck = await page.evaluate(() => {
      const vh = window.innerHeight;
      const btns = [...document.querySelectorAll('button')];
      const found = [];
      for (const b of btns) {
        const r = b.getBoundingClientRect();
        if (r.y < vh * 0.5 || r.width === 0) continue; // only bottom toolbar
        const t = b.textContent?.trim() || '';
        if (t === '8s' || t === '15s' || t === '5s' || t === '10s') found.push(t);
        if (t === '1080p' || t === '720p' || t === '480p') found.push(t);
        if (t.includes('Cinema Studio 3.5')) found.push('Cinema Studio 3.5');
        if (t === 'Off' && b.querySelector('svg') && r.width < 60) found.push('Off-btn');
      }
      return found;
    }).catch(() => []);

    if (videoSmokeCheck.length > 0) {
      // Toolbar setup SAID it succeeded but we're still in Video mode.
      // This is a hard failure — do NOT proceed (would waste credits on video generation).
      this.log(`[PHASE1b] *** VIDEO MODE DETECTED *** — smoking guns: [${videoSmokeCheck.join(', ')}]. Toolbar setup gave false positive!`);
      throw new Error(`SAFETY STOP: Still in Video mode after toolbar setup — indicators: [${videoSmokeCheck.join(', ')}]`);
    } else {
      this.log('[PHASE1b] Video-mode smoke guard passed; skipping obsolete typed @element diagnostic');
    }

    // ── Attach location reference image ──
    // Select from "Image Generations" tab — no local upload needed.
    // The location was already generated in Cinema Studio.
    // Clear stale references first, then pick from the gallery.
    await this._clearAttachedReferences();
    this._lastSceneReferenceProof = null;

    this.log('[PHASE1c] Attaching location reference from Image Generations gallery');
    await this._attachLocationReference(locationImagePath);
    await page.waitForTimeout(1500);

    // ── PHASE 1d: RE-VERIFY & REPAIR ASPECT RATIO ──
    // The reference picker interaction can reset the aspect ratio (observed:
    // 16:9 → 1:1 after picker close). Re-read and re-set if it drifted.
    let postRefState = await this._readToolbarState();
    if (postRefState.aspect !== aspectRatio) {
      this.log(`[PHASE1d] Aspect ratio drifted: ${postRefState.aspect} → re-setting to ${aspectRatio}`);
      for (let aspectRepair = 1; aspectRepair <= 3 && postRefState.aspect !== aspectRatio; aspectRepair++) {
        await this._setAspectRatio(aspectRatio);
        await page.waitForTimeout(1200);
        postRefState = await this._readToolbarState();
        this.log(`[PHASE1d] Aspect repair ${aspectRepair}/3 readback: aspect=${postRefState.aspect || 'null'}, model=${postRefState.model}, res=${postRefState.resolution || 'null'}, grid=${postRefState.grid || 'null'}`);
      }
    } else {
      this.log(`[PHASE1d] Aspect ratio OK: ${postRefState.aspect}`);
    }
    this.log(postRefState.aspect === aspectRatio
      ? `[PHASE1d] Aspect ratio confirmed before Phase 2: ${postRefState.aspect}`
      : `[PHASE1d] Aspect ratio still wrong before Phase 2: ${postRefState.aspect || 'null'} (need ${aspectRatio})`,
      postRefState.aspect === aspectRatio ? 'info' : 'warn');

    // ══════════════════════════════════════════════════════════
    // PHASE 2: FINAL SETTINGS VERIFICATION before typing
    // ══════════════════════════════════════════════════════════
    this.log('[PHASE2] Final settings verification (HARD GATE — ALL checks must pass)...');

    const toolbarState = await this._readToolbarState();
    this.log(`[PHASE2] State: mode=${toolbarState.mode}, model=${toolbarState.model}, aspect=${toolbarState.aspect || 'null'}, res=${toolbarState.resolution || 'null'}, grid=${toolbarState.grid || 'null'}, @btn=${toolbarState.hasAtButton}, cost=${toolbarState.generateCost || 'unknown'}`);

    // ══════════════════════════════════════════════════════════
    // HARD GATE: Every single check must pass. Collect ALL
    // failures and throw a single comprehensive error.
    // This prevents generation with wrong settings or no reference.
    // ══════════════════════════════════════════════════════════
    const gateFailures = [];

    // Gate 1: Must be in Image mode
    if (toolbarState.mode === 'video') {
      gateFailures.push('VIDEO MODE (need Image)');
    } else if (toolbarState.mode === 'unknown') {
      gateFailures.push('MODE UNKNOWN (cannot confirm Image)');
    }

    // Gate 2: Must have Cinematic Cameras model (@ button = proof)
    if (!toolbarState.hasAtButton && toolbarState.model !== 'cinematic-cameras') {
      gateFailures.push(`WRONG MODEL: ${toolbarState.model} (need Cinematic Cameras)`);
    }

    // Gate 3: Credit cost sanity check (4K = ~4 credits)
    if (toolbarState.generateCost && toolbarState.generateCost > 10) {
      gateFailures.push(`COST TOO HIGH: ${toolbarState.generateCost} credits (expected ~4)`);
    }

    // Gate 4: Aspect ratio must be set and match expected target
    if (!toolbarState.aspect) {
      gateFailures.push('ASPECT RATIO NULL (not detected in toolbar)');
    } else if (toolbarState.aspect !== aspectRatio) {
      gateFailures.push(`ASPECT RATIO WRONG: ${toolbarState.aspect} (need ${aspectRatio})`);
    }

    // Gate 5: Resolution — informational only, not gated (use default)
    this.log(`[PHASE2] Resolution: ${toolbarState.resolution || 'unknown'} (not gated)`);

    // Gate 5b: Grid must be 1x1 (if detected)
    if (toolbarState.grid && toolbarState.grid !== '1x1') {
      gateFailures.push(`GRID: ${toolbarState.grid} (need 1x1)`);
    }

    // Gate 7: Reference upload must be backend-confirmed.
    const startFrameProofOk = !!(
      this._lastSceneReferenceProof &&
      (this._lastSceneReferenceProof.finalizeOk || (this._lastSceneReferenceProof.batchOk && this._lastSceneReferenceProof.putOk))
    );

    this.log(`[PHASE2] Reference upload proof: ${JSON.stringify(this._lastSceneReferenceProof?.responses?.slice?.(-8) || [])}`);
    if (!startFrameProofOk) {
      gateFailures.push(`START FRAME UPLOAD NOT CONFIRMED (proof=${JSON.stringify(this._lastSceneReferenceProof?.responses?.slice?.(-8) || [])})`);
    }

    // ── HARD GATE VERDICT ──
    if (gateFailures.length > 0) {
      const failMsg = gateFailures.join(' | ');
      this.log(`[PHASE2] *** HARD GATE FAILED *** (${gateFailures.length} issue(s)): ${failMsg}`);
      throw new Error(`HARD GATE: Refusing to generate — ${failMsg}`);
    }
    this.log('[PHASE2] ✓ All gates passed — settings + reference confirmed');

    // ══════════════════════════════════════════════════════════
    // PHASE 3: TYPE PROMPT + GENERATE (settings locked in)
    // ══════════════════════════════════════════════════════════
    // ── BUILD PROMPT with budget-aware blocking truncation ──
    // Higgsfield prompt limit is ~2500 chars. The fixed text (opener + closer +
    // lighting) takes ~350-500 chars. Remaining budget is split across characters.
    const imageReferenceProof = await this._checkSceneReferenceAttached();
    if (!imageReferenceProof.attached) {
      throw new Error(`[PRE-GEN] HARD GATE: Attached scene reference thumbnail not visible in composer: ${JSON.stringify(imageReferenceProof)}. No credits burned.`);
    }
    this.log(`[PHASE2] Composer reference thumbnail proof passed (${imageReferenceProof.method})`);

    const PROMPT_BUDGET = 2400;
    const opener = `WIDE SHOT inside this location. Characters are immersed in the scene and never look at or acknowledge the camera. `;
    const closer = `Photorealistic cinematic still, shallow depth of field, 35mm. Natural candid moment — no posing, no eye contact with camera. Location must match the attached image exactly — no new props or objects.`;
    // Strip existing @-prefixes from lighting text — character names in lighting
    // will be re-tagged and converted to { at: name } segments below for proper
    // UUID pill resolution. The initial strip prevents double-@ issues.
    const resolveHolderName = (holder) => {
      const raw = String(holder || '').replace(/^@/, '').toLowerCase();
      const match = characters.find(c =>
        String(c.name || '').toLowerCase() === raw ||
        String(c.baseName || '').toLowerCase() === raw
      );
      return match?.name || holder;
    };
    const promptProps = [
      ...(propContract?.requiredProps || []).filter(p => p.requiredVisible),
      ...(propContract?.mediumConfidenceMentions || []),
    ].slice(0, 4);
    const requiredProps = (propContract?.requiredProps || []).filter(p => p.requiredVisible);
    const requiredPropText = promptProps.length > 0
      ? `Nigerian story props: ${promptProps.map(p => {
          const propName = p.aliases?.[0] || p.prop;
          const holder = p.holder ? `${resolveHolderName(p.holder)} has ` : 'show ';
          const placement = p.placement || 'visible and physically anchored in the scene';
          const required = p.requiredVisible ? 'must appear' : 'optional cue';
          return `${holder}${propName} ${placement}; ${p.culturalDescription}; ${required}; never floating`;
        }).join('. ')}. `
      : '';
    const propAwareCloser = requiredProps.length > 0
      ? 'Photorealistic cinematic still, shallow depth of field, 35mm. Natural candid moment - no posing, no eye contact with camera. Location must match the attached image exactly. Do not add unrelated props, furniture, or objects. Required story props are allowed and must appear physically anchored.'
      : 'Photorealistic cinematic still, shallow depth of field, 35mm. Natural candid moment - no posing, no eye contact with camera. Location must match the attached image exactly. Do not add unrelated props, furniture, or objects. Optional story prop cues may appear only if natural and physically anchored.';
    const finalCloser = requiredPropText
      ? propAwareCloser
      : closer;
    const cleanLighting = lighting ? lighting.replace(/@/g, '') + ' ' : '';
    const fixedLen = opener.length + finalCloser.length + requiredPropText.length + cleanLighting.length;
    const charCount = characters.length;
    // Budget per character for position text (account for @name + separators)
    const perCharBudget = charCount > 0
      ? Math.floor((PROMPT_BUDGET - fixedLen) / charCount) - 30 // 30 for @name overhead
      : 200;
    const maxPosLen = Math.max(60, Math.min(200, perCharBudget));

    // Deduplicate characters by name (safety net — orchestrator should already dedup)
    const seenNames = new Set();
    const uniqueChars = characters.filter(c => {
      const key = c.name.toLowerCase();
      if (seenNames.has(key)) return false;
      seenNames.add(key);
      return true;
    });

    const segments = [];
    segments.push(opener);
    for (const c of uniqueChars) {
      segments.push({ at: c.name });
      // Position text already has @suffixedName cross-references from Vision blocking
      // (e.g. "toward @adanna_msebe_0419"). These get typed as plain text — the
      // autocomplete dropdown resolves them to UUID pills via the @-trigger.
      // Ensure any bare base names also get @-prefixed with their suffixed form.
      let posText = c.position || '';
      for (const other of uniqueChars) {
        if (other.baseName && other.baseName !== other.name) {
          const atBaseRe = new RegExp(`@${other.baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
          posText = posText.replace(atBaseRe, `@${other.name}`);
          const bareBaseRe = new RegExp(`(?<!@)\\b${other.baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
          posText = posText.replace(bareBaseRe, `@${other.name}`);
        }
        const bareRe = new RegExp(`(?<!@)\\b${other.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
        posText = posText.replace(bareRe, `@${other.name}`);
      }
      // Truncate position text at sentence/comma boundary if too long
      if (posText.length > maxPosLen) {
        const truncated = posText.slice(0, maxPosLen);
        const lastStop = Math.max(truncated.lastIndexOf('.'), truncated.lastIndexOf(','));
        posText = lastStop > maxPosLen * 0.4
          ? truncated.slice(0, lastStop + 1)
          : truncated.trimEnd();
      }
      // Clean trailing punctuation before appending period (avoids ",." or "..")
      posText = posText.replace(/[,.\s]+$/, '');
      segments.push(` ${posText}. `);
    }
    if (requiredPropText) {
      segments.push(requiredPropText);
    }
    // ── LIGHTING TEXT: convert bare character names to { at: name } segments ──
    // The lighting/notes text (e.g. "illuminating adanna's bowed face") may
    // contain bare character names without @-prefix. These MUST become @element
    // UUID pills so the model knows which character is referenced.
    // Strategy: find bare names, split into [text, {at:name}, text, ...] segments.
    if (cleanLighting.trim()) {
      let litText = cleanLighting;
      // Normalize all character name variants to @@MARKER@@ for splitting
      const litNames = {};
      for (const ch of uniqueChars) {
        litNames[ch.name.toLowerCase()] = ch.name;
        if (ch.baseName && ch.baseName !== ch.name) {
          litNames[ch.baseName.toLowerCase()] = ch.name;
        }
      }
      const sortedLitNames = Object.keys(litNames).sort((a, b) => b.length - a.length);
      for (const nv of sortedLitNames) {
        const esc = nv.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Match possessive forms too (adanna's → marker + 's)
        litText = litText.replace(new RegExp(`@?${esc}(?='s\\b)`, 'gi'), `@@${litNames[nv]}@@`);
        litText = litText.replace(new RegExp(`@?${esc}\\b`, 'gi'), `@@${litNames[nv]}@@`);
      }
      // Split on markers
      const litParts = litText.split(/@@([^@]+)@@/);
      for (let li = 0; li < litParts.length; li++) {
        if (li % 2 === 0) {
          if (litParts[li]) segments.push(litParts[li]);
        } else {
          segments.push({ at: litParts[li] });
        }
      }
    }
    segments.push(finalCloser);

    // ── PRE-GENERATION GATE: convert every character reference to @element segments ──
    // Scans string segments for explicit @element references and bare character
    // names. Instead of leaving them as raw prompt text, split them into mixed
    // text + { at: name } sequences so every character reference becomes a
    // proper Higgsfield element pill in the UI.
    {
      // Build name lookup: lowercase variant → canonical suffixed name
      const gateNames = {};
      for (const ch of uniqueChars) {
        gateNames[ch.name.toLowerCase()] = ch.name;
        if (ch.baseName && ch.baseName !== ch.name) {
          gateNames[ch.baseName.toLowerCase()] = ch.name;
        }
      }
      // Sort longest-first to avoid partial matches (e.g. "ada" inside "adanna")
      const sortedGateNames = Object.keys(gateNames).sort((a, b) => b.length - a.length);

      let fixCount = 0;
      for (let si = segments.length - 1; si >= 0; si--) {
        if (typeof segments[si] !== 'string') continue; // skip { at: name } objects
        let text = segments[si];

        // Check if this text segment contains explicit @mentions or bare names.
        let hasCharacterReference = false;
        for (const nv of sortedGateNames) {
          const esc = nv.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          if (
            new RegExp(`@${esc}\\b`, 'gi').test(text) ||
            new RegExp(`(?<!@)\\b${esc}\\b`, 'gi').test(text)
          ) {
            hasCharacterReference = true;
            break;
          }
        }
        if (!hasCharacterReference) continue;

        // Replace explicit @mentions and bare names with @@MARKER@@ delimiters, then split.
        for (const nv of sortedGateNames) {
          const esc = nv.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          // Handle possessives: "adanna's" → @@name@@'s
          text = text.replace(new RegExp(`@?${esc}(?='s\\b)`, 'gi'), `@@${gateNames[nv]}@@`);
          // Handle normal occurrences
          text = text.replace(new RegExp(`@?${esc}\\b`, 'gi'), `@@${gateNames[nv]}@@`);
        }

        // Split on @@markers@@ into alternating [text, name, text, name, ...]
        const parts = text.split(/@@([^@]+)@@/);
        const replacement = [];
        for (let pi = 0; pi < parts.length; pi++) {
          if (pi % 2 === 0) {
            if (parts[pi]) replacement.push(parts[pi]);
          } else {
            replacement.push({ at: parts[pi] });
            fixCount++;
          }
        }

        // Splice the fixed segments in place of the original string
        segments.splice(si, 1, ...replacement);
      }

      if (fixCount > 0) {
        this.log(`[PRE-GEN GATE] AUTO-FIXED ${fixCount} character reference(s) → converted to @element segments`);
        this.log(`[PRE-GEN GATE] Fixed segments: ${JSON.stringify(segments, null, 2).substring(0, 2000)}`);
      } else {
        this.log(`[PRE-GEN GATE] PASSED — all character names already properly tagged`);
      }
    }

    this.log('[PROMPT] Waiting for reference/tool state to settle before typing prompt...');
    await page.waitForTimeout(2500);
    await this._typeBlockingPrompt(segments);
    await page.waitForTimeout(2000);

    // ── FINAL SAFETY CHECK before clicking GENERATE ──
    this._ensurePageAlive();
    await this._dismissOverlays();

    // Read the GENERATE button cost one last time (handles decimals like 0.125)
    const finalCost = await page.evaluate(() => {
      const btns = document.querySelectorAll('button');
      for (const b of btns) {
        const text = b.textContent?.trim() || '';
        if (text.includes('GENERATE')) {
          const m = text.match(/([\d,.]+)\s*$/);
          return m ? parseFloat(m[1].replace(/,/g, '')) : null;
        }
      }
      return null;
    }).catch(() => null);

    if (finalCost && finalCost > 10) {
      throw new Error(`SAFETY STOP: GENERATE button shows ${finalCost} credits — aborting (expected ~2 for Image mode)`);
    }
    this.log(`[PHASE3] Final cost check: ${finalCost || 'unknown'} credits — OK`);

    // ── FINAL REFERENCE RE-CHECK (right before clicking GENERATE) ──
    // This is the LAST line of defense. If the reference somehow detached
    // (picker auto-closed, React state drift), we catch it here.
    const finalRefCheck = await this._checkSceneReferenceAttached();

    if (!finalRefCheck.attached) {
      throw new Error(`HARD GATE (PHASE3): Reference image thumbnail not visible right before GENERATE - ${JSON.stringify(finalRefCheck)}`);
    }
    if (!this._isStartFrameProofValid(this._lastSceneReferenceProof, finalRefCheck)) {
      throw new Error(`HARD GATE (PHASE3): Start frame upload not backend-confirmed right before GENERATE — proof=${JSON.stringify(this._lastSceneReferenceProof?.responses?.slice?.(-8) || [])}`);
    }
    this.log('[PHASE3] ✓ Reference still attached and backend-confirmed — proceeding to GENERATE');

    // Scroll toolbar into view before clicking GENERATE
    await this._scrollToolbarIntoView();

    // ── CLICK GENERATE ──
    // Use Playwright-native click (real mouse events) — DOM .click() can be
    // silently swallowed by React's synthetic event system.
    // Strategy: locate button via evaluate → get bounding box → Playwright click at coordinates.
    const genBtnBox = await page.evaluate(() => {
      const btns = document.querySelectorAll('button[type="submit"], button');
      for (const b of btns) {
        const text = b.textContent?.trim() || '';
        if (text.includes('GENERATE') && b.getBoundingClientRect().width > 0) {
          const r = b.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2, text };
        }
      }
      return null;
    });

    if (!genBtnBox) {
      throw new Error('GENERATE button not found on page');
    }
    this.log(`[PHASE3] Clicking GENERATE at (${Math.round(genBtnBox.x)}, ${Math.round(genBtnBox.y)}) — "${genBtnBox.text}"`);

    // Capture prompt text BEFORE clicking (button click may navigate/change DOM)
    const submittedPrompt = await page.evaluate(() => {
      const tb = document.querySelector('[role="textbox"][contenteditable="true"]');
      return tb?.textContent?.trim() || '';
    }).catch(() => '');

    // ── HARD GATE: verify prompt text before GENERATE ──
    if (!submittedPrompt || submittedPrompt.length < 30) {
      throw new Error(`[PRE-GEN] HARD GATE: Prompt text is ${submittedPrompt ? submittedPrompt.length + ' chars' : 'empty'} right before GENERATE — refusing to click. No credits burned.`);
    }

    // ── SINGLE CLICK ONLY ──
    // CRITICAL: We click GENERATE exactly ONCE. The old 3-attempt escalation pattern
    // caused triple generation (3× "Generating" tiles) because didGenerationStart()
    // detection was unreliable — the CSS selectors didn't match Higgsfield's actual DOM,
    // causing all 3 attempts to fire. At 4 credits per generation, that's 12 credits
    // wasted per scene. If the single click doesn't work, we throw an error and let
    // the orchestrator's retry loop handle it with a fresh browser context.
    await page.mouse.click(genBtnBox.x, genBtnBox.y);
    this.log('[PHASE3] GENERATE clicked once — waiting for submission to register');
    await page.waitForTimeout(4000);

    this.log(`[PHASE3] Scene image generation submitted — credits burned (${characters.length} chars, aspect ${aspectRatio}, cost: ${finalCost ?? 'unknown'})`);

    // Notify caller that Generate was clicked (for DB persistence + credit tracking)
    if (typeof onGenClicked === 'function') {
      try { onGenClicked(finalCost); } catch (_) {}
    }

    // ── WAIT FOR RESULT + DOWNLOAD ──
    // Pass the full submitted prompt for harvest verification — different scenes
    // can share the same characters, so character names alone aren't enough.
    try {
      const result = await this._waitAndDownload(outputPath, submittedPrompt);
      return { path: outputPath, model: 'cinematic-cameras', sourceGenId: result?.sourceGenId };
    } catch (e) {
      throw new Error(`Cinema Studio 3.5 gen/download failed: ${e.message}`);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // GENERATION POLLING + DOWNLOAD
  // ═══════════════════════════════════════════════════════════

  async _waitAndDownload(outputPath, submittedPrompt = '') {
    const fs = require('fs');
    const maxWaitMs = 240000; // 4 minutes — multi-character scenes can take longer
    const startedAt = Date.now();

    // Use a local reference and check alive before every page interaction
    let page = this._ensurePageAlive();

    // Snapshot ALL gallery tile srcs currently on the page before generation starts.
    // A "new" tile is one whose src is NOT in this initial set.
    // This prevents downloading stale tiles from previous projects/sessions
    // that were already visible when the page loaded.
    //
    // CRITICAL: Only count images in the GALLERY AREA (top half of page).
    // The reference thumbnail near the + button in the bottom toolbar also has
    // a CDN URL — if we include it, it can get mistaken for a "new" generation
    // tile (e.g., URL changes after upload processing).
    let initialSrcSet = new Set();
    let initialTileCount = 0;
    try {
      const initial = await page.evaluate(() => {
        const vh = window.innerHeight;
        const galleryThreshold = vh * 0.55; // Gallery is top ~55%, toolbar is below
        const sel = 'img[src*="images.higgs.ai"], img[src*="cloudfront.net"], img[src*="cdn.higgsfield"]';
        const tiles = document.querySelectorAll(sel);
        const srcs = [];
        for (const t of tiles) {
          const r = t.getBoundingClientRect();
          // Only include tiles in the gallery area (above toolbar)
          // AND reasonably sized (not tiny icons/avatars)
          if (r.y < galleryThreshold && r.width > 80 && r.height > 80) {
            srcs.push(t.src);
          }
        }
        return { srcs, count: srcs.length };
      });
      initialSrcSet = new Set(initial.srcs);
      initialTileCount = initial.count;
      this.log(`[POLL] Initial state: ${initialTileCount} gallery tiles snapshotted`);
    } catch (e) {
      throw new Error(`Page closed before download polling started: ${e.message.split('\n')[0]}`);
    }

    while (Date.now() - startedAt < maxWaitMs) {
      // ── PAGE-ALIVE CHECK (every poll iteration) ──
      try {
        page = this._ensurePageAlive();
      } catch (e) {
        throw new Error(`Page closed during generation wait: ${e.message}`);
      }

      try {
        await page.waitForTimeout(3000);
      } catch (e) {
        // waitForTimeout fails if page is closed
        throw new Error(`Page closed during generation wait (timeout): ${e.message.split('\n')[0]}`);
      }

      let currentTiles = [];
      try {
        currentTiles = await page.evaluate(() => {
          const vh = window.innerHeight;
          const galleryThreshold = vh * 0.55;
          const sel = 'img[src*="images.higgs.ai"], img[src*="cloudfront.net"], img[src*="cdn.higgsfield"]';
          const tiles = document.querySelectorAll(sel);
          const srcs = [];
          for (const t of tiles) {
            const r = t.getBoundingClientRect();
            if (r.y < galleryThreshold && r.width > 80 && r.height > 80) {
              srcs.push(t.src);
            }
          }
          return srcs;
        });
      } catch (e) {
        throw new Error(`Page closed during generation poll: ${e.message.split('\n')[0]}`);
      }

      // Find any tile src that was NOT in the initial snapshot — that's the new generation.
      // This is robust against stale tiles from previous projects/sessions.
      const newSrc = currentTiles.find(src => src && !initialSrcSet.has(src));

      if (newSrc) {
        this.log(`[POLL] New tile detected! (${currentTiles.length} total, was ${initialTileCount})`);
        try {
          const buffer = await page.evaluate(async (url) => {
            const res = await fetch(url);
            const blob = await res.blob();
            const ab = await blob.arrayBuffer();
            return Array.from(new Uint8Array(ab));
          }, newSrc);
          if (buffer.length < 5000) {
            this.log(`[DOWNLOAD] WARNING: fetched image too small (${buffer.length} bytes) — may be a placeholder, retrying...`);
            continue; // Keep polling — the real image may still be rendering
          }
          fs.writeFileSync(outputPath, Buffer.from(buffer));
          // Verify file was actually written
          const stat = fs.statSync(outputPath);
          this.log(`Downloaded scene image to ${outputPath} (${stat.size} bytes on disk)`);
          return { sourceGenId: this._extractGenId(newSrc) };
        } catch (e) {
          throw new Error(`Download failed: ${e.message}`);
        }
      }

      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      if (elapsed % 15 === 0) this.log(`[POLL] Waiting for generation... (${elapsed}s, tiles: ${currentTiles.length})`);
    }
    // ── TIMEOUT RECOVERY: Try to harvest the generation from the Asset library ──
    // The generation may have completed on Higgsfield's side — just the tile
    // detection missed it. Instead of re-generating (wasting credits), navigate
    // to /asset/image, find the image by prompt matching, and download it.
    this.log(`[HARVEST] Generation timed out after ${maxWaitMs / 1000}s — attempting to harvest from Asset library...`);
    try {
      const harvested = await this._harvestRecentGeneration(outputPath, submittedPrompt);
      if (harvested) {
        this.log(`[HARVEST] ✓ Successfully harvested generation — saved to ${outputPath}`);
        return { sourceGenId: harvested.sourceGenId };
      }
    } catch (harvestErr) {
      this.log(`[HARVEST] Harvest attempt failed: ${harvestErr.message}`);
    }

    throw new Error(`Timeout (${maxWaitMs / 1000}s) — harvest also failed`);
  }

  /**
   * Recover a timed-out scene image from the Higgsfield Asset library.
   * Mirrors the Kling recoverTimedOutClip() pattern.
   *
   * DOM facts (confirmed via Chrome MCP inspection, April 2026):
   *   - Assets/Image grid URL: https://higgsfield.ai/asset/image
   *   - Tiles: <figure data-asset-id="{uuid}"> containing <img data-asset-preview="{uuid}">
   *   - No <a> tags — React client-side routing. Clicking figure may not navigate
   *     in Playwright, so we navigate directly to /asset/image/{uuid}
   *   - Detail page: right panel has PROMPT section (text between "PROMPT" and "INFORMATION"
   *     in body.innerText, strip "Copy" prefix and "See all" suffix)
   *   - Copy button is a <div> near the PROMPT heading
   *   - Download button: <button> with text "Download"
   *   - Close button: top-right X (can also use Escape or navigate away)
   *
   * Flow:
   *   1. Nuke context (page is in unknown state after timeout)
   *   2. Navigate to /asset/image (all generated images)
   *   3. Scan figure[data-asset-id] tiles (most recent first)
   *   4. For each tile: navigate to /asset/image/{uuid}, scrape prompt, compare
   *   5. On match (≥85% similarity): click Download → save → return success
   *
   * @param {string} submittedPrompt - the exact blocking prompt submitted to Cinema Studio
   * @param {string} outputPath      - where to save the recovered image
   * @param {Object} [opts]
   * @param {number} [opts.minSimilarity=85] - minimum prompt similarity (0-100)
   * @param {number} [opts.maxTilesToCheck=6] - max tiles to check before giving up
   * @param {number} [opts.timeoutMs=90000]   - total recovery timeout
   * @returns {Promise<{path, sourceGenId, assetUuid}|null>}
   */
  async recoverTimedOutImage(submittedPrompt, outputPath, opts = {}) {
    const fs = require('fs');
    const minSimilarity = opts.minSimilarity || 85;
    const maxTilesToCheck = opts.maxTilesToCheck || 6;
    const timeoutMs = opts.timeoutMs || 90000;
    const startedAt = Date.now();

    this.log('[RECOVERY] Starting scene image recovery from Asset library...');

    // ── 1. Nuke context for clean navigation ──
    try {
      await this.automation.recreateContext();
    } catch (e) {
      this.log(`[RECOVERY] Context recreate failed: ${e.message}`);
      return null;
    }
    const page = this.automation.page;
    if (!page) {
      this.log('[RECOVERY] No page after context recreate');
      return null;
    }
    this._projectCreated = false;

    // ── 2. Navigate to Asset/Image grid ──
    try {
      await page.goto('https://higgsfield.ai/asset/image', {
        waitUntil: 'domcontentloaded',
        timeout: 20000,
      });
    } catch (navErr) {
      this.log(`[RECOVERY] Navigation failed: ${navErr.message.split('\n')[0]}`);
      return null;
    }
    await page.waitForTimeout(3000);
    this.log(`[RECOVERY] Asset/image page loaded. URL: ${page.url()}`);

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
      this.log(`[RECOVERY] No image tiles yet (poll ${poll + 1}/4) — waiting 2s...`);
      await page.waitForTimeout(2000);
    }

    if (imageTiles.length === 0) {
      this.log('[RECOVERY] No image tiles found on asset page — giving up');
      return null;
    }
    this.log(`[RECOVERY] Found ${imageTiles.length} image tile(s) — checking up to ${Math.min(maxTilesToCheck, imageTiles.length)}`);

    // ── 4. Check each tile: navigate to detail, scrape prompt, compare ──
    const tilesToCheck = imageTiles.slice(0, maxTilesToCheck);

    for (let i = 0; i < tilesToCheck.length; i++) {
      if (Date.now() - startedAt > timeoutMs) {
        this.log(`[RECOVERY] Timeout (${timeoutMs / 1000}s) — giving up after ${i} tiles`);
        return null;
      }

      const tile = tilesToCheck[i];
      if (!tile.uuid) {
        this.log(`[RECOVERY] Tile ${i + 1} has no UUID — skipping`);
        continue;
      }
      this.log(`[RECOVERY] Checking tile ${i + 1}/${tilesToCheck.length} (uuid=${tile.uuid})...`);

      try {
        // Navigate directly to the detail page (click doesn't work — React routing)
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
          this.log(`[RECOVERY] Detail panel didn't load for tile ${i + 1} — skipping`);
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
          this.log(`[RECOVERY] No prompt text for tile ${i + 1} — skipping`);
          continue;
        }

        // Compare prompts using normalized similarity
        const similarity = this._promptSimilarity(submittedPrompt, tilePrompt);
        this.log(`[RECOVERY] Tile ${i + 1} similarity: ${similarity}% (need ≥${minSimilarity}%)`);
        this.log(`[RECOVERY]   Submitted (first 80): "${submittedPrompt.slice(0, 80)}..."`);
        this.log(`[RECOVERY]   Tile      (first 80): "${tilePrompt.slice(0, 80)}..."`);

        if (similarity < minSimilarity) {
          continue; // Not a match — try next tile
        }

        // ── 5. MATCH FOUND — Download the image ──
        this.log(`[RECOVERY] ✓ MATCH at ${similarity}% — downloading ${tile.uuid}...`);

        try {
          const dlBtn = await page.getByText('Download', { exact: true }).first();
          const [download] = await Promise.all([
            page.waitForEvent('download', { timeout: 20000 }),
            dlBtn.click({ timeout: 5000 }),
          ]);
          await download.saveAs(outputPath);
          const stat = fs.statSync(outputPath);

          if (stat.size < 10000) {
            this.log(`[RECOVERY] Download too small (${stat.size} bytes) — likely a placeholder`);
            fs.unlinkSync(outputPath);
            continue; // try next tile
          }

          this.log(`[RECOVERY] ✓ Downloaded to ${outputPath} (${(stat.size / 1024).toFixed(1)} KB)`);
          return {
            path: outputPath,
            sourceGenId: tile.uuid,
            assetUuid: tile.uuid,
          };
        } catch (dlErr) {
          this.log(`[RECOVERY] Download failed for tile ${i + 1}: ${dlErr.message.split('\n')[0]}`);
          continue;
        }
      } catch (tileErr) {
        this.log(`[RECOVERY] Error checking tile ${i + 1}: ${tileErr.message.split('\n')[0]}`);
        continue;
      }
    }

    this.log(`[RECOVERY] No matching image found after checking ${tilesToCheck.length} tiles`);
    return null;
  }

  /**
   * Public wrapper for harvest recovery — called by the orchestrator's retry loop
   * to attempt image recovery before re-generating (which burns credits).
   *
   * Uses the Asset library (/asset/image) with prompt matching to find the
   * correct image, rather than blindly downloading the newest tile.
   *
   * @param {string} submittedPrompt - the prompt that was submitted before timeout
   * @param {string} outputPath - Where to save the harvested image
   * @returns {{ sourceGenId: string, assetUuid: string }|null}
   */
  async attemptHarvestRecovery(submittedPrompt, outputPath) {
    return this.recoverTimedOutImage(submittedPrompt, outputPath);
  }

  /**
   * INTERNAL HARVEST: Called by _waitAndDownload() on timeout.
   * Uses the same Asset library recovery with prompt matching.
   *
   * @param {string} outputPath - Where to save the harvested image
   * @param {string} submittedPrompt - the prompt used for generation
   * @returns {{ sourceGenId: string }|null}
   */
  async _harvestRecentGeneration(outputPath, submittedPrompt) {
    if (!submittedPrompt || submittedPrompt.length < 20) {
      this.log('[HARVEST] No prompt available for matching — cannot recover');
      return null;
    }
    return this.recoverTimedOutImage(submittedPrompt, outputPath);
  }

  /**
   * Normalize a prompt string for fuzzy comparison. Strips whitespace runs,
   * lowercases, removes @-mention prefixes.
   */
  _normalizePrompt(text) {
    return (text || '')
      .toLowerCase()
      .replace(/@/g, '')           // strip @ symbols
      .replace(/\s+/g, ' ')       // collapse whitespace
      .replace(/[""'']/g, '"')    // normalize quotes
      .trim();
  }

  /**
   * Calculate prompt similarity (0-100) using word overlap.
   * Same algorithm as Kling's _promptSimilarity.
   */
  _promptSimilarity(a, b) {
    const normA = this._normalizePrompt(a);
    const normB = this._normalizePrompt(b);
    if (normA === normB) return 100;
    if (!normA || !normB) return 0;

    const wordsA = new Set(normA.split(' ').filter(w => w.length > 2));
    const wordsB = new Set(normB.split(' ').filter(w => w.length > 2));
    if (wordsA.size === 0 || wordsB.size === 0) return 0;

    let overlap = 0;
    for (const w of wordsA) {
      if (wordsB.has(w)) overlap++;
    }
    // Jaccard-ish: overlap / union
    const union = new Set([...wordsA, ...wordsB]).size;
    return Math.round((overlap / union) * 100);
  }

  /**
   * Scan the current page for generated image tiles (history grid, gallery, etc).
   * Returns array of { src, x, y, w, h } for clickable tiles.
   */
  async _scanForImageTiles(page) {
    return page.evaluate(() => {
      const seen = new Set();
      const results = [];

      const addImg = (img) => {
        if (!img || seen.has(img)) return;
        seen.add(img);
        const r = img.getBoundingClientRect();
        // Must be visible, reasonably sized (not icons/avatars), and on-screen
        if (r.width > 50 && r.height > 50 && r.x >= 0 && r.y >= 0 &&
            r.x < window.innerWidth && r.y < window.innerHeight * 2) {
          results.push({
            src: img.src,
            x: Math.round(r.x + r.width / 2),
            y: Math.round(r.y + r.height / 2),
            w: Math.round(r.width),
            h: Math.round(r.height),
          });
        }
      };

      // Strategy 1: CDN URL patterns (images.higgs.ai, cloudfront.net, cdn.higgsfield)
      document.querySelectorAll('img[src*="images.higgs.ai"], img[src*="cloudfront.net"], img[src*="cdn.higgsfield"]').forEach(addImg);
      // Strategy 2: data-asset-preview attribute (history cards in non-Cinema-Studio views)
      document.querySelectorAll('img[data-asset-preview]').forEach(addImg);
      // Strategy 3: Grid container images (overflow grids, thumbnails)
      document.querySelectorAll('.overflow-x-hidden img, [class*="grid"] img, [class*="thumbnail"] img, [class*="card"] img').forEach(i => {
        if (i.src && !i.src.includes('avatar') && !i.src.includes('icon') && !i.src.includes('logo')) addImg(i);
      });
      // Strategy 4: Any large image that looks like generated content (>100px both dimensions)
      document.querySelectorAll('img').forEach(img => {
        const r = img.getBoundingClientRect();
        if (r.width > 100 && r.height > 100 && img.src &&
            !img.src.includes('avatar') && !img.src.includes('icon') &&
            !img.src.includes('logo') && !img.src.includes('data:')) {
          addImg(img);
        }
      });

      return results.slice(0, 10);
    }).catch(() => []);
  }

  /**
   * Close the image detail modal — click the X button in the top-right corner.
   * Falls back to Escape key if X button not found.
   */
  async _closeDetailModal(page) {
    try {
      // The X close button is in the top-right of the detail panel.
      // Look for a button/element with × or X text, or an SVG close icon.
      const closed = await page.evaluate(() => {
        // Strategy 1: Find a close button near the top-right of the modal
        const buttons = document.querySelectorAll('button, [role="button"], svg');
        for (const btn of buttons) {
          const r = btn.getBoundingClientRect();
          const text = btn.textContent?.trim() || '';
          const ariaLabel = btn.getAttribute('aria-label') || '';
          // X button is typically in the top-right area, small, with × or close label
          if (
            (text === '×' || text === 'X' || text === '✕' ||
             ariaLabel.toLowerCase().includes('close') ||
             ariaLabel.toLowerCase().includes('dismiss')) &&
            r.x > window.innerWidth * 0.7 && r.y < 150 && r.width < 60
          ) {
            btn.click();
            return true;
          }
        }
        // Strategy 2: Look for SVG-based close icons (line/path elements forming an X)
        // in the top-right area
        const svgs = document.querySelectorAll('svg');
        for (const svg of svgs) {
          const r = svg.getBoundingClientRect();
          if (r.x > window.innerWidth * 0.7 && r.y < 150 && r.width < 40 && r.width > 8) {
            const parent = svg.closest('button') || svg.parentElement;
            if (parent) { parent.click(); return true; }
          }
        }
        return false;
      });

      if (closed) {
        await page.waitForTimeout(500);
        return;
      }
    } catch (_) {}
    // Fallback: press Escape
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  }

  _extractGenId(url) {
    const match = url.match(/url=([^&]+)/);
    return match ? decodeURIComponent(match[1]).split('/').pop()?.split('.')[0] || null : null;
  }
}

module.exports = { CinemaStudioAutomation };
