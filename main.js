const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');
const https = require('https');
const { spawn } = require('child_process');
const ffprobeStatic = require('ffprobe-static');

const DATA_DIR = process.env.VIDEO_EDITOR_DATA_DIR || (app.isPackaged
  ? path.join(path.dirname(process.execPath), 'data')
  : path.join(__dirname, 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true });
process.env.VIDEO_EDITOR_DATA_DIR = DATA_DIR;

const { JobToken } = require('./utils/pythonRunner');
const { generateTimeline } = require('./utils/timelineEngine');
const { matchImages } = require('./utils/imageMatcher');
const { renderVideo, resolveFfmpeg } = require('./utils/videoRenderer');
const transcriptCache = require('./utils/transcriptCache');
const projectStore = require('./utils/projectStore');
const clipStudio = require('./utils/clipStudio');
const licenseService = require('./utils/licenseService');
const enhancements = require('./utils/enhancements');

// In-app automatic updates. Only meaningful in a packaged build — in dev there
// is no update feed and the calls below are no-ops. Every call is guarded so a
// missing/unreachable feed (until the build is published) can never crash the
// app or block start-up.
const { autoUpdater } = require('electron-updater');

app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');

const OUTPUT_DIR = path.join(DATA_DIR, 'generated_videos');
const PACK_DIR = path.join(DATA_DIR, 'library', 'packs');

/**
 * What the background-music picker will show. Video containers are in the list
 * on purpose — a song saved as .mp4 is still music, and FFmpeg reads its audio
 * stream without touching the pictures.
 */
const MUSIC_EXTENSIONS = [
  'mp3', 'wav', 'm4a', 'aac', 'ogg', 'opus', 'flac', 'wma',
  'mp4', 'mkv', 'webm', 'm4v', 'mov', 'avi'
];

/** Refuse to start a download unless this much room is free on the data drive. */
const MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Caption templates the renderer is allowed to ask for. This list has to match
 * CAPTION_TEMPLATES in python/clip_renderer.py and the one in renderer.js;
 * anything not listed here is replaced with 'bold' rather than passed through.
 */
const CAPTION_TEMPLATE_KEYS = [
  'bold', 'boxed', 'clean',
  'karaoke', 'karaoke_green', 'hormozi', 'beast', 'pop_word', 'one_word',
  'neon', 'sunset', 'yellow', 'mint', 'alert', 'sticker',
  'podcast', 'tiktok', 'minimal', 'serif', 'mono', 'news',
  'top', 'top_box', 'middle'
];

function safeCaptionStyle(value) {
  return CAPTION_TEMPLATE_KEYS.includes(value) ? value : 'bold';
}

const FRAMING_KEYS = ['crop', 'blur', 'track'];

function safeFraming(value) {
  return FRAMING_KEYS.includes(value) ? value : 'crop';
}

// Whisper's own language codes. 'auto' means let it detect.
const LANGUAGE_KEYS = [
  'auto', 'en', 'ur', 'hi', 'ar', 'pa', 'fa', 'bn', 'es', 'fr', 'de', 'pt',
  'ru', 'tr', 'id', 'ms', 'zh', 'ja', 'ko', 'it', 'nl'
];

function safeLanguage(value) {
  const code = String(value || 'auto').toLowerCase();
  return LANGUAGE_KEYS.includes(code) ? code : 'auto';
}

/**
 * A caption colour arrives from the UI as a web #RRGGBB, but ASS wants BBGGRR.
 * Anything that is not six hex digits is dropped rather than guessed at, so the
 * template's own colour stays in place.
 */
function safeColour(value) {
  const hex = String(value || '').trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return '';
  const upper = hex.toUpperCase();
  return upper.slice(4, 6) + upper.slice(2, 4) + upper.slice(0, 2);
}

/** One line of overlay text: no line breaks, no runaway paragraph. */
function safeText(value, limit = 90) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function resolveFfprobe() {
  const unpacked = ffprobeStatic.path.replace(
    `${path.sep}app.asar${path.sep}`,
    `${path.sep}app.asar.unpacked${path.sep}`
  );
  return fs.existsSync(unpacked) ? unpacked : ffprobeStatic.path;
}

let mainWindow = null;
let activeJob = null;        // { token, projectId }
let lastGeneratedPath = null;
let lastPercent = 0;
let clipProject = null;      // the one Clipping-by-Saim job currently on disk

/** Keep costly/download-capable actions behind the server-verified license. */
async function requireLicense() {
  const status = await licenseService.verify(DATA_DIR);
  if (!status.allowed) {
    const error = new Error(status.reason || 'An approved license is required.');
    error.code = 'LICENSE_REQUIRED';
    throw error;
  }
  return status;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 860,
    minWidth: 1100,
    minHeight: 700,
    title: 'Clipping by Saim',
    icon: path.join(__dirname, 'assets', 'logo-32.png'),
    backgroundColor: '#14161a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  });

  mainWindow.loadFile('index.html');
  // The editor never needs popup windows or navigation away from its local UI.
  // Keeping both closed removes two common Electron attack surfaces.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.on('closed', () => { mainWindow = null; });
}

/* --------------------------------------------------------- in-app updates */

/**
 * Forward one update event to the renderer so the UI can show a friendly
 * "Update available / downloading / ready to restart" message instead of the
 * raw autoUpdater outcome.
 */
function sendUpdateEvent(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app-update', payload);
  }
}

