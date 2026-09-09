const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pythonCommand } = require('./pythonRunner');

/**
 * Resolve a Python script path that may live inside app.asar.unpacked in a
 * packaged Electron build.
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
 * Re-assigns which image goes in which timeline slot based on actual
 * image CONTENT matching the narration text — not upload order.
 *
 * @param {string[]} imagePaths
 * @param {Array} segments - transcript segments (text + start/end)
 * @param {Array} schedule - time slots from image_scheduler.py
 * @returns {Promise<Array>} new schedule with content-matched image_index values
 */
function matchImagesToContent(imagePaths, segments, schedule) {
  return new Promise((resolve, reject) => {
    const scriptPath = resolveScriptPath('content_matcher.py');

    const config = { imagePaths, segments, schedule };
    const configPath = path.join(os.tmpdir(), `content_match_${Date.now()}.json`);
    fs.writeFileSync(configPath, JSON.stringify(config));

    const proc = spawn(pythonCommand(), [scriptPath, configPath]);

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('error', (err) => {
      fs.unlink(configPath, () => {});
      reject(new Error(`Failed to start content_matcher.py: ${err.message}`));
    });

    proc.on('close', (code) => {
      fs.unlink(configPath, () => {});

      if (code !== 0 && !stdout) {
        reject(new Error(`Content matching failed: ${stderr || 'unknown error'}`));
        return;
      }

      try {
        const result = JSON.parse(stdout.trim());
        if (result.error) {
          reject(new Error(result.error));
        } else {
          resolve(result.schedule);
        }
      } catch (e) {
        reject(new Error(`Could not parse content matcher output: ${stdout}`));
      }
    });
  });
}

module.exports = { matchImagesToContent };