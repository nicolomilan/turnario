// Turnario API — tutte le scritture passano da qui (il client ha solo lettura via RLS).
import { createClient } from 'npm:@supabase/supabase-js@2';
import { bestSchedule, findOffers, offerValid, CTX_DAYS } from './logic.js';

const URL_ = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const RESEND = Deno.env.get('RESEND_API_KEY') || '';
const FROM = Deno.env.get('EMAIL_FROM') || 'Turnario <onboarding@resend.dev>';
const APP_URL = Deno.env.get('APP_URL') || '';
const db = createClient(URL_, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }
const fail = (status: number, msg: string): never => { throw new HttpError(status, msg); };
const MESI = ['gennaio','febbraio','marzo','aprile','maggio','giugno','luglio','agosto','settembre','ottobre','novembre','dicembre'];
const GG = ['dom','lun','mar','mer','gio','ven','sab'];

/* ---------- date ---------- */
const pad = (x: number) => String(x).padStart(2, '0');
const monthOf = (date: string) => date.slice(0, 7);                // 'YYYY-MM'
const daysIn = (m: string) => { const [y, mo] = m.split('-').map(Number); return new Date(Date.UTC(y, mo, 0)).getUTCDate(); };
const dateOf = (m: string, d: number) => `${m}-${pad(d + 1)}`;
const idxOf = (date: string) => Number(date.slice(8, 10)) - 1;
const addDays = (date: string, k: number) => { const t = new Date(date + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + k); return t.toISOString().slice(0, 10); };
// Codici dei giorni [from..to] per ogni persona (R se nessun turno): serve a collegare i mesi.
async function ctxDays(b: string, from: string, to: string, ids: string[]) {
  const rows = await q(db.from('assignments').select('member_id,day,code').eq('business_id', b).gte('day', from).lte('day', to)) as any[];
  const days: string[] = []; for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  const out: Record<string, string[]> = {};
  ids.forEach((id) => (out[id] = days.map(() => 'R')));
  rows.forEach((r) => { if (out[r.member_id]) out[r.member_id][days.indexOf(r.day)] = r.code; });
  return out;
}
const fmt = (date: string) => { const dt = new Date(date + 'T12:00:00Z'); return `${GG[dt.getUTCDay()]} ${dt.getUTCDate()} ${MESI[dt.getUTCMonth()].slice(0, 3)}`; };
const isMonth = (m: unknown) => typeof m === 'string' && /^\d{4}-\d{2}$/.test(m);
const isDate = (d: unknown) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);

/* ---------- helper db ---------- */
async function q<T = any>(p: PromiseLike<{ data: T; error: any }>): Promise<T> {
  const { data, error } = await p;
  if (error) { console.error(error); fail(500, error.message || 'Errore database'); }
  return data;
}
// limite di frequenza: protegge da abusi e da bollette impreviste
async function limit(key: string, max: number, windowS: number) {
  const { data, error } = await db.rpc('rl_hit', { p_key: key, p_max: max, p_window_s: windowS });
  if (error) { console.warn('rate limit', error.message); return; }
  if (data === false) fail(429, 'Troppe richieste in poco tempo: riprova tra qualche minuto.');
}
async function log(b: string, text: string) { await db.from('audit_log').insert({ business_id: b, text }); }

async function sendEmail(to: string, subject: string, text: string) {
  if (!RESEND || !to) return;
  try {
    const body = text + (APP_URL ? `\n\nApri Turnario: ${APP_URL}` : '');
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM, to: [to], subject, text: body }),
    });
    if (!r.ok) console.warn('resend', r.status, await r.text());
  } catch (e) { console.warn('resend error', e); }
}
type Member = { id: string; business_id: string; user_id: string | null; department_id: string | null; name: string; email: string; role: string; job: string | null; active: boolean; skills: string[]; _dev?: boolean; _imp?: boolean };
async function notify(m: Member | undefined, text: string, subject?: string) {
  if (!m) return;
  await db.from('notifications').insert({ business_id: m.business_id, member_id: m.id, text });
  if (subject) await sendEmail(m.email, subject, text);
}
const first = (m?: Member) => (m ? m.name.split(' ')[0] : '—');

/* ---------- contesto del mese ---------- */
async function loadMonth(b: string, month: string) {
  const n = daysIn(month);
  const [biz, members, shifts, asg, locks, depts, needs, mrules] = await Promise.all([
    q(db.from('businesses').select('*').eq('id', b).single()),
    q(db.from('members').select('*').eq('business_id', b)),
    q(db.from('shift_types').select('*').eq('business_id', b).order('position')),
    q(db.from('assignments').select('member_id,day,code,skill').eq('business_id', b).gte('day', dateOf(month, 0)).lte('day', dateOf(month, n - 1))),
    q(db.from('request_days').select('member_id,day').eq('business_id', b).in('status', ['approved', 'awaiting_manager']).gte('day', dateOf(month, 0)).lte('day', dateOf(month, n - 1))),
    q(db.from('departments').select('*').eq('business_id', b)),
    q(db.from('shift_needs').select('*').eq('business_id', b)),
    q(db.from('member_rules').select('*').eq('business_id', b)),
  ]);
  const skillSeqs: Record<string, (string | null)[]> = {};
  (members as Member[]).forEach((m) => (skillSeqs[m.id] = Array(n).fill(null)));
  (asg as any[]).forEach((a) => { if (skillSeqs[a.member_id]) skillSeqs[a.member_id][idxOf(a.day)] = a.skill; });
  const memberRules = rulesByMember(mrules as any[]);
  const [yy, mm] = month.split('-').map(Number);
  const dow = (d: number) => new Date(Date.UTC(yy, mm - 1, d + 1)).getUTCDay();
  const seqs: Record<string, string[]> = {};
  (members as Member[]).forEach((m) => (seqs[m.id] = Array(n).fill('R')));
  (asg as any[]).forEach((a) => { if (seqs[a.member_id]) seqs[a.member_id][idxOf(a.day)] = a.code; });
  const lockSet = new Set((locks as any[]).map((l) => `${l.member_id}|${idxOf(l.day)}`));
  const byId = new Map((members as Member[]).map((m) => [m.id, m]));
  const ids = (members as Member[]).map((m) => m.id);
  const first0 = dateOf(month, 0), last0 = dateOf(month, n - 1);
  const [pre, post] = await Promise.all([ctxDays(b, addDays(first0, -CTX_DAYS), addDays(first0, -1), ids), ctxDays(b, addDays(last0, 1), addDays(last0, CTX_DAYS), ids)]);
  return { biz: biz as any, rules: (biz as any).rules, members: members as Member[], byId, shifts: shifts as any[], depts: depts as any[], needs: needs as any[], skillSeqs, memberRules, dow, seqs, n, month, pre, post, locked: (id: string, d: number) => lockSet.has(`${id}|${d}`) };
}
type Ctx = Awaited<ReturnType<typeof loadMonth>>;
function deptCtx(c: Ctx, deptId: string | null) {
  return {
    seqs: c.seqs, n: c.n, rules: c.rules, locked: c.locked, pre: c.pre, post: c.post,
    skillSeqs: c.skillSeqs, memberRules: c.memberRules, dow: c.dow,
    skills: Object.fromEntries(c.members.map((m) => [m.id, m.skills || []])),
    shifts: c.shifts.filter((s) => s.department_id === deptId),
    colleagues: c.members.filter((m) => m.active && m.department_id === deptId).map((m) => m.id),
  };
}
async function setCode(b: string, memberId: string, day: string, code: string, skill: string | null = null) {
  if (code === 'R') await q(db.from('assignments').delete().eq('member_id', memberId).eq('day', day));
  else await q(db.from('assignments').upsert({ business_id: b, member_id: memberId, day, code, skill }));
}
function rulesByMember(rows: any[]) {
  const out: Record<string, any[]> = {};
  rows.forEach((r) => (out[r.member_id] ||= []).push(r));
  return out;
}
// chi gestisce le richieste di un dipendente: responsabile del suo team e sostituto (altrimenti la direzione)
function managersFor(c: Ctx, memberId: string) {
  const m = c.byId.get(memberId), dp = c.depts.find((d: any) => d.id === m?.department_id);
  const ids = [dp?.scheduler_id, dp?.deputy_id].filter(Boolean);
  const list = c.members.filter((x) => x.active && ids.includes(x.id) && x.id !== memberId);
  return list.length ? list : c.members.filter((x) => x.active && x.role === 'manager' && x.id !== memberId);
}
const shiftName = (c: Ctx, deptId: string | null, code: string) => c.shifts.find((s) => s.department_id === deptId && s.code === code)?.name || code;

