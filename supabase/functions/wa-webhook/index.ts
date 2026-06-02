// ============================================================
// wa-webhook — recebe mensagens do Z-API e cria contatos no CRM
// ------------------------------------------------------------
// Substitui a necessidade do Make. O consultório só precisa colar
// UMA URL na configuração de webhook do Z-API:
//
//   https://<projeto>.supabase.co/functions/v1/wa-webhook?owner=<USER_ID>
//
// O ?owner=<USER_ID> diz a qual consultório o contato pertence.
// A função usa a service role key (já disponível como variável de
// ambiente no Supabase) para inserir em crm_leads, ignorando o RLS.
//
// IMPORTANTE ao implantar: desligar "Verify JWT" (é um webhook
// público — o Z-API não manda token do Supabase).
// ============================================================

import { createClient } from 'jsr:@supabase/supabase-js@2';

Deno.serve(async (req) => {
  // Health check / verificação simples
  if (req.method === 'GET') {
    return new Response('wa-webhook ativo', { status: 200 });
  }
  if (req.method !== 'POST') {
    return new Response('Método não permitido', { status: 405 });
  }

  const url = new URL(req.url);
  const owner = url.searchParams.get('owner');
  const prof  = url.searchParams.get('prof'); // opcional: número por profissional (Tijolo 4B)
  if (!owner) {
    return json({ error: 'Faltou ?owner=<user_id> na URL do webhook.' }, 400);
  }

  let p: any;
  try { p = await req.json(); } catch { return json({ error: 'corpo inválido' }, 400); }

  // Ignora o que não é mensagem recebida de pessoa (minhas mensagens, grupos, status)
  if (p.fromMe === true || p.isGroup === true || p.isStatusReply === true || p.isNewsletter === true) {
    return json({ ok: true, skipped: 'própria/grupo/status' });
  }

  // Extração defensiva (o payload do Z-API varia entre versões)
  const phoneRaw = (p.phone ?? p.from ?? p.participantPhone ?? '').toString();
  const phone = phoneRaw.replace(/\D/g, '');
  if (!phone || phone.length < 10) {
    return json({ ok: true, skipped: 'sem telefone válido' });
  }

  const nome =
    p.senderName || p.chatName || p.pushName || p.notifyName ||
    (p.senderPhoto ? '' : '') || 'Contato WhatsApp';

  const mensagem =
    (p.text && (p.text.message || p.text.body)) ||
    p.body || p.message || p.caption ||
    (p.image ? '[imagem]' : '') || (p.audio ? '[áudio]' : '') || '';

  const supa = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // Chave do chat: o app salva o contato SEM o 55 inicial (ex.: "8199158387").
  // Gravamos a mensagem com a mesma chave, senão ela não aparece na conversa.
  const phoneChat = phone.replace(/^55/, '');
  const texto = (mensagem && String(mensagem).trim()) || '[mensagem sem texto]';

  // 1) SEMPRE registra a mensagem recebida no histórico do chat (crm_messages).
  //    É isso que faz a mensagem aparecer na conversa e permite responder.
  const { error: msgErr } = await supa.from('crm_messages').insert({
    user_id: owner,
    whatsapp: phoneChat,
    remetente: 'contato',
    mensagem: texto,
  });
  if (msgErr) return json({ error: 'crm_messages: ' + msgErr.message }, 500);

  // 2) Cria o card no CRM só se ainda não existir um lead desse número
  //    (evita cards duplicados pra quem já está no funil; as mensagens
  //    seguintes continuam sendo gravadas no passo 1).
  const { data: existente } = await supa
    .from('crm_leads')
    .select('id')
    .eq('user_id', owner)
    .eq('whatsapp', phone)
    .limit(1);
  if (existente && existente.length) {
    return json({ ok: true, stored: 'mensagem', lead: 'já existe' });
  }

  const leadObj: any = {
    user_id: owner,
    nome,
    whatsapp: phone,
    primeira_mensagem: texto,
    canal: 'WhatsApp',
    processado: false,
  };
  // Só inclui profissional_id quando veio na URL (evita depender da coluna
  // se o número for compartilhado / o SQL ainda não tiver rodado).
  if (prof) leadObj.profissional_id = prof;
  const { error } = await supa.from('crm_leads').insert(leadObj);
  if (error) return json({ error: error.message }, 500);

  return json({ ok: true, stored: 'mensagem + lead', nome, whatsapp: phone });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
