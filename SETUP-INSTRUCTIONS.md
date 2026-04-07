# Clean Sweep Stake Game — Complete Setup Guide

---

## Files You Have

| File | Purpose |
|------|---------|
| `game-frontend.html` | Paste into Squarespace Code Block |
| `cloudflare-worker.js` | Deploy as a Cloudflare Worker |

---

## STEP 1 — Cloudflare Turnstile Setup

1. Log in to **dash.cloudflare.com**
2. In the left sidebar → **Turnstile**
3. Click **Add a site**
4. Widget type: **Managed** (visible checkbox)
5. Enter your domain: `clearchoiceservices.info`
6. Click **Create**
7. Copy two values:
   - **Site Key** — goes in the HTML file
   - **Secret Key** — goes in the Worker environment variables

---

## STEP 2 — Create KV Namespace

1. In Cloudflare Dashboard → **Workers & Pages** → **KV**
2. Click **Create Namespace**
3. Name it exactly: `RATE_LIMIT_KV`
4. Click **Add**

---

## STEP 3 — Deploy the Cloudflare Worker

### Option A: Cloudflare Dashboard (no CLI needed)

1. Go to **Workers & Pages** → **Create Application** → **Create Worker**
2. Name it: `clean-sweep-game`
3. Click **Deploy**, then click **Edit code**
4. Delete all existing code and paste the entire contents of `cloudflare-worker.js`
5. Click **Save and Deploy**

### Option B: Wrangler CLI (advanced)

```bash
npm install -g wrangler
wrangler login
wrangler deploy cloudflare-worker.js --name clean-sweep-game
```

---

## STEP 4 — Set Environment Variables in the Worker

In the Worker settings → **Settings** → **Variables and Secrets**:

| Variable Name | Value | Type |
|---|---|---|
| `TURNSTILE_SECRET` | Your Turnstile **Secret Key** | Secret |
| `SESSION_SECRET` | Any long random string (e.g. 40+ chars) | Secret |
| `NOTIFY_EMAIL` | `marketing@clearchoiceservices.info` | Text |
| `WIN_TOLERANCE` | `0.05` | Text |

To generate a good SESSION_SECRET, run this in any browser console:
```javascript
Array.from(crypto.getRandomValues(new Uint8Array(32))).map(b=>b.toString(16).padStart(2,'0')).join('')
```

---

## STEP 5 — Bind KV to the Worker

1. Worker settings → **Settings** → **Bindings**
2. Click **Add** → **KV Namespace**
3. Variable name: `RATE_LIMIT_KV`
4. KV namespace: select `RATE_LIMIT_KV` you created in Step 2
5. Save

---

## STEP 6 — Edit the Front-End HTML File

Open `game-frontend.html` and find these two lines:

```html
data-sitekey="YOUR_TURNSTILE_SITE_KEY"
```
→ Replace `YOUR_TURNSTILE_SITE_KEY` with your Turnstile **Site Key**

```javascript
var _W = 'YOUR_WORKER_URL';
```
→ Replace with your Worker URL, e.g.:
`https://clean-sweep-game.YOURSUBDOMAIN.workers.dev`

Also update your logo URL:
```html
src="https://images.squarespace-cdn.com/content/v1/YOURSITE/logo.png"
```
→ Replace with your actual logo URL from Squarespace

---

## STEP 7 — Add to Squarespace

1. Edit your Squarespace page
2. Add a **Code Block** (+ → Code)
3. Make sure it is set to **HTML** mode (not Markdown)
4. Paste the entire contents of `game-frontend.html`
5. Save and publish
6. **Important:** Also go to **Settings → Advanced → Code Injection → Header** and verify the Turnstile script is not already loaded there — if it is, remove the `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js">` line from the HTML file to avoid loading it twice

---

## STEP 8 — Enable MailChannels (Email Sending)

MailChannels is free for Cloudflare Workers but requires domain verification:

1. Add a DNS TXT record to your domain:
   - Type: `TXT`
   - Name: `_mailchannels`
   - Value: `v=mc1 cfid=clearchoiceservices.info`
2. Wait 5–10 minutes for DNS propagation
3. Test by playing the game and winning

**Alternative: SendGrid**
If you prefer SendGrid, in the Worker replace the `sendWinnerEmail` function's fetch call with:
```javascript
await fetch('https://api.sendgrid.com/v3/mail/send', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer ' + env.EMAIL_API_KEY,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify(payload)  // same payload structure
});
```
And add `EMAIL_API_KEY` as a secret variable in the Worker.

---

## STEP 9 — CORS Configuration

In `cloudflare-worker.js`, line 12–15, update `ALLOWED_ORIGINS` to match your exact domain:

```javascript
const ALLOWED_ORIGINS = [
  'https://www.clearchoiceservices.info',
  'https://clearchoiceservices.info',
];
```

---

## STEP 10 — Testing

### Test Turnstile fix specifically:
1. Open your page
2. Open browser DevTools → Network tab
3. Complete the CAPTCHA widget
4. The Turnstile callback `csgOnTurnstileSuccess` fires and sets the token
5. The Start button becomes enabled
6. Click Start — network request to `/start` should show `200 OK`
7. If you see 403 with "CAPTCHA verification failed" → your **Secret Key** or **Site Key** mismatch

### Test winning:
- The tolerance is `±0.05 seconds` around 10.00
- Stop between `9.95` and `10.05` to win
- A winner pop-up will appear asking for contact details

### Test rate limiting:
- After 3 attempts in 24 hours, the `/start` endpoint returns 429
- The UI shows "Too many attempts"

### Test fraud detection:
- A user who wins on their 3rd attempt (after 2 prior attempts in the same 24h window) is flagged HIGH RISK in the email

---

## Turnstile Issue — Root Cause Explained

The original issue ("Turnstile shows verified but submission fails") happens because:

1. The Turnstile widget fires a JavaScript callback when verified
2. If the token is read **before** that callback fires (e.g. on page load), it is `null`
3. The Worker then rejects the submission with a missing-token error

**How this solution fixes it:**
- The token is stored in `_tsToken` variable **only** when `csgOnTurnstileSuccess` fires
- The Start button is disabled until that callback fires
- Both `/start` AND `/stop` submit the token and verify it server-side
- Turnstile is reset after each game so the user must re-verify for the next attempt

---

## Security Summary

| Protection | Implementation |
|---|---|
| CAPTCHA required | Turnstile verified server-side on both /start and /stop |
| Timer cannot be faked | Server measures elapsed time, client time is cross-checked |
| Sessions are one-use | Burned in KV after /stop is called |
| Win tokens are one-use | Burned in KV after /claim is called |
| IP binding | Sessions and win tokens are bound to the originating IP |
| Rate limiting | 3 attempts per IP per 24 hours, enforced in KV |
| Input sanitisation | All claim inputs stripped of HTML/script characters |
| CORS locked | Only your production domain can call the Worker |
