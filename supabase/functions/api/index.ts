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
type Member = { id: string; business_id: string; user_id: string | null; department_id: string | null; name: string; email: string; role: string; job: string | null; active: boolean };
async function notify(m: Member | undefined, text: string, subject?: string) {
  if (!m) return;
  await db.from('notifications').insert({ business_id: m.business_id, member_id: m.id, text });
  if (subject) await sendEmail(m.email, subject, text);
}
const first = (m?: Member) => (m ? m.name.split(' ')[0] : '—');

/* ---------- contesto del mese ---------- */
async function loadMonth(b: string, month: string) {
  const n = daysIn(month);
  const [biz, members, shifts, asg, locks] = await Promise.all([
    q(db.from('businesses').select('*').eq('id', b).single()),
    q(db.from('members').select('*').eq('business_id', b)),
    q(db.from('shift_types').select('*').eq('business_id', b).order('position')),
    q(db.from('assignments').select('member_id,day,code').eq('business_id', b).gte('day', dateOf(month, 0)).lte('day', dateOf(month, n - 1))),
    q(db.from('request_days').select('member_id,day').eq('business_id', b).in('status', ['approved', 'awaiting_manager']).gte('day', dateOf(month, 0)).lte('day', dateOf(month, n - 1))),
  ]);
  const seqs: Record<string, string[]> = {};
  (members as Member[]).forEach((m) => (seqs[m.id] = Array(n).fill('R')));
  (asg as any[]).forEach((a) => { if (seqs[a.member_id]) seqs[a.member_id][idxOf(a.day)] = a.code; });
  const lockSet = new Set((locks as any[]).map((l) => `${l.member_id}|${idxOf(l.day)}`));
  const byId = new Map((members as Member[]).map((m) => [m.id, m]));
  const ids = (members as Member[]).map((m) => m.id);
  const first0 = dateOf(month, 0), last0 = dateOf(month, n - 1);
  const [pre, post] = await Promise.all([ctxDays(b, addDays(first0, -CTX_DAYS), addDays(first0, -1), ids), ctxDays(b, addDays(last0, 1), addDays(last0, CTX_DAYS), ids)]);
  return { biz: biz as any, rules: (biz as any).rules, members: members as Member[], byId, shifts: shifts as any[], seqs, n, month, pre, post, locked: (id: string, d: number) => lockSet.has(`${id}|${d}`) };
}
type Ctx = Awaited<ReturnType<typeof loadMonth>>;
function deptCtx(c: Ctx, deptId: string | null) {
  return {
    seqs: c.seqs, n: c.n, rules: c.rules, locked: c.locked, pre: c.pre, post: c.post,
    shifts: c.shifts.filter((s) => s.department_id === deptId),
    colleagues: c.members.filter((m) => m.active && m.department_id === deptId && m.role === 'employee').map((m) => m.id),
  };
}
async function setCode(b: string, memberId: string, day: string, code: string) {
  if (code === 'R') await q(db.from('assignments').delete().eq('member_id', memberId).eq('day', day));
  else await q(db.from('assignments').upsert({ business_id: b, member_id: memberId, day, code }));
}
const managersOf = (c: Ctx) => c.members.filter((m) => m.active && m.role === 'manager');
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
    for (const m of managersOf(c)) await notify(m, `${A.name}: nessun collega disponibile per ${fmt(day.day)}.`, `Turnario: serve il tuo intervento per ${A.name}`);
  }
}
const rangeIdx = (from: string, to: string) => { const a: number[] = []; for (let d = idxOf(from); d <= idxOf(to); d++) a.push(d); return a; };

async function applyOffer(c: Ctx, o: any) {
  const b = o.business_id;
  await setCode(b, o.from_member, o.day, 'R');
  await setCode(b, o.to_member, o.day, o.shift_code);
  if (o.type === 'swap') { await setCode(b, o.from_member, o.day2, o.shift2_code); await setCode(b, o.to_member, o.day2, 'R'); }
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
  await q(db.from('members').insert({ business_id: biz.id, user_id: user.id, name, email, role: 'manager', job: 'Responsabile' }));
  await log(biz.id, `${name} ha creato ${bname}.`);
  return { ok: true };
};

