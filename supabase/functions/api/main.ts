// Turnario API — tutte le scritture passano da qui (il client ha solo lettura via RLS).
import { createClient } from 'npm:@supabase/supabase-js@2';
import { findOffers, offerValid, swapOptions, CTX_DAYS, planVariants, planMetrics, holidaysOfMonth, italianHolidays, nightCodes, targetDays } from './logic.js';

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
// giorni approvati di ferie/permesso/malattia → { 'member|YYYY-MM-DD': kind }
async function leaveDays(b: string, from: string, to: string) {
  const rows = await q(db.from('leaves').select('member_id,kind,date_from,date_to').eq('business_id', b).eq('status', 'approved').lte('date_from', to).gte('date_to', from)) as any[];
  const out = new Map<string, string>();
  for (const l of rows) for (let d = l.date_from < from ? from : l.date_from; d <= l.date_to && d <= to; d = addDays(d, 1)) out.set(`${l.member_id}|${d}`, l.kind);
  return out;
}
// giorni di ferie che si scalano dal saldo: esclusi domeniche e festivi
function leaveCount(from: string, to: string) {
  let k = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) { const wd = new Date(d + 'T12:00:00Z').getUTCDay(); if (wd !== 0 && !italianHolidays(Number(d.slice(0, 4)))[d.slice(5)]) k++; }
  return k;
}
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
  // chi è in ferie o malattia non può coprire né essere spostato in quei giorni
  (await leaveDays(b, dateOf(month, 0), dateOf(month, n - 1))).forEach((_k, key) => { const [id, d] = key.split('|'); lockSet.add(`${id}|${idxOf(d)}`); });
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
// ogni modifica di un turno finisce nello storico (con chi l'ha fatta), così si può annullare
type Meta = { actor?: string | null; source?: string; batch?: string };
async function setCode(b: string, memberId: string, day: string, code: string, skill: string | null = null, meta: Meta = {}) {
  const old = (await q(db.from('assignments').select('code,skill').eq('member_id', memberId).eq('day', day)) as any[])[0];
  const oc = old?.code || 'R', os = old?.skill ?? null;
  if (oc === code && (code === 'R' || os === skill)) return;
  if (code === 'R') await q(db.from('assignments').delete().eq('member_id', memberId).eq('day', day));
  else await q(db.from('assignments').upsert({ business_id: b, member_id: memberId, day, code, skill }));
  await db.from('change_log').insert({ business_id: b, batch: meta.batch || crypto.randomUUID(), member_id: memberId, day, old_code: oc, new_code: code, old_skill: os, new_skill: code === 'R' ? null : skill, actor: meta.actor || null, source: meta.source || 'sistema' });
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
  const rows = offs.map((o, i) => ({
    business_id: req.business_id, request_id: req.id, request_day_id: day.id, from_member: req.member_id, to_member: o.to,
    day: day.day, shift_code: day.shift_code, type: o.type, day2: o.type === 'swap' ? dateOf(c.month, o.d2) : null, shift2_code: o.s2 || null,
    rank: (day.asked || []).length + i + 1, score: o.score ?? null,
  }));
  await q(db.from('offers').insert(rows));
  day.asked = [...(day.asked || []), ...offs.map((o) => o.to)];
  await q(db.from('request_days').update({ asked: day.asked }).eq('id', day.id));
  for (const o of offs) {
    const B = c.byId.get(o.to);
    const extra = o.type === 'swap' ? ` In cambio saresti libero/a ${fmt(dateOf(c.month, o.d2))}.` : ' È una copertura senza scambio.';
    const sn = shiftName(c, A.department_id, day.shift_code);
    if (req.kind === 'malattia') await notify(B, `Urgente: ${A.name} è assente per malattia. Puoi coprire ${fmt(day.day)} (${sn})?${extra} Il primo che accetta prende il turno.`, `Turnario: urgente, serve una copertura ${fmt(day.day)}`);
    else if (req.kind === 'scambio') await notify(B, `${A.name} ti propone uno scambio: tu lavori ${fmt(day.day)} (${sn}), lui/lei lavora il tuo ${fmt(dateOf(c.month, o.d2))}. Serve poi l'ok del responsabile.`, `Turnario: ${first(A)} ti propone uno scambio`);
    else await notify(B, `${A.name} ti chiede un cambio: lavoreresti ${fmt(day.day)} (${sn}).${extra} Il primo collega che accetta ottiene il cambio.`, `Turnario: ${first(A)} ti chiede un cambio per ${fmt(day.day)}`);
  }
}

