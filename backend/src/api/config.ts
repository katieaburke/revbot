import { Router } from 'express'
import { randomBytes } from 'crypto'
import { db } from '../db'
import { requireAdmin } from '../middleware/adminAuth'
import { z } from 'zod'
import { scheduleAlertJob } from '../jobs/scheduler'
import { invalidateTestOverrideCache } from '../slack/bot'
import bcrypt from 'bcrypt'

const router = Router()
router.use(requireAdmin)

// ── Last Dry Run Summary ──────────────────────────────────────────────────────

router.get('/last-dry-run-summary', async (_req, res) => {
  const setting = await db.appSetting.findUnique({ where: { key: 'lastDryRunSummary' } })
  if (!setting) return res.json(null)
  res.json(JSON.parse(setting.value))
})

// ── Stall Rules ───────────────────────────────────────────────────────────────

router.get('/stall-rules', async (_req, res) => {
  const rules = await db.stallRule.findMany({ orderBy: { createdAt: 'asc' } })
  res.json(rules)
})

const stallRuleSchema = z.object({
  name: z.string().min(1),
  enabled: z.boolean().optional().default(true),
  dealAgeThresholdDays: z.number().int().positive().nullable().optional(),
  stageDurationThresholdDays: z.number().int().positive().nullable().optional(),
  gongInactivityDays: z.number().int().positive().nullable().optional(),
  flagSingleThreaded: z.boolean().optional().default(false),
  flagGongRedFlags: z.boolean().optional().default(false),
  filterStages: z.array(z.string()).optional().default([]),
  filterOppTypes: z.array(z.string()).optional().default([]),
  filterSegments: z.array(z.string()).optional().default([]),
  filterOwnerIds: z.array(z.string()).optional().default([]),
})

router.post('/stall-rules', async (req, res) => {
  try {
    const data = stallRuleSchema.parse(req.body)
    const rule = await db.stallRule.create({ data })
    res.status(201).json(rule)
  } catch (err) {
    res.status(400).json({ error: String(err) })
  }
})

router.put('/stall-rules/:id', async (req, res) => {
  try {
    const data = stallRuleSchema.partial().parse(req.body)
    const rule = await db.stallRule.update({ where: { id: req.params.id }, data })
    res.json(rule)
  } catch (err) {
    res.status(400).json({ error: String(err) })
  }
})

router.delete('/stall-rules/:id', async (req, res) => {
  await db.stallRule.delete({ where: { id: req.params.id } })
  res.status(204).send()
})

// ── Stall Thresholds by Stage ─────────────────────────────────────────────────

router.get('/stall-thresholds', async (_req, res) => {
  const thresholds = await db.stallThresholdByStage.findMany({ orderBy: { stageName: 'asc' } })
  res.json(thresholds)
})

const stallThresholdSchema = z.object({
  stageName: z.string().min(1),
  opportunityType: z.string().optional().default('All'),
  enabled: z.boolean().optional().default(true),
  stageDurationThresholdDays: z.number().int().positive().nullable().optional(),
  dealAgeThresholdDays: z.number().int().positive().nullable().optional(),
})

router.post('/stall-thresholds', async (req, res) => {
  try {
    const data = stallThresholdSchema.parse(req.body)
    const threshold = await db.stallThresholdByStage.create({ data })
    res.status(201).json(threshold)
  } catch (err) {
    res.status(400).json({ error: String(err) })
  }
})

router.put('/stall-thresholds/:id', async (req, res) => {
  try {
    const data = stallThresholdSchema.partial().parse(req.body)
    const threshold = await db.stallThresholdByStage.update({ where: { id: req.params.id }, data })
    res.json(threshold)
  } catch (err) {
    res.status(400).json({ error: String(err) })
  }
})

router.delete('/stall-thresholds/:id', async (req, res) => {
  await db.stallThresholdByStage.delete({ where: { id: req.params.id } })
  res.status(204).send()
})

// ── Close Date Risk Rules ─────────────────────────────────────────────────────

router.get('/close-date-risk', async (_req, res) => {
  const rules = await db.closeDateRiskRule.findMany({ orderBy: { stageName: 'asc' } })
  res.json(rules)
})

