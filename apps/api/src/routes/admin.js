const router = require('express').Router();
const { z } = require('zod');
const config = require('../config/env');
const validate = require('../middleware/validate');
const { adminAuthLimiter } = require('../middleware/limiters');
const { authenticateAdmin, requirePermission } = require('../middleware/adminAuth');
const asyncHandler = require('../utils/asyncHandler');
const { zObjectId } = require('../utils/b64');
const { ROLES } = require('../admin/permissions');
const auth = require('../services/adminAuthService');
const svc = require('../services/adminService');
const audit = require('../services/adminAuditService');
const settings = require('../services/settingsService');

const COOKIE = 'art';
const cookieOpts = () => ({ httpOnly: true, secure: config.NODE_ENV === 'production', sameSite: 'strict', path: '/api/v1/admin/auth' }); // never sent to any other path
const ctxOf = (req) => ({ ip: req.ip, userAgent: (req.get('user-agent') || '').slice(0, 200), admin: req.admin });
const idParam = z.object({ id: zObjectId }).strict();
const password = z.string().min(12).refine((p) => Buffer.byteLength(p) <= 72, 'Password too long (max 72 bytes)');
const code = z.string().min(6).max(12);

function sendSession(res, status, { admin, session, ...extra }) {
  res.cookie(COOKIE, session.refreshToken, { ...cookieOpts(), maxAge: 8 * 3600 * 1000 });
  res.status(status).json({ data: { admin, accessToken: session.accessToken, ...extra } });
}

// ---------- sign-in (no session yet) ----------
router.post('/auth/login', adminAuthLimiter, validate(z.object({ email: z.string().email().max(254), password: z.string().min(1).max(200) }).strict()),
  asyncHandler(async (req, res) => res.json({ data: await auth.login(req.body.email, req.body.password, ctxOf(req)) })));
router.post('/auth/mfa', adminAuthLimiter, validate(z.object({ preAuthToken: z.string().min(10).max(2000), code }).strict()),
  asyncHandler(async (req, res) => sendSession(res, 200, await auth.verifyMfa(req.body.preAuthToken, req.body.code, ctxOf(req)))));
router.post('/auth/enroll', adminAuthLimiter, validate(z.object({ preAuthToken: z.string().min(10).max(2000), code }).strict()),
  asyncHandler(async (req, res) => sendSession(res, 200, await auth.enrollMfa(req.body.preAuthToken, req.body.code, ctxOf(req)))));
router.post('/auth/setup', adminAuthLimiter, validate(z.object({ token: z.string().min(10).max(200), password }).strict()),
  asyncHandler(async (req, res) => res.json({ data: await auth.setup(req.body.token, req.body.password, ctxOf(req)) })));
router.post('/auth/refresh', adminAuthLimiter, asyncHandler(async (req, res) => sendSession(res, 200, await auth.refresh(req.cookies?.[COOKIE], ctxOf(req)))));
router.post('/auth/logout', asyncHandler(async (req, res) => {
  await auth.logout(req.cookies?.[COOKIE]);
  res.clearCookie(COOKIE, cookieOpts());
  res.status(204).end();
}));

// ---------- everything below needs a signed-in admin with MFA ----------
router.use(authenticateAdmin);
router.get('/me', (req, res) => res.json({ data: { admin: auth.adminView(req.admin) } }));

const pageQuery = (extra = {}) => z.object({ before: zObjectId.optional(), limit: z.coerce.number().int().min(1).max(100).default(25), ...extra }).strict();
const reason = z.object({ reason: z.string().trim().min(3).max(500) }).strict();
const send = (fn) => asyncHandler(async (req, res) => res.json({ data: await fn(req) }));
const ok = (fn) => asyncHandler(async (req, res) => { await fn(req); res.status(204).end(); });

router.get('/stats', requirePermission('stats:read'), send(() => svc.stats()));
router.get('/alerts', requirePermission('alerts:read'), send(() => svc.alerts()));
router.get('/abuse', requirePermission('abuse:read'), send(() => svc.abuse()));

