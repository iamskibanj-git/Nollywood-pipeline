const fs = require('fs');
const { chromium } = require('playwright');
const { YOUTUBE_STUDIO_DASHBOARD_URL } = require('./platform-profiles');

const NAV_TIMEOUT = 60000;
const LOGIN_WAIT_TIMEOUT = 180000;
const LOGIN_POLL_INTERVAL = 3000;

const TITLE_SELECTORS = [
  '#title-textarea #textbox',
  'ytcp-social-suggestions-textbox#title-textarea #textbox',
  '[aria-label*="title" i][contenteditable="true"]',
];

const DESCRIPTION_SELECTORS = [
  '#description-textarea #textbox',
  'ytcp-social-suggestions-textbox#description-textarea #textbox',
  '[aria-label*="description" i][contenteditable="true"]',
];

const DATE_SELECTORS = [
  'input[aria-label*="Date" i]',
  'input[placeholder*="Date" i]',
  'ytcp-datetime-picker input[aria-label*="Date" i]',
  'ytcp-datetime-picker input[placeholder*="Date" i]',
];

const TIME_SELECTORS = [
  'input[aria-label*="Time" i]',
  'input[placeholder*="Time" i]',
  'ytcp-datetime-picker input',
];


class YouTubeStudioUploader {
  constructor(options = {}) {
    this.userDataDir = options.userDataDir || null;
    this.headless = options.headless === true;
    this.log = options.log || console.log;
    this.dashboardUrl = options.dashboardUrl || YOUTUBE_STUDIO_DASHBOARD_URL;
    this.expectedChannelId = options.channelId || extractYouTubeStudioChannelId(this.dashboardUrl);
    this.loginWaitMs = Number.isFinite(Number(options.loginWaitMs))
      ? Number(options.loginWaitMs)
      : LOGIN_WAIT_TIMEOUT;
    this.navigationTimeoutMs = Number.isFinite(Number(options.navigationTimeoutMs))
      ? Number(options.navigationTimeoutMs)
      : NAV_TIMEOUT;
    this.newPageOnLaunch = options.newPageOnLaunch !== false;
    this.page = options.page || null;
    this.context = options.context || null;
    this.browser = options.browser || null;
    this.chromium = options.chromium || chromium;
    this.channelProof = null;
  }

  async launch() {
    if (!this.page) {
      if (this.userDataDir) {
        this.context = await this.chromium.launchPersistentContext(this.userDataDir, {
          headless: this.headless,
          viewport: { width: 1400, height: 900 },
          args: ['--disable-blink-features=AutomationControlled'],
        });
        this.page = this.newPageOnLaunch
          ? await this.context.newPage()
          : (this.context.pages()[0] || await this.context.newPage());
      } else {
        this.browser = await this.chromium.launch({
          headless: this.headless,
          args: ['--disable-blink-features=AutomationControlled'],
        });
        this.context = await this.browser.newContext({
          viewport: { width: 1400, height: 900 },
        });
        this.page = await this.context.newPage();
      }
      this.log('[YT-STUDIO] Browser launched for channel-context dry-run');
    }

    return this.verifyChannelContext();
  }

  async verifyChannelContext() {
    if (!this.page) throw new Error('YouTube Studio verifier has no page. Call launch() first.');
    if (!this.expectedChannelId) {
      throw new Error('YOUTUBE_CHANNEL_ID_REQUIRED: dashboardUrl must include /channel/<id> or channelId must be provided.');
    }

    this.log(`[YT-STUDIO] Navigating to YouTube Studio dashboard: ${this.dashboardUrl}`);
    await this.page.goto(this.dashboardUrl, {
      waitUntil: 'domcontentloaded',
      timeout: this.navigationTimeoutMs,
    });
    await safeWait(this.page, 3000);

    const proof = await this._waitForChannelProof();
    this.channelProof = proof;
    this.log(`[YT-STUDIO] Channel context verified for ${this.expectedChannelId}`);
    return {
      success: true,
      dryRun: true,
      dashboardUrl: this.dashboardUrl,
      channelProof: proof,
    };
  }

  async inspectUploadWizard(options = {}) {
    if (!this.page) {
      await this.launch();
    } else if (!this.channelProof || !this.channelProof.verified) {
      await this.verifyChannelContext();
    }

    const entryProof = await this._readUploadEntryProof();
    let wizardProof = null;
    if (options.openWizard === true) {
      wizardProof = await this._openUploadWizardForInspection(options);
      if (options.closeWizard !== false) {
        await this._closeUploadWizard();
      }
    }

    return {
      success: true,
      dryRun: true,
      noFileSelected: true,
      dashboardUrl: this.dashboardUrl,
      channelProof: this.channelProof,
      entryProof,
      wizardProof,
    };
  }

  async uploadShortDraft(payload = {}, options = {}) {
    if (options.confirmDraftUpload !== true) {
      throw new Error('YOUTUBE_DRAFT_UPLOAD_REQUIRES_CONFIRMATION: pass confirmDraftUpload=true to set a file input.');
    }
    if (!payload.filePath) throw new Error('YOUTUBE_DRAFT_UPLOAD_FILE_REQUIRED');
    if (!fs.existsSync(payload.filePath)) {
      throw new Error(`YOUTUBE_DRAFT_UPLOAD_FILE_NOT_FOUND: ${payload.filePath}`);
    }
    if (options.allowFinalAction === true) {
      throw new Error('YOUTUBE_FINAL_ACTION_NOT_IMPLEMENTED: this path must stop before publish/schedule.');
    }

    if (!this.page) {
      await this.launch();
    } else if (!this.channelProof || !this.channelProof.verified) {
      await this.verifyChannelContext();
    }

    const duplicateDraftProof = options.skipExistingDraftCheck === true
      ? { skipped: true, matchCount: 0, matches: [] }
      : await this._inspectMatchingShortDrafts(payload, options);
    if (duplicateDraftProof.matchCount > 0) {
      if (options.existingDraftPolicy === 'resume') {
        if (duplicateDraftProof.matchCount !== 1) {
          throw new Error(`YOUTUBE_DUPLICATE_DRAFTS_AMBIGUOUS: ${JSON.stringify(duplicateDraftProof)}`);
        }
        return this._resumeMatchingShortDraft(payload, options, duplicateDraftProof);
      }
      throw new Error(`YOUTUBE_DUPLICATE_DRAFTS_FOUND: ${JSON.stringify(duplicateDraftProof)}`);
    }

    const entryProof = await this._readUploadEntryProof();
    const wizardProof = await this._openUploadWizardForInspection({
      ...options,
      closeWizard: false,
    });
    const fileProof = await this._setUploadFile(payload.filePath);
    const draftSurfaceProof = await this._waitForDraftDetailsSurface(options);
    const metadataProof = await this._fillDraftMetadata(payload, options);
    const finalActionProof = await this._readFinalActionProof();

    return {
      success: true,
      draftOnly: true,
      dryRun: false,
      fileSelected: true,
      noFinalAction: true,
      published: false,
      scheduled: false,
      dashboardUrl: this.dashboardUrl,
      channelProof: this.channelProof,
      entryProof,
      wizardProof,
      fileProof,
      draftSurfaceProof,
      metadataProof,
      finalActionProof,
      proofCheckedAt: new Date().toISOString(),
    };
  }