async function sendOffers(c: Ctx, req: any, day: any, offs: any[]) {
  if (!offs.length) return;
  const A = c.byId.get(req.member_id)!;
  const rows = offs.map((o) => ({
    business_id: req.business_id, request_id: req.id, request_day_id: day.id, from_member: req.member_id, to_member: o.to,
    day: day.day, shift_code: day.shift_code, type: o.type, day2: o.type === 'swap' ? dateOf(c.month, o.d2) : null, shift2_code: o.s2 || null,
  }));
  await q(db.from('offers').insert(rows));
  day.asked = [...(day.asked || []), ...offs.map((o) => o.to)];
  await q(db.from('request_days').update({ asked: day.asked }).eq('id', day.id));
  for (const o of offs) {
    const B = c.byId.get(o.to);
    const extra = o.type === 'swap' ? ` In cambio saresti libero/a ${fmt(dateOf(c.month, o.d2))}.` : ' È una copertura senza scambio.';
    await notify(B, `${A.name} ti chiede un cambio: lavoreresti ${fmt(day.day)} (${shiftName(c, A.department_id, day.shift_code)}).${extra} Il primo collega che accetta ottiene il cambio.`, `Turnario: ${first(A)} ti chiede un cambio per ${fmt(day.day)}`);
  }
}

async function afterOfferClosed(c: Ctx, dayId: string) {
  const day = await q(db.from('request_days').select('*').eq('id', dayId).single()) as any;
  if (day.status !== 'pending') return;
  const pend = await q(db.from('offers').select('id').eq('request_day_id', dayId).eq('status', 'pending')) as any[];
  if (pend.length) return;
  const req = await q(db.from('requests').select('*').eq('id', day.request_id).single()) as any;
  const A = c.byId.get(req.member_id)!;
  const ex = rangeIdx(req.date_from, req.date_to);
  const offs = findOffers(deptCtx(c, A.department_id), A.id, idxOf(day.day), ex, day.asked || []).slice(0, c.rules.sendTo);
  if (offs.length) {
    await sendOffers(c, req, day, offs);
    await notify(A, `Per ${fmt(day.day)} nessuno dei colleghi contattati ha accettato: ho ricalcolato e chiesto a ${offs.map((o) => first(c.byId.get(o.to))).join(', ')}.`);
  } else {
    await q(db.from('request_days').update({ status: 'failed' }).eq('id', dayId));
    await notify(A, `Per ${fmt(day.day)} non ci sono altri colleghi compatibili: la richiesta passa al responsabile.`, 'Turnario: richiesta passata al responsabile');
    for (const m of managersFor(c, A.id)) await notify(m, `${A.name}: nessun collega disponibile per ${fmt(day.day)}.`, `Turnario: serve il tuo intervento per ${A.name}`);
  }
}
const rangeIdx = (from: string, to: string) => { const a: number[] = []; for (let d = idxOf(from); d <= idxOf(to); d++) a.push(d); return a; };

async function applyOffer(c: Ctx, o: any) {
  const b = o.business_id;
  const skA = c.skillSeqs[o.from_member]?.[idxOf(o.day)] ?? null, skB = o.day2 ? (c.skillSeqs[o.to_member]?.[idxOf(o.day2)] ?? null) : null;
  await setCode(b, o.from_member, o.day, 'R');
  await setCode(b, o.to_member, o.day, o.shift_code, skA);
  if (o.type === 'swap') { await setCode(b, o.from_member, o.day2, o.shift2_code, skB); await setCode(b, o.to_member, o.day2, 'R'); }
  const A = c.byId.get(o.from_member), B = c.byId.get(o.to_member);
  await log(b, `Turno aggiornato: ${B?.name} copre ${A?.name} ${fmt(o.day)}` + (o.type === 'swap' ? `, in cambio ${A?.name} lavora ${fmt(o.day2)}.` : ' (copertura).'));
}
const toLogicOffer = (o: any) => ({ from: o.from_member, to: o.to_member, d: idxOf(o.day), shift: o.shift_code, type: o.type, d2: o.day2 ? idxOf(o.day2) : null, s2: o.shift2_code });

/* ---------- template iniziale ---------- */
const TEMPLATES: Record<string, any[]> = {
  hotel: [
    { name: 'Ricevimento', shifts: [
      { code: 'M', name: 'Mattina', start_time: '07:00', end_time: '15:00', need: 2, color: '#D97706' },
      { code: 'P', name: 'Pomeriggio', start_time: '15:00', end_time: '23:00', need: 1, color: '#2563EB' },
      { code: 'N', name: 'Notte', start_time: '23:00', end_time: '07:00', need: 1, color: '#4C1D95' }] },
    { name: 'Ristorante', shifts: [
      { code: 'C', name: 'Colazione e pranzo', start_time: '06:30', end_time: '14:30', need: 2, color: '#0F9F6E' },
      { code: 'S', name: 'Cena', start_time: '15:00', end_time: '23:00', need: 3, color: '#BE123C' }] },
  ],
  ristorante: [
    { name: 'Sala', shifts: [
      { code: 'P', name: 'Pranzo', start_time: '10:30', end_time: '15:30', need: 3, color: '#D97706' },
      { code: 'S', name: 'Cena', start_time: '18:00', end_time: '23:30', need: 4, color: '#BE123C' }] },
    { name: 'Cucina', shifts: [
      { code: 'P', name: 'Pranzo', start_time: '09:00', end_time: '15:00', need: 3, color: '#0F9F6E' },
      { code: 'S', name: 'Cena', start_time: '17:00', end_time: '23:30', need: 3, color: '#2563EB' }] },
  ],
};
function tempPassword() {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  const r = crypto.getRandomValues(new Uint8Array(8));
  return 'Turni-' + Array.from(r, (x) => abc[x % abc.length]).join('');
}
const cleanEmail = (e: unknown) => String(e || '').trim().toLowerCase();
const validEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

async function createAuthUser(email: string, password: string, name: string) {
  const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { name } });
  if (error) {
    if (/already|registered|exists/i.test(error.message)) fail(409, 'Esiste già un account con questa email.');
    fail(400, error.message);
  }
  return data.user!;
}

/* ---------- azioni ---------- */
type Me = Member;
const H: Record<string, (me: Me | null, p: any) => Promise<any>> = {};

H.signup_business = async (_me, p) => {
  const email = cleanEmail(p.email), name = String(p.name || '').trim(), bname = String(p.business_name || '').trim();
  const kind = TEMPLATES[p.kind] ? p.kind : 'hotel';
  if (!bname || !name) fail(400, 'Inserisci nome dell\'attività e il tuo nome.');
  if (!validEmail(email)) fail(400, 'Email non valida.');
  if (String(p.password || '').length < 8) fail(400, 'La password deve avere almeno 8 caratteri.');
  const user = await createAuthUser(email, p.password, name);
  const biz = await q(db.from('businesses').insert({ name: bname, kind }).select().single()) as any;
  let i = 0;
  for (const t of TEMPLATES[kind]) {
    const dep = await q(db.from('departments').insert({ business_id: biz.id, name: t.name, position: i++ }).select().single()) as any;
    await q(db.from('shift_types').insert(t.shifts.map((s: any, k: number) => ({ ...s, business_id: biz.id, department_id: dep.id, position: k }))));
  }
  const boss = await q(db.from('members').insert({ business_id: biz.id, user_id: user.id, name, email, role: 'manager', job: 'Responsabile' }).select().single()) as any;
  // all'inizio il responsabile fa i turni di tutti i team: poi li assegna ad altri da Personale
  await q(db.from('departments').update({ scheduler_id: boss.id }).eq('business_id', biz.id));
  await log(biz.id, `${name} ha creato ${bname}.`);
  return { ok: true };
};

