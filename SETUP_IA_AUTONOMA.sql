-- ============================================================
-- SETUP IA AUTÔNOMA — rodar no SQL Editor do Supabase (idempotente)
-- Necessário ANTES de ligar o modo autônomo da secretária IA.
-- ============================================================

-- Dedupe de eventos do WhatsApp: a Meta/Z-API REENTREGAM o mesmo evento
-- quando o webhook demora ou falha. Sem esta tabela o paciente pode receber
-- a mesma resposta 2-3x. O webhook insere o id do provedor aqui; se já
-- existir (unique violation), ignora o evento.
create table if not exists public.wa_eventos (
  id         text primary key,          -- id da mensagem no provedor (Meta/Z-API)
  owner_id   uuid,
  created_at timestamptz not null default now()
);

-- Trava a tabela para clientes comuns (só a service role do webhook usa).
alter table public.wa_eventos enable row level security;

-- Índice p/ limpeza por data.
create index if not exists wa_eventos_created_idx on public.wa_eventos (created_at);

-- Limpeza: eventos com mais de 7 dias não servem pra dedupe.
-- (Rode de vez em quando, ou agende com pg_cron se disponível.)
-- delete from public.wa_eventos where created_at < now() - interval '7 days';
