import { Redis } from 'ioredis'
import { config } from './config'

// BullMQ connection — must have maxRetriesPerRequest: null (BullMQ requirement)
export const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
})
redis.on('error', (err) => console.error('Redis error:', err))

// Cache connection — fails fast so a slow/flaky Redis never blocks a scan
// maxRetriesPerRequest: 0 = give up immediately if the command can't be sent
// enableOfflineQueue: false = reject commands instantly when disconnected (no hanging)
// commandTimeout: 2000 = hard 2s cap per command
export const cacheRedis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: 0,
  enableOfflineQueue: false,
  commandTimeout: 2000,
})
cacheRedis.on('error', (err) => console.error('Cache Redis error:', err))
