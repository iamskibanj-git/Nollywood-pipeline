const { HiggsFieldAutomation } = require('../src/main/automation/higgsfield');
const { CinemaVideoAutomation } = require('../src/main/automation/cinema-video-automation');

const projectDir = process.argv[2] || 'C:/Users/chris/Cowork_Nollywood/Mass-produced/Mass production - Nollywood/2026-05-26_dba0e3fb';
const projectId = process.argv[3] || 'd66ff579-890d-4325-a2b6-91ad9a8312dc';
const aspectRatio = process.argv[4] || '9:16';

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

(async () => {
  const automation = new HiggsFieldAutomation(null, projectDir);
  const cinema = new CinemaVideoAutomation({
    automation,
    projectId,
    log: (message) => console.log(`[DRY] ${message}`),
  });

  try {
    await automation.ensureBrowser();
    await cinema._ensureCinemaStudio35VideoActive(aspectRatio);
    const state = await automation.page.evaluate(() => {
      const cleanText = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      let toolbarText = '';
      for (const el of document.querySelectorAll('div, section, form')) {
        const r = el.getBoundingClientRect();
        const text = cleanText(el.textContent);
        if (r.width > 250 && r.height > 20 && r.y > window.innerHeight * 0.50 && /Cinema Studio 3\.5/i.test(text) && !/Nano Banana/i.test(text)) {
          toolbarText = text;
          break;
        }
      }
      const generateButtons = [...document.querySelectorAll('button')]
        .map((button) => ({ text: cleanText(button.textContent), rect: button.getBoundingClientRect() }))
        .filter((button) => /generate/i.test(button.text) && button.rect.width > 0 && button.rect.height > 0)
        .map((button) => button.text);
      return { toolbarText, generateButtons };
    });
    console.log(`FINAL_STATE ${JSON.stringify(state)}`);
  } finally {
    try {
      if (automation.browser) await automation.browser.close();
    } catch (err) {
      console.warn(`Browser close failed: ${clean(err.message)}`);
    }
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
