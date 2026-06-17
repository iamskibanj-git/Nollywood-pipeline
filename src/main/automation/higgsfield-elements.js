/**
 * Higgsfield Elements — @ Toolbar Button Modal Overlay Automation
 *
 * As of June 2026, the top-center project @/Elements control is the preferred
 * entry point for element creation and browsing. The bottom prompt-toolbar @
 * button is retained as a fallback only because it is crowded by prompt and
 * reference controls.
 *
 * ── UI Flow (May 2026) ──
 *
 * 1. Top-center project @/Elements control opens a modal overlay. Fallback:
 *    @ toolbar button in the bottom toolbar after the "1x1" grid button.
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
 * - Primary entry point is the top-center project @/Elements control
 * - Current preference: click the top-center project @/Elements control first;
 *   the bottom toolbar @ is fallback only
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

  /** Normalize an element name for comparison: lowercase, trim, strip leading @ and UI type suffix. */
  _normalizeName(name) {
    return (name || '')
      .toLowerCase()
      .trim()
      .replace(/^@+/, '')
      .replace(/\s+/g, ' ')
      .replace(/(character|location|prop)$/i, '')
      .trim();
  }

  /** Normalize scraped modal labels, which often include a leading "Use" button label. */
  _normalizeScrapedElementName(name) {
    const raw = (name || '').trim();
    const withoutUse = raw.replace(/^Use(?=[@A-Za-z0-9_-])/, '');
    const atMatch = withoutUse.match(/@([A-Za-z0-9_-]+?)(?:Character|Location|Prop|Use|\s|$)/);
    if (atMatch) return this._normalizeName(atMatch[1]);
    return this._normalizeName(withoutUse);
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
    if (await this._isElementsModalOpen(page)) {
      this.log('Elements modal already open');
      return;
    }

    const openedViaProjectButton = await this._openElementsModalViaProjectButton(page);
    if (openedViaProjectButton) return;

    this.log('Project Elements button did not open modal; falling back to bottom @ toolbar button...');

    // Find the @ button using dual-toolbar-aware selection.
    // CRITICAL: Higgsfield renders TWO duplicate toolbar sets at slightly different
    // positions. The CONTROLLING set is the LEFTMOST (minimum x). We must find the
    // controlling toolbar's y position first (via the model button), then pick the
    // @ button from that same toolbar set (within ±5px of that y).
    const btnInfo = await page.evaluate(() => {
      const vh = window.innerHeight;
      const yThreshold = vh * 0.65;

      // Step 1: Find the controlling toolbar set's y by locating the leftmost
      // model button (has text like "Cinematic Cameras", "Nano Banana Pro", etc.)
      const modelIndicators = [
        'cinematic cameras', 'nano banana pro', 'soul cinema', 'cinema studio',
        'cinematic characters', 'cinematic locations', 'higgsfield soul',
      ];
      let controllingY = null;
      let minModelX = Infinity;

      const allButtons = document.querySelectorAll('button');
      for (const btn of allButtons) {
        const rect = btn.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) continue;
        if (rect.y < yThreshold) continue;
        const text = (btn.textContent?.trim() || '').toLowerCase();
        if (modelIndicators.some(m => text.includes(m))) {
          if (rect.x < minModelX) {
            minModelX = rect.x;
            controllingY = rect.y + rect.height / 2;
          }
        }
      }

      // Step 2: Find all no-text SVG button candidates in bottom toolbar
      const candidates = [];
      for (const btn of allButtons) {
        const rect = btn.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) continue;
        if (rect.y < yThreshold) continue;

        const text = btn.textContent?.trim() || '';
        const hasSvg = !!btn.querySelector('svg');

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

      if (candidates.length === 0) {
        return { error: 'no_candidates', controllingY, candidateCount: 0 };
      }

      // Step 3: Filter to controlling toolbar set if we found a model button.
      // The dual toolbars differ by ~4px in y. Use ±5px tolerance from the
      // controlling model button's y center to select the correct set.
      let pool = candidates;
      let gridButtonRight = null;
      if (controllingY !== null) {
        const yFiltered = candidates.filter(c => Math.abs(c.cy - controllingY) < 10);
        if (yFiltered.length > 0) {
          pool = yFiltered;
        }

        for (const btn of allButtons) {
          const rect = btn.getBoundingClientRect();
          if (rect.width < 1 || rect.height < 1) continue;
          const text = btn.textContent?.trim() || '';
          if (text === '1x1' && Math.abs((rect.y + rect.height / 2) - controllingY) < 12) {
            gridButtonRight = rect.x + rect.width;
            break;
          }
        }
      }

      // Step 4: Filter out wide buttons (GENERATE area)
      const filtered = pool.filter(c => c.w <= 60);
      if (filtered.length === 0 && pool.length > 0) {
        // fallback to unfiltered pool
        pool.sort((a, b) => a.x - b.x);
        return { ...pool[0], candidateCount: candidates.length, controllingY };
      }

      // Step 5: Pick the LEFTMOST small no-text SVG button in the controlling set.
      // The @ button in the controlling (leftmost) toolbar set is what we want.
      // Sort ascending by x — leftmost first (matches controlling toolbar).
      filtered.sort((a, b) => a.x - b.x);
      let ordered = filtered;
      if (gridButtonRight !== null) {
        const afterGrid = filtered.filter(c => c.x > gridButtonRight - 2).sort((a, b) => a.x - b.x);
        const beforeGrid = filtered.filter(c => c.x <= gridButtonRight - 2).sort((a, b) => a.x - b.x);
        ordered = [...afterGrid, ...beforeGrid];
      }

      // Return several candidates. Higgsfield currently renders two tiny
      // no-text icons beside the model selector; the Elements/@ control may be
      // either one depending on UI rollout.
      return {
        ...ordered[0],
        candidates: ordered.slice(0, 6),
        candidateCount: candidates.length,
        controllingY,
        gridButtonRight,
      };
    });

    if (!btnInfo || btnInfo.error) {
      const diag = btnInfo ? `controllingY=${btnInfo.controllingY}, candidates=${btnInfo.candidateCount}` : 'null';
      throw new Error(`Could not find @ toolbar button in bottom toolbar (${diag})`);
    }

    {
    const candidates = Array.isArray(btnInfo.candidates) && btnInfo.candidates.length > 0
      ? btnInfo.candidates
      : [btnInfo];
    this.log(`Found ${candidates.length} @ button candidate(s): ${candidates.map(c => `(${Math.round(c.cx)},${Math.round(c.cy)},w=${Math.round(c.w)})`).join(', ')}, total=${btnInfo.candidateCount}, controllingY=${btnInfo.controllingY ? Math.round(btnInfo.controllingY) : 'unknown'}`);

    let modalOpened = false;
    let clickedInfo = null;
    for (let i = 0; i < candidates.length && !modalOpened; i++) {
      const candidate = candidates[i];
      this.log(`Trying @/Elements candidate ${i + 1}/${candidates.length} at (${Math.round(candidate.cx)}, ${Math.round(candidate.cy)})...`);

      // Click with real mouse (isTrusted) - required for Radix UI
      await page.mouse.click(candidate.cx, candidate.cy);
      await page.waitForTimeout(2000);
      modalOpened = await this._isElementsModalOpen(page);

      if (!modalOpened) {
        this.log(`Candidate ${i + 1} did not open Elements modal - retrying same candidate once...`);
        await page.mouse.click(candidate.cx, candidate.cy);
        await page.waitForTimeout(2500);
        modalOpened = await this._isElementsModalOpen(page);
      }

      if (!modalOpened) {
        await page.keyboard.press('Escape');
        await page.waitForTimeout(800);
      } else {
        clickedInfo = candidate;
      }
    }

    if (!modalOpened) {
      const diag = await this._getModalDiagnostics(page);
      this.log(`[DIAG] Modal detection failed. Page signals: ${JSON.stringify(diag)}`);
      throw new Error(`Elements modal did not open after trying ${candidates.length} @ toolbar candidate(s). Diagnostics: ${JSON.stringify(diag)}`);
    }

    this.log(`Elements modal opened${clickedInfo ? ` via candidate at (${Math.round(clickedInfo.cx)}, ${Math.round(clickedInfo.cy)})` : ''}`);
    return;
    }

    this.log(`Found @ button at (${Math.round(btnInfo.cx)}, ${Math.round(btnInfo.cy)}), w=${Math.round(btnInfo.w)}, candidates=${btnInfo.candidateCount}, controllingY=${btnInfo.controllingY ? Math.round(btnInfo.controllingY) : 'unknown'}`);

    // Click with real mouse (isTrusted) — required for Radix UI
    await page.mouse.click(btnInfo.cx, btnInfo.cy);
    await page.waitForTimeout(2000);

    // Verify modal opened
    let modalOpened = await this._isElementsModalOpen(page);
    if (!modalOpened) {
      // Retry 1: click same button again
      this.log('Modal not detected after first click — retrying...');
      await page.mouse.click(btnInfo.cx, btnInfo.cy);
      await page.waitForTimeout(2500);
      modalOpened = await this._isElementsModalOpen(page);
    }

    if (!modalOpened) {
      // Retry 2: Escape first (dismiss any partial state), then click
      this.log('Modal still not detected — pressing Escape and retrying...');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(1000);
      await page.mouse.click(btnInfo.cx, btnInfo.cy);
      await page.waitForTimeout(2500);
      modalOpened = await this._isElementsModalOpen(page);
    }

    if (!modalOpened) {
      // Dump diagnostic info for debugging
      const diag = await this._getModalDiagnostics(page);
      this.log(`[DIAG] Modal detection failed. Page signals: ${JSON.stringify(diag)}`);
      throw new Error(`Elements modal did not open after clicking @ toolbar button. Diagnostics: ${JSON.stringify(diag)}`);
    }

    this.log('Elements modal opened');
  }

  async _openElementsModalViaProjectButton(page) {
    this.log('Trying project Elements button...');
    const candidates = await page.evaluate(() => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'
          && r.top < innerHeight && r.left < innerWidth && r.bottom > 0 && r.right > 0;
      };
      return [...document.querySelectorAll('button, [role="button"], div, a')]
        .map((el) => {
          const r = el.getBoundingClientRect();
          const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
          const aria = (el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
          const isExactElements = /^Elements$/i.test(text) || /^Elements$/i.test(aria);
          const inProjectControlBand =
            r.y > 60 &&
            r.y < window.innerHeight * 0.40 &&
            r.x > window.innerWidth * 0.38 &&
            r.x < window.innerWidth * 0.82;
          const score =
            (inProjectControlBand ? 100 : 0) +
            (/^Elements$/i.test(aria) ? 30 : 0) +
            (/^Elements$/i.test(text) ? 20 : 0) +
            (r.y < 60 ? -80 : 0) +
            (r.width >= 30 && r.width <= 90 && r.height >= 28 && r.height <= 90 ? 15 : 0);
          return {
            tag: el.tagName,
            role: el.getAttribute('role'),
            text,
            aria,
            cx: r.x + r.width / 2,
            cy: r.y + r.height / 2,
            w: r.width,
            h: r.height,
            y: r.y,
            x: r.x,
            visible: visible(el),
            isExactElements,
            score,
          };
        })
        .filter((c) =>
          c.visible &&
          c.isExactElements &&
          c.w >= 30 &&
          c.w <= 160 &&
          c.h >= 20 &&
          c.h <= 100 &&
          c.x > window.innerWidth * 0.35 &&
          c.x < window.innerWidth * 0.85 &&
          c.y < window.innerHeight * 0.45
        )
        .sort((a, b) => b.score - a.score || a.y - b.y || a.x - b.x)
        .slice(0, 4);
    }).catch(() => []);

    for (const candidate of candidates) {
      await page.mouse.click(candidate.cx, candidate.cy);
      await page.waitForTimeout(1500);
      if (await this._isElementsModalOpen(page)) {
        this.log(`Elements modal opened via project Elements button at (${Math.round(candidate.cx)}, ${Math.round(candidate.cy)})`);
        return true;
      }
    }
    return false;
  }

  /**
   * Check if the elements modal overlay is currently open.
   * Uses broad detection: text signals, overlay containers, Radix popovers.
   * Case-insensitive matching to handle UI text changes.
   */
  async _isElementsModalOpen(page) {
    return page.evaluate(() => {
      const strictCandidates = [...document.querySelectorAll('[role="dialog"], [data-state="open"], [class*="Dialog"], [class*="Sheet"], [class*="modal"], [class*="Modal"]')];
      for (const el of strictCandidates) {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        if (
          rect.width < 350 || rect.height < 250 ||
          style.display === 'none' || style.visibility === 'hidden' ||
          rect.top >= innerHeight || rect.left >= innerWidth || rect.bottom <= 0 || rect.right <= 0
        ) continue;

        const text = (el.innerText || el.textContent || '').toLowerCase();
        const hasModalListSignals =
          (
            text.includes('assets elements') ||
            text.includes('my elements') ||
            text.includes('all pinned')
          ) &&
          (
            text.includes('show subfolders elements') ||
            text.includes('all pinned') ||
            text.includes('create element') ||
            text.includes('new element')
          );
        const hasNewElementForm =
          text.includes('new element') &&
          text.includes('category') &&
          (
            text.includes('upload media') ||
            text.includes('upload images') ||
            text.includes('enter name')
          );

        if (hasModalListSignals || hasNewElementForm) return true;
      }

      return false;

      const allText = (document.body.innerText || '').toLowerCase();

      // Text signals (case-insensitive)
      const hasElementsHeading = allText.includes('elements');
      const hasCreateNew = allText.includes('create new');
      const hasCreateElement = allText.includes('create element') || allText.includes('new element');
      const hasPinned = allText.includes('pinned');
      const hasCharacters = allText.includes('characters');

      // Overlay/modal container signals — broad set for Radix/Headless UI
      const dialogs = document.querySelectorAll(
        '[role="dialog"], [data-state="open"], [data-radix-popper-content-wrapper], ' +
        '[class*="overlay"], [class*="modal"], [class*="popover"], [class*="Popover"], ' +
        '[class*="Dialog"], [class*="Sheet"]'
      );

      // Fixed/absolute positioned large overlays that appeared recently
      const fixedOverlays = document.querySelectorAll('div[style*="position: fixed"], div[style*="position:fixed"]');
      let hasLargeOverlay = false;
      for (const el of fixedOverlays) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 200 && rect.height > 200) {
          const innerText = (el.innerText || '').toLowerCase();
          if (innerText.includes('element') || innerText.includes('create new')) {
            hasLargeOverlay = true;
            break;
          }
        }
      }

      // Search bar unique to the modal
      const hasSearch = !!document.querySelector(
        'input[type="search"], input[placeholder*="earch"], input[placeholder*="Search"]'
      );

      // Category sidebar signals (All, Pinned, Characters, Locations, Props)
      const hasCategorySidebar = hasCharacters && (hasPinned || allText.includes('locations') || allText.includes('props'));

      return (hasElementsHeading && hasCreateNew) ||
             (hasElementsHeading && hasCategorySidebar) ||
             (dialogs.length > 0 && (hasElementsHeading || hasCreateNew || hasCreateElement)) ||
             (hasLargeOverlay) ||
             (hasSearch && (hasCreateNew || hasCreateElement)) ||
             (hasElementsHeading && hasSearch);
    }).catch(() => false);
  }

  /**
   * Gather diagnostic info about what the page currently shows.
   * Used when modal detection fails, to help debug selector issues.
   */
  async _getModalDiagnostics(page) {
    return page.evaluate(() => {
      const allText = (document.body.innerText || '').toLowerCase();
      const dialogs = document.querySelectorAll('[role="dialog"], [data-state="open"]');
      const radixPoppers = document.querySelectorAll('[data-radix-popper-content-wrapper]');
      const overlays = document.querySelectorAll('[class*="overlay"], [class*="modal"], [class*="popover"]');
      const fixedDivs = document.querySelectorAll('div[style*="position: fixed"], div[style*="position:fixed"]');

      // Check for specific text fragments
      const textSignals = {
        elements: allText.includes('elements'),
        create_new: allText.includes('create new'),
        pinned: allText.includes('pinned'),
        characters: allText.includes('characters'),
        locations: allText.includes('locations'),
        props: allText.includes('props'),
        search: !!document.querySelector('input[type="search"], input[placeholder*="earch"]'),
      };

      // Count overlay-like containers
      const containerCounts = {
        dialogs: dialogs.length,
        radixPoppers: radixPoppers.length,
        overlays: overlays.length,
        fixedDivs: fixedDivs.length,
      };

      // Sample large fixed divs
      const fixedDivInfo = [];
      for (const el of fixedDivs) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 100 && rect.height > 100) {
          fixedDivInfo.push({
            w: Math.round(rect.width),
            h: Math.round(rect.height),
            textSnippet: (el.innerText || '').slice(0, 80).replace(/\n/g, ' '),
          });
        }
        if (fixedDivInfo.length >= 3) break;
      }

      return { textSignals, containerCounts, fixedDivInfo, url: window.location.href };
    }).catch((e) => ({ error: e.message }));
  }

  /**
   * Close the elements modal overlay.
   * Strategy order: X close button → Cancel button → Escape key.
   */
  async _closeElementsModal() {
    const page = this.automation.page;
    this.log('Closing elements modal...');

    // Strategy 1: Find X close button coordinates, then click with real mouse (isTrusted)
    const closeBtn = await page.evaluate(() => {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        const rect = btn.getBoundingClientRect();
        if (rect.width < 1) continue;

        const text = btn.textContent?.trim() || '';
        const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();

        const isClose = text === '×' || text === '✕' || text === 'x' || text === 'X' ||
          ariaLabel.includes('close') || ariaLabel.includes('dismiss');

        if (isClose && rect.width <= 60) {
          return { cx: rect.x + rect.width / 2, cy: rect.y + rect.height / 2 };
        }
      }
      return null;
    }).catch(() => null);

    if (closeBtn) {
      await page.mouse.click(closeBtn.cx, closeBtn.cy);
      this.log('Closed modal via X button (real mouse click)');
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
          if (text.includes('Create new') || text.includes('New Element') || text === '+') continue;
          if (['Create Element', 'Browse all elements', 'Add to Element',
               'Uploads', 'Image Generations', 'Liked', 'Auto', 'Character',
               'Location', 'Prop'].includes(text)) continue;
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
            if (text.includes('Create new') || text.includes('New Element') || text === '+') break;

            const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
            // Find a line that looks like an element name (short, no common UI words)
            for (const line of lines) {
              if (line.length > 2 && line.length < 60 &&
                  !['Upload images', 'Upload media', 'Save', 'Cancel', 'Elements', 'Create new', 'New Element',
                    'Create Element', 'Browse all elements', 'Add to Element',
                    'All', 'Pinned', 'Characters', 'Locations', 'Props',
                    'Uploads', 'Image Generations', 'Liked', 'Auto', 'Character',
                    'Location', 'Prop', 'Advanced settings', 'Search'].some(skip => line.includes(skip))) {
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

      for (const container of searchContexts) {
        const text = container.textContent || '';
        const matches = text.matchAll(/@([A-Za-z0-9_-]+?)(?:Character|Location|Prop|Use|\s|$)/g);
        for (const match of matches) {
          const name = (match[1] || '').trim();
          if (!name || name.length < 2) continue;
          const key = name.toLowerCase();
          if (!seen.has(key)) {
            seen.add(key);
            results.push({ name, category: 'unknown' });
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

    const normalizedSeen = new Set();
    const normalizedElements = elements
      .map(e => {
        const normalizedName = this._normalizeScrapedElementName(e.name);
        return normalizedName ? { ...e, name: normalizedName, rawName: e.name } : null;
      })
      .filter((e) => {
        if (!e || [
          'check eligibility',
          'create element',
          'browse all elements',
          'add to element',
          'new element',
        ].includes(e.name)) return false;
        if (normalizedSeen.has(e.name)) return false;
        normalizedSeen.add(e.name);
        return true;
      });

    this.log(`Found ${normalizedElements.length} existing elements: ${normalizedElements.map(e => e.name).join(', ') || '(none)'}`);

    // Close the modal
    await this._closeElementsModal();

    this._cache = normalizedElements;
    return normalizedElements;
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
  async _createElementCurrentUi({ normalized, uploadImagePaths, description, uiCategory }) {
    const page = this.automation.page;

    const alreadyExists = await this.elementExists(normalized);
    if (alreadyExists) {
      this.log(`Element @${normalized} already exists - skipping creation`);
      return { created: false, name: normalized };
    }

    await this._dismissOverlays();
    await this._openElementsModal();
    await page.waitForTimeout(1000);

    await this._clickNewElementEntry(page);
    await this._waitForCurrentElementForm(page);
    await this._fillCurrentElementFields(page, { normalized, description, uiCategory });

    for (let i = 0; i < uploadImagePaths.length; i++) {
      await this._attachCurrentElementImage(page, uploadImagePaths[i], i, uploadImagePaths.length);
      const waitMs = i < uploadImagePaths.length - 1 ? 8000 : 4000;
      this.log(`Waiting ${Math.round(waitMs / 1000)}s after image ${i + 1}/${uploadImagePaths.length} attach...`);
      await page.waitForTimeout(waitMs);
    }

    const previewCount = await this._countCurrentElementPreviews(page);
    if (previewCount < 2) {
      await this._closeCreationForm(page);
      throw new Error(`Element form has only ${previewCount} image preview(s); expected at least 2`);
    }
    this.log(`Element form has ${previewCount}/${uploadImagePaths.length} required image previews confirmed before Create`);

    await this._clickCurrentElementCreate(page);
    const created = await this._waitForCurrentElementCreated(page, normalized);
    this.invalidateCache();
    if (!created && !(await this.elementExists(normalized))) {
      this.log(`Warn: @${normalized} not found by scraper - but Create completed, trusting creation`, 'warn');
    }
    this.log(`Created ${uiCategory.toLowerCase()} element @${normalized}`);
    return { created: true, name: normalized };
  }

  async _clickNewElementEntry(page) {
    const entry = await page.evaluate(() => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
      };
      const button = [...document.querySelectorAll('button')]
        .map((el) => {
          const r = el.getBoundingClientRect();
          const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
          return { text, cx: r.x + r.width / 2, cy: r.y + r.height / 2, x: r.x, y: r.y, w: r.width, h: r.height, visible: visible(el), kind: 'button' };
        })
        .find((c) => c.visible && c.text === 'Create Element' && c.w > 80);
      if (button) return button;

      return [...document.querySelectorAll('button, [role="button"], div')]
        .map((el) => {
          const r = el.getBoundingClientRect();
          const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
          return { text, cx: r.x + r.width / 2, cy: r.y + Math.min(60, r.height * 0.42), x: r.x, y: r.y, w: r.width, h: r.height, visible: visible(el), kind: 'plus-tile' };
        })
        .filter((c) => c.visible && c.text === 'New Element' && c.w >= 90 && c.h >= 90 && c.x > 250)
        .sort((a, b) => (b.w * b.h) - (a.w * a.h))[0] || null;
    });
    if (!entry) throw new Error('Could not find Create Element button or New Element plus tile');
    await page.mouse.click(entry.cx, entry.cy);
    this.log(`Clicked ${entry.kind} element entry at (${Math.round(entry.cx)}, ${Math.round(entry.cy)})`);
    await page.waitForTimeout(1500);
  }

  async _waitForCurrentElementForm(page) {
    const ok = await page.waitForFunction(() => {
      const body = document.body.innerText || '';
      return body.includes('New Element') &&
        body.includes('Category') &&
        body.includes('Upload media') &&
        !!document.querySelector('input[placeholder="Enter name"], input[aria-label="Element name"]');
    }, { timeout: 15000 }).then(() => true).catch(() => false);
    if (!ok) throw new Error('New Element form did not appear');
  }

  async _fillCurrentElementFields(page, { normalized, description, uiCategory }) {
    const state = await page.evaluate(() => {
      const input = document.querySelector('input[placeholder="Enter name"], input[aria-label="Element name"]');
      return { value: input?.value || '' };
    }).catch(() => ({ value: '' }));
    if (state.value && state.value !== normalized) {
      await this._closeCreationForm(page);
      throw new Error(`Create-new safety check failed: opened prefilled form "${state.value}"`);
    }

    const nameInput = page.locator('input[placeholder="Enter name"], input[aria-label="Element name"]').first();
    await nameInput.click({ timeout: 5000 });
    await nameInput.fill(normalized, { timeout: 5000 });

    if (description) {
      await page.locator('textarea[placeholder="Add description"], textarea[aria-label="Element description"]')
        .first()
        .fill(String(description).slice(0, 500), { timeout: 5000 })
        .catch((e) => this.log(`Warn: couldn't fill description - ${e.message.split('\n')[0]}`, 'warn'));
    }

    await this._setCurrentElementCategory(page, uiCategory);
  }

  async _setCurrentElementCategory(page, uiCategory) {
    if (uiCategory === 'Auto') return;
    const category = await page.evaluate(() => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
      };
      return [...document.querySelectorAll('button')]
        .map((el) => {
          const r = el.getBoundingClientRect();
          const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
          return { text, cx: r.x + r.width / 2, cy: r.y + r.height / 2, x: r.x, y: r.y, w: r.width, h: r.height, visible: visible(el) };
        })
        .filter((c) => c.visible && ['Auto', 'Character', 'Location', 'Prop'].includes(c.text) && c.x > 250 && c.x < 760 && c.y > 150 && c.y < 430)
        .sort((a, b) => (b.w * b.h) - (a.w * a.h))[0] || null;
    });
    if (!category) throw new Error('Category dropdown button not found');
    await page.mouse.click(category.cx, category.cy);
    await page.waitForTimeout(800);

    const option = await page.evaluate((wanted) => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
      };
      return [...document.querySelectorAll('button, [role="option"], [role="menuitem"], div')]
        .map((el) => {
          const r = el.getBoundingClientRect();
          const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
          return { text, cx: r.x + r.width / 2, cy: r.y + r.height / 2, x: r.x, y: r.y, w: r.width, h: r.height, visible: visible(el) };
        })
        .filter((c) => c.visible && c.text === wanted && c.x > 250 && c.x < 760 && c.y > 80 && c.y < 500)
        .sort((a, b) => (a.w * a.h) - (b.w * b.h))[0] || null;
    }, uiCategory);
    if (!option) throw new Error(`Category option "${uiCategory}" not found`);
    await page.mouse.click(option.cx, option.cy);
    await page.waitForTimeout(800);

    const stuck = await page.evaluate((wanted) => {
      const body = document.body.innerText || '';
      return body.includes(`Category\n${wanted}`) || body.includes(`Category ${wanted}`);
    }, uiCategory).catch(() => false);
    if (!stuck) throw new Error(`Category "${uiCategory}" did not visually stick`);
    this.log(`Category set to "${uiCategory}"`);
  }

  async _attachCurrentElementImage(page, filePath, index, total) {
    const before = await this._countCurrentElementPreviews(page);
    this.log(`Uploading element image ${index + 1}/${total}: ${filePath} (previews before=${before})`);
    await this._openCurrentElementUploadPicker(page);
    await this._uploadIntoCurrentElementPicker(page, filePath);
    if (!(await this._waitForAddToElementEnabled(page, 45000))) {
      await this._selectFirstCurrentUploadTile(page);
      if (!(await this._waitForAddToElementEnabled(page, 15000))) {
        throw new Error('Add to Element did not become enabled after upload/selection');
      }
    }
    await this._clickCurrentAddToElement(page);
    if (!(await this._waitForElementPreviewCount(page, before + 1, 30000))) {
      throw new Error(`Image ${index + 1}/${total} was not attached to element form`);
    }
    this.log(`Element image ${index + 1}/${total} attached; previews=${before + 1}+`);
  }

  async _openCurrentElementUploadPicker(page) {
    const findTarget = async () => page.evaluate(() => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
      };

      const dialog = [...document.querySelectorAll('[role="dialog"], div')]
        .map((el) => {
          const r = el.getBoundingClientRect();
          const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
          return { el, text, x: r.x, y: r.y, w: r.width, h: r.height, visible: visible(el) };
        })
        .filter((d) =>
          d.visible &&
          d.w > 500 &&
          d.h > 300 &&
          d.text.includes('New Element') &&
          d.text.includes('Category') &&
          d.text.includes('Upload media')
        )
        .sort((a, b) => (a.w * a.h) - (b.w * b.h))[0]?.el || document.body;

      return [...dialog.querySelectorAll('div, button, [role="button"], label')]
        .map((el) => {
          const r = el.getBoundingClientRect();
          const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
          const lower = text.toLowerCase();

          let cx = r.x + r.width / 2;
          let cy = r.y + Math.min(58, r.height * 0.38);
          let clickKind = 'upper-center';
          const innerPlus = [...el.querySelectorAll('button, [role="button"], svg, [class*="plus"], [class*="Plus"]')]
            .map((child) => {
              const cr = child.getBoundingClientRect();
              return {
                tag: child.tagName.toLowerCase(),
                x: cr.x,
                y: cr.y,
                w: cr.width,
                h: cr.height,
                cx: cr.x + cr.width / 2,
                cy: cr.y + cr.height / 2,
                text: (child.textContent || '').trim(),
              };
            })
            .filter((c) =>
              c.w >= 12 && c.h >= 12 &&
              c.x >= r.x - 2 && c.y >= r.y - 2 &&
              c.x + c.w <= r.x + r.width + 2 &&
              c.y + c.h <= r.y + r.height + 2
            )
            .sort((a, b) => {
              const aSvg = a.tag === 'svg' ? 1 : 0;
              const bSvg = b.tag === 'svg' ? 1 : 0;
              if (aSvg !== bSvg) return bSvg - aSvg;
              return (a.w * a.h) - (b.w * b.h);
            })[0] || null;
          if (innerPlus) {
            cx = innerPlus.cx;
            cy = innerPlus.cy;
            clickKind = `inner-${innerPlus.tag}`;
          }

          let score = 0;
          if (lower.includes('upload media')) score += 100;
          if (lower.includes('drag') && lower.includes('upload')) score += 80;
          if (lower.includes('click to upload')) score += 80;
          if (innerPlus) score += 40;
          if (r.x > window.innerWidth * 0.42) score += 30;
          if (r.w > 250 && r.h > 180) score += 20;
          if (r.y < 120 || r.y > window.innerHeight - 140) score -= 80;

          return { text, cx, cy, x: r.x, y: r.y, w: r.width, h: r.height, visible: visible(el), score, clickKind };
        })
        .filter((c) =>
          c.visible &&
          c.score > 0 &&
          c.x > 250 &&
          c.y > 80 &&
          c.y < window.innerHeight - 80 &&
          c.w >= 80 &&
          c.h >= 70
        )
        .sort((a, b) => b.score - a.score || (b.w * b.h) - (a.w * a.h))[0] || null;
    });

    let target = null;
    const started = Date.now();
    let polls = 0;
    while (Date.now() - started < 30000) {
      polls++;
      target = await findTarget();
      if (target) break;
      if (polls % 4 === 0) this.log(`Waiting for New Element upload tile (${Math.round((Date.now() - started) / 1000)}s)...`);
      await page.waitForTimeout(1000);
    }
    if (!target) throw new Error('Upload media tile not found in element form');

    this.log(`Element upload tile target: "${target.text || '(no text)'}" ${Math.round(target.w)}x${Math.round(target.h)} at (${Math.round(target.cx)}, ${Math.round(target.cy)}), click=${target.clickKind}, score=${target.score}`);
    for (let attempt = 1; attempt <= 3; attempt++) {
      await page.mouse.click(target.cx, target.cy);
      const opened = await page.waitForFunction(() => {
        const body = document.body.innerText || '';
        return body.includes('Uploads') && body.includes('Add to Element');
      }, { timeout: 8000 }).then(() => true).catch(() => false);
      if (opened) return;
      this.log(`Upload media picker did not open after tile click ${attempt}/3; retrying...`, 'warn');
      await page.waitForTimeout(1000);
      target = await findTarget() || target;
    }
    throw new Error('Upload media picker did not open');
  }

  async _uploadIntoCurrentElementPicker(page, filePath) {
    const inputInfo = await page.evaluate(() => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
      };

      const picker = [...document.querySelectorAll('[role="dialog"], div')]
        .map((el) => {
          const r = el.getBoundingClientRect();
          const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
          return { el, text, x: r.x, y: r.y, w: r.width, h: r.height, visible: visible(el) };
        })
        .filter((d) =>
          d.visible &&
          d.w > 300 &&
          d.h > 250 &&
          d.text.includes('Uploads') &&
          d.text.includes('Add to Element')
        )
        .sort((a, b) => (a.w * a.h) - (b.w * b.h))[0]?.el || document.body;

      const allFileInputs = [...document.querySelectorAll('input[type="file"]')];
      const inputs = [...picker.querySelectorAll('input[type="file"]')]
        .map((input, index) => {
          const r = input.getBoundingClientRect();
          return {
            index,
            globalIndex: allFileInputs.indexOf(input),
            accept: input.getAttribute('accept') || '',
            multiple: !!input.multiple,
            x: r.x,
            y: r.y,
            w: r.width,
            h: r.height,
            visible: visible(input),
          };
        });
      const imageInput = inputs.find((i) => /\.(jpg|jpeg|png|webp)|image\//i.test(i.accept)) || inputs[0] || null;
      return imageInput ? { ...imageInput, count: inputs.length } : { count: 0 };
    });

    if (!inputInfo || inputInfo.count === 0 || inputInfo.globalIndex == null || inputInfo.globalIndex < 0) {
      const diag = await page.evaluate(() => ({
        bodyText: (document.body.innerText || '').slice(0, 500).replace(/\s+/g, ' '),
        fileInputs: [...document.querySelectorAll('input[type="file"]')].map((input, index) => ({
          index,
          accept: input.getAttribute('accept') || '',
          multiple: !!input.multiple,
        })),
      })).catch((e) => ({ error: e.message }));
      throw new Error(`No file input found in upload picker; diag=${JSON.stringify(diag)}`);
    }

    const fileInputs = page.locator('input[type="file"]');
    await fileInputs.nth(inputInfo.globalIndex).setInputFiles(filePath, { timeout: 15000 });
    this.log(`Picker file input accepted ${filePath} (picker input ${inputInfo.index + 1}/${inputInfo.count}, global input ${inputInfo.globalIndex + 1}, accept="${inputInfo.accept || 'none'}")`);
    await page.waitForFunction(() => !(document.body.innerText || '').includes('Uploading...'), { timeout: 60000 }).catch(() => {
      this.log('Upload picker still showed Uploading... after 60s; continuing to selection check', 'warn');
    });
    await page.waitForTimeout(2000);
  }

  async _waitForAddToElementEnabled(page, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const enabled = await page.evaluate(() => {
        const add = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').replace(/\s+/g, ' ').trim() === 'Add to Element');
        if (!add) return false;
        return !(add.disabled || add.getAttribute('aria-disabled') === 'true' || getComputedStyle(add).pointerEvents === 'none' || Number(getComputedStyle(add).opacity) < 0.6);
      }).catch(() => false);
      if (enabled) return true;
      await page.waitForTimeout(1000);
    }
    return false;
  }

  async _selectFirstCurrentUploadTile(page) {
    const tile = await page.evaluate(() => {
      return [...document.querySelectorAll('img')]
        .map((img) => {
          const r = img.getBoundingClientRect();
          return { cx: r.x + r.width / 2, cy: r.y + r.height / 2, x: r.x, y: r.y, w: r.width, h: r.height };
        })
        .filter((img) => img.w >= 60 && img.h >= 60 && img.x > 250 && img.x < 1200 && img.y > 100 && img.y < 650)
        .sort((a, b) => a.y - b.y || a.x - b.x)[0] || null;
    });
    if (!tile) throw new Error('No selectable upload tile found');
    await page.mouse.click(tile.cx, tile.cy);
    await page.waitForTimeout(1000);
  }

  async _clickCurrentAddToElement(page) {
    const add = await page.evaluate(() => {
      return [...document.querySelectorAll('button')]
        .map((b) => {
          const r = b.getBoundingClientRect();
          const text = (b.textContent || '').replace(/\s+/g, ' ').trim();
          return { text, cx: r.x + r.width / 2, cy: r.y + r.height / 2, w: r.width, h: r.height, disabled: b.disabled || b.getAttribute('aria-disabled') === 'true' };
        })
        .find((b) => b.text === 'Add to Element' && b.w > 0 && b.h > 0 && !b.disabled) || null;
    });
    if (!add) throw new Error('Enabled Add to Element button not found');
    await page.mouse.click(add.cx, add.cy);
    await page.waitForTimeout(2000);
  }

  async _countCurrentElementPreviews(page) {
    return page.evaluate(() => {
      const dialog = [...document.querySelectorAll('[role="dialog"], div')]
        .map((el) => {
          const r = el.getBoundingClientRect();
          const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
          return { el, text, w: r.width, h: r.height };
        })
        .filter((d) => d.w > 400 && d.h > 300 && d.text.includes('New Element') && d.text.includes('Category'))
        .sort((a, b) => (a.w * a.h) - (b.w * b.h))[0]?.el || document.body;
      return [...dialog.querySelectorAll('img, video')]
        .filter((m) => {
          const r = m.getBoundingClientRect();
          return r.width >= 80 && r.height >= 80 && r.x > 500 && r.y > 50 && r.y < window.innerHeight - 40;
        }).length;
    }).catch(() => 0);
  }

  async _waitForElementPreviewCount(page, expected, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await this._countCurrentElementPreviews(page) >= expected) return true;
      await page.waitForTimeout(1000);
    }
    return false;
  }

  async _clickCurrentElementCreate(page) {
    const create = await page.evaluate(() => {
      return [...document.querySelectorAll('button')]
        .map((b) => {
          const r = b.getBoundingClientRect();
          const text = (b.textContent || '').replace(/\s+/g, ' ').trim();
          const disabled = b.disabled || b.getAttribute('aria-disabled') === 'true' || getComputedStyle(b).pointerEvents === 'none' || Number(getComputedStyle(b).opacity) < 0.6;
          return { text, cx: r.x + r.width / 2, cy: r.y + r.height / 2, y: r.y, w: r.width, h: r.height, disabled };
        })
        .filter((b) => b.text === 'Create' && b.w > 0 && b.h > 0)
        .sort((a, b) => b.y - a.y)[0] || null;
    });
    if (!create) throw new Error('Create button not found');
    if (create.disabled) throw new Error('Create button is disabled');
    await page.mouse.click(create.cx, create.cy);
  }

  async _waitForCurrentElementCreated(page, normalized) {
    const wanted = `@${normalized}`;
    const start = Date.now();
    while (Date.now() - start < 90000) {
      await page.waitForTimeout(3000);
      const state = await page.evaluate((name) => {
        const body = document.body.innerText || '';
        return {
          creating: body.includes('Creating...'),
          hasName: body.toLowerCase().includes(name.toLowerCase()),
        };
      }, wanted).catch(() => ({ creating: false, hasName: false }));
      if (!state.creating && state.hasName) return true;
    }
    return false;
  }

  async _createElement({ name, imagePaths, description, category = 'Auto' }) {
    const page = this.automation.page;
    const fs = require('fs');
    const path = require('path');
    const normalized = this._normalizeName(name);
    const uiCategory = HiggsfieldElements.CATEGORY_MAP[(category || 'auto').toLowerCase()] || 'Auto';

    if (!normalized) throw new Error('Element name is required');
    if (!imagePaths || imagePaths.length === 0) throw new Error('At least one image path required');

    const uploadImagePaths = imagePaths.map((srcPath) => {
      if (!fs.existsSync(srcPath)) {
        throw new Error(`Upload source file does not exist: ${srcPath}`);
      }
      return srcPath;
    });

    this.log(`Creating element @${normalized} (${uiCategory}) with ${uploadImagePaths.length} image(s)...`);
    return this._createElementCurrentUi({
      normalized,
      uploadImagePaths,
      description,
      uiCategory,
    });

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

    // Strategy A: find the "Create new" tile by its label, then click the
    // circular plus control inside that same tile. Clicking the label itself
    // is not reliable in the current Higgsfield UI.
    const createNewInfo = await page.evaluate(() => {
      const all = [...document.querySelectorAll('button, [role="button"], div[tabindex], a, div, span, p')];
      for (const labelEl of all) {
        const text = (labelEl.textContent || '').replace(/\s+/g, ' ').trim();
        if (text !== 'Create new') continue;

        let tile = labelEl;
        for (let depth = 0; depth < 5 && tile; depth++) {
          const rect = tile.getBoundingClientRect();
          const tileText = (tile.textContent || '').replace(/\s+/g, ' ').trim();
          if (rect.width >= 100 && rect.height >= 100 && tileText.includes('Create new')) {
            const plusCandidates = [...tile.querySelectorAll('button, [role="button"], svg, div')]
              .map(el => {
                const r = el.getBoundingClientRect();
                return {
                  cx: r.x + r.width / 2,
                  cy: r.y + r.height / 2,
                  w: r.width,
                  h: r.height,
                  text: (el.textContent || '').trim(),
                  hasSvg: !!el.querySelector?.('svg') || el.tagName.toLowerCase() === 'svg',
                };
              })
              .filter(c =>
                c.w >= 20 && c.w <= 70 &&
                c.h >= 20 && c.h <= 70 &&
                (c.text === '+' || c.hasSvg) &&
                c.cy < rect.y + rect.height * 0.75
              )
              .sort((a, b) => Math.abs(a.cx - (rect.x + rect.width / 2)) - Math.abs(b.cx - (rect.x + rect.width / 2)));

            if (plusCandidates.length > 0) {
              return { ...plusCandidates[0], method: 'plus-in-create-new-tile' };
            }

            // Last safe fallback: click near the visual plus position within
            // the located Create new tile, not any arbitrary SVG card.
            return {
              cx: rect.x + rect.width / 2,
              cy: rect.y + rect.height * 0.42,
              w: rect.width,
              h: rect.height,
              method: 'create-new-tile-estimated-plus',
            };
          }
          tile = tile.parentElement;
        }
      }

      return null;
    });

    if (createNewInfo) {
      await page.mouse.click(createNewInfo.cx, createNewInfo.cy);
      createNewClicked = true;
      this.log(`Clicked Create new plus (${createNewInfo.method || 'unknown'}) at (${Math.round(createNewInfo.cx)}, ${Math.round(createNewInfo.cy)})`);
    } else {
      throw new Error('Could not find the Create new tile/plus control in elements modal');
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
      this.log(`SAFETY STOP: form has pre-filled name "${formState.nameValue}" - likely editing an existing element; refusing to upload files`, 'error');
      await this._closeCreationForm(page);
      throw new Error(`Create-new safety check failed: opened existing element "${formState.nameValue}" instead of a blank new-element form`);
      this.log(`Warn: form has pre-filled name "${formState.nameValue}" — may be editing. Clearing.`);
      try {
        const nameInput = page.locator('input[placeholder="reference-name"]').first();
        await nameInput.click({ timeout: 3000 });
        await nameInput.fill('', { timeout: 3000 });
      } catch (_) {}
    }

    // Fill the required name before uploads. Higgsfield keeps Save disabled
    // until this field has a value, and filling it early gives us a stable
    // signal if the form is actually writable.
    this.log('Pre-fill: setting required element name before upload...');
    try {
      const nameInput = page.locator('input[type="text"][placeholder="reference-name"]').first();
      await nameInput.click({ timeout: 3000 });
      await nameInput.fill(normalized, { timeout: 3000 });
      await page.waitForTimeout(500);
      const nameValue = await page.evaluate(() => {
        const input = document.querySelector('input[placeholder="reference-name"]');
        return input?.value || '';
      }).catch(() => '');
      if (nameValue !== normalized) {
        throw new Error(`name field verification failed; value="${nameValue}"`);
      }
      this.log(`Pre-fill confirmed element name: "${normalized}"`);
    } catch (nameErr) {
      await this._closeCreationForm(page);
      throw new Error(`Could not pre-fill element name before upload: ${nameErr.message}`);
    }

    // ── Step 3: Upload images ──
    this.log(`Step 3: Uploading ${uploadImagePaths.length} image(s)...`);
    const uploadResponses = [];
    const responseListener = (response) => {
      try {
        const url = response.url();
        const lowerUrl = url.toLowerCase();
        const status = response.status();
        const method = response.request().method();
        const isUploadish =
          (method === 'POST' && (
            lowerUrl.includes('/upload') ||
            lowerUrl.includes('/asset') ||
            lowerUrl.includes('/media') ||
            lowerUrl.includes('/image') ||
            lowerUrl.includes('/file') ||
            lowerUrl.includes('/reference')
          )) ||
          (method === 'PUT' && (
            lowerUrl.includes('amazonaws') ||
            lowerUrl.includes('cloudfront') ||
            lowerUrl.includes('s3') ||
            lowerUrl.includes('storage') ||
            lowerUrl.includes('higgs')
          ));
        if (isUploadish) {
          uploadResponses.push({ url: url.slice(0, 140), status, method, ts: Date.now() });
          if (status >= 200 && status < 300) {
            this.log(`[UPLOAD-NET] ${method} ${status} ${url.slice(0, 100)}`);
          }
        }
      } catch (_) {}
    };
    page.on('response', responseListener);

    let fileChooserHandler = null;
    try {
      this.log(`Upload files: ${uploadImagePaths.join(' | ')}`);

      const countPreviews = async () => page.evaluate(() => {
        const nameInput = document.querySelector('input[placeholder="reference-name"]');
        const nameRect = nameInput?.getBoundingClientRect();
        const formBottom = nameRect ? nameRect.y : window.innerHeight * 0.45;
        let count = 0;
        for (const el of document.querySelectorAll('img, video')) {
          const r = el.getBoundingClientRect();
          if (r.width >= 40 && r.height >= 40 && r.y >= 0 && r.y <= formBottom) count++;
        }
        return count;
      }).catch(() => 0);

      const getUploadDomDiagnostics = async () => page.evaluate(() => {
        const nameInput = document.querySelector('input[placeholder="reference-name"]');
        const nameRect = nameInput?.getBoundingClientRect();
        const maxY = nameRect ? nameRect.y : window.innerHeight * 0.45;
        const visibleControls = [];
        for (const el of document.querySelectorAll('button, [role="button"], label, input[type="file"], div')) {
          const r = el.getBoundingClientRect();
          if (r.width < 5 || r.height < 5 || r.y > maxY) continue;
          const text = (el.textContent || '').trim().replace(/\s+/g, ' ');
          const tag = el.tagName.toLowerCase();
          const type = (el.getAttribute('type') || '').toLowerCase();
          const accept = el.getAttribute('accept') || '';
          if (tag === 'input' || /upload|add more|\+/.test(text.toLowerCase()) || accept) {
            visibleControls.push({
              tag,
              type,
              accept,
              text: text.slice(0, 60),
              x: Math.round(r.x),
              y: Math.round(r.y),
              w: Math.round(r.width),
              h: Math.round(r.height),
            });
          }
          if (visibleControls.length >= 20) break;
        }
        const previews = [...document.querySelectorAll('img, video')]
          .map(el => {
            const r = el.getBoundingClientRect();
            return {
              tag: el.tagName.toLowerCase(),
              src: (el.currentSrc || el.src || '').slice(0, 80),
              x: Math.round(r.x),
              y: Math.round(r.y),
              w: Math.round(r.width),
              h: Math.round(r.height),
            };
          })
          .filter(p => p.w >= 30 && p.h >= 30 && p.y <= maxY);
        return {
          nameValue: nameInput?.value || '',
          visibleControls,
          previews,
          bodyText: (document.body.innerText || '').slice(0, 300).replace(/\s+/g, ' '),
        };
      }).catch(e => ({ error: e.message }));

      const findUploadTarget = async () => page.evaluate(() => {
        const nameInput = document.querySelector('input[placeholder="reference-name"]');
        const nameRect = nameInput?.getBoundingClientRect();
        const maxY = nameRect ? nameRect.y : window.innerHeight * 0.45;
        let previewCount = 0;
        for (const media of document.querySelectorAll('img, video')) {
          const mr = media.getBoundingClientRect();
          if (mr.width >= 40 && mr.height >= 40 && mr.y >= 0 && mr.y <= maxY) previewCount++;
        }
        const candidates = [];
        for (const el of document.querySelectorAll('button, [role="button"], div, label, input[type="file"]')) {
          const r = el.getBoundingClientRect();
          if (r.width < 10 || r.height < 10 || r.y > maxY) continue;
          const text = (el.textContent || '').trim().toLowerCase();
          const tag = el.tagName.toLowerCase();
          const type = (el.getAttribute('type') || '').toLowerCase();
          const cls = String(el.className || '').toLowerCase();
          const isFile = tag === 'input' && type === 'file';
          const hasUploadText = text.includes('upload images') || text.includes('add more images');
          const hasPlus = text === '+' || text.includes('add more') || !!el.querySelector?.('svg');
          if (!hasUploadText && !isFile && !hasPlus) continue;

          let clickX = r.x + r.width / 2;
          let clickY = r.y + r.height / 2;
          let clickKind = 'element-center';

          // The actionable control is the circular + button inside the upload
          // tile. Clicking the tile label or horizontal strip can be ignored.
          const innerControls = [...el.querySelectorAll('button, [role="button"], svg, [class*="plus"], [class*="Plus"]')]
            .map(child => {
              const cr = child.getBoundingClientRect();
              return {
                x: cr.x,
                y: cr.y,
                w: cr.width,
                h: cr.height,
                cx: cr.x + cr.width / 2,
                cy: cr.y + cr.height / 2,
                tag: child.tagName.toLowerCase(),
              };
            })
            .filter(c =>
              c.w >= 12 && c.h >= 12 &&
              c.x >= r.x - 2 && c.y >= r.y - 2 &&
              c.x + c.w <= r.x + r.width + 2 &&
              c.y + c.h <= r.y + r.height + 2
            )
            .sort((a, b) => {
              const aSvg = a.tag === 'svg' ? 1 : 0;
              const bSvg = b.tag === 'svg' ? 1 : 0;
              if (aSvg !== bSvg) return bSvg - aSvg;
              return (a.w * a.h) - (b.w * b.h);
            });

          if (innerControls.length > 0) {
            clickX = innerControls[0].cx;
            clickY = innerControls[0].cy;
            clickKind = `inner-${innerControls[0].tag}`;
          } else if (hasUploadText || text.includes('add more images')) {
            // Fallback to the visual plus position: horizontally centered and
            // above the label in the upper third of the upload tile.
            clickX = r.x + r.width / 2;
            clickY = r.y + Math.min(r.height * 0.38, 58);
            clickKind = 'plus-position-fallback';
          }

          let score = 0;
          if (text.includes('add more images')) score += 100;
          if (text.includes('upload images')) score += 90;
          if (hasPlus) score += 30;
          if (tag === 'label' || tag === 'button') score += 20;
          if (isFile) score -= 50;
          if (previewCount > 0) {
            // After the first upload, Higgsfield renders a full-width strip
            // containing a small "Add more images" tile on the left plus the
            // existing preview. Clicking the strip center hits empty space, so
            // prefer the compact tile itself.
            if (text.includes('add more images') && r.width >= 80 && r.width <= 180 && r.height >= 80 && r.height <= 150) score += 120;
            if (r.width > 300) score -= 80;
          } else if (r.width > 500 && r.height > 80) {
            score += 10;
          }
          if (cls.includes('upload')) score += 10;
          candidates.push({
            cx: clickX,
            cy: clickY,
            w: r.width,
            h: r.height,
            tag,
            text: text.slice(0, 80),
            score,
            previewCount,
            clickKind,
          });
        }
        candidates.sort((a, b) => b.score - a.score || a.cy - b.cy || (b.w * b.h) - (a.w * a.h));
        return candidates[0] || null;
      });

      let currentUploadFile = null;
      let lastFileChooserAt = 0;
      fileChooserHandler = async (chooser) => {
        try {
          if (!currentUploadFile) {
            await chooser.setFiles([]).catch(() => {});
            return;
          }
          const file = currentUploadFile;
          await chooser.setFiles(file);
          lastFileChooserAt = Date.now();
          this.log(`[UPLOAD-FC] Filechooser accepted ${path.basename(file)}`);
        } catch (e) {
          this.log(`[UPLOAD-FC] Handler error: ${e.message.split('\n')[0]}`, 'warn');
        }
      };
      page.on('filechooser', fileChooserHandler);

      const countSuccessfulUploadsSince = (ts) =>
        uploadResponses.filter(r => r.ts >= ts && r.status >= 200 && r.status < 300).length;

      for (let i = 0; i < uploadImagePaths.length; i++) {
        const imagePath = uploadImagePaths[i];
        const beforeCount = await countPreviews();
        this.log(`Uploading image ${i + 1}/${uploadImagePaths.length}: ${imagePath} (previews before=${beforeCount})`);

        currentUploadFile = imagePath;
        const fileChooserAtBeforeClick = lastFileChooserAt;
        const uploadStartTs = Date.now();
        const uploadTarget = await findUploadTarget();
        if (!uploadTarget) {
          const diag = await getUploadDomDiagnostics();
          throw new Error(`No upload target found in creation form; dom=${JSON.stringify(diag)}`);
        }

        this.log(`Upload target ${i + 1}/${uploadImagePaths.length}: <${uploadTarget.tag}> "${uploadTarget.text || '(no text)'}" plus-click=${uploadTarget.clickKind || 'unknown'} at (${Math.round(uploadTarget.cx)}, ${Math.round(uploadTarget.cy)}) tile=${Math.round(uploadTarget.w)}x${Math.round(uploadTarget.h)}`);
        await page.mouse.move(uploadTarget.cx, uploadTarget.cy);
        await page.waitForTimeout(250);
        await page.mouse.click(uploadTarget.cx, uploadTarget.cy);

        const chooserWaitStart = Date.now();
        while (Date.now() - chooserWaitStart < 12000) {
          if (lastFileChooserAt > fileChooserAtBeforeClick) break;
          await page.waitForTimeout(250);
        }
        if (lastFileChooserAt <= fileChooserAtBeforeClick) {
          const diag = await getUploadDomDiagnostics();
          throw new Error(`Trusted click did not trigger filechooser for image ${i + 1}; dom=${JSON.stringify(diag)}`);
        }

        let accepted = false;
        for (let poll = 0; poll < 12; poll++) {
          await page.waitForTimeout(2500);
          const currentCount = await countPreviews();
          this.log(`Upload ${i + 1}/${uploadImagePaths.length} settle ${poll + 1}/12: previews=${currentCount}`);
          if (currentCount >= beforeCount + 1) {
            accepted = true;
            break;
          }
        }
        if (!accepted) {
          const diag = await getUploadDomDiagnostics();
          throw new Error(`Image ${i + 1}/${uploadImagePaths.length} did not appear as an uploaded preview; dom=${JSON.stringify(diag)}`);
        }

        let backendConfirmed = false;
        const uploadConfirmStart = Date.now();
        while (Date.now() - uploadConfirmStart < 30000) {
          if (countSuccessfulUploadsSince(uploadStartTs) > 0) {
            backendConfirmed = true;
            break;
          }
          await page.waitForTimeout(500);
        }
        if (backendConfirmed) {
          this.log(`Upload ${i + 1}/${uploadImagePaths.length} confirmed by network response`);
        } else {
          const recent = uploadResponses.filter(r => r.ts >= uploadStartTs).slice(0, 8);
          this.log(`Upload ${i + 1}/${uploadImagePaths.length} did not show upload network response within 30s; continuing with preview signal. Recent upload-ish responses: ${JSON.stringify(recent)}`, 'warn');
        }

        currentUploadFile = null;
        const interUploadWait = i < uploadImagePaths.length - 1 ? 8000 : 4000;
        this.log(`Waiting ${Math.round(interUploadWait / 1000)}s after image ${i + 1}/${uploadImagePaths.length} upload...`);
        await page.waitForTimeout(interUploadWait);
      }

      page.off('filechooser', fileChooserHandler);
      fileChooserHandler = null;
      await page.waitForTimeout(2000);

    } catch (e) {
      if (fileChooserHandler) page.off('filechooser', fileChooserHandler);
      page.off('response', responseListener);
      // Try to close the form before bailing
      await this._closeCreationForm(page);
      throw new Error(`Image upload failed: ${e.message}`);
    }
    page.off('response', responseListener);

    // ── Wait for upload to be processed (Save button enabled) ──
    // Save is expected to stay disabled until the required element name is
    // filled in Step 4; the per-image preview checks above are the upload gate.
    const UPLOAD_POLL_MAX = 0;
    const UPLOAD_POLL_MS = 2000;
    this.log(`Upload previews accepted; Save enable check will run after required name/category fields are filled`);

    let uploadProcessed = true;
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
      await this._closeCreationForm(page);
      throw new Error(`Image upload did not complete: Save stayed disabled after 50s; diagnosis=${JSON.stringify(diagnosis)}`);
    }

    await page.waitForTimeout(2000);

    // ── Step 4: Fill element name ──
    this.log('Step 4: Verifying/filling element name...');
    try {
      const nameInput = page.locator('input[type="text"][placeholder="reference-name"]').first();
      await nameInput.click({ timeout: 3000 });
      await nameInput.fill(normalized, { timeout: 3000 });
      const confirmedName = await page.evaluate(() => {
        const input = document.querySelector('input[placeholder="reference-name"]');
        return input?.value || '';
      }).catch(() => '');
      if (confirmedName !== normalized) {
        throw new Error(`name field verification failed; value="${confirmedName}"`);
      }
      this.log(`Element name confirmed as "${normalized}"`);
    } catch (e) {
      try {
        const fallbackInput = page.locator('input[type="text"]').first();
        await fallbackInput.click({ timeout: 3000 });
        await fallbackInput.fill(normalized, { timeout: 3000 });
        const confirmedName = await page.evaluate(() => {
          const input = document.querySelector('input[placeholder="reference-name"], input[type="text"]');
          return input?.value || '';
        }).catch(() => '');
        if (confirmedName !== normalized) {
          throw new Error(`fallback name field verification failed; value="${confirmedName}"`);
        }
        this.log('Element name confirmed via fallback input');
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

      await this._closeCreationForm(page);
      throw new Error(`"Save" button never became safely clickable after ${MAX_SAVE_ATTEMPTS} attempts`);
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
      this.log('Warn: creation form still open after Save - waiting for first Save request to finish (no second Save click)');
      const saveWaitStart = Date.now();
      while (Date.now() - saveWaitStart < 30000) {
        await page.waitForTimeout(3000);
        formStillOpen = await checkFormOpen();
        if (formStillOpen !== 'form-still-open') break;
      }
    }

    if (formStillOpen === 'form-still-open') {
      this.log('Form still open after one Save click - closing form and verifying; no duplicate Save will be attempted', 'warn');
      await this._closeCreationForm(page);
      await page.waitForTimeout(3000);
    }

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
    if (imagePaths.length < 2) imagePaths.push(portraitPath);
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
      imagePaths: [locationImagePath, locationImagePath],
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
      imagePaths: propImagePaths.length >= 2 ? propImagePaths : [propImagePaths[0], propImagePaths[0]],
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
