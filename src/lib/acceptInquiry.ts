import type { Payload } from 'payload'

import { inquiryItemCodes, loadPriceTable, quotePrice, refreshFromDk } from './catalogPrices'
import { generateQuoteWorkbook, loadMasterTemplate, quoteFileName } from './excel'
import { buildQuoteData } from './quoteData'

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

export interface AcceptResult {
  quoteMediaId: number
  fileName: string
  /** Item codes whose live DK price was fetched and stored. */
  refreshed: string[]
  /** Item codes DK does not know — the template keeps its own price for them. */
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
    const itemCode = inquiry.wantedProduct?.itemCode ?? ''
    const now = new Date().toISOString()
    const { refreshed, missing } = await refreshFromDk(payload, inquiryItemCodes(inquiry))
    if (missing.length > 0) {
      payload.logger.warn(`acceptInquiry: not in DK (template price used): ${missing.join(', ')}`)
    }

    // --- 2. Rebuild the price table (now containing the live prices) ---
    const { prices, findItem } = await loadPriceTable(payload)
    const mainItem = findItem(itemCode)

    // --- 3. Regenerate the Excel quote with real prices ---
    const quoteData = buildQuoteData(inquiry)

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
          resolvedUnitPrice: mainItem ? quotePrice(mainItem) : undefined,
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