  async uploadAndScheduleShort(payload = {}, options = {}) {
    if (options.confirmSchedule !== true) {
      throw new Error('YOUTUBE_SCHEDULE_REQUIRES_CONFIRMATION: pass confirmSchedule=true for the final Schedule click.');
    }
    if (!payload.scheduledDate || !payload.scheduledTime) {
      throw new Error('YOUTUBE_SCHEDULE_DATE_TIME_REQUIRED');
    }

    const draftProof = await this.uploadShortDraft(payload, {
      ...options,
      confirmDraftUpload: true,
      allowFinalAction: false,
      stopStage: 'details',
    });
    const visibilityProof = await this._advanceToVisibilityStep(options);
    const scheduleSettingsProof = await this._setScheduledVisibility(payload, options);
    const scheduleSubmitProof = await this._clickFinalScheduleAndVerify(payload, options);

    return {
      success: true,
      scheduled: true,
      draftOnly: false,
      dryRun: false,
      published: false,
      dashboardUrl: this.dashboardUrl,
      channelProof: this.channelProof,
      draftProof,
      visibilityProof,
      scheduleSettingsProof,
      scheduleSubmitProof,
      remoteVideoId: scheduleSubmitProof.remoteVideoId || null,
      remoteUrl: scheduleSubmitProof.remoteUrl || null,
      proofCheckedAt: new Date().toISOString(),
    };
  }


  async deleteShortByRemoteId(payload = {}, options = {}) {
    if (options.confirmDelete !== true) {
      throw new Error('YOUTUBE_DELETE_REQUIRES_CONFIRMATION: pass confirmDelete=true for the permanent YouTube Studio delete action.');
    }
    const remoteVideoId = String(payload.remoteVideoId || payload.remote_post_id || '').trim();
    if (!remoteVideoId) throw new Error('YOUTUBE_DELETE_REMOTE_ID_REQUIRED');

    if (!this.page) {
      await this.launch();
    } else if (!this.channelProof || !this.channelProof.verified) {
      await this.verifyChannelContext();
    }

    const before = await this._readShortsContentRowsByRemoteId(remoteVideoId, options);
    if (before.matchCount !== 1) {
      throw new Error(`YOUTUBE_DELETE_REMOTE_ROW_MATCH_FAILED: ${JSON.stringify({ remoteVideoId, matchCount: before.matchCount, matches: before.matches })}`);
    }

    const menuProof = await this._openShortRowOptionsByRemoteId(remoteVideoId, options);
    const deleteMenuProof = await this._clickShortRowDeleteMenuItem(options);
    if (!deleteMenuProof.clicked) {
      throw new Error(`YOUTUBE_DELETE_MENU_ITEM_NOT_CLICKED: ${JSON.stringify(deleteMenuProof)}`);
    }

    const dialogProof = await this._readShortDeleteDialogProof();
    if (!dialogProof.visible) {
      throw new Error(`YOUTUBE_DELETE_CONFIRMATION_DIALOG_NOT_FOUND: ${JSON.stringify(dialogProof)}`);
    }

    const confirmationProof = await this._confirmDeleteForever(options);
    await safeWait(this.page, options.afterDeleteWaitMs || 6000);

    const after = await this._readShortsContentRowsByRemoteId(remoteVideoId, {
      ...options,
      contentSettleMs: options.afterDeleteContentSettleMs || options.contentSettleMs || 7000,
    });
    if (after.matchCount !== 0) {
      throw new Error(`YOUTUBE_DELETE_VERIFICATION_FAILED: ${JSON.stringify({ remoteVideoId, matchCount: after.matchCount, matches: after.matches })}`);
    }

    return {
      success: true,
      deleted: true,
      remoteVideoId,
      dashboardUrl: this.dashboardUrl,
      channelProof: this.channelProof,
      before,
      menuProof,
      deleteMenuProof,
      dialogProof,
      confirmationProof,
      after,
      proofCheckedAt: new Date().toISOString(),
    };
  }

  async _readShortsContentRowsByRemoteId(remoteVideoId, options = {}) {
    const id = String(remoteVideoId || '').trim();
    if (!id) return { remoteVideoId: id, matchCount: 0, matches: [], skipped: true, reason: 'empty-remote-id' };
    const shortsUrl = this._shortsContentUrl();
    if (options.navigate !== false) {
      await this.page.goto(shortsUrl, { waitUntil: 'domcontentloaded', timeout: this.navigationTimeoutMs });
    }
    await safeWait(this.page, options.contentSettleMs || 7000);
    const proof = await this.page.evaluate(videoId => {
      const rows = Array.from(document.querySelectorAll('ytcp-video-row'))
        .map((row, index) => {
          const text = (row.innerText || row.textContent || '').trim();
          const hrefs = Array.from(row.querySelectorAll('a[href]')).map(a => a.href);
          const imageSrcs = Array.from(row.querySelectorAll('img[src]')).map(img => img.src);
          const thumbnailIds = imageSrcs
            .map(src => String(src || '').match(/\/vi\/([^/?]+)/))
            .filter(Boolean)
            .map(match => match[1]);
          const exactHref = hrefs.some(href => String(href || '').includes(videoId));
          const exactImage = imageSrcs.some(src => String(src || '').includes(videoId));
          const exactThumb = thumbnailIds.includes(videoId);
          const textMatch = text.includes(videoId);
          const matches = exactHref || exactImage || exactThumb || textMatch;
          return matches ? { index, text, hrefs, thumbnailIds, exactHref, exactImage, exactThumb, textMatch } : null;
        })
        .filter(Boolean);
      return {
        finalUrl: location.href,
        title: document.title,
        bodyHasTargetId: (document.body?.innerText || '').includes(videoId),
        bodySample: (document.body?.innerText || '').slice(0, 1200),
        matches: rows,
      };
    }, id);
    return { ...proof, shortsUrl, remoteVideoId: id, matchCount: proof.matches.length };
  }

  async _findShortContentRowByRemoteId(remoteVideoId) {
    const id = String(remoteVideoId || '').trim();
    if (!id || !this.page || !this.page.locator) return null;
    const rows = await this.page.locator('ytcp-video-row').all();
    for (const row of rows) {
      const hit = await row.evaluate((el, videoId) => {
        const text = (el.innerText || el.textContent || '');
        const hrefs = Array.from(el.querySelectorAll('a[href]')).map(a => a.href || '');
        const imgs = Array.from(el.querySelectorAll('img[src]')).map(img => img.src || '');
        return text.includes(videoId) || hrefs.some(href => href.includes(videoId)) || imgs.some(src => src.includes(videoId));
      }, id).catch(() => false);
      if (hit) return row;
    }
    return null;
  }

