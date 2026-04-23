const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * Default branding card location. Can be overridden via settings.
 * Place a 16:9 transparent PNG at config/branding-card.png
 */
const DEFAULT_BRANDING_CARD = path.join(__dirname, '..', '..', '..', 'config', 'branding.fw.png');

/**
 * Branding overlay PNGs — transparent watermark composited on the full video.
 * Aspect-ratio-aware: 16:9 and 9:16 variants.
 */
const BRANDING_OVERLAY_16_9 = path.join(__dirname, '..', '..', '..', 'config', 'branding.fw.png');
const BRANDING_OVERLAY_9_16 = path.join(__dirname, '..', '..', '..', 'config', 'branding 916.fw.png');

/**
 * Fade duration in seconds for the final video's opening and closing.
 */
const FADE_DURATION_SECONDS = 2;

/**
 * How often to insert the branding card between clips.
 * Every N clips = roughly every N×7s ≈ every ~1.5 minutes at 13 clips.
 */
const BRANDING_INTERVAL_CLIPS = 13;

/**
 * Duration (seconds) to show the branding card each time it appears.
 */
const BRANDING_CARD_DURATION = 3;

class VideoAssembler {
  constructor(projectDir, options = {}) {
    this.projectDir = projectDir;
    this.ffmpegPath = findFFmpeg();
    this.brandingCardPath = options.brandingCardPath || DEFAULT_BRANDING_CARD;
    this.brandingInterval = options.brandingInterval || BRANDING_INTERVAL_CLIPS;
    this.brandingDuration = options.brandingDuration || BRANDING_CARD_DURATION;
    // Branding card insertion is disabled by default for MVP. Set to true
    // (or pass enableBranding: true) to re-enable intro/outro/interval cards.
    // Can also be overridden via env var: ENABLE_BRANDING=true
    this.enableBranding = options.enableBranding === true ||
                          process.env.ENABLE_BRANDING === 'true' ||
                          process.env.ENABLE_BRANDING === '1';
    // Trim dead frames from clip starts. 0 = no trim (default, avoids audio drift).
    // Previously defaulted to 0.3s which caused ~5-20ms drift per clip.
    this.trimStartSeconds = options.trimStartSeconds !== undefined
      ? options.trimStartSeconds
      : Number(process.env.CLIP_TRIM_START_SECONDS) || 0;
  }

  /**
   * Check if branding cards should be inserted into the output.
   * Requires BOTH enableBranding flag AND existing card file.
   */
  hasBrandingCard() {
    return this.enableBranding && this.brandingCardPath && fs.existsSync(this.brandingCardPath);
  }

  /**
   * Create a short video clip from the branding card PNG.
   * Uses the same resolution as the source clips (matched via probe or default 1280x720).
   * Silent audio track added so concat doesn't break.
   */
  async createBrandingClip(tempDir, index, resolution = '1280x720') {
    const outPath = path.join(tempDir, `branding_${String(index).padStart(4, '0')}.mp4`);

    await this.runFFmpeg([
      // Static image input — loop for N seconds
      '-loop', '1',
      '-i', this.brandingCardPath,
      '-f', 'lavfi',
      '-i', `anullsrc=channel_layout=stereo:sample_rate=44100`,
      '-t', String(this.brandingDuration),
      '-vf', `scale=${resolution}:flags=lanczos,format=yuv420p`,
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '18',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-shortest',
      '-y',
      outPath,
    ]);

    return outPath;
  }

