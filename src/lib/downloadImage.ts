import path from 'path'

export interface DownloadedFile {
  buffer: Buffer
  filename: string
  mimeType: string
}

const MAX_BYTES = 15 * 1024 * 1024 // 15 MB
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic']

/** Block obvious internal/link-local targets when no host allowlist is set. */
function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase()
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true
  // IPv4 private / loopback / link-local ranges
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)) return true
  if (/^169\.254\./.test(h)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true
  if (h === '0.0.0.0' || h === '::1' || h === '[::1]') return true
  return false
}

/**
 * Download a reference image referenced by URL in a WordPress submission,
 * guarding against SSRF: enforce an allowlisted host (WP_ALLOWED_IMAGE_HOST)
 * or, failing that, block private/loopback hosts; cap size; enforce a timeout;
 * and validate the content-type before the caller persists it.
 */
export async function downloadReferenceImage(rawUrl: string): Promise<DownloadedFile> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error(`Invalid image URL: ${rawUrl}`)
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`Unsupported protocol for image URL: ${url.protocol}`)
  }

  const allowedHost = process.env.WP_ALLOWED_IMAGE_HOST?.trim()
  if (allowedHost) {
    if (url.hostname !== allowedHost) {
      throw new Error(`Image host not allowlisted: ${url.hostname}`)
    }
  } else if (isBlockedHost(url.hostname)) {
    throw new Error(`Refusing to fetch image from internal host: ${url.hostname}`)
  }

  const res = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
    redirect: 'follow',
    headers: { Accept: 'image/*' },
  })
  if (!res.ok) throw new Error(`Failed to download image (${res.status}) from ${url.hostname}`)

  const mimeType = (res.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase()
  if (!mimeType || !ALLOWED_IMAGE_TYPES.includes(mimeType)) {
    throw new Error(`Unexpected content-type for image: ${mimeType || 'none'}`)
  }

  const declaredLen = Number(res.headers.get('content-length') ?? 0)
  if (declaredLen && declaredLen > MAX_BYTES) {
    throw new Error(`Image too large: ${declaredLen} bytes`)
  }

  const buffer = Buffer.from(await res.arrayBuffer())
  if (buffer.length > MAX_BYTES) throw new Error(`Image too large: ${buffer.length} bytes`)

  const base = path.basename(url.pathname) || 'reference-image'
  return { buffer, filename: decodeURIComponent(base), mimeType }
}
