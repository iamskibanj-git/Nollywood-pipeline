/**
 * higgsfield-elements.js — Phase 2 of the cinematic workflow.
 *
 * Automates Higgsfield's Elements panel: list existing elements and create new
 * Character / Location / Prop elements programmatically. These elements provide
 * the persistent visual + voice identity lock that makes the cinematic pipeline's
 * multi-shot Kling generations consistent across cuts.
 *
 * DOM structure (verified via live Playwright DevTools, April 2026):
 *
 *   TOP CENTER (only visible inside a project view):
 *     <div class="flex items-center gap-1 rounded-[10px] bg-white/5 p-1">
 *       <button class="button button-sm ...">Generations</button>
 *       <button class="button button-sm ...">Elements</button>   ← PREFERRED entry
 *     </div>
 *     NOTE: These tabs do NOT appear on "My Generations" default view.
 *           Must select/create a project first.
 *
 *   BOTTOM TOOLBAR @ BUTTON (alternate entry to Elements):
 *     After [Cinematic Cameras] [-1/4+] [16:9] [2K] [1x1]:
 *       button (34x32, no text, SVG with @ icon, y ≈ 779)
 *     Clicking this also opens the Elements panel.
 *
 *   PROMPT TEXTBOX (Lexical editor):
 *     div[role="textbox"][contenteditable="true"]
 *     This is a Lexical editor — NOT a standard input/textarea.
 *     Use document.execCommand('insertText') to type text.
 *     Use keyboard.type() ONLY for '@' to trigger autocomplete dropdown.
 *     DO NOT walk React fibers — causes cross-origin crash.
 *
 *   ELEMENTS PANEL (after clicking Elements tab):
 *     "Project elements" header
 *     "Personal elements" collapsible section
 *       Element list: div.min-w-0.flex-1.flex.flex-col.gap-1 containers
 *         <p> name (e.g., "solomon")
 *         <p> category (e.g., "Character") or description text
 *     Grid card: "Create new" card with + icon (the entry point for new elements)
 *
 *   ELEMENTS GRID (after the panel opens):
 *     Shows existing elements as thumbnail cards + a "Create new" card with + icon.
 *     Left sidebar filter: All | Pinned | Characters | Locations
 *
 *   ELEMENT CREATION FORM (after clicking "Create new"):
 *     Upload area: input[type="file"].sr-only (accept: image/png,jpeg,video/mp4; multiple)
 *     Name: input[type="text"][placeholder="reference-name"] (@ prefix shown in UI)
 *     Category: button[role="combobox"] → div[role="option"]: Auto | Character | Location | Prop
 *       NOTE: Singular "Character" / "Location" / "Prop" (NOT plural)
 *     "Advanced settings" toggle button → expands:
 *       Description: textarea[placeholder="Describe how to use this reference when it's mentioned"]
 *     Submit: button with text "Save" (NOT "Create")
 *
 * ⚠️ DESIGN INTENT: this automation is the PRIMARY path. The manual checklist
 * surfaced by the orchestrator when this fails is a DIAGNOSTIC FALLBACK, not
 * a routine UX. Session 8 first cinematic run showed all 3 character elements
 * falling through to manual — that's a regression to fix, not normal flow.
 */

const path = require('path');

class HiggsfieldElements {
  /**
   * @param {Object} opts
   * @param {HiggsFieldAutomation} opts.automation - shared Playwright instance
   * @param {Function} [opts.logger] - callback for log messages
   * @param {Object} [opts.cinemaStudio] - CinemaStudioAutomation instance (for project management)
   */
  constructor({ automation, logger, cinemaStudio }) {
    this.automation = automation;
    this.log = logger || ((msg) => console.log(`[ELEMENTS] ${msg}`));
    this.cinemaStudio = cinemaStudio || null;
    this._cache = null;
  }

  // ═══════════════════════════════════════════════════════════
  // NAVIGATION — OPEN ELEMENTS PANEL
  // ═══════════════════════════════════════════════════════════

