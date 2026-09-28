/**
 * Email body builders for the two messages sent per inquiry. Sending (with
 * attachments) happens in the processInquiry job via payload.sendEmail.
 */

export interface InquiryEmailData {
  id: string | number
  customerName?: string
  customerEmail?: string
  customerPhone?: string
  deceasedName?: string
  deceasedBorn?: string
  deceasedDied?: string
  productItemCode: string
  productDescription?: string
  inscriptionLines: string[]
  addons: { type?: string; code: string; label?: string; qty: number }[]
  options?: { letur?: string; litur?: string; stoneColor?: string; cemetery?: string }
  referenceImageUrls: string[]
}

const ADDON_TYPE_LABELS: Record<string, string> = {
  kross: 'Kross',
  luktVasi: 'Lukt/vasi',
  fugl: 'Fugl',
  mynd: 'Mynd',
  rammi: 'Rammi',
  annad: 'Annað',
}

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function row(label: string, value: unknown): string {
  return `<tr><td style="padding:4px 12px 4px 0;color:#555;vertical-align:top">${esc(label)}</td><td style="padding:4px 0">${esc(value) || '—'}</td></tr>`
}

/** Designer brief: all customer choices + reference images, asking for a mockup. */
export function buildDesignerBrief(data: InquiryEmailData): { subject: string; html: string } {
  const subject = `Mockup request — ${data.customerName ?? 'New inquiry'} (${data.productItemCode})`

  const inscriptions = data.inscriptionLines.length
    ? `<ul style="margin:4px 0 0;padding-left:18px">${data.inscriptionLines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`
    : '—'

  const addons = data.addons.length
    ? `<ul style="margin:4px 0 0;padding-left:18px">${data.addons
        .map(
          (a) =>
            `<li>${a.type ? `${esc(ADDON_TYPE_LABELS[a.type] ?? a.type)}: ` : ''}${esc(a.label || a.code)} × ${esc(a.qty)} <span style="color:#888">(${esc(a.code)})</span></li>`,
        )
        .join('')}</ul>`
    : '—'

  const images = data.referenceImageUrls.length
    ? data.referenceImageUrls
        .map(
          (u) =>
            `<a href="${esc(u)}" target="_blank"><img src="${esc(u)}" alt="reference" style="max-width:220px;max-height:220px;margin:6px 6px 0 0;border:1px solid #ddd;border-radius:6px"/></a>`,
        )
        .join('')
    : '<p style="color:#888">No reference images provided.</p>'

  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;line-height:1.5">
    <h2 style="margin:0 0 4px">New tombstone mockup request</h2>
    <p style="margin:0 0 16px;color:#555">Please prepare a mockup image for the inquiry below.</p>
    <table style="border-collapse:collapse">
      ${row('Customer', data.customerName)}
      ${row('Deceased', data.deceasedName)}
      ${row('Dates', [data.deceasedBorn, data.deceasedDied].filter(Boolean).join(' – '))}
      ${row('Stone (Steinn)', `${data.productDescription ?? ''} (${data.productItemCode})`)}
      ${row('Stone colour (Glitir)', data.options?.stoneColor)}
      ${row('Font (Letur)', data.options?.letur)}
      ${row('Lettering colour (Litur)', data.options?.litur)}
      ${row('Cemetery (Kirkjugarður)', data.options?.cemetery)}
    </table>
    <h3 style="margin:18px 0 2px">Inscription</h3>${inscriptions}
    <h3 style="margin:18px 0 2px">Add-ons</h3>${addons}
    <h3 style="margin:18px 0 6px">Reference images</h3>
    <div>${images}</div>
    <p style="margin:20px 0 0;color:#555">Reply to this email with the mockup image. — Inquiry #${esc(data.id)}</p>
  </div>`

  return { subject, html }
}

/** Salesperson quote: summary of the inquiry; the Excel quote is attached. */
export function buildSalesQuote(data: InquiryEmailData): { subject: string; html: string } {
  const subject = `Quote — ${data.customerName ?? 'New inquiry'} (${data.productItemCode})`
  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;line-height:1.5">
    <h2 style="margin:0 0 4px">New quote ready</h2>
    <p style="margin:0 0 16px;color:#555">The Excel quote is attached. Open it in Excel to see the calculated totals.</p>
    <table style="border-collapse:collapse">
      ${row('Customer', data.customerName)}
      ${row('Email', data.customerEmail)}
      ${row('Phone', data.customerPhone)}
      ${row('Product', `${data.productDescription ?? ''} (${data.productItemCode})`)}
      ${row('Add-ons', data.addons.map((a) => `${a.label || a.code}×${a.qty}`).join(', '))}
    </table>
    <p style="margin:20px 0 0;color:#555">The designer's mockup will follow when ready. — Inquiry #${esc(data.id)}</p>
  </div>`
  return { subject, html }
}
