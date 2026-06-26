import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn, exec } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

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

// --- API Routes ---

// 1. Fetch Video Metadata
app.get('/api/info', (req, res) => {
  const videoUrl = req.query.url;
  if (!videoUrl) {
    return res.status(400).json({ error: 'URL parameter is required' });
  }

  // Get video details using yt-dlp
  exec(`yt-dlp -j --no-playlist "${videoUrl}"`, (error, stdout, stderr) => {
    if (error) {
      console.error('yt-dlp info error:', stderr);
      return res.status(500).json({ error: 'Failed to fetch video details' });
    }

    try {
      const data = JSON.parse(stdout);
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

  const url = `https://www.youtube.com/watch?v=${id}`;
  
  res.setHeader('Content-Type', 'audio/mpeg');
  
  // Stream audio directly using yt-dlp and ffmpeg pipeline
  const ytDlp = spawn('yt-dlp', [
    '-f', 'bestaudio',
    '-o', '-',
    url
  ]);

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

  const url = `https://www.youtube.com/watch?v=${id}`;
  const filename = sanitizeFilename(rawTitle) + '.mp3';

  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  // Stream high-quality 320kbps MP3 directly
  const ytDlp = spawn('yt-dlp', [
    '-f', 'bestaudio',
    '-o', '-',
    url
  ]);

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
