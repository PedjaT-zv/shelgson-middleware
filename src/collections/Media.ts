import type { CollectionConfig } from 'payload'

/**
 * Media stores two kinds of files:
 *  - reference images downloaded from the WordPress submission
 *  - generated Excel quotes (.xlsx)
 *
 * `read` is public so the reference-image URLs embedded in the designer
 * brief email render without authentication. Generated quotes are also
 * reachable by URL — acceptable for this internal workflow, but note it if
 * quote files ever need to be private (then attach instead of link, and
 * lock `read` down).
 */
export const Media: CollectionConfig = {
  slug: 'media',
  access: {
    read: () => true,
  },
  upload: {
    staticDir: 'media',
    mimeTypes: [
      'image/*',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ],
    imageSizes: [
      {
        name: 'thumbnail',
        width: 400,
        position: 'centre',
      },
    ],
  },
  fields: [
    {
      name: 'alt',
      type: 'text',
    },
    {
      name: 'kind',
      type: 'select',
      options: [
        { label: 'Reference image', value: 'reference' },
        { label: 'Generated quote', value: 'quote' },
        { label: 'Designer mockup', value: 'mockup' },
      ],
      admin: { description: 'What this file is, for filtering in the admin.' },
    },
  ],
}
