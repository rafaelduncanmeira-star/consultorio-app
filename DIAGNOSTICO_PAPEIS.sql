-- ============================================================
-- DIAGNOSTICO_PAPEIS.sql — SÓ LEITURA. Nenhum UPDATE, nenhum DELETE.
--
-- Serve pra conferir se a falha corrigida em 67a524c deixou algum papel errado
-- gravado no banco. Rode no SQL Editor do Supabase logado com a SUA conta.
--
-- ------------------------------------------------------------
-- A FALHA
--
-- Nos dois caminhos de login, o app lia o perfil assim:
--
--     const { data: profile } = await _supa.from('profiles')...single();
--     if (!profile) { ...primeiro login... }
--
-- com o `error` descartado. Uma falha de leitura (rede, timeout) ficava
-- indistinguível de "esse usuário ainda não tem perfil" — e o ramo de primeiro
-- login pega o papel do `user_metadata`, que o próprio usuário controla, com
-- padrão **'medico'** quando o metadata não diz nada. Pior: ele faz um upsert,
-- gravando esse papel por cima do perfil real.
--
-- Ou seja: uma secretária que pegou rede ruim no login pode ter virado médica
-- no banco, de forma permanente. A correção impede que aconteça de novo, mas
-- não desfaz o que já foi gravado — daí este arquivo.
--
-- O que procurar: alguém marcado como 'medico' em `profiles` que, na prática,
-- é secretária ou profissional da sua equipe. Só VOCÊ sabe quem é quem; as
-- consultas abaixo colocam os dados lado a lado pra facilitar.
-- ============================================================


-- ------------------------------------------------------------
-- 1) SUA EQUIPE: papel na equipe × papel da conta × o que o metadata diz
--
--    A coluna `papel_conta` é o que o app usa pra liberar telas quando a pessoa
--    NÃO está atuando como membro. `papel_na_equipe` é o que você escolheu ao
--    convidar. `metadata_role` é o que o usuário tem no próprio cadastro —
--    é dele que o papel errado teria vindo.
--
--    ⚠️ Divergência entre as duas primeiras colunas não é necessariamente erro:
--    quem tem clínica própria E é membro da sua legitimamente tem papéis
--    diferentes nos dois lugares. O que merece atenção é `papel_conta = medico`
--    em quem você convidou como secretária ou profissional.
-- ------------------------------------------------------------
select
  tm.member_id,
  p.nome                         as pessoa,
  u.email,
  tm.role                        as papel_na_equipe,
  p.role                         as papel_conta,
  u.raw_user_meta_data->>'role'  as metadata_role,
  tm.created_at                  as entrou_em,
  case
    when p.role = 'medico' and tm.role in ('secretaria', 'profissional')
      then '<<< CONFERIR'
    else ''
  end                            as alerta
from team_members tm
left join profiles   p on p.id = tm.member_id
left join auth.users u on u.id = tm.member_id
where tm.owner_id = auth.uid()
order by alerta desc, tm.created_at;


-- ------------------------------------------------------------
-- 2) O SEU PRÓPRIO perfil — confira que continua como você espera
-- ------------------------------------------------------------
select p.nome, p.role as papel_conta,
       u.raw_user_meta_data->>'role' as metadata_role,
       u.created_at as conta_criada_em
  from profiles p
  join auth.users u on u.id = p.id
 where p.id = auth.uid();


-- ------------------------------------------------------------
-- 3) Perfil cujo papel BATE exatamente com o metadata
--
--    Sinal fraco, não prova nada — muita gente tem os dois iguais de forma
--    legítima, porque o perfil nasce do metadata no primeiro login de verdade.
--    Vale como lista de conferência quando a consulta 1 não deixar claro.
-- ------------------------------------------------------------
select p.nome, u.email, p.role as papel_conta,
       u.raw_user_meta_data->>'role' as metadata_role
  from team_members tm
  join profiles   p on p.id = tm.member_id
  join auth.users u on u.id = tm.member_id
 where tm.owner_id = auth.uid()
   and p.role is not distinct from (u.raw_user_meta_data->>'role');


-- ============================================================
-- SE ACHAR ALGUÉM COM O PAPEL ERRADO
--
-- Não escrevi o UPDATE aqui de propósito: mudar papel é mudar quem enxerga o
-- financeiro e os dados dos pacientes, e eu não sei quem é quem na sua equipe.
-- Me diga o e-mail e o papel correto de cada pessoa que eu escrevo o comando,
-- comentado, pra você conferir antes de rodar.
--
-- Dá também pra corrigir pela interface, sem SQL: remova a pessoa da equipe na
-- tela de Equipe e convide de novo com o papel certo. O convite grava o papel
-- na equipe, que é o que manda enquanto ela estiver atuando como membro.
-- ============================================================
