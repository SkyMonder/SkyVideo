const express = require('express');
const http = require('http');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { spawn } = require('child_process');
const compression = require('compression');
const helmet = require('helmet');

const app = express();

// ====== МИДЛВЕР ДЛЯ ПРИНУДИТЕЛЬНЫХ CORS-ЗАГОЛОВКОВ (ДО ВСЕХ МАРШРУТОВ) ======
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-upload-token, Origin, Accept');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// ====== Защита и сжатие ======
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());

// ====== CORS (дублируем для надёжности) ======
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-upload-token', 'Origin', 'Accept'],
  credentials: true
}));
app.options('*', cors());

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ====== Глобальная обработка ошибок ======
process.on('uncaughtException', (err) => {
  console.error('💥 Uncaught Exception:', err.message);
  console.error(err.stack);
});
process.on('unhandledRejection', (err) => {
  console.error('💥 Unhandled Rejection:', err.message);
  console.error(err.stack);
});

const PORT = process.env.PORT || 3000;
const SKYID_URL = process.env.SKYID_URL || 'https://skymutant.onrender.com';
const ADMIN_LOGIN = process.env.ADMIN_LOGIN || 'SkyMonder';
const HF_API_KEY = process.env.HF_API_KEY || null;

// ====== Админ-панель ======
const ADMIN_PANEL_USER = process.env.ADMIN_PANEL_USER || 'QUEUUOENGO_28937YAG';
const ADMIN_PANEL_PASS = process.env.ADMIN_PANEL_PASS || 'BYOSOGB45BGWO45G7_34F';

// ====== Директории ======
const DATA_DIR = path.join(__dirname, 'data');
const VIDEO_DIR = path.join(__dirname, 'videos');
const UPLOAD_TEMP = path.join(__dirname, 'uploads');
const THUMB_DIR = path.join(VIDEO_DIR, 'thumbnails');
const HLS_DIR = path.join(VIDEO_DIR, 'hls');
[VIDEO_DIR, UPLOAD_TEMP, DATA_DIR, THUMB_DIR, HLS_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ====== Файловая БД ======
function dbPut(bucket, key, data) {
  const dir = path.join(DATA_DIR, bucket);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, key + '.json'), JSON.stringify(data, null, 2));
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
  limits: { fileSize: 100 * 1024 * 1024, fieldSize: 50 * 1024 * 1024 }
});
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Файл слишком большой (максимум 100 МБ)' });
    return res.status(400).json({ error: err.message });
  }
  next(err);
});

// ====== Модерация ======
const BAD_WORDS = ['идиот', 'дебил', 'тупой', 'лох', 'дурак', 'кретин', 'урод', 'ублюдок', 'сволочь', 'тварь', 'сука', 'блядь', 'хуй', 'пизда', 'залупа', 'мудак', 'редиска', 'спам', 'бан', 'мат', 'оскорбление', 'нецензурная', 'порно', 'наркотики', 'взлом', 'мошенничество', 'скам', 'фишинг'];
function containsBadWords(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return BAD_WORDS.some(word => lower.includes(word));
}
async function checkAI(text) {
  if (HF_API_KEY) {
    try {
      const res = await axios.post('https://api-inference.huggingface.co/models/Nelera/ru-toxicity-detection', { inputs: text }, {
        headers: { Authorization: `Bearer ${HF_API_KEY}` },
        timeout: 5000
      });
      const result = res.data[0] || {};
      const isToxic = result.label === 'LABEL_1';
      const score = result.score || 0;
      const local = containsBadWords(text);
      return { toxic: isToxic || local, score: Math.max(score, local ? 1 : 0) };
    } catch (e) {
      console.error('⚠️ Ошибка ИИ-модерации:', e.message);
    }
  }
  return { toxic: containsBadWords(text), score: containsBadWords(text) ? 1 : 0 };
}

