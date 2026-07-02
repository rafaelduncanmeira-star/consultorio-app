-- ============================================================
-- SETUP SYNC — rodar no SQL Editor do Supabase (idempotente)
-- Habilita a concorrência otimista dos blobs do app_data.
--
-- Problema que resolve: dois aparelhos (PC + celular) editando a mesma chave
-- (procedimentos, despesas, config...) ao mesmo tempo — o último a gravar
-- SOBRESCREVIA o outro por completo (last-write-wins silencioso).
--
-- Com a coluna `rev`, o app grava com "update ... where rev = <última vista>":
-- se outro aparelho gravou antes, o update não casa, o app detecta o conflito
-- e MESCLA os arrays por id em vez de sobrescrever. Sem esta coluna o app
-- continua funcionando no modo antigo (upsert simples).
-- ============================================================

alter table public.app_data add column if not exists rev bigint not null default 0;

-- Pronto. O app detecta a coluna sozinho — nenhuma outra mudança necessária.
