# Maestria de Consultório — handoff completo para a fusão com o GeriTools

Documento para quem está do lado do **GeriTools / suíte GeriClass**. Descreve tudo que
existe no Maestria hoje: modelo de dados campo a campo, vocabulários canônicos, regras de
domínio ditadas pelo médico, invariantes que custaram bug real, integrações externas,
modelo de segurança e os conflitos diretos entre os dois apps.

Tudo aqui foi extraído do código em `rafaelduncanmeira-star/consultorio-app`
(branch `claude/app-status-check-wf5vkj`), não de memória. Onde há decisão em aberto, está
marcado como **DECISÃO DO RAFAEL** — não resolva sozinho.

---

## 0. Os dois lados, como estão hoje

| | Maestria | GeriTools |
|---|---|---|
| Repo | `consultorio-app` | `geritools` |
| Stack | HTML + JS puro, **sem build**: `index.html` + `app.js` (~14k linhas) + `sw.js` (PWA) | Next.js 15 + TypeScript + Drizzle + shadcn |
| Deploy | Vercel estático (todo push publica) | Cloudflare |
| Supabase | projeto **`ipvztcqlawwslnkzmzzl`**, schema `public` | projeto **`ogwepzrwmywnubfgndpn`**, schemas `geritools` / `exames` / `shared` |
| Testes | `node --test` nativo, 550 testes, sem dependências | vitest |
| Acesso | `owner_id` + `team_members` (papéis) | `user_id = auth.uid()`, dono único, em 53 policies |

**São projetos Supabase DIFERENTES.** Logo, dois `auth.users` distintos: o mesmo médico tem
dois uuid. Qualquer fusão de dados precisa de um mapeamento de identidade antes de tudo.

O projeto do GeriTools já hospeda a suíte GeriClass inteira (Prescrição, Foco, GeriTools)
com `shared.app_access` como porta única de acesso. O Maestria é o único de fora desse
padrão.

---

## 1. Modelo de dados — 24 coleções

O Maestria guarda **tudo no `localStorage`** e sincroniza com o Supabase. Há dois regimes:

- **Coleções blindadas** (5): uma linha por registro em tabela própria
  `clinica_<nome>(id text pk, owner_id uuid, profissional_id text, data jsonb, updated_at)`.
  O registro inteiro vive no `data` jsonb — **não há colunas tipadas**.
- **Demais chaves** (19): um único blob por chave em `app_data(user_id, key, value jsonb)`.

> Consequência para a migração: **nada é tipado no banco hoje**. Toda a validação vive no JS.
> Ao modelar em Postgres, cada campo abaixo vira coluna e cada vocabulário vira `check`/enum.

### 1.1 `pacientes` — blindada → `clinica_atendimentos`

⚠️ **O nome engana: isto NÃO é cadastro de paciente. É a tabela de ATENDIMENTOS** (evento de
cobrança). Não existe entidade "paciente" no Maestria — a identidade da pessoa é
`(nome || '').toLowerCase().trim()`, uma string. Esse é o buraco central que a fusão resolve.

| campo | tipo | notas |
|---|---|---|
| `id` | text | `pac_<base36>` |
| `data` | `YYYY-MM-DD` | data do atendimento |
| `nome` | text | **identidade da pessoa** — digitada a cada visita |
| `whatsapp` | text | só dígitos, sem DDI (`_normPhone`) |
| `profissionalId` | text | FK lógica → `profissionais[].id`; espelhado na coluna `profissional_id` (é o que o RLS usa) |
| `tipo` | text | nome do procedimento, vindo de `procedimentos[].nome` |
| `procedimento` | text | **só** em lançamento de programa (nome do programa). Telas agrupam por `p.tipo \|\| p.procedimento` |
| `valor` | number | R$; `0` é válido (Retorno é gratuito) |
| `pagamento` | text | vocabulário `FORMAS_PAGAMENTO` |
| `parcelas` | number | só quando `pagamento === 'Cartão crédito'`; senão 1 |
| `recebimentos` | array | `[{numero, mes:'YYYY-MM', valor, recebido}]`, gerado quando `parcelas > 1` |
| `statusPgto` | text | vocabulário `STATUS_PGTO` |
| `tipoAtividade` | text | vocabulário de atividade |
| `obs` | text | livre |
| `programaInscricaoId` | text | FK → `inscricoes[].id` quando é lançamento de programa |
| `pacIdx` | number | **índice legado** — não replicar |

