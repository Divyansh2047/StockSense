import type { CookieOptions, NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { one, pool } from '../db/pool.js';
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

export const USER_COLUMNS = `id, login_id AS "loginId", email, name, role, token_version AS "tokenVersion", created_at AS "createdAt"`;

export async function loadUser(id: number): Promise<SessionUser | undefined> {
  return one<SessionUser>(pool, `SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [id]);
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
    next();
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
  return { id: u.id, loginId: u.loginId, email: u.email, name: u.name, role: u.role, createdAt: u.createdAt };
}
