import crypto from 'crypto'

/**
 * Constant-time comparison of two strings. Returns false on length mismatch
 * without leaking timing information beyond the length.
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) return false
  return crypto.timingSafeEqual(ab, bb)
}

/**
 * Verify an HMAC-SHA256 signature over the raw request body.
 * The WordPress side computes hash_hmac('sha256', $rawBody, $secret) and sends
 * the hex digest in the X-Signature header.
 */
export function verifyHmacSignature(
  rawBody: string,
  signature: string | null,
  secret: string,
): boolean {
  if (!signature || !secret) return false
  // Allow an optional "sha256=" prefix (common convention).
  const provided = signature.startsWith('sha256=') ? signature.slice(7) : signature
  const expected = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')
  return timingSafeEqualStr(provided, expected)
}
