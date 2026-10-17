// The Planner: AI reading for Smart Upload (Supabase Edge Function "ai-scan").
//
// The app only calls this when its own rules can't read a booking. Claude reads the text and returns the
// booking details plus a reusable recipe for that layout (the fixed wording that identifies it, and patterns
// like "Confirmation number: {pnr}"). Recipes are checked here and saved to public.scan_rules, so the next
// booking in the same layout is read by the app's rules without calling the AI.
//
// Limits (enforced in the database, see supabase/ai_scan.sql): 20 AI reads per person per day and
// US$0.50 of AI reading per day for everyone together. Days run on UTC (8am Singapore time).
//
// Secret needed (Supabase → Edge Functions → Secrets): ANTHROPIC_API_KEY.
// SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase automatically.

const MODEL = 'claude-haiku-5-5';
const PRICE_IN = 1 / 1e6;   // US$ per input token (check console.anthropic.com/pricing)
const PRICE_OUT = 5 / 1e6;  // US$ per output token
const MAX_OUT = 1500;
const PER_USER_DAY = 20;
const DAILY_CAP_USD = 0.5;
const MAX_TEXT = 12000;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

// ───────── Recipe patterns (the same engine runs in the app) ─────────
export const RULE_FIELDS: Record<string, string> = {
  pnr: 'code', bookingNumber: 'code', cost: 'amount', currency: 'cur', date: 'date', dateTo: 'date', nights: 'int',
  hotelName: 'text', title: 'text', provider: 'text', roomType: 'text', departureTime: 'time', arrivalTime: 'time',
  airline: 'text', flightNumber: 'fn', fromCode: 'iata', toCode: 'iata', from: 'text', to: 'text', arrivalDate: 'date', seat: 'seat',
};
const LEG_FIELDS = ['airline', 'flightNumber', 'fromCode', 'toCode', 'from', 'to', 'date', 'departureTime', 'arrivalDate', 'arrivalTime', 'seat'];
const RULE_VAL: Record<string, string> = {
  code: '[A-Z0-9][A-Z0-9-]{3,23}', amount: "\\d[\\d,.' ]*\\d|\\d", cur: '[A-Z]{3}|Rp\\.?|RM|[A-Z]{0,2}\\$|[^\\sA-Za-z0-9]{1,2}',
  date: '[^\\n]{3,32}?', int: '\\d{1,3}', text: '[^\\n]{2,80}?', time: '\\d{1,2}[:.h]\\d{2}(?:\\s*[AaPp]\\.?[Mm]\\.?)?|[0-2]\\d[0-5]\\d',
  fn: '[A-Z0-9]{2}\\s?\\d{1,4}', iata: '[A-Z]{3}', seat: '\\d{1,2}[A-K]',
};
export function compileScanPattern(p: string, flags = '') {
  const parts = p.split(/(\{[a-zA-Z]+\})/);
  const fields: string[] = [];
  let re = '';
  parts.forEach((part, i) => {
    const ph = part.match(/^\{([a-zA-Z]+)\}$/);
    if (ph) {
      const t = RULE_FIELDS[ph[1]];
      if (!t) throw new Error('unknown field ' + ph[1]);
      fields.push(ph[1]);
      let v = RULE_VAL[t];
      // Free text or a date at the very end of a pattern runs to the end of its line
      if (v.endsWith('?') && !parts.slice(i + 1).join('').trim()) v = v.slice(0, -1);
      re += '(' + v + ')';
      return;
    }
    // Fixed wording: letters match either case, punctuation is optional, any spacing (OCR merges and splits words)
    const toks = part.match(/[A-Za-z]+|\d+|[^\sA-Za-z\d]/g) || [];
    if (!toks.length) { re += '\\s*'; return; }
    re += '\\s*' + toks.map(t => /^[A-Za-z]+$/.test(t)
      ? t.replace(/[A-Za-z]/g, c => '[' + c.toUpperCase() + c.toLowerCase() + ']')
      : '(?:' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')?').join('\\s*') + '\\s*';
  });
  if (!fields.length) throw new Error('no field');
  return { re: new RegExp(re, flags), fields };
}
const normWords = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
// Does what a pattern captured agree with what Claude read?
function agrees(field: string, raw: string, want: unknown): boolean {
  if (want === undefined || want === null || want === '') return false;
  const w = String(want), r = raw.trim();
  switch (RULE_FIELDS[field]) {
    case 'code': case 'iata': case 'fn': case 'seat': return r.replace(/\s/g, '').toUpperCase() === w.replace(/\s/g, '').toUpperCase();
    case 'amount': return parseFloat(r.replace(/[,' ]/g, '')) === parseFloat(w.replace(/[,' ]/g, ''));
    case 'int': return parseInt(r, 10) === parseInt(w, 10);
    case 'time': return r.replace(/\D/g, '').replace(/^0/, '') === w.replace(/\D/g, '').replace(/^0/, '') || /[ap]/i.test(r);
    case 'date': {
      const m = w.match(/^(\d{4})-(\d{2})-(\d{2})$/); if (!m) return false;
      const day = String(parseInt(m[3], 10)), mon = MON[parseInt(m[2], 10) - 1], low = r.toLowerCase();
      return new RegExp('(^|\\D)0?' + day + '(\\D|$)').test(low) && (low.includes(mon) || new RegExp('(^|\\D)0?' + parseInt(m[2], 10) + '(\\D|$)').test(low));
    }
    case 'cur': return true;
    default: { const a = normWords(r), b = normWords(w); return !!a && !!b && (a === b || (a.includes(b) && a.length - b.length < 12)); }
  }
}
const cleanLiteral = (p: string) => p.replace(/\{[a-zA-Z]+\}/g, ' ');
// Fixed wording may not carry personal details: no digits, no emails, nothing long
const literalOk = (s: string) => !/\d|@/.test(s) && s.length <= 80;

