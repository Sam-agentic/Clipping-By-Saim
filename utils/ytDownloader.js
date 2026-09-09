/**
 * ytDownloader.js — the "paste a YouTube link" half of Clipping by Saim.
 *
 * Design notes
 * ------------
 * yt-dlp is not an npm package, so it is resolved at runtime in this order:
 *   1. process.env.YTDLP_PATH        (explicit override, wins over everything)
 *   2. <dataDir>/bin/yt-dlp.exe      (what this module installs on Windows)
 *   3. yt-dlp on PATH
 *   4. python -m yt_dlp              (works if the user did `pip install yt-dlp`)
 *
 * Progress: yt-dlp is asked for a machine-readable --progress-template instead
 * of scraping its human output, with a plain "[download] 12.3%" regex kept as a
 * fallback for older builds. Every long call takes a JobToken so Cancel really
 * kills the download (and, on Windows, its fragment children).
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { pythonCommand } = require('./pythonRunner');

const YTDLP_RELEASE_URL =
  'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';

const PROGRESS_TAG = '@@YT|';
const PROGRESS_TEMPLATE =
  `download:${PROGRESS_TAG}%(progress.downloaded_bytes)s|%(progress.total_bytes)s` +
  '|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s';
const PERCENT_RE = /\[download\]\s+(\d{1,3}(?:\.\d+)?)%/;
const MAX_LOG_CHARS = 6000;
const VIDEO_EXTS = ['mp4', 'mkv', 'webm', 'mov', 'm4v'];

/** Refuse to download a video bigger than 1 GB — anything larger is a mistake. */
const MAX_VIDEO_BYTES = 1024 * 1024 * 1024;

function cancelledError() {
  const err = new Error('Cancelled by user');
  err.cancelled = true;
  return err;
}

function isWin() {
  return process.platform === 'win32';
}

/** Cheap sanity check so we never hand a search term to yt-dlp by accident. */
function looksLikeUrl(value) {
  return typeof value === 'string' && /^https?:\/\/[^\s]+$/i.test(value.trim());
}

function localBinaryPath(binDir) {
  return path.join(binDir, isWin() ? 'yt-dlp.exe' : 'yt-dlp');
}

/** Every place yt-dlp might live, in priority order. */
function candidateTools(binDir) {
  const list = [];
  if (process.env.YTDLP_PATH) {
    list.push({ command: process.env.YTDLP_PATH, args: [], source: 'YTDLP_PATH' });
  }
  if (binDir) {
    list.push({ command: localBinaryPath(binDir), args: [], source: 'app bin', mustExist: true });
  }
  list.push({ command: isWin() ? 'yt-dlp.exe' : 'yt-dlp', args: [], source: 'PATH' });
  list.push({ command: pythonCommand(), args: ['-m', 'yt_dlp'], source: 'python -m yt_dlp' });
  return list;
}

/**
 * Spawn yt-dlp and stream its output line by line.
 * Resolves with { code, stdout, log } — it never rejects on a non-zero exit,
 * because callers want the stderr tail to build a useful message.
 */
function runTool(tool, args, opts = {}) {
  const { onLine, token, timeoutMs } = opts;

  return new Promise((resolve, reject) => {
    if (token && token.cancelled) return reject(cancelledError());

    let child;
    try {
      child = spawn(tool.command, [...tool.args, ...args], {
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
      });
    } catch (err) {
      return reject(new Error(`Could not start yt-dlp (${tool.command}): ${err.message}`));
    }

    if (token) token.register(child);

    let stdout = '';
    let log = '';
    let pending = '';
    let timer = null;

    const pushLog = (line) => {
      log += line + '\n';
      if (log.length > MAX_LOG_CHARS) log = log.slice(-MAX_LOG_CHARS);
    };

    const consume = (chunk) => {
      pending += chunk.toString();
      const lines = pending.split(/\r?\n|\r/);
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        if (onLine) onLine(line);
        pushLog(line);
      }
    };

    child.stdout.on('data', (d) => { stdout += d.toString(); consume(d); });
    child.stderr.on('data', consume);

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(new Error(`Could not start yt-dlp (${tool.command}): ${err.message}`));
    });

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (pending.trim()) { if (onLine) onLine(pending); pushLog(pending); }
      if (token && token.cancelled) return reject(cancelledError());
      resolve({ code, stdout, log: log.trim() });
    });

    if (timeoutMs) {
      timer = setTimeout(() => {
        try { child.kill(); } catch (_) { /* already gone */ }
      }, timeoutMs);
    }
  });
}

