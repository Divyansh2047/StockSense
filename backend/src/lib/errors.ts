import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { logger } from './logger.js';

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly fields?: Record<string, string>,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, fields?: Record<string, string>) => new HttpError(400, 'bad_request', message, fields);
export const unauthorized = (message = 'Please sign in to continue.') => new HttpError(401, 'unauthorized', message);
export const forbidden = (message = 'You do not have permission to do that.') => new HttpError(403, 'forbidden', message);
export const notFound = (what = 'Record') => new HttpError(404, 'not_found', `${what} not found.`);
export const conflict = (message: string, fields?: Record<string, string>) => new HttpError(409, 'conflict', message, fields);

export function zodFields(err: ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of err.issues) {
    const key = issue.path.join('.') || '_';
    if (!fields[key]) fields[key] = issue.message;
  }
  return fields;
}

// PostgreSQL error codes we translate into friendly API errors.
const PG_UNIQUE = '23505';
const PG_FK = '23503';
const PG_CHECK = '23514';

export const notFoundHandler: RequestHandler = (_req, _res, next) => next(notFound('Endpoint'));

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  let status = 500;
  let body: { code: string; message: string; fields?: Record<string, string> } = {
    code: 'internal',
    message: 'Something went wrong on our side. Please try again.',
  };

  if (err instanceof HttpError) {
    status = err.status;
    body = { code: err.code, message: err.message, fields: err.fields };
  } else if (err instanceof ZodError) {
    status = 400;
    body = { code: 'validation', message: 'Please fix the highlighted fields.', fields: zodFields(err) };
  } else if (err?.type === 'entity.parse.failed') {
    status = 400;
    body = { code: 'bad_json', message: 'Request body is not valid JSON.' };
  } else if (err?.type === 'entity.too.large') {
    status = 413;
    body = { code: 'too_large', message: 'Request body is too large.' };
  } else if (err?.code === PG_UNIQUE) {
    status = 409;
    body = { code: 'duplicate', message: 'A record with the same unique value already exists.' };
  } else if (err?.code === PG_FK) {
    status = 409;
    body = { code: 'in_use', message: 'This record is referenced elsewhere and cannot be changed that way.' };
  } else if (err?.code === PG_CHECK) {
    status = 400;
    body = { code: 'invalid', message: 'One of the values is out of the allowed range.' };
  }

  if (status >= 500) logger.error({ err, url: req.originalUrl }, 'Unhandled error');
  res.status(status).json({ error: body });
};
