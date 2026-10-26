# DevReady — Improvement Plan, Feature Roadmap & Edge-Case Catalogue

> **Scope:** a full engineering review of `devready-plugin/code.js` (3,808 lines), `devready-plugin/ui.html` (1,684 lines), `manifest.json`, the test harness, CI and docs.
> **Baseline:** commit `b76edd1`, package version **1.5.1**, `main` @ 2026-10-26.
> **Purpose:** a prioritised, test-first backlog. Every item below is written so it can be turned into a development step and a set of unit tests without re-analysing the code.
> **Line numbers** are from v1.5.1. The `/* ---------- section ---------- */` comments are the stable anchors — search for those instead.

---

## 0. TL;DR — the ten moves that matter most

| # | Move | Why | Effort | Phase |
|---|---|---|---|---|
| 1 | **Depth/CPU guards in the code engine** — a 3,000-level nested tree crashes with `Maximum call stack size exceeded` (reproduced) | Any pathological or imported file kills the whole plugin, not just codegen | S | 0 |
| 2 | **Fix accessibility contrast: inherit ancestor opacity** — black text inside a 20 %-opacity frame is reported **21:1 PASS** (reproduced) | The audit currently ships a false "AA pass" — the worst kind of a11y bug | S | 0 |
| 3 | **Enable Code Connect mappings in TypeScript targets** — mappings work in `react-css`/`react-tailwind` and are silently ignored in `react-ts`/`react-tailwind-ts` (reproduced) | TS is the flagship target; the feature looks broken there | S | 0 |
| 4 | **Make the gate reachable for every markable layer** — a top-level `GROUP` can never be marked and can never unlock | Dead end for a common Figma structure; user must disable the gate | S | 1 |
| 5 | **Cache invalidation + refresh cost** — `varCache`/`styleCache`/`collCache` are never cleared; a full 2,500-node snapshot is recomputed on *every* node change | Stale tokens after a variable edit; laggy panel on real files | M | 1 |
| 6 | **Codegen fidelity pack** — masks, image crop/scale mode, gradients, dash/caps, layout grids, constraints, text truncation are all ignored today | "Generated code doesn't look like the design" is the #1 churn reason for this product category | L | 2 |
| 7 | **Accessibility 2.0** — non-text contrast, alt-text/heading/form checks, ignore-with-reason, WCAG 2.2 coverage, exportable report | Turns a checkbox feature into something a team can gate a release on | L | 3 |
| 8 | **Panel accessibility & UX** — zero ARIA, no keyboard operation, no scroll preservation, no search | The inspector is unusable for keyboard/screen-reader users, and long panels jump on every edit | M | 4 |
| 9 | **Change tracking 2.0 + handoff report** — semantic diff (variables/styles/gradients/effects), history, exportable Markdown | The differentiator vs Dev Mode; today it is hash-based and shallow | L | 5 |
| 10 | **Test-suite hardening** — unit tests for pure helpers, fuzz/property tests, a fixture per edge case, perf budgets, native compile checks, UI browser tests | The suite is excellent for codegen but has **no unit tests for the panel** and no adversarial tree tests | M | 0–6 |

Severity legend: **S1** wrong output / data loss / crash · **S2** feature gap or misleading UX · **S3** polish.
Effort: **S** ≤ 1 day · **M** 1–3 days · **L** 3–10 days (single developer, including tests).

---

## 1. How this was analysed

```bash
git log --oneline -1                     # b76edd1
npm ci                                   # required: 50 checks silently fail without devDeps
npm test                                 # 158/158 checks pass
npm run verify                           # layout + sandbox + lint + tests all green
npm run lint                             # "lint OK — 13 files"
npm run check                            # "OK — safe for the Figma sandbox"
```

Plus targeted probes run against the real engine through `tests/harness.js`:

| Probe | Result |
|---|---|
| 3,000 nested frames → `generateCode` | **throw**: `Maximum call stack size exceeded` |
| Black text inside `opacity: 0.2` frame on white | **contrast 21:1 → pass** (ancestor opacity ignored) |
| Component with a Code Connect mapping, 4 React targets | `react-css` ✔, `react-tailwind` ✔, **`react-ts` ✘, `react-tailwind-ts` ✘** |
| `markTarget()` on a top-level `GROUP` / `TEXT` / `ELLIPSE` | returns `null` → "Select a frame, component or section…" |

Everything else in this document is from reading the code, the tests, the manifest and the docs, and is cited with an anchor.

### What is genuinely strong (keep it)

- The **message boundary** (`MSG_SCHEMA`, `validateMsg`, `checkFields`) is better than most published plugins: unknown types ignored, unknown fields dropped, ranges clamped, 15 attack cases in tests.
- **Privacy discipline** is real: no network APIs in `code.js`, a bundled 1,950-font catalog, per-family "is this a Google font" check, and tests that enforce it. The preview iframe is `sandbox="allow-same-origin"` + CSP, verified in Chromium.
- **Golden files + `tsc --strict` + real esbuild bundle** of the generated React project. This is the correct triad and should be extended, not replaced.
- **Single-file, no build step** is a legitimate constraint and should be preserved (see §11 non-goals).

---

## 2. Architecture snapshot

```
devready-plugin/
├── code.js    Figma sandbox: gate, spec extraction, 12 code targets, tokens, tracking, canvas tools
├── ui.html    panel: CSS + markup + framework-free script, ZIP writer, preview, demo data
└── manifest.json  inspect + codegen + vscode capabilities, 12 codegen languages
```

| Layer | Facts that constrain every change |
|---|---|
| Size | `code.js` 3,808 lines / 248 KB; `ui.html` 1,684 lines / 180 KB (including a ~100 KB inline `DEMO_CODE` blob) |
| Runtime | Figma sandbox: **no DOM, no `eval`, no workers, no `fetch`** (manifest allows Google Fonts for the *preview iframe only*) |
| State | Panel is stateless per render: `refresh()` posts one `state` object → `render()` redraws. Demo mode (`S.demo`) renders `DEMO` when no `ui-ready` arrives in 1.5 s |
| Storage | Shared plugin data (`status`, chunked `baseline:*`, `map:*`, canvas notes) + `figma.clientStorage` (settings, uploaded fonts) |
| Gate | `ownStatus()` → native `devStatus` first, DevReady flag second; `findDevStatus()` walks up to the page |
| Codegen budgets | 600 layers (panel), 1,500 (project ZIP), 150 + 3 s (Dev Mode code section) |
| Tests | 158 checks: 9 fixtures × 12 targets, privacy, tracking, message validation, `tsc`, golden, esbuild bundle, doc counts |

---

## 3. Verification state (what is green today)

| Gate | Result |
|---|---|
| `npm test` | **158/158** |
| `npm run check:layout` | 23 required files, plugin folder clean |
| `npm run check` (SES) | OK |
| `npm run lint` | 13 files OK |
| `npm run test:browser` | Chromium: panel render + preview isolation |

**Gap in the green light:** the suite asserts *codegen*, *privacy*, *messages* and *tracking* — but has **no unit tests for `ui.html` logic** (ZIP writer, `esc`, `makeZip`, `previewDoc`, `render`), **no test for the panel's accessibility**, **no stress/perf test on deep or wide trees**, and **no compile check for the four native targets**. See §8.

---

## 4. Confirmed defects (reproduced)

### D-1 · `S1` · Deep layer trees crash the whole codegen
**Repro**
```js
let cur = B.T('deep'); for (let i=0;i<3000;i++) cur = B.N({type:'FRAME',width:100,height:100,layoutMode:'NONE'}, [cur]);
await eng.generateCode(root, 'html-css', 'px', 16, 5000, {});
// → Maximum call stack size exceeded
```
**Cause** `buildRawNode()` (`code.js:940`), `applyGeometry`, `walk()`, `sig()`, `snapshot()`, `collectAssets()` and `drawRedlines` are all unbounded recursion. Figma files with deep "layer soup" (imported Sketch/Illustrator groups, screenshots-of-screenshots, AI-generated files) are common.
**Fix** Add `MAX_DEPTH` (e.g. 120) and a stack-safe traversal helper; when exceeded, emit a visible truncation note + `truncated: true` instead of throwing. Wrap `generateCode` in a last-resort try/catch that returns a readable error file.
**Tests** `codegen: a 3000-level tree returns a truncation note instead of throwing`; `codegen: depth limit does not change output for normal fixtures` (golden).

### D-2 · `S1` · Accessibility contrast ignores ancestor opacity
**Repro** black `#000000` text inside a frame with `opacity: 0.2`, on white.
**Actual** `{status:'pass', ratio:21}`. **Expected** fail (~1.05:1).
**Cause** `a11yAudit()` (`code.js:2918`) multiplies only the text node's own opacity (`:2929`), never the accumulated ancestor opacity; `backgroundBehind()` walks geometry only.
**Fix** Accumulate `opacity` up the ancestor chain (and cap), skip text in `visible:false` subtrees (already), and surface "reduced by ancestor opacity" in the detail string.
**Tests** depth-1 and depth-3 ancestor opacity; opacity on a `GROUP`; `opacity` mixed-symbol on a parent; opacity 0 (skip entirely).

### D-3 · `S2` · Code Connect mappings are dead in the TypeScript targets
**Repro** a component with a `map:<key>` entry → `react-css` emits `import { Button } from '@/ui'`, `react-ts` emits the inlined tree.
**Cause** `generateCode()` sets `react: /^react-(tailwind|css)$/.test(lang)`, and both `ctx.react` and `ctx.mappings` guard the mapping branch at `code.js:962`. `react-ts` and `react-tailwind-ts` never match.
**Fix** `const isReact = /^react-/.test(lang);` (mappings make sense for every React target). Keep the existing validator that quotes `name`/`path` safely.
**Tests** mapping applied in all four React targets; mapped component not re-extracted; mapping with a hostile `name`/`path` still rejected; `map-remove` restores inlining.

### D-4 · `S2` · The gate can never unlock a top-level `GROUP`
**Cause** `MARKABLE` (`code.js:162`) = FRAME, COMPONENT, COMPONENT_SET, INSTANCE, SECTION; `markTarget()` requires the ancestor be directly on the page or in a section. A designer whose screen is a plain top-level group can never mark it, so the panel is permanently locked (or the whole team turns the gate off — which defeats the product).
**Fix** (a) allow the DevReady flag on any node type (shared plugin data works everywhere), keeping *native* status limited to `MARKABLE`; (b) when the target is not markable, mark the nearest markable ancestor with a clear explanation; (c) show "This layer type can't carry a Figma status — DevReady will use its own flag".
**Tests** `gate: group → plugin flag written to the group`; `gate: text layer → nearest markable ancestor offered`; `gate: Dev Mode still writes only plugin data`.

### D-5 · `S3` · Published version drifts from the docs
`package.json` = **1.5.1**, `CHANGELOG` has `1.5.1` + Unreleased, but `README.md:32` says *"Status: v1.2.0"* and `docs/ARCHITECTURE.md:4` says *"describes v1.2.0"*.
**Fix** Read the version from `package.json` in the docs check, and fail CI when README/ARCHITECTURE say a different version. (The existing doc-consistency test only compares the *check count*.)

---

## 5. Findings and improvements by area

Each item has: **current behaviour → proposal → edge cases → tests → done when**.

### 5.1 Runtime, data access & API usage

**IMP-01 · `S2` · `skipInvisibleInstanceChildren` is never set** · Effort S
- **Current:** every traversal reads hidden instance subtrees; a file with 200 instances of a 40-layer card processes 8,000 invisible layers.
- **Proposal:** set `figma.skipInvisibleInstanceChildren = true` at startup (Dev Mode included), and document the trade-off (hidden instance children are intentionally skipped everywhere: gate walking still works because it only goes *up*).
- **Edge cases:** gate lookup on a *hidden* instance child; change tracking where a hidden instance becomes visible (should register as a change); `findDevStatus` unaffected (upward only); Dev Mode read-only compliance.
- **Tests:** harness assertion that the flag is set; a tracking test where a hidden instance's child becomes visible → `style`/`vis` change.

