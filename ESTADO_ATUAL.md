# 📍 ESTADO ATUAL — Maestria de Consultório

> **Para o Claude da próxima sessão (web/celular):** leia este arquivo inteiro antes de mexer.
> Ele resume onde paramos. Atualizado no commit `8b8426b`.
> Quando terminar uma etapa importante, **atualize este arquivo** e dê push.

---

## 🎯 O que é o projeto

App de **gestão de consultório/clínica médica** (SPA) que o Dr. Rafael Duncan está
transformando em **produto para vender a clínicas** (multi-profissional).

- **Stack:** HTML/CSS/JS **puro** (NÃO é React). Sem build — é só abrir o `index.html`.
- **Deploy:** Vercel em `consultorio-app-cyan.vercel.app`, **auto-deploy a cada push** no GitHub.
- **Dados:** `DB.get/set/getObj/setObj` (síncrono, localStorage prefixo `consult_`) com
  write-through pro Supabase (`cloudPull`/`cloudPush`).
- **Backend:** Supabase (Postgres + RLS + Edge Functions em Deno).
- **WhatsApp:** Z-API (envio `send-text` com header `Client-Token`; webhook recebe mensagens).
- **Arquivos principais:** `app.js` (~11.800 linhas, lógica), `index.html` (UI), `*.sql` (rodados à mão no Supabase).

> ⚠️ **Ainda NÃO há dados reais** — tudo é fictício. Risco de refatoração é baixo.

---

## ✅ O que já está PRONTO (e testado)

1. **WhatsApp dois sentidos:** recebe via webhook (`supabase/functions/wa-webhook/index.ts`,
   grava em `crm_messages` + cria card em `crm_leads` sem duplicar) e responde pelo
   **chat interno do CRM** (fallback `wa.me` só quando a automação está desligada).
2. **Plano Clínica (multi-profissional):** vários profissionais com login, secretária/médico
   veem tudo, profissional vê só o dele. Agenda multi-coluna por profissional, repasse por
   profissional. (Tijolos 1–4 + onboarding, validados.)
3. **Blindagem de dados (isolamento por profissional via RLS)** — 5 coleções saíram do blob
   `app_data` e viraram **tabelas por linha** (`id, owner_id, profissional_id, data jsonb`),
   filtradas por RLS:

   | Coleção | Tabela |
   |---|---|
   | Pacientes/Atendimentos | `clinica_atendimentos` |
   | Agendamentos | `clinica_agendamentos` |
   | CRM (contatos) | `clinica_crm` |
   | Inscrições (programas) | `clinica_inscricoes` |
   | Follow-ups | `clinica_followup` |

   - Config no código: `const _BLINDADAS = {...}` (app.js ~linha 198). Sync genérico:
     `_pushBlindada`/`_pullBlindada`/`_migrarBlindada`/`_sincronizarBlindadas`.
   - Guards anti-perda: `_pushBlindada` retorna sucesso; só apaga o blob se o push deu certo;
     `_pullBlindada` tem anti-zeramento.
   - **Despesas/metas:** escondidas do profissional — `_limparSensiveisProfissional()` remove
     do localStorage no fim do `cloudPull`.
   - SQL: `SETUP_BLINDAGEM.sql` (já rodado no Supabase, 5 tabelas + RLS + realtime).

