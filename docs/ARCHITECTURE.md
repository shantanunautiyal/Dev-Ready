# Architecture

A map of the repository for someone who has to change the code, written to be read
in ten minutes. It describes v1.5.1.

There is **no build step**. `code.js` and `ui.html` are loaded by Figma exactly as
they are committed, so both are one file each, dependency-free, and ES2020-era
JavaScript.

```
┌─────────────────────────────┐        postMessage         ┌──────────────────────────────┐
│  ui.html  (panel, browser)  │ ─────────────────────────► │  code.js  (Figma sandbox)    │
│  render(), send()           │ ◄───────────────────────── │  figma.ui.onmessage          │
└─────────────────────────────┘        pluginMessage       └──────────┬───────────────────┘
                                                                      │ Figma plugin API
                                                                      ▼
                                                            documents, variables,
                                                            styles, export, clientStorage
```

`code.js` cannot touch the DOM, and `ui.html` cannot touch the Figma document. Every
piece of data crosses the `postMessage` boundary, which is why the message schema
matters.

---

## `devready-plugin/code.js` (≈3,500 lines)

Top-level sections, in file order:

| Lines | Section | What lives there |
|---|---|---|
| 1–24 | Header | Plugin entry, `showUI`, `documentAccess: dynamic-page` handling |
| 26–85 | **Message schema** | `V` validators, `MSG_SCHEMA`, `checkFields()`, `validateMsg()` |
| 87–125 | Small utils | `round`, `colorHex`, `slug`, `pascal`, `camel`, escaping helpers |
| 127–222 | **The gate** | `ownStatus()`, `resolveStatus()`, `setStatus()` — native `devStatus` + `devready` flag fallback, and the baseline snapshot on "ready" |
| 224–262 | Variables & styles | `varInfo()`, mode resolution, cache |
| 264–553 | **Spec extraction** | `buildSpec()` and friends: box model, layout, typography, fills, effects, component info, assets, CSS/Tailwind |
| 556–742 | CSS helpers | `safeCSS()` (`getCSSAsync`), grouping, Tailwind mapping |
| 743–791 | Asset detection | `allVector()`, icon/image heuristics, export planning |
| 799–~1,000 | **Code engine pass 1** | Raw layer tree → intermediate elements, BEM-safe names, semantics |
| 1009–1,114 | Pass 2 | Structure, semantic tags, CSS hygiene |
| 1,115–1,146 | Pass 3 | BEM naming and class de-duplication |
| 1,147–1,186 | Pass 4 (React) | Repeated instances → component + props |
| 1,187–1,267 | Renderers | HTML, CSS, Tailwind, React (JSX and TSX), Vue, Svelte, single-file HTML |
| 1,268–1,435 | **Fonts** | `GF_DATA` catalog, `googleCheck()`, `googleHref()`, `planFonts()` (Google / `@font-face` / system) |
| 1,436–1,599 | Single-file embedding | Assets and image fills → data URIs, size budget |
| 1,600–1,705 | Variable modes | Per-mode values, `[data-theme]` blocks, token collection |
| 1,706–1,848 | **Change tracking** | `nodeSig()`, `nodeVals()`, chunked snapshots (`writeChunked`), `diffBaseline()`, `valDiff()` |
| 1,849–1,881 | Code Connect mapping | `loadMappings()`, `mapProps()`, `connectSnippet()` |
| 1,882–1,926 | Layers + measurements | Breadcrumb, children, native `addMeasurement` |
| 1,927–2,578 | **Native targets** | `generateSwiftUI`, `generateCompose`, `generateReactNative`, `generateFlutter` |
| 2,579–~2,900 | Accessibility | WCAG contrast, touch targets, labels |
| ~2,900–3,140 | Design tokens export | CSS, SCSS, JSON (DTCG), Tailwind v4 `@theme` |
| ~3,140–3,230 | Canvas tools | Annotations (+ canvas-note fallback), redlines, dev resources |
| ~3,230–3,492 | **Runtime** | `refresh()`, selection watching, `figma.ui.onmessage` switch, codegen handler, entry point |

Line numbers shift; the section comments (`/* ---------- … ---------- */`) are the
stable anchors. Search for those rather than for numbers.

### Data flow for one selection

```
selectionchange
  → schedule() (debounced 80 ms)
    → refresh()
       → resolveStatus(node)            gate: native status or DevReady flag
       → buildSpec(node)                specs for the panel
       → diffBaseline(node)             change tracking, cached per container
       → post({ type: 'state', … })     one message, whole panel state
```

The panel is **stateless between renders**: `refresh()` sends one `state` object and
`render()` draws it. When you add a panel feature, extend `buildSpec()` and the
`state` payload rather than adding new ad-hoc messages.

## `devready-plugin/ui.html` (≈1,660 lines)

One file, three layers:

1. **CSS** (top, custom properties for light/dark, `prefers-color-scheme`).
2. **Markup** — header, `#main`, toast, preview frame.
3. **Script** — no framework. Key pieces:

