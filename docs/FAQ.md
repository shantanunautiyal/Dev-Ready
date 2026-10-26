# FAQ

Short answers to the questions people actually ask after opening this repo.

### Is this Figma Dev Mode?

No. It is a **plugin that gives you a Dev Mode-style Inspect panel** plus code
generation, and it runs in Design mode, Dev Mode and Figma for VS Code. Figma's own
Dev Mode is a paid seat; this is free and open source.

What plugins genuinely cannot do, and Dev Mode can: hover-to-measure on the canvas,
version history comparison, notifications when a design changes, and VS Code's
built-in integration. DevReady uses native measurements and native annotations where
Figma allows, and its own fallbacks where it doesn't.

### Do I need a paid Figma plan?

No. Everything works on a free/Starter plan, with two caveats that the UI states
explicitly:

- Figma's native **Ready for dev** status can't be set on some plans. DevReady then
  stores its own flag (shared plugin data) and labels the status **DevReady flag**
  instead of **Figma status**.
- Native **annotations** need a Professional plan or higher. DevReady falls back to a
  locked canvas note beside the frame, which works on every plan.

### Why is everything locked behind a gate?

That's the product's idea: designers mark a frame *Ready for dev*, and only then do
developers get specs and code, so nobody builds from a half-finished design. It is
**optional**:

- **Inspect anyway** on the lock screen, or
- **⚙ Settings → Dev-ready gate → off**, or
- in Dev Mode's Code section, set *Dev-ready gate* to **Always generate**.

### It says "Not ready for dev" but the frame is marked ready in Figma

The plugin walks **up** from the selected layer to the first ancestor with a status.
If you selected a layer inside a frame, the frame itself must be marked. Check the
chip at the top of the lock screen — it tells you which source it consulted
(**Figma status** or **DevReady flag**). *Mark as ready for dev* is also on that
screen.

### Why can't I import the plugin in the browser version of Figma?

Figma only allows importing development plugins in the **desktop app**. Once
published to Figma Community, it will work anywhere.

### "Manifest is invalid" / the plugin doesn't appear

- Make sure you picked `devready-plugin/manifest.json`, not the root of the repo.
- Often the manifest came from a ZIP download where the folder structure was kept —
  the file must sit next to `code.js` and `ui.html`.
- `manifest.json` contains a placeholder `"id"`. That is fine for local use; Figma
  assigns a real one when you create a plugin (see [LAUNCH.md](LAUNCH.md)).
- If Figma rejects the `codegen` capability on an older build, remove `"codegen"`
  from `capabilities` and the `codegenLanguages`/`codegenPreferences` blocks. The
  inspector keeps working.

### Does it send my design anywhere?

Not unless you ask it to. Font classification uses a catalog of 1,950 Google Fonts
bundled into the plugin, so even a private font name never leaves Figma. There are two
network paths, both optional:

1. the *preview* iframe loading **public Google Fonts** so the HTML renders in the
   design's typeface — turn it off with **⋯ → Load Google Fonts in preview**;
2. **GitHub publishing**, which only happens if you paste a token and press *Push*. It
   sends the generated files you selected to your own repository.

Code generation, inspection, tokens, exports and change tracking never touch the
network. See [PRIVACY.md](../PRIVACY.md) and [PUBLISHING.md](PUBLISHING.md).

### Does it push my code to GitHub automatically?

No. The GitHub tab is inert until you connect a token, and even then nothing is written
until you preview the changes, choose files and press *Commit & push*. Details and the
required permissions: [PUBLISHING.md](PUBLISHING.md).

### The generated code doesn't match the design exactly

Two known causes, both visible in the UI:

1. **Layer budget.** Code generation stops after 600 layers in the panel (1,500 for
   project downloads, 150 in Dev Mode's Code section, which has a 3-second budget).
   The output and the panel say when this happened. Select a smaller frame.
2. **Fonts.** If a family is not on Google Fonts and not installed on the machine
   that renders the HTML, text falls back. Add the `.woff2/.woff/.ttf/.otf` files via
   **Code → Fonts → Add font files**, and they are embedded or bundled.

For layout differences, use **Code → Preview → Overlay → Difference**: identical
pixels go black, so anything bright is a mismatch.

### Where do variables/light-dark mode end up in the code?

Every Figma variable becomes a CSS custom property in `:root`, and **every mode**
becomes an override block — `[data-theme="dark"]` for a Light/Dark collection, or
`[data-<collection>="<mode>"]` otherwise. SwiftUI gets light/dark-aware colours,
Compose gets an `AppColorsDark` object. You can also export the whole file's tokens
from **Inspect → Design tokens** as CSS, SCSS, JSON (design-tokens format) or a
Tailwind v4 `@theme`.

### Is there TypeScript output?

Yes. Pick **React + TypeScript** or **React + TypeScript + Tailwind** (panel, Dev Mode's
Code section, or Figma for VS Code). Compared with the JavaScript targets:

- the file is `.tsx`;
- every repeated pattern that becomes a component also gets a `Props` type
  (`type StatCardProps = { label: string; value: string }`) and consumes it;
- an `assets.d.ts` is added with ambient declarations for the CSS and asset imports the
  design uses, so `tsc` doesn't complain about `import logo from './assets/logo.svg'`.

CI compiles the generated `.tsx` with `tsc --strict`, so this is checked on every push,
not just claimed.

### Is the code Tailwind v3 or v4?

The React + Tailwind target emits utility classes, and the **design tokens export**
emits a Tailwind **v4** `@theme` block. Arbitrary values (`w-[182px]`) are used where
a value isn't on the default scale.

### What does "changes since ready" compare against?

The plugin's own snapshot, taken when the frame was marked ready — not Figma's version
history. Changed layers show **before → after** values. **Mark as reviewed** saves a
new baseline; **Start tracking** creates one for designs handed off before you
installed the plugin. Snapshots cover the first 2,500 layers of a frame and are stored
in the file, chunked under Figma's 100 kB per-entry limit.

### Does it work with Figma for VS Code?

Yes — the codegen languages are declared for the `vscode` capability, so the same
targets appear in VS Code's code panel. The full panel is the same as in Dev Mode.

### Can I use it with Code Connect?

DevReady has its own Code Connect-style mapping: select a component instance →
**Component → Connect to code** → component name + import path. Mappings are stored in
the file and affect **React output only**.

### Why is the repository structured this way?

Because Figma imports a folder: `devready-plugin/` may contain only the manifest, the
two source files, the sandbox checker and its README. Everything else (tests, docs,
CI, package.json) lives at the root. `npm run check:layout` fails the build if that
slips — this repository was once broken by uploading the root files *inside* the plugin
folder, which hid the README and disabled CI. See [GITHUB_SETUP.md](GITHUB_SETUP.md).

### How do I regenerate the font catalog?

```bash
npm i --no-save google-font-metadata@6
node scripts/build-font-catalog.js --write
```

The plugin ships only the generated string; the package is not a dependency. If a font
is missing from the catalog, it is treated as custom and gets an `@font-face` with
local fallbacks — safe, but it will not be linked from Google Fonts.
