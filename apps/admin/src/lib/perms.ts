// Mirrors apps/api/src/admin/permissions.js. This only decides what to SHOW; the server enforces every permission itself.
const ROLE_PERMISSIONS: Record<string, string[]> = {
  superadmin: ['*'],
  moderator: ['stats:read', 'users:read', 'users:suspend', 'rooms:read', 'rooms:suspend', 'reports:read', 'reports:handle', 'abuse:read', 'alerts:read'],
  support: ['stats:read', 'users:read', 'rooms:read', 'reports:read', 'abuse:read'],
};
export const can = (role: string, permission: string) => { const l = ROLE_PERMISSIONS[role]; return Boolean(l && (l.includes('*') || l.includes(permission))); };
