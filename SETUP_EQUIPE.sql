-- ============================================================
-- CONSULTÓRIO APP — Multi-usuário (equipe na mesma clínica)
-- Execute este script no SQL Editor do Supabase
-- DEPOIS de já ter rodado o SETUP_SUPABASE.sql
-- ============================================================

-- ------------------------------------------------------------
-- 1) TEAM_MEMBERS — quem é membro da equipe de quem
-- Cada conta tem implicitamente sua própria "clínica"
-- (= seu user_id). team_members liga uma conta-membro a uma
-- conta-dona (owner) para compartilhar dados.
-- ------------------------------------------------------------
create table if not exists team_members (
  owner_id   uuid not null references auth.users(id) on delete cascade,
  member_id  uuid not null references auth.users(id) on delete cascade,
  role       text not null default 'secretaria' check (role in ('medico','secretaria')),
  created_at timestamptz default now(),
  primary key (owner_id, member_id)
);
create index if not exists idx_team_members_member on team_members(member_id);

alter table team_members enable row level security;
drop policy if exists "see own memberships"  on team_members;
drop policy if exists "owner can add members" on team_members;
drop policy if exists "owner can remove members" on team_members;

create policy "see own memberships" on team_members
  for select to authenticated
  using (auth.uid() = owner_id OR auth.uid() = member_id);
create policy "owner can add members" on team_members
  for insert to authenticated
  with check (auth.uid() = owner_id);
create policy "owner can remove members" on team_members
  for delete to authenticated
  using (auth.uid() = owner_id);

-- ------------------------------------------------------------
-- 2) TEAM_INVITES — convites pendentes (com token)
-- O dono gera um link com token e envia manualmente (WhatsApp/email)
-- O convidado faz login, abre o link, aceita e é adicionado a team_members
-- ------------------------------------------------------------
create table if not exists team_invites (
  id          uuid        default gen_random_uuid() primary key,
  owner_id    uuid        not null references auth.users(id) on delete cascade,
  email       text        not null,
  role        text        default 'secretaria' check (role in ('medico','secretaria')),
  token       text        not null unique default encode(gen_random_bytes(16), 'hex'),
  expires_at  timestamptz default (now() + interval '7 days'),
  created_at  timestamptz default now(),
  accepted_at timestamptz,
  accepted_by uuid        references auth.users(id)
);
create index if not exists idx_team_invites_token on team_invites(token);
create index if not exists idx_team_invites_email on team_invites(email);
create index if not exists idx_team_invites_owner on team_invites(owner_id);

alter table team_invites enable row level security;
drop policy if exists "owner manages own invites" on team_invites;
drop policy if exists "auth can read invite by token" on team_invites;  -- legado inseguro
drop policy if exists "auth can accept invite" on team_invites;          -- legado inseguro

-- APENAS o dono lê/gerencia seus próprios convites.
-- O aceite NÃO usa SELECT/UPDATE direto (vazava todos os tokens do sistema);
-- agora é feito pela função accept_invite() abaixo (SECURITY DEFINER).
create policy "owner manages own invites" on team_invites
  for all to authenticated
  using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

