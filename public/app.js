(function () {
  const bootLoader = document.getElementById('boot-loader');
  const authView = document.getElementById('auth-view');
  const appView = document.getElementById('app-view');
  const topbarUser = document.getElementById('topbar-user');

  const loginForm = document.getElementById('login-form');
  const signupForm = document.getElementById('signup-form');
  const authTabs = document.querySelectorAll('.auth-tab');
  const googleBtn = document.getElementById('google-btn');
  const googleDivider = document.getElementById('google-divider');

  const historyList = document.getElementById('history-list');

  const form = document.getElementById('scrape-form');
  const submitBtn = document.getElementById('submit-btn');
  const formError = document.getElementById('form-error');
  const sortSelect = document.getElementById('sort');
  const timeFilterField = document.getElementById('timefilter-field');

  const statusPanel = document.getElementById('status-panel');
  const statusTitle = document.getElementById('status-title');
  const statusBadge = document.getElementById('status-badge');
  const progressFill = document.getElementById('progress-fill');
  const progressLabel = document.getElementById('progress-label');
  const logBox = document.getElementById('log-box');

  const resultsPanel = document.getElementById('results-panel');
  const statsRow = document.getElementById('stats-row');
  const tbody = document.getElementById('results-tbody');
  const downloadJson = document.getElementById('download-json');
  const downloadCsv = document.getElementById('download-csv');

  const qaPanel = document.getElementById('qa-panel');
  const qaHint = document.getElementById('qa-hint');
  const qaThread = document.getElementById('qa-thread');
  const qaForm = document.getElementById('qa-form');
  const qaInput = document.getElementById('qa-input');
  const qaSubmit = document.getElementById('qa-submit');
  const qaError = document.getElementById('qa-error');

  let currentJobId = null;
  let pollTimer = null;
  let logCursor = 0;
  let currentPosts = [];
  let sortState = { key: 'votes', dir: -1 };
  let llmEnabled = false;
  let currentSubreddit = null;
  let currentHasDetails = false;

  function renderStatusTitle() {
    statusTitle.textContent = currentSubreddit
      ? I18N.t('status_title_running', { sub: currentSubreddit })
      : I18N.t('status_title_default');
  }

  function renderStatsRow() {
    const votes = currentPosts.map((p) => p.votes || 0);
    const total = currentPosts.length;
    const avgVotes = total ? Math.round(votes.reduce((a, b) => a + b, 0) / total) : 0;
    const dates = currentPosts.map((p) => p.date).filter(Boolean).sort();
    statsRow.innerHTML = `
      <span>${I18N.t('stats_posts')} <b>${total}</b></span>
      <span>${I18N.t('stats_avg_votes')} <b>${avgVotes}</b></span>
      <span>${I18N.t('stats_range')} <b>${dates[0] ? dates[0].slice(0, 10) : '—'} → ${dates.length ? dates[dates.length - 1].slice(0, 10) : '—'}</b></span>
    `;
  }

  function renderQaHint() {
    qaHint.textContent = currentHasDetails
      ? I18N.t('qa_hint_with_details', { sub: currentSubreddit })
      : I18N.t('qa_hint_no_details');
  }

  // ===================== AUTH =====================

  async function fetchMe() {
    const res = await fetch('/api/auth/me');
    return res.json();
  }

  function renderTopbarUser(user) {
    if (user) {
      topbarUser.innerHTML = `<span class="email">${escapeHtml(user.email)}</span><button id="logout-btn" type="button" data-i18n="btn_logout">${I18N.t('btn_logout')}</button>`;
      document.getElementById('logout-btn').addEventListener('click', async () => {
        await fetch('/api/auth/logout', { method: 'POST' });
        location.reload();
      });
    } else {
      topbarUser.innerHTML = '';
    }
  }

  document.querySelectorAll('#lang-switch [data-lang-option]').forEach((btn) => {
    btn.addEventListener('click', () => I18N.setLang(btn.getAttribute('data-lang-option')));
  });
  document.addEventListener('i18n:change', () => {
    if (currentJobId) renderStatusTitle();
    loadHistory();
    if (!resultsPanel.hidden) renderStatsRow();
    if (!qaPanel.hidden) renderQaHint();
  });

  authTabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      authTabs.forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      const isLogin = tab.dataset.tab === 'login';
      loginForm.hidden = !isLogin;
      signupForm.hidden = isLogin;
    });
  });

  function showFormError(form, message) {
    const el = document.querySelector(`.form-error[data-for="${form.id}"]`);
    el.textContent = message;
    el.hidden = false;
  }

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = { email: loginForm.email.value.trim(), password: loginForm.password.value };
    const res = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) return showFormError(loginForm, data.error || I18N.t('err_login_default'));
    location.reload();
  });

  signupForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = { email: signupForm.email.value.trim(), password: signupForm.password.value };
    const res = await fetch('/api/auth/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) return showFormError(signupForm, data.error || I18N.t('err_signup_default'));
    location.reload();
  });

  // ===================== HISTORY =====================

  function fmtDate(iso) {
    if (!iso) return '—';
    const locale = I18N.getLang() === 'bg' ? 'bg-BG' : 'en-GB';
    return new Date(iso).toLocaleString(locale, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  async function loadHistory() {
    const res = await fetch('/api/history');
    if (!res.ok) return;
    const data = await res.json();
    if (!data.jobs.length) {
      historyList.innerHTML = `<p class="history-empty">${I18N.t('history_empty')}</p>`;
      return;
    }
    historyList.innerHTML = data.jobs
      .map(
        (j) => `
      <div class="history-item" data-job-id="${j.id}">
        <div class="h-sub">r/${escapeHtml(j.subreddit)} <span class="h-status ${j.status}">${I18N.t('status_' + j.status)}</span></div>
        <div class="h-meta">
          <span>${j.sort}${j.sort === 'top' ? `(${j.time_filter})` : ''}</span>
          <span>${I18N.t('history_posts_count', { count: j.post_count ?? '—' })}</span>
          <span>${fmtDate(j.created_at)}</span>
        </div>
      </div>`
      )
      .join('');

    historyList.querySelectorAll('.history-item').forEach((el) => {
      el.addEventListener('click', () => openHistoryJob(el.dataset.jobId));
    });
  }

  async function openHistoryJob(jobId) {
    currentJobId = jobId;
    statusPanel.hidden = true;
    formError.hidden = true;
    try {
      await loadResults();
    } catch (err) {
      alert(I18N.t('err_load_results') + err.message);
    }
  }

  // ===================== SCRAPE FORM =====================

  function toggleTimeFilter() {
    timeFilterField.style.display = sortSelect.value === 'top' ? '' : 'none';
  }
  sortSelect.addEventListener('change', toggleTimeFilter);
  toggleTimeFilter();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    formError.hidden = true;
    submitBtn.disabled = true;
    submitBtn.textContent = I18N.t('btn_start_scrape_loading');

    const payload = {
      subreddit: document.getElementById('subreddit').value.trim(),
      sort: sortSelect.value,
      timeFilter: document.getElementById('timeFilter').value,
      limit: parseInt(document.getElementById('limit').value, 10) || 50,
      fetchDetails: document.getElementById('fetchDetails').checked,
    };

    try {
      const res = await fetch('/api/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || I18N.t('err_start_failed'));

      currentJobId = data.jobId;
      currentSubreddit = payload.subreddit;
      logCursor = 0;
      logBox.textContent = '';
      resultsPanel.hidden = true;
      qaPanel.hidden = true;
      statusPanel.hidden = false;
      renderStatusTitle();
      setBadge('queued');
      startPolling();
    } catch (err) {
      formError.textContent = err.message;
      formError.hidden = false;
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = I18N.t('btn_start_scrape');
    }
  });

  function setBadge(status) {
    statusBadge.textContent = I18N.t('status_' + status) || status;
    statusBadge.className = 'badge ' + status;
  }

  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(pollJob, 1500);
    pollJob();
  }

  async function pollJob() {
    if (!currentJobId) return;
    try {
      const res = await fetch(`/api/jobs/${currentJobId}?sinceLog=${logCursor}`);
      const job = await res.json();
      if (!res.ok) throw new Error(job.error || I18N.t('err_job_not_found'));

      if (job.log && job.log.length) {
        for (const entry of job.log) logBox.textContent += entry.message + '\n';
        logCursor = job.logLength;
        logBox.scrollTop = logBox.scrollHeight;
      }
      setBadge(job.status);

      if (job.status === 'queued' && job.queuePosition) {
        progressLabel.textContent = I18N.t('queue_position', { pos: job.queuePosition });
      } else if (job.progress && job.progress.total) {
        const pct = Math.min(100, Math.round((job.progress.current / job.progress.total) * 100));
        progressFill.style.width = pct + '%';
        const phaseLabel = I18N.t('phase_' + job.progress.phase) || job.progress.phase;
        progressLabel.textContent = `${phaseLabel} — ${job.progress.current}/${job.progress.total}`;
      }

      if (job.status === 'done') {
        clearInterval(pollTimer);
        progressFill.style.width = '100%';
        await loadResults();
        loadHistory();
      } else if (job.status === 'error') {
        clearInterval(pollTimer);
        progressLabel.textContent = I18N.t('err_prefix') + job.error;
        loadHistory();
      }
    } catch (err) {
      clearInterval(pollTimer);
      setBadge('error');
      progressLabel.textContent = I18N.t('err_status_check') + err.message;
    }
  }

  async function loadResults() {
    const res = await fetch(`/api/jobs/${currentJobId}/results`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || I18N.t('err_generic_load'));
    currentPosts = data.posts || [];
    currentSubreddit = data.params.subreddit;

    renderStatsRow();

    downloadJson.href = `/api/jobs/${currentJobId}/export.json`;
    downloadCsv.href = `/api/jobs/${currentJobId}/export.csv`;

    renderTable();
    resultsPanel.hidden = false;

    currentHasDetails = currentPosts.some((p) => p.bodyText || (p.topComments && p.topComments.length));
    if (llmEnabled) {
      qaPanel.hidden = false;
      renderQaHint();
      await loadQaThread();
    } else {
      qaPanel.hidden = true;
    }
  }

  function renderTable() {
    const sorted = [...currentPosts].sort((a, b) => {
      const av = a[sortState.key];
      const bv = b[sortState.key];
      if (av === bv) return 0;
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      return av > bv ? sortState.dir : -sortState.dir;
    });

    tbody.innerHTML = sorted
      .map(
        (p) => `
      <tr>
        <td class="title-cell"><a href="${escapeAttr(p.url)}" target="_blank" rel="noopener">${escapeHtml(p.title)}</a></td>
        <td>${escapeHtml(p.author)}</td>
        <td class="num">${p.votes ?? '—'}</td>
        <td class="num">${p.comments ?? 0}</td>
        <td>${p.date ? p.date.slice(0, 10) : '—'}</td>
      </tr>`
      )
      .join('');
  }

  document.querySelectorAll('#results-table th[data-key]').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.getAttribute('data-key');
      if (sortState.key === key) sortState.dir *= -1;
      else sortState = { key, dir: -1 };
      renderTable();
    });
  });

  // ===================== Q&A =====================

  function renderQaItem(item) {
    const div = document.createElement('div');
    div.className = 'qa-item';
    const answerHtml = window.marked ? marked.parse(item.answer || '') : escapeHtml(item.answer || '');
    div.innerHTML = `
      <div class="qa-question">${escapeHtml(item.question)}</div>
      <div class="qa-answer">${answerHtml}</div>
      ${item.created_at ? `<div class="qa-meta">${fmtDate(item.created_at)}</div>` : ''}
    `;
    qaThread.appendChild(div);
    qaThread.scrollTop = qaThread.scrollHeight;
  }

  async function loadQaThread() {
    qaThread.innerHTML = '';
    const res = await fetch(`/api/jobs/${currentJobId}/qa`);
    if (!res.ok) return;
    const data = await res.json();
    data.qa.forEach(renderQaItem);
  }

  qaForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const question = qaInput.value.trim();
    if (!question || !currentJobId) return;
    qaError.hidden = true;
    qaSubmit.disabled = true;
    qaInput.disabled = true;

    const thinking = document.createElement('div');
    thinking.className = 'qa-thinking';
    thinking.textContent = I18N.t('qa_thinking');
    qaThread.appendChild(thinking);
    qaThread.scrollTop = qaThread.scrollHeight;

    try {
      const res = await fetch(`/api/jobs/${currentJobId}/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question }),
      });
      const data = await res.json();
      thinking.remove();
      if (!res.ok) throw new Error(data.error || I18N.t('err_ask'));
      renderQaItem(data);
      qaInput.value = '';
    } catch (err) {
      thinking.remove();
      qaError.textContent = err.message;
      qaError.hidden = false;
    } finally {
      qaSubmit.disabled = false;
      qaInput.disabled = false;
      qaInput.focus();
    }
  });

  // ===================== BOOT =====================

  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function escapeAttr(str) {
    return escapeHtml(str);
  }

  (async function boot() {
    I18N.applyStaticTranslations();

    let me;
    try {
      me = await fetchMe();
    } catch (err) {
      bootLoader.hidden = true;
      authView.hidden = false;
      showFormError(loginForm, I18N.t('err_connect'));
      return;
    }

    llmEnabled = Boolean(me.llmEnabled);
    if (me.googleEnabled) {
      googleBtn.hidden = false;
      googleDivider.hidden = false;
    }
    if (me.user) {
      renderTopbarUser(me.user);
      appView.hidden = false;
      loadHistory();
    } else {
      authView.hidden = false;
    }
    bootLoader.hidden = true;
  })();
})();
