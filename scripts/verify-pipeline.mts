/**
 * End-to-end pipeline check via the Local API (no HTTP server needed):
 *   1. seed a few catalog items (stand-in for the DK sync)
 *   2. create an inquiry (fires the afterChange hook -> queues processInquiry)
 *   3. run the 'inquiries' queue
 *   4. assert the quote was generated and inspect the .xlsx
 *
 * Run with: DISABLE_AUTORUN=true SALES_EMAIL=... DESIGNER_EMAIL=... tsx scripts/verify-pipeline.mts
 */
import 'dotenv/config'

import { execFileSync } from 'child_process'
import { readFile } from 'fs/promises'
import path from 'path'

import ExcelJS from 'exceljs'
import { getPayload } from 'payload'

import config from '../src/payload.config.js'

const payload = await getPayload({ config })

// --- 1. Seed catalog ---
const seed = [
  { itemCode: 'STONE-001', description: 'Granite headstone', unitPrice1: 250000, taxPercent: 24, currencyCode: 'ISK' },
  { itemCode: 'ADDON-GOLD', description: 'Gold leaf lettering', unitPrice1: 45000, taxPercent: 24, currencyCode: 'ISK' },
  { itemCode: 'ADDON-VASE', description: 'Bronze vase', unitPrice1: 30000, taxPercent: 24, currencyCode: 'ISK' },
]
for (const item of seed) {
  const existing = await payload.find({
    collection: 'catalog-items',
    where: { itemCode: { equals: item.itemCode } },
    limit: 1,
  })
  if (existing.docs[0]) {
    await payload.update({ collection: 'catalog-items', id: existing.docs[0].id, data: { ...item, lastSyncedAt: new Date().toISOString() } })
  } else {
    await payload.create({ collection: 'catalog-items', data: { ...item, lastSyncedAt: new Date().toISOString() } })
  }
}
console.log('✔ seeded catalog items')

// --- 2. Create inquiry ---
const inquiry = await payload.create({
  collection: 'inquiries',
  data: {
    status: 'received',
    customer: { name: 'Jón Jónsson', email: 'jon@example.is', phone: '+354 555 1234' },
    deceased: { name: 'Anna Jónsdóttir', bornDate: '1940-05-01', diedDate: '2026-06-01' },
    wantedProduct: { itemCode: 'STONE-001' },
    inscriptionLines: [{ line: 'In loving memory' }, { line: 'Anna Jónsdóttir' }],
    addons: [
      { code: 'ADDON-GOLD', label: 'Gold leaf', qty: 1 },
      { code: 'ADDON-VASE', label: 'Bronze vase', qty: 2 },
    ],
    rawPayload: { referenceImageUrls: [] },
  },
})
console.log(`✔ created inquiry #${inquiry.id} (status: ${inquiry.status})`)

// --- 3. Run the inquiries queue ---
const result = await payload.jobs.run({ queue: 'inquiries' })
console.log('✔ ran inquiries queue:', JSON.stringify(result?.jobStatus ?? result ?? {}, null, 0).slice(0, 300))

// --- 4. Inspect outcome ---
const done = await payload.findByID({ collection: 'inquiries', id: inquiry.id, depth: 1 })
console.log(`  inquiry status now: ${done.status}`)
if (done.processingError) console.log(`  processingError: ${done.processingError}`)

const quote = done.generatedQuote as { filename?: string } | number | null | undefined
const filename = typeof quote === 'object' && quote ? quote.filename : undefined
if (!filename) {
  console.error('x no generated quote — FAIL')
  process.exit(1)
}
console.log(`✔ generated quote file: ${filename}`)

const filePath = path.join(process.cwd(), 'media', filename)
const wb = new ExcelJS.Workbook()
await wb.xlsx.load(await readFile(filePath))

const q = wb.getWorksheet('Quote')!
const prices = wb.getWorksheet('Prices')!
const priceRowCount = prices.rowCount - 1 // minus header
const c2 = q.getCell('C2').value
const c9 = q.getCell('C9').value
const c10 = q.getCell('C10').value // should still be a VLOOKUP formula object
const total = q.getCell('C26').value

console.log('--- Excel assertions ---')
console.log(`  Prices sheet data rows: ${priceRowCount}`)
console.log(`  Quote C2 (customer): ${JSON.stringify(c2)}`)
console.log(`  Quote C9 (product code): ${JSON.stringify(c9)}`)
console.log(`  Quote C10 (product price formula): ${JSON.stringify(c10)}`)
console.log(`  Quote C26 (total formula): ${JSON.stringify(total)}`)
console.log(`  fullCalcOnLoad: ${wb.calcProperties.fullCalcOnLoad}`)

// ExcelJS does not parse calcPr back on load, so check the written XML directly.
const workbookXml = execFileSync('unzip', ['-p', filePath, 'xl/workbook.xml']).toString()
const hasFullCalcOnLoad = /fullCalcOnLoad="1"/.test(workbookXml)
console.log(`  fullCalcOnLoad in workbook.xml: ${hasFullCalcOnLoad}`)

const c10IsFormula = typeof c10 === 'object' && c10 !== null && 'formula' in (c10 as object)
const ok =
  c2 === 'Jón Jónsson' &&
  c9 === 'STONE-001' &&
  c10IsFormula &&
  hasFullCalcOnLoad &&
  priceRowCount >= 3

// Independent expected total (what Excel will compute on open):
const expected = 250000 + 1 * 45000 + 2 * 30000
console.log(`  expected total when opened in Excel: ${expected} ISK`)

console.log(ok ? '\n✅ PIPELINE OK' : '\n❌ PIPELINE ASSERTIONS FAILED')
process.exit(ok ? 0 : 1)
