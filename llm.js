const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const MODEL = 'qwen/qwen3-vl-32b-instruct';
const CONTEXT_CHAR_BUDGET = 45000; // грубо ~11-13k токена, безопасно за латентност + цена

const LLM_ENABLED = Boolean(OPENROUTER_API_KEY);

/**
 * Изгражда текстов контекст от скрейпнатите постове, подредени по гласове,
 * подрязвайки съдържанието докато остане в границите на бюджета символи.
 */
function buildContext(posts, budget = CONTEXT_CHAR_BUDGET) {
  const sorted = [...posts].sort((a, b) => (b.votes || 0) - (a.votes || 0));
  let used = 0;
  let truncatedCount = 0;
  const chunks = [];

  for (const p of sorted) {
    if (used >= budget) {
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

    if (used + entry.length > budget) {
      const remaining = budget - used;
      if (remaining > 200) chunks.push(entry.slice(0, remaining) + '…(отрязано)');
      truncatedCount++;
      used = budget;
      continue;
    }
    chunks.push(entry);
    used += entry.length;
  }

  return { text: chunks.join('\n'), includedCount: sorted.length - truncatedCount, totalCount: sorted.length, truncated: truncatedCount > 0 };
}

/**
 * Изгражда общ контекст от 1-3 сабредита едновременно, разделяйки бюджета
 * поравно между тях и надписвайки всяка секция с името на сабредита.
 */
function buildMultiContext(subredditsData) {
  const perSubBudget = Math.floor((CONTEXT_CHAR_BUDGET * 1.2) / subredditsData.length);
  const sections = [];
  let anyTruncated = false;
  const summary = [];

  for (const { subreddit, posts } of subredditsData) {
    const { text, includedCount, totalCount, truncated } = buildContext(posts, perSubBudget);
    if (truncated) anyTruncated = true;
    summary.push(`r/${subreddit}: ${includedCount}/${totalCount} поста`);
    sections.push(`## Данни от r/${subreddit}\n\n${text}`);
  }

  return { text: sections.join('\n\n'), summary: summary.join(', '), truncated: anyTruncated };
}

async function callOpenRouter(messages) {
  if (!LLM_ENABLED) {
    throw new Error('OPENROUTER_API_KEY не е конфигуриран на сървъра.');
  }
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://reddit-scraper.up.railway.app',
      'X-Title': 'Reddit Scraper App',
    },
    body: JSON.stringify({ model: MODEL, messages, temperature: 0.3 }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`OpenRouter грешка (${res.status}): ${errText.slice(0, 300)}`);
  }
  const data = await res.json();
  const answer = data?.choices?.[0]?.message?.content;
  if (!answer) throw new Error('OpenRouter не върна отговор.');
  return answer;
}

function digestSystemPrompt(subredditNames, useOwnKnowledge) {
  const subsLabel = subredditNames.map((s) => `r/${s}`).join(', ');
  const ownKnowledgeRule = useOwnKnowledge
    ? `Може да добавяш и собствени общи знания (напр. медицински, технически), когато съдържанието от Reddit е недостатъчно — но ясно разграничавай кое идва от Reddit ("Според ${subsLabel}...") и кое е твое общо знание ("Общо взето..." / "От медицинска гледна точка..."). Никога не представяй собствено знание като мнение на Reddit потребители.`
    : `Отговаряй САМО въз основа на предоставените Reddit постове и коментари. Не измисляй информация, която не е в текста, и не добавяй собствени общи/експертни знания. Ако данните не съдържат отговор, кажи го ясно.`;

  return `Ти си асистент, който обобщава колективното мнение/опит на хората от ${subsLabel} по зададена тема или въпрос. ${ownKnowledgeRule}

Структурирай ВИНАГИ отговора си (Markdown) с точно тези секции:
## Обобщение
Кратък директен отговор на въпроса/темата, синтезиран от реалните постове и коментари.

## Консенсус / разпределение на мненията
Ако въпросът е сравнителен или "анкетен" по природа (напр. "какво е помогнало на хората"), дай ГРУБА приблизителна процентна разбивка на различните гледни точки/подходи, base-нато на извадката от постове/коментари (напр. "~60% споменават X, ~25% Y, останалите...") и изрично отбележи, че това е приблизителна оценка от извадка, не научна анкета. Ако мненията са до голяма степен единодушни или твърде разнородни за групиране, кажи го направо вместо да измисляш проценти.

## Примери
2-4 конкретни цитата/примера с линкове към постовете, които илюстрират горното.

Отговори на същия език, на който е зададен въпросът/темата. Бъди честен кога извадката е малка или недостатъчна за силен извод.`;
}

