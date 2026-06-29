import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { spawn, exec } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

const cookiesPath = path.join(__dirname, 'cookies.txt');

// Helper to get base yt-dlp arguments for spawn
const getBaseYtDlpArgs = () => {
  const args = ['--js-runtimes', 'node'];
  if (fs.existsSync(cookiesPath)) {
    args.push('--cookies', cookiesPath);
  }
  return args;
};

// Helper to get base command prefix for exec
const getExecPrefix = () => {
  let prefix = 'yt-dlp --js-runtimes node';
  if (fs.existsSync(cookiesPath)) {
    prefix += ` --cookies "${cookiesPath}"`;
  }
  return prefix;
};

// Setup cache directory
const cacheDir = path.join(__dirname, 'cache');
if (!fs.existsSync(cacheDir)) {
  fs.mkdirSync(cacheDir);
}

// Track active background conversions
const activeTranscodes = new Map();

const startBackgroundTranscode = (id) => {
  const cachePath = path.join(cacheDir, `${id}.mp3`);
  if (fs.existsSync(cachePath) || activeTranscodes.has(id)) {
    return; // Already cached or currently transcoding
  }

  const url = `https://www.youtube.com/watch?v=${id}`;
  const tempPath = path.join(cacheDir, `${id}.tmp`);
  const downloadPath = path.join(cacheDir, `${id}.download`);
  
  console.log(`[Cache] Starting optimized background transcode for video: ${id}`);
  
  // Step 1: Download bestaudio to a local file.
  // Downloading to a local file bypasses YouTube's play-rate throttling on piped stdout.
  const ytDlpArgs = [...getBaseYtDlpArgs(), '-f', 'bestaudio', '-o', downloadPath, url];
  const ytDlp = spawn('yt-dlp', ytDlpArgs);
  
  activeTranscodes.set(id, { ytDlp, tempPath, downloadPath });

  ytDlp.on('close', (code) => {
    if (code !== 0) {
      console.error(`[Cache] yt-dlp download failed with code ${code} for video: ${id}`);
      if (fs.existsSync(downloadPath)) fs.unlinkSync(downloadPath);
      activeTranscodes.delete(id);
      return;
    }

    console.log(`[Cache] Download complete for ${id}. Starting ffmpeg transcoding...`);

    // Step 2: Transcode local file to MP3.
    // Transcoding from a local file allows ffmpeg to utilize multithreaded decoding and high-speed local disk I/O.
    const ffmpeg = spawn('ffmpeg', [
      '-i', downloadPath,
      '-f', 'mp3',
      '-acodec', 'libmp3lame',
      '-ab', '320k',
      '-threads', '0', // Use all available CPU cores
      '-y',
      tempPath
    ]);

    // Update active transcode mapping with ffmpeg process
    const current = activeTranscodes.get(id);
    if (current) {
      current.ffmpeg = ffmpeg;
    }

    ffmpeg.on('close', (ffmpegCode) => {
      activeTranscodes.delete(id);
      
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
          console.log(`[Cache] Completed background transcode: ${id}.mp3`);
        }
      } else {
        console.error(`[Cache] ffmpeg transcoding failed with code ${ffmpegCode} for video: ${id}`);
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      }
    });

    ffmpeg.on('error', (err) => {
      console.error(`[Cache] ffmpeg failed to start:`, err);
      activeTranscodes.delete(id);
      if (fs.existsSync(downloadPath)) fs.unlinkSync(downloadPath);
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    });
  });

  ytDlp.on('error', (err) => {
    console.error(`[Cache] yt-dlp failed to start:`, err);
    activeTranscodes.delete(id);
    if (fs.existsSync(downloadPath)) fs.unlinkSync(downloadPath);
  });
};

// Enable CORS
app.use(cors());

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Set EJS view engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Clean filename helper
const sanitizeFilename = (filename) => {
  return filename.replace(/[^a-zA-Z0-9\s-_]/g, '').replace(/\s+/g, '_') || 'convetube-audio';
};

