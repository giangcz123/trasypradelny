-- Trasy prádelny: databáze pro sdílená data aplikace
-- Spusťte celé v Supabase: SQL Editor -> New query -> vložit -> Run.
-- Skript lze spustit opakovaně, nic nesmaže.

-- =====================================================================
-- 1. Sdílená data aplikace (auta, řidiči, zákazníci, plán)
-- =====================================================================
create table if not exists public.app_state (
  id         text primary key,
  data       jsonb       not null default '{}'::jsonb,
  version    bigint      not null default 1,
  updated_at timestamptz not null default now(),
  updated_by uuid        references auth.users(id)
);
alter table public.app_state enable row level security;
revoke all on public.app_state from anon;
grant select, insert, update on public.app_state to authenticated;
insert into public.app_state (id) values ('main') on conflict (id) do nothing;

-- =====================================================================
-- 2. Role uživatelů
--    Účet bez záznamu je vedoucí (vidí a upravuje vše).
--    Účet expedice zapíšete takto (e-mail podle skutečného účtu):
--      insert into public.user_roles (email, role) values ('expedice@vase-firma.cz', 'expedice')
--        on conflict (email) do update set role = excluded.role;
-- =====================================================================
create table if not exists public.user_roles (
  email text primary key,
  role  text not null check (role in ('vedouci', 'expedice'))
);
alter table public.user_roles enable row level security;
revoke all on public.user_roles from anon;
grant select on public.user_roles to authenticated;
drop policy if exists "vlastni role" on public.user_roles;
create policy "vlastni role" on public.user_roles for select to authenticated
  using (lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')));

create or replace function public.is_expedice() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.user_roles
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')) and role = 'expedice');
$$;
revoke all on function public.is_expedice() from public;
grant execute on function public.is_expedice() to authenticated;

-- Pravidla pro sdílená data: přihlášený čte, expedice nesmí měnit.
drop policy if exists "prihlaseni cist"    on public.app_state;
drop policy if exists "prihlaseni vlozit"  on public.app_state;
drop policy if exists "prihlaseni upravit" on public.app_state;
create policy "prihlaseni cist"    on public.app_state for select to authenticated using (true);
create policy "prihlaseni vlozit"  on public.app_state for insert to authenticated with check (not public.is_expedice());
create policy "prihlaseni upravit" on public.app_state for update to authenticated
  using (not public.is_expedice()) with check (not public.is_expedice());

-- =====================================================================
-- 3. Naplánované linky (pro řidiče, expedici a přehled Stav)
-- =====================================================================
create table if not exists public.runs (
  id           uuid primary key default gen_random_uuid(),
  token        uuid not null unique default gen_random_uuid(),  -- tajný odkaz pro řidiče
  day          date not null,
  vehicle_id   text not null,
  linka        int  not null default 1,
  plan         jsonb not null default '{}'::jsonb,   -- auto, řidič, hotely, časy
  plan_version int  not null default 1,
  load         jsonb,                                -- naložené klece {by, at, counts}
  prep         jsonb,                                -- klece připravené expedicí pro řidiče
  progress     jsonb not null default '{}'::jsonb,   -- stav jednotlivých hotelů
  problems     jsonb not null default '[]'::jsonb,   -- hlášení řidiče
  finish       jsonb,                                -- návrat a vykládka
  receive      jsonb,                                -- převzetí klecí expedicí
  sent_at      timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (day, vehicle_id, linka)
);
alter table public.runs enable row level security;
revoke all on public.runs from anon;
grant select, insert, update, delete on public.runs to authenticated;

drop policy if exists "linky cist"    on public.runs;
drop policy if exists "linky vlozit"  on public.runs;
drop policy if exists "linky upravit" on public.runs;
drop policy if exists "linky smazat"  on public.runs;
create policy "linky cist"    on public.runs for select to authenticated using (true);
create policy "linky vlozit"  on public.runs for insert to authenticated with check (not public.is_expedice());
create policy "linky upravit" on public.runs for update to authenticated using (true) with check (true);
create policy "linky smazat"  on public.runs for delete to authenticated using (not public.is_expedice());

create or replace function public.runs_touch() returns trigger
language plpgsql as $$ begin new.updated_at := now(); return new; end $$;
drop trigger if exists runs_touch on public.runs;
create trigger runs_touch before update on public.runs for each row execute function public.runs_touch();

-- Řidič bez přihlášení: přečte jen svou linku podle tajného odkazu (platí kolem dne jízdy).
create or replace function public.driver_get(p_token uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select (to_jsonb(r) - 'id') || jsonb_build_object(
           'next_token', (select n.token from public.runs n
                          where n.day = r.day and n.vehicle_id = r.vehicle_id and n.linka = r.linka + 1))
  from public.runs r
  where r.token = p_token and r.day between current_date - 1 and current_date + 1;
$$;

-- Řidič bez přihlášení: zapíše jen povolené údaje své linky.
create or replace function public.driver_save(p_token uuid, p_field text, p_value jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.runs;
begin
  select * into r from public.runs
   where token = p_token and day between current_date - 1 and current_date + 1 for update;
  if not found then raise exception 'Linka nenalezena nebo už neplatí'; end if;

  if p_field = 'stop' then        -- stav jednoho hotelu: {"id": "...", "state": "done", ...}
    if coalesce(p_value ->> 'id', '') = '' then raise exception 'Chybí hotel'; end if;
    update public.runs
       set progress = progress || jsonb_build_object(p_value ->> 'id', (p_value - 'id') || jsonb_build_object('at', now()))
     where id = r.id;
  elsif p_field = 'load' then     -- nakládka řidičem
    if r.load is not null and r.load ->> 'by' = 'expedice' then raise exception 'Linku už naložila expedice'; end if;
    update public.runs set load = p_value || jsonb_build_object('at', now()) where id = r.id;
  elsif p_field = 'problem' then  -- hlášení problému
    update public.runs set problems = problems || jsonb_build_array(p_value || jsonb_build_object('at', now())) where id = r.id;
  elsif p_field = 'finish' then   -- návrat do prádelny a vykládka
    update public.runs set finish = p_value || jsonb_build_object('at', now()) where id = r.id;
  else
    raise exception 'Nepovolená změna';
  end if;
  return public.driver_get(p_token);
end $$;

revoke all on function public.driver_get(uuid) from public;
revoke all on function public.driver_save(uuid, text, jsonb) from public;
grant execute on function public.driver_get(uuid) to anon, authenticated;
grant execute on function public.driver_save(uuid, text, jsonb) to anon, authenticated;

-- =====================================================================
-- 4. Živé změny (upozornění a přehled Stav bez obnovování stránky)
-- =====================================================================
do $$ begin
  alter publication supabase_realtime add table public.app_state;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.runs;
exception when duplicate_object then null; end $$;
