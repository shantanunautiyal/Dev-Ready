/**
 * Platform tests: the processing pipeline and the integrations added for
 * multi-project workspaces.
 *
 *  • vector illustration detection (and the frames that must stay UI)
 *  • complexity assessment and the limits it reports
 *  • job cancellation
 *  • the GitHub adapter: auth, conflicts, unsafe input, rate limits, network loss
 *  • local project/revision storage
 *  • the tabbed workspace: progressive disclosure, GitHub connect, history diffs
 */
'use strict';
const { createBuilders, loadEngine } = require('./harness');
const { loadPanel } = require('./unit-ui');

const hex = h => ({ r: parseInt(h.slice(1, 3), 16) / 255, g: parseInt(h.slice(3, 5), 16) / 255, b: parseInt(h.slice(5, 7), 16) / 255 });

/* ---------------- a scriptable GitHub ---------------- */
function respond(status, body, headers) {
  const h = headers || {};
  return {
    ok: status >= 200 && status < 300,
    status: status,
    headers: { get: k => (h[k] === undefined ? null : h[k]) },
    text: async () => (body === undefined ? '' : JSON.stringify(body))
  };
}
/**
 * routes: [{ path: /regex/, reply: {status, body, headers} | fn(init) }]
 * Records every call so a test can assert what was sent and what was not.
 */
function mockGitHub(routes) {
  const calls = [];
  const fn = async (url, init) => {
    const path = String(url).replace('https://api.github.com', '');
    const call = { url: String(url), path: path, init: init || {} };
    calls.push(call);
    for (const r of routes) {
      if (r.path.test(path)) {
        const res = typeof r.reply === 'function' ? r.reply(init || {}, path) : r.reply;
        return respond(res.status === undefined ? 200 : res.status, res.body, res.headers);
      }
    }
    return respond(404, { message: 'Not Found' });
  };
  fn.calls = calls;
  fn.to = re => calls.filter(c => re.test(c.path));
  return fn;
}
const GH_USER = { status: 200, body: { login: 'octocat', name: 'The Octocat', avatar_url: 'https://x/y.png' }, headers: { 'x-oauth-scopes': 'contents:write' } };

