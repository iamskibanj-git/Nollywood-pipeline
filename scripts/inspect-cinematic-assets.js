const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const dbPath = path.join(process.env.APPDATA, 'nollywood-ai-pipeline', 'nollywood-pipeline.sqlite');
const projectId = process.argv[2] || '2026-05-26_dba0e3fb';

initSqlJs().then((SQL) => {
  const db = new SQL.Database(fs.readFileSync(dbPath));
  const result = db.exec(`
    SELECT id, type, chapter, scene, line, kling_clip_id, status, file_path, error_message, gen_clicked_at, retry_count
    FROM project_assets
    WHERE project_id = '${projectId.replace(/'/g, "''")}'
      AND type IN ('video_clip_cinematic', 'portrait', 'scene_image_cinematic')
    ORDER BY
      CASE type WHEN 'portrait' THEN 1 WHEN 'scene_image_cinematic' THEN 2 ELSE 3 END,
      chapter, scene, line, id
  `)[0];
  const rows = result ? result.values.map((row) => Object.fromEntries(row.map((value, index) => [result.columns[index], value]))) : [];
  console.log(JSON.stringify(rows, null, 2));
});
