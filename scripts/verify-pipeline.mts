/**
 * End-to-end pipeline check via the Local API (no HTTP server needed):
 *   1. seed a few catalog items (stand-in for the DK sync)
 *   2. create an inquiry (fires the afterChange hook -> queues processInquiry)
 *   3. run the 'inquiries' queue
 *   4. assert the quote was generated and inspect the .xlsx against the REAL
 *      Icelandic master template (sheet "Pantanir" inputs + "Vörulisti" prices)
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

// --- 1. Seed catalog (codes exist in the template's Vörulisti; prices differ
//        from the template's own so the DK injection is observable) ---
const seed = [
  { itemCode: 'H111', description: 'Legsteinn H111', unitPrice1: 175000, taxPercent: 24, currencyCode: 'ISK' },
  { itemCode: 'BK101', description: 'Kross BK101', unitPrice1: 15000, taxPercent: 24, currencyCode: 'ISK' },
  { itemCode: 'LK01', description: 'Lukt LK01', unitPrice1: 58000, taxPercent: 24, currencyCode: 'ISK' },
  { itemCode: 'FK01', description: 'Dúfa FK01', unitPrice1: 37500, taxPercent: 24, currencyCode: 'ISK' },
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

// --- 2. Create inquiry (mirrors the client's filled example) ---
const inquiry = await payload.create({
  collection: 'inquiries',
  data: {
    status: 'received',
    customer: {
      firstName: 'Selma',
      lastName: 'Harðardóttir',
      kennitala: '010160-1234',
      address: 'Laugavegur 1, 101 Reykjavík',
      phone: '+354 555 1234',
      email: 'selma@example.is',
    },
    deceased: { firstName: 'Hörður', lastName: 'Kristjánsson', bornDate: '1951-04-17', diedDate: '2025-01-15' },
    wantedProduct: { itemCode: 'H111' },
    inscriptionLines: [{ line: 'Minning þín lifir' }],
    options: {
      letur: 'Times New Roman',
      litur: 'Gull',
      stoneColor: 'SB',
      cemetery: 'Gufunes',
      perCharPrice: 260,
      uppsetningVerd: 86600,
      comments: 'Óska eftir uppsetningu fyrir jól',
    },
    addons: [
      { type: 'kross', code: 'BK101', label: 'Kross', qty: 1 },
      { type: 'luktVasi', code: 'LK01', label: 'Lukt', qty: 1 },
      { type: 'fugl', code: 'FK01', label: 'Dúfa', qty: 2 },
      { type: 'annad', code: 'Möl+Dúk', qty: 1 },
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

const q = wb.getWorksheet('Pantanir')!
const v = wb.getWorksheet('Vörulisti')!

const cell = (addr: string) => q.getCell(addr).value
const checks: [string, unknown, unknown][] = [
  ['D9 customer name', cell('D9'), 'Selma Harðardóttir'],
  ['D11 kennitala', cell('D11'), '010160-1234'],
  ['D13 phone', cell('D13'), '+354 555 1234'],
  ['D14 email', cell('D14'), 'selma@example.is'],
  ['J15 cemetery', cell('J15'), 'Gufunes'],
  ['C19 deceased name', cell('C19'), 'Hörður Kristjánsson'],
  ['C20 dates line', cell('C20'), 'f.17.04.51 d.15.01.25'],
  ['C22 inscription', cell('C22'), 'Minning þín lifir'],
  ['D29 letur', cell('D29'), 'Times New Roman'],
  ['H29 stone code', cell('H29'), 'H111'],
  ['I29 stone colour', cell('I29'), 'SB'],
  ['H30 per-char price', cell('H30'), 260],
  ['D31 litur', cell('D31'), 'Gull'],
  ['H31 kross', cell('H31'), 'BK101'],
  ['H32 lukt/vasi', cell('H32'), 'LK01'],
  ['H34 fugl 1', cell('H34'), 'FK01'],
  ['H35 fugl 2 (qty=2)', cell('H35'), 'FK01'],
  ['H40 annað', cell('H40'), 'Möl+Dúk'],
  ['K50 uppsetning', cell('K50'), 86600],
  ['C34 comments', cell('C34'), 'Óska eftir uppsetningu fyrir jól'],
]
let ok = true
console.log('--- Pantanir assertions ---')
for (const [label, got, want] of checks) {
  const pass = got === want
  if (!pass) ok = false
  console.log(`  ${pass ? '✔' : '✘'} ${label}: ${JSON.stringify(got)}${pass ? '' : ` (expected ${JSON.stringify(want)})`}`)
}

// Price formulas must survive (never overwritten)
const k29 = q.getCell('K29').value
const k54 = q.getCell('K54').value
const k31 = q.getCell('K31').value
const isFormula = (val: unknown) => Boolean(val && typeof val === 'object' && ('formula' in (val as object) || 'sharedFormula' in (val as object)))
console.log(`  ${isFormula(k29) ? '✔' : '✘'} K29 stone price is a formula`)
console.log(`  ${isFormula(k31) ? '✔' : '✘'} K31 kross price is a formula (restored)`)
console.log(`  ${isFormula(k54) ? '✔' : '✘'} K54 total is a formula`)
if (!isFormula(k29) || !isFormula(k31) || !isFormula(k54)) ok = false

// DK price injection into Vörulisti (template's own H111 price was 172000)
const priceOf = (codeCol: string, priceCol: string, code: string, from: number, to: number) => {
  for (let r = from; r <= to; r++) {
    if (v.getCell(`${codeCol}${r}`).value === code) return v.getCell(`${priceCol}${r}`).value
  }
  return undefined
}
const injected: [string, unknown, number][] = [
  ['H111 stone price', priceOf('C', 'D', 'H111', 4, 165), 175000],
  ['BK101 kross price', priceOf('H', 'I', 'BK101', 4, 149), 15000],
  ['LK01 lukt price', priceOf('K', 'L', 'LK01', 4, 38), 58000],
  ['FK01 fugl price', priceOf('N', 'O', 'FK01', 4, 50), 37500],
]
console.log('--- Vörulisti DK price injection ---')
for (const [label, got, want] of injected) {
  const pass = got === want
  if (!pass) ok = false
  console.log(`  ${pass ? '✔' : '✘'} ${label}: ${JSON.stringify(got)}${pass ? '' : ` (expected ${want})`}`)
}

// ExcelJS does not parse calcPr back on load, so check the written XML directly.
const workbookXml = execFileSync('unzip', ['-p', filePath, 'xl/workbook.xml']).toString()
const hasFullCalcOnLoad = /fullCalcOnLoad="1"/.test(workbookXml)
console.log(`  ${hasFullCalcOnLoad ? '✔' : '✘'} fullCalcOnLoad in workbook.xml`)
if (!hasFullCalcOnLoad) ok = false

console.log(ok ? '\n✅ PIPELINE OK' : '\n❌ PIPELINE ASSERTIONS FAILED')
process.exit(ok ? 0 : 1)
