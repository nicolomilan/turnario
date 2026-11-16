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

// ---------- Regole personali (preferenze del dipendente e note del responsabile) ----------
// Regola: { kind, shift_code, shift_codes, weekday, value, weight(1-3), source('pref'|'note') }
// Vincoli rigidi: only_shifts, max_per_month, unavailable_weekday. Gli altri pesano sul punteggio.
export function ruleViolations(seq, mrules = [], dow = () => -1) {
  if (!mrules.length) return 0;
  let v = 0; const cnt = {};
  const only = mrules.find((r) => r.kind === 'only_shifts');
  const maxes = mrules.filter((r) => r.kind === 'max_per_month');
  seq.forEach((c, d) => {
    if (c === 'R') return;
    cnt[c] = (cnt[c] || 0) + 1;
    if (mrules.some((r) => r.kind === 'unavailable_weekday' && r.weekday === dow(d))) v++;
    if (only && !(only.shift_codes || []).includes(c) && !maxes.some((r) => r.shift_code === c)) v++;
  });
  maxes.forEach((r) => { if ((cnt[r.shift_code] || 0) > r.value) v += cnt[r.shift_code] - r.value; });
  const mw = mrules.find((r) => r.kind === 'max_weekends_per_month');
  if (mw && dow(0) >= 0) { const worked = weekendsOf(seq.length, dow).filter(([x, y]) => seq[x] !== 'R' || seq[y] !== 'R').length; if (worked > mw.value) v += worked - mw.value; }
  return v;
}
// costo "morbido": quanto il turno va contro preferenze e note (più basso = meglio)
export function softCost(code, d, mrules = [], dow = () => -1) {
  let s = 0;
  for (const r of mrules) {
    const k = r.source === 'note' ? 1 : 0.45; // le note del responsabile pesano più delle preferenze
    if (r.kind === 'avoid_shift' && r.shift_code === code) s += 5 * r.weight * k;
    if (r.kind === 'prefer_shift' && r.shift_code === code) s -= 4 * r.weight * k;
    if (r.kind === 'avoid_weekday' && r.weekday === dow(d)) s += 4 * r.weight * k;
  }
  return s;
}
const seqSoft = (seq, mrules, dow) => seq.reduce((a, c, d) => a + (c === 'R' ? 0 : softCost(c, d, mrules, dow)), 0);

// Posti da coprire in un giorno: per turno e mansione (es. Mattina·cameriere 3 il sabato).
export function slotsFor(shifts, needs, weekday) {
  const out = [];
  for (const sh of shifts) {
    const rows = needs.filter((x) => x.shift_code === sh.code);
    if (!rows.length) { if (sh.need > 0) out.push({ code: sh.code, skill: null, need: sh.need }); continue; }
    const bySkill = {};
    rows.forEach((r) => { const k = r.skill || ''; if (r.weekday === null || r.weekday === undefined) { if (!(k in bySkill)) bySkill[k] = r.need; } });
    rows.forEach((r) => { if (r.weekday === weekday) bySkill[r.skill || ''] = r.need; });
    Object.entries(bySkill).forEach(([k, need]) => { if (need > 0) out.push({ code: sh.code, skill: k || null, need }); });
  }
  return out;
}

// Eventi (fiere, settimane della moda…): aggiustano il fabbisogno di un giorno, es. Mattina·cameriere +1
export function applyAdjust(slots, adj = []) {
  const out = slots.map((x) => ({ ...x }));
  for (const a of adj) {
    const sl = out.find((x) => x.code === a.shift_code && (x.skill || null) === (a.skill || null))
      || (!a.skill ? out.find((x) => x.code === a.shift_code) : null);
    if (sl) sl.need = Math.max(0, sl.need + a.delta);
    else if (a.delta > 0) out.push({ code: a.shift_code, skill: a.skill || null, need: a.delta });
  }
  return out.filter((x) => x.need > 0);
}

