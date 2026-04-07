/**
 * ============================================================
 * CLEAN SWEEP STAKE GAME — CLOUDFLARE WORKER
 * ============================================================
 * Environment Variables to set in Cloudflare Dashboard:
 *   TURNSTILE_SECRET   — your Turnstile secret key
 *   EMAIL_API_KEY      — your MailChannels / SendGrid API key (see notes)
 *   NOTIFY_EMAIL       — marketing@clearchoiceservices.info
 *   WIN_TOLERANCE      — e.g. "0.05"  (seconds either side of 10.00)
 *   SESSION_SECRET     — any long random string (used to sign tokens)
 *
 * KV Namespace to bind (name exactly):  RATE_LIMIT_KV
 * ============================================================
 */

/* ── Constants ── */
const MAX_ATTEMPTS     = 3;
const ATTEMPT_WINDOW   = 86400;        // 24 hours in seconds
const WIN_TARGET       = 10.00;
const SERVER_WIN_RANGE = 0.05;         // ±50ms — tighter than client sees
const SESSION_TTL_MS   = 30_000;       // 30 s — max allowed game session
const ALLOWED_ORIGINS  = [
  'https://www.clearchoiceservices.info',
  'https://clearchoiceservices.info',
];

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ ROUTER ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
export default {
  async fetch(request, env, ctx) {
    const url    = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const ip     = request.headers.get('CF-Connecting-IP') || '0.0.0.0';

    // ── CORS ──
    const corsHeaders = buildCors(origin);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Only accept POST
    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders);
    }

    let body;
    try { body = await request.json(); }
    catch { return jsonResponse({ error: 'Invalid JSON body' }, 400, corsHeaders); }

    try {
      if (url.pathname.endsWith('/start')) return await handleStart(body, ip, env, corsHeaders);
      if (url.pathname.endsWith('/stop'))  return await handleStop(body, ip, env, corsHeaders);
      if (url.pathname.endsWith('/claim')) return await handleClaim(body, ip, env, corsHeaders);
      return jsonResponse({ error: 'Not found' }, 404, corsHeaders);
    } catch (err) {
      console.error('Worker error:', err);
      return jsonResponse({ error: 'Internal server error' }, 500, corsHeaders);
    }
  }
};

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ /start ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   1. Validate Turnstile token
   2. Check rate limit
   3. Issue a signed session (nonce + server timestamp)
   Returns: { sessionId, attemptsUsed }
