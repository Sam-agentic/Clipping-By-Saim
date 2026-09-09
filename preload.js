/**
 * preload.js — the only bridge between the renderer and Node.
 *
 * contextIsolation stays on and nodeIntegration stays off, so the renderer gets
 * this explicit allow-list and nothing else. Each method is a thin wrapper over
 * one ipcMain.handle channel in main.js.
 */

const { contextBridge, ipcRenderer } = require('electron');
const { pathToFileURL } = require('url');

const PROGRESS_CHANNEL = 'generation-progress';

contextBridge.exposeInMainWorld('api', {
  // pickers
  selectAudioFile: () => ipcRenderer.invoke('select-audio-file'),
  selectImageFiles: () => ipcRenderer.invoke('select-image-files'),
  selectMusicFile: () => ipcRenderer.invoke('select-music-file'),
  selectVideoFile: () => ipcRenderer.invoke('select-video-file'),
  createShortClips: (payload) => ipcRenderer.invoke('create-short-clips', payload),
  selectFontFile: () => ipcRenderer.invoke('select-font-file'),
  selectExportFolder: () => ipcRenderer.invoke('select-export-folder'),
  fileUrl: (filePath) => filePath ? pathToFileURL(filePath).href : null,
  downloadPresetPack: (packName) => ipcRenderer.invoke('download-preset-pack', packName),

  // Clipping by Saim: link -> highlights -> clips -> export (project auto-deletes)
  clipAnalyze: (payload) => ipcRenderer.invoke('clip-analyze', payload),
  clipRender: (payload) => ipcRenderer.invoke('clip-render', payload),
  clipExport: (payload) => ipcRenderer.invoke('clip-export', payload),
  clipDiscard: (payload) => ipcRenderer.invoke('clip-discard', payload),
  clipStatus: () => ipcRenderer.invoke('clip-status'),

  // in-app updates
  checkForUpdates: () => ipcRenderer.invoke('app-check-updates'),
  downloadUpdate: () => ipcRenderer.invoke('app-download-update'),
  installUpdate: () => ipcRenderer.invoke('app-install-update'),
  onUpdate: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('app-update', listener);
    return () => ipcRenderer.removeListener('app-update', listener);
  },

  // generation
  generateVideo: (payload) => ipcRenderer.invoke('generate-video', payload),
  cancelGenerate: () => ipcRenderer.invoke('cancel-generate'),

  /**
   * Subscribe to progress. Returns an unsubscribe function — without it every
   * hot reload would stack another listener and the same update would be
   * applied several times.
   */
  onProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(PROGRESS_CHANNEL, listener);
    return () => ipcRenderer.removeListener(PROGRESS_CHANNEL, listener);
  },

  // output + library
  exportVideo: (sourcePath) => ipcRenderer.invoke('export-video', sourcePath),
  saveProject: (project) => ipcRenderer.invoke('save-project', project),
  loadProject: () => ipcRenderer.invoke('load-project'),
  revealFile: (filePath) => ipcRenderer.invoke('reveal-file', filePath),
  openFile: (filePath) => ipcRenderer.invoke('open-file', filePath),
  listProjects: (limit) => ipcRenderer.invoke('list-projects', limit),
  deleteProject: (id, alsoDeleteFile) => ipcRenderer.invoke('delete-project', id, alsoDeleteFile),

  // diagnostics
  getSystemInfo: () => ipcRenderer.invoke('get-system-info'),
  cacheStats: () => ipcRenderer.invoke('cache-stats'),
  clearCache: () => ipcRenderer.invoke('clear-cache'),
  // licensing (the encrypted session and device hash remain in the main process)
  licenseStatus: () => ipcRenderer.invoke('license-status'),
  licenseRequestAccess: (email) => ipcRenderer.invoke('license-request-access', email),
  licenseSignIn: (payload) => ipcRenderer.invoke('license-sign-in', payload),
  licenseApproveCustomer: (payload) => ipcRenderer.invoke('license-approve-customer', payload),
  licenseListRequests: () => ipcRenderer.invoke('license-list-requests'),
  licenseRevokeCustomer: (payload) => ipcRenderer.invoke('license-revoke-customer', payload),
  licenseListCustomers: () => ipcRenderer.invoke('license-list-customers'),
  licenseSignOut: () => ipcRenderer.invoke('license-sign-out'),

  // enhancements (v1.2) — growth features
  enhanceGenerateHooks: (payload) => ipcRenderer.invoke('enhance-generate-hooks', payload),
  enhanceLanguages: () => ipcRenderer.invoke('enhance-languages'),
  enhanceTranslateCta: (payload) => ipcRenderer.invoke('enhance-translate-cta', payload),
  enhanceBatchAdd: (payload) => ipcRenderer.invoke('enhance-batch-add', payload),
  enhanceBatchRemove: (id) => ipcRenderer.invoke('enhance-batch-remove', id),
  enhanceBatchClear: () => ipcRenderer.invoke('enhance-batch-clear'),
  enhanceBatchState: () => ipcRenderer.invoke('enhance-batch-state'),
  enhanceBatchRun: () => ipcRenderer.invoke('enhance-batch-run'),
  enhanceAnalytics: (payload) => ipcRenderer.invoke('enhance-analytics', payload),
  enhanceTrackEvent: (payload) => ipcRenderer.invoke('enhance-track-event', payload),
  enhancePlatforms: () => ipcRenderer.invoke('enhance-platforms'),
  enhancePlatformPreset: (key) => ipcRenderer.invoke('enhance-platform-preset', key),
  enhanceTrialStatus: () => ipcRenderer.invoke('enhance-trial-status'),
  enhanceTrackClipRender: (payload) => ipcRenderer.invoke('enhance-track-clip-render', payload),
  enhanceTrackExport: (payload) => ipcRenderer.invoke('enhance-track-export', payload)
});
