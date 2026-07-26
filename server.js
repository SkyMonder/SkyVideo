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
app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'] }));
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;
const SKYID_URL = process.env.SKYID_URL || 'https://skymutant.onrender.com'; // основной сервер
const DATA_DIR = path.join(__dirname, 'data');
const VIDEO_DIR = path.join(__dirname, 'videos');
const UPLOAD_TEMP = path.join(__dirname, 'uploads');

// Создаём папки
[VIDEO_DIR, UPLOAD_TEMP].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

// ---------- Файловая БД ----------
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

// ---------- Multer для загрузки видео ----------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_TEMP),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, Date.now() + '_' + Math.random().toString(36).slice(2,8) + ext);
  }
});
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } }); // 100 MB

// ---------- Проверка токена SkyID ----------
async function verifySkyToken(token) {
  try {
    const res = await axios.get(`${SKYID_URL}/me`, { headers: { Authorization: `Bearer ${token}` } });
    return res.data; // { skyid, login }
  } catch (e) { return null; }
}

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization?.replace('Bearer ', '');
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  verifySkyToken(auth).then(user => {
    if (!user) return res.status(401).json({ error: 'Invalid token' });
    req.user = user;
    next();
  });
}

// ========== Healthix ==========
app.get('/healthix', (req, res) => res.json({ status: 'ok', service: 'skyvideo' }));

// ========== Регистрация / вход (прокидываем на SkyID) ==========
app.post('/auth/register', async (req, res) => {
  // Используем существующий SkyID, отдельная регистрация не нужна
  const { login, password } = req.body;
  if (!login || !password) return res.status(400).json({ error: 'login/password required' });
  try {
    const resp = await axios.post(`${SKYID_URL}/register`, { login, password });
    res.json(resp.data);
  } catch (e) {
    res.status(e.response?.status || 500).json(e.response?.data || { error: 'Registration failed' });
  }
});

app.post('/auth/login', async (req, res) => {
  const { login, password } = req.body;
  if (!login || !password) return res.status(400).json({ error: 'login/password required' });
  try {
    const resp = await axios.post(`${SKYID_URL}/login`, { login, password });
    res.json(resp.data);
  } catch (e) {
    res.status(e.response?.status || 500).json(e.response?.data || { error: 'Login failed' });
  }
});

// ========== Загрузка видео ==========
app.post('/upload', authMiddleware, upload.single('video'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No video file' });

    const videoId = 'vid_' + Date.now();
    const originalPath = file.path;
    const optimizedPath = path.join(VIDEO_DIR, videoId + '.mp4');

    // Метаданные
    const { title, description, tags } = req.body;
    const tagArray = tags ? tags.split(',').map(t => t.trim()).filter(Boolean) : [];

    // Запускаем FFmpeg для сжатия
    const ffmpeg = spawn('ffmpeg', [
      '-i', originalPath,
      '-c:v', 'libx264',   // кодек H.264
      '-crf', '23',        // качество (чем меньше, тем лучше, 18-28 нормально)
      '-preset', 'veryfast',
      '-vf', 'scale=trunc(oh*a/2)*2:720', // ограничиваем высоту 720p (можно 1080)
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart',
      optimizedPath
    ]);

    let errorOccurred = false;
    ffmpeg.stderr.on('data', (data) => {
      console.log(`FFmpeg: ${data}`);
    });

    ffmpeg.on('close', (code) => {
      if (code !== 0) {
        errorOccurred = true;
        return res.status(500).json({ error: 'Video processing failed' });
      }
    });

    ffmpeg.on('error', (err) => {
      errorOccurred = true;
      console.error('FFmpeg error:', err);
      return res.status(500).json({ error: 'Video processing error' });
    });

    await new Promise((resolve, reject) => {
      ffmpeg.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error('FFmpeg failed'));
      });
    }).catch(() => {});

    if (errorOccurred) return;

    // Удаляем оригинал
    fs.unlinkSync(originalPath);

    // Сохраняем метаданные
    const meta = {
      id: videoId,
      title: title || 'Без названия',
      description: description || '',
      tags: tagArray,
      author: req.user.login,
      skyid: req.user.skyid,
      created: Date.now(),
      likes: [],
      dislikes: [],
      views: 0,
      comments: [],
      filename: videoId + '.mp4'
    };
    dbPut('videos', videoId, meta);

    res.json({ ok: true, video: meta });
  } catch (e) {
    console.error('Upload error:', e);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// ========== Стриминг видео ==========
app.get('/video/:id', (req, res) => {
  const videoId = req.params.id;
  const meta = dbGet('videos', videoId);
  if (!meta) return res.status(404).json({ error: 'Video not found' });

  const videoPath = path.join(VIDEO_DIR, meta.filename);
  if (!fs.existsSync(videoPath)) return res.status(404).json({ error: 'File not found' });

  const stat = fs.statSync(videoPath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunksize = (end - start) + 1;
    const file = fs.createReadStream(videoPath, { start, end });
    const head = {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': 'video/mp4',
    };
    res.writeHead(206, head);
    file.pipe(res);
  } else {
    const head = {
      'Content-Length': fileSize,
      'Content-Type': 'video/mp4',
    };
    res.writeHead(200, head);
    fs.createReadStream(videoPath).pipe(res);
  }
});

// ========== Метаданные видео ==========
app.get('/video/:id/meta', (req, res) => {
  const meta = dbGet('videos', req.params.id);
  if (!meta) return res.status(404).json({ error: 'Not found' });
  res.json(meta);
});

// ========== Лайк / Дизлайк ==========
app.post('/video/:id/like', authMiddleware, (req, res) => {
  const meta = dbGet('videos', req.params.id);
  if (!meta) return res.status(404).json({ error: 'Not found' });
  // Убираем дизлайк, ставим лайк
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

// ========== Просмотры ==========
app.post('/video/:id/view', (req, res) => {
  const meta = dbGet('videos', req.params.id);
  if (!meta) return res.status(404).json({ error: 'Not found' });
  meta.views = (meta.views || 0) + 1;
  dbPut('videos', req.params.id, meta);
  res.json({ views: meta.views });
});

// ========== Комментарии ==========
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
  const comment = {
    id: 'cmt_' + Date.now(),
    skyid: req.user.skyid,
    author: req.user.login,
    text,
    created: Date.now()
  };
  meta.comments.push(comment);
  dbPut('videos', req.params.id, meta);
  res.json(comment);
});

// ========== Список видео и поиск ==========
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
    if (
      meta.title.toLowerCase().includes(q) ||
      meta.description.toLowerCase().includes(q) ||
      meta.tags.some(tag => tag.toLowerCase().includes(q))
    ) {
      results.push(meta);
    }
  }
  res.json(results.sort((a,b) => b.created - a.created));
});

// ========== Запуск ==========
app.listen(PORT, () => console.log(`SkyVideo running on port ${PORT}`));
