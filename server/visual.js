import Anthropic from '@anthropic-ai/sdk'
import sharp from 'sharp'

const UA = 'Mozilla/5.0 (compatible; OdinWriting/1.0)'

const DRUG_ALIASES = {
  adderall: 'amphetamine',
  addheral: 'amphetamine',
  ritalin: 'methylphenidate',
  concerta: 'methylphenidate',
  provigil: 'modafinil',
  vyvanse: 'lisdexamfetamine',
  caffeine: 'caffeine',
  modafinil: 'modafinil',
  piracetam: 'piracetam',
}

function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function parseJsonFromText(text) {
  if (!text?.trim()) throw new Error('Empty model response')

  const attempts = []
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced?.[1]) attempts.push(fenced[1].trim())
  attempts.push(text.trim())

  const brace = text.match(/\{[\s\S]*\}/)
  if (brace?.[0]) attempts.push(brace[0])

  for (const raw of attempts) {
    try {
      return JSON.parse(raw)
    } catch {
      // try next candidate
    }
  }

  throw new Error('Could not parse JSON from model response')
}

function safeParseJson(text, fallback) {
  try {
    return parseJsonFromText(text)
  } catch {
    return fallback
  }
}

const MOLECULE_NAMES =
  /\b(cortisol|dopamine|serotonin|melatonin|testosterone|estrogen|insulin|adrenaline|epinephrine|norepinephrine|oxytocin|glucose|caffeine|modafinil|amphetamine|methylphenidate|piracetam)\b/i

/** PubChem only for isolated 2D structure requests — not diagrams, interactions, or processes. */
function wantsPubChemStructure(query, messageChain = []) {
  const combined = [query, ...(messageChain || []).map((m) => m.content)].join(' ').toLowerCase()

  if (
    /\b(receptor|interaction|interacting|interact|binding|binds|bound|pathway|mechanism|synapse|synaptic|cascade|process|diagram|sketch|illustration|infographic|specifically|show(s)? .+ (with|to|and|at)|neurotransmitter.+(with|and|at)|how .+ works)\b/.test(
      combined
    )
  ) {
    return false
  }

  if (/\b(chemical structure|molecular structure|structural formula|2d structure|structure diagram only)\b/.test(combined)) {
    return true
  }

  if (MOLECULE_NAMES.test(query) && /\b(what .+ looks like|structure of|sketch of what)\b/i.test(query)) {
    return true
  }

  return false
}

function inferIntentFromContext(query, messageChain = []) {
  const combined = [query, ...(messageChain || []).map((m) => m.content)].join(' ').toLowerCase()

  if (
    /\b(receptor|interaction|interacting|binding|synapse|pathway|mechanism|process|diagram|sketch|illustration|how .+ works)\b/.test(
      combined
    )
  ) {
    return 'diagram'
  }

  if (wantsPubChemStructure(query, messageChain)) {
    return 'chemical_structure'
  }

  return 'illustration'
}

function toDataUrl(buffer, mime = 'image/png') {
  return `data:${mime};base64,${buffer.toString('base64')}`
}

async function fetchImageBuffer(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'image/*,*/*' },
    signal: AbortSignal.timeout(15000),
    redirect: 'follow',
  })
  if (!res.ok) throw new Error(`Could not fetch image (${res.status})`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length < 500) throw new Error('Image too small')
  if (buf.length > 12 * 1024 * 1024) throw new Error('Image too large')
  return buf
}

