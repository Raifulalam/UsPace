// Creates the FIRST (superadmin) account and prints a one-time setup link. Run from apps/api:
//   node --env-file=.env scripts/createAdmin.js you@company.com
// The link lets the new admin choose a password and register an authenticator app. It expires in 48 hours.
const config = require('../src/config/env');
const { connectDb } = require('../src/config/db');
require('../src/models/AdminAccount');
require('../src/models/AdminSession');
require('../src/models/AdminAuditLog');
const auth = require('../src/services/adminAuthService');

(async () => {
  const email = (process.argv[2] || '').toLowerCase().trim();
  if (!/^\S+@\S+\.\S+$/.test(email)) { console.error('Usage: node --env-file=.env scripts/createAdmin.js you@company.com'); process.exit(1); }
  if (!config.ADMIN_JWT_SECRET || !config.ADMIN_MFA_KEY) { console.error('Set ADMIN_JWT_SECRET and ADMIN_MFA_KEY (32+ characters each) in .env first.'); process.exit(1); }
  await connectDb();
  const { setupUrl } = await auth.inviteAdmin(null, email, 'superadmin', { ip: 'cli' });
  console.log(`\nSuperadmin created: ${email}\nOpen this link within 48 hours (shown once):\n\n  ${setupUrl}\n`);
  process.exit(0);
})().catch((e) => { console.error(e.code === 'ALREADY_EXISTS' ? 'An admin with that email already exists.' : e); process.exit(1); });