// ====== Бан ======
function banUserWithDuration(skyid, reason, days = 2) {
  const until = Date.now() + days * 24 * 60 * 60 * 1000;
  dbPut('bans', skyid, { skyid, reason, bannedAt: Date.now(), until });
  console.log(`🔨 Пользователь ${skyid} забанен до ${new Date(until).toISOString()}`);
}
function isUserBanned(skyid) {
  const ban = dbGet('bans', skyid);
  if (!ban) return false;
  if (ban.until && Date.now() > ban.until) { dbDelete('bans', skyid); return false; }
  return true;
}

// ====== Auth ======
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
    if (isUserBanned(user.skyid)) {
      const ban = dbGet('bans', user.skyid);
      const remaining = Math.ceil((ban.until - Date.now()) / (1000 * 60 * 60));
      return res.status(403).json({ error: `Вы забанены до ${new Date(ban.until).toLocaleString()}. Осталось ${remaining} часов.` });
    }
    req.user = user;
    req.isAdmin = (user.login === ADMIN_LOGIN);
    next();
  }).catch(() => res.status(401).json({ error: 'Invalid token' }));
}

// ====== Админ-авторизация ======
const adminSessions = new Map();
function generateAdminToken() { return crypto.randomBytes(32).toString('hex'); }
function adminAuthMiddleware(req, res, next) {
  const auth = req.headers.authorization?.replace('Bearer ', '');
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  const session = adminSessions.get(auth);
  if (!session || Date.now() > session.expires) {
    adminSessions.delete(auth);
    return res.status(401).json({ error: 'Session expired' });
  }
  session.expires = Date.now() + 3600000;
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
    const tokenRes = await axios.post(`${SKYID_URL}/oauth/token`, { code, client_id: 'skyvideo', client_secret: 'skyvideo_secret' });
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
    <html><head><meta charset="UTF-8"><title>Успешный вход</title></head><body>
      <script>
        localStorage.setItem('skyvideo_token', '${token}');
        localStorage.setItem('skyvideo_skyid', '${skyid}');
        localStorage.setItem('skyvideo_login', '${login}');
        window.location.href = '/';
      </script>
    </body></html>
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
  const profile = { name: name || req.user.login, avatar: avatar || '', bio: bio || '' };
  dbPut('profiles', req.user.skyid, profile);
  res.json(profile);
});

// ====== Генерация превью ======
async function generateThumbnail(videoId, videoPath) {
  const thumbPath = path.join(THUMB_DIR, videoId + '.jpg');
  try {
    await new Promise((resolve, reject) => {
      const ff = spawn('ffmpeg', [
        '-i', videoPath,
        '-ss', '00:00:01',
        '-vframes', '1',
        '-vf', 'scale=320:180',
        '-q:v', '2',
        '-y',
        thumbPath
      ]);
      ff.on('close', code => code === 0 ? resolve() : reject(new Error(`FFmpeg exited with ${code}`)));
      ff.on('error', reject);
    });
    console.log(`✅ Превью создано для ${videoId}`);
    return `/thumbnails/${videoId}.jpg`;
  } catch (e) {
    console.error(`❌ Ошибка генерации превью для ${videoId}:`, e.message);
    return null;
  }
}

