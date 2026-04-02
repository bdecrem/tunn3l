#!/usr/bin/env node

/**
 * plumb — one-command domain plumbing
 *
 * Usage:
 *   plumb setup                                  # configure API keys
 *   plumb link <domain> --vercel <project>        # link domain to Vercel project
 *   plumb link <domain> --tunnel <port>           # link domain to tunn3l tunnel
 *   plumb link <domain> --ip <address>            # link domain to IP
 *   plumb dns <domain> list                       # list DNS records
 *   plumb dns <domain> add <type> <name> <value>  # add DNS record
 *   plumb dns <domain> rm <id>                    # remove DNS record
 *   plumb status <domain>                         # check domain status
 *
 * Credentials: ~/.plumb/config.json (never transmitted anywhere)
 */

import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'
import readline from 'readline'

const CONFIG_DIR = path.join(process.env.HOME, '.plumb')
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')

// ── Config ──────────────────────────────────────────────

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'))
  } catch {
    return {}
  }
}

function saveConfig(config) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true })
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 })
}

// ── DNS Provider Detection ──────────────────────────────

async function detectDnsProvider(domain) {
  // Get the root domain (strip subdomain)
  const root = getRootDomain(domain)

  // Check NS records
  let ns = ''
  try {
    ns = execSync(`dig +short NS ${root} 2>/dev/null`, { encoding: 'utf-8' }).toLowerCase()
  } catch { /* ignore */ }

  if (ns.includes('cloudflare')) return 'cloudflare'
  if (ns.includes('registrar-servers.com')) return 'namecheap'
  if (ns.includes('namecheap')) return 'namecheap'
  if (ns.includes('domaincontrol')) return 'godaddy'

  // Fallback: try Cloudflare API to see if zone exists
  const config = loadConfig()
  if (config.cloudflare) {
    const zone = await cfGetZone(root, config.cloudflare)
    if (zone) return 'cloudflare'
  }

  return null
}

function getRootDomain(domain) {
  const parts = domain.split('.')
  // Handle TLDs like .co.uk, .com.au — but for simplicity, take last 2 parts
  // For .dev, .com, .sh, .io etc this works fine
  return parts.slice(-2).join('.')
}

function getSubdomain(domain) {
  const root = getRootDomain(domain)
  if (domain === root) return '@'
  return domain.slice(0, -(root.length + 1))
}

// ── Cloudflare API ──────────────────────────────────────

async function cfFetch(endpoint, token, options = {}) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${endpoint}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  })
  const data = await res.json()
  if (!data.success) {
    const msg = data.errors?.map(e => e.message).join(', ') || 'Unknown error'
    throw new Error(`Cloudflare: ${msg}`)
  }
  return data
}

async function cfGetZone(domain, cfConfig) {
  try {
    const data = await cfFetch(`/zones?name=${domain}`, cfConfig.api_token)
    return data.result?.[0] || null
  } catch {
    return null
  }
}

async function cfListRecords(zoneId, token) {
  const data = await cfFetch(`/zones/${zoneId}/dns_records?per_page=100`, token)
  return data.result
}

async function cfAddRecord(zoneId, token, { type, name, content, proxied = false, ttl = 1 }) {
  return cfFetch(`/zones/${zoneId}/dns_records`, token, {
    method: 'POST',
    body: JSON.stringify({ type, name, content, proxied, ttl }),
  })
}

async function cfDeleteRecord(zoneId, token, recordId) {
  return cfFetch(`/zones/${zoneId}/dns_records/${recordId}`, token, {
    method: 'DELETE',
  })
}

// ── Namecheap API ───────────────────────────────────────

async function ncFetch(command, ncConfig, params = {}) {
  // Namecheap requires client IP
  let clientIp = ncConfig.client_ip
  if (!clientIp || clientIp === 'auto') {
    try {
      clientIp = execSync('curl -s https://api.ipify.org', { encoding: 'utf-8' }).trim()
    } catch {
      throw new Error('Could not detect public IP for Namecheap API')
    }
  }

  const base = 'https://api.namecheap.com/xml.response'
  const qs = new URLSearchParams({
    ApiUser: ncConfig.api_user,
    ApiKey: ncConfig.api_key,
    UserName: ncConfig.api_user,
    ClientIp: clientIp,
    Command: command,
    ...params,
  })

  const res = await fetch(`${base}?${qs}`)
  const text = await res.text()

  if (text.includes('Status="ERROR"')) {
    const match = text.match(/<Error[^>]*>(.*?)<\/Error>/s)
    throw new Error(`Namecheap: ${match?.[1] || 'Unknown error'}`)
  }
  return text
}