**IMP-02 · `S2` · Caches are never invalidated** · Effort S
- **Current:** `varCache` (`:226`), `styleCache` (`:250`), `collCache` (`:1831`), `varModes` results, `diffCache` (invalidated on any `nodechange`). Editing a variable's value or renaming a style leaves stale names/values in the panel for the whole session.
- **Proposal:** clear `varCache`/`styleCache`/`collCache` inside the `nodechange` handler alongside `diffCache`, and key them by `(id, modeId)`.
- **Edge cases:** remote/library variables that fail to resolve (must be able to retry, not cache `null` forever); renamed collection; deleted variable (`null` should be re-fetched, not sticky); mode switch mid-session; 1,000 variables (invalidate must stay O(1)).
- **Tests:** rename a variable → next `extractSpec` shows the new name; delete a variable → token row disappears; a `null` lookup is retried once.

**IMP-03 · `S2` · Silent failure everywhere** · Effort M
- **Current:** 60+ `catch (e) { /* ignore */ }`. When a section is empty the user has no way to know whether the design has no data or an API was unavailable.
- **Proposal:** collect a per-refresh `diagnostics: [{ api, nodeId, message }]` list (bounded, e.g. 20), show a "N features unavailable" affordance in the header, and add `⋯ → Copy diagnostics` (sanitised: no file names, no text content, ids hashed).
- **Edge cases:** diagnostics must not leak design text (privacy test), must be capped, must survive demo mode, must not appear for expected "not supported on this node type" paths (e.g. `annotations` on a group) — classify expected vs unexpected.
- **Tests:** privacy test asserting the diagnostics payload contains no text/layer names; one test per "expected" path to prove it is *not* reported as an error; cap test.

**IMP-04 · `S2` · `listReady()` is page-scoped and depth-limited** · Effort S
- **Current:** only `figma.currentPage`, top level + `SECTION` recursion to depth 4 (`:209`).
- **Proposal:** keep the fast path, but add an explicit "Search all pages" action (cached, `loadAllPagesAsync` in Design mode only, never in Dev Mode), and show "Showing this page only" as the scope.
- **Edge cases:** pages with 500 top-level frames; sections nested 5 deep; duplicate frame names; Dev Mode (read-only, no page loading); renamed pages; a "ready" frame that moved to another page (stale entry in the list).
- **Tests:** nested sections to depth 6; multiple pages; Dev Mode never calls `loadAllPagesAsync`.

**IMP-05 · `S2` · No request timeout; a dropped response hangs the UI** · Effort S
- **Current:** `requestCode()` sets `pending[lang]` and clears it only when a matching `code` message arrives (`ui.html:1399`). If the node is deleted between request and handling, `gen-code` hits `if (!node) break;` and never answers → "Building…" forever. Same shape for `tokens` and `design-shot`.
- **Proposal:** per-request timeout (e.g. 12 s) with a retry button and a footnote; always answer `gen-code` with an error file when the node is missing; add `pending` cleanup on `state`.
- **Edge cases:** slow 1,500-layer project > 12 s (do not time out project exports — they use a different path); selection changed mid-flight (already handled by `requestId`); plugin restart; language switched while pending; three concurrent languages.
- **Tests:** fake a missing response → UI shows a retry state; a real slow fixture (600 layers) does not trip the timeout; stale `requestId` is ignored.

### 5.2 The gate (the product's differentiator)

**IMP-06 · `S2` · Native status suppresses the plugin flag** · Effort S
- **Current:** `setReady()` (`:174`) writes `''` into the DevReady flag when the native status succeeded.
- **Consequence:** on a paid plan the flag is cleared, so a teammate on a free/Starter seat (where `devStatus` is not exposed) sees the design as **locked** even though it is marked ready.
- **Proposal:** always write the plugin flag; show one source in the UI ("Figma status" preferred) and add a "also readable on free plans" indicator. Never let a stale flag override a native status (already true).
- **Edge cases:** native READY + stale plugin COMPLETED (native wins, flag refreshed); native cleared but flag present (should be cleared too, or explicitly "plugin flag remains — remove?"); Dev Mode (flag only); section vs frame source mismatch; `pluginFlag: false` setting.
- **Tests:** mark on a paid-plan mock → both written; free-plan viewer resolves plugin source; clear native → flag cleared; conflict test asserting source precedence.

**IMP-07 · `S2` · No "ready but changed" lifecycle** · Effort M
- **Current:** the header shows `N changes since ready`, but the gate stays open regardless of how much drifted. Nothing distinguishes "ready 3 minutes ago" from "ready, then 40 layers changed".
- **Proposal:** add a derived state — `READY`, `READY · CHANGED (N)`, `STALE` (threshold or elapsed time), `COMPLETED`. Optionally require re-review when `changes > threshold` (off by default, per-file setting).
- **Edge cases:** >2,500-layer snapshots (`__partial`) — never claim stale from incomplete data; frames with no baseline ("Start tracking"); the container renamed; baseline written by an older plugin version; timezone/clock skew in `at`; changes caused by a variable-mode switch (see F-02).
- **Tests:** manual `features.js` cases for each derived state; partial-snapshot case must not produce `STALE`; clock-skew display (`ago()` with a future date).

**IMP-08 · `S2` · Gate settings are per user, not per file** · Effort M
- **Current:** `figma.clientStorage` → one designer with the gate off, one developer with it on. The "team workflow" claim does not hold.
- **Proposal:** store a *team default* in shared plugin data on `figma.root` (opt-in, explicit "Apply to this file for everyone"), with user override and a visible "file policy: gate on" badge.
- **Edge cases:** Dev Mode (read-only → read policy, cannot write); older plugin versions in the same file (unknown keys ignored); conflicting writes from two users (last-write-wins + timestamp); files that should not be modified (offer a read-only preview before accepting); removal semantics.
- **Tests:** message `settings-scope` validation; reading a file policy written by an older schema; Dev Mode never writes.

**IMP-09 · `S3` · `findDevStatus` ignores page-level conventions** · Effort S
- **Current:** stops at `PAGE`, so a status on a page (impossible natively) or a page-naming convention (`[READY] Checkout`) is invisible.
- **Proposal:** optionally read a page/section *prefix convention* and a `SECTION`-level policy; show the resolved source in the breadcrumb.
- **Edge cases:** false positives from names like `Not ready`; emoji prefixes; localised conventions (configurable string).
- **Tests:** prefix parsing table-driven (10 cases).

### 5.3 Spec extraction (the Inspect tab)

**IMP-10 · `S2` · Missing spec fields developers ask for first** · Effort M
| Missing today | Why it matters | Where |
|---|---|---|
| `layoutGrids` (columns/rows, gutter, offset, `SECTION` grids) | Every web layout question starts here | `extractSpec:314` |
| `constraints` as *resizing behaviour* (`MIN/CENTER/MAX/STRETCH`, `SCALE`) | Name is currently used for min/max width/height, which is confusing | `:341` |
| `isMask` / mask relationship | Masked layers look wrong in code and in the layer tree | not present anywhere |
| `imageTransform` + `scaleMode` (FILL/FIT/CROP/TILE) per image paint | Crop is a top-5 "generated code is wrong" cause | `serializePaint:268` |
| Stroke cap/join/dash on vectors; arrow heads | Icons drift | `:360` |
| `textTruncate` / `maxLines` | Ellipsis is a spec, not a guess | `:395` |
| Per-segment truncation beyond 12 segments / 4,000 chars, with a visible "12 of 34 styles shown" | Silent truncation in the panel | `:377` |
| `absoluteRenderBounds`, `absoluteBoundingBox` | Needed for correct measurement when rotated | `:314` |
| Style links for typography/effects/fill on **every** segment (only first style name is surfaced) | Token mapping | `:377` |

- **Proposal:** add the fields above, render them in Layer properties / Layout, and mark truncation explicitly ("12 of 34 styles").
- **Edge cases:** mask chains (a mask that masks a mask), clipped vs masked, grid with `SECTION` scope, `layoutGrids` on a non-auto-layout frame, image fill with `imageTransform` identity, mixed `strokeWeight` per side, text with 40 segments, empty `characters`, `characters` with only whitespace, RTL text segments, `fontName` mixed.
- **Tests:** one fixture per row above (see Appendix D), plus a golden snapshot of `extractSpec` JSON for a "kitchen sink" frame (new golden type: `spec`).

**IMP-11 · `S3` · Components/variants are only partly described** · Effort M
- **Current:** `componentProperties` are shown, but variant→prop mapping is naïve (`c.variant.split(',')` in `ui.html:808`), and `INSTANCE_SWAP` resolves only one level.
- **Proposal:** resolve the component-set matrix (variant axes + values), infer prop types from the set (BOOLEAN/`TEXT`/`INSTANCE_SWAP`/VARIANT enum), and show which values are actually used in this instance.
- **Edge cases:** variant names with `=` or `,` inside values; nested instance swap; remote components; a set with 300 variants (cap + "showing 50"); default variant mismatch.
- **Tests:** axis parsing table; hostile variant names; 300-variant cap.

### 5.4 Code generation (12 targets)

**IMP-12 · `S1` · Masks are ignored** · Effort M
- **Current:** `isMask` is never read (`grep` → 0 hits). A masked avatar or a clipped card renders as a full rectangle in generated HTML/SwiftUI/Compose/Flutter.
- **Proposal:** detect `isMask` siblings, emit `overflow: hidden` + `border-radius` where geometry allows, `clip-path` for simple shapes, and an explicit `/* mask: <name> — manual clip path needed */` note where it cannot be represented. Same idea for `clipsContent` on native targets (already partly done for web).
- **Edge cases:** alpha masks with gradients (not representable → note + `mask-image` with the exported PNG for web); mask + rotation; group masks; nested masks; SVG icon masks (export the composed SVG instead); mask affecting layout (should not).
- **Tests:** fixture `masked-card`; assert `overflow:hidden`/`clip-path`/note per target; golden for web targets.

**IMP-13 · `S1` · Image crop and scale mode are ignored** · Effort M
- **Current:** `materializeImageFills()` sets only `background-size: cover|contain` (`code.js:1576`); `imageTransform` is never read. Native targets reject anything but FILL/FIT.
- **Proposal:** map `CROP` → `background-size` + `background-position` computed from `imageTransform`; `TILE` → `background-repeat`; export the cropped bitmap for native targets; keep an explicit note when an exact crop is impossible.
- **Edge cases:** rotated image fill; `imageTransform` with negative offsets; non-uniform scale; multiple image paints (already handled); missing image bytes (already → note); very large images (memory); image + gradient stack.
- **Tests:** crop math unit tests (identity, 50 % crop, offset), TILE, native crop export, hostile `imageHash`.

**IMP-14 · `S1` · Gradients beyond linear are lossy** · Effort M
- **Current:** `serializePaint` records stops, but codegen relies on `getCSSAsync`; Figma's angular/diamond gradients have no CSS equivalent, and `RADIAL` needs `circle at` semantics.
- **Proposal:** render gradients from the paint data with correct angle/stops/opacity, fall back to a note for angular/diamond, and emit a `background-image` stack in paint order.
- **Edge cases:** gradient with transparency stops, 20 stops, gradient + image, gradient as text fill, `GRADIENT_RADIAL` with non-square box, gradient interpolation space (`SRGB`/`OKLAB`).
- **Tests:** CSS string assertions per gradient type × 12 targets (where supported); golden.

