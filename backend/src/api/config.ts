import { Router } from 'express'
import { db } from '../db'
import { requireAdmin } from '../middleware/adminAuth'
import { z } from 'zod'
import { scheduleAlertJob } from '../jobs/scheduler'

const router = Router()
router.use(requireAdmin)

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

// ── MEDDPICC Stage Requirements ───────────────────────────────────────────────

router.get('/meddpicc', async (_req, res) => {
  const reqs = await db.meddpiccStageRequirement.findMany({ orderBy: { stageName: 'asc' } })
  res.json(reqs)
})

const meddpiccSchema = z.object({
  stageName: z.string().min(1),
  enabled: z.boolean().optional().default(true),
  requireMetrics: z.boolean().optional().default(false),
  requireEconomicBuyer: z.boolean().optional().default(false),
  requireDecisionCriteria: z.boolean().optional().default(false),
  requireDecisionProcess: z.boolean().optional().default(false),
  requireIdentifyPain: z.boolean().optional().default(false),
  requireChampion: z.boolean().optional().default(false),
  requireCompetition: z.boolean().optional().default(false),
  sfdcFieldMetrics: z.string().optional(),
  sfdcFieldEconomicBuyer: z.string().optional(),
  sfdcFieldDecisionCriteria: z.string().optional(),
  sfdcFieldDecisionProcess: z.string().optional(),
  sfdcFieldIdentifyPain: z.string().optional(),
  sfdcFieldChampion: z.string().optional(),
  sfdcFieldCompetition: z.string().optional(),
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

// ── App Settings (schedule, cooldown, etc.) ───────────────────────────────────

router.get('/settings', async (_req, res) => {
  const settings = await db.appSetting.findMany()
  const result = Object.fromEntries(settings.map((s: { key: string; value: string }) => [s.key, JSON.parse(s.value)]))
  res.json(result)
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

    res.json({ ok: true })
  } catch (err) {
    res.status(400).json({ error: String(err) })
  }
})

export default router
