import jwt from 'jsonwebtoken'
import { config } from '../config'

/**
 * Whose queue a token opens, when that isn't the token holder's own.
 *
 * Set only by the admin-minted "work on behalf of" link. The holder stays
 * themselves — their user row is what the portal authenticates and what
 * dispositions are recorded against — but the accounts loaded are the other
 * rep's. That's how a departed rep's book stays workable without anyone having
 * to pretend to be them in our audit log.
 */
export interface RepTokenClaims {
  slackUserId: string
  queueFor?: string
}

export function generateRepToken(
  slackUserId: string,
  opts: { queueFor?: string } = {},
): string {
  return jwt.sign(
    { slackUserId, role: 'rep', ...(opts.queueFor ? { queueFor: opts.queueFor } : {}) },
    config.JWT_SECRET,
    // Deliberately shorter for on-behalf-of links: they cross the normal
    // one-rep-one-queue boundary, so they shouldn't sit in someone's history for
    // a month the way an ordinary portal link does.
    { expiresIn: opts.queueFor ? '7d' : '30d' },
  )
}

export function verifyRepToken(token: string): RepTokenClaims {
  const payload = jwt.verify(token, config.JWT_SECRET) as {
    slackUserId: string
    role: string
    queueFor?: string
  }
  if (payload.role !== 'rep') throw new Error('Invalid token role')
  return {
    slackUserId: payload.slackUserId,
    ...(payload.queueFor ? { queueFor: payload.queueFor } : {}),
  }
}
