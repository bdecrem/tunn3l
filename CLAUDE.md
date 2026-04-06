# tunn3l

Tunnel service for AI agents. Expose localhost to the internet with one command.

## Architecture

- **CLI** (`cli/`) — Node.js client, compiled to standalone binaries with Bun. Entry point: `cli/bore.js`
- **Relay** (`relay/`) — Node.js server (`relay/server.js`). HTTP tunneling via WebSocket, TCP/SSH via per-tunnel port listeners.
- **Nginx** — reverse proxy with wildcard SSL for `*.tunn3l.sh` (not in repo)

## Key files

- `cli/bore.js` — CLI entry point
- `relay/server.js` — relay server
- `relay/db.js` — database layer
- `relay/words.js` — subdomain word list
- `relay/install.sh` — installer script served at tunn3l.sh/install

## Dev

```bash
# Run relay locally
cd relay && npm install && PORT=3000 node server.js

# CLI (from source)
cd cli && npm install && node bore.js http 3000
```

## Deploy

### After changing relay code (`relay/`)

Pushes to `relay/` on `main` auto-deploy to production via GitHub Actions. Just commit and push.

### After changing CLI code (`cli/`)

CLI binaries must be rebuilt and released so `curl -sSf https://tunn3l.sh/install | sh` installs the new version. After committing and pushing CLI changes:

1. Build all 4 binaries:
```bash
cd cli
~/.bun/bin/bun build bore.js --compile --target=bun-darwin-arm64 --outfile dist/tunn3l-darwin-arm64
~/.bun/bin/bun build bore.js --compile --target=bun-darwin-x64 --outfile dist/tunn3l-darwin-x64
~/.bun/bin/bun build bore.js --compile --target=bun-linux-arm64 --outfile dist/tunn3l-linux-arm64
~/.bun/bin/bun build bore.js --compile --target=bun-linux-x64 --outfile dist/tunn3l-linux-x64
```

2. Compress:
```bash
cd dist && gzip -k tunn3l-darwin-arm64 tunn3l-darwin-x64 tunn3l-linux-arm64 tunn3l-linux-x64
```

3. Create GitHub release (install.sh downloads from `bdecrem/tunn3l` releases):
```bash
gh release create vX.Y.Z cli/dist/tunn3l-*.gz --repo bdecrem/tunn3l --title "tunn3l vX.Y.Z — description"
```

There is also a CI workflow (`.github/workflows/release-cli.yml`) that builds on tag push, but it needs repo permissions fixed to upload to releases. For now, create the release manually with `gh`.

### After changing both relay and CLI

Push to main (deploys relay), then build binaries and create a release (updates CLI). Bump version in `cli/package.json`.

## Important

- **Do not use `pkg`** — it's deprecated and broken on modern Node. Use Bun.
- **`cli/dist/` is gitignored** — binaries are uploaded to GitHub Releases, not committed.
- **This repo is standalone** — no dependency on the `hilma` repo. All CI/CD runs here.
- The install script (`relay/install.sh`) downloads from `bdecrem/tunn3l` releases.