function setupAutoUpdater() {
  // Updates only make sense from an installed package; a dev/source run has no
  // feed and must never try to phone home about it.
  if (!app.isPackaged) {
    autoUpdater.autoDownload = false;
    return;
  }

  try {
    autoUpdater.autoDownload = false;      // ask the user before downloading
    autoUpdater.autoInstallOnAppQuit = false;

    autoUpdater.on('checking-for-update', () => sendUpdateEvent({ type: 'checking' }));
    autoUpdater.on('update-available', (info) =>
      sendUpdateEvent({ type: 'available', version: info && info.version }));
    autoUpdater.on('update-not-available', () => sendUpdateEvent({ type: 'not-available' }));
    autoUpdater.on('error', (error) =>
      sendUpdateEvent({ type: 'error', message: error && error.message }));
    autoUpdater.on('download-progress', (progress) =>
      sendUpdateEvent({ type: 'progress', percent: progress && progress.percent }));
    autoUpdater.on('update-downloaded', async (info) => {
      sendUpdateEvent({ type: 'downloaded', version: info && info.version });
      // Ask the user, then quit + install. Prompting before quitting avoids
      // interrupting work in progress.
      const { response } = await dialog.showMessageBox({
        type: 'info',
        title: 'Update ready',
        message: `Version ${info && info.version} has been downloaded.`,
        detail: 'Restart now to finish updating? Your current work will close.',
        buttons: ['Restart now', 'Later'],
        defaultId: 0,
        cancelId: 1
      });
      if (response === 0) {
        try { autoUpdater.quitAndInstall(); } catch (_) { /* retry on next launch */ }
      }
    });

    // Start checking shortly after launch so the app never waits on the network
    // before showing its first window.
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch((err) => {
        // No feed yet (not published) → not an error the user should see.
        sendUpdateEvent({ type: 'not-available' });
        console.warn('Update check skipped:', err && err.message);
      });
    }, 8000);
  } catch (err) {
    console.warn('Auto-updater could not start:', err && err.message);
  }
}

// Manual trigger + result channel for the renderer's "Check for updates" button.
ipcMain.handle('app-check-updates', async () => {
  if (!app.isPackaged) return { success: false, error: 'Updates are only available in installed builds.' };
  try {
    await autoUpdater.checkForUpdates();
    return { success: true };
  } catch (error) {
    return { success: false, error: error && error.message };
  }
});

ipcMain.handle('app-download-update', async () => {
  if (!app.isPackaged) return { success: false, error: 'Updates are only available in installed builds.' };
  try {
    await autoUpdater.downloadUpdate();
    return { success: true };
  } catch (error) {
    return { success: false, error: error && error.message };
  }
});

ipcMain.handle('app-install-update', () => {
  if (!app.isPackaged) return { success: false, error: 'Updates are only available in installed builds.' };
  try {
    autoUpdater.quitAndInstall();
    return { success: true };
  } catch (error) {
    return { success: false, error: error && error.message };
  }
});

app.whenReady().then(() => {
  createWindow();
  // A crash or a force-quit can leave a whole downloaded video behind. This
  // machine has very little free space, so reclaim it before the user notices.
  try {
    const swept = clipStudio.sweepStale({ dataDir: DATA_DIR, maxAgeHours: 12 });
    if (swept.removed) {
      console.log(`Swept ${swept.removed} stale clip project(s), freed ${swept.freedBytes} bytes`);
    }
  } catch (err) {
    console.warn('Clip project sweep failed:', err.message);
  }
  setupAutoUpdater();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => {
  // A render in flight owns FFmpeg child processes. Without this they survive
  // the window closing and keep pegging the CPU with no UI to stop them.
  if (activeJob) activeJob.token.abort();
  // An un-exported clip project is pure temp data: dropping it on exit is the
  // whole point of the "no disk-space problem" rule.
  if (clipProject && clipProject.dir) {
    try {
      clipStudio.discardProject({ dataDir: DATA_DIR, projectDir: clipProject.dir });
    } catch (_) { /* swept on next launch */ }
    clipProject = null;
  }
  if (process.platform !== 'darwin') app.quit();
});

/**
 * Forward one progress update to the UI.
 *
 * The bar is clamped monotonic on purpose: separate stages report on their own
 * schedules, and a bar that jumps backwards reads as a bug even when the
 * underlying work is fine.
 */
function sendProgress(payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  let percent = lastPercent;
  if (typeof payload.percent === 'number' && Number.isFinite(payload.percent)) {
    percent = Math.max(lastPercent, Math.min(100, payload.percent));
    lastPercent = percent;
  }

  mainWindow.webContents.send('generation-progress', {
    ...payload,
    percent: Math.round(percent * 10) / 10
  });
}

function describeFile(filePath) {
  return {
    path: filePath,
    name: path.basename(filePath),
    // Built with pathToFileURL, not string concatenation: this project lives
    // under "D:\my own tool\...", and the spaces and backslashes in a
    // hand-built file:// URL are exactly what breaks <img> and <video> sources.
    url: pathToFileURL(filePath).href
  };
}

/** Cap any preset-pack download at 10 MB — a pack bigger than that is wrong. */
const MAX_PACK_BYTES = 10 * 1024 * 1024;

function downloadText(url, maxBytes = MAX_PACK_BYTES) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'VideoEditor/1.0' } }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        return downloadText(response.headers.location, maxBytes).then(resolve, reject);
      }
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error(`Download failed with HTTP ${response.statusCode}`));
      }
      let body = '';
      let received = 0;
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        received += Buffer.byteLength(chunk);
        if (received > maxBytes) {
          response.destroy();
          return reject(new Error(`Download exceeded the ${Math.round(maxBytes / 1024 / 1024)} MB limit.`));
        }
        body += chunk;
      });
      response.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

