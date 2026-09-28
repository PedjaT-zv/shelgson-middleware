import { readFile } from 'fs/promises'
import path from 'path'

import ExcelJS from 'exceljs'

/**
 * Excel quote generation against the client's REAL master template
 * (src/templates/master-quote-template.xlsx — Icelandic, and it must stay
 * Icelandic; we only write values into input cells, never labels).
 *
 * Template layout (see TEMPLATE_MAP):
 *  - Sheet "Pantanir": the order form. Input cells for customer / deceased /
 *    inscription / stone / add-on codes. Price cells carry the template's own
 *    VLOOKUP formulas over named ranges (STVerð, KrossarVerð, LuktirVasarVerð,
 *    FuglarVerð, MyndVerð, RammiVerð, AnnaðVerð) — we never overwrite formulas.
 *  - Sheet "Vörulisti": the code → price tables those named ranges point at.
 *    We inject current DK prices here by matching itemCode, so the template's
 *    formulas price the order from live data. Codes we don't know keep the
 *    template's own price.
 *  - Sheet "Sheet1": internal notes — untouched.
 *
 * ExcelJS preserves formulas but does not recalculate, so we set
 * `fullCalcOnLoad` and Excel/LibreOffice recomputes when the file is opened.
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
  orderSheet: 'Pantanir',
  priceSheet: 'Vörulisti',
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
  // K31 is static in the saved template; restore the standard lookup formula
  // when we place a cross so it prices itself like the other add-on rows.
  krossPriceCell: 'K31',
  krossPriceFormula:
    'IF(ISNA(VLOOKUP(H31, KrossarVerð, 2, FALSE)) = TRUE, "", VLOOKUP(H31, KrossarVerð, 2, FALSE))',
  // Vörulisti code → price column pairs (bounds from the workbook's named ranges).
  priceTables: [
    { codeCol: 'C', priceCol: 'D', from: 4, to: 165 }, // STVerð (stones)
    { codeCol: 'H', priceCol: 'I', from: 4, to: 149 }, // KrossarVerð
    { codeCol: 'K', priceCol: 'L', from: 4, to: 38 }, // LuktirVasarVerð
    { codeCol: 'N', priceCol: 'O', from: 4, to: 50 }, // MyndVerð + RammiVerð + FuglarVerð
    { codeCol: 'Q', priceCol: 'R', from: 5, to: 140 }, // AnnaðVerð
  ],
} as const

function isFormula(v: ExcelJS.CellValue): boolean {
  return Boolean(v && typeof v === 'object' && ('formula' in v || 'sharedFormula' in v))
}

function setIfPresent(ws: ExcelJS.Worksheet, addr: string, value: unknown) {
  if (value !== undefined && value !== null && value !== '') {
    ws.getCell(addr).value = value as ExcelJS.CellValue
  }
}

/**
 * Load the master template, inject current DK prices into the Vörulisti price
 * tables (matched by itemCode), fill the Pantanir input cells, flag full
 * recalc, and return the resulting .xlsx as a Buffer. Formula cells are never
 * overwritten; template labels stay in Icelandic untouched.
 */
export async function generateQuoteWorkbook(
  templateBuffer: Buffer,
  quote: QuoteData,
  prices: PriceRow[],
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(templateBuffer)

  const map = TEMPLATE_MAP

  // --- 1. Inject DK prices into the Vörulisti tables (match by code) ---
  const priceWs = wb.getWorksheet(map.priceSheet)
  if (!priceWs) throw new Error(`Template is missing the "${map.priceSheet}" sheet`)

  const priceByCode = new Map(prices.map((p) => [p.itemCode, p.unitPrice]))
  for (const table of map.priceTables) {
    for (let r = table.from; r <= table.to; r++) {
      const code = priceWs.getCell(`${table.codeCol}${r}`).value
      if (typeof code !== 'string') continue
      const dkPrice = priceByCode.get(code.trim())
      if (dkPrice === undefined) continue
      const priceCell = priceWs.getCell(`${table.priceCol}${r}`)
      if (isFormula(priceCell.value)) continue
      priceCell.value = dkPrice
    }
  }

  // --- 2. Fill the order-form input cells ---
  const q = wb.getWorksheet(map.orderSheet)
  if (!q) throw new Error(`Template is missing the "${map.orderSheet}" sheet`)

  setIfPresent(q, map.cells.customerName, quote.customerName)
  setIfPresent(q, map.cells.kennitala, quote.kennitala)
  setIfPresent(q, map.cells.address, quote.address)
  setIfPresent(q, map.cells.phone, quote.phone)
  setIfPresent(q, map.cells.email, quote.email)
  setIfPresent(q, map.cells.orderDate, quote.orderDate)
  setIfPresent(q, map.cells.delivery, quote.delivery)
  setIfPresent(q, map.cells.cemetery, quote.cemetery)
  setIfPresent(q, map.cells.letur, quote.letur)
  setIfPresent(q, map.cells.stoneCode, quote.productItemCode)
  setIfPresent(q, map.cells.stoneColor, quote.stoneColor)
  setIfPresent(q, map.cells.perCharPrice, quote.perCharPrice)
  setIfPresent(q, map.cells.litur, quote.litur)
  setIfPresent(q, map.cells.solumadur, quote.solumadur)
  setIfPresent(q, map.cells.blomarammiVerd, quote.blomarammiVerd)
  setIfPresent(q, map.cells.uppsetningVerd, quote.uppsetningVerd)
  if (typeof quote.afslattur === 'number' && quote.afslattur !== 0) {
    q.getCell(map.cells.afslattur).value = -Math.abs(quote.afslattur)
  }

  // --- 3. Inscription block: name, "f.… d.…" line, then the free lines ---
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

  // --- 4. Comments (one line per row under Athugasemdir) ---
  if (quote.comments) {
    const lines = quote.comments.split('\n')
    map.comments.rows.forEach((row, i) => {
      if (lines[i]) q.getCell(`${map.comments.col}${row}`).value = lines[i]
    })
  }

  // --- 5. Add-ons into their typed slots (qty > 1 repeats the code) ---
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
      if (slot) q.getCell(slot).value = addon.code
      else overflow.push(addon.code)
    }
  }
  // Anything that didn't fit its own section lands in a free "Annað" row so it
  // is at least visible to the salesperson (price may show blank there).
  for (const code of overflow) {
    const slot = free.annad.shift()
    if (slot) q.getCell(slot).value = code
  }
  // A placed cross needs its lookup formula restored (static cell in template).
  if (quote.addons.some((a) => a.type === 'kross')) {
    q.getCell(map.krossPriceCell).value = { formula: map.krossPriceFormula }
  }

  // --- 6. Force recalculation when the file is opened ---
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
