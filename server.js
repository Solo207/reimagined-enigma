// npm install cookie-parser  ← run once if not already installed
const express      = require('express');
const cookieParser = require('cookie-parser');
const { randomUUID: uuidv4 } = require('crypto');
const fs   = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

// ── Config ────────────────────────────────────────────────────────────────────
const STORE_FILE  = path.join(__dirname, 'bookmarks-quizzes.json');
const TTL_MS = 24 * 60 * 60 * 1000;
const WEBHOOK_URL = 'https://sb-n8n.rhat7s.easypanel.host/webhook/webbook';
// Fired once, from the results screen, when the student deletes their saved
// bookmark session entirely.
const DELETE_WEBHOOK_URL = 'https://sb-n8n.rhat7s.easypanel.host/webhook/payUrDues';

// ── Atomic write queue ────────────────────────────────────────────────────────
let storeWriteQueue = Promise.resolve();
function loadStore() {
  try { if (fs.existsSync(STORE_FILE)) return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')); }
  catch (e) { console.error('loadStore error:', e); }
  return {};
}
function saveStore(store) {
  storeWriteQueue = storeWriteQueue.then(() => {
    const tmp = STORE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store), 'utf8');
    fs.renameSync(tmp, STORE_FILE);
  }).catch(err => console.error('saveStore error:', err));
}
function cleanup(store) {
  const now = Date.now(); let changed = false;
  for (const id in store) { if (now > store[id].expiresAt) { delete store[id]; changed = true; } }
  if (changed) saveStore(store);
  return store;
}

// ── Periodic cleanup every 30 min ─────────────────────────────────────────────
setInterval(() => {
  const store = loadStore();
  const before = Object.keys(store).length;
  cleanup(store);
  const after = Object.keys(store).length;
  if (before !== after) console.log(`Periodic cleanup: removed ${before - after} expired quiz(zes)`);
}, 30 * 60 * 1000);

function setSessionCookie(res, quizId, token) {
  res.cookie('qsess_' + quizId, token, { maxAge: TTL_MS, httpOnly: false, sameSite: 'lax' });
}

