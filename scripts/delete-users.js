/**
 * Dev utility: delete every Supabase auth user whose email contains a substring
 * (default "ethan"), along with their subscription row and saved workspace blob.
 *
 * Uses the service key (admin API) from .env. DESTRUCTIVE — dev use only.
 *
 * Run: node scripts/delete-users.js [substring]
 */
import dotenv from 'dotenv'
import { createClient } from '@supabase/supabase-js'

dotenv.config()

const MATCH = (process.argv[2] || 'ethan').toLowerCase()
const STATE_BUCKET = process.env.SUPABASE_STATE_BUCKET || 'odin-state'

async function main() {
  const url = process.env.SUPABASE_URL
  const secret = process.env.SUPABASE_SECRET_KEY
  if (!url || !secret) throw new Error('SUPABASE_URL and SUPABASE_SECRET_KEY must be set in .env')

  const supabase = createClient(url, secret, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  // Collect all users (paginated).
  const matches = []
  for (let page = 1; page < 100; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 })
    if (error) throw new Error(`listUsers failed: ${error.message}`)
    const users = data?.users || []
    for (const u of users) {
      if ((u.email || '').toLowerCase().includes(MATCH)) matches.push(u)
    }
    if (users.length < 1000) break
  }

  if (!matches.length) {
    console.log(`No users found with "${MATCH}" in their email.`)
    return
  }

  console.log(`Deleting ${matches.length} user(s) matching "${MATCH}":`)
  for (const u of matches) {
    console.log(`  • ${u.email} (${u.id})`)

    // 1. Remove their saved workspace blob (ignore if missing).
    await supabase.storage
      .from(STATE_BUCKET)
      .remove([`workspace/${u.id}.json`])
      .catch(() => {})

    // 2. Remove their subscription row (ignore if table/row missing).
    await supabase.from('subscriptions').delete().eq('user_id', u.id)

    // 3. Delete the auth user.
    const { error } = await supabase.auth.admin.deleteUser(u.id)
    if (error) console.warn(`    ! failed to delete auth user: ${error.message}`)
  }

  console.log('\n✓ Done. Sign out in the browser (or clear site data) before re-testing.')
}

main().catch((err) => {
  console.error('\n✗ Failed:', err.message)
  process.exit(1)
})
