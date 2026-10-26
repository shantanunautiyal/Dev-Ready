# DevReady Inspect: a Figma plugin that works like Dev Mode, but only for designs marked "ready for dev"

DevReady Inspect is a Dev-Mode-style inspector for Figma. Specs, code and assets only **unlock when the design is marked Ready for dev or Completed**. Anything else shows a 🔒 screen with a one-click hand-off button.

> **New here?** Start with the [root README](../README.md) for install and a tour.
> Code layout: [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md). Questions:
> [docs/FAQ.md](../docs/FAQ.md). This file is the complete behaviour reference.

## Install (local development)
1. Open the **Figma desktop app**.
2. Go to **Plugins → Development → Import plugin from manifest…**
3. Pick `manifest.json` from this folder.
4. Run it from **Plugins → Development → DevReady Inspect**, in Design mode or in Dev Mode (Inspect panel → Plugins).

You don't need a build step. The plugin is plain `code.js` and `ui.html`.

## Where it runs
| Surface | What you get |
|---|---|
| **Design mode** | The full UI. You can also mark designs ready or completed and draw redlines on the canvas |
| **Dev Mode → Plugins tab** | The full inspector (read-only, which is how Figma runs Dev Mode plugins) |
| **Dev Mode → Code section** | All twelve targets in the language dropdown: **DevReady · React + Tailwind / React + CSS / React + TypeScript / React + TypeScript + Tailwind / HTML + CSS / Single HTML / Vue / Svelte / React Native / SwiftUI / Jetpack Compose / Flutter**, with a rem unit option and a gate preference |
| **VS Code (Figma for VS Code)** | The same as Dev Mode |

## How the "dev ready" gate works
For a selected layer, the plugin walks up its parent layers. The first one with a status unlocks the inspector:
- Figma's **native** `devStatus` (`READY_FOR_DEV` or `COMPLETED`), set from Figma's own "Mark ready for dev"
- or the plugin's **team flag** (shared plugin data). Use it on free plans, where the native status isn't available, or in Dev Mode, where plugins can't change the native status.

You can turn the gate off in ⚙ Settings, or use the "Inspect anyway" button.

## Using it in Dev Mode (developer side)
1. Open the file and press **Shift + D** (or use the `</>` toggle) to switch to **Dev Mode**.
2. **Inspect panel → Plugins → DevReady Inspect** shows the full inspector inside Dev Mode's own panel. Drag the panel edge to make it wider.
3. **Inspect panel → Code → language dropdown** lists all twelve **DevReady ·** targets (React + Tailwind, React + CSS, React + TypeScript, React + TypeScript + Tailwind, HTML + CSS, Single HTML, Vue, Svelte, React Native, SwiftUI, Jetpack Compose, Flutter). These show the generated code directly in Figma's native Code section, with no plugin window.
4. In Design mode the plugin opens as a 480px-wide window. You can resize it from the corner.

