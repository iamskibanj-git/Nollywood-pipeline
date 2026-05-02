/**
 * Facebook Reel Uploader — Playwright automation for scheduling Reels.
 *
 * Target: Facebook Personal Page with Professional Mode enabled.
 * Flow: Dashboard → Content → Scheduled → Create → Reel → upload → describe → schedule
 *
 * IMPORTANT: User must be logged in before automation starts.
 * Playwright connects to an existing browser session (persistent context).
 *
 * One upload per navigation cycle. After each successful schedule,
 * returns control so the caller can tag the short as uploaded in the DB.
 *
 * UI Flow (mapped from Meta Business Suite / Professional Dashboard):
 *   1. Navigate to facebook.com/professional_dashboard
 *   2. Click "Content" in left sidebar
 *   3. Click "Scheduled" tab (if not already active)
 *   4. Click "Create" button (top-right area)
 *   5. Select "Reel" from create menu
 *   6. Upload: click "+" or file input → set video file
 *   7. Click "Next"
 *   8. Description field → type SEO text (description + hashtags + CTA)
 *   9. Click "Next"
 *  10. Scheduling options → click "Schedule for later"
 *  11. Set date via date picker
 *  12. Set time via time picker
 *  13. Click "Schedule" button
 *
 * Selectors are best-effort based on known FB structure. They WILL need
 * refinement during first live test run — Facebook changes DOM frequently.
 */

const { chromium } = require('playwright');
const path = require('path');

// ── Timeout defaults ──
const NAV_TIMEOUT = 30000;
const CLICK_TIMEOUT = 15000;
const UPLOAD_TIMEOUT = 180000; // Video upload can take a while (3 min for large files)
const POST_UPLOAD_SETTLE = 15000; // Wait for FB to process uploaded video
const POST_CLICK_SETTLE = 3000;  // Standard settle after a UI click
const POST_NAV_SETTLE = 4000;    // Settle after navigation/page load
const POST_SCHEDULE_CONFIRM = 10000; // Wait for FB to confirm scheduled post
const DESCRIPTION_TYPE_DELAY = 15; // ms between keystrokes (avoid FB's anti-bot)

// ── Selectors (best-effort — refine during live testing) ──
// These use text-based and role-based selectors for resilience.
const SELECTORS = {
  // Left nav
  contentLink: 'a:has-text("Content"), [role="link"]:has-text("Content")',

  // Content tabs
  scheduledTab: '[role="tab"]:has-text("Scheduled"), button:has-text("Scheduled")',

  // Create button
  createButton: 'div[role="button"]:has-text("Create"), button:has-text("Create")',

  // Create menu — Reel option
  reelOption: '[role="menuitem"]:has-text("Reel"), [role="option"]:has-text("Reel"), div:has-text("Reel"):near(div:has-text("Create"))',

  // Upload area — file input or clickable zone
  fileInput: 'input[type="file"][accept*="video"]',
  uploadButton: '[role="button"]:has-text("Add video"), [role="button"]:has-text("Upload"), [aria-label*="upload" i]',

  // Next button (appears in reel creation wizard)
  nextButton: '[role="button"]:has-text("Next"), button:has-text("Next")',

  // Description / caption textarea
  descriptionField: '[role="textbox"][aria-label*="description" i], [role="textbox"][aria-label*="caption" i], textarea[aria-label*="description" i], div[contenteditable="true"][aria-label*="Write"]',

  // Scheduling
  scheduleForLaterOption: '[role="radio"]:has-text("Schedule"), [role="button"]:has-text("Schedule for later"), label:has-text("Schedule")',
  dateInput: 'input[aria-label*="date" i], input[type="date"]',
  timeInput: 'input[aria-label*="time" i], input[type="time"]',

  // Final schedule button
  scheduleButton: '[role="button"]:has-text("Schedule"):not(:has-text("for later")), button:has-text("Schedule"):not(:has-text("for later"))',
};

