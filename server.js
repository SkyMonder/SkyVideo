const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { spawn } = require('child_process');

const app = express();

// ====== Увеличенные лимиты и таймауты ======
app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'] }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const PORT = process.env.PORT || 3000;
const SKYID_URL = process.env.SKYID_URL || 'https://skymutant.onrender.com';
const ADMIN_LOGIN = process.env.ADMIN_LOGIN || 'SkyMonder';

// Директории
const DATA_DIR = path.join(__dirname, 'data');
const VIDEO_DIR = path.join(__dirname, 'videos');
const UPLOAD_TEMP = path.join(__dirname, 'uploads');
const HLS_DIR = path.join(VIDEO_DIR, 'hls');
[VIDEO_DIR, UPLOAD_TEMP, HLS_DIR, DATA_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ====== Файловая БД ======
function dbPut(bucket, key, data) {
  const dir = path.join(DATA_DIR, bucket);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, key + '.json'), JSON.stringify(data));
}
function dbGet(bucket, key) {
  const file = path.join(DATA_DIR, bucket, key + '.json');
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (e) { return null; }
}
function dbList(bucket) {
  const dir = path.join(DATA_DIR, bucket);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5));
}
function dbDelete(bucket, key) {
  const file = path.join(DATA_DIR, bucket, key + '.json');
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

// ====== Multer с большими лимитами ======
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // Убедимся, что папка существует
    if (!fs.existsSync(UPLOAD_TEMP)) fs.mkdirSync(UPLOAD_TEMP, { recursive: true });
    cb(null, UPLOAD_TEMP);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '_' + Math.random().toString(36).slice(2,8) + path.extname(file.originalname));
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 500 * 1024 * 1024, // 500 МБ (максимум для Render)
    fieldSize: 50 * 1024 * 1024,
    parts: 100,
    headerPairs: 2000
  }
});

// Обработка ошибок multer
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'Файл слишком большой (максимум 500 МБ)' });
    }
    return res.status(400).json({ error: err.message });
  }
  next(err);
});

// ====== Поиск FFmpeg ======
function findBinary(name) {
  const envVar = process.env[name.toUpperCase() + '_PATH'];
  if (envVar && fs.existsSync(envVar)) return envVar;
  const localPath = path.join(__dirname, 'bin', name);
  if (fs.existsSync(localPath)) return localPath;
  try {
    const which = require('child_process').execSync(`which ${name}`, { encoding: 'utf8' }).trim();
    if (which && fs.existsSync(which)) return which;
  } catch (e) {}
  return name;
}
const FFMPEG_PATH = findBinary('ffmpeg');
const FFPROBE_PATH = findBinary('ffprobe');
console.log(`🔧 FFmpeg: ${FFMPEG_PATH}`);
console.log(`🔧 FFprobe: ${FFPROBE_PATH}`);

// ====== Проверка токена ======
async function verifySkyToken(token) {
  try {
    const res = await axios.get(`${SKYID_URL}/me`, { headers: { Authorization: `Bearer ${token}` } });
    return res.data;
  } catch (e) { return null; }
}

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization?.replace('Bearer ', '');
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  verifySkyToken(auth).then(user => {
    if (!user) return res.status(401).json({ error: 'Invalid token' });
    req.user = user;
    req.isAdmin = (user.login === ADMIN_LOGIN);
    next();
  }).catch(() => res.status(401).json({ error: 'Invalid token' }));
}

// ====== Health ======
app.get('/healthix', (req, res) => res.json({ status: 'ok', service: 'skyvideo' }));

