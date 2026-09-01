import { readFile } from 'fs/promises'
import path from 'path'

import ExcelJS from 'exceljs'

/**
 * Excel quote generation.
 *
 * Strategy (confirmed with the client):
 *  - The master template keeps its VLOOKUP formulas; we only write INPUT cells
 *    (customer/deceased/inscription/codes) and repopulate the price-table sheet
 *    from the daily DK sync — so DK is the single source of truth for prices.
 *  - ExcelJS preserves formula strings but does NOT recalculate. We set
 *    `workbook.calcProperties.fullCalcOnLoad = true` so Excel/LibreOffice/Sheets
 *    recompute every VLOOKUP the moment the salesperson opens the file.
 *  - Totals are therefore correct in-file (the confirmed requirement). If a
 *    server-side total is ever needed, compute it from `prices` here — do not
 *    read it back from the written workbook (that value is stale).
 */

export interface QuoteData {
  customerName?: string
  customerEmail?: string
  customerPhone?: string
  deceasedName?: string
  deceasedBorn?: string
  deceasedDied?: string
  productItemCode: string
  inscriptionLines: string[]
  addons: { code: string; qty: number }[]
}

export interface PriceRow {
  itemCode: string
  unitPrice: number
  description?: string
}

/**
 * Maps logical fields to physical cells in the template. ALIGN THESE with the
 * client's real master-quote-template.xlsx (sheet names, cell addresses, and
 * the price table's columns/start row). The dev template built by
 * `buildDevTemplate()` matches this map exactly.
 */
export const TEMPLATE_MAP = {
  quoteSheet: 'Quote',
  priceSheet: 'Prices',
  price: {
    startRow: 2,
    itemCodeCol: 'A',
    unitPriceCol: 'B',
    descriptionCol: 'C',
  },
  cells: {
    customerName: 'C2',
    customerEmail: 'C3',
    customerPhone: 'C4',
    deceasedName: 'C5',
    deceasedBorn: 'C6',
    deceasedDied: 'C7',
    productItemCode: 'C9',
  },
  inscription: { startRow: 12, col: 'C', maxRows: 4 },
  addons: { startRow: 17, codeCol: 'A', qtyCol: 'B', maxRows: 8 },
} as const

function setIfPresent(ws: ExcelJS.Worksheet, addr: string, value: unknown) {
  if (value !== undefined && value !== null && value !== '') {
    ws.getCell(addr).value = value as ExcelJS.CellValue
  }
}

/**
 * Load the master template, inject current DK prices into the price sheet, fill
 * the customer/deceased/inscription/addon input cells, flag full recalc, and
 * return the resulting .xlsx as a Buffer. Formula cells are never overwritten.
 */
export async function generateQuoteWorkbook(
  templateBuffer: Buffer,
  quote: QuoteData,
  prices: PriceRow[],
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(templateBuffer)

  const map = TEMPLATE_MAP

  // --- 1. Repopulate the price table from the DK catalog ---
  const priceWs = wb.getWorksheet(map.priceSheet)
  if (!priceWs) throw new Error(`Template is missing the "${map.priceSheet}" sheet`)

  // Clear any existing rows in the price columns from startRow down.
  const lastRow = Math.max(priceWs.rowCount, map.price.startRow + prices.length)
  for (let r = map.price.startRow; r <= lastRow; r++) {
    priceWs.getCell(`${map.price.itemCodeCol}${r}`).value = null
    priceWs.getCell(`${map.price.unitPriceCol}${r}`).value = null
    priceWs.getCell(`${map.price.descriptionCol}${r}`).value = null
  }
  prices.forEach((row, i) => {
    const r = map.price.startRow + i
    priceWs.getCell(`${map.price.itemCodeCol}${r}`).value = row.itemCode
    priceWs.getCell(`${map.price.unitPriceCol}${r}`).value = row.unitPrice
    if (row.description) priceWs.getCell(`${map.price.descriptionCol}${r}`).value = row.description
  })

  // --- 2. Fill quote input cells ---
  const q = wb.getWorksheet(map.quoteSheet)
  if (!q) throw new Error(`Template is missing the "${map.quoteSheet}" sheet`)

  setIfPresent(q, map.cells.customerName, quote.customerName)
  setIfPresent(q, map.cells.customerEmail, quote.customerEmail)
  setIfPresent(q, map.cells.customerPhone, quote.customerPhone)
  setIfPresent(q, map.cells.deceasedName, quote.deceasedName)
  setIfPresent(q, map.cells.deceasedBorn, quote.deceasedBorn)
  setIfPresent(q, map.cells.deceasedDied, quote.deceasedDied)
  setIfPresent(q, map.cells.productItemCode, quote.productItemCode)

  // Inscription lines (one per row, capped).
  quote.inscriptionLines.slice(0, map.inscription.maxRows).forEach((line, i) => {
    q.getCell(`${map.inscription.col}${map.inscription.startRow + i}`).value = line
  })

  // Add-on codes + quantities (price/line-total columns are template formulas).
  quote.addons.slice(0, map.addons.maxRows).forEach((addon, i) => {
    const r = map.addons.startRow + i
    q.getCell(`${map.addons.codeCol}${r}`).value = addon.code
    q.getCell(`${map.addons.qtyCol}${r}`).value = addon.qty
  })

  // --- 3. Force recalculation when the file is opened ---
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

/**
 * Build a DEV master template that matches TEMPLATE_MAP, with real VLOOKUP
 * formulas so the fullCalcOnLoad recalculation can be verified end-to-end.
 * Replace src/templates/master-quote-template.xlsx with the client's real file.
 */
export async function buildDevTemplate(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()

  const prices = wb.addWorksheet('Prices')
  prices.getCell('A1').value = 'ItemCode'
  prices.getCell('B1').value = 'UnitPrice'
  prices.getCell('C1').value = 'Description'

  const q = wb.addWorksheet('Quote')
  q.getCell('B2').value = 'Customer'
  q.getCell('B3').value = 'Email'
  q.getCell('B4').value = 'Phone'
  q.getCell('B5').value = 'Deceased'
  q.getCell('B6').value = 'Born'
  q.getCell('B7').value = 'Died'
  q.getCell('B9').value = 'Product code'
  q.getCell('B10').value = 'Product price'
  // VLOOKUP the chosen product's unit price from the Prices sheet.
  q.getCell('C10').value = { formula: 'VLOOKUP(C9,Prices!A:B,2,FALSE)' }

  q.getCell('B11').value = 'Inscription'

  // Add-on table: A=code (input), B=qty (input), C=unit price (VLOOKUP), D=line total.
  q.getCell('A16').value = 'Add-on code'
  q.getCell('B16').value = 'Qty'
  q.getCell('C16').value = 'Unit price'
  q.getCell('D16').value = 'Line total'
  for (let r = 17; r <= 24; r++) {
    q.getCell(`C${r}`).value = { formula: `IF(A${r}="",0,VLOOKUP(A${r},Prices!A:B,2,FALSE))` }
    q.getCell(`D${r}`).value = { formula: `B${r}*C${r}` }
  }

  q.getCell('B26').value = 'TOTAL'
  q.getCell('C26').value = { formula: 'C10+SUM(D17:D24)' }

  const out = await wb.xlsx.writeBuffer()
  return Buffer.from(out)
}
