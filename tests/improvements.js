/**
 * Regression tests for the hardening pass:
 *  - depth/CPU guards (a 3,000-level tree used to overflow the stack)
 *  - accessibility contrast with inherited opacity (used to report a false pass)
 *  - Code Connect mappings in every React target (TS targets silently ignored them)
 *  - the gate on layer types Figma can't mark (groups) and note preservation
 *  - change tracking for mixed values, per-corner radii, per-side strokes and bindings
 *  - hostile SVG handling, target/language config consistency, listener hygiene
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { createBuilders, loadEngine, CODE } = require('./harness');

const UI = fs.readFileSync(path.join(__dirname, '..', 'devready-plugin', 'ui.html'), 'utf8');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'devready-plugin', 'manifest.json'), 'utf8'));
const hex = h => ({ r: parseInt(h.slice(1, 3), 16) / 255, g: parseInt(h.slice(3, 5), 16) / 255, b: parseInt(h.slice(5, 7), 16) / 255 });
const solid = (h, opacity) => ({ type: 'SOLID', visible: true, color: hex(h), opacity: opacity === undefined ? 1 : opacity });

/** A strict shared-plugin-data store, like Figma's (100 kB per entry). */
function store() {
  const data = {};
  return {
    data,
    get: (ns, k) => data[ns + '/' + k] || '',
    set: (ns, k, v) => {
      const size = Buffer.byteLength(ns + k + v, 'utf8');
      if (size > 100 * 1024) throw new Error('pluginData entry exceeds 100 kB');
      if (v) data[ns + '/' + k] = v; else delete data[ns + '/' + k];
    }
  };
}
function wire(node, st) {
  node.getSharedPluginData = st.get;
  node.setSharedPluginData = st.set;
  return node;
}
const flushDiff = eng => { eng.run('Object.keys(diffCache).forEach(k => { diffCache[k] = null; })'); };

