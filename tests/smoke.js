#!/usr/bin/env node
'use strict';
/* smoke.js — ทดสอบระบบจริงแบบครบวงจร (รัน: npm test)
   สตาร์ทเซิร์ฟเวอร์ด้วยฐานข้อมูลชั่วคราว → สมัคร → ยืนยันอีเมล → เข้าสู่ระบบ → สร้างสินค้า/พนักงาน/บิลขาย
   → รีสตาร์ทเซิร์ฟเวอร์แล้วข้อมูลยังอยู่ → ระงับบัญชี (402) → แจ้งชำระเงิน → แอดมินอนุมัติ → ใบกำกับภาษี → ส่งออก/กู้คืนข้อมูล */
const { spawn } = require('child_process');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 3900 + Math.floor(Math.random() * 100);
const S = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ac711-test-'));
const ENV = { ...process.env, PORT: String(PORT), DATA_DIR, JWT_SECRET: 'smoke-test-secret', ADMIN_PASSWORD: 'admin711', BASE_URL: S, SAVE_DELAY_MS: '100' };
let proc = null; let passed = 0;

const start = () => new Promise((res, rej) => {
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; proc.stdout.on('data', d => { out += d; if (/Cloud: http/.test(out)) res(); }); proc.stderr.on('data', d => { const s = String(d); if (!/ExperimentalWarning|trace-warnings/.test(s)) process.stderr.write(s); });
  proc.on('exit', c => { if (c) rej(new Error('server exited ' + c)); });
  setTimeout(() => rej(new Error('server start timeout')), 20000);
});
const stop = () => new Promise(res => { if (!proc) return res(); proc.once('exit', () => res()); proc.kill('SIGTERM'); });
const api = async (method, p, body, token) => { const r = await fetch(S + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined }); const d = await r.json().catch(() => ({})); return { status: r.status, d }; };
const jwtTid = t => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString()).tid;
const ok = (name, cond, extra = '') => { assert.ok(cond, name + (extra ? ' — ' + extra : '')); passed++; console.log('  ✔', name); };

