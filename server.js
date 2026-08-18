import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const envText = fs.readFileSync(envPath, 'utf8');
  for (const line of envText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const equalsIndex = trimmed.indexOf('=');
    if (equalsIndex === -1) continue;
    const key = trimmed.slice(0, equalsIndex).trim();
    const value = trimmed.slice(equalsIndex + 1).trim().replace(/^["']|["']$/g, '');
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

const app = express();
const PORT = process.env.PORT || 3000;
const CONTACT_TO_EMAIL = process.env.CONTACT_TO_EMAIL || 'info@convetube.com';
const BREVO_SENDER_EMAIL = process.env.BREVO_SENDER_EMAIL || 'noreply@convetube.com';
const BREVO_SENDER_NAME = process.env.BREVO_SENDER_NAME || 'ConveTube';

const cookiesPath = path.join(__dirname, 'cookies.txt');

// Helper to get base yt-dlp arguments for spawn
const getBaseYtDlpArgs = () => {
  const args = ['--js-runtimes', 'node'];
  if (fs.existsSync(cookiesPath)) {
    args.push('--cookies', cookiesPath);
  }
  return args;
};

// Setup cache directory
const cacheDir = path.join(__dirname, 'cache');
if (!fs.existsSync(cacheDir)) {
  fs.mkdirSync(cacheDir);
}

// Track active background conversions
const activeTranscodes = new Map();

const supportedOutputFormats = new Set(['mp3', 'm4a', 'wav', 'flac', 'ogg', 'mp4']);
const getOutputFormat = (format) => supportedOutputFormats.has(format) ? format : 'mp3';

const getTranscodeOptions = (format, quality = 'download') => {
  if (format === 'mp4') {
    return {
      extension: 'mp4',
      mimeType: 'video/mp4',
      ffmpegArgs: [],
    };
  }

  if (format === 'wav') {
    return {
      extension: 'wav',
      mimeType: 'audio/wav',
      ffmpegArgs: ['-f', 'wav', '-acodec', 'pcm_s16le', '-ar', '44100'],
    };
  }

  if (format === 'm4a') {
    return {
      extension: 'm4a',
      mimeType: 'audio/mp4',
      ffmpegArgs: ['-f', 'ipod', '-acodec', 'aac', '-b:a', '256k', '-movflags', '+faststart'],
    };
  }

  if (format === 'flac') {
    return {
      extension: 'flac',
      mimeType: 'audio/flac',
      ffmpegArgs: ['-f', 'flac', '-acodec', 'flac'],
    };
  }

  if (format === 'ogg') {
    return {
      extension: 'ogg',
      mimeType: 'audio/ogg',
      ffmpegArgs: ['-f', 'ogg', '-acodec', 'libvorbis', '-ab', quality === 'stream' ? '128k' : '192k'],
    };
  }

  return {
    extension: 'mp3',
    mimeType: 'audio/mpeg',
    ffmpegArgs: ['-f', 'mp3', '-acodec', 'libmp3lame', '-ab', quality === 'stream' ? '128k' : '320k'],
  };
};

const normalizeSourceUrl = (value) => {
  try {
    const parsed = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) return null;
    return parsed.toString();
  } catch {
    return null;
  }
};

const getSourceKey = (sourceUrl) => crypto
  .createHash('sha256')
  .update(sourceUrl)
  .digest('hex')
  .slice(0, 32);

const getSourceFromRequest = (req) => {
  const directUrl = normalizeSourceUrl(req.query.source || req.query.url);
  if (directUrl) {
    return { url: directUrl, key: getSourceKey(directUrl) };
  }

  // Keep old clients and cached YouTube links working during the migration.
  const legacyId = String(req.query.id || '').trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(legacyId)) {
    const legacyUrl = `https://www.youtube.com/watch?v=${legacyId}`;
    return { url: legacyUrl, key: getSourceKey(legacyUrl) };
  }

  return null;
};

const getCachePath = (sourceKey, format) => path.join(cacheDir, `${sourceKey}.${format}`);

const startBackgroundTranscode = (sourceUrl, sourceKey, requestedFormat = 'mp3') => {
  const format = getOutputFormat(requestedFormat);
  const options = getTranscodeOptions(format);
  const cachePath = getCachePath(sourceKey, format);
  const transcodeKey = `${sourceKey}:${format}`;
  if (fs.existsSync(cachePath) || activeTranscodes.has(transcodeKey)) {
    return; // Already cached or currently transcoding
  }

  const tempPath = path.join(cacheDir, `${sourceKey}.${format}.tmp`);
  const downloadPath = path.join(cacheDir, `${sourceKey}.${format}.download`);
  
  console.log(`[Cache] Starting optimized background ${format.toUpperCase()} conversion for source: ${sourceKey}`);

  if (format === 'mp4') {
    const ytDlp = spawn('yt-dlp', [
      ...getBaseYtDlpArgs(),
      '-f', 'best[ext=mp4]/best',
      '--no-playlist',
      '-o', tempPath,
      sourceUrl
    ]);

    activeTranscodes.set(transcodeKey, { ytDlp, tempPath });

    ytDlp.on('close', (code) => {
      activeTranscodes.delete(transcodeKey);
      if (code === 0 && fs.existsSync(tempPath)) {
        fs.renameSync(tempPath, cachePath);
        console.log(`[Cache] Completed background conversion: ${sourceKey}.mp4`);
      } else {
        console.error(`[Cache] MP4 download failed with code ${code} for source: ${sourceKey}`);
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      }
    });

    ytDlp.on('error', (err) => {
      console.error('[Cache] yt-dlp failed to start:', err);
      activeTranscodes.delete(transcodeKey);
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    });
    return;
  }
  
  // Step 1: Download bestaudio to a local file.
  // Downloading to a local file bypasses YouTube's play-rate throttling on piped stdout.
  const ytDlpArgs = [...getBaseYtDlpArgs(), '-f', 'bestaudio', '-o', downloadPath, sourceUrl];
  const ytDlp = spawn('yt-dlp', ytDlpArgs);
  
  activeTranscodes.set(transcodeKey, { ytDlp, tempPath, downloadPath });

  ytDlp.on('close', (code) => {
    if (code !== 0) {
      console.error(`[Cache] yt-dlp download failed with code ${code} for source: ${sourceKey}`);
      if (fs.existsSync(downloadPath)) fs.unlinkSync(downloadPath);
      activeTranscodes.delete(transcodeKey);
      return;
    }

    console.log(`[Cache] Download complete for ${sourceKey}. Starting ffmpeg transcoding...`);

    // Step 2: Transcode local file to MP3.
    // Transcoding from a local file allows ffmpeg to utilize multithreaded decoding and high-speed local disk I/O.
    const ffmpeg = spawn('ffmpeg', [
      '-i', downloadPath,
      ...options.ffmpegArgs,
      '-threads', '0', // Use all available CPU cores
      '-y',
      tempPath
    ]);

    // Update active transcode mapping with ffmpeg process
    const current = activeTranscodes.get(transcodeKey);
    if (current) {
      current.ffmpeg = ffmpeg;
    }

    ffmpeg.on('close', (ffmpegCode) => {
      activeTranscodes.delete(transcodeKey);
      
      // Clean up the temporary download file
      if (fs.existsSync(downloadPath)) {
        try {
          fs.unlinkSync(downloadPath);
        } catch (e) {
          console.error(`[Cache] Failed to delete temp download file: ${e.message}`);
        }
      }

      if (ffmpegCode === 0) {
        if (fs.existsSync(tempPath)) {
          fs.renameSync(tempPath, cachePath);
          console.log(`[Cache] Completed background transcode: ${sourceKey}.${options.extension}`);
        }
      } else {
        console.error(`[Cache] ffmpeg transcoding failed with code ${ffmpegCode} for source: ${sourceKey}`);
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      }
    });

    ffmpeg.on('error', (err) => {
      console.error(`[Cache] ffmpeg failed to start:`, err);
      activeTranscodes.delete(transcodeKey);
      if (fs.existsSync(downloadPath)) fs.unlinkSync(downloadPath);
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    });
  });

  ytDlp.on('error', (err) => {
    console.error(`[Cache] yt-dlp failed to start:`, err);
    activeTranscodes.delete(transcodeKey);
    if (fs.existsSync(downloadPath)) fs.unlinkSync(downloadPath);
  });
};

// Enable CORS
app.use(cors());
app.use(express.json({ limit: '20kb' }));
app.use(express.urlencoded({ extended: false, limit: '20kb' }));

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Set EJS view engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Clean filename helper
const sanitizeFilename = (filename) => {
  return filename.replace(/[^a-zA-Z0-9\s-_]/g, '').replace(/\s+/g, '_') || 'convetube-audio';
};

const getDownloadFilename = (title, extension) => {
  const baseName = sanitizeFilename(String(title || 'audio'));
  const prefixedName = /^convetube[_-]/i.test(baseName) ? baseName : `ConveTube_${baseName}`;
  return `${prefixedName}.${extension}`;
};

const escapeHtml = (value) => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const languageAlternates = {
  es: 'https://convetube.com/convertidor-de-youtube-a-mp3/',
  fr: 'https://convetube.com/convertir-youtube-vers-mp3/',
  en: 'https://convetube.com/'
};

const languageHomePaths = {
  es: '/convertidor-de-youtube-a-mp3',
  fr: '/convertir-youtube-vers-mp3',
  en: '/'
};

const supportedLanguages = new Set(Object.keys(languageHomePaths));

const getCookieValue = (cookieHeader, name) => {
  const match = String(cookieHeader || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
};

const detectBrowserLanguage = (acceptLanguage) => {
  const requestedLanguages = String(acceptLanguage || '')
    .split(',')
    .map((entry) => {
      const [tag, quality = 'q=1'] = entry.trim().split(';');
      return { tag: tag.toLowerCase(), quality: Number(quality.replace(/^q=/, '')) || 0 };
    })
    .filter(({ tag, quality }) => tag && quality > 0)
    .sort((a, b) => b.quality - a.quality);

  for (const { tag } of requestedLanguages) {
    const language = tag.split('-')[0];
    if (supportedLanguages.has(language)) return language;
  }
  return 'en';
};

const getLanguageAlternates = (canonical, lang) => ({
  es: lang === 'es' ? canonical : languageAlternates.es,
  fr: lang === 'fr' ? canonical : languageAlternates.fr,
  en: lang === 'en' ? canonical : languageAlternates.en
});

const createStructuredData = ({ canonical, title, description, lang, applicationName, applicationCategory, featureList, faqItems }) => ({
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'WebApplication',
      '@id': `${canonical}#webapplication`,
      name: applicationName,
      url: canonical,
      description,
      applicationCategory,
      operatingSystem: 'Any',
      browserRequirements: 'Requires JavaScript and a modern web browser',
      inLanguage: lang,
      featureList,
      provider: {
        '@type': 'Organization',
        name: 'ConveTube',
        url: 'https://convetube.com/'
      }
    },
    {
      '@type': 'FAQPage',
      '@id': `${canonical}#faq`,
      url: canonical,
      inLanguage: lang,
      mainEntity: faqItems.map(({ question, answer }) => ({
        '@type': 'Question',
        name: question,
        acceptedAnswer: {
          '@type': 'Answer',
          text: answer
        }
      }))
    }
  ]
});

const renderPage = (res, view, page) => {
  const { lang, ...pageData } = page;
  res.cookie('convetube_lang', lang, {
    maxAge: 1000 * 60 * 60 * 24 * 365,
    httpOnly: false,
    sameSite: 'lax',
    path: '/'
  });
  res.render(view, {
    ...pageData,
    lang,
    hreflang: getLanguageAlternates(page.canonical, lang),
    structuredData: createStructuredData({ ...page, lang })
  });
};

// --- Web Page Routes ---

// SEO tool pages: one primary keyword per URL, with supporting sections and related-tool links.
app.get('/mp3-converter/link-to-mp3/', (req, res) => {
  renderPage(res, 'seo-converter-page', {
    lang: 'en',
    title: 'Link to MP3 Converter Free Online | Convert Video Links - ConveTube',
    description: 'Use a free link to MP3 converter to turn a supported video link into an MP3 file online. Paste a URL, preview the audio, and download it in your browser.',
    canonical: 'https://convetube.com/mp3-converter/link-to-mp3/',
    applicationName: 'ConveTube Link to MP3 Converter',
    applicationCategory: 'MultimediaApplication',
    featureList: ['Link to MP3 conversion', 'Audio preview in the browser', 'MP3 download without software installation'],
    keyword: 'link to MP3 converter',
    heading: 'Link to',
    headingAccent: 'MP3 Converter',
    heroSubtitle: 'Convert a supported video link to MP3 online, preview the audio, and save the result from your browser.',
    breadcrumbItems: [{ label: 'Home', href: '/' }, { label: 'MP3 Converter', href: '/mp3-converter/link-to-mp3/' }, { label: 'Link to MP3' }],
    introHeading: 'Free link to MP3 converter online',
    introParagraphs: [
      'ConveTube helps you turn a supported <strong>video link into an MP3</strong> without installing a desktop application. Paste the link above, let the converter prepare the audio, and check the result before downloading.',
      'This page is designed for people searching for a direct link to MP3 workflow. It supports a simple URL-first experience on modern phones, tablets, and computers.'
    ],
    stepsHeading: 'How to convert a link to MP3',
    steps: [
      { title: 'Copy the video link', body: 'copy the URL of the video you want to use.' },
      { title: 'Paste the link above', body: 'add it to the converter and start the audio analysis.' },
      { title: 'Preview the audio', body: 'check the title and playback controls when the result is ready.' },
      { title: 'Download MP3', body: 'save the audio file to your device for compatible personal use.' }
    ],
    benefitsHeading: 'Why use a link to MP3 converter?',
    benefits: [
      { icon: 'URL', title: 'Direct link workflow', body: 'Start with a URL instead of searching through files or installing conversion software.' },
      { icon: 'MP3', title: 'Widely supported output', body: 'MP3 files work with common phones, computers, music players, and editing tools.' },
      { icon: 'WEB', title: 'Works in a browser', body: 'Use the same conversion flow on desktop and mobile browsers.' },
      { icon: 'PLAY', title: 'Preview before saving', body: 'Listen to the prepared result before you download the final file.' }
    ],
    relatedTools: [
      { href: '/mp3-converter/video-to-mp3/', label: 'Video to MP3', description: 'Convert a video URL to an MP3 audio file.' },
      { href: '/', label: 'URL to MP3', description: 'Use the homepage for a general URL-to-MP3 workflow.' },
      { href: '/wav-converter/youtube-to-wav/', label: 'YouTube to WAV', description: 'Choose WAV when you need an uncompressed output.' }
    ],
    faqHeading: 'Frequently asked questions about link to MP3 conversion',
    faqItems: [
      { question: 'What is a link to MP3 converter?', answer: 'A link to MP3 converter accepts a supported video URL and prepares an MP3 audio file that you can preview and download in a browser.' },
      { question: 'How do I convert a link to MP3?', answer: 'Copy a supported video link, paste it into the converter, wait for the audio result, preview it, and select the MP3 download button.' },
      { question: 'Can I use a link to MP3 converter on a phone?', answer: 'Yes. ConveTube is designed for modern mobile and desktop browsers, so you can paste a link and download the result from your device.' },
      { question: 'Why use MP3 instead of WAV?', answer: 'MP3 is usually smaller and easier to store or share. Use the YouTube to WAV page when your workflow needs uncompressed audio.' }
    ],
    genericUrl: true,
    defaultFormat: 'mp3'
  });
});

app.get('/mp3-converter/video-to-mp3/', (req, res) => {
  renderPage(res, 'seo-converter-page', {
    lang: 'en',
    title: 'Video to MP3 Converter Free Online | Convert Video to MP3 - ConveTube',
    description: 'Convert video to MP3 online for free with ConveTube. Paste a supported video URL, preview the extracted audio, and download an MP3 file in your browser.',
    canonical: 'https://convetube.com/mp3-converter/video-to-mp3/',
    applicationName: 'ConveTube Video to MP3 Converter',
    applicationCategory: 'MultimediaApplication',
    featureList: ['Video to MP3 conversion', 'Audio preview before download', 'Browser-based conversion on mobile and desktop'],
    keyword: 'video to MP3 converter',
    heading: 'Video to',
    headingAccent: 'MP3 Converter',
    heroSubtitle: 'Convert a supported video URL to a compact MP3 audio file with a fast, browser-based workflow.',
    breadcrumbItems: [{ label: 'Home', href: '/' }, { label: 'MP3 Converter', href: '/mp3-converter/video-to-mp3/' }, { label: 'Video to MP3' }],
    introHeading: 'Convert video to MP3 online',
    introParagraphs: [
      'Use this <strong>video to MP3 converter</strong> when you want the audio track from a supported video URL. ConveTube extracts the audio, prepares an MP3, and gives you a built-in preview before the download step.',
      'MP3 is a practical choice for listening, notes, podcasts, and other workflows where a smaller audio file is more convenient than the original video.'
    ],
    stepsHeading: 'How to convert video to MP3',
    steps: [
      { title: 'Copy a supported video URL', body: 'open the source video and copy its full link.' },
      { title: 'Paste the URL', body: 'insert the link in the converter and start processing.' },
      { title: 'Review the result', body: 'use the title and audio player to confirm the prepared track.' },
      { title: 'Download the MP3', body: 'save the audio file when the conversion is complete.' }
    ],
    benefitsHeading: 'Benefits of converting video to MP3',
    benefits: [
      { icon: 'AUDIO', title: 'Audio-only playback', body: 'Listen to the extracted track without keeping a full video open.' },
      { icon: '320', title: 'High-quality MP3', body: 'The download flow prepares an MP3 suitable for everyday listening.' },
      { icon: 'FAST', title: 'Simple four-step flow', body: 'Paste, process, preview, and download without a multi-screen setup.' },
      { icon: 'MOBILE', title: 'Mobile friendly', body: 'Use the page on Android, iPhone, tablet, Windows, or macOS.' }
    ],
    relatedTools: [
      { href: '/mp3-converter/link-to-mp3/', label: 'Link to MP3', description: 'Convert a supported video link into MP3.' },
      { href: '/', label: 'URL to MP3', description: 'Start with any supported video URL from the homepage.' },
      { href: '/wav-converter/youtube-to-wav/', label: 'YouTube to WAV', description: 'Use the WAV workflow for editing and production.' }
    ],
    faqHeading: 'Frequently asked questions about video to MP3 conversion',
    faqItems: [
      { question: 'What does a video to MP3 converter do?', answer: 'It extracts the audio track from a supported video URL and prepares it as an MP3 file for preview and download.' },
      { question: 'How do I convert a video to MP3 online?', answer: 'Paste a supported video URL into ConveTube, wait for the result, preview the audio, and download the MP3 file.' },
      { question: 'Is video to MP3 conversion available on mobile?', answer: 'Yes. The converter runs in a modern mobile browser and does not require a separate desktop application.' },
      { question: 'When should I choose WAV instead?', answer: 'Choose WAV when you need an uncompressed file for editing, sampling, mixing, or production. MP3 is generally smaller for listening and storage.' }
    ],
    genericUrl: true,
    defaultFormat: 'mp3'
  });
});