const closeDateRiskSchema = z.object({
  stageName: z.string().min(1),
  opportunityType: z.string().optional().default('All'),
  daysThreshold: z.number().int().positive(),
  enabled: z.boolean().optional().default(true),
})

router.post('/close-date-risk', async (req, res) => {
  try {
    const data = closeDateRiskSchema.parse(req.body)
    const rule = await db.closeDateRiskRule.create({ data })
    res.status(201).json(rule)
  } catch (err) {
    res.status(400).json({ error: String(err) })
  }
})

router.put('/close-date-risk/:id', async (req, res) => {
  try {
    const data = closeDateRiskSchema.partial().parse(req.body)
    const rule = await db.closeDateRiskRule.update({ where: { id: req.params.id }, data })
    res.json(rule)
  } catch (err) {
    res.status(400).json({ error: String(err) })
  }
})

router.delete('/close-date-risk/:id', async (req, res) => {
  await db.closeDateRiskRule.delete({ where: { id: req.params.id } })
  res.status(204).send()
})

// ── MEDDPICC Stage Requirements ───────────────────────────────────────────────

router.get('/meddpicc', async (_req, res) => {
  const reqs = await db.meddpiccStageRequirement.findMany({ orderBy: { stageName: 'asc' } })
  res.json(reqs)
})

const meddpiccSchema = z.object({
  stageName: z.string().min(1),
  opportunityType: z.string().optional().default('All'),
  enabled: z.boolean().optional().default(true),
  requireMetrics: z.boolean().optional().default(false),
  requireEconomicBuyer: z.boolean().optional().default(false),
  requireDecisionCriteria: z.boolean().optional().default(false),
  requireDecisionProcess: z.boolean().optional().default(false),
  requireIdentifyPain: z.boolean().optional().default(false),
  requireChampion: z.boolean().optional().default(false),
  requireCompetition: z.boolean().optional().default(false),
  requirePaperProcess: z.boolean().optional().default(false),
  sfdcFieldMetrics: z.string().optional(),
  sfdcFieldEconomicBuyer: z.string().optional(),
  sfdcFieldDecisionCriteria: z.string().optional(),
  sfdcFieldDecisionProcess: z.string().optional(),
  sfdcFieldIdentifyPain: z.string().optional(),
  sfdcFieldChampion: z.string().optional(),
  sfdcFieldCompetition: z.string().optional(),
  sfdcFieldPaperProcess: z.string().optional(),
  requireBudget: z.boolean().optional().default(false),
  requireAuthority: z.boolean().optional().default(false),
  requireNeed: z.boolean().optional().default(false),
  requireTiming: z.boolean().optional().default(false),
  sfdcFieldBudget: z.string().optional(),
  sfdcFieldAuthority: z.string().optional(),
  sfdcFieldNeed: z.string().optional(),
  sfdcFieldTiming: z.string().optional(),
})

router.post('/meddpicc', async (req, res) => {
  try {
    const data = meddpiccSchema.parse(req.body)
    const req_ = await db.meddpiccStageRequirement.create({ data })
    res.status(201).json(req_)
  } catch (err) {
    res.status(400).json({ error: String(err) })
  }
})

router.put('/meddpicc/:id', async (req, res) => {
  try {
    const data = meddpiccSchema.partial().parse(req.body)
    const req_ = await db.meddpiccStageRequirement.update({ where: { id: req.params.id }, data })
    res.json(req_)
  } catch (err) {
    res.status(400).json({ error: String(err) })
  }
})

router.delete('/meddpicc/:id', async (req, res) => {
  await db.meddpiccStageRequirement.delete({ where: { id: req.params.id } })
  res.status(204).send()
})

// ── Stage Mismatch Rules ──────────────────────────────────────────────────────

router.get('/stage-mismatch-rules', async (_req, res) => {
  const rules = await db.stageMismatchRule.findMany({ orderBy: { createdAt: 'asc' } })
  res.json(rules)
})

router.post('/stage-mismatch-rules', async (req, res) => {
  const { name, keywords, stages, enabled } = req.body
  const rule = await db.stageMismatchRule.create({
    data: { name, keywords, stages, enabled: enabled ?? true },
  })
  res.json(rule)
})

