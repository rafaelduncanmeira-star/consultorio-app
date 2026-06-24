# 📲 WhatsApp — provedor plugável (Z-API ↔ Cloud API oficial)

O app agora suporta **dois provedores de WhatsApp**, escolhidos em
**Configurações → WhatsApp**. Só um fica ativo por vez (ligar um desliga o outro).

| Provedor | Quando usar | Custo |
|---|---|---|
| **WhatsApp oficial (Meta)** | Recomendado. Atender (receber+responder) é grátis; lembrete proativo paga centavos. Sem risco de ban. | Pague-por-template |
| **Z-API** | Já funcionava; continua como opção. | Mensalidade fixa |

A escolha vive em `wa_provider` (`'zapi'` | `'cloud'`); a config da Meta em
`wa_cloud_config`. Tudo sincroniza pelo Supabase como as demais chaves.

---

## ✅ Passo a passo — ligar a Cloud API (Meta)

> Só você consegue fazer esta parte (conta Meta). O app já está pronto do lado do código.

1. **Meta Business + verificação da empresa** em [business.facebook.com](https://business.facebook.com) (pede CNPJ/comprovante; leva de horas a dias).
2. **Criar um app** em [developers.facebook.com](https://developers.facebook.com) → produto **WhatsApp**.
3. **Número dedicado:** registre um número que **não** esteja no WhatsApp normal.
4. No painel do WhatsApp do app, pegue:
   - **Phone Number ID** (não é o telefone — é o ID numérico)
   - **Access Token** (gere um **permanente**, via System User, senão expira em 24h)
5. No app → **Configurações → WhatsApp → WhatsApp oficial (Meta)**: ligue o toggle,
   cole **Phone Number ID** e **Access Token**, clique **Salvar** e **Testar conexão**.

### Webhook (para receber mensagens)
6. No **Supabase**, defina a variável de ambiente da Edge Function:
   - `WA_VERIFY_TOKEN` = uma senha qualquer que você inventar (ex.: `maestria-2026`)
   - (opcional Fase 2) `WA_AI_ENABLED` = `1` só quando a secretária por IA estiver pronta.
7. No painel da Meta → **WhatsApp → Configuration → Webhook**:
   - **Callback URL:** o valor mostrado no app (`…/wa-webhook?owner=SEU_ID`)
   - **Verify token:** o mesmo `WA_VERIFY_TOKEN` do passo 6
   - **Assine** o campo **messages**.
8. Mantenha o webhook com **Verify JWT desligado** no Supabase (é público).

> A mesma URL `wa-webhook` atende os dois provedores — não precisa trocar nada
> se um dia voltar pro Z-API.

---

## 📝 Templates (mensagens proativas)

Mensagem **dentro** da janela de 24h (paciente escreveu primeiro) = texto livre, **grátis**.
Mensagem **fora** da janela (lembrete, reativação) = precisa de **template aprovado**.

Cadastre em **WhatsApp Manager → Modelos de mensagem**. Depois cole o **nome** do
template de lembrete no campo "Template de lembrete" do app.

### 1) Lembrete de consulta — categoria **UTILITY** (barato, ~R$0,05)
Mantém-se utilidade porque cita um compromisso concreto, sem tom promocional.

**Nome:** `lembrete_consulta`
**Idioma:** Português (BR) — `pt_BR`
**Corpo:**
```
Olá! Passando para lembrar do seu horário na nossa clínica. {{1}}

Se precisar remarcar ou cancelar, é só responder esta mensagem. Até breve!
```
- `{{1}}` recebe os detalhes (data/hora/profissional) montados pelo app.
- ❌ Não use "promoção", "desconto", "aproveite", emoji de venda — vira marketing.

### 2) Reativação de paciente — categoria **MARKETING** (~R$0,38)
Use só para os ~10% de reengajamento. É marketing porque convida a voltar.

**Nome:** `reativacao_paciente`
**Idioma:** `pt_BR`
**Corpo:**
```
Olá, {{1}}! Faz um tempo desde a sua última consulta com a gente.

Que tal agendar um retorno para manter seu acompanhamento em dia? Responda esta
mensagem que cuidamos do seu horário.
```
- `{{1}}` = nome do paciente.

---

## 🤖 Secretária por IA — modos (tudo desligado por padrão)

O app tem 3 níveis, todos com interruptor próprio em **Configurações → Secretária por IA**:

1. **Copiloto** (padrão, já usável): a IA sugere a resposta no chat do CRM; o humano
   envia. Roda no navegador.
2. **Modo autônomo** (`ia_config.autonomo`): a IA responde o paciente **sozinha**. Roda
   no webhook `wa-webhook` (`maybeAutoReply`), que lê conhecimento/LLM/provedor de
   `app_data` por owner, gera, envia e registra no CRM. **Requer o webhook implantado.**
3. **Agendar** (`ia_config.agendar`): a IA consulta horários livres reais e marca via
   marcador `[[AGENDAR: data hora | proc]]`. Modo padrão **PENDENTE** (humano confirma
   na agenda); opção "direto" cria já Confirmado. Cria linha em `clinica_agendamentos`.

**Motor de IA plugável:** Groq (grátis, padrão) ou Claude (Anthropic) — escolhido no
mesmo card (`llm_config`). Sem env nova: os toggles controlam tudo.

> ⚠️ Os modos 2 e 3 ainda **não foram validados em execução real** (webhook + LLM ao
> vivo). Teste em uma conversa de teste antes de usar com pacientes. O padrão PENDENTE
> do agendamento é a rede de segurança: mesmo ligado, um humano confirma cada marcação.

---

## 🧩 Mapa técnico (para o Claude da próxima sessão)

- **Seleção/config:** `getWaProvider`/`setWaProvider`, `getCloudConfig`, `_waConnected` (app.js).
- **Envio:** `_cloudSendText`, `_cloudSendTemplate`, dispatcher `_waSendText`; lembrete em `_enviarLembreteZapi` (agora multi-provedor).
- **UI:** card "WhatsApp oficial (Meta)" em `index.html`; handlers `_cloudToggleChange`/`saveCloudConfig`/`testCloudConnection`/`_applyCloudUI`.
- **Webhook:** `supabase/functions/wa-webhook/index.ts` — `normalizarEntrada()` cobre Z-API e Cloud; GET trata `hub.challenge`.
- **Exclusão mútua:** ligar um provedor desliga o outro (em `_zapiToggleChange`/`_cloudToggleChange`).

> ⚠️ **Atenção (segurança):** hoje o envio acontece no navegador (igual ao Z-API),
> então o Access Token fica no localStorage. Para produção comercial, o ideal é
> mover o envio da Cloud API para uma Edge Function (token só no servidor). Fica
> como próximo passo recomendado.