ipcMain.handle('download-preset-pack', async (_event, packName = 'emoji') => {
  const packs = {
    emoji: 'https://raw.githubusercontent.com/iamcal/emoji-data/master/emoji.json'
  };
  if (!packs[packName]) return { success: false, error: 'Unknown preset pack.' };
  try {
    const body = await downloadText(packs[packName]);
    JSON.parse(body);
    fs.mkdirSync(PACK_DIR, { recursive: true });
    const outputPath = path.join(PACK_DIR, `${packName}.json`);
    fs.writeFileSync(outputPath, body, 'utf8');
    return { success: true, packName, outputPath, bytes: Buffer.byteLength(body) };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

/* ------------------------------------------------------------------ pickers */

ipcMain.handle('select-audio-file', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose the voiceover',
    properties: ['openFile'],
    filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'] }]
  });
  if (canceled || !filePaths.length) return null;
  return describeFile(filePaths[0]);
});

ipcMain.handle('select-image-files', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose the images',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }]
  });
  if (canceled || !filePaths.length) return [];

  // Sorted by filename so "01_intro.png, 02_city.png" behaves the way the
  // numbering implies. The OS returns selection order, which is arbitrary.
  return filePaths
    .slice()
    .sort((a, b) => path.basename(a).localeCompare(path.basename(b), undefined, { numeric: true }))
    .map(describeFile);
});

/**
 * Background music picker.
 *
 * Song *videos* count as music here: most people keep their music as mp4/mkv
 * files downloaded from YouTube, and a folder full of those used to look empty
 * because the filter only listed audio extensions. FFmpeg takes the audio
 * stream out of a video input just as happily, so both lists are offered — and
 * "All files" is last so an odd extension is never invisible.
 */
ipcMain.handle('select-music-file', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose background music (audio or song video)',
    properties: ['openFile'],
    filters: [
      { name: 'Music (audio or video)', extensions: MUSIC_EXTENSIONS },
      { name: 'Audio only', extensions: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'opus', 'flac', 'wma'] },
      { name: 'Video only', extensions: ['mp4', 'mkv', 'webm', 'm4v', 'mov', 'avi'] },
      { name: 'All files', extensions: ['*'] }
    ]
  });
  if (canceled || !filePaths.length) return null;
  return describeFile(filePaths[0]);
});

ipcMain.handle('select-video-file', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose overlay video',
    properties: ['openFile'],
    filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'webm', 'mkv', 'avi'] }]
  });
  if (canceled || !filePaths.length) return null;
  return describeFile(filePaths[0]);
});

/** The only directory picker in the app — where exported clips are written. */
ipcMain.handle('select-export-folder', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Where should the clips be saved?',
    properties: ['openDirectory', 'createDirectory']
  });
  if (canceled || !filePaths.length) return null;
  return { path: filePaths[0], name: path.basename(filePaths[0]) || filePaths[0] };
});

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (data) => { stdout += data.toString(); });
    child.stderr?.on('data', (data) => { stderr += data.toString(); });
    child.on('error', reject);
    child.on('close', (code) => code === 0
      ? resolve(stdout)
      : reject(new Error(stderr.trim() || `Process exited with code ${code}`)));
  });
}

ipcMain.handle('create-short-clips', async (_event, payload = {}) => {
  try { await requireLicense(); } catch (error) { return { success: false, error: error.message, code: error.code }; }
  const inputPath = payload.inputPath;
  if (!inputPath || !fs.existsSync(inputPath)) {
    return { success: false, error: 'Choose a video file first.' };
  }
  const length = Math.max(5, Math.min(60, Number(payload.length) || 10));
  const count = Math.max(1, Math.min(50, Number(payload.count) || 10));
  const platform = String(payload.platform || 'youtube');
  const musicPath = payload.musicPath && fs.existsSync(payload.musicPath) ? payload.musicPath : null;
  const aspect = platform === 'youtube-wide' ? 'wide' : platform === 'square' ? 'square' : 'vertical';
  const filters = {
    vertical: 'crop=ih*9/16:ih:(iw-ih*9/16)/2:0,scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black',
    wide: 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black',
    square: 'crop=ih:ih:(iw-ih)/2:0,scale=1080:1080'
  };
  try {
    const durationText = await runProcess(resolveFfprobe(), [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', inputPath
    ]);
    const duration = Number.parseFloat(durationText);
    if (!Number.isFinite(duration) || duration < 1) throw new Error('Could not read video duration.');
    const outputDir = path.join(DATA_DIR, 'short_clips');
    fs.mkdirSync(outputDir, { recursive: true });
    const usableLength = Math.min(length, duration);
    const maxStart = Math.max(0, duration - usableLength);
    const clips = [];
    for (let index = 0; index < count; index += 1) {
      const start = count === 1 ? 0 : (maxStart * index) / (count - 1);
      const outputPath = path.join(outputDir, `clip_${Date.now()}_${String(index + 1).padStart(2, '0')}.mp4`);
      const ffmpegArgs = [
        '-ss', start.toFixed(3), '-i', inputPath, '-t', usableLength.toFixed(3),
        '-vf', filters[aspect]
      ];
      if (musicPath) {
        ffmpegArgs.push('-stream_loop', '-1', '-i', musicPath, '-filter_complex',
          '[0:a]volume=1.0[original];[1:a]volume=0.18[music];[original][music]amix=inputs=2:duration=first:dropout_transition=2[aout]',
          '-map', '0:v:0', '-map', '[aout]');
      } else {
        ffmpegArgs.push('-map', '0:v:0', '-map', '0:a?');
      }
      ffmpegArgs.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-shortest', outputPath);
      await runProcess(resolveFfmpeg(), ffmpegArgs);
      clips.push({ index: index + 1, start, duration: usableLength, path: outputPath, url: pathToFileURL(outputPath).href });
    }
    return { success: true, clips, platform, aspect, duration };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('select-font-file', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose custom font',
    properties: ['openFile'],
    filters: [{ name: 'Font', extensions: ['ttf', 'otf'] }]
  });
  if (canceled || !filePaths.length) return null;
  return describeFile(filePaths[0]);
});

