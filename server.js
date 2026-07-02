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
  purgeSharedGuestWorkspace,
  uploadAsset,
  getUserFromToken,
  getSubscription,
  getSubscriptionBySubId,
  upsertSubscription,
} from './server/supabase.js'
import {
  isStripeConfigured,
  createCheckoutSession,
  getCheckoutSession,
  createBillingPortalSession,
  constructEvent,
  getSubscription as getStripeSubscription,
  mapStatus,
  periodEndFrom,
} from './server/stripe.js'

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

// Stripe webhook MUST receive the raw, unparsed body for signature verification,
// so it is registered before the JSON body parser below.
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!isStripeConfigured()) return res.status(200).json({ ok: true })
  const signature = req.headers['stripe-signature']
  let event
  try {
    event = constructEvent(req.body, signature)
  } catch (err) {
    console.warn('[stripe] webhook signature verification failed:', err.message)
    return res.status(400).json({ error: `Webhook Error: ${err.message}` })
  }

  try {
    await handleStripeEvent(event)
    res.json({ received: true })
  } catch (err) {
    console.warn('[stripe] webhook handler error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

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
 *  - With no token → 401 (guest/tutorial data stays local-only in the browser).
 *  - With an invalid/expired token → { error } so the caller can return 401.
 */
async function resolveUserId(req) {
  const header = req.headers['authorization'] || ''
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null
  if (!token) return { error: 'Authentication required' }
  const user = await getUserFromToken(token)
  if (!user) return { error: 'Invalid or expired session' }
  return { userId: user.id }
}

/**
 * Whether a stored subscription row currently grants access. During the free
 * trial PayPal reports the subscription as ACTIVE, so "active" covers the trial
 * too. A cancelled subscription still has access until the paid period ends.
 */
function subscriptionIsActive(sub) {
  if (!sub) return false
  if (sub.status === 'active') return true
  if (sub.status === 'cancelled' && sub.current_period_end) {
    return new Date(sub.current_period_end).getTime() > Date.now()
  }
  return false
}

/**
 * Gate the expensive AI endpoints behind an active trial/subscription — but only
 * when billing is actually configured. Guests (no token) keep the tutorial
 * teaser; signed-in users must have started their trial.
 *
 * Returns { ok: true } to proceed, or { ok: false, status, error } to reject.
 */
async function requireActiveSubscription(req) {
  // Billing not set up (local/dev) → don't gate anything.
  if (!isStripeConfigured() || !isSupabaseConfigured()) return { ok: true }

  const header = req.headers['authorization'] || ''
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null
  // No/!invalid token → treat as guest (tutorial teaser stays free).
  if (!token) return { ok: true, guest: true }
  const user = await getUserFromToken(token)
  if (!user) return { ok: true, guest: true }

  const sub = await getSubscription(user.id)
  if (subscriptionIsActive(sub)) return { ok: true, userId: user.id }
  return { ok: false, status: 402, error: 'A free trial or subscription is required.' }
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

// Domains that reliably allow iframe embedding (great for "embed on canvas").
const EMBED_FRIENDLY_DOMAINS = [
  'wikipedia.org', 'wikimedia.org', 'wiktionary.org', 'wikibooks.org', 'simple.wikipedia.org',
  'youtube.com', 'youtu.be', 'vimeo.com',
  'archive.org', 'arxiv.org', 'gutenberg.org', 'openstax.org', 'khanacademy.org',
  'ourworldindata.org', 'observablehq.com', 'plato.stanford.edu', 'biorxiv.org', 'medrxiv.org',
]
// Domains that block framing (X-Frame-Options/CSP) — avoid when an equivalent exists.
const EMBED_HOSTILE_DOMAINS = [
  'investopedia.com', 'britannica.com', 'nytimes.com', 'bloomberg.com', 'wsj.com', 'ft.com',
  'economist.com', 'forbes.com', 'reuters.com', 'reddit.com', 'medium.com', 'quora.com',
  'twitter.com', 'x.com', 'facebook.com', 'instagram.com', 'linkedin.com', 'statista.com',
  'sciencedirect.com', 'jstor.org', 'springer.com', 'onlinelibrary.wiley.com', 'tandfonline.com',
  'cloudflare.com',
]

function embedScore(url) {
  let host
  try {
    host = new URL(url).hostname.replace(/^www\./, '').toLowerCase()
  } catch {
    return 0
  }
  const matches = (list) => list.some((d) => host === d || host.endsWith('.' + d))
  if (matches(EMBED_HOSTILE_DOMAINS)) return -3
  if (matches(EMBED_FRIENDLY_DOMAINS)) return 2
  if (/(^|\.)gov(\.|$)|(^|\.)edu(\.|$)/.test(host)) return 1
  return 0
}

// Stable sort that floats embed-friendly results to the top while preserving
// the search engine's relevance order within each tier. Pure/in-memory, so it
// adds no latency to the response.
function rankByEmbeddability(results) {
  return results
    .map((r, i) => ({ r, i, s: embedScore(r.url) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.r)
}

// Web research endpoint — used before every exploration response
app.post('/api/research', async (req, res) => {
  const { query } = req.body
  if (!query?.trim()) return res.status(400).json({ error: 'Query required' })

  const access = await requireActiveSubscription(req)
  if (!access.ok) return res.status(access.status).json({ error: access.error, code: 'subscription_required' })

  try {
    // Pull a slightly larger pool so the embeddable re-ranking has room to work.
    const raw = rankByEmbeddability(await searchWeb(query.trim(), 8))
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

  const access = await requireActiveSubscription(req)
  if (!access.ok) return res.status(access.status).json({ error: access.error, code: 'subscription_required' })

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

  const access = await requireActiveSubscription(req)
  if (!access.ok) return res.status(access.status).json({ error: access.error, code: 'subscription_required' })

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

  const access = await requireActiveSubscription(req)
  if (!access.ok) return res.status(access.status).json({ error: access.error, code: 'subscription_required' })

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
  const access = await requireActiveSubscription(req)
  if (!access.ok) return res.status(access.status).json({ error: access.error, code: 'subscription_required' })
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
  const access = await requireActiveSubscription(req)
  if (!access.ok) return res.status(access.status).json({ error: access.error, code: 'subscription_required' })
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
    // Any X-Frame-Options value (DENY, SAMEORIGIN, ALLOW-FROM ...) blocks
    // embedding into an arbitrary third-party origin like ours.
    if (xfo) {
      return { embeddable: false, reason: `X-Frame-Options: ${xfo}` }
    }
    // CSP frame-ancestors gates framing. Only consider it embeddable when it
    // explicitly allows any origin (contains a wildcard or a bare scheme).
    const faMatch = csp.match(/frame-ancestors\s+([^;]+)/i)
    if (faMatch) {
      const dirs = faMatch[1].trim().toLowerCase()
      // Embeddable from any origin only if there's a bare wildcard or a bare
      // scheme source (e.g. `https:`). Specific allowlists won't include us.
      const allowsAny = /(^|\s)\*(\s|$)/.test(dirs) || /(^|\s)https?:(\s|$)/.test(dirs)
      if (!allowsAny) {
        return { embeddable: false, reason: `CSP frame-ancestors ${dirs}` }
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

    // Use GET (what the iframe actually does) — many servers return different
    // framing headers for HEAD vs GET, which caused false "embeddable" results.
    const response = await fetch(url, { method: 'GET', signal: controller.signal, ...fetchOpts })
    clearTimeout(timer)
    // We only need the headers; free the body so we don't download the page.
    try { response.body?.cancel() } catch { /* ignore */ }

    return res.json(checkHeaders(response.headers))
  } catch (err) {
    // Can't verify — default to NOT directly embeddable so the client falls
    // back to the reader-proxy (which always works) instead of a broken frame.
    return res.json({ embeddable: false, reason: 'unreachable' })
  }
})

// Link preview: fetch a page server-side and extract Open Graph / meta info so
// the client can render a rich, reliable preview card for sites that block
// direct framing (and that bot-wall the reader-proxy). Always returns JSON.
app.get('/api/preview', async (req, res) => {
  const { url } = req.query

  const domainOf = (u) => {
    try {
      return new URL(u).hostname.replace(/^www\./, '')
    } catch {
      return ''
    }
  }

  if (!url || typeof url !== 'string') {
    return res.json({ blocked: true, url: '', domain: '' })
  }
  let parsedUrl
  try {
    parsedUrl = new URL(url)
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('protocol')
  } catch {
    return res.json({ blocked: true, url, domain: domainOf(url) })
  }

  const decode = (s) =>
    (s || '')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;/g, "'")
      .replace(/&#x27;/gi, "'")
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim()

  const pick = (html, names) => {
    for (const name of names) {
      const re1 = new RegExp(
        `<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"']*)["']`,
        'i'
      )
      const re2 = new RegExp(
        `<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${name}["']`,
        'i'
      )
      const m = html.match(re1) || html.match(re2)
      if (m && m[1] && m[1].trim()) return decode(m[1])
    }
    return ''
  }

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10000)
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    })
    clearTimeout(timer)

    const finalUrl = response.url || url
    const domain = domainOf(finalUrl)
    const html = (await response.text()).slice(0, 600000)

    const titleTag = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').trim()
    const title = pick(html, ['og:title', 'twitter:title']) || decode(titleTag)
    const description = pick(html, ['og:description', 'twitter:description', 'description'])
    let image = pick(html, ['og:image:secure_url', 'og:image', 'twitter:image', 'twitter:image:src'])
    const siteName = pick(html, ['og:site_name'])

    // Favicon (best effort) — resolve relative to the page origin.
    let favicon = ''
    const iconMatch =
      html.match(/<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]+href=["']([^"']+)["']/i) ||
      html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["'][^"']*icon[^"']*["']/i)
    try {
      const origin = new URL(finalUrl).origin
      favicon = iconMatch?.[1] ? new URL(iconMatch[1], finalUrl).href : `${origin}/favicon.ico`
      if (image) image = new URL(image, finalUrl).href
    } catch {
      /* ignore */
    }

    // Detect bot-walls / JS-gates so the client shows a graceful card.
    const blockedSignal =
      /just a moment|attention required|enable javascript|access denied|are you a (human|robot)|verify you are human|cf-browser-verification/i.test(
        title + ' ' + html.slice(0, 2000)
      )
    const blocked = blockedSignal || (!title && !description && !image)

    return res.json({
      url: finalUrl,
      domain,
      title: blocked ? '' : title,
      description: blocked ? '' : description,
      image: blocked ? '' : image,
      siteName: siteName || domain,
      favicon,
      blocked,
    })
  } catch (err) {
    return res.json({ blocked: true, url, domain: domainOf(url) })
  }
})

// Reader-proxy: fetch a page server-side, strip framing headers and scripts,
// and inject a <base> tag so relative assets/links still resolve. This lets us
// render a safe, framable preview of sites that block direct embedding via
// X-Frame-Options / CSP. Scripts are removed so nothing untrusted runs, and the
// iframe that loads this is sandboxed without script/same-origin privileges.
app.get('/api/proxy', async (req, res) => {
  const { url } = req.query

  const fallbackPage = (message, target) => `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{height:100%;margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f5f5f6;color:#444}
.wrap{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;text-align:center;padding:24px}
a{color:#2563eb;text-decoration:none;border:1px solid #d4d4d8;background:#fff;border-radius:8px;padding:8px 14px;font-size:13px}
a:hover{background:#f0f0f2}p{font-size:13px;color:#666;max-width:340px;line-height:1.5}</style></head>
<body><div class="wrap"><p>${message}</p>${target ? `<a href="${target}" target="_blank" rel="noopener noreferrer">Open in new tab</a>` : ''}</div></body></html>`

  res.set('Content-Type', 'text/html; charset=utf-8')

  if (!url || typeof url !== 'string') {
    return res.status(400).send(fallbackPage('No URL provided.'))
  }
  let parsedUrl
  try {
    parsedUrl = new URL(url)
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('protocol')
  } catch {
    return res.status(400).send(fallbackPage('That link is not a valid web address.'))
  }

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 12000)
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/*,*/*;q=0.8',
      },
    })
    clearTimeout(timer)

    const contentType = response.headers.get('content-type') || ''
    const finalUrl = response.url || url

    // Non-HTML (images, PDFs, etc.) — stream the bytes through, framable.
    if (!contentType.includes('text/html')) {
      const buf = Buffer.from(await response.arrayBuffer())
      res.set('Content-Type', contentType || 'application/octet-stream')
      return res.send(buf)
    }

    let html = await response.text()
    // Drop existing <base> tags, then strip scripts (prevents frame-busting and
    // keeps untrusted JS from running) and remove any inline framing headers.
    html = html
      .replace(/<base[^>]*>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<meta[^>]+http-equiv=["']?(content-security-policy|x-frame-options)["']?[^>]*>/gi, '')

    const markCss =
      '<style>' +
      '::highlight(odin-pending){background-color:rgba(255,196,46,.65);color:inherit}' +
      '::highlight(odin-mark){background-color:rgba(255,196,46,.42);color:inherit}' +
      '.branch-mark,.branch-mark-pending{display:inline!important;box-decoration-break:clone;-webkit-box-decoration-break:clone;color:inherit!important}' +
      '.branch-mark{background-color:rgba(255,196,46,.42)!important;border-bottom:2px solid rgba(180,120,0,.75)!important;border-radius:2px}' +
      '.branch-mark-pending{background-color:rgba(255,196,46,.65)!important;border-bottom:2.5px solid rgba(160,100,0,.9)!important;border-radius:2px;box-shadow:0 0 0 2px rgba(255,196,46,.35)}' +
      '</style>'
    const baseTag = `<base href="${finalUrl}" target="_blank">${markCss}`
    if (/<head[^>]*>/i.test(html)) {
      html = html.replace(/(<head[^>]*>)/i, `$1${baseTag}`)
    } else if (/<html[^>]*>/i.test(html)) {
      html = html.replace(/(<html[^>]*>)/i, `$1<head>${baseTag}</head>`)
    } else {
      html = `${baseTag}${html}`
    }

    return res.send(html)
  } catch (err) {
    return res
      .status(502)
      .send(fallbackPage("This site couldn't be loaded for preview.", url))
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

// ── Subscriptions / Stripe (card-required free trial) ──

// Current user's subscription status. Used by the frontend paywall gate.
app.get('/api/subscription', async (req, res) => {
  // Billing off → treat everyone as entitled so local/dev isn't gated.
  if (!isStripeConfigured() || !isSupabaseConfigured()) {
    return res.json({ active: true, status: 'unconfigured', billingEnabled: false })
  }
  const { userId, error } = await resolveUserId(req)
  if (error) return res.status(401).json({ error })
  try {
    const sub = await getSubscription(userId)
    res.json({
      active: subscriptionIsActive(sub),
      status: sub?.status || 'none',
      currentPeriodEnd: sub?.current_period_end || null,
      billingEnabled: true,
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Start the card-required free trial: create a hosted Checkout Session and
// return its URL for the frontend to redirect to.
app.post('/api/stripe/create-checkout-session', async (req, res) => {
  if (!isStripeConfigured()) return res.status(501).json({ error: 'Stripe not configured' })
  const { userId, error } = await resolveUserId(req)
  if (error) return res.status(401).json({ error })
  try {
    const user = await getUserFromToken((req.headers['authorization'] || '').slice(7).trim())
    const origin = req.headers.origin || `${req.protocol}://${req.get('host')}`
    const url = await createCheckoutSession({ userId, email: user?.email, origin })
    res.json({ url })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Confirm a completed Checkout Session immediately (doesn't rely on the webhook,
// so entitlement is granted the instant the user returns from Stripe).
app.post('/api/stripe/confirm', async (req, res) => {
  if (!isStripeConfigured()) return res.status(501).json({ error: 'Stripe not configured' })
  const { userId, error } = await resolveUserId(req)
  if (error) return res.status(401).json({ error })
  const sessionId = (req.body?.sessionId || '').trim()
  if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' })

  try {
    const session = await getCheckoutSession(sessionId)
    // Security: only accept a session that belongs to this signed-in user.
    const owner = session.metadata?.user_id || session.client_reference_id
    if (owner && owner !== userId) {
      return res.status(403).json({ error: 'Session does not belong to this user' })
    }
    const subscription = session.subscription
    if (subscription && typeof subscription === 'object') {
      await upsertSubscription(userId, {
        customer_id: subscription.customer || session.customer || null,
        subscription_id: subscription.id,
        status: mapStatus(subscription.status),
        current_period_end: periodEndFrom(subscription),
      })
    }
    const sub = await getSubscription(userId)
    res.json({ active: subscriptionIsActive(sub), status: sub?.status || 'none', billingEnabled: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Open the Stripe Customer Portal (cancel / update card / view invoices).
app.post('/api/stripe/create-portal-session', async (req, res) => {
  if (!isStripeConfigured()) return res.status(501).json({ error: 'Stripe not configured' })
  const { userId, error } = await resolveUserId(req)
  if (error) return res.status(401).json({ error })
  try {
    const sub = await getSubscription(userId)
    if (!sub?.customer_id) {
      return res.status(400).json({ error: 'No subscription to manage', code: 'no_customer' })
    }
    const origin = req.headers.origin || `${req.protocol}://${req.get('host')}`
    const url = await createBillingPortalSession({ customerId: sub.customer_id, returnUrl: `${origin}/` })
    res.json({ url })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

/**
 * Apply a Stripe webhook event to the stored subscription. Kept authoritative
 * across the lifecycle (trial start, renewals, cancellations, payment failures).
 */
async function handleStripeEvent(event) {
  const obj = event.data?.object || {}

  // Resolve the subscription + user id depending on the event shape.
  let subscription = null
  let userId = null

  if (event.type === 'checkout.session.completed') {
    userId = obj.metadata?.user_id || obj.client_reference_id || null
    if (obj.subscription) subscription = await getStripeSubscription(obj.subscription)
  } else if (event.type.startsWith('customer.subscription.')) {
    subscription = obj
    userId = obj.metadata?.user_id || null
  } else if (event.type === 'invoice.payment_failed' || event.type === 'invoice.payment_succeeded') {
    if (obj.subscription) subscription = await getStripeSubscription(obj.subscription)
    userId = subscription?.metadata?.user_id || null
  } else {
    return // event we don't care about
  }

  if (!subscription) return

  // If the event didn't carry our user id, fall back to the stored mapping.
  if (!userId) {
    const existing = await getSubscriptionBySubId(subscription.id)
    userId = existing?.user_id || null
  }
  if (!userId) return

  await upsertSubscription(userId, {
    customer_id: subscription.customer || null,
    subscription_id: subscription.id,
    status: mapStatus(subscription.status),
    current_period_end: periodEndFrom(subscription),
  })
}

if (isProduction) {
  app.get('/privacy', (_req, res) => {
    res.sendFile(path.join(distPath, 'privacy/index.html'))
  })
  app.get('/terms', (_req, res) => {
    res.sendFile(path.join(distPath, 'terms/index.html'))
  })
  app.get('/signup-complete', (_req, res) => {
    res.sendFile(path.join(distPath, 'index.html'))
  })
  app.use(express.static(distPath))
  app.get('*', (_req, res) => {
    res.sendFile(path.join(distPath, 'index.html'))
  })
}

app.listen(PORT, async () => {
  if (isSupabaseConfigured()) {
    try {
      await ensureBuckets()
      await purgeSharedGuestWorkspace()
    } catch (err) {
      console.warn('  Supabase bucket setup warning:', err.message)
    }
  }
  console.log(`\n  Odin ${isProduction ? 'production' : 'API'} server on http://localhost:${PORT}`)
  console.log(`  API key: ${process.env.ANTHROPIC_API_KEY ? '✓ loaded from .env' : '✗ not set (use in-app settings)'}`)
  console.log(`  Research: ${process.env.TAVILY_API_KEY ? '✓ Tavily' : '○ DuckDuckGo fallback (set TAVILY_API_KEY for better results)'}`)
  console.log(`  Image gen: ${process.env.OPENAI_API_KEY ? '✓ GPT Image (gpt-image-1)' : process.env.GOOGLE_API_KEY ? '✓ Gemini Imagen' : process.env.REPLICATE_API_KEY ? '✓ Flux Pro' : '○ PubChem + web photos only (add OPENAI_API_KEY for best quality)'}`)
  console.log(`  Cloud sync: ${isSupabaseConfigured() ? '✓ Supabase (state + assets)' : '○ localStorage only (set SUPABASE_URL + SUPABASE_SECRET_KEY)'}`)
  console.log(`  Billing: ${isStripeConfigured() ? '✓ Stripe free-trial paywall enabled' : '○ open access (set STRIPE_SECRET_KEY + STRIPE_PRICE_ID to enable)'}`)
  if (!isProduction) console.log(`\n  Frontend: http://localhost:5173\n`)
})
