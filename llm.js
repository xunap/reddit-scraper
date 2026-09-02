const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const MODEL = 'qwen/qwen3-vl-32b-instruct';
const CONTEXT_CHAR_BUDGET = 45000; // грубо ~11-13k токена, безопасно за латентност + цена

const LLM_ENABLED = Boolean(OPENROUTER_API_KEY);

/**
 * Изгражда текстов контекст от скрейпнатите постове, подредени по гласове,
 * подрязвайки съдържанието докато остане в границите на бюджета символи.
 */
function buildContext(posts) {
  const sorted = [...posts].sort((a, b) => (b.votes || 0) - (a.votes || 0));
  let used = 0;
  let truncatedCount = 0;
  const chunks = [];

  for (const p of sorted) {
    if (used >= CONTEXT_CHAR_BUDGET) {
      truncatedCount++;
      continue;
    }
    let entry = `### "${p.title}" (автор: ${p.author}, гласове: ${p.votes ?? '?'}, коментари: ${p.comments ?? 0}, дата: ${(p.date || '').slice(0, 10)})\nURL: ${p.url}\n`;
    if (p.bodyText) {
      entry += `Текст на поста: ${p.bodyText.slice(0, 2500)}\n`;
    }
    if (Array.isArray(p.topComments) && p.topComments.length) {
      entry += 'Топ коментари:\n';
      for (const c of p.topComments.slice(0, 8)) {
        entry += `- [${c.author}, ${c.score} гласа]: ${(c.text || '').slice(0, 500)}\n`;
      }
    }
    entry += '\n';

    if (used + entry.length > CONTEXT_CHAR_BUDGET) {
      const remaining = CONTEXT_CHAR_BUDGET - used;
      if (remaining > 200) chunks.push(entry.slice(0, remaining) + '…(отрязано)');
      truncatedCount++;
      used = CONTEXT_CHAR_BUDGET;
      continue;
    }
    chunks.push(entry);
    used += entry.length;
  }

  return { text: chunks.join('\n'), includedCount: sorted.length - truncatedCount, totalCount: sorted.length, truncated: truncatedCount > 0 };
}

async function askAboutPosts({ posts, question, subreddit }) {
  if (!LLM_ENABLED) {
    throw new Error('OPENROUTER_API_KEY не е конфигуриран на сървъра.');
  }

  const { text: context, includedCount, totalCount, truncated } = buildContext(posts);

  const systemPrompt = `Ти си асистент, който отговаря на въпроси САМО въз основа на предоставените Reddit постове и коментари от r/${subreddit}. Не измисляй информация, която не е в текста. Ако данните не съдържат отговор, кажи го ясно. Форматирай отговора структурирано (Markdown: заглавия, bullet точки, удебелен текст където е уместно). Отговори на същия език, на който е зададен въпросът.`;

  const userPrompt = `Данни от r/${subreddit} (${includedCount} от общо ${totalCount} поста${truncated ? ', някои постове/коментари са отрязани заради дължина' : ''}):\n\n${context}\n\n---\n\nВъпрос: ${question}`;

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://reddit-scraper.up.railway.app',
      'X-Title': 'Reddit Scraper App',
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.3,
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`OpenRouter грешка (${res.status}): ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  const answer = data?.choices?.[0]?.message?.content;
  if (!answer) throw new Error('OpenRouter не върна отговор.');
  return { answer, includedCount, totalCount, truncated };
}

module.exports = { askAboutPosts, LLM_ENABLED, MODEL };
