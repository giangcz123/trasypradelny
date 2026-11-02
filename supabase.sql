-- Trasy prádelny: databáze pro sdílená data aplikace
-- Spusťte jednou v Supabase: SQL Editor -> New query -> vložit -> Run

create table if not exists public.app_state (
  id         text primary key,
  data       jsonb       not null default '{}'::jsonb,
  version    bigint      not null default 1,
  updated_at timestamptz not null default now(),
  updated_by uuid        references auth.users(id)
);

-- Přístup jen pro přihlášené uživatele; nepřihlášený nevidí nic.
alter table public.app_state enable row level security;

drop policy if exists "prihlaseni cist"    on public.app_state;
drop policy if exists "prihlaseni vlozit"  on public.app_state;
drop policy if exists "prihlaseni upravit" on public.app_state;
create policy "prihlaseni cist"    on public.app_state for select to authenticated using (true);
create policy "prihlaseni vlozit"  on public.app_state for insert to authenticated with check (true);
create policy "prihlaseni upravit" on public.app_state for update to authenticated using (true) with check (true);

revoke all on public.app_state from anon;
grant select, insert, update on public.app_state to authenticated;

insert into public.app_state (id) values ('main') on conflict (id) do nothing;

-- Upozornění, když data změní někdo jiný (živé změny)
do $$ begin
  alter publication supabase_realtime add table public.app_state;
exception when duplicate_object then null; end $$;
