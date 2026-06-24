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

1. **Motor de IA plugável (Groq ↔ Claude):** `getLlmConfig()` + `_llmChat({system,messages})`
   no app.js (dispatcher). Copiloto já usa. UI no card da IA (seletor + chave do Claude).
   Config em `llm_config` (sincronizada). Default Groq (grátis).
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
