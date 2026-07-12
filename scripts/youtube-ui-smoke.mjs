import fs from 'fs';
import os from 'os';
import path from 'path';
import { _electron as electron } from 'playwright';

const root = process.cwd();
const smokeRoot = path.join(root, '.tmp-youtube-ui-smoke');
const appDataRoaming = path.join(smokeRoot, 'AppData', 'Roaming');
const appDataLocal = path.join(smokeRoot, 'AppData', 'Local');
const appUserData = path.join(appDataRoaming, 'nollywood-ai-pipeline');
const copiedDb = path.join(appUserData, 'nollywood-pipeline.sqlite');
const sourceDb = process.env.YOUTUBE_SMOKE_DB
  || path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'nollywood-ai-pipeline', 'nollywood-pipeline.sqlite');
const youtubeProfile = path.join(root, '.browser-profile-youtube');

if (!fs.existsSync(sourceDb)) {
  throw new Error(`Source AppData DB not found for smoke test: ${sourceDb}`);
}
fs.mkdirSync(appUserData, { recursive: true });
fs.mkdirSync(appDataLocal, { recursive: true });
fs.copyFileSync(sourceDb, copiedDb);
if (fs.existsSync(youtubeProfile)) {
  fs.writeFileSync(
    path.join(appUserData, 'config.json'),
    JSON.stringify({ chromeUserDataDir: youtubeProfile }, null, 2)
  );
}

const app = await electron.launch({
  args: ['.'],
  cwd: root,
  env: {
    ...process.env,
    APPDATA: appDataRoaming,
    LOCALAPPDATA: appDataLocal,
    NOLLYWOOD_USER_DATA_DIR: appUserData,
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
  },
});

const result = {
  appDataRoaming,
  sourceDb,
  copiedDb,
  projects: 0,
  projectId: null,
  jobBefore: null,
  jobCountBefore: 0,
  jobCountAfterPrepare: null,
  youtubeSectionVisible: false,
  proofTextVisible: false,
  prepareButton: null,
  inspectButton: null,
  scheduleButtonBeforePrepare: null,
  scheduleButtonAfterPrepare: null,
  confirmCalled: false,
  scheduleApiCalledAfterConfirmFalse: false,
  prepareClicked: false,
  prepareResultText: null,
  screenshot: path.join(smokeRoot, 'youtube-ui-smoke.png'),
  consoleErrors: [],
};

try {
  const page = await app.firstWindow();
  page.on('console', message => {
    if (message.type() === 'error') result.consoleErrors.push(message.text());
  });
  page.on('pageerror', error => {
    result.consoleErrors.push(error.message);
  });

  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => Boolean(window.api && window.api.getShortsProjects), null, { timeout: 30000 });

  const projects = await retry(async () => {
    const rows = await page.evaluate(() => window.api.getShortsProjects());
    if (!Array.isArray(rows) || rows.length === 0) throw new Error('No Shorts projects returned yet');
    return rows;
  }, 45000);
  result.projects = projects.length;

  const target = await retry(async () => {
    for (const project of projects) {
      const status = await page.evaluate(projectId => window.api.getShortsStatus(projectId), project.id);
      const jobs = status.youtubeJobs || [];
      const match = jobs.find(job => job.remote_post_id === 'uQGmdxd0TeM')
        || jobs.find(job => job.platform === 'youtube_shorts');
      if (match) return { project, status, job: match };
    }
    throw new Error('No project with YouTube Shorts job proof found');
  }, 30000);

  result.projectId = target.project.id;
  result.jobBefore = pickJobFields(target.job);
  result.jobCountBefore = (target.status.youtubeJobs || []).length;

  await page.locator('#btn-shorts-standalone').click({ timeout: 15000 });
  await page.locator('#shorts-project-selector').waitFor({ timeout: 30000 });
  await page.selectOption('#shorts-project-selector', String(target.project.id));
  await page.waitForSelector('#shorts-youtube-section', { state: 'visible', timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('#shorts-youtube-jobs')?.innerText.includes('uQGmdxd0TeM'), null, { timeout: 30000 });

  result.youtubeSectionVisible = await page.locator('#shorts-youtube-section').isVisible();
  result.proofTextVisible = await page.locator('#shorts-youtube-jobs').innerText().then(text => text.includes('uQGmdxd0TeM'));
  result.prepareButton = await buttonState(page, '#btn-youtube-prepare');
  result.inspectButton = await buttonState(page, '#btn-youtube-inspect');
  result.scheduleButtonBeforePrepare = await buttonState(page, '#btn-youtube-schedule');

  if (!result.prepareButton.disabled) {
    await page.locator('#btn-youtube-prepare').click();
    await page.waitForFunction(() => document.querySelector('#btn-youtube-prepare')?.textContent.trim() === 'Prepare Next', null, { timeout: 90000 });
    result.prepareClicked = true;
    result.prepareResultText = await page.locator('#shorts-youtube-status').innerText().catch(() => null);
    result.jobCountAfterPrepare = await page.evaluate(projectId => window.api.getShortsStatus(projectId), target.project.id)
      .then(status => (status.youtubeJobs || []).length);
  }

  result.scheduleButtonAfterPrepare = await buttonState(page, '#btn-youtube-schedule');
  if (!result.scheduleButtonAfterPrepare.disabled) {
    await page.evaluate(() => {
      window.__ytSmokeConfirmCalled = false;
      window.__ytSmokeScheduleApiCalled = false;
      const original = window.api.scheduleYouTubeShortPublishJob;
      window.api.scheduleYouTubeShortPublishJob = (...args) => {
        window.__ytSmokeScheduleApiCalled = true;
        return original(...args);
      };
      window.confirm = () => {
        window.__ytSmokeConfirmCalled = true;
        return false;
      };
    });
    await page.locator('#btn-youtube-schedule').click();
    await page.waitForTimeout(500);
    const confirmProof = await page.evaluate(() => ({
      confirmCalled: window.__ytSmokeConfirmCalled === true,
      scheduleApiCalled: window.__ytSmokeScheduleApiCalled === true,
    }));
    result.confirmCalled = confirmProof.confirmCalled;
    result.scheduleApiCalledAfterConfirmFalse = confirmProof.scheduleApiCalled;
  }

  await page.screenshot({ path: result.screenshot, fullPage: true });
} finally {
  await app.close().catch(() => {});
}

console.log(JSON.stringify(result, null, 2));

function pickJobFields(job) {
  return job ? {
    id: job.id,
    short_id: job.short_id,
    short_number: job.short_number,
    status: job.status,
    scheduled_date: job.scheduled_date,
    scheduled_time: job.scheduled_time,
    remote_post_id: job.remote_post_id,
    remote_url: job.remote_url,
  } : null;
}

async function buttonState(page, selector) {
  return page.locator(selector).evaluate(node => ({
    text: node.textContent.trim(),
    disabled: Boolean(node.disabled),
    title: node.getAttribute('title') || '',
  }));
}

async function retry(fn, timeoutMs) {
  const start = Date.now();
  let lastError;
  while (Date.now() - start < timeoutMs) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  throw lastError || new Error('retry timed out');
}
