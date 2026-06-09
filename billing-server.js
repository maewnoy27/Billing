/* ============================================================
 *  ระบบวางบิล & เก็บเงิน (Billing & Payment System)
 *  Backend: Express + ที่เก็บข้อมูลแบบ pure-JS (ไฟล์ JSON)
 *  ------------------------------------------------------------
 *  ไม่มี native module → build/deploy ผ่านทุกแพลตฟอร์ม
 *  (ไม่ต้องคอมไพล์ better-sqlite3 อีกต่อไป)
 *
 *  ฟีเจอร์ครบ 8 ข้อ:
 *   1. สร้างใบวางบิลอัตโนมัติ   2. ใบเสร็จรับเงิน
 *   3. จัดการฐานข้อมูลลูกค้า     4. ตรวจสอบสถานะการชำระ
 *   5. แจ้งเตือนเมื่อถึงกำหนด    6. สถานะ รอชำระ/ชำระแล้ว/ค้างชำระ
 *   7. ส่งเอกสารผ่านอีเมล/SMS   8. รายงาน & Dashboard รายวัน/รายเดือน
 * ============================================================ */

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');

let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch (_) { /* optional */ }

const app = express();

/* ─────────────────────────────────────────────────────────────
 *  DATA STORE (JSON file, pure-JS — ไม่มี native dependency)
 * ───────────────────────────────────────────────────────────── */
const DB_FILE = process.env.DATA_FILE || path.join(__dirname, 'billing-data.json');

const store = {
  seq: { admin: 0, customer: 0, invoice: 0, item: 0, payment: 0, notif: 0 },
  admins: [],
  settings: {},
  customers: [],
  invoices: [],
  invoice_items: [],
  payments: [],
  notifications: [],
};

function load() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      Object.assign(store, data);
      for (const k of Object.keys(store.seq)) if (store.seq[k] == null) store.seq[k] = 0;
    }
  } catch (e) {
    console.error('⚠️  อ่านไฟล์ข้อมูลไม่สำเร็จ เริ่มต้นใหม่:', e.message);
  }
}

let saveTimer = null;
function save() {
  // เขียนแบบ debounce กันเขียนถี่เกินไป
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(DB_FILE, JSON.stringify(store)); }
    catch (e) { console.error('⚠️  บันทึกข้อมูลไม่สำเร็จ:', e.message); }
  }, 50);
}
function saveNow() {
  clearTimeout(saveTimer);
  try { fs.writeFileSync(DB_FILE, JSON.stringify(store)); }
  catch (e) { console.error('⚠️  บันทึกข้อมูลไม่สำเร็จ:', e.message); }
}

load();

/* ─── seed admin (admin / admin1234) ─── */
if (!store.admins.find(a => a.username === 'admin')) {
  store.admins.push({ id: ++store.seq.admin, username: 'admin', password: bcrypt.hashSync('admin1234', 10) });
  console.log('✅ สร้าง admin เริ่มต้น: username=admin / password=admin1234');
  save();
}

/* ─── seed default company settings ─── */
const DEFAULT_SETTINGS = {
  company_name: 'บริษัท ตัวอย่าง จำกัด',
  company_address: '123 ถนนตัวอย่าง แขวง/ตำบล เขต/อำเภอ จังหวัด 10000',
  company_phone: '02-000-0000',
  company_email: 'billing@example.com',
  company_tax_id: '0000000000000',
  default_tax_rate: '7',
  default_due_days: '30',
  reminder_days_before: '3',
};
let settingsChanged = false;
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
  if (store.settings[k] === undefined) { store.settings[k] = v; settingsChanged = true; }
}
if (settingsChanged) save();

/* ─────────────────────────────────────────────────────────────
 *  MIDDLEWARE
 * ───────────────────────────────────────────────────────────── */
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'billing-secret-key-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 3600000 },
}));

function requireAuth(req, res, next) {
  if (req.session && req.session.adminId) return next();
  res.status(401).json({ success: false, message: 'กรุณาเข้าสู่ระบบก่อน' });
}

