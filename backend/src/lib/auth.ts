import type { CookieOptions, NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { asCompany, asSystem, one, pool } from '../db/pool.js';
import { forbidden, unauthorized } from './errors.js';

export const SESSION_COOKIE = 'ss_session';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

export type Role = 'manager' | 'staff';
export interface SessionUser {
  id: number;
  loginId: string;
  email: string;
  name: string;
  role: Role;
  tokenVersion: number;
  createdAt: string;
  companyId: number;
  companyName: string;
  sandbox: boolean;
  emailVerified: boolean;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: SessionUser;
  }
}

interface SessionClaims {
  sub: string;
  v: number;
  typ: 'session';
}

export function signSession(user: { id: number; tokenVersion: number }): string {
  const claims: SessionClaims = { sub: String(user.id), v: user.tokenVersion, typ: 'session' };
  return jwt.sign(claims, config.jwtSecret, { expiresIn: SESSION_TTL_SECONDS, algorithm: 'HS256' });
}

const cookieOptions = (): CookieOptions => ({
  httpOnly: true,
  secure: config.secureTransport,
  sameSite: 'lax',
  path: '/',
});

export function setSessionCookie(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE, token, { ...cookieOptions(), maxAge: SESSION_TTL_SECONDS * 1000 });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, cookieOptions());
}

export const USER_COLUMNS = `u.id, u.login_id AS "loginId", u.email, u.name, u.role, u.token_version AS "tokenVersion",
  u.created_at AS "createdAt", u.company_id AS "companyId", co.name AS "companyName", co.is_sandbox AS sandbox,
  (u.email_verified_at IS NOT NULL) AS "emailVerified"`;
export const USER_FROM = 'users u JOIN companies co ON co.id = u.company_id';

/** Looks a user up across companies (the session names the user, not the company). */
export async function loadUser(id: number): Promise<SessionUser | undefined> {
  return asSystem(() => one<SessionUser>(pool, `SELECT ${USER_COLUMNS} FROM ${USER_FROM} WHERE u.id = $1`, [id]));
}

function readToken(req: Request): string | undefined {
  const cookie = req.cookies?.[SESSION_COOKIE] as string | undefined;
  if (cookie) return cookie;
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  return undefined;
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const token = readToken(req);
    if (!token) throw unauthorized();
    let claims: SessionClaims;
    try {
      claims = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] }) as SessionClaims;
    } catch {
      clearSessionCookie(res);
      throw unauthorized('Your session has expired. Please sign in again.');
    }
    if (claims.typ !== 'session') throw unauthorized();
    const user = await loadUser(Number(claims.sub));
    // token_version bumps on password change / reset, which signs out older sessions
    if (!user || user.tokenVersion !== claims.v) {
      clearSessionCookie(res);
      throw unauthorized('Your session has ended. Please sign in again.');
    }
    req.user = user;
    // Everything after this point only sees the user's own company (row-level security).
    asCompany(user.companyId, () => next());
  } catch (err) {
    next(err);
  }
}

export const requireManager = (req: Request, _res: Response, next: NextFunction): void => {
  if (req.user?.role !== 'manager') return next(forbidden('Only inventory managers can change this.'));
  next();
};

export function currentUser(req: Request): SessionUser {
  if (!req.user) throw unauthorized();
  return req.user;
}

export function publicUser(u: SessionUser) {
  return {
    id: u.id,
    loginId: u.loginId,
    email: u.email,
    name: u.name,
    role: u.role,
    createdAt: u.createdAt,
    emailVerified: u.emailVerified,
    company: { id: u.companyId, name: u.companyName, sandbox: u.sandbox },
  };
}
