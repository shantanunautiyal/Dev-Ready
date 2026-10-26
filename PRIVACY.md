# Privacy

DevReady is a local Figma plugin. It has no server, no account, no analytics and no telemetry.

## Network requests

There are exactly two network paths, and both are things you can see and switch off:

1. the panel's **live HTML preview**, which may load **public Google Fonts**, and
2. **optional GitHub publishing**, which only runs when you connect a token and press a button.

Whether a font is on Google Fonts is answered by a catalog bundled inside the plugin (≈1,950 families with their weights, italics and variable-weight ranges). No font lookups are sent anywhere.

| Domain | Requested by | What is sent | Why |
|---|---|---|---|
| `fonts.googleapis.com` | Preview iframe | A public Google Fonts family and weights from the bundled catalog, e.g. `css2?family=Inter:wght@500` | So the preview renders in the design's typeface |
| `fonts.gstatic.com` | Preview iframe | Requests for the font files that stylesheet references | Same |
| `api.github.com` | The plugin thread, only for GitHub actions you start | The repository, branch, file paths and file contents you selected, plus your token as an `Authorization` header | Publishing generated code to your own repository |

### GitHub publishing (opt-in)

- **Off by default.** Until you paste a token and press *Push*, no request is made; code generation, inspection, previews, tokens and exports never touch the network.
- **What is sent:** the generated files you tick in the preview, their paths, the commit message, and the repository/branch you picked. Nothing else — no design data, layer names, comments, images or user information.
- **The token** is a fine-grained personal access token that you create. It is stored in `clientStorage` (never in the Figma document), read only inside `code.js`, never forwarded to the panel, and redacted from every message the plugin sends back. **Disconnect** removes it.
- **Revoking:** GitHub → Settings → Developer settings → Personal access tokens. Deleting the plugin also removes the stored token.
- Full contract, permissions and error handling: **[docs/PUBLISHING.md](docs/PUBLISHING.md)**.

- **Never sent:** private, commercial or system font names (e.g. an in-house brand font), layer names, text, images, colors, variables, comments, file names/keys, user names or any other design data. A family is only ever requested if it exists in the public Google Fonts catalog.
- **Turn the font requests off:** ⋯ → **Load Google Fonts in preview**. With it off, the preview makes no font requests and uses fallback fonts (or fonts you uploaded). **GitHub** has its own switch: Disconnect.
- The preview is also locked down by a Content-Security-Policy: no scripts, no images or requests to other hosts, no forms. Even if a design contained hostile text, the preview could not contact any other server.
- Like any web request, Google receives your IP address and a user agent when the preview loads a font.

**Generated code:** HTML and React output contain a Google Fonts `<link>`/`@import` for Google-hosted fonts. When *you* open that code in a browser, the browser fetches the fonts from Google. Remove the link if you self-host fonts.

**How this is verified** (on every commit, see `npm test` and `npm run test:browser`):
- the code engine runs with a recording `fetch`, and code generation fails the build if it makes **any** request;
- the generated code must link Inter and a variable Space Grotesk weight, and must **not** contain the private font `Acme Internal Display` or `SF Pro` in any Google URL;
- `code.js` may contain exactly **one** `fetch(` call site, inside `ghRequest()`, and it must target the `GH_API` constant; XMLHttpRequest, WebSocket, sendBeacon and EventSource must not appear at all;
- the manifest's `allowedDomains` must be exactly the two Google Fonts hosts plus `https://api.github.com` — no wildcards;
- the token may not appear in any panel message, the token must be redacted by `ghScrub()`, and the `Authorization` header may only be built from the stored token;
- in Chromium, the real panel renders a hostile document in the preview. The test fails if a script or `onerror` handler runs, if a request goes to any other host, or (in offline mode) if any font request is made.

## What DevReady stores

**In the Figma file** (shared plugin data, namespace `devready`). This is visible to anyone who can open the file, and readable by other plugins:

| Key | Stored on | Contents |
|---|---|---|
| `status`, `note`, `at` | The ready frame/section | Status type, the handoff note, and a timestamp. No user names. Only written when the DevReady flag is used instead of Figma's native status |
| `baseline:*` | The ready frame | Change-tracking snapshot used for "before → after": layer IDs, the first 40 characters of each layer name, hashes, and compact values per layer: position, size, fill/stroke colors, radius, effects, layout/padding, font, and **the first 80 characters of each text layer**. No images. It only contains what is already in this file, and is split into chunks under Figma's 100 kB entry limit. (Snapshots saved by v1.0 contain hashes only.) |
| `map:*` | File root | Component → code mappings you created (component name, import path) |
| dev resources | The layer | Links you added |
| redlines | Locked measurement layers on the page | Spacing labels you asked to draw (Design Mode only) |
| canvas notes | Locked note layers on the page | The annotation text you wrote, and the ID of the annotated layer |

**On your device only** (Figma `clientStorage`, not shared):
- Plugin settings: unit, language, gate on/off, preview fonts on/off, vector-illustration mode.
- **Uploaded font files.** If you add custom fonts for the preview, they stay on your machine and are only embedded in code you export.
- **`devready-projects`** — your projects, their design entries and the last outputs (name, size, status, errors). Capped at 200 kB.
- **`devready-history`** — up to 8 code revisions per machine, with the generated code for comparison and restore. Capped at 200 kB.
- **`devready-github-token`** — the GitHub token, only if you connected GitHub. Removed by Disconnect.

**Native Figma data** the plugin writes when you ask it to: Ready for dev status, annotations, measurements.

## Removing data

- **Change tracking:** clearing a frame's status removes its snapshot, and **Changes → Clear** deletes it without touching the status. **Mark as reviewed** replaces it with the current design.
- **Who can read it:** the snapshot is shared plugin data, so it is part of the file. Anyone with edit access to the file, and any other plugin running on it, can read it. The panel says this next to the Changes section, and there is no way for a plugin to make that data private to one person — if a confidential design must not be snapshotted, clear the snapshot when you are done.
- **Canvas notes:** ⋯ → Remove canvas notes on page.
- **GitHub:** **GitHub tab → Disconnect** deletes the stored token immediately.
- **Local data:** **Settings → Clear local data** (two presses) deletes projects and revisions; removing the plugin from Figma (Plugins → Manage plugins) removes everything in `clientStorage` for this plugin, including the token.

Questions: open an issue at https://github.com/Ankushui18/Dev-Ready/issues.
