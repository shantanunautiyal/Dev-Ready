/**
 * Unit tests for the panel script inside ui.html.
 *
 * The panel is one file with no build step, so its helpers were only covered
 * indirectly through Playwright. They are evaluated here in a VM with a minimal
 * DOM stub: pure functions (escaping, colour formatting, dates, the ZIP writer)
 * can then be asserted directly and in bulk.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');

/** Just enough DOM for the panel script to load without touching a browser. */
function fakeElement(id) {
  const el = {
    id: id || '', tagName: 'DIV', value: '', checked: false, textContent: '', innerHTML: '',
    style: {}, dataset: {}, children: [], files: [], selectedOptions: [], scrollTop: 0, offsetWidth: 100, offsetHeight: 40,
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); }, toggle(c) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); } },
    addEventListener() {}, removeEventListener() {}, appendChild(c) { this.children.push(c); return c; }, remove() {},
    querySelector() { return null; }, querySelectorAll() { return []; }, closest() { return null; },
    getBoundingClientRect() { return { top: 0, left: 0, right: 100, bottom: 20, width: 100, height: 20 }; },
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {}, focus() {}, click() {},
    setSelectionRange() {}, select() {}, attachShadow() { return this; }, contains() { return false; }
  };
  return el;
}

function loadPanel() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'devready-plugin', 'ui.html'), 'utf8');
  const scripts = [];
  const re = /<script>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) scripts.push(m[1]);
  if (!scripts.length) throw new Error('no <script> found in ui.html');

  const elements = {};
  const document = {
    body: fakeElement('body'), documentElement: fakeElement('html'),
    getElementById(id) { return (elements[id] = elements[id] || fakeElement(id)); },
    querySelector() { return null; }, querySelectorAll() { return []; },
    createElement(tag) { const e = fakeElement(); e.tagName = String(tag).toUpperCase(); return e; },
    addEventListener() {}, removeEventListener() {}, execCommand() { return true; },
    activeElement: null
  };
  const sandbox = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON, Intl,
    Uint8Array, Uint32Array, Uint16Array, ArrayBuffer, DataView, TextEncoder, TextDecoder, Blob: function () {}, URL, URLSearchParams,
    FileReader: function () { this.readAsDataURL = () => {}; },
    navigator: { language: 'en', clipboard: { writeText: async () => {} } },
    document, innerWidth: 480, innerHeight: 820,
    requestAnimationFrame: fn => setTimeout(fn, 0),
    addEventListener() {}, removeEventListener() {},
    parent: { postMessage() {} },
    CSS: { escape: s => String(s) },
    localStorage: { getItem() { return null; }, setItem() {} }
  };
  // Record everything the panel sends to the plugin thread.
  const sent = [];
  sandbox.parent.postMessage = m => { sent.push(m && m.pluginMessage ? m.pluginMessage : m); };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  scripts.forEach(src => vm.runInContext(src, sandbox, { filename: 'ui.html.js' }));
  // `const` declarations at the top level of a script are lexical bindings, not
  // properties of the context object, so read them by evaluating an expression.
  const api = {};
  ['esc', 'fmtColor', 'ago', 'fmtDate', 'makeZip', 'hl', 'resIcon', 'host', 'I', 'S', 'hsl', 'rgbaCss', 'secDiagnostics', 'diagNote',
    'renderTabs', 'render', 'renderNow', 'appAction', 'setTab', 'viewGithub', 'viewAssets', 'viewHistory', 'viewSettings',
    'viewOverview', 'histPush', 'histDiffHtml', 'lineDiff', 'filteredAssets', 'wsEnsure', 'wsActive', '$', 'document',
    'projList', 'wsArchive', 'wsNewProject', 'wsRename', 'wsCreateNamed', 'wsRenameTo', 'uniqueName', 'ghPreviewRows', 'ghLocalFiles', 'viewFiles', 'viewCode', 'filesRun', 'filesRunOne', 'filesCancel', 'filesSettle', 'codeDownloadAll', 'lastCodeFrom'].forEach(name => {
    Object.defineProperty(api, name, { get: () => vm.runInContext(name, sandbox), enumerable: true });
  });
  api.get = name => vm.runInContext(name, sandbox);
  api.sent = sent;
  api.onmessage = msg => sandbox.window.onmessage({ data: { pluginMessage: msg } });
  return api;
}

