const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  throw new Error('SESSION_SECRET env variable е задължителна.');
}

const COOKIE_NAME = 'session';
const TOKEN_TTL = '30d';

function hashPassword(password) {
  return bcrypt.hash(password, 10);
}

function verifyPassword(password, hash) {
  if (!hash) return Promise.resolve(false);
  return bcrypt.compare(password, hash);
}

function signSession(user) {
  return jwt.sign({ uid: user.id, email: user.email }, SESSION_SECRET, { expiresIn: TOKEN_TTL });
}

function verifySession(token) {
  try {
    return jwt.verify(token, SESSION_SECRET);
  } catch (e) {
    return null;
  }
}

function setSessionCookie(res, user) {
  const token = signSession(user);
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME);
}

/** Express middleware: attaches req.user (or null) без да блокира заявката. */
function attachUser(req, res, next) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  const payload = token ? verifySession(token) : null;
  req.user = payload ? { id: payload.uid, email: payload.email } : null;
  next();
}

/** Express middleware: изисква логнат потребител, иначе 401. */
function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Изисква се логин.' });
  next();
}

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// --- Google OAuth 2.0 (authorization code flow, без passport) ---

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || '';
const GOOGLE_ENABLED = Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_REDIRECT_URI);

function buildGoogleAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function exchangeGoogleCode(code) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: GOOGLE_REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) throw new Error(`Google token exchange failed: ${res.status} ${await res.text()}`);
  const data = await res.json();

  const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${data.access_token}` },
  });
  if (!userInfoRes.ok) throw new Error('Неуспешно извличане на Google профил.');
  return userInfoRes.json(); // { sub, email, name, picture, ... }
}

function randomState() {
  return crypto.randomBytes(16).toString('hex');
}

module.exports = {
  hashPassword,
  verifyPassword,
  setSessionCookie,
  clearSessionCookie,
  attachUser,
  requireAuth,
  isValidEmail,
  GOOGLE_ENABLED,
  buildGoogleAuthUrl,
  exchangeGoogleCode,
  randomState,
};
