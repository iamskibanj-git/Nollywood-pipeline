const fs = require('fs');
const path = require('path');
const { FacebookUploader } = require('../shorts/facebook-uploader');

const CLICK_TIMEOUT = 20000;
const POST_CLICK_SETTLE = 3000;
const IMAGE_UPLOAD_TIMEOUT = 90000;
const SCHEDULE_MODAL_SETTLE = 3000;
const POST_SCHEDULE_POST_CLICK_SETTLE = 30000;
const POST_SCHEDULE_SETTLE_TIMEOUT = 60000;
const POST_SCHEDULE_MIN_SETTLE = 30000;
const POST_SCHEDULE_IN_PLACE_CONFIRM = 30000;
const POST_SCHEDULE_REFRESH_CONFIRM = 90000;
const POST_SCHEDULE_REFRESH_EVERY = 15000;
const CALENDAR_CONFIRM_TIMEOUT = 90000;
const CALENDAR_CONFIRM_SCROLLS = 12;
const CALENDAR_DIALOG_TEXT_READY_TIMEOUT = 20000;
const CALENDAR_DIALOG_TEXT_POLL = 750;
const SOCIAL_CALENDAR_DAY_URL = 'https://www.facebook.com/professional_dashboard/content_calendar/';

class SocialFacebookUploader extends FacebookUploader {
  async _dismissPopups() {
    await this._dismissWhatsAppButtonPrompt().catch(() => false);

    const popups = [
      { find: () => this.page.locator('[role="dialog"]').getByText('Turn off', { exact: true }), label: 'keyboard shortcuts dialog' },
      { find: () => this.page.locator('button[data-cookiebanner="accept_button"]'), label: 'cookie consent' },
      { find: () => this.page.locator('[data-testid="cookie-policy-manage-dialog-accept-button"]'), label: 'cookie consent (testid)' },
      { find: () => this.page.locator('[aria-label="Dismiss"]'), label: 'dismiss banner' },
      { find: () => this.page.locator('[role="dialog"]').getByText('Not now', { exact: true }), label: 'notification prompt' },
    ];

    for (const popup of popups) {
      try {
        const locator = popup.find();
        if (await locator.count() > 0) {
          const box = await locator.first().boundingBox();
          if (box) {
            await locator.first().click({ timeout: 3000 });
            this.log(`[FB-SOCIAL] Dismissed popup: ${popup.label}`);
            await this.page.waitForTimeout(1000);
            return this._dismissPopups();
          }
        }
      } catch (_) {}
    }

    await this._dismissLeavePageGuard();
  }

  async _dismissWhatsAppButtonPrompt() {
    const dialogs = this.page.locator('[role="dialog"]').filter({
      hasText: /Make it easier to contact you|Add WhatsApp button|WhatsApp button/i,
    });
    const count = await dialogs.count().catch(() => 0);
    for (let index = count - 1; index >= 0; index--) {
      const dialog = dialogs.nth(index);
      const notNow = dialog.getByRole('button', { name: /^Not now$/i }).first();
      if (await notNow.count().catch(() => 0)) {
        await notNow.click({ timeout: 3000 });
        await this.page.waitForTimeout(1000);
        this.log('[FB-SOCIAL] Dismissed WhatsApp button prompt');
        return true;
      }
      const close = dialog.locator('[aria-label="Close"], [aria-label="Dismiss"]').first();
      if (await close.count().catch(() => 0)) {
        await close.click({ timeout: 3000 });
        await this.page.waitForTimeout(1000);
        this.log('[FB-SOCIAL] Closed WhatsApp button prompt');
        return true;
      }
    }
    return false;
  }

