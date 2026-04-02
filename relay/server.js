/**
 * TUNN3L Relay Server
 *
 * HTTP server that upgrades to WebSocket at /ws/connect (tunnel control)
 * and /ws/tcp (inbound TCP proxy connections for SSH/TCP tunnels).
 * Maps subdomains to active WebSocket tunnels and relays HTTP or TCP traffic.
 */

import http from 'http'
import net from 'net'
import { WebSocketServer } from 'ws'
import crypto from 'crypto'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { initDb, upsertSubdomain, recordConnect, recordDisconnect, isSubdomainReserved, getDeviceSubdomain, registerDevice, getReservedSubdomains, isSubdomainReservedByOther, getTokenInfo, claimToken, reserveSubdomain, unreserveSubdomain } from './db.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

let INSTALL_SCRIPT
try {
  INSTALL_SCRIPT = readFileSync(join(__dirname, 'install.sh'), 'utf-8')
} catch {
  INSTALL_SCRIPT = '#!/bin/sh\necho "Install script not found. Visit https://tunn3l.sh for instructions."\nexit 1\n'
}

const PORT = parseInt(process.env.PORT || '4040')
const BASE_DOMAIN = process.env.BASE_DOMAIN || 'localhost'
const MAX_REQUEST_BODY = 50 * 1024 * 1024 // 50MB max request body
const MAX_TUNNELS_PER_TOKEN = 20 // max concurrent tunnels per token
const SUBDOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/ // valid subdomain format

// Registry: subdomain → { ws, mode, pending, tcpStreams, tcpPort, requestCount, connectionId, token }
// mode: "http" (default) or "tcp"
// tcpStreams: Map<streamId, socket> — only used in tcp mode
// tcpPort: assigned external port for TCP tunnels
const tunnels = new Map()

// Track tunnels per token for rate limiting
const tunnelsPerToken = new Map() // token → Set<subdomain>

// Port registry: port → subdomain (for TCP port routing)
const portToSubdomain = new Map()
const TCP_PORT_MIN = 10000
const TCP_PORT_MAX = 60000

function assignTcpPort() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const port = TCP_PORT_MIN + Math.floor(Math.random() * (TCP_PORT_MAX - TCP_PORT_MIN))
    if (!portToSubdomain.has(port)) return port
  }
  return null
}

// Per-tunnel TCP listeners: port → net.Server
const tcpListeners = new Map()

function generateId() {
  return crypto.randomBytes(8).toString('hex') // 16-char hex = 64 bits
}

import { ADJECTIVES, NOUNS } from './words.js'

function generateSubdomain() {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)]
  return `${adj}-${noun}`
}

function extractSubdomain(host) {
  if (!host) return null
  // Remove port
  const hostname = host.split(':')[0]
  // Check if it's a subdomain of BASE_DOMAIN
  if (hostname.endsWith(`.${BASE_DOMAIN}`)) {
    return hostname.slice(0, -(BASE_DOMAIN.length + 1))
  }
  // For local testing: subdomain.localhost
  if (hostname.endsWith('.localhost')) {
    return hostname.slice(0, -'.localhost'.length)
  }
  return null
}

// WebSocket servers: control (tunnel registration) and tcp (proxy connections)
const server = http.createServer()
const wss = new WebSocketServer({ noServer: true })
const wssTcp = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  if (url.pathname === '/ws/connect') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req)
    })
  } else if (url.pathname === '/ws/tcp') {
    wssTcp.handleUpgrade(req, socket, head, (ws) => {
      wssTcp.emit('connection', ws, req)
    })
  } else {
    socket.destroy()
  }
})

