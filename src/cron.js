'use strict';
/* cron.js — งานตามเวลา: เตือนก่อนหมดอายุ 7 วัน/1 วัน, ลบผู้สมัครที่ไม่ยืนยันอีเมลใน 30 วัน, บันทึกข้อมูลร้านที่ค้าง */
const platform = require('./platform');
const mail = require('./mail');
const tenants = require('./tenants');

let lastDemoReset = Date.now();
async function runOnce(baseUrl) {
  const cfg = platform.site();
  for (const t of platform.db.prepare('SELECT * FROM tenants WHERE persist = 1 AND verified = 1 AND locked = 0').all()) {
    const d = platform.daysLeft(t); if (d == null) continue; let meta = {}; try { meta = JSON.parse(t.meta || '{}'); } catch {}
    for (const n of [7, 1]) { if (d === n && !meta['reminded_' + n + '_' + platform.expiryOf(t)]) { const u = platform.userByEmail(t.owner_email); try { await mail.send(cfg, 'reminder', t.owner_email, { name: u?.name || '', company: t.company, days: n, expiry: platform.expiryOf(t), label: platform.statusOf(t)[1], total: platform.priceVat(cfg).toLocaleString('th-TH'), url: baseUrl + '/#/login' }); meta['reminded_' + n + '_' + platform.expiryOf(t)] = true; platform.updateTenant(t.id, { meta: JSON.stringify(meta) }); platform.logUsage({ tenant_id: t.id, tenant: t.company, email: t.owner_email, type: 'reminder', detail: `เตือนหมดอายุใน ${n} วัน` }); } catch (e) { console.error('reminder failed', t.id, e.message); } } }
  }
  // ลบบัญชีที่ไม่ยืนยันอีเมลภายใน 30 วัน (ตามประกาศความเป็นส่วนตัว)
  const stale = platform.db.prepare("SELECT id FROM tenants WHERE verified = 0 AND persist = 1 AND created_at < datetime('now', '-30 days')").all();
  stale.forEach(r => { tenants.evict(r.id); platform.deleteTenant(r.id); });
  platform.pruneUsage(400);
  tenants.saveAll();
  // รีเซ็ตร้านสาธิตวันละครั้ง (ข้อมูลสาธิตอยู่ในหน่วยความจำ ใช้ร่วมกันทุกคน)
  if (Date.now() - lastDemoReset > 24 * 60 * 60e3) { lastDemoReset = Date.now(); tenants.reseedDemo(); }
}
function start(baseUrl) { const tick = () => runOnce(baseUrl).catch(e => console.error('cron error', e.message)); setTimeout(tick, 15000); setInterval(tick, 60 * 60 * 1000).unref(); }
module.exports = { start, runOnce };
