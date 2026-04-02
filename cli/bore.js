#!/usr/bin/env node

/**
 * TUNN3L CLI — expose localhost to the internet via a tunnel relay.
 *
 * Usage:
 *   tunn3l http <port> [--subdomain <name>] [--relay <url>] [--json]
 *   tunn3l tcp <port> [--subdomain <name>] [--relay <url>] [--json]
 *   tunn3l ssh [--subdomain <name>] [--relay <url>] [--json]
 *   tunn3l proxy <hostname> <port>
 *   tunn3l daemon install --port <port> [--name <name>] [--subdomain <name>] [--mode tcp]
 *   tunn3l daemon start|stop|status|uninstall|logs [--name <name>]
 *   tunn3l daemon list
 *
 * Exit codes:
 *   0 — clean shutdown
 *   1 — auth error
 *   2 — connection failed
 *   3 — subdomain taken
 */

import WebSocket from 'ws'
import http from 'http'
import net from 'net'
import crypto from 'crypto'
import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync, readdirSync, chmodSync } from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'
import { homedir, platform, hostname as osHostname } from 'os'

const args = process.argv.slice(2)
const TUNN3L_DIR = join(homedir(), '.tunn3l')
const DAEMON_DIR = join(TUNN3L_DIR, 'daemon')

// Ensure device_id exists in config
function ensureDeviceId() {
  const config = loadConfig('default')
  if (!config.device_id) {
    config.device_id = 'dv_' + crypto.randomBytes(12).toString('hex')
    saveConfig('default', config)
  }
  return config.device_id
}

// Load config for a named instance
function loadConfig(name) {
  const path = name === 'default'
    ? join(TUNN3L_DIR, 'config.json')
    : join(TUNN3L_DIR, `config.${name}.json`)
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return {}
  }
}

function saveConfig(name, config) {
  mkdirSync(TUNN3L_DIR, { recursive: true })
  const path = name === 'default'
    ? join(TUNN3L_DIR, 'config.json')
    : join(TUNN3L_DIR, `config.${name}.json`)
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
  try { chmodSync(path, 0o600) } catch {} // chmod needed when file already exists
  return path
}

function usage() {
  console.error(`Usage: tunn3l http <port> [options]
       tunn3l tcp <port> [options]
       tunn3l ssh [options]
       tunn3l proxy <hostname> <port>
       tunn3l daemon <command> [options]

Commands:
  http <port>          Expose localhost:<port> via HTTP tunnel
  tcp <port>           Expose localhost:<port> via TCP tunnel
  ssh                  Expose SSH (shorthand for: tunn3l tcp 22)
  proxy <host> <port>  SSH ProxyCommand helper
  daemon install       Install tunn3l as a background service
  daemon start|stop|status|list|uninstall|logs

Options:
  --subdomain <name>   Request a specific subdomain
  --relay <url>        Relay server URL (default: wss://tunn3l.sh/ws/connect)
  --json               Output connection info as JSON (for agents)
  --name <name>        Daemon instance name (default: "default")
  --port <port>        Port to tunnel (daemon install)
  --mode <http|tcp>    Tunnel mode (daemon install, default: http)
  --help               Show this help

Examples:
  tunn3l http 3000                        # expose dev server
  tunn3l http 3000 --subdomain myapp      # custom URL: myapp.tunn3l.sh
  tunn3l http 8080 --json                 # JSON output for scripts

  tunn3l ssh                              # expose SSH with random subdomain
  tunn3l ssh --subdomain mybox            # SSH via: mybox.tunn3l.sh
  tunn3l tcp 5432 --subdomain mydb        # expose Postgres

  # Connect to an SSH tunnel from another machine:
  ssh user@mybox.tunn3l.sh -o ProxyCommand="tunn3l proxy %h %p"

  # Or add to ~/.ssh/config:
  # Host *.tunn3l.sh
  #   ProxyCommand tunn3l proxy %h %p

SSH setup (macOS):
  Enable Remote Login in System Settings > General > Sharing`)
  process.exit(1)
}

// Parse args
if (!args[0] || args[0] === '--help' || args[0] === '-h') usage()

if (args[0] === 'daemon') {
  handleDaemon(args.slice(1))
} else if (args[0] === 'http') {
  handleHttp(args.slice(1))
} else if (args[0] === 'tcp') {
  handleTcp(args.slice(1))
} else if (args[0] === 'ssh') {
  handleTcp(['22', ...args.slice(1)])
} else if (args[0] === 'proxy') {
  handleProxy(args.slice(1))
} else {
  console.error(`Error: unknown command "${args[0]}"`)
  usage()
}

