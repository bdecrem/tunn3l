/**
 * Supabase data layer for tunn3l relay.
 * All methods are fire-and-forget — never block the hot path.
 */

import { createClient } from '@supabase/supabase-js'

let supabase = null

export function initDb() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) {
    console.log('[DB] No SUPABASE_URL/SUPABASE_SERVICE_KEY — running without persistence')
    return false
  }
  supabase = createClient(url, key)
  console.log('[DB] Connected to Supabase')
  return true
}

export async function upsertSubdomain(name) {
  if (!supabase) return null
  const { data, error } = await supabase
    .from('subdomains')
    .upsert({ name, last_seen: new Date().toISOString() }, { onConflict: 'name' })
    .select('id')
    .single()
  if (error) throw error
  return data.id
}

export async function recordConnect(subdomain, clientIp, token) {
  if (!supabase) return null
  const row = { subdomain, client_ip: clientIp }
  if (token) row.token = token
  const { data, error } = await supabase
    .from('connections')
    .insert(row)
    .select('id')
    .single()
  if (error) throw error
  return data.id
}

export async function recordDisconnect(connectionId, stats = {}) {
  if (!supabase || !connectionId) return
  const { error } = await supabase
    .from('connections')
    .update({
      disconnected_at: new Date().toISOString(),
      requests_served: stats.requestsServed || 0,
      bytes_relayed: stats.bytesRelayed || 0,
    })
    .eq('id', connectionId)
  if (error) throw error
}

export async function isSubdomainReserved(name) {
  if (!supabase) return { reserved: false }
  const { data } = await supabase
    .from('subdomains')
    .select('reserved, owner_token, device_id')
    .eq('name', name)
    .single()
  if (!data || !data.reserved) return { reserved: false }
  return { reserved: true, owner_token: data.owner_token, device_id: data.device_id }
}

export async function getDeviceSubdomain(token, deviceId) {
  if (!supabase || !token || !deviceId) return null
  const { data } = await supabase
    .from('subdomains')
    .select('name')
    .eq('owner_token', token)
    .eq('device_id', deviceId)
    .eq('reserved', true)
    .single()
  return data?.name || null
}

export async function registerDevice(token, deviceId, hostname, os) {
  if (!supabase || !token || !deviceId) return null
  const { data, error } = await supabase
    .from('devices')
    .upsert({
      device_id: deviceId,
      owner_token: token,
      hostname: hostname || null,
      os: os || null,
      last_seen: new Date().toISOString(),
    }, { onConflict: 'device_id' })
    .select('id')
    .single()
  if (error) throw error
  return data?.id
}

// Get the reserved subdomain for a token (if any)
export async function getReservedSubdomain(token) {
  if (!supabase || !token) return null
  const { data } = await supabase
    .from('subdomains')
    .select('name')
    .eq('owner_token', token)
    .eq('reserved', true)
    .limit(1)
    .single()
  return data?.name || null
}

// Check if a subdomain is reserved by a different token
export async function isSubdomainReservedByOther(name, token) {
  if (!supabase) return false
  const { data } = await supabase
    .from('subdomains')
    .select('owner_token')
    .eq('name', name)
    .eq('reserved', true)
    .single()
  if (!data) return false
  return data.owner_token !== token
}

// Get token claim status and info
export async function getTokenInfo(token) {
  if (!supabase || !token) return null
  const { data } = await supabase
    .from('tokens')
    .select('*')
    .eq('api_key', token)
    .single()
  return data || null
}

// Get all reserved subdomains for a token
export async function getReservedSubdomains(token) {
  if (!supabase || !token) return []
  const { data } = await supabase
    .from('subdomains')
    .select('name, last_seen, device_id')
    .eq('owner_token', token)
    .eq('reserved', true)
  return data || []
}

// Claim a token (link to email)
export async function claimToken(token, email) {
  if (!supabase || !token) return null
  const { data, error } = await supabase
    .from('tokens')
    .upsert({
      api_key: token,
      email,
      claimed_at: new Date().toISOString()
    }, { onConflict: 'api_key' })
    .select()
    .single()
  if (error) throw error
  return data
}

// Reserve a subdomain for a token
export async function reserveSubdomain(token, subdomain, deviceId) {
  if (!supabase || !token || !subdomain) return false
  const row = {
    name: subdomain,
    owner_token: token,
    reserved: true,
    last_seen: new Date().toISOString()
  }
  if (deviceId) row.device_id = deviceId
  const { error } = await supabase
    .from('subdomains')
    .upsert(row, { onConflict: 'name' })
  if (error) throw error
  return true
}

// Unreserve a subdomain
export async function unreserveSubdomain(token, subdomain) {
  if (!supabase || !token || !subdomain) return false
  const { error } = await supabase
    .from('subdomains')
    .update({ reserved: false, owner_token: null })
    .eq('name', subdomain)
    .eq('owner_token', token)
  if (error) throw error
  return true
}