async function ncGetHosts(domain, ncConfig) {
  const root = getRootDomain(domain)
  const [sld, tld] = root.split('.')
  const xml = await ncFetch('namecheap.domains.dns.getHosts', ncConfig, { SLD: sld, TLD: tld })
  // Parse simple host records from XML
  const records = []
  const re = /<host\s+([^/]*)\/?>/gi
  let m
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1]
    const get = (k) => { const r = new RegExp(`${k}="([^"]*)"`, 'i'); const mm = attrs.match(r); return mm?.[1] || '' }
    records.push({
      id: get('HostId'),
      type: get('Type'),
      name: get('Name'),
      value: get('Address'),
      ttl: get('TTL'),
    })
  }
  return records
}

async function ncSetHosts(domain, ncConfig, records) {
  const root = getRootDomain(domain)
  const [sld, tld] = root.split('.')
  const params = { SLD: sld, TLD: tld }
  records.forEach((r, i) => {
    const n = i + 1
    params[`HostName${n}`] = r.name
    params[`RecordType${n}`] = r.type
    params[`Address${n}`] = r.value
    params[`TTL${n}`] = r.ttl || '1800'
  })
  return ncFetch('namecheap.domains.dns.setHosts', ncConfig, params)
}

// ── Vercel API ──────────────────────────────────────────