/* ─────────────────────────────────────────────────────────────
 *  HELPERS
 * ───────────────────────────────────────────────────────────── */
const todayStr = () => new Date().toISOString().slice(0, 10);
const STATUS_TH = { pending: 'รอชำระ', paid: 'ชำระแล้ว', overdue: 'ค้างชำระ' };
const fmtMoney = n => Number(n || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const round2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const getSettings = () => ({ ...store.settings });

function nextCustomerCode() {
  let max = 0;
  for (const c of store.customers) {
    const m = /^CUST-(\d+)$/.exec(c.code || '');
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return 'CUST-' + String(max + 1).padStart(4, '0');
}

function nextDocNo(prefix) {
  const ym = new Date().toISOString().slice(0, 7).replace('-', ''); // YYYYMM
  const re = new RegExp(`^${prefix}-${ym}-(\\d+)$`);
  const list = prefix === 'INV' ? store.invoices.map(i => i.invoice_no) : store.payments.map(p => p.receipt_no);
  let max = 0;
  for (const no of list) { const m = re.exec(no || ''); if (m) max = Math.max(max, parseInt(m[1], 10)); }
  return `${prefix}-${ym}-${String(max + 1).padStart(4, '0')}`;
}

function computeTotals(items, discount, taxRate) {
  const subtotal = items.reduce((s, it) => s + Number(it.quantity) * Number(it.unit_price), 0);
  const disc = Number(discount) || 0;
  const taxable = Math.max(subtotal - disc, 0);
  const taxAmount = round2(taxable * (Number(taxRate) || 0) / 100);
  const total = round2(taxable + taxAmount);
  return { subtotal: round2(subtotal), discount: disc, taxAmount, total };
}

function deriveStatus(inv) {
  if (inv.paid_amount >= inv.total - 0.001 && inv.total > 0) return 'paid';
  if (inv.due_date && inv.due_date < todayStr()) return 'overdue';
  return 'pending';
}

function refreshInvoiceStatus(id) {
  const inv = store.invoices.find(i => i.id === Number(id));
  if (inv) inv.status = deriveStatus(inv);
}

function refreshAllOverdue() {
  let changed = false;
  for (const inv of store.invoices) {
    if (inv.status === 'paid') continue;
    const s = deriveStatus(inv);
    if (s !== inv.status) { inv.status = s; changed = true; }
  }
  if (changed) save();
}

function customerOutstanding(customerId) {
  return round2(store.invoices
    .filter(i => i.customer_id === customerId && i.status !== 'paid')
    .reduce((s, i) => s + (i.total - i.paid_amount), 0));
}
function customerInvoiceCount(customerId) {
  return store.invoices.filter(i => i.customer_id === customerId).length;
}

function loadInvoice(id) {
  const inv = store.invoices.find(i => i.id === Number(id));
  if (!inv) return null;
  const out = { ...inv };
  out.customer = store.customers.find(c => c.id === inv.customer_id) || {};
  out.items = store.invoice_items.filter(it => it.invoice_id === inv.id);
  out.payments = store.payments.filter(p => p.invoice_id === inv.id).sort((a, b) => a.id - b.id);
  out.status_th = STATUS_TH[inv.status];
  return out;
}

/* ─────────────────────────────────────────────────────────────
 *  EMAIL / SMS (ฟีเจอร์ 7)
 * ───────────────────────────────────────────────────────────── */
let mailer = null;
if (nodemailer && process.env.SMTP_HOST) {
  mailer = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  console.log('📧 เปิดใช้งานการส่งอีเมลผ่าน SMTP:', process.env.SMTP_HOST);
} else {
  console.log('📧 โหมดจำลองการส่งอีเมล/SMS (ยังไม่ได้ตั้งค่า SMTP_HOST)');
}

async function sendNotification({ invoiceId, channel, docType, recipient, subject, message }) {
  let status = 'simulated';
  let error = null;
  try {
    if (channel === 'email' && mailer) {
      await mailer.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER || 'billing@example.com',
        to: recipient, subject, text: message,
        html: `<pre style="font-family:Tahoma,sans-serif;font-size:14px">${message.replace(/</g, '&lt;')}</pre>`,
      });
      status = 'sent';
    }
  } catch (e) {
    status = 'failed';
    error = String(e.message || e);
  }
  store.notifications.push({
    id: ++store.seq.notif, invoice_id: invoiceId || null, channel, doc_type: docType,
    recipient: recipient || '', subject: subject || '', message: message || '',
    status, error, created_at: new Date().toISOString(),
  });
  save();
  return { status, error };
}

