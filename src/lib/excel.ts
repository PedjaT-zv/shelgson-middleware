import { readFile } from 'fs/promises'
import path from 'path'

import ExcelJS from 'exceljs'

import { normalizeItemCode } from './catalogUpsert'

/**
 * Excel quote generation against the client's REAL master template
 * (src/templates/master-quote-template.xlsx — Icelandic, and it must stay
 * Icelandic; we only write values into input cells, never labels).
 *
 * Template layout (see TEMPLATE_MAP):
 *  - Sheet "Pantanir": the order form. Input cells for customer / deceased /
 *    inscription / stone / add-on codes, and a price cell (column K) next to
 *    each code.
 *  - Sheet "Vörulisti": the template's own code → price lists.
 *  - Sheet "Sheet1": internal notes.
 *
 * The quote keeps only Pantanir. Prices come only from the DK catalog, so the
 * other sheets are removed, with every named range, VLOOKUP and drop-down list
 * that pointed at Vörulisti.
 *
 * Each price cell gets the catalog's VAT-inclusive price for the code next to
 * it, matched case-insensitively (DK stores "h101", the template "H101").
 * Codes without a catalog price are left blank for the salesperson.
 *
 * The saved template is the client's *filled* example (customer Selma,
 * salesperson Guðrún, Blómarammi 82 000, cross "Kringla", "Möl+Dúk", …), so
 * every input and price cell is cleared before the inquiry is written in —
 * otherwise whatever an inquiry leaves out would leak the example into the quote.
 *
 * The template's remaining formulas (letter count, Áletrun price, total) are
 * kept, so the total follows manual edits; `fullCalcOnLoad` makes spreadsheet
 * apps recompute them on open, and we also store their computed results so
 * viewers that don't recalculate (Quick Look, mail previews) show them right.
 */

export type AddonType = 'kross' | 'luktVasi' | 'fugl' | 'mynd' | 'rammi' | 'annad'

export interface QuoteData {
  customerName?: string
  kennitala?: string
  address?: string
  phone?: string
  email?: string
  /** Order date shown in the Dagsetning cell (dd.mm.yyyy). */
  orderDate?: string
  delivery?: string
  cemetery?: string
  deceasedName?: string
  /** Short dates (dd.mm.yy) — rendered as "f.<born> d.<died>" under the name. */
  deceasedBorn?: string
  deceasedDied?: string
  inscriptionLines: string[]
  /** DK ItemCode of the tombstone (Steinn), e.g. "H111". */
  productItemCode: string
  /** Stone colour code from the Glitir list (SB, BG, NA, …). */
  stoneColor?: string
  letur?: string
  litur?: string
  perCharPrice?: number
  solumadur?: string
  comments?: string
  blomarammiVerd?: number
  uppsetningVerd?: number
  /** Discount amount; written as a negative number so the total subtracts it. */
  afslattur?: number
  addons: { type: AddonType; code: string; qty?: number }[]
}

export interface PriceRow {
  itemCode: string
  unitPrice: number
}

/**
 * Maps logical fields to physical cells in master-quote-template.xlsx.
 * Verified against the client's filled example (Sep 2026). If the client
 * reshuffles the template, re-align these addresses.
 */
export const TEMPLATE_MAP = {
  /** The only sheet the quote keeps. */
  orderSheet: 'Pantanir',
  cells: {
    customerName: 'D9', // Nafn
    kennitala: 'D11', // Kt
    address: 'D12', // Heimili
    phone: 'D13', // Sími
    email: 'D14', // Netfang
    orderDate: 'K11', // Dagsetning
    delivery: 'K12', // Afhending
    cemetery: 'J15', // Kirkjugarður
    letur: 'D29', // Letur
    stoneCode: 'H29', // Steinn
    stoneColor: 'I29', // Glitir code next to the stone
    perCharPrice: 'H30', // Áletrun price per character (260/1070/1250/1490)
    litur: 'D31', // Litur
    solumadur: 'E57', // Sölumaður
    blomarammiVerd: 'K39', // Blómarammi — manual price cell
    uppsetningVerd: 'K50', // Uppsetning — manual price cell
    afslattur: 'K52', // Afsláttur — manual (negative) price cell
  },
  inscription: {
    nameCell: 'C19',
    datesCell: 'C20',
    extraStartRow: 22,
    col: 'C',
    lastRow: 27,
  },
  comments: { col: 'C', rows: [34, 35, 36] }, // under "Athugasemdir:"
  addonSlots: {
    kross: ['H31'],
    luktVasi: ['H32', 'H33'],
    fugl: ['H34', 'H35', 'H36'],
    mynd: ['H37'],
    rammi: ['H38'],
    annad: ['H40', 'H41', 'H42', 'H43', 'H44', 'H45', 'H46', 'H47', 'H48', 'H49'],
  },
  /** Column holding the price of the code on the same row (stone + add-ons). */
  priceCol: 'K',
  // Formula cells whose results we compute and store as well (see header).
  letterCount: { cell: 'D30', sources: ['C18:C27', 'H20:H25'] }, // Stafafjöldi = letters excl. spaces
  inscriptionPriceCell: 'K30', // = D30 * H30
  total: { cell: 'K54', range: 'K29:L52' }, // Heildarverð = SUM(K29:L52)
} as const

