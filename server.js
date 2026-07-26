const express = require('express');
const http = require('http');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { spawn } = require('child_process');

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
const THUMB_DIR = path.join(VIDEO_DIR, 'thumbnails');
[VIDEO_DIR, UPLOAD_TEMP, DATA_DIR, THUMB_DIR].forEach(d => {
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
    fileSize: 100 * 1024 * 1024,
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

// ====== Настройки ИИ-модерации ======
const AI_API_URL = 'https://api-inference.huggingface.co/models/unitary/toxic-bert';
const AI_API_KEY = process.env.HF_API_KEY; // Получите ключ на huggingface.co
const TOXICITY_THRESHOLD = 0.8;

async function checkAI(text) {
  if (!AI_API_KEY) {
    console.warn('⚠️ HF_API_KEY не задан, ИИ-модерация отключена');
    return { toxic: false, score: 0 };
  }
  try {
    const response = await axios.post(
      AI_API_URL,
      { inputs: text },
      {
        headers: { Authorization: `Bearer ${AI_API_KEY}` },
        timeout: 5000,
      }
    );
    const results = response.data[0] || [];
    const toxic = results.find(r => r.label === 'toxic');
    const score = toxic ? toxic.score : 0;
    return { toxic: score >= TOXICITY_THRESHOLD, score };
  } catch (e) {
    console.error('❌ Ошибка ИИ-модерации:', e.message);
    return { toxic: false, score: 0 };
  }
}

// ====== Бан с длительностью ======
function banUserWithDuration(skyid, reason, days = 2) {
  const until = Date.now() + days * 24 * 60 * 60 * 1000;
  dbPut('bans', skyid, {
    skyid,
    reason: reason || 'Нарушение правил (ИИ)',
    bannedAt: Date.now(),
    until: until,
  });
  console.log(`🔨 Пользователь ${skyid} забанен до ${new Date(until).toISOString()}`);
}

function isUserBanned(skyid) {
  const ban = dbGet('bans', skyid);
  if (!ban) return false;
  if (ban.until && Date.now() > ban.until) {
    dbDelete('bans', skyid);
    return false;
  }
  return true;
}

// ====== Проверка токена и прав ======
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
    // Проверка бана
    if (isUserBanned(user.skyid)) {
      const ban = dbGet('bans', user.skyid);
      const remaining = Math.ceil((ban.until - Date.now()) / (1000 * 60 * 60));
      return res.status(403).json({
        error: `Вы забанены до ${new Date(ban.until).toLocaleString()}. Осталось ${remaining} часов.`
      });
    }
    req.user = user;
    req.isAdmin = (user.login === ADMIN_LOGIN);
    next();
  }).catch(() => res.status(401).json({ error: 'Invalid token' }));
}

function adminMiddleware(req, res, next) {
  if (!req.user || !req.isAdmin) {
    return res.status(403).json({ error: 'Forbidden. Только для администратора.' });
  }
  next();
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

// ====== Генерация превью ======
async function generateThumbnail(videoId, videoPath) {
  let ffmpegCmd = 'ffmpeg';
  try {
    await new Promise((resolve, reject) => {
      const test = spawn(ffmpegCmd, ['-version']);
      test.on('close', (code) => code === 0 ? resolve() : reject());
      test.on('error', reject);
    });
  } catch (e) {
    console.warn('⚠️ FFmpeg не установлен, превью не будет создано');
    return null;
  }
  const thumbPath = path.join(THUMB_DIR, videoId + '.jpg');
  try {
    const ff = spawn(ffmpegCmd, [
      '-i', videoPath,
      '-ss', '00:00:01',
      '-vframes', '1',
      '-vf', 'scale=320:180',
      '-q:v', '2',
      '-y',
      thumbPath
    ]);
    await new Promise((resolve, reject) => {
      ff.on('close', (code) => code === 0 ? resolve() : reject(new Error('FFmpeg failed')));
      ff.on('error', reject);
    });
    console.log(`✅ Превью создано для видео ${videoId}`);
    return `/thumbnails/${videoId}.jpg`;
  } catch (e) {
    console.error('❌ Ошибка генерации превью:', e.message);
    return null;
  }
}

// ====== Загрузка видео ======
app.post('/upload', authMiddleware, upload.single('video'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No video file' });
    const videoId = 'vid_' + Date.now();
    const videoPath = file.path;
    const { title, description, tags } = req.body;
    const tagArray = tags ? tags.split(',').map(t => t.trim()).filter(Boolean) : [];

    // ИИ-модерация
    const fullText = title + ' ' + description + ' ' + (tags || '').join(' ');
    const aiResult = await checkAI(fullText);
    if (aiResult.toxic) {
      if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
      banUserWithDuration(req.user.skyid, 'Токсичный контент в видео');
      return res.status(403).json({ error: 'Ваше видео содержит неприемлемый контент. Вы забанены на 2 дня.' });
    }

    const targetPath = path.join(VIDEO_DIR, videoId + path.extname(file.originalname));
    fs.renameSync(videoPath, targetPath);
    const stat = fs.statSync(targetPath);

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
      duration: 0,
      thumbnail: null,
      moderated: true
    };
    dbPut('videos', videoId, meta);

    generateThumbnail(videoId, targetPath).then(thumbUrl => {
      if (thumbUrl) {
        const updated = dbGet('videos', videoId);
        if (updated) {
          updated.thumbnail = thumbUrl;
          dbPut('videos', videoId, updated);
        }
      }
    });

    res.json({ ok: true, videoId, video: meta });
  } catch (e) {
    console.error('❌ Ошибка загрузки:', e);
    if (req.file && req.file.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ error: 'Upload failed: ' + e.message });
  }
});

