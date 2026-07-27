# CLAUDE.md — orientação para sessões de agente

Complementa (não substitui) os documentos do projeto:

- **`ESTADO_ATUAL.md`** — histórico, o que está pronto, mapa do `app.js`. **Leia antes de mexer.**
- **`BRIEF_V2.md`** — roadmap de produto (V1 = gestão · V2 = camada de IA).

---

## O que é

**Maestria de Consultório** — SPA de gestão de consultório médico. Agenda, pacientes,
CRM de WhatsApp, financeiro, programas/assinaturas e uma "secretária por IA".

| | |
|---|---|
| Stack | HTML + JS puro, **sem build**. `index.html` + `app.js` (~13k linhas) |
| Backend | Supabase (projeto `ipvztcqlawwslnkzmzzl`), RLS + Edge Functions |
| Deploy | Vercel estático — **todo push publica** |
| Testes | `node --test` (nativo, sem dependências) — ver `tests/README.md` |

---

## Regras duras

- **NUNCA criar `package.json` na raiz.** A Vercel tentaria buildar e quebraria o deploy.
- Rodar `node --check app.js` e `node --test` **antes de commitar**. Sempre.
- Branch de trabalho: **`claude/app-status-check-wf5vkj`**.
- Os `SETUP_*.sql` são rodados **à mão** pelo usuário no SQL Editor do Supabase.
  Se criar/alterar tabela ou policy, **avise explicitamente** — não presuma que rodou.
- Edge Function `supabase/functions/wa-webhook/index.ts` — deploy pelo painel, *Verify JWT* desligado.
  **Corrigir o arquivo NÃO coloca a correção no ar.** Ao mexer nele: suba o
  `WEBHOOK_VERSAO` (há teste que reprova se esquecer) e **avise o usuário que precisa
  republicar**. Pra conferir o que está rodando, abra a URL do webhook no navegador —
  ela responde `wa-webhook ativo · versao AAAA-MM-DD`.

---

## Decisões de domínio (ditadas pelo médico — não reinterpretar)

- **Paciente novo** = pessoa que **nunca foi atendida antes** pelo consultório.
  Implementado em `_novosNoMes(pacs, mes)`: o *primeiro* atendimento da pessoa cai no mês.
- **Consulta** = atendimento que **paga**. **Retorno** = atendimento que **não paga**
  (o procedimento `Retorno` nasce com `valorPix: 0`, `valorCartao: 0`).
- **Ticket médio tem duas leituras** e as duas são mostradas (`_ticketMedio`):
  `porConsultaPaga` (preço praticado, só `valor > 0`) e `porAtendimento` (divide por tudo).
  A segunda só aparece na tela quando existe atendimento gratuito no período.

---

## Invariantes do código

Estabelecidos na revisão de ponta a ponta — quebrar qualquer um destes reintroduz bug conhecido.

- **Status de pagamento canônicos: `Pago` · `Parcial` · `Pendente` · `Isento`.**
  Nada mais. `Parcial` é gravado por toda inscrição parcelada em programa.
  (`Parcelado` é outra coisa: forma de pagamento de programa, não status.)
- **`_resumoFin(pacs)` é a fonte única** de recebido / a receber / faturado / bruto.
  Toda tela financeira usa ela. Regra de ouro: `recebido + aReceber + isento` **fecha com
  `bruto` ao centavo** — não bit a bit. Os baldes saem arredondados (`_centavos`), mas somar
  três floats fora da função sempre pode deixar resíduo na casa de 1e-13. Teste de dinheiro
  compara **ao centavo**; exigir `===` é exigir o impossível e o teste vira teatro.
  Nunca recalcular "a receber" filtrando só `Pendente` — some o `Parcial`.
- **Regimes:** caixa = `recebido`; competência = `faturado`. Lucro na tela = caixa − despesas.
- **`supabase-js` NÃO lança em erro de banco** (RLS, constraint) — devolve `{ error }`.
  Checar **sempre**. Gravação rejeitada passando por sucesso já causou perda total de coleção.
- **Nunca apagar dado com base em array local vazio.** Local vazio ≠ "não há o que salvar":
  pode ser aparelho novo, pós-logout ou pull que falhou.