async function vercelFetch(endpoint, token, options = {}) {
  const res = await fetch(`https://api.vercel.com${endpoint}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  })
  const data = await res.json()
  if (data.error) throw new Error(`Vercel: ${data.error.message}`)
  return data
}

async function vercelAddDomain(project, domain, token) {
  return vercelFetch(`/v10/projects/${project}/domains`, token, {
    method: 'POST',
    body: JSON.stringify({ name: domain }),
  })
}

async function vercelGetProject(project, token) {
  return vercelFetch(`/v9/projects/${project}`, token)
}

// ── DNS record helpers for Vercel ───────────────────────

function vercelDnsRecords(domain) {
  const sub = getSubdomain(domain)
  if (sub === '@') {
    return [
      { type: 'A', name: '@', value: '76.76.21.21' },
    ]
  } else {
    return [
      { type: 'CNAME', name: sub, value: 'cname.vercel-dns.com' },
    ]
  }
}

// ── Commands ────────────────────────────────────────────

async function cmdSetup() {
  const config = loadConfig()
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const ask = (q) => new Promise(r => rl.question(q, r))

  console.log('\n  plumb setup — configure API keys\n')
  console.log('  Keys are stored in ~/.plumb/config.json (local only)\n')

  // Cloudflare
  const cfToken = await ask('  Cloudflare API token (blank to skip): ')
  if (cfToken.trim()) {
    config.cloudflare = { api_token: cfToken.trim() }
    console.log('  ✓ cloudflare configured')
  }

  // Namecheap
  const ncUser = await ask('  Namecheap API user (blank to skip): ')
  if (ncUser.trim()) {
    const ncKey = await ask('  Namecheap API key: ')
    config.namecheap = { api_user: ncUser.trim(), api_key: ncKey.trim(), client_ip: 'auto' }
    console.log('  ✓ namecheap configured')
  }

  // Vercel
  const vToken = await ask('  Vercel token (blank to skip): ')
  if (vToken.trim()) {
    config.vercel = { token: vToken.trim() }
    console.log('  ✓ vercel configured')
  }

  rl.close()
  saveConfig(config)
  console.log(`\n  saved to ${CONFIG_FILE}\n`)
}

async function cmdLink(domain, args) {
  const config = loadConfig()
  const provider = await detectDnsProvider(domain)

  if (!provider) {
    console.error(`  ✗ could not detect DNS provider for ${domain}`)
    console.error(`    run 'plumb setup' to add provider credentials`)
    process.exit(1)
  }

  console.log(`  domain:   ${domain}`)
  console.log(`  dns:      ${provider}`)

  // Determine target
  const vercelProject = args['--vercel']
  const tunnel = args['--tunnel']
  const ip = args['--ip']

  if (vercelProject) {
    await linkToVercel(domain, vercelProject, provider, config)
  } else if (tunnel) {
    await linkToTunnel(domain, tunnel, provider, config)
  } else if (ip) {
    await linkToIp(domain, ip, provider, config)
  } else {
    console.error('  ✗ specify a target: --vercel <project>, --tunnel <port>, or --ip <address>')
    process.exit(1)
  }
}

async function linkToVercel(domain, project, dnsProvider, config) {
  if (!config.vercel?.token) {
    console.error('  ✗ no vercel token — run plumb setup')
    process.exit(1)
  }

  // 1. Verify project exists
  console.log(`  target:   vercel → ${project}`)
  try {
    await vercelGetProject(project, config.vercel.token)
  } catch (e) {
    console.error(`  ✗ vercel project "${project}" not found: ${e.message}`)
    process.exit(1)
  }

  // 2. Add domain to Vercel
  console.log(`  adding domain to vercel...`)
  try {
    await vercelAddDomain(project, domain, config.vercel.token)
    console.log(`  ✓ domain added to vercel project "${project}"`)
  } catch (e) {
    if (e.message.includes('already')) {
      console.log(`  ✓ domain already on vercel project "${project}"`)
    } else {
      console.error(`  ✗ ${e.message}`)
      process.exit(1)
    }
  }

  // 3. Set DNS records
  const records = vercelDnsRecords(domain)
  await setDnsRecords(domain, dnsProvider, config, records)

  console.log(`\n  ✓ https://${domain} → vercel "${project}"\n`)
}

async function linkToTunnel(domain, port, dnsProvider, config) {
  const relayHost = 'relay.tunn3l.sh'
  console.log(`  target:   tunnel → localhost:${port}`)

  // Set DNS to point to relay
  const sub = getSubdomain(domain)
  const records = sub === '@'
    ? [{ type: 'A', name: '@', value: '64.23.144.236' }]
    : [{ type: 'CNAME', name: sub, value: 'relay.tunn3l.sh' }]

  await setDnsRecords(domain, dnsProvider, config, records)

  console.log(`\n  ✓ DNS configured — now run:`)
  console.log(`    tunn3l http ${port} --subdomain ${domain}\n`)
}

async function linkToIp(domain, ip, dnsProvider, config) {
  console.log(`  target:   ${ip}`)
  const sub = getSubdomain(domain)
  await setDnsRecords(domain, dnsProvider, config, [{ type: 'A', name: sub, value: ip }])
  console.log(`\n  ✓ ${domain} → ${ip}\n`)
}

// ── DNS record setting (provider-agnostic) ──────────────

async function setDnsRecords(domain, provider, config, records) {
  if (provider === 'cloudflare') {
    await setDnsCloudflare(domain, config.cloudflare, records)
  } else if (provider === 'namecheap') {
    await setDnsNamecheap(domain, config.namecheap, records)
  } else {
    console.error(`  ✗ unsupported DNS provider: ${provider}`)
    process.exit(1)
  }
}

async function setDnsCloudflare(domain, cfConfig, records) {
  if (!cfConfig?.api_token) {
    console.error('  ✗ no cloudflare token — run plumb setup')
    process.exit(1)
  }

  const root = getRootDomain(domain)
  const zone = await cfGetZone(root, cfConfig)
  if (!zone) {
    console.error(`  ✗ zone "${root}" not found in cloudflare — add it first`)
    process.exit(1)
  }

  const existing = await cfListRecords(zone.id, cfConfig.api_token)

  for (const rec of records) {
    const name = rec.name === '@' ? root : `${rec.name}.${root}`

    // Check for existing conflicting record
    const conflict = existing.find(e => e.name === name && e.type === rec.type)
    if (conflict) {
      // Update it
      await cfFetch(`/zones/${zone.id}/dns_records/${conflict.id}`, cfConfig.api_token, {
        method: 'PUT',
        body: JSON.stringify({ type: rec.type, name, content: rec.value, proxied: false, ttl: 1 }),
      })
      console.log(`  ✓ updated ${rec.type} ${rec.name} → ${rec.value}`)
    } else {
      await cfAddRecord(zone.id, cfConfig.api_token, { type: rec.type, name, content: rec.value })
      console.log(`  ✓ added ${rec.type} ${rec.name} → ${rec.value}`)
    }
  }
}

async function setDnsNamecheap(domain, ncConfig, newRecords) {
  if (!ncConfig?.api_key) {
    console.error('  ✗ no namecheap credentials — run plumb setup')
    process.exit(1)
  }

  // Namecheap replaces ALL host records at once, so we need to preserve existing ones
  const existing = await ncGetHosts(domain, ncConfig)

  // Merge: replace matching type+name, add new ones
  const merged = [...existing]
  for (const rec of newRecords) {
    const idx = merged.findIndex(e => e.type === rec.type && e.name === rec.name)
    if (idx >= 0) {
      merged[idx] = { ...merged[idx], value: rec.value }
    } else {
      merged.push({ type: rec.type, name: rec.name, value: rec.value, ttl: '1800' })
    }
  }

  await ncSetHosts(domain, ncConfig, merged)
  for (const rec of newRecords) {
    console.log(`  ✓ set ${rec.type} ${rec.name} → ${rec.value}`)
  }
}

// ── DNS list/add/rm commands ────────────────────────────

async function cmdDns(domain, action, args) {
  const config = loadConfig()
  const provider = await detectDnsProvider(domain)

  if (!provider) {
    console.error(`  ✗ could not detect DNS provider for ${domain}`)
    process.exit(1)
  }

  if (action === 'list') {
    if (provider === 'cloudflare') {
      const root = getRootDomain(domain)
      const zone = await cfGetZone(root, config.cloudflare)
      if (!zone) { console.error(`  ✗ zone not found`); process.exit(1) }
      const records = await cfListRecords(zone.id, config.cloudflare.api_token)
      console.log(`\n  DNS records for ${domain} (cloudflare)\n`)
      for (const r of records) {
        console.log(`  ${r.type.padEnd(8)} ${r.name.padEnd(30)} ${r.content}`)
      }
      console.log()
    } else if (provider === 'namecheap') {
      const records = await ncGetHosts(domain, config.namecheap)
      console.log(`\n  DNS records for ${domain} (namecheap)\n`)
      for (const r of records) {
        console.log(`  ${r.type.padEnd(8)} ${r.name.padEnd(30)} ${r.value}`)
      }
      console.log()
    }
  } else if (action === 'add') {
    const [type, name, value] = args
    if (!type || !name || !value) {
      console.error('  usage: plumb dns <domain> add <type> <name> <value>')
      process.exit(1)
    }
    await setDnsRecords(domain, provider, config, [{ type: type.toUpperCase(), name, value }])
  } else if (action === 'rm') {
    const [recordId] = args
    if (provider === 'cloudflare') {
      const root = getRootDomain(domain)
      const zone = await cfGetZone(root, config.cloudflare)
      await cfDeleteRecord(zone.id, config.cloudflare.api_token, recordId)
      console.log(`  ✓ deleted record ${recordId}`)
    } else {
      console.error('  ✗ rm not supported for namecheap (use their dashboard)')
    }
  }
}

async function cmdStatus(domain) {
  const provider = await detectDnsProvider(domain)
  console.log(`\n  ${domain}`)
  console.log(`  dns provider: ${provider || 'unknown'}`)

  // Check if it resolves
  try {
    const ip = execSync(`dig +short A ${domain} 2>/dev/null`, { encoding: 'utf-8' }).trim()
    if (ip) console.log(`  resolves to:  ${ip}`)
    else console.log(`  resolves to:  (nothing)`)
  } catch { /* ignore */ }

  // Check HTTPS
  try {
    const status = execSync(`curl -s -o /dev/null -w "%{http_code}" --max-time 5 https://${domain} 2>/dev/null`, { encoding: 'utf-8' }).trim()
    console.log(`  https:        ${status === '200' ? '✓' : status}`)
  } catch {
    console.log(`  https:        ✗`)
  }

  console.log()
}

// ── Arg parsing ─────────────────────────────────────────

function parseArgs(argv) {
  const positional = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i]
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) {
        flags[key] = next
        i++
      } else {
        flags[key] = true
      }
    } else {
      positional.push(argv[i])
    }
  }
  return { positional, flags }
}

