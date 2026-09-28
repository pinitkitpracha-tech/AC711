'use strict';
/* server.js — AC711 Cloud: เว็บไซต์ + API ของร้าน (หลายผู้เช่า) + API ฝั่งผู้ให้บริการ/แอดมิน */
const path = require('path');
const fs = require('fs');
const express = require('express');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const platform = require('./src/platform');
const tenants = require('./src/tenants');
const mail = require('./src/mail');
const cron = require('./src/cron');
const ai = require('./src/ai');

const PORT = +process.env.PORT || 3000;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const JWT_SECRET = process.env.JWT_SECRET || (() => { console.warn('⚠ JWT_SECRET ไม่ได้ตั้งค่า ใช้ค่าสุ่มชั่วคราว (โทเคนจะหมดอายุเมื่อรีสตาร์ต)'); return require('crypto').randomBytes(32).toString('hex'); })();
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(platform.DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
app.set('trust proxy', process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true' ? 1 : (process.env.TRUST_PROXY && process.env.TRUST_PROXY !== '0' && process.env.TRUST_PROXY !== 'false' ? process.env.TRUST_PROXY : false)); // ตั้ง TRUST_PROXY=1 เฉพาะเมื่ออยู่หลัง reverse proxy/Render
app.disable('x-powered-by');
app.use(express.json({ limit: '25mb' }));
app.use((req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'same-origin'); res.setHeader('X-Frame-Options', 'SAMEORIGIN'); if (process.env.NODE_ENV === 'production' && req.headers['x-forwarded-proto'] === 'http') return res.redirect(301, 'https://' + req.headers.host + req.url); next(); });

/* ---------- helpers ---------- */
const bad = (res, status, error, extra = {}) => res.status(status).json({ error, ...extra });
const sign = (payload, exp = '7d') => jwt.sign(payload, JWT_SECRET, { expiresIn: exp });
const readToken = req => { const h = req.headers.authorization || ''; const t = h.startsWith('Bearer ') ? h.slice(7) : (req.query.token || ''); if (!t) return null; try { return jwt.verify(String(t), JWT_SECRET); } catch { return null; } };
const ua = req => (String(req.headers['user-agent'] || '').match(/(iPhone|iPad|Android|Windows|Mac OS|Linux)/) || ['-'])[0];
const ip = req => req.ip || '';
/* จำกัดอัตรา: นับเฉพาะคำขอที่ล้มเหลว (status ≥ 400) ต่อ IP + ชื่อผู้ใช้/อีเมล เพื่อไม่ให้ร้านที่มีพนักงานหลายคนหลัง IP เดียวโดนบล็อกเมื่อเข้าระบบถูกต้อง */
const limiter = (max, windowMs) => { const hits = new Map(); return (req, res, next) => { const who = String((req.body && (req.body.username || req.body.email || req.body.user)) || '').toLowerCase().slice(0, 80); const k = ip(req) + '|' + req.path + '|' + who; const now = Date.now(); const a = (hits.get(k) || []).filter(t => now - t < windowMs); if (a.length >= max) return bad(res, 429, 'ลองใหม่ในอีกสักครู่ (ป้องกันการเดารหัส)'); res.on('finish', () => { if (res.statusCode >= 400 && res.statusCode !== 402 && res.statusCode !== 409) { a.push(Date.now()); hits.set(k, a); } else hits.delete(k); if (hits.size > 5000) { for (const key of hits.keys()) { hits.delete(key); if (hits.size <= 4000) break; } } }); next(); }; };
const IMG_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' }; // รับเฉพาะรูปภาพ ไม่รับ svg/html (ป้องกัน XSS บนโดเมนหลัก)
const upload = multer({ storage: multer.diskStorage({ destination: UPLOAD_DIR, filename: (req, f, cb) => cb(null, Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8) + IMG_EXT[f.mimetype]) }), limits: { fileSize: 8 * 1024 * 1024, files: 1 }, fileFilter: (req, f, cb) => cb(null, !!IMG_EXT[f.mimetype]) });
const logTenantUsage = (rt, user, type, detail, req) => { try { platform.logUsage({ tenant_id: rt.id, tenant: rt.row.company, email: rt.row.owner_email || user?.email || '', user: user ? (user.name || user.username) + (user.username && user.username !== rt.row.owner_email ? ' (@' + user.username + ')' : '') : '', role: user?.role || '', branch: user ? (rt.api.DB.branches.find(b => b.id === user.branch_id)?.code || 'HQ') : '', type, detail, ua: ua(req) }); } catch {} };
const PW_PATHS = [/^\/staff$/, /^\/staff\/\d+$/, /^\/hr\/employees$/, /^\/hr\/employees\/\d+$/];

