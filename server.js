import express from 'express'
import Anthropic from '@anthropic-ai/sdk'
import cors from 'cors'
import multer from 'multer'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import dotenv from 'dotenv'
import { generateVisualAsset, proxyImage, decideExplorationAction } from './server/visual.js'
import {
  isSupabaseConfigured,
  ensureBuckets,
  getWorkspaceState,
  putWorkspaceState,
  uploadAsset,
  getUserFromToken,
} from './server/supabase.js'

dotenv.config()

const require = createRequire(import.meta.url)
const pdfParse = require('pdf-parse')

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const distPath = path.join(__dirname, 'dist')
const isProduction = process.env.NODE_ENV === 'production'

const app = express()
const PORT = process.env.PORT || 3001

if (!isProduction) {
  app.use(cors({ origin: 'http://localhost:5173' }))
}
app.use(express.json({ limit: '30mb' }))

const upload = multer({ limits: { fileSize: 20 * 1024 * 1024 } })

function getClient(apiKey) {
  const key = apiKey || process.env.ANTHROPIC_API_KEY
  if (!key) throw new Error('No Anthropic API key provided')
  return new Anthropic({ apiKey: key })
}

/**
 * Resolve the user making a persistence request from their bearer token.
 *  - With a valid token → that user's id (data is scoped to them).
 *  - With no token → 'default' (legacy/local mode for setups without auth).
 *  - With an invalid/expired token → { error } so the caller can return 401.
 */
async function resolveUserId(req) {
  const header = req.headers['authorization'] || ''
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null
  if (!token) return { userId: 'default' }
  const user = await getUserFromToken(token)
  if (!user) return { error: 'Invalid or expired session' }
  return { userId: user.id }
}

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    hasKey: !!process.env.ANTHROPIC_API_KEY,
    hasResearch: !!(process.env.TAVILY_API_KEY),
    hasImageGen: !!(process.env.OPENAI_API_KEY || process.env.GOOGLE_API_KEY || process.env.REPLICATE_API_KEY),
    hasSupabase: isSupabaseConfigured(),
    imageProvider: process.env.OPENAI_API_KEY
      ? 'openai'
      : process.env.GOOGLE_API_KEY
      ? 'google'
      : process.env.REPLICATE_API_KEY
      ? 'replicate'
      : null,
  })
})

function normalizeUrl(url) {
  try {
    const parsed = new URL(url.trim())
    parsed.hash = ''
    let path = parsed.pathname.replace(/\/$/, '') || '/'
    return `${parsed.protocol}//${parsed.hostname.toLowerCase()}${path}${parsed.search}`
  } catch {
    return url.trim().toLowerCase()
  }
}

function titleFromUrl(url) {
  try {
    const { hostname, pathname } = new URL(url)
    const host = hostname.replace(/^www\./, '')
    const segment = pathname.split('/').filter(Boolean).pop()
    return segment ? `${host} — ${decodeURIComponent(segment).slice(0, 48)}` : host
  } catch {
    return url.slice(0, 60)
  }
}

function unwrapDdgUrl(href) {
  const raw = href.startsWith('//') ? `https:${href}` : href
  try {
    const parsed = new URL(raw)
    const uddg = parsed.searchParams.get('uddg')
    if (uddg) return decodeURIComponent(uddg)
    return parsed.toString()
  } catch {
    return raw
  }
}

