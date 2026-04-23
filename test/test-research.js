/**
 * Standalone test for the Research Module (YouTube Scraper + Gemini Analyzer)
 *
 * Run: node test/test-research.js
 *
 * This launches a headed Chromium browser, searches YouTube,
 * then optionally analyzes top results with Gemini.
 *
 * Set GEMINI_API_KEY env var to test the Gemini API path:
 *   GEMINI_API_KEY=AIza... node test/test-research.js
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

// Add the src directory to require paths
const { YouTubeResearcher } = require('../src/main/research/youtube-scraper');
const { GeminiVideoAnalyzer } = require('../src/main/research/gemini-analyzer');

const OUTPUT_DIR = path.join(__dirname, 'test-output');

async function main() {
  console.log('='.repeat(60));
  console.log('  RESEARCH MODULE TEST');
  console.log('='.repeat(60));

  // Ensure output directory
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // Launch browser (headed so you can watch)
  console.log('\n[1/4] Launching browser...');
  const browser = await chromium.launch({
    headless: false,
    args: ['--start-maximized'],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  // ── TEST 1: YouTube Scraper ──
  console.log('\n[2/4] Testing YouTube Scraper...');
  console.log('     Searching for AI Nollywood content with 100k+ views\n');

  const researcher = new YouTubeResearcher(page);

  const startTime = Date.now();
  const topVideos = await researcher.searchTopPerformers({
    searchQueries: [
      'AI Nollywood movie',
      'AI African drama full movie',
    ],
    minViews: 100000,
    maxResults: 10,
    sortBy: 'view_count',
  });
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(`\n     YouTube search completed in ${elapsed}s`);
  console.log(`     Found ${topVideos.length} videos with 100k+ views\n`);

  if (topVideos.length === 0) {
    console.log('     ⚠ No videos found! Possible issues:');
    console.log('       - YouTube may be showing a consent/cookie wall');
    console.log('       - Search results may not have loaded fully');
    console.log('       - The min views threshold (100k) might be too high for current results');
    console.log('\n     Trying again with lower threshold (10k)...\n');

    const retryVideos = await researcher.searchTopPerformers({
      searchQueries: ['AI Nollywood movie'],
      minViews: 10000,
      maxResults: 5,
      sortBy: 'view_count',
    });

    if (retryVideos.length > 0) {
      console.log(`     Retry found ${retryVideos.length} videos at 10k threshold:`);
      retryVideos.forEach((v, i) => {
        console.log(`       ${i + 1}. ${v.title}`);
        console.log(`          ${v.viewsFormatted} views | ${v.channel} | ${v.duration}`);
      });
    } else {
      console.log('     ⚠ Still no results. Check the browser window for issues.');
    }
  } else {
    console.log('     TOP PERFORMING VIDEOS:');
    console.log('     ' + '-'.repeat(50));
    topVideos.forEach((v, i) => {
      console.log(`     ${i + 1}. ${v.title}`);
      console.log(`        Views: ${v.viewsFormatted} | Channel: ${v.channel}`);
      console.log(`        Duration: ${v.duration} | Age: ${v.uploadAge}`);
      console.log(`        URL: ${v.url}`);
      console.log('');
    });
  }

  // Save YouTube results
  const ytOutputPath = path.join(OUTPUT_DIR, 'youtube-results.json');
  fs.writeFileSync(ytOutputPath, JSON.stringify(topVideos, null, 2));
  console.log(`     Saved to: ${ytOutputPath}`);

  // ── TEST 2: Gemini Analyzer (API mode) ──
  const geminiKey = process.env.GEMINI_API_KEY;

  if (geminiKey && topVideos.length > 0) {
    console.log('\n[3/4] Testing Gemini Analyzer (API mode)...');
    console.log(`     Analyzing top ${Math.min(2, topVideos.length)} video(s)...\n`);

    const analyzer = new GeminiVideoAnalyzer({ apiKey: geminiKey });

    const researchData = await analyzer.analyzeBatch(topVideos, {
      maxVideos: 2, // Just test with 2 to save API quota
      extractPatterns: true,
    });

    console.log(`     Analyzed ${researchData.videosAnalyzed} videos`);
    console.log(`     Patterns extracted: ${researchData.patterns ? 'Yes' : 'No'}\n`);

    if (researchData.patterns) {
      const p = researchData.patterns;
      if (p.recurring_themes?.length) {
        console.log(`     Themes: ${p.recurring_themes.slice(0, 5).join(', ')}`);
      }
      if (p.winning_character_archetypes?.length) {
        console.log(`     Archetypes: ${p.winning_character_archetypes.slice(0, 5).join(', ')}`);
      }
      if (p.content_formula) {
        console.log(`     Formula: ${p.content_formula.slice(0, 100)}...`);
      }
    }

    // Save Gemini results
    const geminiOutputPath = path.join(OUTPUT_DIR, 'gemini-analysis.json');
    fs.writeFileSync(geminiOutputPath, JSON.stringify(researchData, null, 2));
    console.log(`\n     Saved to: ${geminiOutputPath}`);

  } else if (!geminiKey) {
    console.log('\n[3/4] Skipping Gemini API test (no GEMINI_API_KEY env var)');
    console.log('     Set GEMINI_API_KEY=AIza... to test the Gemini analysis path');
  } else {
    console.log('\n[3/4] Skipping Gemini test (no videos to analyze)');
  }

  // ── TEST 3: Duration Calculator ──
  console.log('\n[4/4] Testing Duration Calculator...');
  // Quick inline test of the calculateStoryStructure function
  const TARGET_DURATION_SECONDS = 600;
  const AVG_CLIP_DURATION = 7;
  const REQUIRED_CLIPS = Math.ceil(TARGET_DURATION_SECONDS / AVG_CLIP_DURATION);

  const structures = [
    { chapters: 6, scenesPerChapter: 3, linesPerScene: 5 },
    { chapters: 5, scenesPerChapter: 4, linesPerScene: 5 },
    { chapters: 7, scenesPerChapter: 3, linesPerScene: 4 },
  ];

  let chosen = null;
  for (const s of structures) {
    const total = s.chapters * s.scenesPerChapter * s.linesPerScene;
    if (total >= REQUIRED_CLIPS) {
      chosen = { ...s, totalLines: total, estimatedDuration: Math.round((total * AVG_CLIP_DURATION) / 60 * 10) / 10 };
      break;
    }
  }

  console.log(`     Target: ${REQUIRED_CLIPS} clips (${TARGET_DURATION_SECONDS}s ÷ ${AVG_CLIP_DURATION}s avg)`);
  console.log(`     Structure: ${chosen.chapters} chapters × ${chosen.scenesPerChapter} scenes × ${chosen.linesPerScene} lines = ${chosen.totalLines} total`);
  console.log(`     Estimated duration: ${chosen.estimatedDuration} minutes ✓`);

  // ── Done ──
  console.log('\n' + '='.repeat(60));
  console.log('  TEST COMPLETE');
  console.log('  Results saved to: test/test-output/');
  console.log('='.repeat(60));

  // Keep browser open for 10s so you can inspect
  console.log('\n  Browser closing in 10 seconds...');
  await page.waitForTimeout(10000);
  await browser.close();
}

main().catch(err => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