async function duckDuckGoImageSearch(query, maxResults = 8) {
  const searchRes = await fetch(
    `https://duckduckgo.com/?q=${encodeURIComponent(query)}&iax=images&ia=images`,
    { headers: { 'User-Agent': UA, Accept: 'text/html' }, signal: AbortSignal.timeout(10000) }
  )
  if (!searchRes.ok) throw new Error(`Image search failed (${searchRes.status})`)

  const html = await searchRes.text()
  const vqdMatch = html.match(/vqd=['"]([^'"]+)['"]/) || html.match(/vqd=([^&'"]+)/)
  if (!vqdMatch) return []

  const vqd = vqdMatch[1]
  const imgRes = await fetch(
    `https://duckduckgo.com/i.js?l=us-en&o=json&q=${encodeURIComponent(query)}&vqd=${encodeURIComponent(vqd)}&f=,,,,,&p=1`,
    {
      headers: {
        'User-Agent': UA,
        Accept: 'application/json',
        Referer: 'https://duckduckgo.com/',
      },
      signal: AbortSignal.timeout(10000),
    }
  )

  if (!imgRes.ok) throw new Error(`Image results failed (${imgRes.status})`)

  const data = await imgRes.json()
  const seen = new Set()
  const results = []

  for (const r of data.results || []) {
    const imageUrl = r.image || r.thumbnail
    if (!imageUrl || seen.has(imageUrl)) continue
    seen.add(imageUrl)
    results.push({
      title: (r.title || '').trim() || 'Reference image',
      sourceUrl: r.url || r.source || '',
      imageUrl,
      thumbnail: r.thumbnail || imageUrl,
    })
    if (results.length >= maxResults) break
  }

  return results
}

async function prepareVisionImage(url) {
  const buf = await fetchImageBuffer(url)
  const processed = await sharp(buf)
    .rotate()
    .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer()

  return {
    buffer: processed,
    base64: processed.toString('base64'),
    mediaType: 'image/jpeg',
  }
}

async function classifyVisualIntent(client, query, fullContext, messageChain) {
  const chainText = (messageChain || [])
    .map((m) => `${m.role.toUpperCase()}: ${m.content.slice(0, 1800)}`)
    .join('\n\n')

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 1200,
    messages: [
      {
        role: 'user',
        content: `You route visual requests in a research writing app. Read the FULL conversation — users often clarify intent in follow-ups (e.g. first "show me what this looks like" then "no, the chemical structure").

CURRENT REQUEST: "${query}"

CONVERSATION THREAD (oldest first):
${chainText || '(no prior messages)'}

BACKGROUND:
${fullContext.slice(0, 3500)}

Return ONLY valid JSON:
{
  "intent": "chemical_structure" | "physical_photo" | "diagram" | "illustration",
  "subjects": ["generic or IUPAC compound names"],
  "searchQuery": "precise web image search query",
  "imageGenPrompt": "detailed prompt for high-quality AI image generation",
  "caption": "2-3 sentences explaining the visual for the writer",
  "method": "search" | "generate",
  "methodConfidence": "high" | "low"
}

INTENT RULES:
- chemical_structure: ONLY isolated 2D molecular formulas (PubChem). NOT receptor binding, synaptic interactions, or biological processes — those are "diagram".
- diagram: biological mechanisms, receptor interactions, pathways, synaptic signaling, labeled process sketches.
- illustration: conceptual or artistic visuals.
- physical_photo: real-world objects.

If user asks for a molecule INTERACTING with something (receptor, enzyme, etc.), intent MUST be "diagram" — use imageGenPrompt for AI generation, NOT PubChem.

If the user corrected an earlier misunderstanding (e.g. "I meant the chemical structure"), the LATEST intent wins.
For imageGenPrompt: be extremely specific to the user's request and conversation. Include every element they described. For sketches: clean hand-drawn diagram style, white background, clear readable labels. Max 900 characters.

METHOD RULES — weigh the TIME COST. AI image generation is slow (30–120s) but produces a NEW image tailored exactly to the request. Web image SEARCH is fast (a few seconds) but only returns an existing real-world image.
- "search": real-world objects/people/places, "what does X look like", reference photos, well-known existing imagery, or anything where a real existing photo answers the request. Prefer this when it adequately satisfies the user, because it is far faster.
- "generate": custom/novel compositions, requests with many SPECIFIC required elements (e.g. "with arrows showing…", "labeled steps", "a diagram of MY process/algorithm"), particular artistic styles, or anything unlikely to exist as a single real image.
- methodConfidence "high" when one method is clearly correct.
- methodConfidence "low" ONLY when the request is genuinely ambiguous and either method is reasonable (a generic real subject that the user might want either photographed OR illustrated). Use "low" sparingly.`,
      },
    ],
  })

  const text = response.content.find((b) => b.type === 'text')?.text || ''
  const molecule = query.match(MOLECULE_NAMES)?.[1]
  return safeParseJson(text, {
    intent: inferIntentFromContext(query, messageChain),
    subjects: molecule ? [molecule] : [],
    searchQuery: query,
    imageGenPrompt: `Educational scientific diagram: ${query}. Clean labeled illustration, white background.`,
    caption: 'Visual adapted to your exploration.',
    method: 'generate',
    methodConfidence: 'high',
  })
}

function normalizeCompound(name) {
  const key = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
  for (const [alias, generic] of Object.entries(DRUG_ALIASES)) {
    if (key.includes(alias.replace(/[^a-z0-9]/g, ''))) return generic
  }
  return String(name || '').trim()
}

async function fetchPubChemStructure(compoundName) {
  const name = normalizeCompound(compoundName)
  if (!name) return null

  const url = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/${encodeURIComponent(name)}/PNG?record_type=2d&image_size=large`
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'image/png' },
    signal: AbortSignal.timeout(12000),
  })
  if (!res.ok) return null
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length < 200) return null
  return { buffer: buf, name, pubchemUrl: `https://pubchem.ncbi.nlm.nih.gov/compound/${encodeURIComponent(name)}` }
}

async function compositeLabeledStructures(structures) {
  const padding = 24
  const labelHeight = 40
  const resized = []

  for (const s of structures) {
    const img = sharp(s.buffer).png()
    const meta = await img.metadata()
    const width = meta.width || 400
    const height = meta.height || 400
    const labelSvg = Buffer.from(
      `<svg width="${width}" height="${labelHeight}" xmlns="http://www.w3.org/2000/svg">
        <rect width="${width}" height="${labelHeight}" fill="#f8f8f8"/>
        <text x="${width / 2}" y="26" text-anchor="middle" font-family="Arial, sans-serif" font-size="16" font-weight="600" fill="#222">${escapeXml(s.name)}</text>
      </svg>`
    )
    const labeled = await sharp({
      create: {
        width,
        height: height + labelHeight,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      },
    })
      .composite([
        { input: labelSvg, top: 0, left: 0 },
        { input: s.buffer, top: labelHeight, left: 0 },
      ])
      .png()
      .toBuffer()

    resized.push({ buffer: labeled, width, height: height + labelHeight })
  }

  const totalWidth = resized.reduce((sum, r) => sum + r.width, padding * (resized.length + 1))
  const maxHeight = Math.max(...resized.map((r) => r.height))

  let x = padding
  const composites = resized.map((r) => {
    const comp = { input: r.buffer, top: Math.round((maxHeight - r.height) / 2), left: x }
    x += r.width + padding
    return comp
  })

  const out = await sharp({
    create: {
      width: totalWidth,
      height: maxHeight + padding * 2,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  })
    .composite(composites.map((c) => ({ ...c, top: c.top + padding })))
    .png()
    .toBuffer()

  return out
}

async function openaiGenerate(prompt) {
  const key = process.env.OPENAI_API_KEY
  if (!key) return null

  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-image-1',
      prompt: prompt.slice(0, 4000),
      size: '1024x1024',
      quality: 'high',
    }),
    signal: AbortSignal.timeout(180000),
  })

  if (!res.ok) {
    const err = await res.text()
    let message = err.slice(0, 200)
    try {
      message = JSON.parse(err).error?.message || message
    } catch {
      // keep raw slice
    }
    throw new Error(message)
  }

  const data = await res.json()
  const b64 = data.data?.[0]?.b64_json
  const url = data.data?.[0]?.url
  if (b64) return toDataUrl(Buffer.from(b64, 'base64'), 'image/png')
  if (url) {
    const buf = await fetchImageBuffer(url)
    return toDataUrl(await sharp(buf).png().toBuffer(), 'image/png')
  }
  return null
}

