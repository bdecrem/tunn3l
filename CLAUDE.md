# tunn3l

Tunnel service for AI agents. Expose localhost to the internet with one command.

## Architecture

- **CLI** (`cli/`) — Node.js client, compiled to standalone binaries. Entry point: `cli/bore.js`
- **Relay** (`relay/`) — Node.js server (`relay/server.js`). HTTP tunneling via WebSocket, TCP/SSH via per-tunnel port listeners.
- **Binaries** (`dist/`) — Pre-built binaries for macOS and Linux (arm64 + x64)
- **Nginx** — reverse proxy with wildcard SSL for `*.tunn3l.sh` (not in repo)

## Key files

- `cli/bore.js` — CLI entry point
- `relay/server.js` — relay server
- `relay/db.js` — database layer
- `relay/words.js` — subdomain word list
- `install.sh` — installer script served at tunn3l.sh/install

## Dev

```bash
# Run relay locally
cd relay && npm install && PORT=3000 node server.js

# CLI
cd cli && npm install && node bore.js http 3000
```

## Deploy

Pushes to `relay/` on `main` auto-deploy to production via GitHub Actions.
