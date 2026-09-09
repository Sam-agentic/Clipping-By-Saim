/**
 * clipStudio.js — orchestrates Clipping by Saim end to end.
 *
 *   analyze()      link -> download -> audio -> transcript -> ranked highlights
 *   renderClips()  chosen windows -> finished vertical clips (music, captions)
 *   exportClips()  copy to the folder the user picked, then delete the project
 *
 * Everything for one job lives in <dataDir>/clip_projects/<id>/ so that the
 * "auto delete after export" rule is a single rmSync of one directory, and so a
 * crash can never leave files scattered across the disk. That matters here: the
 * target machine has very little free space left.
 *
 * Progress percentages are assigned in fixed bands (see BANDS) because the UI
 * bar is clamped monotonic in main.js — each stage must therefore hand over a
 * value at least as large as the previous stage's.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

const { runPython, writeTempConfig } = require('./pythonRunner');
const transcriptCache = require('./transcriptCache');
const { resolveFfmpeg } = require('./videoRenderer');
const ytDownloader = require('./ytDownloader');

const PROJECTS_DIR_NAME = 'clip_projects';
const BIN_DIR_NAME = 'bin';

const BANDS = {
  probe: [2, 4],
  download: [4, 34],
  audio: [34, 38],
  transcribe: [38, 78],
  highlight: [78, 99]
};

/** Map a 0..100 value from one stage onto its slice of the overall bar. */
function band(name, value) {
  const [low, high] = BANDS[name];
  const ratio = Math.max(0, Math.min(100, Number(value) || 0)) / 100;
  return low + ratio * (high - low);
}

function cancelledError() {
  const err = new Error('Cancelled by user');
  err.cancelled = true;
  return err;
}

function projectsRoot(dataDir) {
  return path.join(dataDir, PROJECTS_DIR_NAME);
}

function binDir(dataDir) {
  return path.join(dataDir, BIN_DIR_NAME);
}

function newProjectId() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `clip_${stamp}`;
}

/**
 * Guard for every destructive call: a path coming back from the renderer is
 * only ever deleted if it really is one of our own project folders.
 */
function assertInsideProjects(dataDir, target) {
  const root = path.resolve(projectsRoot(dataDir));
  const resolved = path.resolve(target || '');
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error('Refusing to touch a folder outside the app project area.');
  }
  return resolved;
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJson(filePath, data) {
  const temp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data), 'utf8');
  fs.renameSync(temp, filePath);
}

/** Run one short ffmpeg command, cancellable, resolving on exit code 0. */
function runFfmpeg(ffmpegPath, args, token) {
  return new Promise((resolve, reject) => {
    if (token && token.cancelled) return reject(cancelledError());
    const child = spawn(ffmpegPath, ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', ...args], {
      windowsHide: true
    });
    if (token) token.register(child);

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    child.on('error', (err) => reject(new Error(`FFmpeg start failed: ${err.message}`)));
    child.on('close', (code) => {
      if (token && token.cancelled) return reject(cancelledError());
      if (code === 0) return resolve(true);
      reject(new Error(`FFmpeg failed (exit ${code}): ${stderr.trim().slice(-500)}`));
    });
  });
}

/** 16 kHz mono AAC: what whisper wants, and ~1/40th the bytes of the video. */
async function extractAudio(ffmpegPath, sourcePath, audioPath, token) {
  await runFfmpeg(ffmpegPath, [
    '-i', sourcePath,
    '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'aac', '-b:a', '64k',
    audioPath
  ], token);
  if (!fs.existsSync(audioPath) || fs.statSync(audioPath).size < 1024) {
    throw new Error('Could not extract any audio from this video — does it have sound?');
  }
  return audioPath;
}

async function makeThumbnail(ffmpegPath, videoPath, token) {
  const thumbPath = `${videoPath}.jpg`;
  try {
    await runFfmpeg(ffmpegPath, [
      '-ss', '0.4', '-i', videoPath, '-frames:v', '1', '-vf', 'scale=240:-2', thumbPath
    ], token);
  } catch (err) {
    // A missing preview must never fail a clip — but a cancel is not a failure
    // to swallow, or the caller would report success after the user hit stop.
    if (err && err.cancelled) throw err;
    return null;
  }
  return fs.existsSync(thumbPath) ? thumbPath : null;
}

/**
 * Link -> ranked highlight windows. Nothing is encoded here; this step only
 * downloads, transcribes and scores, so the user can review the clip list
 * before paying for any rendering.
 */
