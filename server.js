require('dotenv').config({ quiet: true, override: true });
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const { scrapeSubreddit } = require('./scraper');
const { pool, initSchema } = require('./db');
const {
  hashPassword,
  verifyPassword,
  setSessionCookie,
  clearSessionCookie,
  attachUser,
  requireAuth,
  isValidEmail,
  GOOGLE_ENABLED,
  buildGoogleAuthUrl,
  exchangeGoogleCode,
  randomState,
} = require('./auth');
const { askAboutPosts, LLM_ENABLED } = require('./llm');
const createTopicsRouter = require('./topics');

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_LOG_LINES = 300;
const JOB_MEMORY_TTL_MS = 2 * 60 * 60 * 1000; // 2 часа в паметта (после само от базата)
const MAX_QUEUE_LENGTH = 15;
const MAX_PENDING_PER_USER = 2;

// commentLimit: null = без посещение на всеки пост (само списък); число = текст + до N топ коментара
const COMMENT_MODES = {
  none: { commentLimit: null, maxPosts: 300 },
  body: { commentLimit: 0, maxPosts: 150 },
  top3: { commentLimit: 3, maxPosts: 80 },
  top10: { commentLimit: 10, maxPosts: 80 },
  top25: { commentLimit: 25, maxPosts: 50 },
  top50: { commentLimit: 50, maxPosts: 50 },
  top100: { commentLimit: 100, maxPosts: 30 },
  all: { commentLimit: 500, maxPosts: 20 },
};

app.use(express.json());
app.use(cookieParser());
app.use(attachUser);
const topicsRouter = createTopicsRouter({ pool, requireAuth });
app.use(topicsRouter);
app.use(express.static(path.join(__dirname, 'public')));

// --- Job опашка (в паметта; резултатите се пазят трайно в Postgres) ---
const jobs = new Map(); // id -> live job state (log, progress) докато е скорошен
let runningJobId = null;
const queue = [];

function cleanupOldJobs() {
  const now = Date.now();
  for (const [id, job] of jobs.entries()) {
    if (job.status !== 'running' && now - job.createdAt > JOB_MEMORY_TTL_MS) jobs.delete(id);
  }
}
setInterval(cleanupOldJobs, 15 * 60 * 1000).unref();

function pushLog(job, message) {
  job.log.push({ t: Date.now(), message });
  if (job.log.length > MAX_LOG_LINES) job.log.shift();
}

async function persistJob(job) {
  await pool.query(
    `INSERT INTO jobs (id, user_id, subreddit, sort, time_filter, post_limit, comment_mode, status, post_count, posts, error, created_at, finished_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, to_timestamp($12/1000.0), $13)
     ON CONFLICT (id) DO UPDATE SET status=$8, post_count=$9, posts=$10, error=$11, finished_at=$13`,
    [
      job.id,
      job.userId,
      job.params.subreddit,
      job.params.sort,
      job.params.timeFilter,
      job.params.limit,
      job.params.commentMode,
      job.status,
      job.posts ? job.posts.length : null,
      job.posts ? JSON.stringify(job.posts) : null,
      job.error,
      job.createdAt,
      job.finishedAt ? new Date(job.finishedAt) : null,
    ]
  );
}

function processQueue() {
  if (runningJobId) return;
  const nextId = queue.shift();
  if (!nextId) return;
  const job = jobs.get(nextId);
  if (!job) return processQueue();

  runningJobId = nextId;
  job.status = 'running';
  pushLog(job, 'Стартиране на скрейпването...');
  persistJob(job).catch(() => {});

  scrapeSubreddit({ ...job.params, commentLimit: COMMENT_MODES[job.params.commentMode].commentLimit }, (evt) => {
    job.progress = { phase: evt.phase, current: evt.current ?? job.progress.current, total: evt.total ?? job.progress.total };
    pushLog(job, evt.message);
  })
    .then(async (posts) => {
      job.posts = posts;
      job.status = 'done';
      job.finishedAt = Date.now();
      await persistJob(job).catch((e) => pushLog(job, `Грешка при запис в базата: ${e.message}`));
    })
    .catch(async (err) => {
      job.status = 'error';
      job.error = err.message || String(err);
      job.finishedAt = Date.now();
      pushLog(job, `ГРЕШКА: ${job.error}`);
      await persistJob(job).catch(() => {});
    })
    .finally(() => {
      runningJobId = null;
      processQueue();
    });
}