// ─── HTTP tunnel ───────────────────────────────────────────────

function handleHttp(httpArgs) {
  const config = loadConfig('default')
  const deviceId = ensureDeviceId()
  const token = config.api_key || process.env.TUNN3L_TOKEN || null

  const port = parseInt(httpArgs[0]) || config.port
  if (!port || isNaN(port)) {
    console.error('Error: port must be a number')
    usage()
  }

  let subdomain = config.subdomain || null
  let relayUrl = process.env.TUNN3L_RELAY || config.relay || 'wss://tunn3l.sh/ws/connect'
  let jsonMode = config.json || false

  for (let i = 1; i < httpArgs.length; i++) {
    if (httpArgs[i] === '--subdomain' && httpArgs[i + 1]) { subdomain = httpArgs[++i] }
    else if (httpArgs[i] === '--relay' && httpArgs[i + 1]) { relayUrl = httpArgs[++i] }
    else if (httpArgs[i] === '--json') { jsonMode = true }
  }

  let backoff = 1000
  let connected = false

  function connect() {
    const ws = new WebSocket(relayUrl)

    ws.on('open', () => {
      backoff = 1000
      const reg = { type: 'register', subdomain }
      if (token) reg.token = token
      if (deviceId) { reg.device_id = deviceId; reg.hostname = osHostname(); reg.os = platform() }
      ws.send(JSON.stringify(reg))
    })

    ws.on('message', (data) => {
      let msg
      try {
        msg = JSON.parse(data.toString())
      } catch {
        return
      }

      if (msg.type === 'registered') {
        connected = true
        if (jsonMode) {
          console.log(JSON.stringify({ url: msg.url, subdomain: msg.subdomain }))
        } else {
          console.log(`\n  tunn3l tunnel ready\n`)
          console.log(`  forwarding  ${msg.url} → http://localhost:${port}\n`)
        }
      }

      if (msg.type === 'error') {
        if (msg.code === 3) {
          console.error(`Error: subdomain '${subdomain}' is already in use`)
          process.exit(3)
        }
        if (msg.code === 4) {
          console.error(`Error: ${msg.message}`)
          process.exit(1)
        }
        console.error(`Error: ${msg.message}`)
        process.exit(2)
      }

      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }))
      }

      if (msg.type === 'request') {
        handleRequest(ws, msg, port)
      }
    })

    ws.on('close', () => {
      if (connected) {
        connected = false
        if (!jsonMode) console.log('Tunnel disconnected. Reconnecting...')
      }
      setTimeout(() => {
        backoff = Math.min(backoff * 2, 30000)
        connect()
      }, backoff)
    })

    ws.on('error', (err) => {
      if (!connected && backoff === 1000) {
        console.error(`Error: could not connect to relay at ${relayUrl}`)
        console.error(`  ${err.message}`)
      }
    })
  }

  process.on('SIGINT', () => {
    if (!jsonMode) console.log('\nShutting down tunnel...')
    process.exit(0)
  })

  connect()
}

function handleRequest(ws, msg, port) {
  const options = {
    hostname: '127.0.0.1',
    port,
    path: msg.url,
    method: msg.method,
    headers: { ...msg.headers },
  }

  options.headers.host = `localhost:${port}`
  delete options.headers['x-forwarded-for']

  const proxyReq = http.request(options, (proxyRes) => {
    const chunks = []
    proxyRes.on('data', (chunk) => chunks.push(chunk))
    proxyRes.on('end', () => {
      const body = Buffer.concat(chunks)
      const headers = { ...proxyRes.headers }
      delete headers['transfer-encoding']
      delete headers['connection']

      ws.send(JSON.stringify({
        type: 'response',
        requestId: msg.requestId,
        statusCode: proxyRes.statusCode,
        headers,
        body: body.toString('base64'),
        encoding: 'base64',
      }))
    })
  })

  proxyReq.on('error', (err) => {
    ws.send(JSON.stringify({
      type: 'response',
      requestId: msg.requestId,
      statusCode: 502,
      headers: { 'content-type': 'text/plain' },
      body: Buffer.from(`Local server error: ${err.message}`).toString('base64'),
      encoding: 'base64',
    }))
  })

  if (msg.body) {
    proxyReq.write(Buffer.from(msg.body, msg.bodyEncoding || 'base64'))
  }
  proxyReq.end()
}

