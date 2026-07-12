const fs = require('fs');
const { execFileSync } = require('child_process');
const {
  YOUTUBE_STUDIO_DASHBOARD_URL,
  validateShortMetadataForPlatform,
} = require('./platform-profiles');

const DEFAULT_YOUTUBE_HASHTAGS = [
  '#shorts',
  '#nollywood',
  '#nollywoodmovies',
  '#africandrama',
  '#naijamovies',
];

const FACEBOOK_ONLY_HASHTAGS = new Set([
  '#fb',
  '#fbreels',
  '#facebook',
  '#facebookreels',
  '#reels',
]);

function prepareYouTubeShortPublishJob(db, short, project = {}, options = {}) {
  if (!db || typeof db.upsertShortPublishJob !== 'function') {
    throw new Error('Database with upsertShortPublishJob() is required');
  }
  if (!short || !short.id) throw new Error('short.id is required');

  const videoInfo = options.videoInfo
    ? normalizeVideoInfo(options.videoInfo, short)
    : probeShortVideoFile(short.file_path, { ...options, fallbackDurationSeconds: short.duration_seconds });

  const metadata = buildYouTubeShortMetadata(short, project, options);
  const validation = validateShortMetadataForPlatform({
    title: metadata.title,
    description: metadata.description,
    durationSeconds: videoInfo.durationSeconds,
    width: videoInfo.width,
    height: videoInfo.height,
    aiDisclosure: metadata.settings.aiDisclosure,
  }, 'youtube_shorts', {
    initialProofMode: options.initialProofMode !== false,
  });

  const gateErrors = [];
  if (!short.file_path) gateErrors.push('Video file path is missing');
  if (!videoInfo.fileExists) gateErrors.push(`Video file not found: ${short.file_path || '(empty)'}`);
  if (videoInfo.probeError) gateErrors.push(`Video probe failed: ${videoInfo.probeError}`);
  if (videoInfo.fileExists && !Number.isFinite(videoInfo.durationSeconds)) gateErrors.push('Video duration could not be verified');
  if (videoInfo.fileExists && (!Number.isFinite(videoInfo.width) || !Number.isFinite(videoInfo.height))) {
    gateErrors.push('Video dimensions could not be verified');
  }
  gateErrors.push(...validation.errors);
  if (options.strictInitialProof !== false) {
    gateErrors.push(...validation.warnings);
  }
  const scheduledDate = Object.prototype.hasOwnProperty.call(options, 'scheduledDate') ? options.scheduledDate : null;
  const scheduledTime = scheduledDate
    ? (options.scheduledTime || short.scheduled_time || metadata.settings.defaultScheduleTime)
    : null;
  if (metadata.settings.visibility === 'scheduled' && !scheduledDate) {
    gateErrors.push('YouTube scheduled visibility requires an explicit scheduledDate');
  }

  const status = gateErrors.length === 0 ? 'ready' : 'blocked';
  const validationRecord = {
    ok: status === 'ready',
    errors: gateErrors,
    warnings: validation.warnings,
    videoInfo,
    checkedAt: new Date().toISOString(),
  };

  const job = db.upsertShortPublishJob({
    short_id: short.id,
    platform: 'youtube_shorts',
    status,
    scheduled_date: scheduledDate,
    scheduled_time: scheduledTime,
    title: metadata.title,
    description: metadata.description,
    hashtags_json: metadata.hashtags,
    metadata_json: metadata,
    validation_json: validationRecord,
    error_message: gateErrors.length ? gateErrors.join('; ') : null,
  });

  return {
    ok: status === 'ready',
    status,
    job,
    metadata,
    validation: validationRecord,
    videoInfo,
    errors: gateErrors,
    warnings: validation.warnings,
  };
}

function buildYouTubeShortMetadata(short = {}, project = {}, options = {}) {
  const profileTitle = cleanTitle(
    options.title ||
    short.title ||
    firstMeaningfulLine(short.description) ||
    project.title ||
    'Nollywood Drama Short'
  );
  const title = truncateAtWord(profileTitle, 100);

  const hashtags = buildYouTubeHashtags(short.hashtags, options.hashtags);
  const baseDescription = cleanDescription(
    options.description ||
    short.description ||
    `A dramatic Nollywood short from "${project.title || 'this AI film'}".`
  );
  const description = buildDescriptionWithHashtags(baseDescription, hashtags, 5000);

  const settings = {
    aiDisclosure: options.aiDisclosure !== false,
    madeForKids: options.madeForKids === true ? true : false,
    ageRestricted: options.ageRestricted === true ? true : false,
    paidPromotion: options.paidPromotion === true ? true : false,
    visibility: options.visibility || 'private',
    defaultScheduleTime: '18:00',
    studioDashboardUrl: YOUTUBE_STUDIO_DASHBOARD_URL,
  };

  return {
    title,
    description,
    hashtags,
    settings,
    source: {
      shortId: short.id || null,
      projectId: short.project_id || project.id || null,
      shortNumber: short.short_number || null,
    },
  };
}

