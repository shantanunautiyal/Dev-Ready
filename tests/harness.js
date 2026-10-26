/**
 * Test harness: loads devready-plugin/code.js inside a fresh VM context with a
 * mock `figma` global (codegen mode, so no UI is opened), and exposes small
 * builders for writing node fixtures.
 *
 * The mock implements only what the code engine reads. It is intentionally
 * strict: unknown variables/styles resolve to null, like remote libraries do.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const CODE = fs.readFileSync(path.join(__dirname, '..', 'devready-plugin', 'code.js'), 'utf8');

/* ---------------- node builders ---------------- */
function createBuilders() {
  let seq = 0;
  const ALL = {};
  const VARS = {}, COLLS = {};

  function N(props, kids) {
    const n = Object.assign({
      id: String(++seq), visible: true, rotation: 0, exportSettings: [], fills: [], strokes: [], effects: [],
      getSharedPluginData: () => '', setSharedPluginData() {}, getPluginData: () => '', setPluginData() {},
      getStyledTextSegments() { return this._segs || null; },
      async getCSSAsync() { return Object.assign({}, this._css || {}); },
      async exportAsync(opts) {
        if (opts && opts.format === 'SVG_STRING') {
          if (this._svgString) return this._svgString;
          const spans = (this._svgBaselines || []).map(y => '<tspan x="0" y="' + y + '"></tspan>').join('');
          return '<svg xmlns="http://www.w3.org/2000/svg"><text x="0" y="0">' + spans + '</text></svg>';
        }
        return new Uint8Array(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0h10v10z"/></svg>'));
      },
      async getMainComponentAsync() { return this._main || null; }
    }, props);
    if (n.ax === undefined) n.ax = 0;
    if (n.ay === undefined) n.ay = 0;
    if (kids) { n.children = kids; kids.forEach(k => { k.parent = n; }); }
    Object.defineProperty(n, 'absoluteBoundingBox', { get() { return { x: this.ax, y: this.ay, width: this.width, height: this.height }; } });
    Object.defineProperty(n, 'x', { get() { return this.ax - (this.parent && this.parent.ax || 0); } });
    Object.defineProperty(n, 'y', { get() { return this.ay - (this.parent && this.parent.ay || 0); } });
    if (n.type === 'TEXT') {
      Object.defineProperties(n, {
        fontName: { get() { const c = n._css; const w = +c['font-weight'] || 400; return { family: String(c['font-family'] || 'Inter').replace(/["']/g, '').split(',')[0], style: (c['font-style'] === 'italic' ? 'Italic ' : '') + ({ 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'Semi Bold', 700: 'Bold' }[w] || 'Regular') }; } },
        fontWeight: { get() { return +n._css['font-weight'] || 400; } }
      });
    }
    ALL[n.id] = n;
    return n;
  }
  /** Text layer. css overrides the default 14px Inter. */
  const T = (chars, css, extra) => {
    const fs = parseFloat((css && css['font-size']) || '14');
    return N(Object.assign({ type: 'TEXT', name: chars, characters: chars, width: Math.max(8, chars.length * fs * 0.55), height: fs * 1.4, fontSize: fs, autoRename: true, textAutoResize: 'WIDTH_AND_HEIGHT',
      _css: Object.assign({ color: '#111827', 'font-family': 'Inter', 'font-size': fs + 'px', 'font-weight': '400', 'line-height': '20px' }, css) }, extra));
  };
  /** Auto-layout frame. dir: HORIZONTAL | VERTICAL */
  const AL = (name, dir, css, kids, extra) => N(Object.assign({ type: 'FRAME', name, width: 200, height: 40, layoutMode: dir,
    _css: Object.assign({ display: 'flex', 'flex-direction': dir === 'VERTICAL' ? 'column' : 'row' }, css) }, extra), kids);
  /** Absolute-positioned frame (no auto layout). */
  const ABS = (name, w, h, css, kids, extra) => N(Object.assign({ type: 'FRAME', name, width: w, height: h, layoutMode: 'NONE',
    _css: Object.assign({ width: w + 'px', height: h + 'px' }, css) }, extra), kids);
  const R = (name, w, h, css, extra) => N(Object.assign({ type: 'RECTANGLE', name, width: w, height: h, _css: Object.assign({ width: w + 'px', height: h + 'px' }, css) }, extra));
  const ICON = (name, s) => N({ type: 'FRAME', name, width: s || 24, height: s || 24, _css: { width: (s || 24) + 'px', height: (s || 24) + 'px' } },
    [N({ type: 'VECTOR', name: 'Vector', width: s || 24, height: s || 24 })]);
  const IMG = (name, w, h) => R(name, w, h, {}, { fills: [{ type: 'IMAGE', visible: true, scaleMode: 'FILL' }] });

  /** Component + instance helpers. */
  function COMPONENT(name, set) {
    const main = { id: 'main-' + (++seq), key: 'key-' + seq, name, type: 'COMPONENT', remote: false, parent: set || null };
    return main;
  }
  function SET(name) { return { id: 'set-' + (++seq), key: 'setkey-' + seq, name, type: 'COMPONENT_SET' }; }
  /**
   * Instance. Mirrors real Figma: the layer is named after the component set
   * (or component), and text inside has ids like "I<inst>;<mainText>" that point
   * at the main component's text (whose characters are the default value).
   */
  const INST = (main, props, dir, css, kids, extra) => {
    const n = AL(main.parent ? main.parent.name : main.name, dir || 'HORIZONTAL', css || {}, kids, Object.assign({ type: 'INSTANCE', _main: main, componentProperties: props || {} }, extra));
    main._texts = main._texts || [];
    let k = 0;
    (function walk(x) {
      (x.children || []).forEach(c => {
        if (c.type === 'TEXT') {
          const idx = k++;
          if (!main._texts[idx]) { const mt = { id: 'mt-' + main.id + '-' + idx, type: 'TEXT', characters: c.characters, autoRename: true }; main._texts[idx] = mt; ALL[mt.id] = mt; }
          delete ALL[c.id]; c.id = 'I' + n.id + ';' + main._texts[idx].id; ALL[c.id] = c;
        } else walk(c);
      });
    })(n);
    return n;
  };

  /** Variables: VAR('brand/primary', 'COLOR', {light: {...}, dark: {...}}, 'var(--brand-primary)') */
  function COLLECTION(name, modes) {
    const id = 'coll-' + (++seq);
    COLLS[id] = { id, name, defaultModeId: modes[0] + '-id', modes: modes.map(m => ({ modeId: m + '-id', name: m })) };
    return COLLS[id];
  }
  function VAR(coll, name, type, valuesByMode, web) {
    const id = 'VariableID:' + (++seq);
    const vbm = {};
    Object.keys(valuesByMode).forEach(m => { vbm[m + '-id'] = valuesByMode[m]; });
    VARS[id] = { id, name, resolvedType: type, variableCollectionId: coll.id, valuesByMode: vbm, codeSyntax: web ? { WEB: web } : {} };
    return { type: 'VARIABLE_ALIAS', id };
  }

  return { N, T, AL, ABS, R, ICON, IMG, COMPONENT, SET, INST, COLLECTION, VAR, ALL, VARS, COLLS };
}

/* ---------------- engine loader ---------------- */
/**
 * Load a fresh engine. options.fetch: async (url) => {status}; default = offline (throws).
 * Returns { generateCode, ctx, fetched } — ctx is the VM global (all top-level functions).
 */
function loadEngine(B, options) {
  options = options || {};
  const fetched = [];
  const store = {};
  const notifyLog = [];
  const writes = [];              // read-only violations (should stay empty in Dev Mode)
  const docData = {};             // figma.root shared plugin data, as stored in the file
  let shown = false;              // showUI was reached
  const posted = [];
  const page = options.page || {
    name: 'Page 1', type: 'PAGE', children: [], selection: options.selection || [],
    on() {}, findAll: () => [],
    findChildren: pred => (options.pageChildren || []).filter(n => !pred || pred(n)),
    // Dev Mode measurement API: metadata, so it is legal in the read-only panel.
    addMeasurement: (a, b) => ({ id: 'm' + (writes.length + 1) })
  };
  const figma = {
    editorType: options.editorType || 'dev', mode: options.mode || 'codegen',
    currentPage: page,
    viewport: { scrollAndZoomIntoView() {}, center: { x: 0, y: 0 }, zoom: 1 },
    mixed: Symbol('mixed'),
    codegen: { on() {}, refresh() {} },
    getNodeByIdAsync: async id => B.ALL[id] || null,
    getStyleByIdAsync: async () => null,
    getImageByHash: hash => {
      const bytes = options.images && options.images[hash];
      return bytes ? { getBytesAsync: async () => bytes } : null;
    },
    base64Encode: b => Buffer.from(b).toString('base64'),
    // Shared plugin data is per file and persists between sessions, so the mock keeps
    // it (with Figma's 100 kB per-entry limit) instead of returning ''.
    root: {
      name: options.fileName || 'Design file',
      getSharedPluginDataKeys: ns => Object.keys(docData).filter(k => k.indexOf(ns + '/') === 0).map(k => k.slice(ns.length + 1)),
      getSharedPluginData: (ns, k) => docData[ns + '/' + k] || '',
      setSharedPluginData(ns, k, v) {
        const key = ns + '/' + k;
        if (v === undefined || v === null || v === '') { delete docData[key]; return; }
        if (Buffer.byteLength(String(v), 'utf8') > 100 * 1024) throw new Error('in setSharedPluginData: This pluginData entry exceeds 100 kB per entry limit.');
        docData[key] = String(v);
      }
    },
    clientStorage: { async getAsync(k) { return store[k]; }, async setAsync(k, v) { store[k] = v; }, async keysAsync() { return Object.keys(store); }, async deleteAsync(k) { delete store[k]; } },
    variables: {
      getVariableByIdAsync: async id => B.VARS[id] || null,
      getVariableCollectionByIdAsync: async id => B.COLLS[id] || null,
      getLocalVariablesAsync: async () => Object.keys(B.VARS).map(k => B.VARS[k])
    },
    getLocalPaintStylesAsync: async () => options.paintStyles || [],
    getLocalTextStylesAsync: async () => options.textStyles || [],
    notify(msg, opts) { notifyLog.push({ text: String(msg), error: !!(opts && opts.error) }); },
    // options.throwOnEvent: some editor/API combinations reject an event registration.
    // Used to prove the panel still gets a message handler when that happens.
    on() { if (options.throwOnEvent) throw new Error('editor rejects event registration'); },
    showUI() { shown = true; },
    ui: { postMessage(m) { posted.push(m); }, on() {}, resize() {} }
  };
  // Document writes throw in Dev Mode (figma.com/plugin-docs/working-in-dev-mode). Model that
  // so a read-only path that reaches for the canvas fails loudly here instead of in Figma.
  if (options.readOnly) {
    ['createFrame', 'createText', 'createEllipse', 'createRectangle', 'createLine', 'createGroup',
      'createVector', 'createNodeFromSvg', 'createComponent', 'createPage', 'group', 'ungroup']
      .forEach(k => {
        figma[k] = () => {
          writes.push(k);
          throw new Error('Cannot write to the document in Dev Mode (' + k + ')');
        };
      });
    // Deleting a layer is a document write too.
    Object.keys(B.ALL || {}).forEach(k => {
      const n = B.ALL[k];
      if (n) n.remove = () => { writes.push('remove(' + n.name + ')'); throw new Error('Cannot remove a layer in Dev Mode'); };
    });
  }
  figma.loadFontAsync = async () => {};
  const sandbox = {
    figma, __html__: '', console,
    setTimeout, clearTimeout, Promise, Uint8Array, TextEncoder, TextDecoder,
    fetch: async (url, init) => {
      fetched.push(String(url));
      if (!options.fetch) throw new Error('offline (test default)');
      return options.fetch(String(url), init || {});
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(CODE, sandbox, { filename: 'code.js' });
  /** send(msg): deliver a UI message to the engine, as Figma would. */
  const send = async msg => {
    if (typeof sandbox.figma.ui.onmessage !== 'function') {
      throw new Error('no UI message handler (engine started in codegen mode)');
    }
    await sandbox.figma.ui.onmessage(msg);
    await new Promise(r => setTimeout(r, 0));
  };
  /** run(expr): evaluate inside the engine (reaches top-level const/let too). */
  return {
    shown: () => shown,
    generateCode: sandbox.generateCode, ctx: sandbox, fetched, figma, notifyLog, writes, posted, page, send, docData,
    run: expr => vm.runInContext(expr, sandbox)
  };
}

module.exports = { createBuilders, loadEngine, CODE };