async function afterOfferClosed(c: Ctx, dayId: string) {
  const day = await q(db.from('request_days').select('*').eq('id', dayId).single()) as any;
  if (day.status !== 'pending') return;
  const pend = await q(db.from('offers').select('id').eq('request_day_id', dayId).eq('status', 'pending')) as any[];
  if (pend.length) return;
  const req = await q(db.from('requests').select('*').eq('id', day.request_id).single()) as any;
  const A = c.byId.get(req.member_id)!;
  if (req.kind === 'scambio') {
    await q(db.from('request_days').update({ status: 'cancelled' }).eq('id', dayId));
    await notify(A, `Lo scambio proposto per ${fmt(day.day)} non è andato in porto.`);
    return;
  }
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
  const b = o.business_id, mt: Meta = { actor: o.to_member, source: o.type === 'swap' ? 'scambio' : 'copertura', batch: crypto.randomUUID() };
  const skA = c.skillSeqs[o.from_member]?.[idxOf(o.day)] ?? null, skB = o.day2 ? (c.skillSeqs[o.to_member]?.[idxOf(o.day2)] ?? null) : null;
  await setCode(b, o.from_member, o.day, 'R', null, mt);
  await setCode(b, o.to_member, o.day, o.shift_code, skA, mt);
  if (o.type === 'swap') { await setCode(b, o.from_member, o.day2, o.shift2_code, skB, mt); await setCode(b, o.to_member, o.day2, 'R', null, mt); }
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

async function createAuthUser(email: string, password: string, name: string, mustChange = false) {
  // con una password temporanea, al primo accesso si deve sceglierne una nuova
  const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { name, must_change: mustChange } });
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
// chi può gestire una persona: chi fa i turni del suo team; per chi non ha un team, la direzione
async function needMemberEditor(me: Me | null, m: Member) {
  if (m.department_id) return needTeamEditor(me, m.department_id);
  needManager(me);
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
  const leads = me.role === 'manager' && me.id !== m.id
    ? ((await q(db.from('departments').select('id').eq('business_id', me.business_id).or(`scheduler_id.eq.${m.id},deputy_id.eq.${m.id}`)) as any[]).length > 0) : false;
  if (leads) {
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
  const user = await createAuthUser(email, pw, name, true);
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
  const { error } = await db.auth.admin.updateUserById(m.user_id, { password: pw, user_metadata: { name: m.name, must_change: true } });
  if (error) fail(400, error.message);
  await sendEmail(m.email, 'Nuova password Turnario', `La tua nuova password temporanea è: ${pw}`);
  return { ok: true, password: pw };
};

// regole di occupazione del team: [{min|max: %, shift_code, skill, delta}]
function occAdjust(dp: any, rooms: number | undefined, total: number) {
  if (rooms == null || !total) return [];
  const pct = (rooms / total) * 100;
  return (dp.occ_rules || []).filter((r: any) => (r.min != null && pct >= r.min) || (r.max != null && pct <= r.max))
    .map((r: any) => ({ department_id: dp.id, shift_code: r.shift_code, skill: r.skill || null, delta: Number(r.delta) || 0 }));
}
// Turni lavorati negli ultimi 12 mesi (notti, weekend, festivi): servono all'equità nel tempo
async function historyFor(b: string, month: string, members: any[], shifts: any[]) {
  const end = addDays(dateOf(month, 0), -1), [y, mo] = month.split('-').map(Number);
  const start = `${mo === 12 ? y : y - 1}-${pad(mo === 12 ? 1 : mo)}-01`;
  const rows: any[] = [];
  for (let from = 0; ; from += 1000) {
    const part = await q(db.from('assignments').select('member_id,day,code').eq('business_id', b).gte('day', start).lte('day', end).in('member_id', members.map((m) => m.id).concat(['00000000-0000-0000-0000-000000000000'])).range(from, from + 999)) as any[];
    rows.push(...part); if (part.length < 1000) break;
  }
  const nightsBy: Record<string, Set<string>> = {};
  for (const m of members) nightsBy[m.id] = nightCodes(shifts.filter((s: any) => s.department_id === m.department_id));
  const holCache: Record<number, Record<string, string>> = {};
  const out: Record<string, { nights: number; weekends: number; holidays: number }> = {};
  members.forEach((m) => (out[m.id] = { nights: 0, weekends: 0, holidays: 0 }));
  for (const r of rows) {
    const h = out[r.member_id]; if (!h) continue;
    const yy = Number(r.day.slice(0, 4)), wd = new Date(r.day + 'T12:00:00Z').getUTCDay();
    if (nightsBy[r.member_id].has(r.code)) h.nights++;
    if (wd === 0 || wd === 6) h.weekends++;
    if ((holCache[yy] ||= italianHolidays(yy))[r.day.slice(5)]) h.holidays++;
  }
  return out;
}

// Calcola 3 versioni del piano (senza salvarle nei turni): la direzione sceglie e applica.
// Opzioni: department_id, from (data: ricalcola solo da quel giorno), member_ids (solo quelle persone).
H.generate = async (me, p) => {
  needMember(me);
  if (!isMonth(p.month)) fail(400, 'Mese non valido.');
  const b = me.business_id, month = p.month, n = daysIn(month);
  const first0 = dateOf(month, 0), last0 = dateOf(month, n - 1);
  const [biz, allDepts, shifts, allMembers, needsRows, ruleRows, evRows, asg, locks, reqLocks] = await Promise.all([
    q(db.from('businesses').select('*').eq('id', b).single()),
    q(db.from('departments').select('*').eq('business_id', b)),
    q(db.from('shift_types').select('*').eq('business_id', b)),
    q(db.from('members').select('*').eq('business_id', b).eq('active', true)),
    q(db.from('shift_needs').select('*').eq('business_id', b)),
    q(db.from('member_rules').select('*').eq('business_id', b)),
    q(db.from('events').select('*').eq('business_id', b).lte('date_from', last0).gte('date_to', first0)),
    q(db.from('assignments').select('member_id,day,code,skill').eq('business_id', b).gte('day', first0).lte('day', last0)),
    q(db.from('cell_locks').select('member_id,day').eq('business_id', b).gte('day', first0).lte('day', last0)),
    q(db.from('request_days').select('member_id,day').eq('business_id', b).in('status', ['approved', 'awaiting_manager']).gte('day', first0).lte('day', last0)),
  ]) as any[];
  // la direzione genera tutti i team; un responsabile solo i suoi
  const depts = allDepts.filter((d: any) => (me.role === 'manager' || schedulesDept(me, d)) && (!p.department_id || d.id === p.department_id));
  if (!depts.length) fail(403, 'Non gestisci i turni di nessun team.');
  const members = allMembers.filter((m: any) => depts.some((d: any) => d.id === m.department_id));
  const onlyIds: string[] | null = Array.isArray(p.member_ids) && p.member_ids.length ? p.member_ids.filter((x: any) => members.some((m: any) => m.id === x)) : null;
  if (onlyIds && !onlyIds.length) fail(400, 'Nessuna persona valida.');
  // da quale giorno ricalcolare: mai i giorni già passati di un mese che ha già i turni
  const today = new Date().toISOString().slice(0, 10);
  let fromIdx = isDate(p.from) && monthOf(p.from) === month ? idxOf(p.from) : 0;
  if (asg.length && monthOf(today) === month) fromIdx = Math.max(fromIdx, idxOf(today));
  if (asg.length && today > last0 && !p.allow_past) fail(400, 'Questo mese è già passato.');
  const memberRules = rulesByMember(ruleRows);
  const dow = (d: number) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, d + 1)).getUTCDay();
  const holidays = holidaysOfMonth(month);
  const [y, mo] = month.split('-').map(Number);
  const cur: Record<string, string[]> = {}, curSk: Record<string, (string | null)[]> = {};
  members.forEach((m: any) => { cur[m.id] = Array(n).fill('R'); curSk[m.id] = Array(n).fill(null); });
  asg.forEach((a: any) => { if (cur[a.member_id]) { cur[a.member_id][idxOf(a.day)] = a.code; curSk[a.member_id][idxOf(a.day)] = a.skill; } });
  // giorni da tenere segnati dalle persone nella raccolta "rifacciamo i turni" (ancora da applicare)
  const wins = await q(db.from('rework_windows').select('id').eq('business_id', b).eq('month', first0).is('applied_at', null)) as any[];
  const keeps = wins.length ? await q(db.from('keep_days').select('id,member_id,day,code').in('window_id', wins.map((w: any) => w.id))) as any[] : [];
  const lockSet = new Set([...locks, ...reqLocks, ...keeps].map((l: any) => `${l.member_id}|${idxOf(l.day)}`));
  // ferie e malattie approvate: riposo fisso e monte giorni ridotto in proporzione
  const lv = await leaveDays(b, first0, last0), leaveBy: Record<string, number> = {};
  lv.forEach((_k, key) => { const [id] = key.split('|'); leaveBy[id] = (leaveBy[id] || 0) + 1; });
  const T0 = targetDays(n, biz.rules), targetAdj = Object.fromEntries(Object.entries(leaveBy).map(([id, k]) => [id, Math.round((k * T0) / n)]));
  const pre = await ctxDays(b, addDays(first0, -CTX_DAYS), addDays(first0, -1), members.map((m: any) => m.id));
  const history = await historyFor(b, month, members, shifts);
  // occupazione prevista (dal PMS): sopra/sotto una soglia aggiunge o toglie persone
  const occRows = await q(db.from('occupancy').select('day,rooms').eq('business_id', b).gte('day', first0).lte('day', last0)) as any[];
  const occ = new Map(occRows.map((r: any) => [r.day, r.rooms])), totalRooms = Number(biz.rules?.totalRooms) || 0;
  const variants: any[] = [];
  let locked = 0;
  for (const dp of depts) {
    const ids = members.filter((m: any) => m.department_id === dp.id).map((m: any) => m.id);
    const sh = shifts.filter((s: any) => s.department_id === dp.id);
    if (!ids.length || !sh.length) continue;
    const needs = needsRows.filter((x: any) => sh.some((s: any) => s.id === x.shift_type_id)).map((x: any) => ({ ...x, shift_code: sh.find((s: any) => s.id === x.shift_type_id).code }));
    const skills = Object.fromEntries(members.map((m: any) => [m.id, m.skills || []]));
    const dayAdjust = (d: number) => { const day = dateOf(month, d);
      const ev = evRows.filter((e: any) => e.date_from <= day && e.date_to >= day).flatMap((e: any) => (e.adjustments || []).filter((a: any) => a.department_id === dp.id));
      return ev.concat(occAdjust(dp, occ.get(day), totalRooms)); };
    // celle fisse: bloccate, prima del giorno scelto, persone escluse
    const fixed: Record<string, Record<number, any>> = {};
    for (const id of ids) {
      fixed[id] = {};
      for (let d = 0; d < n; d++) {
        if (lv.has(`${id}|${dateOf(month, d)}`) && d >= fromIdx) { fixed[id][d] = { code: 'R', skill: null }; continue; }
        const isLocked = lockSet.has(`${id}|${d}`);
        if (isLocked || d < fromIdx || (onlyIds && !onlyIds.includes(id))) { fixed[id][d] = { code: cur[id][d], skill: curSk[id][d] }; if (isLocked && d >= fromIdx) locked++; }
      }
    }
    const current = asg.length ? Object.fromEntries(ids.map((id: string) => [id, cur[id]])) : null;
    const V = planVariants({ shifts: sh, memberIds: ids, n, rules: biz.rules, seedBase: y * 12 + mo + Math.floor(Math.random() * 1000), pre, skills, needs, memberRules, dow, dayAdjust, fixed, history, holidays, current, targetAdj }, 30);
    V.forEach((v: any, k: number) => {
      const t = variants[k] ||= { key: v.key, label: v.label, hint: v.hint, metrics: null, rows: [] };
      const m = planMetrics(v.result, ids, sh, dow, holidays, history);
      if (!t.metrics) t.metrics = m;
      else for (const key of Object.keys(m)) t.metrics[key] = /Spread$/.test(key) ? Math.max(t.metrics[key], (m as any)[key]) : t.metrics[key] + (m as any)[key];
      for (const id of ids) v.result.seq[id].forEach((c: string, d: number) => { if (c !== 'R') t.rows.push([id, d, c, v.result.skillSeq[id][d]]); });
    });
  }
  if (!variants.length) fail(400, 'Mancano persone o turni nei team.');
  const scope = { depts: depts.map((d: any) => d.id), from: fromIdx, members: onlyIds, month };
  await db.from('plan_drafts').delete().eq('business_id', b).eq('created_by', me.id);
  const draft = await q(db.from('plan_drafts').insert({ business_id: b, month: first0, scope, variants, created_by: me.id }).select('id').single()) as any;
  const pubs = await q(db.from('publications').select('department_id').eq('month', first0).in('department_id', scope.depts)) as any[];
  return { ok: true, draft_id: draft.id, from: dateOf(month, fromIdx), locked, keeps: keeps.filter((k: any) => members.some((m: any) => m.id === k.member_id)), published: pubs.length === scope.depts.length, partial: pubs.length > 0 && pubs.length < scope.depts.length,
    variants: variants.map((v) => ({ key: v.key, label: v.label, hint: v.hint, metrics: v.metrics, rows: v.rows })) };
};