### 1.2 `agendamentos` — blindada → `clinica_agendamentos`

`id` (`ag_…`) · `data` · `hora` (`HH:MM`) · `duracao` (min) · `pacienteNome` · `whatsapp` ·
`procedimento` · `profissionalId` · `status` · `tipoAtividade` · `obs` ·
`programaInscricaoId` + `marcoIdx` (quando nasce de programa) ·
`crmId`/`crmIdx` e `pacId`/`pacIdx` (vínculos) · `_viaIa` (criado pela secretária IA) ·
`_lembreteEnviado` (ISO) · `_lembreteErro` · `_lembreteTentativaDia` + `_lembreteTentativas`.

> Sem constraint de unicidade por horário no banco — a checagem é *check-then-insert* no app
> e no webhook. Item aberto do Grupo C.

### 1.3 `crm` — blindada → `clinica_crm`

`id` (`crm_…`) · `data` · `hora` · `nome` · `whatsapp` · `idade` · `canal` · `tipo` ·
`status` (colunas do Kanban) · `obs` · `profissionalId` · `converted` (bool).

Leads entram por **realtime** vindos de `crm_leads`, alimentada pelo `wa-webhook`.

### 1.4 `followup` — blindada → `clinica_followup`

`id` (`fu_…`) · `nome` · `whatsapp` · `ultConsulta` · `dataContato` · `tipoContato`
(`WhatsApp`/`Ligação`/`E-mail`) · `dataReav` · `feito` (bool) · `obs` · `profissionalId` ·
`programaInscricaoId` + `marcoIdx`.

### 1.5 `inscricoes` — blindada → `clinica_inscricoes`

`id` (`ins_…`) · `programaId` · `pacienteNome` · `pacienteWhatsapp` · `profissionalId` ·
`dataInicio` · `dataFim` · `status` (`Ativo`/`Concluído`) · `formaPagamento`
(`À vista`/`Parcelado`) · `nParcelas` · `valorTotal` · `obs` ·
`registros[]` = `{marcoIdx, dataPrevista, dataReal, agendamentoId, followupId, valoresClinicos{}, obs}`.

⚠️ **Não há `dataCancelamento`** — churn cai no mês errado. Item aberto.

### 1.6 `programas` — blob

`id` (`pg_…`) · `nome` · `tipo` (`Assinatura`/`Fixo`/`Contínuo`) · `descricao` · `ativo` ·
`precoAVista` · `parcelas[] = {n, valor}` ·
**Assinatura:** `vigencia` (`Mensal`=30 / `Trimestral`=90 / `Semestral`=180 / `Anual`=365 dias)
· `beneficios[]` · `consultaAvulsa` · `politicas` ·
**Fixo:** `marcos[] = {dias, descricao, tipoAtividade, duracao}` ·
**Contínuo:** `intervaloDias` ·
`camposClinicos[] = {nome, unidade}` (Fixo/Contínuo).

### 1.7 `profissionais` — blob

`id` (`prof_…`) · `nome` · `tipo` · `especialidade` · `cor` (hex) · `ativo` (bool) ·
`repasse = {tipo: 'percentual'|'fixo'|'aluguel', valor}`.

### 1.8 `despesas` — blob

`id` (`desp_…`) · `data` · `descricao` · `categoria` · `tipo` (`Fixo`/`Variável`) · `valor` ·
`formaPgto` (`PIX`/`Débito`/`Crédito`/`Boleto`/`Dinheiro`).