/** Lets the UI warn before someone picks 1440p on a 4GB box. */
ipcMain.handle('get-system-info', () => {
  const free = freeSpaceBytes(DATA_DIR);
  return {
    cores: os.cpus()?.length || 1,
    totalGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    freeGb: Math.round((os.freemem() / 1024 ** 3) * 10) / 10,
    // Disk, not memory: on a nearly full drive this is the number that decides
    // whether a download can even be attempted.
    freeDiskGb: free === null ? null : Math.round((free / 1024 ** 3) * 10) / 10,
    platform: process.platform,
    ffmpegPath: resolveFfmpeg()
  };
});

/* Licensing: the renderer never sees an encrypted session or device identity. */
ipcMain.handle('license-status', () => licenseService.verify(DATA_DIR));
ipcMain.handle('license-request-access', async (_event, email) => {
  try { return await licenseService.requestAccess(email, app.getVersion()); }
  catch (error) { return { success: false, error: error.message }; }
});
ipcMain.handle('license-sign-in', async (_event, payload = {}) => {
  try { return await licenseService.signIn(DATA_DIR, payload.email, payload.password); }
  catch (error) { return { success: false, error: error.message }; }
});
ipcMain.handle('license-sign-out', () => { licenseService.clearSession(DATA_DIR); return { success: true }; });
ipcMain.handle('license-approve-customer', async (_event, payload = {}) => {
  try { return await licenseService.approveCustomer(DATA_DIR, payload.email, payload.deviceLimit); }
  catch (error) { return { success: false, error: error.message }; }
});

ipcMain.handle('license-list-requests', async () => {
  try { return await licenseService.listRequests(DATA_DIR); }
  catch (error) { return { success: false, error: error.message }; }
});

ipcMain.handle('license-revoke-customer', async (_event, payload = {}) => {
  try { return await licenseService.revokeCustomer(DATA_DIR, payload.email, payload.status); }
  catch (error) { return { success: false, error: error.message }; }
});

ipcMain.handle('license-list-customers', async () => {
  try { return await licenseService.listCustomers(DATA_DIR); }
  catch (error) { return { success: false, error: error.message }; }
});

/* ----------------------------------------------------------------- generate */

function outputPathFor() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  return path.join(OUTPUT_DIR, `video_${stamp}.mp4`);
}

function thumbnailPathFor(videoPath) {
  return `${videoPath}.jpg`;
}

function createThumbnail(videoPath) {
  const thumbnailPath = thumbnailPathFor(videoPath);
  return new Promise((resolve) => {
    const child = spawn(resolveFfmpeg(), [
      '-hide_banner', '-loglevel', 'error', '-y', '-ss', '0.5', '-i', videoPath,
      '-frames:v', '1', '-vf', 'scale=320:-1', thumbnailPath
    ], { windowsHide: true });
    child.on('close', () => resolve(fs.existsSync(thumbnailPath) ? thumbnailPath : null));
    child.on('error', () => resolve(null));
  });
}