// Keep only the parts of Claude's recipe that are safe and that really reproduce what it read
export function checkRecipe(text: string, out: any) {
  const rule = out && out.rule || {};
  const words = normWords(text);
  const signature = (Array.isArray(rule.signature) ? rule.signature : [])
    .map((s: unknown) => String(s || '').trim())
    .filter((s: string) => s.length >= 6 && s.length <= 60 && literalOk(s) && words.includes(normWords(s)) && normWords(s).split(' ').length >= 2)
    .slice(0, 6);
  if (signature.length < 2) return null;
  const b = out.booking || {};
  const patterns: { field: string; pattern: string }[] = [];
  for (const p of (Array.isArray(rule.patterns) ? rule.patterns : []).slice(0, 20)) {
    const pattern = String(p && p.pattern || '');
    if (!pattern || pattern.length > 160 || !literalOk(cleanLiteral(pattern))) continue;
    if (!cleanLiteral(pattern).trim()) continue; // a bare {field} isn't a recipe
    try {
      const { re, fields } = compileScanPattern(pattern);
      if (fields.some(f => LEG_FIELDS.includes(f) && !(f in b))) continue;
      const m = text.match(re);
      if (!m) continue;
      if (fields.every((f, i) => f === 'currency' || agrees(f, m[i + 1], b[f]))) patterns.push({ field: fields.join(','), pattern });
    } catch (_) { /* not a valid pattern */ }
  }
  let legPattern = '';
  const legs = Array.isArray(out.legs) ? out.legs : [];
  const lp = String(rule.legPattern || '');
  if (legs.length && lp && lp.length <= 240 && literalOk(cleanLiteral(lp))) {
    try {
      const { re, fields } = compileScanPattern(lp, 'g');
      if (fields.includes('flightNumber')) {
        const ms = [...text.matchAll(re)];
        const ok = ms.length === legs.length && ms.every((m, k) => fields.every((f, i) => agrees(f, m[i + 1], legs[k][f]) || (f !== 'flightNumber' && !legs[k][f])));
        if (ok) legPattern = lp;
      }
    } catch (_) { /* not a valid pattern */ }
  }
  if (!patterns.length && !legPattern) return null;
  return { signature, patterns, legPattern };
}

