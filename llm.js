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

// Проста евристика EN/BG (единствените езици в UI-то): кирилица -> български.
// Явно назоваване на целевия език в prompt-а е много по-надеждно от разчитане
// моделът сам да го извлече от съдържанието на въпроса.
function detectLanguageLabel(text) {
  return /[Ѐ-ӿ]/.test(text || '') ? 'Bulgarian' : 'English';
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
  // Моделите на практика игнорират инструкцията "без тирета" доста често -
  // гарантираме го тук вместо само да разчитаме на prompt-а.
  return answer.replace(/[–—]/g, '-');
}

const DEPTH_INSTRUCTIONS = {
  brief: `Keep the whole answer CONCISE: one short paragraph per section, a few sentences each. Only include the three core sections below - do not add extra subsections.`,
  standard: `Write a few solid paragraphs per section - more thorough than a one-line summary, but not an exhaustive report. Only include the three core sections below unless the data clearly calls for one more.`,
  deep: `Write a LONG, COMPREHENSIVE, in-depth report - do not artificially shorten it, this is meant to read like a detailed research write-up. Beyond the three core sections, add as many additional relevant subsections as the data supports and the topic calls for - for example (only include the ones that actually apply): Diet & foods to include/avoid, Supplements & natural remedies mentioned, Medications & medical options mentioned, Lifestyle & stress factors, Suggested action plan / next steps, Red flags & when to see a doctor. Give each subsection several paragraphs of real substance drawn from the posts and comments, not just a bullet or two.`,
};

function digestSystemPrompt(subredditNames, useOwnKnowledge, languageLabel, depth) {
  const subsLabel = subredditNames.map((s) => `r/${s}`).join(', ');
  const ownKnowledgeRule = useOwnKnowledge
    ? `You may also add your own general knowledge (e.g. medical, technical) when the Reddit content is insufficient - but clearly separate what comes from Reddit ("According to ${subsLabel}...") from your own general knowledge ("In general..." / "From a medical standpoint..."). Never present your own knowledge as if it were a Reddit user's opinion.`
    : `Answer ONLY based on the provided Reddit posts and comments. Do not invent information that isn't in the text, and do not add your own general/expert knowledge. If the data doesn't contain an answer, say so clearly.`;
  const depthRule = DEPTH_INSTRUCTIONS[depth] || DEPTH_INSTRUCTIONS.standard;

  return `You are an assistant that synthesizes the collective opinions/experiences of people from ${subsLabel} on a given topic or question. ${ownKnowledgeRule}

${depthRule}

The three core sections (Markdown headers, translated into the response language) are:
## Summary
A direct answer to the question/topic, synthesized from the real posts and comments.

## Consensus / Split of Opinions
If the question is comparative or "poll-like" by nature (e.g. "what helped people"), give a ROUGH approximate percentage breakdown of the different viewpoints/approaches, based on the sample of posts/comments (e.g. "~60% mention X, ~25% Y, ..."), and explicitly note this is an approximate estimate from a sample, not a scientific poll. If opinions are largely unanimous or too varied to group, say so directly instead of inventing percentages.

## Examples
Concrete quotes/examples that illustrate the above. When picking which posts to cite, prioritize genuine success stories - people describing what specifically helped them improve or recover - over posts that just describe symptoms or complaints, though you can include the latter when directly relevant. Format every post reference as a markdown hyperlink using the post's title as the link text, e.g. [The Gastritis Quick Start Guide](https://reddit.com/...) - never show a raw URL in parentheses next to plain text.

IMPORTANT: The user's question/topic below is written in ${languageLabel}. You MUST write your entire response - including every section header - in ${languageLabel}, regardless of what language these instructions are in. Never use the em dash character or en dash character in your response - always use a regular hyphen (like this one) or split into separate sentences instead. Be honest when the sample is small or insufficient for a strong conclusion. If the topic touches on physical symptoms that could be a medical emergency or need a professional diagnosis (e.g. chest pain, heart palpitations), note briefly that seeing a doctor directly is worth doing regardless of what Reddit says.`;
}

async function generateDigest({ subredditsData, query, useOwnKnowledge = false, forceLanguage = null, depth = 'standard' }) {
  const subredditNames = subredditsData.map((s) => s.subreddit);
  const { text: context, summary, truncated } = buildMultiContext(subredditsData);
  const languageLabel = forceLanguage || detectLanguageLabel(query);

  const systemPrompt = digestSystemPrompt(subredditNames, useOwnKnowledge, languageLabel, depth);
  const userPrompt = `Topic/question: ${query}\n\nData (${summary}${truncated ? ', some posts/comments truncated for length' : ''}):\n\n${context}`;

  const answer = await callOpenRouter([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ]);
  return { answer, summary, truncated };
}

async function continueTopicChat({ subredditsData, messages, useOwnKnowledge = false, depth = 'standard' }) {
  const subredditNames = subredditsData.map((s) => s.subreddit);
  const { text: context } = buildMultiContext(subredditsData);
  const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
  const languageLabel = detectLanguageLabel(lastUserMsg ? lastUserMsg.content : '');

  const systemPrompt = `${digestSystemPrompt(subredditNames, useOwnKnowledge, languageLabel, depth)}\n\nThe user's messages below are a continuation of a conversation on this topic - answer only the latest question, keeping the conversation context in mind. You don't need to repeat the full structure with all sections above for short follow-up questions - answer directly and naturally in ${languageLabel} at the depth level described above, unless the question explicitly asks for something shorter or longer.\n\nReddit data:\n\n${context}`;

  const answer = await callOpenRouter([{ role: 'system', content: systemPrompt }, ...messages]);
  return { answer };
}

async function askAboutPosts({ posts, question, subreddit, useOwnKnowledge = false }) {
  const { text: context, includedCount, totalCount, truncated } = buildContext(posts);
  const languageLabel = detectLanguageLabel(question);

  const systemPrompt = useOwnKnowledge
    ? `You are an assistant that answers questions based on the provided Reddit posts and comments from r/${subreddit}, but may also add your own general knowledge (e.g. medical, technical) when the Reddit content is insufficient. Clearly separate in your answer what comes from the Reddit discussion ("According to r/${subreddit}...") from your own general knowledge ("In general..." / "From a medical standpoint..."). Never present your own knowledge as if it were a Reddit user's opinion. Format the response with structured Markdown (headers, bullet points, bold text where appropriate). IMPORTANT: the question below is written in ${languageLabel} - you MUST answer entirely in ${languageLabel}. Never use the em dash character or en dash character in your response - always use a regular hyphen (like this one) instead.`
    : `You are an assistant that answers questions ONLY based on the provided Reddit posts and comments from r/${subreddit}. Do not invent information that isn't in the text, and do not add your own general/expert knowledge. If the data doesn't contain an answer, say so clearly. Format the response with structured Markdown (headers, bullet points, bold text where appropriate). IMPORTANT: the question below is written in ${languageLabel} - you MUST answer entirely in ${languageLabel}. Never use the em dash character or en dash character in your response - always use a regular hyphen (like this one) instead.`;

  const userPrompt = `Data from r/${subreddit} (${includedCount} of ${totalCount} posts${truncated ? ', some posts/comments truncated for length' : ''}):\n\n${context}\n\n---\n\nQuestion: ${question}`;

  const answer = await callOpenRouter([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ]);
  return { answer, includedCount, totalCount, truncated };
}

module.exports = { askAboutPosts, generateDigest, continueTopicChat, LLM_ENABLED, MODEL };