// Genera i turni di un reparto per un mese. Ritorna { seq, skillSeq, score, uncovered, exceptions }
// ---------- Comodità dei turni ----------
// weekend del mese: coppie [sabato, domenica] tutte dentro il mese
export function weekendsOf(n, dow) {
  const out = [];
  for (let d = 0; d < n - 1; d++) if (dow(d) === 6 && dow(d + 1) === 0) out.push([d, d + 1]);
  return out;
}
// quanti giorni lavorati "isolati" (un giorno solo tra due riposi), riposo più lungo, weekend liberi
export function comfortStats(seq, dow, pre = []) {
  const all = [...pre, ...seq], off = pre.length;
  let isolated = 0, maxRest = 0, run = 0;
  for (let i = 0; i < all.length; i++) {
    if (all[i] === 'R') { run++; if (i >= off) maxRest = Math.max(maxRest, run); }
    else { run = 0; if (i >= off && (i === 0 || all[i - 1] === 'R') && (i === all.length - 1 || all[i + 1] === 'R')) isolated++; }
  }
  // un riposo che inizia nel mese prima conta per intero
  const wk = weekendsOf(seq.length, dow);
  const freeWeekends = wk.filter(([a, b]) => seq[a] === 'R' && seq[b] === 'R').length;
  const weekendsWorked = wk.filter(([a, b]) => seq[a] !== 'R' || seq[b] !== 'R').length;
  return { isolated, maxRest, freeWeekends, weekendsWorked };
}
// violazioni delle regole di comodità (usate anche per non accettare scambi che le rompono)
export function comfortViolations(seq, rules, dow, pre = []) {
  if (!dow || dow(0) < 0) return 0;
  const st = comfortStats(seq, dow, pre); let v = 0;
  if ((rules.restBlock || 0) > 1 && st.maxRest < rules.restBlock) v++;
  if ((rules.freeWeekends || 0) > 0 && weekendsOf(seq.length, dow).length >= rules.freeWeekends && st.freeWeekends < rules.freeWeekends) v++;
  return v;
}