  /**
   * Assemble all video clips into a final output video.
   *
   * Pipeline:
   * 1. Sort clips by chapter + line number
   * 2. Trim first 0.3s of each clip (dead frames from Veo generation)
   * 3. Insert branding card at start, every N clips, and at end
   * 4. Concatenate all segments
   * 5. Upscale to 4K
   *
   * NOTE: Dialogue subtitles are NOT baked in — YouTube/Facebook auto-generate
   * captions from the Veo audio track, which is cleaner and multilingual.
   */
  async assemble({ clips, script, outputPath, onProgress, aspectRatio = '16:9' }) {
    if (!this.ffmpegPath) {
      throw new Error('FFmpeg not found. Please install FFmpeg and ensure it is in your system PATH.');
    }

    // Normalize aspect ratio — derives output dims for final upscale + branding clip
    const _aspect = (aspectRatio === '9:16') ? '9:16' : '16:9';
    const finalDims = _aspect === '9:16' ? '2160:3840' : '3840:2160';   // 4K in the chosen orientation
    const brandingDims = _aspect === '9:16' ? '720x1280' : '1280x720';  // Match source clip resolution
    this.aspectRatio = _aspect;
    this.brandingDims = brandingDims;
    console.log(`[ASSEMBLY] Aspect ratio: ${_aspect} — final output ${finalDims}, branding ${brandingDims}`);

    // Branding card is 16:9. Skip for 9:16 projects to avoid letterboxing the outro.
    // Portrait branding variant is on the post-MVP roadmap.
    const hasBranding = this.hasBrandingCard() && _aspect === '16:9';
    if (this.hasBrandingCard() && _aspect === '9:16') {
      console.warn('[ASSEMBLY] Skipping branding card: project is 9:16 (portrait), branding is 16:9. Portrait variant not yet available.');
    } else if (hasBranding) {
      console.log(`[ASSEMBLY] Branding card found: ${this.brandingCardPath}`);
    } else {
      console.warn('[ASSEMBLY] No branding card found — assembling without branding');
    }

    // Sort clips in order. Prefer the explicit sortKey emitted by the
    // orchestrator (which handles cinematic vs staged ordering uniformly:
    // chapter * 1e6 + scene * 1e3 + (line || klingClipNum)); fall back to
    // the legacy chapter+line sort for callers that don't supply sortKey.
    const sortedClips = [...clips].sort((a, b) => {
      if (a.sortKey != null && b.sortKey != null) return a.sortKey - b.sortKey;
      if (a.chapter !== b.chapter) return a.chapter - b.chapter;
      if (a.scene != null && b.scene != null && a.scene !== b.scene) return a.scene - b.scene;
      return (a.line || 0) - (b.line || 0);
    });

    // Create temp directory
    const tempDir = path.join(this.projectDir, 'temp_assembly');
    fs.mkdirSync(tempDir, { recursive: true });

    // Step 1: Normalize each clip (consistent codec/sample rate/timebase).
    // This is CRITICAL for avoiding audio drift during concat:
    //   - Force 30fps video, yuv420p pixel format
    //   - Force 48000Hz stereo audio (video-standard sample rate)
    //   - Re-encode both streams so durations align to frame/sample boundaries
    // Trim is now OPTIONAL (default off) — trimming introduced ~5-20ms of
    // video-vs-audio drift per clip due to frame-boundary rounding, which
    // accumulated to hundreds of ms over 18 clips, making the final unwatchable.
    const processedClips = [];
    let brandingClipIndex = 0;
    const trim = this.trimStartSeconds;

    for (let i = 0; i < sortedClips.length; i++) {
      const clip = sortedClips[i];
      const tempPath = path.join(tempDir, `processed_${String(i).padStart(4, '0')}.mp4`);

      if (onProgress) onProgress({ step: 'processing', current: i + 1, total: sortedClips.length });

      const ffmpegArgs = ['-i', clip.path];

      if (trim > 0) {
        // Trim path — use filter_complex but normalize carefully.
        // Still produces drift-prone output; prefer trim=0 unless clips have real dead frames.
        const filterComplex = [
          `[0:v]trim=start=${trim},setpts=PTS-STARTPTS,fps=30,format=yuv420p[v]`,
          `[0:a]atrim=start=${trim},asetpts=PTS-STARTPTS,aresample=48000:first_pts=0[a]`,
        ].join(';');
        ffmpegArgs.push('-filter_complex', filterComplex, '-map', '[v]', '-map', '[a]');
      } else {
        // No trim — normalize by re-encoding with forced params.
        // aresample=async=1 resamples audio to match video timeline if they drift.
        ffmpegArgs.push(
          '-vf', 'fps=30,format=yuv420p',
          '-af', 'aresample=48000:async=1',
        );
      }

      ffmpegArgs.push(
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
        '-c:a', 'aac', '-b:a', '192k',
        '-ar', '48000', '-ac', '2',
        '-video_track_timescale', '90000', // standard H.264 timebase
        '-y',
        tempPath,
      );

      await this.runFFmpeg(ffmpegArgs);

      // Insert branding card BEFORE first clip and every N clips (only if enabled)
      if (hasBranding && (i === 0 || i % this.brandingInterval === 0)) {
        const brandingClip = await this.createBrandingClip(tempDir, brandingClipIndex++, brandingDims);
        processedClips.push(brandingClip);
      }

      processedClips.push(tempPath);
    }

    // Add branding card as outro (only if enabled)
    if (hasBranding) {
      const outroClip = await this.createBrandingClip(tempDir, brandingClipIndex++, brandingDims);
      processedClips.push(outroClip);
    }

    // Step 2: Create concat file
    const concatFile = path.join(tempDir, 'concat.txt');
    const concatContent = processedClips.map(p => `file '${p.replace(/\\/g, '/')}'`).join('\n');
    fs.writeFileSync(concatFile, concatContent);

    // Step 3: Concatenate with RE-ENCODING (not stream copy).
    // Stream copy (-c copy) demands identical codec params across all inputs
    // and can still produce drift when timestamps don't align perfectly.
    // Re-encoding during concat forces a single continuous timeline and lets
    // ffmpeg resync audio to video (aresample=async=1).
    if (onProgress) onProgress({ step: 'concatenating', current: 0, total: 1 });

    const concatTempPath = path.join(tempDir, 'concatenated.mp4');
    await this.runFFmpeg([
      '-f', 'concat',
      '-safe', '0',
      '-i', concatFile,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
      '-c:a', 'aac', '-b:a', '192k',
      '-ar', '48000', '-ac', '2',
      '-af', 'aresample=async=1',
      '-fps_mode', 'cfr', '-r', '30',
      '-video_track_timescale', '90000',
      '-y',
      concatTempPath,
    ]);

    // Step 4: Upscale to 4K + fade in/out + branding overlay
    if (onProgress) onProgress({ step: 'upscaling', current: 0, total: 1 });

    // Probe concatenated video duration for fade-out timing
    let totalDuration = 0;
    try {
      const probeOut = execSync(
        `"${this.ffmpegPath}" -i "${concatTempPath}" -f null - 2>&1`,
        { encoding: 'utf-8', timeout: 30000 }
      );
      const durMatch = probeOut.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
      if (durMatch) {
        totalDuration = parseInt(durMatch[1]) * 3600 + parseInt(durMatch[2]) * 60 + parseFloat(durMatch[3]);
      }
    } catch (probeErr) {
      // Fallback: try ffprobe-style extraction from stderr
      const msg = probeErr.stderr || probeErr.stdout || probeErr.message || '';
      const durMatch = msg.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
      if (durMatch) {
        totalDuration = parseInt(durMatch[1]) * 3600 + parseInt(durMatch[2]) * 60 + parseFloat(durMatch[3]);
      }
    }
    console.log(`[ASSEMBLY] Probed duration: ${totalDuration.toFixed(2)}s`);

    const fadeDur = FADE_DURATION_SECONDS;
    const fadeOutStart = Math.max(0, totalDuration - fadeDur);

    // Select the branding overlay PNG based on aspect ratio
    const overlayPath = _aspect === '9:16' ? BRANDING_OVERLAY_9_16 : BRANDING_OVERLAY_16_9;
    const hasOverlay = overlayPath && fs.existsSync(overlayPath);
    if (hasOverlay) {
      console.log(`[ASSEMBLY] Branding overlay: ${overlayPath}`);
    } else {
      console.warn(`[ASSEMBLY] No branding overlay found at ${overlayPath} — assembling without overlay`);
    }

    // Build the FFmpeg command with filter_complex:
    //   [0:v] scale to 4K → fade in/out → [base]
    //   [1:v] scale overlay to match → [ovr]
    //   [base][ovr] overlay → [out]
    // Audio: fade in/out applied separately via afade filters.
    const ffmpegArgs = ['-i', concatTempPath];

    if (hasOverlay) {
      ffmpegArgs.push('-i', overlayPath);
    }

    // Video filter chain
    // CRITICAL: every path must end with format=yuv420p before [out].
    // Without it, the overlay's RGBA→YUV conversion can produce yuv444p,
    // which creates a "High 4:4:4 Predictive" H.264 profile that most
    // players (Windows Media Player, phones, YouTube upload) can't decode.
    //
    // NO FADES: fade in/out removed — the ~1.3s of black screen at the
    // start kills retention on YouTube/TikTok. Content must hit immediately.
    let vFilterChain;
    const scaleOnly = `scale=${finalDims}:flags=lanczos`;
    if (hasOverlay) {
      vFilterChain = [
        `[0:v]${scaleOnly}[base]`,
        `[1:v]scale=${finalDims}:flags=lanczos,format=rgba[ovr]`,
        `[base][ovr]overlay=0:0:format=auto,format=yuv420p[out]`,
      ].join(';');
    } else {
      vFilterChain = `[0:v]${scaleOnly},format=yuv420p[out]`;
    }

    ffmpegArgs.push('-filter_complex', vFilterChain, '-map', '[out]', '-map', '0:a');

    // Audio: no fades, just resample for sync
    ffmpegArgs.push('-af', 'aresample=async=1');

    ffmpegArgs.push(
      '-c:v', 'libx264',
      '-preset', 'slow',
      '-crf', '18',
      '-pix_fmt', 'yuv420p',   // Force compatible pixel format (High profile, not 4:4:4)
      '-profile:v', 'high',    // Ensure H.264 High profile (universally supported)
      '-c:a', 'aac',
      '-b:a', '192k',
      '-ar', '48000', '-ac', '2',
      '-movflags', '+faststart',
      '-y',
      outputPath,
    );

    await this.runFFmpeg(ffmpegArgs);

    // Cleanup temp files
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      console.warn('Could not clean up temp assembly files');
    }

