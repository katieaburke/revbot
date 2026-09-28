import { Router } from 'express'
import { getSfdcAuthUrl, handleSfdcCallback, generatePkce, invalidateSfdcCache } from '../services/salesforce'
import { invalidateSfdcBaseCache } from '../slack/messages'
import { db } from '../db'
import { config } from '../config'
import { requireAdmin } from '../middleware/adminAuth'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcrypt'

const router = Router()

// ── SFDC OAuth ──────────────────────────────────────────────────────────────

// Called from Slack connect message — state JWT contains slackUserId
router.get('/sfdc/start', async (req, res) => {
  try {
    const { state } = req.query as { state: string }
    const authUrl = getSfdcAuthUrl(state)
    res.redirect(authUrl)
  } catch (err) {
    res.status(400).json({ error: 'Invalid state' })
  }
})

// Renders a failure the person staring at it can actually act on. The old handler
// sent a bare "Authentication failed" for every cause — expired state, a user
// Salesforce refused, a missing DB record — which is indistinguishable from the app
// being broken and leaves the only real clue (Salesforce's own error) unread in the
// query string.
function renderAuthFailure(
  res: import('express').Response,
  opts: { title: string; detail?: string | null; hint?: string; status?: number },
) {
  const esc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!)
  res.status(opts.status ?? 400).send(`
    <html><body style="font-family:system-ui,sans-serif;max-width:640px;margin:48px auto;line-height:1.5">
      <h2>❌ Salesforce connection failed</h2>
      <p><strong>${esc(opts.title)}</strong></p>
      ${opts.detail ? `<pre style="background:#f4f4f5;padding:12px;border-radius:8px;white-space:pre-wrap">${esc(opts.detail)}</pre>` : ''}
      ${opts.hint ? `<p>${esc(opts.hint)}</p>` : ''}
      <p style="color:#666;font-size:13px">Send this whole message to RevOps if it isn't clear what to do.</p>
    </body></html>
  `)
}

router.get('/sfdc/callback', async (req, res) => {
  try {
    const { code, state, error, error_description } = req.query as {
      code?: string
      state?: string
      error?: string
      error_description?: string
    }

    // Salesforce refused before we ever got a code. It always says why; the previous
    // version of this handler dropped that on the floor and reported a generic
    // failure, so an org-config problem looked identical to an app bug.
    if (error) {
      console.error('[SFDC OAuth] Salesforce returned an error:', error, error_description ?? '')
      const hint =
        error === 'OAUTH_APP_BLOCKED'
          ? 'Salesforce blocked this user for the Beacon app. In Setup → External Client App Manager → (the Beacon app) → Edit → Policies tab → OAuth Policies, either set "Permitted Users" to "All users may self-authorize", or — if it is set to "Admin approved users are pre-authorized" — add this person via "Selected Permission Sets" (preferred) or "Selected Profiles". Their user also needs the "API Enabled" permission.'
          : 'This came from Salesforce, not from Beacon — it usually means the External Client App\'s policies or the user\'s permissions need changing in Salesforce Setup.'
      return renderAuthFailure(res, {
        title: 'Salesforce rejected the login.',
        detail: `error=${error}${error_description ? `\nerror_description=${error_description}` : ''}`,
        hint,
      })
    }

    if (!code || !state) {
      return renderAuthFailure(res, {
        title: 'The callback came back without an authorization code.',
        hint: 'Start the connection again from Settings. If you opened this link directly or it sat unused for more than 10 minutes, that would do it.',
      })
    }

    const payload = jwt.verify(state, config.JWT_SECRET) as { type?: string; slackUserId?: string; adminEmail?: string; codeVerifier?: string }

    // Admin flow — no Slack required
    if (payload.type === 'admin' && payload.adminEmail) {
      const existing = await db.user.findFirst({ where: { slackEmail: payload.adminEmail } })
      let userId: string
      if (existing) {
        userId = existing.id
        await db.user.update({ where: { id: existing.id }, data: { isRevOps: true } })
      } else {
        const created = await db.user.create({
          data: {
            slackUserId: `admin-${Date.now()}`,
            slackEmail: payload.adminEmail,
            slackName: 'Admin',
            isRevOps: true,
          },
        })
        userId = created.id
      }
      await handleSfdcCallback(code, userId, payload.codeVerifier)
      invalidateSfdcCache()
      invalidateSfdcBaseCache()
      return res.send(`
        <html><body>
          <h2>✅ Salesforce connected!</h2>
          <p>You can close this tab and return to the admin UI.</p>
          <script>
            if (window.opener) { window.opener.postMessage('sfdc-connected', '*'); window.close(); }
            else { setTimeout(() => window.location.href = '/', 2000); }
          </script>
        </body></html>
      `)
    }

    // Slack user flow
    const user = await db.user.findUnique({ where: { slackUserId: payload.slackUserId! } })
    if (!user)
      return renderAuthFailure(res, {
        title: 'Salesforce authorised you, but there is no Beacon account for your Slack user.',
        detail: `slackUserId=${payload.slackUserId}`,
        hint: 'RevOps needs to add you to Beacon before you can connect Salesforce.',
      })

    await handleSfdcCallback(code, user.id)

    // Send a Slack confirmation DM
    const { slackApp } = await import('../slack/bot')
    await slackApp.client.chat.postMessage({
      channel: payload.slackUserId!,
      text: '✅ Salesforce connected! You can now update deals directly from Slack.',
    })

    res.send('<html><body><h2>✅ Salesforce connected!</h2><p>You can close this window and return to Slack.</p></body></html>')
  } catch (err) {
    console.error('SFDC callback error:', err)

    // The state JWT is the most common thing to fail here, and it fails for a boring
    // reason: the person left the tab open too long. Say so instead of implying the
    // app is broken.
    if (err instanceof jwt.TokenExpiredError) {
      return renderAuthFailure(res, {
        title: 'The connection link expired before you finished logging in.',
        hint: 'These links are only good for 10 minutes. Go back to Settings and start the connection again.',
      })
    }
    if (err instanceof jwt.JsonWebTokenError) {
      return renderAuthFailure(res, {
        title: 'The connection link was not valid.',
        detail: err.message,
        hint: 'Start the connection again from Settings rather than reusing an old link.',
      })
    }

    renderAuthFailure(res, {
      title: 'Beacon hit an unexpected error while finishing the Salesforce connection.',
      detail: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      hint: 'This one is on Beacon, not on your Salesforce permissions. Retrying is worth a shot; if it keeps happening the detail above is what RevOps needs.',
      status: 500,
    })
  }
})

