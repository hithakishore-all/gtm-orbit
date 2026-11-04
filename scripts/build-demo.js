// Builds index.html at the repo root: the real web console + the offline snapshot, running in the
// browser with no server, so the demo can be hosted on GitHub Pages.
//   node scripts/build-demo.js
// The page intercepts /api/* calls and answers them from the same mock store and engine logic
// the Node server uses offline (orbit/lib/mock-store.js, orbit/lib/engine.js).
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const safe = (s) => s.replace(/<\/script/gi, '<\\/script');

const fixtures = JSON.parse(read('orbit/mock/fixtures.json'));
let html = read('orbit/public/index.html');
const css = read('orbit/public/styles.css');
const app = read('orbit/public/app.js');

// Same logic as mock-store.js + engine.js + server.js routes, adapted for the browser.
const shim = `
(function () {
  var FX = ${JSON.stringify(fixtures)};
  var clone = function (o) { return o === undefined ? null : JSON.parse(JSON.stringify(o)); };
  var now = function () { return new Date().toISOString().replace('T', ' ').slice(0, 23); };
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var flows = new Map(), audit = [], seen = new Set();
  var DELAY = { 'crew.identifier.done': 1100, 'crew.researcher.done': 1100, 'crew.composer.done': 1100,
    'crew.validator.failed': 700, 'crew.validator.passed': 700, 'crew.identifier.no_contact': 800 };
  var ROLE_HINTS = {
    champion: 'Director, Head of or Manager in the team that feels the problem',
    economic_buyer: 'VP Finance, CFO, Controller or the budget owner',
    technical_evaluator: 'IT Director, Enterprise Architect or Head of Engineering',
    executive_sponsor: 'VP or C-level owner of the business outcome'
  };
  var USER = 'web:ae';

  var store = {
    queue: function () { return clone(FX.queue); },
    context: function (k) { return clone(FX.contexts[k]); },
    contacts: function (k) { return clone(FX.contacts[k] || []); },
    runFlow: async function (key) {
      var run = clone(FX.runs[key]);
      if (!run) throw Object.assign(new Error('unknown account ' + key), { status: 404 });
      var flowId = 'flow_' + Math.random().toString(16).slice(2, 8);
      var ctx = FX.contexts[key];
      var pkg = Object.assign({}, run.package, { flow_id: flowId });
      var flow = { FLOW_ID: flowId, ACCOUNT_ID: ctx.SALESFORCE_ACCOUNT_ID, ACCOUNT_KEY: key, STATE: 'received', RETRIES: 0,
        DRAFT_VERSION: 0, CURRENT_DRAFT: null, PACKAGE: null, CREATED_AT: now(), UPDATED_AT: now() };
      flows.set(flowId, flow);
      var composed = 0;
      for (var i = 0; i < run.events.length; i++) {
        var ev = run.events[i];
        var wait = DELAY[ev.EVENT] || 180;
        await sleep(wait);
        if (ev.DURATION_MS === 0) ev.DURATION_MS = wait + Math.floor(Math.random() * 90);
        if (ev.EVENT === 'ae.accepted') ev.ACTOR = 'user:' + USER;
        audit.push(Object.assign({ FLOW_ID: flowId, TS: now(), ACCOUNT_ID: ctx.SALESFORCE_ACCOUNT_ID, ACCOUNT_NAME: ctx.ACCOUNT_NAME, SCORE_VERSION: ctx.SCORE_VERSION }, ev));
        if (ev.EVENT.indexOf('flow.state.') === 0) flow.STATE = ev.EVENT.slice(11);
        if (ev.EVENT === 'crew.composer.done') { composed += 1; flow.DRAFT_VERSION = composed; }
        if (ev.EVENT === 'crew.validator.failed') flow.RETRIES = ev.DETAIL.retry;
        flow.UPDATED_AT = now();
      }
      flow.PACKAGE = pkg;
      flow.CURRENT_DRAFT = pkg.draft ? pkg.draft.body : null;
      return pkg;
    },
    latestEvents: function (sfId, since) {
      var f = Array.from(flows.values()).filter(function (x) { return x.ACCOUNT_ID === sfId && x.CREATED_AT >= since; })
        .sort(function (a, b) { return a.CREATED_AT < b.CREATED_AT ? 1 : -1; })[0];
      return f ? clone(audit.filter(function (e) { return e.FLOW_ID === f.FLOW_ID; })) : [];
    },
    flow: function (id) { var f = flows.get(id); return f ? clone(f) : null; },
    recentFlows: function () {
      return Array.from(flows.values()).sort(function (a, b) { return a.CREATED_AT < b.CREATED_AT ? 1 : -1; }).slice(0, 20).map(function (f) {
        return { FLOW_ID: f.FLOW_ID, ACCOUNT_KEY: f.ACCOUNT_KEY, ACCOUNT_NAME: FX.contexts[f.ACCOUNT_KEY].ACCOUNT_NAME, STATE: f.STATE,
          RETRIES: f.RETRIES, DRAFT_VERSION: f.DRAFT_VERSION, STATUS: f.PACKAGE ? f.PACKAGE.status : null, UPDATED_AT: f.UPDATED_AT };
      });
    },
    aeAction: function (flowId, action, text, key) {
      if (seen.has(key)) return { ok: false, duplicate: true };
      seen.add(key);
      var f = flows.get(flowId);
      if (!f) return { ok: false, reason: 'unknown flow' };
      if (['approved', 'rejected'].indexOf(f.STATE) >= 0) return { ok: false, reason: 'Flow already ' + f.STATE };
      var event;
      if (action === 'edit') {
        f.DRAFT_VERSION += 1; f.CURRENT_DRAFT = text;
        f.PACKAGE.draft = Object.assign({}, f.PACKAGE.draft, { body: text, version: f.DRAFT_VERSION, edited_by: USER });
        event = 'ae.edited';
      } else if (action === 'approve') { f.STATE = 'approved'; event = 'ae.approved'; }
      else { f.STATE = 'rejected'; event = 'ae.rejected'; }
      f.UPDATED_AT = now();
      audit.push({ FLOW_ID: flowId, TS: now(), LEVEL: 'HUMAN', EVENT: event, ACTOR: 'user:' + USER, DURATION_MS: null,
        ACCOUNT_ID: f.ACCOUNT_ID, ACCOUNT_NAME: FX.contexts[f.ACCOUNT_KEY].ACCOUNT_NAME,
        DETAIL: { level: 'HUMAN', draft_version: f.DRAFT_VERSION, reason: action === 'reject' ? text : undefined,
          note: action === 'approve' ? 'Nothing is sent. Delivery is out of scope.' : undefined } });
      return { ok: true, state: f.STATE, draft_version: f.DRAFT_VERSION };
    },
    recommendationAction: function (key, action, reason) {
      var c = FX.contexts[key];
      audit.push({ FLOW_ID: null, TS: now(), LEVEL: 'HUMAN', EVENT: 'ae.recommendation.' + action, ACTOR: 'user:' + USER,
        ACCOUNT_ID: c.SALESFORCE_ACCOUNT_ID, ACCOUNT_NAME: c.ACCOUNT_NAME, DURATION_MS: null, DETAIL: { level: 'HUMAN', reason: reason } });
      return { ok: true, action: action };
    },
    trace: function (id) { return clone(audit.filter(function (e) { return e.FLOW_ID === id; })); },
    reset: function () { flows = new Map(); audit = []; seen = new Set(); }
  };

  var jobs = new Map(), running = new Map(), seq = 0;
  function startRun(key) {
    if (running.has(key)) return jobs.get(running.get(key));
    var ctx = FX.contexts[key];
    if (!ctx) throw Object.assign(new Error('unknown account ' + key), { status: 404 });
    var job = { jobId: 'job_' + (++seq) + '_' + Date.now().toString(36), key: key, sfId: ctx.SALESFORCE_ACCOUNT_ID,
      name: ctx.ACCOUNT_NAME, since: now(), status: 'running', flowId: null, error: null, startedAt: Date.now() };
    jobs.set(job.jobId, job); running.set(key, job.jobId);
    store.runFlow(key).then(function (p) { job.flowId = p.flow_id; job.status = 'done'; })
      .catch(function (e) { job.status = 'error'; job.error = e.message; })
      .finally(function () { running.delete(key); });
    return job;
  }
  function jobState(id) {
    var job = jobs.get(id); if (!job) return null;
    var events = store.latestEvents(job.sfId, job.since);
    if (!job.flowId && events[0]) job.flowId = events[0].FLOW_ID;
    return Object.assign({}, job, { events: events, flow: job.status === 'done' ? store.flow(job.flowId) : null });
  }
  function buyingGroup(key) {
    var ctx = store.context(key);
    if (!ctx) throw Object.assign(new Error('unknown account ' + key), { status: 404 });
    var rd = ctx.CONTACT_READINESS || {};
    var contacts = store.contacts(key);
    var missing = (rd.missing_roles || []).map(function (r) { return { role: r, look_for: ROLE_HINTS[r] }; });
    var blocked = contacts.filter(function (c) { return !c.permitted; }).map(function (c) {
      return Object.assign({}, c, { why: c.opted_out ? 'opted out of email' : c.incomplete ? 'record incomplete (no title or email)' : 'not permitted' });
    });
    return { account: ctx.ACCOUNT_NAME, key: key, roles_covered: rd.roles_covered, roles_total: rd.roles_total || 4,
      contacts: contacts, permitted: contacts.filter(function (c) { return c.permitted; }), blocked: blocked, missing: missing };
  }

  function route(method, p, body) {
    var m;
    if (p === '/api/health') return { ok: true, data: 'offline' };
    if (p === '/api/status') return { data: 'offline', slack: 'off', slackError: null, agents: 'scripted', port: null, account: null, demo: true };
    if (p === '/api/queue') return store.queue();
    if (p === '/api/reset' && method === 'POST') { store.reset(); return { ok: true }; }
    if (p === '/api/runs' && method === 'POST') {
      if (!body || !body.account) throw Object.assign(new Error('account is required'), { status: 400 });
      return { jobId: startRun(body.account).jobId };
    }
    if ((m = p.match(/^\\/api\\/runs\\/([^/]+)$/))) { var s = jobState(m[1]); if (!s) throw Object.assign(new Error('unknown job'), { status: 404 }); return s; }
    if (p === '/api/flows') return store.recentFlows();
    if ((m = p.match(/^\\/api\\/flows\\/([^/]+)\\/trace$/))) return store.trace(m[1]);
    if ((m = p.match(/^\\/api\\/flows\\/([^/]+)\\/actions$/)) && method === 'POST') {
      var id = m[1], b = body || {};
      if (!store.flow(id)) throw Object.assign(new Error('unknown flow'), { status: 404 });
      if (['edit', 'approve', 'reject'].indexOf(b.action) < 0) throw Object.assign(new Error('action must be edit, approve or reject'), { status: 400 });
      if (b.action === 'edit' && !String(b.text || '').trim()) throw Object.assign(new Error('text is required for edit'), { status: 400 });
      var idem = b.action === 'edit' ? id + ':edit:' + Date.now() : id + ':' + b.action;
      var r = store.aeAction(id, b.action, b.text, idem);
      return Object.assign({}, r, { flow: store.flow(id) });
    }
    if ((m = p.match(/^\\/api\\/flows\\/([^/]+)$/))) { var f = store.flow(m[1]); if (!f) throw Object.assign(new Error('unknown flow'), { status: 404 }); return f; }
    if ((m = p.match(/^\\/api\\/accounts\\/([^/]+)\\/buying-group$/))) return buyingGroup(decodeURIComponent(m[1]));
    if ((m = p.match(/^\\/api\\/accounts\\/([^/]+)\\/defer$/)) && method === 'POST') return store.recommendationAction(decodeURIComponent(m[1]), 'deferred', (body && body.reason) || 'Deferred from GTM Orbit');
    if ((m = p.match(/^\\/api\\/accounts\\/([^/]+)$/))) { var c = store.context(decodeURIComponent(m[1])); if (!c) throw Object.assign(new Error('not found'), { status: 404 }); return c; }
    throw Object.assign(new Error('not found'), { status: 404 });
  }

  var realFetch = window.fetch.bind(window);
  window.fetch = function (input, opts) {
    var url = typeof input === 'string' ? input : input.url;
    var p = new URL(url, location.href).pathname.replace(/^.*?(\\/api\\/)/, '/api/');
    if (p.indexOf('/api/') !== 0) return realFetch(input, opts);
    opts = opts || {};
    var method = (opts.method || 'GET').toUpperCase();
    var body = null;
    try { body = opts.body ? JSON.parse(opts.body) : null; } catch (e) { body = null; }
    var status = 200, out;
    try { out = route(method, p, body); } catch (e) { status = e.status || 500; out = { error: e.message }; }
    return Promise.resolve(new Response(JSON.stringify(out), { status: status, headers: { 'Content-Type': 'application/json' } }));
  };
})();
`;

html = html
  .replace('<link rel="stylesheet" href="styles.css">', '<style>\n' + css + '\n</style>')
  .replace('href="/" aria-label="GTM Orbit home"', 'href="./" aria-label="GTM Orbit home"')
  .replace('<script src="app.js"></script>', '<script>' + safe(shim) + '</script>\n<script>' + safe(app) + '</script>')
  .replace('<title>GTM Orbit</title>', '<title>GTM Orbit · Live demo</title>');

fs.writeFileSync(path.join(root, 'index.html'), html);
console.log('wrote index.html (' + Math.round(html.length / 1024) + ' KB)');
