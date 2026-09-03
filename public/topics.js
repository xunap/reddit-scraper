(function () {
  const topicNewBtn = document.getElementById('topic-new-btn');
  const topicList = document.getElementById('topic-list');

  const topicComposer = document.getElementById('topic-composer');
  const topicForm = document.getElementById('topic-form');
  const topicSubmit = document.getElementById('topic-submit');
  const topicFormError = document.getElementById('topic-form-error');
  const topicQuery = document.getElementById('topic-query');
  const topicSubsList = document.getElementById('topic-subs-list');
  const topicSubAdd = document.getElementById('topic-sub-add');
  const topicSuggestBtn = document.getElementById('topic-suggest-btn');
  const topicSuggestChips = document.getElementById('topic-suggest-chips');
  const MAX_SUBREDDIT_ROWS = 10;
  const topicTimeFilter = document.getElementById('topic-time-filter');
  const topicExtended = document.getElementById('topic-extended');

  // ===================== Auto-resize textareas (без ръчен resize handle) ====

  function autoResize(textarea) {
    textarea.style.height = 'auto';
    textarea.style.height = textarea.scrollHeight + 'px';
  }
  function wireAutoResize(textarea) {
    autoResize(textarea);
    textarea.addEventListener('input', () => autoResize(textarea));
  }

  // ===================== Динамичен списък със сабредити =====================

  function updateSubAddState() {
    const count = topicSubsList.querySelectorAll('.topic-sub-row').length;
    topicSubAdd.disabled = count >= MAX_SUBREDDIT_ROWS;
    topicSubsList.querySelectorAll('.topic-sub-remove').forEach((btn) => {
      btn.hidden = topicSubsList.querySelectorAll('.topic-sub-row').length <= 1;
    });
  }

  function addSubRow() {
    if (topicSubsList.querySelectorAll('.topic-sub-row').length >= MAX_SUBREDDIT_ROWS) return;
    const row = document.createElement('div');
    row.className = 'topic-sub-row';
    row.innerHTML = `
      <div class="prefix-input"><span>r/</span><input type="text" class="topic-sub-input" autocomplete="off"></div>
      <button type="button" class="topic-sub-remove" aria-label="Remove">&times;</button>
    `;
    row.querySelector('.topic-sub-remove').addEventListener('click', () => {
      row.remove();
      updateSubAddState();
    });
    topicSubsList.appendChild(row);
    updateSubAddState();
    row.querySelector('.topic-sub-input').focus();
  }

  function resetSubRows() {
    topicSubsList.querySelectorAll('.topic-sub-row').forEach((row, i) => {
      if (i === 0) row.querySelector('.topic-sub-input').value = '';
      else row.remove();
    });
    topicSuggestChips.innerHTML = '';
    updateSubAddState();
  }

  function addSubredditByName(name) {
    const emptyInput = [...topicSubsList.querySelectorAll('.topic-sub-input')].find((el) => !el.value.trim());
    if (emptyInput) {
      emptyInput.value = name;
      return;
    }
    addSubRow();
    const inputs = topicSubsList.querySelectorAll('.topic-sub-input');
    inputs[inputs.length - 1].value = name;
  }

  function renderSuggestChips(names) {
    topicSuggestChips.innerHTML = '';
    names.forEach((name) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'topic-suggest-chip';
      chip.textContent = '+ r/' + name;
      chip.addEventListener('click', () => {
        addSubredditByName(name);
        chip.remove();
      });
      topicSuggestChips.appendChild(chip);
    });
  }

  topicSubAdd.addEventListener('click', addSubRow);

  topicSuggestBtn.addEventListener('click', async () => {
    const query = topicQuery.value.trim();
    if (!query) {
      topicFormError.textContent = I18N.t('err_topic_suggest_need_query');
      topicFormError.hidden = false;
      return;
    }
    topicFormError.hidden = true;
    const existingSubreddits = [...topicSubsList.querySelectorAll('.topic-sub-input')].map((el) => el.value.trim()).filter(Boolean);
    topicSuggestBtn.disabled = true;
    const originalText = topicSuggestBtn.textContent;
    topicSuggestBtn.textContent = I18N.t('topic_suggest_loading');
    try {
      const res = await fetch('/api/topics/suggest-subreddits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, existingSubreddits }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || I18N.t('err_topic_suggest_default'));
      renderSuggestChips(data.suggestions || []);
    } catch (err) {
      topicFormError.textContent = err.message;
      topicFormError.hidden = false;
    } finally {
      topicSuggestBtn.disabled = false;
      topicSuggestBtn.textContent = originalText;
    }
  });

  updateSubAddState();

  // ===================== Thread =====================

  const topicThreadPanel = document.getElementById('topic-thread-panel');
  const topicThreadTitle = document.getElementById('topic-thread-title');
  const topicStatusBadge = document.getElementById('topic-status-badge');
  const topicMeta = document.getElementById('topic-meta');
  const topicLoader = document.getElementById('topic-loader');
  const topicProgress = document.getElementById('topic-progress');
  const topicThread = document.getElementById('topic-thread');
  const topicFollowupForm = document.getElementById('topic-followup-form');
  const topicFollowupInput = document.getElementById('topic-followup-input');
  const topicFollowupSubmit = document.getElementById('topic-followup-submit');
  const topicThreadError = document.getElementById('topic-thread-error');

  let currentTopicId = null;
  let pollTimer = null;

  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function fmtDate(iso) {
    if (!iso) return '-';
    const locale = I18N.getLang() === 'bg' ? 'bg-BG' : 'en-GB';
    return new Date(iso).toLocaleString(locale, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  const TIME_FILTER_LABEL_KEYS = { all: 'opt_all_time', year: 'opt_year', month: 'opt_month', week: 'opt_week', day: 'opt_day', hour: 'opt_hour' };

  function renderTopicMeta(topic) {
    const parts = [topic.subreddits.map((s) => 'r/' + s).join(', ')];
    parts.push(I18N.t(TIME_FILTER_LABEL_KEYS[topic.time_filter] || 'opt_all_time'));
    if (topic.extended) parts.push(I18N.t('topic_extended_tag'));
    topicMeta.textContent = parts.join(' · ');
    topicMeta.hidden = false;
  }

  async function loadTopicList() {
    const res = await fetch('/api/topics');
    if (!res.ok) return;
    const data = await res.json();
    if (!data.topics.length) {
      topicList.innerHTML = `<p class="history-empty">${I18N.t('topic_list_empty')}</p>`;
      return;
    }
    topicList.innerHTML = data.topics
      .map(
        (t) => `
      <div class="history-item${t.id === currentTopicId ? ' active' : ''}" data-topic-id="${t.id}">
        <div class="h-sub">${escapeHtml(t.title)} <span class="h-status ${t.status}">${I18N.t('status_' + t.status)}</span></div>
        <div class="h-meta">
          <span>${t.subreddits.map((s) => 'r/' + escapeHtml(s)).join(', ')}</span>
          <span>${fmtDate(t.updated_at)}</span>
        </div>
      </div>`
      )
      .join('');

    topicList.querySelectorAll('.history-item').forEach((el) => {
      el.addEventListener('click', () => openTopic(el.dataset.topicId));
    });
  }

  function renderMessage(msg) {
    const div = document.createElement('div');
    div.className = 'qa-item';
    if (msg.role === 'user') {
      div.innerHTML = `<div class="qa-question">${escapeHtml(msg.content)}</div>`;
    } else {
      const answerHtml = window.marked ? marked.parse(msg.content || '') : escapeHtml(msg.content || '');
      div.innerHTML = `<div class="qa-answer">${answerHtml}</div>${msg.created_at ? `<div class="qa-meta">${fmtDate(msg.created_at)}</div>` : ''}`;
    }
    topicThread.appendChild(div);
    topicThread.scrollTop = topicThread.scrollHeight;
  }

  // "done" не се показва - очевидно е готово щом виждаш отговора; за
  // running/queued/error бейджът все още носи полезна информация.
  function setStatusBadge(status) {
    if (!status || status === 'done') {
      topicStatusBadge.hidden = true;
      return;
    }
    topicStatusBadge.hidden = false;
    topicStatusBadge.textContent = I18N.t('status_' + status) || status;
    topicStatusBadge.className = 'badge ' + status;
  }

  function setFollowupEnabled(enabled) {
    topicFollowupInput.disabled = !enabled;
    topicFollowupSubmit.disabled = !enabled;
  }

  async function openTopic(topicId) {
    currentTopicId = topicId;
    clearInterval(pollTimer);
    topicComposer.hidden = true;
    topicThreadPanel.hidden = false;
    topicThreadError.hidden = true;
    topicThread.innerHTML = '';
    topicLoader.hidden = true;
    topicMeta.hidden = true;
    topicFollowupForm.hidden = true;
    setFollowupEnabled(false);

    try {
      const res = await fetch(`/api/topics/${topicId}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || I18N.t('err_topic_load_default'));

      topicThreadTitle.textContent = data.topic.title;
      setStatusBadge(data.topic.status);
      renderTopicMeta(data.topic);
      data.messages.forEach(renderMessage);

      if (data.topic.status === 'running' || data.topic.status === 'queued') {
        topicFollowupForm.hidden = false;
        startPolling(topicId);
      } else if (data.topic.status === 'done') {
        topicFollowupForm.hidden = false;
        setFollowupEnabled(true);
      } else if (data.topic.status === 'error') {
        topicThreadError.textContent = data.topic.error || I18N.t('err_topic_load_default');
        topicThreadError.hidden = false;
      }
    } catch (err) {
      topicThreadError.textContent = err.message;
      topicThreadError.hidden = false;
    }

    loadTopicList();
  }

  function startPolling(topicId) {
    topicLoader.hidden = false;
    pollTimer = setInterval(() => pollTopicStatus(topicId), 2000);
    pollTopicStatus(topicId);
  }

  async function pollTopicStatus(topicId) {
    if (topicId !== currentTopicId) return clearInterval(pollTimer);
    try {
      const res = await fetch(`/api/topics/${topicId}/status`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || I18N.t('err_topic_load_default'));

      setStatusBadge(data.status);
      topicProgress.textContent = data.progressMessage || I18N.t('topic_progress_generating');

      if (data.status === 'done') {
        clearInterval(pollTimer);
        topicLoader.hidden = true;
        const full = await fetch(`/api/topics/${topicId}`).then((r) => r.json());
        topicThread.innerHTML = '';
        full.messages.forEach(renderMessage);
        setFollowupEnabled(true);
        loadTopicList();
      } else if (data.status === 'error') {
        clearInterval(pollTimer);
        topicLoader.hidden = true;
        topicFollowupForm.hidden = true;
        topicThreadError.textContent = data.error || I18N.t('err_topic_create_default');
        topicThreadError.hidden = false;
        loadTopicList();
      }
    } catch (err) {
      clearInterval(pollTimer);
      topicLoader.hidden = true;
      topicThreadError.textContent = err.message;
      topicThreadError.hidden = false;
    }
  }

  topicNewBtn.addEventListener('click', () => {
    currentTopicId = null;
    clearInterval(pollTimer);
    topicThreadPanel.hidden = true;
    topicComposer.hidden = false;
    topicForm.reset();
    resetSubRows();
    autoResize(topicQuery);
    topicFormError.hidden = true;
    topicList.querySelectorAll('.history-item.active').forEach((el) => el.classList.remove('active'));
  });

  // Само Ctrl+Enter изпраща; обикновен Enter и Shift+Enter си остават нов ред
  // (стандартно поведение на textarea, не го пипаме).
  function wireSubmitShortcut(textarea, form) {
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.ctrlKey && !e.shiftKey) {
        e.preventDefault();
        form.requestSubmit();
      }
    });
  }
  wireSubmitShortcut(topicQuery, topicForm);
  wireSubmitShortcut(topicFollowupInput, topicFollowupForm);
  wireAutoResize(topicQuery);
  wireAutoResize(topicFollowupInput);

  topicForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    topicFormError.hidden = true;
    topicSubmit.disabled = true;
    topicSubmit.textContent = I18N.t('topic_submit_loading');

    const subreddits = [...topicSubsList.querySelectorAll('.topic-sub-input')].map((el) => el.value.trim()).filter(Boolean);

    try {
      const res = await fetch('/api/topics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subreddits,
          query: topicQuery.value.trim(),
          timeFilter: topicTimeFilter.value,
          extended: topicExtended.checked,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || I18N.t('err_topic_create_default'));

      await openTopic(data.topicId);
    } catch (err) {
      topicFormError.textContent = err.message;
      topicFormError.hidden = false;
    } finally {
      topicSubmit.disabled = false;
      topicSubmit.textContent = I18N.t('topic_submit');
    }
  });

  topicFollowupForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const content = topicFollowupInput.value.trim();
    if (!content || !currentTopicId) return;
    topicThreadError.hidden = true;
    topicFollowupInput.value = '';
    autoResize(topicFollowupInput);
    setFollowupEnabled(false);

    renderMessage({ role: 'user', content });
    topicThreadPanel.scrollIntoView({ behavior: 'smooth', block: 'end' });

    const thinking = document.createElement('div');
    thinking.className = 'qa-thinking';
    thinking.textContent = I18N.t('qa_thinking');
    topicThread.appendChild(thinking);
    topicThread.scrollTop = topicThread.scrollHeight;

    try {
      const res = await fetch(`/api/topics/${currentTopicId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      const data = await res.json();
      thinking.remove();
      if (!res.ok) throw new Error(data.error || I18N.t('err_topic_followup_default'));
      renderMessage(data);
      loadTopicList();
    } catch (err) {
      thinking.remove();
      topicThreadError.textContent = err.message;
      topicThreadError.hidden = false;
    } finally {
      setFollowupEnabled(true);
      topicFollowupInput.focus();
    }
  });

  document.addEventListener('app:ready', () => {
    loadTopicList();
  });

  document.addEventListener('i18n:change', () => {
    if (!document.getElementById('app-view').hidden) loadTopicList();
  });
})();
