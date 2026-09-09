/**
 * imageMatcher.js — decides WHICH image goes in which time slot.
 *
 * Replaces the two near-identical modules that existed before
 * (utils/filenameMatcher.js and utils/contentmatcher.js), which duplicated the
 * same spawn-python-with-a-temp-config logic and could not report progress or
 * be cancelled.
 *
 * Three modes, all sharing one config shape ({ imagePaths, segments, schedule }
 * in, { schedule } out):
 *
 *   'filename' (default) — python/filename_matcher.py. Embeds each image's
 *       FILENAME with sentence-transformers all-MiniLM-L6-v2 (~80MB) and
 *       Hungarian-matches it against the narration for each slot. For
 *       AI-generated images, whose filenames are usually the prompt, this is
 *       both faster and more accurate than looking at pixels.
 *
 *   'content' — python/content_matcher.py. CLIP (clip-ViT-B-32)
 *       actually looks at the pixels and matches them to the narration.
 *       It pulls in torch and decodes every image, so on a ~4GB machine expect
 *       it to be slow and memory-hungry; that is why it is not the default.
 *
 *   'order' — no model at all, keep upload order. Instant, and the right
 *       choice when the images are already in narrative sequence.
 *
 * Matching is always best-effort: if the model is missing or the process dies,
 * the caller keeps the unmatched schedule rather than losing the whole render.
 */

const { runPython, writeTempConfig } = require('./pythonRunner');

const MATCH_START = 62;
const MATCH_END = 65;

const SCRIPTS = {
  filename: 'filename_matcher.py',
  content: 'content_matcher.py'
};

/**
 * @param {object} params
 * @param {string[]} params.imagePaths
 * @param {Array}  params.segments
 * @param {Array}  params.schedule
 * @param {'filename'|'content'|'order'} [params.mode='filename']
 * @param {(p:object)=>void} [params.onProgress]
 * @param {import('./pythonRunner').JobToken} [params.token]
 * @returns {Promise<{schedule: Array, mode: string, warning?: string}>}
 */
async function matchImages(params) {
  const {
    imagePaths, segments = [], schedule,
    mode = 'filename', onProgress, token
  } = params;

  const report = (message, percent) => {
    if (onProgress) onProgress({ stage: 'match', percent, message });
  };

  if (mode === 'order' || imagePaths.length < 2 || !segments.length) {
    const reason = mode === 'order'
      ? 'Keeping upload order'
      : 'Not enough data to match — keeping upload order';
    report(reason, MATCH_END);
    return { schedule, mode: 'order' };
  }

  const script = SCRIPTS[mode];
  if (!script) return { schedule, mode: 'order', warning: `Unknown match mode "${mode}"` };

  report(
    mode === 'content'
      ? 'Analyzing every image from pixels and matching scene descriptions'
      : 'Matching image names to the narration',
    MATCH_START
  );

  const { configPath, cleanup } = writeTempConfig('image_match', {
    imagePaths, segments, schedule
  });

  try {
    const result = await runPython(script, [configPath], {
      token,
      onProgress: onProgress
        ? (payload) => onProgress({ ...payload, stage: 'match', percent: MATCH_START + 1 })
        : undefined
    });

    const matched = Array.isArray(result.schedule) ? result.schedule : null;
    if (!matched || matched.length !== schedule.length) {
      return {
        schedule,
        mode: 'order',
        warning: 'Matcher returned an unusable timeline — kept upload order'
      };
    }

    report(`Images matched (${mode})`, MATCH_END);
    return { schedule: matched, mode };
  } catch (err) {
    if (err && err.cancelled) throw err; // a cancel must not be swallowed
    report('Matching skipped — keeping upload order', MATCH_END);
    return { schedule, mode: 'order', warning: `Image matching failed: ${err.message}` };
  } finally {
    cleanup();
  }
}

module.exports = { matchImages };
