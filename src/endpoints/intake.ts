import type { Endpoint, PayloadRequest } from 'payload'
import { z } from 'zod'

import { timingSafeEqualStr, verifyHmacSignature } from '../lib/hmac'

/**
 * The JSON contract the WordPress custom form must POST. We own this shape, so
 * the WP submit handler builds it directly (see the wp_remote_post snippet in
 * the plan) and signs the raw body with HMAC-SHA256 in the X-Signature header.
 */
const intakeSchema = z.object({
  customer: z
    .object({
      name: z.string().optional(),
      email: z.string().email().optional(),
      phone: z.string().optional(),
    })
    .optional(),
  deceased: z
    .object({
      name: z.string().optional(),
      bornDate: z.string().optional(),
      diedDate: z.string().optional(),
    })
    .optional(),
  product: z.object({ itemCode: z.string().min(1) }),
  inscriptionLines: z.array(z.string()).default([]),
  addons: z
    .array(
      z.object({
        code: z.string().min(1),
        label: z.string().optional(),
        qty: z.number().positive().default(1),
      }),
    )
    .default([]),
  referenceImageUrls: z.array(z.string().url()).default([]),
})

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status })
}

/**
 * Verify the request is authentic. Accepts EITHER a valid HMAC-SHA256 signature
 * over the raw body (X-Signature, preferred) OR a matching static shared secret
 * (X-Webhook-Secret). Both compare against WEBHOOK_SECRET in constant time.
 */
function isAuthentic(req: PayloadRequest, rawBody: string): boolean {
  const secret = process.env.WEBHOOK_SECRET ?? ''
  if (!secret) return false
  const signature = req.headers.get('x-signature')
  if (verifyHmacSignature(rawBody, signature, secret)) return true
  const staticSecret = req.headers.get('x-webhook-secret')
  return staticSecret ? timingSafeEqualStr(staticSecret, secret) : false
}

/**
 * POST /api/webhooks/wordpress-inquiry — receives a WordPress form submission.
 * (Path avoids the `inquiries` collection slug, whose REST routes would
 * otherwise shadow a config endpoint under /api/inquiries/*.)
 */
export const intakeEndpoint: Endpoint = {
  path: '/webhooks/wordpress-inquiry',
  method: 'post',
  handler: async (req: PayloadRequest) => {
    if (!process.env.WEBHOOK_SECRET) {
      req.payload.logger.error('intake: WEBHOOK_SECRET is not set — refusing to accept submissions')
      return json({ error: 'server misconfigured' }, 500)
    }

    if (!req.text) return json({ error: 'no body' }, 400)
    const rawBody = await req.text()

    if (!isAuthentic(req, rawBody)) {
      return json({ error: 'unauthorized' }, 401)
    }

    let parsed: z.infer<typeof intakeSchema>
    try {
      parsed = intakeSchema.parse(JSON.parse(rawBody))
    } catch (err) {
      return json({ error: 'invalid payload', details: err instanceof Error ? err.message : String(err) }, 422)
    }

    const inquiry = await req.payload.create({
      collection: 'inquiries',
      overrideAccess: true,
      req,
      data: {
        status: 'received',
        customer: parsed.customer,
        deceased: parsed.deceased,
        wantedProduct: { itemCode: parsed.product.itemCode },
        inscriptionLines: parsed.inscriptionLines.map((line) => ({ line })),
        addons: parsed.addons,
        rawPayload: JSON.parse(rawBody),
      },
    })

    // The Inquiries afterChange hook queues the processInquiry job on create.
    return json({ ok: true, id: inquiry.id }, 201)
  },
}
