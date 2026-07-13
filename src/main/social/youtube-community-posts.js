const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { YOUTUBE_STUDIO_DASHBOARD_URL } = require('../shorts/platform-profiles');
const { YouTubeStudioUploader } = require('../shorts/youtube-studio-uploader');

const YOUTUBE_COMMUNITY_PLATFORM = 'youtube_community';
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_IMAGES = 10;
const COMMUNITY_COMPOSER_WAIT = 12000;
const COMMUNITY_SCHEDULE_WAIT = 12000;

function prepareYouTubeCommunityPostJob(db, post = {}, project = {}, options = {}) {
  if (!db || typeof db.upsert !== 'function') {
    throw new Error('SocialPublishJobStore with upsert() is required');
  }

  const existing = typeof db.getForPost === 'function'
    ? db.getForPost(post.id, YOUTUBE_COMMUNITY_PLATFORM)
    : null;
  if (existing && existing.status === 'scheduled' && existing.remote_post_id) {
    const metadata = parseJson(existing.metadata_json, {});
    const mediaPaths = normalizeCommunityMediaPaths(metadata.mediaPaths || existing.media_path);
    return {
      job: existing,
      validation: parseJson(existing.validation_json, { ok: true, errors: [], warnings: [], hashtags: extractHashtags(existing.body || ''), mediaCount: mediaPaths.length }),
      caption: existing.body || buildYouTubeCommunityCaption(post, project, options),
      mediaPaths,
      status: 'scheduled',
      preserved: true,
    };
  }

  const caption = buildYouTubeCommunityCaption(post, project, options);
  const rawMediaPaths = normalizeCommunityMediaPaths(post.media_path || options.mediaPath || options.mediaPaths);
  const mediaPrep = prepareYouTubeCommunityMediaPaths(rawMediaPaths, options.mediaOptions || {});
  const mediaPaths = mediaPrep.mediaPaths;
  const validationOptions = {
    ...(options.validationOptions || {}),
    maxImageBytes: (options.validationOptions && options.validationOptions.maxImageBytes) || mediaPrep.maxImageBytes,
  };
  const validation = validateYouTubeCommunityPost({
    caption,
    mediaPaths,
    scheduledDate: options.scheduledDate || post.scheduled_date,
    scheduledTime: options.scheduledTime || post.scheduled_time,
  }, validationOptions);
  if (mediaPrep.warnings.length > 0) validation.warnings.push(...mediaPrep.warnings);
  if (mediaPrep.errors.length > 0) {
    validation.errors.push(...mediaPrep.errors);
    validation.ok = false;
  }
  if (mediaPrep.conversions.length > 0) validation.conversions = mediaPrep.conversions;

  const status = validation.ok ? 'ready' : 'blocked';
  const job = db.upsert({
    social_post_id: post.id,
    platform: YOUTUBE_COMMUNITY_PLATFORM,
    status,
    scheduled_date: options.scheduledDate || post.scheduled_date || null,
    scheduled_time: options.scheduledTime || post.scheduled_time || null,
    title: rewriteYouTubeCommunityTitle(post.title, project),
    body: caption,
    hashtags_json: JSON.stringify(validation.hashtags),
    media_path: mediaPaths[0] || null,
    metadata_json: {
      projectId: post.project_id || project.id || null,
      postType: post.post_type || null,
      sourceShortId: post.short_id || null,
      mediaPaths,
      originalMediaPaths: rawMediaPaths,
      mediaConversions: mediaPrep.conversions,
    },
    validation_json: validation,
    error_message: validation.ok ? null : validation.errors.join('; '),
  });

  return { job, validation, caption, mediaPaths, status };
}

function prepareYouTubeCommunityMediaPaths(value, options = {}) {
  const mediaPaths = normalizeCommunityMediaPaths(value);
  const maxImageBytes = Number(options.maxImageBytes || MAX_IMAGE_BYTES);
  const result = {
    mediaPaths: [],
    conversions: [],
    warnings: [],
    errors: [],
    maxImageBytes,
  };

  for (const mediaPath of mediaPaths) {
    let finalPath = mediaPath;
    try {
      const ext = path.extname(mediaPath).toLowerCase();
      if (IMAGE_EXTENSIONS.has(ext) && fs.existsSync(mediaPath)) {
        const stat = fs.statSync(mediaPath);
        if (stat.size > maxImageBytes) {
          const converted = ensureCommunityImageDerivative(mediaPath, { ...options, maxImageBytes });
          finalPath = converted.path;
          result.conversions.push(converted);
          result.warnings.push(`Converted oversized YouTube Community image ${path.basename(mediaPath)} (${stat.size} bytes) to ${path.basename(finalPath)} (${converted.bytes} bytes)`);
        }
      }
    } catch (error) {
      result.errors.push(`YouTube Community image export failed for ${mediaPath}: ${error.message || String(error)}`);
    }
    result.mediaPaths.push(finalPath);
  }

  return result;
}

