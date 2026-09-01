import type { TaskConfig } from 'payload'

import { upsertCatalogItem } from '../lib/catalogUpsert'
import { iterateProducts } from '../lib/dkClient'

function bool(v: unknown): boolean {
  return v === true || v === 'true' || v === 1
}

/**
 * Daily sync of the DK Vörubók product catalog into `catalog-items`.
 *
 * Incremental after the first run: uses the max stored `recordModified` as the
 * dkPlus /Product/modified/{date} cursor. Upserts by `itemCode`. Skips deleted
 * rows and rows without an ItemCode.
 *
 * Scheduled daily at 03:00; on a dedicated server `jobs.autoRun` both schedules
 * and runs it (see payload.config.ts).
 */
export const syncCatalog: TaskConfig<'syncCatalog'> = {
  slug: 'syncCatalog',
  label: 'Sync DK catalog (Vörubók)',
  schedule: [{ cron: '0 3 * * *', queue: 'nightly' }],
  handler: async ({ req }) => {
    const { payload } = req

    // Determine the incremental cursor from the newest RecordModified we have.
    const latest = await payload.find({
      collection: 'catalog-items',
      sort: '-recordModified',
      limit: 1,
      depth: 0,
      overrideAccess: true,
    })
    const cursor = latest.docs[0]?.recordModified
    const modifiedSince = cursor ? new Date(cursor).toISOString().slice(0, 10) : undefined

    const now = new Date().toISOString()
    let upserted = 0
    let skipped = 0

    payload.logger.info(
      `syncCatalog: starting ${modifiedSince ? `incremental since ${modifiedSince}` : 'full'} sync`,
    )

    for await (const p of iterateProducts({ count: 200, modifiedSince })) {
      if (!p.ItemCode || bool(p.Deleted)) {
        skipped++
        continue
      }

      await upsertCatalogItem(payload, p, now)
      upserted++
    }

    payload.logger.info(`syncCatalog: done — upserted ${upserted}, skipped ${skipped}`)
    return { output: { upserted, skipped } }
  },
}
