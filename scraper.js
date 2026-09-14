/**
 * Reddit скрейпър модул (Playwright, без API).
 *
 * www.reddit.com се използва вместо old.reddit.com, защото последният вече
 * изисква логин. Постовете се зареждат чрез infinite scroll и Reddit
 * виртуализира DOM-а (маха стари постове докато скролираш), затова
 * резултатите се натрупват инкрементално след всеки скрол, не само в края.
 */

const { chromium } = require('playwright');

const MAX_SCROLLS = 160;
const STAGNATION_LIMIT = 15;

function randomDelay(minMs = 1000, maxMs = 3000) {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildListingUrl(subreddit, sort, timeFilter) {
  const base = `https://www.reddit.com/r/${encodeURIComponent(subreddit)}`;
  if (sort === 'new') return `${base}/new/`;
  if (sort === 'top') return `${base}/top/?t=${encodeURIComponent(timeFilter || 'all')}`;
  return `${base}/`; // hot (default feed)
}

function buildSearchUrl(subreddit, query) {
  return `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/search/?q=${encodeURIComponent(query)}&restrict_sr=1&sort=relevance`;
}

async function extractVisiblePosts(page) {
  return page.$$eval('shreddit-post', (posts) =>
    posts.map((el) => {
      const id = el.id || el.getAttribute('id');
      const title = el.getAttribute('post-title');
      const author = el.getAttribute('author') || '[deleted]';
      const scoreAttr = el.getAttribute('score');
      const votes = scoreAttr !== null && !isNaN(scoreAttr) ? Number(scoreAttr) : null;
      const commentAttr = el.getAttribute('comment-count');
      const comments = commentAttr !== null && !isNaN(commentAttr) ? Number(commentAttr) : 0;
      const permalink = el.getAttribute('permalink');
      const url = permalink ? `https://www.reddit.com${permalink}` : null;
      const postType = el.getAttribute('post-type');
      const domain = el.getAttribute('domain');
      const createdRaw = el.getAttribute('created-timestamp');
      let date = null;
      if (createdRaw) {
        const d = new Date(createdRaw);
        date = isNaN(d.getTime()) ? createdRaw : d.toISOString();
      }
      const flairEl = el.querySelector('[slot*="flair" i], [class*="flair" i], shreddit-post-flair');
      const flair = flairEl ? flairEl.textContent.trim() : '';
      return { id, title, author, votes, comments, url, postType, domain, date, flair };
    })
  );
}

// Груб филтър за забавни/меме постове - те обикновено доминират топ класациите
// на здравни сабредити и нямат съществена стойност за digest анализа.
const MEME_PATTERN = /\b(meme|memes|shitpost|shit post|funny|lol|lmao|lmfao|rofl|joke|comic|cartoon|copypasta)\b|😂|🤣/i;
function isLikelyMeme(post) {
  return MEME_PATTERN.test(post.flair || '') || MEME_PATTERN.test(post.title || '');
}

async function extractPostBody(page) {
  try {
    const loc = page.locator('[slot="text-body"]').first();
    if ((await loc.count()) === 0) return null;
    const text = await loc.innerText({ timeout: 5000 });
    return text.trim() || null;
  } catch (e) {
    return null;
  }
}

async function extractTopComments(page, max) {
  if (!max) return [];
  try {
    await page.waitForSelector('shreddit-comment', { timeout: 8000 });
  } catch (e) {
    return [];
  }

  // За по-големи заявки Reddit lazy-load-ва коментарите при скрол - опитваме
  // се да ги "изкараме" преди да ги извлечем.
  if (max > 15) {
    let stagnant = 0;
    let lastCount = 0;
    for (let i = 0; i < 25 && stagnant < 3; i++) {
      const count = await page.locator('shreddit-comment').count();
      if (count >= max) break;
      stagnant = count === lastCount ? stagnant + 1 : 0;
      lastCount = count;
      await page.mouse.wheel(0, 2600);
      await page.waitForTimeout(600);
    }
  }

  const comments = await page.$$eval(
    'shreddit-comment',
    (els, max) =>
      els.slice(0, max).map((el) => {
        const md = el.querySelector('[slot="comment"]') || el.querySelector('.md');
        const text = md ? md.innerText.trim() : '';
        return {
          author: el.getAttribute('author'),
          score: el.getAttribute('score'),
          depth: el.getAttribute('depth'),
          text,
        };
      }),
    max
  );
  return comments.filter((c) => c.text && c.text.length > 0);
}

async function dismissCookieBanner(page) {
  try {
    await page.getByRole('button', { name: /accept all/i }).click({ timeout: 4000 });
  } catch (e) {
    // банерът може да липсва
  }
}

// Search резултатите на Reddit НЕ използват shreddit-post елементи както
// listing страниците (hot/new/top) - постовете там са обикновени
// <a href="/.../comments/...">, всеки линк дублиран (thumbnail + заглавие).
// Затова взимаме само URL-ите оттук; пълните метаданни (автор, гласове,
// коментари, дата) се четат по-долу от shreddit-post елемента на самата
// страница на всеки пост, който вече посещаваме за текст/коментари.
async function extractSearchResultLinks(page, limit) {
  return page.evaluate((limit) => {
    const links = Array.from(document.querySelectorAll('a[href*="/comments/"]'));
    const seen = new Set();
    const out = [];
    for (const a of links) {
      const href = a.href.split('?')[0];
      if (seen.has(href)) continue;
      seen.add(href);
      out.push(href);
      if (out.length >= limit) break;
    }
    return out;
  }, limit);
}

async function extractPostMeta(page) {
  try {
    return await page.$eval('shreddit-post', (el) => {
      const scoreAttr = el.getAttribute('score');
      const commentAttr = el.getAttribute('comment-count');
      return {
        id: el.id,
        title: el.getAttribute('post-title'),
        author: el.getAttribute('author') || '[deleted]',
        votes: scoreAttr !== null && !isNaN(scoreAttr) ? Number(scoreAttr) : null,
        comments: commentAttr !== null && !isNaN(commentAttr) ? Number(commentAttr) : 0,
        postType: el.getAttribute('post-type'),
        createdRaw: el.getAttribute('created-timestamp'),
      };
    });
  } catch (e) {
    return null;
  }
}

/**
 * Допълнително търсене В рамките на един сабредит по конкретния въпрос на
 * потребителя (sort=relevance, restrict_sr=1) - за случаите, когато общият
 * топ100 на сабредита (сортиран по гласове за цялото време) просто не
 * съдържа постове по тясно специфична тема, но целенасочено търсене намира
 * веднага релевантни резултати.
 * @param {object} opts
 * @param {string} opts.subreddit
 * @param {string} opts.query
 * @param {number} [opts.limit] - макс. брой резултати (топ по relevance)
 * @param {number} [opts.commentLimit] - топ коментари на пост
 */
async function searchSubredditRelevance({ subreddit, query, limit = 10, commentLimit = 20 }, onProgress = () => {}) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);

    const url = buildSearchUrl(subreddit, query);
    onProgress({ phase: 'search', message: `Търсене по релевантност в r/${subreddit}: "${query}"` });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await dismissCookieBanner(page);
    await page.waitForTimeout(2000); // резултатите се хидратират клиентски, не са налични веднага при domcontentloaded

    const links = await extractSearchResultLinks(page, limit);
    onProgress({
      phase: 'search',
      message: `Намерени ${links.length} резултата по релевантност в r/${subreddit}`,
      current: 0,
      total: links.length,
    });

    const posts = [];
    for (let i = 0; i < links.length; i++) {
      const postUrl = links[i];
      onProgress({ phase: 'search-details', message: `[${i + 1}/${links.length}] r/${subreddit}: ${postUrl}`, current: i + 1, total: links.length });
      try {
        await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
        await page.waitForTimeout(1200);
        const meta = await extractPostMeta(page);
        if (!meta || !meta.title) continue;
        let date = null;
        if (meta.createdRaw) {
          const d = new Date(meta.createdRaw);
          date = isNaN(d.getTime()) ? meta.createdRaw : d.toISOString();
        }
        posts.push({
          id: meta.id,
          title: meta.title,
          author: meta.author,
          votes: meta.votes,
          comments: meta.comments,
          url: postUrl,
          postType: meta.postType,
          date,
          bodyText: await extractPostBody(page),
          topComments: await extractTopComments(page, commentLimit),
        });
      } catch (err) {
        // пропускаме единичен проблемен резултат, не проваляме цялото търсене заради него
      }
      await randomDelay(800, 1800);
    }

    onProgress({ phase: 'search-done', message: `Готово: ${posts.length} поста от търсенето по релевантност в r/${subreddit}.` });
    return posts;
  } finally {
    await browser.close();
  }
}