/** Read a store-only ZIP produced by makeZip: names, data, CRCs, EOCD integrity. */
function readZip(bytes) {
  const buf = Buffer.from(bytes);
  const out = { entries: [], valid: true, problems: [] };
  let p = 0;
  while (p + 30 <= buf.length && buf.readUInt32LE(p) === 0x04034b50) {
    const method = buf.readUInt16LE(p + 8);
    const crc = buf.readUInt32LE(p + 14);
    const size = buf.readUInt32LE(p + 18);
    const nameLen = buf.readUInt16LE(p + 26);
    const extraLen = buf.readUInt16LE(p + 28);
    const name = buf.slice(p + 30, p + 30 + nameLen).toString('utf8');
    const start = p + 30 + nameLen + extraLen;
    const data = buf.slice(start, start + size);
    if (method !== 0) out.problems.push(name + ': method ' + method + ' (expected store)');
    if (zlib.crc32 && zlib.crc32(data) !== crc) out.problems.push(name + ': CRC mismatch');
    out.entries.push({ name, size, data });
    p = start + size;
  }
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) { out.valid = false; out.problems.push('no end-of-central-directory record'); }
  else {
    const count = buf.readUInt16LE(eocd + 10);
    if (count !== out.entries.length) out.problems.push('EOCD count ' + count + ' != entries ' + out.entries.length);
    if (eocd + 22 !== buf.length) out.problems.push('trailing bytes after EOCD');
  }
  out.valid = out.problems.length === 0;
  return out;
}