router.get('/users', requirePermission('users:read'), validate(pageQuery({ q: z.string().max(64).optional(), status: z.enum(['active', 'suspended', 'pending_deletion']).optional() }), 'query'), send((req) => svc.listUsers(ctxOf(req), req.query)));
router.get('/users/:id', requirePermission('users:read'), validate(idParam, 'params'), send((req) => svc.userDetail(ctxOf(req), req.params.id)));
router.post('/users/:id/suspend', requirePermission('users:suspend'), validate(idParam, 'params'), validate(reason), ok((req) => svc.suspendUser(ctxOf(req), req.params.id, req.body.reason)));
router.post('/users/:id/reactivate', requirePermission('users:suspend'), validate(idParam, 'params'), validate(reason), ok((req) => svc.reactivateUser(ctxOf(req), req.params.id, req.body.reason)));

router.get('/rooms', requirePermission('rooms:read'), validate(pageQuery({ q: z.string().max(64).optional(), status: z.enum(['pending', 'active', 'closed', 'suspended']).optional() }), 'query'), send((req) => svc.listRooms(ctxOf(req), req.query)));
router.get('/rooms/:id', requirePermission('rooms:read'), validate(idParam, 'params'), send((req) => svc.roomDetail(ctxOf(req), req.params.id)));
router.post('/rooms/:id/suspend', requirePermission('rooms:suspend'), validate(idParam, 'params'), validate(reason), ok((req) => svc.suspendRoom(ctxOf(req), req.params.id, req.body.reason)));
router.post('/rooms/:id/reactivate', requirePermission('rooms:suspend'), validate(idParam, 'params'), validate(reason), ok((req) => svc.reactivateRoom(ctxOf(req), req.params.id, req.body.reason)));

router.get('/reports', requirePermission('reports:read'), validate(pageQuery({ status: z.enum(['open', 'reviewing', 'actioned', 'dismissed']).optional() }), 'query'), send((req) => svc.listReports(ctxOf(req), req.query)));
router.get('/reports/:id', requirePermission('reports:read'), validate(idParam, 'params'), send((req) => svc.reportDetail(ctxOf(req), req.params.id)));
router.post('/reports/:id/handle', requirePermission('reports:handle'), validate(idParam, 'params'),
  validate(z.object({ status: z.enum(['reviewing', 'actioned', 'dismissed']), resolution: z.string().trim().max(1000).optional() }).strict()), send((req) => svc.handleReport(ctxOf(req), req.params.id, req.body)));

router.get('/settings', requirePermission('settings:read'), send(async () => ({ settings: await settings.get() })));
router.patch('/settings', requirePermission('settings:write'), validate(settings.patchSchema), asyncHandler(async (req, res) => {
  const { settings: after, changes } = await settings.update(req.body, req.admin.email);
  await audit.record({ admin: req.admin, action: 'settings.update', targetType: 'settings', details: { changes }, ip: req.ip });
  res.json({ data: { settings: after } });
}));

router.get('/audit', requirePermission('audit:read'), validate(z.object({ before: z.coerce.number().int().min(1).optional(), limit: z.coerce.number().int().min(1).max(200).default(50), action: z.string().max(60).optional(), admin: z.string().email().optional() }).strict(), 'query'),
  send((req) => audit.list({ action: req.query.action, adminEmail: req.query.admin, before: req.query.before, limit: req.query.limit })));
router.get('/audit/verify', requirePermission('audit:read'), send(() => audit.verify()));

router.get('/admins', requirePermission('admins:manage'), send(async () => ({ admins: await auth.listAdmins() })));
router.post('/admins', requirePermission('admins:manage'), validate(z.object({ email: z.string().email().max(254), role: z.enum(ROLES) }).strict()),
  asyncHandler(async (req, res) => res.status(201).json({ data: await auth.inviteAdmin(req.admin, req.body.email.toLowerCase(), req.body.role, ctxOf(req)) })));
router.post('/admins/:id/:action(disable|enable|reset-mfa)', requirePermission('admins:manage'), validate(z.object({ id: zObjectId, action: z.enum(['disable', 'enable', 'reset-mfa']) }).strict(), 'params'),
  send((req) => auth.changeAdmin(req.admin, req.params.id, req.params.action, ctxOf(req))));
router.post('/admins/:id/role', requirePermission('admins:manage'), validate(idParam, 'params'), validate(z.object({ role: z.enum(ROLES) }).strict()),
  send((req) => auth.setRole(req.admin, req.params.id, req.body.role, ctxOf(req))));

module.exports = router;
