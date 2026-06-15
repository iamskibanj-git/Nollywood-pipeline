/**
 * Regression checks for temporary Higgsfield browser inspection mode.
 *
 * Run: node test/test-higgsfield-browser-inspection-mode.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function main() {
  const root = path.join(__dirname, '..');
  const orchestratorSource = fs.readFileSync(path.join(root, 'src/main/pipeline/orchestrator.js'), 'utf8');
  const higgsfieldSource = fs.readFileSync(path.join(root, 'src/main/automation/higgsfield.js'), 'utf8');
  const rendererSource = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');

  assert(
    orchestratorSource.includes("fs.existsSync(BROWSER_INSPECT_FLAG_PATH)") &&
      orchestratorSource.includes("process.env.HIGGSFIELD_BROWSER_INSPECT === '1'"),
    'orchestrator must support both env and local sentinel inspection mode'
  );
  assert(
    orchestratorSource.includes("_enterHiggsfieldBrowserInspection") &&
      orchestratorSource.includes("return { success: true, mode: 'browser-inspection' }"),
    'inspection mode must return before pipeline stages run'
  );
  assert(
    !orchestratorSource.includes("waitForApproval('browser-inspection')"),
    'inspection mode must not persist a pending approval gate'
  );
  assert(
    higgsfieldSource.includes('openInspectionWorkspace') &&
      higgsfieldSource.includes('--remote-debugging-port=') &&
      higgsfieldSource.includes("fs.existsSync(BROWSER_INSPECT_FLAG_PATH)") &&
      higgsfieldSource.includes('higgsfield-ui-snapshot_'),
    'automation must open inspectable browser tabs, enable debug mode, and write snapshots'
  );
  assert(
    rendererSource.includes("'browser-inspection'") &&
      rendererSource.includes('Higgsfield Browser Inspection Mode'),
    'renderer must show inspection gate and Resume control'
  );

  console.log('higgsfield browser inspection mode regression checks passed');
}

main();
