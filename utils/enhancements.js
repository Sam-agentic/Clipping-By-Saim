/**
 * enhancements.js — Growth features for Clipping by Saim
 *
 * 1. Auto-caption AI      — rule-based hook/CTA generator from transcript
 * 2. Multi-language       — caption translation presets
 * 3. Batch processing     — queue multiple YouTube links
 * 4. Analytics dashboard  — owner usage stats (local + Supabase)
 * 5. Auto-posting         — platform export presets (TikTok/Shorts/Reels)
 * 6. Trial/demo mode      — watermark + clip limit for unlicensed users
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ------------------------------------------------------------------ 1. Auto-caption AI */

/**
 * Generate viral hooks/CTAs from a transcript.
 * Rule-based (no external API needed) — picks the strongest opening line,
 * adds a curiosity gap, and appends a CTA.
 */
const HOOK_PATTERNS = [
  { re: /\b(but|however|yet)\b/i, label: 'contrast' },
  { re: /\b(secret|hidden|nobody tells you)\b/i, label: 'secret' },
  { re: /\b(never|always|every time)\b/i, label: 'absolutist' },
  { re: /\b(why|how|what if)\b/i, label: 'question' },
  { re: /\b(mistake|error|wrong|fail)\b/i, label: 'mistake' },
  { re: /\b(actually|really|truth)\b/i, label: 'truth' },
  { re: /\b(stop|start|try|learn|discover)\b/i, label: 'action' }
];

const CTA_TEMPLATES = [
  'Follow for more',
  'Save this for later',
  'Share with someone who needs this',
  'Comment your thoughts below',
  'Turn on notifications',
  'Watch till the end',
  'This changes everything — watch closely',
  'You won\'t believe what happens next'
];

function generateHooks(transcript, count = 3) {
  if (!transcript || typeof transcript !== 'string') return [];
  const sentences = transcript
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 15 && s.length < 160);

  const scored = sentences.map((sentence, index) => {
    let score = 0;
    let matchedPattern = null;
    for (const pattern of HOOK_PATTERNS) {
      if (pattern.re.test(sentence)) {
        score += 3;
        matchedPattern = pattern.label;
        break;
      }
    }
    // Earlier sentences are more likely to be the hook
    score += Math.max(0, 5 - index * 0.5);
    // Shorter sentences punch harder
    if (sentence.length < 60) score += 1;
    if (sentence.length < 40) score += 1;
    return { sentence, score, pattern: matchedPattern };
  });

  scored.sort((a, b) => b.score - a.score);
  const hooks = scored.slice(0, count).map((item) => {
    const cta = CTA_TEMPLATES[Math.floor(Math.random() * CTA_TEMPLATES.length)];
    return {
      hook: item.sentence,
      cta,
      pattern: item.pattern || 'general',
      score: Math.round(item.score * 10) / 10
    };
  });
  return hooks;
}

/* ------------------------------------------------------------------ 2. Multi-language */

const LANGUAGE_LABELS = {
  auto: 'Auto-detect',
  en: 'English',
  ur: 'Urdu',
  hi: 'Hindi',
  ar: 'Arabic',
  pa: 'Punjabi',
  fa: 'Persian',
  bn: 'Bengali',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  pt: 'Portuguese',
  ru: 'Russian',
  tr: 'Turkish',
  id: 'Indonesian',
  ms: 'Malay',
  zh: 'Chinese',
  ja: 'Japanese',
  ko: 'Korean',
  it: 'Italian',
  nl: 'Dutch'
};

