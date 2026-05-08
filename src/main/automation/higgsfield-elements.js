/**
 * Higgsfield Elements — @ Toolbar Button Modal Overlay Automation
 *
 * As of May 2026, Higgsfield removed the Elements tab/panel from Cinema Studio.
 * The @ toolbar button in the bottom toolbar is now the SOLE entry point for
 * element creation and browsing.
 *
 * ── UI Flow (May 2026) ──
 *
 * 1. @ toolbar button (small no-text SVG button in bottom toolbar, after the
 *    "1x1" grid button, at y > vh * 0.65) opens a modal overlay.
 *
 * 2. Elements modal overlay contains:
 *    - "Elements" heading at top
 *    - Search bar
 *    - X close button (top-right corner)
 *    - Category sidebar: All / Pinned / Characters / Locations / Props
 *    - "Create new" card (first position, has + icon)
 *    - Scrollable grid of existing element cards (thumbnail + name label)
 *
 * 3. Clicking "Create new" opens a dialog form inside the modal:
 *    - Back arrow (<) — CRITICAL: closes ENTIRE modal, does NOT go back to list
 *    - "New element" heading
 *    - Upload images zone (hidden input[type="file"], 1x1px, multiple, accepts
 *      png/jpeg/mp4)
 *    - Element name input (placeholder="reference-name")
 *    - Category combobox (Auto/Character/Location/Prop)
 *    - Advanced settings toggle → Description textarea + Workspace combobox
 *    - Cancel + Save buttons
 *
 * 4. After Save, the back arrow closes the entire modal. To verify element
 *    creation, must re-open the @ modal and check the elements grid.
 *
 * ── Key Differences from Old Elements Tab ──
 *
 * - No more "Elements" / "Generations" top tabs — they don't exist
 * - Entry point is @ toolbar button (isTrusted click required — Radix UI)
 * - Elements live in a modal overlay, not a persistent panel
 * - "Create new" is a card in the grid, not a "Create Element" button
 * - Form has Cancel + Save buttons (old form had no Cancel)
 * - Back arrow from form closes entire modal (not back-to-list)
 * - Verification after save requires re-opening the @ modal
 *
 * ── isTrusted Requirement ──
 *
 * Cinema Studio uses Radix UI components that check event.isTrusted.
 * All toolbar button clicks MUST use page.mouse.click(x, y) which goes
 * through CDP Input.dispatchMouseEvent, producing isTrusted: true events.
 * el.click() and dispatchEvent() produce isTrusted: false and are silently
 * ignored by Radix handlers.
 */

'use strict';

class HiggsfieldElements {
  /**
   * @param {{ automation: object, logger?: Function, cinemaStudio?: object }} opts
   *   automation — HiggsFieldAutomation instance (provides .page, recreateContext(), etc.)
   *   logger — optional logging function
   *   cinemaStudio — optional CinemaStudioAutomation instance
   */
  constructor({ automation, logger, cinemaStudio }) {
    this.automation = automation;
    this.log = logger || ((msg) => console.log(`[ELEMENTS] ${msg}`));
    this.cinemaStudio = cinemaStudio || null;
    this._cache = null;
  }

  // ───────────────────────────────────────────────────────────────────
  //  Name normalization + caching
  // ───────────────────────────────────────────────────────────────────

  /** Normalize an element name for comparison: lowercase, trim, strip leading @. */
  _normalizeName(name) {
    return (name || '').toLowerCase().trim().replace(/^@+/, '');
  }

  /** Clear the cached element list so the next call re-scrapes. */
  invalidateCache() {
    this._cache = null;
  }

  /**
   * Check if an element with the given name exists.
   * Uses cache if available; otherwise scrapes via listExistingElements().
   * @param {string} name
   * @returns {Promise<boolean>}
   */
  async elementExists(name) {
    const normalized = this._normalizeName(name);
    if (!this._cache) {
      this._cache = await this.listExistingElements();
    }
    return this._cache.some(el => this._normalizeName(el.name) === normalized);
  }

  // ───────────────────────────────────────────────────────────────────
  //  @ Toolbar Button — Modal Open / Close
  // ───────────────────────────────────────────────────────────────────