function buildDocMessage(inv, docType) {
  const s = getSettings();
  const lines = [];
  if (docType === 'receipt') {
    const pay = inv.payments[inv.payments.length - 1];
    lines.push(`ใบเสร็จรับเงิน เลขที่ ${pay ? pay.receipt_no : ''}`);
  } else if (docType === 'reminder') {
    lines.push(`แจ้งเตือนการชำระเงิน — ใบวางบิล ${inv.invoice_no}`);
  } else {
    lines.push(`ใบวางบิล/ใบแจ้งหนี้ เลขที่ ${inv.invoice_no}`);
  }
  lines.push('', `เรียน คุณ${inv.customer.name}`, `จาก: ${s.company_name}`,
    `วันที่ออก: ${inv.issue_date}`, `กำหนดชำระ: ${inv.due_date}`, '', 'รายการ:');
  inv.items.forEach((it, i) => lines.push(`  ${i + 1}. ${it.description} x${it.quantity} = ${fmtMoney(it.amount)} บาท`));
  lines.push('', `ยอดสุทธิ: ${fmtMoney(inv.total)} บาท`, `ชำระแล้ว: ${fmtMoney(inv.paid_amount)} บาท`,
    `คงเหลือ: ${fmtMoney(inv.total - inv.paid_amount)} บาท`, `สถานะ: ${STATUS_TH[inv.status]}`, '',
    `ติดต่อสอบถาม: ${s.company_phone} / ${s.company_email}`);
  return lines.join('\n');
}

/* ─────────────────────────────────────────────────────────────
 *  AUTH
 * ───────────────────────────────────────────────────────────── */
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  const admin = store.admins.find(a => a.username === username);
  if (!admin || !bcrypt.compareSync(password || '', admin.password)) {
    return res.json({ success: false, message: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
  }
  req.session.adminId = admin.id;
  req.session.adminUsername = admin.username;
  res.json({ success: true, username: admin.username });
});

app.post('/api/auth/logout', (req, res) => req.session.destroy(() => res.json({ success: true })));

app.get('/api/auth/me', (req, res) => {
  if (req.session && req.session.adminId) res.json({ loggedIn: true, username: req.session.adminUsername });
  else res.json({ loggedIn: false });
});

app.post('/api/auth/change-password', requireAuth, (req, res) => {
  const { oldPassword, newPassword } = req.body;
  const admin = store.admins.find(a => a.id === req.session.adminId);
  if (!bcrypt.compareSync(oldPassword || '', admin.password)) {
    return res.json({ success: false, message: 'รหัสผ่านเดิมไม่ถูกต้อง' });
  }
  if (!newPassword || newPassword.length < 6) {
    return res.json({ success: false, message: 'รหัสผ่านใหม่ต้องมีอย่างน้อย 6 ตัวอักษร' });
  }
  admin.password = bcrypt.hashSync(newPassword, 10);
  saveNow();
  res.json({ success: true, message: 'เปลี่ยนรหัสผ่านสำเร็จ' });
});

/* ─────────────────────────────────────────────────────────────
 *  SETTINGS
 * ───────────────────────────────────────────────────────────── */
app.get('/api/settings', requireAuth, (req, res) => res.json({ success: true, data: getSettings() }));

app.put('/api/settings', requireAuth, (req, res) => {
  for (const [k, v] of Object.entries(req.body || {})) store.settings[k] = String(v);
  saveNow();
  res.json({ success: true, data: getSettings() });
});