  /**
   * Navigate to the Elements panel via the "Elements" tab (top center,
   * next to "Generations"). This is only visible inside a project view.
   *
   * The Elements tab shows:
   *   - Left: "Personal elements" list with existing elements
   *   - Right: "Create Element" button + "Share elements inside project" area
   *
   * NOTE: The @ button in the bottom toolbar is NOT used for creation.
   * Element existence is checked via the Elements panel scrape.
   */
  async _openElementsPanel() {
    if (typeof this.automation.ensureBrowser === 'function') {
      await this.automation.ensureBrowser();
    }
    const page = this.automation.page;
    if (!page) throw new Error('Playwright page not ready even after ensureBrowser()');

    await this._dismissOverlays(page);

    // Navigate to Cinema Studio if not already there
    if (!page.url().includes('/cinema-studio')) {
      this.log('Navigating to Cinema Studio...');
      await page.goto('https://higgsfield.ai/cinema-studio', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);
    }

    // Ensure we're in a project view (Elements tab only appears inside a project)
    // If cinemaStudio instance has a project ID, navigate to it
    if (this.cinemaStudio && this.cinemaStudio._projectId) {
      const url = page.url();
      if (!url.includes(this.cinemaStudio._projectId)) {
        this.log(`Navigating to project ${this.cinemaStudio._projectId}...`);
        await page.goto(`https://higgsfield.ai/cinema-studio?cinematic-project-id=${this.cinemaStudio._projectId}`, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(3000);
      }
    }

    // ── Click the "Elements" tab (top center, next to "Generations") ──
    // Retry up to 4 times with waits — the tab may not be rendered yet.
    let tabClicked = false;

    for (let attempt = 0; attempt < 4 && !tabClicked; attempt++) {
      if (attempt > 0) {
        const waitMs = 2000 + attempt * 1000;
        this.log(`Elements tab not found — waiting ${waitMs}ms (attempt ${attempt + 1}/4)...`);
        await page.waitForTimeout(waitMs);
      }

      try {
        tabClicked = await page.evaluate(() => {
          const btns = document.querySelectorAll('button');
          const vh = window.innerHeight;

          // The Generations/Elements tabs are in the top area (y < 15% of viewport)
          for (const b of btns) {
            const r = b.getBoundingClientRect();
            const text = b.textContent?.trim();
            if (text === 'Elements' && r.y < vh * 0.15 && r.y > 0 && r.width > 0) {
              b.click();
              return true;
            }
          }

          // Broader: any "Elements" button in top 20%
          for (const b of btns) {
            const r = b.getBoundingClientRect();
            const text = b.textContent?.trim();
            if (text === 'Elements' && r.y < vh * 0.20 && r.width > 0) {
              b.click();
              return true;
            }
          }

          return false;
        });
      } catch (e) {
        this.log(`Elements tab click failed (attempt ${attempt + 1}): ${e.message.split('\n')[0]}`);
      }
    }

    if (!tabClicked) {
      // Fallback: try clicking a project first (Elements tab only shows in project view)
      this.log('Elements tab not found — trying to select a project first...');
      const clicked = await this._clickFirstProject(page);
      if (clicked) {
        await page.waitForTimeout(2500);
        // Retry Elements tab click
        tabClicked = await page.evaluate(() => {
          const btns = document.querySelectorAll('button');
          for (const b of btns) {
            const r = b.getBoundingClientRect();
            if (b.textContent?.trim() === 'Elements' && r.y < window.innerHeight * 0.20 && r.width > 0) {
              b.click();
              return true;
            }
          }
          return false;
        }).catch(() => false);
      }
    }

    if (tabClicked) {
      this.log('Elements tab clicked');
    } else {
      throw new Error('Could not find "Elements" tab — must be in a project view');
    }

    await page.waitForTimeout(2000);

    // ── Confirm panel is showing elements view ──
    const confirmed = await page.evaluate(() => {
      const allText = document.body.innerText || '';
      return allText.includes('Personal elements') ||
             allText.includes('Project elements') ||
             allText.includes('Create Element') ||
             allText.includes('Share elements');
    }).catch(() => false);

    if (!confirmed) {
      await page.waitForTimeout(2000);
      const retryConfirm = await page.evaluate(() => {
        const allText = document.body.innerText || '';
        return allText.includes('Personal elements') ||
               allText.includes('Project elements') ||
               allText.includes('Create Element') ||
               allText.includes('Share elements');
      }).catch(() => false);
      if (!retryConfirm) {
        throw new Error('Elements panel did not open after clicking Elements tab');
      }
    }

    this.log('Elements panel open (via Elements tab)');
  }

  // ═══════════════════════════════════════════════════════════
  // NAVIGATION HELPERS
  // ═══════════════════════════════════════════════════════════

  /**
   * Click the first project in the left sidebar.
   */
  async _clickFirstProject(page) {
    return page.evaluate(() => {
      const btns = document.querySelectorAll('button');
      for (const b of btns) {
        const r = b.getBoundingClientRect();
        const text = b.textContent?.trim() || '';
        // Sidebar project buttons: x < 80, not "My Generations" or "New project"
        const vh = window.innerHeight;
        if (r.x < 80 && r.y > vh * 0.08 && r.y < vh * 0.35 && r.width > 0 &&
            !text.startsWith('My Generations') && !text.startsWith('New project') &&
            text.includes('asset')) {
          b.click();
          return true;
        }
      }
      return false;
    }).catch(() => false);
  }

  /**
   * Click "New project" in the left sidebar.
   */
  async _createNewProject(page) {
    return page.evaluate(() => {
      const btns = document.querySelectorAll('button');
      for (const b of btns) {
        const r = b.getBoundingClientRect();
        if (r.x < 80 && b.textContent?.trim().includes('New project') && r.width > 0) {
          b.click();
          return true;
        }
      }
      // Fallback: click "+" at sidebar bottom
      let best = null, bestY = 0;
      for (const b of btns) {
        const r = b.getBoundingClientRect();
        if (r.x < 80 && r.y > bestY && r.width > 0 && r.width < 60) {
          best = b; bestY = r.y;
        }
      }
      if (best) { best.click(); return true; }
      return false;
    }).catch(() => false);
  }

  async _dismissOverlays(page) {
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

  /**
   * Store the project name so _openElementsPanel can pass it to
   * CinemaStudioAutomation.ensureProject() if needed.
   */
  setProjectName(name) {
    this._projectName = name;
  }

  // ═══════════════════════════════════════════════════════════
  // LIST EXISTING ELEMENTS
  // ═══════════════════════════════════════════════════════════

  /**
   * List all existing elements. Returns [{ name, category }].
   *
   * DOM: elements are in div.min-w-0.flex-1.flex.flex-col.gap-1 containers,
   * each with <p> tags: first = name, second = category or description.
   */
  async listExistingElements() {
    if (this._cache) return this._cache;

    await this._openElementsPanel();
    const page = this.automation.page;

    // Wait a beat for the element list to render
    await page.waitForTimeout(1500);

    // Scrape element names from the Elements tab list view.
    // The Elements tab shows "Personal elements" with each element in a row:
    //   div.min-w-0.flex-1.flex.flex-col.gap-1
    //     <p> element_name (e.g., "mama_agbado")
    //     <p> category (e.g., "Character")
    //
    // IMPORTANT: Reject generic UI labels aggressively. The old scraper was
    // picking up "Image", "Video", "Audio", "New", "Edit", "Character" etc.
    const names = await page.evaluate(() => {
      const results = [];
      const seen = new Set();

      // Exhaustive blocklist of UI labels that are NOT element names
      const UI_LABELS = new Set([
        'all', 'pinned', 'characters', 'locations', 'props', 'create new',
        'create element', 'search...', 'personal elements', 'project elements',
        'visible only to you', 'share to', 'add to project', 'share elements',
        'share elements inside project', 'elements', 'generations',
        'image', 'video', 'audio', 'new', 'edit', 'character', 'location',
        'prop', 'auto', 'delete', 'rename', 'duplicate', 'save', 'cancel',
        'close', 'back', 'next', 'previous', 'settings', 'advanced settings',
        'upload images', 'reference-name', 'description', 'category',
        'my generations', 'new project', 'cinematic cameras', 'cinema studio',
        'generate', 'ai director', 'text', 'members', 'credits',
      ]);

      // Strategy A: Structured list view — div.min-w-0 containers with <p> tags
      const containers = document.querySelectorAll('div.min-w-0.flex-1.flex.flex-col.gap-1');
      for (const c of containers) {
        const paras = [...c.querySelectorAll('p')];
        if (paras.length >= 1) {
          const name = paras[0]?.textContent?.trim();
          const cat = paras[1]?.textContent?.trim();
          if (!name || name.length > 50) continue;
          if (UI_LABELS.has(name.toLowerCase())) continue;
          if (name.includes('Visible only') || name.includes('Share to')) continue;
          const isCat = cat && ['Character', 'Location', 'Prop', 'Auto'].includes(cat);
          if (!seen.has(name.toLowerCase())) {
            seen.add(name.toLowerCase());
            results.push({ name, category: isCat ? cat : null });
          }
        }
      }

      // Strategy B: Look for elements that have an image thumbnail + name label
      // This handles grid/card layouts where names appear below thumbnails
      if (results.length === 0) {
        // Find containers that have BOTH an <img> and a short text label
        const cards = document.querySelectorAll('div, li, article');
        for (const card of cards) {
          const r = card.getBoundingClientRect();
          // Cards are typically 80-250px
          if (r.width < 60 || r.width > 300 || r.height < 60 || r.height > 300) continue;
          const hasImg = card.querySelector('img');
          if (!hasImg) continue;

          // Get the text that's NOT inside nested complex elements
          const textNodes = [];
          for (const child of card.querySelectorAll('p, span')) {
            const text = child.textContent?.trim();
            if (text && text.length > 1 && text.length < 50 && child.children.length <= 1) {
              textNodes.push(text);
            }
          }

          for (const text of textNodes) {
            const clean = text.replace(/\.{3}$/, '');
            if (!clean || UI_LABELS.has(clean.toLowerCase())) continue;
            if (!seen.has(clean.toLowerCase())) {
              seen.add(clean.toLowerCase());
              results.push({ name: clean, category: null });
            }
          }
        }
      }

      return results;
    }).catch(() => []);

    // DON'T close the Elements tab — it stays visible as a tab,
    // not a modal. Just switch back to Generations if needed later.
    this._cache = names;
    this.log(`Found ${this._cache.length} existing element(s): ${this._cache.slice(0, 8).map(e => e.name).join(', ')}${this._cache.length > 8 ? '...' : ''}`);
    return this._cache;
  }

  invalidateCache() {
    this._cache = null;
  }

  /**
   * Check whether an element with the given name already exists.
   * Case-insensitive match, leading @ normalized.
   *
   * Uses panel scrape (listExistingElements) to check the Elements panel.
   * The authoritative check is the @ button click in Cinema Studio's toolbar
   * (Phase 1b of generateSceneImage) — that runs separately before prompt typing.
   */
  async elementExists(name) {
    const normalized = this._normalizeName(name);

    try {
      const existing = await this.listExistingElements();
      if (existing.some(e => this._normalizeName(e.name) === normalized)) {
        return true;
      }
    } catch (_) {}

    return false;
  }

  _normalizeName(name) {
    return (name || '').toLowerCase().trim().replace(/^@+/, '');
  }

  // ═══════════════════════════════════════════════════════════
  // ELEMENT CREATION
  // ═══════════════════════════════════════════════════════════

  /**
   * Category map: our internal names → Higgsfield's singular UI labels.
   */
  static CATEGORY_MAP = {
    'Characters': 'Character',
    'Character': 'Character',
    'Locations': 'Location',
    'Location': 'Location',
    'Props': 'Prop',
    'Prop': 'Prop',
  };

  /**
   * Create an element. Shared flow for Character/Location/Prop.
   *
   * Steps:
   *   1. Open Elements panel
   *   2. Click "Create Element" button
   *   3. Upload images via hidden file input
   *   4. Fill element name
   *   5. Set category via combobox dropdown
   *   6. Expand "Advanced settings" and fill description
   *   7. Click "Save"
   *   8. Verify by re-listing
   */
  async _createElement({ name, imagePaths, description, category }) {
    const normalized = this._normalizeName(name);
    if (!normalized) throw new Error('_createElement: name required');
    if (!imagePaths || imagePaths.length === 0) throw new Error('_createElement: imagePaths required');

    // Map category to Higgsfield's singular form
    const uiCategory = HiggsfieldElements.CATEGORY_MAP[category] || 'Auto';

    // Idempotency: skip if already exists
    if (await this.elementExists(normalized)) {
      this.log(`Element @${normalized} already exists — skipping`);
      return { created: false, name: normalized, skipped: 'already-exists' };
    }

    await this._openElementsPanel();
    const page = this.automation.page;

    // ── Step 2: Click "Create Element" button in Elements tab ──
    //
    // LAYOUT (from user screenshots):
    //   Left panel: scrollable "Personal elements" list (solomon, claire, etc.)
    //   Right panel: "Share elements inside project" + "Create Element" button
    //
    // The "Create Element" button is on the RIGHT SIDE of the viewport
    // (x > 50% of viewport width). Element cards are on the LEFT.
    // After clicking, the right panel becomes the creation form:
    //   Upload images (+), Element name, Category, Advanced settings, Save
    //
    // CRITICAL: The "Create Element" button is the ONLY button on the right
    // side with that exact text. Element cards on the left do NOT have this text.
    // Previous bugs happened because we clicked element cards — now we use
    // POSITION (right side only) as the primary filter.

    let createClicked = false;
    for (let createAttempt = 0; createAttempt < 4 && !createClicked; createAttempt++) {
      if (createAttempt > 0) {
        this.log(`Retrying Create button click (attempt ${createAttempt + 1}/4)...`);
        await page.waitForTimeout(2500);
      }

      // Single strategy: find "Create Element" button on the RIGHT side
      const result = await page.evaluate(() => {
        const vw = window.innerWidth;
        const midX = vw * 0.5; // Right half of viewport
        const btns = document.querySelectorAll('button, a, div[role="button"]');

        // Log all candidates for debugging
        const debug = [];

        for (const b of btns) {
          const text = b.textContent?.trim();
          const r = b.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          if (!text) continue;

          // Only "Create Element" exact text
          if (text !== 'Create Element') continue;

          const centerX = r.x + r.width / 2;
          debug.push({ text, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), centerX: Math.round(centerX), rightSide: centerX > midX });

          // MUST be on the right side of the viewport
          if (centerX > midX) {
            b.click();
            return { clicked: `Create Element (right panel, x=${Math.round(r.x)}, y=${Math.round(r.y)})`, debug };
          }
        }

        return { clicked: false, debug };
      }).catch(() => ({ clicked: false, debug: [] }));

      if (result.debug.length > 0) {
        this.log(`Create button candidates: ${JSON.stringify(result.debug)}`);
      }

      if (result.clicked) {
        createClicked = result.clicked;
        break;
      }

      // On later attempts, scroll the right panel area to reveal the button
      if (createAttempt >= 1) {
        this.log('Scrolling right panel to find Create Element button...');
        await page.evaluate(() => {
          const vw = window.innerWidth;
          const midX = vw * 0.5;
          const divs = document.querySelectorAll('div');
          for (const div of divs) {
            const r = div.getBoundingClientRect();
            // Right panel: x starts past midpoint, has scroll
            if (r.x > midX * 0.6 && r.width > 200 &&
                div.scrollHeight > div.clientHeight + 50) {
              div.scrollTop = div.scrollHeight;
              return true;
            }
          }
          // Also try scrolling the whole page
          window.scrollTo(0, document.body.scrollHeight);
          return false;
        });
        await page.waitForTimeout(2000);
      }
    }

    if (!createClicked) {
      throw new Error('Could not find "Create Element" button on right panel of Elements tab');
    }
    this.log(`Clicked "${createClicked}"`);
    await page.waitForTimeout(2500);

    // Wait for the creation form to appear on the right panel
    // Indicators: "Upload images" text, input[placeholder="reference-name"], "Save" button
    let formReady = false;
    for (let attempt = 0; attempt < 6 && !formReady; attempt++) {
      formReady = await page.evaluate(() => {
        const vw = window.innerWidth;
        const midX = vw * 0.5;

        // Check for name input on right side
        const nameInput = document.querySelector('input[placeholder="reference-name"]');
        if (nameInput) {
          const r = nameInput.getBoundingClientRect();
          if (r.x > midX * 0.5 && r.width > 0) return 'name-input';
        }

        // Check for "Upload images" text on right side
        const allText = document.querySelectorAll('span, p, div');
        for (const el of allText) {
          if (el.textContent?.trim() === 'Upload images') {
            const r = el.getBoundingClientRect();
            if (r.x > midX * 0.5) return 'upload-text';
          }
        }

        return false;
      }).catch(() => false);

      if (!formReady) {
        this.log(`Waiting for creation form... (attempt ${attempt + 1}/6)`);
        await page.waitForTimeout(2000);
      }
    }

    if (formReady) {
      this.log(`Creation form detected (${formReady})`);
    } else {
      this.log('Warn: creation form not detected — proceeding with caution');
    }

    // ── SAFETY CHECK: Is this a NEW form or an EDIT form? ──
    // EDIT form has: Delete button (bottom left, red), filled name, existing images.
    // NEW form has: "Upload images" placeholder, empty name, NO Delete button.
    const formType = await page.evaluate(() => {
      const nameInput = document.querySelector('input[placeholder="reference-name"]');
      const nameValue = nameInput ? nameInput.value : '';

      // Check for Delete button — ONLY present in edit mode
      let hasDelete = false;
      const btns = document.querySelectorAll('button');
      for (const b of btns) {
        if (b.textContent?.trim() === 'Delete' && b.getBoundingClientRect().width > 0) {
          hasDelete = true;
          break;
        }
      }

      // Check for "Upload images" placeholder text (present in NEW form only)
      let hasUploadPlaceholder = false;
      const allText = document.querySelectorAll('span, p, div');
      for (const el of allText) {
        if (el.textContent?.trim() === 'Upload images' && el.getBoundingClientRect().width > 0) {
          hasUploadPlaceholder = true;
          break;
        }
      }

      return {
        nameValue,
        hasDelete,
        hasUploadPlaceholder,
        isEditForm: hasDelete || (nameValue.length > 0),
      };
    }).catch(() => ({ isEditForm: false }));

    this.log(`Form safety: name="${formType.nameValue}", delete=${formType.hasDelete}, uploadPlaceholder=${formType.hasUploadPlaceholder}, isEdit=${formType.isEditForm}`);

    if (formType.isEditForm) {
      this.log('SAFETY ABORT: Opened an EDIT form instead of CREATE — closing form');
      await this._closeCreationForm(page);
      await page.waitForTimeout(2000);
      throw new Error(`Opened edit form for "${formType.nameValue}" instead of create form`);
    }

    // ── Step 3: Upload images ──
    //
    // From user screenshots, the upload area is a large box on the right panel
    // with a + icon and "Upload images" text. A hidden input[type="file"] is
    // in the DOM (sr-only). Clicking the upload area opens a native file picker.
    //
    // In headed Electron+Playwright, native file dialogs BLOCK the automation.
    // Playwright's filechooser event intercept also fails (timeout).
    //
    // WORKING APPROACH: Use Playwright's setInputFiles() on the hidden input.
    // This sets files programmatically. To make React see them, we trigger
    // React's internal onChange via the native input setter trick.

    this.log(`Uploading ${imagePaths.length} image(s): ${imagePaths.map(p => require('path').basename(p)).join(', ')}`);

    try {
      const fileInput = page.locator('input[type="file"]').first();
      const inputExists = await fileInput.count() > 0;
      if (!inputExists) throw new Error('No input[type="file"] found in DOM');

      const inputInfo = await page.evaluate(() => {
        const input = document.querySelector('input[type="file"]');
        if (!input) return null;
        return { accept: input.accept, multiple: input.multiple, className: input.className };
      });
      this.log(`File input: accept="${inputInfo?.accept}", multiple=${inputInfo?.multiple}`);

      // Set files via Playwright's API
      await fileInput.setInputFiles(imagePaths, { timeout: 10000 });
      this.log('setInputFiles completed');
      await page.waitForTimeout(1000);

      // Trigger React's onChange using the native value setter trick.
      // React overrides the input's value setter — we need to call the
      // NATIVE HTMLInputElement setter to make React detect the change.
      await page.evaluate(() => {
        const input = document.querySelector('input[type="file"]');
        if (!input) return;

        // Method 1: Standard events (works for vanilla JS handlers)
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new Event('input', { bubbles: true }));

        // Method 2: React synthetic event trigger
        // React 16+ uses a custom event system. We need to trigger the
        // internal fiber's onChange. The most reliable way is to find
        // React's internal handler key and call it directly.
        const reactKey = Object.keys(input).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
        if (reactKey) {
          let fiber = input[reactKey];
          // Walk up the fiber tree to find an onChange handler
          while (fiber) {
            if (fiber.memoizedProps && fiber.memoizedProps.onChange) {
              try {
                fiber.memoizedProps.onChange({ target: input, currentTarget: input });
              } catch (_) {}
              break;
            }
            fiber = fiber.return;
          }
        }

        // Method 3: React event props key
        const propsKey = Object.keys(input).find(k => k.startsWith('__reactProps$'));
        if (propsKey && input[propsKey]?.onChange) {
          try {
            input[propsKey].onChange({ target: input, currentTarget: input });
          } catch (_) {}
        }
      });
      this.log('React onChange triggered');
      await page.waitForTimeout(2000);

    } catch (e) {
      throw new Error(`Image upload failed: ${e.message}`);
    }

    // ── Wait for upload to be processed (Save button enabled) ──
    // The ONLY reliable signal is the Save button becoming enabled.
    // Preview counting was picking up page-wide images (33 thumbnails),
    // not form-scoped ones. Focus solely on Save button state.
    const UPLOAD_POLL_MAX = 25;   // 25 polls
    const UPLOAD_POLL_MS = 2000;  // 2s each = 50s max patience
    this.log(`Waiting up to ${(UPLOAD_POLL_MAX * UPLOAD_POLL_MS) / 1000}s for Save to enable...`);

    let uploadProcessed = false;
    for (let poll = 0; poll < UPLOAD_POLL_MAX; poll++) {
      await page.waitForTimeout(UPLOAD_POLL_MS);

      const state = await page.evaluate(() => {
        // Check Save button state
        const saveBtn = [...document.querySelectorAll('button')].find(b =>
          b.textContent?.trim() === 'Save');
        if (!saveBtn) return { saveState: 'not-found' };

        const isDisabled = saveBtn.disabled ||
          saveBtn.getAttribute('aria-disabled') === 'true' ||
          getComputedStyle(saveBtn).opacity < 0.6 ||
          getComputedStyle(saveBtn).pointerEvents === 'none';

        // Also check if "Upload images" placeholder is still showing
        // Scope to the form area — look near the file input, not page-wide
        const fileInput = document.querySelector('input[type="file"]');
        let uploadZoneHasText = false;
        if (fileInput) {
          let container = fileInput;
          for (let i = 0; i < 4; i++) { // Only 4 levels up — tight scope
            container = container.parentElement;
            if (!container) break;
          }
          if (container) {
            uploadZoneHasText = container.textContent?.includes('Upload images') || false;
          }
        }

        return {
          saveState: isDisabled ? 'disabled' : 'enabled',
          uploadZoneHasText,
          saveCursor: getComputedStyle(saveBtn).cursor,
        };
      }).catch(() => ({ saveState: 'error' }));

      if (poll % 5 === 4 || state.saveState === 'enabled') {
        this.log(`Upload poll ${poll + 1}/${UPLOAD_POLL_MAX}: save=${state.saveState}, uploadText=${state.uploadZoneHasText}`);
      }

      if (state.saveState === 'enabled') {
        uploadProcessed = true;
        this.log('Save button enabled — images fully processed');
        break;
      }
    }

    if (!uploadProcessed) {
      // Diagnosis: check if files are on the input
      const diagnosis = await page.evaluate(() => {
        const input = document.querySelector('input[type="file"]');
        return {
          inputExists: !!input,
          filesCount: input?.files?.length || 0,
          fileNames: input?.files ? [...input.files].map(f => f.name) : [],
        };
      }).catch(() => ({}));
      this.log(`Upload diagnosis: ${JSON.stringify(diagnosis)}`);
      this.log('Warn: Save not enabled after 50s — images may not have been processed');
    }

    // Settle time
    await page.waitForTimeout(2000);

    // ── Step 4: Fill element name ──
    this.log('Step 4: Filling element name...');
    try {
      const nameInput = page.locator('input[type="text"][placeholder="reference-name"]').first();
      await nameInput.click({ timeout: 3000 });
      await nameInput.fill(normalized, { timeout: 3000 });
      this.log(`Element name set to "${normalized}"`);
    } catch (e) {
      // Fallback: any text input in the form area
      try {
        const fallbackInput = page.locator('input[type="text"]').first();
        await fallbackInput.click({ timeout: 3000 });
        await fallbackInput.fill(normalized, { timeout: 3000 });
        this.log(`Element name set via fallback input`);
      } catch (e2) {
        throw new Error(`Could not fill element name: ${e2.message}`);
      }
    }
    await page.waitForTimeout(1500); // Wait after name fill

    // ── Step 5: Set category via combobox ──
    this.log(`Step 5: Setting category to "${uiCategory}"...`);
    if (uiCategory !== 'Auto') {
      try {
        // Click the combobox to open dropdown
        const combobox = page.locator('[role="combobox"]').first();
        await combobox.click({ timeout: 3000 });
        await page.waitForTimeout(1000); // Wait for dropdown to open

        // Click the matching option
        const option = page.locator(`[role="option"]:has-text("${uiCategory}")`).first();
        await option.click({ timeout: 3000 });
        this.log(`Category set to "${uiCategory}"`);
        await page.waitForTimeout(1000); // Wait after category set
      } catch (e) {
        this.log(`Warn: couldn't set category to "${uiCategory}" — ${e.message.split('\n')[0]}`);
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(500);
      }
    }

    // ── Step 6: Fill description (expand Advanced settings first) ──
    if (description) {
      this.log('Step 6: Expanding Advanced settings and filling description...');
      try {
        // Click "Advanced settings" to expand
        await page.evaluate(() => {
          const btns = document.querySelectorAll('button');
          for (const b of btns) {
            if (b.textContent?.trim().includes('Advanced settings') && b.getBoundingClientRect().width > 0) {
              b.click();
              return true;
            }
          }
          return false;
        });
        await page.waitForTimeout(1000); // Wait for section to expand

        // Fill description textarea
        const textarea = page.locator('textarea').first();
        await textarea.fill(description.slice(0, 500), { timeout: 3000 });
        this.log('Description filled');
        await page.waitForTimeout(1000); // Wait after description
      } catch (e) {
        this.log(`Warn: couldn't fill description — ${e.message.split('\n')[0]}`);
      }
    }

    // ── Step 7: Wait for Save button to become enabled, then click ──
    // Save stays disabled until images are fully processed by Higgsfield.
    // Poll for up to ~45s (15 attempts × 3s) since image processing can be slow.
    let saveClicked = false;
    const MAX_SAVE_ATTEMPTS = 15;
    const SAVE_POLL_INTERVAL = 3000;

    for (let attempt = 0; attempt < MAX_SAVE_ATTEMPTS && !saveClicked; attempt++) {
      try {
        const saveState = await page.evaluate(() => {
          const btns = document.querySelectorAll('button');
          for (const b of btns) {
            const text = b.textContent?.trim();
            if (text === 'Save' && b.getBoundingClientRect().width > 0) {
              const isDisabled = b.disabled ||
                b.getAttribute('aria-disabled') === 'true' ||
                b.classList.contains('disabled') ||
                getComputedStyle(b).opacity < 0.6 ||
                getComputedStyle(b).pointerEvents === 'none';
              if (isDisabled) return 'disabled';
              b.click();
              return 'clicked';
            }
          }
          return 'not-found';
        });

        if (saveState === 'clicked') {
          saveClicked = true;
          this.log('Save button clicked');
        } else {
          this.log(`Save button ${saveState} (attempt ${attempt + 1}/${MAX_SAVE_ATTEMPTS}) — waiting ${SAVE_POLL_INTERVAL / 1000}s...`);
          await page.waitForTimeout(SAVE_POLL_INTERVAL);
        }
      } catch (e) {
        this.log(`Save button check failed: ${e.message.split('\n')[0]}`);
        await page.waitForTimeout(SAVE_POLL_INTERVAL);
      }
    }

    if (!saveClicked) {
      // Check WHY Save is disabled — are images missing?
      const diagnosis = await page.evaluate(() => {
        const formContainer = document.querySelector('[data-element-form="true"]') || document.body;
        const imgs = formContainer.querySelectorAll('img, video');
        let previewCount = 0;
        for (const el of imgs) {
          const r = el.getBoundingClientRect();
          if (r.width > 20 && r.height > 20) previewCount++;
        }
        const hasUploadText = formContainer.innerText?.includes('Upload images');
        const saveBtn = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Save');
        return {
          previewCount,
          hasUploadText,
          saveDisabled: saveBtn ? saveBtn.disabled : 'not-found',
          saveCursor: saveBtn ? getComputedStyle(saveBtn).cursor : null,
        };
      }).catch(() => ({}));
      this.log(`Save diagnosis: previews=${diagnosis.previewCount}, uploadText=${diagnosis.hasUploadText}, disabled=${diagnosis.saveDisabled}, cursor=${diagnosis.saveCursor}`);

      // Last resort: force-click
      try {
        const saveBtn = page.getByRole('button', { name: 'Save', exact: true }).first();
        await saveBtn.click({ force: true, timeout: 5000 });
        saveClicked = true;
        this.log('Save button force-clicked via role selector');
      } catch (e) {
        throw new Error(`"Save" button could not be clicked after ${MAX_SAVE_ATTEMPTS} attempts: ${e.message}`);
      }
    }

    // Wait for the element to be processed by Higgsfield
    await page.waitForTimeout(4000);

    // ── Step 8: Check for error messages / form still open ──
    // If Save failed (validation error, server error), the form may still
    // be visible with an error toast or the form fields still populated.
    const checkFormOpen = async () => {
      return page.evaluate(() => {
        const nameInput = document.querySelector('input[placeholder="reference-name"]');
        if (nameInput && nameInput.getBoundingClientRect().width > 0) return 'form-still-open';
        // Check for "Upload images" text which means form is still showing
        const allText = document.body.innerText || '';
        if (allText.includes('Upload images') && allText.includes('Save')) return 'form-still-open';
        return false;
      }).catch(() => false);
    };

    let formStillOpen = await checkFormOpen();

    if (formStillOpen === 'form-still-open') {
      this.log('Warn: creation form still open after Save — waiting 5s then retrying Save click');
      await page.waitForTimeout(5000);

      // Retry Save click
      try {
        await page.evaluate(() => {
          const btns = document.querySelectorAll('button');
          for (const b of btns) {
            if (b.textContent?.trim() === 'Save' && b.getBoundingClientRect().width > 0 && !b.disabled) {
              b.click();
              return true;
            }
          }
          return false;
        });
        this.log('Save button re-clicked');
        await page.waitForTimeout(5000);
      } catch (_) {}

      // Re-check if form closed
      formStillOpen = await checkFormOpen();
    }

    // ── Step 9: If form still open, CLOSE IT before throwing ──
    // This is critical — if we leave the form open, the next element creation
    // will fail because "Create Element" button is hidden behind the form.
    if (formStillOpen === 'form-still-open') {
      this.log('Form still open after retries — closing form before continuing');
      await this._closeCreationForm(page);
      throw new Error(`Element @${normalized} creation failed — form still open after Save retries`);
    }

    // Wait for element to be processed
    await page.waitForTimeout(3000);

    this.invalidateCache();
    const verified = await this.elementExists(normalized);
    if (verified) {
      this.log(`Verified: @${normalized} exists in elements panel`);
    } else {
      this.log(`Warn: @${normalized} not found by scraper — but Save succeeded, trusting creation`);
    }

    this.log(`Created ${uiCategory.toLowerCase()} element @${normalized}`);
    return { created: true, name: normalized };
  }

