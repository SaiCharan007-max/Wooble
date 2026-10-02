import { badRequest } from '../lib/errors.js';

export const formatZod = (error) =>
  error.issues.map((i) => ({ field: i.path.join('.') || '(root)', message: i.message }));

/** Validate req[part] against a zod schema and replace it with the parsed (typed, trimmed) value. */
export const validate = (schema, part = 'body') => (req, _res, next) => {
  const result = schema.safeParse(req[part]);
  if (!result.success) return next(badRequest('Invalid request', formatZod(result.error)));
  req[part] = result.data;
  next();
};