app.get('/wav-converter/youtube-to-wav/', (req, res) => {
  renderPage(res, 'seo-converter-page', {
    lang: 'en',
    title: 'YouTube to WAV Converter Free Online | Download WAV - ConveTube',
    description: 'Convert YouTube to WAV online for free. Download uncompressed WAV audio for editing, sampling, production, and creative projects in your browser.',
    canonical: 'https://convetube.com/wav-converter/youtube-to-wav/',
    applicationName: 'ConveTube YouTube to WAV Converter',
    applicationCategory: 'MultimediaApplication',
    featureList: ['YouTube to WAV conversion', '44.1 kHz PCM output', 'Browser-based audio preview and download'],
    keyword: 'YouTube to WAV converter',
    heading: 'YouTube to',
    headingAccent: 'WAV Converter',
    heroSubtitle: 'Convert a YouTube video URL to WAV for editing, sampling, production, and projects that need uncompressed audio.',
    breadcrumbItems: [{ label: 'Home', href: '/' }, { label: 'WAV Converter', href: '/wav-converter/youtube-to-wav/' }, { label: 'YouTube to WAV' }],
    introHeading: 'Free YouTube to WAV converter online',
    introParagraphs: [
      'Use ConveTube when you need <strong>YouTube to WAV</strong> instead of a compressed MP3. Paste a supported YouTube link, let the converter prepare the audio, preview the result, and download a WAV file directly in your browser.',
      'WAV files are larger, but they are useful for editing, trimming, normalization, remixing, and production workflows where you want an uncompressed output.'
    ],
    stepsHeading: 'How to convert YouTube to WAV',
    steps: [
      { title: 'Copy the YouTube link', body: 'open the video and copy its URL from the share or address bar.' },
      { title: 'Paste it above', body: 'add the link to the converter and start the audio analysis.' },
      { title: 'Preview the WAV result', body: 'check the prepared audio and its metadata in the built-in player.' },
      { title: 'Download WAV', body: 'save the uncompressed audio file for your next project.' }
    ],
    benefitsHeading: 'Why choose WAV?',
    benefits: [
      { icon: 'WAV', title: 'Uncompressed output', body: 'Keep an uncompressed PCM file for editing and production workflows.' },
      { icon: 'DAW', title: 'Editor friendly', body: 'Import the result into Audacity, Ableton, Logic, Premiere, and similar tools.' },
      { icon: '44.1', title: 'Standard PCM', body: 'The output is generated as WAV PCM at 44.1 kHz for broad compatibility.' },
      { icon: 'MP3', title: 'Switch to MP3 when smaller', body: 'Use the MP3 pages when storage, sharing, or everyday playback matters more.' }
    ],
    relatedTools: [
      { href: '/mp3-converter/video-to-mp3/', label: 'Video to MP3', description: 'Choose a smaller audio format for everyday listening.' },
      { href: '/mp3-converter/link-to-mp3/', label: 'Link to MP3', description: 'Convert a supported video link directly to MP3.' },
      { href: '/', label: 'URL to MP3', description: 'Start with a general URL-to-MP3 workflow.' }
    ],
    faqHeading: 'Frequently asked questions about YouTube to WAV',
    faqItems: [
      { question: 'Why convert YouTube to WAV?', answer: 'WAV is useful for editing, trimming, mixing, sampling, and production workflows that need an uncompressed audio file.' },
      { question: 'Are WAV files larger than MP3 files?', answer: 'Yes. WAV preserves audio without compression, so it usually requires more storage than an MP3.' },
      { question: 'What sample rate does the WAV output use?', answer: 'The WAV output is generated as PCM at 44.1 kHz, a standard setting supported by many editors.' },
      { question: 'Can I use the converter on a phone?', answer: 'Yes. Paste the link and download the WAV file from a modern browser on Android, iPhone, tablet, or desktop.' }
    ],
    genericUrl: false,
    defaultFormat: 'wav'
  });
});

app.get('/flac-converter/youtube-to-flac/', (req, res) => {
  renderPage(res, 'seo-converter-page', {
    lang: 'en',
    title: 'YouTube to FLAC Converter – Save Lossless Audio | ConveTube',
    description: 'Convert a supported YouTube link to FLAC online for lossless audio workflows. Understand source quality, file size, playback, and download steps.',
    canonical: 'https://convetube.com/flac-converter/youtube-to-flac/',
    applicationName: 'ConveTube YouTube to FLAC Converter',
    applicationCategory: 'MultimediaApplication',
    featureList: ['YouTube to FLAC conversion', 'Lossless FLAC output', 'Browser-based conversion and download'],
    keyword: 'youtube to flac',
    heading: 'YouTube to',
    headingAccent: 'FLAC Converter',
    heroSubtitle: 'Convert a supported YouTube video link to FLAC for archiving, editing, and lossless audio workflows.',
    showBreadcrumb: false,
    breadcrumbItems: [{ label: 'Home', href: '/' }, { label: 'FLAC Converter', href: '/flac-converter/youtube-to-flac/' }, { label: 'YouTube to FLAC' }],
    introHeading: 'Convert YouTube to FLAC online',
    introParagraphs: [
      'Use this <strong>YouTube to FLAC</strong> tool when your workflow needs a lossless audio container. Paste a supported YouTube URL above, let ConveTube prepare the audio, review the result, and download the FLAC file.',
      'FLAC avoids adding lossy compression during export, but it does not restore detail that is missing from the source video. The result can be useful for editing, tagging, archiving, and playback on FLAC-compatible devices.'
    ],
    stepsHeading: 'How to convert YouTube to FLAC',
    steps: [
      { title: 'Copy the YouTube URL', body: 'open the video you are permitted to use and copy its full link.' },
      { title: 'Paste the link', body: 'add the URL to the converter and keep FLAC selected as the output.' },
      { title: 'Prepare the audio', body: 'start conversion and wait while the source audio is processed.' },
      { title: 'Download FLAC', body: 'review the result and save the lossless-format file to your device.' }
    ],
    benefitsHeading: 'FLAC quality, size, and compatibility',
    benefits: [
      { icon: 'FLAC', title: 'Lossless output', body: 'FLAC stores the converted audio without adding another lossy compression stage.' },
      { icon: 'SOURCE', title: 'Source quality matters', body: 'Exporting to FLAC preserves the available source; it does not increase the original fidelity.' },
      { icon: 'SIZE', title: 'Larger files', body: 'Expect FLAC downloads to use more storage than equivalent MP3 or OGG files.' },
      { icon: 'PLAY', title: 'Broad tool support', body: 'FLAC works in many desktop players, media libraries, editors, and current mobile apps.' }
    ],
    relatedTools: [
      { href: '/ogg-converter/youtube-to-ogg/', label: 'YouTube to OGG', description: 'Choose a smaller open audio format for compatible players.' },
      { href: '/mp3-converter/youtube-to-mp3/', label: 'YouTube to MP3', description: 'Create a compact audio file for broad playback support.' },
      { href: '/youtube-to-wav/', label: 'YouTube to WAV', description: 'Use the existing WAV converter for uncompressed PCM output.' }
    ],
    faqHeading: 'YouTube to FLAC questions',
    faqItems: [
      { question: 'How do I convert YouTube to FLAC?', answer: 'Paste a supported YouTube URL into the tool, select FLAC, start the conversion, review the prepared audio, and download the resulting file.' },
      { question: 'Does converting YouTube to FLAC improve audio quality?', answer: 'No. FLAC prevents an additional lossy export, but it cannot recreate audio detail that was not present in the source.' },
      { question: 'Why is a FLAC file larger than an MP3?', answer: 'FLAC uses lossless compression, while MP3 discards some audio data to create a smaller file. The storage difference depends on the source and duration.' },
      { question: 'What devices can play FLAC?', answer: 'Many current phones, computers, media players, library apps, and audio editors support FLAC. Check your target app or device before converting a large file.' }
    ],
    genericUrl: false,
    defaultFormat: 'flac'
  });
});

app.get('/ogg-converter/youtube-to-ogg/', (req, res) => {
  renderPage(res, 'seo-converter-page', {
    lang: 'en',
    title: 'YouTube to OGG Converter – Convert Audio Online | ConveTube',
    description: 'Convert a supported YouTube link to OGG online. Follow a quick workflow, compare compatibility and file size, and troubleshoot common conversion issues.',
    canonical: 'https://convetube.com/ogg-converter/youtube-to-ogg/',
    applicationName: 'ConveTube YouTube to OGG Converter',
    applicationCategory: 'MultimediaApplication',
    featureList: ['YouTube to OGG conversion', 'Vorbis audio output', 'Browser-based conversion and download'],
    keyword: 'youtube to ogg',
    heading: 'YouTube to',
    headingAccent: 'OGG Converter',
    heroSubtitle: 'Convert a supported YouTube video link to OGG for open-format playback and space-conscious audio storage.',
    breadcrumbItems: [{ label: 'Home', href: '/' }, { label: 'OGG Converter', href: '/ogg-converter/youtube-to-ogg/' }, { label: 'YouTube to OGG' }],
    introHeading: 'Convert YouTube to OGG online',
    introParagraphs: [
      'This <strong>YouTube to OGG</strong> converter turns a supported video link into an OGG Vorbis audio file. Paste the URL into the first-screen tool, keep OGG selected, and download the result after processing.',
      'OGG is an open container commonly paired with the Vorbis codec. It can deliver useful quality at moderate file sizes, although support varies across browsers, mobile apps, car systems, and hardware players.'
    ],
    stepsHeading: 'How to convert YouTube to OGG',
    steps: [
      { title: 'Copy the video link', body: 'open a supported YouTube video and copy its full URL.' },
      { title: 'Paste it above', body: 'insert the URL and confirm OGG as the selected format.' },
      { title: 'Run the conversion', body: 'start the tool and wait for the source audio to be prepared.' },
      { title: 'Save the OGG file', body: 'review the result, then download it for a compatible app or device.' }
    ],
    benefitsHeading: 'OGG format uses and compatibility',
    benefits: [
      { icon: 'OGG', title: 'Open audio format', body: 'OGG Vorbis is widely used in open-source software, games, and web-focused audio workflows.' },
      { icon: 'SIZE', title: 'Efficient storage', body: 'Vorbis compression can keep files smaller than lossless FLAC or uncompressed WAV.' },
      { icon: 'CHECK', title: 'Check playback first', body: 'Confirm OGG support in the browser, editor, phone, vehicle, or player you plan to use.' },
      { icon: '192K', title: 'Balanced export', body: 'The download conversion targets a practical balance between clarity and file size.' }
    ],
    relatedTools: [
      { href: '/flac-converter/youtube-to-flac/', label: 'YouTube to FLAC', description: 'Keep a lossless-format file for editing or archiving.' },
      { href: '/mp3-converter/youtube-to-mp3/', label: 'YouTube to MP3', description: 'Choose MP3 when broad device support is the priority.' },
      { href: '/youtube-to-wav/', label: 'YouTube to WAV', description: 'Create an uncompressed file with the existing WAV tool.' }
    ],
    faqHeading: 'YouTube to OGG questions',
    faqItems: [
      { question: 'How do I convert YouTube to OGG?', answer: 'Paste a supported YouTube URL, select OGG, begin conversion, and download the prepared OGG Vorbis audio file.' },
      { question: 'Is OGG supported by every device?', answer: 'No. Many browsers, desktop players, Android apps, and editors support OGG, but some Apple apps, vehicles, and dedicated players may prefer MP3 or WAV.' },
      { question: 'What OGG quality should I choose?', answer: 'The converter uses a balanced setting suitable for typical listening. Choose FLAC when lossless output matters or MP3 when compatibility matters most.' },
      { question: 'Why did the OGG conversion fail?', answer: 'Check that the full YouTube URL is valid and publicly reachable, then retry. A removed, private, region-restricted, or temporarily unavailable source may not process.' }
    ],
    genericUrl: false,
    defaultFormat: 'ogg'
  });
});

app.get('/mp3-converter/youtube-to-mp3/', (req, res) => {
  renderPage(res, 'seo-converter-page', {
    lang: 'en',
    title: 'YouTube to MP3 Converter – Convert Video Links | ConveTube',
    description: 'Convert a supported YouTube link to MP3 online. Use the focused tool, choose audio quality, understand file size, and resolve common URL errors.',
    canonical: 'https://convetube.com/mp3-converter/youtube-to-mp3/',
    applicationName: 'ConveTube YouTube to MP3 Converter',
    applicationCategory: 'MultimediaApplication',
    featureList: ['YouTube to MP3 conversion', '320 kbps MP3 download', 'Audio preview in the browser'],
    keyword: 'youtube to mp3',
    heading: 'YouTube to',
    headingAccent: 'MP3 Converter',
    heroSubtitle: 'Convert a supported YouTube video link to MP3 for compact storage and playback across common devices.',
    breadcrumbItems: [{ label: 'Home', href: '/' }, { label: 'MP3 Converter', href: '/mp3-converter/youtube-to-mp3/' }, { label: 'YouTube to MP3' }],
    introHeading: 'Convert YouTube to MP3 online',
    introParagraphs: [
      'Use this dedicated <strong>YouTube to MP3</strong> page for a focused video-link-to-audio workflow. Paste the full YouTube URL above, start the conversion, preview the prepared track, and save the MP3.',
      'MP3 is a practical output for phones, computers, car stereos, portable players, presentation software, and other tools where broad compatibility and smaller files matter.'
    ],
    stepsHeading: 'How to convert YouTube to MP3',
    steps: [
      { title: 'Copy the YouTube URL', body: 'open the source video and copy its complete link.' },
      { title: 'Paste the link', body: 'add the URL to the converter with MP3 selected.' },
      { title: 'Process and preview', body: 'start conversion, then check the title and audio result.' },
      { title: 'Download MP3', body: 'save the prepared file to your phone, tablet, or computer.' }
    ],
    benefitsHeading: 'MP3 quality, file size, and uses',
    benefits: [
      { icon: 'MP3', title: 'Broad compatibility', body: 'MP3 works with common browsers, phones, computers, vehicles, editors, and media players.' },
      { icon: '320K', title: 'High-quality download', body: 'The download flow prepares a 320 kbps MP3 from the available source audio.' },
      { icon: 'SIZE', title: 'Compact files', body: 'Lossy compression generally uses less storage than FLAC or WAV for the same duration.' },
      { icon: 'PLAY', title: 'Preview first', body: 'Use the built-in player to check the prepared audio before saving it.' }
    ],
    relatedTools: [
      { href: '/flac-converter/youtube-to-flac/', label: 'YouTube to FLAC', description: 'Choose lossless output for editing or archive workflows.' },
      { href: '/ogg-converter/youtube-to-ogg/', label: 'YouTube to OGG', description: 'Use an open audio format for compatible applications.' },
      { href: '/youtube-to-wav/', label: 'YouTube to WAV', description: 'Create an uncompressed WAV file with the existing tool.' }
    ],
    faqHeading: 'YouTube to MP3 questions',
    faqItems: [
      { question: 'How do I convert YouTube to MP3?', answer: 'Copy a supported YouTube URL, paste it into the converter, keep MP3 selected, start processing, preview the result, and download the file.' },
      { question: 'Can I choose MP3 quality?', answer: 'The download workflow prepares a high-quality 320 kbps MP3. The available fidelity still depends on the audio in the source video.' },
      { question: 'Why is my YouTube URL unsupported?', answer: 'Use the complete public video URL and check that the video is still available. Private, removed, age-gated, live, or region-restricted sources may not process.' },
      { question: 'How long does conversion take?', answer: 'Timing depends on video length, source availability, server load, and network speed. Short public videos usually finish sooner than long recordings.' }
    ],
    genericUrl: false,
    defaultFormat: 'mp3'
  });
});

