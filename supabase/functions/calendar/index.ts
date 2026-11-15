// Turnario · feed calendario (.ics) per iPhone, Android (Google Calendar), Outlook.
// URL: /functions/v1/calendar?t=<token personale>
import { createClient } from 'npm:@supabase/supabase-js@2';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

const VTIMEZONE = [
  'BEGIN:VTIMEZONE', 'TZID:Europe/Rome',
  'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'TZNAME:CEST', 'DTSTART:19700329T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT',
  'BEGIN:STANDARD', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'TZNAME:CET', 'DTSTART:19701025T030000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD',
  'END:VTIMEZONE',
];
const esc = (s: string) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
const addDays = (date: string, k: number) => { const t = new Date(date + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + k); return t.toISOString().slice(0, 10); };
const local = (date: string, time: string) => `${date.replace(/-/g, '')}T${time.replace(':', '')}00`;
const toMin = (t: string) => { const [a, b] = t.split(':').map(Number); return a * 60 + b; };
// righe ICS max 75 caratteri
const fold = (line: string) => { const out: string[] = []; let s = line; while (s.length > 74) { out.push(s.slice(0, 74)); s = ' ' + s.slice(74); } out.push(s); return out.join('\r\n'); };

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const token = url.searchParams.get('t') || '';
  if (!/^[a-f0-9]{64}$/.test(token)) return new Response('Link non valido', { status: 404 });
  const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'ip?';
  for (const [k, max] of [['cal:ip:' + ip, 300], ['cal:t:' + token.slice(0, 16), 60]] as [string, number][]) {
    const { data } = await db.rpc('rl_hit', { p_key: k, p_max: max, p_window_s: 3600 });
    if (data === false) return new Response('Troppe richieste', { status: 429, headers: { 'Retry-After': '3600' } });
  }
  const { data: tok } = await db.from('calendar_tokens').select('member_id').eq('token', token).maybeSingle();
  if (!tok) return new Response('Link non valido', { status: 404 });
  const { data: m } = await db.from('members').select('*').eq('id', tok.member_id).eq('active', true).maybeSingle();
  if (!m) return new Response('Account non attivo', { status: 404 });

  const today = new Date().toISOString().slice(0, 10);
  const [{ data: biz }, { data: shifts }, { data: asg }] = await Promise.all([
    db.from('businesses').select('name').eq('id', m.business_id).single(),
    db.from('shift_types').select('*').eq('department_id', m.department_id),
    db.from('assignments').select('day,code').eq('member_id', m.id).gte('day', addDays(today, -45)).lte('day', addDays(today, 120)),
  ]);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Turnario//Turni//IT', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(`Turni · ${biz?.name || 'Turnario'}`)}`, 'X-WR-TIMEZONE:Europe/Rome',
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H',
    ...VTIMEZONE,
  ];
  for (const a of asg || []) {
    const s = (shifts || []).find((x: any) => x.code === a.code);
    if (!s) continue;
    const endDay = toMin(s.end_time) <= toMin(s.start_time) ? addDays(a.day, 1) : a.day; // notte: finisce il giorno dopo
    lines.push(
      'BEGIN:VEVENT',
      `UID:${m.id}-${a.day}@turnario`,
      `DTSTAMP:${stamp}`,
      `DTSTART;TZID=Europe/Rome:${local(a.day, s.start_time)}`,
      `DTEND;TZID=Europe/Rome:${local(endDay, s.end_time)}`,
      `SUMMARY:${esc(`${s.name} (${s.code})`)}`,
      `DESCRIPTION:${esc(`Turno ${s.start_time}–${s.end_time} · ${biz?.name || ''}`)}`,
      'TRANSP:OPAQUE',
      'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc(`Tra un'ora: ${s.name}`)}`, 'TRIGGER:-PT1H', 'END:VALARM',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return new Response(lines.map(fold).join('\r\n') + '\r\n', {
    headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'no-cache, max-age=0', 'Content-Disposition': 'inline; filename="turni.ics"' },
  });
});
