import dotenv from 'dotenv'
import { z } from 'zod'
import { resolve } from 'path'
import { readFileSync } from 'fs'

// Load .env from project root — try multiple paths for tsx vs compiled
dotenv.config({ path: resolve(process.cwd(), '.env') })
dotenv.config({ path: resolve(process.cwd(), '../.env') })

// Read admin password hash from file (avoids dotenv mangling $ signs in bcrypt hashes)
for (const p of [resolve(process.cwd(), '.admin-hash'), resolve(process.cwd(), '../.admin-hash')]) {
  try {
    const hash = readFileSync(p, 'utf8').trim()
    if (hash) { process.env.ADMIN_PASSWORD_HASH = hash; break }
  } catch { /* file not found */ }
}

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3001),
  APP_URL: z.string().url(),
  DATABASE_URL: z.string(),
  REDIS_URL: z.string().default('redis://localhost:6379'),

  ENCRYPTION_KEY: z.string().length(64, 'Must be 64-char hex (32 bytes)'),

  SFDC_CLIENT_ID: z.string(),
  SFDC_CLIENT_SECRET: z.string(),
  SFDC_REDIRECT_URI: z.string().url(),
  SFDC_LOGIN_URL: z.string().url().default('https://login.salesforce.com'),

  SLACK_BOT_TOKEN: z.string().optional(),
  SLACK_SIGNING_SECRET: z.string().optional(),
  SLACK_APP_TOKEN: z.string().optional(),

  GONG_ACCESS_KEY: z.string(),
  GONG_ACCESS_SECRET: z.string(),

  JWT_SECRET: z.string().min(32),
  ADMIN_EMAIL: z.string().email(),
  ADMIN_PASSWORD: z.string().optional(),
  ADMIN_PASSWORD_HASH: z.string().optional(),

  ANTHROPIC_API_KEY: z.string().optional(),
})

const parsed = schema.safeParse(process.env)

if (!parsed.success) {
  console.error('❌ Invalid environment variables:')
  console.error(parsed.error.flatten().fieldErrors)
  process.exit(1)
}

export const config = parsed.data