async function analyze(options = {}) {
  const {
    url,
    dataDir,
    ffmpegPath = resolveFfmpeg(),
    onProgress = () => {},
    token,
    clipCount = 10,
    minDuration = 15,
    maxDuration = 60,
    targetDuration = 30,
    modelSize = 'tiny',
    language = 'auto',
    translate = false,
    maxHeight = 720,
    useCache = true
  } = options;

  if (!dataDir) throw new Error('clipStudio.analyze needs dataDir');
  if (!ytDownloader.looksLikeUrl(url)) {
    throw new Error('Paste a full YouTube link first.');
  }

  const warnings = [];
  const id = newProjectId();
  const projectDir = path.join(projectsRoot(dataDir), id);
  fs.mkdirSync(projectDir, { recursive: true });

  const step = (stage, name, value, extra = {}) =>
    onProgress({ stage, percent: band(name, value), ...extra });

  step('download', 'probe', 0, { message: 'Checking yt-dlp…' });
  const tool = await ytDownloader.ensureYtDlp({
    binDir: binDir(dataDir),
    token,
    onStatus: (message) => step('download', 'probe', 40, { message })
  });
  if (token) token.throwIfCancelled();

  step('download', 'probe', 60, { message: 'Reading the video details…' });
  const info = await ytDownloader.probeVideo(url, { tool, token });
  if (info.isLive) {
    throw new Error('This is a live stream — wait until the stream has finished.');
  }
  if (info.duration && info.duration > 5400) {
    warnings.push('The video is longer than 1.5 hours — transcription will take a while.');
  }
  if (token) token.throwIfCancelled();

  const download = await ytDownloader.downloadVideo(url, {
    tool,
    destDir: projectDir,
    maxHeight,
    ffmpegPath,
    token,
    onProgress: (update) => step('download', 'download', update.percent, {
      message: update.message || 'Downloading the video…',
      title: info.title
    })
  });
  if (token) token.throwIfCancelled();

  step('prepare', 'audio', 20, { message: 'Extracting the audio…' });
  const audioPath = path.join(projectDir, 'audio.m4a');
  await extractAudio(ffmpegPath, download.path, audioPath, token);
  step('prepare', 'audio', 100, { message: 'Audio ready' });
  if (token) token.throwIfCancelled();

  // --- transcript (cache-first: re-analysing the same link is then instant) ---
  // The language and translate choices change what Whisper returns for the same
  // audio, so they are part of the cache identity — otherwise asking for English
  // captions would hand back the Urdu transcript from the run before.
  const spokenLanguage = String(language || 'auto').toLowerCase();
  const task = translate ? 'translate' : 'transcribe';
  const variant = `${spokenLanguage}-${task}`;
  let transcript = useCache ? await transcriptCache.get(audioPath, modelSize, variant) : null;
  const fromCache = Boolean(transcript);

  if (!transcript) {
    step('transcribe', 'transcribe', 0, {
      message: translate
        ? 'Listening to the video and translating it into English…'
        : 'Listening to the video (transcribing)…'
    });
    transcript = await runPython('audio_analyzer.py', [audioPath, modelSize, spokenLanguage, task], {
      token,
      // audio_analyzer reports 3..55 on its own scale; rebase it to 0..100
      // before it is folded into this stage's band.
      onProgress: (update) => {
        const local = ((Number(update.percent) || 3) - 3) / 52 * 100;
        step('transcribe', 'transcribe', local, {
          message: update.message || 'Transcribing…',
          sentences: update.sentences
        });
      }
    });
    await transcriptCache.set(audioPath, modelSize, transcript, variant);
  } else {
    step('transcribe', 'transcribe', 100, { message: 'Transcript loaded from cache' });
  }
  if (token) token.throwIfCancelled();

  const duration = Number(transcript.duration) || Number(info.duration) || 0;
  writeJson(path.join(projectDir, 'transcript.json'), {
    duration,
    words: transcript.words || [],
    segments: transcript.segments || [],
    model: transcript.model || modelSize
  });

  // --- highlight scoring ---
  step('highlight', 'highlight', 0, { message: 'Finding the best moments…' });
  const { configPath, cleanup } = writeTempConfig('highlights', {
    mediaPath: audioPath,          // audio-only decode: much cheaper than the mp4
    ffmpegPath,
    duration,
    segments: transcript.segments || [],
    clipCount,
    minDuration,
    maxDuration,
    targetDuration,
    useAudioEnergy: true
  });

  let found;
  try {
    found = await runPython('highlight_finder.py', [configPath], {
      token,
      onProgress: (update) => step('highlight', 'highlight', update.percent, {
        message: update.message
      })
    });
  } finally {
    cleanup();
  }
  if (found.warning) warnings.push(found.warning);

  const project = {
    id,
    dir: projectDir,
    url: info.webpageUrl,
    videoId: info.id,
    title: info.title,
    uploader: info.uploader,
    duration,
    sourcePath: download.path,
    sourceName: download.name,
    sourceBytes: download.sizeBytes,
    audioPath,
    modelSize,
    language: spokenLanguage,
    task,
    fromCache,
    clips: found.clips || [],
    createdAt: new Date().toISOString()
  };
  writeJson(path.join(projectDir, 'project.json'), project);

  onProgress({
    stage: 'done',
    percent: 100,
    message: `Found ${project.clips.length} clip${project.clips.length === 1 ? '' : 's'}`
  });
  return { ...project, warnings };
}

