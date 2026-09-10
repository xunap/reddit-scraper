(function () {
  const topicNewBtn = document.getElementById('topic-new-btn');
  const topicList = document.getElementById('topic-list');

  const ICON_RENAME = '<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M13.5 3.5l3 3L7 16H4v-3L13.5 3.5z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  const ICON_DELETE = '<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 6h12M8 6V4.5a1 1 0 011-1h2a1 1 0 011 1V6m-7 0l.6 9.4a1 1 0 001 .9h4.8a1 1 0 001-.9L14 6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  const topicComposer = document.getElementById('topic-composer');
  const topicForm = document.getElementById('topic-form');
  const topicSubmit = document.getElementById('topic-submit');
  const topicFormError = document.getElementById('topic-form-error');
  const topicQuery = document.getElementById('topic-query');
  const topicSubsTags = document.getElementById('topic-subs-tags');
  const topicSubText = document.getElementById('topic-sub-text');
  const topicSubPrefix = document.getElementById('topic-sub-prefix');
  const topicSuggestBtn = document.getElementById('topic-suggest-btn');
  const topicSuggestChips = document.getElementById('topic-suggest-chips');
  const MAX_SUBREDDIT_TAGS = 10;
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

  // ===================== Тагове за сабредити (единен инпут, до 10) =====================

  let subTags = [];

  // Само латиница/цифри/долна черта, докато пишеш - Reddit имената на
  // сабредити не поддържат нищо друго, а така случайно превключена кирилица
  // (или каквато и да е друга азбука) никога не влиза в полето.
  function filterSubText() {
    const cleaned = topicSubText.value.replace(/^\/?r\//i, '').replace(/[^a-zA-Z0-9_]/g, '');
    if (cleaned !== topicSubText.value) topicSubText.value = cleaned;
  }

  function renderSubTags() {
    topicSubsTags.querySelectorAll('.sub-tag').forEach((el) => el.remove());
    subTags.forEach((name) => {
      const tag = document.createElement('span');
      tag.className = 'sub-tag';
      tag.innerHTML = `<span class="tag-prefix">r/</span><span>${escapeHtml(name)}</span>`;
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'tag-remove';
      removeBtn.innerHTML = '&times;';
      removeBtn.setAttribute('aria-label', 'Remove');
      removeBtn.addEventListener('click', () => removeSubTag(name));
      tag.appendChild(removeBtn);
      topicSubsTags.insertBefore(tag, topicSubPrefix);
    });
    const atMax = subTags.length >= MAX_SUBREDDIT_TAGS;
    topicSubPrefix.hidden = atMax;
    topicSubText.hidden = atMax;
    if (atMax) closeAutocomplete();
  }

  function addSubTag(name) {
    const clean = String(name || '').replace(/^\/?r\//i, '').replace(/[^a-zA-Z0-9_]/g, '');
    if (!clean || subTags.length >= MAX_SUBREDDIT_TAGS) return false;
    if (subTags.some((s) => s.toLowerCase() === clean.toLowerCase())) return false;
    subTags.push(clean);
    renderSubTags();
    return true;
  }

  function removeSubTag(name) {
    subTags = subTags.filter((s) => s !== name);
    renderSubTags();
    topicSubText.focus();
  }

  function resetSubTags() {
    subTags = [];
    topicSubText.value = '';
    topicSuggestChips.innerHTML = '';
    renderSubTags();
  }

  function commitPendingSubText() {
    const val = topicSubText.value.trim();
    if (val) {
      addSubTag(val);
      topicSubText.value = '';
    }
  }

  function addSubredditByName(name) {
    addSubTag(name);
  }

  topicSubText.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      commitPendingSubText();
      closeAutocomplete();
    } else if (e.key === 'Backspace' && !topicSubText.value && subTags.length) {
      removeSubTag(subTags[subTags.length - 1]);
    }
  });

  // Клик някъде другаде в кутията (не върху таг/бутон) фокусира инпута -
  // прави цялата кутия да се държи като едно поле, не само тесния текст input.
  topicSubsTags.addEventListener('click', (e) => {
    if (e.target === topicSubsTags) topicSubText.focus();
  });

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

  topicSuggestBtn.addEventListener('click', async () => {
    const query = topicQuery.value.trim();
    if (!query) {
      topicFormError.textContent = I18N.t('err_topic_suggest_need_query');
      topicFormError.hidden = false;
      return;
    }
    topicFormError.hidden = true;
    const existingSubreddits = subTags.slice();
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

  renderSubTags();

  // ===================== Autocomplete за имена на сабредити =====================

  let acDropdown = null;
  let acAbortController = null;
  let acDebounceTimer = null;

  function closeAutocomplete() {
    if (acDropdown) {
      acDropdown.remove();
      acDropdown = null;
    }
  }

  function renderAutocomplete(results) {
    closeAutocomplete();
    if (!results.length) return;
    const dropdown = document.createElement('div');
    dropdown.className = 'sub-autocomplete';
    results.forEach((r) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'sub-autocomplete-item';
      item.innerHTML = `<span>r/${escapeHtml(r.name)}</span>`;
      // mousedown (не click) за да хванем избора преди input-ът да загуби фокус.
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        addSubTag(r.name);
        topicSubText.value = '';
        closeAutocomplete();
      });
      dropdown.appendChild(item);
    });
    topicSubsTags.appendChild(dropdown);
    acDropdown = dropdown;
  }

  topicSubText.addEventListener('input', () => {
    filterSubText();
    clearTimeout(acDebounceTimer);
    const q = topicSubText.value.trim();
    if (q.length < 2) {
      closeAutocomplete();
      return;
    }
    acDebounceTimer = setTimeout(async () => {
      if (acAbortController) acAbortController.abort();
      acAbortController = new AbortController();
      try {
        const res = await fetch(`/api/subreddits/autocomplete?q=${encodeURIComponent(q)}`, { signal: acAbortController.signal });
        const data = await res.json();
        if (document.activeElement === topicSubText) renderAutocomplete(data.results || []);
      } catch (err) {
        // тихо - автодовършването не е критично
      }
    }, 250);
  });

  topicSubText.addEventListener('focusout', () => {
    // малко отлагане, за да може mousedown върху резултат да отработи първо
    setTimeout(closeAutocomplete, 150);
  });

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
      <div class="history-item${t.id === currentTopicId ? ' active' : ''}" data-topic-id="${t.id}" data-title="${escapeHtml(t.title)}">
        <div class="h-sub"><span class="h-title">${escapeHtml(t.title)}</span> <span class="h-status ${t.status}">${I18N.t('status_' + t.status)}</span></div>
        <div class="h-subs-line">${t.subreddits.map((s) => 'r/' + escapeHtml(s)).join(', ')}</div>
        <div class="h-meta">
          <span class="h-date">${fmtDate(t.updated_at)}</span>
          <span class="h-actions">
            <button type="button" class="h-icon-btn h-rename" title="${I18N.t('tooltip_rename')}" aria-label="${I18N.t('tooltip_rename')}">${ICON_RENAME}</button>
            <button type="button" class="h-icon-btn h-delete" title="${I18N.t('tooltip_delete')}" aria-label="${I18N.t('tooltip_delete')}">${ICON_DELETE}</button>
          </span>
        </div>
      </div>`
      )
      .join('');

    topicList.querySelectorAll('.history-item').forEach((el) => {
      const id = el.dataset.topicId;
      el.addEventListener('click', () => navigateToTopic(id));
      el.querySelector('.h-rename').addEventListener('click', (e) => {
        e.stopPropagation();
        startRenameTopic(el, id);
      });
      el.querySelector('.h-delete').addEventListener('click', (e) => {
        e.stopPropagation();
        deleteTopic(id);
      });
    });
  }

  function startRenameTopic(el, id) {
    const subEl = el.querySelector('.h-sub');
    const statusEl = subEl.querySelector('.h-status');
    const currentTitle = el.dataset.title;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'h-rename-input';
    input.value = currentTitle;
    input.maxLength = 200;
    subEl.innerHTML = '';
    subEl.appendChild(input);
    if (statusEl) subEl.appendChild(statusEl);
    input.focus();
    input.select();

    let done = false;
    const commit = async () => {
      if (done) return;
      done = true;
      const newTitle = input.value.trim();
      if (!newTitle || newTitle === currentTitle) return loadTopicList();
      try {
        const res = await fetch(`/api/topics/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: newTitle }),
        });
        if (!res.ok) throw new Error();
        if (id === currentTopicId) topicThreadTitle.textContent = newTitle;
      } catch (err) {
        // тихо се отказваме, старото заглавие се връща при следващото loadTopicList
      }
      loadTopicList();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        input.blur();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        done = true;
        loadTopicList();
      }
    });
    input.addEventListener('blur', commit);
  }

  async function deleteTopic(id) {
    if (!confirm(I18N.t('confirm_delete_topic'))) return;
    try {
      const res = await fetch(`/api/topics/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error();
    } catch (err) {
      alert(I18N.t('err_topic_delete_default'));
      return;
    }
    if (id === currentTopicId) {
      currentTopicId = null;
      clearInterval(pollTimer);
      topicThreadPanel.hidden = true;
      topicComposer.hidden = false;
      navigateToNew();
    }
    loadTopicList();
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

  // Полето си остава активно докато чака отговор (за да можеш да пишеш
  // следващия въпрос междувременно) - само бутонът се блокира, за да не се
  // изпрати нищо преди текущият отговор да е готов.
  function setFollowupEnabled(enabled) {
    topicFollowupSubmit.disabled = !enabled;
  }

  function scrollToBottomAndFocusFollowup() {
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
    topicFollowupInput.focus();
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
    scrollToBottomAndFocusFollowup();
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
        scrollToBottomAndFocusFollowup();
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

  // ===================== URL <-> тема (two-way binding, като claude.ai) =====

  const TOPIC_URL_RE = /^\/t\/([a-zA-Z0-9]+)$/;

  function navigateToTopic(id) {
    if (location.pathname !== `/t/${id}`) history.pushState({ topicId: id }, '', `/t/${id}`);
    openTopic(id);
  }

  function navigateToNew() {
    if (location.pathname !== '/') history.pushState({ topicId: null }, '', '/');
  }

  function showComposer() {
    currentTopicId = null;
    clearInterval(pollTimer);
    topicThreadPanel.hidden = true;
    topicComposer.hidden = false;
    topicForm.reset();
    resetSubTags();
    autoResize(topicQuery);
    topicFormError.hidden = true;
    topicList.querySelectorAll('.history-item.active').forEach((el) => el.classList.remove('active'));
  }

  window.addEventListener('popstate', () => {
    const match = location.pathname.match(TOPIC_URL_RE);
    if (match) openTopic(match[1]);
    else showComposer();
  });

  topicNewBtn.addEventListener('click', () => {
    navigateToNew();
    showComposer();
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
    commitPendingSubText();
    const subreddits = subTags.slice();
    if (!subreddits.length) {
      topicFormError.textContent = I18N.t('err_topic_need_subreddit');
      topicFormError.hidden = false;
      return;
    }
    topicSubmit.disabled = true;
    topicSubmit.textContent = I18N.t('topic_submit_loading');

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

      navigateToTopic(data.topicId);
    } catch (err) {
      topicFormError.textContent = err.message;
      topicFormError.hidden = false;
    } finally {
      topicSubmit.disabled = false;
      topicSubmit.textContent = I18N.t('topic_submit');
    }
  });

  let followupInFlight = false;

  topicFollowupForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (followupInFlight) return;
    const content = topicFollowupInput.value.trim();
    if (!content || !currentTopicId) return;
    followupInFlight = true;
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
      followupInFlight = false;
      setFollowupEnabled(true);
      scrollToBottomAndFocusFollowup();
    }
  });

  document.addEventListener('app:ready', () => {
    loadTopicList();
    const match = location.pathname.match(TOPIC_URL_RE);
    if (match) {
      history.replaceState({ topicId: match[1] }, '', location.pathname);
      openTopic(match[1]);
    } else {
      // При първоначалното зареждане wireAutoResize()-ът по-горе смята
      // scrollHeight докато #app-view (родителят) все още е [hidden] по
      // време на auth проверката - тогава scrollHeight винаги е 0, затова
      // textarea-та тръгва свита, докато потребителят не напише нещо. Сега
      // #app-view вече е видим, преизчисляваме.
      autoResize(topicQuery);
    }
  });

  document.addEventListener('i18n:change', () => {
    if (!document.getElementById('app-view').hidden) loadTopicList();
  });
})();