// ====== Фоновая обработка видео (HLS) ======
async function processVideoInBackground(videoId, originalPath) {
  console.log(`🔄 Начинаем обработку видео ${videoId}`);
  try {
    const meta = dbGet('videos', videoId);
    if (!meta) throw new Error('Video not found');

    const videoHlsDir = path.join(HLS_DIR, videoId);
    if (!fs.existsSync(videoHlsDir)) fs.mkdirSync(videoHlsDir, { recursive: true });

    const qualities = [
      { label: '360p', width: 640, height: 360, bitrate: '500k' },
      { label: '480p', width: 854, height: 480, bitrate: '1000k' },
      { label: '720p', width: 1280, height: 720, bitrate: '2000k' }
    ];

    const playlists = [];
    for (const q of qualities) {
      const outDir = path.join(videoHlsDir, q.label);
      if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
      const playlistPath = path.join(outDir, 'playlist.m3u8');
      const segPattern = path.join(outDir, 'segment_%03d.ts');

      await new Promise((resolve, reject) => {
        const ff = spawn('ffmpeg', [
          '-i', originalPath,
          '-c:v', 'libx264',
          '-b:v', q.bitrate,
          '-maxrate', q.bitrate,
          '-bufsize', q.bitrate,
          '-preset', 'veryfast',
          '-profile:v', 'high',
          '-vf', `scale=trunc(${q.width}/2)*2:trunc(${q.height}/2)*2`,
          '-c:a', 'aac',
          '-b:a', '128k',
          '-f', 'hls',
          '-hls_time', '6',
          '-hls_playlist_type', 'vod',
          '-hls_segment_filename', segPattern,
          playlistPath
        ]);
        ff.stderr.on('data', d => console.log(d.toString()));
        ff.on('close', code => code === 0 ? resolve() : reject(new Error(`FFmpeg for ${q.label} failed`)));
        ff.on('error', reject);
      });
      playlists.push({
        label: q.label,
        width: q.width,
        height: q.height,
        bitrate: q.bitrate,
        playlist: `/video/${videoId}/${q.label}/playlist.m3u8`
      });
    }

    let master = '#EXTM3U\n#EXT-X-VERSION:3\n';
    for (const p of playlists) {
      const bitrateNum = parseInt(p.bitrate);
      master += `#EXT-X-STREAM-INF:BANDWIDTH=${bitrateNum*1000},RESOLUTION=${p.width}x${p.height}\n${p.playlist}\n`;
    }
    const masterPath = path.join(videoHlsDir, 'master.m3u8');
    fs.writeFileSync(masterPath, master);

    if (fs.existsSync(originalPath)) fs.unlinkSync(originalPath);

    meta.status = 'ready';
    meta.hlsMaster = `/video/${videoId}/master.m3u8`;
    meta.qualities = playlists.map(p => ({
      label: p.label,
      width: p.width,
      height: p.height,
      bitrate: p.bitrate
    }));
    dbPut('videos', videoId, meta);

    const firstSeg = path.join(videoHlsDir, '360p', 'segment_000.ts');
    if (fs.existsSync(firstSeg)) {
      const thumbUrl = await generateThumbnail(videoId, firstSeg);
      if (thumbUrl) {
        meta.thumbnail = thumbUrl;
        dbPut('videos', videoId, meta);
      }
    }
    console.log(`✅ Видео ${videoId} обработано`);
  } catch (err) {
    console.error(`❌ Ошибка обработки видео ${videoId}:`, err.message);
    const meta = dbGet('videos', videoId);
    if (meta) {
      meta.status = 'failed';
      dbPut('videos', videoId, meta);
    }
    if (fs.existsSync(originalPath)) fs.unlinkSync(originalPath);
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

    const fullText = title + ' ' + description + ' ' + tagArray.join(' ');
    const aiResult = await checkAI(fullText);
    if (aiResult.toxic) {
      if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
      banUserWithDuration(req.user.skyid, 'Токсичный контент в видео');
      return res.status(403).json({ error: 'Ваше видео содержит неприемлемый контент. Вы забанены на 2 дня.' });
    }

    const meta = {
      id: videoId,
      title: title || 'Без названия',
      description: description || '',
      tags: tagArray,
      author: req.user.login,
      authorSkyid: req.user.skyid,
      created: Date.now(),
      status: 'processing',
      likes: [],
      dislikes: [],
      views: 0,
      comments: [],
      filename: null,
      size: 0,
      mimetype: file.mimetype || 'video/mp4',
      duration: 0,
      thumbnail: null,
      hlsMaster: null,
      qualities: []
    };
    dbPut('videos', videoId, meta);

    processVideoInBackground(videoId, videoPath);

    res.json({ ok: true, videoId, status: 'processing' });
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
  if (!fs.existsSync(thumbPath)) return res.status(404).json({ error: 'Not found' });
  res.sendFile(thumbPath);
});