### 1.9 `procedimentos` — blob (tabela de preços)

`id` · `nome` · `valorPix` · `valorCartao` · `obs`. Semeado com 7 itens em conta nova.

### 1.10 `bloqueios` — blob

`id` · `motivo` · `dataInicio` · `horaInicio` · `dataFim` · `horaFim`. **Tem hora, não só
data** — bloqueio de tarde não pode apagar a manhã.

### 1.11 Configurações (blobs, objeto)

- `agenda_config` — `horaInicio`, `horaFim`, `slotDuracao`, `almocoInicio`, `almocoFim`,
  `diasUteis[0-6]`, `slotsSemanais[7]` (capacidade por dia da semana). Campo legado
  `slotsConsultorioDia` migrado dentro do getter.
- `clinica_config` — `nome`, `especialidade`, `nomeClinica`, `cidade`, `crm`, `cor`, **`modo`**
  (`completo` | `financeiro` — esconde CRM/Follow-up/Programas/Agenda).
- `metas` — `{fat, pac, desp}` · `metas_proc` — `{categoria: qtd}` · `metas_proc_valor` — `{categoria: valor}`.
- `lembretes_config` — `ativo`, `horasAntes`, `mensagem` (com `{nome}` `{data}` `{hora}`
  `{procedimento}`), `ultimoEnvio`.
- `zapi_config` — `enabled`, `instanceId`, `token`, `clientToken`. **Segredo.**
- `wa_cloud_config` — `enabled`, `phoneNumberId`, `accessToken`, `templateLembrete`, `templateLang`. **Segredo.**
- `wa_provider` — `'zapi' | 'cloud'` (string, não objeto).
- `ia_config` — `enabled`, `nomeAssistente`, `apresentarComoIA`, `tom`, `endereco`,
  `convenios`, `pagamentos`, `instrucoes`, `naoResponder`, `autoSugerir`, `autonomo`,
  `agendar`, `agendarModo`.
- `llm_config` — `provider` (`groq`|`claude`|`openrouter`|`custom`), `groqModel`,
  `claudeKey`, `claudeModel`, `openrouterKey`, `openrouterModel`, `customUrl`, `customKey`,
  `customModel`. **Segredos.**
- `maestria` — gamificação: `{desbloqueados: [{id, ts}]}`, 7 níveis.

### 1.12 Chaves **locais**, que nunca sincronizam

`audit_log` (últimas 500 alterações: `{ts, autor, autorRole, acao, entidade, descricao, detalhes}`)
e `chat_history` (conversa com a IA). Estão no backup exportado, mas **restaurar não pode
gravá-las via `DB.set`** — criaria linha no `app_data` e o pull devolveria o retrato
congelado por cima do log real em toda abertura.

### 1.13 Tabelas Supabase que não são coleção

`app_data` · `clinica_*` (5) · `profiles(id, role, nome)` · `team_members(owner_id,
member_id, role, profissional_id)` · `team_invites` · `crm_leads` · `crm_messages` · `wa_eventos`.

---

## 2. Vocabulários canônicos — strings exatas

Valor fora destas listas **some de todos os baldes** e o dado desaparece dos relatórios sem
erro nenhum. Cada um tem canonizador no app.

```
STATUS_PGTO       = ['Pago', 'Parcial', 'Pendente', 'Isento']
FORMAS_PAGAMENTO  = ['PIX', 'Cartão crédito', 'Cartão débito', 'Dinheiro', 'A receber']
Status agendamento= ['Pendente','Confirmado','Compareceu','No-show','Cancelado']   // AG_FALTOU = 'No-show'
Kanban CRM        = ['Contato feito','Em negociação','Marcou','Atendeu','Não marcou']
tipoAtividade     = ['Consultório','Visita Domiciliar','Visita Hospitalar','Outro']
Canal CRM         = ['Indicação médica','Indicação paciente','Google','Instagram','WhatsApp','Doctoralia','Outros']
Categoria de meta = ['1ª vez','Consulta','Retorno','Domiciliar','Hospitalar','Telemedicina','Programa']
Vigência          = Mensal 30 · Trimestral 90 · Semestral 180 · Anual 365 (dias)
Repasse           = ['percentual','fixo','aluguel']
```

