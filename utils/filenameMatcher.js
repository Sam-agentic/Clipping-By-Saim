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
 * Matches images to timeline slots using each image's FILENAME
 * (assumed descriptive, e.g. AI-generation prompts) against the
 * narration text — much faster and more accurate than analyzing
 * pixel content for simple/illustration-style images.
 *
 * @param {string[]} imagePaths
 * @param {Array} segments
 * @param {Array} schedule
 * @returns {Promise<Array>} new schedule with matched image_index values
 */
function matchImagesByFilename(imagePaths, segments, schedule) {
  return new Promise((resolve, reject) => {
    const scriptPath = resolveScriptPath('filename_matcher.py');

    const config = { imagePaths, segments, schedule };
    const configPath = path.join(os.tmpdir(), `filename_match_${Date.now()}.json`);
    fs.writeFileSync(configPath, JSON.stringify(config));

    const proc = spawn(pythonCommand(), [scriptPath, configPath]);

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('error', (err) => {
      fs.unlink(configPath, () => {});
      reject(new Error(`Failed to start filename_matcher.py: ${err.message}`));
    });

    proc.on('close', (code) => {
      fs.unlink(configPath, () => {});

      if (code !== 0 && !stdout) {
        reject(new Error(`Filename matching failed: ${stderr || 'unknown error'}`));
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
        reject(new Error(`Could not parse filename matcher output: ${stdout}`));
      }
    });
  });
}

module.exports = { matchImagesByFilename };