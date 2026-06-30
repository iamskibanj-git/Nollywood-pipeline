import fs from 'node:fs/promises';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { chromium } from 'playwright';
import { pipelineConfig } from './config.js';

let pinterestAutocompleteSuppressed = false;

export async function scrapeTopics({ config = pipelineConfig, logger = console, db = null, runId = null } = {}) {
  const startedAt = new Date().toISOString();
  const browserConfig = config.browser || {};
  const scraperConfig = config.scraper || {};
  const log = makeLogger(logger);

  let browser = null;
  let context = null;
  let page = null;

  try {
    if (browserConfig.userDataDir) {
      context = await chromium.launchPersistentContext(browserConfig.userDataDir, {
        headless: browserConfig.headless === true,
        viewport: browserConfig.viewport || { width: 1400, height: 900 },
        args: ['--disable-blink-features=AutomationControlled'],
      });
    } else {
      browser = await chromium.launch({
        headless: browserConfig.headless === true,
        args: ['--disable-blink-features=AutomationControlled'],
      });
      context = await browser.newContext({
        viewport: browserConfig.viewport || { width: 1400, height: 900 },
      });
    }

    page = context.pages()[0] || await context.newPage();
    page.setDefaultTimeout(scraperConfig.sourceTimeoutMs || 30000);

    if (browserConfig.pauseForManualLogin !== false || Number(browserConfig.loginWaitMs || 0) > 0) {
      await showLoginHoldingPage(page, browserConfig);
      await waitForManualContinue(log, browserConfig);
    }

    const pages = [];
    for (let nicheIndex = 0; nicheIndex < config.niches.length; nicheIndex++) {
      const niche = config.niches[nicheIndex];
      log.info(`[SCRAPER] Niche start: ${niche.id} (${niche.name})`);
      const items = [];

      const sourceDefinitions = [
        ['reddit', () => scrapeReddit(page, niche, scraperConfig, log)],
        ['google_trends', () => scrapeGoogleTrends(page, niche, scraperConfig, log)],
        ['pinterest', () => scrapePinterest(page, niche, scraperConfig, log)],
        ['youtube', () => scrapeYouTubeAutocomplete(page, niche, scraperConfig, browserConfig, log)],
        ['quora', () => scrapeQuora(page, niche, scraperConfig, log, nicheIndex, config.niches.length)],
      ];
      const enabledSources = getEnabledSources(scraperConfig.sources);
      const sources = enabledSources
        ? sourceDefinitions.filter(([sourceName]) => enabledSources.has(sourceName))
        : sourceDefinitions;

      if (sources.length === 0) {
        log.warn(`[SCRAPER] ${niche.id}: no enabled sources; skipping niche.`);
      }

      for (const [sourceName, runSource] of sources) {
        try {
          db?.markSourcePullStart?.(runId, niche, sourceName);
          const sourceItems = await runSource();
          items.push(...sourceItems);
          db?.markSourcePullDone?.(runId, niche, sourceName, sourceItems.length);
          log.info(`[SCRAPER] ${niche.id}/${sourceName}: ${sourceItems.length} item(s)`);
        } catch (error) {
          db?.markSourcePullFailed?.(runId, niche, sourceName, error);
          log.warn(`[SCRAPER] ${niche.id}/${sourceName} failed; continuing`, error.message);
        }
      }

      const merged = mergeTopicSignals(items);
      pages.push({
        niche_id: niche.id,
        niche_name: niche.name,
        facebook_page_name: niche.facebook_page_name || niche.name,
        generated_at: new Date().toISOString(),
        items: merged,
      });
      log.info(`[SCRAPER] Niche done: ${niche.id} (${merged.length} unique raw item(s))`);
    }

    const outputJson = {
      generated_at: startedAt,
      run_id: runId || null,
      pages,
      totals: {
        niches: pages.length,
        items: pages.reduce((sum, pageInfo) => sum + pageInfo.items.length, 0),
      },
    };

    db?.saveRawTopics?.(runId, outputJson);
    await fs.writeFile(config.files.rawTopics, `${JSON.stringify(outputJson, null, 2)}\n`, 'utf8');
    log.info(`[SCRAPER] Wrote ${config.files.rawTopics}`, outputJson.totals);
    return outputJson;
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

async function showLoginHoldingPage(page, browserConfig = {}) {
  const loginWaitMs = Number(browserConfig.loginWaitMs || 0);
  const waitSeconds = Math.ceil(loginWaitMs / 1000);
  await page.goto('about:blank');
  await page.setContent(`
    <!doctype html>
    <html>
      <head>
        <title>Content Research Pipeline</title>
        <style>
          body { font: 18px/1.45 system-ui, sans-serif; padding: 48px; color: #172033; }
          code { background: #eef1f6; padding: 2px 6px; border-radius: 4px; }
          a { color: #0b57d0; display: inline-block; margin: 4px 0; }
          .timer { margin-top: 24px; font-weight: 700; }
        </style>
      </head>
      <body>
        <h1>Content Research Pipeline</h1>
        <p>Log in to any required source sites in this browser before scraping starts.</p>
        ${loginWaitMs > 0
          ? `<p class="timer">Timed login wait: <span id="countdown">${waitSeconds}</span> second(s) remaining.</p>`
          : '<p>Return to the terminal and press Enter when login is complete.</p>'}
        <p>Common login/check links:</p>
        <ul>
          <li><a href="https://www.pinterest.com/login/">Pinterest login</a></li>
          <li><a href="https://www.facebook.com/">Facebook</a></li>
          <li><a href="https://www.quora.com/">Quora</a></li>
          <li><a href="https://trends.google.com/trends/">Google Trends</a></li>
          <li><a href="https://www.reddit.com/">Reddit</a></li>
        </ul>
        <p>Set <code>CONTENT_RESEARCH_SKIP_LOGIN_PAUSE=1</code> to skip this page during test runs.</p>
        <p>Or pass <code>--login-wait-sec 120</code> to hold this browser open for a fixed login window.</p>
        ${loginWaitMs > 0 ? `
        <script>
          let remaining = ${waitSeconds};
          const node = document.getElementById('countdown');
          setInterval(() => {
            remaining = Math.max(0, remaining - 1);
            if (node) node.textContent = String(remaining);
          }, 1000);
        </script>
        ` : ''}
      </body>
    </html>
  `);
}

async function waitForManualContinue(log, browserConfig = {}) {
  const loginWaitMs = Number(browserConfig.loginWaitMs || 0);
  if (loginWaitMs > 0) {
    log.info(`[SCRAPER] Timed login wait active for ${Math.ceil(loginWaitMs / 1000)} second(s). Use the browser to log in now.`);
    await new Promise(resolve => setTimeout(resolve, loginWaitMs));
    log.info('[SCRAPER] Timed login wait complete; starting scrape.');
    return;
  }

  if (!input.isTTY) {
    log.warn('[SCRAPER] stdin is not interactive; skipping manual login pause.');
    return;
  }
  const rl = readline.createInterface({ input, output });
  try {
    await rl.question('Log in to all required sites, then press Enter to continue...');
  } finally {
    rl.close();
  }
}

async function scrapeReddit(page, niche, scraperConfig, log) {
  const limit = scraperConfig.redditPostsPerSubreddit || 20;
  const minBeforeBackup = scraperConfig.redditMinItemsBeforeBackup || 40;
  const maxPerNiche = scraperConfig.redditMaxItemsPerNiche || 70;
  const primaryMinUpvotes = scraperConfig.redditMinUpvotesPrimary || 100;
  const backupMinUpvotes = scraperConfig.redditMinUpvotesBackup || 100;
  const groups = getRedditSubredditGroups(niche);
  let all = [];

  const scrapeGroup = async (subreddits, groupName, minUpvotes) => {
    for (const subreddit of subreddits || []) {
      if (all.length >= maxPerNiche) break;
      let rows = [];
      try {
        rows = await scrapeRedditSubreddit(page, {
          subreddit,
          nicheId: niche.id,
          groupName,
          minUpvotes,
          limit,
          scraperConfig,
          log,
        });
      } catch (error) {
        log.warn(`[SCRAPER] reddit:${subreddit} (${groupName}) failed; continuing`, error.message);
      }
      all.push(...rows);
      all = mergeTopicSignals(all).sort((a, b) => Number(b.engagement || 0) - Number(a.engagement || 0));
      log.info(`[SCRAPER] reddit:${subreddit} (${groupName}, min ${minUpvotes} upvotes): ${rows.length}`);
    }
  };

  await scrapeGroup(groups.primary, 'primary', primaryMinUpvotes);

  if (all.length < minBeforeBackup && groups.backup.length > 0) {
    log.info(`[SCRAPER] ${niche.id}/reddit: ${all.length} item(s) after primaries; opening backups.`);
    await scrapeGroup(groups.backup, 'backup', backupMinUpvotes);
  }

  return all.slice(0, maxPerNiche);
}

async function scrapeRedditSubreddit(page, { subreddit, nicheId, groupName, minUpvotes, limit, scraperConfig, log }) {
  const url = `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/top/?t=month`;
  await gotoAndSettle(page, url, scraperConfig);
  await dismissCommonPopups(page);
  await autoScroll(page, 2);

  let rows = [];
  try {
    rows = await page.evaluate(({ maxItems, minUpvotes }) => {
      const norm = (text) => String(text || '').replace(/\s+/g, ' ').trim();
      const parseCompactNumber = (text) => {
        const match = String(text || '').match(/([\d,.]+)\s*([kKmM])?/);
        const rawNumber = match?.[1];
        if (!rawNumber) return 0;
        let value = Number(String(rawNumber).replace(/,/g, ''));
        if (!Number.isFinite(value)) return 0;
        if (/k/i.test(match?.[2] || '')) value *= 1000;
        if (/m/i.test(match?.[2] || '')) value *= 1000000;
        return Math.round(value);
      };
      const parseByLabel = (text, labels) => {
        const labelList = Array.isArray(labels) ? labels : [labels];
        const matches = String(text || '').matchAll(/([\d,.]+)\s*([kKmM])?\s*(upvotes?|votes?|points?|comments?|replies?)/gi);
        for (const match of matches) {
          const label = String(match?.[3] || '').toLowerCase();
          if (!labelList.some(value => label.startsWith(value))) continue;
          const count = parseCompactNumber(`${match?.[1] || ''}${match?.[2] || ''}`);
          if (count > 0) return count;
        }
        return 0;
      };
      const parseAttributeCount = (card, names) => {
        for (const name of names) {
          const value = parseCompactNumber(card.getAttribute(name));
          if (value > 0) return value;
        }
        return 0;
      };
      const parseAriaCount = (card, labels) => {
        const selector = labels.map(label => `[aria-label*="${label}" i]`).join(', ');
        const node = selector ? card.querySelector(selector) : null;
        return parseByLabel(node?.getAttribute('aria-label'), labels);
      };
      const parseMetric = (card, text, labels, attributes) => Math.max(
        parseAttributeCount(card, attributes),
        parseAriaCount(card, labels),
        parseByLabel(text, labels)
      );
      const titleLooksPinned = (title) => /^(?:\[?mod\]?|\[?meta\]?|\[?announcement\]?|daily thread|weekly thread|monthly thread|megathread)\b/i.test(title);
      const isPinnedOrMod = (card, title, text) => {
        const attrs = [
          card?.getAttribute?.('stickied'),
          card?.getAttribute?.('pinned'),
          card?.getAttribute?.('data-stickied'),
          card?.getAttribute?.('data-pinned'),
          card?.getAttribute?.('distinguished'),
        ].join(' ').toLowerCase();
        if (/\btrue\b|stickied|pinned|moderator/.test(attrs)) return true;
        if (titleLooksPinned(title)) return true;
        return /\[mod\]|moderator announcement|pinned by moderators|stickied post|mod post/i.test(text);
      };
      const out = [];
      const seen = new Set();
      const add = ({ title, card, text, scrapeMode }) => {
        title = norm(title);
        if (!title || title.length < 8 || title.length > 280) return;
        const key = title.toLowerCase();
        if (seen.has(key)) return;
        if (isPinnedOrMod(card, title, text)) return;
        const upvotes = parseMetric(card, text, ['upvote', 'vote', 'point'], ['score', 'upvote-count', 'data-score', 'data-upvotes']);
        if (upvotes < minUpvotes) return;
        const comments = parseMetric(card, text, ['comment', 'repl'], ['comment-count', 'comments-count', 'data-comments']);
        seen.add(key);
        out.push({
          title,
          engagement: upvotes + comments * 3,
          engagement_detail: { upvotes, comments, scrape_mode: scrapeMode },
        });
      };

      for (const card of document.querySelectorAll('shreddit-post, article, [data-testid="post-container"]')) {
        const title =
          norm(card.getAttribute('post-title')) ||
          norm(card.querySelector('[slot="title"]')?.textContent) ||
          norm(card.querySelector('h3')?.textContent) ||
          norm(card.querySelector('[data-testid="post-title"]')?.textContent) ||
          norm(card.querySelector('a[href*="/comments/"]')?.textContent);
        add({ title, card, text: norm(card.textContent), scrapeMode: 'dom' });
        if (out.length >= maxItems) return out;
      }

      for (const link of document.querySelectorAll('a[href*="/comments/"]')) {
        const parent = link.closest('article, shreddit-post, div') || link;
        add({
          title: link.textContent || link.getAttribute('aria-label'),
          card: parent,
          text: norm(parent.textContent),
          scrapeMode: 'dom-link',
        });
        if (out.length >= maxItems) return out;
      }

      return out;
    }, { maxItems: limit, minUpvotes });
  } catch (error) {
    log?.warn?.(`[SCRAPER] reddit:${subreddit} DOM scrape failed; trying JSON fallback`, error.message);
  }

  if (rows.length === 0) {
    const fallbackRows = await scrapeRedditJsonFallback(page, {
      subreddit,
      minUpvotes,
      limit,
      scraperConfig,
    });
    if (fallbackRows.length > 0) {
      log?.info?.(`[SCRAPER] reddit:${subreddit} JSON fallback: ${fallbackRows.length} item(s)`);
      rows = fallbackRows;
    }
  }

  return normalizeItems(rows, `reddit:${subreddit}`, nicheId, limit).map(row => ({
    ...row,
    engagement_detail: {
      ...(row.engagement_detail || {}),
      subreddit,
      subreddit_group: groupName,
      min_upvotes: minUpvotes,
    },
  }));
}

async function scrapeRedditJsonFallback(page, { subreddit, minUpvotes, limit, scraperConfig }) {
  const jsonLimit = Math.max(Number(limit) * 2 || 40, 50);
  const url = `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/top.json?t=month&limit=${jsonLimit}`;
  try {
    await gotoAndSettle(page, url, {
      ...scraperConfig,
      settleMs: Math.min(scraperConfig.settleMs || 2500, 1000),
    });
    const bodyText = await page.locator('body').innerText({ timeout: scraperConfig.sourceTimeoutMs || 30000 });
    const parsed = JSON.parse(bodyText);
    const children = Array.isArray(parsed?.data?.children) ? parsed.data.children : [];
    const out = [];
    const seen = new Set();

    for (const child of children) {
      const post = child?.data || {};
      const title = cleanTitle(post.title);
      const key = title.toLowerCase();
      if (!title || seen.has(key)) continue;
      if (post.stickied || post.pinned || post.distinguished) continue;
      if (/^(?:\[?mod\]?|\[?meta\]?|\[?announcement\]?|daily thread|weekly thread|monthly thread|megathread)\b/i.test(title)) continue;

      const upvotes = Number.isFinite(Number(post.ups)) ? Number(post.ups) : 0;
      const comments = Number.isFinite(Number(post.num_comments)) ? Number(post.num_comments) : 0;
      if (upvotes < minUpvotes) continue;

      seen.add(key);
      out.push({
        title,
        engagement: upvotes + comments * 3,
        engagement_detail: {
          upvotes,
          comments,
          scrape_mode: 'json',
          permalink: post.permalink || null,
        },
      });
      if (out.length >= limit) break;
    }

    return out;
  } catch (_) {
    return [];
  }
}

function getRedditSubredditGroups(niche) {
  if (niche?.reddit) {
    return {
      primary: Array.isArray(niche.reddit.primary) ? niche.reddit.primary : [],
      backup: Array.isArray(niche.reddit.backup) ? niche.reddit.backup : [],
    };
  }
  return {
    primary: Array.isArray(niche?.subreddits) ? niche.subreddits : [],
    backup: [],
  };
}

async function scrapeGoogleTrends(page, niche, scraperConfig, log) {
  const keywords = getGoogleTrendsKeywords(niche);
  const maxPerNiche = scraperConfig.googleTrendsMaxItemsPerNiche || 50;
  const all = [];

  for (let index = 0; index < keywords.length; index++) {
    const keyword = keywords[index];
    if (index > 0) {
      await waitWithJitter(
        page,
        scraperConfig.googleTrendsDelayMinMs || 2000,
        scraperConfig.googleTrendsDelayMaxMs || 3000
      );
    }

    try {
      const rows = await scrapeGoogleTrendsSeed(page, {
        keyword,
        nicheId: niche.id,
        scraperConfig,
        log,
      });
      all.push(...rows);
      log.info(`[SCRAPER] google_trends:${keyword}: ${rows.length} item(s)`);
    } catch (error) {
      log.warn(`[SCRAPER] google_trends:${keyword} failed; continuing`, error.message);
    }
  }

  return mergeTopicSignals(all)
    .sort((a, b) => Number(b.engagement || 0) - Number(a.engagement || 0))
    .slice(0, maxPerNiche);
}

async function scrapeGoogleTrendsSeed(page, { keyword, nicheId, scraperConfig, log }) {
  const geo = scraperConfig.googleTrendsGeo || 'US';
  const date = scraperConfig.googleTrendsDate || 'now 7-d';
  const limit = scraperConfig.googleTrendsItemsPerSeed || 25;
  const minRising = scraperConfig.googleTrendsMinRisingBeforeTop || 5;
  const renderTimeout = scraperConfig.googleTrendsRenderTimeoutMs || 15000;
  const params = new URLSearchParams({ q: keyword, geo, date });
  const url = `https://trends.google.com/trends/explore?${params.toString()}`;

  await gotoAndSettle(page, url, { ...scraperConfig, settleMs: 6000 });
  await dismissCommonPopups(page);

  let rendered = true;
  try {
    await page.waitForSelector('.related-queries-table, .fe-related-queries, trends-widget', {
      timeout: renderTimeout,
    });
  } catch (error) {
    await autoScroll(page, 1);
    await page.waitForTimeout(3000);
    rendered = await page.locator('.related-queries-table, .fe-related-queries, trends-widget').first().count()
      .then(count => count > 0)
      .catch(() => false);
    if (!rendered) {
      log.warn(`[SCRAPER] google_trends:${keyword}: related queries did not render in ${renderTimeout}ms; trying fallback`);
    }
  }

  await autoScroll(page, 2);

  const rows = [];
  if (rendered) {
    const risingQueries = await scrapeGoogleTrendsSection(page, {
      keyword,
      geo,
      date,
      sectionKey: 'related_queries',
      sectionLabel: 'Related queries',
      tab: 'rising',
      maxItems: limit,
    });
    rows.push(...risingQueries);

    if (risingQueries.length < minRising) {
      const topQueries = await scrapeGoogleTrendsSection(page, {
        keyword,
        geo,
        date,
        sectionKey: 'related_queries',
        sectionLabel: 'Related queries',
        tab: 'top',
        maxItems: limit,
      });
      rows.push(...topQueries);
    }

    const risingTopics = await scrapeGoogleTrendsSection(page, {
      keyword,
      geo,
      date,
      sectionKey: 'related_topics',
      sectionLabel: 'Related topics',
      tab: 'rising',
      maxItems: Math.ceil(limit / 2),
    });
    rows.push(...risingTopics);
  }

  if (rows.length === 0) {
    rows.push(...await scrapeGoogleTrendsBroadFallback(page, { keyword, geo, date, maxItems: limit }));
  }

  return normalizeItems(rows, 'google_trends', nicheId, limit);
}

async function scrapeGoogleTrendsSection(page, { keyword, geo, date, sectionKey, sectionLabel, tab, maxItems }) {
  await selectGoogleTrendsTab(page, sectionLabel, tab);
  await page.waitForTimeout(900);

  return page.evaluate((options) => {
    const norm = (text) => String(text || '').replace(/\s+/g, ' ').trim();
    const lower = (text) => norm(text).toLowerCase();
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const valueScore = (value, tabName) => {
      if (/breakout/i.test(value)) return 999;
      const match = String(value || '').match(/\+?([\d,]+)%/);
      if (match) return Number(match[1].replace(/,/g, '')) || 0;
      if (tabName === 'top') return 10;
      return 1;
    };
    const cleanTrendTitle = (text, value) => norm(text)
      .replace(value || '', '')
      .replace(/\b(?:Breakout|\+?[\d,]+%)\b/gi, '')
      .replace(/\b(?:Search term|Topic|Rising|Top|Related queries|Related topics)\b/gi, '')
      .replace(/^\d{1,2}\s+(?=[A-Za-z])/, '')
      .replace(/\s+/g, ' ')
      .trim();
    const bad = /^(Explore|Trending now|Recently trending|Search|Compare|Interest|Past|Worldwide|United States|Sign in|Help|Privacy|Terms|Loading)$/i;
    const sectionNeedle = options.sectionLabel.toLowerCase();
    const roots = [
      ...document.querySelectorAll('trends-widget, md-card, .fe-related-queries, .fe-related-topics, .related-queries-table, .related-topics-table, div'),
    ]
      .filter(isVisible)
      .filter(el => lower(el.textContent).includes(sectionNeedle))
      .sort((a, b) => norm(a.textContent).length - norm(b.textContent).length)
      .slice(0, 6);
    const scopes = roots.length > 0 ? roots : [document.body];
    const out = [];
    const seen = new Set();

    for (const scope of scopes) {
      const candidates = [
        ...scope.querySelectorAll('.item, tr, [role="row"], .progress-row, .fe-related-searches-item'),
      ].filter(isVisible);

      for (const row of candidates) {
        const rowText = norm(row.textContent);
        if (!rowText || rowText.length < 4 || rowText.length > 220) continue;
        const value = norm(row.querySelector('.value, [class*="value"], [aria-label*="percent" i]')?.textContent) ||
          (rowText.match(/Breakout|\+?[\d,]+%/i)?.[0] || '');
        const label = norm(row.querySelector('.label-text, [class*="label"], [class*="query"], a')?.textContent) ||
          cleanTrendTitle(rowText, value);
        const title = cleanTrendTitle(label, value);
        if (!title || title.length < 4 || title.length > 100 || bad.test(title)) continue;
        const key = `${title.toLowerCase()}|${options.sectionKey}|${options.tab}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          title,
          source: `google_trends:${options.keyword}:${options.sectionKey}:${options.tab}`,
          engagement: valueScore(value, options.tab),
          engagement_detail: {
            seed: options.keyword,
            section: options.sectionKey,
            tab: options.tab,
            value: value || null,
            geo: options.geo,
            date: options.date,
          },
        });
        if (out.length >= options.maxItems) return out;
      }
    }

    return out;
  }, { keyword, geo, date, sectionKey, sectionLabel, tab, maxItems });
}

async function selectGoogleTrendsTab(page, sectionLabel, tab) {
  const tabLabel = tab === 'top' ? 'Top' : 'Rising';
  const clicked = await page.evaluate(({ sectionLabel, tabLabel }) => {
    const norm = (text) => String(text || '').replace(/\s+/g, ' ').trim();
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const sectionNeedle = sectionLabel.toLowerCase();
    const candidates = [
      ...document.querySelectorAll('trends-widget, md-card, .fe-related-queries, .fe-related-topics, div'),
    ]
      .filter(isVisible)
      .filter(el => norm(el.textContent).toLowerCase().includes(sectionNeedle))
      .sort((a, b) => norm(a.textContent).length - norm(b.textContent).length)
      .slice(0, 6);

    for (const scope of candidates) {
      const tabControls = [...scope.querySelectorAll('button, [role="tab"], md-tab-item, .md-tab')]
        .filter(isVisible)
        .filter(el => norm(el.textContent).toLowerCase() === tabLabel.toLowerCase() ||
          norm(el.getAttribute('aria-label')).toLowerCase() === tabLabel.toLowerCase());
      if (tabControls[0]) {
        tabControls[0].click();
        return true;
      }
    }
    return false;
  }, { sectionLabel, tabLabel }).catch(() => false);

  if (clicked) return;

  const selectors = [
    `button[aria-label="${tabLabel}"]`,
    `[role="tab"]:has-text("${tabLabel}")`,
    `md-tab-item:has-text("${tabLabel}")`,
    `.md-tab:has-text("${tabLabel}")`,
  ];
  for (const selector of selectors) {
    try {
      const locator = page.locator(selector).last();
      if (await locator.count()) {
        await locator.click({ timeout: 1500 });
        return;
      }
    } catch (_) {}
  }
}

async function scrapeGoogleTrendsBroadFallback(page, { keyword, geo, date, maxItems }) {
  const rows = await page.evaluate((options) => {
    const norm = (text) => String(text || '').replace(/\s+/g, ' ').trim();
    const cleanTrendTitle = (text) => norm(text)
      .replace(/\b(?:Breakout|\+?[\d,]+%)\b/gi, '')
      .replace(/\b(?:Search term|Topic|Rising|Top|Related queries|Related topics)\b/gi, '')
      .replace(/^\d{1,2}\s+(?=[A-Za-z])/, '')
      .replace(/\s+/g, ' ')
      .trim();
    const bad = /^(Explore|Trending now|Recently trending|Search|Compare|Interest|Related topics|Related queries|Rising|Top|Past|Worldwide|United States|Sign in|Help|Privacy|Terms|Loading)$/i;
    const scoreValue = (text) => {
      if (/Breakout/i.test(text)) return 999;
      const match = String(text || '').match(/\+?([\d,]+)%/);
      if (match) return Number(match[1].replace(/,/g, '')) || 0;
      return /Rising/i.test(text) ? 1 : 0;
    };
    const candidates = [];
    for (const el of document.querySelectorAll('td, span, div, a')) {
      const text = cleanTrendTitle(el.textContent);
      if (!text || text.length < 4 || text.length > 90 || bad.test(text)) continue;
      if (/^\+?\d+%$|^Breakout$/i.test(text)) continue;
      const context = norm(el.parentElement?.textContent || '');
      const engagement = scoreValue(context);
      candidates.push({
        title: text,
        source: `google_trends:${options.keyword}:fallback`,
        engagement,
        engagement_detail: {
          seed: options.keyword,
          section: 'fallback',
          tab: null,
          value: context.match(/Breakout|\+?[\d,]+%/i)?.[0] || null,
          geo: options.geo,
          date: options.date,
        },
      });
    }
    const seen = new Set();
    return candidates
      .filter(item => {
        const key = item.title.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => b.engagement - a.engagement)
      .slice(0, options.maxItems);
  }, { keyword, geo, date, maxItems });

  return rows;
}

function getGoogleTrendsKeywords(niche) {
  const configured = Array.isArray(niche?.google_trends_keywords) ? niche.google_trends_keywords : [];
  const values = configured.length > 0
    ? configured
    : [niche?.google_trends_keyword, niche?.name];
  const seen = new Set();
  return values
    .map(value => String(value || '').trim())
    .filter(Boolean)
    .filter(value => {
      const key = value.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

async function scrapePinterest(page, niche, scraperConfig, log) {
  const terms = Array.isArray(niche.pinterest_terms) ? niche.pinterest_terms : [];
  const all = [];
  const state = {
    autocompleteEnabled: scraperConfig.pinterestAutocompleteEnabled !== false && !pinterestAutocompleteSuppressed,
  };

  for (let index = 0; index < terms.length; index++) {
    const term = terms[index];
    if (index > 0) {
      await waitWithJitter(
        page,
        scraperConfig.pinterestDelayMinMs || 1500,
        scraperConfig.pinterestDelayMaxMs || 2500
      );
    }

    let termPage = null;
    try {
      termPage = await page.context().newPage();
      termPage.setDefaultTimeout(scraperConfig.sourceTimeoutMs || 30000);
      const rows = await runWithPageTimeout({
        page: termPage,
        timeoutMs: scraperConfig.pinterestTermTimeoutMs || 55000,
        label: `Pinterest term "${term}"`,
        task: () => scrapePinterestTerm(termPage, {
          term,
          nicheId: niche.id,
          scraperConfig,
          log,
          state,
        }),
      });
      all.push(...rows);
      log.info(`[SCRAPER] pinterest:${term}: ${rows.length} item(s)`);
    } catch (error) {
      log.warn(`[SCRAPER] pinterest:${term} failed; continuing`, error.message);
    } finally {
      if (termPage) await termPage.close().catch(() => {});
    }
  }

  if (all.length > 0 && scraperConfig.pinterestDelayBetweenNichesMs) {
    await page.waitForTimeout(scraperConfig.pinterestDelayBetweenNichesMs);
  }

  return all;
}

async function scrapePinterestTerm(page, { term, nicheId, scraperConfig, log, state = {} }) {
  const autocompleteLimit = scraperConfig.pinterestAutocompletePerTerm || 12;
  const pinLimit = scraperConfig.pinterestPinsPerTerm || 40;
  const minPinTitles = scraperConfig.pinterestMinPinTitlesPerTerm || 20;
  const rows = [];

  if (state.autocompleteEnabled) {
    await gotoAndSettle(page, 'https://www.pinterest.com/', { ...scraperConfig, settleMs: 2500 });
    await dismissCommonPopups(page);
    await dismissPinterestInterstitals(page);
  }

  const searchInput = page.locator([
    '[data-test-id="search-bar-input"]',
    '[data-test-id="search-box-input"]',
    'input[data-test-id*="search" i]',
    'input[aria-label*="Search" i]',
    'input[placeholder*="Search" i]',
  ].join(', ')).first();

  try {
    if (!state.autocompleteEnabled) {
      throw new Error('Pinterest autocomplete suppressed after previous unavailable search input');
    }
    await searchInput.waitFor({ timeout: scraperConfig.sourceTimeoutMs || 30000 });
    await searchInput.click({ timeout: 10000 });
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await page.keyboard.press('Backspace');
    await searchInput.type(term, { delay: 80 });
    await page.waitForSelector('[data-test-id="search-suggestion"], [data-test-id*="search-suggestion" i]', {
      timeout: 8000,
    }).catch(() => null);

    const suggestions = await page.evaluate(({ maxItems, term }) => {
      const norm = (text) => String(text || '').replace(/\s+/g, ' ').trim();
      const out = [];
      const seen = new Set();
      const selectors = [
        '[data-test-id="search-suggestion"]',
        '[data-test-id*="search-suggestion" i]',
        '[data-test-id*="typeahead" i]',
        '[role="listbox"] [role="option"]',
        '[role="option"]',
      ];
      for (const selector of selectors) {
        for (const el of document.querySelectorAll(selector)) {
          const title = norm(el.textContent || el.getAttribute('aria-label'));
          if (!title || title.length < 4 || title.length > 120) continue;
          const key = title.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({
            title,
            source: 'pinterest_autocomplete',
            engagement: 0,
            engagement_detail: { term, kind: 'autocomplete' },
          });
          if (out.length >= maxItems) return out;
        }
      }
      return out;
    }, { maxItems: autocompleteLimit, term });
    rows.push(...normalizeItems(suggestions, 'pinterest_autocomplete', nicheId, autocompleteLimit));

    await page.keyboard.press('Enter');
  } catch (error) {
    log.warn(`[SCRAPER] pinterest:${term}: autocomplete unavailable; using results URL`, error.message);
    state.autocompleteEnabled = false;
    pinterestAutocompleteSuppressed = true;
    await gotoAndSettle(page, `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(term)}`, {
      ...scraperConfig,
      settleMs: 3000,
    });
  }

  await dismissPinterestInterstitals(page);
  try {
    await page.waitForSelector('[data-test-id="pin"], [data-test-id*="pin" i], [data-grid-item="true"]', { timeout: 10000 });
  } catch (_) {
    await gotoAndSettle(page, `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(term)}`, {
      ...scraperConfig,
      settleMs: 3000,
    });
    await dismissPinterestInterstitals(page);
    await page.waitForSelector('[data-test-id="pin"], [data-test-id*="pin" i], [data-grid-item="true"]', { timeout: 10000 });
  }

  await page.evaluate(() => window.scrollBy(0, 1500)).catch(() => {});
  await page.waitForTimeout(2000);

  const pinRows = await page.evaluate(({ maxItems, term }) => {
    const norm = (text) => String(text || '').replace(/\s+/g, ' ').trim();
    const clean = (text) => norm(text)
      .replace(/^(?:Image|This)\s+may\s+contain:\s*/i, '')
      .replace(/[\u0080-\uFFFF]+/g, '')
      .replace(/\s*\|\s*Pinterest$/i, '');
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const selectors = [
      '[data-test-id="pin"] [data-test-id="pin-visual-title"]',
      '[data-test-id="pin"] [data-test-id*="title" i]',
      '[data-test-id="pin"] h3',
      '[data-test-id*="pin" i] [data-test-id*="title" i]',
      '[data-test-id*="pin" i] h3',
    ];
    const out = [];
    const seen = new Set();
    const add = (raw) => {
      const title = clean(raw);
      if (!title || title.length < 6 || title.length > 140) return;
      if (/^(?:Image|This)\s+may\s+contain\b/i.test(title)) return;
      if (/\b(?:ad-slot|google-ad|third-party-ad)\b/i.test(title)) return;
      if (/^(Save|Saved|Promoted|Pinterest|Log in|Sign up|More like this|Pin card|third-party-ad-slot)$/i.test(title)) return;
      if (/^[\w.-]+\.(?:com|net|org|co|io|app)$/i.test(title)) return;
      const words = title.match(/[A-Za-z0-9]+/g) || [];
      if (words.length < 3 && !/^(?:how to|diy|easy|quick|best|fix|repair|home|make|cook|grow|style|fitness|money|tech)\b/i.test(title)) return;
      const key = title.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push({
        title,
        source: 'pinterest_pins',
        engagement: 0,
        engagement_detail: { term, kind: 'pins' },
      });
    };
    for (const selector of selectors) {
      for (const el of document.querySelectorAll(selector)) {
        add(el.textContent || el.getAttribute('aria-label') || el.getAttribute('title'));
        if (out.length >= maxItems) return out;
      }
    }

    const pinRoots = [
      ...document.querySelectorAll('[data-test-id="pin"], [data-test-id*="pin" i], [data-grid-item="true"]'),
    ].filter(isVisible);
    for (const root of pinRoots) {
      const image = root.querySelector('img[alt], img[title]');
      add(image?.getAttribute('alt') || image?.getAttribute('title'));
      if (out.length >= maxItems) return out;

      const labelled = root.querySelector('a[aria-label], div[aria-label], [title]');
      add(labelled?.getAttribute('aria-label') || labelled?.getAttribute('title'));
      if (out.length >= maxItems) return out;
    }

    return out;
  }, { maxItems: pinLimit, term });

  if (pinRows.length < minPinTitles) {
    log.warn(`[SCRAPER] pinterest:${term}: only ${pinRows.length} non-empty pin title(s)`);
  }

  rows.push(...normalizeItems(pinRows, 'pinterest_pins', nicheId, pinLimit));
  if (rows.length === 0) {
    log.warn(`[SCRAPER] pinterest:${term}: zero rows after autocomplete and pins`, await collectPinterestDiagnostics(page, term));
  }
  return rows;
}

async function collectPinterestDiagnostics(page, term) {
  return page.evaluate((term) => {
    const norm = (text) => String(text || '').replace(/\s+/g, ' ').trim();
    const count = (selector) => document.querySelectorAll(selector).length;
    return {
      term,
      url: window.location.href,
      title: document.title,
      counts: {
        searchInput: count('[data-test-id="search-bar-input"], [data-test-id="search-box-input"], input[aria-label*="Search" i]'),
        suggestions: count('[data-test-id="search-suggestion"], [data-test-id*="search-suggestion" i], [role="option"]'),
        pins: count('[data-test-id="pin"], [data-test-id*="pin" i], [data-grid-item="true"]'),
        pinImagesWithAlt: count('[data-test-id="pin"] img[alt], [data-test-id*="pin" i] img[alt], [data-grid-item="true"] img[alt]'),
        dialogs: count('[role="dialog"], [data-test-id*="modal" i], [class*="modal" i]'),
      },
      bodySample: norm(document.body?.innerText || '').slice(0, 500),
    };
  }, term).catch(error => ({ term, error: error.message }));
}

async function scrapeYouTubeAutocomplete(basePage, niche, scraperConfig, browserConfig, log) {
  const seeds = getYouTubeSeeds(niche);
  const suggestionLimit = scraperConfig.youtubeSuggestionsPerSeed || 12;
  const useFreshContext = scraperConfig.youtubeUseFreshContext !== false;
  let ytBrowser = null;
  let ytContext = null;
  let ytPage = basePage;

  try {
    if (useFreshContext) {
      const viewport = browserConfig.viewport || { width: 1400, height: 900 };
      const parentBrowser = basePage.context().browser();
      if (parentBrowser) {
        ytContext = await parentBrowser.newContext({ viewport });
      } else {
        ytBrowser = await chromium.launch({
          headless: browserConfig.headless === true,
          args: ['--disable-blink-features=AutomationControlled'],
        });
        ytContext = await ytBrowser.newContext({ viewport });
      }
      ytPage = await ytContext.newPage();
      ytPage.setDefaultTimeout(scraperConfig.sourceTimeoutMs || 30000);
    }

    await gotoAndSettle(ytPage, 'https://www.youtube.com/', { ...scraperConfig, settleMs: 2500 });
    await dismissCommonPopups(ytPage);
    await dismissYouTubeConsent(ytPage);

    const rows = [];
    const inputLocator = ytPage.locator([
      'ytd-searchbox input#search',
      'input#search[name="search_query"]',
      'input[name="search_query"]',
      'input#search',
      '[role="search"] input',
    ].join(', ')).first();
    await inputLocator.waitFor({ timeout: scraperConfig.sourceTimeoutMs || 30000 });

    for (let index = 0; index < seeds.length; index++) {
      const seed = seeds[index];
      if (index > 0) {
        await waitWithJitter(
          ytPage,
          scraperConfig.youtubeDelayMinMs || 800,
          scraperConfig.youtubeDelayMaxMs || 1200
        );
      }

      try {
        await clearYouTubeSearch(ytPage, inputLocator);
        const query = ensureTrailingSpace(seed);
        await inputLocator.type(query, {
          delay: scraperConfig.youtubeTypeDelayMs || 60,
        });
        await ytPage.waitForTimeout(scraperConfig.youtubePostTypeSettleMs || 1200);
        await ytPage.waitForSelector(getYouTubeSuggestionWaitSelector(), {
          timeout: scraperConfig.youtubeSuggestionTimeoutMs || 8000,
        }).catch(() => null);

        const suggestions = await scrapeYouTubeSuggestionRows(ytPage, {
          seed,
          maxItems: suggestionLimit,
        });
        if (suggestions.length === 0 && scraperConfig.youtubeDebugOnZero !== false) {
          const diagnostics = await collectYouTubeDiagnostics(ytPage, seed);
          log.warn(`[SCRAPER] youtube_autocomplete:${seed}: zero suggestions`, diagnostics);
        }
        rows.push(...normalizeItems(suggestions, 'youtube_autocomplete', niche.id, suggestionLimit));
        log.info(`[SCRAPER] youtube_autocomplete:${seed}: ${suggestions.length} item(s)`);
      } catch (error) {
        log.warn(`[SCRAPER] youtube_autocomplete:${seed} failed; continuing`, error.message);
      }
    }

    if (rows.length > 0 && scraperConfig.youtubeDelayBetweenNichesMs) {
      await ytPage.waitForTimeout(scraperConfig.youtubeDelayBetweenNichesMs);
    }

    return rows;
  } finally {
    if (ytContext) await ytContext.close().catch(() => {});
    if (ytBrowser) await ytBrowser.close().catch(() => {});
  }
}

async function scrapeYouTubeSuggestionRows(page, { seed, maxItems }) {
  return page.evaluate(({ seed, maxItems }) => {
    const norm = (text) => String(text || '').replace(/\s+/g, ' ').trim();
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const add = (raw, out, seen) => {
      let title = norm(raw)
        .replace(/\s+/g, ' ')
        .replace(/^Search\s+/i, '')
        .trim();
      if (!title || title.length < 4 || title.length > 140) return;
      if (/^(Search|Shorts|Home|Subscriptions|You|History)$/i.test(title)) return;
      const key = title.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push({
        title,
        source: 'youtube_autocomplete',
        engagement: 0,
        engagement_detail: {
          seed,
          kind: 'autocomplete',
          position: out.length + 1,
        },
      });
    };
    const firstDistinctSuggestionText = (texts) => {
      const localSeen = new Set();
      for (const text of texts || []) {
        const key = text.toLowerCase();
        if (localSeen.has(key)) continue;
        localSeen.add(key);
        return text;
      }
      return '';
    };
    const out = [];
    const seen = new Set();
    const renderers = [
      ...document.querySelectorAll([
        'ytd-search-suggestion-renderer',
        'yt-searchbox-suggestion',
        'ytSuggestionComponentSuggestion',
        '[class*="ytSuggestionComponentSuggestion"]',
      ].join(', ')),
    ].filter(isVisible);

    for (const renderer of renderers) {
      if (renderer.closest('ytd-search-refinement-card-renderer')) continue;
      const textNodes = [
        ...renderer.querySelectorAll([
          'span.sbqs_c',
          '#suggestion-text',
          '[id*="suggestion-text" i]',
          '[class*="SuggestionText"]',
          '[class*="suggestionText"]',
          '[class*="suggestion-text"]',
          'span',
        ].join(', ')),
      ];
      const texts = textNodes
        .map(el => norm(el.textContent))
        .filter(Boolean);
      const title = firstDistinctSuggestionText(texts) || renderer.textContent;
      add(title, out, seen);
      if (out.length >= maxItems) break;
    }

    if (out.length < maxItems) {
      const optionNodes = [
        ...document.querySelectorAll([
          'ytd-searchbox-suggestions [role="option"]',
          '[role="listbox"] [role="option"]',
          '[role="option"][aria-label]',
          'li[role="presentation"]',
          '.sbsb_b li',
        ].join(', ')),
      ].filter(isVisible);

      for (const option of optionNodes) {
        if (option.closest('ytd-search-refinement-card-renderer')) continue;
        add(option.getAttribute('aria-label') || option.textContent, out, seen);
        if (out.length >= maxItems) break;
      }
    }

    return out;
  }, { seed, maxItems });
}

function getYouTubeSuggestionWaitSelector() {
  return [
    'ytd-search-suggestion-renderer',
    'yt-searchbox-suggestion',
    'ytSuggestionComponentSuggestion',
    '[class*="ytSuggestionComponentSuggestion"]',
    'ytd-searchbox-suggestions [role="option"]',
    '[role="listbox"] [role="option"]',
  ].join(', ');
}

async function collectYouTubeDiagnostics(page, seed) {
  return page.evaluate((seed) => {
    const norm = (text) => String(text || '').replace(/\s+/g, ' ').trim();
    const selectors = {
      inputSearch: document.querySelectorAll('input#search').length,
      namedSearch: document.querySelectorAll('input[name="search_query"]').length,
      ytdSuggestionRenderer: document.querySelectorAll('ytd-search-suggestion-renderer').length,
      ytSearchboxSuggestion: document.querySelectorAll('yt-searchbox-suggestion').length,
      ytSuggestionComponent: document.querySelectorAll('ytSuggestionComponentSuggestion, [class*="ytSuggestionComponentSuggestion"]').length,
      roleOptions: document.querySelectorAll('[role="listbox"] [role="option"], [role="option"][aria-label]').length,
      refinementCards: document.querySelectorAll('ytd-search-refinement-card-renderer').length,
    };
    const active = document.activeElement;
    const inputs = [...document.querySelectorAll('input#search, input[name="search_query"]')]
      .slice(0, 5)
      .map(input => ({
        value: input.value || '',
        placeholder: input.getAttribute('placeholder') || '',
        visible: !!(input.offsetWidth || input.offsetHeight || input.getClientRects().length),
        focused: input === active,
      }));
    const bodySample = norm(document.body?.innerText || '').slice(0, 500);
    const suggestionSample = [
      ...document.querySelectorAll('ytd-search-suggestion-renderer, yt-searchbox-suggestion, [role="option"]'),
    ]
      .slice(0, 8)
      .map(el => norm(el.textContent || el.getAttribute('aria-label')))
      .filter(Boolean);
    return { seed, url: location.href, title: document.title, selectors, inputs, suggestionSample, bodySample };
  }, seed).catch(error => ({ seed, error: error.message }));
}

async function clearYouTubeSearch(page, inputLocator) {
  await inputLocator.click({ timeout: 10000, clickCount: 3 });
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(800);
}

function ensureTrailingSpace(value) {
  const text = String(value || '').trim();
  return text.endsWith(' ') ? text : `${text} `;
}

function getYouTubeSeeds(niche) {
  const configured = Array.isArray(niche?.youtube_seeds) ? niche.youtube_seeds : [];
  const values = configured.length > 0
    ? configured
    : [niche?.youtube_seed, `how to ${niche?.name || ''}`];
  const seen = new Set();
  return values
    .map(value => String(value || '').trim())
    .filter(Boolean)
    .filter(value => {
      const key = value.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

async function scrapeQuora(page, niche, scraperConfig, log, nicheIndex = 0, nicheCount = 1) {
  const pulls = [
    ...getQuoraTopics(niche).map(topic => ({
      kind: 'topic',
      label: topic,
      source: 'quora_topic',
      url: `https://www.quora.com/topic/${encodeURIComponent(topic)}`,
    })),
    ...getQuoraSearchTerms(niche).map(term => ({
      kind: 'search',
      label: term,
      source: 'quora_search',
      url: `https://www.quora.com/search?q=${encodeURIComponent(term)}&type=question`,
    })),
  ];
  const all = [];

  try {
    for (let index = 0; index < pulls.length; index++) {
      const pull = pulls[index];
      if (index > 0) {
        await page.waitForTimeout(scraperConfig.quoraDelayBetweenPullsMs || 3000);
      }

      try {
        const result = await scrapeQuoraPull(page, {
          pull,
          nicheId: niche.id,
          scraperConfig,
          log,
        });
        if (result.captcha) {
          log.warn(`[SCRAPER] quora:${niche.id}: CAPTCHA/bot check detected; skipping niche`);
          return [];
        }
        all.push(...result.rows);
        log.info(`[SCRAPER] ${pull.source}:${pull.label}: ${result.rows.length} item(s)`);
      } catch (error) {
        log.warn(`[SCRAPER] ${pull.source}:${pull.label} failed; continuing`, error.message);
      }
    }

    return all;
  } finally {
    if (nicheIndex < nicheCount - 1) {
      const cooldownEvery = scraperConfig.quoraCooldownEveryNiches || 2;
      const shouldCooldown = cooldownEvery > 0 && (nicheIndex + 1) % cooldownEvery === 0;
      await page.waitForTimeout(shouldCooldown
        ? scraperConfig.quoraCooldownMs || 10000
        : scraperConfig.quoraDelayBetweenNichesMs || 5000);
    }
  }
}

