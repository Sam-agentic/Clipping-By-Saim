const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { pythonCommand } = require('./pythonRunner');

/**
 * Resolve a Python script path that may live inside app.asar.unpacked in a
 * packaged Electron build — Python cannot execute from inside an asar archive.
 */
function resolveScriptPath(scriptName) {
  const packed = path.join(__dirname, '..', 'python', scriptName);
  const unpacked = packed.replace(
    `${path.sep}app.asar${path.sep}`,
    `${path.sep}app.asar.unpacked${path.sep}`
  );
  return fs.existsSync(unpacked) ? unpacked : packed;
}

/**
 * Runs python/analyze_video.py against a video file and resolves with
 * real, content-based brightness/contrast/saturation adjustments.
 *
 * Requires Python 3 + opencv-python + numpy installed:
 *   pip install opencv-python numpy
 *
 * @param {string} videoPath - absolute path to the source video
 * @param {number} numSamples - how many frames to sample (default 12)
 * @returns {Promise<{brightness:number, contrast:number, saturation:number, samples:number}>}
 */
function analyzeVideo(videoPath, numSamples = 12) {
  return new Promise((resolve, reject) => {
    const scriptPath = resolveScriptPath('analyze_video.py');
    const proc = spawn(pythonCommand(), [scriptPath, videoPath, String(numSamples)]);

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('error', (err) => {
      reject(new Error(`Failed to start Python process: ${err.message}`));
    });

    proc.on('close', (code) => {
      if (code !== 0 && !stdout) {
        reject(new Error(`Python analysis failed: ${stderr || 'unknown error'}`));
        return;
      }

      try {
        const result = JSON.parse(stdout.trim());
        if (result.error) {
          reject(new Error(result.error));
        } else {
          resolve(result);
        }
      } catch (e) {
        reject(new Error(`Could not parse analyzer output: ${stdout}`));
      }
    });
  });
}

module.exports = { analyzeVideo };