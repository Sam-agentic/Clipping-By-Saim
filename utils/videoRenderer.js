/**
 * videoRenderer.js — drives python/render_video.py.
 *
 * render_video.py reports its own 0..100 progress. This module maps that onto
 * the render slice of the overall job so the UI bar only ever moves forward:
 *
 *   3..55   transcription       (audio_analyzer.py)
 *   58..62  image scheduling    (image_scheduler.py)
 *   62..65  image matching      (filename_matcher.py)
 *   65..100 rendering           (render_video.py, mapped here)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const ffmpegStatic = require('ffmpeg-static');

const { runPython, writeTempConfig } = require('./pythonRunner');

const RENDER_START = 65;
const RENDER_SPAN = 35;

/**
 * Decide how many clips to encode at once.
 *
 * Each concurrent x264 encode wants its own decoder, filter chain and encoder
 * buffers. On a ~4GB machine three or more at 1080p pushes the box into swap,
 * where everything is slower than running two. Free RAM is measured at call
 * time rather than assumed.
 */
function pickWorkerCount(explicit) {
  if (explicit) return Math.max(1, Number(explicit));

  const cores = os.cpus()?.length || 2;
  const freeGb = os.freemem() / 1024 ** 3;
  const totalGb = os.totalmem() / 1024 ** 3;

  let workers = Math.max(1, Math.min(cores, 4));
  if (totalGb <= 4.5 || freeGb < 1.2) workers = Math.min(workers, 2);
  if (freeGb < 0.6) workers = 1;
  return workers;
}

/**
 * Resolve the FFmpeg binary. ffmpeg-static's path is rewritten inside a
 * packaged app (app.asar is not executable), so fall back to the unpacked copy
 * and finally to a system ffmpeg.
 */
function resolveFfmpeg() {
  const unpacked = ffmpegStatic && ffmpegStatic.replace(
    `${path.sep}app.asar${path.sep}`,
    `${path.sep}app.asar.unpacked${path.sep}`
  );
  const candidates = [
    process.env.FFMPEG_PATH,
    unpacked,
    ffmpegStatic
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'ffmpeg'; // last resort: whatever is on PATH
}

/**
 * @param {object} params
 * @param {string}   params.audioPath
 * @param {string[]} params.imagePaths
 * @param {Array}    params.schedule
 * @param {Array}    params.segments
 * @param {number}   params.duration
 * @param {object}   params.captionSettings  { enabled, fontSize, mode }
 * @param {object}   params.musicSettings    { path, volume }
 * @param {object}   params.exportSettings   { quality, fps, motion }
 * @param {string}   params.outputPath
 * @param {(p:object)=>void} [params.onProgress]
 * @param {import('./pythonRunner').JobToken} [params.token]
 */
async function renderVideo(params) {
  const ffmpegPath = resolveFfmpeg();
  const workers = pickWorkerCount(params.maxWorkers);

  const config = {
    ffmpegPath,
    audioPath: params.audioPath,
    imagePaths: params.imagePaths,
    schedule: params.schedule,
    segments: params.segments || [],
    duration: params.duration || 0,
    captionSettings: params.captionSettings || { enabled: true, fontSize: 28, mode: 'burn' },
    musicSettings: params.musicSettings || { path: null, volume: 20 },
    effectSettings: params.effectSettings || { type: null, label: null },
    overlaySettings: params.overlaySettings || [],
    videoTracks: params.videoTracks || [],
    trimSettings: params.trimSettings || { start: 0, end: 0 },
    fontSettings: params.fontSettings || { path: null },
    exportSettings: params.exportSettings || { quality: '1080', fps: '30', motion: 'kenburns' },
    outputPath: params.outputPath,
    maxWorkers: workers
  };

  const outputDir = path.dirname(params.outputPath);
  fs.mkdirSync(outputDir, { recursive: true });

  const { configPath, cleanup } = writeTempConfig('render_config', config);

  // render_video.py speaks a local 0..100; translate to the global bar.
  const onProgress = params.onProgress
    ? (payload) => {
        const mapped = { ...payload };
        if (typeof payload.percent === 'number') {
          mapped.percent = RENDER_START + (RENDER_SPAN * payload.percent) / 100;
        }
        params.onProgress(mapped);
      }
    : undefined;

  try {
    const result = await runPython('render_video.py', [configPath], {
      onProgress,
      token: params.token
    });
    return { ...result, ffmpegPath, workers };
  } finally {
    cleanup();
  }
}

module.exports = { renderVideo, resolveFfmpeg, pickWorkerCount };