router.put('/stage-mismatch-rules/:id', async (req, res) => {
  const { name, keywords, stages, enabled } = req.body
  const rule = await db.stageMismatchRule.update({
    where: { id: req.params.id },
    data: { name, keywords, stages, enabled },
  })
  res.json(rule)
})

router.delete('/stage-mismatch-rules/:id', async (req, res) => {
  await db.stageMismatchRule.delete({ where: { id: req.params.id } })
  res.json({ ok: true })
})

// ── Salesforce connection status ──────────────────────────────────────────────

router.get('/sfdc-status', async (_req, res) => {
  const user = await db.user.findFirst({ where: { isRevOps: true, sfdcAccessToken: { not: null } } })
  res.json({ connected: !!user })
})

router.delete('/sfdc-disconnect', async (_req, res) => {
  await db.user.updateMany({
    where: { isRevOps: true },
    data: {
      sfdcAccessToken: null,
      sfdcRefreshToken: null,
      sfdcTokenExpiresAt: null,
      sfdcConnectedAt: null,
    },
  })
  // Bust the cached connection so next connect starts fresh
  const { invalidateSfdcCache } = await import('../services/salesforce')
  invalidateSfdcCache()
  res.json({ ok: true })
})

// ── App Settings (schedule, cooldown, etc.) ───────────────────────────────────

router.get('/settings', async (_req, res) => {
  try {
    const settings = await db.appSetting.findMany()
    const result: Record<string, unknown> = {
      sfdcInstanceUrl: 'https://uberall.lightning.force.com/',
    }
    for (const s of settings) result[s.key] = JSON.parse(s.value)
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

router.put('/settings', async (req, res) => {
  try {
    const updates = req.body as Record<string, unknown>

    for (const [key, value] of Object.entries(updates)) {
      await db.appSetting.upsert({
        where: { key },
        create: { key, value: JSON.stringify(value) },
        update: { value: JSON.stringify(value) },
      })
    }

    // If schedule changed, reschedule
    if (updates.alertCron) {
      await scheduleAlertJob(updates.alertCron as string)
    }

    // If test recipient changed, bust the cached Slack ID
    if ('slackTestRecipient' in updates) {
      invalidateTestOverrideCache()
    }

    res.json({ ok: true })
  } catch (err) {
    res.status(400).json({ error: String(err) })
  }
})

// Generate (or rotate) the Chrome extension API key
router.post('/settings/generate-extension-key', async (req, res) => {
  const key = randomBytes(24).toString('hex')
  await db.appSetting.upsert({
    where: { key: 'extensionApiKey' },
    create: { key: 'extensionApiKey', value: JSON.stringify(key) },
    update: { value: JSON.stringify(key) },
  })
  res.json({ extensionApiKey: key })
})

// ── Admin Users ───────────────────────────────────────────────────────────────

router.get('/admin-users', async (_req, res) => {
  const users = await db.adminUser.findMany({
    orderBy: { createdAt: 'asc' },
    select: { id: true, email: true, name: true, createdAt: true }, // never return passwordHash
  })
  res.json(users)
})

router.post('/admin-users', async (req, res) => {
  try {
    const { email, password, name } = req.body as { email: string; password: string; name?: string }
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' })
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' })
    const passwordHash = await bcrypt.hash(password, 10)
    const user = await db.adminUser.create({
      data: { email, passwordHash, name: name || null },
      select: { id: true, email: true, name: true, createdAt: true },
    })
    res.status(201).json(user)
  } catch (err: any) {
    if (err.code === 'P2002') return res.status(409).json({ error: 'Email already exists' })
    res.status(500).json({ error: 'Failed to create user' })
  }
})

router.put('/admin-users/:id/password', async (req, res) => {
  try {
    const { password } = req.body as { password: string }
    if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' })
    const passwordHash = await bcrypt.hash(password, 10)
    await db.adminUser.update({ where: { id: req.params.id }, data: { passwordHash } })
    res.json({ ok: true })
  } catch {
    res.status(500).json({ error: 'Failed to update password' })
  }
})

router.delete('/admin-users/:id', async (req, res) => {
  await db.adminUser.delete({ where: { id: req.params.id } })
  res.json({ ok: true })
})

export default router
