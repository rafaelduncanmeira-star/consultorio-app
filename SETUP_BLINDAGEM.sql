-- ============================================================
-- BLINDAGEM Fase 2.1 — Atendimentos por linha (isolamento por profissional)
-- Rode no SQL Editor do Supabase. Idempotente (pode rodar de novo).
-- Depois do SETUP_EQUIPE_PROFISSIONAL.sql (precisa de team_members.profissional_id).
-- ============================================================

-- Cada atendimento vira UMA linha, com o profissional dono.
-- O registro completo fica em `data` (jsonb); id/owner/profissional ficam
-- em colunas pra chave primária, índice e RLS.
create table if not exists clinica_atendimentos (
  id              text primary key,
  owner_id        uuid not null references auth.users(id) on delete cascade,
  profissional_id text,
  data            jsonb not null,
  updated_at      timestamptz default now()
);
create index if not exists idx_clin_atend_owner on clinica_atendimentos(owner_id);
create index if not exists idx_clin_atend_prof  on clinica_atendimentos(owner_id, profissional_id);

alter table clinica_atendimentos enable row level security;

-- RLS — o coração da blindagem:
--   • dono (médico titular) → vê/edita TUDO da clínica
--   • membro secretária/médico → vê TUDO da clínica
--   • membro profissional → vê/edita SÓ as linhas com o profissional_id dele
drop policy if exists "acesso atendimentos clinica" on clinica_atendimentos;
create policy "acesso atendimentos clinica" on clinica_atendimentos
  for all to authenticated
  using (
    auth.uid() = owner_id
    OR exists (
      select 1 from team_members tm
      where tm.member_id = auth.uid()
        and tm.owner_id = clinica_atendimentos.owner_id
        and (tm.role <> 'profissional' OR tm.profissional_id = clinica_atendimentos.profissional_id)
    )
  )
  with check (
    auth.uid() = owner_id
    OR exists (
      select 1 from team_members tm
      where tm.member_id = auth.uid()
        and tm.owner_id = clinica_atendimentos.owner_id
        and (tm.role <> 'profissional' OR tm.profissional_id = clinica_atendimentos.profissional_id)
    )
  );

-- Realtime (idempotente — não falha se já estiver na publicação)
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'clinica_atendimentos'
  ) then
    alter publication supabase_realtime add table clinica_atendimentos;
  end if;
end $$;

-- ============================================================
-- Fase 2.2 — Agendamentos por linha (mesma estrutura + RLS)
-- ============================================================
create table if not exists clinica_agendamentos (
  id              text primary key,
  owner_id        uuid not null references auth.users(id) on delete cascade,
  profissional_id text,
  data            jsonb not null,
  updated_at      timestamptz default now()
);
create index if not exists idx_clin_ag_owner on clinica_agendamentos(owner_id);
create index if not exists idx_clin_ag_prof  on clinica_agendamentos(owner_id, profissional_id);

alter table clinica_agendamentos enable row level security;
drop policy if exists "acesso agendamentos clinica" on clinica_agendamentos;
create policy "acesso agendamentos clinica" on clinica_agendamentos
  for all to authenticated
  using (
    auth.uid() = owner_id
    OR exists (select 1 from team_members tm
      where tm.member_id = auth.uid() and tm.owner_id = clinica_agendamentos.owner_id
        and (tm.role <> 'profissional' OR tm.profissional_id = clinica_agendamentos.profissional_id))
  )
  with check (
    auth.uid() = owner_id
    OR exists (select 1 from team_members tm
      where tm.member_id = auth.uid() and tm.owner_id = clinica_agendamentos.owner_id
        and (tm.role <> 'profissional' OR tm.profissional_id = clinica_agendamentos.profissional_id))
  );

do $$
begin
  if not exists (select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'clinica_agendamentos') then
    alter publication supabase_realtime add table clinica_agendamentos;
  end if;
end $$;

-- ============================================================
-- Fase 2.3 — CRM (contatos) por linha (mesma estrutura + RLS)
-- ============================================================
create table if not exists clinica_crm (
  id              text primary key,
  owner_id        uuid not null references auth.users(id) on delete cascade,
  profissional_id text,
  data            jsonb not null,
  updated_at      timestamptz default now()
);
create index if not exists idx_clin_crm_owner on clinica_crm(owner_id);
create index if not exists idx_clin_crm_prof  on clinica_crm(owner_id, profissional_id);

alter table clinica_crm enable row level security;
drop policy if exists "acesso crm clinica" on clinica_crm;
create policy "acesso crm clinica" on clinica_crm
  for all to authenticated
  using (
    auth.uid() = owner_id
    OR exists (select 1 from team_members tm
      where tm.member_id = auth.uid() and tm.owner_id = clinica_crm.owner_id
        and (tm.role <> 'profissional' OR tm.profissional_id = clinica_crm.profissional_id))
  )
  with check (
    auth.uid() = owner_id
    OR exists (select 1 from team_members tm
      where tm.member_id = auth.uid() and tm.owner_id = clinica_crm.owner_id
        and (tm.role <> 'profissional' OR tm.profissional_id = clinica_crm.profissional_id))
  );

do $$
begin
  if not exists (select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'clinica_crm') then
    alter publication supabase_realtime add table clinica_crm;
  end if;
end $$;

-- Pronto. Rode o arquivo inteiro (é idempotente). O app passa a usar as tabelas
-- conforme as coleções entram no _BLINDADAS.