/* ─────────────────────────────────────────────────────────────
 *  CUSTOMERS (ฟีเจอร์ 3)
 * ───────────────────────────────────────────────────────────── */
app.get('/api/customers', requireAuth, (req, res) => {
  const { search = '', page = 1, limit = 50 } = req.query;
  let rows = store.customers.slice();
  if (search) {
    const q = String(search).toLowerCase();
    rows = rows.filter(c =>
      (c.name || '').toLowerCase().includes(q) || (c.phone || '').toLowerCase().includes(q) ||
      (c.email || '').toLowerCase().includes(q) || (c.code || '').toLowerCase().includes(q));
  }
  rows.sort((a, b) => b.id - a.id);
  const total = rows.length;
  const offset = (page - 1) * limit;
  const paged = rows.slice(offset, offset + Number(limit)).map(c => ({
    ...c, invoice_count: customerInvoiceCount(c.id), outstanding: customerOutstanding(c.id),
  }));
  res.json({ success: true, data: paged, total, page: Number(page) });
});

app.get('/api/customers/:id', requireAuth, (req, res) => {
  const c = store.customers.find(x => x.id === Number(req.params.id));
  if (!c) return res.status(404).json({ success: false, message: 'ไม่พบลูกค้า' });
  const out = { ...c, invoices: store.invoices.filter(i => i.customer_id === c.id).sort((a, b) => b.id - a.id) };
  res.json({ success: true, data: out });
});

app.post('/api/customers', requireAuth, (req, res) => {
  const { name, contact_name, phone, email, address, tax_id, note } = req.body;
  if (!name || !name.trim()) return res.json({ success: false, message: 'กรุณากรอกชื่อลูกค้า' });
  const c = {
    id: ++store.seq.customer, code: nextCustomerCode(), name: name.trim(),
    contact_name: contact_name || '', phone: phone || '', email: email || '',
    address: address || '', tax_id: tax_id || '', note: note || '', created_at: new Date().toISOString(),
  };
  store.customers.push(c); saveNow();
  res.json({ success: true, id: c.id, message: 'เพิ่มลูกค้าสำเร็จ' });
});

app.put('/api/customers/:id', requireAuth, (req, res) => {
  const c = store.customers.find(x => x.id === Number(req.params.id));
  if (!c) return res.status(404).json({ success: false, message: 'ไม่พบลูกค้า' });
  const { name, contact_name, phone, email, address, tax_id, note } = req.body;
  if (!name || !name.trim()) return res.json({ success: false, message: 'กรุณากรอกชื่อลูกค้า' });
  Object.assign(c, {
    name: name.trim(), contact_name: contact_name || '', phone: phone || '', email: email || '',
    address: address || '', tax_id: tax_id || '', note: note || '',
  });
  saveNow();
  res.json({ success: true, message: 'แก้ไขข้อมูลลูกค้าสำเร็จ' });
});

app.delete('/api/customers/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (customerInvoiceCount(id) > 0) return res.json({ success: false, message: 'ลบไม่ได้ เนื่องจากมีใบวางบิลของลูกค้ารายนี้อยู่' });
  store.customers = store.customers.filter(c => c.id !== id);
  saveNow();
  res.json({ success: true, message: 'ลบลูกค้าสำเร็จ' });
});

/* ─────────────────────────────────────────────────────────────
 *  INVOICES (ฟีเจอร์ 1, 4, 6)
 * ───────────────────────────────────────────────────────────── */
function cleanItems(items) {
  return (items || [])
    .filter(it => it.description && it.description.trim())
    .map(it => ({
      description: it.description.trim(),
      quantity: Number(it.quantity) || 0,
      unit_price: Number(it.unit_price) || 0,
      amount: round2((Number(it.quantity) || 0) * (Number(it.unit_price) || 0)),
    }));
}