// Applica la versione scelta: cambia solo le celle diverse, le registra nello storico, avvisa chi è toccato se il mese è pubblicato
H.apply_plan = async (me, p) => {
  needMember(me);
  const dr = (await q(db.from('plan_drafts').select('*').eq('id', p.draft_id).eq('business_id', me.business_id).eq('created_by', me.id)) as any[])[0];
  if (!dr) fail(404, 'Proposta scaduta: rigenera.');
  const v = dr.variants.find((x: any) => x.key === p.key); if (!v) fail(400, 'Versione non valida.');
  const { month, from, depts } = dr.scope, n = daysIn(month), b = me.business_id;
  const allDepts = await q(db.from('departments').select('*').eq('business_id', b).in('id', depts)) as any[];
  if (!allDepts.every((d: any) => me.role === 'manager' || schedulesDept(me, d))) fail(403, 'Non gestisci più questi team.');
  const members = await q(db.from('members').select('*').eq('business_id', b).in('department_id', depts).eq('active', true)) as any[];
  const ids = dr.scope.members || members.map((m: any) => m.id);
  const fromDay = dateOf(month, from), last0 = dateOf(month, n - 1);
  const [asg, locks, reqLocks] = await Promise.all([
    q(db.from('assignments').select('member_id,day,code,skill').eq('business_id', b).in('member_id', ids).gte('day', fromDay).lte('day', last0)),
    q(db.from('cell_locks').select('member_id,day').eq('business_id', b).gte('day', fromDay).lte('day', last0)),
    q(db.from('request_days').select('member_id,day').eq('business_id', b).in('status', ['approved', 'awaiting_manager']).gte('day', fromDay).lte('day', last0)),
  ]) as any[];
  const lockSet = new Set([...locks, ...reqLocks].map((l: any) => `${l.member_id}|${l.day}`));
  const lvA = await leaveDays(b, fromDay, last0);
  const cur = new Map(asg.map((a: any) => [`${a.member_id}|${a.day}`, a]));
  const want = new Map<string, any>();
  for (const [id, d, c, sk] of v.rows) if (d >= from && ids.includes(id)) want.set(`${id}|${dateOf(month, d)}`, { code: c, skill: sk });
  const batch = crypto.randomUUID(), logs: any[] = [], ups: any[] = [], dels: Record<string, string[]> = {}, touched: Record<string, number> = {};
  for (const id of ids) for (let d = from; d < n; d++) {
    const day = dateOf(month, d), key = `${id}|${day}`;
    if (lockSet.has(key) || (lvA.has(key) && !cur.get(key))) continue;
    const o = cur.get(key) as any, w = want.get(key);
    const oc = o?.code || 'R', nc = w?.code || 'R';
    if (oc === nc && (nc === 'R' || (o?.skill ?? null) === (w?.skill ?? null))) continue;
    if (nc === 'R') (dels[id] ||= []).push(day); else ups.push({ business_id: b, member_id: id, day, code: nc, skill: w.skill ?? null });
    logs.push({ business_id: b, batch, member_id: id, day, old_code: oc, new_code: nc, old_skill: o?.skill ?? null, new_skill: w?.skill ?? null, actor: me.id, source: 'piano' });
    if (oc !== nc) touched[id] = (touched[id] || 0) + 1;
  }
  for (const [id, days] of Object.entries(dels)) await q(db.from('assignments').delete().eq('member_id', id).in('day', days));
  for (let i = 0; i < ups.length; i += 500) await q(db.from('assignments').upsert(ups.slice(i, i + 500)));
  for (let i = 0; i < logs.length; i += 500) await q(db.from('change_log').insert(logs.slice(i, i + 500)));
  await q(db.from('months').upsert({ business_id: b, month: dateOf(month, 0), generated_at: new Date().toISOString() }));
  await db.from('plan_drafts').delete().eq('id', dr.id);
  // la raccolta dei giorni da tenere è servita: si chiude
  const nowIso = new Date().toISOString();
  await db.from('rework_windows').update({ applied_at: nowIso }).in('department_id', depts).eq('month', dateOf(month, 0)).is('applied_at', null);
  await db.from('rework_windows').update({ closed_at: nowIso }).in('department_id', depts).eq('month', dateOf(month, 0)).is('closed_at', null);
  const [y, mo] = month.split('-').map(Number), label = `${MESI[mo - 1]} ${y}`;
  const pubs = new Set((await q(db.from('publications').select('department_id').eq('month', dateOf(month, 0)).in('department_id', depts)) as any[]).map((x) => x.department_id));
  for (const m of members) if (touched[m.id] && pubs.has(m.department_id)) await notify(m, `I tuoi turni di ${label} sono cambiati (${touched[m.id]} ${touched[m.id] === 1 ? 'giorno' : 'giorni'}).`, `Turnario: turni di ${label} aggiornati`);
  await log(b, `${me.name} ha applicato il piano "${v.label}" per ${label} (${allDepts.map((d: any) => d.name).join(', ')}${from ? `, dal ${fmt(fromDay)}` : ''}): ${logs.length} celle cambiate.`);
  return { ok: true, changed: logs.length, batch };
};

