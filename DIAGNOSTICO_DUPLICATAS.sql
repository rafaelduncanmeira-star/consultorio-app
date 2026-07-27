-- ============================================================================
-- DIAGNÓSTICO — atendimentos duplicados vindos da agenda
-- ============================================================================
--
-- SOMENTE LEITURA. Nenhum SELECT abaixo altera, apaga ou cria qualquer coisa.
-- Pode rodar no horário que quiser, com o app aberto, sem risco.
--
-- POR QUE ESTE DIAGNÓSTICO EXISTE
--
-- Havia um bug no app: ao marcar um agendamento como "Compareceu", ele oferece
-- registrar o atendimento. Depois de registrado, não deveria oferecer de novo.
-- Mas o atendimento novo entra na lista pelo TOPO — no índice 0 — e o app
-- checava o vínculo com `!pacIdx`. Zero é "falso" em JavaScript, então a checagem
-- nunca reconhecia a conversão que ela mesma tinha acabado de gravar.
--
-- Resultado: toda vez que aquele agendamento fosse aberto ou tivesse o status
-- remarcado, o app perguntava de novo "Fulano compareceu — registrar o
-- atendimento agora?". Cada "sim" criava OUTRO atendimento do mesmo paciente,
-- no mesmo dia, pelo mesmo valor.
--
-- O bug já está corrigido no app (o vínculo agora é pelo id estável, não pelo
-- índice). Mas as duplicatas que ele já criou continuam no banco, inflando
-- faturamento, contagem de consultas e ticket médio. Este diagnóstico mostra
-- quais são. NÃO apaga nada — a decisão sobre o que fazer é sua, e eu não
-- consigo distinguir sozinho uma duplicata de um atendimento legítimo repetido
-- (paciente que voltou no mesmo dia, procedimento em duas sessões etc.).
--
-- COMO RODAR: SQL Editor do Supabase → cole tudo → Run. São quatro consultas;
-- o painel mostra o resultado de cada uma. Me mande o que aparecer.
-- ============================================================================


-- ── 1. Grupos suspeitos: mesmo paciente, mesma data, mesmo procedimento ──────
-- Duas ou mais linhas iguais nesses três campos é o formato exato que o bug
-- produzia. Ordenado pelo dinheiro em jogo, do maior pro menor.
select
  a.data->>'nome'         as paciente,
  a.data->>'data'         as data_atendimento,
  a.data->>'procedimento' as procedimento,
  count(*)                as vezes,
  round(sum((a.data->>'valor')::numeric), 2)                       as soma_lancada,
  round(max((a.data->>'valor')::numeric), 2)                       as valor_de_uma_so,
  round(sum((a.data->>'valor')::numeric)
        - max((a.data->>'valor')::numeric), 2)                     as excesso_se_for_duplicata,
  string_agg(a.id, ' | ' order by a.data->>'criadoEm' nulls last)  as ids
from clinica_atendimentos a
where a.data->>'nome' is not null
  and a.data->>'data' is not null
group by 1, 2, 3
having count(*) > 1
order by 7 desc nulls last, 4 desc;


-- ── 2. Quanto isso representa no total ──────────────────────────────────────
-- Se "excesso_total" for perto de zero, não há o que fazer: siga a vida.
with grupos as (
  select
    count(*) as vezes,
    sum((a.data->>'valor')::numeric) as soma,
    max((a.data->>'valor')::numeric) as um_so
  from clinica_atendimentos a
  where a.data->>'nome' is not null and a.data->>'data' is not null
  group by a.data->>'nome', a.data->>'data', a.data->>'procedimento'
  having count(*) > 1
)
select
  count(*)                                as grupos_suspeitos,
  coalesce(sum(vezes - 1), 0)             as linhas_a_mais,
  round(coalesce(sum(soma - um_so), 0), 2) as excesso_total_em_reais
from grupos;


-- ── 3. As duplicatas vieram mesmo da agenda? ────────────────────────────────
-- O caminho do bug passa pelo agendamento. Se o par (paciente, data) tem mais
-- atendimentos do que agendamentos, o excesso saiu de um "sim" repetido.
-- Se esta consulta vier vazia e a nº 1 não, o excesso tem outra origem
-- (importação de planilha rodada duas vezes, por exemplo) — me avise.
select
  at.paciente,
  at.dia,
  at.qtd_atendimentos,
  coalesce(ag.qtd_agendamentos, 0) as qtd_agendamentos,
  at.qtd_atendimentos - coalesce(ag.qtd_agendamentos, 0) as sobra
from (
  select data->>'nome' as paciente, data->>'data' as dia, count(*) as qtd_atendimentos
  from clinica_atendimentos
  where data->>'nome' is not null and data->>'data' is not null
  group by 1, 2 having count(*) > 1
) at
left join (
  select data->>'pacienteNome' as paciente, data->>'data' as dia, count(*) as qtd_agendamentos
  from clinica_agendamentos
  where data->>'status' = 'Compareceu'
  group by 1, 2
) ag on ag.paciente = at.paciente and ag.dia = at.dia
where at.qtd_atendimentos > coalesce(ag.qtd_agendamentos, 0)
order by 5 desc, 3 desc;


-- ── 4. Agendamentos com vínculo pelo índice zero ────────────────────────────
-- Esta é a assinatura do bug: agendamento "Compareceu" com pacIdx = 0. Enquanto
-- o app antigo estivesse rodando, cada um destes podia gerar mais uma duplicata
-- a qualquer momento. Depois da correção publicada, não gera mais — mas o
-- número aqui indica quantos agendamentos ficaram expostos.
select
  count(*) filter (where data->>'pacIdx' = '0')                        as com_indice_zero,
  count(*) filter (where data->>'pacId' is not null)                   as ja_com_vinculo_por_id,
  count(*) filter (where data->>'pacId' is null
                     and data->>'pacIdx' is null)                      as sem_vinculo_nenhum,
  count(*)                                                             as total_compareceu
from clinica_agendamentos
where data->>'status' = 'Compareceu';