// --- Web Page Routes ---

// ES Homepage
app.get('/', (req, res) => {
  res.render('index', {
    title: 'Convertidor YouTube a MP3 Gratis | Descargar Música de YouTube - ConveTube',
    description: 'El mejor convertidor YouTube a MP3 gratis. Convierte videos de YouTube a MP3 en segundos con alta calidad. Fácil, rápido y sin registro en ConveTube.',
    canonical: 'https://convetube.com/'
  });
});

// FR Subdirectory
app.get('/convertir-youtube-vers-mp3', (req, res) => {
  res.render('convertir-youtube-vers-mp3', {
    title: 'Convertir YouTube vers MP3 Gratuit | Télécharger Vidéo YouTube - ConveTube',
    description: 'Convertir YouTube vers MP3 gratuitement et en haute qualité. Télécharger vos musiques et vidéos préférées de YouTube en quelques secondes sur ConveTube.',
    canonical: 'https://convetube.com/convertir-youtube-vers-mp3/'
  });
});

// ES Secondary Page
app.get('/convertidor-de-youtube-a-mp3', (req, res) => {
  res.render('convertidor-de-youtube-a-mp3', {
    title: 'Convertidor de YouTube a MP3 en Alta Calidad | ConveTube',
    description: 'Usa el mejor convertidor de YouTube a MP3 online. Descarga audio MP3 de videos de YouTube de forma rápida, segura y totalmente gratis.',
    canonical: 'https://convetube.com/convertidor-de-youtube-a-mp3/'
  });
});

// ES Tertiary Page
app.get('/convertidor-de-youtube-a-mp3/convertir-videos-de-youtube-a-mp3', (req, res) => {
  res.render('convertir-videos-de-youtube-a-mp3', {
    title: 'Cómo Convertir Videos de YouTube a MP3 Paso a Paso | ConveTube',
    description: 'Guía y herramienta para convertir videos de YouTube a MP3. Descarga música y audio de YouTube a tu dispositivo móvil o PC con la mejor calidad.',
    canonical: 'https://convetube.com/convertidor-de-youtube-a-mp3/convertir-videos-de-youtube-a-mp3/'
  });
});

// ES No Tube Page
app.get('/convertidor-mp3-no-tube', (req, res) => {
  res.render('convertidor-mp3-no-tube', {
    title: 'Convertidor MP3 No Tube Gratis | La Mejor Alternativa - ConveTube',
    description: '¿Buscas un convertidor mp3 no tube rápido y sin publicidad? ConveTube es la mejor alternativa gratuita para convertir videos de YouTube a MP3 online.',
    canonical: 'https://convetube.com/convertidor-mp3-no-tube/'
  });
});

