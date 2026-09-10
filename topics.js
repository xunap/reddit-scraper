const crypto = require('crypto');
const express = require('express');
const { scrapeSubreddit, searchSubredditRelevance } = require('./scraper');
const { generateDigest, continueTopicChat, suggestSubreddits, generateTopicTitle, LLM_ENABLED } = require('./llm');

const MAX_SUBREDDITS = 10;
const DIGEST_SORT = 'top';
const ALLOWED_TIME_FILTERS = ['all', 'year', 'month', 'week', 'day', 'hour'];
const DEFAULT_TIME_FILTER = 'all';
const DIGEST_COMMENT_MODE = 'top50';
const DIGEST_COMMENT_LIMIT = 50;
// Кешът винаги се опитва да събере до толкова РЕАЛНИ (не-меме) постове на
// сабредит; всяка тема винаги ползва целия топ100 (потребителят не избира).
const DIGEST_MAX_POST_TARGET = 100;
const DEFAULT_POST_COUNT = DIGEST_MAX_POST_TARGET; // винаги топ100, потребителят не избира
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 дни
const MAX_TOPICS_PENDING_PER_USER = 2;
const MAX_CACHED_POSTS = 150; // таван след merge на инкременталните обновявания
// Допълнително search-по-relevance за самия въпрос, В ДОПЪЛНЕНИЕ на общия
// топ100 - общият топ (сортиран по гласове за цялото време) често пропуска
// тясно специфични теми, докато целенасочено търсене за въпроса веднага ги
// намира, дори при нисък брой гласове.
const SEARCH_RESULT_LIMIT = 10;
const SEARCH_COMMENT_LIMIT = 15;