  async scheduleImagePost(post) {
    const { mediaPath, caption, scheduledDate, scheduledTime, status } = post;
    if (!FacebookUploader.isWithinScheduleWindow(scheduledDate, this.nowProvider())) {
      return { success: false, deferred: true, error: FacebookUploader.getScheduleWindowError(scheduledDate, this.nowProvider()) };
    }
    if (!mediaPath || !fs.existsSync(mediaPath)) {
      return { success: false, error: `Image file not found: ${mediaPath || '(empty)'}` };
    }
    if (!caption || !caption.trim()) {
      return { success: false, error: 'Caption is empty' };
    }

    try {
      this.log('[FB-SOCIAL] Step 1: Navigating to Content Library');
      await this.page.goto('https://www.facebook.com/professional_dashboard/content/content_library/?filter=SCHEDULED', {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      await this._waitForPageReady();
      await this._dismissPopups();
      await this._dismissLeavePageGuard();
      this.onStepComplete('navigate');

      if (status === 'upload_failed') {
        const recovered = await this._confirmImagePostInCalendar({
          expectedCaption: caption,
          scheduledDate,
          scheduledTime,
          phase: 'pre-submit calendar recovery',
        }).catch(error => {
          this.log(`[FB-SOCIAL] Pre-submit calendar recovery warning: ${error.message || error}`);
          return false;
        });
        if (recovered) {
          this.log('[FB-SOCIAL] Existing scheduled image post recovered from Calendar; skipping duplicate create');
          return { success: true, recovered: true, facebookPostId: null };
        }

        this.log('[FB-SOCIAL] No existing Calendar match found for retry; returning to Content Library to create post');
        await this._reloadScheduledLibrary();
      }

      const scheduledRowBaseline = (await this._getScheduledPostRows()).length;
      this.log(`[FB-SOCIAL] Scheduled row baseline before image post: ${scheduledRowBaseline}`);

      this.log('[FB-SOCIAL] Step 2: Opening Create Post');
      await this._openCreatePostDialog();
      this.onStepComplete('create_post');

      this.log(`[FB-SOCIAL] Step 3: Uploading image ${path.basename(mediaPath)}`);
      await this._uploadImage(mediaPath);
      await this._waitForImagePreview();
      this.onStepComplete('image');

      this.log('[FB-SOCIAL] Step 4: Entering caption');
      await this._enterPostCaption(caption);
      await this._dismissCaptionSuggestions();
      this.onStepComplete('caption');

      this.log('[FB-SOCIAL] Step 5: Opening scheduling modal');
      await this._scrollComposerToBottom();
      await this._advanceImagePostComposerIfNeeded();
      await this._clickComposerScheduleButton();
      await this.page.waitForTimeout(POST_CLICK_SETTLE);
      this.onStepComplete('scheduling_options');

      this.log(`[FB-SOCIAL] Step 6: Setting date ${scheduledDate}`);
      await this._setScopedScheduleDate(scheduledDate);
      await this.page.waitForTimeout(1000);

      this.log(`[FB-SOCIAL] Step 7: Setting time ${scheduledTime}`);
      await this._setScopedScheduleTime(scheduledTime);
      await this.page.waitForTimeout(1000);
      await this._dismissPopups();

      this.log('[FB-SOCIAL] Step 8: Clicking Schedule for later');
      await this._clickScheduleForLater();
      await this.page.waitForTimeout(POST_CLICK_SETTLE);
      await this._dismissPopups();
      this.onStepComplete('schedule_for_later');

      this.log('[FB-SOCIAL] Step 9: Clicking Schedule post to submit scheduled post');
      await this._dismissPopups();
      await this._clickComposerSubmitButton();
      this.log(`[FB-SOCIAL] Step 9b: Waiting ${POST_SCHEDULE_POST_CLICK_SETTLE / 1000}s after Schedule click for Facebook to settle...`);
      await this.page.waitForTimeout(POST_SCHEDULE_POST_CLICK_SETTLE);
      this.log('[FB-SOCIAL] Step 9c: Waiting for schedule confirmation...');
      await this._waitForScheduleConfirmation(caption, scheduledRowBaseline, {
        scheduledDate,
        scheduledTime,
        alreadySettledMs: POST_SCHEDULE_POST_CLICK_SETTLE,
      });
      this.onStepComplete('scheduled');

      this.log('[FB-SOCIAL] Image post scheduled successfully');
      return { success: true, facebookPostId: null };
    } catch (error) {
      const debugPath = await this._captureDebugScreenshot(mediaPath, 'social_post_error');
      return {
        success: false,
        error: `${error.message || error}${debugPath ? ` (screenshot: ${debugPath})` : ''}`,
      };
    }
  }

  async _openCreatePostDialog() {
    await this._clickCreateButton();
    await this.page.waitForTimeout(1500);
    await this._clickPostMenuItem();
    await this._waitForCreatePostDialog();
  }

  async _clickCreateButton() {
    const candidates = [
      () => this.page.getByRole('button', { name: /^Create$/i }).first(),
      () => this.page.locator('div[role="button"]:has-text("Create")').first(),
      () => this.page.locator('span:text-is("Create")').first(),
    ];
    for (const getLocator of candidates) {
      try {
        const locator = getLocator();
        if (await locator.count() > 0) {
          await locator.click({ timeout: CLICK_TIMEOUT });
          await this.page.waitForTimeout(1200);
          if (await this._hasCreateMenuOpen()) return;
          await locator.click({ timeout: CLICK_TIMEOUT });
          await this.page.waitForTimeout(1200);
          if (await this._hasCreateMenuOpen()) return;
        }
      } catch (_) {}
    }
    const clicked = await this._clickVisibleControlByText(/^Create$/i);
    if (clicked) {
      await this.page.waitForTimeout(1200);
      if (await this._hasCreateMenuOpen()) return;
      await this._clickVisibleControlByText(/^Create$/i);
      await this.page.waitForTimeout(1200);
      return;
    }
    throw new Error('Could not click Create button');
  }

  async _hasCreateMenuOpen() {
    return await this.page.evaluate(() => {
      const text = document.body.innerText || document.body.textContent || '';
      return /\bPost\b[\s\S]*\bStory\b[\s\S]*\bReel\b/.test(text);
    }).catch(() => false);
  }

  async _clickPostMenuItem() {
    const candidates = [
      () => this.page.getByRole('menuitem', { name: /^Post$/i }).first(),
      () => this.page.locator('[role="menuitem"]:has-text("Post")').first(),
      () => this.page.getByText('Post', { exact: true }).first(),
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
    const clicked = await this._clickVisibleControlByText(/^Post$/i, { preferRole: 'menuitem' });
    if (clicked) return;
    throw new Error('Could not click Post menu item');
  }

  async _waitForCreatePostDialog() {
    await this.page.waitForFunction(() => {
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 100 && rect.height > 100 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(visible);
      return dialogs.some(dialog => {
        const text = dialog.innerText || dialog.textContent || '';
        const hasComposerText = /Create post|What's on your mind|Posting to|Add photos or videos|Photo\/video/i.test(text);
        const hasComposerControl = !!dialog.querySelector('div[contenteditable="true"], [role="textbox"], input[type="file"]');
        return hasComposerText || hasComposerControl;
      });
    }, { timeout: CLICK_TIMEOUT });
    await this._waitForComposerHydration({ required: true });
  }

  _activeDialog() {
    return this.page.locator('[role="dialog"]').filter({
      hasText: /Create post|What's on your mind|Posting to|Photo\/video|Add photos or videos|Scheduling options|Schedule for later/i,
    }).last();
  }

  _schedulingDialog() {
    return this.page.locator('[role="dialog"]').filter({
      hasText: /Scheduling options|Choose a date and time|Schedule for later|Date\s+Time/i,
    }).last();
  }

  async _enterPostCaption(caption) {
    let lastActual = '';
    for (let attempt = 1; attempt <= 2; attempt++) {
      await this._typePostCaptionOnce(caption);
      const actual = await this._readComposerCaption();
      lastActual = actual;
      if (this._captionsMatch(caption, actual)) {
        if (attempt > 1) this.log('[FB-SOCIAL] Caption read-back matched after retry');
        return;
      }
      this.log(`[FB-SOCIAL] Caption read-back mismatch on attempt ${attempt}; retrying`);
      await this.page.waitForTimeout(1000);
    }

    throw new Error(`Caption read-back mismatch after retry. Expected ${caption.length} chars, got ${lastActual.length} chars.`);
  }

  async _typePostCaptionOnce(caption) {
    await this._waitForComposerHydration();
    const dialog = this._activeDialog();
    const editables = dialog.locator('div[contenteditable="true"]');
    const count = await editables.count();
    if (count > 0) {
      const field = editables.first();
      await field.click({ timeout: CLICK_TIMEOUT });
      await this.page.keyboard.press('Control+A');
      await this.page.keyboard.press('Backspace');
      await this._pasteOrTypeCaption(caption);
      await this.page.waitForTimeout(1000);
      return;
    }

    const box = await dialog.boundingBox().catch(() => null);
    if (box) {
      await this.page.mouse.click(box.x + Math.min(180, box.width / 2), box.y + 150);
      await this.page.waitForTimeout(500);
      await this._pasteOrTypeCaption(caption);
      await this.page.waitForTimeout(1000);
      return;
    }

    const placeholder = dialog.getByText(/What's on your mind/i).first();
    if (await placeholder.count() > 0) {
      await placeholder.click({ timeout: CLICK_TIMEOUT });
      await this._pasteOrTypeCaption(caption);
      await this.page.waitForTimeout(1000);
      return;
    }

    const typed = await this.page.evaluate(() => {
      const dialogs = [...document.querySelectorAll('[role="dialog"]')];
      const dialog = dialogs[dialogs.length - 1];
      if (!dialog) return false;
      const candidates = [...dialog.querySelectorAll('[role="textbox"], [aria-label], span, div')];
      const node = candidates.find(el => /What's on your mind/i.test(el.textContent || '') || /What's on your mind/i.test(el.getAttribute('aria-label') || ''));
      if (!node) return false;
      node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
      node.click();
      return true;
    });
    if (typed) {
      await this._pasteOrTypeCaption(caption);
      await this.page.waitForTimeout(1000);
      return;
    }

    throw new Error('Could not find post caption field');
  }

  async _pasteOrTypeCaption(caption) {
    try {
      await this.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://www.facebook.com' });
      await this.page.evaluate(text => navigator.clipboard.writeText(text), caption);
      await this.page.keyboard.press('Control+V');
      await this.page.waitForTimeout(800);
      return;
    } catch (error) {
      this.log(`[FB-SOCIAL] Clipboard paste failed; falling back to typed input (${error.message || error})`);
    }

    await this.page.keyboard.type(caption, { delay: 2 });
  }

  async _dismissCaptionSuggestions() {
    try {
      const hasSuggestions = await this.page.evaluate(() => {
        const visible = el => {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 20 && rect.height > 20 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        return [...document.querySelectorAll('[role="listbox"], [role="option"], div')]
          .filter(visible)
          .some(el => /posts\b|#\w+/i.test(el.innerText || el.textContent || ''));
      }).catch(() => false);
      if (hasSuggestions) {
        await this.page.keyboard.press('Escape');
        await this.page.waitForTimeout(700);
      }
    } catch (_) {}
  }

  async _readComposerCaption() {
    await this.page.waitForTimeout(500);
    return await this.page.evaluate(() => {
      const dialogs = [...document.querySelectorAll('[role="dialog"]')]
        .map(el => {
          const rect = el.getBoundingClientRect();
          return { el, rect, area: Math.max(0, rect.width) * Math.max(0, rect.height) };
        })
        .filter(item => item.rect.width > 100 && item.rect.height > 100)
        .sort((a, b) => b.area - a.area);
      const dialog = dialogs[0]?.el;
      if (!dialog) return '';
      const editables = [...dialog.querySelectorAll('div[contenteditable="true"], [role="textbox"][contenteditable="true"]')];
      const visibleTexts = editables
        .filter(el => {
          const rect = el.getBoundingClientRect();
          return rect.width > 20 && rect.height > 10;
        })
        .map(el => el.innerText || el.textContent || '')
        .filter(Boolean)
        .sort((a, b) => b.length - a.length);
      return visibleTexts[0] || dialog.innerText || dialog.textContent || '';
    }).catch(() => '');
  }

  _captionsMatch(expected, actual) {
    const normalize = (value) => String(value || '')
      .replace(/\u00ad/g, '')
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    const expectedText = normalize(expected);
    const actualText = normalize(actual);
    return actualText === expectedText || actualText.includes(expectedText);
  }

  async _waitForComposerHydration(options = {}) {
    try {
      await this.page.waitForFunction(() => {
        const visible = el => {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 100 && rect.height > 100 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const dialogs = [...document.querySelectorAll('[role="dialog"]')]
          .filter(visible)
          .filter(dialog => /Create post|What's on your mind|Posting to|Add to your post|Photo\/video/i.test(dialog.innerText || dialog.textContent || ''));
        const dialog = dialogs[dialogs.length - 1];
        if (!dialog) return false;
        const text = dialog.textContent || '';
        const hasComposerBody = /mind|Add to your post|Photo\/video/i.test(text);
        const hasEditor = !!dialog.querySelector('div[contenteditable="true"], [role="textbox"], [data-lexical-editor="true"]');
        return hasComposerBody || hasEditor;
      }, { timeout: 8000 });
    } catch (_) {
      if (options.required) throw new Error('Create post composer did not hydrate.');
      this.log('[FB-SOCIAL] Composer hydration wait timed out; continuing with click fallback');
    }
    await this.page.waitForTimeout(3500);
  }

  async _uploadImage(mediaPath) {
    await this._dismissLeavePageGuard();
    const dialog = this._activeDialog();
    if (await dialog.count().catch(() => 0) === 0) {
      throw new Error('Create post dialog is not open; refusing to upload image.');
    }

    const triggerClick = async () => {
      const clickedNewDropZone = await this._clickAddPhotosDropZone();
      if (clickedNewDropZone) return true;

      const clickedAddToPostIcon = await this._clickPhotoVideoIconByGeometry(dialog);
      if (clickedAddToPostIcon) return true;

      const photoButton = dialog.getByText('Photo/video', { exact: false }).first();
      if (await photoButton.count() > 0) {
        try {
          await photoButton.click({ timeout: 5000 });
          return true;
        } catch (_) {
          return await photoButton.evaluate(el => {
            const button = el.closest('[role="button"], button') || el;
            button.click();
            return true;
          }).catch(() => false);
        }
      }

      return await this.page.evaluate(() => {
        const dialogs = [...document.querySelectorAll('[role="dialog"]')];
        const dialog = dialogs[dialogs.length - 1];
        if (!dialog) return false;
        const candidates = [...dialog.querySelectorAll('[role="button"], button, span, div')];
        const node = candidates.find(el => /Photo\/video/i.test(el.textContent || ''));
        if (!node) return false;
        const button = node.closest('[role="button"], button') || node;
        button.click();
        return true;
      });
    };

    try {
      const [chooser] = await Promise.all([
        this.page.waitForEvent('filechooser', { timeout: 10000 }),
        triggerClick(),
      ]);
      await chooser.setFiles(mediaPath);
      await this.page.waitForTimeout(POST_CLICK_SETTLE);
      return;
    } catch (_) {
      await this._dismissLeavePageGuard();
      if (await this._setAnyImageFileInput(mediaPath)) return;
    }

    try {
      const [chooser] = await Promise.all([
        this.page.waitForEvent('filechooser', { timeout: 10000 }),
        this._clickPhotoVideoByDom(),
      ]);
      await chooser.setFiles(mediaPath);
      await this.page.waitForTimeout(POST_CLICK_SETTLE);
      return;
    } catch (_) {
      await this._dismissLeavePageGuard();
      if (await this._setAnyImageFileInput(mediaPath)) return;
    }

    throw new Error('Could not upload image through Photo/video control');
  }

  async _clickAddPhotosDropZone() {
    const clicked = await this._clickVisibleControlByText(/Add photos or videos/i);
    if (!clicked) return false;
    await this.page.waitForTimeout(800);
    return true;
  }

  async _setAnyImageFileInput(mediaPath) {
    const inputs = this.page.locator('input[type="file"]');
    const count = await inputs.count();
    for (let i = 0; i < count; i++) {
      const input = inputs.nth(i);
      const accept = await input.getAttribute('accept').catch(() => '');
      if (accept && !/image|png|jpeg|jpg|\*/i.test(accept)) continue;
      try {
        await input.setInputFiles(mediaPath);
        await this.page.waitForTimeout(POST_CLICK_SETTLE);
        this.log(`[FB-SOCIAL] Image attached via file input (${accept || 'no accept attr'})`);
        return true;
      } catch (_) {}
    }
    return false;
  }

  async _clickPhotoVideoByDom() {
    const clicked = await this.page.evaluate(() => {
      const dialogs = [...document.querySelectorAll('[role="dialog"]')];
      const dialog = dialogs[dialogs.length - 1];
      if (!dialog) return false;
      const rowText = [...dialog.querySelectorAll('*')].find(el => (el.textContent || '').trim() === 'Add to your post');
      const row = rowText?.closest('[role="button"], div')?.parentElement || rowText?.parentElement;
      const buttons = row ? [...row.querySelectorAll('[role="button"], button')] : [...dialog.querySelectorAll('[role="button"], button')];
      const photo = buttons.find(btn => /photo|video|media/i.test(btn.getAttribute('aria-label') || btn.textContent || '')) || buttons[0];
      if (!photo) return false;
      photo.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      photo.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
      photo.click();
      return true;
    });
    await this.page.waitForTimeout(1000);
    if (!clicked) throw new Error('DOM Photo/video click failed');
  }

  async _clickPhotoVideoIconByGeometry(dialog) {
    try {
      const dialogBox = await dialog.boundingBox();
      if (!dialogBox) return false;

      // In the May 2026 FB composer, the Photo/video button is the first icon
      // in the Add-to-post row. Use dialog-relative coordinates so we do not
      // drift down into the disabled Next button.
      const x = dialogBox.x + Math.round(dialogBox.width * 0.515);
      const y = dialogBox.y + Math.round(dialogBox.height * 0.78);
      await this.page.mouse.click(x, y);
      await this.page.waitForTimeout(1000);
      await this._dismissLeavePageGuard();
      return true;
    } catch (_) {
      return false;
    }
  }

  async _waitForImagePreview() {
    const start = Date.now();
    while (Date.now() - start < IMAGE_UPLOAD_TIMEOUT) {
      const ready = await this.page.evaluate(() => {
        const dialogs = [...document.querySelectorAll('[role="dialog"]')];
        const dialog = dialogs[dialogs.length - 1];
        if (!dialog) return false;
        const text = dialog.textContent || '';
        if (/Edit media|Remove post attachment|Add photos\/videos|\bEdit\b/i.test(text)) return true;
        const imgs = [...dialog.querySelectorAll('img')].filter(img => {
          const rect = img.getBoundingClientRect();
          return rect.width > 80 && rect.height > 80;
        });
        return imgs.length > 0;
      }).catch(() => false);
      if (ready) {
        this.log('[FB-SOCIAL] Image preview confirmed');
        return;
      }
      await this.page.waitForTimeout(2000);
    }
    this.log('[FB-SOCIAL] Image preview wait timed out; continuing because file input accepted the image');
  }

  async _scrollComposerToBottom() {
    try {
      await this.page.evaluate(() => {
        const textOf = el => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
        const isVisible = el => {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 1 && rect.height > 1 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const isScrollable = el => {
          const style = window.getComputedStyle(el);
          return /(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 20;
        };
        const scrollables = [document.scrollingElement, ...document.querySelectorAll('*')]
          .filter(Boolean)
          .filter(el => isVisible(el) && isScrollable(el))
          .map(el => {
            const rect = el.getBoundingClientRect();
            const text = textOf(el);
            let score = 0;
            if (rect.left < window.innerWidth * 0.5) score += 20;
            if (/Posting to|Uploaded media|Add to feed post|Share|Post audience|Schedule|Post/i.test(text)) score += 40;
            if (/What's on your mind|Add photos or videos/i.test(text)) score += 20;
            if (rect.height > window.innerHeight * 0.45) score += 10;
            return { el, score };
          })
          .sort((a, b) => b.score - a.score)
          .slice(0, 6);

        for (const { el } of scrollables) {
          el.scrollTop = el.scrollHeight;
        }

        const leftPane = scrollables.find(({ el }) => {
          const rect = el.getBoundingClientRect();
          return rect.left < window.innerWidth * 0.5 && rect.height > window.innerHeight * 0.45;
        });
        if (leftPane) leftPane.el.scrollTop = leftPane.el.scrollHeight;
      });
      const viewport = this.page.viewportSize() || { width: 1280, height: 900 };
      await this.page.mouse.move(Math.min(360, viewport.width * 0.35), Math.max(200, viewport.height - 120));
      await this.page.mouse.wheel(0, 3000);
      await this.page.waitForTimeout(500);
      await this.page.mouse.wheel(0, 3000);
      await this.page.waitForTimeout(1000);
    } catch (_) {}
  }

  async _advanceImagePostComposerIfNeeded() {
    const clickedNext = await this._clickVisibleControlByText(/^Next$/i, { preferRole: 'button', bottomOnly: true });
    if (!clickedNext) return false;
    this.log('[FB-SOCIAL] Clicked Next in image post composer');
    await this.page.waitForTimeout(5000);
    await this._dismissPopups();
    return true;
  }

  async _clickScheduleForLater() {
    await this._waitForSchedulingModalOpen();
    const dialog = this._schedulingDialog();
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
    await this._clickWithFallback('div[role="button"]:has-text("Schedule for later"), span:text("Schedule for later")');
  }

  async _clickComposerScheduleButton() {
    const clickedSchedulingOptions = await this._clickVisibleControlByText(/Scheduling options/i, { preferRole: 'button' });
    if (clickedSchedulingOptions) {
      await this._waitForSchedulingModalOpen();
      return;
    }

    for (let attempt = 1; attempt <= 3; attempt++) {
      await this._scrollComposerToBottom();
      const clicked = await this._clickVisibleControlByText(/^Schedule$/i, { preferRole: 'button', bottomOnly: true });
      if (clicked) {
        try {
          await this._waitForSchedulingModalOpen();
          return;
        } catch (error) {
          this.log(`[FB-SOCIAL] Schedule click attempt ${attempt} did not open modal; retrying`);
        }
      }
      await this.page.waitForTimeout(1000);
    }

    throw new Error('Could not open Facebook scheduling modal; bottom Schedule button may still be off screen.');
  }

  async _waitForSchedulingModalOpen(timeout = CLICK_TIMEOUT) {
    await this.page.waitForFunction(() => {
      const dialogs = [...document.querySelectorAll('[role="dialog"]')];
      return dialogs.some(dialog => {
        const rect = dialog.getBoundingClientRect();
        const style = window.getComputedStyle(dialog);
        const text = dialog.innerText || dialog.textContent || '';
        return rect.width > 100 &&
          rect.height > 100 &&
          style.visibility !== 'hidden' &&
          style.display !== 'none' &&
          /Scheduling options|Choose a date and time|Schedule for later/i.test(text);
      });
    }, { timeout });
    await this.page.waitForTimeout(SCHEDULE_MODAL_SETTLE);
  }

  async _clickComposerSubmitButton() {
    const clicked = await this._clickVisibleControlByText(/^(Schedule post|Schedule|Post)$/i, { preferRole: 'button', bottomOnly: true });
    if (clicked) return;
    await this._clickWithFallback('div[role="button"][aria-label="Schedule post"], div[role="button"]:has-text("Schedule post"), div[role="button"][aria-label="Schedule"], div[role="button"]:has-text("Schedule"), div[role="button"][aria-label="Post"], div[role="button"]:has-text("Post")');
  }

  async _waitForScheduleConfirmationLegacy(expectedCaption = '') {
    const captionNeedle = String(expectedCaption || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const start = Date.now();
    const timeoutMs = 30000;
    while (Date.now() - start < timeoutMs) {
      const state = await this.page.evaluate((caption) => {
        const text = document.body.innerText || document.body.textContent || '';
        const url = location.href;
        const hasSuccessText = /post has been scheduled|your post.*scheduled|scheduled your post|successfully scheduled/i.test(text);
        const stillComposer = /What's on your mind|Add photos or videos|Posting to/i.test(text) && url.includes('/post/create');
        const onContentLibrary = /Content Library/i.test(text) && /professional_dashboard\/content\/content_library/.test(url);
        const noScheduledPosts = /No scheduled posts/i.test(text);
        const hasScheduledRow = onContentLibrary &&
          !noScheduledPosts &&
          /Scheduled\s*[·•]/i.test(text) &&
          (!caption || text.replace(/\s+/g, ' ').includes(caption));
        return { url, hasSuccessText, stillComposer, onContentLibrary, noScheduledPosts, hasScheduledRow };
      }, captionNeedle).catch(() => ({ url: '', hasSuccessText: false, stillComposer: false, onContentLibrary: false, noScheduledPosts: false, hasScheduledRow: false }));

      if (state.hasSuccessText || state.hasScheduledRow) {
        this.log('[FB-SOCIAL] Schedule confirmed for image post');
        return;
      }

      await this.page.waitForTimeout(2000);
    }

    throw new Error('Schedule confirmation timed out; scheduled row did not appear in Content Library.');
  }

  async _waitForScheduleConfirmation(expectedCaption = '', baselineCount = 0, options = {}) {
    if (baselineCount && typeof baselineCount === 'object') {
      options = baselineCount;
      baselineCount = 0;
    }

    const scheduledDate = options?.scheduledDate || '';
    const scheduledTime = options?.scheduledTime || '';
    const alreadySettledMs = options?.alreadySettledMs || 0;

    await this._waitForImageScheduleSubmissionSettle(expectedCaption, alreadySettledMs);

    const calendarMatched = await this._confirmImagePostInCalendar({
      expectedCaption,
      scheduledDate,
      scheduledTime,
      phase: 'calendar confirmation',
    }).catch(error => {
      this.log(`[FB-SOCIAL] Calendar confirmation warning: ${error.message || error}`);
      return false;
    });
    if (calendarMatched) return;

    this.log('[FB-SOCIAL] Calendar confirmation missed; falling back to Content Library row checks');
    await this._reloadScheduledLibrary();

    const inPlaceMatched = await this._pollSocialScheduledRowsForMatch({
      expectedCaption,
      scheduledDate,
      scheduledTime,
      baselineCount,
      timeoutMs: POST_SCHEDULE_IN_PLACE_CONFIRM,
      phase: 'in-place confirmation',
      reloadEveryMs: 0,
    });
    if (inPlaceMatched) return;

    this.log('[FB-SOCIAL] 3b: forcing scheduled confirmation page refresh before final checks');
    const refreshedMatched = await this._pollSocialScheduledRowsForMatch({
      expectedCaption,
      scheduledDate,
      scheduledTime,
      baselineCount,
      timeoutMs: POST_SCHEDULE_REFRESH_CONFIRM,
      phase: 'post-refresh confirmation',
      reloadEveryMs: POST_SCHEDULE_REFRESH_EVERY,
    });
    if (refreshedMatched) return;

    throw new Error('Schedule confirmation timed out; matching scheduled image post row did not appear after settle and refresh checks.');
  }

  async _waitForImageScheduleSubmissionSettle(expectedCaption = '', alreadySettledMs = 0) {
    const captionNeedle = String(expectedCaption || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const start = Date.now();
    let lastState = null;
    while (Date.now() - start < POST_SCHEDULE_SETTLE_TIMEOUT) {
      await this._dismissPopups().catch(() => {});
      lastState = await this.page.evaluate((caption) => {
        const visible = el => {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 1 && rect.height > 1 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const text = document.body.innerText || document.body.textContent || '';
        const url = location.href;
        const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(visible);
        const hasSuccessText = /post has been scheduled|your post.*scheduled|scheduled your post|successfully scheduled/i.test(text);
        const hasProgressText = /scheduling|posting|publishing|please wait|your post is being scheduled/i.test(text);
        const hasComposerDialog = dialogs.some(dialog => /Create post|What's on your mind|Add photos or videos|Posting to|Schedule post/i.test(dialog.innerText || dialog.textContent || ''));
        const hasFinalScheduleButton = [...document.querySelectorAll('button, [role="button"]')]
          .filter(visible)
          .some(el => /^(Schedule post|Post)$/i.test((el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim()));
        const onScheduledSurface = /Content Library|Scheduled posts|Published Scheduled Drafts/i.test(text) ||
          /professional_dashboard\/content\/content_library/.test(url);
        const hasCaptionText = !!caption && text.replace(/\s+/g, ' ').includes(caption);
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

      const elapsed = alreadySettledMs + (Date.now() - start);
      if (lastState.hasSuccessText && elapsed >= POST_SCHEDULE_MIN_SETTLE) {
        this.log('[FB-SOCIAL] Schedule submit settle: Facebook displayed scheduled success text');
        return lastState;
      }
      const composerGone = !lastState.hasComposerDialog && !lastState.hasFinalScheduleButton && !lastState.hasProgressText;
      if (composerGone && elapsed >= POST_SCHEDULE_MIN_SETTLE) {
        this.log(`[FB-SOCIAL] Schedule submit settle: composer no longer active after ${Math.round(elapsed / 1000)}s`);
        return lastState;
      }
      await this.page.waitForTimeout(3000);
    }
    this.log(`[FB-SOCIAL] Schedule submit settle timed out; continuing to confirmation checks (state=${JSON.stringify(lastState)})`);
    return lastState;
  }

  async _checkSocialScheduledRowsForMatch(expectedCaption, scheduledDate, scheduledTime, baselineCount, phase) {
    const rows = await this._getScheduledPostRows();
    const match = this._findScheduledReelMatch(rows, expectedCaption, scheduledDate, scheduledTime);
    if (match) {
      this.log(`[FB-SOCIAL] Schedule confirmed for image post by ${phase} row match (${match.proof}): "${match.row.text.slice(0, 120)}"`);
      return true;
    }

    if (rows.length > baselineCount) {
      this.log(`[FB-SOCIAL] ${phase}: row count increased (${baselineCount} -> ${rows.length}), but no caption proof yet`);
    } else {
      this.log(`[FB-SOCIAL] ${phase}: ${rows.length} scheduled row(s), waiting for caption proof`);
    }
    return false;
  }

  async _pollSocialScheduledRowsForMatch({ expectedCaption, scheduledDate, scheduledTime, baselineCount, timeoutMs, phase, reloadEveryMs = 0 }) {
    const start = Date.now();
    let nextReloadAt = reloadEveryMs ? start : Number.POSITIVE_INFINITY;
    while (Date.now() - start < timeoutMs) {
      if (Date.now() >= nextReloadAt) {
        this.log(`[FB-SOCIAL] ${phase}: refreshing scheduled confirmation page`);
        await this._reloadScheduledLibrary();
        nextReloadAt = Date.now() + reloadEveryMs;
      }
      if (await this._checkSocialScheduledRowsForMatch(expectedCaption, scheduledDate, scheduledTime, baselineCount, phase)) {
        return true;
      }
      await this.page.waitForTimeout(5000);
    }
    return false;
  }

  async _confirmImagePostInCalendar({ expectedCaption = '', scheduledDate = '', scheduledTime = '', phase = 'calendar confirmation' } = {}) {
    if (!expectedCaption || !scheduledDate) return false;

    const calendarOpened = await this._openSocialCalendarDay(scheduledDate, phase);
    if (!calendarOpened) return false;
    const headerText = await this._readCalendarDayHeader();
    if (headerText) {
      const headerOk = this._calendarHeaderMatchesDate(headerText, scheduledDate);
      this.log(`[FB-SOCIAL] ${phase}: calendar header "${headerText}"${headerOk ? '' : ` does not visibly match ${scheduledDate}`}`);
    }

    await this._scrollCalendarToScheduledTime(scheduledTime);

    const start = Date.now();
    const inspected = new Set();
    for (let pass = 0; pass < CALENDAR_CONFIRM_SCROLLS && Date.now() - start < CALENDAR_CONFIRM_TIMEOUT; pass++) {
      const candidates = await this._getVisibleCalendarPostCandidates(scheduledTime);
      if (candidates.length > 0) {
        this.log(`[FB-SOCIAL] ${phase}: inspecting ${candidates.length} visible calendar candidate(s), pass ${pass + 1}`);
      }

      for (const candidate of candidates) {
        const key = candidate.coordinateKey || candidate.key || `${candidate.x},${candidate.y},${candidate.text}`;
        if (inspected.has(key)) continue;
        inspected.add(key);

        const remainingMs = Math.max(1000, CALENDAR_CONFIRM_TIMEOUT - (Date.now() - start));
        if (await this._inspectCalendarPostCandidate(candidate, {
          expectedCaption,
          scheduledDate,
          scheduledTime,
          headerText,
          phase,
          timeoutMs: Math.min(CALENDAR_DIALOG_TEXT_READY_TIMEOUT, remainingMs),
        })) {
          return true;
        }
      }

      await this.page.mouse.wheel(0, pass < 2 ? 420 : 760).catch(() => {});
      await this.page.waitForTimeout(1000);
    }

    this.log(`[FB-SOCIAL] ${phase}: no matching calendar post found after inspecting ${inspected.size} candidate(s)`);
    return false;
  }

  async _openSocialCalendarDay(scheduledDate, phase = 'calendar confirmation') {
    const url = this._buildSocialCalendarDayUrl(scheduledDate);
    this.log(`[FB-SOCIAL] ${phase}: opening Calendar day view ${url}`);
    await this.page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await this._waitForPageReady().catch(error => {
      this.log(`[FB-SOCIAL] ${phase}: calendar page readiness warning (${error.message || error})`);
    });
    await this._dismissPopups();
    await this._dismissLeavePageGuard();
    await this.page.waitForTimeout(2500);
    if (await this._isCalendarUnavailableSurface()) {
      this.log(`[FB-SOCIAL] ${phase}: calendar day view unavailable; falling back to Content Library confirmation`);
      return false;
    }
    return true;
  }

  async _isCalendarUnavailableSurface() {
    return await this.page.evaluate(() => {
      const text = document.body?.innerText || document.body?.textContent || '';
      return /This content isn['’]t available right now/i.test(text) &&
        /Go to Feed|Visit Help Center|only shared it with a small group/i.test(text);
    }).catch(() => false);
  }

  _buildSocialCalendarDayUrl(scheduledDate) {
    const offset = this._calendarDayOffsetFromToday(scheduledDate);
    return `${SOCIAL_CALENDAR_DAY_URL}?time_offset=${offset}&view=DAY`;
  }

  _calendarDayOffsetFromToday(scheduledDate) {
    const target = this._parseLocalDateOnly(scheduledDate);
    if (!target) return 0;
    const now = this.nowProvider();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.round((target.getTime() - today.getTime()) / 86400000);
  }

  _parseLocalDateOnly(value) {
    if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return null;
    const [year, month, day] = String(value).split('-').map(n => parseInt(n, 10));
    if (!year || month < 1 || month > 12 || day < 1 || day > 31) return null;
    return new Date(year, month - 1, day);
  }

  async _readCalendarDayHeader() {
    return await this.page.evaluate(() => {
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 1 && rect.height > 1 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const candidates = [...document.querySelectorAll('h1, h2, [role="heading"], span, div')]
        .filter(visible)
        .map(el => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim())
        .filter(text => /(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i.test(text))
        .sort((a, b) => a.length - b.length);
      return candidates[0] || '';
    }).catch(() => '');
  }

  _calendarHeaderMatchesDate(headerText, scheduledDate) {
    if (!scheduledDate) return true;
    const needles = this._scheduledDateNeedles(scheduledDate);
    return this._textHasAnyNeedle(headerText || '', needles);
  }

  async _scrollCalendarToScheduledTime(scheduledTime) {
    const labels = this._calendarTimeLabels(scheduledTime);
    const hour = this._parseScheduledHour(scheduledTime);
    const scrolledToLabel = await this.page.evaluate(({ labels, hour }) => {
      const norm = text => (text || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 1 && rect.height > 1 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const labelSet = new Set(labels.map(norm));
      const nodes = [...document.querySelectorAll('span, div')]
        .filter(el => {
          const text = norm(el.innerText || el.textContent || '');
          if (!labelSet.has(text)) return false;
          const rect = el.getBoundingClientRect();
          return rect.width < 120 && rect.height < 80;
        });
      if (nodes[0]) {
        nodes[0].scrollIntoView({ block: 'center', inline: 'nearest' });
        return nodes[0].innerText || nodes[0].textContent || '';
      }

      const scrollables = [document.scrollingElement, ...document.querySelectorAll('*')]
        .filter(Boolean)
        .filter(el => {
          const style = window.getComputedStyle(el);
          return /(auto|scroll)/i.test(style.overflowY || '') && el.scrollHeight > el.clientHeight + 50;
        });
      const approx = Math.max(0, (Number.isFinite(hour) ? hour : 12) * 155);
      for (const el of scrollables.slice(0, 8)) {
        el.scrollTop = approx;
      }
      if (document.scrollingElement) document.scrollingElement.scrollTop = approx;
      return '';
    }, { labels, hour }).catch(() => '');

    if (scrolledToLabel) {
      this.log(`[FB-SOCIAL] Calendar scrolled to time label "${String(scrolledToLabel).trim()}"`);
    }
    await this.page.waitForTimeout(1200);
  }

  _parseScheduledHour(timeStr) {
    const match = String(timeStr || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return NaN;
    const hour = parseInt(match[1], 10);
    return hour >= 0 && hour <= 23 ? hour : NaN;
  }

  _calendarTimeLabels(timeStr) {
    const timeNeedles = this._scheduledTimeNeedles(timeStr);
    const hour = this._parseScheduledHour(timeStr);
    if (!Number.isFinite(hour)) return timeNeedles;
    const period = hour >= 12 ? 'pm' : 'am';
    const h12 = hour > 12 ? hour - 12 : (hour === 0 ? 12 : hour);
    return [...new Set([
      ...timeNeedles,
      `${h12} ${period}`,
      `${h12}${period}`,
      `${h12} ${period.toUpperCase()}`,
      `${h12}${period.toUpperCase()}`,
    ])];
  }

  async _getVisibleCalendarPostCandidates(scheduledTime = '') {
    const timeNeedles = this._scheduledTimeNeedles(scheduledTime);
    return await this.page.evaluate((timeNeedles) => {
      const norm = text => (text || '').replace(/\s+/g, ' ').trim();
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 1 && rect.height > 1 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const textHasAny = (text, needles) => {
        const compactText = norm(text).toLowerCase();
        const spacelessText = compactText.replace(/\s+/g, '');
        return (needles || []).some(needle => {
          const compactNeedle = norm(needle).toLowerCase();
          return compactNeedle && (compactText.includes(compactNeedle) || spacelessText.includes(compactNeedle.replace(/\s+/g, '')));
        });
      };
      const hasMedia = el => !!el.querySelector?.('img, video, [aria-label*="photo" i], [aria-label*="image" i], [aria-label*="post" i]') ||
        /url\(/i.test(window.getComputedStyle(el).backgroundImage || '');
      const looksLikeCard = (el, text) => {
        const rect = el.getBoundingClientRect();
        if (rect.x < 430 || rect.y < 90) return false;
        if (rect.width < 35 || rect.height < 30 || rect.width > 420 || rect.height > 280) return false;
        if (/Dashboard|Content Library|Planner|Monetization|All tools|Today|Day Month|Wednesday|Thursday|Friday/i.test(text) && rect.width > 260) return false;
        return hasMedia(el) || textHasAny(text, timeNeedles);
      };
      const bestCardFor = el => {
        let node = el;
        let best = null;
        for (let depth = 0; node && depth < 7; depth++, node = node.parentElement) {
          if (!visible(node)) continue;
          const text = norm(node.innerText || node.textContent || node.getAttribute('aria-label') || '');
          if (!looksLikeCard(node, text)) continue;
          const rect = node.getBoundingClientRect();
          const score = (hasMedia(node) ? 40 : 0) +
            (textHasAny(text, timeNeedles) ? 60 : 0) +
            (node.matches?.('button, [role="button"], a') ? 15 : 0) -
            Math.max(0, rect.width - 220) / 20;
          if (!best || score > best.score) best = { el: node, rect, text, score };
        }
        return best;
      };

      const seeds = [
        ...document.querySelectorAll('img, video, [role="button"], button, a, div'),
      ].filter(visible);
      const candidates = [];
      const seen = new Set();
      for (const seed of seeds) {
        const card = bestCardFor(seed);
        if (!card) continue;
        const centerX = Math.round(card.rect.x + card.rect.width / 2);
        const centerY = Math.round(card.rect.y + card.rect.height / 2);
        const coordinateKey = `${Math.round(centerX / 8) * 8}:${Math.round(centerY / 8) * 8}`;
        const key = `${coordinateKey}:${Math.round(card.rect.width)}:${Math.round(card.rect.height)}:${card.text.slice(0, 80)}`;
        if (seen.has(coordinateKey)) continue;
        if (seen.has(key)) continue;
        seen.add(coordinateKey);
        seen.add(key);
        candidates.push({
          x: centerX,
          y: centerY,
          text: card.text,
          key,
          coordinateKey,
          score: card.score,
          timeMatch: textHasAny(card.text, timeNeedles),
        });
      }
      return candidates
        .sort((a, b) => (b.score - a.score) || (a.y - b.y))
        .slice(0, 8);
    }, timeNeedles).catch(() => []);
  }

  async _inspectCalendarPostCandidate(candidate, { expectedCaption, scheduledDate, scheduledTime, headerText, phase, timeoutMs = CALENDAR_DIALOG_TEXT_READY_TIMEOUT }) {
    this.log(`[FB-SOCIAL] ${phase}: clicking calendar candidate at ${candidate.x},${candidate.y} (${String(candidate.text || '').slice(0, 80)})`);
    let dialogOpened = false;
    try {
      await this.page.mouse.click(candidate.x, candidate.y);
      dialogOpened = await this._waitForCalendarPostDialog();
      if (!dialogOpened) {
        this.log(`[FB-SOCIAL] ${phase}: candidate did not open an Edit post dialog`);
        return false;
      }

      const proof = await this._waitForCalendarPostDialogMatch({
        candidate,
        expectedCaption,
        scheduledDate,
        scheduledTime,
        headerText,
        timeoutMs,
      });
      const { dialogText, match } = proof;
      if (match.matched) {
        this.log(`[FB-SOCIAL] ${phase}: Calendar post confirmed (${match.proof}; textLen=${dialogText.length}; waits=${proof.attempts})`);
        return true;
      }
      this.log(`[FB-SOCIAL] ${phase}: Calendar candidate rejected (${match.proof}; textLen=${dialogText.length}; waits=${proof.attempts})`);
      return false;
    } finally {
      if (dialogOpened) await this._closeCalendarPostDialog();
    }
  }

  async _waitForCalendarPostDialog() {
    return await this.page.waitForFunction(() => {
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 100 && rect.height > 100 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      return [...document.querySelectorAll('[role="dialog"]')]
        .filter(visible)
        .some(dialog => /Edit post|Unsaved changes|What's on your mind|Add to your post/i.test(dialog.innerText || dialog.textContent || ''));
    }, { timeout: 8000 }).then(() => true).catch(() => false);
  }

  async _readCalendarPostDialogText() {
    return await this.page.evaluate(() => {
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 100 && rect.height > 100 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const dialogs = [...document.querySelectorAll('[role="dialog"]')]
        .filter(visible)
        .map(dialog => ({
          text: (dialog.innerText || dialog.textContent || '').replace(/\s+/g, ' ').trim(),
          rect: dialog.getBoundingClientRect(),
        }))
        .sort((a, b) => b.text.length - a.text.length);
      return dialogs[0]?.text || '';
    }).catch(() => '');
  }

  async _waitForCalendarPostDialogMatch({ candidate, expectedCaption, scheduledDate, scheduledTime, headerText, timeoutMs = CALENDAR_DIALOG_TEXT_READY_TIMEOUT }) {
    const start = Date.now();
    let attempts = 0;
    let lastDialogText = '';
    let lastMatch = this._calendarDialogMatchesExpectedPost({
      dialogText: '',
      candidate,
      expectedCaption,
      scheduledDate,
      scheduledTime,
      headerText,
    });

    while (Date.now() - start < timeoutMs) {
      attempts += 1;
      lastDialogText = await this._readCalendarPostDialogText();
      lastMatch = this._calendarDialogMatchesExpectedPost({
        dialogText: lastDialogText,
        candidate,
        expectedCaption,
        scheduledDate,
        scheduledTime,
        headerText,
      });
      if (lastMatch.matched) {
        return { dialogText: lastDialogText, match: lastMatch, attempts };
      }
      await this.page.waitForTimeout(CALENDAR_DIALOG_TEXT_POLL);
    }

    return { dialogText: lastDialogText, match: lastMatch, attempts };
  }

  _calendarDialogMatchesExpectedPost({ dialogText = '', candidate = {}, expectedCaption = '', scheduledDate = '', scheduledTime = '', headerText = '' } = {}) {
    const captionNeedles = this._captionNeedles(expectedCaption);
    const captionMatch = this._textHasAnyNeedle(dialogText, captionNeedles);
    const timeNeedles = this._scheduledTimeNeedles(scheduledTime);
    const timeText = `${candidate.text || ''} ${dialogText || ''}`;
    const timeMatch = !scheduledTime || this._textHasAnyNeedle(timeText, timeNeedles);
    const headerKnown = !!String(headerText || '').trim();
    const dateMatch = !scheduledDate || !headerKnown || this._calendarHeaderMatchesDate(headerText, scheduledDate);
    const proof = [
      captionMatch ? 'caption' : 'missing-caption',
      timeMatch ? 'time' : 'missing-time',
      dateMatch ? (headerKnown ? 'date' : 'date-unverified-day-view') : 'wrong-date',
    ].join('+');
    return {
      matched: captionMatch && timeMatch && dateMatch,
      proof,
      captionMatch,
      timeMatch,
      dateMatch,
    };
  }

  async _closeCalendarPostDialog() {
    const dialog = this.page.locator('[role="dialog"]').last();
    const closeCandidates = [
      () => dialog.locator('[aria-label="Close"], [aria-label="Dismiss"]').last(),
      () => dialog.getByRole('button', { name: /Close|Dismiss/i }).last(),
      () => this.page.locator('[aria-label="Close"], [aria-label="Dismiss"]').last(),
    ];
    let closed = false;
    for (const getLocator of closeCandidates) {
      try {
        const locator = getLocator();
        if (await locator.count() > 0) {
          await locator.click({ timeout: 3000 });
          closed = true;
          break;
        }
      } catch (_) {}
    }
    if (!closed) {
      await this.page.keyboard.press('Escape').catch(() => {});
    }
    await this.page.waitForTimeout(800);

    const discarded = await this._clickVisibleControlByText(/^Discard$/i, { preferRole: 'button' }).catch(() => false);
    if (discarded) {
      this.log('[FB-SOCIAL] Calendar dialog close: discarded unsaved Edit post prompt');
      await this.page.waitForTimeout(1000);
    }
  }

  async _hasVisibleComposerScheduleButton() {
    return await this.page.evaluate(() => {
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 1 && rect.height > 1 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const buttons = [...document.querySelectorAll('button, [role="button"]')].filter(visible);
      return buttons.some(el => {
        const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
        const aria = el.getAttribute('aria-label') || '';
        const rect = el.getBoundingClientRect();
        return /^Schedule$/i.test(text || aria) && rect.y > window.innerHeight * 0.65;
      });
    }).catch(() => false);
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
    this.log(`[FB-SOCIAL] Clicking visible control "${target.text}" (${target.role || 'no role'}) at ${target.x},${target.y}`);
    await this.page.mouse.click(target.x, target.y);
    await this.page.waitForTimeout(800);
    return true;
  }

  async _dismissLeavePageGuard() {
    try {
      const dialog = this.page.locator('[role="dialog"]').filter({ hasText: /Leave Page\?/i }).last();
      if (await dialog.count() === 0) return false;

      const keepEditing = dialog.getByText('Keep editing', { exact: true }).first();
      if (await keepEditing.count() > 0) {
        await keepEditing.click({ timeout: 5000 });
      } else {
        const close = dialog.locator('[aria-label="Close"]').first();
        if (await close.count() > 0) {
          await close.click({ timeout: 3000 });
        } else {
          await this.page.keyboard.press('Escape');
        }
      }
      await this.page.waitForTimeout(1000);
      this.log('[FB-SOCIAL] Dismissed Leave Page guard, kept editing');
      return true;
    } catch (_) {
      return false;
    }
  }

  async _captureDebugScreenshot(mediaPath, label) {
    try {
      const baseDir = mediaPath ? path.dirname(mediaPath) : process.cwd();
      const debugPath = path.join(baseDir, `fb_${label}_${Date.now()}.png`);
      await this.page.screenshot({ path: debugPath, fullPage: true });
      return debugPath;
    } catch (_) {
      return null;
    }
  }
}

module.exports = { SocialFacebookUploader };