- **XSS:** `_esc()` para qualquer dado em `innerHTML`; **`_jsArg()`** (não `encodeURIComponent`)
  para argumento dentro de `onclick` — `encodeURIComponent` não escapa aspa simples.
  Nome de contato vem do perfil do WhatsApp, ou seja: é entrada de terceiro não confiável.

---

## Backlog aberto da revisão

~43 achados verificados; ~27 corrigidos (commits `2a8686a` → `HEAD`). **Restam ~16.**

### Grupo A — ✅ concluído

Sync / integridade de dados. Os 8 achados foram corrigidos — o que **fica valendo
como invariante** (quebrar reintroduz o bug):

1. **`_pushBlindada` envia em lotes de 200 e o lote não é tudo-ou-nada.** Lote reprovado
   → reenvia linha a linha; a linha que o servidor recusa vai pra `consult__quarentena`
   com o registro inteiro (**nada some por causa de uma rejeição**).
   `_rowBlindada` carimba `profissional_id` quando quem grava é profissional — era a
   causa raiz da recusa.
2. **Outbox tem teto (`_OUTBOX_TETO`).** Passado o teto a entrada continua anotada mas
   **para de bloquear o pull** — senão o aparelho congela naquela coleção pra sempre.
   `online` zera o contador: falha de rede não gasta o orçamento reservado a RLS.
3. **`_lerTodasBlindada` pagina** (`.order('id')` + `.range()`, avançando pelo que voltou
   de fato). Sem isso o `max-rows` do PostgREST corta a resposta e o recorte é gravado
   por cima do localStorage.
4. **`DB.set` devolve `Promise<boolean>`.** Quem vai dar um passo **irreversível** depois
   de gravar (ex.: `syncLeadsFromSupabase` marcando `processado: true`) **tem de esperar**.
5. **Pushes são serializados por chave** (`_enfileirarPush`) — "excluir + desfazer" não
   pode ser confirmado fora de ordem. O `old` do diff é lido na chamada, não na execução.
6. **`logoutUser` drena o outbox antes de apagar o localStorage** e pergunta se sobrar
   algo não entregue.
7. **Anti-zeramento do `_pullBlindada`:** a auto-cura (re-armar a migração) só vale
   enquanto o aparelho **nunca** leu linha da tabela (`consult_<key>_msync`). Depois disso,
   pull vazio é exclusão real e é refletido — re-armar ali **ressuscitava** o que o
   usuário tinha apagado no outro aparelho.
8. **`_podeVerFinanceiro()` é o gate do financeiro na UI** (`_applyRole`, `showPage`,
   `_limparSensiveisProfissional`): só **médico DONO**. Médico *membro* também não entra —
   é o que o RLS já dizia, e a sidebar liberava a página pra ele lançar despesa que o
   servidor recusava calado.

### Achados NOVOS (fora do backlog original) — já corrigidos

Encontrados depois que o Grupo A fechou. Viraram invariante igual aos de cima.

- 🔴 **Dado do LLM entra normalizado ou não entra.** `executeAIAction` espalhava `dados`
  cru. `valor: "1.200,50"` (o formato que o médico dita) virava **string** no registro —
  e a soma de `_resumoFin` é `s + (p.valor || 0)`, que com string **concatena**:
  `"3001.200,50"`, cujo `_centavos` é `NaN`. Um atendimento zerava o financeiro inteiro.
  `parseFloat` não salva (para no primeiro ponto → `1.2`); use **`impNormValor`**.
  Status idem: fora do canônico o registro fica **fora de todos os baldes** e o dinheiro
  some dos relatórios. Em **UPDATE**, não caia no padrão — *recuse*: canonizar rebaixaria
  pra `Pendente` um atendimento já pago.
- **Mutação depois do `DB.set` não é gravada.** `DB.set` serializa um instantâneo; o push
  assíncrono carrega a referência viva. Mexer no registro depois deixa o aparelho sem o
  dado e o servidor, às vezes, com ele. Monte o registro **inteiro** antes de gravar.
