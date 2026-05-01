var initSqlJs = require('sql.js');
var fs = require('fs');
var path = require('path');

var electronPath = path.join(
  process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming'),
  'nollywood-ai-pipeline', 'nollywood-pipeline.sqlite'
);
var localPath = path.join(__dirname, 'nollywood-pipeline.sqlite');
var dbFile = fs.existsSync(electronPath) ? electronPath : localPath;

async function main() {
  if (!fs.existsSync(dbFile)) { console.error('DB not found at ' + dbFile); process.exit(1); }
  var SQL = await initSqlJs();
  var db = new SQL.Database(fs.readFileSync(dbFile));

  var proj = db.exec("SELECT id, title, stage FROM projects WHERE completed_at IS NULL ORDER BY created_at DESC LIMIT 1");
  if (!proj.length || !proj[0].values.length) { console.log('No active project.'); process.exit(0); }
  var pid = proj[0].values[0][0];
  var title = proj[0].values[0][1];
  var stage = proj[0].values[0][2];
  console.log('\nProject: "' + title + '" (id=' + pid + ', stage=' + stage + ')\n');

  // Debug: show all asset types in this project
  var typeCheck = db.exec("SELECT type, COUNT(*) as cnt FROM project_assets WHERE project_id = '" + pid + "' GROUP BY type ORDER BY cnt DESC");
  if (typeCheck.length) {
    console.log('Asset types in DB:');
    typeCheck[0].values.forEach(function(r) { console.log('  ' + r[0] + ': ' + r[1]); });
    console.log('');
  }
  var types = "('video_clip','video_clip_cinematic')";
  var rej = db.exec("SELECT chapter, scene, line, status, file_path, gen_clicked_at FROM project_assets WHERE project_id = '" + pid + "' AND type IN " + types + " AND verify_human_decision = 'rejected' ORDER BY chapter, scene, line");
  var pend = db.exec("SELECT chapter, scene, line, verify_human_decision, file_path, gen_clicked_at FROM project_assets WHERE project_id = '" + pid + "' AND type IN " + types + " AND status = 'pending' ORDER BY chapter, scene, line");
  var acc = db.exec("SELECT COUNT(*) FROM project_assets WHERE project_id = '" + pid + "' AND type IN " + types + " AND verify_human_decision = 'accepted'");
  var tot = db.exec("SELECT COUNT(*) FROM project_assets WHERE project_id = '" + pid + "' AND type IN " + types);

  console.log('=== REJECTED (verify_human_decision=rejected) ===');
  if (rej.length && rej[0].values.length) {
    rej[0].values.forEach(function(r) {
      var clip = 'ch' + r[0] + '_sc' + r[1] + '_c' + r[2];
      var fe = r[4] ? (fs.existsSync(r[4]) ? 'EXISTS' : 'GONE') : 'null';
      console.log('  ' + clip + '  status=' + r[3] + '  file=' + fe + '  gen_clicked=' + (r[5] || 'null'));
    });
  } else { console.log('  (none)'); }

  console.log('\n=== PENDING (status=pending) ===');
  if (pend.length && pend[0].values.length) {
    pend[0].values.forEach(function(r) {
      var clip = 'ch' + r[0] + '_sc' + r[1] + '_c' + r[2];
      var fe = r[4] ? (fs.existsSync(r[4]) ? 'EXISTS' : 'GONE') : 'null';
      console.log('  ' + clip + '  decision=' + (r[3] || 'null') + '  file=' + fe + '  gen_clicked=' + (r[5] || 'null'));
    });
  } else { console.log('  (none)'); }

  console.log('\n=== SUMMARY ===');
  console.log('Total: ' + (tot.length ? tot[0].values[0][0] : '?'));
  console.log('Accepted: ' + (acc.length ? acc[0].values[0][0] : '?'));
  console.log('Rejected: ' + (rej.length ? rej[0].values.length : 0));
  console.log('Pending: ' + (pend.length ? pend[0].values.length : 0));
  db.close();
}
main();
