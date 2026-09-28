'use strict';
/* mail.js — ส่งอีเมลผ่าน SMTP (nodemailer) ถ้าตั้งค่า SMTP_HOST ไว้ มิฉะนั้นเป็นโหมด preview (คืนเนื้อหาให้หน้าเว็บแสดงในกล่องจดหมายจำลอง + log) */
let transporter = null;
const configured = !!process.env.SMTP_HOST;
if (configured) {
  const nodemailer = require('nodemailer');
  transporter = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: +process.env.SMTP_PORT || 587, secure: process.env.SMTP_SECURE === 'true', auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined });
}
const FROM = process.env.MAIL_FROM || 'AC711 <no-reply@ac711.com>';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function layout(cfg, title, body) {
  return `<!doctype html><html lang="th"><body style="margin:0;background:#f3f4f6;font-family:Prompt,'Segoe UI',Arial,sans-serif;color:#1f2329"><div style="max-width:560px;margin:24px auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #dfe2e7"><div style="background:#f97316;color:#fff;padding:18px 24px;font-weight:800;font-size:18px">${esc(cfg.brand || 'AC711')} · ${esc(cfg.site || '')}</div><div style="padding:24px;line-height:1.8;font-size:15px"><h2 style="margin:0 0 12px;font-size:18px">${esc(title)}</h2>${body}<p style="color:#8a919b;font-size:12px;margin-top:24px">อีเมลนี้ส่งจากระบบอัตโนมัติ ${esc(cfg.site || '')} · ติดต่อ ${esc(cfg.sales_email || '')}</p></div></div></body></html>`;
}
const btn = (url, label) => `<p style="margin:20px 0"><a href="${esc(url)}" style="display:inline-block;background:#f97316;color:#fff;text-decoration:none;padding:12px 22px;border-radius:12px;font-weight:700">${esc(label)}</a></p><p style="font-size:12px;color:#5f6772">หากกดปุ่มไม่ได้ ให้คัดลอกลิงก์นี้: ${esc(url)}</p>`;

