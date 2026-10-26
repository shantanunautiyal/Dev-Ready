/**
 * Regression tests for the second hardening pass:
 *  - design tokens: alias chains, published library variables, unreadable values
 *  - degraded reads: failures are reported instead of swallowed by empty catches
 *  - change tracking: the snapshot byte budget truncates, and says so
 *  - single-file / static HTML: document language and direction from the text
 *  - exported SVG: entity-encoded and parser-level evasion
 */
'use strict';
const { createBuilders, loadEngine } = require('./harness');

const hex = h => ({ r: parseInt(h.slice(1, 3), 16) / 255, g: parseInt(h.slice(3, 5), 16) / 255, b: parseInt(h.slice(5, 7), 16) / 255 });
const solid = h => ({ type: 'SOLID', visible: true, color: hex(h), opacity: 1 });

/** A token world with an alias chain whose middle link is not exported. */
function tokenWorld() {
  const B = createBuilders();
  const theme = B.COLLECTION('Theme', ['Light', 'Dark']);
  const core = B.VAR(theme, 'core/ink', 'COLOR', { Light: { r: 0, g: 0, b: 0, a: 1 }, Dark: { r: 1, g: 1, b: 1, a: 1 } }, 'var(--core-ink)');
  // hidden → never part of the export, so referencing it would break the CSS
  const bridge = B.VAR(theme, 'internal/bridge', 'COLOR', { Light: core, Dark: core });
  const text = B.VAR(theme, 'color/text', 'COLOR', { Light: bridge, Dark: bridge });
  const gap = B.VAR(theme, 'spacing/gap', 'FLOAT', { Light: 8, Dark: 8 });
  return { B, theme, core, text, gap };
}

