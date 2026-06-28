/** Hostnames that need a direct iframe (player scripts); articles use the reader proxy. */
const DIRECT_EMBED_HOSTS = /^(youtube\.com|youtu\.be|m\.youtube\.com|vimeo\.com|player\.vimeo\.com)$/

export function shouldUseDirectEmbed(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '')
    return DIRECT_EMBED_HOSTS.test(host)
  } catch {
    return false
  }
}

/** Reader proxy for HTML articles (same-origin → scroll + highlight); direct for video players. */
export function getEmbedFrameSrc(url: string): string {
  if (shouldUseDirectEmbed(url)) return url
  return `/api/proxy?url=${encodeURIComponent(url)}`
}

export function isReaderProxySrc(src: string): boolean {
  return src.startsWith('/api/proxy')
}