/** `yt-dlp --version` succeeded? Used to pick between the candidates above. */
async function toolWorks(tool, token) {
  try {
    const { code, stdout, log } = await runTool(tool, ['--version'], { timeoutMs: 20000, token });
    if (code !== 0) return null;
    const version = (stdout || log).trim().split(/\r?\n/).pop() || 'unknown';
    return version;
  } catch (err) {
    // A failed probe just means "try the next candidate" — a cancel does not.
    if (err && err.cancelled) throw err;
    return null;
  }
}

/** Stream a URL to disk, following redirects (GitHub release assets need this). */
function downloadBinary(url, destPath, onProgress, hops = 0, token = null) {
  return new Promise((resolve, reject) => {
    if (hops > 5) return reject(new Error('Too many redirects while fetching yt-dlp'));
    if (token && token.cancelled) return reject(cancelledError());

    const request = https.get(url, { headers: { 'User-Agent': 'ClippingBySaim' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return downloadBinary(res.headers.location, destPath, onProgress, hops + 1, token)
          .then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`yt-dlp download failed with HTTP ${res.statusCode}`));
      }

      const total = Number(res.headers['content-length']) || 0;
      let received = 0;
      const tmpPath = `${destPath}.part`;
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      const file = fs.createWriteStream(tmpPath);

      res.on('data', (chunk) => {
        if (token && token.cancelled) {
          res.destroy();
          file.destroy();
          try { fs.unlinkSync(tmpPath); } catch (_) { /* nothing to clean */ }
          return reject(cancelledError());
        }
        received += chunk.length;
        if (onProgress && total) onProgress(Math.min(100, (received / total) * 100));
      });
      res.pipe(file);

      file.on('finish', () => {
        file.close(() => {
          try {
            fs.renameSync(tmpPath, destPath);
            if (!isWin()) fs.chmodSync(destPath, 0o755);
            resolve(destPath);
          } catch (err) {
            reject(err);
          }
        });
      });
      file.on('error', (err) => {
        try { fs.unlinkSync(tmpPath); } catch (_) { /* best effort */ }
        reject(err);
      });
    }).on('error', (err) => reject(new Error(`yt-dlp download failed: ${err.message}`)));

    // No token.register here: JobToken expects a real child process. The
    // per-chunk check above is enough — bytes keep arriving, so a Cancel is
    // noticed within one chunk and the request is destroyed there.
    void request;
  });
}

/**
 * Find a working yt-dlp, installing it into <dataDir>/bin on Windows if none of
 * the candidates answer --version. Returns { command, args, version, source }.
 */
async function ensureYtDlp(opts = {}) {
  const { binDir, onStatus, allowInstall = true, token = null } = opts;

  for (const tool of candidateTools(binDir)) {
    if (token && token.cancelled) throw cancelledError();
    if (tool.mustExist && !fs.existsSync(tool.command)) continue;
    const version = await toolWorks(tool, token);
    if (version) return { ...tool, version };
  }

  if (!allowInstall || !binDir) {
    throw new Error(installHint());
  }
  if (!isWin()) {
    throw new Error(installHint());
  }

  const target = localBinaryPath(binDir);
  if (onStatus) onStatus('Downloading yt-dlp (one time, ~17 MB)…');
  await downloadBinary(YTDLP_RELEASE_URL, target, (percent) => {
    if (onStatus) onStatus(`yt-dlp download: ${percent.toFixed(0)}%`);
  }, 0, token);

  const tool = { command: target, args: [], source: 'app bin' };
  const version = await toolWorks(tool, token);
  if (!version) {
    throw new Error(
      `yt-dlp was downloaded to ${target} but would not run. ` +
      'An antivirus may have blocked it. ' + installHint()
    );
  }
  return { ...tool, version };
}