**IMP-15 · `S2` · Text truncation, decoration, list and RTL semantics** · Effort M
- **Current:** some of this exists (`white-space`, `text-decoration`), but `textTruncate`, `maxLines`, mixed-direction runs and list markers are not modelled.
- **Edge cases:** ellipsis with a fixed height, `textCase` + `textDecoration` combined, RTL with LTR numbers, CJK line breaking, `paragraphSpacing` ≈ multiple paragraphs, zero-width joiners/emoji sequences, tabs, `\u0000`, surrogates split across a run boundary.
- **Tests:** unicode fixture (emoji, ZWJ, RTL, bidi overrides, `\u2028`, NUL) × 12 targets, asserting no syntax error and no injected code.

**IMP-16 · `S2` · Tailwind mapping is a fixed scale** · Effort S
- **Current:** `SP`/`FS`/`RAD` tables (`:587–591`); anything else becomes arbitrary values (`w-[37px]`), which is correct but noisy; `flex-shrink: 2` becomes `shrink`, `letter-spacing: normal` becomes `tracking-[normal]`.
- **Proposal:** use a configurable Tailwind theme (import a `tailwind.config`-ish map in settings), prefer design tokens (`--space-4` → `p-4`) when a variable is present, and add `preserve-arbitrary`/`tokens-only` modes.
- **Edge cases:** negative values, decimals (`2.5px`), `rem` mode, `calc()`, `var()` fallbacks, 4-value padding with mixed units, `999px` radius → `rounded-full`, `border-radius` per-corner, `auto` sizes.
- **Tests:** table-driven unit tests for `cssToTailwind` (currently only indirectly covered): ≥60 cases including all keys in the switch and a fallback case.

**IMP-17 · `S2` · Component extraction only handles repetition-by-identity** · Effort L
- **Current:** `extractComponents()` groups instances by `key + structural signature` (`:1186`); props are inferred from differing leaves; `unsafe` cases bail out silently.
- **Proposal:** group by component *set* + variant matrix, emit typed props (including variant enums and booleans), allow "extract this instance" on demand, and name props from component property names rather than heuristic leaf names.
- **Edge cases:** same component with different asset props (currently bails), 50 instances, instances inside instances, an instance that is itself mapped, prop-name collisions, boolean props that are always true, text props with identical values in all instances (should be a default, not a prop).
- **Tests:** fixture `variant-matrix`; assertion that props come from `componentProperties`; "unsafe mapping" produces a note not silence.

**IMP-18 · `S2` · Native targets are structurally checked but never compiled** · Effort L
- **Current:** `validators.js` does structural checks; Swift/Kotlin/Dart are not compiled anywhere. `/* TODO: onClick */` is emitted for buttons (`:2429`, `:2745`).
- **Proposal:** (a) add optional CI jobs with `swiftc`/`kotlinc`/`dart analyze` (Linux-runnable subsets: `dart analyze` and `kotlinc` are feasible; Swift needs a macOS runner or `swift-syntax` parse), (b) replace TODOs with a documented `onClick` parameter and a note, (c) add `@Preview`/sample data consistently.
- **Edge cases:** Compose `Color(0xFF…)` overflow, Kotlin `$` in strings, Dart `'''` and `$`, Swift `\"` and `\(`, trailing commas, empty containers, 300-layer output size.
- **Tests:** "no TODO in generated code" assertion; string-escaping property tests; `dart analyze` job (optional, non-blocking at first).

**IMP-19 · `S3` · Generated code has no a11y or test hooks** · Effort S
- **Proposal:** read Figma annotations to emit `aria-label`, `alt`, `role`, `data-testid` (opt-in), and turn `devResources` links into JSDoc `@see` comments.
- **Edge cases:** annotation markdown → attribute escaping; duplicate test ids; empty labels; annotation intentionally private.
- **Tests:** hostile annotation content × 12 targets.

### 5.5 Fonts & assets