// Genera i turni di un reparto per un mese. Ritorna { seq, skillSeq, score, uncovered, exceptions, isolated }
// fixed: { id: { giorno: {code, skill} } } celle che non si toccano (bloccate, già passate, altre persone)
// history: { id: {nights, weekends, holidays} } lavorati negli ultimi 12 mesi → equità nel tempo
// holidays: giorni festivi del mese; current: turni attuali (per "meno cambi"); weights: {fair, comfort, stable}
export function generateDept({ shifts, memberIds, n, rules, seed, pre = {}, skills = {}, needs = [], memberRules = {}, dow = () => -1, dayAdjust = () => [], fixed = {}, history = {}, holidays = [], current = null, weights = {} }) {
  const wf = weights.fair ?? 1, wc = weights.comfort ?? 1, ws = weights.stable ?? 0;
  const hol = new Set(holidays);
  const isWE = (md) => dow(md) === 0 || dow(md) === 6;
  const fx = (e, md) => (fixed[e] ? fixed[e][md] : undefined);
  const R = rng(seed), T = targetDays(n, rules), emps = memberIds;
  const seq = {}, sk = {}, w = {}, consec = {}, cnt = {}, wkw = {};
  const P = CTX_DAYS; // i primi P giorni sono la coda del mese precedente
  emps.forEach((e) => {
    const tail = (pre[e] || []).slice(-P);
    seq[e] = [...Array(P - tail.length).fill('R'), ...tail, ...Array(n).fill('R')];
    sk[e] = Array(n).fill(null);
    w[e] = 0; cnt[e] = {}; consec[e] = 0; wkw[e] = new Set();
    for (let j = P - 1; j >= 0 && seq[e][j] !== 'R'; j--) consec[e]++;
    shifts.forEach((s) => (cnt[e][s.code] = 0));
  });
  const has = (e, skill) => !skill || (skills[e] || []).includes(skill);
  const rarity = (skill) => emps.filter((e) => has(e, skill)).length;
  const start = Object.fromEntries(shifts.map((s) => [s.code, toMin(s.start_time)]));
  const nights = nightCodes(shifts), kN = restAfterNight(rules);
  const eventDay = (md) => dayAdjust(md).some((a) => a.delta > 0);
  const known = dow(0) >= 0;
  const hv = (e, k) => ((history[e] || {})[k] || 0);
  const havg = (k) => emps.reduce((a, e) => a + hv(e, k), 0) / (emps.length || 1);
  const HA = { nights: havg('nights'), weekends: havg('weekends'), holidays: havg('holidays') };
  // --- riposi protetti: a ognuno un weekend libero, allungato a un blocco di 3 giorni (ven-dom o sab-lun)
  const wk = known ? weekendsOf(n, dow) : [];
  const weekIdx = {}; wk.forEach(([a, b], i) => { weekIdx[a] = i; weekIdx[b] = i; });
  const prot = {}; emps.forEach((e) => (prot[e] = new Set()));
  if (wk.length && ((rules.freeWeekends || 0) > 0 || (rules.restBlock || 0) > 1)) {
    // preferisco i weekend senza eventi impegnativi; le persone con la stessa mansione finiscono su weekend diversi
    const order = wk.map((x, i) => i).sort((i, j) => (eventDay(wk[i][0]) || eventDay(wk[i][1]) ? 1 : 0) - (eventDay(wk[j][0]) || eventDay(wk[j][1]) ? 1 : 0) || R() - 0.5);
    const byskill = [...emps].sort((a, b) => String((skills[a] || [])[0] || '').localeCompare(String((skills[b] || [])[0] || '')) || R() - 0.5);
    const off = Math.floor(R() * order.length);
    byskill.forEach((e, i) => {
      const [sa, su] = wk[order[(i + off) % order.length]];
      [sa, su].forEach((d) => { if (!fx(e, d) || fx(e, d).code === 'R') prot[e].add(d); });
      if ((rules.restBlock || 0) >= 3) { const ext = (i % 2 === 0 && sa > 0) || su >= n - 1 ? sa - 1 : su + 1; if (ext >= 0 && ext < n && (!fx(e, ext) || fx(e, ext).code === 'R')) prot[e].add(ext); }
    });
  }
  // vincoli rigidi personali
  const hardOk = (e, code, md, useProt = false) => {
    if (prot[e].has(md) && !eventDay(md) && !useProt) return false;
    const mr = memberRules[e]; if (!mr || !mr.length) return true;
    if (mr.some((r) => r.kind === 'unavailable_weekday' && r.weekday === dow(md))) return false;
    const mx = mr.find((r) => r.kind === 'max_per_month' && r.shift_code === code);
    if (mx && cnt[e][code] >= mx.value) return false;
    const only = mr.find((r) => r.kind === 'only_shifts');
    if (only && !(only.shift_codes || []).includes(code) && !mx) return false;
    const mw = mr.find((r) => r.kind === 'max_weekends_per_month');
    if (mw && md in weekIdx && !wkw[e].has(weekIdx[md]) && wkw[e].size >= mw.value) return false;
    return true;
  };
  let unc = 0;
  for (let d = P; d < P + n; d++) {
    const md = d - P, used = new Set();
    const slots = applyAdjust(slotsFor(shifts, needs, dow(md)), dayAdjust(md)).map((x) => ({ ...x })).sort((a, b) => rarity(a.skill) - rarity(b.skill) || start[b.code] - start[a.code]);
    // celle fisse: occupano il loro posto e tolgono la persona dai candidati
    for (const e of emps) {
      const f = fx(e, md); if (!f) continue;
      used.add(e); if (f.code === 'R') continue;
      seq[e][d] = f.code; sk[e][md] = f.skill || null; w[e]++; cnt[e][f.code] = (cnt[e][f.code] || 0) + 1; if (md in weekIdx) wkw[e].add(weekIdx[md]);
      const sl = slots.find((x) => x.need > 0 && x.code === f.code && (x.skill || null) === (f.skill || null)) || slots.find((x) => x.need > 0 && x.code === f.code && (!x.skill || !f.skill));
      if (sl) sl.need--;
    }
    for (const sl of slots) {
      const avg = emps.reduce((a, x) => a + cnt[x][sl.code], 0) / (emps.length || 1);
      for (let k = 0; k < sl.need; k++) {
        let best = null, bs = Infinity;
        // 1) limite normale  2) un giorno extra sul monte  3) eccezione: 6° giorno di fila solo se serve a coprire
        // 4) ultima risorsa: si usa un riposo protetto piuttosto che lasciare il turno scoperto
        for (const [cap, extra, useProt] of [[rules.maxConsec, 0, false], [rules.maxConsec, 1, false], [exCap(rules), 1, false], [exCap(rules), 1, true]]) {
          for (const e of emps) {
            if (used.has(e) || !has(e, sl.skill) || consec[e] >= cap || w[e] >= T + extra) continue;
            const prev = seq[e][d - 1], prev2 = seq[e][d - 2];
            if (prev !== 'R' && !gapOk(shifts, prev, sl.code, rules)) continue;
            if (kN > 0 && !nightRestOk(seq[e], d, sl.code, nights, kN)) continue;
            if (!hardOk(e, sl.code, md, useProt)) continue;
            let s = (w[e] - (T * (md + 1)) / n) * 4 + (cnt[e][sl.code] - avg) * 1.5 + consec[e] * 0.4 + R() * 1.5;
            if (prev === sl.code) s -= nights.has(sl.code) ? 9 : 4; // serie di notti più lunghe = meno riposi sprecati
            if (prev === 'R') s += prev2 !== 'R' ? 3 : -1;
            // comodità: chi ha appena iniziato una serie la continua (niente giorni isolati)
            if (rules.noSingleDays !== false && consec[e] === 1) s -= 6 * wc;
            // comodità: non richiamare chi domani è in riposo protetto per un giorno solo
            if (rules.noSingleDays !== false && prev === 'R' && prot[e].has(md + 1)) s += 8;
            if (sl.skill !== 'manager' && has(e, 'manager')) s += 3; // il manager resta libero per i posti da manager
            s += softCost(sl.code, md, memberRules[e], dow);
            // equità nel tempo: chi ha fatto più notti/weekend/festivi negli ultimi mesi ne riceve meno
            if (nights.has(sl.code)) s += (hv(e, 'nights') - HA.nights) * 0.5 * wf;
            if (isWE(md)) s += (hv(e, 'weekends') - HA.weekends) * 0.6 * wf;
            if (hol.has(md)) s += (hv(e, 'holidays') - HA.holidays) * 2 * wf + 1;
            // meno cambi: preferisco lasciare il turno a chi lo ha già
            if (ws && current && current[e]) s -= current[e][md] === sl.code ? 6 * ws : 0;
            if (useProt && prot[e].has(md)) s += 50;
            if (s < bs) { bs = s; best = e; }
          }
          if (best) break;
        }
        if (best) { seq[best][d] = sl.code; sk[best][md] = sl.skill; used.add(best); w[best]++; cnt[best][sl.code]++; if (md in weekIdx) wkw[best].add(weekIdx[md]); } else unc++;
      }
    }
    emps.forEach((e) => (consec[e] = seq[e][d] === 'R' ? 0 : consec[e] + 1));
  }
  // --- riparazione: un giorno lavorato isolato passa a un collega che così allunga la sua serie
  if (rules.noSingleDays !== false) {
    const runLen = (e, d) => { let a = d, b = d; while (a - 1 >= 0 && seq[e][a - 1] !== 'R') a--; while (b + 1 < P + n && seq[e][b + 1] !== 'R') b++; return b - a + 1; };
    for (let pass = 0; pass < 2; pass++) for (let d = P; d < P + n; d++) for (const e of emps) {
      const c = seq[e][d], md = d - P;
      if (c === 'R' || seq[e][d - 1] !== 'R' || (d + 1 < P + n && seq[e][d + 1] !== 'R') || eventDay(md) || fx(e, md)) continue;
      for (const f of emps) {
        if (f === e || seq[f][d] !== 'R' || !has(f, sk[e][md]) || prot[f].has(md) || fx(f, md)) continue;
        if (!(seq[f][d - 1] !== 'R' || (d + 1 < P + n && seq[f][d + 1] !== 'R'))) continue; // deve allungare una serie
        if (w[f] >= T + 1) continue;
        const save = [...seq[f]]; seq[f][d] = c;
        const ok = violations(seq[f], shifts, rules) <= violations(save, shifts, rules) && runLen(f, d) <= rules.maxConsec && hardOk(f, c, md)
          && ruleViolations(seq[f].slice(P), memberRules[f] || [], dow) === 0;
        if (!ok) { seq[f] = save; continue; }
        seq[e][d] = 'R'; sk[f][md] = sk[e][md]; sk[e][md] = null; w[e]--; w[f]++; cnt[e][c]--; cnt[f][c]++;
        break;
      }
    }
  }
  let exc = 0, soft = 0, iso = 0, comfort = 0;
  emps.forEach((e) => {
    exc += softFlags(seq[e], rules).slice(P).filter(Boolean).length;
    const tail = seq[e].slice(0, P);
    seq[e] = seq[e].slice(P);
    soft += seqSoft(seq[e], memberRules[e] || [], dow);
    if (known) { iso += comfortStats(seq[e], dow, tail).isolated; comfort += comfortViolations(seq[e], rules, dow, tail); }
  });
  let changes = 0;
  if (current) emps.forEach((e) => { if (current[e]) seq[e].forEach((c, d) => { if ((current[e][d] || 'R') !== c) changes++; }); });
  // equità: weekend e festivi lavorati, sommati allo storico; poi turni dello stesso tipo
  const variance = (a) => { const m = a.reduce((x, y) => x + y, 0) / (a.length || 1); return a.reduce((x, y) => x + (y - m) ** 2, 0); };
  const tot = (e, k, f) => hv(e, k) + seq[e].filter((c, d) => c !== 'R' && f(d)).length;
  let fair = variance(emps.map((e) => tot(e, 'weekends', isWE))) * 3 + variance(emps.map((e) => tot(e, 'holidays', (d) => hol.has(d)))) * 6;
  shifts.forEach((sh) => { fair += variance(emps.map((e) => cnt[e][sh.code] + (nights.has(sh.code) ? hv(e, 'nights') : 0))); });
  let base = 0;
  emps.forEach((e) => {
    base += (w[e] - T) ** 2 * 5;
    for (let d = 1; d < n - 1; d++) if (seq[e][d] === 'R' && seq[e][d - 1] !== 'R' && seq[e][d + 1] !== 'R') base += 2;
  });
  const parts = { unc, exc, soft, iso, comfort, changes, fair, base };
  return { seq, skillSeq: sk, score: scoreOf(parts, weights), parts, uncovered: unc, exceptions: exc, isolated: iso, comfortMisses: comfort, changes };
}
export function scoreOf(p, weights = {}) {
  const wf = weights.fair ?? 1, wc = weights.comfort ?? 1, ws = weights.stable ?? 0;
  return p.unc * 1000 + p.exc * 40 + p.soft + (p.iso * 25 + p.comfort * 60) * wc + p.changes * 3 * ws + p.fair * wf + p.base;
}

