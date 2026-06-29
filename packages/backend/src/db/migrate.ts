import 'dotenv/config'
import { readFileSync } from 'fs'
import { join } from 'path'
import { Client } from 'pg'

async function migrate() {
  const client = new Client({ connectionString: process.env.DATABASE_URL! })
  await client.connect()

  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf-8')
  await client.query(schema)

  console.log('Migration complete')
  await client.end()
}

migrate().catch((err) => {
  console.error('Migration failed:', err)
  process.exit(1)
})