// ─── TCP tunnel ───────────────────────────────────────────────

function handleTcp(tcpArgs) {
  const config = loadConfig('default')
  const deviceId = ensureDeviceId()
  const token = config.api_key || process.env.TUNN3L_TOKEN || null

  const port = parseInt(tcpArgs[0]) || config.port
  if (!port || isNaN(port)) {
    console.error('Error: port must be a number')
    usage()
  }

  let subdomain = config.subdomain || null
  let relayUrl = process.env.TUNN3L_RELAY || config.relay || 'wss://tunn3l.sh/ws/connect'
  let jsonMode = config.json || false

  for (let i = 1; i < tcpArgs.length; i++) {
    if (tcpArgs[i] === '--subdomain' && tcpArgs[i + 1]) { subdomain = tcpArgs[++i] }
    else if (tcpArgs[i] === '--relay' && tcpArgs[i + 1]) { relayUrl = tcpArgs[++i] }
    else if (tcpArgs[i] === '--json') { jsonMode = true }
  }

  const streams = new Map() // streamId → net.Socket
  let backoff = 1000
  let connected = false

  function connect() {
    const ws = new WebSocket(relayUrl)

    ws.on('open', () => {
      backoff = 1000
      const reg = { type: 'register', subdomain, mode: 'tcp' }
      if (token) reg.token = token
      if (deviceId) { reg.device_id = deviceId; reg.hostname = osHostname(); reg.os = platform() }
      ws.send(JSON.stringify(reg))
    })

    ws.on('message', (data, isBinary) => {
      // Binary frames: TCP data from relay → local socket
      if (isBinary) {
        const buf = Buffer.from(data)
        if (buf.length < 16) return
        const streamId = buf.subarray(0, 16).toString('ascii')
        const payload = buf.subarray(16)
        const sock = streams.get(streamId)
        if (sock && !sock.destroyed) {
          sock.write(payload)
        }
        return
      }

      // JSON messages
      let msg
      try {
        msg = JSON.parse(data.toString())
      } catch {
        return
      }

      if (msg.type === 'registered') {
        connected = true
        if (jsonMode) {
          const info = { url: msg.url, subdomain: msg.subdomain, mode: 'tcp' }
          if (msg.tcpPort) { info.tcpPort = msg.tcpPort; info.tcpHost = msg.tcpHost }
          console.log(JSON.stringify(info))
        } else {
          console.log(`\n  tunn3l tcp tunnel ready\n`)
          console.log(`  forwarding  ${msg.url} → tcp://localhost:${port}`)
          if (msg.tcpPort) {
            console.log(`  connect:    ssh user@${msg.tcpHost || 'tunn3l.sh'} -p ${msg.tcpPort}\n`)
          } else {
            console.log(`  connect:    ssh user@${msg.subdomain}.tunn3l.sh -o ProxyCommand="tunn3l proxy %h %p"\n`)
          }
        }
      }

      if (msg.type === 'error') {
        if (msg.code === 3) {
          console.error(`Error: subdomain '${subdomain}' is already in use`)
          process.exit(3)
        }
        if (msg.code === 4) {
          console.error(`Error: ${msg.message}`)
          process.exit(1)
        }
        console.error(`Error: ${msg.message}`)
        process.exit(2)
      }

      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }))
      }

      if (msg.type === 'tcp-open') {
        // New inbound TCP connection — connect to local port
        const sock = net.createConnection({ host: '127.0.0.1', port }, () => {
          ws.send(JSON.stringify({ type: 'tcp-ready', streamId: msg.streamId }))
        })
        sock.setKeepAlive(true, 30000)
        streams.set(msg.streamId, sock)

        sock.on('data', (chunk) => {
          if (ws.readyState !== ws.OPEN) return
          const frame = Buffer.alloc(16 + chunk.length)
          frame.write(msg.streamId, 0, 16, 'ascii')
          chunk.copy(frame, 16)
          ws.send(frame)
        })

        sock.on('close', () => {
          streams.delete(msg.streamId)
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: 'tcp-close', streamId: msg.streamId }))
          }
        })

        sock.on('error', (err) => {
          streams.delete(msg.streamId)
          ws.send(JSON.stringify({ type: 'tcp-error', streamId: msg.streamId, message: err.message }))
        })
      }

      if (msg.type === 'tcp-close') {
        const sock = streams.get(msg.streamId)
        if (sock) {
          sock.destroy()
          streams.delete(msg.streamId)
        }
      }
    })

    ws.on('close', () => {
      // Clean up all streams
      for (const [, sock] of streams) { sock.destroy() }
      streams.clear()

      if (connected) {
        connected = false
        if (!jsonMode) console.log('Tunnel disconnected. Reconnecting...')
      }
      setTimeout(() => {
        backoff = Math.min(backoff * 2, 30000)
        connect()
      }, backoff)
    })

    ws.on('error', (err) => {
      if (!connected && backoff === 1000) {
        console.error(`Error: could not connect to relay at ${relayUrl}`)
        console.error(`  ${err.message}`)
      }
    })
  }

  process.on('SIGINT', () => {
    if (!jsonMode) console.log('\nShutting down tunnel...')
    for (const [, sock] of streams) { sock.destroy() }
    process.exit(0)
  })

  connect()
}

