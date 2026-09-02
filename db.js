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
      fetch_details BOOLEAN DEFAULT false,
      status TEXT NOT NULL DEFAULT 'queued',
      post_count INTEGER,
      posts JSONB,
      error TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      finished_at TIMESTAMPTZ
    );
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
  `);
}

module.exports = { pool, initSchema };
