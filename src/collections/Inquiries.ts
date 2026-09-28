import type { CollectionConfig, PayloadRequest } from 'payload'

import { acceptInquiry } from '../lib/acceptInquiry'

/** Statuses from which an admin may (re-)accept an inquiry. */
export const ACCEPTABLE_STATUSES = ['quoted', 'emailed', 'failed'] as const

/**
 * The store for WordPress tombstone-inquiry submissions — the "CPT" equivalent.
 * Created by the /api/inquiries/intake endpoint (or manually in admin). On
 * create, the afterChange hook queues the `processInquiry` job which downloads
 * reference images, resolves the product, generates the Excel quote, and sends
 * the two emails.
 */
export const Inquiries: CollectionConfig = {
  slug: 'inquiries',
  admin: {
    useAsTitle: 'title',
    defaultColumns: ['title', 'status', 'acceptAction', 'createdAt'],
    group: 'Inquiries',
  },
  endpoints: [
    {
      // POST /api/inquiries/:id/accept — admin action: pull live DK prices for
      // the inquiry's items, regenerate the Excel quote, mark it accepted.
      path: '/:id/accept',
      method: 'post',
      handler: async (req: PayloadRequest) => {
        if (!req.user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
        const id = req.routeParams?.id as string | undefined
        if (!id) return Response.json({ error: 'Missing inquiry id' }, { status: 400 })

        const inquiry = await req.payload
          .findByID({ collection: 'inquiries', id, depth: 0, overrideAccess: true })
          .catch(() => null)
        if (!inquiry) return Response.json({ error: 'Inquiry not found' }, { status: 404 })

        if (!ACCEPTABLE_STATUSES.includes(inquiry.status as (typeof ACCEPTABLE_STATUSES)[number])) {
          const reason =
            inquiry.status === 'accepted'
              ? 'Inquiry is already accepted.'
              : inquiry.status === 'accepting'
                ? 'Acceptance is already in progress.'
                : `Inquiry cannot be accepted while status is "${inquiry.status}" — wait until the quote has been generated.`
          return Response.json({ error: reason }, { status: 409 })
        }

        try {
          const result = await acceptInquiry(req.payload, inquiry.id, req.user.id)
          return Response.json({ ok: true, ...result }, { status: 200 })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          return Response.json({ error: `Accept failed: ${message}` }, { status: 502 })
        }
      },
    },
  ],
  hooks: {
    afterChange: [
      async ({ doc, operation, req }) => {
        // Only kick off processing once, when the inquiry is first created.
        if (operation === 'create') {
          await req.payload.jobs.queue({
            task: 'processInquiry',
            input: { inquiryId: doc.id },
            queue: 'inquiries',
          })
        }
        return doc
      },
    ],
  },
  fields: [
    {
      name: 'title',
      type: 'text',
      admin: {
        description: 'Auto-filled from the customer name + product for readability.',
        readOnly: true,
      },
      hooks: {
        beforeChange: [
          ({ data }) => {
            const name =
              [data?.customer?.firstName, data?.customer?.lastName].filter(Boolean).join(' ') ||
              'Unknown'
            const code = data?.wantedProduct?.itemCode ?? '—'
            return `${name} · ${code}`
          },
        ],
      },
    },
    {
      name: 'status',
      type: 'select',
      defaultValue: 'received',
      options: [
        { label: 'Received', value: 'received' },
        { label: 'Processing', value: 'processing' },
        { label: 'Quoted', value: 'quoted' },
        { label: 'Emailed', value: 'emailed' },
        { label: 'Accepting…', value: 'accepting' },
        { label: 'Accepted', value: 'accepted' },
        { label: 'Failed', value: 'failed' },
      ],
      admin: { position: 'sidebar' },
    },
    {
      name: 'acceptAction',
      type: 'ui',
      label: 'Accept',
      admin: {
        position: 'sidebar',
        components: {
          Field: '/components/AcceptInquiryButton#AcceptInquiryField',
          Cell: '/components/AcceptInquiryButton#AcceptInquiryCell',
        },
      },
    },
    {
      name: 'acceptedAt',
      type: 'date',
      admin: {
        position: 'sidebar',
        readOnly: true,
        date: { pickerAppearance: 'dayAndTime' },
        description: 'When the inquiry was accepted.',
      },
    },
    {
      name: 'acceptedBy',
      type: 'relationship',
      relationTo: 'users',
      admin: { position: 'sidebar', readOnly: true, description: 'Admin who accepted the inquiry.' },
    },
    {
      name: 'customer',
      type: 'group',
      fields: [
        { name: 'firstName', type: 'text' },
        { name: 'lastName', type: 'text' },
        { name: 'kennitala', type: 'text', admin: { description: 'Icelandic national ID (Kt.).' } },
        { name: 'address', type: 'text', admin: { description: 'Heimili.' } },
        { name: 'phone', type: 'text' },
        { name: 'email', type: 'email' },
      ],
    },
    {
      name: 'deceased',
      type: 'group',
      fields: [
        { name: 'firstName', type: 'text' },
        { name: 'lastName', type: 'text' },
        { name: 'bornDate', type: 'text', admin: { description: 'As submitted (free text / date).' } },
        { name: 'diedDate', type: 'text', admin: { description: 'As submitted (free text / date).' } },
      ],
    },
    {
      name: 'options',
      type: 'group',
      admin: { description: 'Selections from the order template (Icelandic values).' },
      fields: [
        { name: 'letur', type: 'text', admin: { description: 'Font (Letur list).' } },
        { name: 'litur', type: 'text', admin: { description: 'Lettering colour (Litur list).' } },
        { name: 'stoneColor', type: 'text', admin: { description: 'Stone colour code (Glitir list: SB, BG, …).' } },
        { name: 'cemetery', type: 'text', admin: { description: 'Kirkjugarður.' } },
        { name: 'delivery', type: 'text', admin: { description: 'Afhending.' } },
        { name: 'perCharPrice', type: 'number', admin: { description: 'Áletrun price per character (260/1070/1250/1490).' } },
        { name: 'solumadur', type: 'text', admin: { description: 'Sölumaður.' } },
        { name: 'comments', type: 'textarea', admin: { description: 'Athugasemdir.' } },
        { name: 'blomarammiVerd', type: 'number', admin: { description: 'Blómarammi price, if chosen.' } },
        { name: 'uppsetningVerd', type: 'number', admin: { description: 'Uppsetning (installation) price, if chosen.' } },
        { name: 'afslattur', type: 'number', admin: { description: 'Discount amount (entered as negative in the sheet).' } },
      ],
    },
    {
      name: 'wantedProduct',
      type: 'group',
      fields: [
        {
          name: 'itemCode',
          type: 'text',
          required: true,
          admin: { description: 'DK ItemCode the customer chose (from WordPress).' },
        },
        { name: 'catalogItem', type: 'relationship', relationTo: 'catalog-items' },
        { name: 'resolvedDescription', type: 'text', admin: { readOnly: true } },
        { name: 'resolvedUnitPrice', type: 'number', admin: { readOnly: true } },
      ],
    },
    {
      name: 'inscriptionLines',
      type: 'array',
      labels: { singular: 'Inscription line', plural: 'Inscription lines' },
      fields: [{ name: 'line', type: 'text' }],
    },
    {
      name: 'addons',
      type: 'array',
      labels: { singular: 'Add-on', plural: 'Add-ons' },
      admin: { description: 'Add-on codes selected by the customer; type decides the template section.' },
      fields: [
        {
          name: 'type',
          type: 'select',
          defaultValue: 'annad',
          options: [
            { label: 'Kross', value: 'kross' },
            { label: 'Lukt / vasi', value: 'luktVasi' },
            { label: 'Fugl', value: 'fugl' },
            { label: 'Mynd', value: 'mynd' },
            { label: 'Rammi', value: 'rammi' },
            { label: 'Annað', value: 'annad' },
          ],
        },
        { name: 'code', type: 'text', required: true },
        { name: 'label', type: 'text' },
        { name: 'qty', type: 'number', defaultValue: 1 },
      ],
    },
    {
      name: 'referenceImages',
      type: 'array',
      labels: { singular: 'Reference image', plural: 'Reference images' },
      fields: [{ name: 'image', type: 'upload', relationTo: 'media' }],
    },
    {
      name: 'generatedQuote',
      type: 'upload',
      relationTo: 'media',
      admin: { description: 'The generated .xlsx quote.' },
    },
    {
      name: 'designerMockup',
      type: 'upload',
      relationTo: 'media',
      admin: { description: 'Added when the designer returns a mockup.' },
    },
    {
      name: 'rawPayload',
      type: 'json',
      admin: { description: 'Original webhook body, kept for audit / replay.', readOnly: true },
    },
    {
      name: 'processingError',
      type: 'textarea',
      admin: { description: 'Last processing error, if any.', readOnly: true },
    },
  ],
}