// ─── Proxy (SSH ProxyCommand helper) ──────────────────────────

function handleProxy(proxyArgs) {
  const hostname = proxyArgs[0]
  if (!hostname) {
    console.error('Usage: tunn3l proxy <hostname> <port>')
    console.error('  Used as SSH ProxyCommand: ssh user@host -o ProxyCommand="tunn3l proxy %h %p"')
    process.exit(1)
  }

  // Extract subdomain from hostname (e.g., "mybox" from "mybox.tunn3l.sh")
  const parts = hostname.split('.')
  const subdomain = parts[0]

  // Build relay URL from hostname
  let relayHost = hostname
  // If just a subdomain was passed, assume tunn3l.sh
  if (!hostname.includes('.')) {
    relayHost = `${hostname}.tunn3l.sh`
  }

  // Allow --relay override
  let relayUrl = null
  for (let i = 1; i < proxyArgs.length; i++) {
    if (proxyArgs[i] === '--relay' && proxyArgs[i + 1]) { relayUrl = proxyArgs[++i] }
  }
  if (!relayUrl) {
    relayUrl = `wss://${relayHost}/ws/tcp`
  }

  const ws = new WebSocket(relayUrl)

  ws.on('open', () => {
    // Pipe stdin → WebSocket
    process.stdin.on('data', (chunk) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(chunk)
      }
    })
  })

  // Pipe WebSocket → stdout
  ws.on('message', (data) => {
    process.stdout.write(Buffer.from(data))
  })

  ws.on('close', () => {
    process.exit(0)
  })

  ws.on('error', (err) => {
    process.stderr.write(`tunn3l proxy: ${err.message}\n`)
    process.exit(2)
  })

  process.stdin.on('end', () => {
    ws.close()
  })
}

// ─── Daemon ────────────────────────────────────────────────────

function labelFor(name) { return name === 'default' ? 'sh.tunn3l.tunnel' : `sh.tunn3l.tunnel.${name}` }
function plistPathFor(name) { return join(homedir(), 'Library', 'LaunchAgents', `${labelFor(name)}.plist`) }
function systemdUnitFor(name) { return name === 'default' ? 'tunn3l-tunnel.service' : `tunn3l-tunnel-${name}.service` }
function systemdPathFor(name) { return join(homedir(), '.config', 'systemd', 'user', systemdUnitFor(name)) }
function logPathFor(name) { return join(DAEMON_DIR, name === 'default' ? 'tunn3l.log' : `tunn3l-${name}.log`) }
function errPathFor(name) { return join(DAEMON_DIR, name === 'default' ? 'tunn3l.err' : `tunn3l-${name}.err`) }

const DAEMON_NAME_RE = /^[a-zA-Z0-9_-]+$/

function parseName(daemonArgs) {
  for (let i = 0; i < daemonArgs.length; i++) {
    if (daemonArgs[i] === '--name' && daemonArgs[i + 1]) {
      const name = daemonArgs[i + 1]
      if (!DAEMON_NAME_RE.test(name)) {
        console.error('Error: daemon name must be alphanumeric, hyphens, or underscores only')
        process.exit(1)
      }
      return name
    }
  }
  return 'default'
}

