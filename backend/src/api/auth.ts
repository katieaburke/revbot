import { Router } from 'express'
import { getSfdcAuthUrl, handleSfdcCallback, generatePkce, invalidateSfdcCache } from '../services/salesforce'
import { invalidateSfdcBaseCache } from '../slack/messages'
import { db } from '../db'
import { config } from '../config'
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

router.get('/sfdc/callback', async (req, res) => {
  try {
    const { code, state } = req.query as { code: string; state: string }
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
    if (!user) return res.status(404).send('User not found')

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
    res.status(500).send('Authentication failed')
  }
})

// ── Admin SFDC Connect (no Slack required) ───────────────────────────────────

router.get('/sfdc/admin-start', async (req, res) => {
  try {
    const { verifier, challenge } = generatePkce()
    const state = jwt.sign({ type: 'admin', adminEmail: config.ADMIN_EMAIL, codeVerifier: verifier }, config.JWT_SECRET, { expiresIn: '10m' })
    const authUrl = getSfdcAuthUrl(state, challenge)
    res.redirect(authUrl)
  } catch (err) {
    res.status(500).json({ error: 'Could not generate auth URL' })
  }
})

// ── Admin Login ──────────────────────────────────────────────────────────────

router.post('/admin/login', async (req, res) => {
  try {
    const { email, password } = req.body as { email: string; password: string }

    if (email !== config.ADMIN_EMAIL) {
      return res.status(401).json({ error: 'Invalid credentials' })
    }

    if (!config.ADMIN_PASSWORD_HASH) {
      return res.status(500).json({ error: 'Admin password not configured' })
    }

    const valid = await bcrypt.compare(password, config.ADMIN_PASSWORD_HASH)
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' })

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
