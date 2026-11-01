const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
const isProd = process.env.NODE_ENV === 'production';

// NOTE: 'unsafe-inline' scripts are required by Next's inline bootstrap unless nonces are wired up.
// That weakens XSS protection, which matters because E2EE keys live in the page. Moving to nonce-based CSP is on the hardening list.
const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  `connect-src 'self' ${API} ${API.replace(/^http/, 'ws')}`,
  "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'", "object-src 'none'",
].join('; ');

export default {
  reactStrictMode: true,
  transpilePackages: ['@couples/crypto', '@couples/canvas-core', '@couples/media-core'],
  webpack(config, { isServer }) {
    if (!isServer) config.resolve.fallback = { ...config.resolve.fallback, fs: false, path: false, crypto: false };
    return config;
  },
  async headers() {
    return [{
      source: '/(.*)',
      headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'Referrer-Policy', value: 'no-referrer' },
        ...(isProd ? [{ key: 'Content-Security-Policy', value: csp }] : []),
      ],
    }];
  },
};