app.get('/api/invoices', requireAuth, (req, res) => {
  refreshAllOverdue();
  const { search = '', status = '', customer_id = '', from = '', to = '' } = req.query;
  let rows = store.invoices.slice();
  if (status) rows = rows.filter(i => i.status === status);
  if (customer_id) rows = rows.filter(i => i.customer_id === Number(customer_id));
  if (from) rows = rows.filter(i => i.issue_date >= from);
  if (to) rows = rows.filter(i => i.issue_date <= to);
  if (search) {
    const q = String(search).toLowerCase();
    rows = rows.filter(i => {
      const c = store.customers.find(x => x.id === i.customer_id) || {};
      return (i.invoice_no || '').toLowerCase().includes(q) || (c.name || '').toLowerCase().includes(q);
    });
  }
  rows.sort((a, b) => b.id - a.id);
  const data = rows.map(i => {
    const c = store.customers.find(x => x.id === i.customer_id) || {};
    return {
      ...i, customer_name: c.name, customer_email: c.email, customer_phone: c.phone,
      status_th: STATUS_TH[i.status], outstanding: round2(i.total - i.paid_amount),
    };
  });
  res.json({ success: true, data });
});

app.get('/api/invoices/:id', requireAuth, (req, res) => {
  refreshInvoiceStatus(req.params.id);
  const inv = loadInvoice(req.params.id);
  if (!inv) return res.status(404).json({ success: false, message: 'ไม่พบใบวางบิล' });
  res.json({ success: true, data: inv });
});

app.post('/api/invoices', requireAuth, (req, res) => {
  const s = getSettings();
  const { customer_id, issue_date, due_date, items = [], discount = 0, tax_rate, note } = req.body;
  if (!customer_id) return res.json({ success: false, message: 'กรุณาเลือกลูกค้า' });
  const its = cleanItems(items);
  if (its.length === 0) return res.json({ success: false, message: 'กรุณาเพิ่มรายการอย่างน้อย 1 รายการ' });

  const issue = issue_date || todayStr();
  const due = due_date || new Date(Date.now() + Number(s.default_due_days || 30) * 86400000).toISOString().slice(0, 10);
  const rate = (tax_rate === undefined || tax_rate === '') ? Number(s.default_tax_rate || 0) : Number(tax_rate);
  const t = computeTotals(its, discount, rate);

  const inv = {
    id: ++store.seq.invoice, invoice_no: nextDocNo('INV'), customer_id: Number(customer_id),
    issue_date: issue, due_date: due, status: 'pending',
    subtotal: t.subtotal, discount: t.discount, tax_rate: rate, tax_amount: t.taxAmount,
    total: t.total, paid_amount: 0, note: note || '', paid_at: null, created_at: new Date().toISOString(),
  };
  inv.status = deriveStatus(inv);
  store.invoices.push(inv);
  for (const it of its) store.invoice_items.push({ id: ++store.seq.item, invoice_id: inv.id, ...it });
  saveNow();
  res.json({ success: true, id: inv.id, data: loadInvoice(inv.id), message: 'สร้างใบวางบิลสำเร็จ' });
});

app.put('/api/invoices/:id', requireAuth, (req, res) => {
  const inv = store.invoices.find(i => i.id === Number(req.params.id));
  if (!inv) return res.status(404).json({ success: false, message: 'ไม่พบใบวางบิล' });
  if (inv.paid_amount > 0) return res.json({ success: false, message: 'แก้ไขไม่ได้ เนื่องจากมีการชำระเงินบางส่วนแล้ว' });
  const { customer_id, issue_date, due_date, items = [], discount = 0, tax_rate, note } = req.body;
  const its = cleanItems(items);
  if (its.length === 0) return res.json({ success: false, message: 'กรุณาเพิ่มรายการอย่างน้อย 1 รายการ' });
  const rate = Number(tax_rate) || 0;
  const t = computeTotals(its, discount, rate);
  Object.assign(inv, {
    customer_id: Number(customer_id) || inv.customer_id, issue_date: issue_date || inv.issue_date,
    due_date: due_date || inv.due_date, subtotal: t.subtotal, discount: t.discount,
    tax_rate: rate, tax_amount: t.taxAmount, total: t.total, note: note || '',
  });
  store.invoice_items = store.invoice_items.filter(it => it.invoice_id !== inv.id);
  for (const it of its) store.invoice_items.push({ id: ++store.seq.item, invoice_id: inv.id, ...it });
  inv.status = deriveStatus(inv);
  saveNow();
  res.json({ success: true, data: loadInvoice(inv.id), message: 'แก้ไขใบวางบิลสำเร็จ' });
});

