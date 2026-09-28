'use strict';
/* tenants.js — รันไทม์ข้อมูลร้านต่อผู้เช่า: โหลด API ของร้าน (build/tenant-api.js) ต่อร้าน 1 ชุด เก็บในหน่วยความจำ และบันทึกลง SQLite แบบหน่วงเวลาหลังทุกการเขียน */
const path = require('path');
const platform = require('./platform');
const createTenantApi = require(path.join(__dirname, '..', 'build', 'tenant-api.js'));
const PAGE_TABS = require('./page-tabs.json');

const SAVE_DELAY = +process.env.SAVE_DELAY_MS || 1500;
const runtimes = new Map();          // tenant_id → runtime
const sseClients = new Map();        // tenant_id → Set(res)

const TH_M = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const dd = s => { if (!s) return '-'; const d = new Date(String(s).replace(' ', 'T')); return isNaN(d) ? s : `${d.getDate()} ${TH_M[d.getMonth()]} ${d.getFullYear() + 543}`; };

function broadcast(tid, ev, data) { const set = sseClients.get(tid); if (!set) return; const msg = `event: ${ev}\ndata: ${JSON.stringify(data ?? {})}\n\n`; for (const res of set) { try { res.write(msg); } catch { set.delete(res); } } }

class TenantRuntime {
  constructor(row) {
    this.id = row.id; this.row = row; this.persist = row.persist !== 0; this.dirty = false; this.timer = null; this.saving = false;
    this.api = createTenantApi({ PAGE_TABS, dd, setTimeout: (fn) => setTimeout(fn, 0) });
    this.api.setEmitHook((ev, data) => broadcast(this.id, ev, data));
    const saved = this.persist ? platform.loadTenantData(this.id) : null;
    if (saved) { const data = JSON.parse(saved); Object.keys(data).forEach(k => { this.api.DB[k] = data[k]; }); }
    else if (!this.persist) { this.seedDemo(); }
    else { this.seedFresh(); this.save(true); }
  }
  seedDemo() { this.api.seedAll(); const h = platform.hash('ac1234'); this.api.DB.staff.forEach(s => { s.password = h; }); }
  seedFresh() {
    const { DB } = this.api; const u = platform.userByEmail(this.row.owner_email); let meta = {}; try { meta = JSON.parse(this.row.meta || '{}'); } catch {}
    this.api.seedAll(); this.api.applyReset('all');
    ['employees', 'att_devices', 'att_logs', 'attendance', 'eval_periods', 'evals', 'progress', 'points', 'posts', 'campaigns', 'contacts', 'messages', 'notifications', 'audit', 'ai_logs', 'lots', 'moves', 'branch_stock'].forEach(t => { if (Array.isArray(DB[t])) DB[t].length = 0; });
    // สาขา: สำนักงานใหญ่ 0000 ชื่อร้าน + สาขาตามจำนวนที่สมัคร + คลังออนไลน์ (ปิดไว้)
    const hq = DB.branches.find(b => b.is_hq); const online = DB.branches.find(b => b.is_online);
    DB.branches.length = 0; DB.branches.push({ ...hq, id: 1, code: '0000', name: `${this.row.company} (สำนักงานใหญ่)`, province: u?.province || '-', address: '', phone: u?.phone || '', color: '#f97316', active: 1 });
    const n = Math.max(0, Math.min(200, (+meta.branches || 1) - 1));
    for (let i = 1; i <= n; i++) { const code = String(i).padStart(4, '0'); DB.branches.push({ id: i + 1, code, name: `สาขา ${code}`, province: '-', address: '', phone: '', is_hq: 0, is_online: 0, color: '#fb923c', active: 1 }); }
    DB.branches.push({ ...online, id: n + 2, code: 'ONLINE', name: 'คลังออนไลน์', province: '-', address: '', phone: '', color: '#f59e0b', active: 0 });
    DB.seq.branches = n + 2;
    // ผู้ใช้: เจ้าของกิจการคนเดียว (รหัสผ่านตามอีเมลที่สมัคร)
    DB.staff.length = 0; DB.seq.staff = 0;
    this.api.ins('staff', { username: this.row.owner_email, password: u ? u.password_hash : platform.hash(platform.genPassword()), name: u?.name || 'เจ้าของกิจการ', role: 'owner', branch_id: 1, phone: u?.phone || '', email: this.row.owner_email, pin: '', active: 1, last_login: null, company: this.row.company });
    Object.assign(DB.settings, { company_name: this.row.company, company_tax_id: u?.taxid || '', company_address: '', receipt_footer: `ขอบคุณที่ใช้บริการ ${this.row.company}`, promptpay_id: '', ai_persona: 'น้อง AC711', emp_code_prefix: 'EMP' });
    DB.channels.forEach(c => { c.active = 0; c.config = {}; });
    DB.rules && DB.rules.forEach(r => { r.branch_id = null; });
  }
  handle(method, p, body, params) { const { R } = this.api; this.api.tick(); for (const [m, re, fn] of R) { if (m !== method) continue; const mm = p.match(re); if (mm) return fn(mm, body, params); } const e = new Error('ไม่พบ endpoint ' + method + ' ' + p); e.status = 404; throw e; }
  usernames() { return this.api.DB.staff.filter(s => s.active).map(s => String(s.username).toLowerCase()); }
  touch() { if (!this.persist) return; this.dirty = true; if (this.timer) return; this.timer = setTimeout(() => { this.timer = null; this.save(); }, SAVE_DELAY); }
  save(force = false) { if (!this.persist || (!this.dirty && !force)) return; this.dirty = false; try { platform.saveTenantData(this.id, JSON.stringify(this.api.DB), this.usernames()); } catch (e) { console.error('save tenant failed', this.id, e.message); this.dirty = true; } }
}

function get(tid) { let rt = runtimes.get(tid); if (rt) return rt; const row = platform.tenant(tid); if (!row) return null; rt = new TenantRuntime(row); runtimes.set(tid, rt); return rt; }
function refreshRow(tid) { const rt = runtimes.get(tid); if (rt) rt.row = platform.tenant(tid) || rt.row; }
function evict(tid) { const rt = runtimes.get(tid); if (rt) { if (rt.timer) { clearTimeout(rt.timer); rt.timer = null; } rt.save(true); rt.persist = false; runtimes.delete(tid); } }
function saveAll() { for (const rt of runtimes.values()) rt.save(); }
function addClient(tid, res) { if (!sseClients.has(tid)) sseClients.set(tid, new Set()); sseClients.get(tid).add(res); res.on('close', () => sseClients.get(tid)?.delete(res)); }
function reseedDemo() { const old = runtimes.get('demo'); runtimes.delete('demo'); const rt = get('demo'); if (old) { const set = sseClients.get('demo'); if (set) for (const res of set) { try { res.write('event: notify\ndata: {"title":"ข้อมูลสาธิตถูกรีเซ็ต","body":"โหลดหน้าใหม่เพื่อดูข้อมูลล่าสุด"}\n\n'); } catch { } } } return rt; }
function ensureDemo() { if (!platform.tenant('demo')) { platform.db.prepare("INSERT INTO tenants (id, code, company, plan, verified, owner_email, persist) VALUES ('demo', 'DEMO', 'ร้าน AC711 ออโต้พาร์ท (สาธิต)', 'annual', 1, 'demo@ac711.com', 0)").run(); } get('demo'); }

setInterval(saveAll, 30000).unref();
module.exports = { get, refreshRow, evict, saveAll, addClient, ensureDemo, reseedDemo, PAGE_TABS };