  /**
   * Close the element creation form if it's still open.
   * Tries Cancel button, X button, Escape key, clicking outside.
   */
  async _closeCreationForm(page) {
    // The creation form replaces the right panel content. It has NO Cancel
    // or Close button. To close it, we re-click the "Elements" tab which
    // resets the right panel back to the "Share elements" + "Create Element" view.
    //
    // Strategies in order:
    //   1. Click "Elements" tab (top center) to reset the panel
    //   2. Click "Generations" tab to switch away entirely
    //   3. Press Escape + click outside as fallback
    //   4. Navigate away from the page

    // Strategy 1: Re-click Elements tab
    let closed = await page.evaluate(() => {
      const btns = document.querySelectorAll('button');
      // First try "Generations" to fully exit
      for (const b of btns) {
        const text = b.textContent?.trim();
        const r = b.getBoundingClientRect();
        if (text === 'Generations' && r.y < window.innerHeight * 0.15 && r.width > 0) {
          b.click();
          return 'Generations tab';
        }
      }
      return false;
    }).catch(() => false);

    if (closed) {
      this.log(`Closed form via: ${closed}`);
      await page.waitForTimeout(2000);

      // Re-open Elements tab to get back to element list
      await page.evaluate(() => {
        const btns = document.querySelectorAll('button');
        for (const b of btns) {
          const text = b.textContent?.trim();
          const r = b.getBoundingClientRect();
          if (text === 'Elements' && r.y < window.innerHeight * 0.15 && r.width > 0) {
            b.click();
            return true;
          }
        }
        return false;
      }).catch(() => false);
      await page.waitForTimeout(2000);
    } else {
      // Fallback: press Escape, click left panel area
      await page.keyboard.press('Escape');
      await page.waitForTimeout(1000);

      // Click the left panel (element list area) to deselect
      await page.mouse.click(200, 300);
      await page.waitForTimeout(1000);
      this.log('Pressed Escape + clicked left panel');
    }

    // Verify the form is closed
    const stillOpen = await page.evaluate(() => {
      const nameInput = document.querySelector('input[placeholder="reference-name"]');
      return nameInput && nameInput.getBoundingClientRect().width > 0;
    }).catch(() => false);

    if (stillOpen) {
      this.log('Form still open after close attempt — navigating to reset');
      // Last resort: reload the page
      await page.evaluate(() => {
        const btns = document.querySelectorAll('button');
        for (const b of btns) {
          if (b.textContent?.trim() === 'Elements' && b.getBoundingClientRect().y < window.innerHeight * 0.2) {
            b.click();
            return;
          }
        }
      }).catch(() => {});
      await page.waitForTimeout(2000);
    }
  }

