/**
 * cinema-video-automation.js - Phase 4 alternative cinematic video engine.
 *
 * Uses Higgsfield Cinema Studio 3.5 for video generation while keeping the
 * orchestrator-facing contract identical to KlingAutomation:
 *   generateClip({ startFramePath, multiShotPrompt, durationSeconds, outputPath, validElements, onGenClicked })
 *   recoverTimedOutClip(submittedPrompt, outputPath, opts)
 *
 * Scene/start-frame images come from local project files. The + picker is the
 * only scene-upload path. The @/Elements picker is only used for element
 * eligibility and real prompt attachment, never temporary diagnostics.
 */

const fs = require('fs');
const path = require('path');
const { KlingAutomation, parsePromptSegments } = require('./kling-automation');

const ELEMENT_ELIGIBILITY_CACHE_VERSION = 3;

class CinemaEligibilityError extends Error {
  constructor(message, failedAssets = []) {
    super(message);
    this.name = 'CinemaEligibilityError';
    this.code = 'CINEMA_ELIGIBILITY_FAILED';
    this.failedAssets = failedAssets;
  }
}

class CinemaRefundedFailureError extends Error {
  constructor(message, evidence = null) {
    super(message);
    this.name = 'CinemaRefundedFailureError';
    this.code = 'CINEMA_REFUNDED_FAILURE';
    this.evidence = evidence;
  }
}

class CinemaVideoAutomation extends KlingAutomation {
  constructor({ automation, logger, projectId, elementEligibilityCache, onElementEligibilityUpdate } = {}) {
    super({ automation, logger: logger || ((msg) => console.log(`[CINEMA-VIDEO] ${msg}`)) });
    this.modelName = 'cinema-studio-3.5';
    this.creditLedgerModelRe = /cinema\s*studio\s*3\.5/i;
    this._projectId = projectId || null;
    this._elementEligibilityCache = new Map();
    this._elementEligibilityProof = new Map();
    this._onElementEligibilityUpdate = typeof onElementEligibilityUpdate === 'function'
      ? onElementEligibilityUpdate
      : null;
    this._lastClipElementEligibility = { required: [], eligible: [] };
    this._hydrateElementEligibilityCache(elementEligibilityCache);
  }

  _elementEligibilityCacheKey(name) {
    return `${this._projectId || 'default'}::${String(name || '').trim().replace(/^@/, '').toLowerCase()}`;
  }

  _hydrateElementEligibilityCache(cache) {
    if (!cache || typeof cache !== 'object') return;
    for (const [rawKey, rawValue] of Object.entries(cache)) {
      const record = rawValue && typeof rawValue === 'object' ? rawValue : { status: rawValue };
      const status = String(record.status || '').toLowerCase();
      if (status !== 'eligible' && status !== 'not-eligible') continue;
      if (record.version !== ELEMENT_ELIGIBILITY_CACHE_VERSION) continue;
      const key = rawKey.includes('::') ? rawKey : this._elementEligibilityCacheKey(rawKey);
      this._elementEligibilityCache.set(key, status);
      this._elementEligibilityProof.set(key, record);
    }
  }

  _getCachedElementEligibility(name) {
    return this._elementEligibilityCache.get(this._elementEligibilityCacheKey(name));
  }

  _getElementEligibilityRecord(name) {
    return this._elementEligibilityProof.get(this._elementEligibilityCacheKey(name)) || null;
  }

  _buildElementEligibilityFailure(name, status) {
    const finalStatus = status === 'not-eligible' ? 'Not eligible' : status;
    const proof = this._getElementEligibilityRecord(name);
    const proofText = String(proof?.text || '');
    return {
      type: 'element',
      name,
      status: finalStatus,
      proof: proof || null,
      repairable: finalStatus === 'Not eligible',
      mixedUseProof: /not eligible/i.test(proofText) && /\bUse\b/i.test(proofText),
    };
  }

  _rememberElementEligibility(name, status, proof = {}) {
    const normalized = String(name || '').trim().replace(/^@/, '');
    const finalStatus = String(status || '').toLowerCase();
    if (!normalized || (finalStatus !== 'eligible' && finalStatus !== 'not-eligible')) return;
    const key = this._elementEligibilityCacheKey(normalized);
    const record = {
      status: finalStatus,
      checkedAt: new Date().toISOString(),
      projectId: this._projectId || null,
      name: normalized,
      version: ELEMENT_ELIGIBILITY_CACHE_VERSION,
      ...proof,
    };
    this._elementEligibilityCache.set(key, finalStatus);
    this._elementEligibilityProof.set(key, record);
    if (this._onElementEligibilityUpdate) {
      try {
        this._onElementEligibilityUpdate(key, record);
      } catch (err) {
        this.log(`Warn: could not persist element eligibility for @${normalized}: ${err.message}`);
      }
    }
  }

  invalidateElementEligibility(names) {
    const list = Array.isArray(names) ? names : [names];
    for (const name of list.filter(Boolean)) {
      const key = this._elementEligibilityCacheKey(name);
      this._elementEligibilityCache.delete(key);
      this._elementEligibilityProof.delete(key);
      if (this._onElementEligibilityUpdate) {
        try {
          this._onElementEligibilityUpdate(key, null);
        } catch (err) {
          this.log(`Warn: could not clear element eligibility for @${String(name).replace(/^@/, '')}: ${err.message}`);
        }
      }
    }
  }

  async generateClip({ startFramePath, multiShotPrompt, durationSeconds = 15, outputPath, validElements, aspectRatio = '16:9', onGenClicked, onVerificationRequired }) {
    if (!startFramePath) throw new Error('generateClip: startFramePath required');
    if (!fs.existsSync(startFramePath)) throw new Error(`[PRE-GEN] Start frame file not found: ${startFramePath}`);
    if (!multiShotPrompt) throw new Error('generateClip: multiShotPrompt required');
    if (multiShotPrompt.length > 2500) {
      throw new Error(`[PRE-GEN] Prompt exceeds 2500-char Cinema Studio limit (${multiShotPrompt.length} chars)`);
    }

    try {
      this._cinemaGeneratePhase = 'setup';
      await this.automation.ensureBrowser();
      await this._ensureCinemaStudio35VideoActive(aspectRatio);
      await this._assertCurrentCinemaProjectUrl('before start-frame upload');
      await this._attachStartFrameFromLocalUpload(startFramePath);
      await this._assertCurrentCinemaProjectUrl('after start-frame upload');
      await this._ensureElementEligibility(validElements);
      await this._armGenerateNetworkKillSwitch();
      await this._armCinemaGenerationEndpointBlocker();
      await this._setGenerateSafetyLock(true);
      this._expectedCinemaPromptText = multiShotPrompt;
      this._cinemaGeneratePhase = 'typing';
      await this._typeMultiShotPrompt(multiShotPrompt, validElements);
      const expectedReferenceTiles = this._expectedComposerReferenceTileCount(multiShotPrompt, validElements);
      this._lastClipElementEligibility.expectedReferenceTiles = expectedReferenceTiles;
      await this._waitForComposerReferenceAttachmentCount(expectedReferenceTiles, 45000);
      await this._assertCurrentCinemaProjectUrl('after prompt typing');
      this._cinemaGeneratePhase = 'preBaseline';
      await this._setGenerateSafetyLock(true);
      await this.automation.page.waitForTimeout(800);
    } catch (setupErr) {
      await this._cleanupCinemaSafetyAfterFailure('setup').catch(() => {});
      await this._setGenerateSafetyLock(false).catch(() => {});
      if (setupErr.code === 'CINEMA_ELIGIBILITY_FAILED') throw setupErr;
      if (setupErr.code === 'HIGGSFIELD_VERIFICATION_REQUIRED') throw setupErr;
      if (setupErr.message && setupErr.message.includes('SESSION_EXPIRED')) throw setupErr;
      throw new Error(`[PRE-GEN] ${setupErr.message}`);
    }

    try {
      const result = await this._generateAndDownload(outputPath, durationSeconds, onGenClicked, onVerificationRequired);
      return { ...result, model: this.modelName };
    } catch (err) {
      await this._cleanupCinemaSafetyAfterFailure('generate').catch(() => {});
      await this._setGenerateSafetyLock(false).catch(() => {});
      throw err;
    }
  }

  async recoverTimedOutClip(submittedPrompt, outputPath, opts = {}) {
    this.log('[RECOVERY] Cinema Studio recovery requires dialogue match');
    return super.recoverTimedOutClip(submittedPrompt, outputPath, {
      ...opts,
      requireDialogueMatch: true,
    });
  }

  async _typeMultiShotPrompt(promptText, validElements) {
    const page = this.automation.page;
    await this._focusPromptTextboxForTyping();
    await page.waitForTimeout(200);
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Delete');
    await page.waitForTimeout(200);

    const validSet = new Set([...(validElements || [])].map(name => String(name || '').toLowerCase().replace(/^@/, '')));
    const expectedMentionCounts = new Map();
    const segments = parsePromptSegments(promptText);

    for (const seg of segments) {
      if (typeof seg === 'string') {
        await page.keyboard.type(seg);
        continue;
      }
      if (!seg || !seg.at) continue;

      const name = String(seg.at || '').toLowerCase().replace(/^@+/, '');
      if (validElements && !validSet.has(name)) {
        this.log(`Skipping @-autocomplete for "${name}" — not a valid element, typing as plain text`);
        await page.keyboard.type(name);
        continue;
      }

      const lastChar = await page.evaluate(() => {
        const active = document.activeElement;
        const selection = window.getSelection?.();
        const selectedNode = selection?.anchorNode?.nodeType === Node.ELEMENT_NODE
          ? selection.anchorNode
          : selection?.anchorNode?.parentElement;
        const tb = active?.closest?.('[role="textbox"]')
          || selectedNode?.closest?.('[role="textbox"]')
          || document.querySelector('[data-cinema-prompt-target="typing"]');
        const text = tb ? (tb.innerText || tb.textContent || '') : '';
        return text.slice(-1);
      }).catch(() => '');
      if (lastChar && lastChar !== ' ' && lastChar !== '\n') {
        await page.keyboard.type(' ');
        await page.waitForTimeout(50);
      }

      this.log(`[PROMPT] Typing strict @mention: "@${name}"`);
      await page.keyboard.type('@', { delay: 0 });
      await page.waitForTimeout(500);
      await page.keyboard.type(name, { delay: 85 });
      await page.waitForTimeout(1700);

      const selected = await this._selectExactMentionOption(name);
      if (!selected.ok) {
        throw new Error(`[PRE-GEN] Required Cinema Studio @mention did not resolve for @${name}. Options: ${JSON.stringify(selected.options || [])}`);
      }
      this.log(`[PROMPT] Strict @mention selected: @${name} → "${selected.text}"`);
      expectedMentionCounts.set(name, (expectedMentionCounts.get(name) || 0) + 1);

      const audit = await this._auditPromptMentionChips(expectedMentionCounts);
      if (!audit.ok) {
        throw new Error(`[PRE-GEN] @mention chip audit failed after @${name}: ${audit.reason}`);
      }
    }

    const finalAudit = await this._auditPromptMentionChips(expectedMentionCounts);
    if (!finalAudit.ok) {
      throw new Error(`[PRE-GEN] Final @mention chip audit failed: ${finalAudit.reason}`);
    }
  }

  async _selectExactMentionOption(name) {
    const page = this.automation.page;
    const target = String(name || '').toLowerCase().replace(/^@/, '');
    const state = await page.evaluate((targetName) => {
      const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const normalize = (value) => clean(value).toLowerCase().replace(/^@/, '');
      const textbox = document.querySelector('[role="textbox"]');
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 10 && r.height > 10 && s.display !== 'none' && s.visibility !== 'hidden'
          && r.top < innerHeight && r.left < innerWidth && r.bottom > 0 && r.right > 0;
      };
      const optionNodes = [
        ...document.querySelectorAll('[role="option"]'),
        ...document.querySelectorAll('[role="listbox"] [role="option"]'),
        ...document.querySelectorAll('[role="menu"] [role="menuitem"]'),
        ...document.querySelectorAll('[role="menuitem"]'),
        ...document.querySelectorAll('[data-radix-popper-content-wrapper] [role="option"]'),
        ...document.querySelectorAll('[data-radix-popper-content-wrapper] [role="menuitem"]'),
        ...document.querySelectorAll('[class*="dropdown"] [role="option"], [class*="autocomplete"] [role="option"]'),
      ];
      const seen = new Set();
      const options = [];
      for (const el of optionNodes) {
        if (textbox && textbox.contains(el)) continue;
        if (!visible(el)) continue;
        const text = clean(el.innerText || el.textContent || '');
        if (!text || seen.has(el)) continue;
        seen.add(el);
        const normalized = normalize(text);
        if (!/[a-z0-9_]/i.test(normalized)) continue;
        const tokens = normalized.split(/\s+/).filter(Boolean);
        const r = el.getBoundingClientRect();
        options.push({
          text,
          normalized,
          tokens,
          x: Math.round(r.x + r.width / 2),
          y: Math.round(r.y + r.height / 2),
          area: Math.round(r.width * r.height),
        });
      }
      const exact = options
        .filter(o => {
          const compact = o.normalized.replace(/\s+/g, '');
          const firstCompact = String(o.tokens[0] || '').replace(/\s+/g, '');
          return o.normalized === targetName || o.tokens[0] === targetName ||
            compact === targetName || firstCompact === targetName;
        })
        .filter(o => !o.tokens.some(token => {
          const compactToken = token.replace(/\s+/g, '');
          return token !== targetName && compactToken !== targetName && token.includes(targetName);
        }))
        .sort((a, b) => {
          const aExact = a.normalized === targetName ? 0 : 1;
          const bExact = b.normalized === targetName ? 0 : 1;
          if (aExact !== bExact) return aExact - bExact;
          return a.area - b.area;
        })[0];
      return {
        ok: !!exact,
        exact,
        options: options.slice(0, 12).map(o => o.normalized),
      };
    }, target).catch(err => ({ ok: false, options: [`eval-error: ${err.message}`] }));

