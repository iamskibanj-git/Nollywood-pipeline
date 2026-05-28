/**
 * Regression checks for cinematic clip asset identity and triage skip flow.
 *
 * Run: node test/test-cinematic-asset-flow.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const db = require('../src/main/database/db');
const { PipelineOrchestrator } = require('../src/main/pipeline/orchestrator');

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nollywood-cinematic-flow-'));
  const dbPath = path.join(tmpDir, 'test.sqlite');

  try {
    await db.init(dbPath);

    const projectId = 'test-project';
    db.createProject({
      id: projectId,
      title: 'Test Story',
      durationPreset: '1min',
      generatorMode: 'cinematic',
      stage: 'scenes-done',
      settings: {},
      projectDir: tmpDir,
    });

    db.insertExpectedAssets(projectId, [
      { type: 'video_clip_cinematic', chapter: 1, scene: 1, line: 1 },
      { type: 'video_clip_cinematic', chapter: 1, scene: 2, line: 2 },
    ]);

    const pipeline = new PipelineOrchestrator({ get: () => null }, null);
    pipeline.state.script = {
      chapters: [{
        chapter_number: 1,
        scenes: [
          {
            scene_number: 1,
            lines: [{ line_number: 1, speaker_id: 'character_1', dialogue: 'I will not leave.' }],
            kling_clips: [{ clip_id: 'ch1_sc1_c1', line_refs: [1], duration_seconds: 10 }],
          },
          {
            scene_number: 2,
            lines: [{ line_number: 2, speaker_id: 'character_1', dialogue: '' }],
            kling_clips: [{ clip_id: 'ch1_sc2_c1', line_refs: [2], duration_seconds: 10 }],
          },
        ],
      }],
    };

    pipeline._emitDialogueTriageData(projectId);

    const clips = db.getAssets(projectId, { type: 'video_clip_cinematic' });
    const dialogueClip = clips.find(a => a.kling_clip_id === 'ch1_sc1_c1');
    const silentClip = clips.find(a => a.kling_clip_id === 'ch1_sc2_c1');

    assert(dialogueClip, 'dialogue clip row should be adopted and tagged');
    assert(silentClip, 'silent clip row should be adopted and tagged');
    assert.strictEqual(dialogueClip.status, 'pending');
    assert.strictEqual(silentClip.status, 'skipped');

    const incomplete = db.getIncompleteAssets(projectId, 'video_clip_cinematic');
    assert.deepStrictEqual(
      incomplete.map(a => a.kling_clip_id),
      ['ch1_sc1_c1'],
      'skipped cinematic clips should be excluded from incomplete assets'
    );

    const activeForAssembly = clips.filter(a => !['skipped', 'archived'].includes(a.status));
    assert.deepStrictEqual(
      activeForAssembly.map(a => a.kling_clip_id),
      ['ch1_sc1_c1'],
      'assembly should count only active cinematic clip rows'
    );

    console.log('cinematic asset flow regression checks passed');
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