⚠️ **Categoria de despesa**: o `<select>` é agrupado por `<optgroup>` e grava a **opção**
(`Aluguel`, `Salários`, `Contador`…), **não** o rótulo do grupo (`Estrutura`, `Pessoal`…).
São 22 opções. Filtrar pelos rótulos perde quase tudo — foi bug real.

---

## 3. Regras de domínio — ditadas pelo médico, não reinterpretar

1. **Paciente novo = pessoa que nunca foi atendida antes.** Duas leituras legítimas, cada uma
   com uma implementação:
   - `_novosNoMes(pacs, mes)` — por **pessoa no mês** (aquisição; alimenta CAC e ROI de marketing);
   - `_primeiroAtendimentoDe(todos)` — por **atendimento** (o DRE fatia o faturamento em
     novos + recorrentes, e só soma 100% se a divisão for por atendimento).
2. **Consulta = atendimento que paga. Retorno = atendimento que não paga** (o procedimento
   `Retorno` nasce com `valorPix: 0`).
3. **Ticket médio tem duas leituras e as duas aparecem** (`_ticketMedio`): `porConsultaPaga`
   (só `valor > 0`) e `porAtendimento` (divide por tudo). A segunda só aparece quando existe
   atendimento gratuito no período.
4. **Financeiro tem fonte única: `_resumoFin(pacs)`.** Regra de ouro:
   `recebido + aReceber + isento` fecha com `bruto` **ao centavo**.
   - `recebido = pago` (caixa) · `aReceber = parcial + pendente` · `faturado = bruto − isento`
     (competência) · lucro na tela = caixa − despesas.
   - **Nunca** recalcular "a receber" filtrando só `Pendente` — some o `Parcial`, que é o
     status de toda inscrição parcelada.
5. **Inadimplência ≠ a receber.** O app exclui `Parcial` da inadimplência de propósito: quem
   paga parcelado não é inadimplente.
6. **Ocupação do consultório** conta só `!tipoAtividade || tipoAtividade === 'Consultório'`,
   contra `slotsSemanais[diaDaSemana]`.
7. **Aviso de renovação de assinatura se ancora no VENCIMENTO** (`dataFim − N`), nunca em
   `dataInicio + vigência`.

---

## 4. Invariantes técnicos — cada um destes foi bug real

Não são preferências de estilo. Estão em `CLAUDE.md` com o cenário de falha completo.

**Identidade e vínculos**
- Identidade de paciente é **sempre** `(p.nome || '').toLowerCase().trim()`. Nome chega
  digitado a cada visita, de planilha e do perfil do WhatsApp.
- **Índice nunca vira vínculo persistido nem argumento de `onclick`.** Ele é calculado no
  render e usado no clique; entre os dois a coleção muda. Passe o **id** e reencontre por id
  na hora de gravar.
- **Zero é um valor, não "vazio"** — `!x.pacIdx` tratava o índice 0 como "sem vínculo" e
  duplicava faturamento. Use `!= null`.
- Telefone: `_normPhone` (app) e `_foneChat` (webhook) têm de concordar. O `55` só sai quando
  é DDI de fato (12+ dígitos) — **DDD 55 existe** (Santa Maria/RS).

**Dinheiro**
- `p.valor` sem `|| 0` contamina a tela inteira (`s + undefined = NaN`).
- Separador decimal é o da **direita** (`impNormValor`): `"1234.56"` é mil duzentos e trinta
  e quatro, não cento e vinte e três mil.