// ====== OAuth ======
app.get('/auth/login', (req, res) => {
  const clientId = 'skyvideo';
  const scope = req.query.scope || 'profile email';
  const host = req.headers.host || `localhost:${PORT}`;
  const redirectUri = `https://${host}/auth/callback`;
  const state = crypto.randomBytes(8).toString('hex');
  const loginUrl = `${SKYID_URL}/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scope)}&state=${state}`;
  res.json({ loginUrl });
});
app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Missing code');
  try {
    const tokenRes = await axios.post(`${SKYID_URL}/oauth/token`, {
      code,
      client_id: 'skyvideo',
      client_secret: 'skyvideo_secret'
    });
    const { access_token, skyid, login } = tokenRes.data;
    res.redirect(`/auth/success?token=${access_token}&skyid=${skyid}&login=${login}`);
  } catch (e) {
    console.error('OAuth callback error:', e.response?.data || e);
    res.status(500).send('OAuth failed');
  }
});
app.get('/auth/success', (req, res) => {
  const { token, skyid, login } = req.query;
  res.send(`
    <!DOCTYPE html>
    <html>
    <head><meta charset="UTF-8"><title>Успешный вход</title></head>
    <body>
      <script>
        localStorage.setItem('skyvideo_token', '${token}');
        localStorage.setItem('skyvideo_skyid', '${skyid}');
        localStorage.setItem('skyvideo_login', '${login}');
        window.location.href = '/';
      </script>
    </body>
    </html>
  `);
});

// ====== Профиль ======
app.get('/profile', authMiddleware, (req, res) => {
  let profile = dbGet('profiles', req.user.skyid);
  if (!profile) profile = { name: req.user.login, avatar: '' };
  res.json(profile);
});
app.put('/profile', authMiddleware, (req, res) => {
  const { name, avatar } = req.body;
  const profile = { name: name || req.user.login, avatar: avatar || '' };
  dbPut('profiles', req.user.skyid, profile);
  res.json(profile);
});

// ====== Конфигурация качества (оптимизирована для скорости) ======
const QUALITY_CONFIGS = [
  { label: '720p', width: 1280, height: 720, bitrate: '1500k', maxrate: '1500k', bufsize: '3000k' },
  { label: '480p', width: 854, height: 480, bitrate: '800k', maxrate: '800k', bufsize: '1600k' }
];

// ====== Загрузка видео (асинхронная) ======
app.post('/upload', authMiddleware, upload.single('video'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No video file' });
    const videoId = 'vid_' + Date.now();
    const originalPath = file.path;
    const { title, description, tags } = req.body;
    const tagArray = tags ? tags.split(',').map(t => t.trim()).filter(Boolean) : [];

    // Сразу сохраняем метаданные со статусом "processing"
    const meta = {
      id: videoId,
      title: title || 'Без названия',
      description: description || '',
      tags: tagArray,
      author: req.user.login,
      skyid: req.user.skyid,
      created: Date.now(),
      status: 'processing',
      likes: [],
      dislikes: [],
      views: 0,
      comments: [],
      hlsMaster: null,
      qualities: []
    };
    dbPut('videos', videoId, meta);

    // Возвращаем ответ немедленно
    res.json({ ok: true, videoId, status: 'processing' });

    // Запускаем фоновую конвертацию (не ждём)
    processVideoInBackground(videoId, originalPath);
  } catch (e) {
    console.error('Upload error:', e);
    // Если ошибка, удаляем загруженный файл, если он есть
    if (req.file && req.file.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ error: 'Upload failed: ' + e.message });
  }
});

