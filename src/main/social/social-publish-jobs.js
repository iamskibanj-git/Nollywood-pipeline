class SocialPublishJobStore {
  constructor(db) {
    if (!db) throw new Error('Database is required for SocialPublishJobStore');
    this.db = db;
  }

  upsert(job = {}) {
    if (!job.social_post_id) throw new Error('social_post_id is required for social publish job');
    const platform = String(job.platform || '').trim();
    if (!platform) throw new Error('platform is required for social publish job');

    const hashtagsJson = normalizeJson(job.hashtags_json ?? job.hashtags, '[]');
    const proofJson = normalizeJson(job.proof_json ?? job.proof, null);
    const metadataJson = normalizeJson(job.metadata_json ?? job.metadata, null);
    const validationJson = normalizeJson(job.validation_json ?? job.validation, null);

    this.db.runSql(`
      INSERT OR IGNORE INTO social_publish_jobs (
        social_post_id, platform, status, scheduled_date, scheduled_time,
        title, body, hashtags_json, media_path, remote_post_id, remote_url,
        upload_confirmed_at, proof_json, metadata_json, validation_json, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      job.social_post_id,
      platform,
      job.status || 'planned',
      job.scheduled_date || null,
      job.scheduled_time || null,
      job.title || null,
      job.body || null,
      hashtagsJson === undefined ? '[]' : hashtagsJson,
      job.media_path || null,
      job.remote_post_id || null,
      job.remote_url || null,
      job.upload_confirmed_at || null,
      proofJson === undefined ? null : proofJson,
      metadataJson === undefined ? null : metadataJson,
      validationJson === undefined ? null : validationJson,
      job.error_message || null,
    ]);

    const updates = {
      status: job.status,
      scheduled_date: job.scheduled_date,
      scheduled_time: job.scheduled_time,
      title: job.title,
      body: job.body,
      hashtags_json: hashtagsJson,
      media_path: job.media_path,
      remote_post_id: job.remote_post_id,
      remote_url: job.remote_url,
      upload_confirmed_at: job.upload_confirmed_at,
      proof_json: proofJson,
      metadata_json: metadataJson,
      validation_json: validationJson,
      error_message: job.error_message,
    };

    const sets = [];
    const vals = [];
    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined) continue;
      sets.push(`${key} = ?`);
      vals.push(value);
    }
    if (sets.length > 0) {
      vals.push(job.social_post_id, platform);
      this.db.runSql(`
        UPDATE social_publish_jobs
        SET ${sets.join(', ')}, updated_at = datetime('now')
        WHERE social_post_id = ? AND platform = ?
      `, vals);
    }

    return this.getForPost(job.social_post_id, platform);
  }

  update(id, fields = {}) {
    const allowed = [
      'status', 'scheduled_date', 'scheduled_time', 'title', 'body',
      'hashtags_json', 'media_path', 'remote_post_id', 'remote_url',
      'upload_confirmed_at', 'proof_json', 'metadata_json', 'validation_json',
      'error_message',
    ];
    const sets = [];
    const vals = [];
    for (const [key, rawValue] of Object.entries(fields || {})) {
      if (!allowed.includes(key) || rawValue === undefined) continue;
      const value = key === 'hashtags_json'
        ? normalizeJson(rawValue, '[]')
        : key === 'proof_json' || key === 'metadata_json' || key === 'validation_json'
          ? normalizeJson(rawValue, null)
          : rawValue;
      sets.push(`${key} = ?`);
      vals.push(value);
    }
    if (sets.length === 0) return this.getById(id);
    sets.push(`updated_at = datetime('now')`);
    vals.push(id);
    this.db.runSql(`UPDATE social_publish_jobs SET ${sets.join(', ')} WHERE id = ?`, vals);
    return this.getById(id);
  }

  getForPost(socialPostId, platform) {
    if (typeof this.db.queryOne !== 'function') return null;
    return this.db.queryOne(`
      SELECT * FROM social_publish_jobs
      WHERE social_post_id = ? AND platform = ?
    `, [socialPostId, platform]);
  }

  getById(id) {
    if (typeof this.db.queryOne !== 'function') return null;
    return this.db.queryOne(`SELECT * FROM social_publish_jobs WHERE id = ?`, [id]);
  }

  listForProject(projectId, platform = null) {
    if (typeof this.db.queryAll !== 'function') return [];
    const params = [projectId];
    const platformSql = platform ? ' AND spj.platform = ?' : '';
    if (platform) params.push(platform);
    return this.db.queryAll(`
      SELECT spj.*,
        sp.project_id,
        sp.short_id,
        sp.post_type,
        sp.sequence,
        sp.status AS source_status,
        sp.title AS source_title,
        sp.body AS source_body,
        sp.hashtags AS source_hashtags,
        sp.media_path AS source_media_path,
        sp.source_character_id,
        sp.source_character_element_name,
        sp.source_scene_asset_id
      FROM social_publish_jobs spj
      JOIN social_posts sp ON sp.id = spj.social_post_id
      WHERE sp.project_id = ?${platformSql}
      ORDER BY spj.scheduled_date ASC, spj.scheduled_time ASC, sp.id ASC
    `, params);
  }

  getPending(projectId, platform, statuses = ['planned', 'ready', 'upload_failed']) {
    if (typeof this.db.queryAll !== 'function') return [];
    const normalizedStatuses = Array.isArray(statuses) && statuses.length > 0
      ? statuses.map(status => String(status || '').trim()).filter(Boolean)
      : ['planned', 'ready', 'upload_failed'];
    const placeholders = normalizedStatuses.map(() => '?').join(',');
    return this.db.queryAll(`
      SELECT spj.*,
        sp.project_id,
        sp.short_id,
        sp.post_type,
        sp.sequence,
        sp.status AS source_status,
        sp.title AS source_title,
        sp.body AS source_body,
        sp.hashtags AS source_hashtags,
        sp.media_path AS source_media_path
      FROM social_publish_jobs spj
      JOIN social_posts sp ON sp.id = spj.social_post_id
      WHERE sp.project_id = ?
        AND spj.platform = ?
        AND spj.status IN (${placeholders})
      ORDER BY spj.scheduled_date ASC, spj.scheduled_time ASC, sp.id ASC
    `, [projectId, platform, ...normalizedStatuses]);
  }

  markScheduled(id, proof = {}) {
    return this.update(id, {
      status: 'scheduled',
      remote_post_id: proof.remote_post_id,
      remote_url: proof.remote_url,
      upload_confirmed_at: proof.upload_confirmed_at || new Date().toISOString(),
      proof_json: proof.proof_json ?? proof.proof,
      error_message: null,
    });
  }

  markFailed(id, errorMessage) {
    return this.update(id, {
      status: 'upload_failed',
      error_message: errorMessage || 'Unknown social publish failure',
    });
  }

  markDeleted(id, errorMessage) {
    return this.update(id, {
      status: 'deleted',
      scheduled_date: null,
      scheduled_time: null,
      remote_post_id: null,
      remote_url: null,
      upload_confirmed_at: null,
      proof_json: null,
      error_message: errorMessage || 'Deleted remote social publish job',
    });
  }
}

function normalizeJson(value, fallback) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return fallback;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

module.exports = { SocialPublishJobStore, normalizeJson };