-- ------------------------------------------------------------
-- 2b) FUNÇÃO DE ACEITE — SECURITY DEFINER
-- Valida o token server-side, insere o membro e marca o convite
-- como aceito numa transação. Roda com privilégio elevado (bypassa
-- RLS), então o convidado consegue entrar mesmo sem ser dono — sem
-- expor os tokens dos outros.
-- ------------------------------------------------------------
create or replace function accept_invite(invite_token text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare inv team_invites;
begin
  -- Busca o convite válido (sem expor via RLS — roda como definer)
  select * into inv from team_invites
    where token = invite_token
      and accepted_at is null
      and expires_at > now();
  if not found then
    return json_build_object('error', 'Convite inválido, expirado ou já utilizado.');
  end if;

  -- Não deixa a pessoa entrar na própria "equipe"
  if inv.owner_id = auth.uid() then
    return json_build_object('error', 'Você não pode aceitar um convite seu mesmo.');
  end if;

  -- Adiciona como membro (idempotente)
  insert into team_members (owner_id, member_id, role)
    values (inv.owner_id, auth.uid(), inv.role)
    on conflict (owner_id, member_id) do update set role = excluded.role;

  -- Marca convite como aceito
  update team_invites
    set accepted_at = now(), accepted_by = auth.uid()
    where id = inv.id;

  -- Atualiza o papel do perfil de quem aceitou
  update profiles set role = inv.role where id = auth.uid();

  return json_build_object('ok', true, 'owner_id', inv.owner_id, 'role', inv.role);
end $$;

-- Garante que usuários autenticados podem chamar a função via RPC
grant execute on function accept_invite(text) to authenticated;

-- ------------------------------------------------------------
-- 3) RLS revisada — app_data, crm_leads, crm_messages
-- Acesso permitido se: (a) você é dono OU (b) é membro do dono
-- ------------------------------------------------------------

-- ----- APP_DATA -----
drop policy if exists "own rows select" on app_data;
drop policy if exists "own rows insert" on app_data;
drop policy if exists "own rows update" on app_data;
drop policy if exists "own rows delete" on app_data;
drop policy if exists "team read app_data"   on app_data;
drop policy if exists "team insert app_data" on app_data;
drop policy if exists "team update app_data" on app_data;
drop policy if exists "team delete app_data" on app_data;

create policy "team read app_data" on app_data for select to authenticated using (
  auth.uid() = user_id
  OR user_id IN (select owner_id from team_members where member_id = auth.uid())
);
create policy "team insert app_data" on app_data for insert to authenticated with check (
  auth.uid() = user_id
  OR user_id IN (select owner_id from team_members where member_id = auth.uid())
);
create policy "team update app_data" on app_data for update to authenticated using (
  auth.uid() = user_id
  OR user_id IN (select owner_id from team_members where member_id = auth.uid())
) with check (
  auth.uid() = user_id
  OR user_id IN (select owner_id from team_members where member_id = auth.uid())
);
create policy "team delete app_data" on app_data for delete to authenticated using (
  auth.uid() = user_id
  OR user_id IN (select owner_id from team_members where member_id = auth.uid())
);

-- ----- CRM_LEADS -----
drop policy if exists "auth select own crm_leads" on crm_leads;
drop policy if exists "auth update own crm_leads" on crm_leads;
drop policy if exists "team select crm_leads" on crm_leads;
drop policy if exists "team update crm_leads" on crm_leads;

create policy "team select crm_leads" on crm_leads for select to authenticated using (
  auth.uid() = user_id
  OR user_id IN (select owner_id from team_members where member_id = auth.uid())
);
create policy "team update crm_leads" on crm_leads for update to authenticated using (
  auth.uid() = user_id
  OR user_id IN (select owner_id from team_members where member_id = auth.uid())
);

-- ----- CRM_MESSAGES -----
drop policy if exists "auth select own crm_messages" on crm_messages;
drop policy if exists "auth insert own crm_messages" on crm_messages;
drop policy if exists "team select crm_messages" on crm_messages;
drop policy if exists "team insert crm_messages" on crm_messages;

create policy "team select crm_messages" on crm_messages for select to authenticated using (
  auth.uid() = user_id
  OR user_id IN (select owner_id from team_members where member_id = auth.uid())
);
create policy "team insert crm_messages" on crm_messages for insert to authenticated with check (
  auth.uid() = user_id
  OR user_id IN (select owner_id from team_members where member_id = auth.uid())
);

-- ------------------------------------------------------------
-- 4) Realtime para as novas tabelas (idempotente — ignora se já adicionado)
-- ------------------------------------------------------------
do $$ begin
  alter publication supabase_realtime add table team_members;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table team_invites;
exception when duplicate_object then null; end $$;

-- ============================================================
-- ✅ PRONTO
-- ============================================================
