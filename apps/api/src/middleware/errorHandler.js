const AppError = require('../utils/AppError');

const notFound = (req, res, next) => next(new AppError(404, 'NOT_FOUND', 'Route not found'));

// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, next) => {
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'BAD_JSON', message: 'Malformed JSON body' } });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large' } });
  }
  if (err.name === 'CastError') {
    return res.status(400).json({ error: { code: 'BAD_ID', message: 'Invalid identifier' } });
  }
  console.error(err); // TODO Phase 8: structured logger + error reporting
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong' } });
};
module.exports = { notFound, errorHandler };
