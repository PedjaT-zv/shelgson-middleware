import { postgresAdapter } from '@payloadcms/db-postgres'
import { nodemailerAdapter } from '@payloadcms/email-nodemailer'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import path from 'path'
import { buildConfig } from 'payload'
import { fileURLToPath } from 'url'
import sharp from 'sharp'

import { CatalogItems } from './collections/CatalogItems'
import { EmailLogs } from './collections/EmailLogs'
import { Inquiries } from './collections/Inquiries'
import { Media } from './collections/Media'
import { Users } from './collections/Users'
import { intakeEndpoint } from './endpoints/intake'
import { processInquiry } from './jobs/processInquiry'
import { syncCatalog } from './jobs/syncCatalog'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)

// Real SMTP when configured; otherwise Nodemailer's jsonTransport so dev boots
// and the pipeline runs offline (emails are captured, not sent).
const email = process.env.SMTP_HOST
  ? nodemailerAdapter({
      defaultFromAddress: process.env.MAIL_FROM || 'no-reply@example.com',
      defaultFromName: 'Tombstone Middleware',
      transportOptions: {
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 587),
        secure: process.env.SMTP_SECURE === 'true',
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      },
    })
  : nodemailerAdapter({
      defaultFromAddress: process.env.MAIL_FROM || 'no-reply@example.com',
      defaultFromName: 'Tombstone Middleware',
      // No SMTP configured (dev): don't actually send — capture as JSON so the
      // pipeline runs offline. Payload logs the message; set SMTP_* to send.
      transportOptions: { jsonTransport: true } as Record<string, unknown>,
    })

export default buildConfig({
  serverURL: process.env.SERVER_URL || 'http://localhost:3000',
  admin: {
    user: Users.slug,
    importMap: {
      baseDir: path.resolve(dirname),
    },
  },
  collections: [Users, Media, CatalogItems, Inquiries, EmailLogs],
  editor: lexicalEditor(),
  secret: process.env.PAYLOAD_SECRET || '',
  typescript: {
    outputFile: path.resolve(dirname, 'payload-types.ts'),
  },
  db: postgresAdapter({
    pool: {
      connectionString: process.env.DATABASE_URL || '',
    },
  }),
  email,
  endpoints: [intakeEndpoint],
  jobs: {
    tasks: [syncCatalog, processInquiry],
    // Dedicated-server runner: schedules due tasks AND runs queued jobs.
    // Disable on serverless (set DISABLE_AUTORUN=true) and drive
    // /api/payload-jobs/run from an external cron instead.
    shouldAutoRun: async () => process.env.DISABLE_AUTORUN !== 'true',
    autoRun: [
      { cron: '* * * * *', queue: 'inquiries', limit: 10 },
      { cron: '* * * * *', queue: 'nightly', limit: 5 },
    ],
  },
  sharp,
  plugins: [],
})