// ── Admin SFDC Connect (no Slack required) ───────────────────────────────────

/**
 * Mints the Salesforce authorization URL for the admin who is actually signed in.
 *
 * Authenticated POST rather than the GET a popup can open directly, and that is the
 * whole point. The old GET had no way to know who had clicked — a popup carries no
 * Authorization header — so it stamped config.ADMIN_EMAIL into the state JWT no matter
 * who it was. The callback then resolved that email to the primary RevOps user row and
 * wrote the newcomer's Salesforce tokens over it. A second admin connecting did not
 * get their own connection; they silently took over the service account, and every
 * scan and scheduled job afterwards ran under their Salesforce permissions. Nothing
 * errored, and the only outward sign was query results quietly changing shape.
 *
 * The caller opens the returned URL itself. The state JWT in that URL is a short-lived
 * single-purpose OAuth state, not a credential — unlike the admin bearer token, which
 * must never be put in a query string where it would land in browser history, proxy
 * logs and Referer headers.
 */
router.post('/sfdc/admin-start-url', requireAdmin, async (req, res) => {
  try {
    // requireAdmin has already verified the signature; re-decoding here is just how we
    // read the claims, since the middleware does not attach them to the request.
    const token = req.headers.authorization!.slice(7)
    const claims = jwt.verify(token, config.JWT_SECRET) as { email?: string }
    const adminEmail = claims.email
    if (!adminEmail) {
      return res.status(400).json({ error: 'Admin token carries no email claim — sign out and back in.' })
    }

    const { verifier, challenge } = generatePkce()
    const state = jwt.sign({ type: 'admin', adminEmail, codeVerifier: verifier }, config.JWT_SECRET, {
      expiresIn: '10m',
    })
    res.json({ url: getSfdcAuthUrl(state, challenge) })
  } catch (err) {
    console.error('[SFDC] Could not build admin auth URL:', err)
    res.status(500).json({ error: 'Could not generate auth URL' })
  }
})

/**
 * Legacy popup entry point. Deliberately refuses rather than guessing an identity.
 *
 * Kept because the frontend and backend deploy independently: an admin with the old
 * bundle still loaded will hit this, and a clear instruction beats a silent takeover
 * of the service account. Safe to delete once no old frontend build is in use.
 */
router.get('/sfdc/admin-start', async (_req, res) => {
  renderAuthFailure(res, {
    title: 'This Salesforce connect link is out of date.',
    hint: 'Refresh the admin UI (Cmd-Shift-R) and click Connect Salesforce again. The old link could not tell which admin was connecting, so it is no longer accepted.',
  })
})

// ── Admin Login ──────────────────────────────────────────────────────────────

router.post('/admin/login', async (req, res) => {
  try {
    const { email, password } = req.body as { email: string; password: string }

    let authenticated = false

    if (email === config.ADMIN_EMAIL) {
      // Primary: check env var credentials
      if (config.ADMIN_PASSWORD) {
        authenticated = password === config.ADMIN_PASSWORD
      } else if (config.ADMIN_PASSWORD_HASH) {
        authenticated = await bcrypt.compare(password, config.ADMIN_PASSWORD_HASH)
      } else {
        return res.status(500).json({ error: 'Admin password not configured' })
      }
    } else {
      // Secondary: check AdminUser table
      const adminUser = await db.adminUser.findUnique({ where: { email } })
      if (adminUser) {
        authenticated = await bcrypt.compare(password, adminUser.passwordHash)
      }
    }

    if (!authenticated) {
      return res.status(401).json({ error: 'Invalid credentials' })
    }

    const token = jwt.sign({ email, role: 'admin' }, config.JWT_SECRET, { expiresIn: '8h' })

    // Store session
    await db.adminSession.create({
      data: {
        email,
        tokenHash: await bcrypt.hash(token, 8),
        expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000),
      },
    })

    res.json({ token })
  } catch (err) {
    res.status(500).json({ error: 'Login failed' })
  }
})

// Helper to generate initial admin password hash (run once, save to .env)
router.post('/admin/setup', async (req, res) => {
  if (config.NODE_ENV !== 'development') {
    return res.status(403).json({ error: 'Only available in development' })
  }
  const { password } = req.body as { password: string }
  const hash = await bcrypt.hash(password, 12)
  res.json({ hash, instruction: 'Set this as ADMIN_PASSWORD_HASH in your .env' })
})

export default router