- **Bloqueio de um dia só precisa de validação por HORA.** `dataFim < dataInicio` nunca
  dispara quando as datas são iguais: um bloqueio 14:00 → 09:00 era salvo, aparecia na
  lista e não barrava slot nenhum (a sobreposição é impossível com o fim antes do início).
- **Zero é um valor, não "vazio".** `!x.pacIdx` tratava o índice **0** como "sem vínculo" —
  e 0 é o caso *normal*, porque atendimento novo entra com `unshift`. O app reoferecia
  registrar o atendimento a cada toque no agendamento e **duplicava o faturamento**.
  Use `!= null`. Vale pra todo índice, e pra `valor` (Retorno nasce com `valor: 0`).
- **Índice nunca vira vínculo persistido.** `registros[].followupIdx` guardava a posição
  no array de follow-ups; o pull reescreve a coleção na ordem do servidor e qualquer
  exclusão recompacta o array. Registrar o marco marcava o follow-up de **outro paciente**.
  Vínculo é por `id` — e, pra dado legado, pelo par `(programaInscricaoId, marcoIdx)`.
- **`setMonth(getMonth() ± n)` transborda.** Em 31/jan, +1 mês vira "31 de fevereiro" =
  3 de março: a agenda pulava fevereiro. Ao contrário é pior — em 31/mar, −1 mês volta
  pra 3 de março e o botão parece morto. Use `_addMeses`, que ancora no dia 1.
- **`DB.set` carimba `id` nas coleções blindadas.** `_pushBlindada` filtra por id, então
  registro sem id não sobe. O `_migrarIds` só conserta no `cloudPull` (carga do app):
  até recarregar, o registro só existe naquele aparelho.
- **Data: nunca compare `'YYYY-MM-DD'` cru com `Date.now()`.** String sem hora é lida
  como meia-noite **UTC**; `Date.now()` é local. Em UTC-3 a conta já nasce 3h adiantada
  e vira o dia a partir das 21:00. Ancore os dois lados ao **meio-dia local**
  (`+ 'T12:00:00'`). Foi o que quebrava `_diasDesde` (todo card do Kanban envelhecia
  sozinho toda noite).
- **Nunca `toISOString()` pra extrair `YYYY-MM-DD` de um `Date`** — use `_ymd()`.
  Em fuso negativo o toISOString devolve o dia anterior.
- **`instanceof` antes de `String()`.** Em `impNormDate` o teste vinha depois da
  conversão, então nunca era verdade: `.xlsx` com coluna de data de verdade importava
  **zero linhas**, todas contadas como "sem data".
- **`impNormValor`: o separador da DIREITA é o decimal.** Tratar todo ponto como milhar
  fazia `"1234.56"` virar `123456` — e esse é o formato que o próprio `exportarCSV`
  grava, então exportar+reimportar inflava o faturamento em 100x.
- **Telefone: `_foneChat` (webhook) espelha `_normPhone` (app).** Tirar o `55` sem olhar
  o tamanho comia o DDD de quem é do DDD 55 e escreveu sem código do país — a conversa
  ficava numa chave que o app nunca procura e o chat abria vazio.
- **Bloqueio de agenda tem HORA, não só data** (`_isBloqueado` e o `bloqueado()` do
  webhook). O webhook olhava só a data e apagava o dia inteiro da disponibilidade da IA.
- 🔴 **`'texto'.includes('')` é sempre `true`.** Todo campo de texto opcional usado como
  filtro de busca vira **coringa universal** quando chega vazio. Apareceu em **5** lugares
  do copiloto, todos gravando no banco: registro sem nome casava com qualquer paciente, e
  `cancelar_agendamento`/`mover_agendamento` sem nome pegavam o **primeiro da agenda**.
  Busca por nome agora é só via **`_acharPorNome`** — exato, parcial por palavra inteira,
  e **-1 na dúvida** (inclusive homônimo). Nunca voltar a usar `findIndex` + `includes`.
- **Ação destrutiva que sai do app (mensagem, e-mail) grava a marca de "já fiz" ANTES do
  próximo item.** Guardar pro fim do laço perde tudo se o app fechar no meio — e
  `rodarCicloLembretes` dispara sozinho 5s depois de abrir, ~1s por paciente.
