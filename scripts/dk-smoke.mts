import 'dotenv/config'

import { iterateProducts } from '../src/lib/dkClient'

// Read a handful of products to validate connectivity/auth/parsing.
let n = 0
try {
  for await (const p of iterateProducts({ count: 3 })) {
    console.log(`  ${p.ItemCode} | ${p.Description ?? ''} | net=${p.UnitPrice1} ${p.CurrencyCode ?? ''} | tax=${p.TaxPercent}`)
    if (++n >= 5) break
  }
  console.log(n > 0 ? `\n✅ DK client OK — read ${n} products` : '\n⚠ DK client connected but returned 0 products')
} catch (err) {
  console.log(`\n❌ DK client error: ${err instanceof Error ? err.message : String(err)}`)
  console.log('(If this is auth/403, the demo key was rotated — supply a real DK_API_KEY.)')
}
process.exit(0)