ipcMain.handle('generate-video', async (_event, payload = {}) => {
  try { await requireLicense(); } catch (error) { return { success: false, error: error.message, code: error.code }; }
  if (activeJob) {
    return { success: false, error: 'A video is already being generated.' };
  }

  const {
    audioPath,
    imagePaths = [],
    modelSize = 'base',
    // 'filename' to match the UI's own default. 'content' loads CLIP + torch,
    // which is the slowest and most memory-hungry path in the app, so it must
    // never be what an incomplete payload falls back to.
    matchMode = 'filename',
    useCache = true,
    captionSettings = {},
    musicSettings = {},
    effectSettings = {},
    overlaySettings = [],
    videoTracks = [],
    trimSettings = {},
    fontSettings = {},
    exportSettings = {},
    timelineOverride = null,
    timelineSegments = [],
    timelineDuration = 0
  } = payload;

  if (!audioPath || !fs.existsSync(audioPath)) {
    return { success: false, error: 'Pick a voiceover file first.' };
  }
  if (!imagePaths.length) {
    return { success: false, error: 'Pick at least one image.' };
  }

  const missing = imagePaths.filter((p) => !fs.existsSync(p));
  if (missing.length) {
    return {
      success: false,
      error: `${missing.length} image(s) are no longer on disk, starting with ${path.basename(missing[0])}.`
    };
  }

  const token = new JobToken();
  const outputPath = outputPathFor();
  const startedAt = Date.now();

  lastPercent = 0;
  const record = projectStore.insert({
    status: 'running',
    audioPath,
    audioName: path.basename(audioPath),
    imageCount: imagePaths.length,
    modelSize,
    matchMode,
    exportSettings,
    outputPath
  });
  activeJob = { token, projectId: record.id };

  const onProgress = (update) => sendProgress(update);

  try {
    sendProgress({ stage: 'start', percent: 1, message: 'Starting up' });

    // 1. Transcribe + schedule (3..62)
    const timeline = Array.isArray(timelineOverride) && timelineOverride.length &&
      Array.isArray(timelineSegments) && timelineSegments.length && timelineDuration
      ? {
          duration: Number(timelineDuration),
          segments: timelineSegments,
          words: [],
          schedule: timelineOverride,
          fromCache: true
        }
      : await generateTimeline(audioPath, imagePaths.length, {
          modelSize, useCache, onProgress, token
        });

    // 2. Decide which image lands in which slot (62..65)
    const match = await matchImages({
      imagePaths,
      segments: timeline.segments,
      schedule: timeline.schedule,
      mode: timelineOverride && timelineOverride.length ? 'order' : matchMode,
      onProgress,
      token
    });

    // 3. Encode (65..100)
    const rendered = await renderVideo({
      audioPath,
      imagePaths,
      schedule: match.schedule,
      segments: timeline.segments,
      duration: timeline.duration,
      captionSettings,
      musicSettings,
      effectSettings,
      overlaySettings,
      videoTracks,
      trimSettings,
      fontSettings,
      exportSettings,
      outputPath,
      onProgress,
      token
    });

    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    sendProgress({ stage: 'done', percent: 100, message: `Finished in ${elapsed}s` });

    lastGeneratedPath = outputPath;
    const thumbnailPath = await createThumbnail(outputPath);
    projectStore.update(record.id, {
      status: 'completed',
      durationSeconds: timeline.duration,
      renderSeconds: elapsed,
      fromCache: Boolean(timeline.fromCache),
      matchMode: match.mode,
      subtitlePath: rendered.subtitlePath || null,
      thumbnailPath,
      sizeBytes: fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0
    });

    return {
      success: true,
      outputPath,
      url: pathToFileURL(outputPath).href,
      duration: timeline.duration,
      renderSeconds: elapsed,
      fromCache: Boolean(timeline.fromCache),
      matchMode: match.mode,
      workers: rendered.workers,
      schedule: match.schedule,
      segments: timeline.segments,
      subtitlePath: rendered.subtitlePath || null,
      captionsBurned: Boolean(rendered.captionsBurned),
      warnings: [match.warning, rendered.captionWarning, rendered.scheduleWarning].filter(Boolean)
    };
  } catch (err) {
    const cancelled = Boolean(err && err.cancelled);
    projectStore.update(record.id, {
      status: cancelled ? 'cancelled' : 'failed',
      error: cancelled ? null : String(err && err.message ? err.message : err),
      renderSeconds: Math.round((Date.now() - startedAt) / 1000)
    });

    // A cancelled run leaves a half-written file that would only confuse the
    // gallery later.
    if (fs.existsSync(outputPath)) {
      try { fs.unlinkSync(outputPath); } catch (_) { /* locked; harmless */ }
    }

    sendProgress({
      stage: cancelled ? 'cancelled' : 'error',
      message: cancelled ? 'Cancelled' : `Failed: ${err.message}`
    });

    return { success: false, cancelled, error: cancelled ? 'Cancelled' : err.message };
  } finally {
    activeJob = null;
  }
});

ipcMain.handle('cancel-generate', () => {
  if (!activeJob) return { cancelled: false };
  activeJob.token.abort();
  return { cancelled: true };
});

/* -------------------------------------------------------- Clipping by Saim */

function clampInt(value, low, high, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(low, Math.min(high, Math.round(number)));
}

function clampFloat(value, low, high, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(low, Math.min(high, number));
}

/** Every clip handler fails the same way, so the renderer only needs one path. */
function clipFailure(err) {
  const cancelled = Boolean(err && err.cancelled);
  const message = String(err && err.message ? err.message : err);
  sendProgress({
    stage: cancelled ? 'cancelled' : 'error',
    message: cancelled ? 'Cancelled' : message
  });
  return { success: false, cancelled, error: cancelled ? 'Cancelled' : message };
}

/**
 * Free bytes on the drive that holds `dir`, or null when it cannot be read.
 *
 * fs.statfsSync landed in Node 18.15 (Electron 27 ships 18.17) but the typeof
 * guard keeps an older runtime from turning a disk check into a crash — an
 * unknown answer means "carry on", never "refuse".
 */
function freeSpaceBytes(dir) {
  try {
    if (typeof fs.statfsSync !== 'function') return null;
    const info = fs.statfsSync(dir);
    const block = Number(info.bsize);
    const available = Number(info.bavail);
    if (!Number.isFinite(block) || !Number.isFinite(available) || block <= 0) return null;
    return block * available;
  } catch (_) {
    return null;
  }
}

function formatGb(bytes) {
  return `${Math.round((bytes / 1024 ** 3) * 10) / 10} GB`;
}

/** Drop whatever project is on disk. Called before starting a new one. */
function dropClipProject() {
  if (!clipProject || !clipProject.dir) {
    clipProject = null;
    return { removed: false, freedBytes: 0 };
  }
  let result = { removed: false, freedBytes: 0 };
  try {
    result = clipStudio.discardProject({ dataDir: DATA_DIR, projectDir: clipProject.dir });
  } catch (_) { /* swept on next launch */ }
  clipProject = null;
  return result;
}