function needManager(me: Me | null): asserts me is Me { if (!me || me.role !== 'manager') fail(403, 'Solo il responsabile può farlo.'); }
function needMember(me: Me | null): asserts me is Me { if (!me) fail(401, 'Accesso richiesto.'); }
async function deptRow(me: Me, deptId: string | null) {
  if (!deptId) return null;
  return (await q(db.from('departments').select('*').eq('id', deptId).eq('business_id', me.business_id)) as any[])[0] || null;
}
// fa i turni di quel team (responsabile o sostituto)?
const schedulesDept = (me: Me, dp: any) => !!dp && (dp.scheduler_id === me.id || dp.deputy_id === me.id);
// può modificare turni e fabbisogni del team: responsabile, sostituto o direzione
async function needTeamEditor(me: Me | null, deptId: string | null) {
  needMember(me);
  const dp = await deptRow(me, deptId);
  if (!dp) fail(400, 'Team non valido.');
  if (!(schedulesDept(me, dp) || me.role === 'manager')) fail(403, 'Non gestisci i turni di questo team.');
  return dp;
}
async function devReadsNotes() {
  const r = (await q(db.from('platform_settings').select('value').eq('key', 'dev_reads_notes')) as any[])[0];
  return r ? r.value === true : false;
}
// note riservate: solo responsabile/sostituto del team (e lo sviluppatore finché l'impostazione è attiva)
// solo il responsabile (o sostituto) del team; in "Vedi come" lo sviluppatore le vede solo se l'impostazione lo consente
async function needNotesFor(me: Me, dp: any) {
  if (!schedulesDept(me, dp)) fail(403, 'Queste informazioni sono riservate al responsabile del team.');
  if (me._imp && !(await devReadsNotes())) fail(403, 'Accesso dello sviluppatore alle note disattivato.');
}
async function needNotesAccess(me: Me | null, memberId: string) {
  needMember(me);
  const m = (await q(db.from('members').select('*').eq('id', memberId).eq('business_id', me.business_id)) as Member[])[0];
  if (!m) fail(404, 'Persona non trovata.');
  const dp = await deptRow(me, m.department_id);
  // chi fa i turni del proprio team (es. F&B manager) ha come superiore la direzione
  if (dp && (dp.scheduler_id === m.id || dp.deputy_id === m.id) && me.role === 'manager' && me.id !== m.id) {
    if (me._imp && !(await devReadsNotes())) fail(403, 'Accesso dello sviluppatore alle note disattivato.');
    return { m, dp };
  }
  await needNotesFor(me, dp);
  return { m, dp };
}
const RULE_KINDS = ['avoid_shift', 'prefer_shift', 'only_shifts', 'max_per_month', 'unavailable_weekday', 'avoid_weekday', 'max_weekends_per_month'];
async function cleanRules(me: Me, m: Member, rules: any[], source: 'pref' | 'note') {
  if (!Array.isArray(rules) || rules.length > 12) fail(400, 'Regole non valide.');
  const codes = ((await q(db.from('shift_types').select('code').eq('department_id', m.department_id)) as any[]) || []).map((x) => x.code);
  return rules.map((r: any) => {
    if (!RULE_KINDS.includes(r.kind)) fail(400, 'Tipo di regola non valido.');
    const row: any = { business_id: m.business_id, member_id: m.id, source, kind: r.kind, created_by: me.id, label: String(r.label || '').slice(0, 140) || r.kind };
    const w = Math.round(Number(r.weight) || 2); row.weight = Math.min(source === 'pref' ? 2 : 3, Math.max(1, w));
    if (['avoid_shift', 'prefer_shift', 'max_per_month'].includes(r.kind)) { if (!codes.includes(r.shift_code)) fail(400, 'Turno non valido nella regola.'); row.shift_code = r.shift_code; }
    if (r.kind === 'only_shifts') { const l = (r.shift_codes || []).filter((x: string) => codes.includes(x)); if (!l.length) fail(400, 'Turni non validi nella regola.'); row.shift_codes = l; }
    if (r.kind === 'max_per_month') { const v = Math.round(Number(r.value)); if (!(v >= 0 && v <= 31)) fail(400, 'Numero non valido.'); row.value = v; }
    if (r.kind === 'max_weekends_per_month') { const v = Math.round(Number(r.value)); if (!(v >= 0 && v <= 5)) fail(400, 'Numero di weekend non valido.'); row.value = v; }
    if (['unavailable_weekday', 'avoid_weekday'].includes(r.kind)) { const d = Math.round(Number(r.weekday)); if (!(d >= 0 && d <= 6)) fail(400, 'Giorno non valido.'); row.weekday = d; }
    return row;
  });
}
async function accessLog(me: Me, action: string, target: string | null) {
  await db.from('access_log').insert({ business_id: me.business_id, actor_member: me.id, actor_user: me.user_id, action: (me._dev ? 'dev:' : '') + action, target });
}

H.add_member = async (me, p) => {
  needManager(me);
  const name = String(p.name || '').trim();
  if (!name) fail(400, 'Inserisci il nome.');
  // persona di prova (senza account) creata dallo sviluppatore
  if (me._dev && !p.email) {
    const m = await q(db.from('members').insert({ business_id: me.business_id, department_id: p.department_id || null, name, email: demoEmail(name), role: p.role === 'manager' ? 'manager' : 'employee', job: String(p.job || '').trim() || null, skills: cleanSkills(p.skills) }).select().single()) as Member;
    await log(me.business_id, `Aggiunta persona di prova ${name}.`);
    return { ok: true, member: m };
  }
  const email = cleanEmail(p.email);
  if (!validEmail(email)) fail(400, 'Inserisci un\'email valida.');
  const role = p.role === 'manager' ? 'manager' : 'employee';
  let dept: string | null = p.department_id || null;
  if (dept) {
    const d = await q(db.from('departments').select('id').eq('id', dept).eq('business_id', me.business_id)) as any[];
    if (!d.length) fail(400, 'Team non valido.');
  } else if (role === 'employee') fail(400, 'Scegli un team.');
  const pw = tempPassword();
  const user = await createAuthUser(email, pw, name);
  const m = await q(db.from('members').insert({ business_id: me.business_id, user_id: user.id, department_id: dept, name, email, role, job: String(p.job || '').trim() || null, skills: cleanSkills(p.skills) }).select().single()) as Member;
  await log(me.business_id, `${me.name} ha aggiunto ${name}.`);
  await sendEmail(email, 'Il tuo account Turnario', `Ciao ${name.split(' ')[0]},\n${me.name} ti ha aggiunto su Turnario.\n\nEmail: ${email}\nPassword temporanea: ${pw}\n\nAl primo accesso cambiala dal tuo profilo.`);
  return { ok: true, member: m, password: pw };
};

H.remove_member = async (me, p) => {
  needManager(me);
  const m = await q(db.from('members').select('*').eq('id', p.member_id).eq('business_id', me.business_id).single()) as Member;
  if (m.id === me.id) fail(400, 'Non puoi rimuovere te stesso.');
  const today = new Date().toISOString().slice(0, 10);
  await q(db.from('members').update({ active: false, user_id: null }).eq('id', m.id));
  await q(db.from('assignments').delete().eq('member_id', m.id).gte('day', today));
  await q(db.from('offers').update({ status: 'withdrawn' }).eq('to_member', m.id).eq('status', 'pending'));
  if (m.user_id) await db.auth.admin.deleteUser(m.user_id);
  await log(me.business_id, `${me.name} ha rimosso ${m.name}. Rigenera i turni per ridistribuire i suoi giorni.`);
  return { ok: true };
};

H.reset_password = async (me, p) => {
  needManager(me);
  const m = await q(db.from('members').select('*').eq('id', p.member_id).eq('business_id', me.business_id).single()) as Member;
  if (!m.user_id) fail(400, 'Questa persona non ha un account.');
  const pw = tempPassword();
  const { error } = await db.auth.admin.updateUserById(m.user_id, { password: pw });
  if (error) fail(400, error.message);
  await sendEmail(m.email, 'Nuova password Turnario', `La tua nuova password temporanea è: ${pw}`);
  return { ok: true, password: pw };
};