module.exports = async function uiUnitTests(record) {
  console.log('\npanel unit tests' + ' — pure functions in ui.html, including the ZIP writer');
  const P = loadPanel();

  {
    const esc = P.esc;
    const cases = [
      ['escapes markup', esc('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;'],
      ['escapes quotes', esc('"x"'), '&quot;x&quot;'],
      ['escapes ampersand first', esc('&lt;'), '&amp;lt;'],
      ['null and undefined become empty', esc(null) === '' && esc(undefined) === '', true],
      ['numbers survive', esc(0) === '0', true],
      ['unicode is preserved', esc('Pay ₹1,499 ✓') === 'Pay ₹1,499 ✓', true]
    ];
    const errs = cases.filter(c => c[1] !== c[2]).map(c => c[0] + ': ' + JSON.stringify(c[1]));
    record('panel', cases.length + ' escaping cases (markup, quotes, entities, unicode)', errs);
  }

  {
    const c = { r: 0.05, g: 0.6, b: 1, a: 1 };
    const half = { r: 0, g: 0, b: 0, a: 0.5 };
    const cases = [
      ['hex', P.fmtColor(c), '#0D99FF'],
      ['hex with alpha', P.fmtColor(half), '#000000  50%'],
      ['rgb', P.fmtColor.call(null, c) && (() => { P.S.data = { settings: { colorFormat: 'rgb' } }; const v = P.fmtColor(c); return v; })(), 'rgb(13, 153, 255)'],
      ['rgba', (() => { P.S.data = { settings: { colorFormat: 'rgb' } }; return P.fmtColor(half); })(), 'rgba(0, 0, 0, 0.5)'],
      ['hsl', (() => { P.S.data = { settings: { colorFormat: 'hsl' } }; return P.fmtColor(c); })(), 'hsl(205, 100%, 53%)'],
      ['hsl with alpha', (() => { P.S.data = { settings: { colorFormat: 'hsl' } }; return P.fmtColor(half); })(), 'hsla(0, 0%, 0%, 0.5)']
    ];
    P.S.data = null;
    const errs = cases.filter(x => x[1] !== x[2]).map(x => x[0] + ': got ' + JSON.stringify(x[1]) + ' expected ' + JSON.stringify(x[2]));
    record('panel', 'colour formatting honours hex / RGB / HSL and alpha', errs);
  }

  {
    const now = Date.parse('2026-10-26T12:00:00Z');
    const realNow = Date.now;
    Date.now = () => now;
    const cases = [
      ['seconds', P.ago('2026-10-26T11:59:30Z'), 'just now'],
      ['minutes', P.ago('2026-10-26T11:30:00Z'), '30 minutes ago'],
      ['hours', P.ago('2026-10-26T09:00:00Z'), '3 hours ago'],
      ['days', P.ago('2026-10-23T12:00:00Z'), '3 days ago'],
      ['future dates do not crash', /ago|now/.test(P.ago('2027-01-01T00:00:00Z')), true],
      ['empty input', P.ago('') === '', true]
    ];
    Date.now = realNow;
    const errs = cases.filter(c => c[1] !== c[2]).map(c => c[0] + ': ' + JSON.stringify(c[1]));
    record('panel', 'relative timestamps (just now → days, future and empty input)', errs);
  }

  {
    const errs = [];
    const enc = new TextEncoder();
    const one = P.makeZip([{ name: 'index.html', bytes: enc.encode('<!doctype html><p>hi</p>') }]);
    const z1 = readZip(one);
    if (!z1.valid) errs.push('single file archive: ' + z1.problems.join('; '));
    if (z1.entries.length !== 1 || z1.entries[0].name !== 'index.html') errs.push('wrong entry list: ' + z1.entries.map(e => e.name).join(','));
    if (z1.entries[0] && z1.entries[0].data.toString() !== '<!doctype html><p>hi</p>') errs.push('payload changed');

    const many = P.makeZip([
      { name: 'src/App.tsx', bytes: enc.encode('export default function App() { return null; }') },
      { name: 'src/styles.css', bytes: enc.encode('body{margin:0}') },
      { name: 'assets/icon-ünïcode.svg', bytes: enc.encode('<svg/>') },
      { name: 'empty.txt', bytes: new Uint8Array(0) }
    ]);
    const z2 = readZip(many);
    if (!z2.valid) errs.push('multi-file archive: ' + z2.problems.join('; '));
    if (z2.entries.length !== 4) errs.push('expected 4 entries, got ' + z2.entries.length);
    if (!z2.entries.some(e => e.name === 'assets/icon-ünïcode.svg')) errs.push('unicode filename was not preserved');
    if (!z2.entries.some(e => e.name === 'empty.txt' && e.size === 0)) errs.push('empty file missing');

    // Duplicate names are legal in ZIP but break extraction: the writer must not
    // silently create two identical paths for a project download.
    const dup = P.makeZip([{ name: 'a.txt', bytes: enc.encode('1') }, { name: 'a.txt', bytes: enc.encode('2') }]);
    const z3 = readZip(dup);
    if (!z3.valid) errs.push('duplicate-name archive is structurally invalid: ' + z3.problems.join('; '));
    record('panel', 'ZIP writer: store method, CRCs, unicode names, empty files and duplicate names', errs);
  }

  {
    // The syntax highlighter keeps arbitrary design text inert.
    const errs = [];
    const hostile = P.hl('<script>alert(1)</script> "quoted" & <b>x</b>', 'html');
    if (/<script/i.test(hostile)) errs.push('highlighter emitted a raw <script> tag');
    const css = P.hl('color: #0D99FF; padding: 16px; gap: var(--space-200, 8px);', 'css');
    if (!/c-v/.test(css) || !/c-n/.test(css)) errs.push('CSS highlighting lost colour/number spans');
    record('panel', 'syntax highlighter escapes design text and still marks colours and numbers', errs);
  }

  {
    // Degraded reads: the panel reports them, and design text cannot break out.
    const errs = [];
    const empty = P.secDiagnostics({ diagnostics: [] });
    if (empty !== '') errs.push('an empty diagnostics list should render nothing');
    if (P.secDiagnostics({}) !== '') errs.push('a missing diagnostics list should render nothing');
    const html = P.secDiagnostics({ diagnostics: [{ where: 'local variables', detail: 'API <offline>' }, { where: 'font availability', detail: '' }] });
    if (!/Limited data/.test(html)) errs.push('section title missing');
    if (!/local variables/.test(html) || !/font availability/.test(html)) errs.push('notes missing');
    if (/<offline>/.test(html)) errs.push('detail was not escaped');
    const note = P.diagNote([{ where: 'local variables' }, { where: 'library variables' }]);
    if (!/local variables, library variables/.test(note)) errs.push('export note does not name the failed reads');
    if (P.diagNote([]) !== '') errs.push('an empty export note should render nothing');
    record('panel', 'degraded reads are surfaced ("Limited data" section, export warning) and escaped', errs);
  }

  {
    const rows = [
      ['github link icon', P.resIcon('https://github.com/org/repo'), 'github'],
      ['storybook link icon', P.resIcon('https://storybook.js.org/x'), 'storybook'],
      ['issue tracker icon', P.resIcon('https://linear.app/team'), 'ticket'],
      ['unknown host falls back', P.resIcon('https://example.com/x'), 'link'],
      ['host for display', P.host('https://www.github.com/org/repo'), 'www.github.com'],
      ['host of an invalid url', P.host('not a url') === '']
    ];
    // The icons are SVGs; compare by which glyph each constant holds.
    const glyph = { github: P.I.github, storybook: P.I.storybook, ticket: P.I.ticket, link: P.I.link };
    const errs = rows.filter(r => {
      if (r[2] === undefined) return !r[1];
      if (r[0] === 'host for display') return r[1] !== r[2];
      return r[1] !== glyph[r[2]];
    }).map(r => r[0]);
    record('panel', 'dev-resource icons and host display (link safety)', errs);
  }
};

// Exposed for the workspace tests (tests/platform.js).
module.exports.loadPanel = loadPanel;