export function bestSchedule(opts, tries = 60) {
  let best = null;
  for (let s = 1; s <= tries; s++) {
    const r = generateDept({ ...opts, seed: s * 7919 + (opts.seedBase || 0) });
    if (!best || r.score < best.score) best = r;
  }
  return best;
}

// Tre versioni del piano con pesi diversi: la direzione sceglie quella che preferisce
export function planVariants(opts, tries = 40) {
  const hasCur = !!opts.current && Object.values(opts.current).some((s) => s.some((c) => c !== 'R'));
  const V = [
    { key: 'bal', label: 'Equilibrato', hint: 'Il miglior compromesso tra equità e comodità', weights: { fair: 1, comfort: 1, stable: hasCur ? 0.3 : 0 } },
    { key: 'comfort', label: 'Più comodo', hint: 'Serie lunghe e riposi di fila, anche a costo di un po\' di equità', weights: { fair: 0.5, comfort: 2.5, stable: 0 } },
    hasCur ? { key: 'stable', label: 'Meno cambi', hint: 'Cambia il meno possibile rispetto ai turni attuali', weights: { fair: 0.7, comfort: 0.8, stable: 4 } }
      : { key: 'fair', label: 'Più equo', hint: 'Notti, weekend e festivi divisi nel modo più uniforme', weights: { fair: 3, comfort: 0.7, stable: 0 } },
  ];
  // un'unica raccolta di piani (generati con i tre pesi), poi ogni versione sceglie il migliore secondo i suoi pesi
  const pool = [];
  V.forEach((v, i) => { for (let s = 1; s <= tries; s++) pool.push(generateDept({ ...opts, weights: v.weights, seed: s * 7919 + (opts.seedBase || 0) + i * 101 })); });
  const taken = new Set();
  const out = [];
  // prima le versioni "specializzate", poi l'equilibrata: così ognuna ha davvero il suo piano migliore
  [2, 1, 0].forEach((k) => {
    const v = V[k], order = pool.map((r, i) => [scoreOf(r.parts, v.weights), i]).sort((a, b) => a[0] - b[0]);
    const pick = (order.find(([, i]) => !taken.has(i)) || order[0])[1]; taken.add(pick);
    out[k] = { ...v, result: pool[pick] };
  });
  return out;
}
// numeri per confrontare le versioni
export function planMetrics(r, ids, shifts, dow, holidays = [], history = {}) {
  const nights = nightCodes(shifts), hol = new Set(holidays), hv = (e, k) => ((history[e] || {})[k] || 0);
  // differenza tra chi ne fa di più e chi di meno, contando anche gli ultimi 12 mesi
  const cnt = (f, k) => ids.map((e) => hv(e, k) + r.seq[e].filter((c, d) => c !== 'R' && f(c, d)).length);
  const spread = (a) => (a.length ? Math.max(...a) - Math.min(...a) : 0);
  return {
    uncovered: r.uncovered, isolated: r.isolated, comfortMisses: r.comfortMisses, exceptions: r.exceptions, changes: r.changes || 0,
    nightsSpread: spread(cnt((c) => nights.has(c), 'nights')), weekendSpread: spread(cnt((c, d) => dow(d) === 0 || dow(d) === 6, 'weekends')), holidaySpread: spread(cnt((c, d) => hol.has(d), 'holidays')),
  };
}