ipcMain.handle('clip-analyze', async (_event, payload = {}) => {
  try { await requireLicense(); } catch (error) { return { success: false, error: error.message, code: error.code }; }
  if (activeJob) return { success: false, error: 'Another job is already running.' };

  const url = String(payload.url || '').trim();
  if (!url) return { success: false, error: 'Paste a YouTube link first.' };

  // Only ever one project on disk: the previous one goes before the next
  // download starts, which is what keeps this usable on a nearly full drive.
  dropClipProject();
  // dropClipProject only knows the pointer this process holds. A project left
  // by an earlier session (crash, force-quit) is younger than the 12h startup
  // sweep, so wipe every leftover here too — maxAgeHours: 0 means "all of them".
  try {
    const swept = clipStudio.sweepStale({ dataDir: DATA_DIR, maxAgeHours: 0 });
    if (swept.removed) console.log(`Cleared ${swept.removed} leftover clip project(s)`);
  } catch (err) {
    console.warn('Leftover clip project cleanup failed:', err.message);
  }

  // Space check *after* the sweep, so the room the sweep just reclaimed counts.
  // Better to say "there isn't room" in one clear line than to die halfway
  // through a download and leave a part-file behind.
  // lastPercent is reset first: sendProgress floors every update at the last
  // value it sent, so without this the message below would arrive carrying the
  // 100% left over from the previous job and fill the bar before anything ran.
  lastPercent = 0;
  const free = freeSpaceBytes(DATA_DIR);
  if (free !== null && free < MIN_FREE_BYTES) {
    return clipFailure(new Error(
      `Not enough free space: ${formatGb(free)} left on this drive, and about `
      + `${formatGb(MIN_FREE_BYTES)} is needed to download the video and write the clips. `
      + `Free some space, then try again. The working folder is ${DATA_DIR}`
    ));
  }
  if (free !== null && free < MIN_FREE_BYTES * 2) {
    // Enough to start, not enough to be relaxed about a two-hour upload.
    sendProgress({
      stage: 'space',
      percent: 0,
      message: `Only ${formatGb(free)} free — fine for a short video, tight for a long one`
    });
  }

  const token = new JobToken();
  activeJob = { token, projectId: 'clip-analyze' };
  lastPercent = 0;

  try {
    sendProgress({ stage: 'start', percent: 1, message: 'Checking the link…' });
    const result = await clipStudio.analyze({
      url,
      dataDir: DATA_DIR,
      ffmpegPath: resolveFfmpeg(),
      clipCount: clampInt(payload.clipCount, 1, 20, 10),
      minDuration: clampInt(payload.minDuration, 5, 120, 15),
      maxDuration: clampInt(payload.maxDuration, 10, 180, 60),
      targetDuration: clampInt(payload.targetDuration, 5, 180, 30),
      modelSize: payload.modelSize === 'base' ? 'base' : 'tiny',
      language: safeLanguage(payload.language),
      translate: payload.translate === true,
      maxHeight: clampInt(payload.maxHeight, 360, 1080, 720),
      useCache: payload.useCache !== false,
      onProgress: sendProgress,
      token
    });

    clipProject = { id: result.id, dir: result.dir };
    return { success: true, ...result };
  } catch (err) {
    // A failed analyse leaves a part-downloaded video behind; bin it.
    dropClipProject();
    return clipFailure(err);
  } finally {
    activeJob = null;
  }
});

ipcMain.handle('clip-render', async (_event, payload = {}) => {
  try { await requireLicense(); } catch (error) { return { success: false, error: error.message, code: error.code }; }
  if (activeJob) return { success: false, error: 'Another job is already running.' };

  const projectDir = payload.projectDir || (clipProject && clipProject.dir);
  if (!projectDir) return { success: false, error: 'Analyse a link first.' };

  const token = new JobToken();
  activeJob = { token, projectId: 'clip-render' };
  lastPercent = 0;

  try {
    sendProgress({ stage: 'clips', percent: 1, message: 'Starting the clips…' });
    const result = await clipStudio.renderClips({
      projectDir,
      dataDir: DATA_DIR,
      ffmpegPath: resolveFfmpeg(),
      clips: (Array.isArray(payload.clips) ? payload.clips : []).map((clip) => {
        if (!clip || typeof clip !== 'object') return clip;
        const safe = { ...clip };
        if (safe.captionStyle) safe.captionStyle = safeCaptionStyle(safe.captionStyle);
        if (safe.hook) safe.hook = safeText(safe.hook);
        return safe;
      }),
      aspect: ['vertical', 'square', 'wide'].includes(payload.aspect) ? payload.aspect : 'vertical',
      quality: String(payload.quality) === '1080' ? '1080' : '720',
      fps: clampInt(payload.fps, 15, 60, 30),
      captionMode: payload.captionMode === 'off' ? 'off' : 'burn',
      captionStyle: safeCaptionStyle(payload.captionStyle),
      captionPrimary: safeColour(payload.captionPrimary),
      captionHighlight: safeColour(payload.captionHighlight),
      musicDuck: payload.musicDuck !== false,
      fontName: String(payload.fontName || 'Arial'),
      framing: safeFraming(payload.framing),
      logoPath: typeof payload.logoPath === 'string' ? payload.logoPath : '',
      logoScale: clampFloat(payload.logoScale, 0.05, 0.5, 0.18),
      logoOpacity: clampFloat(payload.logoOpacity, 0.1, 1, 0.85),
      hook: safeText(payload.hook),
      hookSeconds: clampFloat(payload.hookSeconds, 0.5, 10, 2.5),
      tighten: payload.tighten === true,
      cutFillers: payload.cutFillers !== false,
      writeMeta: payload.writeMeta === true,
      onProgress: sendProgress,
      token
    });
    return { success: true, ...result };
  } catch (err) {
    return clipFailure(err);
  } finally {
    activeJob = null;
  }
});

