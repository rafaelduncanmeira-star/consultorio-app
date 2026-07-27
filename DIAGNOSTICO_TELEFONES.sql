-- ============================================================
-- DIAGNOSTICO_TELEFONES.sql — SÓ LEITURA. Nenhum UPDATE, nenhum DELETE.
--
-- Pode rodar sem medo: são apenas SELECTs. Serve pra você VER se as falhas de
-- telefone corrigidas nesta revisão deixaram dado torto no seu banco, e quanto.
-- Depois de olhar, você decide se vale corrigir — e aí eu escrevo o script de
-- correção, que você roda separado.
--
-- Rode no SQL Editor do Supabase logado com a SUA conta (o RLS limita tudo ao
-- que é seu). Pode rodar o arquivo inteiro de uma vez.
--
-- ------------------------------------------------------------
-- AS FALHAS, E O QUE CADA UMA DEIXOU PRA TRÁS
--
-- 1) IMPORTAÇÃO DE PLANILHA (corrigido em d744fb1) — deixa dado torto.
--    Normalizava com `slice(-11)`: "pegue os últimos 11 dígitos". Só vale pra
--    celular. Fixo com código do país tem 12 dígitos (55 + DDD + 8), e cortar
--    os últimos 11 come só o primeiro dígito do DDI:
--        55 11 3333-4444  →  gravado 51133334444   (sobrou um 5 na frente)
--    O app lê isso como DDD 51 e o botão de WhatsApp abre conversa com número
--    de outro estado.
--
--    Como as consultas identificam: 11 dígitos, começando com 5, cujo TERCEIRO
--    dígito não é 9. Celular brasileiro legítimo de 11 dígitos é sempre
--    DDD + 9xxxxxxxx — o 9 na 3ª posição é o que separa o número correto do
--    corrompido. "55987654321" (celular de Santa Maria) fica de fora, como deve.
--
-- 2) ENVIO PELA CLOUD API (corrigido em c71fff9) — NÃO deixa dado torto.
--    O número no banco está certo; quem saía errado era o destinatário do
--    envio. Só afeta quem usa a WhatsApp Cloud API (Meta). A consulta 3 lista
--    quem pode não ter recebido lembrete até agora.
--
-- 3) CHAVE DA CONVERSA NO WEBHOOK (corrigido em c1383e0) — deixa dado torto.
--    Mensagem de paciente do DDD 55 que escreveu sem o código do país ficava
--    gravada sob uma chave que o app não procura: o chat abre vazio no CRM.
-- ============================================================


-- ------------------------------------------------------------
-- 1) ATENDIMENTOS, CRM e AGENDA: telefone com cara de "fixo importado torto"
--    Vazio = a falha 1 não te afetou.
-- ------------------------------------------------------------
with ddds(cod) as (values
  ('11'),('12'),('13'),('14'),('15'),('16'),('17'),('18'),('19'),
  ('21'),('22'),('24'),('27'),('28'),
  ('31'),('32'),('33'),('34'),('35'),('37'),('38'),
  ('41'),('42'),('43'),('44'),('45'),('46'),('47'),('48'),('49'),
  ('51'),('53'),('54'),('55'),
  ('61'),('62'),('63'),('64'),('65'),('66'),('67'),('68'),('69'),
  ('71'),('73'),('74'),('75'),('77'),('79'),
  ('81'),('82'),('83'),('84'),('85'),('86'),('87'),('88'),('89'),
  ('91'),('92'),('93'),('94'),('95'),('96'),('97'),('98'),('99')
),
fones as (
  select 'atendimento' as origem, data->>'nome' as pessoa,
         data->>'whatsapp' as gravado, data->>'data' as quando,
         regexp_replace(coalesce(data->>'whatsapp',''), '\D', '', 'g') as so_digitos
    from clinica_atendimentos where owner_id = auth.uid()
  union all
  select 'crm', data->>'nome', data->>'whatsapp', data->>'data',
         regexp_replace(coalesce(data->>'whatsapp',''), '\D', '', 'g')
    from clinica_crm where owner_id = auth.uid()
  union all
  select 'agendamento', data->>'pacienteNome', data->>'whatsapp', data->>'data',
         regexp_replace(coalesce(data->>'whatsapp',''), '\D', '', 'g')
    from clinica_agendamentos where owner_id = auth.uid()
)
select origem, pessoa, gravado,
       substr(so_digitos, 2) as provavel_correto,   -- basta tirar o 5 da frente
       quando
  from fones
 where so_digitos ~ '^5[0-9]{10}$'
   and substr(so_digitos, 3, 1) <> '9'              -- celular legítimo tem 9 aqui
   and substr(so_digitos, 2, 2) in (select cod from ddds)
 order by origem, quando desc nulls last;


