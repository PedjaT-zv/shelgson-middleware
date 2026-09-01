/**
 * Minimal client for the dkPlus REST API (DK Hugbúnaður).
 *
 * Verified during research:
 *  - Base URL:  https://api.dkplus.is/api/v1
 *  - Auth:      header `Authorization: bearer <GUID>`  (lowercase "bearer")
 *  - Products:  GET /Product/page/{page}/{count}
 *  - Delta:     GET /Product/modified/{modified}/{page}/{count}
 *  - Field trim: ?include=Field1,Field2,...
 *
 * No official SDK exists, so we call it with fetch.
 */

export interface DkProduct {
  ItemCode: string
  RecordID?: number
  Description?: string
  Description2?: string
  UnitCode?: string
  Group?: string
  UnitPrice1?: number
  UnitPrice1WithTax?: number
  TaxPercent?: number
  CurrencyCode?: string
  Inactive?: boolean
  Deleted?: boolean
  ShowItemInWebShop?: boolean
  RecordModified?: string
}

const INCLUDE_FIELDS = [
  'ItemCode',
  'RecordID',
  'Description',
  'Description2',
  'UnitCode',
  'CurrencyCode',
  'UnitPrice1',
  'UnitPrice1WithTax',
  'TaxPercent',
  'Group',
  'Inactive',
  'Deleted',
  'ShowItemInWebShop',
  'RecordModified',
].join(',')

function baseUrl(): string {
  return (process.env.DK_API_BASE ?? 'https://api.dkplus.is/api/v1').replace(/\/$/, '')
}

function authHeaders(): Record<string, string> {
  const key = process.env.DK_API_KEY ?? ''
  if (!key) throw new Error('DK_API_KEY is not set')
  // DK examples use the lowercase "bearer" scheme with the raw GUID.
  return { Authorization: `bearer ${key}`, Accept: 'application/json' }
}

/** Some DK endpoints return a bare array; be tolerant of an envelope too. */
function extractArray(data: unknown): DkProduct[] {
  if (Array.isArray(data)) return data as DkProduct[]
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>
    for (const key of ['items', 'Items', 'value', 'data', 'Records']) {
      if (Array.isArray(obj[key])) return obj[key] as DkProduct[]
    }
  }
  return []
}

async function fetchProductsPage(
  page: number,
  count: number,
  modifiedSince?: string,
): Promise<DkProduct[]> {
  const p = modifiedSince
    ? `/Product/modified/${encodeURIComponent(modifiedSince)}/${page}/${count}`
    : `/Product/page/${page}/${count}`
  const url = `${baseUrl()}${p}?include=${INCLUDE_FIELDS}`
  const res = await fetch(url, {
    headers: authHeaders(),
    signal: AbortSignal.timeout(60_000),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`dkPlus ${res.status} ${res.statusText} for ${p}${body ? ` — ${body.slice(0, 200)}` : ''}`)
  }
  return extractArray(await res.json())
}

/**
 * Fetch a single product by ItemCode via GET /Product/{itemcode}. Returns null
 * when DK does not know the code (404). Used by the accept flow to pull live
 * prices for exactly the items on an inquiry.
 */
export async function fetchProduct(itemCode: string): Promise<DkProduct | null> {
  const url = `${baseUrl()}/Product/${encodeURIComponent(itemCode)}?include=${INCLUDE_FIELDS}`
  const res = await fetch(url, {
    headers: authHeaders(),
    signal: AbortSignal.timeout(30_000),
  })
  if (res.status === 404) return null
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(
      `dkPlus ${res.status} ${res.statusText} for /Product/${itemCode}${body ? ` — ${body.slice(0, 200)}` : ''}`,
    )
  }
  const data = await res.json()
  if (data && typeof data === 'object' && !Array.isArray(data) && 'ItemCode' in data) {
    return data as DkProduct
  }
  return extractArray(data)[0] ?? null
}

/**
 * Async iterator over every product, paging until a short page is returned.
 * `modifiedSince` (a YYYY-MM-DD or ISO date) switches to the delta endpoint.
 * `throttleMs` spaces requests out since DK publishes no rate limit.
 */
export async function* iterateProducts(opts: {
  count?: number
  modifiedSince?: string
  throttleMs?: number
} = {}): AsyncGenerator<DkProduct> {
  const count = opts.count ?? 200
  const throttleMs = opts.throttleMs ?? 250
  let page = 1
  // Hard cap to avoid an unbounded loop if the API never returns a short page.
  const maxPages = 10_000
  while (page <= maxPages) {
    const batch = await fetchProductsPage(page, count, opts.modifiedSince)
    for (const product of batch) yield product
    if (batch.length < count) break
    page += 1
    if (throttleMs > 0) await new Promise((r) => setTimeout(r, throttleMs))
  }
}
