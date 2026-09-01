import type { Payload } from 'payload'

import { upsertCatalogItem } from './catalogUpsert'
import { fetchProduct } from './dkClient'
import {
  generateQuoteWorkbook,
  loadMasterTemplate,
  quoteFileName,
  type PriceRow,
  type QuoteData,
} from './excel'

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

export interface AcceptResult {
  quoteMediaId: number
  fileName: string
  /** Item codes whose live DK price was fetched and stored. */
  refreshed: string[]
  /** Item codes DK does not know — their price falls back to the catalog mirror (or #N/A). */
  missing: string[]
}

/**
 * Accept an inquiry (admin action):
 *   1. fetch LIVE prices from the DK API for exactly the items on the inquiry
 *      (main product + add-ons) and upsert them into the catalog mirror
 *   2. regenerate the Excel quote so its price table carries the real prices
 *   3. mark the inquiry `accepted` (acceptedAt / acceptedBy)
 *
 * Throws on failure after marking the inquiry `failed` with the error, so the
 * admin UI can surface the message instead of failing silently.
 */
export async function acceptInquiry(
  payload: Payload,
  inquiryId: string | number,
  acceptedBy?: string | number,
): Promise<AcceptResult> {
  const base = { collection: 'inquiries' as const, id: inquiryId, depth: 0, overrideAccess: true }
  const inquiry = await payload.findByID({ ...base })

  await payload.update({ ...base, data: { status: 'accepting', processingError: null } })

  try {
    // --- 1. Live DK price refresh for this inquiry's items ---
    const itemCode = (inquiry.wantedProduct as { itemCode?: string })?.itemCode ?? ''
    const addons = (inquiry.addons ?? []) as { code?: string; qty?: number }[]
    const codes = [...new Set([itemCode, ...addons.map((a) => a.code ?? '')].filter(Boolean))]

    const now = new Date().toISOString()
    const refreshed: string[] = []
    const missing: string[] = []
    for (const code of codes) {
      const product = await fetchProduct(code)
      if (product?.ItemCode) {
        await upsertCatalogItem(payload, product, now)
        refreshed.push(code)
      } else {
        missing.push(code)
        payload.logger.warn(`acceptInquiry: itemCode "${code}" not found in DK`)
      }
    }

    // --- 2. Rebuild the price table (now containing the live prices) ---
    const priced = await payload.find({
      collection: 'catalog-items',
      where: { inactive: { not_equals: true } },
      pagination: false,
      depth: 0,
      overrideAccess: true,
    })
    const prices: PriceRow[] = priced.docs
      .filter((d) => typeof d.unitPrice1 === 'number')
      .map((d) => ({
        itemCode: d.itemCode,
        unitPrice: d.unitPrice1 as number,
        description: d.description ?? undefined,
      }))

    const mainItem = priced.docs.find((d) => d.itemCode === itemCode)

    // --- 3. Regenerate the Excel quote with real prices ---
    const inscriptionLines = ((inquiry.inscriptionLines ?? []) as { line?: string }[])
      .map((l) => l.line ?? '')
      .filter(Boolean)
    const quoteData: QuoteData = {
      customerName: (inquiry.customer as { name?: string })?.name,
      customerEmail: (inquiry.customer as { email?: string })?.email,
      customerPhone: (inquiry.customer as { phone?: string })?.phone,
      deceasedName: (inquiry.deceased as { name?: string })?.name,
      deceasedBorn: (inquiry.deceased as { bornDate?: string })?.bornDate,
      deceasedDied: (inquiry.deceased as { diedDate?: string })?.diedDate,
      productItemCode: itemCode,
      inscriptionLines,
      addons: addons.map((a) => ({ code: a.code ?? '', qty: a.qty ?? 1 })).filter((a) => a.code),
    }

    const template = await loadMasterTemplate()
    const xlsx = await generateQuoteWorkbook(template, quoteData, prices)
    const fileName = quoteFileName(quoteData.customerName, inquiryId)

    const quoteMedia = await payload.create({
      collection: 'media',
      overrideAccess: true,
      data: { alt: `${fileName} (accepted, live DK prices)`, kind: 'quote' },
      file: { data: xlsx, mimetype: XLSX_MIME, name: fileName, size: xlsx.length },
    })

    await payload.update({
      ...base,
      data: {
        generatedQuote: quoteMedia.id,
        wantedProduct: {
          itemCode,
          catalogItem: mainItem?.id,
          resolvedDescription: mainItem?.description ?? undefined,
          resolvedUnitPrice: mainItem?.unitPrice1 ?? undefined,
        },
        status: 'accepted',
        acceptedAt: now,
        acceptedBy: typeof acceptedBy === 'number' ? acceptedBy : undefined,
        processingError: null,
      },
    })

    return { quoteMediaId: quoteMedia.id, fileName, refreshed, missing }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    payload.logger.error(`acceptInquiry ${inquiryId} failed: ${message}`)
    await payload
      .update({ ...base, data: { status: 'failed', processingError: message } })
      .catch(() => undefined)
    throw err
  }
}
