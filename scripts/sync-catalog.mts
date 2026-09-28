import 'dotenv/config'

import { getPayload } from 'payload'

import { syncCatalogFromDk } from '../src/lib/catalogSync'
import config from '../src/payload.config'

// Run the nightly DK → catalog-items sync on demand (full pull, exact mirror).
const payload = await getPayload({ config })

const started = Date.now()
const result = await syncCatalogFromDk(payload)
console.log(`✅ DK catalog synced in ${((Date.now() - started) / 1000).toFixed(1)}s:`, result)

const priced = await payload.count({
  collection: 'catalog-items',
  where: { and: [{ inactive: { not_equals: true } }, { unitPrice1WithTax: { greater_than: 0 } }] },
  overrideAccess: true,
})
console.log(`   ${priced.totalDocs} active items carry a VAT-inclusive price (usable in quotes)`)
process.exit(0)
