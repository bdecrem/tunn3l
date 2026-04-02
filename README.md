# tunn3l.sh

The tunnel service built for AI agents. Expose localhost to the internet. One command. No signup. No config.

Free and open source. MIT licensed.

## Quick Start

```bash
curl -sSf https://tunn3l.sh/install | sh
tunn3l http 3000
```

```
tunn3l: tunnel ready
tunn3l: https://myapp.tunn3l.sh → localhost:3000
```

## Why tunn3l?

- **Agent-first** — JSON output, env var config, exit codes. Zero interactive prompts. Your AI agent can install and run it without help.
- **Zero setup** — No account. No API key. No client app on the other end. Just curl the binary and go.
- **Free & open source** — MIT licensed. Run the relay yourself or use ours. HTTP tunnels, TCP tunnels, SSH — all free.

## Features

- **HTTP tunnels** — expose any local port at `*.tunn3l.sh`
- **SSH/TCP tunnels** — expose SSH, databases, or any TCP service
- **Custom subdomains** — `tunn3l http 3000 --subdomain myapp`
- **Reserved subdomains** — permanently bind a subdomain to a device
- **Daemon mode** — `tunn3l daemon install` for always-on tunnels
- **JSON output** — `--json` flag for programmatic use

## Usage

```bash
tunn3l http 3000                          # random subdomain
tunn3l http 3000 --subdomain myapp        # myapp.tunn3l.sh
tunn3l http 3000 --json                   # JSON output
tunn3l ssh                                # SSH tunnel
tunn3l ssh --subdomain mybox              # ssh user@mybox.tunn3l.sh
tunn3l daemon install --port 3000         # always-on tunnel
tunn3l status                             # show active tunnels
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `TUNN3L_TOKEN` | API token (alternative to `tunn3l login`) |
| `TUNN3L_RELAY` | Relay server URL |
| `TUNN3L_SUBDOMAIN` | Default subdomain |

## Architecture

- **CLI** (`cli/`) — Node.js, compiled to standalone binaries via esbuild + pkg
- **Relay server** (`relay/`) — Node.js on a DigitalOcean droplet. HTTP tunneling via WebSocket, TCP/SSH via per-tunnel port listeners.
- **Nginx** — reverse proxy with wildcard SSL for `*.tunn3l.sh`

## Self-Hosting

```bash
cd relay
npm install
PORT=3000 node server.js
```

Set up wildcard DNS pointing to your server. See `TUNN3L.md` for full docs.

## Deploy

Pushes to `relay/` on `main` auto-deploy to the production droplet via GitHub Actions.

## License

MIT