/**
 * @param {object} opts
 * @param {string} opts.subreddit
 * @param {'hot'|'new'|'top'} opts.sort
 * @param {string} [opts.timeFilter] - за sort=top: hour|day|week|month|year|all
 * @param {number} opts.limit - макс. брой постове (1-300)
 * @param {number|null} opts.commentLimit - null = без посещение на всеки пост (бързо, само списък);
 *   0 = посети всеки пост само за пълния текст; N>0 = текст + до N топ коментара
 * @param {string|null} [opts.sinceDate] - ISO дата; ако е зададена и sort='new', спираме
 *   скролирането веднага щом стигнем пост, по-стар или равен на нея (инкрементално скрейпване)
 * @param {(evt: {phase:string, message:string, current?:number, total?:number}) => void} onProgress
 */
async function scrapeSubreddit(opts, onProgress = () => {}) {
  const { subreddit, sort = 'hot', timeFilter = 'all', limit = 50, commentLimit = null, sinceDate = null } = opts;
  const safeLimit = Math.max(1, Math.min(300, Number(limit) || 50));

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);

    const url = buildListingUrl(subreddit, sort, timeFilter);
    onProgress({ phase: 'listing', message: `Зареждане на r/${subreddit} (${url})` });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await dismissCookieBanner(page);

    // Бърза проверка дали сабредитът изобщо съществува, преди да чакаме пълните
    // 15s за постове: заглавният h1 на реална страница е "r/<име>", докато на
    // несъществуващ/забранен сабредит Reddit никога не рендира такъв h1 (връща
    // generic 200 SPA страница, не истинско HTTP 404, затова не може да се
    // разчита на статус кода). Пести ~10s+ забавяне при сгрешено име.
    onProgress({ phase: 'listing', message: `Проверка дали r/${subreddit} съществува...` });
    const h1Text = await page
      .locator('h1')
      .first()
      .textContent({ timeout: 6000 })
      .catch(() => null);
    if (!h1Text || !new RegExp(`^\\s*r/${subreddit}\\s*$`, 'i').test(h1Text)) {
      throw new Error(`r/${subreddit} не съществува или не е достъпен (възможна е правописна грешка).`);
    }

    try {
      await page.waitForSelector('shreddit-post', { timeout: 15000 });
    } catch (err) {
      const bodyText = await page.textContent('body').catch(() => '');
      const title = await page.title().catch(() => '');
      const finalUrl = page.url();
      const snippet = bodyText.replace(/\s+/g, ' ').trim().slice(0, 250);
      onProgress({ phase: 'debug', message: `DEBUG title="${title}" url="${finalUrl}" snippet="${snippet}"` });
      if (/blocked|captcha|unusual traffic/i.test(bodyText)) {
        throw new Error(`Изглежда сме блокирани от Reddit (captcha/rate-limit). title="${title}" snippet="${snippet}"`);
      }
      throw new Error(`Не бяха намерени постове (title="${title}", url="${finalUrl}"). snippet="${snippet}"`);
    }

    const collected = new Map();
    const seenMemeIds = new Set();
    let memeSkipped = 0;
    let stagnant = 0;
    let scrolls = 0;
    let hitCutoff = false;

    while (collected.size < safeLimit && scrolls < MAX_SCROLLS && stagnant < STAGNATION_LIMIT && !hitCutoff) {
      const visible = await extractVisiblePosts(page);
      let added = 0;
      for (const p of visible) {
        if (!p.id || collected.has(p.id) || !p.title || !p.url) continue;
        if (sinceDate && p.date && p.date <= sinceDate) {
          hitCutoff = true; // sort=new е хронологичен - от тук нататък всичко е по-старо
          continue;
        }
        if (isLikelyMeme(p)) {
          if (!seenMemeIds.has(p.id)) {
            seenMemeIds.add(p.id);
            memeSkipped += 1;
          }
          continue; // не броим мемета/забавни постове към целевия лимит
        }
        collected.set(p.id, p);
        added += 1;
      }
      if (added > 0) {
        stagnant = 0;
        onProgress({
          phase: 'listing',
          message: `Скрол ${scrolls + 1}: +${added} нови поста${memeSkipped ? ` (${memeSkipped} мемета пропуснати общо)` : ''}`,
          current: collected.size,
          total: safeLimit,
        });
      } else {
        stagnant += 1;
      }
      if (collected.size >= safeLimit || hitCutoff) break;
      await page.mouse.wheel(0, 2600);
      scrolls += 1;
      await randomDelay(1000, 3000);
    }

    let posts = Array.from(collected.values()).slice(0, safeLimit);
    onProgress({
      phase: 'listing-done',
      message: `Списъкът е готов: ${posts.length} поста`,
      current: posts.length,
      total: safeLimit,
    });

    if (commentLimit !== null) {
      for (let i = 0; i < posts.length; i++) {
        const p = posts[i];
        onProgress({
          phase: 'details',
          message: `[${i + 1}/${posts.length}] ${p.title.slice(0, 70)}`,
          current: i + 1,
          total: posts.length,
        });
        try {
          await page.goto(p.url, { waitUntil: 'domcontentloaded', timeout: 25000 });
          await page.waitForTimeout(1500);
          p.bodyText = await extractPostBody(page);
          p.topComments = await extractTopComments(page, commentLimit);
        } catch (err) {
          p.bodyText = null;
          p.topComments = [];
          p.detailError = err.message;
        }
        await randomDelay(1000, 3000);
      }
    }

    onProgress({ phase: 'done', message: `Готово! ${posts.length} поста събрани.`, current: posts.length, total: posts.length });
    return posts;
  } finally {
    await browser.close();
  }
}