// ── Helper: format a duration in minutes as H:MM:SS / MM:SS ───────────────────
function formatDurationHMS(minutes) {
  if (!minutes || minutes <= 0) return null;
  const totalSec = Math.round(minutes * 60);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = n => String(n).padStart(2, '0');
  return h > 0 ? (h + ':' + pad(m) + ':' + pad(s)) : (pad(m) + ':' + pad(s));
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.post('/create-quiz', (req, res) => {
  const { title, question, wa_id, time } = req.body;
  if (!title || !question) return res.status(400).json({ error: 'Missing title or question fields' });
  let questions;
  try { questions = typeof question === 'string' ? JSON.parse(question) : question; }
  catch (e) { return res.status(400).json({ error: 'Invalid questions JSON' }); }

  // `time` is in minutes. 0 / missing / invalid = no timer — the review stays
  // fully interactive (marking, disagree, bookmark toggle) the way it already was.
  let timeMinutes = 0;
  if (time !== undefined && time !== null && time !== '') {
    const t = Number(time);
    if (!Number.isNaN(t) && t > 0) timeMinutes = t;
  }

  const id    = uuidv4();
  const store = cleanup(loadStore());
  store[id] = {
    title, questions, wa_id: wa_id || null,
    timeMinutes,            // 0 = untimed
    examEndsAt: null,       // set once the student opens the link
    submitted: false,
    submittedAt: null,
    reviewed: false,        // true once the one-time post-submit Review has been submitted
    finalResults: null,
    finalBookmarks: null,
    finalCorrections: null,
    createdAt: Date.now(),
    expiresAt: Date.now() + TTL_MS,
    claimed: false
  };
  saveStore(store);
  const host     = req.headers['x-forwarded-host'] || req.headers.host;
  const protocol = req.headers['x-forwarded-proto'] || 'http';
  res.json({
    link: `${protocol}://${host}/quiz/${id}`,
    id,
    expiresIn: (TTL_MS / (60 * 60 * 1000)) + ' hours',
    timeMinutes,
    duration: formatDurationHMS(timeMinutes)
  });
});

app.get('/quiz/:id', (req, res) => {
  const store = cleanup(loadStore());
  const quiz  = store[req.params.id];
  if (!quiz) return res.status(404).send(expiredPage());
  const cookieName    = 'qsess_' + req.params.id;
  const sessionCookie = req.cookies?.[cookieName];
  if (!quiz.claimed) {
    const token = uuidv4();
    store[req.params.id].claimed = true;
    store[req.params.id].sessionToken = token;
    store[req.params.id].examEndsAt = quiz.timeMinutes > 0 ? Date.now() + quiz.timeMinutes * 60000 : null;
    saveStore(store); setSessionCookie(res, req.params.id, token);
    return res.send(quizPage(req.params.id, store[req.params.id]));
  }
  if (sessionCookie === quiz.sessionToken) return res.send(quizPage(req.params.id, quiz));
  return res.status(403).send(claimedPage(req.params.id));
});

app.post('/quiz/:id/recover', (req, res) => {
  const store = loadStore(), quiz = store[req.params.id];
  if (!quiz) return res.status(404).json({ ok: false });
  const { token } = req.body;
  if (!token || token !== quiz.sessionToken) return res.status(403).json({ ok: false, error: 'Invalid token' });
  setSessionCookie(res, req.params.id, quiz.sessionToken);
  res.json({ ok: true });
});

app.post('/submit/:id', async (req, res) => {
  const store = loadStore(), quiz = store[req.params.id];
  if (!quiz) return res.status(404).json({ ok: false, error: 'Quiz not found' });
  const cookieName = 'qsess_' + req.params.id;
  if (req.cookies?.[cookieName] !== quiz.sessionToken) return res.status(403).json({ ok: false, error: 'Unauthorized' });
  const payload = { ...req.body, wa_id: quiz.wa_id };

  // Persist final state server-side; the record is kept (not deleted) so a
  // refresh shows Review/results instead of "Session Expired". If this quiz
  // was already submitted once, this call is the one-time Review completing.
  const wasAlreadySubmitted = !!quiz.submitted;
  quiz.submitted   = true;
  quiz.submittedAt = Date.now();
  if (wasAlreadySubmitted) quiz.reviewed = true;
  quiz.finalResults   = Array.isArray(req.body.full_results) ? req.body.full_results : null;
  quiz.finalBookmarks = Array.isArray(req.body.remaining_bookmarks) ? req.body.remaining_bookmarks.map(b => b.number) : null;
  quiz.finalCorrections = Array.isArray(req.body.corrections)
    ? req.body.corrections.reduce((acc, c) => { acc[c.question_number] = c; return acc; }, {})
    : {};
  store[req.params.id] = quiz;
  saveStore(store);

  try {
    const r = await fetch(WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    res.json({ ok: r.ok });
  } catch (e) { console.error('Webhook error:', e); res.status(502).json({ ok: false, error: 'Webhook unreachable' }); }
});

// Deletes the ENTIRE saved bookmark session. Only fires the "delete" webhook
// (never the regular submit one), and only removes the record once that
// webhook call succeeds — so the link only goes dead after confirmation.
app.post('/quiz/:id/delete-bookmark', async (req, res) => {
  const store = loadStore(), quiz = store[req.params.id];
  if (!quiz) return res.status(404).json({ ok: false, error: 'Quiz not found' });
  const cookieName = 'qsess_' + req.params.id;
  if (req.cookies?.[cookieName] !== quiz.sessionToken) return res.status(403).json({ ok: false, error: 'Unauthorized' });

  // Built entirely from the stored record — wa_id never has to be trusted from the client.
  const payload = { title: quiz.title, wa_id: quiz.wa_id };
  try {
    const r = await fetch(DELETE_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!r.ok) return res.status(502).json({ ok: false, error: 'Webhook unreachable' });
    delete store[req.params.id];
    saveStore(store);
    res.json({ ok: true });
  } catch (e) {
    console.error('Delete-bookmark webhook error:', e);
    res.status(502).json({ ok: false, error: 'Webhook unreachable' });
  }
});

app.delete('/quiz/:id', (req, res) => {
  const store = loadStore(), quiz = store[req.params.id];
  if (!quiz) return res.json({ ok: true });
  const cookieName = 'qsess_' + req.params.id;
  if (req.cookies?.[cookieName] !== quiz.sessionToken) return res.status(403).json({ ok: false, error: 'Unauthorized' });
  delete store[req.params.id]; saveStore(store); res.json({ ok: true });
});

app.get('/', (req, res) => res.json({ status: 'ok', service: 'Bookmark Quiz App' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bookmark quiz app running on port ${PORT}`));

// ── Static pages ──────────────────────────────────────────────────────────────
function expiredPage() {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Session Expired</title>
  <link href="https://fonts.googleapis.com/css2?family=Sora:wght@400;600&display=swap" rel="stylesheet"/>
  <style>body{background:#090b18;color:#fff;font-family:'Sora',sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}
  .box{text-align:center;}h1{font-size:2.5rem;color:#ef4444;margin-bottom:12px;}p{color:#64748b;}</style>
  </head><body><div class="box"><h1>⏳ Session Expired</h1><p>This review session has expired or has already been submitted.</p></div></body></html>`;
}

function claimedPage(quizId) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Reconnecting…</title>
  <link href="https://fonts.googleapis.com/css2?family=Sora:wght@400;600&display=swap" rel="stylesheet"/>
  <style>
    body{background:#090b18;color:#fff;font-family:'Sora',sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;padding:24px;}
    .box{text-align:center;max-width:400px;}h1{font-size:2rem;margin-bottom:12px;}p{color:#64748b;line-height:1.6;font-size:.9rem;}
    .spinner{width:36px;height:36px;border:3px solid #1e2d45;border-top-color:#f59e0b;border-radius:50%;animation:spin .8s linear infinite;margin:20px auto;}
    @keyframes spin{to{transform:rotate(360deg);}}.error{color:#ef4444;}
  </style></head><body>
  <div class="box">
    <div id="checking"><h1 style="color:#f59e0b">🔖 Reconnecting…</h1><p>Verifying your session…</p><div class="spinner"></div></div>
    <div id="error" style="display:none"><h1 class="error">Session Unavailable</h1><p>This review session is already open in another session.</p></div>
  </div>
  <script>
    (function(){
      var tok=localStorage.getItem('qt_${quizId}');
      if(!tok){showError();return;}
      fetch('/quiz/${quizId}/recover',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({token:tok})})
      .then(function(r){if(r.ok){location.href='/quiz/${quizId}';}else{showError();}}).catch(showError);
      function showError(){document.getElementById('checking').style.display='none';document.getElementById('error').style.display='block';}
    })();
  </script></body></html>`;
}

// ── Quiz page ─────────────────────────────────────────────────────────────────
function quizPage(id, quiz) {
  const questionsJson = JSON.stringify(quiz.questions);
  const titleJson     = JSON.stringify(quiz.title);
  const tokenJson     = JSON.stringify(quiz.sessionToken);
  const examEndsAtJs         = quiz.examEndsAt ? String(quiz.examEndsAt) : 'null';
  const submittedJs          = quiz.submitted ? 'true' : 'false';
  const reviewedJs           = quiz.reviewed ? 'true' : 'false';
  const finalResultsJson     = JSON.stringify(quiz.finalResults || []);
  const finalBookmarksJson   = JSON.stringify(quiz.finalBookmarks || []);
  const finalCorrectionsJson = JSON.stringify(quiz.finalCorrections || {});
  const FAVICON = `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='7' fill='%23090b18'/><path d='M8 4h16v24l-8-5-8 5z' fill='none' stroke='%23f59e0b' stroke-width='2' stroke-linejoin='round'/></svg>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Bookmarks — ${quiz.title}</title>
  <link rel="icon" type="image/svg+xml" href="${FAVICON}"/>
  <link href="https://fonts.googleapis.com/css2?family=Sora:wght@300;400;600;700&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet"/>
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
    :root{
      --bg:#090b18;--surface:#0d1626;--surface2:#121d30;--border:#1e2d45;
      --accent:#3b82f6;--accent2:#60a5fa;--correct:#22c55e;--wrong:#ef4444;
      --bookmark:#f59e0b;--text:#e2e8f0;--muted:#64748b;
      --mono:'JetBrains Mono',monospace;
    }
    body{background:var(--bg);color:var(--text);font-family:'Sora',sans-serif;min-height:100vh;overflow-x:hidden;}
    #bgCanvas{position:fixed;inset:0;z-index:0;pointer-events:none;}
    .bg-grid{position:fixed;inset:0;z-index:0;pointer-events:none;
      background-image:linear-gradient(rgba(245,158,11,.04) 1px,transparent 1px),linear-gradient(90deg,rgba(245,158,11,.04) 1px,transparent 1px);
      background-size:44px 44px;animation:gridPulse 5s ease-in-out infinite;}
    @keyframes gridPulse{0%,100%{opacity:.45;}50%{opacity:1;}}
    .bg-orb{position:fixed;border-radius:50%;pointer-events:none;z-index:0;filter:blur(80px);}
    .bg-orb-1{width:560px;height:560px;top:-160px;right:-120px;background:radial-gradient(circle,rgba(245,158,11,.15) 0%,transparent 70%);animation:orbFloat 9s ease-in-out infinite;}
    .bg-orb-2{width:440px;height:440px;bottom:5%;left:-120px;background:radial-gradient(circle,rgba(20,184,166,.14) 0%,transparent 70%);animation:orbFloat 11s ease-in-out infinite reverse;}
    .bg-orb-3{width:340px;height:340px;bottom:-60px;right:8%;background:radial-gradient(circle,rgba(99,102,241,.14) 0%,transparent 70%);animation:orbFloat 14s ease-in-out infinite 2s;}
    .bg-orb-4{width:380px;height:380px;top:-80px;left:-100px;background:radial-gradient(circle,rgba(168,85,247,.14) 0%,transparent 70%);animation:orbFloat 12s ease-in-out infinite 4s;}
    @keyframes orbFloat{0%,100%{transform:translateY(0) scale(1);}50%{transform:translateY(-32px) scale(1.05);}}

    .container{max-width:680px;margin:0 auto;padding:24px 16px 200px;position:relative;z-index:1;}

    /* ── Header ── */
    .header{display:flex;align-items:flex-start;justify-content:space-between;
      margin-bottom:28px;padding-bottom:16px;border-bottom:1px solid var(--border);flex-wrap:wrap;gap:10px;}
    .header-left{display:flex;flex-direction:column;gap:4px;}
    .bookmarks-super-label{font-family:var(--mono);font-size:.95rem;font-weight:600;
      color:var(--bookmark);letter-spacing:.15em;text-transform:uppercase;
      display:flex;align-items:center;gap:6px;}
    .bookmarks-super-label::before{content:'🔖';}
    .quiz-subtitle{font-family:var(--mono);font-size:.72rem;color:var(--muted);letter-spacing:.1em;text-transform:uppercase;}
    .header-right{display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:flex-end;}
    .exam-timer{display:none;align-items:center;gap:6px;font-family:var(--mono);font-size:.78rem;color:var(--accent2);
      background:var(--surface2);border:1px solid var(--border);padding:6px 12px;border-radius:20px;white-space:nowrap;}
    .exam-timer.show{display:flex;}
    .exam-timer.low{color:var(--wrong);border-color:var(--wrong);animation:pulseTimer 1s infinite;}
    @keyframes pulseTimer{0%,100%{opacity:1;}50%{opacity:.5;}}
    .bm-controls{display:flex;gap:8px;align-items:center;}
    .bm-icon-btn{background:none;border:1px solid var(--border);color:var(--muted);width:38px;height:38px;
      border-radius:10px;font-size:1rem;cursor:pointer;transition:all .2s;display:flex;align-items:center;justify-content:center;}
    .bm-icon-btn:hover{border-color:var(--bookmark);color:var(--bookmark);}
    .bm-icon-btn.active{border-color:var(--bookmark);color:var(--bookmark);background:rgba(245,158,11,.1);}
    .bm-list-btn{background:none;border:1px solid var(--border);color:var(--muted);padding:6px 14px;
      border-radius:20px;font-family:'Sora',sans-serif;font-size:.78rem;cursor:pointer;transition:all .2s;
      display:flex;align-items:center;gap:6px;}
    .bm-list-btn:hover{border-color:var(--bookmark);color:var(--bookmark);}
    .bm-list-btn.has-items{border-color:rgba(245,158,11,.4);color:var(--bookmark);}

    /* ── Progress ── */
    .progress-wrap{margin-bottom:28px;}
    .progress-label{display:flex;justify-content:space-between;font-size:.75rem;color:var(--muted);font-family:var(--mono);margin-bottom:8px;}
    .progress-bar{height:3px;background:var(--border);border-radius:2px;overflow:hidden;}
    .progress-fill{height:100%;background:linear-gradient(90deg,var(--bookmark),#f97316);border-radius:2px;transition:width .5s cubic-bezier(.4,0,.2,1);}

    /* ── Bookmark list ── */
    .bookmark-list{display:none;margin-bottom:20px;background:var(--surface);border:1px solid var(--border);border-radius:12px;overflow:hidden;}
    .bookmark-list.show{display:block;animation:fadeIn .3s ease;}
    .bookmark-list-header{padding:12px 16px;font-family:var(--mono);font-size:.72rem;color:var(--bookmark);border-bottom:1px solid var(--border);letter-spacing:.1em;}
    .bookmark-item{padding:12px 16px;font-size:.82rem;color:var(--muted);border-bottom:1px solid var(--border);cursor:pointer;transition:background .15s;}
    .bookmark-item:last-child{border-bottom:none;}
    .bookmark-item:hover{background:var(--surface2);}
    .bookmark-item span{color:var(--text);}
    .no-bookmarks{padding:16px;color:var(--muted);font-size:.85rem;text-align:center;}

    /* ── Question card ── */
    .question-card{background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:28px;margin-bottom:16px;}
    .q-number{font-family:var(--mono);font-size:.7rem;color:var(--bookmark);letter-spacing:.1em;margin-bottom:12px;}
    .q-text{font-size:1.05rem;font-weight:400;line-height:1.65;color:var(--text);}
    @keyframes slideIn{from{opacity:0;transform:translateY(16px);}to{opacity:1;transform:translateY(0);}}
    @keyframes fadeIn{from{opacity:0;}to{opacity:1;}}

    /* ── Options ── */
    .options{display:flex;flex-direction:column;gap:10px;margin-top:24px;}
    .option{background:var(--surface2);border:1px solid var(--border);border-radius:12px;padding:14px 18px;
      cursor:pointer;display:flex;align-items:center;gap:12px;transition:all .18s;font-size:.92rem;color:var(--text);text-align:left;width:100%;}
    .option:hover:not(.disabled){border-color:var(--bookmark);background:rgba(245,158,11,.05);}
    .option.disabled{cursor:default;pointer-events:none;}
    .option.correct{border-color:var(--correct);background:rgba(34,197,94,.08);color:var(--correct);}
    .option.wrong{border-color:var(--wrong);background:rgba(239,68,68,.08);color:var(--wrong);}
    .option.selected{border-color:var(--bookmark);background:rgba(245,158,11,.08);color:var(--text);}
    .option.selected .opt-letter{background:var(--bookmark);color:#fff;}
    .opt-letter{font-family:var(--mono);font-size:.72rem;font-weight:600;width:26px;height:26px;border-radius:6px;
      background:var(--border);color:var(--muted);display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:all .18s;}
    .option.correct .opt-letter{background:var(--correct);color:#fff;}
    .option.wrong .opt-letter{background:var(--wrong);color:#fff;}

    /* ── Feedback ── */
    .feedback{margin-top:16px;padding:14px 18px;border-radius:10px;font-size:.88rem;line-height:1.6;display:none;}
    .feedback.show{display:block;animation:fadeIn .25s ease;}
    .feedback.correct-fb{background:rgba(34,197,94,.07);border:1px solid rgba(34,197,94,.2);color:#86efac;}
    .feedback.wrong-fb{background:rgba(239,68,68,.07);border:1px solid rgba(239,68,68,.2);color:#fca5a5;}

    /* ── Change answer ── */
    .change-answer-wrap{display:none;margin-top:10px;}
    .change-answer-wrap.show{display:block;animation:fadeIn .25s ease;}
    .change-answer-btn{background:none;border:1px dashed var(--accent);color:var(--accent2);padding:8px 16px;
      border-radius:8px;font-family:'Sora',sans-serif;font-size:.8rem;cursor:pointer;transition:all .2s;}
    .change-answer-btn:hover{background:rgba(59,130,246,.07);}

    /* ── Disagree / Correction ── */
    .disagree-wrap{margin-top:14px;display:none;}
    .disagree-wrap.show{display:block;animation:fadeIn .3s ease;}
    .disagree-btn{background:none;border:1px dashed var(--muted);color:var(--muted);padding:8px 16px;
      border-radius:8px;font-family:'Sora',sans-serif;font-size:.8rem;cursor:pointer;transition:all .2s;}
    .disagree-btn:hover{border-color:var(--bookmark);color:var(--bookmark);}
    .correction-panel{margin-top:14px;display:none;background:var(--surface2);border:1px solid var(--border);border-radius:12px;padding:16px;}
    .correction-panel.show{display:block;animation:fadeIn .3s ease;}
    .correction-panel > p{font-size:.8rem;color:var(--muted);margin-bottom:12px;}
    .correction-options{display:flex;flex-direction:column;gap:8px;margin-bottom:14px;}
    .correction-option{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:10px 14px;
      cursor:pointer;display:flex;align-items:center;gap:10px;font-size:.85rem;color:var(--text);transition:all .18s;text-align:left;width:100%;}
    .correction-option:hover{border-color:var(--accent);background:rgba(59,130,246,.05);}
    .correction-option.selected{border-color:var(--bookmark);background:rgba(245,158,11,.08);color:var(--bookmark);}
    .co-letter{font-family:var(--mono);font-size:.7rem;font-weight:600;width:24px;height:24px;border-radius:5px;
      background:var(--border);color:var(--muted);display:flex;align-items:center;justify-content:center;flex-shrink:0;}
    .correction-option.selected .co-letter{background:var(--bookmark);color:#fff;}
    textarea{width:100%;background:var(--surface);border:1px solid var(--border);border-radius:8px;color:var(--text);
      font-family:'Sora',sans-serif;font-size:.85rem;padding:12px;resize:vertical;min-height:80px;outline:none;
      transition:border-color .2s;margin-bottom:12px;}
    textarea:focus{border-color:var(--accent);}
    textarea::placeholder{color:var(--muted);}
    .btn-send-correction{background:linear-gradient(135deg,var(--bookmark),#d97706);color:#fff;border:none;
      padding:10px 22px;border-radius:10px;font-family:'Sora',sans-serif;font-size:.85rem;font-weight:600;
      cursor:pointer;transition:all .2s;}
    .btn-send-correction:hover{transform:translateY(-1px);box-shadow:0 4px 16px rgba(245,158,11,.3);}

    /* ── Correction bar ── */
    .correction-bar{display:none;margin-top:14px;padding:14px 16px;
      background:rgba(245,158,11,.07);border:1px solid rgba(245,158,11,.25);border-radius:12px;}
    .correction-bar.show{display:block;animation:fadeIn .3s ease;}
    .correction-bar-top{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:6px;}
    .correction-bar-label{font-family:var(--mono);font-size:.68rem;color:var(--bookmark);letter-spacing:.1em;}
    .correction-undo-btn{background:none;border:1px solid rgba(239,68,68,.3);color:#fca5a5;padding:3px 10px;
      border-radius:6px;font-family:'Sora',sans-serif;font-size:.72rem;cursor:pointer;transition:all .2s;flex-shrink:0;}
    .correction-undo-btn:hover{border-color:var(--wrong);color:var(--wrong);}
    .correction-bar-answer{font-size:.88rem;color:var(--text);font-weight:600;margin-bottom:4px;}
    .correction-bar-expl{font-size:.82rem;color:var(--muted);line-height:1.5;margin-bottom:8px;}
    .correction-bar-note{font-size:.78rem;color:var(--bookmark);opacity:.85;}

    /* ── Removed-from-bookmark notice ── */
    .removed-notice{display:none;margin-top:12px;padding:10px 14px;
      background:rgba(100,116,139,.08);border:1px dashed rgba(100,116,139,.3);border-radius:10px;
      font-size:.82rem;color:var(--muted);display:flex;align-items:center;gap:8px;}
    .removed-notice.show{display:flex;animation:fadeIn .25s ease;}

    /* ── Nav buttons ── */
    .nav{display:flex;gap:10px;margin-top:20px;}
    .btn{padding:14px;border-radius:12px;border:none;font-family:'Sora',sans-serif;font-size:.9rem;font-weight:600;cursor:pointer;transition:all .2s;}
    .btn-prev{background:var(--surface2);border:1px solid var(--border);color:var(--muted);flex:0 0 auto;min-width:96px;}
    .btn-prev:hover:not(:disabled){border-color:var(--accent);color:var(--text);}
    .btn-prev:disabled{opacity:.3;cursor:not-allowed;}
    .btn-next{background:linear-gradient(135deg,var(--bookmark),#f97316);color:#fff;flex:1;}
    .btn-next:hover{transform:translateY(-1px);box-shadow:0 6px 20px rgba(245,158,11,.3);}
    .btn-next.skip-mode{background:var(--surface2);border:1px solid var(--border);color:var(--muted);}
    .btn-next.skip-mode:hover{border-color:var(--bookmark);color:var(--text);transform:none;box-shadow:none;}

    /* ── Question nav grid ── */
    .qnav-wrap{margin-top:10px;}
    .qnav-toggle-btn{background:var(--surface);border:1px solid var(--border);color:var(--muted);
      padding:10px 18px;border-radius:10px;font-family:'Sora',sans-serif;font-size:.82rem;cursor:pointer;
      transition:all .2s;display:flex;align-items:center;gap:8px;width:100%;justify-content:center;}
    .qnav-toggle-btn:hover{border-color:var(--bookmark);color:var(--text);}
    .qnav-toggle-btn.active{border-color:var(--bookmark);color:var(--bookmark);background:rgba(245,158,11,.05);}
    .qnav-panel{display:none;margin-top:10px;background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px;}
    .qnav-panel.show{display:block;animation:fadeIn .25s ease;}
    .qnav-label{font-family:var(--mono);font-size:.7rem;color:var(--muted);letter-spacing:.1em;margin-bottom:10px;}
    .qnav-legend{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px;}
    .qnav-legend-item{display:flex;align-items:center;gap:5px;font-size:.7rem;color:var(--muted);}
    .qnav-dot{width:10px;height:10px;border-radius:3px;}
    .qnav-dot.d-current{background:rgba(59,130,246,.7);}
    .qnav-dot.d-correct-bm{background:rgba(34,197,94,.7);outline:2px solid rgba(245,158,11,.6);outline-offset:1px;}
    .qnav-dot.d-correct{background:rgba(34,197,94,.35);}
    .qnav-dot.d-wrong-bm{background:rgba(239,68,68,.7);outline:2px solid rgba(245,158,11,.6);outline-offset:1px;}
    .qnav-dot.d-wrong{background:rgba(239,68,68,.35);}
    .qnav-dot.d-bm-unanswered{background:rgba(245,158,11,.6);}
    .qnav-dot.d-removed{background:var(--border);}
    .qnav-dot.d-answered{background:rgba(59,130,246,.4);}
    .qnav-grid{display:flex;flex-wrap:wrap;gap:8px;}
    .qnav-chip{width:40px;height:40px;border-radius:8px;border:1px solid var(--border);background:var(--surface2);
      color:var(--muted);font-family:var(--mono);font-size:.8rem;font-weight:600;cursor:pointer;
      display:flex;align-items:center;justify-content:center;transition:all .15s;position:relative;}
    .qnav-chip:hover{border-color:var(--bookmark);color:var(--text);}
    /* Current */
    .qnav-chip.qn-current{border-color:var(--accent);color:var(--accent);background:rgba(59,130,246,.12);}
    /* Correct answers */
    .qnav-chip.qn-correct{border-color:var(--correct);background:rgba(34,197,94,.12);color:var(--correct);}
    /* Wrong answers */
    .qnav-chip.qn-wrong{border-color:var(--wrong);background:rgba(239,68,68,.12);color:var(--wrong);}
    /* Still bookmarked unanswered */
    .qnav-chip.qn-bm-unanswered{border-color:var(--bookmark);background:rgba(245,158,11,.12);color:var(--bookmark);}
    /* Removed from bookmarks: mute everything */
    .qnav-chip.qn-removed{opacity:.4;}
    .qnav-chip.qn-removed:hover{opacity:1;}
    /* Blind (timed) mode: answered, but no correct/wrong reveal */
    .qnav-chip.qn-answered{border-color:rgba(59,130,246,.45);background:rgba(59,130,246,.06);color:var(--accent2);}
    /* Bookmark dot on answered chips that are still bookmarked */
    .qnav-chip.qn-has-bookmark::after{content:'●';position:absolute;top:2px;right:3px;
      color:var(--bookmark);font-size:.5rem;line-height:1;}

    /* ── Modal ── */
    .modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:100;
      display:none;align-items:center;justify-content:center;padding:20px;}
    .modal-overlay.show{display:flex;animation:fadeIn .2s ease;}
    .modal-box{background:var(--surface);border:1px solid var(--border);border-radius:18px;
      padding:32px 28px;max-width:400px;width:100%;text-align:center;animation:slideIn .3s cubic-bezier(.4,0,.2,1);}
    .modal-icon{font-size:2.5rem;margin-bottom:14px;}
    .modal-title{font-size:1.2rem;font-weight:600;color:var(--text);margin-bottom:10px;}
    .modal-msg{font-size:.9rem;color:var(--muted);line-height:1.6;margin-bottom:24px;}
    .modal-btns{display:flex;gap:12px;}
    .modal-btn-cancel{flex:1;padding:13px;border-radius:11px;background:var(--surface2);border:1px solid var(--border);
      color:var(--muted);font-family:'Sora',sans-serif;font-size:.9rem;font-weight:600;cursor:pointer;transition:all .2s;}
    .modal-btn-cancel:hover{border-color:var(--accent);color:var(--text);}
    .modal-btn-confirm{flex:1;padding:13px;border-radius:11px;
      background:linear-gradient(135deg,var(--bookmark),#f97316);color:#fff;border:none;
      font-family:'Sora',sans-serif;font-size:.9rem;font-weight:600;cursor:pointer;transition:all .2s;}
    .modal-btn-confirm:hover{transform:translateY(-1px);box-shadow:0 6px 20px rgba(245,158,11,.3);}
    .modal-btn-confirm.danger{background:linear-gradient(135deg,var(--wrong),#b91c1c);}
    .modal-btn-confirm.danger:hover{box-shadow:0 6px 20px rgba(239,68,68,.3);}

    /* ── Results ── */
    .results-card{background:var(--surface);border:1px solid var(--border);border-radius:16px;
      padding:36px 28px;text-align:center;display:none;}
    .results-card.show{display:block;animation:slideIn .4s cubic-bezier(.4,0,.2,1);}
    .score-big{font-family:var(--mono);font-size:3.5rem;font-weight:600;
      background:linear-gradient(135deg,var(--bookmark),#f97316);
      -webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:4px;}
    .score-percent{font-family:var(--mono);font-size:1.6rem;font-weight:600;color:var(--accent2);margin-bottom:4px;}
    .score-label{color:var(--muted);font-size:.88rem;margin-bottom:28px;}
    .stats{display:flex;gap:12px;justify-content:center;margin-bottom:24px;flex-wrap:wrap;}
    .stat{background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:14px 18px;text-align:center;min-width:76px;}
    .stat-val{font-family:var(--mono);font-size:1.4rem;font-weight:600;}
    .stat-val.c{color:var(--correct);} .stat-val.w{color:var(--wrong);}
    .stat-val.bm{color:var(--bookmark);} .stat-val.rm{color:var(--muted);}
    .stat-label{font-size:.7rem;color:var(--muted);margin-top:2px;letter-spacing:.05em;}
    .btn-review{display:block;margin:4px auto 12px;padding:12px 28px;border-radius:12px;background:none;
      border:1px solid var(--accent);color:var(--accent2);font-family:'Sora',sans-serif;font-size:.88rem;
      font-weight:600;cursor:pointer;transition:all .2s;}
    .btn-review:hover{background:rgba(59,130,246,.08);transform:translateY(-1px);}
    .btn-delete-bookmark{display:block;margin:4px auto 20px;padding:12px 28px;border-radius:12px;background:none;
      border:1px solid var(--wrong);color:#fca5a5;font-family:'Sora',sans-serif;font-size:.88rem;
      font-weight:600;cursor:pointer;transition:all .2s;}
    .btn-delete-bookmark:hover{background:rgba(239,68,68,.08);transform:translateY(-1px);}
    .btn-delete-bookmark:disabled{opacity:.5;cursor:not-allowed;transform:none;}
    .submit-status{font-size:.87rem;color:var(--muted);padding:12px 16px;background:var(--surface2);border:1px solid var(--border);border-radius:10px;}

    /* ── Mobile ── */
    @media(max-width:520px){
      .container{padding:16px 12px 200px;}
      .q-text{font-size:.95rem;} .question-card{padding:20px 16px;} .option{font-size:.86rem;padding:12px 14px;}
      .score-big{font-size:2.5rem;} .score-percent{font-size:1.3rem;}
      .stat{padding:10px 12px;min-width:66px;} .stat-val{font-size:1.1rem;}
      .qnav-chip{width:36px;height:36px;font-size:.75rem;}
      .btn{font-size:.85rem;padding:13px;} .btn-prev{min-width:80px;} .modal-box{padding:24px 18px;}
      .exam-timer{font-size:.7rem;padding:5px 10px;} .bm-list-btn{font-size:.72rem;padding:5px 10px;}
    }
    @media(max-width:360px){.qnav-chip{width:32px;height:32px;font-size:.7rem;}}
  </style>
</head>
<body>
<canvas id="bgCanvas"></canvas>
<div class="bg-grid"></div>
<div class="bg-orb bg-orb-1"></div><div class="bg-orb bg-orb-2"></div>
<div class="bg-orb bg-orb-3"></div><div class="bg-orb bg-orb-4"></div>

<div class="container">
  <div class="header">
    <div class="header-left">
      <div class="bookmarks-super-label">BOOKMARKS</div>
      <div class="quiz-subtitle" id="quizTitle"></div>
    </div>
    <div class="header-right">
      <div class="exam-timer" id="examTimer"><span>⏱</span><span id="timerText">00:00</span></div>
      <div class="bm-controls" id="bmControls">
        <button class="bm-icon-btn" id="bmIconBtn" title="Toggle bookmark for this question">🔖</button>
        <button class="bm-list-btn" id="bmListBtn" onclick="toggleBookmarkList()">
          📋 <span id="bmCount">0</span> saved
        </button>
      </div>
    </div>
  </div>

  <div class="progress-wrap">
    <div class="progress-label"><span id="qProgress">Question 1</span><span id="qFraction">1 / 0</span></div>
    <div class="progress-bar"><div class="progress-fill" id="progressFill"></div></div>
  </div>

  <div class="bookmark-list" id="bookmarkList">
    <div class="bookmark-list-header">🔖 STILL BOOKMARKED</div>
    <div id="bookmarkItems"><div class="no-bookmarks">No bookmarks yet</div></div>
  </div>

  <div class="question-card" id="questionCard">
    <div class="q-number" id="qNum"></div>
    <div class="q-text" id="qText"></div>
    <div class="options" id="options"></div>
    <div class="feedback" id="feedback"></div>
    <div class="change-answer-wrap" id="changeAnswerWrap">
      <button class="change-answer-btn" onclick="changeAnswer()">↩ Change Answer</button>
    </div>
    <div class="disagree-wrap" id="disagreeWrap">
      <button class="disagree-btn" onclick="showCorrectionPanel()">✏️ Disagree with answer? Correct it</button>
    </div>
    <div class="correction-panel" id="correctionPanel">
      <p>Select the option you believe is correct, then explain why:</p>
      <div class="correction-options" id="correctionOptions"></div>
      <textarea id="correctionText" placeholder="Why do you think this is the correct answer? (optional)"></textarea>
      <button class="btn-send-correction" onclick="sendCorrection()">📤 Send Correction</button>
    </div>
    <div class="correction-bar" id="correctionBar">
      <div class="correction-bar-top">
        <div class="correction-bar-label">✏️ YOUR CORRECTION</div>
        <button class="correction-undo-btn" onclick="undoCorrection()">✕ Remove</button>
      </div>
      <div class="correction-bar-answer" id="correctionBarAnswer"></div>
      <div class="correction-bar-expl" id="correctionBarExpl"></div>
      <div class="correction-bar-note">📬 Submit the quiz for this correction to take effect.</div>
    </div>
    <div class="removed-notice" id="removedNotice">
      <span>🔕</span><span>Removed from bookmarks — will be reported on submit.</span>
    </div>
  </div>

  <div class="nav">
    <button class="btn btn-prev" id="prevBtn" onclick="prevQuestion()" disabled>← Prev</button>
    <button class="btn btn-next skip-mode" id="nextBtn" onclick="nextQuestion()">Next →</button>
  </div>

  <div class="qnav-wrap">
    <button class="qnav-toggle-btn" id="qnavToggleBtn" onclick="toggleQNav()">⊞ &nbsp;All Questions</button>
    <div class="qnav-panel" id="qnavPanel">
      <div class="qnav-label">TAP A NUMBER TO JUMP</div>
      <div class="qnav-legend">
        <div class="qnav-legend-item"><div class="qnav-dot d-current"></div>Current</div>
        <div class="qnav-legend-item" id="legendCorrectBm"><div class="qnav-dot d-correct-bm"></div>Correct+Saved</div>
        <div class="qnav-legend-item" id="legendCorrect"><div class="qnav-dot d-correct"></div>Correct+Removed</div>
        <div class="qnav-legend-item" id="legendWrongBm"><div class="qnav-dot d-wrong-bm"></div>Wrong+Saved</div>
        <div class="qnav-legend-item" id="legendWrong"><div class="qnav-dot d-wrong"></div>Wrong+Removed</div>
        <div class="qnav-legend-item" id="legendAnswered" style="display:none;"><div class="qnav-dot d-answered"></div>Answered</div>
        <div class="qnav-legend-item" id="legendSaved"><div class="qnav-dot d-bm-unanswered"></div>Saved</div>
        <div class="qnav-legend-item" id="legendRemoved"><div class="qnav-dot d-removed"></div>Removed</div>
      </div>
      <div class="qnav-grid" id="qnavGrid"></div>
    </div>
  </div>

  <div class="results-card" id="resultsCard">
    <div class="score-big" id="scoreBig"></div>
    <div class="score-percent" id="scorePercent"></div>
    <div class="score-label">Review Complete</div>
    <div class="stats">
      <div class="stat"><div class="stat-val c" id="statCorrect">0</div><div class="stat-label">CORRECT</div></div>
      <div class="stat"><div class="stat-val w" id="statWrong">0</div><div class="stat-label">WRONG</div></div>
      <div class="stat"><div class="stat-val bm" id="statKept">0</div><div class="stat-label">KEPT</div></div>
      <div class="stat"><div class="stat-val rm" id="statRemoved">0</div><div class="stat-label">REMOVED</div></div>
    </div>
    ${quiz.timeMinutes > 0 && !quiz.reviewed ? '<button class="btn-review" id="reviewBtn" onclick="enterReview()">📝 Review Answers</button>' : ''}
    <button class="btn-delete-bookmark" id="deleteBookmarkBtn" onclick="promptDeleteBookmark()">🗑️ Delete Bookmark</button>
    <div class="submit-status" id="submitStatus">Submitting…</div>
  </div>
</div>

<div class="modal-overlay" id="submitModal">
  <div class="modal-box">
    <div class="modal-icon">🔖</div>
    <div class="modal-title">Submit Review?</div>
    <p class="modal-msg" id="modalMsg"></p>
    <div class="modal-btns">
      <button class="modal-btn-cancel" onclick="closeModal()">Go Back</button>
      <button class="modal-btn-confirm" onclick="confirmSubmit()">Submit Anyway</button>
    </div>
  </div>
</div>

<div class="modal-overlay" id="deleteBookmarkModal">
  <div class="modal-box">
    <div class="modal-icon">🗑️</div>
    <div class="modal-title">Delete This Bookmark Session?</div>
    <p class="modal-msg">This permanently removes your saved bookmarks and ends this session. The link won't work afterward. This can't be undone.</p>
    <div class="modal-btns">
      <button class="modal-btn-cancel" onclick="closeDeleteBookmarkModal()">Keep It</button>
      <button class="modal-btn-confirm danger" onclick="confirmDeleteBookmark()">Yes, Delete</button>
    </div>
  </div>
</div>

<script>
const QUIZ_ID      = ${JSON.stringify(id)};
const TITLE        = ${titleJson};
const QUESTIONS    = ${questionsJson};
const SESS_TOKEN   = ${tokenJson};
const EXAM_ENDS_AT = ${examEndsAtJs};
// EXAM_MODE (a timer was set) means the live pass is "blind": no correct/wrong
// reveal, no feedback text, no disagree, no bookmark toggling — only Change
// Answer stays active. Everything reveals once finalized, via the one-time Review.
const EXAM_MODE = !!EXAM_ENDS_AT;

// Store session token for cookie recovery
localStorage.setItem('qt_' + QUIZ_ID, SESS_TOKEN);

// ── State ─────────────────────────────────────────────────────────────────────
let current = 0, answered = false;
let bookmarks = new Set();          // questions STILL bookmarked
let corrections = {}, results = [], selectedCorrection = null;
let reviewMode = false, finalized = false, examTimerInterval = null;
const LETTERS = ['a','b','c','d','e'];

// ── Persistence ───────────────────────────────────────────────────────────────
const STATE_KEY = 'bm_quiz_state_' + QUIZ_ID;
function saveState() {
  try { localStorage.setItem(STATE_KEY, JSON.stringify({ current, results, bookmarks: [...bookmarks], corrections, reviewMode })); } catch(e) {}
}
function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(STATE_KEY) || 'null');
    if (!s) {
      // First load — all questions start bookmarked
      QUESTIONS.forEach(q => bookmarks.add(q.number));
      saveState(); return;
    }
    current     = typeof s.current === 'number' ? s.current : 0;
    results     = Array.isArray(s.results) ? s.results : [];
    bookmarks   = new Set(Array.isArray(s.bookmarks) ? s.bookmarks : []);
    corrections = (s.corrections && typeof s.corrections === 'object') ? s.corrections : {};
    reviewMode  = !!s.reviewMode;
    // Safety: if bookmarks empty and no saved state had any, re-init
    if (bookmarks.size === 0 && results.length === 0) {
      QUESTIONS.forEach(q => bookmarks.add(q.number));
      saveState();
    }
  } catch(e) {
    QUESTIONS.forEach(q => bookmarks.add(q.number));
  }
}
function clearState() { try { localStorage.removeItem(STATE_KEY); } catch(e) {} }

// ── Helpers ───────────────────────────────────────────────────────────────────
function getOptions(q) {
  return LETTERS.map(l => ({ letter: l.toUpperCase(), text: q['option_' + l] })).filter(o => o.text?.trim());
}

function formatHMS(ms) {
  if (ms < 0) ms = 0;
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = n => (n < 10 ? '0' + n : '' + n);
  return h > 0 ? (h + ':' + pad(m) + ':' + pad(s)) : (pad(m) + ':' + pad(s));
}

function startExamTimer() {
  if (!EXAM_ENDS_AT) return;
  const wrap = document.getElementById('examTimer');
  const textEl = document.getElementById('timerText');
  wrap.classList.add('show');
  function tick() {
    const remain = EXAM_ENDS_AT - Date.now();
    textEl.textContent = formatHMS(remain);
    wrap.classList.toggle('low', remain > 0 && remain <= 60000);
    if (remain <= 0) {
      clearInterval(examTimerInterval);
      examTimerInterval = null;
      textEl.textContent = '00:00';
      if (!finalized) doSubmit();
    }
  }
  tick();
  examTimerInterval = setInterval(tick, 1000);
}

// ── Render ────────────────────────────────────────────────────────────────────
function render() {
  const q = QUESTIONS[current], total = QUESTIONS.length, isLast = current === total - 1;
  const prevResult   = results.find(r => r.number === q.number);
  const sentCorr     = corrections[q.number]?.sent ? corrections[q.number] : null;
  const isBookmarked = bookmarks.has(q.number);
  const blind = EXAM_MODE && !finalized;

  document.getElementById('quizTitle').textContent  = TITLE;
  document.getElementById('qNum').textContent       = 'QUESTION ' + q.number + (reviewMode ? ' · Review' : '');
  document.getElementById('qText').textContent      = q.question;
  document.getElementById('qProgress').textContent  = 'Question ' + (current + 1);
  document.getElementById('qFraction').textContent  = (current + 1) + ' / ' + total;
  document.getElementById('progressFill').style.width = ((current + 1) / total * 100) + '%';

  // Bookmark controls + removed-notice are hidden entirely during a blind (timed,
  // not-yet-finalized) pass — bookmark curation only happens live (untimed) or
  // in the post-submit Review.
  document.getElementById('bmControls').style.display = blind ? 'none' : '';
  if (blind) document.getElementById('bookmarkList').classList.remove('show');

  // Bookmark icon state
  const bmBtn = document.getElementById('bmIconBtn');
  bmBtn.classList.toggle('active', isBookmarked);
  bmBtn.title = isBookmarked ? 'Remove from bookmarks' : 'Add back to bookmarks';
  document.getElementById('bmCount').textContent = bookmarks.size;
  const bmListBtn = document.getElementById('bmListBtn');
  bmListBtn.classList.toggle('has-items', bookmarks.size > 0);

  // Reset panels
  ['feedback','changeAnswerWrap','disagreeWrap','correctionPanel','correctionBar','removedNotice']
    .forEach(id => { const el = document.getElementById(id); el.className = el.className.split(' ')[0]; });
  document.getElementById('feedback').textContent = '';
  document.getElementById('correctionText').value = '';
  selectedCorrection = null;

  document.getElementById('prevBtn').disabled = current === 0;
  const nextBtn = document.getElementById('nextBtn');
  if (reviewMode) {
    nextBtn.textContent = isLast ? '📤 Submit Corrections & Removed Bookmarks' : 'Next →';
  } else {
    nextBtn.textContent = isLast ? 'Submit & Finish 🔖' : 'Next →';
  }

  // Render options
  const opts = getOptions(q), container = document.getElementById('options');
  container.innerHTML = '';
  opts.forEach(o => {
    const btn = document.createElement('button');
    btn.className = 'option';
    btn.innerHTML = '<span class="opt-letter">' + o.letter + '</span><span>' + o.text + '</span>';
    if (prevResult) {
      btn.classList.add('disabled');
      if (blind) {
        if (o.letter === prevResult.selectedLetter) btn.classList.add('selected');
      } else {
        if (o.letter === q.answer_letter) btn.classList.add('correct');
        else if (o.letter === prevResult.selectedLetter && !prevResult.correct) btn.classList.add('wrong');
      }
    } else { btn.onclick = () => selectOption(o.letter, btn); }
    container.appendChild(btn);
  });

  // Restore answered state
  if (prevResult) {
    answered = true; nextBtn.classList.remove('skip-mode');
    const fb = document.getElementById('feedback');
    if (blind) {
      fb.className = 'feedback';
      fb.textContent = '';
    } else {
      fb.className = 'feedback show ' + (prevResult.correct ? 'correct-fb' : 'wrong-fb');
      fb.textContent = prevResult.correct
        ? '✓ Correct!' + (q.explanation ? ' ' + q.explanation : '')
        : '✗ The correct answer is ' + q.answer_letter + ': ' + q.answer_text + (q.explanation ? ' — ' + q.explanation : '');
    }
    if (!finalized) {
      document.getElementById('changeAnswerWrap').className = 'change-answer-wrap show';
    }
    // Bookmarking and "disagree with answer" stay active after submission/finalization
    // (review), on BOTH correct and wrong questions — students may want to flag a
    // question they got right but still think is worded wrong or has a bad key.
    // Disagree stays hidden during a blind, still-in-progress timed pass, and once
    // a correction has already been sent for this question.
    if (!blind && !sentCorr) document.getElementById('disagreeWrap').className = 'disagree-wrap show';
  } else {
    answered = false; nextBtn.classList.add('skip-mode');
  }

  // Correction bar
  if (sentCorr) {
    document.getElementById('correctionBarAnswer').textContent = 'Your answer: ' + sentCorr.user_correction_letter + ' — ' + sentCorr.user_correction_text;
    document.getElementById('correctionBarExpl').textContent   = sentCorr.explanation ? '"' + sentCorr.explanation + '"' : '';
    document.getElementById('correctionBar').className = 'correction-bar show';
  }

  // Removed notice (not shown during a blind pass — nothing can be removed yet)
  if (!blind && !isBookmarked) {
    document.getElementById('removedNotice').className = 'removed-notice show';
  }

  renderQNav(); renderBookmarkList();
}

// ── Select answer ─────────────────────────────────────────────────────────────
function selectOption(letter, btn) {
  if (answered) return;
  answered = true;
  const q = QUESTIONS[current], isLast = current === QUESTIONS.length - 1, correct = letter === q.answer_letter;
  const blind = EXAM_MODE && !finalized;
  document.querySelectorAll('.option').forEach(b => {
    b.classList.add('disabled');
    if (!blind && b.querySelector('.opt-letter').textContent === q.answer_letter) b.classList.add('correct');
  });
  const fb = document.getElementById('feedback');
  if (blind) {
    btn.classList.add('selected');
    fb.className = 'feedback';
    fb.textContent = '';
  } else {
    if (!correct) btn.classList.add('wrong');
    fb.className = 'feedback show ' + (correct ? 'correct-fb' : 'wrong-fb');
    fb.textContent = correct
      ? '✓ Correct!' + (q.explanation ? ' ' + q.explanation : '')
      : '✗ The correct answer is ' + q.answer_letter + ': ' + q.answer_text + (q.explanation ? ' — ' + q.explanation : '');
  }
  results = results.filter(r => r.number !== q.number);
  results.push({ number: q.number, correct, selectedLetter: letter });
  document.getElementById('changeAnswerWrap').className = 'change-answer-wrap show';
  // Available regardless of correct/wrong — same reasoning as in render() above.
  if (!blind && !corrections[q.number]?.sent) document.getElementById('disagreeWrap').className = 'disagree-wrap show';
  const nextBtn = document.getElementById('nextBtn');
  nextBtn.classList.remove('skip-mode');
  nextBtn.textContent = isLast ? 'Submit & Finish 🔖' : 'Next →';
  saveState(); renderQNav();
}

function changeAnswer() {
  results = results.filter(r => r.number !== QUESTIONS[current].number);
  answered = false; saveState(); render();
}

// ── Correction ────────────────────────────────────────────────────────────────
function showCorrectionPanel() {
  const q = QUESTIONS[current];
  document.getElementById('correctionPanel').className = 'correction-panel show';
  document.getElementById('disagreeWrap').className    = 'disagree-wrap';
  const container = document.getElementById('correctionOptions'); container.innerHTML = '';
  getOptions(q).forEach(o => {
    const btn = document.createElement('button'); btn.className = 'correction-option';
    btn.innerHTML = '<span class="co-letter">' + o.letter + '</span><span>' + o.text + '</span>';
    btn.onclick = () => { document.querySelectorAll('.correction-option').forEach(b => b.classList.remove('selected')); btn.classList.add('selected'); selectedCorrection = o.letter; };
    container.appendChild(btn);
  });
}
function sendCorrection() {
  if (!selectedCorrection) { alert('Please select the option you believe is correct first.'); return; }
  const q = QUESTIONS[current], opts = getOptions(q);
  const corrText = opts.find(o => o.letter === selectedCorrection)?.text || '';
  const expl     = document.getElementById('correctionText').value.trim();
  corrections[q.number] = { question_number: q.number, question_text: q.question, original_answer_letter: q.answer_letter, original_answer_text: q.answer_text, user_correction_letter: selectedCorrection, user_correction_text: corrText, explanation: expl, sent: true };
  saveState();
  document.getElementById('correctionPanel').className = 'correction-panel';
  document.getElementById('disagreeWrap').className    = 'disagree-wrap';
  document.getElementById('correctionBarAnswer').textContent = 'Your answer: ' + selectedCorrection + ' — ' + corrText;
  document.getElementById('correctionBarExpl').textContent   = expl ? '"' + expl + '"' : '';
  document.getElementById('correctionBar').className = 'correction-bar show';
}
function undoCorrection() { delete corrections[QUESTIONS[current].number]; saveState(); render(); }

// ── Navigation ────────────────────────────────────────────────────────────────
function animateToQuestion() {
  const card = document.getElementById('questionCard');
  card.style.transition = ''; card.style.opacity = '0'; card.style.transform = 'translateY(12px)';
  setTimeout(() => { render(); card.style.transition = 'opacity .3s, transform .3s'; card.style.opacity = '1'; card.style.transform = 'translateY(0)'; }, 150);
}

function nextQuestion() {
  const isLast = current === QUESTIONS.length - 1;
  if (reviewMode) {
    if (isLast) { submitReviewUpdates(); return; }
    current++; saveState(); animateToQuestion();
    return;
  }
  if (isLast) {
    const unanswered = QUESTIONS.filter(q => !results.find(r => r.number === q.number)).length;
    if (unanswered > 0) {
      document.getElementById('modalMsg').textContent =
        unanswered + ' question' + (unanswered > 1 ? 's are' : ' is') +
        ' unanswered and will be marked as wrong. Ready to submit?';
      document.getElementById('submitModal').className = 'modal-overlay show';
    } else { doSubmit(); }
    return;
  }
  current++; saveState(); animateToQuestion();
}
function prevQuestion() { if (current === 0) return; current--; saveState(); animateToQuestion(); }
function goToQuestion(index) {
  current = index; saveState();
  document.getElementById('bookmarkList').classList.remove('show');
  document.getElementById('qnavPanel').classList.remove('show');
  document.getElementById('qnavToggleBtn').classList.remove('active');
  animateToQuestion();
}

// ── Modal ─────────────────────────────────────────────────────────────────────
function closeModal()    { document.getElementById('submitModal').className = 'modal-overlay'; }
function confirmSubmit() { closeModal(); doSubmit(); }

// ── Review (timed quizzes only, one-time) ─────────────────────────────────────
function enterReview() {
  if (!EXAM_MODE) return;
  reviewMode = true;
  current = 0;
  saveState();
  document.getElementById('resultsCard').classList.remove('show');
  document.getElementById('questionCard').style.display = '';
  document.querySelector('.nav').style.display = '';
  document.querySelector('.qnav-wrap').style.display = '';
  render();
}

// ── Submission ────────────────────────────────────────────────────────────────
const PENDING_KEY = 'bm_quiz_pending_' + QUIZ_ID;

function getStats() {
  QUESTIONS.forEach(q => {
    if (!results.find(r => r.number === q.number))
      results.push({ number: q.number, correct: false, selectedLetter: null, skipped: true });
  });
  const correct = results.filter(r => r.correct).length;
  const skipped = results.filter(r => r.skipped).length;
  const wrong   = results.filter(r => !r.correct && !r.skipped).length;
  const pct     = Math.round(correct / QUESTIONS.length * 100);
  const kept    = bookmarks.size;
  const removed = QUESTIONS.length - kept;
  return { correct, wrong, skipped, pct, kept, removed };
}

function populateResultsDom(stats) {
  document.getElementById('scoreBig').textContent     = stats.correct + ' / ' + QUESTIONS.length;
  document.getElementById('scorePercent').textContent = stats.pct + '% Correct';
  document.getElementById('statCorrect').textContent  = stats.correct;
  document.getElementById('statWrong').textContent    = stats.wrong;
  document.getElementById('statKept').textContent     = stats.kept;
  document.getElementById('statRemoved').textContent  = stats.removed;
}

function showResultsScreen() {
  document.getElementById('questionCard').style.display = 'none';
  document.querySelector('.nav').style.display          = 'none';
  document.querySelector('.qnav-wrap').style.display    = 'none';
  document.getElementById('resultsCard').className      = 'results-card show';
  const et = document.getElementById('examTimer');
  if (et) et.classList.remove('show');
  if (examTimerInterval) { clearInterval(examTimerInterval); examTimerInterval = null; }
}

function computeAndShowResults() {
  const stats = getStats();
  populateResultsDom(stats);
  showResultsScreen();
  return stats;
}

function buildPayload(stats) {
  return {
    title:             TITLE,
    score:             stats.correct + '/' + QUESTIONS.length,
    score_percent:     stats.pct + '%',
    correct_answers:   stats.correct,
    wrong_answers:     stats.wrong,
    skipped_questions: stats.skipped,
    total_questions:   QUESTIONS.length,
    kept_bookmarks:    stats.kept,
    removed_bookmarks_count: stats.removed,
    remaining_bookmarks: QUESTIONS
      .filter(q => bookmarks.has(q.number))
      .map(q => ({ number: q.number, question: q.question, answer_letter: q.answer_letter, answer_text: q.answer_text })),
    removed_bookmarks: QUESTIONS
      .filter(q => !bookmarks.has(q.number))
      .map(q => ({ number: q.number, question: q.question, answer_letter: q.answer_letter, answer_text: q.answer_text })),
    corrections: Object.values(corrections).filter(c => c.sent),
    full_results: results
  };
}

async function doSubmit() {
  finalized = true;
  const stats = computeAndShowResults();
  const payload = buildPayload(stats);

  try { localStorage.setItem(PENDING_KEY, JSON.stringify(payload)); } catch(e) {}

  await attemptSubmitAndFinalize(payload);
}

// Reached from the last review question. Re-posts to the SAME /submit/:id
// endpoint with the SAME payload shape as the original submission — just with
// the updated bookmarks/corrections — then returns to the results screen and
// removes the Review button (one-time only).
async function submitReviewUpdates() {
  const stats = getStats();
  const payload = buildPayload(stats);
  reviewMode = false;
  saveState();
  populateResultsDom(stats);
  showResultsScreen();
  const rb = document.getElementById('reviewBtn');
  if (rb) rb.remove();

  try { localStorage.setItem(PENDING_KEY, JSON.stringify(payload)); } catch(e) {}
  await attemptSubmitAndFinalize(payload);
}

// ── Auto-retry ────────────────────────────────────────────────────────────────
// The browser's "online" event only fires on real link-layer changes (wifi
// reconnecting, airplane mode, etc). It never fires if the device was online
// the whole time but the request still failed (a slow/flaky server, a
// timeout, a transient 502 from the webhook) — that case needs its own retry
// loop, not just a connectivity listener.
let retryTimer = null;
let retryDelay = 3000;
const RETRY_MAX_DELAY = 30000;
let submitInFlight = false;

function clearScheduledRetry() {
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
}
function scheduleRetry() {
  clearScheduledRetry();
  retryTimer = setTimeout(retryNow, retryDelay);
  retryDelay = Math.min(Math.round(retryDelay * 1.6), RETRY_MAX_DELAY);
}
async function retryNow() {
  clearScheduledRetry();
  const raw = localStorage.getItem(PENDING_KEY);
  if (!raw) return; // already submitted successfully via another path
  let payload;
  try { payload = JSON.parse(raw); } catch(e) { return; }
  await attemptSubmitAndFinalize(payload);
}
// Instant retry triggers — on top of (not instead of) the backoff loop above,
// so a genuine reconnect or the tab regaining focus does not have to wait out
// the current backoff delay.
window.addEventListener('online', () => { retryDelay = 3000; retryNow(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') retryNow();
});

// Tries to POST to server. On success: clears the retry cache only — the quiz
// record and local results stay put so results/Review keep working. On
// failure: keeps everything alive and retries automatically in the background.
async function attemptSubmitAndFinalize(payload) {
  if (submitInFlight) return;
  submitInFlight = true;
  const statusEl = document.getElementById('submitStatus');
  if (statusEl) statusEl.textContent = 'Submitting…';

  let ok = false;
  try {
    const r = await fetch('/submit/' + QUIZ_ID, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin', body: JSON.stringify(payload)
    });
    if (r.ok) {
      const data = await r.json().catch(() => null);
      ok = !!(data && data.ok);
    }
  } catch(e) { ok = false; }
  submitInFlight = false;

  if (ok) {
    try { localStorage.removeItem(PENDING_KEY); } catch(e) {}
    clearScheduledRetry();
    retryDelay = 3000;
    if (statusEl) statusEl.textContent = '✓ Review submitted successfully!';
  } else {
    if (statusEl) statusEl.innerHTML =
      'Could not reach the server — results saved locally.<br>' +
      '<small style="color:var(--muted);font-size:.8rem;margin-top:4px;display:block;">' +
      'Retrying automatically…</small>';
    scheduleRetry();
  }
}

async function checkPending() {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    if (!raw) return false;
    const p = JSON.parse(raw);

    finalized = true;
    if (Array.isArray(p.full_results) && p.full_results.length) results = p.full_results;
    if (Array.isArray(p.remaining_bookmarks)) bookmarks = new Set(p.remaining_bookmarks.map(b => b.number));

    populateResultsDom(getStats());
    showResultsScreen();
    await attemptSubmitAndFinalize(p);
    return true;
  } catch(e) { return false; }
}

// ── Delete Bookmark (available on results, both timed & untimed) ─────────────
function promptDeleteBookmark() {
  document.getElementById('deleteBookmarkModal').className = 'modal-overlay show';
}
function closeDeleteBookmarkModal() {
  document.getElementById('deleteBookmarkModal').className = 'modal-overlay';
}
async function confirmDeleteBookmark() {
  closeDeleteBookmarkModal();
  const btn = document.getElementById('deleteBookmarkBtn');
  const statusEl = document.getElementById('submitStatus');
  if (btn) { btn.disabled = true; btn.textContent = 'Deleting…'; }
  try {
    const r = await fetch('/quiz/' + QUIZ_ID + '/delete-bookmark', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin', body: JSON.stringify({ title: TITLE })
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok && data.ok) {
      if (btn) btn.textContent = '✓ Bookmark Deleted';
      if (statusEl) statusEl.textContent = '🗑️ Bookmark deleted — this link is no longer active.';
      try { localStorage.removeItem(STATE_KEY); localStorage.removeItem(PENDING_KEY); } catch(e) {}
    } else {
      if (btn) { btn.disabled = false; btn.textContent = '🗑️ Delete Bookmark'; }
      if (statusEl) statusEl.textContent = '⚠️ Could not delete right now — please try again.';
    }
  } catch(e) {
    if (btn) { btn.disabled = false; btn.textContent = '🗑️ Delete Bookmark'; }
    if (statusEl) statusEl.textContent = '📡 No connection — please try again.';
  }
}

// ── Bookmarks ─────────────────────────────────────────────────────────────────
function toggleBookmark() {
  if (EXAM_MODE && !finalized) return; // bookmark curation only happens live-untimed or in Review
  const q = QUESTIONS[current];
  bookmarks.has(q.number) ? bookmarks.delete(q.number) : bookmarks.add(q.number);
  document.getElementById('bmCount').textContent = bookmarks.size;
  document.getElementById('bmListBtn').classList.toggle('has-items', bookmarks.size > 0);
  renderBookmarkList(); renderQNav(); saveState();
  const isBookmarked = bookmarks.has(q.number);
  document.getElementById('bmIconBtn').classList.toggle('active', isBookmarked);
  document.getElementById('bmIconBtn').title = isBookmarked ? 'Remove from bookmarks' : 'Add back to bookmarks';
  const notice = document.getElementById('removedNotice');
  notice.className = isBookmarked ? 'removed-notice' : 'removed-notice show';
}
function toggleBookmarkList() { document.getElementById('bookmarkList').classList.toggle('show'); }
function renderBookmarkList() {
  const c = document.getElementById('bookmarkItems');
  if (!bookmarks.size) { c.innerHTML = '<div class="no-bookmarks">All questions removed from bookmarks</div>'; return; }
  c.innerHTML = [...bookmarks].sort((a,b)=>a-b).map(n => {
    const q = QUESTIONS.find(x=>x.number===n), idx = QUESTIONS.findIndex(x=>x.number===n);
    return '<div class="bookmark-item" onclick="goToQuestion(' + idx + ')">Q' + n + '. <span>' + (q?.question||'') + '</span></div>';
  }).join('');
}

// ── Question nav grid ─────────────────────────────────────────────────────────
function toggleQNav() {
  const p = document.getElementById('qnavPanel'), b = document.getElementById('qnavToggleBtn');
  p.classList.toggle('show'); b.classList.toggle('active', p.classList.contains('show'));
}
function renderQNav() {
  const grid = document.getElementById('qnavGrid'); if (!grid) return;
  const blind = EXAM_MODE && !finalized;

  ['legendCorrectBm','legendCorrect','legendWrongBm','legendWrong','legendSaved','legendRemoved'].forEach(id => {
    const el = document.getElementById(id); if (el) el.style.display = blind ? 'none' : '';
  });
  const legendAnswered = document.getElementById('legendAnswered');
  if (legendAnswered) legendAnswered.style.display = blind ? '' : 'none';

  grid.innerHTML = QUESTIONS.map((q, i) => {
    const r            = results.find(r => r.number === q.number && !r.skipped);
    const isBookmarked = bookmarks.has(q.number);
    let cls = 'qnav-chip';
    if (i === current) {
      cls += ' qn-current';
    } else if (blind) {
      if (r) cls += ' qn-answered';
    } else if (r && r.correct) {
      cls += ' qn-correct';
      if (!isBookmarked) cls += ' qn-removed';
    } else if (r && !r.correct) {
      cls += ' qn-wrong';
      if (!isBookmarked) cls += ' qn-removed';
    } else if (isBookmarked) {
      cls += ' qn-bm-unanswered';
    } else {
      cls += ' qn-removed'; // unanswered + removed
    }
    if (isBookmarked && i !== current && !blind) cls += ' qn-has-bookmark';
    return '<button class="' + cls + '" onclick="goToQuestion(' + i + ')" title="Q' + q.number + (isBookmarked ? ' 🔖' : ' 🔕') + '">' + q.number + '</button>';
  }).join('');
}

// ── Animated background ───────────────────────────────────────────────────────
(function initBackground() {
  const canvas = document.getElementById('bgCanvas'), ctx = canvas.getContext('2d');
  const mobile = window.innerWidth < 600, N = mobile ? 40 : 75;
  const PALETTE = [[245,158,11],[251,146,60],[168,85,247],[45,212,191],[96,165,250],[232,121,249],[52,211,153]];
  let dots = [], w, h, raf;
  function resize() {
    w = canvas.width = window.innerWidth; h = canvas.height = window.innerHeight;
    dots = Array.from({ length: N }, () => {
      const col = PALETTE[Math.floor(Math.random() * PALETTE.length)];
      return { x: Math.random()*w, y: Math.random()*h, r: Math.random()*2+0.5, vx: (Math.random()-.5)*.42, vy: (Math.random()-.5)*.42, op: Math.random()*.5+.18, col };
    });
  }
  function draw() {
    ctx.clearRect(0, 0, w, h);
    for (let i = 0; i < dots.length; i++) for (let j = i+1; j < dots.length; j++) {
      const dx=dots[i].x-dots[j].x, dy=dots[i].y-dots[j].y, d=Math.sqrt(dx*dx+dy*dy);
      if (d < 120) { const c=dots[i].col; ctx.beginPath(); ctx.strokeStyle='rgba('+c[0]+','+c[1]+','+c[2]+','+(0.1*(1-d/120))+')'; ctx.lineWidth=0.7; ctx.moveTo(dots[i].x,dots[i].y); ctx.lineTo(dots[j].x,dots[j].y); ctx.stroke(); }
    }
    dots.forEach(d => {
      d.x=(d.x+d.vx+w)%w; d.y=(d.y+d.vy+h)%h;
      ctx.beginPath(); ctx.arc(d.x,d.y,d.r,0,Math.PI*2);
      ctx.fillStyle='rgba('+d.col[0]+','+d.col[1]+','+d.col[2]+','+d.op+')'; ctx.fill();
    });
    raf = requestAnimationFrame(draw);
  }
  window.addEventListener('resize', () => { cancelAnimationFrame(raf); resize(); draw(); });
  resize(); draw();
})();

// ── Init ──────────────────────────────────────────────────────────────────────
document.getElementById('bmIconBtn').onclick = toggleBookmark;
loadState();

const SERVER_SUBMITTED   = ${submittedJs};
const SERVER_REVIEWED    = ${reviewedJs};
const SERVER_RESULTS     = ${finalResultsJson};
const SERVER_BOOKMARKS   = ${finalBookmarksJson};
const SERVER_CORRECTIONS = ${finalCorrectionsJson};

async function init() {
  if (SERVER_SUBMITTED) {
    finalized = true;
    // A local results array only ever gets populated once this device has
    // actually taken the quiz — an empty array means this is a fresh device /
    // cleared cache, so fall back to the server's saved copy (bookmarks always
    // default to "all saved" locally, so results.length is the reliable signal).
    const looksFresh = results.length === 0;
    if (looksFresh) {
      if (SERVER_RESULTS.length) results = SERVER_RESULTS;
      bookmarks = new Set(SERVER_BOOKMARKS);
      if (Object.keys(SERVER_CORRECTIONS).length) corrections = SERVER_CORRECTIONS;
    }

    if (reviewMode && EXAM_MODE && !SERVER_REVIEWED) {
      // Resume exactly where the reviewer left off instead of resetting to Q1.
      if (current < 0 || current >= QUESTIONS.length) current = 0;
      populateResultsDom(getStats());
      document.getElementById('questionCard').style.display = '';
      document.querySelector('.nav').style.display = '';
      document.querySelector('.qnav-wrap').style.display = '';
      render();
    } else {
      computeAndShowResults();
      if (SERVER_REVIEWED) { const rb = document.getElementById('reviewBtn'); if (rb) rb.remove(); }
      const statusEl = document.getElementById('submitStatus');
      if (statusEl) statusEl.textContent = '✓ Review submitted successfully!';
    }
    return;
  }
  const hasPending = await checkPending();
  if (!hasPending) { render(); startExamTimer(); }
}
init();
</script>
</body>
</html>`;
}