    if (!state.ok || !state.exact) return state;
    await page.mouse.click(state.exact.x, state.exact.y);
    await page.waitForTimeout(500);
    return { ok: true, text: state.exact.text, options: state.options };
  }

  async _auditPromptMentionChips(expectedCounts) {
    const page = this.automation.page;
    const expected = Object.fromEntries([...expectedCounts.entries()]);
    return page.evaluate((expectedByName) => {
      const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const canonical = (value) => clean(value).toLowerCase().replace(/^@/, '').replace(/\s+/g, '');
      const expectedNames = new Set(Object.keys(expectedByName).map(canonical));
      const chipTexts = [];
      const seenNodes = new Set();
      const root = document.querySelector('[role="textbox"]') || document;
      const primary = [...root.querySelectorAll('[data-beautiful-mention]')];
      const fallback = [...root.querySelectorAll('[contenteditable="false"]')]
        .filter(el => /[a-z0-9_]/i.test(clean(el.innerText || el.textContent || '')));
      for (const el of [...primary, ...fallback]) {
        const chipRoot = el.closest('[data-beautiful-mention]') || el.closest('[contenteditable="false"]') || el;
        if (seenNodes.has(chipRoot)) continue;
        seenNodes.add(chipRoot);
        const text = canonical(chipRoot.innerText || chipRoot.textContent || '');
        if (!text || !/[a-z0-9_]/.test(text)) continue;
        chipTexts.push(text);
      }
      const counts = {};
      for (const text of chipTexts) {
        if (expectedNames.has(text)) counts[text] = (counts[text] || 0) + 1;
      }
      const unexpected = chipTexts.filter(text => !expectedNames.has(text));
      if (unexpected.length > 0) {
        return { ok: false, reason: `unexpected mention chip(s): ${unexpected.join(', ')}` };
      }
      const missing = [];
      for (const [name, expectedCount] of Object.entries(expectedByName)) {
        const key = canonical(name);
        if ((counts[key] || 0) < expectedCount) {
          missing.push(`${name} expected ${expectedCount}, found ${counts[key] || 0}`);
        }
      }
      if (missing.length > 0) return { ok: false, reason: `missing mention chip(s): ${missing.join('; ')}` };
      return { ok: true, chips: chipTexts };
    }, expected).catch(err => ({ ok: false, reason: err.message }));
  }

  _expectedComposerReferenceTileCount(promptText, validElements) {
    const validSet = new Set([...(validElements || [])]
      .filter(Boolean)
      .map(name => String(name).trim().replace(/^@/, '').toLowerCase())
      .filter(Boolean));
    const distinctPromptRefs = new Set();
    for (const seg of parsePromptSegments(promptText || '')) {
      if (!seg || !seg.at) continue;
      const name = String(seg.at).trim().replace(/^@+/, '').toLowerCase();
      if (!name) continue;
      if (validSet.size > 0 && !validSet.has(name)) continue;
      distinctPromptRefs.add(name);
    }
    return 1 + distinctPromptRefs.size;
  }

  async _setGenerateSafetyLock(locked) {
    const page = this.automation.page;
    if (!page || page.isClosed?.()) return;
    await page.evaluate((shouldLock) => {
      const lockKey = '__cinemaGenerateSafetyLockInstalled';
      const shieldId = 'cinema-generate-safety-shield';
      const findGenerateButtons = () => [...document.querySelectorAll('button[type="submit"], button')]
        .filter((b) => /generate/i.test(b.textContent || '') && b.getBoundingClientRect().width > 0);
      const isAllowedNow = () => Date.now() < (window.__cinemaGenerateSafetyAllowUntil || 0);
      const eventInsideGenerateButton = (event) => {
        if (!event || typeof event.clientX !== 'number' || typeof event.clientY !== 'number') return null;
        for (const button of findGenerateButtons()) {
          const r = button.getBoundingClientRect();
          if (event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom) {
            return button;
          }
        }
        return null;
      };
      const prevent = (event, reason) => {
        if (!window.__cinemaGenerateSafetyLocked || isAllowedNow()) return false;
        event?.preventDefault?.();
        event?.stopImmediatePropagation?.();
        console.warn(`[CINEMA-SAFETY] Blocked Generate ${reason} while safety lock is active`);
        return true;
      };
      const isGenerateButton = (el) => {
        const button = el?.closest?.('button');
        return button && /generate/i.test(button.textContent || '') ? button : null;
      };
      const updateShield = () => {
        const buttons = findGenerateButtons();
        let shield = document.getElementById(shieldId);
        if (!window.__cinemaGenerateSafetyLocked || isAllowedNow() || buttons.length === 0) {
          if (shield) shield.remove();
          return;
        }
        const rects = buttons.map(b => b.getBoundingClientRect()).filter(r => r.width > 0 && r.height > 0);
        if (rects.length === 0) {
          if (shield) shield.remove();
          return;
        }
        const left = Math.min(...rects.map(r => r.left));
        const top = Math.min(...rects.map(r => r.top));
        const right = Math.max(...rects.map(r => r.right));
        const bottom = Math.max(...rects.map(r => r.bottom));
        if (!shield) {
          shield = document.createElement('div');
          shield.id = shieldId;
          shield.setAttribute('data-cinema-generate-shield', 'true');
          shield.addEventListener('click', (event) => prevent(event, 'shield click'), true);
          shield.addEventListener('pointerdown', (event) => prevent(event, 'shield pointer'), true);
          document.documentElement.appendChild(shield);
        }
        Object.assign(shield.style, {
          position: 'fixed',
          left: `${Math.max(0, left - 8)}px`,
          top: `${Math.max(0, top - 8)}px`,
          width: `${Math.max(1, right - left + 16)}px`,
          height: `${Math.max(1, bottom - top + 16)}px`,
          zIndex: '2147483647',
          pointerEvents: 'auto',
          background: 'transparent',
          cursor: 'not-allowed',
        });
      };
      const applyButtonLock = () => {
        for (const b of findGenerateButtons()) {
          if (window.__cinemaGenerateSafetyLocked && !isAllowedNow()) {
            if (!b.hasAttribute('data-cinema-old-tabindex')) {
              b.setAttribute('data-cinema-old-tabindex', b.getAttribute('tabindex') ?? '');
            }
            if (!b.hasAttribute('data-cinema-old-disabled')) {
              b.setAttribute('data-cinema-old-disabled', b.disabled ? 'true' : 'false');
            }
            b.setAttribute('data-cinema-generate-locked', 'true');
            b.setAttribute('aria-disabled', 'true');
            b.setAttribute('tabindex', '-1');
            b.disabled = true;
            b.style.pointerEvents = 'none';
            b.style.filter = 'grayscale(0.65) brightness(0.8)';
            b.style.cursor = 'not-allowed';
            if (document.activeElement === b) b.blur();
          } else {
            const oldTabIndex = b.getAttribute('data-cinema-old-tabindex');
            if (oldTabIndex !== null) {
              if (oldTabIndex === '') b.removeAttribute('tabindex');
              else b.setAttribute('tabindex', oldTabIndex);
              b.removeAttribute('data-cinema-old-tabindex');
            }
            const oldDisabled = b.getAttribute('data-cinema-old-disabled');
            if (oldDisabled !== null) {
              b.disabled = oldDisabled === 'true';
              b.removeAttribute('data-cinema-old-disabled');
            }
            b.removeAttribute('data-cinema-generate-locked');
            b.removeAttribute('aria-disabled');
            b.style.pointerEvents = '';
            b.style.filter = '';
            b.style.cursor = '';
          }
        }
        updateShield();
      };
      if (!window[lockKey]) {
        window.__cinemaGenerateSafetyLocked = false;
        window.__cinemaGenerateSafetyAllowOnce = false;
        window.__cinemaGenerateSafetyAllowUntil = 0;
        window.__cinemaGenerateSafetyHandler = (event) => {
          const target = isGenerateButton(event.target) || eventInsideGenerateButton(event);
          if (!target) return;
          prevent(event, event.type);
        };
        window.__cinemaGenerateSafetyKeyHandler = (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          const target = isGenerateButton(event.target) || isGenerateButton(document.activeElement);
          if (!target) return;
          prevent(event, `key ${event.key}`);
        };
        window.__cinemaGenerateSafetyFocusHandler = (event) => {
          const target = isGenerateButton(event.target);
          if (!target || !window.__cinemaGenerateSafetyLocked || isAllowedNow()) return;
          target.blur();
        };
        document.addEventListener('click', window.__cinemaGenerateSafetyHandler, true);
        document.addEventListener('pointerdown', window.__cinemaGenerateSafetyHandler, true);
        document.addEventListener('keydown', window.__cinemaGenerateSafetyKeyHandler, true);
        document.addEventListener('focusin', window.__cinemaGenerateSafetyFocusHandler, true);
        window.__cinemaGenerateSafetyOriginalButtonClick = HTMLButtonElement.prototype.click;
        HTMLButtonElement.prototype.click = function(...args) {
          if (isGenerateButton(this) && window.__cinemaGenerateSafetyLocked && !isAllowedNow()) {
            console.warn('[CINEMA-SAFETY] Blocked Generate programmatic click while safety lock is active');
            return undefined;
          }
          return window.__cinemaGenerateSafetyOriginalButtonClick.apply(this, args);
        };
        window.__cinemaGenerateSafetyObserver = new MutationObserver(() => applyButtonLock());
        window.__cinemaGenerateSafetyObserver.observe(document.documentElement, { childList: true, subtree: true });
        window.__cinemaGenerateSafetyInterval = window.setInterval(applyButtonLock, 150);
        window[lockKey] = true;
      }
      window.__cinemaGenerateSafetyLocked = Boolean(shouldLock);
      window.__cinemaGenerateSafetyAllowOnce = false;
      if (!shouldLock) window.__cinemaGenerateSafetyAllowUntil = Date.now() + 15000;
      applyButtonLock();
    }, Boolean(locked)).catch(() => {});
  }

  async _allowNextGenerateClick() {
    await this._disarmGenerateNetworkKillSwitch('intentional Generate click');
    const page = this.automation.page;
    if (!page || page.isClosed?.()) return;
    await page.evaluate(() => {
      window.__cinemaGenerateSafetyLocked = false;
      window.__cinemaGenerateSafetyAllowOnce = true;
      window.__cinemaGenerateSafetyAllowUntil = Date.now() + 15000;
      document.getElementById('cinema-generate-safety-shield')?.remove();
      for (const b of [...document.querySelectorAll('button[type="submit"], button')]) {
        if (!/generate/i.test(b.textContent || '')) continue;
        const oldTabIndex = b.getAttribute('data-cinema-old-tabindex');
        if (oldTabIndex !== null) {
          if (oldTabIndex === '') b.removeAttribute('tabindex');
          else b.setAttribute('tabindex', oldTabIndex);
          b.removeAttribute('data-cinema-old-tabindex');
        }
        const oldDisabled = b.getAttribute('data-cinema-old-disabled');
        if (oldDisabled !== null) {
          b.disabled = oldDisabled === 'true';
          b.removeAttribute('data-cinema-old-disabled');
        }
        b.removeAttribute('data-cinema-generate-locked');
        b.removeAttribute('aria-disabled');
        b.style.pointerEvents = '';
        b.style.filter = '';
        b.style.cursor = '';
      }
    }).catch(() => {});
  }

  async _armGenerateNetworkKillSwitch() {
    const page = this.automation.page;
    if (!page || page.isClosed?.()) return;
    await this._disarmGenerateNetworkKillSwitch();
    const shouldBlock = (request) => {
      const method = String(request.method() || 'GET').toUpperCase();
      if (method === 'GET' || method === 'OPTIONS' || method === 'HEAD') return false;
      const url = String(request.url() || '').toLowerCase();
      const body = String(request.postData() || '').toLowerCase();
      const haystack = `${url} ${body}`;
      if (/clerk\.higgsfield\.ai\/v1\/client\/sessions\/[^/]+\/tokens/.test(haystack)
          || /eligib|credit|ledger|history|autocomplete|mention|search|analytics|telemetry|sentry|segment|amplitude|mixpanel|posthog/.test(haystack)) {
        return false;
      }
      // Uploads/eligibility are complete before this guard is armed. During
      // prompt typing/autocomplete, any remaining write request is too risky:
      // Higgsfield's Generate submit endpoint has changed names more than once.
      return true;
    };
    this._generateNetworkKillSwitchHandler = async (route, request) => {
      if (shouldBlock(request)) {
        this.log(`[CINEMA-SAFETY] Aborted accidental generation request while typing: ${request.method()} ${request.url()}`, 'warn');
        await route.abort('blockedbyclient').catch(() => {});
        return;
      }
      await route.continue().catch(() => {});
    };
    await page.route('**/*', this._generateNetworkKillSwitchHandler);
    this.log('[CINEMA-SAFETY] Generation network kill switch armed for prompt typing');
  }

  async _disarmGenerateNetworkKillSwitch(reason = 'cleanup') {
    const page = this.automation.page;
    if (!page || page.isClosed?.() || !this._generateNetworkKillSwitchHandler) return;
    const handler = this._generateNetworkKillSwitchHandler;
    this._generateNetworkKillSwitchHandler = null;
    await page.unroute('**/*', handler).catch(() => {});
    this.log(`[CINEMA-SAFETY] Generation network kill switch disarmed for ${reason}`);
  }

  async _cleanupCinemaSafetyAfterFailure(reason = 'failure') {
    const phase = this._cinemaGeneratePhase || 'unknown';
    if (phase === 'intentionalGenerate' || phase === 'postGenerate') {
      await this._disarmCinemaGenerationEndpointBlocker().catch(() => {});
    } else if (this._cinemaGenerationEndpointBlocker) {
      this.log(`[CINEMA-SAFETY] Keeping generation endpoint blocker armed after pre-baseline ${reason} failure (phase=${phase})`, 'warn');
    }
    await this._disarmGenerateNetworkKillSwitch(reason).catch(() => {});
  }

  async _armCinemaGenerationEndpointBlocker() {
    const page = this.automation.page;
    const context = page?.context();
    if (!page || !context) return;
    await this._disarmCinemaGenerationEndpointBlocker().catch(() => {});
    this._lastCinemaEndpointBlockAt = 0;
    this._cinemaEndpointBlockCount = 0;
    const pattern = '**/jobs/v2/cinematic_studio_video_3_5**';
    const handler = async (route, request) => {
      this._lastCinemaEndpointBlockAt = Date.now();
      this._cinemaEndpointBlockCount = (this._cinemaEndpointBlockCount || 0) + 1;
      this.log(`[CINEMA-SAFETY] Endpoint blocked pre-baseline Cinema generation request #${this._cinemaEndpointBlockCount}: ${request.method()} ${request.url()}`, 'warn');
      await route.abort('blockedbyclient').catch(() => {});
    };
    this._cinemaGenerationEndpointBlocker = { context, page, pattern, handler };
    await context.route(pattern, handler);
    await page.route(pattern, handler);
    this.log('[CINEMA-SAFETY] Generation endpoint blocker armed until usage baseline is captured');
  }

  async _waitForCinemaEndpointQuietPeriod({ quietMs = 10000, timeoutMs = 30000, label = 'pre-baseline' } = {}) {
    const page = this.automation.page;
    if (!page || page.isClosed?.()) return;
    const startedAt = Date.now();
    const initialCount = this._cinemaEndpointBlockCount || 0;
    if (this._lastCinemaEndpointBlockAt) {
      this.log(`[CINEMA-SAFETY] Waiting for ${Math.round(quietMs / 1000)}s Cinema endpoint quiet period before ${label} (${initialCount} blocked submit(s) so far)`);
    }

    while (Date.now() - startedAt < timeoutMs) {
      const lastBlockAt = this._lastCinemaEndpointBlockAt || 0;
      if (!lastBlockAt || Date.now() - lastBlockAt >= quietMs) {
        const finalCount = this._cinemaEndpointBlockCount || 0;
        if (finalCount > initialCount || lastBlockAt) {
          this.log(`[CINEMA-SAFETY] Cinema endpoint quiet period satisfied before ${label} (${finalCount} blocked submit(s), ${Math.round((Date.now() - Math.max(lastBlockAt, startedAt)) / 1000)}s quiet)`);
        }
        return;
      }

      const remainingQuietMs = quietMs - (Date.now() - lastBlockAt);
      await page.waitForTimeout(Math.min(1000, Math.max(250, remainingQuietMs)));
    }

    this.log(`[CINEMA-SAFETY] Warn: Cinema endpoint quiet period timed out before ${label}; continuing with endpoint blocker still armed`, 'warn');
  }

  async _disarmCinemaGenerationEndpointBlocker() {
    const blocker = this._cinemaGenerationEndpointBlocker;
    if (!blocker) return;
    this._cinemaGenerationEndpointBlocker = null;
    await blocker.page?.unroute(blocker.pattern, blocker.handler).catch(() => {});
    await blocker.context.unroute(blocker.pattern, blocker.handler).catch(() => {});
    this.log('[CINEMA-SAFETY] Generation endpoint blocker disarmed');
  }

  _cinemaProjectUrl() {
    return this._projectId
      ? `https://higgsfield.ai/generate?projectId=${this._projectId}`
      : 'https://higgsfield.ai/generate';
  }

  _isCurrentCinemaProjectUrl(url) {
    const value = String(url || '');
    if (!value.includes('/generate') && !value.includes('/cinema-studio')) return false;
    if (!this._projectId) return true;
    try {
      const parsed = new URL(value);
      return (parsed.pathname.includes('/generate') || parsed.pathname.includes('/cinema-studio'))
        && (parsed.searchParams.get('projectId') === this._projectId ||
          parsed.searchParams.get('cinematic-project-id') === this._projectId);
    } catch (_) {
      return value.includes(this._projectId);
    }
  }

  async _navigateToCinemaProject() {
    const page = this.automation.page;
    const targetUrl = this._cinemaProjectUrl();
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);
    await this.automation.assertNoVerificationRequired?.('Cinema Studio project navigation');
    if (this._isCurrentCinemaProjectUrl(page.url())) return;

    this.log(`[CINEMA-VIDEO] Wrong URL after Cinema Studio navigation (${page.url()}); retrying direct project URL`, 'warn');
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);
    await this.automation.assertNoVerificationRequired?.('Cinema Studio project navigation retry');
  }

  async _assertCurrentCinemaProjectUrl(label = 'Cinema Studio navigation') {
    const page = this.automation.page;
    if (!page) throw new Error('Playwright page not ready');
    await this.automation.assertNoVerificationRequired?.(label);
    if (this._isCurrentCinemaProjectUrl(page.url())) return;

    if (this._projectId) {
      this.log(`[CINEMA-VIDEO] Wrong URL ${label}: ${page.url()} — retrying project ${this._projectId}`, 'warn');
      await this._navigateToCinemaProject();
      if (this._isCurrentCinemaProjectUrl(page.url())) return;
    }

    throw new Error(`Wrong Cinema Studio project URL ${label}: ${page.url()}`);
  }

  async _focusPromptTextboxForTyping() {
    const page = this.automation.page;
    await this._dismissSeedanceAndAIDirectorOverlays('[CINEMA-VIDEO]');
    const target = await page.evaluate(() => {
      const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const inCinemaComposer = (el) => {
        let node = el;
        for (let depth = 0; node && depth < 10; depth++, node = node.parentElement) {
          const r = node.getBoundingClientRect();
          const text = clean(node.textContent);
          if (
            r.width > 300 && r.height > 80
            && r.y > window.innerHeight * 0.45
            && /Cinema Studio 3\.5/i.test(text)
            && !/Nano Banana/i.test(text)
          ) return true;
        }
        return false;
      };
      const boxes = [...document.querySelectorAll('[role="textbox"][contenteditable="true"], [role="textbox"], textarea')]
        .map(el => ({ el, r: el.getBoundingClientRect(), text: clean(el.innerText || el.textContent || el.value || '') }))
        .filter(({ el, r }) => (
          r.width > 100
          && r.height > 18
          && r.y > window.innerHeight * 0.45
          && r.y < window.innerHeight - 40
          && inCinemaComposer(el)
        ))
        .sort((a, b) => {
          const aEmpty = a.text.length === 0 ? 0 : 1;
          const bEmpty = b.text.length === 0 ? 0 : 1;
          if (aEmpty !== bEmpty) return aEmpty - bEmpty;
          return a.r.y - b.r.y;
        });
      const chosen = boxes[0];
      if (!chosen) {
        return {
          ok: false,
          reason: 'no visible Cinema Studio prompt textbox candidate',
          candidates: boxes.length,
          scrollY: window.scrollY,
        };
      }
      for (const el of document.querySelectorAll('[data-cinema-prompt-target]')) {
        el.removeAttribute('data-cinema-prompt-target');
      }
      chosen.el.setAttribute('data-cinema-prompt-target', 'typing');
      return {
        ok: true,
        x: Math.round(chosen.r.x + Math.min(120, chosen.r.width / 2)),
        y: Math.round(chosen.r.y + Math.min(24, chosen.r.height / 2)),
        rect: {
          x: Math.round(chosen.r.x),
          y: Math.round(chosen.r.y),
          w: Math.round(chosen.r.width),
          h: Math.round(chosen.r.height),
        },
        textLength: chosen.text.length,
        scrollY: window.scrollY,
      };
    });
    if (!target?.ok) {
      throw new Error(`Prompt textbox did not resolve for typing: ${JSON.stringify(target || {})}`);
    }

    await page.mouse.click(target.x, target.y);
    await page.waitForTimeout(250);

    const focused = await page.evaluate(() => {
      const targetEl = document.querySelector('[data-cinema-prompt-target="typing"]');
      const active = document.activeElement;
      const selection = window.getSelection?.();
      const selectedNode = selection?.anchorNode?.nodeType === Node.ELEMENT_NODE
        ? selection.anchorNode
        : selection?.anchorNode?.parentElement;
      const activeTextbox = active?.closest?.('[role="textbox"]') || null;
      const selectionTextbox = selectedNode?.closest?.('[role="textbox"]') || null;
      const ownsFocus = !!targetEl && (targetEl === activeTextbox || targetEl.contains(active) || targetEl === selectionTextbox || targetEl.contains(selectedNode));
      const r = targetEl?.getBoundingClientRect?.();
      return {
        ok: ownsFocus,
        activeTag: active?.tagName || '',
        activeRole: active?.getAttribute?.('role') || '',
        activeText: String(active?.innerText || active?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
        selectionRole: selectionTextbox?.getAttribute?.('role') || '',
        targetRect: r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null,
        scrollY: window.scrollY,
      };
    });
    if (!focused.ok) {
      throw new Error(`Prompt textbox did not receive focus: ${JSON.stringify(focused)}`);
    }
    this.log(`[PROMPT] Focused Cinema prompt textbox at ${JSON.stringify(target.rect)} (scrollY=${target.scrollY})`);
  }

  async _readCinemaPromptText() {
    const page = this.automation.page;
    if (!page || page.isClosed?.()) return '';
    return page.evaluate(() => {
      const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const inCinemaComposer = (el) => {
        let node = el;
        for (let depth = 0; node && depth < 10; depth++, node = node.parentElement) {
          const r = node.getBoundingClientRect();
          const text = clean(node.textContent);
          if (
            r.width > 300 && r.height > 80
            && r.y > window.innerHeight * 0.40
            && /Cinema Studio 3\.5/i.test(text)
            && !/Nano Banana/i.test(text)
          ) return true;
        }
        return false;
      };
      const marked = document.querySelector('[data-cinema-prompt-target="typing"]');
      if (marked && inCinemaComposer(marked)) {
        return marked.innerText || marked.textContent || marked.value || '';
      }
      const boxes = [...document.querySelectorAll('[role="textbox"][contenteditable="true"], [role="textbox"], textarea')]
        .map(el => ({ el, r: el.getBoundingClientRect(), text: el.innerText || el.textContent || el.value || '' }))
        .filter(({ el, r }) => (
          r.width > 100
          && r.height > 18
          && r.y > window.innerHeight * 0.40
          && inCinemaComposer(el)
        ))
        .sort((a, b) => {
          const aLen = clean(a.text).length;
          const bLen = clean(b.text).length;
          if (aLen !== bLen) return bLen - aLen;
          return a.r.y - b.r.y;
        });
      return boxes[0]?.text || '';
    }).catch(() => '');
  }

  async _assertCinemaPromptComplete(expectedPrompt) {
    const expected = String(expectedPrompt || '');
    const actualRaw = await this._readCinemaPromptText();
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const actual = normalize(actualRaw);
    const expectedNormalized = normalize(expected);
    const sentinel = 'NO SUBTITLES.';
    const issues = [];
    if (!actual.endsWith(sentinel)) {
      issues.push(`missing final sentinel "${sentinel}"`);
    }
    if (expectedNormalized.length > 100 && actual.length < Math.floor(expectedNormalized.length * 0.75)) {
      issues.push(`prompt length too short (${actual.length}/${expectedNormalized.length} chars)`);
    }
    if (issues.length > 0) {
      throw new Error(`[PRE-GEN] Prompt typing incomplete before usage baseline: ${issues.join('; ')}; tail=${JSON.stringify(actual.slice(-180))}`);
    }
    this.log(`[PROMPT] Prompt completion confirmed before usage baseline (${actual.length}/${expectedNormalized.length} chars, sentinel present)`);
  }

  async _readGenerateButtonWithCreditCost({ timeoutMs = 20000, expectedMaxCost = 70 } = {}) {
    const page = this.automation.page;
    const startedAt = Date.now();
    let lastButtonText = '';
    let lastParsedCost = null;

    while (Date.now() - startedAt < timeoutMs) {
      await this._dismissLowCreditToast('Generate credit read');
      const genBtnBox = await page.evaluate(() => {
        for (const b of document.querySelectorAll('button[type="submit"], button')) {
          const text = b.textContent?.trim() || '';
          if (/generate/i.test(text) && b.getBoundingClientRect().width > 0) {
            const r = b.getBoundingClientRect();
            const textParts = [];
            const walker = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
            let node;
            while ((node = walker.nextNode())) {
              const part = (node.nodeValue || '').replace(/\s+/g, ' ').trim();
              if (part) textParts.push(part);
            }
            return { x: r.x + r.width / 2, y: r.y + r.height / 2, text, textParts };
          }
        }
        return null;
      });

      if (!genBtnBox) {
        lastButtonText = 'not found';
      } else {
        lastButtonText = genBtnBox.text || '';
        lastParsedCost = this._parseGenerateCreditCost(genBtnBox);
        if (Number.isFinite(lastParsedCost)) {
          if (lastParsedCost > expectedMaxCost) {
            throw new Error(`[PRE-GEN] Credit cost inflated: ${lastParsedCost} credits for Cinema Studio 3.5 (expected <= ${expectedMaxCost})`);
          }
          if (Date.now() - startedAt > 1000) {
            this.log(`[CINEMA-SAFETY] Generate button credit cost recovered after UI settle: ${lastParsedCost}`);
          }
          return { genBtnBox, creditCost: lastParsedCost };
        }
      }

      await this._waitForCinemaEndpointQuietPeriod({ quietMs: 3000, timeoutMs: 3500, label: 'Generate credit read' });
      await page.waitForTimeout(500);
    }

    throw new Error(`[PRE-GEN] Generate button has no credit cost after setup (last text=${JSON.stringify(lastButtonText)}, parsed=${lastParsedCost})`);
  }

  async _dismissLowCreditToast(label = 'pre-Generate') {
    const page = this.automation.page;
    if (!page) return false;
    const result = await page.evaluate(() => {
      const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
      const isLowCreditText = text => /credits are running low/i.test(text) || /over\s+90%\s+already\s+used/i.test(text);

      const candidates = [...document.querySelectorAll('div, section, aside, [role="alert"], [role="status"]')]
        .map(el => {
          const r = el.getBoundingClientRect();
          const text = normalize(el.innerText || el.textContent || '');
          return { el, r, text };
        })
        .filter(item =>
          item.r.width > 120 &&
          item.r.height > 20 &&
          item.r.x > window.innerWidth * 0.45 &&
          item.r.y > window.innerHeight * 0.55 &&
          isLowCreditText(item.text)
        )
        .sort((a, b) => (a.r.width * a.r.height) - (b.r.width * b.r.height));

      if (candidates.length === 0) return { dismissed: false, reason: 'not-found' };

      let toast = null;
      let close = null;
      for (const candidate of candidates) {
        const buttons = [...candidate.el.querySelectorAll('button, [role="button"]')]
          .map(btn => {
            const r = btn.getBoundingClientRect();
            const text = normalize(btn.innerText || btn.textContent || btn.getAttribute('aria-label') || '');
            return { btn, r, text };
          })
          .filter(item => item.r.width > 0 && item.r.height > 0);

        const candidateClose = buttons
          .filter(item => !/upgrade/i.test(item.text))
          .sort((a, b) => {
            const aRight = a.r.x + a.r.width;
            const bRight = b.r.x + b.r.width;
            if (Math.abs(bRight - aRight) > 4) return bRight - aRight;
            return a.r.y - b.r.y;
          })[0];
        if (candidateClose) {
          toast = candidate;
          close = candidateClose;
          break;
        }
      }

      if (!toast || !close) return { dismissed: false, reason: 'close-not-found', text: candidates[0].text.slice(0, 120) };
      close.btn.click();
      return {
        dismissed: true,
        text: toast.text.slice(0, 120),
        closeText: close.text,
        box: { x: toast.r.x, y: toast.r.y, w: toast.r.width, h: toast.r.height },
      };
    }).catch(err => ({ dismissed: false, reason: err.message }));

    if (result?.dismissed) {
      this.log(`[CINEMA-SAFETY] Dismissed low-credit toast before ${label}: ${JSON.stringify(result.box)}`);
      await page.waitForTimeout(300);
      return true;
    }
    return false;
  }

  async _assertGenerateClickPointClear(genBtnBox) {
    const page = this.automation.page;
    if (!page || !genBtnBox) throw new Error('[PRE-GEN] Generate button box unavailable');
    await this._dismissSeedanceAndAIDirectorOverlays('[CINEMA-VIDEO]');
    const point = { x: Math.round(genBtnBox.x), y: Math.round(genBtnBox.y) };
    const info = await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      const text = String(el?.innerText || el?.textContent || el?.getAttribute?.('aria-label') || '').replace(/\s+/g, ' ').trim();
      const buttonsAtPoint = [...document.querySelectorAll('button[type="submit"], button')]
        .filter(btn => {
          const r = btn.getBoundingClientRect();
          return /generate/i.test(btn.textContent || '') &&
            r.width > 0 &&
            r.height > 0 &&
            x >= r.left &&
            x <= r.right &&
            y >= r.top &&
            y <= r.bottom;
        })
        .map(btn => String(btn.innerText || btn.textContent || btn.getAttribute?.('aria-label') || '').replace(/\s+/g, ' ').trim());
      const lowCreditAtPoint = [...document.querySelectorAll('div, section, aside, [role="alert"], [role="status"]')]
        .some(node => {
          const r = node.getBoundingClientRect();
          if (!(r.width > 120 && r.height > 20 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom)) return false;
          const nodeText = String(node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
          return /credits are running low|over\s+90%\s+already\s+used/i.test(nodeText);
        });
      return {
        tag: el?.tagName || '',
        text: text.slice(0, 160),
        buttonText: buttonsAtPoint[0]?.slice(0, 160) || '',
        ok: buttonsAtPoint.length > 0,
        blockedByLowCredit: lowCreditAtPoint || /credits are running low|over\s+90%\s+already\s+used|upgrade/i.test(text),
      };
    }, point);

    if (!info.ok || info.blockedByLowCredit) {
      throw new Error(`[PRE-GEN] Generate click point occluded before intentional click: ${JSON.stringify(info)}`);
    }
    return true;
  }

  async _ensureCinemaStudio35VideoActive(aspectRatio = '16:9') {
    const page = this.automation.page;
    if (!page) throw new Error('Playwright page not ready');
    const targetAspect = aspectRatio === '9:16' ? '9:16' : '16:9';
    this._targetAspect = targetAspect;

    if (this._projectId && !this._isCurrentCinemaProjectUrl(page.url())) {
      this.log(`Navigating to Cinema Studio project ${this._projectId}...`);
      await this._navigateToCinemaProject();
    } else if (!page.url().includes('/generate') && !page.url().includes('/cinema-studio')) {
      this.log('Navigating to Cinema Studio...');
      await page.goto('https://higgsfield.ai/generate', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await this.automation.assertNoVerificationRequired?.('Cinema Studio navigation');
    }
    await this._dismissAdsWithPatience('[CINEMA-VIDEO]');
    await page.waitForTimeout(2500);
    await this.automation.assertNoVerificationRequired?.('Cinema Studio setup');
    await this._assertCurrentCinemaProjectUrl('after Cinema Studio navigation');

    await this._ensureVideoMode();
    await this._selectCinemaStudio35Model();
    await this._dumpCinemaToolbarDiagnostics('before setup controls');
    await this._ensureGenreGeneral();
    await this._ensureStyleAuto();
    await this._ensureCameraAuto();
    await this._setDuration15s();
    await this._setResolution480p();
    await this._setAspectRatio(targetAspect);
    await this._ensureAudioOn();

    const expectedDuration = this._selectedDuration || '15s';
    const expectedResolution = this._selectedResolution || '480p';
    const ready = await page.evaluate(({ duration, resolution }) => {
      const text = document.body?.innerText || '';
      const toolbarText = (() => {
        for (const el of document.querySelectorAll('div, section, form')) {
          const r = el.getBoundingClientRect();
          const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
          if (r.width > 250 && r.height > 20 && r.y > window.innerHeight * 0.50 && /Cinema Studio 3\.5/i.test(t) && !/Nano Banana/i.test(t)) {
            return t;
          }
        }
        return '';
      })();
      const hasModel = /Cinema Studio 3\.5/i.test(text);
      const hasVideoGuns = toolbarText.includes(duration) && toolbarText.includes(resolution);
      const hasTopDefaults = /Genre:\s*General/i.test(text) && /Style:\s*Auto/i.test(text) && /Camera:\s*Auto/i.test(text);
      const hasGenerate = [...document.querySelectorAll('button')].some(b => /generate/i.test(b.textContent || '') && b.getBoundingClientRect().width > 0);
      return { ok: hasModel && hasVideoGuns && hasGenerate, hasModel, hasVideoGuns, hasTopDefaults, hasGenerate, toolbarText };
    }, { duration: expectedDuration, resolution: expectedResolution });
    if (!ready.ok) {
      await this._dumpCinemaToolbarDiagnostics('setup incomplete');
      throw new Error(`Cinema Studio 3.5 video setup incomplete: ${JSON.stringify(ready)}`);
    }
    if (!ready.hasTopDefaults) {
      this.log('[CINEMA-VIDEO] Optional top defaults not visible; continuing with current Cinema Studio defaults');
    }
    this.log(`Cinema Studio 3.5 video setup ready: ${expectedDuration}, ${expectedResolution}, ${targetAspect}, audio on`);
  }

  async _ensureVideoMode() {
    const page = this.automation.page;
    for (let attempt = 0; attempt < 4; attempt++) {
      const state = await page.evaluate(() => {
        const vh = window.innerHeight;
        const buttons = [...document.querySelectorAll('button, [role="tab"]')];
        const videoTabs = [];
        let hasVideoIndicators = false;
        for (const b of buttons) {
          const text = (b.textContent || '').trim();
          const r = b.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) continue;
          if (r.y > vh * 0.55 && text === 'Video') {
            videoTabs.push({
              x: r.x, y: r.y, w: r.width, h: r.height,
              selected: b.getAttribute('aria-selected') === 'true',
            });
          }
          if (r.y > vh * 0.60 && (/Cinema Studio 3\.5/i.test(text) || /^(5s|8s|10s|15s|480p|720p|1080p)$/.test(text))) {
            hasVideoIndicators = true;
          }
        }
        if (hasVideoIndicators) return { status: 'already-video' };
        videoTabs.sort((a, b) => a.x - b.x);
        const target = videoTabs[0];
        if (!target) return { status: 'no-video-tab' };
        return { status: 'click', x: Math.round(target.x + target.w / 2), y: Math.round(target.y + target.h / 2) };
      });
      if (state.status === 'already-video') return;
      if (state.status === 'click') {
        await page.mouse.click(state.x, state.y);
        await page.waitForTimeout(2500);
      } else {
        await page.waitForTimeout(1500);
      }
    }
    throw new Error('Video mode switch failed');
  }

  async _selectCinemaStudio35Model() {
    const page = this.automation.page;
    const modelBtn = await page.evaluate(() => {
      const vh = window.innerHeight;
      const names = /Cinema Studio|Kling|Seedance|Hunyuan|Veo|Grok|HappyHorse/i;
      const candidates = [];
      for (const b of document.querySelectorAll('button')) {
        const text = (b.textContent || '').trim();
        const r = b.getBoundingClientRect();
        if (r.width > 80 && r.height > 20 && r.y > vh * 0.60 && names.test(text)) {
          candidates.push({ x: r.x, y: r.y, w: r.width, h: r.height, text });
        }
      }
      candidates.sort((a, b) => a.x - b.x);
      const c = candidates[0];
      return c ? { x: Math.round(c.x + c.w / 2), y: Math.round(c.y + c.h / 2), text: c.text } : null;
    });
    if (!modelBtn) throw new Error('Cinema Studio model selector not found');
    if (/Cinema Studio 3\.5/i.test(modelBtn.text || '')) {
      this.log('[CINEMA-VIDEO] Cinema Studio 3.5 already selected');
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(500);
      return;
    }

    await page.mouse.click(modelBtn.x, modelBtn.y);
    await page.waitForTimeout(1500);

    const alreadySelected = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('button, [role="option"], [role="menuitem"], div')];
      return rows.some((el) => {
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!/^Cinema Studio 3\.5\b/i.test(text)) return false;
        const r = el.getBoundingClientRect();
        const visible = r.width > 0 && r.height > 0;
        const hasSelectedSignal =
          el.getAttribute('aria-selected') === 'true' ||
          el.getAttribute('data-state') === 'checked' ||
          /✓|check/i.test(text) ||
          !!el.querySelector('svg, [data-state="checked"], [aria-checked="true"]');
        return visible && hasSelectedSignal;
      });
    }).catch(() => false);
    if (alreadySelected) {
      this.log('[CINEMA-VIDEO] Cinema Studio 3.5 dropdown row already selected');
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(500);
      return;
    }

    const option = page.getByText('Cinema Studio 3.5', { exact: true }).first();
    if (await option.isVisible({ timeout: 5000 }).catch(() => false)) {
      await option.click({ timeout: 5000 }).catch(async () => {
        const box = await option.boundingBox().catch(() => null);
        if (!box) throw new Error('Cinema Studio 3.5 option not clickable');
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      });
      await page.waitForTimeout(2500);
      const selected = await page.evaluate(() => /Cinema Studio 3\.5/i.test(document.body?.innerText || '')).catch(() => false);
      if (selected) return;
    }
    throw new Error('Cinema Studio 3.5 model option not found');
  }

  async _openTopPill(label) {
    const page = this.automation.page;
    const trigger = await page.evaluate((pillLabel) => {
      const vh = window.innerHeight;
      const candidates = [];
      for (const el of document.querySelectorAll('button, [role="button"], div')) {
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0 || r.y > vh * 0.50) continue;
        if (!new RegExp(`^${pillLabel}\\s*:`, 'i').test(text)) continue;
        candidates.push({ x: r.x, y: r.y, w: r.width, h: r.height, text });
      }
      candidates.sort((a, b) => (a.y - b.y) || (a.x - b.x));
      const c = candidates[0];
      return c ? { x: Math.round(c.x + c.w / 2), y: Math.round(c.y + c.h / 2), left: c.x, top: c.y, right: c.x + c.w, bottom: c.y + c.h, text: c.text } : null;
    }, label);
    if (!trigger) throw new Error(`${label} control not found`);

    await page.mouse.click(trigger.x, trigger.y);
    await page.waitForTimeout(700);
    return trigger;
  }

  async _ensureGenreGeneral() {
    const page = this.automation.page;
    const trigger = await this._openTopPill('Genre').catch((err) => {
      this.log(`[CINEMA-VIDEO] Optional Genre control unavailable (${err.message}); continuing`);
      return null;
    });
    if (!trigger) return;
    const selected = await this._clickVisibleTextOption('General', trigger);
    if (!selected) {
      const alreadySet = await this._topPillHasValue('Genre', 'General');
      await page.keyboard.press('Escape').catch(() => {});
      if (!alreadySet) throw new Error('Genre option General not found');
    }

    const verified = await this._topPillHasValue('Genre', 'General');
    if (!verified) throw new Error('Genre did not settle to General');
  }

  async _ensureStyleAuto() {
    const page = this.automation.page;
    const trigger = await this._openTopPill('Style').catch((err) => {
      this.log(`[CINEMA-VIDEO] Optional Style control unavailable (${err.message}); continuing`);
      return null;
    });
    if (!trigger) return;
    await page.waitForTimeout(500);

    const state = await page.evaluate(() => {
      const text = document.body?.innerText || '';
      const manualOff = /Manual Style[^\n\r]{0,12}Off/i.test(text);
      const hasPanel = /Style Settings/i.test(text);
      const autoCount = (text.match(/\bAuto\b/g) || []).length;
      return { ok: hasPanel && manualOff && autoCount >= 4, hasPanel, manualOff, autoCount };
    });
    await page.keyboard.press('Escape').catch(() => {});
    if (!state.ok) throw new Error(`Style Auto state not confirmed: ${JSON.stringify(state)}`);

    const verified = await this._topPillHasValue('Style', 'Auto');
    if (!verified) throw new Error('Style did not settle to Auto');
  }

  async _ensureCameraAuto() {
    const page = this.automation.page;
    const trigger = await this._openTopPill('Camera').catch((err) => {
      this.log(`[CINEMA-VIDEO] Optional Camera control unavailable (${err.message}); continuing`);
      return null;
    });
    if (!trigger) return;
    await page.waitForTimeout(500);

    const state = await page.evaluate(() => {
      const text = document.body?.innerText || '';
      const hasPanel = /Camera Settings/i.test(text);
      const hasCameraAuto = /CAMERA[^\n\r]*(?:\n|\r\n?)\s*Auto/i.test(text) || /CAMERA[\s\S]{0,120}\bAuto\b/i.test(text);
      const hasLensAuto = /LENS[^\n\r]*(?:\n|\r\n?)\s*Auto/i.test(text) || /LENS[\s\S]{0,120}\bAuto\b/i.test(text);
      const hasApertureAuto = /APERTURE[^\n\r]*(?:\n|\r\n?)\s*Auto/i.test(text) || /APERTURE[\s\S]{0,120}\bAuto\b/i.test(text);
      return { ok: hasPanel && hasCameraAuto && hasLensAuto && hasApertureAuto, hasPanel, hasCameraAuto, hasLensAuto, hasApertureAuto };
    });
    await page.keyboard.press('Escape').catch(() => {});
    if (!state.ok) throw new Error(`Camera Auto state not confirmed: ${JSON.stringify(state)}`);

    const verified = await this._topPillHasValue('Camera', 'Auto');
    if (!verified) throw new Error('Camera did not settle to Auto');
  }

  async _setDuration15s() {
    const page = this.automation.page;
    const chip = await this._findBottomToolbarChip(/^\d+s$/i);
    if (!chip) throw new Error('Duration control not found');

    if (/^15s$/i.test(chip.text || '')) {
      this.log('[CINEMA-VIDEO] Duration already 15s');
      this._selectedDuration = '15s';
      return;
    }

    await page.mouse.click(chip.x, chip.y);
    await page.waitForTimeout(700);

    if (await this._clickVisibleTextOption('15s', chip)) {
      await page.waitForTimeout(900);
      if (await this._bottomToolbarHasValue('15s')) {
        this._selectedDuration = '15s';
        return;
      }
    }

    const slider = await page.evaluate(() => {
      const candidates = [...document.querySelectorAll('[role="slider"], input[type="range"]')];
      for (const el of candidates) {
        const label = el.getAttribute('aria-label') || el.getAttribute('name') || '';
        const groupLabel = el.closest('[aria-label]')?.getAttribute('aria-label') || '';
        const r = el.getBoundingClientRect();
        const min = el.getAttribute('aria-valuemin') || el.getAttribute('min') || '';
        const max = el.getAttribute('aria-valuemax') || el.getAttribute('max') || '';
        if (r.width > 0 && r.height > 0 && (/duration/i.test(`${label} ${groupLabel}`) || (min === '4' && max === '15'))) {
          let node = el;
          for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
            const nr = node.getBoundingClientRect();
            if (nr.width > 80 && nr.height >= 20 && nr.height <= 70) {
              return { x: nr.x, y: nr.y, w: nr.width, h: nr.height };
            }
          }
          return { x: r.x, y: r.y, w: r.width, h: r.height };
        }
      }
      return null;
    });
    if (!slider) {
      const currentDuration = await this._getBottomToolbarValue(/^\d+s$/i);
      await page.keyboard.press('Escape').catch(() => {});
      if (/^(4s|5s|6s|7s|8s|9s|10s|11s|12s|13s|14s|15s)$/i.test(currentDuration || '')) {
        this.log(`[CINEMA-VIDEO] Duration slider not found; keeping existing ${currentDuration}`);
        this._selectedDuration = currentDuration;
        return;
      }
      await this._dumpCinemaToolbarDiagnostics('duration control missing');
      throw new Error('Duration slider not found');
    }

    const y = Math.round(slider.y + slider.h / 2);
    await page.mouse.move(Math.round(slider.x + 4), y);
    await page.mouse.down();
    await page.mouse.move(Math.round(slider.x + slider.w - 4), y, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(900);
    await page.keyboard.press('Escape').catch(() => {});

    const verified = await this._bottomToolbarHasValue('15s');
    if (!verified) throw new Error('Duration did not settle to 15s');
    this._selectedDuration = '15s';
  }

  async _setResolution480p() {
    const page = this.automation.page;
    const chip = await this._findBottomToolbarChip(/^(480p|720p|1080p|4K)$/i);
    if (!chip) {
      await this._dumpCinemaToolbarDiagnostics('resolution control missing');
      throw new Error('Resolution control not found');
    }

    if (/^480p$/i.test(chip.text || '')) {
      this.log('[CINEMA-VIDEO] Resolution already 480p');
      this._selectedResolution = '480p';
      return;
    }

    await page.mouse.click(chip.x, chip.y);
    await page.waitForTimeout(700);
    if (!(await this._visibleTextExistsAwayFrom('480p', chip))) {
      await page.mouse.click(chip.x, chip.y);
      await page.waitForTimeout(900);
    }

    const selected = await this._clickVisibleTextOption('480p', chip);
    if (!selected) {
      const alreadySet = await this._bottomToolbarHasValue('480p');
      await page.keyboard.press('Escape').catch(() => {});
      if (!alreadySet) throw new Error('Resolution option 480p not found');
    }
    await page.waitForTimeout(800);
    const verified = await this._bottomToolbarHasValue('480p');
    if (!verified) throw new Error('Resolution did not settle to 480p');
    this._selectedResolution = '480p';
  }

  async _setAspectRatio(targetAspect) {
    await this._setToolbarChip(targetAspect, /^(Auto|1:1|3:4|9:16|4:3|16:9|21:9)$/i, [targetAspect]);
  }

  async _setToolbarChip(targetText, chipPattern, optionTexts) {
    const page = this.automation.page;
    const chip = await this._findBottomToolbarChip(chipPattern);
    if (!chip) throw new Error(`Toolbar chip for ${targetText} not found`);
    await page.mouse.click(chip.x, chip.y);
    await page.waitForTimeout(700);

    let selected = false;
    for (const text of optionTexts) {
      if (await this._clickVisibleTextOption(text, chip)) {
        await page.waitForTimeout(1000);
        selected = true;
        break;
      }
    }
    if (!selected) {
      const alreadySet = await this._bottomToolbarHasValue(targetText);
      await page.keyboard.press('Escape').catch(() => {});
      if (!alreadySet) throw new Error(`Toolbar option ${targetText} not found`);
    }

    const verified = await this._bottomToolbarHasValue(targetText);
    if (!verified) throw new Error(`Toolbar did not settle to ${targetText}`);
  }

  async _findBottomToolbarChip(chipPattern) {
    return this.automation.page.evaluate((patternSource) => {
      const pattern = new RegExp(patternSource, 'i');
      const vh = window.innerHeight;
      const vw = window.innerWidth;
      const activeCinemaRoot = () => {
        const roots = [];
        for (const el of document.querySelectorAll('div, section, form')) {
          const r = el.getBoundingClientRect();
          const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
          if (
            r.width > 300 && r.height > 20 && r.height < 170
            && r.y > vh * 0.55
            && /Cinema Studio 3\.5/i.test(text)
            && !/Nano Banana/i.test(text)
          ) {
            roots.push({ el, r, text });
          }
        }
        roots.sort((a, b) => (a.r.height - b.r.height) || (b.r.y - a.r.y));
        return roots[0]?.el || null;
      };
      const activeRoot = activeCinemaRoot();
      const inCinemaToolbar = (el) => {
        if (activeRoot && activeRoot.contains(el)) return true;
        let node = el;
        for (let depth = 0; node && depth < 8; depth++, node = node.parentElement) {
          const r = node.getBoundingClientRect();
          const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
          if (
            r.width > 250 && r.height > 20
            && r.y > vh * 0.50
            && /Cinema Studio 3\.5/i.test(text)
            && !/Nano Banana/i.test(text)
          ) return true;
        }
        return false;
      };
      const candidates = [];
      for (const el of document.querySelectorAll('button, [role="button"], [aria-haspopup], div')) {
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
        const r = el.getBoundingClientRect();
        if (
          r.width > 0 && r.height > 0
          && r.y > vh * 0.60
          && r.width < Math.min(360, vw * 0.35)
          && r.height < 90
          && pattern.test(text)
          && inCinemaToolbar(el)
        ) {
          const exact = pattern.test(text) && text.length <= 30;
          candidates.push({ x: r.x, y: r.y, w: r.width, h: r.height, text, exact, active: !!(activeRoot && activeRoot.contains(el)) });
        }
      }
      candidates.sort((a, b) => Number(b.active) - Number(a.active) || Number(b.exact) - Number(a.exact) || a.x - b.x);
      const c = candidates[0];
      return c ? { x: Math.round(c.x + c.w / 2), y: Math.round(c.y + c.h / 2), left: c.x, top: c.y, right: c.x + c.w, bottom: c.y + c.h, text: c.text } : null;
    }, chipPattern.source).catch(() => null);
  }

  async _dumpCinemaToolbarDiagnostics(label = 'toolbar') {
    const page = this.automation.page;
    const diag = await page.evaluate(() => {
      const vh = window.innerHeight;
      const vw = window.innerWidth;
      const items = [];
      for (const el of document.querySelectorAll('button, [role="button"], [aria-haspopup], input, [role="slider"], div')) {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0 || r.y < vh * 0.52) continue;
        const text = (el.textContent || el.getAttribute('aria-label') || el.getAttribute('name') || '').replace(/\s+/g, ' ').trim();
        if (!text && el.tagName !== 'INPUT') continue;
        if (r.width > vw * 0.85 || r.height > 220) continue;
        items.push({
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role') || '',
          aria: el.getAttribute('aria-label') || '',
          text: text.slice(0, 90),
          x: Math.round(r.x),
          y: Math.round(r.y),
          w: Math.round(r.width),
          h: Math.round(r.height),
        });
      }
      items.sort((a, b) => (a.y - b.y) || (a.x - b.x));
      const generate = [...document.querySelectorAll('button')]
        .map((b) => ({ text: (b.textContent || '').replace(/\s+/g, ' ').trim(), rect: b.getBoundingClientRect() }))
        .filter((b) => /generate/i.test(b.text) && b.rect.width > 0 && b.rect.height > 0)
        .map((b) => ({ text: b.text, x: Math.round(b.rect.x), y: Math.round(b.rect.y), w: Math.round(b.rect.width), h: Math.round(b.rect.height) }));
      return { url: location.href, viewport: { w: vw, h: vh }, items: items.slice(-80), generate };
    }).catch((err) => ({ error: err.message }));
    this.log(`[CINEMA-VIDEO] Toolbar diagnostics (${label}): ${JSON.stringify(diag)}`);
  }

  async _ensureAudioOn() {
    const page = this.automation.page;
    const state = await this._findBottomToolbarChip(/^(On|Off)$/i);
    if (!state) throw new Error('Audio On/Off control not found');
    if (/^Off$/i.test(state.text)) {
      await page.mouse.click(state.x, state.y);
      await page.waitForTimeout(700);
    }
    const on = await this._bottomToolbarHasValue('On');
    if (!on) throw new Error('Audio control did not settle to On');
  }

  async _clickVisibleTextOption(targetText, trigger) {
    const page = this.automation.page;
    const option = await page.evaluate(({ target, triggerPoint }) => {
      const candidates = [];
      for (const el of document.querySelectorAll('button, [role="option"], [role="menuitem"], div, span')) {
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
        const r = el.getBoundingClientRect();
        if (text !== target || r.width <= 0 || r.height <= 0) continue;
        if (
          typeof triggerPoint.left === 'number'
          && r.x < triggerPoint.right
          && r.x + r.width > triggerPoint.left
          && r.y < triggerPoint.bottom
          && r.y + r.height > triggerPoint.top
        ) continue;
        const cx = r.x + r.width / 2;
        const cy = r.y + r.height / 2;
        const distance = Math.hypot(cx - triggerPoint.x, cy - triggerPoint.y);
        if (distance < 12) continue;
        candidates.push({ x: r.x, y: r.y, w: r.width, h: r.height, distance });
      }
      candidates.sort((a, b) => a.distance - b.distance);
      const c = candidates[0];
      return c ? { x: Math.round(c.x + c.w / 2), y: Math.round(c.y + c.h / 2) } : null;
    }, { target: targetText, triggerPoint: trigger });
    if (!option) return false;
    await page.mouse.click(option.x, option.y);
    return true;
  }

  async _visibleTextExistsAwayFrom(targetText, trigger) {
    return this.automation.page.evaluate(({ target, triggerPoint }) => {
      return [...document.querySelectorAll('button, [role="option"], [role="menuitem"], div, span')].some(el => {
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
        const r = el.getBoundingClientRect();
        if (
          typeof triggerPoint.left === 'number'
          && r.x < triggerPoint.right
          && r.x + r.width > triggerPoint.left
          && r.y < triggerPoint.bottom
          && r.y + r.height > triggerPoint.top
        ) return false;
        return text === target && r.width > 0 && r.height > 0;
      });
    }, { target: targetText, triggerPoint: trigger }).catch(() => false);
  }

  async _topPillHasValue(label, targetText) {
    return this.automation.page.evaluate(({ pillLabel, target }) => {
      const vh = window.innerHeight;
      return [...document.querySelectorAll('button, [role="button"], div')].some(el => {
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.y < vh * 0.50
          && new RegExp(`^${pillLabel}\\s*:`, 'i').test(text)
          && text.toLowerCase().includes(target.toLowerCase());
      });
    }, { pillLabel: label, target: targetText }).catch(() => false);
  }

  async _bottomToolbarHasValue(targetText) {
    return this.automation.page.evaluate((target) => {
      const vh = window.innerHeight;
      const activeCinemaRoot = () => {
        const roots = [];
        for (const el of document.querySelectorAll('div, section, form')) {
          const r = el.getBoundingClientRect();
          const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
          if (
            r.width > 300 && r.height > 20 && r.height < 170
            && r.y > vh * 0.55
            && /Cinema Studio 3\.5/i.test(text)
            && !/Nano Banana/i.test(text)
          ) {
            roots.push({ el, r });
          }
        }
        roots.sort((a, b) => (a.r.height - b.r.height) || (b.r.y - a.r.y));
        return roots[0]?.el || null;
      };
      const activeRoot = activeCinemaRoot();
      const inCinemaToolbar = (el) => {
        if (activeRoot && activeRoot.contains(el)) return true;
        let node = el;
        for (let depth = 0; node && depth < 8; depth++, node = node.parentElement) {
          const r = node.getBoundingClientRect();
          const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
          if (
            r.width > 250 && r.height > 20
            && r.y > vh * 0.50
            && /Cinema Studio 3\.5/i.test(text)
            && !/Nano Banana/i.test(text)
          ) return true;
        }
        return false;
      };
      return [...document.querySelectorAll('button, [role="button"], div')].some(el => {
        const r = el.getBoundingClientRect();
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
        return r.y > vh * 0.60 && r.width > 0 && r.height > 0 && text === target && inCinemaToolbar(el);
      });
    }, targetText).catch(() => false);
  }

  async _getBottomToolbarValue(pattern) {
    return this.automation.page.evaluate((patternSource) => {
      const pattern = new RegExp(patternSource, 'i');
      const vh = window.innerHeight;
      const activeCinemaRoot = () => {
        const roots = [];
        for (const el of document.querySelectorAll('div, section, form')) {
          const r = el.getBoundingClientRect();
          const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
          if (
            r.width > 300 && r.height > 20 && r.height < 170
            && r.y > vh * 0.55
            && /Cinema Studio 3\.5/i.test(text)
            && !/Nano Banana/i.test(text)
          ) {
            roots.push({ el, r });
          }
        }
        roots.sort((a, b) => (a.r.height - b.r.height) || (b.r.y - a.r.y));
        return roots[0]?.el || null;
      };
      const activeRoot = activeCinemaRoot();
      const inCinemaToolbar = (el) => {
        if (activeRoot && activeRoot.contains(el)) return true;
        let node = el;
        for (let depth = 0; node && depth < 8; depth++, node = node.parentElement) {
          const r = node.getBoundingClientRect();
          const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
          if (
            r.width > 250 && r.height > 20
            && r.y > vh * 0.50
            && /Cinema Studio 3\.5/i.test(text)
            && !/Nano Banana/i.test(text)
          ) return true;
        }
        return false;
      };
      const candidates = [];
      for (const el of document.querySelectorAll('button, [role="button"], div')) {
        const r = el.getBoundingClientRect();
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (r.y > vh * 0.60 && r.width > 0 && r.height > 0 && pattern.test(text) && inCinemaToolbar(el)) {
          candidates.push({ x: r.x, text, active: !!(activeRoot && activeRoot.contains(el)) });
        }
      }
      candidates.sort((a, b) => Number(b.active) - Number(a.active) || a.x - b.x);
      return candidates[0]?.text || null;
    }, pattern.source).catch(() => null);
  }

  async _attachStartFrameFromLocalUpload(localPath) {
    const page = this.automation.page;
    this.log(`Uploading start frame from local file: ${path.basename(localPath)}`);

    const beforeSrcs = await this._visiblePickerImageSrcs();
    await this._openSceneUploadPicker();
    await this._clickPickerTab('Uploads');
    const beforeAfterOpen = new Set([...(beforeSrcs || []), ...(await this._visiblePickerImageSrcs())]);

    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 20000 }),
      this._clickUploadMediaControl(),
    ]);
    await chooser.setFiles(localPath);

    const card = await this._waitForNewUploadCard(beforeAfterOpen, 180000);
    const status = await this._waitForSceneEligibility(card, 420000);
    if (status === 'not-eligible') {
      throw new CinemaEligibilityError(`Scene image is Not eligible: ${path.basename(localPath)}`, [{
        type: 'scene-image',
        name: path.basename(localPath),
        path: localPath,
        status: 'Not eligible',
      }]);
    }

    await this._selectEligibleSceneImageAndAttach(this._lastEligibleSceneUploadCard || card);
    const attached = await this._hasStartFrameAttached();
    if (!attached) {
      throw new Error('[PRE-GEN] Attached start frame thumbnail not visible in Cinema Studio composer');
    }
    this.log('Start frame composer thumbnail verified');
    this.log(`Start frame uploaded and eligible (${Math.round(card.waitMs / 1000)}s upload/eligibility window)`);
  }

  async _openSceneUploadPicker() {
    const page = this.automation.page;
    await this._dismissSeedanceAndAIDirectorOverlays('[CINEMA-VIDEO]');
    const pickerAlreadyOpen = async () => page.evaluate(() => {
      const body = document.body?.innerText || '';
      return /\bUploads\b/i.test(body) && /\bUpload media\b/i.test(body);
    }).catch(() => false);

    if (await pickerAlreadyOpen()) return;

    const referencesPlusTarget = await this._findReferencesPlusControl();
    if (referencesPlusTarget) {
      this.log(`[CINEMA-VIDEO] Opening scene upload picker via References + control: ${JSON.stringify(referencesPlusTarget)}`);
      await page.mouse.click(referencesPlusTarget.x, referencesPlusTarget.y);
      await page.waitForTimeout(1500);
      if (await pickerAlreadyOpen()) return;
      throw new Error(`Scene upload picker did not open after clicking References +: ${JSON.stringify(referencesPlusTarget)}`);
    }

    const startFrameTarget = await this._findOptionalStartFrameControl();
    if (startFrameTarget) {
      this.log(`[CINEMA-VIDEO] Opening scene upload picker via Optional Start Frame control: ${JSON.stringify(startFrameTarget)}`);
      await page.mouse.click(startFrameTarget.x, startFrameTarget.y);
      await page.waitForTimeout(1500);
      if (await pickerAlreadyOpen()) return;
      throw new Error(`Scene upload picker did not open after clicking Optional Start Frame: ${JSON.stringify(startFrameTarget)}`);
    }

    const explicitTarget = await this._findAddReferenceMediaControl();
    if (explicitTarget) {
      this.log(`[CINEMA-VIDEO] Opening scene upload picker via Add reference media control: ${JSON.stringify(explicitTarget)}`);
      await page.mouse.click(explicitTarget.x, explicitTarget.y);
      await page.waitForTimeout(1500);
      if (await pickerAlreadyOpen()) return;
      throw new Error(`Scene upload picker did not open after clicking Add reference media: ${JSON.stringify(explicitTarget)}`);
    }

    const hoverTarget = await this._findAddReferenceMediaControlByTooltip();
    if (hoverTarget) {
      this.log(`[CINEMA-VIDEO] Opening scene upload picker via Add reference media tooltip control: ${JSON.stringify(hoverTarget)}`);
      await page.mouse.click(hoverTarget.x, hoverTarget.y);
      await page.waitForTimeout(1500);
      if (await pickerAlreadyOpen()) return;
      throw new Error(`Scene upload picker did not open after clicking tooltip-confirmed Add reference media: ${JSON.stringify(hoverTarget)}`);
    }

    const promptLeftTargets = await this._findPromptLeftReferenceMediaControls();
    for (const target of promptLeftTargets) {
      this.log(`[CINEMA-VIDEO] Opening scene upload picker via prompt-left media control: ${JSON.stringify(target)}`);
      await page.mouse.click(target.x, target.y);
      await page.waitForTimeout(1500);
      if (await pickerAlreadyOpen()) return;
    }

    const diagnostics = await this._diagnoseReferenceMediaControls();
    throw new Error(`Add reference media control not found; refusing unsafe scene upload click: ${JSON.stringify(diagnostics)}`);
  }

  async _findReferencesPlusControl() {
    const page = this.automation.page;
    const candidates = await page.evaluate(() => {
      const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width >= 24 && r.width <= 56 && r.height >= 24 && r.height <= 56
          && s.display !== 'none' && s.visibility !== 'hidden'
          && r.top > innerHeight * 0.55 && r.bottom < innerHeight
          && r.left > innerWidth * 0.05 && r.left < innerWidth * 0.60;
      };
      const inVideoComposer = (el) => {
        let node = el;
        for (let depth = 0; node && depth < 10; depth++, node = node.parentElement) {
          const r = node.getBoundingClientRect();
          const text = clean(node.textContent);
          if (
            r.width > 350 && r.height > 70
            && r.y > innerHeight * 0.45
            && /Cinema Studio 3\.5/i.test(text)
            && !/Nano Banana/i.test(text)
          ) return true;
        }
        return false;
      };
      const results = [];
      for (const el of document.querySelectorAll('button, [role="button"]')) {
        if (!visible(el) || !inVideoComposer(el)) continue;
        const r = el.getBoundingClientRect();
        const label = clean([el.getAttribute('aria-label'), el.getAttribute('title'), el.innerText || el.textContent].filter(Boolean).join(' '));
        if (/generate|decrement|increment|image|video/i.test(label)) continue;
        const text = clean(el.innerText || el.textContent || '');
        const hasPlus = text === '+' || !!el.querySelector('svg, path');
        if (!hasPlus && !/reference/i.test(label)) continue;
        results.push({
          x: Math.round(r.left + r.width / 2),
          y: Math.round(r.top + r.height / 2),
          w: Math.round(r.width),
          h: Math.round(r.height),
          label: label.slice(0, 80),
          text,
        });
      }
      results.sort((a, b) => a.x - b.x);
      return results.slice(0, 6);
    }).catch(() => []);

    for (const candidate of candidates) {
      await page.mouse.move(candidate.x, candidate.y);
      await page.waitForTimeout(350);
      const tooltip = await page.evaluate(() => {
        const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        return [...document.querySelectorAll('[role="tooltip"], [data-radix-popper-content-wrapper], div')]
          .map(el => {
            const r = el.getBoundingClientRect();
            return { text: clean(el.innerText || el.textContent || ''), w: r.width, h: r.height, y: r.y };
          })
          .filter(item => item.w > 20 && item.h > 10 && item.y >= 0 && /\bReferences?\b/i.test(item.text))
          .map(item => item.text)
          .sort((a, b) => a.length - b.length)[0] || '';
      }).catch(() => '');
      if (tooltip || candidate.text === '+') return { ...candidate, tooltip };
    }
    return candidates[0] || null;
  }

  async _findOptionalStartFrameControl() {
    const page = this.automation.page;
    return page.evaluate(() => {
      const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const visibleRect = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        if (r.width < 40 || r.height < 40 || s.display === 'none' || s.visibility === 'hidden') return null;
        if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return null;
        return r;
      };

      const matches = [];
      for (const el of document.querySelectorAll('button, [role="button"], div')) {
        const r = visibleRect(el);
        if (!r || r.y < innerHeight * 0.45 || r.width > 140 || r.height > 140) continue;
        const label = clean([el.getAttribute('aria-label'), el.getAttribute('title'), el.innerText || el.textContent].filter(Boolean).join(' '));
        if (!/Optional\s*Start\s*Frame/i.test(label)) continue;
        if (/generate|general/i.test(label)) continue;
        matches.push({
          x: Math.round(r.left + r.width / 2),
          y: Math.round(r.top + r.height / 2),
          w: Math.round(r.width),
          h: Math.round(r.height),
          label: label.slice(0, 120),
          area: r.width * r.height,
        });
      }
      matches.sort((a, b) => a.area - b.area || b.y - a.y || a.x - b.x);
      return matches[0] || null;
    }).catch(() => null);
  }

  async _findAddReferenceMediaControl() {
    const page = this.automation.page;
    return page.evaluate(() => {
      const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const targetText = /\badd reference media\b/i;
      const visibleRect = (el) => {
        const r = el.getBoundingClientRect();
        if (r.width < 20 || r.height < 20) return null;
        if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return null;
        return r;
      };
      const inCinemaComposer = (el) => {
        let node = el;
        for (let depth = 0; node && depth < 10; depth++, node = node.parentElement) {
          const r = node.getBoundingClientRect();
          const text = clean(node.textContent);
          if (
            r.width > 300 && r.height > 80
            && r.y > innerHeight * 0.45
            && /Cinema Studio 3\.5/i.test(text)
            && !/Nano Banana/i.test(text)
          ) return true;
        }
        return false;
      };

      const matches = [];
      for (const el of document.querySelectorAll('button, [role="button"], [aria-label], [title]')) {
        const r = visibleRect(el);
        if (!r || !inCinemaComposer(el)) continue;
        const aria = clean(el.getAttribute('aria-label'));
        const title = clean(el.getAttribute('title'));
        const label = [aria, title].filter(Boolean).join(' ');
        if (!targetText.test(label)) continue;
        matches.push({
          x: Math.round(r.left + r.width / 2),
          y: Math.round(r.top + r.height / 2),
          w: Math.round(r.width),
          h: Math.round(r.height),
          aria,
          title,
        });
      }
      matches.sort((a, b) => b.y - a.y || a.x - b.x);
      return matches[0] || null;
    }).catch(() => null);
  }

  async _findAddReferenceMediaControlByTooltip() {
    const page = this.automation.page;
    const candidates = await page.evaluate(() => {
      const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const inCinemaComposer = (el) => {
        let node = el;
        for (let depth = 0; node && depth < 10; depth++, node = node.parentElement) {
          const r = node.getBoundingClientRect();
          const text = clean(node.textContent);
          if (
            r.width > 300 && r.height > 80
            && r.y > innerHeight * 0.45
            && /Cinema Studio 3\.5/i.test(text)
            && !/Nano Banana/i.test(text)
          ) return true;
        }
        return false;
      };
      const promptLike = [...document.querySelectorAll('[role="textbox"][contenteditable="true"], [role="textbox"], textarea, [contenteditable="true"]')]
        .map(el => ({ el, r: el.getBoundingClientRect(), text: clean(el.textContent || el.getAttribute('placeholder')) }))
        .filter(({ el, r }) => r.width > 100 && r.height > 20 && r.y > innerHeight * 0.45 && inCinemaComposer(el))
        .sort((a, b) => b.r.y - a.r.y)[0];
      if (!promptLike) return [];

      const tb = promptLike.r;
      const tbCenterY = tb.top + tb.height / 2;
      const results = [];
      for (const el of document.querySelectorAll('button, [role="button"]')) {
        const r = el.getBoundingClientRect();
        const centerY = r.top + r.height / 2;
        const label = clean([el.getAttribute('aria-label'), el.getAttribute('title'), el.textContent].filter(Boolean).join(' '));
        if (r.width < 25 || r.width > 90 || r.height < 25 || r.height > 90) continue;
        if (r.left < tb.left - 180 || r.right > tb.left + 12) continue;
        if (Math.abs(centerY - tbCenterY) > 95) continue;
        if (/copy prompt|delete|generate|decrement|increment|video|image/i.test(label)) continue;
        results.push({
          x: Math.round(r.left + r.width / 2),
          y: Math.round(r.top + r.height / 2),
          w: Math.round(r.width),
          h: Math.round(r.height),
          label: label.slice(0, 80),
        });
      }
      results.sort((a, b) => b.y - a.y || b.x - a.x);
      return results.slice(0, 6);
    }).catch(() => []);

    for (const candidate of candidates) {
      await page.mouse.move(candidate.x, candidate.y);
      await page.waitForTimeout(450);
      const tooltip = await page.evaluate(() => {
        const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        return [...document.querySelectorAll('[role="tooltip"], [data-radix-popper-content-wrapper], div')]
          .map(el => {
            const r = el.getBoundingClientRect();
            return { text: clean(el.textContent), w: r.width, h: r.height, y: r.y };
          })
          .filter(item => item.w > 20 && item.h > 10 && item.y >= 0 && /\badd reference media\b/i.test(item.text))
          .map(item => item.text)
          .sort((a, b) => a.length - b.length)[0] || '';
      }).catch(() => '');
      if (tooltip) return { ...candidate, tooltip };
    }
    return null;
  }

  async _findPromptLeftReferenceMediaControls() {
    const page = this.automation.page;
    return page.evaluate(() => {
      const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const inCinemaComposer = (el) => {
        let node = el;
        for (let depth = 0; node && depth < 10; depth++, node = node.parentElement) {
          const r = node.getBoundingClientRect();
          const text = clean(node.textContent);
          if (
            r.width > 300 && r.height > 80
            && r.y > innerHeight * 0.45
            && /Cinema Studio 3\.5/i.test(text)
            && !/Nano Banana/i.test(text)
          ) return true;
        }
        return false;
      };
      const promptBoxes = [...document.querySelectorAll('[role="textbox"][contenteditable="true"], [role="textbox"], textarea, [contenteditable="true"]')]
        .map(el => ({ el, r: el.getBoundingClientRect(), text: clean(el.textContent || el.getAttribute('placeholder')) }))
        .filter(({ el, r }) => r.width > 100 && r.height > 18 && r.y > innerHeight * 0.45 && inCinemaComposer(el))
        .sort((a, b) => {
          const aScene = /describe your scene/i.test(a.text) ? 1 : 0;
          const bScene = /describe your scene/i.test(b.text) ? 1 : 0;
          if (aScene !== bScene) return bScene - aScene;
          return a.r.y - b.r.y;
        });
      const tb = promptBoxes[0]?.r;
      if (!tb) return [];

      const textboxCenterY = tb.top + tb.height / 2;
      const targets = [];
      for (const el of document.querySelectorAll('button, [role="button"], div')) {
        const r = el.getBoundingClientRect();
        const label = clean([el.getAttribute('aria-label'), el.getAttribute('title'), el.textContent].filter(Boolean).join(' '));
        if (/copy prompt|delete|generate|decrement|increment|video|image|ai director/i.test(label)) continue;
        if (r.width < 28 || r.width > 90 || r.height < 28 || r.height > 90) continue;
        if (r.left < tb.left - 88 || r.right > tb.left - 4) continue;
        if (Math.abs((r.top + r.height / 2) - textboxCenterY) > 80 && Math.abs(r.top - tb.bottom) > 60) continue;
        targets.push({
          x: Math.round(r.left + r.width / 2),
          y: Math.round(r.top + r.height / 2),
          w: Math.round(r.width),
          h: Math.round(r.height),
          label,
          prompt: clean(promptBoxes[0].text).slice(0, 80),
        });
      }
      targets.sort((a, b) => (b.w * b.h) - (a.w * a.h));
      return targets.slice(0, 3);
    }).catch(() => []);
  }

  async _diagnoseReferenceMediaControls() {
    const page = this.automation.page;
    return page.evaluate(() => {
      const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const items = [];
      for (const el of document.querySelectorAll('button, [role="button"], [aria-label], [title]')) {
        const r = el.getBoundingClientRect();
        if (r.width < 20 || r.height < 20 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
        const label = clean([el.getAttribute('aria-label'), el.getAttribute('title'), el.textContent].filter(Boolean).join(' '));
        if (r.y < innerHeight * 0.45 && !/reference|upload|media/i.test(label)) continue;
        items.push({
          x: Math.round(r.left),
          y: Math.round(r.top),
          w: Math.round(r.width),
          h: Math.round(r.height),
          label: label.slice(0, 100),
        });
      }
      items.sort((a, b) => b.y - a.y || a.x - b.x);
      return {
        viewport: { w: innerWidth, h: innerHeight },
        bottomControls: items.slice(0, 30),
        bodySnippet: clean(document.body?.innerText).slice(0, 800),
      };
    }).catch(error => ({ error: error.message }));
  }

  async _clickPickerTab(tabName) {
    const page = this.automation.page;
    const tab = page.getByText(tabName, { exact: true }).first();
    if (await tab.isVisible({ timeout: 5000 }).catch(() => false)) {
      await tab.click({ timeout: 3000 });
      await page.waitForTimeout(1000);
      return;
    }
    throw new Error(`${tabName} tab not found in picker`);
  }

  async _clickUploadMediaControl() {
    const page = this.automation.page;
    const plusTarget = await page.evaluate(() => {
      const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'
          && r.top < innerHeight && r.left < innerWidth && r.bottom > 0 && r.right > 0;
      };
      const uploadCards = [...document.querySelectorAll('button, [role="button"], div, label')]
        .filter(visible)
        .map(el => ({ el, r: el.getBoundingClientRect(), text: clean(el.innerText || el.textContent || '') }))
        .filter(o => /Upload media/i.test(o.text) && o.r.width > 120 && o.r.height > 80)
        .sort((a, b) => (a.r.y - b.r.y) || (a.r.x - b.r.x));

      for (const card of uploadCards) {
        const controls = [...card.el.querySelectorAll('button, [role="button"], div, span')]
          .filter(visible)
          .map(el => ({ el, r: el.getBoundingClientRect(), text: clean(el.innerText || el.textContent || ''), aria: clean(el.getAttribute('aria-label') || '') }))
          .filter(o => {
            const cx = o.r.x + o.r.width / 2;
            const cy = o.r.y + o.r.height / 2;
            return cx >= card.r.left && cx <= card.r.right && cy >= card.r.top && cy <= card.r.bottom
              && o.r.width >= 24 && o.r.width <= 72 && o.r.height >= 24 && o.r.height <= 72
              && (o.text === '+' || /upload|add/i.test(o.aria) || !!o.el.querySelector('svg, path'));
          })
          .sort((a, b) => {
            const ay = a.r.y + a.r.height / 2;
            const by = b.r.y + b.r.height / 2;
            const targetY = card.r.y + card.r.height * 0.35;
            return Math.abs(ay - targetY) - Math.abs(by - targetY);
          });
        const target = controls[0];
        const r = target?.r || card.r;
        return {
          x: Math.round(r.x + r.width / 2),
          y: Math.round(r.y + r.height / 2),
          text: target ? (target.text || target.aria || 'inner-plus') : card.text,
          card: { x: Math.round(card.r.x), y: Math.round(card.r.y), w: Math.round(card.r.width), h: Math.round(card.r.height) },
        };
      }
      return null;
    }).catch(() => null);
    if (plusTarget) {
      this.log(`[CINEMA-VIDEO] Clicking Upload media plus control: ${JSON.stringify(plusTarget)}`);
      await page.mouse.click(plusTarget.x, plusTarget.y);
      return;
    }

    const upload = await page.evaluate(() => {
      const candidates = [];
      for (const el of document.querySelectorAll('button, div, label')) {
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
        const r = el.getBoundingClientRect();
        if (
          r.width > 120 && r.width < 280
          && r.height > 80 && r.height < 150
          && /^Upload media\b/i.test(text)
        ) {
          candidates.push({ x: r.x, y: r.y, w: r.width, h: r.height, text });
        }
      }
      candidates.sort((a, b) => (a.y - b.y) || (a.x - b.x));
      const c = candidates[0];
      return c ? { x: Math.round(c.x + c.w / 2), y: Math.round(c.y + c.h / 2), text: c.text } : null;
    });
    if (!upload) throw new Error('Upload media control not found');
    await page.mouse.click(upload.x, upload.y);
  }

  async _visiblePickerImageSrcs() {
    const page = this.automation.page;
    return page.evaluate(() => {
      return [...document.querySelectorAll('img')].filter(img => {
        const r = img.getBoundingClientRect();
        return r.width > 50 && r.height > 50 && r.y > 50 && r.y < window.innerHeight - 40;
      }).map(img => img.currentSrc || img.src).filter(Boolean);
    }).catch(() => []);
  }

  async _waitForNewUploadCard(beforeSrcs, timeoutMs) {
    const page = this.automation.page;
    const before = new Set(beforeSrcs || []);
    const start = Date.now();
    let deadline = start + timeoutMs;
    const maxDeadline = start + Math.max(timeoutMs, 420000);
    let extended = false;
    let fallbackCard = null;
    let lastPendingLogAt = 0;
    while (Date.now() < deadline) {
      const candidates = await page.evaluate((beforeList) => {
        const beforeSet = new Set(beforeList);
        const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const makeCard = (img, cardEl) => {
          const cr = cardEl.getBoundingClientRect();
          const ir = img.getBoundingClientRect();
          const text = clean(cardEl.innerText || cardEl.textContent || '');
          const checkEl = [...cardEl.querySelectorAll('button, [role="button"], div, span')]
            .map(el => ({ el, r: el.getBoundingClientRect(), text: clean(el.innerText || el.textContent || '') }))
            .filter(({ r, text }) => r.width > 20 && r.height > 12 && /check eligibility/i.test(text))
            .sort((a, b) => (b.r.width * b.r.height) - (a.r.width * a.r.height))[0];
          const target = checkEl?.r || cr;
          return {
            src: img.currentSrc || img.src || '',
            text,
            x: Math.round(cr.x + cr.width / 2),
            y: Math.round(cr.y + cr.height / 2),
            imageX: Math.round(ir.x + ir.width / 2),
            imageY: Math.round(ir.y + ir.height / 2),
            checkX: Math.round(target.x + target.width / 2),
            checkY: Math.round(target.y + target.height / 2),
            rect: { x: cr.x, y: cr.y, w: cr.width, h: cr.height },
            statusReady: /uploading|checking content|check eligibility|eligible|use/i.test(text) || !!(img.currentSrc || img.src),
            waitMs: 0,
          };
        };
        const statusCardForImage = (img) => {
          let fallback = img;
          for (let node = img; node; node = node.parentElement) {
            const r = node.getBoundingClientRect();
            const text = clean(node.innerText || node.textContent || '');
            if (r.width >= 70 && r.width <= 280 && r.height >= 70 && r.height <= 280) {
              fallback = node;
              if (/uploading|checking content|check eligibility|eligible|use/i.test(text)) return node;
            }
          }
          return fallback;
        };
        const cards = [];
        for (const img of document.querySelectorAll('img')) {
          const src = img.currentSrc || img.src;
          const r = img.getBoundingClientRect();
          if (!src || beforeSet.has(src) || r.width < 60 || r.height < 60 || r.y < 50 || r.y > innerHeight - 80) continue;
          const cardEl = statusCardForImage(img);
          cards.push(makeCard(img, cardEl));
        }
        cards.sort((a, b) => Number(b.statusReady) - Number(a.statusReady) || (a.rect.y - b.rect.y) || (a.rect.x - b.rect.x));
        return cards.slice(0, 6);
      }, [...before]);

      for (const candidate of candidates || []) {
        candidate.waitMs = Date.now() - start;
        fallbackCard = fallbackCard || candidate;
        const statusResult = await this._readSceneCardStatus(candidate, { hoverMs: 700 });
        if (statusResult.status !== 'pending') {
          const card = statusResult.card || candidate;
          card.waitMs = candidate.waitMs;
          return card;
        }
      }

      if (fallbackCard && Date.now() - lastPendingLogAt > 15000) {
        this.log(`Uploaded scene image card visible, waiting for eligibility control (${Math.round((Date.now() - start) / 1000)}s)`);
        lastPendingLogAt = Date.now();
      }
      if (!extended && fallbackCard && Date.now() > start + (timeoutMs * 0.90)) {
        deadline = Math.min(maxDeadline, deadline + 180000);
        extended = true;
        this.log(`Scene image upload card wait extended; Higgsfield eligibility UI is still settling (${Math.round((Date.now() - start) / 1000)}s)`);
      }
      await page.waitForTimeout(1500);
    }
    throw new Error('Uploaded scene image card not found after upload');
  }

  async _reacquireSceneUploadCard(card) {
    const page = this.automation.page;
    if (!card?.src && !card?.rect) return card;
    return page.evaluate((original) => {
      const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const makeCard = (img, cardEl) => {
        const cr = cardEl.getBoundingClientRect();
        const ir = img?.getBoundingClientRect?.();
        const text = clean(cardEl.innerText || cardEl.textContent || '');
        const checkEl = [...cardEl.querySelectorAll('button, [role="button"], div, span')]
          .map(el => ({ el, r: el.getBoundingClientRect(), text: clean(el.innerText || el.textContent || '') }))
          .filter(({ r, text }) => r.width > 20 && r.height > 12 && /check eligibility/i.test(text))
          .sort((a, b) => (b.r.width * b.r.height) - (a.r.width * a.r.height))[0];
        const target = checkEl?.r || cr;
        return {
          src: img.currentSrc || img.src || original.src || '',
          text,
          x: Math.round(cr.x + cr.width / 2),
          y: Math.round(cr.y + cr.height / 2),
          imageX: ir ? Math.round(ir.x + ir.width / 2) : Math.round(cr.x + cr.width / 2),
          imageY: ir ? Math.round(ir.y + ir.height / 2) : Math.round(cr.y + cr.height / 2),
          checkX: Math.round(target.x + target.width / 2),
          checkY: Math.round(target.y + target.height / 2),
          rect: { x: cr.x, y: cr.y, w: cr.width, h: cr.height },
        };
      };
      const statusCardForImage = (img) => {
        let fallback = img;
        for (let node = img; node; node = node.parentElement) {
          const r = node.getBoundingClientRect();
          const text = clean(node.innerText || node.textContent || '');
          if (r.width >= 70 && r.width <= 280 && r.height >= 70 && r.height <= 280) {
            fallback = node;
            if (/uploading|checking content|check eligibility|eligible|use/i.test(text)) return node;
          }
        }
        return fallback;
      };
      let img = null;
      if (original.rect) {
        const originalCx = original.x || (original.rect.x + original.rect.w / 2);
        const originalCy = original.y || (original.rect.y + original.rect.h / 2);
        const candidates = [...document.querySelectorAll('img')]
          .map(candidate => {
            const r = candidate.getBoundingClientRect();
            const cx = r.x + r.width / 2;
            const cy = r.y + r.height / 2;
            return {
              img: candidate,
              r,
              distance: Math.hypot(cx - originalCx, cy - originalCy),
            };
          })
          .filter(o => o.r.width > 50 && o.r.height > 50 && o.r.y > 50 && o.r.y < innerHeight - 20 && o.distance < 120)
          .sort((a, b) => a.distance - b.distance);
        img = candidates[0]?.img || null;
      }
      if (!img && original.src) {
        img = [...document.querySelectorAll('img')].find(candidate => {
          const current = candidate.currentSrc || candidate.src;
          const r = candidate.getBoundingClientRect();
          return current === original.src && r.width > 50 && r.height > 50 && r.y > 50 && r.y < innerHeight - 20;
        }) || null;
      }
      if (!img) return null;
      const cardEl = statusCardForImage(img);
      return makeCard(img, cardEl);
    }, card).catch(() => null);
  }

  _progressiveWaitMs(attempt, { min = 700, max = 5000, step = 450 } = {}) {
    return Math.min(max, min + Math.max(0, attempt) * step);
  }

  async _hoverPoint(point, settleMs = 500) {
    const page = this.automation.page;
    if (!point?.x || !point?.y) return;
    await page.mouse.move(point.x, point.y).catch(() => {});
    await page.waitForTimeout(Math.max(150, Math.floor(settleMs / 2)));
    await page.mouse.move(point.x + 2, point.y + 2).catch(() => {});
    await page.waitForTimeout(Math.max(150, Math.ceil(settleMs / 2)));
  }

  async _readSceneCardStatus(card, { hoverMs = 500 } = {}) {
    const page = this.automation.page;
    const current = await this._reacquireSceneUploadCard(card) || card;
    if (!current?.x || !current?.y) return { status: 'pending', card: current || card };

    await this._hoverPoint(current, hoverMs);

    const rawStatusResult = await page.evaluate(({ x, y, src }) => {
      const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const makeCard = (img, cardEl) => {
        const cr = cardEl.getBoundingClientRect();
        const ir = img?.getBoundingClientRect?.();
        const text = clean(cardEl.innerText || cardEl.textContent || '');
        const checkEl = [...cardEl.querySelectorAll('button, [role="button"], div, span')]
          .map(el => ({ el, r: el.getBoundingClientRect(), text: clean(el.innerText || el.textContent || '') }))
          .filter(({ r, text }) => r.width > 20 && r.height > 12 && /check eligibility/i.test(text))
          .sort((a, b) => (b.r.width * b.r.height) - (a.r.width * a.r.height))[0];
        const target = checkEl?.r || cr;
        return {
          src: img?.currentSrc || img?.src || src || '',
          text,
          x: Math.round(cr.x + cr.width / 2),
          y: Math.round(cr.y + cr.height / 2),
          imageX: ir ? Math.round(ir.x + ir.width / 2) : Math.round(cr.x + cr.width / 2),
          imageY: ir ? Math.round(ir.y + ir.height / 2) : Math.round(cr.y + cr.height / 2),
          checkX: Math.round(target.x + target.width / 2),
          checkY: Math.round(target.y + target.height / 2),
          rect: { x: cr.x, y: cr.y, w: cr.width, h: cr.height },
        };
      };
      const statusCardForImage = (img) => {
        let fallback = img;
        for (let node = img; node; node = node.parentElement) {
          const r = node.getBoundingClientRect();
          const text = clean(node.innerText || node.textContent || '');
          if (r.width >= 70 && r.width <= 280 && r.height >= 70 && r.height <= 280) {
            fallback = node;
            if (/uploading|checking content|check eligibility|eligible|use/i.test(text)) return node;
          }
        }
        return fallback;
      };
      let img = null;
      let cardEl = null;
      if (src) {
        img = [...document.querySelectorAll('img')].find(candidate => (candidate.currentSrc || candidate.src) === src);
        cardEl = img ? statusCardForImage(img) : null;
      }
      if (!cardEl) {
        const el = document.elementFromPoint(x, y);
        cardEl = el?.closest('figure, [role="button"], button, div') || el;
      }
      const text = clean(cardEl?.innerText || cardEl?.textContent || '');
      const card = cardEl ? makeCard(img, cardEl) : null;
      if (/not eligible/i.test(text)) return { status: 'not-eligible', card };
      if (/uploading/i.test(text)) return { status: 'uploading', card };
      if (/checking content|checking/i.test(text)) return { status: 'checking', card };
      if (/check eligibility/i.test(text)) return { status: 'check', card };
      if (/\beligible\b/i.test(text)) return { status: 'eligible', card };
      if (img || (src && !/upload media/i.test(text))) return { status: 'eligible', card };

      return { status: 'pending', card };
    }, current).catch(() => ({ status: 'pending', card: null }));

    const statusResult = typeof rawStatusResult === 'string'
      ? { status: rawStatusResult, card: null }
      : (rawStatusResult || { status: 'pending', card: null });
    return { status: statusResult.status || 'pending', card: statusResult.card || current };
  }

  async _clickSceneCheckEligibility(card) {
    const page = this.automation.page;
    const current = await this._reacquireSceneUploadCard(card) || card;
    if (!current?.x || !current?.y) return false;

    await this._hoverPoint(current, 700);
    const target = await page.evaluate(({ x, y, checkX, checkY }) => {
      const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const near = (r) => {
        const cx = r.x + r.width / 2;
        const cy = r.y + r.height / 2;
        return Math.abs(cx - x) < 220 && Math.abs(cy - y) < 180;
      };

      const candidates = [];
      for (const el of document.querySelectorAll('button, [role="button"], div, span')) {
        const r = el.getBoundingClientRect();
        if (r.width < 18 || r.height < 12 || r.bottom < 0 || r.top > innerHeight) continue;
        const text = clean(el.innerText || el.textContent || '');
        if (!/check eligibility/i.test(text)) continue;
        if (!near(r)) continue;
        candidates.push({
          x: Math.round(r.x + r.width / 2),
          y: Math.round(r.y + r.height / 2),
          text,
          area: r.width * r.height,
          dist: Math.hypot((r.x + r.width / 2) - x, (r.y + r.height / 2) - y),
        });
      }
      candidates.sort((a, b) => a.dist - b.dist || b.area - a.area);
      if (candidates[0]) return candidates[0];

      if (Number.isFinite(checkX) && Number.isFinite(checkY)) {
        return { x: checkX, y: checkY, text: 'card check target' };
      }
      return null;
    }, current).catch(() => null);

    if (!target?.x || !target?.y) return false;
    await page.mouse.click(target.x, target.y);
    this.log(`Scene image eligibility check clicked manually (${target.text || 'check target'})`);
    return true;
  }

  async _waitForSceneEligibility(card, timeoutMs) {
    const page = this.automation.page;
    const start = Date.now();
    let deadline = start + timeoutMs;
    const maxDeadline = start + Math.max(timeoutMs, 600000);
    let extended = false;
    let sawChecking = false;
    let lastStatus = null;
    let attempt = 0;
    let manualCheckClicked = false;
    while (Date.now() < deadline) {
      const waitMs = this._progressiveWaitMs(attempt, { min: 700, max: 4500, step: 350 });
      const result = await this._readSceneCardStatus(card, { hoverMs: waitMs });
      const status = result.status;
      if (status === 'eligible') this._lastEligibleSceneUploadCard = result.card || card;
      if (status !== lastStatus) {
        this.log(`Scene image eligibility status: ${status} (${Math.round((Date.now() - start) / 1000)}s)`);
        lastStatus = status;
      }
      if (status === 'checking') sawChecking = true;
      if (status === 'check' && !manualCheckClicked) {
        const clicked = await this._clickSceneCheckEligibility(result.card || card);
        manualCheckClicked = clicked;
        this.log(`Scene image eligibility check ${clicked ? 'clicked manually' : 'manual click target not confirmed'} - waiting for Higgsfield content review`);
        await page.waitForTimeout(2000);
        attempt++;
        continue;
      }
      if (status === 'eligible' || status === 'not-eligible') return status;
      if (!extended && Date.now() > start + (timeoutMs * 0.90)) {
        deadline = Math.min(maxDeadline, deadline + 180000);
        extended = true;
        this.log(`Scene image eligibility wait extended at 90%; current status is ${status}`);
      }
      await page.waitForTimeout(waitMs);
      attempt++;
    }
    throw new Error(`Scene image eligibility did not settle before timeout${sawChecking ? ' (saw Checking)' : ''}`);
  }

  async _hasStartFrameAttached() {
    return (await this._composerStartFrameAttachmentCount()) > 0;
  }

  async _waitForComposerReferenceAttachmentCount(expectedCount, timeoutMs = 45000) {
    const page = this.automation.page;
    const target = Math.max(1, Number(expectedCount) || 1);
    const start = Date.now();
    let attempt = 0;
    let lastCount = -1;
    while (Date.now() - start < timeoutMs) {
      const count = await this._composerStartFrameAttachmentCount();
      if (count >= target) {
        this.log(`[PROMPT] Composer reference tiles ready: ${count}/${target}`);
        return count;
      }
      if (count !== lastCount || attempt % 5 === 0) {
        this.log(`[PROMPT] Waiting for composer reference tiles: ${count}/${target}`);
        lastCount = count;
      }
      const waitMs = this._progressiveWaitMs(attempt, { min: 900, max: 4500, step: 350 });
      await page.waitForTimeout(waitMs);
      attempt++;
    }
    const finalCount = await this._composerStartFrameAttachmentCount();
    throw new Error(`[PRE-GEN] Composer reference tiles incomplete after prompt typing: ${finalCount}/${target}`);
  }

  async _composerStartFrameAttachmentCount() {
    const page = this.automation.page;
    return page.evaluate(() => {
      const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const inCinemaComposer = (el) => {
        let node = el;
        for (let depth = 0; node && depth < 10; depth++, node = node.parentElement) {
          const r = node.getBoundingClientRect();
          const text = clean(node.textContent);
          if (
            r.width > 300 && r.height > 80
            && r.y > window.innerHeight * 0.45
            && /Cinema Studio 3\.5/i.test(text)
            && !/Nano Banana/i.test(text)
          ) return true;
        }
        return false;
      };
      const textboxes = [...document.querySelectorAll('[role="textbox"][contenteditable="true"], [role="textbox"], textarea')]
        .map(el => ({ el, r: el.getBoundingClientRect() }))
        .filter(({ el, r }) => r.width > 100 && r.height > 20 && r.y > window.innerHeight * 0.45 && inCinemaComposer(el))
        .sort((a, b) => a.r.y - b.r.y);
      const tb = textboxes[0]?.el || null;
      if (!tb) return 0;
      const tbRect = tb.getBoundingClientRect();
      return [...document.querySelectorAll('img')].filter(img => {
        const r = img.getBoundingClientRect();
        const src = String(img.currentSrc || img.src || '');
        if (!/^(https?:|blob:|data:image\/)/i.test(src)) return false;
        const centerX = r.x + r.width / 2;
        const centerY = r.y + r.height / 2;
        const textboxCenterY = tbRect.y + tbRect.height / 2;
        return r.width > 25 && r.width < 180 && r.height > 25 && r.height < 180 &&
          centerX > tbRect.x - 80 && centerX < tbRect.x + tbRect.width + 80 &&
          centerY > tbRect.y - 170 && Math.abs(centerY - textboxCenterY) < 180;
      }).length;
    }).catch(() => 0);
  }

  async _clickPromptTextbox() {
    const page = this.automation.page;
    const textbox = await page.evaluate(() => {
      const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const inCinemaComposer = (el) => {
        let node = el;
        for (let depth = 0; node && depth < 10; depth++, node = node.parentElement) {
          const r = node.getBoundingClientRect();
          const text = clean(node.textContent);
          if (
            r.width > 300 && r.height > 80
            && r.y > window.innerHeight * 0.45
            && /Cinema Studio 3\.5/i.test(text)
            && !/Nano Banana/i.test(text)
          ) return true;
        }
        return false;
      };
      const boxes = [...document.querySelectorAll('[role="textbox"][contenteditable="true"], [role="textbox"], textarea')]
        .map(el => ({ el, r: el.getBoundingClientRect() }))
        .filter(({ el, r }) => r.width > 100 && r.height > 20 && r.y > window.innerHeight * 0.45 && inCinemaComposer(el))
        .sort((a, b) => a.r.y - b.r.y);
      const target = boxes[0];
      if (!target) return null;
      return {
        x: Math.round(target.r.x + Math.min(120, target.r.width / 2)),
        y: Math.round(target.r.y + Math.min(24, target.r.height / 2)),
      };
    });
    if (!textbox) throw new Error('Cinema Studio prompt textbox not found for start-frame attach');
    await page.mouse.click(textbox.x, textbox.y);
  }

  async _selectEligibleSceneImageAndAttach(card) {
    const page = this.automation.page;
    const beforeCount = await this._composerStartFrameAttachmentCount();
    let statusResult = await this._readSceneCardStatus(card, { hoverMs: 1500 });
    if (statusResult.status !== 'eligible') {
      throw new Error(`Cannot select scene image; card status is ${statusResult.status}`);
    }

    let current = statusResult.card || card;
    this.log('Scene image eligible; waiting for reference tile to settle before selecting');
    await page.waitForTimeout(5000);
    for (let attempt = 0; attempt < 5; attempt++) {
      statusResult = await this._readSceneCardStatus(current, { hoverMs: 1200 });
      current = statusResult.card || current;
      if (statusResult.status === 'eligible') break;
      if (statusResult.status === 'not-eligible') {
        throw new Error('Cannot select scene image; settled card became not-eligible');
      }
      await page.waitForTimeout(2000);
    }
    if (statusResult.status !== 'eligible') {
      throw new Error(`Cannot select scene image after settle wait; card status is ${statusResult.status}`);
    }

    const clickX = current.imageX || current.x;
    const clickY = current.imageY || current.y;
    this.log(`Selecting settled scene reference image at (${clickX}, ${clickY})`);
    await page.mouse.click(clickX, clickY);
    await page.waitForTimeout(3500);

    await this._clickPromptTextbox();
    await page.waitForTimeout(4000);

    const attached = await this._hasStartFrameAttached();
    const afterCount = await this._composerStartFrameAttachmentCount();
    if (!attached) {
      throw new Error(`Start frame thumbnail not detected after eligible image select (before=${beforeCount}, after=${afterCount})`);
    }
    if (afterCount <= beforeCount) {
      this.log(`Start frame thumbnail already present after eligible image select (before=${beforeCount}, after=${afterCount})`);
    }
  }

  async _ensureElementEligibility(validElements) {
    await this._dismissSeedanceAndAIDirectorOverlays('[CINEMA-VIDEO]');
    const names = [...new Set([...(validElements || [])]
      .filter(Boolean)
      .map(name => String(name).trim().replace(/^@/, ''))
      .filter(Boolean))];
    this._lastClipElementEligibility = { required: names, eligible: [] };
    if (names.length === 0) return;

    const failed = [];
    for (const name of names) {
      const cached = this._getCachedElementEligibility(name);
      if (cached === 'eligible') {
        this.log(`Element @${name} eligibility cache hit: eligible`);
        this._lastClipElementEligibility.eligible.push(name);
        continue;
      }
      if (cached === 'not-eligible') {
        this.log(`Element @${name} eligibility cache hit: not-eligible`);
        failed.push(this._buildElementEligibilityFailure(name, 'not-eligible'));
        continue;
      }

      const status = await this._checkOneElementEligibility(name);
      if (status === 'eligible') {
        this._lastClipElementEligibility.eligible.push(name);
      } else {
        failed.push(this._buildElementEligibilityFailure(name, status));
      }
    }
    if (failed.length > 0) {
      const notEligible = failed.filter(item => item.status === 'Not eligible').length;
      const unresolved = failed.length - notEligible;
      const parts = [];
      if (notEligible) parts.push(`${notEligible} not eligible`);
      if (unresolved) parts.push(`${unresolved} unresolved`);
      throw new CinemaEligibilityError(`${failed.length} Cinema Studio element eligibility issue(s): ${parts.join(', ')}`, failed);
    }
  }

  async _checkOneElementEligibility(name) {
    const page = this.automation.page;
    await this._closePickerAndReturnToComposer();
    await this._ensureElementsPickerOpen();
    const dismissedOverlay = await this._dismissSeedanceAndAIDirectorOverlays('[CINEMA-VIDEO]');
    if (dismissedOverlay) {
      this.log(`Closed blocking overlay before checking @${name}; reopening Elements picker if needed`);
      if (!(await this._isElementsPickerOpen())) {
        await this._ensureElementsPickerOpen();
      }
    }
    const card = await this._waitForElementCard(name, 60000);
    if (!card) {
      await this._closePickerAndReturnToComposer();
      return 'missing';
    }
    let status = await this._waitForElementEligibility(card, 60000);
    if (status === 'check') {
      let clicked = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        clicked = await this._clickElementCheckEligibility(card);
        if (clicked) {
          this.log(`Element ${card.name || `@${name}`} eligibility check confirmed on attempt ${attempt} - waiting for Higgsfield content review`);
          break;
        }
        this.log(`Element ${card.name || `@${name}`} eligibility check attempt ${attempt}/3 did not trigger content review`);
        await this._closePickerAndReturnToComposer().catch(() => {});
        await page.waitForTimeout(1500);
        await this._ensureElementsPickerOpen().catch(() => false);
      }
      if (!clicked) {
        await this._closePickerAndReturnToComposer();
        return 'check-click-failed';
      }
      await page.waitForTimeout(3500);
      status = await this._waitForElementEligibility(card, 420000, { returnOnCheck: false, useFallbackStatus: false });
    }
    if (status === 'eligible' || status === 'eligible-visual') {
      const proof = await this._snapshotElementCardProof(name).catch(() => ({}));
      const textProof = proof.text ? ` proof="${proof.text.slice(0, 180)}"` : '';
      this.log(`Element @${name} hover Use/badge proof persisted: eligible${textProof}`);
      this._rememberElementEligibility(name, 'eligible', proof);
      await this._closePickerAndReturnToComposer();
      return 'eligible';
    }
    if (status === 'not-eligible') {
      const proof = await this._snapshotElementCardProof(name).catch(() => ({}));
      const textProof = proof.text ? ` proof="${proof.text.slice(0, 180)}"` : '';
      this.log(`Element @${name} final eligibility persisted: ${status}${textProof}`);
      this._rememberElementEligibility(name, status, proof);
    }
    await this._closePickerAndReturnToComposer();
    return status;
  }

  async checkElementEligibility(name) {
    const normalized = String(name || '').trim().replace(/^@/, '');
    if (!normalized) return { status: 'missing', proof: null };
    this.invalidateElementEligibility(normalized);
    const status = await this._checkOneElementEligibility(normalized);
    return {
      status,
      proof: this._getElementEligibilityRecord(normalized),
    };
  }

  async _openElementsPickerViaAtButton() {
    const page = this.automation.page;
    const atButton = await page.evaluate(() => {
      const vh = window.innerHeight;
      const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const inCinemaComposer = (el) => {
        let node = el;
        for (let depth = 0; node && depth < 10; depth++, node = node.parentElement) {
          const r = node.getBoundingClientRect();
          const text = clean(node.textContent);
          if (
            r.width > 300 && r.height > 80
            && r.y > window.innerHeight * 0.45
            && /Cinema Studio 3\.5/i.test(text)
            && !/Nano Banana/i.test(text)
          ) return true;
        }
        return false;
      };
      const buttons = [...document.querySelectorAll('button')];
      const explicitAt = buttons.map(b => ({
          b,
          r: b.getBoundingClientRect(),
          t: clean(b.textContent || b.getAttribute('aria-label') || ''),
        }))
        .filter(o => o.r.y > vh * 0.60 && o.r.width > 20 && o.r.width < 70 && o.r.height > 20 && o.r.height < 70
          && /^@$/i.test(o.t) && inCinemaComposer(o.b))
        .sort((a, b) => b.r.x - a.r.x)[0];
      if (explicitAt) {
        return {
          x: Math.round(explicitAt.r.x + explicitAt.r.width / 2),
          y: Math.round(explicitAt.r.y + explicitAt.r.height / 2),
          text: explicitAt.t,
        };
      }
      const sound = buttons.map(b => ({ b, r: b.getBoundingClientRect(), t: clean(b.textContent || '') }))
        .filter(o => o.r.y > vh * 0.60 && /^(On|Off)$/i.test(o.t))
        .sort((a, b) => a.r.x - b.r.x).pop();
      if (!sound) return null;
      const candidates = [];
      for (const b of buttons) {
        const r = b.getBoundingClientRect();
        const t = clean(b.textContent || b.getAttribute('aria-label') || '');
        if (r.y > vh * 0.60 && r.x > sound.r.x && r.x < sound.r.x + 140
            && r.width > 15 && r.width < 70 && r.height > 15 && r.height < 70
            && inCinemaComposer(b)) {
          candidates.push({ x: r.x, y: r.y, w: r.width, h: r.height, text: t });
        }
      }
      candidates.sort((a, b) => a.x - b.x);
      const c = candidates[0];
      return c ? { x: Math.round(c.x + c.w / 2), y: Math.round(c.y + c.h / 2), text: c.text } : null;
    });
    if (!atButton) throw new Error('@ element button next to Sound/Audio control not found');
    await page.mouse.click(atButton.x, atButton.y);
    await page.waitForTimeout(1200);
  }

  async _isElementsPickerOpen() {
    const page = this.automation.page;
    return page.evaluate(() => {
      const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 10 && r.height > 10 && s.display !== 'none' && s.visibility !== 'hidden'
          && r.top < innerHeight && r.left < innerWidth && r.bottom > 0 && r.right > 0;
      };
      const modalish = [...document.querySelectorAll(
        '[role="dialog"], [data-state="open"], [class*="Dialog"], [class*="Sheet"], [class*="modal"], [class*="Modal"], [class*="popover"], [class*="Popover"]'
      )].filter(visible);
      for (const el of modalish) {
        const r = el.getBoundingClientRect();
        if (r.width < 300 || r.height < 220) continue;
        const text = clean(el.innerText || el.textContent || '');
        const hasElementsSignals =
          /\bElements\b/i.test(text) &&
          (
            /Assets\s+Elements/i.test(text) ||
            /\bMy Elements\b/i.test(text) ||
            /\bAll Pinned\b/i.test(text) ||
            /\bShow subfolders elements\b/i.test(text)
          );
        const hasPickerTabs = /\b(Uploads|Image Generations|Video Generations)\b/i.test(text);
        if (hasElementsSignals || (hasPickerTabs && /\bMy Elements\b/i.test(text))) return true;
      }
      return false;
    }).catch(() => false);
  }

  async _ensureElementsPickerOpen() {
    if (await this._isElementsPickerOpen()) return true;
    await this._openElementsPickerViaProjectButton().catch(() => {});
    if (await this._isElementsPickerOpen()) return true;
    await this._openElementsPickerViaAtButton();
    return this._isElementsPickerOpen();
  }

  async _openElementsPickerViaProjectButton() {
    const page = this.automation.page;
    const target = await page.evaluate(() => {
      const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const candidates = [...document.querySelectorAll('button, [role="button"], div')]
        .map(el => {
          const r = el.getBoundingClientRect();
          const text = clean(el.innerText || el.textContent || '');
          const aria = clean(el.getAttribute('aria-label') || '');
          const inProjectControlBand = r.y > 60 && r.y < innerHeight * 0.40 && r.x > innerWidth * 0.38 && r.x < innerWidth * 0.82;
          const score =
            (inProjectControlBand ? 100 : 0) +
            (/^Elements$/i.test(aria) ? 30 : 0) +
            (/^Elements$/i.test(text) ? 20 : 0) +
            (r.y < 60 ? -80 : 0) +
            (r.width >= 30 && r.width <= 90 && r.height >= 28 && r.height <= 90 ? 15 : 0);
          return { el, r, text, aria, score };
        })
        .filter(o =>
          o.r.width >= 30 && o.r.width <= 160 &&
          o.r.height >= 20 && o.r.height <= 100 &&
          o.r.y > 40 && o.r.y < innerHeight * 0.45 &&
          o.r.x > innerWidth * 0.35 && o.r.x < innerWidth * 0.85 &&
          (/^Elements$/i.test(o.text) || /^Elements$/i.test(o.aria))
        )
        .sort((a, b) => b.score - a.score || a.r.y - b.r.y || a.r.x - b.r.x);
      const item = candidates[0];
      return item ? {
        x: Math.round(item.r.x + item.r.width / 2),
        y: Math.round(item.r.y + item.r.height / 2),
        text: item.text || item.aria,
      } : null;
    }).catch(() => null);
    if (!target) throw new Error('Project Elements button not found');
    this.log(`[CINEMA-VIDEO] Opening Elements panel via project Elements button at (${target.x}, ${target.y})`);
    await page.mouse.click(target.x, target.y);
    await page.waitForTimeout(1200);
  }

  async _closePickerAndReturnToComposer() {
    const page = this.automation.page;
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(700);
    await this._clickPromptTextbox().catch(() => {});
    await page.waitForTimeout(500);
  }

  async _tryClickPickerTab(tabName) {
    const page = this.automation.page;
    const directTab = page.getByText(tabName, { exact: true }).first();
    if (await directTab.isVisible({ timeout: 1500 }).catch(() => false)) {
      await directTab.click({ timeout: 3000 });
      await page.waitForTimeout(1000);
      return true;
    }

    const clicked = await page.evaluate((label) => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 10 && r.height > 10 && s.display !== 'none' && s.visibility !== 'hidden'
          && r.top < innerHeight && r.left < innerWidth && r.bottom > 0 && r.right > 0;
      };
      const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const candidates = [...document.querySelectorAll('button, [role="tab"], div, span')]
        .filter(visible)
        .map(el => ({ el, text: clean(el.innerText || el.textContent || ''), r: el.getBoundingClientRect() }))
        .filter(o => o.text === label && o.r.y < innerHeight * 0.45);
      candidates.sort((a, b) => a.r.y - b.r.y || a.r.x - b.r.x);
      const target = candidates[0]?.el;
      if (!target) return false;
      target.click();
      return true;
    }, tabName).catch(() => false);

    if (clicked) {
      await page.waitForTimeout(1000);
      return true;
    }
    return false;
  }

  async _findElementCard(name) {
    const page = this.automation.page;
    return page.evaluate((targetName) => {
      const target = String(targetName || '').toLowerCase().replace(/^@/, '');
      const parts = target.split('_');
      const outfitIndex = parts.findIndex(part => /^o\d+$/i.test(part));
      const matchPrefix = outfitIndex >= 2 ? parts.slice(0, outfitIndex + 1).join('_') : target;
      const normalize = (value) => String(value || '').toLowerCase().replace(/^@/, '').trim();
      const nameTokens = (text) => {
        const tokens = [];
        const re = /@([a-z0-9_.-]+)/ig;
        let match;
        while ((match = re.exec(text || '')) !== null) {
          tokens.push(normalize(match[1]));
        }
        return tokens;
      };
      const tokenMatchesTarget = (token) => {
        if (!token) return false;
        if (token === target) return true;
        // Truncated UI labels commonly end in "..."; allow a target prefix
        // only when the rendered token itself is the beginning of the target.
        if (token.endsWith('...')) return target.startsWith(token.replace(/\.+$/g, ''));
        return false;
      };
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 20 && r.height > 20 && s.display !== 'none' && s.visibility !== 'hidden'
          && r.top < innerHeight && r.left < innerWidth && r.bottom > 0 && r.right > 0;
      };
      const textOf = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      const checkingRe = /face\s*\/\s*ip\s*check(?:ing)?|checking content|checking/i;
      const all = [...document.querySelectorAll('figure, [role="button"], button, div')];
      const cards = [];
      for (const el of all) {
        if (!visible(el)) continue;
        const text = textOf(el);
        const lower = text.toLowerCase();
        const r = el.getBoundingClientRect();
        if (r.width < 80 || r.width > 260 || r.height < 80 || r.height > 280) continue;
        const tokens = nameTokens(text);
        const exactToken = tokens.find(tokenMatchesTarget);
        if (!exactToken) continue;
        const checkBtn = [...el.querySelectorAll('button, div, span')]
          .filter(visible)
          .find(child => /check eligibility/i.test(textOf(child)));
        const cr = checkBtn ? checkBtn.getBoundingClientRect() : r;
        const statusText = /not eligible/i.test(text) ? 'not-eligible'
          : checkingRe.test(text) ? 'checking'
          : /check eligibility/i.test(text) ? 'check'
          : /\beligible\b/i.test(text) ? 'eligible'
          : /\bUse\b/i.test(text) ? 'eligible-visual'
          : 'unknown';
        cards.push({
          x: Math.round(r.x + r.width / 2),
          y: Math.round(r.y + r.height / 2),
          rect: {
            x: Math.round(r.x),
            y: Math.round(r.y),
            w: Math.round(r.width),
            h: Math.round(r.height),
          },
          text,
          checkX: Math.round(cr.x + cr.width / 2),
          checkY: Math.round(cr.y + cr.height / 2),
          name: `@${exactToken}`,
          target,
          matchPrefix,
          status: statusText,
          area: r.width * r.height,
          hasCharacterLabel: /\bCharacter\b/i.test(text),
        });
      }
      cards.sort((a, b) => {
        if (a.hasCharacterLabel !== b.hasCharacterLabel) return a.hasCharacterLabel ? -1 : 1;
        return b.area - a.area || a.y - b.y || a.x - b.x;
      });
      return cards[0] || null;
    }, name);
  }

  async _waitForElementCard(name, timeoutMs) {
    const page = this.automation.page;
    const start = Date.now();
    let attempt = 0;
    await this._scrollElementPicker('top').catch(() => null);
    while (Date.now() - start < timeoutMs) {
      const card = await this._findElementCard(name);
      if (card) return card;
      const waitMs = this._progressiveWaitMs(attempt, { min: 750, max: 4000, step: 400 });
      if (attempt === 0 || attempt % 5 === 4) {
        this.log(`Element @${String(name).replace(/^@/, '')} card not visible yet (${Math.round((Date.now() - start) / 1000)}s)`);
      }
      await this._scrollElementPicker('next').catch(() => null);
      await page.waitForTimeout(waitMs);
      attempt++;
    }
    return null;
  }

  async _centerElementCardInPicker(name) {
    const page = this.automation.page;
    const centered = await page.evaluate((targetName) => {
      const target = String(targetName || '').toLowerCase().replace(/^@/, '');
      const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const normalize = (value) => clean(value).toLowerCase().replace(/^@/, '');
      const tokensOf = (text) => {
        const tokens = [];
        const re = /@([a-z0-9_.-]+)/ig;
        let match;
        while ((match = re.exec(text || '')) !== null) tokens.push(normalize(match[1]));
        return tokens;
      };
      const tokenMatchesTarget = (token) => {
        if (!token) return false;
        if (token === target) return true;
        if (token.endsWith('...')) return target.startsWith(token.replace(/\.+$/g, ''));
        return false;
      };
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 20 && r.height > 20 && s.display !== 'none' && s.visibility !== 'hidden'
          && r.top < innerHeight && r.left < innerWidth && r.bottom > 0 && r.right > 0;
      };
      const textOf = (el) => clean(el.innerText || el.textContent || '');
      const cards = [...document.querySelectorAll('figure, [role="button"], button, div')]
        .filter(visible)
        .map(el => ({ el, r: el.getBoundingClientRect(), text: textOf(el) }))
        .filter(o =>
          o.r.width >= 80 && o.r.width <= 280
          && o.r.height >= 80 && o.r.height <= 320
          && tokensOf(o.text).some(tokenMatchesTarget)
          && /Character|Check eligibility|Face\s*\/\s*IP|eligible|Use/i.test(o.text)
        )
        .sort((a, b) => {
          const aCharacter = /\bCharacter\b/i.test(a.text) ? 1 : 0;
          const bCharacter = /\bCharacter\b/i.test(b.text) ? 1 : 0;
          if (aCharacter !== bCharacter) return bCharacter - aCharacter;
          return (b.r.width * b.r.height) - (a.r.width * a.r.height);
        });
      const card = cards[0];
      if (!card) return null;

      card.el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const scrollParent = (() => {
        for (let node = card.el.parentElement; node; node = node.parentElement) {
          const s = getComputedStyle(node);
          if (/(auto|scroll)/i.test(`${s.overflowY} ${s.overflow}`) && node.scrollHeight > node.clientHeight + 20) {
            return node;
          }
        }
        return null;
      })();
      if (scrollParent) {
        const r = card.el.getBoundingClientRect();
        const desiredTop = Math.max(110, Math.floor(innerHeight * 0.28));
        if (r.bottom > innerHeight - 140 || r.top < 120) {
          scrollParent.scrollTop += r.top - desiredTop;
        }
      }

      const after = card.el.getBoundingClientRect();
      return {
        before: {
          x: Math.round(card.r.x),
          y: Math.round(card.r.y),
          w: Math.round(card.r.width),
          h: Math.round(card.r.height),
        },
        after: {
          x: Math.round(after.x),
          y: Math.round(after.y),
          w: Math.round(after.width),
          h: Math.round(after.height),
        },
      };
    }, name).catch(() => null);
    await page.waitForTimeout(700);
    return centered;
  }

  async _hoverElementCardControls(card) {
    const page = this.automation.page;
    if (!card) return;
    const rect = card.rect || null;
    await this._hoverPoint(card, 450).catch(() => {});
    if (rect?.w && rect?.h) {
      const menuHotspot = {
        x: Math.round(rect.x + rect.w - 24),
        y: Math.round(rect.y + rect.h - 34),
      };
      await page.mouse.move(menuHotspot.x, menuHotspot.y).catch(() => {});
      await page.waitForTimeout(450);
      await page.mouse.move(menuHotspot.x - 2, menuHotspot.y + 2).catch(() => {});
      await page.waitForTimeout(450);
    }
  }

  async _scrollElementPicker(action = 'next') {
    const page = this.automation.page;
    const state = await page.evaluate((scrollAction) => {
      const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const visible = (el) => {
        if (el === document.body || el === document.documentElement) return false;
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 120 && r.height > 120 && s.display !== 'none' && s.visibility !== 'hidden'
          && r.top < innerHeight && r.left < innerWidth && r.bottom > 0 && r.right > 0;
      };
      const candidates = [...document.querySelectorAll('div, section, main, [role="dialog"], [data-radix-scroll-area-viewport]')]
        .filter(el => visible(el) && el.scrollHeight > el.clientHeight + 40)
        .map(el => {
          const r = el.getBoundingClientRect();
          const text = clean(el.innerText || el.textContent || '');
          const score = (/(Uploads|Image Generations|Video Generations|Elements|Liked)/i.test(text) ? 5 : 0)
            + (/Check eligibility|Face\s*\/\s*IP\s*check(?:ing)?|Checking content|Character|\bUse\b/i.test(text) ? 5 : 0)
            + (r.width > 600 && r.height > 300 ? 3 : 0)
            + Math.min(4, Math.floor((el.scrollHeight - el.clientHeight) / 300));
          return { el, r, score };
        })
        .filter(o => o.score >= 5)
        .sort((a, b) => b.score - a.score || (b.r.width * b.r.height) - (a.r.width * a.r.height));
      const target = candidates[0]?.el;
      if (!target) return null;
      if (scrollAction === 'top') {
        target.scrollTop = 0;
      } else {
        const before = target.scrollTop;
        target.scrollTop = Math.min(target.scrollHeight, target.scrollTop + Math.max(180, Math.floor(target.clientHeight * 0.75)));
        if (target.scrollTop === before && target.scrollTop + target.clientHeight >= target.scrollHeight - 4) {
          target.scrollTop = 0;
        }
      }
      return {
        scrollTop: Math.round(target.scrollTop),
        clientHeight: Math.round(target.clientHeight),
        scrollHeight: Math.round(target.scrollHeight),
      };
    }, action).catch(() => null);
    await page.waitForTimeout(500);
    return state;
  }

  async _setElementsPickerSearch(value) {
    const page = this.automation.page;
    const text = String(value || '').trim().replace(/^@/, '');
    const target = await page.evaluate(() => {
      const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim();
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 40 && r.height > 16 && s.display !== 'none' && s.visibility !== 'hidden'
          && r.top < innerHeight && r.left < innerWidth && r.bottom > 0 && r.right > 0;
      };
      const inElementsDialog = (el) => {
        for (let node = el; node; node = node.parentElement) {
          const r = node.getBoundingClientRect();
          if (r.width < 450 || r.height < 240) continue;
          const text = clean(node.innerText || node.textContent || '');
          if (/\bMy Elements\b/i.test(text) && /\bShow subfolders elements\b/i.test(text)) return true;
          if (/\bUploads\b/i.test(text) && /\bElements\b/i.test(text) && /\bImage Generations\b/i.test(text)) return true;
        }
        return false;
      };
      const candidates = [...document.querySelectorAll('input, textarea, [contenteditable="true"]')]
        .filter(visible)
        .map(el => {
          const r = el.getBoundingClientRect();
          const label = clean([
            el.getAttribute('placeholder'),
            el.getAttribute('aria-label'),
            el.getAttribute('title'),
            el.innerText,
            el.textContent,
          ].filter(Boolean).join(' '));
          const score = (/search/i.test(label) ? 60 : 0)
            + (inElementsDialog(el) ? 50 : 0)
            + (r.y < innerHeight * 0.42 ? 10 : 0)
            + (r.x > innerWidth * 0.45 ? 10 : 0);
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), label, score };
        })
        .filter(o => o.score >= 60)
        .sort((a, b) => b.score - a.score || b.x - a.x);
      return candidates[0] || null;
    }).catch(() => null);
    if (!target) return false;
    await page.mouse.click(target.x, target.y);
    await page.keyboard.press('Control+A').catch(() => {});
    await page.keyboard.press('Backspace').catch(() => {});
    if (text) await page.keyboard.type(text, { delay: 8 });
    await page.waitForTimeout(text ? 1400 : 700);
    await this._scrollElementPicker('top').catch(() => null);
    return true;
  }

  async _clearElementsPickerSearch() {
    return this._setElementsPickerSearch('');
  }

  async _reacquireElementCard(card) {
    const name = card?.target || card?.name;
    if (!name) return null;
    let current = await this._findElementCard(name).catch(() => null);
    if (current) return current;
    const opened = await this._ensureElementsPickerOpen().catch(() => false);
    if (!opened) return null;
    return this._waitForElementCard(name, 45000).catch(() => null);
  }

  async _findElementCheckButton(card) {
    const page = this.automation.page;
    return page.evaluate(({ name, target, matchPrefix }) => {
      const fullTarget = String(target || name || '').toLowerCase().replace(/^@/, '');
      const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const normalize = (value) => clean(value).toLowerCase().replace(/^@/, '');
      const tokensOf = (text) => {
        const tokens = [];
        const re = /@([a-z0-9_.-]+)/ig;
        let match;
        while ((match = re.exec(text || '')) !== null) tokens.push(normalize(match[1]));
        return tokens;
      };
      const exactNameIn = (text) => tokensOf(text).some(token => token === fullTarget || (token.endsWith('...') && fullTarget.startsWith(token.replace(/\.+$/g, ''))));
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 10 && r.height > 10 && s.display !== 'none' && s.visibility !== 'hidden'
          && r.top < innerHeight && r.left < innerWidth && r.bottom > 0 && r.right > 0;
      };
      const textOf = (el) => clean(el?.innerText || el?.textContent || '');
      const candidates = [...document.querySelectorAll('figure, [role="button"], button, div')]
        .filter(visible)
        .map(el => {
          const r = el.getBoundingClientRect();
          const text = textOf(el);
          const matchesTarget = exactNameIn(text);
          return { el, r, text, matchesTarget };
        })
        .filter(o => o.matchesTarget && o.r.width >= 80 && o.r.width <= 280 && o.r.height >= 70 && o.r.height <= 320)
        .sort((a, b) => (a.r.width * a.r.height) - (b.r.width * b.r.height));
      for (const candidate of candidates) {
        const buttons = [...candidate.el.querySelectorAll('button, [role="button"], div, span')]
          .filter(visible)
          .map(el => {
            const r = el.getBoundingClientRect();
            const text = textOf(el);
            const tag = String(el.tagName || '').toLowerCase();
            const role = el.getAttribute('role') || '';
            const exact = /^check eligibility$/i.test(text);
            const actionable = tag === 'button' || role === 'button';
            const pillSized = r.width >= 70 && r.width <= 190 && r.height >= 24 && r.height <= 58;
            const inLowerCard = r.y + r.height / 2 >= candidate.r.y + candidate.r.height * 0.35;
            const score = (exact ? 50 : 0)
              + (actionable ? 30 : 0)
              + (pillSized ? 20 : 0)
              + (inLowerCard ? 10 : 0)
              - Math.abs((r.width * r.height) - 5000) / 1000;
            return { el, r, text, tag, role, score };
          })
          .filter(o => /^check eligibility$/i.test(o.text) || /check eligibility/i.test(o.text))
          .sort((a, b) => b.score - a.score || (a.r.width * a.r.height) - (b.r.width * b.r.height));
        const button = buttons[0];
        if (!button) continue;
        button.el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        const br = button.el.getBoundingClientRect();
        return {
          x: Math.round(br.x + br.width / 2),
          y: Math.round(br.y + br.height / 2),
          text: button.text,
          tag: button.tag,
          role: button.role,
          score: Math.round(button.score),
          cardText: candidate.text,
        };
      }
      return null;
    }, card).catch(() => null);
  }

  async _clickElementCheckEligibility(card) {
    const page = this.automation.page;
    await this._ensureElementsPickerOpen().catch(() => false);
    let currentCard = await this._reacquireElementCard(card).catch(() => null) || card;
    await this._hoverPoint(currentCard, 800);

    let button = await this._findElementCheckButton(currentCard);
    if (!button) {
      currentCard = await this._reacquireElementCard(currentCard).catch(() => null) || currentCard;
      await this._hoverPoint(currentCard, 800);
      button = await this._findElementCheckButton(currentCard);
    }
    if (!button) return false;

    await page.mouse.click(button.x, button.y);
    for (let attempt = 0; attempt < 6; attempt++) {
      await page.waitForTimeout(attempt === 0 ? 1200 : 1000);
      currentCard = await this._reacquireElementCard(currentCard).catch(() => null) || currentCard;
      const status = await this._readElementCardStatus(currentCard, { hoverMs: 800, useFallbackStatus: false });
      if (status === 'checking' || status === 'eligible' || status === 'eligible-visual' || status === 'not-eligible') {
        return true;
      }
    }
    return false;
  }

  async _waitForElementEligibility(card, timeoutMs, { returnOnCheck = true, useFallbackStatus = true } = {}) {
    const page = this.automation.page;
    const start = Date.now();
    let attempt = 0;
    let lastStatus = null;
    let lastProgressLogAt = 0;
    let currentCard = card;
    while (Date.now() - start < timeoutMs) {
      const waitMs = this._progressiveWaitMs(attempt, { min: 700, max: 4500, step: 350 });
      const reacquired = await this._reacquireElementCard(currentCard).catch(() => null);
      if (reacquired) {
        currentCard = reacquired;
      } else if (!returnOnCheck) {
        const elapsedSeconds = Math.round((Date.now() - start) / 1000);
        if (lastStatus !== 'picker-closed') {
          this.log(`Element ${currentCard.name || card.name || ''} eligibility picker/card not visible (${elapsedSeconds}s)`);
          lastStatus = 'picker-closed';
          lastProgressLogAt = Date.now();
        } else if (Date.now() - lastProgressLogAt > 15000) {
          this.log(`Element ${currentCard.name || card.name || ''} eligibility picker/card still not visible; reopening @ picker (${elapsedSeconds}s)`);
          lastProgressLogAt = Date.now();
        }
        await page.waitForTimeout(waitMs);
        attempt++;
        continue;
      }
      const status = await this._readElementCardStatus(currentCard, { hoverMs: waitMs, useFallbackStatus });
      const effectiveStatus = status === 'unknown' && useFallbackStatus && currentCard.status && currentCard.status !== 'unknown' ? currentCard.status : status;
      const elapsedSeconds = Math.round((Date.now() - start) / 1000);
      if (effectiveStatus !== lastStatus) {
        this.log(`Element ${currentCard.name || card.name || ''} eligibility status: ${effectiveStatus} (${elapsedSeconds}s)`);
        lastStatus = effectiveStatus;
        lastProgressLogAt = Date.now();
      } else if (!returnOnCheck && Date.now() - lastProgressLogAt > 15000) {
        this.log(`Element ${currentCard.name || card.name || ''} eligibility still ${effectiveStatus}; waiting for final hover status (${elapsedSeconds}s)`);
        lastProgressLogAt = Date.now();
      }
      if (effectiveStatus === 'eligible' || effectiveStatus === 'eligible-visual' || effectiveStatus === 'not-eligible' || (returnOnCheck && effectiveStatus === 'check')) return effectiveStatus;
      await page.waitForTimeout(waitMs);
      attempt++;
    }
    return 'timeout';
  }

  async _readElementCardStatus(card, { hoverMs = 500, useFallbackStatus = true } = {}) {
    const page = this.automation.page;
    await this._hoverPoint(card, hoverMs);
    return page.evaluate(({ x, y, checkX, checkY, name, target, matchPrefix, status: fallbackStatus, allowFallback }) => {
      const cardName = String(name || '').toLowerCase().replace(/^@/, '');
      const fullTarget = String(target || cardName || '').toLowerCase().replace(/^@/, '');
      const textOf = (el) => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase().replace(/^@/, '');
      const tokensOf = (text) => {
        const tokens = [];
        const re = /@([a-z0-9_.-]+)/ig;
        let match;
        while ((match = re.exec(text || '')) !== null) tokens.push(normalize(match[1]));
        return tokens;
      };
      const exactNameIn = (text) => !fullTarget || tokensOf(text).some(token => token === fullTarget || (token.endsWith('...') && fullTarget.startsWith(token.replace(/\.+$/g, ''))));
      const checkingRe = /face\s*\/\s*ip\s*check(?:ing)?|checking content|checking/i;
      const statusSignalRe = /face\s*\/\s*ip\s*check(?:ing)?|eligible|eligibility|checking|check eligibility|\bUse\b/i;
      const pointEls = [
        document.elementFromPoint(x, y),
        checkX && checkY ? document.elementFromPoint(checkX, checkY) : null,
      ].filter(Boolean);
      let cardEl = null;
      for (const pointEl of pointEls) {
        for (let node = pointEl; node; node = node.parentElement) {
          const r = node.getBoundingClientRect();
          const text = textOf(node);
          const matchesTarget = exactNameIn(text);
          if (
            r.width >= 80 && r.width <= 260
            && r.height >= 50 && r.height <= 280
            && matchesTarget
            && statusSignalRe.test(text)
          ) {
            cardEl = node;
            break;
          }
        }
        if (cardEl && statusSignalRe.test(textOf(cardEl))) break;
      }
      if (!cardEl && fullTarget) {
        const matches = [...document.querySelectorAll('figure, [role="button"], button, div')].filter(node => {
          const r = node.getBoundingClientRect();
          const text = textOf(node);
          return r.width >= 80 && r.width <= 260
            && r.height >= 50 && r.height <= 280
            && r.top < innerHeight && r.bottom > 0
            && exactNameIn(text)
            && statusSignalRe.test(text);
        });
        cardEl = matches[0] || pointEls[0];
      }
      const text = textOf(cardEl);
      const hasUse = /\bUse\b/i.test(text);
      const colorLooksReady = (value) => {
        const m = String(value || '').match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([0-9.]+))?\)/i);
        if (!m) return false;
        const r = Number(m[1]);
        const g = Number(m[2]);
        const b = Number(m[3]);
        const a = m[4] === undefined ? 1 : Number(m[4]);
        if (!Number.isFinite(r + g + b + a) || a < 0.25) return false;
        return g >= 150 && r >= 100 && b <= 140 && g >= b + 45;
      };
      const hasReadyBadge = cardEl ? [...cardEl.querySelectorAll('*')].some(child => {
        const r = child.getBoundingClientRect();
        if (r.width < 7 || r.width > 32 || r.height < 7 || r.height > 32) return false;
        const cx = r.x + r.width / 2;
        const cy = r.y + r.height / 2;
        const cr = cardEl.getBoundingClientRect();
        if (cx < cr.x || cx > cr.x + cr.width * 0.45) return false;
        if (cy < cr.y + cr.height * 0.45 || cy > cr.y + cr.height * 0.98) return false;
        const s = getComputedStyle(child);
        const tag = String(child.tagName || '').toLowerCase();
        const hasReadyColor = colorLooksReady(s.backgroundColor) || colorLooksReady(s.color) || colorLooksReady(s.borderColor) || colorLooksReady(s.fill) || colorLooksReady(s.stroke);
        const logoLike = hasUse && /^(img|svg|canvas)$/i.test(tag) && !textOf(child);
        return hasReadyColor || logoLike;
      }) : false;
      if (/not eligible/i.test(text)) return 'not-eligible';
      if (checkingRe.test(text)) return 'checking';
      if (/check eligibility/i.test(text)) return 'check';
      if (/\beligible\b/i.test(text)) return 'eligible';
      if (hasUse && hasReadyBadge) return 'eligible-visual';
      return allowFallback && fallbackStatus && fallbackStatus !== 'unknown' ? fallbackStatus : 'unknown';
    }, { ...card, allowFallback: useFallbackStatus }).catch(() => 'unknown');
  }

  async _snapshotElementCardProof(nameOrCard) {
    const page = this.automation.page;
    const card = typeof nameOrCard === 'object'
      ? nameOrCard
      : await this._findElementCard(nameOrCard).catch(() => null);
    if (card) await this._hoverPoint(card, 900).catch(() => {});
    return page.evaluate((arg) => {
      const target = String(arg?.target || arg?.name || arg || '').toLowerCase().replace(/^@/, '');
      const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const normalize = (value) => clean(value).toLowerCase().replace(/^@/, '');
      const tokensOf = (text) => {
        const tokens = [];
        const re = /@([a-z0-9_.-]+)/ig;
        let match;
        while ((match = re.exec(text || '')) !== null) tokens.push(normalize(match[1]));
        return tokens;
      };
      const exactNameIn = (text) => !target || tokensOf(text).some(token => token === target || (token.endsWith('...') && target.startsWith(token.replace(/\.+$/g, ''))));
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 20 && r.height > 20 && s.display !== 'none' && s.visibility !== 'hidden'
          && r.top < innerHeight && r.left < innerWidth && r.bottom > 0 && r.right > 0;
      };
      const checkingRe = /face\s*\/\s*ip\s*check(?:ing)?|checking content|checking/i;
      const candidates = [...document.querySelectorAll('figure, [role="button"], button, div')]
        .filter(visible)
        .map(el => {
          const r = el.getBoundingClientRect();
          const text = clean(el.innerText || el.textContent || '');
          const matches = exactNameIn(text);
          const colorLooksReady = (value) => {
            const m = String(value || '').match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([0-9.]+))?\)/i);
            if (!m) return false;
            const red = Number(m[1]);
            const green = Number(m[2]);
            const blue = Number(m[3]);
            const alpha = m[4] === undefined ? 1 : Number(m[4]);
            return Number.isFinite(red + green + blue + alpha)
              && alpha >= 0.25
              && green >= 150
              && red >= 100
              && blue <= 140
              && green >= blue + 45;
          };
          const hasUse = /\bUse\b/i.test(text);
          const hasReadyBadge = [...el.querySelectorAll('*')].some(child => {
            const br = child.getBoundingClientRect();
            if (br.width < 7 || br.width > 32 || br.height < 7 || br.height > 32) return false;
            const cx = br.x + br.width / 2;
            const cy = br.y + br.height / 2;
            if (cx < r.x || cx > r.x + r.width * 0.45) return false;
            if (cy < r.y + r.height * 0.45 || cy > r.y + r.height * 0.98) return false;
            const s = getComputedStyle(child);
            const tag = String(child.tagName || '').toLowerCase();
            const hasReadyColor = colorLooksReady(s.backgroundColor) || colorLooksReady(s.color) || colorLooksReady(s.borderColor) || colorLooksReady(s.fill) || colorLooksReady(s.stroke);
            const logoLike = hasUse && /^(img|svg|canvas)$/i.test(tag) && !clean(child.innerText || child.textContent || '');
            return hasReadyColor || logoLike;
          });
          const status = /not eligible/i.test(text) ? 'not-eligible'
            : checkingRe.test(text) ? 'checking'
              : /check eligibility/i.test(text) ? 'check'
                : /\beligible\b/i.test(text) ? 'eligible'
                  : hasUse && hasReadyBadge ? 'eligible-visual'
                  : 'unknown';
          const score = (matches ? 10 : 0)
            + (status !== 'unknown' ? 8 : 0)
            + (/\bCharacter\b/i.test(text) ? 2 : 0)
            - Math.abs((r.width * r.height) - 26000) / 10000;
          return { text, status, score, hasUse, hasReadyBadge, rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } };
        })
        .filter(o => o.score >= 8)
        .sort((a, b) => b.score - a.score);
      const best = candidates[0] || null;
      return best ? {
        status: best.status,
        text: best.text.slice(0, 500),
        source: 'hover-card',
        hasUse: !!best.hasUse,
        hasReadyBadge: !!best.hasReadyBadge,
        rect: best.rect,
      } : { status: 'unknown', text: '', source: 'not-found' };
    }, card || nameOrCard).catch(() => ({ status: 'unknown', text: '', source: 'snapshot-error' }));
  }

  async _findElementCardMenuButton(card) {
    const page = this.automation.page;
    return page.evaluate(({ name, target }) => {
      const fullTarget = String(target || name || '').toLowerCase().replace(/^@/, '');
      const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const normalize = (value) => clean(value).toLowerCase().replace(/^@/, '');
      const tokensOf = (text) => {
        const tokens = [];
        const re = /@([a-z0-9_.-]+)/ig;
        let match;
        while ((match = re.exec(text || '')) !== null) tokens.push(normalize(match[1]));
        return tokens;
      };
      const exactNameIn = (text) => tokensOf(text).some(token => token === fullTarget || (token.endsWith('...') && fullTarget.startsWith(token.replace(/\.+$/g, ''))));
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 8 && r.height > 8 && s.display !== 'none' && s.visibility !== 'hidden'
          && r.top < innerHeight && r.left < innerWidth && r.bottom > 0 && r.right > 0;
      };
      const textOf = (el) => clean(el?.innerText || el?.textContent || '');
      const cardCandidates = [...document.querySelectorAll('figure, [role="button"], button, div')]
        .filter(visible)
        .map(el => {
          const r = el.getBoundingClientRect();
          const text = textOf(el);
          return { el, r, text };
        })
        .filter(o =>
          o.r.width >= 80 && o.r.width <= 280
          && o.r.height >= 70 && o.r.height <= 320
          && exactNameIn(o.text)
          && /Character|Check eligibility|Face\s*\/\s*IP|eligible|Use/i.test(o.text)
        )
        .sort((a, b) => {
          const aCharacter = /\bCharacter\b/i.test(a.text) ? 1 : 0;
          const bCharacter = /\bCharacter\b/i.test(b.text) ? 1 : 0;
          if (aCharacter !== bCharacter) return bCharacter - aCharacter;
          return (b.r.width * b.r.height) - (a.r.width * a.r.height);
        });

      const cardEl = cardCandidates[0]?.el || null;
      if (!cardEl) return null;
      const cr = cardEl.getBoundingClientRect();
      const candidateElements = [
        ...cardEl.querySelectorAll('button, [role="button"], div, span, svg'),
        ...document.querySelectorAll('button, [role="button"], div, span, svg'),
      ];
      const seen = new Set();
      const menuCandidates = candidateElements
        .filter(el => {
          if (seen.has(el)) return false;
          seen.add(el);
          return true;
        })
        .filter(visible)
        .map(el => {
          const r = el.getBoundingClientRect();
          const text = textOf(el);
          const aria = clean(el.getAttribute('aria-label') || el.getAttribute('title') || '');
          const tag = String(el.tagName || '').toLowerCase();
          const role = el.getAttribute('role') || '';
          const hasSvg = !!el.querySelector?.('svg') || tag === 'svg';
          const cx = r.x + r.width / 2;
          const cy = r.y + r.height / 2;
          const nearCard = cx >= cr.x + cr.width * 0.52
            && cx <= cr.x + cr.width + 18
            && cy >= cr.y + cr.height * 0.35
            && cy <= cr.y + cr.height + 12;
          const inLowerRight = cx >= cr.x + cr.width * 0.62 && cy >= cr.y + cr.height * 0.45;
          const small = r.width >= 14 && r.width <= 54 && r.height >= 14 && r.height <= 54;
          const badLabel = /\b(Use|Check eligibility|Not eligible|Eligible|Character|View|Pin|Edit|Move to|Copy to|Share|Delete)\b/i.test(text);
          const score = (nearCard ? 45 : 0)
            + (inLowerRight ? 35 : 0)
            + (small ? 35 : 0)
            + ((/more|options|menu|ellipsis/i.test(`${text} ${aria}`) || !text || hasSvg) ? 30 : 0)
            + ((tag === 'button' || role === 'button') ? 20 : 0)
            - (badLabel ? 80 : 0);
          return { x: Math.round(cx), y: Math.round(cy), text, aria, score, w: Math.round(r.width), h: Math.round(r.height) };
        })
        .filter(o => o.score >= 80)
        .sort((a, b) => b.score - a.score || b.x - a.x);
      if (menuCandidates[0]) return menuCandidates[0];
      return null;
    }, card).catch(() => null);
  }

  async _findOpenMenuDeleteItem() {
    const page = this.automation.page;
    return page.evaluate(() => {
      const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 20 && r.height > 14 && s.display !== 'none' && s.visibility !== 'hidden'
          && r.top < innerHeight && r.left < innerWidth && r.bottom > 0 && r.right > 0;
      };
      const inMenu = (el) => {
        for (let node = el; node; node = node.parentElement) {
          const role = node.getAttribute?.('role') || '';
          const cls = String(node.className || '');
          const ds = String(node.getAttribute?.('data-radix-popper-content-wrapper') || '');
          if (/menu/i.test(role) || /popover|dropdown|menu/i.test(cls) || ds) return true;
        }
        return false;
      };
      const items = [...document.querySelectorAll('button, [role="menuitem"], [role="option"], div, span')]
        .filter(visible)
        .map(el => {
          const r = el.getBoundingClientRect();
          const text = clean(el.innerText || el.textContent || '');
          const role = el.getAttribute('role') || '';
          const tag = String(el.tagName || '').toLowerCase();
          const score = (/^Delete$/i.test(text) ? 80 : 0)
            + (inMenu(el) ? 40 : 0)
            + ((role === 'menuitem' || tag === 'button') ? 20 : 0)
            - (/Get Unlimited|Seedance|Generate/i.test(text) ? 100 : 0);
          return {
            text,
            x: Math.round(r.x + r.width / 2),
            y: Math.round(r.y + r.height / 2),
            w: Math.round(r.width),
            h: Math.round(r.height),
            score,
          };
        })
        .filter(o => /^Delete$/i.test(o.text) && o.score >= 80)
        .sort((a, b) => b.score - a.score || a.y - b.y);
      return items[0] || null;
    }).catch(() => null);
  }

  async _findOpenMenuItem(label) {
    const page = this.automation.page;
    return page.evaluate((menuLabel) => {
      const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const wanted = clean(menuLabel).toLowerCase();
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 20 && r.height > 14 && s.display !== 'none' && s.visibility !== 'hidden'
          && r.top < innerHeight && r.left < innerWidth && r.bottom > 0 && r.right > 0;
      };
      const inMenu = (el) => {
        for (let node = el; node; node = node.parentElement) {
          const role = node.getAttribute?.('role') || '';
          const cls = String(node.className || '');
          const ds = String(node.getAttribute?.('data-radix-popper-content-wrapper') || '');
          if (/menu/i.test(role) || /popover|dropdown|menu/i.test(cls) || ds) return true;
        }
        return false;
      };
      const items = [...document.querySelectorAll('button, [role="menuitem"], [role="option"], div, span')]
        .filter(visible)
        .map(el => {
          const r = el.getBoundingClientRect();
          const text = clean(el.innerText || el.textContent || '');
          const role = el.getAttribute('role') || '';
          const tag = String(el.tagName || '').toLowerCase();
          const exact = text.toLowerCase() === wanted;
          const score = (exact ? 80 : 0)
            + (inMenu(el) ? 40 : 0)
            + ((role === 'menuitem' || tag === 'button') ? 20 : 0)
            - (/Get Unlimited|Seedance|Generate/i.test(text) ? 100 : 0);
          return {
            text,
            x: Math.round(r.x + r.width / 2),
            y: Math.round(r.y + r.height / 2),
            w: Math.round(r.width),
            h: Math.round(r.height),
            score,
          };
        })
        .filter(o => o.text.toLowerCase() === wanted && o.score >= 80)
        .sort((a, b) => b.score - a.score || a.y - b.y);
      return items[0] || null;
    }, label).catch(() => null);
  }

  async _readOpenElementDetailProof(name) {
    const page = this.automation.page;
    return page.evaluate((targetName) => {
      const target = String(targetName || '').toLowerCase().replace(/^@/, '').trim();
      const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const normalize = (value) => clean(value).toLowerCase().replace(/^@/, '').trim();
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 120 && r.height > 80 && s.display !== 'none' && s.visibility !== 'hidden'
          && r.top < innerHeight && r.left < innerWidth && r.bottom > 0 && r.right > 0;
      };
      const dialogs = [...document.querySelectorAll('[role="dialog"], [data-state="open"], section, div')]
        .filter(visible)
        .map(el => {
          const r = el.getBoundingClientRect();
          const text = clean(el.innerText || el.textContent || '');
          const score = (/\bElement\b/i.test(text) ? 25 : 0)
            + (/\bStatus\b/i.test(text) ? 25 : 0)
            + (/\bType\b/i.test(text) ? 25 : 0)
            + (/\bFolders\b/i.test(text) ? 20 : 0)
            + (target && normalize(text).includes(target) ? 40 : 0)
            + (r.width >= 650 && r.height >= 360 ? 15 : 0)
            - (/\bMy Elements\b/i.test(text) && /\bShow subfolders elements\b/i.test(text) ? 30 : 0);
          return { el, r, text, score };
        })
        .filter(o => o.score >= 70)
        .sort((a, b) => b.score - a.score || (b.r.width * b.r.height) - (a.r.width * a.r.height));

      const dialog = dialogs[0] || null;
      if (!dialog) return { open: false, name: '', nameNormalized: '', status: '', text: '', source: 'not-found' };

      const texts = [...dialog.el.querySelectorAll('h1, h2, h3, h4, button, div, span, p')]
        .map(el => clean(el.innerText || el.textContent || ''))
        .filter(Boolean);
      let nameText = '';
      if (target) {
        const exact = texts.find(t => normalize(t) === target)
          || texts.find(t => normalize(t).startsWith(`${target} `))
          || texts.find(t => normalize(t).includes(` ${target} `));
        if (exact) nameText = exact;
      }
      if (!nameText) {
        const token = dialog.text.match(/@?[a-z0-9][a-z0-9.-]*(?:_[a-z0-9][a-z0-9.-]*){2,}/i);
        if (token) nameText = token[0];
      }
      const statusMatch = dialog.text.match(/\bStatus\s+([A-Za-z][A-Za-z -]{1,30})\b/);
      return {
        open: true,
        name: nameText,
        nameNormalized: normalize(nameText),
        status: statusMatch ? clean(statusMatch[1]) : '',
        text: dialog.text.slice(0, 700),
        source: 'element-detail',
        rect: {
          x: Math.round(dialog.r.x),
          y: Math.round(dialog.r.y),
          w: Math.round(dialog.r.width),
          h: Math.round(dialog.r.height),
        },
      };
    }, name).catch(() => ({ open: false, name: '', nameNormalized: '', status: '', text: '', source: 'read-error' }));
  }

  async _findOpenElementDetailButton(label) {
    const page = this.automation.page;
    return page.evaluate((buttonLabel) => {
      const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const wanted = clean(buttonLabel).toLowerCase();
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 20 && r.height > 16 && s.display !== 'none' && s.visibility !== 'hidden'
          && r.top < innerHeight && r.left < innerWidth && r.bottom > 0 && r.right > 0;
      };
      const detailDialogs = [...document.querySelectorAll('[role="dialog"], [data-state="open"], section, div')]
        .filter(visible)
        .map(el => {
          const r = el.getBoundingClientRect();
          const text = clean(el.innerText || el.textContent || '');
          const score = (/\bElement\b/i.test(text) ? 25 : 0)
            + (/\bStatus\b/i.test(text) ? 25 : 0)
            + (/\bType\b/i.test(text) ? 25 : 0)
            + (/\bFolders\b/i.test(text) ? 20 : 0)
            + (r.width >= 650 && r.height >= 360 ? 15 : 0)
            - (/\bMy Elements\b/i.test(text) && /\bShow subfolders elements\b/i.test(text) ? 30 : 0);
          return { el, r, text, score };
        })
        .filter(o => o.score >= 60)
        .sort((a, b) => b.score - a.score || (b.r.width * b.r.height) - (a.r.width * a.r.height));
      const dialog = detailDialogs[0]?.el || null;
      if (!dialog) return null;
      const dr = dialog.getBoundingClientRect();
      const buttons = [...dialog.querySelectorAll('button, [role="button"], div, span')]
        .filter(visible)
        .map(el => {
          const r = el.getBoundingClientRect();
          const text = clean(el.innerText || el.textContent || '');
          const tag = String(el.tagName || '').toLowerCase();
          const role = el.getAttribute('role') || '';
          const exact = text.toLowerCase() === wanted;
          const nearBottom = (r.y + r.height / 2) > dr.y + dr.height * 0.72;
          const score = (exact ? 80 : 0)
            + (nearBottom ? 35 : 0)
            + ((tag === 'button' || role === 'button') ? 20 : 0);
          return { text, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), score };
        })
        .filter(o => o.text.toLowerCase() === wanted && o.score >= 80)
        .sort((a, b) => b.score - a.score || b.y - a.y);
      return buttons[0] || null;
    }, label).catch(() => null);
  }

  async _closeOpenElementDetail() {
    const page = this.automation.page;
    const close = await page.evaluate(() => {
      const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 12 && r.height > 12 && s.display !== 'none' && s.visibility !== 'hidden'
          && r.top < innerHeight && r.left < innerWidth && r.bottom > 0 && r.right > 0;
      };
      const dialogs = [...document.querySelectorAll('[role="dialog"], [data-state="open"], section, div')]
        .filter(visible)
        .map(el => {
          const r = el.getBoundingClientRect();
          const text = clean(el.innerText || el.textContent || '');
          const score = (/\bElement\b/i.test(text) ? 25 : 0)
            + (/\bStatus\b/i.test(text) ? 25 : 0)
            + (/\bType\b/i.test(text) ? 25 : 0)
            + (r.width >= 650 && r.height >= 360 ? 15 : 0);
          return { el, r, score };
        })
        .filter(o => o.score >= 60)
        .sort((a, b) => b.score - a.score);
      const dialog = dialogs[0];
      if (!dialog) return null;
      const buttons = [...dialog.el.querySelectorAll('button, [role="button"], svg, div, span')]
        .filter(visible)
        .map(el => {
          const r = el.getBoundingClientRect();
          const text = clean(el.innerText || el.textContent || '');
          const aria = clean(el.getAttribute?.('aria-label') || el.getAttribute?.('title') || '');
          const cx = r.x + r.width / 2;
          const cy = r.y + r.height / 2;
          const topRight = cx > dialog.r.x + dialog.r.width * 0.88 && cy < dialog.r.y + dialog.r.height * 0.16;
          const score = (topRight ? 70 : 0)
            + (/close|dismiss/i.test(`${text} ${aria}`) ? 40 : 0)
            + (r.width <= 60 && r.height <= 60 ? 20 : 0);
          return { x: Math.round(cx), y: Math.round(cy), score };
        })
        .filter(o => o.score >= 80)
        .sort((a, b) => b.score - a.score);
      return buttons[0] || null;
    }).catch(() => null);
    if (close) {
      await page.mouse.click(close.x, close.y);
      await page.waitForTimeout(900);
      return true;
    }
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(600);
    return false;
  }

  async _openElementDetailFromCard(name, card) {
    const page = this.automation.page;
    await this._hoverElementCardControls(card);
    const menu = await this._findElementCardMenuButton(card);
    if (!menu) throw new Error(`Could not find hover-revealed card menu button for @${String(name).replace(/^@/, '')}`);
    this.log(`Opening element detail for @${String(name).replace(/^@/, '')} via card menu at (${menu.x}, ${menu.y})`);
    await page.mouse.click(menu.x, menu.y);
    await page.waitForTimeout(900);
    const viewItem = await this._findOpenMenuItem('View');
    if (!viewItem) throw new Error(`View menu item not found for @${String(name).replace(/^@/, '')}`);
    await page.mouse.click(viewItem.x, viewItem.y);
    await page.waitForTimeout(1500);
    const detail = await this._readOpenElementDetailProof(name);
    if (!detail.open) throw new Error(`Element detail modal did not open for @${String(name).replace(/^@/, '')}`);
    return detail;
  }

  async _confirmElementDeleteIfNeeded() {
    const page = this.automation.page;
    const confirm = await page.evaluate(() => {
      const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 20 && r.height > 16 && s.display !== 'none' && s.visibility !== 'hidden'
          && r.top < innerHeight && r.left < innerWidth && r.bottom > 0 && r.right > 0;
      };
      const dialogs = [...document.querySelectorAll('[role="dialog"], [data-state="open"], div')]
        .filter(visible)
        .map(el => ({ el, r: el.getBoundingClientRect(), text: clean(el.innerText || el.textContent || '') }))
        .filter(o =>
          o.r.width >= 240 && o.r.height >= 100
          && /delete|remove|sure/i.test(o.text)
          && !/View Pin Edit Move to Copy to Share Delete/i.test(o.text)
        )
        .sort((a, b) => (a.r.width * a.r.height) - (b.r.width * b.r.height));
      for (const dialog of dialogs) {
        const buttons = [...dialog.el.querySelectorAll('button, [role="button"]')]
          .filter(visible)
          .map(el => {
            const r = el.getBoundingClientRect();
            const text = clean(el.innerText || el.textContent || '');
            return { text, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: r.width, h: r.height };
          })
          .filter(b => /^(Delete|Confirm|Yes|Remove)$/i.test(b.text))
          .sort((a, b) => b.y - a.y || b.x - a.x);
        if (buttons[0]) return buttons[0];
      }
      return null;
    }).catch(() => null);
    if (!confirm) return false;
    await page.mouse.click(confirm.x, confirm.y);
    await page.waitForTimeout(1500);
    return true;
  }

  async _waitForElementDeleted(name, timeoutMs = 45000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const remaining = timeoutMs - (Date.now() - start);
      const card = await this._waitForElementCard(name, Math.min(12000, Math.max(3000, remaining))).catch(() => null);
      if (!card) return true;
      this.log(`Element @${String(name).replace(/^@/, '')} still visible after delete; waiting...`);
      await this.automation.page.waitForTimeout(2500);
    }
    return false;
  }

  async deleteElementFromPicker(name, options = {}) {
    const normalized = String(name || '').trim().replace(/^@/, '');
    if (!normalized) throw new Error('deleteElementFromPicker: element name required');
    const requireNotEligible = options.requireNotEligible !== false;
    const page = this.automation.page;
    this.invalidateElementEligibility(normalized);
    await this._closePickerAndReturnToComposer().catch(() => {});
    await this._ensureElementsPickerOpen();
    const searchFiltered = await this._setElementsPickerSearch(normalized).catch(() => false);
    if (searchFiltered) this.log(`Filtered Elements picker to @${normalized} before delete confirmation`);
    const card = await this._waitForElementCard(normalized, 45000);
    if (!card) {
      this.log(`Element @${normalized} not visible for delete; treating as already absent`);
      await this._clearElementsPickerSearch().catch(() => {});
      await this._closePickerAndReturnToComposer().catch(() => {});
      return { deleted: false, alreadyMissing: true, proof: null };
    }
    await this._centerElementCardInPicker(normalized).catch(() => null);
    const centeredCard = await this._findElementCard(normalized).catch(() => null) || card;
    await this._hoverElementCardControls(centeredCard);
    const proof = await this._snapshotElementCardProof(centeredCard).catch(() => ({}));
    const proofText = proof?.text ? ` proof="${proof.text.slice(0, 180)}"` : '';
    const cardStatus = await this._readElementCardStatus(centeredCard, {
      hoverMs: 1000,
      useFallbackStatus: false,
    }).catch(() => 'unknown');
    if (requireNotEligible && cardStatus !== 'not-eligible') {
      await this._clearElementsPickerSearch().catch(() => {});
      await this._closePickerAndReturnToComposer().catch(() => {});
      throw new Error(`Refusing to delete @${normalized}: card status is ${cardStatus || 'unknown'}, not not-eligible${proofText}`);
    }

    const detail = await this._openElementDetailFromCard(normalized, centeredCard);
    if (detail.nameNormalized !== normalized.toLowerCase()) {
      await this._closeOpenElementDetail().catch(() => {});
      await this._clearElementsPickerSearch().catch(() => {});
      await this._closePickerAndReturnToComposer().catch(() => {});
      throw new Error(`Refusing to delete @${normalized}: View modal confirmed "${detail.name || detail.nameNormalized || 'unknown'}"`);
    }

    const deleteButton = await this._findOpenElementDetailButton('Delete');
    if (!deleteButton) {
      await this._closeOpenElementDetail().catch(() => {});
      await this._clearElementsPickerSearch().catch(() => {});
      await this._closePickerAndReturnToComposer().catch(() => {});
      throw new Error(`Detail modal Delete button not found for @${normalized}`);
    }
    this.log(`Deleting element @${normalized} from confirmed detail modal (status=${cardStatus})${proofText}`);
    await page.mouse.click(deleteButton.x, deleteButton.y);
    await page.waitForTimeout(1000);
    await this._confirmElementDeleteIfNeeded();
    await page.waitForTimeout(2500);
    await this._ensureElementsPickerOpen().catch(() => false);
    const gone = await this._waitForElementDeleted(normalized, 45000);
    await this._clearElementsPickerSearch().catch(() => {});
    await this._closePickerAndReturnToComposer().catch(() => {});
    if (!gone) throw new Error(`Element @${normalized} was still visible after delete`);
    this.invalidateElementEligibility(normalized);
    return { deleted: true, alreadyMissing: false, proof: { ...proof, cardStatus, detail } };
  }

  async isElementVisibleInPicker(name) {
    await this._closePickerAndReturnToComposer().catch(() => {});
    await this._ensureElementsPickerOpen();
    const card = await this._waitForElementCard(name, 45000);
    const proof = card ? await this._snapshotElementCardProof(card).catch(() => ({})) : {};
    await this._closePickerAndReturnToComposer().catch(() => {});
    return { exists: !!card, proof };
  }

  _parseCinemaCreditRowsFromText(text) {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const parseCost = (value) => {
      const m = normalize(value).match(/([+-]?\s*\d+(?:[.,]\d+)?)\s+credits/i);
      if (!m) return null;
      const n = parseFloat(m[1].replace(/\s+/g, '').replace(/,/g, '.'));
      return Number.isFinite(n) ? n : null;
    };
    const parseDateText = (value) => {
      const normalized = normalize(value)
        .replace(/(\d{4})(\d{1,2}:\d{2}\s*(?:AM|PM))/i, '$1 $2');
      const m = normalized.match(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\s+\d{1,2},\s+\d{4}\s+\d{1,2}:\d{2}\s*(?:AM|PM)\b/i);
      return m ? m[0] : null;
    };
    const rows = [];
    const wholeText = normalize(text);
    const pattern = /([+-]?\s*\d+(?:[.,]\d+)?\s+credits)\s+(Cinematic\s+Studio\s+3\.5\s+Video|Cinema\s+Studio\s+3\.5\s+Video)\s+(Spent|Refunded)\s+((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\s+\d{1,2},\s+\d{4}\s*\d{1,2}:\d{2}\s*(?:AM|PM))/ig;
    for (const match of wholeText.matchAll(pattern)) {
      const action = normalize(match[3]);
      if (!/^spent$/i.test(action)) continue;
      const dateText = parseDateText(match[4]);
      const rowText = normalize(match[0]);
      rows.push({
        text: rowText,
        signature: rowText.toLowerCase(),
        cost: parseCost(match[1]),
        dateText,
        source: 'text-scan',
      });
    }
    return rows;
  }

  async _readCinemaCreditRows(ledgerPage) {
    return ledgerPage.evaluate(() => {
      const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim();
      const parseCost = (text) => {
        const m = text.match(/([+-]?\s*\d+(?:[.,]\d+)?)\s+credits/i);
        if (!m) return null;
        const n = parseFloat(m[1].replace(/\s+/g, '').replace(/,/g, '.'));
        return Number.isFinite(n) ? n : null;
      };
      const parseDateText = (text) => {
        const normalized = normalize(text).replace(/(\d{4})(\d{1,2}:\d{2}\s*(?:AM|PM))/i, '$1 $2');
        const m = normalized.match(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\s+\d{1,2},\s+\d{4}\s+\d{1,2}:\d{2}\s*(?:AM|PM)\b/i);
        return m ? m[0] : null;
      };
      const isCinemaFeature = (text) => /\bCinematic\s+Studio\s+3\.5\s+Video\b/i.test(text)
        || /\bCinema\s+Studio\s+3\.5\s+Video\b/i.test(text);
      const rows = [];
      const seen = new Set();
      const candidates = [
        ...document.querySelectorAll('tr'),
        ...document.querySelectorAll('[role="row"], tbody > *, [class*="row"], [class*="history"] > *'),
      ];
      for (const el of candidates) {
        const text = normalize(el.innerText || el.textContent || '');
        if (!text || seen.has(text)) continue;
        seen.add(text);
        if (!isCinemaFeature(text) || !/\bspent\b/i.test(text) || !/credits/i.test(text)) continue;
        const cells = [...el.querySelectorAll('td, [role="cell"], th')].map(cell => normalize(cell.innerText || cell.textContent || ''));
        const rowText = cells.length >= 4 ? normalize(cells.slice(0, 4).join(' ')) : text;
        const actionText = cells.length >= 3 ? cells[2] : text;
        if (!/\bspent\b/i.test(actionText) || /\brefunded\b/i.test(actionText)) continue;
        rows.push({
          text: rowText,
          signature: rowText.toLowerCase(),
          cost: parseCost(cells[0] || text),
          dateText: parseDateText(cells[3] || text),
          source: cells.length >= 4 ? 'table-cells' : 'dom',
        });
      }
      return rows;
    });
  }

  async _readCinemaCreditLedger(context, waitMs = 15000) {
    const ledgerPage = await context.newPage();
    try {
      await ledgerPage.goto('https://higgsfield.ai/me/settings/credits-usage', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await ledgerPage.waitForTimeout(waitMs);
      await this._scrollCreditLedgerToHistory(ledgerPage);
      await ledgerPage.waitForTimeout(5000);
      let rows = await this._readCinemaCreditRows(ledgerPage);
      if (!rows.length) {
        const pageText = await ledgerPage.evaluate(() => document.body?.innerText || document.body?.textContent || '').catch(() => '');
        rows = this._parseCinemaCreditRowsFromText(pageText);
      }
      const seen = new Set();
      return rows.filter(row => {
        if (!row || !row.signature || seen.has(row.signature)) return false;
        seen.add(row.signature);
        return true;
      });
    } finally {
      await ledgerPage.close().catch(() => {});
    }
  }

  async _detectCinemaGenerationInProgress(page) {
    if (!page) return { active: false, evidence: null };
    try {
      return await page.evaluate(() => {
        const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim();
        const visible = (el) => {
          const r = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
            && r.top < window.innerHeight && r.bottom > 0 && r.left < window.innerWidth && r.right > 0;
        };

        const elements = [...document.querySelectorAll('button, [role="button"], [role="status"], [aria-live], div, span')];
        for (const el of elements) {
          if (!visible(el)) continue;
          const text = normalize(el.innerText || el.textContent || '');
          if (/^(processing|generating)$/i.test(text) || /\b(processing|generating)\b/i.test(text)) {
            return { active: true, evidence: text.slice(0, 120) };
          }
        }
        return { active: false, evidence: null };
      });
    } catch (err) {
      return { active: false, evidence: `check failed: ${err.message}` };
    }
  }

  async _detectCinemaGenerationLifecycle(page) {
    if (!page) return { state: 'unknown', evidence: 'no page' };
    try {
      return await page.evaluate(() => {
        const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const visible = (el) => {
          const r = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
            && r.top < window.innerHeight && r.bottom > 0 && r.left < window.innerWidth && r.right > 0;
        };
        const interesting = [...document.querySelectorAll('button, [role="button"], [role="status"], [aria-live], div, span')]
          .filter(visible)
          .map(el => ({
            text: normalize(el.innerText || el.textContent || ''),
            tag: el.tagName || '',
          }))
          .filter(item => item.text);

        for (const item of interesting) {
          if (/^(processing|generating)$/i.test(item.text) || /\b(processing|generating)\b/i.test(item.text)) {
            return { state: 'active', evidence: item.text.slice(0, 160) };
          }
        }

        for (const item of interesting) {
          const lower = item.text.toLowerCase();
          const failed = /\bfailed\b/.test(lower) || /please try again/i.test(item.text);
          const refunded = /credits?\s+refunded/i.test(item.text) || /\brefunded\b/i.test(lower);
          if (failed && refunded) {
            return { state: 'failed_refunded', evidence: item.text.slice(0, 220) };
          }
        }

        const videoTiles = [...document.querySelectorAll('video, video source, img')]
          .filter(el => {
            const r = el.getBoundingClientRect();
            if (!visible(el)) return false;
            if (r.width < 140 || r.height < 140) return false;
            return r.top > 60;
          });
        if (videoTiles.length > 0) {
          return { state: 'settled', evidence: `${videoTiles.length} visible media tile(s), no Processing/Generating/Failed-refunded label` };
        }

        return { state: 'unknown', evidence: null };
      });
    } catch (err) {
      return { state: 'unknown', evidence: `check failed: ${err.message}` };
    }
  }

  async _waitForCinemaGenerationAccepted(page, timeoutMs = 90000) {
    const started = Date.now();
    let attempt = 0;
    while (Date.now() - started < timeoutMs) {
      await this.automation.assertNoVerificationRequired?.('post-Generate acceptance wait');
      const state = await this._detectCinemaGenerationInProgress(page);
      if (state.active) {
        this.log(`Cinema Studio generation accepted by UI state (${state.evidence || 'Processing'})`);
        return state;
      }
      const waitMs = this._progressiveWaitMs(attempt, { min: 1200, max: 6000, step: 600 });
      if (attempt === 0 || attempt % 5 === 4) {
        this.log(`Waiting for Cinema Studio Processing/Generating state (${Math.round((Date.now() - started) / 1000)}s)`);
      }
      await page.waitForTimeout(waitMs);
      attempt++;
    }
    return { active: false, evidence: null };
  }

  async _confirmCinemaCreditSpend({ expectedCost, clickedAt, timeoutMs = 90000, baselineSignatures = [], generationPage = null } = {}) {
    const context = this.automation.page?.context();
    if (!context) throw new Error('Browser context not ready for Cinema Studio credit ledger confirmation');

    const baseline = new Set(baselineSignatures || []);
    const expected = Number.isFinite(expectedCost) ? expectedCost : null;
    const started = Date.now();
    let uiAccepted = false;
    let uiEvidence = null;
    await new Promise(resolve => setTimeout(resolve, 10000));
    while (Date.now() - started < timeoutMs) {
      try {
        await this.automation.assertNoVerificationRequired?.('Cinema credit ledger confirmation');
        const uiState = await this._detectCinemaGenerationInProgress(generationPage);
        if (uiState.active && !uiAccepted) {
          uiAccepted = true;
          uiEvidence = uiState.evidence || 'Processing';
          this.log(`Cinema Studio generation accepted by UI state (${uiEvidence}); waiting for matching credit ledger row`);
        }

        const rows = await this._readCinemaCreditLedger(context, 15000);
        const rejectCounts = {};
        const matchingRows = rows.filter(row => {
          const reject = (reason) => {
            rejectCounts[reason] = (rejectCounts[reason] || 0) + 1;
            return false;
          };
          if (baseline.has(row.signature)) return reject('baseline');
          if (!row.dateText) return reject('no-date');
          if (expected !== null && row.cost !== null && Math.abs(row.cost - expected) > 0.02) return reject('cost');
          const rowTime = this._parseCreditLedgerDate(row.dateText);
          if (!Number.isFinite(rowTime)) return reject('date-parse');
          const lowerBound = clickedAt.getTime() - (2 * 60 * 1000);
          const upperBound = clickedAt.getTime() + (20 * 60 * 1000);
          if (rowTime < lowerBound || rowTime > upperBound) return reject('time-window');
          return true;
        });

        if (matchingRows.length > 0) {
          const row = matchingRows[0];
          this.log(`Credit ledger confirmed Cinema Studio spend: ${row.cost ?? 'unknown'} credits (${row.dateText}, ${row.source || 'dom'})`);
          return { ok: true, accepted: uiAccepted, ledgerConfirmed: true, uiEvidence, row };
        }

        const newest = rows.find(row => !baseline.has(row.signature) && row.dateText) || rows.find(row => row.dateText);
        const newestHint = newest ? `; newest=${newest.cost ?? '?'} @ ${newest.dateText} (${newest.source || 'dom'})` : '';
        this.log(`Credit ledger not matched yet (${rows.length} Cinema Studio row(s), rejects=${JSON.stringify(rejectCounts)}${newestHint}) — polling...`);
      } catch (ledgerErr) {
        if (ledgerErr.code === 'HIGGSFIELD_VERIFICATION_REQUIRED' || ledgerErr.message?.includes('HIGGSFIELD_VERIFICATION_REQUIRED')) {
          throw ledgerErr;
        }
        this.log(`Cinema Studio credit ledger check failed (${ledgerErr.message}) — polling...`, 'warn');
      }
      await new Promise(resolve => setTimeout(resolve, 5000));
    }

    const finalUiState = await this._detectCinemaGenerationInProgress(generationPage);
    if (finalUiState.active) {
      uiAccepted = true;
      uiEvidence = uiEvidence || finalUiState.evidence || 'Processing';
      this.log(`Cinema Studio generation still visible in UI (${uiEvidence}), but no matching credit ledger row was found`);
    }
    return {
      ok: false,
      accepted: uiAccepted,
      ledgerConfirmed: false,
      uiEvidence,
      reason: uiAccepted
        ? `Processing/Generating appeared in UI (${uiEvidence}), but no matching Cinema Studio credit row appeared within ${Math.round(timeoutMs / 1000)}s`
        : `No matching Cinema Studio credit row or Processing state appeared within ${Math.round(timeoutMs / 1000)}s`,
    };
  }

  async _captureCinemaSubmitDiagnostics(page, label = 'submit') {
    try {
      if (!page || page.isClosed?.()) return { label, pageClosed: true };
      return await page.evaluate((diagLabel) => {
        const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const visible = (el) => {
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'
            && r.top < innerHeight && r.bottom > 0 && r.left < innerWidth && r.right > 0;
        };
        const buttons = [...document.querySelectorAll('button, [role="button"]')]
          .filter(visible)
          .map(el => clean(el.innerText || el.textContent || el.getAttribute('aria-label') || ''))
          .filter(Boolean)
          .slice(0, 24);
        const iframes = [...document.querySelectorAll('iframe')]
          .map(frame => ({
            src: frame.src || '',
            title: frame.title || '',
            visible: visible(frame),
          }))
          .slice(0, 8);
        const text = clean(document.body?.innerText || document.body?.textContent || '');
        return {
          label: diagLabel,
          url: location.href,
          title: document.title,
          bodySnippet: text.slice(0, 700),
          hasVerificationText: /Verification Required|Slide right to secure your access|unusual activity/i.test(text),
          buttons,
          iframes,
        };
      }, label);
    } catch (err) {
      return { label, error: err.message };
    }
  }

  async _generateAndDownload(outputPath, durationSeconds, onGenClicked, onVerificationRequired) {
    const page = this.automation.page;
    await this._assertCurrentCinemaProjectUrl('before Generate');
    const initialFirstSrc = await page.evaluate(() => document.querySelector('video[src*="cloudfront"], video source[src*="cloudfront"]')?.src || null);
    const expectedDuration = this._selectedDuration || '15s';
    const expectedResolution = this._selectedResolution || '480p';
    let audioValue = await this._getBottomToolbarValue(/^(On|Off)$/i);
    if (/^Off$/i.test(audioValue || '')) {
      this.log('[CINEMA-VIDEO] Audio drifted Off before Generate; switching back On');
      await this._ensureAudioOn();
      audioValue = await this._getBottomToolbarValue(/^(On|Off)$/i);
    }
    const preGenCheck = await page.evaluate(({ targetAspect, elementEligibility, expectedDuration, expectedResolution, audioValue }) => {
      const issues = [];
      const body = document.body?.innerText || '';
      const toolbarText = (() => {
        for (const el of document.querySelectorAll('div, section, form')) {
          const r = el.getBoundingClientRect();
          const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
          if (r.width > 250 && r.height > 20 && r.y > window.innerHeight * 0.50 && /Cinema Studio 3\.5/i.test(t) && !/Nano Banana/i.test(t)) {
            return t;
          }
        }
        return '';
      })();
      const textbox = document.querySelector('[role="textbox"]');
      const promptText = textbox ? (textbox.innerText || textbox.textContent || '').trim() : '';
      if (!/Cinema Studio 3\.5/i.test(body)) issues.push('Cinema Studio 3.5 model not detected');
      if (!toolbarText.includes(expectedDuration)) issues.push(`${expectedDuration} duration not detected`);
      if (!toolbarText.includes(expectedResolution)) issues.push(`${expectedResolution} resolution not detected`);
      if (!toolbarText.includes(targetAspect)) issues.push(`${targetAspect} aspect not detected`);
      if (!/^On$/i.test(String(audioValue || ''))) issues.push(`Audio On not detected (current=${audioValue || 'unknown'})`);
      if (promptText.length < 20) issues.push(`Prompt too short or empty (${promptText.length} chars)`);
      const tbRect = textbox ? textbox.getBoundingClientRect() : null;
      const imgs = [...document.querySelectorAll('img')].filter(img => {
        const r = img.getBoundingClientRect();
        const src = String(img.currentSrc || img.src || '');
        if (!/^(https?:|blob:|data:image\/)/i.test(src)) return false;
        if (!(r.width > 25 && r.width < 180 && r.height > 25 && r.height < 180 && r.y > window.innerHeight * 0.45)) return false;
        if (!tbRect) return true;
        const centerX = r.x + r.width / 2;
        const centerY = r.y + r.height / 2;
        return centerX > tbRect.x - 120
          && centerX < tbRect.x + tbRect.width + 120
          && centerY > tbRect.y - 180
          && centerY < tbRect.y + tbRect.height + 120;
      });
      const requiredElements = elementEligibility?.required || [];
      const eligibleElements = new Set((elementEligibility?.eligible || []).map(name => String(name).toLowerCase()));
      const missingEligible = requiredElements.filter(name => !eligibleElements.has(String(name).toLowerCase()));
      if (missingEligible.length > 0) {
        issues.push(`Required element eligibility not confirmed: ${missingEligible.join(', ')}`);
      }
      const expectedTiles = Math.max(1, Number(elementEligibility?.expectedReferenceTiles) || (1 + new Set(requiredElements.map(name => String(name).toLowerCase())).size));
      if (imgs.length < expectedTiles) {
        issues.push(`Composer reference tiles incomplete: ${imgs.length}/${expectedTiles}`);
      }
      return { ok: issues.length === 0, issues, promptLength: promptText.length };
    }, {
      targetAspect: this._targetAspect || '16:9',
      elementEligibility: this._lastClipElementEligibility || { required: [], eligible: [] },
      expectedDuration,
      expectedResolution,
      audioValue,
    });
    if (!preGenCheck.ok) {
      throw new Error(`[PRE-GEN] Pre-generation check failed: ${preGenCheck.issues.join('; ')}`);
    }

    await this._assertCinemaPromptComplete(this._expectedCinemaPromptText);

    let acceptedState = null;
    let creditConfirmation = null;
    let creditCost = null;
    let submitAttempt = 0;
    const maxSubmitAttempts = 3;

    while (true) {
      submitAttempt++;
      try {
        await this.automation.assertNoVerificationRequired?.(`before Cinema submit attempt ${submitAttempt}`);
        await this._waitForCinemaEndpointQuietPeriod({
          quietMs: 10000,
          timeoutMs: 30000,
          label: submitAttempt === 1 ? 'usage baseline' : `usage baseline after verification ${submitAttempt}`,
        });

        let genBtnBox;
        ({ genBtnBox, creditCost } = await this._readGenerateButtonWithCreditCost({ timeoutMs: 20000, expectedMaxCost: 70 }));

        let baselineLedgerSignatures = [];
        this._cinemaGeneratePhase = 'baseline';
        try {
          const baselineRows = await this._readCinemaCreditLedger(page.context(), 15000);
          baselineLedgerSignatures = baselineRows.map(row => row.signature);
          this.log(`Credit ledger baseline captured (${baselineLedgerSignatures.length} Cinema Studio row(s))`);
        } catch (ledgerErr) {
          this.log(`Warn: could not capture credit ledger baseline before click: ${ledgerErr.message}`, 'warn');
        }

        await this._waitForCinemaEndpointQuietPeriod({ quietMs: 5000, timeoutMs: 15000, label: 'intentional Generate click' });
        await this._dismissLowCreditToast('intentional Generate click');
        ({ genBtnBox, creditCost } = await this._readGenerateButtonWithCreditCost({ timeoutMs: 8000, expectedMaxCost: 70 }));
        await this._assertGenerateClickPointClear(genBtnBox);
        this._cinemaGeneratePhase = 'readyToGenerate';
        await this._disarmCinemaGenerationEndpointBlocker();
        await this._allowNextGenerateClick();
        const clickedAt = new Date();
        this._cinemaGeneratePhase = 'intentionalGenerate';
        await page.mouse.click(genBtnBox.x, genBtnBox.y);
        this._cinemaGeneratePhase = 'postGenerate';
        await this._setGenerateSafetyLock(true);
        this.log(`GENERATE clicked once at ${clickedAt.toLocaleTimeString()} - confirming Cinema Studio credit ledger`);

        acceptedState = await this._waitForCinemaGenerationAccepted(page, 45000);
        creditConfirmation = await this._confirmCinemaCreditSpend({
          expectedCost: creditCost,
          clickedAt,
          timeoutMs: acceptedState.active ? 120000 : 35000,
          baselineSignatures: baselineLedgerSignatures,
          generationPage: page,
        });
        if (!creditConfirmation.ok) {
          if (acceptedState.active || creditConfirmation.accepted) {
            this.log(`Warn: Cinema Studio UI accepted generation but ledger spend was not confirmed (${creditConfirmation.reason}). Continuing without retry to avoid double-spend.`, 'warn');
          } else {
            const diagnostics = await this._captureCinemaSubmitDiagnostics(page, `not-submitted attempt ${submitAttempt}`);
            this.log(`[CINEMA-VIDEO] Submit attempt ${submitAttempt} did not produce Processing or ledger spend; treating as not submitted. Diagnostics: ${JSON.stringify(diagnostics).slice(0, 1600)}`, 'warn');
            if (submitAttempt < maxSubmitAttempts) {
              await page.waitForTimeout(5000);
              continue;
            }
            throw new Error(`[PRE-GEN] Generate click was not submitted after ${maxSubmitAttempts} attempts (${creditConfirmation.reason})`);
          }
        }
        if (creditConfirmation.ok && typeof onGenClicked === 'function') {
          try { onGenClicked(creditCost); } catch (_) {}
        }
        break;
      } catch (submitErr) {
        if ((submitErr.code === 'HIGGSFIELD_VERIFICATION_REQUIRED' || submitErr.message?.includes('HIGGSFIELD_VERIFICATION_REQUIRED')) && typeof onVerificationRequired === 'function') {
          this.log(`[CINEMA-VIDEO] Higgsfield verification interrupted submit attempt ${submitAttempt}; waiting for manual slider completion, then resuming at usage baseline`, 'warn');
          await this._setGenerateSafetyLock(true).catch(() => {});
          await onVerificationRequired({ message: submitErr.message, attempt: submitAttempt });
          await this.automation.assertNoVerificationRequired?.(`after verification submit attempt ${submitAttempt}`);
          continue;
        }
        throw submitErr;
      }
    }

    const maxWaitMs = 12 * 60 * 1000;
    const minEarlyRecoveryMs = 4 * 60 * 1000;
    const pollMs = 60 * 1000;
    const startedAt = Date.now();
    let settledPolls = 0;
    this.log(`Cinema Studio generation submitted; polling UI lifecycle up to ${Math.round(maxWaitMs / 60000)}min before Asset Library recovery (direct UI video-source download disabled for identity safety)`);
    let lastSeenSrc = initialFirstSrc;
    while (Date.now() - startedAt < maxWaitMs) {
      await page.waitForTimeout(pollMs);
      const elapsedMs = Date.now() - startedAt;
      const lifecycle = await this._detectCinemaGenerationLifecycle(page);
      if (lifecycle.state === 'failed_refunded') {
        throw new CinemaRefundedFailureError(`CINEMA_REFUNDED_FAILURE: Cinema Studio failed and credits were refunded (${lifecycle.evidence || 'visible failure state'})`, lifecycle.evidence);
      }
      if (lifecycle.state === 'active') {
        settledPolls = 0;
        this.log(`[CINEMA-VIDEO] Generation still active after ${Math.round(elapsedMs / 1000)}s (${lifecycle.evidence || 'Processing/Generating'})`);
      } else if (elapsedMs >= minEarlyRecoveryMs && lifecycle.state === 'settled') {
        settledPolls++;
        this.log(`[CINEMA-VIDEO] UI appears settled after ${Math.round(elapsedMs / 1000)}s (${settledPolls}/2): ${lifecycle.evidence || 'no active label'}`);
        if (settledPolls >= 2) {
          throw new Error(`Timeout waiting for Cinema Studio 3.5 generation (${Math.round(elapsedMs / 1000)}s; UI settled early for Asset Library recovery)`);
        }
      } else {
        settledPolls = 0;
        this.log(`[CINEMA-VIDEO] Waiting for generation lifecycle (${Math.round(elapsedMs / 1000)}s, state=${lifecycle.state}${lifecycle.evidence ? `, evidence=${lifecycle.evidence}` : ''})`);
      }
      const currentFirstSrc = await page.evaluate(() => document.querySelector('video[src*="cloudfront"], video source[src*="cloudfront"]')?.src || null).catch(() => null);
      if (currentFirstSrc && currentFirstSrc !== initialFirstSrc) {
        if (currentFirstSrc !== lastSeenSrc) {
          lastSeenSrc = currentFirstSrc;
          this.log('[CINEMA-VIDEO] Candidate video source appeared during mandatory wait; ignoring direct UI source and deferring to Asset Library recovery');
        }
      }
    }
    throw new Error(`Timeout waiting for Cinema Studio 3.5 generation (${maxWaitMs / 1000}s)`);
  }

  _parseGenerateCreditCost(buttonInfo) {
    const parts = Array.isArray(buttonInfo?.textParts) ? buttonInfo.textParts : [];
    const partNumbers = [];
    for (const part of parts) {
      for (const match of String(part).matchAll(/\d+(?:[.,]\d+)?/g)) {
        const value = Number(match[0].replace(',', '.'));
        if (Number.isFinite(value)) partNumbers.push({ raw: match[0], value });
      }
    }

    const decimalPart = [...partNumbers].reverse().find(n => /[.,]/.test(n.raw));
    if (decimalPart) return decimalPart.value;

    if (partNumbers.length >= 2) {
      const [a, b] = partNumbers.slice(-2);
      if (a.value >= 1 && a.value <= 999 && b.value >= 0 && b.value < 100 && String(b.raw).length <= 2) {
        return Number(`${Math.trunc(a.value)}.${String(Math.trunc(b.value)).padStart(2, '0')}`);
      }
      return b.value;
    }

    if (partNumbers.length === 1) return partNumbers[0].value;

    const text = String(buttonInfo?.text || '').replace(/\s+/g, ' ').trim();
    const decimalMatches = [...text.matchAll(/\d+[.,]\d+/g)].map(m => Number(m[0].replace(',', '.')));
    if (decimalMatches.length) return decimalMatches[decimalMatches.length - 1];

    const tailMatch = text.match(/(\d{1,3})\s*$/);
    return tailMatch ? Number(tailMatch[1]) : null;
  }
}

module.exports = { CinemaVideoAutomation, CinemaEligibilityError, CinemaRefundedFailureError };
