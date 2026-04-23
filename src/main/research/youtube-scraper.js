const fs = require('fs');
const path = require('path');

/**
 * YouTubeResearcher
 *
 * Uses Playwright to search YouTube for high-performing Nollywood content.
 * Two research pools:
 *   1. "ai_original"      — AI-generated Nollywood movies (competition analysis)
 *   2. "remake_candidate"  — Traditional Nollywood hits (proven stories to redo as AI)
 *
 * Extracts: title, view count, channel name, video URL, thumbnail URL, duration.
 * Each result is tagged with its category so the UI can display them separately.
 */
class YouTubeResearcher {
  constructor(page) {
    this.page = page; // Reuse the same Playwright page from HiggsFieldAutomation
  }

  /**
   * Search YouTube for both AI and traditional Nollywood content.
   *
   * @param {Object} options
   * @param {string[]} options.aiQueries    - Queries targeting AI-generated content
   * @param {string[]} options.remakeQueries - Queries targeting traditional Nollywood hits
   * @param {number} options.minViewsAI      - Min views for AI content (default: 10000)
   * @param {number} options.minViewsRemake  - Min views for traditional content (default: 500000)
   * @param {number} options.maxResults       - Max videos to return per category (default: 10)
   * @param {string} options.sortBy           - YouTube sort: "relevance" | "view_count" | "upload_date"
   * @returns {Promise<Object>} { aiOriginals: [], remakeCandidates: [], all: [] }
   */
  async searchTopPerformers(options = {}) {
    const {
      aiQueries = [
        'AI Nollywood movie',
        'AI African drama full movie',
        'AI generated Nollywood movie',
        'AI Nigerian movie 2025',
        'AI Nigerian movie 2026',
        'AI Nollywood drama',
      ],
      remakeQueries = [
        'Nollywood movie full',
        'Nigerian movie drama village',
        'Nollywood betrayal movie',
        'Nigerian movie wife husband',
        'Nollywood family drama full movie',
      ],
      minViewsAI = 10000,
      minViewsRemake = 500000,
      maxResults = 10,
      sortBy = 'relevance', // 'relevance' returns more results; we sort by views ourselves
    } = options;

    // ── Pool 1: AI Originals ──
    console.log('[YT] === Searching AI Nollywood content ===');
    const aiRaw = await this._searchPool(aiQueries, minViewsAI, sortBy);

    // Categorize: must have "AI" as a whole word in title
    const aiOriginals = aiRaw
      .filter(v => /\bai\b/i.test(v.title))
      .map(v => ({ ...v, category: 'ai_original' }));

    console.log(`[YT] AI originals: ${aiOriginals.length} (filtered from ${aiRaw.length} raw results)`);

    // ── Pool 2: Remake Candidates (traditional Nollywood hits) ──
    console.log('[YT] === Searching traditional Nollywood hits ===');
    const remakeRaw = await this._searchPool(remakeQueries, minViewsRemake, sortBy);

    // Exclude anything already tagged as AI — these are traditional hits
    const remakeCandidates = remakeRaw
      .filter(v => !/\bai\b/i.test(v.title))
      .map(v => ({ ...v, category: 'remake_candidate' }));

    console.log(`[YT] Remake candidates: ${remakeCandidates.length} (filtered from ${remakeRaw.length} raw results)`);

    // ── Merge, deduplicate by videoId, sort ──
    const seen = new Set();
    const all = [];

    // AI originals first (sorted by views), then remake candidates
    for (const v of [...aiOriginals, ...remakeCandidates]) {
      if (!seen.has(v.videoId)) {
        seen.add(v.videoId);
        all.push(v);
      }
    }

    const topAI = all.filter(v => v.category === 'ai_original').slice(0, maxResults);
    const topRemake = all.filter(v => v.category === 'remake_candidate').slice(0, maxResults);

    console.log(`[YT] Final: ${topAI.length} AI originals + ${topRemake.length} remake candidates`);

    return {
      aiOriginals: topAI,
      remakeCandidates: topRemake,
      all: [...topAI, ...topRemake],
    };
  }

