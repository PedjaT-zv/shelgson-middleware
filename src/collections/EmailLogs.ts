import type { CollectionConfig } from 'payload'

/**
 * Audit log of every email the processInquiry job sends — one document per
 * message, with the client name, the inquiry it belongs to, and (for the
 * sales quote) the generated .xlsx attachment.
 *
 * Documents are created server-side only (overrideAccess in the job). Admins
 * can read them in the panel but not create/edit/delete, so the log stays a
 * trustworthy record of what was actually sent.
 */
export const EmailLogs: CollectionConfig = {
  slug: 'email-logs',
  labels: { singular: 'Sent email', plural: 'Sent emails' },
  admin: {
    useAsTitle: 'title',
    defaultColumns: ['title', 'emailType', 'clientName', 'to', 'status', 'sentAt'],
    group: 'Inquiries',
    description: 'Every email the middleware sent (or failed to send), with the attached quote.',
  },
  access: {
    read: ({ req: { user } }) => Boolean(user),
    create: () => false,
    update: () => false,
    delete: () => false,
  },
  fields: [
    {
      name: 'title',
      type: 'text',
      admin: { description: 'Auto-filled: email type + client name + inquiry id.' },
    },
    {
      name: 'emailType',
      type: 'select',
      required: true,
      options: [
        { label: 'Designer brief', value: 'designer-brief' },
        { label: 'Sales quote (.xlsx attached)', value: 'sales-quote' },
      ],
      admin: { position: 'sidebar' },
    },
    {
      name: 'status',
      type: 'select',
      required: true,
      options: [
        { label: 'Sent', value: 'sent' },
        { label: 'Failed', value: 'failed' },
      ],
      admin: { position: 'sidebar' },
    },
    {
      name: 'sentAt',
      type: 'date',
      admin: { position: 'sidebar', date: { pickerAppearance: 'dayAndTime' } },
    },
    {
      name: 'clientName',
      type: 'text',
      admin: { description: 'Client name and surname as submitted on the WordPress form.' },
    },
    { name: 'to', type: 'text', admin: { description: 'Recipient address.' } },
    { name: 'subject', type: 'text' },
    {
      name: 'inquiry',
      type: 'relationship',
      relationTo: 'inquiries',
      admin: { description: 'The inquiry this email was sent for.' },
    },
    {
      name: 'attachment',
      type: 'upload',
      relationTo: 'media',
      admin: { description: 'The generated .xlsx quote attached to this email (sales quote only).' },
    },
    {
      name: 'html',
      type: 'code',
      admin: { language: 'html', description: 'The HTML body as sent.' },
    },
    {
      name: 'error',
      type: 'textarea',
      admin: {
        description: 'Send error, if the email failed.',
        condition: (data) => data?.status === 'failed',
      },
    },
  ],
}
