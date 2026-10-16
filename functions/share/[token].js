// Read-only trip page for travel companions: https://theplanner.pages.dev/share/<token>
// Shows the copy of one trip that its owner chose to share (supabase/shared_trips.sql). Everything is escaped.
const SUPA_URL='https://lfezxmbsnsrkyqvismaj.supabase.co';
const SUPA_KEY='sb_publishable_Dq3LuTEfNwRFTQ85XfTIEw_bRBqHqRq';
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const MON=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'],DOW=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const dt=d=>{const m=String(d||'').match(/^(\d{4})-(\d{2})-(\d{2})/);if(!m)return '';const x=new Date(Date.UTC(+m[1],m[2]-1,+m[3]));return `${DOW[x.getUTCDay()]} ${+m[3]} ${MON[m[2]-1]} ${m[1]}`;};
const tm=d=>{const m=String(d||'').match(/T(\d{2}):(\d{2})/)||String(d||'').match(/^(\d{2}):(\d{2})$/);return m?`${m[1]}:${m[2]}`:'';};
const money=(v,c)=>v&&!isNaN(parseFloat(v))?`${esc(c||'')} ${parseFloat(v).toLocaleString('en',{minimumFractionDigits:2,maximumFractionDigits:2})}`:'';
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
@media(max-width:560px){.it{flex-direction:column;gap:2px}.d{width:auto}h1{font-size:28px}}</style></head><body><main>${body}</main></body></html>`;
const notFound=()=>new Response(page('Trip not found',`<div class="k">The Planner</div><h1>This link isn't available</h1><p class="sub">The trip may no longer be shared, or the link is incomplete. Ask the person who sent it for a new one.</p>`),{status:404,headers:{'Content-Type':'text/html; charset=utf-8','X-Robots-Tag':'noindex'}});

export async function onRequestGet({params}){
  const t=String(params.token||'');
  if(!/^[a-f0-9]{32}$/.test(t))return notFound();
  let r;try{r=await fetch(SUPA_URL+'/rest/v1/rpc/shared_trip_get',{method:'POST',headers:{apikey:SUPA_KEY,'Content-Type':'application/json'},body:JSON.stringify({t})});}catch(e){r=null;}
  if(!r||!r.ok)return r&&r.status===404?notFound():new Response('Trip unavailable, try again later',{status:503});
  const s=await r.json();if(!s||!s.name)return notFound();
  const o=s.opts||{},rows=[];
  (s.flights||[]).forEach(f=>rows.push({k:f.departureTime||'',d:dt(f.departureTime),h:`<div class="n">✈ ${esc([f.airline,f.flightNumber].filter(Boolean).join(' '))}${f.from||f.to?` · ${esc(f.from)} → ${esc(f.to)}`:''}</div><div class="m">${[tm(f.departureTime)&&'Departs '+tm(f.departureTime),f.arrivalTime&&('Arrives '+tm(f.arrivalTime)+(f.arrivalTime.slice(0,10)!==String(f.departureTime).slice(0,10)?' ('+dt(f.arrivalTime)+')':'')),f.duration].filter(Boolean).map(esc).join(' · ')}</div>${o.refs&&f.pnr?`<div class="ref">Booking reference ${esc(f.pnr)}</div>`:''}${o.costs&&f.cost?`<div class="ref">${money(f.cost,f.currency)}</div>`:''}`}));
  (s.hotels||[]).forEach(h=>rows.push({k:h.checkIn||'',d:dt(h.checkIn),h:`<div class="n">🏨 ${esc(h.name||'Hotel')}</div><div class="m">${h.checkIn?'Check-in '+esc(dt(h.checkIn)):''}${h.checkOut?' · check-out '+esc(dt(h.checkOut)):''}</div>${o.refs&&h.bookingNumber?`<div class="ref">Confirmation ${esc(h.bookingNumber)}</div>`:''}${o.costs&&h.cost?`<div class="ref">${money(h.cost,h.currency)}</div>`:''}`}));
  (s.activities||[]).forEach(a=>rows.push({k:(a.date||'')+'T'+(a.time||''),d:dt(a.date),h:`<div class="n">🎯 ${esc(a.name||'Activity')}</div><div class="m">${[a.time,a.location,a.duration].filter(Boolean).map(esc).join(' · ')}</div>${o.refs&&a.bookingDetails?`<div class="ref">${esc(a.bookingDetails)}</div>`:''}${o.costs&&a.cost?`<div class="ref">${money(a.cost,a.currency)}</div>`:''}`}));
  (s.transport||[]).forEach(x=>rows.push({k:(x.date||'')+'T'+(x.time||''),d:dt(x.date),h:`<div class="n">🚐 ${esc([x.type,x.name].filter(Boolean).join(' · ')||'Transport')}</div><div class="m">${[x.time,x.location,x.duration].filter(Boolean).map(esc).join(' · ')}</div>${o.refs&&x.bookingDetails?`<div class="ref">${esc(x.bookingDetails)}</div>`:''}${o.costs&&x.cost?`<div class="ref">${money(x.cost,x.currency)}</div>`:''}`}));
  rows.sort((a,b)=>String(a.k).localeCompare(String(b.k)));
  const body=`<div class="k">${s.sharedBy?esc(s.sharedBy)+' shared a trip':'Shared trip'}</div><h1>${esc(s.name)}</h1>
    <div class="sub">${esc(dt(s.startDate))}${s.endDate&&s.endDate!==s.startDate?' – '+esc(dt(s.endDate)):''}${(s.locations||[]).length?' · '+esc(s.locations.join(', ')):''}</div>
    ${o.notes&&s.notes?`<p class="m" style="margin-top:14px;white-space:pre-wrap">${esc(s.notes)}</p>`:''}
    <h2>Itinerary</h2>${rows.length?rows.map(r=>`<div class="it"><div class="d">${esc(r.d)}</div><div>${r.h}</div></div>`).join(''):'<p class="sub">No bookings added yet.</p>'}
    <p class="note">A read-only copy, kept up to date by the trip's owner${s.updated_at?' (last updated '+esc(dt(s.updated_at))+')':''}. Times are local to each place.</p>
    <div class="sig">Planned with The Planner · designed and created by <a href="https://www.instagram.com/irn.w" target="_blank" rel="noopener noreferrer">@irn.w</a></div>`;
  return new Response(page(s.name+' · shared trip',body),{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'private, max-age=60','X-Robots-Tag':'noindex','Referrer-Policy':'no-referrer'}});
}
