// Turns a spoken sentence ("Ποδόσφαιρο ο Πάνος την Τρίτη 6 με 7 και μισή") into the fields of a new
// activity, with Google Gemini. The site then opens the usual «Νέα δραστηριότητα» window filled in,
// and nothing is saved until the person presses Αποθήκευση.
//
// Deploy: Supabase → Edge Functions → Deploy a new function → Via Editor, name "sched-ai", paste this
// file, deploy, and turn off "Verify JWT" (the function checks the sign-in itself, below).
// Secrets (Edge Functions → Secrets): GEMINI_API_KEY, from https://aistudio.google.com/apikey.
// Optional: GEMINI_MODEL (default gemini-flash-lite-latest).

// deno-lint-ignore no-explicit-any
const Deno = (globalThis as any).Deno; // undefined when the tests import this file in Node

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const DAYS = ['Δευτέρα', 'Τρίτη', 'Τετάρτη', 'Πέμπτη', 'Παρασκευή', 'Σάββατο', 'Κυριακή'];

export type Ask = { text: string; today: string; members: string[]; categories: string[]; titles?: string[] };
export type Parsed = {
  category: string; title: string; members: string[]; date: string; allDay: boolean;
  start: string; end: string; endDate: string; repeatDays: number[]; repeatEvery: number;
  repeatUntil: string; location: string; notes: string;
};

const iso = (d: Date) => d.toISOString().slice(0, 10);
const weekday = (d: Date) => d.getUTCDay() || 7;

/** The instructions for Gemini, with a calendar of the next weeks so "την Τρίτη" needs no arithmetic. */
export function prompt(a: Ask): string {
  const start = new Date(`${a.today}T00:00:00Z`);
  const days: string[] = [];
  for (let i = 0; i < 35; i++) {
    const d = new Date(start.getTime() + i * 86400000);
    days.push(`${DAYS[weekday(d) - 1]} ${iso(d)}${i === 0 ? ' (σήμερα)' : i === 1 ? ' (αύριο)' : ''}`);
  }
  return [
    'Είσαι βοηθός σε οικογενειακό ημερολόγιο. Ο χρήστης υπαγόρευσε μια νέα δραστηριότητα στα ελληνικά.',
    'Βγάλε τα πεδία της. Η υπαγόρευση μπορεί να έχει λάθη αναγνώρισης φωνής: διάλεξε το πιο λογικό.',
    '',
    `Μέλη οικογένειας (γράψε τα ονόματα ακριβώς έτσι): ${a.members.join(', ')}.`,
    'Αν λέει «όλοι» ή «οικογένεια», βάλε όλα τα μέλη. Αν δεν αναφέρει κανέναν, άφησε τη λίστα κενή.',
    'Η αναγνώριση φωνής συχνά γράφει λάθος τα ονόματα, ειδικά τα σπάνια: π.χ. «πάνω» αντί για «Πάνος»,',
    '«κατσάκι», «καντσάκι» ή «γατάκι» αντί για «Καντζάκι». Αν μια λέξη μοιάζει στον ήχο με όνομα μέλους',
    '(ίδια αρχή, ίδια σύμφωνα, ίδιος τόνος) και στη θέση της στην πρόταση λογικά είναι πρόσωπο, πάρ\' την για εκείνο το μέλος.',
    'Μην βάζεις ονόματα μελών ή τέτοιες λέξεις στο title.',
    `Κατηγορίες (γράψε ακριβώς μία από αυτές ή κενό): ${a.categories.join(', ')}.`,
    'Διάλεξε κατηγορία μόνο αν ταιριάζει καθαρά (π.χ. «προπόνηση» → Ποδόσφαιρο, «παιδίατρος» → Γιατρός).',
    'Αν η κατηγορία είναι «Άλλο» ή καμία, γράψε στο title έναν σύντομο τίτλο (π.χ. «Γενέθλια Μαρίας»).',
    'Αλλιώς title κενό.',
    a.titles?.length ? `Τίτλοι που έχουν χρησιμοποιηθεί ξανά (προτίμησε αυτούς αν ταιριάζουν): ${a.titles.join(', ')}.` : '',
    '',
    'Ημερολόγιο για τις ημερομηνίες:',
    days.join('\n'),
    'Αν δεν λέει ημέρα, βάλε σήμερα. «Την Τρίτη» σημαίνει την επόμενη Τρίτη από σήμερα (ή σήμερα αν σήμερα είναι Τρίτη).',
    '',
    'Ώρες σε μορφή HH:MM (24ωρο). «6 το απόγευμα» ή σκέτο «6» για δραστηριότητα παιδιών/απογεύματος = 18:00.',
    '«6 με 7 και μισή» = start 18:00, end 19:30. Αν δεν λέει ώρα λήξης, end κενό.',
    'Αν δεν λέει καμία ώρα, allDay true και start/end κενά. endDate μόνο για ολοήμερο πολλών ημερών (π.χ. «από Δευτέρα ως Τετάρτη»).',
    '',
    'Επανάληψη μόνο αν το λέει («κάθε Τρίτη και Πέμπτη», «κάθε δεύτερη εβδομάδα»):',
    'repeatDays με αριθμούς 1=Δευτέρα ... 7=Κυριακή, repeatEvery 1 ή 2, repeatUntil ημερομηνία ή κενό.',
    'Τότε date = η πρώτη από αυτές τις ημέρες από σήμερα και μετά. Χωρίς επανάληψη: repeatDays κενή, repeatEvery 1.',
    'location: τόπος αν τον λέει. notes: ό,τι άλλο χρήσιμο δεν χωράει αλλού, αλλιώς κενό.',
  ].filter((l) => l !== null).join('\n');
}

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    category: { type: 'STRING' },
    title: { type: 'STRING' },
    members: { type: 'ARRAY', items: { type: 'STRING' } },
    date: { type: 'STRING' },
    allDay: { type: 'BOOLEAN' },
    start: { type: 'STRING' },
    end: { type: 'STRING' },
    endDate: { type: 'STRING' },
    repeatDays: { type: 'ARRAY', items: { type: 'INTEGER' } },
    repeatEvery: { type: 'INTEGER' },
    repeatUntil: { type: 'STRING' },
    location: { type: 'STRING' },
    notes: { type: 'STRING' },
  },
  required: ['category', 'title', 'members', 'date', 'allDay', 'start', 'end', 'endDate', 'repeatDays', 'repeatEvery', 'repeatUntil', 'location', 'notes'],
};

