/**
 * timelineEngine.js — Step 1 + Step 2 of the auto-generation engine.
 *
 *   1. Transcribe the voiceover (python/audio_analyzer.py, faster-whisper)
 *   2. Assign each image a start/end time (python/image_scheduler.py)
 *
 * BUG FIXED HERE
 * --------------
 * This file used to hand the scheduler a temp file containing
 * `{ break_points, duration }`, but image_scheduler.py reads
 * `data.get("segments", [])`. So `segments` was always empty, the scheduler
 * silently took its "no transcript available" branch, and every image got an
 * equal slice of the runtime. All of the sentence-aligned scheduling logic —
 * the whole reason the transcript is produced — was dead code. It now receives
 * the segments it actually asks for.
 */

const { runPython, writeTempConfig } = require('./pythonRunner');
const transcriptCache = require('./transcriptCache');

/**
 * @param {string} audioPath
 * @param {number} numImages
 * @param {object} [opts]
 * @param {string} [opts.modelSize='base']    tiny | base | small | medium
 * @param {boolean} [opts.useCache=true]
 * @param {(p:object)=>void} [opts.onProgress]
 * @param {import('./pythonRunner').JobToken} [opts.token]
 * @returns {Promise<{duration:number, words:Array, segments:Array, schedule:Array, fromCache:boolean}>}
 */
async function generateTimeline(audioPath, numImages, opts = {}) {
  const { modelSize = 'base', useCache = true, onProgress, token } = opts;
  const report = (payload) => { if (onProgress) onProgress(payload); };

  // ---- Step 1: transcribe (or reuse a previous transcript) ----
  let analysis = null;
  let fromCache = false;

  if (useCache) {
    report({ stage: 'transcribe', percent: 1, message: 'Checking transcript cache' });
    analysis = await transcriptCache.get(audioPath, modelSize);
    if (analysis) {
      fromCache = true;
      report({
        stage: 'transcribe',
        percent: 55,
        message: `Reusing cached transcript (${analysis.segments.length} sentences)`
      });
    }
  }

  if (!analysis) {
    report({ stage: 'transcribe', percent: 2, message: `Transcribing with Whisper "${modelSize}"` });
    analysis = await runPython('audio_analyzer.py', [audioPath, modelSize], { onProgress, token });
    if (useCache) await transcriptCache.set(audioPath, modelSize, analysis);
  }

  if (token) token.throwIfCancelled();

  const segments = Array.isArray(analysis.segments) ? analysis.segments : [];
  const duration = Number(analysis.duration) || 0;
  if (!duration) throw new Error('Could not determine the audio duration');

  // ---- Step 2: schedule the images against sentence boundaries ----
  report({
    stage: 'schedule',
    percent: 58,
    message: `Placing ${numImages} images across ${segments.length} sentences`
  });

  const { configPath, cleanup } = writeTempConfig('schedule', {
    segments,                          // the field the scheduler actually reads
    duration,
    break_points: analysis.break_points || []
  });

  let scheduleResult;
  try {
    scheduleResult = await runPython(
      'image_scheduler.py',
      [configPath, numImages, duration],
      { onProgress, token }
    );
  } finally {
    cleanup();
  }

  const schedule = Array.isArray(scheduleResult.schedule) ? scheduleResult.schedule : [];
  if (!schedule.length) throw new Error('The scheduler returned an empty timeline');

  report({
    stage: 'schedule',
    percent: 62,
    message: `Timeline ready: ${schedule.length} slots over ${duration.toFixed(1)}s`
  });

  return {
    duration,
    words: analysis.words || [],
    segments,
    schedule,
    fromCache
  };
}

module.exports = { generateTimeline };
