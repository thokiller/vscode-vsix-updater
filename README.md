# VSIX Updater

Installs and updates sideloaded VS Code extensions from GitHub releases. Install
this extension once, tell it which GitHub repositories to watch, and it will
offer to install or update their released `.vsix` files. It never installs
anything without your approval, and it keeps itself updated the same way.

## One-time install

1. Download `vsix-updater-<version>.vsix` from this repository's
   [latest release](https://github.com/thokiller/vscode-vsix-updater/releases/latest).
2. In VS Code open the Command Palette (`Ctrl+Shift+P`), run
   **Extensions: Install from VSIX...**, and pick the downloaded file.
3. Reload the window when asked.

That is the last time you install anything by hand.

## What it does

- Checks the configured repositories once shortly after VS Code starts.
- When a watched extension is missing or has a newer GitHub release, you get a
  notification with these choices:
  - **Install** / **Update** - downloads the VSIX in the background (with a
    progress popup) and installs it, then offers to reload the window.
  - **Remind Me Tomorrow** - asks again the next day.
  - **Skip This Version** - never asks about that version again. A newer
    release will still be offered, and a manual check always shows skipped
    versions so you can change your mind.
  - **Release Notes** - opens the GitHub release page.
- Closing the notification does nothing permanent; it may come back on a later
  check.

## Adding repositories

Run **VSIX Updater: Add GitHub Repository** from the Command Palette and paste
a repository URL (for example `https://github.com/owner/repo`) or just
`owner/repo`. The repository must publish a `.vsix` file on its GitHub
releases.

## Checking manually

Run **VSIX Updater: Check for Updates** from the Command Palette, or click the
**VSIX Updates** button in the status bar (bottom right). Manual checks report
their result, including "everything is up to date" and any problems.

## Configuration file

Run **VSIX Updater: Open Configuration File** to edit the settings. The file is
strict JSON and lives in the extension's global storage (the command opens it
for you):

```json
{
  "sources": [
    "owner/repo",
    { "repo": "owner/other", "asset": "other-windows.vsix" },
    { "repo": "owner/private", "token": "ghp_..." }
  ],
  "token": "",
  "checkOnStartup": true,
  "periodicCheckHours": 0
}
```

- `sources` - repositories to watch. Plain `"owner/repo"` strings are enough.
  Use the object form with `"asset"` only when a release contains more than one
  `.vsix` file, to name exactly which one to install, and with `"token"` to use
  a specific token for that repository only. Only github.com repositories are
  supported; anything else is rejected with a clear error.
- `token` - optional GitHub personal access token used for every source that
  does not set its own `"token"`, needed for private repositories (give it
  read-only access to those repositories and nothing more). It also raises the
  API rate limit for public repositories.
- `checkOnStartup` - check once shortly after VS Code starts (default `true`).
- `periodicCheckHours` - also check every N hours while VS Code is running.
  `0` (the default) disables periodic checks.

Changes are picked up when you save the file; no restart needed.

### Token safety

Tokens are stored as plain text in this file, so:

- use fine-grained tokens restricted to the private repositories they need,
  with read-only contents access;
- never share, screenshot, or commit the file;
- the extension only ever sends tokens to `api.github.com` and never logs them.

## Self-updating

The updater watches its own repository automatically, so it offers updates for
itself exactly like for any other extension. You do not need to add it to
`sources`.

## Troubleshooting

Background check problems are never shown as popups; look at the
**VSIX Updater** output channel (View > Output) or run a manual check to see
what went wrong.

## Development

- `npm ci` then `npm test` for unit tests, `npm run test:extension` for the
  VS Code integration tests, `npm run package` (or `build-vsix.cmd`) to build
  the VSIX.
- Pushing a `v*` tag builds the VSIX in CI and attaches it to a GitHub release.

Licensed GPL-2.0-only; see [LICENSE.txt](./LICENSE.txt).