H.generate = async (me, p) => {
  needMember(me);
  if (!isMonth(p.month)) fail(400, 'Mese non valido.');
  const b = me.business_id, month = p.month, n = daysIn(month);
  const [biz, allDepts, shifts, allMembers, needsRows, ruleRows, evRows] = await Promise.all([
    q(db.from('businesses').select('*').eq('id', b).single()),
    q(db.from('departments').select('*').eq('business_id', b)),
    q(db.from('shift_types').select('*').eq('business_id', b)),
    q(db.from('members').select('*').eq('business_id', b).eq('active', true)),
    q(db.from('shift_needs').select('*').eq('business_id', b)),
    q(db.from('member_rules').select('*').eq('business_id', b)),
    q(db.from('events').select('*').eq('business_id', b).lte('date_from', dateOf(month, n - 1)).gte('date_to', dateOf(month, 0))),
  ]) as any[];
  // la direzione genera tutti i team; un responsabile solo i suoi
  const depts = allDepts.filter((d: any) => (me.role === 'manager' || schedulesDept(me, d)) && (!p.department_id || d.id === p.department_id));
  if (!depts.length) fail(403, 'Non gestisci i turni di nessun team.');
  const members = allMembers.filter((m: any) => depts.some((d: any) => d.id === m.department_id));
  const memberRules = rulesByMember(ruleRows);
  const dow = (d: number) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, d + 1)).getUTCDay();
  const rows: any[] = []; let unc = 0;
  const [y, mo] = month.split('-').map(Number);
  // coda del mese precedente: notti, giorni di fila e riposi continuano oltre il cambio mese
  const pre = await ctxDays(b, addDays(dateOf(month, 0), -CTX_DAYS), addDays(dateOf(month, 0), -1), members.map((m: any) => m.id));
  for (const dp of depts) {
    const ids = members.filter((m: any) => m.department_id === dp.id).map((m: any) => m.id);
    const sh = shifts.filter((s: any) => s.department_id === dp.id);
    if (!ids.length || !sh.length) continue;
    const needs = needsRows.filter((x: any) => sh.some((s: any) => s.id === x.shift_type_id)).map((x: any) => ({ ...x, shift_code: sh.find((s: any) => s.id === x.shift_type_id).code }));
    const skills = Object.fromEntries(members.map((m: any) => [m.id, m.skills || []]));
    // eventi del mese che riguardano questo team
    const dayAdjust = (d: number) => { const day = dateOf(month, d);
      return evRows.filter((e: any) => e.date_from <= day && e.date_to >= day).flatMap((e: any) => (e.adjustments || []).filter((a: any) => a.department_id === dp.id)); };
    const best = bestSchedule({ shifts: sh, memberIds: ids, n, rules: biz.rules, seedBase: y * 12 + mo, pre, skills, needs, memberRules, dow, dayAdjust }, 60);
    unc += best.uncovered;
    for (const id of ids) best.seq[id].forEach((c: string, d: number) => { if (c !== 'R') rows.push({ business_id: b, member_id: id, day: dateOf(month, d), code: c, skill: best.skillSeq[id][d] }); });
  }
  const mids = members.map((m: any) => m.id).concat(['00000000-0000-0000-0000-000000000000']);
  await q(db.from('requests').delete().eq('business_id', b).in('member_id', mids).gte('date_from', dateOf(month, 0)).lte('date_from', dateOf(month, n - 1)));
  await q(db.from('assignments').delete().eq('business_id', b).in('member_id', mids).gte('day', dateOf(month, 0)).lte('day', dateOf(month, n - 1)));
  for (let i = 0; i < rows.length; i += 500) await q(db.from('assignments').insert(rows.slice(i, i + 500)));
  await q(db.from('months').upsert({ business_id: b, month: dateOf(month, 0), generated_at: new Date().toISOString() }));
  const label = `${MESI[mo - 1]} ${y}`;
  await log(b, `Turni di ${label} (${depts.map((d: any) => d.name).join(', ')}) generati automaticamente${unc ? ` (${unc} turni scoperti: servono più persone)` : ''}.`);
  if (p.notify) for (const m of members) await notify(m, `Sono pubblicati i turni di ${label}.`, `Turnario: turni di ${label} pubblicati`);
  return { ok: true, uncovered: unc };
};

H.set_cell = async (me, p) => {
  needMember(me);
  if (!isDate(p.day)) fail(400, 'Data non valida.');
  const m = await q(db.from('members').select('*').eq('id', p.member_id).eq('business_id', me.business_id).single()) as Member;
  await needTeamEditor(me, m.department_id);
  let skill: string | null = null;
  if (p.code !== 'R') {
    const ok = await q(db.from('shift_types').select('id').eq('department_id', m.department_id).eq('code', p.code)) as any[];
    if (!ok.length) fail(400, 'Turno non valido per questo reparto.');
    const nd = await q(db.from('shift_needs').select('skill').eq('shift_type_id', ok[0].id)) as any[];
    skill = (p.skill && (m.skills || []).includes(p.skill)) ? p.skill : (nd.map((x) => x.skill).find((sk) => sk && (m.skills || []).includes(sk) && sk !== 'manager') || nd.map((x) => x.skill).find((sk) => sk && (m.skills || []).includes(sk)) || null);
  }
  await setCode(me.business_id, m.id, p.day, p.code, skill);
  await log(me.business_id, `Modifica manuale: ${m.name} ${fmt(p.day)} → ${p.code === 'R' ? 'Riposo' : p.code}.`);
  return { ok: true };
};

H.save_settings = async (me, p) => {
  needManager(me);
  const r = p.rules || {};
  const int = (v: any, lo: number, hi: number, d: number) => { const x = Math.round(Number(v)); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d; };
  const maxConsec = int(r.maxConsec, 1, 14, 5);
  const rules = { maxConsec, maxConsecEx: int(r.maxConsecEx ?? maxConsec + 1, maxConsec, 14, maxConsec + 1), minRest: int(r.minRest, 0, 24, 11), restPerWeek: int(r.restPerWeek, 0, 4, 2), restAfterNight: int(r.restAfterNight ?? 2, 0, 4, 2), restBlock: int(r.restBlock ?? 3, 0, 7, 3), freeWeekends: int(r.freeWeekends ?? 1, 0, 2, 1), noSingleDays: r.noSingleDays !== false, sendTo: int(r.sendTo, 1, 10, 3), managerApproval: !!r.managerApproval };
  await q(db.from('businesses').update({ rules, ...(p.name ? { name: String(p.name).trim() } : {}) }).eq('id', me.business_id));
  for (const s of p.shifts || []) {
    const t = /^\d\d:\d\d$/;
    if (!t.test(s.start_time) || !t.test(s.end_time)) fail(400, 'Orari non validi.');
    await q(db.from('shift_types').update({ name: String(s.name).trim() || 'Turno', start_time: s.start_time, end_time: s.end_time, need: int(s.need, 0, 50, 1) }).eq('id', s.id).eq('business_id', me.business_id));
  }
  await log(me.business_id, `${me.name} ha aggiornato le regole.`);
  return { ok: true };
};

H.add_department = async (me, p) => {
  needManager(me);
  const name = String(p.name || '').trim(); if (!name) fail(400, 'Nome reparto mancante.');
  await q(db.from('departments').insert({ business_id: me.business_id, name, position: 99 }));
  return { ok: true };
};
H.add_shift = async (me, p) => {
  await needTeamEditor(me, p.department_id);
  const code = String(p.code || '').trim().toUpperCase();
  if (!/^[A-Z]{1,2}$/.test(code) || code === 'R') fail(400, 'Sigla: 1-2 lettere, diversa da R.');
  if (!/^\d\d:\d\d$/.test(p.start_time) || !/^\d\d:\d\d$/.test(p.end_time)) fail(400, 'Orari non validi.');
  const colors = ['#D97706', '#2563EB', '#4C1D95', '#0F9F6E', '#BE123C', '#0E7490', '#A21CAF'];
  const { error } = await db.from('shift_types').insert({ business_id: me.business_id, department_id: p.department_id, code, name: String(p.name || code).trim(), start_time: p.start_time, end_time: p.end_time, need: Math.max(0, Number(p.need) || 1), color: colors[Math.floor(Math.random() * colors.length)], position: 99 });
  if (error) fail(400, /duplicate/.test(error.message) ? 'Sigla già usata in questo reparto.' : error.message);
  return { ok: true };
};
H.delete_shift = async (me, p) => {
  needMember(me);
  const st = (await q(db.from('shift_types').select('*').eq('id', p.shift_id).eq('business_id', me.business_id)) as any[])[0];
  if (!st) fail(404, 'Turno non trovato.');
  await needTeamEditor(me, st.department_id);
  await q(db.from('shift_types').delete().eq('id', p.shift_id).eq('business_id', me.business_id));
  return { ok: true };
};

