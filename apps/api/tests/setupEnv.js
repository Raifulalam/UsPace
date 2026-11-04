process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = 'mongodb://placeholder';
process.env.JWT_ACCESS_SECRET = 'test-secret-test-secret-test-secret-123456';
process.env.CLIENT_ORIGIN = 'http://localhost:3000';
process.env.BCRYPT_COST = '4';
process.env.MEDIA_DIR = require('path').join(require('os').tmpdir(), `couples-test-media-${process.pid}`);
process.env.ADMIN_JWT_SECRET = 'admin-test-secret-admin-test-secret-123456';
process.env.ADMIN_MFA_KEY = 'admin-mfa-key-admin-mfa-key-1234567890';