wss.on('connection', (ws) => {
  let registeredSubdomain = null

  ws.on('message', async (data, isBinary) => {
    // Binary frames: TCP data from CLI → proxy
    if (isBinary) {
      const buf = Buffer.from(data)
      if (buf.length < 16 || !registeredSubdomain) return
      const streamId = buf.subarray(0, 16).toString('ascii')
      const payload = buf.subarray(16)
      const tunnel = tunnels.get(registeredSubdomain)
      if (!tunnel) return
      const stream = tunnel.tcpStreams.get(streamId)
      if (!stream) return
      // WebSocket proxy stream
      if (stream.send && stream.readyState === stream.OPEN) {
        stream.send(payload)
      }
      // Raw TCP socket
      else if (stream.write && !stream.destroyed) {
        stream.write(payload)
      }
      return
    }

    // JSON messages: control protocol
    let msg
    try {
      msg = JSON.parse(data.toString())
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }))
      return
    }

    if (msg.type === 'register') {
      const token = msg.token || null
      const deviceId = msg.device_id || null
      const mode = msg.mode === 'tcp' ? 'tcp' : 'http'

      // Register device if token + device_id provided
      if (token && deviceId) {
        registerDevice(token, deviceId, msg.hostname, msg.os)
          .catch(err => console.error('[DB]', err.message))
      }

      // Per-token concurrent tunnel limit
      if (token) {
        const active = tunnelsPerToken.get(token)
        if (active && active.size >= MAX_TUNNELS_PER_TOKEN) {
          console.log(`[AUTH] Token ${token.slice(0, 8)}... exceeded max tunnels (${MAX_TUNNELS_PER_TOKEN})`)
          ws.send(JSON.stringify({ type: 'error', code: 5, message: `Too many active tunnels (max ${MAX_TUNNELS_PER_TOKEN})` }))
          return
        }
      }

      // Resolve subdomain: explicit > device reservation > random
      let subdomain = msg.subdomain ? msg.subdomain.toLowerCase() : null

      // Validate subdomain format if explicitly requested
      if (subdomain && !SUBDOMAIN_RE.test(subdomain)) {
        ws.send(JSON.stringify({ type: 'error', code: 6, message: 'Invalid subdomain. Use lowercase letters, numbers, and hyphens (max 63 chars).' }))
        return
      }

      if (!subdomain && token && deviceId) {
        try {
          subdomain = await getDeviceSubdomain(token, deviceId)
          if (subdomain) console.log(`[TUNNEL] Auto-assigned reserved subdomain '${subdomain}' for device ${deviceId}`)
        } catch (err) {
          console.error('[DB]', err.message)
        }
      }
      if (!subdomain) subdomain = generateSubdomain()

      // Check if subdomain is currently active
      if (tunnels.has(subdomain)) {
        ws.send(JSON.stringify({ type: 'error', code: 3, message: `Subdomain '${subdomain}' is already in use` }))
        return
      }

      // Check if subdomain is reserved by someone else
      try {
        const reservation = await isSubdomainReserved(subdomain)
        if (reservation.reserved) {
          if (!token || token !== reservation.owner_token) {
            console.log(`[AUTH] Rejected: token ${token ? token.slice(0, 8) + '...' : 'none'} tried reserved subdomain '${subdomain}' (device: ${deviceId || 'none'}, ip: ${ws._socket?.remoteAddress})`)
            ws.send(JSON.stringify({ type: 'error', code: 4, message: `Subdomain '${subdomain}' is reserved by another account` }))
            return
          }
          if (reservation.device_id && deviceId && deviceId !== reservation.device_id) {
            console.log(`[AUTH] Rejected: device ${deviceId} tried subdomain '${subdomain}' reserved for ${reservation.device_id} (token: ${token.slice(0, 8)}..., ip: ${ws._socket?.remoteAddress})`)
            ws.send(JSON.stringify({ type: 'error', code: 4, message: `Subdomain '${subdomain}' is reserved for a different device` }))
            return
          }
        }
      } catch (err) {
        console.error('[DB] Reservation check failed:', err.message)
        // Allow through if DB is down — don't block tunnels
      }

      registeredSubdomain = subdomain
      const tunnel = { ws, mode, pending: new Map(), tcpStreams: new Map(), requestCount: 0, connectionId: null }

      if (mode === 'tcp') {
        const tcpPort = assignTcpPort()
        if (!tcpPort) {
          ws.send(JSON.stringify({ type: 'error', message: 'No TCP ports available' }))
          return
        }
        tunnel.tcpPort = tcpPort
        portToSubdomain.set(tcpPort, subdomain)
      }

      tunnel.token = token
      tunnels.set(subdomain, tunnel)

      // Track per-token tunnel count
      if (token) {
        if (!tunnelsPerToken.has(token)) tunnelsPerToken.set(token, new Set())
        tunnelsPerToken.get(token).add(subdomain)
      }

      // Start TCP listener for this tunnel
      if (mode === 'tcp' && tunnel.tcpPort) {
        startTcpListener(tunnel.tcpPort, subdomain)
      }

      const url = `https://${subdomain}.${BASE_DOMAIN}`
      const response = { type: 'registered', subdomain, url, mode }
      if (tunnel.tcpPort) {
        response.tcpPort = tunnel.tcpPort
        response.tcpHost = BASE_DOMAIN
      }

      ws.send(JSON.stringify(response))
      console.log(`[TUNNEL] ${subdomain} registered (${mode}${tunnel.tcpPort ? ` port:${tunnel.tcpPort}` : ''}${token ? ` token:${token.slice(0, 8)}...` : ''})`)

      // Fire-and-forget: persist to Supabase
      upsertSubdomain(subdomain)
        .then(() => recordConnect(subdomain, ws._socket?.remoteAddress))
        .then(connId => { tunnel.connectionId = connId })
        .catch(err => console.error('[DB]', err.message))
    }

    if (msg.type === 'response') {
      // Client sending back a response to a relayed request
      if (!registeredSubdomain) return
      const tunnel = tunnels.get(registeredSubdomain)
      if (!tunnel) return

      const pending = tunnel.pending.get(msg.requestId)
      if (!pending) return

      clearTimeout(pending.timer)
      tunnel.pending.delete(msg.requestId)

      const res = pending.res
      res.writeHead(msg.statusCode || 200, msg.headers || {})
      if (msg.body) {
        const buf = Buffer.from(msg.body, msg.encoding || 'utf-8')
        res.end(buf)
      } else {
        res.end()
      }
    }

    if (msg.type === 'tcp-ready') {
      // CLI connected to local port, start relaying
      if (!registeredSubdomain) return
      const tunnel = tunnels.get(registeredSubdomain)
      if (!tunnel) return
      const stream = tunnel.tcpStreams.get(msg.streamId)
      if (!stream) return

      if (stream._buffered) {
        // WebSocket proxy stream (from tunn3l proxy)
        for (const buf of stream._buffered) {
          const frame = Buffer.alloc(16 + buf.length)
          frame.write(msg.streamId, 0, 16, 'ascii')
          buf.copy(frame, 16)
          ws.send(frame)
        }
        stream._buffered = null
      } else if (stream._tcpBuffered) {
        // Raw TCP socket stream (from direct SSH)
        clearTimeout(stream._readyTimer)
        stream._waitingForReady = false
        stream._paused = false
        for (const buf of stream._tcpBuffered) {
          const frame = Buffer.alloc(16 + buf.length)
          frame.write(msg.streamId, 0, 16, 'ascii')
          buf.copy(frame, 16)
          ws.send(frame)
        }
        stream._tcpBuffered = null
        stream.resume()
      }
      console.log(`[TCP] ${registeredSubdomain} stream ${msg.streamId} ready`)
    }

    if (msg.type === 'tcp-error' || msg.type === 'tcp-close') {
      if (!registeredSubdomain) return
      const tunnel = tunnels.get(registeredSubdomain)
      if (!tunnel) return
      const stream = tunnel.tcpStreams.get(msg.streamId)
      if (stream) {
        if (stream.close) stream.close()
        else if (stream.destroy) stream.destroy()
        tunnel.tcpStreams.delete(msg.streamId)
      }
    }

    if (msg.type === 'pong') {
      // Keepalive response, nothing to do
    }
  })

  ws.on('close', () => {
    if (registeredSubdomain) {
      const tunnel = tunnels.get(registeredSubdomain)
      if (tunnel) {
        // Reject all pending HTTP requests
        for (const [, pending] of tunnel.pending) {
          clearTimeout(pending.timer)
          pending.res.writeHead(502)
          pending.res.end('Tunnel disconnected')
        }
        // Close all TCP proxy connections
        for (const [, stream] of tunnel.tcpStreams) {
          if (stream.close) stream.close()
          else if (stream.destroy) stream.destroy()
        }
        tunnel.tcpStreams.clear()
        // Release TCP port and stop listener
        if (tunnel.tcpPort) {
          stopTcpListener(tunnel.tcpPort)
          portToSubdomain.delete(tunnel.tcpPort)
        }
        // Fire-and-forget: record disconnect
        if (tunnel.connectionId) {
          recordDisconnect(tunnel.connectionId, { requestsServed: tunnel.requestCount || 0 })
            .catch(err => console.error('[DB]', err.message))
        }
        // Clean up per-token tracking
        if (tunnel.token) {
          const active = tunnelsPerToken.get(tunnel.token)
          if (active) {
            active.delete(registeredSubdomain)
            if (active.size === 0) tunnelsPerToken.delete(tunnel.token)
          }
        }
        tunnels.delete(registeredSubdomain)
      }
      console.log(`[TUNNEL] ${registeredSubdomain} disconnected`)
    }
  })

  // Keepalive ping every 30s
  const pingInterval = setInterval(() => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'ping' }))
    } else {
      clearInterval(pingInterval)
    }
  }, 30000)

  ws.on('close', () => clearInterval(pingInterval))
})

