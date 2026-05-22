import { Redis } from 'ioredis'
import { config } from './config'

export const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: null, // required by BullMQ
})

redis.on('error', (err) => console.error('Redis error:', err))