app.get('/mp4-converter/youtube-to-mp4/', (req, res) => {
  renderPage(res, 'seo-converter-page', {
    lang: 'en',
    title: 'YouTube to MP4 Converter Online | ConveTube',
    description: 'Convert a supported YouTube link to MP4 online with a simple browser workflow. Review format compatibility, quality limits, file size, and common link errors.',
    canonical: 'https://convetube.com/mp4-converter/youtube-to-mp4/',
    applicationName: 'ConveTube YouTube to MP4 Converter',
    applicationCategory: 'MultimediaApplication',
    featureList: ['YouTube to MP4 conversion', 'MP4 video output', 'Browser-based conversion and download'],
    keyword: 'youtube to mp4',
    heading: 'YouTube to',
    headingAccent: 'MP4 Converter',
    heroSubtitle: 'Convert a supported YouTube video link to a compatible MP4 file from your browser.',
    breadcrumbItems: [{ label: 'Home', href: '/' }, { label: 'MP4 Converter', href: '/mp4-converter/youtube-to-mp4/' }, { label: 'YouTube to MP4' }],
    introHeading: 'Convert YouTube to MP4 online',
    introParagraphs: [
      'Use this <strong>YouTube to MP4</strong> converter when you need a video file rather than audio only. Paste a supported public YouTube URL into the first-screen tool, start the conversion, and download the prepared MP4.',
      'MP4 is widely supported by browsers, phones, computers, presentation tools, editors, televisions, and messaging apps. Available resolution and processing time still depend on the source video and the formats it provides.'
    ],
    stepsHeading: 'How to convert YouTube to MP4',
    steps: [
      { title: 'Copy the YouTube link', body: 'open the source video and copy its complete public URL.' },
      { title: 'Paste the URL above', body: 'insert the link and keep MP4 selected as the output format.' },
      { title: 'Prepare the video', body: 'start conversion and wait while the compatible video stream is processed.' },
      { title: 'Download the MP4', body: 'review the result details and save the file to your device.' }
    ],
    benefitsHeading: 'MP4 quality, compatibility, and file size',
    benefits: [
      { icon: 'MP4', title: 'Broad playback support', body: 'MP4 works in common browsers, mobile devices, computers, editors, and smart displays.' },
      { icon: 'SOURCE', title: 'Source-based quality', body: 'The converter uses a compatible MP4 stream supplied by the source; it does not invent missing resolution.' },
      { icon: 'SIZE', title: 'Video-sized downloads', body: 'MP4 files include video and audio, so expect larger downloads than MP3, WAV, FLAC, or OGG.' },
      { icon: 'WEB', title: 'Browser workflow', body: 'Paste, process, and download without installing a separate desktop converter.' }
    ],
    relatedTools: [
      { href: '/mp4-converter/url-to-mp4/', label: 'URL to MP4', description: 'Convert another supported video link to MP4.' },
      { href: '/mp3-converter/youtube-to-mp3/', label: 'YouTube to MP3', description: 'Extract a compact audio file when video is not needed.' },
      { href: '/wav-converter/youtube-to-wav/', label: 'YouTube to WAV', description: 'Create an uncompressed audio file for editing workflows.' }
    ],
    faqHeading: 'YouTube to MP4 questions',
    faqItems: [
      { question: 'How do I convert YouTube to MP4?', answer: 'Paste a supported public YouTube URL into the converter, keep MP4 selected, start processing, and download the prepared video file.' },
      { question: 'Can I download 1080p or 4K MP4?', answer: 'Resolution depends on the compatible MP4 stream available from the source. Some high-resolution videos separate audio and video, so the available result may be lower than the source maximum.' },
      { question: 'Why did the YouTube link fail?', answer: 'Check that the full URL is valid and publicly reachable. Removed, private, region-restricted, live, or temporarily unavailable videos may not process.' },
      { question: 'Which browsers support the MP4 converter?', answer: 'Current versions of Chrome, Edge, Firefox, and Safari can use the page. Download handling and playback support can vary by device and browser settings.' }
    ],
    genericUrl: false,
    inputMode: 'url',
    defaultFormat: 'mp4'
  });
});

app.get('/mp4-converter/url-to-mp4/', (req, res) => {
  renderPage(res, 'seo-converter-page', {
    lang: 'en',
    title: 'URL to MP4 Converter – Video Links | ConveTube',
    description: 'Convert a supported video URL to MP4 online with a focused browser tool. Learn which links work, how quality affects file size, and how to fix common URL errors.',
    canonical: 'https://convetube.com/mp4-converter/url-to-mp4/',
    applicationName: 'ConveTube URL to MP4 Converter',
    applicationCategory: 'MultimediaApplication',
    featureList: ['URL to MP4 conversion', 'Compatible video-link input', 'Browser-based MP4 download'],
    keyword: 'url to mp4',
    heading: 'URL to',
    headingAccent: 'MP4 Converter',
    heroSubtitle: 'Paste a supported video URL and prepare a compatible MP4 file in your browser.',
    breadcrumbItems: [{ label: 'Home', href: '/' }, { label: 'MP4 Converter', href: '/mp4-converter/url-to-mp4/' }, { label: 'URL to MP4' }],
    introHeading: 'Convert a URL to MP4 online',
    introParagraphs: [
      'This <strong>URL to MP4</strong> page provides a direct link-first workflow. Paste a supported HTTP or HTTPS video address, let ConveTube inspect the source, and download the compatible MP4 result.',
      'A webpage address is not always a direct video source. Public availability, site support, stream format, duration, and network conditions can all affect whether the link can be processed.'
    ],
    stepsHeading: 'How to convert a URL to MP4',
    steps: [
      { title: 'Copy the video URL', body: 'copy the complete HTTP or HTTPS link from the supported source page.' },
      { title: 'Paste the link', body: 'add it to the tool above with MP4 selected.' },
      { title: 'Start conversion', body: 'allow the converter to inspect and prepare a compatible video stream.' },
      { title: 'Save the MP4', body: 'download the prepared file after the result appears.' }
    ],
    benefitsHeading: 'Supported links, resolution, and file size',
    benefits: [
      { icon: 'URL', title: 'Link-first input', body: 'Begin with a supported video page URL instead of uploading a large local file.' },
      { icon: 'MP4', title: 'Compatible output', body: 'MP4 is a practical format for browsers, mobile devices, presentation tools, and editors.' },
      { icon: 'QUALITY', title: 'Source-defined resolution', body: 'The available quality depends on the video stream exposed by the source URL.' },
      { icon: 'CHECK', title: 'Clear troubleshooting', body: 'A complete public link works better than a shortened, private, expired, or access-restricted address.' }
    ],
    relatedTools: [
      { href: '/mp4-converter/youtube-to-mp4/', label: 'YouTube to MP4', description: 'Use the dedicated converter for a YouTube video URL.' },
      { href: '/', label: 'URL to MP3', description: 'Convert a supported video URL to an audio-only MP3.' },
      { href: '/mp3-converter/video-to-mp3/', label: 'Video to MP3', description: 'Extract audio when you do not need the video track.' }
    ],
    faqHeading: 'URL to MP4 questions',
    faqItems: [
      { question: 'How do I convert a URL to MP4?', answer: 'Paste a complete supported video URL into the tool, select MP4, start conversion, and download the resulting video file.' },
      { question: 'What resolution can I choose?', answer: 'The tool prepares a compatible MP4 stream supplied by the source. Resolution options vary by site and video, and the source maximum may not be available as one MP4 stream.' },
      { question: 'Why is my URL unsupported?', answer: 'The address may be private, expired, restricted, unavailable, or hosted by a site the converter cannot read. Confirm that the full public URL opens in your browser and retry.' },
      { question: 'Can I use the converter on mobile?', answer: 'Yes. The page works in current mobile browsers, although long videos and large MP4 downloads may need more time, storage, and a stable connection.' }
    ],
    genericUrl: true,
    inputMode: 'url',
    defaultFormat: 'mp4'
  });
});

app.get('/mp3-converter/m4a-to-mp3-online/', (req, res) => {
  renderPage(res, 'seo-converter-page', {
    lang: 'en',
    title: 'M4A to MP3 Online Converter | ConveTube',
    description: 'Use the M4A to MP3 online converter for a local audio file up to 100 MB. Get practical 320 kbps, file-size, compatibility, and batch-conversion guidance.',
    canonical: 'https://convetube.com/mp3-converter/m4a-to-mp3-online/',
    applicationName: 'ConveTube M4A to MP3 Online Converter',
    applicationCategory: 'MultimediaApplication',
    featureList: ['M4A file to MP3 conversion', '320 kbps MP3 output', 'Browser-based local file upload and download'],
    keyword: 'm4a to mp3 online',
    heading: 'M4A to MP3',
    headingAccent: 'Online Converter',
    heroSubtitle: 'Choose an M4A audio file and convert it to a broadly compatible MP3 from your browser.',
    breadcrumbItems: [{ label: 'Home', href: '/' }, { label: 'MP3 Converter', href: '/mp3-converter/m4a-to-mp3-online/' }, { label: 'M4A to MP3 Online' }],
    introHeading: 'Convert M4A to MP3 online',
    introParagraphs: [
      'Use this <strong>M4A to MP3 online</strong> tool to turn one local M4A audio file into an MP3. Choose a file up to 100 MB, start the conversion, preview the result, and save it without installing a desktop application.',
      'MP3 usually offers broader compatibility than M4A across older players, car stereos, presentation software, and editing tools. Transcoding does not improve the original recording, and file size depends on duration and source characteristics.'
    ],
    stepsHeading: 'How to convert M4A to MP3 online',
    steps: [
      { title: 'Choose an M4A file', body: 'select one local .m4a audio file no larger than 100 MB.' },
      { title: 'Start conversion', body: 'submit the file and keep this browser tab open while it is processed.' },
      { title: 'Preview the MP3', body: 'listen to the converted result before saving it.' },
      { title: 'Download the file', body: 'save the MP3 to your phone, tablet, or computer.' }
    ],
    benefitsHeading: 'MP3 quality, limits, and compatibility',
    benefits: [
      { icon: '320K', title: '320 kbps output', body: 'The converter encodes the MP3 at 320 kbps while preserving the quality available in the source.' },
      { icon: '100MB', title: 'Clear upload limit', body: 'Each conversion accepts one M4A file up to 100 MB.' },
      { icon: 'MP3', title: 'Broad compatibility', body: 'MP3 plays in common browsers, phones, computers, vehicles, editors, and media players.' },
      { icon: 'ONE', title: 'One file at a time', body: 'For multiple files, convert each item separately and verify every result before deleting the originals.' }
    ],
    relatedTools: [
      { href: '/mp3-converter/youtube-to-mp3/', label: 'YouTube to MP3', description: 'Convert a supported YouTube link to MP3.' },
      { href: '/mp3-converter/video-to-mp3/', label: 'Video to MP3', description: 'Extract audio from a supported video URL.' },
      { href: '/', label: 'URL to MP3', description: 'Use the homepage for a general video-link-to-MP3 workflow.' }
    ],
    faqHeading: 'M4A to MP3 online questions',
    faqItems: [
      { question: 'How do I convert M4A to MP3 online?', answer: 'Choose one local M4A file up to 100 MB, start conversion, preview the result, and download the prepared MP3.' },
      { question: 'Can I convert M4A to 320 kbps MP3?', answer: 'Yes. The converter encodes a 320 kbps MP3, although transcoding cannot add detail that is missing from the original M4A audio.' },
      { question: 'Is the online converter free?', answer: 'The page provides the file conversion workflow without requiring a desktop installation or account. Standard file-size and server-capacity limits apply.' },
      { question: 'How do I convert multiple M4A files?', answer: 'Convert one file at a time. Keep the originals until you have checked playback, duration, metadata, and any quality changes in every downloaded MP3.' }
    ],
    genericUrl: false,
    inputMode: 'file',
    defaultFormat: 'mp3'
  });
});

app.get('/mp3-converter/aac-to-mp3/', (req, res) => {
  renderPage(res, 'seo-converter-page', {
    lang: 'en',
    title: 'AAC to MP3 Converter Online | ConveTube',
    description: 'Convert AAC to MP3 online from a local file up to 100 MB. Create a 320 kbps MP3 and learn about compatibility, source quality, and common conversion errors.',
    canonical: 'https://convetube.com/mp3-converter/aac-to-mp3/',
    applicationName: 'ConveTube AAC to MP3 Converter',
    applicationCategory: 'MultimediaApplication',
    featureList: ['AAC file to MP3 conversion', '320 kbps MP3 output', 'Browser-based file upload and download'],
    keyword: 'aac to mp3',
    heading: 'AAC to MP3',
    headingAccent: 'Converter',
    heroSubtitle: 'Choose an AAC audio file and create a broadly compatible MP3 from your browser.',
    breadcrumbItems: [{ label: 'Home', href: '/' }, { label: 'MP3 Converter', href: '/mp3-converter/aac-to-mp3/' }, { label: 'AAC to MP3' }],
    introHeading: 'Convert an AAC audio file to MP3',
    introParagraphs: [
      'Use this <strong>AAC to MP3</strong> tool when an app, player, editor, or device does not accept your AAC file. Choose one local file up to 100 MB, start the conversion, preview the result, and download the MP3.',
      'AAC and MP3 are both lossy audio formats. Transcoding changes the container and codec compatibility but does not restore detail missing from the source, so keep the original file until you have checked the result.'
    ],
    stepsHeading: 'How to change AAC audio into MP3',
    steps: [
      { title: 'Choose an AAC file', body: 'select one local .aac file no larger than 100 MB.' },
      { title: 'Start the conversion', body: 'submit the file and keep this browser tab open while it is processed.' },
      { title: 'Preview the result', body: 'listen to the prepared MP3 and check its duration before saving.' },
      { title: 'Download MP3', body: 'save the converted audio to your phone, tablet, or computer.' }
    ],
    benefitsHeading: 'AAC compatibility, output quality, and limits',
    benefits: [
      { icon: 'AAC', title: 'Focused file input', body: 'The first-screen tool accepts one AAC audio file per conversion.' },
      { icon: '320K', title: 'Practical MP3 output', body: 'The converter encodes a 320 kbps MP3 while retaining only the detail present in the source.' },
      { icon: 'MP3', title: 'Broad playback support', body: 'MP3 works with common phones, computers, vehicles, editors, browsers, and media players.' },
      { icon: '100MB', title: 'Clear upload limit', body: 'Each conversion accepts one non-empty AAC file up to 100 MB.' }
    ],
    relatedTools: [
      { href: '/mp3-converter/flac-to-mp3/', label: 'FLAC File Converter', description: 'Create a smaller MP3 from a local lossless audio file.' },
      { href: '/mp3-converter/m4a-to-mp3-online/', label: 'M4A File Converter', description: 'Prepare an MP3 from an M4A audio file.' },
      { href: '/mp3-converter/mkv-to-mp3/', label: 'MKV Audio Extractor', description: 'Extract an MP3 audio track from an MKV video file.' }
    ],
    faqHeading: 'AAC file conversion questions',
    faqItems: [
      { question: 'How does this AAC file converter work?', answer: 'Choose one local AAC file up to 100 MB, start conversion, preview the prepared audio, and download the MP3 result.' },
      { question: 'Does converting AAC improve audio quality?', answer: 'No. Encoding a new MP3 cannot add detail that is absent from the AAC source and may introduce a small additional quality loss.' },
      { question: 'Why use MP3 instead of AAC?', answer: 'MP3 can be easier to play in older car stereos, hardware players, editors, presentation tools, and software with limited AAC support.' },
      { question: 'Why did my AAC file fail?', answer: 'Confirm that the file is non-empty, uses the .aac extension, is no larger than 100 MB, and contains a readable audio stream. Damaged or mislabeled files may fail.' }
    ],
    genericUrl: false,
    inputMode: 'file',
    inputFormat: 'aac',
    defaultFormat: 'mp3'
  });
});

app.get('/mp3-converter/flac-to-mp3/', (req, res) => {
  renderPage(res, 'seo-converter-page', {
    lang: 'en',
    title: 'FLAC to MP3 Converter Online | ConveTube',
    description: 'Convert FLAC to MP3 online from a local file up to 100 MB. Reduce storage needs with a 320 kbps MP3 while understanding quality, metadata, and playback.',
    canonical: 'https://convetube.com/mp3-converter/flac-to-mp3/',
    applicationName: 'ConveTube FLAC to MP3 Converter',
    applicationCategory: 'MultimediaApplication',
    featureList: ['FLAC file to MP3 conversion', '320 kbps MP3 output', 'Browser-based file upload and download'],
    keyword: 'flac to mp3',
    heading: 'FLAC to MP3',
    headingAccent: 'Converter',
    heroSubtitle: 'Choose a FLAC audio file and make a smaller MP3 for everyday playback.',
    breadcrumbItems: [{ label: 'Home', href: '/' }, { label: 'MP3 Converter', href: '/mp3-converter/flac-to-mp3/' }, { label: 'FLAC to MP3' }],
    introHeading: 'Make a compact MP3 from a FLAC file',
    introParagraphs: [
      'Use this <strong>FLAC to MP3</strong> tool when you need a smaller audio file or wider device support. Choose one local FLAC file up to 100 MB, convert it in the browser, preview the MP3, and save the result.',
      'FLAC preserves the source audio without lossy compression, while MP3 trades some detail for smaller files. Keep the FLAC original for archiving or editing and use the MP3 as a convenient listening copy.'
    ],
    stepsHeading: 'How to prepare an MP3 from FLAC',
    steps: [
      { title: 'Choose a FLAC file', body: 'select one local .flac audio file no larger than 100 MB.' },
      { title: 'Convert the audio', body: 'start processing and leave this browser tab open until it finishes.' },
      { title: 'Check the MP3', body: 'preview the audio and verify its playback and duration.' },
      { title: 'Save the result', body: 'download the MP3 while keeping the original FLAC as your lossless copy.' }
    ],
    benefitsHeading: 'FLAC source quality, MP3 size, and metadata',
    benefits: [
      { icon: 'FLAC', title: 'Lossless source input', body: 'Begin with a FLAC file that preserves the audio data available in the original source.' },
      { icon: 'SIZE', title: 'Smaller listening copy', body: 'MP3 generally uses much less storage than FLAC for the same recording duration.' },
      { icon: '320K', title: '320 kbps encoding', body: 'The converter creates a high-bitrate MP3 suited to broad everyday playback.' },
      { icon: 'META', title: 'Verify file details', body: 'Check title, artwork, tags, duration, and gapless playback because metadata behavior can vary after transcoding.' }
    ],
    relatedTools: [
      { href: '/flac-converter/youtube-to-flac/', label: 'YouTube to FLAC', description: 'Prepare lossless-format audio from a supported YouTube link.' },
      { href: '/mp3-converter/aac-to-mp3/', label: 'AAC File Converter', description: 'Create a compatible MP3 from an AAC audio file.' },
      { href: '/mp3-converter/m4a-to-mp3-online/', label: 'M4A File Converter', description: 'Convert one M4A audio file in the browser.' }
    ],
    faqHeading: 'FLAC file conversion questions',
    faqItems: [
      { question: 'How does this FLAC file converter work?', answer: 'Choose a local FLAC file up to 100 MB, start the conversion, preview the new audio, and download the prepared MP3.' },
      { question: 'Will the MP3 sound identical to FLAC?', answer: 'Not exactly. MP3 uses lossy compression, so the result is smaller but does not preserve every bit of the lossless FLAC source.' },
      { question: 'Should I delete the FLAC after conversion?', answer: 'Keep the FLAC if you value a lossless archive or expect to edit or re-encode the recording later. Use the MP3 as a portable copy.' },
      { question: 'Will FLAC metadata transfer to MP3?', answer: 'Some metadata may be retained or rewritten, but tags and artwork can differ between formats. Verify the downloaded file in your preferred library before removing anything.' }
    ],
    genericUrl: false,
    inputMode: 'file',
    inputFormat: 'flac',
    defaultFormat: 'mp3'
  });
});