  /**
   * Internal: search a pool of queries and return raw results.
   */
  async _searchPool(queries, minViews, sortBy) {
    const page = this.page;
    const allResults = [];

    for (const query of queries) {
      try {
        console.log(`[YT] Searching: "${query}"...`);

        const sortParam = sortBy === 'view_count' ? '&sp=CAMSAhAB' :
                          sortBy === 'upload_date' ? '&sp=CAISAhAB' : '';
        const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}${sortParam}`;

        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(3000);

        // Dismiss any cookie/consent dialog
        try {
          const acceptBtn = await page.$('button[aria-label="Accept all"], button:has-text("Accept all"), tp-yt-paper-button:has-text("Accept all")');
          if (acceptBtn) {
            await acceptBtn.click();
            await page.waitForTimeout(1000);
          }
        } catch {}

        // Scroll down to load more results
        for (let i = 0; i < 3; i++) {
          await page.evaluate(() => window.scrollBy(0, 1500));
          await page.waitForTimeout(1500);
        }

        // Extract video data from search results
        const videos = await page.evaluate((minViewsThreshold) => {
          const results = [];
          const renderers = document.querySelectorAll('ytd-video-renderer');

          for (const renderer of renderers) {
            try {
              const titleEl = renderer.querySelector('#video-title');
              const title = titleEl?.textContent?.trim();
              const href = titleEl?.getAttribute('href');
              if (!title || !href) continue;

              const url = href.startsWith('http') ? href : `https://www.youtube.com${href}`;
              if (href.includes('/shorts/') || href.includes('&list=')) continue;

              const metaEl = renderer.querySelector('#metadata-line');
              const metaText = metaEl?.textContent || '';
              const viewMatch = metaText.match(/([\d,.]+)\s*(K|M|B)?\s*views?/i);
              let views = 0;
              if (viewMatch) {
                views = parseFloat(viewMatch[1].replace(/,/g, ''));
                const multiplier = viewMatch[2];
                if (multiplier === 'K' || multiplier === 'k') views *= 1000;
                else if (multiplier === 'M' || multiplier === 'm') views *= 1000000;
                else if (multiplier === 'B' || multiplier === 'b') views *= 1000000000;
              }

              if (views < minViewsThreshold) continue;

              const channelEl = renderer.querySelector('#channel-name a, .ytd-channel-name a, yt-formatted-string.ytd-channel-name');
              const channel = channelEl?.textContent?.trim() || 'Unknown';

              const thumbEl = renderer.querySelector('img#img');
              const thumbnail = thumbEl?.src || '';

              const durationEl = renderer.querySelector('ytd-thumbnail-overlay-time-status-renderer span, .badge-shape-wiz__text');
              const duration = durationEl?.textContent?.trim() || '';

              const timeMatch = metaText.match(/(\d+\s+(?:day|week|month|year)s?\s+ago)/i);
              const uploadAge = timeMatch ? timeMatch[1] : '';

              // Extract video ID from URL for reliable dedup
              const vidIdMatch = href.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
              const videoId = vidIdMatch ? vidIdMatch[1] : href;

              results.push({
                title,
                url,
                videoId,
                views: Math.round(views),
                viewsFormatted: viewMatch ? viewMatch[0] : 'N/A',
                channel,
                thumbnail,
                duration,
                uploadAge,
              });
            } catch (e) {
              continue;
            }
          }

          return results;
        }, minViews);

        console.log(`[YT] Found ${videos.length} videos with ${minViews / 1000}k+ views for "${query}"`);

        // Deduplicate by videoId within this pool
        for (const video of videos) {
          if (!allResults.find(r => r.videoId === video.videoId)) {
            video.searchQuery = query;
            allResults.push(video);
          }
        }

      } catch (e) {
        console.warn(`[YT] Search failed for "${query}": ${e.message}`);
      }
    }

    // Sort by views descending
    allResults.sort((a, b) => b.views - a.views);
    return allResults;
  }

  /**
   * Extract the video ID from a YouTube URL.
   */
  static extractVideoId(url) {
    const match = url.match(/(?:v=|\/v\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
    return match ? match[1] : null;
  }
}

module.exports = { YouTubeResearcher };
