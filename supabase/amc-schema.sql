-- ═══════════════════════════════════════════════════════════════════════
-- AMC Math Coach — Supabase schema
--
-- Run this once in your Supabase project: Dashboard → SQL Editor → New
-- query → paste this whole file → Run.
--
-- The Express server talks to these tables with the SERVICE ROLE key
-- (SUPABASE_SECRET_KEY in .env), which bypasses row-level security. RLS is
-- still enabled with no policies so the public anon key can never touch
-- account data directly from a browser.
-- ═══════════════════════════════════════════════════════════════════════

-- ── Accounts (username + scrypt-hashed password) ──
create table if not exists public.amc_users (
  username_lower text primary key,
  username       text not null,
  salt           text not null,
  hash           text not null,
  created_at     timestamptz not null default now()
);

-- ── Sessions (opaque bearer tokens, pruned by the server after 90 days) ──
create table if not exists public.amc_sessions (
  token          text primary key,
  username_lower text not null references public.amc_users (username_lower) on delete cascade,
  created_at     timestamptz not null default now()
);

create index if not exists amc_sessions_user_idx
  on public.amc_sessions (username_lower);

-- ── Whiteboards (auto-saved: strokes + pasted images as one jsonb blob) ──
create table if not exists public.amc_boards (
  id             text primary key,
  username_lower text not null references public.amc_users (username_lower) on delete cascade,
  name           text not null,
  data           jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists amc_boards_user_idx
  on public.amc_boards (username_lower, created_at);

-- ── Lock the tables down: no anon/authenticated access, server-only ──
alter table public.amc_users    enable row level security;
alter table public.amc_sessions enable row level security;
alter table public.amc_boards   enable row level security;
