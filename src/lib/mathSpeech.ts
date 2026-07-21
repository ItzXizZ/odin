/**
 * LaTeX → spoken English, so the TTS voice reads equations like a human tutor
 * ("x squared plus 3 d" — never "backslash frac open brace…").
 *
 * `speakableMathText` is the single entry point: it finds math spans
 * (\( \), \[ \], $ $, $$ $$) in model output, converts their contents to words,
 * and scrubs any stray LaTeX that leaked outside delimiters.
 */

/** Commands that vanish entirely (layout only). */
const DROP_COMMANDS =
  /\\(?:left|right|big[lr]?|Big[lr]?|bigg[lr]?|Bigg[lr]?|mathrm|mathbf|mathit|mathcal|mathbb|text|operatorname|displaystyle|limits|quad|qquad|;|,|!|:)\b/g

/** Simple token → spoken word map (applied after structural commands). */
const SYMBOL_WORDS: [RegExp, string][] = [
  [/\\cdot|\\times/g, ' times '],
  [/\\div/g, ' divided by '],
  [/\\pm/g, ' plus or minus '],
  [/\\mp/g, ' minus or plus '],
  [/\\leq?\b/g, ' is less than or equal to '],
  [/\\geq?\b/g, ' is greater than or equal to '],
  [/\\neq?\b/g, ' is not equal to '],
  [/\\equiv/g, ' is equivalent to '],
  [/\\approx|\\simeq|\\sim/g, ' is approximately '],
  [/\\propto/g, ' is proportional to '],
  [/\\to|\\rightarrow|\\Rightarrow|\\implies/g, ' goes to '],
  [/\\iff|\\Leftrightarrow/g, ' if and only if '],
  [/\\in\b/g, ' in '],
  [/\\subset\b/g, ' is a subset of '],
  [/\\cup\b/g, ' union '],
  [/\\cap\b/g, ' intersect '],
  [/\\infty/g, ' infinity '],
  [/\\pi\b/g, ' pi '],
  [/\\alpha\b/g, ' alpha '],
  [/\\beta\b/g, ' beta '],
  [/\\gamma\b/g, ' gamma '],
  [/\\delta\b/g, ' delta '],
  [/\\Delta\b/g, ' delta '],
  [/\\epsilon\b|\\varepsilon\b/g, ' epsilon '],
  [/\\theta\b/g, ' theta '],
  [/\\lambda\b/g, ' lambda '],
  [/\\mu\b/g, ' mu '],
  [/\\sigma\b/g, ' sigma '],
  [/\\phi\b|\\varphi\b/g, ' phi '],
  [/\\omega\b/g, ' omega '],
  [/\\sum\b/g, ' the sum of '],
  [/\\prod\b/g, ' the product of '],
  [/\\int\b/g, ' the integral of '],
  [/\\lim\b/g, ' the limit of '],
  [/\\ln\b/g, ' natural log of '],
  [/\\log\b/g, ' log of '],
  [/\\sin\b/g, ' sine of '],
  [/\\cos\b/g, ' cosine of '],
  [/\\tan\b/g, ' tangent of '],
  [/\\deg(ree)?\b/g, ' degrees '],
  [/\\%/g, ' percent '],
  [/\\ldots|\\dots|\\cdots|…/g, ' dot dot dot '],
]

/** Replace innermost `\cmd{A}{B}`-style constructs until none remain. */
function replaceNested(src: string, pattern: RegExp, build: (...groups: string[]) => string): string {
  let out = src
  for (let guard = 0; guard < 24; guard++) {
    const next = out.replace(pattern, (...args) => build(...(args.slice(1, -2) as string[])))
    if (next === out) break
    out = next
  }
  return out
}

