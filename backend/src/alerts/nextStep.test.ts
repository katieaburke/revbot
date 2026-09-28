import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateNextStep } from './nextStep'
import { evaluatePastDue } from './pastDue'
import type { SfdcOpportunity } from '../services/salesforce'

/** Days from today as a YYYY-MM-DD string, matching what Salesforce returns for dates. */
function daysOut(n: number): string {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + n)
  return d.toISOString().slice(0, 10)
}

function opp(over: Partial<SfdcOpportunity> = {}): SfdcOpportunity {
  return {
    Id: '006000000000001',
    Name: 'Test Opp',
    StageName: 'Discovery',
    CloseDate: daysOut(30),
    Type: 'New Business',
    Amount: 1000,
    OwnerId: '005000000000001',
    Owner: { Id: '005000000000001', Name: 'Rep', Email: 'rep@uberall.com' },
    CreatedDate: daysOut(-90),
    LastActivityDate: null,
    IsClosed: false,
    IsWon: false,
    NextStep: 'Send proposal',
    Next_Step_Date__c: daysOut(7),
    Booking_Date__c: daysOut(30),
    ...over,
  } as SfdcOpportunity
}

describe('evaluateNextStep', () => {
  test('a fully populated opp raises nothing', () => {
    assert.deepEqual(evaluateNextStep([opp()]), [])
  })

  test('closed opps are skipped entirely', () => {
    const alerts = evaluateNextStep([opp({ IsClosed: true, NextStep: null, Next_Step_Date__c: null })])
    assert.deepEqual(alerts, [])
  })

  test('flags missing text and missing date separately', () => {
    const alerts = evaluateNextStep([opp({ NextStep: null, Next_Step_Date__c: null })])
    assert.equal(alerts.length, 1)
    assert.deepEqual(alerts[0].issues.sort(), ['missing_date', 'missing_text'])
  })

  test('whitespace-only next step counts as missing', () => {
    const alerts = evaluateNextStep([opp({ NextStep: '   ' })])
    assert.deepEqual(alerts[0].issues, ['missing_text'])
  })

  test('flags a past next-step date', () => {
    const alerts = evaluateNextStep([opp({ Next_Step_Date__c: daysOut(-5) })])
    assert.deepEqual(alerts[0].issues, ['past_date'])
  })

  describe('grace period', () => {
    test('suppresses past_date inside the buffer', () => {
      assert.deepEqual(evaluateNextStep([opp({ Next_Step_Date__c: daysOut(-3) })], 5), [])
    })

    test('flags once past the buffer', () => {
      const alerts = evaluateNextStep([opp({ Next_Step_Date__c: daysOut(-6) })], 5)
      assert.deepEqual(alerts[0].issues, ['past_date'])
    })

    test('a NaN buffer does not silently disable the check', () => {
      // The failure this guards against is invisible: NaN comparisons are always
      // false, so every past_date would quietly stop being reported while the other
      // two issues kept firing, making it look like the rule still worked.
      const alerts = evaluateNextStep([opp({ Next_Step_Date__c: daysOut(-30) })], Number.NaN)
      assert.deepEqual(alerts[0].issues, ['past_date'])
    })

    test('a zero buffer still flags everything overdue', () => {
      const alerts = evaluateNextStep([opp({ Next_Step_Date__c: daysOut(-1) })], 0)
      assert.deepEqual(alerts[0].issues, ['past_date'])
    })
  })

  describe('renewals', () => {
    const renewal = (over: Partial<SfdcOpportunity> = {}) =>
      opp({ Type: 'Renewal', NextStep: null, Next_Step_Date__c: null, ...over })

    test('are checked inside the 90-day booking window', () => {
      const alerts = evaluateNextStep([renewal({ Booking_Date__c: daysOut(30) })])
      assert.equal(alerts.length, 1)
    })

    test('are skipped when booking is more than 90 days out', () => {
      assert.deepEqual(evaluateNextStep([renewal({ Booking_Date__c: daysOut(120) })]), [])
    })

    test('are skipped when already past due — evaluatePastDue owns those', () => {
      const overdue = renewal({ Booking_Date__c: daysOut(-10) })
      assert.deepEqual(evaluateNextStep([overdue]), [])
      // Confirm the handoff is real rather than assumed: something must cover it.
      assert.equal(evaluatePastDue([overdue]).length, 1)
    })

    test('a renewal with NO booking date is still evaluated', () => {
      // Regression test. This used to `continue`, and evaluatePastDue also bails on a
      // missing Booking_Date__c, so a dateless open renewal was the one kind of
      // opportunity that no evaluator ever looked at.
      const dateless = renewal({ Booking_Date__c: null })
      assert.equal(evaluatePastDue([dateless]).length, 0, 'pastDue still ignores these')
      const alerts = evaluateNextStep([dateless])
      assert.equal(alerts.length, 1, 'nextStep must cover the gap pastDue leaves')
      assert.deepEqual(alerts[0].issues.sort(), ['missing_date', 'missing_text'])
    })
  })

  test('carries through the fields the Slack message needs', () => {
    const alerts = evaluateNextStep([opp({ NextStep: null, Id: '006xyz', Name: 'Acme Renewal' })])
    assert.equal(alerts[0].opportunityId, '006xyz')
    assert.equal(alerts[0].opportunityName, 'Acme Renewal')
    assert.equal(alerts[0].ownerEmail, 'rep@uberall.com')
  })
})
