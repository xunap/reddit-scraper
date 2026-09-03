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
  const MAX_SUBREDDIT_ROWS = 10;
  const topicOwnKnowledge = document.getElementById('topic-own-knowledge');
  const topicDepth = document.getElementById('topic-depth');
  const topicTimeFilter = document.getElementById('topic-time-filter');

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
    updateSubAddState();
  }

  topicSubAdd.addEventListener('click', addSubRow);
  updateSubAddState();

  const topicThreadPanel = document.getElementById('topic-thread-panel');
  const topicThreadTitle = document.getElementById('topic-thread-title');
  const topicStatusBadge = document.getElementById('topic-status-badge');
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
        <div class="h-sub">${t.use_own_knowledge ? `<span class="h-own-knowledge" title="${I18N.t('topic_own_knowledge_badge')}">&#129504;</span> ` : ''}${escapeHtml(t.title)} <span class="h-status ${t.status}">${I18N.t('status_' + t.status)}</span></div>
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

  function setStatusBadge(status) {
    if (!status) {
      topicStatusBadge.hidden = true;
      return;
    }
    topicStatusBadge.hidden = false;
    topicStatusBadge.textContent = I18N.t('status_' + status) || status;
    topicStatusBadge.className = 'badge ' + status;
  }

  async function openTopic(topicId) {
    currentTopicId = topicId;
    clearInterval(pollTimer);
    topicComposer.hidden = true;
    topicThreadPanel.hidden = false;
    topicThreadError.hidden = true;
    topicThread.innerHTML = '';
    topicFollowupForm.hidden = true;
    topicProgress.hidden = true;

    try {
      const res = await fetch(`/api/topics/${topicId}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || I18N.t('err_topic_load_default'));

      topicThreadTitle.textContent = data.topic.title;
      setStatusBadge(data.topic.status);
      topicOwnKnowledge.checked = Boolean(data.topic.use_own_knowledge);
      data.messages.forEach(renderMessage);

      if (data.topic.status === 'running' || data.topic.status === 'queued') {
        startPolling(topicId);
      } else if (data.topic.status === 'done') {
        topicFollowupForm.hidden = false;
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
    topicProgress.hidden = false;
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
        topicProgress.hidden = true;
        const full = await fetch(`/api/topics/${topicId}`).then((r) => r.json());
        topicThread.innerHTML = '';
        full.messages.forEach(renderMessage);
        topicFollowupForm.hidden = false;
        loadTopicList();
      } else if (data.status === 'error') {
        clearInterval(pollTimer);
        topicProgress.hidden = true;
        topicThreadError.textContent = data.error || I18N.t('err_topic_create_default');
        topicThreadError.hidden = false;
        loadTopicList();
      }
    } catch (err) {
      clearInterval(pollTimer);
      topicProgress.hidden = true;
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
    topicFormError.hidden = true;
    topicList.querySelectorAll('.history-item.active').forEach((el) => el.classList.remove('active'));
  });

  // Ctrl+Enter, Shift+Enter, или Ctrl+Shift+Enter изпращат формата; обикновен
  // Enter си остава нов ред в textarea-та.
  function wireSubmitShortcut(textarea, form) {
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.shiftKey)) {
        e.preventDefault();
        form.requestSubmit();
      }
    });
  }
  wireSubmitShortcut(topicQuery, topicForm);
  wireSubmitShortcut(topicFollowupInput, topicFollowupForm);

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
          useOwnKnowledge: topicOwnKnowledge.checked,
          depth: topicDepth.value,
          timeFilter: topicTimeFilter.value,
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
    topicFollowupSubmit.disabled = true;
    topicFollowupInput.disabled = true;

    renderMessage({ role: 'user', content });

    const thinking = document.createElement('div');
    thinking.className = 'qa-thinking';
    thinking.textContent = I18N.t('qa_thinking');
    topicThread.appendChild(thinking);
    topicThread.scrollTop = topicThread.scrollHeight;

    try {
      const res = await fetch(`/api/topics/${currentTopicId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, useOwnKnowledge: topicOwnKnowledge.checked }),
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
      topicFollowupSubmit.disabled = false;
      topicFollowupInput.disabled = false;
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
