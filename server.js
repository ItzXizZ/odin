import express from 'express'
import Anthropic from '@anthropic-ai/sdk'
import cors from 'cors'
import multer from 'multer'
import { createRequire } from 'module'
import dotenv from 'dotenv'
import { generateVisualAsset, proxyImage } from './server/visual.js'

dotenv.config()

const require = createRequire(import.meta.url)
const pdfParse = require('pdf-parse')

const app = express()
const PORT = process.env.PORT || 3001

app.use(cors({ origin: 'http://localhost:5173' }))
app.use(express.json({ limit: '10mb' }))

const upload = multer({ limits: { fileSize: 20 * 1024 * 1024 } })

function getClient(apiKey) {
  const key = apiKey || process.env.ANTHROPIC_API_KEY
  if (!key) throw new Error('No Anthropic API key provided')
  return new Anthropic({ apiKey: key })
}

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    hasKey: !!process.env.ANTHROPIC_API_KEY,
    hasResearch: !!(process.env.TAVILY_API_KEY),
    hasImageGen: !!(process.env.OPENAI_API_KEY || process.env.GOOGLE_API_KEY || process.env.REPLICATE_API_KEY),
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

// Visual generation — search web photos, adapt for the user's use case
app.post('/api/visual', async (req, res) => {
  const { query, apiKey, context, parentPrompt, parentResponse, excerpt, messageChain } = req.body
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

app.listen(PORT, () => {
  console.log(`\n  Odin API server running on http://localhost:${PORT}`)
  console.log(`  API key: ${process.env.ANTHROPIC_API_KEY ? '✓ loaded from .env' : '✗ not set (use in-app settings)'}`)
  console.log(`  Research: ${process.env.TAVILY_API_KEY ? '✓ Tavily' : '○ DuckDuckGo fallback (set TAVILY_API_KEY for better results)'}`)
  console.log(`  Image gen: ${process.env.OPENAI_API_KEY ? '✓ GPT Image (gpt-image-1)' : process.env.GOOGLE_API_KEY ? '✓ Gemini Imagen' : process.env.REPLICATE_API_KEY ? '✓ Flux Pro' : '○ PubChem + web photos only (add OPENAI_API_KEY for best quality)'}`)
  console.log(`\n  Frontend: http://localhost:5173\n`)
})
