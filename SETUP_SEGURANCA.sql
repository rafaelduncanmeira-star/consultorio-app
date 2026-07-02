-- ============================================================
-- SETUP SEGURANÇA — rodar no SQL Editor do Supabase (idempotente)
-- Fecha os vazamentos encontrados na auditoria de segurança:
--
--  1. SNAPSHOTS (chaves app_data '_snapshot_%') continham TODOS os dados da
--     clínica (pacientes + finanças + chaves de API) e eram legíveis por
--     qualquer membro da equipe — furando a blindagem por RLS.
--     → Agora: só o DONO lê/escreve snapshots.
--
--  2. SEGREDOS DE INTEGRAÇÃO (zapi_config, wa_cloud_config, llm_config,
--     gemini_key_secure) eram legíveis por qualquer membro, inclusive
--     profissionais.
--     → Agora: dono + secretária/médico da equipe (a secretária precisa das
--       credenciais pra enviar WhatsApp pelo chat — o envio é feito no
--       navegador). PROFISSIONAL não lê mais.
--
--  3. DELETE em app_data era permitido a qualquer membro ("limpar todos os
--     dados" apagava a clínica inteira a partir da conta de um membro).
--     → Agora: só o DONO deleta.
--
-- Obs.: melhoria futura recomendada — mover o envio de WhatsApp para uma
-- Edge Function e tirar os segredos do navegador por completo.
-- ============================================================

-- ----- APP_DATA: substitui as policies da equipe por versões restritas -----
drop policy if exists "team read app_data"   on app_data;
drop policy if exists "team insert app_data" on app_data;
drop policy if exists "team update app_data" on app_data;
drop policy if exists "team delete app_data" on app_data;

-- Chaves que só o dono (e, para segredos, a secretária) podem tocar:
--   snapshots: '_snapshot_%'   segredos: lista fixa abaixo.

create policy "team read app_data" on app_data for select to authenticated using (
  auth.uid() = user_id
  OR (
    -- membro da equipe lê os dados do dono…
    user_id IN (select owner_id from team_members where member_id = auth.uid())
    -- …exceto snapshots (contêm TUDO, inclusive finanças)
    AND key NOT LIKE '\_snapshot\_%'
    -- …e segredos só para secretária/médico (profissional fica de fora)
    AND (
      key NOT IN ('zapi_config','wa_cloud_config','llm_config','gemini_key_secure')
      OR user_id IN (select owner_id from team_members
                     where member_id = auth.uid() and role in ('secretaria','medico'))
    )
  )
);

create policy "team insert app_data" on app_data for insert to authenticated with check (
  auth.uid() = user_id
  OR (
    user_id IN (select owner_id from team_members where member_id = auth.uid())
    AND key NOT LIKE '\_snapshot\_%'
    AND key NOT IN ('zapi_config','wa_cloud_config','llm_config','gemini_key_secure')
  )
);

create policy "team update app_data" on app_data for update to authenticated using (
  auth.uid() = user_id
  OR (
    user_id IN (select owner_id from team_members where member_id = auth.uid())
    AND key NOT LIKE '\_snapshot\_%'
    AND key NOT IN ('zapi_config','wa_cloud_config','llm_config','gemini_key_secure')
  )
) with check (
  auth.uid() = user_id
  OR (
    user_id IN (select owner_id from team_members where member_id = auth.uid())
    AND key NOT LIKE '\_snapshot\_%'
    AND key NOT IN ('zapi_config','wa_cloud_config','llm_config','gemini_key_secure')
  )
);

-- DELETE: só o dono. ("Limpar todos os dados" numa conta de membro não pode
-- apagar a clínica inteira.)
create policy "team delete app_data" on app_data for delete to authenticated using (
  auth.uid() = user_id
);
