/**
 * Regression checks for the Shorts tab YouTube UI wiring.
 *
 * Run: node test/test-shorts-youtube-renderer-ui.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

function read(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

function testRendererContainsYouTubeControls() {
  const html = read('src/renderer/index.html');
  [
    'shorts-youtube-section',
    'btn-youtube-prepare',
    'btn-youtube-inspect',
    'btn-youtube-schedule',
    'shorts-youtube-date',
    'shorts-youtube-time',
    'shorts-youtube-jobs',
  ].forEach(id => {
    assert(html.includes(id), `missing renderer id: ${id}`);
  });

  [
    'prepareNextYouTubeShort()',
    'inspectYouTubeShortWizard()',
    'scheduleYouTubeShort()',
    'updateShortsYouTubeButtons()',
  ].forEach(handler => {
    assert(html.includes(handler), `missing renderer handler: ${handler}`);
  });
}

function testRendererCallsPreloadApiMethods() {
  const html = read('src/renderer/index.html');
  [
    'window.api.prepareNextYouTubeShortPublishJob',
    'window.api.inspectYouTubeUploadWizard',
    'window.api.scheduleYouTubeShortPublishJob',
  ].forEach(call => {
    assert(html.includes(call), `missing renderer API call: ${call}`);
  });
  assert(html.includes('window.confirm('), 'schedule action must keep an explicit confirmation');
  assert(html.includes('confirmSchedule: true'), 'schedule call must pass confirmSchedule=true');
}

function testPreloadAndMainExposeYouTubeShortsApi() {
  const preload = read('src/preload/preload.js');
  const main = read('src/main/main.js');
  [
    'prepareYouTubeShortPublishJob',
    'prepareNextYouTubeShortPublishJob',
    'inspectYouTubeUploadWizard',
    'scheduleYouTubeShortPublishJob',
    'scheduleNextYouTubeShortPublishJob',
  ].forEach(name => {
    assert(preload.includes(name), `missing preload API: ${name}`);
  });
  [
    'shorts:prepareYouTubePublishJob',
    'shorts:prepareNextYouTubePublishJob',
    'shorts:inspectYouTubeUploadWizard',
    'shorts:scheduleYouTubePublishJob',
    'shorts:scheduleNextYouTubePublishJob',
  ].forEach(channel => {
    assert(main.includes(channel), `missing main IPC channel: ${channel}`);
  });
}

function testInlineScriptsParse() {
  const html = read('src/renderer/index.html');
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
  assert(scripts.length > 0, 'renderer should contain inline scripts');
  scripts.forEach((code, index) => {
    new vm.Script(code, { filename: `renderer-inline-${index}.js` });
  });
}

function main() {
  testRendererContainsYouTubeControls();
  testRendererCallsPreloadApiMethods();
  testPreloadAndMainExposeYouTubeShortsApi();
  testInlineScriptsParse();
  console.log('test-shorts-youtube-renderer-ui passed');
}

main();
