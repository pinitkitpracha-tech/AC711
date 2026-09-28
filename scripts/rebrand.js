#!/usr/bin/env node
/* rebrand.js — โคลนระบบเป็นแบรนด์ใหม่: เปลี่ยนชื่อ โดเมน อีเมล ตัวย่อโลโก้ ในทุกไฟล์ที่ผู้ใช้เห็น
   ใช้: node scripts/rebrand.js --name "NEWBRAND" --domain www.newbrand.com --email sales@newbrand.com --mark "NB"
   ไม่แตะชื่อภายในของโค้ด (เส้นทาง /api/ac711, คีย์ localStorage ac711_*, ตัวแปร AC711_*, ชื่อไฟล์ ac711.html) */
const fs = require('fs');
const path = require('path');

const args = {}; for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const NAME = (args.name || '').trim(); const DOMAIN = (args.domain || '').trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
if (!NAME || !DOMAIN) { console.error('ใช้: node scripts/rebrand.js --name "NEWBRAND" --domain www.newbrand.com [--email sales@newbrand.com] [--mark "NB"]'); process.exit(1); }
const BARE = DOMAIN.replace(/^www\./, ''); const EMAIL = args.email || 'sales@' + BARE; const MARK = (args.mark || NAME.replace(/[^A-Za-z0-9]/g, '').slice(0, 3) || 'NEW').toUpperCase();
const ROOT = path.join(__dirname, '..');
const FILES = ['ac711.html', 'src/site-defaults.json', 'src/mail.js', 'src/tenants.js', 'src/ai.js', 'server.js', 'README.md', 'render.yaml', '.env.example', 'docs/USER-GUIDE.md', 'docs/AC711-CLOUD.md', 'docs/CLONE-SPEC.md', 'package.json'];
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
let total = 0;
for (const f of FILES) {
  const p = path.join(ROOT, f); if (!fs.existsSync(p)) continue;
  let s = fs.readFileSync(p, 'utf8'); const before = s; let n = 0;
  const rep = (re, to) => { s = s.replace(re, m => { n++; return typeof to === 'function' ? to(m) : to; }); };
  rep(/www\.ac711\.com/g, DOMAIN);                                   // โดเมนเต็ม
  rep(/https:\/\/ac711\.com/g, 'https://' + BARE);                     // root domain ใน URL
  rep(/sales@ac711\.com/g, EMAIL);                                     // อีเมลฝ่ายขาย
  rep(/no-reply@ac711\.com/g, 'no-reply@' + BARE);                     // ผู้ส่งอีเมล
  rep(/demo@ac711\.com/g, 'demo@' + BARE);                             // อีเมลร้านสาธิต
  rep(/@ac711autoparts/g, '@' + BARE.split('.')[0]);                   // LINE id ตัวอย่าง
  rep(/class="mark">711</g, `class="mark">${MARK}<`);                  // ตัวย่อบนโลโก้
  rep(/AC711AutoParts/g, NAME.replace(/[^A-Za-z0-9]/g, '') + 'AutoParts');       // ชื่อบัญชีตัวอย่างในข้อมูลสาธิต
  rep(/AC711(?![_A-Za-z0-9])/g, NAME);                                 // ชื่อแบรนด์ที่แสดง (เว้นตัวแปร AC711_*)
  if (f === 'README.md' || f === 'docs/CLONE-SPEC.md') rep(/pinitkitpracha-tech\/ac711/g, '<owner>/<repo>');
  if (s !== before) { fs.writeFileSync(p, s); console.log(`${f}: ${n} จุด`); total += n; }
}
console.log(`\nเปลี่ยนแบรนด์เป็น "${NAME}" (${DOMAIN}, ${EMAIL}, โลโก้ ${MARK}) รวม ${total} จุด\nถัดไป: npm install && npm test`);
