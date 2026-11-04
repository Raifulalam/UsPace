// Least privilege: each role gets only what its job needs. NOTHING here grants access to message, memory, drawing,
// media or location content: those are end-to-end encrypted and no permission can unlock them.
const ROLE_PERMISSIONS = {
  superadmin: ['*'],
  moderator: ['stats:read', 'users:read', 'users:suspend', 'rooms:read', 'rooms:suspend', 'reports:read', 'reports:handle', 'abuse:read', 'alerts:read'],
  support: ['stats:read', 'users:read', 'rooms:read', 'reports:read', 'abuse:read'],
};
const ALL_PERMISSIONS = [
  'stats:read', 'users:read', 'users:read-email', 'users:suspend', 'rooms:read', 'rooms:suspend', 'reports:read', 'reports:handle',
  'abuse:read', 'alerts:read', 'settings:read', 'settings:write', 'audit:read', 'admins:manage',
];
const ROLES = Object.keys(ROLE_PERMISSIONS);

function can(role, permission) {
  const list = ROLE_PERMISSIONS[role];
  if (!list || !ALL_PERMISSIONS.includes(permission)) return false; // unknown role or permission: deny
  return list.includes('*') || list.includes(permission);
}
const maskEmail = (email) => {
  if (!String(email).includes('@')) return '***@***'; // not an address: reveal nothing
  const [local = '', domain = ''] = String(email).split('@');
  const dot = domain.lastIndexOf('.');
  const host = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : '';
  return `${local.slice(0, 1)}***@${host.slice(0, 1)}***${tld}`;
};

module.exports = { ROLE_PERMISSIONS, ALL_PERMISSIONS, ROLES, can, maskEmail };
