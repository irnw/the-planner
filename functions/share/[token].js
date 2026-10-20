// Read-only trip page for travel companions: https://theplanner.pages.dev/share/<token>
// Shows the copy of one trip that its owner chose to share (supabase/shared_trips.sql). Everything is escaped.
const SUPA_URL='https://lfezxmbsnsrkyqvismaj.supabase.co';
const SUPA_KEY='sb_publishable_Dq3LuTEfNwRFTQ85XfTIEw_bRBqHqRq';
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const MON=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'],DOW=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const dt=d=>{const m=String(d||'').match(/^(\d{4})-(\d{2})-(\d{2})/);if(!m)return '';const x=new Date(Date.UTC(+m[1],m[2]-1,+m[3]));return `${DOW[x.getUTCDay()]} ${+m[3]} ${MON[m[2]-1]} ${m[1]}`;};
const tm=d=>{const m=String(d||'').match(/T(\d{2}):(\d{2})/)||String(d||'').match(/^(\d{2}):(\d{2})$/);return m?`${m[1]}:${m[2]}`:'';};
const money=(v,c)=>v&&!isNaN(parseFloat(v))?`${esc(c||'')} ${parseFloat(v).toLocaleString('en',{minimumFractionDigits:2,maximumFractionDigits:2})}`:'';
// A booking split across the group shows the total and each person's part
const cost=e=>{const m=money(e.cost,e.currency),n=parseInt(e.ways)||1;return m&&n>1&&n<=50?`${m} · ${money(parseFloat(e.cost)/n,e.currency)} each (split ${n} ways)`:m;};
const kb=n=>n>=1048576?(n/1048576).toFixed(1).replace(/\.0$/,'')+' MB':Math.max(1,Math.round(n/1024))+' KB';
// Only the owner's own signed file links, web links and small inline previews are shown
const FILE_RE=new RegExp('^'+SUPA_URL.replace(/[.]/g,'\\.')+'/storage/v1/object/sign/attachments/[\\w./-]+\\?token=[\\w.-]+$');
const okUrl=u=>/^https?:\/\/[^\s"'<>]+$/i.test(String(u||''));
const okThumb=u=>/^data:image\/(?:jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(String(u||''));
const attHtml=a=>{
  const pdf=a.type==='pdf',href=pdf?(FILE_RE.test(String(a.file||''))?a.file:''):(okUrl(a.url)?a.url:'');
  const meta=pdf?['PDF',a.pages>1?a.pages+' pages':'',a.size?kb(+a.size):''].filter(Boolean).join(' · '):a.type==='image'?'Image':'Link';
  const inner=`<div class="at">${okThumb(a.thumb)?`<img src="${a.thumb}" alt="" loading="lazy">`:pdf?'📄':a.type==='image'?'🖼':'🔗'}${pdf?'<span class="bd">PDF</span>':''}</div><div class="ai"><div class="n">${esc(a.name||'Attachment')}</div><div class="ref">${esc(meta)}</div></div>`;
  return href?`<a class="ac" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${inner}</a>`:`<div class="ac">${inner}</div>`;
};
const num=v=>Math.max(0,Math.min(9999,parseInt(v)||0));
const statsHtml=s=>{const t=s.stats;if(!t||typeof t!=='object')return '';
  const bk=[['flights','flight'],['hotels','hotel'],['activities','activity'],['transport','transport']].map(([k,w])=>num(t[k])?num(t[k])+' '+(num(t[k])>1?(w==='activity'?'activities':w==='transport'?'transport':w+'s'):w):'').filter(Boolean);
  const cells=[num(t.days)&&[num(t.days),num(t.days)>1?'Days':'Day',num(t.nights)?num(t.nights)+' night'+(num(t.nights)>1?'s':''):''],
    num(t.people)>1&&[num(t.people),'People',''],
    bk.length&&[bk.reduce((a,x)=>a+parseInt(x),0),'Bookings',bk.join(' · ')],
    (s.opts||{}).costs&&t.perPerson>0&&/^[A-Z]{3}$/.test(t.cur||'')&&[money(t.perPerson,t.cur),'Cost per person','estimate']].filter(Boolean);
  return cells.length?`<div class="stats">${cells.map(([v,l,sub])=>`<div class="st"><span>${esc(l)}</span><b>${typeof v==='number'?v:v}</b>${sub?`<small>${esc(sub)}</small>`:''}</div>`).join('')}</div>`:'';};
const page=(title,body)=>`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500&family=Playfair+Display:wght@700&display=swap" rel="stylesheet">
<style>:root{--bg:#f7f6f3;--card:#fbfaf8;--text:#1d1d22;--text2:#55555e;--text3:#7c7c86;--line:#e6e3dc;--p:#5f52d6}
@media(prefers-color-scheme:dark){:root{--bg:#0f1014;--card:#14161c;--text:#ececf1;--text2:#a4a7b4;--text3:#8b90a0;--line:#262934;--p:#a89cff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 'DM Sans',system-ui,sans-serif}
main{max-width:760px;margin:0 auto;padding:32px 20px 48px}.k{font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:var(--p);font-weight:500}
h1{font:700 34px/1.1 'Playfair Display',serif;margin:8px 0 6px}h2{font:700 19px/1.2 'Playfair Display',serif;margin:30px 0 10px}
.sub{color:var(--text2)}.it{border-top:1px solid var(--line);padding:14px 0;display:flex;gap:14px}.it:last-child{border-bottom:1px solid var(--line)}
.d{flex:none;width:118px;color:var(--text3);font-size:13px}.n{font-weight:500}.m{font-size:13px;color:var(--text2)}.ref{font-size:12px;color:var(--text3)}
.note{font-size:12px;color:var(--text3);margin-top:34px}.sig{text-align:right;font-size:11px;color:var(--text3);margin-top:30px}.sig a{color:var(--p)}
.att{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px}.ac{display:block;border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--card);color:inherit;text-decoration:none}
a.ac:hover{border-color:var(--p)}.at{height:110px;background:var(--bg);display:flex;align-items:center;justify-content:center;position:relative;color:var(--text3);font-size:26px}.at img{width:100%;height:100%;object-fit:cover;object-position:top}
.bd{position:absolute;left:6px;bottom:6px;background:var(--p);color:#fff;font-size:9px;font-weight:500;letter-spacing:.06em;padding:2px 6px;border-radius:4px}.ai{padding:8px 10px}.ai .n{font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ai .ref{margin-top:1px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));border:1px solid var(--line);border-radius:12px;margin-top:20px;overflow:hidden;background:var(--card)}
.st{padding:12px 14px;border-left:1px solid var(--line)}.st:first-child{border-left:0}.st b{display:block;font:700 22px/1.2 'Playfair Display',serif}.st span{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--text3)}.st small{display:block;font-size:11px;color:var(--text3)}
@media(max-width:560px){.stats{grid-template-columns:repeat(2,1fr)}.st:nth-child(odd){border-left:0}.st:nth-child(n+3){border-top:1px solid var(--line)}.att{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.at{height:96px}.it{flex-direction:column;gap:2px}.d{width:auto}h1{font-size:28px}}</style></head><body><main>${body}</main></body></html>`;
const notFound=()=>new Response(page('Trip not found',`<div class="k">The Planner</div><h1>This link isn't available</h1><p class="sub">The trip may no longer be shared, or the link is incomplete. Ask the person who sent it for a new one.</p>`),{status:404,headers:{'Content-Type':'text/html; charset=utf-8','X-Robots-Tag':'noindex'}});

export async function onRequestGet({params}){
  const t=String(params.token||'');
  if(!/^[a-f0-9]{32}$/.test(t))return notFound();
  let r;try{r=await fetch(SUPA_URL+'/rest/v1/rpc/shared_trip_get',{method:'POST',headers:{apikey:SUPA_KEY,'Content-Type':'application/json'},body:JSON.stringify({t})});}catch(e){r=null;}
  if(!r||!r.ok)return r&&r.status===404?notFound():new Response('Trip unavailable, try again later',{status:503});
  const s=await r.json();if(!s||!s.name)return notFound();
  const o=s.opts||{},rows=[];
  (s.flights||[]).forEach(f=>rows.push({k:f.departureTime||'',d:dt(f.departureTime),h:`<div class="n">✈ ${esc([f.airline,f.flightNumber].filter(Boolean).join(' '))}${f.from||f.to?` · ${esc(f.from)} → ${esc(f.to)}`:''}</div><div class="m">${[tm(f.departureTime)&&'Departs '+tm(f.departureTime),f.arrivalTime&&('Arrives '+tm(f.arrivalTime)+(f.arrivalTime.slice(0,10)!==String(f.departureTime).slice(0,10)?' ('+dt(f.arrivalTime)+')':'')),f.duration].filter(Boolean).map(esc).join(' · ')}</div>${o.refs&&f.pnr?`<div class="ref">Booking reference ${esc(f.pnr)}</div>`:''}${o.costs&&f.cost?`<div class="ref">${cost(f)}</div>`:''}`}));
  (s.hotels||[]).forEach(h=>rows.push({k:h.checkIn||'',d:dt(h.checkIn),h:`<div class="n">🏨 ${esc(h.name||'Hotel')}</div><div class="m">${h.checkIn?'Check-in '+esc(dt(h.checkIn)):''}${h.checkOut?' · check-out '+esc(dt(h.checkOut)):''}</div>${o.refs&&h.bookingNumber?`<div class="ref">Confirmation ${esc(h.bookingNumber)}</div>`:''}${o.costs&&h.cost?`<div class="ref">${cost(h)}</div>`:''}`}));
  (s.activities||[]).forEach(a=>rows.push({k:(a.date||'')+'T'+(a.time||''),d:dt(a.date),h:`<div class="n">🎯 ${esc(a.name||'Activity')}</div><div class="m">${[a.time,a.location,a.duration].filter(Boolean).map(esc).join(' · ')}</div>${o.refs&&a.bookingDetails?`<div class="ref">${esc(a.bookingDetails)}</div>`:''}${o.costs&&a.cost?`<div class="ref">${cost(a)}</div>`:''}`}));
  (s.transport||[]).forEach(x=>rows.push({k:(x.date||'')+'T'+(x.time||''),d:dt(x.date),h:`<div class="n">🚐 ${esc([x.type,x.name].filter(Boolean).join(' · ')||'Transport')}</div><div class="m">${[x.time,x.location,x.duration].filter(Boolean).map(esc).join(' · ')}</div>${o.refs&&x.bookingDetails?`<div class="ref">${esc(x.bookingDetails)}</div>`:''}${o.costs&&x.cost?`<div class="ref">${cost(x)}</div>`:''}`}));
  rows.sort((a,b)=>String(a.k).localeCompare(String(b.k)));
  const body=`<div class="k">${s.sharedBy?esc(s.sharedBy)+' shared a trip':'Shared trip'}</div><h1>${esc(s.name)}</h1>
    <div class="sub">${esc(dt(s.startDate))}${s.endDate&&s.endDate!==s.startDate?' – '+esc(dt(s.endDate)):''}${(s.locations||[]).length?' · '+esc(s.locations.join(', ')):''}</div>
    ${statsHtml(s)}
    ${o.notes&&s.notes?`<p class="m" style="margin-top:14px;white-space:pre-wrap">${esc(s.notes)}</p>`:''}
    <h2>Itinerary</h2>${rows.length?rows.map(r=>`<div class="it"><div class="d">${esc(r.d)}</div><div>${r.h}</div></div>`).join(''):'<p class="sub">No bookings added yet.</p>'}
    ${o.files&&(s.attachments||[]).length?`<h2>Attachments</h2><div class="att">${s.attachments.slice(0,60).map(attHtml).join('')}</div>`:''}
    <p class="note">A read-only copy, kept up to date by the trip's owner${s.updated_at?' (last updated '+esc(dt(s.updated_at))+')':''}. Times are local to each place.</p>
    <div class="sig">Planned with The Planner · designed and created by <a href="https://www.instagram.com/irn.w" target="_blank" rel="noopener noreferrer">@irn.w</a></div>`;
  return new Response(page(s.name+' · shared trip',body),{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'private, max-age=60','X-Robots-Tag':'noindex','Referrer-Policy':'no-referrer'}});
}
