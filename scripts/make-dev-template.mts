import { mkdir, writeFile } from 'fs/promises'
import path from 'path'

import { buildDevTemplate } from '../src/lib/excel.js'

const out = path.join(process.cwd(), 'src', 'templates', 'master-quote-template.xlsx')
await mkdir(path.dirname(out), { recursive: true })
await writeFile(out, await buildDevTemplate())
console.log('Wrote dev template:', out)