// Festività nazionali italiane (con Pasqua e Pasquetta)
export function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  return [Math.floor((h + l - 7 * m + 114) / 31), ((h + l - 7 * m + 114) % 31) + 1]; // [mese 1-12, giorno]
}
export function italianHolidays(y) {
  const out = { '01-01': 'Capodanno', '01-06': 'Epifania', '04-25': 'Liberazione', '05-01': 'Festa dei lavoratori', '06-02': 'Festa della Repubblica', '08-15': 'Ferragosto', '11-01': 'Ognissanti', '12-08': 'Immacolata', '12-25': 'Natale', '12-26': 'Santo Stefano' };
  const [em, ed] = easter(y); const p = (x) => String(x).padStart(2, '0');
  out[`${p(em)}-${p(ed)}`] = 'Pasqua';
  const t = new Date(Date.UTC(y, em - 1, ed + 1)); out[`${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`] = 'Pasquetta';
  return out;
}
// indici (0-based) dei festivi in un mese 'YYYY-MM'
export function holidaysOfMonth(month) {
  const [y, m] = month.split('-').map(Number), H = italianHolidays(y), pre = String(m).padStart(2, '0') + '-';
  return Object.keys(H).filter((k) => k.startsWith(pre)).map((k) => Number(k.slice(3)) - 1).sort((a, b) => a - b);
}

