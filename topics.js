const crypto = require('crypto');
const express = require('express');
const { scrapeSubreddit } = require('./scraper');
const { generateDigest, continueTopicChat, LLM_ENABLED } = require('./llm');

const MAX_SUBREDDITS = 3;
const DIGEST_SORT = 'top';
const DIGEST_TIME_FILTER = 'all';
const DIGEST_COMMENT_MODE = 'top50';
const DIGEST_COMMENT_LIMIT = 50;
// Кешът винаги се опитва да събере до толкова РЕАЛНИ (не-меме) постове на
// сабредит - конкретната тема после само отрязва до избрания от потребителя
// брой (ALLOWED_POST_COUNTS), така че всички теми споделят един кеш ред.
const DIGEST_MAX_POST_TARGET = 100;
const ALLOWED_POST_COUNTS = [10, 25, 50, 100];
const DEFAULT_POST_COUNT = 25;
const ALLOWED_DEPTHS = ['brief', 'standard', 'deep'];
const DEFAULT_DEPTH = 'standard';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 дни
const MAX_TOPICS_PENDING_PER_USER = 2;
const MAX_CACHED_POSTS = 150; // таван след merge на инкременталните обновявания

// С малки букви нарочно - Reddit имената на сабредити са case-insensitive,
// а нормализирането максимизира cache hit-овете между различни потребители.
function sanitizeSubreddit(raw) {
  return String(raw || '').trim().replace(/^\/?r\//i, '').replace(/[^a-zA-Z0-9_]/g, '').toLowerCase();
}

module.exports = function createTopicsRouter({ pool, requireAuth }) {
  const router = express.Router();

  // ===================== Споделена кеш опашка за сабредити =====================
  const cacheQueue = []; // масив от subreddit_cache.id
  let cacheRunningId = null;
  const cacheStatusText = new Map(); // subreddit_cache.id -> текущо съобщение за прогрес
  const pendingTopics = new Map(); // topicId -> { waitingOn: Set<cacheId>, subreddits: string[], query, useOwnKnowledge, userId }

  function processCacheQueue() {
    if (cacheRunningId) return;
    const id = cacheQueue.shift();
    if (id === undefined) return;
    cacheRunningId = id;
    runCacheScrape(id).finally(() => {
      cacheRunningId = null;
      processCacheQueue();
    });
  }

  async function runCacheScrape(id) {
    const row = (await pool.query('SELECT * FROM subreddit_cache WHERE id=$1', [id])).rows[0];
    if (!row) return;

    // Ако вече имаме постове от преди, това е опресняване на остарял кеш, не
    // първо скрейпване - скрейпваме само НОВИ постове (sort=new, отрязано на
    // датата на последното скрейпване) вместо да теглим всичко наново.
    // Коментарите на вече познатите постове НЕ се опресняват (виж бележката
    // в getOrCreateCacheEntry/README на функцията по-долу).
    const existingPosts = Array.isArray(row.posts) ? row.posts : [];
    const isIncremental = existingPosts.length > 0;
    const sinceDate = isIncremental ? new Date(row.updated_at).toISOString() : null;

    await pool.query("UPDATE subreddit_cache SET status='running', updated_at=now() WHERE id=$1", [id]);
    cacheStatusText.set(id, `Скрейпване на r/${row.subreddit}...`);
    try {
      const newPosts = await scrapeSubreddit(
        {
          subreddit: row.subreddit,
          sort: isIncremental ? 'new' : row.sort,
          timeFilter: row.time_filter,
          limit: DIGEST_MAX_POST_TARGET,
          commentLimit: DIGEST_COMMENT_LIMIT,
          sinceDate,
        },
        (evt) =>
          cacheStatusText.set(
            id,
            `r/${row.subreddit}${isIncremental ? ' (само нови постове)' : ''}: ${evt.message}`
          )
      );

      let mergedPosts = [...newPosts].sort((a, b) => (b.votes || 0) - (a.votes || 0));
      if (isIncremental) {
        const existingIds = new Set(existingPosts.map((p) => p.id));
        const trulyNew = newPosts.filter((p) => !existingIds.has(p.id));
        mergedPosts = [...trulyNew, ...existingPosts]
          .sort((a, b) => (b.votes || 0) - (a.votes || 0))
          .slice(0, MAX_CACHED_POSTS);
      }

      await pool.query(
        "UPDATE subreddit_cache SET status='done', posts=$2, post_count=$3, error=NULL, updated_at=now() WHERE id=$1",
        [id, JSON.stringify(mergedPosts), mergedPosts.length]
      );
    } catch (err) {
      await pool.query(
        "UPDATE subreddit_cache SET status='error', error=$2, updated_at=now() WHERE id=$1",
        [id, err.message || String(err)]
      );
    } finally {
      cacheStatusText.delete(id);
      await checkPendingTopics(id);
    }
  }

  async function getOrCreateCacheEntry(subreddit, userId) {
    const existing = (
      await pool.query(
        'SELECT * FROM subreddit_cache WHERE subreddit=$1 AND sort=$2 AND time_filter=$3 AND comment_mode=$4',
        [subreddit, DIGEST_SORT, DIGEST_TIME_FILTER, DIGEST_COMMENT_MODE]
      )
    ).rows[0];

    const isFresh = (row) => row.status === 'done' && Date.now() - new Date(row.updated_at).getTime() < CACHE_TTL_MS;

    if (existing && isFresh(existing)) return existing;

    let row = existing;
    if (!row) {
      // ON CONFLICT DO NOTHING покрива race-а, когато два topic-а поискат
      // едновременно същия сабредит - при конфликт просто препрочитаме реда.
      const inserted = (
        await pool.query(
          `INSERT INTO subreddit_cache (subreddit, sort, time_filter, comment_mode, status, scraped_by)
           VALUES ($1,$2,$3,$4,'queued',$5)
           ON CONFLICT (subreddit, sort, time_filter, comment_mode) DO NOTHING RETURNING *`,
          [subreddit, DIGEST_SORT, DIGEST_TIME_FILTER, DIGEST_COMMENT_MODE, userId]
        )
      ).rows[0];
      row =
        inserted ||
        (
          await pool.query(
            'SELECT * FROM subreddit_cache WHERE subreddit=$1 AND sort=$2 AND time_filter=$3 AND comment_mode=$4',
            [subreddit, DIGEST_SORT, DIGEST_TIME_FILTER, DIGEST_COMMENT_MODE]
          )
        ).rows[0];
    } else if (row.status !== 'queued' && row.status !== 'running') {
      // остаряло или гръмнало преди - пускаме нов опит
      row = (
        await pool.query("UPDATE subreddit_cache SET status='queued', error=NULL WHERE id=$1 RETURNING *", [row.id])
      ).rows[0];
    }

    if (!cacheQueue.includes(row.id) && cacheRunningId !== row.id) cacheQueue.push(row.id);
    return row;
  }

  async function buildWaitingOn(subreddits, userId) {
    const waitingOn = new Set();
    for (const sub of subreddits) {
      const row = await getOrCreateCacheEntry(sub, userId);
      if (row.status !== 'done') waitingOn.add(row.id);
    }
    return waitingOn;
  }

  async function checkPendingTopics(finishedCacheId) {
    for (const [topicId, pending] of pendingTopics.entries()) {
      if (!pending.waitingOn.has(finishedCacheId)) continue;
      pending.waitingOn.delete(finishedCacheId);
      if (pending.waitingOn.size === 0) {
        pendingTopics.delete(topicId);
        await finalizeTopic(topicId, pending);
      }
    }
  }

  async function finalizeTopic(topicId, pending) {
    try {
      const rows = (
        await pool.query(
          'SELECT subreddit, status, posts, error FROM subreddit_cache WHERE subreddit = ANY($1) AND sort=$2 AND time_filter=$3 AND comment_mode=$4',
          [pending.subreddits, DIGEST_SORT, DIGEST_TIME_FILTER, DIGEST_COMMENT_MODE]
        )
      ).rows;

      const bySubreddit = new Map(rows.map((r) => [r.subreddit, r]));
      const failed = pending.subreddits.filter((s) => bySubreddit.get(s)?.status !== 'done');
      if (failed.length) {
        const msg = `Неуспешно скрейпване на: ${failed.join(', ')}`;
        await pool.query("UPDATE topics SET status='error', error=$2, updated_at=now() WHERE id=$1", [topicId, msg]);
        return;
      }

      const subredditsData = pending.subreddits.map((s) => ({
        subreddit: s,
        posts: bySubreddit.get(s).posts.slice(0, pending.postCount || DEFAULT_POST_COUNT),
      }));
      const { answer } = await generateDigest({
        subredditsData,
        query: pending.query,
        useOwnKnowledge: pending.useOwnKnowledge,
        depth: pending.depth,
      });

      await pool.query('INSERT INTO topic_messages (topic_id, role, content) VALUES ($1,$2,$3)', [topicId, 'assistant', answer]);
      await pool.query("UPDATE topics SET status='done', updated_at=now() WHERE id=$1", [topicId]);
    } catch (err) {
      await pool.query("UPDATE topics SET status='error', error=$2, updated_at=now() WHERE id=$1", [
        topicId,
        err.message || String(err),
      ]);
    }
  }

  // При рестарт на сървъра (напр. nodemon по време на разработка) губим
  // in-memory опашката. Всичко останало на status='running' в кеша е
  // гарантирано "мъртво" (процесът, който го е скрейпвал, вече не съществува),
  // затова го връщаме в опашката; недовършените теми се пре-регистрират.
  async function recoverIncompleteState() {
    await pool.query("UPDATE subreddit_cache SET status='queued' WHERE status='running'");

    const incompleteTopics = (
      await pool.query("SELECT * FROM topics WHERE status IN ('queued','running')")
    ).rows;

    for (const topic of incompleteTopics) {
      const firstMsg = (
        await pool.query(
          "SELECT content FROM topic_messages WHERE topic_id=$1 AND role='user' ORDER BY created_at ASC LIMIT 1",
          [topic.id]
        )
      ).rows[0];
      if (!firstMsg) continue;

      const waitingOn = await buildWaitingOn(topic.subreddits, topic.user_id);
      const pendingData = {
        subreddits: topic.subreddits,
        query: firstMsg.content,
        useOwnKnowledge: topic.use_own_knowledge,
        postCount: topic.post_count,
        depth: topic.depth,
      };
      if (waitingOn.size === 0) {
        finalizeTopic(topic.id, pendingData);
      } else {
        pendingTopics.set(topic.id, { waitingOn, ...pendingData });
      }
    }
    processCacheQueue();
  }

  // ===================== Routes =====================

  router.post('/api/topics', requireAuth, async (req, res) => {
    if (!LLM_ENABLED) return res.status(503).json({ error: 'Q&A не е конфигуриран на сървъра (липсва OPENROUTER_API_KEY).' });

    const pendingForUser = (
      await pool.query("SELECT count(*) FROM topics WHERE user_id=$1 AND status IN ('queued','running')", [req.user.id])
    ).rows[0].count;
    if (Number(pendingForUser) >= MAX_TOPICS_PENDING_PER_USER) {
      return res.status(429).json({ error: `Вече имаш ${pendingForUser} чакащи тема(и). Изчакай да приключат.` });
    }

    const { subreddits, query, useOwnKnowledge, postCount, depth } = req.body || {};
    const cleanSubs = [...new Set((Array.isArray(subreddits) ? subreddits : []).map(sanitizeSubreddit).filter(Boolean))];
    if (!cleanSubs.length) return res.status(400).json({ error: 'Липсва поне един валиден сабредит.' });
    if (cleanSubs.length > MAX_SUBREDDITS) return res.status(400).json({ error: `Максимум ${MAX_SUBREDDITS} сабредита.` });

    const cleanQuery = String(query || '').trim();
    if (!cleanQuery) return res.status(400).json({ error: 'Липсва въпрос/тема.' });
    if (cleanQuery.length > 2000) return res.status(400).json({ error: 'Въпросът е твърде дълъг (макс. 2000 символа).' });

    const cleanPostCount = ALLOWED_POST_COUNTS.includes(Number(postCount)) ? Number(postCount) : DEFAULT_POST_COUNT;
    const cleanDepth = ALLOWED_DEPTHS.includes(depth) ? depth : DEFAULT_DEPTH;

    const topicId = crypto.randomBytes(8).toString('hex');
    const title = cleanQuery.length > 80 ? cleanQuery.slice(0, 80) + '…' : cleanQuery;

    await pool.query(
      "INSERT INTO topics (id, user_id, title, subreddits, use_own_knowledge, post_count, depth, status) VALUES ($1,$2,$3,$4,$5,$6,$7,'running')",
      [topicId, req.user.id, title, cleanSubs, Boolean(useOwnKnowledge), cleanPostCount, cleanDepth]
    );
    await pool.query('INSERT INTO topic_messages (topic_id, role, content) VALUES ($1,$2,$3)', [topicId, 'user', cleanQuery]);

    const waitingOn = await buildWaitingOn(cleanSubs, req.user.id);
    const pendingData = {
      subreddits: cleanSubs,
      query: cleanQuery,
      useOwnKnowledge: Boolean(useOwnKnowledge),
      postCount: cleanPostCount,
      depth: cleanDepth,
    };

    if (waitingOn.size === 0) {
      // всичко вече е в кеша - генерираме дайджеста веднага (async, не блокираме отговора)
      finalizeTopic(topicId, pendingData);
    } else {
      pendingTopics.set(topicId, { waitingOn, ...pendingData });
      processCacheQueue();
    }

    res.json({ topicId });
  });

  router.get('/api/topics', requireAuth, async (req, res) => {
    const result = await pool.query(
      'SELECT id, title, subreddits, status, use_own_knowledge, post_count, depth, created_at, updated_at FROM topics WHERE user_id=$1 ORDER BY updated_at DESC LIMIT 200',
      [req.user.id]
    );
    res.json({ topics: result.rows });
  });

  async function loadOwnedTopic(topicId, userId) {
    const topic = (await pool.query('SELECT * FROM topics WHERE id=$1 AND user_id=$2', [topicId, userId])).rows[0];
    if (!topic) return null;
    const messages = (
      await pool.query('SELECT id, role, content, created_at FROM topic_messages WHERE topic_id=$1 ORDER BY created_at ASC', [topicId])
    ).rows;
    return { topic, messages };
  }

  router.get('/api/topics/:id', requireAuth, async (req, res) => {
    const found = await loadOwnedTopic(req.params.id, req.user.id);
    if (!found) return res.status(404).json({ error: 'Темата не е намерена.' });
    res.json(found);
  });

  router.get('/api/topics/:id/status', requireAuth, async (req, res) => {
    const result = await pool.query('SELECT status, error FROM topics WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Темата не е намерена.' });
    const pending = pendingTopics.get(req.params.id);
    let progressMessage = null;
    if (pending) {
      for (const cacheId of pending.waitingOn) {
        if (cacheStatusText.has(cacheId)) {
          progressMessage = cacheStatusText.get(cacheId);
          break;
        }
      }
      if (!progressMessage) progressMessage = 'В опашката за скрейпване...';
    }
    res.json({ ...result.rows[0], progressMessage });
  });

  router.post('/api/topics/:id/messages', requireAuth, async (req, res) => {
    try {
      const found = await loadOwnedTopic(req.params.id, req.user.id);
      if (!found) return res.status(404).json({ error: 'Темата не е намерена.' });
      if (found.topic.status !== 'done') {
        return res.status(409).json({ error: `Темата все още не е готова (статус: ${found.topic.status}).` });
      }

      const { content, useOwnKnowledge } = req.body || {};
      const cleanContent = String(content || '').trim();
      if (!cleanContent) return res.status(400).json({ error: 'Липсва съобщение.' });

      const rows = (
        await pool.query(
          'SELECT subreddit, posts FROM subreddit_cache WHERE subreddit = ANY($1) AND sort=$2 AND time_filter=$3 AND comment_mode=$4 AND status=\'done\'',
          [found.topic.subreddits, DIGEST_SORT, DIGEST_TIME_FILTER, DIGEST_COMMENT_MODE]
        )
      ).rows;
      if (rows.length !== found.topic.subreddits.length) {
        return res.status(409).json({ error: 'Липсват кеширани данни за някои от сабредитите на тази тема.' });
      }
      const subredditsData = rows.map((r) => ({ subreddit: r.subreddit, posts: r.posts.slice(0, found.topic.post_count || DEFAULT_POST_COUNT) }));

      await pool.query('INSERT INTO topic_messages (topic_id, role, content) VALUES ($1,$2,$3)', [req.params.id, 'user', cleanContent]);

      const history = [...found.messages, { role: 'user', content: cleanContent }].map((m) => ({ role: m.role, content: m.content }));
      const { answer } = await continueTopicChat({
        subredditsData,
        messages: history,
        useOwnKnowledge: Boolean(useOwnKnowledge),
        depth: found.topic.depth,
      });

      const saved = await pool.query(
        'INSERT INTO topic_messages (topic_id, role, content) VALUES ($1,$2,$3) RETURNING id, created_at',
        [req.params.id, 'assistant', answer]
      );
      await pool.query('UPDATE topics SET updated_at=now() WHERE id=$1', [req.params.id]);

      res.json({ id: saved.rows[0].id, role: 'assistant', content: answer, created_at: saved.rows[0].created_at });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.recoverIncompleteState = recoverIncompleteState;
  return router;
};