// ===================== Autocomplete за имена на сабредити =====================
// Reddit-овото JSON API блокира обикновени (non-browser) HTTP заявки с 403,
// дори за валидни сабредити - но fetch(), изпълнен ВЪТРЕ в реална, вече
// заредена reddit.com страница (със session/credentials на самия browser),
// минава нормално, защото идва от истинска browser мрежова сесия, не гол
// Node HTTP request. Затова държим ЕДНА постоянна, лека browser страница
// жива между заявките (само за autocomplete), вместо да палим нов browser
// (скъпо, секунди) при всяко търсене - typeahead трябва да е бърз.
let acBrowser = null;
let acPage = null;
let acInitPromise = null;

async function ensureAutocompletePage() {
  if (acPage) return acPage;
  if (!acInitPromise) {
    acInitPromise = (async () => {
      acBrowser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
      });
      const context = await acBrowser.newContext({
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        viewport: { width: 1280, height: 900 },
        locale: 'en-US',
      });
      await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      });
      const page = await context.newPage();
      await page.goto('https://www.reddit.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });
      // Веднага след domcontentloaded сесийните cookies/токъни още не са напълно
      // "уседнали" - първа fetch заявка веднага след goto понякога се връща
      // празна дори за валидна заявка. Кратка пауза го оправя надеждно.
      await page.waitForTimeout(1500);
      acPage = page;
      return page;
    })().finally(() => {
      acInitPromise = null;
    });
  }
  return acInitPromise;
}

