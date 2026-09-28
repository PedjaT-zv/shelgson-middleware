import type { Payload } from 'payload'

import type { CatalogItem } from '../payload-types'
import { dkToCatalogData, type CatalogData } from './catalogUpsert'
import { iterateProducts } from './dkClient'

export interface CatalogSyncResult {
  /** Products DK returned (after skipping rows without an ItemCode). */
  total: number
  created: number
  updated: number
  unchanged: number
  /** Mirror rows DK no longer has — placeholders, deleted or renamed codes. */
  removed: number
  skipped: number
}

/** Fields that come from DK; everything else on the row is bookkeeping. */
const DK_FIELDS = [
  'recordId',
  'description',
  'description2',
  'unitCode',
  'group',
  'unitPrice1',
  'unitPrice1WithTax',
  'taxPercent',
  'currencyCode',
  'inactive',
  'showItemInWebShop',
  'recordModified',
] as const

function sameDkData(doc: CatalogItem, data: CatalogData): boolean {
  return DK_FIELDS.every((f) => {
    const a = doc[f] ?? null
    const b = data[f] ?? null
    if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-6
    return a === b
  })
}

/**
 * Make `catalog-items` an exact mirror of the DK product catalog: pull every
 * product, create/update the rows whose DK data changed, and delete rows DK
 * does not have. The whole catalog is fetched before anything is written, so a
 * DK failure midway leaves the mirror untouched.
 */
export async function syncCatalogFromDk(payload: Payload): Promise<CatalogSyncResult> {
  const syncedAt = new Date().toISOString()

  const incoming = new Map<string, CatalogData>()
  let skipped = 0
  for await (const p of iterateProducts()) {
    if (!p.ItemCode?.trim() || p.Deleted === true) {
      skipped++
      continue
    }
    const data = dkToCatalogData(p, syncedAt)
    incoming.set(data.itemCode, data)
  }
  // An empty answer is far more likely a DK hiccup than an empty catalog —
  // never let it wipe the mirror.
  if (incoming.size === 0) throw new Error('dkPlus returned no products — catalog left unchanged')

  const existing = await payload.find({
    collection: 'catalog-items',
    pagination: false,
    depth: 0,
    overrideAccess: true,
  })
  const byCode = new Map(existing.docs.map((d) => [d.itemCode, d]))

  let created = 0
  let updated = 0
  let unchanged = 0
  for (const [code, data] of incoming) {
    const doc = byCode.get(code)
    if (!doc) {
      await payload.create({ collection: 'catalog-items', data, depth: 0, overrideAccess: true })
      created++
    } else if (sameDkData(doc, data)) {
      unchanged++
    } else {
      await payload.update({
        collection: 'catalog-items',
        id: doc.id,
        data,
        depth: 0,
        overrideAccess: true,
      })
      updated++
    }
  }

  const stale = existing.docs.filter((d) => !incoming.has(d.itemCode))
  if (stale.length > 0) {
    await payload.delete({
      collection: 'catalog-items',
      where: { id: { in: stale.map((d) => d.id) } },
      depth: 0,
      overrideAccess: true,
    })
  }

  return { total: incoming.size, created, updated, unchanged, removed: stale.length, skipped }
}
