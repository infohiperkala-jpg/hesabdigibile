// Seeds sample data through the REAL services (rules, audit chain, change history all genuine). Usage: tsx scripts/demo-data.ts
import { openDb } from '../src/core/db.js';
import * as org from '../src/services/org.js';
import * as acc from '../src/services/accounting.js';
import * as credit from '../src/services/credit.js';
import * as posting from '../src/services/posting.js';
import * as reg from '../src/services/registration.js';
import * as ch from '../src/core/changes.js';
import { makeUser, png } from '../tests/helpers.js';

const db = openDb();
const owner = (await db.one('SELECT * FROM users WHERE is_owner = 1')) as any; owner.company_id = null;
const mother = Number(await db.val('SELECT id FROM companies WHERE parent_id IS NULL'));
const vam = await org.createCompany(db, owner, 'وام‌سیتی', 'شرکت وام‌سیتی (نمونه)', mother), bile = await org.createCompany(db, owner, 'دیجی‌بایل', 'شرکت دیجی‌بایل (نمونه)', mother);
const b1 = await org.createBrand(db, owner, vam, 'آقای وام', 'aghaye-vam', 'vam.example.ir'); await org.createBrand(db, owner, bile, 'دیجی‌بایل موبایل', 'digi-mobile', 'mobile.example.ir'); await org.createBrand(db, owner, mother, 'جام طلا', 'jam-tala');
const fin = await makeUser(db, owner, 'fin_manager', 'fin@demo.test', vam), accountant = await makeUser(db, owner, 'accountant', 'acc@demo.test', vam);
const mgr = await makeUser(db, owner, 'credit_manager', 'credit@demo.test', vam), off = await makeUser(db, owner, 'credit_officer', 'officer@demo.test', vam);
const registrar = await makeUser(db, owner, 'registrar', 'registrar@demo.test', vam), expert = await makeUser(db, owner, 'doc_expert', 'expert@demo.test', vam);
const sales = await makeUser(db, owner, 'viewer', 'sales@demo.test', vam); await makeUser(db, owner, 'market_manager', 'market@demo.test', bile); await makeUser(db, owner, 'legal_manager', 'legal@demo.test', mother);

// ── edits and status changes (so every history panel is populated by genuine records)
await org.editCompany(db, owner, vam, { name: 'وام‌سیتی', legal_name: 'شرکت وام‌سیتی سهامی خاص (نمونه)' }, ch.versionOf(await org.getCompany(db, owner, vam)));
await org.editBrand(db, owner, b1, 'آقای وام آنلاین', ch.versionOf(await org.getBrand(db, owner, b1))); await org.addDomain(db, owner, b1, 'shop.vam.example.ir'); await org.setBrandStatus(db, owner, b1, 'suspended', 'تعلیق موقت برای به‌روزرسانی قرارداد پذیرندگان'); await org.setBrandStatus(db, owner, b1, 'active', 'به‌روزرسانی انجام شد و برند دوباره فعال شد');
const rolesById = Object.fromEntries((await db.all('SELECT id, code FROM roles')).map(r => [r.code, Number(r.id)]));
await org.changeUserRole(db, owner, sales.id, rolesById.sales_agent, 'انتقال به واحد فروش اعتباری'); await org.editUser(db, owner, off.id, 'کارشناس اعتبار – شعبه مرکزی', 'officer@demo.test', ch.versionOf(await org.getUser(db, owner, off.id)));

// ── real registration workflow: registrar -> upload -> submit -> expert review -> final approval (profile 1), second profile left under review (profile 2)
const p1 = await reg.createPerson(db, registrar, { first_name: 'علی', last_name: 'رضایی', national_id: '0499370899', mobile: '09123456789', consent: '1' });
await reg.upload(db, registrar, p1, 'id_front', png(640, 400), 'front.png'); await reg.upload(db, registrar, p1, 'id_back', png(640, 400, 0x70), 'back.png');
await reg.editProfile(db, registrar, p1, { first_name: 'علی', last_name: 'رضایی', mobile: '09121234567' }, reg.versionOf(await reg.find(db, registrar, p1)));
await reg.transition(db, registrar, p1, 'submitted'); await reg.transition(db, registrar, p1, 'awaiting_review'); await reg.transition(db, expert, p1, 'approved_initial');
const rid = Number(await db.val("SELECT r.id FROM document_ocr_results r JOIN document_files f ON f.id = r.file_id WHERE f.profile_id = ? AND f.kind = 'id_front'", [p1]));
await reg.review(db, expert, rid, '0499370899', 'علی', 'رضایی'); await reg.transition(db, expert, p1, 'approved_final');
const p2 = await reg.createPerson(db, registrar, { first_name: 'سارا', last_name: 'احمدی', national_id: '0084575948', mobile: '09120000000', consent: '1' });
await reg.upload(db, registrar, p2, 'id_front', png(700, 450), 'front.png'); await reg.transition(db, registrar, p2, 'submitted'); await reg.transition(db, registrar, p2, 'awaiting_review');