  /**
   * Create a character element. Uses portrait + grid as reference images.
   */
  async createCharacterElement({ name, portraitPath, gridPath, description }) {
    if (!portraitPath) throw new Error('createCharacterElement: portraitPath required');
    const imagePaths = [portraitPath];
    if (gridPath) imagePaths.push(gridPath);
    return this._createElement({ name, imagePaths, description, category: 'Character' });
  }

  /**
   * @deprecated Locations are NOT Higgsfield elements — they are reference images
   * attached via the + button at scene-gen time. This method is retained for
   * potential future use but is NOT called from the orchestrator pipeline.
   * See orchestrator.js Phase 3 comment block for full rationale.
   */
  async createLocationElement({ name, locationImagePath, description }) {
    if (!locationImagePath) throw new Error('createLocationElement: locationImagePath required');
    return this._createElement({
      name,
      imagePaths: [locationImagePath],
      description,
      category: 'Location',
    });
  }

  /**
   * Create a prop element. Uses one or more reference images of the object.
   */
  async createPropElement({ name, propImagePaths, description }) {
    if (!propImagePaths || propImagePaths.length === 0) {
      throw new Error('createPropElement: propImagePaths required');
    }
    return this._createElement({
      name,
      imagePaths: propImagePaths,
      description,
      category: 'Prop',
    });
  }

