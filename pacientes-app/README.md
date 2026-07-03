# Vitalis — Acompanhamento de Pacientes (SaaS)

App novo e independente do Maestria: plataforma de acompanhamento de pacientes
com **duas visões** — a da clínica/profissional e a do paciente (PWA instalável).

**Stack:** Next.js (App Router) + TypeScript + Tailwind + Supabase (Postgres/Auth/RLS).

## Estado atual (M1 — Fundação)

- ✅ Login/cadastro (Supabase Auth) e onboarding (primeiro login cria a clínica)
- ✅ Cadastro de pacientes (lista, perfil, edição)
- ✅ Convite do paciente: link `/convite/<token>` → paciente cria conta → entra na visão dele
- ✅ Visão do paciente (PWA): abas Hoje, Consultas, Programa e Chat (conteúdo chega nos próximos marcos)
- 🔜 M2 agenda/consultas · M3 plano de cuidado + lembretes push + adesão · M4 programas · M5 chat · M6 billing

## Setup (uma vez)

### 1. Supabase

1. Crie um projeto **novo** em [supabase.com](https://supabase.com) (não use o projeto do Maestria).
2. No **SQL Editor**, rode o conteúdo de `supabase/migrations/0001_core.sql` (é idempotente).
3. Em **Authentication → Providers → Email**: para testar sem fricção, desative
   temporariamente "Confirm email" (ou configure SMTP). Com confirmação ligada o
   fluxo também funciona — o paciente confirma o e-mail e volta pelo link do convite.
4. Em **Project Settings → API**, copie a URL e a chave `anon`.

### 2. Rodar localmente

```bash
cd pacientes-app
cp .env.example .env.local   # preencha com URL e anon key do Supabase
npm install
npm run dev
```

### 3. Deploy (Vercel)

Crie um **projeto novo** na Vercel apontando para este repositório com
**Root Directory = `pacientes-app`**, e configure as duas variáveis de ambiente
(`NEXT_PUBLIC_SUPABASE_URL` e `NEXT_PUBLIC_SUPABASE_ANON_KEY`).
O deploy do app do consultório (raiz do repo) não é afetado.

## Fluxo de teste (M1)

1. Acesse `/cadastro`, crie sua conta profissional e dê nome à clínica.
2. Em **Pacientes → Novo paciente**, cadastre um paciente.
3. No perfil dele, clique em **Gerar convite** e copie o link.
4. Abra o link numa aba anônima, crie a conta do paciente → ele cai na visão dele.
5. De volta à visão pro, o paciente aparece como **conectado**.

## Segurança (RLS)

- Membros da clínica só enxergam dados da própria clínica (`app.is_member`).
- O paciente só enxerga a própria linha em `patients` (e nada da clínica).
- Convites são aceitos por RPC `SECURITY DEFINER` com validações
  (expiração, uso único, não permite "roubar" paciente já vinculado,
  membro da equipe não pode virar paciente da própria clínica).

## Convenções

- Migrações SQL numeradas em `supabase/migrations/`, sempre idempotentes.
- `npm run build && npm run lint` antes de commit.
- Nunca criar `package.json` na raiz do repositório (quebra o deploy estático do app antigo).
