<p align="center"><img src="docs/brand/cover-1920x1080.png" alt="DevReady: a free Figma plugin for design handoff, gated on Ready for dev" width="100%"></p>

<h1 align="center">DevReady</h1>

<p align="center"><b>A free, open-source Figma plugin for design handoff.</b><br>
Inspect specs like Dev Mode, generate real code in 12 targets, see what changed — for designs your team has marked <i>Ready for dev</i>.</p>

<p align="center">
  <a href=".github/workflows/ci.yml"><img src="https://github.com/Ankushui18/Dev-Ready/actions/workflows/ci.yml/badge.svg" alt="Tests"></a>
  <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT">
  <img src="https://img.shields.io/badge/Figma-Design%20%2B%20Dev%20Mode-0d99ff" alt="Figma Design + Dev Mode">
  <img src="https://img.shields.io/badge/tests-192%20passing-brightgreen" alt="192 checks passing">
</p>

---

## Start here

DevReady is a **Figma plugin**, not a website. Pick the path that matches you:

| I want to… | Go to |
|---|---|
| **Try it** on a design (2 minutes) | [Install](#install-2-minutes) |
| **Understand what it does** before installing | [What you get](#what-you-get) · [How the gate works](#how-the-gate-works) |
| **Use it as a developer** in Dev Mode | [Developer workflow](#developer-workflow-in-dev-mode) |
| **Understand or change the code** | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — map of `code.js` and `ui.html` |
| **Run the tests / contribute** | [CONTRIBUTING.md](CONTRIBUTING.md) · [Quality](#quality) |
| **See what's missing** (honest list) | [Known limits](#known-limits) |
| **Plan the next release** | [docs/IMPROVEMENTS.md](docs/IMPROVEMENTS.md) — findings, features, edge cases, test plan |
| **Publish it to Figma Community** | [docs/LAUNCH.md](docs/LAUNCH.md) |
| **Fix the repo if files were uploaded to the wrong place** | [docs/GITHUB_SETUP.md](docs/GITHUB_SETUP.md) |

> **Status: v1.5.1, local development plugin.** It is not on Figma Community yet, so you install it from this repo (below). Everything runs inside Figma — no account, no server, no tracking.

---

## What is this, in one paragraph

Figma's **Dev Mode** shows developers the specs of a design: sizes, spacing, colours, type, assets, and code. It is a paid, seat-based feature. DevReady gives you a **Dev Mode-style Inspect panel for free**, and adds the part Dev Mode does not have: a **gate**. Designers mark a frame *Ready for dev*; only then do specs, code and assets unlock for developers. If your team does not want the gate, switch it off in one click and it is simply a free inspector and code generator.

**Who it is for:** designers handing work to engineers, engineers who need measurements and code without a paid Figma seat, and teams who want a clear "this design is ready" signal instead of a Slack message.

---

## What you get

| | |
|---|---|
| **Inspect** | Box model, layout and Auto Layout, typography, fills/strokes/effects, variables with **every mode**, component properties and overrides, dev resources, interactions. |
| **Code (12 targets)** | **React + TypeScript**, React + TypeScript + Tailwind, React + Tailwind, React + CSS, HTML + CSS, single-file HTML, Vue, Svelte, React Native, SwiftUI, Jetpack Compose, Flutter. Semantic tags, BEM classes, design tokens, real components for repeated instances — with **typed props** and ambient asset declarations in the TypeScript targets — and a project ZIP with `fonts/` + `assets/`. |
| **Preview & compare** | Renders the generated HTML next to, or on top of, the Figma design. Difference blend mode makes mismatches visible. |
| **Change tracking** | Lists layers that changed since handoff — size/position, style, text, name, added and removed — with **before → after** values. |
| **Accessibility** | WCAG 2.2 contrast for every text layer, touch-target sizes, unlabelled icon buttons, text under 12px. Click a row to select the layer. |
| **Design tokens** | Export this layer or the whole file as CSS variables, SCSS, JSON (design-tokens format) or a Tailwind v4 `@theme`, with every variable mode. |
| **Annotations** | Figma-native annotations with categories and pinned properties, plus a canvas-note fallback that works on every plan. |
| **Assets & export** | Icons and images found automatically. PNG/JPG/SVG/PDF at 0.5–4x, or everything as one ZIP. |
| **Free-plan friendly** | Where Figma's native *Ready for dev* status isn't available (free plans, Dev Mode), DevReady uses its own flag and always labels which one it used. |

<p align="center">
  <img src="docs/screenshots/inspect.png" width="30%" alt="Inspect panel with status, overrides, dev resources and changes">
  <img src="docs/screenshots/layer-properties.png" width="30%" alt="Box model diagram with design token chips">
  <img src="docs/screenshots/code-react.png" width="30%" alt="Generated React + Tailwind component">
</p>
<p align="center"><sub>Inspect · Box model & tokens · Generated React + Tailwind</sub></p>

<p align="center">
  <img src="docs/screenshots/preview-compare.png" width="30%" alt="Live HTML preview compared with the Figma design">
  <img src="docs/screenshots/changes.png" width="30%" alt="Changes since ready with before/after values">
  <img src="docs/screenshots/inspect-dark.png" width="30%" alt="Inspect panel in dark mode">
</p>
<p align="center"><sub>Preview vs design · Changes since handoff · Dark mode</sub></p>

---

## Install (2 minutes)

**You need:** the Figma **desktop app** (plugins can't be imported into the browser version) and this repository on disk.

1. **Get the files.** `git clone https://github.com/Ankushui18/Dev-Ready.git`, or on GitHub use **Code → Download ZIP** and unzip it.
2. **Import the plugin.** In Figma: **Plugins → Development → Import plugin from manifest…** → choose `devready-plugin/manifest.json` (the one *inside* the `devready-plugin/` folder).
3. **Run it.** Open any file → **Plugins → Development → DevReady Inspect**.

Where to find it afterwards:

- **Design mode:** **Plugins → Development → DevReady Inspect**.
- **Dev Mode** (press <kbd>Shift</kbd>+<kbd>D</kbd>): **Inspect → Plugins → DevReady Inspect**, or in **Inspect → Code** pick a language named **"DevReady · React + Tailwind"**, and so on.
- **Figma for VS Code:** the DevReady codegen languages appear in the code panel.

**No Figma file handy?** Open `devready-plugin/ui.html` in any browser. The panel runs on sample data — the fastest way to see the UI (and to work on it).

**First run shows a lock.** That is the gate working. Select a frame → **Mark as ready for dev** (or **Inspect anyway** if you just want to look around).

---

## How the gate works

The plugin walks up from the selected layer and unlocks at the first ancestor that has a status:

1. **Figma status** — native `READY_FOR_DEV` or `COMPLETED`, set with Figma's own *Mark ready for dev*.
2. **DevReady flag** — shared plugin data, used where native status can't be set (free/Starter plan, or Dev Mode, where plugins are read-only).

The panel always tells you **which source** the status came from, and the flag never overwrites a native status. Families of behaviour:

- **Gate off** (⚙ Settings, or *Inspect anyway*) → it behaves like a plain inspector and code generator.
- **Mark as reviewed** → saves a fresh change-tracking snapshot.
- **Start tracking** → for designs handed off before you installed the plugin.

---

## Developer workflow in Dev Mode

1. Press <kbd>Shift</kbd>+<kbd>D</kbd> to enter Dev Mode.
2. **Inspect → Plugins → DevReady Inspect** — the full inspector inside Figma's own panel (drag the panel edge to widen it).
3. **Inspect → Code** — choose **DevReady · React + Tailwind** (or any other target). Code appears in Figma's native Code section, no plugin window.
4. Copy, or download a **project ZIP** with the code files, `assets/` and any uploaded `fonts/`.

Tip: **Code → Preview → Overlay → Difference** is the fastest way to see whether the generated HTML actually matches the design.

---

## Privacy, in one line

**The plugin code makes no network requests at all.** Fonts are classified using a catalog of **1,950 Google Fonts bundled in the plugin**, so a private or brand font name is never sent anywhere. The only traffic is the *preview iframe* loading public Google Fonts so text renders in the design's typeface — and you can switch that off in **⋯ → Load Google Fonts in preview**.

Details, and everything the plugin stores in your Figma file: **[PRIVACY.md](PRIVACY.md)**. Automated tests check these claims on every commit.

---

## Repository map

```
Dev-Ready/
├── README.md                  ← you are here: what it is, install, map
├── devready-plugin/           ← ONLY what Figma loads. Import manifest.json from here.
│   ├── manifest.json          editor types, capabilities, 10 codegen languages
│   ├── code.js                plugin sandbox: gate, spec extraction, code generation
│   ├── ui.html                the panel (also opens in a browser on sample data)
│   ├── README.md              full feature documentation & behaviour details
│   └── check-sandbox.js       checks code.js against Figma's SES restrictions
├── docs/
│   ├── ARCHITECTURE.md        how the code is organised, message protocol, where to change things
│   ├── FAQ.md                 free plan, Dev Mode, fonts, exports, common confusions
│   ├── LAUNCH.md              Figma Community checklist + manual test matrix
│   ├── GITHUB_SETUP.md        repo settings, upload mistakes, releases
│   ├── NAMING.md              name options and what to rename if you pick one
│   ├── IMPROVEMENTS.md        review: findings, feature roadmap, edge cases, test plan
│   ├── test-report.md         latest test results
│   ├── screenshots/           images used above
│   └── brand/                 icon, cover, social preview
├── tests/                     fixtures × 12 targets, privacy, change tracking, browser sandbox
├── scripts/                   layout check, lint, ZIP builder
├── .github/workflows/ci.yml   what runs on every push and tag
├── CHANGELOG.md               what changed in each version
├── CONTRIBUTING.md            how to build, test and add a fixture
├── PRIVACY.md · SECURITY.md · LICENSE (MIT)
```

**Rule of thumb:** `devready-plugin/` holds only the four files Figma loads plus its own README. Everything else lives at the root. `npm run check:layout` enforces this, because a mis-placed upload is the most common way this repo breaks.

---

## Quality

```bash
npm ci
npm run verify        # layout + Figma sandbox check + ESLint + tests (what CI runs)
npm test              # 192 checks: 9 fixtures × 12 targets, privacy, messages, tracking,
                      # tsc, golden output, and a real bundle of the generated React project
npm test -- --update-golden   # accept a deliberate change to generated output
npm run lint          # ESLint, including the script inside ui.html
npm run test:browser  # Chromium: renders the panel, attacks the preview sandbox (needs Python Playwright)
```

Every push runs [CI](.github/workflows/ci.yml):

- Generated code parses: JSX/CSS with **esbuild**; HTML, Swift, Kotlin, Dart and Vue/Svelte templates with structural checks.
- **TypeScript output is compiled by `tsc` in strict mode**, so the generated props types and asset declarations actually type-check.
- **The generated React project is bundled with esbuild**, so every import it emits (`./Component.css`, `./assets/icon.svg`) has to resolve — a parse-only check would miss that.
- **Golden files** pin the output of four fixture × target pairs, so any drift shows up as a one-line diff (`Dashboard.tsx:20  - <h2>Weekly insightZ</h2>  + …`).
- **The published counts can't drift:** a check compares the README badge and `docs/test-report.md` against the number of checks the suite actually ran.
- **Hostile layer names** can't inject markup or break string literals, and design text can't reach `{{ }}`, `{ }` or `$` interpolation.
- **Every UI → plugin message** is validated against a schema (15 attack cases), and crafted component mappings can't inject code.
- **Privacy:** no network APIs in `code.js`, private font names never appear in a Google URL, and only Google Fonts are allowed by the manifest.
- **Change tracking** stays under Figma's 100 kB plugin-data limit, and before → after values are correct.
- **The preview iframe is sandboxed** — a hostile document can't run scripts, reach other hosts or touch the panel (checked in a real browser).
- **Repository layout** is correct, so a mis-placed upload fails the build.

Latest results: [docs/test-report.md](docs/test-report.md).

---

## Known limits

Honest list — these are APIs Figma doesn't give plugins, not things we haven't tried.

- **This is not Dev Mode.** Hover-to-measure on canvas, version comparison, change notifications and VS Code's built-in Figma integration are Figma features; plugins can't reproduce them.
- **Code** stops after a layer budget: 600 in the panel, 1,500 for project downloads, 150 in Dev Mode's Code section (Figma gives codegen a 3-second budget). The output says when it truncated; pick a smaller frame for the full tree.
- **Change tracking** shows before → after for position, size, fills, strokes, radius, effects, layout/padding, font and text (first 80 characters). Gradients stops and individual effect parameters are flagged by category only. It covers the first 2,500 layers of a frame.
- **SwiftUI, Compose, Flutter and React Native output** is checked for structure and safe escaping, but not compiled in CI. JSX and CSS are parsed by esbuild. Native text with Figma Auto line-height uses the platform font engine's metrics; SVG baseline measurements are applied only to web CSS, where they have a direct meaning.
- **Native annotations and native *Ready for dev*** depend on your Figma plan and seat; DevReady falls back to canvas notes and its own flag, and the UI says which one is in use.
- **Partially tested on a real Figma file** (20 Oct 2026, Design mode, dark theme): the panel, the gate and its status source, inspect data, variables, assets, and full-tree HTML + CSS on a 214-layer frame all worked. **Dev Mode (Inspect → Plugins, the Code section) and Figma for VS Code have not been run yet**, and neither has the light theme. [docs/LAUNCH.md](docs/LAUNCH.md#3-environment-test-matrix) has the row-by-row result and the screenshots, including the rows that failed.

---

## The name

`Dev-Ready` describes the gate, but new visitors often read it as "a repo that is ready for dev" rather than a Figma plugin. **DevReady Inspect** is what the plugin is actually called in Figma. If you want a clearer project name, [docs/NAMING.md](docs/NAMING.md) lists options with the trade-offs and a rename checklist.

---

## License

[MIT](LICENSE) — free for personal and commercial use. Issues and ideas: [CONTRIBUTING.md](CONTRIBUTING.md).