async function resetAutocompletePage() {
  const browser = acBrowser;
  acPage = null;
  acBrowser = null;
  if (browser) await browser.close().catch(() => {});
}

async function fetchAutocomplete(page, query) {
  return page.evaluate(async (q) => {
    const url =
      'https://www.reddit.com/api/subreddit_autocomplete_v2.json?query=' +
      encodeURIComponent(q) +
      '&limit=8&include_over_18=false&include_profiles=false&typeahead_active=true';
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) return { ok: false, status: res.status, statusText: res.statusText };
    return { ok: true, status: res.status, data: await res.json() };
  }, query);
}

/**
 * Търсене на сабредити по префикс за typeahead - срещу целия Reddit, не само
 * вече скрейпнатите от нас (виж бележката по-горе защо е нужен browser).
 */
async function autocompleteSubreddits(query) {
  try {
    const page = await ensureAutocompletePage();
    const result = await fetchAutocomplete(page, query);
    if (!result.ok) throw new Error('non-ok response: ' + JSON.stringify(result));
    console.log('[autocomplete] ok, status=' + result.status + ' children=' + (result.data?.data?.children || []).length);
    return (result.data?.data?.children || []).map((c) => ({
      name: c.data.display_name,
      subscribers: c.data.subscribers || 0,
    }));
  } catch (err) {
    console.error('[autocomplete] first attempt failed: ' + (err && err.stack || err));
    // Страницата може да е "умряла" (краш, изтекла сесия) - рестартираме и
    // пробваме точно веднъж отначало, преди тихо да се откажем.
    await resetAutocompletePage();
    try {
      const page = await ensureAutocompletePage();
      const result = await fetchAutocomplete(page, query);
      if (!result.ok) {
        console.error('[autocomplete] retry non-ok: ' + JSON.stringify(result));
        return [];
      }
      console.log('[autocomplete] retry ok, children=' + (result.data?.data?.children || []).length);
      return (result.data?.data?.children || []).map((c) => ({
        name: c.data.display_name,
        subscribers: c.data.subscribers || 0,
      }));
    } catch (err2) {
      console.error('[autocomplete] retry failed: ' + (err2 && err2.stack || err2));
      return [];
    }
  }
}

module.exports = { scrapeSubreddit, searchSubredditRelevance, autocompleteSubreddits };