- **`_foneE164BR` é a única forma de montar o número pra Cloud API.** `startsWith('55')`
  sozinho confunde DDI com o DDD 55 e o lembrete ia pra outro estado. Quatro pontos usam a
  mesma regra hoje; um teste compara com o 1º candidato do Z-API número a número.
- **Migração não chuta dono.** `_migrarIds` roda a cada `cloudPull`; usar `_profDoPaciente`
  (que cai no profissional logado) fazia o primeiro a abrir o app levar pra si todos os
  registros sem dono — e o RLS some com eles pros outros. Use `_profDoPacienteEstrito`.
- **O prompt que o médico LÊ tem de ser o que o servidor MANDA.** O preview do app exibia
  "não confirme o agendamento" sempre, e o webhook não dizia nada sobre agendar quando
  `agendar` está desligado (o padrão) — a IA respondia "marquei!" sem marcar. Os textos
  são comparados literalmente em `tests/webhook.test.js`.
- ⚠️ **O `wa-webhook` é publicado à MÃO.** Corrigir o arquivo não põe nada no ar. Ao mexer:
  suba `WEBHOOK_VERSAO` (há teste) e **avise o usuário pra republicar**. Pra saber o que
  está rodando, abra a URL do webhook — ela responde `wa-webhook ativo · versao AAAA-MM-DD`.

#### 🔴 Padrão que mais rendeu: pergunta ao banco com o `error` descartado

`supabase-js` não lança — devolve `{ error }`. Em **toda** consulta que pergunta
*"quem é você"* ou *"o que você pode"*, descartar o erro faz a resposta vazia ser lida
como **permissão**. Quatro achados seguidos, todos deste mesmo formato:

- `listFactors()` falhando devolvia `{ ok: true }` → **login entrava sem 2FA**.
- `"tenho clínica própria?"` falhando → o **dono virava membro da clínica alheia**,
  gravando os registros novos lá dentro.
- perfil ilegível caía no ramo de "primeiro login" → papel vinha do `user_metadata`
  (que o usuário controla, padrão `'medico'`) e era **gravado por cima** do perfil.
- `listarMembros`/`listarConvites` devolvendo `[]` → tela dizia que a **equipe estava vazia**.

Regra: erro de leitura **nunca** é resposta negativa. Falhe fechado (barre, derrube a
sessão) ou devolva `null` como "não sei" — distinto de `[]`/`false`, que são respostas.
Com `.single()`, só **`PGRST116`** significa "não existe linha"; qualquer outro código é
falha de leitura.

#### Outras regras aprendidas

- **Ação irreversível espera confirmação da nuvem.** `importarJSON` recarregava a página
  num timer de 2s enquanto os pushes voavam; o pull seguinte trazia os dados velhos e o
  backup "restaurado" evaporava. `restaurarSnapshot` já esperava — quando duas funções
  fazem a mesma coisa de jeitos diferentes, **uma delas é o bug**. Esse sinal apareceu
  em quase todo achado desta série (Z-API × Cloud API, `_isBloqueado` × webhook,
  `renderStatus2FA` × portão de 2FA, `_normPhone` × importação).
- **Poda antes de gravar.** O snapshot gravava e só depois podava; uma vez cheio o
  `localStorage`, o `setItem` lançava, a poda nunca rodava e o backup automático parava
  **para sempre**, calado (o chamador não tinha `.catch`).
- **`opacity: 0` não desliga clique.** O toast ficava sobre a nav inferior do celular e
  matava o botão central. Elemento que some precisa de `pointer-events: none`.
- **SQL: `SETUP_EQUIPE.sql` sobrescreve policies que arquivos posteriores restringem.**
  O `accept_invite` dele já foi alinhado, mas as policies não — re-rodar sozinho reverte.
  A ordem completa está no cabeçalho do arquivo.
- **Ler → esperar o usuário → gravar o array velho.** `deleteRow`/`saveCrm`/
  `excluirInscricao`/`deleteProc` liam a coleção, abriam `confirm()`/`prompt()` (aberto o
  tempo que a pessoa levar) e gravavam o array de antes. O CRM recebe leads por realtime
  nesse intervalo: o lead sumia, e o push levava a exclusão pro servidor. **Releia depois
  do diálogo e reaplique por id.** Vale pra qualquer gap — diálogo ou `await`.
