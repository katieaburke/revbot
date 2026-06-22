import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

const stages = [
  {
    stageName: 'Qualification',
    enabled: true,
    requireMetrics: false,
    requireEconomicBuyer: false,
    requireDecisionCriteria: false,
    requireDecisionProcess: false,
    requirePaperProcess: false,
    requireIdentifyPain: false,
    requireChampion: false,
    requireCompetition: false,
  },
  {
    stageName: 'Discovery',
    enabled: true,
    requireMetrics: true,
    requireEconomicBuyer: false,
    requireDecisionCriteria: false,
    requireDecisionProcess: false,
    requirePaperProcess: false,
    requireIdentifyPain: false,
    requireChampion: true,
    requireCompetition: false,
  },
  {
    stageName: 'Custom Demo',
    enabled: true,
    requireMetrics: true,
    requireEconomicBuyer: false,
    requireDecisionCriteria: true,
    requireDecisionProcess: false,
    requirePaperProcess: false,
    requireIdentifyPain: true,
    requireChampion: true,
    requireCompetition: false,
  },
  {
    stageName: 'Presentation/Proposal',
    enabled: true,
    requireMetrics: true,
    requireEconomicBuyer: true,
    requireDecisionCriteria: true,
    requireDecisionProcess: true,
    requirePaperProcess: false,
    requireIdentifyPain: true,
    requireChampion: true,
    requireCompetition: false,
  },
  {
    stageName: 'Decision/Negotiation',
    enabled: true,
    requireMetrics: true,
    requireEconomicBuyer: true,
    requireDecisionCriteria: true,
    requireDecisionProcess: true,
    requirePaperProcess: true,
    requireIdentifyPain: true,
    requireChampion: true,
    requireCompetition: true,
  },
  {
    stageName: 'Legal/Procurement',
    enabled: true,
    requireMetrics: true,
    requireEconomicBuyer: true,
    requireDecisionCriteria: true,
    requireDecisionProcess: true,
    requirePaperProcess: true,
    requireIdentifyPain: true,
    requireChampion: true,
    requireCompetition: true,
  },
]

async function main() {
  for (const stage of stages) {
    await db.meddpiccStageRequirement.upsert({
      where: { stageName: stage.stageName },
      create: stage,
      update: stage,
    })
    console.log(`✓ ${stage.stageName}`)
  }
  console.log('\nAll MEDDPICC stages seeded!')
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => db.$disconnect())
