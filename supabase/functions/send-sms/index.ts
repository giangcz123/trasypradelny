// Trasy prádelny – odeslání linky řidičům přes SMS (BulkGate).
// Nasazení: Supabase → Edge Functions → Deploy a new function → Via Editor → název „send-sms“ → vložit tento soubor → Deploy.
// Tajné údaje (Edge Functions → Secrets):
//   BULKGATE_APP_ID     – Application ID z BulkGate
//   BULKGATE_APP_TOKEN  – Application token z BulkGate
//   SMS_SENDER          – nepovinné: vlastní odesílatel (text do 11 znaků, musí být schválený v BulkGate)
//   APP_URL             – nepovinné: adresa aplikace, výchozí https://giangcz123.github.io/trasypradelny/
import { createClient } from 'npm:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// --- pomocné funkce (bez závislostí) ---
// 777 123 456 → 420777123456, +420 … / 00420 … → 420…
function phoneDigits(p) {
  let d = String(p || '').replace(/[^\d+]/g, '');
  if (d.startsWith('+')) d = d.slice(1); else if (d.startsWith('00')) d = d.slice(2); else if (d.length === 9) d = '420' + d;
  return /^\d{9,15}$/.test(d) ? d : null;
}
// SMS bez diakritiky = 160 znaků v jedné zprávě (s diakritikou jen 70)
function plain(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[–—]/g, '-'); }
function hm(m) { if (m == null || isNaN(m)) return ''; m = Math.round(m); return `${Math.floor(m / 60) % 24}:${String(m % 60).padStart(2, '0')}`; }
function dayShort(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  const wd = ['Ne', 'Po', 'Ut', 'St', 'Ct', 'Pa', 'So'][new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${wd} ${d}.${m}.`;
}
function smsText(run, appUrl) {
  const p = run.plan || {};
  const link = appUrl.replace(/\/?$/, '/') + 'ridic.html?r=' + run.token;
  const head = (veh) => plain(`D&D laundry: Linka ${run.linka}, ${veh}, ${dayShort(run.day)} vyjezd ${hm(p.start)} `);
  let veh = plain((p.vehicle || {}).name || '');
  while (veh.length > 3 && head(veh).length + link.length > 160) veh = veh.slice(0, -1);  // vejde se do 1 SMS
  return head(veh.trim()) + link;
}
// --- konec pomocných funkcí ---

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
  try {
    const appId = Deno.env.get('BULKGATE_APP_ID'), appToken = Deno.env.get('BULKGATE_APP_TOKEN');
    if (!appId || !appToken) return json({ error: 'Chybí přístupové údaje k SMS bráně (BULKGATE_APP_ID, BULKGATE_APP_TOKEN).' }, 500);
    const appUrl = Deno.env.get('APP_URL') || 'https://giangcz123.github.io/trasypradelny/';
    const sender = Deno.env.get('SMS_SENDER') || '';

    // klient s oprávněními přihlášeného uživatele (platí pravidla databáze)
    // klíč: z požadavku aplikace (hlavička apikey), jinak z proměnných projektu (nové i starší názvy)
    let key = req.headers.get('apikey') || Deno.env.get('SUPABASE_PUBLISHABLE_KEY') || Deno.env.get('SUPABASE_ANON_KEY') || '';
    if (!key) { try { const all = JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') || '{}'); key = all.default || Object.values(all)[0] || ''; } catch (_) {} }
    if (!key) return json({ error: 'Funkce nenašla klíč projektu Supabase.' }, 500);
    const sb = createClient(Deno.env.get('SUPABASE_URL'), key, { global: { headers: { Authorization: req.headers.get('Authorization') || '' } } });
    const { data: who, error: ue } = await sb.auth.getUser();
    if (ue || !who || !who.user) return json({ error: 'Nepřihlášený uživatel.' }, 401);
    const { data: isExp } = await sb.rpc('is_expedice');
    if (isExp) return json({ error: 'Účet expedice nemůže posílat SMS.' }, 403);

    const body = await req.json().catch(() => ({}));
    const ids = Array.isArray(body.run_ids) ? body.run_ids.slice(0, 20) : [];
    if (!ids.length) return json({ error: 'Není vybraná žádná linka.' }, 400);

    const results = [];
    for (const id of ids) {
      const { data: run, error } = await sb.from('runs').select('id, token, day, linka, plan').eq('id', id).maybeSingle();
      if (error || !run) { results.push({ id, ok: false, error: 'Linka nenalezena.' }); continue; }
      const drv = (run.plan || {}).driver;
      const number = drv && phoneDigits(drv.phone);
      let res;
      if (!number) res = { ok: false, error: 'Řidič nemá platné telefonní číslo.' };
      else {
        const text = smsText(run, appUrl);
        const payload = { application_id: appId, application_token: appToken, number, text, unicode: false, country: 'cz' };
        if (sender) { payload.sender_id = 'gText'; payload.sender_id_value = sender; }
        try {
          const r = await fetch('https://portal.bulkgate.com/api/1.0/simple/transactional', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' }, body: JSON.stringify(payload) });
          const out = await r.json().catch(() => ({}));
          if (!r.ok || out.error || out.type) res = { ok: false, error: `SMS brána: ${out.error || out.detail || out.type || r.status}` };
          else res = { ok: true, number, smsId: out.data && out.data.sms_id ? out.data.sms_id : null };
        } catch (e) { res = { ok: false, error: 'SMS brána neodpovídá.' }; }
      }
      const sms = { ...res, at: new Date().toISOString(), to: drv ? drv.name : '' };
      const patch = res.ok ? { sms, sent_at: sms.at } : { sms };
      await sb.from('runs').update(patch).eq('id', id);
      results.push({ id, ...sms });
    }
    return json({ results });
  } catch (e) {
    return json({ error: 'Chyba při odesílání: ' + (e && e.message ? e.message : String(e)) }, 500);
  }
});