// What a saved pattern gives on this text: 'agree' with what Claude read, 'wrong', or 'none' (no match)
function patternResult(text: string, pattern: string, b: any): 'agree' | 'wrong' | 'none' {
  try {
    const { re, fields } = compileScanPattern(pattern);
    const m = text.match(re);
    if (!m) return 'none';
    return fields.every((f, i) => f === 'currency' || agrees(f, m[i + 1], b[f])) ? 'agree' : 'wrong';
  } catch (_) { return 'none'; }
}
const sigWords = (s: string) => ' ' + normWords(s) + ' ';
// A recipe the app already used on this text (all its identifying wording is here), which fell short.
// The new patterns are added to it, so one layout keeps one recipe that grows instead of several partial ones.
export function mergeRecipe(text: string, out: any, recipe: { signature: string[]; patterns: { field: string; pattern: string }[]; legPattern: string }, existing: any[]) {
  const words = sigWords(text);
  const hit = (existing || [])
    .filter(r => Array.isArray(r.signature) && r.signature.length >= 2 && r.signature.every((x: string) => words.includes(sigWords(x))))
    .sort((a, b) => b.signature.length - a.signature.length)[0];
  if (!hit) return null;
  const b = out.booking || {};
  // Keep old patterns unless they read this booking wrongly; add new ones for fields the old ones don't get right here
  const kept = (Array.isArray(hit.patterns) ? hit.patterns : []).filter((p: any) => patternResult(text, p.pattern, b) !== 'wrong');
  const good = new Set<string>();
  kept.forEach((p: any) => { if (patternResult(text, p.pattern, b) === 'agree') String(p.field).split(',').forEach(f => good.add(f)); });
  const added = recipe.patterns.filter(p => !kept.some((o: any) => o.pattern === p.pattern) && p.field.split(',').some(f => !good.has(f)));
  const patterns = [...kept, ...added].slice(-30);
  // A leg pattern that reproduces these legs replaces one that doesn't
  let legPattern = hit.leg_pattern || '';
  if (recipe.legPattern && legPattern !== recipe.legPattern) {
    let oldOk = false;
    try { const { re } = compileScanPattern(legPattern, 'g'); oldOk = legPattern !== '' && [...text.matchAll(re)].length === (out.legs || []).length; } catch (_) { /* invalid */ }
    if (!oldOk) legPattern = recipe.legPattern;
  }
  return { id: hit.id, patterns, legPattern, changed: added.length > 0 || kept.length !== (hit.patterns || []).length || legPattern !== (hit.leg_pattern || '') };
}

// ───────── Claude ─────────
const SYSTEM = `You read travel booking confirmations (flights, hotels, activities, transport) that were turned into text by OCR, so expect misread characters, merged columns and stray specks.

Call record_booking once with:
1. booking: the details exactly as the booking states them. Times as HH:MM, 24-hour. Dates as YYYY-MM-DD (if a year isn't shown, use the next occurrence after today, ${'${TODAY}'}). cost: the total actually paid or payable for the whole booking, digits only (no currency, no thousands separators). currency: ISO code (¥ is JPY unless the booking is in China). pnr: the airline booking reference or the hotel confirmation number. Leave out anything not in the text; never guess.
2. legs: for flights, one entry per flight segment in order.
3. rule: a recipe so a simple program can read the next booking in this same layout without you.
   - signature: 2 to 5 phrases of fixed template wording that every booking in this layout will contain, copied exactly from the text (e.g. "View & Edit Your Stay", "Total for stay"). Never names, emails, addresses, numbers, dates, hotel or city names.
   - patterns: for each booking field, a pattern copied from the text with the value replaced by a placeholder, e.g. "Confirmation number: {pnr}", "Total for stay: {currency}{cost}", "Check-in\\n{date}". Use \\n where the value is on the next line. Placeholders: {pnr} {bookingNumber} {hotelName} {title} {provider} {roomType} {date} {dateTo} {nights} {cost} {currency} {departureTime} {arrivalTime}. The fixed text must be the label wording only: no digits, names, or other personal details.
   - legPattern: for flights, one pattern that matches each flight segment's block, with placeholders {flightNumber} {fromCode} {toCode} {from} {to} {date} {departureTime} {arrivalTime} {arrivalDate} {seat} {airline}.`;

const TOOL = {
  name: 'record_booking',
  description: 'Record the booking details and a reusable recipe for this layout.',
  input_schema: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['flight', 'hotel', 'activity', 'transport'] },
      booking: {
        type: 'object',
        properties: Object.fromEntries(['hotelName', 'title', 'provider', 'pnr', 'bookingNumber', 'date', 'dateTo', 'cost', 'currency', 'roomType', 'departureTime', 'arrivalTime', 'transportType']
          .map(k => [k, { type: 'string' }]).concat([['nights', { type: 'integer' }], ['locations', { type: 'array', items: { type: 'string' } }]] as any)),
      },
      legs: {
        type: 'array',
        items: { type: 'object', properties: Object.fromEntries(LEG_FIELDS.map(k => [k, { type: 'string' }])) },
      },
      rule: {
        type: 'object',
        properties: {
          signature: { type: 'array', items: { type: 'string' } },
          patterns: { type: 'array', items: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } },
          legPattern: { type: 'string' },
        },
        required: ['signature', 'patterns'],
      },
    },
    required: ['type', 'booking', 'rule'],
  },
};