module.exports = async function enhancementTests(record) {
  const anyRecord = typeof record === 'function' ? record : () => {};

  /* ---------------- design tokens: aliases and libraries ---------------- */
  console.log('\ndesign tokens' + ' — alias chains, library variables and unreadable values');
  {
    const { B, gap } = tokenWorld();
    // the bridge variable is hidden from publishing: not in the export
    const bridgeId = Object.keys(B.VARS).find(id => B.VARS[id].name === 'internal/bridge');
    B.VARS[bridgeId].hiddenFromPublishing = true;
    void gap;
    const eng = loadEngine(B);
    const out = await eng.ctx.buildTokens('css', 'file', null, 'px', 16);
    const errs = [];
    if (!/--color-text: var\(--core-ink\);/.test(out.text)) errs.push('alias should resolve past the hidden link: ' + out.text.split('\n').filter(l => /color-text/.test(l)).join('|'));
    if (/--internal-bridge/.test(out.text)) errs.push('hidden variable leaked into the export');
    if (/--color-text: #/.test(out.text)) errs.push('alias fell back to a literal colour');
    if (out.stats.aliases !== 1) errs.push('stats.aliases should count the aliased token, got ' + out.stats.aliases);
    const json = await eng.ctx.buildTokens('json', 'file', null, 'px', 16);
    if (!/"\$value": "\{core\.ink\}"/.test(json.text)) errs.push('JSON alias should point at the exported path: ' + json.text.slice(0, 400));
    anyRecord('tokens', 'an alias resolves past a hidden middle link; nothing hidden leaks into the export', errs);
  }
  {
    // Alias target that exists but is not in the selection-scope export: write the
    // literal instead of var(--undefined).
    const B = createBuilders();
    const theme = B.COLLECTION('Theme', ['Light']);
    const base = B.VAR(theme, 'palette/blue', 'COLOR', { Light: { r: 0.05, g: 0.6, b: 1, a: 1 } }, 'var(--palette-blue)');
    const alias = B.VAR(theme, 'semantic/link', 'COLOR', { Light: base });
    void alias;
    const frame = B.AL('Card', 'VERTICAL', {}, [B.T('Link')]);
    frame.boundVariables = { fills: [alias] };
    frame.fills = [solid('#0D99FF')];
    frame.parent = { type: 'PAGE' };
    const eng = loadEngine(B);
    // Selection scope exports only the variables the selection uses.
    eng.run('(function(){ var keep = ' + JSON.stringify(Object.keys(B.VARS).filter(id => B.VARS[id].name === 'semantic/link')) + '; })()');
    const out = await eng.ctx.buildTokens('css', 'selection', frame, 'px', 16);
    const errs = [];
    if (!out.text) errs.push('no output');
    else if (/var\(--palette-blue\)/.test(out.text)) errs.push('selection export references a token it does not define, and has no fallback that works');
    if (out.stats.unresolved) errs.push('a resolvable alias was reported unresolved');
    anyRecord('tokens', 'a selection export never references a token it does not define', errs);
  }
  {
    // Published library variables are part of the file's tokens.
    const B = createBuilders();
    const local = B.COLLECTION('Local', ['Light']);
    B.VAR(local, 'local/one', 'COLOR', { Light: { r: 1, g: 0, b: 0, a: 1 } });
    const eng = loadEngine(B);
    const libraryVar = { id: 'lib-var-1', name: 'brand/primary', resolvedType: 'COLOR', variableCollectionId: 'lib-coll-1', valuesByMode: { 'lib-mode-1': { r: 0.05, g: 0.6, b: 1, a: 1 } }, codeSyntax: { WEB: 'var(--brand-primary)' } };
    B.VARS[libraryVar.id] = libraryVar;
    eng.figma.variables.getAvailableLibraryVariableCollectionsAsync = async () => [{ id: 'lib-coll-1', key: 'lib-key-1', name: 'Brand (library)', modes: [{ modeId: 'lib-mode-1', name: 'Light' }], defaultModeId: 'lib-mode-1' }];
    eng.figma.variables.getVariablesInLibraryCollectionAsync = async key => (key === 'lib-key-1' ? [libraryVar] : []);
    // getLocalVariablesAsync must not return the library variable (Figma does not)
    eng.figma.variables.getLocalVariablesAsync = async () => [B.VARS[Object.keys(B.VARS).find(id => B.VARS[id].name === 'local/one')]];
    const out = await eng.ctx.buildTokens('css', 'file', null, 'px', 16);
    const errs = [];
    if (!/--brand-primary: #0D99FF;/.test(out.text)) errs.push('library variable missing from the export: ' + out.text);
    if (out.stats.library !== 1) errs.push('stats.library should be 1, got ' + out.stats.library);
    if (!/published library variable/.test(out.text)) errs.push('header should say library variables are included: ' + out.text.split('\n')[0]);
    if (!/--local-one: #FF0000;/.test(out.text)) errs.push('local variables were dropped');
    // A library collection that cannot be read must not break the export.
    eng.figma.variables.getVariableCollectionByIdAsync = async () => null;
    eng.figma.variables.getAvailableLibraryVariableCollectionsAsync = async () => { throw new Error('no libraries'); };
    eng.run('Object.keys(collCache).forEach(k => delete collCache[k])');
    const again = await eng.ctx.buildTokens('css', 'file', null, 'px', 16);
    if (!/--brand-primary/.test(again.text) && !/--local-one/.test(again.text)) errs.push('an unreadable collection broke the whole export');
    anyRecord('tokens', 'published library variables are exported, and an unreadable collection degrades quietly', errs);
  }
  {
    // A value the file cannot read (remote variable) is kept and flagged, not dropped.
    const B = createBuilders();
    const theme = B.COLLECTION('Theme', ['Light']);
    B.VARS['ghost'] = { id: 'ghost', name: 'color/ghost', resolvedType: 'COLOR', variableCollectionId: theme.id, valuesByMode: { 'Light-id': { type: 'VARIABLE_ALIAS', id: 'not-in-this-file' } } };
    const eng = loadEngine(B);
    eng.figma.variables.getLocalVariablesAsync = async () => [B.VARS.ghost];
    const out = await eng.ctx.buildTokens('json', 'file', null, 'px', 16);
    const errs = [];
    let j = null; try { j = JSON.parse(out.text); } catch (e) { errs.push('invalid JSON: ' + e.message); }
    const leaf = j && j.color && j.color.ghost;
    if (!leaf) errs.push('unresolved token was dropped from the JSON export');
    else if (leaf.$value !== null) errs.push('unresolved token should carry $value: null, got ' + JSON.stringify(leaf.$value));
    if (out.stats.unresolved !== 1) errs.push('stats.unresolved should be 1, got ' + out.stats.unresolved);
    if (!/could not be resolved/.test(out.text)) errs.push('header should mention the unresolved token');
    anyRecord('tokens', 'a token whose value cannot be read is kept and flagged, never silently dropped', errs);
  }
  {
    // Two variables aliasing each other must terminate.
    const B = createBuilders();
    const theme = B.COLLECTION('Theme', ['Light']);
    B.VARS['a'] = { id: 'a', name: 'loop/a', resolvedType: 'COLOR', variableCollectionId: theme.id, valuesByMode: { 'Light-id': { type: 'VARIABLE_ALIAS', id: 'b' } } };
    B.VARS['b'] = { id: 'b', name: 'loop/b', resolvedType: 'COLOR', variableCollectionId: theme.id, valuesByMode: { 'Light-id': { type: 'VARIABLE_ALIAS', id: 'a' } } };
    const eng = loadEngine(B);
    eng.figma.variables.getLocalVariablesAsync = async () => [B.VARS.a, B.VARS.b];
    const errs = [];
    const out = await eng.ctx.buildTokens('css', 'file', null, 'px', 16).catch(e => { errs.push('alias loop threw: ' + e.message); return null; });
    if (out && /undefined|null/.test(out.text)) errs.push('alias loop wrote an invalid value: ' + out.text);
    if (out && !out.stats.unresolved) errs.push('a cyclic alias should be reported as unresolved');
    anyRecord('tokens', 'a cyclic alias terminates and is reported, not written as "undefined"', errs);
  }

  /* ---------------- degraded reads are reported ---------------- */
  console.log('\ndiagnostics' + ' — a failed Figma read leaves a note behind');
  {
    const B = createBuilders();
    const eng = loadEngine(B);
    eng.figma.variables.getLocalVariablesAsync = async () => { throw new Error('variables API unavailable'); };
    eng.figma.getLocalPaintStylesAsync = async () => { throw new Error('styles unavailable'); };
    eng.run('clearDiagnostics()');
    const out = await eng.ctx.buildTokens('css', 'file', null, 'px', 16);
    const list = eng.run('takeDiagnostics()');
    const errs = [];
    if (!list.length) errs.push('no diagnostics recorded');
    if (!list.some(d => d.where === 'local variables')) errs.push('missing local-variable note: ' + JSON.stringify(list));
    if (!list.some(d => /unavailable/.test(d.detail))) errs.push('the error message is not kept: ' + JSON.stringify(list));
    if (out.empty !== true && out.stats.variables !== 0) errs.push('export should be empty when nothing was readable');
    if (eng.run('takeDiagnostics()').length !== list.length) errs.push('diagnostics are cleared between reads');
    // bounded: a broken loop cannot flood the list
    eng.run('clearDiagnostics()');
    for (let i = 0; i < 40; i++) eng.run("diag('step ' + " + i + ", new Error('x'))");
    if (eng.run('takeDiagnostics().length') > 12) errs.push('diagnostics are not capped');
    if (eng.run("(function(){ clearDiagnostics(); for (var i = 0; i < 5; i++) diag('same', new Error('x')); return takeDiagnostics().length; })()") !== 1) errs.push('duplicate notes are not collapsed');
    anyRecord('diagnostics', 'failed reads are recorded with their message, capped and de-duplicated', errs);
  }
  {
    // A read that fails during a pass reaches the panel with that pass's answer.
    const B = createBuilders();
    const frame = B.AL('Card', 'VERTICAL', {}, [B.T('Title')]);
    frame.parent = { type: 'PAGE' };
    const eng = loadEngine(B, { mode: 'inspect', editorType: 'dev', selection: [frame] });
    eng.figma.variables.getLocalVariablesAsync = async () => { throw new Error('variables API unavailable'); };
    eng.posted.length = 0;
    await eng.send({ type: 'ui-ready' });
    await new Promise(r => setTimeout(r, 260));
    const state = eng.posted.filter(m => m.type === 'state').pop();
    const errs = [];
    if (!state) errs.push('no state posted');
    else if (!Array.isArray(state.diagnostics)) errs.push('inspect state has no diagnostics array');
    // The token export is a separate request: its notes travel with its answer.
    await eng.send({ type: 'tokens-export', format: 'css', scope: 'file' });
    const tok = eng.posted.filter(m => m.type === 'tokens').pop();
    if (!tok) errs.push('no tokens response');
    else if (!Array.isArray(tok.diagnostics) || !tok.diagnostics.some(d => d.where === 'local variables')) errs.push('token notes not forwarded: ' + JSON.stringify(tok && tok.diagnostics));
    anyRecord('diagnostics', 'a failed read travels with the state and token answers the panel renders', errs);
  }

  /* ---------------- snapshot budget ---------------- */
  console.log('\nchange tracking' + ' — the snapshot has a byte budget, not only a layer cap');
  {
    const B = createBuilders();
    const st = { data: {}, get: () => '', set() {} };
    const kids = [];
    for (let i = 0; i < 200; i++) kids.push(B.AL('Row ' + i, 'HORIZONTAL', {}, [B.T('A fairly long label that costs bytes in the snapshot ' + i)]));
    const root = B.AL('Big', 'VERTICAL', {}, kids);
    root.parent = { type: 'PAGE' };
    const eng = loadEngine(B);
    const small = eng.ctx.snapshot(root, 2500, 2000);
    const errs = [];
    if (!small.__partial) errs.push('a snapshot past the byte budget is not flagged partial');
    const size = JSON.stringify(small).length;
    if (size > 4000) errs.push('byte budget ignored: ' + size + ' units');
    const roomy = eng.ctx.snapshot(root, 2500, 4e6);
    if (roomy.__partial) errs.push('a snapshot inside the budget is wrongly flagged partial');
    if (Object.keys(roomy).length < 100) errs.push('full snapshot lost layers: ' + Object.keys(roomy).length);
    void st;
    const d = eng.ctx.diffBaseline(root);
    if (d && !d.budget) errs.push('diff result does not expose the budget');
    anyRecord('changes', 'the snapshot stops at a byte budget and flags itself partial', errs);
  }

  /* ---------------- document language and direction ---------------- */
  console.log('\nstatic HTML' + ' — lang/dir follow the text that is actually in the design');
  {
    const cases = [
      ['english keeps lang="en"', 'Save changes', /<html lang="en">/, /dir=/],
      ['japanese', '保存する', /<html lang="ja">/, /dir=/],
      ['arabic is right-to-left', 'حفظ التغييرات', /<html lang="ar" dir="rtl">/, null],
      ['hebrew is right-to-left', 'שמור שינויים', /<html lang="he" dir="rtl">/, null],
      ['devanagari', 'सहेजें', /<html lang="hi">/, /dir=/]
    ];
    const errs = [];
    for (const [name, chars, want, not] of cases) {
      const B = createBuilders();
      const card = B.AL('Card', 'VERTICAL', {}, [B.T(chars)]);
      card.parent = { type: 'PAGE' };
      const eng = loadEngine(B);
      for (const lang of ['html-single', 'html-css']) {
        const out = await eng.generateCode(card, lang, 'px', 16, 600, {});
        const code = out.files.map(f => f.code).join('\n');
        if (!want.test(code)) errs.push(name + ' (' + lang + '): ' + (code.match(/<html[^>]*>/) || ['no <html>'])[0]);
        if (not && not.test(code)) errs.push(name + ' (' + lang + '): unexpected dir attribute');
      }
    }
    const B = createBuilders();
    const mixed = B.AL('Card', 'VERTICAL', {}, [B.T('Hello'), B.T('こんにちは世界、これはテストです')]);
    mixed.parent = { type: 'PAGE' };
    const eng = loadEngine(B);
    const out = await eng.generateCode(mixed, 'html-single', 'px', 16, 600, {});
    if (!/lang="ja"/.test(out.files[0].code)) errs.push('the dominant script should win, not the first layer');
    anyRecord('static HTML', 'lang and dir are derived from the text (CJK, Arabic, Hebrew, Devanagari)', errs);
  }

  /* ---------------- SVG evasion ---------------- */
  console.log('\nassets' + ' — SVG checks that see what a parser sees');
  {
    const B = createBuilders(); const eng = loadEngine(B);
    const ok = '<svg viewBox="0 0 10 10"><path d="M0 0h10v10z" fill="#000"/></svg>';
    const cases = [
      ['plain markup still passes', eng.ctx.cleanSvg(ok) !== null],
      ['entity-encoded scheme rejected', eng.ctx.cleanSvg('<svg><a href="javascript&#58;alert(1)"/></svg>') === null],
      ['hex entity in a handler name rejected', eng.ctx.cleanSvg('<svg><rect onlo&#97;d="x"/></svg>') === null],
      ['no-space handler rejected', eng.ctx.cleanSvg('<svg/onload=alert(1)>') === null],
      ['uppercase handler rejected', eng.ctx.cleanSvg('<svg ONLOAD="alert(1)"></svg>') === null],
      ['newline before handler rejected', eng.ctx.cleanSvg('<svg\n onload="alert(1)"></svg>') === null],
      ['external <use> rejected', eng.ctx.cleanSvg('<svg><use href="https://evil.example/s.svg#a"/></svg>') === null],
      ['local <use> still allowed', eng.ctx.cleanSvg('<svg><defs><path id="p" d="M0 0"/></defs><use href="#p"/></svg>') !== null],
      ['animate rewriting a href rejected', eng.ctx.cleanSvg('<svg><a href="#x"><animate attributeName="xlink:href" to="javascript:alert(1)"/></a></svg>') === null],
      ['remote feImage rejected', eng.ctx.cleanSvg('<svg><filter><feImage href="https://evil.example/x"/></filter></svg>') === null],
      ['CSS expression rejected', eng.ctx.cleanSvg('<svg><rect fill="expression(alert(1))"/></svg>') === null],
      ['data:image/svg script rejected', eng.ctx.cleanSvg('<svg><image href="data:image/svg+xml;base64,PHN2Zz4="/></svg>') === null],
      ['inline data URI image is fine in a <path> fill', eng.ctx.cleanSvg('<svg><path d="M0 0" fill="url(#g)"/></svg>') !== null]
    ];
    const errs = cases.filter(c => !c[1]).map(c => c[0]);
    anyRecord('assets', cases.length + ' parser-level SVG cases (entities, no-space handlers, animate, feImage)', errs);
  }
};