app.get('/mp3-converter/mkv-to-mp3/', (req, res) => {
  renderPage(res, 'seo-converter-page', {
    lang: 'en',
    title: 'MKV to MP3 Audio Converter | ConveTube',
    description: 'Convert MKV to MP3 from a local video up to 100 MB. Extract the available audio track as a 320 kbps MP3 and review track selection, quality, and errors.',
    canonical: 'https://convetube.com/mp3-converter/mkv-to-mp3/',
    applicationName: 'ConveTube MKV to MP3 Audio Converter',
    applicationCategory: 'MultimediaApplication',
    featureList: ['MKV audio extraction to MP3', '320 kbps MP3 output', 'Browser-based file upload and download'],
    keyword: 'mkv to mp3',
    heading: 'MKV to MP3',
    headingAccent: 'Audio Converter',
    heroSubtitle: 'Choose an MKV video and extract its available audio track as a portable MP3.',
    breadcrumbItems: [{ label: 'Home', href: '/' }, { label: 'MP3 Converter', href: '/mp3-converter/mkv-to-mp3/' }, { label: 'MKV to MP3' }],
    introHeading: 'Extract an MP3 audio track from MKV',
    introParagraphs: [
      'Use this <strong>MKV to MP3</strong> tool when you need the sound from a local Matroska video without keeping the picture. Choose one MKV file up to 100 MB, start processing, preview the extracted audio, and download the MP3.',
      'An MKV container can hold video, audio, subtitles, and multiple tracks. The converter uses the first readable audio stream, so files with several languages or commentary tracks should be checked after conversion.'
    ],
    stepsHeading: 'How to extract MP3 audio from MKV',
    steps: [
      { title: 'Choose an MKV video', body: 'select one local .mkv file no larger than 100 MB.' },
      { title: 'Start extraction', body: 'submit the file and keep the browser tab open during processing.' },
      { title: 'Preview the audio', body: 'listen to the MP3 and confirm that the intended track was selected.' },
      { title: 'Download MP3', body: 'save the extracted audio file to your device.' }
    ],
    benefitsHeading: 'MKV tracks, MP3 output, and file limits',
    benefits: [
      { icon: 'MKV', title: 'Video-container input', body: 'The tool reads a local MKV container and prepares audio without including the video track.' },
      { icon: 'TRACK', title: 'Check track selection', body: 'Files with multiple audio streams may default to the first readable track, so preview the result.' },
      { icon: 'MP3', title: 'Portable audio output', body: 'The extracted track is encoded as a 320 kbps MP3 for broad playback support.' },
      { icon: '100MB', title: 'One file up to 100 MB', body: 'Large or long MKV videos may exceed the browser upload limit and need a local desktop workflow.' }
    ],
    relatedTools: [
      { href: '/mp3-converter/video-to-mp3/', label: 'Video Link to MP3', description: 'Extract audio from a supported online video URL.' },
      { href: '/mp3-converter/aac-to-mp3/', label: 'AAC File Converter', description: 'Prepare a compatible MP3 from an AAC file.' },
      { href: '/mp3-converter/m4a-to-mp3-online/', label: 'M4A File Converter', description: 'Convert a local M4A audio file to MP3.' }
    ],
    faqHeading: 'MKV audio extraction questions',
    faqItems: [
      { question: 'How does this MKV audio extractor work?', answer: 'Choose one local MKV file up to 100 MB, start processing, preview the extracted track, and download the MP3 result.' },
      { question: 'Does the MP3 include the video?', answer: 'No. MP3 is an audio-only format, so the downloaded result contains the selected audio stream without the MKV video or subtitles.' },
      { question: 'Which audio track is extracted?', answer: 'The conversion pipeline uses the first readable audio stream. Preview the result when the MKV contains multiple languages, commentary, or alternate mixes.' },
      { question: 'Why did my MKV conversion fail?', answer: 'The file may exceed 100 MB, be damaged, use an unreadable audio codec, contain no audio stream, or carry an extension that does not match its contents.' }
    ],
    genericUrl: false,
    inputMode: 'file',
    inputFormat: 'mkv',
    defaultFormat: 'mp3'
  });
});

const renderLocalConversionPage = (res, page) => {
  renderPage(res, 'seo-converter-page', {
    lang: 'en',
    applicationCategory: 'MultimediaApplication',
    ...page,
    genericUrl: false,
    inputMode: 'file'
  });
};

app.get('/flac-converter/mp3-to-flac/', (req, res) => {
  renderLocalConversionPage(res, {
    title: 'MP3 to FLAC Converter Online – Audio Format Guide | ConveTube',
    description: 'Convert an MP3 file to FLAC online from your browser. Create a lossless-format copy, compare file size and quality, and download the result up to 100 MB.',
    canonical: 'https://convetube.com/flac-converter/mp3-to-flac/',
    applicationName: 'ConveTube MP3 to FLAC Converter',
    featureList: ['MP3 file to FLAC conversion', 'Browser-based local file processing', 'FLAC output with source-quality guidance'],
    keyword: 'mp3 to flac',
    heading: 'MP3 to',
    headingAccent: 'FLAC Converter',
    heroSubtitle: 'Create a FLAC copy from a local MP3 file and understand what the format change means for audio quality.',
    breadcrumbItems: [{ label: 'Home', href: '/' }, { label: 'MP3 to FLAC' }],
    introHeading: 'Convert an MP3 file to FLAC',
    introParagraphs: [
      'Use this <strong>MP3 to FLAC</strong> converter when a workflow requires a FLAC container or a lossless-format file. Choose one local MP3 up to 100 MB, run the conversion in the first-screen tool, preview the result, and download the FLAC copy.',
      'Converting MP3 to FLAC does not restore detail already removed by MP3 compression. The output can be useful for format compatibility or a consistent archive, but keep the original MP3 and prefer a lossless source when you need editing headroom.'
    ],
    stepsHeading: 'How to convert MP3 to FLAC',
    steps: [
      { title: 'Choose an MP3 file', body: 'select one local .mp3 file that is non-empty and no larger than 100 MB.' },
      { title: 'Start the conversion', body: 'submit the file and keep the browser tab open while the FLAC copy is prepared.' },
      { title: 'Preview the result', body: 'listen to the converted audio and compare its duration with the original MP3.' },
      { title: 'Download FLAC', body: 'save the FLAC file for a compatible editor, library, or format-specific workflow.' }
    ],
    benefitsHeading: 'MP3 input, FLAC output, and quality notes',
    benefits: [
      { icon: 'MP3', title: 'Simple MP3 input', body: 'The first-screen tool accepts one local MP3 file per conversion.' },
      { icon: 'FLAC', title: 'Lossless-format output', body: 'FLAC uses lossless encoding, but it cannot recreate detail that was absent from the MP3 source.' },
      { icon: 'CHECK', title: 'Preview before saving', body: 'Check playback and duration before adding the converted file to another library or project.' },
      { icon: '100MB', title: 'One file up to 100 MB', body: 'Large files may exceed the browser upload limit and may need to be processed locally.' }
    ],
    relatedTools: [
      { href: '/mp3-converter/flac-to-mp3/', label: 'FLAC to MP3', description: 'Create a compact MP3 from a local FLAC file.' },
      { href: '/flac-converter/youtube-to-flac/', label: 'YouTube to FLAC', description: 'Prepare FLAC audio from a supported video link.' },
      { href: '/mp3-converter/aac-to-mp3/', label: 'AAC to MP3', description: 'Convert another common audio file to MP3.' }
    ],
    faqHeading: 'MP3 to FLAC questions',
    faqItems: [
      { question: 'How do I convert MP3 to FLAC?', answer: 'Choose one local MP3 file up to 100 MB, start the conversion, preview the result, and download the FLAC copy.' },
      { question: 'Does MP3 to FLAC improve audio quality?', answer: 'No. FLAC preserves the converted signal without additional lossy compression, but it cannot restore detail already removed by the MP3 source.' },
      { question: 'Why is the FLAC file larger than the MP3?', answer: 'FLAC is lossless and usually needs more storage than a compressed MP3, even when both contain the same audible source material.' },
      { question: 'Why did my MP3 to FLAC conversion fail?', answer: 'The file may exceed 100 MB, be damaged, contain an unsupported encoding, or use an extension that does not match its contents.' }
    ],
    inputFormat: 'mp3',
    defaultFormat: 'flac'
  });
});

app.get('/m4a-converter/mp3-to-m4a/', (req, res) => {
  renderLocalConversionPage(res, {
    title: 'MP3 to M4A Converter Online – Convert Audio Files | ConveTube',
    description: 'Convert an MP3 file to M4A online in your browser. Create an AAC-based M4A copy, review compatibility and quality trade-offs, and download it up to 100 MB.',
    canonical: 'https://convetube.com/m4a-converter/mp3-to-m4a/',
    applicationName: 'ConveTube MP3 to M4A Converter',
    featureList: ['MP3 file to M4A conversion', 'AAC-based M4A output', 'Browser-based local file processing up to 100 MB'],
    keyword: 'mp3 to m4a',
    heading: 'MP3 to',
    headingAccent: 'M4A Converter',
    heroSubtitle: 'Convert a local MP3 file to an AAC-based M4A copy for compatible libraries, devices, and media workflows.',
    breadcrumbItems: [{ label: 'Home', href: '/' }, { label: 'MP3 to M4A' }],
    introHeading: 'Convert MP3 to M4A online',
    introParagraphs: [
      'This <strong>MP3 to M4A</strong> tool creates an M4A audio file from one local MP3. Choose a file up to 100 MB, start the conversion in the browser, preview the result, and download it when the file is ready.',
      'M4A commonly uses AAC audio in an MP4-based container. The conversion changes the format and may involve another lossy encode, so keep the original MP3 and compare the result before replacing your source file.'
    ],
    stepsHeading: 'How to convert MP3 to M4A',
    steps: [
      { title: 'Choose an MP3 file', body: 'select one local .mp3 file that is non-empty and no larger than 100 MB.' },
      { title: 'Convert to M4A', body: 'submit the file and wait while the browser prepares an AAC-based M4A copy.' },
      { title: 'Check compatibility', body: 'preview the output and confirm that the duration and playback match the intended workflow.' },
      { title: 'Download the M4A', body: 'save the converted file for a supported phone, media library, editor, or player.' }
    ],
    benefitsHeading: 'M4A format, compatibility, and quality',
    benefits: [
      { icon: 'MP3', title: 'Local MP3 input', body: 'The first-screen tool accepts one MP3 file per conversion and keeps the workflow simple.' },
      { icon: 'M4A', title: 'AAC-based output', body: 'The M4A result is designed for devices and libraries that support the MP4 audio container.' },
      { icon: 'CHECK', title: 'Preview before saving', body: 'Listen to the result and check duration before adding it to a music or editing workflow.' },
      { icon: '100MB', title: 'One file up to 100 MB', body: 'Long recordings may need to be split locally if they exceed the browser upload limit.' }
    ],
    relatedTools: [
      { href: '/mp3-converter/m4a-to-mp3-online/', label: 'M4A to MP3 Online', description: 'Convert a local M4A file to a widely compatible MP3.' },
      { href: '/mp3-converter/video-to-mp3/', label: 'Video to MP3', description: 'Extract audio from a supported online video URL.' },
      { href: '/mp3-converter/flac-to-mp3/', label: 'FLAC to MP3', description: 'Create a smaller MP3 from a lossless audio source.' }
    ],
    faqHeading: 'MP3 to M4A questions',
    faqItems: [
      { question: 'How do I convert MP3 to M4A?', answer: 'Choose one local MP3 file up to 100 MB, start the conversion, preview the M4A result, and download it from the browser.' },
      { question: 'Is M4A smaller than MP3?', answer: 'File size depends on bitrate, duration, and encoder settings. M4A can be efficient, but a new conversion should be compared with the original file.' },
      { question: 'Which devices support M4A?', answer: 'Many modern phones, computers, browsers, music apps, and media libraries support AAC-based M4A, but check the requirements of your target device or editor.' },
      { question: 'Will MP3 metadata be preserved?', answer: 'Metadata support depends on the source and conversion pipeline. Keep the original MP3 and verify title, artwork, and other tags after downloading.' }
    ],
    inputFormat: 'mp3',
    defaultFormat: 'm4a'
  });
});

app.get('/flac-converter/mp4-to-flac/', (req, res) => {
  renderLocalConversionPage(res, {
    title: 'MP4 to FLAC Converter Online – Extract Audio | ConveTube',
    description: 'Convert an MP4 video to FLAC online from a local file. Extract its readable audio, keep lossless FLAC output, preview the result, and download up to 100 MB.',
    canonical: 'https://convetube.com/flac-converter/mp4-to-flac/',
    applicationName: 'ConveTube MP4 to FLAC Converter',
    featureList: ['MP4 video to FLAC audio extraction', 'Lossless FLAC output', 'Browser-based local file conversion up to 100 MB'],
    keyword: 'mp4 to flac',
    heading: 'MP4 to',
    headingAccent: 'FLAC Converter',
    heroSubtitle: 'Extract the readable audio from a local MP4 video and save it as a FLAC file for compatible audio workflows.',
    breadcrumbItems: [{ label: 'Home', href: '/' }, { label: 'MP4 to FLAC' }],
    introHeading: 'Extract audio from MP4 to FLAC',
    introParagraphs: [
      'Use this <strong>MP4 to FLAC</strong> converter when you need audio from a local video without keeping its picture. Choose one MP4 file up to 100 MB, extract the readable audio with the first-screen tool, preview the FLAC result, and download it.',
      'FLAC uses lossless encoding for the extracted signal, but it cannot recover information that was absent from the source audio. Keep the original MP4 for visual context and check the selected audio track when the file contains multiple streams.'
    ],
    stepsHeading: 'How to convert MP4 to FLAC',
    steps: [
      { title: 'Choose an MP4 video', body: 'select one local .mp4 file that is non-empty and no larger than 100 MB.' },
      { title: 'Extract the audio', body: 'submit the video and wait while the readable audio track is encoded as FLAC.' },
      { title: 'Review the track', body: 'preview the result and check duration, language, and playback when multiple streams are present.' },
      { title: 'Download FLAC', body: 'save the audio-only file for editing, archiving, or another format-specific workflow.' }
    ],
    benefitsHeading: 'MP4 input, FLAC output, and track details',
    benefits: [
      { icon: 'MP4', title: 'Video-file input', body: 'The first-screen tool accepts one local MP4 video per conversion.' },
      { icon: 'FLAC', title: 'Audio-only output', body: 'The downloaded FLAC contains the readable audio stream without the MP4 picture.' },
      { icon: 'TRACK', title: 'Review the selected stream', body: 'Preview the result when the source contains multiple languages, commentary, or alternate mixes.' },
      { icon: '100MB', title: 'One file up to 100 MB', body: 'Large or long videos may need to be split locally before browser upload.' }
    ],
    relatedTools: [
      { href: '/mp4-converter/mkv-to-mp4/', label: 'MKV to MP4', description: 'Create a broadly compatible video copy from an MKV file.' },
      { href: '/mp3-converter/mp4-to-mp3/', label: 'MP4 to MP3', description: 'Extract a compact MP3 audio copy from a local MP4.' },
      { href: '/flac-converter/youtube-to-flac/', label: 'YouTube to FLAC', description: 'Prepare FLAC audio from a supported video link.' }
    ],
    faqHeading: 'MP4 to FLAC questions',
    faqItems: [
      { question: 'How do I convert MP4 to FLAC?', answer: 'Choose one local MP4 file up to 100 MB, start the conversion, preview the extracted audio, and download the FLAC result.' },
      { question: 'Does MP4 to FLAC keep the video?', answer: 'No. FLAC is an audio format, so the downloaded file contains the readable audio stream without the MP4 picture.' },
      { question: 'Which audio track is extracted?', answer: 'The conversion pipeline uses the first readable audio stream. Preview the result when the MP4 contains multiple languages, commentary, or alternate mixes.' },
      { question: 'Why did my MP4 to FLAC conversion fail?', answer: 'The file may exceed 100 MB, be damaged, contain no readable audio stream, use an unsupported codec, or have an extension that does not match its contents.' }
    ],
    inputFormat: 'mp4',
    defaultFormat: 'flac'
  });
});