// С малки букви нарочно - Reddit имената на сабредити са case-insensitive,
// а нормализирането максимизира cache hit-овете между различни потребители.
function sanitizeSubreddit(raw) {
  return String(raw || '').trim().replace(/^\/?r\//i, '').replace(/[^a-zA-Z0-9_]/g, '').toLowerCase();
}

// Обединява топ100-кеша с допълнителните search-по-relevance постове за
// конкретния въпрос: search постовете отиват първи (priorityIds), за да не
// бъдат изместени от бюджета на LLM контекста от по-висoкогласови, но
// нерелевантни постове (виж buildContext в llm.js). Дублати (пост вече
// присъстващ в топ100-кеша) се махат от search списъка.
function mergeSearchPosts(cachePosts, extraPosts) {
  const cacheIds = new Set(cachePosts.map((p) => p.id));
  const newFromSearch = (Array.isArray(extraPosts) ? extraPosts : []).filter((p) => p && p.id && !cacheIds.has(p.id));
  return { posts: [...newFromSearch, ...cachePosts], priorityIds: newFromSearch.map((p) => p.id) };
}

module.exports = function createTopicsRouter({ pool, requireAuth }) {
  const router = express.Router();

  // ===================== Споделена опашка (кеш-скрейпове + search-по-relevance) =====================
  // Единна опашка за ДВА вида фонова работа - и двете стартират реален Playwright
  // browser, затова се изпълняват стриктно последователно (едно по едно), за да
  // не гърми паметта с няколко Chromium инстанции едновременно:
  //   'cache'  - общия топ100-скрейп на цял сабредит (споделен между потребители)
  //   'search' - search-по-relevance само за конкретния въпрос на една тема
  const workQueue = []; // масив от job keys (виж cacheKey/searchKey)
  let runningKey = null;
  const workItems = new Map(); // key -> { type:'cache', cacheId } | { type:'search', topicId, subreddit, query }
  const statusText = new Map(); // key -> текущо съобщение за прогрес
  const pendingTopics = new Map(); // topicId -> { waitingOn: Set<key>, subreddits: string[], query, extended, timeFilter, postCount }

  const cacheKey = (cacheId) => `cache:${cacheId}`;
  const searchKey = (topicId, subreddit) => `search:${topicId}:${subreddit}`;

  function enqueueJob(key, item) {
    if (workItems.has(key)) return; // вече чака в опашката или тече в момента
    workItems.set(key, item);
    if (runningKey !== key) workQueue.push(key);
  }

  function processQueue() {
    if (runningKey) return;
    const key = workQueue.shift();
    if (key === undefined) return;
    const item = workItems.get(key);
    if (!item) return processQueue();
    runningKey = key;
    const run = item.type === 'cache' ? runCacheScrape(key, item.cacheId) : runSearchScrape(key, item);
    run.finally(() => {
      workItems.delete(key);
      runningKey = null;
      processQueue();
    });
  }

  async function runCacheScrape(key, id) {
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
    statusText.set(key, `Скрейпване на r/${row.subreddit}...`);
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
          statusText.set(
            key,
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
      statusText.delete(key);
      await checkPendingTopics(key);
    }
  }

  async function runSearchScrape(key, item) {
    statusText.set(key, `Търсене по релевантност в r/${item.subreddit}...`);
    let posts = [];
    try {
      posts = await searchSubredditRelevance(
        { subreddit: item.subreddit, query: item.query, limit: SEARCH_RESULT_LIMIT, commentLimit: SEARCH_COMMENT_LIMIT },
        (evt) => statusText.set(key, evt.message)
      );
    } catch (err) {
      // search-ът е допълнение, не критичен източник - темата продължава
      // само с общия топ100 кеш, ако това се провали.
      posts = [];
    } finally {
      await pool
        .query("UPDATE topics SET search_posts = COALESCE(search_posts, '{}'::jsonb) || jsonb_build_object($2::text, $3::jsonb) WHERE id=$1", [
          item.topicId,
          item.subreddit,
          JSON.stringify(posts),
        ])
        .catch(() => {});
      statusText.delete(key);
      await checkPendingTopics(key);
    }
  }

  async function getOrCreateCacheEntry(subreddit, userId, timeFilter) {
    const existing = (
      await pool.query(
        'SELECT * FROM subreddit_cache WHERE subreddit=$1 AND sort=$2 AND time_filter=$3 AND comment_mode=$4',
        [subreddit, DIGEST_SORT, timeFilter, DIGEST_COMMENT_MODE]
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
          [subreddit, DIGEST_SORT, timeFilter, DIGEST_COMMENT_MODE, userId]
        )
      ).rows[0];
      row =
        inserted ||
        (
          await pool.query(
            'SELECT * FROM subreddit_cache WHERE subreddit=$1 AND sort=$2 AND time_filter=$3 AND comment_mode=$4',
            [subreddit, DIGEST_SORT, timeFilter, DIGEST_COMMENT_MODE]
          )
        ).rows[0];
    } else if (row.status !== 'queued' && row.status !== 'running') {
      // остаряло или гръмнало преди - пускаме нов опит
      row = (
        await pool.query("UPDATE subreddit_cache SET status='queued', error=NULL WHERE id=$1 RETURNING *", [row.id])
      ).rows[0];
    }

    enqueueJob(cacheKey(row.id), { type: 'cache', cacheId: row.id });
    return row;
  }

  // За всеки сабредит: (1) осигурява топ100-кеша (споделен, преизползваем) и
  // (2) ВИНАГИ пуска отделно search-по-relevance за точно този въпрос (не се
  // преизползва между теми, специфично е за въпроса) - затова waitingOn
  // практически никога не е празен, дори когато топ100-кешът вече е пресен.
  async function buildWaitingOn(subreddits, userId, timeFilter, topicId, query) {
    const waitingOn = new Set();
    for (const sub of subreddits) {
      const row = await getOrCreateCacheEntry(sub, userId, timeFilter);
      if (row.status !== 'done') waitingOn.add(cacheKey(row.id));

      const sKey = searchKey(topicId, sub);
      enqueueJob(sKey, { type: 'search', topicId, subreddit: sub, query });
      waitingOn.add(sKey);
    }
    processQueue();
    return waitingOn;
  }

  async function checkPendingTopics(finishedKey) {
    for (const [topicId, pending] of pendingTopics.entries()) {
      if (!pending.waitingOn.has(finishedKey)) continue;
      pending.waitingOn.delete(finishedKey);
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
          [pending.subreddits, DIGEST_SORT, pending.timeFilter || DEFAULT_TIME_FILTER, DIGEST_COMMENT_MODE]
        )
      ).rows;

      const bySubreddit = new Map(rows.map((r) => [r.subreddit, r]));
      const failed = pending.subreddits.filter((s) => bySubreddit.get(s)?.status !== 'done');
      const succeeded = pending.subreddits.filter((s) => bySubreddit.get(s)?.status === 'done');

      if (!succeeded.length) {
        const msg = `Неуспешно скрейпване на: ${failed.join(', ')}`;
        await pool.query("UPDATE topics SET status='error', error=$2, updated_at=now() WHERE id=$1", [topicId, msg]);
        return;
      }

      // Ако само ЧАСТ от сабредитите се провалят (напр. грешно/несъществуващо
      // име), продължаваме с останалите вместо да проваляме цялата тема -
      // потребителят иначе може да чака с часове за нищо заради един лош ред.
      const topicRow = (await pool.query('SELECT search_posts FROM topics WHERE id=$1', [topicId])).rows[0];
      const searchPosts = (topicRow && topicRow.search_posts) || {};
      const subredditsData = succeeded.map((s) => {
        const cachePosts = bySubreddit.get(s).posts.slice(0, pending.postCount || DEFAULT_POST_COUNT);
        const merged = mergeSearchPosts(cachePosts, searchPosts[s]);
        return { subreddit: s, posts: merged.posts, priorityIds: merged.priorityIds };
      });
      const { answer } = await generateDigest({
        subredditsData,
        query: pending.query,
        extended: pending.extended,
      });

      const failedNote = failed.length
        ? `\n\n*(Note: could not scrape: ${failed.map((s) => 'r/' + s).join(', ')} - possibly a typo or a subreddit that doesn't exist. The digest above only covers ${succeeded.map((s) => 'r/' + s).join(', ')}.)*`
        : '';

      await pool.query('INSERT INTO topic_messages (topic_id, role, content) VALUES ($1,$2,$3)', [topicId, 'assistant', answer + failedNote]);
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

      const waitingOn = await buildWaitingOn(topic.subreddits, topic.user_id, topic.time_filter, topic.id, firstMsg.content);
      const pendingData = {
        subreddits: topic.subreddits,
        query: firstMsg.content,
        postCount: topic.post_count,
        extended: topic.extended,
        timeFilter: topic.time_filter,
      };
      if (waitingOn.size === 0) {
        finalizeTopic(topic.id, pendingData);
      } else {
        pendingTopics.set(topic.id, { waitingOn, ...pendingData });
      }
    }
    processQueue();
  }

  // ===================== Routes =====================

  // Reddit блокира обикновени (non-browser) HTTP заявки към JSON API-то си
  // (403 дори за валидни сабредити), затова истинско live autocomplete срещу
  // целия Reddit не е възможно без пълен browser per keystroke - твърде бавно
  // и тежко за typeahead. Вместо това предлагаме от собствения ни кеш
  // (сабредити, които вече е скрейпвал някой потребител) - мигновено, без
  // мрежова заявка навън.
  router.get('/api/subreddits/autocomplete', requireAuth, async (req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    if (q.length < 2) return res.json({ results: [] });
    // posts IS NOT NULL (а не status='done') - и сабредит, чийто периодичен
    // refresh в момента е running/error, си остава валидно, познато име, щом
    // някога вече е бил успешно скрейпнат.
    const rows = (
      await pool.query(
        'SELECT DISTINCT subreddit FROM subreddit_cache WHERE subreddit ILIKE $1 AND posts IS NOT NULL ORDER BY subreddit ASC LIMIT 8',
        [q.replace(/[%_]/g, '\\$&') + '%']
      )
    ).rows;
    res.json({ results: rows.map((r) => ({ name: r.subreddit })) });
  });

  router.post('/api/topics/suggest-subreddits', requireAuth, async (req, res) => {
    try {
      if (!LLM_ENABLED) return res.status(503).json({ error: 'Q&A не е конфигуриран на сървъра (липсва OPENROUTER_API_KEY).' });
      const { query, existingSubreddits } = req.body || {};
      const cleanQuery = String(query || '').trim();
      if (!cleanQuery) return res.status(400).json({ error: 'Липсва въпрос/тема.' });
      const cleanExisting = (Array.isArray(existingSubreddits) ? existingSubreddits : []).map(sanitizeSubreddit).filter(Boolean);
      const suggestions = await suggestSubreddits({ query: cleanQuery, existingSubreddits: cleanExisting });
      res.json({ suggestions });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/topics', requireAuth, async (req, res) => {
    if (!LLM_ENABLED) return res.status(503).json({ error: 'Q&A не е конфигуриран на сървъра (липсва OPENROUTER_API_KEY).' });

    const pendingForUser = (
      await pool.query("SELECT count(*) FROM topics WHERE user_id=$1 AND status IN ('queued','running')", [req.user.id])
    ).rows[0].count;
    if (Number(pendingForUser) >= MAX_TOPICS_PENDING_PER_USER) {
      return res.status(429).json({ error: `Вече имаш ${pendingForUser} чакащи тема(и). Изчакай да приключат.` });
    }

    const { subreddits, query, extended, timeFilter } = req.body || {};
    const cleanSubs = [...new Set((Array.isArray(subreddits) ? subreddits : []).map(sanitizeSubreddit).filter(Boolean))];
    if (!cleanSubs.length) return res.status(400).json({ error: 'Липсва поне един валиден сабредит.' });
    if (cleanSubs.length > MAX_SUBREDDITS) return res.status(400).json({ error: `Максимум ${MAX_SUBREDDITS} сабредита.` });

    const cleanQuery = String(query || '').trim();
    if (!cleanQuery) return res.status(400).json({ error: 'Липсва въпрос/тема.' });
    if (cleanQuery.length > 2000) return res.status(400).json({ error: 'Въпросът е твърде дълъг (макс. 2000 символа).' });

    const cleanPostCount = DEFAULT_POST_COUNT;
    const cleanExtended = Boolean(extended);
    const cleanTimeFilter = ALLOWED_TIME_FILTERS.includes(timeFilter) ? timeFilter : DEFAULT_TIME_FILTER;

    const topicId = crypto.randomBytes(8).toString('hex');
    const title = cleanQuery.length > 80 ? cleanQuery.slice(0, 80) + '…' : cleanQuery;

    await pool.query(
      "INSERT INTO topics (id, user_id, title, subreddits, post_count, extended, time_filter, status) VALUES ($1,$2,$3,$4,$5,$6,$7,'running')",
      [topicId, req.user.id, title, cleanSubs, cleanPostCount, cleanExtended, cleanTimeFilter]
    );
    await pool.query('INSERT INTO topic_messages (topic_id, role, content) VALUES ($1,$2,$3)', [topicId, 'user', cleanQuery]);

    // Заглавието по-горе е само fallback (отрязаният въпрос); генерираме
    // истинско кратко резюме в отделен LLM-извикване, без да бавим отговора -
    // ъпдейтваме реда щом е готово, само ако потребителят вече не го е преименувал.
    generateTopicTitle({ query: cleanQuery })
      .then((generatedTitle) =>
        pool.query('UPDATE topics SET title=$1 WHERE id=$2 AND title_is_custom=false', [generatedTitle, topicId])
      )
      .catch(() => {});

    const waitingOn = await buildWaitingOn(cleanSubs, req.user.id, cleanTimeFilter, topicId, cleanQuery);
    const pendingData = {
      subreddits: cleanSubs,
      query: cleanQuery,
      postCount: cleanPostCount,
      extended: cleanExtended,
      timeFilter: cleanTimeFilter,
    };

    if (waitingOn.size === 0) {
      // теоретичен fallback (напр. без сабредити) - на практика waitingOn
      // винаги съдържа поне search job-овете, виж buildWaitingOn.
      finalizeTopic(topicId, pendingData);
    } else {
      pendingTopics.set(topicId, { waitingOn, ...pendingData });
    }

    res.json({ topicId });
  });

  router.get('/api/topics', requireAuth, async (req, res) => {
    const result = await pool.query(
      'SELECT id, title, subreddits, status, post_count, extended, time_filter, created_at, updated_at FROM topics WHERE user_id=$1 ORDER BY updated_at DESC LIMIT 200',
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
      for (const key of pending.waitingOn) {
        if (statusText.has(key)) {
          progressMessage = statusText.get(key);
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

      const { content } = req.body || {};
      const cleanContent = String(content || '').trim();
      if (!cleanContent) return res.status(400).json({ error: 'Липсва съобщение.' });

      const rows = (
        await pool.query(
          'SELECT subreddit, posts FROM subreddit_cache WHERE subreddit = ANY($1) AND sort=$2 AND time_filter=$3 AND comment_mode=$4 AND status=\'done\'',
          [found.topic.subreddits, DIGEST_SORT, found.topic.time_filter, DIGEST_COMMENT_MODE]
        )
      ).rows;
      if (!rows.length) {
        return res.status(409).json({ error: 'Липсват кеширани данни за сабредитите на тази тема.' });
      }
      const searchPosts = found.topic.search_posts || {};
      const subredditsData = rows.map((r) => {
        const cachePosts = r.posts.slice(0, found.topic.post_count || DEFAULT_POST_COUNT);
        const merged = mergeSearchPosts(cachePosts, searchPosts[r.subreddit]);
        return { subreddit: r.subreddit, posts: merged.posts, priorityIds: merged.priorityIds };
      });

      await pool.query('INSERT INTO topic_messages (topic_id, role, content) VALUES ($1,$2,$3)', [req.params.id, 'user', cleanContent]);

      const history = [...found.messages, { role: 'user', content: cleanContent }].map((m) => ({ role: m.role, content: m.content }));
      const { answer } = await continueTopicChat({ subredditsData, messages: history });

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

  router.patch('/api/topics/:id', requireAuth, async (req, res) => {
    const cleanTitle = String((req.body || {}).title || '').trim().slice(0, 200);
    if (!cleanTitle) return res.status(400).json({ error: 'Липсва заглавие.' });
    const result = await pool.query(
      'UPDATE topics SET title=$1, title_is_custom=true WHERE id=$2 AND user_id=$3 RETURNING id',
      [cleanTitle, req.params.id, req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Темата не е намерена.' });
    res.json({ ok: true, title: cleanTitle });
  });

  router.delete('/api/topics/:id', requireAuth, async (req, res) => {
    const result = await pool.query('DELETE FROM topics WHERE id=$1 AND user_id=$2 RETURNING id', [req.params.id, req.user.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Темата не е намерена.' });
    res.json({ ok: true });
  });

  router.recoverIncompleteState = recoverIncompleteState;
  return router;
};