**IMP-20 · `S2` · Font handling stops at "Google or custom"** · Effort M
- **Current:** bundled `GF_DATA` catalog, `local()` + uploaded `@font-face`, system-font classification.
- **Gaps:** variable-font axes, `fontFallbacksAsync` (Figma's own fallback chain) unused, font weight availability per family, italic synthesis, uploaded-font total budget (only 2.5 MB *per file*, no total), licensing warnings for embedding a brand font in exported HTML, `@font-face` for `.ttc`/`.otc`, subsetting.
- **Edge cases:** a private font whose name collides with a Google font (privacy-critical: must not produce a Google URL — test exists, keep it); a font family used at 9 weights with only 3 uploaded; `Inter` vs `Inter Variable`; a deleted uploaded font; `font-display` choice; user switches the preview font setting mid-render.
- **Tests:** catalog lookup (miss/hit/variable range), `local()` generation with quotes in family names, uploaded-font storage budget, "no Google URL for a private family" (existing, extend to aliases).

**IMP-21 · `S2` · Asset collection & naming** · Effort M
- **Current:** `collectAssets()` limit 60, visited 4,000 (`:775`); icons heuristic; export settings honoured; per-target naming via `ctx.assetNames`.
- **Gaps:** assets beyond the 60-row cap are invisible ("showing 60"), no "export all as declared presets" (each `exportSettings` entry, all scales), no hash dedupe across *different* layers with the same image, SVG cleanup is minimal (`cleanSvg`), no sprite/icon-font export, no `favicon`/`manifest` for web, PDF is offered in the panel but not in project exports.
- **Edge cases:** two layers named `Icon`; names differing only by case on macOS (case-insensitive collisions); 300 assets; a zero-size layer; a layer with `exportSettings: []` but an image fill; SVG with embedded raster; SVG with `foreignObject`; assets inside instances (dedupe by component key — exists); asset export failing for one layer (all-or-nothing project — exists, keep).
- **Tests:** collision matrix (case, whitespace, unicode, `@2x`), 300-asset cap message, SVG sanitisation, duplicate-hash dedupe.

**IMP-22 · `S3` · Single-file HTML budget is a single number** · Effort S
- **Current:** `inlineAssets` budget 8 MB default, 400 KB for codegen; exceeding it silently degrades to `none` + a note.
- **Proposal:** surface a size meter in the panel ("3.2 MB of 8 MB"), allow a per-export budget, and produce a **.zip fallback** when the single file is too big.
- **Edge cases:** one 9 MB image (always fails), 40 × 200 KB, base64 inflation (33 %), duplicated images with different hashes, budget exactly at the boundary.
- **Tests:** boundary tests at `budget-1`, `budget`, `budget+1`.

### 5.6 Design tokens & variables

**IMP-23 · `S2` · Token export is value-only** · Effort M
- **Current:** CSS/SCSS/JSON (DTCG)/Tailwind `@theme`, all modes.
- **Gaps:** per-mode CSS is emitted as `[data-theme]` blocks, but there is no `@media (prefers-color-scheme: dark)` variant, no `@layer`, no naming transform (kebab/camel/BEM), no typography/shadow/gradient composite tokens (styles are partly handled), no alias preservation beyond `ref` in JSON, no `Style Dictionary` config, no token-drift check.
- **Edge cases:** alias chains 5 deep, alias to a deleted variable, `STRING`/`BOOLEAN` variables, variables with `/` and spaces and unicode, duplicate web code syntax (`var(--x)` in two variables), mode-only variables (missing default), 500 variables × 4 modes (file size), numbers with units inside names.
- **Tests:** DTCG structural validation, alias chain resolution, duplicate `codeSyntax` disambiguation, unicode/naming transform table, deterministic ordering.

**IMP-24 · `S3` · Colour format setting only affects the panel** · Effort S
- **Current:** `colorFormat` (`hex|rgb|hsl`) is applied by `fmtColor()` in `ui.html:598`; generated CSS/tokens always use hex/rgba.
- **Proposal:** decide and document it: either apply to generated CSS values too (consistent) or rename the setting to "Panel colour format". Recommendation: apply to generated code as well, since the control lives in the panel's colour area.
- **Edge cases:** alpha, `hsl` rounding, CSS custom properties that other code expects as hex, Tailwind arbitrary values.
- **Tests:** generated stylesheet honours the setting; golden per format.

### 5.7 Change tracking & storage

**IMP-25 · `S2` · Snapshot cost and invalidation granularity** · Effort M
- **Current:** every `nodechange` clears *all* diffs and schedules a full `refresh()`; `diffBaseline()` re-walks up to 2,500 nodes and re-serialises them (`:2022`).
- **Proposal:** (a) cache the baseline parse per container (already partially), (b) invalidate only containers whose subtree contains the changed node when `nodechange` provides ids, (c) debounce to 400 ms (exists) plus a "busy" indicator, (d) incremental snapshot keyed by a cheap node version hash.
- **Edge cases:** a change inside a nested frame whose parent is also marked ready (two baselines → two invalidations); 5,000-node pages; rapid undo/redo; a change during a refresh (the `reqId` guard exists); a page switch while a diff is in flight.
- **Tests:** assert one snapshot per change burst (instrument `snapshot()` calls in the harness); assert no recompute when a change is outside the container.

**IMP-26 · `S1` · Diff misses variable-, style- and paint-binding changes** · Effort L
- **Current:** `nodeSig()` hashes raw `fills`/`strokes`/`effects`/`layout` and text (`:1935`). Switching a fill from a hex to a variable that resolves to the same hex, switching a variable's *mode*, re-binding a text style, or changing a gradient stop is either invisible or collapses to "style".
- **Proposal:** include `boundVariables` ids, `*StyleId` values, `explicitVariableModes`, gradient `gradientTransform`/stops, individual effect parameters and per-side radii in the signature; keep the human-readable `nodeVals()` for "before → after" but add structured sub-changes (`fill[0].color`, `cornerRadius.topLeft`).
- **Edge cases:** mixed values (`figma.mixed`) serialised as `null` today (a Mixed→same-value change is undetectable); renamed variables; a style edit affecting 200 layers (report as one group); a mode switch affecting the whole frame; snapshot size explosion (must stay under 100 kB/chunk).
- **Tests:** one test per signature component (change it → exactly that label appears); mixed-value handling; snapshot size budget for 2,500 layers; legacy snapshot compatibility (existing test must keep passing).

**IMP-27 · `S2` · One baseline, no history** · Effort M
- **Proposal:** keep N baselines (`baseline:<name>:*`), show "Ready v1/v2/v3" with timestamps and authors (`figma.currentUser` name only, opt-in), diff any pair, and a "mark reviewed" action that advances the current baseline.
- **Edge cases:** storage growth (cap 3 by default, prune oldest, never exceed a total budget), rename collisions, a baseline of a deleted frame, cross-page restore.
- **Tests:** prune order, quota guard, reading a baseline written by an older version.

**IMP-28 · `S2` · Change tracking cap semantics** · Effort S
- **Current:** 2,500-layer cap with `__partial` suppressing added/removed (`:2047`). Only the first 150 changes are sent.
- **Proposal:** state the caps in the UI ("first 2,500 layers, 150 changes shown"), add paging or "copy all changes", and never show "no changes" when partial and unchanged.
- **Edge cases:** exactly 2,500; 2,501; all layers changed; 1,000 added; a completely rebuilt frame (should be one "rebuilt" summary, not 1,000 rows).
- **Tests:** boundary table; the "partial + identical" case must say "not comparable" rather than "no changes".

**IMP-29 · `S3` · ZIP writer edge cases** · Effort S
- **Current:** `makeZip()` (`ui.html:624`) is store-only, DOS date fixed to 1980-01-01, no ZIP64, no compression, no directory entries, 4 GB / 65,535-entry ceilings, UTF-8 flag set.
- **Proposal:** add deflate via a tiny stored-block-safe compressor or keep store-only but (a) write a real timestamp, (b) warn above 200 MB / 4 GB / 65,535 files, (c) verify CRC in tests, (d) reject duplicate entry names.
- **Edge cases:** empty file, 0-byte asset, unicode file names, path traversal in names (`../`), duplicate names, 65,536 files, >4 GB total, names >65,535 bytes.
- **Tests:** `unzip -t` on generated archives in CI (store-only is easy to validate), CRC32 vectors, traversal-name rejection.

**IMP-30 · `S3` · Snapshot/plugin-data hygiene** · Effort S
- **Current:** chunks written under `baseline:i` + `baseline:n`; `map:*` keys on `figma.root`; no cleanup of orphaned keys; no "what will be stored" disclosure beyond PRIVACY.md.
- **Proposal:** add a "Storage" section in the panel (bytes per node, list of keys), prune chunks when shrinking (exists), remove orphaned `map:` keys for deleted components, and offer "remove all DevReady data from this file".
- **Edge cases:** a file with 40 baselines from old versions; chunks written by a future version; shared plugin data on a locked node; `figma.root` keys accumulating over years.
- **Tests:** storage report accuracy; prune test; remove-all test (assert no `devready` keys remain).

### 5.8 Accessibility audit

**IMP-31 · `S1` · Contrast false negatives** — see D-2. Additionally:
- **Current scope:** WCAG 1.4.3 text contrast, 2.5.8 target size, "has visible text" label heuristic, `size < 12px` warning.
- **Missing:** **1.4.11 non-text contrast** (icons, borders, focus rings, chart lines — 3:1), focus indicator presence, heading structure/order, form-field labelling, colour-only meaning, link distinguishability, motion/animation, text spacing, 1.4.10 reflow, 2.4.11 focus not obscured, 2.5.7 dragging alternatives, zoom.
- **Edge cases for the existing rules:** background from a *sibling above* vs below; blend modes (`MULTIPLY`, `SCREEN`); gradients (already `unknown`); images; semi-transparent overlays; text with a stroke; text inside a clipped/masked area; huge pages (400-layer cap → show "scanned 400 of 2,000"); `fontSize` mixed; `opacity: 0` text (skip); hidden instances; per-run colours inside one text layer (only the first solid fill is used today); emoji-only text; pseudo-"text" made of vectors (silently ignored).
- **Proposal:** add rule engine (`rules/{contrast,nontext,target,label,heading,form,color-only}`), each producing `{rule, wcag, status, evidence, fix}`; per-rule enable/disable; **ignore with reason** persisted per node; export report (Markdown/CSV); "select all failing layers" action.
- **Tests:** a table per rule (pass/fail/unknown/n-a), contrast matrices (AA/AAA/large/opacity/blend/gradient/image), target-size at 375 px and 1440 px frames, label heuristics with icon-only buttons/instances, heading order (`h1`→`h3`), 400-layer cap.

**IMP-32 · `S2` · Interactive detection is an English name regex** · Effort M
- **Current:** `TARGET_NAME_RE` (`:2911`) matches `button|btn|cta|tab|chip|checkbox|radio|switch|toggle|link|icon button`.
- **Gaps:** localised layer names, component names like `Primary/Default`, pure text links, prototypes with `reactions`, touch targets measured on the wrong node (a 44 px hit area with a 20 px visual).
- **Proposal:** combine signals: name regex, `reactions`, component property `role`-ish names, annotation `role`, and allow a manual "treat as interactive" toggle. Also accept a configurable name dictionary (i18n).
- **Edge cases:** `ButtonLabel` (a text child, not the target), `TabBar` container, `Link` inside a paragraph, `switch` matching "switch theme" copy, uppercase/underscore variants, plural/singular.
- **Tests:** 30-case table including false-positive names.

**IMP-33 · `S2` · Mobile detection uses a frame-width walk** · Effort S
- **Current:** `frameWidth()` walks up to the first frame below the page/section (`:2920`).
- **Bugs:** a 375 px component inside a 1440 px page frame is treated as desktop (44 px warning lost); a 375 px *component* used in a desktop frame is treated as mobile.
- **Proposal:** decide by the nearest ancestor with a device-like name/size, or expose a per-frame "target device" toggle; default to the outermost frame's width but let annotations override.
- **Tests:** nested-component cases; explicit override.

### 5.9 Panel UI, UX and *panel* accessibility

**IMP-34 · `S1` · The panel is not keyboard- or screen-reader-accessible** · Effort M
- **Evidence:** zero `aria-*`, zero `role=`, no `tabindex`, **no `keydown` handler** in `ui.html`. Section headers are `<button>` (good) but menus (`openMenu`) are divs with click handlers, cannot be opened by keyboard, and have no `Escape`, focus trap or `aria-expanded`. Toasts have no `aria-live`. Icons are inline `<svg>` without `aria-hidden`/labels. Focus is lost on every re-render (`#main.innerHTML = …`).
- **Proposal:** semantic landmarks (`header/main`), `aria-live="polite"` for toasts and status changes, `role="menu"/"menuitem"` + arrow/Home/End/Escape + focus return, `aria-expanded` on section toggles, visible `:focus-visible` rings, `aria-label` on every icon button, focus restoration across re-render (remember the focused action id), and a "Screen-reader friendly" density.
- **Edge cases:** menus near the viewport edge; 100 menu items; nested menus; focus inside a removed section; Figma dark/light themes; the demo mode (no plugin); IME input in the note field; zoomed text (200 %).
- **Tests:** Playwright: tab-order snapshot; open menu with Enter/Space; Escape closes and returns focus; arrow keys cycle; toast announced (live region present); axe-core run with zero serious violations.

**IMP-35 · `S2` · Re-render resets scroll and input state** · Effort S
- **Current:** `renderInspect()` replaces `#main.innerHTML` on every `state`; scroll position and any open dropdown/expanded "show all" state can jump; `S.closed` only remembers section collapse.
- **Proposal:** save/restore `#main.scrollTop` (and per-section scroll), key inputs by node id, and re-render only changed sections (or diff the HTML strings).
- **Edge cases:** scroll position beyond the new content height, preview iframe reload on every render (visible flicker), long note textarea mid-typing, `:focus` inside `#main`, sticky header height changes.
- **Tests:** Playwright: scroll to Changes → change a layer → scroll offset preserved; typing in the note field survives a state update.

**IMP-36 · `S2` · No search, filter or "find the thing" affordance** · Effort M
- **Proposal:** a command palette (`⌘K`) and per-section filters: search layers, variables by name/collection, a11y by rule/status, assets by name/format, changes by kind.
- **Edge cases:** 500 variables (virtual list), diacritics/unicode normalisation, empty query, no results, stale results after selection change.
- **Tests:** filter function unit tests (pure, extracted from UI); Playwright keyboard flow.

**IMP-37 · `S2` · Demo mode drifts from the real state payload** · Effort S
- **Current:** `DEMO` (`ui.html:1626`) is hand-maintained; it already lacks `settings.previewFonts`, and `DEMO_CODE` is a ~100 KB inline blob inside the shipped panel.
- **Proposal:** (a) generate `DEMO` from `buildSpec()`/`state` at test time and assert key parity, (b) move `DEMO_CODE` to a compact set (1–2 targets) or generate it in tests, shrinking `ui.html`.
- **Edge cases:** new state field added without demo (silent), demo code for a removed language, demo with dark theme, `S.demo` toggling mid-session.
- **Tests:** "every key in a real `state` payload exists in `DEMO`" (regex/JSON shape test in `tests/run.js`); `ui.html` size budget assertion.

**IMP-38 · `S3` · Copy & download fallbacks** · Effort S
- **Current:** `document.execCommand('copy')` fallback (deprecated), no failure message when both paths fail; `download()` revokes the blob URL after 1.5 s (fine) but large blobs may not have started.
- **Proposal:** use `navigator.clipboard` first, report real failures, and defer revocation to the next tick after a `setTimeout` of ~10 s or on `unload`.
- **Edge cases:** clipboard permission denied, huge copy (>5 MB), Safari/WebKit (Figma desktop uses Chromium), sandboxed iframe restrictions.
- **Tests:** Playwright with clipboard permissions denied → visible error.

**IMP-39 · `S3` · No manual theme/i18n/RTL** · Effort L
- **Current:** `prefers-color-scheme` + Figma theme variables only; all strings are English literals in the HTML/JS.
- **Proposal:** manual theme override (System/Light/Dark), string table with `en` default and a `lang` attribute, `dir="rtl"` support, and number/date formatting via `Intl`.
- **Edge cases:** Figma-injected theme classes (`figma-light`), mixed-direction layer names (bidi isolation with `unicode-bidi: plaintext`), long German strings wrapping, currency/percentage formatting in tokens.
- **Tests:** string-table completeness test (`every key used in ui.html exists`), Playwright RTL screenshot, theme toggle persistence.

### 5.10 Performance & scalability

**IMP-40 · `S2` · Unbounded concurrency in traversal** · Effort M
- **Current:** `buildRawNode()` does `Promise.all(node.children.map(...))` (`:1035`) — a 2,000-child frame issues 2,000 concurrent `getCSSAsync()` calls; each also awaits `compInfo`, `varInfo` etc.
- **Proposal:** a small async pool (e.g. 8–12 concurrent), chunked children, and a time budget with graceful "partial" output. Also batch variable/style lookups with a memo per refresh.
- **Edge cases:** 10,000 children; a mix of cheap and expensive nodes; Dev Mode (read-only APIs are usually faster); timeouts; cancellation when the selection changes (`reqId`).
- **Tests:** harness instrumentation counting in-flight calls (max ≤ pool size); perf budget test (600 layers < 2.5 s already asserted for codegen; add 2,000 layers < 8 s with partial output).

**IMP-41 · `S2` · Refresh does too much work per selection change** · Effort M
- **Current:** `refresh()` = `extractSpec` + `getCSSAsync` + `diffBaseline` (up to 2,500 nodes) + `a11yAudit` (400) + `collectAssets` (4,000 visits) + up to 24 PNG exports, **sequentially**.
- **Proposal:** split into *fast state* (spec + gate + header, posted in <200 ms) and *lazy sections* the UI requests on demand (a11y, changes, assets, thumbnails), each with its own message and its own cache. Keep one render pipeline but allow sections to arrive late (skeleton).
- **Edge cases:** a user opens a section after changing selection (stale response — needs a node id + `requestId`), a section requested twice, a closed section that should never compute, Dev Mode, empty selection, a 2,000-layer frame.
- **Tests:** message-schema tests for the new types; response-identity tests (like the existing out-of-order code test); a perf test asserting the header state arrives without computing a11y.

**IMP-42 · `S3` · Thumbnails** · Effort S
- **Current:** up to 24 PNGs per selection change, object URLs cached in `S.thumbs` and only revoked when leaving inspect mode (`ui.html:1571`) → memory grows as you click through layers.
- **Proposal:** LRU cap (~60), revoke on eviction, re-use by `(id, version)`, and a "show thumbnails" setting.
- **Tests:** LRU unit test; Playwright memory/URL-count check (instrument `URL.createObjectURL`).

**IMP-43 · `S3` · `nodechange` listener leak across pages** · Effort S
- **Current:** `watchPage()` (`:3524`) attaches a `nodechange` handler to `figma.currentPage` on every `currentpagechange` and never calls `.off()`.
- **Proposal:** keep a reference and detach before re-attaching; also detach on `figma.closePlugin`.
- **Edge cases:** 30 page switches in one session (30 handlers), a page removed while watched, plugin reload.
- **Tests:** harness counts listeners per page.

### 5.11 Security & privacy

**IMP-44 · `S2` · Privacy tests don't cover the new surface** · Effort S
- **Current:** tests assert no network APIs, no private font names in Google URLs, manifest allowlist.
- **Add:** no design text in `postMessage`/diagnostics; no `figma.root.name`/file key leakage; font uploads stored unencrypted in `clientStorage` (disclose in PRIVACY.md, add "remove all fonts"); preview `srcdoc` injection surface (already CSP + no-scripts, add a test for `</style>`/`</script>` breakout in generated HTML); `map:` paths can't escape (`MAP_PATH_RE` exists — add `..` cases); `devres-add` URL schemes; note/label markdown rendering (`mdLite` — check for HTML injection: it escapes first, good).
- **Tests:** extend `privacyAndOffline()` and `messageValidation()` with 10–15 cases; a browser test that a generated HTML containing `</style><script>` cannot execute.

**IMP-45 · `S3` · Manifest hardening** · Effort S
- **Current:** local id `devready-inspect-local`, no publish metadata, `codegenPreferences` only cover the 7 web languages for `unit`/`gate`.
- **Proposal:** real plugin id at publish time, `gate`/`unit` preferences for native targets, a `codegenPreferences` "naming style" (kebab/camel), accurate `reasoning` per capability, and a test that `manifest.codegenLanguages` exactly equals `LANG_IDS` (the UI has `LANGS` too — three lists to keep in sync).
- **Tests:** set-equality test across `manifest.json`, `LANG_IDS`, `ui.html` `LANGS`, and `tests/run.js` `LANGS` (a fourth place).

### 5.12 Tests & CI

**IMP-46 · `S2` · No unit tests for pure helpers** · Effort M
- **Untested (directly):** `cssToTailwind`, `slug`/`pascal`/`camel`/`cleanName`, `remify`, `colorHex`, `nodeSig`/`vals`, `cssIdent`, `themeSelector`, `swStr`/`ktStr`/`dtStr`/`jsQuote`, `cleanSvg`, `parseColorStr`, `parsePad`, `pxNum`, `hover`-ish helpers, `blendOver`/`contrastRatio` (only via the audit), `makeZip`/`crc32` (UI!), `esc`/`escHtml`/`escAttr`, `jsxStr`, `hl()` highlighter.
- **Proposal:** extract-or-invoke them in `tests/unit.js` via the existing VM sandbox (`eng.ctx.<fn>`), table-driven, ≥200 assertions. Add `tests/unit-ui.js` that loads `ui.html`, extracts the `<script>`, and evaluates pure functions (ZIP, escaping, `fmtColor`, `ago`, `fmtDate`, `hlVal`, `guessKey`) in a DOM-free VM with a tiny stub.
- **Tests:** the tables themselves.

**IMP-47 · `S2` · No fuzz/property tests** · Effort M
- **Proposal:** seeded generator producing random trees (depth, type mix, names from a hostile alphabet, unicode text, mixed values, extreme numbers) → assert: never throws, always returns files, validators pass, output is deterministic for a seed, runtime under budget.
- **Edge cases:** the generator itself must include masks, gradients, image fills, instances, zero/negative sizes, NaN/Infinity guard, huge strings.
- **Tests:** 100 seeds in CI (fast), 10,000 locally via `--fuzz=10000`.

**IMP-48 · `S2` · Golden coverage is 4 pairs** · Effort S
- **Current:** `nested-components` and `hostile-content` × `react-ts`/`html-css`.
- **Proposal:** one golden per target for a single "kitchen sink" fixture (12 files), plus `swiftui`, `compose`, `flutter`, `react-native` for the existing fixtures, plus a `spec` golden (JSON from `extractSpec`).
- **Tests:** `npm test -- --update-golden` with a reviewable diff format (already prints the first differing line — extend to path + line number).

**IMP-49 · `S2` · No perf/memory budgets in CI** · Effort S
- **Current:** one `ms > 2500` assertion per fixture×target.
- **Proposal:** track per-target timings in `docs/test-report.md`, fail on >20 % regression vs a committed baseline file, and add budgets for `extractSpec`, `a11yAudit` (400 nodes), `diffBaseline` (2,500 nodes), `buildTokens` (500 variables).
- **Edge cases:** CI machine variance → use generous absolute budgets and a relative guard with a tolerance; allow `--no-perf` locally.

**IMP-50 · `S3` · Browser suite is a smoke test** · Effort M
- **Current:** renders the panel and attacks the preview sandbox.
- **Proposal:** add axe-core accessibility scan, keyboard-only flows, demo-mode interactions, ZIP download integrity (`unzip -t` on the downloaded file via Playwright download API), light/dark screenshots (visual diff with a tolerance), and a "large demo" (500 layers) render.
- **Tests:** the above, in `tests/browser.py`.

**IMP-51 · `S3` · Doc consistency is only the check count** · Effort S
- **Proposal:** one `docs` test that also verifies: version in `package.json` appears in README + ARCHITECTURE; `CHANGELOG` has an entry for the current version; `manifest.codegenLanguages` count matches the README claim ("12 targets"); `PRIVACY.md` mentions every storage key used in code (`baseline`, `status`, `map`, `note`, `noteText`, `redlines`, `devready-settings`, `font:`); feature claims in README correspond to a message type or code path.
- **Tests:** the above (string/AST-free regex checks are enough and robust).

### 5.13 Docs, packaging, distribution

**IMP-52 · `S2` · Not on Figma Community** · Effort M (mostly non-code)
- Real plugin id, Community listing assets (already in `docs/brand`), a 30-second demo GIF, changelog-based release notes, versioned ZIP in the GitHub release (CI already builds it), "What's new" toast on version change, and an install/update path that doesn't require a re-import.
- **Edge cases:** plugin id change (relaunch data reset), files that stored `map:` under an old id, users on an older local install, Figma review feedback (network access reasoning).
- **Tests:** a release checklist test that the manifest id is not the local placeholder before tagging.

---

## 6. New feature proposals

Ordered by user value ÷ effort. Each has scope, edge cases and tests; the roadmap in §9 sequences them.

### F-01 · Handoff report export (`S2`, M) — *highest value new feature*
One click → **Markdown** (and HTML/JSON) report containing: frame + status + source + timestamp, box model, layout, typography table, colours + styles, tokens with all modes, component props/overrides, assets manifest, a11y findings with rule + WCAG reference, and the change list. Paste into a PR or Notion; no network needed.
- **Edge cases:** 500 layers (paginate by section, cap assets/a11y rows with "…and N more"), markdown injection from layer names (escape `|`, backticks, newlines), RTL/emoji names, huge token sets, embedded code in fenced blocks (fence length must exceed the longest run of backticks), a report for a *locked* frame (must honour the gate or explicitly say "gate bypassed"), report for a multi-selection.
- **Tests:** markdown escaping table (20 hostile names), golden report for `kitchen-sink`, size budget (<2 MB), `report` message schema validation, Dev Mode read-only (no writes).
- **Done when:** a 214-layer frame produces a report a developer can read without opening Figma, and `docs/test-report.md` includes the golden.

### F-02 · Change tracking 2.0 (`S1`, L)
Semantic diff with structured paths (`fill[0].color`, `cornerRadius.topLeft`, `padding.top`), variable/style binding awareness, mode-switch detection, N baselines/history, per-change "select layer", filter by kind, ignore list, and export (Markdown/JSON).
- **Edge cases:** see IMP-26/27/28. Plus: a change caused only by another library publishing an update; undo/redo; a component main changed (all instances change — report once); node id reuse after delete+undo; a baseline saved in Dev Mode (read-only → not allowed); two users saving baselines concurrently.
- **Tests:** one signature test per property; group-collapse test; "mode switch changes 200 layers → one group"; legacy snapshot; storage budget; export golden.

### F-03 · Accessibility 2.0 (`S1`, L)
Rule engine (contrast, non-text contrast, target size, label/alt, heading order, form labels, colour-only meaning, focus indicator, motion), per-rule config, ignore-with-reason (persisted), WCAG 2.2 mapping, "select all failing", report export (F-01), and a per-frame pass/fail summary badge.
- **Edge cases:** see IMP-31/32/33. Plus: 2,000-layer frames (cap + honest "scanned" count), a11y for component *sets*, text in instances (dedupe by component), text inside hidden frames, contrast on gradient/image/blend → `unknown` with guidance.
- **Tests:** rule tables, contrast matrices, dedupe, ignore persistence, report golden.

### F-04 · Codegen fidelity pack (`S1`, L)
Masks, image crop/TILE, all gradient types, dash/cap/join, layout grids → CSS grid, constraints → responsive CSS, truncation → `line-clamp`, inner shadows, blend modes, boolean ops (already assets), z-order (already partially), ellipsis, arrows, `clip-path` for simple shapes, plus a "fidelity notes" block listing everything that could not be represented.
- **Edge cases:** see IMP-12…16. Plus: masks on native targets, grid + auto-layout mixed, `min/max` conflicting with fixed size, `aspect-ratio` + fixed height, RTL layout (`layoutMode` + `itemReverseZIndex`), `space-between` with a single child.
- **Tests:** new fixtures (`masked-card`, `gradient-stack`, `cropped-images`, `grid-layout`, `truncated-text`, `nested-boolean`); one golden per target; "fidelity notes are never empty when a feature is dropped" assertion.

### F-05 · Framework packaging options (`S2`, M)
Named presets: React + CSS Modules, styled-components, Tailwind (with `tokens.css`), Vue 3 `<script setup>`, Svelte 5 runes, RN style sheet split, SwiftUI + theme enum, Compose + `Theme.kt`, Flutter + `theme.dart`. Per-export options: component file name, prop naming (`props` vs `args`), `data-testid`, import aliases.
- **Edge cases:** file-name collisions, reserved words as component names (`Switch`, `Default`, `Class`), import path aliasing, CSS Modules class naming vs BEM, Tailwind safelist for dynamic classes (should not exist), Svelte 5 vs 4 syntax, `tsconfig` path aliases.
- **Tests:** per-preset compile/parse (esbuild for JS/CSS, `tsc` for TS, `svelte-check`/`vue-tsc` optional), reserved-word table, golden per preset.

### F-06 · Gate 2.0 (`S1`, M)
Derived states (`READY`, `READY·CHANGED`, `STALE`, `COMPLETED`), "mark reviewed", bulk mark from the ready list, multi-select mark, reviewer sign-off (name + timestamp), gate policy per file/section (IMP-08), and an explicit "session-only inspect anyway" instead of a device-wide setting.
- **Edge cases:** a designer and developer with different policies; a section marked but a frame explicitly *not* ready (child override); moving a frame between sections; a renamed section; a completed design that gets edited (COMPLETED + changes); offline/read-only.
- **Tests:** state-derivation table, precedence matrix (native vs flag vs policy vs override), bulk mark, session-only reset.

### F-07 · Search & command palette (`S2`, M)
`⌘K`/`Ctrl+K` palette: search layers, variables, tokens, assets, a11y rules, sections; jump-to-layer; run actions (mark ready, export, copy code, switch language, toggle theme).
- **Edge cases:** IME composition, unicode normalisation, fuzzy scoring, 5,000 items, stale index after edits, keyboard-only usage, palette open while locked.
- **Tests:** scoring unit tests; Playwright keyboard flow; 5,000-item perf.

### F-08 · Design-to-code verification (`S2`, L) — *new capability, not parity*
Render the generated HTML in the preview iframe, compare with the Figma PNG snapshot, and report structural + visual mismatches ("12 px height difference in header", "missing icon", "font fallback active"). Score per frame; list the top mismatches with a jump link.
- **Edge cases:** font loading race (must settle or report "font not loaded"), animation/video, image decode timing, DPR/scale, sub-pixel rounding tolerance, a11y-hidden layers, deterministic output requirement (same input → same diff).
- **Tests:** deterministic diff on a synthetic pair (identical → 0; 1 px offset → 1 finding); tolerance thresholds; golden diff report.

### F-09 · Team settings sync & policy (`S2`, M)
File-level policy in shared plugin data (gate, unit, rem base, colour format, a11y thresholds), read-only for non-owners, "apply to this file", "copy policy JSON".
- **Edge cases:** concurrent writes, older clients, Dev Mode read-only, policy removal, per-language overrides.
- **Tests:** schema validation, precedence, Dev Mode, migration.

### F-10 · Token drift checker (`S2`, M)
Paste/upload the repo's token file (CSS/JSON) → compare with the Figma variables → report added/removed/changed values and naming mismatches, as a table plus Markdown export. Fully local (clipboard/file input), so privacy is preserved.
- **Edge cases:** different naming conventions (kebab vs dot), aliases, modes, numeric precision (`16px` vs `1rem`), duplicate names, 1,000 tokens.
- **Tests:** parser unit tests (CSS/JSON), comparison table, precision tolerance, hostile input (huge file, binary).

### F-11 · Diagnostics & safe mode (`S2`, S)
Opt-in visible error log, "copy diagnostics", per-feature availability matrix (which Figma API failed), and a safe mode that turns off expensive sections.
- **Edge cases:** see IMP-03/44 (privacy), Dev Mode, demo mode.
- **Tests:** sanitisation, cap, feature-matrix snapshot.

### F-12 · Multi-frame flows (`S3`, M)
Select several frames → screen list, navigation stubs from `reactions` (`NAVIGATE`), a Next.js/Expo router skeleton, and shared tokens across screens.
- **Edge cases:** duplicate screen names, cyclic navigation, 20 frames (budget), native targets (screen per file), gate per screen.
- **Tests:** flow graph unit tests (dedupe, cycles), scaffold golden.

### F-13 · Asset pipeline (`S3`, M)
Dedupe by hash+transform, export all declared presets, SVG optimisation (ids/metadata/`viewBox`), icon sprite/`symbol` sheet, alt-text manifest, favicon/manifest generation, memory-safe batching.
- **Edge cases:** see IMP-21. Plus: SVGs with the same content but different ids (dedupe by normalised hash), 1,000 icons, names with emoji.
- **Tests:** normalised-hash dedupe, sprite golden, 1,000-icon perf.

### F-14 · i18n & RTL for the panel (`S3`, L)
String table, `dir` support, `Intl` formatting, translated demo data, and an RTL screenshot test.
- **Edge cases:** see IMP-39.

### F-15 · Publish to Figma Community (`S2`, M)
Real id, listing copy, demo file, review checklist, in-plugin "what's new", update notes from `CHANGELOG`, and a `vscode`-capability verification run (currently *never tested* on a real VS Code session).

---

## 7. Edge-case catalogue (cross-cutting)

Use this as the checklist for §8 fixtures. "Today" = current behaviour in v1.5.1.

### 7.1 Gate & status

| # | Case | Today | Expected |
|---|---|---|---|
| G1 | Status on a section, layer nested 5 deep | unlocked | unlocked |
| G2 | Status on a group (plugin flag) | never written (`markTarget` null) | flag written |
| G3 | Native READY + stale plugin COMPLETED | native wins (flag retained) | native wins + flag refreshed |
| G4 | Native status on paid plan, viewer on free plan | locked (flag cleared) | unlocked via flag |
| G5 | Marked frame moved to another page | still marked, current-page list stale | discoverable |
| G6 | Frame deleted while panel open | selection empties | empty state |
| G7 | Gate off, then on | design relocks | relocks |
| G8 | "Inspect anyway" | persisted for the device | session-only (proposal) |
| G9 | Dev Mode read-only | flag path only | unchanged |
| G10 | Localised layer names (`Bouton`) | not interactive | configurable |
| G11 | Two users mark concurrently | last write wins | timestamp + conflict note |
| G12 | Status note 2,000 chars | truncated by schema | truncated with counter |
| G13 | Status on a component set | works | works |
| G14 | Instance inside a marked section | unlocked | unlocked |
| G15 | Node id reused after delete/undo | baseline keyed by id collides | detect id reuse |

### 7.2 Spec extraction

| # | Case | Today |
|---|---|---|
| S1 | `layoutGrids` | not exported |
| S2 | Resizing constraints (`MIN/CENTER/MAX/STRETCH`) | not exported |
| S3 | `isMask` / mask chain | not exported |
| S4 | `imageTransform` / CROP / TILE | not exported |
| S5 | 40 text segments | 12 shown, "more" count |
| S6 | 10,000-character text | 4,000 kept, no banner |
| S7 | Mixed `fontName` | `figma.mixed` → `null`, segment table may mislead |
| S8 | Zero/negative width | printed as-is |
| S9 | Rotated node | `x/y` from `absoluteBoundingBox` in places, `node.x/y` elsewhere |
| S10 | `opacity` on an ancestor | not shown in the box model |
| S11 | Gradient with 20 stops | shown, no transform info |
| S12 | Stroke with per-side weights | joined string |
| S13 | Effect `visible:false` | filtered (good) |
| S14 | Empty frame | "no visible layers" |
| S15 | Remote/library component | `mainId: null`, mapping by key |
| S16 | Instance with 30 overrides | 12 shown |
| S17 | Variable modes | only when ≥2 modes exist (by design) |
| S18 | Explicit variable mode per layer | shown if resolvable |
| S19 | Non-ASCII variable names | slugged for CSS (collisions possible) |
| S20 | Two variables with the same `codeSyntax` | no disambiguation |

### 7.3 Code generation & escaping

| # | Case | Today |
|---|---|---|
| C1 | Depth 3,000 | **crash** |
| C2 | 10,000 children in one frame | unbounded concurrency |
| C3 | Layer names with `"` `'` `<` `>` `&` `{}` `{{}}` `${}` | escaped (tested) |
| C4 | Text with bidi overrides `\u202A-\u202E` | stripped in Kotlin only |
| C5 | Text with `\u2028`, NUL, tabs | escaped in JS; check Dart/Swift |
| C6 | Emoji / ZWJ sequences | pass-through |
| C7 | `</style>` inside a text layer | escaped in HTML (verify per target) |
| C8 | Backtick runs in text (markdown/HTML fences) | not applicable yet; F-01 must handle |
| C9 | Masked sibling | **fully rendered** |
| C10 | Cropped image | wrong crop |
| C11 | Angular/diamond gradient | lossy |
| C12 | Dashing/arrow stroke | plain border |
| C13 | `layoutGrids` | absent |
| C14 | Constraints | absent (fixed sizes) |
| C15 | Text truncation | no ellipsis/clamp |
| C16 | Inner shadow | `box-shadow` may be wrong (verify) |
| C17 | Blend mode | passed through from CSS (verify native targets) |
| C18 | Boolean op with text | outline text in SVG (may lose fonts) |
| C19 | Auto-layout `WRAP` + `space-between` | mapped |
| C20 | Grid auto-layout | `display:grid` from `getCSSAsync` (verify template) |
| C21 | 1,500-layer project | budget note |
| C22 | Zero-visible-layers frame | `empty.txt` |
| C23 | Reserved word layer name (`Class`, `Switch`) | `pascal()` prefixes `C` → `CClass` (good) |
| C24 | Duplicate component names | numbered suffixes |
| C25 | Component set with 300 variants | extraction cost/perf |
| C26 | Instance swap prop | string prop, not import |
| C27 | Same asset on 20 instances | deduped by component key |
| C28 | Asset name collision (case-insensitive FS) | suffix numbering (case not normalised) |
| C29 | `rem` mode with 1 px hairlines | kept as px (good) |
| C30 | Negative/zero padding | printed |

### 7.4 Fonts & assets

| # | Case | Today |
|---|---|---|
| F1 | Private font named exactly like a Google family | privacy test guards it |
| F2 | Variable font with 1–1000 range | catalog stores ranges |
| F3 | Italic-only style used | `@font-face` italic |
| F4 | 9 weights, 3 uploaded | missing faces fall back silently |
| F5 | Uploaded font deleted | `fonts-updated` re-render |
| F6 | 20 uploaded fonts × 2.5 MB | no total budget |
| F7 | Font family with quotes/spaces | `local("…")` quoting |
| F8 | `.ttc`/`.otc` upload | rejected by `ext` enum |
| F9 | Image with `imageTransform` | see C10 |
| F10 | 300 assets | 60-row cap, silent |
| F11 | Asset export fails for 1 of 40 | project aborts (good) |
| F12 | SVG with embedded raster | inlined |
| F13 | SVG `foreignObject` | may break |
| F14 | Zero-byte asset | `V.bytes` rejects uploads; exports could be 0 |
| F15 | Asset named `../../etc/passwd` | `slug()` sanitises; assert |
| F16 | Single-file total 9 MB | note + `none` placeholders |
| F17 | Base64 inflation 33 % | unaccounted in budget |
| F18 | PDF export from the panel | supported; not in project |

### 7.5 Tokens & variables

| # | Case | Today |
|---|---|---|
| T1 | Alias chain 5 deep | resolved recursively with depth guard |
| T2 | Alias to a missing variable | `null` value |
| T3 | Duplicate `codeSyntax` | last wins |
| T4 | Variable with no default mode value | printed as `undefined`? |
| T5 | `STRING`/`BOOLEAN` variables | exported raw |
| T6 | Unicode/`/` in names | slugged |
| T7 | 500 variables × 4 modes | large file, no progress |
| T8 | Renamed collection | `collCache` stale |
| T9 | Deleted variable | `null` cached |
| T10 | Style-based tokens (paint/text/effect) | partly exported |
| T11 | Dark-mode media query output | only `[data-theme]` |
| T12 | Tailwind theme names with `/` | sanitised? |
| T13 | Numeric precision (`1.333rem`) | rounded to 4 dp |
| T14 | Mode switch mid-session | stale cache |

### 7.6 Change tracking & storage

| # | Case | Today |
|---|---|---|
| K1 | 2,500 layers | `SNAP_LIMIT` |
| K2 | 2,501 layers | `__partial` → no added/removed |
| K3 | Partial + identical | claims "no changes" (misleading) |
| K4 | Layer renamed | change with Name detail |
| K5 | Layer moved between parents | remove + add |
| K6 | Fill hex → variable, same colour | undetected |
| K7 | Variable mode switched | undetected (hash is raw paint) |
| K8 | Text style re-bound, same values | undetected |
| K9 | Gradient stop changed | "style" only |
| K10 | Effect radius changed | "style" only |
| K11 | `visible` toggled | detected |
| K12 | Zero-opacity layer | omitted from codegen, tracked |
| K13 | 1,000 changes | 150 shown |
| K14 | Baseline from v1.2 | legacy read (tested) |
| K15 | Frame duplicated | copied baseline? (plugin data copies) |
| K16 | Baseline chunks interrupted | `readChunked` returns partial JSON → `null` |
| K17 | 40 baselines in one file | unbounded growth |
| K18 | Text >80 chars changed at char 90 | flagged, detail identical |
| K19 | Mixed paint values | symbol → `null`/`"mixed"` |
| K20 | Undo after mark | baseline not updated |

### 7.7 Accessibility

| # | Case | Today |
|---|---|---|
| A1 | Text in a 20 %-opacity parent | **passes (wrong)** |
| A2 | Text with 0 % opacity | still evaluated |
| A3 | Text on an image | `unknown` |
| A4 | Text on a gradient | `unknown` |
| A5 | Blend mode background | ignored |
| A6 | Per-run colours | only first solid fill |
| A7 | Target with a 44 px hit area, 20 px visual | fails |
| A8 | Icon-only button named `bouton` | no finding |
| A9 | Text link | not a target |
| A10 | 2,000-layer frame | scans 400, `limited` flag (shown?) |
| A11 | Two identical failing cards | grouped (good) |
| A12 | Non-text contrast (icon on background) | not checked |
| A13 | Form field with no label | not checked |
| A14 | Heading order skipped | not checked |
| A15 | Focus indicator | not checked |
| A16 | 375 px component inside a 1440 px frame | desktop rules |
| A17 | 12 px text | warn (may be noise) |
| A18 | `fontSize` mixed | assumes 16 |
| A19 | Hidden instance text | skipped |
| A20 | Colour-only error state | not checked |

### 7.8 Panel UI

| # | Case | Today |
|---|---|---|
| U1 | Keyboard-only use | impossible (no key handlers) |
| U2 | Screen reader | no roles/labels/live regions |
| U3 | Scroll after edit | resets |
| U4 | Long note typed, selection refreshed | content may be lost |
| U5 | 500 variables | one long list |
| U6 | Preview iframe | reloads per render |
| U7 | Light theme | Figma theme vars + `prefers-color-scheme` |
| U8 | Manual theme | none |
| U9 | Panel width 360 px | wraps; check tables |
| U10 | Zoom 200 % | untested |
| U11 | RTL | unsupported |
| U12 | Non-English UI | unsupported |
| U13 | Clipboard denied | silent |
| U14 | Demo mode | drifts from `state` |
| U15 | Two code requests racing | guarded by `requestId` |
| U16 | Request never answered | hangs |

### 7.9 Export & download

| # | Case | Today |
|---|---|---|
| E1 | 300 items | schema slice (silent) |
| E2 | Name collision in ZIP | `-2` suffix |
| E3 | Unicode names | UTF-8 flag set |
| E4 | 0-byte file | allowed |
| E5 | >4 GB / 65,535 entries | broken archive |
| E6 | Duplicate names after `-2` loop | possible |
| E7 | One asset fails | abort with message |
| E8 | Browser blocks download | no feedback |
| E9 | Single-file > budget | `none` + note |
| E10 | Path traversal in asset name | `slug()` |
| E11 | 2 downloads at once | blob URL lifetime |

### 7.10 Platform, plans & permissions

| # | Case | Today |
|---|---|---|
| P1 | Free plan | no native status → flag |
| P2 | Org with plugins restricted | plugin doesn't load (Figma) |
| P3 | Dev Mode | read-only enforcement (tested) |
| P4 | Figma for VS Code | **never run** (README says so) |
| P5 | Light theme in Figma | never run |
| P6 | Very large file (10k nodes/page) | slow refresh |
| P7 | Remote libraries offline | `null` caches sticky |
| P8 | Document access `dynamic-page` | async APIs used |
| P9 | Plugin reload mid-operation | state lost |
| P10 | Locale/timezone | `toLocaleDateString` only |

---

## 8. Testing strategy & unit-test plan

### 8.1 Structure (keep the existing shape, add layers)

```
tests/
├── harness.js        (extend: depth/large builders, call instrumentation, listener spies)
├── fixtures.js       (+12 fixtures, see Appendix D)
├── validators.js     (+ compile hooks for dart/kotlin; SVG/HTML sanity)
├── run.js            (golden + docs + repo + codegen, as today)
├── features.js       (a11y, tokens — extend per rule)
├── unit.js           (NEW: pure functions from code.js, table-driven)
├── unit-ui.js        (NEW: pure functions from ui.html in a DOM-free VM)
├── fuzz.js           (NEW: seeded random trees; --fuzz=1000)
└── browser.py        (extend: axe-core, keyboard, scroll, download, screenshots)
```

### 8.2 Unit tests to add (concrete)

| Function | Cases |
|---|---|
| `cssToTailwind` | every `switch` branch + fallback; negative/decimals/`rem`/`var()`/`calc()`; 4-value padding; `999px` radius; `flex` variants; 60+ rows |
| `slug`/`pascal`/`camel`/`cleanName` | reserved words, emoji, leading digits, all-punctuation, 200-char names, `C++`, `#hashtag` |
| `remify` | hairlines, negatives, `0`, `1.5rem` input, big values |
| `colorHex`/`hex2`/`to255` | 0/1 clamp, alpha rounding, 8-digit hex |
| `nodeSig`/`nodeVals`/`valDiff` | each component; `figma.mixed`; missing props; symbol paints |
| `pxNum`/`parsePad`/`parseColorStr`/`npx` | units, `auto`, gradients, named colours, `rgba()` |
| `swStr`/`ktStr`/`dtStr`/`jsQuote`/`rnStr`/`cssStr` | quotes, newlines, `$`, backslash, `\u2028`, bidi, interpolation tokens |
| `escHtml`/`escAttr`/`jsxStr`/`jsxTextNode` | `<>&"'{}` + backticks + newlines |
| `cleanSvg`/`cleanCss`/`utf8`/`rasterExtension` | metadata stripping, BOM, GIF/WebP/PNG/JPEG sniffing |
| `themeSelector`/`cssIdent`/`tokenValue`/`jsonSet` | duplicate names, unicode, numeric precision, mode fallbacks |
| `contrastRatio`/`relLum`/`blendOver`/`composeLayers` | known pairs, alpha compositing, same colour, black/white |
| `makeZip`/`crc32` (UI) | CRC vectors, empty file, unicode name, 2 files, duplicate name, 0 bytes; validate with `unzip -t` |
| `fmtColor`/`hsl`/`rgbaCss` (UI) | alpha, hsl rounding, hex format setting |
| `ago`/`fmtDate` (UI) | future dates, <60 s, years, invalid ISO |
| `hl`/`hlVal` (UI) | regex safety on hostile code, no `undefined` in output |
| `guessKey` (UI) | font file names (`Inter-SemiBoldItalic.woff2`, `inter_700.woff2`, `foo.ttf`) |

### 8.3 Harness upgrades

1. **Instrumentation:** counters for `getCSSAsync`, `exportAsync`, `getNodeByIdAsync`, and a max-in-flight tracker (for IMP-40).
2. **Listener spy:** `page.on/off` counters (IMP-43).
3. **Large builders:** `TREE(depth, width)` and `WIDE(n)` helpers.
4. **Mixed values:** a `MIXED` sentinel matching Figma’s symbol.
5. **Strictness:** already strict; add assertions that every mock getter accessed is declared (catches accidental sync API usage).
6. **`loadEngine({ readOnly: true })`:** extend traps to `setSharedPluginData` on `figma.root` (IMP-08).

### 8.4 Fuzz/property tests (IMP-47)

```js
// tests/fuzz.js  (sketch)
for (let seed = 1; seed <= N; seed++) {
  const root = randomTree(rng(seed));           // depth ≤ 140, masks, gradients, mixed, unicode
  const out = await eng.generateCode(root, lang, ...);
  assert(out.files.length > 0);
  out.files.forEach(f => assert(validateFile(f).length === 0, `seed ${seed}`));
  assert(deterministic(seed));                   // same seed → byte-identical output
}
```
Properties: never throws · output parses · escaping holds (`no raw '<script'` unless from text-escaped content) · runtime budget · memory (no unbounded array growth; cap `ctx.assets`).

### 8.5 Golden matrix (IMP-48)

Add `kitchen-sink` fixture → golden for **all 12 targets** + `spec.json`. Keep current 4 pairs. Format the diff as:
```
src/components/Card.tsx:214  - <h2 class="card__title">Weekly</h2>
                             + <h2 class="card__title">Weekly insight</h2>
```

### 8.6 Browser tests (IMP-50)

- axe-core: 0 serious/critical violations (light + dark).
- Keyboard: `Tab` through the header → `Enter` opens Settings → arrows move → `Escape` closes and restores focus.
- Scroll preservation across a simulated `state` message.
- Demo mode: every section renders; no console errors.
- ZIP: click "Download project", capture the download, `unzip -t`, assert file list.
- Preview injection: a generated doc containing `</style><script>alert(1)</script>` and `<img src=x onerror=…>` stays inert.
- 500-layer demo renders under 2 s.

### 8.7 CI additions

| Job | Contents | Blocking? |
|---|---|---|
| `unit` | `node tests/unit.js && node tests/unit-ui.js` | yes |
| `fuzz` | `node tests/fuzz.js --fuzz=200` | yes |
| `native` | `dart analyze` on Flutter output; `kotlinc` parse for Compose (best-effort) | warn first, then block |
| `browser` | extended suite + axe | yes |
| `perf` | budgets + report | yes (generous) |
| `docs` | version/changelog/manifest/storage-claim consistency | yes |

---

## 9. Phased delivery plan

Each phase is independently shippable, keeps the 158 existing checks green, and adds its own tests. Estimates assume one experienced developer, including tests and docs.

### Phase 0 — Correctness hot-fixes (1–2 days)
1. D-1 depth guard + last-resort error file.
2. D-2 ancestor-opacity in contrast.
3. D-3 React mappings for TS targets.
4. D-5 version consistency test (+ fix README/ARCHITECTURE).
5. IMP-01 `skipInvisibleInstanceChildren`, IMP-43 listener leak, IMP-05 request timeouts, IMP-02 cache invalidation.
6. IMP-29 ZIP guard (>4 GB / 65,535) + timestamp.
**Exit:** 12–18 new checks; golden unchanged except the intended ones; `npm run verify` green; CHANGELOG "Fixed" section.

### Phase 1 — Robustness & performance (3–5 days)
IMP-40 concurrency pool, IMP-41 fast/lazy state split (header first, sections on demand), IMP-25 granular diff invalidation, IMP-03 diagnostics, IMP-11 component/variant metadata, IMP-30 storage report.
**Exit:** 600-layer refresh < 400 ms on a mid-range laptop; 2,000-layer frame returns partial output in < 8 s; new perf budgets in CI.

### Phase 2 — Codegen fidelity (5–8 days)
IMP-12 masks, IMP-13 crop/TILE, IMP-14 gradients, IMP-15 truncation/text, IMP-10 spec fields feeding codegen, IMP-16 Tailwind theme, IMP-18 native TODOs → real handlers, IMP-17 variant props.
**Exit:** new fixtures + goldens for 12 targets; "fidelity notes" block; README "Known limits" rewritten to match reality.

### Phase 3 — Accessibility 2.0 (5–8 days)
IMP-31 rule engine + IMP-32/33, F-03, ignore-with-reason, report export (F-01), a11y panel redesign (per-rule rows, filters).
**Exit:** rule tables tested; a11y golden; WCAG mapping documented; the audit is defensible in a design review.

### Phase 4 — Panel UX & panel a11y (4–6 days)
IMP-34 ARIA/keyboard, IMP-35 scroll/focus preservation, IMP-36 search/palette, IMP-37 demo parity, IMP-38 clipboard, IMP-42 thumbnails.
**Exit:** axe 0 serious; keyboard-only walkthrough recorded in `docs/`; browser suite extended.

### Phase 5 — Change tracking 2.0 + handoff report (5–8 days)
IMP-26/27/28, F-01, F-02 export.
**Exit:** semantic diff tests; history; report golden; storage budgets.

### Phase 6 — Gate 2.0 & team policy (3–5 days)
IMP-06/07/08/09, F-06, F-09.
**Exit:** precedence matrix tests; session-only bypass; file policy with Dev Mode read-only compliance.

### Phase 7 — Distribution & polish (3–5 days)
IMP-45/52, F-15, IMP-19, IMP-39 (i18n scaffolding), IMP-21/22 asset pipeline, F-05 presets.
**Exit:** Community submission checklist complete; manifest id swapped; release notes generated.

### Suggested next 10 development steps (smallest safe increments)

| Step | Work | Tests to write with it | Done when |
|---|---|---|---|
| 1 | Add `docs/IMPROVEMENTS.md` to the repo map + version-consistency check | `docs: README, ARCHITECTURE, package.json and CHANGELOG agree on the version` | CI red if versions drift |
| 2 | Depth guard in `buildRawNode` + traversal helpers | depth 3,000 returns a note; 120-depth golden unchanged | No stack overflow |
| 3 | Ancestor-opacity accumulation in `a11yAudit` | 3 opacity cases + existing contrast suite | Audit fails 20 %-opacity black text |
| 4 | `ctx.react` → `/^react-/` + mapping tests | mapping in 4 React targets, hostile name/path | TS targets import mapped components |
| 5 | `skipInvisibleInstanceChildren` + listener cleanup | flag assertion, listener count | No leak, faster on instance-heavy files |
| 6 | Cache invalidation on `nodechange` | rename variable/style, delete variable | Fresh names/values |
| 7 | Code/tokens request timeouts | fake-dropped response | No infinite spinner |
| 8 | ZIP guards + `unzip -t` test | 65,536-entry rejection, CRC vectors | Valid archives only |
| 9 | `tests/unit.js` skeleton with `cssToTailwind` (60 rows) | the table | First pure-function suite |
| 10 | `tests/unit-ui.js` with `makeZip`/`esc`/`fmtColor`/`ago` | the tables | Panel logic covered |

---

## 10. Risks, constraints & non-goals

**Risks**

| Risk | Mitigation |
|---|---|
| Two big files, no build step → merge conflicts and accidental global leaks | Add `'use strict'` at the top of both scripts (currently absent; the sandbox is per-file so leaking globals is easy), a lint rule for undeclared variables (ESLint already covers `ui.html`), and keep section banners |
| More features in `code.js` worsen refresh time | Phase 1 lazy sections must land *before* Phase 2/3 feature growth |
| Golden churn makes reviews noisy | One golden per target, deterministic output, `--update-golden` diffs with file:line |
| A11y rules create false positives → users mute the feature | Ignore-with-reason, per-rule toggles, "unknown" instead of "fail" when unsure |
| `figma.clientStorage` quota for uploaded fonts | Total budget + "remove all fonts" + size display |
| Plugin review rejects broader network reasoning | Keep zero network in `code.js`; the preview stays the only Google Fonts consumer |
| Community id change breaks relaunch/plugin data | Store data under the same `NS`; keep `relaunchButtons` keys stable; document migration |

**Non-goals (deliberate)**

- Reimplementing Dev Mode's hover-to-measure, version comparison or VS Code integration (Figma features, not APIs).
- Any server, account, telemetry or cloud sync (privacy is the product).
- Compressing the ZIP with a bundled library (store-only is fine; guard the limits instead).
- Building a general Figma-to-production converter (imports, routing, state management). The value is *accurate primitives* a developer then wires up.

---

## 11. Appendices

### A. Anchors in `code.js` (v1.5.1)

| Concern | Symbol | Line |
|---|---|---|
| Message schema / validators | `V`, `MSG_SCHEMA`, `validateMsg` | 34–85 |
| Gate | `ownStatus`, `findDevStatus`, `setReady`, `listReady` | 129–223 |
| Readiness targets | `MARKABLE`, `markTarget` | 162–172 |
| Variables / styles | `varInfo`, `styleName`, `getColl` | 226, 250, 1831 |
| Spec | `extractSpec`, `serializePaint`, `computeBox` | 268–556 |
| Tailwind | `SP`, `FS`, `RAD`, `cssToTailwind` | 587–742 |
| Assets | `collectAssets`, `exportNode`, `isIconLike` | 744–812 |
| Code engine | `buildRawNode`, `structurePass`, `namePass`, `extractComponents` | 940–1223 |
| Renderers | `renderHTML`, `renderJSX`, `stylesheet` | 1233–1310 |
| Fonts | `planFonts`, `googleCheck`, `GF_DATA` | 1386–1470 |
| Inlining | `materializeImageFills`, `inlineAssets` | 1576–1680 |
| Entry | `generateCode` | 1718 |
| Tokens | `tokenFromVariable`, `buildTokens` | 2992–3090 |
| Change tracking | `nodeSig`, `nodeVals`, `snapshot`, `diffBaseline` | 1935–2078 |
| A11y | `isInteractive`, `a11yAudit` | 2911–2983 |
| Canvas tools | `drawRedlines`, `drawCanvasNote`, `measurePair` | 3250–3400 |
| Runtime | `refresh`, `schedule`, `watchPage`, `onmessage` | 3435–3808 |

### B. Figma constraints that shape the design

| Constraint | Consequence |
|---|---|
| No DOM in the sandbox, no framework in the UI without a build step | Everything is string templating; XSS surface is real → keep escaping tests |
| `getCSSAsync()` is the only supported style reader | Anything not in its output must be read from node properties (masks, crop, grids, constraints) |
| 100 kB per shared-plugin-data entry | Chunked snapshots (exists) — keep the budget test |
| 3 s codegen budget in Dev Mode | 150-layer cap for codegen, fast font plan |
| `documentAccess: dynamic-page` | Async node/variable/style APIs only; page-scoped traversal unless `loadAllPagesAsync` |
| Dev Mode is read-only | All writes gated by `IS_DEV` (tested) — keep this test as a contract |
| No workers/timers throttling | Long loops block the UI thread → chunking, not threading |

### C. Proposed new message types (add to `MSG_SCHEMA` + attack test in the same commit)

| Type | Fields | Purpose |
|---|---|---|
| `section-request` | `section: oneOf(['a11y','changes','assets','thumbs','tokens'])`, `id`, `requestId` | Lazy section loading (IMP-41) |
| `a11y-config` | `rules: {…bool}`, `minTarget: num(16,96)` | Rule toggles (F-03) |
| `a11y-ignore` | `id`, `rule`, `reason: str(200)`, `on: bool` | Ignore with reason |
| `report-export` | `format: oneOf(['md','html','json'])`, `scope`, `id` | Handoff report (F-01) |
| `baseline-save-named` | `id`, `label: str(60)` | History (F-02) |
| `policy-set` | `settings`, `scope: oneOf(['file','user'])` | Team policy (IMP-08) |
| `diagnostics` | none (request) | IMP-03 |
| `storage-report` | none | IMP-30 |
| `fonts-clear` | none | IMP-20 |

Every one needs: validator, `case`, UI `send`, a `__invalid` attack test, and a `MSG_SCHEMA`-vs-README update (IMP-51 catches drift).

### D. Fixtures to add

| Fixture | Covers |
|---|---|
| `kitchen-sink` | every node type once; used for the 12-target golden matrix |
| `deep-tree` | 3,000 levels (truncation), 120 levels (golden) |
| `wide-frame` | 2,000 children (concurrency + perf) |
| `masked-card` | alpha masks, shape masks, mask + rotation |
| `cropped-images` | `imageTransform`, CROP/TILE, multiple image fills |
| `gradient-stack` | linear/radial/angular/diamond, transparency, gradient text |
| `truncated-text` | `maxLines`, ellipsis, fixed height, mixed decoration |
| `unicode-hostile` | emoji/ZWJ, RTL, bidi overrides, `\u2028`, NUL, tabs, CJK |
| `grid-layout` | GRID auto-layout, wrap, `space-between`, reverse z-index |
| `variant-matrix` | component set with 3 axes, 24 instances, boolean/text/swap props |
| `variables-heavy` | 300 variables, 4 modes, alias chains, duplicate `codeSyntax` |
| `styles-bound` | paint/text/effect styles bound, mode switch |
| `legacy-baseline` | snapshot from v1.2 (exists — keep) |
| `zero-and-negative` | 0×0, 1×1, negative spacing, huge numbers |
| `instances-deep` | instance inside instance inside instance, hidden instance children |

### E. Tracker

Copy this into an issue per phase.

```
[ ] Item ID: IMP-__ / D-_ / F-__
[ ] Change is behind no new global state (or it is added to DEFAULT_SETTINGS + schema)
[ ] Message added to MSG_SCHEMA with validators
[ ] Unit test(s) added (tests/unit*.js) or fixture + golden
[ ] Existing 158 checks still pass
[ ] `npm run verify` green
[ ] README / CHANGELOG / docs updated; version-consistency test green
[ ] Edge cases from §7 checked off for the touched area
[ ] Perf budget unchanged or improved
[ ] Privacy: no new network, no design text in new payloads
[ ] Dev Mode read-only still holds
```

---

---

## Appendix — implementation status (2026-10-26)

The suite has grown from 158 to **192 checks** while every item below landed; `npm test`,
`npm run lint` and `npm run check` are green after each batch.

### Shipped

| Area | Items | What changed |
|---|---|---|
| Depth / crash safety | #1, D-1, F5 | `MAX_DEPTH` (120) in every traversal, `ASSET_WALK_LIMIT`, bounded `allVector`/`hasNestedImageFill`, and `generateCode` now returns a readable `error.txt` instead of throwing into Figma. |
| Accessibility | #2, D-2 | Contrast uses accumulated ancestor opacity, unmeasurable backgrounds stay `unknown` with a confidence flag, every finding carries its WCAG rule id, and the audit reports when it stopped at its depth limit. |
| Code Connect | #3, D-3 | Mappings apply in `react-ts` and `react-tailwind-ts` as well as `react-css`/`react-tailwind`. |
| The gate | #4, D-4 | `flagTarget`/`statusTargets` mark the nearest layer that can hold a status, groups included; notes survive status changes; clearing removes both the native status and the flag. |
| Refresh cost | #5 | `clearLookupCaches()` on every document change, one `nodechange` listener per page instead of one per switch, and previews only reload when their document actually changed. |
| Change tracking | #9 (partial) | Hashes cover per-corner radii, per-side stroke weights, style/variable bindings, grids, text runs, constraints; a partial (depth-, count- or byte-limited) snapshot is reported as partial instead of “no changes”. New: a byte budget so a 2,500-layer snapshot cannot grow to ~1 MB of plugin data. |
| Design tokens | F13 | Alias **chains** resolve through hidden and cross-file links, unpublished/undeclared targets fall back to the literal value instead of `var(--undefined)`, published **library** variables are exported, unreadable values are kept and flagged, and cyclic aliases terminate. |
| Diagnostics | F17 | Empty `catch` blocks on meaningful reads (variables, library collections, variable modes, fonts, mappings) now record a bounded, de-duplicated note that the panel shows as “Limited data” and that travels with the token export. |
| Static HTML | F14 | `lang` and `dir="rtl"` are derived from the design's own text (Arabic, Hebrew, Devanagari, Thai, CJK, Cyrillic) instead of a hard-coded `lang="en"`. |
| Panel accessibility & UX | #8, #10 | ARIA menu roles and full keyboard operation, `aria-label`s on icon-only controls, scroll/focus preservation across re-renders, a 20 s timeout with retry for code requests, and honest copy for locked, partial and throttled states. |
| Version drift | D-5 | README, `docs/ARCHITECTURE.md` and `package-lock.json` now agree with `package.json` at 1.5.1. |
| Test suite | #10 (partial) | New `tests/improvements.js`, `tests/enhancements.js` and `tests/unit-ui.js`: the panel's pure helpers (escaping, colour formats, relative dates, the ZIP writer, the syntax highlighter) are now unit-tested in a VM, alongside adversarial trees, token aliases, parser-level SVG evasion and export responses. |
| Manifest | — | The `unit` preference covers every web target and `gate` covers all twelve languages. |

### Still open

Phase 2 codegen fidelity (masks, image crop/scale mode, gradients, dash/caps, layout grids,
constraints, text truncation), Phase 3 accessibility 2.0 (non-text contrast, alt/heading/form
checks, ignore-with-reason, exportable report), Phase 5 handoff report and history, native
target compile checks, browser-level UI tests, and the fixture catalogue in §8
(`unicode-hostile`, `grid-layout`, `variant-matrix`, `variables-heavy`, …).

*The backlog above is unchanged and still describes the remaining work; this appendix only
records what has already been built and verified.*
