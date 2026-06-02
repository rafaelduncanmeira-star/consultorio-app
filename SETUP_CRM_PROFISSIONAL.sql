-- ============================================================
-- TIJOLO 4B — Roteamento por número (número por profissional)
-- Rode no SQL Editor do Supabase. Idempotente.
-- ============================================================

-- Coluna que guarda a qual profissional o contato pertence
-- (preenchida pelo webhook quando a URL tem &prof=<id>).
alter table crm_leads add column if not exists profissional_id text;

-- Pronto. Agora recole o webhook (wa-webhook) com a versão nova.