  /**
   * Build a manual-creation checklist when automation fails.
   */
  static buildManualChecklist(pending) {
    const lines = [
      '',
      '='.repeat(63),
      '  ELEMENT AUTOMATION FAILED — MANUAL CREATION REQUIRED',
      '='.repeat(63),
      '',
      'Elements that need creation in Higgsfield:',
    ];
    for (const p of pending) {
      lines.push(`  - @${p.name}  (upload portrait + grid, set category "Character")`);
      if (p.description) lines.push(`      desc: ${p.description.slice(0, 80)}${p.description.length > 80 ? '...' : ''}`);
      if (p.portraitPath) lines.push(`      portrait: ${p.portraitPath}`);
      if (p.gridPath) lines.push(`      grid:     ${p.gridPath}`);
    }
    lines.push('');
    lines.push('Steps (per element):');
    lines.push('  1. Open Cinema Studio 3.5 (top nav)');
    lines.push('  2. Select your project in the left sidebar');
    lines.push('  3. Click the @ button in the bottom toolbar');
    lines.push('  4. Click "Create new" card (+ icon in the elements grid)');
    lines.push('  5. Upload images (portrait + grid for characters)');
    lines.push('  6. Enter the element name (exactly as listed above, without @)');
    lines.push('  7. Set Category dropdown to "Character" (or Location/Prop)');
    lines.push('  8. Expand "Advanced settings" to add a description (optional)');
    lines.push('  9. Click "Save"');
    lines.push('');
    lines.push('When all elements exist, click "Elements Ready — Continue" to proceed.');
    lines.push('='.repeat(63));
    return lines.join('\n');
  }
}

module.exports = { HiggsfieldElements };