// ====== Раздача превью ======
app.get('/thumbnails/:filename', (req, res) => {
  const thumbPath = path.join(THUMB_DIR, req.params.filename);
  if (!fs.existsSync(thumbPath)) return res.status(404).send('Not found');
  res.sendFile(thumbPath);
});

// ====== Стриминг ======
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
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': meta.mimetype || 'video/mp4',
    });
    file.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': meta.mimetype || 'video/mp4',
    });
    fs.createReadStream(videoPath).pipe(res);
  }
});

// ====== Статус ======
app.get('/video/:id/status', (req, res) => {
  const meta = dbGet('videos', req.params.id);
  if (!meta) return res.status(404).json({ error: 'Not found' });
  res.json({ status: 'ready', videoUrl: `/video/${meta.id}` });
});

// ====== Метаданные ======
app.get('/video/:id/meta', (req, res) => {
  const meta = dbGet('videos', req.params.id);
  if (!meta) return res.status(404).json({ error: 'Not found' });
  res.json(meta);
});

// ====== Лайки ======
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
app.post('/video/:id/comment', authMiddleware, async (req, res) => {
  const meta = dbGet('videos', req.params.id);
  if (!meta) return res.status(404).json({ error: 'Not found' });
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'Text required' });

  // ИИ-модерация комментария
  const aiResult = await checkAI(text);
  if (aiResult.toxic) {
    banUserWithDuration(req.user.skyid, 'Токсичный комментарий');
    return res.status(403).json({ error: 'Ваш комментарий содержит неприемлемый контент. Вы забанены на 2 дня.' });
  }

  const comment = { id: 'cmt_' + Date.now(), skyid: req.user.skyid, author: req.user.login, text, created: Date.now() };
  meta.comments.push(comment);
  dbPut('videos', req.params.id, meta);
  res.json(comment);
});
app.put('/video/:id/comment/:commentId', authMiddleware, async (req, res) => {
  const meta = dbGet('videos', req.params.id);
  if (!meta) return res.status(404).json({ error: 'Not found' });
  const comment = meta.comments.find(c => c.id === req.params.commentId);
  if (!comment) return res.status(404).json({ error: 'Comment not found' });
  if (comment.skyid !== req.user.skyid && !req.isAdmin) return res.status(403).json({ error: 'Forbidden' });

  // ИИ-модерация при редактировании
  const aiResult = await checkAI(req.body.text);
  if (aiResult.toxic) {
    banUserWithDuration(req.user.skyid, 'Токсичный комментарий (редактирование)');
    return res.status(403).json({ error: 'Ваш комментарий содержит неприемлемый контент. Вы забанены на 2 дня.' });
  }

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
  if (meta.authorSkyid !== req.user.skyid && !req.isAdmin) return res.status(403).json({ error: 'Forbidden' });
  const videoPath = path.join(VIDEO_DIR, meta.filename);
  if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
  const thumbPath = path.join(THUMB_DIR, meta.id + '.jpg');
  if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
  dbDelete('videos', req.params.id);
  res.json({ ok: true });
});