// Pubblica il mese: da bozza (visibile solo a chi fa i turni) a visibile per tutti, con una notifica a ognuno
H.publish_month = async (me, p) => {
  needMember(me);
  if (!isMonth(p.month)) fail(400, 'Mese non valido.');
  const b = me.business_id, first0 = dateOf(p.month, 0);
  const all = await q(db.from('departments').select('*').eq('business_id', b)) as any[];
  const depts = all.filter((d: any) => (me.role === 'manager' || schedulesDept(me, d)) && (!p.department_id || d.id === p.department_id));
  if (!depts.length) fail(403, 'Non gestisci i turni di nessun team.');
  const already = new Set((await q(db.from('publications').select('department_id').eq('month', first0).in('department_id', depts.map((d: any) => d.id))) as any[]).map((x) => x.department_id));
  const todo = depts.filter((d: any) => !already.has(d.id));
  if (!todo.length) return { ok: true, already: true };
  await q(db.from('publications').insert(todo.map((d: any) => ({ business_id: b, department_id: d.id, month: first0, published_by: me.id }))));
  const [y, mo] = p.month.split('-').map(Number), label = `${MESI[mo - 1]} ${y}`;
  const ms = await q(db.from('members').select('*').eq('business_id', b).eq('active', true).in('department_id', todo.map((d: any) => d.id))) as Member[];
  for (const m of ms) if (m.id !== me.id) await notify(m, `Sono pubblicati i turni di ${label}.`, `Turnario: turni di ${label} pubblicati`);
  await log(b, `${me.name} ha pubblicato i turni di ${label} (${todo.map((d: any) => d.name).join(', ')}).`);
  return { ok: true, published: todo.length };
};
H.unpublish_month = async (me, p) => {
  needMember(me);
  if (!isMonth(p.month)) fail(400, 'Mese non valido.');
  const all = await q(db.from('departments').select('*').eq('business_id', me.business_id)) as any[];
  const depts = all.filter((d: any) => (me.role === 'manager' || schedulesDept(me, d)) && (!p.department_id || d.id === p.department_id));
  if (!depts.length) fail(403, 'Non gestisci i turni di nessun team.');
  await q(db.from('publications').delete().eq('month', dateOf(p.month, 0)).in('department_id', depts.map((d: any) => d.id)));
  await log(me.business_id, `${me.name} ha riportato in bozza i turni di ${p.month}.`);
  return { ok: true };
};

// Lucchetto su una cella: la rigenerazione non la tocca
H.toggle_lock = async (me, p) => {
  needMember(me);
  if (!isDate(p.day)) fail(400, 'Data non valida.');
  const m = await q(db.from('members').select('*').eq('id', p.member_id).eq('business_id', me.business_id).single()) as Member;
  await needTeamEditor(me, m.department_id);
  const ex = await q(db.from('cell_locks').select('day').eq('member_id', m.id).eq('day', p.day)) as any[];
  const on = p.on ?? !ex.length;
  if (on && !ex.length) await q(db.from('cell_locks').insert({ business_id: me.business_id, member_id: m.id, day: p.day }));
  if (!on && ex.length) await q(db.from('cell_locks').delete().eq('member_id', m.id).eq('day', p.day));
  return { ok: true, locked: on };
};

// Equità nel tempo: notti, weekend e festivi degli ultimi 12 mesi (per il Report)
H.fairness = async (me, p) => {
  needMember(me);
  if (!isMonth(p.month)) fail(400, 'Mese non valido.');
  const ms = await editableMemberIds(me);
  const shifts = await q(db.from('shift_types').select('*').eq('business_id', me.business_id)) as any[];
  return { history: await historyFor(me.business_id, p.month, ms, shifts) };
};
// Storico delle modifiche (raggruppate) per chi fa i turni
async function editableMemberIds(me: Me) {
  const ds = await q(db.from('departments').select('*').eq('business_id', me.business_id)) as any[];
  const mine = ds.filter((d: any) => me.role === 'manager' || schedulesDept(me, d)).map((d: any) => d.id);
  if (!mine.length) fail(403, 'Non gestisci i turni di nessun team.');
  const ms = await q(db.from('members').select('id,name,department_id').eq('business_id', me.business_id).in('department_id', mine)) as any[];
  return ms;
}
H.history = async (me, p) => {
  needMember(me);
  const ms = await editableMemberIds(me), names = new Map(ms.map((m: any) => [m.id, m.name]));
  const all = await q(db.from('members').select('id,name').eq('business_id', me.business_id)) as any[];
  const anyName = new Map(all.map((m: any) => [m.id, m.name]));
  let qq = db.from('change_log').select('*').eq('business_id', me.business_id).in('member_id', ms.map((m: any) => m.id)).order('id', { ascending: false }).limit(400);
  if (isMonth(p.month)) qq = qq.gte('day', dateOf(p.month, 0)).lte('day', dateOf(p.month, daysIn(p.month) - 1));
  const rows = await q(qq) as any[];
  const groups: any[] = [], byB = new Map<string, any>();
  for (const r of rows) {
    let g = byB.get(r.batch);
    if (!g) { g = { batch: r.batch, at: r.created_at, source: r.source, actor: anyName.get(r.actor) || null, undone: !!r.undone_at, items: [] }; byB.set(r.batch, g); groups.push(g); }
    g.items.push({ member: names.get(r.member_id), day: r.day, from: r.old_code, to: r.new_code });
  }
  return { groups: groups.slice(0, 60) };
};
H.undo_change = async (me, p) => {
  needMember(me);
  const ms = await editableMemberIds(me), ok = new Set(ms.map((m: any) => m.id));
  const rows = await q(db.from('change_log').select('*').eq('business_id', me.business_id).eq('batch', p.batch).is('undone_at', null).order('id', { ascending: false })) as any[];
  if (!rows.length) fail(404, 'Niente da annullare.');
  if (!rows.every((r) => ok.has(r.member_id))) fail(403, 'Non gestisci tutti i turni di questa modifica.');
  const batch = crypto.randomUUID(); let done = 0, skipped = 0;
  for (const r of rows) {
    const curr = (await q(db.from('assignments').select('code').eq('member_id', r.member_id).eq('day', r.day)) as any[])[0]?.code || 'R';
    if (curr !== r.new_code) { skipped++; continue; } // nel frattempo è cambiato di nuovo: non lo tocco
    await setCode(me.business_id, r.member_id, r.day, r.old_code, r.old_skill, { actor: me.id, source: 'annulla', batch });
    done++;
  }
  await q(db.from('change_log').update({ undone_at: new Date().toISOString() }).eq('batch', p.batch));
  await log(me.business_id, `${me.name} ha annullato una modifica (${done} celle${skipped ? `, ${skipped} lasciate perché cambiate dopo` : ''}).`);
  return { ok: true, done, skipped };
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
  await setCode(me.business_id, m.id, p.day, p.code, skill, { actor: me.id, source: 'manuale' });
  // una cella messa a mano resta bloccata: la rigenerazione non la sposta
  if (p.lock !== false) await db.from('cell_locks').upsert({ business_id: me.business_id, member_id: m.id, day: p.day });
  await log(me.business_id, `Modifica manuale: ${m.name} ${fmt(p.day)} → ${p.code === 'R' ? 'Riposo' : p.code}.`);
  return { ok: true };
};