## Code engine
Code is built from the whole layer tree, not just the one layer you selected:
- **Semantic BEM class names.** Auto-generated layer names are ignored (`Frame 2121453060` → `insights__header`, `1284` → `insights__value`, `12.4%` → `insights__change`, a pill with a fill → `insights__badge`). Text inside a component gets a role name from the main component, so every instance shares classes.
- **De-duplication.** Layers with identical styles share one class. Repeated component instances become one **React component with props**, e.g. `<StatCard label="Sessions" value="342" />`.
- **TypeScript.** The two `React + TypeScript` targets emit `.tsx` instead of `.jsx`, export a `Props` type for every extracted component, and add an `assets.d.ts` with ambient declarations for the CSS and asset imports the design needs — so the output type-checks in a strict project. CI compiles it with `tsc --strict`.
- **Design tokens.** Figma variables are collected into `:root { --surface: #FFF; … }` and the code uses `var(--surface)`.
- **Clean CSS.** It removes Figma's inline comments and `font-style: normal`, strips flex-only properties when the parent isn't flex, adds `position: relative` when a child is absolutely positioned, sets the most common font family once on the root, and adds a scoped reset (Figma has no default margins).
- **Semantics.** Lists become `ul`/`li`, buttons become `<button type="button">`, and only one real title becomes a heading (`h1` for page-sized frames, otherwise `h2`). Numbers never become headings.
- **Assets.** Icons and images become `<img>` tags pointing to exported files. Rotation is baked into the exported file, so there's no `rotate()` in the CSS. Decorative icons get `alt="" aria-hidden="true"`, and React code imports them (`import userCircleIcon from './assets/user-circle.svg'`).
- **Free-positioned layouts.** Layers inside regular (non-auto-layout) frames and groups are positioned with `position: absolute; left; top`, measured from the layer's real position (group children are measured from the group). Those frames get `position: relative` and their size, and frames that clip their content get `overflow: hidden`.
- **Fonts, handled automatically (web outputs).** Every font family and weight the design uses is detected, and each family is handled one of three ways:
  - **On Google Fonts** (recognised using a catalog of 1,950 families bundled in the plugin, so nothing is looked up online; includes variable-weight ranges, e.g. Space Grotesk 450): linked automatically with only the weights/italics the design uses. A weight the family doesn't have falls back to the nearest one. HTML gets `<link>` tags; React gets an `@import` in `Component.css` / `tokens.css`.
  - **Not on Google Fonts** (Gilroy, brand fonts…): an `@font-face` rule per style with `src: local(...)`, so the copy installed on the device is used. Click **Code → Fonts → Add font files** and pick the `.woff2/.woff/.ttf/.otf` files. They're matched to styles by file name (Bold, SemiBold, MediumItalic, 700…) and then:
    - **Single HTML:** embedded as data URIs.
    - **Project ZIPs:** bundled in `fonts/`.
    Uploaded files are remembered per font family (max 2.5 MB each; `.woff2` is the smallest).
  - **System fonts** (SF Pro, New York, SF Mono, Helvetica, Segoe UI…): nothing is loaded.
  - Every `font-family` gets a fallback stack (sans, serif or mono), so text never falls back to Times.
  - Auto-width text gets `white-space: nowrap`, so it doesn't wrap where Figma doesn't.
  - Wrapped Auto text in web targets uses Figma's measured SVG baseline spacing when the paragraph has uniform line boxes. Mixed metrics and uneven paragraph spacing are left at `normal` with a warning instead of being guessed.
  - Auto layout children get their Fixed / Fill / Hug sizing from the layer itself (`width`, `flex: 1 0 0` or `align-self: stretch`, `flex-shrink: 0`).
  - SwiftUI uses `ZStack` + `.offset` and Compose uses `Box` + `Modifier.offset` for the same layouts.
- **Mixed text styles** become `<span>`s with their own classes.
- **Project export.** **Download project** builds a ZIP with the code files and every referenced asset (SVG, or PNG @2x):
  - `HTML + CSS` → `index.html` (with the Google Fonts link) + `styles.css` + `assets/`
  - `React + Tailwind` → `Component.jsx` + `tokens.css` + `assets/`
  - `React + CSS` → `Component.jsx` + `Component.css` + `assets/`
  - `Single HTML` → **one `.html` file** with the CSS inlined and every asset embedded (see below)
  - `SwiftUI` → `Component.swift` + `assets/`
  - `Jetpack Compose` → `Component.kt` + `assets/`
  - `Vue` → `Component.vue` (template + style) + `assets/`
  - `Svelte` → `Component.svelte` + `assets/`
  - `React Native` → `Component.jsx` (StyleSheet) + `assets/`
  - `Flutter` → `component.dart` + `assets/`
