import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { PASSWORD, app, invite, resetDb, signup } from './helpers.js';

beforeEach(resetDb);
afterAll(() => pool.end());

const body = (over: Record<string, string> = {}) => ({
  companyName: 'Desai Traders',
  loginId: 'riya_d01',
  email: 'riya@example.com',
  password: PASSWORD,
  confirmPassword: PASSWORD,
  ...over,
});

describe('sign up rules from the brief', () => {
  it.each([
    ['login id shorter than 6', { loginId: 'abcde' }, 'loginId'],
    ['login id longer than 12', { loginId: 'abcdefghijklm' }, 'loginId'],
    ['password of 8 characters', { password: 'Abcdef!1', confirmPassword: 'Abcdef!1' }, 'password'],
    ['password without uppercase', { password: 'abcdefgh!1', confirmPassword: 'abcdefgh!1' }, 'password'],
    ['password without lowercase', { password: 'ABCDEFGH!1', confirmPassword: 'ABCDEFGH!1' }, 'password'],
    ['password without special character', { password: 'Abcdefgh12', confirmPassword: 'Abcdefgh12' }, 'password'],
    ['passwords that do not match', { confirmPassword: 'Different!1' }, 'confirmPassword'],
    ['invalid email', { email: 'not-an-email' }, 'email'],
    ['missing company name', { companyName: '' }, 'companyName'],
  ])('rejects %s', async (_label, over, field) => {
    const res = await request(app).post('/api/auth/signup').send(body(over));
    expect(res.status).toBe(400);
    expect(res.body.error.fields[field]).toBeTruthy();
  });

  it('accepts a login id of exactly 6 and 12 characters', async () => {
    expect((await request(app).post('/api/auth/signup').send(body({ loginId: 'abcdef', email: 'a@x.io' }))).status).toBe(201);
    expect((await request(app).post('/api/auth/signup').send(body({ loginId: 'abcdefghijkl', email: 'b@x.io' }))).status).toBe(201);
  });

  it('gives every sign-up its own company with the new user as manager', async () => {
    const a = await signup('owner_a1', 'a@example.com', 'Alpha Stores');
    const b = await signup('owner_b1', 'b@example.com', 'Beta Stores');
    const me = (await a.get('/api/auth/me')).body.user;
    const other = (await b.get('/api/auth/me')).body.user;
    expect(me.role).toBe('manager');
    expect(other.role).toBe('manager');
    expect(me.company.name).toBe('Alpha Stores');
    expect(other.company.id).not.toBe(me.company.id);
    expect(me).not.toHaveProperty('passwordHash');
  });

  it('keeps login ids and emails unique across all companies, ignoring case', async () => {
    await request(app).post('/api/auth/signup').send(body());
    const dupLogin = await request(app).post('/api/auth/signup').send(body({ loginId: 'RIYA_D01', email: 'other@example.com' }));
    expect(dupLogin.status).toBe(409);
    expect(dupLogin.body.error.fields.loginId).toMatch(/taken/);
    const dupEmail = await request(app).post('/api/auth/signup').send(body({ loginId: 'another1', email: 'RIYA@example.com' }));
    expect(dupEmail.status).toBe(409);
    expect(dupEmail.body.error.fields.email).toMatch(/already exists/);
  });
});

describe('email verification', () => {
  it('does not sign in until the email is confirmed, then accepts the code', async () => {
    const created = await request(app).post('/api/auth/signup').send(body());
    expect(created.status).toBe(201);
    expect(created.headers['set-cookie']).toBeUndefined();
    expect(created.body.verification.masked).toBe('r**a@example.com');

    const blocked = await request(app).post('/api/auth/login').send({ loginId: 'riya_d01', password: PASSWORD });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('email_unverified');
    // inside the one-minute cooldown no second email goes out
    expect(blocked.body.error.devCode).toBeUndefined();

    const agent = request.agent(app);
    const ok = await agent.post('/api/auth/verify-email').send({ email: 'riya@example.com', code: created.body.devCode });
    expect(ok.status).toBe(200);
    expect(ok.body.user.emailVerified).toBe(true);
    expect((await agent.get('/api/auth/me')).status).toBe(200);
    expect((await request(app).post('/api/auth/login').send({ loginId: 'riya_d01', password: PASSWORD })).status).toBe(200);
  });

  it('does not reveal an unverified account to a wrong password', async () => {
    await request(app).post('/api/auth/signup').send(body());
    const res = await request(app).post('/api/auth/login').send({ loginId: 'riya_d01', password: 'Wrong!pass1' });
    expect(res.status).toBe(401);
  });

  it('confirms through the emailed link once', async () => {
    const created = await request(app).post('/api/auth/signup').send(body());
    const token = new URL(created.body.devLink).searchParams.get('token');
    const agent = request.agent(app);
    expect((await agent.post('/api/auth/verify-email/link').send({ token })).status).toBe(200);
    expect((await agent.get('/api/auth/me')).body.user.emailVerified).toBe(true);
    expect((await request(app).post('/api/auth/verify-email/link').send({ token })).status).toBe(400);
  });

  it('locks a verification code after five wrong tries', async () => {
    const created = await request(app).post('/api/auth/signup').send(body());
    const wrong = created.body.devCode === '123456' ? '654321' : '123456';
    for (let i = 0; i < 5; i++) await request(app).post('/api/auth/verify-email').send({ email: 'riya@example.com', code: wrong });
    const right = await request(app).post('/api/auth/verify-email').send({ email: 'riya@example.com', code: created.body.devCode });
    expect(right.status).toBe(400);
  });

  it('answers resend requests the same way for unknown emails', async () => {
    const res = await request(app).post('/api/auth/resend-verification').send({ email: 'ghost@example.com' });
    expect(res.status).toBe(200);
    expect(res.body.devCode).toBeUndefined();
  });
});

