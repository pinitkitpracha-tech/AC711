'use strict';
/* platform.js — ฐานข้อมูลฝั่งผู้ให้บริการ (SQLite ที่มากับ Node): ผู้เช่า ผู้สมัคร การชำระเงิน ใบกำกับภาษี บันทึกการใช้งาน เนื้อหาเว็บ แอดมิน */
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'platform.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
db.exec(`
CREATE TABLE IF NOT EXISTS tenants (id TEXT PRIMARY KEY, code TEXT UNIQUE, company TEXT NOT NULL, plan TEXT DEFAULT 'trial', trial_start TEXT, trial_end TEXT, paid_until TEXT, locked INTEGER DEFAULT 0, verified INTEGER DEFAULT 0, owner_email TEXT, persist INTEGER DEFAULT 1, meta TEXT DEFAULT '{}', created_at TEXT DEFAULT (datetime('now','localtime')));
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, email TEXT UNIQUE NOT NULL, password_hash TEXT, name TEXT, title TEXT, phone TEXT, province TEXT, branches INTEGER DEFAULT 1, biz TEXT, taxid TEXT, source TEXT, consent TEXT DEFAULT '{}', verify_token TEXT, reset_token TEXT, reset_at INTEGER, created_at TEXT DEFAULT (datetime('now','localtime')));
CREATE TABLE IF NOT EXISTS payments (id TEXT PRIMARY KEY, tenant_id TEXT, email TEXT, company TEXT, name TEXT, phone TEXT, amount REAL, date TEXT, method TEXT, ref TEXT, slip TEXT, note TEXT, status TEXT DEFAULT 'pending', created_at TEXT, decided_at TEXT, admin_note TEXT DEFAULT '', invoice_no TEXT);
CREATE TABLE IF NOT EXISTS invoices (no TEXT PRIMARY KEY, tenant_id TEXT, payment_id TEXT, company TEXT, buyer_address TEXT, buyer_taxid TEXT, amount REAL, vat REAL, total REAL, period_from TEXT, period_to TEXT, issued_at TEXT);
CREATE TABLE IF NOT EXISTS usage (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, tenant_id TEXT, tenant TEXT, email TEXT, user TEXT, role TEXT, branch TEXT, type TEXT, detail TEXT, ua TEXT);
CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage(ts);
CREATE INDEX IF NOT EXISTS idx_usage_tenant ON usage(tenant_id, ts);
CREATE TABLE IF NOT EXISTS site (key TEXT PRIMARY KEY, json TEXT);
CREATE TABLE IF NOT EXISTS admins (user TEXT PRIMARY KEY, password_hash TEXT);
CREATE TABLE IF NOT EXISTS tenant_data (tenant_id TEXT PRIMARY KEY, json TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS tenant_staff (tenant_id TEXT, username TEXT, PRIMARY KEY (tenant_id, username));
`);