function needManager(me: Me | null): asserts me is Me { if (!me || me.role !== 'manager') fail(403, 'Solo il responsabile può farlo.'); }
function needMember(me: Me | null): asserts me is Me { if (!me) fail(401, 'Accesso richiesto.'); }

H.add_member = async (me, p) => {
  needManager(me);
  const email = cleanEmail(p.email), name = String(p.name || '').trim();
  if (!name || !validEmail(email)) fail(400, 'Inserisci nome ed email validi.');
  const role = p.role === 'manager' ? 'manager' : 'employee';
  let dept: string | null = p.department_id || null;
  if (role === 'employee') {
    const d = await q(db.from('departments').select('id').eq('id', dept).eq('business_id', me.business_id)) as any[];
    if (!d.length) fail(400, 'Scegli un reparto.');
  } else dept = null;
  const pw = tempPassword();
  const user = await createAuthUser(email, pw, name);
  const m = await q(db.from('members').insert({ business_id: me.business_id, user_id: user.id, department_id: dept, name, email, role, job: String(p.job || '').trim() || null }).select().single()) as Member;
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
  needManager(me);
  if (!isMonth(p.month)) fail(400, 'Mese non valido.');
  const b = me.business_id, month = p.month, n = daysIn(month);
  const [biz, depts, shifts, members] = await Promise.all([
    q(db.from('businesses').select('*').eq('id', b).single()),
    q(db.from('departments').select('*').eq('business_id', b)),
    q(db.from('shift_types').select('*').eq('business_id', b)),
    q(db.from('members').select('*').eq('business_id', b).eq('active', true).eq('role', 'employee')),
  ]) as any[];
  const rows: any[] = []; let unc = 0;
  const [y, mo] = month.split('-').map(Number);
  // coda del mese precedente: notti, giorni di fila e riposi continuano oltre il cambio mese
  const pre = await ctxDays(b, addDays(dateOf(month, 0), -CTX_DAYS), addDays(dateOf(month, 0), -1), members.map((m: any) => m.id));
  for (const dp of depts) {
    const ids = members.filter((m: any) => m.department_id === dp.id).map((m: any) => m.id);
    const sh = shifts.filter((s: any) => s.department_id === dp.id);
    if (!ids.length || !sh.length) continue;
    const best = bestSchedule({ shifts: sh, memberIds: ids, n, rules: biz.rules, seedBase: y * 12 + mo, pre }, 60);
    unc += best.uncovered;
    for (const id of ids) best.seq[id].forEach((c: string, d: number) => { if (c !== 'R') rows.push({ business_id: b, member_id: id, day: dateOf(month, d), code: c }); });
  }
  await q(db.from('requests').delete().eq('business_id', b).gte('date_from', dateOf(month, 0)).lte('date_from', dateOf(month, n - 1)));
  await q(db.from('assignments').delete().eq('business_id', b).gte('day', dateOf(month, 0)).lte('day', dateOf(month, n - 1)));
  for (let i = 0; i < rows.length; i += 500) await q(db.from('assignments').insert(rows.slice(i, i + 500)));
  await q(db.from('months').upsert({ business_id: b, month: dateOf(month, 0), generated_at: new Date().toISOString() }));
  const label = `${MESI[mo - 1]} ${y}`;
  await log(b, `Turni di ${label} generati automaticamente${unc ? ` (${unc} turni scoperti: servono più persone)` : ''}.`);
  if (p.notify) for (const m of members) await notify(m, `Sono pubblicati i turni di ${label}.`, `Turnario: turni di ${label} pubblicati`);
  return { ok: true, uncovered: unc };
};

H.set_cell = async (me, p) => {
  needManager(me);
  if (!isDate(p.day)) fail(400, 'Data non valida.');
  const m = await q(db.from('members').select('*').eq('id', p.member_id).eq('business_id', me.business_id).single()) as Member;
  if (p.code !== 'R') {
    const ok = await q(db.from('shift_types').select('id').eq('department_id', m.department_id).eq('code', p.code)) as any[];
    if (!ok.length) fail(400, 'Turno non valido per questo reparto.');
  }
  await setCode(me.business_id, m.id, p.day, p.code);
  await log(me.business_id, `Modifica manuale: ${m.name} ${fmt(p.day)} → ${p.code === 'R' ? 'Riposo' : p.code}.`);
  return { ok: true };
};