function ensureCommunityImageDerivative(mediaPath, options = {}) {
  const maxImageBytes = Number(options.maxImageBytes || MAX_IMAGE_BYTES);
  const outputPath = options.outputPath || buildCommunityDerivativePath(mediaPath, options);
  const originalBytes = fs.statSync(mediaPath).size;

  if (fs.existsSync(outputPath)) {
    const outputStat = fs.statSync(outputPath);
    const sourceStat = fs.statSync(mediaPath);
    if (outputStat.size > 0 && outputStat.size <= maxImageBytes && outputStat.mtimeMs >= sourceStat.mtimeMs) {
      return { sourcePath: mediaPath, path: outputPath, originalBytes, bytes: outputStat.size, reused: true };
    }
  }

  if (typeof options.convertImage === 'function') {
    const converted = options.convertImage(mediaPath, { outputPath, maxImageBytes, originalBytes });
    const convertedPath = converted && converted.path ? converted.path : outputPath;
    if (!fs.existsSync(convertedPath)) throw new Error(`custom converter did not create ${convertedPath}`);
    const stat = fs.statSync(convertedPath);
    if (stat.size <= maxImageBytes) {
      return { sourcePath: mediaPath, path: convertedPath, originalBytes, bytes: stat.size, custom: true, ...(converted || {}) };
    }
    throw new Error(`custom converter output is still over ${maxImageBytes} bytes: ${convertedPath}`);
  }

  const ffmpegPath = options.ffmpegPath || findCommunityFFmpegPath();
  if (!ffmpegPath) throw new Error('ffmpeg not found for oversized YouTube Community image export');

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const attempts = options.attempts || [
    { longSide: 1920, q: 4 },
    { longSide: 1600, q: 5 },
    { longSide: 1440, q: 6 },
    { longSide: 1280, q: 7 },
    { longSide: 1080, q: 8 },
    { longSide: 960, q: 10 },
  ];
  let lastError = null;
  for (const attempt of attempts) {
    try {
      exportCommunityImageWithFFmpeg(ffmpegPath, mediaPath, outputPath, attempt);
      const stat = fs.statSync(outputPath);
      if (stat.size > 0 && stat.size <= maxImageBytes) {
        return {
          sourcePath: mediaPath,
          path: outputPath,
          originalBytes,
          bytes: stat.size,
          ffmpegPath,
          longSide: attempt.longSide,
          q: attempt.q,
        };
      }
      lastError = new Error(`converted image remains over ${maxImageBytes} bytes (${stat.size})`);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error(`failed to export ${mediaPath}`);
}

function buildCommunityDerivativePath(mediaPath) {
  const parsed = path.parse(mediaPath);
  const parts = path.normalize(mediaPath).split(/[\\/]+/);
  const assetsIndex = parts.map(part => part.toLowerCase()).lastIndexOf('assets');
  const safeName = parsed.name.replace(/[^a-z0-9_.-]+/gi, '_').slice(0, 90) || 'community-image';
  const outputDir = assetsIndex >= 0
    ? path.join(parts.slice(0, assetsIndex + 1).join(path.sep), 'social', 'youtube-community')
    : path.join(parsed.dir, '.youtube-community');
  return path.join(outputDir, `${safeName}_yt_community.jpg`);
}

function findCommunityFFmpegPath() {
  for (const candidate of ['ffmpeg', 'C:\\ffmpeg\\bin\\ffmpeg.exe', 'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe']) {
    try {
      execFileSync(candidate, ['-version'], { stdio: 'ignore', timeout: 5000 });
      return candidate;
    } catch (_) {}
  }
  return null;
}

function exportCommunityImageWithFFmpeg(ffmpegPath, inputPath, outputPath, attempt = {}) {
  const longSide = Number(attempt.longSide || 1600);
  const q = Number(attempt.q || 5);
  const filter = `scale='if(gt(iw,ih),${longSide},-2)':'if(gt(iw,ih),-2,${longSide})'`;
  execFileSync(ffmpegPath, [
    '-y',
    '-i', inputPath,
    '-frames:v', '1',
    '-vf', filter,
    '-q:v', String(q),
    outputPath,
  ], { stdio: 'pipe', timeout: 45000 });
}

function parseJson(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}
function buildYouTubeCommunityCaption(post = {}, project = {}, options = {}) {
  const rawBody = String(options.body || post.body || '').trim();
  const hashtags = parseHashtags(options.hashtags ?? post.hashtags)
    .map(normalizeCommunityHashtag)
    .filter(Boolean);

  let caption = rawBody
    .replace(/\bFacebook\s+Reels?\b/ig, 'Shorts')
    .replace(/\bFacebook\b/ig, 'YouTube')
    .replace(/\bReels?\b/g, 'Shorts')
    .replace(/\breels?\b/g, 'shorts')
    .replace(/\bWatch the Reel\b/ig, 'Watch the Short')
    .replace(/\bnew Reel\b/ig, 'new Short')
    .replace(/\bthis Reel\b/ig, 'this Short')
    .replace(/\bthe Reel\b/ig, 'the Short')
    .replace(/\bFB\b/g, 'YouTube')
    .trim();

  const tagFromTitle = tagFromTitleText(project.title || '');
  const finalTags = [...new Set([
    ...hashtags,
    tagFromTitle,
    'Nollywood',
    'AfricanDrama',
  ].filter(Boolean))]
    .slice(0, 7)
    .map(tag => tag.startsWith('#') ? tag : `#${tag}`);

  for (const tag of finalTags) {
    if (!caption.toLowerCase().includes(tag.toLowerCase())) {
      caption = `${caption}\n\n${tag}`.trim();
    }
  }

  return caption;
}

function validateYouTubeCommunityPost(input = {}, options = {}) {
  const errors = [];
  const warnings = [];
  const caption = String(input.caption || '').trim();
  const mediaPaths = normalizeCommunityMediaPaths(input.mediaPaths || input.mediaPath);
  const hashtags = extractHashtags(caption);
  const maxImageBytes = Number(options.maxImageBytes || MAX_IMAGE_BYTES);

  if (!caption) errors.push('YouTube Community post caption is empty');
  if (caption.length > (options.maxCaptionChars || 1500)) {
    errors.push(`YouTube Community post caption exceeds ${options.maxCaptionChars || 1500} characters`);
  }
  if (!input.scheduledDate || !/^\d{4}-\d{2}-\d{2}$/.test(String(input.scheduledDate))) {
    errors.push('YouTube Community scheduled_date is required');
  }
  if (!input.scheduledTime || !/^\d{2}:\d{2}$/.test(String(input.scheduledTime))) {
    errors.push('YouTube Community scheduled_time is required');
  }
  if (mediaPaths.length > MAX_IMAGES) {
    errors.push(`YouTube Community image posts support up to ${MAX_IMAGES} images`);
  }

  for (const mediaPath of mediaPaths) {
    const ext = path.extname(mediaPath).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) {
      errors.push(`Unsupported YouTube Community image type: ${ext || '(none)'}`);
      continue;
    }
    if (!fs.existsSync(mediaPath)) {
      errors.push(`YouTube Community media file not found: ${mediaPath}`);
      continue;
    }
    const stat = fs.statSync(mediaPath);
    if (stat.size > maxImageBytes) {
      errors.push(`YouTube Community image exceeds ${Math.round(maxImageBytes / 1024 / 1024) || maxImageBytes} MB: ${mediaPath}`);
    }
  }

  if (/facebook/i.test(caption)) {
    warnings.push('Caption still mentions Facebook after YouTube rewrite');
  }
  if (/\breel\b/i.test(caption)) {
    warnings.push('Caption still mentions Reel after YouTube rewrite');
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    captionLength: caption.length,
    mediaCount: mediaPaths.length,
    hashtags,
  };
}

class YouTubeCommunityStudioUploader extends YouTubeStudioUploader {
  async inspectCommunityPostComposer(options = {}) {
    if (!this.page) {
      await this.launch();
    } else if (!this.channelProof || !this.channelProof.verified) {
      await this.verifyChannelContext();
    }

    const entryProof = await this._readCommunityEntryProof();
    let composerProof = null;
    if (options.openComposer === true) {
      composerProof = await this._openCommunityPostComposer(options);
      if (options.closeComposer !== false) await this._closeCommunityComposer();
    }

    return {
      success: true,
      dryRun: true,
      noPostSubmitted: true,
      dashboardUrl: this.dashboardUrl,
      channelProof: this.channelProof,
      entryProof,
      composerProof,
      proofCheckedAt: new Date().toISOString(),
    };
  }

  async scheduleCommunityPost(payload = {}, options = {}) {
    if (options.confirmSchedule !== true) {
      throw new Error('YOUTUBE_COMMUNITY_SCHEDULE_REQUIRES_CONFIRMATION: pass confirmSchedule=true for the live schedule-only proof.');
    }
    if (!payload.caption || !String(payload.caption).trim()) throw new Error('YOUTUBE_COMMUNITY_CAPTION_REQUIRED');
    if (!payload.scheduledDate || !payload.scheduledTime) throw new Error('YOUTUBE_COMMUNITY_SCHEDULE_DATE_TIME_REQUIRED');

    if (!this.page) {
      await this.launch();
    } else if (!this.channelProof || !this.channelProof.verified) {
      await this.verifyChannelContext();
    }

    const entryProof = await this._readCommunityEntryProof();
    const composerProof = await this._openCommunityPostComposer(options);
    const captionProof = await this._enterCommunityCaption(payload.caption);
    const mediaProof = await this._uploadCommunityImages(payload.mediaPaths || []);
    const scheduleMenuProof = await this._openCommunityScheduleMenu();
    const scheduleSettingsProof = await this._setCommunitySchedule(payload);
    const submitProof = await this._clickCommunityScheduleAndVerify(payload, options);

    return {
      success: true,
      scheduled: true,
      publishedNow: false,
      dashboardUrl: this.dashboardUrl,
      channelProof: this.channelProof,
      entryProof,
      composerProof,
      captionProof,
      mediaProof,
      scheduleMenuProof,
      scheduleSettingsProof,
      submitProof,
      remotePostId: submitProof.remotePostId || null,
      remoteUrl: submitProof.remoteUrl || null,
      proofCheckedAt: new Date().toISOString(),
    };
  }

  async _readCommunityEntryProof() {
    const bodyText = await this._readBodyText();
    const createButtonCount = await this._countRole('button', /Create/i);
    const createPostText = /Create post|Post/i.test(bodyText);
    return {
      hasCreateEntry: createButtonCount > 0 || createPostText,
      createButtonCount,
      createPostText,
      sampledText: bodyText.slice(0, 700),
    };
  }

  async _openCommunityPostComposer() {
    const before = await this._readCommunityComposerProof();
    if (before.hasComposer) return { ...before, alreadyOpen: true };

    const communityUrl = buildYouTubeCommunityUrl(this.dashboardUrl, this.expectedChannelId, true);
    this.log(`[YT-COMMUNITY] Navigating to Community composer: ${communityUrl}`);
    await this.page.goto(communityUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await this._waitForCommunityComposer();

    const proof = await this._readCommunityComposerProof();
    if (!proof.hasComposer) throw new Error(`YOUTUBE_COMMUNITY_COMPOSER_NOT_FOUND: ${JSON.stringify(proof)}`);
    return {
      ...proof,
      communityUrl,
      route: 'youtube-community-show-create-dialog',
    };
  }

  async _waitForCommunityComposer() {
    if (!this.page || typeof this.page.waitForFunction !== 'function') {
      await waitPage(this.page, 2000);
      return;
    }
    await this.page.waitForFunction(() => {
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 1 && rect.height > 1 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const textOf = el => (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
      const url = location.href || '';
      const isCommunityPage = /youtube\.com\/channel\/[^/]+\/community/i.test(url);
      const promptVisible = [...document.querySelectorAll('[role="button"], yt-formatted-string, div[aria-label], span[aria-label]')]
        .some(el => visible(el) && (textOf(el) === "What's on your mind?" || (el.getAttribute('aria-label') || '') === "What's on your mind?"));
      const postButtonVisible = [...document.querySelectorAll('button, [role="button"], yt-button-shape')]
        .some(el => visible(el) && (textOf(el) === 'Post' || (el.getAttribute('aria-label') || '') === 'Post'));
      const inlineComposer = isCommunityPage && promptVisible && postButtonVisible;
      const text = document.body?.innerText || '';
      const dialogs = [...document.querySelectorAll('[role="dialog"], ytcp-dialog')].filter(visible);
      const hasTextbox = [...document.querySelectorAll('[contenteditable="true"], [role="textbox"], textarea')].some(visible);
      return inlineComposer || /Post to your community|Share an update/i.test(text) || dialogs.length > 0 && hasTextbox;
    }, { timeout: COMMUNITY_COMPOSER_WAIT });
  }

  async _readCommunityComposerProof() {
    return await this.page.evaluate(() => {
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 1 && rect.height > 1 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const textOf = el => (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
      const text = document.body?.innerText || '';
      const url = location.href || '';
      const isCommunityPage = /youtube\.com\/channel\/[^/]+\/community/i.test(url);
      const promptVisible = [...document.querySelectorAll('[role="button"], yt-formatted-string, div[aria-label], span[aria-label]')]
        .some(el => visible(el) && (textOf(el) === "What's on your mind?" || (el.getAttribute('aria-label') || '') === "What's on your mind?"));
      const postButtonVisible = [...document.querySelectorAll('button, [role="button"], yt-button-shape')]
        .some(el => visible(el) && (textOf(el) === 'Post' || (el.getAttribute('aria-label') || '') === 'Post'));
      const inlineComposer = isCommunityPage && promptVisible && postButtonVisible;
      const dialogs = [...document.querySelectorAll('[role="dialog"], ytcp-dialog')].filter(visible);
      const textboxes = [...document.querySelectorAll('[contenteditable="true"], [role="textbox"], textarea')].filter(visible);
      const fileInputs = [...document.querySelectorAll('input[type="file"]')];
      const buttons = [...document.querySelectorAll('button, [role="button"], [role="menuitem"]')]
        .filter(visible)
        .map(el => (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .slice(0, 40);
      return {
        hasComposer: inlineComposer || /Post to your community|Share an update/i.test(text) || textboxes.length > 0 && dialogs.length > 0,
        dialogCount: dialogs.length,
        textboxCount: textboxes.length,
        fileInputCount: fileInputs.length,
        promptVisible,
        postButtonVisible,
        buttons,
        sampledText: text.slice(0, 900),
      };
    }).catch(() => ({ hasComposer: false, dialogCount: 0, textboxCount: 0, fileInputCount: 0, buttons: [], sampledText: '' }));
  }

  async _enterCommunityCaption(caption) {
    const promptClicked = await this._clickCommunityCaptionPrompt();
    if (promptClicked) {
      await waitPage(this.page, 500);
      await this.page.keyboard.press('Control+A').catch(() => {});
      await this.page.keyboard.press('Backspace').catch(() => {});
      await this.page.keyboard.type(String(caption), { delay: 1 });
      await waitPage(this.page, 800);
      const readback = await this._readCommunityComposerProof();
      const matched = (readback.sampledText || '').includes(String(caption).slice(0, Math.min(80, String(caption).length)));
      return { filled: true, selector: 'community-inline-prompt', promptClicked, readbackMatched: matched, length: String(caption).length, readback };
    }

    const selectors = [
      '[role="dialog"] [contenteditable="true"]',
      '[role="dialog"] [role="textbox"]',
      'ytcp-dialog [contenteditable="true"]',
      '[contenteditable="true"]',
      'textarea',
    ];
    for (const selector of selectors) {
      const locator = this.page.locator(selector).first();
      if (await locator.count().catch(() => 0)) {
        await locator.click({ timeout: 8000 });
        await this.page.keyboard.press('Control+A').catch(() => {});
        await this.page.keyboard.press('Backspace').catch(() => {});
        await this.page.keyboard.type(String(caption), { delay: 1 });
        await waitPage(this.page, 800);
        const readback = await this._readCommunityComposerProof();
        const matched = (readback.sampledText || '').includes(String(caption).slice(0, Math.min(80, String(caption).length)));
        return { filled: true, selector, readbackMatched: matched, length: String(caption).length, readback };
      }
    }
    throw new Error('YOUTUBE_COMMUNITY_CAPTION_FIELD_NOT_FOUND');
  }

  async _uploadCommunityImages(mediaPaths = []) {
    const paths = normalizeCommunityMediaPaths(mediaPaths);
    if (paths.length === 0) return { skipped: true, mediaCount: 0 };
    for (const mediaPath of paths) {
      if (!fs.existsSync(mediaPath)) throw new Error(`YOUTUBE_COMMUNITY_MEDIA_FILE_NOT_FOUND: ${mediaPath}`);
    }

    const chooserPromise = this.page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null);
    const imageButtonProof = await this._clickCommunityExactControl({
      text: 'Image',
      selector: 'button, [role="button"], yt-formatted-string, div[aria-label], span[aria-label]',
    }).catch(() => null);
    const chooser = await chooserPromise;
    let setBy = null;
    if (chooser) {
      await chooser.setFiles(paths);
      setBy = 'filechooser';
    } else {
      await waitPage(this.page, 500);
      const inputs = this.page.locator('input[type="file"][accept*="image"], input[type="file"]');
      const count = await inputs.count().catch(() => 0);
      if (count < 1) throw new Error('YOUTUBE_COMMUNITY_IMAGE_FILE_INPUT_NOT_FOUND');
      await inputs.nth(count - 1).setInputFiles(paths);
      setBy = `input-${count - 1}`;
    }
    await waitPage(this.page, 7000);
    const attachmentProof = await this._readCommunityImageAttachmentProof(paths.length);
    if (!attachmentProof.hasAttachment) {
      throw new Error(`YOUTUBE_COMMUNITY_IMAGE_ATTACHMENT_PROOF_NOT_FOUND: ${JSON.stringify(attachmentProof)}`);
    }
    return {
      uploaded: true,
      mediaCount: paths.length,
      setBy,
      imageButtonProof,
      attachmentProof,
      proof: await this._readCommunityComposerProof(),
    };
  }

  async _readCommunityImageAttachmentProof(expectedCount = 1) {
    return await this.page.evaluate(expected => {
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 1 && rect.height > 1 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const textOf = el => (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
      const imagePreviews = [...document.querySelectorAll('img')]
        .filter(visible)
        .map(el => {
          const rect = el.getBoundingClientRect();
          return {
            alt: el.getAttribute('alt') || '',
            src: el.currentSrc || el.src || '',
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          };
        })
        .filter(item => {
          if (/(avatar|fayebaba)/i.test(item.alt)) return false;
          if (item.width < 40 || item.height < 40) return false;
          return /^data:image/i.test(item.src)
            || /^blob:/i.test(item.src)
            || /googleusercontent|ggpht|ytimg/i.test(item.src);
        });
      const buttons = [...document.querySelectorAll('button, [role="button"], [aria-label]')]
        .filter(visible)
        .map(el => textOf(el) || el.getAttribute('aria-label') || '')
        .filter(Boolean);
      const attachmentButtons = buttons.filter(label => /Cancel image post|Edit preview|Delete/i.test(label));
      return {
        hasAttachment: imagePreviews.length >= Math.min(Number(expected) || 1, 1)
          || attachmentButtons.some(label => /Cancel image post|Edit preview/i.test(label)),
        expectedCount: Number(expected) || 1,
        imagePreviewCount: imagePreviews.length,
        attachmentButtons,
        imagePreviews: imagePreviews.map(item => ({
          ...item,
          src: item.src.slice(0, 120),
        })).slice(0, 10),
        sampledText: (document.body?.innerText || '').slice(0, 1000),
      };
    }).catch(error => ({
      hasAttachment: false,
      expectedCount,
      imagePreviewCount: 0,
      attachmentButtons: [],
      imagePreviews: [],
      sampledText: String(error?.message || error || '').slice(0, 1000),
    }));
  }
  async _openCommunityScheduleMenu() {
    const clickedScheduleDirect = await this._clickCommunityControl(/^(Schedule post|Schedule)$/i, { preferRole: 'button' });
    if (clickedScheduleDirect) {
      await waitPage(this.page, 1000);
      return { clicked: true, direct: true, proof: await this._readCommunityComposerProof() };
    }

    const clickedArrow = await this._clickCommunityExactControl({ text: 'Action menu', aria: 'Action menu' });
    if (!clickedArrow) throw new Error('YOUTUBE_COMMUNITY_SCHEDULE_MENU_NOT_FOUND');
    await waitPage(this.page, 800);
    const clickedSchedule = await this._clickCommunityExactControl({ text: 'Schedule post', role: 'menuitem' });
    if (!clickedSchedule) throw new Error('YOUTUBE_COMMUNITY_SCHEDULE_MENU_ITEM_NOT_FOUND');
    await waitPage(this.page, 1000);
    return { clicked: true, direct: false, actionMenu: clickedArrow, schedulePost: clickedSchedule, proof: await this._readCommunityComposerProof() };
  }

  async _setCommunitySchedule(payload = {}) {
    const dateProof = await this._setCommunityScheduleDate(payload.scheduledDate);
    const timeProof = await this._setCommunityScheduleTime(payload.scheduledTime);
    return { dateProof, timeProof, scheduledDate: payload.scheduledDate, scheduledTime: payload.scheduledTime };
  }

  async _setCommunityScheduleDate(value) {
    const displayDate = formatCommunityDisplayDate(value);
    if (!displayDate) throw new Error(`YOUTUBE_COMMUNITY_INVALID_SCHEDULE_DATE: ${value}`);
    const opened = await this._clickCommunityExactControl({ selector: '#date-picker' });
    if (!opened) throw new Error('YOUTUBE_COMMUNITY_DATE_PICKER_NOT_FOUND');
    await waitPage(this.page, 500);
    const filled = await this.page.evaluate(dateValue => {
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 1 && rect.height > 1 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const input = [...document.querySelectorAll('input')]
        .find(el => visible(el) && /^\w{3}\s+\d{1,2},\s+\d{4}$/.test(el.value || ''));
      if (!input) return false;
      input.focus();
      input.value = dateValue;
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: dateValue }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, displayDate);
    if (!filled) throw new Error('YOUTUBE_COMMUNITY_DATE_INPUT_NOT_FOUND');
    await this.page.keyboard.press('Enter').catch(() => {});
    await waitPage(this.page, 800);
    const label = await this._readCommunityPickerLabel('date-picker');
    if (!label.includes(displayDate)) throw new Error(`YOUTUBE_COMMUNITY_DATE_SET_FAILED: expected ${displayDate}, saw ${label}`);
    return { filled: true, value, displayDate, label };
  }

  async _setCommunityScheduleTime(value) {
    const displayTime = formatCommunityTime(value);
    const opened = await this._clickCommunityExactControl({ selector: '#time-picker' });
    if (!opened) throw new Error('YOUTUBE_COMMUNITY_TIME_PICKER_NOT_FOUND');
    await waitPage(this.page, 500);
    const clicked = await this.page.evaluate(timeValue => {
      const textOf = el => (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
      const item = [...document.querySelectorAll('tp-yt-paper-item[role="option"], [role="option"]')]
        .find(el => textOf(el) === timeValue);
      if (!item) return false;
      item.scrollIntoView({ block: 'center', inline: 'nearest' });
      item.click();
      return true;
    }, displayTime);
    if (!clicked) throw new Error(`YOUTUBE_COMMUNITY_TIME_OPTION_NOT_FOUND: ${displayTime}`);
    await waitPage(this.page, 800);
    const label = await this._readCommunityPickerLabel('time-picker');
    if (!label.includes(displayTime)) throw new Error(`YOUTUBE_COMMUNITY_TIME_SET_FAILED: expected ${displayTime}, saw ${label}`);
    return { filled: true, value, displayTime, label };
  }

  async _clickCommunityScheduleAndVerify(payload = {}, options = {}) {
    const clicked = await this._clickCommunityExactControl({ text: 'Schedule', aria: 'Schedule' });
    if (!clicked) throw new Error('YOUTUBE_COMMUNITY_FINAL_SCHEDULE_BUTTON_NOT_FOUND');
    await waitPage(this.page, options.afterScheduleWaitMs || COMMUNITY_SCHEDULE_WAIT);
    const proof = await this._readCommunityScheduleProof(payload);
    if (proof.scheduled) return proof;

    const studioProof = await this._readCommunityStudioPostsProof(payload);
    const merged = {
      ...proof,
      scheduled: studioProof.scheduled,
      remotePostId: proof.remotePostId || studioProof.remotePostId || null,
      remoteUrl: proof.remoteUrl || studioProof.remoteUrl || null,
      studioPostsProof: studioProof,
    };
    if (!merged.scheduled) throw new Error(`YOUTUBE_COMMUNITY_SCHEDULE_PROOF_NOT_FOUND: ${JSON.stringify(merged)}`);
    return merged;
  }

  async _readCommunityScheduleProof(payload = {}) {
    const text = await this._readBodyText();
    const url = typeof this.page.url === 'function' ? this.page.url() : '';
    const captionNeedle = String(payload.caption || '').trim().slice(0, 80);
    const captionMatch = !captionNeedle || text.includes(captionNeedle);
    const scheduledText = /scheduled|has been scheduled/i.test(text);
    const remotePostId = extractCommunityPostId(url);
    return {
      scheduled: scheduledText || /\/post\//i.test(url),
      captionMatch,
      remotePostId,
      remoteUrl: remotePostId ? url : null,
      url,
      sampledText: text.slice(0, 1000),
    };
  }

  async _readCommunityStudioPostsProof(payload = {}) {
    const postsUrl = buildYouTubeStudioPostsUrl(this.dashboardUrl);
    await this.page.goto(postsUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitPage(this.page, 5000);

    const proof = await this.page.evaluate(({ caption, scheduledDate }) => {
      const bodyText = (document.body?.innerText || document.body?.textContent || '').replace(/\s+/g, ' ').trim();
      const captionNeedle = String(caption || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      const dateNeedle = String(scheduledDate || '').replace(/\s+/g, ' ').trim();
      const editLink = [...document.querySelectorAll('a[href*="/post/"]')]
        .map(el => el.href || '')
        .find(Boolean) || '';
      return {
        scheduled: (!captionNeedle || bodyText.includes(captionNeedle)) && /\bScheduled\b/i.test(bodyText),
        captionMatch: !captionNeedle || bodyText.includes(captionNeedle),
        dateMatch: !dateNeedle || bodyText.includes(dateNeedle),
        remotePostId: editLink.match(/\/post\/([^/?#]+)/i)?.[1] || null,
        remoteUrl: editLink || null,
        postsUrl: location.href,
        sampledText: bodyText.slice(0, 1500),
      };
    }, {
      caption: payload.caption || '',
      scheduledDate: formatCommunityDisplayDate(payload.scheduledDate),
    }).catch(error => ({
      scheduled: false,
      captionMatch: false,
      dateMatch: false,
      remotePostId: null,
      remoteUrl: null,
      postsUrl,
      sampledText: String(error?.message || error || '').slice(0, 1500),
    }));

    return proof;
  }

  async _closeCommunityComposer() {
    await this.page.keyboard.press('Escape').catch(() => {});
    await waitPage(this.page, 500);
    await this._clickCommunityControl(/^(Cancel|Discard|Close)$/i, { preferRole: 'button' }).catch(() => false);
  }

  async _clickCommunityCaptionPrompt() {
    return await this._clickCommunityExactControl({
      text: "What's on your mind?",
      aria: "What's on your mind?",
      role: 'button',
      selector: '[role="button"], yt-formatted-string, div[aria-label], span[aria-label]',
    });
  }

  async _readCommunityPickerLabel(id) {
    return await this.page.evaluate(pickerId => {
      const el = document.querySelector(`#${pickerId}`);
      return (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
    }, id).catch(() => '');
  }

  async _clickCommunityExactControl(target = {}) {
    const result = await this.page.evaluate(({ text, aria, role, selector }) => {
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 1 && rect.height > 1 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const textOf = el => (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
      const source = selector
        ? [...document.querySelectorAll(selector)]
        : [...document.querySelectorAll('button, [role="button"], [role="menuitem"], [role="option"], tp-yt-paper-item, ytd-menu-service-item-renderer, yt-button-shape, yt-icon-button, yt-formatted-string, div[aria-label], span[aria-label]')];
      const ranked = source
        .filter(visible)
        .filter(el => {
          if (text && textOf(el) !== text) return false;
          if (aria && (el.getAttribute('aria-label') || '') !== aria) return false;
          if (role && (el.getAttribute('role') || '') !== role) return false;
          return true;
        })
        .map(el => {
          const rect = el.getBoundingClientRect();
          const actualRole = el.getAttribute('role') || '';
          let score = 0;
          if (role && actualRole === role) score += 120;
          if (actualRole === 'button' || actualRole === 'menuitem' || actualRole === 'option') score += 80;
          if (el.tagName === 'BUTTON' || el.tagName === 'TP-YT-PAPER-ITEM' || el.tagName === 'YTD-MENU-SERVICE-ITEM-RENDERER') score += 50;
          if (el.tagName === 'YT-FORMATTED-STRING') score += 40;
          if (el.tagName === 'DIV') score -= 30;
          if (rect.width > 700) score -= 20;
          return { el, tag: el.tagName, role: actualRole, text: textOf(el), aria: el.getAttribute('aria-label') || '', score };
        })
        .sort((a, b) => b.score - a.score);
      const picked = ranked[0] || null;
      if (!picked) return null;
      picked.el.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = picked.el.getBoundingClientRect();
      return {
        x: Math.round(rect.x + rect.width / 2),
        y: Math.round(rect.y + rect.height / 2),
        tag: picked.tag,
        role: picked.role,
        text: picked.text,
        aria: picked.aria,
        score: picked.score,
      };
    }, {
      text: target.text || '',
      aria: target.aria || '',
      role: target.role || '',
      selector: target.selector || '',
    }).catch(() => null);

    if (!result) return null;
    this.log(`[YT-COMMUNITY] Clicking exact "${result.text || result.aria || target.selector}" (${result.role || result.tag || 'node'}) at ${result.x},${result.y}`);
    await this.page.mouse.click(result.x, result.y);
    await waitPage(this.page, 500);
    return result;
  }

  async _clickCommunityControl(pattern, options = {}) {
    const target = await this.page.evaluate(({ source, flags, preferRole, bottomOnly, rightSide }) => {
      const re = new RegExp(source, flags);
      const visible = el => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 1 && rect.height > 1 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const textOf = el => (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
      const controls = [...document.querySelectorAll('button, [role="button"], [role="menuitem"], ytcp-button, tp-yt-paper-item, div, span')]
        .filter(visible)
        .filter(el => re.test(textOf(el)));
      const ranked = controls.map(el => {
        const rect = el.getBoundingClientRect();
        const role = el.getAttribute('role') || '';
        let score = 0;
        if (preferRole && role === preferRole) score += 100;
        if (role === 'button' || role === 'menuitem' || el.tagName === 'BUTTON' || el.tagName === 'YTCP-BUTTON') score += 30;
        if (bottomOnly && rect.y > window.innerHeight * 0.55) score += 20;
        if (bottomOnly && rect.y <= window.innerHeight * 0.55) score -= 50;
        if (rightSide && rect.x > window.innerWidth * 0.5) score += 15;
        if (rect.width > 380) score -= 10;
        return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2), text: textOf(el), role, score };
      }).sort((a, b) => b.score - a.score);
      return ranked[0] || null;
    }, {
      source: pattern.source,
      flags: pattern.flags,
      preferRole: options.preferRole || '',
      bottomOnly: options.bottomOnly === true,
      rightSide: options.rightSide === true,
    }).catch(() => null);

    if (!target) return false;
    this.log(`[YT-COMMUNITY] Clicking "${target.text}" (${target.role || 'no role'}) at ${target.x},${target.y}`);
    await this.page.mouse.click(target.x, target.y);
    await waitPage(this.page, 800);
    return true;
  }

  async _readBodyText() {
    return await this.page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
  }

  async _countRole(role, pattern) {
    return await this.page.getByRole(role, { name: pattern }).count().catch(() => 0);
  }
}

class YouTubeCommunityPostPublisher {
  constructor(options = {}) {
    this.options = options;
    this.dashboardUrl = options.dashboardUrl || YOUTUBE_STUDIO_DASHBOARD_URL;
    this.userDataDir = options.userDataDir || null;
    this.headless = options.headless === true;
    this.loginWaitMs = options.loginWaitMs;
    this.log = options.log || console.log;
    this.studioUploaderFactory = options.studioUploaderFactory || (uploaderOptions => new YouTubeCommunityStudioUploader(uploaderOptions));
    this.studioUploader = null;
    this.channelProof = null;
  }

  async verifyChannelContext() {
    this.studioUploader = this.studioUploaderFactory(this._uploaderOptions());
    const result = await this.studioUploader.launch();
    this.channelProof = result.channelProof || null;
    return result;
  }

  async inspectComposer(options = {}) {
    this.studioUploader = this.studioUploaderFactory(this._uploaderOptions());
    const launchResult = await this.studioUploader.launch();
    if (typeof this.studioUploader.inspectCommunityPostComposer !== 'function') {
      return {
        success: false,
        dryRun: true,
        blocked: true,
        dashboardUrl: this.dashboardUrl,
        channelProof: launchResult.channelProof || null,
        error: 'YOUTUBE_COMMUNITY_COMPOSER_INSPECTOR_NOT_AVAILABLE',
      };
    }
    const result = await this.studioUploader.inspectCommunityPostComposer(options);
    this.channelProof = result.channelProof || launchResult.channelProof || null;
    return result;
  }

  async schedulePost(payload = {}, options = {}) {
    const validation = validateYouTubeCommunityPost(payload, payload.validationOptions || {});
    if (!validation.ok) {
      return {
        success: false,
        blocked: true,
        validation,
        error: `YOUTUBE_COMMUNITY_VALIDATION_FAILED: ${validation.errors.join('; ')}`,
      };
    }
    if (options.confirmSchedule !== true) {
      throw new Error('YOUTUBE_COMMUNITY_SCHEDULE_REQUIRES_CONFIRMATION: pass confirmSchedule=true for the live schedule-only proof.');
    }

    this.studioUploader = this.studioUploaderFactory(this._uploaderOptions());
    await this.studioUploader.launch();
    if (typeof this.studioUploader.scheduleCommunityPost !== 'function') {
      throw new Error('YOUTUBE_COMMUNITY_SCHEDULE_NOT_AVAILABLE');
    }
    const result = await this.studioUploader.scheduleCommunityPost(payload, options);
    this.channelProof = result.channelProof || null;
    return {
      ...result,
      validation,
    };
  }

  async close() {
    if (this.studioUploader && typeof this.studioUploader.close === 'function') {
      await this.studioUploader.close();
    }
    this.studioUploader = null;
  }

  _uploaderOptions() {
    return {
      userDataDir: this.userDataDir,
      headless: this.headless,
      dashboardUrl: this.dashboardUrl,
      loginWaitMs: this.loginWaitMs,
      log: this.log,
    };
  }
}

function buildYouTubeCommunityUrl(dashboardUrl, channelId, showCreateDialog = true) {
  const id = channelId || String(dashboardUrl || '').match(/\/channel\/([^/?#]+)/i)?.[1];
  if (!id) throw new Error('YOUTUBE_COMMUNITY_CHANNEL_ID_REQUIRED');
  const url = `https://www.youtube.com/channel/${encodeURIComponent(id)}/community`;
  return showCreateDialog ? `${url}?show_create_dialog=1` : url;
}

function buildYouTubeStudioPostsUrl(dashboardUrl) {
  const base = String(dashboardUrl || YOUTUBE_STUDIO_DASHBOARD_URL).replace(/\/?$/, '');
  return `${base}/content/posts?filter=%5B%5D&sort=%7B%22columnType%22%3A%22date%22%2C%22sortOrder%22%3A%22DESCENDING%22%7D`;
}

function formatCommunityDisplayDate(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return String(value || '');
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function formatCommunityTime(value) {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return String(value || '');
  const hour = Number(match[1]);
  const minute = match[2];
  const suffix = hour >= 12 ? 'PM' : 'AM';
  const hour12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  return `${hour12}:${minute} ${suffix}`;
}

function extractCommunityPostId(url) {
  const match = String(url || '').match(/\/post\/([^/?#]+)/i);
  return match ? decodeURIComponent(match[1]) : null;
}

async function waitPage(page, ms) {
  if (page && typeof page.waitForTimeout === 'function') await page.waitForTimeout(ms);
}

function normalizeCommunityMediaPaths(value) {
  if (!value) return [];
  const list = Array.isArray(value) ? value : String(value).split('|');
  return list
    .map(item => String(item || '').trim())
    .filter(Boolean);
}

function parseHashtags(value) {
  if (Array.isArray(value)) return value.map(String);
  if (value == null || value === '') return [];
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch (_) {}
    return extractHashtags(value);
  }
  return [];
}

function extractHashtags(text) {
  return [...String(text || '').matchAll(/#[\p{L}\p{N}_]+/gu)]
    .map(match => match[0])
    .filter(Boolean);
}

function rewriteYouTubeCommunityTitle(title, project = {}) {
  const text = String(title || project.title || 'YouTube Community post')
    .replace(/\bFacebook\s+Reels?\b/ig, 'YouTube Shorts')
    .replace(/\bFacebook\b/ig, 'YouTube')
    .replace(/\bReels?\b/g, 'Shorts')
    .trim();
  return text.slice(0, 90);
}

function tagFromTitleText(title) {
  return String(title || '')
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join('');
}

function normalizeCommunityHashtag(tag) {
  const text = String(tag || '')
    .replace(/^#+/, '')
    .replace(/facebookreels?/ig, 'YouTubeShorts')
    .replace(/facebook/ig, 'YouTube')
    .replace(/\breels?\b/ig, 'Shorts')
    .replace(/[^a-z0-9_]+/gi, '');
  return text || null;
}

module.exports = {
  YOUTUBE_COMMUNITY_PLATFORM,
  YouTubeCommunityStudioUploader,
  YouTubeCommunityPostPublisher,
  prepareYouTubeCommunityPostJob,
  prepareYouTubeCommunityMediaPaths,
  buildYouTubeCommunityCaption,
  validateYouTubeCommunityPost,
  normalizeCommunityMediaPaths,
};