  async _openShortRowOptionsByRemoteId(remoteVideoId, options = {}) {
    const row = await this._findShortContentRowByRemoteId(remoteVideoId);
    if (!row) throw new Error(`YOUTUBE_DELETE_REMOTE_ROW_HANDLE_NOT_FOUND: ${remoteVideoId}`);
    await row.scrollIntoViewIfNeeded().catch(() => {});
    await row.hover().catch(() => {});
    const optionsButton = row.locator('ytcp-icon-button[aria-label="Options"], [aria-label="Options"], button[aria-label="Options"]').first();
    await optionsButton.click({ timeout: options.menuClickTimeoutMs || 15000, force: true });
    await safeWait(this.page, options.menuWaitMs || 1000);
    return this._readShortRowMenuProof();
  }

  async _readShortRowMenuProof() {
    return await this.page.evaluate(() => Array.from(document.querySelectorAll('tp-yt-paper-listbox, tp-yt-paper-item, ytcp-menu-service-item-renderer, ytd-menu-service-item-renderer, [role="menu"], [role="menuitem"]'))
      .map((el, index) => ({
        index,
        tag: el.tagName,
        role: el.getAttribute('role'),
        text: (el.innerText || el.textContent || '').trim(),
        visible: Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
      }))
      .filter(item => /delete|edit|analytics|menu|download|shareable/i.test(item.text) || /menu/i.test(item.role || '')));
  }

  async _clickShortRowDeleteMenuItem(options = {}) {
    const selector = 'tp-yt-paper-listbox [role="menuitem"], tp-yt-paper-item, ytcp-menu-service-item-renderer, ytd-menu-service-item-renderer, [role="menuitem"]';
    const item = this.page.locator(selector).filter({ hasText: /Delete forever|Delete video|Delete/i }).last();
    const count = await item.count().catch(() => 0);
    if (count < 1) return { clicked: false, reason: 'delete-menu-item-not-found' };
    await item.click({ timeout: options.deleteMenuTimeoutMs || 15000, force: true });
    await safeWait(this.page, options.dialogWaitMs || 1500);
    return { clicked: true, matchedCount: count };
  }

  async _readShortDeleteDialogProof() {
    const dialogs = await this.page.evaluate(() => Array.from(document.querySelectorAll('[role="dialog"], ytcp-confirmation-dialog, tp-yt-paper-dialog, ytcp-dialog'))
      .map((dialog, index) => ({
        index,
        tag: dialog.tagName,
        text: (dialog.innerText || dialog.textContent || '').trim(),
        controls: Array.from(dialog.querySelectorAll('button, tp-yt-paper-button, ytcp-button, [role="button"], [role="checkbox"], input, ytcp-checkbox-lit'))
          .map((el, controlIndex) => ({
            controlIndex,
            tag: el.tagName,
            role: el.getAttribute('role'),
            type: el.getAttribute('type'),
            ariaLabel: el.getAttribute('aria-label'),
            text: (el.innerText || el.textContent || '').trim(),
            disabled: el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true',
            checked: el.getAttribute('aria-checked') || el.checked || null,
          })),
      })));
    return {
      visible: dialogs.some(dialog => /Permanently delete|Delete forever|I understand that deleting/i.test(dialog.text)),
      dialogs,
    };
  }

  async _confirmDeleteForever(options = {}) {
    const dialog = this.page.locator('[role="dialog"], ytcp-confirmation-dialog, tp-yt-paper-dialog, ytcp-dialog').filter({ hasText: /delete/i }).last();
    const checkbox = dialog.locator('[role="checkbox"], ytcp-checkbox-lit, input[type="checkbox"]').first();
    let checkboxClicked = false;
    if (await checkbox.count().catch(() => 0)) {
      await checkbox.click({ timeout: options.checkboxTimeoutMs || 7000, force: true }).catch(async () => {
        if (this.page.keyboard && typeof this.page.keyboard.press === 'function') {
          await this.page.keyboard.press('Space').catch(() => {});
        }
      });
      checkboxClicked = true;
      await safeWait(this.page, options.afterCheckboxWaitMs || 750);
    }

    const deleteButton = dialog.locator('button, tp-yt-paper-button, ytcp-button, [role="button"]')
      .filter({ hasText: /Delete forever|Delete video|Delete/i })
      .last();
    if (await deleteButton.count().catch(() => 0)) {
      await deleteButton.click({ timeout: options.finalDeleteTimeoutMs || 15000, force: true });
      return { clicked: true, checkboxClicked };
    }

    await this.page.getByRole('button', { name: /Delete forever|Delete video|Delete/i }).last().click({ timeout: options.finalDeleteTimeoutMs || 15000, force: true });
    return { clicked: true, checkboxClicked, fallbackRoleButton: true };
  }

  async _advanceToVisibilityStep(options = {}) {
    const proofs = [];
    for (let i = 0; i < 5; i++) {
      const proof = await this._readVisibilityStepProof();
      proofs.push(proof);
      if (proof.visibilityVisible && proof.scheduleOptionVisible) {
        return { reached: true, steps: i, proofs };
      }
      const clicked = await clickRole(this.page, 'button', /^Next$/i, options.nextTimeoutMs || 15000);
      if (!clicked) break;
      await safeWait(this.page, options.nextSettleMs || 2500);
    }

    const finalProof = await this._readVisibilityStepProof();
    proofs.push(finalProof);
    if (finalProof.visibilityVisible && finalProof.scheduleOptionVisible) {
      return { reached: true, steps: proofs.length - 1, proofs };
    }
    throw new Error(`YOUTUBE_VISIBILITY_STEP_NOT_REACHED: ${JSON.stringify(finalProof)}`);
  }

  async _readVisibilityStepProof() {
    const bodyText = await readBodyText(this.page);
    return {
      visibilityVisible: /Visibility/i.test(bodyText),
      scheduleOptionVisible: /Schedule/i.test(bodyText),
      publicOptionVisible: /Public/i.test(bodyText),
      privateOptionVisible: /Private/i.test(bodyText),
      nextButtonCount: await countRole(this.page, 'button', /^Next$/i),
      scheduleButtonCount: await countRole(this.page, 'button', /^Schedule$/i),
      sampledText: bodyText.slice(0, 700),
    };
  }

  async _setScheduledVisibility(payload = {}, options = {}) {
    const radioClicked = await clickRole(this.page, 'radio', /^Schedule$/i, 10000)
      || await clickRole(this.page, 'radio', /Schedule/i, 10000);
    const textClicked = radioClicked ? false : await clickText(this.page, /^Schedule$/i, 10000);
    if (!radioClicked && !textClicked) {
      throw new Error(`YOUTUBE_SCHEDULE_OPTION_NOT_CLICKED: ${JSON.stringify(await this._readVisibilityStepProof())}`);
    }
    await safeWait(this.page, 1000);

    const beforeDateProof = await this._readScheduleDateTimeProof();
    const dateValue = options.studioDate || formatStudioDate(payload.scheduledDate);
    const timeValue = options.studioTime || formatStudioTime(payload.scheduledTime);
    const dateProof = options.setStudioDate === true
      ? await this._setScheduleDate(payload.scheduledDate, dateValue, beforeDateProof, options)
      : { attempted: false, skipped: true, reason: 'using-visible-studio-default-date' };
    const timeProof = await fillFirstInput(this.page, TIME_SELECTORS, timeValue, 'schedule-time');
    const afterProof = await this._readVisibilityStepProof();
    const afterDateTimeProof = await this._readScheduleDateTimeProof();

    return {
      scheduleOptionClicked: true,
      radioClicked,
      textClicked,
      requestedScheduledDate: payload.scheduledDate,
      requestedScheduledTime: payload.scheduledTime,
      studioDate: dateValue,
      studioTime: timeValue,
      date: dateProof,
      time: timeProof,
      beforeDateTimeProof: beforeDateProof,
      afterDateTimeProof,
      afterProof,
    };
  }