async function geminiImagenGenerate(prompt) {
  const key = process.env.GOOGLE_API_KEY
  if (!key) return null

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-002:predict?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instances: [{ prompt: prompt.slice(0, 4000) }],
        parameters: { sampleCount: 1, aspectRatio: '1:1' },
      }),
      signal: AbortSignal.timeout(120000),
    }
  )

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Gemini Imagen failed (${res.status}): ${err.slice(0, 120)}`)
  }

  const data = await res.json()
  const b64 = data.predictions?.[0]?.bytesBase64Encoded
  if (!b64) return null
  return toDataUrl(Buffer.from(b64, 'base64'), 'image/png')
}

async function replicateProGenerate(prompt) {
  const token = process.env.REPLICATE_API_KEY
  if (!token) return null

  const createRes = await fetch(
    'https://api.replicate.com/v1/models/black-forest-labs/flux-1.1-pro/predictions',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Prefer: 'wait=120',
      },
      body: JSON.stringify({
        input: {
          prompt: prompt.slice(0, 4000),
          aspect_ratio: '1:1',
          output_format: 'png',
          output_quality: 90,
        },
      }),
      signal: AbortSignal.timeout(180000),
    }
  )

  if (!createRes.ok) return null

  const prediction = await createRes.json()
  let output = prediction.output

  if (prediction.status === 'processing' || prediction.status === 'starting') {
    const pollUrl = prediction.urls?.get
    if (!pollUrl) return null
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 2000))
      const pollRes = await fetch(pollUrl, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15000),
      })
      const polled = await pollRes.json()
      if (polled.status === 'succeeded') {
        output = polled.output
        break
      }
      if (polled.status === 'failed') return null
    }
  }

  const imageUrl = Array.isArray(output) ? output[0] : output
  if (!imageUrl || typeof imageUrl !== 'string') return null

  const buf = await fetchImageBuffer(imageUrl)
  return toDataUrl(await sharp(buf).png().toBuffer(), 'image/png')
}

async function generateHighQualityImage(prompt) {
  const errors = []

  if (process.env.OPENAI_API_KEY) {
    try {
      const result = await openaiGenerate(prompt)
      if (result) return { imageDataUrl: result, provider: 'openai' }
      errors.push('OpenAI returned empty result')
    } catch (err) {
      errors.push(`OpenAI: ${err.message}`)
    }
  }

  for (const { name, fn } of [
    { name: 'google', fn: geminiImagenGenerate },
    { name: 'replicate', fn: replicateProGenerate },
  ]) {
    try {
      const result = await fn(prompt)
      if (result) return { imageDataUrl: result, provider: name }
    } catch (err) {
      errors.push(`${name}: ${err.message}`)
    }
  }

  if (errors.length) {
    console.error('Image generation failed:', errors.join('; '))
    throw new Error(errors[0])
  }
  return null
}

async function buildAdaptedGenPrompt(client, query, fullContext, messageChain, intent) {
  const chainText = (messageChain || [])
    .map((m) => `${m.role.toUpperCase()}: ${m.content.slice(0, 1800)}`)
    .join('\n\n')

  const searchQuery = intent.searchQuery || query
  const candidates = await duckDuckGoImageSearch(searchQuery.trim(), 8).catch(() => [])

  const visionImages = []
  for (let i = 0; i < candidates.length && visionImages.length < 3; i++) {
    try {
      visionImages.push({ ...(await prepareVisionImage(candidates[i].imageUrl)), title: candidates[i].title })
    } catch {
      // skip broken references
    }
  }

  const content = [
    {
      type: 'text',
      text: `Write an image generation prompt for GPT Image to create a visual ADAPTED to the user's specific request.