describe('sign in', () => {
  it('uses one message for a wrong password and an unknown login id', async () => {
    await signup('manager1');
    const wrong = await request(app).post('/api/auth/login').send({ loginId: 'manager1', password: 'Wrong!pass1' });
    const unknown = await request(app).post('/api/auth/login').send({ loginId: 'nobody99', password: PASSWORD });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.message).toBe('Invalid Login Id or Password');
    expect(unknown.body.error.message).toBe('Invalid Login Id or Password');
  });

  it('sets an httpOnly session cookie and signs out cleanly', async () => {
    await signup('manager1');
    const agent = request.agent(app);
    const res = await agent.post('/api/auth/login').send({ loginId: 'MANAGER1', password: PASSWORD });
    expect(res.status).toBe(200);
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/ss_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect((await agent.get('/api/auth/me')).body.user.loginId).toBe('manager1');
    await agent.post('/api/auth/logout');
    expect((await agent.get('/api/auth/me')).status).toBe(401);
  });

  it('rejects API calls without a session', async () => {
    expect((await request(app).get('/api/dashboard')).status).toBe(401);
    expect((await request(app).get('/api/operations')).status).toBe(401);
  });
});

describe('password reset', () => {
  it('resets the password with a valid code and ends old sessions', async () => {
    const oldSession = await signup('manager1', 'owner@example.com');
    const forgot = await request(app).post('/api/auth/forgot-password').send({ email: 'OWNER@example.com' });
    expect(forgot.status).toBe(200);
    expect(forgot.body.devOtp).toMatch(/^\d{6}$/);

    const wrongCode = forgot.body.devOtp === '000000' ? '111111' : '000000';
    const bad = await request(app).post('/api/auth/verify-otp').send({ email: 'owner@example.com', otp: wrongCode });
    expect(bad.status).toBe(400);

    const ok = await request(app).post('/api/auth/verify-otp').send({ email: 'owner@example.com', otp: forgot.body.devOtp });
    expect(ok.status).toBe(200);
    const next = 'Brand-new!pw9';
    const reset = await request(app)
      .post('/api/auth/reset-password')
      .send({ resetToken: ok.body.resetToken, password: next, confirmPassword: next });
    expect(reset.status).toBe(200);

    expect((await oldSession.get('/api/auth/me')).status).toBe(401);
    expect((await request(app).post('/api/auth/login').send({ loginId: 'manager1', password: PASSWORD })).status).toBe(401);
    expect((await request(app).post('/api/auth/login').send({ loginId: 'manager1', password: next })).status).toBe(200);

    // a used reset token cannot be replayed
    const replay = await request(app)
      .post('/api/auth/reset-password')
      .send({ resetToken: ok.body.resetToken, password: 'Another!pw9', confirmPassword: 'Another!pw9' });
    expect(replay.status).toBe(400);
  });

  it('answers the same way for unknown emails and never leaks a code', async () => {
    const res = await request(app).post('/api/auth/forgot-password').send({ email: 'ghost@example.com' });
    expect(res.status).toBe(200);
    expect(res.body.devOtp).toBeUndefined();
    expect(res.body.message).toMatch(/If an account exists/);
  });

  it('locks a code after five wrong attempts', async () => {
    await signup('manager1', 'owner@example.com');
    const forgot = await request(app).post('/api/auth/forgot-password').send({ email: 'owner@example.com' });
    const wrong = forgot.body.devOtp === '999999' ? '888888' : '999999';
    for (let i = 0; i < 5; i++) {
      await request(app).post('/api/auth/verify-otp').send({ email: 'owner@example.com', otp: wrong });
    }
    const right = await request(app).post('/api/auth/verify-otp').send({ email: 'owner@example.com', otp: forgot.body.devOtp });
    expect(right.status).toBe(400);
  });
});

