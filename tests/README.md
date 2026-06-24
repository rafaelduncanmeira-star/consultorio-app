# Testes

Testes automatizados da lógica crítica do app — **sem dependências externas**
(usam só o `node:test` e o `node:vm`, nativos do Node ≥ 18).

## Como rodar

```bash
node --test
```

> ⚠️ **Não** adicione um `package.json` na raiz só pra isso: o deploy na Vercel
> é estático, e um `package.json` pode fazer a Vercel tentar um build e quebrar
> a publicação. Rode os testes pela linha de comando acima.

## Como funciona

`_extrair.js` lê o **código-fonte real** do `app.js`, recorta a função pedida
(casando chaves) e a executa num sandbox isolado com os globais de browser
stubados (`DB`, `localStorage`, `currentRole`, ...). Assim os testes exercitam
exatamente o que roda em produção, sem precisar carregar o `app.js` inteiro
(que dispararia init, listeners e Supabase).

## O que está coberto (`seguranca.test.js`)

- **`_esc`** — escape de HTML anti-XSS (tags, atributos, nulos, falso-positivo).
- **`_limparSensiveisProfissional`** — blindagem do financeiro: profissional perde
  despesas/metas do localStorage; médico/secretária mantêm tudo.
- **`_profDoPaciente`** — resolução do dono do paciente (isolamento por profissional).

## Como adicionar um teste

```js
const { carregar } = require('./_extrair.js');
const { minhaFuncao } = carregar('minhaFuncao', { /* globais stubados */ });
```

Mantenha o foco em **funções puras** ou facilmente stubáveis. Para fluxos que
dependem do DOM/Supabase, prefira extrair a lógica pura primeiro.
