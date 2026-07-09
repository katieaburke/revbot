import jwt from 'jsonwebtoken'
import { config } from '../config'

export function generateManagerToken(slackUserId: string): string {
  return jwt.sign({ slackUserId, role: 'manager' }, config.JWT_SECRET, { expiresIn: '30d' })
}

export function verifyManagerToken(token: string): { slackUserId: string } {
  const payload = jwt.verify(token, config.JWT_SECRET) as { slackUserId: string; role?: string }
  if (payload.role !== 'manager') throw new Error('Not a manager token')
  return { slackUserId: payload.slackUserId }
}