// ── accounting
await acc.seedStarterChart(db, fin, vam); await acc.createPeriod(db, fin, vam, 'سال مالی ۱۴۰۵', '1405/01/01', '1405/12/29');
const id = async (code: string) => Number(await db.val('SELECT id FROM accounts WHERE company_id = ? AND code = ?', [vam, code]));
const cash = await id('1101'), bank = await id('1102'), sales_ = await id('4101'), cap = await id('3101'), exp = await id('5101');
await acc.editAccount(db, fin, cash, 'صندوق مرکزی', ch.versionOf(await acc.getAccount(db, fin, cash)));
const mk = async (d: string, t: string, a: number, b: number, n: number) => acc.finalize(db, fin, await acc.createVoucher(db, accountant, vam, d, t, [{ account_id: a, debit: n }, { account_id: b, credit: n }]));
await mk('1405/01/10', 'افزایش سرمایه', bank, cap, 500_000_000); await mk('1405/08/16', 'فروش نقدی', cash, sales_, 120_000_000); await mk('1405/08/17', 'هزینه اجاره دفتر', exp, bank, 35_000_000);
const draft = await acc.createVoucher(db, accountant, vam, '1405/08/18', 'فروش اقساطی (پیش‌نویس در انتظار تأیید)', [{ account_id: cash, debit: 8_000_000 }, { account_id: sales_, credit: 8_000_000 }]);
await acc.updateDraft(db, accountant, draft, '1405/08/19', 'فروش اقساطی (پیش‌نویس اصلاح‌شده)', [{ account_id: cash, debit: 4_000_000 }, { account_id: bank, debit: 4_500_000 }, { account_id: sales_, credit: 8_500_000 }], await acc.voucherVersion(db, draft));

// ── credit: plan 1 gets used (locked); plan 2 stays editable
const plan = await credit.createPlan(db, mgr, vam, { name: 'طرح نمونه ۳ و ۶ ماهه', min_amount: 1_000_000, max_amount: 100_000_000, min_down_bp: 0, max_down_bp: 5000, quote_ttl_min: 30, grace_days: 30, late_fee_bp_day: 10, settlement_work_days: 12 }, [{ installments: 3, monthly_fee_bp: 0, upfront_fee_bp: 100 }, { installments: 6, monthly_fee_bp: 50, upfront_fee_bp: 0 }]);
const plan2 = await credit.createPlan(db, mgr, vam, { name: 'طرح پیشنهادی ۱۲ ماهه (در دست بازبینی)', min_amount: 5_000_000, max_amount: 200_000_000, min_down_bp: 1000, max_down_bp: 5000, quote_ttl_min: 30, grace_days: 30, late_fee_bp_day: 10, settlement_work_days: 12 }, [{ installments: 12, monthly_fee_bp: 80, upfront_fee_bp: 0 }]);
await credit.editPlan(db, mgr, plan2, { name: 'طرح پیشنهادی ۱۲ ماهه (در دست بازبینی)', min_amount: 5_000_000, max_amount: 150_000_000, min_down_bp: 1000, max_down_bp: 5000, quote_ttl_min: 30, grace_days: 15, late_fee_bp_day: 10, settlement_work_days: 12 }, [{ installments: 12, monthly_fee_bp: 80, upfront_fee_bp: 0 }, { installments: 6, monthly_fee_bp: 60, upfront_fee_bp: 0 }], ch.versionOf(await credit.getPlan(db, mgr, plan2)));
const q = await credit.quote(db, off, vam, plan, 12_000_000, 2_000_000, 3), ap = await credit.createApplication(db, off, q.quote_id, p1);
await credit.transition(db, off, ap, 'submitted'); await credit.transition(db, mgr, ap, 'under_review'); await credit.transition(db, mgr, ap, 'approved', 'مدارک و ظرفیت بازپرداخت تأیید شد');
await credit.signContract(db, off, ap, 'امضا حضوری در شعبه؛ نسخه کاغذی بایگانی شد'); await credit.activate(db, off, ap, '1405/08/16'); await credit.recordPayment(db, off, ap, 1_000_000, 'REF-DEMO-0001');
for (const [role, code] of [['receivable', '1103'], ['merchant_payable', '2101'], ['fee_income', '4101'], ['cash_bank', '1102'], ['commission_income', '4101']]) await posting.setAccount(db, fin, vam, role, await id(code));
await acc.finalize(db, fin, await posting.post(db, accountant, vam, 'credit.activate', ap));
console.log(JSON.stringify({ vam, b1, p1, p2, plan, plan2, draft, cash, saleUser: sales.id, offUser: off.id }));
await db.close();