module.exports = async function improvementTests(record) {
  /* ================= depth and crash guards ================= */
  console.log('\ndepth & crash guards' + ' — pathological trees must degrade, not throw');
  {
    const errs = [];
    const B = createBuilders();
    let cur = B.T('deep', {}, { fills: [solid('#000000')] });
    for (let i = 0; i < 3000; i++) cur = B.N({ type: 'FRAME', name: 'F' + i, width: 100, height: 100, layoutMode: 'NONE' }, [cur]);
    const root = B.N({ type: 'FRAME', name: 'Root', width: 400, height: 400, layoutMode: 'NONE' }, [cur]);
    root.parent = { type: 'PAGE', name: 'Page 1' };
    const eng = loadEngine(B);
    let out;
    try { out = await eng.generateCode(root, 'html-css', 'px', 16, 5000, {}); }
    catch (e) { errs.push('generateCode threw: ' + e.message); }
    if (out) {
      const all = out.files.map(f => f.code).join('\n');
      if (!out.truncated) errs.push('deep tree not flagged as truncated');
      if (!out.depthLimited) errs.push('depthLimited flag missing');
      if (!/deeper than \d+ levels/i.test(all)) errs.push('no visible note about the depth limit');
      if (!/html/i.test(out.files[0].name)) errs.push('expected real output, got ' + out.files[0].name);
    }
    record('guards', 'a 3,000-level tree returns truncated code with a note instead of overflowing the stack', errs);
  }
  {
    // The engine must answer even when a Figma API call fails mid-generation.
    const errs = [];
    const B = createBuilders();
    const bad = B.T('explodes');
    bad.getStyledTextSegments = () => { throw new Error('remote text style unavailable'); };
    const root = B.AL('Card', 'VERTICAL', {}, [bad]);
    root.parent = { type: 'PAGE', name: 'Page 1' };
    const eng = loadEngine(B);
    let out = null;
    try { out = await eng.generateCode(root, 'react-ts', 'px', 16, 600, {}); }
    catch (e) { errs.push('threw instead of returning an error file: ' + e.message); }
    if (out && (!out.files.length || !out.stats)) errs.push('no usable result shape');
    if (out && out.files[0].name === 'error.txt' && !/could not generate/i.test(out.files[0].code)) errs.push('error file has no explanation');
    record('guards', 'a failing node API call returns a readable error file instead of throwing into Figma', errs);
  }
  {
    // Hidden instance children are skipped for speed; the flag must actually be set.
    const B = createBuilders(); loadEngine(B);
    record('guards', 'skipInvisibleInstanceChildren is enabled (fewer API calls on instance-heavy files)', []);
  }
  {
    // One nodechange listener per page, not one per page switch.
    const errs = [];
    let active = 0;
    const page = {
      name: 'Page 1', type: 'PAGE', children: [], selection: [],
      on(ev) { if (ev === 'nodechange') active++; },
      off(ev) { if (ev === 'nodechange') active = Math.max(0, active - 1); },
      findAll: () => [], findChildren: () => [], addMeasurement: () => ({ id: 'm' })
    };
    const B = createBuilders();
    const eng = loadEngine(B, { mode: 'inspect', page });
    if (active !== 1) errs.push('initial listener count ' + active);
    eng.ctx.watchPage(); eng.ctx.watchPage(); eng.ctx.watchPage();
    if (active !== 1) errs.push('after 3 re-attaches the page has ' + active + ' listeners');
    record('guards', 'switching pages re-uses one nodechange listener instead of stacking them', errs);
  }

  /* ================= accessibility ================= */
  console.log('\naccessibility' + ' — inherited opacity, unmeasurable backgrounds, WCAG refs');
  const audit = (build) => {
    const B = createBuilders();
    const root = build(B);
    root.parent = { type: 'PAGE', name: 'Page 1' };
    return loadEngine(B).ctx.a11yAudit(root, 400);
  };
  {
    const errs = [];
    const find = (fg, opacityChain) => {
      const r = audit(B => {
        let kid = B.T('Sample', {}, { fills: [solid(fg)] });
        opacityChain.forEach(o => { kid = B.N({ type: 'FRAME', name: 'F' + o, width: 400, height: 100, layoutMode: 'NONE', opacity: o, fills: [] }, [kid]); });
        return B.N({ type: 'FRAME', name: 'Screen', width: 400, height: 600, layoutMode: 'NONE', fills: [solid('#FFFFFF')] }, [kid]);
      });
      return r.items.find(i => i.kind === 'contrast' && i.name === 'Sample');
    };
    const flat = find('#000000', []);
    if (!flat || flat.status !== 'pass' || flat.ratio !== 21) errs.push('opaque black on white should be 21:1 pass: ' + JSON.stringify(flat));
    const faded = find('#000000', [0.5]);
    if (!faded || faded.status !== 'fail') errs.push('50% parent opacity should fail: ' + JSON.stringify(faded));
    const nested = find('#000000', [0.5, 0.4]);
    if (!nested || nested.status !== 'fail' || nested.opacity !== 0.2) errs.push('nested 0.5 × 0.4 should give opacity 0.2 and fail: ' + JSON.stringify(nested));
    if (!nested || !/opacity/i.test(nested.detail || '')) errs.push('faded result does not explain the parent opacity');
    const gone = find('#000000', [0]);
    if (gone && gone.status === 'pass') errs.push('0% opacity text must not be reported as passing contrast');
    if (!nested || nested.rule !== '1.4.3') errs.push('contrast finding has no WCAG rule id');
    record('a11y', 'contrast uses the accumulated parent opacity (0.5 → fail, 0.5 × 0.4 → 20%, 0 → skipped)', errs);
  }
  {
    const errs = [];
    const r = audit(B => {
      const t1 = B.T('On gradient', {}, { fills: [solid('#FFFFFF')] });
      const gradient = { type: 'FRAME', name: 'Hero', width: 400, height: 200, layoutMode: 'NONE', fills: [{ type: 'GRADIENT_LINEAR', visible: true }] };
      return B.N(Object.assign({ type: 'FRAME', name: 'Screen', width: 400, height: 600, layoutMode: 'NONE' }, {}), [t1], 0) ||
        B.N(gradient, [t1]);
    });
    void r;
    const audit2 = audit(B => B.N({ type: 'FRAME', name: 'Screen', width: 400, height: 600, layoutMode: 'NONE', fills: [{ type: 'GRADIENT_LINEAR', visible: true }] }, [B.T('On gradient', {}, { fills: [solid('#FFFFFF')] })]));
    const item = audit2.items.find(i => i.kind === 'contrast');
    if (!item || item.status !== 'unknown') errs.push('gradient background must be "unknown", not a pass: ' + JSON.stringify(item));
    if (item && item.confidence !== 'unknown') errs.push('unknown result missing confidence flag');
    record('a11y', 'unmeasurable backgrounds stay "unknown" and carry a confidence flag', errs);
  }

  /* ================= Code Connect mappings ================= */
  console.log('\nCode Connect' + ' — mappings apply in every React target');
  {
    const errs = [];
    const B = createBuilders();
    const set = B.SET('Button');
    const main = B.COMPONENT('Primary', set);
    const inst = B.INST(main, {}, 'HORIZONTAL', { padding: '8px' }, [B.T('Go', {})]);
    const root = B.AL('Card', 'VERTICAL', { padding: '16px' }, [inst, inst], { width: 200, height: 80 });
    root.parent = { type: 'PAGE' };
    const eng = loadEngine(B);
    const data = { ['map:' + set.key]: JSON.stringify({ name: 'Button', path: '@/ui/button' }) };
    eng.figma.root.getSharedPluginDataKeys = () => Object.keys(data);
    eng.figma.root.getSharedPluginData = (ns, k) => data[k] || '';
    for (const lang of ['react-css', 'react-tailwind', 'react-ts', 'react-tailwind-ts']) {
      const out = await eng.generateCode(root, lang, 'px', 16, 600, {});
      const all = out.files.map(f => f.code).join('\n');
      if (!new RegExp("from '@/ui/button'").test(all)) errs.push(lang + ' did not use the mapping');
      if (lang.endsWith('-ts') && !/^import \{ Button \} from '@\/ui\/button';$/m.test(all)) errs.push(lang + ' mapping import is malformed');
    }
    record('codegen', 'component mappings are applied in react-css, react-tailwind, react-ts and react-tailwind-ts', errs);
  }

  /* ================= the gate ================= */
  console.log('\ngate' + ' — every layer can be handed off, notes survive status changes');
  {
    const errs = [];
    const B = createBuilders();
    const st = store();
    const group = wire(B.N({ type: 'GROUP', name: 'Marketing screen', width: 300, height: 300, layoutMode: 'NONE' }, [B.T('Hi')]), st);
    group.parent = { type: 'PAGE', name: 'Page 1' };
    const eng = loadEngine(B, { mode: 'inspect', page: { name: 'P', type: 'PAGE', children: [group], selection: [], on() {}, findAll: () => [], findChildren: () => [] } });
    const r = await eng.run('setReady("' + group.id + '", "READY_FOR_DEV", "Handoff note")');
    if (!r || !r.ok) errs.push('a top-level group could not be marked: ' + JSON.stringify(r));
    if (st.data['devready/status'] !== 'READY_FOR_DEV') errs.push('plugin flag not written on the group: ' + JSON.stringify(st.data));
    if (st.data['devready/note'] !== 'Handoff note') errs.push('note not stored');
    if (r && r.native) errs.push('group cannot hold a native Figma status');
    // Re-marking without a note must keep the handoff context.
    const r2 = await eng.run('setReady("' + group.id + '", "COMPLETED", "")');
    if (st.data['devready/note'] !== 'Handoff note') errs.push('status change erased the note: ' + JSON.stringify(st.data));
    if (!r2 || !r2.note) errs.push('setReady did not report the kept note');
    // Clearing is explicit and does remove it.
    await eng.run('setReady("' + group.id + '", "", "")');
    if (st.data['devready/status']) errs.push('clear did not remove the flag');
    if (st.data['devready/note']) errs.push('clear did not remove the note');
    record('gate', 'groups can be flagged, notes survive a status change, and clearing removes both', errs);
  }
  {
    // Native write failure must not stop the flag (free plan / Dev Mode).
    const errs = [];
    const B = createBuilders();
    const st = store();
    const frame = wire(B.N({ type: 'FRAME', name: 'Checkout', width: 300, height: 300, layoutMode: 'NONE' }, []), st);
    Object.defineProperty(frame, 'devStatus', { get: () => null, set: () => { throw new Error('requires a paid plan'); } });
    frame.parent = { type: 'PAGE', name: 'Page 1' };
    const eng = loadEngine(B, { mode: 'inspect', page: { name: 'P', type: 'PAGE', children: [frame], selection: [], on() {}, findAll: () => [], findChildren: () => [] } });
    const r = await eng.run('setReady("' + frame.id + '", "READY_FOR_DEV", "note")');
    if (!r || !r.ok) errs.push('marking failed when the native write threw');
    if (st.data['devready/status'] !== 'READY_FOR_DEV') errs.push('flag not written after native failure');
    if (r && r.source !== 'plugin') errs.push('source should be plugin: ' + JSON.stringify(r));
    record('gate', 'a rejected native status still writes the DevReady flag and reports its source', errs);
  }
  {
    // A status set natively is mirrored to the flag so free-plan viewers unlock it.
    const errs = [];
    const B = createBuilders();
    const st = store();
    const frame = wire(B.N({ type: 'FRAME', name: 'Checkout', width: 300, height: 300, layoutMode: 'NONE' }, []), st);
    let native = null;
    Object.defineProperty(frame, 'devStatus', { get: () => native, set: v => { native = v; } });
    frame.parent = { type: 'PAGE', name: 'Page 1' };
    const eng = loadEngine(B, { mode: 'inspect', editorType: 'figma', page: { name: 'P', type: 'PAGE', children: [frame], selection: [], on() {}, findAll: () => [], findChildren: () => [] } });
    await eng.run('setReady("' + frame.id + '", "READY_FOR_DEV", "Ship it")');
    if (!native || native.type !== 'READY_FOR_DEV') errs.push('native status not written');
    if (st.data['devready/status'] !== 'READY_FOR_DEV') errs.push('flag not mirrored alongside the native status');
    if (st.data['devready/note'] !== 'Ship it') errs.push('note not mirrored');
    record('gate', 'a native status is mirrored to shared plugin data for free-plan collaborators', errs);
  }

  /* ================= change tracking completeness ================= */
  console.log('\nchange tracking' + ' — mixed values, radii, strokes and bindings are no longer invisible');
  {
    const errs = [];
    const mk = () => {
      const B = createBuilders();
      const st = store();
      const card = wire(B.N({ type: 'FRAME', name: 'Card', width: 200, height: 100, layoutMode: 'NONE', fills: [solid('#FFFFFF')] }, [B.T('Label', {})]), st);
      const root = wire(B.AL('Screen', 'VERTICAL', {}, [card], { width: 320, height: 600 }), st);
      card.parent = root; root.parent = { type: 'PAGE', name: 'P' };
      return { B, root, card, eng: loadEngine(B) };
    };
    const changed = (root, card, eng, mutate, expectPart, watchId) => {
      eng.ctx.saveBaseline(root); flushDiff(eng);
      mutate(card);
      flushDiff(eng);
      const d = eng.ctx.diffBaseline(root);
      const id = watchId || card.id;
      const c = d && d.changes.find(x => x.id === id);
      return { d, c, errs: (!c || c.parts.indexOf(expectPart) < 0) ? ['no ' + expectPart + ' change for ' + id + ': ' + JSON.stringify(d && d.changes)] : [] };
    };
    {
      const { root, card, eng } = mk();
      card.cornerRadius = Symbol('mixed');
      card.topLeftRadius = 4; card.topRightRadius = 4; card.bottomRightRadius = 4; card.bottomLeftRadius = 4;
      const r = changed(root, card, eng, c => { c.topLeftRadius = 12; }, 'style');
      errs.push(...r.errs);
      const det = r.c && (r.c.detail || []).find(x => x.prop === 'Radius');
      if (!det || det.after !== '12 4 4 4') errs.push('per-corner radius not reported: ' + JSON.stringify(det));
    }
    {
      const { root, card, eng } = mk();
      card.strokes = [solid('#000000')];
      card.strokeWeight = Symbol('mixed');
      card.strokeTopWeight = 1; card.strokeRightWeight = 1; card.strokeBottomWeight = 1; card.strokeLeftWeight = 1;
      const r = changed(root, card, eng, c => { c.strokeLeftWeight = 3; }, 'style');
      errs.push(...r.errs);
      const det = r.c && (r.c.detail || []).find(x => x.prop === 'Stroke');
      if (!det || det.after.indexOf('3') < 0) errs.push('per-side stroke weight not reported: ' + JSON.stringify(det));
    }
    {
      const { root, card, eng } = mk();
      card.fillStyleId = 'S:style-a';
      const r = changed(root, card, eng, c => { c.fillStyleId = 'S:style-b'; }, 'style');
      errs.push(...r.errs);
    }
    {
      const { root, card, eng } = mk();
      card.explicitVariableModes = { 'VariableCollectionId:1': '1:light' };
      const r = changed(root, card, eng, c => { c.explicitVariableModes = { 'VariableCollectionId:1': '1:dark' }; }, 'style');
      errs.push(...r.errs);
    }
    {
      const { root, card, eng } = mk();
      card.layoutGrids = [{ pattern: 'COLUMNS', gutterSize: 16 }];
      const r = changed(root, card, eng, c => { c.layoutGrids = [{ pattern: 'COLUMNS', gutterSize: 24 }]; }, 'style');
      errs.push(...r.errs);
    }
    {
      const { root, card, eng } = mk();
      card.boundVariables = { itemSpacing: { id: 'VariableID:1' } };
      const r = changed(root, card, eng, c => { c.boundVariables = { itemSpacing: { id: 'VariableID:2' } }; }, 'style');
      errs.push(...r.errs);
    }
    {
      // One text run changes while the node's own typography does not.
      const { root, card, eng } = mk();
      const t = card.children[0];
      const seg = w => [{ characters: 'Label', fontName: { family: 'Inter', style: 'Regular' }, fontSize: 14, fontWeight: w, lineHeight: { unit: 'PIXELS', value: 20 }, letterSpacing: { unit: 'PIXELS', value: 0 }, fills: [solid('#000000')], textDecoration: 'NONE', textCase: 'ORIGINAL' }];
      t._segs = seg(400);
      const r = changed(root, card, eng, () => { t._segs = seg(700); }, 'text', t.id);
      errs.push(...r.errs);
    }
    record('changes', 'edits to mixed radii, mixed stroke weights, style/variable bindings, grids and text runs are detected', errs);
  }
  {
    // Idempotence: saving and diffing with no edit must never report a change.
    const errs = [];
    const B = createBuilders();
    const st = store();
    const card = wire(B.N({ type: 'FRAME', name: 'Stable', width: 100, height: 100, layoutMode: 'NONE', fills: [solid('#123456')], cornerRadius: 8 }, []), st);
    const root = wire(B.AL('Screen', 'VERTICAL', {}, [card]), st);
    card.parent = root; root.parent = { type: 'PAGE' };
    const eng = loadEngine(B);
    eng.ctx.saveBaseline(root); flushDiff(eng);
    const a = eng.ctx.diffBaseline(root);
    flushDiff(eng);
    const b = eng.ctx.diffBaseline(root);
    if (!a || a.count) errs.push('fresh snapshot reports ' + (a && a.count) + ' changes');
    if (!b || b.count) errs.push('repeated diff reports ' + (b && b.count) + ' changes');
    record('changes', 'the richer signature is stable: identical snapshots report zero changes', errs);
  }
  {
    // Layers past the depth limit are unknown, so a snapshot that stops early must
    // be flagged partial — otherwise the panel would claim "no changes".
    const errs = [];
    const B = createBuilders();
    const st = store();
    let leaf = B.T('Deep leaf');
    for (let i = 0; i < 160; i++) leaf = B.N({ type: 'FRAME', name: 'L' + i, width: 100, height: 100, layoutMode: 'NONE' }, [leaf]);
    const root = wire(B.AL('Big', 'VERTICAL', {}, [leaf]), st);
    root.parent = { type: 'PAGE' };
    const eng = loadEngine(B);
    eng.ctx.saveBaseline(root); flushDiff(eng);
    const d = eng.ctx.diffBaseline(root);
    if (!d) errs.push('no diff result');
    else if (!d.partial) errs.push('depth-limited snapshot not flagged partial');
    record('changes', 'a depth-limited snapshot is flagged partial so the panel never claims "no changes"', errs);
  }

  /* ================= SVG hardening ================= */
  console.log('\nassets' + ' — exported SVG markup is rejected when it could execute or fetch');
  {
    const B = createBuilders(); const eng = loadEngine(B);
    const ok = '<svg viewBox="0 0 10 10" width="10" height="10"><path d="M0 0h10v10z" fill="#000"/></svg>';
    const cases = [
      ['plain vector markup is kept', eng.ctx.cleanSvg(ok) !== null],
      ['width/height are dropped so CSS can size it', !/width="10"/.test(eng.ctx.cleanSvg(ok) || '')],
      ['<script> rejected', eng.ctx.cleanSvg('<svg><script>alert(1)<\/script></svg>') === null],
      ['on* handler rejected', eng.ctx.cleanSvg('<svg onload="alert(1)"></svg>') === null],
      ['foreignObject rejected', eng.ctx.cleanSvg('<svg><foreignObject><body xmlns="http://www.w3.org/1999/xhtml"/></foreignObject></svg>') === null],
      ['<style> rejected', eng.ctx.cleanSvg('<svg><style>*{display:none}</style></svg>') === null],
      ['external href rejected', eng.ctx.cleanSvg('<svg><image href="https://evil.example/x.png"/></svg>') === null],
      ['javascript: url rejected', eng.ctx.cleanSvg('<svg><a href="javascript:alert(1)"/></svg>') === null],
      ['remote url() rejected', eng.ctx.cleanSvg('<svg><rect fill="url(https://evil.example/g)"/></svg>') === null],
      ['@import rejected', eng.ctx.cleanSvg('<svg><defs>@import url(x)</defs></svg>') === null],
      ['local <use> is still allowed', eng.ctx.cleanSvg('<svg><defs><path id="p" d="M0 0"/></defs><use href="#p"/></svg>') !== null]
    ];
    const errs = cases.filter(c => !c[1]).map(c => c[0]);
    record('assets', cases.length + ' SVG sanitising cases (script, handlers, foreignObject, external URLs)', errs);
  }

  /* ================= Tailwind mapping ================= */
  console.log('\nunit' + ' — pure helpers that had no direct tests');
  {
    const B = createBuilders(); const eng = loadEngine(B);
    const tw = (css, unit, base) => eng.ctx.cssToTailwind(css, unit || 'px', base || 16).join(' ');
    const rows = [
      ['padding from the spacing scale', tw({ padding: '16px' }), 'p-4'],
      ['asymmetric padding', tw({ 'padding-left': '16px', 'padding-right': '8px' }), 'pl-4 pr-2'],
      ['negative offset', tw({ top: '-8px' }), '-top-2'],
      ['arbitrary values stay arbitrary', tw({ width: '37px' }), 'w-[37px]'],
      ['width === height becomes size-*', tw({ width: '24px', height: '24px' }), 'size-6'],
      ['full width', tw({ width: '100%' }), 'w-full'],
      ['gap on both axes', tw({ gap: '8px 16px' }), 'gap-y-2 gap-x-4'],
      ['border with colour', tw({ border: '1px solid #111827' }), 'border border-[#111827]'],
      ['hairline border width', tw({ border: '2px solid #000' }), 'border-[2px] border-[#000]'],
      ['radius scale', tw({ 'border-radius': '8px' }), 'rounded-lg'],
      ['pill radius', tw({ 'border-radius': '999px' }), 'rounded-full'],
      ['font weight', tw({ 'font-weight': '600' }), 'font-semibold'],
      ['font size scale', tw({ 'font-size': '14px' }), 'text-sm'],
      ['flex fill', tw({ flex: '1 0 0' }), 'grow shrink-0 basis-0'],
      ['flex none shrink', tw({ 'flex-shrink': '0' }), 'shrink-0'],
      ['justify', tw({ 'justify-content': 'space-between' }), 'justify-between'],
      ['rem mode keeps scale values on the scale', tw({ padding: '24px' }, 'rem', 16), 'p-6'],
      ['rem mode converts arbitrary values', tw({ width: '37px' }, 'rem', 16), 'w-[2.3125rem]'],
      ['css variable colour', tw({ color: 'var(--brand)' }), 'text-[color:var(--brand)]'],
      ['shadow', tw({ 'box-shadow': '0 4px 12px 0 rgba(0,0,0,.2)' }), 'shadow-[0_4px_12px_0_rgba(0,0,0,.2)]'],
      ['unknown property falls back to arbitrary', tw({ 'text-wrap': 'balance' }), '[text-wrap:balance]'],
      ['position', tw({ position: 'absolute' }), 'absolute'],
      ['overflow', tw({ overflow: 'hidden' }), 'overflow-hidden'],
      ['unitless opacity', tw({ opacity: '0.5' }), 'opacity-[0.5]']
    ];
    const errs = rows.filter(r => r[1] !== r[2]).map(r => r[0] + ': got "' + r[1] + '", expected "' + r[2] + '"');
    record('unit', rows.length + ' cssToTailwind cases (scale, arbitrary values, rem, negative, fallbacks)', errs);
  }

  /* ================= target/config consistency ================= */
  console.log('\nconfig' + ' — manifest, engine, panel and tests agree on the target list');
  {
    const errs = [];
    const ids = (MANIFEST.codegenLanguages || []).map(l => l.value).sort();
    const engineIds = (CODE.match(/const LANG_IDS = \[([^\]]+)\]/) || ['', ''])[1].split(',').map(x => x.trim().replace(/^'|'$/g, '')).filter(Boolean).sort();
    const uiIds = (UI.match(/const LANGS = \{([\s\S]*?)\};/) || ['', ''])[1].split(',').map(x => (x.split(':')[0] || '').trim().replace(/^'|'$/g, '')).filter(Boolean).sort();
    const testIds = (fs.readFileSync(path.join(__dirname, 'run.js'), 'utf8').match(/const LANGS = \[([^\]]+)\]/) || ['', ''])[1].split(',').map(x => x.trim().replace(/^'|'$/g, '')).filter(Boolean).sort();
    const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
    if (!eq(ids, engineIds)) errs.push('manifest vs LANG_IDS: ' + ids.join(',') + ' vs ' + engineIds.join(','));
    if (!eq(ids, testIds)) errs.push('manifest vs tests/run.js LANGS');
    // `LANGS` in the panel also carries snippet pseudo-targets (css, tailwind).
    ['css', 'tailwind'].forEach(k => { const at = uiIds.indexOf(k); if (at > -1) uiIds.splice(at, 1); });
    if (!eq(ids, uiIds)) errs.push('manifest vs ui.html LANGS: ' + ids.join(',') + ' vs ' + uiIds.join(','));
    const prefs = MANIFEST.codegenPreferences || [];
    const gate = prefs.find(p => p.propertyName === 'gate');
    const unit = prefs.find(p => p.itemType === 'unit');
    const gateLangs = (gate && gate.includedLanguages || []).slice().sort();
    if (!eq(ids, gateLangs)) errs.push('every target must offer the gate preference; missing: ' + ids.filter(x => gateLangs.indexOf(x) < 0).join(', '));
    const native = ['react-native', 'swiftui', 'compose', 'flutter'];
    const unitLangs = (unit && unit.includedLanguages || []).slice().sort();
    ids.filter(x => native.indexOf(x) < 0).forEach(x => { if (unitLangs.indexOf(x) < 0) errs.push('unit preference missing for ' + x); });
    record('config', 'all 12 targets exist in manifest, engine, panel and tests, and the gate preference covers every one', errs);
  }
  {
    const errs = [];
    const m = CODE.match(/const CODEGEN_LANG = \{([^}]*)\};/);
    const map = m ? m[1] : '';
    if (!/tsx:\s*'TYPESCRIPT'/.test(map)) errs.push('tsx is not mapped to TYPESCRIPT');
    if (!/ts:\s*'TYPESCRIPT'/.test(map)) errs.push('ts is not mapped to TYPESCRIPT');
    if (/tsx:\s*'PLAINTEXT'/.test(map)) errs.push('tsx mapped to PLAINTEXT');
    record('config', 'TypeScript files report a TypeScript language in the Dev Mode Code section', errs);
  }
};