  /**
   * Open the elements modal by clicking the @ toolbar button.
   *
   * The @ button is a small no-text SVG button in the bottom toolbar,
   * positioned after the "1x1" grid button. It is at y > vh * 0.65.
   * Must use page.mouse.click() for isTrusted events (Radix UI).
   *
   * Confirmation signal: "Elements" heading visible in the modal overlay.
   *
   * @returns {Promise<void>}
   * @throws if @ button not found or modal doesn't open
   */
  async _openElementsModal() {
    const page = this.automation.page;
    this.log('Opening elements modal via @ toolbar button...');

    // Find the @ button: no-text SVG button in bottom toolbar (y > 65% vh)
    const btnInfo = await page.evaluate(() => {
      const vh = window.innerHeight;
      const yThreshold = vh * 0.65;
      const candidates = [];

      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        const rect = btn.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) continue;
        if (rect.y < yThreshold) continue; // must be in bottom toolbar

        const text = btn.textContent?.trim() || '';
        const hasSvg = !!btn.querySelector('svg');

        // @ button is a small no-text button with SVG, width 20-60px
        if (!text && hasSvg && rect.width >= 15 && rect.width <= 80) {
          candidates.push({
            cx: rect.x + rect.width / 2,
            cy: rect.y + rect.height / 2,
            w: rect.width,
            x: rect.x,
            y: rect.y,
          });
        }
      }

      if (candidates.length === 0) return null;

      // The @ button is positioned after the 1x1 grid button.
      // Among no-text SVG buttons in the toolbar, pick the one with the
      // highest x position that isn't the GENERATE button area (which is
      // typically the rightmost and much wider).
      // Sort by x position descending, pick the best match.
      candidates.sort((a, b) => b.x - a.x);

      // Filter out candidates that are too wide (GENERATE area) or too far right
      const filtered = candidates.filter(c => c.w <= 60);
      if (filtered.length === 0) return candidates[0]; // fallback

      // The @ button should be the rightmost small no-text SVG button
      // before the camera/model selector and GENERATE button
      return filtered[0];
    });

    if (!btnInfo) {
      throw new Error('Could not find @ toolbar button in bottom toolbar');
    }

    this.log(`Found @ button at (${Math.round(btnInfo.cx)}, ${Math.round(btnInfo.cy)}), w=${Math.round(btnInfo.w)}`);

    // Click with real mouse (isTrusted)
    await page.mouse.click(btnInfo.cx, btnInfo.cy);
    await page.waitForTimeout(1500);

    // Verify modal opened: look for "Elements" heading
    const modalOpened = await this._isElementsModalOpen(page);
    if (!modalOpened) {
      // Retry click once
      this.log('Modal not detected after first click — retrying...');
      await page.mouse.click(btnInfo.cx, btnInfo.cy);
      await page.waitForTimeout(2000);

      const retryOpened = await this._isElementsModalOpen(page);
      if (!retryOpened) {
        throw new Error('Elements modal did not open after clicking @ toolbar button');
      }
    }

    this.log('Elements modal opened');
  }

  /**
   * Check if the elements modal overlay is currently open.
   * Looks for "Elements" heading and modal-like overlay structure.
   */
  async _isElementsModalOpen(page) {
    return page.evaluate(() => {
      // Look for "Elements" heading in a modal/overlay context
      const allText = document.body.innerText || '';
      const hasElementsHeading = allText.includes('Elements');
      const hasCreateNew = allText.includes('Create new');

      // Check for modal/dialog overlay
      const dialogs = document.querySelectorAll('[role="dialog"], [data-state="open"]');
      const overlays = document.querySelectorAll('[class*="overlay"], [class*="modal"]');

      // Also check for the search bar and category sidebar which are unique to the modal
      const hasSearch = !!document.querySelector('input[type="search"], input[placeholder*="earch"]');

      return (hasElementsHeading && hasCreateNew) ||
             (dialogs.length > 0 && hasElementsHeading) ||
             (overlays.length > 0 && hasElementsHeading) ||
             (hasSearch && hasCreateNew);
    }).catch(() => false);
  }

  /**
   * Close the elements modal overlay.
   * Strategy order: X close button → Cancel button → Escape key.
   */
  async _closeElementsModal() {
    const page = this.automation.page;
    this.log('Closing elements modal...');

    // Strategy 1: Click X close button (top-right of modal)
    let closed = await page.evaluate(() => {
      // Find X / close buttons in the modal area
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        const rect = btn.getBoundingClientRect();
        if (rect.width < 1) continue;

        const text = btn.textContent?.trim() || '';
        const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();

        // X close button: small button with × or x text, or aria-label close/dismiss
        const isClose = text === '×' || text === '✕' || text === 'x' || text === 'X' ||
          ariaLabel.includes('close') || ariaLabel.includes('dismiss');

        if (isClose && rect.width <= 60) {
          btn.click();
          return 'x-button';
        }
      }
      return false;
    }).catch(() => false);

    if (closed) {
      this.log(`Closed modal via: ${closed}`);
      await page.waitForTimeout(1000);
      return;
    }

    // Strategy 2: Press Escape
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1000);

    const stillOpen = await this._isElementsModalOpen(page);
    if (!stillOpen) {
      this.log('Closed modal via Escape');
      return;
    }

    // Strategy 3: Click outside the modal overlay
    await page.mouse.click(50, 50);
    await page.waitForTimeout(1000);
    this.log('Attempted to close modal by clicking outside');
  }

  // ───────────────────────────────────────────────────────────────────
  //  Dismiss Overlays (ads, promos) — preserved from original
  // ───────────────────────────────────────────────────────────────────

  /**
   * Dismiss any promo overlays, modals, or popups that might interfere.
   */
  async _dismissOverlays() {
    const page = this.automation.page;
    try {
      await page.evaluate(() => {
        const btns = document.querySelectorAll('button');
        for (const b of btns) {
          const text = b.textContent?.trim() || '';
          const ariaLabel = (b.getAttribute('aria-label') || '').toLowerCase();
          if ((text === '×' || text === '✕' || ariaLabel.includes('close') || ariaLabel.includes('dismiss')) &&
              b.getBoundingClientRect().width > 0 && b.getBoundingClientRect().width <= 50) {
            // Only click small close buttons (not the modal close we might need)
            const rect = b.getBoundingClientRect();
            if (rect.y < window.innerHeight * 0.3) {
              b.click();
            }
          }
        }
      });
    } catch (_) {}
    await page.waitForTimeout(500);
  }

  // ───────────────────────────────────────────────────────────────────
  //  Set Project Name — preserved from original
  // ───────────────────────────────────────────────────────────────────

  /**
   * Set the project name in the Cinema Studio sidebar.
   * Called by orchestrator to ensure the correct project is active.
   * @param {string} projectName
   */
  async setProjectName(projectName) {
    // Delegate to cinemaStudio if available; otherwise no-op.
    // The orchestrator manages project creation/selection via
    // CinemaStudioAutomation.ensureProject() before element creation.
    if (this.cinemaStudio && typeof this.cinemaStudio.setProjectName === 'function') {
      await this.cinemaStudio.setProjectName(projectName);
    } else {
      this.log(`setProjectName("${projectName}") — no cinemaStudio instance, skipping`);
    }
  }

  // ───────────────────────────────────────────────────────────────────
  //  List Existing Elements (scrape from @ modal grid)
  // ───────────────────────────────────────────────────────────────────

  /**
   * List all existing elements by opening the @ modal and scraping the grid.
   * Returns [{ name, category }]. Caches the result.
   * @returns {Promise<Array<{name: string, category: string}>>}
   */
  async listExistingElements() {
    const page = this.automation.page;

    try {
      await this._openElementsModal();
    } catch (e) {
      this.log(`Could not open elements modal for listing: ${e.message}`);
      return [];
    }

    await page.waitForTimeout(1000);

    // Scrape element cards from the modal grid
    const elements = await page.evaluate(() => {
      const results = [];
      const seen = new Set();

      // Strategy 1: Find cards in the modal grid.
      // Each element card has a thumbnail image and a name label.
      // The "Create new" card has a + icon and "Create new" text — skip it.

      // Look for the modal/overlay container
      const containers = [
        ...document.querySelectorAll('[role="dialog"]'),
        ...document.querySelectorAll('[data-state="open"]'),
        ...document.querySelectorAll('[class*="modal"], [class*="overlay"], [class*="popover"]'),
      ];

      // Also search the body for element-like cards
      const searchContexts = containers.length > 0 ? containers : [document.body];

      for (const container of searchContexts) {
        // Look for elements with name labels — typically small text under thumbnails
        // Each element card is a clickable div/button with an image + text
        const allButtons = container.querySelectorAll('button, [role="button"], div[tabindex]');
        for (const card of allButtons) {
          const text = card.textContent?.trim() || '';
          const rect = card.getBoundingClientRect();
          if (rect.width < 30 || rect.height < 30) continue;

          // Skip the "Create new" card
          if (text.includes('Create new') || text === '+') continue;
          // Skip navigation/utility buttons
          if (['Save', 'Cancel', 'All', 'Pinned', 'Characters', 'Locations', 'Props',
               'Elements', '×', '✕', 'X'].includes(text)) continue;
          // Skip search input
          if (card.tagName === 'INPUT') continue;

          // An element card should have an image (thumbnail) and a short name
          const hasImage = !!card.querySelector('img, video, svg[class*="icon"]');
          const nameLen = text.replace(/\s+/g, ' ').length;

          if (hasImage && nameLen > 0 && nameLen < 80) {
            // Extract just the name — take the last line (name is typically below thumbnail)
            const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
            const name = lines[lines.length - 1] || text;

            const key = name.toLowerCase().trim();
            if (!seen.has(key)) {
              seen.add(key);
              results.push({ name: name.trim(), category: 'unknown' });
            }
          }
        }

        // Strategy 2: Scan for text nodes near images in the grid area
        // Some element cards may not be buttons
        const images = container.querySelectorAll('img');
        for (const img of images) {
          const rect = img.getBoundingClientRect();
          if (rect.width < 30 || rect.height < 30) continue;

          // Look at the parent card for a name label
          let parent = img.parentElement;
          for (let i = 0; i < 4 && parent; i++) {
            const text = parent.textContent?.trim() || '';
            if (text.includes('Create new') || text === '+') break;

            const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
            // Find a line that looks like an element name (short, no common UI words)
            for (const line of lines) {
              if (line.length > 2 && line.length < 60 &&
                  !['Upload images', 'Save', 'Cancel', 'Elements', 'Create new',
                    'All', 'Pinned', 'Characters', 'Locations', 'Props',
                    'Advanced settings', 'Search'].some(skip => line.includes(skip))) {
                const key = line.toLowerCase().trim();
                if (!seen.has(key)) {
                  seen.add(key);
                  results.push({ name: line.trim(), category: 'unknown' });
                }
              }
            }
            parent = parent.parentElement;
          }
        }
      }

      return results;
    }).catch(e => {
      console.error('Element scraping failed:', e);
      return [];
    });

    // Try to determine categories from the sidebar filter
    // Click "Characters" filter to tag character elements, etc.
    // For now, leave as 'unknown' — category is not critical for the pipeline.

    this.log(`Found ${elements.length} existing elements: ${elements.map(e => e.name).join(', ') || '(none)'}`);

    // Close the modal
    await this._closeElementsModal();

    this._cache = elements;
    return elements;
  }

  // ───────────────────────────────────────────────────────────────────
  //  Category Map
  // ───────────────────────────────────────────────────────────────────

  static CATEGORY_MAP = {
    character: 'Character',
    location: 'Location',
    prop: 'Prop',
    auto: 'Auto',
  };

  // ───────────────────────────────────────────────────────────────────
  //  Create Element (core implementation)
  // ───────────────────────────────────────────────────────────────────

  /**
   * Create a new element via the @ toolbar modal.
   *
   * Flow:
   *   1. Open @ modal → click "Create new" card → fill form → Save
   *   2. Re-open @ modal → verify element appears in grid
   *
   * @param {{ name: string, imagePaths: string[], description?: string, category?: string }} opts
   * @returns {Promise<{created: boolean, name: string}>}
   */
  async _createElement({ name, imagePaths, description, category = 'Auto' }) {
    const page = this.automation.page;
    const normalized = this._normalizeName(name);
    const uiCategory = HiggsfieldElements.CATEGORY_MAP[(category || 'auto').toLowerCase()] || 'Auto';

    if (!normalized) throw new Error('Element name is required');
    if (!imagePaths || imagePaths.length === 0) throw new Error('At least one image path required');

    this.log(`Creating element @${normalized} (${uiCategory}) with ${imagePaths.length} image(s)...`);

    // ── Idempotency: check if element already exists ──
    const alreadyExists = await this.elementExists(normalized);
    if (alreadyExists) {
      this.log(`Element @${normalized} already exists — skipping creation`);
      return { created: false, name: normalized };
    }

    // ── Dismiss any lingering overlays ──
    await this._dismissOverlays();

    // ── Step 1: Open the @ modal ──
    this.log('Step 1: Opening elements modal...');
    await this._openElementsModal();
    await page.waitForTimeout(1000);

    // ── Step 2: Click "Create new" card ──
    this.log('Step 2: Clicking "Create new" card...');
    let createNewClicked = false;

    // Strategy A: Find by text content "Create new"
    const createNewInfo = await page.evaluate(() => {
      // Search for "Create new" text in buttons/cards within the modal
      const allClickable = document.querySelectorAll('button, [role="button"], div[tabindex], a');
      for (const el of allClickable) {
        const text = el.textContent?.trim() || '';
        if (text.includes('Create new')) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 20 && rect.height > 20) {
            return { cx: rect.x + rect.width / 2, cy: rect.y + rect.height / 2 };
          }
        }
      }

      // Strategy B: Find the + icon card (first card in grid with + or plus)
      for (const el of allClickable) {
        const text = el.textContent?.trim() || '';
        const rect = el.getBoundingClientRect();
        if (rect.width < 30 || rect.height < 30) continue;
        // Look for a plus icon card (+ symbol or SVG with plus path)
        if (text === '+' || (text === '' && el.querySelector('svg') && rect.width < 120 && rect.height < 120)) {
          return { cx: rect.x + rect.width / 2, cy: rect.y + rect.height / 2 };
        }
      }

      return null;
    });

    if (createNewInfo) {
      await page.mouse.click(createNewInfo.cx, createNewInfo.cy);
      createNewClicked = true;
      this.log('Clicked "Create new" card');
    } else {
      // Fallback: use Playwright locator
      try {
        const createBtn = page.getByText('Create new', { exact: false }).first();
        await createBtn.click({ timeout: 5000 });
        createNewClicked = true;
        this.log('Clicked "Create new" via locator');
      } catch (e) {
        throw new Error(`Could not find "Create new" card in elements modal: ${e.message}`);
      }
    }

    await page.waitForTimeout(2000);

    // ── Verify the form appeared ──
    const formAppeared = await page.evaluate(() => {
      const nameInput = document.querySelector('input[placeholder="reference-name"]');
      if (nameInput && nameInput.getBoundingClientRect().width > 0) return true;
      // Fallback: check for "New element" heading or "Upload images" text
      const text = document.body.innerText || '';
      return text.includes('New element') || (text.includes('Upload images') && text.includes('Save'));
    }).catch(() => false);

    if (!formAppeared) {
      this.log('Form did not appear after clicking "Create new" — waiting longer...');
      await page.waitForTimeout(3000);
      const retryForm = await page.evaluate(() => {
        const nameInput = document.querySelector('input[placeholder="reference-name"]');
        return nameInput && nameInput.getBoundingClientRect().width > 0;
      }).catch(() => false);
      if (!retryForm) {
        // Try to close modal and bail
        await this._closeElementsModal();
        throw new Error('Element creation form did not appear after clicking "Create new"');
      }
    }

    this.log('Element creation form is open');

    // ── Safety check: make sure we're on a NEW form, not editing existing ──
    const formState = await page.evaluate(() => {
      const nameInput = document.querySelector('input[placeholder="reference-name"]');
      const currentValue = nameInput ? nameInput.value : '';
      return { nameValue: currentValue };
    }).catch(() => ({ nameValue: '' }));

    if (formState.nameValue && formState.nameValue.length > 0) {
      this.log(`Warn: form has pre-filled name "${formState.nameValue}" — may be editing. Clearing.`);
      try {
        const nameInput = page.locator('input[placeholder="reference-name"]').first();
        await nameInput.click({ timeout: 3000 });
        await nameInput.fill('', { timeout: 3000 });
      } catch (_) {}
    }

    // ── Step 3: Upload images ──
    this.log(`Step 3: Uploading ${imagePaths.length} image(s)...`);
    try {
      // The file input is hidden (1x1px), accepts image/png, image/jpeg, video/mp4
      const fileInput = await page.$('input[type="file"]');
      if (!fileInput) {
        throw new Error('File input not found in creation form');
      }

      await fileInput.setInputFiles(imagePaths);
      this.log(`setInputFiles completed for ${imagePaths.length} file(s)`);

      // Trigger React onChange via multiple methods
      await page.evaluate(() => {
        const input = document.querySelector('input[type="file"]');
        if (!input) return;

        // Method 1: Standard DOM events
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new Event('input', { bubbles: true }));

        // Method 2: React fiber walk to find onChange handler
        const reactKey = Object.keys(input).find(k =>
          k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
        if (reactKey) {
          let fiber = input[reactKey];
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

        // Method 3: React props key
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
      // Try to close the form before bailing
      await this._closeCreationForm(page);
      throw new Error(`Image upload failed: ${e.message}`);
    }

    // ── Wait for upload to be processed (Save button enabled) ──
    const UPLOAD_POLL_MAX = 25;
    const UPLOAD_POLL_MS = 2000;
    this.log(`Waiting up to ${(UPLOAD_POLL_MAX * UPLOAD_POLL_MS) / 1000}s for Save to enable...`);

    let uploadProcessed = false;
    for (let poll = 0; poll < UPLOAD_POLL_MAX; poll++) {
      await page.waitForTimeout(UPLOAD_POLL_MS);

      const state = await page.evaluate(() => {
        const saveBtn = [...document.querySelectorAll('button')].find(b =>
          b.textContent?.trim() === 'Save');
        if (!saveBtn) return { saveState: 'not-found' };

        const isDisabled = saveBtn.disabled ||
          saveBtn.getAttribute('aria-disabled') === 'true' ||
          getComputedStyle(saveBtn).opacity < 0.6 ||
          getComputedStyle(saveBtn).pointerEvents === 'none';

        const fileInput = document.querySelector('input[type="file"]');
        let uploadZoneHasText = false;
        if (fileInput) {
          let container = fileInput;
          for (let i = 0; i < 4; i++) {
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

    await page.waitForTimeout(2000);

    // ── Step 4: Fill element name ──
    this.log('Step 4: Filling element name...');
    try {
      const nameInput = page.locator('input[type="text"][placeholder="reference-name"]').first();
      await nameInput.click({ timeout: 3000 });
      await nameInput.fill(normalized, { timeout: 3000 });
      this.log(`Element name set to "${normalized}"`);
    } catch (e) {
      try {
        const fallbackInput = page.locator('input[type="text"]').first();
        await fallbackInput.click({ timeout: 3000 });
        await fallbackInput.fill(normalized, { timeout: 3000 });
        this.log('Element name set via fallback input');
      } catch (e2) {
        await this._closeCreationForm(page);
        throw new Error(`Could not fill element name: ${e2.message}`);
      }
    }
    await page.waitForTimeout(1500);

    // ── Step 5: Set category via combobox ──
    this.log(`Step 5: Setting category to "${uiCategory}"...`);
    if (uiCategory !== 'Auto') {
      try {
        const combobox = page.locator('[role="combobox"]').first();
        await combobox.click({ timeout: 3000 });
        await page.waitForTimeout(1000);

        const option = page.locator(`[role="option"]:has-text("${uiCategory}")`).first();
        await option.click({ timeout: 3000 });
        this.log(`Category set to "${uiCategory}"`);
        await page.waitForTimeout(1000);
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
        await page.waitForTimeout(1000);

        const textarea = page.locator('textarea').first();
        await textarea.fill(description.slice(0, 500), { timeout: 3000 });
        this.log('Description filled');
        await page.waitForTimeout(1000);
      } catch (e) {
        this.log(`Warn: couldn't fill description — ${e.message.split('\n')[0]}`);
      }
    }

    // ── Step 7: Click Save ──
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
      const diagnosis = await page.evaluate(() => {
        const imgs = document.querySelectorAll('img, video');
        let previewCount = 0;
        for (const el of imgs) {
          const r = el.getBoundingClientRect();
          if (r.width > 20 && r.height > 20) previewCount++;
        }
        const hasUploadText = (document.body.innerText || '').includes('Upload images');
        const saveBtn = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Save');
        return {
          previewCount,
          hasUploadText,
          saveDisabled: saveBtn ? saveBtn.disabled : 'not-found',
          saveCursor: saveBtn ? getComputedStyle(saveBtn).cursor : null,
        };
      }).catch(() => ({}));
      this.log(`Save diagnosis: previews=${diagnosis.previewCount}, uploadText=${diagnosis.hasUploadText}, disabled=${diagnosis.saveDisabled}`);

      // Last resort: force-click
      try {
        const saveBtn = page.getByRole('button', { name: 'Save', exact: true }).first();
        await saveBtn.click({ force: true, timeout: 5000 });
        saveClicked = true;
        this.log('Save button force-clicked via role selector');
      } catch (e) {
        await this._closeCreationForm(page);
        throw new Error(`"Save" button could not be clicked after ${MAX_SAVE_ATTEMPTS} attempts: ${e.message}`);
      }
    }

    // Wait for element to be processed
    await page.waitForTimeout(4000);

    // ── Step 8: Check if form is still open (save may have failed) ──
    const checkFormOpen = async () => {
      return page.evaluate(() => {
        const nameInput = document.querySelector('input[placeholder="reference-name"]');
        if (nameInput && nameInput.getBoundingClientRect().width > 0) return 'form-still-open';
        const allText = document.body.innerText || '';
        if (allText.includes('Upload images') && allText.includes('Save') && allText.includes('Cancel')) return 'form-still-open';
        return false;
      }).catch(() => false);
    };

    let formStillOpen = await checkFormOpen();

    if (formStillOpen === 'form-still-open') {
      this.log('Warn: creation form still open after Save — waiting 5s then retrying Save click');
      await page.waitForTimeout(5000);

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

      formStillOpen = await checkFormOpen();
    }

    // ── Step 9: If form still open, close it before throwing ──
    if (formStillOpen === 'form-still-open') {
      this.log('Form still open after retries — closing form before continuing');
      await this._closeCreationForm(page);
      throw new Error(`Element @${normalized} creation failed — form still open after Save retries`);
    }

    await page.waitForTimeout(3000);

    // ── Step 10: Verify element was created ──
    // CRITICAL: After Save, the back button closes the entire modal.
    // We must re-open the @ modal to verify the element exists.
    this.invalidateCache();
    const verified = await this.elementExists(normalized);
    if (verified) {
      this.log(`Verified: @${normalized} exists in elements modal`);
    } else {
      this.log(`Warn: @${normalized} not found by scraper — but Save succeeded, trusting creation`);
    }

    this.log(`Created ${uiCategory.toLowerCase()} element @${normalized}`);
    return { created: true, name: normalized };
  }

  /**
   * Close the element creation form if it's still open.
   * In the new modal UI, the form is a dialog inside the modal overlay.
   *
   * Strategy order:
   *   1. Cancel button (available in new UI)
   *   2. X close button on modal
   *   3. Escape key
   *   4. Click outside modal
   */
  async _closeCreationForm(page) {
    // Strategy 1: Click Cancel button
    let closed = await page.evaluate(() => {
      const btns = document.querySelectorAll('button');
      for (const b of btns) {
        const text = b.textContent?.trim();
        if (text === 'Cancel' && b.getBoundingClientRect().width > 0) {
          b.click();
          return 'Cancel';
        }
      }
      return false;
    }).catch(() => false);

    if (closed) {
      this.log(`Closed form via: ${closed}`);
      await page.waitForTimeout(2000);
      // Cancel may return to the elements list inside the modal, or close the modal.
      // Either way, close the modal if it's still open.
      const modalOpen = await this._isElementsModalOpen(page);
      if (modalOpen) {
        await this._closeElementsModal();
      }
      return;
    }

    // Strategy 2: X close button
    closed = await page.evaluate(() => {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        const text = btn.textContent?.trim() || '';
        const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
        const isClose = text === '×' || text === '✕' || text === 'x' ||
          ariaLabel.includes('close') || ariaLabel.includes('dismiss');
        if (isClose && btn.getBoundingClientRect().width > 0 && btn.getBoundingClientRect().width <= 60) {
          btn.click();
          return 'X button';
        }
      }
      return false;
    }).catch(() => false);

    if (closed) {
      this.log(`Closed form via: ${closed}`);
      await page.waitForTimeout(2000);
      return;
    }

    // Strategy 3: Escape
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1500);
    this.log('Pressed Escape to close form');

    // Verify closure
    const stillOpen = await page.evaluate(() => {
      const nameInput = document.querySelector('input[placeholder="reference-name"]');
      return nameInput && nameInput.getBoundingClientRect().width > 0;
    }).catch(() => false);

    if (stillOpen) {
      // Strategy 4: click outside
      await page.mouse.click(50, 50);
      await page.waitForTimeout(1500);
      this.log('Clicked outside to close form');
    }
  }

  // ───────────────────────────────────────────────────────────────────
  //  Public wrapper methods — preserved signatures exactly
  // ───────────────────────────────────────────────────────────────────

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
    lines.push('  3. Click the @ button in the bottom toolbar (next to 1x1)');
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
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       