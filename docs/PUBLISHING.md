# Publishing to GitHub (optional)

DevReady can send the code it generates to a GitHub repository. It is **off by
default**, it never runs without you pressing a button, and the plugin works
exactly as before if you never connect an account.

This page is the whole contract: what is stored, what permissions are needed,
what the limits are, and what happens when something goes wrong.

---

## 1. Why a token and not “Sign in with GitHub”

Figma plugins run in two sandboxes and have no OAuth redirect URL. The OAuth
web flow needs a client secret and a callback host; a plugin has neither, so the
usual “Sign in with GitHub” button is not available to it, and hiding a secret
in a plugin bundle would make it public.

DevReady therefore uses a **fine-grained personal access token** that you create
and paste in once. It is the smallest credential GitHub offers that can be
scoped to specific repositories.

- It is stored with `figma.clientStorage` under the key `devready-github-token`.
  That storage belongs to the plugin instance on your machine — not to the
  document, so it is never shared with anyone you send the file to.
- It is never sent to the panel. The token is read and used only inside
  `code.js`; the UI sends `gh-connect { token }` once, and every reply from the
  plugin thread passes through `ghScrub()`, which redacts anything that looks
  like a token before it can reach the panel.
- **Disconnect** deletes the stored token (`deleteAsync`), so the plugin is back
  to “not connected” without any leftover credential.

> If a token ever does leak, revoke it in GitHub → Settings → Developer
> settings → Personal access tokens. Nothing in Figma can revoke it for you.

## 2. Required permissions

Create the token at **GitHub → Settings → Developer settings → Personal access
tokens → Fine-grained tokens → Generate new token**.

| Permission | Why | Needed for |
|---|---|---|
| **Contents: Read and write** | create blobs, trees, commits; update a branch | every push |
| **Administration: Read and write** | create a repository | “Create repository” only |
| Metadata: Read | GitHub always grants this | every call |

Scope it to the repositories you intend to publish to (“Only select
repositories”), with an expiry you are comfortable with.

The manifest allows exactly one network host for this feature,
`https://api.github.com`, so the plugin cannot call anything else. Google Fonts
keeps its own two hosts for font previews.

## 3. What each action does

| Action | GitHub calls | Notes |
|---|---|---|
| Connect | `GET /user` | Verifies the token; a rejected token is never stored. |
| List repositories | `GET /user/repos` | Up to 100, most recently updated first. |
| List branches | `GET /repos/{owner}/{repo}/branches` | Up to 100. |
| Preview | `GET /repos/{owner}/{repo}/git/trees/{branch}` | Shows added / modified / deleted / unchanged for every generated file, with per-file selection. |
| Push | `blobs` → `trees` → `commits` → `PATCH refs/heads/{branch}` | One commit, never a force-push (`force: false`). |
| Create repository | `POST /user/repos` | Private by default. |

Nothing is written to GitHub until **Push** is pressed on the preview screen,
and only the files you tick are included.

## 4. Limits

| Limit | Value | What happens |
|---|---|---|
| Files per push | 200 | The push is refused with a message; use a narrower selection. |
| Total bytes per push | 4 MB | Same — assets are not inlined into code, so this is usually only hit by very large single-file exports. |
| Files in a tree listing | 100 (preview) | Preview says the list is partial rather than pretending it is complete. |
| Request timeout | 20 s | Reported as a timeout, not as a silent hang. |
| Retries | reads only, once, on 5xx | A write is never retried automatically, so a push cannot create two commits. |

## 5. When something goes wrong

Every failure is mapped to one code with a sentence you can act on:

| Code | Meaning | What to do |
|---|---|---|
| `not-connected` | No token | Press Connect. |
| `auth` | 401 — expired or revoked | Create a new token, disconnect, connect again. |
| `permission` | 403 without rate-limit headers | Add *Contents: read and write* (and *Administration: write* to create repositories). |
| `rate-limit` | 403 with `x-ratelimit-remaining: 0` | The panel shows the reset time; wait and retry. |
| `conflict` | The branch moved, or the ref update was rejected | Nothing was overwritten. Preview again to see the current files, then push. |
| `network` | The request never reached GitHub | Nothing was changed on GitHub. |
| `not-found` | 404 — repo or branch deleted, or no access | Re-pick the repository. |
| `bad-path`, `bad-repo`, `bad-branch`, `no-files`, `too-many`, `too-large` | Local validation | The message says which field is wrong. |

### Conflicts, precisely

A push carries the commit it started from. Before writing anything, DevReady
re-reads the branch head:

- If the head moved, the push stops with `conflict` **before** any blob is
  created — nothing is left behind.
- If the head moves during the push, GitHub rejects the ref update
  (`422`). DevReady reports that as `conflict` too, and the text says explicitly
  that nothing was overwritten. Retrying is safe: it is a new commit on the
  current head, not a partial one.

### Path safety

File paths are validated before they reach the API: no absolute paths, no `..`
segments, no `.git` directory, no control characters, and a 240-character cap.
Repository names must match GitHub's own grammar (`owner/name`) and branch names
reject spaces, `..`, `~`, `^`, `:`, `?`, `*`, `[`, `\` and trailing dots. These
checks run in the plugin thread, so a crafted message from the panel cannot skip
them.

## 6. Local history is independent

Version history lives on your machine (`devready-history`) and does not require
GitHub at all: every successful run records a revision, revisions can be
compared (added / removed / changed / unchanged per file, with a line diff) and
restored (with a confirmation, as a ZIP and as the current code).

Each revision also records which design layer produced it, so the chain
**design layer → run → files** is visible in the panel. When you push, the
commit URL is shown next to the run, which closes the loop: **design → code →
commit**.

## 7. Turning it off

- Disconnect removes the token; the GitHub tab goes back to the connect form.
- **Settings → Clear local data** deletes projects and revisions from
  `clientStorage` (two confirmation presses).
- Uninstalling the plugin removes `clientStorage` for that plugin entirely.

Nothing about GitHub is enabled by default, and no other feature depends on it.