async function scrapeQuoraPull(page, { pull, nicheId, scraperConfig, log }) {
  const limit = scraperConfig.quoraItemsPerPull || 15;
  const selectorTimeout = scraperConfig.quoraWaitForSelectorMs || 12000;
  const scrollY = pull.kind === 'topic'
    ? scraperConfig.quoraTopicScrollY || 2000
    : scraperConfig.quoraSearchScrollY || 1500;
  const settleMs = pull.kind === 'topic'
    ? scraperConfig.quoraTopicSettleMs || 2500
    : scraperConfig.quoraSearchSettleMs || 2000;

  await gotoAndSettle(page, pull.url, { ...scraperConfig, settleMs: 3500 });
  await dismissCommonPopups(page);
  await dismissQuoraModal(page);

  if (await detectQuoraCaptcha(page)) {
    return { rows: [], captcha: true };
  }

  const questionSelector = [
    '.q-text.qu-dynamicFontSize--regular',
    '[class*="question_title"]',
    'h2',
    '[data-testid="question-text"]',
  ].join(', ');

  try {
    await page.waitForSelector(questionSelector, { timeout: selectorTimeout });
  } catch (error) {
    log.warn(`[SCRAPER] ${pull.source}:${pull.label}: question selector did not render in ${selectorTimeout}ms`);
  }

  await page.evaluate(y => window.scrollBy(0, y), scrollY).catch(() => {});
  await page.waitForTimeout(settleMs);
  await dismissQuoraModal(page);

  if (await detectQuoraCaptcha(page)) {
    return { rows: [], captcha: true };
  }

  const rows = await page.evaluate(({ maxItems, pull }) => {
    const norm = (text) => String(text || '').replace(/\s+/g, ' ').trim();
    const selectors = [
      '.q-text.qu-dynamicFontSize--regular',
      '[class*="question_title"]',
      'h2',
      '[data-testid="question-text"]',
    ];
    const out = [];
    const seen = new Set();
    const add = (raw) => {
      const title = norm(raw);
      if (!title || title.length < 10 || title.length >= 120) return;
      if (!title.endsWith('?')) return;
      if (!/^[A-Z]/.test(title)) return;
      const key = title.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push({
        title,
        source: pull.source,
        engagement: 0,
        engagement_detail: {
          kind: pull.kind,
          label: pull.label,
          position: out.length + 1,
        },
      });
    };

    for (const selector of selectors) {
      for (const el of document.querySelectorAll(selector)) {
        add(el.textContent || el.getAttribute('aria-label') || el.getAttribute('title'));
        if (out.length >= maxItems) return out;
      }
    }

    return out;
  }, { maxItems: limit, pull });

  return {
    rows: normalizeItems(rows, pull.source, nicheId, limit),
    captcha: false,
  };
}