// ====== Фоновая обработка ======
async function processVideoInBackground(videoId, originalPath) {
  try {
    const meta = dbGet('videos', videoId);
    if (!meta) throw new Error('Video not found');

    const hlsVideoDir = path.join(HLS_DIR, videoId);
    if (!fs.existsSync(hlsVideoDir)) fs.mkdirSync(hlsVideoDir, { recursive: true });

    // Получаем разрешение
    let videoWidth = 1920, videoHeight = 1080;
    try {
      const probe = spawn(FFPROBE_PATH, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', originalPath]);
      const output = await new Promise((resolve, reject) => {
        let data = '';
        probe.stdout.on('data', chunk => data += chunk);
        probe.stderr.on('data', chunk => console.error(chunk.toString()));
        probe.on('close', code => code === 0 ? resolve(data) : reject(new Error('ffprobe failed')));
      });
      const [w, h] = output.trim().split(',').map(Number);
      if (w && h) { videoWidth = w; videoHeight = h; }
    } catch (e) { console.warn('Could not probe video, using default 1080p'); }

    // Фильтруем качества
    const validQualities = QUALITY_CONFIGS.filter(q => q.width <= videoWidth && q.height <= videoHeight);
    if (validQualities.length === 0) {
      validQualities.push({ label: 'original', width: videoWidth, height: videoHeight, bitrate: '1500k', maxrate: '1500k', bufsize: '3000k' });
    }

    const variantStreams = [];
    for (const quality of validQualities) {
      const qualityDir = path.join(hlsVideoDir, quality.label);
      if (!fs.existsSync(qualityDir)) fs.mkdirSync(qualityDir, { recursive: true });

      const playlistPath = path.join(qualityDir, 'playlist.m3u8');
      const segmentPattern = path.join(qualityDir, 'segment_%03d.ts');

      const ffmpegArgs = [
        '-i', originalPath,
        '-c:v', 'libx264',
        '-b:v', '800k',           // снижаем битрейт до 800k
        '-maxrate', '800k',
        '-bufsize', '1600k',
        '-preset', 'ultrafast',   // вместо veryfast (быстрее на 30-50%)
        '-profile:v', 'high',
        '-vf', 'scale=854:480',   // только одно качество 480p (отключаем 720p)
        '-c:a', 'aac',
        '-b:a', '96k',            // снижаем аудио битрейт
        '-f', 'hls',
        '-hls_time', '10',        // увеличиваем сегменты до 10 секунд (меньше файлов)
        '-hls_playlist_type', 'vod',
        '-hls_segment_filename', segmentPattern,
        playlistPath
      ];

      await new Promise((resolve, reject) => {
        const ff = spawn(FFMPEG_PATH, ffmpegArgs);
        let stderr = '';
        ff.stderr.on('data', d => { stderr += d.toString(); console.log(d.toString()); });
        ff.on('close', code => {
          if (code === 0) resolve();
          else reject(new Error(`FFmpeg for ${quality.label} failed with code ${code}: ${stderr}`));
        });
        ff.on('error', reject);
      });

      variantStreams.push({
        label: quality.label,
        width: quality.width,
        height: quality.height,
        bitrate: quality.bitrate,
        playlist: `/video/${videoId}/${quality.label}/playlist.m3u8`
      });
    }

    // Мастер-плейлист
    let masterContent = '#EXTM3U\n#EXT-X-VERSION:3\n';
    for (const v of variantStreams) {
      const bitrateNum = parseInt(v.bitrate);
      const resolution = `${v.width}x${v.height}`;
      masterContent += `#EXT-X-STREAM-INF:BANDWIDTH=${bitrateNum*1000},RESOLUTION=${resolution}\n${v.playlist}\n`;
    }
    const masterPath = path.join(hlsVideoDir, 'master.m3u8');
    fs.writeFileSync(masterPath, masterContent);

    // Удаляем оригинал
    if (fs.existsSync(originalPath)) fs.unlinkSync(originalPath);

    // Обновляем метаданные
    meta.status = 'ready';
    meta.hlsMaster = `/video/${videoId}/master.m3u8`;
    meta.qualities = variantStreams.map(v => ({ label: v.label, width: v.width, height: v.height, bitrate: v.bitrate }));
    dbPut('videos', videoId, meta);

    console.log(`✅ Video ${videoId} processed successfully`);
  } catch (e) {
    console.error(`❌ Video ${videoId} processing failed:`, e);
    const meta = dbGet('videos', videoId);
    if (meta) {
      meta.status = 'failed';
      dbPut('videos', videoId, meta);
    }
    if (fs.existsSync(originalPath)) fs.unlinkSync(originalPath);
  }
}

// ====== Статус видео ======
app.get('/video/:id/status', (req, res) => {
  const meta = dbGet('videos', req.params.id);
  if (!meta) return res.status(404).json({ error: 'Not found' });
  res.json({ status: meta.status, hlsMaster: meta.hlsMaster });
});

// ====== HLS endpoints ======
app.get('/video/:videoId/master.m3u8', (req, res) => {
  const { videoId } = req.params;
  const masterPath = path.join(HLS_DIR, videoId, 'master.m3u8');
  if (!fs.existsSync(masterPath)) return res.status(404).send('Master playlist not found');
  res.set('Content-Type', 'application/vnd.apple.mpegurl');
  res.sendFile(masterPath);
});
app.get('/video/:videoId/:quality/playlist.m3u8', (req, res) => {
  const { videoId, quality } = req.params;
  const playlistPath = path.join(HLS_DIR, videoId, quality, 'playlist.m3u8');
  if (!fs.existsSync(playlistPath)) return res.status(404).send('Playlist not found');
  res.set('Content-Type', 'application/vnd.apple.mpegurl');
  res.sendFile(playlistPath);
});
app.get('/video/:videoId/:quality/:segment', (req, res) => {
  const { videoId, quality, segment } = req.params;
  const segPath = path.join(HLS_DIR, videoId, quality, segment);
  if (!fs.existsSync(segPath)) return res.status(404).send('Segment not found');
  res.set('Content-Type', 'video/MP2T');
  res.sendFile(segPath);
});

// ====== Fallback MP4 ======
app.get('/video/:id', (req, res) => {
  const meta = dbGet('videos', req.params.id);
  if (!meta) return res.status(404).json({ error: 'Not found' });
  if (meta.hlsMaster) return res.redirect(meta.hlsMaster);
  const videoPath = path.join(VIDEO_DIR, meta.filename);
  if (!fs.existsSync(videoPath)) return res.status(404).json({ error: 'File not found' });
  const stat = fs.statSync(videoPath); const fileSize = stat.size;
  const range = req.headers.range;
  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunksize = (end - start) + 1;
    const file = fs.createReadStream(videoPath, { start, end });
    res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${fileSize}`, 'Accept-Ranges': 'bytes', 'Content-Length': chunksize, 'Content-Type': 'video/mp4' });
    file.pipe(res);
  } else {
    res.writeHead(200, { 'Content-Length': fileSize, 'Content-Type': 'video/mp4' });
    fs.createReadStream(videoPath).pipe(res);
  }
});

// ====== Остальные эндпоинты (мета, лайки, комменты и т.д.) ======
app.get('/video/:id/meta', (req, res) => {
  const meta = dbGet('videos', req.params.id);
  if (!meta) return res.status(404).json({ error: 'Not found' });
  res.json(meta);
});
app.post('/video/:id/like', authMiddleware, (req, res) => {
  const meta = dbGet('videos', req.params.id);
  if (!meta) return res.status(404).json({ error: 'Not found' });
  meta.dislikes = meta.dislikes.filter(u => u !== req.user.skyid);
  if (!meta.likes.includes(req.user.skyid)) meta.likes.push(req.user.skyid);
  else meta.likes = meta.likes.filter(u => u !== req.user.skyid);
  dbPut('videos', req.params.id, meta);
  res.json({ likes: meta.likes.length, dislikes: meta.dislikes.length });
});
app.post('/video/:id/dislike', authMiddleware, (req, res) => {
  const meta = dbGet('videos', req.params.id);
  if (!meta) return res.status(404).json({ error: 'Not found' });
  meta.likes = meta.likes.filter(u => u !== req.user.skyid);
  if (!meta.dislikes.includes(req.user.skyid)) meta.dislikes.push(req.user.skyid);
  else meta.dislikes = meta.dislikes.filter(u => u !== req.user.skyid);
  dbPut('videos', req.params.id, meta);
  res.json({ likes: meta.likes.length, dislikes: meta.dislikes.length });
});
app.post('/video/:id/view', (req, res) => {
  const meta = dbGet('videos', req.params.id);
  if (!meta) return res.status(404).json({ error: 'Not found' });
  meta.views = (meta.views || 0) + 1;
  dbPut('videos', req.params.id, meta);
  res.json({ views: meta.views });
});
app.get('/video/:id/comments', (req, res) => {
  const meta = dbGet('videos', req.params.id);
  if (!meta) return res.status(404).json({ error: 'Not found' });
  res.json(meta.comments || []);
});
app.post('/video/:id/comment', authMiddleware, (req, res) => {
  const meta = dbGet('videos', req.params.id);
  if (!meta) return res.status(404).json({ error: 'Not found' });
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'Text required' });
  const comment = { id: 'cmt_' + Date.now(), skyid: req.user.skyid, author: req.user.login, text, created: Date.now() };
  meta.comments.push(comment);
  dbPut('videos', req.params.id, meta);
  res.json(comment);
});
app.put('/video/:id/comment/:commentId', authMiddleware, (req, res) => {
  const meta = dbGet('videos', req.params.id);
  if (!meta) return res.status(404).json({ error: 'Not found' });
  const comment = meta.comments.find(c => c.id === req.params.commentId);
  if (!comment) return res.status(404).json({ error: 'Comment not found' });
  if (comment.skyid !== req.user.skyid && !req.isAdmin) return res.status(403).json({ error: 'Forbidden' });
  comment.text = req.body.text;
  dbPut('videos', req.params.id, meta);
  res.json(comment);
});
app.delete('/video/:id/comment/:commentId', authMiddleware, (req, res) => {
  const meta = dbGet('videos', req.params.id);
  if (!meta) return res.status(404).json({ error: 'Not found' });
  const comment = meta.comments.find(c => c.id === req.params.commentId);
  if (!comment) return res.status(404).json({ error: 'Comment not found' });
  if (comment.skyid !== req.user.skyid && !req.isAdmin) return res.status(403).json({ error: 'Forbidden' });
  meta.comments = meta.comments.filter(c => c.id !== req.params.commentId);
  dbPut('videos', req.params.id, meta);
  res.json({ ok: true });
});
app.delete('/video/:id', authMiddleware, (req, res) => {
  const meta = dbGet('videos', req.params.id);
  if (!meta) return res.status(404).json({ error: 'Not found' });
  if (meta.skyid !== req.user.skyid && !req.isAdmin) return res.status(403).json({ error: 'Forbidden' });
  const hlsDir = path.join(HLS_DIR, req.params.id);
  if (fs.existsSync(hlsDir)) fs.rmSync(hlsDir, { recursive: true, force: true });
  if (meta.filename) {
    const videoPath = path.join(VIDEO_DIR, meta.filename);
    if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
  }
  dbDelete('videos', req.params.id);
  res.json({ ok: true });
});
app.post('/admin/ban', authMiddleware, (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'Forbidden' });
  const { skyid } = req.body;
  if (!skyid) return res.status(400).json({ error: 'skyid required' });
  dbPut('bans', skyid, { skyid, bannedAt: Date.now() });
  res.json({ ok: true });
});
app.post('/admin/unban', authMiddleware, (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'Forbidden' });
  const { skyid } = req.body;
  dbDelete('bans', skyid);
  res.json({ ok: true });
});
app.get('/list', (req, res) => {
  const ids = dbList('videos');
  const videos = ids.map(id => dbGet('videos', id)).filter(Boolean).sort((a,b) => b.created - a.created);
  res.json(videos);
});
app.get('/search', (req, res) => {
  const q = (req.query.q || '').toLowerCase();
  const ids = dbList('videos');
  const results = [];
  for (const id of ids) {
    const meta = dbGet('videos', id);
    if (!meta) continue;
    if (meta.title.toLowerCase().includes(q) || meta.description.toLowerCase().includes(q) || meta.tags.some(tag => tag.toLowerCase().includes(q))) {
      results.push(meta);
    }
  }
  res.json(results.sort((a,b) => b.created - a.created));
});
app.get('/verify', authMiddleware, (req, res) => {
  res.json({ user: req.user, isAdmin: req.isAdmin });
});

// ====== Запуск сервера с таймаутами ======
const server = http.createServer(app);

// Увеличиваем таймауты для больших файлов
server.timeout = 30 * 60 * 1000; // 30 минут
server.keepAliveTimeout = 30 * 60 * 1000;
server.headersTimeout = 60 * 60 * 1000; // 1 час

server.listen(PORT, () => {
  console.log(`🚀 SkyVideo running on port ${PORT}`);
  console.log(`⏱️  Таймауты: ${server.timeout/1000}с, Keep-Alive: ${server.keepAliveTimeout/1000}с`);
});