function probeShortVideoFile(filePath, options = {}) {
  if (!filePath) {
    return normalizeVideoInfo({ fileExists: false }, { duration_seconds: options.fallbackDurationSeconds });
  }
  if (!fs.existsSync(filePath)) {
    return normalizeVideoInfo({ fileExists: false }, { duration_seconds: options.fallbackDurationSeconds });
  }

  const ffprobePath = options.ffprobePath || 'ffprobe';
  try {
    const output = execFileSync(ffprobePath, [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,duration:format=duration',
      '-of', 'json',
      filePath,
    ], {
      encoding: 'utf8',
      timeout: options.probeTimeoutMs || 15000,
    });
    const parsed = JSON.parse(output || '{}');
    const stream = Array.isArray(parsed.streams) ? parsed.streams[0] || {} : {};
    const format = parsed.format || {};
    return normalizeVideoInfo({
      fileExists: true,
      durationSeconds: firstFinite(stream.duration, format.duration, options.fallbackDurationSeconds),
      width: firstFinite(stream.width),
      height: firstFinite(stream.height),
    });
  } catch (error) {
    return normalizeVideoInfo({
      fileExists: true,
      durationSeconds: options.fallbackDurationSeconds,
      probeError: error.message || String(error),
    });
  }
}

function normalizeVideoInfo(videoInfo = {}, short = {}) {
  return {
    fileExists: videoInfo.fileExists !== false,
    durationSeconds: firstFinite(videoInfo.durationSeconds, videoInfo.duration_seconds, short.duration_seconds),
    width: firstFinite(videoInfo.width),
    height: firstFinite(videoInfo.height),
    probeError: videoInfo.probeError || null,
  };
}

function buildYouTubeHashtags(primary, extra) {
  const tags = [];
  const add = tag => {
    const normalized = normalizeHashtag(tag);
    if (!normalized || FACEBOOK_ONLY_HASHTAGS.has(normalized)) return;
    if (!tags.includes(normalized)) tags.push(normalized);
  };

  DEFAULT_YOUTUBE_HASHTAGS.forEach(add);
  parseHashtags(primary).forEach(add);
  parseHashtags(extra).forEach(add);

  return tags.slice(0, 12);
}

function parseHashtags(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch (_) {}
    return value.split(/\s+/).filter(token => token.startsWith('#'));
  }
  return [];
}

function normalizeHashtag(tag) {
  const text = String(tag || '').trim().toLowerCase();
  if (!text) return null;
  const body = text.replace(/^#/, '').replace(/[^a-z0-9_]/g, '');
  return body ? `#${body}` : null;
}

function cleanTitle(value) {
  return String(value || '')
    .replace(/#\w+/g, '')
    .replace(/\bfacebook\s+reels?\b/ig, 'short')
    .replace(/\bfbreels?\b/ig, 'shorts')
    .replace(/\s+/g, ' ')
    .trim() || 'Nollywood Drama Short';
}

function cleanDescription(value) {
  return String(value || '')
    .replace(/\bFacebook Reel\b/ig, 'YouTube Short')
    .split(/\r?\n/)
    .map(line => line.replace(/#[\w]+/g, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function buildDescriptionWithHashtags(description, hashtags, maxLength) {
  const tagLine = hashtags.join(' ');
  let body = description || 'A dramatic Nollywood short.';
  if (tagLine && !body.includes(tagLine)) {
    body = `${body.trim()}\n\n${tagLine}`;
  }
  if (body.length <= maxLength) return body;

  const suffix = tagLine ? `\n\n${tagLine}` : '';
  const maxBody = Math.max(0, maxLength - suffix.length - 3);
  return `${truncateAtWord(body.replace(tagLine, '').trim(), maxBody)}${suffix}`.slice(0, maxLength);
}

function firstMeaningfulLine(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(line => line && !line.startsWith('#')) || '';
}

function truncateAtWord(value, maxLength) {
  const text = String(value || '').trim();
  if (text.length <= maxLength) return text;
  const clipped = text.slice(0, Math.max(0, maxLength - 3));
  const lastSpace = clipped.lastIndexOf(' ');
  const base = lastSpace > 30 ? clipped.slice(0, lastSpace) : clipped;
  return `${base.trim()}...`;
}

function firstFinite(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

module.exports = {
  buildYouTubeShortMetadata,
  buildYouTubeHashtags,
  prepareYouTubeShortPublishJob,
  probeShortVideoFile,
};