function ghEngine(fetchImpl, opts) {
  const B = createBuilders();
  const eng = loadEngine(B, Object.assign({ mode: 'inspect', editorType: 'dev', fetch: fetchImpl }, opts || {}));
  return { B, eng };
}
async function ghConnect(eng, token) {
  await eng.send({ type: 'gh-connect', token: token || 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' });
  return eng.posted.filter(m => m.type === 'gh-status').pop();
}

/* ---------------- vector artwork builders ---------------- */
function artwork(B, name, opts) {
  opts = opts || {};
  const kids = [];
  const n = opts.vectors || 5;
  for (let i = 0; i < n; i++) {
    kids.push(B.N({ type: 'VECTOR', name: 'path ' + i, width: 10, height: 10, fills: [{ type: 'SOLID', visible: true, color: hex('#222222') }] }));
  }
  const frame = B.N(Object.assign({ type: 'FRAME', name: name, width: opts.w || 320, height: opts.h || 240, layoutMode: 'NONE', fills: [] }, opts.extra || {}), kids);
  frame.parent = { type: 'PAGE' };
  return frame;
}

module.exports = async function platformTests(record) {
  /* ================= illustrations ================= */
  console.log('\nillustrations' + ' — artwork becomes one SVG asset, UI stays code');
  {
    const B = createBuilders();
    const eng = loadEngine(B);
    const cases = [
      ['named illustration', artwork(B, 'Hero illustration'), true, 'name'],
      ['logo artwork', artwork(B, 'Brand logo'), true, 'name'],
      ['artwork with an explicit SVG export', artwork(B, 'Blob', { extra: { exportSettings: [{ format: 'SVG' }] } }), true, 'svg-export'],
      ['complex unnamed artwork', artwork(B, 'Group 12', { vectors: 16, w: 400, h: 400 }), true, 'complexity'],
      ['complex artwork in "named" mode is left alone', artwork(B, 'Group 13', { vectors: 16, w: 400, h: 400 }), false, null, 'named'],
      ['off mode disables detection', artwork(B, 'Hero illustration'), false, null, 'off'],
      ['UI name wins over vector content', artwork(B, 'Icon button'), false],
      ['single shape is not an illustration', artwork(B, 'Logo', { vectors: 1 }), false]
    ];
    const errs = [];
    for (const [name, node, expected, reason, mode] of cases) {
      const plan = eng.ctx.illustrationPlan(node, mode || 'auto');
      if (!!plan !== expected) errs.push(name + ': expected ' + expected + ', got ' + JSON.stringify(plan));
      else if (plan && reason && plan.reason !== reason) errs.push(name + ': reason ' + plan.reason + ' (expected ' + reason + ')');
    }
    record('illustrations', 'illustrations are detected by name, SVG export or vector complexity — and only then', errs, cases.length + ' cases');
  }
  {
    const B = createBuilders();
    const eng = loadEngine(B);
    const errs = [];
    // Text inside → UI
    const withText = B.N({ type: 'FRAME', name: 'Illustration card', width: 320, height: 200, layoutMode: 'VERTICAL', fills: [] },
      [B.N({ type: 'VECTOR', name: 'p1', width: 10, height: 10 }), B.N({ type: 'VECTOR', name: 'p2', width: 10, height: 10 }), B.T('Caption')]);
    if (eng.ctx.illustrationPlan(withText)) errs.push('a frame with text was classified as artwork');
    // Instance inside → UI
    const main = B.COMPONENT('Badge');
    const withInst = B.N({ type: 'FRAME', name: 'Hero illustration', width: 300, height: 300, fills: [] },
      [B.N({ type: 'VECTOR', name: 'p1', width: 10, height: 10 }), B.INST(main, {}, 'HORIZONTAL', {})]);
    if (eng.ctx.illustrationPlan(withInst)) errs.push('a frame with an instance was classified as artwork');
    // Image fill inside → raster, not vector
    const withImage = B.N({ type: 'FRAME', name: 'Hero illustration', width: 300, height: 300, fills: [] },
      [B.N({ type: 'VECTOR', name: 'p1', width: 10, height: 10 }), B.N({ type: 'RECTANGLE', name: 'photo', width: 40, height: 40, fills: [{ type: 'IMAGE', visible: true }] })]);
    if (eng.ctx.illustrationPlan(withImage)) errs.push('a frame with raster content was classified as artwork');
    // Zero-size
    if (eng.ctx.illustrationPlan(B.N({ type: 'FRAME', name: 'Logo', width: 0, height: 0, fills: [] }, []))) errs.push('a zero-size frame was classified as artwork');
    record('illustrations', 'text, instances, raster content and zero-size frames never become SVG artwork', errs);
  }
  {
    // End to end: the illustration is one asset and its inner paths are not markup.
    const B = createBuilders();
    const art = artwork(B, 'Hero illustration', { vectors: 6 });
    const card = B.AL('Card', 'VERTICAL', { padding: '16px', gap: '12px' }, [B.T('Welcome'), art], { width: 400, height: 500 });
    card.parent = { type: 'PAGE' };
    const eng = loadEngine(B);
    const out = await eng.generateCode(card, 'html-css', 'px', 16, 600, {});
    const html = out.files.map(f => f.code).join('\n');
    const errs = [];
    const svgs = out.assets.filter(a => a.format === 'SVG' && a.illustration);
    if (svgs.length !== 1) errs.push('expected exactly one illustration asset, got ' + JSON.stringify(out.assets.map(a => [a.file, a.illustration])));
    if (!/assets\/hero-illustration\.svg/.test(html)) errs.push('the illustration is not referenced as a file: ' + html.split('\n').filter(l => /img/.test(l)).join(' | '));
    if ((html.match(/<img/g) || []).length !== 1) errs.push('illustration produced ' + (html.match(/<img/g) || []).length + ' <img> tags');
    if (!/alt="Hero illustration"/.test(html)) errs.push('the illustration has no alt text');
    if (!/Welcome/.test(html)) errs.push('the UI text around the artwork was dropped');
    if (/hero-illustration__/.test(html)) errs.push('the artwork inner layers were still converted to markup');
    // The note explains what happened, without hiding it.
    const single = await eng.generateCode(card, 'html-single', 'px', 16, 600, {});
    const singleHtml = single.files[0].code;
    if (!/<svg class="/.test(singleHtml)) errs.push('single-file output does not inline the illustration');
    if (/vector illustration/.test(singleHtml) === false) errs.push('the export note does not mention illustrations');
    // 'off' restores the previous behaviour exactly.
    const off = await eng.generateCode(card, 'html-css', 'px', 16, 600, { svgFrames: 'off' });
    if (off.assets.some(a => a.illustration)) errs.push('svgFrames: off still exported artwork');
    record('illustrations', 'one SVG asset, alt text, no inner markup — and "off" restores element-by-element output', errs);
  }

  /* ================= complexity ================= */
  console.log('\ncomplexity' + ' — cost is estimated before anything is generated');
  {
    const B = createBuilders();
    const eng = loadEngine(B);
    const kids = [];
    for (let i = 0; i < 20; i++) kids.push(B.AL('Row ' + i, 'HORIZONTAL', {}, [B.T('Label'), B.IMG('Photo', 40, 40)]));
    const frame = B.AL('Feed', 'VERTICAL', {}, kids);
    frame.parent = { type: 'PAGE' };
    const cx = eng.ctx.assessComplexity(frame);
    const errs = [];
    if (cx.nodes !== 61) errs.push('node count ' + cx.nodes + ' (expected 61)');
    if (cx.text !== 20) errs.push('text count ' + cx.text);
    if (cx.images !== 20) errs.push('image count ' + cx.images);
    if (cx.depth !== 2) errs.push('depth ' + cx.depth + ' (expected 2)');
    if (!(cx.estimatedMs > 0)) errs.push('no time estimate');
    if (cx.level !== 'small') errs.push('level ' + cx.level);
    if (cx.warnings.length) errs.push('unexpected warning: ' + cx.warnings[0]);
    // A pathological tree is clipped, not walked forever.
    const wide = B.AL('Wide', 'VERTICAL', {}, Array.from({ length: 2100 }, (_, i) => B.AL('R' + i, 'HORIZONTAL', {}, [B.T('a'), B.T('b'), B.T('c')])));
    wide.parent = { type: 'PAGE' };
    const big = eng.ctx.assessComplexity(wide);
    if (!big.clipped) errs.push('a 8000-layer tree was not clipped');
    if (big.nodes > 6100) errs.push('walked past the limit: ' + big.nodes);
    if (!big.warnings.some(w => /6,000|6000/.test(w))) errs.push('no warning about the cap');
    if (!big.warnings.some(w => /truncated/.test(w))) errs.push('no warning about generation truncation');
    record('complexity', 'counts, depth, cost estimate and hard caps with warnings', errs, 'small: ' + cx.nodes + ' nodes · clipped tree: ' + big.nodes);
  }
  {
    // The inspect payload carries complexity and the limits, so the panel never guesses.
    const B = createBuilders();
    const frame = B.AL('Card', 'VERTICAL', {}, [B.T('Title')]);
    frame.parent = { type: 'PAGE' };
    const eng = loadEngine(B, { mode: 'inspect', editorType: 'dev', selection: [frame] });
    await eng.send({ type: 'settings', settings: { gate: 'off' } });
    await eng.send({ type: 'ui-ready' });
    await new Promise(r => setTimeout(r, 260));
    const state = eng.posted.filter(m => m.type === 'state').pop();
    const errs = [];
    if (!state || !state.complexity) errs.push('no complexity in the inspect state');
    else if (state.complexity.nodes !== 2) errs.push('complexity nodes ' + state.complexity.nodes);
    if (!state || !state.limits || !state.limits.run) errs.push('limits.run missing');
    // The plan message answers for the whole selection.
    await eng.send({ type: 'plan' });
    const plan = eng.posted.filter(m => m.type === 'plan').pop();
    if (!plan) errs.push('no plan response');
    else if (!plan.nodes || plan.nodes[0].id !== frame.id) errs.push('plan did not describe the selection');
    record('complexity', 'complexity and limits travel with the inspect state; the plan message answers first', errs);
  }

  /* ================= cancellation ================= */
  console.log('\njobs' + ' — long runs can be cancelled without leaving the panel spinning');
  {
    const B = createBuilders();
    const kids = [];
    for (let i = 0; i < 400; i++) kids.push(B.AL('Row ' + i, 'HORIZONTAL', {}, [B.T('Cell ' + i), B.T('Value ' + i)]));
    const root = B.AL('Feed', 'VERTICAL', {}, kids);
    root.parent = { type: 'PAGE' };
    const eng = loadEngine(B, { mode: 'inspect', editorType: 'dev', selection: [root] });
    const errs = [];
    const p1 = eng.send({ type: 'gen-code', lang: 'html-css', requestId: 1, jobId: 4242 });
    const p2 = eng.send({ type: 'cancel', jobId: 4242 });
    await Promise.all([p1, p2]);
    const res = eng.posted.filter(m => m.type === 'code').pop();
    if (!res) errs.push('a cancelled job produced no answer');
    else {
      if (!res.cancelled) errs.push('the answer is not marked cancelled');
      if (res.out && res.out.files && res.out.files.length) errs.push('a cancelled job still returned files');
    }
    // Cancelling something that is not running is harmless.
    await eng.send({ type: 'cancel', jobId: 999999 });
    if (eng.notifyLog.some(n => n.error)) errs.push('cancelling an unknown job raised an error');
    // A normal run afterwards still works.
    await eng.send({ type: 'gen-code', lang: 'html-css', requestId: 2, jobId: 4243 });
    const ok = eng.posted.filter(m => m.type === 'code').pop();
    if (!ok || !ok.out || !ok.out.files.length) errs.push('a run after a cancel returned nothing');
    record('jobs', 'a running job can be cancelled, answers immediately, and the next run is unaffected', errs);
  }

  /* ================= GitHub ================= */
  console.log('\ngithub' + ' — optional publishing with explicit failure handling');
  const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
  {
    const { eng } = ghEngine(mockGitHub([]));
    await eng.send({ type: 'gh-status' });
    const st = eng.posted.filter(m => m.type === 'gh-status').pop();
    const errs = [];
    if (!st || st.status.connected) errs.push('unconnected status wrong');
    await eng.send({ type: 'gh-commit', repo: 'octo/repo', branch: 'main', message: 'x', files: [{ path: 'a.txt', content: 'a' }] });
    const res = eng.posted.filter(m => m.type === 'gh-committed').pop();
    if (!res || res.ok) errs.push('commit without a token should fail');
    else if (!res.error || res.error.code !== 'not-connected') errs.push('wrong error: ' + JSON.stringify(res.error));
    record('github', 'unconnected: status is offline-safe and writes are refused with a clear code', errs);
  }
  {
    const fetchImpl = mockGitHub([{ path: /^\/user$/, reply: GH_USER }]);
    const { eng } = ghEngine(fetchImpl);
    const errs = [];
    const st = await ghConnect(eng, TOKEN);
    if (!st || !st.status.connected) errs.push('connect failed: ' + JSON.stringify(st && st.status));
    else if (st.status.login !== 'octocat') errs.push('login not reported');
    // The token is used as a header and never posted to the panel.
    const call = fetchImpl.to(/^\/user$/)[0];
    if (!call || call.init.headers.Authorization !== 'Bearer ' + TOKEN) errs.push('Authorization header missing');
    if (JSON.stringify(eng.posted).indexOf(TOKEN) > -1) errs.push('the token appears in a panel message');
    if (JSON.stringify(eng.notifyLog).indexOf(TOKEN) > -1) errs.push('the token appears in a toast');
    const stored = await eng.figma.clientStorage.getAsync('devready-github-token');
    if (stored !== TOKEN) errs.push('the token was not kept in clientStorage');
    // Disconnect deletes it.
    await eng.send({ type: 'gh-disconnect' });
    if (await eng.figma.clientStorage.getAsync('devready-github-token')) errs.push('disconnect left the token behind');
    const off = eng.posted.filter(m => m.type === 'gh-status').pop();
    if (!off || off.status.connected) errs.push('disconnect did not report the new state');
    record('github', 'connect validates the token, keeps it out of the panel, and disconnect removes it', errs);
  }
  {
    const fetchImpl = mockGitHub([{ path: /^\/user$/, reply: { status: 401, body: { message: 'Bad credentials' } } }]);
    const { eng } = ghEngine(fetchImpl);
    const st = await ghConnect(eng);
    const errs = [];
    if (!st || st.status.connected) errs.push('a rejected token was accepted');
    else if (!st.status.error || st.status.error.code !== 'auth') errs.push('wrong error code: ' + JSON.stringify(st.status.error));
    if (await eng.figma.clientStorage.getAsync('devready-github-token')) errs.push('a rejected token was kept');
    record('github', 'a rejected token leaves the app disconnected and stores nothing', errs);
  }
  {
    // Rate limit, permission and network failures are distinct and actionable.
    const cases = [
      ['rate limit', { status: 403, body: { message: 'API rate limit exceeded' }, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1900000000' } }, 'rate-limit'],
      ['missing permission', { status: 403, body: { message: 'Resource not accessible by personal access token' } }, 'permission'],
      ['not found', { status: 404, body: { message: 'Not Found' } }, 'not-found']
    ];
    const errs = [];
    for (const [name, reply, code] of cases) {
      const fetchImpl = mockGitHub([{ path: /^\/user$/, reply: GH_USER }, { path: /^\/user\/repos/, reply: reply }]);
      const { eng } = ghEngine(fetchImpl);
      await ghConnect(eng);
      await eng.send({ type: 'gh-repos' });
      const res = eng.posted.filter(m => m.type === 'gh-repos').pop();
      if (!res || res.ok) errs.push(name + ' was reported as success');
      else if (!res.error || res.error.code !== code) errs.push(name + ': got ' + JSON.stringify(res.error));
      else if (!res.error.message) errs.push(name + ': no message');
    }
    const offlineFetch = mockGitHub([{ path: /^\/user$/, reply: GH_USER }, { path: /^\/user\/repos/, reply: () => { throw new Error('offline'); } }]);
    const offline = ghEngine(offlineFetch);
    await ghConnect(offline.eng);
    await offline.eng.send({ type: 'gh-repos' });
    const offRes = offline.eng.posted.filter(m => m.type === 'gh-repos').pop();
    if (!offRes || !offRes.error || offRes.error.code !== 'network') errs.push('a network failure was not reported as such: ' + JSON.stringify(offRes && offRes.error));
    // A transient server error on a read is retried exactly once; writes never are.
    const flakyFetch = mockGitHub([{ path: /^\/user$/, reply: GH_USER }, { path: /^\/user\/repos/, reply: { status: 503, body: { message: 'Service Unavailable' } } }]);
    const flaky = ghEngine(flakyFetch);
    await ghConnect(flaky.eng);
    await flaky.eng.send({ type: 'gh-repos' });
    const flakyRes = flaky.eng.posted.filter(m => m.type === 'gh-repos').pop();
    if (!flakyRes || flakyRes.ok) errs.push('a 503 was reported as success');
    else if (flakyRes.error.code !== 'unavailable') errs.push('503 code: ' + JSON.stringify(flakyRes.error));
    if (flakyFetch.to(/^\/user\/repos/).length !== 2) errs.push('a transient read should be retried exactly once, got ' + flakyFetch.to(/^\/user\/repos/).length + ' calls');
    record('github', 'rate limits, permissions, 404s and network loss each map to a distinct actionable error', errs, cases.length + ' failure kinds');
  }
  {
    // Happy path commit, with the exact calls GitHub needs.
    let treeBody = null, refBody = null;
    const fetchImpl = mockGitHub([
      { path: /^\/user$/, reply: GH_USER },
      { path: /^\/repos\/octo\/repo\/git\/ref\/heads\/main$/, reply: { status: 200, body: { object: { sha: 'base1111' } } } },
      { path: /^\/repos\/octo\/repo\/git\/commits\/base1111$/, reply: { status: 200, body: { tree: { sha: 'tree0000' } } } },
      { path: /^\/repos\/octo\/repo\/git\/blobs$/, reply: { status: 201, body: { sha: 'blob0001' } } },
      { path: /^\/repos\/octo\/repo\/git\/trees$/, reply: (init) => { treeBody = JSON.parse(init.body); return { status: 201, body: { sha: 'tree1111' } }; } },
      { path: /^\/repos\/octo\/repo\/git\/commits$/, reply: { status: 201, body: { sha: 'commit01' } } },
      { path: /^\/repos\/octo\/repo\/git\/refs\/heads\/main$/, reply: (init) => { refBody = JSON.parse(init.body); return { status: 200, body: { object: { sha: 'commit01' } } }; } }
    ]);
    const { eng } = ghEngine(fetchImpl);
    await ghConnect(eng);
    await eng.send({ type: 'gh-commit', repo: 'octo/repo', branch: 'main', message: 'Add Button.tsx', files: [{ path: 'src/Button.tsx', content: 'export const x = 1;' }, { path: 'styles.css', content: 'body{}' }] });
    const res = eng.posted.filter(m => m.type === 'gh-committed').pop();
    const errs = [];
    if (!res || !res.ok) errs.push('commit failed: ' + JSON.stringify(res && res.error));
    else {
      if (res.result.files !== 2) errs.push('wrong file count');
      if (!/^https:\/\/github\.com\/octo\/repo\/commit\//.test(res.result.url || '')) errs.push('no commit url');
    }
    if (!treeBody || treeBody.tree.length !== 2) errs.push('tree payload wrong: ' + JSON.stringify(treeBody));
    else if (treeBody.base_tree !== 'tree0000') errs.push('tree is not based on the parent commit');
    if (!refBody || refBody.force !== false) errs.push('the ref update must not force-push');
    if (fetchImpl.calls.some(c => c.init.body && c.init.body.indexOf('ghp_') > -1)) errs.push('the token appears in a request body');
    record('github', 'a commit creates blobs, a tree on the parent, a commit and a non-forced ref update', errs);
  }
  {
    // Conflicts: the branch moved under us, before or after we started.
    const errs = [];
    const moved = mockGitHub([
      { path: /^\/user$/, reply: GH_USER },
      { path: /^\/repos\/octo\/repo\/git\/ref\/heads\/main$/, reply: { status: 200, body: { object: { sha: 'bbbbbbb' } } } }
    ]);
    const a = ghEngine(moved);
    await ghConnect(a.eng);
    await a.eng.send({ type: 'gh-commit', repo: 'octo/repo', branch: 'main', message: 'x', baseSha: 'aaaaaaa', files: [{ path: 'a.txt', content: 'a' }] });
    const res1 = a.eng.posted.filter(m => m.type === 'gh-committed').pop();
    if (!res1 || res1.ok) errs.push('a stale base sha was committed anyway');
    else if (res1.error.code !== 'conflict') errs.push('stale base: ' + JSON.stringify(res1.error));
    if (moved.to(/git\/blobs/).length) errs.push('blobs were written before the conflict was detected');

    const rejected = mockGitHub([
      { path: /^\/user$/, reply: GH_USER },
      { path: /^\/repos\/octo\/repo\/git\/ref\/heads\/main$/, reply: { status: 200, body: { object: { sha: 'base1111' } } } },
      { path: /^\/repos\/octo\/repo\/git\/commits\/base1111$/, reply: { status: 200, body: { tree: { sha: 'tree0000' } } } },
      { path: /^\/repos\/octo\/repo\/git\/blobs$/, reply: { status: 201, body: { sha: 'blob0001' } } },
      { path: /^\/repos\/octo\/repo\/git\/trees$/, reply: { status: 201, body: { sha: 'tree1111' } } },
      { path: /^\/repos\/octo\/repo\/git\/commits$/, reply: { status: 201, body: { sha: 'commit01' } } },
      { path: /^\/repos\/octo\/repo\/git\/refs\/heads\/main$/, reply: { status: 422, body: { message: 'Update is not a fast forward' } } }
    ]);
    const b = ghEngine(rejected);
    await ghConnect(b.eng);
    await b.eng.send({ type: 'gh-commit', repo: 'octo/repo', branch: 'main', message: 'x', files: [{ path: 'a.txt', content: 'a' }] });
    const res2 = b.eng.posted.filter(m => m.type === 'gh-committed').pop();
    if (!res2 || res2.ok) errs.push('a rejected ref update was reported as success');
    else if (res2.error.code !== 'conflict') errs.push('rejected push: ' + JSON.stringify(res2.error));
    record('github', 'a moved branch is detected before writing, and a rejected push is never reported as success', errs);
  }
  {
    // Hostile input never reaches the network.
    const fetchImpl = mockGitHub([{ path: /^\/user$/, reply: GH_USER }]);
    const { eng } = ghEngine(fetchImpl);
    await ghConnect(eng);
    const before = fetchImpl.calls.length;
    const bad = [
      ['path traversal', { repo: 'octo/repo', branch: 'main', message: 'x', files: [{ path: '../../etc/passwd', content: 'x' }] }],
      ['absolute path', { repo: 'octo/repo', branch: 'main', message: 'x', files: [{ path: '/etc/passwd', content: 'x' }] }],
      ['git directory', { repo: 'octo/repo', branch: 'main', message: 'x', files: [{ path: '.git/config', content: 'x' }] }],
      ['bad repo', { repo: '../../evil', branch: 'main', message: 'x', files: [{ path: 'a.txt', content: 'x' }] }],
      ['bad branch', { repo: 'octo/repo', branch: 'ma in;rm', message: 'x', files: [{ path: 'a.txt', content: 'x' }] }],
      ['no files', { repo: 'octo/repo', branch: 'main', message: 'x', files: [] }]
    ];
    const errs = [];
    for (const [name, msg] of bad) {
      await eng.send(Object.assign({ type: 'gh-commit' }, msg));
      const res = eng.posted.filter(m => m.type === 'gh-committed').pop();
      if (!res || res.ok) errs.push(name + ' was accepted');
      else if (!res.error || !res.error.code) errs.push(name + ' has no error code');
    }
    // The validator rejects them before the adapter is even called.
    if (fetchImpl.calls.length !== before) errs.push('a rejected commit still reached the network (' + (fetchImpl.calls.length - before) + ' calls)');
    record('github', 'unsafe paths, repo names, branches and empty file sets are refused before any request', errs, bad.length + ' vectors');
  }

  {
    // Preview: exact added / modified / unchanged / deleted, and no empty commits.
    const localA = 'export const a = 1;\n';
    const localB = 'export const b = 2;\n';
    const state = {};
    const fetchImpl = mockGitHub([
      { path: /^\/user$/, reply: GH_USER },
      { path: /^\/repos\/octo\/repo\/git\/ref\/heads\/main$/, reply: { status: 200, body: { object: { sha: 'head111' } } } },
      {
        path: /^\/repos\/octo\/repo\/git\/trees\/main/,
        reply: () => ({
          status: 200,
          body: {
            truncated: false,
            tree: [
              { path: 'src/a.ts', type: 'blob', sha: state.eng.ctx.gitBlobSha(localA), size: localA.length },
              { path: 'src/old.ts', type: 'blob', sha: 'a'.repeat(40), size: 10 }
            ]
          }
        })
      }
    ]);
    const { eng } = ghEngine(fetchImpl);
    state.eng = eng;
    await ghConnect(eng);
    // The panel sends local files; the plugin compares hashes.
    await eng.send({ type: 'gh-tree', repo: 'octo/repo', branch: 'main', files: [{ path: 'src/a.ts', content: localA }, { path: 'src/b.ts', content: localB }] });
    const tree = eng.posted.filter(m => m.type === 'gh-tree').pop();
    const errs = [];
    if (!tree || !tree.ok) errs.push('preview failed: ' + JSON.stringify(tree && tree.error));
    else {
      if (tree.headSha !== 'head111') errs.push('no head sha for the stale-base check: ' + JSON.stringify(tree.headSha));
      const byPath = {};
      (tree.local || []).forEach(f => { byPath[f.path] = f.status; });
      if (byPath['src/a.ts'] !== 'unchanged') errs.push('identical content is not unchanged: ' + byPath['src/a.ts']);
      if (byPath['src/b.ts'] !== 'added') errs.push('a new file is not added: ' + byPath['src/b.ts']);
      const del = (tree.deleted || []).map(d => d.path).join(',');
      if (del !== 'src/old.ts') errs.push('deletions: ' + del);
    }
    // A file whose content differs is "modified".
    await eng.send({ type: 'gh-tree', repo: 'octo/repo', branch: 'main', files: [{ path: 'src/a.ts', content: 'something else' }] });
    const tree2 = eng.posted.filter(m => m.type === 'gh-tree').pop();
    const a2 = (tree2.local || []).filter(f => f.path === 'src/a.ts')[0];
    if (!a2 || a2.status !== 'modified') errs.push('changed content is not modified: ' + JSON.stringify(a2));
    record('github', 'the preview compares git blob hashes: added, modified, unchanged and deleted', errs);
  }
  {
    // Empty repository, a delete entry, and the identical-tree refusal.
    const errs = [];
    const fetchImpl = mockGitHub([
      { path: /^\/user$/, reply: GH_USER },
      { path: /^\/repos\/octo\/repo\/git\/ref\/heads\/main$/, reply: { status: 404, body: { message: 'Not Found' } } },
      { path: /^\/repos\/octo\/repo\/git\/trees\/main/, reply: { status: 404, body: { message: 'Not Found' } } },
      { path: /^\/repos\/octo\/repo$/, reply: { status: 200, body: { default_branch: 'main' } } }
    ]);
    const a = ghEngine(fetchImpl);
    await ghConnect(a.eng);
    await a.eng.send({ type: 'gh-tree', repo: 'octo/repo', branch: 'main', files: [{ path: 'a.txt', content: 'a' }] });
    const t = a.eng.posted.filter(m => m.type === 'gh-tree').pop();
    if (!t || !t.ok) errs.push('an empty repository was reported as an error');
    else if (!t.empty) errs.push('the empty flag is missing');
    else if (!t.local || t.local[0].status !== 'added') errs.push('a file in an empty repo is not added');

    // Delete: a null sha, and no blob written for it.
    let treeBody = null;
    const delFetch = mockGitHub([
      { path: /^\/user$/, reply: GH_USER },
      { path: /^\/repos\/octo\/repo\/git\/ref\/heads\/main$/, reply: { status: 200, body: { object: { sha: 'head111' } } } },
      { path: /^\/repos\/octo\/repo\/git\/commits\/head111$/, reply: { status: 200, body: { tree: { sha: 'tree0000' } } } },
      { path: /^\/repos\/octo\/repo\/git\/blobs$/, reply: { status: 201, body: { sha: 'blob0001' } } },
      { path: /^\/repos\/octo\/repo\/git\/trees$/, reply: init => { treeBody = JSON.parse(init.body); return { status: 201, body: { sha: 'tree1111' } }; } },
      { path: /^\/repos\/octo\/repo\/git\/commits$/, reply: { status: 201, body: { sha: 'commit01' } } },
      { path: /^\/repos\/octo\/repo\/git\/refs\/heads\/main$/, reply: { status: 200, body: {} } }
    ]);
    const b = ghEngine(delFetch);
    await ghConnect(b.eng);
    await b.eng.send({ type: 'gh-commit', repo: 'octo/repo', branch: 'main', message: 'Remove', files: [{ path: 'old.ts', content: '', del: true }, { path: 'new.ts', content: 'x' }] });
    const pushed = b.eng.posted.filter(m => m.type === 'gh-committed').pop();
    if (!pushed || !pushed.ok) errs.push('a delete commit failed: ' + JSON.stringify(pushed && pushed.error));
    const removed = treeBody && treeBody.tree.filter(e => e.path === 'old.ts')[0];
    if (!removed || removed.sha !== null) errs.push('the delete entry is not sha:null: ' + JSON.stringify(removed));
    if (delFetch.to(/git\/blobs/).length !== 1) errs.push('a blob was written for a deleted file');

    // Identical tree → refused, and no commit is created.
    let commits = 0;
    const sameFetch = mockGitHub([
      { path: /^\/user$/, reply: GH_USER },
      { path: /^\/repos\/octo\/repo\/git\/ref\/heads\/main$/, reply: { status: 200, body: { object: { sha: 'head111' } } } },
      { path: /^\/repos\/octo\/repo\/git\/commits\/head111$/, reply: { status: 200, body: { tree: { sha: 'tree0000' } } } },
      { path: /^\/repos\/octo\/repo\/git\/blobs$/, reply: { status: 201, body: { sha: 'blob0001' } } },
      { path: /^\/repos\/octo\/repo\/git\/trees$/, reply: { status: 201, body: { sha: 'tree0000' } } },
      { path: /^\/repos\/octo\/repo\/git\/commits$/, reply: () => { commits++; return { status: 201, body: { sha: 'x' } }; } }
    ]);
    const c = ghEngine(sameFetch);
    await ghConnect(c.eng);
    await c.eng.send({ type: 'gh-commit', repo: 'octo/repo', branch: 'main', message: 'x', files: [{ path: 'a.txt', content: 'same' }] });
    const none = c.eng.posted.filter(m => m.type === 'gh-committed').pop();
    if (!none || none.ok) errs.push('an empty commit was created');
    else if (none.error.code !== 'no-changes') errs.push('wrong code: ' + JSON.stringify(none.error));
    if (commits) errs.push('a commit request was sent for an unchanged tree');
    record('github', 'empty repositories, deletions and identical trees are handled without writing', errs);
  }

  {
    // The GitHub tab: preview statuses, deletions and what a push actually sends.
    const P = loadPanel();
    const S = P.get('S');
    S.data = { mode: 'inspect', spec: { id: '1:1', name: 'Card' }, assets: [], settings: {} };
    S.lastCode = { lang: 'html-css', nodeId: '1:1', nodeName: 'Card', at: Date.now(), truncated: false, assetErrors: [],
      files: [{ name: 'a.html', size: 6, code: '<h1>a' }, { name: 'b.css', size: 5, code: 'h1{}' }] };
    S.hist = { list: [], open: null, cmp: null };
    S.gh = {
      status: { connected: true, login: 'octocat' }, repos: [], reposAll: false, q: '', repo: 'octo/repo', branches: [{ name: 'main' }], branch: 'main',
      tree: { repo: 'octo/repo', branch: 'main', headSha: 'head111', files: [{ path: 'a.html' }, { path: 'old.html' }],
        local: [{ path: 'a.html', status: 'unchanged' }, { path: 'b.css', status: 'added' }], deleted: [{ path: 'old.html' }], truncated: false },
      files: {}, msg: 'Update', busy: '', error: null, result: null
    };
    P.get('setTab')('github');
    const main = () => P.$('main').innerHTML;
    const errs = [];
    if (!/unchanged/.test(main())) errs.push('unchanged files are not labelled');
    if (!/will add/.test(main())) errs.push('new files are not labelled');
    if (!/delete/.test(main())) errs.push('deleted files are not offered');
    if (!/3 of 3 selected/.test(main())) errs.push('selection count is wrong: ' + (main().match(/\d+ of \d+ selected/) || ['none'])[0]);
    // Push skips unchanged rows and sends the delete as a removal.
    P.sent.length = 0;
    P.get('appAction')('gh-push', P.document.createElement('button'));
    const commit = P.sent.filter(m => m.type === 'gh-commit')[0];
    if (!commit) errs.push('no commit request');
    else {
      const paths = commit.files.map(f => f.path).sort().join(',');
      if (paths !== 'b.css,old.html') errs.push('push sent: ' + paths);
      const del = commit.files.filter(f => f.del)[0];
      if (!del || del.path !== 'old.html') errs.push('the deletion was not marked');
      if (commit.baseSha !== 'head111') errs.push('the preview head sha was not used as the base');
    }
    // Unchecking everything that would change refuses instead of pushing nothing.
    S.gh.files = { 'b.css': false, 'old.html': false };
    P.sent.length = 0;
    P.get('appAction')('gh-push', P.document.createElement('button'));
    if (P.sent.filter(m => m.type === 'gh-commit').length) errs.push('an empty selection was pushed');
    record('github', 'the preview renders added/unchanged/delete rows and pushes exactly the changed selection', errs);
  }

  /* ================= local storage ================= */
  console.log('\nworkspace storage' + ' — projects and revisions stay on this machine');
  {
    const B = createBuilders();
    const eng = loadEngine(B, { mode: 'inspect', editorType: 'dev' });
    const errs = [];
    const payload = JSON.stringify({ projects: [{ id: 'p1', name: 'Site', files: [], revisions: [] }], active: 'p1' });
    await eng.send({ type: 'store-set', key: 'projects', value: payload });
    const okMsg = eng.posted.filter(m => m.type === 'store-ok').pop();
    if (!okMsg) errs.push('store-set did not confirm');
    await eng.send({ type: 'store-get', key: 'projects' });
    const got = eng.posted.filter(m => m.type === 'store').pop();
    if (!got || !got.value || got.value.projects[0].name !== 'Site') errs.push('round trip failed: ' + JSON.stringify(got && got.value));
    // Oversized payloads are refused, not silently truncated.
    await eng.send({ type: 'store-set', key: 'history', value: JSON.stringify({ list: ['x'.repeat(210000)] }) });
    const bad = eng.posted.filter(m => m.type === 'store-error').pop();
    if (!bad) errs.push('an oversized payload was accepted');
    // Only the two known keys are readable.
    await eng.send({ type: 'store-get', key: 'github-token' });
    if (eng.posted.filter(m => m.type === 'store' && m.key === 'github-token').length) errs.push('an arbitrary storage key was readable');
    record('workspace storage', 'projects and revisions round-trip, oversized payloads and unknown keys are refused', errs);
  }

  /* ================= tabbed workspace UI ================= */
  console.log('\nworkspace ui' + ' — tabs, progressive disclosure, connect flow, history');
  {
    const P = loadPanel();
    const errs = [];
    const S = P.get('S');
    P.get('renderTabs')();
    const tabsHtml = P.$('tabs').innerHTML;
    const ids = (tabsHtml.match(/data-tab="([a-z]+)"/g) || []).map(x => x.slice(10, -1));
    if (ids.join(',') !== 'overview,design,files,code,assets,history,github,settings') errs.push('tabs: ' + ids.join(','));
    if ((tabsHtml.match(/role="tab"/g) || []).length !== 8) errs.push('tabs are not exposed as a tablist');
    if (!/aria-selected="true"[^>]*>Overview|Overview/.test(tabsHtml)) errs.push('no selected tab');
    if ((tabsHtml.match(/tabindex="-1"/g) || []).length !== 7) errs.push('roving tabindex is wrong');

    // Progressive disclosure on a large asset collection.
    const assets = [];
    for (let i = 0; i < 21; i++) assets.push({ id: 'a' + i, name: 'Asset ' + i, kind: i % 3 === 0 ? 'illustration' : 'icon', w: 24, h: 24 });
    assets.push({ id: 'sel', name: 'Selection', kind: 'selection' });
    S.data = { mode: 'inspect', spec: { id: '1', name: 'Card', type: 'FRAME' }, assets: assets, settings: { gate: 'strict', unit: 'px', remBase: 16, colorFormat: 'hex', previewFonts: 'google', svgFrames: 'auto' }, limits: { run: {} } };
    S.assetsView = { all: false, q: '', kind: 'all' };
    S.tab = 'assets';
    P.get('render')();
    const main = () => P.$('main').innerHTML;
    const rows = () => (main().match(/data-export="/g) || []).length;
    if (rows() !== 8) errs.push('expected 8 rows before expanding, got ' + rows());
    if (!/Show all 21 assets/.test(main())) errs.push('no expand control');
    P.get('appAction')('assets-all', P.document.createElement('button'));
    P.get('render')();
    if (rows() !== 21) errs.push('expand did not reveal every asset: ' + rows());
    if (!/Show less/.test(main())) errs.push('no collapse control');
    // The selection root is not repeated in the list.
    if (/data-export="sel"/.test(main())) errs.push('the selection is listed as an asset');
    // Filter by kind + search.
    P.get('appAction')('assets-kind', Object.assign(P.document.createElement('button'), { getAttribute: () => 'illustration' }));
    P.get('render')();
    if (rows() !== 7) errs.push('kind filter gave ' + rows() + ' rows');
    S.assetsView.kind = 'all'; S.assetsView.q = 'Asset 1';
    P.get('render')();
    if (rows() !== 11) errs.push('search gave ' + rows() + ' rows');

    // GitHub connect: a password field, an explanation, and no token echoed back.
    S.assetsView = { all: false, q: '', kind: 'all' };
    S.tab = 'github';
    S.gh = { status: { connected: false }, repos: [], branches: [], tree: null, files: {}, busy: '', error: null, msg: '', q: '' };
    P.get('render')();
    if (!/type="password"/.test(main())) errs.push('the token field is not masked');
    if (!/Contents: read and write/.test(main())) errs.push('the required permission is not stated');
    if (/\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/.test(main())) errs.push('the panel rendered something token-shaped');
    // Connected view shows the account and the repository picker.
    S.gh = { status: { connected: true, login: 'octocat' }, repos: [{ fullName: 'octo/repo', private: true, defaultBranch: 'main' }], branches: [], tree: null, files: {}, busy: '', error: null, msg: '', q: '' };
    P.get('render')();
    if (!/octocat/.test(main())) errs.push('the connected account is not shown');
    if (!/octo\/repo/.test(main())) errs.push('repositories are not listed');

    // History: compare renders a diff with added and removed lines.
    S.tab = 'history';
    const rev2 = { id: 'r2', at: Date.now(), label: 'html-css · 1 file', files: [{ name: 'a.html', hash: 'x' }], code: { 'a.html': '<h1>New</h1>' } };
    const rev1 = { id: 'r1', at: Date.now() - 1000, label: 'html-css · 1 file', files: [{ name: 'a.html', hash: 'y' }], code: { 'a.html': '<h1>Old</h1>' } };
    S.hist = { list: [rev2, rev1], open: null, cmp: 'r2' };
    P.get('render')();
    if (!/diff-line del/.test(main()) || !/diff-line add/.test(main())) errs.push('compare did not show a diff');
    if (!/&lt;h1&gt;Old/.test(main())) errs.push('the removed line is not escaped and shown');

    // Settings renders the new processing switch and the limits.
    S.tab = 'settings';
    P.get('render')();
    if (!/Vector illustrations/.test(main())) errs.push('the illustration setting is missing');
    if (!/id="set-svg"/.test(main())) errs.push('no control for the illustration mode');
    if (!/Layers per generation/.test(main())) errs.push('limits are not documented in the panel');
    record('workspace ui', 'tabs, 8-then-all asset disclosure, masked connect flow, diffs and settings', errs, 21 + ' assets');

    // Every tab renders with a realistic payload, and the inspector still renders
    // from the bundled demo data (the Design tab is untouched by the workspace).
    const P2 = loadPanel();
    const S2 = P2.get('S');
    S2.data = {
      mode: 'inspect', page: 'Home',
      spec: { id: '1:1', name: 'Card', type: 'FRAME' },
      complexity: { nodes: 12, depth: 3, text: 2, vectors: 1, instances: 0, images: 0, level: 'small', estimatedMs: 9, warnings: [], clipped: false },
      limits: { run: { maxNodes: 6000, maxGenerateNodes: 2500, maxDepth: 120 } },
      assets: [{ id: 'a1', name: 'icon', kind: 'icon' }, { id: 'a2', name: 'Hero illustration', kind: 'illustration', w: 120, h: 80 }, { id: 'a3', name: 'photo', kind: 'image' }],
      settings: { gate: 'off', unit: 'px', remBase: 16, colorFormat: 'hex', previewFonts: 'google', svgFrames: 'auto' },
      diagnostics: [{ where: 'local variables', detail: 'not available' }]
    };
    S2.hist = { list: [], open: null, cmp: null };
    S2.ws = null;
    const smokeErrs = [];
    ['overview', 'files', 'code', 'assets', 'history', 'github', 'settings'].forEach(t => {
      try {
        P2.get('setTab')(t);
        if (!P2.$('main').innerHTML.length) smokeErrs.push(t + ' rendered nothing');
      } catch (e) { smokeErrs.push(t + ' threw: ' + e.message); }
    });
    try {
      S2.data = P2.get('DEMO');
      P2.get('setTab')('design');
      if (P2.$('main').innerHTML.length < 1000) smokeErrs.push('the Design tab rendered almost nothing');
    } catch (e) { smokeErrs.push('design threw: ' + e.message); }
    record('workspace ui', 'every tab renders with a real payload, including the untouched Design inspector', smokeErrs, '8 tabs');
  }

  /* ============ the design-file queue ============ */
  console.log('\ndesign files' + ' — one file at a time, failures isolated, progress kept');
  {
    const P = loadPanel();
    const S = P.get('S');
    const errs = [];
    S.tab = 'files';
    S.data = { mode: 'inspect', spec: { id: '9:9', name: 'Page' }, assets: [], settings: { gate: 'off', unit: 'px', remBase: 16, colorFormat: 'hex' }, hist: { list: [] } };
    S.hist = { list: [], open: null, cmp: null };
    S.run = { queue: [], active: null, done: 0, total: 0, seq: 0, lang: 'html-css', cancelled: false, lastError: '' };
    S.ws = {
      active: 'p1',
      projects: [{
        id: 'p1', name: 'Site', created: Date.now(), updated: Date.now(), archived: false, revisions: [],
        files: [
          { id: 'f1', nodeId: '1:1', name: 'Header', type: 'FRAME', page: 'Home', status: 'idle' },
          { id: 'f2', nodeId: '2:2', name: 'Card', type: 'COMPONENT', page: 'Home', status: 'error', error: 'old failure' },
          { id: 'f3', nodeId: '3:3', name: 'Hero', type: 'FRAME', page: 'Home', status: 'ok', count: 2, at: Date.now() }
        ]
      }]
    };
    P.get('render')();
    const main = () => P.$('main').innerHTML;
    if (!/Design Files/.test(P.$('hdr').innerHTML)) errs.push('the files tab did not render');
    if (!/Retry/.test(main())) errs.push('a failed file has no retry control');
    if (!/1 failed/.test(main())) errs.push('failures are not summarised in the header');

    // Generate all: two files are eligible (idle + failed), one is already done.
    P.sent.length = 0;
    P.filesRun(false);
    const gen = () => P.sent.filter(m => m.type === 'gen-code');
    if (gen().length !== 1) errs.push('expected one in-flight request, got ' + gen().length);
    const first = gen()[0] || {};
    if (first.type !== 'gen-code' || first.nodeId !== '1:1') errs.push('queue started with ' + JSON.stringify(first));
    if (!first.jobId || !first.requestId) errs.push('the queued request has no job id');
    // A second run refuses to start while one is in flight.
    P.sent.length = 0;
    P.filesRun(false);
    if (gen().length) errs.push('a concurrent run was allowed to start');
    // A reply from another job is ignored.
    P.onmessage({ type: 'code', jobId: 1, lang: 'html-css', requestId: 'x', nodeId: '1:1', out: { files: [{ name: 'nope.html', code: 'x' }] } });
    if (P.wsActive().files[0].status !== 'running') errs.push('a stale reply changed a file status');
    // The real reply advances the queue.
    P.onmessage({ type: 'code', jobId: first.jobId, lang: 'html-css', requestId: first.requestId, nodeId: '1:1', out: { files: [{ name: 'Header.html', code: '<header></header>' }, { name: 'Header.css', code: 'header{}' }] } });
    const f1 = P.wsActive().files[0];
    if (f1.status !== 'ok') errs.push('success was not recorded: ' + f1.status);
    if (f1.count !== 2) errs.push('file count ' + f1.count);
    if (!gen().length) errs.push('the queue did not advance to the next file');
    const second = gen()[gen().length - 1] || {};
    if (second.nodeId !== '2:2') errs.push('next file was ' + second.nodeId);
    // A failure is isolated and explained.
    P.onmessage({ type: 'code', jobId: second.jobId, lang: 'html-css', requestId: second.requestId, nodeId: '2:2', out: { files: [{ name: 'error.txt', code: 'x' }], error: 'Font unavailable', assetErrors: ['Font unavailable'] } });
    const f2 = P.wsActive().files[1];
    if (f2.status !== 'error') errs.push('failure was not recorded');
    if (!/Font unavailable/.test(f2.error || '')) errs.push('the failure reason was lost');
    if (P.wsActive().files[2].status !== 'ok') errs.push('an untouched file was reset');
    if (P.get('S').run.done !== 1) errs.push('done counter ' + P.get('S').run.done);
    if (!/Font unavailable/.test(main())) errs.push('the failure is not shown in the tab');
    // The generated code tab reflects the last successful run.
    const lc = P.get('S').lastCode;
    if (!lc || lc.files.length !== 2) errs.push('no last-code record');
    else if (!/Header.css/.test(lc.files.map(f => f.name).join(','))) errs.push('last code lost a file');
    P.get('setTab')('code');
    if (!/Header\.html/.test(main())) errs.push('the code tab does not list the files');
    if (!/Download all/.test(main())) errs.push('the code tab has no bulk download');
    if (!/Push to GitHub/.test(main())) errs.push('the code tab has no publishing shortcut');
    // Cancellation asks the engine to stop and leaves the file pending.
    P.get('setTab')('files');
    P.sent.length = 0;
    P.filesRun(false);
    const inFlight = gen()[gen().length - 1];
    P.sent.length = 0;
    P.filesCancel();
    const cancelMsg = P.sent.filter(m => m.type === 'cancel')[0];
    if (!cancelMsg || cancelMsg.jobId !== inFlight.jobId) errs.push('cancel did not target the running job');
    P.onmessage({ type: 'code', jobId: inFlight.jobId, lang: 'html-css', requestId: inFlight.requestId, nodeId: '2:2', cancelled: true, out: { files: [] } });
    if (P.wsActive().files[1].status !== 'idle') errs.push('a cancelled file kept a status: ' + P.wsActive().files[1].status);
    // Retry targets only what failed — and says so when nothing did.
    P.sent.length = 0;
    P.filesRun(true);
    if (gen().length) errs.push('retry ran files that never failed');
    // Make one file fail again, then retry it.
    P.filesRun(false);
    const again = gen()[gen().length - 1];
    P.onmessage({ type: 'code', jobId: again.jobId, lang: 'html-css', requestId: again.requestId, nodeId: '2:2', out: { files: [{ name: 'error.txt', code: 'x' }], error: 'Still failing' } });
    if (P.wsActive().files[1].status !== 'error') errs.push('the second attempt was not recorded as a failure');
    P.sent.length = 0;
    P.filesRun(true);
    if (gen().length !== 1) errs.push('retry sent ' + gen().length + ' requests');
    else if (gen()[0].nodeId !== '2:2') errs.push('retry started from ' + gen()[0].nodeId);
    record('design files', 'queued one-at-a-time runs, isolated failures, retry, cancel and the code view', errs, '3 files');
  }

  /* ============ projects ============ */
  console.log('\nprojects' + ' — find, sort and archive without losing work');
  {
    const P = loadPanel();
    const S = P.get('S');
    const errs = [];
    const now = Date.now();
    S.tab = 'overview';
    S.data = { mode: 'inspect', spec: { id: '1:1', name: 'Card' }, assets: [], settings: {} };
    S.activity = [];
    S.hist = { list: [], open: null, cmp: null };
    S.run = { queue: [], active: null, done: 0, total: 0, seq: 0, lang: 'html-css', cancelled: false, lastError: '' };
    S.projView = { q: '', sort: 'recent', archived: false };
    S.ws = {
      active: 'b', projects: [
        { id: 'a', name: 'Marketing site', created: now - 5000, updated: now - 5000, files: [], revisions: [] },
        { id: 'b', name: 'App shell', created: now - 1000, updated: now, files: [{ id: 'f', nodeId: '1:1', name: 'Card' }], revisions: [] },
        { id: 'c', name: 'Old landing', created: now - 9000, updated: now - 9000, archived: true, files: [], revisions: [] }
      ]
    };
    P.get('render')();
    const main = () => P.$('main').innerHTML;
    const list = () => P.get('projList')().map(p => p.name);
    if (JSON.stringify(list()) !== JSON.stringify(['App shell', 'Marketing site'])) errs.push('recent order: ' + list());
    if (/Old landing/.test(main())) errs.push('an archived project is listed by default');
    S.projView.sort = 'name';
    if (JSON.stringify(list()) !== JSON.stringify(['App shell', 'Marketing site'])) errs.push('name order: ' + list());
    S.projView.sort = 'created';
    if (JSON.stringify(list()) !== JSON.stringify(['App shell', 'Marketing site'])) errs.push('created order: ' + list());
    S.projView.q = 'market';
    if (JSON.stringify(list()) !== JSON.stringify(['Marketing site'])) errs.push('search: ' + list());
    S.projView.q = 'zzz';
    P.get('render')();
    if (!/No project matches/.test(main())) errs.push('no empty state for a search with no hits');
    S.projView.q = '';
    S.projView.archived = true;
    if (JSON.stringify(list()) !== JSON.stringify(['Old landing'])) errs.push('archived filter: ' + list());
    // Switching projects keeps each project's own files.
    S.projView.archived = false;
    P.get('appAction')('proj-switch', Object.assign(P.document.createElement('button'), { getAttribute: () => 'a' }));
    if (P.wsActive().id !== 'a') errs.push('switch did not change project');
    if ((P.wsActive().files || []).length) errs.push('files were copied between projects');
    // Archive follows the filter instead of hiding the project silently.
    P.get('appAction')('proj-sort', Object.assign(P.document.createElement('button'), { getAttribute: () => 'recent' }));
    P.get('appAction')('proj-archived', P.document.createElement('button'));
    S.projView.archived = false;
    S.ws.active = 'a';
    P.get('wsArchive')();
    if (!P.wsActive().archived) errs.push('archive did not apply');
    if (!S.projView.archived) errs.push('the list did not follow the archived project');
    // Creating and renaming happen in the panel: Figma's plugin iframe blocks
    // window.prompt(), so a prompt-based flow would silently fail there.
    const fs = require('fs');
    const src = fs.readFileSync(require('path').join(__dirname, '..', 'devready-plugin', 'ui.html'), 'utf8');
    if (/\bwindow\.(prompt|confirm|alert)\s*\(/.test(src) && !/blocks window\.prompt/.test(src)) errs.push('the panel still calls a blocked browser dialog');
    S.projForm = null;
    P.get('wsNewProject')();
    if (!S.projForm || S.projForm.kind !== 'new') errs.push('New project did not open the inline form');
    if (P.wsEnsure().projects.length !== 3) errs.push('opening the form created a project');
    P.get('wsCreateNamed')('App shell');
    if (P.wsEnsure().projects.length !== 4) errs.push('the form did not create a project');
    const created = P.wsActive();
    if (created.name !== 'App shell 2') errs.push('duplicate names are not made unique: ' + created.name);
    if (S.projForm) errs.push('the form stayed open after creating');
    P.get('wsRenameTo')('Design system');
    if (P.wsActive().name !== 'Design system') errs.push('rename failed');
    P.get('wsRenameTo')('   ');
    if (P.wsActive().name !== 'Design system') errs.push('a blank name overwrote the project name');
    record('projects', 'recents, sorting, search, archive filtering, isolation, and naming without browser dialogs', errs, '4 projects');
  }
};
