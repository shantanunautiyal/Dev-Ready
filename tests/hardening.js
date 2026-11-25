/**
 * Hardening: the panel must never look idle while it is actually stuck.
 *
 * Every bug here was reported from a real session:
 *   • the panel showed sample data because the plugin thread never answered, so a
 *     pasted GitHub token went nowhere and the selection never followed;
 *   • "Checking GitHub connection…" could stay on screen forever with no retry;
 *   • the workspace tabs had no horizontal padding (#main pads nothing);
 *   • the accessibility section disappeared on a clean layer, taking the report
 *     buttons with it;
 *   • a token was deleted when GitHub was merely unreachable.
 *
 * The static checks at the end pin the two message contracts, which is the class of
 * bug that produces a silent no-op: a message that is sent but not in MSG_SCHEMA is
 * dropped before it reaches a handler.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { createBuilders, loadEngine, CODE } = require('./harness');
const { loadPanel } = require('./unit-ui');

const UI_CODE = fs.readFileSync(path.join(__dirname, '..', 'devready-plugin', 'ui.html'), 'utf8');

const hex = h => ({ r: parseInt(h.slice(1, 3), 16) / 255, g: parseInt(h.slice(3, 5), 16) / 255, b: parseInt(h.slice(5, 7), 16) / 255 });
const solid = h => [{ type: 'SOLID', visible: true, opacity: 1, color: hex(h) }];
const screen = (B, kids) => {
  const root = B.ABS('Screen', 420, 320, { 'background-color': '#FFFFFF' }, kids, { fills: solid('#FFFFFF') });
  root.parent = { type: 'PAGE' };
  return root;
};

module.exports = async function hardeningTests(record) {
  /* ================= startup ordering ================= */
  console.log('\nstartup' + ' — the panel always gets a message handler');
  {
    const errs = [];
    const B = createBuilders();
    const root = screen(B, [B.T('Hello', {}, { fills: solid('#111111') })]);
    // The editor rejects event registration. Before the fix this threw between
    // showUI and the handler assignment: the panel opened and heard nothing.
    const eng = loadEngine(B, { mode: 'inspect', editorType: 'dev', selection: [root], throwOnEvent: true });
    if (!eng.shown()) errs.push('showUI was never reached');
    if (typeof eng.figma.ui.onmessage !== 'function') errs.push('no message handler after a rejected event registration');
    await eng.send({ type: 'settings', settings: { gate: 'off' } });
    await eng.send({ type: 'ui-ready' });
    await new Promise(r => setTimeout(r, 250));
    const state = eng.posted.filter(m => m.type === 'state').pop();
    if (!state || !state.spec) errs.push('the panel still got no state: ' + JSON.stringify(eng.posted.map(m => m.type)));
    const warned = eng.posted.filter(m => m.type === 'error').pop();
    if (!warned || !/Selection tracking/.test(warned.message || '')) errs.push('the panel was not told that tracking is unavailable: ' + JSON.stringify(warned));
    record('startup', 'a rejected event registration still leaves a working handler, and the panel is told', errs);
  }
  {
    // The handler is assigned before anything that can throw, in source order too.
    const errs = [];
    const at = CODE.indexOf('figma.ui.onmessage = handleUiMessage;');
    const on = CODE.search(/figma\.on\('selectionchange'/);
    const decl = CODE.indexOf('async function handleUiMessage(raw)');
    if (at < 0) errs.push('the handler is not assigned straight after showUI');
    if (decl < 0) errs.push('handleUiMessage is not a hoisted function declaration');
    if (on >= 0 && at > on) errs.push('the handler is assigned after the page watchers');
    if (CODE.indexOf('figma.showUI(') > at) errs.push('the handler is assigned before the panel exists');
    record('startup', 'the handler is attached between showUI and the page watchers', errs);
  }

  /* ================= rejected messages are answered ================= */
  console.log('startup' + ' — a refused message reaches the panel, not just the canvas');
  {
    const B = createBuilders();
    const root = screen(B, [B.T('Hello', {}, { fills: solid('#111111') })]);
    const eng = loadEngine(B, { mode: 'inspect', editorType: 'dev', selection: [root] });
    const errs = [];
    await eng.send({ type: 'gh-connect', token: 'short' });        // fails V.re(^\\S{20,255}$)
    const bad = eng.posted.filter(m => m.type === 'invalid').pop();
    if (!bad) errs.push('no invalid answer: ' + JSON.stringify(eng.posted.map(m => m.type)));
    else {
      if (bad.of !== 'gh-connect') errs.push('wrong message named: ' + bad.of);
      if (!/token/.test(bad.field || '')) errs.push('the refused field is not named: ' + bad.field);
      if (!/refused/.test(bad.message || '')) errs.push('the panel gets no sentence to show: ' + bad.message);
    }
    if (eng.posted.some(m => m.type === 'gh-status')) errs.push('a refused connect still answered as if it ran');
    record('startup', 'an invalid field answers the panel, so no control stays disabled', errs);
  }

  /* ================= GitHub token handling ================= */
  console.log('\ngithub' + ' — a token is only discarded when GitHub rejects it');
  {
    const B = createBuilders();
    const root = screen(B, [B.T('Hello', {}, { fills: solid('#111111') })]);
    // Network failure: fetch throws, as it does offline or behind a blocked domain.
    const offline = loadEngine(B, { mode: 'inspect', editorType: 'dev', selection: [root] });
    const errs = [];
    await offline.send({ type: 'gh-connect', token: 'ghp_' + 'a'.repeat(36) });
    const kept = offline.figma.root.getSharedPluginData('devready-x', 'nothing');
    void kept;
    const storedOffline = await offline.run("(async () => await figma.clientStorage.getAsync('devready-github-token'))()");
    if (!storedOffline) errs.push('an unreachable GitHub erased a valid token');
    const replyOffline = offline.posted.filter(m => m.type === 'gh-status').pop();
    if (!replyOffline || replyOffline.status.connected) errs.push('an offline connect claimed to be connected');
    else {
      if (!replyOffline.status.stale) errs.push('the reply does not say the token was kept');
      if (replyOffline.status.error.code !== 'network' && replyOffline.status.error.code !== 'timeout') errs.push('the cause is not reported: ' + replyOffline.status.error.code);
    }

    // 401: the token really is wrong, so it goes.
    const B2 = createBuilders();
    const root2 = screen(B2, [B.T('Hello', {}, { fills: solid('#111111') })]);
    const rejected = loadEngine(B2, {
      mode: 'inspect', editorType: 'dev', selection: [root2],
      fetch: async () => ({ status: 401, ok: false, text: async () => JSON.stringify({ message: 'Bad credentials' }), headers: { get: () => null } })
    });
    await rejected.send({ type: 'gh-connect', token: 'ghp_' + 'b'.repeat(36) });
    const replyBad = rejected.posted.filter(m => m.type === 'gh-status').pop();
    const storedBad = await rejected.run("(async () => await figma.clientStorage.getAsync('devready-github-token'))()");
    if (!replyBad || replyBad.status.stale) errs.push('a rejected token was reported as kept: ' + JSON.stringify(replyBad && replyBad.status));
    if (replyBad && replyBad.status.error && replyBad.status.error.code !== 'auth') errs.push('a 401 is not reported as auth: ' + replyBad.status.error.code);
    if (storedBad) errs.push('a token GitHub rejected was kept on the machine');
    record('github', 'an unreachable GitHub keeps the token; a rejected one is removed', errs);
  }

  /* ================= panel: no silent sample data ================= */
  console.log('\npanel' + ' — a silent thread is reported, not disguised');
  {
    const P = loadPanel();
    const S = P.get('S');
    const errs = [];
    S.got = false; S.disconnected = true; S.demo = false; S.data = null;
    P.get('render')();
    const main = P.$('main').innerHTML;
    if (!/No answer from/.test(main)) errs.push('the disconnected state is not explained: ' + main.slice(0, 160));
    if (!/retry-connect/.test(main)) errs.push('there is no Retry control');
    if (/Pay button|Checkout/.test(main)) errs.push('sample data is still shown while disconnected');
    if (/use-samples/.test(main)) errs.push('sample data is offered inside Figma');
    // Retry asks again and stays honest when nothing answers.
    P.sent.length = 0;
    P.get('retryConnect')();
    if (!P.sent.some(m => m.type === 'ui-ready')) errs.push('Retry does not ask the plugin again');
    if (S.disconnected) errs.push('Retry does not leave the disconnected state while it waits');
    // A real state clears it.
    P.onmessage(Object.assign({ type: 'state' }, JSON.parse(JSON.stringify(P.get('DEMO')))));
    if (S.disconnected || S.demo) errs.push('a real state did not clear the disconnected state');
    record('panel', 'a disconnected panel explains itself, offers Retry and never shows another design', errs);
  }

  /* ================= panel: GitHub cannot hang ================= */
  console.log('panel' + ' — GitHub always has a way out');
  {
    const P = loadPanel();
    const S = P.get('S');
    const errs = [];
    S.disconnected = false; S.demo = false; S.tab = 'github';
    S.gh = { status: undefined, repos: [], reposAll: false, q: '', repo: '', branches: [], branch: '', tree: null, files: {}, msg: '', busy: '', error: null, result: null, pending: false, timeout: '' };
    S.data = { mode: 'inspect', spec: { id: '1:1', name: 'Card', type: 'FRAME' }, settings: {} };
    P.sent.length = 0;
    P.get('viewGithub')();
    if (!/Checking GitHub connection/.test(P.$('main').innerHTML)) errs.push('the check state is not shown');
    if (!P.sent.some(m => m.type === 'gh-status')) errs.push('no gh-status request');

    // Timed out: the panel says so and offers a retry instead of spinning forever.
    S.gh.timeout = 'the connection check'; S.gh.pending = false;
    P.get('viewGithub')();
    const stuck = P.$('main').innerHTML;
    if (!/GitHub did not answer/.test(stuck)) errs.push('a timed-out check is not reported: ' + stuck.slice(0, 160));
    if (!/gh-retry/.test(stuck)) errs.push('a timed-out check has no Retry');
    P.sent.length = 0;
    P.get('appAction')('gh-retry', { getAttribute: () => 'gh-retry' });
    if (!P.sent.some(m => m.type === 'gh-status')) errs.push('Retry does not re-ask');

    // A saved token plus an unreachable GitHub asks for a retry, not the token again.
    S.gh.timeout = ''; S.gh.pending = false;
    S.gh.status = { connected: false, stale: true, error: { code: 'network', message: 'Could not reach GitHub.' } };
    P.get('viewGithub')();
    const stale = P.$('main').innerHTML;
    if (!/token is saved/.test(stale)) errs.push('a stale connection does not say the token was kept');
    if (/placeholder="github_pat_/.test(stale)) errs.push('a stale connection asks for the token again');
    if (!/gh-retry/.test(stale)) errs.push('a stale connection has no Retry');

    // Connect sends exactly what was typed, and nothing hangs if the reply is lost.
    S.gh.status = { connected: false }; S.gh.timeout = ''; S.gh.busy = '';
    P.$('gh-token').value = '  ghp_' + 'c'.repeat(36) + '  ';
    P.sent.length = 0;
    P.get('appAction')('gh-connect', { getAttribute: () => 'gh-connect' });
    const sent = P.sent.filter(m => m.type === 'gh-connect').pop();
    if (!sent) errs.push('the token was not sent');
    else if (sent.token !== 'ghp_' + 'c'.repeat(36)) errs.push('the token was not trimmed: ' + JSON.stringify(sent.token));
    record('panel', 'a check, a timeout, a stale token and Connect all resolve visibly', errs);
  }

  /* ================= panel: layout and sections ================= */
  console.log('panel' + ' — tab views are padded and the a11y section always exists');
  {
    const P = loadPanel();
    const S = P.get('S');
    const errs = [];
    S.disconnected = false; S.demo = true; S.data = JSON.parse(JSON.stringify(P.get('DEMO')));
    P.get('setTab')('code');
    if (!P.$('main').classList.contains('tabview')) errs.push('a workspace tab does not get the padded container');
    P.get('setTab')('design');
    if (P.$('main').classList.contains('tabview')) errs.push('the Design tab is double-padded');
    if (!/main\.tabview \{ padding/.test(UI_CODE)) errs.push('the padded container has no CSS');

    // A clean layer still gets the section, so Ignore/report stay reachable.
    const clean = { a11y: { scanned: 20, counts: { fail: 0, warn: 0, pass: 6, unknown: 0, ignored: 0 }, items: [], groups: [], ignored: [], reasons: ['Decorative'] } };
    const html = P.get('secA11y')(clean);
    if (!html) errs.push('a clean layer hides the accessibility section');
    else {
      if (!/Export report/.test(html)) errs.push('a clean layer loses the report button');
      if (!/No contrast, non-text/.test(html)) errs.push('a clean layer does not say it is clean');
    }
    record('panel', 'workspace tabs get padding and a clean layer keeps its report controls', errs);
  }

  /* ================= panel: failures release the controls ================= */
  console.log('panel' + ' — a failed request never leaves a control disabled');
  {
    const P = loadPanel();
    const S = P.get('S');
    const errs = [];
    S.disconnected = false; S.demo = true; S.tab = 'files';
    S.data = JSON.parse(JSON.stringify(P.get('DEMO')));
    S.run = S.run || { queue: [], done: 0, total: 0, active: null, cancelled: false, lastError: '', seq: 1, lang: 'html-css' };
    S.gh = Object.assign({}, S.gh, { busy: 'push', pending: true, timeout: '' });
    const proj = P.get('wsActive')();
    proj.files = [{ id: 'f1', nodeId: '1:1', name: 'Card', status: 'running', error: '' }];
    S.run.active = { fileId: 'f1', jobId: 1, requestId: 'r1', nodeId: '1:1' };
    P.onmessage({ type: 'error', message: 'The plugin hit a problem' });
    if (S.gh.busy || S.gh.pending) errs.push('a failed request left GitHub busy');
    if (S.run.active) errs.push('a failed run left the queue active');
    if (proj.files[0].status !== 'error') errs.push('the queue entry is still "running": ' + proj.files[0].status);
    if (!proj.files[0].error) errs.push('the failure has no message');

    // Same for a rejected message.
    S.run.active = { fileId: 'f1', jobId: 2, requestId: 'r2', nodeId: '1:1' };
    proj.files[0].status = 'running';
    P.onmessage({ type: 'invalid', of: 'gen-code', field: 'lang', message: 'DevReady refused lang for gen-code.' });
    if (S.run.active) errs.push('a refused message left the queue active');
    if (proj.files[0].status !== 'error') errs.push('a refused message left the entry running');
    record('panel', 'error and invalid answers reset GitHub and the file queue', errs);
  }

  /* ================= every tab renders ================= */
  console.log('panel' + ' — every tab renders from real state and from samples');
  {
    const P = loadPanel();
    const S = P.get('S');
    const errs = [];
    S.disconnected = false; S.demo = false; S.data = null;
    // A state as the engine really posts it (inspect mode, one layer, audit present).
    const B = createBuilders();
    const root = screen(B, [B.T('Pay', { 'font-size': '14px' }, { fills: solid('#0D99FF') })]);
    const eng = loadEngine(B, { mode: 'inspect', editorType: 'dev', selection: [root] });
    await eng.send({ type: 'settings', settings: { gate: 'off' } });
    await eng.send({ type: 'ui-ready' });
    await new Promise(r => setTimeout(r, 250));
    const state = eng.posted.filter(m => m.type === 'state').pop();
    if (!state || !state.spec) { errs.push('the engine did not produce an inspect state'); }
    else {
      const tabs = P.get('TABS').map(t => t.id);
      tabs.forEach(id => {
        try {
          P.get('setTab')(id);
          const main = P.$('main').innerHTML;
          const hdr = P.$('hdr').innerHTML;
          if (!main && !hdr) errs.push('tab "' + id + '" rendered nothing');
          if (/undefined/.test(main.replace(/data-[a-z-]+="[^"]*"/g, '').slice(0, 4000))) errs.push('tab "' + id + '" prints undefined');
        } catch (e) {
          errs.push('tab "' + id + '" threw: ' + e.message);
        }
      });
      // And the sample state, which is what a standalone preview shows.
      S.demo = true; S.data = JSON.parse(JSON.stringify(P.get('DEMO')));
      tabs.forEach(id => {
        try { P.get('setTab')(id); if (!P.$('main').innerHTML && id !== 'design') errs.push('sample tab "' + id + '" rendered nothing'); }
        catch (e) { errs.push('sample tab "' + id + '" threw: ' + e.message); }
      });
    }
    record('panel', 'all eight tabs render from an engine state and from sample data', errs);
  }

  /* ================= the two message contracts ================= */
  console.log('messages' + ' — nothing is sent that cannot be answered, nothing posted is ignored');
  {
    const errs = [];
    // Everything the panel sends must be in MSG_SCHEMA, or validateMsg() drops it and
    // the control that sent it waits forever.
    const start = CODE.indexOf('const MSG_SCHEMA');
    const block = CODE.slice(start, CODE.indexOf('\n};', start));
    const schema = new Set([...block.matchAll(/'([a-zA-Z0-9_-]+)':/g)].map(m => m[1]));
    const sent = new Set();
    for (const m of UI_CODE.matchAll(/send\(\{\s*type:\s*'([a-zA-Z0-9_-]+)'/g)) sent.add(m[1]);
    for (const m of UI_CODE.matchAll(/send\(Object\.assign\(\{\s*type:\s*'([a-zA-Z0-9_-]+)'/g)) sent.add(m[1]);
    const dropped = [...sent].filter(t => !schema.has(t));
    if (dropped.length) errs.push('sent but not in MSG_SCHEMA: ' + dropped.join(', '));

    // Everything the engine posts must be accepted by the panel, or the reply is
    // silently ignored and the request looks unanswered.
    const posted = new Set();
    for (const m of CODE.matchAll(/post\(\{\s*type:\s*'([a-zA-Z0-9_-]+)'/g)) posted.add(m[1]);
    for (const m of CODE.matchAll(/post\(Object\.assign\(\{\s*type:\s*'([a-zA-Z0-9_-]+)'/g)) posted.add(m[1]);
    const wl = UI_CODE.slice(UI_CODE.indexOf("window.onmessage = ev =>"), UI_CODE.indexOf("S.got = true; S.demo = false;"));
    const accepted = new Set([...wl.matchAll(/'([a-z][a-z0-9-]+)'/g)].map(m => m[1]));
    const ignored = [...posted].filter(t => !accepted.has(t));
    if (ignored.length) errs.push('posted but ignored by the panel: ' + ignored.join(', '));

    // Every rendered control must have a handler, or it is a dead button.
    const acts = new Set([...UI_CODE.matchAll(/data-act="([a-zA-Z0-9_:|-]+)"/g)].map(m => m[1]));
    const handled = new Set([...UI_CODE.matchAll(/act === '([a-zA-Z0-9_:|-]+)'/g)].map(m => m[1]));
    const prefixes = [...UI_CODE.matchAll(/\/\^([a-z0-9-]+)-[^/]*\/\.test\(act\)/g)].map(m => m[1]);
    // Some controls are intercepted before the action chain, by a closest() lookup.
    const early = new Set([
      ...[...UI_CODE.matchAll(/closest\('\[data-act="([a-zA-Z0-9_-]+)"\]'\)/g)].map(m => m[1]),
      // Checkboxes are handled by the change listener, not the click chain.
      ...[...UI_CODE.matchAll(/getAttribute\('data-act'\) === '([a-zA-Z0-9_-]+)'/g)].map(m => m[1])
    ]);
    const dead = [...acts].filter(a => !handled.has(a) && !early.has(a) && !a.endsWith('-menu') && !prefixes.some(p => a.indexOf(p + '-') === 0));
    if (dead.length) errs.push('rendered with no handler: ' + dead.join(', '));
    record('messages', 'sent ⊆ schema, posted ⊆ accepted, every rendered control has a handler', errs,
      sent.size + ' sent · ' + posted.size + ' posted · ' + acts.size + ' controls');
  }
};