- **Variable modes → themes.** Each variable's value is resolved for every mode of its collection, following aliases. The default mode goes in `:root`. Other modes become override blocks: `[data-theme="dark"] { --surface: #121726; }` for Light/Dark collections, otherwise `[data-<collection>="<mode>"]`, e.g. `[data-density="compact"]`.
- **SwiftUI and Jetpack Compose.** These come from the same layer tree as the web code:
  - Auto layout becomes `VStack`/`HStack`/`ZStack` in SwiftUI and `Column`/`Row`/`Box` in Compose.
  - Gaps and space-between alignment become `spacing:` + `Spacer()` in SwiftUI and `Arrangement.spacedBy`/`SpaceBetween` in Compose.
  - Padding, frame, background, corner radius, border, shadow and opacity become modifiers in the correct order.
  - Text gets font, weight, color, explicit line height and tracking. When Figma reports Auto line-height, native targets keep the platform font engine's metrics rather than treating SVG web baselines as a native line box. Text with mixed styles becomes `Text + Text` in SwiftUI and `buildAnnotatedString` in Compose.
  - Repeated components become a `struct StatCard: View` or a `@Composable fun StatCard(...)` with parameters.
  - Variables become `Color.surface` / `AppColors.Surface`. If a Dark mode exists, SwiftUI gets light/dark-aware colors (`Color(light:dark:)`) and Compose gets a separate `AppColorsDark` object.
- **Code Connect-style mapping.** Select a component instance → **Component → Connect to code** → enter the code component name and import path, e.g. `Button` from `@/components/ui/button`.
  - From then on, every instance of that component in generated React code becomes `<Button variant="primary" size="large" showIcon>View report</Button>`, plus the correct `import`, instead of rebuilt divs.
  - Variant props become string props, boolean props become flags, and a Label/Text prop becomes the children.
  - Mappings are saved in the file, so the whole team gets the same output.

## Single HTML + Preview & Compare
**Single HTML (one file)** gives you HTML, CSS and assets in one self-contained file:
- The CSS goes in a `<style>` block.
- Icons are embedded as SVG data URIs and images as PNG/JPG data URIs. Image fills on containers are embedded too, so no `url(<path-to-image>)` placeholders are left.
- The Google Font is linked.
- Double-click the downloaded file and it opens in any browser, centered on a neutral background. There are no folders to put together.
- Embedding is capped at 8 MB in the panel and 400 KB in Dev Mode's Code section. Anything over the cap stays as an `assets/` reference.

**Code → Preview** renders that file live inside the plugin, so you can check the build against the design without leaving Figma:
- **Preview**: the HTML build at design width, scaled to fit the panel. It grows if the HTML ends up taller than the frame.
- **Side by side**: Figma's own render of the frame on the left, the HTML on the right.
- **Overlay**: Figma's render on top of the HTML, with an opacity slider. Tick **Difference** to switch the blend mode: matching pixels turn black, so anything bright is a spacing, size, font or color mismatch.
- **Download .html** saves the single file.

## Accessibility and design tokens
- **Accessibility** (Inspect): WCAG 2.2 AA contrast for each text layer, touch-target size, missing labels on icon-only controls, tiny text. Rows show the measured colors and ratio; click one to select the layer. Backgrounds are found from covering layers and ancestors; gradients/images are reported as unmeasured. **Identical findings are grouped** (`40 layers · #6B7280 on #09090B · 4.12:1 needs 4.5`), so repeated content doesn't bury the rest of the panel; the list is capped at 25 groups with *Show N more*.
- **Design tokens**: export what the layer uses, or the whole file, as CSS variables, SCSS, JSON (design-tokens format) or a Tailwind v4 `@theme`. All variable modes become `[data-theme=...]` overrides; aliases stay references.

## Inspect panel layout (matches Figma Dev Mode)

Top to bottom, every section is collapsible (click its title):