| Piece | Purpose |
|---|---|
| `const S = { … }` | All UI state: current tab, language, generated code cache, preview mode |
| `send(m)` | The only way to talk to `code.js`; a no-op in demo mode |
| `render()` | Full re-render from `S.data` |
| `sec…()` functions | One per panel section (`secChanges`, `secCode`, `secAssets`, …) |
| `secLayerProps`, `boxModel` | List/Code toggle and the box-model diagram |
| `secCode`, `previewDoc`, `mountPreview` | Code tab, sandboxed preview iframe, overlay/difference |
| `hl()` | Tiny syntax highlighter |
| `makeZip()` | ZIP writer (CRC32 + local headers) so nothing needs a network or a library |
| `DEMO` / `DEMO_CODE` | Sample data used when the file is opened in a normal browser |

### Demo mode

When `ui.html` is opened outside Figma, no `ui-ready` answer arrives within 1.5 s, so
the script switches to `S.demo = true` and renders `DEMO`. That is why `send()` is a
no-op in demo mode and why every browser check can run without Figma. Keep `DEMO`
in sync with the `state` payload when you add a field, or the demo silently drifts.

---

## The message boundary

Every UI → plugin message is validated in `validateMsg()` before the switch in
`figma.ui.onmessage` runs:

- unknown `type` → ignored (returns `null`);
- unknown fields → dropped;
- wrong types or out-of-range values → `{ type: '__invalid', … }` and a toast;
- node ids must look like Figma ids, URLs must be `http(s)`.

Message types (see `MSG_SCHEMA`): `ui-ready`, `settings`, `select`, `mark`, `export`,
`export-all`, `export-project`, `gen-code`, `tokens-export`, `design-shot`,
`font-upload`, `font-remove`, `baseline-save`, `baseline-clear`, `measure-native`, `measure-clear`,
`annotate-add`, `annotate-remove`, `notes-clear`, `goto`, `devres-add`,
`devres-remove`, `map-save`, `map-remove`, `redlines`, `clear-redlines`, `notify`,
`resize`, plus the workspace group:

| Message | Answer | Notes |
|---|---|---|
| `plan` | `plan` | Complexity + illustration classification for the selection. Read-only. |
| `cancel` | — | Marks a `jobId`; `gen-code` stops at the next layer and answers `cancelled: true`. |
| `thumb-request` | `thumb` | A 160 px PNG for a visible row (assets, design files). |
| `a11y-ignore` / `a11y-unignore` | `a11y-ignored` | Records or clears a review decision in the file (`devready` / `a11y-ignore`); `ids` are capped at 50 and the stored map at 120 entries / 20 kB. |
| `a11y-report` | `a11y-report` | Re-audits the selection and answers `{ format, out: { text, file } }` for Markdown or CSV. |

A message that fails validation answers `{ type: 'invalid', of, field, message }` as well as
showing a canvas toast: the panel disables controls while a request is in flight, so a refusal
must come back to it or the control stays disabled forever.

`figma.ui.onmessage` is assigned immediately after `figma.showUI` and before the page watchers,
which are wrapped in `try/catch`. A throw in an event registration used to leave the panel on
screen with no handler at all — the failure mode that looks like "the plugin shows sample data".
| `store-get` / `store-set` | `store` / `store-ok` / `store-error` | `clientStorage` for `projects` and `history`, JSON-validated, 200 kB cap. |
| `gh-status` | `gh-status` | Never throws: a network failure is reported as `error.code`. |
| `gh-connect` / `gh-disconnect` | `gh-status` | The token is stored/removed in `clientStorage`; it is never echoed back. |
| `gh-repos` / `gh-branches` / `gh-create-repo` | `gh-repos` / `gh-branches` / `gh-created` | Repository and branch discovery. |
| `gh-tree` | `gh-tree` | Preview: `headSha` plus per-file `added`/`modified`/`unchanged`/`deleted`, computed from git blob hashes. |
| `gh-commit` | `gh-committed` | Blobs → tree → commit → non-forced ref update. Every failure has a `code`. |

The GitHub adapter is isolated: `ghRequest()` is the only `fetch()` call site in the
plugin, it never throws, and it scrubs the token out of anything it returns
(`ghScrub`). `docs/PUBLISHING.md` is the contract.

**When you add a message type:** add it to `MSG_SCHEMA` with validators first, then
the `case` in the switch, then `tests/run.js` → `messageValidation()` with an attack
case. The test suite fails if a message reaches the API unvalidated.

## The workspace

The panel has eight tabs. Seven of them are new surfaces owned by `ui.html`; the
**Design** tab is the original inspector and is untouched by them.

```
S.ws      projects: [{ id, name, files: [...], revisions: [...] }]   → clientStorage 'devready-projects'
S.hist    revisions: [{ id, files: [{name,size,hash}], code }]       → clientStorage 'devready-history'
S.run     the processing queue: { queue, active: { jobId }, done, total, cancelled }
S.lastCode the files of the last successful run (drives the Code tab and GitHub)
S.gh      GitHub state: status, repos, branches, tree, selection, busy, error, result
S.tab / S.projView / S.assetsView / S.confirm     view state only
```

