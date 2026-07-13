const { FacebookUploader } = require('./facebook-uploader');
const {
  YOUTUBE_STUDIO_DASHBOARD_URL,
  validateShortMetadataForPlatform,
} = require('./platform-profiles');
const { YouTubeStudioUploader } = require('./youtube-studio-uploader');

class ShortPublisherAdapter {
  constructor(options = {}) {
    this.options = options;
    this.log = options.log || console.log;
  }

  async launch() {
    throw new Error('ShortPublisherAdapter.launch() must be implemented by subclasses');
  }

  async scheduleShort() {
    throw new Error('ShortPublisherAdapter.scheduleShort() must be implemented by subclasses');
  }

  async close() {}
}

class FacebookShortPublisherAdapter extends ShortPublisherAdapter {
  constructor(options = {}) {
    super(options);
    this.platform = 'facebook_reels';
    this.uploaderOptions = options.uploaderOptions || options;
    this.uploaderFactory = options.uploaderFactory || (uploaderOptions => new FacebookUploader(uploaderOptions));
    this.uploader = null;
  }

  static getScheduleWindow(now) {
    return FacebookUploader.getScheduleWindow(now);
  }

  static isWithinScheduleWindow(date, now) {
    return FacebookUploader.isWithinScheduleWindow(date, now);
  }

  async launch() {
    this.uploader = this.uploaderFactory(this.uploaderOptions);
    await this.uploader.launch();
  }

  async scheduleShort(payload) {
    if (!this.uploader) throw new Error('Facebook publisher has not been launched');
    return this.uploader.scheduleReel({
      filePath: payload.filePath,
      description: payload.description,
      scheduledDate: payload.scheduledDate,
      scheduledTime: payload.scheduledTime,
      status: payload.status,
    });
  }

  async close() {
    if (this.uploader && typeof this.uploader.close === 'function') {
      await this.uploader.close();
    }
    this.uploader = null;
  }
}

class YouTubeShortPublisherAdapter extends ShortPublisherAdapter {
  constructor(options = {}) {
    super(options);
    this.platform = 'youtube_shorts';
    this.dashboardUrl = options.dashboardUrl || YOUTUBE_STUDIO_DASHBOARD_URL;
    this.userDataDir = options.userDataDir || null;
    this.headless = options.headless === true;
    this.loginWaitMs = options.loginWaitMs;
    this.studioUploaderFactory = options.studioUploaderFactory || (uploaderOptions => new YouTubeStudioUploader(uploaderOptions));
    this.studioUploader = null;
    this.channelProof = null;
    this.launched = false;
  }

  async launch() {
    this.launched = true;
    this.log(`[SHORTS][YOUTUBE] Dry-run publisher initialized for ${this.dashboardUrl}`);
    return {
      success: true,
      dryRun: true,
      dashboardUrl: this.dashboardUrl,
    };
  }

  async scheduleShort(payload = {}) {
    const validation = validateShortMetadataForPlatform({
      title: payload.title,
      description: payload.description,
      durationSeconds: payload.durationSeconds,
      width: payload.width,
      height: payload.height,
      aiDisclosure: payload.aiDisclosure,
    }, 'youtube_shorts', payload.validationOptions || {});

    if (!validation.ok) {
      return {
        success: false,
        dryRun: true,
        blocked: true,
        validation,
        error: `YOUTUBE_SHORT_VALIDATION_FAILED: ${validation.errors.join('; ')}`,
      };
    }

    return {
      success: false,
      dryRun: true,
      blocked: true,
      validation,
      dashboardUrl: this.dashboardUrl,
      channelProof: this.channelProof,
      error: 'YOUTUBE_DRY_RUN_ONLY: YouTube Studio upload is not enabled until channel-context proof and explicit live approval.',
    };
  }

  async verifyChannelContext() {
    this.studioUploader = this.studioUploaderFactory({
      userDataDir: this.userDataDir,
      headless: this.headless,
      dashboardUrl: this.dashboardUrl,
      loginWaitMs: this.loginWaitMs,
      log: this.log,
    });
    const result = await this.studioUploader.launch();
    this.channelProof = result.channelProof || null;
    return result;
  }

  async inspectUploadWizard(options = {}) {
    this.studioUploader = this.studioUploaderFactory({
      userDataDir: this.userDataDir,
      headless: this.headless,
      dashboardUrl: this.dashboardUrl,
      loginWaitMs: this.loginWaitMs,
      log: this.log,
    });
    const launchResult = await this.studioUploader.launch();
    if (typeof this.studioUploader.inspectUploadWizard !== 'function') {
      throw new Error('YOUTUBE_UPLOAD_WIZARD_INSPECTOR_NOT_AVAILABLE');
    }
    const result = await this.studioUploader.inspectUploadWizard(options);
    this.channelProof = result.channelProof || launchResult.channelProof || null;
    return result;
  }

  async uploadAndScheduleShort(payload = {}, options = {}) {
    const validation = validateShortMetadataForPlatform({
      title: payload.title,
      description: payload.description,
      durationSeconds: payload.durationSeconds,
      width: payload.width,
      height: payload.height,
      aiDisclosure: payload.aiDisclosure,
    }, 'youtube_shorts', payload.validationOptions || {});

    if (!validation.ok) {
      return {
        success: false,
        blocked: true,
        validation,
        error: `YOUTUBE_SHORT_VALIDATION_FAILED: ${validation.errors.join('; ')}`,
      };
    }
    if (options.confirmSchedule !== true) {
      throw new Error('YOUTUBE_SCHEDULE_REQUIRES_CONFIRMATION: pass confirmSchedule=true for the live e2e schedule proof.');
    }

    this.studioUploader = this.studioUploaderFactory({
      userDataDir: this.userDataDir,
      headless: this.headless,
      dashboardUrl: this.dashboardUrl,
      loginWaitMs: this.loginWaitMs,
      log: this.log,
    });
    await this.studioUploader.launch();
    if (typeof this.studioUploader.uploadAndScheduleShort !== 'function') {
      throw new Error('YOUTUBE_UPLOAD_AND_SCHEDULE_NOT_AVAILABLE');
    }
    const result = await this.studioUploader.uploadAndScheduleShort(payload, options);
    this.channelProof = result.channelProof || null;
    return {
      ...result,
      validation,
    };
  }
  async deleteShort(payload = {}, options = {}) {
    if (options.confirmDelete !== true) {
      throw new Error('YOUTUBE_DELETE_REQUIRES_CONFIRMATION: pass confirmDelete=true for the permanent YouTube Studio delete action.');
    }

    this.studioUploader = this.studioUploaderFactory({
      userDataDir: this.userDataDir,
      headless: this.headless,
      dashboardUrl: this.dashboardUrl,
      loginWaitMs: this.loginWaitMs,
      log: this.log,
    });
    await this.studioUploader.launch();
    if (typeof this.studioUploader.deleteShortByRemoteId !== 'function') {
      throw new Error('YOUTUBE_DELETE_SHORT_NOT_AVAILABLE');
    }
    const result = await this.studioUploader.deleteShortByRemoteId(payload, options);
    this.channelProof = result.channelProof || null;
    return result;
  }

  async close() {
    if (this.studioUploader && typeof this.studioUploader.close === 'function') {
      await this.studioUploader.close();
    }
    this.studioUploader = null;
    this.launched = false;
  }
}

module.exports = {
  ShortPublisherAdapter,
  FacebookShortPublisherAdapter,
  YouTubeShortPublisherAdapter,
};