-- ------------------------------------------------------------
-- 2) Só a contagem, se a lista acima vier grande
-- ------------------------------------------------------------
with ddds(cod) as (values
  ('11'),('12'),('13'),('14'),('15'),('16'),('17'),('18'),('19'),
  ('21'),('22'),('24'),('27'),('28'),
  ('31'),('32'),('33'),('34'),('35'),('37'),('38'),
  ('41'),('42'),('43'),('44'),('45'),('46'),('47'),('48'),('49'),
  ('51'),('53'),('54'),('55'),
  ('61'),('62'),('63'),('64'),('65'),('66'),('67'),('68'),('69'),
  ('71'),('73'),('74'),('75'),('77'),('79'),
  ('81'),('82'),('83'),('84'),('85'),('86'),('87'),('88'),('89'),
  ('91'),('92'),('93'),('94'),('95'),('96'),('97'),('98'),('99')
)
select 'atendimentos' as tabela, count(*) as suspeitos from clinica_atendimentos
 where owner_id = auth.uid()
   and regexp_replace(coalesce(data->>'whatsapp',''), '\D', '', 'g') ~ '^5[0-9]{10}$'
   and substr(regexp_replace(data->>'whatsapp', '\D', '', 'g'), 3, 1) <> '9'
   and substr(regexp_replace(data->>'whatsapp', '\D', '', 'g'), 2, 2) in (select cod from ddds)
union all
select 'crm', count(*) from clinica_crm
 where owner_id = auth.uid()
   and regexp_replace(coalesce(data->>'whatsapp',''), '\D', '', 'g') ~ '^5[0-9]{10}$'
   and substr(regexp_replace(data->>'whatsapp', '\D', '', 'g'), 3, 1) <> '9'
   and substr(regexp_replace(data->>'whatsapp', '\D', '', 'g'), 2, 2) in (select cod from ddds)
union all
select 'agendamentos', count(*) from clinica_agendamentos
 where owner_id = auth.uid()
   and regexp_replace(coalesce(data->>'whatsapp',''), '\D', '', 'g') ~ '^5[0-9]{10}$'
   and substr(regexp_replace(data->>'whatsapp', '\D', '', 'g'), 3, 1) <> '9'
   and substr(regexp_replace(data->>'whatsapp', '\D', '', 'g'), 2, 2) in (select cod from ddds);


-- ------------------------------------------------------------
-- 3) Pacientes do DDD 55 (Santa Maria/RS e região)
--    O número aqui está CERTO. Isto é só pra você saber quem NÃO recebeu
--    lembrete automático até agora — e só vale se você usa a Cloud API (Meta).
--    Quem usa Z-API não foi afetado: aquele caminho já normalizava certo.
-- ------------------------------------------------------------
select 'atendimento' as origem, data->>'nome' as paciente, data->>'whatsapp' as telefone
  from clinica_atendimentos
 where owner_id = auth.uid()
   and regexp_replace(coalesce(data->>'whatsapp',''), '\D', '', 'g') ~ '^55[0-9]{8,9}$'
union
select 'crm', data->>'nome', data->>'whatsapp'
  from clinica_crm
 where owner_id = auth.uid()
   and regexp_replace(coalesce(data->>'whatsapp',''), '\D', '', 'g') ~ '^55[0-9]{8,9}$';


-- ------------------------------------------------------------
-- 4) Conversas gravadas sob chave truncada (falha 3).
--    9 dígitos começando com 9 é curto demais pra ser telefone completo —
--    é o que sobrava quando o webhook comia o DDD 55 achando que era DDI.
--    Essas conversas existem no banco mas o chat do CRM abre vazio.
-- ------------------------------------------------------------
select whatsapp as chave_truncada, count(*) as mensagens,
       min(created_at) as primeira, max(created_at) as ultima
  from crm_messages
 where user_id = auth.uid()
   and whatsapp ~ '^9[0-9]{8}$'
 group by whatsapp
 order by ultima desc;


-- ============================================================
-- Tudo vazio = seu histórico está limpo, as correções valem daqui pra frente
-- e não há nada a fazer.
--
-- Veio linha em 1 ou 4? Me diga quantas e de qual consulta que eu escrevo o
-- UPDATE correspondente — comentado, pra você conferir linha a linha antes de
-- rodar. Não vou aplicar nada sozinho.
-- ============================================================