4. **Último ajuste (commit `8b8426b`) — 2 bugs que o teste revelou:**
   - **Vazamento de financeiro no Dashboard:** os cards (Faturamento/Lucro/Despesas),
     Inteligência Financeira, DRE, MRR e Análise apareciam pra não-médico. Corrigido com
     `body.role-no-fin` (toggle em `_applyRole`, app.js) + CSS `!important` no `index.html`
     escondendo `[data-fin]` e `[data-section=financeiro|mrr|analise]`. Os 3 KPIs financeiros
     ganharam `data-fin="1"`.
   - **Etiqueta de papel mentirosa:** `_atualizarSidebar` mostrava "Secretária" pra QUALQUER
     não-médico (escondia que era "Profissional"). Agora reflete `currentRole`:
     **Médico | Profissional | Secretária**. (Provável causa da confusão "convidei como
     profissional e entrou como secretária".)

---

## 🛡️ Sessão de hardening (segurança + testes + LGPD)

Passada de qualidade sobre a base, sem tocar em regras de negócio:

1. **XSS blindado — 17 pontos corrigidos.** Auditoria cruzou as ~174 atribuições a
   `innerHTML` com interpolações de dados externos (nome/obs/canal/tipo de paciente,
   CRM e WhatsApp). 10 gaps de risco alto + 7 baixo foram envolvidos com `_esc(...)`.
   Casos notáveis: card do "marcar atendimento" (CRM→Kanban), view **mensal** da agenda
   (a semanal já escapava), alerta de follow-ups, abas do perfil do paciente, e
   agregações dos relatórios. `toast()`/`confirm()` são texto puro → não eram XSS.
2. **Testes automatizados (novos).** Pasta `tests/` com harness **sem dependências**
   (`node:test` + `node:vm`) que recorta funções do `app.js` real e roda em sandbox.
   Cobre `_esc`, `_limparSensiveisProfissional` (blindagem do financeiro) e
   `_profDoPaciente` (isolamento). Rodar com **`node --test`**. 7/7 passando.
   ⚠️ Não criar `package.json` na raiz (Vercel é estático — quebraria o deploy).
3. **LGPD.** `privacidade.html` (política-modelo com placeholders pra preencher CNPJ/
   razão social/DPO) + link em Configurações.

**Ainda em aberto (próximas passadas de qualidade):** feature de exportar/excluir dados
de um paciente sob demanda (direito LGPD), acessibilidade (zero `aria-` hoje), validação
de formulários (WhatsApp/e-mail), e — só com testes mais amplos antes — modularizar o
`app.js` (11.8k linhas num arquivo só).

---

## 📲 Sessão WhatsApp plugável (Z-API ↔ Cloud API oficial)

Para parar de pagar mensalidade do Z-API, o WhatsApp virou **plugável**: a clínica
escolhe o provedor em **Configurações → WhatsApp**. Só um ativo por vez.

- **Camada de provedor (app.js):** `getWaProvider`/`setWaProvider`, `getCloudConfig`,
  `_waConnected`. Envio unificado por `_waSendText` (sessão) e `_cloudSendText`/
  `_cloudSendTemplate` (Cloud API). `_enviarLembreteZapi` agora roteia por provedor.
  Todos os gates de UI ("responde pelo CRM") passaram a usar `_waConnected()`.
- **UI (index.html):** novo card "WhatsApp oficial (Meta)" com toggle/campos/teste,
  espelhando o do Z-API. Ligar um desliga o outro (exclusão mútua).
- **Webhook (wa-webhook/index.ts):** `normalizarEntrada()` cobre os dois formatos
  (Z-API plano + Cloud aninhado), GET trata o `hub.challenge` da Meta. **Gancho da
  IA já preparado** em `maybeAutoReply()` (inerte até `WA_AI_ENABLED=1`).
- **Setup:** ver `SETUP_WHATSAPP_CLOUD.md` (passo a passo Meta + os 2 templates
  prontos: lembrete=utility, reativação=marketing).

**Próximo passo do WhatsApp:** o usuário criar a conta Meta/credenciais e testar;
depois, mover o envio da Cloud API pro servidor (token fora do navegador) e então
ligar a **secretária por IA** (Fase 2) dentro do gancho já pronto.

---

## 🤖 Sessão Secretária por IA (copiloto) — Fase 1

A secretária por IA foi ligada em **modo copiloto**: no chat do CRM, a IA **sugere**
a resposta ao paciente; a secretária **revisa e envia** (nunca envia sozinha).
Roda **no navegador**, reusando o Groq já configurado — **sem chave nova no servidor
e sem depender da Meta** (funciona com o Z-API atual).

- **Conhecimento automático:** `_iaMontarSystemPrompt()` monta o "cérebro" a partir
  de procedimentos/preços (`getProcedimentos`), programas (`getProgramas`), horários
  (`agenda_config`) e nome da clínica (`clinica_config`). Guardrails no prompt:
  **nada de conselho médico**, não inventar preço/horário, não fechar agenda sozinha,
  escalar pra humano quando fugir do escopo.
- **Geração:** `_iaSugerirResposta()` busca as últimas 16 msgs da conversa e chama
  o Groq (`llama-3.3-70b-versatile`). `iaSugerirNoChat()` preenche o input pra revisão.
- **UI:** botão "✨ Sugerir" no chat + aviso "revise antes de enviar"; auto-sugestão
  opcional ao chegar mensagem. Card de config em Configurações (toggle, tom,
  instruções extras, auto-sugerir). Config em `ia_config` (sincronizada).
- **Testes:** `tests/ia.test.js` (prompt traz dados certos + guardrail sempre presente
  + mapeamento de histórico). 11/11 no `node --test`.

**Próximos passos da IA:** (1) modo **autônomo** (responder sozinho) — mover a geração
pro webhook `maybeAutoReply()` e enviar server-side; (2) **agendar de verdade** (tool
use lendo/escrevendo a agenda); (3) trocar Groq→Claude se quiser mais qualidade.

---

## 🧩 Sessão "ship dark" — IA plugável + autônomo + agendar (tudo OFF)

Construído pronto-para-ligar, **desligado por padrão** (o usuário quer ter a opção,
não usar ainda):

1. **Motor de IA plugável (qualquer provedor):** `getLlmConfig()` + `_llmChat({system,messages})`
   no app.js (dispatcher). Suporta **Groq** (grátis), **Claude** (Anthropic), **OpenRouter**
   (vários modelos numa chave) e **Personalizado** (qualquer endpoint compatível com OpenAI:
   URL+chave+modelo). Claude usa formato Anthropic; os demais, formato OpenAI Chat Completions.
   Copiloto já usa; webhook (`chamarLLMServer`) espelha os 4. UI no card da IA. Config em
   `llm_config` (sincronizada). Default Groq.
2. **Modo autônomo (webhook):** `maybeAutoReply()` agora implementa de verdade — lê
   `ia_config`/conhecimento/`llm_config`/provedor de `app_data` por owner, monta prompt
   (`montarSystemPromptServer`), chama LLM (`chamarLLMServer`), envia
   (`enviarWhatsAppServer`) e grava no CRM. Gated por `ia_config.autonomo`.
3. **Agendar (webhook):** via marcador `[[AGENDAR: data hora | proc]]`. `montarDisponibilidade`
   calcula horários livres reais; `criarAgendamentoPendente` insere em `clinica_agendamentos`
   (status **Pendente** por padrão; "direto" = Confirmado). Gated por `ia_config.agendar`.
   UI com modo pendente/direto.

⚠️ **Não validado ao vivo** (sem Deno/LLM aqui). Modos 2 e 3 precisam de 1 teste real
antes de usar com paciente. Rede de segurança: agendar default = PENDENTE (humano confirma).
`node --check` OK; `node --test` 11/11 (cobre prompt+guardrail+histórico do lado app).

**Próximo passo da IA:** teste ao vivo do autônomo (webhook redeployado) numa conversa
de teste; depois validar o agendar-pendente; e migrar envio da Cloud API p/ server-side.

---

## 🔍 AUDITORIA COMPLETA (avaliação de release) — sessão mais recente

Auditoria de 3 frentes (segurança/sync, bugs de produto, webhook/IA) + smoke
test Playwright real (boot logado simulado, demo-data, 13 páginas, zero erros).

**Corrigido nesta sessão (commitado):**
- CRÍTICO dados: `_pushBlindada`/`cloudPush` não liam o `{error}` do supabase-js
  → migração podia apagar blob com push rejeitado = perda total. Corrigido +
  anti-zeramento reforçado (pull vazio p/ dono nunca sobrescreve; auto-cura).
- CRÍTICO segurança: snapshots diários vazavam a clínica INTEIRA (+chaves de
  API) p/ qualquer membro via app_data. Agora: snapshot só do dono, membro
  limpa snapshots/segredos do localStorage, e **SETUP_SEGURANCA.sql** fecha o
  RLS (segredos: dono+secretária; snapshots: só dono; DELETE: só dono).
- CRÍTICO webhook: IA "desligada" continuava respondendo (só checava autonomo);
  loop de eco por callback de status; retry da Meta duplicava respostas; sem
  rate limit; marcador AGENDAR sem validação (prompt injection podia marcar
  qualquer horário); fuso UTC oferecia dias errados à noite. Tudo corrigido —
  ver commit "hardening". **Requer REDEPLOY do webhook + SETUP_IA_AUTONOMA.sql.**
- Lembretes automáticos nunca saíam p/ Cloud API (gate exigia Z-API).
- ~25 pontos de fuso horário (toISOString → _ymd): lembrete 48h antes/dia pulado,
  dashboard zerado à noite no fim do mês, follow-up "atrasado" às 21h etc.
- Dedupe de leads com DDI 55 (cards duplicados), chave do chat com +55 (chat
  vazio), wa.me/5555, drag-drop sem validação, conflito multi-profissional,
  cancelamento por crmIdx congelado (paciente errado!), edição apagando
  campos de sistema, Pendente da IA invisível (agora: option+estilo+banner+pull),
  chat realtime não mostrava respostas da IA, CDN fora do ar derrubava o app.

**Personalização da IA (novo):** nome da assistente, endereço, convênios,
pagamentos, "nunca responder sobre", transparência (não finge ser humana,
padrão ligado), data local no prompt, **Playground de teste no card** (conversa
simulada sem WhatsApp, usa o formulário ao vivo) e "🧠 Ver o que a IA sabe".

**AINDA ABERTO (conhecido, documentado):**
1. ⚠️ Rodar **SETUP_SEGURANCA.sql** e **SETUP_IA_AUTONOMA.sql** no Supabase e
   **redeployar o wa-webhook** (o do ar está SEM o hardening).
2. Teste de isolamento com convite real (pendente desde o início!).
3. Last-write-wins nos blobs do app_data (PC+celular simultâneo pode perder
   edição de config/procedimentos); edição offline pode ser sobrescrita no pull.
4. accept_invite sobrescreve profiles.role global (dono que aceita convite de
   outra clínica vira secretaria na PRÓPRIA) — corrigir no SQL da equipe.
5. Segredos ainda vão pro navegador da secretária (necessário p/ enviar do
   browser) — próximo passo estrutural: envio server-side via Edge Function.
6. Pagamento "Parcial" de programas não entra em nenhum KPI de receita.
7. Índices congelados em onclick podem apodrecer quando lead chega via
   realtime com modal aberto (mitigado nos fluxos críticos; refactor p/ ids).
8. IA autônoma: código blindado mas NUNCA testada ao vivo — testar com o
   próprio número antes de ligar pra paciente real. Playground cobre o copiloto.

---

## 🔁 RE-AUDITORIA do código já corrigido (esta sessão)

Duas frentes de auditoria adversarial sobre o código JÁ corrigido: (a) verificar
que as correções estão certas e não introduziram regressão; (b) caçar buracos no
webhook reescrito. Resultado: o grosso das correções passou limpo — a re-auditoria
confirmou como **CORRETOS**: os ~45 `_ymd()` (todos recebem `Date`, nenhum string;
`impNormDate`/Excel seguem UTC de propósito), o `_normPhone` (webhook e cliente
concordam para número normal; DDD-55 preservado), `_temConflito` ciente de
profissional, os guards de snapshot/segredo, `_pushBlindada` lendo `{error}`, e o
`_pullBlindada` da agenda sem loop de eco.

**Corrigido nesta re-auditoria (commitado):**
- **Regressão (agenda):** o merge que preserva campos de sistema mantinha
  `_lembreteEnviado` ao **remarcar** — mudança de dia não reenviava lembrete.
  Agora, se data/hora mudam, `_lembreteEnviado`/`_lembreteErro` são rearmados.
- **wa.me (DDD-55):** `falarComPaciente` usava fallback inline `startsWith('55')`
  em vez do `_waMeLink` — quebrava número local de Santa Maria-RS. Migrado.
- **Relatório mês fixo:** `showPage('relatorio')` abria sempre em `'2026-05'`
  (hardcode) → agora abre no mês atual.
- **Webhook — autonomia só autenticada (HIGH):** a IA autônoma (custo de LLM +
  criação de agenda) agora SÓ dispara com `WA_WEBHOOK_SECRET` conferido. Sem o
  segredo o webhook ainda ingere leads/mensagens, mas não responde nem agenda —
  fecha a URL vazada como torneira de custo / porta pra agenda falsa.
- **Webhook — fusível global por dono:** teto de 300 respostas/dia somando todos
  os telefones (barra rotação de números furando o limite por telefone).
- **Webhook — double-booking (HIGH):** `criarAgendamentoSeguro` re-checava só
  início idêntico; agora checa **sobreposição de intervalo** (90min às 08:00
  barra novo slot às 08:30). Duração do agendamento vem de `agcfg.slotDuracao`
  (era fixa em 60).
- **Webhook — frescor por timestamp:** o guard de "mensagem mais nova" comparava
  TEXTO (mesmo texto repetido → resposta dupla). Agora compara `created_at`.
- **Webhook — dedupe:** chave sintetizada (telefone+`momment`) quando a Z-API não
  manda id; e o registro de dedupe é desfeito se a gravação da mensagem falhar
  (evita perder a mensagem num retry). Marcador AGENDAR com `.+?` (não trunca em
  `]` interno).

**AINDA ABERTO desta re-auditoria:**
- Modo autônomo exige agora `WA_WEBHOOK_SECRET` definido no Supabase **e** `&s=...`
  na URL colada no provedor — sem isso a IA não responde (por design).
- Double-booking residual: se a clínica NUNCA migrou a agenda pras linhas
  `clinica_agendamentos` (flag `consult_ag_migrado`), o webhook vê tudo livre.
  Garantir que a migração rodou antes de ligar o `agendar`.
- **REDEPLOY do wa-webhook** de novo (esta re-auditoria mexeu no index.ts).
- Corridas check-then-act no rate limit (duas invocações quase simultâneas) e
  tarefa de background morta = resposta perdida sem retry — baixo volume, aceito
  para o piloto; ideal futuro é guarda atômica (RPC).

---

## 🧹 VARREDURA 6h #1 (loop automático) — segurança, isolamento e integridade

Três auditorias paralelas (financeiro/KPI, integridade de sync, auth/equipe/RLS)
sobre o código corrigido. Corrigido e commitado:

**Segurança / isolamento (exige rodar SQL de novo no Supabase):**
- **Financeiro vazava por RLS:** `despesas/metas/metas_proc/metas_proc_valor` eram
  legíveis por qualquer membro (inclusive profissional) direto no banco — a
  blindagem só existia no navegador. **SETUP_SEGURANCA.sql** agora tranca essas
  chaves ao dono no RLS (select/insert/update).
- **Convite agora é NOMINAL:** `accept_invite` só aceita se o e-mail logado for o
  convidado (antes, qualquer um com o link entrava). **SETUP_EQUIPE_PROFISSIONAL.sql**.
- **Dono não é mais rebaixado:** `accept_invite` não sobrescreve mais o
  `profiles.role` global (o papel do convite vale só dentro da equipe, em
  `team_members.role`). E `resolveDataOwner` (app.js) faz quem tem clínica
  própria SEMPRE ver a própria, mesmo sendo membro de outra — antes, aceitar um
  convite trancava o dono fora dos próprios dados.

**Integridade de dados (app.js, já no deploy):**
- **Ações de CRM e Kanban por ID, não por índice:** editar/excluir/mudar
  status/converter/chat/arrastar resolviam a linha por índice congelado. Um lead
  chegando via realtime (`unshift`) reordenava o array e a ação caía no contato
  ERRADO (sobrescrevia/excluía/convertia o vizinho). Agora tudo resolve por id
  no momento da ação; `renderCrm`/`renderKanban` garantem id em toda linha.
  Coberto por novo teste no smoke (simula lead no meio da edição).
- **saveAgendamento** prefere `crmId` estável ao índice congelado.
- **Anti-zeramento do membro:** o guard usava a flag de migração (que nunca liga
  pra membro), então o membro nunca refletia deleções do dono (registros-fantasma).
  Agora há flag `_msync` por coleção: aceita pull vazio só depois de sincronizar
  linhas uma vez.

**AINDA ABERTO desta varredura (documentado, não corrigido):**
1. ⚠️ **Rodar de novo** `SETUP_SEGURANCA.sql` e `SETUP_EQUIPE_PROFISSIONAL.sql`
   no Supabase (as policies e o `accept_invite` mudaram) + o novo
   `SETUP_SYNC.sql` (coluna `rev` p/ concorrência otimista — sem ela o app
   funciona no modo antigo).
2. ✅ **Financeiro — "Parcial" RESOLVIDO (Dr. Rafael pediu os DOIS regimes).**
   Helper único `_resumoFin`/`_lucroFin` (com testes) padroniza todas as telas:
   CAIXA (recebido = Pago) e COMPETÊNCIA (faturado = Pago+Parcial+Pendente). O
   `Parcial` agora entra em "a receber" e `recebido + a receber + isento` fecha
   com o bruto. Receita, Dashboard, Relatório, PDF e Metas usam o lucro de CAIXA
   (batem entre si); o **DRE mostra os dois lucros** (Caixa e Competência) lado a
   lado. (Nos dados demo: Lucro Caixa R$14.250 · Lucro Competência R$32.050.)
3. ✅ **Sync estrutural RESOLVIDO (Dr. Rafael autorizou "Sim"):**
   (a) **Outbox**: escrita offline/rejeitada agora fica numa fila por chave
   (`consult__outbox`); o pull NÃO sobrescreve chaves pendentes e a fila é
   drenada ao voltar a conexão (`online`) e no início de cada `cloudPull`.
   (b) **Concorrência otimista**: blobs do `app_data` ganham coluna `rev`
   (**SETUP_SYNC.sql** — rodar no Supabase). O push usa `update ... where rev =
   última vista`; se outro aparelho gravou antes, detecta o conflito e MESCLA
   arrays por id (nada se perde; deleção pode "ressuscitar", que é mais seguro
   que perder um lançamento). Objetos/sem-id: local vence (LWW como antes, mas
   detectado). Sem a coluna, o app cai no upsert antigo — retrocompatível.
   (c) Backfill de `id` em despesas/agendamentos/inscricoes (`_migrarIds`) —
   habilita o merge e fecha o resíduo "linha sem id ficava fora da blindada".
   Coberto por 7 testes unitários novos + 2 cenários E2E no smoke (conflito
   entre 2 aparelhos e edição offline sobrevivendo ao pull).

---

## 🎨 PACOTE DE USABILIDADE — auditoria visual (screenshots desktop+mobile)

Pedido do Dr. Rafael: "como melhorar o app, especialmente a usabilidade?".
Rodei o app real no Playwright (desktop 1440px e mobile 390px) e tirei
screenshots das telas principais antes de recomendar qualquer coisa. Depois
implementei o pacote completo:

1. **Agenda no celular**: view padrão passa a ser **Dia** (não mais Semana —
   7 colunas espremidas em 390px eram inutilizáveis). Os 5 cards de KPI vêm
   **colapsados** num resumo de 1 linha ("N agendado(s) · N compareceram · X%
   ocupação"), expansível com 1 toque — o calendário aparece sem precisar
   rolar. `renderAgenda()` agora também sincroniza as abas ativas sozinho
   (antes só `setAgendaView` fazia isso — o default mobile 'dia' não acendia
   nenhuma aba no primeiro load).
2. **Autocomplete de paciente no agendamento**: campo "Paciente" ganhou
   `<datalist>` com todo mundo de Atendidos+CRM; ao digitar/selecionar um nome
   conhecido, WhatsApp/Procedimento/Profissional se preenchem sozinhos (só em
   campos ainda vazios — não pisa em edição manual). Acaba com o
   redigitar-e-errar telefone que quebrava lembrete e vínculo com o CRM.
3. **Toasts de conquista**: no celular saem do canto inferior-direito (cobria
   calendário/tabelas) pro topo, menores, 2s. Corrigido também um bug real de
   EMPILHAMENTO — quando 2+ conquistas desbloqueiam juntas (comum ao carregar
   dados de demonstração), todas caíam na MESMA posição e ficavam ilegíveis
   sobrepostas; agora cada uma abre um pouco abaixo da anterior.
4. **Dashboard "Bom dia" 24h por dia + zerado sem aviso**: a saudação era
   texto FIXO no HTML (nunca atualizava — sempre "Bom dia, Dr. Rafael" mesmo
   às 23h, com nome de exemplo hardcoded). Agora calcula por hora real e usa
   `currentNome`. Mês sem nenhum lançamento agora mostra um banner "Nenhum
   lançamento em [mês] ainda — ver [último mês com dados]" em vez de uma
   tela de R$0 que parece bug.
5. **"Dr. Dr. Fulano"**: bug real — nome cadastrado como "Dr. Teste" virava
   "Dr. Dr. Teste" no chip da sidebar/saudação/PDF. `_comTituloMedico()`
   agora detecta título existente (regex exige "." ou espaço depois de
   dr/dra — não confunde nomes reais como "Drico"/"Dracena"). Achei e corrigi
   um SEGUNDO bug da mesma família na correção da saudação do dashboard
   (cortar o primeiro nome ANTES de tirar o título transformava "Dr. Teste"
   em só "Dr.", que meu próprio regex não reconhecia como título já
   presente — "Dr. Dr." de novo). Travado com teste de regressão dedicado.
6. **Desfazer exclusão**: `deleteRow` (crm/pacientes/followup/despesas) e as
   exclusões de agendamento agora mostram um toast com botão "Desfazer" por
   6s, restaurando o registro na mesma posição. O `confirm()` nativo continua
   existindo (barreira antes de agir), isto é uma segunda rede de segurança
   pra quando o dedo escorrega.
7. **Ícones de ação tocáveis**: ✏️/🗑️ nas tabelas tinham ~20px de área de
   toque; CSS mobile os aumenta pra ~38px mirando pelo `onclick` (mesmo
   padrão já usado nas grids responsivas — não precisou tocar em cada
   função de render).
8. **Data por extenso**: todo `<input type="date">` da página ganha um texto
   auxiliar abaixo ("qui, 3 de julho") — o formato nativo do browser
   (dd/mm vs mm/dd) é ambíguo em alguns navegadores/SOs.

Validado com 12 novos testes unitários (39/39 no total) + smoke Playwright
com cenários dirigidos (autocomplete preenchendo campos, id-safety do CRM já
existente continua ok, undo de exclusão restaurando o registro certo, banner
de mês vazio trocando de mês ao clicar) — 0 erros de runtime, screenshots
desktop+mobile conferidas visualmente antes de fechar.

**Não implementado** (ficou de fora do pacote, por ser diferente em natureza):
teste cronometrado com uma secretária de verdade usando o app — isso exige
uma pessoa real testando ao vivo, não dá pra simular.

---

## 🔜 PRÓXIMO PASSO (é aqui que paramos)

**Provar o isolamento com um teste limpo.** O teste anterior não valeu porque o "Dr. Jovino"
tinha entrado como conta-própria, não como profissional da equipe.

### Como testar
**Como Rafael (dono):** atribua 1 paciente a um profissional + crie 1 follow-up pra ele.
Convide `acac.pereira@gmail.com` como **"Profissional"** → pegue o link.

**Numa aba anônima:** abra o link → confirme que diz **"como profissional"** → logue com a
conta `acac.pereira` → **aceite**. Dê **Ctrl+Shift+R**.

### Verificação (rodar no Console F12, logado como o profissional)
```js
JSON.stringify({
  papel: currentRole,
  emEquipe: currentTeamRole,
  profId: currentProfissionalId,
  donoDados: currentDataOwner,
  meuId: currentUser && currentUser.id,
  pacientes: DB.get('pacientes').length,
  agendamentos: DB.get('agendamentos').length,
  followup: DB.get('followup').length,
  despesas: DB.get('despesas').length,
  clinica: (DB.getObj('clinica_config')||{}).nome
}, null, 2)
```

### O que cada resultado significa
| Se vier... | Significa |
|---|---|
| `papel: "profissional"` | 🎉 O convite-como-profissional sempre funcionou — o bug era só a etiqueta. Só conferir o isolamento. |
| `papel: "secretaria"` | Convite caiu como secretária de verdade → **tem bug no `accept_invite`** (investigar a função SECURITY DEFINER no Supabase + a criação do convite na UII). |
| `despesas: 0` + cards financeiros sumiram | ✅ Financeiro blindado. |
| `pacientes` = só os dele (não todos) | ✅ Isolamento por linha funcionando. |

> Se `papel` voltar `"secretaria"` apesar do convite ter sido "Profissional", o próximo
> trabalho é depurar `accept_invite` (Supabase) e a tela de criação de convite (`app.js`,
> procurar `criarConvite`/`role` no modal de equipe).

---

## 🛠️ Convenções de trabalho (importante)

- **Sempre** `node --check app.js` antes de commitar (valida sintaxe).
- **Commits:** PowerShell quebra com parênteses em here-string → escreva a mensagem num
  arquivo `.gitmsg.tmp` e use `git commit -F .gitmsg.tmp` (e apague depois).
- **Assinatura do commit:** `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- **SQL:** os arquivos `*.sql` são rodados **à mão** no SQL Editor do Supabase (idempotentes).
  Se criar/alterar tabela, lembre o usuário de rodar.
- **Edge Function (webhook):** `supabase/functions/wa-webhook/index.ts` — deploy pelo painel
  do Supabase (Verify JWT **desligado**).
- **Push = deploy.** Todo push na `main` republica na Vercel automaticamente.

---

## 📂 Mapa rápido (app.js)

- Papéis/sidebar: `_applyRole` (~929), `_atualizarSidebar` (~880), `_papelLabel` (~284),
  `showPage` (~1164, já barra páginas financeiras pra não-médico via `_PAGES_FINANCEIRO`).
- Blindagem: `_BLINDADAS` (~198), `_pushBlindada`/`_pullBlindada`/`_migrarBlindada`/
  `_sincronizarBlindadas`, `_migrarIds`, `_profDoPaciente`, `_novoId`.
- Equipe/convites: `listarConvites`, `criarConvite`, `accept_invite`/`peek_invite` (RPC Supabase).
- WhatsApp: `_zapiSendText`, `_parseZapiCreds`, `falarComPaciente`/`abrirChatPorTelefone`.
- Dashboard: `renderDashboard`, `_reorderDashboardSections`.

---

_Atualize este arquivo conforme avançar. Ele é a ponte entre as sessões (PC ↔ celular/web)._