function checkRange(p: any) {
  if (!isDate(p.from) || !isDate(p.to)) fail(400, 'Date non valide.');
  if (monthOf(p.from) !== monthOf(p.to)) fail(400, 'Il periodo deve stare nello stesso mese.');
  if (p.to < p.from) fail(400, 'La data finale è prima di quella iniziale.');
  if (idxOf(p.to) - idxOf(p.from) > 13) fail(400, 'Massimo 14 giorni per richiesta.');
  if (p.from < new Date().toISOString().slice(0, 10)) fail(400, 'Non puoi chiedere giorni già passati.');
}

H.preview_request = async (me, p) => {
  needMember(me); checkRange(p);
  const c = await loadMonth(me.business_id, monthOf(p.from));
  const k = Math.min(10, Math.max(1, Number(p.k) || c.rules.sendTo));
  const ex = rangeIdx(p.from, p.to), dc = deptCtx(c, me.department_id);
  return {
    days: ex.map((d) => {
      const code = c.seqs[me.id][d];
      if (code === 'R') return { day: dateOf(c.month, d), already: true };
      return { day: dateOf(c.month, d), code, offers: findOffers(dc, me.id, d, ex).slice(0, k).map((o) => ({ to: o.to, type: o.type, day2: o.type === 'swap' ? dateOf(c.month, o.d2) : null, s2: o.s2 || null })) };
    }),
  };
};

H.create_request = async (me, p) => {
  needMember(me); checkRange(p);
  const c = await loadMonth(me.business_id, monthOf(p.from));
  const k = Math.min(10, Math.max(1, Number(p.k) || c.rules.sendTo));
  const open = await q(db.from('request_days').select('day').eq('member_id', me.id).in('status', ['pending', 'claiming', 'awaiting_manager']).gte('day', p.from).lte('day', p.to)) as any[];
  if (open.length) fail(409, `Hai già una richiesta in corso per ${fmt(open[0].day)}.`);
  const req = await q(db.from('requests').insert({ business_id: me.business_id, member_id: me.id, date_from: p.from, date_to: p.to, note: String(p.note || '').slice(0, 200) || null }).select().single()) as any;
  const ex = rangeIdx(p.from, p.to), dc = deptCtx(c, me.department_id);
  let sent = 0;
  for (const d of ex) {
    const code = c.seqs[me.id][d];
    const day = await q(db.from('request_days').insert({ business_id: me.business_id, request_id: req.id, member_id: me.id, day: dateOf(c.month, d), shift_code: code, status: code === 'R' ? 'already' : 'pending' }).select().single()) as any;
    if (code === 'R') continue;
    const offs = findOffers(dc, me.id, d, ex).slice(0, k);
    if (offs.length) { await sendOffers(c, req, day, offs); sent += offs.length; }
    else {
      await q(db.from('request_days').update({ status: 'failed' }).eq('id', day.id));
      for (const m of managersFor(c, me.id)) await notify(m, `${me.name}: nessun collega compatibile per ${fmt(day.day)}.`, `Turnario: serve il tuo intervento per ${me.name}`);
    }
  }
  await log(me.business_id, `${me.name} ha chiesto libero ${p.from === p.to ? fmt(p.from) : `dal ${fmt(p.from)} al ${fmt(p.to)}`}.`);
  return { ok: true, sent };
};

H.accept_offer = async (me, p) => {
  needMember(me);
  const o = await q(db.from('offers').select('*').eq('id', p.offer_id).eq('to_member', me.id).single()) as any;
  if (o.status !== 'pending') fail(409, 'Questa proposta non è più attiva.');
  // Blocco atomico: solo il primo che arriva cambia lo stato da pending a claiming.
  const claimed = await q(db.from('request_days').update({ status: 'claiming', covered_by: me.id }).eq('id', o.request_day_id).eq('status', 'pending').select()) as any[];
  if (!claimed.length) fail(409, 'Un collega ha già accettato prima di te.');
  const c = await loadMonth(me.business_id, monthOf(o.day));
  try {
    if (!offerValid({ ...deptCtx(c, c.byId.get(o.from_member)!.department_id) }, toLogicOffer(o))) {
      await q(db.from('offers').update({ status: 'invalid' }).eq('id', o.id));
      await q(db.from('request_days').update({ status: 'pending', covered_by: null }).eq('id', o.request_day_id));
      await afterOfferClosed(c, o.request_day_id);
      return { ok: false, message: 'Nel frattempo i turni sono cambiati: lo scambio non è più valido.' };
    }
    const A = c.byId.get(o.from_member);
    await q(db.from('offers').update({ status: 'accepted' }).eq('id', o.id));
    const others = await q(db.from('offers').update({ status: 'superseded' }).eq('request_day_id', o.request_day_id).eq('status', 'pending').select()) as any[];
    for (const x of others) await notify(c.byId.get(x.to_member), `La richiesta di ${first(A)} per ${fmt(o.day)} è già stata coperta da ${first(me)}.`);
    if (c.rules.managerApproval) {
      await q(db.from('request_days').update({ status: 'awaiting_manager' }).eq('id', o.request_day_id));
      await notify(A, `${first(me)} ha accettato per ${fmt(o.day)}. Manca l'approvazione del responsabile.`, `Turnario: ${first(me)} ha accettato il cambio`);
      for (const m of managersFor(c, o.from_member)) await notify(m, `Da approvare: ${me.name} copre ${A?.name} ${fmt(o.day)}.`, 'Turnario: un cambio turno da approvare');
      return { ok: true, message: 'Accettato! Manca l\'approvazione del responsabile.' };
    }
    await applyOffer(c, o);
    await q(db.from('request_days').update({ status: 'approved' }).eq('id', o.request_day_id));
    await notify(A, `${first(me)} ha accettato: ${fmt(o.day)} sei libero/a. I turni sono aggiornati.`, `Turnario: ${fmt(o.day)} sei libero/a`);
    return { ok: true, message: 'Fatto! Il tuo turno è stato aggiornato.' };
  } catch (e) {
    await db.from('request_days').update({ status: 'pending', covered_by: null }).eq('id', o.request_day_id).eq('status', 'claiming');
    throw e;
  }
};

H.decline_offer = async (me, p) => {
  needMember(me);
  const o = await q(db.from('offers').select('*').eq('id', p.offer_id).eq('to_member', me.id).single()) as any;
  if (o.status !== 'pending') return { ok: true };
  await q(db.from('offers').update({ status: 'declined' }).eq('id', o.id));
  const c = await loadMonth(me.business_id, monthOf(o.day));
  await notify(c.byId.get(o.from_member), `${first(me)} non può fare il cambio per ${fmt(o.day)}.`);
  await afterOfferClosed(c, o.request_day_id);
  return { ok: true };
};

H.cancel_request = async (me, p) => {
  needMember(me);
  const req = await q(db.from('requests').select('*').eq('id', p.request_id).eq('member_id', me.id).single()) as any;
  await q(db.from('request_days').update({ status: 'cancelled' }).eq('request_id', req.id).eq('status', 'pending'));
  const offs = await q(db.from('offers').update({ status: 'withdrawn' }).eq('request_id', req.id).eq('status', 'pending').select()) as any[];
  const mem = await q(db.from('members').select('*').in('id', offs.map((o) => o.to_member).concat(['00000000-0000-0000-0000-000000000000']))) as Member[];
  for (const o of offs) await notify(mem.find((m) => m.id === o.to_member), `${first(me)} ha ritirato la richiesta per ${fmt(o.day)}.`);
  await log(me.business_id, `${me.name} ha annullato una richiesta.`);
  return { ok: true };
};