function setIfPresent(ws: ExcelJS.Worksheet, addr: string, value: unknown) {
  if (value !== undefined && value !== null && value !== '') {
    ws.getCell(addr).value = value as ExcelJS.CellValue
  }
}

/** The price cell for the code cell on the same row (H31 → K31). */
function priceCellFor(ws: ExcelJS.Worksheet, codeAddr: string): string {
  return `${TEMPLATE_MAP.priceCol}${ws.getCell(codeAddr).row}`
}

/** Every order-sheet cell the generator may write (cleared before filling). */
function templateInputCells(ws: ExcelJS.Worksheet): string[] {
  const { cells, inscription, comments, addonSlots } = TEMPLATE_MAP
  const codeCells: string[] = [cells.stoneCode, ...Object.values(addonSlots).flat()]
  const out: string[] = [...Object.values(cells), inscription.nameCell, inscription.datesCell]
  for (let r = inscription.extraStartRow; r <= inscription.lastRow; r++) {
    out.push(`${inscription.col}${r}`)
  }
  out.push(...comments.rows.map((r) => `${comments.col}${r}`))
  out.push(...codeCells, ...codeCells.map((addr) => priceCellFor(ws, addr)))
  return out
}

function forEachAddress(ws: ExcelJS.Worksheet, range: string, fn: (addr: string) => void) {
  const [from, to = from] = range.split(':')
  const a = ws.getCell(from)
  const b = ws.getCell(to)
  for (let r = Number(a.row); r <= Number(b.row); r++) {
    for (let c = Number(a.col); c <= Number(b.col); c++) fn(ws.getCell(r, c).address)
  }
}

/** A cell's numeric value as SUM sees it (merged-away cells count as empty). */
function numericValue(ws: ExcelJS.Worksheet, addr: string): number {
  const cell = ws.getCell(addr)
  if (cell.isMerged && cell.master.address !== cell.address) return 0
  const v = cell.value
  if (typeof v === 'number') return v
  if (v && typeof v === 'object' && 'result' in v && typeof v.result === 'number') return v.result
  return 0
}

function setFormulaResult(ws: ExcelJS.Worksheet, addr: string, result: number) {
  const cell = ws.getCell(addr)
  cell.value = { formula: cell.formula, result }
}

/**
 * Load the master template, drop every sheet but Pantanir, fill its input cells, price every code from the DK catalog, and return the resulting
 * .xlsx as a Buffer. Template labels stay in Icelandic untouched.
 */