// ── Main ────────────────────────────────────────────────

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2))
  const cmd = positional[0]

  if (!cmd || cmd === 'help' || flags['--help']) {
    console.log(`
  plumb — one-command domain plumbing

  setup                                    configure API keys
  link <domain> --vercel <project>         link domain to Vercel project
  link <domain> --tunnel <port>            link domain to tunn3l tunnel
  link <domain> --ip <address>             link domain to IP address
  dns <domain> list                        list DNS records
  dns <domain> add <type> <name> <value>   add a DNS record
  dns <domain> rm <id>                     remove a DNS record (cloudflare only)
  status <domain>                          check domain status
`)
    return
  }

  if (cmd === 'setup') {
    await cmdSetup()
  } else if (cmd === 'link') {
    const domain = positional[1]
    if (!domain) { console.error('  usage: plumb link <domain> --vercel <project>'); process.exit(1) }
    await cmdLink(domain, flags)
  } else if (cmd === 'dns') {
    const domain = positional[1]
    const action = positional[2]
    if (!domain || !action) { console.error('  usage: plumb dns <domain> list'); process.exit(1) }
    await cmdDns(domain, action, positional.slice(3))
  } else if (cmd === 'status') {
    await cmdStatus(positional[1])
  } else {
    console.error(`  unknown command: ${cmd}`)
    process.exit(1)
  }
}

main().catch(e => {
  console.error(`  ✗ ${e.message}`)
  process.exit(1)
})