async function dayForManager(me: Me | null, id: string) {
  needMember(me);
  const day = await q(db.from('request_days').select('*').eq('id', id).eq('business_id', me.business_id).single()) as any;
  const m = (await q(db.from('members').select('department_id').eq('id', day.member_id)) as any[])[0];
  await needTeamEditor(me, m?.department_id || null);
  return day;
}
H.approve_day = async (me, p) => {
  const day = await dayForManager(me, p.request_day_id);
  if (day.status !== 'awaiting_manager') fail(409, 'Già gestita.');
  const o = (await q(db.from('offers').select('*').eq('request_day_id', day.id).eq('status', 'accepted')) as any[])[0];
  // sblocca il giorno prima di validare (altrimenti il lock blocca lo scambio stesso)
  await q(db.from('request_days').update({ status: 'claiming' }).eq('id', day.id));
  const c = await loadMonth(me.business_id, monthOf(day.day));
  if (o && offerValid(deptCtx(c, c.byId.get(o.from_member)!.department_id), toLogicOffer(o))) {
    await applyOffer(c, o);
    await q(db.from('request_days').update({ status: 'approved' }).eq('id', day.id));
    await notify(c.byId.get(o.from_member), `Il responsabile ha approvato: ${fmt(o.day)} sei libero/a.`, `Turnario: ${fmt(o.day)} approvato`);
    await notify(c.byId.get(o.to_member), `Approvato il cambio con ${first(c.byId.get(o.from_member))} per ${fmt(o.day)}.`);
    return { ok: true, message: 'Approvato, turni aggiornati.' };
  }
  if (o) await q(db.from('offers').update({ status: 'invalid' }).eq('id', o.id));
  await q(db.from('request_days').update({ status: 'pending', covered_by: null }).eq('id', day.id));
  await afterOfferClosed(c, day.id);
  return { ok: false, message: 'Lo scambio non è più valido: ho ricalcolato.' };
};
H.reject_day = async (me, p) => {
  const day = await dayForManager(me, p.request_day_id);
  await q(db.from('request_days').update({ status: 'rejected' }).eq('id', day.id));
  await q(db.from('offers').update({ status: 'withdrawn' }).eq('request_day_id', day.id).eq('status', 'pending'));
  const c = await loadMonth(me.business_id, monthOf(day.day));
  await notify(c.byId.get(day.member_id), `Il responsabile non ha approvato il libero per ${fmt(day.day)}.`, `Turnario: richiesta per ${fmt(day.day)} non approvata`);
  if (day.covered_by) await notify(c.byId.get(day.covered_by), `Il responsabile non ha approvato il cambio per ${fmt(day.day)}.`);
  return { ok: true };
};
H.retry_day = async (me, p) => {
  const day = await dayForManager(me, p.request_day_id);
  if (day.status !== 'failed') fail(409, 'Questa richiesta non è senza copertura.');
  const req = await q(db.from('requests').select('*').eq('id', day.request_id).single()) as any;
  const c = await loadMonth(me.business_id, monthOf(day.day));
  const A = c.byId.get(day.member_id)!;
  const offs = findOffers(deptCtx(c, A.department_id), A.id, idxOf(day.day), rangeIdx(req.date_from, req.date_to)).slice(0, 6);
  if (!offs.length) return { ok: false, message: 'Ancora nessun collega compatibile: modifica i turni a mano.' };
  await q(db.from('request_days').update({ status: 'pending', asked: [] }).eq('id', day.id));
  day.asked = [];
  await sendOffers(c, req, day, offs);
  return { ok: true, message: `Chiesto a ${offs.length} colleghi.` };
};
H.handled_day = async (me, p) => {
  await dayForManager(me, p.request_day_id);
  await q(db.from('request_days').update({ status: 'handled' }).eq('id', p.request_day_id));
  return { ok: true };
};
H.calendar_link = async (me, p) => {
  needMember(me);
  if (p.reset) await q(db.from('calendar_tokens').delete().eq('member_id', me.id));
  let row = (await q(db.from('calendar_tokens').select('token').eq('member_id', me.id)) as any[])[0];
  if (!row) row = await q(db.from('calendar_tokens').insert({ member_id: me.id }).select('token').single());
  const https = `${URL_}/functions/v1/calendar?t=${row.token}`;
  return { ok: true, https, webcal: https.replace(/^https:/, 'webcal:') };
};
H.mark_read = async (me) => {
  needMember(me);
  await q(db.from('notifications').update({ read: true }).eq('member_id', me.id).eq('read', false));
  return { ok: true };
};


/* ---------- organigramma, mansioni, fabbisogni ---------- */
const cleanSkills = (v: any) => (Array.isArray(v) ? v : String(v || '').split(','))
  .map((x: any) => String(x).trim().toLowerCase()).filter((x: string) => /^[a-zà-ù &]{2,24}$/.test(x)).slice(0, 6);
const demoEmail = (name: string) => `${name.toLowerCase().normalize('NFD').replace(/[^a-z ]/g, '').trim().replace(/\s+/g, '.')}.${crypto.randomUUID().slice(0, 4)}@demo.turnario`;

H.update_member = async (me, p) => {
  needManager(me);
  const m = (await q(db.from('members').select('*').eq('id', p.member_id).eq('business_id', me.business_id)) as Member[])[0];
  if (!m) fail(404, 'Persona non trovata.');
  const upd: any = {};
  if (p.name !== undefined) upd.name = String(p.name).trim().slice(0, 80) || m.name;
  if (p.job !== undefined) upd.job = String(p.job).trim().slice(0, 60) || null;
  if (p.skills !== undefined) upd.skills = cleanSkills(p.skills);
  if (p.department_id !== undefined) {
    if (p.department_id && !(await deptRow(me, p.department_id))) fail(400, 'Team non valido.');
    upd.department_id = p.department_id || null;
  }
  if (p.role !== undefined && m.id !== me.id) upd.role = p.role === 'manager' ? 'manager' : 'employee';
  await q(db.from('members').update(upd).eq('id', m.id));
  await log(me.business_id, `${me.name} ha aggiornato ${upd.name || m.name}.`);
  return { ok: true };
};
H.set_team_roles = async (me, p) => {
  needManager(me);
  const dp = await deptRow(me, p.department_id); if (!dp) fail(400, 'Team non valido.');
  const check = async (id: string | null) => { if (id && !(await q(db.from('members').select('id').eq('id', id).eq('business_id', me.business_id)) as any[]).length) fail(400, 'Persona non valida.'); return id || null; };
  await q(db.from('departments').update({ scheduler_id: await check(p.scheduler_id), deputy_id: await check(p.deputy_id), ...(p.name ? { name: String(p.name).trim().slice(0, 40) } : {}) }).eq('id', dp.id));
  await log(me.business_id, `${me.name} ha aggiornato i responsabili di ${dp.name}.`);
  return { ok: true };
};
H.save_needs = async (me, p) => {
  needMember(me);
  const st = (await q(db.from('shift_types').select('*').eq('id', p.shift_type_id).eq('business_id', me.business_id)) as any[])[0];
  if (!st) fail(404, 'Turno non trovato.');
  await needTeamEditor(me, st.department_id);
  const rows = (Array.isArray(p.rows) ? p.rows : []).slice(0, 40).map((r: any) => ({
    business_id: me.business_id, shift_type_id: st.id,
    skill: r.skill ? cleanSkills([r.skill])[0] || null : null,
    weekday: r.weekday === null || r.weekday === undefined || r.weekday === '' ? null : Math.min(6, Math.max(0, Math.round(Number(r.weekday)))),
    need: Math.min(50, Math.max(0, Math.round(Number(r.need) || 0))),
  }));
  await q(db.from('shift_needs').delete().eq('shift_type_id', st.id));
  if (rows.length) await q(db.from('shift_needs').insert(rows));
  return { ok: true };
};

/* ---------- eventi (fiere, settimane della moda, giorni tranquilli) ---------- */
H.save_event = async (me, p) => {
  needMember(me);
  const depts = await q(db.from('departments').select('*').eq('business_id', me.business_id)) as any[];
  const editable = depts.filter((d) => me.role === 'manager' || schedulesDept(me, d));
  if (!editable.length) fail(403, 'Solo chi fa i turni può gestire gli eventi.');
  const name = String(p.name || '').trim().slice(0, 80); if (!name) fail(400, 'Dai un nome all\'evento.');
  if (!isDate(p.date_from) || !isDate(p.date_to) || p.date_to < p.date_from) fail(400, 'Date non valide.');
  const impact = ['busy', 'quiet', 'info'].includes(p.impact) ? p.impact : 'busy';
  const shifts = await q(db.from('shift_types').select('department_id,code').eq('business_id', me.business_id)) as any[];
  const adjustments = (Array.isArray(p.adjustments) ? p.adjustments : []).slice(0, 20).map((a: any) => {
    if (!editable.some((d) => d.id === a.department_id)) fail(403, 'Puoi modificare solo i fabbisogni dei tuoi team.');
    if (!shifts.some((s) => s.department_id === a.department_id && s.code === a.shift_code)) fail(400, 'Turno non valido.');
    const delta = Math.max(-10, Math.min(10, Math.round(Number(a.delta) || 0)));
    return { department_id: a.department_id, shift_code: a.shift_code, skill: a.skill ? cleanSkills([a.skill])[0] || null : null, delta };
  }).filter((a: any) => a.delta !== 0);
  const row = { business_id: me.business_id, name, date_from: p.date_from, date_to: p.date_to, impact, adjustments, note: String(p.note || '').slice(0, 300) || null };
  if (p.id) {
    const ev = (await q(db.from('events').select('*').eq('id', p.id).eq('business_id', me.business_id)) as any[])[0];
    if (!ev) fail(404, 'Evento non trovato.');
    if (ev.created_by !== me.id && me.role !== 'manager') fail(403, 'Può modificarlo solo chi l\'ha creato o la direzione.');
    await q(db.from('events').update(row).eq('id', ev.id));
  } else await q(db.from('events').insert({ ...row, created_by: me.id }));
  await log(me.business_id, `${me.name} ha ${p.id ? 'modificato' : 'aggiunto'} l'evento "${name}" (${fmt(p.date_from)} – ${fmt(p.date_to)}).`);
  return { ok: true };
};
H.delete_event = async (me, p) => {
  needMember(me);
  const ev = (await q(db.from('events').select('*').eq('id', p.event_id).eq('business_id', me.business_id)) as any[])[0];
  if (!ev) fail(404, 'Evento non trovato.');
  if (ev.created_by !== me.id && me.role !== 'manager') fail(403, 'Può eliminarlo solo chi l\'ha creato o la direzione.');
  await q(db.from('events').delete().eq('id', ev.id));
  await log(me.business_id, `${me.name} ha eliminato l'evento "${ev.name}".`);
  return { ok: true };
};

