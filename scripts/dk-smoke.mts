import 'dotenv/config'

import { fetchProduct, iterateProducts } from '../src/lib/dkClient'

// Read a handful of products to validate connectivity/auth/parsing.
let n = 0
try {
  for await (const p of iterateProducts({ count: 3 })) {
    console.log(`  ${p.ItemCode} | ${p.Description ?? ''} | net=${p.UnitPrice1} | with VAT=${p.UnitPrice1WithTax}`)
    if (++n >= 5) break
  }
  // Template codes are uppercase; DK must resolve them case-insensitively.
  const h101 = await fetchProduct('H101')
  console.log(`  lookup H101 → ${h101 ? `${h101.ItemCode} with VAT=${h101.UnitPrice1WithTax}` : 'not found'}`)
  console.log(n > 0 ? `\n✅ DK client OK — read ${n} products` : '\n⚠ DK client connected but returned 0 products')
} catch (err) {
  console.log(`\n❌ DK client error: ${err instanceof Error ? err.message : String(err)}`)
  console.log('(401/403 means DK_API_KEY is wrong or lacks access to the company.)')
}
process.exit(0)
