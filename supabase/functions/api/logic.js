// Logica pura dei turni: nessun accesso al database, testabile da sola.
// seq = array di codici turno per giorno del mese ('R' = riposo).

export const toMin = (t) => { const [a, b] = t.split(':').map(Number); return a * 60 + b; };

export function rng(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const targetDays = (n, rules) => n - Math.round((n * rules.restPerWeek) / 7);

export function gapOk(shifts, a, b, rules) {
  const s1 = shifts.find((s) => s.code === a), s2 = shifts.find((s) => s.code === b);
  if (!s1 || !s2) return true;
  let end = toMin(s1.end_time);
  if (end <= toMin(s1.start_time)) end += 1440;
  return 1440 + toMin(s2.start_time) - end >= rules.minRest * 60;
}

// Turno notturno = turno che finisce il giorno dopo (es. 23:00–07:00).
export const isNight = (s) => !!s && toMin(s.end_time) <= toMin(s.start_time);
export const nightCodes = (shifts) => new Set(shifts.filter(isNight).map((s) => s.code));
export const restAfterNight = (rules) => (rules.restAfterNight ?? 2);
// Giorni di fila: `maxConsec` è il limite normale (5); `maxConsecEx` (6) è ammesso solo
// in casi eccezionali: scambi, ferie, corsi o quando altrimenti un turno resterebbe scoperto.
export const exCap = (rules) => Math.max(rules.maxConsec, rules.maxConsecEx ?? rules.maxConsec + 1);
export const hardRules = (rules) => ({ ...rules, maxConsec: exCap(rules) });
// Giorni oltre il limite normale ma entro quello eccezionale (da segnalare, non vietati).
export function softFlags(seq, rules) {
  const f = Array(seq.length).fill(false); let run = 0;
  for (let d = 0; d < seq.length; d++) { run = seq[d] === 'R' ? 0 : run + 1; if (run > rules.maxConsec && run <= exCap(rules)) f[d] = true; }
  return f;
}

// Dopo l'ultima notte di una serie servono `restAfterNight` giorni di riposo.
// Ritorna false se il turno `code` al giorno d viola la regola guardando i giorni precedenti.
export function nightRestOk(seq, d, code, nights, k) {
  for (let j = 1; j <= k && d - j >= 0; j++) {
    if (nights.has(seq[d - j])) return j === 1 && nights.has(code); // solo continuare la serie
    if (seq[d - j] !== 'R') return true;
  }
  return true;
}

export function violFlags(seq, shifts, rules) {
  const f = Array(seq.length).fill(false);
  const nights = nightCodes(shifts), k = restAfterNight(rules);
  let run = 0;
  for (let d = 0; d < seq.length; d++) {
    if (seq[d] === 'R') { run = 0; continue; }
    run++;
    if (run > rules.maxConsec) f[d] = true;
    if (d > 0 && seq[d - 1] !== 'R' && !gapOk(shifts, seq[d - 1], seq[d], rules)) f[d] = true;
    if (k > 0 && !nightRestOk(seq, d, seq[d], nights, k)) f[d] = true;
  }
  return f;
}
export const violations = (seq, shifts, rules) => violFlags(seq, shifts, rules).filter(Boolean).length;

// Collegamento tra mesi: `pre` = ultimi giorni del mese prima, `post` = primi giorni del mese dopo.
export const CTX_DAYS = 7;
export const joinCtx = (seq, pre = [], post = []) => [...pre, ...seq, ...post];
// Violazioni del mese considerando i giorni a cavallo.
export const violationsCtx = (seq, shifts, rules, pre = [], post = []) => violations(joinCtx(seq, pre, post), shifts, rules);
export function violFlagsCtx(seq, shifts, rules, pre = [], post = []) {
  return violFlags(joinCtx(seq, pre, post), shifts, rules).slice(pre.length, pre.length + seq.length);
}

// Genera i turni di un reparto per un mese. Ritorna { seq: {memberId: [...]}, score }
export function generateDept({ shifts, memberIds, n, rules, seed, pre = {} }) {
  const R = rng(seed), T = targetDays(n, rules), emps = memberIds;
  const seq = {}, w = {}, consec = {}, cnt = {};
  const P = CTX_DAYS; // i primi P giorni sono la coda del mese precedente
  emps.forEach((e) => {
    const tail = (pre[e] || []).slice(-P);
    seq[e] = [...Array(P - tail.length).fill('R'), ...tail, ...Array(n).fill('R')];
    w[e] = 0; cnt[e] = {}; consec[e] = 0;
    for (let j = P - 1; j >= 0 && seq[e][j] !== 'R'; j--) consec[e]++;
    shifts.forEach((s) => (cnt[e][s.code] = 0));
  });
  const order = [...shifts].sort((a, b) => toMin(b.start_time) - toMin(a.start_time));
  const nights = nightCodes(shifts), kN = restAfterNight(rules);
  let unc = 0;
  for (let d = P; d < P + n; d++) {
    const used = new Set();
    for (const sh of order) {
      const avg = emps.reduce((a, x) => a + cnt[x][sh.code], 0) / (emps.length || 1);
      for (let k = 0; k < sh.need; k++) {
        let best = null, bs = Infinity;
        // 1) limite normale  2) un giorno extra sul monte  3) eccezione: 6° giorno di fila solo se serve a coprire
        for (const [cap, extra] of [[rules.maxConsec, 0], [rules.maxConsec, 1], [exCap(rules), 1]]) {
          for (const e of emps) {
            if (used.has(e) || consec[e] >= cap || w[e] >= T + extra) continue;
            const prev = seq[e][d - 1], prev2 = seq[e][d - 2];
            if (prev !== 'R' && !gapOk(shifts, prev, sh.code, rules)) continue;
            if (kN > 0 && !nightRestOk(seq[e], d, sh.code, nights, kN)) continue;
            let s = (w[e] - (T * (d - P + 1)) / n) * 4 + (cnt[e][sh.code] - avg) * 1.5 + consec[e] * 0.4 + R() * 1.5;
            if (prev === sh.code) s -= nights.has(sh.code) ? 9 : 4; // serie di notti più lunghe = meno riposi sprecati
            if (prev === 'R') s += prev2 !== 'R' ? 3 : -1;
            if (s < bs) { bs = s; best = e; }
          }
          if (best) break;
        }
        if (best) { seq[best][d] = sh.code; used.add(best); w[best]++; cnt[best][sh.code]++; } else unc++;
      }
    }
    emps.forEach((e) => (consec[e] = seq[e][d] === 'R' ? 0 : consec[e] + 1));
  }
  let exc = 0;
  emps.forEach((e) => { exc += softFlags(seq[e], rules).slice(P).filter(Boolean).length; seq[e] = seq[e].slice(P); });
  let score = unc * 1000 + exc * 40;
  emps.forEach((e) => {
    score += (w[e] - T) ** 2 * 5;
    for (let d = 1; d < n - 1; d++) if (seq[e][d] === 'R' && seq[e][d - 1] !== 'R' && seq[e][d + 1] !== 'R') score += 2;
  });
  shifts.forEach((sh) => {
    const a = emps.map((e) => cnt[e][sh.code]);
    const m = a.reduce((x, y) => x + y, 0) / (a.length || 1);
    score += a.reduce((x, y) => x + (y - m) ** 2, 0);
  });
  return { seq, score, uncovered: unc, exceptions: exc };
}

export function bestSchedule(opts, tries = 60) {
  let best = null;
  for (let s = 1; s <= tries; s++) {
    const r = generateDept({ ...opts, seed: s * 7919 + (opts.seedBase || 0) });
    if (!best || r.score < best.score) best = r;
  }
  return best;
}

// Trova i colleghi che possono coprire il giorno d del richiedente a.
// ctx: { seqs: {id: []}, colleagues: [ids stesso reparto], shifts, rules, n, locked(id,d) }
export function findOffers(ctx, a, d, exDays = [], exEmps = []) {
  const { seqs, colleagues, shifts, n, locked } = ctx, rules = ctx.rules, HR = hardRules(rules);
  const V = (id, sq) => violationsCtx(sq, shifts, HR, ctx.pre?.[id], ctx.post?.[id]);
  const X = (id, sq) => softFlags(joinCtx(sq, ctx.pre?.[id], ctx.post?.[id]), rules).filter(Boolean).length; // giorni eccezionali
  const sa = seqs[a], sh = sa[d];
  if (!sh || sh === 'R') return [];
  const T = targetDays(n, rules), vA = V(a, sa), res = [];
  for (const b of colleagues) {
    if (b === a || exEmps.includes(b)) continue;
    const sb = seqs[b];
    if (!sb || sb[d] !== 'R' || locked(b, d)) continue;
    const vB = V(b, sb);
    let best = null;
    for (let d2 = 0; d2 < n; d2++) {
      if (d2 === d || exDays.includes(d2) || sa[d2] !== 'R' || sb[d2] === 'R' || locked(a, d2)) continue;
      const s2 = sb[d2];
      const na = [...sa]; na[d] = 'R'; na[d2] = s2;
      const nb = [...sb]; nb[d] = sh; nb[d2] = 'R';
      if (V(a, na) > vA || V(b, nb) > vB) continue;
      const sc = 1 + Math.abs(d2 - d) * 0.3 + (X(a, na) > X(a, sa) || X(b, nb) > X(b, sb) ? 3 : 0);
      if (!best || sc < best.score) best = { type: 'swap', d2, s2, score: sc };
    }
    const wB = sb.filter((x) => x !== 'R').length;
    if (wB < T) {
      const na = [...sa]; na[d] = 'R';
      const nb = [...sb]; nb[d] = sh;
      if (V(a, na) <= vA && V(b, nb) <= vB) {
        const sc = 2.5 - (T - wB) * 0.5 + (X(b, nb) > X(b, sb) ? 3 : 0);
        if (!best || sc < best.score) best = { type: 'cover', score: sc };
      }
    }
    if (best) res.push({ to: b, ...best });
  }
  return res.sort((x, y) => x.score - y.score);
}

// Verifica che uno scambio sia ancora applicabile sui turni attuali.
export function offerValid(ctx, o) {
  const { seqs, shifts, locked } = ctx, HR = hardRules(ctx.rules);
  const V = (id, sq) => violationsCtx(sq, shifts, HR, ctx.pre?.[id], ctx.post?.[id]);
  const sa = seqs[o.from], sb = seqs[o.to];
  if (!sa || !sb) return false;
  if (sa[o.d] !== o.shift || sb[o.d] !== 'R' || locked(o.to, o.d)) return false;
  const na = [...sa], nb = [...sb];
  na[o.d] = 'R'; nb[o.d] = o.shift;
  if (o.type === 'swap') {
    if (sa[o.d2] !== 'R' || sb[o.d2] !== o.s2 || locked(o.from, o.d2)) return false;
    na[o.d2] = o.s2; nb[o.d2] = 'R';
  }
  return V(o.from, na) <= V(o.from, sa) && V(o.to, nb) <= V(o.to, sb);
}
