import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z, type ZodTypeAny } from 'zod';

/** Wrap an async handler so rejected promises reach the error middleware. */
export const h =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

export const parse = <S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> => schema.parse(data);

export const idParam = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const optionalId = z.coerce.number().int().positive().optional();
/** Query-string friendly optional id: '' and 'all' mean "no filter". */
export const filterId = z
  .union([z.literal(''), z.literal('all'), z.coerce.number().int().positive()])
  .optional()
  .transform((v) => (typeof v === 'number' ? v : undefined));

export const qty = z.coerce
  .number({ invalid_type_error: 'Enter a number' })
  .finite()
  .min(0, 'Must be zero or more')
  .max(1e10, 'That number is too large')
  .transform((v) => Math.round(v * 1000) / 1000);

export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-09-30')
  .refine((s) => !Number.isNaN(Date.parse(s)), 'Not a real date');

export const trimmed = (max: number) => z.string().trim().max(max);
