/* TIE — Tracking Interaction Events · study address for ReMeDe · version 1.0.0
 *
 * Paste this whole file into a Cloudflare Worker (TIE's "Set up" tab walks you through it).
 *
 * What it does
 *   - Shows the live ReMeDe exactly as it is, at this Worker's own address. ReMeDe's code,
 *     hosting and public address are never touched.
 *   - On the way to the participant's browser it adds one script (the TIE tracker, below)
 *     that records cursor movement, clicks, scrolling and page views. No typed text is kept.
 *   - Keeps what it records in this Worker's own D1 database (binding name: DB).
 *   - Hands the records to the TIE dashboard when given the export key (secret: EXPORT_KEY).
 *
 * Settings (Worker → Settings → Variables and Secrets); all optional except EXPORT_KEY:
 *   EXPORT_KEY      secret passphrase the dashboard uses to read the data
 *   UPSTREAM        the site to show (default below)
 *   PID_PARAMS      address parameters that carry the participant ID (default "pid,participant")
 *   TASK_PARAMS     address parameters that carry the task code (default "task")
 *   GROUP_PARAMS    address parameters that carry the group (default "g,group")
 *   CAPTURE_SEARCH  "1" to keep the words typed into search boxes (off by default)
 */

const DEFAULTS = {
  UPSTREAM: 'https://remede-iitd.lovable.app',
  PID_PARAMS: 'pid,participant',
  TASK_PARAMS: 'task',
  GROUP_PARAMS: 'g,group',
  CAPTURE_SEARCH: '0',
};
const TIE_VERSION = '1.0.0';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/__tie/')) return await tieRoute(request, env, url);
      if (url.pathname === '/robots.txt') {
        return new Response('User-agent: *\nDisallow: /\n', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
      }
      return await relay(request, env, url);
    } catch (e) {
      return new Response('The study address could not reach the site: ' + ((e && e.message) || e), {
        status: 502, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
      });
    }
  },
};

/* ------------------------------------------------------------------ settings */
function settings(env) {
  const get = (k) => (env && env[k] != null && String(env[k]).trim() !== '' ? String(env[k]).trim() : DEFAULTS[k]);
  const list = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);
  const upstream = get('UPSTREAM').replace(/\/+$/, '');
  return {
    upstream,
    upstreamHost: new URL(upstream).host,
    pid: list(get('PID_PARAMS')),
    task: list(get('TASK_PARAMS')),
    group: list(get('GROUP_PARAMS')),
    searchText: get('CAPTURE_SEARCH') === '1',
  };
}

let injectCache = null;
function snippet(s) {
  const key = JSON.stringify(s);
  if (injectCache && injectCache.key === key) return injectCache.html;
  const conf = JSON.stringify({
    endpoint: '/__tie/c', upstreamHost: s.upstreamHost, pid: s.pid, task: s.task, group: s.group,
    searchText: s.searchText, sampleMs: 50, flushMs: 5000,
  });
  const js = ('(' + tieTracker.toString() + ')();').replace('__TIE_CFG__', () => conf);
  const html = '<meta name="robots" content="noindex,nofollow"><script data-tie="' + TIE_VERSION + '">' +
    js.replace(/<\/(script)/gi, '<\\/$1') + '</script>';
  injectCache = { key, html };
  return html;
}

/* ------------------------------------------------------------------ the relay */
const DROP_REQUEST = ['host', 'cf-connecting-ip', 'x-forwarded-for', 'x-real-ip', 'cf-ipcountry', 'cf-ray',
  'cf-visitor', 'x-forwarded-proto', 'cdn-loop', 'cf-worker', 'true-client-ip'];

async function relay(request, env, url) {
  const s = settings(env);
  const up = new URL(s.upstream);
  const target = new URL(url.pathname + url.search, up);
  const page = request.method === 'GET' && (request.headers.get('accept') || '').includes('text/html');
  const h = new Headers(request.headers);
  DROP_REQUEST.forEach((k) => h.delete(k));
  if (page) { h.delete('if-none-match'); h.delete('if-modified-since'); }
  const ref = h.get('referer');
  if (ref) {
    try {
      const r = new URL(ref);
      if (r.host === url.host) { r.protocol = up.protocol; r.host = up.host; h.set('referer', r.toString()); }
      else h.delete('referer');
    } catch (e) { h.delete('referer'); }
  }
  if (h.get('origin') === url.origin) h.set('origin', up.origin);
  const init = { method: request.method, headers: h, redirect: 'follow' };
  if (request.method !== 'GET' && request.method !== 'HEAD') init.body = request.body;

  const res = await fetch(target.toString(), init);
  const type = (res.headers.get('content-type') || '').toLowerCase();
  const out = new Headers(res.headers);
  out.set('x-robots-tag', 'noindex, nofollow');

  if (request.method === 'GET' && type.includes('text/html')) {
    ['content-security-policy', 'content-security-policy-report-only', 'content-length', 'etag', 'last-modified']
      .forEach((k) => out.delete(k));
    out.set('cache-control', 'no-store');
    const html = snippet(s);
    let added = false;
    return new HTMLRewriter()
      .on('meta[http-equiv]', {
        element(e) { if ((e.getAttribute('http-equiv') || '').toLowerCase() === 'content-security-policy') e.remove(); },
      })
      .on('head', { element(e) { if (!added) { e.prepend(html, { html: true }); added = true; } } })
      .onDocument({ end(end) { if (!added) { end.append(html, { html: true }); added = true; } } })
      .transform(new Response(res.body, { status: res.status, statusText: res.statusText, headers: out }));
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
}

/* ------------------------------------------------------------------ TIE routes */
async function tieRoute(request, env, url) {
  const route = url.pathname.slice('/__tie/'.length);
  if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
  if (route === 'c' && request.method === 'POST') return collect(request, env);
  if (route === 'status') return cors(json(await status(env, url, request)));
  if (route === 'export') return cors(await exportRows(env, url, request));
  if (route === 'sessions') return cors(await sessions(env, url, request));
  if (route === 'delete' && request.method === 'POST') return cors(await remove(env, url, request));
  if (route === 'download') return downloadPage();
  return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
function cors(res) {
  const h = new Headers(res.headers);
  h.set('access-control-allow-origin', '*');
  h.set('access-control-allow-methods', 'GET, POST, OPTIONS');
  h.set('access-control-allow-headers', 'content-type, x-tie-key');
  h.set('access-control-max-age', '86400');
  h.set('x-robots-tag', 'noindex, nofollow');
  return new Response(res.body, { status: res.status, headers: h });
}

let tableReady = false;
async function ensureTable(env) {
  if (tableReady) return;
  await env.DB.batch([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS tie_batches (id INTEGER PRIMARY KEY AUTOINCREMENT, sid TEXT NOT NULL, ' +
      'seq INTEGER NOT NULL, received TEXT NOT NULL, pid TEXT, task TEXT, grp TEXT, test INTEGER DEFAULT 0, n INTEGER, ' +
      'bytes INTEGER, body TEXT NOT NULL, UNIQUE(sid, seq))'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS tie_batches_pid ON tie_batches(pid)'),
  ]);
  tableReady = true;
}

async function keyOk(env, url, request) {
  const given = url.searchParams.get('key') || (request && request.headers.get('x-tie-key')) || '';
  const want = (env && env.EXPORT_KEY) || '';
  if (!given || !want) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(given)), crypto.subtle.digest('SHA-256', enc.encode(want))]);
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

const SID = /^[a-z0-9]{6,40}$/;
async function collect(request, env) {
  if (!env.DB) return new Response('no database', { status: 503 });
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > 700000) return new Response('too large', { status: 413 });
  const text = await request.text();
  if (text.length > 700000) return new Response('too large', { status: 413 });
  let b;
  try { b = JSON.parse(text); } catch (e) { return new Response('not json', { status: 400 }); }
  if (!b || typeof b.sid !== 'string' || !SID.test(b.sid) || !Number.isInteger(b.seq) || b.seq < 0 || b.seq > 1e6 ||
    !Array.isArray(b.ev) || b.ev.length > 6000) {
    return new Response('not a TIE batch', { status: 400 });
  }
  const c = b.ctx && typeof b.ctx === 'object' ? b.ctx : {};
  const str = (v) => (typeof v === 'string' ? v.slice(0, 64) : '');
  await ensureTable(env);
  await env.DB.prepare('INSERT OR IGNORE INTO tie_batches (sid, seq, received, pid, task, grp, test, n, bytes, body) ' +
    'VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)')
    .bind(b.sid, b.seq, new Date().toISOString(), str(c.pid), str(c.task), str(c.g), c.test ? 1 : 0, b.ev.length, text.length, text)
    .run();
  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
}

