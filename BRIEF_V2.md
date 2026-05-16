# Consultório App — Briefing para a V2.0

## Roadmap do produto

| Versão | O que tem |
|--------|-----------|
| **V1.0** | App completo + caixa de entrada WhatsApp integrada ao CRM (Z-API opcional, operada pela secretária) |
| **V2.0** | Tudo da V1.0 + IA receptionist que atende, informa valores, agenda e converte automaticamente |

**A única diferença entre V1.0 e V2.0 é a camada de inteligência artificial.**

---

## O que já existe (V1.0 — base)

Aplicativo de gestão de consultório médico — SPA puro em HTML/CSS/JS.
Repositório GitHub: `rafaelduncanmeira-star/consultorio-app`
Arquivos principais: `index.html` e `app.js`
Deploy automático na Vercel a cada push no GitHub.

**Stack técnica:**
- Frontend: HTML + CSS + JS puro (sem framework)
- Banco de dados: localStorage com write-through para Supabase
- Supabase URL: `https://ipvztcqlawwslnkzmzzl.supabase.co`
- Tabela principal: `app_data` (chave/valor JSON)
- Autenticação: Supabase Auth (email/senha)
- Tabela de perfis: `profiles` (campos: id, role, nome)

**Páginas do app:**
Dashboard, CRM/Kanban, Pacientes, Agenda, Receita, Despesas, Relatório, Follow-Up, Metas, Backup, Configurações

**CRM atual (estrutura de cada contato):**
```js
{
  data, hora, nome, whatsapp, idade,
  canal, tipo, status, obs
}
// Armazenado em DB.get('crm') → localStorage 'consult_crm' → Supabase app_data key='crm'
```

**Status do CRM:** Contato feito → Em negociação → Marcou → Atendeu → Não marcou

---

## O que ainda falta na V1.0 (construir agora)

### Integração Z-API (opcional — usuário conecta se quiser)

**Fluxo V1.0:**
```
Paciente manda mensagem no WhatsApp
→ Z-API captura e envia para Make
→ Make insere em Supabase (crm_leads + crm_messages)
→ Card aparece automaticamente no Kanban
→ Secretária abre o card → conversa aparece do lado direito
→ Secretária responde de dentro do app
→ Mensagem sai pelo WhatsApp normalmente
```

**Novas tabelas Supabase necessárias:**
- `crm_leads` — contatos vindos do WhatsApp (nome, telefone, primeira mensagem, data)
- `crm_messages` — histórico completo de cada conversa (remetente, texto, timestamp)

**Interface a construir no app:**
- Tela de configuração Z-API (Instance ID + Token) em Configurações
- Chat panel dentro do CRM: Kanban à esquerda, conversa à direita ao clicar no card
- Badge de mensagem nova no card
- Realtime via Supabase para mensagens chegando ao vivo

**Peças externas:**
- Z-API (app.zapi.io) — Instance ID + Token após conectar o número
- Make (make.com) — plano gratuito, cenário: Z-API webhook → Supabase insert

---

## O que a V2.0 adiciona sobre a V1.0

**Única diferença:** uma IA (Claude API ou OpenAI) entra no fluxo entre o Z-API e a secretária.

**Fluxo V2.0:**
```
Paciente manda mensagem
→ IA recebe, entende, responde automaticamente
→ IA informa procedimentos e valores
→ IA verifica disponibilidade na agenda do sistema
→ IA confirma agendamento
→ Card vai para "Marcou" automaticamente
→ Secretária supervisiona, intervém só quando necessário
```

**O que a IA precisa saber (configurar em V2.0):**
- Lista de procedimentos com valores
- Regras de agendamento (dias, horários, duração por procedimento)
- Tom de voz desejado
- Quando escalar para humano

---

## Como começar a sessão V2.0

Diga ao Claude:

> "Estou construindo a V2.0 do meu app de consultório. Leia o arquivo BRIEF_V2.md para entender o contexto. A V1.0 já tem a integração Z-API funcionando. Agora quero adicionar a camada de IA para atendimento automático no WhatsApp."

O arquivo está em:
`C:\Users\Rafael Duncan\consultorio-app\BRIEF_V2.md`