app.delete('/api/invoices/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  store.invoices = store.invoices.filter(i => i.id !== id);
  store.invoice_items = store.invoice_items.filter(it => it.invoice_id !== id);
  store.payments = store.payments.filter(p => p.invoice_id !== id);
  saveNow();
  res.json({ success: true, message: 'ลบใบวางบิลสำเร็จ' });
});

/* ─── บันทึกการชำระเงิน → ออกใบเสร็จอัตโนมัติ (ฟีเจอร์ 2, 4) ─── */
app.post('/api/invoices/:id/pay', requireAuth, (req, res) => {
  const inv = store.invoices.find(i => i.id === Number(req.params.id));
  if (!inv) return res.status(404).json({ success: false, message: 'ไม่พบใบวางบิล' });
  const outstanding = round2(inv.total - inv.paid_amount);
  let { amount, method = 'เงินสด', paid_date, note } = req.body;
  amount = (amount === undefined || amount === '') ? outstanding : Number(amount);
  if (!(amount > 0)) return res.json({ success: false, message: 'จำนวนเงินไม่ถูกต้อง' });
  if (amount > outstanding + 0.001) return res.json({ success: false, message: `ชำระเกินยอดค้าง (คงเหลือ ${fmtMoney(outstanding)} บาท)` });

  const receiptNo = nextDocNo('REC');
  store.payments.push({
    id: ++store.seq.payment, receipt_no: receiptNo, invoice_id: inv.id, amount: round2(amount),
    method, paid_date: paid_date || todayStr(), note: note || '', created_at: new Date().toISOString(),
  });
  inv.paid_amount = round2(inv.paid_amount + amount);
  if (inv.paid_amount >= inv.total - 0.001 && !inv.paid_at) inv.paid_at = new Date().toISOString();
  inv.status = deriveStatus(inv);
  saveNow();
  res.json({ success: true, receipt_no: receiptNo, data: loadInvoice(inv.id), message: 'บันทึกการชำระเงินและออกใบเสร็จสำเร็จ' });
});

app.post('/api/invoices/refresh-overdue', requireAuth, (req, res) => { refreshAllOverdue(); res.json({ success: true }); });

/* ─────────────────────────────────────────────────────────────
 *  SEND DOCUMENT (ฟีเจอร์ 7)
 * ───────────────────────────────────────────────────────────── */
app.post('/api/invoices/:id/send', requireAuth, async (req, res) => {
  const inv = loadInvoice(req.params.id);
  if (!inv) return res.status(404).json({ success: false, message: 'ไม่พบใบวางบิล' });
  const { channel = 'email', docType = 'invoice', recipient } = req.body;
  const to = recipient || (channel === 'email' ? inv.customer.email : inv.customer.phone);
  if (!to) return res.json({ success: false, message: channel === 'email' ? 'ลูกค้าไม่มีอีเมล' : 'ลูกค้าไม่มีเบอร์โทร' });

  const s = getSettings();
  const subjectMap = {
    invoice: `ใบวางบิล ${inv.invoice_no} จาก ${s.company_name}`,
    receipt: `ใบเสร็จรับเงิน — ใบวางบิล ${inv.invoice_no}`,
    reminder: `[แจ้งเตือน] ครบกำหนดชำระ ใบวางบิล ${inv.invoice_no}`,
  };
  const result = await sendNotification({
    invoiceId: inv.id, channel, docType, recipient: to,
    subject: subjectMap[docType] || subjectMap.invoice, message: buildDocMessage(inv, docType),
  });
  const verb = result.status === 'sent' ? 'ส่งสำเร็จ' : result.status === 'simulated' ? 'จำลองการส่ง (ยังไม่ได้ตั้งค่า SMTP)' : 'ส่งไม่สำเร็จ';
  res.json({
    success: result.status !== 'failed', status: result.status,
    message: `${channel === 'email' ? 'อีเมล' : 'SMS'} → ${to}: ${verb}`, error: result.error,
  });
});