async function generateDigest({ subredditsData, query, useOwnKnowledge = false }) {
  const subredditNames = subredditsData.map((s) => s.subreddit);
  const { text: context, summary, truncated } = buildMultiContext(subredditsData);

  const systemPrompt = digestSystemPrompt(subredditNames, useOwnKnowledge);
  const userPrompt = `Тема/въпрос: ${query}\n\nДанни (${summary}${truncated ? ', някои постове/коментари са отрязани заради дължина' : ''}):\n\n${context}`;

  const answer = await callOpenRouter([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ]);
  return { answer, summary, truncated };
}

async function continueTopicChat({ subredditsData, messages, useOwnKnowledge = false }) {
  const subredditNames = subredditsData.map((s) => s.subreddit);
  const { text: context } = buildMultiContext(subredditsData);

  const systemPrompt = `${digestSystemPrompt(subredditNames, useOwnKnowledge)}\n\nПод-въпросите на потребителя по-долу са продължение на разговор по тази тема — отговаряй само на последния въпрос, като имаш предвид контекста на разговора. Не е нужно да повтаряш пълната структура с всичките секции по-горе за кратки follow-up въпроси — отговори директно и естествено, освен ако въпросът изрично не иска нова разбивка.\n\nДанни от Reddit:\n\n${context}`;

  const answer = await callOpenRouter([{ role: 'system', content: systemPrompt }, ...messages]);
  return { answer };
}

async function askAboutPosts({ posts, question, subreddit, useOwnKnowledge = false }) {
  const { text: context, includedCount, totalCount, truncated } = buildContext(posts);

  const systemPrompt = useOwnKnowledge
    ? `Ти си асистент, който отговаря на въпроси на база предоставените Reddit постове и коментари от r/${subreddit}, но може да добавя и собствени общи знания (напр. медицински, технически и т.н.), когато Reddit съдържанието е недостатъчно. Ясно разграничавай в отговора кое идва от Reddit дискусията ("Според r/${subreddit}...") и кое е твое общо знание ("Общо взето..." / "От медицинска гледна точка..."). Никога не представяй собствено знание като мнение на Reddit потребители. Форматирай отговора структурирано (Markdown: заглавия, bullet точки, удебелен текст където е уместно). Отговори на същия език, на който е зададен въпросът.`
    : `Ти си асистент, който отговаря на въпроси САМО въз основа на предоставените Reddit постове и коментари от r/${subreddit}. Не измисляй информация, която не е в текста, и не добавяй собствени общи/експертни знания. Ако данните не съдържат отговор, кажи го ясно. Форматирай отговора структурирано (Markdown: заглавия, bullet точки, удебелен текст където е уместно). Отговори на същия език, на който е зададен въпросът.`;

  const userPrompt = `Данни от r/${subreddit} (${includedCount} от общо ${totalCount} поста${truncated ? ', някои постове/коментари са отрязани заради дължина' : ''}):\n\n${context}\n\n---\n\nВъпрос: ${question}`;

  const answer = await callOpenRouter([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ]);
  return { answer, includedCount, totalCount, truncated };
}

module.exports = { askAboutPosts, generateDigest, continueTopicChat, LLM_ENABLED, MODEL };
