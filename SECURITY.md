# Security

DevReady runs inside Figma's plugin sandbox. There are two network paths, both optional and both switchable: the panel's preview may load public Google Fonts (turn it off in settings), and the plugin may publish generated files to GitHub, but only after you connect a token and confirm a preview (see [PUBLISHING.md](docs/PUBLISHING.md)). Code generation itself makes no requests — the test suite fails if it does.

## Trust boundaries and how they are protected

| Boundary | Risk | Protection | Tested by |
|---|---|---|---|
| **Design content → generated code** | Layer names and text come from files that may not be trusted. They're written into HTML, JSX, Swift and Kotlin | Escaped for each target language: markup and attributes, `{}` in JSX, `$` templates in Kotlin, `\(` in Swift, control characters, bidi overrides ("Trojan Source") | `hostile-content` fixture × 12 targets (`npm test`) |
| **Generated HTML → live preview** | The preview renders generated HTML inside the panel | `<iframe sandbox="allow-same-origin">` with **no** `allow-scripts`, so scripts and event handlers never run. A CSP meta allows no requests except Google Fonts (none when offline), `referrerpolicy="no-referrer"`, no forms, no `<base>` | `npm run test:browser`: a hostile document with `<script>`, `onerror`, an external image and a form. Also checked: the test fails if the sandbox is removed |
| **Panel UI → main thread** | Messages from the UI iframe drive file edits and exports | Every message is checked against a per-type schema before it is handled. Unknown types are ignored and unknown fields dropped. Strings are length-capped, ids must look like Figma node ids, enums and numeric ranges are enforced (export format/scale, font upload size/type, http(s)-only dev resources) and settings keys are whitelisted. Invalid input shows an error toast | `message validation` (15 cases) in `npm test` |
| **Panel → GitHub** | Generated code leaves Figma for a repository | Optional and user-initiated: a fine-grained token stored in `clientStorage`, used only in the plugin thread, redacted from every reply, never rendered in the panel and deleted on Disconnect. Files, paths, repo names and branches are validated in the adapter, the ref update is never forced, and a moved branch is detected before anything is written | `tests/platform.js` (`github`) — connect, reject, token never echoed, rate limits, permissions, 404, network, retry policy, unsafe paths, stale base, rejected ref |
| **Untrusted SVG → preview** | An exported illustration could carry script or external references | `cleanSvg()` rejects dangerous tags, `on*` handlers, external `href`/`src`/`action`/`data`, remote `url()` and `@import`, including entity-obfuscated forms; the preview iframe has no `allow-scripts` | `tests/enhancements.js` and `tests/platform.js` (SVG cases) |
| **File data → generated code** | Component mappings are stored in the Figma file (shared plugin data), which anyone with edit access, or another plugin, can write | Mappings are re-validated when read. The import path must be a plain module path, and it is emitted through a JS string-escaping helper | `component mappings from the file are validated and safely quoted` in `npm test` |

### Fixed in 1.1.0
- **Code injection via component mappings.** A crafted import path stored in the file (e.g. `./x';alert(1);//`) was concatenated into generated React code without escaping, so someone who opened the file and copied the code got the injected statement. Paths are now validated on save and on load, and quoted on output.

## Verify these claims yourself

None of the above is a promise — each row has a test you can run:

```bash
npm ci
npm run verify          # includes the 15 message-validation cases, injection cases,
                        # privacy checks and the hostile-content fixtures
python3 -m pip install playwright && python3 -m playwright install chromium
npm run test:browser    # sandbox: script, onerror, external image and form in a hostile document
```

The browser test also **fails if the sandbox attribute is removed**, so the protection
can't be dropped silently.

Look at the actual attributes rather than a description:

```bash
grep -n 'sandbox=\|Content-Security-Policy' devready-plugin/ui.html
grep -n 'function validateMsg\|MSG_SCHEMA' devready-plugin/code.js
grep -n 'function ghScrub\|Authorization' devready-plugin/code.js   # one fetch() call site, token redaction
sed -n '1,12p' devready-plugin/manifest.json                        # network allowlist
```

The GitHub path is documented end to end in [docs/PUBLISHING.md](docs/PUBLISHING.md):
required scopes, what is sent, the limits, and the meaning of every error code.

### If you are reviewing this project

Reviews written before **v1.2.0** (October 2026) describe an unsandboxed preview and an
unvalidated message handler. Both were addressed in v1.1.0/v1.2.0, and the repository's
layout was repaired afterwards — older reviews may also have read the stale copy of the
plugin that used to live in `devready-plugin/devready-plugin/`. Quote the commit you
reviewed (`git rev-parse HEAD`) next to your findings so readers can tell which tree
the result applies to.

## Reporting a vulnerability

Please open a GitHub security advisory (**Security → Report a vulnerability**) rather than a public issue. Expect a reply within a week.