app.get('/api/notifications', requireAuth, (req, res) => {
  const rows = store.notifications.slice().sort((a, b) => b.id - a.id).slice(0, 100).map(n => ({
    ...n, invoice_no: (store.invoices.find(i => i.id === n.invoice_id) || {}).invoice_no || '',
  }));
  res.json({ success: true, data: rows });
});

/* ─────────────────────────────────────────────────────────────
 *  REMINDERS / DUE TRACKING (ฟีเจอร์ 5)
 * ───────────────────────────────────────────────────────────── */
function tagInvoice(i) {
  const c = store.customers.find(x => x.id === i.customer_id) || {};
  return {
    ...i, customer_name: c.name, customer_email: c.email, customer_phone: c.phone,
    status_th: STATUS_TH[i.status], outstanding: round2(i.total - i.paid_amount),
  };
}

app.get('/api/reminders/due', requireAuth, (req, res) => {
  refreshAllOverdue();
  const s = getSettings();
  const daysBefore = Number(s.reminder_days_before || 3);
  const soon = new Date(Date.now() + daysBefore * 86400000).toISOString().slice(0, 10);
  const today = todayStr();
  const overdue = store.invoices.filter(i => i.status === 'overdue')
    .sort((a, b) => a.due_date.localeCompare(b.due_date)).map(tagInvoice);
  const dueSoon = store.invoices.filter(i => i.status === 'pending' && i.due_date <= soon && i.due_date >= today)
    .sort((a, b) => a.due_date.localeCompare(b.due_date)).map(tagInvoice);
  res.json({ success: true, overdue, dueSoon, daysBefore });
});

app.post('/api/reminders/send-all', requireAuth, async (req, res) => {
  refreshAllOverdue();
  const { channel = 'email', scope = 'overdue' } = req.body;
  const s = getSettings();
  const daysBefore = Number(s.reminder_days_before || 3);
  const soon = new Date(Date.now() + daysBefore * 86400000).toISOString().slice(0, 10);
  const today = todayStr();
  let targets;
  if (scope === 'dueSoon') targets = store.invoices.filter(i => i.status === 'pending' && i.due_date <= soon && i.due_date >= today);
  else targets = store.invoices.filter(i => i.status === 'overdue');

  let sent = 0, skipped = 0;
  for (const t of targets) {
    const inv = loadInvoice(t.id);
    const to = channel === 'email' ? inv.customer.email : inv.customer.phone;
    if (!to) { skipped++; continue; }
    await sendNotification({
      invoiceId: inv.id, channel, docType: 'reminder', recipient: to,
      subject: `[แจ้งเตือน] ครบกำหนดชำระ ใบวางบิล ${inv.invoice_no}`, message: buildDocMessage(inv, 'reminder'),
    });
    sent++;
  }
  res.json({ success: true, message: `ส่งแจ้งเตือน ${sent} รายการ${skipped ? ` (ข้าม ${skipped} รายการที่ไม่มีช่องทางติดต่อ)` : ''}`, sent, skipped });
});

/* ─────────────────────────────────────────────────────────────
 *  RECEIPTS (ฟีเจอร์ 2)
 * ───────────────────────────────────────────────────────────── */
app.get('/api/receipts', requireAuth, (req, res) => {
  const rows = store.payments.slice().sort((a, b) => b.id - a.id).map(p => {
    const inv = store.invoices.find(i => i.id === p.invoice_id) || {};
    const c = store.customers.find(x => x.id === inv.customer_id) || {};
    return { ...p, invoice_no: inv.invoice_no, customer_name: c.name };
  });
  res.json({ success: true, data: rows });
});

