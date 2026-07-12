const YOUTUBE_STUDIO_DASHBOARD_URL = 'https://studio.youtube.com/channel/UCObQBiWc7kI4Q1PPpQZiuxA';

const SHORT_PLATFORM_PROFILES = Object.freeze({
  facebook_reels: Object.freeze({
    platform: 'facebook_reels',
    label: 'Facebook Reels',
    minDurationSeconds: 30,
    maxDurationSeconds: 90,
    defaultScheduleTime: '18:00',
    titleMaxChars: 40,
    descriptionMaxChars: 63206,
    verticalOrSquareRequired: true,
    requiresAiDisclosureDecision: false,
  }),
  youtube_shorts: Object.freeze({
    platform: 'youtube_shorts',
    label: 'YouTube Shorts',
    minDurationSeconds: 1,
    maxDurationSeconds: 180,
    initialProofMaxDurationSeconds: 60,
    defaultScheduleTime: '18:00',
    titleMaxChars: 100,
    descriptionMaxChars: 5000,
    verticalOrSquareRequired: true,
    requiresAiDisclosureDecision: true,
    studioDashboardUrl: YOUTUBE_STUDIO_DASHBOARD_URL,
  }),
});

const PLATFORM_ALIASES = Object.freeze({
  facebook: 'facebook_reels',
  facebook_reel: 'facebook_reels',
  facebook_reels: 'facebook_reels',
  fb: 'facebook_reels',
  fb_reels: 'facebook_reels',
  youtube: 'youtube_shorts',
  youtube_short: 'youtube_shorts',
  youtube_shorts: 'youtube_shorts',
  yt: 'youtube_shorts',
});

function normalizeShortPlatform(platform = 'facebook_reels') {
  const key = String(platform || 'facebook_reels').trim().toLowerCase();
  return PLATFORM_ALIASES[key] || key;
}

function getShortPlatformProfile(platform = 'facebook_reels') {
  const normalized = normalizeShortPlatform(platform);
  const profile = SHORT_PLATFORM_PROFILES[normalized];
  if (!profile) throw new Error(`Unsupported short platform: ${platform}`);
  return profile;
}

function validateShortMetadataForPlatform(input = {}, platform = 'youtube_shorts', options = {}) {
  const profile = getShortPlatformProfile(platform);
  const errors = [];
  const warnings = [];

  const title = String(input.title || '').trim();
  if (profile.platform === 'youtube_shorts' && title.length === 0) {
    errors.push(`${profile.label} title is required`);
  }
  if (profile.titleMaxChars && title.length > profile.titleMaxChars) {
    errors.push(`${profile.label} title exceeds ${profile.titleMaxChars} characters`);
  }

  const description = String(input.description || '').trim();
  if (profile.descriptionMaxChars && description.length > profile.descriptionMaxChars) {
    errors.push(`${profile.label} description exceeds ${profile.descriptionMaxChars} characters`);
  }

  const durationSeconds = toFiniteNumber(input.durationSeconds);
  if (durationSeconds != null) {
    if (durationSeconds < profile.minDurationSeconds) {
      errors.push(`${profile.label} video is shorter than ${profile.minDurationSeconds} second(s)`);
    }
    if (durationSeconds > profile.maxDurationSeconds) {
      errors.push(`${profile.label} video exceeds ${profile.maxDurationSeconds} seconds`);
    }
    if (
      profile.initialProofMaxDurationSeconds &&
      options.initialProofMode !== false &&
      durationSeconds > profile.initialProofMaxDurationSeconds
    ) {
      warnings.push(`${profile.label} initial live proof should stay at or below ${profile.initialProofMaxDurationSeconds} seconds`);
    }
  }

  const width = toFiniteNumber(input.width);
  const height = toFiniteNumber(input.height);
  if (profile.verticalOrSquareRequired && width != null && height != null && width > height) {
    errors.push(`${profile.label} requires a vertical or square video aspect ratio`);
  }

  if (profile.requiresAiDisclosureDecision && input.aiDisclosure == null) {
    errors.push(`${profile.label} requires an AI altered/generated disclosure decision`);
  }

  return {
    ok: errors.length === 0,
    platform: profile.platform,
    profile,
    errors,
    warnings,
  };
}

function toFiniteNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

module.exports = {
  SHORT_PLATFORM_PROFILES,
  YOUTUBE_STUDIO_DASHBOARD_URL,
  getShortPlatformProfile,
  normalizeShortPlatform,
  validateShortMetadataForPlatform,
};