    if (onProgress) onProgress({ step: 'complete', outputPath });
    return outputPath;
  }

  findLine(script, chapterNum, lineNum) {
    if (!script || !script.chapters) return null;
    for (const ch of script.chapters) {
      if (ch.chapter_number === chapterNum) {
        for (const sc of ch.scenes) {
          for (const ln of sc.lines) {
            if (ln.line_number === lineNum) return ln;
          }
        }
      }
    }
    return null;
  }

  getSpeakerLabel(script, speakerId) {
    if (!script || !script.character_bible || !speakerId) return '';
    const char = script.character_bible.find(c => c.id === speakerId);
    return char ? char.description_label : '';
  }

  escapeFFmpegText(text) {
    if (!text) return '';
    return text
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'")
      .replace(/:/g, '\\:')
      .replace(/\[/g, '\\[')
      .replace(/\]/g, '\\]')
      .replace(/;/g, '\\;')
      .replace(/%/g, '%%');
  }

  runFFmpeg(args) {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      proc.stderr.on('data', (data) => { stderr += data.toString(); });
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`FFmpeg exited with code ${code}: ${stderr.slice(-500)}`));
      });
      proc.on('error', reject);
    });
  }
}

function findFFmpeg() {
  const candidates = ['ffmpeg', 'C:\\ffmpeg\\bin\\ffmpeg.exe', 'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe'];
  for (const cmd of candidates) {
    try {
      execSync(`"${cmd}" -version`, { stdio: 'ignore' });
      return cmd;
    } catch {}
  }
  try {
    execSync('ffmpeg -version', { stdio: 'ignore' });
    return 'ffmpeg';
  } catch {}
  return null;
}

module.exports = { VideoAssembler };