export async function generateQuoteWorkbook(
  templateBuffer: Buffer,
  quote: QuoteData,
  prices: PriceRow[],
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(templateBuffer)

  const map = TEMPLATE_MAP
  const q = wb.getWorksheet(map.orderSheet)
  if (!q) throw new Error(`Template is missing the "${map.orderSheet}" sheet`)

  // --- 1. Keep only the order sheet; drop the named ranges and the order
  //        sheet's drop-down lists too (all sourced from Vörulisti) ---
  for (const ws of [...wb.worksheets]) if (ws.id !== q.id) wb.removeWorksheet(ws.id)
  wb.definedNames.model = []
  ;(q as unknown as { dataValidations: { model: Record<string, unknown> } }).dataValidations.model = {}

  // --- 2. Clear the filled example's inputs and prices ---
  for (const addr of templateInputCells(q)) q.getCell(addr).value = null

  // --- 3. Fill the order-form input cells ---
  setIfPresent(q, map.cells.customerName, quote.customerName)
  setIfPresent(q, map.cells.kennitala, quote.kennitala)
  setIfPresent(q, map.cells.address, quote.address)
  setIfPresent(q, map.cells.phone, quote.phone)
  setIfPresent(q, map.cells.email, quote.email)
  setIfPresent(q, map.cells.orderDate, quote.orderDate)
  setIfPresent(q, map.cells.delivery, quote.delivery)
  setIfPresent(q, map.cells.cemetery, quote.cemetery)
  setIfPresent(q, map.cells.letur, quote.letur)
  setIfPresent(q, map.cells.stoneColor, quote.stoneColor)
  setIfPresent(q, map.cells.perCharPrice, quote.perCharPrice)
  setIfPresent(q, map.cells.litur, quote.litur)
  setIfPresent(q, map.cells.solumadur, quote.solumadur)
  setIfPresent(q, map.cells.blomarammiVerd, quote.blomarammiVerd)
  setIfPresent(q, map.cells.uppsetningVerd, quote.uppsetningVerd)
  if (typeof quote.afslattur === 'number' && quote.afslattur !== 0) {
    q.getCell(map.cells.afslattur).value = -Math.abs(quote.afslattur)
  }

  // --- 4. Inscription block: name, "f.… d.…" line, then the free lines ---
  setIfPresent(q, map.inscription.nameCell, quote.deceasedName)
  const dates = [
    quote.deceasedBorn ? `f.${quote.deceasedBorn}` : '',
    quote.deceasedDied ? `d.${quote.deceasedDied}` : '',
  ]
    .filter(Boolean)
    .join(' ')
  setIfPresent(q, map.inscription.datesCell, dates)
  const maxExtra = map.inscription.lastRow - map.inscription.extraStartRow + 1
  quote.inscriptionLines.slice(0, maxExtra).forEach((line, i) => {
    q.getCell(`${map.inscription.col}${map.inscription.extraStartRow + i}`).value = line
  })

  // --- 5. Comments (one line per row under Athugasemdir) ---
  if (quote.comments) {
    const lines = quote.comments.split('\n')
    map.comments.rows.forEach((row, i) => {
      if (lines[i]) q.getCell(`${map.comments.col}${row}`).value = lines[i]
    })
  }

  // --- 6. Stone + add-on codes, each priced from the catalog ---
  const priceByCode = new Map(prices.map((p) => [normalizeItemCode(p.itemCode), p.unitPrice]))
  const placeCode = (codeAddr: string, code: string) => {
    q.getCell(codeAddr).value = code
    const price = priceByCode.get(normalizeItemCode(code))
    if (price !== undefined) q.getCell(priceCellFor(q, codeAddr)).value = price
  }

  if (quote.productItemCode) placeCode(map.cells.stoneCode, quote.productItemCode)

  // Add-ons go into their typed slots (qty > 1 repeats the code).
  const free: Record<AddonType, string[]> = {
    kross: [...map.addonSlots.kross],
    luktVasi: [...map.addonSlots.luktVasi],
    fugl: [...map.addonSlots.fugl],
    mynd: [...map.addonSlots.mynd],
    rammi: [...map.addonSlots.rammi],
    annad: [...map.addonSlots.annad],
  }
  const overflow: string[] = []
  for (const addon of quote.addons) {
    for (let i = 0; i < Math.max(1, addon.qty ?? 1); i++) {
      const slot = free[addon.type]?.shift()
      if (slot) placeCode(slot, addon.code)
      else overflow.push(addon.code)
    }
  }
  // Anything that didn't fit its own section lands in a free "Annað" row so it
  // is at least visible (and priced) for the salesperson.
  for (const code of overflow) {
    const slot = free.annad.shift()
    if (slot) placeCode(slot, code)
  }

  // --- 7. Remaining formulas: write shared ones out per cell (no app has to
  //        expand them) and drop the example's stale cached results ---
  const formulas: [ExcelJS.Cell, string][] = []
  q.eachRow((row) =>
    row.eachCell((cell) => {
      if (cell.type === ExcelJS.ValueType.Formula && cell.formula) formulas.push([cell, cell.formula])
    }),
  )
  for (const [cell, formula] of formulas) cell.value = { formula }

  // ...then store the results a reader looks at: letter count, Áletrun, total.
  let letters = 0
  for (const range of map.letterCount.sources) {
    forEachAddress(q, range, (addr) => {
      const v = q.getCell(addr).value
      if (typeof v === 'string') letters += v.replace(/ /g, '').length
    })
  }
  setFormulaResult(q, map.letterCount.cell, letters)
  setFormulaResult(q, map.inscriptionPriceCell, letters * (quote.perCharPrice ?? 0))
  let total = 0
  forEachAddress(q, map.total.range, (addr) => (total += numericValue(q, addr)))
  setFormulaResult(q, map.total.cell, total)

  // --- 8. Recompute on open in spreadsheet apps ---
  wb.calcProperties.fullCalcOnLoad = true

  const out = await wb.xlsx.writeBuffer()
  return Buffer.from(out)
}

/** Load the master template from disk (QUOTE_TEMPLATE_PATH or src/templates). */
export async function loadMasterTemplate(): Promise<Buffer> {
  const p =
    process.env.QUOTE_TEMPLATE_PATH ||
    path.join(process.cwd(), 'src', 'templates', 'master-quote-template.xlsx')
  return readFile(p)
}

/** Sanitize a customer name into a safe filename fragment. */
export function quoteFileName(customerName: string | undefined, inquiryId: string | number): string {
  const safe = (customerName ?? 'customer').replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 60) || 'customer'
  return `Quote - ${safe} - ${inquiryId}.xlsx`
}