const templates = {
  verify: (cfg, d) => ({ subject: `ยืนยันอีเมลและรหัสผ่านทดลองใช้ ${cfg.brand}`, html: layout(cfg, `ยินดีต้อนรับสู่ ${cfg.brand}`, `<p>สวัสดีคุณ${esc(d.name)}</p><p>ขอบคุณที่สมัครใช้บริการสำหรับ <b>${esc(d.company)}</b> นี่คือข้อมูลเข้าใช้งานของคุณ</p><div style="background:#f7f8fa;border:1px solid #dfe2e7;border-radius:12px;padding:14px 16px"><div style="font-size:12px;color:#5f6772">ชื่อผู้ใช้</div><div style="font-weight:700">${esc(d.email)}</div><div style="font-size:12px;color:#5f6772;margin-top:8px">รหัสผ่านชั่วคราว</div><div style="font-family:monospace;font-size:20px;letter-spacing:.12em;font-weight:700">${esc(d.password)}</div><div style="font-size:12px;color:#5f6772;margin-top:8px">รหัสร้าน (ใช้เมื่อพนักงานเข้าสู่ระบบ)</div><div style="font-weight:700">${esc(d.code)}</div></div><p>กดปุ่มด้านล่างเพื่อยืนยันอีเมล ระยะทดลองใช้ฟรี ${esc(cfg.trial_days)} วันจะเริ่มนับทันทีที่ยืนยัน แนะนำให้เปลี่ยนรหัสผ่านหลังเข้าสู่ระบบครั้งแรก</p>${btn(d.url, 'ยืนยันอีเมลและเริ่มใช้งาน')}`) }),
  newpass: (cfg, d) => ({ subject: `${cfg.brand}: รหัสผ่านใหม่สำหรับ ${d.company}`, html: layout(cfg, 'รหัสผ่านใหม่', `<p>สวัสดีคุณ${esc(d.name)}</p><p>ผู้ดูแลระบบได้ตั้งรหัสผ่านใหม่ให้บัญชี <b>${esc(d.email)}</b> (รหัสร้าน ${esc(d.code)})</p><p>รหัสผ่านใหม่: <b style="font-size:20px;letter-spacing:2px">${esc(d.password)}</b></p><p>แนะนำให้เปลี่ยนรหัสผ่านหลังเข้าสู่ระบบ</p>${btn(d.url, 'เข้าสู่ระบบ')}`) }),
  reset: (cfg, d) => ({ subject: `ตั้งรหัสผ่านใหม่สำหรับ ${cfg.brand}`, html: layout(cfg, 'ตั้งรหัสผ่านใหม่', `<p>สวัสดีคุณ${esc(d.name)}</p><p>มีคำขอตั้งรหัสผ่านใหม่สำหรับบัญชี <b>${esc(d.email)}</b> หากท่านไม่ได้ขอ กรุณาเพิกเฉยต่ออีเมลนี้ ลิงก์มีอายุ 60 นาที</p>${btn(d.url, 'ตั้งรหัสผ่านใหม่')}`) }),
  reminder: (cfg, d) => ({ subject: `${cfg.brand}: บัญชีของ ${d.company} จะหมดอายุใน ${d.days} วัน`, html: layout(cfg, `แพ็กเกจจะหมดอายุใน ${d.days} วัน`, `<p>สวัสดีคุณ${esc(d.name)}</p><p>บัญชี <b>${esc(d.company)}</b> (${esc(d.label)}) จะหมดอายุวันที่ <b>${esc(d.expiry)}</b> เมื่อครบกำหนดระบบจะล็อกการใช้งานชั่วคราว ข้อมูลของท่านยังอยู่ครบ</p><p>ค่าบริการรายปี ${esc(d.total)} บาท (รวม VAT) ${esc(cfg.bank_info)} ชำระแล้วเข้าสู่ระบบและกด "แจ้งชำระเงิน" เพื่อให้ผู้ดูแลระบบเปิดใช้งานต่อ</p>${btn(d.url, 'เข้าสู่ระบบ')}`) }),
  approved: (cfg, d) => ({ subject: `${cfg.brand}: เปิดใช้งานแพ็กเกจรายปีแล้ว (${d.invoice_no})`, html: layout(cfg, 'เปิดใช้งานรายปีเรียบร้อย', `<p>สวัสดีคุณ${esc(d.name)}</p><p>เราได้รับชำระเงินของ <b>${esc(d.company)}</b> แล้ว แพ็กเกจรายปีใช้งานได้ถึงวันที่ <b>${esc(d.until)}</b></p><p>ใบกำกับภาษี/ใบเสร็จรับเงินเลขที่ <b>${esc(d.invoice_no)}</b> ดูและพิมพ์ได้จากเมนูผู้ใช้ → แพ็กเกจรายปี</p>${btn(d.url, 'เข้าสู่ระบบ')}`) }),
  rejected: (cfg, d) => ({ subject: `${cfg.brand}: การแจ้งชำระเงินยังไม่ผ่านการตรวจสอบ`, html: layout(cfg, 'ตรวจสอบการชำระเงินไม่สำเร็จ', `<p>สวัสดีคุณ${esc(d.name)}</p><p>การแจ้งชำระเงินของ <b>${esc(d.company)}</b> ยอด ${esc(d.amount)} บาท ยังไม่ผ่านการตรวจสอบ เหตุผล: ${esc(d.note || '-')}</p><p>กรุณาตรวจสอบและแจ้งชำระเงินใหม่อีกครั้ง หรือติดต่อ ${esc(cfg.sales_email)}</p>`) }),
};

async function send(cfg, type, to, data) {
  const t = templates[type](cfg, data);
  const msg = { from: FROM, to, subject: t.subject, html: t.html };
  if (transporter) { await transporter.sendMail(msg); return { sent: true }; }
  console.log(`[mail preview] to=${to} subject=${t.subject}`);
  return { sent: false, preview: { to, subject: t.subject, html: t.html, data } };
}
module.exports = { send, configured };
