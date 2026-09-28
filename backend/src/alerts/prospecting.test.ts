import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateProspectingHygiene } from './prospecting'
import type { SfdcAccount } from '../services/salesforce'
import type { GongAccountActivity, GongFlowEnrollment } from '../services/gong'

function daysOut(n: number): string {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + n)
  return d.toISOString().slice(0, 10)
}

function account(over: Partial<SfdcAccount> = {}): SfdcAccount {
  return {
    Id: '001000000000001',
    Name: 'Acme Corp',
    Account_Stage__c: 'Prospect',
    Prospecting_Status__c: 'Prospecting',
    Prospecting_Pause_Reason__c: null,
    Target_Prospecting_Date__c: null,
    Date_to_Re_engage__c: null,
    End_of_competitor_engagement__c: null,
    Competitor__c: null,
    Last_Rep_Communication_Date__c: null,
    OwnerId: '005000000000001',
    Owner: { Id: '005000000000001', Name: 'Rep', Email: 'rep@uberall.com' },
    RecordType: { Name: 'Enterprise Account Record', DeveloperName: 'Enterprise_Account_Record' },
    ...over,
  } as SfdcAccount
}

function gong(accountId: string, lastCallDaysAgo: number | null, totalCalls = 1): Map<string, GongAccountActivity> {
  return new Map([
    [
      accountId,
      {
        sfdcAccountId: accountId,
        lastCallDate: lastCallDaysAgo === null ? null : daysOut(-lastCallDaysAgo),
        totalCalls,
        contactEmailsOnCalls: new Set<string>(),
      },
    ],
  ])
}

const types = (flags: { flagType: string }[]) => flags.map((f) => f.flagType).sort()

describe('STALE_PROSPECTING', () => {
  test('flags a Prospecting account with no activity at all', () => {
    const flags = evaluateProspectingHygiene([account()], new Map())
    assert.deepEqual(types(flags), ['STALE_PROSPECTING'])
  })

  test('a recent Gong call suppresses it', () => {
    const acct = account()
    const flags = evaluateProspectingHygiene([acct], gong(acct.Id, 3))
    assert.deepEqual(types(flags), [])
  })

  test('recent rep contact suppresses it even with no Gong call', () => {
    // Covers email and manual outreach, which never produce a Gong call. Without this
    // the flag fires at reps who are demonstrably working the account.
    const acct = account({ Last_Rep_Communication_Date__c: daysOut(-3) })
    const flags = evaluateProspectingHygiene([acct], new Map())
    assert.deepEqual(types(flags), [])
  })

  test('activity older than the threshold does not suppress it', () => {
    const acct = account({ Last_Rep_Communication_Date__c: daysOut(-40) })
    const flags = evaluateProspectingHygiene([acct], gong(acct.Id, 40))
    assert.deepEqual(types(flags), ['STALE_PROSPECTING'])
  })

  test('only applies to the Prospecting status', () => {
    for (const status of ['Paused', 'Nurturing', 'Success', null]) {
      const flags = evaluateProspectingHygiene([account({ Prospecting_Status__c: status })], new Map())
      assert.deepEqual(types(flags), [], `status ${status} should not be flagged`)
    }
  })
})

describe('SHOULD_BE_PROSPECTING', () => {
  const planned = (over: Partial<SfdcAccount> = {}) => account({ Prospecting_Status__c: 'Planned', ...over })

  test('flags a Planned account with a recent Gong call', () => {
    const acct = planned()
    const flags = evaluateProspectingHygiene([acct], gong(acct.Id, 2))
    assert.deepEqual(types(flags), ['SHOULD_BE_PROSPECTING'])
  })

  test('a future re-engage date suppresses it', () => {
    const acct = planned({ Date_to_Re_engage__c: daysOut(30) })
    const flags = evaluateProspectingHygiene([acct], gong(acct.Id, 2))
    assert.deepEqual(types(flags), [])
  })

  test('a future target prospecting date suppresses it', () => {
    const acct = planned({ Target_Prospecting_Date__c: daysOut(30) })
    const flags = evaluateProspectingHygiene([acct], gong(acct.Id, 2))
    assert.deepEqual(types(flags), [])
  })

  test('no recent call means no flag', () => {
    const acct = planned()
    const flags = evaluateProspectingHygiene([acct], gong(acct.Id, 60))
    assert.deepEqual(types(flags), [])
  })
})