async function askClaude(text: string, key: string) {
  const today = new Date().toISOString().slice(0, 10);
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL, max_tokens: MAX_OUT, system: SYSTEM.replace('${TODAY}', today),
      tools: [TOOL], tool_choice: { type: 'tool', name: 'record_booking' },
      messages: [{ role: 'user', content: '<booking_text>\n' + text + '\n</booking_text>' }],
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data && data.error && data.error.message) || 'AI request failed (' + r.status + ')');
  const use = data.usage || {};
  const cost = (use.input_tokens || 0) * PRICE_IN + (use.output_tokens || 0) * PRICE_OUT;
  const tool = (data.content || []).find((c: any) => c.type === 'tool_use');
  return { out: tool ? tool.input : null, cost };
}

// ───────── Request ─────────
export async function handle(req: Request, env: Record<string, string | undefined>, ask = askClaude): Promise<Response> {
  if (req.method === 'OPTIONS') return json({ ok: true });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const URL_ = env.SUPABASE_URL, ANON = env.SUPABASE_ANON_KEY, SERVICE = env.SUPABASE_SERVICE_ROLE_KEY, KEY = env.ANTHROPIC_API_KEY;
  if (!URL_ || !SERVICE || !ANON) return json({ error: 'Server not configured' }, 500);
  if (!KEY) return json({ error: 'not_enabled' }, 503);

  // Who is asking (signed-in accounts only)
  const auth = req.headers.get('authorization') || '';
  const who = await fetch(URL_ + '/auth/v1/user', { headers: { apikey: ANON, authorization: auth } });
  if (!who.ok) return json({ error: 'Please sign in again.' }, 401);
  const user = await who.json();

  const body = await req.json().catch(() => ({}));
  const text = String(body.text || '').slice(0, MAX_TEXT);
  if (text.replace(/\s/g, '').length < 30) return json({ error: 'Not enough text to read.' }, 400);

  const db = (fn: string, args: unknown) => fetch(URL_ + '/rest/v1/rpc/' + fn, {
    method: 'POST',
    headers: { apikey: SERVICE, authorization: 'Bearer ' + SERVICE, 'content-type': 'application/json' },
    body: JSON.stringify(args),
  }).then(async r => { const j = await r.json().catch(() => null); if (!r.ok) throw new Error((j && j.message) || 'database error'); return j; });

  // Reserve the worst case up front so simultaneous scans can't overshoot the daily cap
  const estimate = (text.length / 3.5 + 1500) * PRICE_IN + MAX_OUT * PRICE_OUT;
  const slot = await db('ai_scan_reserve', { p_user: user.id, p_estimate: estimate, p_user_limit: PER_USER_DAY, p_daily_cap: DAILY_CAP_USD });
  if (!slot || !slot.ok) return json({ error: slot && slot.reason || 'limit', remaining: slot && slot.remaining || 0 }, 429);

  let res;
  try { res = await ask(text, KEY); }
  catch (e) { await db('ai_scan_finish', { p_id: slot.id, p_cost: 0, p_status: 'failed' }).catch(() => {}); return json({ error: String((e as Error).message || e) }, 502); }
  await db('ai_scan_finish', { p_id: slot.id, p_cost: res.cost, p_status: 'done' }).catch(() => {});
  const out = res.out;
  if (!out || !out.type) return json({ error: 'The AI could not read this booking.', remaining: slot.remaining }, 422);

  // Learn the layout (only the checked parts of the recipe are kept)
  let learned = null;
  const recipe = checkRecipe(text, out);
  if (recipe) {
    const existing = await fetch(URL_ + '/rest/v1/scan_rules?select=id,signature,patterns,leg_pattern&kind=eq.' + encodeURIComponent(out.type), {
      headers: { apikey: SERVICE, authorization: 'Bearer ' + SERVICE },
    }).then(r => r.ok ? r.json() : []).catch(() => []);
    const into = mergeRecipe(text, out, recipe, existing);
    if (into) learned = into.changed
      ? await db('scan_rule_save', { p_kind: out.type, p_signature: recipe.signature, p_patterns: into.patterns, p_leg_pattern: into.legPattern || null, p_into: into.id }).catch(() => null)
      : into.id;
    else learned = await db('scan_rule_save', { p_kind: out.type, p_signature: recipe.signature, p_patterns: recipe.patterns, p_leg_pattern: recipe.legPattern || null, p_into: null }).catch(() => null);
  }
  return json({ type: out.type, booking: out.booking || {}, legs: out.legs || [], learned: !!learned, ruleId: learned, remaining: slot.remaining });
}

declare const Deno: any;
if (typeof Deno !== 'undefined') Deno.serve((req: Request) => handle(req, Deno.env.toObject()));