// TCP proxy connections — inbound from `tunn3l proxy` (SSH clients)
wssTcp.on('connection', (proxyWs, req) => {
  const subdomain = extractSubdomain(req.headers.host)
  if (!subdomain) {
    proxyWs.close()
    return
  }

  const tunnel = tunnels.get(subdomain)
  if (!tunnel || tunnel.mode !== 'tcp') {
    proxyWs.close()
    return
  }

  const streamId = generateId() // 16-char hex
  tunnel.tcpStreams.set(streamId, proxyWs)
  proxyWs._buffered = [] // buffer data until CLI sends tcp-ready

  // Tell CLI: new TCP connection arrived
  tunnel.ws.send(JSON.stringify({ type: 'tcp-open', streamId }))

  // Timeout if CLI doesn't respond with tcp-ready
  const readyTimer = setTimeout(() => {
    if (proxyWs._buffered !== null) {
      proxyWs.close()
      tunnel.tcpStreams.delete(streamId)
      tunnel.ws.send(JSON.stringify({ type: 'tcp-close', streamId }))
    }
  }, 10000)

  // Data from proxy (SSH client) → relay → CLI
  proxyWs.on('message', (data) => {
    const buf = Buffer.from(data)
    if (proxyWs._buffered !== null) {
      // Still waiting for tcp-ready, buffer the data
      proxyWs._buffered.push(buf)
      return
    }
    // Forward to CLI as binary frame: [streamId][payload]
    const frame = Buffer.alloc(16 + buf.length)
    frame.write(streamId, 0, 16, 'ascii')
    buf.copy(frame, 16)
    tunnel.ws.send(frame)
  })

  proxyWs.on('close', () => {
    clearTimeout(readyTimer)
    tunnel.tcpStreams.delete(streamId)
    if (tunnel.ws.readyState === tunnel.ws.OPEN) {
      tunnel.ws.send(JSON.stringify({ type: 'tcp-close', streamId }))
    }
  })

  console.log(`[TCP] ${subdomain} stream ${streamId} opened`)
})

