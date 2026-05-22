import type { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { config } from '../config'

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  try {
    const token = header.slice(7)
    const payload = jwt.verify(token, config.JWT_SECRET) as { role: string }
    if (payload.role !== 'admin') return res.status(403).json({ error: 'Forbidden' })
    next()
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' })
  }
}