function handleDaemon(daemonArgs) {
  const cmd = daemonArgs[0]
  if (!cmd || cmd === '--help') {
    console.error(`Usage: tunn3l daemon <command> [--name <name>]

Commands:
  install    Install as a background service
  start      Start the service
  stop       Stop the service
  status     Show service status
  list       List all installed daemons
  uninstall  Remove the service
  logs       Show service logs

Options:
  --name <name>        Instance name (default: "default")
  --port <port>        Port to tunnel (install only)
  --subdomain <name>   Request specific subdomain (install only)
  --mode <http|tcp>    Tunnel mode (install only, default: http)`)
    process.exit(1)
  }

  const name = parseName(daemonArgs)

  switch (cmd) {
    case 'install': return daemonInstall(name, daemonArgs.slice(1))
    case 'start': return daemonStart(name)
    case 'stop': return daemonStop(name)
    case 'status': return daemonStatus(name)
    case 'list': return daemonList()
    case 'uninstall': return daemonUninstall(name)
    case 'logs': return daemonLogs(name)
    default:
      console.error(`Error: unknown daemon command "${cmd}"`)
      process.exit(1)
  }
}

function daemonInstall(name, installArgs) {
  const config = loadConfig(name)

  for (let i = 0; i < installArgs.length; i++) {
    if (installArgs[i] === '--port' && installArgs[i + 1]) { config.port = parseInt(installArgs[++i]) }
    else if (installArgs[i] === '--subdomain' && installArgs[i + 1]) { config.subdomain = installArgs[++i] }
    else if (installArgs[i] === '--relay' && installArgs[i + 1]) { config.relay = installArgs[++i] }
    else if (installArgs[i] === '--mode' && installArgs[i + 1]) { config.mode = installArgs[++i] }
    else if (installArgs[i] === '--name') { i++ } // skip, already parsed
  }

  if (!config.port) {
    console.error('Error: port required. Use --port <port>')
    process.exit(1)
  }

  const configPath = saveConfig(name, config)
  mkdirSync(DAEMON_DIR, { recursive: true })

  const tunn3lBin = join(TUNN3L_DIR, 'bin', 'tunn3l')
  const mode = config.mode === 'tcp' ? 'tcp' : 'http'
  const tunn3lArgs = [mode, String(config.port)]
  if (config.subdomain) tunn3lArgs.push('--subdomain', config.subdomain)

  const os = platform()
  if (os === 'darwin') {
    installLaunchd(name, tunn3lBin, tunn3lArgs, config)
  } else if (os === 'linux') {
    installSystemd(name, tunn3lBin, tunn3lArgs, config)
  } else {
    console.error(`Error: daemon not supported on ${os}`)
    process.exit(1)
  }

  console.log(`  tunn3l daemon "${name}" installed`)
  console.log(`  port:   ${config.port}`)
  if (config.subdomain) console.log(`  subdomain: ${config.subdomain}`)
  console.log(`  config: ${configPath}`)
  console.log(`  logs:   ${logPathFor(name)}`)
  console.log(`\n  Run "tunn3l daemon start${name !== 'default' ? ` --name ${name}` : ''}" to start`)
}

function installLaunchd(name, tunn3lBin, tunn3lArgs, config) {
  const label = labelFor(name)
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${tunn3lBin}</string>
${tunn3lArgs.map(a => `    <string>${a}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logPathFor(name)}</string>
  <key>StandardErrorPath</key>
  <string>${errPathFor(name)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>TUNN3L_RELAY</key>
    <string>${config.relay || 'wss://tunn3l.sh/ws/connect'}</string>
  </dict>
</dict>
</plist>`

  mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true })
  writeFileSync(plistPathFor(name), plist)
}

function installSystemd(name, tunn3lBin, tunn3lArgs, config) {
  const unit = `[Unit]
Description=tunn3l.sh tunnel (${name})
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${tunn3lBin} ${tunn3lArgs.join(' ')}
Restart=always
RestartSec=5
Environment=TUNN3L_RELAY=${config.relay || 'wss://tunn3l.sh/ws/connect'}
StandardOutput=append:${logPathFor(name)}
StandardError=append:${errPathFor(name)}

[Install]
WantedBy=default.target`

  const dir = join(homedir(), '.config', 'systemd', 'user')
  mkdirSync(dir, { recursive: true })
  writeFileSync(systemdPathFor(name), unit)
  try { execSync('systemctl --user daemon-reload', { stdio: 'pipe' }) } catch {}
}

function daemonStart(name) {
  const os = platform()
  try {
    if (os === 'darwin') {
      const plist = plistPathFor(name)
      if (!existsSync(plist)) {
        console.error(`Error: daemon "${name}" not installed. Run "tunn3l daemon install --port <port>${name !== 'default' ? ` --name ${name}` : ''}"`)
        process.exit(1)
      }
      execSync(`launchctl load ${plist}`, { stdio: 'pipe' })
    } else {
      execSync(`systemctl --user start ${systemdUnitFor(name)} && systemctl --user enable ${systemdUnitFor(name)}`, { stdio: 'pipe' })
    }
    console.log(`  tunn3l daemon "${name}" started`)
  } catch (err) {
    console.error(`Error starting daemon: ${err.message}`)
    process.exit(1)
  }
}