1. **Header**: layer name, type line (e.g. "Component instance"), status chip, "Ready for dev · <frame>" and a **N changes** button that jumps to *Changes since ready*.
2. **Overrides**: on instances, shows which layers differ from the main component, with **Compare with main component**.
3. **Dev resources**: links with GitHub / Storybook / Jira / Linear icons. **Code Connect** box below.
4. **Component information**: description, preview thumbnail, properties (boolean / instance swap / text / variant icons), "N more" and **Go to main component**.
5. **Annotations**: colour-coded categories, pinned property chips, add form (category, pinned property, optional canvas note).
6. **Code**, **Layer properties**, **Typography**, **Colors**, **Effects**, **Variables**, **Content**, **Interactions**, **Layers**, **Assets**, **Export**.
   - **Layer properties** has a box-model diagram (margin, border, padding, size, radius) and a **List / Code** toggle. List shows token chips (`# var(--space-600)`). Code shows grouped CSS (Layout / Style) or Tailwind.
   - **Export** has scale (0.5x to 4x), format (PNG / JPG / SVG / PDF), **Export <layer>** and a preview.

## Why annotations might not show on the canvas

Figma's native annotations are real, but several Figma rules can hide them:

| Cause | Fix |
|---|---|
| The annotation view is off (it also hides measurements, and sometimes turns back off on reload) | Press **Shift+Y**, or Main menu → View → **Annotations** |
| Free (Starter) plan | Native annotations need a Professional plan or higher. Tick **Also add a note on the canvas** instead. |
| No edit seat | Adding annotations needs a Full seat with edit access. Viewing needs a Full or Dev seat. |
| Main component vs instance | An annotation on a main component doesn't appear on its instances, and the other way round. |
| Group, section or boolean layer | These can't hold annotations. Select a frame, shape, text or instance. The plugin falls back to a canvas note. |
| Layer is off-screen | The plugin now scrolls the layer into view after adding. |

What the plugin does now:
- It reads the annotations back after writing, to confirm Figma kept them.
- It retries without the pinned property or category if Figma rejects them.
- If Figma drops or blocks the annotation, it draws a **canvas note** instead: a locked "📝 DevReady note" card with a leader line, placed beside the frame and visible on every plan.
- Deleting the annotation also removes its canvas note. **⋯ → Remove canvas notes on page** clears all of them.

## Features
- **Inspect**
  - Box model (distance to parent, padding, size)
  - Width/height/X/Y, sizing (fixed/hug/fill), min/max
  - Auto layout: direction, gap, alignment, padding, wrap
  - Fills and gradients, strokes, corner radius, shadows and blurs
  - Typography, including text with mixed styles
  - Text content (click to copy)
  - Color & text **style names** and **variables/tokens** (with their WEB code syntax)
  - Component, variant and properties, plus a "go to main component" button
  - **Variable modes**: every token shows its value in each mode (Light/Dark, Comfortable/Compact…) with alias chains (`→ blue/500`), plus the layer's explicit mode
  - **Layers**: a breadcrumb of parent layers (click to go up) and a list of child layers (click to go down)
- **Changes since ready** (Figma's API doesn't provide this, so the plugin implements it itself)
  - When a design is marked Ready for dev, the plugin saves a snapshot of its layers: hashes, plus compact values for position, size, fill, stroke, radius, effects, layout, font and text.
  - The header then shows **"N changes"**, and the **Changes** section lists added, changed and removed layers. Changed layers show **before → after** values, e.g. `Fill #7B61FF → #0D99FF`, `Padding 8 12 8 12 → 8 12 8 16`, or old → new text. Click one to select it.
  - <img src="../docs/screenshots/changes.png" width="360" alt="Changes since ready with before → after values">
  - **Mark as reviewed** saves a new snapshot. For designs that were marked ready before you installed the plugin, use **Start tracking**. **Clear** deletes the snapshot (all of its chunks) without changing the design's status.
  - The panel states that the snapshot lives **in the file**, so collaborators and other plugins can read it — it is shared plugin data, not private state.
  - Dev Mode's Code section header also shows "⚠ N changes since ready".
- **Annotations & dev resources (read + write)**
  - Add notes for developers, optionally pinned to a property (width, gap, fill, font size…), and remove them. These are real Figma annotations, so they also appear on the canvas in Dev Mode.
  - Add/remove links (GitHub, Storybook, Jira…) as real Dev Mode dev resources.