describe('teams and invitations', () => {
  it('lets a manager invite staff into the same company', async () => {
    const manager = await signup('manager1');
    await manager.post('/api/products').send({ name: 'Desk', sku: 'DESK1' });
    const staff = await invite(manager, 'picker01');
    const me = (await staff.get('/api/auth/me')).body.user;
    expect(me.role).toBe('staff');
    expect(me.emailVerified).toBe(true);
    expect((await staff.get('/api/products')).body.items.map((p: { sku: string }) => p.sku)).toEqual(['DESK1']);
    const team = (await manager.get('/api/users')).body.items;
    expect(team).toHaveLength(2);
  });

  it('shows who an invitation link is for, and the link works once', async () => {
    const manager = await signup('manager1');
    const res = await manager.post('/api/users').send({ loginId: 'picker02', name: 'Riya', email: 'riya@example.com' });
    const token = new URL(res.body.devLink).searchParams.get('token');
    const info = await request(app).post('/api/auth/reset-link').send({ token });
    expect(info.body).toMatchObject({ loginId: 'picker02', companyName: 'manager1 Co', invited: true, masked: 'r**a@example.com' });
    expect((await request(app).post('/api/auth/reset-password').send({ token, password: PASSWORD, confirmPassword: PASSWORD })).status).toBe(200);
    expect((await request(app).post('/api/auth/reset-link').send({ token })).status).toBe(400);
  });

  it('keeps settings for managers only', async () => {
    const manager = await signup('manager1');
    const staff = await invite(manager, 'picker01');
    expect((await staff.post('/api/warehouses').send({ name: 'Side', shortCode: 'SD' })).status).toBe(403);
    expect((await staff.post('/api/users').send({ loginId: 'sneaky1', name: 'S', email: 's@example.com' })).status).toBe(403);
  });
});

describe('tenant isolation', () => {
  it('never shows or accepts another company’s records', async () => {
    const alpha = await signup('alpha_01');
    const beta = await signup('beta_001');
    const wh = await alpha.post('/api/warehouses').send({ name: 'Alpha WH', shortCode: 'WH' });
    const product = await alpha.post('/api/products').send({ name: 'Secret widget', sku: 'SECRET1' });
    expect(product.status).toBe(201);

    // same codes are fine in another company
    expect((await beta.post('/api/warehouses').send({ name: 'Beta WH', shortCode: 'WH' })).status).toBe(201);
    expect((await beta.post('/api/products').send({ name: 'Widget', sku: 'SECRET1' })).status).toBe(201);

    expect((await beta.get('/api/products')).body.items.map((p: { name: string }) => p.name)).toEqual(['Widget']);
    expect((await beta.get(`/api/products/${product.body.id}`)).status).toBe(404);
    expect((await beta.get('/api/warehouses')).body.items).toHaveLength(1);
    expect((await beta.get('/api/users')).body.items).toHaveLength(1);

    // guessing ids does not help
    const betaLocs = (await beta.get('/api/locations')).body.items;
    const betaStock = betaLocs.find((l: { shortCode: string }) => l.shortCode === 'Stock');
    const sneaky = await beta.post('/api/operations').send({ type: 'receipt', destLocationId: betaStock.id, lines: [{ productId: product.body.id, quantity: 1 }] });
    expect(sneaky.status).toBeGreaterThanOrEqual(400);
    expect(sneaky.status).toBeLessThan(500);
    const alphaLocs = (await alpha.get('/api/locations')).body.items;
    const alphaStock = alphaLocs.find((l: { shortCode: string; warehouseId: number }) => l.warehouseId === wh.body.id);
    const intoAlpha = await beta.put('/api/stock').send({ productId: product.body.id, locationId: alphaStock.id, quantity: 5 });
    expect(intoAlpha.status).toBeGreaterThanOrEqual(400);
    expect(intoAlpha.status).toBeLessThan(500);
    expect((await alpha.get('/api/stock')).body.items[0].onHand).toBe(0);
  });
});

describe('demo sandbox', () => {
  it('creates a private, filled-in company in one call', async () => {
    const a = request.agent(app);
    const b = request.agent(app);
    const first = await a.post('/api/auth/demo').send({});
    expect(first.status).toBe(201);
    expect(first.body.user.company.sandbox).toBe(true);
    await b.post('/api/auth/demo').send({});
    const productsA = (await a.get('/api/products')).body.items;
    expect(productsA.length).toBeGreaterThan(5);
    const dash = (await a.get('/api/dashboard')).body;
    expect(dash).toBeTruthy();
    // changes in one sandbox never reach the other
    await a.post('/api/products').send({ name: 'Only in A', sku: 'ONLYA' });
    const namesB = (await b.get('/api/products')).body.items.map((p: { name: string }) => p.name);
    expect(namesB).not.toContain('Only in A');
  });
});

describe('request hardening', () => {
  it('blocks cross-site writes and non-JSON bodies', async () => {
    const agent = await signup('manager1');
    const cross = await agent.post('/api/partners').set('Origin', 'https://evil.example').send({ name: 'X' });
    expect(cross.status).toBe(403);
    const form = await agent.post('/api/partners').type('form').send('name=X');
    expect(form.status).toBe(403);
  });
});