function getQuoraTopics(niche) {
  const configured = Array.isArray(niche?.quora_topics) ? niche.quora_topics : [];
  const values = configured.length > 0
    ? configured
    : [niche?.quora_topic, niche?.name];
  return uniqueCleanValues(values).slice(0, 2);
}

function getQuoraSearchTerms(niche) {
  const configured = Array.isArray(niche?.quora_search_terms) ? niche.quora_search_terms : [];
  const values = configured.length > 0
    ? configured
    : [`how to ${niche?.name || ''}`, niche?.name];
  return uniqueCleanValues(values).slice(0, 2);
}

async function runWithPageTimeout({ page, timeoutMs, label, task }) {
  let timer = null;
  const taskPromise = Promise.resolve().then(task);
  taskPromise.catch(() => {});

  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      page?.close?.().catch(() => {});
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
  });

  try {
    return await Promise.race([taskPromise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function gotoAndSettle(page, url, config) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: config.sourceTimeoutMs || 30000 });
  await page.waitForTimeout(config.settleMs || 2500);
}

async function dismissCommonPopups(page) {
  const patterns = [
    /^Accept all$/i,
    /^Accept$/i,
    /^I agree$/i,
    /^Not now$/i,
    /^Maybe later$/i,
    /^Continue$/i,
    /^Close$/i,
  ];
  for (const pattern of patterns) {
    try {
      const locator = page.getByRole('button', { name: pattern }).first();
      if (await locator.count()) {
        await locator.click({ timeout: 1500 });
        await page.waitForTimeout(700);
      }
    } catch (_) {}
  }
}

