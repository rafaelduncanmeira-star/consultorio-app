-- ============================================================
-- SETUP_LGPD_CRM.sql — fecha dois buracos de RLS nas conversas
-- Rode no SQL Editor do Supabase. Idempotente.
--
-- ⚠️ ORDEM IMPORTA. Rode DEPOIS de:
--      SETUP_SUPABASE.sql → SETUP_EQUIPE.sql → SETUP_EQUIPE_PROFISSIONAL.sql
--      → SETUP_CRM_PROFISSIONAL.sql → SETUP_SEGURANCA.sql
--    Se um dia você re-rodar o SETUP_EQUIPE.sql, ele derruba as policies
--    daqui (dá `drop policy` nos mesmos nomes) — rode este arquivo de novo.
-- ============================================================
--
-- BURACO 1 — qualquer pessoa podia forjar conversa em qualquer clínica.
--
--   SETUP_SUPABASE.sql:87 e :120 criam, pro papel `anon`:
--       with check (user_id is not null)
--   Só isso. A chave `anon` está no JavaScript do app (é pública, por design),
--   então qualquer um a copia, escolhe um user_id de outra clínica e insere
--   lead e mensagem lá dentro. Além do lixo, isso envenena o histórico que a
--   secretária de IA lê antes de responder — dá pra escrever a conversa que o
--   LLM vai usar como contexto.
--
--   Essas policies não são mais necessárias: o wa-webhook usa
--   SUPABASE_SERVICE_ROLE_KEY (index.ts:84), que ignora RLS.
--
--   ❗ ANTES DE RODAR, confirme: você ainda tem algum cenário do Make, Zapier
--      ou Z-API gravando DIRETO em crm_leads/crm_messages com a chave anon,
--      sem passar pelo wa-webhook? Se tiver, ele vai parar de gravar. Se toda
--      a entrada passa pelo webhook (é o caso hoje), pode rodar tranquilo.
--
-- BURACO 2 — profissional lia TODAS as conversas da clínica.
--
--   SETUP_EQUIPE.sql:202 libera crm_messages pra qualquer membro da equipe,
--   sem nenhuma cláusula de profissional_id. Um profissional contratado lê a
--   conversa de todos os pacientes do consultório, inclusive os que não são
--   dele. É dado de saúde: art. 11 da LGPD.
--
--   crm_leads JÁ tem profissional_id (SETUP_CRM_PROFISSIONAL.sql), preenchido
--   pelo webhook quando a URL traz &prof=<id>. crm_messages não tem — o vínculo
--   é feito pelo telefone.
--
--   ⚠️ MUDANÇA DE COMPORTAMENTO, leia antes de rodar:
--      · Profissional passa a ver só os contatos roteados pra ele.
--      · Lead SEM profissional_id (número geral da clínica, contato criado à
--        mão) fica invisível pro profissional. Médico e secretária continuam
--        vendo tudo.
--      · Profissional cujo convite não definiu qual profissional ele é
--        (team_members.profissional_id nulo) não vê NENHUMA conversa. Se algum
--        membro seu está nesse estado, corrija o cadastro dele antes — dá pra
--        conferir com a consulta de diagnóstico no fim deste arquivo.
--
--   Nota de desempenho: a policy de crm_messages casa o telefone com
--   regexp_replace (o webhook grava o lead COM DDI 55 e a mensagem SEM), o que
--   impede o uso do índice. Em consultório pequeno não pesa; se um dia a caixa
--   passar de dezenas de milhares de mensagens, o certo é criar uma coluna
--   profissional_id em crm_messages e preencher no webhook.
-- ============================================================


-- ------------------------------------------------------------
-- 1) Fecha a porta do `anon`
-- ------------------------------------------------------------
drop policy if exists "anon insert with user_id"     on crm_leads;
drop policy if exists "anon insert crm_leads"        on crm_leads;
drop policy if exists "anon insert with user_id msg" on crm_messages;
drop policy if exists "anon insert crm_messages"     on crm_messages;