(async () => {
  try {
    await start(); console.log('server up on', S);
    ok('health', (await api('GET', '/health')).d.ok);
    ok('website content', typeof (await api('GET', '/api/platform/site')).d.brand === 'string' && (await api('GET', '/api/platform/site')).d.brand.length > 0);
    // demo
    const demo = await api('POST', '/api/ac711/auth/login', { username: 'owner', password: 'ac1234' }); ok('demo login owner/ac1234', demo.status === 200 && demo.d.user.role === 'owner');
    ok('demo has products', (await api('GET', '/api/ac711/products', null, demo.d.token)).d.length > 50);
    ok('demo is read-only for destructive actions', (await api('POST', '/api/ac711/settings/reset-demo', { scope: 'all' }, demo.d.token)).status === 403 && (await api('POST', '/api/ac711/staff', { username: 'x', password: 'x', name: 'x', role: 'pos', branch_id: 1 }, demo.d.token)).status === 403 && (await api('PUT', '/api/ac711/auth/password', { old_password: 'ac1234', new_password: 'hacked1' }, demo.d.token)).status === 403);
    ok('demo can still sell', (await api('POST', '/api/ac711/sales', { branch_id: 1, items: [{ product_id: (await api('GET', '/api/ac711/products', null, demo.d.token)).d.find(p => p.sku === '711-COMP-001').id, qty: 1 }], payment_method: 'cash', paid: 99999 }, demo.d.token)).status === 200);
    // signup
    const email = `smoke${Date.now()}@example.com`;
    const su = await api('POST', '/api/platform/signup', { form: { email, name: 'ผู้ทดสอบ', company: 'ร้านทดสอบอัตโนมัติ', phone: '0812345678', province: 'กรุงเทพ', branches: 2, biz: 'ร้านอะไหล่รถยนต์' }, consent: { terms: true, marketing: false, privacy_version: '1.0' } });
    ok('signup returns mail preview (no SMTP)', su.status === 200 && su.d.mail_preview && su.d.mail_preview.data.password, JSON.stringify(su.d).slice(0, 200));
    const pw = su.d.mail_preview.data.password; const vt = su.d.mail_preview.data.url.split('t=')[1];
    ok('login before verify is rejected', (await api('POST', '/api/ac711/auth/login', { username: email, password: pw })).status !== 200);
    const ve = await api('POST', '/api/platform/verify', { t: vt }); ok('verify email', ve.status === 200 && /^S\d{4}$/.test(ve.d.code)); const code = ve.d.code;
    ok('verify token single-use', (await api('POST', '/api/platform/verify', { t: vt })).status === 400);
    const lg = await api('POST', '/api/ac711/auth/login', { username: email, password: pw }); ok('login new tenant', lg.status === 200 && lg.d.user.plan.status === 'trial' && lg.d.user.tenant_code === code);
    const tk = lg.d.token;
    const br = (await api('GET', '/api/ac711/branches', null, tk)).d; ok('fresh tenant: HQ + 1 branch + online', br.length === 3 && br[0].code === '0000');
    ok('fresh tenant has no products', (await api('GET', '/api/ac711/products', null, tk)).d.length === 0);
    ok('fresh tenant forecast works', (await api('GET', '/api/ac711/forecast/top?limit=5', null, tk)).status === 200);
    ok('cannot see demo data across tenants', (await api('GET', '/api/ac711/sales?limit=5', null, tk)).d.length === 0);
    // product + stock + sale (partial)
    const pr = await api('POST', '/api/ac711/products', { sku: 'T-001', name: 'ไส้กรองน้ำมัน', price_retail: 150, cost: 100, category_id: 1, unit: 'ชิ้น' }, tk); ok('create product', pr.status === 200, JSON.stringify(pr.d));
    const pid = pr.d.id;
    const gr = await api('POST', '/api/ac711/stock/receive', { branch_id: 1, items: [{ product_id: pid, qty: 10, cost: 100 }] }, tk); ok('receive stock creates GR awaiting approval', gr.status === 200 && gr.d.code.startsWith('GR') && (await api('GET', '/api/ac711/approvals/mine', null, tk)).d.some(a => a.status === 'pending'), JSON.stringify(gr.d));
    const op = await api('POST', '/api/ac711/import/stock-opening', { sku: 'T-001', branch_code: '0000', qty: 10, unit_cost: 100 }, tk); ok('opening stock import', op.status === 200, JSON.stringify(op.d));
    ok('opening AR/AP imports', (await api('POST', '/api/ac711/import/ar-opening', { customer_name: 'ลูกค้ายกมา', doc_no: 'OLD-1', amount: 1000 }, tk)).status === 200 && (await api('POST', '/api/ac711/import/ap-opening', { supplier_name: 'ไม่มีในระบบ', amount: 5 }, tk)).status === 400);
    const sl = await api('POST', '/api/ac711/sales', { branch_id: 1, items: [{ product_id: pid, qty: 2, price: 150 }], payment_method: 'cash', paid: 100, partial: true, customer_name: 'ลูกค้า', phone: '0899999999' }, tk);
    ok('partial sale creates balance', sl.status === 200 && sl.d.status === 'partial' && sl.d.balance === 200, JSON.stringify(sl.d));
    const rc = await api('POST', `/api/ac711/sales/${sl.d.id}/receive`, { amount: 200, method: 'cash' }, tk); ok('receive remaining → paid', rc.status === 200 && rc.d.status === 'paid' && rc.d.balance === 0, JSON.stringify(rc.d));
    const st = await api('POST', '/api/ac711/staff', { username: 'pos1', password: 'pass1234', name: 'พนักงานขาย', role: 'cashier', branch_id: 2, pin: '1111' }, tk); ok('create staff', st.status === 200, JSON.stringify(st.d));
    ok('staff login with tenant code', (await api('POST', '/api/ac711/auth/login', { username: 'pos1', password: 'pass1234', tenant: code })).status === 200);
    ok('staff list hides password and PIN', (await api('GET', '/api/ac711/staff', null, tk)).d.every(s => s.password === undefined && s.pin === undefined));
    // อู่ซ่อมรถ: ทะเบียนรถ ใบเสนอราคา/ใบรับรถ ออกบิลพร้อมค่าแรง CRM อัตโนมัติ
    const jq = await api('POST', '/api/ac711/jobs', { branch_id: 1, new_customer: { name: 'ลูกค้าอู่', phone: '0877777777' }, new_vehicle: { plate: 'ทส 1234', brand: 'Toyota', model: 'Vios' }, mileage_in: 40000, symptoms: 'แอร์ไม่เย็น', items: [{ kind: 'part', product_id: pid, qty: 1, price: 150 }, { kind: 'labor', name: 'ค่าแรงล้างตู้แอร์', qty: 1, price: 1200 }], warranty_terms: 'รับประกัน 6 เดือน', next_service_date: '2027-06-01', next_service_km: 50000 }, tk);
    ok('garage: create quote with new customer + vehicle + labor line', jq.status === 200 && /^QT/.test(jq.d.code) && jq.d.total === 1350, JSON.stringify(jq.d));
    ok('garage: vehicle registered under customer', (await api('GET', '/api/ac711/vehicles?q=' + encodeURIComponent('ทส'), null, tk)).d.some(v => v.plate === 'ทส 1234' && v.customer_name === 'ลูกค้าอู่'));
    ok('garage: invalid status transition rejected', (await api('POST', `/api/ac711/jobs/${jq.d.id}/status`, { status: 'ready' }, tk)).status === 400);
    const rcv = await api('POST', `/api/ac711/jobs/${jq.d.id}/status`, { status: 'received', mileage_in: 40100 }, tk); ok('garage: receive vehicle issues JO code', rcv.status === 200 && /^JO/.test(rcv.d.job_code));
    const qBefore = (await api('GET', '/api/ac711/products?branch_id=1&q=T-001', null, tk)).d[0].qty;
    const bill = await api('POST', `/api/ac711/jobs/${jq.d.id}/bill`, { payment_method: 'cash', paid: 2000 }, tk); const qAfter = (await api('GET', '/api/ac711/products?branch_id=1&q=T-001', null, tk)).d[0].qty;
    ok('garage: bill job → sale, part issued from stock, labor not stocked', bill.status === 200 && bill.d.total === 1350 && qAfter === qBefore - 1, JSON.stringify(bill.d));
    const jsale = (await api('GET', '/api/ac711/sales/' + bill.d.id, null, tk)).d; ok('garage: receipt carries warranty + next service + labor line', !!jsale.job && jsale.job.warranty_terms === 'รับประกัน 6 เดือน' && jsale.job.next_service_date === '2027-06-01' && jsale.items.some(i => i.kind === 'labor' && i.product_id === null));
    const auto = (await api('GET', '/api/ac711/crm/tasks?status=open&customer_id=' + jsale.customer_id, null, tk)).d; ok('CRM: auto follow-up + service reminder created on billing', auto.some(t => t.type === 'followup' && t.auto) && auto.some(t => t.type === 'reminder' && t.auto), JSON.stringify(auto.map(t => t.type)));
    ok('garage: job locked after billing except warranty/next-service terms', (await api('PUT', `/api/ac711/jobs/${jq.d.id}`, { symptoms: 'x' }, tk)).status === 400 && (await api('PUT', `/api/ac711/jobs/${jq.d.id}/terms`, { next_service_km: 55000 }, tk)).status === 200);
    const ct = await api('POST', '/api/ac711/crm', { customer_id: jsale.customer_id, type: 'call', subject: 'โทรตาม', due_at: '2026-12-01' }, tk); const cd = await api('PUT', `/api/ac711/crm/${ct.d.id}`, { done: 1, outcome: 'เรียบร้อย' }, tk);
    ok('CRM: task create/close keeps change log', ct.status === 200 && cd.d.task.done === 1 && (await api('GET', '/api/ac711/crm/' + ct.d.id, null, tk)).d.log.length >= 2);
    ok('CRM: customer 360 timeline + stats', (await api('GET', '/api/ac711/crm/customers/' + jsale.customer_id, null, tk)).d.timeline.length >= 3 && (await api('GET', '/api/ac711/crm/stats', null, tk)).d.open >= 2);
    { const { DatabaseSync } = require('node:sqlite'); const rdb = new DatabaseSync(path.join(DATA_DIR, 'platform.db'), { readOnly: true }); await new Promise(r => setTimeout(r, 400)); const row = rdb.prepare('SELECT json FROM tenant_data WHERE tenant_id = ?').get(lg.d.user ? (jwtTid(tk)) : ''); rdb.close(); const staff = row ? JSON.parse(row.json).staff : []; ok('passwords persisted as bcrypt hashes', staff.length >= 2 && staff.every(s => /^\$2[aby]\$/.test(s.password)), JSON.stringify(staff.map(s => s.password && s.password.slice(0, 4)))); }
    const posTk = (await api('POST', '/api/ac711/auth/login', { username: 'pos1', password: 'pass1234', tenant: code })).d.token;
    ok('non-owner cannot create staff or promote self', (await api('POST', '/api/ac711/staff', { username: 'evil', password: 'evil1234', name: 'x', role: 'owner', branch_id: 1 }, posTk)).status === 403 && (await api('PUT', '/api/ac711/staff/2', { role: 'owner' }, posTk)).status === 403);
    ok('owner cannot be demoted by hq via PUT', (await api('PUT', '/api/ac711/staff/1', { role: 'pos' }, posTk)).status === 403);
    ok('PIN: empty/short pin rejected, default owner pin not set', (await api('POST', '/api/ac711/auth/pin', { username: email, pin: '' }, posTk)).status === 401 && (await api('POST', '/api/ac711/auth/pin', { username: email, pin: '1234' }, posTk)).status === 401);
    ok('non-owner cannot file payment notice or read plan', (await api('POST', '/api/platform/payments', { amount: 1, date: '2026-01-01' }, posTk)).status === 403 && (await api('GET', '/api/platform/me/plan', null, posTk)).status === 403);
    ok('cross-tenant: demo token cannot read this tenant', !(await api('GET', '/api/ac711/staff', null, demo.d.token)).d.some(s => s.username === email));
    { const fd = new FormData(); fd.append('image', new Blob(['<script>alert(1)</script>'], { type: 'image/png' }), 'x.html'); const r = await fetch(S + '/api/ac711/upload', { method: 'POST', headers: { authorization: 'Bearer ' + tk }, body: fd }); const d = await r.json(); ok('upload stores image extension only (no .html)', r.status === 200 && /\.png$/.test(d.url), JSON.stringify(d)); const fd2 = new FormData(); fd2.append('image', new Blob(['<svg/>'], { type: 'image/svg+xml' }), 'x.svg'); ok('svg upload rejected', (await fetch(S + '/api/ac711/upload', { method: 'POST', headers: { authorization: 'Bearer ' + tk }, body: fd2 })).status !== 200); }
    ok('bad JSON body → JSON error', (await fetch(S + '/api/ac711/products', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tk }, body: '{bad' })).headers.get('content-type').includes('json'));
    ok('export all (owner)', Object.keys((await api('GET', '/api/ac711/export/all', null, tk)).d.tables).length > 20);
    const backup = (await api('GET', '/api/ac711/export/all', null, tk)).d;
    // restart → persistence
    await new Promise(r => setTimeout(r, 400)); await stop(); await start();
    const lg2 = await api('POST', '/api/ac711/auth/login', { username: email, password: pw }); ok('login after restart', lg2.status === 200); const tk2 = lg2.d.token;
    ok('data persisted across restart (products, 2 sales, job + vehicle + CRM)', (await api('GET', '/api/ac711/products', null, tk2)).d.length === 1 && (await api('GET', '/api/ac711/sales?limit=5', null, tk2)).d.length === 2 && (await api('GET', '/api/ac711/jobs?status=billed', null, tk2)).d.length === 1 && (await api('GET', '/api/ac711/vehicles', null, tk2)).d.length === 1 && (await api('GET', '/api/ac711/crm/tasks?status=all', null, tk2)).d.length >= 3);
    ok('staff persisted (login with code)', (await api('POST', '/api/ac711/auth/login', { username: 'pos1', password: 'pass1234', tenant: code })).status === 200);
    // restore from backup
    ok('reset all data', (await api('POST', '/api/ac711/settings/reset-demo', { scope: 'all' }, tk2)).status === 200 && (await api('GET', '/api/ac711/products', null, tk2)).d.length === 0);
    const rs = await api('POST', '/api/ac711/settings/restore', backup, tk2); ok('restore from backup', rs.status === 200 && (await api('GET', '/api/ac711/products', null, tk2)).d.length === 1, JSON.stringify(rs.d));
    // admin
    const ad = await api('POST', '/api/platform/admin/login', { user: 'admin', password: 'admin711' }); ok('admin login', ad.status === 200); const at = ad.d.token;
    ok('admin login wrong password', (await api('POST', '/api/platform/admin/login', { user: 'admin', password: 'x' })).status === 401);
    const tl = (await api('GET', '/api/platform/admin/tenants', null, at)).d; const t = tl.find(x => x.code === code); ok('admin sees tenant', !!t && !tl.some(x => x.id === 'demo'));
    ok('admin lock', (await api('POST', `/api/platform/admin/tenants/${t.id}/lock`, {}, at)).status === 200);
    const locked = await api('GET', '/api/ac711/products', null, tk2); ok('locked tenant gets 402 with plan', locked.status === 402 && locked.d.plan && locked.d.plan.status === 'locked');
    const lg3 = await api('POST', '/api/ac711/auth/login', { username: email, password: pw }); ok('locked login → 402 + billing token', lg3.status === 402 && lg3.d.billing_token);
    ok('billing token cannot use shop API', (await api('GET', '/api/ac711/products', null, lg3.d.billing_token)).status === 401);
    const pay = await api('POST', '/api/platform/payments', { amount: 19260, date: '2026-09-27', method: 'transfer', ref: '1234' }, lg3.d.billing_token); ok('payment notice with billing token', pay.status === 200, JSON.stringify(pay.d));
    ok('duplicate payment notice blocked', (await api('POST', '/api/platform/payments', { amount: 19260, date: '2026-09-27' }, lg3.d.billing_token)).status === 409);
    ok('admin unlock', (await api('POST', `/api/platform/admin/tenants/${t.id}/unlock`, {}, at)).status === 200);
    const ap = await api('POST', `/api/platform/admin/payments/${pay.d.id}/approve`, {}, at); ok('approve → annual + invoice', ap.status === 200 && /^INV-/.test(ap.d.invoice_no), JSON.stringify(ap.d));
    const plan = (await api('GET', '/api/platform/me/plan', null, tk2)).d; ok('plan is annual with invoice', plan.status === 'annual' && plan.invoices.length === 1);
    const inv = await fetch(`${S}/api/platform/invoices/${ap.d.invoice_no}?token=${tk2}`); ok('invoice HTML for tenant', inv.status === 200 && (await inv.text()).includes('ใบกำกับภาษี'));
    ok('invoice denied for other tenant', (await fetch(`${S}/api/platform/invoices/${ap.d.invoice_no}?token=${demo.d.token}`)).status === 403);
    ok('usage log recorded', (await api('GET', '/api/platform/admin/usage?days=1', null, at)).d.length > 5);
    ok('admin stats', (await api('GET', '/api/platform/admin/stats', null, at)).d.total >= 1);
    ok('reset password by admin', /^[A-Za-z0-9]{8}$/.test((await api('POST', `/api/platform/admin/tenants/${t.id}/reset-password`, {}, at)).d.password));
    ok('forgot password (unknown email is silent)', (await api('POST', '/api/platform/forgot', { email: 'nobody@example.com' })).d.ok);
    const fg = await api('POST', '/api/platform/forgot', { email }); const rt = fg.d.mail_preview.data.url.split('t=')[1];
    ok('reset password via link', (await api('POST', '/api/platform/reset', { t: rt, password: 'newpass123' })).status === 200 && (await api('POST', '/api/ac711/auth/login', { username: email, password: 'newpass123' })).status === 200);
    ok('delete tenant', (await api('POST', `/api/platform/admin/tenants/${t.id}/delete`, {}, at)).status === 200 && (await api('POST', '/api/ac711/auth/login', { username: email, password: 'newpass123' })).status === 401);
    { const su2 = await api('POST', '/api/platform/signup', { form: { email: 'after-delete' + Date.now() + '@example.com', name: 'ข', company: 'ร้านหลังลบ', phone: '0812345678', province: 'x', branches: 1 }, consent: { terms: true } }); ok('signup still works after a tenant was deleted', su2.status === 200 && /^S\d{4}$/.test(su2.d.mail_preview.data.code), JSON.stringify(su2.d).slice(0, 120)); }
    ok('SPA fallback serves index', (await fetch(S + '/some/deep/link')).status === 200);
    ok('unknown api → 404 json', (await api('GET', '/api/nothing')).status === 404);
    console.log(`\n✅ ผ่านทั้งหมด ${passed} ข้อ`);
  } catch (e) { console.error('\n❌ FAILED after', passed, 'checks:', e.message); process.exitCode = 1; }
  finally { await stop(); fs.rmSync(DATA_DIR, { recursive: true, force: true }); }
})();
