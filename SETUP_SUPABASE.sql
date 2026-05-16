-- ============================================================
-- CONSULTÓRIO APP — Setup completo (multi-tenant via user_id)
-- Execute este script no SQL Editor do Supabase
-- Projeto: https://ipvztcqlawwslnkzmzzl.supabase.co
-- ============================================================

-- ------------------------------------------------------------
-- 1) APP_DATA — chave/valor JSON com isolamento por usuário
-- ------------------------------------------------------------
create table if not exists app_data (
  user_id    uuid        not null references auth.users(id) on delete cascade,
  key        text        not null,
  value      jsonb,
  updated_at timestamptz default now(),
  primary key (user_id, key)
);

-- Migração: se app_data já existir sem user_id, adiciona a coluna
alter table app_data add column if not exists user_id uuid references auth.users(id);

-- Migração: troca PK se ela estiver só em (key)
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'app_data_pkey'
      and pg_get_constraintdef(oid) not like '%user_id%'
  ) then
    alter table app_data drop constraint app_data_pkey;
    alter table app_data add primary key (user_id, key);
  end if;
end $$;

alter table app_data enable row level security;
drop policy if exists "own rows select" on app_data;
drop policy if exists "own rows insert" on app_data;
drop policy if exists "own rows update" on app_data;
drop policy if exists "own rows delete" on app_data;
create policy "own rows select" on app_data for select to authenticated using (auth.uid() = user_id);
create policy "own rows insert" on app_data for insert to authenticated with check (auth.uid() = user_id);
create policy "own rows update" on app_data for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own rows delete" on app_data for delete to authenticated using (auth.uid() = user_id);

-- ------------------------------------------------------------
-- 2) PROFILES — papel + nome do usuário
-- ------------------------------------------------------------
create table if not exists profiles (
  id   uuid primary key references auth.users(id) on delete cascade,
  role text default 'secretaria' check (role in ('medico', 'secretaria')),
  nome text
);
alter table profiles enable row level security;
drop policy if exists "self select" on profiles;
drop policy if exists "self update" on profiles;
create policy "self select" on profiles for select to authenticated using (auth.uid() = id);
create policy "self update" on profiles for update to authenticated using (auth.uid() = id);

-- ------------------------------------------------------------
-- 3) CRM_LEADS — contatos novos do WhatsApp (Make insere aqui)
-- ------------------------------------------------------------
create table if not exists crm_leads (
  id                uuid        default gen_random_uuid() primary key,
  user_id           uuid        references auth.users(id) on delete cascade,
  created_at        timestamptz default now(),
  nome              text,
  whatsapp          text        not null,
  primeira_mensagem text,
  canal             text        default 'WhatsApp',
  status            text        default 'Contato feito',
  processado        boolean     default false
);
alter table crm_leads add column if not exists user_id uuid references auth.users(id) on delete cascade;

create index if not exists idx_crm_leads_whatsapp    on crm_leads (whatsapp);
create index if not exists idx_crm_leads_processado  on crm_leads (processado);
create index if not exists idx_crm_leads_user        on crm_leads (user_id);

alter table crm_leads enable row level security;
drop policy if exists "anon insert crm_leads" on crm_leads;
drop policy if exists "auth select crm_leads" on crm_leads;
drop policy if exists "auth update crm_leads" on crm_leads;
drop policy if exists "auth select own crm_leads" on crm_leads;
drop policy if exists "auth update own crm_leads" on crm_leads;
drop policy if exists "anon insert with user_id" on crm_leads;

-- Make/Z-API entra como anon e DEVE incluir user_id no payload
create policy "anon insert with user_id" on crm_leads for insert to anon
  with check (user_id is not null);
create policy "auth select own crm_leads" on crm_leads for select to authenticated
  using (auth.uid() = user_id);
create policy "auth update own crm_leads" on crm_leads for update to authenticated
  using (auth.uid() = user_id);

-- ------------------------------------------------------------
-- 4) CRM_MESSAGES — histórico de cada conversa
-- ------------------------------------------------------------
create table if not exists crm_messages (
  id         uuid        default gen_random_uuid() primary key,
  user_id    uuid        references auth.users(id) on delete cascade,
  created_at timestamptz default now(),
  whatsapp   text        not null,
  remetente  text        not null check (remetente in ('contato', 'consultorio')),
  mensagem   text        not null,
  lida       boolean     default false
);
alter table crm_messages add column if not exists user_id uuid references auth.users(id) on delete cascade;

create index if not exists idx_crm_messages_whatsapp on crm_messages (whatsapp);
create index if not exists idx_crm_messages_created  on crm_messages (created_at);
create index if not exists idx_crm_messages_user     on crm_messages (user_id);

alter table crm_messages enable row level security;
drop policy if exists "anon insert crm_messages" on crm_messages;
drop policy if exists "auth select crm_messages" on crm_messages;
drop policy if exists "auth insert crm_messages auth" on crm_messages;
drop policy if exists "auth select own crm_messages" on crm_messages;
drop policy if exists "auth insert own crm_messages" on crm_messages;
drop policy if exists "anon insert with user_id msg" on crm_messages;

create policy "anon insert with user_id msg" on crm_messages for insert to anon
  with check (user_id is not null);
create policy "auth select own crm_messages" on crm_messages for select to authenticated
  using (auth.uid() = user_id);
create policy "auth insert own crm_messages" on crm_messages for insert to authenticated
  with check (auth.uid() = user_id);

-- ------------------------------------------------------------
-- 5) Realtime
-- ------------------------------------------------------------
alter publication supabase_realtime add table app_data;
alter publication supabase_realtime add table crm_leads;
alter publication supabase_realtime add table crm_messages;

-- ============================================================
-- IMPORTANTE — Integração Make → Supabase:
-- O cenário Make TEM que incluir o campo `user_id` no payload
-- correspondente ao dono daquele número de WhatsApp.
-- Sem user_id, o Supabase recusa o insert (RLS).
-- ============================================================
