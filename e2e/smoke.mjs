/**
 * End-to-end smoke test through the real UI.
 *
 *   npm run db:reset          # fresh demo data (development only)
 *   npm run build && npm start
 *   npx playwright install chromium   # once
 *   npm run e2e
 *
 * BASE_URL defaults to http://localhost:4000. CHROMIUM_PATH points at a custom browser.
 */
import { chromium } from 'playwright';
const BASE = process.env.BASE_URL ?? 'http://localhost:4000';
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const results = [];
const check = (name, ok, extra = '') => { results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`); };
const errs = [];
async function newPage(ctx) {
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  return p;
}

// ---------- sign-up validation and account creation
const c0 = await browser.newContext({ viewport: { width: 1280, height: 860 } });
const s = await newPage(c0);
await s.goto(BASE + '/app/signup');
await s.fill('#su-login', 'abc');
await s.fill('#su-email', 'not-email');
await s.fill('#su-pass', 'weakpass');
await s.fill('#su-pass2', 'nope');
await s.click('button[type=submit]');
const errTexts = await s.locator('.field .error').allTextContents();
check('signup shows field errors for bad input', errTexts.length >= 4, errTexts.join(' | '));
await s.fill('#su-login', 'manager');
await s.fill('#su-email', 'someone@example.com');
await s.fill('#su-pass', 'Str0ng!pass');
await s.fill('#su-pass2', 'Str0ng!pass');
await s.click('button[type=submit]');
await s.waitForTimeout(700);
const dupe = await s.locator('.field .error').allTextContents();
check('duplicate login id rejected by server', dupe.some((t) => /taken/i.test(t)), dupe.join(' | '));
await s.fill('#su-login', 'qa_tester');
await s.click('button[type=submit]');
await s.waitForURL(/\/app\/?$/, { timeout: 10000 }).catch(() => {});
check('new account lands on dashboard', /\/app\/?$/.test(s.url()), s.url());
await c0.close();

// ---------- OTP reset through the UI
const c1 = await browser.newContext({ viewport: { width: 1280, height: 860 } });
const f = await newPage(c1);
await f.goto(BASE + '/app/forgot-password');
await f.fill('#fp-email', 'someone@example.com');
await f.click('button[type=submit]');
await f.waitForSelector('.note-box .mono');
const otp = (await f.locator('.note-box .mono').textContent()).trim();
check('dev OTP shown in development', /^\d{6}$/.test(otp), otp);
await f.locator('.otp__cell').first().click();
await f.keyboard.type(otp);
await f.click('button[type=submit]');
await f.waitForSelector('#fp-pass');
await f.fill('#fp-pass', 'Newer!pass9');
await f.fill('#fp-pass2', 'Newer!pass9');
await f.click('button[type=submit]');
await f.waitForURL(/\/app\/?$/, { timeout: 10000 }).catch(() => {});
check('password reset signs the user in', /\/app\/?$/.test(f.url()), f.url());
await c1.close();

// ---------- manager session A (watcher) and B (worker)
async function login(ctx) {
  const p = await newPage(ctx);
  await p.goto(BASE + '/app/login');
  await p.fill('#loginId', 'manager');
  await p.fill('#password', 'Stock@2026!');
  await p.click('button[type=submit]');
  await p.waitForURL(/\/app\/?$/);
  return p;
}
const A = await login(await browser.newContext({ viewport: { width: 1440, height: 900 } }));
const B = await login(await browser.newContext({ viewport: { width: 1440, height: 900 } }));
await A.waitForSelector('.live-pill[data-state=live]', { timeout: 10000 }).catch(() => {});
check('live connection established', (await A.locator('.live-pill').getAttribute('data-state')) === 'live');
const readyBefore = (await A.locator('.dock[data-type=receipt] .dock__n').textContent()).trim();

// B: create a receipt through the form
await B.goto(BASE + '/app/receipts/new');
await B.waitForSelector('#f-partner');
await B.click('#f-partner');
await B.keyboard.type('Kalinga');
await B.keyboard.press('Enter');
await B.locator('.lines .combo input').first().click();
await B.keyboard.type('HNG045');
await B.keyboard.press('Enter');
await B.locator('.lines .qty-input input').first().fill('75');
await B.getByRole('button', { name: 'To Do' }).click();
await B.waitForSelector('.stepper li.is-current[data-s=ready]', { timeout: 10000 });
const ref = (await B.locator('.opform__ref').textContent()).trim();
check('receipt created and marked To Do', /^WH\/IN\/\d{4}$/.test(ref), ref);
await A.waitForTimeout(1500);
const readyAfter = (await A.locator('.dock[data-type=receipt] .dock__n').textContent()).trim();
check('other session dashboard updated live (to receive count)', Number(readyAfter) === Number(readyBefore) + 1, `${readyBefore} -> ${readyAfter}`);

// stock before validation
const stockBefore = await B.evaluate(async () => (await (await fetch('/api/products?search=HNG045')).json()).items[0].onHand);
await B.getByRole('button', { name: 'Validate' }).click();
await B.waitForSelector('.stepper li.is-current[data-s=done]', { timeout: 10000 });
const stockAfter = await B.evaluate(async () => (await (await fetch('/api/products?search=HNG045')).json()).items[0].onHand);
check('validating the receipt adds stock', stockAfter === stockBefore + 75, `${stockBefore} -> ${stockAfter}`);
check('print is offered once done', await B.getByRole('link', { name: 'Print' }).first().isVisible());

// the waiting chairs order becomes ready when today's chair receipt is validated
const waiting = await B.evaluate(async () => (await (await fetch('/api/operations?type=delivery&status=waiting')).json()).items[0]);
const chairReceipt = await B.evaluate(async () => (await (await fetch('/api/operations?type=receipt&search=CHR004&status=ready')).json()).items[0]);
await B.goto(`${BASE}/app/receipts/${chairReceipt.id}`);
await B.getByRole('button', { name: 'Validate' }).click();
await B.waitForSelector('.stepper li.is-current[data-s=done]');
await B.waitForTimeout(600);
const toastText = (await B.locator('.toast').allTextContents()).join(' | ');
const after = await B.evaluate(async (id) => (await (await fetch('/api/operations/' + id)).json()).status, waiting.id);
check('waiting delivery turned ready automatically', after === 'ready', `${waiting.reference}: ${after}`);
check('user told about the unblocked document', /now ready/i.test(toastText), toastText.slice(0, 120));

// deliver it
await B.goto(`${BASE}/app/deliveries/${waiting.id}`);
await B.getByRole('button', { name: 'Validate' }).click();
await B.waitForSelector('.stepper li.is-current[data-s=done]');
check('delivery validated', true, waiting.reference);

// stock page inline update posts an adjustment
await B.goto(BASE + '/app/stock?q=GLU007');
await B.locator('tbody tr.is-link').first().click();
await B.locator('.locqty__value').first().click();
await B.locator('.locqty__form input').first().fill('13');
await B.keyboard.press('Enter');
await B.waitForTimeout(900);
const adj = await B.evaluate(async () => (await (await fetch('/api/moves?kind=adjustment&search=GLU007')).json()).items[0]);
check('stock page edit creates a ledger adjustment', adj && /ADJ/.test(adj.reference), adj ? `${adj.reference} ${adj.direction} ${adj.quantity}` : 'none');

// kanban drag: draft receipt -> ready
await B.goto(BASE + '/app/receipts?view=kanban');
await B.waitForSelector('.kanban__col');
const draftCard = B.locator('.kanban__col').nth(0).locator('.kcard').first();
const draftRef = (await draftCard.locator('.kcard__ref').textContent()).trim();
await draftCard.dragTo(B.locator('.kanban__col').nth(1));
await B.waitForTimeout(1200);
const draftStatus = await B.evaluate(async (r) => (await (await fetch('/api/operations?search=' + encodeURIComponent(r))).json()).items[0].status, draftRef);
check('kanban drag draft -> ready confirms the receipt', draftStatus === 'ready', `${draftRef}: ${draftStatus}`);

// command palette finds a SKU
await B.keyboard.press('Control+k');
await B.keyboard.type('STL010');
await B.waitForTimeout(700);
const pal = (await B.locator('.palette__item').allTextContents()).join(' | ');
check('command palette finds a SKU', /STL010/.test(pal), pal.slice(0, 100));
await B.keyboard.press('Escape');

console.log(results.join('\n'));
// the duplicate-signup check expects one 409 from the API
const unexpected = errs.filter((e) => !/401|Unauthorized|409/.test(e));
if (unexpected.length) console.log('page errors:', JSON.stringify(unexpected, null, 1));
await browser.close();
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed || unexpected.length ? 1 : 0);