const nowIso = () => new Date().toISOString();
const today = () => { const d = new Date(); const z = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`; };
const addDays = (ymd, n) => { const d = new Date(ymd + 'T00:00:00'); d.setDate(d.getDate() + n); const z = x => String(x).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`; };
const token = () => crypto.randomBytes(18).toString('base64url');
const genPassword = () => { const c = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'; return Array.from(crypto.randomBytes(8)).map(b => c[b % c.length]).join(''); };
const hash = pw => bcrypt.hashSync(String(pw), 10);
const verify = (pw, h) => { if (!h) return false; if (String(h).startsWith('$2')) return bcrypt.compareSync(String(pw), h); return String(pw) === String(h); };

/* ---------- เนื้อหาเว็บไซต์ / แพ็กเกจ ---------- */
const SITE_DEFAULTS = require('./site-defaults.json');
function site() { const r = db.prepare('SELECT json FROM site WHERE key = ?').get('main'); let o = {}; try { o = r ? JSON.parse(r.json) : {}; } catch {} return { ...SITE_DEFAULTS, ...o }; }
function saveSite(o) { db.prepare('INSERT INTO site (key, json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json').run('main', JSON.stringify(o)); }
const priceVat = c => Math.round((+c.price || 18000) * (1 + (+c.vat || 7) / 100));

/* ---------- สถานะแพ็กเกจของผู้เช่า ---------- */
function expiryOf(t) { return t.plan === 'annual' && t.paid_until ? t.paid_until : t.trial_end || null; }
function daysLeft(t) { const e = expiryOf(t); if (!e) return null; return Math.floor((new Date(e + 'T23:59:59') - Date.now()) / 864e5); }
function statusOf(t) { if (!t.verified) return ['pending', 'รอยืนยันอีเมล', '']; if (t.locked) return ['locked', 'ระงับ', 'red']; const d = daysLeft(t); if (d != null && d < 0) return ['expired', t.plan === 'annual' ? 'รายปีหมดอายุ' : 'หมดทดลองใช้', 'red']; if (t.plan === 'annual') return ['annual', `รายปี ถึง ${t.paid_until}`, 'green']; return ['trial', `ทดลองใช้ เหลือ ${d} วัน`, 'amber']; }
function lockReason(t, cfg = site()) { if (!t) return ''; if (t.persist === 0) return ''; if (t.locked) return 'บัญชีนี้ถูกระงับโดยผู้ดูแลระบบ กรุณาติดต่อ ' + cfg.sales_email; const d = daysLeft(t); if (d != null && d < 0) return t.plan === 'annual' ? `แพ็กเกจรายปีหมดอายุเมื่อ ${t.paid_until} กรุณาชำระค่าบริการเพื่อใช้งานต่อ ข้อมูลของคุณยังอยู่ครบ` : `ระยะทดลองใช้ ${cfg.trial_days} วันสิ้นสุดแล้ว ระบบล็อกการใช้งานแต่ข้อมูลของคุณยังอยู่ครบ ชำระค่าบริการรายปีแล้วแจ้งชำระเงินให้แอดมินอนุมัติ`; return ''; }
function planOf(t) { if (!t) return null; const [status, label, cls] = statusOf(t); const pend = db.prepare("SELECT id, amount, created_at FROM payments WHERE tenant_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1").get(t.id) || null; const cfg = site(); return { status, label, cls, company: t.company, expiry: expiryOf(t), days_left: daysLeft(t), pending: pend, reason: lockReason(t, cfg), is_demo: t.persist === 0, price: +cfg.price, vat: +cfg.vat, total: priceVat(cfg), bank_info: cfg.bank_info, sales_email: cfg.sales_email }; }

/* ---------- ผู้เช่า ---------- */
const tenant = id => db.prepare('SELECT * FROM tenants WHERE id = ?').get(id) || null;
const tenantByCode = code => db.prepare('SELECT * FROM tenants WHERE code = ?').get(String(code || '').toUpperCase()) || null;
const tenantByEmail = email => { const u = userByEmail(email); return u ? tenant(u.tenant_id) : null; };
function listTenants() { return db.prepare('SELECT * FROM tenants ORDER BY created_at DESC').all().map(t => ({ ...t, user: db.prepare('SELECT id, email, name, title, phone, province, branches, biz, taxid, source, consent, created_at FROM users WHERE tenant_id = ?').get(t.id) || null, status: statusOf(t), expiry: expiryOf(t), usage_n: db.prepare('SELECT COUNT(*) n FROM usage WHERE tenant_id = ?').get(t.id).n })); }
function updateTenant(id, patch) { const keys = Object.keys(patch); if (!keys.length) return; db.prepare(`UPDATE tenants SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map(k => patch[k]), id); }
function nextCode() { const r = db.prepare("SELECT MAX(CAST(SUBSTR(code, 2) AS INTEGER)) m FROM tenants WHERE code LIKE 'S%'").get(); return 'S' + String(Math.max(1000, +r.m || 1000) + 1); }

/* ---------- ผู้สมัคร ---------- */
const userByEmail = email => db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').trim().toLowerCase()) || null;
const userByToken = (field, t) => t ? db.prepare(`SELECT * FROM users WHERE ${field} = ?`).get(t) || null : null;
function signup(form, consent) {
  const email = String(form.email || '').trim().toLowerCase();
  const exist = userByEmail(email); if (exist) { const t = tenant(exist.tenant_id); if (t && t.verified) { const e = new Error('อีเมลนี้มีบัญชีอยู่แล้ว กรุณาเข้าสู่ระบบหรือกดลืมรหัสผ่าน'); e.status = 409; throw e; } deleteTenant(exist.tenant_id); }
  const id = crypto.randomUUID(); const code = nextCode(); const pw = genPassword(); const vt = token();
  db.exec('BEGIN'); try {
  db.prepare('INSERT INTO tenants (id, code, company, plan, verified, owner_email, meta) VALUES (?, ?, ?, ?, 0, ?, ?)').run(id, code, form.company, 'trial', email, JSON.stringify({ branches: +form.branches || 1 }));
  db.prepare('INSERT INTO users (tenant_id, email, password_hash, name, title, phone, province, branches, biz, taxid, source, consent, verify_token) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, email, hash(pw), form.name || '', form.title || '', form.phone || '', form.province || '', +form.branches || 1, form.biz || '', form.taxid || '', form.source || '', JSON.stringify(consent || {}), vt);
  db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { tenant_id: id, code, email, password: pw, verify_token: vt };
}
function verifyEmail(t, cfg = site()) { const u = userByToken('verify_token', t); if (!u) return null; const start = today(), end = addDays(start, +cfg.trial_days || 30); db.prepare('UPDATE users SET verify_token = NULL WHERE id = ?').run(u.id); updateTenant(u.tenant_id, { verified: 1, trial_start: start, trial_end: end, plan: 'trial', locked: 0 }); return { ...u, tenant: tenant(u.tenant_id) }; }
function activateAnnual(tenantId) { const t = tenant(tenantId); if (!t) return null; const base = expiryOf(t) && expiryOf(t) > today() ? expiryOf(t) : today(); const d = new Date(base + 'T00:00:00'); d.setFullYear(d.getFullYear() + 1); const z = x => String(x).padStart(2, '0'); const until = `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`; updateTenant(tenantId, { plan: 'annual', paid_until: until, locked: 0, verified: 1 }); return { from: base, until }; }

/* ---------- ชำระเงิน / ใบกำกับภาษี ---------- */
function addPayment(t, u, p) { const id = crypto.randomUUID(); db.prepare('INSERT INTO payments (id, tenant_id, email, company, name, phone, amount, date, method, ref, slip, note, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, t.id, u ? u.email : t.owner_email, t.company, u ? u.name : '', u ? u.phone : '', +p.amount, p.date, p.method || 'transfer', p.ref || '', p.slip || '', p.note || '', 'pending', nowIso()); return id; }
const payment = id => db.prepare('SELECT * FROM payments WHERE id = ?').get(id) || null;
const listPayments = f => db.prepare(`SELECT * FROM payments ${f && f !== 'all' ? "WHERE status = ?" : ''} ORDER BY created_at DESC`).all(...(f && f !== 'all' ? [f] : []));
function nextInvoiceNo() { const ym = today().slice(0, 7).replace('-', ''); const r = db.prepare('SELECT COUNT(*) n FROM invoices WHERE no LIKE ?').get(`INV-${ym}-%`); return `INV-${ym}-${String(r.n + 1).padStart(4, '0')}`; }
function approvePayment(id) { const p = payment(id); if (!p || p.status !== 'pending') return null; const per = activateAnnual(p.tenant_id); const cfg = site(); const vatRate = +cfg.vat || 7; const total = +p.amount; const base = Math.round(total / (1 + vatRate / 100) * 100) / 100; const vat = Math.round((total - base) * 100) / 100; const no = nextInvoiceNo(); const u = userByEmail(p.email); db.prepare('INSERT INTO invoices (no, tenant_id, payment_id, company, buyer_address, buyer_taxid, amount, vat, total, period_from, period_to, issued_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(no, p.tenant_id, p.id, p.company, p.note || '', u ? u.taxid : '', base, vat, total, per.from, per.until, today()); db.prepare("UPDATE payments SET status = 'approved', decided_at = ?, invoice_no = ? WHERE id = ?").run(nowIso(), no, id); return { ...per, invoice_no: no }; }
function rejectPayment(id, note) { db.prepare("UPDATE payments SET status = 'rejected', decided_at = ?, admin_note = ? WHERE id = ? AND status = 'pending'").run(nowIso(), note || '', id); }
const invoice = no => db.prepare('SELECT * FROM invoices WHERE no = ?').get(no) || null;

/* ---------- บันทึกการใช้งาน ---------- */
const insUsage = db.prepare('INSERT INTO usage (ts, tenant_id, tenant, email, user, role, branch, type, detail, ua) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
function logUsage(e) { insUsage.run(e.ts || nowIso(), e.tenant_id || '', e.tenant || '', e.email || '', e.user || '', e.role || '', e.branch || '', e.type || '', String(e.detail || '').slice(0, 200), String(e.ua || '').slice(0, 40)); }
function listUsage({ tenant_id = '', type = '', days = 30, limit = 5000 } = {}) { const since = new Date(Date.now() - days * 864e5).toISOString(); const where = ['ts > ?']; const args = [since]; if (tenant_id) { where.push('tenant_id = ?'); args.push(tenant_id); } if (type === 'admin') where.push("type LIKE 'admin%'"); else if (type) { where.push('type = ?'); args.push(type); } return db.prepare(`SELECT * FROM usage WHERE ${where.join(' AND ')} ORDER BY ts DESC LIMIT ?`).all(...args, limit); }
const usageCount = tenantId => db.prepare('SELECT COUNT(*) n FROM usage WHERE tenant_id = ?').get(tenantId).n;
function pruneUsage(days = 400) { return db.prepare("DELETE FROM usage WHERE ts < ?").run(new Date(Date.now() - days * 864e5).toISOString()).changes; }
function clearUsage() { db.exec('DELETE FROM usage'); }

/* ---------- แอดมิน ---------- */
function ensureAdmin() { const r = db.prepare('SELECT * FROM admins').get(); if (!r) { db.prepare('INSERT INTO admins (user, password_hash) VALUES (?, ?)').run(process.env.ADMIN_USER || 'admin', hash(process.env.ADMIN_PASSWORD || 'admin711')); return; } if (process.env.ADMIN_PASSWORD && verify('admin711', r.password_hash)) setAdmin(process.env.ADMIN_USER || r.user, process.env.ADMIN_PASSWORD); if (!process.env.ADMIN_PASSWORD && verify('admin711', r.password_hash)) console.warn('⚠ Admin Console ยังใช้รหัสผ่านค่าเริ่มต้น admin711 — ตั้ง ADMIN_PASSWORD ก่อนเปิดใช้จริง'); }
function adminCheck(user, pw) { const r = db.prepare('SELECT * FROM admins WHERE user = ?').get(String(user || '').trim()); return !!(r && verify(pw, r.password_hash)); }
function setAdmin(user, pw) { db.exec('DELETE FROM admins'); db.prepare('INSERT INTO admins (user, password_hash) VALUES (?, ?)').run(user || 'admin', hash(pw)); }

/* ---------- ข้อมูลร้าน (JSON ต่อผู้เช่า) ---------- */
const loadTenantData = id => db.prepare('SELECT json FROM tenant_data WHERE tenant_id = ?').get(id)?.json || null;
function saveTenantData(id, json, usernames) { db.prepare('INSERT INTO tenant_data (tenant_id, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(tenant_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at').run(id, json, nowIso()); if (usernames) { const tx = db.prepare('INSERT OR IGNORE INTO tenant_staff (tenant_id, username) VALUES (?, ?)'); db.prepare('DELETE FROM tenant_staff WHERE tenant_id = ?').run(id); usernames.forEach(u => tx.run(id, u)); } }
const tenantsWithUsername = username => db.prepare('SELECT tenant_id FROM tenant_staff WHERE username = ?').all(String(username || '').toLowerCase()).map(r => r.tenant_id);
function deleteTenant(id) { ['payments', 'usage', 'tenant_data', 'tenant_staff', 'users', 'invoices'].forEach(t => db.prepare(`DELETE FROM ${t} WHERE tenant_id = ?`).run(id)); db.prepare('DELETE FROM tenants WHERE id = ?').run(id); }

module.exports = { db, DATA_DIR, today, addDays, token, genPassword, hash, verify, site, saveSite, priceVat, SITE_DEFAULTS, expiryOf, daysLeft, statusOf, lockReason, planOf, tenant, tenantByCode, tenantByEmail, listTenants, updateTenant, userByEmail, userByToken, signup, verifyEmail, activateAnnual, addPayment, payment, listPayments, approvePayment, rejectPayment, invoice, logUsage, listUsage, usageCount, clearUsage, pruneUsage, ensureAdmin, adminCheck, setAdmin, loadTenantData, saveTenantData, tenantsWithUsername, deleteTenant, nowIso };
