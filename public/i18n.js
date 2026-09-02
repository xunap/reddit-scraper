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
      history_title: 'History',
      history_empty: 'No scraped jobs yet.',
      form_title: 'Scrape a subreddit',
      field_subreddit: 'Subreddit',
      field_sort: 'Sort',
      field_period: 'Time period',
      opt_all_time: 'All time',
      opt_year: 'Year',
      opt_month: 'Month',
      opt_week: 'Week',
      opt_day: 'Day',
      opt_hour: 'Hour',
      field_limit: 'Number of posts (max. {max} for this mode)',
      field_comment_mode: 'Comments to include',
      opt_comments_none: 'None (fastest, list only)',
      opt_comments_body: 'Title + post text only',
      opt_comments_top3: 'Title + post text + top 3 comments',
      opt_comments_top10: 'Title + post text + top 10 comments',
      opt_comments_top25: 'Title + post text + top 25 comments',
      opt_comments_top50: 'Title + post text + top 50 comments',
      opt_comments_top100: 'Title + post text + top 100 comments',
      opt_comments_all: 'Title + post text + all comments',
      btn_start_scrape: 'Start scraping',
      btn_start_scrape_loading: 'Starting...',
      status_title_default: 'Scraping...',
      status_title_running: 'Scraping r/{sub}',
      th_title: 'Title',
      th_author: 'Author',
      th_votes: 'Votes',
      th_comments: 'Comments',
      th_date: 'Date',
      results_title: 'Results',
      btn_download_json: 'Download JSON',
      btn_download_csv: 'Download CSV',
      stats_posts: 'Posts:',
      stats_avg_votes: 'Avg. votes:',
      stats_range: 'Range:',
      qa_title: 'Ask about the data',
      qa_placeholder: 'E.g.: What are the three most common complaints in the comments?',
      qa_hint_with_details: 'Ask freely about the posts and comments from this job (r/{sub}).',
      qa_hint_no_details: 'This job has no full text/comments — answers will be based only on titles, authors and stats. For richer answers, run a new scrape with "Full text + comments" checked.',
      btn_ask: 'Ask',
      qa_own_knowledge_main: 'Also let the model add its own knowledge',
      qa_own_knowledge_sub: '(e.g. general medical knowledge — off by default, answers only from Reddit)',
      qa_thinking: 'Thinking...',
      btn_logout: 'Log out',
      err_login_default: 'Login failed.',
      err_signup_default: 'Signup failed.',
      err_load_results: 'Failed to load results: ',
      err_start_failed: 'Failed to start.',
      err_job_not_found: 'Job not found.',
      queue_position: 'Waiting in queue (position {pos})',
      err_status_check: 'Error checking status: ',
      err_generic_load: 'Failed to load.',
      err_ask: 'Failed to get an answer.',
      err_connect: 'Could not connect to the server. Reload the page.',
      history_posts_count: '{count} posts',
      status_queued: 'queued',
      status_running: 'running',
      status_done: 'done',
      status_error: 'error',
      phase_queued: 'queued',
      phase_listing: 'loading list',
      'phase_listing-done': 'list ready',
      phase_details: 'loading details',
      phase_done: 'done',
      phase_debug: 'debug',
      err_prefix: 'Error: ',
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
      history_title: 'История',
      history_empty: 'Все още няма скрейпнати задачи.',
      form_title: 'Скрейпни сабредит',
      field_subreddit: 'Сабредит',
      field_sort: 'Сортиране',
      field_period: 'Период',
      opt_all_time: 'За всички времена',
      opt_year: 'Година',
      opt_month: 'Месец',
      opt_week: 'Седмица',
      opt_day: 'Ден',
      opt_hour: 'Час',
      field_limit: 'Брой постове (макс. {max} за този режим)',
      field_comment_mode: 'Коментари за включване',
      opt_comments_none: 'Без (най-бързо, само списък)',
      opt_comments_body: 'Заглавие + текст на поста',
      opt_comments_top3: 'Заглавие + текст + топ 3 коментара',
      opt_comments_top10: 'Заглавие + текст + топ 10 коментара',
      opt_comments_top25: 'Заглавие + текст + топ 25 коментара',
      opt_comments_top50: 'Заглавие + текст + топ 50 коментара',
      opt_comments_top100: 'Заглавие + текст + топ 100 коментара',
      opt_comments_all: 'Заглавие + текст + всички коментари',
      btn_start_scrape: 'Стартирай скрейпване',
      btn_start_scrape_loading: 'Стартиране...',
      status_title_default: 'Скрейпване...',
      status_title_running: 'Скрейпване на r/{sub}',
      th_title: 'Заглавие',
      th_author: 'Автор',
      th_votes: 'Гласове',
      th_comments: 'Коментари',
      th_date: 'Дата',
      results_title: 'Резултати',
      btn_download_json: 'Изтегли JSON',
      btn_download_csv: 'Изтегли CSV',
      stats_posts: 'Постове:',
      stats_avg_votes: 'Ср. гласове:',
      stats_range: 'Диапазон:',
      qa_title: 'Питай по данните',
      qa_placeholder: 'Напр: Кои са трите най-чести оплаквания в коментарите?',
      qa_hint_with_details: 'Питай свободно за постовете и коментарите от тази задача (r/{sub}).',
      qa_hint_no_details: 'Тази задача е без пълен текст/коментари — отговорите ще се базират само на заглавия, автори и статистики. За по-богати отговори пусни нов скрейп с отметнато "Пълен текст + коментари".',
      btn_ask: 'Попитай',
      qa_own_knowledge_main: 'Позволи на модела да добавя и собствени знания',
      qa_own_knowledge_sub: '(напр. общи медицински знания — по подразбиране е изключено, отговорите са само от Reddit)',
      qa_thinking: 'Мисля...',
      btn_logout: 'Изход',
      err_login_default: 'Грешка при вход.',
      err_signup_default: 'Грешка при регистрация.',
      err_load_results: 'Неуспешно зареждане на резултатите: ',
      err_start_failed: 'Неуспешно стартиране.',
      err_job_not_found: 'Job не е намерен.',
      queue_position: 'Чака се ред в опашката (позиция {pos})',
      err_status_check: 'Грешка при проверка на статус: ',
      err_generic_load: 'Грешка при зареждане.',
      err_ask: 'Грешка при въпроса.',
      err_connect: 'Неуспешна връзка със сървъра. Презареди страницата.',
      history_posts_count: '{count} поста',
      status_queued: 'queued',
      status_running: 'running',
      status_done: 'done',
      status_error: 'error',
      phase_queued: 'на опашка',
      phase_listing: 'зареждане на списъка',
      'phase_listing-done': 'списъкът е готов',
      phase_details: 'зареждане на детайли',
      phase_done: 'готово',
      phase_debug: 'debug',
      err_prefix: 'Грешка: ',
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
