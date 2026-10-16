// Calendar feed link: https://theplanner.pages.dev/feed/<token>.ics
// Calendar apps (Apple, Google, Outlook) fetch this; it returns that account's calendar file from Supabase.
// The publishable key is public (it's in index.html too); the database only hands out the feed matching the token.
const SUPA_URL='https://lfezxmbsnsrkyqvismaj.supabase.co';
const SUPA_KEY='sb_publishable_Dq3LuTEfNwRFTQ85XfTIEw_bRBqHqRq';

export async function onRequestGet({params}){
  const t=String(params.token||'').replace(/\.ics$/i,'');
  if(!/^[a-f0-9]{32}$/.test(t))return new Response('Calendar feed not found',{status:404,headers:{'Content-Type':'text/plain; charset=utf-8'}});
  let r;
  try{
    r=await fetch(SUPA_URL+'/rest/v1/rpc/calendar_feed_ics',{method:'POST',headers:{apikey:SUPA_KEY,'Content-Type':'application/json'},body:JSON.stringify({t})});
  }catch(e){return new Response('Calendar feed unavailable, try again later',{status:503});}
  if(!r.ok)return new Response('Calendar feed unavailable, try again later',{status:r.status===404?404:503});
  const ics=await r.json();
  if(!ics)return new Response('Calendar feed not found',{status:404,headers:{'Content-Type':'text/plain; charset=utf-8'}});
  return new Response(ics,{headers:{
    'Content-Type':'text/calendar; charset=utf-8',
    'Content-Disposition':'inline; filename="the-planner.ics"',
    'Cache-Control':'private, max-age=300',
    'X-Robots-Tag':'noindex'
  }});
}