async function status(env, url, request) {
  const s = settings(env);
  const out = { tie: TIE_VERSION, upstream: s.upstream, database: !!env.DB, keySet: !!env.EXPORT_KEY, searchText: s.searchText,
    pidParams: s.pid, taskParams: s.task, groupParams: s.group };
  try {
    const r = await fetch(s.upstream + '/', { headers: { accept: 'text/html', 'user-agent': 'Mozilla/5.0 (compatible; TIE status check)' } });
    out.upstreamStatus = r.status;
    out.upstreamType = r.headers.get('content-type') || '';
    try { await r.body.cancel(); } catch (e) { /* ignore */ }
  } catch (e) {
    out.upstreamStatus = 0; out.upstreamError = String((e && e.message) || e);
  }
  out.keyOk = await keyOk(env, url, request);
  if (out.keyOk && env.DB) {
    await ensureTable(env);
    const r = await env.DB.prepare("SELECT count(*) AS batches, count(DISTINCT sid) AS sessions, " +
      "count(DISTINCT CASE WHEN test = 0 AND pid != '' THEN grp || ':' || pid END) AS participants, max(id) AS lastId, " +
      "max(received) AS last, sum(bytes) AS bytes FROM tie_batches").first();
    Object.assign(out, r || {});
  }
  return out;
}

