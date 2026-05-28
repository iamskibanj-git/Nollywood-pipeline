/**
 * Reset social engagement post rows for iteration.
 *
 * Examples:
 *   node scripts/reset-social-posts.js --project 2026-04-21_05963753 --date 2026-05-26 --mode reset-copy
 *   node scripts/reset-social-posts.js --project 2026-04-21_05963753 --date 2026-05-26 --mode retry-upload
 *
 * Modes:
 *   reset-copy   Clear generated copy and set rows back to planned.
 *   retry-upload Keep generated copy and set rows to content_done.
 *   delete-local Delete unscheduled local social rows only.
 */

const path = require('path');
const db = require('../src/main/database/db');

function arg(name, fallback = null) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : fallback;
}

async function main() {
  const projectId = arg('project');
  const date = arg('date');
  const mode = arg('mode', 'reset-copy');
  const type = arg('type', null);
  const appData = arg('app-data', 'C:/Users/chris/AppData/Roaming/nollywood-ai-pipeline');

  if (!projectId) throw new Error('Missing --project');
  if (!date) throw new Error('Missing --date');
  if (!['reset-copy', 'retry-upload', 'delete-local'].includes(mode)) {
    throw new Error(`Unsupported --mode ${mode}`);
  }

  await db.init(path.join(appData, 'nollywood-pipeline.sqlite'));
  db.backup(`pre-social-reset-${mode}`);

  const filters = ['project_id = ?', 'scheduled_date = ?'];
  const params = [projectId, date];
  if (type) {
    filters.push('post_type = ?');
    params.push(type);
  }
  const where = filters.join(' AND ');
  const before = db.queryAll(`SELECT id, post_type, scheduled_date, scheduled_time, status FROM social_posts WHERE ${where} ORDER BY scheduled_time, post_type`, params);

  if (mode === 'reset-copy') {
    db.runSql(`
      UPDATE social_posts
      SET status = 'planned',
          title = CASE WHEN post_type = 'character_intro' THEN title ELSE NULL END,
          body = NULL,
          hashtags = '[]',
          caption_json = NULL,
          facebook_post_id = NULL,
          error_message = NULL,
          generated_at = NULL,
          upload_confirmed_at = NULL,
          updated_at = datetime('now')
      WHERE ${where}
    `, params);
  } else if (mode === 'retry-upload') {
    db.runSql(`
      UPDATE social_posts
      SET status = 'content_done',
          facebook_post_id = NULL,
          error_message = NULL,
          upload_confirmed_at = NULL,
          updated_at = datetime('now')
      WHERE ${where}
        AND body IS NOT NULL
        AND TRIM(body) != ''
    `, params);
  } else if (mode === 'delete-local') {
    db.runSql(`
      DELETE FROM social_posts
      WHERE ${where}
        AND status != 'scheduled'
    `, params);
  }

  const after = db.queryAll(`SELECT id, post_type, scheduled_date, scheduled_time, status FROM social_posts WHERE ${where} ORDER BY scheduled_time, post_type`, params);
  console.log(JSON.stringify({ projectId, date, mode, type, before, after }, null, 2));
}

main().catch(err => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
