const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const dbPath = path.join(process.env.APPDATA, 'nollywood-ai-pipeline', 'nollywood-pipeline.sqlite');

initSqlJs().then((SQL) => {
  const db = new SQL.Database(fs.readFileSync(dbPath));
  const query = (sql) => {
    try {
      const result = db.exec(sql)[0];
      if (!result) return [];
      return result.values.map((row) => Object.fromEntries(row.map((value, index) => [result.columns[index], value])));
    } catch (error) {
      return [{ error: error.message }];
    }
  };

  console.log(JSON.stringify({
    dbPath,
    activeProjects: query(`
      SELECT id, title, stage, duration_preset, generator_mode, settings, created_at, updated_at
      FROM projects
      WHERE completed_at IS NULL
      ORDER BY id DESC
      LIMIT 5
    `),
    recentProjects: query(`
      SELECT id, title, stage, duration_preset, generator_mode, completed_at, created_at
      FROM projects
      ORDER BY id DESC
      LIMIT 8
    `),
    researchPools: query(`
      SELECT id, fetched_at, expires_at
      FROM research_cache
      ORDER BY id DESC
      LIMIT 5
    `),
  }, null, 2));
});