- **Measure**
  - Select one layer to see its distance to the parent, or shift-select a second layer to see the spacing between them
  - The 📏 button adds **real Figma measurements**, the same ones Dev Mode draws (insets to the parent, or the gap between two layers). In Design mode it falls back to drawn redlines if measurements aren't available. ✕ clears them.
- **Code**
  - CSS from Figma's own engine (`getCSSAsync`)
  - Tailwind classes, with the Tailwind scale used where values match and arbitrary values otherwise
  - Full-tree **HTML + CSS** and **React + Tailwind** for the selected layer and everything inside it
  - Automatic tag guesses (`button`, `nav`, `h1`–`h3`, `p`, `img` for icons)
  - px/rem units with a configurable base size
- **Assets**
  - Automatically finds icons, image fills and layers with export settings
  - Export as SVG / PNG 1x/2x/3x / JPG / PDF, or **download everything as a ZIP** (built in, so no network access is needed)
- **Ready list**: with nothing selected, it lists every ready or completed design on the page. Click one to jump to it.
- **Settings** (saved per user): gate on/off, accept the team flag, px/rem, rem base, HEX/RGB/HSL

## Workspace, vector illustrations and GitHub

The panel has a tab bar. **Design** is the original inspector (unchanged); the other tabs
are workspace surfaces:

| Tab | Contents |
|---|---|
| **Overview** | Current selection, layer count, depth, cost estimate, warnings, recent activity, and the project list (search, sort, archive). |
| **Design Files** | The design entries of the active project with per-file status. *Generate all* runs them one at a time with a progress meter; *Retry N failed* re-runs failures only; *Cancel* stops the queue. |
| **Code** | Files from the last run with sizes, per-file and ZIP download, warnings, and links to history and publishing. |
| **Assets** | Search, type filter, 8 rows with *Show all N* / *Show less*, thumbnails for visible rows, per-asset and bulk export. |
| **History** | Local revisions: compare (added / removed / changed / unchanged, line diff) and restore with a confirmation. |
| **GitHub** | Connect a token, list or create repositories, pick a branch, preview added/modified/unchanged/deleted files, choose files, commit. |
| **Settings** | Gate, units, rem base, colours, fonts, **vector illustrations**, limits, disconnect, clear local data. |

Projects, entries and revisions live in `figma.clientStorage` on this machine (200 kB per
key), not in the file — nothing is shared with collaborators.

**Vector illustrations.** A self-contained artwork frame is exported as **one SVG** and
referenced like an image instead of being rebuilt element by element. The heuristic needs
all of: a vector-only subtree (no text, no instances, no raster fills) *and* one of — an
SVG export setting, an artwork-like name (`illustration`, `logo`, `artwork`, `mascot`, …),
or a dense composition (≥ 30 shapes). `Settings → Vector illustrations` has three levels:
*Automatic*, *Named or SVG-exported only*, and *Never*. Everything Figma considers UI —
forms, buttons, navs, cards with text — is generated as code exactly as before, and a
failed SVG export falls back to element-by-element output with a note in the panel.
Exported SVG is sanitised (`cleanSvg`): scripts, event handlers, external references,
remote `url()` and `@import` are rejected; local `url(#gradient)` and `<use href="#id">` are kept.

**Limits, cost and cancellation.** Before generating, `assessComplexity()` walks up to
6,000 layers and reports layers, depth, text, vectors, instances, images and an estimated
cost, with warnings when a run will be truncated. Layers described per selection: 6,000;
layers per generation: 2,500; asset walk: 2,000 layers / 400 assets; panel code timeout:
20 s; local storage: 200 kB per key; projects: 20; revisions: 8. A run carries a job id:
**Cancel** stops it at the next layer boundary and answers `cancelled`, so the panel never
sits on “Building…”.

