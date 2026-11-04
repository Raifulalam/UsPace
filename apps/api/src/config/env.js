const { z } = require('zod');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  MONGODB_URI: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  CLIENT_ORIGIN: z.string().url(),
  MIN_AGE: z.coerce.number().int().min(13).default(18),
  INVITATION_TTL_HOURS: z.coerce.number().positive().default(72),
  BCRYPT_COST: z.coerce.number().int().min(4).max(15).default(12),
  // Admin area. Optional so existing setups keep working: without both secrets the admin API stays switched off.
  ADMIN_JWT_SECRET: z.string().min(32, 'ADMIN_JWT_SECRET must be at least 32 characters').optional(),
  ADMIN_MFA_KEY: z.string().min(32, 'ADMIN_MFA_KEY must be at least 32 characters').optional(),
  ADMIN_ORIGIN: z.string().url().default('http://localhost:3001'),
  MEDIA_DIR: z.string().default('./data/media'),
  FREE_STORAGE_BYTES: z.coerce.number().int().positive().default(1073741824), // 1 GiB per couple on the free plan
  REQUIRE_EMAIL_VERIFICATION: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
  throw new Error(`Invalid environment configuration:\n${msg}`);
}
module.exports = parsed.data;
