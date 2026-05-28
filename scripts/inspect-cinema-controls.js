const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const projectId = process.argv[2] || 'd66ff579-890d-4325-a2b6-91ad9a8312dc';
const sessionPath = process.argv[3] || path.resolve(__dirname, '..', '..', 'higgsfield-session.json');
const keepOpen = process.argv.includes('--keep-open');

function simplifyText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

async function dumpControls(page, label) {
  const data = await page.evaluate(() => {
    const textOf = (el) => String(el.textContent || el.getAttribute('aria-label') || el.getAttribute('name') || '').replace(/\s+/g, ' ').trim();
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const items = [];
    for (const el of document.querySelectorAll('button, [role="button"], [role="option"], [role="menuitem"], [aria-haspopup], input, [role="slider"], div, span')) {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const text = textOf(el);
      if (!text && el.tagName !== 'INPUT') continue;
      if (r.width > vw * 0.9 || r.height > 260) continue;
      const lowerHalf = r.y > vh * 0.48;
      const interesting = lowerHalf || /Cinema Studio|Kling|Seedance|Veo|Grok|HappyHorse|Generate|480p|720p|1080p|4K|\d+s|Auto|9:16|16:9|Genre|Style|Camera|On|Off/i.test(text);
      if (!interesting) continue;
      items.push({
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || '',
        aria: el.getAttribute('aria-label') || '',
        type: el.getAttribute('type') || '',
        text: text.slice(0, 120),
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height),
      });
    }
    items.sort((a, b) => (a.y - b.y) || (a.x - b.x) || (a.text.length - b.text.length));
    return {
      url: location.href,
      viewport: { w: vw, h: vh },
      bodySnippet: (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 1200),
      controls: items,
    };
  });
  console.log(`\n=== ${label} ===`);
  console.log(JSON.stringify(data, null, 2));
}

async function dumpCompact(page, label) {
  const data = await page.evaluate(() => {
    const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const vh = window.innerHeight;
    const rows = [];
    for (const el of document.querySelectorAll('button, [role="button"], [role="option"], [role="menuitem"], div, span')) {
      const r = el.getBoundingClientRect();
      const text = clean(el.textContent);
      if (!text || r.width <= 0 || r.height <= 0) continue;
      if (r.y < vh * 0.50) continue;
      if (!/Cinema Studio|Kling|Seedance|Veo|Grok|HappyHorse|Nano Banana|Generate|480p|720p|1080p|4K|\b\d+s\b|Auto|9:16|16:9|1\/4|On|Off|General|Style|Camera|Resolution/i.test(text)) continue;
      if (r.width > 950 || r.height > 160) continue;
      rows.push({
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || '',
        text,
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height),
      });
    }
    rows.sort((a, b) => (a.y - b.y) || (a.x - b.x) || (a.w - b.w));
    return rows.slice(0, 120);
  });
  console.log(`\n=== COMPACT ${label} ===`);
  console.log(JSON.stringify(data, null, 2));
}

async function findChip(page, pattern) {
  return page.evaluate((source) => {
    const pattern = new RegExp(source, 'i');
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const candidates = [];
    for (const el of document.querySelectorAll('button, [role="button"], [aria-haspopup], div, span')) {
      const r = el.getBoundingClientRect();
      const text = String(el.textContent || '').replace(/\s+/g, ' ').trim();
      if (
        r.width > 0 && r.height > 0 &&
        r.y > vh * 0.58 &&
        r.width < Math.min(360, vw * 0.35) &&
        r.height < 100 &&
        pattern.test(text)
      ) {
        candidates.push({ text, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), left: Math.round(r.x), top: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
      }
    }
    candidates.sort((a, b) => a.top - b.top || a.left - b.left || a.text.length - b.text.length);
    return candidates[0] || null;
  }, pattern.source);
}

async function clickAndDumpMenu(page, pattern, label) {
  const chip = await findChip(page, pattern);
  console.log(`\n>>> ${label} chip: ${JSON.stringify(chip)}`);
  if (!chip) return;
  await page.mouse.click(chip.x, chip.y);
  await page.waitForTimeout(900);
  if (process.argv.includes('--compact')) {
    await dumpCompact(page, `${label} menu open`);
  } else {
    await dumpControls(page, `${label} menu open`);
  }
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(300);
}

(async () => {
  if (!fs.existsSync(sessionPath)) {
    throw new Error(`Session file not found: ${sessionPath}`);
  }

  const browser = await chromium.launch({
    headless: false,
    args: ['--start-maximized', '--disable-blink-features=AutomationControlled', '--no-sandbox'],
  });
  const context = await browser.newContext({ viewport: null, storageState: sessionPath });
  const page = await context.newPage();
  page.on('console', (msg) => {
    const text = simplifyText(msg.text());
    if (/error|warn/i.test(msg.type()) || /higgs|cinema/i.test(text)) {
      console.log(`[browser:${msg.type()}] ${text.slice(0, 300)}`);
    }
  });

  const url = `https://higgsfield.ai/cinema-studio?cinematic-project-id=${projectId}`;
  console.log(`Opening ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(8000);
  if (process.argv.includes('--compact')) {
    await dumpCompact(page, 'initial');
  } else {
    await dumpControls(page, 'initial');
  }
  await clickAndDumpMenu(page, /Cinema Studio|Kling|Seedance|Veo|Grok|HappyHorse/i, 'model');
  await clickAndDumpMenu(page, /^\d+s$/i, 'duration');
  await clickAndDumpMenu(page, /^(480p|720p|1080p|4K)$/i, 'resolution');
  await clickAndDumpMenu(page, /^(Auto|1:1|3:4|9:16|4:3|16:9|21:9)$/i, 'aspect');
  await clickAndDumpMenu(page, /^(On|Off)$/i, 'audio');
  if (process.argv.includes('--compact')) {
    await dumpCompact(page, 'final');
  } else {
    await dumpControls(page, 'final');
  }
  if (keepOpen) {
    console.log('\nInspector finished. Browser left open for visual inspection; close it when done.');
  } else {
    await browser.close();
    console.log('\nInspector finished. Browser closed.');
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