-- ------------------------------------------------------------
-- 2) CRM_LEADS — profissional só enxerga o que é dele
-- ------------------------------------------------------------
drop policy if exists "auth select own crm_leads" on crm_leads;
drop policy if exists "auth update own crm_leads" on crm_leads;
drop policy if exists "team select crm_leads"     on crm_leads;
drop policy if exists "team update crm_leads"     on crm_leads;

create policy "team select crm_leads" on crm_leads for select to authenticated using (
  auth.uid() = user_id
  OR exists (
    select 1 from team_members tm
     where tm.member_id = auth.uid()
       and tm.owner_id  = crm_leads.user_id
       and (
         tm.role in ('medico', 'secretaria')
         OR (tm.role = 'profissional'
             and tm.profissional_id is not null
             and crm_leads.profissional_id = tm.profissional_id)
       )
  )
);

create policy "team update crm_leads" on crm_leads for update to authenticated using (
  auth.uid() = user_id
  OR exists (
    select 1 from team_members tm
     where tm.member_id = auth.uid()
       and tm.owner_id  = crm_leads.user_id
       and (
         tm.role in ('medico', 'secretaria')
         OR (tm.role = 'profissional'
             and tm.profissional_id is not null
             and crm_leads.profissional_id = tm.profissional_id)
       )
  )
);


-- ------------------------------------------------------------
-- 3) CRM_MESSAGES — mesma regra, vinculada pelo telefone
--    (lead grava COM DDI 55, mensagem grava SEM — normaliza os dois lados)
-- ------------------------------------------------------------
drop policy if exists "auth select own crm_messages" on crm_messages;
drop policy if exists "auth insert own crm_messages" on crm_messages;
drop policy if exists "team select crm_messages"     on crm_messages;
drop policy if exists "team insert crm_messages"     on crm_messages;

create policy "team select crm_messages" on crm_messages for select to authenticated using (
  auth.uid() = user_id
  OR exists (
    select 1 from team_members tm
     where tm.member_id = auth.uid()
       and tm.owner_id  = crm_messages.user_id
       and (
         tm.role in ('medico', 'secretaria')
         OR (tm.role = 'profissional'
             and tm.profissional_id is not null
             and exists (
               select 1 from crm_leads l
                where l.user_id = crm_messages.user_id
                  and l.profissional_id = tm.profissional_id
                  and regexp_replace(l.whatsapp,          '^55', '')
                    = regexp_replace(crm_messages.whatsapp, '^55', '')
             ))
       )
  )
);

create policy "team insert crm_messages" on crm_messages for insert to authenticated with check (
  auth.uid() = user_id
  OR exists (
    select 1 from team_members tm
     where tm.member_id = auth.uid()
       and tm.owner_id  = crm_messages.user_id
       and (
         tm.role in ('medico', 'secretaria')
         OR (tm.role = 'profissional'
             and tm.profissional_id is not null
             and exists (
               select 1 from crm_leads l
                where l.user_id = crm_messages.user_id
                  and l.profissional_id = tm.profissional_id
                  and regexp_replace(l.whatsapp,          '^55', '')
                    = regexp_replace(crm_messages.whatsapp, '^55', '')
             ))
       )
  )
);


-- ============================================================
-- DIAGNÓSTICO — rode ANTES pra saber o que vai mudar na prática
-- ============================================================

-- (a) Algum profissional da sua equipe está sem profissional_id?
--     Os que aparecerem aqui vão parar de ver conversa nenhuma.
--
--   select member_id, role, profissional_id
--     from team_members
--    where owner_id = auth.uid() and role = 'profissional'
--      and profissional_id is null;

-- (b) Quantos contatos NÃO estão roteados pra ninguém? Esses ficam visíveis
--     só pra você e pra secretária.
--
--   select count(*) filter (where profissional_id is null) as sem_rota,
--          count(*)                                        as total
--     from crm_leads where user_id = auth.uid();

-- ============================================================
-- ✅ PRONTO
-- ============================================================