  async _setScheduleDate(scheduledDate, dateValue, beforeDateProof = {}, options = {}) {
    const targetLong = formatStudioDateLong(scheduledDate);
    if (beforeDateProof.visibleDate === targetLong) {
      return { attempted: true, skipped: true, reason: 'already-selected', targetDate: targetLong };
    }

    const directBefore = await this._fillScheduleDateInput(dateValue, targetLong, { phase: 'before-picker' });
    if (directBefore.selected) return directBefore;

    if (!beforeDateProof.visibleDate) {
      throw new Error(`YOUTUBE_SCHEDULE_DATE_PICKER_CURRENT_DATE_NOT_FOUND: ${JSON.stringify({ beforeDateProof, directBefore })}`);
    }
    if (!sameMonthYear(beforeDateProof.visibleDate, targetLong)) {
      throw new Error(`YOUTUBE_SCHEDULE_DATE_PICKER_MONTH_NAV_NOT_IMPLEMENTED: ${JSON.stringify({ current: beforeDateProof.visibleDate, target: targetLong, directBefore })}`);
    }

    const opened = await clickText(this.page, new RegExp(escapeRegExp(beforeDateProof.visibleDate)), 10000)
      || await clickFirstLocator(this.page, ['ytcp-datetime-picker button', 'ytcp-datetime-picker ytcp-dropdown-trigger', 'ytcp-datetime-picker [role="button"]'], 'schedule-date-picker').then(result => result.clicked);
    if (!opened) {
      throw new Error(`YOUTUBE_SCHEDULE_DATE_PICKER_OPEN_FAILED: ${JSON.stringify({ beforeDateProof, directBefore })}`);
    }
    await safeWait(this.page, 1000);

    const day = String(Number(String(scheduledDate || '').split('-')[2] || ''));
    if (!day) throw new Error(`YOUTUBE_SCHEDULE_DATE_INVALID: ${scheduledDate}`);
    const roleDayClicked = await clickRole(this.page, 'button', new RegExp(`^${day}$`), 10000)
      || await clickText(this.page, new RegExp(`^${day}$`), 10000);
    const domDayClick = roleDayClicked ? null : await clickDatePickerDay(this.page, day);
    if (!roleDayClicked && !domDayClick.clicked) {
      const directAfterOpen = await this._fillScheduleDateInput(dateValue, targetLong, { phase: 'after-picker-open', dayClickFailed: true, domDayClick });
      if (directAfterOpen.selected) return directAfterOpen;
      throw new Error(`YOUTUBE_SCHEDULE_DATE_DAY_NOT_CLICKED: ${JSON.stringify({ day, targetDate: targetLong, directBefore, domDayClick, directAfterOpen })}`);
    }
    await safeWait(this.page, 1000);
    const after = await this._readScheduleDateTimeProof();
    if (after.visibleDate !== targetLong) {
      const directAfterMismatch = await this._fillScheduleDateInput(dateValue, targetLong, { phase: 'after-day-click-mismatch', dayClicked: true, previousAfter: after });
      if (directAfterMismatch.selected) return directAfterMismatch;
      throw new Error(`YOUTUBE_SCHEDULE_DATE_NOT_SET: ${JSON.stringify({ targetDate: targetLong, after, directBefore, directAfterMismatch })}`);
    }
    return { attempted: true, selected: true, targetDate: targetLong, studioDate: dateValue, after };
  }

