const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const ffprobeStatic = require('ffprobe-static');
const path = require('path');
const fs = require('fs');
const { analyzeVideo } = require('./autoAnalyze');

/**
 * ffmpeg-static exports a plain string path, while ffprobe-static exports
 * { path: string }. Both live inside app.asar.unpacked when the app is
 * packaged, so the asar-unpacked rewrite must be applied before handing
 * either path to fluent-ffmpeg.
 */
function resolveAsarPath(p) {
  if (!p) return p;
  return p.replace(
    `${path.sep}app.asar${path.sep}`,
    `${path.sep}app.asar.unpacked${path.sep}`
  );
}

const resolvedFfmpeg = resolveAsarPath(ffmpegStatic);
const resolvedFfprobe = resolveAsarPath(ffprobeStatic.path);

ffmpeg.setFfmpegPath(fs.existsSync(resolvedFfmpeg) ? resolvedFfmpeg : ffmpegStatic);
ffmpeg.setFfprobePath(fs.existsSync(resolvedFfprobe) ? resolvedFfprobe : ffprobeStatic.path);

class VideoProcessor {
  constructor() {
    this.isProcessing = false;
  }

  trimVideo(inputPath, outputPath, startTime, endTime, adjustments = {}) {
    return new Promise((resolve, reject) => {
      if (this.isProcessing) {
        reject(new Error('Another operation is in progress'));
        return;
      }

      this.isProcessing = true;
      const duration = endTime - startTime;

      let command = ffmpeg(inputPath)
        .setStartTime(startTime)
        .setDuration(duration)
        .videoCodec('libx264')
        .audioCodec('aac')
        .format('mp4')
        .output(outputPath);

      if (adjustments && (adjustments.brightness !== 100 ||
          adjustments.contrast !== 100 ||
          adjustments.saturation !== 100)) {
        const filterComplex = this.buildFilterComplex(adjustments);
        command = command.videoFilter(filterComplex);
      }

      command
        .on('progress', (progress) => {
          console.log('Trim progress: ' + progress.percent + '%');
        })
        .on('end', () => {
          this.isProcessing = false;
          resolve({ success: true, message: 'Video trimmed successfully' });
        })
        .on('error', (err) => {
          this.isProcessing = false;
          reject(err);
        })
        .run();
    });
  }

  exportVideo(inputPath, outputPath, startTime, endTime, adjustments = {}) {
    return new Promise((resolve, reject) => {
      if (this.isProcessing) {
        reject(new Error('Another operation is in progress'));
        return;
      }

      this.isProcessing = true;
      const duration = endTime - startTime;

      let command = ffmpeg(inputPath)
        .setStartTime(startTime)
        .setDuration(duration)
        .videoCodec('libx264')
        .audioCodec('aac')
        .videoBitrate('5000k')
        .audioBitrate('192k')
        .format('mp4')
        .output(outputPath);

      if (adjustments && (adjustments.brightness !== 100 ||
          adjustments.contrast !== 100 ||
          adjustments.saturation !== 100)) {
        const filterComplex = this.buildFilterComplex(adjustments);
        command = command.videoFilter(filterComplex);
      }

      command
        .on('progress', (progress) => {
          console.log('Export progress: ' + progress.percent + '%');
        })
        .on('end', () => {
          this.isProcessing = false;
          resolve({
            success: true,
            message: 'Video exported successfully',
            path: outputPath
          });
        })
        .on('error', (err) => {
          this.isProcessing = false;
          reject(err);
        })
        .run();
    });
  }

  getMetadata(videoPath) {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(videoPath, (err, metadata) => {
        if (err) {
          reject(err);
        } else {
          const duration = metadata.format.duration;
          const videoStream = metadata.streams.find(s => s.codec_type === 'video');

          resolve({
            duration: duration,
            width: videoStream?.width,
            height: videoStream?.height,
            fps: this.calculateFPS(videoStream?.r_frame_rate),
            bitrate: metadata.format.bit_rate,
            size: metadata.format.size
          });
        }
      });
    });
  }

  buildFilterComplex(adjustments) {
    const brightness = (adjustments.brightness / 100).toFixed(3);
    const contrast = (adjustments.contrast / 100).toFixed(3);
    const saturation = (adjustments.saturation / 100).toFixed(3);

    return `eq=brightness=${brightness - 1}:contrast=${contrast}:saturation=${saturation}`;
  }

  calculateFPS(rFrameRate) {
    if (!rFrameRate) return 30;

    const parts = rFrameRate.split('/');
    if (parts.length === 2) {
      return Math.round(parseInt(parts[0]) / parseInt(parts[1]));
    }
    return 30;
  }

  async autoAdjust(videoPath) {
    try {
      const result = await analyzeVideo(videoPath, 12);
      console.log(`Auto-adjust analyzed ${result.samples} frames:`, result);
      return {
        brightness: result.brightness,
        contrast: result.contrast,
        saturation: result.saturation
      };
    } catch (err) {
      console.warn('Auto-adjust analysis failed, using neutral defaults:', err.message);
      return {
        brightness: 100,
        contrast: 100,
        saturation: 100
      };
    }
  }

  mergeVideos(videoList, outputPath) {
    return new Promise((resolve, reject) => {
      if (this.isProcessing) {
        reject(new Error('Another operation is in progress'));
        return;
      }

      this.isProcessing = true;

      let command = ffmpeg();

      videoList.forEach(video => {
        command = command.input(video);
      });

      command
        .on('end', () => {
          this.isProcessing = false;
          resolve({ success: true, message: 'Videos merged successfully' });
        })
        .on('error', (err) => {
          this.isProcessing = false;
          reject(err);
        })
        .mergeToFile(outputPath);
    });
  }

  addWatermark(inputPath, outputPath, watermarkPath, position = 'bottom-right') {
    return new Promise((resolve, reject) => {
      if (this.isProcessing) {
        reject(new Error('Another operation is in progress'));
        return;
      }

      this.isProcessing = true;

      let overlayFilter = 'overlay=W-w-10:H-h-10';

      if (position === 'top-left') overlayFilter = 'overlay=10:10';
      else if (position === 'top-right') overlayFilter = 'overlay=W-w-10:10';
      else if (position === 'bottom-left') overlayFilter = 'overlay=10:H-h-10';

      ffmpeg(inputPath)
        .input(watermarkPath)
        .complexFilter(overlayFilter)
        .videoCodec('libx264')
        .audioCodec('aac')
        .format('mp4')
        .output(outputPath)
        .on('end', () => {
          this.isProcessing = false;
          resolve({ success: true, message: 'Watermark added successfully' });
        })
        .on('error', (err) => {
          this.isProcessing = false;
          reject(err);
        })
        .run();
    });
  }
}

module.exports = new VideoProcessor();