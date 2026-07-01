import type { User } from '@supabase/supabase-js'

const NOTIFY_EMAIL = 'ethan8eight@gmail.com'
const NOTIFY_KEY = 'odin-signup-notify-fired'

/** Accounts created within this window are treated as new sign-ups. */
const NEW_USER_WINDOW_MS = 15 * 60 * 1000

function isRecentSignup(user: User) {
  const created = Date.parse(user.created_at)
  return Number.isFinite(created) && Date.now() - created <= NEW_USER_WINDOW_MS
}

function displayName(user: User) {
  const meta = user.user_metadata || {}
  return meta.full_name || meta.name || user.email || user.id
}

/** Email the admin via FormSubmit when a sign-up finishes. No API key needed. */
export async function notifySignupComplete(user: User | null): Promise<void> {
  if (!user || !isRecentSignup(user)) return

  const dedupKey = `${NOTIFY_KEY}:${user.id}`
  if (sessionStorage.getItem(dedupKey)) return
  sessionStorage.setItem(dedupKey, '1')

  const name = displayName(user)
  const email = user.email || '(no email)'
  const created = user.created_at ? new Date(user.created_at).toISOString() : 'unknown'

  try {
    const res = await fetch(`https://formsubmit.co/ajax/${encodeURIComponent(NOTIFY_EMAIL)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        _subject: `New Odin signup: ${name}`,
        _captcha: 'false',
        _template: 'table',
        _url: `${window.location.origin}/signup-complete`,
        name,
        email,
        user_id: user.id,
        signed_up: created,
        message: 'A new user signed up for Odin.',
      }),
    })
    const data = (await res.json().catch(() => ({}))) as { success?: string | boolean; message?: string }
    if (data.success === 'false' || data.success === false) {
      console.warn('[signup-notify]', data.message || 'FormSubmit rejected the request')
    }
  } catch {
    // Non-blocking — conversion tracking and the app should keep working.
  }
}