async function exportRows(env, url, request) {
  if (!(await keyOk(env, url, request))) return json({ error: 'The export key is missing or wrong.' }, 403);
  if (!env.DB) return json({ error: 'No database is connected to this Worker.' }, 503);
  await ensureTable(env);
  const after = Math.max(0, parseInt(url.searchParams.get('after') || '0', 10) || 0);
  const limit = Math.min(1000, Math.max(1, parseInt(url.searchParams.get('limit') || '250', 10) || 250));
  const rs = await env.DB.prepare('SELECT id, received, body FROM tie_batches WHERE id > ?1 ORDER BY id LIMIT ?2').bind(after, limit).all();
  const rows = rs.results || [];
  const last = rows.length ? rows[rows.length - 1].id : after;
  const parts = rows.map((r) => '{"id":' + r.id + ',"rcv":' + JSON.stringify(r.received) + ',"b":' + r.body + '}');
  const body = '{"format":"tie-export/1","tie":' + JSON.stringify(TIE_VERSION) + ',"upstream":' + JSON.stringify(settings(env).upstream) +
    ',"exported":' + JSON.stringify(new Date().toISOString()) + ',"after":' + after + ',"last":' + last +
    ',"more":' + (rows.length === limit) + ',"rows":[' + parts.join(',') + ']}';
  return new Response(body, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}

async function sessions(env, url, request) {
  if (!(await keyOk(env, url, request))) return json({ error: 'The export key is missing or wrong.' }, 403);
  if (!env.DB) return json({ error: 'No database is connected to this Worker.' }, 503);
  await ensureTable(env);
  const rs = await env.DB.prepare('SELECT sid, max(pid) AS pid, max(task) AS task, max(grp) AS grp, max(test) AS test, ' +
    'count(*) AS batches, sum(n) AS events, sum(bytes) AS bytes, min(received) AS first, max(received) AS last ' +
    'FROM tie_batches GROUP BY sid ORDER BY last DESC LIMIT 2000').all();
  return json({ sessions: rs.results || [] });
}

async function remove(env, url, request) {
  if (!(await keyOk(env, url, request))) return json({ error: 'The export key is missing or wrong.' }, 403);
  if (!env.DB) return json({ error: 'No database is connected to this Worker.' }, 503);
  await ensureTable(env);
  const sids = (url.searchParams.get('sid') || '').split(',').map((x) => x.trim()).filter((x) => SID.test(x));
  const pid = (url.searchParams.get('pid') || '').trim();
  let deleted = 0;
  for (const sid of sids) {
    const r = await env.DB.prepare('DELETE FROM tie_batches WHERE sid = ?1').bind(sid).run();
    deleted += (r.meta && r.meta.changes) || 0;
  }
  if (pid) {
    const r = await env.DB.prepare('DELETE FROM tie_batches WHERE pid = ?1').bind(pid.slice(0, 64)).run();
    deleted += (r.meta && r.meta.changes) || 0;
  }
  if (!sids.length && !pid) return json({ error: 'Say which session or participant to delete.' }, 400);
  return json({ deleted });
}

function downloadPage() {
  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>TIE data download</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:560px;margin:48px auto;padding:0 16px;color:#1d2420;background:#f6f7f4}
input,button{font:inherit;padding:8px 12px;border-radius:6px;border:1px solid #9aa59c}button{background:#24493a;color:#fff;border-color:#24493a;cursor:pointer}
#log{white-space:pre-wrap;font:13px/1.5 ui-monospace,monospace;margin-top:16px}</style></head><body>
<h1 style="font-size:22px">Download the recorded data</h1>
<p>Saves everything this study address has recorded as one file, to keep as a backup or to open in TIE.</p>
<form id="f"><label>Export key <input id="k" type="password" autocomplete="off" required></label> <button>Download</button></form>
<div id="log"></div>
<script>
const q=new URLSearchParams(location.search);if(q.get('key'))document.getElementById('k').value=q.get('key');
document.getElementById('f').addEventListener('submit',async e=>{e.preventDefault();const key=document.getElementById('k').value.trim();const log=document.getElementById('log');
let after=0,rows=[],head=null;try{for(;;){const r=await fetch('/__tie/export?key='+encodeURIComponent(key)+'&after='+after+'&limit=200');
const j=await r.json();if(!r.ok)throw new Error(j.error||r.status);head=head||j;rows=rows.concat(j.rows);after=j.last;log.textContent='Fetched '+rows.length+' batches…';if(!j.more)break;}
const out={format:'tie-export/1',tie:head.tie,upstream:head.upstream,exported:new Date().toISOString(),after:0,last:after,more:false,rows};
const blob=new Blob([JSON.stringify(out)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);
a.download='tie-data-'+new Date().toISOString().slice(0,10)+'.json';document.body.appendChild(a);a.click();log.textContent='Saved '+rows.length+' batches.';}
catch(err){log.textContent='Could not download: '+err.message;}});
</script></body></html>`;
  return new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });
}

/* ------------------------------------------------------------------ the tracker
 * Everything below runs in the participant's browser, never in the Worker.
 * The Worker turns this function into text and adds it to each page it relays. */
/* TIE tracker — runs only on the TIE study address, which relays the live site
   unchanged and adds this script on the way to the participant's browser.
   It records cursor movement, clicks (with a readable name for what was clicked),
   scrolling, page views and outlines of each page's layout, and sends them in
   small batches to the study address. Typed text is never recorded (search text
   only when the researcher turns it on). Every handler is guarded: if anything
   in here fails, the tracker switches itself off and the site carries on. */
function tieTracker() {
  'use strict';
  var CFG = __TIE_CFG__;
  var W = window, D = document, NAV = navigator;
  if (W.__TIE || W.top !== W) return;
  var VERSION = '1.0.0';

  /* ---------- safety ---------- */
  var ok = true, internalErrors = 0, intervals = [], observer = null;
  function stop() {
    ok = false;
    for (var i = 0; i < intervals.length; i++) clearInterval(intervals[i]);
    if (observer) { try { observer.disconnect(); } catch (e) { } }
  }
  function guard(fn) {
    return function () {
      if (!ok) return;
      try { return fn.apply(this, arguments); } catch (e) { if (++internalErrors > 30) stop(); }
    };
  }
  function every(ms, fn) { var id = setInterval(guard(fn), ms); intervals.push(id); return id; }
  function later(ms, fn) { return setTimeout(guard(fn), ms); }
  function on(target, type, fn, capture) {
    try { target.addEventListener(type, guard(fn), { capture: !!capture, passive: true }); } catch (e) { }
  }

  /* ---------- storage (namespaced, never required) ---------- */
  function probe(name) {
    try { var s = W[name], k = '__tie_probe'; s.setItem(k, '1'); s.removeItem(k); return s; } catch (e) { return null; }
  }
  var SS = probe('sessionStorage'), LS = probe('localStorage');
  function sget(s, k) { try { return s ? s.getItem(k) : null; } catch (e) { return null; } }
  function sput(s, k, v) { try { if (s) { s.setItem(k, v); return true; } } catch (e) { } return false; }
  function sdel(s, k) { try { if (s) s.removeItem(k); } catch (e) { } }
  function jget(s, k) { var v = sget(s, k); if (!v) return null; try { return JSON.parse(v); } catch (e) { return null; } }

  /* ---------- who and what (from the study link) ---------- */
  var U;
  try { U = new URL(location.href); } catch (e) { return; }
  var Q = U.searchParams;
  if (Q.get('tie') === 'off') sput(SS, 'tie:off', '1');
  if (Q.get('tie') === 'on') sdel(SS, 'tie:off');
  if (sget(SS, 'tie:off') === '1') { W.__TIE = { v: VERSION, off: true }; return; }
  if (Q.get('tie_debug') === '1') sput(SS, 'tie:debug', '1');
  if (Q.get('tie_debug') === '0') sdel(SS, 'tie:debug');
  var DEBUG = sget(SS, 'tie:debug') === '1';

  function pick(names) {
    for (var i = 0; i < names.length; i++) {
      var v = Q.get(names[i]);
      if (v) return String(v).trim().slice(0, 64);
    }
    return '';
  }
  var fromUrl = { pid: pick(CFG.pid), task: pick(CFG.task), g: pick(CFG.group), test: Q.get('tie_test') === '1' ? 1 : 0 };
  var prev = jget(SS, 'tie:ctx');
  var ctx, fresh = false;
  if (fromUrl.pid || fromUrl.task || fromUrl.g || fromUrl.test) {
    var p = prev || {};
    var same = !fromUrl.pid || !p.pid || fromUrl.pid === p.pid;
    ctx = {
      pid: fromUrl.pid || (same ? p.pid || '' : ''),
      task: fromUrl.task || (same && !fromUrl.pid ? p.task || '' : ''),
      g: fromUrl.g || (same ? p.g || '' : ''),
      test: fromUrl.test || (same ? p.test || 0 : 0),
      src: 'link'
    };
    fresh = !prev || ctx.pid !== (p.pid || '') || ctx.task !== (p.task || '');
    sput(LS, 'tie:last', JSON.stringify({ ctx: ctx, at: Date.now() }));
  } else if (prev) {
    ctx = prev;
  } else {
    var shared = jget(LS, 'tie:last');
    if (shared && shared.ctx && Date.now() - shared.at < 3 * 3600 * 1000) {
      ctx = { pid: shared.ctx.pid || '', task: shared.ctx.task || '', g: shared.ctx.g || '', test: shared.ctx.test || 0, src: 'tab' };
    } else ctx = { pid: '', task: '', g: '', test: 0, src: 'none' };
    fresh = true;
  }
  sput(SS, 'tie:ctx', JSON.stringify(ctx));

  /* ---------- session ---------- */
  function rid() {
    var a = new Uint32Array(3), s = '';
    try { (W.crypto || W.msCrypto).getRandomValues(a); } catch (e) { for (var j = 0; j < 3; j++) a[j] = Math.floor(Math.random() * 4294967296); }
    for (var i = 0; i < a.length; i++) s += ('000000' + a[i].toString(36)).slice(-6);
    return s;
  }
  var sid = sget(SS, 'tie:sid'), t0, seq, loadNo;
  if (fresh || !sid) {
    sid = rid(); t0 = Date.now(); seq = 0; loadNo = 1;
    sput(SS, 'tie:sid', sid); sput(SS, 'tie:t0', String(t0)); sput(SS, 'tie:seq', '0');
  } else {
    t0 = +sget(SS, 'tie:t0') || Date.now();
    seq = +sget(SS, 'tie:seq') || 0;
    loadNo = (+sget(SS, 'tie:load') || 0) + 1;
  }
  sput(SS, 'tie:load', String(loadNo));
  function now() { return Date.now() - t0; }
  var perf = W.performance && W.performance.now ? function () { return W.performance.now(); } : function () { return Date.now(); };

  /* ---------- small helpers ---------- */
  function hk(s) {
    var a = 0x811c9dc5, b = 0x01000193 ^ 0x5bd1e995;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      a = Math.imul(a ^ c, 16777619);
      b = Math.imul(b ^ c, 2246822519);
    }
    return (a >>> 0).toString(36) + ((b >>> 0) % 46656).toString(36);
  }
  function clean(s, n) {
    s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }
  var R = Math.round;
  function vpW() { return D.documentElement ? D.documentElement.clientWidth || W.innerWidth : W.innerWidth; }

  var buf = [], sentEls = {}, sentLabels = {}, needDev = true, stats = { ev: 0, sent: 0, failed: 0, lastOk: 0 };
  function push(e) { buf.push(e); stats.ev++; if (buf.length >= 400) flush(false); }

  /* ---------- page frame: main scroller and fixed bars ---------- */
  var primary = null;           // the large inner scroll area, when the site scrolls inside a container
  var ancCache = new WeakMap(); // element -> nearest fixed/sticky ancestor (or null)
  function stickyAnc(el) {
    if (!el || el.nodeType !== 1) return null;
    var path = [], n = el, res = null, depth = 0;
    while (n && n.nodeType === 1 && n !== D.body && n !== D.documentElement && depth < 40) {
      if (ancCache.has(n)) { res = ancCache.get(n); break; }
      path.push(n);
      var cs = W.getComputedStyle(n), pos = cs.position;
      if (pos === 'fixed' || pos === 'sticky') { res = { node: n, pos: pos, top: parseFloat(cs.top) }; break; }
      n = n.parentElement; depth++;
    }
    for (var i = 0; i < path.length; i++) ancCache.set(path[i], res);
    return res;
  }
  function scrolled() { return W.scrollY > 0 || (primary && primary.scrollTop > 0); }
  // A fixed or stuck bar along an edge of the window (a header, a side menu) is drawn where the
  // participant saw it, at the top of the page; everything else is placed on the full page.
  function isBar(anc, memo) {
    if (!anc) return false;
    if (memo && memo.has(anc.node)) return memo.get(anc.node);
    var r = anc.node.getBoundingClientRect(), vw = vpW(), vh = W.innerHeight, res = false;
    if (anc.pos === 'sticky' && (!scrolled() || !(isFinite(anc.top) && Math.abs(r.top - anc.top) < 2))) res = false;
    else {
      var bar = r.width >= vw * 0.5 && (r.top <= 2 || r.bottom >= vh - 2) && r.height <= vh * 0.4;
      var side = r.height >= vh * 0.6 && (r.left <= 2 || r.right >= vw - 2) && r.width <= vw * 0.4;
      res = bar || side;
    }
    if (memo) memo.set(anc.node, res);
    return res;
  }
  function toPage(cx, cy, el) {
    if (isBar(stickyAnc(el))) return [R(cx), R(cy), 1];
    var x = cx + W.scrollX, y = cy + W.scrollY;
    if (primary && el && primary !== el && primary.contains(el)) { x += primary.scrollLeft; y += primary.scrollTop; }
    return [R(x), R(y), 0];
  }
  function rectPage(el, r, memo) {
    r = r || el.getBoundingClientRect();
    if (isBar(stickyAnc(el), memo)) return [R(r.left), R(r.top), R(r.width), R(r.height), 1];
    var x = r.left + W.scrollX, y = r.top + W.scrollY, h = r.height;
    if (primary && primary !== el && primary.contains(el)) { x += primary.scrollLeft; y += primary.scrollTop; }
    if (el === primary) h = primary.scrollHeight;
    return [R(x), R(y), R(r.width), R(h), 0];
  }
  function docH() {
    var de = D.documentElement, b = D.body;
    var h = Math.max(de ? de.scrollHeight : 0, b ? b.scrollHeight : 0, W.innerHeight);
    if (primary) {
      var r = primary.getBoundingClientRect();
      h = Math.max(h, r.top + W.scrollY + primary.scrollHeight);
    }
    return R(h);
  }
  function band() { // the strip of the page currently visible
    if (primary) {
      var r = primary.getBoundingClientRect(), off = W.scrollY + primary.scrollTop;
      return [R(Math.max(0, r.top) + off), R(Math.min(W.innerHeight, r.bottom) + off)];
    }
    return [R(W.scrollY), R(W.scrollY + W.innerHeight)];
  }

  /* ---------- what an element is ---------- */
  var ACT = 'a[href],button,input,select,textarea,summary,label,[role=button],[role=link],[role=tab],[role=menuitem],' +
    '[role=menuitemcheckbox],[role=menuitemradio],[role=option],[role=checkbox],[role=radio],[role=switch],[role=combobox],' +
    '[role=treeitem],[role=gridcell],[contenteditable=""],[contenteditable=true]';
  function actionable(el) {
    if (!el || el.nodeType !== 1) return null;
    var a = el.closest ? el.closest(ACT) : null;
    if (a) return a;
    var n = el, best = null, d = 0;
    while (n && n.nodeType === 1 && n !== D.body && d < 10) {
      if (W.getComputedStyle(n).cursor === 'pointer') best = n; else if (best) break;
      n = n.parentElement; d++;
    }
    return best;
  }
  function iconOf(el) {
    var svg = el.tagName && el.tagName.toLowerCase() === 'svg' ? el : (el.querySelector ? el.querySelector('svg') : null);
    if (!svg) return '';
    var m = String(svg.getAttribute('class') || '').match(/lucide-([a-z0-9-]+)/);
    return m ? m[1] : 'svg';
  }
  function labelOf(el) {
    var a = el.getAttribute('aria-label');
    if (a && clean(a, 80)) return clean(a, 80);
    var lb = el.getAttribute('aria-labelledby');
    if (lb) {
      var t = lb.split(/\s+/).map(function (id) { var x = D.getElementById(id); return x ? x.textContent : ''; }).join(' ');
      if (clean(t, 80)) return clean(t, 80);
    }
    if (el.isContentEditable) return clean(el.getAttribute('data-placeholder') || el.getAttribute('placeholder') || 'text editor', 80);
    var tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      if (el.labels && el.labels.length && clean(el.labels[0].textContent, 80)) return clean(el.labels[0].textContent, 80);
      var ph = el.getAttribute('placeholder');
      if (ph) return clean(ph, 80);
      if (tag === 'INPUT' && /^(button|submit|reset)$/i.test(el.type) && el.value) return clean(el.value, 80);
      return clean(el.getAttribute('name') || el.getAttribute('title') || (tag === 'INPUT' ? el.type : tag.toLowerCase()), 80);
    }
    var raw = el.textContent || '';
    if (raw.length > 400) { // a large area rather than a control: name it by its first heading, if any
      var big = el.querySelector('h1,h2,h3,h4,h5,h6');
      return big ? clean(big.textContent, 80) : '';
    }
    var txt = clean(el.innerText != null ? el.innerText : raw, 240);
    if (txt.length > 60) {
      var hd = el.querySelector('h1,h2,h3,h4,h5,h6,[class*="title"]');
      if (hd && clean(hd.textContent, 80)) return clean(hd.textContent, 80);
    }
    if (txt) return clean(txt, 80);
    var ti = el.getAttribute('title');
    if (ti) return clean(ti, 80);
    var img = el.querySelector ? el.querySelector('img[alt]') : null;
    if (img && img.alt) return clean(img.alt, 80);
    var ic = iconOf(el);
    return ic ? 'icon: ' + ic : '';
  }
  function regionOf(el) {
    if (el.closest('[role=dialog],[role=alertdialog],dialog')) return 'dialog';
    if (el.closest('[role=menu],[role=listbox],[data-radix-popper-content-wrapper],[role=tooltip]')) return 'popup';
    if (el.closest('header,[role=banner]')) return 'header';
    if (el.closest('nav,[role=navigation]')) return 'nav';
    if (el.closest('aside,[role=complementary]')) return 'aside';
    if (el.closest('footer,[role=contentinfo]')) return 'footer';
    if (el.closest('main,[role=main]')) return 'main';
    return 'page';
  }
  function sectionOf(el) {
    var n = el, d = 0;
    while (n && n.nodeType === 1 && n !== D.body && d < 8) {
      if (/^H[1-6]$/.test(n.tagName)) return clean(n.textContent, 60);
      var s = n.previousElementSibling, k = 0;
      while (s && k < 40) {
        if (/^H[1-6]$/.test(s.tagName)) return clean(s.textContent, 60);
        var hs = s.querySelectorAll ? s.querySelectorAll('h1,h2,h3,h4') : [];
        if (hs.length) return clean(hs[hs.length - 1].textContent, 60);
        s = s.previousElementSibling; k++;
      }
      n = n.parentElement; d++;
    }
    return '';
  }
  function patternOf(el) {
    var parts = [], n = el, d = 0;
    while (n && n.nodeType === 1 && n !== D.body && d < 6) {
      var t = n.tagName.toLowerCase(), r = n.getAttribute('role');
      parts.unshift(r ? t + '[' + r + ']' : t);
      if (/^(main|header|nav|aside|footer|dialog)$/.test(t)) break;
      n = n.parentElement; d++;
    }
    return parts.join('>');
  }
  function hrefOf(el) {
    if (el.tagName !== 'A') return '';
    var h = el.getAttribute('href') || '';
    try {
      var u = new URL(h, location.href);
      if (u.host === location.host || u.host === CFG.upstreamHost) return u.pathname + u.search + u.hash;
      return u.protocol === 'mailto:' ? 'mailto:' : u.host + u.pathname;
    } catch (e) { return clean(h, 80); }
  }
  function interactiveEl(el) {
    return !!(el && el.matches && (el.matches(ACT) || W.getComputedStyle(el).cursor === 'pointer'));
  }
  function describe(el, lite) {
    var tag = el.tagName.toLowerCase();
    var d = {
      g: tag, r: el.getAttribute('role') || '', y: tag === 'input' ? String(el.type || 'text').toLowerCase() : '',
      l: lite ? '' : labelOf(el), i: lite ? '' : iconOf(el), rg: regionOf(el), s: lite ? '' : sectionOf(el), p: patternOf(el), h: hrefOf(el),
      n: lite ? 0 : interactiveEl(el) ? 1 : 0
    };
    var id = el.id;
    if (id && !/\d{3,}|radix|^:|^r\d|^[a-f0-9-]{16,}$/i.test(id)) d.id = clean(id, 40);
    return d;
  }
  function reg(el, lite) {
    var d = describe(el, lite);
    var k = hk([d.g, d.r, d.y, d.l, d.i, d.rg, d.s, d.p, d.h].join('|'));
    if (!sentEls[k]) { sentEls[k] = 1; push(['e', k, d]); }
    return k;
  }
  function lab(text) {
    text = clean(text, 60);
    if (!text) return 0;
    var k = hk(text);
    if (!sentLabels[k]) { sentLabels[k] = 1; push(['lb', k, text]); }
    return k;
  }

  /* ---------- page views (single-page app aware) ---------- */
  var STRIP = {};
  [].concat(CFG.pid, CFG.task, CFG.group, ['tie', 'tie_test', 'tie_debug']).forEach(function (k) { STRIP[k] = 1; });
  function pathParts() {
    var u = new URL(location.href), keys = [];
    u.searchParams.forEach(function (v, k) { if (STRIP[k]) keys.push(k); });
    keys.forEach(function (k) { u.searchParams.delete(k); });
    return [u.pathname + u.search, u.hash];
  }
  var lastHref = null, pv = 0, pvAt = 0, curPath = '';
  function checkRoute() {
    if (!D.body) return;
    var href = location.pathname + location.search + location.hash;
    if (href === lastHref) return;
    lastHref = href; pv++; pvAt = perf(); mark(signals.route);
    if (primary && !D.contains(primary)) primary = null;
    ancCache = new WeakMap();
    var pp = pathParts();
    curPath = pp[0];
    push(['P', now(), pp[0], pp[1], clean(D.title, 120), W.innerWidth, W.innerHeight, vpW(), docH(), pv]);
    var b = band(); push(['s', now(), b[0], b[1]]);
    snapState.due = perf() + 350; snapState.hard = perf() + 2500; snapState.pending = true;
  }

  /* ---------- layout outlines ---------- */
  var SNAP_MAIN = 'h1,h2,h3,h4,h5,h6,a[href],button,input,select,textarea,summary,[role=button],[role=tab],[role=link],' +
    '[role=checkbox],[role=switch],[role=combobox],[role=dialog],[role=alertdialog],header,nav,main,aside,footer,' +
    '[class*="cursor-pointer"],[class*="card"]';
  var SNAP_REST = 'section,article,p,li,img,video,iframe,figure,label,td,th,pre,blockquote';
  var MAX_ITEMS = 900;
  var snapState = { due: 0, hard: 0, pending: false, scheduled: false, last: 0, sigs: {}, count: 0, dirty: false, cheap: '' };
  var lastMut = 0;
  function kindOf(el) {
    var t = el.tagName;
    if (/^H[1-6]$/.test(t)) return 'h' + Math.min(4, +t.charAt(1));
    switch (t) {
      case 'A': return 'a';
      case 'BUTTON': case 'SUMMARY': return 'b';
      case 'INPUT': return /^(checkbox|radio)$/i.test(el.type) ? 'x' : /^(button|submit|reset)$/i.test(el.type) ? 'b' : 'i';
      case 'SELECT': return 's';
      case 'TEXTAREA': return 'i';
      case 'HEADER': case 'NAV': case 'MAIN': case 'ASIDE': case 'FOOTER': return 'L';
      case 'SECTION': case 'ARTICLE': return 'S';
      case 'IMG': case 'VIDEO': case 'IFRAME': case 'FIGURE': return 'g';
      case 'LI': return 'l';
      case 'P': case 'PRE': case 'BLOCKQUOTE': case 'TD': case 'TH': case 'LABEL': return 'p';
    }
    var r = el.getAttribute('role');
    if (r === 'dialog' || r === 'alertdialog') return 'd';
    if (r === 'tab') return 't';
    if (r) return 'b';
    var c = String(el.getAttribute('class') || '');
    if (/cursor-pointer/.test(c)) return 'c';
    return 'k';
  }
  function snapLabel(kind, el) {
    if (kind === 'L') return el.tagName.toLowerCase();
    if (kind.charAt(0) === 'h' || kind === 'b' || kind === 't' || kind === 'a' || kind === 'x' || kind === 's') {
      var a = el.getAttribute('aria-label');
      return a || el.textContent || (kind === 'x' ? '' : iconOf(el));
    }
    if (kind === 'i') return el.getAttribute('placeholder') || el.getAttribute('aria-label') || el.getAttribute('name') || '';
    if (kind === 'c' || kind === 'k') {
      var hd = el.querySelector('h1,h2,h3,h4,h5,h6');
      return hd ? hd.textContent : '';
    }
    return '';
  }
  function visible(el) {
    if (el.checkVisibility) { try { return el.checkVisibility({ visibilityProperty: true }); } catch (e) { } }
    return true;
  }
  function collect(sel, items, seen, memo) {
    var nodes = D.querySelectorAll(sel);
    for (var i = 0; i < nodes.length && items.length < MAX_ITEMS; i++) {
      var el = nodes[i];
      if (seen.has(el)) continue;
      seen.add(el);
      var r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4 || !visible(el)) continue;
      var kind = kindOf(el);
      var rp = rectPage(el, r, memo);
      if (rp[1] + rp[3] < -50 || rp[0] + rp[2] < -50) continue;
      var lb = lab(snapLabel(kind, el));
      var it = [kind, rp[0], rp[1], rp[2], rp[3]];
      if (lb || rp[4]) it.push(lb || 0);
      if (rp[4]) it.push(1);
      items.push(it);
    }
  }
  function takeSnap() {
    snapState.scheduled = false;
    if (!D.body || D.hidden) return;
    var started = perf();
    var items = [], seen = new Set(), memo = new Map();
    if (primary) items.push(['P'].concat(rectPage(primary, null, memo).slice(0, 4)));
    collect(SNAP_MAIN, items, seen, memo);
    collect(SNAP_REST, items, seen, memo);
    var cw = vpW(), dh = docH(), path = curPath;
    var sig = hk(path + '|' + cw + '|' + dh + '|' + JSON.stringify(items));
    snapState.last = perf(); snapState.pending = false; snapState.dirty = false; snapState.count++;
    snapState.cheap = cheapSig();
    if (snapState.sigs[sig]) push(['Xr', now(), sig]);
    else { snapState.sigs[sig] = 1; push(['X', now(), sig, path, cw, dh, W.innerHeight, items]); }
    var took = perf() - started;
    if (took > 60) MAX_ITEMS = Math.max(250, R(MAX_ITEMS * 0.7));
  }
  function cheapSig() {
    try { return D.querySelectorAll(SNAP_MAIN).length + ':' + docH() + ':' + vpW(); } catch (e) { return ''; }
  }
  function snapTick() {
    if (!D.body || D.hidden || snapState.count > 150 || snapState.scheduled) return;
    var t = perf();
    if (snapState.pending) {
      if ((t >= snapState.due && t - lastMut > 250) || t >= snapState.hard) idle(takeSnap);
      return;
    }
    if (snapState.dirty && t - snapState.last > 1200) {
      snapState.dirty = false;
      if (cheapSig() !== snapState.cheap) idle(takeSnap);
    }
  }
  function idle(fn) {
    snapState.scheduled = true;
    if (W.requestIdleCallback) W.requestIdleCallback(guard(fn), { timeout: 800 }); else later(0, fn);
  }

  /* ---------- cursor ---------- */
  var SAMPLE = CFG.sampleMs || 50;
  var lastSample = 0, latest = null, trail = 0, lcx = -1, lcy = -1, lastTarget = null, lastInput = 0;
  function sample(e, rest) {
    lastSample = perf(); latest = null;
    var cx = e.clientX, cy = e.clientY;
    var el = rest ? (D.elementFromPoint(cx, cy) || lastTarget) : e.target;
    if (!el || el.nodeType !== 1) return;
    lastTarget = el;
    var p = toPage(cx, cy, el);
    var dx = lcx < 0 || rest ? 0 : R(cx - lcx), dy = lcy < 0 || rest ? 0 : R(cy - lcy);
    lcx = cx; lcy = cy;
    var rec = ['m', now(), p[0], p[1], dx, dy];
    if (p[2]) rec.push(1);
    push(rec);
  }
  on(D, 'mousemove', function (e) {
    lastInput = perf();
    if (e.clientX === lcx && e.clientY === lcy) return;
    var t = perf();
    if (t - lastSample >= SAMPLE) sample(e, false);
    else {
      latest = { clientX: e.clientX, clientY: e.clientY, target: e.target };
      if (!trail) trail = later(SAMPLE, function () { trail = 0; if (latest) sample(latest, false); });
    }
  }, true);
  on(D, 'mouseout', function (e) {
    if (!e.relatedTarget) { push(['mo', now()]); lcx = -1; lcy = -1; }
  }, true);

  /* ---------- scrolling ---------- */
  var lastScroll = 0, scrollTrail = 0, restTimer = 0, lastScrollAt = 0;
  function recordScroll() {
    lastScroll = perf();
    var b = band();
    push(['s', now(), b[0], b[1]]);
  }
  on(D, 'scroll', function (e) {
    var t = e.target;
    lastScrollAt = perf(); lastInput = lastScrollAt;
    if (lastScrollAt - lastUserScrollInput > 300) mark(signals.scroll);
    if (t && t.nodeType === 1 && t !== D.documentElement && t !== D.body) {
      if (t !== primary) {
        var r = t.getBoundingClientRect();
        if (r.width * r.height >= 0.35 * W.innerWidth * W.innerHeight && t.scrollHeight > t.clientHeight + 40) {
          primary = t; ancCache = new WeakMap();
          push(['sc', now(), reg(t, true)]);
        } else return;
      }
    }
    if (perf() - lastScroll >= 120) recordScroll();
    else if (!scrollTrail) scrollTrail = later(130, function () { scrollTrail = 0; recordScroll(); });
    clearTimeout(restTimer);
    restTimer = later(160, function () { if (lcx >= 0) sample({ clientX: lcx, clientY: lcy }, true); });
  }, true);

  /* ---------- clicks ---------- */
  // A click counts as answered when, before the next click (and within one second), the page changed,
  // focus moved, the address changed or the page scrolled by itself.
  var pendingClicks = [], recentClicks = [], lastPointer = 'mouse', lastUserScrollInput = 0;
  var signals = { mut: [], focus: [], scroll: [], route: [], down: [] };
  function mark(list) {
    var t = perf();
    if (list.length && t - list[list.length - 1] < 40) return;
    list.push(t);
    while (list.length && t - list[0] > 6000) list.shift();
  }
  function within(list, a, b) {
    for (var i = list.length - 1; i >= 0; i--) { if (list[i] <= a) return false; if (list[i] <= b) return true; }
    return false;
  }
  on(D, 'focusin', function () { mark(signals.focus); }, true);
  on(D, 'wheel', function () { lastUserScrollInput = perf(); }, true);
  on(D, 'touchmove', function () { lastUserScrollInput = perf(); }, true);
  on(D, 'keydown', function (e) {
    if (/^(ArrowUp|ArrowDown|PageUp|PageDown|Home|End| |Spacebar)$/.test(e.key)) lastUserScrollInput = perf();
  }, true);
  on(D, 'pointerdown', function (e) { lastPointer = e.pointerType || 'mouse'; lastInput = perf(); mark(signals.down); }, true);
  function clickRec(e, aux) {
    var el = e.target;
    if (!el || el.nodeType !== 1) el = el && el.parentElement;
    if (!el) return;
    var act = actionable(el) || el;
    var key = reg(act);
    var kb = e.detail === 0 && e.clientX === 0 && e.clientY === 0 && !aux;
    var r = act.getBoundingClientRect(), rp = rectPage(act, r), p;
    if (kb) p = [R(rp[0] + rp[2] / 2), R(rp[1] + rp[3] / 2), rp[4]];
    else p = toPage(e.clientX, e.clientY, el);
    var flags = 0;
    if (act !== el || act.matches(ACT)) flags |= 4;
    else if (interactiveEl(act)) flags |= 4;
    if (kb) flags |= 8;
    if (aux || e.ctrlKey || e.metaKey || e.shiftKey) flags |= 16;
    if (lastPointer === 'touch' || lastPointer === 'pen') flags |= 64;
    var field = act.matches('input,textarea,select,label,[contenteditable=""],[contenteditable=true]') || act.isContentEditable;
    var c = {
      rec: ['c', now(), p[0], p[1], p[2], key, 0, rp[0], rp[1], rp[2], rp[3]],
      at: perf(), cx: e.clientX, cy: e.clientY, field: field, flags: flags
    };
    var t = c.at;
    recentClicks = recentClicks.filter(function (x) { return t - x.at < 1000; });
    var near = recentClicks.filter(function (x) { return Math.abs(x.cx - c.cx) < 30 && Math.abs(x.cy - c.cy) < 30; });
    recentClicks.push(c);
    if (near.length >= 2 && !kb) { c.flags |= 2; near.forEach(function (x) { x.flags |= 2; if (x.done) push(['cf', x.rec[1], x.flags]); }); }
    pendingClicks.push(c);
    later(1000, resolveClicks);
  }
  function resolveClicks(final) {
    var t = perf(), keep = [];
    for (var i = 0; i < pendingClicks.length; i++) {
      var c = pendingClicks[i];
      if (!final && t - c.at < 1000) { keep.push(c); continue; }
      var end = c.at + 1000, downs = signals.down;
      for (var j = 0; j < downs.length; j++) if (downs[j] > c.at) { end = Math.min(end, downs[j]); break; }
      var responded = c.field || within(signals.mut, c.at, end) || within(signals.focus, c.at, end) ||
        within(signals.scroll, c.at, end) || within(signals.route, c.at, end);
      if (!responded) c.flags |= final && t - c.at < 1000 ? 32 : 1;
      c.rec[6] = c.flags; c.done = true;
      push(c.rec);
    }
    pendingClicks = keep;
  }
  on(D, 'click', function (e) { clickRec(e, false); }, true);
  on(D, 'auxclick', function (e) { if (e.button === 1) clickRec(e, true); }, true);

  // keep participants on the study address when the site links to its own public address
  on(D, 'click', function (e) {
    if (!CFG.upstreamHost) return;
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    try {
      var u = new URL(a.getAttribute('href'), location.href);
      if (u.host === CFG.upstreamHost) { u.protocol = location.protocol; u.host = location.host; a.setAttribute('href', u.toString()); }
    } catch (x) { }
  }, true);

  /* ---------- typing (never the text, except search text when switched on) ---------- */
  var typing = new WeakMap();
  function isSearch(el) {
    if (el.type === 'search' || el.getAttribute('role') === 'searchbox') return true;
    var s = [el.getAttribute('placeholder'), el.getAttribute('aria-label'), el.getAttribute('name'), el.id].join(' ');
    return /search|find|look ?up/i.test(s);
  }
  function sensitive(el) { return el.tagName === 'INPUT' && /^(password|email|tel|hidden)$/i.test(el.type); }
  on(D, 'input', function (e) {
    var el = e.target;
    if (!el || !el.tagName) return;
    if (!(el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
    if (el.tagName === 'INPUT' && /^(checkbox|radio|range|file|color|date|time)$/i.test(el.type)) return;
    lastInput = perf();
    clearTimeout(typing.get(el));
    typing.set(el, later(900, function () {
      var v = el.isContentEditable ? el.textContent : el.value;
      var s = isSearch(el) && !sensitive(el);
      var rec = ['k', now(), reg(el), String(v || '').length, s ? 1 : 0];
      if (s && CFG.searchText) rec.push(clean(v, 80));
      push(rec);
    }));
  }, true);
  on(D, 'change', function (e) {
    var el = e.target;
    if (!el || !el.tagName) return;
    if (el.tagName === 'SELECT') {
      var o = el.selectedOptions && el.selectedOptions[0];
      push(['ch', now(), reg(el), o ? clean(o.textContent, 60) : '']);
    } else if (el.tagName === 'INPUT' && /^(checkbox|radio)$/i.test(el.type)) {
      push(['ch', now(), reg(el), el.checked ? 'on' : 'off']);
    } else if (el.tagName === 'INPUT' && el.type === 'range') {
      push(['ch', now(), reg(el), String(el.value).slice(0, 20)]);
    }
  }, true);
  on(D, 'submit', function (e) { if (e.target && e.target.tagName) push(['sb', now(), reg(e.target)]); }, true);
  on(D, 'copy', function () {
    var s = W.getSelection ? W.getSelection() : null, txt = s ? String(s) : '';
    var n = s && s.anchorNode ? (s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentElement) : null;
    push(['cp', now(), txt.length, n ? sectionOf(n) : '']);
  }, true);

  /* ---------- errors the participant ran into ---------- */
  var nErr = 0;
  on(W, 'error', function (e) {
    if (++nErr > 25) return;
    var t = e && e.target;
    if (t && t !== W && t.tagName) {
      push(['er', now(), 'resource', clean(String(t.currentSrc || t.src || t.href || '').split('?')[0].slice(-100), 100)]);
    } else {
      push(['er', now(), clean(e && e.message, 160), clean(String((e && e.filename) || '').split('/').pop(), 60), (e && e.lineno) || 0]);
    }
  }, true);
  on(W, 'unhandledrejection', function (e) {
    if (++nErr > 25) return;
    var r = e && e.reason;
    push(['er', now(), 'promise: ' + clean(r && (r.message || r), 150)]);
  });

  /* ---------- attention ---------- */
  on(D, 'visibilitychange', function () {
    push(['v', now(), D.hidden ? 0 : 1]);
    if (D.hidden) flush(true);
  });
  on(W, 'blur', function () { push(['w', now(), 0]); });
  on(W, 'focus', function () { push(['w', now(), 1]); });
  on(W, 'popstate', function () { push(['nb', now()]); later(0, checkRoute); });
  on(W, 'hashchange', function () { checkRoute(); });
  var resizeTimer = 0;
  on(W, 'resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = later(400, function () {
      push(['r', now(), W.innerWidth, W.innerHeight, vpW()]);
      snapState.pending = true; snapState.due = perf() + 300; snapState.hard = perf() + 2000;
    });
  });
  on(W, 'pagehide', function () { flush(true); });

  /* ---------- sending ---------- */
  var QKEY = 'tie:q:' + sid, MAX_Q = 900000;
  function devInfo() {
    var tz = '';
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { }
    var ref = '';
    try { ref = D.referrer ? new URL(D.referrer).origin : ''; } catch (e) { }
    return {
      ua: String(NAV.userAgent || '').slice(0, 300), lang: NAV.language || '', tz: tz,
      sw: (W.screen && screen.width) || 0, sh: (W.screen && screen.height) || 0, dpr: W.devicePixelRatio || 1,
      tp: NAV.maxTouchPoints || 0, vw: W.innerWidth, vh: W.innerHeight, cw: vpW(), ref: ref, tv: VERSION
    };
  }
  function flush(final) {
    resolveClicks(!!final);
    if (!buf.length) { retryQueue(); return; }
    var ev = buf; buf = [];
    var b = { v: 1, sid: sid, seq: seq++, t0: t0, sent: Date.now(), load: loadNo, ctx: { pid: ctx.pid, task: ctx.task, g: ctx.g, test: ctx.test, src: ctx.src }, ev: ev };
    if (needDev) { b.dev = devInfo(); needDev = false; }
    sput(SS, 'tie:seq', String(seq));
    send(JSON.stringify(b), !!final);
  }
  function send(body, final) {
    var url = CFG.endpoint;
    if (final && NAV.sendBeacon && body.length < 60000) {
      try { if (NAV.sendBeacon(url, new Blob([body], { type: 'text/plain' }))) { stats.sent++; return; } } catch (e) { }
    }
    if (!W.fetch) { enqueue(body); return; }
    try {
      W.fetch(url, { method: 'POST', body: body, keepalive: body.length < 60000, headers: { 'content-type': 'text/plain' }, credentials: 'omit' })
        .then(function (r) { if (r.ok) { stats.sent++; stats.lastOk = Date.now(); } else if (r.status >= 500 || r.status === 429) { stats.failed++; enqueue(body); } })
        .catch(function () { stats.failed++; enqueue(body); });
    } catch (e) { enqueue(body); }
  }
  function enqueue(body) {
    var q = jget(SS, QKEY) || [], size = body.length;
    for (var i = 0; i < q.length; i++) size += q[i].length;
    while (q.length && size > MAX_Q) size -= q.shift().length;
    if (body.length <= MAX_Q) q.push(body);
    sput(SS, QKEY, JSON.stringify(q));
  }
  var retrying = false;
  function retryQueue() {
    if (retrying || !W.fetch) return;
    var q = jget(SS, QKEY);
    if (!q || !q.length) return;
    retrying = true;
    var body = q[0];
    W.fetch(CFG.endpoint, { method: 'POST', body: body, headers: { 'content-type': 'text/plain' }, credentials: 'omit' })
      .then(function (r) {
        retrying = false;
        if (r.ok || (r.status >= 400 && r.status < 500 && r.status !== 429)) {
          var cur = jget(SS, QKEY) || [];
          if (cur.length && cur[0] === body) cur.shift();
          sput(SS, QKEY, JSON.stringify(cur));
          if (r.ok) stats.sent++;
        }
      })
      .catch(function () { retrying = false; });
  }

  /* ---------- watching the page change ---------- */
  var overlay = null;
  function startObserver() {
    if (!W.MutationObserver || !D.documentElement) return;
    observer = new MutationObserver(function (list) {
      if (overlay) {
        var all = true;
        for (var i = 0; i < list.length; i++) if (!overlay.contains(list[i].target)) { all = false; break; }
        if (all) return;
      }
      lastMut = perf(); snapState.dirty = true; mark(signals.mut);
    });
    observer.observe(D.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
  }

  /* ---------- optional on-page status for the researcher (?tie_debug=1) ---------- */
  function drawDebug() {
    if (!DEBUG || !D.body) return;
    if (!overlay) {
      overlay = D.createElement('div');
      overlay.setAttribute('aria-hidden', 'true');
      overlay.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:2147483647;pointer-events:none;font:11px/1.4 ui-monospace,Menlo,Consolas,monospace;' +
        'background:rgba(20,24,30,.86);color:#e8f0ea;padding:6px 9px;border-radius:6px;max-width:360px;white-space:pre';
      D.body.appendChild(overlay);
    }
    var age = stats.lastOk ? R((Date.now() - stats.lastOk) / 1000) + ' s ago' : 'not yet';
    overlay.textContent = 'TIE recording  ' + (ctx.pid || 'no participant') + (ctx.task ? ' · ' + ctx.task : '') + (ctx.g ? ' · ' + ctx.g : '') + (ctx.test ? ' · test' : '') +
      '\nsession ' + sid + ' · page view ' + pv + '\nevents ' + stats.ev + ' · batches sent ' + stats.sent + (stats.failed ? ' · failed ' + stats.failed : '') + '\nlast saved ' + age;
  }

  /* ---------- start ---------- */
  push(['L', now(), loadNo, ctx.src]);
  function boot() {
    checkRoute();
    startObserver();
    every(250, checkRoute);
    every(150, snapTick);
    every(CFG.flushMs || 5000, function () { flush(false); retryQueue(); });
    if (DEBUG) every(1000, drawDebug);
  }
  if (D.readyState === 'loading') on(D, 'DOMContentLoaded', boot); else boot();
  try {
    W.__TIE = Object.freeze({ v: VERSION, sid: sid, ctx: ctx, stop: stop, flush: function () { flush(false); } });
  } catch (e) { }
}