/** Keeps only values the site can use: known names, real dates and times. */
export function clean(r: Partial<Parsed>, a: Ask): Parsed {
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const date = (v: unknown) => (/^\d{4}-\d{2}-\d{2}$/.test(str(v)) && !isNaN(Date.parse(str(v))) ? str(v) : '');
  const time = (v: unknown) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(str(v));
    return m && Number(m[1]) < 24 && Number(m[2]) < 60 ? `${m[1].padStart(2, '0')}:${m[2]}` : '';
  };
  const out: Parsed = {
    category: a.categories.includes(str(r.category)) ? str(r.category) : '',
    title: str(r.title).slice(0, 80),
    members: [...new Set((Array.isArray(r.members) ? r.members : []).map(str).filter((m) => a.members.includes(m)))],
    date: date(r.date) || a.today,
    allDay: false,
    start: time(r.start),
    end: time(r.end),
    endDate: date(r.endDate),
    repeatDays: [...new Set((Array.isArray(r.repeatDays) ? r.repeatDays : []).map(Number).filter((d) => d >= 1 && d <= 7))].sort(),
    repeatEvery: Number(r.repeatEvery) === 2 ? 2 : 1,
    repeatUntil: date(r.repeatUntil),
    location: str(r.location).slice(0, 120),
    notes: str(r.notes).slice(0, 300),
  };
  if (!out.start) out.end = '';
  if (out.end && out.end <= out.start) out.end = '';
  out.allDay = !out.start;
  if (!out.allDay || out.repeatDays.length || out.endDate <= out.date) out.endDate = '';
  if (!out.repeatDays.length) { out.repeatEvery = 1; out.repeatUntil = ''; }
  if (out.repeatUntil && out.repeatUntil < out.date) out.repeatUntil = '';
  return out;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

/** Only signed-in members of a household (allowed_emails) may use the Gemini key. */
async function allowed(req: Request): Promise<boolean> {
  const auth = req.headers.get('authorization') || '';
  const apikey = req.headers.get('apikey') || Deno.env.get('SUPABASE_ANON_KEY') || '';
  if (!auth.startsWith('Bearer ')) return false;
  const res = await fetch(`${Deno.env.get('SUPABASE_URL')}/rest/v1/rpc/sched_household`, {
    method: 'POST',
    headers: { apikey, Authorization: auth, 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) { await res.body?.cancel(); return false; }
  return !!(await res.json());
}

async function handle(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  if (!(await allowed(req))) return json({ error: 'Η σύνδεση έληξε. Συνδέσου ξανά.' }, 401);

  const a = await req.json().catch(() => null) as Ask | null;
  if (!a || typeof a.text !== 'string' || !a.text.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(a.today || '')) {
    return json({ error: 'Δεν ακούστηκε τίποτα.' }, 400);
  }
  a.text = a.text.slice(0, 500);
  a.members = (a.members || []).map(String).slice(0, 20);
  a.categories = (a.categories || []).map(String).slice(0, 40);
  a.titles = (a.titles || []).map(String).slice(0, 40);

  const key = Deno.env.get('GEMINI_API_KEY');
  if (!key) return json({ error: 'Λείπει το κλειδί του Gemini (GEMINI_API_KEY) στο Supabase.' }, 500);
  const model = Deno.env.get('GEMINI_MODEL') || 'gemini-flash-lite-latest';

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: prompt(a) }] },
      contents: [{ role: 'user', parts: [{ text: a.text }] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: SCHEMA },
    }),
  });
  if (!res.ok) {
    const detail = await res.text();
    console.error('gemini', res.status, detail.slice(0, 500));
    if (res.status === 429) return json({ error: 'Το Gemini έφτασε το δωρεάν όριο. Δοκίμασε σε λίγο.' }, 429);
    return json({ error: `Το Gemini δεν απάντησε (${res.status}).` }, 502);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text || '').join('') || '';
  let parsed: Partial<Parsed>;
  try { parsed = JSON.parse(text); } catch { return json({ error: 'Δεν κατάλαβα. Δοκίμασε ξανά.' }, 502); }
  return json(clean(parsed, a));
}

if (Deno) Deno.serve(handle);
