'use strict';
/* ai.js — เชื่อม Claude จริงเมื่อมี ANTHROPIC_API_KEY (ไม่มีคีย์ → ใช้คำตอบจำลองจาก tenant-api ตามเดิม) */
const MODEL = process.env.AI_MODEL || 'claude-opus-5';
let client = null;
function ready() { return !!process.env.ANTHROPIC_API_KEY; }
function getClient() { if (!client) { const Anthropic = require('@anthropic-ai/sdk'); client = new Anthropic(); } return client; }

/* สรุปข้อมูลร้านให้ Claude ใช้ตอบ (เฉพาะตัวเลขรวม ไม่ส่งข้อมูลส่วนบุคคลของลูกค้า) */
function contextOf(rt) {
  const { DB } = rt.api; const today = new Date().toISOString().slice(0, 10);
  const live = DB.sales.filter(s => s.status !== 'void'); const todayS = live.filter(s => String(s.created_at).startsWith(today));
  const month = live.filter(s => String(s.created_at).slice(0, 7) === today.slice(0, 7));
  const sum = a => a.reduce((t, s) => t + (+s.total || 0), 0);
  const byBranch = {}; todayS.forEach(s => { const b = DB.branches.find(x => x.id === s.branch_id); const k = b ? b.name : '?'; byBranch[k] = (byBranch[k] || 0) + s.total; });
  const onHand = (bid, pid) => DB.lots.filter(l => l.branch_id === bid && l.product_id === pid).reduce((t, l) => t + l.qty, 0);
  const low = []; DB.branch_stock.forEach(bs => { const q = onHand(bs.branch_id, bs.product_id); if (bs.min_qty && q <= bs.min_qty) { const p = DB.products.find(x => x.id === bs.product_id); const b = DB.branches.find(x => x.id === bs.branch_id); if (p && b) low.push(`${p.sku} ${p.name} @${b.code} เหลือ ${q} (min ${bs.min_qty})`); } });
  const pend = (DB.approvals || []).filter(a => a.status === 'pending').length;
  const ar = (DB.ar || []).filter(i => ['open', 'partial'].includes(i.status)).reduce((t, i) => t + (i.amount - i.paid - (i.credited || 0)), 0);
  return [`ร้าน: ${DB.settings.company_name || '-'} · สาขา ${DB.branches.filter(b => b.active).length} แห่ง · วันที่ ${today}`,
    `ยอดขายวันนี้ ${sum(todayS).toFixed(0)} บาท (${todayS.length} บิล) · เดือนนี้ ${sum(month).toFixed(0)} บาท (${month.length} บิล)`,
    `ยอดวันนี้แยกสาขา: ${Object.entries(byBranch).map(([k, v]) => `${k} ${v.toFixed(0)}`).join(', ') || '-'}`,
    `สินค้าต่ำกว่า Min (${low.length}): ${low.slice(0, 15).join('; ') || '-'}`,
    `เอกสารรออนุมัติ ${pend} รายการ · ลูกหนี้คงค้าง ${ar.toFixed(0)} บาท · สินค้าทั้งหมด ${DB.products.length} รายการ`].join('\n');
}

async function ask(rt, messages, persona) {
  const c = getClient();
  const system = `คุณคือ "${persona || 'น้อง AC711'}" ผู้ช่วย AI ของระบบบริหารร้านอะไหล่รถยนต์ AC711 ตอบเป็นภาษาไทย กระชับ ใช้ตัวเลขจากข้อมูลร้านด้านล่างเท่านั้น ห้ามเดาตัวเลขที่ไม่มีในข้อมูล ถ้าข้อมูลไม่พอให้บอกว่าต้องดูที่เมนูใดในระบบ\n\nข้อมูลร้าน ณ ตอนนี้:\n${contextOf(rt)}`;
  const res = await c.beta.messages.create({ model: MODEL, max_tokens: 2048, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default', system, messages: messages.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '') })).filter(m => m.content) });
  if (res.stop_reason === 'refusal') return { text: 'ขออภัย คำถามนี้ระบบไม่สามารถตอบได้', usage: res.usage };
  return { text: res.content.filter(b => b.type === 'text').map(b => b.text).join('\n'), usage: res.usage, model: res.model };
}
module.exports = { ready, ask, MODEL };
