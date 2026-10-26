/* =====================================================================
 * DevReady Inspect — a Dev-Mode-style inspector that only unlocks specs
 * & code when a design is marked "Ready for dev" (or "Completed").
 *
 * Runs in:
 *   • Figma Design mode  (full UI + can mark ready / draw redlines)
 *   • Figma Dev Mode     (Inspect panel plugin, read-only)
 *   • Dev Mode Codegen   (native "Code" section language dropdown)
 *
 * Plain JS, no build step. Kept to ES2017-ish syntax for the plugin sandbox.
 * ===================================================================== */

const NS = 'devready'; // shared plugin data namespace
const IS_DEV = figma.editorType === 'dev';
/* Figma APIs come and go with plan, editor mode and file age: a call that fails
   used to be swallowed by an empty catch, so the panel quietly showed fewer
   tokens / fonts / mappings with no explanation. Every degraded call now leaves
   a short note behind, which the panel lists as "limited data". Bounded and
   de-duplicated so a hot loop cannot flood it. */
const DIAGS = [];
const DIAG_LIMIT = 12;
function diag(where, err) {
  if (DIAGS.length >= DIAG_LIMIT) return;
  const msg = String(where || 'unknown step');
  if (DIAGS.some(d => d.where === msg)) return;
  const detail = err && err.message ? String(err.message) : err ? String(err) : '';
  DIAGS.push({ where: msg, detail: detail.slice(0, 160) });
}
function clearDiagnostics() { DIAGS.length = 0; }
function takeDiagnostics() { return DIAGS.slice(0); }
/* Hidden instance children can't be selected or inspected, so skipping them saves
   API calls on instance-heavy files. Guarded for Figma versions without the flag. */
try { figma.skipInvisibleInstanceChildren = true; } catch (e) { /* older Figma */ }
/* A deeply nested layer tree (Sketch/Illustrator/AI-generated layer soup) can be
   thousands of levels deep. Every traversal in this file is recursive, so the
   limit is enforced once and reported to the user instead of overflowing the stack. */
const MAX_DEPTH = 120;
const DEFAULT_SETTINGS = {
  gate: 'strict',        // 'strict' = only dev-ready designs, 'off' = always inspect
  unit: 'px',            // 'px' | 'rem'
  remBase: 16,
  colorFormat: 'hex',    // 'hex' | 'rgb' | 'hsl'
  pluginFlag: true,      // also accept the plugin's own "ready" flag (for free plans / Dev Mode)
  previewFonts: 'google', // 'google' = preview loads public Google Fonts, 'off' = no network at all
  // Vector illustrations become one SVG asset instead of a tree of divs.
  // 'auto'  = illustrations by name, explicit SVG export or sheer vector complexity
  // 'named' = only frames whose name says so, or that export as SVG
  // 'off'   = every frame is converted element by element (previous behaviour)
  svgFrames: 'auto'
};
let settings = Object.assign({}, DEFAULT_SETTINGS);

/* ------------------------------------------------------------------ */
/* UI → main-thread message validation                                 */
/* Every message from ui.html is checked against a schema before use:  */
/* unknown types are ignored, unknown fields dropped, values typed and  */
/* range-checked. The UI is bundled, but this keeps the boundary narrow. */
/* ------------------------------------------------------------------ */
const LANG_IDS = ['react-tailwind', 'react-css', 'react-ts', 'react-tailwind-ts', 'html-css', 'html-single', 'vue', 'svelte', 'react-native', 'swiftui', 'compose', 'flutter'];
/* One table for "file extension → Dev Mode code language". It used to live inline in
   the codegen handler, where a new target could be added and forgotten. */
const CODEGEN_LANG = { html: 'HTML', vue: 'HTML', svelte: 'HTML', css: 'CSS', jsx: 'JAVASCRIPT', tsx: 'TYPESCRIPT', ts: 'TYPESCRIPT', swift: 'SWIFT', kotlin: 'KOTLIN', dart: 'PLAINTEXT', text: 'PLAINTEXT' };
const MAP_NAME_RE = /^[A-Za-z_$][\w$.]{0,79}$/;
const MAP_PATH_RE = /^[\w@~.\-][\w@~.\/\-]{0,199}$/;
const V = {
  id: v => typeof v === 'string' && /^[\w:;\-]{1,300}$/.test(v) ? v : undefined,
  str: max => v => v === undefined || v === null ? '' : String(v).slice(0, max),
  oneOf: list => v => list.indexOf(v) > -1 ? v : undefined,
  num: (lo, hi) => v => typeof v === 'number' && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : undefined,
  int: (lo, hi) => v => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : undefined,
  bool: v => !!v,
  bytes: max => v => v instanceof Uint8Array && v.length > 0 && v.length <= max ? v : undefined,
  url: v => typeof v === 'string' && v.length <= 2000 && /^https?:\/\/[^\s"'<>]+$/i.test(v) ? v : undefined,
  re: (re, max) => v => typeof v === 'string' && v.length <= max && re.test(v) ? v : undefined,
  opt: f => v => v === undefined || v === null || v === '' ? '' : f(v)
};
const EXPORT_ITEM = { id: V.id, format: V.oneOf(['PNG', 'JPG', 'SVG', 'PDF']), scale: V.num(0.5, 4) };
const SETTINGS_SCHEMA = { gate: V.oneOf(['strict', 'off']), unit: V.oneOf(['px', 'rem']), remBase: V.int(8, 32), colorFormat: V.oneOf(['hex', 'rgb', 'hsl']), pluginFlag: V.bool, previewFonts: V.oneOf(['google', 'off']), svgFrames: V.oneOf(['auto', 'named', 'off']) };
/* GitHub identifiers. Validated before any request is built, so a hostile
   payload cannot redirect the adapter at another host or path. */
const GH_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
const GH_REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const GH_BRANCH_RE = /^[A-Za-z0-9._\/-]{1,200}$/;
/* Never absolute, never a parent segment, no control characters, no .git trickery. */
const GH_PATH_RE = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))(?!.*\.git(?:\/|$))[A-Za-z0-9._@+ -]{1,120}(?:\/[A-Za-z0-9._@+ -]{1,120})*$/;
const GH_MAX_FILES = 200;
const GH_MAX_BYTES = 4 * 1024 * 1024;
const MSG_SCHEMA = {
  'ui-ready': {}, 'measure-native': {}, 'measure-clear': {}, 'notes-clear': {}, 'redlines': {}, 'clear-redlines': {},
  'settings': { settings: v => { if (!v || typeof v !== 'object') return undefined; const o = {}; Object.keys(SETTINGS_SCHEMA).forEach(k => { if (k in v) { const x = SETTINGS_SCHEMA[k](v[k]); if (x !== undefined) o[k] = x; } }); return o; } },
  'select': { id: V.id }, 'goto': { id: V.id }, 'design-shot': { id: V.id }, 'thumb-request': { id: V.id }, 'baseline-save': { id: V.id }, 'baseline-clear': { id: V.id },
  'mark': { id: V.id, status: V.opt(V.oneOf(['READY_FOR_DEV', 'COMPLETED'])), note: V.str(2000) },
  'export': EXPORT_ITEM,
  'export-all': { items: v => Array.isArray(v) ? v.slice(0, 300).map(i => checkFields(i || {}, EXPORT_ITEM)).filter(Boolean) : undefined, zipName: V.opt(V.re(/^[\w .\-]{1,100}\.zip$/, 104)) },
  'gen-code': { lang: V.oneOf(LANG_IDS), requestId: V.opt(V.int(1, Number.MAX_SAFE_INTEGER)), nodeId: V.opt(V.id), jobId: V.opt(V.int(1, Number.MAX_SAFE_INTEGER)) }, 'tokens-export': { format: V.oneOf(['css', 'scss', 'json', 'tailwind']), scope: V.oneOf(['selection', 'file']) }, 'export-project': { lang: V.oneOf(LANG_IDS) },
  'font-upload': { family: V.re(/^[^|]{1,100}$/, 100), key: V.re(/^[01],[1-9]00$/, 5), ext: V.oneOf(['woff2', 'woff', 'ttf', 'otf']), bytes: V.bytes(2.5 * 1024 * 1024), name: V.str(200), last: V.bool },
  'font-remove': { family: V.re(/^[^|]{1,100}$/, 100), key: V.re(/^[01],[1-9]00$/, 5) },
  'annotate-add': { id: V.id, label: V.str(5000), prop: V.opt(V.re(/^[A-Za-z]{1,40}$/, 40)), cat: V.opt(V.re(/^[\w:;\-]{1,200}$/, 200)), color: V.opt(V.oneOf(['yellow', 'orange', 'red', 'pink', 'violet', 'blue', 'teal', 'green'])), pin: V.bool },
  'annotate-remove': { id: V.id, index: V.int(0, 9999) },
  'devres-add': { id: V.id, url: V.url, name: V.str(200) }, 'devres-remove': { id: V.id, url: V.re(/^\S{1,2000}$/, 2000) },
  'map-save': { key: V.re(/^[\w:;\-]{1,200}$/, 200), name: V.re(MAP_NAME_RE, 80), path: V.opt(V.re(MAP_PATH_RE, 200)) },
  'map-remove': { key: V.re(/^[\w:;\-]{1,200}$/, 200) },
  'notify': { text: V.str(300), error: V.bool },
  'resize': { w: V.num(360, 1600), h: V.num(420, 1600) },
  /* Long jobs can be cancelled. The id is chosen by the panel so a stale cancel
     can never stop a newer run. */
  'cancel': { jobId: V.int(1, Number.MAX_SAFE_INTEGER) },
  /* Per-layer plan: is it an illustration, how expensive is it, can it be generated. */
  'plan': {},
  /* Accessibility review decisions and reporting. */
  'a11y-ignore': { ids: v => Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.length < 80).slice(0, 50) : undefined, reason: V.opt(V.str(120)) },
  'a11y-unignore': { ids: v => Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.length < 80).slice(0, 50) : undefined },
  'a11y-report': { format: V.oneOf(['md', 'csv']) },
  /* Workspace state (projects, local revisions) lives in clientStorage, never in
     the document. Only these keys are readable, and only as bounded JSON. */
  'store-get': { key: V.oneOf(['projects', 'history']) },
  'store-set': { key: V.oneOf(['projects', 'history']), value: V.re(/^[\s\S]{2,600000}$/, 600000) },
  /* GitHub — optional, token-based, every call user-initiated. */
  'gh-status': {}, 'gh-disconnect': {},
  'gh-connect': { token: V.re(/^\S{20,255}$/, 255) },
  'gh-repos': {},
  'gh-branches': { repo: V.re(/^\S{1,300}$/, 300) },
  'gh-tree': {
    repo: V.re(/^\S{1,300}$/, 300),
    branch: V.opt(V.re(/^\S{0,200}$/, 200)),
    // The panel sends the files it would push so the preview can compare hashes.
    files: v => {
      if (!Array.isArray(v) || v.length > GH_MAX_FILES) return undefined;
      return v.slice(0, GH_MAX_FILES).map(f => ({
        path: f && typeof f.path === 'string' ? f.path.slice(0, 300) : '',
        content: f && typeof f.content === 'string' ? f.content.slice(0, GH_MAX_BYTES) : ''
      }));
    }
  },
  'gh-create-repo': { name: V.re(GH_NAME_RE, 100), private: V.bool, description: V.str(200) },
  'gh-commit': {
    // Shape only: paths, counts, sizes and refs are validated by ghCommit(), which
    // answers with an error code instead of leaving the panel waiting.
    repo: V.re(/^\S{1,300}$/, 300),
    branch: V.re(/^\S{1,200}$/, 200),
    message: V.re(/^[^\u0000-\u0008]{0,500}$/, 500),
    baseSha: V.opt(V.re(/^[^\s]{0,40}$/, 40)),
    createBranch: V.bool,
    files: v => {
      if (!Array.isArray(v) || v.length > 500) return undefined;
      return v.slice(0, 500).map(f => ({
        path: f && typeof f.path === 'string' ? f.path.slice(0, 300) : '',
        content: f && typeof f.content === 'string' ? f.content : '',
        del: !!(f && f.del)
      }));
    }
  }
};
/** Returns a cleaned copy with only schema fields, or null if a required field is invalid. */
function checkFields(src, schema, bad) {
  const out = {};
  for (const k of Object.keys(schema)) {
    const x = schema[k](src[k]);
    if (x === undefined) { if (bad) bad.field = k; return null; }
    out[k] = x;
  }
  return out;
}
/** Validate a UI message. Returns { type, ...fields } or null (ignored). */
function validateMsg(msg) {
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string' || !Object.prototype.hasOwnProperty.call(MSG_SCHEMA, msg.type)) return null;
  const bad = {};
  const out = checkFields(msg, MSG_SCHEMA[msg.type], bad);
  if (!out) return { type: '__invalid', of: msg.type, field: bad.field };
  out.type = msg.type;
  return out;
}

/* ------------------------------------------------------------------ */
/* Small utils                                                         */
/* ------------------------------------------------------------------ */
function round(n, d) {
  if (typeof n !== 'number' || !isFinite(n)) return n;
  const p = Math.pow(10, d === undefined ? 2 : d);
  return Math.round(n * p) / p;
}
function to255(v) { return Math.round(v * 255); }
function hex2(v) { const s = to255(v).toString(16); return s.length === 1 ? '0' + s : s; }
function colorHex(c, a) {
  let h = '#' + hex2(c.r) + hex2(c.g) + hex2(c.b);
  if (a !== undefined && a < 1) h += hex2(a);
  return h.toUpperCase();
}
function slug(s) {
  return String(s || 'layer')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'layer';
}
function pascal(s) {
  const p = String(s || 'Component')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
  return /^[A-Z]/.test(p) ? p : 'C' + p;
}
function isMixed(v) { return typeof v === 'symbol'; }
function remify(value, unit, base) {
  if (unit !== 'rem') return value;
  return String(value).replace(/(-?\d*\.?\d+)px/g, function (m, num) {
    const n = parseFloat(num);
    if (Math.abs(n) <= 1) return m; // keep hairlines in px
    return round(n / base, 4) + 'rem';
  });
}

/* ------------------------------------------------------------------ */
/* Dev status (the gate)                                               */
/* ------------------------------------------------------------------ */
function ownStatus(node) {
  try {
    if ('devStatus' in node && node.devStatus) {
      return { type: node.devStatus.type, description: node.devStatus.description || '', source: 'figma' };
    }
  } catch (e) { /* not supported on this node */ }
  if (settings.pluginFlag) {
    try {
      const f = node.getSharedPluginData(NS, 'status');
      if (f) {
        return {
          type: f,
          description: node.getSharedPluginData(NS, 'note') || '',
          at: node.getSharedPluginData(NS, 'at') || '',
          source: 'plugin'
        };
      }
    } catch (e) { /* ignore */ }
  }
  return null;
}

/** Walk up from node to the page; first ancestor with a status wins. */
function findDevStatus(node) {
  let n = node;
  while (n && n.type !== 'PAGE' && n.type !== 'DOCUMENT') {
    const s = ownStatus(n);
    if (s) return Object.assign({ nodeId: n.id, nodeName: n.name, nodeType: n.type }, s);
    n = n.parent;
  }
  return null;
}

const MARKABLE = { FRAME: 1, COMPONENT: 1, COMPONENT_SET: 1, INSTANCE: 1, SECTION: 1 };
/** Figma only allows devStatus on nodes directly under a page or a section. */
function markTarget(node) {
  let n = node;
  while (n && n.parent) {
    const pt = n.parent.type;
    if ((pt === 'PAGE' || pt === 'SECTION') && MARKABLE[n.type]) return n;
    n = n.parent;
  }
  return null;
}
/**
 * Where the DevReady flag goes when Figma's own status isn't available.
 * Shared plugin data works on every node type and every plan, so the same
 * container rule applies — but without the MARKABLE restriction. Without this,
 * a design built from top-level groups could never be marked, and the gate
 * would stay locked for the whole file.
 */
function flagTarget(node) {
  let n = node;
  while (n && n.parent) {
    const pt = n.parent.type;
    if (pt === 'PAGE' || pt === 'SECTION') return n.type === 'PAGE' || n.type === 'DOCUMENT' ? null : n;
    n = n.parent;
  }
  return n && n.type !== 'PAGE' && n.type !== 'DOCUMENT' ? n : null;
}

/** The layer that a status would be written to, and whether Figma can hold it natively. */
function statusTargets(node) {
  const native = markTarget(node);
  const flag = native || flagTarget(node);
  return { native: native, flag: flag };
}

async function setReady(nodeId, type, note) {
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) return { ok: false, error: 'Layer not found' };
  const t = statusTargets(node);
  const target = t.flag;
  if (!target) return { ok: false, error: 'Select a layer that sits on a page or inside a section.' };

  // Keep the handoff note across routine status changes: clearing a status is
  // explicit, and re-marking with an empty note must not erase the context.
  let kept = '';
  if (type) {
    const own = ownStatus(target);
    kept = (note && String(note).trim()) ? String(note) : (own ? own.description || '' : '');
  }

  let native = false;
  if (!IS_DEV && t.native) {
    try {
      if (type) {
        const ds = { type: type };
        if (kept) ds.description = kept;
        t.native.devStatus = ds;
      } else {
        t.native.devStatus = null;
      }
      native = true;
    } catch (e) {
      native = false; // e.g. free plan, nested status, or restricted
    }
  }
  // The flag is always mirrored, not only when the native write fails. Teams mix
  // paid and free seats: a free-plan collaborator, a viewer or another plugin can
  // only read shared plugin data, and would otherwise see a ready design as locked.
  target.setSharedPluginData(NS, 'status', type || '');
  target.setSharedPluginData(NS, 'note', type ? kept : '');
  target.setSharedPluginData(NS, 'at', type ? new Date().toISOString() : '');
  try { target.setRelaunchData(type ? { open: 'Dev ready — inspect specs & code' } : {}); } catch (e) { /* ignore */ }
  // Change tracking: snapshot the design when it's handed off
  try {
    if (type === 'READY_FOR_DEV') saveBaseline(target);
    else if (!type) clearBaseline(target);
  } catch (e) { /* ignore */ }
  return { ok: true, native: native, name: target.name, note: kept, source: native ? 'figma' : 'plugin' };
}

/**
 * All designs with a status (top level + nested sections).
 * scope: 'page' (default, fast) | 'file' (every page, for the handoff inbox).
 */
function listReady(scope) {
  const out = [];
  let pages = [figma.currentPage];
  if (scope === 'file') {
    try { if (figma.root && figma.root.children && figma.root.children.length) pages = figma.root.children; } catch (e) { /* page-scoped only */ }
  }
  const seen = {};
  const MAX_SECTION_DEPTH = 8;
  function visit(parent, depth, pageName) {
    if (!('children' in parent) || depth > MAX_SECTION_DEPTH) return;
    for (const n of parent.children) {
      const s = ownStatus(n);
      if (s) out.push({ id: n.id, name: n.name, type: n.type, status: s.type, note: s.description, source: s.source, page: pageName });
      if (n.type === 'SECTION') visit(n, depth + 1, pageName);
    }
  }
  pages.forEach(p => {
    if (!p || p.type !== 'PAGE' || seen[p.id]) return;
    seen[p.id] = 1;
    visit(p, 0, p.name);
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* Variables & styles                                                  */
/* ------------------------------------------------------------------ */
const varCache = {};
async function varInfo(id) {
  if (!id) return null;
  if (varCache[id] !== undefined) return varCache[id];
  let info = null;
  try {
    const v = await figma.variables.getVariableByIdAsync(id);
    if (v) {
      let coll = '';
      try {
        const c = await figma.variables.getVariableCollectionByIdAsync(v.variableCollectionId);
        coll = c ? c.name : '';
      } catch (e) { /* remote */ }
      info = {
        name: v.name,
        collection: coll,
        type: v.resolvedType,
        web: (v.codeSyntax && v.codeSyntax.WEB) || ''
      };
    }
  } catch (e) { /* ignore */ }
  varCache[id] = info;
  return info;
}
const styleCache = {};
async function styleName(id) {
  if (!id || typeof id !== 'string') return null;
  if (styleCache[id] !== undefined) return styleCache[id];
  let name = null;
  try {
    const st = await figma.getStyleByIdAsync(id);
    name = st ? st.name : null;
  } catch (e) { /* ignore */ }
  styleCache[id] = name;
  return name;
}
/**
 * Variables, styles and collections can be renamed or edited while the plugin is
 * open. Without dropping these caches the panel keeps showing the old name (or a
 * stale "not found") for the rest of the session. Called on every document change;
 * diffCache is part of the same invalidation.
 */
function clearLookupCaches() {
  [varCache, styleCache, collCache].forEach(cache => { Object.keys(cache).forEach(k => { delete cache[k]; }); });
  Object.keys(diffCache).forEach(k => { diffCache[k] = null; });
}

/* ------------------------------------------------------------------ */
/* Spec extraction                                                     */
/* ------------------------------------------------------------------ */
function rgbaObj(c, a) { return { r: c.r, g: c.g, b: c.b, a: a === undefined ? 1 : round(a, 3) }; }

async function serializePaint(p) {
  const o = { type: p.type, visible: p.visible !== false, opacity: p.opacity === undefined ? 1 : round(p.opacity, 3) };
  if (p.blendMode && p.blendMode !== 'NORMAL') o.blendMode = p.blendMode;
  if (p.type === 'SOLID') {
    o.color = rgbaObj(p.color, o.opacity);
    if (p.boundVariables && p.boundVariables.color) o.variable = await varModes(p.boundVariables.color.id);
  } else if (p.type.indexOf('GRADIENT') === 0) {
    o.stops = p.gradientStops.map(s => ({ color: rgbaObj(s.color, s.color.a * o.opacity), position: round(s.position * 100, 1) }));
  } else if (p.type === 'IMAGE') {
    o.scaleMode = p.scaleMode;
  }
  return o;
}

function computeBox(node) {
  const box = { margin: null, padding: null };
  const nb = node.absoluteBoundingBox;
  const parent = node.parent;
  const pb = parent && 'absoluteBoundingBox' in parent ? parent.absoluteBoundingBox : null;
  if (nb && pb) {
    box.margin = {
      top: round(nb.y - pb.y),
      left: round(nb.x - pb.x),
      right: round(pb.x + pb.width - (nb.x + nb.width)),
      bottom: round(pb.y + pb.height - (nb.y + nb.height))
    };
    box.parentName = parent.name;
  }
  if ('paddingTop' in node) {
    box.padding = { top: node.paddingTop, right: node.paddingRight, bottom: node.paddingBottom, left: node.paddingLeft };
  }
  return box;
}

function fmtLineHeight(lh) {
  if (!lh || isMixed(lh)) return 'Mixed';
  if (lh.unit === 'AUTO') return 'Auto';
  if (lh.unit === 'PERCENT') return round(lh.value, 1) + '%';
  return round(lh.value, 2) + 'px';
}
function fmtLetterSpacing(ls) {
  if (!ls || isMixed(ls)) return 'Mixed';
  if (ls.unit === 'PERCENT') return round(ls.value, 2) + '%';
  return round(ls.value, 2) + 'px';
}

async function extractSpec(node) {
  const s = { id: node.id, name: node.name, type: node.type };
  s.size = { w: round(node.width), h: round(node.height) };
  s.pos = { x: round(node.x), y: round(node.y) };
  if ('rotation' in node && node.rotation) s.rotation = round(node.rotation);
  if ('opacity' in node && node.opacity < 1) s.opacity = round(node.opacity);
  if ('blendMode' in node && node.blendMode !== 'PASS_THROUGH' && node.blendMode !== 'NORMAL') s.blendMode = node.blendMode;
  if ('clipsContent' in node && node.clipsContent) s.clips = true;
  s.box = computeBox(node);

  // Auto layout
  if ('layoutMode' in node && node.layoutMode !== 'NONE') {
    s.layout = {
      mode: node.layoutMode,
      wrap: node.layoutWrap === 'WRAP',
      gap: node.primaryAxisAlignItems === 'SPACE_BETWEEN' ? 'auto' : node.itemSpacing,
      crossGap: node.layoutWrap === 'WRAP' ? node.counterAxisSpacing : null,
      primary: node.primaryAxisAlignItems,
      counter: node.counterAxisAlignItems,
      padding: [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft]
    };
    if (node.layoutMode === 'GRID') s.layout.grid = { rows: node.gridRowCount, cols: node.gridColumnCount };
  }
  try {
    if ('layoutSizingHorizontal' in node) s.sizing = { h: node.layoutSizingHorizontal, v: node.layoutSizingVertical };
  } catch (e) { /* not applicable */ }
  try {
    if ('layoutPositioning' in node && node.layoutPositioning === 'ABSOLUTE') s.absolute = true;
  } catch (e) { /* ignore */ }
  const mm = {};
  ['minWidth', 'maxWidth', 'minHeight', 'maxHeight'].forEach(k => {
    try { if (k in node && node[k] !== null && node[k] !== undefined) mm[k] = node[k]; } catch (e) { /* ignore */ }
  });
  if (Object.keys(mm).length) s.constraints = mm;

  // Radius
  if ('cornerRadius' in node) {
    if (isMixed(node.cornerRadius)) {
      s.radius = [node.topLeftRadius, node.topRightRadius, node.bottomRightRadius, node.bottomLeftRadius];
    } else if (node.cornerRadius) {
      s.radius = [node.cornerRadius];
    }
  }

  // Fills / strokes / effects
  if ('fills' in node && !isMixed(node.fills)) {
    s.fills = [];
    for (const p of node.fills) if (p.visible !== false) s.fills.push(await serializePaint(p));
    s.fillStyle = await styleName(node.fillStyleId);
  }
  if ('strokes' in node && node.strokes.length) {
    s.strokes = [];
    for (const p of node.strokes) if (p.visible !== false) s.strokes.push(await serializePaint(p));
    s.strokeStyle = await styleName(node.strokeStyleId);
    let weight = node.strokeWeight;
    if (isMixed(weight)) weight = [node.strokeTopWeight, node.strokeRightWeight, node.strokeBottomWeight, node.strokeLeftWeight].join(' ');
    s.strokeInfo = {
      weight: weight,
      align: node.strokeAlign,
      dash: 'dashPattern' in node && node.dashPattern.length ? node.dashPattern.join(', ') : ''
    };
  }
  if ('effects' in node && node.effects.length) {
    s.effects = node.effects.filter(e => e.visible !== false).map(e => ({
      type: e.type,
      color: e.color ? rgbaObj(e.color, e.color.a) : null,
      x: e.offset ? e.offset.x : null,
      y: e.offset ? e.offset.y : null,
      radius: e.radius,
      spread: e.spread || 0
    }));
    s.effectStyle = await styleName(node.effectStyleId);
  }

  // Typography
  if (node.type === 'TEXT') {
    const segs = node.getStyledTextSegments([
      'fontName', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing',
      'fills', 'textDecoration', 'textCase', 'textStyleId'
    ]);
    const out = [];
    for (const seg of segs.slice(0, 12)) {
      const solid = seg.fills.find(f => f.type === 'SOLID' && f.visible !== false);
      let colorVar = null;
      if (solid && solid.boundVariables && solid.boundVariables.color) colorVar = await varInfo(solid.boundVariables.color.id);
      out.push({
        text: seg.characters.slice(0, 60),
        family: seg.fontName.family,
        style: seg.fontName.style,
        size: seg.fontSize,
        weight: seg.fontWeight,
        lineHeight: fmtLineHeight(seg.lineHeight),
        letterSpacing: fmtLetterSpacing(seg.letterSpacing),
        decoration: seg.textDecoration,
        textCase: seg.textCase,
        color: solid ? rgbaObj(solid.color, solid.opacity === undefined ? 1 : solid.opacity) : null,
        colorVar: colorVar,
        styleName: await styleName(seg.textStyleId)
      });
    }
    s.text = {
      characters: node.characters.slice(0, 4000),
      align: node.textAlignHorizontal,
      valign: node.textAlignVertical,
      autoResize: node.textAutoResize,
      paragraphSpacing: node.paragraphSpacing,
      segments: out,
      more: segs.length > 12 ? segs.length - 12 : 0
    };
  }

  // Bound variables (tokens) on the node itself
  s.tokens = [];
  try {
    const bv = node.boundVariables || {};
    for (const key of Object.keys(bv)) {
      const val = bv[key];
      const list = Array.isArray(val) ? val : (val && val.id ? [val] : []);
      for (const alias of list) {
        if (!alias || !alias.id) continue;
        const info = await varModes(alias.id);
        if (info) s.tokens.push({ property: key, name: info.name, collection: info.collection, web: info.web, type: info.type, modes: modeList(info) });
      }
    }
    // also paint-level variables
    (s.fills || []).concat(s.strokes || []).forEach(p => {
      if (p.variable) s.tokens.push({ property: 'color', name: p.variable.name, collection: p.variable.collection, web: p.variable.web, type: 'COLOR', modes: modeList(p.variable) });
    });
    // de-dupe
    const seen = {};
    s.tokens = s.tokens.filter(t => { const k = t.property + t.name; if (seen[k]) return false; seen[k] = 1; return true; });
  } catch (e) { /* ignore */ }

  // Resolved mode for this layer (explicit or inherited)
  try {
    const em = node.explicitVariableModes || {};
    const ids = Object.keys(em);
    if (ids.length) {
      s.explicitModes = [];
      for (const cid of ids) { const c = await getColl(cid); if (c) { const m = c.modes.find(x => x.modeId === em[cid]); s.explicitModes.push({ collection: c.name, mode: m ? m.name : em[cid] }); } }
    }
  } catch (e) { /* ignore */ }

  // Components
  try {
    if (node.type === 'INSTANCE') {
      const main = await node.getMainComponentAsync();
      if (main) {
        const inSet = main.parent && main.parent.type === 'COMPONENT_SET';
        s.component = {
          kind: 'Instance',
          name: inSet ? main.parent.name : main.name,
          variant: inSet ? main.name : '',
          description: main.description || (inSet ? main.parent.description : '') || '',
          remote: main.remote,
          mainId: main.remote ? null : main.id,
          mapKey: (inSet ? main.parent.key : main.key) || main.id,
          props: []
        };
        const props = node.componentProperties || {};
        for (const k of Object.keys(props)) {
          let value = props[k].value;
          if (props[k].type === 'INSTANCE_SWAP') {
            try { const sw = await figma.getNodeByIdAsync(String(value)); if (sw) value = sw.name; } catch (e) { /* ignore */ }
          }
          s.component.props.push({ name: k.split('#')[0], type: props[k].type, value: String(value) });
        }
      }
    } else if (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') {
      const inSet = node.type === 'COMPONENT' && node.parent && node.parent.type === 'COMPONENT_SET';
      s.component = { kind: node.type === 'COMPONENT' ? 'Main component' : 'Component set', name: inSet ? node.parent.name : node.name, inSet: inSet, variant: inSet ? node.name : '', description: node.description || (inSet ? node.parent.description : '') || '', props: [] };
      try {
        const defs = node.componentPropertyDefinitions || {};
        for (const k of Object.keys(defs)) {
          s.component.props.push({ name: k.split('#')[0], type: defs[k].type, value: String(defs[k].defaultValue) + (defs[k].variantOptions ? ' (' + defs[k].variantOptions.join(' | ') + ')' : '') });
        }
      } catch (e) { /* ignore */ }
    }
    if (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') {
      const set = node.type === 'COMPONENT' && node.parent && node.parent.type === 'COMPONENT_SET' ? node.parent : null;
      s.component.mapKey = (set ? set.key : node.key) || node.id;
    }
    if (s.component && s.component.mapKey) {
      const raw = figma.root.getSharedPluginData(NS, 'map:' + s.component.mapKey);
      if (raw) {
        try {
          s.component.map = JSON.parse(raw);
          const pr = s.component.kind === 'Instance' ? s.component.props.map(p => ({ name: p.name, type: p.type, value: p.type === 'BOOLEAN' ? p.value === 'true' : p.value })) : [];
          s.component.snippet = connectSnippet(s.component.map, pr);
        } catch (e) { /* ignore */ }
      }
      s.component.suggest = { name: pascal(cleanName(s.component.name) || 'Component'), path: '@/components/' + (cleanName(s.component.name) || 'component') };
    }
    if (s.component && 'documentationLinks' in node && node.documentationLinks && node.documentationLinks.length) {
      s.component.docs = node.documentationLinks.map(l => l.uri);
    }
  } catch (e) { /* ignore */ }

  // Annotations & dev resources (Dev Mode metadata)
  try {
    if ('annotations' in node && node.annotations && node.annotations.length) {
      s.annotations = node.annotations.map((a, i) => ({
        index: i,
        label: a.labelMarkdown || a.label || '',
        properties: (a.properties || []).map(p => p.type),
        categoryId: a.categoryId || ''
      }));
    }
  } catch (e) { /* ignore */ }
  try {
    if ('getDevResourcesAsync' in node) {
      const res = await node.getDevResourcesAsync();
      if (res && res.length) s.devResources = res.map(r => ({ name: r.name, url: r.url }));
    }
  } catch (e) { /* ignore */ }

  s.canAnnotate = 'annotations' in node;
  if (s.canAnnotate || s.annotations) s.annCats = await annCategories();
  s.annNoteCount = IS_DEV ? 0 : canvasNotesFor(node.id).length;
  try { s.interactions = await interactionsOf(node); } catch (e) { /* ignore */ }
  try {
    if (node.type === 'INSTANCE' && s.component && 'overrides' in node && node.overrides && node.overrides.length) {
      s.component.overrideCount = node.overrides.length;
      s.component.overrides = [];
      for (const o of node.overrides.slice(0, 12)) {
        let name = o.id;
        try { const on = await figma.getNodeByIdAsync(o.id); if (on) name = on.id === node.id ? node.name + ' (this layer)' : on.name; } catch (e) { /* ignore */ }
        s.component.overrides.push({ id: o.id, name: name, fields: o.overriddenFields || [] });
      }
    }
  } catch (e) { /* ignore */ }
  s.canMeasure = !!MEASURABLE[node.type] && 'addMeasurement' in figma.currentPage;
  s.layers = layersInfo(node);
  return s;
}
function modeList(info) {
  if (!info || !info.modes || info.modes.length < 2) return null;
  return info.modes.map(m => ({ name: m.name, display: m.display, color: m.color, alias: m.alias, isDefault: m.isDefault }));
}

/* ------------------------------------------------------------------ */
/* CSS + Tailwind generation                                           */
/* ------------------------------------------------------------------ */
async function safeCSS(node) {
  try { return await node.getCSSAsync(); } catch (e) { return {}; }
}

const CSS_GROUPS = [
  ['Auto layout', /^(display|flex-direction|flex-wrap|justify-content|align-items|align-content|gap|row-gap|column-gap|padding(-.*)?)$/],
  ['Layout', /^(position|top|left|right|bottom|width|height|min-.*|max-.*|flex|flex-grow|flex-shrink|flex-basis|align-self|aspect-ratio|overflow|transform|z-index)$/],
  ['Typography', /^(color|font.*|line-height|letter-spacing|text-.*|white-space|-webkit-.*|leading-trim|word-.*|font-feature-settings)$/],
  ['Style', /.*/]
];
/** Dev-Mode-like CSS: grouped with comments. */
function groupedCSS(obj, unit, base, typeComment) {
  const buckets = CSS_GROUPS.map(() => []);
  Object.keys(obj).forEach(k => {
    for (let i = 0; i < CSS_GROUPS.length; i++) {
      if (CSS_GROUPS[i][1].test(k)) { buckets[i].push(k + ': ' + remify(obj[k], unit, base) + ';'); break; }
    }
  });
  const out = [];
  buckets.forEach((lines, i) => {
    if (!lines.length) return;
    let title = CSS_GROUPS[i][0];
    if (title === 'Typography' && typeComment) title = typeComment;
    if (out.length) out.push('');
    out.push('/* ' + title + ' */');
    out.push.apply(out, lines);
  });
  return out.join('\n');
}

const SP = { 0: '0', 1: 'px', 2: '0.5', 4: '1', 6: '1.5', 8: '2', 10: '2.5', 12: '3', 14: '3.5', 16: '4', 20: '5', 24: '6', 28: '7', 32: '8', 36: '9', 40: '10', 44: '11', 48: '12', 56: '14', 64: '16', 80: '20', 96: '24', 112: '28', 128: '32', 144: '36', 160: '40', 176: '44', 192: '48', 208: '52', 224: '56', 240: '60', 256: '64', 288: '72', 320: '80', 384: '96' };
const FS = { 12: 'xs', 14: 'sm', 16: 'base', 18: 'lg', 20: 'xl', 24: '2xl', 30: '3xl', 36: '4xl', 48: '5xl', 60: '6xl', 72: '7xl', 96: '8xl', 128: '9xl' };
const FW = { 100: 'thin', 200: 'extralight', 300: 'light', 400: 'normal', 500: 'medium', 600: 'semibold', 700: 'bold', 800: 'extrabold', 900: 'black' };
const RAD = { 0: 'none', 2: 'sm', 4: '', 6: 'md', 8: 'lg', 12: 'xl', 16: '2xl', 24: '3xl' };
const JUST = { 'flex-start': 'start', 'center': 'center', 'flex-end': 'end', 'space-between': 'between', 'space-around': 'around', 'space-evenly': 'evenly', 'stretch': 'stretch', 'baseline': 'baseline', 'start': 'start', 'end': 'end' };

function pxNum(v) { const m = /^(-?\d*\.?\d+)px$/.exec(String(v).trim()); return m ? parseFloat(m[1]) : null; }

function cssToTailwind(css, unit, base) {
  const cls = [];
  const arb = v => remify(String(v), unit, base).replace(/\s*,\s*/g, ',').replace(/\s+/g, '_');
  const spc = (prefix, v) => {
    if (String(v).trim() === '0') return prefix + '-0';
    const n = pxNum(v);
    if (n !== null && SP[n] !== undefined) return prefix + '-' + SP[n];
    if (n !== null && n < 0 && SP[-n] !== undefined) return '-' + prefix + '-' + SP[-n];
    return prefix + '-[' + arb(v) + ']';
  };
  const size = (prefix, v) => {
    if (v === '100%') return prefix + '-full';
    if (v === 'fit-content') return prefix + '-fit';
    if (v === 'auto') return prefix + '-auto';
    return spc(prefix, v);
  };
  const isVar = v => /^var\(/.test(String(v).trim());

  css = Object.assign({}, css);
  Object.keys(css).forEach(k => { css[k] = String(css[k]).replace(/\/\*[\s\S]*?\*\//g, '').trim(); if (!css[k] || (k === 'font-style' && css[k] === 'normal')) delete css[k]; });
  // width === height on the spacing scale → size-*
  if (css.width && css.width === css.height && pxNum(css.width) !== null && SP[pxNum(css.width)] !== undefined) {
    cls.push('size-' + SP[pxNum(css.width)]);
    delete css.width; delete css.height;
  }
  for (const prop of Object.keys(css)) {
    const v = String(css[prop]).trim();
    switch (prop) {
      case 'list-style': cls.push(v === 'none' ? 'list-none' : '[list-style:' + arb(v) + ']'); break;
      case 'margin': cls.push(v === '0' || v === '0px' ? 'm-0' : spc('m', v)); break;
      case 'display':
        if (v === 'flex' || v === 'inline-flex' || v === 'grid' || v === 'block' || v === 'inline-block' || v === 'none') cls.push(v === 'none' ? 'hidden' : v);
        else cls.push('[display:' + arb(v) + ']');
        break;
      case 'flex-direction': cls.push(v === 'column' ? 'flex-col' : v === 'row' ? 'flex-row' : 'flex-' + v); break;
      case 'justify-content': cls.push(JUST[v] ? 'justify-' + JUST[v] : '[justify-content:' + arb(v) + ']'); break;
      case 'align-items': cls.push(JUST[v] ? 'items-' + JUST[v] : '[align-items:' + arb(v) + ']'); break;
      case 'align-content': cls.push(JUST[v] ? 'content-' + JUST[v] : '[align-content:' + arb(v) + ']'); break;
      case 'align-self': cls.push(JUST[v] ? 'self-' + JUST[v] : '[align-self:' + arb(v) + ']'); break;
      case 'flex':
        if (v === '1 0 0' || v === '1 0 0%') cls.push('grow', 'shrink-0', 'basis-0');
        else if (v === '1' || v === '1 1 0%') cls.push('flex-1');
        else cls.push('flex-[' + arb(v) + ']');
        break;
      case 'flex-grow': cls.push(v === '1' ? 'grow' : v === '0' ? 'grow-0' : 'grow-[' + v + ']'); break;
      case 'flex-shrink': cls.push(v === '0' ? 'shrink-0' : 'shrink'); break;
      case 'flex-wrap': cls.push(v === 'wrap' ? 'flex-wrap' : 'flex-nowrap'); break;
      case 'gap': {
        const parts = v.split(/\s+(?![^(]*\))/);
        if (parts.length === 2) cls.push(spc('gap-y', parts[0]), spc('gap-x', parts[1]));
        else cls.push(spc('gap', v));
        break;
      }
      case 'row-gap': cls.push(spc('gap-y', v)); break;
      case 'column-gap': cls.push(spc('gap-x', v)); break;
      case 'padding': {
        const p = v.split(/\s+(?![^(]*\))/);
        const [t, r, b, l] = p.length === 1 ? [p[0], p[0], p[0], p[0]] : p.length === 2 ? [p[0], p[1], p[0], p[1]] : p.length === 3 ? [p[0], p[1], p[2], p[1]] : p;
        if (t === r && r === b && b === l) cls.push(spc('p', t));
        else if (t === b && l === r) cls.push(spc('px', l), spc('py', t));
        else cls.push(spc('pt', t), spc('pr', r), spc('pb', b), spc('pl', l));
        break;
      }
      case 'padding-top': cls.push(spc('pt', v)); break;
      case 'padding-right': cls.push(spc('pr', v)); break;
      case 'padding-bottom': cls.push(spc('pb', v)); break;
      case 'padding-left': cls.push(spc('pl', v)); break;
      case 'width': cls.push(size('w', v)); break;
      case 'height': cls.push(size('h', v)); break;
      case 'min-width': cls.push(size('min-w', v)); break;
      case 'max-width': cls.push(size('max-w', v)); break;
      case 'min-height': cls.push(size('min-h', v)); break;
      case 'max-height': cls.push(size('max-h', v)); break;
      case 'position': cls.push(v); break;
      case 'top': case 'left': case 'right': case 'bottom': cls.push(spc(prop, v)); break;
      case 'background':
      case 'background-color':
        if (/gradient|url\(/.test(v) || v.indexOf(',') > -1 && !isVar(v)) cls.push('[background:' + arb(v) + ']');
        else cls.push('bg-[' + arb(v) + ']');
        break;
      case 'color': cls.push(isVar(v) ? 'text-[color:' + arb(v) + ']' : 'text-[' + arb(v) + ']'); break;
      case 'font-family': {
        const fam = v.replace(/^var\([^,]+,\s*/, '').replace(/\)$/, '').split(',')[0].replace(/["']/g, '').trim();
        cls.push("font-['" + fam.replace(/\s+/g, '_') + "']");
        break;
      }
      case 'font-size': {
        const n = pxNum(v);
        if (n !== null && FS[n]) cls.push('text-' + FS[n]);
        else cls.push(isVar(v) ? 'text-[length:' + arb(v) + ']' : 'text-[' + arb(v) + ']');
        break;
      }
      case 'font-weight': cls.push(FW[v] ? 'font-' + FW[v] : 'font-[' + arb(v) + ']'); break;
      case 'font-style': if (v === 'italic') cls.push('italic'); break;
      case 'line-height': cls.push(v === 'normal' ? 'leading-normal' : 'leading-[' + arb(v) + ']'); break;
      case 'letter-spacing': cls.push('tracking-[' + arb(v) + ']'); break;
      case 'text-align': cls.push('text-' + v); break;
      case 'text-transform': if (v !== 'none') cls.push(v === 'capitalize' ? 'capitalize' : v); break;
      case 'text-decoration-line':
      case 'text-decoration':
        if (/underline/.test(v)) cls.push('underline');
        else if (/line-through/.test(v)) cls.push('line-through');
        break;
      case 'border-radius': {
        const n = pxNum(v);
        if (n !== null && RAD[n] !== undefined) cls.push(RAD[n] ? 'rounded-' + RAD[n] : 'rounded');
        else if (n !== null && n >= 999) cls.push('rounded-full');
        else cls.push('rounded-[' + arb(v) + ']');
        break;
      }
      case 'border': {
        const m = /^(\d*\.?\d+px)\s+(solid|dashed|dotted)\s+(.+)$/.exec(v);
        if (m) {
          cls.push(m[1] === '1px' ? 'border' : 'border-[' + m[1] + ']');
          if (m[2] !== 'solid') cls.push('border-' + m[2]);
          cls.push('border-[' + arb(m[3]) + ']');
        } else cls.push('[border:' + arb(v) + ']');
        break;
      }
      case 'box-shadow': cls.push('shadow-[' + arb(v) + ']'); break;
      case 'opacity': cls.push('opacity-[' + v + ']'); break;
      case 'overflow': cls.push('overflow-' + v); break;
      case 'mix-blend-mode': cls.push('mix-blend-' + v); break;
      case 'backdrop-filter': {
        const m = /^blur\((.+)\)$/.exec(v);
        cls.push(m ? 'backdrop-blur-[' + arb(m[1]) + ']' : '[backdrop-filter:' + arb(v) + ']');
        break;
      }
      case 'filter': {
        const m = /^blur\((.+)\)$/.exec(v);
        cls.push(m ? 'blur-[' + arb(m[1]) + ']' : '[filter:' + arb(v) + ']');
        break;
      }
      case 'aspect-ratio': cls.push('aspect-[' + arb(v.replace(/\s*\/\s*/, '/')) + ']'); break;
      case 'object-fit': cls.push('object-' + v); break;
      case 'white-space': cls.push(v === 'nowrap' ? 'whitespace-nowrap' : 'whitespace-' + v); break;
      case 'text-overflow': if (v === 'ellipsis') cls.push('text-ellipsis'); break;
      case '-webkit-line-clamp': cls.push('line-clamp-' + v); break;
      case '-webkit-box-orient': case 'display-webkit': break;
      default:
        cls.push('[' + prop + ':' + arb(v) + ']');
    }
  }
  return cls.filter(Boolean);
}

/* ------------------------------------------------------------------ */
/* Asset detection                                                     */
/* ------------------------------------------------------------------ */
const VECTORISH = { VECTOR: 1, BOOLEAN_OPERATION: 1, STAR: 1, LINE: 1, ELLIPSE: 1, POLYGON: 1, RECTANGLE: 1 };
const ASSET_WALK_LIMIT = 2000;
function allVector(n, depth, seen) {
  // Image-filled rectangles/ellipses are raster content, even though their node
  // type is vector-ish. Check every descendant so avatar stacks are not exported
  // as one opaque SVG icon. Bounded: a pathological tree must not overflow.
  depth = depth || 0; seen = seen || { n: 0 };
  if (depth > MAX_DEPTH || seen.n++ > ASSET_WALK_LIMIT) return false;
  if (n.visible === false || hasImageFill(n)) return false;
  if (!('children' in n)) return !!VECTORISH[n.type];
  if (n.type === 'BOOLEAN_OPERATION') return true;
  const kids = n.children.filter(c => c.visible !== false);
  if (!kids.length) return false;
  for (const c of kids) { if (!allVector(c, depth + 1, seen)) return false; }
  return true;
}
function hasImageFill(n) {
  return 'fills' in n && !isMixed(n.fills) && n.fills.some(f => f.type === 'IMAGE' && f.visible !== false);
}
function hasNestedImageFill(n, depth, seen) {
  depth = depth || 0; seen = seen || { n: 0 };
  if (depth > MAX_DEPTH || seen.n++ > ASSET_WALK_LIMIT) return false;
  if (hasImageFill(n)) return true;
  return 'children' in n && n.children.some(c => c.visible !== false && hasNestedImageFill(c, depth + 1, seen));
}
function isIconLike(n) {
  // A vector-shaped container is still raster artwork when any visible paint or
  // descendant contains an image (including inside a boolean operation).
  if (hasNestedImageFill(n)) return false;
  if (n.type === 'VECTOR' || n.type === 'BOOLEAN_OPERATION' || n.type === 'STAR' || n.type === 'POLYGON') return true;
  if ((n.type === 'FRAME' || n.type === 'GROUP' || n.type === 'INSTANCE' || n.type === 'COMPONENT') &&
      'children' in n && n.children.length && n.width <= 128 && n.height <= 128) {
    return allVector(n);
  }
  return false;
}
/* ------------------------------------------------------------------ */
/* Vector illustrations: one asset, not a hundred divs                 */
/* A frame that is nothing but paths, shapes and boolean operations is  */
/* artwork. Converting each inner path into markup produces hundreds of */
/* unreachable nodes that never match the design pixel for pixel; the    */
/* whole frame is exported as one SVG instead. Frames that contain text, */
/* instances, components or raster paint stay UI and are converted.      */
/* ------------------------------------------------------------------ */
const ILLUSTRATION_HINT = /(illustration|artwork|vector|logo|mascot|drawing|graphic|diagram|hero.?art|sketch|painting|isometric)/i;
/* A semantic UI name beats a coincidence: "Icon button", "Logo link" are UI. */
const UI_NAME_HINT = /(button|btn|input|field|form|nav|menu|header|footer|toolbar|tab|card|modal|dialog|table|row|list|item|link|badge|chip|avatar|checkbox|radio|toggle|slider|tooltip|dropdown|select|search|pagination|breadcrumb|alert|banner|toast)/i;

/** Bounded scan: what is actually inside this layer? */
function vectorScan(node) {
  const st = { nodes: 0, vectors: 0, maxDepth: 0, allVector: true, svgExport: false, text: 0, instances: 0, raster: 0 };
  (function walk(n, depth) {
    if (st.nodes > ASSET_WALK_LIMIT || depth > MAX_DEPTH) { st.allVector = false; return; }
    if (n.visible === false) return;
    st.nodes++;
    st.maxDepth = Math.max(st.maxDepth, depth);
    if (depth === 0) {
      const es = 'exportSettings' in n ? n.exportSettings : [];
      st.svgExport = es.some(e => e && String(e.format).toUpperCase() === 'SVG');
    }
    if (n.type === 'TEXT') st.text++;
    else if (n.type === 'INSTANCE' || n.type === 'COMPONENT' || n.type === 'COMPONENT_SET') st.instances++;
    if (hasImageFill(n)) st.raster++;
    if (VECTORISH[n.type]) st.vectors++;
    if (!('children' in n)) {
      if (!VECTORISH[n.type] && n.type !== 'GROUP' && n.type !== 'BOOLEAN_OPERATION') st.allVector = false;
      return;
    }
    if (n.type === 'BOOLEAN_OPERATION') return; // its children are consumed by the boolean
    for (const c of n.children) walk(c, depth + 1);
  })(node, 0);
  if (st.text || st.instances || st.raster) st.allVector = false;
  return st;
}

/**
 * Decide whether a layer is a self-contained illustration that should ship as one
 * SVG. Returns null for UI, or { reason, vectors, nodes, depth } for artwork.
 * mode: 'auto' (default) | 'named' (name or explicit SVG export only) | 'off'.
 */
function illustrationPlan(node, mode) {
  if (!node || node.visible === false || mode === 'off') return null;
  if (typeof node.width !== 'number' || typeof node.height !== 'number') return null;
  if (node.width <= 0 || node.height <= 0) return null;
  const st = vectorScan(node);
  if (!st.allVector || st.raster) return null;
  if (st.vectors < 2) return null;                 // a single shape is not an illustration
  if (st.nodes > ASSET_WALK_LIMIT) return null;    // too big to be one sane asset
  if (st.maxDepth > 48) return null;               // deeply nested artwork exports poorly
  const name = String(node.name || '');
  const named = ILLUSTRATION_HINT.test(name) && !UI_NAME_HINT.test(name);
  const complex = st.vectors >= 12 && (node.width > 256 || node.height > 256);
  const stats = { vectors: st.vectors, nodes: st.nodes, depth: st.maxDepth };
  if (st.svgExport) return Object.assign({ reason: 'svg-export' }, stats);
  if (named) return Object.assign({ reason: 'name' }, stats);
  if (mode === 'auto' && complex) return Object.assign({ reason: 'complexity' }, stats);
  return null;
}

/* ------------------------------------------------------------------ */
/* Complexity assessment & limits                                      */
/* ------------------------------------------------------------------ */
const RUN_LIMITS = {
  maxNodes: 6000,          // layers we will walk to describe a design
  maxGenerateNodes: 2500,  // layers per code generation (the engine truncates past this)
  maxDepth: MAX_DEPTH,
  maxAssets: 400,
  maxMs: 15000,
  maxStoreKb: 200
};
/**
 * Estimate how expensive a layer is before generating anything, so the panel can
 * warn, offer a smaller selection or refuse, instead of freezing. Bounded: it
 * stops at 6000 nodes and says so.
 */
function assessComplexity(node) {
  const out = { nodes: 0, depth: 0, text: 0, vectors: 0, instances: 0, images: 0, components: 0, clipped: false, level: 'small', estimatedMs: 0, warnings: [] };
  if (!node) return out;
  (function walk(n, depth) {
    if (out.nodes >= RUN_LIMITS.maxNodes || depth > MAX_DEPTH) { out.clipped = true; return; }
    if (n.visible === false) return;
    out.nodes++;
    out.depth = Math.max(out.depth, depth);
    if (n.type === 'TEXT') out.text++;
    else if (VECTORISH[n.type]) out.vectors++;
    else if (n.type === 'INSTANCE') out.instances++;
    else if (n.type === 'COMPONENT' || n.type === 'COMPONENT_SET') out.components++;
    if (hasImageFill(n)) out.images++;
    if ('children' in n) n.children.forEach(c => walk(c, depth + 1));
  })(node, 0);
  // Deliberately conservative: a layout pass per node, an export per vector asset
  // and a raster export per image fill.
  out.estimatedMs = Math.round(out.nodes * 0.4 + out.vectors * 1.2 + out.images * 25);
  out.level = out.nodes > 4000 ? 'extreme' : out.nodes > 1200 ? 'large' : out.nodes > 300 ? 'medium' : 'small';
  if (out.clipped) out.warnings.push('This layer has more than ' + RUN_LIMITS.maxNodes.toLocaleString('en-US') + ' layers - counts stop there.');
  if (out.depth > 80) out.warnings.push('Nesting is ' + out.depth + ' levels deep; layers past ' + MAX_DEPTH + ' are omitted.');
  if (out.images > 40) out.warnings.push(out.images + ' image fills: exporting them takes a while.');
  if (out.nodes > RUN_LIMITS.maxGenerateNodes) out.warnings.push('Past ' + RUN_LIMITS.maxGenerateNodes.toLocaleString('en-US') + ' layers the code is truncated - select a child frame for the rest.');
  return out;
}

/** Bounded local storage (clientStorage) for projects and revision history. */
async function storeGet(key) {
  try {
    const raw = await figma.clientStorage.getAsync('devready-' + key);
    if (!raw) return null;
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (e) { diag('local storage', e); return null; }
}
async function storeSet(key, json) {
  const text = String(json || '');
  if (text.length > RUN_LIMITS.maxStoreKb * 1024) {
    throw new Error('That is too much data to keep locally (' + Math.round(text.length / 1024) + ' kB, limit ' + RUN_LIMITS.maxStoreKb + ' kB).');
  }
  const parsed = JSON.parse(text); // reject garbage before it is persisted
  await figma.clientStorage.setAsync('devready-' + key, JSON.stringify(parsed));
  return true;
}

function collectAssets(root, limit, svgMode) {
  const out = [];
  let visited = 0;
  const mode = svgMode || 'auto';
  (function walk(n, depth) {
    if (out.length >= limit || visited++ > 4000) return;
    if (depth > MAX_DEPTH) return;
    if (n.visible === false) return;
    const hasExport = 'exportSettings' in n && n.exportSettings.length > 0;
    if (n !== root) {
      const illo = illustrationPlan(n, mode);
      if (illo) {
        out.push({ id: n.id, name: n.name, type: n.type, kind: 'illustration', reason: illo.reason, vectors: illo.vectors, formats: ['SVG'], w: round(n.width), h: round(n.height) });
        return;
      }
    }
    if (hasExport) {
      out.push({ id: n.id, name: n.name, type: n.type, kind: 'export', formats: n.exportSettings.map(e => e.format + (e.constraint && e.constraint.type === 'SCALE' && e.constraint.value !== 1 ? '@' + e.constraint.value + 'x' : '')), w: round(n.width), h: round(n.height) });
      return;
    }
    if (n !== root && isIconLike(n)) { out.push({ id: n.id, name: n.name, type: n.type, kind: 'icon', w: round(n.width), h: round(n.height) }); return; }
    if (hasImageFill(n)) out.push({ id: n.id, name: n.name, type: n.type, kind: 'image', w: round(n.width), h: round(n.height) });
    if ('children' in n) for (const c of n.children) walk(c, depth + 1);
  })(root, 0);
  return out;
}

async function exportNode(id, format, scale) {
  const node = await figma.getNodeByIdAsync(id);
  if (!node || !('exportAsync' in node)) throw new Error('Cannot export this layer');
  const opts = { format: format };
  if (format === 'PNG' || format === 'JPG') opts.constraint = { type: 'SCALE', value: scale || 1 };
  if (format === 'SVG') opts.svgOutlineText = true;
  const bytes = await node.exportAsync(opts);
  const ext = format.toLowerCase();
  const suffix = (format === 'PNG' || format === 'JPG') && scale && scale !== 1 ? '@' + scale + 'x' : '';
  return { name: slug(node.name) + suffix + '.' + ext, bytes: bytes };
}

/* ------------------------------------------------------------------ */
/* CODE ENGINE — Figma tree → clean, production-style code             */
/*  • semantic BEM class names (no "frame-2121453060")                 */
/*  • shared classes for identical styles, component extraction (React)*/
/*  • CSS variables collected into :root, fonts hoisted, scoped reset  */
/*  • icons exported as assets, lists → ul/li, buttons → <button>      */
/* ------------------------------------------------------------------ */
const GENERIC_NAME = /^(frame|group|rectangle|rect|ellipse|vector|line|polygon|star|container|auto ?layout|component|instance|layer|union|subtract|intersect|exclude|mask|image|img|shape|path|wrapper|div|box|copy|selection|untitled)([\s_-]*(copy|\d+))*$/i;

function isNumericText(s) {
  return /^[\s+\-–−]*[$₹€£¥]?\s*[\d][\d.,]*\s*[%kKmMbBx+]?\s*$/.test(String(s).trim());
}
function cleanName(s) {
  if (!s) return '';
  const last = String(s).split('/').pop();
  const n = slug(last.replace(/=/g, ' ')).replace(/^[\d-]+/, '');
  return n.length > 32 ? n.slice(0, 32).replace(/-[^-]*$/, '') : n;
}
function camel(s) {
  const p = String(s || '').replace(/[^a-zA-Z0-9]+/g, ' ').trim().split(/\s+/);
  const out = p.map((w, i) => i ? w.charAt(0).toUpperCase() + w.slice(1) : w.toLowerCase()).join('');
  return /^[a-zA-Z_]/.test(out) ? out : 'v' + out;
}
function nodeIsGeneric(node) {
  const n = String(node.name || '').trim();
  if (!n || GENERIC_NAME.test(n)) return true;
  if (/^[\d\s.,:%+\-–—$₹€£#()]+$/.test(n)) return true;
  if (/\d{5,}/.test(n)) return true; // "Frame 2121453060", imported ids
  if (node.type === 'TEXT') {
    try { if (node.autoRename) return true; } catch (e) { /* ignore */ }
    if (n === String(node.characters).trim().slice(0, n.length)) return true;
  }
  return false;
}
function cleanCss(raw) {
  const o = {};
  Object.keys(raw || {}).forEach(k => {
    const v = String(raw[k]).replace(/\/\*[\s\S]*?\*\//g, '').trim();
    if (!v) return;
    if (k === 'font-style' && v === 'normal') return;
    o[k] = v;
  });
  return o;
}
const LAYOUT_KEYS = ['position', 'left', 'top', 'right', 'bottom', 'flex-shrink', 'align-self', 'flex', 'opacity', 'z-index'];

async function compInfo(node) {
  if (node.type !== 'INSTANCE') return null;
  try {
    const main = await node.getMainComponentAsync();
    if (!main) return null;
    const set = main.parent && main.parent.type === 'COMPONENT_SET' ? main.parent : null;
    let props = [];
    try {
      const cp = node.componentProperties || {};
      props = Object.keys(cp).map(k => ({ name: k.split('#')[0], type: cp[k].type, value: cp[k].value }));
    } catch (e) { /* ignore */ }
    return { key: main.id, mapKey: (set ? set.key : main.key) || main.id, name: set ? set.name : main.name, variant: set ? main.name : '', props: props, remote: !!main.remote };
  } catch (e) { return null; }
}
function variantSlug(v) {
  if (!v) return '';
  return slug(v.split(/,\s*/).map(kv => kv.split('=')[1] || kv).filter(x => !/^(default|false|off|none)$/i.test(x)).join(' '));
}

function textRuns(node) {
  let segs;
  try { segs = node.getStyledTextSegments(['fontWeight', 'fontSize', 'fills', 'textDecoration', 'fontName']); } catch (e) { return null; }
  if (!segs || segs.length < 2) return null;
  const base = segs[0];
  const col = s => { const f = s.fills.find(p => p.type === 'SOLID' && p.visible !== false); return f ? colorHex(f.color, f.opacity === undefined ? 1 : f.opacity) : null; };
  const runs = segs.map(s => {
    const d = {};
    if (s.fontWeight !== base.fontWeight) d['font-weight'] = String(s.fontWeight);
    if (s.fontSize !== base.fontSize) d['font-size'] = round(s.fontSize) + 'px';
    if (col(s) && col(s) !== col(base)) d.color = col(s);
    if (s.textDecoration !== base.textDecoration) d['text-decoration'] = s.textDecoration === 'UNDERLINE' ? 'underline' : s.textDecoration === 'STRIKETHROUGH' ? 'line-through' : 'none';
    if (s.fontName.family !== base.fontName.family) d['font-family'] = '"' + s.fontName.family + '"';
    const it = /italic/i.test(s.fontName.style);
    if (it !== /italic/i.test(base.fontName.style)) d['font-style'] = it ? 'italic' : 'normal';
    return { text: s.characters, css: Object.keys(d).length ? d : null };
  });
  return runs.some(r => r.css) ? runs : null;
}

/* ---------- pass 1: raw tree ---------- */
const isAutoLayout = n => !!n && 'layoutMode' in n && !!n.layoutMode && n.layoutMode !== 'NONE';
/**
 * Geometry from the node itself. getCSSAsync() describes a layer's own styles but not
 * where it sits inside a non-auto-layout frame or group, so without this, free-positioned
 * layers would just stack in normal flow.
 */
function applyGeometry(node, el, isRoot) {
  if (!el) return el;
  const c = el.css;
  const px = v => round(v) + 'px';
  const text = node.type === 'TEXT';
  const ar = text ? node.textAutoResize : null;
  if (text && ar === 'WIDTH_AND_HEIGHT') c['white-space'] = 'nowrap';
  const p = node.parent;
  if (!isRoot && p) {
    const abs = !isAutoLayout(p) || node.layoutPositioning === 'ABSOLUTE';
    const A = node.absoluteBoundingBox, B = p.absoluteBoundingBox;
    if (abs && A && B) {
      ['right', 'bottom', 'inset', 'margin', 'align-self', 'flex', 'flex-grow', 'flex-shrink', 'flex-basis'].forEach(k => delete c[k]);
      const rotated = node.rotation && Math.abs(node.rotation) > 0.01 && el.kind !== 'img';
      c.position = 'absolute';
      if (rotated) { c.left = px(node.x - (p.type === 'GROUP' ? p.x : 0)); c.top = px(node.y - (p.type === 'GROUP' ? p.y : 0)); }
      else { c.left = px(A.x - B.x); c.top = px(A.y - B.y); delete c.transform; }
      if (el.kind !== 'mapped') {
        const w = el.kind === 'img' ? A.width : node.width, h = el.kind === 'img' ? A.height : node.height;
        if (!text || ar === 'NONE' || ar === 'TRUNCATE' || ar === 'HEIGHT') c.width = px(w);
        if (!text || ar === 'NONE' || ar === 'TRUNCATE') c.height = px(h);
      }
    } else if (!abs && el.kind !== 'img') {
      const dir = p.layoutMode, sh = node.layoutSizingHorizontal, sv = node.layoutSizingVertical;
      if (sh === 'FIXED' && !c.width) c.width = px(node.width);
      if (sv === 'FIXED' && !c.height && !text) c.height = px(node.height);
      if (sh === 'FILL') { if (dir === 'HORIZONTAL') { if (!c.flex) c.flex = '1 0 0'; delete c.width; } else { c['align-self'] = 'stretch'; delete c.width; } }
      if (sv === 'FILL') { if (dir === 'VERTICAL') { if (!c.flex) c.flex = '1 0 0'; delete c.height; } else { c['align-self'] = 'stretch'; delete c.height; } }
      if (((sh === 'FIXED' && dir === 'HORIZONTAL') || (sv === 'FIXED' && dir === 'VERTICAL')) && !c.flex && !c['flex-shrink']) c['flex-shrink'] = '0';
    }
  }
  const container = el.kind === 'box' && 'children' in node;
  if (container && !isAutoLayout(node)) {
    if (!c.position) c.position = 'relative';
    if (!c.width) c.width = px(node.width);
    if (!c.height) c.height = px(node.height);
  }
  if (container && node.clipsContent && !c.overflow) c.overflow = 'hidden';
  return el;
}
const JOBS = {};
const ghReposCache = [];
/* A cancelled job stops at the next layer instead of running to completion. */
const CANCEL = { cancelled: true };
function jobCancelled(ctx) { return !!(ctx && ctx.job && ctx.job.cancelled); }
async function buildRaw(node, ctx, isRoot, inInst, depth) {
  if (jobCancelled(ctx)) throw CANCEL;
  return applyGeometry(node, await buildRawNode(node, ctx, isRoot, inInst, depth || 0), isRoot);
}
async function buildRawNode(node, ctx, isRoot, inInst, depth) {
  if (node.visible === false || node.opacity === 0) return null;
  if (ctx.count >= ctx.max) { ctx.truncated = true; return null; }
  if (depth > MAX_DEPTH) { ctx.truncated = true; ctx.depthLimited = true; return null; }
  ctx.count++;
  const el = { id: node.id, type: node.type, name: node.name, generic: nodeIsGeneric(node), kind: 'box', tag: 'div', css: {}, children: [], attrs: {}, inInst: !!inInst, w: node.width, h: node.height };
  const rawCss = await safeCSS(node);
  el.css = cleanCss(rawCss);
  if (isRoot) LAYOUT_KEYS.forEach(k => { if (k !== 'opacity') delete el.css[k]; });
  // Figma children are back-to-front. DOM order alone is insufficient when
  // absolute siblings are painted in a different CSS stacking phase, and auto
  // layout can explicitly reverse canvas stacking. Preserve both semantics with
  // sibling-local z-index values (including on raster/mapped children).
  const parent = node.parent;
  const mixedPaintOrder = parent && isAutoLayout(parent) && 'children' in parent && parent.children.some(c => c.layoutPositioning === 'ABSOLUTE');
  if (!isRoot && parent && 'children' in parent && (mixedPaintOrder || parent.itemReverseZIndex === true)) {
    const index = parent.children.indexOf(node);
    if (index > -1) el.css['z-index'] = String(parent.itemReverseZIndex === true ? parent.children.length - index : index + 1);
  }
  collectVarIds(node, ctx);
  el.comp = await compInfo(node);

  // Code Connect-style mapping: render the mapped code component instead of its internals
  if (!isRoot && ctx.react && el.comp && ctx.mappings[el.comp.mapKey]) {
    const map = ctx.mappings[el.comp.mapKey];
    el.kind = 'mapped'; el.tag = map.name; el.map = map;
    el.mapProps = mapProps(el.comp.props);
    const css = {};
    LAYOUT_KEYS.forEach(k => { if (el.css[k] !== undefined) css[k] = el.css[k]; });
    el.css = css;
    (ctx.imports[map.path] = ctx.imports[map.path] || {})[map.name] = 1;
    return el;
  }

  const hasExport = 'exportSettings' in node && node.exportSettings.length > 0;
  const leafImage = hasImageFill(node) && !('children' in node && node.children.length);
  // Self-contained vector artwork (illustrations, logos, complex diagrams) is one
  // SVG asset. Its inner paths never become markup: they are unreachable nodes that
  // cannot match the design pixel for pixel. A selected illustration frame is
  // included, so generating code for artwork produces an image, not a guess.
  const illo = illustrationPlan(node, ctx.svgFrames);
  if (illo) {
    el.kind = 'img'; el.tag = 'img';
    el.base = 'illustration';
    el.illustration = illo;
    el.attrs.alt = node.name || 'Illustration';
    const key = node.id;
    let file = ctx.assetByKey[key];
    if (!file) {
      const baseName = cleanName(node.name) || 'illustration';
      let fname = baseName, i = 1;
      while (ctx.assetNames[fname]) fname = baseName + '-' + (++i);
      ctx.assetNames[fname] = 1;
      file = { id: node.id, file: fname + '.svg', format: 'SVG', scale: 1, varName: camel(fname) + 'Illustration', illustration: illo.reason };
      ctx.assetByKey[key] = file;
      ctx.assets.push(file);
    }
    el.asset = file;
    const css = { width: round(node.width) + 'px', height: round(node.height) + 'px' };
    LAYOUT_KEYS.forEach(k => { if (el.css[k] !== undefined) css[k] = el.css[k]; });
    el.css = css;
    return el;
  }
  // TEXT stays accessible, selectable text even when a designer gave it export
  // settings. Asset export belongs to the Assets panel; it must not rasterise copy.
  if (node.type !== 'TEXT' && !isRoot && (isIconLike(node) || hasExport || leafImage)) {
    el.kind = 'img'; el.tag = 'img';
    const icon = isIconLike(node);
    const requested = hasExport ? node.exportSettings[0].format : (icon ? 'SVG' : 'PNG');
    const fmt = ['PNG', 'JPG', 'SVG'].indexOf(requested) > -1 ? requested : 'PNG';
    const scale = fmt === 'PNG' || fmt === 'JPG' ? 2 : 1;
    const key = el.comp ? el.comp.key : node.id;
    let file = ctx.assetByKey[key];
    if (!file) {
      const baseName = (el.comp && cleanName(el.comp.variant ? el.comp.name + ' ' + variantSlug(el.comp.variant) : el.comp.name)) ||
        (!el.generic && cleanName(node.name)) || (icon ? 'icon' : 'image');
      let fname = baseName, i = 1;
      while (ctx.assetNames[fname]) fname = baseName + '-' + (++i);
      ctx.assetNames[fname] = 1;
      file = { id: node.id, file: fname + '.' + fmt.toLowerCase(), format: fmt, scale: scale, varName: /(icon|img|image)$/i.test(camel(fname)) ? camel(fname) : camel(fname) + (fmt === 'SVG' ? 'Icon' : 'Img') };
      ctx.assetByKey[key] = file;
      ctx.assets.push(file);
    }
    el.asset = file;
    el.base = icon ? 'icon' : 'image';
    el.attrs.alt = icon ? '' : (el.generic ? '' : node.name);
    const w = node.rotation ? (node.absoluteBoundingBox || node).width : node.width;
    const h = node.rotation ? (node.absoluteBoundingBox || node).height : node.height;
    const css = { width: round(w) + 'px', height: round(h) + 'px' };
    LAYOUT_KEYS.forEach(k => { if (el.css[k] !== undefined) css[k] = el.css[k]; });
    el.css = css; // drop transforms/fills — they're baked into the exported file
    return el;
  }

  if (node.type === 'TEXT') {
    el.kind = 'text';
    el.text = node.characters;
    el.textAutoResize = node.textAutoResize;
    el.fontSize = isMixed(node.fontSize) ? 16 : node.fontSize;
    el.runs = textRuns(node);
    // Browser `normal` line-height is font- and platform-dependent. Auto-width
    // text cannot wrap, so explicit lines and a uniform font size have a known
    // line count and Figma's height gives the exact line box. Fixed-width text
    // is measured from Figma's own SVG baselines in resolveAutoLineHeights().
    const mixedSizes = (el.runs || []).some(r => r.css && r.css['font-size']);
    if (['react-native', 'swiftui', 'compose', 'flutter'].indexOf(ctx.lang) < 0 && el.css['line-height'] === 'normal' && el.text && node.textAutoResize === 'WIDTH_AND_HEIGHT' && node.height > 0 && !mixedSizes && !(node.paragraphSpacing > 0)) {
      const lines = el.text.split(/\r\n|\r|\n/).length;
      el.css['line-height'] = round(node.height / lines) + 'px';
    }
    collectFonts(node, ctx);
    // Inside an instance, read the main component's default text so naming stays
    // consistent across instances ("342" and "Friday" both become __value).
    if (inInst && node.id.indexOf(';') > -1) {
      try {
        const mainText = await figma.getNodeByIdAsync(node.id.split(';').pop());
        if (mainText && mainText.type === 'TEXT') {
          el.mainText = mainText.characters;
          if (el.name === mainText.characters || mainText.autoRename) el.generic = true;
        }
      } catch (e) { /* ignore */ }
    }
    if (!isNumericText(el.text)) ctx.maxFont = Math.max(ctx.maxFont, el.fontSize);
    return el;
  }

  if ('children' in node) {
    const kids = await Promise.all(node.children.map(c => buildRaw(c, ctx, false, inInst || node.type === 'INSTANCE', depth + 1)));
    el.children = kids.filter(Boolean);
  }
  el.isBlock = !isRoot && (node.type === 'INSTANCE' || node.type === 'COMPONENT') && !!(el.comp || !el.generic);
  return el;
}

/* ---------- pass 2: structure, semantics, CSS hygiene ---------- */
function blockTexts(block) {
  if (block._texts) return block._texts;
  const out = [];
  (function w(e) { e.children.forEach(c => { if (c.kind === 'text') out.push(c); else if (!c.isBlock) w(c); }); })(block);
  block._texts = out;
  return out;
}
function textName(el, ctx) {
  if (!el.generic) { const n = cleanName(el.name); if (n) return n; }
  const t = String(el.mainText !== undefined ? el.mainText : el.text).trim();
  if (isNumericText(t)) return /%/.test(t) ? 'change' : 'value';
  const words = t.split(/\s+/).filter(Boolean);
  const texts = blockTexts(el.block).filter(x => !isNumericText(x.mainText !== undefined ? x.mainText : x.text));
  const max = texts.reduce((m, x) => Math.max(m, x.fontSize), 0);
  const min = texts.reduce((m, x) => Math.min(m, x.fontSize), Infinity);
  const isFirstMax = texts.find(x => x.fontSize === max) === el;
  if (isFirstMax && words.length <= 10 && (el.fontSize >= 18 || (texts.length > 1 && el.fontSize > min))) return 'title';
  if (el.inInst) return el.fontSize <= 13 ? 'label' : el.fontSize >= 18 ? 'subtitle' : 'text';
  if (words.length <= 3) { const sl = slug(words.join(' ')); if (sl && sl.length <= 24 && !/^\d/.test(sl)) return sl; }
  if (el.fontSize >= 20) return 'heading';
  if (el.fontSize <= 12) return 'caption';
  return words.length > 12 ? 'description' : 'text';
}
function containerName(el, parent) {
  const c = el.css, kids = el.children;
  const bg = c.background || c['background-color'];
  if (el.tag === 'ul') return 'list';
  if (bg && c['border-radius'] && kids.length && el.h <= 36) return 'badge';
  if (bg && (c['border-radius'] || c['box-shadow'] || c.border) && kids.length) return 'card';
  if (parent && !parent.parent && parent.children[0] === el && c.display === 'flex' && c['flex-direction'] !== 'column' && kids.some(k => k.kind === 'text')) return 'header';
  if (kids.length && kids.every(k => k.kind === 'text')) return kids.length === 1 ? 'label' : 'content';
  if (kids.length === 2 && kids.some(k => k.kind === 'img') && kids.some(k => k.kind === 'text')) return 'item';
  if (!kids.length) return bg ? 'shape' : 'spacer';
  if (c.display === 'flex') return c['flex-direction'] === 'column' ? 'stack' : 'row';
  return 'group';
}
function semanticTag(name) {
  const n = String(name || '').toLowerCase();
  if (/\b(button|btn|cta)\b/.test(n)) return 'button';
  if (/\blink\b/.test(n)) return 'a';
  if (/\b(nav|navbar|navigation|menu bar)\b/.test(n)) return 'nav';
  if (/\bheader\b/.test(n)) return 'header';
  if (/\bfooter\b/.test(n)) return 'footer';
  return null;
}
function structurePass(el, parent, ctx, block) {
  el.parent = parent; el.depth = parent ? parent.depth + 1 : 0; el.block = block || el;
  const pc = parent ? parent.css : null;
  // flex-only props are noise if the parent isn't a flex container
  if (pc && !/flex|grid/.test(pc.display || '')) { delete el.css['flex-shrink']; delete el.css['align-self']; delete el.css.flex; }
  // absolute children need a positioned parent
  if (el.children.some(c => c.css.position === 'absolute') && !el.css.position) el.css.position = 'relative';

  if (el.kind === 'text') {
    el.base = textName(el, ctx);
    const inline = parent && (parent.tag === 'button' || parent.tag === 'a');
    if (inline) el.tag = 'span';
    else if (el.base === 'title' && !el.inInst && !ctx.usedTitle) { ctx.usedTitle = true; el.tag = ctx.rootWidth >= 900 ? 'h1' : 'h2'; }
    else if (el.base === 'title' && el.inInst) el.tag = 'h3';
    else if (el.base === 'heading') el.tag = 'h3';
    else el.tag = 'p';
    return;
  }
  if (el.kind === 'img') return;
  if (el.kind === 'mapped') { el.base = slug(el.map.name) || 'component'; return; }

  const sem = semanticTag(el.comp ? el.comp.name : el.name);
  if (sem) el.tag = sem;
  if (el.tag === 'button') el.attrs.type = 'button';
  if (el.tag === 'a') el.attrs.href = '#';

  // repeated instances of one component → list
  const k = el.children;
  if (k.length >= 3 && k.every(c => c.comp && c.comp.key === k[0].comp.key) && el.tag === 'div') {
    el.tag = 'ul';
    if (!el.css.padding) el.css.padding = '0';
    el.css.margin = '0';
    el.css['list-style'] = 'none';
    k.forEach(c => { if (c.tag === 'div') c.tag = 'li'; });
  }
  const nextBlock = el.isBlock ? el : (block || el);
  el.children.forEach(c => structurePass(c, el, ctx, nextBlock));
  // name containers after children are known (post-order)
  el.base = el.isBlock ? (cleanName(el.generic ? (el.comp && el.comp.name) : el.name) || 'component')
    : (!el.generic && cleanName(el.name)) || containerName(el, parent);
}
function walk(el, fn) { fn(el); el.children.forEach(c => walk(c, fn)); }

function hoistFont(root) {
  const count = {};
  walk(root, e => { const f = e.css['font-family']; if (e.kind === 'text' && f) count[f] = (count[f] || 0) + 1; });
  const top = Object.keys(count).sort((a, b) => count[b] - count[a])[0];
  if (!top) return null;
  walk(root, e => { if (e !== root && e.css['font-family'] === top) delete e.css['font-family']; });
  root.css['font-family'] = top;
  return top;
}
const VAR_RE = /var\((--[A-Za-z0-9_-]+),\s*((?:[^()]|\([^()]*\))*)\)/g;
function collectVars(root, ctx) {
  const fix = css => Object.keys(css).forEach(k => {
    css[k] = css[k].replace(VAR_RE, (m, name, fb) => { if (!ctx.vars[name]) ctx.vars[name] = fb.trim(); return 'var(' + name + ')'; });
  });
  walk(root, e => { fix(e.css); (e.runs || []).forEach(r => r.css && fix(r.css)); });
}

/* ---------- pass 3: BEM naming + class de-duplication ---------- */
function cssKey(css) { return Object.keys(css).sort().map(k => k + ':' + css[k]).join(';'); }
function claim(ctx, base, css, variant) {
  const key = cssKey(css);
  const list = ctx.classes[base] || (ctx.classes[base] = []);
  const hit = list.find(x => x.key === key);
  if (hit) return hit.cls;
  let cls = base;
  if (list.length) {
    const mod = variant ? base + '--' + variant : '';
    cls = mod && !list.some(x => x.cls === mod) ? mod : base + '-' + (list.length + 1);
  }
  list.push({ key: key, cls: cls, css: css });
  ctx.order.push({ cls: cls, css: css });
  return cls;
}
function namePass(el, block, ctx, isRoot) {
  let childBlock = block;
  if (isRoot) { el.cls = claim(ctx, block, el.css); }
  else if (el.isBlock) { childBlock = el.base; el.cls = claim(ctx, el.base, el.css, el.comp ? variantSlug(el.comp.variant) : ''); }
  else if (el.kind === 'mapped' && !Object.keys(el.css).length) el.cls = '';
  else el.cls = claim(ctx, block + '__' + el.base, el.css);
  if (el.runs) {
    el.runs.forEach(r => {
      if (!r.css) return;
      const lbl = Object.keys(r.css).length === 1 && r.css['font-weight'] ? 'strong' : r.css.color ? 'accent' : 'span';
      r.cls = claim(ctx, el.cls + '-' + lbl, r.css);
    });
  }
  el.children.forEach(c => namePass(c, childBlock, ctx, false));
}

/* ---------- pass 4 (React): extract repeated components ---------- */
function sig(el) { return el.tag + '.' + el.cls + '[' + el.children.map(sig).join(',') + ']'; }
function leaves(el, out) { if (el.kind === 'text' || el.kind === 'img' || el.kind === 'mapped') out.push(el); el.children.forEach(c => leaves(c, out)); return out; }
function extractComponents(root, ctx) {
  const groups = {};
  walk(root, e => { if (e !== root && e.isBlock && e.comp) { const k = e.comp.key + '|' + sig(e); (groups[k] = groups[k] || []).push(e); } });
  const defs = [];
  const usedNames = { [ctx.rootName]: 1 };
  const insideUsage = e => { let p = e.parent; while (p) { if (p.usage) return true; p = p.parent; } return false; };
  Object.keys(groups).sort((a, b) => groups[a][0].depth - groups[b][0].depth).forEach(k => {
    const list = groups[k].filter(e => !insideUsage(e));
    if (list.length < 2) return;
    const tpl = list[0];
    let name = pascal(tpl.cls.replace(/--/g, ' '));
    let n = name, i = 1; while (usedNames[n]) n = name + (++i); name = n; usedNames[name] = 1;
    const tl = leaves(tpl, []);
    const all = list.map(e => leaves(e, []));
    const props = []; const propNames = {};
    let unsafe = false;
    tl.forEach((leaf, idx) => {
      const vals = all.map(l => leaf.kind === 'text' ? l[idx].text : leaf.kind === 'mapped' ? JSON.stringify(l[idx].mapProps) : l[idx].asset.varName);
      if (vals.every(v => v === vals[0])) return;
      if (leaf.kind === 'mapped') { unsafe = true; return; }
      const pn = camel(leaf.kind === 'img' ? 'icon' : (leaf.base || 'text'));
      let p = pn, j = 1; while (propNames[p]) p = pn + (++j); propNames[p] = 1;
      props.push({ idx: idx, name: p, kind: leaf.kind });
    });
    if (unsafe) return;
    const def = { name: name, tpl: tpl, props: props };
    defs.push(def);
    list.forEach((e, ii) => {
      const l = all[ii];
      e.usage = { def: def, values: props.map(p => ({ name: p.name, kind: p.kind, value: p.kind === 'text' ? l[p.idx].text : l[p.idx].asset.varName, file: p.kind === 'img' ? l[p.idx].asset.file : '' })) };
    });
    // mark template leaves with prop refs
    props.forEach(p => { tl[p.idx].prop = p.name; });
  });
  return defs;
}

/* ---------- renderers ---------- */
function escHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function escAttr(s) { return escHtml(s).replace(/"/g, '&quot;'); }
function ind(n) { return '  '.repeat(n); }

function htmlText(el) {
  const fmt = t => escHtml(t).replace(/\n/g, '<br />');
  if (!el.runs) return fmt(el.text);
  return el.runs.map(r => r.cls ? '<span class="' + r.cls + '">' + fmt(r.text) + '</span>' : fmt(r.text)).join('');
}
function renderHTML(el, d) {
  const attrs = ' class="' + el.cls + '"' + Object.keys(el.attrs).filter(k => k !== 'alt').map(k => ' ' + k + '="' + escAttr(el.attrs[k]) + '"').join('');
  if (el.kind === 'img' && el.asset.svg) return ind(d) + el.asset.svg.replace(/^<svg\b/, '<svg class="' + el.cls + '"' + (el.attrs.alt ? ' role="img" aria-label="' + escAttr(el.attrs.alt) + '"' : ' aria-hidden="true"') + ' focusable="false"');
  if (el.kind === 'img') return ind(d) + '<img' + attrs + ' src="' + (el.asset.src || 'assets/' + el.asset.file) + '" alt="' + escAttr(el.attrs.alt) + '"' + (el.attrs.alt ? '' : ' aria-hidden="true"') + ' />';
  if (el.kind === 'text') return ind(d) + '<' + el.tag + attrs + '>' + htmlText(el) + '</' + el.tag + '>';
  if (!el.children.length) return ind(d) + '<' + el.tag + attrs + '></' + el.tag + '>';
  return ind(d) + '<' + el.tag + attrs + '>\n' + el.children.map(c => renderHTML(c, d + 1)).join('\n') + '\n' + ind(d) + '</' + el.tag + '>';
}

function jsxStr(s) { return /["{}<>\n\\]/.test(s) || /^\s|\s$/.test(s) ? '{' + JSON.stringify(s) + '}' : '"' + s + '"'; }
function jsxTextNode(t) {
  return t.split('\n').map(line => (/[{}<>]/.test(line) || /^\s|\s$/.test(line)) && line ? '{' + JSON.stringify(line) + '}' : line.replace(/&/g, '&amp;')).join('<br />');
}
function classAttr(el, mode, unit, base, css) {
  if (mode === 'tw') { const tw = cssToTailwind(css || el.css, unit, base).join(' '); return tw ? ' className="' + tw + '"' : ''; }
  return ' className="' + el.cls + '"';
}
function jsxText(el, mode, unit, base) {
  if (el.prop) return '{' + el.prop + '}';
  if (!el.runs) return jsxTextNode(el.text);
  return el.runs.map(r => r.css ? '<span' + (mode === 'tw' ? classAttr(r, mode, unit, base, r.css) : ' className="' + r.cls + '"') + '>' + jsxTextNode(r.text) + '</span>' : jsxTextNode(r.text)).join('');
}
function renderJSX(el, d, mode, unit, base, inDef) {
  if (el.usage && !inDef) {
    const props = el.usage.values.map(v => ' ' + v.name + '=' + (v.kind === 'img' ? '{' + v.value + '}' : jsxStr(v.value))).join('');
    return ind(d) + '<' + el.usage.def.name + props + ' />';
  }
  if (el.kind === 'mapped') {
    const cls = Object.keys(el.css).length ? classAttr(el, mode, unit, base) : '';
    const a = cls + el.mapProps.attrs.map(x => x.kind === 'bool' ? ' ' + x.name : ' ' + x.name + '=' + jsxStr(x.value)).join('');
    return el.mapProps.children !== null ? ind(d) + '<' + el.map.name + a + '>' + jsxTextNode(el.mapProps.children) + '</' + el.map.name + '>' : ind(d) + '<' + el.map.name + a + ' />';
  }
  const attrs = classAttr(el, mode, unit, base) + Object.keys(el.attrs).filter(k => k !== 'alt').map(k => ' ' + k + '="' + escAttr(el.attrs[k]) + '"').join('');
  if (el.kind === 'img') return ind(d) + '<img' + attrs + ' src={' + (el.prop || el.asset.varName) + '} alt="' + escAttr(el.attrs.alt) + '"' + (el.attrs.alt ? '' : ' aria-hidden="true"') + ' />';
  if (el.kind === 'text') return ind(d) + '<' + el.tag + attrs + '>' + jsxText(el, mode, unit, base) + '</' + el.tag + '>';
  if (!el.children.length) return ind(d) + '<' + el.tag + attrs + ' />';
  return ind(d) + '<' + el.tag + attrs + '>\n' + el.children.map(c => renderJSX(c, d + 1, mode, unit, base, inDef)).join('\n') + '\n' + ind(d) + '</' + el.tag + '>';
}
function cssBlock(sel, css, unit, base) {
  const body = Object.keys(css).map(k => '  ' + k + ': ' + remify(css[k], unit, base) + ';').join('\n');
  return body ? sel + ' {\n' + body + '\n}' : '';
}
function varsBlock(ctx, unit, base) {
  const names = Object.keys(ctx.vars);
  if (!names.length) return '';
  let out = ':root {\n' + names.map(n => '  ' + n + ': ' + remify(ctx.vars[n], unit, base) + ';').join('\n') + '\n}';
  Object.keys(ctx.themes || {}).forEach(sel => {
    const t = ctx.themes[sel];
    out += '\n\n' + sel + ' {\n' + Object.keys(t).map(n => '  ' + n + ': ' + remify(t[n], unit, base) + ';').join('\n') + '\n}';
  });
  return out;
}
function resetBlock(rootCls) {
  return '/* Scoped reset — Figma has no default margins */\n' +
    '.' + rootCls + ', .' + rootCls + ' *, .' + rootCls + ' *::before, .' + rootCls + ' *::after { box-sizing: border-box; }\n' +
    '.' + rootCls + ' :where(h1, h2, h3, p, ul, li, figure) { margin: 0; padding: 0; }\n' +
    '.' + rootCls + ' :where(button) { border: 0; background: none; padding: 0; font: inherit; color: inherit; cursor: pointer; }\n' +
    '.' + rootCls + ' :where(a) { color: inherit; text-decoration: none; }\n' +
    '.' + rootCls + ' :where(img) { display: block; }';
}
function stylesheet(ctx, rootCls, unit, base, pre, standalone) {
  const parts = [];
  // Components must not reset their host application. Standalone HTML+CSS is the
  // exception: without this, browsers add an 8px body margin around the design.
  if (standalone) parts.push('/* Standalone page reset */\nhtml, body { margin: 0; padding: 0; min-height: 100%; }\nbody { min-height: 100vh; }');
  if (pre) parts.push(pre);
  const v = varsBlock(ctx, unit, base); if (v) parts.push('/* Design tokens */\n' + v);
  parts.push(resetBlock(rootCls));
  const rules = ctx.order.map(r => cssBlock('.' + r.cls, r.css, unit, base)).filter(Boolean);
  parts.push(rules.join('\n\n'));
  if (ctx.embed && ctx.embed.list.length) parts.push('/* Embedded images (data URIs): swap for real files when you ship */\n:root {\n' + ctx.embed.list.map(x => '  ' + x.name + ': ' + x.value + ';').join('\n') + '\n}');
  return parts.join('\n\n') + '\n';
}

/* ------------------------------------------------------------------ */
/* Fonts: Google Fonts → <link>; other fonts → @font-face that uses     */
/* the installed copy, or the file the user uploaded (embedded/bundled) */
/* ------------------------------------------------------------------ */
const SYSTEM_FONTS = {
  sans: /^(sf pro( (text|display|rounded))?|sf compact( (text|display|rounded))?|system-ui|-apple-system|blinkmacsystemfont|helvetica( neue)?|arial|segoe ui|tahoma|verdana|trebuchet ms)$/i,
  serif: /^(new york( (small|medium|large|extra large))?|times( new roman)?|georgia)$/i,
  mono: /^(sf mono|menlo|monaco|courier( new)?|consolas)$/i
};
const STACK = {
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  serif: 'ui-serif, Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
};
function fontKind(fam) {
  const g = gfLookup(fam);
  if (g && (g.cat === 'm' || g.cat === 'r')) return g.cat === 'm' ? 'mono' : 'serif';
  if (g && g.cat === 's') return 'sans';
  const f = fam.toLowerCase();
  if (/mono|code|courier|menlo|consolas/.test(f)) return 'mono';
  if (!/sans/.test(f) && /serif|times|georgia|garamond|playfair|merriweather|lora|baskerville|caslon|bodoni|new york|didot|spectral|crimson|cormorant|bitter|arvo/.test(f)) return 'serif';
  return 'sans';
}
function systemKind(fam) { for (const k of Object.keys(SYSTEM_FONTS)) if (SYSTEM_FONTS[k].test(fam.trim())) return k; return null; }
const STYLE_WEIGHTS = [['extralight', 200], ['ultralight', 200], ['semibold', 600], ['demibold', 600], ['extrabold', 800], ['ultrabold', 800], ['thin', 100], ['hairline', 100],
  ['light', 300], ['regular', 400], ['book', 400], ['normal', 400], ['medium', 500], ['bold', 700], ['heavy', 800], ['black', 900]];
function styleWeight(style) {
  const s = String(style || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const m = /([1-9]00)/.exec(s); if (m) return +m[1];
  for (const p of STYLE_WEIGHTS) if (s.indexOf(p[0]) > -1) return p[1];
  return 400;
}
function collectFonts(node, ctx) {
  const add = (fn, w) => {
    if (!fn || isMixed(fn) || !fn.family) return;
    const it = /italic|oblique/i.test(fn.style) ? 1 : 0;
    const weight = typeof w === 'number' ? w : styleWeight(fn.style);
    (ctx.fonts[fn.family] = ctx.fonts[fn.family] || {})[it + ',' + weight] = fn.style;
  };
  try { const segs = node.getStyledTextSegments(['fontName', 'fontWeight']); if (segs && segs.length) { segs.forEach(s => add(s.fontName, s.fontWeight)); return; } } catch (e) { /* ignore */ }
  try { add(node.fontName, isMixed(node.fontWeight) ? undefined : node.fontWeight); } catch (e) { /* ignore */ }
}
const sortKeys = keys => keys.slice().sort((a, b) => { const x = a.split(',').map(Number), y = b.split(',').map(Number); return x[0] - y[0] || x[1] - y[1]; });
/**
 * Is `fam` on Google Fonts, and which of the used weights/styles exist there?
 * Answered from the bundled catalog (GF_DATA, below), so the plugin never sends
 * font names over the network to find out. Private/proprietary family names
 * therefore never leave Figma; only public Google families are ever linked.
 */
function googleCheck(fam, keys) {
  const g = gfLookup(fam);
  if (!g) return { google: false, ok: [] };
  const hasItalic = (g.mask >> 9) > 0;
  const has = k => {
    const p = k.split(',').map(Number), it = p[0] === 1, w = p[1];
    if (it && !hasItalic) return false;
    if (g.min && w >= g.min && w <= g.max) return true; // variable font: any weight in range
    const i = w / 100 - 1;
    return Number.isInteger(i) && i >= 0 && i < 9 && ((g.mask >> (i + (it ? 9 : 0))) & 1) === 1;
  };
  let ok = keys.filter(has);
  if (!ok.length) {
    // none of the used styles exist: link the closest upright weight instead of nothing
    const want = +(keys[0] || '0,400').split(',')[1];
    let best = 400, bd = 1e9;
    for (let i = 0; i < 9; i++) if ((g.mask >> i) & 1) { const w = (i + 1) * 100, dd = Math.abs(w - want); if (dd < bd) { bd = dd; best = w; } }
    ok = ['0,' + best];
  }
  return { google: true, ok: sortKeys(ok), family: g.family };
}
function googleHref(list) {
  return 'https://fonts.googleapis.com/css2?' + list.map(g => {
    const ital = g.keys.some(k => k[0] === '1');
    return 'family=' + encodeURIComponent(g.family).replace(/%20/g, '+') + ':' + (ital ? 'ital,wght@' + g.keys.join(';') : 'wght@' + g.keys.map(k => k.split(',')[1]).join(';'));
  }).join('&') + '&display=swap';
}
/* Google Fonts catalog (fonts.google.com/metadata/fonts, 1950 families).
   Record: family|category(s sans, r serif, m mono, d display, h handwriting)|weights|wghtMin-wghtMax
   weights = base-36 bitmask: bits 0-8 = 100..900 upright, bits 9-17 = 100..900 italic. */
const GF_DATA = 'ABeeZee|s|360;ADLaM Display|d|8;AR One Sans|s|3c|400-700;Abel|s|8;Abhaya Libre|r|6w;Aboreto|d|8;Abril Fatface|d|8;Abyssinica SIL|r|8;Aclonica|s|8;Acme|s|8;Actor|s|8;Adamina|r|8;Advent Pro|s|5m9r|100-900;Afacad|s|1bi0|400-700;Afacad Flux|s|e7|100-1000;Agbalumo|d|8;Agdasima|s|20;Agu Display|d|8;Aguafina Script|h|8;Akatab|s|e0;Akaya Kanadaka|d|8;Akaya Telivigala|d|8;Akronim|d|8;Akshar|s|3g|300-700;Akt|s|e7|100-900;Aladin|d|8;Alan Sans|s|e4|300-900;Alata|s|8;Alatsi|s|8;Albert Sans|s|5m9r|100-900;Aldrich|s|8;Alef|s|20;Alegreya|r|5ji0|400-900;Alegreya SC|r|56u0;Alegreya Sans|s|58t9;Alegreya Sans SC|s|58t9;Aleo|r|5m9r|100-900;Alex Brush|h|8;Alexandria|s|e7|100-900;Alfa Slab One|d|8;Alice|r|8;Alien Block|d|8;Alike|r|8;Alike Angular|r|8;Alkalami|r|8;Alkatra|d|3c|400-700;Allan|d|20;Allerta|s|8;Allerta Stencil|s|8;Allison|h|8;Allkin|d|8;Allura|h|8;Almarai|s|5o;Almendra|r|si0;Almendra Display|d|8;Almendra SC|r|8;Alumni Sans|s|5m9r|100-900;Alumni Sans Collegiate One|s|360;Alumni Sans Inline One|d|360;Alumni Sans Pinstripe|s|360;Alumni Sans SC|s|5m9r|100-900;Alyamama|r|e4|300-900;Amarante|d|8;Amaranth|s|si0;Amarna|s|1e9r|100-700;Amatic SC|h|20;Amethysta|r|8;Amiko|s|2w;Amiri|r|si0;Amiri Quran|r|8;Amita|h|20;Anaheim|s|6w|400-800;Ancizar Sans|s|5m9r|100-1000;Ancizar Serif|r|5l30|300-900;Andada Pro|r|2q60|400-840;Andika|s|si0;Anek Bangla|s|73|100-800;Anek Devanagari|s|73|100-800;Anek Gujarati|s|73|100-800;Anek Gurmukhi|s|73|100-800;Anek Kannada|s|73|100-800;Anek Latin|s|73|100-800;Anek Malayalam|s|73|100-800;Anek Odia|s|73|100-800;Anek Tamil|s|73|100-800;Anek Telugu|s|73|100-800;Angkor|d|8;Annapurna SIL|r|20;Annie Use Your Telescope|h|8;Anonymous Pro|m|si0;Anta|s|8;Antic|s|8;Antic Didone|r|8;Antic Slab|r|8;Anton|s|8;Anton SC|s|8;Antonio|s|3j|100-700;Anuphan|s|3j|100-700;Anybody|d|5m9r|100-900;Aoboshi One|r|8;Arapey|r|360;Arbutus|r|8;Arbutus Slab|r|8;Architects Daughter|h|8;Archivo|s|5m9r|100-900;Archivo Black|s|8;Archivo Narrow|s|1bi0|400-700;Are You Serious|h|8;Aref Ruqaa|r|20;Aref Ruqaa Ink|r|20;Arima|d|3j|100-700;Arimo|s|1bi0|400-700;Arizonia|h|8;Armata|s|8;Arsenal|s|si0;Arsenal SC|s|si0;Artifika|r|8;Arvo|r|si0;Arya|s|20;Asap|s|5m9r|100-900;Asap Condensed|s|5lvi;Asap Sharp|s|5m9r|100-900;Asar|r|8;Asimovian|s|8;Asset|d|8;Assistant|s|72|200-800;Asta Sans|s|70|300-800;Astloch|d|20;Asul|r|20;Athiti|s|3i;Atkinson Hyperlegible|s|si0;Atkinson Hyperlegible Mono|s|2sji|200-800;Atkinson Hyperlegible Next|s|2sji|200-800;Atma|d|3g;Atomic Age|d|8;Aubrey|d|8;Audiowide|d|8;Autour One|d|8;Average|r|8;Average Sans|s|8;Averia Gruesa Libre|d|8;Averia Libre|d|u30;Averia Sans Libre|d|u30;Averia Serif Libre|d|u30;Azeret Mono|m|5m9r|100-900;B612|s|si0;B612 Mono|m|si0;BBH Bartle|s|8;BBH Bogle|s|8;BBH Hegarty|s|8;BIZ UDGothic|s|20;BIZ UDMincho|r|20;BIZ UDPGothic|s|20;BIZ UDPMincho|r|20;BJCree|r|3c;Babylonica|h|8;Bacasime Antique|r|8;Bad Script|h|8;Badeen Display|d|8;Bagel Fat One|d|8;Bahiana|d|8;Bahianita|d|8;Bai Jamjuree|s|1dvi;Bakbak One|d|8;Ballet|h|8;Baloo 2|d|6w|400-800;Baloo Bhai 2|d|6w|400-800;Baloo Bhaijaan 2|d|6w|400-800;Baloo Bhaina 2|d|6w|400-800;Baloo Chettan 2|d|6w|400-800;Baloo Da 2|d|6w|400-800;Baloo Paaji 2|d|6w|400-800;Baloo Tamma 2|d|6w|400-800;Baloo Tammudu 2|d|6w|400-800;Baloo Thambi 2|d|6w|400-800;Balsamiq Sans|d|si0;Balthazar|r|8;Bangers|d|8;Barlow|s|5m9r;Barlow Condensed|s|5m9r;Barlow Semi Condensed|s|5m9r;Barriecito|d|8;Barrio|d|8;Basic|s|8;Baskervville|r|1bi0|400-700;Baskervville SC|r|3c|400-700;Battambang|d|99;Baumans|d|8;Bayon|s|8;Be Vietnam Pro|s|5m9r;Beau Rivage|h|8;Bebas Neue|s|8;Beiruti|s|e6|200-900;Belanosima|s|2w;Belgrano|r|8;Bellefair|r|8;Belleza|s|8;Bellota|d|u30;Bellota Text|d|u30;BenchNine|s|24;Benne|r|8;Bentham|r|8;Berkshire Swash|h|8;Besley|r|5ji0|400-900;Betania Patmos|h|8;Betania Patmos GDL|h|8;Betania Patmos In|h|8;Betania Patmos In GDL|h|8;Beth Ellen|h|8;Bevan|r|360;BhuTuka Expanded One|r|8;Big Shoulders|d|e7|100-900;Big Shoulders Inline|d|e7|100-900;Big Shoulders Stencil|d|e7|100-900;Bigelow Rules|d|8;Bigshot One|d|8;Bilbo|h|8;Bilbo Swash Caps|h|8;BioRhyme|r|72|200-800;BioRhyme Expanded|r|5q;Birthstone|h|8;Birthstone Bounce|h|o;Biryani|s|dq;Bitcount|d|e7|100-900;Bitcount Grid Double|d|e7|100-900;Bitcount Grid Double Ink|d|e7|100-900;Bitcount Grid Single|d|e7|100-900;Bitcount Grid Single Ink|d|e7|100-900;Bitcount Ink|d|e7|100-900;Bitcount Prop Double|d|e7|100-900;Bitcount Prop Double Ink|d|e7|100-900;Bitcount Prop Single|d|e7|100-900;Bitcount Prop Single Ink|d|e7|100-900;Bitcount Single|d|e7|100-900;Bitcount Single Ink|d|e7|100-900;Bitter|r|5m9r|100-900;Black And White Picture|d|8;Black Han Sans|s|8;Black Ops One|d|8;Blaka|d|8;Blaka Hollow|d|8;Blaka Ink|d|8;Blinker|s|dr;Bodoni Moda|r|5ji0|400-900;Bodoni Moda SC|r|5ji0|400-900;Bokor|d|8;Boldonse|d|8;Bona Nova|r|37s;Bona Nova SC|r|37s;Bonbon|h|8;Bonheur Royale|h|8;Boogaloo|d|8;Borel|h|8;Bowlby One|d|8;Bowlby One SC|d|8;Bpmf Huninn|s|8;Bpmf Iansui|h|8;Bpmf Zihi Kai Std|s|8;Braah One|s|8;Brawler|r|20;Bree Serif|r|8;Bricolage Grotesque|s|72|200-800;Bruno Ace|d|8;Bruno Ace SC|d|8;Brygada 1918|r|1bi0|400-700;Bubblegum Sans|d|8;Bubbler One|s|8;Buda|d|4;Buenard|r|3c|400-700;Bungee|d|8;Bungee Hairline|d|8;Bungee Inline|d|8;Bungee Outline|d|8;Bungee Shade|d|8;Bungee Spice|d|8;Bungee Tint|d|8;Butcherman|d|8;Butterfly Kids|h|8;Bytesized|s|8;Caacupe One|d|8;Cabin|s|1bi0|400-700;Cabin Condensed|s|3c;Cabin Sketch|d|20;Cactus Classical Serif|r|8;Caesar Dressing|d|8;Cagliostro|s|8;Cairo|s|e6|200-1000;Cairo Play|s|e6|200-1000;Cal Sans|s|8;Caladea|r|si0;Calistoga|d|8;Calligraffitti|h|8;Cambay|s|si0;Cambo|r|8;Candal|s|8;Cantarell|s|si0;Cantata One|r|8;Cantora One|s|8;Caprasimo|d|8;Capriola|s|8;Caramel|h|8;Carattere|h|8;Cardo|r|37s;Carlito|s|si0;Carme|s|8;Carrois Gothic|s|8;Carrois Gothic SC|s|8;Carter One|d|8;Cascadia Code|s|1dvi|200-700;Cascadia Mono|s|1dvi|200-700;Castoro|r|360;Castoro Titling|d|8;Catamaran|s|e7|100-900;Caudex|r|si0;Cause|h|e7|100-900;Caveat|h|3c|400-700;Caveat Brush|h|8;Cedarville Cursive|h|8;Ceviche One|d|8;Chakra Petch|s|1d30;Changa|s|72|200-800;Changa One|d|360;Chango|d|8;Charis SIL|r|si0;Charm|h|20;Charmonman|h|20;Chathura|s|5p;Chau Philomene One|s|360;Chela One|d|8;Chelsea Market|d|8;Chenla|d|8;Cherish|h|8;Cherry Bomb One|d|8;Cherry Cream Soda|d|8;Cherry Swash|d|20;Chewy|d|8;Chicle|d|8;Chilanka|h|8;Chiron GoRound TC|s|e6|200-900;Chiron Hei HK|s|5lvi|200-900;Chiron Sung HK|r|5lvi|200-900;Chivo|s|5m9r|100-900;Chivo Mono|m|5m9r|100-900;Chocolate Classical Sans|s|8;Chokokutai|d|8;Chonburi|d|8;Cinzel|r|e0|400-900;Cinzel Decorative|d|94;Clarity City|s|5m9r|100-900;Clicker Script|h|8;Climate Crisis|d|8;Coda|d|3s;Codystar|d|c;Coiny|d|8;Combo|d|8;Comfortaa|d|3g|300-700;Comforter|h|8;Comforter Brush|h|8;Comic Neue|h|u30;Comic Relief|d|20;Coming Soon|h|8;Comme|s|e7|100-900;Commissioner|s|e7|100-900;Concert One|d|8;Condiment|h|8;Content|d|20;Contrail One|d|8;Convergence|s|8;Cookie|h|8;Copse|r|8;Coral Pixels|d|8;Corben|d|20;Corinthia|h|20;Cormorant|r|1d30|300-700;Cormorant Garamond|r|1d30|300-700;Cormorant Infant|r|1d30|300-700;Cormorant SC|r|3g;Cormorant Unicase|r|3g;Cormorant Upright|r|3g;Cossette Texte|s|20;Cossette Titre|s|20;Courgette|h|8;Courier Prime|m|si0;Cousine|m|si0;Coustard|r|7c;Covered By Your Grace|h|8;Crafty Girls|h|8;Creepster|d|8;Crete Round|r|360;Crimson Pro|r|5lvi|200-900;Crimson Text|r|1560;Croissant One|d|8;Crushed|d|8;Cuprum|s|1bi0|400-700;Cute Font|d|8;Cutive|r|8;Cutive Mono|m|8;DM Mono|m|b30;DM Sans|s|5m9r|100-1000;DM Serif Display|r|360;DM Serif Text|r|360;Dai Banna SIL|r|1d30;Damion|h|8;Dancing Script|h|3c|400-700;Danfo|r|8;Dangrek|d|8;Darker Grotesque|s|e4|300-900;Darumadrop One|d|8;Datatype|m|e7|100-900;David Libre|r|2g;Dawning of a New Day|h|8;Days One|s|8;Dekko|h|8;Dela Gothic One|d|8;Delicious Handrawn|h|8;Delius|h|8;Delius Swash Caps|h|8;Delius Unicase|h|20;Della Respira|r|8;Denk One|s|8;Devonshire|h|8;Dhurjati|s|8;Didact Gothic|s|8;Diphylleia|r|8;Diplomata|d|8;Diplomata SC|d|8;Do Hyeon|s|8;Dokdo|d|8;Domine|r|3c|400-700;Donegal One|r|8;Dongle|s|24;Doppio One|s|8;Dorsa|s|8;Dosis|s|72|200-800;DotGothic16|s|8;Doto|s|e7|100-900;Dr Sugiyama|h|8;Duru Sans|s|8;DynaPuff|d|3c|400-700;Dynalight|d|8;EB Garamond|r|2q60|400-800;Eagle Lake|h|8;East Sea Dokdo|h|8;Eater|d|8;Economica|s|si0;Eczar|r|6w|400-800;Edu AU VIC WA NT Arrows|h|3c|400-700;Edu AU VIC WA NT Dots|h|3c|400-700;Edu AU VIC WA NT Guides|h|3c|400-700;Edu AU VIC WA NT Hand|h|3c|400-700;Edu AU VIC WA NT Pre|h|3c|400-700;Edu NSW ACT Cursive|h|3c|400-700;Edu NSW ACT Foundation|h|3c|400-700;Edu NSW ACT Hand Pre|h|3c|400-700;Edu QLD Beginner|h|3c|400-700;Edu QLD Hand|h|3c|400-700;Edu SA Beginner|h|3c|400-700;Edu SA Hand|h|3c|400-700;Edu TAS Beginner|h|3c|400-700;Edu VIC WA NT Beginner|h|3c|400-700;Edu VIC WA NT Hand|h|3c|400-700;Edu VIC WA NT Hand Pre|h|3c|400-700;El Messiri|s|3c|400-700;Electrolize|s|8;Elms Sans|s|5m9r|100-900;Elsie|d|7c;Elsie Swash Caps|d|7c;Emblema One|d|8;Emilys Candy|d|8;Encode Sans|s|e7|100-900;Encode Sans Condensed|s|e7;Encode Sans Expanded|s|e7;Encode Sans SC|s|e7|100-900;Encode Sans Semi Condensed|s|e7;Encode Sans Semi Expanded|s|e7;Engagement|h|8;Englebert|s|8;Enriqueta|r|3c;Ephesis|h|8;Epilogue|s|5m9r|100-900;Epunda Sans|s|5l30|300-900;Epunda Slab|r|5l30|300-900;Erica One|d|8;Esteban|r|8;Estedad|s|e7|100-900;Estonia|h|8;Euphoria Script|h|8;Ewert|d|8;Exile|d|8;Exo|s|5m9r|100-900;Exo 2|s|5m9r|100-900;Expletus Sans|d|1bi0|400-700;Explora|h|8;Faculty Glyphic|s|8;Fahkwang|s|1dvi;Familjen Grotesk|s|1bi0|400-700;Fanwood Text|r|360;Farro|s|2k;Farsan|d|8;Fascinate|d|8;Fascinate Inline|d|8;Faster One|d|8;Fasthand|d|8;Fauna One|r|8;Faustina|r|2rr0|300-800;Federant|d|8;Federo|s|8;Felipa|h|8;Fenix|r|8;Festive|h|8;Figtree|s|5l30|300-900;Finger Paint|d|8;Finlandica Headline|s|5m9r|100-900;Finlandica Text|s|5m9r|100-900;Fira Code|m|3g|300-700;Fira Mono|m|2g;Fira Sans|s|5m9r;Fira Sans Condensed|s|5m9r;Fira Sans Extra Condensed|s|5m9r;Fjalla One|s|8;Fjord One|r|8;Flamenco|d|c;Flavors|d|8;Fleur De Leah|h|8;Flow Block|d|8;Flow Circular|d|8;Flow Rounded|d|8;Foldit|d|e7|100-900;Fondamento|h|360;Fontdiner Swanky|d|8;Forum|d|8;Fragment Mono|m|360;Francois One|s|8;Frank Ruhl Libre|r|e4|300-900;Fraunces|r|5m9r|100-900;Freckle Face|d|8;Fredericka the Great|d|8;Fredoka|s|3g|300-700;Freehand|d|8;Freeman|d|8;Fresca|s|8;Frijole|d|8;Fruktur|d|360;Fugaz One|d|8;Fuggles|h|8;Funnel Display|d|70|300-800;Funnel Sans|s|2rr0|300-800;Fustat|s|72|200-800;Fuzzy Bubbles|h|20;GFS Didot|r|8;GFS Neohellenic|s|si0;Ga Maamli|d|8;Gabarito|d|e0|400-900;Gabriela|r|8;Gaegu|h|24;Gafata|s|8;Gajraj One|d|8;Galada|d|8;Galdeano|s|8;Galindo|d|8;Gamja Flower|h|8;Gantari|s|5m9r|100-900;Gasoek One|s|8;Gayathri|s|21;Geist|s|5m9r|100-900;Geist Mono|m|5m9r|100-900;Geist Pixel|d|8;Gelasio|r|1bi0|400-700;Gemunu Libre|s|72|200-800;Genos|s|5m9r|100-900;Gentium Book Plus|r|si0;Gentium Plus|r|si0;Geo|s|360;Geologica|s|e7|100-900;Geom|s|5l30|300-900;Geomini|s|72|200-800;Georama|s|5m9r|100-900;Geostar|d|8;Geostar Fill|d|8;Germania One|d|8;Gideon Roman|d|8;Gidole|s|8;Gidugu|s|8;Gilda Display|r|8;Girassol|d|8;Give You Glory|h|8;Glass Antiqua|d|8;Glegoo|r|20;Gloock|r|8;Gloria Hallelujah|h|8;Glory|s|2sxr|100-800;Gluten|d|e7|100-900;Goblin One|d|8;Gochi Hand|h|8;Goldman|d|20;Golos Text|s|e0|400-900;Google Sans|s|1bi0|400-700;Google Sans Code|m|2rr0|300-800;Google Sans Flex|s|e7|1-1000;Gorditas|d|20;Gothic A1|s|e7;Gotu|s|8;Goudy Bookletter 1911|r|8;Gowun Batang|r|20;Gowun Dodum|s|8;Graduate|r|8;Grand Hotel|h|8;Grandiflora One|r|8;Grandstander|d|5m9r|100-900;Grape Nuts|h|8;Gravitas One|d|8;Great Vibes|h|8;Grechen Fuemen|h|8;Grenze|r|5m9r|100-900;Grenze Gotisch|d|e7|100-900;Grey Qo|h|8;Griffy|d|8;Gruppo|s|8;Gudea|s|37s;Gugi|d|8;Gulzar|r|8;Gupter|r|2g;Gurajada|s|8;Gveret Levin|h|8;Gwendolyn|h|20;Habibi|r|8;Hachi Maru Pop|h|8;Hahmlet|r|e7|100-900;Halant|r|3g;Hammersmith One|s|8;Hanalei|d|8;Hanalei Fill|d|8;Handjet|d|e7|100-900;Handlee|h|8;Hanken Grotesk|s|5m9r|100-900;Hanuman|r|e7|100-900;Happy Monkey|d|8;Harmattan|s|3c;Headland One|r|8;Hedvig Letters Sans|s|8;Hedvig Letters Serif|r|8;Heebo|s|e7|100-900;Henny Penny|d|8;Hepta Slab|r|e7|1-900;Herr Von Muellerhoff|h|8;Hi Melody|h|8;Hibur Mono|m|8;Hina Mincho|r|8;Hind|s|3g;Hind Guntur|s|3g;Hind Madurai|s|3g;Hind Mysuru|s|3g;Hind Siliguri|s|3g;Hind Vadodara|s|3g;Holtwood One SC|r|8;Homemade Apple|h|8;Homenaje|s|8;Honk|d|8;Host Grotesk|s|2rr0|300-800;Hubballi|s|8;Hubot Sans|s|5lvi|200-900;Huninn|s|8;Hurricane|h|8;IBM Plex Mono|m|1e9r;IBM Plex Sans|s|1e9r|100-700;IBM Plex Sans Arabic|s|3j;IBM Plex Sans Condensed|s|1e9r;IBM Plex Sans Devanagari|s|3j;IBM Plex Sans Hebrew|s|3j;IBM Plex Sans JP|s|3j;IBM Plex Sans KR|s|3j;IBM Plex Sans Thai|s|3j;IBM Plex Sans Thai Looped|s|3j;IBM Plex Serif|r|1e9r;IM Fell DW Pica|r|360;IM Fell DW Pica SC|r|8;IM Fell Double Pica|r|360;IM Fell Double Pica SC|r|8;IM Fell English|r|360;IM Fell English SC|r|8;IM Fell French Canon|r|360;IM Fell French Canon SC|r|8;IM Fell Great Primer|r|360;IM Fell Great Primer SC|r|8;Iansui|h|8;Ibarra Real Nova|r|1bi0|400-700;Iceberg|d|8;Iceland|d|8;Idiqlat|r|e;Imbue|r|e7|100-900;Imperial Script|h|8;Imprima|s|8;Inclusive Sans|s|1d30|300-700;Inconsolata|m|e6|200-900;Inder|s|8;Indie Flower|h|8;Ingrid Darling|h|8;Inika|r|20;Inknut Antiqua|r|e4;Inria Sans|s|u30;Inria Serif|r|u30;Inspiration|h|8;Instrument Sans|s|1bi0|400-700;Instrument Serif|r|360;Intel One Mono|m|1d30|300-700;Inter|s|5m9r|100-900;Inter Tight|s|5m9r|100-900;Iosevka Charon|m|10f0;Iosevka Charon Mono|m|10f0;Irish Grover|d|8;Island Moments|h|8;Isometra|r|8;Istok Web|s|si0;Italiana|s|8;Italianno|h|8;Itim|h|8;Jacquard 12|d|8;Jacquard 12 Charted|d|8;Jacquard 24|d|8;Jacquard 24 Charted|d|8;Jacquarda Bastarda 9|d|8;Jacquarda Bastarda 9 Charted|d|8;Jacques Francois|r|8;Jacques Francois Shadow|d|8;Jaini|d|8;Jaini Purva|d|8;Jaldi|s|20;Jaro|s|8;Jersey 10|d|8;Jersey 10 Charted|d|8;Jersey 15|d|8;Jersey 15 Charted|d|8;Jersey 20|d|8;Jersey 20 Charted|d|8;Jersey 25|d|8;Jersey 25 Charted|d|8;JetBrains Mono|m|2sxr|100-800;Jim Nightshade|h|8;Joan|r|8;Jockey One|s|8;Jolly Lodger|d|8;Jomhuria|d|8;Jomolhari|r|8;Josefin Sans|s|1e9r|100-700;Josefin Slab|r|1e9r|100-700;Jost|s|5m9r|100-900;Joti One|d|8;Jua|s|8;Judson|r|37s;Julee|h|8;Julius Sans One|s|8;Junge|r|8;Jura|s|3g|300-700;Just Another Hand|h|8;Just Me Again Down Here|h|8;K2D|s|2sxr;Kablammo|d|8;Kadwa|r|20;Kaisei Decol|r|2g;Kaisei HarunoUmi|r|2g;Kaisei Opti|r|2g;Kaisei Tokumin|r|60;Kalam|h|24;Kalnia|r|3j|100-700;Kalnia Glaze|d|3j|100-700;Kameron|r|3c|400-700;Kanchenjunga|s|3c;Kanit|s|5m9r;Kantumruy Pro|s|1e9r|100-700;Kapakana|h|c|300-400;Karantina|d|24;Karla|s|2sji|200-800;Karla Tamil Inclined|s|20;Karla Tamil Upright|s|20;Karma|r|3g;Katibeh|d|8;Kaushan Script|h|8;Kavivanar|h|8;Kavoon|d|8;Kay Pho Du|r|3c;Kdam Thmor Pro|s|8;Keania One|d|8;Kedebideri|s|e0;Kelly Slab|d|8;Kenia|d|8;Khand|s|3g;Khmer|s|8;Khula|s|6k;Kings|h|8;Kirang Haerang|d|8;Kite One|s|8;Kiwi Maru|r|s;Klee One|h|14;Knewave|d|8;KoHo|s|1dvi;Kodchasan|s|1dvi;Kode Mono|m|3c|400-700;Koh Santepheap|r|99;Kolker Brush|h|8;Konkhmer Sleokchher|d|8;Kosugi|s|8;Kosugi Maru|s|8;Kotta One|r|8;Koulen|d|8;Kranky|d|8;Kreon|r|3g|300-700;Kripa|s|e7|100-900;Kristi|h|8;Krona One|s|8;Krub|s|1dvi;Kufam|s|5ji0|400-900;Kulim Park|s|17ji;Kumar One|d|8;Kumar One Outline|d|8;Kumbh Sans|s|e7|100-900;Kurale|r|8;LINE Seed JP|s|5l;LXGW Marker Gothic|s|8;LXGW WenKai Mono TC|m|24;LXGW WenKai TC|h|24;La Belle Aurore|h|8;Labrada|r|5m9r|100-900;Lacquer|d|8;Laila|r|3g;Lakki Reddy|h|8;Lalezar|s|8;Lancelot|d|8;Langar|d|8;Lateef|r|72;Lato|s|3nt9;Lavishly Yours|h|8;League Gothic|s|8;League Script|h|8;League Spartan|s|e7|100-900;Leckerli One|h|8;Ledger|r|8;Lekton|m|37s;Lemon|d|8;Lemonada|d|3g|300-700;Lexend|s|e7|100-900;Lexend Deca|s|e7|100-900;Lexend Exa|s|e7|100-900;Lexend Giga|s|e7|100-900;Lexend Mega|s|e7|100-900;Lexend Peta|s|e7|100-900;Lexend Tera|s|e7|100-900;Lexend Zetta|s|e7|100-900;Libertinus Keyboard|d|8;Libertinus Math|d|8;Libertinus Mono|m|8;Libertinus Sans|s|37s;Libertinus Serif|r|1560;Libertinus Serif Display|d|8;Libre Barcode 128|d|8;Libre Barcode 128 Text|d|8;Libre Barcode 39|d|8;Libre Barcode 39 Extended|d|8;Libre Barcode 39 Extended Text|d|8;Libre Barcode 39 Text|d|8;Libre Barcode EAN13 Text|d|8;Libre Baskerville|r|1bi0|400-700;Libre Bodoni|r|1bi0|400-700;Libre Caslon Condensed|r|1bi0|400-700;Libre Caslon Display|r|8;Libre Caslon Text|r|37s;Libre Franklin|s|5m9r|100-900;Licorice|h|8;Life Savers|d|5k;Lilex|m|1e9r|100-700;Lilita One|d|8;Lily Script One|d|8;Limelight|d|8;Linden Hill|r|360;Linefont|d|e7|4-1000;Lisu Bosa|r|5lvi;Liter|s|8;Literata|r|5lvi|200-900;Liu Jian Mao Cao|h|8;Livvic|s|47lr;Lobster|d|8;Lobster Two|d|si0;Londrina Outline|d|8;Londrina Shadow|d|8;Londrina Sketch|d|8;Londrina Solid|d|7h;Long Cang|h|8;Lora|r|1bi0|400-700;Love Light|h|8;Love Ya Like A Sister|d|8;Loved by the King|h|8;Lovers Quarrel|h|8;Luckiest Guy|d|8;Lugrasimo|h|8;Lumanosimo|h|8;Lunasima|s|20;Lusitana|r|20;Lustria|r|8;Luxurious Roman|d|8;Luxurious Script|h|8;M PLUS 1|s|e7|100-900;M PLUS 1 Code|m|3j|100-700;M PLUS 1p|s|d9;M PLUS 2|s|e7|100-900;M PLUS Code Latin|s|3j|100-700;M PLUS Rounded 1c|s|d9;M PLUS U|s|e7|100-900;Ma Shan Zheng|h|8;Macondo|d|8;Macondo Swash Caps|d|8;Mada|s|e6|200-900;Madimi One|s|8;Magra|s|20;Maiden Orange|r|8;Maitree|r|3i;Major Mono Display|m|8;Mako|s|8;Mali|h|1dvi;Mallanna|s|8;Maname|r|8;Mandali|s|8;Manjari|s|21;Manrope|s|72|200-800;Mansalva|h|8;Manuale|r|2rr0|300-800;Manufacturing Consent|d|8;Marcellus|r|8;Marcellus SC|r|8;Marck Script|h|8;Margarine|d|8;Marhey|d|3g|300-700;Markazi Text|r|3c|400-700;Marko One|r|8;Marmelad|s|8;Martel|r|dq;Martel Sans|s|dq;Martian Mono|m|73|100-800;Marvel|s|si0;Matangi|s|e4|300-900;Mate|r|360;Mate SC|r|8;Matemasie|s|8;Maven Pro|s|e0|400-900;McLaren|d|8;Mea Culpa|h|8;Meddon|h|8;MedievalSharp|d|8;Medula One|d|8;Meera Inimai|s|8;Megrim|d|8;Meie Script|h|8;Menbere|s|3j|100-700;Meow Script|h|8;Merienda|h|e4|300-900;Merriweather|r|5l30|300-900;Merriweather Sans|s|2rr0|300-800;Metal|d|8;Metal Mania|d|8;Metamorphous|d|8;Metrophobic|s|8;Michroma|s|8;Micro 5|d|8;Micro 5 Charted|d|8;Milonga|d|8;Miltonian|d|8;Miltonian Tattoo|d|8;Mina|s|20;Mingzat|s|8;Miniver|d|8;Miranda Sans|s|1bi0|400-700;Miriam Libre|s|3c|400-700;Mirza|r|3c;Miss Fajardose|h|8;Mitr|s|3i;Mochiy Pop One|s|8;Mochiy Pop P One|s|8;Modak|d|8;Modern Antiqua|d|8;Moderustic|s|70|300-800;Mogra|d|8;Mohave|s|1d30|300-700;Moirai One|d|8;Molengo|s|8;Molle|h|35s;Momo Signature|s|8;Momo Trust Display|s|8;Momo Trust Sans|s|72|200-800;Mona Sans|s|5lvi|200-900;Monda|s|3c|400-700;Monofett|m|8;Monomakh|d|8;Monomaniac One|s|8;Monoton|d|8;Monsieur La Doulaise|h|8;Montaga|r|8;Montagu Slab|r|3j|100-700;MonteCarlo|h|8;Montenegrin Gothic One|r|8;Montez|h|8;Montserrat|s|5m9r|100-900;Montserrat Alternates|s|5m9r;Montserrat Underline|s|5m9r|100-900;Moo Lah Lah|d|8;Mooli|s|8;Moon Dance|h|8;Moul|d|8;Moulpali|s|8;Mountains of Christmas|d|20;Mouse Memoirs|s|8;Mozilla Headline|s|3i|200-700;Mozilla Text|s|3i|200-700;Mr Bedfort|h|8;Mr Dafoe|h|8;Mr De Haviland|h|8;Mrs Saint Delafield|h|8;Mrs Sheppards|h|8;Ms Madi|h|8;Mukta|s|72;Mukta Mahee|s|72;Mukta Malar|s|72;Mukta Vaani|s|72;Mulish|s|5lvi|200-1000;Murecho|s|e7|100-900;MuseoModerno|d|5m9r|100-900;My Soul|h|8;Mynerve|h|8;Mystery Quest|d|8;NTR|s|8;Nabla|d|8;Namdhinggo|r|6w;Nanum Brush Script|h|8;Nanum Gothic|s|5k;Nanum Gothic Coding|h|20;Nanum Myeongjo|r|5k;Nanum Pen Script|h|8;Narnoor|s|6w;Nata Sans|s|e7|100-900;National Park|s|72|200-800;Neonderthaw|h|8;Nerko One|h|8;Neucha|h|8;Neuton|r|3bi;New Amsterdam|s|8;New Rocker|d|8;New Tegomin|r|8;News Cycle|s|20;Newsreader|r|2sji|200-800;Niconne|h|8;Niramit|s|1dvi;Nixie One|d|8;Nobile|s|yu0;Nokora|s|e7|100-900;Norican|h|8;Nosifer|d|8;Notable|s|8;Nothing You Could Do|h|8;Noticia Text|r|si0;Noto Color Emoji|s|8;Noto Emoji|s|3g|300-700;Noto Kufi Arabic|s|e7|100-900;Noto Music|s|8;Noto Naskh Arabic|r|3c|400-700;Noto Nastaliq Urdu|r|3c|400-700;Noto Rashi Hebrew|r|e7|100-900;Noto Sans|s|5m9r|100-900;Noto Sans Adlam|s|3c|400-700;Noto Sans Adlam Unjoined|s|3c|400-700;Noto Sans Anatolian Hieroglyphs|s|8;Noto Sans Arabic|s|e7|100-900;Noto Sans Armenian|s|e7|100-900;Noto Sans Avestan|s|8;Noto Sans Balinese|s|3c|400-700;Noto Sans Bamum|s|3c|400-700;Noto Sans Bassa Vah|s|3c|400-700;Noto Sans Batak|s|8;Noto Sans Bengali|s|e7|100-900;Noto Sans Bhaiksuki|s|8;Noto Sans Brahmi|s|8;Noto Sans Buginese|s|8;Noto Sans Buhid|s|8;Noto Sans Canadian Aboriginal|s|e7|100-900;Noto Sans Carian|s|8;Noto Sans Caucasian Albanian|s|8;Noto Sans Chakma|s|8;Noto Sans Cham|s|e7|100-900;Noto Sans Cherokee|s|e7|100-900;Noto Sans Chorasmian|s|8;Noto Sans Coptic|s|8;Noto Sans Cuneiform|s|8;Noto Sans Cypriot|s|8;Noto Sans Cypro Minoan|s|8;Noto Sans Deseret|s|8;Noto Sans Devanagari|s|e7|100-900;Noto Sans Display|s|5m9r|100-900;Noto Sans Duployan|s|20;Noto Sans Egyptian Hieroglyphs|s|8;Noto Sans Elbasan|s|8;Noto Sans Elymaic|s|8;Noto Sans Ethiopic|s|e7|100-900;Noto Sans Georgian|s|e7|100-900;Noto Sans Glagolitic|s|8;Noto Sans Gothic|s|8;Noto Sans Grantha|s|8;Noto Sans Gujarati|s|e7|100-900;Noto Sans Gunjala Gondi|s|3c|400-700;Noto Sans Gurmukhi|s|e7|100-900;Noto Sans HK|s|e7|100-900;Noto Sans Hanifi Rohingya|s|3c|400-700;Noto Sans Hanunoo|s|8;Noto Sans Hatran|s|8;Noto Sans Hebrew|s|e7|100-900;Noto Sans Imperial Aramaic|s|8;Noto Sans Indic Siyaq Numbers|s|8;Noto Sans Inscriptional Pahlavi|s|8;Noto Sans Inscriptional Parthian|s|8;Noto Sans JP|s|e7|100-900;Noto Sans Javanese|s|3c|400-700;Noto Sans KR|s|e7|100-900;Noto Sans Kaithi|s|8;Noto Sans Kannada|s|e7|100-900;Noto Sans Kawi|s|3c|400-700;Noto Sans Kayah Li|s|3c|400-700;Noto Sans Kharoshthi|s|8;Noto Sans Khmer|s|e7|100-900;Noto Sans Khojki|s|8;Noto Sans Khudawadi|s|8;Noto Sans Lao|s|e7|100-900;Noto Sans Lao Looped|s|e7|100-900;Noto Sans Lepcha|s|8;Noto Sans Limbu|s|8;Noto Sans Linear A|s|8;Noto Sans Linear B|s|8;Noto Sans Lisu|s|3c|400-700;Noto Sans Lycian|s|8;Noto Sans Lydian|s|8;Noto Sans Mahajani|s|8;Noto Sans Malayalam|s|e7|100-900;Noto Sans Mandaic|s|8;Noto Sans Manichaean|s|8;Noto Sans Marchen|s|8;Noto Sans Masaram Gondi|s|8;Noto Sans Math|s|8;Noto Sans Mayan Numerals|s|8;Noto Sans Medefaidrin|s|3c|400-700;Noto Sans Meetei Mayek|s|e7|100-900;Noto Sans Mende Kikakui|s|8;Noto Sans Meroitic|s|8;Noto Sans Miao|s|8;Noto Sans Modi|s|8;Noto Sans Mongolian|s|8;Noto Sans Mono|s|e7|100-900;Noto Sans Mro|s|8;Noto Sans Multani|s|8;Noto Sans Myanmar|s|e7|100-900;Noto Sans NKo|s|8;Noto Sans NKo Unjoined|s|3c|400-700;Noto Sans Nabataean|s|8;Noto Sans Nag Mundari|s|3c|400-700;Noto Sans Nandinagari|s|8;Noto Sans New Tai Lue|s|3c|400-700;Noto Sans Newa|s|8;Noto Sans Nushu|s|8;Noto Sans Ogham|s|8;Noto Sans Ol Chiki|s|3c|400-700;Noto Sans Old Hungarian|s|8;Noto Sans Old Italic|s|8;Noto Sans Old North Arabian|s|8;Noto Sans Old Permic|s|8;Noto Sans Old Persian|s|8;Noto Sans Old Sogdian|s|8;Noto Sans Old South Arabian|s|8;Noto Sans Old Turkic|s|8;Noto Sans Oriya|s|e7|100-900;Noto Sans Osage|s|8;Noto Sans Osmanya|s|8;Noto Sans Pahawh Hmong|s|8;Noto Sans Palmyrene|s|8;Noto Sans Pau Cin Hau|s|8;Noto Sans PhagsPa|s|8;Noto Sans Phoenician|s|8;Noto Sans Psalter Pahlavi|s|8;Noto Sans Rejang|s|8;Noto Sans Runic|s|8;Noto Sans SC|s|e7|100-900;Noto Sans Samaritan|s|8;Noto Sans Saurashtra|s|8;Noto Sans Sharada|s|8;Noto Sans Shavian|s|8;Noto Sans Siddham|s|8;Noto Sans SignWriting|s|8;Noto Sans Sinhala|s|e7|100-900;Noto Sans Sogdian|s|8;Noto Sans Sora Sompeng|s|3c|400-700;Noto Sans Soyombo|s|8;Noto Sans Sundanese|s|3c|400-700;Noto Sans Sunuwar|s|8;Noto Sans Syloti Nagri|s|8;Noto Sans Symbols|s|e7|100-900;Noto Sans Symbols 2|s|8;Noto Sans Syriac|s|e7|100-900;Noto Sans Syriac Eastern|s|e7|100-900;Noto Sans Syriac Western|s|e7|100-900;Noto Sans TC|s|e7|100-900;Noto Sans Tagalog|s|8;Noto Sans Tagbanwa|s|8;Noto Sans Tai Le|s|8;Noto Sans Tai Tham|s|3c|400-700;Noto Sans Tai Viet|s|8;Noto Sans Takri|s|8;Noto Sans Tamil|s|e7|100-900;Noto Sans Tamil Supplement|s|8;Noto Sans Tangsa|s|3c|400-700;Noto Sans Telugu|s|e7|100-900;Noto Sans Thaana|s|e7|100-900;Noto Sans Thai|s|e7|100-900;Noto Sans Thai Looped|s|e7|100-900;Noto Sans Tifinagh|s|8;Noto Sans Tirhuta|s|8;Noto Sans Ugaritic|s|8;Noto Sans Vai|s|8;Noto Sans Vithkuqi|s|3c|400-700;Noto Sans Wancho|s|8;Noto Sans Warang Citi|s|8;Noto Sans Yi|s|8;Noto Sans Zanabazar Square|s|8;Noto Serif|r|5m9r|100-900;Noto Serif Ahom|r|8;Noto Serif Armenian|r|e7|100-900;Noto Serif Balinese|r|8;Noto Serif Bengali|r|e7|100-900;Noto Serif Devanagari|r|e7|100-900;Noto Serif Display|r|5m9r|100-900;Noto Serif Dives Akuru|r|8;Noto Serif Dogra|r|8;Noto Serif Ethiopic|r|e7|100-900;Noto Serif Georgian|r|e7|100-900;Noto Serif Grantha|r|8;Noto Serif Gujarati|r|e7|100-900;Noto Serif Gurmukhi|r|e7|100-900;Noto Serif HK|r|e6|200-900;Noto Serif Hebrew|r|e7|100-900;Noto Serif Hentaigana|r|e6|200-900;Noto Serif JP|r|e6|200-900;Noto Serif KR|r|e6|200-900;Noto Serif Kannada|r|e7|100-900;Noto Serif Khitan Small Script|r|8;Noto Serif Khmer|r|e7|100-900;Noto Serif Khojki|r|3c|400-700;Noto Serif Lao|r|e7|100-900;Noto Serif Makasar|r|8;Noto Serif Malayalam|r|e7|100-900;Noto Serif Myanmar|r|e7;Noto Serif NP Hmong|r|3c|400-700;Noto Serif Old Uyghur|r|8;Noto Serif Oriya|r|3c|400-700;Noto Serif Ottoman Siyaq|r|8;Noto Serif SC|r|e6|200-900;Noto Serif Sinhala|r|e7|100-900;Noto Serif TC|r|e6|200-900;Noto Serif Tamil|r|5m9r|100-900;Noto Serif Tangut|r|8;Noto Serif Telugu|r|e7|100-900;Noto Serif Thai|r|e7|100-900;Noto Serif Tibetan|r|e7|100-900;Noto Serif Todhri|r|8;Noto Serif Toto|r|3c|400-700;Noto Serif Vithkuqi|r|3c|400-700;Noto Serif Yezidi|r|3c|400-700;Noto Traditional Nushu|s|3g|300-700;Noto Znamenny Musical Notation|s|8;Nova Cut|d|8;Nova Flat|d|8;Nova Mono|m|8;Nova Oval|d|8;Nova Round|d|8;Nova Script|d|8;Nova Slim|d|8;Nova Square|d|8;Numans|s|8;Nunito|s|5lvi|200-1000;Nunito Sans|s|5lvi|200-1000;Nuosu SIL|s|8;Odibee Sans|d|8;Odor Mean Chey|r|8;Offside|d|8;Oi|d|8;Ojuju|s|72|200-800;Old Standard TT|r|37s;Oldenburg|d|8;Ole|h|8;Oleo Script|d|20;Oleo Script Swash Caps|d|20;Onest|s|e7|100-900;Oooh Baby|h|8;Open Sans|s|2rr0|300-800;Oranienbaum|r|8;Orbit|s|8;Orbitron|s|e0|400-900;Oregano|d|360;Orelega One|d|8;Orienta|s|8;Original Surfer|d|8;Oswald|s|3i|200-700;Outfit|s|e7|100-900;Over the Rainbow|h|8;Overlock|d|3lu0;Overlock SC|d|8;Overpass|s|5m9r|100-900;Overpass Mono|m|3g|300-700;Ovo|r|8;Oxanium|d|72|200-800;Oxygen|s|24;Oxygen Mono|m|8;PT Mono|m|8;PT Sans|s|si0;PT Sans Caption|s|20;PT Sans Narrow|s|20;PT Serif|r|si0;PT Serif Caption|r|360;Pacifico|h|8;Padauk|s|20;Padyakke Expanded One|r|8;Palanquin|s|3j;Palanquin Dark|s|3c;Palette Mosaic|d|8;Pangolin|h|8;Paprika|d|8;Parastoo|r|3c|400-700;Parisienne|h|8;Parkinsans|s|70|300-800;Passero One|d|8;Passion One|d|94;Passions Conflict|h|8;Pathway Extreme|s|5m9r|100-900;Pathway Gothic One|s|8;Patrick Hand|h|8;Patrick Hand SC|h|8;Pattaya|s|8;Patua One|d|8;Pavanam|s|8;Paytone One|s|8;Peddana|r|8;Peralta|r|8;Permanent Marker|h|8;Petemoss|h|8;Petit Formal Script|h|8;Petrona|r|5m9r|100-900;Phetsarath|s|20;Philosopher|s|si0;Phudu|d|e4|300-900;Piazzolla|r|5m9r|100-900;Piedra|d|8;Pinyon Script|h|8;Pirata One|d|8;Pixelify Sans|d|3c|400-700;Plaster|d|8;Platypi|r|2rr0|300-800;Play|s|20;Playball|d|8;Playfair|r|5l30|300-900;Playfair Display|r|5ji0|400-900;Playfair Display SC|r|3lu0;Playpen Sans|h|73|100-800;Playpen Sans Arabic|h|73|100-800;Playpen Sans Deva|h|73|100-800;Playpen Sans Hebrew|h|73|100-800;Playpen Sans Thai|h|73|100-800;Playwrite AR|h|f|100-400;Playwrite AR Guides|h|8;Playwrite AT|h|5xr|100-400;Playwrite AT Guides|h|360;Playwrite AU NSW|h|f|100-400;Playwrite AU NSW Guides|h|8;Playwrite AU QLD|h|f|100-400;Playwrite AU QLD Guides|h|8;Playwrite AU SA|h|f|100-400;Playwrite AU SA Guides|h|8;Playwrite AU TAS|h|f|100-400;Playwrite AU TAS Guides|h|8;Playwrite AU VIC|h|f|100-400;Playwrite AU VIC Guides|h|8;Playwrite BE VLG|h|f|100-400;Playwrite BE VLG Guides|h|8;Playwrite BE WAL|h|f|100-400;Playwrite BE WAL Guides|h|8;Playwrite BR|h|f|100-400;Playwrite BR Guides|h|8;Playwrite CA|h|f|100-400;Playwrite CA Guides|h|8;Playwrite CL|h|f|100-400;Playwrite CL Guides|h|8;Playwrite CO|h|f|100-400;Playwrite CO Guides|h|8;Playwrite CU|h|f|100-400;Playwrite CU Guides|h|8;Playwrite CZ|h|f|100-400;Playwrite CZ Guides|h|8;Playwrite DE Grund|h|f|100-400;Playwrite DE Grund Guides|h|8;Playwrite DE LA|h|f|100-400;Playwrite DE LA Guides|h|8;Playwrite DE SAS|h|f|100-400;Playwrite DE SAS Guides|h|8;Playwrite DE VA|h|f|100-400;Playwrite DE VA Guides|h|8;Playwrite DK Loopet|h|f|100-400;Playwrite DK Loopet Guides|h|8;Playwrite DK Uloopet|h|f|100-400;Playwrite DK Uloopet Guides|h|8;Playwrite ES|h|f|100-400;Playwrite ES Deco|h|f|100-400;Playwrite ES Deco Guides|h|8;Playwrite ES Guides|h|8;Playwrite FR Moderne|h|f|100-400;Playwrite FR Moderne Guides|h|8;Playwrite FR Trad|h|f|100-400;Playwrite FR Trad Guides|h|8;Playwrite GB J|h|5xr|100-400;Playwrite GB J Guides|h|360;Playwrite GB S|h|5xr|100-400;Playwrite GB S Guides|h|360;Playwrite HR|h|f|100-400;Playwrite HR Guides|h|8;Playwrite HR Lijeva|h|f|100-400;Playwrite HR Lijeva Guides|h|8;Playwrite HU|h|f|100-400;Playwrite HU Guides|h|8;Playwrite ID|h|f|100-400;Playwrite ID Guides|h|8;Playwrite IE|h|f|100-400;Playwrite IE Guides|h|8;Playwrite IN|h|f|100-400;Playwrite IN Guides|h|8;Playwrite IS|h|f|100-400;Playwrite IS Guides|h|8;Playwrite IT Moderna|h|f|100-400;Playwrite IT Moderna Guides|h|8;Playwrite IT Trad|h|f|100-400;Playwrite IT Trad Guides|h|8;Playwrite MX|h|f|100-400;Playwrite MX Guides|h|8;Playwrite NG Modern|h|f|100-400;Playwrite NG Modern Guides|h|8;Playwrite NL|h|f|100-400;Playwrite NL Guides|h|8;Playwrite NO|h|f|100-400;Playwrite NO Guides|h|8;Playwrite NZ|h|f|100-400;Playwrite NZ Basic|h|f|100-400;Playwrite NZ Basic Guides|h|8;Playwrite NZ Guides|h|8;Playwrite PE|h|f|100-400;Playwrite PE Guides|h|8;Playwrite PL|h|f|100-400;Playwrite PL Guides|h|8;Playwrite PT|h|f|100-400;Playwrite PT Guides|h|8;Playwrite RO|h|f|100-400;Playwrite RO Guides|h|8;Playwrite SK|h|f|100-400;Playwrite SK Guides|h|8;Playwrite TZ|h|f|100-400;Playwrite TZ Guides|h|8;Playwrite US Modern|h|f|100-400;Playwrite US Modern Guides|h|8;Playwrite US Trad|h|f|100-400;Playwrite US Trad Guides|h|8;Playwrite VN|h|f|100-400;Playwrite VN Guides|h|8;Playwrite ZA|h|f|100-400;Playwrite ZA Guides|h|8;Pliant|s|5m9r|100-900;Plus Jakarta Sans|s|2sji|200-800;Pochaevsk|d|8;Podkova|r|6w|400-800;Poetsen One|d|8;Poiret One|d|8;Poller One|d|8;Poltawski Nowy|r|1bi0|400-700;Poly|r|360;Pompiere|d|8;Ponnala|d|8;Ponomar|d|8;Pontano Sans|s|3g|300-700;Poor Story|d|8;Poppins|s|5m9r;Port Lligat Sans|s|8;Port Lligat Slab|r|8;Potta One|d|8;Pragati Narrow|s|20;Praise|h|8;Prata|r|8;Preahvihear|s|8;Press Start 2P|d|8;Pridi|r|3i;Princess Sofia|h|8;Prociono|r|8;Prompt|s|5m9r;Prosto One|d|8;Protest Guerrilla|d|8;Protest Revolution|d|8;Protest Riot|d|8;Protest Strike|d|8;Proza Libre|s|2q60;Public Sans|s|5m9r|100-900;Puppies Play|h|8;Puritan|s|si0;Purple Purse|d|8;Qahiri|s|8;Quando|r|8;Quantico|s|si0;Quattrocento|r|20;Quattrocento Sans|s|si0;Questrial|s|8;Quicksand|s|3g|300-700;Quintessential|h|8;Qwigley|h|8;Qwitcher Grypen|h|20;REM|s|5m9r|100-900;Racing Sans One|d|8;Radio Canada|s|1d30|300-700;Radio Canada Big|s|1bi0|400-700;Radley|r|360;Rajdhani|s|3g;Rakkas|d|8;Raleway|s|5m9r|100-900;Raleway Dots|d|8;Ramabhadra|s|8;Ramaraja|r|8;Rambla|s|si0;Rammetto One|d|8;Rampart One|d|8;Ramsina|r|8;Ranchers|d|8;Rancho|h|8;Ranga|d|20;Rasa|r|1d30|300-700;Rationale|s|8;Ravi Prakash|d|8;Readex Pro|s|3i|160-700;Recursive|s|e4|300-1000;Red Hat Display|s|5l30|300-900;Red Hat Mono|m|1d30|300-700;Red Hat Text|s|1d30|300-700;Red Rose|d|3g|300-700;Redacted|d|8;Redacted Script|d|24;Reddit Mono|m|e6|200-900;Reddit Sans|s|5lvi|200-900;Reddit Sans Condensed|s|e6|200-900;Redressed|h|8;Reem Kufi|s|3c|400-700;Reem Kufi Fun|s|3c|400-700;Reem Kufi Ink|s|8;Reenie Beanie|h|8;Reggae One|d|8;Rethink Sans|s|2q60|400-800;Revalia|d|8;Rhodium Libre|r|8;Ribeye|d|8;Ribeye Marrow|d|8;Righteous|d|8;Risque|d|8;Road Rage|d|8;Roboto|s|5m9r|100-900;Roboto Condensed|s|5m9r|100-900;Roboto Flex|s|e7|100-1000;Roboto Mono|m|1e9r|100-700;Roboto Serif|r|5m9r|100-900;Roboto Slab|r|e7|100-900;Rochester|h|8;Rock 3D|d|8;Rock Salt|h|8;RocknRoll One|s|8;Rokkitt|r|5m9r|100-900;Romanesco|h|8;Ropa Sans|s|360;Rosario|s|1d30|300-700;Rosarivo|r|360;Rouge Script|h|8;Rowdies|d|24;Rozha One|r|8;Rubik|s|5l30|300-900;Rubik 80s Fade|d|8;Rubik Beastly|d|8;Rubik Broken Fax|d|8;Rubik Bubbles|d|8;Rubik Burned|d|8;Rubik Dirt|d|8;Rubik Distressed|d|8;Rubik Doodle Shadow|d|8;Rubik Doodle Triangles|d|8;Rubik Gemstones|d|8;Rubik Glitch|d|8;Rubik Glitch Pop|d|8;Rubik Iso|d|8;Rubik Lines|d|8;Rubik Maps|d|8;Rubik Marker Hatch|d|8;Rubik Maze|d|8;Rubik Microbe|d|8;Rubik Mono One|s|8;Rubik Moonrocks|d|8;Rubik Pixels|d|8;Rubik Puddles|d|8;Rubik Scribble|d|8;Rubik Spray Paint|d|8;Rubik Storm|d|8;Rubik Vinyl|d|8;Rubik Wet Paint|d|8;Ruda|s|e0|400-900;Rufina|r|20;Ruge Boogie|h|8;Ruluko|s|8;Rum Raisin|s|8;Ruslan Display|d|8;Russo One|s|8;Ruthie|h|8;Ruwudu|r|3c;Rye|d|8;SN Pro|s|5lvi|200-900;STIX Two Math|r|8;STIX Two Text|r|1bi0|400-700;SUSE|s|5m9r|100-900;SUSE Mono|s|2sxr|100-800;Sacramento|h|8;Sahitya|r|20;Sail|d|8;Saira|s|5m9r|100-900;Saira Condensed|s|e7;Saira Extra Condensed|s|e7;Saira Semi Condensed|s|e7;Saira Stencil|d|5m9r|100-900;Salsa|d|8;Sanchez|r|360;Sancreek|d|8;Sankofa Display|s|8;Sansation|s|u30;Sansita|s|50i0;Sansita Swashed|d|e4|300-900;Sarabun|s|2sxr;Sarala|s|20;Sarina|d|8;Sarpanch|s|e0;Sassy Frass|h|8;Satisfy|h|8;Savate|s|5lvi|200-900;Sawarabi Gothic|s|8;Sawarabi Mincho|r|8;Scada|s|si0;Scheherazade New|r|3c;Schibsted Grotesk|s|5ji0|400-900;Schoolbell|h|8;Science Gothic|s|e7|100-900;Scope One|r|8;Scoutie Sans|s|2sji|200-800;Seaweed Script|d|8;Secular One|s|8;Sedan|r|360;Sedan SC|r|8;Sedgwick Ave|h|8;Sedgwick Ave Display|h|8;Sekuya|d|8;Sen|s|6w|400-800;Send Flowers|h|8;Sevillana|d|8;Seymour One|s|8;Shadows Into Light|h|8;Shadows Into Light Two|h|8;Shafarik|d|8;Shalimar|h|8;Shantell Sans|d|2rr0|300-800;Shanti|s|8;Share|s|si0;Share Tech|s|8;Share Tech Mono|m|8;Shippori Antique|s|8;Shippori Antique B1|s|8;Shippori Mincho|r|6w;Shippori Mincho B1|r|6w;Shizuru|d|8;Shojumaru|d|8;Short Stack|h|8;Shrikhand|d|8;Siemreap|s|8;Sigmar|d|8;Sigmar One|d|8;Signika|s|3g|300-700;Signika Negative|s|3g|300-700;Silkscreen|d|20;Simonetta|d|2wi0;Single Day|d|8;Sintony|s|20;Sirin Stencil|d|8;Sirivennela|s|8;Six Caps|s|8;Sixtyfour|m|8;Sixtyfour Convergence|m|8;Skranji|d|20;Slabo 13px|r|8;Slabo 27px|r|8;Slackey|d|8;Slackside One|h|8;Smokum|d|8;Smooch|h|8;Smooch Sans|s|e7|100-900;Smythe|d|8;Sniglet|d|3s;Snippet|s|8;Snowburst One|d|8;Sofadi One|d|8;Sofia|h|8;Sofia Sans|s|5m9r|1-1000;Sofia Sans Condensed|s|5m9r|1-1000;Sofia Sans Extra Condensed|s|5m9r|1-1000;Sofia Sans Semi Condensed|s|5m9r|1-1000;Solitreo|h|8;Solway|r|64;Sometype Mono|m|1bi0|400-700;Song Myung|r|8;Sono|s|72|200-800;Sonsie One|d|8;Sora|s|73|100-800;Sorts Mill Goudy|r|360;Sour Gummy|s|5m9r|100-900;Source Code Pro|m|5lvi|200-900;Source Sans 3|s|5lvi|200-900;Source Serif 4|r|5lvi|200-900;Space Grotesk|s|3g|300-700;Space Mono|m|si0;Special Elite|d|8;Special Gothic|s|3c|400-700;Special Gothic Condensed One|s|8;Special Gothic Expanded One|s|8;Spectral|r|2sji;Spectral SC|r|2sji;Spicy Rice|d|8;Spinnaker|s|8;Spirax|d|8;Splash|h|8;Spline Sans|s|3g|300-700;Spline Sans Mono|m|1d30|300-700;Squada One|d|8;Square Peg|h|8;Sree Krushnadevaraya|r|8;Sriracha|h|8;Srisakdi|d|20;Staatliches|d|8;Stack Sans Headline|s|3i|200-700;Stack Sans Notch|s|3i|200-700;Stack Sans Text|s|3i|200-700;Stalemate|h|8;Stalinist One|d|8;Stardos Stencil|d|20;Stick|s|8;Stick No Bills|s|72|200-800;Stint Ultra Condensed|r|8;Stint Ultra Expanded|r|8;Stoke|r|c;Story Script|s|8;Strait|s|8;Strichpunkt Sans|s|e0|400-900;Style Script|h|8;Stylish|s|8;Sue Ellen Francisco|h|8;Suez One|r|8;Sulphur Point|s|24;Sumana|r|20;Sunflower|s|2c;Sunshiney|h|8;Supermercado One|d|8;Sura|r|20;Suranna|r|8;Suravaram|r|8;Suwannaphum|r|99;Swanky and Moo Moo|h|8;Syncopate|s|20;Syne|s|6w|400-800;Syne Mono|m|8;Syne Tactile|d|8;TASA Explorer|s|6w|400-800;TASA Orbiter|s|6w|400-800;Tac One|s|8;Tagesschrift|d|8;Tai Heritage Pro|r|20;Tajawal|s|da;Tangerine|h|20;Tapestry|h|8;Taprom|d|8;Tauri|s|8;Taviraj|r|5m9r;Teachers|s|2q60|400-800;Teko|s|3g|300-700;Tektur|d|e0|400-900;Telex|s|8;Tenali Ramakrishna|s|8;Tenor Sans|s|8;Text Me One|s|8;Texturina|r|5m9r|100-900;Thasadith|s|si0;The Girl Next Door|h|8;The Nautigal|h|20;Tienne|r|94;TikTok Sans|s|e4|300-900;Tillana|d|6w;Tilt Neon|d|8;Tilt Prism|d|8;Tilt Warp|d|8;Timmana|s|8;Tinos|r|si0;Tiny5|s|8;Tiro Bangla|r|360;Tiro Devanagari Hindi|r|360;Tiro Devanagari Marathi|r|360;Tiro Devanagari Sanskrit|r|360;Tiro Gurmukhi|r|360;Tiro Kannada|r|360;Tiro Tamil|r|360;Tiro Telugu|r|360;Tirra|s|e0;Titan One|d|8;Titillium Web|s|17qm;Tomorrow|s|5m9r;Tourney|d|5m9r|100-900;Trade Winds|d|8;Train One|d|8;Triodion|d|8;Trirong|r|5m9r;Trispace|s|73|100-800;Trocchi|r|8;Trochut|d|37s;Truculenta|s|e7|100-900;Trykker|r|8;Tsukimi Rounded|s|3g;Tuffy|s|si0;Tulpen One|d|8;Turret Road|d|66;Twinkle Star|h|8;Ubuntu|s|10f0;Ubuntu Condensed|s|8;Ubuntu Mono|m|si0;Ubuntu Sans|s|2sxr|100-800;Ubuntu Sans Mono|m|1bi0|400-700;Uchen|r|8;Ultra|r|8;Unbounded|s|e6|200-900;Uncial Antiqua|d|8;Underdog|d|8;Unica One|d|8;UnifrakturCook|d|1s;UnifrakturMaguntia|d|8;Unkempt|d|20;Unlock|d|8;Unna|r|si0;UoqMunThenKhung|r|8;Updock|h|8;Urbanist|s|5m9r|100-900;VT323|m|8;Valley Sans|s|5m9r|100-900;Vampiro One|d|8;Varela|s|8;Varela Round|s|8;Varta|s|3g|300-700;Vast Shadow|r|8;Vazirmatn|s|e7|100-900;Vend Sans|s|1d30|300-700;Vesper Libre|r|9k;Viaoda Libre|d|8;Vibes|d|8;Vibur|h|8;Victor Mono|m|1e9r|100-700;Vidaloka|r|8;Viga|s|8;Vina Sans|d|8;Voces|s|8;Volkhov|r|si0;Vollkorn|r|5ji0|400-900;Vollkorn SC|r|a0;Voltaire|s|8;Vujahday Script|h|8;WDXL Lubrifont JP N|s|8;WDXL Lubrifont SC|s|8;WDXL Lubrifont TC|s|8;Waiting for the Sunrise|h|8;Wallpoet|d|8;Walter Turncoat|h|8;Warnes|d|8;Water Brush|h|8;Waterfall|h|8;Wavefont|d|e7|4-1000;Wellfleet|r|8;Wendy One|s|8;Whisper|h|8;WindSong|h|o;Winky Rough|s|5l30|300-900;Winky Sans|s|5l30|300-900;Wire One|s|8;Wittgenstein|r|5ji0|400-900;Wix Madefor Display|s|6w|400-800;Wix Madefor Text|s|2q60|400-800;Work Sans|s|5m9r|100-900;Workbench|m|8;Xanh Mono|m|360;Yaldevi|s|3i|200-700;Yanone Kaffeesatz|s|3i|200-700;Yantramanav|s|9p;Yarndings 12|d|8;Yarndings 12 Charted|d|8;Yarndings 20|d|8;Yarndings 20 Charted|d|8;Yatra One|d|8;Yellowtail|h|8;Yeon Sung|d|8;Yeseva One|d|8;Yesteryear|h|8;Yomogi|h|8;Young Serif|r|8;Yrsa|r|1d30|300-700;Ysabeau|s|5m9r|1-1000;Ysabeau Infant|s|5m9r|1-1000;Ysabeau Office|s|5m9r|1-1000;Ysabeau SC|s|e7|1-1000;Yuji Boku|r|8;Yuji Hentaigana Akari|h|8;Yuji Hentaigana Akebono|h|8;Yuji Mai|r|8;Yuji Syuku|r|8;Yusei Magic|s|8;Yuyu|h|8;Yuyu Short|h|8;ZCOOL KuaiLe|s|8;ZCOOL QingKe HuangYou|s|8;ZCOOL XiaoWei|s|8;Zain|s|53i;Zalando Sans|s|5lvi|200-900;Zalando Sans Expanded|s|5lvi|200-900;Zalando Sans SemiExpanded|s|5lvi|200-900;Zen Antique|r|8;Zen Antique Soft|r|8;Zen Dots|d|8;Zen Kaku Gothic Antique|s|9o;Zen Kaku Gothic New|s|9o;Zen Kurenaido|s|8;Zen Loop|d|360;Zen Maru Gothic|s|9o;Zen Old Mincho|r|ag;Zen Tokyo Zoo|d|8;Zeyada|h|8;Zhi Mang Xing|h|8;Zilla Slab|r|1d30;Zilla Slab Highlight|r|20';
let GF = null;
function gfLookup(fam) {
  if (!GF) {
    GF = {};
    GF_DATA.split(';').forEach(r => {
      const p = r.split('|'), rg = p[3] ? p[3].split('-').map(Number) : null;
      GF[p[0].toLowerCase()] = { family: p[0], cat: p[1], mask: parseInt(p[2], 36), min: rg ? rg[0] : 0, max: rg ? rg[1] : 0 };
    });
  }
  return GF[String(fam || '').trim().toLowerCase()] || null;
}
const FONT_FMT = { woff2: ['font/woff2', 'woff2'], woff: ['font/woff', 'woff'], ttf: ['font/ttf', 'truetype'], otf: ['font/otf', 'opentype'] };
async function loadFontUploads(families) {
  const out = {};
  try {
    const keys = (await figma.clientStorage.keysAsync()).filter(k => k.indexOf('font:') === 0 && families.indexOf(k.slice(5).split('|')[0]) > -1);
    for (const k of keys) { const v = await figma.clientStorage.getAsync(k); if (v && v.bytes) out[k.slice(5)] = v; }
  } catch (e) { /* ignore */ }
  return out;
}
/** Decide how each font family is delivered. */
async function planFonts(ctx, lang, wantBytes, fast) {
  const plan = { google: [], faces: [], files: [], families: [] };
  const fams = Object.keys(ctx.fonts);
  if (!fams.length) return plan;
  const uploads = await loadFontUploads(fams);
  // local catalog lookup: instant, and works offline
  const checks = fams.map(fam => systemKind(fam) ? null : googleCheck(fam, sortKeys(Object.keys(ctx.fonts[fam]))));
  void fast;
  for (const [fi, fam] of fams.entries()) {
    const keys = sortKeys(Object.keys(ctx.fonts[fam]));
    const info = { family: fam, kind: fontKind(fam), variants: [] };
    const sys = systemKind(fam);
    let g = { google: false, ok: [] };
    if (sys) { info.source = 'system'; info.kind = sys; }
    else {
      g = checks[fi]; info.source = g.google ? 'google' : 'custom'; }
    if (info.source === 'google') plan.google.push({ family: g.family || fam, keys: g.ok });
    keys.forEach(k => {
      const it = k[0] === '1', w = +k.split(',')[1], style = ctx.fonts[fam][k];
      const up = uploads[fam + '|' + k];
      const v = { key: k, weight: w, italic: it, style: style, uploaded: !!up, onGoogle: g.ok.indexOf(k) > -1 };
      info.variants.push(v);
      if (info.source !== 'custom') return;
      const src = ['local("' + fam + ' ' + style + '")', 'local("' + fam.replace(/\s+/g, '') + '-' + String(style).replace(/\s+/g, '') + '")'];
      if (up) {
        const f = FONT_FMT[up.ext] || FONT_FMT.woff2;
        const file = 'fonts/' + slug(fam) + '-' + w + (it ? '-italic' : '') + '.' + up.ext;
        if (lang === 'html-single') src.push('url(data:' + f[0] + ';base64,' + figma.base64Encode(up.bytes) + ') format("' + f[1] + '")');
        else { src.push('url("' + (/^(react|vue|svelte)/.test(lang) ? './' : '') + file + '") format("' + f[1] + '")'); if (wantBytes) plan.files.push({ name: file, bytes: up.bytes }); }
      }
      plan.faces.push('@font-face {\n  font-family: "' + fam + '";\n  src: ' + src.join(',\n       ') + ';\n  font-weight: ' + w + ';\n  font-style: ' + (it ? 'italic' : 'normal') + ';\n  font-display: swap;\n}');
    });
    plan.families.push(info);
  }
  return plan;
}
function fontStack(value, plan) {
  if (!value || /var\(/.test(value)) return value;
  const first = value.split(',')[0].replace(/["']/g, '').trim();
  if (!first) return value;
  const info = plan.families.find(f => f.family.toLowerCase() === first.toLowerCase());
  const kind = info ? info.kind : (systemKind(first) || fontKind(first));
  return (/\s/.test(first) ? '"' + first + '"' : first) + ', ' + STACK[kind];
}
function applyFontStacks(root, ctx, plan) {
  walk(root, e => {
    if (e.css['font-family']) e.css['font-family'] = fontStack(e.css['font-family'], plan);
    (e.runs || []).forEach(r => { if (r.css && r.css['font-family']) r.css['font-family'] = fontStack(r.css['font-family'], plan); });
  });
  Object.keys(ctx.vars).forEach(k => { if (/font(?!-?(size|weight|height|spacing))/i.test(k) && !/^[\d.]/.test(ctx.vars[k])) ctx.vars[k] = fontStack(ctx.vars[k], plan); });
}
/** CSS for fonts. `withImport` = Google Fonts via a CSS at-rule (for .css files); HTML uses a <link> tag instead. */
function fontCss(plan, withImport) {
  const parts = [];
  if (withImport && plan.google.length) parts.push("@import url('" + googleHref(plan.google) + "');");
  const custom = plan.families.filter(f => f.source === 'custom');
  if (custom.length) {
    const missing = custom.filter(f => f.variants.some(v => !v.uploaded)).map(f => f.family);
    parts.push('/* Not on Google Fonts: ' + custom.map(f => f.family).join(', ') + (missing.length ? '\n   Variants without a file use the copy installed on the device (local()).\n   Add the font files in DevReady → Code → Fonts to bundle them. */' : ' — font files bundled */') + '\n' + plan.faces.join('\n'));
  }
  return parts.join('\n\n');
}
function fontHead(plan) {
  if (!plan.google.length) return '';
  return '  <link rel="preconnect" href="https://fonts.googleapis.com" />\n  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />\n  <link href="' + googleHref(plan.google).replace(/&/g, '&amp;') + '" rel="stylesheet" />\n';
}

/* ---------- Figma-measured Auto line-height for wrapped text ---------- */
function svgNumberAttr(attrs, name) {
  const m = new RegExp('\\b' + name + '="([^"]+)"').exec(attrs);
  const value = m ? parseFloat(m[1]) : null;
  return value !== null && isFinite(value) ? value : null;
}
/** Figma's non-outlined SVG export contains its own laid-out text baselines. */
function measureSvgText(svg) {
  const ys = [];
  const texts = String(svg).match(/<text\b[^>]*>[\s\S]*?<\/text>/g) || [];
  for (const block of texts) {
    const head = /^<text\b([^>]*)>/.exec(block);
    let y = head ? svgNumberAttr(head[1], 'y') : null;
    const spans = block.match(/<tspan\b[^>]*>/g) || [];
    if (!spans.length && y !== null) ys.push(y);
    for (const span of spans) {
      const attrs = span.replace(/^<tspan\b|\/?>$/g, '');
      const absolute = svgNumberAttr(attrs, 'y');
      const relative = svgNumberAttr(attrs, 'dy');
      if (absolute !== null) y = absolute;
      else if (relative !== null) y = (y || 0) + relative;
      if (y !== null) ys.push(y);
    }
  }
  ys.sort((a, b) => a - b);
  const unique = [];
  ys.forEach(y => { if (!unique.length || Math.abs(y - unique[unique.length - 1]) > 0.01) unique.push(y); });
  if (unique.length < 2) return null;
  const deltas = [];
  for (let i = 1; i < unique.length; i++) deltas.push(unique[i] - unique[i - 1]);
  if (deltas[0] <= 0 || deltas.some(d => Math.abs(d - deltas[0]) > Math.max(0.05, deltas[0] * 0.002))) return null;
  const lineHeight = round(deltas.reduce((a, b) => a + b, 0) / deltas.length, 2);
  return { lineHeight: lineHeight };
}
function measuredSvgLineHeight(svg) {
  const metrics = measureSvgText(svg);
  return metrics ? metrics.lineHeight : null;
}
async function resolveAutoLineHeights(root, ctx, lang) {
  // SVG baselines map directly to CSS line boxes. Native text engines have
  // different baseline/line-box contracts, so do not invent a native metric.
  if (['react-native', 'swiftui', 'compose', 'flutter'].indexOf(lang) > -1) return;
  const candidates = [];
  walk(root, e => {
    if (e.kind !== 'text' || e.css['line-height'] !== 'normal' || !e.text || e.textAutoResize === 'WIDTH_AND_HEIGHT') return;
    if ((e.runs || []).some(r => r.css && r.css['font-size'])) return;
    candidates.push(e);
  });
  for (const e of candidates) {
    try {
      const n = await figma.getNodeByIdAsync(e.id);
      if (!n || n.type !== 'TEXT' || n.paragraphSpacing > 0 || !('exportAsync' in n)) continue;
      const result = await n.exportAsync({ format: 'SVG_STRING', svgOutlineText: false });
      const lineHeight = measuredSvgLineHeight(typeof result === 'string' ? result : utf8(result));
      if (lineHeight) e.css['line-height'] = lineHeight + 'px';
    } catch (err) { /* retain normal and surface the generated-code warning */ }
  }
  walk(root, e => {
    if (e.kind === 'text' && e.css['line-height'] === 'normal') ctx.autoLineHeight = (ctx.autoLineHeight || 0) + 1;
  });
}

/* ---------- image fills: real files for projects, data URIs for single HTML ---------- */
function hasImagePlaceholder(css) {
  return /url\(<path-to-image>\)/.test(css.background || '') || /url\(<path-to-image>\)/.test(css['background-image'] || '');
}
function imagePlaceholderCount(css) {
  const count = k => (String(css[k] || '').match(/url\(<path-to-image>\)/g) || []).length;
  return Math.max(count('background'), count('background-image'));
}
function imagePaints(n) {
  return n && 'fills' in n && !isMixed(n.fills) ? n.fills.filter(f => f.type === 'IMAGE' && f.visible !== false && f.imageHash) : [];
}
function replaceImagePlaceholders(css, replacements) {
  ['background', 'background-image'].forEach(k => {
    if (!css[k]) return;
    let i = 0;
    css[k] = css[k].replace(/url\(<path-to-image>\)/g, () => replacements[i++] || 'none');
  });
}
function replaceImagePlaceholder(css, replacement) {
  ['background', 'background-image'].forEach(k => {
    if (css[k]) css[k] = css[k].replace(/url\(<path-to-image>\)/g, () => replacement);
  });
}
function assetProblem(ctx, detail) {
  ctx.assetErrors = ctx.assetErrors || [];
  if (ctx.assetErrors.indexOf(detail) < 0) ctx.assetErrors.push(detail);
}
function rasterExtension(bytes) {
  if (bytes && bytes.length > 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return 'jpg';
  if (bytes && bytes.length > 5 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'gif';
  if (bytes && bytes.length > 11 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'webp';
  return 'png';
}
function rasterMime(bytes) {
  const ext = rasterExtension(bytes);
  return ext === 'jpg' ? 'image/jpeg' : 'image/' + ext;
}

/** Multi-file targets need a real file wherever Figma's CSS uses url(<path-to-image>). */
async function materializeImageFills(root, ctx, native) {
  const els = [];
  walk(root, e => { if (hasImagePlaceholder(e.css)) els.push(e); });
  for (const e of els) {
    try {
      const n = await figma.getNodeByIdAsync(e.id);
      const paints = imagePaints(n);
      if (!paints.length || imagePlaceholderCount(e.css) !== paints.length) throw new Error('image data unavailable');
      // Native background APIs accept one full-layer FILL/FIT image. More complex
      // paint stacks fail explicitly instead of rendering the wrong artwork.
      if (native && (paints.length !== 1 || ['FILL', 'FIT'].indexOf(paints[0].scaleMode) < 0)) throw new Error('unsupported native image fill');
      const replacements = [];
      for (const paint of paints) {
        const key = 'fill:' + paint.imageHash;
        let file = ctx.assetByKey[key];
        if (!file) {
          const baseName = (cleanName(e.name) || 'image') + '-fill';
          let fname = baseName, i = 1;
          while (ctx.assetNames[fname]) fname = baseName + '-' + (++i);
          ctx.assetNames[fname] = 1;
          file = { id: n.id, file: fname + '.png', format: 'PNG', scale: 1, varName: camel(fname) + 'Img', imageHash: paint.imageHash, cssOnly: true };
          ctx.assetByKey[key] = file;
          ctx.assets.push(file);
        }
        replacements.push('url(assets/' + file.file + ')');
        if (native) e.bgImage = { asset: file, scaleMode: paint.scaleMode };
      }
      // Unquoted URLs are valid CSS and safe inside JSX/Tailwind class attributes.
      replaceImagePlaceholders(e.css, replacements);
      if (!e.css['background-size'] && (!e.css.background || !/\b(cover|contain)\b/.test(e.css.background))) {
        e.css['background-size'] = paints.map(p => p.scaleMode === 'FIT' ? 'contain' : 'cover').join(', ');
      }
    } catch (err) {
      replaceImagePlaceholder(e.css, 'none');
      assetProblem(ctx, 'image fill on ' + e.id);
    }
  }
}
/** Never emit Figma's non-standard placeholder, even if an embed budget was hit. */
function clearUnresolvedImageFills(root, ctx) {
  walk(root, e => {
    if (!hasImagePlaceholder(e.css)) return;
    replaceImagePlaceholder(e.css, 'none');
    assetProblem(ctx, 'unembedded image fill on ' + e.id);
  });
}

/* ---------- single-file HTML: embed assets & image fills as data URIs ---------- */
const DATA_MIME = { SVG: 'image/svg+xml', PNG: 'image/png', JPG: 'image/jpeg' };
async function inlineAssets(root, ctx, budget) {
  let used = 0;
  // 1) exported assets (icons, images, layers with export settings)
  for (const a of ctx.assets) {
    try {
      const n = await figma.getNodeByIdAsync(a.id);
      if (!n) throw new Error('layer unavailable');
      const fmt = a.format === 'SVG' ? 'SVG' : a.format === 'JPG' ? 'JPG' : 'PNG';
      const o = { format: fmt };
      if (fmt === 'SVG') o.svgOutlineText = true; else o.constraint = { type: 'SCALE', value: a.scale || 2 };
      const bytes = await n.exportAsync(o);
      if (used + bytes.length > budget) { assetProblem(ctx, a.file + ' exceeds the inline budget'); continue; }
      used += bytes.length;
      if (fmt === 'SVG') { const m = cleanSvg(utf8(bytes)); if (m) a.svg = m; else a.src = 'data:' + DATA_MIME[fmt] + ';base64,' + figma.base64Encode(bytes); }
      else a.src = 'data:' + DATA_MIME[fmt] + ';base64,' + figma.base64Encode(bytes);
    } catch (e) { assetProblem(ctx, 'could not embed ' + a.file); }
  }
  // 2) image fills on containers (Figma's CSS says url(<path-to-image>))
  const els = [];
  const fillBytes = {};
  walk(root, e => { if (hasImagePlaceholder(e.css)) els.push(e); });
  for (const e of els) {
    try {
      const n = await figma.getNodeByIdAsync(e.id);
      const paints = imagePaints(n);
      if (!paints.length || imagePlaceholderCount(e.css) !== paints.length) throw new Error('image data unavailable');
      const replacements = [];
      for (const paint of paints) {
        if (!fillBytes[paint.imageHash]) {
          const img = figma.getImageByHash(paint.imageHash);
          if (!img) throw new Error('image data unavailable');
          const bytes = await img.getBytesAsync();
          if (used + bytes.length > budget) throw new Error('inline budget exceeded');
          used += bytes.length;
          fillBytes[paint.imageHash] = bytes;
        }
        const bytes = fillBytes[paint.imageHash];
        replacements.push('var(' + embedImage(ctx, 'fill', 'url(data:' + rasterMime(bytes) + ';base64,' + figma.base64Encode(bytes) + ')') + ')');
      }
      replaceImagePlaceholders(e.css, replacements);
      if (!e.css['background-size'] && (!e.css.background || !/\b(cover|contain)\b/.test(e.css.background))) {
        e.css['background-size'] = paints.map(p => p.scaleMode === 'FIT' ? 'contain' : 'cover').join(', ');
      }
    } catch (e2) { assetProblem(ctx, 'could not embed image fill on ' + e.id); }
  }
  // 3) raster images become CSS backgrounds (data URI lives once, at the end of the stylesheet)
  walk(root, e => {
    if (e.kind !== 'img' || !e.asset.src) return;
    const alt = e.attrs.alt;
    e.kind = 'box'; e.tag = 'div'; e.children = [];
    e.attrs = alt ? { role: 'img', 'aria-label': alt } : { 'aria-hidden': 'true' };
    e.css['background-image'] = 'var(' + embedImage(ctx, e.asset.file.replace(/\.\w+$/, ''), 'url(' + e.asset.src + ')') + ')';
    e.css['background-size'] = 'contain'; e.css['background-position'] = 'center'; e.css['background-repeat'] = 'no-repeat';
  });
  return used;
}
/** UTF-8 bytes to string. */
function utf8(bytes) {
  let b = '';
  for (let i = 0; i < bytes.length; i += 8192) b += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  try { return decodeURIComponent(escape(b)); } catch (e) { return b; }
}
/**
 * Exported SVG to inline-able markup: no XML header/comments, size comes from CSS.
 * Exported artwork is design content, but an SVG is also an executable document
 * when it is ever loaded directly, so anything scriptable, remote or style-bearing
 * is rejected rather than sanitised. Returns null → the caller embeds the raw
 * bytes as a data URI in an <img>, where nothing inside can run.
 */
/* Elements that can execute, fetch or replace the document when an exported SVG is
   inlined into generated HTML. `image`, `use` and `animate` are here because they
   can pull a remote resource or rewrite an href to a script URL. */
const SVG_BAD = /<\s*(script|foreignObject|iframe|object|embed|style|link|meta|base|audio|video|canvas|image|feImage|animate|animateMotion|animateTransform|set|handler|discard|listen)\b/i;
/* Named/numeric entities are decoded before values are checked: `javascript&#58;`
   is the same string to a browser but not to a naive regex. */
const SVG_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", colon: ':', tab: '\t', newline: '\n', sol: '/' };
function svgDecode(v) {
  return String(v).replace(/&(#x?[0-9a-f]+|[a-z]+);?/gi, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return isFinite(code) && code > 0 && code < 0x110000 ? String.fromCharCode(code) : '';
    }
    const k = body.toLowerCase();
    return Object.prototype.hasOwnProperty.call(SVG_ENTITIES, k) ? SVG_ENTITIES[k] : m;
  });
}
/** Attributes of a raw `<tag …>` body, tokenised the way a parser reads them. */
function svgAttrs(raw) {
  const out = [];
  const re = /([A-Za-z_:][-\w:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let m;
  while ((m = re.exec(raw))) {
    out.push({ name: m[1].toLowerCase(), value: m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] });
  }
  return out;
}
/** Anything that would execute or reach the network if this markup is inlined. */
function svgUnsafe(t) {
  if (/@import|expression\s*\(/i.test(t)) return true;
  if (/url\(\s*['"]?\s*(?:https?:|\/\/|javascript:|vbscript:|data:text\/html)/i.test(svgDecode(t))) return true;
  const re = /<\s*([A-Za-z][\w:.-]*)([^>]*)>/g;
  let m;
  while ((m = re.exec(t))) {
    const tag = m[1].toLowerCase();
    // `<use href="#id">` is safe (same document); an external one is caught by the href rule.
    if (/^(script|foreignobject|iframe|object|embed|style|link|meta|base|audio|video|canvas|image|feimage|animate|animatemotion|animatetransform|set|handler|discard|listen)$/.test(tag)) return true;
    const attrs = svgAttrs(svgDecode(m[2]));
    for (const a of attrs) {
      const name = a.name;
      if (/^on/.test(name)) return true;
      const value = svgDecode(a.value).replace(/[\u0000-\u001f\u007f\s]/g, '');
      if (/(?:javascript|vbscript|data:text\/html|data:image\/svg\+xml):?/i.test(value) && /javascript|vbscript|text\/html|svg\+xml/i.test(value)) return true;
      // href/src and friends may not leave the document (or the plugin's CSP)
      if (/^(href|xlink:href|src|action|formaction|poster|data)$/.test(name) && /^(?:https?:|\/\/)/i.test(value)) return true;
    }
  }
  return false;
}
function cleanSvg(text) {
  let t = String(text).replace(/<\?xml[^>]*\?>/g, '').replace(/<[!]--[\s\S]*?--[>]/g, '').replace(/<!DOCTYPE[^>]*>/gi, '').trim();
  if (!/^<svg\b/.test(t) || t.length > 200000) return null;
  if (SVG_BAD.test(t)) return null;
  if (/javascript:/i.test(t)) return null;
  if (svgUnsafe(t)) return null;
  t = t.replace(/^<svg\b([^>]*)>/, (m, attrs) => '<svg' + attrs.replace(/\s(width|height)="[^"]*"/g, '') + '>');
  return t;
}
/** Registers a data URI under a CSS custom property name, deduplicated. */
function embedImage(ctx, name, value) {
  ctx.embed = ctx.embed || { names: {}, list: [], byValue: {} };
  if (ctx.embed.byValue[value]) return ctx.embed.byValue[value];
  const base = '--img-' + (slug(name) || 'image');
  let n = base, i = 1;
  while (ctx.embed.names[n]) n = base + '-' + (++i);
  ctx.embed.names[n] = 1; ctx.embed.byValue[value] = n; ctx.embed.list.push({ name: n, value: value });
  return n;
}
/* Text scripts decide the document language and direction, so a screen reader
   announces an Arabic or Japanese design correctly. Latin-only designs keep
   lang="en" and no dir attribute, as before. */
const DOC_SCRIPTS = [
  { re: /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/g, lang: 'ar', rtl: true },
  { re: /[\u0590-\u05FF]/g, lang: 'he', rtl: true },
  { re: /[\u0900-\u097F]/g, lang: 'hi' },
  { re: /[\u0E00-\u0E7F]/g, lang: 'th' },
  { re: /[\u3040-\u30FF]/g, lang: 'ja' },
  { re: /[\uAC00-\uD7AF]/g, lang: 'ko' },
  { re: /[\u4E00-\u9FFF]/g, lang: 'zh' },
  { re: /[\u0400-\u04FF]/g, lang: 'ru' }
];
function docLang(root) {
  let text = '';
  walk(root, e => {
    if (e.kind === 'text' && e.text && text.length < 4000) text += ' ' + String(e.text).slice(0, 4000);
  });
  let best = null;
  DOC_SCRIPTS.forEach(sc => {
    const hits = (text.match(sc.re) || []).length;
    if (hits && (!best || hits > best.hits)) best = { lang: sc.lang, rtl: !!sc.rtl, hits: hits };
  });
  return best || { lang: 'en', rtl: false, hits: 0 };
}
function htmlOpenTag(root) {
  const l = docLang(root);
  return '<html lang="' + l.lang + '"' + (l.rtl ? ' dir="rtl"' : '') + '>';
}
function singleHtml(node, root, ctx, unit, base, note) {
  return '<!DOCTYPE html>\n' + htmlOpenTag(root) + '\n<head>\n  <meta charset="UTF-8" />\n  <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n  <title>' + escHtml(node.name) + '</title>\n' +
    fontHead(ctx.fontPlan) +
    '  <!' + '-- Single-file build from Figma (DevReady) · open it directly in any browser. CSS and assets are embedded. --' + '>\n' +
    '  <style>\n/* Page preview canvas */\nbody { margin: 0; min-height: 100vh; display: flex; justify-content: center; align-items: flex-start; padding: 40px 16px; box-sizing: border-box; background: #F5F5F5; }\n\n' +
    stylesheet(ctx, root.cls, unit, base, fontCss(ctx.fontPlan, false)) + '  </style>\n</head>\n<body>\n' +
    (note ? '  <!' + '-- ' + note + ' --' + '>\n' : '') + renderHTML(root, 1) + '\n</body>\n</html>\n';
}

/**
 * Generate code for a node.
 * lang: 'html-css' | 'react-tailwind' | 'react-css'
 * returns { files: [{name, lang, code}], assets: [{id,file,format,scale}], truncated, stats }
 */
async function generateCodeInner(node, lang, unit, base, maxNodes, opts) {
  opts = opts || {};
  const isReact = /^react-/.test(lang);
  const svgMode = opts.svgFrames || settings.svgFrames || 'auto';
  const ctx = { lang: lang, count: 0, max: maxNodes || 600, truncated: false, maxFont: 0, assets: [], assetByKey: {}, assetNames: {}, vars: {}, classes: {}, order: [], weights: {}, usedTitle: false, rootWidth: node.width,
    varIds: {}, themes: {}, tokenInfo: {}, imports: {}, fonts: {}, react: isReact, mappings: isReact ? loadMappings() : {} };
  ctx.svgFrames = svgMode;
  ctx.job = opts.job || null;
  const root = await buildRaw(node, ctx, true, false, 0);
  if (!root) return { files: [{ name: 'empty.txt', lang: 'text', code: 'Nothing visible to generate.' }], assets: [] };
  await resolveAutoLineHeights(root, ctx, lang);
  structurePass(root, null, ctx, null);
  walk(root, e => { if (e.css['font-weight']) ctx.weights[e.css['font-weight']] = 1; (e.runs || []).forEach(r => { if (r.css && r.css['font-weight']) ctx.weights[r.css['font-weight']] = 1; }); });
  hoistFont(root);
  collectVars(root, ctx);
  try { await resolveThemes(ctx); } catch (e) { diag('variable modes', e); }
  let fontPlan = { google: [], faces: [], files: [], families: [] };
  try { fontPlan = await planFonts(ctx, lang, !!opts.withFonts, !!opts.fastFonts); } catch (e) { diag('font availability', e); }
  applyFontStacks(root, ctx, fontPlan);
  ctx.fontPlan = fontPlan;
  ctx.rootFont = root.css['font-family'] || '';
  let inlined = 0;
  if (lang === 'html-single') {
    try { inlined = await inlineAssets(root, ctx, opts.inlineBudget || 8e6); }
    catch (e) { assetProblem(ctx, 'single-file asset embedding failed'); }
  } else {
    const native = ['react-native', 'swiftui', 'compose', 'flutter'].indexOf(lang) > -1;
    try { await materializeImageFills(root, ctx, native); }
    catch (e) { assetProblem(ctx, 'image-fill export failed'); }
  }
  clearUnresolvedImageFills(root, ctx);
  const rootName = cleanName(node.name) || 'component';
  if (root.tag === 'div' && node.width >= 900) root.tag = 'main';
  namePass(root, rootName, ctx, true);

  const Comp = pascal(rootName);
  ctx.rootName = Comp;
  const notes = [];
  if (ctx.depthLimited) notes.push('Layer tree deeper than ' + MAX_DEPTH + ' levels — nested layers beyond that are omitted. Select a child frame for the rest.');
  if (ctx.truncated && !ctx.depthLimited) notes.push('Output truncated after ' + ctx.max + ' layers — select a smaller frame for full code.');
  if (ctx.autoLineHeight) notes.push(ctx.autoLineHeight + ' text layer' + (ctx.autoLineHeight === 1 ? '' : 's') + ' could not be measured; browser font metrics can differ. Set an explicit line-height for pixel-exact output.');
  const illos = (ctx.assets || []).filter(a => a.illustration);
  if (illos.length) notes.push(illos.length + ' vector illustration' + (illos.length === 1 ? '' : 's') + ' exported as SVG (' + illos.slice(0, 3).map(a => a.file).join(', ') + (illos.length > 3 ? ', ...' : '') + '). Inner vector layers are not converted to code.');
  if (ctx.assetErrors && ctx.assetErrors.length) notes.push(ctx.assetErrors.length + ' asset export issue' + (ctx.assetErrors.length === 1 ? '' : 's') + ' — download the project for details or retry in Figma.');
  const note = notes.join(' ');
  const files = [];

  if (lang === 'swiftui' || lang === 'compose' || lang === 'flutter') {
    const defs = extractComponents(root, ctx);
    if (lang === 'swiftui') files.push({ name: Comp + '.swift', lang: 'swift', code: (note ? '// ' + note + '\n' : '') + generateSwift(root, defs, ctx, Comp) });
    else if (lang === 'flutter') files.push({ name: slug(rootName).replace(/-/g, '_') + '.dart', lang: 'dart', code: (note ? '// ' + note + '\n' : '') + generateFlutter(root, defs, ctx, Comp) });
    else files.push({ name: Comp + '.kt', lang: 'kotlin', code: (note ? '// ' + note + '\n' : '') + generateCompose(root, defs, ctx, Comp) });
  } else if (lang === 'react-native') {
    const defs = extractComponents(root, ctx);
    files.push({ name: Comp + '.jsx', lang: 'jsx', code: (note ? '// ' + note + '\n' : '') + generateRN(root, defs, ctx, Comp) });
  } else if (lang === 'vue' || lang === 'svelte') {
    const raw = renderHTML(root, lang === 'vue' ? 1 : 0);
    // {{ }} (Vue) and { } (Svelte) are template expressions: design text must never reach them
    const markup = lang === 'vue' ? raw.replace(/\{\{/g, '{&#123;') : raw.replace(/[{}]/g, c => c === '{' ? '&#123;' : '&#125;');
    const style = '<style>\n' + stylesheet(ctx, root.cls, unit, base, fontCss(ctx.fontPlan, true)) + '</style>\n';
    const cmt = note ? '<!' + '-- ' + note + ' --' + '>\n' : '';
    if (lang === 'vue') files.push({ name: Comp + '.vue', lang: 'vue', code: cmt + '<template>\n' + markup + '\n</template>\n\n' + style });
    else files.push({ name: Comp + '.svelte', lang: 'svelte', code: cmt + markup + '\n\n' + style });
  } else if (lang === 'html-single') {
    files.push({ name: rootName + '.html', lang: 'html', code: singleHtml(node, root, ctx, unit, base, note) });
  } else if (lang === 'html-css') {
    const html = '<!DOCTYPE html>\n' + htmlOpenTag(root) + '\n<head>\n  <meta charset="UTF-8" />\n  <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n  <title>' + escHtml(node.name) + '</title>\n' +
      fontHead(ctx.fontPlan) + '  <link rel="stylesheet" href="styles.css" />\n</head>\n<body>\n' +
      (note ? '  <!' + '-- ' + note + ' --' + '>\n' : '') + renderHTML(root, 1) + '\n</body>\n</html>\n';
    files.push({ name: 'index.html', lang: 'html', code: html });
    files.push({ name: 'styles.css', lang: 'css', code: stylesheet(ctx, root.cls, unit, base, fontCss(ctx.fontPlan, false), true) });
  } else {
    // react-css / react-tailwind emit JSX; react-ts / react-tailwind-ts add types.
    const ts = /-ts$/.test(lang);
    const mode = /^react-tailwind/.test(lang) ? 'tw' : 'css';
    const defs = extractComponents(root, ctx);
    const imports = Object.keys(ctx.imports).map(p => "import { " + Object.keys(ctx.imports[p]).join(', ') + " } from " + jsQuote(p) + ";")
      .concat(ctx.assets.filter(a => !a.cssOnly).map(a => "import " + a.varName + " from './assets/" + a.file + "';"));
    if (mode === 'css') imports.push("import './" + Comp + ".css';");
    else if (Object.keys(ctx.vars).length || fontCss(ctx.fontPlan, true)) imports.push("import './tokens.css';");
    const defCode = defs.map(def => {
      const args = def.props.length ? '{ ' + def.props.map(p => p.name).join(', ') + ' }' : '';
      const typed = ts && def.props.length ? args + ': ' + def.name + 'Props' : args;
      const propsType = ts && def.props.length ? 'type ' + def.name + 'Props = {\n' + def.props.map(p => '  ' + p.name + ': string;').join('\n') + '\n};\n\n' : '';
      return propsType + 'function ' + def.name + '(' + typed + ') {\n  return (\n' + renderJSX(def.tpl, 2, mode, unit, base, true) + '\n  );\n}';
    });
    const main = 'export default function ' + Comp + '() {\n  return (\n' + renderJSX(root, 2, mode, unit, base, false) + '\n  );\n}';
    const code = (imports.length ? imports.join('\n') + '\n\n' : '') + (note ? '// ' + note + '\n\n' : '') + defCode.concat([main]).join('\n\n') + '\n';
    files.push({ name: Comp + (ts ? '.tsx' : '.jsx'), lang: ts ? 'tsx' : 'jsx', code: code });
    // Asset and CSS imports need ambient declarations, or `tsc` rejects the component.
    if (ts) {
      const exts = {};
      ctx.assets.forEach(a => { const e = String(a.file).split('.').pop().toLowerCase(); if (e) exts[e] = 1; });
      // Original image-fill bytes keep their real format in the project ZIP.
      if (ctx.assets.some(a => a.imageHash)) ['jpg', 'gif', 'webp'].forEach(e => { exts[e] = 1; });
      const decl = ['css'].concat(Object.keys(exts).filter(e => e !== 'css').sort()).map(e =>
        e === 'css' ? "declare module '*.css';" : "declare module '*." + e + "' {\n  const src: string;\n  export default src;\n}");
      files.push({ name: 'assets.d.ts', lang: 'ts', code: '/* Ambient declarations for asset and stylesheet imports. */\n' + decl.join('\n') + '\n' });
    }
    const fcss = fontCss(ctx.fontPlan, true);
    if (mode === 'css') files.push({ name: Comp + '.css', lang: 'css', code: stylesheet(ctx, root.cls, unit, base, fcss) });
    else if (Object.keys(ctx.vars).length || fcss) files.push({ name: 'tokens.css', lang: 'css', code: (fcss ? fcss + '\n\n' : '') + (Object.keys(ctx.vars).length ? '/* Design tokens from Figma variables */\n' + varsBlock(ctx, unit, base) + '\n' : '') });
  }
  return {
    files: files,
    assets: ctx.assets.filter(a => !a.src && !a.svg).map(a => ({ id: a.id, file: a.file, format: a.format, scale: a.scale, imageHash: a.imageHash || '', cssOnly: !!a.cssOnly, illustration: a.illustration || '' })),
    fonts: fontPlan.families,
    fontFiles: opts.withFonts ? fontPlan.files : undefined,
    preview: { w: round(node.width), h: round(node.height), inlinedKB: Math.round(inlined / 1024) },
    truncated: ctx.truncated,
    depthLimited: !!ctx.depthLimited,
    assetErrors: ctx.assetErrors || [],
    stats: { layers: ctx.count, classes: ctx.order.length, assets: ctx.assets.length, tokens: Object.keys(ctx.vars).length, modes: Object.keys(ctx.themes).length, mapped: Object.keys(ctx.imports).reduce((n, p) => n + Object.keys(ctx.imports[p]).length, 0) }
  };
}
/**
 * Last-resort guard. Codegen must never throw into Figma's UI: a pathological
 * tree, a remote library outage or an unexpected API shape should produce a
 * readable explanation the user can act on, not a dead panel.
 */
async function generateCode(node, lang, unit, base, maxNodes, opts) {
  try {
    return await generateCodeInner(node, lang, unit, base, maxNodes, opts);
  } catch (e) {
    if (e === CANCEL) return { files: [], assets: [], fonts: [], cancelled: true, truncated: false, stats: {} };
    const msg = String((e && e.message) || e).slice(0, 300);
    return {
      files: [{ name: 'error.txt', lang: 'text', code: 'DevReady could not generate code for this layer.\n\n' + msg + '\n\nTry selecting a smaller frame, or a child frame of the design.' }],
      assets: [], fonts: [], fontFiles: undefined,
      preview: { w: round(node && node.width) || 0, h: round(node && node.height) || 0, inlinedKB: 0 },
      truncated: false, depthLimited: false, assetErrors: [msg],
      error: msg,
      stats: { layers: 0, classes: 0, assets: 0, tokens: 0, modes: 0, mapped: 0 }
    };
  }
}

/* ------------------------------------------------------------------ */
/* PRO: variable modes, change tracking, Code Connect, native tools    */
/* ------------------------------------------------------------------ */

/* ---------- variable modes ---------- */
const collCache = {};
/**
 * Collection lookup. Variables that come from a library live in a collection the
 * file does not own: `getVariableCollectionByIdAsync` resolves them in current
 * Figma builds but has returned null in older ones, which used to drop those
 * variables from the token export entirely. Fall back to the published list.
 */
async function getColl(id) {
  if (collCache[id] !== undefined) return collCache[id];
  let c = null;
  try { c = await figma.variables.getVariableCollectionByIdAsync(id); } catch (e) { /* not this build */ }
  if (!c) {
    try {
      const libs = await figma.variables.getAvailableLibraryVariableCollectionsAsync();
      const hit = (libs || []).filter(x => x && x.id === id)[0];
      if (hit) c = { id: hit.id, key: hit.key, name: hit.name, modes: hit.modes, defaultModeId: hit.defaultModeId, remote: true };
    } catch (e) { /* no libraries / older Figma */ }
  }
  collCache[id] = c;
  return c;
}
async function resolveVarValue(val, modeId, depth) {
  if (val && typeof val === 'object' && val.type === 'VARIABLE_ALIAS') {
    if (depth > 6) return { value: null, cycle: true };
    let v = null;
    try { v = await figma.variables.getVariableByIdAsync(val.id); } catch (e) { /* ignore */ }
    if (!v) return { value: null, remote: true };
    let mv = v.valuesByMode[modeId];
    if (mv === undefined) { const c = await getColl(v.variableCollectionId); mv = c ? v.valuesByMode[c.defaultModeId] : v.valuesByMode[Object.keys(v.valuesByMode)[0]]; }
    const inner = await resolveVarValue(mv, modeId, depth + 1);
    return { value: inner.value, alias: inner.alias || v.name, cycle: inner.cycle, remote: inner.remote };
  }
  return { value: val };
}
function varValueCss(value, type, unitHint) {
  if (value === null || value === undefined) return null;
  if (type === 'COLOR' && typeof value === 'object' && 'r' in value) {
    const a = value.a === undefined ? 1 : value.a;
    return a < 1 ? 'rgba(' + to255(value.r) + ', ' + to255(value.g) + ', ' + to255(value.b) + ', ' + round(a, 2) + ')' : colorHex(value);
  }
  if (type === 'FLOAT') return round(value, 2) + (unitHint || '');
  if (type === 'STRING') return String(value);
  if (type === 'BOOLEAN') return value ? 'true' : 'false';
  return String(value);
}
/** Full variable info incl. resolved value for every mode of its collection. */
async function varModes(id) {
  const base = await varInfo(id);
  if (!base) return null;
  if (base.modes) return base;
  base.id = id;
  try {
    const v = await figma.variables.getVariableByIdAsync(id);
    const c = await getColl(v.variableCollectionId);
    base.cssName = base.web && /var\((--[^),\s]+)/.test(base.web) ? /var\((--[^),\s]+)/.exec(base.web)[1] : '--' + v.name.replace(/\//g, '-').replace(/\s+/g, '-');
    base.modes = [];
    base.remote = !!(c && c.remote);
    if (c) {
      base.defaultModeId = c.defaultModeId;
      const modes = c.modes && c.modes.length ? c.modes : Object.keys(v.valuesByMode || {}).map((mid, i) => ({ modeId: mid, name: i ? 'Mode ' + (i + 1) : 'Default' }));
      base.defaultModeId = base.defaultModeId || (modes[0] && modes[0].modeId);
      for (const m of modes) {
        const r = await resolveVarValue(v.valuesByMode[m.modeId], m.modeId, 0);
        base.modes.push({
          id: m.modeId, name: m.name, isDefault: m.modeId === c.defaultModeId,
          value: r.value, alias: r.alias || '',
          color: v.resolvedType === 'COLOR' && r.value && typeof r.value === 'object' ? rgbaObj(r.value, r.value.a) : null,
          display: varValueCss(r.value, v.resolvedType, '')
        });
      }
    }
  } catch (e) { base.modes = []; diag('variable modes', e); }
  return base;
}
function collectVarIds(node, ctx) {
  const add = a => { if (a && a.id) ctx.varIds[a.id] = 1; };
  try {
    const bv = node.boundVariables || {};
    Object.keys(bv).forEach(k => { const v = bv[k]; if (Array.isArray(v)) v.forEach(add); else add(v); });
  } catch (e) { /* ignore */ }
  ['fills', 'strokes'].forEach(k => {
    try { if (k in node && !isMixed(node[k])) node[k].forEach(p => { if (p.boundVariables && p.boundVariables.color) add(p.boundVariables.color); }); } catch (e) { /* ignore */ }
  });
  try { if ('effects' in node) node.effects.forEach(e => { if (e.boundVariables) Object.keys(e.boundVariables).forEach(k => add(e.boundVariables[k])); }); } catch (e) { /* ignore */ }
}
const normVar = s => String(s).replace(/^--/, '').toLowerCase().replace(/[^a-z0-9]/g, '');
function themeSelector(collName, modeName, allModes) {
  if (allModes.some(m => /light|dark/i.test(m.name))) return '[data-theme="' + slug(modeName) + '"]';
  return '[data-' + slug(collName) + '="' + slug(modeName) + '"]';
}
/** Match CSS var names in ctx.vars to Figma variables and build per-mode theme blocks. */
async function resolveThemes(ctx) {
  ctx.themes = {};      // selector → { --var: value }
  ctx.tokenInfo = {};   // --var → { type, modes: { modeName: {r,g,b,a}|value }, defaultValue }
  const byNorm = {};
  Object.keys(ctx.vars).forEach(k => { byNorm[normVar(k)] = k; });
  for (const id of Object.keys(ctx.varIds)) {
    const info = await varModes(id);
    if (!info || !info.modes || !info.modes.length) continue;
    const cssVar = byNorm[normVar(info.cssName)] || byNorm[normVar(info.name)];
    if (!cssVar) continue;
    const hint = /px$/.test(ctx.vars[cssVar]) ? 'px' : '';
    const ti = { type: info.type, modes: {}, collection: info.collection };
    info.modes.forEach(m => {
      const css = varValueCss(m.value, info.type, hint);
      if (css === null) return;
      ti.modes[m.name] = m.color || m.value;
      if (m.isDefault) { ctx.vars[cssVar] = css; ti.defaultValue = m.color || m.value; }
      else {
        const sel = themeSelector(info.collection, m.name, info.modes);
        (ctx.themes[sel] = ctx.themes[sel] || {})[cssVar] = css;
      }
    });
    ctx.tokenInfo[cssVar] = ti;
  }
}

/* ---------- change tracking ("changed since ready") ---------- */
function hashStr(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }
function safeVal(v) { return isMixed(v) ? 'mixed' : v; }
/**
 * Values that Figma reports as `figma.mixed` used to collapse to the string
 * "mixed", so editing one corner radius, one stroke side or one text run was
 * invisible to change tracking. Each item is now hashed individually.
 */
function radiusSig(n) {
  if (!('cornerRadius' in n)) return 0;
  if (isMixed(n.cornerRadius)) {
    try { return [n.topLeftRadius, n.topRightRadius, n.bottomRightRadius, n.bottomLeftRadius].map(v => safeVal(v)).join('/'); } catch (e) { return 'mixed'; }
  }
  return safeVal(n.cornerRadius);
}
function strokeSig(n) {
  if (!('strokes' in n)) return 0;
  let weight;
  try {
    weight = isMixed(n.strokeWeight)
      ? [n.strokeTopWeight, n.strokeRightWeight, n.strokeBottomWeight, n.strokeLeftWeight].map(v => safeVal(v)).join('/')
      : safeVal(n.strokeWeight);
  } catch (e) { weight = 'mixed'; }
  return JSON.stringify([safeVal(n.strokes), weight, safeVal(n.strokeAlign), safeVal(n.strokeCap), safeVal(n.strokeJoin),
    Array.isArray(n.dashPattern) ? n.dashPattern.join(',') : safeVal(n.dashPattern)]);
}
/** Variable and style bindings: switching a hex to a variable of the same colour is a change. */
function bindSig(n) {
  let bv;
  try {
    const b = n.boundVariables || {};
    bv = Object.keys(b).sort().map(k => {
      const v = b[k], one = x => (x && x.id) ? x.id : '';
      return k + ':' + (Array.isArray(v) ? v.map(one).join('+') : one(v));
    }).join(',');
  } catch (e) { bv = ''; }
  const id = v => { try { return safeVal(v) || ''; } catch (e) { return ''; } };
  let modes;
  try { modes = JSON.stringify(n.explicitVariableModes || {}); } catch (e) { modes = ''; }
  return [bv, id(n.fillStyleId), id(n.strokeStyleId), id(n.effectStyleId), id(n.textStyleId), modes].join('|');
}
/** Per-run text styling: a single changed word is a change even if the node's own props don't move. */
function textSig(n) {
  let segs = '';
  try {
    if (n.getStyledTextSegments) {
      const list = n.getStyledTextSegments(['fontName', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'fills', 'textDecoration', 'textCase']);
      if (list) segs = list.map(x => JSON.stringify([x.characters, safeVal(x.fontName), safeVal(x.fontSize), safeVal(x.fontWeight), safeVal(x.lineHeight), safeVal(x.letterSpacing), x.fills, safeVal(x.textDecoration), safeVal(x.textCase)])).join('~');
    }
  } catch (e) { segs = 'unavailable'; }
  try {
    return n.characters + '|' + JSON.stringify([n.fontSize, n.fontName, n.lineHeight, n.letterSpacing, n.textAlignHorizontal, n.textAlignVertical, n.textAutoResize, n.paragraphSpacing, n.textTruncate].map(safeVal)) + '|' + segs;
  } catch (e) { return ''; }
}
function gridSig(n) {
  try { return n.layoutGrids ? JSON.stringify(n.layoutGrids) : ''; } catch (e) { return ''; }
}
function constraintSig(n) {
  const out = [];
  try { if (n.constraints) out.push(JSON.stringify(n.constraints)); } catch (e) { /* ignore */ }
  ['minWidth', 'maxWidth', 'minHeight', 'maxHeight', 'layoutSizingHorizontal', 'layoutSizingVertical', 'layoutPositioning', 'itemReverseZIndex', 'clipsContent', 'isMask', 'blendMode'].forEach(k => {
    try { if (k in n) out.push(k + '=' + safeVal(n[k])); } catch (e) { /* ignore */ }
  });
  return out.join(';');
}
function nodeSig(n) {
  const g = [round(n.x, 1), round(n.y, 1), round(n.width, 1), round(n.height, 1), n.rotation ? round(n.rotation, 1) : 0].join(',');
  let st = '';
  try {
    st = JSON.stringify([
      'fills' in n ? safeVal(n.fills) : 0, strokeSig(n),
      'effects' in n ? n.effects : 0, radiusSig(n), 'opacity' in n ? n.opacity : 1, n.visible,
      'layoutMode' in n ? [n.layoutMode, n.itemSpacing, n.counterAxisSpacing, n.paddingTop, n.paddingRight, n.paddingBottom, n.paddingLeft, n.primaryAxisAlignItems, n.counterAxisAlignItems, n.layoutWrap, n.gridRowCount, n.gridColumnCount] : 0
    ]);
  } catch (e) { /* ignore */ }
  let meta;
  try { meta = bindSig(n) + '#' + gridSig(n) + '#' + constraintSig(n); } catch (e) { meta = ''; }
  const tx = n.type === 'TEXT' ? textSig(n) : '';
  return [hashStr(g), hashStr(st + '#' + meta), tx ? hashStr(tx) : ''];
}
/* Compact, human-readable values stored next to the hashes so the Changes panel can
   show "before → after". Hashes stay the source of truth for *whether* something
   changed (they cover more than these values); values only explain *what*. Only
   non-default values are stored, to keep snapshots small. */
const VAL_LABELS = { pos: 'Position', size: 'Size', rot: 'Rotation', vis: 'Visible', op: 'Opacity', fill: 'Fill', stroke: 'Stroke', rad: 'Radius', fx: 'Effects', lay: 'Layout', pad: 'Padding', font: 'Font', align: 'Text align', text: 'Text' };
function paintVal(paints) {
  if (isMixed(paints)) return 'mixed';
  if (!Array.isArray(paints)) return '';
  const vis = paints.filter(p => p && p.visible !== false);
  if (!vis.length) return '';
  const one = p => p.type === 'SOLID' && p.color ? colorHex(p.color, p.opacity) : p.type === 'IMAGE' ? 'image' : p.type === 'VIDEO' ? 'video' : String(p.type || '').toLowerCase().replace(/_/g, ' ').replace('gradient ', '') + ' gradient';
  return vis.slice(0, 3).map(one).join(' + ') + (vis.length > 3 ? ' +' + (vis.length - 3) : '');
}
function nodeVals(n) {
  const v = {};
  const r1 = x => isMixed(x) ? 'mixed' : String(round(x, 1));
  try {
    v.pos = r1(n.x) + ', ' + r1(n.y);
    v.size = r1(n.width) + ' × ' + r1(n.height);
    if (n.rotation) v.rot = r1(n.rotation) + '°';
    if (n.visible === false) v.vis = 'hidden';
    if ('opacity' in n && n.opacity !== 1 && typeof n.opacity === 'number') v.op = Math.round(n.opacity * 100) + '%';
    if ('fills' in n && n.type !== 'TEXT') { const f = paintVal(n.fills); if (f) v.fill = f; }
    if ('strokes' in n) {
      const st = paintVal(n.strokes);
      // Per-side stroke weights are mixed: keep them readable instead of "mixed".
      let w = '';
      try {
        w = isMixed(n.strokeWeight)
          ? [n.strokeTopWeight, n.strokeRightWeight, n.strokeBottomWeight, n.strokeLeftWeight].map(r1).join(' ')
          : r1(n.strokeWeight);
      } catch (e) { w = 'mixed'; }
      if (st) v.stroke = st + (w ? ' · ' + w : '');
    }
    if ('cornerRadius' in n && (n.cornerRadius || isMixed(n.cornerRadius))) v.rad = isMixed(n.cornerRadius) ? [n.topLeftRadius, n.topRightRadius, n.bottomRightRadius, n.bottomLeftRadius].map(r1).join(' ') : r1(n.cornerRadius);
    if ('effects' in n && Array.isArray(n.effects)) {
      const e = n.effects.filter(x => x && x.visible !== false);
      if (e.length) {
        v.fx = e.map(x => {
          const kind = String(x.type).toLowerCase().replace(/_/g, ' ');
          const off = (x.offset && (x.offset.x || x.offset.y)) ? 'x' + r1(x.offset.x) + ' y' + r1(x.offset.y) : '';
          const geo = [x.radius ? r1(x.radius) : '', x.spread ? 'spread ' + r1(x.spread) : '', off].filter(Boolean).join(' ');
          return kind + (geo ? ' ' + geo : '');
        }).join(', ');
      }
    }
    if ('layoutMode' in n && n.layoutMode && n.layoutMode !== 'NONE') {
      v.lay = (n.layoutMode === 'VERTICAL' ? 'column' : n.layoutMode === 'GRID' ? 'grid' : 'row') + (n.layoutWrap === 'WRAP' ? ' wrap' : '') + ' · gap ' + (n.primaryAxisAlignItems === 'SPACE_BETWEEN' ? 'auto' : r1(n.itemSpacing)) + ' · ' + String(n.primaryAxisAlignItems || '').toLowerCase() + '/' + String(n.counterAxisAlignItems || '').toLowerCase();
      v.pad = [n.paddingTop, n.paddingRight, n.paddingBottom, n.paddingLeft].map(r1).join(' ');
    }
    if (n.type === 'TEXT') {
      const fnm = n.fontName;
      const lh = n.lineHeight;
      v.font = (isMixed(fnm) ? 'mixed' : fnm.family + ' ' + fnm.style) + ' · ' + r1(n.fontSize) + (lh && !isMixed(lh) && lh.unit && lh.unit !== 'AUTO' ? '/' + r1(lh.value) + (lh.unit === 'PERCENT' ? '%' : '') : '');
      const f = paintVal(n.fills); if (f) v.font += ' · ' + f;
      if (n.textAlignHorizontal && n.textAlignHorizontal !== 'LEFT') v.align = String(n.textAlignHorizontal).toLowerCase();
      const t = String(n.characters || '').replace(/\s+/g, ' ');
      v.text = t.length > 80 ? t.slice(0, 79) + '…' : t;
    }
  } catch (e) { return null; }
  return v;
}
function valDiff(a, b) {
  if (!a || !b) return [];
  const out = [];
  Object.keys(VAL_LABELS).forEach(k => {
    const x = a[k] === undefined ? '' : a[k], y = b[k] === undefined ? '' : b[k];
    if (x !== y) out.push({ prop: VAL_LABELS[k], before: x || (k === 'vis' ? 'visible' : '—'), after: y || (k === 'vis' ? 'visible' : '—') });
  });
  return out;
}
const SNAP_LIMIT = 2500;
/* A layer cap alone does not bound the snapshot: 2,500 layers with text, effects
   and fills serialise to ~1 MB, and shared plugin data is not free (Figma throttles
   and can reject oversized writes on large files). Stop at a byte budget too, and
   mark the snapshot partial so the panel never claims "no changes" for the layers
   it did not see. */
const SNAP_BYTES = 400000;
/* Figma caps each plugin-data entry at 100 kB (enforced since March 2025), so large
   values are split across "<key>:0..n" entries. 30k UTF-16 units is < 90 kB even
   when every unit needs 3 bytes of UTF-8. */
const CHUNK_UNITS = 30000;
function writeChunked(node, key, str) {
  const old = +node.getSharedPluginData(NS, key + ':n') || 0;
  const n = str ? Math.ceil(str.length / CHUNK_UNITS) : 0;
  for (let i = 0; i < n; i++) node.setSharedPluginData(NS, key + ':' + i, str.slice(i * CHUNK_UNITS, (i + 1) * CHUNK_UNITS));
  for (let i = n; i < old; i++) node.setSharedPluginData(NS, key + ':' + i, '');
  node.setSharedPluginData(NS, key + ':n', n ? String(n) : '');
  if (node.getSharedPluginData(NS, key)) node.setSharedPluginData(NS, key, ''); // legacy single entry
}
function readChunked(node, key) {
  const n = +node.getSharedPluginData(NS, key + ':n') || 0;
  if (!n) return node.getSharedPluginData(NS, key); // written by an older version
  let out = '';
  for (let i = 0; i < n; i++) out += node.getSharedPluginData(NS, key + ':' + i);
  return out;
}
function snapshot(root, limit, budget) {
  const map = {}; let count = 0; let size = 0;
  const cap = typeof budget === 'number' ? budget : SNAP_BYTES;
  let truncated = false;
  (function walk(n, depth) {
    if (truncated) return;
    if (count >= limit || size >= cap) { truncated = true; return; }
    if (depth > MAX_DEPTH) { truncated = true; return; }
    count++;
    const s = nodeSig(n);
    const v = nodeVals(n);
    const rec = v ? [String(n.name).slice(0, 40), s[0], s[1], s[2], v] : [String(n.name).slice(0, 40), s[0], s[1], s[2]];
    map[n.id] = rec;
    size += JSON.stringify(rec).length + 12; // + key, quotes and commas
    if ('children' in n) n.children.forEach(c => walk(c, depth + 1));
  })(root, 0);
  // Layers past any limit are unknown, so added/removed must not be claimed.
  if (truncated) map.__partial = 1;
  return map;
}
function saveBaseline(target) {
  const snap = snapshot(target, SNAP_LIMIT);
  writeChunked(target, 'baseline', JSON.stringify(snap));
  target.setSharedPluginData(NS, 'baselineAt', new Date().toISOString());
  diffCache[target.id] = null;
}
/* Removes every trace of a snapshot: all chunks, the chunk count and the timestamp. */
function clearBaseline(target) {
  writeChunked(target, 'baseline', '');
  target.setSharedPluginData(NS, 'baselineAt', '');
  diffCache[target.id] = null;
}
const diffCache = {};
function diffBaseline(target) {
  if (diffCache[target.id]) return diffCache[target.id];
  const raw = readChunked(target, 'baseline');
  if (!raw) return null;
  let base;
  try { base = JSON.parse(raw); } catch (e) { return null; }
  const now = snapshot(target, SNAP_LIMIT);
  const partial = !!(base.__partial || now.__partial);
  delete base.__partial; delete now.__partial;
  const changes = [];
  Object.keys(now).forEach(id => {
    const a = base[id], b = now[id];
    if (!a) { changes.push({ id: id, name: b[0], kind: 'added', parts: [] }); return; }
    const parts = [];
    if (a[1] !== b[1]) parts.push('size/position');
    if (a[2] !== b[2]) parts.push('style');
    if (a[3] !== b[3]) parts.push('text');
    if (a[0] !== b[0]) parts.push('renamed');
    if (!parts.length) return;
    const detail = valDiff(a[4], b[4]);
    if (a[0] !== b[0]) detail.unshift({ prop: 'Name', before: a[0], after: b[0] });
    changes.push({ id: id, name: b[0], kind: 'changed', parts: parts, detail: detail.slice(0, 8) });
  });
  // When a snapshot hit the layer cap, layers past it are unknown, not added/removed.
  if (partial) {
    for (let i = changes.length - 1; i >= 0; i--) { if (changes[i].kind !== 'changed') changes.splice(i, 1); }
  } else {
    Object.keys(base).forEach(id => { if (!now[id]) changes.push({ id: null, name: base[id][0], kind: 'removed', parts: [] }); });
  }
  const res = { at: target.getSharedPluginData(NS, 'baselineAt'), partial: partial, values: Object.keys(base).some(k => base[k] && base[k][4]), limit: SNAP_LIMIT, budget: SNAP_BYTES, count: changes.length, changes: changes.slice(0, 150), containerId: target.id, containerName: target.name };
  diffCache[target.id] = res;
  return res;
}

/* ---------- Code Connect-style component mapping ---------- */
function loadMappings() {
  const out = {};
  try {
    figma.root.getSharedPluginDataKeys(NS).filter(k => k.indexOf('map:') === 0).forEach(k => {
      try {
        // file data can be written by anyone who edits the file (or another plugin): re-validate
        const m = JSON.parse(figma.root.getSharedPluginData(NS, k));
        if (m && MAP_NAME_RE.test(m.name) && MAP_PATH_RE.test(m.path)) out[k.slice(4)] = { name: m.name, path: m.path, at: String(m.at || '') };
      } catch (e) { diag('component mappings', e); }
    });
  } catch (e) { /* ignore */ }
  return out;
}
const CHILD_PROP = /^(label|text|title|content|children|value|caption)$/i;
function mapProps(props) {
  const attrs = []; let children = null;
  (props || []).forEach(p => {
    const name = camel(p.name);
    if (p.type === 'VARIANT') { if (!/^(default)$/i.test(String(p.value))) attrs.push({ name: name, kind: 'str', value: camel(String(p.value)) }); }
    else if (p.type === 'BOOLEAN') { if (p.value === true || p.value === 'true') attrs.push({ name: name, kind: 'bool' }); }
    else if (p.type === 'TEXT') { if (CHILD_PROP.test(p.name.trim()) && children === null) children = String(p.value); else attrs.push({ name: name, kind: 'str', value: String(p.value) }); }
  });
  return { attrs: attrs, children: children };
}
function connectSnippet(map, props) {
  const mp = mapProps(props);
  const attrs = mp.attrs.map(a => a.kind === 'bool' ? ' ' + a.name : ' ' + a.name + '=' + jsxStr(a.value)).join('');
  const open = '<' + map.name + attrs;
  const body = mp.children !== null ? open + '>\n  ' + jsxTextNode(mp.children) + '\n</' + map.name + '>' : open + ' />';
  return "import { " + map.name + " } from " + jsQuote(map.path) + ";\n\n" + body;
}

/* ---------- layers (breadcrumb + children) ---------- */
function layersInfo(node) {
  const anc = [];
  let p = node.parent;
  while (p && p.type !== 'PAGE' && p.type !== 'DOCUMENT') { anc.unshift({ id: p.id, name: p.name, type: p.type }); p = p.parent; }
  const kids = 'children' in node ? node.children.slice(0, 80).map(c => ({ id: c.id, name: c.name, type: c.type, visible: c.visible !== false, kids: 'children' in c ? c.children.length : 0 })) : [];
  return { ancestors: anc.slice(-6), children: kids, more: 'children' in node && node.children.length > 80 ? node.children.length - 80 : 0 };
}

/* ---------- native Dev Mode measurements ---------- */
const MEASURABLE = { COMPONENT: 1, COMPONENT_SET: 1, ELLIPSE: 1, FRAME: 1, INSTANCE: 1, LINE: 1, POLYGON: 1, RECTANGLE: 1, STAR: 1, TEXT: 1, VECTOR: 1 };
function addNativeMeasurements(sel) {
  const page = figma.currentPage;
  if (!('addMeasurement' in page)) throw new Error('Measurements API not available here');
  let pairs = [];
  if (sel.length === 2) {
    const a = sel[0], b = sel[1], A = a.absoluteBoundingBox, B = b.absoluteBoundingBox;
    const inside = (o, i) => i.x >= o.x && i.y >= o.y && i.x + i.width <= o.x + o.width && i.y + i.height <= o.y + o.height;
    if (inside(A, B) || inside(B, A)) {
      const o = inside(A, B) ? a : b, i = o === a ? b : a;
      pairs = [['TOP', 'TOP'], ['BOTTOM', 'BOTTOM'], ['LEFT', 'LEFT'], ['RIGHT', 'RIGHT']].map(s => [o, s[0], i, s[1]]);
    } else {
      if (B.x >= A.x + A.width) pairs.push([a, 'RIGHT', b, 'LEFT']); else if (A.x >= B.x + B.width) pairs.push([b, 'RIGHT', a, 'LEFT']);
      if (B.y >= A.y + A.height) pairs.push([a, 'BOTTOM', b, 'TOP']); else if (A.y >= B.y + B.height) pairs.push([b, 'BOTTOM', a, 'TOP']);
    }
  } else if (sel.length === 1 && sel[0].parent && sel[0].parent.type !== 'PAGE' && sel[0].parent.type !== 'SECTION') {
    const n = sel[0], p = n.parent;
    pairs = [['TOP', 'TOP'], ['BOTTOM', 'BOTTOM'], ['LEFT', 'LEFT'], ['RIGHT', 'RIGHT']].map(s => [p, s[0], n, s[1]]);
  }
  let added = 0;
  for (const pr of pairs) {
    if (!MEASURABLE[pr[0].type] || !MEASURABLE[pr[2].type]) continue;
    try { page.addMeasurement({ node: pr[0], side: pr[1] }, { node: pr[2], side: pr[3] }); added++; } catch (e) { /* zero distance or unsupported */ }
  }
  return added;
}
function clearNativeMeasurements(sel) {
  const page = figma.currentPage;
  if (!('getMeasurementsForNode' in page)) return 0;
  const ids = {};
  sel.forEach(n => { try { page.getMeasurementsForNode(n).forEach(m => { ids[m.id] = 1; }); } catch (e) { /* ignore */ } });
  Object.keys(ids).forEach(id => { try { page.deleteMeasurement(id); } catch (e) { /* ignore */ } });
  return Object.keys(ids).length;
}

/* ================================================================== */
/* Native code: SwiftUI + Jetpack Compose (derived from the same tree) */
/* ================================================================== */
function npx(v) { if (v === undefined || v === null) return null; const m = /^(-?\d*\.?\d+)px/.exec(String(v).trim()); return m ? parseFloat(m[1]) : (String(v).trim() === '0' ? 0 : null); }
function parseColorStr(v, ctx) {
  if (!v) return null;
  let s = String(v).trim(), token = null;
  const vm = /^var\((--[\w-]+)\)$/.exec(s);
  if (vm) { token = vm[1]; s = ctx.vars[vm[1]] || ''; }
  let c = null, m;
  if ((m = /^#([0-9a-f]{3,8})$/i.exec(s))) {
    let h = m[1]; if (h.length === 3 || h.length === 4) h = h.split('').map(x => x + x).join('');
    c = { r: parseInt(h.slice(0, 2), 16) / 255, g: parseInt(h.slice(2, 4), 16) / 255, b: parseInt(h.slice(4, 6), 16) / 255, a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 };
  } else if ((m = /^rgba?\(([^)]+)\)$/i.exec(s))) {
    const p = m[1].split(/[\s,\/]+/).filter(Boolean).map(parseFloat);
    c = { r: p[0] / 255, g: p[1] / 255, b: p[2] / 255, a: p[3] === undefined ? 1 : p[3] };
  } else if (/^white$/i.test(s)) c = { r: 1, g: 1, b: 1, a: 1 };
  else if (/^black$/i.test(s)) c = { r: 0, g: 0, b: 0, a: 1 };
  if (!c) return null;
  c.token = token;
  return c;
}
function parsePad(css) {
  const p = css.padding ? css.padding.split(/\s+/).map(npx) : [0];
  let t = p[0], r = p.length > 1 ? p[1] : t, b = p.length > 2 ? p[2] : t, l = p.length > 3 ? p[3] : r;
  if (css['padding-top']) t = npx(css['padding-top']); if (css['padding-right']) r = npx(css['padding-right']);
  if (css['padding-bottom']) b = npx(css['padding-bottom']); if (css['padding-left']) l = npx(css['padding-left']);
  return [t || 0, r || 0, b || 0, l || 0];
}
function parseShadow(v, ctx) {
  if (!v) return null;
  const first = v.split(/,(?![^(]*\))/)[0].trim();
  if (/^inset/.test(first)) return null;
  const col = /(rgba?\([^)]*\)|#[0-9a-f]{3,8}|var\([^)]*\))/i.exec(first);
  const nums = first.replace(col ? col[0] : '', '').trim().split(/\s+/).map(npx);
  return { x: nums[0] || 0, y: nums[1] || 0, blur: nums[2] || 0, spread: nums[3] || 0, color: col ? parseColorStr(col[0], ctx) : null };
}
function nprops(el, parent, ctx) {
  const c = {}, P = {};
  Object.keys(el.css).forEach(k => { c[k] = /color|background|border|shadow/.test(k) ? el.css[k] : String(el.css[k]).replace(/var\((--[\w-]+)\)/g, (m, n) => ctx.vars[n] || m); });
  P.dir = c.display && /flex/.test(c.display) ? (c['flex-direction'] === 'column' ? 'col' : 'row') : (el.children.some(k => k.css.position === 'absolute') ? 'z' : 'col');
  const gp = c.gap ? c.gap.split(/\s+/) : [];
  P.gap = gp.length ? npx(gp[gp.length - 1]) || 0 : 0;
  P.justify = c['justify-content'] || 'flex-start';
  P.align = c['align-items'] || 'flex-start';
  P.pad = parsePad(c);
  P.w = c.width && c.width !== '100%' ? npx(c.width) : null;
  P.h = c.height && c.height !== '100%' ? npx(c.height) : null;
  const pdir = parent ? (parent.css['flex-direction'] === 'column' ? 'col' : 'row') : null;
  P.grow = /^1(\s|$)/.test(c.flex || '') || c['flex-grow'] === '1';
  P.fillW = c.width === '100%' || (c['align-self'] === 'stretch' && pdir === 'col') || (P.grow && pdir === 'row');
  P.fillH = c.height === '100%' || (c['align-self'] === 'stretch' && pdir === 'row') || (P.grow && pdir === 'col');
  if (P.fillW) P.w = null; if (P.fillH) P.h = null;
  P.bg = parseColorStr(c.background || c['background-color'], ctx);
  P.radius = c['border-radius'] ? npx(c['border-radius'].split(/\s+/)[0]) : 0;
  const bm = c.border ? /^(\d*\.?\d+)px\s+\w+\s+(.+)$/.exec(c.border) : null;
  P.border = bm ? { w: parseFloat(bm[1]), color: parseColorStr(bm[2], ctx) } : null;
  P.shadow = parseShadow(c['box-shadow'], ctx);
  P.opacity = c.opacity ? parseFloat(c.opacity) : 1;
  P.z = c['z-index'] !== undefined ? parseInt(c['z-index'], 10) || 0 : null;
  P.bgImage = el.bgImage || null;
  P.abs = c.position === 'absolute' ? { x: npx(c.left) || 0, y: npx(c.top) || 0 } : null;
  P.size = npx(c['font-size']) || 16;
  P.weight = parseInt(c['font-weight'] || '400', 10);
  P.color = parseColorStr(c.color, ctx);
  P.lh = npx(c['line-height']);
  P.ls = npx(c['letter-spacing']);
  P.talign = c['text-align'] || '';
  P.family = (c['font-family'] || ctx.rootFont || '').replace(/var\([^,]+,?\s*/, '').replace(/[)"']/g, '').split(',')[0].trim();
  return P;
}
const n2 = v => String(round(v, 2));
const tokenId = t => camel(String(t).replace(/^--/, ''));

/* ---------- SwiftUI ---------- */
const SW_WEIGHT = { 100: 'ultraLight', 200: 'thin', 300: 'light', 400: 'regular', 500: 'medium', 600: 'semibold', 700: 'bold', 800: 'heavy', 900: 'black' };
/* Unicode bidi controls are escaped so generated code can't hide "Trojan Source" text. */
const BIDI_RE = /[\u202A-\u202E\u2066-\u2069]/g;
/** Single-quoted JS string literal (for import paths). */
function jsQuote(s) { return "'" + String(s).replace(/[\\'\n\r\u2028\u2029]/g, c => c === '\n' ? '\\n' : c === '\r' ? '\\r' : '\\' + (c === '\u2028' ? 'u2028' : c === '\u2029' ? 'u2029' : c)) + "'"; }
function swStr(s) {
  return '"' + String(s).replace(/[\\"\u0000-\u001f\u007f\u202A-\u202E\u2066-\u2069]/g, c =>
    c === '\\' ? '\\\\' : c === '"' ? '\\"' : c === '\n' ? '\\n' : c === '\t' ? '\\t' : c === '\r' ? '\\r' : '\\u{' + c.charCodeAt(0).toString(16) + '}') + '"';
}
function swColor(c, ctx) {
  if (!c) return null;
  if (c.token && ctx.tokenUse) { ctx.tokenUse[c.token] = c; return 'Color.' + tokenId(c.token); }
  return 'Color(red: ' + n2(c.r) + ', green: ' + n2(c.g) + ', blue: ' + n2(c.b) + (c.a < 1 ? ', opacity: ' + n2(c.a) : '') + ')';
}
function swPadding(p) {
  const [t, r, b, l] = p;
  if (!t && !r && !b && !l) return [];
  if (t === r && r === b && b === l) return ['.padding(' + n2(t) + ')'];
  if (t === b && l === r) return ['.padding(.horizontal, ' + n2(l) + ')', '.padding(.vertical, ' + n2(t) + ')'];
  return ['.padding(EdgeInsets(top: ' + n2(t) + ', leading: ' + n2(l) + ', bottom: ' + n2(b) + ', trailing: ' + n2(r) + '))'];
}
function swFrame(P, align) {
  const parts = [];
  if (P.w !== null) parts.push('width: ' + n2(P.w));
  if (P.h !== null) parts.push('height: ' + n2(P.h));
  if (P.fillW) parts.push('maxWidth: .infinity');
  if (P.fillH) parts.push('maxHeight: .infinity');
  if (!parts.length) return [];
  if ((P.fillW || P.fillH) && align) parts.push('alignment: ' + align);
  return ['.frame(' + parts.join(', ') + ')'];
}
function swTextChunk(text, P, extra, ctx) {
  const s = 'Text(' + swStr(text) + ')';
  const mods = [];
  if (extra) {
    if (extra['font-weight']) mods.push('.fontWeight(.' + (SW_WEIGHT[parseInt(extra['font-weight'], 10)] || 'regular') + ')');
    if (extra.color) { const col = parseColorStr(extra.color, ctx); if (col) mods.push('.foregroundColor(' + swColor(col, ctx) + ')'); }
    if (extra['text-decoration'] === 'underline') mods.push('.underline()');
    if (extra['text-decoration'] === 'line-through') mods.push('.strikethrough()');
  }
  return s + mods.join('');
}
function swText(el, P, d, ctx, prop) {
  const pad = '    '.repeat(d);
  let head;
  if (prop) head = 'Text(' + prop + ')';
  else if (el.runs) head = '(' + el.runs.map(r => swTextChunk(r.text, P, r.css, ctx)).join(' + ') + ')';
  else head = 'Text(' + swStr(el.text) + ')';
  const mods = [];
  const font = P.family && !/^(sf pro|-apple|system)/i.test(P.family) ? '.custom(' + swStr(P.family) + ', size: ' + n2(P.size) + ')' : '.system(size: ' + n2(P.size) + ')';
  mods.push('.font(' + font + (P.weight !== 400 ? '.weight(.' + (SW_WEIGHT[P.weight] || 'regular') + ')' : '') + ')');
  if (P.color) mods.push('.foregroundStyle(' + swColor(P.color, ctx) + ')');
  if (P.ls) mods.push('.tracking(' + n2(P.ls) + ')');
  if (P.lh && P.lh > P.size * 1.25) mods.push('.lineSpacing(' + n2(P.lh - P.size * 1.2) + ')');
  if (P.talign === 'center') mods.push('.multilineTextAlignment(.center)');
  if (P.talign === 'right') mods.push('.multilineTextAlignment(.trailing)');
  mods.push.apply(mods, swFrame(P, P.talign === 'center' ? '.center' : '.leading'));
  if (P.z !== null) mods.push('.zIndex(' + n2(P.z) + ')');
  if (P.abs) mods.push('.offset(x: ' + n2(P.abs.x) + ', y: ' + n2(P.abs.y) + ')');
  return pad + head + mods.map(m => '\n' + pad + '    ' + m).join('');
}
function swNode(el, parent, d, ctx, inDef) {
  const pad = '    '.repeat(d);
  if (el.usage && !inDef) {
    return pad + el.usage.def.name + '(' + el.usage.values.map(v => v.name + ': ' + swStr(v.kind === 'img' ? v.file.replace(/\.\w+$/, '') : v.value)).join(', ') + ')';
  }
  const P = nprops(el, parent, ctx);
  if (el.kind === 'text') return swText(el, P, d, ctx, el.prop);
  if (el.kind === 'img') {
    const name = el.prop ? el.prop : swStr(el.asset.file.replace(/\.\w+$/, ''));
    const mods = ['.resizable()', '.scaledToFit()'].concat(swFrame(P, null));
    if (P.w === null && P.h === null && !P.fillW) mods.push('.frame(width: ' + n2(npx(el.css.width) || 24) + ', height: ' + n2(npx(el.css.height) || 24) + ')');
    if (!el.attrs.alt) mods.push('.accessibilityHidden(true)');
    if (P.z !== null) mods.push('.zIndex(' + n2(P.z) + ')');
    if (P.abs) mods.push('.offset(x: ' + n2(P.abs.x) + ', y: ' + n2(P.abs.y) + ')');
    return pad + 'Image(' + name + ')' + mods.map(m => '\n' + pad + '    ' + m).join('');
  }
  // container
  let open;
  if (P.dir === 'z') open = 'ZStack(alignment: .topLeading)';
  else if (P.dir === 'row') open = 'HStack(alignment: ' + ({ center: '.center', 'flex-end': '.bottom', baseline: '.firstTextBaseline' }[P.align] || '.top') + ', spacing: ' + n2(P.justify === 'space-between' ? 0 : P.gap) + ')';
  else open = 'VStack(alignment: ' + ({ center: '.center', 'flex-end': '.trailing' }[P.align] || '.leading') + ', spacing: ' + n2(P.justify === 'space-between' ? 0 : P.gap) + ')';
  const kd = el.tag === 'button' ? d + 2 : d + 1;
  let kids = el.children.map(c => swNode(c, el, kd, ctx, inDef));
  const sp = '    '.repeat(kd) + 'Spacer(minLength: 0)';
  if (P.dir !== 'z') {
    if (P.justify === 'space-between' && kids.length > 1) kids = kids.reduce((a, k, i) => i ? a.concat([sp, k]) : [k], []);
    else if (P.justify === 'center' && (P.w || P.h || P.fillW || P.fillH)) kids = [sp].concat(kids, [sp]);
    else if (P.justify === 'flex-end') kids = [sp].concat(kids);
  }
  const mods = [];
  mods.push.apply(mods, swPadding(P.pad));
  mods.push.apply(mods, swFrame(P, P.dir === 'row' ? '.leading' : '.topLeading'));
  if (P.bgImage) {
    mods.push('.background(Image(' + swStr(P.bgImage.asset.file.replace(/\.\w+$/, '')) + ').resizable().' + (P.bgImage.scaleMode === 'FIT' ? 'scaledToFit()' : 'scaledToFill()') + ')');
    if (!P.radius) mods.push('.clipped()');
  }
  if (P.bg) mods.push('.background(' + swColor(P.bg, ctx) + ')');
  if (P.radius) mods.push('.clipShape(RoundedRectangle(cornerRadius: ' + n2(P.radius) + '))');
  if (P.border && P.border.color) mods.push('.overlay(RoundedRectangle(cornerRadius: ' + n2(P.radius || 0) + ').stroke(' + swColor(P.border.color, ctx) + ', lineWidth: ' + n2(P.border.w) + '))');
  if (P.shadow && P.shadow.color) mods.push('.shadow(color: ' + swColor(P.shadow.color, ctx) + ', radius: ' + n2(P.shadow.blur / 2) + ', x: ' + n2(P.shadow.x) + ', y: ' + n2(P.shadow.y) + ')');
  if (P.opacity < 1) mods.push('.opacity(' + n2(P.opacity) + ')');
  if (P.z !== null) mods.push('.zIndex(' + n2(P.z) + ')');
  if (P.abs) mods.push('.offset(x: ' + n2(P.abs.x) + ', y: ' + n2(P.abs.y) + ')');
  if (!el.children.length && el.tag !== 'button') {
    // plain shape (track, divider, dot…): a colour view carries the modifiers
    return pad + 'Color.clear' + mods.map(m => '\n' + pad + '    ' + m).join('');
  }
  if (el.tag === 'button') {
    return pad + 'Button(action: {}) {\n' + pad + '    ' + open + ' {\n' + kids.join('\n') + '\n' + pad + '    }\n' + pad + '}' +
      '\n' + pad + '.buttonStyle(.plain)' + mods.map(m => '\n' + pad + m).join('');
  }
  return pad + open + ' {\n' + kids.join('\n') + '\n' + pad + '}' + mods.map(m => '\n' + pad + m).join('');
}
function generateSwift(root, defs, ctx, name) {
  ctx.tokenUse = {};
  const defCode = defs.map(def => {
    const props = def.props.map(p => '    let ' + p.name + ': String').join('\n');
    return 'struct ' + def.name + ': View {\n' + (props ? props + '\n\n' : '') + '    var body: some View {\n' + swNode(def.tpl, def.tpl.parent, 2, ctx, true) + '\n    }\n}';
  });
  const main = 'struct ' + name + ': View {\n    var body: some View {\n' + swNode(root, null, 2, ctx, false) + '\n    }\n}';
  let tokens = '';
  const used = Object.keys(ctx.tokenUse);
  if (used.length) {
    const dyn = used.some(t => ctx.tokenInfo[t] && Object.keys(ctx.tokenInfo[t].modes).some(m => /dark/i.test(m)));
    tokens = '\n\n// MARK: - Design tokens (from Figma variables)\nextension Color {\n' + used.map(t => {
      const ti = ctx.tokenInfo[t];
      const darkKey = ti ? Object.keys(ti.modes).find(m => /dark/i.test(m)) : null;
      const base = swColor(Object.assign({}, ctx.tokenUse[t], { token: null }), ctx);
      if (darkKey && ti.modes[darkKey] && typeof ti.modes[darkKey] === 'object') {
        const dk = ti.modes[darkKey];
        const lt = ti.defaultValue && typeof ti.defaultValue === 'object' ? ti.defaultValue : ctx.tokenUse[t];
        return '    static let ' + tokenId(t) + ' = Color(light: ' + swColor(Object.assign({}, lt, { token: null }), ctx) + ', dark: ' + swColor(Object.assign({}, dk, { token: null }), ctx) + ')';
      }
      return '    static let ' + tokenId(t) + ' = ' + base;
    }).join('\n') + '\n}' + (dyn ? '\n\nextension Color {\n    /// Light/dark aware color, mirroring Figma variable modes.\n    init(light: Color, dark: Color) {\n        self.init(UIColor { $0.userInterfaceStyle == .dark ? UIColor(dark) : UIColor(light) })\n    }\n}' : '');
  }
  const assets = ctx.assets.length ? '\n\n// Assets: add to Assets.xcassets → ' + ctx.assets.map(a => a.file.replace(/\.\w+$/, '')).join(', ') : '';
  return 'import SwiftUI\n\n' + defCode.concat([main]).join('\n\n') + '\n\n#Preview {\n    ' + name + '()\n}' + tokens + assets + '\n';
}

/* ---------- Jetpack Compose ---------- */
const KT_WEIGHT = { 100: 'Thin', 200: 'ExtraLight', 300: 'Light', 400: 'Normal', 500: 'Medium', 600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold', 900: 'Black' };
function ktStr(s) { return JSON.stringify(String(s)).replace(/\$/g, '\\$').replace(BIDI_RE, c => '\\u' + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')); }
function ktColor(c, ctx) {
  if (!c) return null;
  if (c.token && ctx.tokenUse) { ctx.tokenUse[c.token] = c; return 'AppColors.' + pascal(tokenId(c.token)); }
  const h = n => to255(n).toString(16).padStart(2, '0').toUpperCase();
  return 'Color(0x' + h(c.a === undefined ? 1 : c.a) + h(c.r) + h(c.g) + h(c.b) + ')';
}
const drawableName = f => f.replace(/\.\w+$/, '').replace(/[^a-z0-9]+/gi, '_').toLowerCase();
function ktLayoutMods(P, parentDir) {
  const m = [];
  if (P.grow && parentDir) m.push('weight(1f)');
  if (P.fillW && !(P.grow && parentDir === 'row')) m.push('fillMaxWidth()');
  if (P.fillH && !(P.grow && parentDir === 'col')) m.push('fillMaxHeight()');
  return m;
}
function ktModifier(P, parentDir, ctx, base, skipLayout) {
  const m = skipLayout ? [] : ktLayoutMods(P, parentDir);
  if (P.w !== null && P.h !== null && P.w === P.h) m.push('size(' + n2(P.w) + '.dp)');
  else { if (P.w !== null) m.push('width(' + n2(P.w) + '.dp)'); if (P.h !== null) m.push('height(' + n2(P.h) + '.dp)'); }
  if (P.abs) m.push('offset(x = ' + n2(P.abs.x) + '.dp, y = ' + n2(P.abs.y) + '.dp)');
  const shape = P.radius ? 'RoundedCornerShape(' + n2(P.radius) + '.dp)' : null;
  if (P.shadow) m.push('shadow(' + n2(Math.max(1, P.shadow.blur / 2)) + '.dp' + (shape ? ', ' + shape : '') + ')');
  if (shape && (P.bg || P.border || P.bgImage)) m.push('clip(' + shape + ')');
  if (P.bg) m.push('background(' + ktColor(P.bg, ctx) + ')');
  if (P.bgImage) {
    ctx.ktPaint = true;
    m.push('paint(painter = painterResource(R.drawable.' + drawableName(P.bgImage.asset.file) + '), contentScale = ContentScale.' + (P.bgImage.scaleMode === 'FIT' ? 'Fit' : 'Crop') + ')');
  }
  if (P.border && P.border.color) m.push('border(' + n2(P.border.w) + '.dp, ' + ktColor(P.border.color, ctx) + (shape ? ', ' + shape : '') + ')');
  const [t, r, b, l] = P.pad || [0, 0, 0, 0];
  if (t || r || b || l) {
    if (t === r && r === b && b === l) m.push('padding(' + n2(t) + '.dp)');
    else if (t === b && l === r) m.push('padding(horizontal = ' + n2(l) + '.dp, vertical = ' + n2(t) + '.dp)');
    else m.push('padding(start = ' + n2(l) + '.dp, top = ' + n2(t) + '.dp, end = ' + n2(r) + '.dp, bottom = ' + n2(b) + '.dp)');
  }
  if (P.opacity < 1) m.push('alpha(' + n2(P.opacity) + 'f)');
  if (P.z !== null) { ctx.ktZIndex = true; m.push('zIndex(' + n2(P.z) + 'f)'); }
  if (!m.length) return base === 'modifier' ? 'modifier' : null;
  return (base || 'Modifier') + m.map(x => '\n.' + x).join('');
}
function ktIndent(s, pad) { return s.split('\n').map((l, i) => i ? pad + l : l).join('\n'); }
function ktNode(el, parent, d, ctx, inDef, isRoot) {
  const pad = '    '.repeat(d);
  const parentDir = parent ? nprops(parent, null, ctx).dir : null;
  if (el.usage && !inDef) {
    const lm = ktLayoutMods(nprops(el, parent, ctx), parentDir === 'z' ? null : parentDir);
    const args = el.usage.values.map(v => v.name + ' = ' + (v.kind === 'img' ? 'R.drawable.' + drawableName(v.file) : ktStr(v.value)));
    if (lm.length) args.push('modifier = Modifier.' + lm.join('.'));
    return pad + el.usage.def.name + '(' + args.join(', ') + ')';
  }
  const P = nprops(el, parent, ctx);
  let mod = ktModifier(P, parentDir === 'z' ? null : parentDir, ctx, isRoot ? 'modifier' : null, isRoot && inDef);
  if (el.tag === 'button' && el.kind === 'box') { ctx.ktClickable = true; mod = (mod || 'Modifier') + '\n.clickable(role = Role.Button) { /* TODO: onClick */ }'; }
  const modArg = mod ? 'modifier = ' + ktIndent(mod, pad + '        ') : null;
  if (el.kind === 'text') {
    const args = [];
    if (el.prop) args.push('text = ' + el.prop);
    else if (el.runs) {
      ctx.ktAnnotated = true;
      args.push('text = buildAnnotatedString {\n' + el.runs.map(r => {
        if (!r.css) return pad + '        append(' + ktStr(r.text) + ')';
        const st = [];
        if (r.css['font-weight']) st.push('fontWeight = FontWeight.' + (KT_WEIGHT[parseInt(r.css['font-weight'], 10)] || 'Normal'));
        if (r.css.color) { const col = parseColorStr(r.css.color, ctx); if (col) st.push('color = ' + ktColor(col, ctx)); }
        if (r.css['text-decoration'] === 'underline') st.push('textDecoration = TextDecoration.Underline');
        return pad + '        withStyle(SpanStyle(' + st.join(', ') + ')) { append(' + ktStr(r.text) + ') }';
      }).join('\n') + '\n' + pad + '    }');
    } else args.push('text = ' + ktStr(el.text));
    if (modArg) args.push(modArg);
    args.push('fontSize = ' + n2(P.size) + '.sp');
    if (P.weight !== 400) args.push('fontWeight = FontWeight.' + (KT_WEIGHT[P.weight] || 'Normal'));
    if (P.color) args.push('color = ' + ktColor(P.color, ctx));
    if (P.lh) args.push('lineHeight = ' + n2(P.lh) + '.sp');
    if (P.ls) args.push('letterSpacing = ' + n2(P.ls) + '.sp');
    if (P.talign === 'center') args.push('textAlign = TextAlign.Center');
    if (P.talign === 'right') args.push('textAlign = TextAlign.End');
    return pad + 'Text(\n' + args.map(a => pad + '    ' + a).join(',\n') + ',\n' + pad + ')';
  }
  if (el.kind === 'img') {
    const args = ['painter = painterResource(' + (el.prop || 'R.drawable.' + drawableName(el.asset.file)) + ')', 'contentDescription = ' + (el.attrs.alt ? ktStr(el.attrs.alt) : 'null')];
    if (modArg) args.push(modArg);
    return pad + 'Image(\n' + args.map(a => pad + '    ' + a).join(',\n') + ',\n' + pad + ')';
  }
  const args = [];
  if (modArg) args.push(modArg);
  if (P.dir === 'row') {
    if (P.justify === 'space-between') args.push('horizontalArrangement = Arrangement.SpaceBetween');
    else if (P.gap || P.justify !== 'flex-start') args.push('horizontalArrangement = Arrangement.spacedBy(' + n2(P.gap) + '.dp' + ({ center: ', Alignment.CenterHorizontally', 'flex-end': ', Alignment.End' }[P.justify] || '') + ')');
    if (P.align !== 'flex-start') args.push('verticalAlignment = Alignment.' + ({ center: 'CenterVertically', 'flex-end': 'Bottom' }[P.align] || 'Top'));
  } else if (P.dir === 'col') {
    if (P.justify === 'space-between') args.push('verticalArrangement = Arrangement.SpaceBetween');
    else if (P.gap || P.justify !== 'flex-start') args.push('verticalArrangement = Arrangement.spacedBy(' + n2(P.gap) + '.dp' + ({ center: ', Alignment.CenterVertically', 'flex-end': ', Alignment.Bottom' }[P.justify] || '') + ')');
    if (P.align !== 'flex-start') args.push('horizontalAlignment = Alignment.' + ({ center: 'CenterHorizontally', 'flex-end': 'End' }[P.align] || 'Start'));
  }
  const comp = P.dir === 'row' ? 'Row' : P.dir === 'z' ? 'Box' : 'Column';
  const kids = el.children.map(c => ktNode(c, el, d + 1, ctx, inDef, false)).join('\n');
  const argStr = '(' + (args.length ? '\n' + args.map(a => pad + '    ' + a).join(',\n') + ',\n' + pad : '') + ')';
  const call = !el.children.length ? pad + 'Box' + argStr : pad + comp + argStr + ' {\n' + kids + '\n' + pad + '}';
  return call;
}
function generateCompose(root, defs, ctx, name) {
  ctx.tokenUse = {};
  const defCode = defs.map(def => {
    const params = def.props.map(p => p.name + ': ' + (p.kind === 'img' ? 'Int' : 'String')).concat(['modifier: Modifier = Modifier']).join(', ');
    return '@Composable\nfun ' + def.name + '(' + params + ') {\n' + ktNode(def.tpl, def.tpl.parent, 1, ctx, true, true) + '\n}';
  });
  const main = '@Composable\nfun ' + name + '(modifier: Modifier = Modifier) {\n' + ktNode(root, null, 1, ctx, false, true) + '\n}';
  const used = Object.keys(ctx.tokenUse);
  let tokens = '';
  if (used.length) {
    tokens = '\n\n// Design tokens (from Figma variables)\nobject AppColors {\n' + used.map(t => '    val ' + pascal(tokenId(t)) + ' = ' + ktColor(Object.assign({}, ctx.tokenUse[t], { token: null }), ctx)).join('\n') + '\n}';
    const dark = used.filter(t => ctx.tokenInfo[t] && Object.keys(ctx.tokenInfo[t].modes).some(m => /dark/i.test(m)));
    if (dark.length) tokens += '\n\nobject AppColorsDark {\n' + dark.map(t => { const ti = ctx.tokenInfo[t]; const dk = ti.modes[Object.keys(ti.modes).find(m => /dark/i.test(m))]; return '    val ' + pascal(tokenId(t)) + ' = ' + (typeof dk === 'object' ? ktColor(Object.assign({}, dk, { token: null }), ctx) : ktColor(Object.assign({}, ctx.tokenUse[t], { token: null }), ctx)); }).join('\n') + '\n}';
  }
  const imports = [
    'androidx.compose.foundation.Image', 'androidx.compose.foundation.background', 'androidx.compose.foundation.border',
    ctx.ktClickable ? 'androidx.compose.foundation.clickable' : null, 'androidx.compose.foundation.layout.*',
    'androidx.compose.foundation.shape.RoundedCornerShape', 'androidx.compose.material3.Text', 'androidx.compose.runtime.Composable',
    'androidx.compose.ui.Alignment', 'androidx.compose.ui.Modifier', 'androidx.compose.ui.draw.alpha', 'androidx.compose.ui.draw.clip',
    ctx.ktPaint ? 'androidx.compose.ui.draw.paint' : null, ctx.ktZIndex ? 'androidx.compose.ui.zIndex' : null,
    'androidx.compose.ui.draw.shadow', 'androidx.compose.ui.graphics.Color', ctx.ktPaint ? 'androidx.compose.ui.layout.ContentScale' : null, 'androidx.compose.ui.res.painterResource', ctx.ktClickable ? 'androidx.compose.ui.semantics.Role' : null,
    ctx.ktAnnotated ? 'androidx.compose.ui.text.SpanStyle' : null, ctx.ktAnnotated ? 'androidx.compose.ui.text.buildAnnotatedString' : null,
    ctx.ktAnnotated ? 'androidx.compose.ui.text.withStyle' : null, ctx.ktAnnotated ? 'androidx.compose.ui.text.style.TextDecoration' : null,
    'androidx.compose.ui.text.font.FontWeight', 'androidx.compose.ui.text.style.TextAlign', 'androidx.compose.ui.tooling.preview.Preview',
    'androidx.compose.ui.unit.dp', 'androidx.compose.ui.unit.sp'
  ].filter(Boolean).map(i => 'import ' + i).join('\n');
  const assets = ctx.assets.length ? '\n\n// Drawables: import into res/drawable (SVG → Vector Asset): ' + ctx.assets.map(a => drawableName(a.file)).join(', ') : '';
  return imports + '\n\n' + defCode.concat([main]).join('\n\n') + '\n\n@Preview(showBackground = true)\n@Composable\nprivate fun ' + name + 'Preview() {\n    ' + name + '()\n}' + tokens + assets + '\n';
}

/* ---------- React Native ---------- */
function rnStr(s) {
  return JSON.stringify(String(s)).replace(/[\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, c => '\\u' + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0'));
}
function rnRawColor(c) {
  const a = c.a === undefined ? 1 : c.a;
  if (a < 1) return "'rgba(" + to255(c.r) + ', ' + to255(c.g) + ', ' + to255(c.b) + ', ' + n2(a) + ")'";
  return "'#" + hex2(c.r) + hex2(c.g) + hex2(c.b) + "'";
}
function rnColor(c, ctx) {
  if (!c) return null;
  if (c.token && ctx.tokenUse) { ctx.tokenUse[c.token] = c; return 'colors.' + tokenId(c.token); }
  return rnRawColor(c);
}
const rnQ = s => "'" + s + "'";
function rnStyleRef(ctx, el, pairs) {
  if (!pairs.length) return null;
  const reg = ctx.rnStyles = ctx.rnStyles || { byBody: {}, names: {}, order: [] };
  const body = pairs.map(p => p[0] + ': ' + p[1]).join(', ');
  if (reg.byBody[body]) return 'styles.' + reg.byBody[body];
  const base = camel(el.cls || el.base || 'node').replace(/[^A-Za-z0-9_]/g, '_');
  let name = base, i = 1;
  while (reg.names[name]) name = base + (++i);
  reg.names[name] = 1; reg.byBody[body] = name; reg.order.push({ name: name, pairs: pairs });
  return 'styles.' + name;
}
function rnLayoutPairs(P, parentDir, s) {
  if (parentDir) {
    const mainFill = parentDir === 'row' ? P.fillW : P.fillH, crossFill = parentDir === 'row' ? P.fillH : P.fillW;
    if (P.grow || mainFill) s.push(['flex', '1']);
    if (crossFill) s.push(['alignSelf', rnQ('stretch')]);
  } else {
    if (P.fillW) s.push(['width', rnQ('100%')]);
    if (P.fillH) s.push(['height', rnQ('100%')]);
  }
}
function rnBoxPairs(el, P, parentDir, ctx) {
  const s = [];
  if (el.children.length && P.dir !== 'z') {
    if (P.dir === 'row') s.push(['flexDirection', rnQ('row')]);
    const jc = { center: 'center', 'flex-end': 'flex-end', 'space-between': 'space-between' }[P.justify];
    if (jc) s.push(['justifyContent', rnQ(jc)]);
    s.push(['alignItems', rnQ({ center: 'center', 'flex-end': 'flex-end', baseline: 'baseline', stretch: 'stretch' }[P.align] || 'flex-start')]);
    if (P.gap && P.justify !== 'space-between') s.push(['gap', n2(P.gap)]);
  }
  const [t, r, b, l] = P.pad;
  if (t || r || b || l) {
    if (t === r && r === b && b === l) s.push(['padding', n2(t)]);
    else if (t === b && l === r) { if (l) s.push(['paddingHorizontal', n2(l)]); if (t) s.push(['paddingVertical', n2(t)]); }
    else { if (t) s.push(['paddingTop', n2(t)]); if (r) s.push(['paddingRight', n2(r)]); if (b) s.push(['paddingBottom', n2(b)]); if (l) s.push(['paddingLeft', n2(l)]); }
  }
  if (P.w !== null) s.push(['width', n2(P.w)]);
  if (P.h !== null) s.push(['height', n2(P.h)]);
  rnLayoutPairs(P, parentDir, s);
  if (P.bg) s.push(['backgroundColor', rnColor(P.bg, ctx)]);
  if (P.radius) s.push(['borderRadius', n2(P.radius)]);
  if (P.border && P.border.color) { s.push(['borderWidth', n2(P.border.w)]); s.push(['borderColor', rnColor(P.border.color, ctx)]); }
  if (el.css.overflow === 'hidden' || (el.bgImage && P.radius)) s.push(['overflow', rnQ('hidden')]);
  if (P.shadow && P.shadow.color) {
    const sc = P.shadow.color;
    s.push(['shadowColor', rnColor(Object.assign({}, sc, { a: 1, token: null }), ctx)]);
    s.push(['shadowOffset', '{ width: ' + n2(P.shadow.x) + ', height: ' + n2(P.shadow.y) + ' }']);
    s.push(['shadowOpacity', n2(sc.a === undefined ? 1 : sc.a)]);
    s.push(['shadowRadius', n2(P.shadow.blur / 2)]);
    s.push(['elevation', n2(Math.max(1, Math.round(P.shadow.blur / 2)))]);
  }
  if (P.opacity < 1) s.push(['opacity', n2(P.opacity)]);
  if (P.z !== null) s.push(['zIndex', String(P.z)]);
  if (P.abs) { s.push(['position', rnQ('absolute')]); s.push(['left', n2(P.abs.x)]); s.push(['top', n2(P.abs.y)]); }
  return s;
}
function rnTextPairs(el, P, parentDir, ctx) {
  const s = [];
  if (P.family && !SYSTEM_FONTS.sans.test(P.family) && !SYSTEM_FONTS.serif.test(P.family) && !SYSTEM_FONTS.mono.test(P.family)) s.push(['fontFamily', rnStr(P.family).replace(/^"|"$/g, "'")]);
  s.push(['fontSize', n2(P.size)]);
  if (P.weight !== 400) s.push(['fontWeight', rnQ(String(P.weight))]);
  if (el.css['font-style'] === 'italic') s.push(['fontStyle', rnQ('italic')]);
  if (P.color) s.push(['color', rnColor(P.color, ctx)]);
  if (P.lh) s.push(['lineHeight', n2(P.lh)]);
  if (P.ls) s.push(['letterSpacing', n2(P.ls)]);
  if (P.talign === 'center' || P.talign === 'right') s.push(['textAlign', rnQ(P.talign)]);
  if (P.w !== null) s.push(['width', n2(P.w)]);
  rnLayoutPairs(P, parentDir, s);
  if (P.opacity < 1) s.push(['opacity', n2(P.opacity)]);
  if (P.z !== null) s.push(['zIndex', String(P.z)]);
  if (P.abs) { s.push(['position', rnQ('absolute')]); s.push(['left', n2(P.abs.x)]); s.push(['top', n2(P.abs.y)]); }
  return s;
}
function rnRunStyle(css, ctx) {
  const p = [];
  if (css['font-weight']) p.push('fontWeight: ' + rnQ(String(parseInt(css['font-weight'], 10) || 400)));
  if (css['font-style'] === 'italic') p.push("fontStyle: 'italic'");
  if (css.color) { const col = parseColorStr(css.color, ctx); if (col) p.push('color: ' + rnColor(col, ctx)); }
  if (css['text-decoration'] === 'underline') p.push("textDecorationLine: 'underline'");
  if (css['text-decoration'] === 'line-through') p.push("textDecorationLine: 'line-through'");
  return p;
}
function rnNode(el, parent, d, ctx, inDef) {
  const pad = '  '.repeat(d);
  const use = n => { ctx.rnUse[n] = 1; return n; };
  if (el.usage && !inDef) {
    const props = el.usage.values.map(v => ' ' + v.name + '={' + (v.kind === 'img' ? v.value : rnStr(v.value)) + '}').join('');
    return pad + '<' + el.usage.def.name + props + ' />';
  }
  const P = nprops(el, parent, ctx);
  const pdRaw = parent ? nprops(parent, null, ctx).dir : null;
  const pd = pdRaw === 'z' ? null : pdRaw;
  if (el.kind === 'text') {
    const ref = rnStyleRef(ctx, el, rnTextPairs(el, P, pd, ctx));
    let inner;
    if (el.prop) inner = '{' + el.prop + '}';
    else if (el.runs) {inner = el.runs.map(r => {
      const st = r.css ? rnRunStyle(r.css, ctx) : [];
      return st.length ? '<Text style={{ ' + st.join(', ') + ' }}>{' + rnStr(r.text) + '}</Text>' : '{' + rnStr(r.text) + '}';
    }).join('');}
    else inner = '{' + rnStr(el.text) + '}';
    return pad + '<' + use('Text') + (ref ? ' style={' + ref + '}' : '') + '>' + inner + '</Text>';
  }
  if (el.kind === 'img') {
    const w = npx(el.css.width) || 24, h = npx(el.css.height) || 24;
    const isSvg = el.asset.format === 'SVG';
    const pairs = [];
    rnLayoutPairs(P, pd, pairs);
    if (P.z !== null) pairs.push(['zIndex', String(P.z)]);
    if (P.abs) { pairs.push(['position', rnQ('absolute')]); pairs.push(['left', n2(P.abs.x)]); pairs.push(['top', n2(P.abs.y)]); }
    const a11y = el.attrs.alt ? ' accessibilityLabel={' + rnStr(el.attrs.alt) + '}' : ' accessible={false}';
    if (isSvg) {
      const comp = el.prop ? pascal(el.prop) : pascal(el.asset.varName);
      const ref = rnStyleRef(ctx, el, pairs);
      return pad + '<' + comp + ' width={' + n2(w) + '} height={' + n2(h) + '}' + (ref ? ' style={' + ref + '}' : '') + a11y + ' />';
    }
    const ref = rnStyleRef(ctx, el, [['width', n2(w)], ['height', n2(h)]].concat(pairs));
    return pad + '<' + use('Image') + ' source={' + (el.prop || el.asset.varName) + '} style={' + ref + '} resizeMode="contain"' + a11y + ' />';
  }
  const btn = el.tag === 'button';
  const comp = use(btn ? 'Pressable' : 'View');
  const ref = rnStyleRef(ctx, el, rnBoxPairs(el, P, pd, ctx));
  const attrs = (ref ? ' style={' + ref + '}' : '') + (btn ? ' accessibilityRole="button" onPress={() => {}}' : '');
  let bgCode = '';
  if (el.bgImage) {
    use('Image');
    const bgPairs = [['position', rnQ('absolute')], ['left', '0'], ['top', '0'], ['right', '0'], ['bottom', '0']];
    if (P.radius) bgPairs.push(['borderRadius', n2(P.radius)]);
    const bgRef = rnStyleRef(ctx, el, bgPairs);
    bgCode = pad + '  <Image source={' + el.bgImage.asset.varName + '} style={' + bgRef + '} resizeMode="' + (el.bgImage.scaleMode === 'FIT' ? 'contain' : 'cover') + '" accessible={false} />';
  }
  if (!el.children.length && !bgCode) return pad + '<' + comp + attrs + ' />';
  const content = [bgCode].concat(el.children.map(c => rnNode(c, el, d + 1, ctx, inDef))).filter(Boolean).join('\n');
  return pad + '<' + comp + attrs + '>\n' + content + '\n' + pad + '</' + comp + '>';
}
function generateRN(root, defs, ctx, name) {
  ctx.tokenUse = {}; ctx.rnUse = {}; ctx.rnStyles = null;
  const defCode = defs.map(def => {
    const leafs = leaves(def.tpl, []);
    const args = def.props.length ? '{ ' + def.props.map(p => p.kind === 'img' && leafs[p.idx].asset.format === 'SVG' ? p.name + ': ' + pascal(p.name) : p.name).join(', ') + ' }' : '';
    return 'function ' + def.name + '(' + args + ') {\n  return (\n' + rnNode(def.tpl, def.tpl.parent, 2, ctx, true) + '\n  );\n}';
  });
  const main = 'export default function ' + name + '() {\n  return (\n' + rnNode(root, null, 2, ctx, false) + '\n  );\n}';
  const reg = ctx.rnStyles || { order: [] };
  const styles = 'const styles = StyleSheet.create({\n' + reg.order.map(o => '  ' + o.name + ': {\n' + o.pairs.map(p => '    ' + p[0] + ': ' + p[1] + ',').join('\n') + '\n  },').join('\n') + '\n});';
  const comps = ['View', 'Text', 'Image', 'Pressable'].filter(c => ctx.rnUse[c]).concat(['StyleSheet']);
  const imports = ["import { " + comps.join(', ') + " } from 'react-native';"];
  let hasSvg = false;
  ctx.assets.forEach(a => {
    if (a.format === 'SVG') { hasSvg = true; imports.push('import ' + pascal(a.varName) + " from './assets/" + a.file + "';"); }
    else imports.push('import ' + a.varName + " from './assets/" + a.file + "';");
  });
  const used = Object.keys(ctx.tokenUse);
  let colors = '';
  if (used.length) {
    colors = '// Design tokens (from Figma variables)\nconst colors = {\n' + used.map(t => '  ' + tokenId(t) + ': ' + rnRawColor(ctx.tokenUse[t]) + ',').join('\n') + '\n};\n\n';
    const dark = used.filter(t => ctx.tokenInfo[t] && Object.keys(ctx.tokenInfo[t].modes).some(m => /dark/i.test(m)));
    if (dark.length) {colors += '// Dark mode values: pick colors / colorsDark with useColorScheme()\nconst colorsDark = {\n' + dark.map(t => {
      const ti = ctx.tokenInfo[t], dk = ti.modes[Object.keys(ti.modes).find(m => /dark/i.test(m))];
      return '  ' + tokenId(t) + ': ' + rnRawColor(typeof dk === 'object' ? dk : ctx.tokenUse[t]) + ',';
    }).join('\n') + '\n};\n\n';}
  }
  const note = hasSvg ? '// SVG assets use react-native-svg + react-native-svg-transformer (or export them as PNG).\n' : '';
  return imports.join('\n') + '\n' + note + '\n' + colors + defCode.concat([main]).join('\n\n') + '\n\n' + styles + '\n';
}

/* ---------- Flutter (Dart) ---------- */
function dtStr(s) {
  return "'" + String(s).replace(/[\\'$\u0000-\u001f\u007f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, c =>
    c === '\\' ? '\\\\' : c === "'" ? "\\'" : c === '$' ? '\\$' : c === '\n' ? '\\n' : c === '\r' ? '\\r' : c === '\t' ? '\\t' : '\\u{' + c.charCodeAt(0).toString(16) + '}') + "'";
}
function dtRawColor(c) {
  const h = v => to255(v).toString(16).padStart(2, '0').toUpperCase();
  return 'Color(0x' + h(c.a === undefined ? 1 : c.a) + h(c.r) + h(c.g) + h(c.b) + ')';
}
function dtColor(c, ctx) {
  if (!c) return null;
  if (c.token && ctx.tokenUse) { ctx.tokenUse[c.token] = c; return 'AppColors.' + tokenId(c.token); }
  return dtRawColor(c);
}
/** Widget call. Args are 'key: value' strings; the widget "starts" at depth d (first line unindented). */
function dtCall(name, args, d) {
  const pad = '  '.repeat(d);
  return name + '(\n' + args.map(a => pad + '  ' + a + ',').join('\n') + '\n' + pad + ')';
}
function dtList(items, d) {
  // items are widgets started at depth d + 2 (list lives in an argument line at depth d + 1)
  const pad = '  '.repeat(d + 1);
  return '[\n' + items.map(i => pad + '  ' + i + ',').join('\n') + '\n' + pad + ']';
}
function dtTextStyle(P, el, ctx, css) {
  const a = [];
  const c = css || el.css;
  if (!css && P.family && !SYSTEM_FONTS.sans.test(P.family) && !SYSTEM_FONTS.serif.test(P.family) && !SYSTEM_FONTS.mono.test(P.family)) a.push('fontFamily: ' + dtStr(P.family));
  if (!css) a.push('fontSize: ' + n2(P.size));
  const w = css ? parseInt(css['font-weight'], 10) : P.weight;
  if (w && (css || w !== 400)) a.push('fontWeight: FontWeight.w' + (Math.round(w / 100) * 100 || 400));
  if (c['font-style'] === 'italic') a.push('fontStyle: FontStyle.italic');
  const col = css ? (css.color ? parseColorStr(css.color, ctx) : null) : P.color;
  if (col) a.push('color: ' + dtColor(col, ctx));
  if (!css && P.lh && P.size) a.push('height: ' + n2(P.lh / P.size));
  if (!css && P.ls) a.push('letterSpacing: ' + n2(P.ls));
  if (c['text-decoration'] === 'underline') a.push('decoration: TextDecoration.underline');
  if (c['text-decoration'] === 'line-through') a.push('decoration: TextDecoration.lineThrough');
  return a.length ? 'TextStyle(' + a.join(', ') + ')' : null;
}
const DT_MAIN = { 'flex-start': 'start', center: 'center', 'flex-end': 'end', 'space-between': 'spaceBetween' };
const DT_CROSS = { 'flex-start': 'start', center: 'center', 'flex-end': 'end', stretch: 'stretch' };
function dtNode(el, parent, d, ctx, inDef) {
  const P = nprops(el, parent, ctx);
  const pdRaw = parent ? nprops(parent, null, ctx).dir : null;
  const pd = pdRaw === 'z' ? null : pdRaw;
  if (el.usage && !inDef) {
    return dtCall(el.usage.def.name, el.usage.values.map(v => v.name + ': ' + dtStr(v.kind === 'img' ? 'assets/' + v.file : v.value)), d);
  }
  // wrappers, outermost first
  const wraps = [];
  if (P.abs) wraps.push({ name: 'Positioned', args: ['left: ' + n2(P.abs.x), 'top: ' + n2(P.abs.y)] });
  else if (pd) {
    const mainFill = pd === 'row' ? P.fillW : P.fillH;
    if (P.grow || mainFill) wraps.push({ name: 'Expanded', args: [] });
  }
  if (P.opacity < 1) wraps.push({ name: 'Opacity', args: ['opacity: ' + n2(P.opacity)] });
  if (el.tag === 'button' && el.kind === 'box') { ctx.dtInk = true; wraps.push({ name: 'InkWell', args: ['onTap: () {} /* TODO: onTap */'] }); }
  const inner = d + wraps.length;
  const crossW = pd === 'col' && P.fillW || (!pd && P.fillW), crossH = pd === 'row' && P.fillH || (!pd && P.fillH);
  let w;
  if (el.kind === 'text') {
    const sized = P.w !== null && !P.abs;
    const td = sized ? inner + 1 : inner;
    const style = dtTextStyle(P, el, ctx);
    const args = [];
    let head;
    if (el.runs && !el.prop) {
      const spans = el.runs.map(r => {
        const st = r.css ? dtTextStyle(P, el, ctx, r.css) : null;
        return 'TextSpan(text: ' + dtStr(r.text) + (st ? ', style: ' + st : '') + ')';
      });
      args.push('TextSpan(children: [' + spans.join(', ') + '])');
      head = 'Text.rich';
    } else if (!el.prop) { args.push(dtStr(el.text)); head = 'Text'; }
    else { args.push(el.prop); head = 'Text'; }
    if (style) args.push('style: ' + style);
    if (P.talign === 'center') args.push('textAlign: TextAlign.center');
    if (P.talign === 'right') args.push('textAlign: TextAlign.right');
    w = dtCall(head, args, td);
    if (sized) w = dtCall('SizedBox', ['width: ' + n2(P.w), 'child: ' + w], inner);
  } else if (el.kind === 'img') {
    const iw = npx(el.css.width) || 24, ih = npx(el.css.height) || 24;
    const path = el.prop || dtStr('assets/' + el.asset.file);
    const svg = el.asset.format === 'SVG';
    if (svg) ctx.dtSvg = true;
    const args = [path, 'width: ' + n2(iw), 'height: ' + n2(ih)];
    if (!svg) args.push('fit: BoxFit.contain');
    args.push(el.attrs.alt ? (svg ? 'semanticsLabel: ' : 'semanticLabel: ') + dtStr(el.attrs.alt) : 'excludeFromSemantics: true');
    w = dtCall(svg ? 'SvgPicture.asset' : 'Image.asset', args, inner);
  } else {
    const c = [];
    if (P.w !== null) c.push('width: ' + n2(P.w)); else if (crossW) c.push('width: double.infinity');
    if (P.h !== null) c.push('height: ' + n2(P.h)); else if (crossH) c.push('height: double.infinity');
    const [t, r, b, l] = P.pad;
    if (t || r || b || l) c.push(t === r && r === b && b === l ? 'padding: const EdgeInsets.all(' + n2(t) + ')' : 'padding: const EdgeInsets.fromLTRB(' + [l, t, r, b].map(n2).join(', ') + ')');
    const deco = [];
    if (P.bg) deco.push('color: ' + dtColor(P.bg, ctx));
    if (P.bgImage) deco.push('image: DecorationImage(image: AssetImage(' + dtStr('assets/' + P.bgImage.asset.file) + '), fit: BoxFit.' + (P.bgImage.scaleMode === 'FIT' ? 'contain' : 'cover') + ')');
    if (P.radius) deco.push('borderRadius: BorderRadius.circular(' + n2(P.radius) + ')');
    if (P.border && P.border.color) deco.push('border: Border.all(color: ' + dtColor(P.border.color, ctx) + ', width: ' + n2(P.border.w) + ')');
    if (P.shadow && P.shadow.color) deco.push('boxShadow: [BoxShadow(color: ' + dtColor(P.shadow.color, ctx) + ', offset: Offset(' + n2(P.shadow.x) + ', ' + n2(P.shadow.y) + '), blurRadius: ' + n2(P.shadow.blur) + ', spreadRadius: ' + n2(P.shadow.spread) + ')]');
    if (deco.length) c.push('decoration: BoxDecoration(' + deco.join(', ') + ')');
    if (el.css.overflow === 'hidden' && P.radius && el.children.length) c.push('clipBehavior: Clip.antiAlias');
    const cd = c.length ? inner + 1 : inner; // depth where the layout widget starts
    const kids = el.children.map(k => dtNode(k, el, cd + 2, ctx, inDef));
    let child = null;
    if (kids.length) {
      const a = [];
      if (P.dir === 'z') {
        a.push('children: ' + dtList(kids, cd));
        child = dtCall('Stack', a, cd);
      } else {
        const row = P.dir === 'row';
        const hug = row ? (P.w === null && !P.fillW) : (P.h === null && !P.fillH);
        if (hug) a.push('mainAxisSize: MainAxisSize.min');
        if (DT_MAIN[P.justify] && P.justify !== 'flex-start') a.push('mainAxisAlignment: MainAxisAlignment.' + DT_MAIN[P.justify]);
        a.push('crossAxisAlignment: CrossAxisAlignment.' + (DT_CROSS[P.align] || 'start'));
        if (P.gap && P.justify !== 'space-between') a.push('spacing: ' + n2(P.gap));
        a.push('children: ' + dtList(kids, cd));
        child = dtCall(row ? 'Row' : 'Column', a, cd);
      }
    }
    if (!c.length) w = child || 'SizedBox.shrink()';
    else { if (child) c.push('child: ' + child); w = dtCall('Container', c, inner); }
  }
  for (let i = wraps.length - 1; i >= 0; i--) w = dtCall(wraps[i].name, wraps[i].args.concat(['child: ' + w]), d + i);
  return w;
}
function generateFlutter(root, defs, ctx, name) {
  ctx.tokenUse = {}; ctx.dtSvg = false; ctx.dtInk = false;
  const cls = (cname, fields, body) => 'class ' + cname + ' extends StatelessWidget {\n  const ' + cname + '({super.key' + fields.map(f => ', required this.' + f).join('') + '});\n' +
    (fields.length ? '\n' + fields.map(f => '  final String ' + f + ';').join('\n') + '\n' : '') +
    '\n  @override\n  Widget build(BuildContext context) {\n    return ' + body + ';\n  }\n}';
  const defCode = defs.map(def => cls(def.name, def.props.map(p => p.name), dtNode(def.tpl, def.tpl.parent, 2, ctx, true)));
  const main = cls(name, [], dtNode(root, null, 2, ctx, false));
  const used = Object.keys(ctx.tokenUse);
  let tokens = '';
  if (used.length) {
    tokens = '\n\n/// Design tokens (from Figma variables)\nclass AppColors {\n  AppColors._();\n' + used.map(t => '  static const ' + tokenId(t) + ' = ' + dtRawColor(ctx.tokenUse[t]) + ';').join('\n') + '\n}';
    const dark = used.filter(t => ctx.tokenInfo[t] && Object.keys(ctx.tokenInfo[t].modes).some(m => /dark/i.test(m)));
    if (dark.length) {tokens += '\n\nclass AppColorsDark {\n  AppColorsDark._();\n' + dark.map(t => {
      const ti = ctx.tokenInfo[t], dk = ti.modes[Object.keys(ti.modes).find(m => /dark/i.test(m))];
      return '  static const ' + tokenId(t) + ' = ' + dtRawColor(typeof dk === 'object' ? dk : ctx.tokenUse[t]) + ';';
    }).join('\n') + '\n}';}
  }
  const imports = "import 'package:flutter/material.dart';" + (ctx.dtSvg ? "\nimport 'package:flutter_svg/flutter_svg.dart';" : '');
  const assets = ctx.assets.length ? '\n\n// Assets: add to pubspec.yaml → flutter: assets: [assets/]' + (ctx.dtSvg ? ' (SVGs need the flutter_svg package)' : '') : '';
  return imports + '\n\n' + defCode.concat([main]).join('\n\n') + tokens + assets + '\n';
}

/* ------------------------------------------------------------------ */
/* Accessibility audit: WCAG contrast, touch targets, labels           */
/* ------------------------------------------------------------------ */
function relLum(c) {
  const f = v => v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}
function contrastRatio(a, b) {
  const l1 = relLum(a), l2 = relLum(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}
function blendOver(fg, alpha, bg) {
  return { r: fg.r * alpha + bg.r * (1 - alpha), g: fg.g * alpha + bg.g * (1 - alpha), b: fg.b * alpha + bg.b * (1 - alpha) };
}
/** Top-most visible paint: { color, alpha } for solids, { unknown: type } for gradients/images, null if none. */
function topSolid(paints) {
  if (!paints || isMixed(paints) || !paints.length) return null;
  for (let i = paints.length - 1; i >= 0; i--) {
    const p = paints[i];
    if (p.visible === false) continue;
    if (p.type === 'SOLID') return { color: p.color, alpha: (p.opacity === undefined ? 1 : p.opacity) };
    return { unknown: p.type };
  }
  return null;
}
function coversBox(outer, inner) {
  const t = 1;
  return outer.x <= inner.x + t && outer.y <= inner.y + t && outer.x + outer.width >= inner.x + inner.width - t && outer.y + outer.height >= inner.y + inner.height - t;
}
/** Colour behind a layer: nearest covering sibling below it, then each ancestor's fill. */
function backgroundBehind(node) {
  const layers = [];
  let cur = node;
  const box = node.absoluteBoundingBox;
  let guard = 0;
  while (cur.parent && cur.parent.type !== 'PAGE' && cur.parent.type !== 'DOCUMENT' && guard++ < 40) {
    const par = cur.parent;
    const sibs = par.children || [];
    for (let i = sibs.indexOf(cur) - 1; i >= 0; i--) {
      const s = sibs[i];
      if (s.visible === false || !('fills' in s) || s.type === 'TEXT' || s.type === 'LINE') continue; // text is never a background
      const sb = s.absoluteBoundingBox;
      if (!sb || !box || !coversBox(sb, box)) continue;
      const f = topSolid(s.fills);
      if (!f) continue;
      if (f.unknown) return { unknown: f.unknown };
      layers.push(f);
      if (f.alpha >= 0.999) return composeLayers(layers, null);
    }
    if ('fills' in par) {
      const f = topSolid(par.fills);
      if (f && f.unknown) return { unknown: f.unknown };
      if (f) { layers.push(f); if (f.alpha >= 0.999) return composeLayers(layers, null); }
    }
    cur = par;
  }
  return composeLayers(layers, { r: 1, g: 1, b: 1 });
}
function composeLayers(layers, assumed) {
  let base = assumed || null;
  let i = layers.length - 1;
  if (!base) { base = layers[i].color; i--; }
  for (; i >= 0; i--) base = blendOver(layers[i].color, layers[i].alpha, base);
  return { color: base, assumed: !!assumed };
}
function textFill(n) {
  let f = topSolid(n.fills);
  if (!f && isMixed(n.fills)) {
    try { const segs = n.getStyledTextSegments(['fills']); if (segs && segs[0]) f = topSolid(segs[0].fills); } catch (e) { /* ignore */ }
  }
  return f;
}
const TARGET_NAME_RE = /(^|[\s\/_\-])(button|btn|cta|tab|chip|checkbox|radio|switch|toggle|link|icon button)([\s\/_\-]|$)/i;
function isInteractive(n) {
  try {
    if (n.reactions && n.reactions.some(r => { const t = r.trigger && r.trigger.type; return t === 'ON_CLICK' || t === 'ON_PRESS' || t === 'ON_DRAG' ? true : false; })) return true;
  } catch (e) { /* ignore */ }
  return /^(FRAME|INSTANCE|COMPONENT)$/.test(n.type) && TARGET_NAME_RE.test(n.name || '');
}
/** WCAG references attached to each finding, so a report can cite the rule. */
const A11Y_RULE = {
  contrast: '1.4.3', size: 'readability', target: '2.5.8', label: '4.1.2',
  nonText: '1.4.11', alt: '1.1.1', heading: '1.3.1', form: '3.3.2'
};
const A11Y_RULE_TITLE = {
  '1.4.3': 'Text contrast', '1.4.11': 'Non-text contrast', '1.1.1': 'Image alternative',
  '1.3.1': 'Info and relationships', '2.5.8': 'Target size', '4.1.2': 'Name, role, value',
  '3.3.2': 'Labels or instructions', readability: 'Readability'
};
/** Review decisions are kept per file, so ignoring a finding is visible to the team. */
const A11Y_IGNORE_KEY = 'a11y-ignore';
const A11Y_IGNORE_MAX = 120;
const A11Y_REASONS = ['Decorative', 'Brand exception', 'Legacy design', 'False positive', 'Will fix later', 'Approved by design'];
const AUTO_LAYER_NAME_RE = /^(image|img|bitmap|picture|photo|rectangle|rounded ?rectangle|ellipse|vector|group|frame|shape|layer|mask|graphic)([\s._-]*\d+)?$/i;
const DECORATIVE_NAME_RE = /(decorat|background|\bbg\b|pattern|texture|blob|spacer|divider|separator|shadow|glow|noise)/i;
const FIELD_NAME_RE = /(^|[\s/_-])(input|field|text ?field|search|email|username|password|select|combobox|dropdown|textarea|checkbox|radio|toggle|phone|number field)([\s/_-]|$)/i;
const ICON_NAME_RE = /(^|[\s/_.-])(icon|icons|glyph|glyphs|ic)([\s/_.-]|$)/i;
/** Does this layer live under something the team calls an icon? A raster icon is
 *  artwork, so asking for alt text there would be noise. */
function inIconContext(n) {
  let c = n, guard = 0;
  while (c && guard++ < 4) {
    if (ICON_NAME_RE.test(String(c.name || ''))) return true;
    c = c.parent;
  }
  return false;
}
/** Alt-text decision for a layer that carries an image. */
function altDecision(n) {
  const name = String(n.name || '').trim();
  if (!name) return { status: 'warn', detail: 'Unnamed image — rename the layer so its alt text can be written' };
  if (DECORATIVE_NAME_RE.test(name)) return { status: 'pass', detail: 'Looks decorative — export it with alt="" and aria-hidden' };
  if (AUTO_LAYER_NAME_RE.test(name)) return { status: 'warn', detail: 'Layer name "' + name.slice(0, 32) + '" is auto-generated — rename it to describe the image, or mark it decorative' };
  return { status: 'pass', detail: 'Descriptive layer name — use it as the alt text' };
}
/** Heading level suggested by the type scale (0 = body text). */
function headingLevel(size, weight) {
  if (!(size > 0)) return 0;
  if (size >= 32) return 1;
  if (size >= 24) return 2;
  if (size >= 20) return 3;
  if (size >= 18 && weight >= 700) return 4;
  return 0;
}
/** Is there readable text in this subtree? A manual walk, so it works on every
 *  Figma API version (findOne is not available on every node type). */
function hasVisibleText(n) {
  if (!n) return false;
  if (n.type === 'TEXT') return !!String(n.characters || '').trim();
  let found = false;
  (function walk(x, depth) {
    if (found || depth > 40 || !('children' in x)) return;
    for (const c of x.children) {
      if (found) return;
      if (c.visible === false) continue;
      if (c.type === 'TEXT' && String(c.characters || '').trim()) { found = true; return; }
      walk(c, depth + 1);
    }
  })(n, 0);
  return found;
}
/** The paint an icon actually draws with: its own, or the first one inside it. */
function firstSolidPaint(n) {
  const own = topSolid(n.fills) || topSolid(n.strokes);
  if (own && !own.unknown) return own;
  let found = null;
  (function walk(x, depth) {
    if (found || depth > 6) return;
    const f = topSolid(x.fills) || topSolid(x.strokes);
    if (f && !f.unknown) { found = f; return; }
    if ('children' in x) x.children.forEach(c => walk(c, depth + 1));
  })(n, 0);
  return found;
}
async function readA11yIgnore() {
  try {
    const raw = figma.root.getSharedPluginData(NS, A11Y_IGNORE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out = {};
    Object.keys(parsed).slice(0, A11Y_IGNORE_MAX).forEach(k => {
      if (typeof k === 'string' && k.length < 80 && typeof parsed[k] === 'string') out[k] = parsed[k].slice(0, 120);
    });
    return out;
  } catch (e) { return {}; }
}
function writeA11yIgnore(map) {
  const keys = Object.keys(map).slice(0, A11Y_IGNORE_MAX);
  const clean = {};
  keys.forEach(k => { clean[k] = String(map[k] || 'Ignored').slice(0, 120); });
  const text = JSON.stringify(clean);
  // Shared plugin data is per file and readable by collaborators: keep it small and plain.
  figma.root.setSharedPluginData(NS, A11Y_IGNORE_KEY, text.length <= 20000 ? text : '{}');
  return clean;
}
/**
 * Opacity that actually reaches a layer: Figma multiplies a layer's opacity with
 * every ancestor's. Reading only the layer's own value makes faded content look
 * fully opaque, which produced false "AA pass" results.
 */
function effectiveOpacity(node) {
  let o = 1, c = node, guard = 0;
  while (c && guard++ < 60) {
    if (c.visible === false) return 0;
    if (typeof c.opacity === 'number') o *= c.opacity;
    if (c.opacity === 0) return 0;
    if (c.parent && (c.parent.type === 'PAGE' || c.parent.type === 'DOCUMENT')) break;
    c = c.parent;
  }
  return Math.max(0, Math.min(1, o));
}
/**
 * WCAG 2.2 audit.
 *
 * Text contrast (1.4.3), non-text contrast for icons and control boundaries
 * (1.4.11), image alternatives (1.1.1), heading order (1.3.1), field labels
 * (3.3.2), target size (2.5.8), readable type, and a nameless-control check
 * (4.1.2). Findings can be reviewed per file with a reason, and the whole audit
 * can be exported as Markdown or CSV.
 */
function a11yAudit(root, limit, ignoreMap) {
  const ignore = ignoreMap || {};
  const items = [];
  const ignoredItems = [];
  const headings = [];
  let scanned = 0, limited = false, depthLimited = false;
  const push = it => {
    if (ignore[it.id]) ignoredItems.push(Object.assign({}, it, { reason: ignore[it.id] }));
    else items.push(it);
  };
  const frameWidth = n => { let c = n, g = 0; while (c.parent && g++ < 60 && c.parent.type !== 'PAGE' && c.parent.type !== 'DOCUMENT' && c.parent.type !== 'SECTION') c = c.parent; return c.width || 9999; };
  const visit = (n, depth) => {
    if (n.visible === false) return;
    if (scanned >= (limit || 400)) { limited = true; return; }
    if (depth > MAX_DEPTH) { depthLimited = true; return; }
    scanned++;
    if (n.type === 'TEXT' && n.characters && String(n.characters).trim()) {
      const fg = textFill(n), size = isMixed(n.fontSize) ? 16 : n.fontSize;
      const weight = isMixed(n.fontWeight) ? 400 : (n.fontWeight || 400);
      const op = effectiveOpacity(n);
      if (fg && !fg.unknown && op > 0.005) {
        const bg = backgroundBehind(n);
        if (bg && !bg.unknown) {
          const a = Math.min(1, fg.alpha * op);
          const eff = blendOver(fg.color, a, bg.color);
          const ratio = contrastRatio(eff, bg.color);
          const large = size >= 24 || (size >= 18.66 && weight >= 700);
          const need = large ? 3 : 4.5, aaa = large ? 4.5 : 7;
          const faded = op < 0.995;
          push({ rule: A11Y_RULE.contrast, id: n.id, name: String(n.characters).slice(0, 40), kind: 'contrast', status: ratio >= need ? 'pass' : 'fail', ratio: round(ratio, 2), need: need, aaa: ratio >= aaa, large: large,
            fg: colorHex(eff), bg: colorHex(bg.color), assumed: bg.assumed, confidence: bg.assumed ? 'assumed' : 'measured', opacity: round(op, 2), size: size,
            detail: faded ? 'Reduced to ' + Math.round(op * 100) + '% opacity by a parent layer' : '' });
        } else push({ rule: A11Y_RULE.contrast, id: n.id, name: String(n.characters).slice(0, 40), kind: 'contrast', status: 'unknown', confidence: 'unknown', detail: 'Background is a ' + String(bg && bg.unknown || 'gradient/image').toLowerCase() + ' — check contrast manually' });
      }
      if (size < 12) push({ rule: A11Y_RULE.size, id: n.id, name: String(n.characters).slice(0, 40), kind: 'size', status: 'warn', confidence: 'measured', detail: 'Text is ' + round(size, 1) + 'px — under 12px is hard to read' });
      const lvl = headingLevel(size, weight);
      if (lvl) headings.push({ level: lvl, id: n.id, name: String(n.characters).slice(0, 40), size: size });
    }

    // Images need an alternative; a layer name is the only signal a plugin has.
    if (n !== root && hasImageFill(n) && !isIconLike(n) && !inIconContext(n)) {
      const alt = altDecision(n);
      push({ rule: A11Y_RULE.alt, id: n.id, name: n.name, kind: 'alt', status: alt.status, confidence: 'inferred', detail: alt.detail });
    }

    // Icons and control outlines must reach 3:1 against what is behind them.
    const iconLike = n !== root && isIconLike(n);
    const outline = !iconLike && n !== root && isInteractive(n) && topSolid(n.strokes);
    if (iconLike || outline) {
      const fg = iconLike ? firstSolidPaint(n) : topSolid(n.strokes);
      if (fg && !fg.unknown) {
        const bg = backgroundBehind(n);
        const op = effectiveOpacity(n);
        if (bg && !bg.unknown && op > 0.005) {
          const eff = blendOver(fg.color, Math.min(1, fg.alpha * op), bg.color);
          const ratio = contrastRatio(eff, bg.color);
          push({ rule: A11Y_RULE.nonText, id: n.id, name: n.name, kind: 'nontext', status: ratio >= 3 ? 'pass' : 'fail', ratio: round(ratio, 2), need: 3,
            fg: colorHex(eff), bg: colorHex(bg.color), assumed: bg.assumed, confidence: bg.assumed ? 'assumed' : 'measured',
            detail: (iconLike ? 'Icon' : 'Control outline') + ' contrast against the layer behind it' });
        } else push({ rule: A11Y_RULE.nonText, id: n.id, name: n.name, kind: 'nontext', status: 'unknown', confidence: 'unknown', detail: 'Background is a ' + String(bg && bg.unknown || 'gradient/image').toLowerCase() + ' — check the 3:1 requirement manually' });
      }
    }

    // A field with no visible label is unusable with a screen reader.
    if (n !== root && /^(FRAME|INSTANCE|COMPONENT)$/.test(n.type) && FIELD_NAME_RE.test(n.name || '')) {
      const labelled = hasVisibleText(n);
      if (!labelled) push({ rule: A11Y_RULE.form, id: n.id, name: n.name, kind: 'form', status: 'warn', confidence: 'inferred', detail: 'Field has no visible label — pair it with a text label or a placeholder that survives' });
      else push({ rule: A11Y_RULE.form, id: n.id, name: n.name, kind: 'form', status: 'pass', confidence: 'inferred', detail: 'Field has visible text' });
    }

    if (n !== root && isInteractive(n) && 'width' in n) {
      const w = n.width, h = n.height, min = Math.min(w, h), mobile = frameWidth(n) <= 600;
      if (min < 24) push({ rule: A11Y_RULE.target, id: n.id, name: n.name, kind: 'target', status: 'fail', confidence: 'measured', w: round(w), h: round(h), detail: round(w) + '×' + round(h) + ' is under the 24×24 minimum (WCAG 2.5.8)' });
      else if (mobile && min < 44) push({ rule: A11Y_RULE.target, id: n.id, name: n.name, kind: 'target', status: 'warn', confidence: 'measured', w: round(w), h: round(h), detail: round(w) + '×' + round(h) + ' — aim for 44×44 on touch screens' });
      else push({ rule: A11Y_RULE.target, id: n.id, name: n.name, kind: 'target', status: 'pass', confidence: 'measured', w: round(w), h: round(h), detail: round(w) + '×' + round(h) });
      if (!hasVisibleText(n)) push({ rule: A11Y_RULE.label, id: n.id, name: n.name, kind: 'label', status: 'warn', confidence: 'inferred', detail: 'No visible text — give it an accessible name (aria-label / contentDescription)' });
    }
    if ('children' in n) n.children.forEach(c => visit(c, depth + 1));
  };
  visit(root, 0);

  // Document order is the only order a screen reader sees, so a skipped level is a
  // real navigation problem — not a cosmetic one. Levels come from the type scale.
  let prev = 0;
  headings.forEach(h => {
    if (prev && h.level > prev + 1) {
      push({ rule: A11Y_RULE.heading, id: h.id, name: h.name, kind: 'heading', status: 'warn', confidence: 'inferred',
        detail: 'Heading levels jump from ' + prev + ' to ' + h.level + ' (' + round(h.size, 1) + 'px) — do not skip levels' });
    }
    prev = h.level;
  });

  const counts = { fail: 0, warn: 0, pass: 0, unknown: 0, ignored: ignoredItems.length };
  items.forEach(i => { counts[i.status]++; });
  const order = { fail: 0, warn: 1, unknown: 2, pass: 3 };
  items.sort((a, b) => order[a.status] - order[b.status]);
  // Designs repeat themselves (a carousel of 30 identical cards), so one issue per
  // layer produces a wall of identical rows. Group findings that carry the same
  // problem: the count is the useful part ("12 layers fail 3.71:1"), and each group
  // still points at real layers.
  const groups = [];
  const byKey = {};
  items.forEach(it => {
    const key = (it.kind === 'contrast' || it.kind === 'nontext') && it.status !== 'unknown'
      ? [it.kind, it.status, it.fg, it.bg, it.ratio, it.need, it.large ? 1 : 0, it.assumed ? 1 : 0].join('|')
      : [it.kind, it.status, it.detail || '', it.need || ''].join('|');
    const g = byKey[key];
    if (!g) {
      byKey[key] = { key: key, rule: it.rule, kind: it.kind, status: it.status, count: 1, ids: [it.id], item: it };
      groups.push(byKey[key]);
      return;
    }
    g.count++;
    if (g.ids.length < 50) g.ids.push(it.id);
  });
  groups.sort((a, b) => order[a.status] - order[b.status] || b.count - a.count);
  const byRule = {};
  items.forEach(i => { byRule[i.rule] = (byRule[i.rule] || 0) + (i.status === 'fail' ? 1 : 0); });
  const ignoredGroups = {};
  ignoredItems.forEach(i => {
    ignoredGroups[i.id] = ignoredGroups[i.id] || { id: i.id, name: i.name, reason: i.reason, kinds: [], rules: [] };
    ignoredGroups[i.id].kinds.push(i.kind);
    if (ignoredGroups[i.id].rules.indexOf(i.rule) < 0) ignoredGroups[i.id].rules.push(i.rule);
  });
  return {
    items: items.slice(0, 120), groups: groups.slice(0, 120), counts: counts, byRule: byRule,
    scanned: scanned, limited: limited, depthLimited: depthLimited,
    ignored: Object.keys(ignoredGroups).map(k => ignoredGroups[k]).slice(0, 60),
    headingLevels: headings.slice(0, 40).map(h => h.level),
    reasons: A11Y_REASONS
  };
}

/** Markdown or CSV export of an audit, including the review decisions. */
function a11yReport(audit, format, meta) {
  const a = audit || { groups: [], counts: { fail: 0, warn: 0, pass: 0, unknown: 0, ignored: 0 }, byRule: {}, scanned: 0 };
  const c = a.counts || {};
  // Layer names are user data: a newline or a stray pipe would break the table.
  const flat = v => String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  const title = flat(meta && meta.name) || 'Design';
  const when = new Date().toISOString().slice(0, 10);
  const groups = (a.groups || []).filter(g => g.status !== 'pass');
  if (format === 'csv') {
    const esc = v => '"' + String(v == null ? '' : v).replace(/"/g, '""').replace(/[\r\n\t]+/g, ' ') + '"';
    const rows = [['status', 'rule', 'kind', 'layers', 'name', 'detail'].map(esc).join(',')];
    groups.forEach(g => rows.push([g.status, g.rule, g.kind, g.count, (g.item && g.item.name) || '', (g.item && g.item.detail) || (g.item && g.item.ratio ? g.item.ratio + ':1' : '')].map(esc).join(',')));
    (a.ignored || []).forEach(i => rows.push(['ignored', '', i.kinds.join(' '), 1, i.name, i.reason].map(esc).join(',')));
    return { format: 'csv', text: rows.join('\n') + '\n', file: 'devready-a11y-' + slug(title) + '.csv' };
  }
  const lines = [];
  lines.push('# Accessibility report — ' + title);
  lines.push('');
  lines.push('Generated by DevReady on ' + when + '. WCAG 2.2 AA.');
  lines.push('');
  lines.push('| | Count |');
  lines.push('|---|---|');
  lines.push('| Failing | ' + (c.fail || 0) + ' |');
  lines.push('| To review | ' + (c.warn || 0) + ' |');
  lines.push('| Unmeasured | ' + (c.unknown || 0) + ' |');
  lines.push('| Passing | ' + (c.pass || 0) + ' |');
  lines.push('| Ignored with a reason | ' + (c.ignored || 0) + ' |');
  lines.push('| Layers checked | ' + (a.scanned || 0) + ' |');
  lines.push('');
  const rules = Object.keys(A11Y_RULE_TITLE).filter(r => (a.byRule || {})[r]);
  if (rules.length) {
    lines.push('## By rule');
    lines.push('');
    lines.push('| Rule | Criterion | Failures |');
    lines.push('|---|---|---|');
    rules.forEach(r => lines.push('| ' + r + ' | ' + A11Y_RULE_TITLE[r] + ' | ' + a.byRule[r] + ' |'));
    lines.push('');
  }
  lines.push('## Findings');
  lines.push('');
  if (!groups.length) lines.push('No failing or reviewable findings.');
  groups.forEach(g => {
    const it = g.item || {};
    lines.push('- **' + g.status.toUpperCase() + '** · WCAG ' + (g.rule || '—') + ' · ' + g.kind + (g.count > 1 ? ' · ' + g.count + ' layers' : ''));
    lines.push('  - ' + (flat(it.name) || 'layer') + (it.detail ? ' — ' + flat(it.detail) : ''));
  });
  if ((a.ignored || []).length) {
    lines.push('');
    lines.push('## Ignored');
    lines.push('');
    // The criterion stays attached to the decision, so the exemption can be audited later.
    a.ignored.forEach(i => lines.push('- ' + (flat(i.name) || 'layer') + ' — ' + (flat(i.reason) || 'no reason given') + ' (' + i.kinds.join(', ') + ((i.rules || []).length ? ' · WCAG ' + i.rules.join(', ') : '') + ')'));
  }
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('Checked ' + (a.scanned || 0) + ' layers' + (a.limited ? ', stopped at the layer limit' : '') + (a.depthLimited ? ', deeper layers skipped' : '') + '. Contrast includes opacity inherited from parent layers. Backgrounds that cannot be measured are reported as unmeasured, never as a pass.');
  return { format: 'md', text: lines.join('\n') + '\n', file: 'devready-a11y-' + slug(title) + '.md' };
}

/* ------------------------------------------------------------------ */
/* Design tokens export: variables (all modes) + styles                */
/* ------------------------------------------------------------------ */
const UNITLESS_RE = /opacity|alpha|ratio|weight|z-?index|scale|line-?height|leading|count|order|columns?/i;
function cssIdent(path) { return path.map(p => slug(p)).filter(Boolean).join('-') || 'token'; }
function cssStr(s) { return '"' + String(s).replace(/[\\"]/g, '\\$&').replace(/\n/g, '\\A ').replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ') + '"'; }
function safeVarName(web, path) {
  const m = web && /var\((--[A-Za-z0-9_-]+)/.exec(web);
  return m ? m[1] : '--' + cssIdent(path);
}
/**
 * Walks alias → alias → … so a token can fall back to the first target that is
 * actually part of the export. A single-step lookup produced `var(--x)` for `--x`
 * that belonged to a hidden variable or another file — valid CSS naming an
 * undefined custom property, which renders as nothing.
 */
async function aliasChain(raw, modeId) {
  const names = [];
  let cur = raw;
  for (let depth = 0; depth < 8; depth++) {
    if (!cur || typeof cur !== 'object' || cur.type !== 'VARIABLE_ALIAS') break;
    let v = null;
    try { v = await figma.variables.getVariableByIdAsync(cur.id); } catch (e) { /* unavailable target */ }
    if (!v) return names; // the target lives outside this file: chain stops here
    names.push(v.name);
    const coll = await getColl(v.variableCollectionId);
    const mid = v.valuesByMode[modeId] !== undefined ? modeId : coll ? coll.defaultModeId : Object.keys(v.valuesByMode || {})[0];
    cur = v.valuesByMode[mid];
  }
  return names;
}
async function tokenFromVariable(v) {
  const coll = await getColl(v.variableCollectionId);
  const fallbackMode = Object.keys(v.valuesByMode || {})[0];
  const modes = coll && coll.modes && coll.modes.length ? coll.modes : [{ modeId: fallbackMode, name: 'Default' }];
  const defId = (coll && coll.defaultModeId) || modes[0].modeId;
  const path = String(v.name).split('/').map(s => s.trim()).filter(Boolean);
  const tok = { source: 'variable', name: v.name, path: path, type: v.resolvedType, collection: coll ? coll.name : '', remote: !!(coll && coll.remote), description: v.description || '', web: (v.codeSyntax && v.codeSyntax.WEB) || '', modes: [] };
  for (const m of modes) {
    const raw = v.valuesByMode[m.modeId];
    const r = await resolveVarValue(raw, m.modeId, 0);
    const chain = raw && typeof raw === 'object' && raw.type === 'VARIABLE_ALIAS' ? await aliasChain(raw, m.modeId) : [];
    const mode = { name: m.name, isDefault: m.modeId === defId, value: r.value, ref: chain.length ? chain[0] : null };
    if (chain.length > 1) mode.refChain = chain;
    if (r.cycle) mode.cycle = true;
    if (r.value === null || r.value === undefined) mode.unresolved = true;
    tok.modes.push(mode);
  }
  return tok;
}
function walkTree(node, fn, limit) {
  let n = 0;
  (function go(x, depth) {
    if (n++ >= limit || depth > MAX_DEPTH) return;
    fn(x);
    if ('children' in x) x.children.forEach(c => go(c, depth + 1));
  })(node, 0);
}
async function gatherTokens(scope, node) {
  const tokens = [];
  const seen = {};
  let libraryCount = 0;
  const add = async v => {
    if (!v || seen[v.id] || v.hiddenFromPublishing) return;
    seen[v.id] = 1;
    if (v.resolvedType === 'BOOLEAN') return;
    try { tokens.push(await tokenFromVariable(v)); } catch (e) { /* skip */ }
  };
  if (scope === 'selection' && node) {
    const ctx = { varIds: {} };
    walkTree(node, n => collectVarIds(n, ctx), 1500);
    for (const id of Object.keys(ctx.varIds)) { let v = null; try { v = await figma.variables.getVariableByIdAsync(id); } catch (e) { /* remote */ } await add(v); }
  } else {
    let list = [];
    try { list = await figma.variables.getLocalVariablesAsync(); } catch (e) { diag('local variables', e); }
    for (const v of list.slice(0, 2000)) await add(v);
    // A design system usually lives in a library: those variables are part of the
    // file's tokens even though the file does not own them. Bounded, and silently
    // skipped on Figma builds without the API.
    let library = 0;
    const lib = figma.variables.getVariablesInLibraryCollectionAsync;
    if (lib) {
      let colls = [];
      try { colls = await figma.variables.getAvailableLibraryVariableCollectionsAsync(); } catch (e) { diag('library collections', e); }
      for (const c of (colls || []).slice(0, 8)) {
        if (!c) continue;
        let vars = [];
        try { vars = await lib.call(figma.variables, c.key || c.id); } catch (e) { diag('library variables', e); }
        for (const v of (vars || []).slice(0, 600)) {
          if (library >= 500) break;
          await add(v);
          library++;
        }
      }
    }
    libraryCount = library;
  }
  const styles = { paint: [], text: [] };
  if (scope !== 'selection') {
    try {
      const ps = await figma.getLocalPaintStylesAsync();
      ps.slice(0, 500).forEach(s => {
        const f = topSolid(s.paints);
        if (f && !f.unknown) styles.paint.push({ name: s.name, path: String(s.name).split('/').map(x => x.trim()).filter(Boolean), color: { r: f.color.r, g: f.color.g, b: f.color.b, a: f.alpha } });
      });
    } catch (e) { /* unavailable */ }
    try {
      const ts = await figma.getLocalTextStylesAsync();
      ts.slice(0, 500).forEach(s => {
        const lh = s.lineHeight && s.lineHeight.unit === 'PIXELS' ? s.lineHeight.value + 'px' : s.lineHeight && s.lineHeight.unit === 'PERCENT' ? round(s.lineHeight.value / 100, 3) : null;
        const ls = s.letterSpacing && s.letterSpacing.value ? (s.letterSpacing.unit === 'PIXELS' ? s.letterSpacing.value + 'px' : round(s.letterSpacing.value / 100, 3) + 'em') : null;
        styles.text.push({ name: s.name, path: String(s.name).split('/').map(x => x.trim()).filter(Boolean), family: s.fontName.family, weight: styleWeight(s.fontName.style), italic: /italic/i.test(s.fontName.style), size: s.fontSize, lineHeight: lh, letterSpacing: ls });
      });
    } catch (e) { /* unavailable */ }
  }
  return { tokens: tokens, styles: styles, library: libraryCount };
}
/**
 * Name to reference for an aliased value, or '' when no target in the chain is
 * part of this export (then the literal value is written instead).
 */
function refName(mode, nameOf, known) {
  const chain = mode.refChain || (mode.ref ? [mode.ref] : []);
  for (const n of chain) {
    if (!n) continue;
    if (!known || known(n)) return nameOf(n);
  }
  return '';
}
function tokenValue(tok, mode, nameOf, unit, base, known) {
  const ref = refName(mode, nameOf, known);
  if (ref) return 'var(' + ref + ')';
  const hint = tok.type === 'FLOAT' && !UNITLESS_RE.test(tok.name) ? 'px' : '';
  if (tok.type === 'STRING') return mode.value === null || mode.value === undefined ? null : cssStr(mode.value);
  const v = varValueCss(mode.value, tok.type, hint);
  return v === null ? null : remify(v, unit, base);
}
function twName(tok) {
  const p = tok.path.slice();
  const take = re => { const i = p.findIndex(s => re.test(s)); if (i > -1) p.splice(i, 1); return i > -1; };
  let prefix = '';
  if (tok.type === 'COLOR') { take(/^colou?rs?$/i); prefix = 'color'; }
  else if (tok.type === 'FLOAT') {
    if (take(/radius|rounded|corner/i)) prefix = 'radius';
    else if (take(/^(spacing|space|gap|padding|margin)$/i)) prefix = 'spacing';
    else if (take(/font-?size|text-?size|type-?size/i)) prefix = 'text';
    else if (take(/font-?weight/i)) prefix = 'font-weight';
    else if (take(/line-?height|leading/i)) prefix = 'leading';
    else if (take(/letter|tracking/i)) prefix = 'tracking';
  } else if (tok.type === 'STRING' && take(/font|family/i)) prefix = 'font';
  const rest = cssIdent(p.length ? p : ['default']);
  return '--' + (prefix ? prefix + '-' : '') + rest;
}
function jsonSet(root, path, leaf) {
  let o = root;
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i];
    if (!o[k] || o[k].$value !== undefined) o[k] = Object.create(null);
    o = o[k];
  }
  const last = path[path.length - 1];
  o[o[last] && o[last].$value === undefined && o[last] ? last + '-default' : last] = leaf;
}
function jsonValue(tok, mode, unit, base, refPath, known) {
  const ref = refName(mode, refPath, known);
  if (ref) return '{' + ref + '}';
  if (tok.type === 'COLOR') return varValueCss(mode.value, 'COLOR');
  if (tok.type === 'FLOAT') return UNITLESS_RE.test(tok.name) ? mode.value : remify(round(mode.value, 2) + 'px', unit, base);
  return mode.value;
}
async function buildTokens(format, scope, node, unit, base) {
  const data = await gatherTokens(scope, node);
  const toks = data.tokens;
  const byName = {};
  toks.forEach(t => { byName[t.name] = t; });
  const nameOf = format === 'tailwind'
    ? n => byName[n] ? twName(byName[n]) : '--' + cssIdent(String(n).split('/'))
    : n => byName[n] ? safeVarName(byName[n].web, byName[n].path) : '--' + cssIdent(String(n).split('/'));
  // An alias may only become `var(--x)` / `{x.y}` when `--x` is in this export.
  const known = n => !!(byName[n] && byName[n].path && byName[n].path.length);
  const aliases = toks.filter(t => t.modes.some(m => m.ref)).length;
  const unresolved = toks.filter(t => t.modes.some(m => m.unresolved)).length;
  const library = data.library || 0;
  const when = scope === 'selection'
    ? 'tokens used by the selection'
    : 'all local variables and styles' + (library ? ' plus ' + library + ' published library variable' + (library === 1 ? '' : 's') : '');
  const stats = { variables: toks.length, styles: data.styles.paint.length + data.styles.text.length, modes: 0, aliases: aliases, library: library, unresolved: unresolved };
  const head = 'Design tokens — exported from Figma by DevReady (' + when + ')' +
    (unresolved ? ' · ' + unresolved + ' token' + (unresolved === 1 ? '' : 's') + ' could not be resolved in this file' : '');
  let text;
  const modeNames = {};
  toks.forEach(t => t.modes.forEach(m => { if (!m.isDefault) modeNames[t.collection + '|' + m.name] = 1; }));
  stats.modes = Object.keys(modeNames).length;

  if (format === 'json') {
    const root = Object.create(null);
    const refPath = n => (byName[n] ? byName[n].path : String(n).split('/')).join('.');
    toks.forEach(t => {
      const def = t.modes.find(m => m.isDefault) || t.modes[0];
      if (!def || !t.path.length) return;
      const v = jsonValue(t, def, unit, base, refPath, known);
      if (v === null || v === undefined) {
        // Value could not be resolved (remote variable the file cannot read).
        // Keep the token so the consumer sees it exists, flagged rather than missing.
        jsonSet(root, t.path, { $type: 'string', $value: null, $description: t.description || 'Unresolved in Figma — read the variable in the design file.' });
        return;
      }
      const leaf = { $type: t.type === 'COLOR' ? 'color' : t.type === 'FLOAT' ? (UNITLESS_RE.test(t.name) ? 'number' : 'dimension') : 'string', $value: v };
      if (t.description) leaf.$description = t.description;
      const others = t.modes.filter(m => !m.isDefault);
      leaf.$extensions = { 'com.figma': { collection: t.collection } };
      if (others.length) { leaf.$extensions['com.figma'].modes = {}; others.forEach(m => { const mv = jsonValue(t, m, unit, base, refPath, known); if (mv !== null && mv !== undefined) leaf.$extensions['com.figma'].modes[m.name] = mv; }); }
      jsonSet(root, t.path, leaf);
    });
    data.styles.paint.forEach(s => { if (s.path.length) jsonSet(root, ['style'].concat(s.path), { $type: 'color', $value: varValueCss(s.color, 'COLOR') }); });
    data.styles.text.forEach(s => {
      if (!s.path.length) return;
      const v = { fontFamily: s.family, fontWeight: s.weight, fontSize: remify(s.size + 'px', unit, base) };
      if (s.lineHeight !== null) v.lineHeight = s.lineHeight;
      if (s.letterSpacing !== null) v.letterSpacing = s.letterSpacing;
      jsonSet(root, ['text'].concat(s.path), { $type: 'typography', $value: v });
    });
    root.$description = head;
    text = JSON.stringify(root, null, 2) + '\n';
  } else if (format === 'scss') {
    const sn = n => '$' + nameOf(n).replace(/^--/, '');
    const lines = ['// ' + head, ''];
    toks.forEach(t => {
      const def = t.modes.find(m => m.isDefault) || t.modes[0];
      if (!def) return;
      const v = tokenValue(t, def, n => sn(n), unit, base, known);
      if (v === null) return;
      const name = sn(t.name);
      lines.push(name + ': ' + v.replace(/var\((\$[^)]+)\)/g, '$1') + ';');
      t.modes.filter(m => !m.isDefault).forEach(m => {
        const mv = tokenValue(t, m, n => sn(n), unit, base, known);
        if (mv !== null && mv !== v) lines.push(name + '--' + slug(m.name) + ': ' + mv.replace(/var\((\$[^)]+)\)/g, '$1') + ';');
      });
    });
    if (data.styles.paint.length) { lines.push('', '// Color styles'); data.styles.paint.forEach(s => lines.push('$style-' + cssIdent(s.path) + ': ' + varValueCss(s.color, 'COLOR') + ';')); }
    if (data.styles.text.length) {
      lines.push('', '// Text styles');
      data.styles.text.forEach(s => {
        const n = '$text-' + cssIdent(s.path);
        lines.push(n + '-font-family: ' + cssStr(s.family) + ';', n + '-font-size: ' + remify(s.size + 'px', unit, base) + ';', n + '-font-weight: ' + s.weight + ';');
        if (s.lineHeight !== null) lines.push(n + '-line-height: ' + s.lineHeight + ';');
        if (s.letterSpacing !== null) lines.push(n + '-letter-spacing: ' + s.letterSpacing + ';');
      });
    }
    text = lines.join('\n') + '\n';
  } else {
    // css and tailwind (v4 @theme) share the :root / mode-override structure
    const tw = format === 'tailwind';
    const root = [], themes = {};
    toks.forEach(t => {
      const def = t.modes.find(m => m.isDefault) || t.modes[0];
      if (!def) return;
      const name = nameOf(t.name);
      const v = tokenValue(t, def, nameOf, unit, base, known);
      if (v === null) return;
      root.push('  ' + name + ': ' + v + ';');
      t.modes.filter(m => !m.isDefault).forEach(m => {
        const mv = tokenValue(t, m, nameOf, unit, base, known);
        if (mv === null || mv === v) return;
        const sel = themeSelector(t.collection, m.name, t.modes);
        (themes[sel] = themes[sel] || []).push('  ' + name + ': ' + mv + ';');
      });
    });
    data.styles.paint.forEach(s => root.push('  ' + (tw ? '--color-' : '--style-') + cssIdent(s.path) + ': ' + varValueCss(s.color, 'COLOR') + ';'));
    data.styles.text.forEach(s => {
      const n = cssIdent(s.path);
      if (tw) {
        root.push('  --text-' + n + ': ' + remify(s.size + 'px', unit, base) + ';');
        if (s.lineHeight !== null) root.push('  --text-' + n + '--line-height: ' + s.lineHeight + ';');
        if (s.letterSpacing !== null) root.push('  --text-' + n + '--letter-spacing: ' + s.letterSpacing + ';');
        root.push('  --text-' + n + '--font-weight: ' + s.weight + ';');
      } else {
        root.push('  --text-' + n + '-font-family: ' + cssStr(s.family) + ';', '  --text-' + n + '-font-size: ' + remify(s.size + 'px', unit, base) + ';', '  --text-' + n + '-font-weight: ' + s.weight + ';');
        if (s.lineHeight !== null) root.push('  --text-' + n + '-line-height: ' + s.lineHeight + ';');
        if (s.letterSpacing !== null) root.push('  --text-' + n + '-letter-spacing: ' + s.letterSpacing + ';');
      }
    });
    const parts = ['/* ' + head + ' */'];
    if (tw) parts.push('@import "tailwindcss";');
    parts.push((tw ? '@theme' : ':root') + ' {\n' + root.join('\n') + '\n}');
    Object.keys(themes).forEach(sel => parts.push(sel + ' {\n' + themes[sel].join('\n') + '\n}'));
    text = parts.join('\n\n') + '\n';
  }
  const ext = format === 'json' ? 'json' : format === 'scss' ? 'scss' : 'css';
  return { text: text, file: (format === 'tailwind' ? 'theme' : 'tokens') + '.' + ext, lang: format === 'json' ? 'json' : 'css', stats: stats, empty: !toks.length && !stats.styles };
}

/* ------------------------------------------------------------------ */
/* GitHub - optional, token-based, user-initiated only                 */
/*                                                                     */
/* A Figma plugin has no server, so an OAuth client secret cannot be   */
/* kept: the safest supported flow is a fine-grained personal access   */
/* token with "Contents: read and write" on the chosen repositories.    */
/* The token lives in clientStorage on this machine, is attached to     */
/* requests here in the plugin thread, and is never sent to the panel,  */
/* written to the document, or included in generated code or logs.      */
/* ------------------------------------------------------------------ */
const GH_API = 'https://api.github.com';
const GH_TIMEOUT_MS = 20000;
let ghTokenCache;
let ghTokenLoaded = false;

async function ghToken() {
  if (ghTokenLoaded) return ghTokenCache || null;
  ghTokenLoaded = true;
  try {
    const t = await figma.clientStorage.getAsync('devready-github-token');
    ghTokenCache = typeof t === 'string' && t ? t : null;
  } catch (e) { ghTokenCache = null; diag('GitHub token', e); }
  return ghTokenCache;
}
async function ghSetToken(t) {
  ghTokenCache = t || null;
  ghTokenLoaded = true;
  try {
    if (t) await figma.clientStorage.setAsync('devready-github-token', t);
    else await figma.clientStorage.deleteAsync('devready-github-token');
  } catch (e) { diag('GitHub token', e); }
}
/** Belt and braces: no token-shaped string ever leaves this module. */
function ghScrub(text) {
  let out = String(text == null ? '' : text);
  if (ghTokenCache) out = out.split(ghTokenCache).join('[redacted]');
  out = out.replace(/\b(?:gh[pousr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,})\b/g, '[redacted]');
  return out.slice(0, 300);
}
function ghErrorOf(status, body, headers) {
  const msg = body && body.message ? String(body.message) : '';
  const remaining = headers && headers['x-ratelimit-remaining'];
  const reset = headers && headers['x-ratelimit-reset'];
  if (status === 0) return { code: 'network', message: msg || 'Could not reach GitHub. Check your connection and try again.' };
  if (status === 401) return { code: 'auth', message: 'GitHub rejected the token. It may have expired or been revoked — reconnect GitHub.' };
  if (status === 403 && String(remaining) === '0') {
    const when = reset ? new Date(+reset * 1000).toLocaleTimeString() : 'later';
    return { code: 'rate-limit', message: 'GitHub rate limit reached. Try again after ' + when + '.' };
  }
  if (status === 403) return { code: 'permission', message: 'The token cannot do that. It needs "Contents: read and write" (and "Administration: write" to create repositories).' };
  if (status === 404) return { code: 'not-found', message: msg || 'Not found — or the token cannot see this repository.' };
  if (status === 409 || status === 422) return { code: 'conflict', message: msg || 'The branch moved while committing. Refresh the changes and try again.' };
  if (status >= 500) return { code: 'unavailable', message: 'GitHub is unavailable right now (' + status + '). Try again in a moment.' };
  return { code: 'http-' + status, message: msg || ('GitHub returned ' + status + '.') };
}

function ghWithTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; reject({ code: 'timeout', message: 'GitHub did not answer within ' + Math.round(ms / 1000) + ' s.' }); } }, ms);
    promise.then(v => { if (!done) { done = true; clearTimeout(timer); resolve(v); } },
      e => { if (!done) { done = true; clearTimeout(timer); reject(e); } });
  });
}

/**
 * One place where GitHub is called. Adds auth, version pinning, a timeout, a single
 * retry for transient failures and uniform error mapping. Returns
 * { ok, status, body, headers, rate, error } and never throws.
 */
async function ghRequest(path, opts) {
  opts = opts || {};
  if (typeof path !== 'string' || path[0] !== '/' || /[\s\u0000]/.test(path) || path.length > 400) {
    return { ok: false, status: 0, error: { code: 'bad-path', message: 'Invalid GitHub request.' } };
  }
  const token = await ghToken();
  if (!token) return { ok: false, status: 0, error: { code: 'not-connected', message: 'Connect GitHub first.' } };
  const attempt = async () => {
    const headers = {
      'Accept': 'application/vnd.github+json',
      'Authorization': 'Bearer ' + token,
      'X-GitHub-Api-Version': '2022-11-28'
    };
    if (opts.body) headers['Content-Type'] = 'application/json';
    const init = { method: opts.method || 'GET', headers: headers };
    if (opts.body) init.body = JSON.stringify(opts.body);
    const res = await ghWithTimeout(fetch(GH_API + path, init), GH_TIMEOUT_MS);
    let text;
    try { text = await res.text(); } catch (e) { /* empty body */ }
    let body = null;
    if (text) { try { body = JSON.parse(text); } catch (e) { body = null; } }
    const headersOut = {};
    ['x-ratelimit-remaining', 'x-ratelimit-reset', 'x-oauth-scopes'].forEach(k => {
      try { if (res.headers && res.headers.get) headersOut[k] = res.headers.get(k); } catch (e) { /* ignore */ }
    });
    return { res: res, body: body, headers: headersOut };
  };
  let result;
  try {
    result = await attempt();
  } catch (e) {
    if (e && e.code === 'timeout') return { ok: false, status: 0, error: { code: 'timeout', message: ghScrub(e.message) } };
    return { ok: false, status: 0, error: { code: 'network', message: ghScrub((e && e.message) || 'Could not reach GitHub.') } };
  }
  const status = result.res && typeof result.res.status === 'number' ? result.res.status : 0;
  const ok = result.res && result.res.ok !== false && status >= 200 && status < 300;
  // One retry for a transient server error on a read. Writes are never retried
  // automatically: a retried commit can duplicate history.
  if (!ok && (opts.method || 'GET') === 'GET' && status >= 500 && !opts.retried) {
    await new Promise(r => setTimeout(r, 300));
    return ghRequest(path, Object.assign({}, opts, { retried: true }));
  }
  return {
    ok: ok, status: status, body: result.body, headers: result.headers,
    rate: result.headers['x-ratelimit-remaining'], error: ok ? null : ghErrorOf(status, result.body, result.headers)
  };
}

/* --- repository & account operations --- */

async function ghStatus() {
  const token = await ghToken();
  if (!token) return { connected: false };
  const r = await ghRequest('/user');
  if (!r.ok) return { connected: false, stale: true, error: r.error };
  const b = r.body || {};
  return { connected: true, login: b.login, name: b.name || '', avatar: b.avatar_url || '', scopes: r.headers['x-oauth-scopes'] || '', rate: r.rate };
}

async function ghRepos() {
  const r = await ghRequest('/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member');
  if (!r.ok) return { ok: false, error: r.error };
  const list = (Array.isArray(r.body) ? r.body : []).slice(0, 100).map(x => ({
    fullName: x.full_name || '', private: !!x.private, defaultBranch: x.default_branch || 'main',
    updatedAt: x.updated_at || '', description: x.description || '', empty: !x.size
  }));
  return { ok: true, repos: list };
}

async function ghBranches(repo) {
  if (!GH_REPO_RE.test(String(repo))) return { ok: false, error: { code: 'bad-repo', message: 'Pick a repository first.' } };
  const r = await ghRequest('/repos/' + repo + '/branches?per_page=100');
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, branches: (Array.isArray(r.body) ? r.body : []).slice(0, 100).map(b => ({ name: b.name, sha: b.commit && b.commit.sha, protected: !!(b.protected) })) };
}

async function ghCreateRepo(opts) {
  const name = String(opts && opts.name || '');
  if (!GH_NAME_RE.test(name)) return { ok: false, error: { code: 'bad-name', message: 'Repository names may use letters, numbers, dot, dash and underscore.' } };
  const body = { name: name, private: opts.private !== false, description: String(opts.description || '').slice(0, 200), auto_init: true };
  const r = await ghRequest('/user/repos', { method: 'POST', body: body });
  if (!r.ok) return { ok: false, error: r.error };
  const b = r.body || {};
  return { ok: true, repo: { fullName: b.full_name, defaultBranch: b.default_branch || 'main', private: !!b.private, url: b.html_url } };
}

/** Remote file list (paths only), for the commit preview. */
/* ---------- git blob hashes ---------- */
/**
 * Git's object name for a file: SHA-1 of "blob <bytes>\0" + the UTF-8 content.
 * With it the preview can say added / modified / unchanged exactly, and a push
 * whose tree would be identical to the parent can be refused instead of creating
 * an empty commit.
 */
function utf8Of(text) {
  const out = [];
  const str = String(text == null ? '' : text);
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const low = str.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (low - 0xdc00);
        i++;
        out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      } else out.push(0xef, 0xbf, 0xbd);
    } else if (c >= 0xd800 && c <= 0xdfff) out.push(0xef, 0xbf, 0xbd);
    else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}
function sha1Hex(bytes) {
  const ml = bytes.length * 8;
  const buf = bytes.slice();
  buf.push(0x80);
  while (buf.length % 64 !== 56) buf.push(0);
  const hi = Math.floor(ml / 0x100000000), lo = ml >>> 0;
  buf.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255);
  buf.push((lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255);
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Array(80);
  const rol = (n, k) => ((n << k) | (n >>> (32 - k))) >>> 0;
  for (let i = 0; i < buf.length; i += 64) {
    for (let j = 0; j < 16; j++) {
      w[j] = (buf[i + j * 4] << 24) | (buf[i + j * 4 + 1] << 16) | (buf[i + j * 4 + 2] << 8) | buf[i + j * 4 + 3];
    }
    for (let j = 16; j < 80; j++) w[j] = rol(w[j - 3] ^ w[j - 8] ^ w[j - 14] ^ w[j - 16], 1);
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let j = 0; j < 80; j++) {
      let f, k;
      if (j < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (j < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (j < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const t = (rol(a, 5) + (f >>> 0) + e + k + (w[j] >>> 0)) >>> 0;
      e = d; d = c; c = rol(b, 30); b = a; a = t;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
  }
  return [h0, h1, h2, h3, h4].map(h => ('00000000' + h.toString(16)).slice(-8)).join('');
}
function gitBlobSha(text) {
  const body = utf8Of(text);
  const head = utf8Of('blob ' + body.length + '\u0000');
  return sha1Hex(head.concat(body));
}

async function ghRemoteFiles(repo, branch, local) {
  if (!GH_REPO_RE.test(String(repo))) return { ok: false, error: { code: 'bad-repo', message: 'Pick a repository first.' } };
  if (branch && !GH_BRANCH_RE.test(String(branch))) return { ok: false, error: { code: 'bad-branch', message: 'Invalid branch name.' } };
  const ref = branch || 'HEAD';
  const r = await ghRequest('/repos/' + repo + '/git/trees/' + encodeURIComponent(ref) + '?recursive=1');
  // An empty repository (no commits yet) answers 404/409: that is a valid state,
  // not a failure — everything local is then "added".
  if (!r.ok && (r.status === 404 || r.status === 409)) {
    // Empty repository: every local file is new, and nothing is deleted.
    const fresh = (Array.isArray(local) ? local : [])
      .filter(f => f && typeof f.path === 'string' && GH_PATH_RE.test(f.path))
      .slice(0, GH_MAX_FILES)
      .map(f => ({ path: f.path, status: 'added', sha: gitBlobSha(f.content) }));
    return { ok: true, files: [], headSha: '', empty: true, truncated: false, local: fresh, deleted: [] };
  }
  if (!r.ok) return { ok: false, error: r.error };
  const remote = {};
  const blobs = (r.body && Array.isArray(r.body.tree) ? r.body.tree : []).filter(x => x.type === 'blob');
  blobs.slice(0, 2000).forEach(x => { remote[x.path] = { sha: x.sha, size: x.size }; });
  const head = branch ? await ghRef(repo, branch) : { ok: true, sha: '' };
  const files = Object.keys(remote).map(path => ({ path: path, sha: remote[path].sha, size: remote[path].size }));
  const out = { ok: true, files: files, headSha: (head && head.sha) || '', empty: false, truncated: !!(r.body && r.body.truncated) };

  // Compare against the files the panel is about to send, when it sent them.
  if (Array.isArray(local) && local.length) {
    const mine = {};
    local.slice(0, GH_MAX_FILES).forEach(f => {
      if (!f || typeof f.path !== 'string' || !GH_PATH_RE.test(f.path)) return;
      mine[f.path] = gitBlobSha(f.content);
    });
    out.local = Object.keys(mine).map(path => {
      const known = remote[path];
      return { path: path, status: !known ? 'added' : known.sha === mine[path] ? 'unchanged' : 'modified', sha: mine[path] };
    });
    out.deleted = Object.keys(remote).filter(path => mine[path] === undefined).map(path => ({ path: path, status: 'deleted', sha: remote[path].sha }));
  }
  return out;
}

async function ghDefaultBranch(repo) {
  const r = await ghRequest('/repos/' + repo);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, branch: (r.body && r.body.default_branch) || 'main' };
}

async function ghRef(repo, branch) {
  const r = await ghRequest('/repos/' + repo + '/git/ref/heads/' + encodeURIComponent(branch));
  if (r.ok) return { ok: true, sha: r.body && r.body.object && r.body.object.sha, exists: true };
  if (r.status === 404 || r.status === 409) return { ok: true, sha: null, exists: false };
  return { ok: false, error: r.error };
}

/**
 * Publish generated files as one commit.
 *  1. resolve the branch head (optionally verifying the sha the panel previewed)
 *  2. create blobs, a tree on top of the head, and a commit
 *  3. move the branch with force:false, so a concurrent push is rejected, not lost
 * Nothing is written until every blob exists, and a failed push leaves the branch
 * untouched and retryable.
 */
async function ghCommit(job) {
  const repo = String(job.repo || '');
  const branch = String(job.branch || '');
  const files = job.files || [];
  if (!GH_REPO_RE.test(repo)) return { ok: false, error: { code: 'bad-repo', message: 'Pick a repository first.' } };
  if (!GH_BRANCH_RE.test(branch) || branch.indexOf('..') > -1) return { ok: false, error: { code: 'bad-branch', message: 'Invalid branch name.' } };
  if (!files.length) return { ok: false, error: { code: 'no-files', message: 'Nothing selected to commit.' } };
  if (files.length > GH_MAX_FILES) return { ok: false, error: { code: 'too-many', message: 'Select at most ' + GH_MAX_FILES + ' files.' } };
  let total = 0;
  for (const f of files) {
    if (!GH_PATH_RE.test(f.path)) return { ok: false, error: { code: 'bad-path', message: 'Unsafe file path: ' + String(f.path).slice(0, 120) } };
    total += String(f.content || '').length;
  }
  if (total > GH_MAX_BYTES) return { ok: false, error: { code: 'too-large', message: 'The selected files are ' + Math.round(total / 1024) + ' kB; the limit is ' + Math.round(GH_MAX_BYTES / 1024) + ' kB.' } };

  const head = await ghRef(repo, branch);
  if (!head.ok) return { ok: false, error: head.error };
  let parentSha = head.sha;
  if (!head.exists) {
    if (!job.createBranch) return { ok: false, error: { code: 'no-branch', message: 'Branch "' + branch + '" does not exist. Create it from the default branch first.' } };
    const def = await ghDefaultBranch(repo);
    if (!def.ok) return { ok: false, error: def.error };
    const base = await ghRef(repo, def.branch);
    if (!base.ok) return { ok: false, error: base.error };
    parentSha = base.sha;
    if (!parentSha) return { ok: false, error: { code: 'no-branch', message: 'The repository has no commits yet. Add a README on GitHub, then try again.' } };
  }
  // The panel previewed against a specific head; if it moved, stop before writing.
  if (job.baseSha && head.exists && job.baseSha !== parentSha) {
    return { ok: false, error: { code: 'conflict', message: 'The branch moved since you previewed these changes (' + String(parentSha).slice(0, 7) + '). Preview again to see the new state.' } };
  }

  const commitRes = await ghRequest('/repos/' + repo + '/git/commits/' + parentSha);
  if (!commitRes.ok) return { ok: false, error: commitRes.error };
  const baseTree = commitRes.body && commitRes.body.tree && commitRes.body.tree.sha;

  const entries = [];
  for (const f of files) {
    if (f.del) {
      // `sha: null` removes the path from the tree; no blob is written.
      entries.push({ path: f.path, mode: '100644', type: 'blob', sha: null });
      continue;
    }
    const blob = await ghRequest('/repos/' + repo + '/git/blobs', { method: 'POST', body: { content: f.content, encoding: 'utf-8' } });
    if (!blob.ok) return { ok: false, error: blob.error, stage: 'blob', file: f.path };
    entries.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.body && blob.body.sha });
  }
  const tree = await ghRequest('/repos/' + repo + '/git/trees', { method: 'POST', body: { base_tree: baseTree, tree: entries } });
  if (!tree.ok) return { ok: false, error: tree.error, stage: 'tree' };
  if (tree.body && tree.body.sha && baseTree && tree.body.sha === baseTree) {
    // Nothing would actually change: an empty commit is worse than an honest refusal.
    return { ok: false, error: { code: 'no-changes', message: 'Every selected file already matches the repository — there is nothing to commit.' }, stage: 'tree' };
  }
  const commit = await ghRequest('/repos/' + repo + '/git/commits', {
    method: 'POST',
    body: { message: String(job.message || 'Update from DevReady').slice(0, 500), tree: tree.body && tree.body.sha, parents: [parentSha] }
  });
  if (!commit.ok) return { ok: false, error: commit.error, stage: 'commit' };
  const sha = commit.body && commit.body.sha;

  const moved = head.exists
    ? await ghRequest('/repos/' + repo + '/git/refs/heads/' + encodeURIComponent(branch), { method: 'PATCH', body: { sha: sha, force: false } })
    : await ghRequest('/repos/' + repo + '/git/refs', { method: 'POST', body: { ref: 'refs/heads/' + branch, sha: sha } });
  if (!moved.ok) {
    const err = moved.error;
    // 422 on a non-forced ref update means the branch advanced underneath us.
    if (moved.status === 422) return { ok: false, error: { code: 'conflict', message: 'Someone pushed to "' + branch + '" while committing. Nothing was overwritten — preview and try again.' }, stage: 'push' };
    return { ok: false, error: err, stage: 'push' };
  }
  return { ok: true, sha: sha, branch: branch, repo: repo, files: files.length, created: !head.exists,
    url: 'https://github.com/' + repo + '/commit/' + sha };
}

/* ---------- Prototype interactions ---------- */
const TRIGGERS = { ON_CLICK: 'On click', ON_HOVER: 'On hover', ON_PRESS: 'On press', ON_DRAG: 'On drag', MOUSE_ENTER: 'Mouse enter', MOUSE_LEAVE: 'Mouse leave',
  MOUSE_UP: 'Mouse up', MOUSE_DOWN: 'Mouse down', WHILE_HOVERING: 'While hovering', WHILE_PRESSED: 'While pressing', ON_KEY_DOWN: 'Key / gamepad', ON_MEDIA_HIT: 'Media hits time', ON_MEDIA_END: 'Media ends' };
const NAVS = { NAVIGATE: 'Navigate to', SWAP: 'Swap overlay', OVERLAY: 'Open overlay', SCROLL_TO: 'Scroll to', CHANGE_TO: 'Change to' };
async function nodeName(id) { try { const n = id && await figma.getNodeByIdAsync(id); return n ? n.name : ''; } catch (e) { return ''; } }
async function actionLabel(a) {
  if (!a) return '';
  if (a.type === 'BACK') return 'Back';
  if (a.type === 'CLOSE') return 'Close overlay';
  if (a.type === 'URL') return 'Open link · ' + a.url;
  if (a.type === 'SET_VARIABLE') { let nm = ''; try { const v = await figma.variables.getVariableByIdAsync(a.variableId); nm = v ? v.name : ''; } catch (e) { /* ignore */ } return 'Set variable' + (nm ? ' · ' + nm : ''); }
  if (a.type === 'SET_VARIABLE_MODE') return 'Set variable mode';
  if (a.type === 'CONDITIONAL') return 'Conditional';
  if (a.type === 'UPDATE_MEDIA_RUNTIME') return 'Media · ' + String(a.mediaAction || '').toLowerCase().replace(/_/g, ' ');
  if (a.type === 'NODE') {
    const dest = await nodeName(a.destinationId);
    const tr = a.transition ? ' · ' + String(a.transition.type).toLowerCase().replace(/_/g, ' ') + (a.transition.duration ? ' ' + Math.round(a.transition.duration * 1000) + 'ms' : '') : '';
    return (NAVS[a.navigation] || 'Go to') + (dest ? ' ' + dest : '') + tr;
  }
  return String(a.type).toLowerCase().replace(/_/g, ' ');
}
async function interactionsOf(node) {
  if (!('reactions' in node) || !node.reactions || !node.reactions.length) return undefined;
  const out = [];
  for (const r of node.reactions.slice(0, 8)) {
    const t = r.trigger || {};
    let trig = TRIGGERS[t.type] || String(t.type || 'Trigger').toLowerCase().replace(/_/g, ' ');
    if (t.type === 'AFTER_TIMEOUT') trig = 'After ' + Math.round((t.timeout || 0) * 1000) + 'ms';
    else if (t.delay) trig += ' · ' + Math.round(t.delay * 1000) + 'ms delay';
    const acts = r.actions || (r.action ? [r.action] : []);
    const labels = [];
    for (const a of acts) { const l = await actionLabel(a); if (l) labels.push(l); }
    out.push({ trigger: trig, actions: labels });
  }
  return out;
}

/* ---------- Annotations ---------- */
async function annCategories() {
  try {
    if (figma.annotations && figma.annotations.getAnnotationCategoriesAsync) {
      return (await figma.annotations.getAnnotationCategoriesAsync()).map(c => ({ id: c.id, label: c.label, color: c.color }));
    }
  } catch (e) { /* ignore */ }
  return [];
}
const NOTE_COLORS = { yellow: [1, 0.78, 0.16], orange: [1, 0.55, 0.1], red: [0.95, 0.28, 0.13], pink: [0.95, 0.35, 0.65], violet: [0.6, 0.28, 1], blue: [0.05, 0.6, 1], teal: [0.03, 0.7, 0.72], green: [0.08, 0.68, 0.36] };
function canvasNotesFor(id) {
  try { return figma.currentPage.findChildren(n => n.getSharedPluginData(NS, 'note') === id); } catch (e) { return []; }
}
/** Visible-on-every-plan fallback: a locked sticky note next to the layer, with a leader line. */
async function drawCanvasNote(node, text, color) {
  if (IS_DEV) return false;
  const bb = node.absoluteBoundingBox; if (!bb) return false;
  let top = node; while (top.parent && top.parent.type !== 'PAGE' && top.parent.type !== 'SECTION') top = top.parent;
  const tb = top.absoluteBoundingBox || bb;
  await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
  await figma.loadFontAsync({ family: 'Inter', style: 'Semi Bold' });
  const c = NOTE_COLORS[color] || NOTE_COLORS.green, RGB = { r: c[0], g: c[1], b: c[2] };
  const existing = canvasNotesFor(node.id);
  const card = figma.createFrame();
  card.name = 'Note'; card.layoutMode = 'VERTICAL'; card.primaryAxisSizingMode = 'AUTO'; card.counterAxisSizingMode = 'FIXED';
  card.resize(260, 40); card.paddingLeft = card.paddingRight = 12; card.paddingTop = card.paddingBottom = 10; card.itemSpacing = 4;
  card.cornerRadius = 8; card.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
  card.strokes = [{ type: 'SOLID', color: RGB }]; card.strokeWeight = 1.5;
  card.effects = [{ type: 'DROP_SHADOW', color: { r: 0, g: 0, b: 0, a: 0.12 }, offset: { x: 0, y: 2 }, radius: 8, spread: 0, visible: true, blendMode: 'NORMAL' }];
  const h = figma.createText(); h.fontName = { family: 'Inter', style: 'Semi Bold' }; h.fontSize = 10; h.characters = '📝 ' + node.name; h.fills = [{ type: 'SOLID', color: RGB }];
  const t = figma.createText(); t.fontName = { family: 'Inter', style: 'Regular' }; t.fontSize = 12; t.lineHeight = { unit: 'PIXELS', value: 17 };
  t.characters = String(text).replace(/[#*_`>]/g, '').trim() || '(note)'; t.fills = [{ type: 'SOLID', color: { r: 0.1, g: 0.1, b: 0.1 } }];
  card.appendChild(h); card.appendChild(t); h.layoutAlign = 'STRETCH'; t.layoutAlign = 'STRETCH'; t.textAutoResize = 'HEIGHT';
  const cy = bb.y + bb.height / 2;
  card.x = tb.x + tb.width + 48;
  card.y = cy - 16 + existing.reduce((sum, g) => sum + g.height + 8, 0);
  const startX = bb.x + bb.width;
  const line = figma.createRectangle(); line.name = 'Leader'; line.fills = [{ type: 'SOLID', color: RGB }];
  line.resize(Math.max(1, card.x - startX), 1.5); line.x = startX; line.y = cy - 0.75;
  const dot = figma.createEllipse(); dot.name = 'Dot'; dot.resize(8, 8); dot.x = startX - 4; dot.y = cy - 4; dot.fills = [{ type: 'SOLID', color: RGB }];
  const g = figma.group([line, dot, card], figma.currentPage);
  g.name = '📝 DevReady note · ' + node.name; g.locked = true;
  g.setSharedPluginData(NS, 'note', node.id); g.setSharedPluginData(NS, 'noteText', String(text));
  return true;
}
function annotateError(e, node) {
  const m = String(e && e.message || e);
  if (/instance/i.test(m)) return new Error('Figma can’t annotate this layer inside an instance — annotate the instance itself or the main component.');
  if (/permission|read.?only|edit access|cannot (set|edit)/i.test(m)) return new Error('No edit access — annotations need a Full seat with “can edit” access to this file.');
  return new Error('Could not add the annotation on “' + node.name + '”: ' + m);
}
function inViewport(node) {
  const v = figma.viewport.bounds, b = node.absoluteBoundingBox;
  return b && b.x < v.x + v.width && b.x + b.width > v.x && b.y < v.y + v.height && b.y + b.height > v.y;
}
function cleanAnnotation(a) {
  const o = {};
  if (a.labelMarkdown) o.labelMarkdown = a.labelMarkdown; else if (a.label) o.label = a.label;
  if (a.properties && a.properties.length) o.properties = a.properties.map(p => ({ type: p.type }));
  if (a.categoryId) o.categoryId = a.categoryId;
  return o;
}
/* ------------------------------------------------------------------ */
/* Measurements & redlines                                             */
/* ------------------------------------------------------------------ */
function measurePair(a, b) {
  const A = a.absoluteBoundingBox, B = b.absoluteBoundingBox;
  if (!A || !B) return null;
  const inside = (o, i) => i.x >= o.x && i.y >= o.y && i.x + i.width <= o.x + o.width && i.y + i.height <= o.y + o.height;
  const segs = [];
  let result;
  if (inside(A, B) || inside(B, A)) {
    const O = inside(A, B) ? A : B, I = O === A ? B : A;
    const cx = I.x + I.width / 2, cy = I.y + I.height / 2;
    result = {
      mode: 'inset',
      outer: O === A ? a.name : b.name,
      inner: O === A ? b.name : a.name,
      top: round(I.y - O.y), left: round(I.x - O.x),
      right: round(O.x + O.width - (I.x + I.width)), bottom: round(O.y + O.height - (I.y + I.height))
    };
    segs.push({ x1: cx, y1: O.y, x2: cx, y2: I.y, v: result.top });
    segs.push({ x1: cx, y1: I.y + I.height, x2: cx, y2: O.y + O.height, v: result.bottom });
    segs.push({ x1: O.x, y1: cy, x2: I.x, y2: cy, v: result.left });
    segs.push({ x1: I.x + I.width, y1: cy, x2: O.x + O.width, y2: cy, v: result.right });
  } else {
    result = { mode: 'gap', a: a.name, b: b.name, horizontal: null, vertical: null };
    const oy1 = Math.max(A.y, B.y), oy2 = Math.min(A.y + A.height, B.y + B.height);
    const ox1 = Math.max(A.x, B.x), ox2 = Math.min(A.x + A.width, B.x + B.width);
    const midY = oy2 > oy1 ? (oy1 + oy2) / 2 : A.y + A.height / 2;
    const midX = ox2 > ox1 ? (ox1 + ox2) / 2 : A.x + A.width / 2;
    if (B.x >= A.x + A.width) { result.horizontal = round(B.x - (A.x + A.width)); segs.push({ x1: A.x + A.width, y1: midY, x2: B.x, y2: midY, v: result.horizontal }); }
    else if (A.x >= B.x + B.width) { result.horizontal = round(A.x - (B.x + B.width)); segs.push({ x1: B.x + B.width, y1: midY, x2: A.x, y2: midY, v: result.horizontal }); }
    if (B.y >= A.y + A.height) { result.vertical = round(B.y - (A.y + A.height)); segs.push({ x1: midX, y1: A.y + A.height, x2: midX, y2: B.y, v: result.vertical }); }
    else if (A.y >= B.y + B.height) { result.vertical = round(A.y - (B.y + B.height)); segs.push({ x1: midX, y1: B.y + B.height, x2: midX, y2: A.y, v: result.vertical }); }
  }
  result.segments = segs;
  return result;
}
function measureToParent(node) {
  const p = node.parent;
  if (!p || !('absoluteBoundingBox' in p) || !p.absoluteBoundingBox || p.type === 'PAGE') return null;
  return measurePair(p, node);
}

async function drawRedlines(segments) {
  if (IS_DEV) throw new Error('Redlines need Design mode (Dev Mode is read-only).');
  await figma.loadFontAsync({ family: 'Inter', style: 'Medium' });
  const RED = [{ type: 'SOLID', color: { r: 0.96, g: 0.26, b: 0.21 } }];
  const nodes = [];
  for (const s of segments) {
    if (!s.v) continue;
    const horizontal = Math.abs(s.y1 - s.y2) < 0.01;
    const line = figma.createRectangle();
    line.fills = RED;
    if (horizontal) { line.resize(Math.max(Math.abs(s.x2 - s.x1), 0.01), 1); line.x = Math.min(s.x1, s.x2); line.y = s.y1 - 0.5; }
    else { line.resize(1, Math.max(Math.abs(s.y2 - s.y1), 0.01)); line.x = s.x1 - 0.5; line.y = Math.min(s.y1, s.y2); }
    nodes.push(line);

    const pill = figma.createFrame();
    pill.layoutMode = 'HORIZONTAL';
    pill.primaryAxisSizingMode = 'AUTO';
    pill.counterAxisSizingMode = 'AUTO';
    pill.paddingLeft = pill.paddingRight = 4;
    pill.paddingTop = pill.paddingBottom = 1;
    pill.cornerRadius = 3;
    pill.fills = RED;
    const t = figma.createText();
    t.fontName = { family: 'Inter', style: 'Medium' };
    t.fontSize = 10;
    t.characters = String(round(s.v, 1));
    t.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
    pill.appendChild(t);
    const cx = (s.x1 + s.x2) / 2, cy = (s.y1 + s.y2) / 2;
    pill.x = horizontal ? cx - pill.width / 2 : cx + 4;
    pill.y = horizontal ? cy - pill.height - 3 : cy - pill.height / 2;
    nodes.push(pill);
  }
  if (!nodes.length) return 0;
  const g = figma.group(nodes, figma.currentPage);
  g.name = '📏 DevReady redlines';
  g.locked = true;
  g.setSharedPluginData(NS, 'redlines', '1');
  return segments.length;
}
function clearRedlines() {
  if (IS_DEV) return 0;
  const found = figma.currentPage.findChildren(n => n.getSharedPluginData(NS, 'redlines') === '1');
  found.forEach(n => n.remove());
  return found.length;
}

/* ================================================================== */
/* MODE 1: Codegen (Dev Mode → Code section)                           */
/* ================================================================== */
if (figma.mode === 'codegen') {
  figma.codegen.on('generate', async function (event) {
    const node = event.node;
    const prefs = figma.codegen.preferences || {};
    const unit = prefs.unit === 'SCALED' ? 'rem' : 'px';
    const base = prefs.scaleFactor || 16;
    const gate = (prefs.customSettings && prefs.customSettings.gate) || 'strict';
    const status = findDevStatus(node);
    if (gate === 'strict' && !status) {
      return [{
        title: '🔒 Not ready for dev',
        language: 'PLAINTEXT',
        code: '"' + node.name + '" is not inside a design marked "Ready for dev".\n\n' +
          'Ask the designer to mark the frame/section as Ready for dev,\n' +
          'or switch the "Dev-ready gate" preference to "Always generate".'
      }];
    }
    let header = status ? (status.type === 'COMPLETED' ? '✅ Completed' : '🟢 Ready for dev') + ' · ' + status.nodeName : '⚪ No dev status (gate off)';
    try {
      if (status) { const cont = await figma.getNodeByIdAsync(status.nodeId); const d = cont && diffBaseline(cont); if (d && d.count) header += ' · ⚠ ' + d.count + ' change' + (d.count > 1 ? 's' : '') + ' since ready'; }
    } catch (e) { /* ignore */ }
    const out = await generateCode(node, event.language, unit, base, 150, { inlineBudget: 400 * 1024, fastFonts: true });
    const res = out.files.map((f, i) => ({ title: (i === 0 ? header + '  ·  ' : '') + f.name, language: CODEGEN_LANG[f.lang] || 'PLAINTEXT', code: f.code }));
    if (out.assets.length) res.push({ title: 'Assets (export from the DevReady panel → Download project)', language: 'PLAINTEXT', code: out.assets.map(a => 'assets/' + a.file + (a.scale > 1 ? '  (@' + a.scale + 'x)' : '')).join('\n') });
    return res;
  });
} else {
  /* ================================================================ */
  /* MODE 2: Inspect UI (Design mode + Dev Mode Inspect panel)        */
  /* ================================================================ */
  figma.showUI(__html__, { width: 480, height: 820, themeColors: true, title: 'DevReady Inspect' });

  let reqId = 0;
  let timer = null;
  let lastSegments = [];
  let lastThumbKey = '';

  function post(msg) { figma.ui.postMessage(msg); }

  async function refresh() {
    const my = ++reqId;
    clearDiagnostics(); // notes describe this pass only
    const sel = figma.currentPage.selection;
    const base = { editor: figma.editorType, isDev: IS_DEV, settings: settings,
      limits: { maxDepth: MAX_DEPTH, snapLimit: SNAP_LIMIT, snapBytes: SNAP_BYTES, a11yLimit: 400, run: RUN_LIMITS } };

    if (!sel.length) {
      lastSegments = [];
      lastThumbKey = '';
      post(Object.assign({ type: 'state', mode: 'empty', ready: listReady(), page: figma.currentPage.name }, base));
      return;
    }

    const node = sel[0];
    const status = findDevStatus(node);
    const targets = statusTargets(node);
    // Where a status would go, and whether Figma itself can hold it. The panel
    // uses this to explain why a group needs the DevReady flag instead.
    const targetInfo = targets.flag ? { id: targets.flag.id, name: targets.flag.name, type: targets.flag.type, native: !!targets.native } : null;

    if (settings.gate === 'strict' && !status) {
      lastSegments = [];
      lastThumbKey = '';
      post(Object.assign({
        type: 'state', mode: 'locked',
        node: { id: node.id, name: node.name, type: node.type },
        target: targetInfo,
        ready: listReady(),
        diagnostics: takeDiagnostics()
      }, base));
      return;
    }

    post({ type: 'loading' });
    const spec = await extractSpec(node);
    if (my !== reqId) return;
    const css = await safeCSS(node);
    if (my !== reqId) return;

    let measure = null;
    if (sel.length === 2) measure = measurePair(sel[0], sel[1]);
    else if (sel.length === 1) measure = measureToParent(node);
    lastSegments = measure ? measure.segments : [];

    // Changes since the design was handed off
    let changes = null;
    if (status && status.type !== 'COMPLETED_NONE') {
      try {
        const cont = await figma.getNodeByIdAsync(status.nodeId);
        if (cont) changes = diffBaseline(cont) || { none: true, containerId: cont.id, containerName: cont.name };
      } catch (e) { diag('change history', e); }
    }
    if (my !== reqId) return;

    let a11y = null;
    try { a11y = a11yAudit(node, 400, await readA11yIgnore()); } catch (e) { diag('accessibility audit', e); }
    if (my !== reqId) return;

    const assets = collectAssets(node, 120, settings.svgFrames);
    const complexity = assessComplexity(node);
    // Include the selected node itself as the first asset row
    assets.unshift({ id: node.id, name: node.name, type: node.type, kind: 'selection', w: round(node.width), h: round(node.height) });

    post(Object.assign({
      type: 'state', mode: 'inspect',
      count: sel.length,
      status: status,
      target: targetInfo,
      spec: spec,
      css: groupedCSS(css, settings.unit, settings.remBase, spec.text && spec.text.segments[0] ? spec.text.segments[0].styleName : null),
      tailwind: cssToTailwind(css, settings.unit, settings.remBase).join(' '),
      measure: measure,
      changes: changes,
      a11y: a11y,
      assets: assets,
      complexity: complexity,
      diagnostics: takeDiagnostics()
    }, base));

    // Thumbnails (only when the selection itself changes, not on every edit)
    const key = sel.map(n => n.id).join(',');
    if (key !== lastThumbKey) {
      lastThumbKey = key;
      for (const a of assets.slice(0, 24)) {
        if (my !== reqId) return;
        try {
          const n = await figma.getNodeByIdAsync(a.id);
          const big = Math.max(n.width, n.height) || 1;
          const bytes = await n.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: Math.min(4, 160 / big) } });
          if (my !== reqId) return;
          post({ type: 'thumb', id: a.id, bytes: bytes });
        } catch (e) { /* skip */ }
      }
    }
  }

  function schedule(delay) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; refresh().catch(err => post({ type: 'error', message: String(err && err.message || err) })); }, typeof delay === 'number' ? delay : 120);
  }

  // One listener per page, not one per page switch: without detaching, switching
  // pages 30 times leaves 30 handlers running the same refresh.
  let watchedPage = null;
  let watchedHandler = null;
  function watchPage() {
    try {
      if (watchedPage && watchedHandler && typeof watchedPage.off === 'function') watchedPage.off('nodechange', watchedHandler);
    } catch (e) { /* older Figma */ }
    watchedPage = figma.currentPage;
    watchedHandler = null;
    try {
      watchedHandler = function () {
        // A variable/style rename or an edit inside a baseline container must be
        // visible on the next refresh, so drop the lookup caches with the diffs.
        clearLookupCaches();
        schedule(400);
      };
      watchedPage.on('nodechange', watchedHandler);
    } catch (e) { /* ignore */ }
  }

  figma.on('selectionchange', () => schedule(80));
  figma.on('currentpagechange', () => { watchPage(); schedule(); });
  watchPage();

  figma.ui.onmessage = async function (raw) {
    const msg = validateMsg(raw);
    if (!msg) return; // unknown message type: ignore
    if (msg.type === '__invalid') { figma.notify('DevReady: invalid ' + msg.field + ' for ' + msg.of, { error: true }); return; }
    try {
      switch (msg.type) {
        case 'ui-ready': {
          const saved = await figma.clientStorage.getAsync('devready-settings');
          if (saved) settings = Object.assign({}, DEFAULT_SETTINGS, MSG_SCHEMA.settings.settings(saved) || {});
          schedule();
          break;
        }
        case 'settings': {
          settings = Object.assign({}, settings, msg.settings);
          await figma.clientStorage.setAsync('devready-settings', settings);
          schedule();
          break;
        }
        case 'select': {
          const n = await figma.getNodeByIdAsync(msg.id);
          if (n && n.type !== 'PAGE' && n.type !== 'DOCUMENT') {
            figma.currentPage.selection = [n];
            figma.viewport.scrollAndZoomIntoView([n]);
          }
          break;
        }
        case 'mark': {
          const r = await setReady(msg.id, msg.status, msg.note);
          if (r.ok) {
            if (msg.status) {
              const label = r.name + (msg.status === 'COMPLETED' ? ' marked Completed' : ' marked Ready for dev');
              figma.notify(r.native ? '🟢 ' + label : '🟢 ' + r.name + ' flagged ready (Figma status not available on this layer type or plan)');
            } else figma.notify('"' + r.name + '" status cleared');
          } else figma.notify(r.error, { error: true });
          schedule();
          break;
        }
        case 'export': {
          const f = await exportNode(msg.id, msg.format, msg.scale);
          post({ type: 'download', files: [f], zip: false });
          break;
        }
        case 'export-all': {
          const files = [];
          const used = {};
          const failures = [];
          for (const item of msg.items) {
            try {
              const f = await exportNode(item.id, item.format, item.scale);
              let name = f.name;
              if (used[name]) { used[name]++; name = name.replace(/(\.[a-z]+)$/, '-' + used[name] + '$1'); } else used[name] = 1;
              files.push({ name: name, bytes: f.bytes });
            } catch (e) {
              failures.push(item.id + ': ' + (e && e.message ? e.message : String(e)));
            }
          }
          if (failures.length) {
            post({ type: 'error', message: 'Assets not downloaded — export failed: ' + failures.join(', ') });
            break;
          }
          post({ type: 'download', files: files, zip: true, zipName: msg.zipName || 'assets.zip' });
          break;
        }
        case 'gen-code': {
          const sel = figma.currentPage.selection;
          const node = msg.nodeId ? await figma.getNodeByIdAsync(msg.nodeId) : sel[0];
          // Always answer: a deleted layer used to leave the panel on "Building…"
          // forever, because the request was never resolved either way.
          if (!node) {
            post({ type: 'code', lang: msg.lang, requestId: msg.requestId || '', nodeId: msg.nodeId || '', out: {
              files: [{ name: 'error.txt', lang: 'text', code: 'That layer no longer exists — select another layer and try again.' }],
              assets: [], fonts: [], preview: { w: 0, h: 0, inlinedKB: 0 }, truncated: false, assetErrors: [],
              stats: { layers: 0, classes: 0, assets: 0, tokens: 0, modes: 0, mapped: 0 }
            } });
            break;
          }
          const job = { id: msg.jobId || 0, cancelled: false };
          if (job.id) JOBS[job.id] = job;
          let out;
          try {
            out = await generateCode(node, msg.lang, settings.unit, settings.remBase, 600, { job: job, svgFrames: settings.svgFrames });
          } finally {
            if (job.id) delete JOBS[job.id];
          }
          post({ type: 'code', lang: msg.lang, requestId: msg.requestId || '', nodeId: node.id, out: out, cancelled: !!out.cancelled });
          break;
        }
        case 'cancel': {
          const job = JOBS[msg.jobId];
          if (job) job.cancelled = true;
          break;
        }
        case 'thumb-request': {
          // Thumbnails are small PNGs; the panel asks for the ones it actually shows.
          try {
            const n = await figma.getNodeByIdAsync(msg.id);
            if (n && 'exportAsync' in n) {
              const big = Math.max(n.width, n.height) || 1;
              const bytes = await n.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: Math.min(4, 160 / big) } });
              post({ type: 'thumb', id: n.id, bytes: bytes });
            }
          } catch (e) { diag('thumbnail', e); }
          break;
        }
        case 'plan': {
          // Cheap pre-flight for the panel: classification + cost, nothing generated.
          const sel = figma.currentPage.selection.slice(0, 50);
          const nodes = sel.map(n => {
            const complexity = assessComplexity(n);
            const illo = illustrationPlan(n, settings.svgFrames);
            return {
              id: n.id, name: n.name, type: n.type,
              illustration: illo ? { reason: illo.reason, vectors: illo.vectors, nodes: illo.nodes } : null,
              complexity: complexity
            };
          });
          post({ type: 'plan', nodes: nodes, limits: RUN_LIMITS, svgFrames: settings.svgFrames });
          break;
        }
        case 'a11y-ignore': {
          const map = await readA11yIgnore();
          msg.ids.forEach(id => { map[id] = msg.reason || 'Ignored'; });
          const clean = writeA11yIgnore(map);
          post({ type: 'a11y-ignored', ignored: Object.keys(clean).length });
          figma.notify('Accessibility: ' + msg.ids.length + ' finding' + (msg.ids.length === 1 ? '' : 's') + ' ignored' + (msg.reason ? ' · ' + msg.reason : ''));
          schedule();
          break;
        }
        case 'a11y-unignore': {
          const map = await readA11yIgnore();
          msg.ids.forEach(id => { delete map[id]; });
          const clean = writeA11yIgnore(map);
          post({ type: 'a11y-ignored', ignored: Object.keys(clean).length });
          schedule();
          break;
        }
        case 'a11y-report': {
          const node = figma.currentPage.selection[0];
          let audit = null;
          try { if (node) audit = a11yAudit(node, 400, await readA11yIgnore()); } catch (e) { diag('accessibility report', e); }
          post({ type: 'a11y-report', format: msg.format, out: a11yReport(audit, msg.format, { name: node ? node.name : (figma.root.name || 'Design') }) });
          break;
        }
        case 'store-get': {
          post({ type: 'store', key: msg.key, value: await storeGet(msg.key) });
          break;
        }
        case 'store-set': {
          try {
            await storeSet(msg.key, msg.value);
            post({ type: 'store-ok', key: msg.key });
          } catch (e) {
            post({ type: 'store-error', key: msg.key, message: String((e && e.message) || e).slice(0, 200) });
          }
          break;
        }
        case 'gh-status': {
          const st = await ghStatus();
          post({ type: 'gh-status', status: st });
          break;
        }
        case 'gh-connect': {
          await ghSetToken(msg.token);
          const st = await ghStatus();
          if (!st.connected) {
            await ghSetToken(null);
            post({ type: 'gh-status', status: { connected: false, error: st.error || { code: 'auth', message: 'GitHub did not accept that token.' } } });
            break;
          }
          figma.notify('GitHub connected as ' + st.login);
          post({ type: 'gh-status', status: st });
          break;
        }
        case 'gh-disconnect': {
          await ghSetToken(null);
          ghReposCache.length = 0;
          figma.notify('GitHub disconnected — the token was removed from this machine');
          post({ type: 'gh-status', status: { connected: false } });
          break;
        }
        case 'gh-repos': {
          const r = await ghRepos();
          post({ type: 'gh-repos', ok: r.ok, repos: r.repos || [], error: r.error || null });
          break;
        }
        case 'gh-branches': {
          const r = await ghBranches(msg.repo);
          post({ type: 'gh-branches', ok: r.ok, repo: msg.repo, branches: r.branches || [], error: r.error || null });
          break;
        }
        case 'gh-create-repo': {
          const r = await ghCreateRepo(msg);
          post({ type: 'gh-created', ok: r.ok, repo: r.repo || null, error: r.error || null });
          break;
        }
        case 'gh-tree': {
          const r = await ghRemoteFiles(msg.repo, msg.branch, msg.files);
          post({ type: 'gh-tree', ok: r.ok, repo: msg.repo, branch: msg.branch, files: r.files || [], local: r.local || [],
            deleted: r.deleted || [], headSha: r.headSha || '', empty: !!r.empty, truncated: !!r.truncated, error: r.error || null });
          break;
        }
        case 'gh-commit': {
          const r = await ghCommit(msg);
          if (r.ok) figma.notify('Pushed ' + r.files + ' file' + (r.files === 1 ? '' : 's') + ' to ' + r.repo + ' · ' + r.branch);
          else figma.notify('GitHub: ' + r.error.message, { error: true });
          post({ type: 'gh-committed', ok: r.ok, result: r.ok ? { sha: r.sha, url: r.url, branch: r.branch, files: r.files, created: r.created } : null, error: r.error || null, stage: r.stage || '' });
          break;
        }
        case 'tokens-export': {
          const sel = figma.currentPage.selection;
          clearDiagnostics();
          const out = await buildTokens(msg.format, msg.scope, sel[0] || null, settings.unit, settings.remBase);
          post({ type: 'tokens', format: msg.format, scope: msg.scope, out: out, diagnostics: takeDiagnostics() });
          break;
        }
        case 'design-shot': {
          const n = await figma.getNodeByIdAsync(msg.id);
          if (!n || !('exportAsync' in n)) break;
          const big = Math.max(n.width, n.height) || 1;
          const scale = Math.min(2, 4096 / big);
          const bytes = await n.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: scale } });
          post({ type: 'design-shot', id: n.id, bytes: bytes, w: round(n.width), h: round(n.height) });
          break;
        }
        case 'export-project': {
          const sel = figma.currentPage.selection;
          if (!sel.length) break;
          const out = await generateCode(sel[0], msg.lang, settings.unit, settings.remBase, 1500, { withFonts: true, svgFrames: settings.svgFrames });
          const files = out.files.map(f => ({ name: f.name, text: f.code }));
          (out.fontFiles || []).forEach(f => files.push({ name: f.name, bytes: f.bytes }));
          const failures = (out.assetErrors || []).slice();
          for (const a of out.assets) {
            try {
              let bytes, fileName = a.file;
              if (a.imageHash) {
                const img = figma.getImageByHash(a.imageHash);
                if (!img) throw new Error('image data unavailable');
                bytes = await img.getBytesAsync();
                const ext = rasterExtension(bytes);
                if (ext !== 'png') fileName = fileName.replace(/\.png$/i, '.' + ext);
              } else {
                const n = await figma.getNodeByIdAsync(a.id);
                if (!n) throw new Error('layer unavailable');
                const opts = { format: a.format };
                if (a.format === 'PNG' || a.format === 'JPG') opts.constraint = { type: 'SCALE', value: a.scale };
                if (a.format === 'SVG') opts.svgOutlineText = true;
                bytes = await n.exportAsync(opts);
              }
              if (fileName !== a.file) {
                // Rewrite both path references (web/RN/Flutter) and any native
                // renderer that embedded the filename directly.
                files.forEach(f => { if (f.text) f.text = f.text.split(a.file).join(fileName); });
              }
              files.push({ name: 'assets/' + fileName, bytes: bytes });
            } catch (e) { failures.push(a.file + ' (' + String(e && e.message || e) + ')'); }
          }
          if (failures.length) {
            const detail = failures.slice(0, 3).join(', ') + (failures.length > 3 ? ' and ' + (failures.length - 3) + ' more' : '');
            post({ type: 'error', message: 'Project not downloaded — asset export failed: ' + detail + '. Retry in Figma.' });
            break;
          }
          post({ type: 'project', files: files, zipName: slug(sel[0].name) + '-' + msg.lang + '.zip', single: files.length === 1 });
          break;
        }
        case 'font-upload': {
          if (!msg.bytes || msg.bytes.length > 2.5 * 1024 * 1024) { figma.notify('Font file too large (max 2.5 MB) — use .woff2', { error: true }); break; }
          await figma.clientStorage.setAsync('font:' + msg.family + '|' + msg.key, { ext: msg.ext, bytes: msg.bytes, name: msg.name || '' });
          if (msg.last) { figma.notify('🔤 Font saved — it will be embedded in the HTML'); post({ type: 'fonts-updated' }); }
          break;
        }
        case 'font-remove': {
          await figma.clientStorage.deleteAsync('font:' + msg.family + '|' + msg.key);
          figma.notify('Font file removed'); post({ type: 'fonts-updated' });
          break;
        }
        case 'baseline-clear': {
          const n = await figma.getNodeByIdAsync(msg.id);
          if (n) { clearBaseline(n); figma.notify('Snapshot removed from this file'); }
          schedule();
          break;
        }
        case 'baseline-save': {
          const n = await figma.getNodeByIdAsync(msg.id);
          if (n) { saveBaseline(n); figma.notify('✓ Baseline saved — future edits will show as changes'); }
          schedule();
          break;
        }
        case 'measure-native': {
          const sel = figma.currentPage.selection;
          let added = 0, failed = false;
          try { added = addNativeMeasurements(sel); } catch (e) { failed = true; }
          if (added) figma.notify('📏 ' + added + ' measurement' + (added > 1 ? 's' : '') + ' added' + (IS_DEV ? ' (visible in Dev Mode)' : ''));
          else if (!IS_DEV) { const n = await drawRedlines(lastSegments); figma.notify(n ? '📏 Redlines drawn (native measurements unavailable here)' : 'Nothing to measure'); }
          else figma.notify(failed ? 'Measurements API not available in this Figma version' : 'Nothing measurable — select a layer inside a frame, or two layers', { error: !added });
          break;
        }
        case 'measure-clear': {
          const n = clearNativeMeasurements(figma.currentPage.selection);
          const r = IS_DEV ? 0 : clearRedlines();
          figma.notify(n || r ? 'Cleared ' + (n ? n + ' measurement(s)' : '') + (n && r ? ' and ' : '') + (r ? r + ' redline group(s)' : '') : 'No measurements on the selection');
          break;
        }
        case 'annotate-add': {
          const n = await figma.getNodeByIdAsync(msg.id);
          if (!n) break;
          const text = String(msg.label || '').trim();
          if (!('annotations' in n)) {
            // Groups, sections, boolean shapes and slices can't hold native annotations
            if (msg.pin && !IS_DEV && await drawCanvasNote(n, text, msg.color)) { figma.notify('📝 ' + n.type.toLowerCase() + ' layers can’t hold Figma annotations — added a canvas note instead'); schedule(); break; }
            figma.notify('Figma annotations can’t be added to ' + n.type.toLowerCase() + ' layers — select a frame, shape, text or instance', { error: true });
            break;
          }
          const before = n.annotations.length;
          const keep = n.annotations.map(cleanAnnotation);
          const a = {};
          if (text) a.labelMarkdown = text;
          if (msg.prop) a.properties = [{ type: msg.prop }];
          if (msg.cat) a.categoryId = msg.cat;
          let note = '', failErr = null;
          try { n.annotations = keep.concat([a]); }
          catch (e) {
            if (!a.properties && !a.categoryId) failErr = annotateError(e, n);
            else {
              delete a.properties; delete a.categoryId;
              if (!a.labelMarkdown) a.labelMarkdown = '(note)';
              try { n.annotations = keep.concat([a]); note = ' (pinned property not supported on this layer — note only)'; }
              catch (e2) { failErr = annotateError(e2, n); }
            }
          }
          const ok = !failErr && n.annotations.length > before;
          if (failErr && IS_DEV) throw failErr;
          let pinned = false;
          if (msg.pin || !ok) pinned = await drawCanvasNote(n, text || (msg.prop || ''), msg.color).catch(() => false);
          if (!inViewport(n)) { try { figma.viewport.scrollAndZoomIntoView([n]); } catch (e) { /* ignore */ } }
          if (ok) figma.notify('📝 Annotation added' + note + (pinned ? ' + canvas note' : '') + '. Not on canvas? Press Shift+Y (View → Annotations)', { timeout: 6000 });
          else if (failErr && !pinned) throw failErr;
          else figma.notify(pinned ? (failErr ? failErr.message.replace(/\.?$/, '.') + ' Added a canvas note instead.' : 'Figma didn’t keep the native annotation (needs a paid plan) — added a canvas note instead') : 'Figma didn’t keep the annotation — native annotations need a paid plan and edit access', { error: !pinned, timeout: 7000 });
          post({ type: 'ann-result', ok: ok, pinned: pinned });
          schedule();
          break;
        }
        case 'annotate-remove': {
          const n = await figma.getNodeByIdAsync(msg.id);
          if (n && 'annotations' in n) {
            const gone = n.annotations[msg.index];
            n.annotations = n.annotations.map(cleanAnnotation).filter((a, i) => i !== msg.index);
            const txt = gone ? (gone.labelMarkdown || gone.label || '') : '';
            if (!IS_DEV) canvasNotesFor(n.id).filter(g => g.getSharedPluginData(NS, 'noteText') === txt).forEach(g => g.remove());
            figma.notify('Annotation removed');
          }
          schedule();
          break;
        }
        case 'notes-clear': {
          if (IS_DEV) break;
          const all = figma.currentPage.findChildren(g => !!g.getSharedPluginData(NS, 'note'));
          all.forEach(g => g.remove());
          figma.notify(all.length ? 'Removed ' + all.length + ' canvas note(s)' : 'No canvas notes on this page');
          schedule();
          break;
        }
        case 'goto': {
          const n = await figma.getNodeByIdAsync(msg.id);
          if (n) { try { figma.viewport.scrollAndZoomIntoView([n]); } catch (e) { /* ignore */ } }
          break;
        }
        case 'devres-add': {
          const n = await figma.getNodeByIdAsync(msg.id);
          if (!n || !('addDevResourceAsync' in n)) { figma.notify('Dev resources are not supported on this layer', { error: true }); break; }
          await n.addDevResourceAsync(msg.url, msg.name || undefined);
          figma.notify('🔗 Link added');
          schedule();
          break;
        }
        case 'devres-remove': {
          const n = await figma.getNodeByIdAsync(msg.id);
          if (n && 'deleteDevResourceAsync' in n) { await n.deleteDevResourceAsync(msg.url); figma.notify('Link removed'); }
          schedule();
          break;
        }
        case 'map-save': {
          // name/path already validated by MSG_SCHEMA (identifier + safe import path)
          figma.root.setSharedPluginData(NS, 'map:' + msg.key, JSON.stringify({ name: msg.name, path: msg.path || './' + msg.name, at: new Date().toISOString() }));
          figma.notify('🔗 Mapped to <' + msg.name + '> — generated code now uses it');
          schedule();
          break;
        }
        case 'map-remove': {
          figma.root.setSharedPluginData(NS, 'map:' + msg.key, '');
          figma.notify('Mapping removed');
          schedule();
          break;
        }
        case 'redlines': {
          const n = await drawRedlines(lastSegments);
          figma.notify(n ? '📏 Redlines drawn' : 'Nothing to measure');
          break;
        }
        case 'clear-redlines': {
          const n = clearRedlines();
          figma.notify(n ? 'Removed ' + n + ' redline group(s)' : 'No redlines on this page');
          break;
        }
        case 'notify':
          figma.notify(msg.text, msg.error ? { error: true } : undefined);
          break;
        case 'resize':
          if (!IS_DEV) figma.ui.resize(Math.max(360, msg.w), Math.max(420, msg.h));
          break;
      }
    } catch (err) {
      figma.notify(String(err && err.message || err), { error: true });
      post({ type: 'error', message: String(err && err.message || err) });
    }
  };
}
