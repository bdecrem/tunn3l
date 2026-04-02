# tunn3l domain — one-command domain plumbing

*Spec v1 — 2026-04-02*

## The Problem

You have a machine. You have a service running on it. You want it on the public internet with a real domain, HTTPS, and proper DNS. Today that means:

1. Buy a domain (Namecheap, Cloudflare, etc.)
2. Configure DNS (A records, CNAME, etc.)
3. Set up SSL/TLS (Let's Encrypt, Cloudflare, etc.)
4. Point it at hosting (Vercel, DigitalOcean, etc.) OR tunnel it (ngrok, tunn3l, etc.)
5. Hope you didn't mess up the propagation

Each step has its own dashboard, its own auth, its own docs. AI agents can't do any of it.

## The Solution

```bash
tunn3l domain buy myapp.dev --tunnel 3000
```

One command. Domain purchased, DNS configured, HTTPS provisioned, localhost:3000 live at `myapp.dev`. Done.

## Design Principles

1. **All API keys live on the client device. Always.** The tunn3l relay never sees your Cloudflare token, Vercel token, or Namecheap credentials. The CLI talks directly to provider APIs from the user's machine.

2. **The relay is optional.** `tunn3l domain` works without the tunn3l relay for static hosting (Vercel, Netlify). It only uses the relay when tunneling to localhost.

3. **Agent-friendly.** JSON output, env var config, exit codes. An AI agent can buy a domain and deploy a site without a human touching a browser.

4. **Provider-agnostic.** Cloudflare first, then Namecheap, then others. Hosting: Vercel first, then Netlify, then direct tunnel.

## Architecture

```
┌──────────────────────────────────────────────────┐
│  User's machine                                   │
│                                                    │
│  tunn3l CLI                                        │
│  ├── ~/.tunn3l/providers.json  (API keys — LOCAL) │
│  ├── Cloudflare API  ←→  direct HTTPS calls       │
│  ├── Namecheap API   ←→  direct HTTPS calls       │
│  ├── Vercel API      ←→  direct HTTPS calls       │
│  └── tunn3l relay    ←→  only for tunnel mode     │
│                                                    │
│  No secrets leave this machine.                    │
└──────────────────────────────────────────────────┘
```

The tunn3l relay's only role is what it does today: proxying HTTP/TCP traffic. It never touches provider APIs or credentials.

## Credential Storage

```json
// ~/.tunn3l/providers.json (local only, never transmitted)
{
  "cloudflare": {
    "api_token": "cf_...",
    "account_id": "abc123"
  },
  "namecheap": {
    "api_user": "myuser",
    "api_key": "nc_...",
    "client_ip": "auto"
  },
  "vercel": {
    "token": "vl_..."
  }
}
```

```bash
# Setup — one time per provider
tunn3l provider add cloudflare --token cf_xxx --account-id abc123
tunn3l provider add vercel --token vl_xxx
tunn3l provider add namecheap --user myuser --key nc_xxx

# Or via env vars (agent-friendly)
TUNN3L_CF_TOKEN=cf_xxx
TUNN3L_CF_ACCOUNT=abc123
TUNN3L_VERCEL_TOKEN=vl_xxx
```

## Commands

### `tunn3l domain search <query>`

Check availability and pricing. Calls provider APIs directly from client.

```bash
$ tunn3l domain search myapp
  myapp.dev       $12.99/yr  available   (cloudflare)
  myapp.com       $9.99/yr   available   (cloudflare)
  myapp.io        $39.99/yr  available   (cloudflare)
  myapp.sh        $24.99/yr  available   (namecheap)
```

```bash
$ tunn3l domain search myapp --json
[{"domain":"myapp.dev","price":12.99,"available":true,"provider":"cloudflare"}, ...]
```

### `tunn3l domain buy <domain>`

Purchase and configure DNS. Direct API call from client to provider.

```bash
$ tunn3l domain buy myapp.dev
  tunn3l: buying myapp.dev on cloudflare... done ($12.99/yr)
  tunn3l: DNS configured
  tunn3l: myapp.dev is yours
```

### `tunn3l domain buy <domain> --tunnel <port>`

Buy + immediately tunnel localhost to it.

```bash
$ tunn3l domain buy myapp.dev --tunnel 3000
  tunn3l: buying myapp.dev on cloudflare... done
  tunn3l: DNS → tunn3l relay
  tunn3l: tunnel ready
  tunn3l: https://myapp.dev → localhost:3000
```

Behind the scenes:
1. CLI calls Cloudflare API to register domain (from client)
2. CLI calls Cloudflare API to set DNS: CNAME → `relay.tunn3l.sh` (from client)
3. CLI opens tunnel to relay with subdomain matching the domain
4. Relay sees the domain in the Host header, routes to the tunnel
5. SSL is handled by Cloudflare (proxy mode) or relay's wildcard cert

### `tunn3l domain buy <domain> --host vercel`

Buy + deploy to Vercel.

```bash
$ tunn3l domain buy myapp.dev --host vercel --dir ./my-site
  tunn3l: buying myapp.dev on cloudflare... done
  tunn3l: DNS → Vercel
  tunn3l: deploying ./my-site to Vercel... done
  tunn3l: https://myapp.dev → Vercel project "my-site"
```

Behind the scenes:
1. CLI calls Cloudflare API to register domain (from client)
2. CLI calls Vercel API to create project + assign domain (from client)
3. CLI calls Cloudflare API to set DNS records per Vercel's requirements (from client)
4. Vercel handles SSL automatically

### `tunn3l domain point <domain> <target>`

Configure an already-owned domain.

```bash
$ tunn3l domain point myapp.dev --tunnel 3000
$ tunn3l domain point myapp.dev --host vercel --dir ./site
$ tunn3l domain point myapp.dev --ip 64.23.144.236
$ tunn3l domain point blog.myapp.dev --host vercel --dir ./blog
```

### `tunn3l domain list`

Show all domains across all configured providers.

```bash
$ tunn3l domain list
  myapp.dev       cloudflare   → tunnel:3000 (this machine)
  blog.myapp.dev  cloudflare   → vercel (my-blog)
  mybox.sh        namecheap    → 64.23.144.236
```

### `tunn3l domain dns <domain>`

Show/manage DNS records.

```bash
$ tunn3l domain dns myapp.dev
  A     @       64.23.144.236
  CNAME www     myapp.dev
  CNAME blog    cname.vercel-dns.com

$ tunn3l domain dns myapp.dev add A api 1.2.3.4
$ tunn3l domain dns myapp.dev rm CNAME blog
```

## How Tunneling Works with Custom Domains

When a user runs `tunn3l domain point myapp.dev --tunnel 3000`:

1. CLI sets DNS: `myapp.dev` CNAME → `relay.tunn3l.sh` (via Cloudflare API, from client)
2. CLI connects to relay with metadata: "I own myapp.dev, tunnel port 3000"
3. Relay registers the custom domain mapping
4. When a request hits the relay for `myapp.dev` (via Host header), relay routes it to the tunnel
5. SSL: Cloudflare proxy mode handles TLS termination, or we add the domain to the relay's cert

**Key constraint:** The relay needs to know about custom domain → tunnel mappings. This is the ONE piece of data that flows through the relay. But no credentials — just "domain X maps to tunnel Y."

## Provider Support Roadmap

### Phase 1: Cloudflare (start here)
- Domain registration
- DNS management
- SSL (automatic via proxy mode)
- Best API of all providers, handles both registration AND DNS

### Phase 2: Vercel
- Project creation
- Domain assignment
- Deploy from directory

### Phase 3: Namecheap
- Domain registration
- DNS management (their API is clunkier but works)

### Phase 4: Others
- DigitalOcean (hosting)
- Netlify (hosting)
- Fly.io (hosting)
- Google Domains / Squarespace (registration)

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Auth error (missing or invalid provider credentials) |
| 2 | Domain unavailable |
| 3 | Purchase failed (payment, rate limit, etc.) |
| 4 | DNS configuration failed |
| 5 | Hosting configuration failed |

## Security Model

- **Provider API keys** never leave `~/.tunn3l/providers.json` or env vars
- **All provider API calls** are made directly from the client to the provider (Cloudflare, Vercel, etc.)
- **The tunn3l relay** only knows domain → tunnel mappings, never credentials
- **File permissions**: `providers.json` is `chmod 600` (owner read/write only)
- **No telemetry**: the CLI doesn't phone home with domain or credential info

## Open Questions

1. **Cloudflare proxy mode vs. relay SSL?** If we use Cloudflare's proxy (orange cloud), SSL is free and automatic. But it means traffic goes Cloudflare → relay → client (extra hop). Direct mode (gray cloud) means we need the domain on the relay's cert.

2. **Payment for domain purchases?** The CLI would need the user's Cloudflare/Namecheap account to have a payment method on file. We can't handle payments ourselves.

3. **Domain renewal?** Auto-renew is typically on by default at registrars. We could add `tunn3l domain renew` but it might be unnecessary.

4. **Subdomain management?** `tunn3l domain point blog.myapp.dev --tunnel 4000` should work for subdomains too. Each subdomain could point to a different machine/port.

5. **Multiple machines?** "Map X subdomain to Y port on Z machine" — the Z machine part means the relay needs to know which tunnel belongs to which machine. Device IDs (already in tunn3l) solve this.