/* ---------- personalizzazione: note riservate, preferenze, regole ---------- */
H.team_personal = async (me, p) => {
  needMember(me);
  const dp = await deptRow(me, p.department_id); if (!dp) fail(400, 'Team non valido.');
  await needNotesFor(me, dp);
  const ms = (await q(db.from('members').select('id').eq('department_id', dp.id).eq('active', true)) as any[]).map((x) => x.id).concat(['00000000-0000-0000-0000-000000000000']);
  const [notes, rules, prefs] = await Promise.all([
    q(db.from('manager_notes').select('*').in('member_id', ms).order('created_at', { ascending: false })),
    q(db.from('member_rules').select('*').in('member_id', ms).order('created_at')),
    q(db.from('preferences').select('*').in('member_id', ms).order('created_at', { ascending: false })),
  ]);
  await accessLog(me, 'read_team_notes', dp.id);
  return { notes, rules, prefs };
};
H.add_note = async (me, p) => {
  const { m } = await needNotesAccess(me, p.member_id);
  const text = String(p.text || '').trim().slice(0, 2000);
  const rows = await cleanRules(me!, m, p.rules || [], 'note');
  if (!text && !rows.length) fail(400, 'Scrivi una nota.');
  if (text) await q(db.from('manager_notes').insert({ business_id: me!.business_id, member_id: m.id, author_id: me!.id, text }));
  if (rows.length) await q(db.from('member_rules').insert(rows));
  await accessLog(me!, 'add_note', m.id);
  return { ok: true, rules: rows.length };
};
H.delete_note = async (me, p) => {
  needMember(me);
  const n = (await q(db.from('manager_notes').select('*').eq('id', p.note_id).eq('business_id', me.business_id)) as any[])[0];
  if (!n) fail(404, 'Nota non trovata.');
  await needNotesAccess(me, n.member_id);
  await q(db.from('manager_notes').delete().eq('id', n.id));
  return { ok: true };
};
H.delete_rule = async (me, p) => {
  needMember(me);
  const r = (await q(db.from('member_rules').select('*').eq('id', p.rule_id).eq('business_id', me.business_id)) as any[])[0];
  if (!r) fail(404, 'Regola non trovata.');
  if (!(r.source === 'pref' && r.member_id === me.id)) await needNotesAccess(me, r.member_id);
  await q(db.from('member_rules').delete().eq('id', r.id));
  return { ok: true };
};
H.my_prefs = async (me) => {
  needMember(me);
  const [prefs, rules] = await Promise.all([
    q(db.from('preferences').select('*').eq('member_id', me.id).order('created_at', { ascending: false })),
    q(db.from('member_rules').select('*').eq('member_id', me.id).eq('source', 'pref').order('created_at')),
  ]);
  return { prefs, rules };
};
H.add_preference = async (me, p) => {
  needMember(me);
  if (!me.department_id) fail(400, 'Non sei in un team.');
  const text = String(p.text || '').trim().slice(0, 1000);
  if (!text) fail(400, 'Scrivi la tua preferenza.');
  const rows = await cleanRules(me, me, p.rules || [], 'pref');
  const pr = await q(db.from('preferences').insert({ business_id: me.business_id, member_id: me.id, text }).select().single());
  if (rows.length) await q(db.from('member_rules').insert(rows));
  return { ok: true, preference: pr };
};
H.delete_preference = async (me, p) => {
  needMember(me);
  await q(db.from('preferences').delete().eq('id', p.preference_id).eq('member_id', me.id));
  return { ok: true };
};