USER REQUEST: "${query}"
VISUAL TYPE: ${intent.intent}
CONVERSATION (oldest first):
${chainText || '(none)'}

BACKGROUND:
${fullContext.slice(0, 3500)}

${visionImages.length ? `${visionImages.length} reference image(s) from the web are attached. Use them as inspiration for subject/style, but the output must be a NEW custom image tailored to the user's ask — not a copy.` : 'No reference images available — rely on conversation context.'}

Requirements:
- The image must directly serve what the user asked for in this thread
- For sketches/diagrams: clean hand-drawn or vector infographic style, white/light background, legible text labels
- For photos: photorealistic but framed for the user's writing purpose
- Include ALL specific elements mentioned in the conversation (nodes, arrows, labels, steps, etc.)

Return ONLY JSON:
{
  "imageGenPrompt": "detailed DALL-E prompt, under 900 chars, no markdown",
  "caption": "2-3 sentences explaining the adapted visual"
}`,
    },
  ]

  for (const img of visionImages) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType, data: img.base64 },
    })
  }

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 1200,
    messages: [{ role: 'user', content }],
  })

  const text = response.content.find((b) => b.type === 'text')?.text || ''
  const plan = safeParseJson(text, {
    imageGenPrompt:
      intent.imageGenPrompt ||
      `Educational scientific diagram: ${query}. Clean hand-drawn or vector style, white background, clear readable labels showing all elements the user described.`,
    caption: intent.caption || 'Visual adapted to your exploration.',
  })
  return {
    imageGenPrompt: plan.imageGenPrompt || intent.imageGenPrompt || query,
    caption: plan.caption || intent.caption,
    referenceUrl: candidates[0]?.sourceUrl,
    referenceTitle: candidates[0]?.title,
  }
}

/** Fast path: find a real existing image from the web instead of generating one. */
async function searchWebImage(query, intent) {
  const searchQuery = (intent.searchQuery || query).trim()
  const candidates = await duckDuckGoImageSearch(searchQuery, 12).catch(() => [])

  for (const candidate of candidates) {
    try {
      const prepared = await prepareVisionImage(candidate.imageUrl)
      return {
        imageDataUrl: `data:${prepared.mediaType};base64,${prepared.base64}`,
        caption: intent.caption || `Reference image found for "${query}".`,
        referenceUrl: candidate.sourceUrl || candidate.imageUrl,
        referenceTitle: candidate.title || 'Web image',
        referenceImageUrl: candidate.imageUrl,
        mode: 'reference_photo',
        provider: 'web',
      }
    } catch {
      // try the next candidate
    }
  }

  return null
}

async function generateAdaptedVisual(client, query, fullContext, messageChain, intent) {
  const plan = await buildAdaptedGenPrompt(client, query, fullContext, messageChain, intent)

  const generated = await generateHighQualityImage(plan.imageGenPrompt).catch((err) => {
    throw new Error(err.message || 'Image generation failed')
  })
  if (!generated) {
    throw new Error('Image generation returned no result')
  }

  return {
    imageDataUrl: generated.imageDataUrl,
    caption: plan.caption || intent.caption || 'AI-generated visual adapted to your request.',
    referenceUrl: plan.referenceUrl,
    referenceTitle: plan.referenceTitle,
    mode: 'generated',
    provider: generated.provider,
  }
}

/**
 * Tool-calling router. Instead of brittle keyword matching, we hand Claude the
 * actual capabilities (write text / generate image / find image / ask the user)
 * and let it decide which one fits the request. tool_choice "any" forces a pick.
 */
const ROUTING_TOOLS = [
  {
    name: 'write_text_response',
    description:
      'Answer the user in writing — explanation, analysis, research, discussion, brainstorming. Use this for ANY request that is not primarily asking to SEE an image or visual. This is the default.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'generate_image',
    description:
      'Create a NEW custom image with AI image generation. Slower (30-120s) but tailored exactly to the request. Choose this for custom diagrams, sketches, labeled figures, novel or artistic compositions, or anything specific that is unlikely to already exist as a real photo.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            "A clear, standalone description of what the image should depict. Resolve pronouns like 'this/it/that' using the conversation so the description makes sense on its own.",
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'find_image',
    description:
      'Find a REAL existing image from the web. Fast (a few seconds). Choose this when the user wants to see what a real-world object, person, place, or device actually looks like, or wants a reference photo that already exists. Prefer this over generation whenever a real photo would satisfy the user, because it is far faster.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'A web image search query. Resolve pronouns using the conversation so it makes sense on its own.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'ask_user_image_method',
    description:
      'Use ONLY when the user clearly wants an image but it is genuinely ambiguous whether a custom AI-generated image or a real existing web image would serve them better. Presents the user a quick two-way choice.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The standalone description / search query for the desired image.',
        },
      },
      required: ['query'],
    },
  },
]

export async function decideExplorationAction({ apiKey, prompt, messageChain, context, excerpt }) {
  const key = apiKey || process.env.ANTHROPIC_API_KEY
  if (!key) throw new Error('No Anthropic API key provided')
  const client = new Anthropic({ apiKey: key })

  const chainText = (messageChain || [])
    .map((m) => `${m.role.toUpperCase()}: ${m.content.slice(0, 1500)}`)
    .join('\n\n')

  const userBlock = excerpt
    ? `The user highlighted this excerpt: "${excerpt}"\n\nUser request: "${prompt}"`
    : `User request: "${prompt}"`

  const response = await client.messages.create(
    {
      model: 'claude-sonnet-4-5',
      max_tokens: 500,
      tools: ROUTING_TOOLS,
      tool_choice: { type: 'any' },
      messages: [
        {
          role: 'user',
          content: `You route requests in a research-writing app. Decide how to handle the user's LATEST request by calling exactly ONE tool.

