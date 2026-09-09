/**
 * pythonRunner.js — the single place where this app spawns Python.
 *
 * Previously timelineEngine.js, filenameMatcher.js and videoRenderer.js each
 * had their own near-identical copy of this spawn logic, and none of them
 * could report progress or be cancelled. That is why the app looked frozen:
 * stdout was buffered until the process exited, so nothing reached the UI
 * until the whole job was done (or never, if it was killed).
 *
 * Protocol between Node and Python
 * --------------------------------
 *   stdout : ONE JSON object, printed once at the end. This is the result.
 *   stderr : line-delimited diagnostics. Any line starting with the marker
 *            "@@PROGRESS " is parsed as JSON and forwarded to onProgress().
 *            Everything else is kept as the error log for failure messages.
 *
 * Keeping progress on stderr means stdout stays a clean JSON channel, so we
 * never have to guess which line was the result.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PROGRESS_MARKER = '@@PROGRESS ';
const PYTHON_DIR = path.join(__dirname, '..', 'python');

function filesystemPythonDir() {
  return PYTHON_DIR.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
}

/** How many stderr characters to keep for error messages. */
const MAX_LOG_CHARS = 8000;

/**
 * Resolve the Python executable. Honours PYTHON_PATH so a venv can be used
 * without editing code, then falls back to the platform default.
 */
function pythonCommand() {
  if (process.env.PYTHON_PATH) return process.env.PYTHON_PATH;
  return process.platform === 'win32' ? 'python' : 'python3';
}

/**
 * A cancellation token shared by every step of one generation run.
 * main.js creates one per "generate-video" request and calls abort() when the
 * user presses Cancel, which kills whichever Python child is currently alive.
 */
class JobToken {
  constructor() {
    this.cancelled = false;
    this._children = new Set();
  }

  register(child) {
    if (this.cancelled) {
      killTree(child);
      return;
    }
    this._children.add(child);
    child.once('close', () => this._children.delete(child));
  }

  abort() {
    if (this.cancelled) return;
    this.cancelled = true;
    for (const child of this._children) killTree(child);
    this._children.clear();
  }

  throwIfCancelled() {
    if (this.cancelled) {
      const err = new Error('Cancelled by user');
      err.cancelled = true;
      throw err;
    }
  }
}

/**
 * Kill a child process and, on Windows, its descendants. FFmpeg is spawned by
 * Python, so killing only the Python process would leave FFmpeg running and
 * still eating the CPU — which on a 4GB machine means the app stays unusable
 * after "Cancel".
 */
function killTree(child) {
  if (!child || child.killed || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/f', '/t'], {
        stdio: 'ignore',
        windowsHide: true
      });
    } else {
      child.kill('SIGKILL');
    }
  } catch (_) {
    try { child.kill('SIGKILL'); } catch (__) { /* already gone */ }
  }
}

/**
 * Run a script in python/ and resolve its JSON result.
 *
 * @param {string} scriptName            e.g. 'audio_analyzer.py'
 * @param {string[]} args                CLI args after the script path
 * @param {object} [opts]
 * @param {(p: object) => void} [opts.onProgress]  called per @@PROGRESS line
 * @param {JobToken} [opts.token]        cancellation token
 * @returns {Promise<object>}            parsed stdout JSON
 */
function runPython(scriptName, args, opts = {}) {
  const { onProgress, token } = opts;
  const scriptPath = path.join(filesystemPythonDir(), scriptName);

  return new Promise((resolve, reject) => {
    if (token && token.cancelled) {
      const err = new Error('Cancelled by user');
      err.cancelled = true;
      return reject(err);
    }

    if (!fs.existsSync(scriptPath)) {
      return reject(new Error(`Missing Python script: ${scriptPath}`));
    }

    let child;
    try {
      child = spawn(pythonCommand(), ['-u', scriptPath, ...args.map(String)], {
        windowsHide: true,
        // PYTHONIOENCODING keeps non-ASCII transcript text from crashing
        // print() on a Windows console using a legacy code page.
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' }
      });
    } catch (err) {
      return reject(new Error(`Could not start Python for ${scriptName}: ${err.message}`));
    }

    if (token) token.register(child);

    let stdout = '';
    let log = '';
    let stderrTail = '';

    child.stdout.on('data', (d) => { stdout += d.toString(); });

    child.stderr.on('data', (chunk) => {
      stderrTail += chunk.toString();
      const lines = stderrTail.split(/\r?\n/);
      stderrTail = lines.pop() ?? ''; // keep the incomplete trailing line

      for (const line of lines) {
        if (line.startsWith(PROGRESS_MARKER)) {
          if (!onProgress) continue;
          try {
            onProgress(JSON.parse(line.slice(PROGRESS_MARKER.length)));
          } catch (_) { /* a malformed progress line must never fail the job */ }
        } else if (line.trim()) {
          log += line + '\n';
          if (log.length > MAX_LOG_CHARS) log = log.slice(-MAX_LOG_CHARS);
        }
      }
    });

    child.on('error', (err) => {
      reject(new Error(
        `Could not start Python for ${scriptName}: ${err.message}. ` +
        `Check that Python is installed and on PATH, or set PYTHON_PATH.`
      ));
    });

    child.on('close', (code, signal) => {
      if (token && token.cancelled) {
        const err = new Error('Cancelled by user');
        err.cancelled = true;
        return reject(err);
      }

      const trimmed = stdout.trim();

      if (!trimmed) {
        return reject(new Error(
          `${scriptName} exited (code ${code}${signal ? `, signal ${signal}` : ''}) ` +
          `without producing a result.${log ? `\n${log.trim()}` : ''}`
        ));
      }

      let result;
      try {
        result = JSON.parse(trimmed);
      } catch (_) {
        return reject(new Error(
          `${scriptName} produced output that is not valid JSON:\n` +
          `${trimmed.slice(0, 1000)}${log ? `\n--- stderr ---\n${log.trim()}` : ''}`
        ));
      }

      if (result && result.error) {
        return reject(new Error(`${scriptName}: ${result.error}`));
      }
      resolve(result);
    });
  });
}

/**
 * Write an object to a temp JSON file and hand back the path plus a cleanup
 * function. Several scripts take their input as a config file because the
 * payloads (full transcripts, hundreds of image paths) are far too large to
 * pass as command-line arguments on Windows.
 */
function writeTempConfig(prefix, data) {
  const configPath = path.join(os.tmpdir(), `${prefix}_${Date.now()}_${process.pid}.json`);
  fs.writeFileSync(configPath, JSON.stringify(data), 'utf-8');
  return {
    configPath,
    cleanup: () => { try { fs.unlinkSync(configPath); } catch (_) { /* best effort */ } }
  };
}

module.exports = { runPython, writeTempConfig, JobToken, pythonCommand, PROGRESS_MARKER };
