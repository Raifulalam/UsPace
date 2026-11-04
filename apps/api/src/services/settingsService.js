const { z } = require('zod');
const config = require('../config/env');
const ApplicationSettings = require('../models/ApplicationSettings');

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const url = z.union([z.literal(''), z.string().url().max(300).refine((u) => u.startsWith('https://'), 'must start with https://')]);
const MB = 1024 * 1024;

const FEATURES = ['chat', 'canvas', 'memories', 'media', 'games', 'calls', 'wallpaper'];
const defaults = () => ({
  appName: 'Our Space',
  logoUrl: '',
  theme: { accent: '#db2777', accent2: '#7c3aed' },
  maintenance: { enabled: false, message: 'We are making things better. Back soon!' },
  limits: { invitesPerDay: 10, reportsPerDay: 5, freeStorageBytes: config.FREE_STORAGE_BYTES },
  features: Object.fromEntries(FEATURES.map((f) => [f, true])),
  legal: { termsUrl: '', privacyUrl: '', guidelinesUrl: '' },
});

const patchSchema = z.object({
  appName: z.string().trim().min(1).max(40),
  logoUrl: url,
  theme: z.object({ accent: hex, accent2: hex }).partial().strict(),
  maintenance: z.object({ enabled: z.boolean(), message: z.string().max(300) }).partial().strict(),
  limits: z.object({
    invitesPerDay: z.number().int().min(1).max(100), reportsPerDay: z.number().int().min(1).max(50),
    freeStorageBytes: z.number().int().min(100 * MB).max(1024 * 1024 * MB),
  }).partial().strict(),
  features: z.object(Object.fromEntries(FEATURES.map((f) => [f, z.boolean()]))).partial().strict(),
  legal: z.object({ termsUrl: url, privacyUrl: url, guidelinesUrl: url }).partial().strict(),
}).partial().strict().refine((o) => Object.keys(o).length > 0, 'Nothing to update');

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) out[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v) : v;
  return out;
}
/** Lists every setting that changed as { 'limits.invitesPerDay': { from, to } } (this is what goes in the audit log). */
function diff(a, b, prefix = '') {
  const out = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (isObj(a[k]) && isObj(b[k])) Object.assign(out, diff(a[k], b[k], path));
    else if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out[path] = { from: a[k], to: b[k] };
  }
  return out;
}

let cache = null;
const TTL = 10_000;
async function get() {
  if (cache && Date.now() - cache.at < TTL) return cache.value;
  const doc = await ApplicationSettings.findOne({ key: 'main' }).lean();
  cache = { at: Date.now(), value: merge(defaults(), doc?.values) };
  return cache.value;
}
const invalidate = () => { cache = null; };

async function update(patch, adminEmail) {
  const before = await get();
  const after = merge(before, patch);
  await ApplicationSettings.findOneAndUpdate({ key: 'main' }, { $set: { values: after, updatedBy: adminEmail } }, { upsert: true });
  invalidate();
  return { settings: after, changes: diff(before, after) };
}

/** The only settings the public app may see. */
const publicConfig = (s) => ({ appName: s.appName, logoUrl: s.logoUrl, theme: s.theme, maintenance: s.maintenance, features: s.features, legal: s.legal });

module.exports = { get, update, invalidate, publicConfig, patchSchema, diff, merge, defaults, FEATURES };
