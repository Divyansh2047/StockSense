import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { PASSWORD, app, resetDb, signup } from './helpers.js';

beforeEach(resetDb);
afterAll(() => pool.end());

const body = (over: Record<string, string> = {}) => ({
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
  ])('rejects %s', async (_label, over, field) => {
    const res = await request(app).post('/api/auth/signup').send(body(over));
    expect(res.status).toBe(400);
    expect(res.body.error.fields[field]).toBeTruthy();
  });

  it('accepts a login id of exactly 6 and 12 characters', async () => {
    expect((await request(app).post('/api/auth/signup').send(body({ loginId: 'abcdef', email: 'a@x.io' }))).status).toBe(201);
    expect((await request(app).post('/api/auth/signup').send(body({ loginId: 'abcdefghijkl', email: 'b@x.io' }))).status).toBe(201);
  });

  it('makes the first account a manager and later ones staff', async () => {
    const first = await request(app).post('/api/auth/signup').send(body());
    const second = await request(app).post('/api/auth/signup').send(body({ loginId: 'picker01', email: 'p@example.com' }));
    expect(first.body.user.role).toBe('manager');
    expect(second.body.user.role).toBe('staff');
    expect(first.body.user).not.toHaveProperty('passwordHash');
  });

  it('keeps login ids and emails unique, ignoring case', async () => {
    await request(app).post('/api/auth/signup').send(body());
    const dupLogin = await request(app).post('/api/auth/signup').send(body({ loginId: 'RIYA_D01', email: 'other@example.com' }));
    expect(dupLogin.status).toBe(409);
    expect(dupLogin.body.error.fields.loginId).toMatch(/taken/);
    const dupEmail = await request(app).post('/api/auth/signup').send(body({ loginId: 'another1', email: 'RIYA@example.com' }));
    expect(dupEmail.status).toBe(409);
    expect(dupEmail.body.error.fields.email).toMatch(/already exists/);
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

describe('OTP password reset', () => {
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

describe('request hardening', () => {
  it('blocks cross-site writes and non-JSON bodies', async () => {
    const agent = await signup('manager1');
    const cross = await agent.post('/api/partners').set('Origin', 'https://evil.example').send({ name: 'X' });
    expect(cross.status).toBe(403);
    const form = await agent.post('/api/partners').type('form').send('name=X');
    expect(form.status).toBe(403);
  });

  it('keeps settings for managers only', async () => {
    await signup('manager1');
    const staff = await signup('picker01');
    const res = await staff.post('/api/warehouses').send({ name: 'Side', shortCode: 'SD' });
    expect(res.status).toBe(403);
  });
});