Rules that keep it coherent:

- **One run at a time.** `filesNext()` starts the next queued file only after the
  previous `code` reply is settled by `filesSettle()`, which also refuses replies
  from other job ids. That is the dedupe and the backpressure in one place.
- **Failures are per file.** A failed entry keeps its `error` string and stops only
  itself; `Retry N failed` re-queues `status === 'error'` entries.
- **Illustrations are decided in the engine, not the panel.** `illustrationPlan()`
  runs inside `buildRawNode`, so every target and every path (panel, project ZIP,
  Dev Mode codegen) sees the same classification.
- **Nothing is written to GitHub until the preview is confirmed**, and the preview's
  `headSha` travels with the commit so a moved branch is caught before any blob.

Tests: `tests/platform.js` (20 checks) covers the queue, the adapter, the storage
bound and the tab rendering; `tests/unit-ui.js` covers the panel's pure helpers.

## What is stored, and where

| Storage | Key | Contents |
|---|---|---|
| Shared plugin data (`devready` namespace) on the design | `status`, `note`, `at` | The DevReady flag, used when native status isn't available |
| Shared plugin data on the design | `baseline:0…n`, `baseline:n`, `baselineAt` | Change-tracking snapshot, chunked under Figma's 100 kB entry limit |
| Shared plugin data on `figma.root` | `map:<key>` | Code Connect-style component mappings |
| Shared plugin data on `figma.root` | `a11y-ignore` | Accessibility review decisions: `{"<nodeId>": "<reason>"}`, ≤120 entries and ≤20 kB, so a file records *why* a finding was accepted |
| Shared plugin data on canvas notes | `note`, `noteText` | The canvas-note annotation fallback |
| `figma.clientStorage` (per user) | `devready-settings`, `font:<family>\|<key>` | Settings, uploaded font files |
| `figma.clientStorage` (per user) | `devready-projects`, `devready-history` | Workspace: projects, design entries, revisions (≤200 kB each) |
| `figma.clientStorage` (per user) | `devready-github-token` | GitHub token, written only by `gh-connect`, deleted by `gh-disconnect` |
| Native Figma properties | `devStatus`, `annotations`, `devResources` | Written where the plan/seat allows it |

Nothing is stored on a server, because there is no server.

## Where to change what

| Task | Start here |
|---|---|
| Add a code target | `generateCode()` renderers (line ~1,187), `LANG_IDS`, `manifest.json` → `codegenLanguages`, `LANGS`/`NATIVE` in `ui.html`, a validator in `tests/validators.js`, a language in `tests/run.js`. The TypeScript targets are the same React renderer with `ts` set — copy that pattern instead of forking the generator. |
| Fix a measurement | `buildSpec()` and `boxModel()` in `ui.html` |
| Change typography or colour extraction | `buildSpec()` → `typography`, `paints` |
| Add a panel section | `sec…()` in `ui.html` + a field in the `state` payload, plus a `DEMO` example |
| Change the gate | `resolveStatus()` / `setStatus()` (lines 127–222) |
| Change snapshot format | `nodeSig`, `nodeVals`, `snapshot`, `diffBaseline` — **keep reading old snapshots** (the legacy test covers this) |
| Fonts | `GF_DATA` is generated: `node scripts/build-font-catalog.js --write` |
| Security / escaping | helpers at the top of `code.js`; the `hostile-content` fixture is the guard rail |

## Testing harness

`tests/harness.js` runs `code.js` in a Node `vm` context with a **mock `figma`** and
constructs node trees via builders (`T`, `AL`, `ABS`, `R`, `ICON`, `COMPONENT`,
`VARIABLE`). Code generation is invoked directly (`eng.generateCode(...)`), so no
Figma is needed. `tests/validators.js` parses each output (esbuild for JSX/CSS;
structural checks for HTML, Swift, Kotlin, Dart, Vue, Svelte).

Beyond per-target assertions, three groups protect the output itself:

| Group | What it proves | Where |
|---|---|---|
| **Golden files** | Generated code does not drift silently. A change prints the first differing line of the first differing file | `tests/golden/*.json`, update with `npm test -- --update-golden` |
| **Generated project build** | The emitted imports actually resolve: the files are written to a temp dir and bundled with esbuild | `generatedProjectBuild()` in `tests/run.js` |
| **Doc consistency** | The README badge and `docs/test-report.md` match the number of checks the suite ran | `docConsistency()` in `tests/run.js` |
| **Dev Mode read-only contract** | The Dev Mode panel never writes to the document. The engine starts in `inspect` mode with every canvas-writing API throwing, then messages that touch the canvas are delivered and the traps must stay untouched | `tests/features.js` (`dev mode`), `loadEngine({ readOnly: true })` in `tests/harness.js` |

When you add or remove a check, regenerate the report (`npm test -- --report`) — the
consistency check fails the build otherwise. When the output change is deliberate,
review the golden diff and run `npm test -- --update-golden`.

If a mock getter is missing, add it to the builders in `harness.js` rather than
special-casing production code — the mock is deliberately strict.
