const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const positionalArgs = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
const projectId = positionalArgs[0] || 'd66ff579-890d-4325-a2b6-91ad9a8312dc';
const sessionPath = positionalArgs[1] || path.resolve(__dirname, '..', '..', 'higgsfield-session.json');
const keepOpen = process.argv.includes('--keep-open');

const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();

async function clickBottomAt(page) {
  const atButton = await page.evaluate(() => {
    const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const vh = window.innerHeight;
    const inCinemaComposer = (el) => {
      let node = el;
      for (let depth = 0; node && depth < 10; depth++, node = node.parentElement) {
        const r = node.getBoundingClientRect();
        const text = clean(node.textContent);
        if (
          r.width > 300 && r.height > 80
          && r.y > window.innerHeight * 0.45
          && /Cinema Studio 3\.5/i.test(text)
          && !/Nano Banana/i.test(text)
        ) return true;
      }
      return false;
    };
    const buttons = [...document.querySelectorAll('button')].map((b) => {
      const r = b.getBoundingClientRect();
      const text = clean(b.textContent || b.getAttribute('aria-label') || '');
      return { b, r, text };
    });
    const exact = buttons
      .filter(o => o.r.y > vh * 0.55 && o.r.width > 18 && o.r.width < 80 && o.r.height > 18 && o.r.height < 80 && /^@$/i.test(o.text) && inCinemaComposer(o.b))
      .sort((a, b) => b.r.x - a.r.x)[0];
    if (exact) return {
      x: Math.round(exact.r.x + exact.r.width / 2),
      y: Math.round(exact.r.y + exact.r.height / 2),
      text: exact.text,
      rect: { x: exact.r.x, y: exact.r.y, w: exact.r.width, h: exact.r.height },
    };
    return null;
  });
  console.log('AT_BUTTON', JSON.stringify(atButton, null, 2));
  if (!atButton) throw new Error('Bottom @ button not found');
  await page.mouse.click(atButton.x, atButton.y);
  await page.waitForTimeout(1500);
}

async function dumpElementModal(page, label) {
  const data = await page.evaluate(() => {
    const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 5 && r.height > 5 && s.display !== 'none' && s.visibility !== 'hidden'
        && r.top < innerHeight && r.left < innerWidth && r.bottom > 0 && r.right > 0;
    };
    const cards = [];
    const seen = new Set();
    for (const img of document.querySelectorAll('img')) {
      if (!visible(img)) continue;
      let card = img;
      for (let node = img; node; node = node.parentElement) {
        const r = node.getBoundingClientRect();
        const text = clean(node.innerText || node.textContent || '');
        if (r.width >= 120 && r.width <= 260 && r.height >= 120 && r.height <= 320) {
          card = node;
          if (/@[a-z0-9_.-]+|Check eligibility|Eligible|Character|Location|Prop/i.test(text)) break;
        }
      }
      const r = card.getBoundingClientRect();
      const key = `${Math.round(r.x)}:${Math.round(r.y)}:${Math.round(r.width)}:${Math.round(r.height)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const text = clean(card.innerText || card.textContent || '');
      if (!/@|eligib|Character|Location|Prop/i.test(text)) continue;
      const buttons = [...card.querySelectorAll('button, [role="button"], div, span')]
        .filter(visible)
        .map(el => {
          const br = el.getBoundingClientRect();
          return {
            tag: el.tagName.toLowerCase(),
            role: el.getAttribute('role') || '',
            aria: el.getAttribute('aria-label') || '',
            text: clean(el.innerText || el.textContent || '').slice(0, 80),
            x: Math.round(br.x),
            y: Math.round(br.y),
            w: Math.round(br.width),
            h: Math.round(br.height),
          };
        })
        .filter(o => /eligib|@|Character|Location|Prop/i.test(`${o.text} ${o.aria}`));
      cards.push({
        text,
        src: img.currentSrc || img.src || '',
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height),
        buttons,
      });
    }
    const topControls = [...document.querySelectorAll('button, [role="tab"], div, span')]
      .filter(visible)
      .map(el => {
        const r = el.getBoundingClientRect();
        return {
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role') || '',
          aria: el.getAttribute('aria-label') || '',
          text: clean(el.innerText || el.textContent || '').slice(0, 100),
          x: Math.round(r.x),
          y: Math.round(r.y),
          w: Math.round(r.width),
          h: Math.round(r.height),
        };
      })
      .filter(o => o.y < innerHeight * 0.45 && /Uploads|Image Generations|Video Generations|Elements|Liked|All|Pinned|Shared|Characters|Locations|Props|Search/i.test(`${o.text} ${o.aria}`))
      .slice(0, 80);
    return {
      url: location.href,
      bodySnippet: clean(document.body?.innerText || '').slice(0, 1400),
      topControls,
      cards,
    };
  });
  console.log(`\n=== ${label} ===`);
  console.log(JSON.stringify(data, null, 2));
}

(async () => {
  if (!fs.existsSync(sessionPath)) throw new Error(`Session file not found: ${sessionPath}`);
  const browser = await chromium.launch({
    headless: false,
    args: ['--start-maximized', '--disable-blink-features=AutomationControlled', '--no-sandbox'],
  });
  const context = await browser.newContext({ viewport: null, storageState: sessionPath });
  const page = await context.newPage();
  page.on('console', (msg) => {
    const text = clean(msg.text());
    if (/error|warn/i.test(msg.type()) || /higgs|cinema/i.test(text)) {
      console.log(`[browser:${msg.type()}] ${text.slice(0, 300)}`);
    }
  });

  const url = `https://higgsfield.ai/cinema-studio?cinematic-project-id=${projectId}`;
  console.log(`Opening ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(8000);
  await clickBottomAt(page);
  await dumpElementModal(page, 'after @ click');

  const targets = ['nneka_osuagwu_o1_botmf_0526', 'nneka_osuagwu_o2_botmf_0526', 'segun_balogun_o1_botmf_0526'];
  for (const target of targets) {
    const result = await page.evaluate((targetName) => {
      const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const parts = String(targetName).toLowerCase().replace(/^@/, '').split('_');
      const prefix = parts.slice(0, 4).join('_');
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 5 && r.height > 5 && s.display !== 'none' && s.visibility !== 'hidden'
          && r.top < innerHeight && r.left < innerWidth && r.bottom > 0 && r.right > 0;
      };
      const candidates = [];
      for (const el of document.querySelectorAll('figure, [role="button"], button, div')) {
        if (!visible(el)) continue;
        const text = clean(el.innerText || el.textContent || '');
        const lower = text.toLowerCase();
        const r = el.getBoundingClientRect();
        if (r.width < 100 || r.width > 280 || r.height < 100 || r.height > 340) continue;
        if (!lower.includes(`@${prefix}`) && !lower.includes(prefix)) continue;
        candidates.push({
          text,
          x: Math.round(r.x),
          y: Math.round(r.y),
          w: Math.round(r.width),
          h: Math.round(r.height),
        });
      }
      candidates.sort((a, b) => (a.y - b.y) || (a.x - b.x) || (a.text.length - b.text.length));
      return { targetName, prefix, candidates: candidates.slice(0, 8) };
    }, target);
    console.log(`\n=== TARGET ${target} ===`);
    console.log(JSON.stringify(result, null, 2));
  }

  if (keepOpen) {
    console.log('\nElement inspector finished. Browser left open; close it when done.');
  } else {
    await browser.close();
    console.log('\nElement inspector finished. Browser closed.');
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
