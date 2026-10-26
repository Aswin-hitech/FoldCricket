/**
 * Vercel Serverless Function: /api/log-ip
 * Extracts client IP and Vercel geo headers, and uploads a log record
 * directly into the configured Supabase Storage bucket.
 */

export default async function handler(req, res) {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Credentials', 'true')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST')
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-Type'
  )

  if (req.method === 'OPTIONS') {
    return res.status(200).end()
  }

  const headers = req.headers || {}

  // Resolve client IP using Vercel, Cloudflare, and standard proxy headers
  const rawVercel = headers['x-vercel-forwarded-for']
  const rawForwarded = headers['x-forwarded-for']
  const ip =
    (rawVercel ? String(rawVercel).split(',')[0].trim() : null) ||
    (rawForwarded ? String(rawForwarded).split(',')[0].trim() : null) ||
    headers['x-real-ip'] ||
    headers['cf-connecting-ip'] ||
    req.socket?.remoteAddress ||
    'unknown'

  // Vercel Geolocation headers
  const geo = {
    country: headers['x-vercel-ip-country'] || null,
    region: headers['x-vercel-ip-country-region'] || null,
    city: headers['x-vercel-ip-city'] || null,
    latitude: headers['x-vercel-ip-latitude'] || null,
    longitude: headers['x-vercel-ip-longitude'] || null,
    timezone: headers['x-vercel-ip-timezone'] || null,
  }

  let body = {}
  if (req.body) {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body
  }
  const action = body.action || 'visit'

  const supabaseUrl = process.env.SUPABASE_URL
  const supabaseKey =
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_PUBLISHABLE_KEY ||
    process.env.SUPABASE_ANON_KEY
  const bucketName = process.env.SUPABASE_BUCKET_NAME || 'ip-logs'

  let uploaded = false
  let uploadError = null

  if (supabaseUrl && supabaseKey) {
    try {
      const now = new Date()
      const dateStr = now.toISOString().split('T')[0]
      const timestampMs = Date.now()
      const cleanIp = String(ip).replace(/[:.]/g, '_')
      const filePath = `records/${dateStr}/${cleanIp}_${timestampMs}_${action}.json`

      const payload = {
        ip,
        action,
        timestamp_utc: now.toISOString(),
        date: dateStr,
        geo,
        headers: {
          'user-agent': headers['user-agent'],
          'referer': headers['referer'],
          'accept-language': headers['accept-language'],
        },
        metadata: body,
      }

      const uploadUrl = `${supabaseUrl.replace(/\/$/, '')}/storage/v1/object/${bucketName}/${filePath}`
      const uploadRes = await fetch(uploadUrl, {
        method: 'POST',
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
          'x-upsert': 'true',
        },
        body: JSON.stringify(payload, null, 2),
      })

      uploaded = uploadRes.ok
      if (!uploadRes.ok) {
        uploadError = `HTTP ${uploadRes.status}`
      }
    } catch (err) {
      uploadError = err.message
    }
  }

  return res.status(200).json({
    success: true,
    ip,
    geo,
    supabase_configured: Boolean(supabaseUrl && supabaseKey),
    supabase_uploaded: uploaded,
    ...(uploadError ? { error: uploadError } : {}),
  })
}
