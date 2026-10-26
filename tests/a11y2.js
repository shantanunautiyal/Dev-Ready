/**
 * Accessibility 2.0 — the rules beyond text contrast.
 *
 *   • non-text contrast for icons and control outlines (WCAG 1.4.11)
 *   • image alternatives (1.1.1)
 *   • heading order (1.3.1)
 *   • field labels (3.3.2)
 *   • ignore-with-reason, stored in the file and carried into the report
 *   • Markdown/CSV export
 */
'use strict';
const { createBuilders, loadEngine } = require('./harness');
const { loadPanel } = require('./unit-ui');

const hex = h => ({ r: parseInt(h.slice(1, 3), 16) / 255, g: parseInt(h.slice(3, 5), 16) / 255, b: parseInt(h.slice(5, 7), 16) / 255 });
const solid = h => [{ type: 'SOLID', visible: true, opacity: 1, color: hex(h) }];

/** A white screen holding whatever the test needs. */
function screen(B, kids) {
  const root = B.ABS('Screen', 420, 320, { 'background-color': '#FFFFFF' }, kids, { fills: solid('#FFFFFF') });
  root.parent = { type: 'PAGE' };
  return root;
}

module.exports = async function a11y2Tests(record) {
  /* ================= non-text contrast ================= */
  console.log('\naccessibility' + ' — icons and outlines, not just text');
  {
    const B = createBuilders();
    const lowIcon = B.N({ type: 'FRAME', name: 'icon/eye', width: 24, height: 24, fills: solid('#DDDDDD') }, [B.N({ type: 'VECTOR', name: 'Vector', width: 24, height: 24 })]);
    const okIcon = B.N({ type: 'FRAME', name: 'icon/star', width: 24, height: 24, fills: solid('#333333') }, [B.N({ type: 'VECTOR', name: 'Vector', width: 24, height: 24 })]);
    const button = B.AL('Button', 'HORIZONTAL', { padding: '8px 12px' }, [B.T('Save', {})], { width: 90, height: 36, strokes: solid('#EBEBEB'), strokeWeight: 1 });
    const root = screen(B, [lowIcon, okIcon, button]);
    const eng = loadEngine(B);
    const audit = eng.ctx.a11yAudit(root, 400, {});
    const errs = [];
    const nonText = audit.items.filter(i => i.kind === 'nontext');
    const low = nonText.filter(i => i.id === lowIcon.id)[0];
    const ok = nonText.filter(i => i.id === okIcon.id)[0];
    const outline = nonText.filter(i => i.id === button.id)[0];
    if (!low) errs.push('a low-contrast icon was not measured');
    else if (low.status !== 'fail') errs.push('a 1.4:1 icon passed: ' + low.status + ' ' + low.ratio);
    else if (low.need !== 3) errs.push('non-text needs 3:1, got ' + low.need);
    if (!ok || ok.status !== 'pass') errs.push('a 12:1 icon did not pass: ' + JSON.stringify(ok && ok.status));
    if (!outline) errs.push('a control outline was not measured');
    else if (outline.status !== 'fail') errs.push('a 1.1:1 outline passed');
    if (nonText.some(i => i.rule !== '1.4.11')) errs.push('a non-text finding has the wrong WCAG reference');
    // Passing icons are still reported, so "no findings" cannot hide an unmeasured icon.
    if (nonText.length < 3) errs.push('expected three non-text rows, got ' + nonText.length);
    record('accessibility', 'icons and control outlines are measured at 3:1 (WCAG 1.4.11)', errs, nonText.length + ' measured');
  }

  /* ================= image alternatives ================= */
  console.log('accessibility' + ' — image alt text');
  {
    const B = createBuilders();
    const auto = B.IMG('Rectangle 12', 100, 80);
    const described = B.IMG('Team photo', 100, 80);
    const decorative = B.IMG('decorative background', 100, 80);
    const root = screen(B, [auto, described, decorative]);
    const eng = loadEngine(B);
    const audit = eng.ctx.a11yAudit(root, 400, {});
    const errs = [];
    const byId = id => audit.items.filter(i => i.kind === 'alt' && i.id === id)[0];
    if (!byId(auto.id) || byId(auto.id).status !== 'warn') errs.push('an auto-named image was not flagged');
    else if (!/rename/i.test(byId(auto.id).detail)) errs.push('the finding does not say what to do: ' + byId(auto.id).detail);
    if (!byId(described.id) || byId(described.id).status !== 'pass') errs.push('a descriptive name was not accepted');
    if (!byId(decorative.id) || byId(decorative.id).status !== 'pass') errs.push('a decorative image was not recognised');
    else if (!/alt=""|aria-hidden/.test(byId(decorative.id).detail)) errs.push('decorative guidance is missing');
    if (audit.items.some(i => i.kind === 'alt' && i.rule !== '1.1.1')) errs.push('alt findings carry the wrong rule');
    // An icon with an image fill stays artwork, not a content image.
    const rasterIcon = B.N({ type: 'FRAME', name: 'icon/avatar', width: 24, height: 24 }, [B.IMG('Vector', 24, 24)]);
    const root2 = screen(B, [rasterIcon]);
    const audit2 = loadEngine(B).ctx.a11yAudit(root2, 400, {});
    if (audit2.items.some(i => i.kind === 'alt')) errs.push('a raster icon inside an icon layer was treated as a content image');
    record('accessibility', 'image layers need a descriptive name, decorative ones are recognised (WCAG 1.1.1)', errs);
  }

  /* ================= heading order ================= */
  console.log('accessibility' + ' — heading order and field labels');
  {
    const B = createBuilders();
    const skip = screen(B, [B.T('Title', { 'font-size': '40px' }, { fills: solid('#111111') }), B.T('Sub', { 'font-size': '20px' }, { fills: solid('#111111') })]);
    const fine = screen(B, [B.T('Title', { 'font-size': '40px' }, { fills: solid('#111111') }), B.T('Sub', { 'font-size': '26px' }, { fills: solid('#111111') })]);
    const eng = loadEngine(B);
    const errs = [];
    const a1 = eng.ctx.a11yAudit(skip, 400, {});
    const heads1 = a1.items.filter(i => i.kind === 'heading');
    if (!heads1.length) errs.push('a 1 → 3 heading jump was not reported');
    else if (!/jump from 1 to 3/.test(heads1[0].detail)) errs.push('the heading detail is unclear: ' + heads1[0].detail);
    if (heads1.some(i => i.rule !== '1.3.1')) errs.push('heading findings carry the wrong rule');
    const a2 = eng.ctx.a11yAudit(fine, 400, {});
    if (a2.items.some(i => i.kind === 'heading')) errs.push('1 → 2 was reported as a skip');
    if (JSON.stringify(a1.headingLevels.slice(0, 2)) !== '[1,3]') errs.push('heading levels: ' + JSON.stringify(a1.headingLevels));
    if (eng.ctx.headingLevel(18, 400) !== 0 || eng.ctx.headingLevel(18, 700) !== 4 || eng.ctx.headingLevel(32, 400) !== 1) errs.push('headingLevel thresholds are wrong');
    record('accessibility', 'heading levels follow the type scale and skipped levels are reported (WCAG 1.3.1)', errs, 'levels ' + a1.headingLevels.join('→'));
  }
  {
    const B = createBuilders();
    const bare = B.AL('Email input', 'HORIZONTAL', { padding: '8px' }, [], { width: 200, height: 36, strokes: solid('#111111'), strokeWeight: 1, fills: solid('#FFFFFF') });
    const labelled = B.AL('Search field', 'HORIZONTAL', { padding: '8px' }, [B.T('Search', {})], { width: 200, height: 36, fills: solid('#FFFFFF') });
    const root = screen(B, [bare, labelled]);
    const eng = loadEngine(B);
    const audit = eng.ctx.a11yAudit(root, 400, {});
    const errs = [];
    const b = audit.items.filter(i => i.kind === 'form' && i.id === bare.id)[0];
    const l = audit.items.filter(i => i.kind === 'form' && i.id === labelled.id)[0];
    if (!b || b.status !== 'warn') errs.push('an unlabelled field was not reported');
    else if (!/label/i.test(b.detail)) errs.push('the field finding does not mention a label');
    if (!l || l.status !== 'pass') errs.push('a labelled field was not accepted');
    if (audit.items.some(i => i.kind === 'form' && i.rule !== '3.3.2')) errs.push('form findings carry the wrong rule');
    record('accessibility', 'fields named like inputs need visible text (WCAG 3.3.2)', errs);
  }

  /* ================= ignore with reason ================= */
  console.log('accessibility' + ' — review decisions, stored in the file');
  {
    const B = createBuilders();
    const text = B.T('Muted label', { 'font-size': '12px' }, { fills: solid('#DDDDDD') });
    const root = screen(B, [text]);
    const eng = loadEngine(B);
    const errs = [];
    const first = eng.ctx.a11yAudit(root, 400, {});
    const failing = first.items.filter(i => i.status === 'fail')[0];
    if (!failing) errs.push('the fixture produced no failure to ignore');
    const map = {};
    map[text.id] = 'Brand exception';
    const audit = eng.ctx.a11yAudit(root, 400, map);
    if (audit.items.some(i => i.id === text.id)) errs.push('an ignored layer still appears in the findings');
    if (!audit.counts.ignored) errs.push('counts.ignored is missing');
    const ig = audit.ignored[0];
    if (!ig || ig.reason !== 'Brand exception') errs.push('the reason was not carried: ' + JSON.stringify(ig));
    if (!ig || ig.kinds.indexOf('contrast') < 0) errs.push('the ignored kinds are not recorded');
    if (!ig || (ig.rules || []).indexOf('1.4.3') < 0) errs.push('an ignored finding does not keep its criterion');

    // Round-trip through the file, with caps.
    eng.ctx.writeA11yIgnore({ '1:1': 'Decorative', '2:2': '' });
    const back = await eng.ctx.readA11yIgnore();
    if (back['1:1'] !== 'Decorative') errs.push('ignore map did not round-trip');
    if (back['2:2'] !== 'Ignored') errs.push('an empty reason was not normalised: ' + JSON.stringify(back['2:2']));
    const many = {};
    for (let i = 0; i < 300; i++) many['n' + i] = 'x';
    eng.ctx.writeA11yIgnore(many);
    const capped = await eng.ctx.readA11yIgnore();
    if (Object.keys(capped).length > 120) errs.push('the ignore map is not capped: ' + Object.keys(capped).length);
    // Garbage in the file is ignored, not fatal.
    eng.figma.root.setSharedPluginData('devready', 'a11y-ignore', '[1,2,3]');
    const junk = await eng.ctx.readA11yIgnore();
    if (Object.keys(junk).length) errs.push('a non-object ignore map was accepted');
    record('accessibility', 'ignoring a finding stores a reason in the file, capped and validated', errs, 'reasons: 6 presets');
  }

  /* ================= messages ================= */
  console.log('accessibility' + ' — the message round trip');
  {
    const B = createBuilders();
    const text = B.T('Low contrast', { 'font-size': '12px' }, { fills: solid('#EEEEEE') });
    const root = screen(B, [text]);
    const eng = loadEngine(B, { mode: 'inspect', editorType: 'dev', selection: [root] });
    const errs = [];
    // Strict mode hides the audit behind a ready flag; these messages are not about that.
    await eng.send({ type: 'settings', settings: { gate: 'off' } });
    await eng.send({ type: 'ui-ready' });
    await new Promise(r => setTimeout(r, 200));
    const before = eng.posted.filter(m => m.type === 'state').pop();
    if (!before || !before.a11y || !before.a11y.counts) errs.push('the state carries no audit');
    else if (!before.a11y.counts.fail) errs.push('the fixture produced no failing finding');
    await eng.send({ type: 'a11y-ignore', ids: [text.id], reason: 'Legacy design' });
    const stored = eng.figma.root.getSharedPluginData('devready', 'a11y-ignore');
    if (!/Legacy design/.test(stored || '')) errs.push('the decision was not written to the file');
    const ignoredReply = eng.posted.filter(m => m.type === 'a11y-ignored').pop();
    if (!ignoredReply || ignoredReply.ignored !== 1) errs.push('no confirmation: ' + JSON.stringify(ignoredReply));
    await new Promise(r => setTimeout(r, 200));
    const after = eng.posted.filter(m => m.type === 'state').pop();
    if (!after || !after.a11y || !after.a11y.counts.ignored) errs.push('the refreshed state did not carry the ignored count');
    else if (after.a11y.items.some(i => i.id === text.id)) errs.push('the ignored finding is still listed');

    // Reports
    await eng.send({ type: 'a11y-report', format: 'md' });
    const md = eng.posted.filter(m => m.type === 'a11y-report').pop();
    if (!md || !md.out || md.out.format !== 'md') errs.push('no Markdown report');
    else {
      if (!/^# Accessibility report/m.test(md.out.text)) errs.push('the report has no title');
      if (!/1\.4\.3/.test(md.out.text)) errs.push('the report does not cite the rule');
      if (!/Legacy design/.test(md.out.text)) errs.push('the report drops the review decision');
      if (!/Legacy design \(contrast \u00b7 WCAG 1\.4\.3\)/.test(md.out.text)) errs.push('the ignored finding does not keep its criterion: ' + JSON.stringify((md.out.text.match(/^- .*$/gm) || []).slice(-1)));
      if (!/\.md$/.test(md.out.file)) errs.push('the report filename is wrong: ' + md.out.file);
      if (!/Count/.test(md.out.text)) errs.push('the report has no counts table');
    }
    await eng.send({ type: 'a11y-report', format: 'csv' });
    const csv = eng.posted.filter(m => m.type === 'a11y-report').pop();
    if (!csv || !csv.out || !/^"status","rule"/.test(csv.out.text)) errs.push('no CSV report');
    if (!/\.csv$/.test((csv && csv.out && csv.out.file) || '')) errs.push('the CSV filename is wrong');

    // Unignore brings it back.
    await eng.send({ type: 'a11y-unignore', ids: [text.id] });
    const cleared = eng.figma.root.getSharedPluginData('devready', 'a11y-ignore');
    if (/Legacy design/.test(cleared || '')) errs.push('unignore did not clear the decision');
    record('accessibility', 'ignore, unignore and both report formats work end to end', errs);
  }
  {
    // Report escaping and empty audits.
    const B = createBuilders();
    const eng = loadEngine(B);
    const errs = [];
    const empty = eng.ctx.a11yReport(null, 'md', { name: 'Empty' });
    if (!/No failing or reviewable findings/.test(empty.text)) errs.push('an empty audit has no empty state');
    if (!/Checked 0 layers/.test(empty.text)) errs.push('an empty audit does not say what was checked');
    const csv = eng.ctx.a11yReport(null, 'csv', { name: 'Empty' });
    if (!/^"status"/.test(csv.text)) errs.push('the empty CSV has no header');
    // A hostile layer name must not break the table or the CSV.
    const name = 'Label, "quoted" | pipe\nnewline';
    const audit = { counts: { fail: 1, warn: 0, pass: 0, unknown: 0, ignored: 0 }, byRule: { '1.4.3': 1 }, scanned: 3,
      groups: [{ status: 'fail', rule: '1.4.3', kind: 'contrast', count: 1, ids: ['1:1'], item: { name: name, detail: 'low contrast', ratio: 2.1 } }], ignored: [] };
    const out = eng.ctx.a11yReport(audit, 'md', { name: name });
    // The download name comes from a layer name, so it must not become a path.
    const nasty = eng.ctx.a11yReport(audit, 'md', { name: '../../etc/Pass Word' });
    if (!/^devready-a11y-[a-z0-9-]+\.md$/.test(nasty.file)) errs.push('the report filename is not a safe slug: ' + nasty.file);
    if (!/^devready-a11y-/.test(eng.ctx.a11yReport(audit, 'csv', { name: '../../etc/pass wd' }).file)) errs.push('the CSV filename is not a safe slug');
    if (/\nnewline/.test(out.text)) errs.push('a newline in a layer name breaks the Markdown table');
    if (!/quoted" \| pipe newline/.test(out.text)) errs.push('the layer name is not flattened into one line: ' + JSON.stringify(out.text.split('\n').filter(l => /pipe/.test(l))));
    const rows = eng.ctx.a11yReport(audit, 'csv', { name: 'x' }).text.split('\n');
    const dataRow = rows.filter(r => /1\.4\.3/.test(r))[0] || '';
    if (!/""quoted""/.test(dataRow)) errs.push('the CSV does not escape quotes: ' + dataRow);
    if ((dataRow.match(/"/g) || []).length % 2) errs.push('the CSV row has unbalanced quotes');
    record('accessibility', 'reports escape hostile names and describe an empty audit honestly', errs);
  }

  /* ================= panel ================= */
  console.log('accessibility' + ' — the panel surface');
  {
    const P = loadPanel();
    const S = P.get('S');
    const errs = [];
    S.data = {
      mode: 'inspect', spec: { id: '1:1', name: 'Card', type: 'FRAME' },
      settings: { gate: 'off', unit: 'px', remBase: 16, colorFormat: 'hex', previewFonts: 'google', svgFrames: 'auto' },
      a11y: {
        scanned: 9, limited: false, depthLimited: false,
        counts: { fail: 1, warn: 1, pass: 1, unknown: 0, ignored: 2 },
        byRule: { '1.4.3': 1, '1.4.11': 0 },
        groups: [
          { key: 'a', rule: '1.4.3', kind: 'contrast', status: 'fail', count: 3, ids: ['2:2', '3:3'], item: { id: '2:2', name: 'Muted label', kind: 'contrast', status: 'fail', fg: '#DDDDDD', bg: '#FFFFFF', ratio: 1.4, need: 4.5 } },
          { key: 'b', rule: '1.1.1', kind: 'alt', status: 'warn', count: 1, ids: ['4:4'], item: { id: '4:4', name: 'Rectangle 12', kind: 'alt', status: 'warn', detail: 'Layer name is auto-generated' } }
        ],
        items: [{ id: '2:2', name: 'Muted label', kind: 'contrast', status: 'fail', fg: '#DDDDDD', bg: '#FFFFFF', ratio: 1.4, need: 4.5 }],
        ignored: [{ id: '5:5', name: 'Decorative blob', reason: 'Decorative', kinds: ['nontext'] }],
        reasons: ['Decorative', 'Brand exception', 'False positive']
      }
    };
    const html = P.get('secA11y')(S.data);
    if (!/Ignore/.test(html)) errs.push('no Ignore control');
    if (!/Export report/.test(html)) errs.push('no report control');
    if (!/1 ignored/.test(html)) errs.push('the ignored count is not shown');
    if (!/data-act="a11y-ignore-menu" data-ids="2:2,3:3"/.test(html)) errs.push('the ignore control does not carry the group ids');
    if (!/WCAG 2\.2 AA/.test(html)) errs.push('the section does not explain the rules');
    S.a11yIgnored = true;
    const shown = P.get('secA11y')(S.data);
    if (!/Unignore/.test(shown)) errs.push('ignored findings cannot be restored');
    if (!/Decorative · Non-text contrast/.test(shown)) errs.push('the ignored reason is not rendered: ' + shown.slice(0, 400));
    // The reason menu lists the plugin's presets.
    P.get('menuFor')('a11y-ignore-menu', { getAttribute: () => '2:2,3:3', getBoundingClientRect: () => ({ top: 0, left: 0, right: 10, bottom: 10, width: 10, height: 10 }) });
    const menu = P.$('menu').innerHTML;
    if (!/Brand exception/.test(menu)) errs.push('the reason menu did not open with the presets');
    if (!/a11y-ignore-menu|Brand exception/.test(menu)) errs.push('the menu is empty');
    // The report handler turns the answer into a download and confirms it.
    P.onmessage({ type: 'a11y-report', format: 'md', out: { format: 'md', text: '# Accessibility report — x\n', file: 'devready-a11y-x.md' } });
    if (!/Downloaded devready-a11y-x\.md/.test(P.$('toast').textContent)) errs.push('the report is not confirmed: ' + P.$('toast').textContent);
    P.onmessage({ type: 'a11y-ignored', ignored: 2 });
    if (!/2 review decisions stored/.test(P.$('toast').textContent)) errs.push('the ignore confirmation is missing: ' + P.$('toast').textContent);
    P.onmessage({ type: 'a11y-ignored', ignored: 1 });
    if (!/1 review decision stored/.test(P.$('toast').textContent)) errs.push('the singular confirmation is wrong');
    record('accessibility', 'the panel offers ignore-with-reason, unignore and report export', errs);
  }
};