async function dismissPinterestInterstitals(page) {
  await page.keyboard.press('Escape').catch(() => {});
  const selectors = [
    '[data-test-id="register-modal"]',
    '[data-test-id="login-modal"]',
    '[data-test-id="closeup-modal"]',
  ];
  for (const selector of selectors) {
    try {
      const modal = page.locator(selector).first();
      if (await modal.count()) {
        await page.keyboard.press('Escape');
        await page.waitForTimeout(700);
      }
    } catch (_) {}
  }
}

async function dismissYouTubeConsent(page) {
  const patterns = [
    /^Accept all$/i,
    /^I agree$/i,
    /^Accept$/i,
    /^Reject all$/i,
  ];
  for (const pattern of patterns) {
    try {
      const locator = page.getByRole('button', { name: pattern }).first();
      if (await locator.count()) {
        await locator.click({ timeout: 2000 });
        await page.waitForTimeout(800);
        return;
      }
    } catch (_) {}
  }
}

async function dismissQuoraModal(page) {
  await page.keyboard.press('Escape').catch(() => {});
  const selectors = [
    '[class*="modal"]',
    '[role="dialog"]',
    '[data-testid*="modal" i]',
  ];
  for (const selector of selectors) {
    try {
      const modal = page.locator(selector).first();
      if (await modal.count()) {
        await page.keyboard.press('Escape');
        await page.waitForTimeout(1000);
        return;
      }
    } catch (_) {}
  }
}

