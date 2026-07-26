const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();
app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'] }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const PORT = process.env.PORT || 3000;
const SKYID_URL = process.env.SKYID_URL || 'https://skymutant.onrender.com';
const ADMIN_LOGIN = process.env.ADMIN_LOGIN || 'SkyMonder';

// ====== Директории ======
const DATA_DIR = path.join(__dirname, 'data');
const VIDEO_DIR = path.join(__dirname, 'videos');
const UPLOAD_TEMP = path.join(__dirname, 'uploads');
[VIDEO_DIR, UPLOAD_TEMP, DATA_DIR].forEach(d => {
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

// ====== Multer ======
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_TEMP),
  filename: (req, file, cb) => cb(null, Date.now() + '_' + Math.random().toString(36).slice(2,8) + path.extname(file.originalname))
});
const upload = multer({
  storage,
  limits: {
    fileSize: 100 * 1024 * 1024, // 100 МБ (Render лимит)
    fieldSize: 50 * 1024 * 1024,
  }
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'Файл слишком большой (максимум 100 МБ)' });
    }
    return res.status(400).json({ error: err.message });
  }
  next(err);
});

// ====== Проверка токена SkyID ======
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

// ====== Профиль канала ======
app.get('/profile', authMiddleware, (req, res) => {
  let profile = dbGet('profiles', req.user.skyid);
  if (!profile) profile = { name: req.user.login, avatar: '', bio: '' };
  res.json(profile);
});
app.put('/profile', authMiddleware, (req, res) => {
  const { name, avatar, bio } = req.body;
  const profile = {
    name: name || req.user.login,
    avatar: avatar || '',
    bio: bio || ''
  };
  dbPut('profiles', req.user.skyid, profile);
  res.json(profile);
});

// ====== Загрузка видео (без конвертации) ======
app.post('/upload', authMiddleware, upload.single('video'), async (req, res) => {
  try {
    console.log('📥 Начало загрузки файла');
    const file = req.file;
    if (!file) {
      console.error('❌ Файл не получен');
      return res.status(400).json({ error: 'No video file' });
    }
    console.log(`📄 Имя: ${file.originalname}, Размер: ${file.size} байт`);
    const videoId = 'vid_' + Date.now();
    const videoPath = file.path;
    const { title, description, tags } = req.body;
    const tagArray = tags ? tags.split(',').map(t => t.trim()).filter(Boolean) : [];

    // Перемещаем в папку videos
    const targetPath = path.join(VIDEO_DIR, videoId + path.extname(file.originalname));
    fs.renameSync(videoPath, targetPath);

    const stat = fs.statSync(targetPath);

    // Метаданные видео
    const meta = {
      id: videoId,
      title: title || 'Без названия',
      description: description || '',
      tags: tagArray,
      author: req.user.login,
      authorSkyid: req.user.skyid,
      created: Date.now(),
      status: 'ready',
      likes: [],
      dislikes: [],
      views: 0,
      comments: [],
      filename: path.basename(targetPath),
      size: stat.size,
      mimetype: file.mimetype || 'video/mp4',
      duration: 0 // можно добавить позже через ffprobe
    };
    dbPut('videos', videoId, meta);

    console.log(`✅ Видео ${videoId} загружено`);
    res.json({ ok: true, videoId, video: meta });
  } catch (e) {
    console.error('❌ Ошибка загрузки:', e);
    if (req.file && req.file.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ error: 'Upload failed: ' + e.message });
  }
});

// ====== Стриминг видео (с поддержкой перемотки) ======
app.get('/video/:id', (req, res) => {
  const meta = dbGet('videos', req.params.id);
  if (!meta) return res.status(404).json({ error: 'Not found' });
  
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
      'Content-Type': meta.mimetype || 'video/mp4',
    };
    res.writeHead(206, head);
    file.pipe(res);
  } else {
    const head = {
      'Content-Length': fileSize,
      'Content-Type': meta.mimetype || 'video/mp4',
    };
    res.writeHead(200, head);
    fs.createReadStream(videoPath).pipe(res);
  }
});

