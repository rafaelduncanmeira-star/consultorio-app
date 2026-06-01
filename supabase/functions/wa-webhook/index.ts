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

  // Não duplica: se já há um lead pendente desse número pra esse consultório, pula
  const { data: existente } = await supa
    .from('crm_leads')
    .select('id')
    .eq('user_id', owner)
    .eq('whatsapp', phone)
    .eq('processado', false)
    .limit(1);
  if (existente && existente.length) {
    return json({ ok: true, skipped: 'já existe lead pendente' });
  }

  const { error } = await supa.from('crm_leads').insert({
    user_id: owner,
    nome,
    whatsapp: phone,
    primeira_mensagem: mensagem,
    canal: 'WhatsApp',
    processado: false,
  });
  if (error) return json({ error: error.message }, 500);

  return json({ ok: true, nome, whatsapp: phone });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