/* ---------- เว็บไซต์ / ไฟล์ ---------- */
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d', setHeaders: res => { res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox"); res.setHeader('Content-Disposition', 'inline'); } }));
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html', maxAge: '1h', setHeaders: (res, p) => { if (p.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache'); } }));
app.get('/health', (req, res) => res.json({ ok: true, mail: mail.configured, ai: ai.ready(), time: new Date().toISOString() }));

/* ===================== API ฝั่งผู้ให้บริการ (/api/platform) ===================== */
const P = express.Router();
P.get('/site', (req, res) => { const c = platform.site(); res.json({ ...c, mail_configured: mail.configured, ai_ready: ai.ready() }); });

P.post('/signup', limiter(10, 10 * 60e3), async (req, res) => {
  const f = req.body.form || {}; const consent = req.body.consent || {}; const cfg = platform.site();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(f.email || ''))) return bad(res, 400, 'รูปแบบอีเมลไม่ถูกต้อง');
  if (!f.company || !f.name) return bad(res, 400, 'กรอกชื่อร้านและชื่อผู้สมัคร');
  if (!consent.terms) return bad(res, 400, 'ต้องยอมรับประกาศความเป็นส่วนตัวและข้อกำหนดการใช้บริการก่อน');
  try { const prev = platform.userByEmail(String(f.email).trim().toLowerCase()); if (prev) tenants.evict(prev.tenant_id); const r = platform.signup(f, { ...consent, ip: ip(req), ua: ua(req) }); const url = `${BASE_URL}/#/verify?t=${r.verify_token}`; const m = await mail.send(cfg, 'verify', r.email, { name: f.name, company: f.company, email: r.email, password: r.password, code: r.code, url });
    platform.logUsage({ tenant_id: r.tenant_id, tenant: f.company, email: r.email, user: f.name, type: 'signup', detail: f.company, ua: ua(req) });
    res.json({ ok: true, email: r.email, sent: m.sent, mail_preview: m.preview || null }); } catch (e) { bad(res, e.status || 500, e.message); }
});
P.post('/verify', (req, res) => { const cfg = platform.site(); const u = platform.verifyEmail(String(req.body.t || ''), cfg); if (!u) return bad(res, 400, 'ลิงก์ยืนยันไม่ถูกต้องหรือถูกใช้ไปแล้ว'); tenants.refreshRow(u.tenant_id); tenants.get(u.tenant_id); platform.logUsage({ tenant_id: u.tenant_id, tenant: u.tenant.company, email: u.email, user: u.name, type: 'verify', detail: u.tenant.company, ua: ua(req) }); res.json({ ok: true, email: u.email, code: u.tenant.code }); });
P.post('/forgot', limiter(10, 10 * 60e3), async (req, res) => { const cfg = platform.site(); const u = platform.userByEmail(req.body.email); if (!u || !platform.tenant(u.tenant_id)?.verified) return res.json({ ok: true, sent: true }); const t = platform.token(); platform.db.prepare('UPDATE users SET reset_token = ?, reset_at = ? WHERE id = ?').run(t, Date.now(), u.id); const m = await mail.send(cfg, 'reset', u.email, { name: u.name, email: u.email, url: `${BASE_URL}/#/reset?t=${t}` }); res.json({ ok: true, sent: m.sent, mail_preview: m.preview || null }); });
P.post('/reset', (req, res) => { const u = platform.userByToken('reset_token', String(req.body.t || '')); if (!u || Date.now() - (u.reset_at || 0) > 60 * 60e3) return bad(res, 400, 'ลิงก์ตั้งรหัสผ่านใหม่ไม่ถูกต้องหรือหมดอายุ'); const pw = String(req.body.password || ''); if (pw.length < 8) return bad(res, 400, 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร'); const h = platform.hash(pw); platform.db.prepare('UPDATE users SET password_hash = ?, reset_token = NULL, reset_at = NULL WHERE id = ?').run(h, u.id); const rt = tenants.get(u.tenant_id); if (rt) { const s = rt.api.DB.staff.find(x => x.username === u.email); if (s) { s.password = h; rt.touch(); } } res.json({ ok: true, email: u.email }); });
P.post('/usage', limiter(120, 60e3), (req, res) => { const tk = readToken(req); const rt = tk?.tid ? tenants.get(tk.tid) : null; const list = Array.isArray(req.body.events) ? req.body.events.slice(0, 50) : []; if (rt) { const u = rt.api.DB.staff.find(s => s.id === tk.sid); list.forEach(e => logTenantUsage(rt, u, String(e.type || 'page').slice(0, 30), e.detail, req)); } res.json({ ok: true }); });
const ownerOnly = tk => { if (!tk?.tid) return false; if (tk.billing) return true; const rt = tenants.get(tk.tid); const u = rt && rt.api.DB.staff.find(s => s.id === tk.sid && s.active); return !!u && u.role === 'owner'; };
P.get('/me/plan', (req, res) => { const tk = readToken(req); const t = tk?.tid ? platform.tenant(tk.tid) : null; if (!t) return bad(res, 401, 'กรุณาเข้าสู่ระบบ'); if (!ownerOnly(tk)) return bad(res, 403, 'เฉพาะบัญชีเจ้าของกิจการ'); const plan = platform.planOf(t); plan.invoices = platform.db.prepare('SELECT no, issued_at, total, period_from, period_to FROM invoices WHERE tenant_id = ? ORDER BY issued_at DESC').all(t.id); res.json(plan); });
P.post('/payments', limiter(10, 10 * 60e3), (req, res) => { const tk = readToken(req); const t = tk?.tid ? platform.tenant(tk.tid) : null; if (!t || t.persist === 0) return bad(res, 401, 'กรุณาเข้าสู่ระบบด้วยบัญชีร้านของคุณ'); if (!ownerOnly(tk)) return bad(res, 403, 'การแจ้งชำระเงินทำได้โดยบัญชีเจ้าของกิจการ'); if (platform.db.prepare("SELECT 1 FROM payments WHERE tenant_id = ? AND status = 'pending'").get(t.id)) return bad(res, 409, 'มีการแจ้งชำระเงินรอตรวจสอบอยู่แล้ว'); const b = req.body || {}; if (!(+b.amount > 0)) return bad(res, 400, 'ระบุยอดที่โอน'); if (!b.date) return bad(res, 400, 'ระบุวันที่โอน'); const u = platform.userByEmail(t.owner_email); const id = platform.addPayment(t, u, { ...b, slip: String(b.slip || '').slice(0, 4_000_000) }); platform.logUsage({ tenant_id: t.id, tenant: t.company, email: t.owner_email, user: u?.name || '', type: 'payment_notice', detail: `${t.company} ${b.amount}`, ua: ua(req) }); res.json({ ok: true, id }); });
P.get('/invoices/:no', (req, res) => { const tk = readToken(req); const inv = platform.invoice(req.params.no); if (!inv) return bad(res, 404, 'ไม่พบใบกำกับภาษี'); if (!(tk?.admin || (tk?.tid && tk.tid === inv.tenant_id))) return bad(res, 403, 'ไม่มีสิทธิ์'); const cfg = platform.site(); const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); const money = n => (+n).toLocaleString('th-TH', { minimumFractionDigits: 2 }); const dd = s => { if (!s) return '-'; const d = new Date(s + 'T00:00:00'); return d.toLocaleDateString('th-TH', { day: 'numeric', month: 'long', year: 'numeric' }); };
  res.type('html').send(`<!doctype html><html lang="th"><head><meta charset="utf-8"><title>ใบกำกับภาษี ${esc(inv.no)}</title><style>body{font-family:Prompt,'Segoe UI',Arial,sans-serif;color:#1f2329;margin:0;background:#f3f4f6}.page{max-width:794px;margin:24px auto;background:#fff;padding:48px;border:1px solid #dfe2e7}h1{font-size:22px;margin:0 0 4px}table{width:100%;border-collapse:collapse;margin-top:18px}th,td{border-bottom:1px solid #dfe2e7;padding:10px 8px;text-align:left;font-size:14px}th{background:#f7f8fa}.r{text-align:right}.tot td{font-weight:800;font-size:16px}.muted{color:#5f6772;font-size:13px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-top:20px}.btn{position:fixed;top:12px;right:12px;background:#f97316;color:#fff;border:none;border-radius:10px;padding:10px 16px;font-weight:700;cursor:pointer}@media print{.btn{display:none}body{background:#fff}.page{border:none;margin:0}}</style></head><body><button class="btn" onclick="window.print()">พิมพ์</button><div class="page"><h1>ใบกำกับภาษี / ใบเสร็จรับเงิน</h1><div class="muted">เลขที่ ${esc(inv.no)} · วันที่ ${dd(inv.issued_at)} · ต้นฉบับ</div><div class="grid"><div><b>ผู้ขาย</b><br>${esc(cfg.controller)}<br>${esc(cfg.address)}<br>เลขประจำตัวผู้เสียภาษี ${esc(cfg.seller_taxid || '-')}<br>${esc(cfg.sales_email)}</div><div><b>ผู้ซื้อ</b><br>${esc(inv.company)}<br>${esc(inv.buyer_address || '-')}<br>เลขประจำตัวผู้เสียภาษี ${esc(inv.buyer_taxid || '-')}</div></div><table><thead><tr><th>รายการ</th><th class="r">จำนวนเงิน (บาท)</th></tr></thead><tbody><tr><td>ค่าบริการระบบ ${esc(cfg.brand)} แพ็กเกจรายปี<br><span class="muted">ระยะเวลาใช้งาน ${dd(inv.period_from)} – ${dd(inv.period_to)}</span></td><td class="r">${money(inv.amount)}</td></tr><tr><td>ภาษีมูลค่าเพิ่ม ${esc(cfg.vat)}%</td><td class="r">${money(inv.vat)}</td></tr><tr class="tot"><td>รวมทั้งสิ้น</td><td class="r">${money(inv.total)}</td></tr></tbody></table><p class="muted" style="margin-top:32px">ชำระเงินแล้ว · เอกสารนี้ออกโดยระบบอัตโนมัติ ${esc(cfg.site)}</p></div></body></html>`); });

/* ---------- แอดมิน ---------- */
const adminOnly = (req, res, next) => { const tk = readToken(req); if (!tk?.admin) return bad(res, 401, 'กรุณาเข้าสู่ระบบผู้ดูแล'); req.admin = tk; next(); };
P.post('/admin/login', limiter(8, 5 * 60e3), (req, res) => { if (!platform.adminCheck(req.body.user, req.body.password)) return bad(res, 401, 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง'); if (process.env.NODE_ENV === 'production' && String(req.body.password) === 'admin711') return bad(res, 403, 'ยังใช้รหัสผ่านแอดมินค่าเริ่มต้น กรุณาตั้ง ADMIN_PASSWORD ในตัวแปรแวดล้อมแล้วรีสตาร์ต'); platform.logUsage({ tenant: 'ผู้ดูแลระบบ', user: String(req.body.user), type: 'admin_login', detail: 'admin', ua: ua(req) }); res.json({ token: sign({ admin: true, user: String(req.body.user) }, '12h') }); });
P.get('/admin/stats', adminOnly, (req, res) => { const list = platform.listTenants().filter(t => t.persist !== 0); const st = list.map(t => t.status[0]); const cnt = k => st.filter(x => x === k).length; const pays = platform.listPayments('all'); const since = new Date(Date.now() - 7 * 864e5).toISOString(); const u7 = platform.db.prepare('SELECT COUNT(DISTINCT tenant_id) n, COUNT(*) e FROM usage WHERE ts > ? AND tenant_id != \'\'').get(since); res.json({ total: list.length, pending: cnt('pending'), trial: cnt('trial'), annual: cnt('annual'), expired: cnt('expired'), locked: cnt('locked'), pay_pending: pays.filter(p => p.status === 'pending').length, pay_approved: pays.filter(p => p.status === 'approved').length, revenue: pays.filter(p => p.status === 'approved').reduce((s, p) => s + p.amount, 0), active7: u7.n, events7: u7.e, usage_total: platform.db.prepare('SELECT COUNT(*) n FROM usage').get().n, soon: list.filter(t => t.verified && !t.locked && platform.daysLeft(t) >= 0 && platform.daysLeft(t) <= 7).sort((a, b) => platform.daysLeft(a) - platform.daysLeft(b)).slice(0, 10), recent: list.slice(0, 8), mail: mail.configured, ai: ai.ready() }); });
P.get('/admin/tenants', adminOnly, (req, res) => res.json(platform.listTenants().filter(t => t.persist !== 0)));
P.get('/admin/tenants/:id', adminOnly, (req, res) => { const t = platform.listTenants().find(x => x.id === req.params.id); if (!t) return bad(res, 404, 'ไม่พบ'); res.json({ ...t, payments: platform.db.prepare('SELECT * FROM payments WHERE tenant_id = ? ORDER BY created_at DESC').all(t.id).map(({ slip, ...p }) => p), usage_last: platform.db.prepare('SELECT ts FROM usage WHERE tenant_id = ? ORDER BY ts DESC LIMIT 1').get(t.id)?.ts || null, top_pages: platform.db.prepare("SELECT detail, COUNT(*) n FROM usage WHERE tenant_id = ? AND type = 'page' GROUP BY detail ORDER BY n DESC LIMIT 5").all(t.id), invoices: platform.db.prepare('SELECT no, issued_at, total FROM invoices WHERE tenant_id = ? ORDER BY issued_at DESC').all(t.id) }); });
P.post('/admin/tenants/:id/:action', adminOnly, async (req, res) => { const t = platform.tenant(req.params.id); if (!t || t.persist === 0) return bad(res, 404, 'ไม่พบ'); const a = req.params.action; const u = platform.userByEmail(t.owner_email); const cfg = platform.site(); let out = { ok: true };
  if (a === 'reset-password') { const pw = platform.genPassword(); const h = platform.hash(pw); if (u) platform.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(h, u.id); const rt = tenants.get(t.id); if (rt) { const s = rt.api.DB.staff.find(x => x.username === t.owner_email); if (s) { s.password = h; rt.save(true); } } out.password = pw; try { const m = await mail.send(cfg, 'newpass', t.owner_email, { name: u?.name || '', company: t.company, email: t.owner_email, password: pw, code: t.code, url: BASE_URL + '/#/login?u=' + encodeURIComponent(t.owner_email) }); out.sent = !!m.sent; } catch (e) { out.sent = false; } }
  else if (a === 'extend') { const base = platform.expiryOf(t) && platform.expiryOf(t) > platform.today() ? platform.expiryOf(t) : platform.today(); const d = platform.addDays(base, +req.body.days || 7); platform.updateTenant(t.id, t.plan === 'annual' ? { paid_until: d } : { trial_end: d, locked: 0 }); out.until = d; }
  else if (a === 'lock') platform.updateTenant(t.id, { locked: 1 });
  else if (a === 'unlock') platform.updateTenant(t.id, { locked: 0 });
  else if (a === 'activate') { out = { ok: true, ...platform.activateAnnual(t.id) }; }
  else if (a === 'delete') { tenants.evict(t.id); platform.deleteTenant(t.id); }
  else return bad(res, 400, 'ไม่รู้จักคำสั่ง');
  tenants.refreshRow(t.id); platform.logUsage({ tenant: 'ผู้ดูแลระบบ', user: req.admin.user, type: 'admin_' + a.replace('-', '_'), detail: `${t.company} (${t.owner_email})`, ua: ua(req) }); res.json(out); });
P.get('/admin/payments', adminOnly, (req, res) => res.json(platform.listPayments(req.query.f || 'pending')));
P.post('/admin/payments/:id/approve', adminOnly, async (req, res) => { const p = platform.payment(req.params.id); if (!p || p.status !== 'pending') return bad(res, 404, 'ไม่พบรายการรอตรวจ'); const r = platform.approvePayment(p.id); tenants.refreshRow(p.tenant_id); const t = platform.tenant(p.tenant_id); const u = platform.userByEmail(p.email); try { await mail.send(platform.site(), 'approved', p.email, { name: u?.name || p.name, company: p.company, until: r.until, invoice_no: r.invoice_no, url: `${BASE_URL}/#/login` }); } catch (e) { console.error('mail approved failed', e.message); } platform.logUsage({ tenant: 'ผู้ดูแลระบบ', user: req.admin.user, type: 'admin_activate', detail: `${p.company} → ${r.until} (${r.invoice_no})`, ua: ua(req) }); res.json({ ok: true, ...r, company: t?.company }); });
P.post('/admin/payments/:id/reject', adminOnly, async (req, res) => { const p = platform.payment(req.params.id); if (!p || p.status !== 'pending') return bad(res, 404, 'ไม่พบรายการรอตรวจ'); platform.rejectPayment(p.id, req.body.note); try { await mail.send(platform.site(), 'rejected', p.email, { name: p.name, company: p.company, amount: p.amount, note: req.body.note }); } catch (e) { console.error('mail rejected failed', e.message); } platform.logUsage({ tenant: 'ผู้ดูแลระบบ', user: req.admin.user, type: 'admin_reject_payment', detail: p.company, ua: ua(req) }); res.json({ ok: true }); });
P.get('/admin/usage', adminOnly, (req, res) => res.json(platform.listUsage({ tenant_id: req.query.tenant_id || '', type: req.query.type || '', days: +req.query.days || 30, limit: Math.min(+req.query.limit || 5000, 20000) })));
P.delete('/admin/usage', adminOnly, (req, res) => { platform.clearUsage(); res.json({ ok: true }); });
P.get('/admin/site', adminOnly, (req, res) => res.json(platform.site()));
P.put('/admin/site', adminOnly, (req, res) => { const o = { ...platform.site(), ...(req.body || {}) }; delete o.mail_configured; delete o.ai_ready; platform.saveSite(o); platform.logUsage({ tenant: 'ผู้ดูแลระบบ', user: req.admin.user, type: 'admin_site_update', detail: 'เนื้อหาเว็บไซต์', ua: ua(req) }); res.json({ ...platform.site(), mail_configured: mail.configured, ai_ready: ai.ready() }); });
P.delete('/admin/site', adminOnly, (req, res) => { platform.saveSite({}); res.json({ ok: true }); });
P.put('/admin/password', adminOnly, (req, res) => { const pw = String(req.body.password || ''); if (pw.length < 8) return bad(res, 400, 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร'); platform.setAdmin(String(req.body.user || 'admin').trim(), pw); res.json({ ok: true }); });
P.get('/admin/export', adminOnly, (req, res) => res.json({ tenants: platform.listTenants(), payments: platform.listPayments('all').map(({ slip, ...p }) => p), exported_at: platform.nowIso() }));
app.use('/api/platform', P);

/* ===================== API ของร้าน (/api/ac711) ===================== */
const T = express.Router();
/* ร้านสาธิต (owner/ac1234) ใช้ร่วมกันทุกคน: ห้ามลบ/กู้คืนข้อมูล แก้พนักงาน รหัสผ่าน สาขา สิทธิ์ และตั้งค่าร้าน */
const DEMO_BLOCK = /^\/(settings(\/(reset-demo|restore))?$|staff|branches|hr\/permissions|import\/)/;
const findLoginTenant = (username, code) => {
  if (code) { const t = platform.tenantByCode(code); return t ? [t] : []; }
  if (username.includes('@')) { const t = platform.tenantByEmail(username); if (t) return [t]; }
  const ids = platform.tenantsWithUsername(username); const list = ids.map(id => platform.tenant(id)).filter(Boolean);
  const demo = platform.tenant('demo'); const rtDemo = tenants.get('demo'); if (rtDemo && rtDemo.api.DB.staff.some(s => s.username === username)) list.push(demo);
  return list;
};
T.post('/auth/login', limiter(12, 5 * 60e3), (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase(), password = String(req.body.password || ''); if (!username || !password) return bad(res, 400, 'กรอกชื่อผู้ใช้และรหัสผ่าน');
  const cands = findLoginTenant(username, req.body.tenant); if (!cands.length) return bad(res, 401, 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
  if (cands.length > 1) return bad(res, 409, 'ชื่อผู้ใช้นี้มีในหลายร้าน กรุณาระบุรหัสร้าน', { need_tenant: true });
  const t = cands[0]; if (!t.verified && t.persist !== 0) return bad(res, 403, 'บัญชีนี้ยังไม่ได้ยืนยันอีเมล กรุณากดยืนยันจากอีเมลที่ระบบส่งให้', { unverified: true });
  const rt = tenants.get(t.id); if (!rt) return bad(res, 401, 'ไม่พบข้อมูลร้าน');
  const u = rt.api.DB.staff.find(s => s.username === username && s.active); if (!u || !platform.verify(password, u.password)) { logTenantUsage(rt, { username, name: username }, 'login_failed', username, req); return bad(res, 401, 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง'); }
  const why = platform.lockReason(t); const plan = platform.planOf(t);
  if (why) { logTenantUsage(rt, u, 'login_blocked', why.slice(0, 60), req); return bad(res, 402, why, { plan, billing_token: u.role === 'owner' ? sign({ tid: t.id, sid: u.id, billing: true }, '2h') : null }); }
  rt.api.setUser(u); u.last_login = rt.api.nowStr(); rt.api.audit('auth.login', 'staff', u.id, u.username); rt.touch(); logTenantUsage(rt, u, 'login', username, req);
  res.json({ token: sign({ tid: t.id, sid: u.id }), user: { ...rt.api.userView(u), plan, tenant_code: t.code } });
});
T.use((req, res, next) => {
  const tk = readToken(req); if (!tk?.tid || tk.billing) return bad(res, 401, 'กรุณาเข้าสู่ระบบ');
  const rt = tenants.get(tk.tid); if (!rt || (!rt.row.verified && rt.persist)) return bad(res, 401, 'ไม่พบข้อมูลร้าน กรุณาเข้าสู่ระบบใหม่');
  const u = rt.api.DB.staff.find(s => s.id === tk.sid && s.active); if (!u) return bad(res, 401, 'บัญชีถูกปิดใช้งาน');
  const why = platform.lockReason(rt.row); if (why && !/^\/events/.test(req.path)) return bad(res, 402, why, { plan: platform.planOf(rt.row), billing_token: u.role === 'owner' ? sign({ tid: rt.id, sid: u.id, billing: true }, '2h') : null });
  req.rt = rt; req.user = u; req.tk = tk; rt.api.setUser(u); next();
});
T.get('/events', (req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' }); res.write(': connected\n\n'); tenants.addClient(req.rt.id, res); const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch { clearInterval(hb); } }, 25000); req.on('close', () => clearInterval(hb)); });
T.get('/auth/me', (req, res) => res.json({ user: { ...req.rt.api.userView(req.user), plan: platform.planOf(req.rt.row), tenant_code: req.rt.row.code }, ai_ready: true }));
T.put('/auth/password', (req, res) => { if (!req.rt.persist) return bad(res, 403, 'โหมดสาธิตเปลี่ยนรหัสผ่านไม่ได้'); if (!platform.verify(req.body.old_password, req.user.password)) return bad(res, 400, 'รหัสผ่านเดิมไม่ถูกต้อง'); const pw = String(req.body.new_password || ''); if (pw.length < 6) return bad(res, 400, 'รหัสผ่านใหม่ต้องมีอย่างน้อย 6 ตัวอักษร'); req.user.password = platform.hash(pw); if (req.user.username === req.rt.row.owner_email) { const u = platform.userByEmail(req.user.username); if (u) platform.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(req.user.password, u.id); } req.rt.touch(); res.json({ ok: true }); });
T.post('/auth/pin', limiter(10, 5 * 60e3), (req, res) => { const pin = String(req.body.pin || ''); const u = pin.length >= 4 ? req.rt.api.DB.staff.find(s => s.username === String(req.body.username || '').trim().toLowerCase() && s.pin && String(s.pin) === pin && s.active) : null; if (!u) { logTenantUsage(req.rt, req.user, 'login_failed', 'pin:' + String(req.body.username || ''), req); return bad(res, 401, 'PIN ไม่ถูกต้อง'); } logTenantUsage(req.rt, u, 'login', 'pin:' + u.username, req); res.json({ token: sign({ tid: req.rt.id, sid: u.id }), user: { ...req.rt.api.userView(u), plan: platform.planOf(req.rt.row), tenant_code: req.rt.row.code } }); });
T.post('/upload', upload.single('image'), (req, res) => { if (!req.file) return bad(res, 400, 'ไม่พบไฟล์รูป (รองรับเฉพาะรูปภาพ ≤ 8MB)'); res.json({ url: '/uploads/' + req.file.filename }); });
T.post('/ai/chat', async (req, res, next) => { if (!ai.ready()) return next(); try { const msgs = Array.isArray(req.body.messages) && req.body.messages.length ? req.body.messages : [{ role: 'user', content: req.body.message || '' }]; const r = await ai.ask(req.rt, msgs, req.rt.api.DB.settings.ai_persona); req.rt.api.ins('ai_logs', { staff_id: req.user.id, kind: 'copilot', prompt: msgs.slice(-1)[0]?.content || '', response: r.text, tokens_in: r.usage?.input_tokens || 0, tokens_out: r.usage?.output_tokens || 0, model: r.model || ai.MODEL }); req.rt.touch(); res.json({ ok: true, text: r.text, usage: { in: r.usage?.input_tokens || 0, out: r.usage?.output_tokens || 0 } }); } catch (e) { console.error('ai error', e.message); next(); } });
T.post('/ai/insight', async (req, res, next) => { if (!ai.ready()) return next(); try { const q = { daily: 'สรุปยอดขายวันนี้ทุกสาขา และข้อสังเกตที่ผู้บริหารควรรู้', marketing: 'แนะนำแคมเปญการตลาดสำหรับเดือนนี้จากข้อมูลร้าน', fraud: 'ตรวจความผิดปกติที่ควรตรวจสอบ', stock: 'สินค้าที่ต้องสั่งซื้อและจำนวนที่แนะนำ' }[req.body.topic] || String(req.body.topic || ''); const r = await ai.ask(req.rt, [{ role: 'user', content: q }], req.rt.api.DB.settings.ai_persona); res.json({ ok: true, text: r.text }); } catch (e) { console.error('ai error', e.message); next(); } });
T.get('/ai/status', (req, res, next) => { if (!ai.ready()) return next(); res.json({ ready: true, model: ai.MODEL, persona: req.rt.api.DB.settings.ai_persona, tools: ['ข้อมูลยอดขาย', 'สต็อก', 'ลูกหนี้', 'เอกสารรออนุมัติ'] }); });
T.post('/ai/test', (req, res, next) => { if (!ai.ready()) return next(); res.json({ ok: true, text: `เชื่อมต่อ Claude แล้ว (${ai.MODEL})` }); });
T.all(/.*/, (req, res) => {
  const method = req.method.toUpperCase(); const p = req.path; const params = new URLSearchParams(req.url.split('?')[1] || ''); const body = req.body || {};
  if (!req.rt.persist && method !== 'GET' && DEMO_BLOCK.test(p)) return bad(res, 403, 'โหมดสาธิตไม่อนุญาตให้แก้ไขส่วนนี้ (ข้อมูลสาธิตใช้ร่วมกันและรีเซ็ตทุกวัน) สมัครทดลองใช้ฟรีเพื่อใช้ร้านของคุณเอง');
  if (method !== 'GET' && body && 'password' in body && PW_PATHS.some(re => re.test(p))) { if (body.password === '' || body.password == null) delete body.password; else if (typeof body.password !== 'string' || body.password.length < 6 || body.password.length > 100) return bad(res, 400, 'รหัสผ่านต้องเป็นข้อความ 6-100 ตัวอักษร'); else body.password = platform.hash(body.password); }
  req.rt.api.tick();
  try { const out = req.rt.handle(method, p, body, params); if (method !== 'GET') { if (/^\/staff/.test(p)) req.rt.save(true); else req.rt.touch(); logTenantUsage(req.rt, req.user, 'action', method + ' ' + p, req); } res.json(out ?? {}); }
  catch (e) { const st = e.status && e.status >= 400 && e.status < 600 ? e.status : 400; if (st >= 500) console.error('tenant api error', p, e); res.status(st).json({ error: e.message || 'เกิดข้อผิดพลาด' }); }
});
app.use('/api/ac711', T);
app.use('/api', (req, res) => bad(res, 404, 'ไม่พบ endpoint'));
app.get(/^\/(?!api|uploads).*/, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use((err, req, res, next) => { if (res.headersSent) return next(err); const st = err.status || err.statusCode || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 400); if (st >= 500) console.error('server error', err); bad(res, st, err.code === 'LIMIT_FILE_SIZE' ? 'ไฟล์ใหญ่เกิน 8 MB' : err.type === 'entity.parse.failed' ? 'รูปแบบข้อมูล JSON ไม่ถูกต้อง' : err.message || 'เกิดข้อผิดพลาด'); });

/* ---------- start ---------- */
platform.ensureAdmin(); tenants.ensureDemo();
const server = app.listen(PORT, () => { console.log(`AC711 Cloud: ${BASE_URL} · mail: ${mail.configured ? 'SMTP' : 'preview'} · AI: ${ai.ready() ? ai.MODEL : 'จำลอง'} · data: ${platform.DATA_DIR}`); cron.start(BASE_URL); });
const shutdown = () => { console.log('saving tenants…'); tenants.saveAll(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000); };
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
module.exports = app;
