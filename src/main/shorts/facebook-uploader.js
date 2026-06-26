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
const fs = require('fs');

// ── Timeout defaults ──
const NAV_TIMEOUT = 30000;
const CLICK_TIMEOUT = 20000;
const LOGIN_WAIT_TIMEOUT = 180000; // 3 minutes for login + 2FA
const UPLOAD_TIMEOUT = 180000; // Video upload can take a while (3 min for large files)
const POST_UPLOAD_SETTLE = 15000; // Wait for FB to process uploaded video
const POST_CLICK_SETTLE = 4000;  // Standard settle after a UI click
const POST_NAV_SETTLE = 6000;    // Settle after navigation/page load
const POST_SCHEDULE_CONFIRM = 15000; // Legacy toast/dialog confirmation wait
const POST_SCHEDULE_POST_CLICK_SETTLE = 30000; // Quiet period after final Schedule click
const POST_SCHEDULE_MIN_SETTLE = 30000; // Let FB finish the schedule action before confirmation probes
const POST_SCHEDULE_SETTLE_TIMEOUT = 60000;
const POST_SCHEDULE_IN_PLACE_CONFIRM = 30000;
const POST_SCHEDULE_REFRESH_CONFIRM = 90000;
const POST_SCHEDULE_REFRESH_EVERY = 15000;
const FACEBOOK_MAX_SCHEDULE_DAYS_AHEAD = 29;

// ── Dynamic readiness — adaptive wait based on FB DOM hydration ──
// Adapted from Kling automation's DYNAMIC READINESS WAIT pattern.
// FB's SPA loads fast but React hydration is slow — elements exist in DOM
// but aren't interactive until hydration completes.
const READINESS_MAX_WAIT = 15000;
const READINESS_POLL_INTERVAL = 1000;
const READINESS_CHECKS = [
  // 1. Content Library heading
  { name: 'contentLibrary', fn: (page) => page.$('text=Content Library').then(el => !!el).catch(() => false) },
  // 2. "+ Create" button visible
  { name: 'createButton', fn: (page) => page.$('[role="button"]:has-text("Create")').then(el => !!el).catch(() => false) },
  // 3. Tab bar (Published/Scheduled/Drafts)
  { name: 'tabBar', fn: (page) => page.$('text=Scheduled').then(el => !!el).catch(() => false) },
  // 4. No loading spinner
  { name: 'noSpinner', fn: (page) => page.$('[role="progressbar"]').then(el => !el).catch(() => true) },
];
const DESCRIPTION_TYPE_DELAY = 15; // ms between keystrokes (avoid FB's anti-bot)

