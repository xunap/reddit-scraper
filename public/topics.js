(function () {
  const topicNewBtn = document.getElementById('topic-new-btn');
  const topicList = document.getElementById('topic-list');

  const topicComposer = document.getElementById('topic-composer');
  const topicForm = document.getElementById('topic-form');
  const topicSubmit = document.getElementById('topic-submit');
  const topicFormError = document.getElementById('topic-form-error');
  const topicQuery = document.getElementById('topic-query');
  const topicSub1 = document.getElementById('topic-sub-1');
  const topicSub2 = document.getElementById('topic-sub-2');
  const topicSub3 = document.getElementById('topic-sub-3');
  const topicOwnKnowledge = document.getElementById('topic-own-knowledge');
  const topicPostCount = document.getElementById('topic-post-count');
  const topicDepth = document.getElementById('topic-depth');

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
    topicFormError.hidden = true;
    topicList.querySelectorAll('.history-item.active').forEach((el) => el.classList.remove('active'));
  });

  topicForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    topicFormError.hidden = true;
    topicSubmit.disabled = true;
    topicSubmit.textContent = I18N.t('topic_submit_loading');

    const subreddits = [topicSub1.value, topicSub2.value, topicSub3.value].map((s) => s.trim()).filter(Boolean);

    try {
      const res = await fetch('/api/topics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subreddits,
          query: topicQuery.value.trim(),
          useOwnKnowledge: topicOwnKnowledge.checked,
          postCount: parseInt(topicPostCount.value, 10),
          depth: topicDepth.value,
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
    topicFollowupSubmit.disabled = true;
    topicFollowupInput.disabled = true;

    const thinking = document.createElement('div');
    thinking.className = 'qa-thinking';
    thinking.textContent = I18N.t('qa_thinking');
    topicThread.appendChild(thinking);
    topicThread.scrollTop = topicThread.scrollHeight;

    renderMessage({ role: 'user', content });

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
      topicFollowupInput.value = '';
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
