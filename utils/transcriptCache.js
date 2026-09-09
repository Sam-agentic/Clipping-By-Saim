/**
 * transcriptCache.js — persistent cache for Whisper output.
 *
 * Transcription is by far the slowest step in this app, and it is completely
 * deterministic for a given (audio file, model) pair. Before this cache,
 * changing the caption font size or swapping one image meant re-transcribing
 * the whole voiceover from scratch. Now the second render of the same audio
 * skips straight to the render step.
 *
 * The cache key is sha256(file bytes) + model size, so it stays correct if the
 * file is renamed, moved, or edited in place — mtime/size alone would not.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CACHE_DIR = path.join(
  process.env.VIDEO_EDITOR_DATA_DIR || path.join(__dirname, '..'),
  'cache', 'transcripts'
);
const CACHE_VERSION = 2; // bump when the stored shape changes
const MAX_ENTRIES = 40;

function ensureDir() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

/** sha256 of the file, streamed so a large MP3 is never held in memory. */
function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * The key is used as a filename, so anything folded into it has to be stripped
 * down to safe characters first. `variant` carries things that change what
 * Whisper returns without changing the audio — the spoken language and whether
 * the output was translated into English.
 */
function safeVariant(variant) {
  const text = String(variant || '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return text.replace(/^-+|-+$/g, '').slice(0, 24);
}

async function cacheKey(audioPath, modelSize, variant = '') {
  const digest = await hashFile(audioPath);
  const tag = safeVariant(variant);
  return `${digest.slice(0, 32)}_${modelSize}${tag ? `_${tag}` : ''}_v${CACHE_VERSION}`;
}

function entryPath(key) {
  return path.join(CACHE_DIR, `${key}.json`);
}

/** @returns {Promise<object|null>} the cached analysis, or null on any miss. */
async function get(audioPath, modelSize, variant = '') {
  try {
    const file = entryPath(await cacheKey(audioPath, modelSize, variant));
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    // A truncated or hand-edited cache file must degrade to a miss, never
    // propagate a half-transcript into the render.
    if (!parsed || typeof parsed.duration !== 'number' || !Array.isArray(parsed.segments)) {
      return null;
    }
    fs.utimesSync(file, new Date(), new Date()); // mark as recently used
    return parsed;
  } catch (_) {
    return null;
  }
}

async function set(audioPath, modelSize, analysis, variant = '') {
  try {
    ensureDir();
    const key = await cacheKey(audioPath, modelSize, variant);
    fs.writeFileSync(entryPath(key), JSON.stringify(analysis), 'utf-8');
    prune();
  } catch (_) {
    /* caching is an optimisation — never fail a render because of it */
  }
}

/** Keep the cache from growing without bound; drop least-recently-used. */
function prune() {
  try {
    const files = fs.readdirSync(CACHE_DIR)
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        const full = path.join(CACHE_DIR, name);
        return { full, mtime: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);

    for (const stale of files.slice(MAX_ENTRIES)) {
      try { fs.unlinkSync(stale.full); } catch (_) { /* ignore */ }
    }
  } catch (_) { /* ignore */ }
}

function stats() {
  try {
    const files = fs.readdirSync(CACHE_DIR).filter((n) => n.endsWith('.json'));
    const bytes = files.reduce((sum, n) => sum + fs.statSync(path.join(CACHE_DIR, n)).size, 0);
    return { entries: files.length, bytes };
  } catch (_) {
    return { entries: 0, bytes: 0 };
  }
}

function clear() {
  try {
    for (const name of fs.readdirSync(CACHE_DIR)) {
      if (name.endsWith('.json')) fs.unlinkSync(path.join(CACHE_DIR, name));
    }
  } catch (_) { /* ignore */ }
}

module.exports = { get, set, stats, clear, hashFile, CACHE_DIR };
