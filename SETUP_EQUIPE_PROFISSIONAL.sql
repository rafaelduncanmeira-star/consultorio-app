-- ============================================================
-- TIJOLO 2 — Papel "profissional" + vínculo login ↔ profissional
-- Rode no SQL Editor do Supabase DEPOIS do SETUP_EQUIPE.sql
-- É idempotente: pode rodar mais de uma vez sem problema.
-- ============================================================

-- ------------------------------------------------------------
-- 1) Permite o papel 'profissional' (remove os checks antigos de role,
--    qualquer que seja o nome auto-gerado, e recria já com o novo valor)
-- ------------------------------------------------------------
do $$
declare c text;
begin
  for c in select conname from pg_constraint
           where conrelid = 'team_members'::regclass and contype = 'c'
             and pg_get_constraintdef(oid) ilike '%role%'
  loop execute format('alter table team_members drop constraint %I', c); end loop;

  for c in select conname from pg_constraint
           where conrelid = 'team_invites'::regclass and contype = 'c'
             and pg_get_constraintdef(oid) ilike '%role%'
  loop execute format('alter table team_invites drop constraint %I', c); end loop;

  -- profiles.role também pode ter um check que barra 'profissional'
  begin
    for c in select conname from pg_constraint
             where conrelid = 'profiles'::regclass and contype = 'c'
               and pg_get_constraintdef(oid) ilike '%role%'
    loop execute format('alter table profiles drop constraint %I', c); end loop;
  exception when undefined_table then null;
  end;
end $$;

alter table team_members add constraint team_members_role_chk
  check (role in ('medico','secretaria','profissional'));
alter table team_invites add constraint team_invites_role_chk
  check (role in ('medico','secretaria','profissional'));

-- ------------------------------------------------------------
-- 2) Coluna de vínculo com o profissional da clínica
--    (= id do registro em consult_profissionais, guardado no app_data)
-- ------------------------------------------------------------
alter table team_members add column if not exists profissional_id text;
alter table team_invites add column if not exists profissional_id text;

-- ------------------------------------------------------------
-- 3) accept_invite agora carrega o profissional_id pro membro
-- ------------------------------------------------------------
create or replace function accept_invite(invite_token text)
returns json language plpgsql security definer set search_path = public as $$
declare inv team_invites;
begin
  select * into inv from team_invites
    where token = invite_token and accepted_at is null and expires_at > now();
  if not found then
    return json_build_object('error', 'Convite inválido, expirado ou já utilizado.');
  end if;
  if inv.owner_id = auth.uid() then
    return json_build_object('error', 'Você não pode aceitar um convite seu mesmo.');
  end if;
  -- Convite é NOMINAL: só a conta com o e-mail convidado pode aceitar. Sem isto,
  -- qualquer um que recebesse o link (o app manda por WhatsApp) entrava na
  -- clínica com o papel do convite. (Convites antigos sem e-mail seguem abertos.)
  if inv.email is not null and inv.email <> ''
     and lower(inv.email) <> lower(coalesce(auth.email(), '')) then
    return json_build_object('error', 'Este convite é para outro e-mail. Entre com a conta convidada.');
  end if;

  insert into team_members (owner_id, member_id, role, profissional_id)
    values (inv.owner_id, auth.uid(), inv.role, inv.profissional_id)
    on conflict (owner_id, member_id)
      do update set role = excluded.role, profissional_id = excluded.profissional_id;

  update team_invites set accepted_at = now(), accepted_by = auth.uid() where id = inv.id;
  -- NÃO sobrescreve profiles.role (papel GLOBAL). O papel do convite vale só
  -- DENTRO da equipe e já fica em team_members.role (lido por resolveDataOwner).
  -- Antes, um DONO que aceitasse convite de outra clínica virava "secretária" na
  -- PRÓPRIA clínica e ficava trancado fora dos próprios dados.

  return json_build_object('ok', true, 'owner_id', inv.owner_id,
                           'role', inv.role, 'profissional_id', inv.profissional_id);
end $$;
grant execute on function accept_invite(text) to authenticated;

-- ------------------------------------------------------------
-- 4) peek_invite devolve o profissional_id (pro banner do convite)
-- ------------------------------------------------------------
create or replace function peek_invite(invite_token text)
returns json language plpgsql security definer set search_path = public as $$
declare inv team_invites; owner_nome text;
begin
  select * into inv from team_invites
    where token = invite_token and accepted_at is null and expires_at > now();
  if not found then return json_build_object('valid', false); end if;
  select nome into owner_nome from profiles where id = inv.owner_id;
  return json_build_object('valid', true, 'role', inv.role, 'email', inv.email,
    'profissional_id', inv.profissional_id, 'ownerNome', coalesce(owner_nome, 'um consultório'));
end $$;
grant execute on function peek_invite(text) to anon, authenticated;

-- Pronto. Agora dá pra convidar alguém como "Profissional" no app.
