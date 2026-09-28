import type { Inquiry } from '../payload-types'
import type { AddonType, QuoteData } from './excel'

/** "First Last" — undefined when both parts are missing. */
export function joinName(first?: string | null, last?: string | null): string | undefined {
  const s = [first, last].filter(Boolean).join(' ').trim()
  return s || undefined
}

/**
 * dd.mm.yy for the inscription's "f.… d.…" line. ISO dates (yyyy-mm-dd) are
 * converted; anything else (e.g. already "17.04.51") passes through as-is.
 */
export function toIcelandicShortDate(v?: string | null): string | undefined {
  if (!v) return undefined
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})/)
  return m ? `${m[3]}.${m[2]}.${m[1].slice(2)}` : v
}

/** dd.mm.yyyy for the order's Dagsetning cell. */
export function toIcelandicDate(d: Date): string {
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  return `${dd}.${mm}.${d.getFullYear()}`
}

/** Map an Inquiry document onto the Excel generator's QuoteData shape. */
export function buildQuoteData(inquiry: Inquiry): QuoteData {
  const customer = inquiry.customer ?? {}
  const deceased = inquiry.deceased ?? {}
  const options = inquiry.options ?? {}
  const addons = (inquiry.addons ?? []).filter((a) => a.code)

  return {
    customerName: joinName(customer.firstName, customer.lastName),
    kennitala: customer.kennitala ?? undefined,
    address: customer.address ?? undefined,
    phone: customer.phone ?? undefined,
    email: customer.email ?? undefined,
    orderDate: toIcelandicDate(new Date()),
    delivery: options.delivery ?? undefined,
    cemetery: options.cemetery ?? undefined,
    deceasedName: joinName(deceased.firstName, deceased.lastName),
    deceasedBorn: toIcelandicShortDate(deceased.bornDate),
    deceasedDied: toIcelandicShortDate(deceased.diedDate),
    inscriptionLines: (inquiry.inscriptionLines ?? []).map((l) => l.line ?? '').filter(Boolean),
    productItemCode: inquiry.wantedProduct?.itemCode ?? '',
    stoneColor: options.stoneColor ?? undefined,
    letur: options.letur ?? undefined,
    litur: options.litur ?? undefined,
    perCharPrice: options.perCharPrice ?? undefined,
    solumadur: options.solumadur ?? undefined,
    comments: options.comments ?? undefined,
    blomarammiVerd: options.blomarammiVerd ?? undefined,
    uppsetningVerd: options.uppsetningVerd ?? undefined,
    afslattur: options.afslattur ?? undefined,
    addons: addons.map((a) => ({
      type: (a.type ?? 'annad') as AddonType,
      code: a.code,
      qty: a.qty ?? 1,
    })),
  }
}
