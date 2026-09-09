/**
 * projectStore.js — persistent history of every generation.
 *
 * WHY NOT SQLITE (YET)
 * --------------------
 * The plan called for SQLite. better-sqlite3 is a native addon: it publishes
 * prebuilt binaries for Node, not for Electron's ABI, so installing it here
 * means a node-gyp compile plus @electron/rebuild, which needs Visual Studio
 * Build Tools (multi-GB) on a machine whose disk is already full. That is a
 * likely dead end for zero benefit at this data volume — a few hundred render
 * records.
 *
 * So this is a JSON-backed store behind a deliberately SQL-shaped API
 * (insert / list / get / remove). Swapping in better-sqlite3 later means
 * rewriting this one file and nothing else; no caller changes.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DB_DIR = path.join(process.env.VIDEO_EDITOR_DATA_DIR || path.join(__dirname, '..'), 'database');
const DB_FILE = path.join(DB_DIR, 'projects.json');
const SCHEMA_VERSION = 1;
const MAX_RECORDS = 200;

function emptyDb() {
  return { schemaVersion: SCHEMA_VERSION, projects: [] };
}

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
    if (!parsed || !Array.isArray(parsed.projects)) return emptyDb();
    return parsed;
  } catch (_) {
    return emptyDb();
  }
}

/**
 * Write via a temp file + rename. A direct overwrite that is interrupted
 * (and this app gets force-quit a lot mid-render) leaves a truncated file and
 * loses the entire history.
 */
function save(db) {
  fs.mkdirSync(DB_DIR, { recursive: true });
  const tmp = `${DB_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf-8');
  fs.renameSync(tmp, DB_FILE);
}

/** Record one generation. Returns the stored row. */
function insert(record) {
  const db = load();
  const row = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    ...record
  };
  db.projects.unshift(row);
  if (db.projects.length > MAX_RECORDS) db.projects.length = MAX_RECORDS;
  save(db);
  return row;
}

function update(id, patch) {
  const db = load();
  const row = db.projects.find((p) => p.id === id);
  if (!row) return null;
  Object.assign(row, patch, { updatedAt: new Date().toISOString() });
  save(db);
  return row;
}

/** Most recent first. Rows whose output file is gone are flagged, not hidden. */
function list(limit = 25) {
  return load().projects.slice(0, limit).map((row) => ({
    ...row,
    fileExists: Boolean(row.outputPath && fs.existsSync(row.outputPath))
  }));
}

function get(id) {
  return load().projects.find((p) => p.id === id) || null;
}

function remove(id) {
  const db = load();
  const before = db.projects.length;
  db.projects = db.projects.filter((p) => p.id !== id);
  if (db.projects.length === before) return false;
  save(db);
  return true;
}

function stats() {
  const projects = load().projects;
  const completed = projects.filter((p) => p.status === 'completed');
  return {
    total: projects.length,
    completed: completed.length,
    failed: projects.filter((p) => p.status === 'failed').length,
    cancelled: projects.filter((p) => p.status === 'cancelled').length,
    totalSeconds: Math.round(completed.reduce((sum, p) => sum + (p.durationSeconds || 0), 0))
  };
}

module.exports = { insert, update, list, get, remove, stats, DB_FILE };
