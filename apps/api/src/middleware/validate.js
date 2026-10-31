const AppError = require('../utils/AppError');

// Zod schemas are .strict(): unknown keys (e.g. "role") are rejected, and values must be
// primitives of the declared type, which also blocks NoSQL operator objects like {"$gt": ""}.
const validate = (schema, source = 'body') => (req, res, next) => {
  const r = schema.safeParse(req[source]);
  if (!r.success) {
    return next(
      new AppError(400, 'VALIDATION_ERROR', 'Invalid request', r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })))
    );
  }
  req[source] = r.data;
  next();
};
module.exports = validate;
