/**
 * Wipe competition / affiliate link data (storage blob + optional DB rows).
 * Run: node scripts/reset-competition.js
 */
import dotenv from 'dotenv'
import { createClient } from '@supabase/supabase-js'
import ws from 'ws'

dotenv.config()

const AFFILIATE_STORAGE_USER = '__affiliate__'
const statePath = (userId) => `workspace/${userId || 'default'}.json`

async function main() {
  const url = process.env.SUPABASE_URL
  const secret = process.env.SUPABASE_SECRET_KEY
  const stateBucket = process.env.SUPABASE_STATE_BUCKET || 'odin-state'

  if (!url || !secret) {
    throw new Error('SUPABASE_URL and SUPABASE_SECRET_KEY required')
  }

  const supabase = createClient(url, secret, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { transport: ws },
  })

  const { error: storageError } = await supabase.storage
    .from(stateBucket)
    .upload(statePath(AFFILIATE_STORAGE_USER), Buffer.from(JSON.stringify({ links: {}, signups: {} }), 'utf-8'), {
      contentType: 'application/json',
      upsert: true,
    })
  if (storageError) {
    console.warn('Storage reset:', storageError.message)
  } else {
    console.log('✓ Cleared competition storage blob.')
  }

  for (const table of ['affiliate_signups', 'affiliate_links']) {
    const { error } = await supabase.from(table).delete().neq('code', '__impossible__')
    if (error) {
      if (/does not exist|schema cache/i.test(error.message)) {
        console.log(`○ Table ${table} not present (skipped).`)
      } else {
        console.warn(`Could not clear ${table}:`, error.message)
      }
    } else {
      console.log(`✓ Cleared table ${table}.`)
    }
  }

  console.log('Competition data reset complete.')
}

main().catch((err) => {
  console.error('Reset failed:', err.message)
  process.exit(1)
})