- **Vocabulário: `<select>` estático e lista canônica do JS têm de bater.** O select do
  modal não tinha `Parcial` (editar+salvar apagava o status, e o valor sumia de todos os
  baldes); o código comparava com `'Faltou'` mas a agenda grava `'No-show'` (o card do CRM
  nunca voltava pra "Não marcou"). `tests/vocabulario.test.js` guarda isso a cada rodada.
- **Campo que o código sabe que pode faltar tem de ser guardado em TODO lugar.** Se existe
  `x.campo || ''` num ponto, `x.campo.metodo()` em outro é bug esperando: um atendimento
  sem `data` derrubava a busca global inteira (`undefined.localeCompare`), e um sem `nome`
  abortava a importação de planilha antes da primeira linha. Use `_cmpDataDesc`/`_cmpDataAsc`.
- **`DB.getObj` NÃO mescla com o default** — só usa o default quando a chave não existe.
  Config parcial (backup antigo, arquivo editado) passava com buracos e `cfg.diasUteis
  .includes()` derrubava a agenda. `getAgConfig` agora mescla e valida o formato.
- **Atribuição a `.value` de `<select>` com opção inexistente** deixa `selectedIndex = -1`
  e o `FormData` devolve `''` no save — apaga o dado em silêncio.

#### Sobre os testes

- `node --test` roda 209 testes. **Rode também em outro fuso** quando mexer em data:
  `TZ=UTC node --test` — teste de fuso que só passa na máquina local não guarda nada.
- `tests/_extrair.js` — recorta funções do `app.js`. Aceita `const:NOME` pra constante
  e entende `async function`.
- `tests/_extrairTs.js` — recorta funções do `wa-webhook/index.ts` e deixa o Node fazer
  o type-stripping nativo (v22.6+). A agenda que a IA oferece ao paciente é calculada
  **lá**, não no `app.js`.
- **Armadilha do `node:vm`:** o sandbox tem realm próprio. `deepStrictEqual` reprova por
  protótipo (normalize com `JSON.parse(JSON.stringify(x))`) e `instanceof Date` dá falso
  se você não passar o **mesmo** `Date` nos globais.
- `tests/vocabulario.test.js` — varredura genérica: acusa comparação com literal que nada
  no app grava nem oferece na interface. Vocabulário externo entra em `LEGITIMAS`
  **com o motivo escrito**; um segundo teste reprova exceção que virou órfã.
- **Hábito que vale manter:** depois de corrigir, **reverta a versão antiga e confira que
  o teste novo reprova**. Já pegou teste meu que passava sem guardar nada — **cinco vezes**
  nesta série. Reverta com **`git stash push`**, nunca com `git checkout --`: uma vez usei
  o checkout num ponto sem nada pra restaurar e ele descartou o trabalho não commitado.
- Falso positivo pontual numa varredura entra na lista de exceções. **Nunca alargue o
  detector pra silenciá-lo** — tentei uma vez e o teste parou de acusar até os bugs reais.
- Teste que falha depois de mexer no `app.js` nem sempre é regressão: já foi o extrator do
  `_extrair.js` não dando conta (constante multilinha, `async function`) e realm do
  `node:vm`. Leia a mensagem antes de "consertar" o código.

### Grupo B — precisa de decisão do usuário

- **MRR tem duas fórmulas convivendo:** `renderProgramas` usa `valorTotal / vigência × 30`
  (o contratado); `_mrrDeInscricao` usa `precoAVista / dias × 30`. Programas e Dashboard
  mostram MRR diferente. **Qual é a canônica?**
- Cancelamento de assinatura não grava data → churn cai no mês errado e o MRR histórico
  é reescrito retroativamente. Precisa de campo `dataCancelamento`.
- Tabela "Mix de pagamento" — linhas somam menos que o próprio Total (programas não gravam
  `pagamento`). Definir se programa entra no mix e como.