*/
async function handleStart(body, ip, env, cors) {
  const { turnstileToken } = body;

  if (!turnstileToken) {
    return jsonResponse({ error: 'CAPTCHA token missing. Please verify the CAPTCHA.' }, 400, cors);
  }

  // ── Verify Turnstile ──
  const tsOk = await verifyTurnstile(turnstileToken, ip, env);
  if (!tsOk) {
    return jsonResponse({ error: 'CAPTCHA verification failed. Please re-verify.' }, 403, cors);
  }

  // ── Rate limit ──
  const rlKey = 'rl:' + ip;
  const { allowed, used } = await checkRateLimit(rlKey, env);
  if (!allowed) {
    return jsonResponse({ error: 'Too many attempts. Please try again after 24 hours.', attemptsUsed: used }, 429, cors);
  }

  // ── Issue session ──
  const sessionId = await signSession({ ip, ts: Date.now() }, env);
  return jsonResponse({ sessionId, attemptsUsed: used }, 200, cors);
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ /stop ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   1. Verify session (not expired, not reused, same IP)
   2. Check server-side elapsed time against client time
   3. Determine win/lose using SERVER time (client time is advisory only)
   Returns: { won, winToken?, attemptsUsed, serverTime }
*/
async function handleStop(body, ip, env, cors) {
  const { sessionId, clientTime, turnstileToken } = body;

  if (!sessionId || clientTime === undefined || !turnstileToken) {
    return jsonResponse({ error: 'Missing required fields.' }, 400, cors);
  }

  // ── Re-verify Turnstile (second check) ──
  const tsOk = await verifyTurnstile(turnstileToken, ip, env);
  if (!tsOk) {
    return jsonResponse({ error: 'CAPTCHA re-verification failed.' }, 403, cors);
  }

  // ── Validate session ──
  const session = await verifySession(sessionId, ip, env);
  if (!session) {
    return jsonResponse({ error: 'Invalid or expired session. Please start a new game.' }, 403, cors);
  }

  // ── Burn session (one-use) ──
  await burnSession(sessionId, env);

  // ── Increment rate-limit counter ──
  const rlKey = 'rl:' + ip;
  const used  = await incrementRateLimit(rlKey, env);

  // ── Server-side elapsed time ──
  const serverElapsed = (Date.now() - session.ts) / 1000;

  // ── Anti-tamper: reject if client time diverges more than 500ms from server ──
  const drift = Math.abs(serverElapsed - parseFloat(clientTime));
  if (isNaN(drift) || drift > 0.5) {
    return jsonResponse({
      error        : 'Timing mismatch detected. Submission rejected.',
      attemptsUsed : used
    }, 400, cors);
  }

  // ── Win check using SERVER elapsed ──
  const tolerance = parseFloat(env.WIN_TOLERANCE || '0.05');
  const won       = Math.abs(serverElapsed - WIN_TARGET) <= tolerance;

  if (won) {
    const winToken = await signWinToken({ sessionId, ip, ts: Date.now() }, env);
    return jsonResponse({ won: true, winToken, serverTime: serverElapsed.toFixed(3), attemptsUsed: used }, 200, cors);
  }

  return jsonResponse({ won: false, serverTime: serverElapsed.toFixed(3), attemptsUsed: used }, 200, cors);
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ /claim ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   1. Verify win token
   2. Sanitise inputs
   3. Flag risk level
   4. Send email notification
   Returns: { ok: true }
*/
async function handleClaim(body, ip, env, cors) {
  const { sessionId, winToken, name, email, phone } = body;

  if (!winToken || !name || !email || !phone) {
    return jsonResponse({ error: 'All fields are required.' }, 400, cors);
  }

  // ── Validate win token ──
  const win = await verifyWinToken(winToken, ip, env);
  if (!win) {
    return jsonResponse({ error: 'Invalid win token. This submission cannot be verified.' }, 403, cors);
  }

  // ── Burn win token (one-use) ──
  await burnWinToken(winToken, env);

  // ── Input sanitation ──
  const safeName  = sanitise(name,  80);
  const safeEmail = sanitise(email, 120);
  const safePhone = sanitise(phone, 20);

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(safeEmail)) {
    return jsonResponse({ error: 'Invalid email address.' }, 400, cors);
  }

  // ── Fraud risk scoring ──
  const riskLevel = await assessRisk(ip, env);

  // ── Send email ──
  await sendWinnerEmail({ name: safeName, email: safeEmail, phone: safePhone, ip, riskLevel }, env);

  return jsonResponse({ ok: true }, 200, cors);
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ HELPERS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

/** Verify Cloudflare Turnstile token */
async function verifyTurnstile(token, ip, env) {
  if (!token) return false;
  const form = new FormData();
  form.append('secret',   env.TURNSTILE_SECRET);
  form.append('response', token);
  form.append('remoteip', ip);

  try {
    const res  = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: form
    });
    const data = await res.json();
    return data.success === true;
  } catch {
    return false;
  }
}

/** Rate limiting using KV */
async function checkRateLimit(key, env) {
  const raw  = await env.RATE_LIMIT_KV.get(key, { type: 'json' });
  const data = raw || { count: 0, resetAt: Date.now() + ATTEMPT_WINDOW * 1000 };

  if (Date.now() > data.resetAt) {
    data.count   = 0;
    data.resetAt = Date.now() + ATTEMPT_WINDOW * 1000;
  }

  return { allowed: data.count < MAX_ATTEMPTS, used: data.count };
}

async function incrementRateLimit(key, env) {
  const raw  = await env.RATE_LIMIT_KV.get(key, { type: 'json' });
  const data = raw || { count: 0, resetAt: Date.now() + ATTEMPT_WINDOW * 1000 };

  if (Date.now() > data.resetAt) {
    data.count   = 0;
    data.resetAt = Date.now() + ATTEMPT_WINDOW * 1000;
  }
  data.count++;
  await env.RATE_LIMIT_KV.put(key, JSON.stringify(data), { expirationTtl: ATTEMPT_WINDOW });
  return data.count;
}

/** Fraud risk assessment */
async function assessRisk(ip, env) {
  const rlKey = 'rl:' + ip;
  const raw   = await env.RATE_LIMIT_KV.get(rlKey, { type: 'json' });
  if (!raw) return 'LOW RISK';

  // If they've used all 3 attempts in this 24-hour window and still won → suspicious
  if (raw.count >= MAX_ATTEMPTS) return 'HIGH RISK';
  if (raw.count >= 2)            return 'MEDIUM RISK';
  return 'LOW RISK';
}

