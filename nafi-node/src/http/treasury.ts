import * as gate from '../core/gate.js';
import * as audit from '../core/audit.js';
import { HttpError, Invalid } from '../core/errors.js';
import { fa, money, parseAmount } from '../core/validator.js';
import { html } from './view.js';
import { Ctx, Out } from './types.js';

async function company(c: Ctx) {
  const group = gate.isGroup(c.A);
  const cid = group ? Number(c.rq.query.get('c') ?? c.rq.form.get('c') ?? await c.db.val('SELECT id FROM companies ORDER BY id LIMIT 1')) : Number(c.u.company_id);
  gate.assertCompany(c.A, cid);
  if (!cid || !(await c.db.val('SELECT 1 FROM companies WHERE id=?', [cid]))) throw new HttpError('شرکت انتخاب‌شده معتبر نیست.',404);
  return { cid, hidden: group ? html`<input type="hidden" name="c" value="${cid}">` : html` `,
    url: (path: string) => path + (group ? `?c=${cid}` : '') };
}
const validDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s+'T00:00:00Z'));

/** Bank account register and append-only cash movement journal. */
export async function handleTreasury(c: Ctx): Promise<Out | null> {
 const {rq,db,A}=c;
 if (!rq.path.startsWith('/treasury')) return null;
 await gate.require_(db,A,'accounting.view');
 const co=await company(c), cid=co.cid, back=co.url('/treasury');
 const canManage=await gate.can(db,A,'accounting.manage'), canEnter=await gate.can(db,A,'accounting.entry');
 if(rq.method==='POST' && rq.path==='/treasury/accounts'){
  if(!canManage) throw new HttpError('دسترسی ایجاد حساب بانکی ندارید.',403);
  const title=c.f('title').trim(), bank=c.f('bank_name').trim(), number=c.f('account_number').trim(), iban=c.f('iban').trim();
  const opening=parseAmount(c.f('opening_balance'));
  if(!title||title.length>120||!bank||bank.length>120||!number||number.length>40||opening===null||opening<0|| (iban && !/^IR\d{24}$/.test(iban))) throw new Invalid('اطلاعات حساب بانکی معتبر نیست؛ شبا باید با IR و ۲۴ رقم وارد شود.');
  return c.done(back,()=>db.tx(async t=>{
   const id=await t.insert('INSERT INTO bank_accounts(company_id,title,bank_name,account_number,iban,opening_balance,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)',[cid,title,bank,number,iban||null,opening,A.id,db.now()]);
   await audit.log(t,A,'treasury.account.create','bank_account',id,{bank_name:bank,account_number:number},cid);
  }),'حساب بانکی ثبت شد.');
 }
 if(rq.method==='POST' && rq.path==='/treasury/transactions'){
  if(!canEnter) throw new HttpError('دسترسی ثبت گردش مالی ندارید.',403);
  const kind=c.f('kind'), amount=parseAmount(c.f('amount')), fromRaw=c.f('from_account_id'), toRaw=c.f('to_account_id');
  const from=fromRaw?Number(fromRaw):null, to=toRaw?Number(toRaw):null, reference=c.f('reference').trim(), description=c.f('description').trim(), date=c.f('transacted_on');
  if(!['receipt','payment','transfer'].includes(kind)||amount===null||amount<=0||amount>9000000000000000||reference.length>80||!description||description.length>300||!validDate(date)) throw new Invalid('نوع، مبلغ، شرح یا تاریخ تراکنش معتبر نیست.');
  if((kind==='receipt' && (!to||from))||(kind==='payment'&&(!from||to))||(kind==='transfer'&&(!from||!to||from===to))) throw new Invalid('حساب مبدأ و مقصد را متناسب با نوع عملیات انتخاب کنید.');
  return c.done(back,()=>db.tx(async t=>{
   const ids=[from,to].filter((x):x is number=>!!x).sort((a,b)=>a-b);
   const locked=await t.all('SELECT id,opening_balance FROM bank_accounts WHERE company_id=? AND id IN ('+ids.map(()=>'?').join(',')+') AND status="active" ORDER BY id FOR UPDATE',[cid,...ids]);
   if(locked.length!==ids.length) throw new Invalid('حساب بانکی فعال و متعلق به همین شرکت پیدا نشد.');
   if(from){
    const bal=Number(locked.find(x=>Number(x.id)===from)!.opening_balance)+Number(await t.val('SELECT COALESCE(SUM(CASE WHEN to_account_id=? THEN amount ELSE 0 END)-SUM(CASE WHEN from_account_id=? THEN amount ELSE 0 END),0) FROM treasury_transactions WHERE company_id=? AND (from_account_id=? OR to_account_id=?)',[from,from,cid,from,from]));
    if(bal<amount) throw new Invalid('موجودی حساب مبدأ برای این عملیات کافی نیست.');
   }
   const id=await t.insert('INSERT INTO treasury_transactions(company_id,kind,from_account_id,to_account_id,amount,reference,description,transacted_on,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',[cid,kind,from,to,amount,reference||null,description,date,A.id,db.now()]);
   await audit.log(t,A,'treasury.transaction.'+kind,'treasury_transaction',id,{amount,from_account_id:from,to_account_id:to,reference},cid);
  }),'گردش مالی با موفقیت ثبت شد.');
 }
 const accounts=await db.all('SELECT a.*, a.opening_balance + COALESCE((SELECT SUM(t.amount) FROM treasury_transactions t WHERE t.company_id=a.company_id AND t.to_account_id=a.id),0) - COALESCE((SELECT SUM(t.amount) FROM treasury_transactions t WHERE t.company_id=a.company_id AND t.from_account_id=a.id),0) balance FROM bank_accounts a WHERE a.company_id=? ORDER BY a.id DESC',[cid]);
 const rows=await db.all('SELECT t.*, f.title from_title, z.title to_title FROM treasury_transactions t LEFT JOIN bank_accounts f ON f.id=t.from_account_id LEFT JOIN bank_accounts z ON z.id=t.to_account_id WHERE t.company_id=? ORDER BY t.transacted_on DESC,t.id DESC LIMIT 300',[cid]);
 const net=accounts.reduce((n,a)=>n+Number(a.balance),0);
 return c.render('خزانه‌داری و بانک',html`
 <div class="kpis"><div class="kpi"><b>${fa(String(accounts.length))}</b><span>حساب بانکی</span></div><div class="kpi"><b>${money(net)}</b><span>مانده خالص حساب‌ها (ریال)</span></div><div class="kpi"><b>${fa(String(rows.length))}</b><span>گردش‌های اخیر</span></div></div>
 <div class="panel"><h2>حساب‌های بانکی</h2><table><tr><th>عنوان</th><th>بانک</th><th>شماره حساب</th><th>شبا</th><th>مانده (ریال)</th></tr>${accounts.map(a=>html`<tr><td>${a.title}</td><td>${a.bank_name}</td><td dir="ltr">${a.account_number}</td><td dir="ltr">${a.iban||'—'}</td><td>${money(a.balance)}</td></tr>`)}</table></div>
 ${canManage?html`<form method="post" action="/treasury/accounts" class="panel form">${c.csrf}${co.hidden}<h2>افزودن حساب بانکی</h2><label>عنوان حساب<input name="title" maxlength="120" required></label><label>نام بانک<input name="bank_name" maxlength="120" required></label><label>شماره حساب<input name="account_number" maxlength="40" dir="ltr" required></label><label>شماره شبا<input name="iban" maxlength="26" dir="ltr" placeholder="IR000000000000000000000000"></label><label>مانده افتتاحیه (ریال)<input name="opening_balance" inputmode="numeric" value="0" required></label><button>ثبت حساب</button></form>`:html` `}
 ${canEnter?html`<form method="post" action="/treasury/transactions" class="panel form">${c.csrf}${co.hidden}<h2>ثبت دریافت، پرداخت یا انتقال</h2><label>نوع عملیات<select name="kind"><option value="receipt">دریافت وجه</option><option value="payment">پرداخت وجه</option><option value="transfer">انتقال بین حساب‌ها</option></select></label><label>حساب مبدأ (برای پرداخت/انتقال)<select name="from_account_id"><option value="">—</option>${accounts.map(a=>html`<option value="${a.id}">${a.title} — ${money(a.balance)} ریال</option>`)}</select></label><label>حساب مقصد (برای دریافت/انتقال)<select name="to_account_id"><option value="">—</option>${accounts.map(a=>html`<option value="${a.id}">${a.title}</option>`)}</select></label><label>مبلغ (ریال)<input name="amount" inputmode="numeric" required></label><label>تاریخ میلادی<input type="date" name="transacted_on" required></label><label>شماره پیگیری<input name="reference" maxlength="80" dir="ltr"></label><label>شرح<input name="description" maxlength="300" required></label><button>ثبت گردش</button></form>`:html` `}
 <div class="panel"><h2>دفتر گردش حساب‌ها</h2><table><tr><th>تاریخ</th><th>نوع</th><th>مبدأ</th><th>مقصد</th><th>مبلغ (ریال)</th><th>پیگیری</th><th>شرح</th></tr>${rows.map(r=>html`<tr><td>${r.transacted_on}</td><td>${r.kind==='receipt'?'دریافت':r.kind==='payment'?'پرداخت':'انتقال'}</td><td>${r.from_title||'—'}</td><td>${r.to_title||'—'}</td><td>${money(r.amount)}</td><td>${r.reference||'—'}</td><td>${r.description}</td></tr>`)}</table></div>`);
}
