// ============================================================
// wa-webhook — recebe mensagens do WhatsApp e cria contatos no CRM
// ------------------------------------------------------------
// Suporta DOIS provedores no mesmo endpoint:
//   • Z-API (gateway pago)        → POST com payload "plano"
//   • WhatsApp Cloud API (Meta)   → POST aninhado (entry/changes/value)
//                                   + verificação GET (hub.challenge)
//
// O consultório cola UMA URL na config de webhook do provedor:
//   https://<projeto>.supabase.co/functions/v1/wa-webhook?owner=<USER_ID>
//
// O ?owner=<USER_ID> diz a qual consultório o contato pertence.
// Usa a service role key (env do Supabase) p/ inserir ignorando o RLS.
//
// IMPORTANTE ao implantar: desligar "Verify JWT" (webhook público).
// Para a Cloud API, definir a variável de ambiente WA_VERIFY_TOKEN com
// o mesmo "Verify token" cadastrado no painel da Meta.
// ============================================================

import { createClient } from 'jsr:@supabase/supabase-js@2';

Deno.serve(async (req) => {
  const url = new URL(req.url);

  // --- GET: verificação da Cloud API (Meta) ou health check ---
  if (req.method === 'GET') {
    const mode      = url.searchParams.get('hub.mode');
    const challenge = url.searchParams.get('hub.challenge');
    const verify    = url.searchParams.get('hub.verify_token');
    if (mode === 'subscribe' && challenge) {
      const expected = Deno.env.get('WA_VERIFY_TOKEN');
      // Se não há token configurado, aceita (facilita o primeiro setup);
      // se há, exige que bata — senão recusa.
      if (!expected || verify === expected) {
        return new Response(challenge, { status: 200 });
      }
      return new Response('verify_token inválido', { status: 403 });
    }
    return new Response('wa-webhook ativo', { status: 200 });
  }
  if (req.method !== 'POST') {
    return new Response('Método não permitido', { status: 405 });
  }

  const owner = url.searchParams.get('owner');
  const prof  = url.searchParams.get('prof'); // opcional: número por profissional
  if (!owner) {
    return json({ error: 'Faltou ?owner=<user_id> na URL do webhook.' }, 400);
  }

  let p: any;
  try { p = await req.json(); } catch { return json({ error: 'corpo inválido' }, 400); }

  // Normaliza o payload dos dois provedores para { phone, nome, mensagem }.
  const msg = normalizarEntrada(p);
  if (!msg.ok) {
    return json({ ok: true, skipped: msg.motivo });
  }
  const phone = msg.phone.replace(/\D/g, '');
  if (!phone || phone.length < 10) {
    return json({ ok: true, skipped: 'sem telefone válido' });
  }
  const nome    = msg.nome || 'Contato WhatsApp';
  const mensagem = (msg.mensagem && String(msg.mensagem).trim()) || '[mensagem sem texto]';

  const supa = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // Chave do chat: o app salva o contato SEM o 55 inicial (ex.: "8199158387").
  const phoneChat = phone.replace(/^55/, '');

  // 1) SEMPRE registra a mensagem recebida no histórico (crm_messages).
  const { error: msgErr } = await supa.from('crm_messages').insert({
    user_id: owner,
    whatsapp: phoneChat,
    remetente: 'contato',
    mensagem,
  });
  if (msgErr) return json({ error: 'crm_messages: ' + msgErr.message }, 500);

  // 2) Cria o card no CRM só se ainda não existir um lead desse número.
  const { data: existente } = await supa
    .from('crm_leads')
    .select('id')
    .eq('user_id', owner)
    .eq('whatsapp', phone)
    .limit(1);

  let leadNovo = false;
  if (!(existente && existente.length)) {
    const leadObj: any = {
      user_id: owner,
      nome,
      whatsapp: phone,
      primeira_mensagem: mensagem,
      canal: 'WhatsApp',
      processado: false,
    };
    if (prof) leadObj.profissional_id = prof;
    const { error } = await supa.from('crm_leads').insert(leadObj);
    if (error) return json({ error: error.message }, 500);
    leadNovo = true;
  }

  // 3) ── GANCHO DA SECRETÁRIA POR IA (Fase 2) ──
  // Aqui a IA vai entrar: ler o histórico desta conversa, montar o contexto
  // (procedimentos, preços, agenda), chamar o modelo e responder pelo provedor
  // de WhatsApp ativo. Está DESLIGADA por padrão (env WA_AI_ENABLED != '1').
  await maybeAutoReply({ supa, owner, phone, phoneChat, nome, mensagem });

  return json({ ok: true, stored: leadNovo ? 'mensagem + lead' : 'mensagem', nome, whatsapp: phone });
});

// ------------------------------------------------------------
// Normaliza a entrada dos dois provedores.
// Retorna { ok, phone, nome, mensagem } ou { ok:false, motivo }.
function normalizarEntrada(p: any): any {
  // --- WhatsApp Cloud API (Meta): payload aninhado ---
  if (p && (p.object === 'whatsapp_business_account' || Array.isArray(p.entry))) {
    const value = p?.entry?.[0]?.changes?.[0]?.value;
    if (!value) return { ok: false, motivo: 'cloud: sem value' };
    // Callbacks de status de entrega (sent/delivered/read) — ignora.
    if (value.statuses && !value.messages) return { ok: false, motivo: 'cloud: status de entrega' };
    const m = value?.messages?.[0];
    if (!m) return { ok: false, motivo: 'cloud: sem mensagem' };
    const nome = value?.contacts?.[0]?.profile?.name || '';
    const texto =
      (m.text && m.text.body) ||
      (m.button && m.button.text) ||
      (m.interactive && (m.interactive.button_reply?.title || m.interactive.list_reply?.title)) ||
      (m.image ? '[imagem]' : '') || (m.audio ? '[áudio]' : '') ||
      (m.document ? '[documento]' : '') || (m.video ? '[vídeo]' : '') ||
      (m.location ? '[localização]' : '') || '';
    return { ok: true, phone: String(m.from || ''), nome, mensagem: texto };
  }

  // --- Z-API: payload plano (comportamento original) ---
  if (p.fromMe === true || p.isGroup === true || p.isStatusReply === true || p.isNewsletter === true) {
    return { ok: false, motivo: 'própria/grupo/status' };
  }
  const phoneRaw = (p.phone ?? p.from ?? p.participantPhone ?? '').toString();
  const nome = p.senderName || p.chatName || p.pushName || p.notifyName || '';
  const mensagem =
    (p.text && (p.text.message || p.text.body)) ||
    p.body || p.message || p.caption ||
    (p.image ? '[imagem]' : '') || (p.audio ? '[áudio]' : '') || '';
  return { ok: true, phone: phoneRaw, nome, mensagem };
}

// ------------------------------------------------------------
// Stub da secretária por IA. Inerte enquanto WA_AI_ENABLED != '1'.
// Na Fase 2, aqui dentro: buscar histórico em crm_messages, montar prompt
// com a base da clínica, chamar o LLM, e responder via Cloud API / Z-API,
// gravando a resposta como remetente='consultorio' em crm_messages.
async function maybeAutoReply(_ctx: any): Promise<void> {
  if (Deno.env.get('WA_AI_ENABLED') !== '1') return;
  // TODO Fase 2: integração da IA (Claude/Groq) + envio da resposta.
  return;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