async function detectQuoraCaptcha(page) {
  return page.evaluate(() => {
    const text = String(document.body?.innerText || '');
    if (/captcha|verify you are human|unusual traffic|robot check|are you a robot/i.test(text)) {
      return true;
    }
    return Boolean(document.querySelector(
      'iframe[src*="captcha" i], [id*="captcha" i], [class*="captcha" i], [data-testid*="captcha" i]'
    ));
  }).catch(() => false);
}

async function autoScroll(page, rounds = 3) {
  for (let i = 0; i < rounds; i++) {
    await page.evaluate(() => window.scrollBy(0, Math.max(900, window.innerHeight * 0.9))).catch(() => {});
    await page.waitForTimeout(1000);
  }
}

async function waitWithJitter(page, minMs, maxMs) {
  const low = Math.max(0, Number(minMs) || 0);
  const high = Math.max(low, Number(maxMs) || low);
  const delayMs = Math.round(low + Math.random() * (high - low));
  await page.waitForTimeout(delayMs);
}

function normalizeItems(rows, source, nicheId, limit) {
  return (rows || [])
    .map(row => ({
      title: cleanTitle(row.title),
      source: row.source || source,
      engagement: Number.isFinite(Number(row.engagement)) ? Number(row.engagement) : 0,
      engagement_detail: row.engagement_detail && typeof row.engagement_detail === 'object' ? row.engagement_detail : undefined,
      niche_id: nicheId,
    }))
    .filter(row => row.title && row.title.length >= 5)
    .slice(0, limit);
}