- Linha "Total" soma as **linhas**, nunca refaz a conta por outro caminho.

**Datas**
- Nunca comparar `'YYYY-MM-DD'` cru com `Date.now()` — string sem hora é meia-noite **UTC**.
  Ancore os dois lados ao meio-dia local (`+ 'T12:00:00'`).
- Nunca `toISOString()` para extrair `YYYY-MM-DD` — em fuso negativo devolve o dia anterior.
  Use componentes locais.
- `setMonth(getMonth() ± n)` transborda (31/jan +1 mês = 3/mar).
- Data importada tem de **existir**, não só ter o formato (`2026-02-31` passava).

**Sincronização**
- `supabase-js` **não lança** em erro de banco — devolve `{ error }`. Erro de leitura
  **nunca** é resposta negativa: falhe fechado ou devolva `null` ("não sei"), distinto de
  `[]`/`false` (que são respostas). Com `.single()`, só `PGRST116` significa "não existe".
- Nunca apagar dado com base em array local vazio — vazio pode ser aparelho novo, pós-logout
  ou pull que falhou. Vale igual para **seed**: seed é gravação, e gravação sobe pra nuvem.
- Toda chamada externa precisa de prazo — `fetch()` do navegador não tem timeout, e promise
  pendurada nunca roda `catch`/`finally`.

**Interface**
- `_esc()` para dado em `innerHTML`; `_jsArg()` (não `encodeURIComponent`) para argumento em
  `onclick`. Nome de contato vem do perfil do WhatsApp = entrada de terceiro não confiável.
- Atribuir a `.value` de `<select>` um valor que não existe entre as `<option>` deixa
  `selectedIndex = -1` e o save devolve `''` — **apaga o campo em silêncio**.
- Lista de **escolha** ≠ lista de **exibição**: o profissional do registro entra no select
  mesmo inativo, senão o registro é transferido pro primeiro ativo.
- `form.reset()` não desfaz estilo inline nem `<option>` criada por JS.

---

## 5. Funcionalidades, tela por tela

`dashboard` · `pacientes` (atendidos) · `crm` (lista + Kanban) · `agenda` · `followup` ·
`programas` · `receita` · `despesas` · `metas` · `relatorio` · `precos` · `backup` ·
`configuracoes`.

- **Dashboard** — KPIs do mês, gráficos (faturamento×lucro 12 meses, despesas por categoria,
  funil CRM), alertas proativos (no-show alto, ocupação baixa, inadimplência, pacientes sem
  retorno há +6 meses, conversão CRM baixa), banner de renovações em 30 dias.
