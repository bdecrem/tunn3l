# plumb — API Key Setup

## Cloudflare

### Create an API token

1. Go to **dash.cloudflare.com**
2. Click your profile icon (top right) → **My Profile**
3. Click **API Tokens** in the left sidebar
4. Click **Create Token**
5. Click **Create Custom Token** (at the bottom, not one of the templates)
6. Configure:
   - **Token name:** `plumb` (or whatever you want)
   - **Permissions:**
     - `Zone` → `DNS` → `Edit`
     - `Zone` → `Zone` → `Read`
   - **Zone Resources:** `Include` → `All zones` (or pick specific zones)
7. Click **Continue to summary** → **Create Token**
8. Copy the token — you won't see it again

### Where to find your Account ID

1. Go to **dash.cloudflare.com**
2. Click any domain
3. Scroll down on the right sidebar — **Account ID** is listed there

You don't need the Account ID for plumb — just the API token.

### Moving a domain's DNS to Cloudflare

If your domain is registered on Namecheap (or anywhere else) but you want Cloudflare to handle DNS:

1. On Cloudflare: **Add a site** → enter your domain → select **Free** plan
2. Cloudflare will give you two nameservers (e.g. `ada.ns.cloudflare.com`, `bert.ns.cloudflare.com`)
3. On Namecheap: go to the domain → **Nameservers** → switch from "Namecheap BasicDNS" to **Custom DNS** → paste the two Cloudflare nameservers
4. Wait 5-30 minutes for propagation
5. Cloudflare will confirm the domain is active

After this, plumb manages all DNS through Cloudflare regardless of where you bought the domain.

---

## Namecheap

### Enable API access

**Requirements:** Your account must have at least $50 on file OR 20+ domains. If you don't meet this, skip Namecheap and use Cloudflare for DNS instead (see above).

1. Go to **namecheap.com** → log in
2. Click your username (top right) → **Profile**
3. Click **Tools** in the left sidebar
4. Scroll to **Namecheap API Access**
5. Toggle **ON**
6. Your **API Key** will appear — copy it

### Whitelist your IP

Namecheap requires you to whitelist your public IP address:

1. On the same API Access page, find **Whitelisted IPs**
2. Add your current public IP (find it at **whatismyip.com**)
3. If your IP changes (e.g. home internet), you'll need to update this

**Note:** This is a pain. If you're on a dynamic IP, consider using Cloudflare DNS instead — no IP whitelisting required.

### API user

Your API user is just your Namecheap username (the one you log in with).

---

## Vercel

### Create a token

**Important:** Tokens are in your *personal* account settings, not the team settings.

1. Go to **vercel.com** → log in
2. Click your name/avatar at the **bottom left** of the sidebar
3. Click **Account Settings** (not team settings — that's different)
4. Click **Tokens** in the left sidebar
5. Click **Create**
6. Configure:
   - **Name:** `plumb`
   - **Scope:** `Full Account` (or scope to specific projects if you prefer)
   - **Expiration:** `No expiration` (or set one if you want to rotate it)
7. Click **Create Token**
8. Copy the token — you won't see it again

**Common mistake:** If you click Settings from the team dashboard, you'll see team settings (General, Billing, Members, etc.) — there's no Tokens page there. You need to go to your *personal* account settings via the avatar at the bottom left.

---

## Configure plumb

Run:

```bash
node plumb.js setup
```

Or set environment variables:

```bash
export PLUMB_CF_TOKEN=cfat_xxx
export PLUMB_VERCEL_TOKEN=vl_xxx
export PLUMB_NC_USER=myuser
export PLUMB_NC_KEY=xxx
```

Or edit `~/.plumb/config.json` directly:

```json
{
  "cloudflare": { "api_token": "cfat_xxx" },
  "vercel": { "token": "vl_xxx" },
  "namecheap": { "api_user": "myuser", "api_key": "xxx", "client_ip": "auto" }
}
```

You only need the providers you use. If all your DNS is on Cloudflare, skip Namecheap.
