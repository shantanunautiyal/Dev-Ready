# Changelog

All notable changes to DevReady are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/), and versions follow [SemVer](https://semver.org/).

## [Unreleased]

### Fixed
- **Design text stays text.** Export settings on a `TEXT` layer no longer turn copy into an image, zero-opacity layers are omitted, and single-line auto-sized text uses its exact line box instead of the browser-dependent `normal` line-height.
- **Raster artwork is no longer mistaken for a vector icon.** Image-filled rectangles, ellipses and nested avatar stacks stay raster assets, including image content nested in boolean operations.
- **Container image fills are real assets.** Multi-file web targets emit files and matching CSS URLs; single-file HTML embeds the original bytes. React Tailwind URLs are valid JSX, multiple image fills retain their own assets, and native targets render a supported single image fill instead of ignoring it. Unresolved Figma `url(<path-to-image>)` placeholders are rejected instead of leaking into output.
- **Standalone HTML starts at the page edge.** The `html, body` reset is included only for standalone HTML + CSS, not in reusable component stylesheets.
- **Project downloads are all-or-nothing.** Original image bytes keep their real JPEG/GIF/WebP/PNG extension, and any failed asset export stops the download with a visible error rather than producing an incomplete ZIP. Export all follows the visible Assets list and excludes the selected root.
- **Code responses cannot overwrite a newer selection.** Requests carry selection identity, and the UI accepts only the exact pending response.
- **Mixed absolute and auto-layout siblings keep Figma's paint order.** Bottom bars remain above earlier overlapping rows, including reversed auto-layout stacking.
- **Wrapped Auto text has deterministic web line-height.** Compatible uniform text uses Figma's SVG baseline spacing; native targets keep their platform font metrics rather than receiving an inferred cross-platform line box.

- **Design tokens survive real design systems.** An alias is followed through its whole
  chain, so `--color-text: var(--core-ink)` no longer points at a variable that is hidden
  or belongs to another file; when no target is exported the literal value is written
  instead of `var(--undefined)`. Published **library** variables are part of the export,
  unreadable values are kept and flagged (`$value: null` in DTCG, "could not be resolved"
  in the header) and a cyclic alias terminates instead of writing `undefined`.
- **A failed Figma read is no longer silent.** Calls whose errors were swallowed by empty
  `catch` blocks — local variables, library collections, variable modes, font availability,
  component mappings — leave a bounded, de-duplicated note that the panel shows as
  “Limited data”, and that travels with the token export that triggered it.
- **Snapshots have a byte budget, not only a layer cap.** 2,500 text-heavy layers serialise
  to about a megabyte of shared plugin data; the snapshot now stops at 400,000 characters
  and marks itself partial, so the Changes panel never claims “no changes” for layers it
  did not read.
- **A rejected commit always answers.** GitHub messages are shape-validated at the
  message boundary and fully validated inside the adapter, so an unsafe path, a bad
  repo name, a bad branch or an empty file list comes back as a named error instead of
  being dropped — which used to leave the panel on “Pushing…” forever.
- **Projects are named in the panel.** Creating or renaming a project used
  `window.prompt()`, which Figma's plugin iframe blocks — the flow either threw or silently
  produced “Untitled project”. It is now an inline form with a live field, unique-name
  handling and an explicit Save/Create; a blank rename is refused instead of erasing the
  name.
- **The GitHub tab no longer re-requests status on every render.** One request is made
  when the tab is first opened, and the reply clears the pending flag.
- **Asset and design-file thumbnails are requested, not assumed.** The panel asks only
  for the thumbnails it is about to show (8 asset rows, 12 file rows), scaled to 160 px.
- **Static HTML announces the design's language.** `lang` and `dir="rtl"` are derived from
  the actual text (Arabic, Hebrew, Devanagari, Thai, Japanese, Korean, Chinese, Cyrillic),
  instead of hard-coding `lang="en"` on every export.

### Added

- **A tabbed workspace, without changing the inspector.** The panel gains Overview,
  Design Files, Code, Assets, History, GitHub and Settings tabs around the existing
  Design tab, which is untouched. Tabs are a real `role="tablist"` with roving
  `tabindex`, arrow/Home/End keys, `aria-selected` and `aria-controls`; the open
  section, scroll position and selections survive a switch.
- **Projects hold several design files.** Create, rename, duplicate, archive and
  delete projects; search them, sort by recent/name/created, and filter archived ones.
  Each project owns its own entries, statuses, outputs and revisions, so switching
  projects cannot mix assets or code. Importing the same layer twice is refused with
  an explanation, and archiving follows the filter instead of hiding the project.
- **A processing queue with per-file status.** *Generate all* runs the entries of a
  project one at a time with a progress meter; every entry keeps `idle` / `running` /
  `ok` / `error` plus its own error text, file count and timestamp. *Retry N failed*
  re-runs only the failures, *Cancel* stops the queue at the next layer boundary, and
  a second run for a file already running is refused. Progress is persisted, so
  closing the panel does not lose it.
- **A Code tab for the last run.** Files, sizes, per-file download, ZIP download,
  truncation and asset-export warnings, the linked revision id, and shortcuts to
  history and publishing.
- **Job cancellation end to end.** `gen-code` accepts a `jobId`, `cancel` marks it,
  the engine checks between layers, and a cancelled run answers immediately with
  `cancelled: true` and no files — the panel never sits on “Building…”.
- **Cost estimation before a run.** `assessComplexity()` reports layers, depth, text,
  vectors, instances, images and a millisecond estimate, bounded at 6,000 layers with
  warnings for the generation cap, deep nesting and expensive image fills. It travels
  with the inspect state, and a `plan` message answers for the whole selection.
- **Vector illustrations export as one SVG.** A self-contained artwork frame (named
  like art, carrying an SVG export setting, or dense enough to be art rather than UI)
  becomes a single sanitised SVG asset with its `viewBox`, gradients, masks and clip
  paths intact, referenced like any other image with real `alt` text; its inner paths
  are never emitted as elements. Frames with text, instances or raster content are
  never treated as artwork, and `svgFrames: 'named' | 'off'` narrows or disables the
  heuristic. A failed export degrades to normal element output with a note.
- **Optional GitHub publishing.** Connect with a fine-grained token, list repositories
  and branches, preview added / modified / deleted / unchanged files with per-file
  selection, commit a message, and push. Every failure has its own code and sentence:
  `auth`, `permission`, `rate-limit` (with the reset time), `conflict`, `network`,
  `not-found`, plus local validation for paths, repo names, branches, empty selections
  and size. Nothing is written before the preview is confirmed, a stale base commit is
  detected before any blob is created, the ref update is never forced, reads retry once
  on 5xx and writes never retry. The token lives in `clientStorage`, is used only in
  the plugin thread, is scrubbed from every reply and is deleted on Disconnect.
- **Local revisions with compare and restore.** Every successful run is recorded with
  its files, sizes, hashes and code (when it fits), linked to the design layer that
  produced it. History compares two revisions per file (added / removed / changed /
  unchanged) with a line diff, and restores with a confirmation.
- **An assets gallery.** Search by name, filter by type, 8 rows by default with
  *Show all N* / *Show less*, thumbnails requested only for visible rows, per-asset
  export, ZIP export and an explanation of what an illustration asset is.
- **`docs/PUBLISHING.md`** — the complete contract for GitHub: why a token instead of
  OAuth, required permissions, the API calls per action, limits, the error table,
  conflict semantics and path validation. `PRIVACY.md` and `manifest.json` now describe
  both network paths.
- A second hardening suite: 34 regressions for token aliases and libraries, degraded-read
  diagnostics, the snapshot budget, document language/direction and parser-level SVG
  evasion, plus direct unit tests for the panel's helpers and its ZIP writer.
- A third suite, `tests/platform.js`: 21 checks covering illustration detection and
  its negative cases, end-to-end SVG assets, complexity caps, cancellation, the GitHub
  adapter (connect, reject, rate limit, permission, 404, network, retry policy, commit
  sequence, stale base, rejected ref, six unsafe inputs), local storage bounds, the
  tabbed panel, the file queue and project management (**213 checks total**).

## [1.5.1] — 2026-10-20

No product change. The Dev Mode surface is the one part of the launch matrix that has
never been run, so its read-only contract is now a test instead of a promise.

### Added
- **A test that runs the plugin in Dev Mode → Plugins with every document-writing API
  trapped** (`figma.createFrame`, `createText`, `createLine`, layer deletion, … all
  throw, as they do in Figma). It drives the messages that touch the canvas — redlines,
  native measurements, note clearing, clearing redlines, marking ready, resize — and
  asserts that the document is never written to and no unexpected error toast appears.
  - Plugin data, relaunch data and `page.addMeasurement` are Figma's documented
    exceptions, so "mark ready" and Dev Mode measurements are required to still work.
  - Redlines are refused in Dev Mode with an explanation instead of a silent no-op; the
    test pins that message too.
  - Verified by mutation: removing the `IS_DEV` guard on note clearing fails with
    `Dev Mode reached for the canvas: remove(Canvas note)`.
- `tests/harness.js`: `loadEngine()` can now start in **inspect** mode (`mode: 'inspect'`,
  `editorType: 'dev'`, `readOnly: true`), with the read-only traps above, a page mock, a
  notification log, a record of any write that slipped through, and `send(msg)` to
  deliver UI messages.

## [1.5.0] — 2026-10-20

First run on a real Figma file, and the two things that run exposed.

### Added
- **Environment test matrix filled in** (`docs/LAUNCH.md`), row by row, from a real
  session on 20 October 2026: Design mode, Figma's default Inspect width, dark theme,
  a 393×852 "home" frame with 292 layers beneath it. Screenshots are in
  `docs/screenshots/real-file/`.
  - Verified: the panel renders, a native *Ready for dev* frame is labelled
    **Figma status**, dimensions/box model/background/variables/layers/assets populate
    from the file, full-tree HTML + CSS on a **214-layer** frame (50 tokens, 19 assets,
    no truncation), and the accessibility audit reports real findings on real content.
  - **Not yet run:** Dev Mode → Plugins, Dev Mode → Code section, Figma for VS Code,
    annotations, exports (opened), the preview overlay, remote libraries, light theme.
    The README says so instead of implying full coverage.

### Fixed
- **The Accessibility section produced one row per layer.** On a design with repeated
  content — a carousel, a list of identical cards — that meant ~40 near-identical rows
  that pushed Variables and Assets below the fold. Identical findings are now grouped:
  `40 layers · #6B7280 on #09090B · 4.12:1 needs 4.5`, with a count, the real layer ids
  behind it, and click-to-select. Different problems stay separate, and passing rows
  never merge with failing ones.
- **The list is capped** at 25 groups with *Show N more*, so a frame with thousands of
  text layers cannot make the panel slow to render.

## [1.4.0] — 2026-10-20

Follow-up to a second audit. Two of its findings were real; one was a stale read.

### Added
- **Clearing a snapshot is now a first-class action.** Until now the only way to delete a change-tracking snapshot was to unset the frame's dev status. **Changes → Clear** removes every chunk, the chunk count and the timestamp, and a test asserts nothing is left behind.
- **The panel says where a snapshot lives.** Next to Changes: stored **in this Figma file**, readable by anyone with edit access and by other plugins, with what it contains (layer ids, 40 characters of layer names, colours, sizes, 80 characters of text — no images).
- **Golden-output tests** (`tests/golden/`, 4 fixture × target pairs): any change in generated code fails with the first changed line, e.g. `Dashboard.tsx:20  - <h2>Weekly insightZ</h2>  + <h2>Weekly insights</h2>`. Update deliberately with `npm test -- --update-golden`.
- **Generated-project build test:** the React targets are bundled with esbuild from the emitted files, so a missing `./Component.css`, `./tokens.css` or `./assets/icon.svg` fails the suite. Parse-only checks could not catch this.
- **Documentation-consistency check:** the README badge and `docs/test-report.md` are compared against the number of checks the suite actually ran, so a stale count fails CI.

### Fixed
- **A test report one release behind.** The second audit reported `docs/test-report.md` saying 110/110 while the README said 133. At the reviewed commit both said 133 (the report was regenerated in 1.3.0); the audit had read a cached page from before that merge. The underlying risk was real — nothing kept the two in step — so the new consistency check now fails the build instead of relying on memory.
- **141 checks** (was 133: 8 new).

### Not addressed here
- **Native compilation** (SwiftUI, Compose, Flutter, React Native) still is not compiled in CI. It needs Xcode on a macOS runner and Android/Flutter toolchains; that is a separate, slow job rather than something to bolt onto this suite. The README continues to say these are structurally checked only.
- **Real Figma testing** (Design Mode, Dev Mode, Inspect → Code, Figma for VS Code) cannot be done from CI or from a repository sandbox. [docs/LAUNCH.md](docs/LAUNCH.md#3-environment-test-matrix) tracks it, and it stays the main release blocker.

## [1.3.0] — 2026-10-20

A new code target, plus the repository repair and documentation work from the merged
layout fix.

### Added
- **React + TypeScript targets** (`react-ts`, `react-tailwind-ts`, in the panel, the Dev Mode Code section and Figma for VS Code):
  - files are `.tsx`, and every extracted component gets a `Props` type, e.g. `type StatCardProps = { label: string; value: string }` with `function StatCard({ label, value }: StatCardProps)`;
  - an `assets.d.ts` is emitted with ambient declarations for the CSS and asset (`*.svg`, `*.png`, …) imports the design needs, so the output type-checks in a strict project;
  - the JavaScript targets are unchanged, and a test fails if types leak into them.
- **CI compiles the generated TypeScript with `tsc --strict`**, so "type-checked output" is verified rather than claimed (`typescript` is a dev dependency only).
- 23 new checks (**133 total**): the two targets across all 9 fixtures, plus typed-props, ambient-declaration, `tsc` and no-types-in-JS checks.

### Fixed
- **Repository layout restored.** All root files had been uploaded *inside* `devready-plugin/`, including a second, older copy of the plugin in `devready-plugin/devready-plugin/`. The result: GitHub showed no README or license, CI never ran, `npm test` could not work from a fresh clone, and Figma imported the older plugin. Root files are back at the root; `devready-plugin/` now contains only `manifest.json`, `code.js`, `ui.html`, `README.md` and `check-sandbox.js`.
- **CI restored** (`.github/workflows/ci.yml`): layout check, Figma sandbox check, ESLint, the 133-check suite, the Playwright browser job, and a release job that attaches `devready-plugin.zip` to a tag.
- Added the missing `.gitignore`.

### Added
- **`docs/ARCHITECTURE.md`**: where every section of `code.js` and `ui.html` lives, the selection → `state` data flow, the UI ↔ plugin message protocol, storage keys, and where to change what.
- **`docs/FAQ.md`**: free plans, the gate, Dev Mode, fonts, generated-code mismatches, tokens, privacy.
- **`docs/NAMING.md`**: name options with trade-offs, a recommendation, and a complete rename checklist.
- **`.github/ISSUE_TEMPLATE/`** (bug report asking for surface + code target, feature request) and a pull-request checklist.
- Root `README.md` rewritten as a landing page: what it is, 2-minute install, repository map, docs index, developer workflow.

### Changed
- `docs/GITHUB_SETUP.md` now describes the correct layout and how to recover if it breaks again, instead of the old "current state is broken" instructions.
- Refreshed `docs/test-report.md`: **133/133 checks**, 9 fixtures × 12 code targets.
- `SECURITY.md`: a "verify these claims yourself" section with the exact commands, and a note that reviews of the pre-1.2 tree (or of the stale duplicate plugin folder) describe protections that already exist.
- Plugin README: complete target list in Dev Mode, catalog size (1,950 families), test counts, and links to the architecture doc.

## [1.2.0] — 2026-10-20

Closes more of the gap with Figma Dev Mode.

### Added
- **4 new code targets** (Dev Mode Code section and panel): **Vue** single-file component, **Svelte**, **React Native** (`StyleSheet`, props components, SVG via react-native-svg) and **Flutter** (Dart widgets, `AppColors` tokens, light/dark values). Design text can never reach `{{ }}` (Vue) or `{ }` (Svelte) expressions, or Dart `$` interpolation.
- **Accessibility section** in Inspect: WCAG contrast for every text layer (finds the real background from covering layers, handles opacity, large-text rules, flags gradients as unmeasured), touch-target size (24px fail, 44px mobile warning), icon-only controls without a label, text under 12px. Click a row to select the layer.
- **Design tokens export** (This layer / Whole file) as CSS variables, SCSS, JSON in the design-tokens format, or a Tailwind v4 `@theme`. Includes every variable mode, `{alias}` references, color and text styles, rem option, copy and download. Variable names are sanitised, so hostile names stay inert.
- 45 new checks (110 total), including template-injection guards for the new targets.

### Changed
- **Single HTML is readable now.** SVG icons are inline `<svg>` elements (no base64 in `src`), and raster images are CSS backgrounds whose data URI sits once in a labelled `:root` block at the end of the stylesheet, so the HTML and component CSS stay clean.
- Manifest lists the new languages; `gen-code` and `tokens-export` messages are validated.

## [1.1.0] — 2026-10-20

Trust and security release, following an external benchmark against Figma Dev Mode.

### Security
- **Fixed: code injection through component mappings.** Mappings are stored in the Figma file. A crafted import path such as `./x';alert(1);//` was written into generated React code unescaped. Paths are now validated on save and when read from the file, and are emitted through a string-escaping helper.
- **Every UI → plugin message is validated** against a per-type schema:
  - unknown types are ignored and unknown fields dropped;
  - strings are capped and node ids checked;
  - enums and ranges are enforced (export format/scale, font upload size/type, http(s)-only links, whitelisted settings);
  - invalid input shows an error toast instead of reaching the Figma API.
- **Sandboxed preview:** the HTML preview iframe is `sandbox="allow-same-origin"` with no scripts, `referrerpolicy="no-referrer"`, plus a Content-Security-Policy. It allows no requests except Google Fonts, and none at all when preview fonts are off.

### Privacy
- **The plugin code makes no network requests.** Google Fonts detection uses a bundled catalog of ≈1,950 families, with weights, italics and variable ranges, instead of live lookups. Private, commercial and system font names can never be sent.
- New setting **⋯ → Load Google Fonts in preview** (on by default). Off = zero network traffic.
- Removed the on-device font-lookup cache (no longer needed).
- The manifest's network reasoning now describes exactly what is requested.

### Added
- **Before → after values in change tracking:** position, size, fill, stroke, radius, effects, layout/padding, font and text (first 80 characters). Includes colour swatches. Snapshots from 1.0 still work and show categories until **Mark as reviewed**.
- Variable Google Fonts weights (e.g. Space Grotesk 450) are linked exactly. Missing weights fall back to the nearest available one.
- **ESLint 10** (`npm run lint`), including the script inside `ui.html`. Fixed what it found: 4 unused functions, unbraced multi-line `if`s.
- **Browser tests** (`npm run test:browser`, Playwright): renders the panel in light/dark, and attacks the preview with a hostile document. A mutation run with the sandbox removed confirms the test catches it.
- **Repository layout check** (`npm run check:layout`, also part of `npm test`), so a mis-placed upload fails CI.
- `npm run verify` runs layout, sandbox, lint and tests. CI now runs lint and the browser tests, and the release job waits for both.
- New tests: zero network requests, bundled font catalog, 15 message-validation cases, mapping injection, before → after values. **65/65 checks.**

### Fixed
- The test runner now exits non-zero if it crashes, not only when a check fails.

## [1.0.0] — 2026-10-20

First public release.

### Added
- **Ready-for-dev gate.** Uses Figma's native status, or a DevReady flag where native status isn't available. Every status is labelled **Figma status** or **DevReady flag**. The gate is optional and can be turned off per user.
- **Dev Mode-style Inspect panel:**
  - header with the status and a change count;
  - overrides with "Compare with main component";
  - dev resources (GitHub/Storybook icons) and a Code Connect-style mapping;
  - component info and properties;
  - collapsible sections;
  - box-model diagram with a List/Code toggle and token chips;
  - colors, effects, variables with modes, interactions, layers, assets, export;
  - light and dark themes.
- **Code generation** for React + Tailwind, React + CSS, HTML + CSS, single-file HTML, SwiftUI and Jetpack Compose. Also works as a native Dev Mode codegen plugin.
- **Live preview:** side by side, overlay and difference against the Figma design.
- **Fonts:**
  - Google Fonts detection that links only the weights used;
  - `@font-face` for custom fonts, with optional file upload;
  - fallback stacks for every family.
- **Change tracking** since handoff.
- **Annotations** with categories and pinned properties. They are verified after writing, with a canvas-note fallback on plans without native annotations.
- **Test suite** (`npm test`):
  - 9 fixture designs × 6 targets, with output parsing and escaping checks;
  - change tracking under Figma's 100 kB limit;
  - offline fonts and network privacy.
- **CI workflow**, PRIVACY.md and the launch checklist.

### Fixed (found by the new test suite)
- Change-tracking snapshots of large frames (~1,000+ layers) went over Figma's 100 kB per-entry plugin-data limit, so "Start tracking" failed. Snapshots are now split into chunks. Frames over 2,500 layers are marked *partial* in the panel, instead of looking clean.
- SwiftUI strings with control characters produced `\u0007`, which isn't valid Swift. They now use `\u{7}`.
- Unicode bidi control characters ("Trojan Source") in design text are escaped in SwiftUI and Compose string literals.
- Figma's SES sandbox rejected `code.js` because of `<!--` / `eval(`-like text. Added `check-sandbox.js`.