// ===================== AUTH =====================

app.post('/api/auth/signup', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!isValidEmail(email)) return res.status(400).json({ error: 'Невалиден email.' });
    if (!password || password.length < 8) return res.status(400).json({ error: 'Паролата трябва да е поне 8 символа.' });

    const existing = await pool.query('SELECT id FROM users WHERE email=$1', [email.toLowerCase()]);
    if (existing.rows.length) return res.status(409).json({ error: 'Вече има акаунт с този email.' });

    const hash = await hashPassword(password);
    const result = await pool.query(
      'INSERT INTO users (email, password_hash) VALUES ($1,$2) RETURNING id, email',
      [email.toLowerCase(), hash]
    );
    const user = result.rows[0];
    setSessionCookie(res, user);
    res.json({ user: { email: user.email } });
  } catch (err) {
    res.status(500).json({ error: 'Грешка при регистрация: ' + err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!isValidEmail(email) || !password) return res.status(400).json({ error: 'Липсва email или парола.' });

    const result = await pool.query('SELECT id, email, password_hash FROM users WHERE email=$1', [email.toLowerCase()]);
    const user = result.rows[0];
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      return res.status(401).json({ error: 'Грешен email или парола.' });
    }
    setSessionCookie(res, user);
    res.json({ user: { email: user.email } });
  } catch (err) {
    res.status(500).json({ error: 'Грешка при вход: ' + err.message });
  }
});

app.post('/api/auth/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  res.json({ user: req.user, googleEnabled: GOOGLE_ENABLED, llmEnabled: LLM_ENABLED });
});

app.get('/auth/google/start', (req, res) => {
  if (!GOOGLE_ENABLED) return res.status(503).send('Google login не е конфигуриран.');
  const state = randomState();
  res.cookie('oauth_state', state, {
    httpOnly: true,
    maxAge: 10 * 60 * 1000,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  });
  res.redirect(buildGoogleAuthUrl(state));
});

app.get('/auth/google/callback', async (req, res) => {
  try {
    if (!GOOGLE_ENABLED) return res.status(503).send('Google login не е конфигуриран.');
    const { code, state } = req.query;
    const expectedState = req.cookies && req.cookies.oauth_state;
    if (!code || !state || state !== expectedState) {
      return res.status(400).send('Невалидна OAuth сесия. Опитай отново.');
    }
    res.clearCookie('oauth_state');

    const profile = await exchangeGoogleCode(code);
    if (!profile.email) throw new Error('Google не върна email адрес.');

    const existing = await pool.query('SELECT id, email FROM users WHERE google_id=$1 OR email=$2', [profile.sub, profile.email.toLowerCase()]);
    let user;
    if (existing.rows.length) {
      user = existing.rows[0];
      await pool.query('UPDATE users SET google_id=$1, display_name=$2 WHERE id=$3', [profile.sub, profile.name || null, user.id]);
    } else {
      const inserted = await pool.query(
        'INSERT INTO users (email, google_id, display_name) VALUES ($1,$2,$3) RETURNING id, email',
        [profile.email.toLowerCase(), profile.sub, profile.name || null]
      );
      user = inserted.rows[0];
    }
    setSessionCookie(res, user);
    res.redirect('/');
  } catch (err) {
    res.status(500).send('Грешка при Google вход: ' + err.message);
  }
});

// ===================== SCRAPE =====================

