/**
 * Vercel Serverless Function: /api/feedback
 * Collects player first-game feedback reports and persists them directly
 * to the configured Supabase Storage bucket and Database table.
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

  const playerId = body.player_id || 'unknown'
  const playerName = body.player_name || 'Anonymous Player'
  const rating = Number(body.rating) || 5
  const feedbackText = String(body.feedback_text || '').trim()
  const categories = Array.isArray(body.categories) ? body.categories : []
  const roomCode = body.room_code || null
  const metadata = body.metadata || {}

  const supabaseUrl = process.env.SUPABASE_URL
  const supabaseKey =
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_PUBLISHABLE_KEY ||
    process.env.SUPABASE_ANON_KEY
  const bucketName = process.env.SUPABASE_BUCKET_NAME || 'ip-logs'

  let storageUploaded = false
  let dbInserted = false
  let uploadError = null

  if (supabaseUrl && supabaseKey) {
    const now = new Date()
    const dateStr = now.toISOString().split('T')[0]
    const timestampMs = Date.now()
    const cleanId = String(playerId).replace(/[:.-]/g, '_')
    const filePath = `feedback/${dateStr}/${cleanId}_${timestampMs}.json`

    const payload = {
      player_id: playerId,
      player_name: playerName,
      rating,
      feedback_text: feedbackText,
      categories,
      room_code: roomCode,
      ip,
      geo,
      timestamp_utc: now.toISOString(),
      date: dateStr,
      headers: {
        'user-agent': headers['user-agent'],
        referer: headers['referer'],
      },
      metadata,
    }

    // 1. Upload to Supabase Storage Bucket
    try {
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
      storageUploaded = uploadRes.ok
    } catch (err) {
      uploadError = String(err)
    }

    // 2. Attempt direct table insert to Supabase Database 'feedback'
    try {
      const dbUrl = `${supabaseUrl.replace(/\/$/, '')}/rest/v1/feedback`
      const dbRes = await fetch(dbUrl, {
        method: 'POST',
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({
          player_id: playerId,
          player_name: playerName,
          rating,
          feedback_text: feedbackText,
          categories,
          room_code: roomCode,
          ip,
          metadata,
        }),
      })
      dbInserted = dbRes.ok
    } catch {
      // Table may not exist yet, storage backup succeeded
    }
  }

  return res.status(200).json({
    success: true,
    storage_uploaded: storageUploaded,
    db_inserted: dbInserted,
    error: uploadError,
  })
}
