const { Pool } = require('pg');

const dbUrl = process.env.DATABASE_URL || '';
const isLocalDb = /railway\.internal|localhost|127\.0\.0\.1/.test(dbUrl);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocalDb ? false : { rejectUnauthorized: false },
});

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT,
      google_id TEXT UNIQUE,
      display_name TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      subreddit TEXT NOT NULL,
      sort TEXT NOT NULL,
      time_filter TEXT,
      post_limit INTEGER,
      comment_mode TEXT NOT NULL DEFAULT 'none',
      status TEXT NOT NULL DEFAULT 'queued',
      post_count INTEGER,
      posts JSONB,
      error TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      finished_at TIMESTAMPTZ
    );
    ALTER TABLE jobs ADD COLUMN IF NOT EXISTS comment_mode TEXT NOT NULL DEFAULT 'none';
    ALTER TABLE jobs DROP COLUMN IF EXISTS fetch_details;
    CREATE INDEX IF NOT EXISTS idx_jobs_user ON jobs(user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS qa (
      id SERIAL PRIMARY KEY,
      job_id TEXT REFERENCES jobs(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_qa_job ON qa(job_id, created_at ASC);

    -- Споделен кеш на скрейпнати сабредити за Topic Digest: не е обвързан с
    -- конкретен потребител, за да могат различни хора да преизползват вече
    -- скрейпнати данни за същия сабредит вместо да се скрейпва повторно.
    CREATE TABLE IF NOT EXISTS subreddit_cache (
      id SERIAL PRIMARY KEY,
      subreddit TEXT NOT NULL,
      sort TEXT NOT NULL DEFAULT 'top',
      time_filter TEXT NOT NULL DEFAULT 'all',
      comment_mode TEXT NOT NULL DEFAULT 'top50',
      status TEXT NOT NULL DEFAULT 'queued',
      posts JSONB,
      post_count INTEGER,
      error TEXT,
      scraped_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_subreddit_cache_key
      ON subreddit_cache(subreddit, sort, time_filter, comment_mode);

    -- Topic Digest "чатове": лична история на потребителя (като claude.ai),
    -- всеки topic е обвързан с 1-3 сабредита от кеша по-горе.
    CREATE TABLE IF NOT EXISTS topics (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      subreddits TEXT[] NOT NULL,
      use_own_knowledge BOOLEAN NOT NULL DEFAULT false,
      post_count INTEGER NOT NULL DEFAULT 25,
      status TEXT NOT NULL DEFAULT 'queued',
      error TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );
    ALTER TABLE topics ADD COLUMN IF NOT EXISTS use_own_knowledge BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE topics ADD COLUMN IF NOT EXISTS post_count INTEGER NOT NULL DEFAULT 25;
    CREATE INDEX IF NOT EXISTS idx_topics_user ON topics(user_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS topic_messages (
      id SERIAL PRIMARY KEY,
      topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_topic_messages_topic ON topic_messages(topic_id, created_at ASC);
  `);
}

module.exports = { pool, initSchema };