// Trova i colleghi che possono coprire il giorno d del richiedente a.
// ctx: { seqs, skillSeqs, skills, memberRules, dow, colleagues, shifts, rules, n, locked(id,d), pre, post }
export function findOffers(ctx, a, d, exDays = [], exEmps = []) {
  const { seqs, colleagues, shifts, n, locked } = ctx, rules = ctx.rules, rules0 = ctx.rules, HR = hardRules(rules);
  const dow = ctx.dow || (() => -1), MR = (id) => (ctx.memberRules || {})[id] || [];
  const V = (id, sq) => violationsCtx(sq, shifts, HR, ctx.pre?.[id], ctx.post?.[id]) + ruleViolations(sq, MR(id), dow) + comfortViolations(sq, rules0, dow, ctx.pre?.[id]);
  const X = (id, sq) => softFlags(joinCtx(sq, ctx.pre?.[id], ctx.post?.[id]), rules).filter(Boolean).length; // giorni eccezionali
  const S = (id, sq) => seqSoft(sq, MR(id), dow);
  const has = (id, skill) => !skill || ((ctx.skills || {})[id] || []).includes(skill);
  const skillOf = (id, day) => ctx.skillSeqs?.[id]?.[day] ?? null;
  const sa = seqs[a], sh = sa[d];
  if (!sh || sh === 'R') return [];
  const T = targetDays(n, rules), vA = V(a, sa), res = [];
  for (const b of colleagues) {
    if (b === a || exEmps.includes(b)) continue;
    const sb = seqs[b];
    if (!sb || sb[d] !== 'R' || locked(b, d) || !has(b, skillOf(a, d))) continue;
    const vB = V(b, sb);
    let best = null;
    for (let d2 = 0; d2 < n; d2++) {
      if (d2 === d || exDays.includes(d2) || sa[d2] !== 'R' || sb[d2] === 'R' || locked(a, d2) || !has(a, skillOf(b, d2))) continue;
      const s2 = sb[d2];
      const na = [...sa]; na[d] = 'R'; na[d2] = s2;
      const nb = [...sb]; nb[d] = sh; nb[d2] = 'R';
      if (V(a, na) > vA || V(b, nb) > vB) continue;
      const sc = 1 + Math.abs(d2 - d) * 0.3 + (X(a, na) > X(a, sa) || X(b, nb) > X(b, sb) ? 3 : 0)
        + Math.max(0, (S(a, na) - S(a, sa) + S(b, nb) - S(b, sb)) * 0.2);
      if (!best || sc < best.score) best = { type: 'swap', d2, s2, score: sc };
    }
    const wB = sb.filter((x) => x !== 'R').length;
    if (wB < T) {
      const na = [...sa]; na[d] = 'R';
      const nb = [...sb]; nb[d] = sh;
      if (V(a, na) <= vA && V(b, nb) <= vB) {
        const sc = 2.5 - (T - wB) * 0.5 + (X(b, nb) > X(b, sb) ? 3 : 0) + Math.max(0, (S(b, nb) - S(b, sb)) * 0.2);
        if (!best || sc < best.score) best = { type: 'cover', score: sc };
      }
    }
    if (best) res.push({ to: b, ...best });
  }
  return res.sort((x, y) => x.score - y.score);
}

