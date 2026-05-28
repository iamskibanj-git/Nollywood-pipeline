const fs = require('fs');
const path = require('path');
const { FacebookUploader } = require('../shorts/facebook-uploader');

const CLICK_TIMEOUT = 20000;
const POST_CLICK_SETTLE = 3000;
const IMAGE_UPLOAD_TIMEOUT = 90000;

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

      this.log('[FB-SOCIAL] Step 2: Opening Create Post');
      await this._openCreatePostDialog();
      this.onStepComplete('create_post');

      this.log(`[FB-SOCIAL] Step 3: Uploading image ${path.basename(mediaPath)}`);
      await this._uploadImage(mediaPath);
      await this._waitForImagePreview();
      this.onStepComplete('image');

      this.log('[FB-SOCIAL] Step 4: Entering caption');
      await this._enterPostCaption(caption);
      this.onStepComplete('caption');

      this.log('[FB-SOCIAL] Step 5: Clicking Next');
      await this._scrollComposerToBottom();
      await this._clickNext();
      await this.page.waitForTimeout(POST_CLICK_SETTLE);
      this.onStepComplete('next');

      this.log('[FB-SOCIAL] Step 6: Opening scheduling options');
      await this._clickSchedulingOptions();
      await this.page.waitForTimeout(POST_CLICK_SETTLE);
      this.onStepComplete('scheduling_options');

      this.log(`[FB-SOCIAL] Step 7: Setting date ${scheduledDate}`);
      await this._setScopedScheduleDate(scheduledDate);
      await this.page.waitForTimeout(1000);

      this.log(`[FB-SOCIAL] Step 8: Setting time ${scheduledTime}`);
      await this._setScopedScheduleTime(scheduledTime);
      await this.page.waitForTimeout(1000);

      this.log('[FB-SOCIAL] Step 9: Clicking Schedule for later');
      await this._clickScheduleForLater();
      await this.page.waitForTimeout(POST_CLICK_SETTLE);
      this.onStepComplete('schedule_for_later');

      this.log('[FB-SOCIAL] Step 10: Clicking Schedule');
      await this._clickFinalSchedule();
      await this._waitForScheduleConfirmation();
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
          return;
        }
      } catch (_) {}
    }
    throw new Error('Could not click Create button');
  }

  async _clickPostMenuItem() {
    const candidates = [
      () => this.page.getByRole('menuitem', { name: /^Post$/i }).first(),
      () => this.page.getByText('Post', { exact: true }).first(),
      () => this.page.locator('[role="menuitem"]:has-text("Post")').first(),
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
    throw new Error('Could not click Post menu item');
  }

  async _waitForCreatePostDialog() {
    await this.page.waitForFunction(() => {
      const dialogs = [...document.querySelectorAll('[role="dialog"]')];
      return dialogs.some(d => /Create post/i.test(d.textContent || ''));
    }, { timeout: CLICK_TIMEOUT });
    await this._waitForComposerHydration();
  }

  _activeDialog() {
    return this.page.locator('[role="dialog"]').filter({
      hasText: /Create post|What's on your mind|Photo\/video|Scheduling options|Schedule for later/i,
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

  async _waitForComposerHydration() {
    try {
      await this.page.waitForFunction(() => {
        const dialogs = [...document.querySelectorAll('[role="dialog"]')];
        const dialog = dialogs[dialogs.length - 1];
        if (!dialog) return false;
        const text = dialog.textContent || '';
        const hasComposerBody = /mind|Add to your post|Photo\/video/i.test(text);
        const hasEditor = !!dialog.querySelector('div[contenteditable="true"], [role="textbox"], [data-lexical-editor="true"]');
        return hasComposerBody || hasEditor;
      }, { timeout: 8000 });
    } catch (_) {
      this.log('[FB-SOCIAL] Composer hydration wait timed out; continuing with click fallback');
    }
    await this.page.waitForTimeout(3500);
  }

  async _uploadImage(mediaPath) {
    await this._dismissLeavePageGuard();
    const dialog = this._activeDialog();

    const triggerClick = async () => {
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
        const dialogs = [...document.querySelectorAll('[role="dialog"]')];
        const dialog = dialogs[dialogs.length - 1];
        if (!dialog) return;
        const scrollables = [dialog, ...dialog.querySelectorAll('*')].filter(el => {
          const style = window.getComputedStyle(el);
          return /(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 20;
        });
        for (const el of scrollables) el.scrollTop = el.scrollHeight;
      });
      await this.page.mouse.wheel(0, 2000);
      await this.page.waitForTimeout(1000);
    } catch (_) {}
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
    await this._clickWithFallback('div[role="button"]:has-text("Schedule for later"), span:text("Schedule for later")');
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