function installHint() {
  return (
    'yt-dlp was not found. Three options: (1) turn the internet on and try again, ' +
    'the app installs it by itself; (2) run `pip install -U yt-dlp` in a command ' +
    'prompt; (3) download yt-dlp.exe manually and put it in the app\'s data\\bin ' +
    'folder, or set the YTDLP_PATH environment variable.'
  );
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Format ladder. Height is capped because this app targets a 2-core / 4 GB
 * laptop: a 1080p60 source costs far more to decode per clip than it gains,
 * and vertical clips are cropped to 1080x1920 at most anyway.
 */
function formatSelector(maxHeight) {
  const h = Math.max(240, Math.min(1080, num(maxHeight) || 720));
  return [
    `bestvideo[height<=${h}][ext=mp4]+bestaudio[ext=m4a]`,
    `bestvideo[height<=${h}]+bestaudio`,
    `best[height<=${h}][ext=mp4]`,
    `best[height<=${h}]`,
    'best'
  ].join('/');
}

function commonArgs() {
  const args = [
    '--no-playlist',
    '--no-warnings',
    '--ignore-config',
    '--socket-timeout', '20',
    '--retries', '5'
  ];
  const browser = process.env.YTDLP_COOKIES_BROWSER;
  if (browser) args.push('--cookies-from-browser', browser);
  return args;
}

/** Metadata only — no download. Used to show title/length before committing. */
async function probeVideo(url, opts = {}) {
  if (!looksLikeUrl(url)) throw new Error('That does not look like a valid link. Paste the full YouTube URL.');
  const tool = opts.tool || await ensureYtDlp(opts);

  const { code, stdout, log } = await runTool(
    tool,
    [...commonArgs(), '--dump-single-json', '--no-progress', url.trim()],
    { token: opts.token, timeoutMs: 90000 }
  );

  if (code !== 0 || !stdout.trim()) {
    throw new Error(`Could not read the video details.\n${log || `yt-dlp exit code ${code}`}`);
  }

  let info;
  try {
    info = JSON.parse(stdout.trim());
  } catch (_) {
    throw new Error('The details yt-dlp returned could not be read.');
  }

  return {
    id: info.id || '',
    title: info.title || 'Untitled video',
    duration: num(info.duration),
    uploader: info.uploader || info.channel || '',
    thumbnail: info.thumbnail || '',
    webpageUrl: info.webpage_url || url.trim(),
    isLive: Boolean(info.is_live)
  };
}

/** Pick the finished file out of the download folder. */
function findDownloaded(destDir) {
  let names;
  try {
    names = fs.readdirSync(destDir);
  } catch (_) {
    return null;
  }

  const usable = names.filter((name) =>
    name.toLowerCase().startsWith('source.') &&
    !/\.(part|ytdl|temp|tmp)$/i.test(name) &&
    !/\.f\d+\./i.test(name)          // leftover per-stream fragments
  );
  if (!usable.length) return null;

  for (const ext of VIDEO_EXTS) {
    const exact = usable.find((name) => name.toLowerCase() === `source.${ext}`);
    if (exact) return path.join(destDir, exact);
  }

  const bySize = usable
    .map((name) => {
      const full = path.join(destDir, name);
      let size = 0;
      try { size = fs.statSync(full).size; } catch (_) { /* ignore */ }
      return { full, size };
    })
    .sort((a, b) => b.size - a.size);
  return bySize.length ? bySize[0].full : null;
}

/**
 * Download one video into destDir as source.mp4 (or whatever container yt-dlp
 * ends up with) and report progress as a single monotonically rising percent.
 *
 * Because bestvideo+bestaudio means two sequential downloads, file 1 is mapped
 * to 0-92% and the (much smaller) audio file to 92-99%, so the bar never goes
 * backwards and never stalls visibly on a single-file progressive download.
 */
async function downloadVideo(url, opts = {}) {
  if (!looksLikeUrl(url)) throw new Error('That does not look like a valid link. Paste the full YouTube URL.');

  const { destDir, onProgress, onLog, token, maxHeight = 720, ffmpegPath } = opts;
  if (!destDir) throw new Error('downloadVideo needs a destDir');
  const tool = opts.tool || await ensureYtDlp(opts);

  fs.mkdirSync(destDir, { recursive: true });

  const args = [
    ...commonArgs(),
    '--newline',
    '--fragment-retries', '5',
    '--concurrent-fragments', '4',
    '--progress-template', PROGRESS_TEMPLATE,
    '-f', formatSelector(maxHeight),
    '--merge-output-format', 'mp4',
    '-o', path.join(destDir, 'source.%(ext)s')
  ];
  if (ffmpegPath) args.push('--ffmpeg-location', ffmpegPath);
  args.push(url.trim());

  let fileIndex = 0;
  let lastPercent = 0;
  let merging = false;

  const emit = (rawPercent, extra) => {
    const band = fileIndex >= 2 ? [92, 99] : [0, 92];
    const scaled = band[0] + (Math.max(0, Math.min(100, rawPercent)) / 100) * (band[1] - band[0]);
    const percent = Math.max(lastPercent, merging ? 99.5 : scaled);
    lastPercent = percent;
    if (onProgress) onProgress({ percent, ...extra });
  };

  const handleLine = (line) => {
    if (/\[download\]\s+Destination:/i.test(line)) {
      fileIndex += 1;
      return;
    }
    if (/^\[Merger\]/i.test(line) || /\[ExtractAudio\]/i.test(line)) {
      merging = true;
      emit(100, { message: 'Joining the audio and video…' });
      return;
    }

    const tagAt = line.indexOf(PROGRESS_TAG);
    if (tagAt >= 0) {
      const [downloaded, total, estimate, speed, eta] =
        line.slice(tagAt + PROGRESS_TAG.length).split('|');
      const size = num(total) || num(estimate);
      const got = num(downloaded);
      if (size > MAX_VIDEO_BYTES) {
        throw new Error(
          `This video is ${(size / 1024 ** 3).toFixed(1)} GB — bigger than the ` +
          '1 GB limit. Pick a shorter video or a lower quality.'
        );
      }
      if (size > 0) {
        emit((got / size) * 100, {
          message: 'Downloading the video…',
          speed: num(speed),
          eta: num(eta),
          downloadedBytes: got,
          totalBytes: size
        });
      }
      return;
    }

    const match = PERCENT_RE.exec(line);
    if (match) {
      emit(Number(match[1]), { message: 'Downloading the video…' });
      return;
    }
    if (onLog && !line.startsWith('[download]')) onLog(line);
  };

  const { code, log } = await runTool(tool, args, { onLine: handleLine, token });

  const filePath = findDownloaded(destDir);
  if (code !== 0 || !filePath) {
    throw new Error(friendlyDownloadError(code, log));
  }

  let sizeBytes = 0;
  try { sizeBytes = fs.statSync(filePath).size; } catch (_) { /* ignore */ }

  if (onProgress) onProgress({ percent: 100, message: 'Download complete' });
  return { path: filePath, name: path.basename(filePath), sizeBytes };
}

/**
 * yt-dlp's own errors are long and technical. Translate the three failures that
 * actually happen in practice, and fall back to the raw tail otherwise.
 */
function friendlyDownloadError(code, log) {
  const text = log || '';
  if (/confirm your age|age-restricted|Sign in to confirm your age/i.test(text)) {
    return 'This video is age-restricted, so yt-dlp cannot download it without a login. ' +
      'Try a different link.';
  }
  if (/Sign in to confirm you.?re not a bot|cookies/i.test(text)) {
    return 'YouTube asked for a bot check. Fix: set the environment variable ' +
      'YTDLP_COOKIES_BROWSER=chrome (or edge/firefox) and reopen the app.';
  }
  if (/Private video|unavailable|removed|not available in your country/i.test(text)) {
    return 'This video is private, unavailable, or blocked in your region.';
  }
  if (/HTTP Error 429|Too Many Requests/i.test(text)) {
    return 'YouTube rate-limited the download (429). Try again in a few minutes.';
  }
  if (/getaddrinfo|Temporary failure in name resolution|Network is unreachable|Unable to download webpage/i.test(text)) {
    return 'This looks like an internet connection problem. Check the connection and try again.';
  }
  const tail = text.split(/\r?\n/).filter(Boolean).slice(-4).join('\n');
  return `Download failed (exit code ${code}).${tail ? `\n${tail}` : ''}`;
}

module.exports = {
  ensureYtDlp,
  probeVideo,
  downloadVideo,
  looksLikeUrl,
  localBinaryPath,
  YTDLP_RELEASE_URL
};