H.save_settings = async (me, p) => {
  needManager(me);
  const r = p.rules || {};
  const int = (v: any, lo: number, hi: number, d: number) => { const x = Math.round(Number(v)); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d; };
  const maxConsec = int(r.maxConsec, 1, 14, 5);
  const rules = { maxConsec, maxConsecEx: int(r.maxConsecEx ?? maxConsec + 1, maxConsec, 14, maxConsec + 1), minRest: int(r.minRest, 0, 24, 11), restPerWeek: int(r.restPerWeek, 0, 4, 2), restAfterNight: int(r.restAfterNight ?? 2, 0, 4, 2), restBlock: int(r.restBlock ?? 3, 0, 7, 3), freeWeekends: int(r.freeWeekends ?? 1, 0, 2, 1), noSingleDays: r.noSingleDays !== false, sendTo: int(r.sendTo, 1, 10, 3), managerApproval: !!r.managerApproval, offerExpiryH: int(r.offerExpiryH ?? 12, 1, 72, 12), leaveDays: int(r.leaveDays ?? 26, 0, 60, 26) };
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
    const rq = (await q(db.from('requests').select('kind').eq('id', o.request_id)) as any[])[0] || {};
    // scambio diretto: sempre con l'ok del responsabile; malattia: niente attese
    if (rq.kind === 'scambio' || (c.rules.managerApproval && rq.kind !== 'malattia')) {
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
/* ---------- Rifacciamo i turni: ognuno segna i giorni da tenere ---------- */
async function openWindow(me: Me, id: string) {
  const w = (await q(db.from('rework_windows').select('*').eq('id', id).eq('business_id', me.business_id)) as any[])[0];
  if (!w) fail(404, 'Raccolta non trovata.');
  return w;
}
const windowOpen = (w: any) => !w.closed_at && !w.applied_at && Date.parse(w.closes_at) > Date.now();
H.open_rework = async (me, p) => {
  if (!isMonth(p.month)) fail(400, 'Mese non valido.');
  const dp = await needTeamEditor(me, p.department_id);
  const today = new Date().toISOString().slice(0, 10), first0 = dateOf(p.month, 0), last0 = dateOf(p.month, daysIn(p.month) - 1);
  let from = isDate(p.from) && p.from >= first0 && p.from <= last0 ? p.from : first0;
  if (from < today) from = today > last0 ? last0 : today;
  const hours = Math.max(1, Math.min(168, Math.round(Number(p.hours) || 48)));
  const max = p.max_per_person === '' || p.max_per_person == null ? null : Math.max(0, Math.min(31, Math.round(Number(p.max_per_person))));
  const open = (await q(db.from('rework_windows').select('*').eq('department_id', dp.id).eq('month', first0).is('applied_at', null)) as any[]).filter(windowOpen);
  if (open.length) fail(409, 'C\'è già una raccolta aperta per questo mese.');
  const closes = new Date(Date.now() + hours * 3600e3).toISOString();
  const w = await q(db.from('rework_windows').insert({ business_id: me.business_id, department_id: dp.id, month: first0, from_day: from, closes_at: closes, max_per_person: max, reason: String(p.reason || '').slice(0, 200) || null, created_by: me.id }).select().single()) as any;
  const [y, mo] = p.month.split('-').map(Number), label = `${MESI[mo - 1]} ${y}`;
  const when = new Date(closes).toLocaleString('it-IT', { timeZone: 'Europe/Rome', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  const ms = await q(db.from('members').select('*').eq('department_id', dp.id).eq('active', true)) as Member[];
  for (const m of ms) if (m.id !== me.id) await notify(m, `Si rifanno i turni di ${label} dal ${fmt(from)}${w.reason ? ` (${w.reason})` : ''}. Entro ${when} segna nel tuo mese i giorni che vuoi tenere: tutto il resto potrà cambiare.`, `Turnario: segna i giorni da tenere entro ${when}`);
  await log(me.business_id, `${me.name} ha aperto la raccolta dei giorni da tenere per ${dp.name}, ${label} dal ${fmt(from)}.`);
  return { ok: true, id: w.id };
};
H.set_keep = async (me, p) => {
  needMember(me);
  const w = await openWindow(me, p.window_id);
  if (me.department_id !== w.department_id) fail(403, 'Questa raccolta non è per il tuo team.');
  if (!windowOpen(w)) fail(409, 'La raccolta è chiusa.');
  if (!isDate(p.day) || p.day < w.from_day || monthOf(p.day) !== String(w.month).slice(0, 7)) fail(400, 'Giorno fuori dal periodo da rifare.');
  if (p.keep === false) { await q(db.from('keep_days').delete().eq('window_id', w.id).eq('member_id', me.id).eq('day', p.day)); return { ok: true }; }
  if (w.max_per_person != null) {
    const n = (await q(db.from('keep_days').select('id').eq('window_id', w.id).eq('member_id', me.id)) as any[]).length;
    if (n >= w.max_per_person) fail(409, `Puoi tenere al massimo ${w.max_per_person} giorni.`);
  }
  const a = (await q(db.from('assignments').select('code,skill').eq('member_id', me.id).eq('day', p.day)) as any[])[0];
  await q(db.from('keep_days').upsert({ window_id: w.id, business_id: me.business_id, member_id: me.id, day: p.day, code: a?.code || 'R', skill: a?.skill ?? null }, { onConflict: 'window_id,member_id,day' }));
  return { ok: true };
};
H.close_rework = async (me, p) => {
  const w = await openWindow(me, p.window_id);
  await needTeamEditor(me, w.department_id);
  await q(db.from('rework_windows').update(p.cancel ? { closed_at: new Date().toISOString(), applied_at: new Date().toISOString() } : { closed_at: new Date().toISOString() }).eq('id', w.id));
  return { ok: true };
};
// il responsabile sblocca un giorno che impedisce di coprire i turni: la persona viene avvisata
H.unlock_keep = async (me, p) => {
  needMember(me);
  const k = (await q(db.from('keep_days').select('*').eq('id', p.id).eq('business_id', me.business_id)) as any[])[0];
  if (!k) fail(404, 'Blocco non trovato.');
  const m = await q(db.from('members').select('*').eq('id', k.member_id).single()) as Member;
  await needTeamEditor(me, m.department_id);
  await q(db.from('keep_days').delete().eq('id', k.id));
  await notify(m, `Per coprire tutti i turni ${first(me)} ha dovuto sbloccare il tuo ${fmt(k.day)}${p.reason ? `: ${String(p.reason).slice(0, 150)}` : ''}. Ti avviso quando i nuovi turni sono pronti.`, `Turnario: sbloccato il tuo ${fmt(k.day)}`);
  await log(me.business_id, `${me.name} ha sbloccato il giorno da tenere di ${m.name} (${fmt(k.day)}).`);
  return { ok: true };
};

/* ---------- Occupazione prevista (importata dal PMS o scritta a mano) ---------- */
H.save_occupancy = async (me, p) => {
  needMember(me);
  const ds = await q(db.from('departments').select('*').eq('business_id', me.business_id)) as any[];
  if (!(me.role === 'manager' || ds.some((d: any) => schedulesDept(me, d)))) fail(403, 'Solo chi fa i turni può farlo.');
  if (p.total_rooms != null) {
    const t = Math.round(Number(p.total_rooms)); if (!(t >= 0 && t <= 5000)) fail(400, 'Numero di camere non valido.');
    const biz = await q(db.from('businesses').select('rules').eq('id', me.business_id).single()) as any;
    await q(db.from('businesses').update({ rules: { ...biz.rules, totalRooms: t } }).eq('id', me.business_id));
  }
  const rows = (Array.isArray(p.rows) ? p.rows : []).slice(0, 400).filter((r: any) => isDate(r.day) && Number.isFinite(Number(r.rooms)))
    .map((r: any) => ({ business_id: me.business_id, day: r.day, rooms: Math.max(0, Math.min(5000, Math.round(Number(r.rooms)))) }));
  if (rows.length) await q(db.from('occupancy').upsert(rows));
  const del = (Array.isArray(p.clear) ? p.clear : []).filter(isDate);
  if (del.length) await q(db.from('occupancy').delete().eq('business_id', me.business_id).in('day', del));
  return { ok: true, saved: rows.length };
};
H.save_occ_rules = async (me, p) => {
  const dp = await needTeamEditor(me, p.department_id);
  const sh = await q(db.from('shift_types').select('code').eq('department_id', dp.id)) as any[];
  const rules = (Array.isArray(p.rules) ? p.rules : []).slice(0, 8).map((r: any) => ({
    min: r.min === '' || r.min == null ? null : Math.max(0, Math.min(100, Number(r.min))),
    max: r.max === '' || r.max == null ? null : Math.max(0, Math.min(100, Number(r.max))),
    shift_code: String(r.shift_code || ''), skill: r.skill ? String(r.skill).slice(0, 30) : null, delta: Math.max(-5, Math.min(5, Math.round(Number(r.delta) || 0))),
  })).filter((r: any) => (r.min != null || r.max != null) && r.delta && sh.some((x: any) => x.code === r.shift_code));
  await q(db.from('departments').update({ occ_rules: rules }).eq('id', dp.id));
  return { ok: true };
};

/* ---------- Passaggio di consegne (come i Traces di OPERA) ---------- */
H.add_shift_note = async (me, p) => {
  needMember(me);
  if (!isDate(p.day)) fail(400, 'Data non valida.');
  const text = String(p.text || '').trim().slice(0, 1000); if (!text) fail(400, 'Scrivi la consegna.');
  const dp = await deptRow(me, p.department_id); if (!dp) fail(400, 'Team non valido.');
  if (!(me.department_id === dp.id || schedulesDept(me, dp) || me.role === 'manager')) fail(403, 'Non fai parte di questo team.');
  await q(db.from('shift_notes').insert({ business_id: me.business_id, department_id: dp.id, day: p.day, shift_code: p.shift_code ? String(p.shift_code).slice(0, 2) : null, text, author: me.id }));
  return { ok: true };
};
H.done_shift_note = async (me, p) => {
  needMember(me);
  const n = (await q(db.from('shift_notes').select('*').eq('id', p.id).eq('business_id', me.business_id)) as any[])[0];
  if (!n) fail(404, 'Consegna non trovata.');
  const dp = await deptRow(me, n.department_id);
  if (!(me.department_id === n.department_id || schedulesDept(me, dp) || me.role === 'manager')) fail(403, 'Non fai parte di questo team.');
  if (p.delete) { if (n.author !== me.id && !(schedulesDept(me, dp) || me.role === 'manager')) fail(403, 'Può cancellarla solo chi l\'ha scritta.'); await q(db.from('shift_notes').delete().eq('id', n.id)); return { ok: true }; }
  const done = p.done !== false;
  await q(db.from('shift_notes').update({ done, done_by: done ? me.id : null, done_at: done ? new Date().toISOString() : null }).eq('id', n.id));
  return { ok: true };
};

/* ---------- Esportazione dei dati (backup) ---------- */
H.export_data = async (me) => {
  needManager(me);
  const b = me.business_id, all = async (t: string, sel = '*') => {
    const out: any[] = [];
    for (let i = 0; ; i += 1000) { const part = await q(db.from(t).select(sel).eq('business_id', b).range(i, i + 999)) as any[]; out.push(...part); if (part.length < 1000) break; }
    return out;
  };
  const [business] = await q(db.from('businesses').select('*').eq('id', b)) as any[];
  const data: any = { exported_at: new Date().toISOString(), format: 'turnario-backup-1', business };
  for (const t of ['departments', 'shift_types', 'shift_needs', 'events', 'occupancy', 'assignments', 'cell_locks', 'publications', 'leaves', 'leave_balances', 'requests', 'request_days', 'offers', 'preferences', 'member_rules', 'shift_notes', 'change_log', 'audit_log'])
    data[t] = await all(t);
  data.members = (await all('members')).map((m: any) => ({ ...m, user_id: m.user_id ? 'collegato' : null }));
  await accessLog(me, 'export_data', null);
  await log(b, `${me.name} ha esportato tutti i dati.`);
  return data;
};

/* ---------- Scambio diretto tra colleghi ---------- */
H.swap_options = async (me, p) => {
  needMember(me);
  if (!isDate(p.day)) fail(400, 'Data non valida.');
  const c = await loadMonth(me.business_id, monthOf(p.day));
  const opts = swapOptions(deptCtx(c, me.department_id), me.id, idxOf(p.day));
  return { options: opts.map((o) => ({ to: o.to, name: c.byId.get(o.to)?.name, day2: dateOf(c.month, o.d2), s2: o.s2 })) };
};
H.propose_swap = async (me, p) => {
  needMember(me);
  if (!isDate(p.day) || !isDate(p.day2) || monthOf(p.day) !== monthOf(p.day2)) fail(400, 'Le due date devono essere nello stesso mese.');
  if (p.day < new Date().toISOString().slice(0, 10)) fail(400, 'Non puoi scambiare giorni già passati.');
  const c = await loadMonth(me.business_id, monthOf(p.day));
  const B = c.byId.get(p.to_member);
  if (!B || !B.active || B.department_id !== me.department_id) fail(400, 'Collega non valido.');
  const d = idxOf(p.day), d2 = idxOf(p.day2), code = c.seqs[me.id][d], s2 = c.seqs[B.id][d2];
  const o = { from: me.id, to: B.id, d, shift: code, type: 'swap', d2, s2 };
  if (!offerValid(deptCtx(c, me.department_id), o)) fail(409, 'Questo scambio non rispetta le regole dei turni.');
  const open = await q(db.from('request_days').select('day').eq('member_id', me.id).eq('day', p.day).in('status', ['pending', 'claiming', 'awaiting_manager'])) as any[];
  if (open.length) fail(409, `Hai già una richiesta in corso per ${fmt(p.day)}.`);
  const req = await q(db.from('requests').insert({ business_id: me.business_id, member_id: me.id, date_from: p.day, date_to: p.day, kind: 'scambio', note: String(p.note || '').slice(0, 200) || null }).select().single()) as any;
  const day = await q(db.from('request_days').insert({ business_id: me.business_id, request_id: req.id, member_id: me.id, day: p.day, shift_code: code, status: 'pending' }).select().single()) as any;
  await sendOffers(c, req, day, [{ to: B.id, type: 'swap', d2, s2, score: 0 }]);
  await log(me.business_id, `${me.name} propone a ${B.name} uno scambio: ${fmt(p.day)} ↔ ${fmt(p.day2)}.`);
  return { ok: true, message: `Proposta inviata a ${first(B)}.` };
};
// il responsabile assegna direttamente una delle opzioni pronte (dopo una scadenza o un rifiuto)
H.force_offer = async (me, p) => {
  needMember(me);
  const o = (await q(db.from('offers').select('*').eq('id', p.offer_id).eq('business_id', me.business_id)) as any[])[0];
  if (!o) fail(404, 'Opzione non trovata.');
  const day = await dayForManager(me, o.request_day_id);
  if (!['failed', 'pending'].includes(day.status)) fail(409, 'Richiesta già gestita.');
  const c = await loadMonth(me.business_id, monthOf(o.day));
  if (!offerValid(deptCtx(c, c.byId.get(o.from_member)!.department_id), toLogicOffer(o))) fail(409, 'Questa opzione non è più valida con i turni attuali.');
  await applyOffer(c, o);
  await q(db.from('offers').update({ status: 'accepted' }).eq('id', o.id));
  await q(db.from('offers').update({ status: 'superseded' }).eq('request_day_id', o.request_day_id).eq('status', 'pending'));
  await q(db.from('request_days').update({ status: 'approved', covered_by: o.to_member }).eq('id', day.id));
  await notify(c.byId.get(o.from_member), `Il responsabile ha sistemato ${fmt(o.day)}: sei libero/a.`, `Turnario: ${fmt(o.day)} sistemato`);
  await notify(c.byId.get(o.to_member), `Il responsabile ti ha assegnato ${fmt(o.day)} (${shiftName(c, c.byId.get(o.from_member)!.department_id, o.shift_code)})${o.type === 'swap' ? ` e sei libero/a ${fmt(o.day2)}` : ''}.`, `Turnario: turno assegnato ${fmt(o.day)}`);
  return { ok: true, message: 'Assegnato, turni aggiornati.' };
};

/* ---------- Ferie, permessi e malattia ---------- */
async function approversOf(me: Member) {
  const dp = me.department_id ? (await q(db.from('departments').select('*').eq('id', me.department_id)) as any[])[0] : null;
  const ids = [dp?.scheduler_id, dp?.deputy_id].filter((x) => x && x !== me.id);
  const list = ids.length ? await q(db.from('members').select('*').in('id', ids).eq('active', true)) as Member[] : [];
  return list.length ? list : await q(db.from('members').select('*').eq('business_id', me.business_id).eq('role', 'manager').eq('active', true).neq('id', me.id)) as Member[];
}
const LK: Record<string, string> = { ferie: 'ferie', permesso: 'permesso', malattia: 'malattia' };
H.request_leave = async (me, p) => {
  needMember(me);
  const kind = p.kind === 'permesso' ? 'permesso' : 'ferie';
  if (!isDate(p.from) || !isDate(p.to) || p.to < p.from) fail(400, 'Date non valide.');
  if (p.from < new Date().toISOString().slice(0, 10)) fail(400, 'Non puoi chiedere giorni già passati.');
  if ((Date.parse(p.to) - Date.parse(p.from)) / 864e5 > 31) fail(400, 'Massimo 31 giorni per richiesta.');
  const clash = await q(db.from('leaves').select('id').eq('member_id', me.id).in('status', ['pending', 'approved']).lte('date_from', p.to).gte('date_to', p.from)) as any[];
  if (clash.length) fail(409, 'Hai già ferie o una richiesta in quei giorni.');
  const days = leaveCount(p.from, p.to);
  await q(db.from('leaves').insert({ business_id: me.business_id, member_id: me.id, kind, date_from: p.from, date_to: p.to, days, note: String(p.note || '').slice(0, 300) || null }));
  for (const a of await approversOf(me)) await notify(a, `${me.name} chiede ${LK[kind]} dal ${fmt(p.from)} al ${fmt(p.to)} (${days} gg).`, `Turnario: richiesta di ${LK[kind]} da ${first(me)}`);
  await log(me.business_id, `${me.name} ha chiesto ${LK[kind]} dal ${fmt(p.from)} al ${fmt(p.to)}.`);
  return { ok: true, message: `Richiesta inviata (${days} giorni).` };
};
H.cancel_leave = async (me, p) => {
  needMember(me);
  const l = (await q(db.from('leaves').select('*').eq('id', p.id).eq('member_id', me.id)) as any[])[0];
  if (!l || !['pending', 'approved'].includes(l.status)) fail(404, 'Richiesta non trovata.');
  if (l.status === 'approved' && l.date_from <= new Date().toISOString().slice(0, 10)) fail(400, 'Le ferie sono già iniziate: chiedi al responsabile.');
  await q(db.from('leaves').update({ status: 'cancelled' }).eq('id', l.id));
  if (l.status === 'approved') for (const a of await approversOf(me)) await notify(a, `${me.name} ha annullato ${LK[l.kind]} dal ${fmt(l.date_from)} al ${fmt(l.date_to)}: puoi rigenerare quei giorni.`);
  return { ok: true };
};
H.decide_leave = async (me, p) => {
  needMember(me);
  const l = (await q(db.from('leaves').select('*').eq('id', p.id).eq('business_id', me.business_id)) as any[])[0];
  if (!l || l.status !== 'pending') fail(409, 'Richiesta già gestita.');
  const m = await q(db.from('members').select('*').eq('id', l.member_id).single()) as Member;
  await needMemberEditor(me, m);
  if (m.id === me.id && me.role !== 'manager') fail(403, 'Le tue ferie le approva la direzione.');
  const ok = !!p.approve;
  await q(db.from('leaves').update({ status: ok ? 'approved' : 'rejected', decided_by: me.id, decided_at: new Date().toISOString() }).eq('id', l.id));
  let holes = 0;
  if (ok) {
    // i turni già messi in quei giorni diventano riposo: restano da coprire
    const asg = await q(db.from('assignments').select('day,code').eq('member_id', m.id).gte('day', l.date_from).lte('day', l.date_to)) as any[];
    const batch = crypto.randomUUID();
    for (const a of asg) { await setCode(me.business_id, m.id, a.day, 'R', null, { actor: me.id, source: 'ferie', batch }); holes++; }
  }
  await notify(m, ok ? `Approvate: ${LK[l.kind]} dal ${fmt(l.date_from)} al ${fmt(l.date_to)}.` : `Non approvate: ${LK[l.kind]} dal ${fmt(l.date_from)} al ${fmt(l.date_to)}.`, `Turnario: ${LK[l.kind]} ${ok ? 'approvate' : 'non approvate'}`);
  await log(me.business_id, `${me.name} ha ${ok ? 'approvato' : 'rifiutato'} ${LK[l.kind]} di ${m.name} (${fmt(l.date_from)} → ${fmt(l.date_to)}).`);
  return { ok: true, holes, from: l.date_from, message: ok ? (holes ? `Approvate. ${holes} turni ora scoperti: rigenera dal ${fmt(l.date_from)}.` : 'Approvate.') : 'Rifiutate.' };
};
H.set_balance = async (me, p) => {
  needMember(me);
  const m = await q(db.from('members').select('*').eq('id', p.member_id).eq('business_id', me.business_id).single()) as Member;
  await needMemberEditor(me, m);
  const year = Math.round(Number(p.year)), num = (v: any, d: number) => { const x = Number(v); return Number.isFinite(x) ? Math.min(99, Math.max(0, Math.round(x * 2) / 2)) : d; };
  if (!(year >= 2020 && year <= 2100)) fail(400, 'Anno non valido.');
  await q(db.from('leave_balances').upsert({ member_id: m.id, business_id: me.business_id, year, entitled: num(p.entitled, 26), carried: num(p.carried, 0) }));
  return { ok: true };
};
// Panoramica ferie: saldo per persona e richieste in coda ordinate per priorità (estate: chi ne ha avute meno l'anno prima)
H.leaves_overview = async (me, p) => {
  needMember(me);
  const year = Math.round(Number(p.year)) || new Date().getFullYear();
  const ds = await q(db.from('departments').select('*').eq('business_id', me.business_id)) as any[];
  const mine = ds.filter((d: any) => me.role === 'manager' || schedulesDept(me, d)).map((d: any) => d.id);
  const ms = (await q(db.from('members').select('id,name,department_id').eq('business_id', me.business_id).eq('active', true)) as any[])
    .filter((m: any) => m.id === me.id || mine.includes(m.department_id));
  const ids = ms.map((m: any) => m.id);
  const [bal, lv, lvPrev] = await Promise.all([
    q(db.from('leave_balances').select('*').in('member_id', ids).eq('year', year)),
    q(db.from('leaves').select('*').in('member_id', ids).lte('date_from', `${year}-12-31`).gte('date_to', `${year}-01-01`).order('created_at')),
    q(db.from('leaves').select('member_id,date_from,date_to,kind').in('member_id', ids).eq('status', 'approved').eq('kind', 'ferie').gte('date_from', `${year - 1}-06-01`).lte('date_from', `${year - 1}-09-30`)),
  ]) as any[];
  const summerPrev: Record<string, number> = {};
  lvPrev.forEach((l: any) => (summerPrev[l.member_id] = (summerPrev[l.member_id] || 0) + leaveCount(l.date_from, l.date_to)));
  const people = ms.map((m: any) => {
    const b = bal.find((x: any) => x.member_id === m.id) || { entitled: 26, carried: 0 };
    const mine2 = lv.filter((l: any) => l.member_id === m.id && l.kind === 'ferie');
    const used = mine2.filter((l: any) => l.status === 'approved').reduce((a: number, l: any) => a + Number(l.days), 0);
    const pend = mine2.filter((l: any) => l.status === 'pending').reduce((a: number, l: any) => a + Number(l.days), 0);
    return { id: m.id, name: m.name, department_id: m.department_id, entitled: Number(b.entitled), carried: Number(b.carried), used, pending: pend, left: Number(b.entitled) + Number(b.carried) - used, summerPrev: summerPrev[m.id] || 0 };
  });
  const isSummer = (l: any) => Number(l.date_from.slice(5, 7)) >= 6 && Number(l.date_from.slice(5, 7)) <= 9;
  const pending = lv.filter((l: any) => l.status === 'pending' && l.member_id !== me.id || (l.status === 'pending' && me.role === 'manager'))
    .map((l: any) => {
      const pm = people.find((x: any) => x.id === l.member_id)!;
      // quante persone dello stesso team sono già via (o lo chiedono) negli stessi giorni
      let overlap = 0;
      for (let d = l.date_from; d <= l.date_to; d = addDays(d, 1)) {
        const k = lv.filter((x: any) => x.id !== l.id && ['approved', 'pending'].includes(x.status) && x.date_from <= d && x.date_to >= d && people.find((y: any) => y.id === x.member_id)?.department_id === pm.department_id).length;
        overlap = Math.max(overlap, k);
      }
      return { ...l, name: pm.name, overlap, summer: isSummer(l), summerPrev: pm.summerPrev, left: pm.left };
    })
    .sort((a: any, b: any) => (a.summer && b.summer ? a.summerPrev - b.summerPrev : 0) || a.created_at.localeCompare(b.created_at));
  pending.forEach((l: any, i: number) => (l.priority = i + 1));
  return { year, people, pending, mine: lv.filter((l: any) => l.member_id === me.id), canDecide: mine.length > 0 };
};
// Malattia improvvisa: segna l'assenza e chiede subito ai colleghi che possono davvero coprire
H.report_absence = async (me, p) => {
  needMember(me);
  const target = p.member_id && p.member_id !== me.id ? await q(db.from('members').select('*').eq('id', p.member_id).eq('business_id', me.business_id).single()) as Member : me;
  if (target.id !== me.id) await needTeamEditor(me, target.department_id);
  const today = new Date().toISOString().slice(0, 10);
  const from = isDate(p.from) ? p.from : today, to = isDate(p.to) && p.to >= from ? p.to : from;
  if (from < addDays(today, -1)) fail(400, 'Si può segnalare da ieri in poi.');
  if ((Date.parse(to) - Date.parse(from)) / 864e5 > 13) fail(400, 'Massimo 14 giorni: poi usa le ferie o rigenera.');
  const clash = await q(db.from('leaves').select('id').eq('member_id', target.id).eq('status', 'approved').lte('date_from', to).gte('date_to', from)) as any[];
  if (clash.length) fail(409, 'In quei giorni risulta già un\'assenza.');
  await q(db.from('leaves').insert({ business_id: me.business_id, member_id: target.id, kind: 'malattia', date_from: from, date_to: to, days: 0, status: 'approved', decided_by: me.id, decided_at: new Date().toISOString(), note: String(p.note || '').slice(0, 300) || null }));
  let sent = 0, uncovered = 0;
  // per ogni mese toccato: una richiesta urgente con le proposte ai colleghi
  for (let m0 = monthOf(from); m0 <= monthOf(to); m0 = monthOf(addDays(dateOf(m0, daysIn(m0) - 1), 1))) {
    const c = await loadMonth(me.business_id, m0);
    const a = from > dateOf(m0, 0) ? from : dateOf(m0, 0), z = to < dateOf(m0, daysIn(m0) - 1) ? to : dateOf(m0, daysIn(m0) - 1);
    const ex = rangeIdx(a, z), work = ex.filter((d) => c.seqs[target.id][d] !== 'R' && dateOf(m0, d) >= today);
    if (!work.length) continue;
    const req = await q(db.from('requests').insert({ business_id: me.business_id, member_id: target.id, date_from: a, date_to: z, kind: 'malattia', note: 'Malattia' }).select().single()) as any;
    // la persona malata non va bloccata sui suoi stessi giorni da coprire
    const dc = { ...deptCtx(c, target.department_id), locked: (id: string, d: number) => (id === target.id && ex.includes(d) ? false : c.locked(id, d)) };
    for (const d of work) {
      const day = await q(db.from('request_days').insert({ business_id: me.business_id, request_id: req.id, member_id: target.id, day: dateOf(m0, d), shift_code: c.seqs[target.id][d], status: 'pending' }).select().single()) as any;
      const offs = findOffers(dc, target.id, d, ex).slice(0, Math.max(4, c.rules.sendTo * 2));
      if (offs.length) { await sendOffers(c, req, day, offs); sent += offs.length; }
      else { uncovered++; await q(db.from('request_days').update({ status: 'failed' }).eq('id', day.id)); }
    }
  }
  for (const a of await approversOf(target)) if (a.id !== me.id) await notify(a, `${target.name} è assente per malattia dal ${fmt(from)}${to !== from ? ` al ${fmt(to)}` : ''}.${uncovered ? ` ${uncovered} turni senza colleghi disponibili: servono interventi.` : ''}`, `Turnario: assenza di ${first(target)}`);
  await log(me.business_id, `Assenza per malattia: ${target.name} dal ${fmt(from)}${to !== from ? ` al ${fmt(to)}` : ''}.`);
  return { ok: true, sent, uncovered, message: sent ? `Assenza registrata: chiesto a ${sent} colleghi.` : uncovered ? 'Assenza registrata: nessun collega disponibile, avvisato il responsabile.' : 'Assenza registrata.' };
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
  let ms: string[];
  if (p.leaders) {
    // la direzione: note e regole su chi fa i turni dei team che non gestisce lei
    needManager(me);
    if (me._imp && !(await devReadsNotes())) fail(403, 'Accesso dello sviluppatore alle note disattivato.');
    const ds = await q(db.from('departments').select('*').eq('business_id', me.business_id)) as any[];
    const mine = new Set(ds.filter((d: any) => schedulesDept(me, d)).map((d: any) => d.id));
    const ids = new Set(ds.flatMap((d: any) => [d.scheduler_id, d.deputy_id]).filter((x: any) => x && x !== me.id));
    const act = await q(db.from('members').select('id,department_id').eq('business_id', me.business_id).eq('active', true)) as any[];
    ms = act.filter((m: any) => ids.has(m.id) && !mine.has(m.department_id)).map((m: any) => m.id);
  } else {
    const dp = await deptRow(me, p.department_id); if (!dp) fail(400, 'Team non valido.');
    await needNotesFor(me, dp);
    ms = (await q(db.from('members').select('id').eq('department_id', dp.id).eq('active', true)) as any[]).map((x) => x.id);
  }
  ms = ms.concat(['00000000-0000-0000-0000-000000000000']);
  const [notes, rules, prefs] = await Promise.all([
    q(db.from('manager_notes').select('*').in('member_id', ms).order('created_at', { ascending: false })),
    q(db.from('member_rules').select('*').in('member_id', ms).order('created_at')),
    q(db.from('preferences').select('*').in('member_id', ms).order('created_at', { ascending: false })),
  ]);
  await accessLog(me, p.leaders ? 'read_leader_notes' : 'read_team_notes', p.leaders ? null : p.department_id);
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
    if (['generate', 'apply_plan', 'preview_request', 'create_request', 'dev_create_hotel', 'add_member', 'reset_password'].includes(body.action)) await limit('heavy:' + user.id, 30, 600);
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