/* ---------- sviluppatore ---------- */
const TEMPLATE_FULL = [
  { key: 'dir', name: 'Direzione', shifts: [
    { code: 'G', name: 'Giornata', start_time: '09:00', end_time: '17:00', need: 0, color: '#0E7490', needs: [
      { skill: null, weekday: null, need: 1 }, ...[1, 2, 3, 4, 5].map((w) => ({ skill: null, weekday: w, need: 2 }))] },
    { code: 'S', name: 'Sera', start_time: '14:00', end_time: '22:00', need: 0, color: '#6D28D9', needs: [
      { skill: null, weekday: null, need: 0 }, ...[1, 2, 3, 4, 5].map((w) => ({ skill: null, weekday: w, need: 1 }))] }] },
  { key: 'fo', name: 'Front Office', shifts: [
    { code: 'M', name: 'Mattina', start_time: '07:00', end_time: '15:00', need: 2, color: '#D97706' },
    { code: 'P', name: 'Pomeriggio', start_time: '15:00', end_time: '23:00', need: 1, color: '#2563EB' },
    { code: 'N', name: 'Notte', start_time: '23:00', end_time: '07:00', need: 1, color: '#4C1D95' }] },
  { key: 'fb', name: 'Ristorante', shifts: [
    { code: 'C', name: 'Mattina', start_time: '06:30', end_time: '14:30', need: 0, color: '#0F9F6E', needs: [
      { skill: 'cameriere', weekday: null, need: 2 }, { skill: 'cameriere', weekday: 6, need: 3 }, { skill: 'cameriere', weekday: 0, need: 3 },
      ...[1, 2, 3, 4, 5].map((w) => ({ skill: 'manager', weekday: w, need: 1 }))] },
    { code: 'S', name: 'Sera', start_time: '15:00', end_time: '23:00', need: 0, color: '#BE123C', needs: [
      { skill: 'chef', weekday: null, need: 1 }, { skill: 'cameriere', weekday: null, need: 1 }] }] },
];
const DEMO_STAFF: [string, string, string, string[], string?][] = [
  // nome, team, ruolo, mansioni, responsabilità
  ['Giorgio Bellini', 'dir', 'Direttore', [], 'admin'],
  ['Federica Neri', 'dir', 'Vice Direttore', []],
  ['Alessandro Riva', 'dir', 'Front Office Manager', [], 'fo-scheduler'],
  ['Silvia Gatti', 'dir', 'Reservation Manager', []],
  ['Lorenzo Fabbri', 'dir', 'Assistant FO Manager', [], 'fo-deputy'],
  ['Marco Rinaldi', 'fo', 'Receptionist', []], ['Giovanni Testa', 'fo', 'Night Auditor', []], ['Martina Sala', 'fo', 'Receptionist', []],
  ['Chiara Villa', 'fo', 'Receptionist', []], ['Davide Monti', 'fo', 'Receptionist', []], ['Elisa Pace', 'fo', 'Receptionist', []], ['Nicola Serra', 'fo', 'Receptionist', []],
  ['Roberto Galli', 'fb', 'F&B Manager', ['manager', 'cameriere'], 'fb-scheduler'],
  ['Paolo Greco', 'fb', 'Chef', ['chef']], ['Anna Ferri', 'fb', 'Chef', ['chef']],
  ['Luca Moretti', 'fb', 'Cameriere', ['cameriere']], ['Sara Conti', 'fb', 'Cameriera', ['cameriere']], ['Matteo Costa', 'fb', 'Cameriere', ['cameriere']],
  ['Giulia Marini', 'fb', 'Cameriera', ['cameriere']], ['Andrea Leone', 'fb', 'Cameriere', ['cameriere']], ['Elena Bassi', 'fb', 'Cameriera', ['cameriere']],
];
async function needDev(user: any) {
  const r = await q(db.from('platform_admins').select('user_id').eq('user_id', user?.id || '00000000-0000-0000-0000-000000000000')) as any[];
  if (!r.length) fail(403, 'Riservato allo sviluppatore.');
}
const D: Record<string, (user: any, p: any) => Promise<any>> = {};
D.dev_bootstrap = async (_u, p) => {
  const n = await q(db.from('platform_admins').select('user_id')) as any[];
  if (n.length) fail(403, 'Lo sviluppatore esiste già.');
  const email = cleanEmail(p.email);
  if (!validEmail(email) || String(p.password || '').length < 10) fail(400, 'Email valida e password di almeno 10 caratteri.');
  const user = await createAuthUser(email, p.password, String(p.name || 'Sviluppatore'));
  await q(db.from('platform_admins').insert({ user_id: user.id }));
  return { ok: true };
};
D.dev_status = async (u) => { await needDev(u); return { ok: true, dev: true, dev_reads_notes: await devReadsNotes() }; };
D.dev_settings = async (u, p) => {
  await needDev(u);
  await q(db.from('platform_settings').upsert({ key: 'dev_reads_notes', value: !!p.dev_reads_notes }));
  return { ok: true };
};
D.dev_create_hotel = async (u, p) => {
  await needDev(u);
  const name = String(p.name || '').trim().slice(0, 80); if (!name) fail(400, 'Nome mancante.');
  const lat = Number(p.lat), lng = Number(p.lng);
  const biz = await q(db.from('businesses').insert({ name, kind: 'hotel', lat: Number.isFinite(lat) ? lat : null, lng: Number.isFinite(lng) ? lng : null, address: String(p.address || '').slice(0, 200) || null }).select().single()) as any;
  const dep: Record<string, any> = {};
  let i = 0;
  for (const t of TEMPLATE_FULL) {
    dep[t.key] = await q(db.from('departments').insert({ business_id: biz.id, name: t.name, position: i++ }).select().single());
    for (const [k, sdef] of t.shifts.entries()) {
      const { needs, ...row } = sdef as any;
      const st = await q(db.from('shift_types').insert({ ...row, business_id: biz.id, department_id: dep[t.key].id, position: k }).select().single()) as any;
      if (needs) await q(db.from('shift_needs').insert(needs.map((n: any) => ({ ...n, business_id: biz.id, shift_type_id: st.id }))));
    }
  }
  if (p.demo) {
    const roles: Record<string, string> = {};
    for (const [nm, team, job, skills, resp] of DEMO_STAFF) {
      const m = await q(db.from('members').insert({ business_id: biz.id, department_id: team ? dep[team].id : null, name: nm, email: demoEmail(nm), role: resp === 'admin' ? 'manager' : 'employee', job, skills }).select().single()) as any;
      if (resp) roles[resp] = m.id;
      roles['name:' + nm] = m.id;
    }
    // regole di esempio della direzione: direttore mai nel weekend, vice al massimo un weekend, FO manager e assistente il meno possibile
    const R = (nm: string, kind: string, extra: any, label: string) => ({ business_id: biz.id, member_id: roles['name:' + nm], source: 'note', kind, weight: 3, label, ...extra });
    await q(db.from('member_rules').insert([
      R('Giorgio Bellini', 'unavailable_weekday', { weekday: 6 }, 'Mai di sabato'), R('Giorgio Bellini', 'unavailable_weekday', { weekday: 0 }, 'Mai di domenica'),
      R('Federica Neri', 'max_weekends_per_month', { value: 1 }, 'Max 1 weekend al mese'),
      R('Alessandro Riva', 'avoid_weekday', { weekday: 6 }, 'Evitare il sabato'), R('Alessandro Riva', 'avoid_weekday', { weekday: 0 }, 'Evitare la domenica'),
      R('Lorenzo Fabbri', 'avoid_weekday', { weekday: 6 }, 'Evitare il sabato'), R('Lorenzo Fabbri', 'avoid_weekday', { weekday: 0 }, 'Evitare la domenica'),
    ]));
    await q(db.from('departments').update({ scheduler_id: roles['admin'] }).eq('id', dep.dir.id));
    await q(db.from('departments').update({ scheduler_id: roles['fo-scheduler'], deputy_id: roles['fo-deputy'] }).eq('id', dep.fo.id));
    await q(db.from('departments').update({ scheduler_id: roles['fb-scheduler'] }).eq('id', dep.fb.id));
  }
  await log(biz.id, `Hotel creato dallo sviluppatore${p.demo ? ' con personale di prova' : ''}.`);
  return { ok: true, business_id: biz.id };
};
D.dev_update_hotel = async (u, p) => {
  await needDev(u);
  const upd: any = {};
  if (p.name) upd.name = String(p.name).trim().slice(0, 80);
  if (p.lat !== undefined) upd.lat = Number(p.lat); if (p.lng !== undefined) upd.lng = Number(p.lng);
  if (p.address !== undefined) upd.address = String(p.address).slice(0, 200);
  await q(db.from('businesses').update(upd).eq('id', p.business_id));
  return { ok: true };
};
D.dev_delete_hotel = async (u, p) => {
  await needDev(u);
  const ms = await q(db.from('members').select('user_id').eq('business_id', p.business_id)) as any[];
  await q(db.from('businesses').delete().eq('id', p.business_id));
  for (const m of ms) if (m.user_id) await db.auth.admin.deleteUser(m.user_id);
  return { ok: true };
};
D.dev_add_admin_member = async (u, p) => {
  // collega il tuo account sviluppatore come persona di un hotel (es. come receptionist)
  await needDev(u);
  const exists = await q(db.from('members').select('id').eq('user_id', u.id)) as any[];
  if (exists.length) fail(409, 'Il tuo account è già collegato a una persona.');
  const m = (await q(db.from('members').select('*').eq('id', p.member_id)) as any[])[0];
  if (!m || m.user_id) fail(400, 'Persona non valida o già collegata.');
  await q(db.from('members').update({ user_id: u.id, email: u.email }).eq('id', m.id));
  return { ok: true };
};

/* ---------- server ---------- */
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
  try {
    if (req.method !== 'POST') fail(405, 'Usa POST.');
    const raw = await req.text();
    if (raw.length > 64000) fail(413, 'Richiesta troppo grande.');
    let body: any = {}; try { body = JSON.parse(raw || '{}'); } catch { fail(400, 'Richiesta non valida.'); }
    const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'ip?';
    const fn = H[body.action], dfn = D[body.action];
    if (!fn && !dfn) fail(400, 'Azione sconosciuta.');
    if (body.action === 'signup_business') { await limit('signup:ip:' + ip, 5, 3600); await limit('signup:all', 50, 86400); return json(await fn(null, body)); }
    if (body.action === 'dev_bootstrap') { await limit('boot:ip:' + ip, 5, 3600); return json(await dfn(null, body)); }
    await limit('ip:' + ip, 600, 60);
    const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const { data, error } = await db.auth.getUser(token);
    if (error || !data.user) fail(401, 'Sessione scaduta: accedi di nuovo.');
    const user = data.user!;
    await limit('user:' + user.id, 120, 60);
    if (['generate', 'preview_request', 'create_request', 'dev_create_hotel', 'add_member', 'reset_password'].includes(body.action)) await limit('heavy:' + user.id, 30, 600);
    if (dfn) return json(await dfn(user, body));
    let me: Me | null = null;
    if (body.as_member) {
      // "Vedi come": solo lo sviluppatore può agire al posto di un'altra persona
      await needDev(user);
      me = (await q(db.from('members').select('*').eq('id', body.as_member).eq('active', true)) as Member[])[0] || null;
      if (!me) fail(404, 'Persona non trovata.');
      me._dev = true; me._imp = true;
    } else {
      const rows = await q(db.from('members').select('*').eq('user_id', user.id).eq('active', true)) as Member[];
      if (!rows.length) fail(403, 'Il tuo account non è collegato a nessuna attività.');
      me = rows[0];
      const isDev = (await q(db.from('platform_admins').select('user_id').eq('user_id', user.id)) as any[]).length > 0;
      if (isDev) me._dev = true;
    }
    return json(await fn(me, body));
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: 'Errore imprevisto. Riprova.' }, 500);
  }
});