  async _fillScheduleDateInput(dateValue, targetLong, extra = {}) {
    let fillProof;
    try {
      fillProof = await fillFirstInput(this.page, DATE_SELECTORS, dateValue, 'schedule-date');
    } catch (error) {
      fillProof = await setFirstInputValue(this.page, DATE_SELECTORS, dateValue, 'schedule-date-dom', error);
    }
    if (!fillProof.filled) {
      return { attempted: true, selected: false, directInput: true, targetDate: targetLong, studioDate: dateValue, fillProof, ...extra };
    }
    await safeWait(this.page, 1000);
    const after = await this._readScheduleDateTimeProof();
    return {
      attempted: true,
      selected: after.visibleDate === targetLong,
      directInput: true,
      targetDate: targetLong,
      studioDate: dateValue,
      fillProof,
      after,
      ...extra,
    };
  }
  async _readScheduleDateTimeProof() {
    const bodyText = await readBodyText(this.page);
    const visibleDateMatch = bodyText.match(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4}\b/);
    const timeValue = await readFirstInputValue(this.page, TIME_SELECTORS);
    return {
      visibleDate: visibleDateMatch ? visibleDateMatch[0] : null,
      timeValue,
      invalidTimeVisible: /Invalid Time/i.test(bodyText),
      sampledText: bodyText.slice(0, 500),
    };
  }
  async _clickFinalScheduleAndVerify(payload = {}, options = {}) {
    const dateTimeProof = await this._readScheduleDateTimeProof();
    if (dateTimeProof.invalidTimeVisible) {
      throw new Error(`YOUTUBE_INVALID_TIME_BEFORE_FINAL_SCHEDULE: ${JSON.stringify(dateTimeProof)}`);
    }

    const timeoutMs = Number.isFinite(Number(options.finalScheduleTimeoutMs)) ? Number(options.finalScheduleTimeoutMs) : 300000;
    const start = Date.now();
    let clicked = false;
    let lastProof = null;

    while (Date.now() - start < timeoutMs) {
      clicked = await clickRole(this.page, 'button', /^Schedule$/i, 10000);
      if (clicked) break;
      lastProof = await this._readVisibilityStepProof();
      await safeWait(this.page, 5000);
    }
    if (!clicked) {
      throw new Error(`YOUTUBE_FINAL_SCHEDULE_CLICK_FAILED: ${JSON.stringify(lastProof || await this._readVisibilityStepProof())}`);
    }

    const confirmation = await this._waitForScheduleConfirmation(payload, options);
    return {
      clicked: true,
      ...confirmation,
    };
  }

  async _waitForScheduleConfirmation(payload = {}, options = {}) {
    const timeoutMs = Number.isFinite(Number(options.confirmationTimeoutMs)) ? Number(options.confirmationTimeoutMs) : 180000;
    const contentVerifyDelayMs = Number.isFinite(Number(options.contentVerifyDelayMs)) ? Number(options.contentVerifyDelayMs) : 45000;
    const start = Date.now();
    let lastProof = null;
    while (Date.now() - start < timeoutMs) {
      const allowContentTabVerification = Date.now() - start >= contentVerifyDelayMs;
      lastProof = await this._readScheduleConfirmationProof(payload, {
        ...options,
        verifyInContentTab: allowContentTabVerification,
      });
      if (lastProof.confirmed) return lastProof;
      await safeWait(this.page, allowContentTabVerification ? 5000 : 3000);
    }
    throw new Error(`YOUTUBE_SCHEDULE_CONFIRMATION_NOT_FOUND: ${JSON.stringify(lastProof || {})}`);
  }

  async _readScheduleConfirmationProof(payload = {}, options = {}) {
    const bodyText = await readBodyText(this.page);
    const currentUrl = typeof this.page.url === 'function' ? this.page.url() : '';
    const currentUrlVideoId = extractYouTubeVideoId(currentUrl) || extractStudioVideoId(currentUrl) || null;
    const confirmationText = /Video scheduled|Your video has been scheduled|Scheduled for|Will be public/i.test(bodyText);
    if (confirmationText && !/Draft\s+Edit draft/i.test(bodyText) && options.allowUploadSurfaceConfirmation === true && currentUrlVideoId) {
      return {
        confirmed: true,
        source: 'upload-confirmation-text',
        confirmationText,
        currentUrl,
        remoteUrl: currentUrlVideoId ? currentUrl : null,
        remoteVideoId: currentUrlVideoId,
        closeButtonCount: await countRole(this.page, 'button', /^Close$/i),
        sampledText: bodyText.slice(0, 1000),
      };
    }

    if (options.verifyInContentTab === false) {
      return {
        confirmed: false,
        source: 'upload-surface-only',
        confirmationText,
        currentUrl,
        remoteUrl: null,
        remoteVideoId: null,
        closeButtonCount: await countRole(this.page, 'button', /^Close$/i),
        sampledText: bodyText.slice(0, 1000),
      };
    }

    const contentProof = await this._readShortsContentScheduleProof(payload, options);
    return {
      confirmed: contentProof.confirmed,
      source: 'shorts-content-tab',
      confirmationText,
      currentUrl: contentProof.finalUrl,
      remoteUrl: contentProof.remoteUrl,
      remoteVideoId: contentProof.remoteVideoId,
      contentProof,
      closeButtonCount: 0,
      sampledText: contentProof.bodySample,
    };
  }

  async _readShortsContentScheduleProof(payload = {}, options = {}) {
    const titleNeedle = normalizeTitleNeedle(options.titleNeedle || payload.title);
    const shortsUrl = this._shortsContentUrl();
    await this.page.goto(shortsUrl, { waitUntil: 'domcontentloaded', timeout: this.navigationTimeoutMs });
    await safeWait(this.page, options.contentSettleMs || 7000);
    const proof = await this.page.evaluate(needle => {
      const lower = String(needle || '').toLowerCase();
      const rows = Array.from(document.querySelectorAll('ytcp-video-row'))
        .map((row, index) => {
          const text = (row.innerText || row.textContent || '').trim();
          if (!text.toLowerCase().includes(lower)) return null;
          const hrefs = Array.from(row.querySelectorAll('a[href]')).map(a => a.href);
          const thumbnailIds = Array.from(row.querySelectorAll('img[src*="/vi/"]'))
            .map(img => String(img.src || '').match(/\/vi\/([^/?]+)/))
            .filter(Boolean)
            .map(match => match[1]);
          const isDraft = /\bDraft\b|Edit draft/i.test(text);
          const isScheduled = /\bScheduled\b|\bPublic\b|\bUnlisted\b|Premiere/i.test(text) && !isDraft;
          return { index, text, hrefs, thumbnailIds, isDraft, isScheduled };
        })
        .filter(Boolean);
      return {
        finalUrl: location.href,
        title: document.title,
        bodySample: (document.body && document.body.innerText || '').slice(0, 1200),
        rows,
      };
    }, titleNeedle);
    const scheduledRow = proof.rows.find(row => row.isScheduled) || null;
    const href = scheduledRow ? scheduledRow.hrefs.find(item => /youtube\.com\/shorts\/|studio\.youtube\.com\/video\//i.test(item)) : null;
    const thumbId = scheduledRow && scheduledRow.thumbnailIds.length ? scheduledRow.thumbnailIds[0] : null;
    const remoteVideoId = extractYouTubeVideoId(href) || extractStudioVideoId(href) || thumbId || null;
    return {
      ...proof,
      titleNeedle,
      confirmed: Boolean(scheduledRow && remoteVideoId),
      matchedRows: proof.rows,
      scheduledRow,
      remoteUrl: href || (remoteVideoId ? `https://youtube.com/shorts/${remoteVideoId}` : null),
      remoteVideoId,
    };
  }
  async _setUploadFile(filePath) {
    const count = await countLocator(this.page, 'input[type="file"]');
    if (count < 1) {
      throw new Error('YOUTUBE_UPLOAD_FILE_INPUT_NOT_FOUND');
    }
    const input = this.page.locator('input[type="file"]').first();
    await input.setInputFiles(filePath);
    await safeWait(this.page, 3000);
    return {
      filePath,
      fileInputCount: count,
      setInputFilesCalled: true,
    };
  }

  async _waitForDraftDetailsSurface(options = {}) {
    const timeoutMs = Number.isFinite(Number(options.detailsTimeoutMs)) ? Number(options.detailsTimeoutMs) : 90000;
    const start = Date.now();
    let lastProof = null;
    while (Date.now() - start < timeoutMs) {
      lastProof = await this._readDraftDetailsProof();
      if (lastProof.detailsVisible || lastProof.titleFieldCount > 0 || lastProof.descriptionFieldCount > 0) {
        return lastProof;
      }
      await safeWait(this.page, 2000);
    }
    throw new Error(`YOUTUBE_DRAFT_DETAILS_NOT_VISIBLE: ${JSON.stringify(lastProof || {})}`);
  }

  async _readDraftDetailsProof() {
    const bodyText = await readBodyText(this.page);
    const titleFieldCount = await countAnyLocator(this.page, TITLE_SELECTORS);
    const descriptionFieldCount = await countAnyLocator(this.page, DESCRIPTION_SELECTORS);
    const nextButtonCount = await countRole(this.page, 'button', /^Next$/i);
    const saveButtonCount = await countRole(this.page, 'button', /^(Save|Done)$/i);
    const detailsVisible = /Details|Video details|Title \(required\)|Description/i.test(bodyText);
    const uploadProcessing = /Uploading|Processing|Checks will begin|Checking/i.test(bodyText);
    return {
      detailsVisible,
      titleFieldCount,
      descriptionFieldCount,
      nextButtonCount,
      saveButtonCount,
      uploadProcessing,
      sampledText: bodyText.slice(0, 700),
    };
  }

  async _fillDraftMetadata(payload = {}, options = {}) {
    const title = String(payload.title || '').trim();
    const description = String(payload.description || '').trim();
    const titleProof = title
      ? await fillFirstMatchingLocator(this.page, TITLE_SELECTORS, title, 'title')
      : { attempted: false, reason: 'empty-title' };
    const descriptionProof = description
      ? await fillFirstMatchingLocator(this.page, DESCRIPTION_SELECTORS, description, 'description')
      : { attempted: false, reason: 'empty-description' };

    let madeForKidsProof = { attempted: false, reason: 'not-requested' };
    if (payload.madeForKids === false) {
      madeForKidsProof = await clickAnyText(this.page, [/No, it's not made for kids/i, /No, it.s not made for kids/i], 'made-for-kids-no');
    } else if (payload.madeForKids === true) {
      madeForKidsProof = await clickAnyText(this.page, [/Yes, it's made for kids/i, /Yes, it.s made for kids/i], 'made-for-kids-yes');
    }

    return {
      title: titleProof,
      description: descriptionProof,
      madeForKids: madeForKidsProof,
      aiDisclosure: {
        attempted: false,
        requested: payload.aiDisclosure === true,
        reason: 'not-on-details-stage',
      },
      stopStage: options.stopStage || 'details',
    };
  }

  async _readFinalActionProof() {
    const bodyText = await readBodyText(this.page);
    return {
      publishButtonCount: await countRole(this.page, 'button', /^(Publish|Schedule)$/i),
      saveButtonCount: await countRole(this.page, 'button', /^(Save|Done)$/i),
      nextButtonCount: await countRole(this.page, 'button', /^Next$/i),
      finalActionBlocked: true,
      sampledText: bodyText.slice(0, 500),
    };
  }
  async _inspectMatchingShortDrafts(payload = {}, options = {}) {
    const titleNeedle = normalizeTitleNeedle(options.titleNeedle || payload.title);
    if (!titleNeedle) return { skipped: true, reason: 'empty-title-needle', matchCount: 0, matches: [] };
    const shortsUrl = this._shortsContentUrl();
    await this.page.goto(shortsUrl, { waitUntil: 'domcontentloaded', timeout: this.navigationTimeoutMs });
    await safeWait(this.page, options.contentSettleMs || 7000);
    const matches = await this.page.evaluate(needle => {
      const lower = String(needle || '').toLowerCase();
      return Array.from(document.querySelectorAll('ytcp-video-row'))
        .map((row, index) => {
          const text = (row.innerText || row.textContent || '').trim();
          if (!text.toLowerCase().includes(lower)) return null;
          const isDraft = /\bDraft\b|Edit draft/i.test(text);
          const hrefs = Array.from(row.querySelectorAll('a[href]')).map(a => a.href);
          const thumbnailIds = Array.from(row.querySelectorAll('img[src*="/vi/"]'))
            .map(img => String(img.src || '').match(/\/vi\/([^/?]+)/))
            .filter(Boolean)
            .map(match => match[1]);
          return { index, text, isDraft, hrefs, thumbnailIds };
        })
        .filter(Boolean)
        .filter(row => row.isDraft);
    }, titleNeedle);
    return {
      skipped: false,
      shortsUrl,
      titleNeedle,
      matchCount: matches.length,
      matches,
    };
  }

  async _resumeMatchingShortDraft(payload = {}, options = {}, duplicateDraftProof = null) {
    const titleNeedle = normalizeTitleNeedle(options.titleNeedle || payload.title);
    const row = this.page.locator('ytcp-video-row').filter({ hasText: titleNeedle }).filter({ hasText: 'Draft' }).first();
    await row.scrollIntoViewIfNeeded().catch(() => {});
    await row.hover().catch(() => {});
    const clicked = await row.locator('button[aria-label="Edit draft"], [aria-label="Edit draft"]').first().click({ timeout: 10000, force: true }).then(() => true).catch(() => false);
    if (!clicked) {
      throw new Error(`YOUTUBE_MATCHING_DRAFT_RESUME_FAILED: ${JSON.stringify(duplicateDraftProof || {})}`);
    }
    await safeWait(this.page, options.dialogWaitMs || 3000);
    const draftSurfaceProof = await this._waitForDraftDetailsSurface(options);
    const metadataProof = await this._fillDraftMetadata(payload, options);
    const finalActionProof = await this._readFinalActionProof();
    return {
      success: true,
      draftOnly: true,
      dryRun: false,
      resumedExistingDraft: true,
      fileSelected: false,
      noFinalAction: true,
      published: false,
      scheduled: false,
      dashboardUrl: this.dashboardUrl,
      channelProof: this.channelProof,
      duplicateDraftProof,
      draftSurfaceProof,
      metadataProof,
      finalActionProof,
      proofCheckedAt: new Date().toISOString(),
    };
  }

  _shortsContentUrl() {
    if (this.expectedChannelId) {
      return `https://studio.youtube.com/channel/${this.expectedChannelId}/videos/short`;
    }
    return this.dashboardUrl.replace(/\/dashboard.*$/i, '').replace(/\/?$/, '/videos/short');
  }
  async _readUploadEntryProof() {
    const bodyText = await readBodyText(this.page);
    const createButtonCount = await countRole(this.page, 'button', /Create/i);
    const uploadVideosMenuCount = await countRole(this.page, 'menuitem', /Upload videos/i);
    const uploadVideosButtonCount = await countRole(this.page, 'button', /Upload videos/i);
    const uploadVideosText = /Upload videos/i.test(bodyText);

    return {
      hasCreateEntry: createButtonCount > 0,
      hasUploadVideosEntry: uploadVideosMenuCount > 0 || uploadVideosButtonCount > 0 || uploadVideosText,
      createButtonCount,
      uploadVideosMenuCount,
      uploadVideosButtonCount,
      uploadVideosText,
      sampledText: bodyText.slice(0, 500),
    };
  }

  async _openUploadWizardForInspection(options = {}) {
    const entryProof = await this._readUploadEntryProof();
    if (!entryProof.hasCreateEntry) {
      throw new Error(`YOUTUBE_UPLOAD_CREATE_ENTRY_NOT_FOUND: ${JSON.stringify(entryProof)}`);
    }

    const createClicked = await clickRole(this.page, 'button', /Create/i);
    if (!createClicked) {
      throw new Error(`YOUTUBE_UPLOAD_CREATE_CLICK_FAILED: ${JSON.stringify(entryProof)}`);
    }
    await safeWait(this.page, options.menuWaitMs || 1000);

    const uploadClicked = await clickRole(this.page, 'menuitem', /Upload videos/i)
      || await clickRole(this.page, 'button', /Upload videos/i)
      || await clickText(this.page, /Upload videos/i);
    if (!uploadClicked) {
      const afterCreateProof = await this._readUploadEntryProof();
      throw new Error(`YOUTUBE_UPLOAD_VIDEOS_ENTRY_NOT_FOUND: ${JSON.stringify(afterCreateProof)}`);
    }

    await safeWait(this.page, options.dialogWaitMs || 3000);
    const wizardProof = await this._readUploadWizardProof();
    if (!wizardProof.uploadDialogVisible) {
      throw new Error(`YOUTUBE_UPLOAD_DIALOG_NOT_VERIFIED: ${JSON.stringify(wizardProof)}`);
    }
    return wizardProof;
  }

  async _readUploadWizardProof() {
    const bodyText = await readBodyText(this.page);
    const uploadDialogCount = await countLocator(this.page, 'ytcp-uploads-dialog');
    const fileInputCount = await countLocator(this.page, 'input[type="file"]');
    const selectFilesButtonCount = await countRole(this.page, 'button', /Select files/i);
    const uploadVideosText = /Upload videos/i.test(bodyText);
    const selectFilesText = /Select files/i.test(bodyText);

    return {
      uploadDialogVisible: uploadDialogCount > 0 || (uploadVideosText && selectFilesText),
      uploadDialogCount,
      fileInputCount,
      selectFilesButtonCount,
      uploadVideosText,
      selectFilesText,
      noFileSelected: true,
      sampledText: bodyText.slice(0, 500),
    };
  }

  async _closeUploadWizard() {
    if (this.page && this.page.keyboard && typeof this.page.keyboard.press === 'function') {
      await this.page.keyboard.press('Escape').catch(() => {});
      await safeWait(this.page, 500);
    }
    await clickRole(this.page, 'button', /^Close$/i).catch(() => false);
  }
  async close() {
    if (this.context && typeof this.context.close === 'function') await this.context.close();
    if (this.browser && typeof this.browser.close === 'function') await this.browser.close();
    this.context = null;
    this.browser = null;
    this.page = null;
    this.log('[YT-STUDIO] Browser closed');
  }

  async _waitForChannelProof() {
    const start = Date.now();
    let lastProof = null;
    let loggedWaiting = false;

    while (Date.now() - start < this.loginWaitMs) {
      lastProof = await this._readChannelProof();
      if (lastProof.verified) return lastProof;

      if (lastProof.loginRequired && !loggedWaiting) {
        this.log('[YT-STUDIO] Waiting for YouTube/Google login in the browser window...');
        loggedWaiting = true;
      }
      await safeWait(this.page, LOGIN_POLL_INTERVAL);
    }

    const detail = lastProof ? JSON.stringify({
      url: lastProof.url,
      title: lastProof.title,
      expectedChannelId: lastProof.expectedChannelId,
      channelIdMatched: lastProof.channelIdMatched,
      studioLoaded: lastProof.studioLoaded,
      loginRequired: lastProof.loginRequired,
      indicators: lastProof.indicators,
    }) : 'no page proof';
    throw new Error(`YOUTUBE_CHANNEL_CONTEXT_NOT_VERIFIED: ${detail}`);
  }

  async _readChannelProof() {
    const url = typeof this.page.url === 'function' ? this.page.url() : '';
    const title = await this.page.title().catch(() => '');
    const bodyText = await readBodyText(this.page);
    const ytcpAppCount = await countLocator(this.page, 'ytcp-app');
    const createButtonCount = await countRole(this.page, 'button', /Create/i);
    const dashboardText = /Channel dashboard|Dashboard|Analytics|Content|Comments|Customization/i.test(bodyText);
    const studioHost = /(^|\/\/)studio\.youtube\.com/i.test(url);
    const loginRequired = /accounts\.google\.com|ServiceLogin|signin|Sign in to continue|Use your Google Account/i.test(`${url}\n${title}\n${bodyText.slice(0, 1000)}`);
    const channelIdMatched = this.expectedChannelId
      ? (url.includes(this.expectedChannelId) || bodyText.includes(this.expectedChannelId))
      : false;
    const studioLoaded = studioHost && (ytcpAppCount > 0 || dashboardText || createButtonCount > 0);

    return {
      verified: Boolean(studioLoaded && channelIdMatched && !loginRequired),
      url,
      title,
      expectedChannelId: this.expectedChannelId,
      channelIdMatched,
      studioLoaded,
      loginRequired,
      indicators: {
        studioHost,
        ytcpAppCount,
        createButtonCount,
        dashboardText,
      },
      sampledText: bodyText.slice(0, 500),
    };
  }
}

async function readAnchorHrefs(page) {
  try {
    if (!page || !page.evaluate) return [];
    return await page.evaluate(() => Array.from(document.querySelectorAll('a[href]')).map(anchor => anchor.href));
  } catch (_) {
    return [];
  }
}

function formatStudioDate(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return String(value || '');
  return `${Number(match[2])}/${Number(match[3])}/${match[1]}`;
}

function formatStudioDateLong(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return String(value || '');
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function sameMonthYear(left, right) {
  const parse = value => {
    const match = String(value || '').match(/^([A-Z][a-z]{2})\s+(\d{1,2}),\s+(\d{4})$/);
    return match ? { month: match[1], year: match[3] } : null;
  };
  const a = parse(left);
  const b = parse(right);
  return Boolean(a && b && a.month === b.month && a.year === b.year);
}

function normalizeTitleNeedle(value) {
  return String(value || '')
    .replace(/#[\w]+/g, '')
    .replace(/[\u{1F300}-\u{1FAFF}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function formatStudioTime(value) {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return String(value || '');
  let hour = Number(match[1]);
  const minute = match[2];
  const suffix = hour >= 12 ? 'PM' : 'AM';
  hour = hour % 12;
  if (hour === 0) hour = 12;
  return `${hour}:${minute} ${suffix}`;
}

function extractYouTubeVideoId(url) {
  const text = String(url || '');
  const watch = text.match(/[?&]v=([^&#]+)/i);
  if (watch) return decodeURIComponent(watch[1]);
  const shorts = text.match(/youtube\.com\/shorts\/([^?#/]+)/i);
  if (shorts) return decodeURIComponent(shorts[1]);
  const short = text.match(/youtu\.be\/([^?#/]+)/i);
  return short ? decodeURIComponent(short[1]) : null;
}

function extractStudioVideoId(url) {
  const match = String(url || '').match(/studio\.youtube\.com\/video\/([^/?#]+)/i);
  return match ? decodeURIComponent(match[1]) : null;
}
async function readBodyText(page) {
  try {
    if (page.locator) {
      return await page.locator('body').innerText({ timeout: 5000 });
    }
  } catch (_) {}
  try {
    if (page.evaluate) {
      return await page.evaluate(() => document.body?.innerText || '');
    }
  } catch (_) {}
  return '';
}

async function countLocator(page, selector) {
  try {
    if (!page.locator) return 0;
    return await page.locator(selector).count();
  } catch (_) {
    return 0;
  }
}

async function countRole(page, role, name) {
  try {
    if (!page.getByRole) return 0;
    return await page.getByRole(role, { name }).count();
  } catch (_) {
    return 0;
  }
}

async function clickDatePickerDay(page, day) {
  try {
    if (!page || !page.evaluate) return { clicked: false, reason: 'no-page' };
    return await page.evaluate(dayText => {
      const visible = el => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const disabled = el => el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true' || el.disabled === true;
      const textOf = el => (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
      const roots = Array.from(document.querySelectorAll('ytcp-date-picker, tp-yt-paper-dialog, tp-yt-iron-dropdown, ytcp-dialog, [role="dialog"], ytcp-popup-container'))
        .filter(visible);
      const scopes = roots.length ? roots : [document.body];
      const selector = 'button, [role="button"], tp-yt-paper-item, ytcp-ve, td, div, span';
      const candidates = [];
      for (const root of scopes) {
        for (const el of Array.from(root.querySelectorAll(selector))) {
          if (!visible(el) || disabled(el)) continue;
          const text = textOf(el);
          const aria = (el.getAttribute('aria-label') || '').trim();
          if (text === dayText || aria === dayText || new RegExp('\\b' + dayText + '\\b').test(aria)) {
            const rect = el.getBoundingClientRect();
            candidates.push({ el, text, aria, tag: el.tagName, role: el.getAttribute('role'), area: rect.width * rect.height });
          }
        }
      }
      candidates.sort((a, b) => a.area - b.area);
      const target = candidates[0];
      if (!target) {
        return {
          clicked: false,
          reason: 'day-not-found',
          day: dayText,
          rootCount: roots.length,
          sample: scopes.flatMap(root => Array.from(root.querySelectorAll(selector)).slice(0, 60).map(textOf)).filter(Boolean).slice(0, 80),
        };
      }
      target.el.scrollIntoView({ block: 'center', inline: 'center' });
      target.el.click();
      return { clicked: true, day: dayText, text: target.text, aria: target.aria, tag: target.tag, role: target.role, rootCount: roots.length };
    }, String(day || ''));
  } catch (error) {
    return { clicked: false, reason: error.message || String(error) };
  }
}
async function clickRole(page, role, name, timeout = 5000) {
  try {
    if (!page || !page.getByRole) return false;
    const locator = page.getByRole(role, { name });
    const target = locator && typeof locator.first === 'function' ? locator.first() : locator;
    if (!target || typeof target.click !== 'function') return false;
    if (typeof target.scrollIntoViewIfNeeded === 'function') {
      await target.scrollIntoViewIfNeeded().catch(() => {});
    }
    await target.click({ timeout });
    return true;
  } catch (_) {
    return false;
  }
}

async function clickText(page, text, timeout = 5000) {
  try {
    if (!page || !page.getByText) return false;
    const locator = page.getByText(text);
    const target = locator && typeof locator.first === 'function' ? locator.first() : locator;
    if (!target || typeof target.click !== 'function') return false;
    if (typeof target.scrollIntoViewIfNeeded === 'function') {
      await target.scrollIntoViewIfNeeded().catch(() => {});
    }
    await target.click({ timeout });
    return true;
  } catch (_) {
    return false;
  }
}
async function countAnyLocator(page, selectors) {
  let total = 0;
  for (const selector of selectors) {
    total += await countLocator(page, selector);
  }
  return total;
}

async function firstMatchingLocator(page, selectors) {
  if (!page || !page.locator) return null;
  for (const selector of selectors) {
    try {
      const locator = page.locator(selector);
      const count = await locator.count();
      if (count > 0) return { selector, locator: locator.first(), count };
    } catch (_) {}
  }
  return null;
}

async function fillFirstMatchingLocator(page, selectors, value, label) {
  const match = await firstMatchingLocator(page, selectors);
  if (!match) {
    throw new Error(`YOUTUBE_${String(label || 'FIELD').toUpperCase()}_FIELD_NOT_FOUND`);
  }
  if (typeof match.locator.scrollIntoViewIfNeeded === 'function') {
    await match.locator.scrollIntoViewIfNeeded().catch(() => {});
  }
  if (typeof match.locator.fill === 'function') {
    await match.locator.fill(value, { timeout: 10000 });
  } else {
    await match.locator.click({ timeout: 10000 });
    if (page.keyboard && typeof page.keyboard.press === 'function') await page.keyboard.press('Control+A');
    if (page.keyboard && typeof page.keyboard.type === 'function') await page.keyboard.type(value);
  }
  return {
    attempted: true,
    filled: true,
    selector: match.selector,
    matchedCount: match.count,
    valueLength: String(value || '').length,
  };
}

async function clickAnyText(page, patterns, label) {
  const list = Array.isArray(patterns) ? patterns : [patterns];
  for (const pattern of list) {
    const clicked = await clickText(page, pattern, 7000);
    if (clicked) {
      return { attempted: true, clicked: true, label, pattern: String(pattern) };
    }
  }
  return { attempted: true, clicked: false, label, patterns: list.map(String) };
}

async function clickFirstLocator(page, selectors, label) {
  const match = await firstMatchingLocator(page, selectors);
  if (!match) return { attempted: true, clicked: false, label, reason: 'not-found' };
  if (typeof match.locator.scrollIntoViewIfNeeded === 'function') {
    await match.locator.scrollIntoViewIfNeeded().catch(() => {});
  }
  await match.locator.click({ timeout: 10000 });
  return { attempted: true, clicked: true, label, selector: match.selector, matchedCount: match.count };
}

async function readFirstInputValue(page, selectors) {
  const match = await firstMatchingLocator(page, selectors);
  if (!match) return null;
  try {
    return await match.locator.inputValue({ timeout: 3000 });
  } catch (_) {
    try {
      return await match.locator.evaluate(node => node.value || node.getAttribute('value') || node.textContent || null);
    } catch (_) {
      return null;
    }
  }
}
async function fillFirstInput(page, selectors, value, label) {
  const match = await firstMatchingLocator(page, selectors);
  if (!match) {
    return { attempted: true, filled: false, label, reason: 'not-found' };
  }
  if (typeof match.locator.scrollIntoViewIfNeeded === 'function') {
    await match.locator.scrollIntoViewIfNeeded().catch(() => {});
  }
  await match.locator.click({ timeout: 10000 });
  if (page.keyboard && typeof page.keyboard.press === 'function') await page.keyboard.press('Control+A');
  if (page.keyboard && typeof page.keyboard.type === 'function') await page.keyboard.type(String(value || ''));
  if (page.keyboard && typeof page.keyboard.press === 'function') {
    await page.keyboard.press('Enter').catch(() => {});
    await page.keyboard.press('Tab').catch(() => {});
  }
  return { attempted: true, filled: true, label, selector: match.selector, matchedCount: match.count, value: String(value || '') };
}

async function setFirstInputValue(page, selectors, value, label, previousError = null) {
  const match = await firstMatchingLocator(page, selectors);
  if (!match) {
    return { attempted: true, filled: false, label, reason: 'not-found', previousError: previousError ? String(previousError.message || previousError) : null };
  }
  await match.locator.evaluate((node, nextValue) => {
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    node.focus();
    if (valueSetter) valueSetter.call(node, nextValue);
    else node.value = nextValue;
    node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: nextValue }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
    node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    node.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
  }, String(value || ''));
  if (page.keyboard && typeof page.keyboard.press === 'function') {
    await page.keyboard.press('Enter').catch(() => {});
    await page.keyboard.press('Tab').catch(() => {});
  }
  return {
    attempted: true,
    filled: true,
    label,
    selector: match.selector,
    matchedCount: match.count,
    value: String(value || ''),
    method: 'dom-value',
    previousError: previousError ? String(previousError.message || previousError).slice(0, 500) : null,
  };
}
async function safeWait(page, ms) {
  if (page && typeof page.waitForTimeout === 'function') {
    await page.waitForTimeout(ms);
  }
}

function extractYouTubeStudioChannelId(url) {
  const match = String(url || '').match(/\/channel\/([^/?#]+)/i);
  return match ? decodeURIComponent(match[1]) : null;
}

module.exports = {
  YouTubeStudioUploader,
  extractYouTubeStudioChannelId,
};