class FacebookUploader {
  /**
   * @param {object} options
   * @param {string} options.userDataDir - Chrome user data directory (for persistent login)
   * @param {boolean} options.headless - Run headless (default: false — user needs to see flow)
   * @param {function} options.log - Logger function
   * @param {function} options.onStepComplete - Callback after each step for UI progress
   */
  constructor(options = {}) {
    this.userDataDir = options.userDataDir || null;
    this.headless = options.headless || false;
    this.log = options.log || console.log;
    this.onStepComplete = options.onStepComplete || (() => {});
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  /**
   * Launch browser with persistent context (user stays logged in).
   * Call once at the start of a scheduling session.
   */
  async launch() {
    if (this.userDataDir) {
      // Persistent context — retains cookies/login
      this.context = await chromium.launchPersistentContext(this.userDataDir, {
        headless: this.headless,
        viewport: { width: 1400, height: 900 },
        args: ['--disable-blink-features=AutomationControlled'],
      });
      this.page = this.context.pages()[0] || await this.context.newPage();
    } else {
      // Non-persistent — user must already be logged in in this browser
      this.browser = await chromium.launch({
        headless: this.headless,
        args: ['--disable-blink-features=AutomationControlled'],
      });
      this.context = await this.browser.newContext({
        viewport: { width: 1400, height: 900 },
      });
      this.page = await this.context.newPage();
    }

    this.log('[FB-UPLOAD] Browser launched');
  }

  /**
   * Schedule a single reel on Facebook.
   *
   * @param {object} short - { filePath, description, scheduledDate, scheduledTime }
   * @returns {object} { success, error?, facebookPostId? }
   */
  async scheduleReel(short) {
    const { filePath, description, scheduledDate, scheduledTime } = short;

    if (!fs.existsSync(filePath)) {
      return { success: false, error: `Video file not found: ${filePath}` };
    }

    try {
      // Step 1: Navigate to Professional Dashboard
      this.log('[FB-UPLOAD] Step 1: Navigating to Professional Dashboard');
      await this.page.goto('https://www.facebook.com/professional_dashboard', {
        waitUntil: 'domcontentloaded',
        timeout: NAV_TIMEOUT,
      });
      await this.page.waitForTimeout(POST_NAV_SETTLE);
      this.onStepComplete('navigate');

      // Step 2: Click "Content" in left nav
      this.log('[FB-UPLOAD] Step 2: Clicking Content');
      await this._clickWithFallback(SELECTORS.contentLink);
      await this.page.waitForTimeout(POST_NAV_SETTLE);
      this.onStepComplete('content');

      // Step 3: Click "Scheduled" tab
      this.log('[FB-UPLOAD] Step 3: Clicking Scheduled tab');
      await this._clickWithFallback(SELECTORS.scheduledTab);
      await this.page.waitForTimeout(POST_CLICK_SETTLE);
      this.onStepComplete('scheduled_tab');

      // Step 4: Click "Create"
      this.log('[FB-UPLOAD] Step 4: Clicking Create');
      await this._clickWithFallback(SELECTORS.createButton);
      await this.page.waitForTimeout(POST_CLICK_SETTLE);
      this.onStepComplete('create');

      // Step 5: Select "Reel"
      this.log('[FB-UPLOAD] Step 5: Selecting Reel');
      await this._clickWithFallback(SELECTORS.reelOption);
      await this.page.waitForTimeout(POST_NAV_SETTLE);
      this.onStepComplete('reel_selected');

      // Step 6: Upload video file
      this.log(`[FB-UPLOAD] Step 6: Uploading video: ${path.basename(filePath)}`);
      await this._uploadVideo(filePath);
      // Wait for FB to fully process the uploaded video (progress bar, thumbnail gen)
      this.log('[FB-UPLOAD] Step 6b: Waiting for upload processing...');
      await this._waitForUploadProcessing();
      this.onStepComplete('uploaded');

      // Step 7: Click "Next" (after upload — button only enables when processing done)
      this.log('[FB-UPLOAD] Step 7: Clicking Next (post-upload)');
      await this._waitAndClick(SELECTORS.nextButton, UPLOAD_TIMEOUT);
      await this.page.waitForTimeout(POST_UPLOAD_SETTLE);
      this.onStepComplete('next_1');

      // Step 8: Enter description
      this.log('[FB-UPLOAD] Step 8: Entering description');
      await this._enterDescription(description);
      await this.page.waitForTimeout(POST_CLICK_SETTLE);
      this.onStepComplete('description');

      // Step 9: Click "Next" (after description)
      this.log('[FB-UPLOAD] Step 9: Clicking Next (post-description)');
      await this._clickWithFallback(SELECTORS.nextButton);
      await this.page.waitForTimeout(POST_NAV_SETTLE);
      this.onStepComplete('next_2');

      // Step 10: Select "Schedule for later"
      this.log('[FB-UPLOAD] Step 10: Selecting Schedule for later');
      await this._clickWithFallback(SELECTORS.scheduleForLaterOption);
      await this.page.waitForTimeout(POST_CLICK_SETTLE);
      this.onStepComplete('schedule_option');

      // Step 11: Set date
      this.log(`[FB-UPLOAD] Step 11: Setting date: ${scheduledDate}`);
      await this._setScheduleDate(scheduledDate);
      await this.page.waitForTimeout(POST_CLICK_SETTLE);
      this.onStepComplete('date_set');

      // Step 12: Set time
      this.log(`[FB-UPLOAD] Step 12: Setting time: ${scheduledTime}`);
      await this._setScheduleTime(scheduledTime);
      await this.page.waitForTimeout(POST_CLICK_SETTLE);
      this.onStepComplete('time_set');

      // Step 13: Click "Schedule" button
      this.log('[FB-UPLOAD] Step 13: Clicking Schedule');
      await this._clickWithFallback(SELECTORS.scheduleButton);
      // Wait for FB to confirm the schedule (toast/redirect/UI update)
      this.log('[FB-UPLOAD] Step 13b: Waiting for schedule confirmation...');
      await this._waitForScheduleConfirmation();
      this.onStepComplete('scheduled');

      this.log('[FB-UPLOAD] ✓ Reel scheduled successfully');
      return { success: true };

    } catch (error) {
      this.log(`[FB-UPLOAD] ✗ Failed: ${error.message}`);

      // Take screenshot for debugging
      try {
        const screenshotPath = path.join(path.dirname(filePath), `fb_error_${Date.now()}.png`);
        await this.page.screenshot({ path: screenshotPath, fullPage: true });
        this.log(`[FB-UPLOAD] Error screenshot saved: ${screenshotPath}`);
      } catch (_) {}

      return { success: false, error: error.message };
    }
  }

  /**
   * Close browser session.
   */
  async close() {
    if (this.context) await this.context.close();
    if (this.browser) await this.browser.close();
    this.log('[FB-UPLOAD] Browser closed');
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PRIVATE — UI INTERACTION HELPERS
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Click using primary selector with fallback to alternatives.
   */
  async _clickWithFallback(selectorString) {
    const selectors = selectorString.split(', ');
    for (const sel of selectors) {
      try {
        const el = await this.page.waitForSelector(sel.trim(), { timeout: CLICK_TIMEOUT });
        if (el) {
          await el.click();
          return;
        }
      } catch (_) {
        // Try next selector
      }
    }
    // Final fallback: try getByText for common patterns
    const textMatch = selectorString.match(/has-text\("([^"]+)"\)/);
    if (textMatch) {
      try {
        await this.page.getByText(textMatch[1], { exact: false }).first().click({ timeout: CLICK_TIMEOUT });
        return;
      } catch (_) {}
    }
    throw new Error(`Could not find clickable element: ${selectorString.slice(0, 80)}...`);
  }

  /**
   * Wait for an element and click it (longer timeout for upload processing).
   */
  async _waitAndClick(selectorString, timeout = CLICK_TIMEOUT) {
    const selectors = selectorString.split(', ');
    for (const sel of selectors) {
      try {
        const el = await this.page.waitForSelector(sel.trim(), { timeout });
        if (el) {
          // Wait for button to become enabled
          await this.page.waitForTimeout(500);
          await el.click();
          return;
        }
      } catch (_) {}
    }
    throw new Error(`Timed out waiting for element: ${selectorString.slice(0, 80)}...`);
  }

  /**
   * Upload video via file input element.
   * Note: post-upload processing wait is handled by _waitForUploadProcessing().
   */
  async _uploadVideo(filePath) {
    // Try to find a file input first (most reliable)
    try {
      const fileInput = await this.page.waitForSelector(SELECTORS.fileInput, { timeout: 5000 });
      if (fileInput) {
        await fileInput.setInputFiles(filePath);
        // Brief settle — actual processing wait is in _waitForUploadProcessing()
        await this.page.waitForTimeout(POST_CLICK_SETTLE);
        return;
      }
    } catch (_) {}

    // Fallback: click upload button which should trigger file chooser
    const [fileChooser] = await Promise.all([
      this.page.waitForEvent('filechooser', { timeout: CLICK_TIMEOUT }),
      this._clickWithFallback(SELECTORS.uploadButton),
    ]);
    await fileChooser.setFiles(filePath);
    // Brief settle — actual processing wait is in _waitForUploadProcessing()
    await this.page.waitForTimeout(POST_CLICK_SETTLE);
  }

  /**
   * Wait for Facebook to finish processing the uploaded video.
   * Polls for: progress bar disappearing, "Next" button becoming enabled,
   * or thumbnail preview appearing. Falls back to fixed timeout.
   */
  async _waitForUploadProcessing() {
    const POLL_INTERVAL = 3000;
    const MAX_WAIT = UPLOAD_TIMEOUT; // 3 minutes max
    const startTime = Date.now();

    while (Date.now() - startTime < MAX_WAIT) {
      // Check if "Next" button is present and enabled (FB enables it when upload is done)
      try {
        const nextBtn = await this.page.$(SELECTORS.nextButton.split(', ')[0]);
        if (nextBtn) {
          const isDisabled = await nextBtn.getAttribute('aria-disabled');
          if (isDisabled !== 'true') {
            this.log('[FB-UPLOAD] Upload processing complete (Next button enabled)');
            return;
          }
        }
      } catch (_) {}

      // Check if progress indicator is gone (FB shows a spinner/progress bar during upload)
      try {
        const spinner = await this.page.$('[role="progressbar"], [aria-label*="uploading" i], [aria-label*="processing" i]');
        if (!spinner) {
          // No spinner — check if we've waited at least the minimum settle time
          if (Date.now() - startTime >= POST_UPLOAD_SETTLE) {
            this.log('[FB-UPLOAD] Upload processing complete (no progress indicator)');
            return;
          }
        }
      } catch (_) {}

      await this.page.waitForTimeout(POLL_INTERVAL);
    }

    // Fallback: max wait reached, proceed anyway
    this.log('[FB-UPLOAD] Upload processing timeout reached — proceeding');
  }

  /**
   * Enter description/caption text into the reel editor.
   */
  async _enterDescription(description) {
    const selectors = SELECTORS.descriptionField.split(', ');
    for (const sel of selectors) {
      try {
     