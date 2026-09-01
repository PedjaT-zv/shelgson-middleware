import 'dotenv/config'

import { getPayload } from 'payload'

import config from '../src/payload.config'

const queue = process.argv[2] || 'inquiries'
const payload = await getPayload({ config })

const res = await payload.jobs.run({ queue })
console.log(`ran queue "${queue}":`, JSON.stringify(res?.jobStatus ?? res ?? {}))

const all = await payload.find({ collection: 'inquiries', limit: 20, sort: '-createdAt', depth: 0 })
for (const i of all.docs) {
  console.log(`  inquiry #${i.id}: status=${i.status} quote=${i.generatedQuote ? 'yes' : 'no'}${i.processingError ? ` err=${i.processingError}` : ''}`)
}
process.exit(0)