// ES Descargar Page
app.get('/descargar-videos-de-youtube-a-mp3-gratis-online', (req, res) => {
  res.render('descargar-videos-de-youtube-a-mp3-gratis-online', {
    title: 'Descargar Videos de YouTube a MP3 Gratis Online | ConveTube',
    description: 'Descarga videos de YouTube a MP3 gratis y online en alta calidad (320kbps). Extrae pistas de audio de forma segura y rápida con ConveTube.',
    canonical: 'https://convetube.com/descargar-videos-de-youtube-a-mp3-gratis-online/'
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
    <loc>https://convetube.com/convertidor-de-youtube-a-mp3/convertir-videos-de-youtube-a-mp3/</loc>
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>
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
</urlset>`);
});

// Robots.txt
app.get('/robots.txt', (req, res) => {
  res.set('Content-Type', 'text/plain');
  res.send(`User-agent: *\nAllow: /\nSitemap: https://convetube.com/sitemap.xml`);
});

// --- API Routes ---

// 0. Check if cached MP3 is ready
app.get('/api/cache-status', (req, res) => {
  const id = req.query.id;
  if (!id) {
    return res.status(400).json({ error: 'Video ID is required' });
  }

  const cachePath = path.join(cacheDir, `${id}.mp3`);
  if (fs.existsSync(cachePath)) {
    const stats = fs.statSync(cachePath);
    return res.json({ ready: true, size: stats.size });
  }

  // Check if transcoding is in progress
  const isTranscoding = activeTranscodes.has(id);
  return res.json({ ready: false, transcoding: isTranscoding });
});

// 1. Fetch Video Metadata
app.get('/api/info', (req, res) => {
  const videoUrl = req.query.url;
  if (!videoUrl) {
    return res.status(400).json({ error: 'URL parameter is required' });
  }

  // Get video details using yt-dlp (optimized for speed)
  const cmdPrefix = getExecPrefix();
  exec(`${cmdPrefix} -j --no-playlist --no-warnings --no-check-certificates --socket-timeout 10 "${videoUrl}"`, (error, stdout, stderr) => {
    if (error) {
      console.error('yt-dlp info error:', stderr);
      return res.status(500).json({ error: 'Failed to fetch video details' });
    }

    try {
      const data = JSON.parse(stdout);
      
      // Start background transcoding immediately
      startBackgroundTranscode(data.id);
      
      res.json({
        id: data.id,
        title: data.title,
        channel: data.uploader || 'ConveTube Engine',
        duration: data.duration, // In seconds
        thumbnail: data.thumbnail
      });
    } catch (e) {
      res.status(500).json({ error: 'Failed to parse metadata' });
    }
  });
});

// 2. Stream Audio Live
app.get('/api/stream', (req, res) => {
  const id = req.query.id;
  if (!id) {
    return res.status(400).send('Video ID is required');
  }

  const cachePath = path.join(cacheDir, `${id}.mp3`);
  
  // If cache exists, serve static file (supports seeking/range requests automatically)
  if (fs.existsSync(cachePath)) {
    return res.sendFile(cachePath);
  }

  const url = `https://www.youtube.com/watch?v=${id}`;
  
  res.setHeader('Content-Type', 'audio/mpeg');
  
  // Stream audio directly using yt-dlp and ffmpeg pipeline
  const ytDlpArgs = [...getBaseYtDlpArgs(), '-f', 'bestaudio', '-o', '-', url];
  const ytDlp = spawn('yt-dlp', ytDlpArgs);

  const ffmpeg = spawn('ffmpeg', [
    '-i', 'pipe:0',
    '-f', 'mp3',
    '-acodec', 'libmp3lame',
    '-ab', '128k',
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

// 3. Convert & Download High-Quality MP3 (320kbps)
app.get('/api/download', (req, res) => {
  const id = req.query.id;
  const rawTitle = req.query.title || 'audio';
  if (!id) {
    return res.status(400).send('Video ID is required');
  }

  const filename = sanitizeFilename(rawTitle) + '.mp3';
  const cachePath = path.join(cacheDir, `${id}.mp3`);

  // If a download token is provided, set a cookie so the client can detect when the download begins.
  const downloadToken = req.query.downloadToken;
  if (downloadToken) {
    res.cookie(downloadToken, 'true', { maxAge: 60000, httpOnly: false, path: '/' });
  }

  // If cache is ready, serve direct file download with Content-Length
  if (fs.existsSync(cachePath)) {
    console.log(`[Cache] Serving cached MP3 for direct download: ${filename}`);
    return res.download(cachePath, filename);
  }

  console.log(`[Cache] Cache not ready for ${id}, converting live...`);
  const url = `https://www.youtube.com/watch?v=${id}`;

  if (downloadToken) {
    res.cookie(downloadToken, 'true', { maxAge: 60000, httpOnly: false, path: '/' });
  }

  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  // Stream high-quality 320kbps MP3 directly
  const ytDlpArgs = [...getBaseYtDlpArgs(), '-f', 'bestaudio', '-o', '-', url];
  const ytDlp = spawn('yt-dlp', ytDlpArgs);

  const ffmpeg = spawn('ffmpeg', [
    '-i', 'pipe:0',
    '-f', 'mp3',
    '-acodec', 'libmp3lame',
    '-ab', '320k',
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
