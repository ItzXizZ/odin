/**
 * One-off Supabase provisioning: creates the `subscriptions` table used by the
 * card-required free-trial paywall.
 *
 * DDL can't run through the REST/service key, so this uses the Supabase
 * Management API (the same endpoint the dashboard SQL editor uses).
 *
 * Reads from .env:
 *   SUPABASE_URL            → used to derive the project ref
 *   SUPABASE_ACCESS_TOKEN   → a Personal Access Token (create at
 *                             https://supabase.com/dashboard/account/tokens)
 *
 * Run: node scripts/supabase-setup.js
 */
import dotenv from 'dotenv'

dotenv.config()

const SQL = `
create table if not exists public.subscriptions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  paypal_subscription_id text unique,
  plan_id text,
  status text not null default 'none',
  current_period_end timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.subscriptions enable row level security;
`

function projectRef() {
  const url = process.env.SUPABASE_URL || ''
  const m = url.match(/^https?:\/\/([a-z0-9]+)\.supabase\.co/i)
  if (!m) throw new Error(`Could not derive project ref from SUPABASE_URL="${url}"`)
  return m[1]
}

async function main() {
  const token = (process.env.SUPABASE_ACCESS_TOKEN || '').trim()
  if (!token) {
    throw new Error(
      'SUPABASE_ACCESS_TOKEN is not set. Create one at ' +
        'https://supabase.com/dashboard/account/tokens and add it to .env'
    )
  }
  const ref = projectRef()
  console.log(`Project ref: ${ref}`)

  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: SQL }),
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`Management API error ${res.status}: ${text.slice(0, 500)}`)
  }
  console.log('✓ subscriptions table created (or already existed).')
}

main().catch((err) => {
  console.error('\n✗ Setup failed:', err.message)
  process.exit(1)
})