- `renderProcBreakdown` joga programas no balde `Consulta` (não gravam `tipo`).

### Grupo C — precisa de SQL que só o usuário roda

**Não aplicar sozinho.** Escrever o `.sql`, explicar o impacto e pedir que ele rode.

- 🟡 **`DIAGNOSTICO_DUPLICATAS.sql` — só leitura, aguardando ele rodar.** O bug do
  `!a.pacIdx` (índice 0 falsy) duplicou atendimentos vindos da agenda enquanto esteve
  no ar. O conserto fecha a torneira; as duplicatas já criadas continuam inflando
  faturamento e ticket médio. O `.sql` mostra quais são e quanto pesam — **não apaga
  nada**, porque duplicata do bug e paciente que voltou no mesmo dia têm o mesmo
  formato, e essa distinção é do médico.

- 🔴 **Webhook multi-tenant.** `wa-webhook` é público e o `owner` vem da URL. `WA_WEBHOOK_SECRET`
  é **global**, não por clínica: não prova que quem chama é o provedor *daquele* owner.
  Correção real: `s = HMAC(segredo, owner_id)` + validar `X-Hub-Signature-256` da Meta.
  **Armadilha conhecida:** a URL que o app gera (`app.js` ~10948/10965/11331/11354) **não inclui `&s=`**,
  então definir o segredo hoje derruba toda a ingestão com 403.
- 🔴 `anon` pode inserir em `crm_leads` / `crm_messages` de qualquer clínica
  (`SETUP_SUPABASE.sql:87` e `:120` — a policy só exige `user_id is not null`).
  Permite forjar conversa e envenenar o histórico que vai pro LLM.
- 🔴 Papel `profissional` lê **todas** as conversas da clínica (`SETUP_EQUIPE.sql:202`)
  — sem cláusula de `profissional_id`. Dado de saúde, art. 11 da LGPD.
- 🟡 Re-rodar `SETUP_EQUIPE.sql` **desfaz** o `SETUP_SEGURANCA.sql` (ambos dão `drop policy`
  nas mesmas policies de `app_data` e recriam versões diferentes). Nada impõe a ordem.
- 🟡 `WA_VERIFY_TOKEN` opcional → sem ele, qualquer um passa na verificação da Meta.
- 🟡 `clinica_agendamentos` não tem constraint de unicidade por horário — `criarAgendamentoSeguro`
  é check-then-insert e não garante o que promete.

---

## Fusão com o Geri Tools (adiada a pedido do usuário)

Outro app dele, `rafaelduncanmeira-star/geritools` — prontuário de escalas geriátricas.
Retomar só quando ele pedir.

- Stack **oposta**: Next.js 15 + TypeScript + Drizzle + shadcn, deploy na Cloudflare, 30 migrations.
- **Ele já tem `patients`** (uuid, nascimento, sexo, RLS, cascade) — que é exatamente o que
  falta aqui: no Maestria a coleção `pacientes` são **atendimentos**, e a identidade da
  pessoa é **string de nome**. Prontuário não pode ser construído sobre isso.
- Por isso a base da fusão é o **Geri Tools**, não o Maestria.
- Pendente do usuário: o valor de `NEXT_PUBLIC_SUPABASE_URL` do geritools (mora no painel
  da Cloudflare, não no repo) — para saber se os dois já compartilham projeto Supabase.
- Buraco de modelagem a resolver antes: `patients.userId` é dono único; aqui existe
  `owner_id` + `team_members` com papéis.

---

## Sobre o loop de revisão

Roda via `CronCreate` a cada 10 min. **Os agendamentos vivem só na memória da sessão** —
qualquer reinício os apaga (já aconteceu uma vez). Se o usuário notar que os commits pararam,
é isso: basta re-armar.

---

## Convenções de commit

- Mensagem em português, explicando **o cenário de falha**, não só o que mudou.
- `Co-Authored-By: Claude <noreply@anthropic.com>` — sem nome de modelo/versão.
- Ambiente atual é Linux: here-string funciona. (O `ESTADO_ATUAL.md` menciona um contorno
  com `.gitmsg.tmp` que era necessário no PowerShell.)
