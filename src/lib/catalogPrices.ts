import type { Payload } from 'payload'

import type { CatalogItem, Inquiry } from '../payload-types'
import { normalizeItemCode, upsertCatalogItem } from './catalogUpsert'
import { fetchProduct } from './dkClient'
import type { PriceRow } from './excel'

/** The DK codes an inquiry prices: the stone plus every add-on, de-duplicated. */
export function inquiryItemCodes(inquiry: Inquiry): string[] {
  const codes = [
    inquiry.wantedProduct?.itemCode ?? '',
    ...(inquiry.addons ?? []).map((a) => a.code ?? ''),
  ]
  return [...new Set(codes.map(normalizeItemCode).filter(Boolean))]
}

/**
 * Fetch LIVE prices from DK for exactly `codes` and upsert them into the
 * catalog mirror, so a quote never waits for the nightly sync. Codes DK does
 * not know are returned in `missing`; DK/network errors are thrown.
 */
export async function refreshFromDk(
  payload: Payload,
  codes: string[],
): Promise<{ refreshed: string[]; missing: string[] }> {
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
    }
  }
  return { refreshed, missing }
}

/**
 * The price a quote uses for a catalog row: DK's VAT-inclusive UnitPrice1WithTax,
 * matching the template's Vörulisti (its prices are VAT-inclusive too).
 * Zero means "no price set in DK" — undefined, so the template keeps its own.
 */
export function quotePrice(item: Pick<CatalogItem, 'unitPrice1WithTax'>): number | undefined {
  const p = item.unitPrice1WithTax
  return typeof p === 'number' && p > 0 ? p : undefined
}

/**
 * Load the active catalog mirror as the quote's price table, plus a lookup by
 * (case-insensitive) item code for resolving the inquiry's own product.
 */
export async function loadPriceTable(payload: Payload): Promise<{
  prices: PriceRow[]
  findItem: (code: string) => CatalogItem | undefined
}> {
  const active = await payload.find({
    collection: 'catalog-items',
    where: { inactive: { not_equals: true } },
    pagination: false,
    depth: 0,
    overrideAccess: true,
  })
  const byCode = new Map(active.docs.map((d) => [normalizeItemCode(d.itemCode), d]))
  const prices: PriceRow[] = []
  for (const d of active.docs) {
    const unitPrice = quotePrice(d)
    if (unitPrice !== undefined) prices.push({ itemCode: d.itemCode, unitPrice })
  }
  return { prices, findItem: (code) => byCode.get(normalizeItemCode(code)) }
}