app.get('/mp3-converter/mov-to-mp3/', (req, res) => {
  renderLocalConversionPage(res, {
    title: 'MOV to MP3 Converter Online | ConveTube',
    description: 'Convert MOV to MP3 online from a local QuickTime video up to 100 MB. Extract the audio track, preview the result, and download a compatible MP3.',
    canonical: 'https://convetube.com/mp3-converter/mov-to-mp3/',
    applicationName: 'ConveTube MOV to MP3 Converter',
    featureList: ['MOV video to MP3 audio extraction', '320 kbps MP3 output', 'Browser-based local file conversion'],
    keyword: 'mov to mp3',
    heading: 'MOV to MP3',
    headingAccent: 'Converter',
    heroSubtitle: 'Choose a MOV video and extract its audio as a portable MP3 in your browser.',
    breadcrumbItems: [{ label: 'Home', href: '/' }, { label: 'MP3 Converter', href: '/mp3-converter/mov-to-mp3/' }, { label: 'MOV to MP3' }],
    introHeading: 'Convert a MOV video to MP3',
    introParagraphs: [
      'Use this <strong>MOV to MP3</strong> tool when you need the sound from a local QuickTime video without keeping the picture. Choose one MOV file up to 100 MB, start the conversion, preview the audio, and download the MP3.',
      'MOV files can contain video, audio, and multiple tracks. MP3 keeps the audio track only and is easier to play in common phones, cars, browsers, editors, and media players. Keep the original MOV until you have checked the downloaded file.'
    ],
    stepsHeading: 'How to convert MOV to MP3',
    steps: [
      { title: 'Choose a MOV file', body: 'select one local .mov video no larger than 100 MB.' },
      { title: 'Start conversion', body: 'submit the file and keep this browser tab open while the audio is extracted.' },
      { title: 'Preview the MP3', body: 'listen to the result and check that the expected audio track and duration are present.' },
      { title: 'Download the audio', body: 'save the MP3 to your phone, computer, editing app, or media library.' }
    ],
    benefitsHeading: 'MOV input, MP3 output, and compatibility',
    benefits: [
      { icon: 'MOV', title: 'QuickTime video input', body: 'The first-screen tool accepts one local MOV file per conversion.' },
      { icon: 'MP3', title: 'Audio-only result', body: 'The converter removes the video track and creates a 320 kbps MP3 for broad playback.' },
      { icon: '100MB', title: 'Clear file limit', body: 'Each upload must be non-empty and no larger than 100 MB.' },
      { icon: 'CHECK', title: 'Preview before saving', body: 'Check duration and playback because MOV containers may include more than one audio track.' }
    ],
    relatedTools: [
      { href: '/mp3-converter/mkv-to-mp3/', label: 'MKV to MP3', description: 'Extract audio from a local Matroska video.' },
      { href: '/mp4-converter/mov-to-mp4/', label: 'MOV to MP4', description: 'Create a more broadly compatible video file from MOV.' },
      { href: '/mp3-converter/video-to-mp3/', label: 'Video to MP3', description: 'Convert a supported online video URL to MP3.' }
    ],
    faqHeading: 'MOV to MP3 questions',
    faqItems: [
      { question: 'How do I convert MOV to MP3?', answer: 'Choose one local MOV file up to 100 MB, start conversion, preview the extracted audio, and download the MP3 result.' },
      { question: 'Does MOV to MP3 keep the video?', answer: 'No. MP3 is an audio-only format, so the downloaded file contains the readable audio track without the MOV picture.' },
      { question: 'Can I convert an iPhone MOV video?', answer: 'Yes, if the local MOV file is non-empty, readable, and no larger than 100 MB. Keep the original until playback is confirmed.' },
      { question: 'Why did my MOV conversion fail?', answer: 'The file may exceed 100 MB, be damaged, contain no readable audio stream, or use an extension that does not match its contents.' }
    ],
    inputFormat: 'mov',
    defaultFormat: 'mp3'
  });
});

app.get('/mp3-converter/mp4-to-mp3/', (req, res) => {
  renderLocalConversionPage(res, {
    title: 'Convert MP4 to MP3 Online – Extract Audio | ConveTube',
    description: 'Convert an MP4 video to MP3 online from a local file up to 100 MB. Extract the audio track, preview the result, and download a compact MP3.',
    canonical: 'https://convetube.com/mp3-converter/mp4-to-mp3/',
    applicationName: 'ConveTube MP4 to MP3 Converter',
    featureList: ['MP4 video to MP3 audio extraction', '320 kbps MP3 output', 'Browser-based local file conversion'],
    keyword: 'mp4 to mp3',
    heading: 'MP4 to MP3',
    headingAccent: 'Audio Extractor',
    heroSubtitle: 'Choose an MP4 video and extract its audio as a portable MP3 in your browser.',
    breadcrumbItems: [{ label: 'Home', href: '/' }, { label: 'MP3 Converter', href: '/mp3-converter/mp4-to-mp3/' }, { label: 'MP4 to MP3' }],
    introHeading: 'Extract audio from an MP4 video',
    introParagraphs: [
      'Use this <strong>MP4 to MP3</strong> tool when you need the audio from a local video without keeping the picture. Choose one MP4 file up to 100 MB, start processing, preview the extracted track, and download the MP3.',
      'MP4 can contain video, audio, captions, and metadata. MP3 keeps the readable audio stream only, which makes the result easier to play in music apps, cars, phones, editors, and other audio players. Keep the original MP4 until you have checked the downloaded file.'
    ],
    stepsHeading: 'How to convert MP4 to MP3',
    steps: [
      { title: 'Choose an MP4 video', body: 'select one local .mp4 file no larger than 100 MB.' },
      { title: 'Start audio extraction', body: 'submit the file and keep the browser tab open while the audio is prepared.' },
      { title: 'Preview the MP3', body: 'listen to the result and check its duration, volume, and expected audio track.' },
      { title: 'Download the audio', body: 'save the MP3 for listening, editing, or importing into another app.' }
    ],
    benefitsHeading: 'MP4 input, MP3 output, and file limits',
    benefits: [
      { icon: 'MP4', title: 'Video-file input', body: 'The first-screen tool accepts one local MP4 file per conversion.' },
      { icon: 'MP3', title: 'Audio-only result', body: 'The video track is removed and the readable audio is encoded as a 320 kbps MP3.' },
      { icon: 'CHECK', title: 'Preview before saving', body: 'Check playback and duration because an MP4 can contain multiple audio tracks or unusual codecs.' },
      { icon: '100MB', title: 'One file up to 100 MB', body: 'Large or long videos may exceed the browser upload limit and need a local desktop workflow.' }
    ],
    relatedTools: [
      { href: '/mp3-converter/video-to-mp3/', label: 'Video Link to MP3', description: 'Extract audio from a supported online video URL.' },
      { href: '/mp3-converter/mkv-to-mp3/', label: 'MKV to MP3', description: 'Extract audio from a local Matroska video.' },
      { href: '/mp4-converter/youtube-to-mp4/', label: 'YouTube to MP4', description: 'Prepare an MP4 from a supported YouTube link.' }
    ],
    faqHeading: 'MP4 audio extraction questions',
    faqItems: [
      { question: 'How do I convert MP4 to MP3?', answer: 'Choose one local MP4 file up to 100 MB, start conversion, preview the extracted audio, and download the MP3 result.' },
      { question: 'Does MP4 to MP3 keep the video?', answer: 'No. MP3 is an audio-only format, so the downloaded file contains the readable audio track without the MP4 picture.' },
      { question: 'Can I extract audio from an MP4 on my phone?', answer: 'Yes. Use a current mobile browser, choose an MP4 stored on the device, and keep the file within the 100 MB upload limit.' },
      { question: 'Why did my MP4 conversion fail?', answer: 'The file may exceed 100 MB, be damaged, contain no readable audio stream, use an unsupported codec, or have an extension that does not match its contents.' }
    ],
    inputFormat: 'mp4',
    defaultFormat: 'mp3'
  });
});

app.get('/mp3-converter/wav-to-mp3/', (req, res) => {
  renderLocalConversionPage(res, {
    title: 'WAV Audio to MP3 Converter – Reduce File Size Online | ConveTube',
    description: 'Convert a WAV audio file to MP3 online from a local file up to 100 MB. Review bitrate, metadata, compatibility, and the lossless original before downloading.',
    canonical: 'https://convetube.com/mp3-converter/wav-to-mp3/',
    applicationName: 'ConveTube WAV Audio to MP3 Converter',
    featureList: ['WAV audio to MP3 conversion', '320 kbps MP3 output', 'Browser-based local file conversion'],
    keyword: 'wav to mp3',
    heading: 'WAV Audio to MP3',
    headingAccent: 'Converter',
    heroSubtitle: 'Turn a WAV recording into a smaller MP3 for everyday playback and sharing.',
    breadcrumbItems: [{ label: 'Home', href: '/' }, { label: 'MP3 Converter', href: '/mp3-converter/wav-to-mp3/' }, { label: 'WAV to MP3' }],
    introHeading: 'Convert a WAV file to MP3 online',
    introParagraphs: [
      'Use this <strong>WAV to MP3</strong> converter when a lossless WAV recording is larger than you need for listening, sending, or storing. Choose one local WAV file up to 100 MB, convert it in the browser, preview the result, and download the MP3.',
      'WAV is useful for editing and archiving because it keeps uncompressed audio, while MP3 uses compression for a smaller file and broad playback support. Keep the original WAV when you may need future editing or a lossless master.'
    ],
    stepsHeading: 'How to convert WAV to MP3',
    steps: [
      { title: 'Choose a WAV file', body: 'select one local .wav recording no larger than 100 MB.' },
      { title: 'Start conversion', body: 'submit the file and keep this browser tab open while the MP3 is encoded.' },
      { title: 'Check the audio', body: 'preview the MP3 and compare its duration, channel balance, and volume with the source.' },
      { title: 'Download MP3', body: 'save the smaller audio file for playback, sharing, or compatible imports.' }
    ],
    benefitsHeading: 'WAV versus MP3 for practical audio files',
    benefits: [
      { icon: 'WAV', title: 'Lossless source', body: 'WAV keeps the source recording available for editing and future exports.' },
      { icon: 'MP3', title: 'Smaller delivery file', body: 'The converter creates a 320 kbps MP3 for easier storage and broad device support.' },
      { icon: 'META', title: 'Review metadata', body: 'Metadata transfer can vary by source and player, so check the downloaded file before cataloging it.' },
      { icon: '100MB', title: 'One file up to 100 MB', body: 'Long recordings may exceed the browser upload limit and need a local desktop workflow.' }
    ],
    relatedTools: [
      { href: '/mp3-converter/flac-to-mp3/', label: 'FLAC to MP3', description: 'Create a compact MP3 from another lossless audio format.' },
      { href: '/mp3-converter/m4a-to-mp3-online/', label: 'M4A to MP3 Online', description: 'Convert a local M4A file in the browser.' },
      { href: '/wav-converter/youtube-to-wav/', label: 'YouTube to WAV', description: 'Prepare uncompressed WAV audio from a supported video link.' }
    ],
    faqHeading: 'WAV conversion questions',
    faqItems: [
      { question: 'How do I convert WAV to MP3?', answer: 'Choose one local WAV file up to 100 MB, start conversion, preview the encoded audio, and download the MP3 result.' },
      { question: 'What happens to WAV quality after conversion?', answer: 'MP3 uses lossy compression, so it is smaller than WAV and may discard detail. Keep the WAV original when lossless editing matters.' },
      { question: 'Will WAV metadata transfer to MP3?', answer: 'Metadata transfer depends on the source and player. Check the downloaded MP3 and add tags in a music library when needed.' },
      { question: 'Why did my WAV conversion fail?', answer: 'The file may exceed 100 MB, be damaged, contain an unsupported encoding, or have an extension that does not match its contents.' }
    ],
    inputFormat: 'wav',
    defaultFormat: 'mp3'
  });
});

app.get('/mp3-converter/wma-to-mp3/', (req, res) => {
  renderLocalConversionPage(res, {
    title: 'WMA Audio to MP3 Converter – Browser File Tool | ConveTube',
    description: 'Convert a WMA audio file to MP3 online from a local file up to 100 MB. Create a compatible MP3, preview the result, and download it in your browser.',
    canonical: 'https://convetube.com/mp3-converter/wma-to-mp3/',
    applicationName: 'ConveTube WMA Audio to MP3 Converter',
    featureList: ['WMA audio to MP3 conversion', '320 kbps MP3 output', 'Browser-based local file conversion'],
    keyword: 'wma to mp3',
    heading: 'WMA Audio to MP3',
    headingAccent: 'Converter',
    heroSubtitle: 'Convert a WMA recording into a broadly compatible MP3 from your browser.',
    breadcrumbItems: [{ label: 'Home', href: '/' }, { label: 'MP3 Converter', href: '/mp3-converter/wma-to-mp3/' }, { label: 'WMA to MP3' }],
    introHeading: 'Convert WMA audio to MP3',
    introParagraphs: [
      'Use this <strong>WMA to MP3</strong> tool when a player, phone, editor, or sharing service works better with MP3. Choose one local WMA file up to 100 MB, start the browser conversion, preview the audio, and download the result.',
      'WMA files are common in older Windows media libraries, while MP3 is recognized by more current devices and applications. Conversion can change compression and metadata, so keep the original WMA until the MP3 has been checked.'
    ],
    stepsHeading: 'How to convert WMA to MP3',
    steps: [
      { title: 'Choose a WMA file', body: 'select one local .wma recording no larger than 100 MB.' },
      { title: 'Start conversion', body: 'submit the file and keep the browser tab open while the audio is processed.' },
      { title: 'Preview the MP3', body: 'listen to the output and check duration, volume, and playback on the page.' },
      { title: 'Download the result', body: 'save the MP3 for a phone, media player, editor, or sharing workflow.' }
    ],
    benefitsHeading: 'WMA input, MP3 compatibility, and limits',
    benefits: [
      { icon: 'WMA', title: 'Legacy audio input', body: 'The first-screen tool accepts one local WMA file per conversion.' },
      { icon: 'MP3', title: 'Broad playback support', body: 'The output is a 320 kbps MP3 that works with a wide range of current players and apps.' },
      { icon: 'CHECK', title: 'Preview before saving', body: 'Confirm that the readable audio track and expected duration survived the format change.' },
      { icon: '100MB', title: 'One file up to 100 MB', body: 'Large recordings may exceed the browser upload limit and need a local desktop workflow.' }
    ],
    relatedTools: [
      { href: '/mp3-converter/wav-to-mp3/', label: 'WAV to MP3', description: 'Reduce a lossless WAV recording to a smaller MP3.' },
      { href: '/mp3-converter/flac-to-mp3/', label: 'FLAC to MP3', description: 'Create a portable MP3 from a local FLAC file.' },
      { href: '/mp3-converter/m4a-to-mp3-online/', label: 'M4A to MP3 Online', description: 'Convert another common audio file in the browser.' }
    ],
    faqHeading: 'WMA conversion questions',
    faqItems: [
      { question: 'How do I convert WMA to MP3?', answer: 'Choose one local WMA file up to 100 MB, start conversion, preview the audio, and download the MP3 result.' },
      { question: 'Why convert WMA to MP3?', answer: 'MP3 is supported by more current phones, browsers, media players, editors, and sharing services than many older WMA workflows.' },
      { question: 'Does WMA to MP3 keep the original file?', answer: 'The conversion creates a new MP3 and does not replace the local WMA file. Keep the original if you may need its source quality or metadata.' },
      { question: 'Why did my WMA conversion fail?', answer: 'The file may exceed 100 MB, be damaged, use an unsupported codec or protection scheme, or have an extension that does not match its contents.' }
    ],
    inputFormat: 'wma',
    defaultFormat: 'mp3'
  });
});

app.get('/mp4-converter/mkv-to-mp4/', (req, res) => {
  renderLocalConversionPage(res, {
    title: 'MKV to MP4 Converter Online | ConveTube',
    description: 'Convert MKV to MP4 online from a local video up to 100 MB. Create a compatible MP4 for sharing, playback, and editing with practical format guidance.',
    canonical: 'https://convetube.com/mp4-converter/mkv-to-mp4/',
    applicationName: 'ConveTube MKV to MP4 Converter',
    featureList: ['MKV video to MP4 conversion', 'Browser-based local video upload', 'MP4 output for broad playback compatibility'],
    keyword: 'mkv to mp4',
    heading: 'MKV to MP4',
    headingAccent: 'Converter',
    heroSubtitle: 'Choose an MKV video and prepare an MP4 that is easier to share and play.',
    breadcrumbItems: [{ label: 'Home', href: '/' }, { label: 'MP4 Converter', href: '/mp4-converter/mkv-to-mp4/' }, { label: 'MKV to MP4' }],
    introHeading: 'Convert MKV to MP4 online',
    introParagraphs: [
      'Use this <strong>MKV to MP4</strong> tool when a player, editor, phone, or sharing service does not accept a Matroska video. Choose one local MKV file up to 100 MB, convert it in the browser, preview the MP4, and save the result.',
      'MKV is a flexible container that may include several video, audio, subtitle, or chapter tracks. MP4 is commonly supported across browsers, phones, TVs, editors, and social platforms, but track selection and codec compatibility should be checked after conversion.'
    ],
    stepsHeading: 'How to convert MKV to MP4',
    steps: [
      { title: 'Choose an MKV file', body: 'select one local .mkv video no larger than 100 MB.' },
      { title: 'Start the conversion', body: 'submit the file and keep this browser tab open during processing.' },
      { title: 'Preview the MP4', body: 'check video playback, audio sync, duration, and the selected tracks.' },
      { title: 'Download the result', body: 'save the MP4 for playback, sharing, or import into an editor.' }
    ],
    benefitsHeading: 'MKV tracks, MP4 compatibility, and limits',
    benefits: [
      { icon: 'MKV', title: 'Flexible container input', body: 'The tool accepts one local MKV video file and processes its readable media tracks.' },
      { icon: 'MP4', title: 'Broad playback support', body: 'MP4 is a practical delivery format for browsers, phones, televisions, editors, and sharing workflows.' },
      { icon: 'TRACK', title: 'Review track selection', body: 'If the MKV has multiple tracks, preview the output to confirm the intended video and audio.' },
      { icon: '100MB', title: 'One file up to 100 MB', body: 'Large videos may exceed the browser upload limit and need a local desktop workflow.' }
    ],
    relatedTools: [
      { href: '/mp4-converter/mov-to-mp4/', label: 'MOV to MP4', description: 'Convert a local QuickTime video to MP4.' },
      { href: '/mp4-converter/url-to-mp4/', label: 'URL to MP4', description: 'Prepare an MP4 from a supported video URL.' },
      { href: '/mp3-converter/mkv-to-mp3/', label: 'MKV to MP3', description: 'Extract only the audio track from an MKV video.' }
    ],
    faqHeading: 'MKV to MP4 questions',
    faqItems: [
      { question: 'How do I convert MKV to MP4?', answer: 'Choose one local MKV file up to 100 MB, start conversion, preview the prepared video, and download the MP4.' },
      { question: 'Will MKV subtitles be included in MP4?', answer: 'Subtitle and chapter behavior depends on the source tracks and output compatibility. Preview the MP4 and verify the tracks you need.' },
      { question: 'Does converting MKV to MP4 reduce quality?', answer: 'The output may be re-encoded for MP4 compatibility, so keep the original MKV if you need a lossless source or want to re-edit later.' },
      { question: 'Why did my MKV to MP4 conversion fail?', answer: 'The file may exceed 100 MB, be damaged, use an unreadable codec, lack a valid media stream, or carry an extension that does not match its contents.' }
    ],
    inputFormat: 'mkv',
    videoOutput: true,
    defaultFormat: 'mp4'
  });
});

