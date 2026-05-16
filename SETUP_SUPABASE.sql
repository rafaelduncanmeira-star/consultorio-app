-- ============================================================
-- CONSULTÓRIO APP — Setup tabelas WhatsApp
-- Execute este script no SQL Editor do Supabase
-- Projeto: https://ipvztcqlawwslnkzmzzl.supabase.co
-- ============================================================

-- Tabela de leads vindos do WhatsApp (Make insere aqui)
create table if not exists crm_leads (
  id               uuid        default gen_random_uuid() primary key,
  created_at       timestamptz default now(),
  nome             text,
  whatsapp         text        not null,
  primeira_mensagem text,
  canal            text        default 'WhatsApp',
  status           text        default 'Contato feito',
  processado       boolean     default false
);

-- Tabela de mensagens de cada conversa
create table if not exists crm_messages (
  id         uuid        default gen_random_uuid() primary key,
  created_at timestamptz default now(),
  whatsapp   text        not null,
  remetente  text        not null check (remetente in ('contato', 'consultorio')),
  mensagem   text        not null,
  lida       boolean     default false
);

-- Índices para performance
create index if not exists idx_crm_leads_whatsapp    on crm_leads    (whatsapp);
create index if not exists idx_crm_leads_processado  on crm_leads    (processado);
create index if not exists idx_crm_messages_whatsapp on crm_messages (whatsapp);
create index if not exists idx_crm_messages_created  on crm_messages (created_at);

-- Habilita Realtime nas duas tabelas
alter publication supabase_realtime add table crm_leads;
alter publication supabase_realtime add table crm_messages;

-- Permissões (anon pode inserir — o Make usa a anon key)
alter table crm_leads    enable row level security;
alter table crm_messages enable row level security;

create policy "anon insert crm_leads"    on crm_leads    for insert to anon with check (true);
create policy "anon insert crm_messages" on crm_messages for insert to anon with check (true);
create policy "auth select crm_leads"    on crm_leads    for select to authenticated using (true);
create policy "auth select crm_messages" on crm_messages for select to authenticated using (true);
create policy "auth update crm_leads"    on crm_leads    for update to authenticated using (true);
create policy "auth insert crm_messages auth" on crm_messages for insert to authenticated with check (true);