function mergeTopicSignals(items) {
  const groups = new Map();
  for (const item of items || []) {
    const title = cleanTitle(item.title);
    const key = topicKey(title);
    if (!key) continue;
    if (!groups.has(key)) {
      groups.set(key, {
        title,
        niche_id: item.niche_id,
        sources: [],
        signals: [],
        engagement: 0,
        bestSignal: null,
      });
    }

    const group = groups.get(key);
    for (const signal of getItemSignals(item)) {
      if (signal.source && !group.sources.includes(signal.source)) {
        group.sources.push(signal.source);
      }
      group.signals.push(signal);
      const engagement = Number(signal.engagement || 0);
      if (engagement >= group.engagement) {
        group.engagement = engagement;
        group.bestSignal = signal;
      }
    }
  }

  return [...groups.values()]
    .map(group => ({
      title: group.title,
      source: group.sources[0] || 'unknown',
      sources: group.sources,
      source_count: group.sources.length,
      signal_count: group.signals.length,
      engagement: group.engagement,
      engagement_detail: group.bestSignal?.engagement_detail,
      signals: group.signals,
      niche_id: group.niche_id,
    }))
    .sort((a, b) => {
      const sourceDiff = Number(b.source_count || 0) - Number(a.source_count || 0);
      if (sourceDiff) return sourceDiff;
      return Number(b.engagement || 0) - Number(a.engagement || 0);
    });
}

