import type { TaskConfig } from 'payload'

import { downloadReferenceImage } from '../lib/downloadImage'
import { buildDesignerBrief, buildSalesQuote, type InquiryEmailData } from '../lib/emails'
import { generateQuoteWorkbook, loadMasterTemplate, quoteFileName, type PriceRow } from '../lib/excel'
import { buildQuoteData } from '../lib/quoteData'

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

/**
 * The end-to-end pipeline for one inquiry, run off the queue:
 *   1. download reference images (SSRF-guarded) into `media`
 *   2. resolve the wanted product against the local DK catalog mirror
 *   3. generate the Excel quote from the master template (DK prices injected)
 *   4. email the designer brief (+ images) and the salesperson quote (+ .xlsx)
 *
 * Steps are idempotent enough to survive a retry: images already linked are not
 * re-downloaded. On failure the inquiry is marked `failed` with the error, then
 * the error is rethrown so the Jobs Queue records the failure / can retry.
 */
export const processInquiry: TaskConfig<'processInquiry'> = {
  slug: 'processInquiry',
  label: 'Process inquiry → quote + emails',
  inputSchema: [{ name: 'inquiryId', type: 'text', required: true }],
  retries: 2,
  handler: async ({ input, req }) => {
    const { payload } = req
    const inquiryId = (input as { inquiryId: string | number }).inquiryId

    const base = {
      collection: 'inquiries' as const,
      id: inquiryId,
      depth: 0,
      overrideAccess: true,
    }

    try {
      const inquiry = await payload.findByID({ ...base })
      await payload.update({ ...base, data: { status: 'processing' } })

      const raw = (inquiry.rawPayload ?? {}) as Record<string, unknown>

      // --- 1. Reference images ---
      const existingRefs = (inquiry.referenceImages ?? []) as { image?: number | { id?: number } }[]
      const referenceImageIds: number[] = existingRefs
        .map((r) => (typeof r.image === 'object' && r.image ? r.image.id : r.image))
        .filter((v): v is number => typeof v === 'number')

      if (referenceImageIds.length === 0) {
        const urls = Array.isArray(raw.referenceImageUrls) ? (raw.referenceImageUrls as string[]) : []
        for (const url of urls) {
          try {
            const f = await downloadReferenceImage(url)
            const media = await payload.create({
              collection: 'media',
              overrideAccess: true,
              data: { alt: `Reference for inquiry ${inquiryId}`, kind: 'reference' },
              file: { data: f.buffer, mimetype: f.mimeType, name: f.filename, size: f.buffer.length },
            })
            referenceImageIds.push(media.id)
          } catch (err) {
            payload.logger.error(`processInquiry: image download failed for ${url}: ${String(err)}`)
          }
        }
        if (referenceImageIds.length > 0) {
          await payload.update({
            ...base,
            data: { referenceImages: referenceImageIds.map((id) => ({ image: id })) },
          })
        }
      }

      // --- 2. Resolve the wanted product against the DK mirror ---
      const itemCode = (inquiry.wantedProduct as { itemCode?: string })?.itemCode ?? ''
      const match = await payload.find({
        collection: 'catalog-items',
        where: { itemCode: { equals: itemCode } },
        limit: 1,
        depth: 0,
        overrideAccess: true,
      })
      const product = match.docs[0]
      if (!product) {
        payload.logger.warn(`processInquiry: itemCode "${itemCode}" not found in catalog — quote will show #N/A for it`)
      }

      // --- 3. Build the price table from the active, priced catalog ---
      const priced = await payload.find({
        collection: 'catalog-items',
        where: { inactive: { not_equals: true } },
        pagination: false,
        depth: 0,
        overrideAccess: true,
      })
      const prices: PriceRow[] = priced.docs
        .filter((d) => typeof d.unitPrice1 === 'number')
        .map((d) => ({ itemCode: d.itemCode, unitPrice: d.unitPrice1 as number }))

      // --- 4. Generate the Excel quote ---
      const quoteData = buildQuoteData(inquiry)

      const template = await loadMasterTemplate()
      const xlsx = await generateQuoteWorkbook(template, quoteData, prices)
      const fileName = quoteFileName(quoteData.customerName, inquiryId)

      const quoteMedia = await payload.create({
        collection: 'media',
        overrideAccess: true,
        data: { alt: fileName, kind: 'quote' },
        file: { data: xlsx, mimetype: XLSX_MIME, name: fileName, size: xlsx.length },
      })

      await payload.update({
        ...base,
        data: {
          generatedQuote: quoteMedia.id,
          wantedProduct: {
            itemCode,
            catalogItem: product?.id,
            resolvedDescription: product?.description ?? undefined,
            resolvedUnitPrice: product?.unitPrice1 ?? undefined,
          },
          status: 'quoted',
        },
      })

      // --- 5. Emails ---
      const serverURL = (payload.config.serverURL || process.env.SERVER_URL || '').replace(/\/$/, '')
      const populated = await payload.findByID({ ...base, depth: 2 })
      const refImageUrls = ((populated.referenceImages ?? []) as { image?: { url?: string } }[])
        .map((r) => r.image?.url)
        .filter((u): u is string => Boolean(u))
        .map((u) => (u.startsWith('http') ? u : `${serverURL}${u}`))

      const emailData: InquiryEmailData = {
        id: inquiryId,
        customerName: quoteData.customerName,
        customerEmail: quoteData.email,
        customerPhone: quoteData.phone,
        deceasedName: quoteData.deceasedName,
        deceasedBorn: quoteData.deceasedBorn,
        deceasedDied: quoteData.deceasedDied,
        productItemCode: itemCode,
        productDescription: product?.description ?? undefined,
        inscriptionLines: quoteData.inscriptionLines,
        addons: (inquiry.addons ?? []).map((a) => ({
          type: a.type ?? undefined,
          code: a.code ?? '',
          label: a.label ?? undefined,
          qty: a.qty ?? 1,
        })),
        options: {
          letur: quoteData.letur,
          litur: quoteData.litur,
          stoneColor: quoteData.stoneColor,
          cemetery: quoteData.cemetery,
        },
        referenceImageUrls: refImageUrls,
      }

      const designerTo = process.env.DESIGNER_EMAIL
      const salesTo = process.env.SALES_EMAIL

      // Record every send in the `email-logs` collection so admins can audit
      // what went out (client, recipient, body, attached quote) in the panel.
      const logEmail = async (entry: {
        emailType: 'designer-brief' | 'sales-quote'
        to: string
        subject: string
        html: string
        status: 'sent' | 'failed'
        attachment?: number
        error?: string
      }) => {
        const typeLabel = entry.emailType === 'sales-quote' ? 'Sales quote' : 'Designer brief'
        await payload
          .create({
            collection: 'email-logs',
            overrideAccess: true,
            data: {
              title: `${typeLabel} — ${quoteData.customerName ?? 'Unknown'} · #${inquiry.id}`,
              clientName: quoteData.customerName,
              inquiry: inquiry.id,
              sentAt: new Date().toISOString(),
              ...entry,
            },
          })
          .catch((logErr) =>
            payload.logger.error(`processInquiry: failed to write email log: ${String(logErr)}`),
          )
      }

      const sendLogged = async (
        entry: {
          emailType: 'designer-brief' | 'sales-quote'
          to: string
          subject: string
          html: string
          attachment?: number
        },
        attachments?: { filename: string; content: Buffer; contentType: string }[],
      ) => {
        try {
          await payload.sendEmail({ to: entry.to, subject: entry.subject, html: entry.html, attachments })
          await logEmail({ ...entry, status: 'sent' })
        } catch (err) {
          await logEmail({
            ...entry,
            status: 'failed',
            error: err instanceof Error ? err.message : String(err),
          })
          throw err
        }
      }

      if (designerTo) {
        const brief = buildDesignerBrief(emailData)
        await sendLogged({
          emailType: 'designer-brief',
          to: designerTo,
          subject: brief.subject,
          html: brief.html,
        })
      } else {
        payload.logger.warn('processInquiry: DESIGNER_EMAIL not set — skipping designer brief')
      }

      if (salesTo) {
        const quote = buildSalesQuote(emailData)
        await sendLogged(
          {
            emailType: 'sales-quote',
            to: salesTo,
            subject: quote.subject,
            html: quote.html,
            attachment: quoteMedia.id,
          },
          [{ filename: fileName, content: xlsx, contentType: XLSX_MIME }],
        )
      } else {
        payload.logger.warn('processInquiry: SALES_EMAIL not set — skipping sales quote')
      }

      await payload.update({ ...base, data: { status: 'emailed', processingError: null } })
      return { output: { quoteMediaId: quoteMedia.id, referenceImages: referenceImageIds.length } }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      payload.logger.error(`processInquiry ${inquiryId} failed: ${message}`)
      await payload
        .update({ ...base, data: { status: 'failed', processingError: message } })
        .catch(() => undefined)
      throw err
    }
  },
}