/** Slice the stored transcript down to one clip's window. */
function sliceTranscript(transcript, start, end) {
  const inRange = (item) => Number(item.end) > start && Number(item.start) < end;
  return {
    words: (transcript.words || []).filter(inRange),
    segments: (transcript.segments || []).filter(inRange)
  };
}

/**
 * Encode the clips the user kept, with their per-clip music, volume and look.
 * `clips` comes straight from the UI, so each entry may carry musicPath,
 * musicVolume (0..1), filter and an enabled flag.
 */
async function renderClips(options = {}) {
  const {
    projectDir,
    dataDir,
    clips = [],
    aspect = 'vertical',
    quality = '720',
    fps = 30,
    captionMode = 'burn',
    captionStyle = 'bold',
    captionPrimary = '',
    captionHighlight = '',
    musicDuck = true,
    fontName = 'Arial',
    framing = 'crop',
    logoPath = '',
    logoScale = 0.18,
    logoOpacity = 0.85,
    hook = '',
    hookSeconds = 2.5,
    tighten = false,
    cutFillers = true,
    writeMeta = false,
    ffmpegPath = resolveFfmpeg(),
    onProgress = () => {},
    token
  } = options;

  const dir = assertInsideProjects(dataDir, projectDir);
  if (token) token.throwIfCancelled();
  const project = readJson(path.join(dir, 'project.json'));
  if (!project) throw new Error('This project could not be found — analyse the link again.');
  if (!fs.existsSync(project.sourcePath)) {
    throw new Error('The downloaded video is no longer on disk — analyse the link again.');
  }

  const transcript = readJson(path.join(dir, 'transcript.json'), { words: [], segments: [] });
  const wanted = clips.filter((clip) => clip && clip.enabled !== false);
  if (!wanted.length) throw new Error('Select at least one clip.');

  const outDir = path.join(dir, 'clips');
  fs.mkdirSync(outDir, { recursive: true });

  const payloadClips = wanted.map((clip, order) => {
    const start = Math.max(0, Number(clip.start) || 0);
    const end = Math.max(start + 1, Number(clip.end) || start + 1);
    const { words, segments } = sliceTranscript(transcript, start, end);
    const music = clip.musicPath && fs.existsSync(clip.musicPath) ? clip.musicPath : null;
    return {
      index: Number(clip.index) || order + 1,
      start,
      end,
      title: clip.title || `Clip ${order + 1}`,
      filter: clip.filter || 'none',
      captionStyle: clip.captionStyle || captionStyle,
      captions: clip.captions !== false,
      // A per-clip headline wins over the one typed for the whole batch.
      hook: typeof clip.hook === 'string' ? clip.hook : '',
      musicPath: music,
      musicVolume: Math.max(0, Math.min(1.5, Number(clip.musicVolume ?? 0.25))),
      words,
      segments
    };
  });

  const logo = logoPath && fs.existsSync(logoPath) ? logoPath : null;

  const { configPath, cleanup } = writeTempConfig('clip_render', {
    ffmpegPath,
    sourcePath: project.sourcePath,
    sourceDuration: project.duration,
    outDir,
    aspect,
    quality: String(quality),
    fps: Number(fps) || 30,
    captionMode,
    captionStyle,
    captionPrimary,
    captionHighlight,
    musicDuck,
    fontName,
    framing,
    logoPath: logo,
    logoScale: Number(logoScale) || 0.18,
    logoOpacity: Number(logoOpacity) || 0.85,
    hook,
    hookSeconds: Number(hookSeconds) || 2.5,
    tighten: Boolean(tighten),
    cutFillers: Boolean(cutFillers),
    writeMeta: Boolean(writeMeta),
    clips: payloadClips
  });

  let result;
  try {
    result = await runPython('clip_renderer.py', [configPath], {
      token,
      onProgress: (update) => onProgress({
        stage: update.stage === 'done' ? 'clips' : (update.stage || 'clips'),
        // clip_renderer owns the whole bar for this call: 1..99, leaving the
        // last point for thumbnail generation below.
        percent: Math.min(99, Number(update.percent) || 0),
        message: update.message,
        done: update.done,
        total: update.total
      })
    });
  } finally {
    cleanup();
  }

  const rendered = [];
  for (const clip of result.clips || []) {
    if (token) token.throwIfCancelled();
    const thumbnailPath = await makeThumbnail(ffmpegPath, clip.path, token);
    rendered.push({
      ...clip,
      url: pathToFileURL(clip.path).href,
      thumbnailPath,
      thumbnailUrl: thumbnailPath ? pathToFileURL(thumbnailPath).href : null
    });
  }

  project.rendered = rendered.map(({ words, segments, ...keep }) => keep);
  project.renderedAt = new Date().toISOString();
  project.renderSettings = {
    aspect, quality: String(quality), fps, captionMode, captionStyle,
    framing, tighten: Boolean(tighten), logo: Boolean(logo), writeMeta: Boolean(writeMeta)
  };
  writeJson(path.join(dir, 'project.json'), project);

  onProgress({
    stage: 'done',
    percent: 100,
    message: `${rendered.length} clip${rendered.length === 1 ? '' : 's'} ready`
  });
  return {
    clips: rendered,
    failed: result.failed || [],
    aspect: result.aspect,
    width: result.width,
    height: result.height,
    framing: result.framing || framing,
    tightened: Number(result.tightened) || 0,
    outDir
  };
}