ipcMain.handle('clip-export', async (_event, payload = {}) => {
  if (activeJob) return { success: false, error: 'Another job is already running.' };

  const projectDir = payload.projectDir || (clipProject && clipProject.dir);
  if (!projectDir) return { success: false, error: 'There is no project to export.' };

  let destDir = payload.destDir;
  if (!destDir) {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: 'Where should the clips be saved?',
      properties: ['openDirectory', 'createDirectory']
    });
    if (canceled || !filePaths.length) return { success: false, cancelled: true };
    destDir = filePaths[0];
  }

  const token = new JobToken();
  activeJob = { token, projectId: 'clip-export' };
  lastPercent = 0;

  try {
    sendProgress({ stage: 'export', percent: 2, message: 'Copying the clips…' });
    const result = await clipStudio.exportClips({
      projectDir,
      dataDir: DATA_DIR,
      destDir,
      only: Array.isArray(payload.only) && payload.only.length ? payload.only : null,
      includeSubtitles: payload.includeSubtitles !== false,
      // The default the user asked for: after export the tool goes back to
      // normal and the temp project disappears.
      deleteAfter: payload.deleteAfter !== false,
      onProgress: sendProgress,
      token
    });
    if (result.removed) clipProject = null;
    return { success: true, ...result };
  } catch (err) {
    return clipFailure(err);
  } finally {
    activeJob = null;
  }
});

ipcMain.handle('clip-discard', (_event, payload = {}) => {
  if (activeJob) return { success: false, error: 'Cancel the running job first.' };
  lastPercent = 0;

  const tracked = clipProject && clipProject.dir;
  const asked = payload && payload.projectDir;

  // A crash can leave an untracked project behind; the renderer passes its dir
  // so the delete still works. assertInsideProjects (in clipStudio) keeps this
  // from ever pointing outside the clip_projects folder.
  if (asked && asked !== tracked) {
    try {
      const result = clipStudio.discardProject({ dataDir: DATA_DIR, projectDir: asked });
      return { success: true, ...result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  return { success: true, ...dropClipProject() };
});

/** What is on disk right now — lets the UI recover after a reload. */
ipcMain.handle('clip-status', () => ({
  active: Boolean(activeJob),
  project: clipProject,
  projects: clipStudio.listProjects(DATA_DIR)
}));


/* ------------------------------------------------------------------ library */

ipcMain.handle('save-project', async (_event, project = {}) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Save project',
    defaultPath: 'video-project.json',
    filters: [{ name: 'Video project', extensions: ['json'] }]
  });
  if (canceled || !filePath) return { success: false, cancelled: true };

  try {
    const safeProject = { ...project, formatVersion: 1, savedAt: new Date().toISOString() };
    const tempPath = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(safeProject, null, 2), 'utf8');
    fs.renameSync(tempPath, filePath);
    return { success: true, filePath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('load-project', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Open project',
    properties: ['openFile'],
    filters: [{ name: 'Video project', extensions: ['json'] }]
  });
  if (canceled || !filePaths.length) return { success: false, cancelled: true };

  try {
    const project = JSON.parse(fs.readFileSync(filePaths[0], 'utf8'));
    if (!project || project.formatVersion !== 1) {
      return { success: false, error: 'Unsupported or invalid project file.' };
    }
    const mediaPaths = [
      project.audioPath,
      ...(project.imagePaths || []),
      project.musicPath,
      project.fontPath,
      ...((project.audioTracks || []).map((track) => track.path)),
      ...((project.videoTracks || []).map((track) => track.path))
    ].filter(Boolean);
    const missingMedia = mediaPaths.filter((mediaPath) => !fs.existsSync(mediaPath));
    return { success: true, filePath: filePaths[0], project, missingMedia };
  } catch (err) {
    return { success: false, error: `Could not open project: ${err.message}` };
  }
});