app.get('/mp4-converter/mov-to-mp4/', (req, res) => {
  renderLocalConversionPage(res, {
    title: 'MOV to MP4 Converter – Convert QuickTime Video Online | ConveTube',
    description: 'Convert MOV to MP4 online from a local QuickTime video up to 100 MB. Improve compatibility for sharing, playback, and editing with a simple browser tool.',
    canonical: 'https://convetube.com/mp4-converter/mov-to-mp4/',
    applicationName: 'ConveTube MOV to MP4 Converter',
    featureList: ['MOV video to MP4 conversion', 'Browser-based local file upload', 'MP4 output for broad device compatibility'],
    keyword: 'mov to mp4',
    heading: 'MOV to MP4',
    headingAccent: 'Converter',
    heroSubtitle: 'Choose a QuickTime MOV video and create an MP4 for wider playback and sharing support.',
    breadcrumbItems: [{ label: 'Home', href: '/' }, { label: 'MP4 Converter', href: '/mp4-converter/mov-to-mp4/' }, { label: 'MOV to MP4' }],
    introHeading: 'Convert MOV to MP4 online',
    introParagraphs: [
      'Use this <strong>MOV to MP4</strong> converter when a device, browser, editor, or sharing service needs a more widely supported video container. Choose one local MOV file up to 100 MB, start processing, preview the MP4, and download it.',
      'MOV is common in Apple and QuickTime workflows, while MP4 is a practical delivery format for phones, browsers, TVs, editors, and online sharing. Conversion can change codecs or metadata, so keep the original MOV until the new file is checked.'
    ],
    stepsHeading: 'How to convert MOV to MP4',
    steps: [
      { title: 'Choose a MOV file', body: 'select one local .mov video no larger than 100 MB.' },
      { title: 'Start conversion', body: 'submit the file and keep this browser tab open while it is processed.' },
      { title: 'Check compatibility', body: 'preview the MP4 and verify picture quality, audio sync, duration, and orientation.' },
      { title: 'Download MP4', body: 'save the converted video for sharing, playback, or editing.' }
    ],
    benefitsHeading: 'MOV versus MP4 for everyday video',
    benefits: [
      { icon: 'MOV', title: 'QuickTime source support', body: 'The first-screen tool accepts one local MOV file per conversion.' },
      { icon: 'MP4', title: 'Easier distribution', body: 'MP4 is widely recognized by browsers, mobile devices, televisions, editors, and social platforms.' },
      { icon: 'SYNC', title: 'Check audio sync', body: 'Preview the result after conversion because a new container or codec can affect track handling.' },
      { icon: '100MB', title: 'Clear upload limit', body: 'Each upload must be non-empty and no larger than 100 MB.' }
    ],
    relatedTools: [
      { href: '/mp4-converter/mkv-to-mp4/', label: 'MKV to MP4', description: 'Convert a local Matroska video to MP4.' },
      { href: '/mp4-converter/url-to-mp4/', label: 'URL to MP4', description: 'Prepare MP4 output from a supported video URL.' },
      { href: '/mp3-converter/mov-to-mp3/', label: 'MOV to MP3', description: 'Extract audio from a MOV video as MP3.' }
    ],
    faqHeading: 'MOV to MP4 questions',
    faqItems: [
      { question: 'How do I convert MOV to MP4?', answer: 'Choose one local MOV file up to 100 MB, start conversion, preview the output, and download the MP4.' },
      { question: 'Can I convert an iPhone MOV video?', answer: 'Yes, provided the MOV file is readable, non-empty, and no larger than 100 MB. Check orientation and audio sync in the preview.' },
      { question: 'Does MOV to MP4 reduce video quality?', answer: 'The output can be re-encoded for compatibility, so quality and file size depend on the source. Keep the original MOV for editing or archiving.' },
      { question: 'Why did my MOV to MP4 conversion fail?', answer: 'The file may exceed 100 MB, be damaged, use an unsupported codec, lack a readable stream, or have a mismatched extension.' }
    ],
    inputFormat: 'mov',
    videoOutput: true,
    defaultFormat: 'mp4'
  });
});

// EN Homepage: URL to MP3
app.get('/', (req, res) => {
  const requestedLanguage = String(req.query.lang || '').toLowerCase();
  if (supportedLanguages.has(requestedLanguage) && requestedLanguage !== 'en') {
    res.cookie('convetube_lang', requestedLanguage, { maxAge: 1000 * 60 * 60 * 24 * 365, httpOnly: false, sameSite: 'lax', path: '/' });
    return res.redirect(302, languageHomePaths[requestedLanguage]);
  }

  if (requestedLanguage === 'en') {
    res.cookie('convetube_lang', 'en', { maxAge: 1000 * 60 * 60 * 24 * 365, httpOnly: false, sameSite: 'lax', path: '/' });
  } else {
    const savedLanguage = getCookieValue(req.headers.cookie, 'convetube_lang');
    const detectedLanguage = savedLanguage && supportedLanguages.has(savedLanguage)
      ? savedLanguage
      : detectBrowserLanguage(req.headers['accept-language']);

    if (detectedLanguage !== 'en') {
      res.cookie('convetube_lang', detectedLanguage, { maxAge: 1000 * 60 * 60 * 24 * 365, httpOnly: false, sameSite: 'lax', path: '/' });
      return res.redirect(302, languageHomePaths[detectedLanguage]);
    }
  }

  renderPage(res, 'index', {
    lang: 'en',
    title: 'URL to MP3 Converter Free Online | Convert Link to MP3 - ConveTube',
    description: 'Convert any supported video URL to MP3 online for free. Preview and download high-quality MP3 audio in your browser with ConveTube.',
    canonical: 'https://convetube.com/',
    applicationName: 'ConveTube URL to MP3 Converter',
    applicationCategory: 'MultimediaApplication',
    featureList: ['Any supported video URL to MP3 conversion', 'Browser-based audio preview', 'MP3 download without software installation'],
    faqItems: [
      { question: 'What is a URL to MP3 converter?', answer: 'A URL to MP3 converter turns a supported video URL into an MP3 audio file that you can save and play on your device.' },
      { question: 'Can I convert any video URL to MP3?', answer: 'Yes. Paste a supported video URL, wait for the audio analysis, and download the MP3 when the result is ready.' },
      { question: 'Is the URL to MP3 converter free?', answer: 'Yes. ConveTube provides the URL to MP3 conversion flow online for free, with no required account or subscription.' },
      { question: 'Do I need to install software?', answer: 'No. The converter runs in a modern web browser, so you can convert a URL to MP3 without installing additional software.' }
    ]
  });
});

// FR Subdirectory
app.get('/convertir-youtube-vers-mp3', (req, res) => {
  renderPage(res, 'convertir-youtube-vers-mp3', {
    lang: 'fr',
    title: 'Convertir YouTube vers MP3 Gratuit | Télécharger Vidéo YouTube - ConveTube',
    description: 'Convertir YouTube vers MP3 gratuitement et en haute qualité. Télécharger vos musiques et vidéos préférées de YouTube en quelques secondes sur ConveTube.',
    canonical: 'https://convetube.com/convertir-youtube-vers-mp3/',
    applicationName: 'ConveTube Convertisseur YouTube vers MP3',
    applicationCategory: 'MultimediaApplication',
    featureList: ['Conversion YouTube vers MP3', 'Audio jusqu’à 320 kbps', 'Compatible mobile et ordinateur'],
    faqItems: [
      { question: 'Le convertisseur est-il vraiment illimité ?', answer: 'Oui, absolument. Nous ne limitions pas le nombre de conversions quotidiennes. Vous pouvez télécharger autant de musiques YouTube que vous le souhaitez.' },
      { question: "Puis-je l'utiliser sur mon smartphone ?", answer: 'Oui. ConveTube est optimisé pour les appareils mobiles. Il fonctionne directement depuis Safari, Chrome ou Firefox sur iOS et Android sans aucune application tierce.' },
      { question: 'Faut-il payer pour télécharger la musique ?', answer: "Non, ce service est 100% gratuit et financé par des dons. Il n'y aura jamais d'abonnements payants cachés." }
    ]
  });
});

// ES Internal Page: migrated former homepage
app.get('/convertidor-de-youtube-a-mp3', (req, res) => {
  renderPage(res, 'convertidor-de-youtube-a-mp3', {
    lang: 'es',
    title: 'Convertidor YouTube a MP3 Gratis | Descargar Música de YouTube - ConveTube',
    description: 'El mejor convertidor YouTube a MP3 gratis. Convierte videos de YouTube a MP3 en segundos con alta calidad. Fácil, rápido y sin registro en ConveTube.',
    canonical: 'https://convetube.com/convertidor-de-youtube-a-mp3/',
    applicationName: 'ConveTube Convertidor YouTube a MP3 Gratis',
    applicationCategory: 'MultimediaApplication',
    featureList: ['Conversión de YouTube a MP3', 'Vista previa de audio', 'Descarga desde el navegador'],
    faqItems: [
      { question: '¿Este convertidor de YouTube a MP3 es completamente gratis?', answer: 'Sí, el servicio de ConveTube es 100% gratis. Puedes realizar tantas conversiones y descargas de música como desees, sin límites diarios ni cargos ocultos.' },
      { question: '¿Necesito registrarme para descargar música?', answer: 'No. Respetamos tu privacidad y comodidad. No necesitas crear una cuenta ni proporcionar correos electrónicos para utilizar nuestro extractor de audio.' },
      { question: '¿Puedo escuchar el audio antes de descargarlo?', answer: '¡Por supuesto! Hemos incorporado un reproductor de música premium para que puedas verificar la calidad y el contenido del audio online antes de guardarlo en tu disco local.' },
      { question: '¿ConveTube funciona como youtube convertidor online?', answer: 'Sí. Puedes usar ConveTube como youtube convertidor desde el navegador: copia el enlace del video, pégalo en la caja principal y descarga el audio MP3 cuando el procesamiento termine.' }
    ]
  });
});

// ES MP3 YouTube Page
app.get('/convertidor-mp3-youtube', (req, res) => {
  renderPage(res, 'convertidor-mp3-youtube', {
    lang: 'es',
    title: 'Convertidor MP3 YouTube Gratis Online | ConveTube',
    description: 'Usa ConveTube como convertidor MP3 YouTube online. Convierte enlaces de YouTube a MP3 gratis, rápido y sin instalar aplicaciones.',
    canonical: 'https://convetube.com/convertidor-mp3-youtube/',
    applicationName: 'ConveTube Convertidor MP3 YouTube',
    applicationCategory: 'MultimediaApplication',
    featureList: ['Conversión directa desde una URL', 'MP3 compatible con teléfonos y computadoras', 'Flujo simple de pegar y descargar'],
    faqItems: [
      { question: '¿Qué significa convertidor MP3 YouTube?', answer: 'Significa convertir el audio de un video de YouTube en un archivo MP3 descargable. ConveTube toma la URL del video y crea un archivo de audio listo para escuchar sin conexión.' },
      { question: '¿Puedo usar este convertidor desde el celular?', answer: 'Sí. Puedes copiar el enlace desde la app de YouTube, abrir ConveTube en el navegador de tu celular y descargar el MP3 cuando termine la conversión.' },
      { question: '¿Es diferente de un convertidor de YouTube a MP3?', answer: 'La función es la misma, pero esta página está enfocada en quienes buscan la frase convertidor MP3 YouTube o convertidor mp3 youtube para encontrar una herramienta directa de audio.' }
    ]
  });
});

// Legacy ES tertiary page
app.get('/convertidor-de-youtube-a-mp3/convertir-videos-de-youtube-a-mp3', (req, res) => {
  res.redirect(301, '/convertidor-de-youtube-a-mp3/');
});

// ES No Tube Page
app.get('/convertidor-mp3-no-tube', (req, res) => {
  renderPage(res, 'convertidor-mp3-no-tube', {
    lang: 'es',
    title: 'Convertidor MP3 No Tube Gratis | La Mejor Alternativa - ConveTube',
    description: '¿Buscas un convertidor mp3 no tube rápido y sin publicidad? ConveTube es la mejor alternativa gratuita para convertir videos de YouTube a MP3 online.',
    canonical: 'https://convetube.com/convertidor-mp3-no-tube/',
    applicationName: 'ConveTube Alternativa a No Tube',
    applicationCategory: 'MultimediaApplication',
    featureList: ['Conversión MP3 sin ventanas invasivas', 'Previsualización del audio', 'Descargas desde Android y iPhone'],
    faqItems: [
      { question: '¿Cómo se diferencia ConveTube de las plataformas tradicionales como no tube?', answer: 'ConveTube ofrece un entorno mucho más limpio, enfocado en la seguridad del usuario. No instalamos cookies de rastreo invasivas y nuestro reproductor integrado te permite previsualizar y escuchar el audio antes de guardarlo en tu dispositivo.' },
      { question: '¿El servicio funciona para convertir música en el celular?', answer: 'Sí, es totalmente compatible. Puedes usarlo en tu dispositivo móvil (Android o iPhone) sin necesidad de instalar aplicaciones desde la App Store o Google Play. Solo copia el enlace de YouTube, pégalo en nuestro navegador y descarga el MP3.' },
      { question: '¿Es legal utilizar este convertidor de YouTube?', answer: 'Nuestra plataforma está diseñada para facilitar la conversión de videos de uso personal, académico o contenido libre de derechos de autor. Te recomendamos respetar las leyes de propiedad intelectual de tu país de residencia.' },
      { question: '¿ConveTube sirve si busco convertidor notube o convertidor mp3 nube?', answer: 'Sí. Esas búsquedas suelen referirse a una herramienta tipo NoTube para convertir enlaces de YouTube en MP3. ConveTube ofrece una experiencia similar, pero enfocada en una navegación limpia y directa.' }
    ]
  });
});

// ES Descargar Page
app.get('/descargar-videos-de-youtube-a-mp3-gratis-online', (req, res) => {
  renderPage(res, 'descargar-videos-de-youtube-a-mp3-gratis-online', {
    lang: 'es',
    title: 'Descargar Videos de YouTube a MP3 Gratis Online | ConveTube',
    description: 'Descarga videos de YouTube a MP3 gratis y online en alta calidad (320kbps). Extrae pistas de audio de forma segura y rápida con ConveTube.',
    canonical: 'https://convetube.com/descargar-videos-de-youtube-a-mp3-gratis-online/',
    applicationName: 'ConveTube Descarga YouTube a MP3',
    applicationCategory: 'MultimediaApplication',
    featureList: ['Descarga de pistas MP3 hasta 320 kbps', 'Conversión individual rápida', 'Compatible con iOS, Android, Windows y macOS'],
    faqItems: [
      { question: '¿Puedo descargar más de un archivo MP3 a la vez?', answer: 'Sí. Puedes realizar tantas descargas como quieras, de forma sucesiva. Procesamos cada video de forma individual a máxima velocidad para no congestionar tu conexión.' },
      { question: '¿En qué carpeta se guardan los audios descargados?', answer: 'Por defecto, los archivos MP3 se guardarán en la carpeta de "Descargas" de tu sistema operativo (o en la ubicación que tengas configurada en las preferencias de tu navegador web).' },
      { question: '¿Es necesario instalar algún tipo de plugin o extensión?', answer: 'No. ConveTube es una aplicación 100% basada en la web. Solo necesitas conexión a Internet y un navegador moderno para poder descargar tus pistas de audio preferidas.' }
    ]
  });
});

// ES Music Download Page
app.get('/descargar-musica-de-youtube', (req, res) => {
  renderPage(res, 'descargar-musica-de-youtube', {
    lang: 'es',
    title: 'Descargar Música de YouTube Gratis en MP3 | ConveTube',
    description: 'Descargar música de YouTube en MP3 gratis y online. Guarda canciones, podcasts y audios para escuchar sin conexión desde cualquier dispositivo.',
    canonical: 'https://convetube.com/descargar-musica-de-youtube/',
    applicationName: 'ConveTube Descargar Música de YouTube',
    applicationCategory: 'MultimediaApplication',
    featureList: ['Descarga de canciones, podcasts y audios', 'Formato MP3 universal', 'Experiencia optimizada para móvil'],
    faqItems: [
      { question: '¿Puedo descargar canciones de YouTube en el móvil?', answer: 'Sí. Copia el enlace desde la app de YouTube, abre ConveTube en tu navegador y descarga el MP3 desde el botón final.' },
      { question: '¿Cómo descargar MP3 de YouTube online?', answer: 'Pega el enlace del video en ConveTube, espera a que el sistema prepare el audio y pulsa el botón de descarga para guardar el archivo MP3.' },
      { question: '¿Qué diferencia hay con una página de videos a MP3?', answer: 'La función es la misma, pero esta página está enfocada en usuarios que quieren guardar música, canciones, podcasts y audios para escucharlos offline.' },
      { question: '¿También ofrecen WAV?', answer: 'Sí. Para edición de audio o trabajos donde prefieras un archivo sin compresión, prueba YouTube a WAV.' }
    ]
  });
});

