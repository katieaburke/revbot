import jwt from 'jsonwebtoken'
import { config } from '../config'

export function generateRepToken(slackUserId: string): string {
  return jwt.sign({ slackUserId, role: 'rep' }, config.JWT_SECRET, { expiresIn: '30d' })
}

export function verifyRepToken(token: string): { slackUserId: string } {
  const payload = jwt.verify(token, config.JWT_SECRET) as { slackUserId: string; role: string }
  if (payload.role !== 'rep') throw new Error('Invalid token role')
  return { slackUserId: payload.slackUserId }
}