const CAPTION_TRANSLATIONS = {
  en: {
    follow: 'Follow for more',
    save: 'Save this for later',
    share: 'Share with someone who needs this',
    comment: 'Comment your thoughts below',
    notifications: 'Turn on notifications',
    watch: 'Watch till the end'
  },
  ur: {
    follow: 'مزید کے لیے فالو کریں',
    save: 'بعد کے لیے محفوظ کریں',
    share: 'کسی ایسے شخص کے ساتھ شیئر کریں جسے اس کی ضرورت ہو',
    comment: 'نیچے اپنی رائے دیں',
    notifications: 'نوٹیفیکیشن آن کریں',
    watch: 'آخر تک دیکھیں'
  },
  hi: {
    follow: 'और के लिए फॉलो करें',
    save: 'बाद के लिए सेव करें',
    share: 'किसी ऐसे व्यक्ति के साथ शेयर करें जिसे इसकी ज़रूरत हो',
    comment: 'नीचे अपनी राय दें',
    notifications: 'नोटिफिकेशन चालू करें',
    watch: 'आखिर तक देखें'
  },
  ar: {
    follow: 'تابع للمزيد',
    save: 'احفظ هذا لوقت لاحق',
    share: 'شارك مع شخص يحتاج هذا',
    comment: 'اكتب رأيك بالأسفل',
    notifications: 'فعّل الإشعارات',
    watch: 'شاهد حتى النهاية'
  },
  es: {
    follow: 'Sígueme para más',
    save: 'Guarda esto para después',
    share: 'Comparte con alguien que lo necesite',
    comment: 'Comenta tus ideas abajo',
    notifications: 'Activa las notificaciones',
    watch: 'Mira hasta el final'
  },
  fr: {
    follow: 'Suivez pour plus',
    save: 'Enregistrez pour plus tard',
    share: 'Partagez avec quelqu\'un qui en a besoin',
    comment: 'Commentez ci-dessous',
    notifications: 'Activez les notifications',
    watch: 'Regardez jusqu\'au bout'
  },
  de: {
    follow: 'Folge für mehr',
    save: 'Speichere für später',
    share: 'Teile mit jemandem, der das braucht',
    comment: 'Hinterlasse einen Kommentar',
    notifications: 'Aktiviere Benachrichtigungen',
    watch: 'Schau bis zum Ende'
  },
  pt: {
    follow: 'Siga para mais',
    save: 'Salve para depois',
    share: 'Compartilhe com alguém que precise',
    comment: 'Comente abaixo',
    notifications: 'Ative as notificações',
    watch: 'Assista até o fim'
  },
  tr: {
    follow: 'Daha fazlası için takip et',
    save: 'Sonra için kaydet',
    share: 'Buna ihtiyacı olan biriyle paylaş',
    comment: 'Aşağıya yorum yap',
    notifications: 'Bildirimleri aç',
    watch: 'Sonuna kadar izle'
  },
  id: {
    follow: 'Ikuti untuk lebih banyak',
    save: 'Simpan untuk nanti',
    share: 'Bagikan dengan yang membutuhkan',
    comment: 'Komentar di bawah',
    notifications: 'Aktifkan notifikasi',
    watch: 'Tonton sampai habis'
  },
  zh: {
    follow: '关注获取更多',
    save: '保存以备后用',
    share: '分享给需要的人',
    comment: '在下方评论',
    notifications: '开启通知',
    watch: '看到最后'
  },
  ja: {
    follow: 'フォローしてね',
    save: '後で見るために保存',
    share: '必要な人とシェア',
    comment: 'コメントしてね',
    notifications: '通知をオンに',
    watch: '最後まで見て'
  },
  ko: {
    follow: '팔로우 하세요',
    save: '나중에 보려면 저장',
    share: '필요한 사람과 공유',
    comment: '아래에 댓글',
    notifications: '알림 켜기',
    watch: '끝까지 보세요'
  }
};

function translateCta(ctaKey, language) {
  const lang = LANGUAGE_LABELS[language] ? language : 'en';
  const table = CAPTION_TRANSLATIONS[lang] || CAPTION_TRANSLATIONS.en;
  return table[ctaKey] || CAPTION_TRANSLATIONS.en[ctaKey] || ctaKey;
}

function getLanguageLabels() {
  return LANGUAGE_LABELS;
}

/* ------------------------------------------------------------------ 3. Batch processing */

class BatchQueue {
  constructor() {
    this.queue = [];
    this.running = false;
    this.results = [];
    this.listeners = new Set();
  }

  add(item) {
    const id = crypto.randomBytes(6).toString('hex');
    const entry = { id, ...item, status: 'queued', progress: 0, error: null, result: null };
    this.queue.push(entry);
    this._emit();
    return id;
  }

  remove(id) {
    const index = this.queue.findIndex((item) => item.id === id);
    if (index === -1) return false;
    const [removed] = this.queue.splice(index, 1);
    if (removed.status === 'running') {
      if (removed.abort) removed.abort();
    }
    this._emit();
    return true;
  }

  clear() {
    this.queue.forEach((item) => {
      if (item.status === 'running' && item.abort) item.abort();
    });
    this.queue = [];
    this.results = [];
    this._emit();
  }

  getState() {
    return {
      queue: this.queue.map(({ id, url, status, progress, error }) => ({ id, url, status, progress, error })),
      results: this.results,
      running: this.running
    };
  }

  onUpdate(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  _emit() {
    const state = this.getState();
    this.listeners.forEach((cb) => cb(state));
  }

  async run(processor) {
    if (this.running) return { success: false, error: 'Batch is already running.' };
    this.running = true;
    this.results = [];
    this._emit();

    for (const item of this.queue) {
      if (item.status === 'cancelled') continue;
      item.status = 'running';
      item.progress = 0;
      this._emit();
      try {
        const result = await processor(item, (percent) => {
          item.progress = percent;
          this._emit();
        });
        item.status = 'completed';
        item.result = result;
        this.results.push({ id: item.id, url: item.url, success: true, result });
      } catch (err) {
        item.status = 'failed';
        item.error = err.message;
        this.results.push({ id: item.id, url: item.url, success: false, error: err.message });
      }
      this._emit();
    }

    this.running = false;
    this._emit();
    return { success: true, results: this.results };
  }
}

/* ------------------------------------------------------------------ 4. Analytics dashboard */

const ANALYTICS_FILE = 'analytics.json';

function analyticsFile(dataDir) {
  return path.join(dataDir, ANALYTICS_FILE);
}

function loadAnalytics(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(analyticsFile(dataDir), 'utf8'));
  } catch (_) {
    return { events: [], totals: { clipsCreated: 0, videosGenerated: 0, exports: 0 } };
  }
}