/** Sign a session payload using HMAC-SHA256 */
async function signSession(payload, env) {
  const data = JSON.stringify(payload);
  const key  = await importHmacKey(env.SESSION_SECRET);
  const sig  = await crypto.subtle.sign('HMAC', key, enc(data));
  const token = btoa(data) + '.' + bufToHex(sig);
  // Store in KV so it can be burned after use
  await env.RATE_LIMIT_KV.put('sess:' + token, '1', { expirationTtl: 60 });
  return token;
}

async function verifySession(token, ip, env) {
  try {
    const [b64, sigHex] = token.split('.');
    const data    = atob(b64);
    const payload = JSON.parse(data);
    const key     = await importHmacKey(env.SESSION_SECRET);
    const valid   = await crypto.subtle.verify('HMAC', key, hexToBuf(sigHex), enc(data));
    if (!valid) return null;
    if (payload.ip !== ip) return null;                   // IP must match
    if (Date.now() - payload.ts > SESSION_TTL_MS) return null; // max 30s session
    // Check it hasn't been burned
    const alive = await env.RATE_LIMIT_KV.get('sess:' + token);
    if (!alive) return null;
    return payload;
  } catch {
    return null;
  }
}

async function burnSession(token, env) {
  await env.RATE_LIMIT_KV.delete('sess:' + token);
}

/** Sign / verify a win token (similar pattern) */
async function signWinToken(payload, env) {
  const data = JSON.stringify(payload);
  const key  = await importHmacKey(env.SESSION_SECRET + '_win');
  const sig  = await crypto.subtle.sign('HMAC', key, enc(data));
  const token = btoa(data) + '.' + bufToHex(sig);
  await env.RATE_LIMIT_KV.put('win:' + token, '1', { expirationTtl: 600 }); // 10 min to claim
  return token;
}

async function verifyWinToken(token, ip, env) {
  try {
    const [b64, sigHex] = token.split('.');
    const data    = atob(b64);
    const payload = JSON.parse(data);
    const key     = await importHmacKey(env.SESSION_SECRET + '_win');
    const valid   = await crypto.subtle.verify('HMAC', key, hexToBuf(sigHex), enc(data));
    if (!valid) return null;
    if (payload.ip !== ip) return null;
    const alive = await env.RATE_LIMIT_KV.get('win:' + token);
    if (!alive) return null;
    return payload;
  } catch {
    return null;
  }
}

async function burnWinToken(token, env) {
  await env.RATE_LIMIT_KV.delete('win:' + token);
}

/** Send winner notification email via MailChannels (free on Workers) */
async function sendWinnerEmail({ name, email, phone, ip, riskLevel }, env) {
  const timestamp = new Date().toUTCString();
  const subject   = `[${riskLevel}] New Winner — Clean Sweep Game`;
  const text = `
🏆 NEW WINNER — CLEAN SWEEP STAKE GAME
========================================
Risk Level  : ${riskLevel}
Timestamp   : ${timestamp}
IP Address  : ${ip}

Winner Details:
  Name      : ${name}
  Email     : ${email}
  Phone     : ${phone}

Verification: Cloudflare Turnstile + Server-Side Timer
========================================
  `.trim();

  // MailChannels — available free on Cloudflare Workers
  // If you prefer SendGrid, swap this block (see instructions file)
  const payload = {
    personalizations: [{
      to: [{ email: env.NOTIFY_EMAIL }]
    }],
    from    : { email: 'noreply@clearchoiceservices.info', name: 'Clean Sweep Game' },
    subject : subject,
    content : [{ type: 'text/plain', value: text }]
  };

  await fetch('https://api.mailchannels.net/tx/v1/send', {
    method : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body   : JSON.stringify(payload)
  });
}

/* ── Crypto utilities ── */
function enc(str) { return new TextEncoder().encode(str); }
function bufToHex(buf) {
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
}
function hexToBuf(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes.buffer;
}
async function importHmacKey(secret) {
  return crypto.subtle.importKey(
    'raw', enc(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign', 'verify']
  );
}

function sanitise(str, max) {
  return String(str).replace(/[<>"'&]/g, '').slice(0, max).trim();
}

function buildCors(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin' : allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type'                 : 'application/json',
  };
}

function jsonResponse(body, status, headers) {
  return new Response(JSON.stringify(body), { status, headers });
}