## Files
- `manifest.json`: editor types, capabilities (inspect + codegen + vscode), codegen languages and preferences
- `code.js`: plugin logic (gate, spec extraction, variable modes, change tracking, Code Connect mapping, CSS→Tailwind, tree code generation for all twelve targets, assets, native measurements, annotations, dev resources, codegen). Section map: [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)
- `ui.html`: the panel UI — the tab bar plus the Inspect panel, styled after Figma Dev Mode (UI3 look, follows Figma's light/dark theme). If you open it in a normal browser, it shows sample data.

## Notes and limits
- If Figma rejects the manifest on import, remove `"codegen"` from `capabilities` and delete the `codegenLanguages` and `codegenPreferences` blocks. The inspector will still work.
- If the plugin seems to ignore edits, re-run it: Figma caches the last loaded `code.js` per session.
- The native status can only be set on frames, components and sections that sit directly on a page or inside a section, and not inside something that already has a status. This is a Figma rule.
- Change tracking compares against the plugin's own snapshot, not Figma's version history. It shows before → after for position, size, fill, stroke, radius, effects, layout/padding, font and text (first 80 characters). Other edits, e.g. gradient stops, are flagged by category. Snapshots made by v1.0 show categories only until you click **Mark as reviewed**. Snapshots are limited to 2,500 layers per design.
- Code Connect mapping affects React output only. SwiftUI and Compose still rebuild the component from its layers.
- Plugins can't do the following, so Dev Mode still does them better: hover-to-measure on the canvas, version comparison, notifications when designs change, and VS Code's built-in "Figma for VS Code" integration.
- Full-tree code stops after 600 layers in the panel (1,500 for Download project) and 150 in Dev Mode's Code section, because Figma gives code generation only a 3-second time limit.
- **Two optional network paths, nothing else.** (1) The HTML preview may load **public Google Fonts** (family + weights from the bundled catalog) from `fonts.googleapis.com` / `fonts.gstatic.com`; turn it off with ⋯ → **Load Google Fonts in preview**. (2) **GitHub publishing**, which runs only after you connect a token and confirm a preview. Private, commercial and system font names are never sent, and no layer names, text, images or file data leave Figma unless you push generated code. See [PRIVACY.md](../PRIVACY.md) and [PUBLISHING.md](../docs/PUBLISHING.md).
- The preview iframe is sandboxed without scripts and locked down by a Content-Security-Policy. Every message from the panel to the plugin is validated. See [SECURITY.md](../SECURITY.md).
- Before you publish, replace `"id"` in `manifest.json` with the ID Figma gives you.

## Testing

From the repo root: `npm ci && npm run verify` (layout, Figma sandbox check, ESLint, tests). The suite runs 9 fixture designs through all 12 code targets and checks each output parses (JSX/CSS with esbuild; HTML, Swift, Kotlin, Dart, Vue and Svelte with structural checks). It also tests:
- escaping of hostile layer names;
- message validation and mapping injection;
- change tracking (100 kB limit, before → after values);
- that the plugin code makes no network requests.

It also covers the workspace: illustration vs UI classification, complexity limits,
cancellation, the GitHub adapter against a mocked API (connect, rate limits, permissions,
network loss, retry policy, commit sequence, stale base, rejected ref, unsafe paths), local
storage bounds, tab rendering, the per-file queue and project management.

Two further groups test the output itself: **golden files** (`tests/golden/`, four fixture × target pairs) fail with a one-line diff when generated code drifts — accept a deliberate change with `npm test -- --update-golden` — and the **generated React project is bundled with esbuild**, so every import it emits must resolve.

`npm run test:browser` renders the panel in Chromium and attacks the preview sandbox. See [docs/test-report.md](../docs/test-report.md).

## Troubleshooting

- **`SyntaxError: possible import expression rejected around line N`** (or an HTML-comment error) in the console: Figma's plugin sandbox rejects some text patterns anywhere in `code.js`, even inside strings and comments. These are `import (` / `import(`, `<!--` / `-->` and `eval(`. Run `node check-sandbox.js` after editing `code.js` to find them.