// ES WAV Page
app.get('/youtube-a-wav', (req, res) => {
  renderPage(res, 'youtube-a-wav', {
    lang: 'es',
    title: 'YouTube a WAV Gratis | Convertir Audio Online - ConveTube',
    description: 'Convierte YouTube a WAV online gratis. Descarga audio WAV sin compresión para edición, producción, muestras y proyectos de audio.',
    canonical: 'https://convetube.com/youtube-a-wav/',
    applicationName: 'ConveTube YouTube a WAV',
    applicationCategory: 'MultimediaApplication',
    featureList: ['Conversión a WAV PCM', 'Salida a 44.1 kHz', 'Archivo sin compresión para edición'],
    faqItems: [
      { question: '¿Para qué sirve convertir YouTube a WAV?', answer: 'WAV es útil para editar, recortar, normalizar o importar audio en un DAW cuando necesitas una salida sin compresión adicional.' },
      { question: '¿El archivo WAV ocupa más espacio que un MP3?', answer: 'Sí. WAV conserva el audio sin compresión, por lo que normalmente ocupa más espacio que un archivo MP3.' },
      { question: '¿Qué frecuencia de muestreo tiene el WAV?', answer: 'La salida WAV se genera en PCM a 44.1 kHz, una configuración estándar y compatible con muchas herramientas.' },
      { question: '¿Puedo usar el convertidor desde el celular?', answer: 'Sí. Puedes pegar el enlace y descargar el archivo WAV desde un navegador moderno en Android, iPhone, tablet u ordenador.' }
    ]
  });
});

// EN WAV legacy route: consolidate the old path under the output-format hierarchy.
app.get('/youtube-to-wav', (req, res) => {
  res.redirect(301, '/wav-converter/youtube-to-wav/');
});

app.get('/audio-converter/audio-extractor/', (req, res) => {
  renderLocalConversionPage(res, {
    title: 'Audio Extractor – Extract Audio from Video Online | ConveTube',
    description: 'Use an audio extractor to pull a readable MP3 track from a local MP4 video up to 100 MB. Preview the result and save the audio online.',
    canonical: 'https://convetube.com/audio-converter/audio-extractor/',
    applicationName: 'ConveTube Audio Extractor',
    featureList: ['Audio extraction from local MP4 video', '320 kbps MP3 output', 'Browser-based file preview and download'],
    keyword: 'audio extractor',
    heading: 'Audio Extractor',
    headingAccent: 'from Video',
    heroSubtitle: 'Choose a local MP4 video and extract its readable audio as a portable MP3.',
    breadcrumbItems: [{ label: 'Home', href: '/' }, { label: 'Audio Converter', href: '/audio-converter/audio-extractor/' }, { label: 'Audio Extractor' }],
    introHeading: 'Extract audio from a video file',
    introParagraphs: [
      'An <strong>audio extractor</strong> separates the sound track from a video container so you can listen, edit, archive, or share the audio without carrying the picture. Use the first-screen tool with one local MP4 file up to 100 MB, preview the MP3, and download the result.',
      'MP4 files may contain more than one audio stream, captions, or unusual codecs. The converter uses the first readable audio stream, so keep the source video until you have checked the duration, language, and playback of the extracted file.'
    ],
    stepsHeading: 'How to use this audio extractor',
    steps: [
      { title: 'Choose a video', body: 'select one local .mp4 file no larger than 100 MB.' },
      { title: 'Extract the audio', body: 'submit the video and keep the browser tab open while the MP3 is prepared.' },
      { title: 'Review the track', body: 'preview the result and check that the intended audio stream and duration are present.' },
      { title: 'Download MP3', body: 'save the audio for listening, editing, captions, or another media workflow.' }
    ],
    benefitsHeading: 'Audio extraction, formats, and file limits',
    benefits: [
      { icon: 'VIDEO', title: 'Video-file input', body: 'The first-screen tool accepts one local MP4 video per conversion.' },
      { icon: 'AUDIO', title: 'Audio-only output', body: 'The video track is removed and the readable audio is encoded as a 320 kbps MP3.' },
      { icon: 'TRACK', title: 'Preview the selected stream', body: 'Check the result when the source contains multiple languages, commentary, or alternate mixes.' },
      { icon: '100MB', title: 'One file up to 100 MB', body: 'Large or long videos may exceed the browser upload limit and need a local desktop workflow.' }
    ],
    relatedTools: [
      { href: '/mp3-converter/video-to-mp3/', label: 'Video to MP3', description: 'Extract audio from a supported online video URL.' },
      { href: '/mp3-converter/mp4-to-mp3/', label: 'MP4 to MP3', description: 'Use the dedicated MP4 audio conversion workflow.' },
      { href: '/mp3-converter/mkv-to-mp3/', label: 'MKV to MP3', description: 'Extract audio from a local Matroska video.' }
    ],
    faqHeading: 'Audio extractor questions',
    faqItems: [
      { question: 'What does an audio extractor do?', answer: 'An audio extractor reads a video file and creates an audio-only file from its readable audio stream. This page prepares the result as a 320 kbps MP3.' },
      { question: 'How do I extract audio from a video?', answer: 'Choose one local MP4 file up to 100 MB, start the conversion, preview the audio track, and download the MP3 result.' },
      { question: 'Which audio track is extracted?', answer: 'The conversion pipeline uses the first readable audio stream. Preview the result when the video contains multiple languages, commentary, or alternate mixes.' },
      { question: 'Why did my audio extraction fail?', answer: 'The file may exceed 100 MB, be damaged, contain no readable audio stream, use an unsupported codec, or have an extension that does not match its contents.' }
    ],
    inputFormat: 'mp4',
    defaultFormat: 'mp3'
  });
});

app.get('/audio-converter/audio-to-text/', (req, res) => {
  renderLocalConversionPage(res, {
    title: 'Audio to Text Workflow – Prepare Audio for Transcription | ConveTube',
    description: 'Prepare a local M4A recording for an audio to text workflow. Convert it to a compact MP3, review the audio, and continue with transcription.',
    canonical: 'https://convetube.com/audio-converter/audio-to-text/',
    applicationName: 'ConveTube Audio to Text Workflow',
    featureList: ['M4A audio preparation for transcription workflows', '320 kbps MP3 output', 'Browser-based file preview and download'],
    keyword: 'audio to text',
    heading: 'Audio to Text',
    headingAccent: 'Workflow',
    heroSubtitle: 'Prepare a local audio recording as MP3 before sending it to a transcription step.',
    breadcrumbItems: [{ label: 'Home', href: '/' }, { label: 'Audio Converter', href: '/audio-converter/audio-to-text/' }, { label: 'Audio to Text' }],
    introHeading: 'Prepare audio for an audio to text workflow',
    introParagraphs: [
      'An <strong>audio to text</strong> workflow starts with a clear, correctly formatted recording. Use the first-screen converter to prepare one local M4A file up to 100 MB as a broadly compatible MP3, listen for missing speech or background noise, then move the checked file into your transcription step.',
      'Audio quality affects transcript quality: clean speech, steady volume, and limited background noise make words easier to recognize. The conversion result on this page is an audio file for the next transcription stage; it does not display a text transcript in the audio preview.'
    ],
    stepsHeading: 'How to prepare audio for text conversion',
    steps: [
      { title: 'Choose a recording', body: 'select one local .m4a file no larger than 100 MB.' },
      { title: 'Create a compatible audio copy', body: 'submit the recording and wait while the MP3 preparation finishes.' },
      { title: 'Check speech quality', body: 'preview the result and listen for clipping, silence, overlapping speakers, or missing sections.' },
      { title: 'Continue to transcription', body: 'download the checked MP3 and use it with the audio transcription tool or workflow you prefer.' }
    ],
    benefitsHeading: 'Audio preparation, quality, and formats',
    benefits: [
      { icon: 'M4A', title: 'Common audio input', body: 'The first-screen tool accepts one local M4A recording per conversion.' },
      { icon: 'MP3', title: 'Broadly compatible copy', body: 'The output is a 320 kbps MP3 that is easy to preview, transfer, and import into many transcription tools.' },
      { icon: 'VOICE', title: 'Review speech first', body: 'Listening before transcription helps catch silence, distortion, low volume, or speaker overlap.' },
      { icon: '100MB', title: 'One file up to 100 MB', body: 'Long recordings may exceed the browser upload limit and may need to be split in a local editor.' }
    ],
    relatedTools: [
      { href: '/audio-converter/mp3-to-text/', label: 'MP3 to Text Workflow', description: 'Prepare an existing MP3 before a transcription step.' },
      { href: '/mp3-converter/m4a-to-mp3-online/', label: 'M4A to MP3 Online', description: 'Convert a local M4A file with the dedicated MP3 page.' },
      { href: '/mp3-converter/wav-to-mp3/', label: 'WAV to MP3', description: 'Create a smaller MP3 copy from a WAV recording.' }
    ],
    faqHeading: 'Audio to text questions',
    faqItems: [
      { question: 'How do I start an audio to text workflow?', answer: 'Prepare a readable recording, convert it to a compatible audio file if needed, review the speech quality, and then send the checked file to a transcription step.' },
      { question: 'Does this page create a text transcript?', answer: 'The first-screen ConveTube tool prepares and previews audio as an MP3. Use the downloaded file with the transcription tool or workflow that will generate the text.' },
      { question: 'Which audio format is best for transcription?', answer: 'A clear recording in a format accepted by your transcription tool is the practical choice. MP3 is broadly compatible, while keeping the original M4A preserves a source copy.' },
      { question: 'Why might an audio to text result be inaccurate?', answer: 'Low volume, clipping, background noise, strong accents, overlapping speakers, silence, and unclear microphones can reduce recognition quality. Review the audio before transcribing.' }
    ],
    inputFormat: 'm4a',
    defaultFormat: 'mp3'
  });
});

app.get('/audio-converter/mp3-to-text/', (req, res) => {
  renderLocalConversionPage(res, {
    title: 'MP3 to Text Workflow – Prepare an MP3 for Transcription | ConveTube',
    description: 'Prepare an MP3 recording for an MP3 to text workflow. Normalize a local file up to 100 MB, preview the speech, and continue with transcription.',
    canonical: 'https://convetube.com/audio-converter/mp3-to-text/',
    applicationName: 'ConveTube MP3 to Text Workflow',
    featureList: ['MP3 audio preparation for transcription workflows', 'Browser-based MP3 preview', 'Local file processing up to 100 MB'],
    keyword: 'mp3 to text',
    heading: 'MP3 to Text',
    headingAccent: 'Workflow',
    heroSubtitle: 'Review and prepare an MP3 recording before moving it into a text transcription step.',
    breadcrumbItems: [{ label: 'Home', href: '/' }, { label: 'Audio Converter', href: '/audio-converter/mp3-to-text/' }, { label: 'MP3 to Text' }],
    introHeading: 'Turn an MP3 recording into a transcription-ready file',
    introParagraphs: [
      'An <strong>MP3 to text</strong> task normally has two stages: prepare the audio, then generate and review a transcript. Use this page to upload one local MP3 file up to 100 MB, create a fresh compatible audio copy, and preview the recording before the text stage.',
      'Keep the original MP3 until the transcript has been checked. A recording with clear speech, consistent volume, and minimal background noise gives downstream speech recognition a better signal than a clipped or incomplete source.'
    ],
    stepsHeading: 'How to prepare an MP3 for text conversion',
    steps: [
      { title: 'Choose an MP3 file', body: 'select one local .mp3 recording no larger than 100 MB.' },
      { title: 'Prepare the audio', body: 'submit the file and keep the browser tab open while the compatible MP3 copy is created.' },
      { title: 'Listen before transcribing', body: 'preview the output and verify speech, duration, volume, and any important pauses.' },
      { title: 'Start the text step', body: 'download the checked audio and pass it to the transcription tool or workflow you use.' }
    ],
    benefitsHeading: 'MP3 input, speech quality, and practical limits',
    benefits: [
      { icon: 'MP3', title: 'Direct MP3 input', body: 'The first-screen tool accepts one local MP3 recording per conversion.' },
      { icon: 'CHECK', title: 'Preview before text conversion', body: 'Confirm that the source contains the expected speech and that the recording is not clipped or silent.' },
      { icon: 'VOICE', title: 'Keep the original copy', body: 'Retain the source MP3 so you can compare transcript errors against the audio later.' },
      { icon: '100MB', title: 'One file up to 100 MB', body: 'Long recordings may need to be split locally before they fit the browser upload limit.' }
    ],
    relatedTools: [
      { href: '/audio-converter/audio-to-text/', label: 'Audio to Text Workflow', description: 'Prepare an M4A recording before transcription.' },
      { href: '/audio-converter/audio-extractor/', label: 'Audio Extractor', description: 'Pull an MP3 track from a local MP4 video.' },
      { href: '/mp3-converter/wav-to-mp3/', label: 'WAV to MP3', description: 'Prepare a compact copy from a lossless WAV source.' }
    ],
    faqHeading: 'MP3 to text questions',
    faqItems: [
      { question: 'How do I convert MP3 to text?', answer: 'Prepare and preview the MP3 first, then send the checked audio file to a transcription step that generates the text. This page handles the local audio preparation and preview stage.' },
      { question: 'Can I upload an MP3 here?', answer: 'Yes. Choose one non-empty MP3 file up to 100 MB, start the preparation step, preview the output, and download the compatible audio copy.' },
      { question: 'What improves MP3 transcription quality?', answer: 'Clear microphones, steady volume, limited background noise, separated speakers, and an intact recording generally make downstream speech recognition easier.' },
      { question: 'Why did my MP3 preparation fail?', answer: 'The file may exceed 100 MB, be damaged, contain an unsupported encoding, or use an extension that does not match its contents.' }
    ],
    inputFormat: 'mp3',
    defaultFormat: 'mp3'
  });
});

app.get('/audio-converter/speech-to-text/', (req, res) => {
  renderLocalConversionPage(res, {
    title: 'Speech to Text Workflow – Prepare Audio for Transcription | ConveTube',
    description: 'Prepare a local speech recording for a speech to text workflow. Review the audio, create a compatible MP3 copy, and continue with transcription.',
    canonical: 'https://convetube.com/audio-converter/speech-to-text/',
    applicationName: 'ConveTube Speech to Text Workflow',
    featureList: ['Speech recording preparation for transcription workflows', 'Browser-based WAV preview', 'Local file processing up to 100 MB'],
    keyword: 'speech to text',
    heading: 'Speech to',
    headingAccent: 'Text',
    heroSubtitle: 'Prepare a clear local speech recording before sending it to a text transcription step.',
    breadcrumbItems: [{ label: 'Home', href: '/' }, { label: 'Audio Converter', href: '/audio-converter/speech-to-text/' }, { label: 'Speech to Text' }],
    introHeading: 'Prepare speech for a speech to text workflow',
    introParagraphs: [
      'A <strong>speech to text</strong> workflow works best when the recording is complete, audible, and easy to process. Upload one local WAV file up to 100 MB in the first-screen tool, create a compatible MP3 copy, and listen to the result before the transcription stage.',
      'Keep the original recording as your reference. Steady volume, a close microphone, limited room noise, and distinct pauses help downstream recognition separate words and speakers more reliably.'
    ],
    stepsHeading: 'How to prepare speech for text conversion',
    steps: [
      { title: 'Choose a recording', body: 'select one local .wav speech recording no larger than 100 MB.' },
      { title: 'Create an audio copy', body: 'submit the recording and wait while the browser prepares the MP3 file.' },
      { title: 'Review the speech', body: 'preview the result and check volume, clipping, pauses, background noise, and missing sections.' },
      { title: 'Continue to transcription', body: 'download the checked file and pass it to the speech recognition or transcription workflow you use.' }
    ],
    benefitsHeading: 'Speech input, audio quality, and formats',
    benefits: [
      { icon: 'WAV', title: 'Lossless speech input', body: 'The first-screen tool accepts one local WAV recording per preparation step.' },
      { icon: 'MP3', title: 'Compatible working copy', body: 'The output is a 320 kbps MP3 that is easy to preview, transfer, and import into many transcription tools.' },
      { icon: 'VOICE', title: 'Listen before transcribing', body: 'A quick review can reveal low volume, clipping, room noise, silence, or overlapping speakers.' },
      { icon: '100MB', title: 'One file up to 100 MB', body: 'Long recordings may need to be split locally before they fit the browser upload limit.' }
    ],
    relatedTools: [
      { href: '/audio-converter/audio-to-text/', label: 'Audio to Text Workflow', description: 'Prepare an M4A recording before a transcription step.' },
      { href: '/audio-converter/mp3-to-text/', label: 'MP3 to Text Workflow', description: 'Review an existing MP3 before generating text.' },
      { href: '/audio-converter/audio-extractor/', label: 'Audio Extractor', description: 'Pull an MP3 track from a local MP4 video.' }
    ],
    faqHeading: 'Speech to text questions',
    faqItems: [
      { question: 'How do I prepare speech for text conversion?', answer: 'Upload a readable speech recording, prepare a compatible audio copy, review the sound, and then send the checked file to a transcription step.' },
      { question: 'Does this page generate a text transcript?', answer: 'The ConveTube tool prepares and previews the audio as an MP3. Use the downloaded file with the transcription tool or workflow that generates the text.' },
      { question: 'What audio improves speech recognition?', answer: 'Clear speech, stable volume, a close microphone, limited background noise, and separated speakers generally make downstream recognition easier.' },
      { question: 'Why did my speech preparation fail?', answer: 'The file may exceed 100 MB, be damaged, contain no readable audio stream, use an unsupported codec, or have an extension that does not match its contents.' }
    ],
    inputFormat: 'wav',
    defaultFormat: 'mp3'
  });
});