function saveAnalytics(dataDir, data) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(analyticsFile(dataDir), JSON.stringify(data, null, 2), 'utf8');
}

function trackEvent(dataDir, event) {
  const data = loadAnalytics(dataDir);
  const entry = {
    ...event,
    timestamp: new Date().toISOString()
  };
  data.events.push(entry);
  // Keep only the last 1000 events
  if (data.events.length > 1000) data.events = data.events.slice(-1000);

  // Update totals
  if (event.type === 'clip-render') data.totals.clipsCreated += event.count || 1;
  if (event.type === 'generate-video') data.totals.videosGenerated += 1;
  if (event.type === 'clip-export') data.totals.exports += 1;

  saveAnalytics(dataDir, data);
  return entry;
}

function getAnalytics(dataDir, days = 30) {
  const data = loadAnalytics(dataDir);
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const recent = data.events.filter((e) => new Date(e.timestamp).getTime() >= cutoff);

  // Group by day
  const byDay = {};
  recent.forEach((e) => {
    const day = e.timestamp.slice(0, 10);
    if (!byDay[day]) byDay[day] = { clips: 0, videos: 0, exports: 0 };
    if (e.type === 'clip-render') byDay[day].clips += e.count || 1;
    if (e.type === 'generate-video') byDay[day].videos += 1;
    if (e.type === 'clip-export') byDay[day].exports += 1;
  });

  return {
    totals: data.totals,
    events: recent.slice(-100),
    byDay: Object.entries(byDay)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, counts]) => ({ date, ...counts }))
  };
}

/* ------------------------------------------------------------------ 5. Auto-posting presets */

const PLATFORM_PRESETS = {
  tiktok: {
    label: 'TikTok',
    aspect: 'vertical',
    resolution: '1080x1920',
    maxDuration: 60,
    captionStyle: 'bold',
    hashtags: ['#fyp', '#viral', '#clips'],
    description: 'Best for: short punchy clips with bold captions'
  },
  youtube_shorts: {
    label: 'YouTube Shorts',
    aspect: 'vertical',
    resolution: '1080x1920',
    maxDuration: 60,
    captionStyle: 'boxed',
    hashtags: ['#shorts', '#youtubeshorts'],
    description: 'Best for: boxed captions, clear text'
  },
  instagram_reels: {
    label: 'Instagram Reels',
    aspect: 'vertical',
    resolution: '1080x1920',
    maxDuration: 90,
    captionStyle: 'karaoke',
    hashtags: ['#reels', '#trending'],
    description: 'Best for: karaoke-style word highlighting'
  }
};

function getPlatformPresets() {
  return PLATFORM_PRESETS;
}

function getPlatformPreset(key) {
  return PLATFORM_PRESETS[key] || PLATFORM_PRESETS.tiktok;
}

/* ------------------------------------------------------------------ 6. Trial/demo mode */

const TRIAL_CONFIG = {
  enabled: true,
  maxClips: 3,           // trial users can only make 3 clips
  watermarkText: 'Clipping by Saim',
  watermarkOpacity: 0.35,
  watermarkScale: 0.12,
  trialDays: 7
};

function isTrialMode(licenseStatus) {
  // If licensing is not configured, or the user is not licensed → trial mode
  return !licenseStatus || !licenseStatus.allowed;
}

function getTrialConfig() {
  return TRIAL_CONFIG;
}

function applyWatermark(ffmpegArgs, position = 'bottom-right') {
  const { watermarkText, watermarkOpacity, watermarkScale } = TRIAL_CONFIG;
  const positions = {
    'bottom-right': '(w-text_w-20):(h-text_h-20)',
    'bottom-left': '20:(h-text_h-20)',
    'top-right': '(w-text_w-20):20',
    'top-left': '20:20',
    center: '(w-text_w)/2:(h-text_h)/2'
  };
  const pos = positions[position] || positions['bottom-right'];
  const drawtext = `drawtext=text='${watermarkText}':fontsize=h*${watermarkScale}:fontcolor=white@${watermarkOpacity}:x=${pos}:y=${pos}`;
  ffmpegArgs.push('-vf', drawtext);
  return ffmpegArgs;
}

module.exports = {
  // 1. Auto-caption AI
  generateHooks,
  // 2. Multi-language
  translateCta,
  getLanguageLabels,
  // 3. Batch processing
  BatchQueue,
  // 4. Analytics
  trackEvent,
  getAnalytics,
  // 5. Auto-posting
  getPlatformPresets,
  getPlatformPreset,
  // 6. Trial/demo mode
  isTrialMode,
  getTrialConfig,
  applyWatermark
};