function daemonStop(name) {
  const os = platform()
  try {
    if (os === 'darwin') {
      execSync(`launchctl unload ${plistPathFor(name)}`, { stdio: 'pipe' })
    } else {
      execSync(`systemctl --user stop ${systemdUnitFor(name)}`, { stdio: 'pipe' })
    }
    console.log(`  tunn3l daemon "${name}" stopped`)
  } catch (err) {
    console.error(`Error stopping daemon: ${err.message}`)
    process.exit(1)
  }
}

function daemonStatus(name) {
  const os = platform()
  const config = loadConfig(name)
  try {
    if (os === 'darwin') {
      const label = labelFor(name)
      const out = execSync(`launchctl list ${label} 2>&1`, { encoding: 'utf-8' })
      const pidMatch = out.match(/"PID"\s*=\s*(\d+)/)
      const pid = pidMatch ? pidMatch[1] : null
      if (pid) {
        console.log(`  tunn3l daemon "${name}" running (PID ${pid})`)
      } else {
        console.log(`  tunn3l daemon "${name}" installed but not running`)
      }
    } else {
      const out = execSync(`systemctl --user is-active ${systemdUnitFor(name)} 2>&1`, { encoding: 'utf-8' }).trim()
      if (out === 'active') {
        console.log(`  tunn3l daemon "${name}" running`)
      } else {
        console.log(`  tunn3l daemon "${name}": ${out}`)
      }
    }
    if (config.port) {
      console.log(`  port: ${config.port}`)
      if (config.subdomain) console.log(`  subdomain: ${config.subdomain}`)
    }
  } catch {
    console.log(`  tunn3l daemon "${name}" not installed`)
  }
}

function daemonList() {
  const os = platform()
  const names = []

  if (os === 'darwin') {
    const dir = join(homedir(), 'Library', 'LaunchAgents')
    try {
      const files = readdirSync(dir).filter(f => f.startsWith('sh.tunn3l.tunnel') && f.endsWith('.plist'))
      for (const f of files) {
        const base = f.replace('.plist', '')
        const name = base === 'sh.tunn3l.tunnel' ? 'default' : base.replace('sh.tunn3l.tunnel.', '')
        names.push(name)
      }
    } catch {}
  } else {
    const dir = join(homedir(), '.config', 'systemd', 'user')
    try {
      const files = readdirSync(dir).filter(f => f.startsWith('tunn3l-tunnel') && f.endsWith('.service'))
      for (const f of files) {
        const base = f.replace('.service', '')
        const name = base === 'tunn3l-tunnel' ? 'default' : base.replace('tunn3l-tunnel-', '')
        names.push(name)
      }
    } catch {}
  }

  if (names.length === 0) {
    console.log('  No daemons installed')
    return
  }

  for (const name of names) {
    const config = loadConfig(name)
    const port = config.port || '?'
    const sub = config.subdomain ? ` (${config.subdomain})` : ''
    console.log(`  ${name}  →  localhost:${port}${sub}`)
  }
}

function daemonUninstall(name) {
  const os = platform()
  try {
    if (os === 'darwin') {
      try { execSync(`launchctl unload ${plistPathFor(name)}`, { stdio: 'pipe' }) } catch {}
      if (existsSync(plistPathFor(name))) unlinkSync(plistPathFor(name))
    } else {
      try { execSync(`systemctl --user stop ${systemdUnitFor(name)} && systemctl --user disable ${systemdUnitFor(name)}`, { stdio: 'pipe' }) } catch {}
      if (existsSync(systemdPathFor(name))) unlinkSync(systemdPathFor(name))
      try { execSync('systemctl --user daemon-reload', { stdio: 'pipe' }) } catch {}
    }
    console.log(`  tunn3l daemon "${name}" uninstalled`)
  } catch (err) {
    console.error(`Error uninstalling daemon: ${err.message}`)
    process.exit(1)
  }
}

function daemonLogs(name) {
  const path = logPathFor(name)
  try {
    const log = readFileSync(path, 'utf-8')
    const lines = log.split('\n')
    console.log(lines.slice(-50).join('\n'))
  } catch {
    console.log('  No logs yet')
  }
}