async function tavilySearch(query, maxResults = 5) {
  const apiKey = process.env.TAVILY_API_KEY
  if (!apiKey) return null

  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      search_depth: 'basic',
      max_results: maxResults,
      include_answer: false,
    }),
    signal: AbortSignal.timeout(15000),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Tavily search failed (${res.status}): ${err.slice(0, 120)}`)
  }

  const data = await res.json()
  return (data.results || []).map((r) => ({
    id: normalizeUrl(r.url),
    title: r.title || titleFromUrl(r.url),
    url: r.url,
    snippet: (r.content || '').slice(0, 400),
  }))
}

async function duckDuckGoSearch(query, maxResults = 5) {
  const res = await fetch(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; OdinWriting/1.0)',
      Accept: 'text/html',
    },
    signal: AbortSignal.timeout(10000),
  })

  if (!res.ok) throw new Error(`DuckDuckGo search failed (${res.status})`)

  const html = await res.text()
  const results = []
  const seen = new Set()
  const linkRe = /<a\s([^>]*class=['"]result-link['"][^>]*)>([\s\S]*?)<\/a>/gi
  const hrefRe = /href=['"]([^'"]+)['"]/
  const snippetRe = /<td[^>]+class=['"]?result-snippet['"]?[^>]*>([\s\S]*?)<\/td>/gi

  const links = [...html.matchAll(linkRe)]
  const snippets = [...html.matchAll(snippetRe)]

  for (let i = 0; i < links.length && results.length < maxResults; i++) {
    const hrefMatch = links[i][1].match(hrefRe)
    if (!hrefMatch) continue
    const href = unwrapDdgUrl(hrefMatch[1])
    const title = links[i][2].replace(/<[^>]+>/g, '').trim()
    const snippet = (snippets[i]?.[1] || '').replace(/<[^>]+>/g, '').trim()
    const id = normalizeUrl(href)
    if (seen.has(id) || !href.startsWith('http')) continue
    seen.add(id)
    results.push({
      id,
      title: title || titleFromUrl(href),
      url: href,
      snippet,
    })
  }

  return results
}

async function searchWeb(query, maxResults = 5) {
  const tavily = await tavilySearch(query, maxResults).catch(() => null)
  if (tavily?.length) return tavily

  const ddg = await duckDuckGoSearch(query, maxResults)
  if (ddg.length) return ddg

  return []
}

function formatResearchContext(sources) {
  if (!sources.length) return ''
  return sources
    .map(
      (s, i) =>
        `[${i + 1}] ${s.title}\nURL: ${s.url}${s.snippet ? `\nSummary: ${s.snippet}` : ''}`
    )
    .join('\n\n')
}

// Web research endpoint — used before every exploration response
app.post('/api/research', async (req, res) => {
  const { query } = req.body
  if (!query?.trim()) return res.status(400).json({ error: 'Query required' })

  try {
    const raw = await searchWeb(query.trim())
    const sources = raw.map(({ id, title, url }) => ({ id, title, url }))
    res.json({
      sources,
      context: formatResearchContext(raw),
      provider: process.env.TAVILY_API_KEY ? 'tavily' : 'duckduckgo',
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Routing — let the model decide (via tool-calling) text vs generate vs find vs ask
app.post('/api/route', async (req, res) => {
  const { prompt, messageChain, context, excerpt, apiKey } = req.body
  if (!prompt?.trim()) return res.status(400).json({ error: 'Prompt required' })

  try {
    const decision = await decideExplorationAction({
      apiKey,
      prompt: prompt.trim(),
      messageChain,
      context,
      excerpt,
    })
    res.json(decision)
  } catch (err) {
    // Degrade gracefully: if routing fails, answer in text so the app still works.
    res.json({ action: 'text', error: err.message })
  }
})

// Visual generation — search web photos, adapt for the user's use case
app.post('/api/visual', async (req, res) => {
  const { query, apiKey, context, parentPrompt, parentResponse, excerpt, messageChain, method } =
    req.body
  if (!query?.trim()) return res.status(400).json({ error: 'Query required' })

  try {
    const visual = await generateVisualAsset({
      query: query.trim(),
      apiKey,
      context,
      parentPrompt,
      parentResponse,
      excerpt,
      messageChain,
      method,
    })
    res.json(visual)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Proxy external images (CORS-safe display)
app.get('/api/image-proxy', async (req, res) => {
  const url = req.query.url
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'URL required' })

  try {
    const jpeg = await proxyImage(url)
    res.setHeader('Content-Type', 'image/jpeg')
    res.setHeader('Cache-Control', 'public, max-age=86400')
    res.send(jpeg)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Streaming chat endpoint — SSE
app.post('/api/chat', async (req, res) => {
  const { messages, system, apiKey } = req.body

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  try {
    const client = getClient(apiKey)
    const stream = client.messages.stream({
      model: 'claude-sonnet-4-5',
      max_tokens: 8096,
      ...(system ? { system } : {}),
      messages,
    })

    for await (const event of stream) {
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta'
      ) {
        res.write(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`)
      }
    }

    res.write('data: [DONE]\n\n')
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`)
  } finally {
    res.end()
  }
})

// Tool-calling chat — returns the raw content blocks (text + tool_use) so the
// client can apply agentic actions (e.g. Stylism network updates)
app.post('/api/chat/tools', async (req, res) => {
  const { messages, system, apiKey, tools, maxTokens } = req.body
  if (!Array.isArray(tools) || tools.length === 0) {
    return res.status(400).json({ error: 'Tools required' })
  }
  try {
    const client = getClient(apiKey)
    const response = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: maxTokens || 1024,
      ...(system ? { system } : {}),
      messages,
      tools,
    })
    res.json({ content: response.content, stop_reason: response.stop_reason })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Non-streaming chat for simpler calls
app.post('/api/chat/sync', async (req, res) => {
  const { messages, system, apiKey, maxTokens } = req.body
  try {
    const client = getClient(apiKey)
    const response = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: maxTokens || 2048,
      ...(system ? { system } : {}),
      messages,
    })
    res.json({ content: response.content[0].text })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// PDF parsing
app.post('/api/upload-pdf', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' })
  try {
    const data = await pdfParse(req.file.buffer)
    res.json({
      text: data.text,
      pages: data.numpages,
      info: data.info,
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Check whether a URL allows iframe embedding by inspecting its response headers.
// We make a HEAD request (fallback to GET with Range) from the server side so we
// bypass browser CORS restrictions. Returns { embeddable: boolean, reason?: string }.
app.get('/api/can-embed', async (req, res) => {
  const { url } = req.query
  if (!url || typeof url !== 'string') {
    return res.json({ embeddable: false, reason: 'no url' })
  }

  let parsedUrl
  try {
    parsedUrl = new URL(url)
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return res.json({ embeddable: false, reason: 'unsupported protocol' })
    }
  } catch {
    return res.json({ embeddable: false, reason: 'invalid url' })
  }

  const checkHeaders = (headers) => {
    const xfo = (headers.get('x-frame-options') || '').trim().toUpperCase()
    const csp = headers.get('content-security-policy') || ''
    if (xfo === 'DENY' || xfo === 'SAMEORIGIN') {
      return { embeddable: false, reason: `X-Frame-Options: ${xfo}` }
    }
    // CSP frame-ancestors 'none' or 'self' (without wildcards) blocks embedding
    const faMatch = csp.match(/frame-ancestors\s+([^;]+)/i)
    if (faMatch) {
      const dirs = faMatch[1].trim().toLowerCase()
      if (dirs === "'none'" || dirs === 'none') {
        return { embeddable: false, reason: "CSP frame-ancestors 'none'" }
      }
      if (dirs === "'self'" || dirs === 'self') {
        return { embeddable: false, reason: "CSP frame-ancestors 'self'" }
      }
    }
    return { embeddable: true }
  }

  const fetchOpts = {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,*/*',
    },
    redirect: 'follow',
  }

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 6000)

    let response
    try {
      response = await fetch(url, { method: 'HEAD', signal: controller.signal, ...fetchOpts })
    } catch {
      // Some servers reject HEAD — retry with GET + early abort via Range
      response = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
        headers: { ...fetchOpts.headers, Range: 'bytes=0-0' },
        redirect: 'follow',
      })
    }
    clearTimeout(timer)

    return res.json(checkHeaders(response.headers))
  } catch (err) {
    // Network/timeout — assume embeddable so the user can still try
    return res.json({ embeddable: true, reason: 'unreachable' })
  }
})

// ── Supabase-backed cloud persistence ──

// Load the signed-in user's workspace state blob.
app.get('/api/workspace', async (req, res) => {
  if (!isSupabaseConfigured()) return res.status(501).json({ error: 'Supabase not configured' })
  const { userId, error } = await resolveUserId(req)
  if (error) return res.status(401).json({ error })
  try {
    const value = await getWorkspaceState(userId)
    res.json({ value })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Save the signed-in user's workspace state blob.
app.put('/api/workspace', async (req, res) => {
  if (!isSupabaseConfigured()) return res.status(501).json({ error: 'Supabase not configured' })
  const { userId, error } = await resolveUserId(req)
  if (error) return res.status(401).json({ error })
  const { value } = req.body || {}
  if (typeof value !== 'string') return res.status(400).json({ error: 'Missing string "value"' })
  try {
    await putWorkspaceState(userId, value)
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Upload a binary asset (image / thumbnail / generated visual) and return its public URL.
app.post('/api/storage/upload', async (req, res) => {
  if (!isSupabaseConfigured()) return res.status(501).json({ error: 'Supabase not configured' })
  const { userId, error } = await resolveUserId(req)
  if (error) return res.status(401).json({ error })
  const { dataUrl, base64, contentType, name } = req.body || {}
  if (!dataUrl && !base64) return res.status(400).json({ error: 'Missing "dataUrl" or "base64"' })
  try {
    const url = await uploadAsset({ dataUrl, base64, contentType, name, userId })
    res.json({ url })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

if (isProduction) {
  app.use(express.static(distPath))
  app.get('*', (_req, res) => {
    res.sendFile(path.join(distPath, 'index.html'))
  })
}

app.listen(PORT, async () => {
  if (isSupabaseConfigured()) {
    try {
      await ensureBuckets()
    } catch (err) {
      console.warn('  Supabase bucket setup warning:', err.message)
    }
  }
  console.log(`\n  Odin ${isProduction ? 'production' : 'API'} server on http://localhost:${PORT}`)
  console.log(`  API key: ${process.env.ANTHROPIC_API_KEY ? '✓ loaded from .env' : '✗ not set (use in-app settings)'}`)
  console.log(`  Research: ${process.env.TAVILY_API_KEY ? '✓ Tavily' : '○ DuckDuckGo fallback (set TAVILY_API_KEY for better results)'}`)
  console.log(`  Image gen: ${process.env.OPENAI_API_KEY ? '✓ GPT Image (gpt-image-1)' : process.env.GOOGLE_API_KEY ? '✓ Gemini Imagen' : process.env.REPLICATE_API_KEY ? '✓ Flux Pro' : '○ PubChem + web photos only (add OPENAI_API_KEY for best quality)'}`)
  console.log(`  Cloud sync: ${isSupabaseConfigured() ? '✓ Supabase (state + assets)' : '○ localStorage only (set SUPABASE_URL + SUPABASE_SECRET_KEY)'}`)
  if (!isProduction) console.log(`\n  Frontend: http://localhost:5173\n`)
})