// ====== Подписки ======
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
app.delete('/follow/:skyid', authMiddleware, (req, res) => {
  const targetSkyid = req.params.skyid;
  let follows = dbGet('follows', req.user.skyid) || { following: [] };
  follows.following = follows.following.filter(id => id !== targetSkyid);
  dbPut('follows', req.user.skyid, follows);
  res.json({ ok: true, following: follows.following });
});
app.get('/follow/following', authMiddleware, (req, res) => {
  const follows = dbGet('follows', req.user.skyid) || { following: [] };
  res.json({ following: follows.following });
});
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
app.get('/follow/check/:skyid', authMiddleware, (req, res) => {
  const targetSkyid = req.params.skyid;
  const follows = dbGet('follows', req.user.skyid) || { following: [] };
  res.json({ isFollowing: follows.following.includes(targetSkyid) });
});

// ====== Админ-панель ======
app.get('/admin/panel', authMiddleware, adminMiddleware, (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>Админ-панель SkyVideo</title>
      <style>
        body { background: #0a0f1e; color: #e0e8ff; font-family: Arial, sans-serif; padding: 20px; }
        h1 { color: #5f7ecf; }
        .admin-section { background: #1a233a; border: 1px solid #2a3450; border-radius: 12px; padding: 20px; margin-bottom: 20px; }
        .admin-section h2 { border-bottom: 1px solid #2a3450; padding-bottom: 10px; }
        button { background: #5f7ecf; border: none; color: white; padding: 6px 12px; border-radius: 6px; cursor: pointer; }
        .btn-danger { background: #c44; }
        .item { background: #111827; padding: 10px; border-radius: 8px; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center; }
        .item .actions { display: flex; gap: 8px; }
        input, textarea { background: #0d1225; border: 1px solid #3a4660; color: white; padding: 6px; border-radius: 6px; width: 100%; margin-bottom: 8px; }
      </style>
    </head>
    <body>
      <h1>🛡️ Админ-панель SkyVideo</h1>
      <div id="app">
        <div class="admin-section">
          <h2>📹 Все видео</h2>
          <div id="video-list">Загрузка...</div>
        </div>
        <div class="admin-section">
          <h2>💬 Все комментарии</h2>
          <div id="comments-list">Загрузка...</div>
        </div>
        <div class="admin-section">
          <h2>🚫 Бан пользователей</h2>
          <input type="text" id="ban-skyid" placeholder="SkyID пользователя">
          <button onclick="banUser()">Забанить (2 дня)</button>
          <button onclick="unbanUser()" class="btn-danger">Разбанить</button>
          <div id="ban-result"></div>
        </div>
        <div class="admin-section">
          <h2>🔒 Забаненные (срок)</h2>
          <div id="banned-list">Загрузка...</div>
        </div>
      </div>
      <script>
        const API_BASE = 'https://skyvideo.onrender.com';
        let token = localStorage.getItem('skyvideo_token');

        async function apiFetch(url, options = {}) {
          const headers = { 'Content-Type': 'application/json' };
          if (token) headers['Authorization'] = 'Bearer ' + token;
          const res = await fetch(API_BASE + url, { ...options, headers });
          if (!res.ok) throw new Error(await res.text());
          return res.json();
        }

        async function loadVideos() {
          const data = await apiFetch('/admin/videos');
          const container = document.getElementById('video-list');
          if (!data.length) { container.innerHTML = '<p>Нет видео</p>'; return; }
          container.innerHTML = data.map(v => \`
            <div class="item">
              <div><strong>\${v.title}</strong> (автор: \${v.author})</div>
              <div class="actions">
                <button onclick="deleteVideo('\${v.id}')" class="btn-danger">Удалить</button>
              </div>
            </div>
          \`).join('');
        }

        async function loadComments() {
          const videos = await apiFetch('/admin/videos');
          let allComments = [];
          for (const v of videos) {
            allComments = allComments.concat((v.comments || []).map(c => ({ ...c, videoId: v.id, videoTitle: v.title })));
          }
          const container = document.getElementById('comments-list');
          if (!allComments.length) { container.innerHTML = '<p>Нет комментариев</p>'; return; }
          container.innerHTML = allComments.map(c => \`
            <div class="item">
              <div><strong>\${c.author}</strong>: \${c.text} (видео: \${c.videoTitle})</div>
              <div class="actions">
                <button onclick="deleteComment('\${c.videoId}','\${c.id}')" class="btn-danger">Удалить</button>
              </div>
            </div>
          \`).join('');
        }

        async function deleteVideo(videoId) {
          if (!confirm('Удалить видео?')) return;
          await apiFetch('/admin/video/' + videoId, { method: 'DELETE' });
          loadVideos();
        }

        async function deleteComment(videoId, commentId) {
          if (!confirm('Удалить комментарий?')) return;
          await apiFetch('/admin/comment/' + videoId + '/' + commentId, { method: 'DELETE' });
          loadComments();
        }

        async function banUser() {
          const skyid = document.getElementById('ban-skyid').value.trim();
          if (!skyid) return alert('Введите SkyID');
          await apiFetch('/admin/ban', { method: 'POST', body: JSON.stringify({ skyid }) });
          document.getElementById('ban-result').textContent = '✅ Пользователь забанен на 2 дня';
          loadBanned();
        }

        async function unbanUser() {
          const skyid = document.getElementById('ban-skyid').value.trim();
          if (!skyid) return alert('Введите SkyID');
          await apiFetch('/admin/unban', { method: 'POST', body: JSON.stringify({ skyid }) });
          document.getElementById('ban-result').textContent = '✅ Пользователь разбанен';
          loadBanned();
        }

        async function loadBanned() {
          const data = await apiFetch('/admin/banned');
          const container = document.getElementById('banned-list');
          if (!data.length) { container.innerHTML = '<p>Нет забаненных</p>'; return; }
          container.innerHTML = data.map(b => \`
            <div class="item">
              <div>
                <strong>\${b.skyid}</strong>
                <span style="color:#8899cc;">(до \${new Date(b.until).toLocaleString()})</span>
              </div>
              <div class="actions">
                <button onclick="unbanUserById('\${b.skyid}')" class="btn-danger">Разбанить</button>
              </div>
            </div>
          \`).join('');
        }

        // Дополнительная функция для разбана по клику из списка
        window.unbanUserById = async (skyid) => {
          await apiFetch('/admin/unban', { method: 'POST', body: JSON.stringify({ skyid }) });
          loadBanned();
        };

        loadVideos();
        loadComments();
        loadBanned();
      </script>
    </body>
    </html>
  `);
});

// Админ-эндпоинты
app.get('/admin/videos', authMiddleware, adminMiddleware, (req, res) => {
  const ids = dbList('videos');
  const videos = ids.map(id => dbGet('videos', id)).filter(Boolean).sort((a,b) => b.created - a.created);
  res.json(videos);
});

app.delete('/admin/video/:videoId', authMiddleware, adminMiddleware, (req, res) => {
  const meta = dbGet('videos', req.params.videoId);
  if (!meta) return res.status(404).json({ error: 'Not found' });
  const videoPath = path.join(VIDEO_DIR, meta.filename);
  if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
  const thumbPath = path.join(THUMB_DIR, meta.id + '.jpg');
  if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
  dbDelete('videos', req.params.videoId);
  res.json({ ok: true });
});

app.delete('/admin/comment/:videoId/:commentId', authMiddleware, adminMiddleware, (req, res) => {
  const meta = dbGet('videos', req.params.videoId);
  if (!meta) return res.status(404).json({ error: 'Video not found' });
  const comment = meta.comments.find(c => c.id === req.params.commentId);
  if (!comment) return res.status(404).json({ error: 'Comment not found' });
  meta.comments = meta.comments.filter(c => c.id !== req.params.commentId);
  dbPut('videos', req.params.videoId, meta);
  res.json({ ok: true });
});

app.post('/admin/ban', authMiddleware, adminMiddleware, (req, res) => {
  const { skyid } = req.body;
  if (!skyid) return res.status(400).json({ error: 'skyid required' });
  banUserWithDuration(skyid, 'Ручной бан (админ)', 2);
  res.json({ ok: true });
});

app.post('/admin/unban', authMiddleware, adminMiddleware, (req, res) => {
  const { skyid } = req.body;
  dbDelete('bans', skyid);
  res.json({ ok: true });
});

app.get('/admin/banned', authMiddleware, adminMiddleware, (req, res) => {
  const ids = dbList('bans');
  const banned = ids.map(id => dbGet('bans', id)).filter(Boolean);
  // Фильтруем только активные
  const active = banned.filter(b => !b.until || Date.now() < b.until);
  res.json(active);
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

// ====== Проверка токена ======
app.get('/verify', authMiddleware, (req, res) => {
  res.json({ user: req.user, isAdmin: req.isAdmin });
});

// ====== Запуск ======
const server = http.createServer(app);
server.timeout = 30 * 60 * 1000;
server.keepAliveTimeout = 30 * 60 * 1000;
server.headersTimeout = 60 * 60 * 1000;

server.listen(PORT, () => {
  console.log(`🚀 SkyVideo running on port ${PORT}`);
  console.log(`🤖 ИИ-модерация ${AI_API_KEY ? 'активна' : 'отключена (нет ключа)'}`);
});