// HTTP request handler — relay to tunnel
server.on('request', async (req, res) => {
  const subdomain = extractSubdomain(req.headers.host)

  // Health check / root / install
  if (!subdomain || subdomain === 'www') {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, tunnels: tunnels.size }))
      return
    }

    if (req.url === '/install') {
      res.writeHead(200, { 'Content-Type': 'text/x-shellscript' })
      res.end(INSTALL_SCRIPT)
      return
    }

    // API: get token info
    if (req.url.startsWith('/api/token-info')) {
      const token = new URL(req.url, 'http://localhost').searchParams.get('token')
      if (!token) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'token required' })); return }
      try {
        const info = await getTokenInfo(token)
        const subdomains = await getReservedSubdomains(token)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ claimed: !!(info && info.claimed_at), email: info?.email, subdomains }))
      } catch (err) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: err.message })) }
      return
    }

    // API: list active tunnels for a token
    if (req.url.startsWith('/api/tunnels')) {
      const token = new URL(req.url, 'http://localhost').searchParams.get('token')
      if (!token) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'token required' })); return }
      const active = []
      for (const [sub, tunnel] of tunnels) {
        if (tunnel.token === token) {
          active.push({ subdomain: sub, url: `https://${sub}.${BASE_DOMAIN}`, mode: tunnel.mode, tcpPort: tunnel.tcpPort || null, device_id: tunnel.deviceId || null })
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ tunnels: active }))
      return
    }

    // API: kill a tunnel
    if (req.url === '/api/kill' && req.method === 'POST') {
      const chunks = []
      req.on('data', c => chunks.push(c))
      req.on('end', () => {
        try {
          const { token, subdomain } = JSON.parse(Buffer.concat(chunks).toString())
          if (!token || !subdomain) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'token and subdomain required' })); return }
          const tunnel = tunnels.get(subdomain)
          if (!tunnel || tunnel.token !== token) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'tunnel not found or not owned by this token' })); return }
          tunnel.ws.close()
          res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, subdomain }))
        } catch (err) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: err.message })) }
      })
      return
    }

    // API: claim a token
    if (req.url === '/api/claim' && req.method === 'POST') {
      const chunks = []
      req.on('data', c => chunks.push(c))
      req.on('end', async () => {
        try {
          const { token, email } = JSON.parse(Buffer.concat(chunks).toString())
          if (!token || !email) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'token and email required' })); return }
          const result = await claimToken(token, email)
          res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, claimed_at: result.claimed_at }))
        } catch (err) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: err.message })) }
      })
      return
    }

    // API: reserve a subdomain
    if (req.url === '/api/reserve' && req.method === 'POST') {
      const chunks = []
      req.on('data', c => chunks.push(c))
      req.on('end', async () => {
        try {
          const { token, subdomain: sub, device_id } = JSON.parse(Buffer.concat(chunks).toString())
          if (!token || !sub) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'token and subdomain required' })); return }
          if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(sub) || sub.length > 63) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Invalid subdomain format' })); return }
          if (await isSubdomainReservedByOther(sub, token)) { res.writeHead(409, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Subdomain reserved by another user' })); return }
          await reserveSubdomain(token, sub, device_id)
          res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, subdomain: sub }))
        } catch (err) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: err.message })) }
      })
      return
    }

    // API: unreserve a subdomain
    if (req.url === '/api/unreserve' && req.method === 'POST') {
      const chunks = []
      req.on('data', c => chunks.push(c))
      req.on('end', async () => {
        try {
          const { token, subdomain: sub } = JSON.parse(Buffer.concat(chunks).toString())
          if (!token || !sub) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'token and subdomain required' })); return }
          await unreserveSubdomain(token, sub)
          res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }))
        } catch (err) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: err.message })) }
      })
      return
    }

    // Claim redirect → dashboard
    if (req.url.startsWith('/claim/')) {
      const key = req.url.slice(7)
      res.writeHead(302, { Location: `/dashboard?key=${encodeURIComponent(key)}` })
      res.end()
      return
    }

    // Features page
    if (req.url === '/features') {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>tunn3l.sh — features</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
html{overflow-x:hidden;background:#1a1a18}
body{font-family:system-ui,-apple-system,sans-serif;background:linear-gradient(180deg,#1a1a18,#2a2218);color:#fff;min-height:100dvh;overflow-x:hidden;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)}
.container{max-width:720px;margin:0 auto;padding:60px 24px}
a{color:#FC913A;text-decoration:none}
a:hover{text-decoration:underline}
h1{font-size:2.5rem;font-weight:800;letter-spacing:-0.02em;margin-bottom:8px}
h1 .ext{color:rgba(255,255,255,0.35)}
.back{font-family:monospace;font-size:0.8rem;color:rgba(255,255,255,0.3);margin-bottom:48px;display:block}
.back:hover{color:rgba(255,255,255,0.6)}
h2{font-size:1.4rem;font-weight:700;margin:48px 0 8px;letter-spacing:-0.01em}
h2:first-of-type{margin-top:0}
.lead{color:rgba(255,255,255,0.4);font-size:1rem;margin-bottom:32px;line-height:1.6}
p{color:rgba(255,255,255,0.5);font-size:0.9rem;line-height:1.7;margin-bottom:16px}
.terminal{background:#0a0a08;border:1px solid rgba(255,255,255,0.1);border-radius:12px;overflow:hidden;margin:16px 0 24px}
.terminal-bar{background:rgba(255,255,255,0.05);padding:8px 16px;display:flex;gap:6px}
.dot{width:10px;height:10px;border-radius:50%;opacity:0.5}
.terminal pre{padding:20px;font-family:monospace;font-size:0.85rem;line-height:1.8;overflow-x:auto}
.cmd{color:#FFF8E7}
.ok{color:#B4E33D}
.url{color:#FC913A}
.dim{color:#555}
.divider{border:none;border-top:1px solid rgba(255,255,255,0.06);margin:48px 0}
.footer{border-top:1px solid rgba(255,255,255,0.05);padding-top:24px;margin-top:64px;color:rgba(255,255,255,0.15);font-size:0.75rem;font-family:monospace}
.footer a{color:rgba(255,255,255,0.25)}
</style>
</head>
<body>
<div class="container">

<a href="/" class="back">\u2190 tunn3l.sh</a>

<h1>Features</h1>
<p class="lead">Everything tunn3l does, from one-liners to always-on tunnels with permanent URLs.</p>

<h2>One-command install</h2>
<p>A single curl downloads a standalone binary. No Node, no Python, no Docker, no package manager. Works on macOS and Linux, ARM and x64.</p>
<div class="terminal">
<div class="terminal-bar"><div class="dot" style="background:#FF4E50"></div><div class="dot" style="background:#F9D423"></div><div class="dot" style="background:#B4E33D"></div></div>
<pre><span class="dim">$</span> <span class="cmd">curl -sSf https://tunn3l.sh/install | sh</span>
<span class="ok">tunn3l installed! Open a new terminal, then:</span>
  tunn3l http 3000</pre>
</div>

<h2>HTTP tunnels</h2>
<p>Expose any local port to the internet. Your dev server, your API, your webhook receiver \u2014 instantly reachable at a <code style="background:rgba(255,255,255,0.08);padding:2px 6px;border-radius:4px">*.tunn3l.sh</code> URL.</p>
<div class="terminal">
<div class="terminal-bar"><div class="dot" style="background:#FF4E50"></div><div class="dot" style="background:#F9D423"></div><div class="dot" style="background:#B4E33D"></div></div>
<pre><span class="dim">$</span> <span class="cmd">tunn3l http 3000</span>

  <span class="ok">tunn3l tunnel ready</span>

  forwarding  <span class="url">https://glass-moss.tunn3l.sh</span> \u2192 http://localhost:3000</pre>
</div>

<h2>SSH &amp; TCP tunnels</h2>
<p>Expose SSH, databases, or any TCP service. Each tunnel gets its own port on the relay. Connect from anywhere without VPNs or firewall changes.</p>
<div class="terminal">
<div class="terminal-bar"><div class="dot" style="background:#FF4E50"></div><div class="dot" style="background:#F9D423"></div><div class="dot" style="background:#B4E33D"></div></div>
<pre><span class="dim">$</span> <span class="cmd">tunn3l ssh</span>

  <span class="ok">tunn3l tcp tunnel ready</span>

  forwarding  <span class="url">https://my-box.tunn3l.sh</span> \u2192 tcp://localhost:22
  connect:    ssh user@tunn3l.sh -p 34821</pre>
</div>

<h2>Always-on daemon</h2>
<p>Install tunn3l as a system service. It starts on boot, reconnects automatically, and stays up forever. One command to install, one to start.</p>
<div class="terminal">
<div class="terminal-bar"><div class="dot" style="background:#FF4E50"></div><div class="dot" style="background:#F9D423"></div><div class="dot" style="background:#B4E33D"></div></div>
<pre><span class="dim">$</span> <span class="cmd">tunn3l daemon install --port 3000 --subdomain my-server</span>
  tunn3l daemon "default" installed

<span class="dim">$</span> <span class="cmd">tunn3l daemon start</span>
  tunn3l daemon "default" started

  forwarding  <span class="url">https://my-server.tunn3l.sh</span></pre>
</div>
<p>Uses launchd on macOS, systemd on Linux. Check on it anytime with <code style="background:rgba(255,255,255,0.08);padding:2px 6px;border-radius:4px">tunn3l daemon status</code>.</p>

<hr class="divider">

<h2>Permanent URLs</h2>
<p>Reserve a subdomain and it's yours. Every time your tunnel connects, it gets the same name \u2014 no more random URLs that change on every restart.</p>
<p>Reserve subdomains from the <a href="/dashboard">dashboard</a> or let your daemon config lock one in with <code style="background:rgba(255,255,255,0.08);padding:2px 6px;border-radius:4px">--subdomain</code>.</p>

<h2>Multi-device, one account</h2>
<p>Install tunn3l on every machine with the same API key. Each device gets its own reserved subdomain, all managed from one dashboard.</p>
<div class="terminal">
<div class="terminal-bar"><div class="dot" style="background:#FF4E50"></div><div class="dot" style="background:#F9D423"></div><div class="dot" style="background:#B4E33D"></div></div>
<pre><span class="dim"># On your second machine:</span>
<span class="dim">$</span> <span class="cmd">curl -sSf https://tunn3l.sh/install | sh -s -- --key tk_your_key</span>
<span class="dim">$</span> <span class="cmd">tunn3l daemon install --port 3000 --subdomain my-laptop</span>
<span class="dim">$</span> <span class="cmd">tunn3l daemon start</span>

  forwarding  <span class="url">https://my-laptop.tunn3l.sh</span></pre>
</div>

<h2>Dashboard</h2>
<p>See all your active tunnels, reserve and release subdomains, claim your account \u2014 all from <a href="/dashboard">tunn3l.sh/dashboard</a>. No signup required to start. Claim with an email whenever you're ready.</p>

<h2>Built for AI agents</h2>
<p>Every command supports <code style="background:rgba(255,255,255,0.08);padding:2px 6px;border-radius:4px">--json</code> for machine-readable output. Clean exit codes (0 = clean, 1 = auth, 2 = connection, 3 = subdomain taken). Fully configurable via environment variables. Zero interactive prompts \u2014 agents can install, connect, and manage tunnels without human intervention.</p>
<div class="terminal">
<div class="terminal-bar"><div class="dot" style="background:#FF4E50"></div><div class="dot" style="background:#F9D423"></div><div class="dot" style="background:#B4E33D"></div></div>
<pre><span class="dim">$</span> <span class="cmd">tunn3l http 3000 --json</span>
<span class="dim">{"url":"https://glass-moss.tunn3l.sh","subdomain":"glass-moss"}</span></pre>
</div>

<h2>CLI management commands</h2>
<p>Everything you can do in the dashboard, you can do from the terminal. No browser needed.</p>
<div class="terminal">
<div class="terminal-bar"><div class="dot" style="background:#FF4E50"></div><div class="dot" style="background:#F9D423"></div><div class="dot" style="background:#B4E33D"></div></div>
<pre><span class="dim">$</span> <span class="cmd">tunn3l status</span>

  API key:  tk_d99c...
  claimed:  you@example.com

  Reserved subdomains:
    my-server.tunn3l.sh
    my-laptop.tunn3l.sh

  Active tunnels:
    <span class="url">https://my-server.tunn3l.sh</span>  (http)

<span class="dim">$</span> <span class="cmd">tunn3l reserve my-new-box</span>
  Reserved: <span class="url">my-new-box.tunn3l.sh</span>

<span class="dim">$</span> <span class="cmd">tunn3l unreserve my-new-box</span>
  Released: my-new-box.tunn3l.sh

<span class="dim">$</span> <span class="cmd">tunn3l claim you@example.com</span>
  Account claimed: you@example.com

<span class="dim">$</span> <span class="cmd">tunn3l status --json</span>
<span class="dim">{"api_key":"tk_d99c...","claimed":true,...}</span></pre>
</div>
<p>The <code style="background:rgba(255,255,255,0.08);padding:2px 6px;border-radius:4px">--json</code> flag on <code style="background:rgba(255,255,255,0.08);padding:2px 6px;border-radius:4px">status</code> returns structured data \u2014 perfect for agents that need to read account state programmatically.</p>

<hr class="divider">

<h2>API key flexibility</h2>
<p>Your API key lives in <code style="background:rgba(255,255,255,0.08);padding:2px 6px;border-radius:4px">~/.tunn3l/config.json</code> by default. Move it to an environment variable or a dotenv file if you prefer:</p>
<div class="terminal">
<div class="terminal-bar"><div class="dot" style="background:#FF4E50"></div><div class="dot" style="background:#F9D423"></div><div class="dot" style="background:#B4E33D"></div></div>
<pre><span class="dim">// ~/.tunn3l/config.json</span>
{
  <span class="url">"api_key_source"</span>: <span class="ok">"env:TUNN3L_API_KEY"</span>
}

<span class="dim">// or read from a file:</span>
{
  <span class="url">"api_key_source"</span>: <span class="ok">"file:~/.env.local:TUNN3L_API_KEY"</span>
}</pre>
</div>

<h2>Open source</h2>
<p>MIT licensed. The relay, the CLI, the installer \u2014 everything is on <a href="https://github.com/bdecrem/hilma/tree/main/apps/tunnel" target="_blank">GitHub</a>. Run your own relay if you want. Point the CLI at it with <code style="background:rgba(255,255,255,0.08);padding:2px 6px;border-radius:4px">--relay wss://your-server/ws/connect</code>.</p>

<div class="footer">
<a href="/">\u2190 back to tunn3l.sh</a>
</div>

</div>
</body>
</html>`)
      return
    }

    // Dashboard
    if (req.url.startsWith('/dashboard')) {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>tunn3l — dashboard</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui,-apple-system,sans-serif;background:linear-gradient(135deg,#FFF5E6,#FFFDE7,#FFF0F0);min-height:100vh;color:#292524}
.wrap{max-width:640px;margin:0 auto;padding:48px 24px}
h1{font-size:2rem;font-weight:800;letter-spacing:-0.02em}
.sub{font-size:.85rem;color:#a8a29e;font-family:monospace;margin-top:4px;margin-bottom:32px}
.card{background:rgba(255,255,255,0.7);backdrop-filter:blur(8px);border:1px solid #e7e5e4;border-radius:16px;padding:24px;margin-bottom:16px}
.card h2{font-size:1.1rem;font-weight:600;margin-bottom:12px}
.card p{font-size:.85rem;color:#78716c;margin-bottom:12px;line-height:1.5}
.row{display:flex;align-items:center;justify-content:space-between;background:#fff;border:1px solid #f5f5f4;border-radius:12px;padding:12px 16px;margin-bottom:8px}
.row .url{font-family:monospace;font-size:.85rem}
.row .meta{font-size:.75rem;color:#a8a29e}
.badge{display:inline-flex;align-items:center;gap:6px;font-size:.75rem}
.dot{width:7px;height:7px;border-radius:50%;background:#22c55e;animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
.form-row{display:flex;gap:8px}
.input-wrap{flex:1;display:flex;align-items:center;background:#fff;border:1px solid #e7e5e4;border-radius:12px;overflow:hidden}
.input-wrap:focus-within{box-shadow:0 0 0 2px #fdba74}
.input-wrap input{flex:1;border:none;outline:none;padding:10px 16px;font-size:.85rem;background:transparent;font-family:monospace}
.input-wrap .suffix{padding-right:12px;font-size:.85rem;color:#a8a29e;white-space:nowrap}
input[type=email]{flex:1;border:1px solid #e7e5e4;border-radius:12px;padding:10px 16px;font-size:.85rem;outline:none}
input[type=email]:focus{box-shadow:0 0 0 2px #fdba74}
.btn{padding:10px 20px;border:none;border-radius:12px;font-size:.85rem;font-weight:500;cursor:pointer;transition:all .15s}
.btn-orange{background:#f97316;color:#fff}.btn-orange:hover{background:#ea580c}
.btn-dark{background:#292524;color:#fff}.btn-dark:hover{background:#44403c}
.btn-ghost{background:none;border:none;color:#a8a29e;font-size:.75rem;cursor:pointer}.btn-ghost:hover{color:#ef4444}
.btn:disabled{opacity:.5;cursor:default}
.claimed-bar{background:rgba(255,255,255,0.5);border:1px solid #bbf7d0;border-radius:16px;padding:12px 20px;margin-bottom:16px;display:flex;align-items:center;gap:10px;font-size:.85rem}
.claimed-dot{width:8px;height:8px;border-radius:50%;background:#22c55e}
.error{background:#fef2f2;border:1px solid #fecaca;border-radius:12px;padding:12px 16px;margin-bottom:16px;font-size:.85rem;color:#b91c1c}
.key-bar{display:flex;align-items:center;gap:12px}
.key-chip{font-family:monospace;font-size:.75rem;color:#a8a29e;background:rgba(255,255,255,0.6);padding:6px 12px;border-radius:8px}
.empty{font-size:.85rem;color:#a8a29e}
code{background:#f5f5f4;padding:2px 8px;border-radius:4px;font-size:.8rem}
#no-key{text-align:center;padding:80px 24px}
#no-key input{width:100%;max-width:320px;margin:0 auto;display:block;border:1px solid #e7e5e4;border-radius:12px;padding:12px 16px;font-family:monospace;font-size:.9rem;outline:none;text-align:center}
#no-key input:focus{box-shadow:0 0 0 2px #fdba74}
</style></head><body>
<div class="wrap" id="app"></div>
<script>
const RELAY = ''
const params = new URLSearchParams(location.search)
let apiKey = params.get('key') || localStorage.getItem('tunn3l_api_key') || ''
if (apiKey) localStorage.setItem('tunn3l_api_key', apiKey)
const app = document.getElementById('app')
function render() { if (!apiKey) { renderNoKey(); return }; app.innerHTML = '<div style="text-align:center;padding:80px;color:#a8a29e">Loading...</div>'; fetchData() }
function renderNoKey() {
  app.innerHTML = '<div id="no-key"><h1><a href="/" style="color:inherit;text-decoration:none">tunn3l<span style="color:#a8a29e">.sh</span></a></h1><p style="color:#a8a29e;margin:8px 0 24px">Enter your API key to manage your tunnels.</p><input type="text" placeholder="tk_..." id="key-input"><p style="font-size:.75rem;color:#a8a29e;margin-top:16px">Install tunn3l to get a key: <code>curl -sSf https://tunn3l.sh/install | sh</code></p></div>'
  document.getElementById('key-input').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.value.trim()) { apiKey = e.target.value.trim(); localStorage.setItem('tunn3l_api_key', apiKey); render() } })
}
async function fetchData() {
  try {
    const [infoR, tunR] = await Promise.all([fetch(RELAY + '/api/token-info?token=' + encodeURIComponent(apiKey)), fetch(RELAY + '/api/tunnels?token=' + encodeURIComponent(apiKey))])
    const info = await infoR.json(); const tun = await tunR.json()
    renderDashboard(info, tun.tunnels || [])
  } catch (e) { app.innerHTML = '<div class="error">Failed to connect: ' + e.message + '</div>' }
}
function renderDashboard(info, tunnels) {
  let html = '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:32px"><div><h1><a href="/" style="color:inherit;text-decoration:none">tunn3l<span style="color:#a8a29e">.sh</span></a></h1><p class="sub">dashboard</p></div><div class="key-bar"><span class="key-chip">' + apiKey.slice(0,12) + '...</span><button class="btn-ghost" onclick="apiKey=&#39;&#39;;localStorage.removeItem(&#39;tunn3l_api_key&#39;);render()">switch key</button></div></div>'
  if (!info.claimed) { html += '<div class="card" style="border-color:#fdba74"><h2>Claim your account</h2><p>Link an email to your API key.</p><form class="form-row" onsubmit="handleClaim(event)"><input type="email" placeholder="you@example.com" id="claim-email" required style="flex:1"><button type="submit" class="btn btn-orange" id="claim-btn">Claim</button></form></div>' }
  else { html += '<div class="claimed-bar"><div class="claimed-dot"></div>Claimed by <strong>' + info.email + '</strong></div>' }
  html += '<div class="card"><h2>Active tunnels</h2>'
  if (tunnels.length === 0) { html += '<p class="empty">No active tunnels. Start one with <code>tunn3l http 3000</code></p>' }
  else { tunnels.forEach(t => { html += '<div class="row"><div><div class="url">' + t.url + '</div><div class="meta">' + t.mode + ' tunnel' + (t.device_id ? ' · ' + t.device_id : '') + '</div></div><div style="display:flex;align-items:center;gap:12px"><div class="badge"><div class="dot"></div>live</div><button class="btn-ghost" onclick="handleKill(&#39;' + t.subdomain + '&#39;)" style="color:#ef4444">kill</button></div></div>' }) }
  html += '</div>'
  html += '<div class="card"><h2>Reserved subdomains</h2><p>Reserved subdomains are automatically assigned when your tunnel connects.</p>'
  if (info.subdomains && info.subdomains.length > 0) { info.subdomains.forEach(s => { html += '<div class="row"><div><span class="url">' + s.name + '</span><span style="color:#a8a29e">.tunn3l.sh</span>' + (s.device_id ? '<div class="meta">' + s.device_id + '</div>' : '') + '</div><button class="btn-ghost" onclick="handleUnreserve(&#39;' + s.name + '&#39;)">release</button></div>' }) }
  html += '<p class="empty" style="margin-top:8px">Reserve subdomains from the CLI: <code>tunn3l reserve my-name</code></p></div>'
  app.innerHTML = html
}
async function handleClaim(e) { e.preventDefault(); const btn = document.getElementById('claim-btn'); const email = document.getElementById('claim-email').value; btn.disabled = true; btn.textContent = 'Claiming...'; try { const r = await fetch(RELAY + '/api/claim', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({token:apiKey,email}) }); if (!r.ok) throw new Error((await r.json()).error); fetchData() } catch(e) { alert(e.message); btn.disabled=false; btn.textContent='Claim' } }
async function handleUnreserve(sub) { try { const r = await fetch(RELAY + '/api/unreserve', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({token:apiKey,subdomain:sub}) }); if (!r.ok) throw new Error((await r.json()).error); fetchData() } catch(e) { alert(e.message) } }
async function handleKill(sub) { try { const r = await fetch(RELAY + '/api/kill', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({token:apiKey,subdomain:sub}) }); if (!r.ok) throw new Error((await r.json()).error); fetchData() } catch(e) { alert(e.message) } }
setInterval(() => { if (apiKey) fetchData() }, 10000)
render()
</script></body></html>`)
      return
    }

    // Landing page
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>tunn3l.sh — tunnel service for AI agents</title>
<meta name="description" content="Expose localhost to the internet. One command. No config.">
<meta name="theme-color" content="#1a1a18">
<meta property="og:title" content="tunn3l.sh">
<meta property="og:description" content="Expose localhost to the internet. One command. Built for AI agents.">
<style>
*{margin:0;padding:0;box-sizing:border-box}
html{overflow-x:hidden;background:#1a1a18}
body{font-family:system-ui,-apple-system,sans-serif;background:linear-gradient(180deg,#1a1a18,#2a2218);color:#fff;min-height:100dvh;overflow-x:hidden;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)}
.container{max-width:720px;margin:0 auto;padding:80px 24px;overflow-x:hidden}
h1{font-size:3.5rem;font-weight:800;letter-spacing:-0.02em;margin-bottom:12px}
h1 .ext{color:rgba(255,255,255,0.35)}
.sub{color:rgba(255,255,255,0.35);font-size:1.1rem;margin-bottom:48px;line-height:1.6}
.terminal{background:#0a0a08;border:1px solid rgba(255,255,255,0.1);border-radius:12px;overflow:hidden;margin-bottom:32px}
.terminal-bar{background:rgba(255,255,255,0.05);padding:8px 16px;display:flex;gap:6px}
.dot{width:10px;height:10px;border-radius:50%;opacity:0.5}
.terminal-body{padding:24px;font-family:monospace;font-size:0.9rem;line-height:1.8}
.cmd{color:#FFF8E7}
.ok{color:#B4E33D}
.url{color:#FC913A}
.dim{color:#666}
.install{background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:12px 16px 12px 20px;font-family:monospace;font-size:0.9rem;color:rgba(255,255,255,0.7);display:inline-flex;align-items:center;gap:12px;margin-bottom:48px}
.install code{white-space:nowrap}
.copy-btn{background:none;border:none;padding:4px;cursor:pointer;color:rgba(255,255,255,0.3);transition:all 0.15s;display:flex;align-items:center}
.copy-btn:hover{color:rgba(255,255,255,0.7)}
.features{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:32px;margin-bottom:64px}
.feature .dot-indicator{width:8px;height:8px;border-radius:50%;margin-bottom:12px}
.feature h3{font-size:1rem;margin-bottom:8px}
.feature p{color:rgba(255,255,255,0.3);font-size:0.85rem;line-height:1.5}
.footer{border-top:1px solid rgba(255,255,255,0.05);padding-top:24px;display:flex;justify-content:space-between;color:rgba(255,255,255,0.15);font-size:0.75rem;font-family:monospace}
.footer a{color:rgba(255,255,255,0.25);text-decoration:none}
.stats{color:rgba(255,255,255,0.15);font-family:monospace;font-size:0.75rem;margin-bottom:48px}
.stats a{color:rgba(255,255,255,0.3);text-decoration:none;transition:color 0.15s}
.stats a:hover{color:rgba(255,255,255,0.6)}
</style>
</head>
<body>
<div class="container">
<h1>tunn3l<span class="ext">.sh</span></h1>
<p class="sub">HI The tunnel service built for AI agents.<br>Expose localhost to the internet. One command. No signup. No config.</p>

<div class="terminal">
<div class="terminal-bar">
<div class="dot" style="background:#FF4E50"></div>
<div class="dot" style="background:#F9D423"></div>
<div class="dot" style="background:#B4E33D"></div>
</div>
<div class="terminal-body">
<div class="cmd">$ curl -sSf https://tunn3l.sh/install | sh</div>
<div class="dim">tunn3l: installing darwin/arm64...</div>
<div class="ok">tunn3l: installed to ~/.tunn3l/bin/tunn3l</div>
<div>&nbsp;</div>
<div class="cmd">$ tunn3l http 3000</div>
<div>&nbsp;</div>
<div class="ok">tunn3l: tunnel ready</div>
<div class="url">tunn3l: https://myapp.tunn3l.sh → localhost:3000</div>
</div>
</div>

<p style="color:rgba(255,255,255,0.5);font-size:0.85rem;margin-bottom:10px">Get started:</p>
<div class="install">
<code>curl -sSf https://tunn3l.sh/install | sh</code>
<button class="copy-btn" onclick="navigator.clipboard.writeText('curl -sSf https://tunn3l.sh/install | sh').then(()=>{this.innerHTML='<svg width=&quot;16&quot; height=&quot;16&quot; viewBox=&quot;0 0 24 24&quot; fill=&quot;none&quot; stroke=&quot;#B4E33D&quot; stroke-width=&quot;2&quot; stroke-linecap=&quot;round&quot; stroke-linejoin=&quot;round&quot;><polyline points=&quot;20 6 9 17 4 12&quot;/></svg>';setTimeout(()=>this.innerHTML='<svg width=&quot;16&quot; height=&quot;16&quot; viewBox=&quot;0 0 24 24&quot; fill=&quot;none&quot; stroke=&quot;currentColor&quot; stroke-width=&quot;2&quot; stroke-linecap=&quot;round&quot; stroke-linejoin=&quot;round&quot;><rect x=&quot;9&quot; y=&quot;9&quot; width=&quot;13&quot; height=&quot;13&quot; rx=&quot;2&quot;/><path d=&quot;M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1&quot;/></svg>',2000)})"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
</div>

<div class="features">
<div class="feature">
<div class="dot-indicator" style="background:#FC913A"></div>
<h3>Agent-first</h3>
<p>JSON output, exit codes, env var config. Zero interactive prompts. Your AI agent can install and run it without help.</p>
</div>
<div class="feature">
<div class="dot-indicator" style="background:#B4E33D"></div>
<h3>Zero setup</h3>
<p>No account. No API key. No client app on the other end. Just curl the binary and go. Unlike Tailscale or Cloudflare Tunnel, nothing needed on either side.</p>
</div>
<div class="feature">
<div class="dot-indicator" style="background:#FF4E50"></div>
<h3>Free &amp; open source</h3>
<p>MIT licensed. Run the relay yourself or use ours. HTTP tunnels, TCP tunnels, SSH — all free.</p>
</div>
</div>

<p class="stats"><a href="/features">See everything tunn3l can do →</a></p>

<p class="stats">${tunnels.size} tunnel${tunnels.size !== 1 ? 's' : ''} live right now · <a href="/dashboard">manage yours →</a></p>

<div class="footer">
<span>tunn3l.sh is <a href="https://github.com/bdecrem/hilma/blob/main/apps/tunnel/LICENSE" target="_blank">open source</a></span>
<a href="https://github.com/bdecrem/hilma/issues/new?labels=tunn3l&title=Feature+request:+" target="_blank">Request a feature</a>
<a href="https://github.com/bdecrem/hilma/tree/main/apps/tunnel" target="_blank">GitHub</a>
</div>
</div>
</body>
</html>`)
    return
  }

  const tunnel = tunnels.get(subdomain)
  if (!tunnel) {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end(`No tunnel found for subdomain: ${subdomain}`)
    return
  }

  // TCP tunnels don't serve HTTP
  if (tunnel.mode === 'tcp') {
    res.writeHead(400, { 'Content-Type': 'text/plain' })
    const port = tunnel.tcpPort ? ` -p ${tunnel.tcpPort}` : ` -o ProxyCommand="tunn3l proxy %h %p"`
    res.end(`This is a TCP tunnel. Use: ssh user@${BASE_DOMAIN}${port}`)
    return
  }

  // Collect request body (with size limit)
  const chunks = []
  let bodySize = 0
  let aborted = false
  req.on('data', (chunk) => {
    if (aborted) return
    bodySize += chunk.length
    if (bodySize > MAX_REQUEST_BODY) {
      aborted = true
      req.removeAllListeners('data')
      res.writeHead(413, { 'Content-Type': 'text/plain' })
      res.end('Request body too large')
      req.destroy()
      return
    }
    chunks.push(chunk)
  })
  req.on('end', () => {
    if (aborted) return
    const body = Buffer.concat(chunks)
    const requestId = generateId()

    // Timeout after 30s
    const timer = setTimeout(() => {
      tunnel.pending.delete(requestId)
      res.writeHead(504, { 'Content-Type': 'text/plain' })
      res.end('Tunnel request timed out')
    }, 30000)

    tunnel.pending.set(requestId, { res, timer })

    // Send request to tunnel client
    const msg = {
      type: 'request',
      requestId,
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: body.length > 0 ? body.toString('base64') : null,
      bodyEncoding: 'base64',
    }

    tunnel.ws.send(JSON.stringify(msg))
    tunnel.requestCount = (tunnel.requestCount || 0) + 1
  })
})

// ─── Per-tunnel TCP listeners ─────────────────────────────────
// Each TCP tunnel gets its own net.Server on its assigned port.
// Direct port binding — no proxy layer.

function startTcpListener(port, subdomain) {
  const srv = net.createServer((socket) => {
    const tunnel = tunnels.get(subdomain)
    if (!tunnel || tunnel.mode !== 'tcp') {
      socket.destroy()
      return
    }

    const streamId = generateId()
    tunnel.tcpStreams.set(streamId, socket)

    tunnel.ws.send(JSON.stringify({ type: 'tcp-open', streamId }))
    console.log(`[TCP] ${subdomain}:${port} stream ${streamId} opened`)

    const readyTimer = setTimeout(() => {
      if (socket._waitingForReady) {
        socket.destroy()
        tunnel.tcpStreams.delete(streamId)
      }
    }, 10000)
    socket._waitingForReady = true
    socket._readyTimer = readyTimer

    socket._tcpBuffered = []
    socket._paused = true

    socket.on('data', (data) => {
      if (socket._paused) {
        socket._tcpBuffered.push(data)
        return
      }
      const frame = Buffer.alloc(16 + data.length)
      frame.write(streamId, 0, 16, 'ascii')
      data.copy(frame, 16)
      if (tunnel.ws.readyState === tunnel.ws.OPEN) {
        tunnel.ws.send(frame)
      }
    })

    socket.on('close', () => {
      clearTimeout(readyTimer)
      tunnel.tcpStreams.delete(streamId)
      if (tunnel.ws.readyState === tunnel.ws.OPEN) {
        tunnel.ws.send(JSON.stringify({ type: 'tcp-close', streamId }))
      }
    })

    socket.on('error', () => {
      tunnel.tcpStreams.delete(streamId)
    })
  })

  srv.listen(port, () => {
    console.log(`[TCP] Listening on port ${port} for ${subdomain}`)
  })

  srv.on('error', (err) => {
    console.error(`[TCP] Failed to listen on port ${port}: ${err.message}`)
  })

  tcpListeners.set(port, srv)
}

function stopTcpListener(port) {
  const srv = tcpListeners.get(port)
  if (srv) {
    srv.close()
    tcpListeners.delete(port)
    console.log(`[TCP] Stopped listening on port ${port}`)
  }
}

initDb()

server.listen(PORT, () => {
  console.log(`[TUNN3L RELAY] HTTP/WS on port ${PORT}`)
  console.log(`[TUNN3L RELAY] Base domain: ${BASE_DOMAIN}`)
  console.log(`[TUNN3L RELAY] TCP tunnel range: ${TCP_PORT_MIN}-${TCP_PORT_MAX}`)
})
