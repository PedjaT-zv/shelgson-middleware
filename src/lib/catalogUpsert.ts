import type { Payload } from 'payload'

import type { DkProduct } from './dkClient'

function num(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : (v as number)
  return typeof n === 'number' && !Number.isNaN(n) ? n : undefined
}

function bool(v: unknown): boolean {
  return v === true || v === 'true' || v === 1
}

/**
 * Canonical form of a DK ItemCode. DK stores codes lowercase ("h101") while the
 * quote template and WordPress use uppercase ("H101"), sometimes with stray
 * whitespace — every comparison and every stored code goes through this.
 */
export function normalizeItemCode(code: string): string {
  return code.trim().toLowerCase()
}

/** Map a dkPlus product onto the `catalog-items` field shape. */
export function dkToCatalogData(p: DkProduct, syncedAt: string) {
  return {
    itemCode: normalizeItemCode(p.ItemCode),
    recordId: num(p.RecordID),
    description: p.Description ?? undefined,
    description2: p.Description2 ?? undefined,
    unitCode: p.UnitCode ?? undefined,
    group: p.Group ?? undefined,
    unitPrice1: num(p.UnitPrice1),
    unitPrice1WithTax: num(p.UnitPrice1WithTax),
    taxPercent: num(p.TaxPercent),
    // DK sales prices are ISK; DK's own CurrencyCode is the purchase currency.
    currencyCode: 'ISK',
    inactive: bool(p.Inactive),
    showItemInWebShop: bool(p.ShowItemInWebShop),
    recordModified: p.RecordModified ? new Date(p.RecordModified).toISOString() : undefined,
    lastSyncedAt: syncedAt,
  }
}

export type CatalogData = ReturnType<typeof dkToCatalogData>

/** Upsert one dkPlus product into `catalog-items` by (normalized) itemCode. */
export async function upsertCatalogItem(payload: Payload, p: DkProduct, syncedAt: string) {
  const data = dkToCatalogData(p, syncedAt)
  const existing = await payload.find({
    collection: 'catalog-items',
    where: { itemCode: { equals: data.itemCode } },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  })
  if (existing.docs[0]) {
    return payload.update({
      collection: 'catalog-items',
      id: existing.docs[0].id,
      data,
      depth: 0,
      overrideAccess: true,
    })
  }
  return payload.create({ collection: 'catalog-items', data, depth: 0, overrideAccess: true })
}
