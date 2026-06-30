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

class SocialFacebookUploader extends FacebookUploader {
  async _dismissPopups() {
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

  async scheduleImagePost(post) {
    const { mediaPath, caption, scheduledDate, scheduledTime } = post;
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

      this.log('[FB-SOCIAL] Step 8: Clicking Schedule for later');
      await this._clickScheduleForLater();
      await this.page.waitForTimeout(POST_CLICK_SETTLE);
      this.onStepComplete('schedule_for_later');

      this.log('[FB-SOCIAL] Step 9: Clicking Schedule post to submit scheduled post');
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
