/**
 * End-to-end pipeline check via the Local API (no HTTP server needed):
 *   1. read the expected prices live from DK (needs DK_API_KEY)
 *   2. create an inquiry (fires the afterChange hook -> queues processInquiry)
 *   3. run the 'inquiries' queue
 *   4. assert the quote was generated and inspect the .xlsx against the REAL
 *      Icelandic master template (only sheet "Pantanir": inputs + DK prices)
 *
 * Run with: DISABLE_AUTORUN=true SALES_EMAIL=... DESIGNER_EMAIL=... tsx scripts/verify-pipeline.mts
 */
import 'dotenv/config'

import { execFileSync } from 'child_process'
import { readFile } from 'fs/promises'
import path from 'path'

import ExcelJS from 'exceljs'
import { getPayload } from 'payload'

import { fetchProduct } from '../src/lib/dkClient.js'
import config from '../src/payload.config.js'

const payload = await getPayload({ config })

// --- 1. Expected prices straight from DK: the job must write exactly these
//        next to each code on the order sheet ---
const expected: Record<string, number> = {}
for (const code of ['H101', 'BK101', 'LK01', 'FK01']) {
  const p = await fetchProduct(code)
  if (!p?.UnitPrice1WithTax) {
    console.error(`x ${code} has no VAT-inclusive price in DK — FAIL`)
    process.exit(1)
  }
  expected[code] = p.UnitPrice1WithTax
}
console.log('✔ live DK prices (with VAT):', JSON.stringify(expected))

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
    wantedProduct: { itemCode: 'H101' },
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
  ['H29 stone code', cell('H29'), 'H101'],
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
  // Prices come straight from the DK catalog, written next to each code
  ['K29 stone price (DK)', cell('K29'), expected.H101],
  ['K31 kross price (DK)', cell('K31'), expected.BK101],
  ['K32 lukt price (DK)', cell('K32'), expected.LK01],
  ['K34 fugl 1 price (DK)', cell('K34'), expected.FK01],
  ['K35 fugl 2 price (DK)', cell('K35'), expected.FK01],
  ['K40 annað not in DK → blank', cell('K40'), null],
  // The template is the client's filled example: what the inquiry doesn't
  // set must come out empty, not as the example's values
  ['K39 blómarammi (example 82000) cleared', cell('K39'), null],
  ['E57 sölumaður (example Guðrún) cleared', cell('E57'), null],
  ['H44 annað (example Möl+Dúk) cleared', cell('H44'), null],
  ['K44 annað price (example 36600) cleared', cell('K44'), null],
]
let ok = true
console.log('--- Pantanir assertions ---')
for (const [label, got, want] of checks) {
  const pass = got === want
  if (!pass) ok = false
  console.log(`  ${pass ? '✔' : '✘'} ${label}: ${JSON.stringify(got)}${pass ? '' : ` (expected ${JSON.stringify(want)})`}`)
}

// Total stays a formula (follows manual edits) with its computed result stored:
// stone + Áletrun (53 letters × 260) + kross + lukt + 2 × fugl + uppsetning
const expectedTotal = expected.H101 + 53 * 260 + expected.BK101 + expected.LK01 + 2 * expected.FK01 + 86600
const k54 = cell('K54') as { formula?: string; result?: unknown } | null
const totalOk = k54?.formula === 'SUM(K29:L52)' && k54.result === expectedTotal
console.log(`  ${totalOk ? '✔' : '✘'} K54 total = SUM(K29:L52) → ${JSON.stringify(k54?.result)}${totalOk ? '' : ` (expected ${expectedTotal})`}`)
if (!totalOk) ok = false

// Only Pantanir is left; Vörulisti and everything pointing at it are gone
const sheetNames = wb.worksheets.map((ws) => ws.name)
const onlyOrderSheet = sheetNames.length === 1 && sheetNames[0] === 'Pantanir'
console.log(`  ${onlyOrderSheet ? '✔' : '✘'} only the Pantanir sheet: ${JSON.stringify(sheetNames)}`)
if (!onlyOrderSheet) ok = false
const sheetXml = execFileSync('unzip', ['-p', filePath, 'xl/worksheets/sheet1.xml']).toString()
const noLinks = !/Vörulisti|<dataValidation /.test(sheetXml) && wb.definedNames.model.length === 0
console.log(`  ${noLinks ? '✔' : '✘'} no named ranges, lookups or drop-downs pointing at Vörulisti`)
if (!noLinks) ok = false

// ExcelJS does not parse calcPr back on load, so check the written XML directly.
const workbookXml = execFileSync('unzip', ['-p', filePath, 'xl/workbook.xml']).toString()
const hasFullCalcOnLoad = /fullCalcOnLoad="1"/.test(workbookXml)
console.log(`  ${hasFullCalcOnLoad ? '✔' : '✘'} fullCalcOnLoad in workbook.xml`)
if (!hasFullCalcOnLoad) ok = false

console.log(ok ? '\n✅ PIPELINE OK' : '\n❌ PIPELINE ASSERTIONS FAILED')
process.exit(ok ? 0 : 1)