/** Convert the CONTENTS of a math span (no delimiters) into spoken words. */
export function latexToSpeech(mathRaw: string): string {
  let s = mathRaw

  s = s.replace(DROP_COMMANDS, ' ')

  // Structural, possibly nested constructs — innermost first ({no braces inside}).
  s = replaceNested(s, /\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, (a, b) => ` ${a} over ${b} `)
  s = replaceNested(s, /\\binom\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, (a, b) => ` ${a} choose ${b} `)
  s = replaceNested(s, /\\sqrt\s*\[([^\]]*)\]\s*\{([^{}]*)\}/g, (n, a) => ` the ${n} root of ${a} `)
  s = replaceNested(s, /\\sqrt\s*\{([^{}]*)\}/g, (a) => ` the square root of ${a} `)
  s = replaceNested(s, /\\overline\s*\{([^{}]*)\}/g, (a) => ` ${a} bar `)
  s = replaceNested(s, /\\vec\s*\{([^{}]*)\}/g, (a) => ` vector ${a} `)
  s = replaceNested(s, /\\hat\s*\{([^{}]*)\}/g, (a) => ` ${a} hat `)
  // a/b written with a plain slash reads naturally as "over".
  s = s.replace(/(?<=[\w)}])\s*\/\s*(?=[\w({])/g, ' over ')

  // Exponents.
  s = replaceNested(s, /\^\s*\{([^{}]*)\}/g, (e) => {
    const t = e.trim()
    if (t === '2') return ' squared '
    if (t === '3') return ' cubed '
    return ` to the power of ${t} `
  })
  s = s.replace(/\^\s*2\b/g, ' squared ')
  s = s.replace(/\^\s*3\b/g, ' cubed ')
  s = s.replace(/\^\s*([A-Za-z0-9])/g, ' to the power of $1 ')

  // Subscripts.
  s = replaceNested(s, /_\s*\{([^{}]*)\}/g, (i) => ` sub ${i.trim()} `)
  s = s.replace(/_\s*([A-Za-z0-9])/g, ' sub $1 ')

  for (const [re, word] of SYMBOL_WORDS) s = s.replace(re, word)

  // Operators & relations. A minus is "negative" only straight after another
  // operator/relation (e.g. "= -3"); between terms it reads as "minus".
  s = s.replace(/(^|[=+<>*/(,[])\s*-(?=\s*[\w({])/g, '$1 negative ')
  s = s.replace(/\b(equals|plus|times|over|than|of|to)\s+-(?=\s*[\w({])/g, '$1 negative ')
  s = s.replace(/=/g, ' equals ')
  s = s.replace(/\+/g, ' plus ')
  s = s.replace(/-/g, ' minus ')
  s = s.replace(/</g, ' is less than ')
  s = s.replace(/>/g, ' is greater than ')
  s = s.replace(/!/g, ' factorial ')
  s = s.replace(/\|([^|]+)\|/g, ' the absolute value of $1 ')

  // Implicit multiplication by adjacency — never silent, or "(x+a)(x+b)" reads
  // as two disconnected phrases with no hint they're a product. A number (or
  // a closing group) directly against an opening paren is unambiguous
  // multiplication; a bare letter directly against "(" is left alone since
  // that's usually function notation ("f(x)") rather than "f times x".
  s = s.replace(/\)\s*\(/g, ') times (')
  s = s.replace(/(\d)\s*\(/g, '$1 times (')

  // "negative (a+b)" / "minus (a+b)" MUST keep a pause before the group, or
  // dropping the paren silently gives "negative a plus b" — which sounds
  // like the negation only applies to the first term, not the whole group.
  s = s.replace(/\b(negative|minus)\s*\(/g, '$1, (')

  // Parentheses/brackets: the OPEN mark is silent (just grouping — saying
  // "open paren" every time is exhausting), the CLOSE mark becomes a short
  // pause, so "a/(b+c)" reads as "a over b plus c," not "a over, b plus c,".
  s = s.replace(/[([{]\s*/g, ' ')
  s = s.replace(/\s*[)\]}]/g, ', ')
  s = s.replace(/\\[a-zA-Z]+/g, ' ')
  s = s.replace(/\\/g, ' ')

  // "3d" → "3 d" so the voice says "three dee", and split run-together vars like "dx".
  s = s.replace(/(\d)([A-Za-z])/g, '$1 $2')
  s = s.replace(/([A-Za-z])(\d)/g, '$1 $2')

  // Juxtaposed single-letter variables: "ab" → "a b", "bd" → "b d" (never "ab").
  s = spellJuxtaposedVars(s)

  return s.replace(/\s+/g, ' ').trim()
}

/** Words that must stay intact when spelling letter-runs in math. */
const KEEP_MATH_WORDS = new Set([
  'pi', 'to', 'of', 'or', 'in', 'on', 'an', 'as', 'at', 'be', 'by', 'if', 'is', 'it',
  'no', 'so', 'we', 'me', 'my', 'he', 'do', 'go', 'up', 'us', 'am', 'oh', 'ox',
  'you', 'the', 'and', 'for', 'not', 'but', 'are', 'was', 'has', 'had', 'can', 'may',
  'all', 'any', 'few', 'own', 'our', 'out', 'too', 'his', 'her', 'she', 'him', 'who',
  'how', 'why', 'let', 'get', 'got', 'put', 'see', 'saw', 'say', 'says', 'use', 'used',
  'ln', 'log', 'sin', 'cos', 'tan', 'sec', 'csc', 'cot', 'det', 'dim', 'mod', 'gcd',
  'lcm', 'max', 'min', 'sup', 'inf', 'lim', 'exp', 'arg', 'dot', 'bar', 'hat', 'vec',
  'over', 'plus', 'minus', 'times', 'equals', 'power', 'root', 'square', 'squared',
  'cubed', 'sub', 'sum', 'product', 'integral', 'limit', 'negative', 'factorial',
  'absolute', 'value', 'choose', 'degrees', 'percent', 'infinity', 'union', 'intersect',
  'natural', 'sine', 'cosine', 'tangent', 'alpha', 'beta', 'gamma', 'delta', 'epsilon',
  'theta', 'lambda', 'mu', 'sigma', 'phi', 'omega',
])

/**
 * Spell short concatenated variables ("ab" → "a b") without breaking English.
 * Only length-2 letter tokens (and vowelless triples like "xyz") are split.
 */
function spellJuxtaposedVars(s: string): string {
  return s.replace(/\b([A-Za-z]{2,3})\b/g, (word) => {
    const lower = word.toLowerCase()
    if (KEEP_MATH_WORDS.has(lower)) return word
    if (word.length === 2) return `${word[0]} ${word[1]}`
    // "xyz", "bcd" — product of three single-letter vars, no vowels
    if (word.length === 3 && !/[aeiouAEIOU]/.test(word)) return word.split('').join(' ')
    return word
  })
}

/**
 * Prepare a full tutor sentence (prose + inline math) for TTS: convert math
 * spans to words, then scrub residual markdown/LaTeX outside the spans.
 */
export function speakableMathText(raw: string): string {
  let s = raw

  // Delimited math spans → words.
  s = s.replace(/\\\[([\s\S]+?)\\\]/g, (_, body) => ` ${latexToSpeech(body)} `)
  s = s.replace(/\\\(([\s\S]+?)\\\)/g, (_, body) => ` ${latexToSpeech(body)} `)
  s = s.replace(/\$\$([\s\S]+?)\$\$/g, (_, body) => ` ${latexToSpeech(body)} `)
  s = s.replace(/\$([^$\n]+?)\$/g, (_, body) => ` ${latexToSpeech(body)} `)

  // Unclosed delimiter at the tail (mid-stream safety): convert the remainder.
  s = s.replace(/(\\\(|\\\[|\$\$?)([\s\S]*)$/g, (_, __, body) => ` ${latexToSpeech(body)} `)

  // Em/en dashes read terribly over TTS — speak them as a natural pause.
  s = s.replace(/\s*[—–]\s*/g, ', ')

  // Markdown + stray LaTeX outside spans.
  s = s.replace(/[*_`#>|]/g, ' ')
  s = s.replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, ' $1 over $2 ')
  s = s.replace(/\\[a-zA-Z]+/g, ' ')
  s = s.replace(/\^/g, ' to the power of ')
  s = s.replace(/\)\s*\(/g, ') times (')
  s = s.replace(/(\d)\s*\(/g, '$1 times (')
  s = s.replace(/-\s*\(/g, '-, (')
  s = s.replace(/[([{]\s*/g, ' ')
  s = s.replace(/\s*[)\]}~]/g, ', ')

  // Voice / undelimited math often writes "bd = -5" — still spell the vars.
  s = spellJuxtaposedVars(s)

  return s
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?)])/g, '$1')
    .replace(/,(?:\s*,)+/g, ',')
    .trim()
}
