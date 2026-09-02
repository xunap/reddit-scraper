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

  // Само EN/BG се поддържат, затова кликването на който и да е от двата
  // бутона просто превключва към другия език.
  document.querySelectorAll('#lang-switch [data-lang-option]').forEach((btn) => {
    btn.addEventListener('click', () => I18N.setLang(I18N.getLang() === 'en' ? 'bg' : 'en'));
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

  // ===================== BOOT =====================

  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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

    if (me.googleEnabled) {
      googleBtn.hidden = false;
      googleDivider.hidden = false;
    }
    if (me.user) {
      renderTopbarUser(me.user);
      appView.hidden = false;
      document.dispatchEvent(new CustomEvent('app:ready', { detail: { user: me.user, llmEnabled: Boolean(me.llmEnabled) } }));
    } else {
      authView.hidden = false;
    }
    bootLoader.hidden = true;
  })();
})();