// ── Selectors (refined from live testing — May 2026 Facebook UI) ──
// IMPORTANT: Facebook DOM changes frequently. These were verified against
// the Professional Dashboard → Content Library → Create Reel flow.
const SELECTORS = {
  // Left nav — "Content" sidebar link (has chevron ">")
  contentLink: 'a:has-text("Content"), [role="link"]:has-text("Content"), span:text("Content")',

  // Content Library tabs — plain text links, NOT role="tab"
  // "Published | Scheduled | Drafts" in the Content Library header
  scheduledTab: 'span:text("Scheduled"), a:text("Scheduled")',

  // "+ Create" dropdown button (blue, with dropdown arrow)
  createButton: 'div[role="button"]:has-text("Create"), span:text("Create")',

  // Create menu items — Post, Story, Reel, Bulk upload reels
  reelOption: '[role="menuitem"]:has-text("Reel"), span:text("Reel")',

  // Upload area — file input or the "Add video" clickable zone
  fileInput: 'input[type="file"][accept*="video"], input[type="file"]',
  uploadButton: '[role="button"]:has-text("Add video"), span:text("Add video")',

  // "Upload" button at bottom of Create Reel panel (before video is selected)
  uploadSubmitButton: 'div[role="button"]:has-text("Upload"):not(:has-text("Bulk")), span:text("Upload")',

  // Next button (appears in reel creation wizard — after upload, after description)
  nextButton: 'div[role="button"]:has-text("Next"), span:text("Next")',

  // Description / caption field — "Describe your reel..." placeholder
  descriptionField: 'div[contenteditable="true"][aria-placeholder*="Describe"], div[contenteditable="true"][data-placeholder*="Describe"], div[contenteditable="true"]',

  // Reel Settings page — "Scheduling options" row (shows "Publish now" by default)
  schedulingOptionsRow: 'div:has-text("Scheduling options"):has-text("Publish now"), span:text("Scheduling options")',

  // Scheduling options sub-panel — Date and Time input fields
  // Date field shows "May 2, 2026" format; Time field shows "10:34 AM" format
  dateInput: 'input[aria-label*="date" i], input[aria-label*="Date" i]',
  timeInput: 'input[aria-label*="time" i], input[aria-label*="Time" i]',

  // "Schedule for later" button inside the scheduling sub-panel
  scheduleForLaterButton: 'div[role="button"]:has-text("Schedule for later"), span:text("Schedule for later")',

  // Final "Schedule" button (appears AFTER date/time are set, replaces "Post")
  scheduleButton: 'div[role="button"]:has-text("Schedule"):not(:has-text("for later")):not(:has-text("Scheduling")), span:text-is("Schedule")',

  // "Post" button (default before scheduling is set — we should NOT click this)
  postButton: 'div[role="button"]:has-text("Post")',
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
    this.nowProvider = options.nowProvider || (() => new Date());
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  static _parseDateOnly(dateStr) {
    if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr))) return null;
    const [year, month, day] = String(dateStr).split('-').map(n => parseInt(n, 10));
    if (!year || month < 1 || month > 12 || day < 1 || day > 31) return null;
    return new Date(year, month - 1, day);
  }

  static _formatDateOnly(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  static _addDaysDateOnly(date, days) {
    const copy = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    copy.setDate(copy.getDate() + days);
    return copy;
  }

  static getScheduleWindow(now = new Date()) {
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const maxDate = FacebookUploader._addDaysDateOnly(today, FACEBOOK_MAX_SCHEDULE_DAYS_AHEAD);
    return {
      today: FacebookUploader._formatDateOnly(today),
      maxDate: FacebookUploader._formatDateOnly(maxDate),
      maxDaysAhead: FACEBOOK_MAX_SCHEDULE_DAYS_AHEAD,
    };
  }

  static getScheduleWindowError(scheduledDate, now = new Date()) {
    const window = FacebookUploader.getScheduleWindow(now);
    return `FACEBOOK_SCHEDULE_WINDOW: Facebook allows scheduling up to ${window.maxDaysAhead} days in advance. Today ${window.today}; max schedule date ${window.maxDate}; ${scheduledDate} must be deferred.`;
  }

  static isWithinScheduleWindow(scheduledDate, now = new Date()) {
    const target = FacebookUploader._parseDateOnly(scheduledDate);
    if (!target) return false;
    const { maxDate } = FacebookUploader.getScheduleWindow(now);
    return FacebookUploader._formatDateOnly(target) <= maxDate;
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

    // Navigate to Facebook and wait for the user to be logged in
    await this._waitForLogin();
  }

  /**
   * Navigate to Facebook and wait for the user to be fully logged in.
   * If not already logged in, waits up to LOGIN_WAIT_TIMEOUT for the user
   * to complete login + 2FA manually. Polls for a known logged-in indicator.
   */
  async _waitForLogin() {
    this.log('[FB-UPLOAD] Navigating to Facebook — checking login status...');
    await this.page.goto('https://www.facebook.com/', {
      waitUntil: 'domcontentloaded',
      timeout: NAV_TIMEOUT,
    });
    await this.page.waitForTimeout(3000);

    // Check if already logged in — look for profile/avatar indicators
    const isLoggedIn = async () => {
      try {
        // Multiple indicators of a logged-in Facebook session:
        // 1. Profile link/avatar in the top nav
        // 2. Notifications bell icon
        // 3. Create post area on the feed
        // 4. URL not being /login or containing login_attempt
        const url = this.page.url();
        if (url.includes('/login') || url.includes('login_attempt')) return false;

        const loggedInIndicators = [
          '[aria-label="Your profile"]',
          '[aria-label="Account"]',
          '[aria-label="Notifications"]',
          '[aria-label="Messenger"]',
          '[role="banner"] [role="navigation"]',
          'div[role="navigation"] a[href*="/me"]',
        ];
        for (const sel of loggedInIndicators) {
          const el = await this.page.$(sel);
          if (el) return true;
        }
        return false;
      } catch (_) {
        return false;
      }
    };

    // Dismiss any popups that appear on initial load (shortcuts dialog, banners, etc.)
    await this._dismissPopups();

    if (await isLoggedIn()) {
      this.log('[FB-UPLOAD] Already logged in — proceeding');
      return;
    }

    // Not logged in — wait for user to complete login + 2FA
    this.log('[FB-UPLOAD] Not logged in — waiting for you to log in and complete 2FA...');
    this.log('[FB-UPLOAD] You have 3 minutes. The upload will start automatically once logged in.');

    const startTime = Date.now();
    const POLL_INTERVAL = 3000;

    while (Date.now() - startTime < LOGIN_WAIT_TIMEOUT) {
      await this.page.waitForTimeout(POLL_INTERVAL);

      if (await isLoggedIn()) {
        this.log('[FB-UPLOAD] Login detected — proceeding with uploads');
        // Extra settle time after login for page to fully load
        await this.page.waitForTimeout(3000);
        return;
      }

      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const remaining = Math.round((LOGIN_WAIT_TIMEOUT - (Date.now() - startTime)) / 1000);
      this.log(`[FB-UPLOAD] Still waiting for login... (${elapsed}s elapsed, ${remaining}s remaining)`);
    }

    throw new Error('Login timeout — could not detect a logged-in Facebook session after 3 minutes. Please log in and try again.');
  }

  /**
   * Schedule a single reel on Facebook.
   *
   * @param {object} short - { filePath, description, scheduledDate, scheduledTime }
   * @returns {object} { success, error?, facebookPostId? }
   */
  async scheduleReel(short) {
    const { filePath, description, scheduledDate, scheduledTime } = short;

    if (!FacebookUploader.isWithinScheduleWindow(scheduledDate, this.nowProvider())) {
      return { success: false, deferred: true, error: FacebookUploader.getScheduleWindowError(scheduledDate, this.nowProvider()) };
    }

    if (!fs.existsSync(filePath)) {
      return { success: false, error: `Video file not found: ${filePath}` };
    }

    try {
      // ── Step 1: Navigate to Content Library (direct URL — faster than dashboard → content)
      this.log('[FB-UPLOAD] Step 1: Navigating to Content Library');
      await this._reloadScheduledLibrary();
      await this._dismissPopups(); // FB shows popups on first load (shortcuts, banners, etc.)
      this.onStepComplete('navigate');

      const preExistingMatch = await this._hasScheduledReel(description);
      if (preExistingMatch) {
        this.log('[FB-UPLOAD] Matching Reel already exists in Scheduled tab — treating as scheduled');
        return { success: true, recovered: true };
      }
      const scheduledRowBaseline = (await this._getScheduledPostRows()).length;
      this.log(`[FB-UPLOAD] Scheduled row baseline before upload: ${scheduledRowBaseline}`);

      // ── Step 2: Click "+ Create" dropdown (with retry — FB DOM can be slow)
      this.log('[FB-UPLOAD] Step 2: Clicking + Create');
      await this._retryStep('Step 2 (Create)', async () => {
        await this._clickWithFallback(SELECTORS.createButton);
      });
      await this.page.waitForTimeout(POST_CLICK_SETTLE);
      this.onStepComplete('create');

      let reelFileChooser = null;
      // ── Step 3: Select "Reel" from dropdown menu (with retry)
      this.log('[FB-UPLOAD] Step 3: Selecting Reel');
      await this._retryStep('Step 3 (Reel)', async () => {
        const fileChooserPromise = this.page.waitForEvent('filechooser', { timeout: 20000 }).catch(() => null);
        // The dropdown has: Post, Story, Reel, Bulk upload reels
        // Use getByText for exact match to avoid hitting "Bulk upload reels"
        try {
          await this._clickCreateMenuReel();
        } catch (_) {
          await this._clickWithFallback(SELECTORS.reelOption);
        }
        reelFileChooser = await fileChooserPromise;
      });
      this.log(reelFileChooser
        ? '[FB-UPLOAD] Reel menu opened native file chooser'
        : '[FB-UPLOAD] Reel menu did not open a file chooser; will use composer upload fallback');
      await this.page.waitForTimeout(POST_NAV_SETTLE);
      await this._dismissPopups();
      this.onStepComplete('reel_selected');

      // ── Step 4: Upload video file
      // "Create reel" modal appears with "Add video / or drag and drop" area
      this.log(`[FB-UPLOAD] Step 4: Uploading video: ${path.basename(filePath)}`);
      await this._uploadVideo(filePath, reelFileChooser);
      this.log('[FB-UPLOAD] Step 4b: Waiting for upload processing...');
      await this._waitForUploadProcessing();
      this.onStepComplete('uploaded');

      // Current Facebook Reels composer keeps caption + schedule controls on
      // the same full-page composer after upload. Do not click the old Next
      // wizard steps unless the UI explicitly changes back.
      this.log('[FB-UPLOAD] Step 5: Waiting for composer controls after upload');
      await this._waitForReelComposerReady();

      this.log('[FB-UPLOAD] Step 6: Entering description');
      await this._enterDescription(description);
      await this.page.waitForTimeout(POST_CLICK_SETTLE);
      this.onStepComplete('description');

      this.log('[FB-UPLOAD] Step 7: Opening scheduling modal');
      await this._scrollComposerToBottom();
      await this._clickComposerScheduleButton();
      await this.page.waitForTimeout(POST_CLICK_SETTLE);

      try {
        const debugPath = path.join(path.dirname(filePath), `fb_debug_schedule_panel_${Date.now()}.png`);
        await this.page.screenshot({ path: debugPath, fullPage: false });
        this.log(`[FB-UPLOAD] Debug screenshot of scheduling panel: ${debugPath}`);
      } catch (_) {}

      this.onStepComplete('scheduling_opened');

      this.log(`[FB-UPLOAD] Step 8: Setting date: ${scheduledDate}`);
      await this._setScopedScheduleDate(scheduledDate);
      await this.page.waitForTimeout(1000);
      this.onStepComplete('date_set');

      this.log(`[FB-UPLOAD] Step 9: Setting time: ${scheduledTime}`);
      await this._setScopedScheduleTime(scheduledTime);
      await this.page.waitForTimeout(1000);
      this.onStepComplete('time_set');

      this.log('[FB-UPLOAD] Step 10: Clicking Schedule for later');
      await this._retryStep('Step 10 (Schedule for later)', async () => {
        await this._clickScheduleForLater();
      });
      await this.page.waitForTimeout(POST_CLICK_SETTLE);
      this.onStepComplete('schedule_for_later');

      this.log('[FB-UPLOAD] Step 11: Clicking Schedule post');
      await this._clickComposerSubmitButton();
      this.log(`[FB-UPLOAD] Step 11b: Waiting ${POST_SCHEDULE_POST_CLICK_SETTLE / 1000}s after Schedule click for Facebook to settle...`);
      await this.page.waitForTimeout(POST_SCHEDULE_POST_CLICK_SETTLE);
      this.log('[FB-UPLOAD] Step 11c: Waiting for schedule confirmation...');
      await this._waitForReelScheduleConfirmation(description, scheduledRowBaseline, {
        scheduledDate,
        scheduledTime,
        alreadySettledMs: POST_SCHEDULE_POST_CLICK_SETTLE,
      });
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
   * Dismiss any Facebook popup/dialog/overlay that blocks the main UI.
   * Facebook randomly shows these: keyboard shortcuts, cookie consent,
   * "videos are now reels" banners, notification permission prompts, etc.
   *
   * Called automatically before every click action to keep the flow clear.
   *
   * IMPORTANT: Uses page.locator() / page.getByText() — NOT page.$() —
   * because text-based matching requires Playwright's locator engine.
   */
  async _dismissPopups() {
    // Each entry: a function that returns a locator + a label for logging
    const popups = [
      {
        // "Keep single-character shortcuts turned on?" dialog
        // Click "Turn off" to prevent FB shortcuts interfering with keyboard.type()
        find: () => this.page.locator('[role="dialog"]').getByText('Turn off', { exact: true }),
        label: 'keyboard shortcuts dialog',
      },
      {
        // Cookie consent / privacy banner
        find: () => this.page.locator('button[data-cookiebanner="accept_button"]'),
        label: 'cookie consent',
      },
      {
        // Cookie consent variant
        find: () => this.page.locator('[data-testid="cookie-policy-manage-dialog-accept-button"]'),
        label: 'cookie consent (testid)',
      },
      {
        // "Videos are now reels" info banner — dismiss X
        find: () => this.page.locator('[aria-label="Dismiss"]'),
        label: 'dismiss banner',
      },
      {
        // Notification permission prompt — "Not now"
        find: () => this.page.locator('[role="dialog"]').getByText('Not now', { exact: true }),
        label: 'notification prompt',
      },
      // NOTE: Do NOT add a generic "dialog close button" handler here!
      // It will close the Create Reel / Edit Reel wizard dialogs.
    ];

    for (const popup of popups) {
      try {
        const locator = popup.find();
        if (await locator.count() > 0) {
          // Verify it's visible before clicking
          const box = await locator.first().boundingBox();
          if (box) {
            await locator.first().click({ timeout: 3000 });
            this.log(`[FB-UPLOAD] Dismissed popup: ${popup.label}`);
            await this.page.waitForTimeout(1000);
            // Recurse — sometimes dismissing one reveals another
            return this._dismissPopups();
          }
        }
      } catch (_) {}
    }

    // Escape fallback for any unmatched dialog — but protect our reel wizard
    try {
      const dialogs = this.page.locator('[role="dialog"]');
      if (await dialogs.count() > 0) {
        const text = await dialogs.first().textContent().catch(() => '');
        const isOurWizard = text && (
          text.includes('Create reel') ||
          text.includes('Edit reel') ||
          text.includes('Reel settings') ||
          text.includes('Scheduling options') ||
          text.includes('Schedule for later') ||
          text.includes('Add video') ||
          text.includes('Describe your reel') ||
          /Post\s+Story\s+Reel/i.test(text) ||
          /Story\s+Reel\s+Bulk upload reels/i.test(text)
        );
        if (!isOurWizard) {
          await this.page.keyboard.press('Escape');
          this.log('[FB-UPLOAD] Dismissed popup: unknown dialog (Escape)');
          await this.page.waitForTimeout(1000);
        }
      }
    } catch (_) {}
  }

  /**
   * Dynamic readiness wait — polls for key FB UI indicators before proceeding.
   * Adapted from Kling automation's DYNAMIC READINESS WAIT pattern:
   *   - Poll for multiple DOM indicators of a fully loaded page
   *   - Threshold: ≥75% of checks must pass
   *   - Buffer: add 10% of elapsed time as extra settle
   *
   * Call after navigation to ensure FB's SPA has fully hydrated.
   */
  async _waitForPageReady() {
    const startTime = Date.now();
    const threshold = Math.ceil(READINESS_CHECKS.length * 0.75);
    let passedCount = 0;

    for (let attempt = 0; attempt < 15; attempt++) {
      passedCount = 0;
      for (const check of READINESS_CHECKS) {
        if (await check.fn(this.page)) passedCount++;
      }

      if (passedCount >= threshold) break;

      if (Date.now() - startTime > READINESS_MAX_WAIT) {
        this.log(`[FB-UPLOAD] Page readiness timeout: ${passedCount}/${READINESS_CHECKS.length} checks after ${READINESS_MAX_WAIT / 1000}s`);
        break;
      }

      await this.page.waitForTimeout(READINESS_POLL_INTERVAL);
    }

    // Buffer: add 10% of elapsed time as extra settle (like Kling pattern)
    const elapsed = Date.now() - startTime;
    const buffer = Math.max(1000, Math.round(elapsed * 0.1));
    this.log(`[FB-UPLOAD] Page ready: ${passedCount}/${READINESS_CHECKS.length} checks in ${(elapsed / 1000).toFixed(1)}s — ${buffer}ms buffer`);
    await this.page.waitForTimeout(buffer);
  }

  /**
   * PRE-UPLOAD RECOVERY — "Disk Recovery" pattern from Higgsfield.
   *
   * Before starting the upload flow for a short, check if a reel matching
   * this short already exists in the Scheduled tab. This handles:
   *   - Previous upload that succeeded but was marked as failed (automation
   *     crashed after FB confirmed but before DB was updated)
   *   - Manual uploads the user did outside the pipeline
   *   - Re-runs after a crash where the reel was actually created
   *
   * Matches by description text (first 40 chars of the SEO description).
   * Returns { alreadyScheduled: true/false, matchText?: string }
   */
  /**
   * Retry a step function up to maxRetries times with exponential backoff.
   * @param {string} stepName - For logging
   * @param {function} fn - Async function to retry
   * @param {number} maxRetries - Max attempts (default: 2 = 1 try + 1 retry)
   * @param {number} baseDelay - Initial delay in ms before retry (default: 3000)
   */
  async _retryStep(stepName, fn, maxRetries = 2, baseDelay = 3000) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (attempt === maxRetries) throw err;
        const delay = baseDelay * attempt; // Linear backoff: 3s, 6s, 9s...
        this.log(`[FB-UPLOAD] ${stepName} failed (attempt ${attempt}/${maxRetries}): ${err.message} — retrying in ${delay / 1000}s`);
        await this.page.waitForTimeout(delay);
        await this._dismissPopups();
      }
    }
  }

  async _openScheduledTab() {
    try {
      const clicked = await this._clickVisibleControlByText(/^Scheduled$/i, { preferRole: 'button' });
      if (clicked) {
        await this.page.waitForTimeout(1500);
        return;
      }
    } catch (_) {}
    try {
      await this.page.getByText('Scheduled', { exact: true }).first().click({ timeout: 5000 });
      await this.page.waitForTimeout(1500);
    } catch (_) {}
  }

  async _reloadScheduledLibrary() {
    await this.page.goto('https://www.facebook.com/professional_dashboard/content/content_library/?filter=SCHEDULED', {
      waitUntil: 'domcontentloaded',
      timeout: NAV_TIMEOUT,
    });
    await this._waitForPageReady();
    await this._openScheduledTab();
    await this.page.waitForTimeout(2500);
  }

  async _clickCreateMenuReel() {
    const clicked = await this._clickVisibleControlByText(/^Reel$/i, { preferRole: 'menuitem' });
    if (clicked) return;
    await this.page.getByText('Reel', { exact: true }).click({ timeout: CLICK_TIMEOUT });
  }

  /**
   * Click using primary selector with fallback to alternatives.
   */
  async _clickWithFallback(selectorString) {
    // Dismiss any blocking popups first
    await this._dismissPopups();

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
    // Dismiss any blocking popups first
    await this._dismissPopups();

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

  _activeDialog() {
    return this.page.locator('[role="dialog"]').last();
  }

  async _waitForReelComposerReady() {
    const start = Date.now();
    const timeoutMs = 90000;
    while (Date.now() - start < timeoutMs) {
      const state = await this.page.evaluate(() => {
        const text = document.body.innerText || document.body.textContent || '';
        const hasCaption = /Describe your reel|Enter caption|caption/i.test(text);
        const hasSchedule = /\bSchedule\b/i.test(text);
        const safe = /safe to publish/i.test(text);
        const hasPreview = !!document.querySelector('video, [aria-label*="video" i], img');
        return { hasCaption, hasSchedule, safe, hasPreview };
      }).catch(() => ({ hasCaption: false, hasSchedule: false, safe: false, hasPreview: false }));
      if ((state.hasCaption && state.hasSchedule) || state.safe || (state.hasPreview && state.hasSchedule)) {
        await this.page.waitForTimeout(1500);
        return;
      }
      await this.page.waitForTimeout(2000);
    }
    throw new Error('Timed out waiting for Reel composer controls after upload');
  }

  async _scrollComposerToBottom() {
    try {
      await this.page.evaluate(() => {
        const dialogs = [...document.querySelectorAll('[role="dialog"]')];
        const dialog = dialogs[dialogs.length - 1];
        const roots = dialog ? [dialog, ...dialog.querySelectorAll('*')] : [document.scrollingElement, ...document.querySelectorAll('*')];
        const scrollables = roots.filter(el => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          return /(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 20;
        });
        for (const el of scrollables) el.scrollTop = el.scrollHeight;
        if (document.scrollingElement) document.scrollingElement.scrollTop = document.scrollingElement.scrollHeight;
      });
      await this.page.mouse.wheel(0, 2000);
      await this.page.waitForTimeout(1000);
    } catch (_) {}
  }

  async _clickVisibleControlByText(pattern, options = {}) {
    const target = await this.page.evaluate(({ source, flags, preferRole, bottomOnly }) => {
      const re = new RegExp(source, flags);
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 1 && rect.height > 1 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const textOf = el => (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
      const all = [...document.querySelectorAll('button, [role="button"], [role="menuitem"], a, label, div')].filter(visible);
      const ranked = all
        .filter(el => re.test(textOf(el)))
        .filter(el => {
          if (!bottomOnly) return true;
          const rect = el.getBoundingClientRect();
          return rect.y > window.innerHeight * 0.6;
        })
        .map(el => {
          const rect = el.getBoundingClientRect();
          const role = el.getAttribute('role') || '';
          let score = 0;
          if (preferRole && role === preferRole) score += 100;
          if (role === 'button' || role === 'menuitem' || el.tagName === 'BUTTON') score += 20;
          if (rect.width > 20 && rect.height > 20) score += 10;
          if (rect.width > 450) score -= 5;
          return { rect, role, text: textOf(el), score };
        })
        .sort((a, b) => b.score - a.score);
      const item = ranked[0];
      if (!item) return null;
      return {
        x: Math.round(item.rect.x + item.rect.width / 2),
        y: Math.round(item.rect.y + item.rect.height / 2),
        text: item.text,
        role: item.role,
      };
    }, { source: pattern.source, flags: pattern.flags, preferRole: options.preferRole || '', bottomOnly: options.bottomOnly === true }).catch(() => null);

    if (!target) return false;
    this.log(`[FB-UPLOAD] Clicking visible control "${target.text}" (${target.role || 'no role'}) at ${target.x},${target.y}`);
    await this.page.mouse.click(target.x, target.y);
    await this.page.waitForTimeout(800);
    return true;
  }

  async _clickComposerScheduleButton() {
    const clicked = await this._clickVisibleControlByText(/^Schedule$/i, { preferRole: 'button', bottomOnly: true });
    if (clicked) return;
    await this._clickWithFallback('div[role="button"]:has-text("Schedule"):not(:has-text("for later")):not(:has-text("Scheduling")), span:text-is("Schedule")');
  }

  async _clickScheduleForLater() {
    const dialog = this._activeDialog();
    const candidates = [
      () => dialog.getByRole('button', { name: /Schedule for later/i }).first(),
      () => dialog.getByText('Schedule for later', { exact: false }).first(),
      () => this.page.getByRole('button', { name: /Schedule for later/i }).first(),
    ];
    for (const getLocator of candidates) {
      try {
        const locator = getLocator();
        if (await locator.count() > 0) {
          await locator.click({ timeout: CLICK_TIMEOUT });
          return;
        }
      } catch (_) {}
    }
    await this._clickWithFallback(SELECTORS.scheduleForLaterButton);
  }

  async _clickComposerSubmitButton() {
    const clicked = await this._clickVisibleControlByText(/^(Schedule post|Post)$/i, { preferRole: 'button', bottomOnly: true });
    if (clicked) return;
    await this._clickWithFallback('div[role="button"][aria-label="Schedule post"], div[role="button"]:has-text("Schedule post"), div[role="button"][aria-label="Post"], div[role="button"]:has-text("Post")');
  }

  async _setScopedScheduleDate(dateStr) {
    const [year, month, day] = dateStr.split('-');
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const fbDate = `${monthNames[parseInt(month, 10) - 1]} ${parseInt(day, 10)}, ${year}`;
    const dialog = this._activeDialog();
    const inputs = dialog.locator('input[type="text"], input:not([type]), input[role="combobox"]');
    const count = await inputs.count();
    for (let i = 0; i < count; i++) {
      const input = inputs.nth(i);
      const value = await input.inputValue().catch(() => '');
      const label = await input.getAttribute('aria-label').catch(() => '');
      if (/date|schedule/i.test(label) || /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/i.test(value) || /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(value)) {
        await input.click({ clickCount: 3, timeout: 5000 });
        await input.fill(fbDate);
        await this.page.keyboard.press('Tab');
        return;
      }
    }
    await this._setScheduleDate(dateStr);
  }

  async _setScopedScheduleTime(timeStr) {
    const [hours, minutes] = timeStr.split(':');
    const h = parseInt(hours, 10);
    const period = h >= 12 ? 'PM' : 'AM';
    const h12 = h > 12 ? h - 12 : (h === 0 ? 12 : h);
    const fbTime = `${h12}:${minutes} ${period}`;
    const dialog = this._activeDialog();
    const inputs = dialog.locator('input[type="text"], input:not([type]), input[role="combobox"]');
    const count = await inputs.count();
    for (let i = 0; i < count; i++) {
      const input = inputs.nth(i);
      const value = await input.inputValue().catch(() => '');
      const label = await input.getAttribute('aria-label').catch(() => '');
      if (/time/i.test(label) || /\b(AM|PM)\b/i.test(value) || /^\d{1,2}:\d{2}/.test(value)) {
        await input.click({ clickCount: 3, timeout: 5000 });
        await input.fill(fbTime);
        await this.page.keyboard.press('Tab');
        return;
      }
    }
    await this._setScheduleTime(timeStr);
  }

  _captionNeedle(description, length = 40) {
    return String(description || '').replace(/\s+/g, ' ').trim().slice(0, length);
  }

  _captionNeedles(description) {
    const normalized = String(description || '').replace(/\s+/g, ' ').trim();
    if (!normalized) return [];
    const firstLine = normalized.split(/\n|#/)[0].trim();
    const firstSentence = normalized.split(/[.!?]\s/)[0].trim();
    return [...new Set([
      normalized.slice(0, 80),
      normalized.slice(0, 50),
      normalized.slice(0, 32),
      firstLine.slice(0, 50),
      firstSentence.slice(0, 50),
    ].map(s => s.trim()).filter(s => s.length >= 12))];
  }

  _scheduledDateNeedles(dateStr) {
    if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr))) return [];
    const [year, monthRaw, dayRaw] = String(dateStr).split('-');
    const month = parseInt(monthRaw, 10);
    const day = parseInt(dayRaw, 10);
    if (!year || month < 1 || month > 12 || day < 1 || day > 31) return [];
    const shortMonths = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const longMonths = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const shortMonth = shortMonths[month - 1];
    const longMonth = longMonths[month - 1];
    return [
      `${year}-${monthRaw}-${dayRaw}`,
      `${shortMonth} ${day}`,
      `${shortMonth} ${day}, ${year}`,
      `${longMonth} ${day}`,
      `${longMonth} ${day}, ${year}`,
      `${month}/${day}/${year}`,
      `${month}/${day}`,
      `${day} ${shortMonth}`,
      `${day} ${longMonth}`,
    ].filter(Boolean);
  }

  _scheduledTimeNeedles(timeStr) {
    if (!timeStr || !/^\d{1,2}:\d{2}$/.test(String(timeStr))) return [];
    const [hoursRaw, minutes] = String(timeStr).split(':');
    const hours = parseInt(hoursRaw, 10);
    if (Number.isNaN(hours) || hours < 0 || hours > 23 || parseInt(minutes, 10) > 59) return [];
    const period = hours >= 12 ? 'PM' : 'AM';
    const h12 = hours > 12 ? hours - 12 : (hours === 0 ? 12 : hours);
    return [
      `${hoursRaw.padStart(2, '0')}:${minutes}`,
      `${hours}:${minutes}`,
      `${h12}:${minutes} ${period}`,
      `${h12}:${minutes}${period}`,
      minutes === '00' ? `${h12} ${period}` : null,
      minutes === '00' ? `${h12}${period}` : null,
    ].filter(Boolean);
  }

  _textHasAnyNeedle(text, needles) {
    const compactText = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const spacelessText = compactText.replace(/\s+/g, '');
    return needles.some(needle => {
      const compactNeedle = String(needle || '').toLowerCase().replace(/\s+/g, ' ').trim();
      if (!compactNeedle) return false;
      return compactText.includes(compactNeedle) || spacelessText.includes(compactNeedle.replace(/\s+/g, ''));
    });
  }

  _findScheduledReelMatch(rows, description, scheduledDate = '', scheduledTime = '') {
    const needles = this._captionNeedles(description);
    if (!needles.length) return null;
    const dateNeedles = this._scheduledDateNeedles(scheduledDate);
    const timeNeedles = this._scheduledTimeNeedles(scheduledTime);

    for (const row of rows || []) {
      const text = row?.text || '';
      if (!this._textHasAnyNeedle(text, needles)) continue;
      const dateMatch = dateNeedles.length ? this._textHasAnyNeedle(text, dateNeedles) : false;
      const timeMatch = timeNeedles.length ? this._textHasAnyNeedle(text, timeNeedles) : false;
      const proof = [
        'caption',
        dateMatch ? 'date' : null,
        timeMatch ? 'time' : null,
      ].filter(Boolean).join('+');
      return { row, proof, dateMatch, timeMatch };
    }

    return null;
  }

  async _getScheduledPostRows() {
    return this.page.evaluate(() => {
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 1 && rect.height > 1 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const norm = text => (text || '').replace(/\s+/g, ' ').trim();
      const textOf = el => norm(el.innerText || el.textContent || '');
      const hasMedia = el => !!el.querySelector('img, video, [aria-label*="video" i], [aria-label*="reel" i]');
      const isScheduledPostRow = (el, text) => {
        const rect = el.getBoundingClientRect();
        if (!/Scheduled/i.test(text) || /No scheduled posts/i.test(text)) return false;
        if (/Content Library|Published Scheduled Drafts|Create|Search for posts|posts selected/i.test(text)) return false;
        if (rect.width < 420 || rect.height < 45 || rect.height > 260) return false;
        if (!hasMedia(el) && !/(Today|Tomorrow|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec).*at\s+\d{1,2}:\d{2}/i.test(text)) return false;
        return true;
      };
      const candidates = [...document.querySelectorAll('[role="row"], tbody tr, div')]
        .filter(visible)
        .map(el => ({ el, text: textOf(el), rect: el.getBoundingClientRect() }))
        .filter(item => isScheduledPostRow(item.el, item.text))
        .sort((a, b) => {
          if (Math.abs(a.rect.y - b.rect.y) > 6) return a.rect.y - b.rect.y;
          return a.rect.width - b.rect.width;
        });
      const rows = [];
      for (const item of candidates) {
        if (rows.some(row => Math.abs(row.y - item.rect.y) < 12 && (row.text.includes(item.text) || item.text.includes(row.text)))) continue;
        rows.push({
          text: item.text,
          key: item.text.slice(0, 300),
          y: Math.round(item.rect.y),
          h: Math.round(item.rect.height),
        });
      }
      return rows;
    }).catch(() => []);
  }

  async _hasScheduledReel(description) {
    const rows = await this._getScheduledPostRows();
    const match = this._findScheduledReelMatch(rows, description);
    if (match) this.log(`[FB-UPLOAD] Existing scheduled Reel row matched: "${match.row.text.slice(0, 120)}"`);
    return !!match;
  }

  async _getScheduleSubmissionState(expectedDescription = '') {
    const captionNeedle = this._captionNeedle(expectedDescription, 80);
    return this.page.evaluate((caption) => {
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 1 && rect.height > 1 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const norm = text => (text || '').replace(/\s+/g, ' ').trim();
      const bodyText = norm(document.body.innerText || document.body.textContent || '');
      const url = location.href;
      const hasSuccessText = /post has been scheduled|reel has been scheduled|your reel.*scheduled|scheduled your reel|successfully scheduled/i.test(bodyText);
      const hasProgressText = /\b(Scheduling|Posting|Processing|Finishing up|Publishing)\b/i.test(bodyText);
      const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(visible);
      const hasComposerDialog = dialogs.some(dialog => {
        const text = norm(dialog.innerText || dialog.textContent || '');
        return /Create reel|Describe your reel|Schedule for later|Schedule post|Reel details/i.test(text);
      });
      const buttons = [...document.querySelectorAll('button, [role="button"]')].filter(visible);
      const hasFinalScheduleButton = buttons.some(button => {
        const text = norm(button.innerText || button.textContent || button.getAttribute('aria-label') || '');
        const rect = button.getBoundingClientRect();
        return /^(Schedule post|Post)$/i.test(text) && rect.y > window.innerHeight * 0.55;
      });
      const onScheduledSurface = /professional_dashboard\/content\/content_library|planner|scheduled/i.test(url) ||
        /Content Library|Planner|Scheduled posts/i.test(bodyText);
      const hasCaptionText = !!caption && bodyText.includes(caption);
      return {
        url,
        hasSuccessText,
        hasProgressText,
        hasComposerDialog,
        hasFinalScheduleButton,
        onScheduledSurface,
        hasCaptionText,
      };
    }, captionNeedle).catch(() => ({
      url: '',
      hasSuccessText: false,
      hasProgressText: false,
      hasComposerDialog: false,
      hasFinalScheduleButton: false,
      onScheduledSurface: false,
      hasCaptionText: false,
    }));
  }

  async _waitForScheduleSubmissionSettle(expectedDescription = '', alreadySettledMs = 0) {
    const start = Date.now();
    let lastState = null;
    while (Date.now() - start < POST_SCHEDULE_SETTLE_TIMEOUT) {
      lastState = await this._getScheduleSubmissionState(expectedDescription);
      const elapsed = alreadySettledMs + (Date.now() - start);
      if (lastState.hasSuccessText && elapsed >= POST_SCHEDULE_MIN_SETTLE) {
        this.log('[FB-UPLOAD] Schedule submit settle: Facebook displayed scheduled success text');
        return lastState;
      }
      const composerGone = !lastState.hasComposerDialog && !lastState.hasFinalScheduleButton && !lastState.hasProgressText;
      if (composerGone && elapsed >= POST_SCHEDULE_MIN_SETTLE) {
        this.log(`[FB-UPLOAD] Schedule submit settle: composer no longer active after ${Math.round(elapsed / 1000)}s`);
        return lastState;
      }
      await this.page.waitForTimeout(3000);
    }
    this.log(`[FB-UPLOAD] Schedule submit settle timed out; continuing to confirmation checks (state=${JSON.stringify(lastState)})`);
    return lastState;
  }

  async _checkScheduledRowsForMatch(expectedDescription, scheduledDate, scheduledTime, baselineCount, phase) {
    const rows = await this._getScheduledPostRows();
    const match = this._findScheduledReelMatch(rows, expectedDescription, scheduledDate, scheduledTime);
    if (match) {
      this.log(`[FB-UPLOAD] Schedule confirmed for Reel by ${phase} row match (${match.proof}): "${match.row.text.slice(0, 120)}"`);
      return true;
    }

    if (rows.length > baselineCount) {
      this.log(`[FB-UPLOAD] ${phase}: row count increased (${baselineCount} -> ${rows.length}), but no caption proof yet`);
    } else {
      this.log(`[FB-UPLOAD] ${phase}: ${rows.length} scheduled row(s), waiting for caption proof`);
    }
    return false;
  }

  async _pollScheduledRowsForMatch({ expectedDescription, scheduledDate, scheduledTime, baselineCount, timeoutMs, phase, reloadEveryMs = 0 }) {
    const start = Date.now();
    let nextReloadAt = reloadEveryMs ? start : Number.POSITIVE_INFINITY;
    while (Date.now() - start < timeoutMs) {
      if (Date.now() >= nextReloadAt) {
        this.log(`[FB-UPLOAD] ${phase}: refreshing scheduled confirmation page`);
        await this._reloadScheduledLibrary();
        nextReloadAt = Date.now() + reloadEveryMs;
      }
      if (await this._checkScheduledRowsForMatch(expectedDescription, scheduledDate, scheduledTime, baselineCount, phase)) {
        return true;
      }
      await this.page.waitForTimeout(5000);
    }
    return false;
  }

  async _waitForReelScheduleConfirmation(expectedDescription = '', baselineCount = 0, options = {}) {
    const scheduledDate = options?.scheduledDate || '';
    const scheduledTime = options?.scheduledTime || '';
    const alreadySettledMs = options?.alreadySettledMs || 0;

    await this._waitForScheduleSubmissionSettle(expectedDescription, alreadySettledMs);

    const inPlaceMatched = await this._pollScheduledRowsForMatch({
      expectedDescription,
      scheduledDate,
      scheduledTime,
      baselineCount,
      timeoutMs: POST_SCHEDULE_IN_PLACE_CONFIRM,
      phase: 'in-place confirmation',
      reloadEveryMs: 0,
    });
    if (inPlaceMatched) return;

    this.log('[FB-UPLOAD] 3b: forcing scheduled confirmation page refresh before final checks');
    const refreshedMatched = await this._pollScheduledRowsForMatch({
      expectedDescription,
      scheduledDate,
      scheduledTime,
      baselineCount,
      timeoutMs: POST_SCHEDULE_REFRESH_CONFIRM,
      phase: 'post-refresh confirmation',
      reloadEveryMs: POST_SCHEDULE_REFRESH_EVERY,
    });
    if (refreshedMatched) return;

    throw new Error('Schedule confirmation timed out; matching scheduled Reel row did not appear after settle and refresh checks.');
  }

  /**
   * Upload video via file input element.
   * Note: post-upload processing wait is handled by _waitForUploadProcessing().
   */
  async _uploadVideo(filePath, preopenedFileChooser = null) {
    if (preopenedFileChooser) {
      this.log('[FB-UPLOAD] File chooser opened from Reel menu click; setting video file');
      await preopenedFileChooser.setFiles(filePath);
      await this.page.waitForTimeout(POST_CLICK_SETTLE);
      return;
    }

    // Try to find a file input first (most reliable)
    try {
      const fileInputs = await this.page.locator(SELECTORS.fileInput).all();
      this.log(`[FB-UPLOAD] Upload fallback: found ${fileInputs.length} file input(s)`);
      for (const fileInput of fileInputs) {
        const accept = await fileInput.getAttribute('accept').catch(() => '');
        if (accept && !/video|\*/i.test(accept)) continue;
        await fileInput.setInputFiles(filePath);
        // Brief settle — actual processing wait is in _waitForUploadProcessing()
        await this.page.waitForTimeout(POST_CLICK_SETTLE);
        this.log('[FB-UPLOAD] Upload fallback: set video on file input');
        return;
      }
    } catch (_) {}

    // Fallback: click the current Reel composer upload surface.
    const fileChooserPromise = this.page.waitForEvent('filechooser', { timeout: CLICK_TIMEOUT });
    const clicked = await this._clickReelUploadSurface();
    if (!clicked) {
      await this._logReelUploadDiagnostics('upload-fallback-no-click-target');
      throw new Error('Could not find Reel upload target after selecting Reel');
    }
    const fileChooser = await fileChooserPromise.catch(async (e) => {
      await this._logReelUploadDiagnostics('upload-fallback-no-filechooser');
      throw e;
    });
    await fileChooser.setFiles(filePath);
    // Brief settle — actual processing wait is in _waitForUploadProcessing()
    await this.page.waitForTimeout(POST_CLICK_SETTLE);
    this.log('[FB-UPLOAD] Upload fallback: set video from composer file chooser');
  }

  async _clickReelUploadSurface() {
    const attempts = [
      () => this.page.getByText(/Add video|Add photos or videos|Upload video|Choose file|or drag and drop/i).first(),
      () => this.page.locator('[role="button"]').filter({ hasText: /Add video|Add photos or videos|Upload video|Choose file/i }).first(),
      () => this.page.locator('div, label').filter({ hasText: /Add video|Add photos or videos|Upload video|or drag and drop/i }).first(),
      () => this.page.locator('input[type="file"]').first(),
    ];

    for (const find of attempts) {
      try {
        const locator = find();
        if (await locator.count() === 0) continue;
        const first = locator.first();
        const box = await first.boundingBox().catch(() => null);
        if (!box) continue;
        await first.click({ timeout: CLICK_TIMEOUT, force: true });
        await this.page.waitForTimeout(1000);
        return true;
      } catch (_) {}
    }
    return false;
  }

  async _logReelUploadDiagnostics(label) {
    try {
      const state = await this.page.evaluate(() => {
        const text = (document.body.innerText || document.body.textContent || '').replace(/\s+/g, ' ').trim();
        const visible = el => {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return rect.width > 1 && rect.height > 1 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const controls = [...document.querySelectorAll('button, [role="button"], label, input[type="file"], [contenteditable="true"]')]
          .filter(visible)
          .slice(0, 40)
          .map(el => ({
            tag: el.tagName,
            role: el.getAttribute('role') || '',
            aria: el.getAttribute('aria-label') || '',
            text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
            accept: el.getAttribute('accept') || '',
            type: el.getAttribute('type') || '',
          }));
        return { url: location.href, text: text.slice(0, 1200), controls };
      });
      this.log(`[FB-UPLOAD] ${label}: ${JSON.stringify(state).slice(0, 3000)}`);
    } catch (e) {
      this.log(`[FB-UPLOAD] ${label}: diagnostics failed (${e.message})`);
    }
  }

  /**
   * Wait for Facebook to finish processing the uploaded video.
   * The current Reels composer can show no spinner before the upload is
   * actually attached, so absence of a spinner is not enough.
   */
  async _waitForUploadProcessing() {
    const POLL_INTERVAL = 3000;
    const MAX_WAIT = UPLOAD_TIMEOUT;
    const startTime = Date.now();

    while (Date.now() - startTime < MAX_WAIT) {
      const state = await this.page.evaluate(() => {
        const text = document.body.innerText || document.body.textContent || '';
        const uploadedMedia = /Uploaded media|Your reel is safe to publish|safe to publish/i.test(text);
        const hasCaption = /Describe your reel|Enter caption|caption/i.test(text);
        const hasSchedule = /\bSchedule\b/i.test(text);
        const hasVideo = !!document.querySelector('video');
        const hasSelectedFile = [...document.querySelectorAll('input[type="file"]')]
          .some(input => input.files && input.files.length > 0);
        const errorText = /could not upload|upload failed|failed to upload|video file is not supported/i.test(text);
        return { uploadedMedia, hasCaption, hasSchedule, hasVideo, hasSelectedFile, errorText };
      }).catch(() => ({ uploadedMedia: false, hasCaption: false, hasSchedule: false, hasVideo: false, hasSelectedFile: false, errorText: false }));

      if (state.errorText) throw new Error('Facebook reported a Reel upload error');
      if (state.uploadedMedia || (state.hasCaption && state.hasSchedule && (state.hasVideo || state.hasSelectedFile))) {
        this.log('[FB-UPLOAD] Upload processing complete (composer upload markers visible)');
        return;
      }

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

      await this.page.waitForTimeout(POLL_INTERVAL);
    }

    throw new Error('Timed out waiting for Reel upload to attach to the composer');
  }

  /**
   * Enter description/caption text into the reel editor.
   */
  async _enterDescription(description) {
    const selectors = SELECTORS.descriptionField.split(', ');
    for (const sel of selectors) {
      try {
        const el = await this.page.waitForSelector(sel.trim(), { timeout: CLICK_TIMEOUT });
        if (el) {
          await el.click();
          await this.page.waitForTimeout(300);
          // Clear existing text
          await this.page.keyboard.press('Control+A');
          await this.page.keyboard.press('Backspace');
          // Type description (slow enough to avoid FB's anti-bot detection)
          await this.page.keyboard.type(description, { delay: DESCRIPTION_TYPE_DELAY });
          return;
        }
      } catch (_) {}
    }
    throw new Error('Could not find description/caption field');
  }

  /**
   * Set the schedule date in FB's scheduling sub-panel.
   *
   * FB's date field shows "May 2, 2026" format. It could be:
   *   - A real <input> with various aria-labels
   *   - A contenteditable span/div
   *   - A label+combobox combo
   *
   * Strategy: find ALL inputs/editables in the scheduling panel area,
   * identify the date one by its current value pattern (month name + day + year).
   */
  async _setScheduleDate(dateStr) {
    // dateStr format: YYYY-MM-DD
    const [year, month, day] = dateStr.split('-');
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                        'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const monthName = monthNames[parseInt(month) - 1];
    const dayNum = parseInt(day);

    // FB format: "May 10, 2026" or "MM/DD/YYYY"
    const fbDate = `${monthName} ${dayNum}, ${year}`;
    const usDate = `${month}/${String(dayNum).padStart(2, '0')}/${year}`;

    // Approach 1: Find input by aria-label containing date/Date/Schedule date
    const dateSelectors = [
      'input[aria-label*="date" i]',
      'input[aria-label*="Date"]',
      'input[aria-label*="schedule" i]',
      'input[type="text"][aria-label]',
      'input[placeholder*="date" i]',
    ];
    for (const sel of dateSelectors) {
      try {
        const el = await this.page.waitForSelector(sel, { timeout: 3000 });
        if (el) {
          const val = await el.inputValue().catch(() => '');
          // Check if this looks like a date (contains a month name or slash-separated numbers)
          if (val.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/i) || val.match(/^\d{1,2}\/\d{1,2}\/\d{4}$/)) {
            this.log(`[FB-UPLOAD] Found date input (value="${val}"), setting to ${fbDate}`);
            await el.click({ clickCount: 3 });
            await this.page.waitForTimeout(200);
            await this.page.keyboard.press('Control+A');
            await el.fill(fbDate);
            await this.page.keyboard.press('Tab');
            return;
          }
        }
      } catch (_) {}
    }

    // Approach 2: Find ALL visible inputs and pick the one with a date-like value
    try {
      const inputs = await this.page.$$('input[type="text"], input:not([type])');
      for (const input of inputs) {
        const val = await input.inputValue().catch(() => '');
        if (val.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/i) ||
            val.match(/^\d{1,2}\/\d{1,2}\/\d{4}$/)) {
          this.log(`[FB-UPLOAD] Found date input by value scan (value="${val}"), setting to ${fbDate}`);
          await input.click({ clickCount: 3 });
          await this.page.waitForTimeout(200);
          await this.page.keyboard.press('Control+A');
          await input.fill(fbDate);
          await this.page.keyboard.press('Tab');
          return;
        }
      }
    } catch (_) {}

    // Approach 3: Find by label text "Date" near the scheduling panel
    try {
      const dateLabel = this.page.getByText('Date', { exact: true });
      if (await dateLabel.count() > 0) {
        // Click the label — FB often makes labels open an input
        await dateLabel.first().click();
        await this.page.waitForTimeout(500);
        // Now try to find the focused/active input
        await this.page.keyboard.press('Control+A');
        await this.page.keyboard.type(fbDate, { delay: 10 });
        await this.page.keyboard.press('Tab');
        return;
      }
    } catch (_) {}

    this.log(`[FB-UPLOAD] WARNING: Could not find date input — proceeding with default date`);
  }

  /**
   * Set the schedule time in FB's scheduling sub-panel.
   *
   * FB's time field shows "10:34 AM" format (12h). It could be:
   *   - A real <input> with various aria-labels
   *   - A combobox/select
   *
   * Strategy: find ALL inputs in the scheduling panel, identify the time one
   * by its value pattern (HH:MM AM/PM).
   */
  async _setScheduleTime(timeStr) {
    // timeStr format: HH:MM (24h)
    const [hours, minutes] = timeStr.split(':');
    const h = parseInt(hours);
    const period = h >= 12 ? 'PM' : 'AM';
    const h12 = h > 12 ? h - 12 : (h === 0 ? 12 : h);
    const fbTime = `${h12}:${minutes} ${period}`;

    // Approach 1: Find input by aria-label containing time/Time
    const timeSelectors = [
      'input[aria-label*="time" i]',
      'input[aria-label*="Time"]',
      'input[placeholder*="time" i]',
    ];
    for (const sel of timeSelectors) {
      try {
        const el = await this.page.waitForSelector(sel, { timeout: 3000 });
        if (el) {
          const val = await el.inputValue().catch(() => '');
          if (val.match(/\b(AM|PM)\b/i) || val.match(/^\d{1,2}:\d{2}/)) {
            this.log(`[FB-UPLOAD] Found time input (value="${val}"), setting to ${fbTime}`);
            await el.click({ clickCount: 3 });
            await this.page.waitForTimeout(200);
            await this.page.keyboard.press('Control+A');
            await el.fill(fbTime);
            await this.page.keyboard.press('Tab');
            return;
          }
        }
      } catch (_) {}
    }

    // Approach 2: Find ALL visible inputs and pick the one with a time-like value
    try {
      const inputs = await this.page.$$('input[type="text"], input:not([type])');
      for (const input of inputs) {
        const val = await input.inputValue().catch(() => '');
        if (val.match(/\b(AM|PM)\b/i) || val.match(/^\d{1,2}:\d{2}\s*(AM|PM)?$/i)) {
          this.log(`[FB-UPLOAD] Found time input by value scan (value="${val}"), setting to ${fbTime}`);
          await input.click({ clickCount: 3 });
          await this.page.waitForTimeout(200);
          await this.page.keyboard.press('Control+A');
          await input.fill(fbTime);
          await this.page.keyboard.press('Tab');
          return;
        }
      }
    } catch (_) {}

    // Approach 3: Find by label text "Time" near the scheduling panel
    try {
      const timeLabel = this.page.getByText('Time', { exact: true });
      if (await timeLabel.count() > 0) {
        await timeLabel.first().click();
        await this.page.waitForTimeout(500);
        await this.page.keyboard.press('Control+A');
        await this.page.keyboard.type(fbTime, { delay: 10 });
        await this.page.keyboard.press('Tab');
        return;
      }
    } catch (_) {}

    this.log(`[FB-UPLOAD] WARNING: Could not find time input — proceeding with default time`);
  }

  /**
   * Click the "Scheduling options" row on the Reel Settings page.
   * This row shows "Publish now" by default and opens a sub-panel
   * with date/time inputs + "Schedule for later" button.
   */

  /**
   * Click the "Next" button — used by steps 5 and 7.
   * FB's Next button can be a <button>, <div role="button">, or <span> inside either.
   * Uses multiple Playwright APIs for maximum reliability.
   */
  async _clickNext() {
    await this._dismissPopups();

    // Strategy 1: getByRole — most reliable for React-rendered buttons
    try {
      const btn = this.page.getByRole('button', { name: 'Next' });
      if (await btn.count() > 0) {
        await btn.first().click({ timeout: CLICK_TIMEOUT });
        return;
      }
    } catch (_) {}

    // Strategy 2: getByText exact match
    try {
      const btn = this.page.getByText('Next', { exact: true });
      if (await btn.count() > 0) {
        // Click the first visible one
        const first = btn.first();
        const box = await first.boundingBox();
        if (box) {
          await first.click({ timeout: CLICK_TIMEOUT });
          return;
        }
      }
    } catch (_) {}

    // Strategy 3: CSS selectors — button element, div role=button, span
    const cssSelectors = [
      'button:has-text("Next")',
      'div[role="button"]:has-text("Next")',
      'span:text-is("Next")',
    ];
    for (const sel of cssSelectors) {
      try {
        const el = await this.page.waitForSelector(sel, { timeout: 5000 });
        if (el) {
          await el.click();
          return;
        }
      } catch (_) {}
    }

    // Strategy 4: Evaluate — find by text content in JS
    try {
      const clicked = await this.page.evaluate(() => {
        // Check <button> elements first
        const buttons = document.querySelectorAll('button');
        for (const b of buttons) {
          if (b.textContent.trim() === 'Next' && b.offsetParent !== null) {
            b.click();
            return true;
          }
        }
        // Check div[role="button"]
        const divBtns = document.querySelectorAll('[role="button"]');
        for (const b of divBtns) {
          if (b.textContent.trim() === 'Next' && b.offsetParent !== null) {
            b.click();
            return true;
          }
        }
        return false;
      });
      if (clicked) return;
    } catch (_) {}

    throw new Error('Could not find or click "Next" button');
  }

  /**
   * Click the "Scheduling options" row on the Reel Settings page.
   * This row shows "Publish now" by default and opens a sub-panel
   *
   * The row structure (from screenshots):
   *   [clock icon] Scheduling options
   *                 Publish now          [chevron >]
   */
  async _clickSchedulingOptions() {
    // Strategy 1: Find the row by text — it contains both "Scheduling options" and "Publish now"
    try {
      const row = await this.page.locator('div:has(> span:text("Scheduling options"))').first();
      if (row) {
        await row.click({ timeout: CLICK_TIMEOUT });
        return;
      }
    } catch (_) {}

    // Strategy 2: Use getByText on "Scheduling options" text
    try {
      await this.page.getByText('Scheduling options').click({ timeout: CLICK_TIMEOUT });
      return;
    } catch (_) {}

    // Strategy 3: Find "Publish now" text and click its parent row
    try {
      const publishNow = await this.page.getByText('Publish now');
      if (publishNow) {
        // Click the parent container (the clickable row)
        await publishNow.locator('..').click({ timeout: CLICK_TIMEOUT });
        return;
      }
    } catch (_) {}

    // Strategy 4: CSS fallback from SELECTORS
    await this._clickWithFallback(SELECTORS.schedulingOptionsRow);
  }

  /**
   * Click the final "Schedule" button on the Reel Settings page.
   * After setting date/time and clicking "Schedule for later" in the sub-panel,
   * the main Reel Settings page shows "Save" + "Schedule" buttons at the bottom.
   *
   * IMPORTANT: Must NOT click:
   *   - "Schedule for later" (that's in the sub-panel, step 11)
   *   - "Scheduling options" (that's the row, step 8)
   *   - "Post" (that's the default before scheduling)
   *
   * The "Schedule" button is a standalone button with exact text "Schedule".
   */
  async _clickFinalSchedule() {
    // Strategy 1: getByRole button with exact name "Schedule"
    try {
      await this.page.getByRole('button', { name: 'Schedule', exact: true }).click({ timeout: CLICK_TIMEOUT });
      return;
    } catch (_) {}

    // Strategy 2: Use text-is selector (exact match, no substring)
    try {
      const btn = await this.page.waitForSelector('div[role="button"] span:text-is("Schedule")', { timeout: CLICK_TIMEOUT });
      if (btn) {
        // Click the parent role=button, not the span
        await btn.evaluate(el => {
          const button = el.closest('[role="button"]');
          if (button) button.click();
          else el.click();
        });
        return;
      }
    } catch (_) {}

    // Strategy 3: CSS fallback — exclude "for later" and "Scheduling" variants
    await this._clickWithFallback(SELECTORS.scheduleButton);
  }

  /**
   * Wait for Facebook to confirm the post was successfully scheduled.
   * Polls for: success toast/banner, redirect to scheduled content list,
   * or dialog closing. Falls back to fixed timeout.
   */
  async _waitForScheduleConfirmation() {
    const POLL_INTERVAL = 2000;
    const MAX_WAIT = POST_SCHEDULE_CONFIRM;
    const startTime = Date.now();

    while (Date.now() - startTime < MAX_WAIT) {
      // Check for success indicators
      try {
        // FB typically shows a toast/banner like "Your reel has been scheduled"
        const successToast = await this.page.$('[role="alert"]:has-text("scheduled"), [aria-live="polite"]:has-text("scheduled"), div:has-text("Your reel has been scheduled")');
        if (successToast) {
          this.log('[FB-UPLOAD] Schedule confirmed (success toast detected)');
          return;
        }
      } catch (_) {}

      // Check if the creation dialog/modal closed (back to content list)
      try {
        const contentList = await this.page.$('[role="tab"][aria-selected="true"]:has-text("Scheduled")');
        if (contentList) {
          this.log('[FB-UPLOAD] Schedule confirmed (returned to scheduled tab)');
          return;
        }
      } catch (_) {}

      // Check URL changed back to content/scheduled
      try {
        const url = this.page.url();
        if (url.includes('/content') || url.includes('/professional_dashboard')) {
          if (Date.now() - startTime >= 4000) {
            // Give it a minimum of 4s before accepting URL as confirmation
            this.log('[FB-UPLOAD] Schedule confirmed (URL indicates content page)');
            return;
          }
        }
      } catch (_) {}

      await this.page.waitForTimeout(POLL_INTERVAL);
    }

    // Fallback: max wait reached, assume success (we already clicked Schedule)
    this.log('[FB-UPLOAD] Schedule confirmation timeout — assuming success');
  }
}

module.exports = { FacebookUploader, SELECTORS };