// ====== Статус видео (всегда ready) ======
app.get('/video/:id/status', (req, res) => {
  const meta = dbGet('videos', req.params.id);
  if (!meta) return res.status(404).json({ error: 'Not found' });
  res.json({ status: 'ready', videoUrl: `/video/${meta.id}` });
});

// ====== Метаданные видео ======
app.get('/video/:id/meta', (req, res) => {
  const meta = dbGet('videos', req.params.id);
  if (!meta) return res.status(404).json({ error: 'Not found' });
  res.json(meta);
});

// ====== Лайки/дизлайки ======
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

// ====== Просмотры ======
app.post('/video/:id/view', (req, res) => {
  const meta = dbGet('videos', req.params.id);
  if (!meta) return res.status(404).json({ error: 'Not found' });
  meta.views = (meta.views || 0) + 1;
  dbPut('videos', req.params.id, meta);
  res.json({ views: meta.views });
});

// ====== Комментарии ======
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

// ====== Удаление видео ======
app.delete('/video/:id', authMiddleware, (req, res) => {
  const meta = dbGet('videos', req.params.id);
  if (!meta) return res.status(404).json({ error: 'Not found' });
  if (meta.skyid !== req.user.skyid && !req.isAdmin) return res.status(403).json({ error: 'Forbidden' });
  const videoPath = path.join(VIDEO_DIR, meta.filename);
  if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
  dbDelete('videos', req.params.id);
  res.json({ ok: true });
});

// ====== ПОДПИСКИ ======
// Подписаться на канал
app.post('/follow/:skyid', authMiddleware, (req, res) => {
  const targetSkyid = req.params.skyid;
  if (targetSkyid === req.user.skyid) return res.status(400).json({ error: 'Нельзя подписаться на себя' });
  
  let follows = dbGet('follows', req.user.skyid) || { following: [] };
  if (!follows.following.includes(targetSkyid)) {
    follows.following.push(targetSkyid);
    dbPut('follows', req.user.skyid, follows);
  }
  res.json({ ok: true, following: follows.following });
});

// Отписаться
app.delete('/follow/:skyid', authMiddleware, (req, res) => {
  const targetSkyid = req.params.skyid;
  let follows = dbGet('follows', req.user.skyid) || { following: [] };
  follows.following = follows.following.filter(id => id !== targetSkyid);
  dbPut('follows', req.user.skyid, follows);
  res.json({ ok: true, following: follows.following });
});

// Получить список подписок пользователя
app.get('/follow/following', authMiddleware, (req, res) => {
  const follows = dbGet('follows', req.user.skyid) || { following: [] };
  res.json({ following: follows.following });
});

// Получить список подписчиков канала (пользователи, которые подписались на данного)
app.get('/follow/followers/:skyid', (req, res) => {
  const targetSkyid = req.params.skyid;
  const allFollows = dbList('follows');
  const followers = [];
  for (const id of allFollows) {
    const data = dbGet('follows', id);
    if (data && data.following.includes(targetSkyid)) {
      followers.push(id);
    }
  }
  res.json({ followers });
});

// Проверить, подписан ли текущий пользователь на канал
app.get('/follow/check/:skyid', authMiddleware, (req, res) => {
  const targetSkyid = req.params.skyid;
  const follows = dbGet('follows', req.user.skyid) || { following: [] };
  res.json({ isFollowing: follows.following.includes(targetSkyid) });
});

// ====== Список видео ======
app.get('/list', (req, res) => {
  const ids = dbList('videos');
  const videos = ids.map(id => dbGet('videos', id)).filter(Boolean).sort((a,b) => b.created - a.created);
  res.json(videos);
});

// ====== Поиск ======
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

// ====== Администрирование ======
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

// ====== Проверка токена ======
app.get('/verify', authMiddleware, (req, res) => {
  res.json({ user: req.user, isAdmin: req.isAdmin });
});

// ====== Запуск сервера ======
const server = http.createServer(app);
server.timeout = 30 * 60 * 1000;
server.keepAliveTimeout = 30 * 60 * 1000;
server.headersTimeout = 60 * 60 * 1000;

server.listen(PORT, () => {
  console.log(`🚀 SkyVideo running on port ${PORT}`);
  console.log(`⚡ Без конвертации — видео доступны мгновенно!`);
});
