const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
const isProd = process.env.NODE_ENV === 'production';
const csp = [
  "default-src 'self'", "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data:",
  `connect-src 'self' ${API}`, "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'", "object-src 'none'",
].join('; ');

export default {
  reactStrictMode: true,
  async headers() {
    return [{
      source: '/(.*)',
      headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'Referrer-Policy', value: 'no-referrer' },
        { key: 'Cache-Control', value: 'no-store' }, // admin screens are never cached
        ...(isProd ? [{ key: 'Content-Security-Policy', value: csp }] : []),
      ],
    }];
  },
};
