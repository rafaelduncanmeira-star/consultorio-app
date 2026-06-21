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
