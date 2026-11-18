/* Nafi admin UI: searchable and sortable tables with guarded destructive actions. */
(() => {
 'use strict';
 const number = n => new Intl.NumberFormat('fa-IR').format(n);
 document.querySelectorAll('.panel table').forEach(table => {
  const header = table.querySelector('tr');
  if (!header) return;
  const rows = Array.from(table.querySelectorAll('tr')).filter(row => row.querySelector('td'));
  if (!rows.length) return;
  const tools = document.createElement('div'); tools.className = 'table-tools';
  const input = document.createElement('input'); input.type = 'search'; input.placeholder = 'جست‌وجو در همین جدول…'; input.setAttribute('aria-label','جست‌وجو در جدول');
  const count = document.createElement('span'); count.className = 'table-count'; count.setAttribute('aria-live','polite');
  tools.append(input,count); table.parentElement.insertBefore(tools,table);
  const refresh = () => { const q=input.value.trim().toLocaleLowerCase('fa'); let visible=0; rows.forEach(row=>{const yes=!q||row.textContent.toLocaleLowerCase('fa').includes(q);row.hidden=!yes;if(yes)visible++;});count.textContent=number(visible)+' از '+number(rows.length)+' ردیف'; };
  input.addEventListener('input',refresh); refresh();
  Array.from(header.querySelectorAll('th')).forEach((th,index)=>{
   th.dataset.sort='1';th.tabIndex=0;th.setAttribute('role','button');
   const sort=()=>{const asc=th.getAttribute('aria-sort')!=='ascending';header.querySelectorAll('th').forEach(x=>x.removeAttribute('aria-sort'));th.setAttribute('aria-sort',asc?'ascending':'descending');
    const parent=table.tBodies[0]||table;
    rows.sort((a,b)=>{const x=(a.cells[index]?.innerText||'').trim(),y=(b.cells[index]?.innerText||'').trim();const nx=Number(x.replace(/[^0-9.-]/g,'')),ny=Number(y.replace(/[^0-9.-]/g,''));const numeric=x!==''&&y!==''&&Number.isFinite(nx)&&Number.isFinite(ny);const cmp=numeric?nx-ny:x.localeCompare(y,'fa');return asc?cmp:-cmp;}).forEach(row=>parent.appendChild(row));refresh();};
   th.addEventListener('click',sort);th.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();sort();}});
  });
 });
 document.addEventListener('submit',event=>{const form=event.target;if(!(form instanceof HTMLFormElement))return;const label=(event.submitter?.textContent||'').trim();if(/حذف|فسخ|غیرفعال‌سازی/.test(label)&&!window.confirm('از انجام این عملیات مطمئن هستید؟'))event.preventDefault();});
})();