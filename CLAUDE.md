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
  Toda tela financeira usa ela. Regra de ouro: `recebido + aReceber + isento === bruto`.
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