/* ─────────────────────────────────────────────────────────────
 *  DASHBOARD & REPORTS (ฟีเจอร์ 8)
 * ───────────────────────────────────────────────────────────── */
app.get('/api/dashboard/summary', requireAuth, (req, res) => {
  refreshAllOverdue();
  const today = todayStr();
  const month = today.slice(0, 7);
  const invs = store.invoices;
  const billed_total = round2(invs.reduce((s, i) => s + i.total, 0));
  const collected_total = round2(invs.reduce((s, i) => s + i.paid_amount, 0));
  const outstanding_total = round2(invs.reduce((s, i) => s + (i.total - i.paid_amount), 0));

  const statusMap = { pending: { c: 0, amt: 0 }, paid: { c: 0, amt: 0 }, overdue: { c: 0, amt: 0 } };
  for (const i of invs) {
    const m = statusMap[i.status]; if (!m) continue;
    m.c++; m.amt = round2(m.amt + (i.total - i.paid_amount));
  }
  const today_income = round2(store.payments.filter(p => p.paid_date === today).reduce((s, p) => s + p.amount, 0));
  const month_income = round2(store.payments.filter(p => (p.paid_date || '').slice(0, 7) === month).reduce((s, p) => s + p.amount, 0));

  res.json({
    success: true,
    data: {
      invoice_count: invs.length, billed_total, collected_total, outstanding_total,
      status: statusMap, today_income, month_income, customer_count: store.customers.length,
    },
  });
});

app.get('/api/dashboard/revenue', requireAuth, (req, res) => {
  const { period = 'daily', n = 14 } = req.query;
  const N = Math.min(Number(n) || 14, 90);
  const out = [];
  if (period === 'monthly') {
    const base = new Date();
    for (let i = N - 1; i >= 0; i--) {
      const d = new Date(base.getFullYear(), base.getMonth() - i, 1);
      const ym = d.toISOString().slice(0, 7);
      const income = round2(store.payments.filter(p => (p.paid_date || '').slice(0, 7) === ym).reduce((s, p) => s + p.amount, 0));
      const billed = round2(store.invoices.filter(x => (x.issue_date || '').slice(0, 7) === ym).reduce((s, x) => s + x.total, 0));
      out.push({ label: ym, income, billed });
    }
  } else {
    for (let i = N - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      const income = round2(store.payments.filter(p => p.paid_date === d).reduce((s, p) => s + p.amount, 0));
      const billed = round2(store.invoices.filter(x => x.issue_date === d).reduce((s, x) => s + x.total, 0));
      out.push({ label: d, income, billed });
    }
  }
  res.json({ success: true, data: out, labels: out.map(o => o.label) });
});

app.get('/api/dashboard/top-customers', requireAuth, (req, res) => {
  const map = new Map();
  for (const i of store.invoices) {
    const m = map.get(i.customer_id) || { invoice_count: 0, billed: 0, paid: 0 };
    m.invoice_count++; m.billed = round2(m.billed + i.total); m.paid = round2(m.paid + i.paid_amount);
    map.set(i.customer_id, m);
  }
  const rows = [...map.entries()].map(([cid, m]) => {
    const c = store.customers.find(x => x.id === cid) || {};
    return { id: cid, name: c.name, ...m };
  }).sort((a, b) => b.billed - a.billed).slice(0, 10);
  res.json({ success: true, data: rows });
});

/* ─────────────────────────────────────────────────────────────
 *  STATIC + ROUTES
 * ───────────────────────────────────────────────────────────── */
app.get('/health', (req, res) => res.json({ ok: true }));
app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'billing.html')));

const PORT = process.env.PORT || 4000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🧾 ระบบวางบิล & เก็บเงิน ทำงานที่พอร์ต ${PORT}`);
  console.log(`   เข้าสู่ระบบ: username=admin / password=admin1234\n`);
});

// บันทึกข้อมูลก่อนปิดโปรเซส
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { saveNow(); process.exit(0); });
