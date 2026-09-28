import type { TaskConfig } from 'payload'

import { syncCatalogFromDk } from '../lib/catalogSync'

/**
 * Daily sync of the DK Vörubók product catalog into `catalog-items`.
 *
 * Always a full pull (DK's modified-since filter can't give a usable delta —
 * see dkClient.ts); only rows whose DK data changed are written, and rows DK
 * doesn't have are removed, so the mirror matches DK exactly.
 *
 * Scheduled daily at 03:00; on a dedicated server `jobs.autoRun` both schedules
 * and runs it (see payload.config.ts). Run on demand: scripts/sync-catalog.mts.
 */
export const syncCatalog: TaskConfig<'syncCatalog'> = {
  slug: 'syncCatalog',
  label: 'Sync DK catalog (Vörubók)',
  schedule: [{ cron: '0 3 * * *', queue: 'nightly' }],
  handler: async ({ req }) => {
    const { payload } = req
    payload.logger.info('syncCatalog: starting full sync')
    const result = await syncCatalogFromDk(payload)
    payload.logger.info(`syncCatalog: done — ${JSON.stringify(result)}`)
    return { output: result }
  },
}
