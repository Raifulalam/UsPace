const jwt = require('jsonwebtoken');
const config = require('../config/env');

const signAccessToken = (user) =>
  jwt.sign({ sub: user.id, role: user.role, tv: user.tokenVersion }, config.JWT_ACCESS_SECRET, {
    algorithm: 'HS256',
    expiresIn: config.ACCESS_TOKEN_TTL,
  });

const verifyAccessToken = (token) =>
  jwt.verify(token, config.JWT_ACCESS_SECRET, { algorithms: ['HS256'] });

module.exports = { signAccessToken, verifyAccessToken };