// ====== HLS endpoints ======
app.get('/video/:videoId/master.m3u8', (req, res) => {
  const masterPath = path.join(HLS_DIR, req.params.videoId, 'master.m3u8');
  if (!fs.existsSync(masterPath)) return res.status(404).send('Master playlist not found');
  res.set('Content-Type', 'application/vnd.apple.mpegurl');
  res.sendFile(masterPath);
});
app.get('/video/:videoId/:quality/playlist.m3u8', (req, res) => {
  const playlistPath = path.join(HLS_DIR, req.params.videoId, req.params.quality, 'playlist.m3u8');
  if (!fs.existsSync(playlistPath)) return res.status(404).send('Playlist not found');
  res.set('Content-Type', 'application/vnd.apple.mpegurl');
  res.sendFile(playlistPath);
});
app.get('/video/:videoId/:quality/:segment', (req, res) => {
  const segPath = path.join(HLS_DIR, req.params.videoId, req.params.quality, req.params.segment);
  if (!fs.existsSync(segPath)) return res.status(404).send('Segment not found');
  res.set('Content-Type', 'video/MP2T');
  res.sendFile(segPath);
});

// ====== Статус ======
app.get('/video/:id/status', (req, res) => {
  const meta = dbGet('videos', req.params.id);
  if (!meta) return res.status(404).json({ error: 'Not found' });
  res.json({ status: meta.status, hlsMaster: meta.hlsMaster });
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
  const hlsDir = path.join(HLS_DIR, req.params.id);
  if (fs.existsSync(hlsDir)) fs.rmSync(hlsDir, { recursive: true, force: true });
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
app.post('/admin/login', (req, res) => {
  const { login, password } = req.body;
  if (login === ADMIN_PANEL_USER && password === ADMIN_PANEL_PASS) {
    const token = generateAdminToken();
    adminSessions.set(token, { created: Date.now(), expires: Date.now() + 3600000 });
    return res.json({ ok: true, token });
  }
  return res.status(401).json({ error: 'Неверные учётные данные' });
});

app.get('/admin/panel', (req, res) => {
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
        .error-message { color: #f48024; text-align: center; margin-top: 20px; }
        .login-form { max-width: 400px; margin: 0 auto; }
        .login-form input { width: 100%; padding: 10px; margin-bottom: 10px; }
        .login-form button { width: 100%; }
        .hidden { display: none; }
      </style>
    </head>
    <body>
      <h1>🛡️ Админ-панель SkyVideo</h1>
      <div id="app">
        <div id="login-form" class="login-form">
          <h2>Вход в админ-панель</h2>
          <input type="text" id="admin-login" placeholder="Логин">
          <input type="password" id="admin-password" placeholder="Пароль">
          <button onclick="login()">Войти</button>
          <div id="login-error" style="color:#c44; margin-top:10px;"></div>
        </div>
        <div id="admin-content" class="hidden">
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
      </div>
      <script>
        const API_BASE = '';
        let adminToken = localStorage.getItem('admin_token') || '';

        function checkAuth() {
          if (!adminToken) {
            document.getElementById('login-form').style.display = 'block';
            document.getElementById('admin-content').style.display = 'none';
            return;
          }
          fetch(API_BASE + '/admin/videos', {
            headers: { 'Authorization': 'Bearer ' + adminToken }
          })
          .then(res => {
            if (res.ok) {
              document.getElementById('login-form').style.display = 'none';
              document.getElementById('admin-content').style.display = 'block';
              loadVideos();
              loadComments();
              loadBanned();
            } else {
              localStorage.removeItem('admin_token');
              adminToken = '';
              document.getElementById('login-form').style.display = 'block';
              document.getElementById('admin-content').style.display = 'none';
            }
          })
          .catch(() => {
            localStorage.removeItem('admin_token');
            adminToken = '';
            document.getElementById('login-form').style.display = 'block';
            document.getElementById('admin-content').style.display = 'none';
          });
        }

        async function login() {
          const login = document.getElementById('admin-login').value.trim();
          const password = document.getElementById('admin-password').value.trim();
          if (!login || !password) {
            document.getElementById('login-error').textContent = 'Заполните все поля';
            return;
          }
          try {
            const res = await fetch(API_BASE + '/admin/login', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ login, password })
            });
            const data = await res.json();
            if (res.ok) {
              localStorage.setItem('admin_token', data.token);
              adminToken = data.token;
              document.getElementById('login-error').textContent = '';
              checkAuth();
            } else {
              document.getElementById('login-error').textContent = data.error || 'Ошибка входа';
            }
          } catch (e) {
            document.getElementById('login-error').textContent = 'Ошибка соединения';
          }
        }

        async function apiFetch(url, options = {}) {
          const headers = { 'Content-Type': 'application/json' };
          if (adminToken) headers['Authorization'] = 'Bearer ' + adminToken;
          const res = await fetch(API_BASE + url, { ...options, headers });
          if (!res.ok) {
            if (res.status === 401) {
              localStorage.removeItem('admin_token');
              adminToken = '';
              document.getElementById('login-form').style.display = 'block';
              document.getElementById('admin-content').style.display = 'none';
              throw new Error('Unauthorized');
            }
            throw new Error(await res.text());
          }
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

        window.unbanUserById = async (skyid) => {
          await apiFetch('/admin/unban', { method: 'POST', body: JSON.stringify({ skyid }) });
          loadBanned();
        };

        checkAuth();
      </script>
    </body>
    </html>
  `);
});

// ====== Админские эндпоинты ======
app.get('/admin/videos', adminAuthMiddleware, (req, res) => {
  const ids = dbList('videos');
  const videos = ids.map(id => dbGet('videos', id)).filter(Boolean).sort((a,b) => b.created - a.created);
  res.json(videos);
});

app.delete('/admin/video/:videoId', adminAuthMiddleware, (req, res) => {
  const meta = dbGet('videos', req.params.videoId);
  if (!meta) return res.status(404).json({ error: 'Not found' });
  const hlsDir = path.join(HLS_DIR, req.params.videoId);
  if (fs.existsSync(hlsDir)) fs.rmSync(hlsDir, { recursive: true, force: true });
  const thumbPath = path.join(THUMB_DIR, meta.id + '.jpg');
  if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
  dbDelete('videos', req.params.videoId);
  res.json({ ok: true });
});

app.delete('/admin/comment/:videoId/:commentId', adminAuthMiddleware, (req, res) => {
  const meta = dbGet('videos', req.params.videoId);
  if (!meta) return res.status(404).json({ error: 'Video not found' });
  const comment = meta.comments.find(c => c.id === req.params.commentId);
  if (!comment) return res.status(404).json({ error: 'Comment not found' });
  meta.comments = meta.comments.filter(c => c.id !== req.params.commentId);
  dbPut('videos', req.params.videoId, meta);
  res.json({ ok: true });
});

app.post('/admin/ban', adminAuthMiddleware, (req, res) => {
  const { skyid } = req.body;
  if (!skyid) return res.status(400).json({ error: 'skyid required' });
  banUserWithDuration(skyid, 'Ручной бан (админ)', 2);
  res.json({ ok: true });
});

app.post('/admin/unban', adminAuthMiddleware, (req, res) => {
  const { skyid } = req.body;
  dbDelete('bans', skyid);
  res.json({ ok: true });
});

app.get('/admin/banned', adminAuthMiddleware, (req, res) => {
  const ids = dbList('bans');
  const banned = ids.map(id => dbGet('bans', id)).filter(Boolean);
  const active = banned.filter(b => !b.until || Date.now() < b.until);
  res.json(active);
});

// ====== Список видео ======
app.get('/list', (req, res) => {
  try {
    const ids = dbList('videos');
    const videos = ids.map(id => dbGet('videos', id)).filter(Boolean).sort((a,b) => b.created - a.created);
    res.json(videos);
  } catch (e) {
    console.error('❌ Ошибка в /list:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ====== Поиск ======
app.get('/search', (req, res) => {
  const q = (req.query.q || '').toLowerCase();
  const ids = dbList('videos');
  const results = [];
  for (const id of ids) {
    const meta = dbGet('videos', id);
    if (!meta) continue;
    if (meta.title.toLowerCase().includes(q) ||
        meta.description.toLowerCase().includes(q) ||
        meta.tags.some(t => t.toLowerCase().includes(q))) {
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
  console.log(`⚡ Полный функционал: ИИ, FFmpeg, HLS, превью`);
  console.log(`🤖 ИИ-модерация ${HF_API_KEY ? 'активна' : 'отключена (локальный список)'}`);
});
