-- =============================================================
-- 0001_core.sql — Fundação multi-tenant
-- clinics, memberships, patients, patient_invites + RLS + RPCs
-- Idempotente: pode rodar mais de uma vez sem erro.
-- =============================================================

create extension if not exists pgcrypto;

-- Schema para funções auxiliares (não exposto na API)
create schema if not exists app;

-- ---------------------------------------------------------------
-- Tabelas
-- ---------------------------------------------------------------

create table if not exists public.clinics (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.memberships (
  clinic_id  uuid not null references public.clinics(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       text not null check (role in ('owner', 'professional', 'assistant')),
  created_at timestamptz not null default now(),
  primary key (clinic_id, user_id)
);

create table if not exists public.patients (
  id              uuid primary key default gen_random_uuid(),
  clinic_id       uuid not null references public.clinics(id) on delete cascade,
  professional_id uuid references auth.users(id) on delete set null,
  name            text not null,
  phone           text,
  email           text,
  birth_date      date,
  notes           text,
  user_id         uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now()
);

create index if not exists patients_clinic_idx on public.patients (clinic_id);
create index if not exists patients_user_idx on public.patients (user_id) where user_id is not null;

create table if not exists public.patient_invites (
  token      uuid primary key default gen_random_uuid(),
  clinic_id  uuid not null references public.clinics(id) on delete cascade,
  patient_id uuid not null references public.patients(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days',
  used_at    timestamptz
);

create index if not exists patient_invites_patient_idx on public.patient_invites (patient_id);

-- ---------------------------------------------------------------
-- Funções auxiliares (SECURITY DEFINER evita recursão de RLS)
-- ---------------------------------------------------------------

create or replace function app.is_member(cid uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.memberships
    where clinic_id = cid and user_id = auth.uid()
  );
$$;

create or replace function app.is_owner(cid uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.memberships
    where clinic_id = cid and user_id = auth.uid() and role = 'owner'
  );
$$;

create or replace function app.my_patient_ids()
returns setof uuid
language sql stable security definer
set search_path = public
as $$
  select id from public.patients where user_id = auth.uid();
$$;

revoke all on function app.is_member(uuid), app.is_owner(uuid), app.my_patient_ids() from public;
grant execute on function app.is_member(uuid), app.is_owner(uuid), app.my_patient_ids() to authenticated;

-- ---------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------

alter table public.clinics enable row level security;
alter table public.memberships enable row level security;
alter table public.patients enable row level security;
alter table public.patient_invites enable row level security;

-- clinics: membro lê; dono edita
drop policy if exists clinics_select_member on public.clinics;
create policy clinics_select_member on public.clinics
  for select to authenticated using (app.is_member(id));

drop policy if exists clinics_update_owner on public.clinics;
create policy clinics_update_owner on public.clinics
  for update to authenticated using (app.is_owner(id));

-- memberships: membro vê a equipe da própria clínica; gestão via RPC/dono
drop policy if exists memberships_select_member on public.memberships;
create policy memberships_select_member on public.memberships
  for select to authenticated using (app.is_member(clinic_id));

drop policy if exists memberships_delete_owner on public.memberships;
create policy memberships_delete_owner on public.memberships
  for delete to authenticated using (app.is_owner(clinic_id) and user_id <> auth.uid());

-- patients: equipe da clínica gerencia; paciente lê a própria linha
drop policy if exists patients_all_member on public.patients;
create policy patients_all_member on public.patients
  for all to authenticated
  using (app.is_member(clinic_id))
  with check (app.is_member(clinic_id));

drop policy if exists patients_select_self on public.patients;
create policy patients_select_self on public.patients
  for select to authenticated using (user_id = auth.uid());

-- patient_invites: só a equipe da clínica (aceite é via RPC)
drop policy if exists invites_all_member on public.patient_invites;
create policy invites_all_member on public.patient_invites
  for all to authenticated
  using (app.is_member(clinic_id))
  with check (app.is_member(clinic_id));

-- ---------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------

-- Onboarding: cria a clínica e torna o usuário atual dono (atômico)
create or replace function public.create_clinic(p_name text)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_clinic uuid;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;
  if coalesce(trim(p_name), '') = '' then
    raise exception 'invalid_name';
  end if;
  insert into public.clinics (name) values (trim(p_name)) returning id into v_clinic;
  insert into public.memberships (clinic_id, user_id, role)
  values (v_clinic, auth.uid(), 'owner');
  return v_clinic;
end;
$$;

-- Página do convite (antes do login): dados mínimos, sem expor o paciente
create or replace function public.peek_patient_invite(p_token uuid)
returns json
language plpgsql stable security definer
set search_path = public
as $$
declare
  v json;
begin
  select json_build_object(
    'clinic_name', c.name,
    'patient_first_name', split_part(p.name, ' ', 1),
    'valid', (i.used_at is null and i.expires_at > now())
  )
  into v
  from public.patient_invites i
  join public.clinics c on c.id = i.clinic_id
  join public.patients p on p.id = i.patient_id
  where i.token = p_token;

  return coalesce(v, json_build_object('valid', false));
end;
$$;

-- Aceite do convite: vincula o usuário logado ao paciente
create or replace function public.accept_patient_invite(p_token uuid)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_invite record;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;

  select * into v_invite
  from public.patient_invites
  where token = p_token
  for update;

  if v_invite is null then
    raise exception 'invite_not_found';
  end if;
  if v_invite.used_at is not null then
    raise exception 'invite_already_used';
  end if;
  if v_invite.expires_at <= now() then
    raise exception 'invite_expired';
  end if;

  -- Não deixa "roubar" um paciente já vinculado a outra conta
  if exists (
    select 1 from public.patients
    where id = v_invite.patient_id
      and user_id is not null
      and user_id <> auth.uid()
  ) then
    raise exception 'patient_already_linked';
  end if;

  -- Um usuário da equipe não pode virar o paciente da própria clínica
  if exists (
    select 1 from public.memberships
    where clinic_id = v_invite.clinic_id and user_id = auth.uid()
  ) then
    raise exception 'member_cannot_be_patient';
  end if;

  update public.patients
  set user_id = auth.uid()
  where id = v_invite.patient_id;

  update public.patient_invites
  set used_at = now()
  where token = p_token;

  return v_invite.patient_id;
end;
$$;

revoke all on function public.create_clinic(text) from public;
grant execute on function public.create_clinic(text) to authenticated;

revoke all on function public.accept_patient_invite(uuid) from public;
grant execute on function public.accept_patient_invite(uuid) to authenticated;

revoke all on function public.peek_patient_invite(uuid) from public;
grant execute on function public.peek_patient_invite(uuid) to anon, authenticated;