/** Total bytes under a directory — used to tell the user what was freed. */
function dirSize(target) {
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(target, { withFileTypes: true });
  } catch (_) {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(target, entry.name);
    try {
      if (entry.isDirectory()) total += dirSize(full);
      else total += fs.statSync(full).size;
    } catch (_) { /* vanished mid-walk */ }
  }
  return total;
}

/** clip-01-title.mp4, clip-01-title-2.mp4, … never overwrite the user's files. */
function uniqueTarget(destDir, stem, ext) {
  let candidate = path.join(destDir, `${stem}${ext}`);
  let counter = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(destDir, `${stem}-${counter}${ext}`);
    counter += 1;
    if (counter > 999) break;
  }
  return candidate;
}

function safeName(clip, order) {
  const index = String(Number(clip.index) || order + 1).padStart(2, '0');
  const slug = (clip.slug || '').replace(/[^a-z0-9-]/gi, '').slice(0, 40);
  return slug ? `clip-${index}-${slug}` : `clip-${index}`;
}
/**
 * Copy the finished clips into a folder the user picked, then (by default)
 * delete the whole project directory. That deletion is the reason this app can
 * be used repeatedly on an almost-full disk: nothing survives an export except
 * the mp4s the user actually asked for.
 */
async function exportClips(options = {}) {
  const {
    projectDir,
    dataDir,
    destDir,
    only = null,                       // optional array of clip indexes
    includeSubtitles = true,
    deleteAfter = true,
    onProgress = () => {},
    token
  } = options;

  const dir = assertInsideProjects(dataDir, projectDir);
  if (!destDir) throw new Error('Choose an export folder.');

  const project = readJson(path.join(dir, 'project.json'));
  if (!project) throw new Error('The project could not be found — analyse the link again.');

  const keepIndexes = Array.isArray(only) && only.length
    ? new Set(only.map((value) => Number(value)))
    : null;
  const source = (project.rendered || []).filter(
    (clip) => clip && clip.path && (!keepIndexes || keepIndexes.has(Number(clip.index)))
  );
  if (!source.length) throw new Error('Make the clips first, then export.');

  fs.mkdirSync(destDir, { recursive: true });
  // Fail early with a clear message rather than half-copying into a read-only
  // or disconnected drive.
  try {
    const probe = path.join(destDir, `.clipping-write-test-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
  } catch (err) {
    throw new Error(`No permission to write into this folder: ${destDir}`);
  }

  const exported = [];
  for (let order = 0; order < source.length; order += 1) {
    if (token) token.throwIfCancelled();
    const clip = source[order];
    if (!fs.existsSync(clip.path)) continue;

    const stem = safeName(clip, order);
    const target = uniqueTarget(destDir, stem, path.extname(clip.path) || '.mp4');
    await fs.promises.copyFile(clip.path, target);
    // path.extname can be '' — slice(0, -0) would return '' and drop the folder.
    const ext = path.extname(target);
    const base = ext ? target.slice(0, -ext.length) : target;

    let subtitle = null;
    if (includeSubtitles && clip.subtitlePath && fs.existsSync(clip.subtitlePath)) {
      subtitle = `${base}.srt`;
      try {
        await fs.promises.copyFile(clip.subtitlePath, subtitle);
      } catch (_) {
        subtitle = null;              // a missing .srt must not fail the export
      }
    }

    // The title/description/hashtag file always travels with its clip: it is
    // tiny, and it is the whole point of having asked for it.
    let meta = null;
    if (clip.metaPath && fs.existsSync(clip.metaPath)) {
      meta = `${base}.txt`;
      try {
        await fs.promises.copyFile(clip.metaPath, meta);
      } catch (_) {
        meta = null;
      }
    }

    exported.push({
      index: clip.index,
      title: clip.title,
      path: target,
      name: path.basename(target),
      subtitlePath: subtitle,
      metaPath: meta,
      sizeBytes: clip.sizeBytes || 0
    });

    onProgress({
      stage: 'export',
      percent: ((order + 1) / source.length) * 96,
      message: `Copying ${order + 1}/${source.length}…`,
      done: order + 1,
      total: source.length
    });
  }

  if (!exported.length) throw new Error('No clip files were found on disk — make the clips again.');

  let freedBytes = 0;
  let removed = false;
  if (deleteAfter) {
    onProgress({ stage: 'export', percent: 98, message: 'Deleting the temporary project…' });
    freedBytes = dirSize(dir);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      removed = true;
    } catch (err) {
      // Windows can hold a handle open for a moment after ffmpeg exits; one
      // retry is enough in practice, and a leftover folder is swept on startup.
      await new Promise((resolve) => setTimeout(resolve, 400));
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        removed = true;
      } catch (_) {
        freedBytes = 0;
      }
    }
  }

  onProgress({
    stage: 'done',
    percent: 100,
    message: `Exported ${exported.length} clip${exported.length === 1 ? '' : 's'}`
  });

  return { exported, destDir, removed, freedBytes, projectId: project.id };
}

/** Throw away a project without exporting (Cancel / "start over"). */
function discardProject(options = {}) {
  const { dataDir, projectDir } = options;
  const dir = assertInsideProjects(dataDir, projectDir);
  if (!fs.existsSync(dir)) return { removed: false, freedBytes: 0 };
  const freedBytes = dirSize(dir);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    return { removed: false, freedBytes: 0, error: err.message };
  }
  return { removed: true, freedBytes };
}

/**
 * Startup cleanup. A crash, a power cut or a "close the window mid-render"
 * leaves a project folder holding a whole downloaded video, so anything older
 * than maxAgeHours is removed before the user can notice the disk shrinking.
 */
function sweepStale(options = {}) {
  const { dataDir, maxAgeHours = 12, keepDir = null } = options;
  const root = projectsRoot(dataDir);
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (_) {
    return { removed: 0, freedBytes: 0 };
  }

  const cutoff = Date.now() - Math.max(0, Number(maxAgeHours) || 0) * 3600 * 1000;
  const keep = keepDir ? path.resolve(keepDir) : null;
  let removed = 0;
  let freedBytes = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(root, entry.name);
    if (keep && path.resolve(full) === keep) continue;

    let stamp = 0;
    const project = readJson(path.join(full, 'project.json'));
    if (project && project.createdAt) stamp = Date.parse(project.createdAt) || 0;
    if (!stamp) {
      try { stamp = fs.statSync(full).mtimeMs; } catch (_) { stamp = 0; }
    }
    if (stamp && stamp > cutoff) continue;

    const bytes = dirSize(full);
    try {
      fs.rmSync(full, { recursive: true, force: true });
      removed += 1;
      freedBytes += bytes;
    } catch (_) { /* try again next launch */ }
  }
  return { removed, freedBytes };
}

/** Projects still on disk, newest first — lets the UI offer "resume". */
function listProjects(dataDir) {
  const root = projectsRoot(dataDir);
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (_) {
    return [];
  }

  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(root, entry.name);
    const project = readJson(path.join(full, 'project.json'));
    if (!project) continue;
    out.push({
      id: project.id || entry.name,
      dir: full,
      title: project.title || entry.name,
      url: project.url || '',
      duration: project.duration || 0,
      clipCount: (project.clips || []).length,
      renderedCount: (project.rendered || []).length,
      createdAt: project.createdAt || null,
      bytes: dirSize(full)
    });
  }
  out.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return out;
}

module.exports = {
  analyze,
  renderClips,
  exportClips,
  discardProject,
  sweepStale,
  listProjects,
  projectsRoot,
  binDir,
  dirSize,
  PROJECTS_DIR_NAME
};