function getItemSignals(item) {
  if (Array.isArray(item.signals) && item.signals.length > 0) {
    return item.signals.map(signal => ({
      source: cleanText(signal.source || item.source || 'unknown'),
      engagement: Number.isFinite(Number(signal.engagement)) ? Number(signal.engagement) : 0,
      engagement_detail: signal.engagement_detail && typeof signal.engagement_detail === 'object'
        ? signal.engagement_detail
        : item.engagement_detail,
    }));
  }

  return [{
    source: cleanText(item.source || 'unknown'),
    engagement: Number.isFinite(Number(item.engagement)) ? Number(item.engagement) : 0,
    engagement_detail: item.engagement_detail && typeof item.engagement_detail === 'object'
      ? item.engagement_detail
      : undefined,
  }];
}

function topicKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function cleanTitle(value) {
  return normalizeReadableText(value)
    .replace(/\s+/g, ' ')
    .replace(/^\s*[-*]\s*/, '')
    .trim();
}

function cleanText(value) {
  return normalizeReadableText(value).replace(/\s+/g, ' ').trim();
}

function normalizeReadableText(value) {
  return String(value || '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[\u00A0]/g, ' ')
    .replace(/[\u{1F000}-\u{1FAFF}]/gu, '');
}

function uniqueCleanValues(values) {
  const seen = new Set();
  return (values || [])
    .map(value => cleanText(value))
    .filter(Boolean)
    .filter(value => {
      const key = value.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function makeLogger(logger) {
  return {
    info: (message, details) => callLogger(logger, 'info', message, details),
    warn: (message, details) => callLogger(logger, 'warn', message, details),
  };
}

function getEnabledSources(sources) {
  if (!Array.isArray(sources) || sources.length === 0) return null;
  return new Set(sources.map(source => String(source || '').trim()).filter(Boolean));
}

function callLogger(logger, level, message, details) {
  const fn = logger?.[level] || logger?.log || console.log;
  if (details) fn.call(logger, message, details);
  else fn.call(logger, message);
}
