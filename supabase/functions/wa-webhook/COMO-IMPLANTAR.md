# Como implantar o wa-webhook (uma única vez)

Isso substitui o Make. Depois de implantado, cada consultório só
precisa **colar uma URL** na configuração do Z-API — sem montar
cenário nenhum.

## Passo a passo (pelo painel do Supabase — sem instalar nada)

1. Abra o painel do projeto: **https://supabase.com/dashboard/project/ipvztcqlawwslnkzmzzl**
2. No menu lateral, vá em **Edge Functions**.
3. Clique em **Deploy a new function → Via Editor** (ou "Create a new function").
4. Nome da função: **`wa-webhook`** (exatamente assim — a URL depende disso).
5. **DESLIGUE** a opção **"Verify JWT"** (é um webhook público; o Z-API não manda token do Supabase). Geralmente fica em "Advanced settings" ou num toggle ao criar.
6. Apague o código de exemplo e **cole todo o conteúdo** de `index.ts` (deste mesmo diretório).
7. Clique em **Deploy**.

> A função usa `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY`, que o
> Supabase já injeta automaticamente — você **não** precisa
> configurar nenhuma secret.

## Testar

Depois de implantar, a URL fica:

```
https://ipvztcqlawwslnkzmzzl.supabase.co/functions/v1/wa-webhook?owner=<USER_ID>
```

Abra no navegador (método GET) — deve responder **"wa-webhook ativo"**.
Pra testar de verdade, configure no Z-API (passo no app) e mande
uma mensagem.

## Como cada consultório usa (no app)

Em **Configurações → Automação total**, o app mostra a URL já pronta
com o `user_id` do médico logado e um botão **Copiar**. O médico cola
essa URL no campo de **webhook "ao receber mensagem"** do Z-API. Pronto.

## Alternativa por linha de comando (Supabase CLI)

```bash
supabase functions deploy wa-webhook --no-verify-jwt --project-ref ipvztcqlawwslnkzmzzl
```