app.post('/api/scrape', requireAuth, async (req, res) => {
  const pendingForUser = [...jobs.values()].filter(
    (j) => j.userId === req.user.id && (j.status === 'queued' || j.status === 'running')
  ).length;
  if (pendingForUser >= MAX_PENDING_PER_USER) {
    return res.status(429).json({ error: `Вече имаш ${pendingForUser} чакащи/активни задачи. Изчакай да приключат.` });
  }
  if (queue.length >= MAX_QUEUE_LENGTH) {
    return res.status(429).json({ error: 'Опашката е пълна в момента. Опитай отново след малко.' });
  }

  const { subreddit, sort, timeFilter, limit, commentMode } = req.body || {};
  const cleanSubreddit = String(subreddit || '').trim().replace(/^\/?r\//i, '').replace(/[^a-zA-Z0-9_]/g, '');
  if (!cleanSubreddit) return res.status(400).json({ error: 'Липсва валидно име на сабредит.' });
  const cleanSort = ['hot', 'new', 'top'].includes(sort) ? sort : 'hot';
  const cleanTimeFilter = ['hour', 'day', 'week', 'month', 'year', 'all'].includes(timeFilter) ? timeFilter : 'all';
  const cleanCommentMode = Object.prototype.hasOwnProperty.call(COMMENT_MODES, commentMode) ? commentMode : 'none';
  const modeConfig = COMMENT_MODES[cleanCommentMode];
  const cleanLimit = Math.max(1, Math.min(modeConfig.maxPosts, parseInt(limit, 10) || 50));

  if (parseInt(limit, 10) > modeConfig.maxPosts) {
    return res.status(400).json({ error: `За избрания режим на коментари лимитът е максимум ${modeConfig.maxPosts} поста (заявени: ${parseInt(limit, 10)}).` });
  }

  const jobId = crypto.randomBytes(8).toString('hex');
  const job = {
    id: jobId,
    userId: req.user.id,
    status: 'queued',
    params: { subreddit: cleanSubreddit, sort: cleanSort, timeFilter: cleanTimeFilter, limit: cleanLimit, commentMode: cleanCommentMode },
    progress: { phase: 'queued', current: 0, total: cleanLimit },
    log: [],
    posts: null,
    error: null,
    createdAt: Date.now(),
    finishedAt: null,
  };
  jobs.set(jobId, job);
  queue.push(jobId);
  pushLog(job, `Заявка приета (позиция в опашката: ${queue.length}): r/${cleanSubreddit}, sort=${cleanSort}${cleanSort === 'top' ? `(${cleanTimeFilter})` : ''}, limit=${cleanLimit}, comments=${cleanCommentMode}`);

  processQueue();
  res.json({ jobId });
});

async function loadJobOwned(jobId, userId) {
  const mem = jobs.get(jobId);
  if (mem && mem.userId === userId) return { source: 'memory', job: mem };
  const dbRes = await pool.query('SELECT * FROM jobs WHERE id=$1 AND user_id=$2', [jobId, userId]);
  if (!dbRes.rows.length) return null;
  const row = dbRes.rows[0];
  return {
    source: 'db',
    job: {
      id: row.id,
      userId: row.user_id,
      status: row.status,
      params: { subreddit: row.subreddit, sort: row.sort, timeFilter: row.time_filter, limit: row.post_limit, commentMode: row.comment_mode },
      posts: row.posts,
      error: row.error,
      log: [],
    },
  };
}

app.get('/api/jobs/:id', requireAuth, async (req, res) => {
  const found = await loadJobOwned(req.params.id, req.user.id);
  if (!found) return res.status(404).json({ error: 'Job не е намерен.' });
  const job = found.job;
  const sinceIdx = parseInt(req.query.sinceLog, 10) || 0;
  res.json({
    id: job.id,
    status: job.status,
    params: job.params,
    progress: job.progress || { phase: job.status, current: 0, total: 0 },
    error: job.error,
    postCount: job.posts ? job.posts.length : null,
    log: (job.log || []).slice(sinceIdx),
    logLength: (job.log || []).length,
    queuePosition: job.status === 'queued' ? queue.indexOf(job.id) + 1 : 0,
  });
});

app.get('/api/jobs/:id/results', requireAuth, async (req, res) => {
  const found = await loadJobOwned(req.params.id, req.user.id);
  if (!found) return res.status(404).json({ error: 'Job не е намерен.' });
  if (found.job.status !== 'done') return res.status(409).json({ error: `Job все още не е готов (статус: ${found.job.status}).` });
  res.json({ params: found.job.params, posts: found.job.posts });
});

function toCSVValue(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (/[",\n]/.test(str)) return '"' + str.replace(/"/g, '""') + '"';
  return str;
}

app.get('/api/jobs/:id/export.:format', requireAuth, async (req, res) => {
  const found = await loadJobOwned(req.params.id, req.user.id);
  if (!found) return res.status(404).json({ error: 'Job не е намерен.' });
  if (found.job.status !== 'done') return res.status(409).json({ error: `Job все още не е готов (статус: ${found.job.status}).` });

  const format = req.params.format;
  const filenameBase = `reddit_${found.job.params.subreddit}_${found.job.params.sort}`;

  if (format === 'json') {
    res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}.json"`);
    res.setHeader('Content-Type', 'application/json');
    return res.send(JSON.stringify(found.job.posts, null, 2));
  }
  if (format === 'csv') {
    const headers = found.job.params.commentMode !== 'none'
      ? ['title', 'author', 'votes', 'comments', 'url', 'date', 'postType', 'bodyText']
      : ['title', 'author', 'votes', 'comments', 'url', 'date', 'postType'];
    const lines = [headers.join(',')];
    for (const p of found.job.posts) lines.push(headers.map((h) => toCSVValue(p[h])).join(','));
    res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}.csv"`);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    return res.send(lines.join('\n'));
  }
  res.status(400).json({ error: 'Неподдържан формат (json или csv).' });
});

// ===================== Q&A (OpenRouter) =====================

app.post('/api/jobs/:id/ask', requireAuth, async (req, res) => {
  try {
    const { question, useOwnKnowledge } = req.body || {};
    if (!question || !question.trim()) return res.status(400).json({ error: 'Липсва въпрос.' });

    const found = await loadJobOwned(req.params.id, req.user.id);
    if (!found) return res.status(404).json({ error: 'Job не е намерен.' });
    if (found.job.status !== 'done' || !found.job.posts || !found.job.posts.length) {
      return res.status(409).json({ error: 'Job-ът трябва да е завършен и с резултати, за да питаш по него.' });
    }

    const result = await askAboutPosts({
      posts: found.job.posts,
      question: question.trim(),
      subreddit: found.job.params.subreddit,
      useOwnKnowledge: Boolean(useOwnKnowledge),
    });

    const saved = await pool.query(
      'INSERT INTO qa (job_id, user_id, question, answer) VALUES ($1,$2,$3,$4) RETURNING id, created_at',
      [req.params.id, req.user.id, question.trim(), result.answer]
    );

    res.json({
      id: saved.rows[0].id,
      question: question.trim(),
      answer: result.answer,
      createdAt: saved.rows[0].created_at,
      includedCount: result.includedCount,
      totalCount: result.totalCount,
      truncated: result.truncated,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/jobs/:id/qa', requireAuth, async (req, res) => {
  const found = await loadJobOwned(req.params.id, req.user.id);
  if (!found) return res.status(404).json({ error: 'Job не е намерен.' });
  const result = await pool.query('SELECT id, question, answer, created_at FROM qa WHERE job_id=$1 AND user_id=$2 ORDER BY created_at ASC', [req.params.id, req.user.id]);
  res.json({ qa: result.rows });
});

// ===================== HISTORY =====================

app.get('/api/history', requireAuth, async (req, res) => {
  const result = await pool.query(
    `SELECT id, subreddit, sort, time_filter, post_limit, comment_mode, status, post_count, error, created_at, finished_at
     FROM jobs WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100`,
    [req.user.id]
  );
  res.json({ jobs: result.rows });
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

// ===================== DEV LIVE-RELOAD =====================
// Само локално (NODE_ENV !== 'production'): при промяна във public/ бутваме
// съобщение по WebSocket, а при рестарт на самия сървър (nodemon) връзката
// пада и клиентският скрипт презарежда страницата щом успее да се свърже пак.
function setupDevReload(httpServer) {
  if (process.env.NODE_ENV === 'production') return;
  const { WebSocketServer } = require('ws');
  const wss = new WebSocketServer({ noServer: true });
  httpServer.on('upgrade', (req, socket, head) => {
    if (req.url !== '/__dev_reload') return;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
  });
  fs.watch(path.join(__dirname, 'public'), { recursive: true }, () => {
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) client.send('reload');
    }
  });
  console.log('Dev live-reload: enabled (watching public/)');
}

initSchema()
  .then(() => {
    const httpServer = app.listen(PORT, () => {
      console.log(`Reddit Scraper App listening on port ${PORT}`);
      console.log(`Google login: ${GOOGLE_ENABLED ? 'enabled' : 'disabled'}, LLM Q&A: ${LLM_ENABLED ? 'enabled' : 'disabled'}`);
    });
    setupDevReload(httpServer);
    topicsRouter.recoverIncompleteState().catch((err) => console.error('Topic recovery грешка:', err));
  })
  .catch((err) => {
    console.error('Неуспешна инициализация на базата данни:', err);
    process.exit(1);
  });