app.get('/video-converter/video-to-text/', (req, res) => {
  renderLocalConversionPage(res, {
    title: 'Video to Text Workflow – Extract Audio for Transcription | ConveTube',
    description: 'Prepare a local video for a video to text workflow. Extract and review the audio, then continue with a transcription step in your browser.',
    canonical: 'https://convetube.com/video-converter/video-to-text/',
    applicationName: 'ConveTube Video to Text Workflow',
    featureList: ['Video audio extraction for transcription workflows', 'Browser-based MP4 preview', 'Local file processing up to 100 MB'],
    keyword: 'video to text',
    heading: 'Video to',
    headingAccent: 'Text',
    heroSubtitle: 'Extract a reviewable audio track from a local video before moving it into a text transcription step.',
    breadcrumbItems: [{ label: 'Home', href: '/' }, { label: 'Video Converter', href: '/video-converter/video-to-text/' }, { label: 'Video to Text' }],
    introHeading: 'Prepare video audio for a video to text workflow',
    introParagraphs: [
      'A <strong>video to text</strong> task usually starts by isolating the speech from the video track. Upload one local MP4 file up to 100 MB, extract its readable audio as MP3, and review the result before sending it to a transcription stage.',
      'The extracted file does not contain the picture or on-screen text. Keep the original video for visual context, speaker identification, and checking names, slides, captions, or moments that audio alone cannot describe.'
    ],
    stepsHeading: 'How to prepare a video for text conversion',
    steps: [
      { title: 'Choose a video', body: 'select one local .mp4 video no larger than 100 MB.' },
      { title: 'Extract the audio', body: 'submit the video and wait while the readable audio track is prepared as MP3.' },
      { title: 'Review the result', body: 'preview the audio and check speech, timing, speaker overlap, and sections that need visual reference.' },
      { title: 'Continue to transcription', body: 'download the checked audio and send it to the video transcription workflow you use.' }
    ],
    benefitsHeading: 'Video input, extracted audio, and format limits',
    benefits: [
      { icon: 'MP4', title: 'Video-file input', body: 'The first-screen tool accepts one local MP4 video per preparation step.' },
      { icon: 'MP3', title: 'Audio-only working copy', body: 'The output removes the video track and creates a 320 kbps MP3 for downstream review.' },
      { icon: 'CHECK', title: 'Keep visual context', body: 'Retain the original video when names, slides, captions, or non-speech events matter to the final text.' },
      { icon: '100MB', title: 'One file up to 100 MB', body: 'Large or long videos may need to be split locally before browser upload.' }
    ],
    relatedTools: [
      { href: '/audio-converter/speech-to-text/', label: 'Speech to Text Workflow', description: 'Prepare a WAV speech recording before transcription.' },
      { href: '/audio-converter/audio-to-text/', label: 'Audio to Text Workflow', description: 'Prepare an audio recording for a text step.' },
      { href: '/mp3-converter/video-to-mp3/', label: 'Video to MP3', description: 'Convert a supported online video URL to MP3.' }
    ],
    faqHeading: 'Video to text questions',
    faqItems: [
      { question: 'How do I prepare a video for text conversion?', answer: 'Upload a readable video, extract and preview its audio, keep the original for visual checks, and then send the checked audio to a transcription step.' },
      { question: 'Does this page create a text transcript?', answer: 'The first-screen ConveTube tool extracts and previews audio as an MP3. A separate transcription tool or workflow is used to generate the text.' },
      { question: 'What happens to the video track?', answer: 'The downloaded MP3 contains the readable audio stream without the picture. Keep the original video when visual context is needed for review.' },
      { question: 'Why did my video preparation fail?', answer: 'The file may exceed 100 MB, be damaged, contain no readable audio stream, use an unsupported codec, or have an extension that does not match its contents.' }
    ],
    inputFormat: 'mp4',
    defaultFormat: 'mp3'
  });
});

// Sitemap.xml
app.get('/sitemap.xml', (req, res) => {
  res.set('Content-Type', 'application/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
        xsi:schemaLocation="http://www.sitemaps.org/schemas/sitemap/0.9
        http://www.sitemaps.org/schemas/sitemap/0.9/sitemap.xsd">
  <url>
    <loc>https://convetube.com/</loc>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>https://convetube.com/convertir-youtube-vers-mp3/</loc>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>https://convetube.com/convertidor-de-youtube-a-mp3/</loc>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>https://convetube.com/convertidor-mp3-youtube/</loc>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>https://convetube.com/convertidor-mp3-no-tube/</loc>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>https://convetube.com/descargar-videos-de-youtube-a-mp3-gratis-online/</loc>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>https://convetube.com/descargar-musica-de-youtube/</loc>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>https://convetube.com/youtube-a-wav/</loc>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>https://convetube.com/mp3-converter/link-to-mp3/</loc>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>https://convetube.com/mp3-converter/video-to-mp3/</loc>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>https://convetube.com/wav-converter/youtube-to-wav/</loc>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>https://convetube.com/flac-converter/youtube-to-flac/</loc>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>https://convetube.com/flac-converter/mp3-to-flac/</loc>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
  </url>
  <url>
    <loc>https://convetube.com/m4a-converter/mp3-to-m4a/</loc>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
  </url>
  <url>
    <loc>https://convetube.com/flac-converter/mp4-to-flac/</loc>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
  </url>
  <url>
    <loc>https://convetube.com/ogg-converter/youtube-to-ogg/</loc>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>https://convetube.com/mp3-converter/youtube-to-mp3/</loc>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>https://convetube.com/mp4-converter/youtube-to-mp4/</loc>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>https://convetube.com/mp4-converter/url-to-mp4/</loc>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>https://convetube.com/mp3-converter/m4a-to-mp3-online/</loc>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>https://convetube.com/mp3-converter/aac-to-mp3/</loc>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>https://convetube.com/mp3-converter/flac-to-mp3/</loc>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>https://convetube.com/mp3-converter/mkv-to-mp3/</loc>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>https://convetube.com/mp3-converter/mov-to-mp3/</loc>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>https://convetube.com/mp3-converter/mp4-to-mp3/</loc>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>https://convetube.com/mp3-converter/wav-to-mp3/</loc>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>https://convetube.com/mp3-converter/wma-to-mp3/</loc>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>https://convetube.com/audio-converter/audio-extractor/</loc>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
  </url>
  <url>
    <loc>https://convetube.com/audio-converter/audio-to-text/</loc>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
  </url>
  <url>
    <loc>https://convetube.com/audio-converter/mp3-to-text/</loc>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
  </url>
  <url>
    <loc>https://convetube.com/audio-converter/speech-to-text/</loc>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
  </url>
  <url>
    <loc>https://convetube.com/video-converter/video-to-text/</loc>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
  </url>
  <url>
    <loc>https://convetube.com/mp4-converter/mkv-to-mp4/</loc>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>https://convetube.com/mp4-converter/mov-to-mp4/</loc>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
</urlset>`);
});

// Robots.txt
app.get('/robots.txt', (req, res) => {
  res.set('Content-Type', 'text/plain');
  res.send(`User-agent: *\nAllow: /\nSitemap: https://convetube.com/sitemap.xml`);
});

// --- API Routes ---

// Contact form: forwards messages by email without storing them on disk.
app.post('/api/contact', async (req, res) => {
  console.log('[Contact] Received contact submission:', req.body);
  const email = String(req.body.email || '').trim();
  const message = String(req.body.message || '').trim();
  const website = String(req.body.website || '').trim();
  const botField = String(req.body.bot_field || '').trim();

  if (website || botField) {
    console.warn(`[Contact] Spam honeypot triggered. website: "${website}", bot_field: "${botField}". Silently ignoring.`);
    return res.json({ ok: true });
  }

  if (!message || message.length > 4000) {
    return res.status(400).json({ error: 'Message must be between 1 and 4000 characters.' });
  }

  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  if (!process.env.BREVO_API_KEY) {
    return res.status(503).json({ error: 'Email service is not configured.' });
  }

  const submittedAt = new Date().toISOString();
  const subject = 'New ConveTube footer message';
  const text = [
    'New message from ConveTube',
    '',
    `From: ${email || 'Not provided'}`,
    `Submitted: ${submittedAt}`,
    '',
    message
  ].join('\n');

  const html = `
    <h2>New message from ConveTube</h2>
    <p><strong>From:</strong> ${escapeHtml(email || 'Not provided')}</p>
    <p><strong>Submitted:</strong> ${escapeHtml(submittedAt)}</p>
    <p><strong>Message:</strong></p>
    <p style="white-space: pre-wrap;">${escapeHtml(message)}</p>
  `;

  try {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': process.env.BREVO_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        sender: {
          email: BREVO_SENDER_EMAIL,
          name: BREVO_SENDER_NAME
        },
        to: [{ email: CONTACT_TO_EMAIL }],
        replyTo: email ? { email } : undefined,
        subject,
        textContent: text,
        htmlContent: html
      })
    });

    if (!response.ok) {
      const details = await response.text();
      console.error(`[Contact] Failed to send email: ${response.status} ${details}`);
      return res.status(502).json({ error: 'Failed to send message.' });
    }

    return res.json({ ok: true });
  } catch (error) {
    console.error('[Contact] Email send error:', error);
    return res.status(502).json({ error: 'Failed to send message.' });
  }
});

// Convert one supported local media file with the same ffmpeg pipeline used by URL tools.
app.post('/api/file-convert', express.raw({ type: 'application/octet-stream', limit: '100mb' }), (req, res) => {
  const encodedName = String(req.headers['x-file-name'] || 'audio.m4a');
  let originalName = 'audio.m4a';
  try {
    originalName = decodeURIComponent(encodedName);
  } catch {
    originalName = encodedName;
  }

  const inputExtension = path.extname(originalName).slice(1).toLowerCase();
  const supportedInputExtensions = new Set(['mp3', 'm4a', 'aac', 'flac', 'wav', 'wma', 'mp4', 'mkv', 'mov']);
  const format = getOutputFormat(req.query.format);
  const outputOptions = getTranscodeOptions(format);
  if (!Buffer.isBuffer(req.body) || req.body.length === 0 || !supportedInputExtensions.has(inputExtension)) {
    return res.status(400).json({ error: 'A non-empty MP3, M4A, AAC, FLAC, WAV, WMA, MP4, MKV, or MOV file is required' });
  }

  const uploadDir = fs.mkdtempSync(path.join(cacheDir, `${inputExtension}-upload-`));
  const inputPath = path.join(uploadDir, `source.${inputExtension}`);
  const outputPath = path.join(uploadDir, `converted.${outputOptions.extension}`);
  fs.writeFileSync(inputPath, req.body);

  const cleanup = () => {
    try {
      fs.rmSync(uploadDir, { recursive: true, force: true });
    } catch (error) {
      console.error('[Upload] Cleanup failed:', error.message);
    }
  };

  const ffmpeg = spawn('ffmpeg', [
    '-i', inputPath,
    ...outputOptions.ffmpegArgs,
    '-threads', '0',
    '-y',
    outputPath
  ]);

  let stderr = '';
  ffmpeg.stderr.on('data', (chunk) => { stderr += chunk; });
  ffmpeg.on('error', (error) => {
    console.error('[Upload] ffmpeg failed to start:', error.message);
    cleanup();
    if (!res.headersSent) res.status(500).json({ error: 'Failed to start file conversion' });
  });
  ffmpeg.on('close', (code) => {
    if (code !== 0 || !fs.existsSync(outputPath)) {
      console.error(`[Upload] ${inputExtension.toUpperCase()} conversion failed with code ${code}: ${stderr.slice(-500)}`);
      cleanup();
      if (!res.headersSent) res.status(422).json({ error: `The ${inputExtension.toUpperCase()} file could not be converted` });
      return;
    }

    const baseName = path.basename(originalName, path.extname(originalName));
    const filename = getDownloadFilename(baseName, outputOptions.extension);
    res.download(outputPath, filename, cleanup);
  });

  req.on('aborted', () => {
    ffmpeg.kill();
    cleanup();
  });
});

// 0. Check if the requested cached output is ready
app.get('/api/cache-status', (req, res) => {
  const source = getSourceFromRequest(req);
  const format = getOutputFormat(req.query.format);
  if (!source) {
    return res.status(400).json({ error: 'A valid video URL is required' });
  }

  const cachePath = getCachePath(source.key, format);
  if (fs.existsSync(cachePath)) {
    const stats = fs.statSync(cachePath);
    return res.json({ ready: true, size: stats.size });
  }

  // Check if transcoding is in progress
  const isTranscoding = activeTranscodes.has(`${source.key}:${format}`);
  return res.json({ ready: false, transcoding: isTranscoding });
});

// 1. Fetch Video Metadata
app.get('/api/info', async (req, res) => {
  const source = getSourceFromRequest(req);
  const format = getOutputFormat(req.query.format);
  if (!source) {
    return res.status(400).json({ error: 'A valid video URL is required' });
  }

  try {
    const data = await new Promise((resolve, reject) => {
      const ytDlp = spawn('yt-dlp', [
        ...getBaseYtDlpArgs(),
        '-j',
        '--no-playlist',
        '--no-warnings',
        '--no-check-certificates',
        '--socket-timeout',
        '10',
        source.url
      ]);
      let stdout = '';
      let stderr = '';

      ytDlp.stdout.on('data', (chunk) => { stdout += chunk; });
      ytDlp.stderr.on('data', (chunk) => { stderr += chunk; });
      ytDlp.on('error', reject);
      ytDlp.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(stderr || `yt-dlp exited with code ${code}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (error) {
          reject(error);
        }
      });
    });

    startBackgroundTranscode(source.url, source.key, format);

    res.json({
      sourceKey: source.key,
      title: data.title || 'Video audio',
      channel: data.uploader || data.channel || 'ConveTube Engine',
      duration: data.duration,
      thumbnail: data.thumbnail
    });
  } catch (error) {
    console.error('yt-dlp info error:', error.message);
    res.status(500).json({ error: 'Failed to fetch video details' });
  }
});

// 2. Stream the requested media output
app.get('/api/stream', (req, res) => {
  const source = getSourceFromRequest(req);
  const format = getOutputFormat(req.query.format);
  const options = getTranscodeOptions(format, 'stream');
  if (!source) {
    return res.status(400).send('A valid video URL is required');
  }

  const cachePath = getCachePath(source.key, format);
  
  // If cache exists, serve static file (supports seeking/range requests automatically)
  if (fs.existsSync(cachePath)) {
    return res.sendFile(cachePath);
  }

  res.setHeader('Content-Type', options.mimeType);

  if (format === 'mp4') {
    const ytDlp = spawn('yt-dlp', [
      ...getBaseYtDlpArgs(),
      '-f', 'best[ext=mp4]/best',
      '--no-playlist',
      '-o', '-',
      source.url
    ]);
    ytDlp.stdout.pipe(res);
    req.on('close', () => ytDlp.kill());
    return;
  }
  
  // Stream audio directly using yt-dlp and ffmpeg pipeline
  const ytDlpArgs = [...getBaseYtDlpArgs(), '-f', 'bestaudio', '-o', '-', source.url];
  const ytDlp = spawn('yt-dlp', ytDlpArgs);

  const ffmpeg = spawn('ffmpeg', [
    '-i', 'pipe:0',
    ...options.ffmpegArgs,
    'pipe:1'
  ]);

  ytDlp.stdout.pipe(ffmpeg.stdin);
  ffmpeg.stdout.pipe(res);

  ytDlp.stderr.on('data', (data) => {
    // Suppress verbose output logs unless debugging
  });

  req.on('close', () => {
    ytDlp.kill();
    ffmpeg.kill();
  });
});

// 3. Convert and download the requested output format
app.get('/api/download', (req, res) => {
  const source = getSourceFromRequest(req);
  const rawTitle = req.query.title || 'audio';
  const format = getOutputFormat(req.query.format);
  const options = getTranscodeOptions(format);
  if (!source) {
    return res.status(400).send('A valid video URL is required');
  }

  const filename = getDownloadFilename(rawTitle, options.extension);
  const cachePath = getCachePath(source.key, format);

  // If a download token is provided, set a cookie so the client can detect when the download begins.
  const downloadToken = req.query.downloadToken;
  if (downloadToken) {
    res.cookie(downloadToken, 'true', { maxAge: 60000, httpOnly: false, path: '/' });
  }

  // If cache is ready, serve direct file download with Content-Length
  if (fs.existsSync(cachePath)) {
    console.log(`[Cache] Serving cached ${format.toUpperCase()} for direct download: ${filename}`);
    return res.download(cachePath, filename);
  }

  console.log(`[Cache] Cache not ready for ${source.key}, converting live...`);

  if (downloadToken) {
    res.cookie(downloadToken, 'true', { maxAge: 60000, httpOnly: false, path: '/' });
  }

  res.setHeader('Content-Type', options.mimeType);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  if (format === 'mp4') {
    const ytDlp = spawn('yt-dlp', [
      ...getBaseYtDlpArgs(),
      '-f', 'best[ext=mp4]/best',
      '--no-playlist',
      '-o', '-',
      source.url
    ]);
    ytDlp.stdout.pipe(res);
    req.on('close', () => ytDlp.kill());
    return;
  }

  // Stream requested audio format directly
  const ytDlpArgs = [...getBaseYtDlpArgs(), '-f', 'bestaudio', '-o', '-', source.url];
  const ytDlp = spawn('yt-dlp', ytDlpArgs);

  const ffmpeg = spawn('ffmpeg', [
    '-i', 'pipe:0',
    ...options.ffmpegArgs,
    'pipe:1'
  ]);

  ytDlp.stdout.pipe(ffmpeg.stdin);
  ffmpeg.stdout.pipe(res);

  req.on('close', () => {
    ytDlp.kill();
    ffmpeg.kill();
  });
});

// Start Server
app.listen(PORT, () => {
  console.log(`ConveTube Express Server is running on port ${PORT}`);
});
