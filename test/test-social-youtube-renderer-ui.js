#!/usr/bin/env node
/**
 * Regression checks for Engagement tab YouTube Community UI wiring.
 *
 * Run: node test/test-social-youtube-renderer-ui.js
 */

const assert = require('assert');
const fs = require('fs');

function testRendererContainsYouTubeCommunityControls() {
  const html = fs.readFileSync('src/renderer/index.html', 'utf8');
  [
    'btn-prepare-youtube-community',
    'btn-inspect-youtube-community',
    'btn-schedule-youtube-community',
    'prepareYouTubeCommunityPosts()',
    'inspectYouTubeCommunityComposer()',
    'scheduleAllYouTubeCommunityPosts()',
    'socialYoutubeCommunityJobs',
    'socialYoutubeShortCompanions',
    'youtubeCommunitySummary',
    'youtubeShortCompanionSummary',
    'window.api.prepareYouTubeCommunityPosts',
    'window.api.inspectYouTubeCommunityComposer',
    'window.api.scheduleAllYouTubeCommunityPosts',
    'confirmSchedule: true',
    'YouTube Community',
    'Prepare YT Companions',
    'Schedule YT Companions',
    'missing 6 PM Short proof',
    'youtubeShortAnchorReady',
    'Schedule 6 PM YouTube Short first. YouTube Community cannot lead.',
  ].forEach(needle => {
    assert(html.includes(needle), `renderer missing ${needle}`);
  });
}

function testPreloadAndMainExposeYouTubeCommunityApis() {
  const preload = fs.readFileSync('src/preload/preload.js', 'utf8');
  const main = fs.readFileSync('src/main/main.js', 'utf8');

  [
    'prepareYouTubeCommunityPosts',
    'inspectYouTubeCommunityComposer',
    'scheduleYouTubeCommunityPostJob',
    'scheduleAllYouTubeCommunityPosts',
  ].forEach(needle => {
    assert(preload.includes(needle), `preload missing ${needle}`);
  });

  [
    'social:prepareYouTubeCommunity',
    'social:inspectYouTubeCommunityComposer',
    'social:scheduleYouTubeCommunityJob',
    'social:scheduleAllYouTubeCommunity',
  ].forEach(needle => {
    assert(main.includes(needle), `main IPC missing ${needle}`);
    assert(preload.includes(needle), `preload IPC missing ${needle}`);
  });
}

function main() {
  testRendererContainsYouTubeCommunityControls();
  testPreloadAndMainExposeYouTubeCommunityApis();
  console.log('test-social-youtube-renderer-ui passed');
}

main();