H.save_settings = async (me, p) => {
  needManager(me);
  const r = p.rules || {};
  const int = (v: any, lo: number, hi: number, d: number) => { const x = Math.round(Number(v)); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d; };
  const maxConsec = int(r.maxConsec, 1, 14, 5);
  const rules = { maxConsec, maxConsecEx: int(r.maxConsecEx ?? maxConsec + 1, maxConsec, 14, maxConsec + 1), minRest: int(r.minRest, 0, 24, 11), restPerWeek: int(r.restPerWeek, 0, 4, 2), restAfterNight: int(r.restAfterNight ?? 2, 0, 4, 2), sendTo: int(r.sendTo, 1, 10, 3), managerApproval: !!r.managerApproval };
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
  needManager(me);
  const d = await q(db.from('departments').select('id').eq('id', p.department_id).eq('business_id', me.business_id)) as any[];
  if (!d.length) fail(400, 'Reparto non valido.');
  const code = String(p.code || '').trim().toUpperCase();
  if (!/^[A-Z]{1,2}$/.test(code) || code === 'R') fail(400, 'Sigla: 1-2 lettere, diversa da R.');
  if (!/^\d\d:\d\d$/.test(p.start_time) || !/^\d\d:\d\d$/.test(p.end_time)) fail(400, 'Orari non validi.');
  const colors = ['#D97706', '#2563EB', '#4C1D95', '#0F9F6E', '#BE123C', '#0E7490', '#A21CAF'];
  const { error } = await db.from('shift_types').insert({ business_id: me.business_id, department_id: p.department_id, code, name: String(p.name || code).trim(), start_time: p.start_time, end_time: p.end_time, need: Math.max(0, Number(p.need) || 1), color: colors[Math.floor(Math.random() * colors.length)], position: 99 });
  if (error) fail(400, /duplicate/.test(error.message) ? 'Sigla già usata in questo reparto.' : error.message);
  return { ok: true };
};
H.delete_shift = async (me, p) => {
  needManager(me);
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
      for (const m of managersOf(c)) await notify(m, `${me.name}: nessun collega compatibile per ${fmt(day.day)}.`, `Turnario: serve il tuo intervento per ${me.name}`);
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
      for (const m of managersOf(c)) await notify(m, `Da approvare: ${me.name} copre ${A?.name} ${fmt(o.day)}.`, 'Turnario: un cambio turno da approvare');
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

async function dayForManager(me: Me, id: string) {
  return await q(db.from('request_days').select('*').eq('id', id).eq('business_id', me.business_id).single()) as any;
}
H.approve_day = async (me, p) => {
  needManager(me);
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
  needManager(me);
  const day = await dayForManager(me, p.request_day_id);
  await q(db.from('request_days').update({ status: 'rejected' }).eq('id', day.id));
  await q(db.from('offers').update({ status: 'withdrawn' }).eq('request_day_id', day.id).eq('status', 'pending'));
  const c = await loadMonth(me.business_id, monthOf(day.day));
  await notify(c.byId.get(day.member_id), `Il responsabile non ha approvato il libero per ${fmt(day.day)}.`, `Turnario: richiesta per ${fmt(day.day)} non approvata`);
  if (day.covered_by) await notify(c.byId.get(day.covered_by), `Il responsabile non ha approvato il cambio per ${fmt(day.day)}.`);
  return { ok: true };
};
H.retry_day = async (me, p) => {
  needManager(me);
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
  needManager(me);
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

/* ---------- server ---------- */
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
  try {
    if (req.method !== 'POST') fail(405, 'Usa POST.');
    const body = await req.json().catch(() => ({}));
    const fn = H[body.action];
    if (!fn) fail(400, 'Azione sconosciuta.');
    let me: Me | null = null;
    if (body.action !== 'signup_business') {
      const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
      const { data, error } = await db.auth.getUser(token);
      if (error || !data.user) fail(401, 'Sessione scaduta: accedi di nuovo.');
      const rows = await q(db.from('members').select('*').eq('user_id', data.user!.id).eq('active', true)) as Member[];
      if (!rows.length) fail(403, 'Il tuo account non è collegato a nessuna attività.');
      me = rows[0];
    }
    return json(await fn(me, body));
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: 'Errore imprevisto. Riprova.' }, 500);
  }
});