// Verifica che uno scambio sia ancora applicabile sui turni attuali.
export function offerValid(ctx, o) {
  const { seqs, shifts, locked } = ctx, rules0 = ctx.rules, HR = hardRules(ctx.rules);
  const dow = ctx.dow || (() => -1), MR = (id) => (ctx.memberRules || {})[id] || [];
  const V = (id, sq) => violationsCtx(sq, shifts, HR, ctx.pre?.[id], ctx.post?.[id]) + ruleViolations(sq, MR(id), dow) + comfortViolations(sq, rules0, dow, ctx.pre?.[id]);
  const has = (id, skill) => !skill || ((ctx.skills || {})[id] || []).includes(skill);
  const sa = seqs[o.from], sb = seqs[o.to];
  if (!sa || !sb) return false;
  if (sa[o.d] !== o.shift || sb[o.d] !== 'R' || locked(o.to, o.d)) return false;
  if (!has(o.to, ctx.skillSeqs?.[o.from]?.[o.d] ?? null)) return false;
  const na = [...sa], nb = [...sb];
  na[o.d] = 'R'; nb[o.d] = o.shift;
  if (o.type === 'swap') {
    if (sa[o.d2] !== 'R' || sb[o.d2] !== o.s2 || locked(o.from, o.d2)) return false;
    if (!has(o.from, ctx.skillSeqs?.[o.to]?.[o.d2] ?? null)) return false;
    na[o.d2] = o.s2; nb[o.d2] = 'R';
  }
  return V(o.from, na) <= V(o.from, sa) && V(o.to, nb) <= V(o.to, sb);
}