CONVERSATION (oldest first):
${chainText || '(none)'}

${context ? `BACKGROUND:\n${context.slice(0, 2000)}\n\n` : ''}${userBlock}

Most requests are written answers. Only choose an image tool when the user actually wants to SEE a visual (e.g. "show me", "find an image", "make a diagram", "what does X look like"). When they do want an image, weigh speed: prefer find_image for real things, generate_image for custom/specific visuals.`,
        },
      ],
    },
    { timeout: 25000 }
  )

  const toolUse = response.content.find((b) => b.type === 'tool_use')
  if (!toolUse) return { action: 'text' }

  const query = (toolUse.input?.query || prompt).trim()
  switch (toolUse.name) {
    case 'generate_image':
      return { action: 'generate', query }
    case 'find_image':
      return { action: 'search', query }
    case 'ask_user_image_method':
      return { action: 'choose', query }
    default:
      return { action: 'text' }
  }
}

export async function generateVisualAsset({
  query,
  apiKey,
  context,
  parentPrompt,
  parentResponse,
  excerpt,
  messageChain,
  method,
}) {
  const key = apiKey || process.env.ANTHROPIC_API_KEY
  if (!key) throw new Error('No Anthropic API key provided')
  const client = new Anthropic({ apiKey: key })

  const fullContext = [
    context,
    excerpt ? `Highlighted excerpt: ${excerpt}` : '',
    parentPrompt ? `Parent question: ${parentPrompt}` : '',
    parentResponse ? `Parent answer: ${parentResponse.slice(0, 2000)}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')

  // Fast path: PubChem ONLY for plain structure requests (not receptor interactions etc.)
  const moleculeMatch = query.match(MOLECULE_NAMES)
  if (moleculeMatch && wantsPubChemStructure(query, messageChain)) {
    const fetched = await fetchPubChemStructure(moleculeMatch[1])
    if (fetched) {
      const composite = await compositeLabeledStructures([fetched])
      return {
        imageDataUrl: toDataUrl(composite, 'image/png'),
        caption: `Accurate 2D chemical structure of ${moleculeMatch[1]} from PubChem.`,
        referenceUrl: fetched.pubchemUrl,
        referenceTitle: 'PubChem',
        mode: 'chemical_structure',
        provider: 'pubchem',
      }
    }
  }

  const intent = await classifyVisualIntent(client, query, fullContext, messageChain)

  if (moleculeMatch && wantsPubChemStructure(query, messageChain) && !intent.subjects?.length) {
    intent.intent = 'chemical_structure'
    intent.subjects = [moleculeMatch[1]]
  }

  // --- Chemical structures: accurate PubChem diagrams (isolated formulas only) ---
  if (intent.intent === 'chemical_structure' && wantsPubChemStructure(query, messageChain)) {
    const rawSubjects = intent.subjects?.length ? intent.subjects : [query]
    const structures = []

    for (const subject of rawSubjects.slice(0, 4)) {
      const fetched = await fetchPubChemStructure(subject)
      if (fetched) structures.push(fetched)
    }

    if (!structures.length) {
      throw new Error(
        'Could not find chemical structures for those compounds. Try generic names like "amphetamine" or "methylphenidate".'
      )
    }

    const composite = await compositeLabeledStructures(structures)
    return {
      imageDataUrl: toDataUrl(composite, 'image/png'),
      caption:
        intent.caption ||
        `Accurate 2D chemical structure${structures.length > 1 ? 's' : ''} from PubChem.`,
      referenceUrl: structures[0].pubchemUrl,
      referenceTitle: 'PubChem',
      mode: 'chemical_structure',
      provider: 'pubchem',
    }
  }

  // --- Decide between fast web search and slow custom generation ---
  // A forced method (from the user's button choice) always wins. Otherwise, if the
  // model is genuinely unsure, ask the client to present the two-choice UI.
  let chosenMethod = method === 'search' || method === 'generate' ? method : null
  if (!chosenMethod) {
    if (intent.methodConfidence === 'low') {
      return { needsChoice: true, suggestion: intent.method === 'search' ? 'search' : 'generate' }
    }
    chosenMethod = intent.method === 'search' ? 'search' : 'generate'
  }

  if (chosenMethod === 'search') {
    const found = await searchWebImage(query, intent)
    if (found) return found
    // No usable web image — fall back to generation so the user still gets a result.
  }

  return generateAdaptedVisual(client, query, fullContext, messageChain, intent)
}

export async function proxyImage(url) {
  const buf = await fetchImageBuffer(url)
  const jpeg = await sharp(buf).rotate().jpeg({ quality: 90 }).toBuffer()
  return jpeg
}

export { duckDuckGoImageSearch }
