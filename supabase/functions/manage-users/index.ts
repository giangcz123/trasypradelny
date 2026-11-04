// @ts-nocheck
// Trasy prádelny – správa uživatelů z aplikace (jen pro vedoucí).
// Nasazení: Supabase → Edge Functions → Deploy a new function → Via Editor → název „manage-users“ → vložit tento soubor → Deploy.
// Nepotřebuje žádné tajné údaje navíc: tajný klíč projektu má Supabase ve funkcích k dispozici sám.
// Přihlašovací jméno „petr“ = účet petr@trasy.local (stejně jako v aplikaci).

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const LOGIN_DOMAIN = 'trasy.local';
const ROLES = ['vedouci', 'expedice'];

// --- pomocné funkce (bez závislostí) ---
function loginEmail(v) {
  v = String(v || '').trim().toLowerCase();
  if (v.includes('@')) return v;
  return v.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, '.') + '@' + LOGIN_DOMAIN;
}
function shortUser(e) { e = String(e || ''); return e.endsWith('@' + LOGIN_DOMAIN) ? e.slice(0, -LOGIN_DOMAIN.length - 1) : e; }
function validLogin(v) {
  const e = loginEmail(v);
  return e.endsWith('@' + LOGIN_DOMAIN) ? /^[a-z0-9._-]{2,40}$/.test(shortUser(e)) : /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
}
// --- konec pomocných funkcí ---

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
  try {
    const base = (Deno.env.get('SUPABASE_URL') || '').replace(/\/$/, '');
    // veřejný klíč (z požadavku aplikace) – pro ověření volajícího
    let pub = req.headers.get('apikey') || Deno.env.get('SUPABASE_PUBLISHABLE_KEY') || Deno.env.get('SUPABASE_ANON_KEY') || '';
    if (!pub) { try { const all = JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') || '{}'); pub = all.default || Object.values(all)[0] || ''; } catch (_) {} }
    // tajný klíč – jen uvnitř funkce, nikdy neodchází do aplikace
    let secret = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
    if (!secret) { try { const all = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}'); secret = all.default || Object.values(all)[0] || ''; } catch (_) {} }
    if (!base || !pub || !secret) return json({ error: 'Funkce nenašla klíče projektu Supabase.' }, 500);

    const call = async (path, opt = {}, admin = false) => {
      const h = admin
        ? (secret.startsWith('sb_secret_') ? { apikey: secret } : { apikey: secret, Authorization: 'Bearer ' + secret })
        : { apikey: pub, Authorization: req.headers.get('Authorization') || '' };
      const r = await fetch(base + path, { ...opt, headers: { ...h, 'Content-Type': 'application/json', ...(opt.headers || {}) } });
      const t = await r.text(); let d = null; try { d = t ? JSON.parse(t) : null; } catch (_) { d = t; }
      return { ok: r.ok, status: r.status, data: d };
    };
    const errText = (r) => (r.data && (r.data.msg || r.data.message || r.data.error_description || r.data.error)) || ('chyba ' + r.status);

    // kdo volá: musí být přihlášený vedoucí
    const me = await call('/auth/v1/user');
    if (!me.ok || !me.data || !me.data.id) return json({ error: 'Nepřihlášený uživatel – odhlaste se a přihlaste znovu.' }, 401);
    const myEmail = String(me.data.email || '').toLowerCase();
    const isExp = await call('/rest/v1/rpc/is_expedice', { method: 'POST', body: '{}' });
    if (!isExp.ok) return json({ error: 'V Supabase spusťte aktualizovaný soubor supabase.sql.' }, 500);
    if (isExp.data === true) return json({ error: 'Uživatele může spravovat jen vedoucí.' }, 403);

    const body = await req.json().catch(() => ({}));
    const action = body.action;
    const roleRows = async () => { const r = await call('/rest/v1/user_roles?select=email,role', {}, true); return r.ok && Array.isArray(r.data) ? r.data : []; };
    const setRole = async (email, role) => role === 'expedice'
      ? call('/rest/v1/user_roles?on_conflict=email', { method: 'POST', body: JSON.stringify({ email, role }), headers: { Prefer: 'resolution=merge-duplicates,return=minimal' } }, true)
      : call('/rest/v1/user_roles?email=eq.' + encodeURIComponent(email), { method: 'DELETE' }, true);
    const findUser = async (id) => { const r = await call('/auth/v1/admin/users/' + encodeURIComponent(id), {}, true); return r.ok ? r.data : null; };

    if (action === 'list') {
      const r = await call('/auth/v1/admin/users?per_page=1000', {}, true);
      if (!r.ok) return json({ error: 'Seznam uživatelů se nepodařilo načíst: ' + errText(r) }, 500);
      const roles = Object.fromEntries((await roleRows()).map(x => [String(x.email).toLowerCase(), x.role]));
      const users = ((r.data && r.data.users) || []).map(u => {
        const email = String(u.email || '').toLowerCase();
        return { id: u.id, login: shortUser(email), email, role: roles[email] === 'expedice' ? 'expedice' : 'vedouci', me: email === myEmail, last: u.last_sign_in_at || null };
      }).sort((a, b) => a.login.localeCompare(b.login, 'cs'));
      return json({ users });
    }

    if (action === 'create') {
      if (!validLogin(body.login)) return json({ error: 'Přihlašovací jméno může obsahovat jen písmena bez diakritiky, číslice, tečku, pomlčku a podtržítko (2–40 znaků).' }, 400);
      if (String(body.password || '').length < 6) return json({ error: 'Heslo musí mít aspoň 6 znaků.' }, 400);
      const role = ROLES.includes(body.role) ? body.role : 'vedouci';
      const email = loginEmail(body.login);
      const r = await call('/auth/v1/admin/users', { method: 'POST', body: JSON.stringify({ email, password: String(body.password), email_confirm: true }) }, true);
      if (!r.ok) return json({ error: /already|registered|exists/i.test(errText(r)) ? 'Uživatel s tímto jménem už existuje.' : 'Uživatele se nepodařilo vytvořit: ' + errText(r) }, 400);
      if (role === 'expedice') { const s = await setRole(email, role); if (!s.ok) return json({ error: 'Uživatel vytvořen, ale roli se nepodařilo uložit: ' + errText(s) }, 500); }
      return json({ ok: true, login: shortUser(email) });
    }

    // ostatní akce pracují s existujícím uživatelem
    const u = body.id ? await findUser(body.id) : null;
    if (!u) return json({ error: 'Uživatel nenalezen.' }, 404);
    const email = String(u.email || '').toLowerCase(), self = email === myEmail;

    if (action === 'password') {
      if (String(body.password || '').length < 6) return json({ error: 'Heslo musí mít aspoň 6 znaků.' }, 400);
      const r = await call('/auth/v1/admin/users/' + encodeURIComponent(u.id), { method: 'PUT', body: JSON.stringify({ password: String(body.password) }) }, true);
      return r.ok ? json({ ok: true }) : json({ error: 'Heslo se nepodařilo změnit: ' + errText(r) }, 400);
    }
    if (action === 'role') {
      if (self) return json({ error: 'Vlastní roli změnit nejde.' }, 400);
      if (!ROLES.includes(body.role)) return json({ error: 'Neznámá role.' }, 400);
      const r = await setRole(email, body.role);
      return r.ok ? json({ ok: true }) : json({ error: 'Roli se nepodařilo uložit: ' + errText(r) }, 500);
    }
    if (action === 'delete') {
      if (self) return json({ error: 'Sami sebe smazat nemůžete.' }, 400);
      const r = await call('/auth/v1/admin/users/' + encodeURIComponent(u.id), { method: 'DELETE' }, true);
      if (!r.ok) return json({ error: 'Uživatele se nepodařilo smazat: ' + errText(r) }, 400);
      await setRole(email, 'vedouci');   // smaže případný záznam role
      return json({ ok: true });
    }
    return json({ error: 'Neznámá akce.' }, 400);
  } catch (e) {
    return json({ error: 'Chyba: ' + (e && e.message ? e.message : String(e)) }, 500);
  }
});