ipcMain.handle('export-video', async (_event, sourcePath) => {
  const source = sourcePath || lastGeneratedPath;
  if (!source || !fs.existsSync(source)) {
    return { success: false, error: 'That video is no longer on disk.' };
  }

  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Save video',
    defaultPath: path.basename(source),
    filters: [{ name: 'MP4 video', extensions: ['mp4'] }]
  });
  if (canceled || !filePath) return { success: false, cancelled: true };

  try {
    fs.copyFileSync(source, filePath);
    return { success: true, outputPath: filePath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

/**
 * Only files the app itself produced (inside DATA_DIR) or files the user
 * explicitly picked via a dialog may be revealed/opened. Anything else is
 * refused — this keeps a compromised renderer from opening arbitrary paths.
 */
function isSafeToReveal(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  const resolved = path.resolve(filePath);
  const dataRoot = path.resolve(DATA_DIR);
  return resolved === dataRoot || resolved.startsWith(dataRoot + path.sep);
}

/** Reveal in Explorer/Finder rather than opening the file itself. */
ipcMain.handle('reveal-file', (_event, filePath) => {
  if (isSafeToReveal(filePath) && fs.existsSync(filePath)) {
    shell.showItemInFolder(filePath);
    return true;
  }
  return false;
});

ipcMain.handle('open-file', async (_event, filePath) => {
  if (!isSafeToReveal(filePath) || !fs.existsSync(filePath)) return false;
  const error = await shell.openPath(filePath);
  return !error;
});

ipcMain.handle('list-projects', (_event, limit = 25) => ({
  projects: projectStore.list(limit).map((row) => ({
    ...row,
    fileUrl: row.fileExists ? pathToFileURL(row.outputPath).href : null,
    thumbnailUrl: row.thumbnailPath && fs.existsSync(row.thumbnailPath)
      ? pathToFileURL(row.thumbnailPath).href : null
  })),
  stats: projectStore.stats()
}));

ipcMain.handle('delete-project', (_event, id, alsoDeleteFile = false) => {
  const row = projectStore.get(id);
  if (alsoDeleteFile && row && row.outputPath && fs.existsSync(row.outputPath)) {
    try { fs.unlinkSync(row.outputPath); } catch (_) { /* locked; leave it */ }
  }
  if (alsoDeleteFile && row && row.thumbnailPath && fs.existsSync(row.thumbnailPath)) {
    try { fs.unlinkSync(row.thumbnailPath); } catch (_) { /* best effort */ }
  }
  return { removed: projectStore.remove(id) };
});

ipcMain.handle('cache-stats', () => transcriptCache.stats());

ipcMain.handle('clear-cache', () => transcriptCache.clear());

/* ------------------------------------------------------- enhancements (v1.2) */

// 1. Auto-caption AI — generate hooks/CTAs from a transcript
ipcMain.handle('enhance-generate-hooks', (_event, payload = {}) => {
  const transcript = String(payload.transcript || '');
  const count = clampInt(payload.count, 1, 5, 3);
  return { success: true, hooks: enhancements.generateHooks(transcript, count) };
});

// 2. Multi-language — caption translation presets
ipcMain.handle('enhance-languages', () => ({
  success: true,
  languages: enhancements.getLanguageLabels()
}));

ipcMain.handle('enhance-translate-cta', (_event, payload = {}) => {
  const key = String(payload.key || 'follow');
  const language = String(payload.language || 'en');
  return { success: true, text: enhancements.translateCta(key, language) };
});

// 3. Batch processing — queue multiple YouTube links
const batchQueue = new enhancements.BatchQueue();

ipcMain.handle('enhance-batch-add', (_event, payload = {}) => {
  const url = String(payload.url || '').trim();
  if (!url) return { success: false, error: 'Paste a YouTube link first.' };
  const id = batchQueue.add({ url, settings: payload.settings || {} });
  return { success: true, id, state: batchQueue.getState() };
});

ipcMain.handle('enhance-batch-remove', (_event, id) => {
  const removed = batchQueue.remove(String(id || ''));
  return { success: removed, state: batchQueue.getState() };
});

ipcMain.handle('enhance-batch-clear', () => {
  batchQueue.clear();
  return { success: true, state: batchQueue.getState() };
});

ipcMain.handle('enhance-batch-state', () => ({
  success: true,
  state: batchQueue.getState()
}));

ipcMain.handle('enhance-batch-run', async () => {
  const result = await batchQueue.run(async (item, onProgress) => {
    // Reuse the clip-analyze pipeline for each queued URL
    const token = new JobToken();
    const analyzeResult = await clipStudio.analyze({
      url: item.url,
      dataDir: DATA_DIR,
      ffmpegPath: resolveFfmpeg(),
      clipCount: clampInt(item.settings.clipCount, 1, 20, 10),
      minDuration: clampInt(item.settings.minDuration, 5, 120, 15),
      maxDuration: clampInt(item.settings.maxDuration, 10, 180, 60),
      targetDuration: clampInt(item.settings.targetDuration, 5, 180, 30),
      modelSize: item.settings.modelSize === 'base' ? 'base' : 'tiny',
      language: safeLanguage(item.settings.language),
      translate: item.settings.translate === true,
      maxHeight: clampInt(item.settings.maxHeight, 360, 1080, 720),
      useCache: item.settings.useCache !== false,
      onProgress: (update) => onProgress(update.percent || 0),
      token
    });
    return analyzeResult;
  });
  return result;
});

// 4. Analytics dashboard — owner usage stats
ipcMain.handle('enhance-analytics', (_event, payload = {}) => {
  try {
    const days = clampInt(payload.days, 1, 365, 30);
    return { success: true, analytics: enhancements.getAnalytics(DATA_DIR, days) };
  } catch (_) {
    return { success: true, analytics: { totals: {}, events: [], byDay: [] } };
  }
});

ipcMain.handle('enhance-track-event', (_event, payload = {}) => {
  const type = String(payload.type || '');
  if (!type) return { success: false, error: 'Event type is required.' };
  try {
    const entry = enhancements.trackEvent(DATA_DIR, {
      type,
      count: payload.count,
      url: payload.url,
      platform: payload.platform
    });
    return { success: true, event: entry };
  } catch (_) {
    return { success: true };
  }
});

// 5. Auto-posting — platform export presets
ipcMain.handle('enhance-platforms', () => ({
  success: true,
  platforms: enhancements.getPlatformPresets()
}));

ipcMain.handle('enhance-platform-preset', (_event, key) => ({
  success: true,
  preset: enhancements.getPlatformPreset(String(key || ''))
}));

// 6. Trial/demo mode — watermark + clip limit for unlicensed users
ipcMain.handle('enhance-trial-status', async () => {
  const license = await licenseService.verify(DATA_DIR);
  const trial = enhancements.isTrialMode(license);
  return {
    success: true,
    trial,
    config: enhancements.getTrialConfig(),
    license
  };
});

// Track analytics events from the renderer
ipcMain.handle('enhance-track-clip-render', (_event, payload = {}) => {
  try {
    enhancements.trackEvent(DATA_DIR, {
      type: 'clip-render',
      count: clampInt(payload.count, 1, 100, 1),
      url: payload.url
    });
  } catch (_) { /* analytics are best-effort */ }
  return { success: true };
});

ipcMain.handle('enhance-track-export', (_event, payload = {}) => {
  try {
    enhancements.trackEvent(DATA_DIR, {
      type: 'clip-export',
      count: clampInt(payload.count, 1, 100, 1),
      platform: payload.platform
    });
  } catch (_) { /* analytics are best-effort */ }
  return { success: true };
});
