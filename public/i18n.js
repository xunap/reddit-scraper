(function () {
  const STORAGE_KEY = 'rs_lang';

  const STRINGS = {
    en: {
      brand_sub: 'Playwright · no API',
      auth_tab_login: 'Log in',
      auth_tab_signup: 'Sign up',
      field_password_login: 'Password',
      field_password_signup: 'Password (min. 8 characters)',
      btn_login: 'Log in',
      btn_signup: 'Sign up',
      auth_divider_or: 'or',
      btn_google: 'Continue with Google',
      topic_new: 'New topic',
      topic_list_empty: 'No topics yet.',
      topic_composer_title: 'What do you want to know?',
      topic_query_label: 'Your question / topic',
      topic_sub1: 'Subreddit',
      topic_sub_add: 'Add subreddit',
      topic_suggest_btn: 'Suggest related subreddits',
      topic_suggest_loading: 'Thinking...',
      err_topic_suggest_need_query: 'Write your question/topic first, then suggest.',
      err_topic_suggest_default: 'Failed to get suggestions.',
      topic_time_filter_label: 'When to scrape from',
      opt_all_time: 'All time',
      opt_year: 'Year',
      opt_month: 'Month',
      opt_week: 'Week',
      opt_day: 'Day',
      opt_hour: 'Hour',
      topic_extended_label: 'Extended response?',
      topic_extended_tag: 'Extended',
      topic_submit: 'Start digest',
      topic_submit_loading: 'Starting...',
      topic_followup_placeholder: 'Ask a follow-up...',
      err_topic_create_default: 'Failed to start the topic.',
      err_topic_load_default: 'Failed to load the topic.',
      err_topic_followup_default: 'Failed to get an answer.',
      topic_progress_generating: 'Generating the digest...',
      btn_ask: 'Ask',
      qa_thinking: 'Thinking...',
      btn_logout: 'Log out',
      err_login_default: 'Login failed.',
      err_signup_default: 'Signup failed.',
      err_connect: 'Could not connect to the server. Reload the page.',
      status_queued: 'queued',
      status_running: 'running',
      status_done: 'done',
      status_error: 'error',
    },
    bg: {
      brand_sub: 'Playwright · без API',
      auth_tab_login: 'Вход',
      auth_tab_signup: 'Регистрация',
      field_password_login: 'Парола',
      field_password_signup: 'Парола (мин. 8 символа)',
      btn_login: 'Влез',
      btn_signup: 'Регистрирай се',
      auth_divider_or: 'или',
      btn_google: 'Продължи с Google',
      topic_new: 'Нова тема',
      topic_list_empty: 'Все още няма теми.',
      topic_composer_title: 'Какво искаш да разбереш?',
      topic_query_label: 'Твоят въпрос / тема',
      topic_sub1: 'Събредит',
      topic_sub_add: 'Добави събредит',
      topic_suggest_btn: 'Предложи сродни събредити',
      topic_suggest_loading: 'Мисля...',
      err_topic_suggest_need_query: 'Първо напиши въпроса/темата, после предложи.',
      err_topic_suggest_default: 'Неуспешно получаване на предложения.',
      topic_time_filter_label: 'От кога да скрейпва',
      opt_all_time: 'За всички времена',
      opt_year: 'Година',
      opt_month: 'Месец',
      opt_week: 'Седмица',
      opt_day: 'Ден',
      opt_hour: 'Час',
      topic_extended_label: 'Разширен отговор?',
      topic_extended_tag: 'Разширен',
      topic_submit: 'Стартирай дайджест',
      topic_submit_loading: 'Стартиране...',
      topic_followup_placeholder: 'Допълнителен въпрос...',
      err_topic_create_default: 'Неуспешно стартиране на темата.',
      err_topic_load_default: 'Неуспешно зареждане на темата.',
      err_topic_followup_default: 'Грешка при въпроса.',
      topic_progress_generating: 'Генериране на дайджеста...',
      btn_ask: 'Попитай',
      qa_thinking: 'Мисля...',
      btn_logout: 'Изход',
      err_login_default: 'Грешка при вход.',
      err_signup_default: 'Грешка при регистрация.',
      err_connect: 'Неуспешна връзка със сървъра. Презареди страницата.',
      status_queued: 'на опашка',
      status_running: 'в процес',
      status_done: 'готово',
      status_error: 'грешка',
    },
  };

  let current = 'en';
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && STRINGS[stored]) current = stored;
  } catch (e) {}

  function t(key, vars) {
    let str = (STRINGS[current] && STRINGS[current][key]) || STRINGS.en[key] || key;
    if (vars) {
      for (const k in vars) str = str.replace(`{${k}}`, vars[k]);
    }
    return str;
  }

  function applyStaticTranslations() {
    document.documentElement.lang = current;
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
      el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder')));
    });
    document.querySelectorAll('[data-lang-option]').forEach((el) => {
      el.classList.toggle('active', el.getAttribute('data-lang-option') === current);
    });
  }

  function setLang(lang) {
    if (!STRINGS[lang] || lang === current) return;
    current = lang;
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch (e) {}
    applyStaticTranslations();
    document.dispatchEvent(new CustomEvent('i18n:change', { detail: { lang } }));
  }

  function getLang() {
    return current;
  }

  window.I18N = { t, setLang, getLang, applyStaticTranslations };
})();