describe('STALE_TARGET_DATE', () => {
  test('flags an active account worked recently with a long-stale target date', () => {
    const acct = account({ Target_Prospecting_Date__c: daysOut(-200) })
    const flags = evaluateProspectingHygiene([acct], gong(acct.Id, 2))
    assert.deepEqual(types(flags), ['STALE_TARGET_DATE'])
  })

  test('does not double-flag an account already caught as STALE_PROSPECTING', () => {
    // Both rules could match the same row; firing both would nudge the rep twice for
    // one underlying problem.
    const acct = account({ Target_Prospecting_Date__c: daysOut(-200) })
    const flags = evaluateProspectingHygiene([acct], new Map())
    assert.deepEqual(types(flags), ['STALE_PROSPECTING'])
  })

  test('is skipped for non-active statuses', () => {
    const acct = account({ Prospecting_Status__c: 'Paused', Target_Prospecting_Date__c: daysOut(-200) })
    const flags = evaluateProspectingHygiene([acct], gong(acct.Id, 2))
    assert.deepEqual(types(flags), [])
  })

  test('a current target date is not stale', () => {
    const acct = account({ Target_Prospecting_Date__c: daysOut(-1) })
    const flags = evaluateProspectingHygiene([acct], gong(acct.Id, 2))
    assert.deepEqual(types(flags), [])
  })
})

describe('gongFlowStats', () => {
  const withContacts = (emails: string[]) =>
    account({
      Contacts: {
        totalSize: emails.length,
        records: emails.map((Email, i) => ({ Id: `003${i}`, Email, Name: `Contact ${i}` })),
      },
    } as Partial<SfdcAccount>)

  const enrollment = (over: Partial<GongFlowEnrollment> = {}): GongFlowEnrollment => ({
    flowId: 'f1',
    flowName: 'Outbound',
    status: 'ACTIVE',
    nextStepDueDate: null,
    completedAt: null,
    ...over,
  })

  test('is null when no flow index is supplied', () => {
    // null means "Gong Engage Flows unavailable on this plan", which is different from
    // "zero contacts in flows" and must not be rendered as zeros.
    const flags = evaluateProspectingHygiene([account()], new Map())
    assert.equal(flags[0].gongFlowStats, null)
  })

  test('is zeroed rather than null when an empty index is supplied', () => {
    const flags = evaluateProspectingHygiene([account()], new Map(), undefined, new Map())
    assert.deepEqual(flags[0].gongFlowStats, { activeWithOverdue: 0, activeOnTrack: 0, completedSinceTarget: 0 })
  })

  test('separates overdue from on-track active enrollments', () => {
    const acct = withContacts(['a@x.com', 'b@x.com'])
    const index = new Map<string, GongFlowEnrollment[]>([
      ['a@x.com', [enrollment({ nextStepDueDate: daysOut(-5) })]],
      ['b@x.com', [enrollment({ nextStepDueDate: daysOut(5) })]],
    ])
    const flags = evaluateProspectingHygiene([acct], new Map(), undefined, index)
    assert.equal(flags[0].gongFlowStats?.activeWithOverdue, 1)
    assert.equal(flags[0].gongFlowStats?.activeOnTrack, 1)
  })

  test('counts a contact in several active flows only once', () => {
    const acct = withContacts(['a@x.com'])
    const index = new Map<string, GongFlowEnrollment[]>([
      ['a@x.com', [enrollment({ flowId: 'f1' }), enrollment({ flowId: 'f2' })]],
    ])
    const flags = evaluateProspectingHygiene([acct], new Map(), undefined, index)
    assert.equal(flags[0].gongFlowStats?.activeOnTrack, 1)
  })

  test('matches contact emails case-insensitively', () => {
    // SFDC preserves whatever case was typed; the index is lowercased. A case
    // mismatch would silently report zero flows for a contact who is in one.
    const acct = withContacts(['Mixed.Case@X.com'])
    const index = new Map<string, GongFlowEnrollment[]>([['mixed.case@x.com', [enrollment()]]])
    const flags = evaluateProspectingHygiene([acct], new Map(), undefined, index)
    assert.equal(flags[0].gongFlowStats?.activeOnTrack, 1)
  })

  test('only counts completions on or after the target prospecting date', () => {
    const base = withContacts(['a@x.com'])
    const acct = { ...base, Target_Prospecting_Date__c: daysOut(-30) } as SfdcAccount
    const before = new Map<string, GongFlowEnrollment[]>([
      ['a@x.com', [enrollment({ status: 'COMPLETED', completedAt: daysOut(-60) })]],
    ])
    const after = new Map<string, GongFlowEnrollment[]>([
      ['a@x.com', [enrollment({ status: 'COMPLETED', completedAt: daysOut(-10) })]],
    ])
    assert.equal(
      evaluateProspectingHygiene([acct], new Map(), undefined, before)[0].gongFlowStats?.completedSinceTarget,
      0,
    )
    assert.equal(
      evaluateProspectingHygiene([acct], new Map(), undefined, after)[0].gongFlowStats?.completedSinceTarget,
      1,
    )
  })
})