- **Agenda** — views dia/semana/mês/**profissionais** (quadro por coluna), arrastar para
  remarcar e para trocar de profissional, detecção de conflito por sobreposição de intervalo,
  bloqueios com hora, configuração de horários e capacidade por dia da semana.
- **CRM** — lista + Kanban com drag, leads chegando por realtime do WhatsApp, conversão para
  atendimento, chat de WhatsApp dentro do app.
- **Programas** — templates (Assinatura/Fixo/Contínuo), inscrição com parcelamento, marcos
  com campos clínicos, renovação, MRR.
- **Financeiro** — Receita (mix de pagamento, quebra por procedimento, fluxo de caixa
  projetado), Despesas, DRE, Metas, relatório mensal e **PDF anual para o contador**.
- **Backup** — export/import JSON, 7 snapshots diários automáticos, restauração, painel de
  saúde da sincronização (fila + quarentena).
- **Secretária por IA** — copiloto no app *e* atendimento autônomo no WhatsApp.

### 5.1 Ações do copiloto (o LLM emite um bloco `action` JSON)

`criar_paciente` · `criar_crm` · `criar_followup` · `criar_agendamento` ·
`cancelar_agendamento` · `mover_agendamento` · `atualizar_status_crm` ·
`atualizar_pagamento` · `criar_despesa` · `criar_procedimento` · `criar_bloqueio` ·
`definir_meta`.

Regras que valem para **toda** ação: dado do LLM entra **normalizado ou não entra** (valor
por `impNormValor`, status pelos canonizadores, nome aparado); busca por nome só via
`_acharPorNome` (exato, parcial por palavra inteira, **−1 na dúvida**, inclusive homônimo);
e o gate `_podeVerFinanceiro()` corta **contexto e instrução** — mandar a IA responder o que
ela não recebeu faz ela inventar número.

---

## 6. Integrações externas

- **WhatsApp, dois provedores no mesmo endpoint**: Z-API (gateway pago) e WhatsApp Cloud API
  (Meta). Nunca perguntar `getZapiConfig()` direto — a pergunta é `_waConnected()`.
- **Edge Function `wa-webhook`** (Deno, *Verify JWT desligado*, **publicada à mão** pelo
  painel): recebe mensagem → cria lead em `crm_leads` → opcionalmente responde com IA. Ela
  calcula a **disponibilidade da agenda** do lado do servidor (respeitando duração, almoço e
  bloqueios) e pode criar agendamento com re-checagem de conflito imediatamente antes do
  insert. A URL carrega `?owner=<USER_ID>`.
- **LLM**: Groq (padrão), Anthropic, OpenRouter ou endpoint próprio.
- **Lembretes automáticos**: ciclo varre a agenda de 15 em 15 min, manda WhatsApp N horas
  antes, marca `_lembreteEnviado` **no agendamento** e tem teto de 3 tentativas por dia.
- **PWA** — service worker network-first, instalável, e a recepção deixa o app **aberto a
  semana inteira** (premissa que vale para todo o resto: nada pode depender de recarregar a
  página).

---

## 7. Segurança — o que está de pé e o que está aberto

**De pé:** RLS em todas as tabelas por `owner_id`; `_podeVerFinanceiro()` (só médico DONO,
nem médico membro) valendo na sidebar, no `showPage`, no `_applyRole` **e no prompt da IA**;
2FA TOTP com falha fechada; auditoria local; marca de dono do aparelho (`consult__dono`)
impedindo que a queda de sessão misture duas contas.

**Aberto — Grupo C, precisa de SQL que só o Rafael roda:**
1. `wa-webhook` é público e o `owner` vem da URL; `WA_WEBHOOK_SECRET` é **global**, não por
   clínica. Correção real: `s = HMAC(segredo, owner_id)` + validar `X-Hub-Signature-256`.
2. **`anon` pode inserir em `crm_leads`/`crm_messages` de qualquer clínica** — permite forjar
   conversa e envenenar o histórico que vai pro LLM.
3. Papel `profissional` lê **todas** as conversas da clínica, sem cláusula de
   `profissional_id`. Dado de saúde, art. 11 da LGPD.
4. `WA_VERIFY_TOKEN` é opcional — sem ele qualquer um passa na verificação da Meta.
5. `clinica_agendamentos` não tem constraint de unicidade por horário.

> 🔴 **Isto muda de tamanho com a fusão.** Hoje o estrago fica contido nos dados do Maestria.
> No projeto GeriClass, esses buracos passam a estar no mesmo banco dos 537 pacientes, do
> prontuário e do módulo de exames. **Feche o Grupo C antes de mover qualquer coisa.**

---

## 8. Conflitos diretos com o GeriTools

| Conceito | GeriTools | Maestria | Situação |
|---|---|---|---|
| **Acesso** | `user_id = auth.uid()`, dono único, 53 policies | `owner_id` + `team_members` com papéis | **Incompatível.** Um dos dois cede. |
| **Paciente** | `geritools.patients` (uuid, nascimento, sexo, RLS, cascade) | não existe — string de nome | GeriTools vence, é o ponto da fusão |
| **Atendimento** | `patient_encounters` (registro clínico) | `pacientes` (evento de cobrança) | **Coisas diferentes.** Coexistem, ligadas por paciente + data |
| **Programas** | `geritools.programas` / `patient_programas` (vazios) | `programas` + `inscricoes` — em uso, com MRR, parcelamento, marcos e renovação | Maestria está muito à frente |
| **Follow-up** | `patient_retornos`, `patient_tarefas`, `patient_pos_consulta` | `followup` | Sobrepostos |
| **Mensagens** | `patient_mensagens` + push | CRM de WhatsApp + `crm_messages` + webhook | Sobrepostos |
| **Perfis** | `geritools.profiles` | `public.profiles` | Unificar sob `shared.app_access` |

---

## 9. Decisões pendentes — **do Rafael, não decida sozinho**

**Bloqueiam a fusão:**
1. **Equipe ou dono único?** É a decisão que destrava as outras.
2. **Maestria entra no `shared.app_access`** como quarto produto da suíte, ou fica fora do portão?
3. Para cada conceito sobreposto da tabela acima: **qual versão vence?**

**Abertas no Maestria (Grupo B), herdadas pela fusão:**
4. **MRR tem duas fórmulas convivendo:** `renderProgramas` usa `valorTotal / vigência × 30`;
   `_mrrDeInscricao` usa `precoAVista / dias × 30`. Qual é a canônica?
5. `inscricoes` não tem `dataCancelamento` → churn no mês errado, MRR histórico reescrito.
6. Mix de pagamento: programas não gravam `pagamento`. Programa entra no mix? Como?
7. `renderProcBreakdown` joga programas no balde `Consulta`.
8. O prompt do copiloto manda a IA usar `tipo` de atendimento com 7 categorias que **não são**
   nomes do catálogo de procedimentos ("Consulta" × "Consulta no consultório").
9. Cartão parcelado no regime de caixa: hoje um 6× com `statusPgto: 'Pago'` conta **inteiro**
   no mês da consulta, enquanto o Fluxo de Caixa espalha em 6 meses. "Pago" = paciente quitou,
   ou = dinheiro entrou?
10. O backup exportado leva `llm_config`, `zapi_config` e `wa_cloud_config` **em texto puro**
    — enquanto `gemini_key_secure` é excluído de propósito. Tirar os segredos do export ou
    avisar na tela que o arquivo contém credenciais?

---

## 10. O que **não** trazer

- `pacIdx`, `crmIdx`, `followupIdx` e qualquer índice persistido — são vínculo por posição.
- O modelo blob (`app_data`) e o par localStorage-como-fonte-de-verdade: no Postgres cada
  campo vira coluna.
- Os seeds de fábrica (7 procedimentos, 5 programas, profissional "Titular") sem antes
  decidir se a conta é nova de verdade.
- O campo legado `slotsConsultorioDia`.
- `saveMetasProc` / `modal-metas-proc`: **código morto** hoje (nenhum botão abre). Religá-lo
  como está apaga a meta de "Programa".

---

## 11. Como usar este documento

Ele responde "o que existe no Maestria". Ele **não** decide a arquitetura da fusão — as três
estratégias (fundir código × fundir banco mantendo dois front-ends × só integrar por link)
dependem das decisões da seção 9.

A recomendação registrada do lado do Maestria é **fundir o banco mantendo os dois
front-ends**: as tabelas do Maestria viram `consultorio.*` no projeto GeriClass, os dois apps
leem o mesmo `geritools.patients` e o mesmo `shared.app_access`. É o padrão que a suíte já usa
para três apps, não exige reescrever um app em produção, e entrega o ganho real — clicar no
paciente da agenda e abrir o prontuário dele.

E a **fase 1 não depende da fusão**: dar identidade real de paciente ao Maestria
(`paciente_id` + deduplicação dos nomes) vale por si só, e é onde mora a maior parte dos bugs
que ainda aparecem.
