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

  // 3) ── SECRETÁRIA POR IA (modo autônomo) ──
  // Responde sozinha SE ia_config.autonomo estiver ligado (desligado por padrão).
  // Lê conhecimento/LLM/provedor de app_data, gera, envia e registra no CRM.
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
// SECRETÁRIA POR IA — MODO AUTÔNOMO (responde sozinha).
// Gated por ia_config.autonomo (toggle no app, DESLIGADO por padrão).
// Reusa as mesmas configs do app (lidas de app_data por owner): conhecimento,
// motor de LLM (Groq/Claude) e provedor de WhatsApp. Se ia_config.agendar
// estiver ligado, a IA pode marcar via marcador [[AGENDAR: data hora | proc]].
async function maybeAutoReply(ctx: any): Promise<void> {
  const { supa, owner, phone, phoneChat, nome } = ctx;
  try {
    const ia = await lerAppData(supa, owner, 'ia_config', null);
    if (!ia || !ia.autonomo) return; // só age com o modo autônomo ligado

    // Histórico recente da conversa
    const { data: histRaw } = await supa.from('crm_messages')
      .select('remetente,mensagem,created_at')
      .eq('user_id', owner).eq('whatsapp', phoneChat)
      .order('created_at', { ascending: false }).limit(16);
    const historico = (histRaw || []).reverse();

    // Conhecimento da clínica
    const proc  = await lerAppData(supa, owner, 'procedimentos', []);
    const prog  = await lerAppData(supa, owner, 'programas', []);
    const agcfg = await lerAppData(supa, owner, 'agenda_config', { horaInicio: '08:00', horaFim: '18:00', slotDuracao: 60, diasUteis: [1,2,3,4,5] });
    const clin  = await lerAppData(supa, owner, 'clinica_config', {});

    // Disponibilidade real (só se a IA pode agendar)
    let disponibilidade = '';
    if (ia.agendar) {
      const ags = await lerAgendamentos(supa, owner);
      disponibilidade = montarDisponibilidade(agcfg, ags);
    }

    const system = montarSystemPromptServer({ ia, proc, prog, agcfg, clin, disponibilidade });
    const messages = historico.map((m: any) => ({
      role: m.remetente === 'consultorio' ? 'assistant' : 'user',
      content: m.mensagem || ''
    }));

    // LLM (Groq por padrão; Claude se configurado)
    const llm = await lerAppData(supa, owner, 'llm_config', { provider: 'groq' });
    const groqKey = await lerAppData(supa, owner, 'gemini_key_secure', '');
    const r = await chamarLLMServer(llm, groqKey, system, messages);
    if (!r.ok) { console.log('[IA] LLM erro:', r.error); return; }
    let texto = r.texto;

    // Marcador de agendamento
    if (ia.agendar) {
      const m = texto.match(/\[\[AGENDAR:\s*(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})\s*(?:\|\s*([^\]]+))?\]\]/);
      if (m) {
        texto = texto.replace(m[0], '').trim();
        await criarAgendamentoPendente(supa, owner, {
          data: m[1], hora: m[2], procedimento: (m[3] || '').trim(),
          pacienteNome: nome || 'Paciente WhatsApp', whatsapp: phone,
          modo: ia.agendarModo || 'pendente',
        });
      }
    }
    if (!texto) return;

    // Envia pelo provedor ativo (server-side)
    const env = await enviarWhatsAppServer(supa, owner, phone, texto);
    if (!env.ok) { console.log('[IA] envio falhou:', env.error); return; }

    // Registra a resposta no CRM (a secretária vê tudo)
    await supa.from('crm_messages').insert({ user_id: owner, whatsapp: phoneChat, remetente: 'consultorio', mensagem: texto });
  } catch (e) {
    console.log('[IA] erro inesperado:', (e as Error).message);
  }
}

// Lê uma chave de app_data (configs/conhecimento) pelo owner.
async function lerAppData(supa: any, owner: string, key: string, def: any): Promise<any> {
  const { data } = await supa.from('app_data').select('value').eq('user_id', owner).eq('key', key).limit(1);
  return (data && data[0] && data[0].value != null) ? data[0].value : def;
}

// Lê agendamentos (coleção blindada: 1 linha por registro).
async function lerAgendamentos(supa: any, owner: string): Promise<any[]> {
  const { data } = await supa.from('clinica_agendamentos').select('data').eq('owner_id', owner);
  return (data || []).map((r: any) => r.data).filter(Boolean);
}

// Monta o prompt do servidor (espelha o do app + data atual + marcador).
function montarSystemPromptServer(k: any): string {
  const nomeClin = (k.clin && k.clin.nome) || 'a clínica';
  const fmtBRL = (v: number) => 'R$ ' + Number(v || 0).toLocaleString('pt-BR');
  const procs = (k.proc || []).filter((p: any) => p.valorPix || p.valorCartao).map((p: any) => {
    const partes = [];
    if (p.valorPix) partes.push(`PIX/dinheiro ${fmtBRL(p.valorPix)}`);
    if (p.valorCartao) partes.push(`cartão ${fmtBRL(p.valorCartao)}`);
    return `- ${p.nome}: ${partes.join(' · ') || 'sob consulta'}${p.obs ? ' (' + p.obs + ')' : ''}`;
  }).join('\n') || '- (nenhum procedimento com valor cadastrado)';
  const progs = (k.prog || []).filter((p: any) => p.ativo !== false)
    .map((p: any) => `- ${p.nome} (${p.tipo})${p.precoAVista ? ' — à vista ' + fmtBRL(p.precoAVista) : ''}`).join('\n');
  const diasNomes = ['domingo','segunda','terça','quarta','quinta','sexta','sábado'];
  const dias = (k.agcfg.diasUteis || []).map((d: number) => diasNomes[d]).filter(Boolean).join(', ') || 'dias úteis';
  const hoje = new Date().toISOString().substring(0, 10);

  const linhas = [
    `Você é a secretária virtual de ${nomeClin}, atendendo pacientes pelo WhatsApp. Hoje é ${hoje}.`,
    `Seu papel é APENAS: tirar dúvidas sobre valores, horários e informações de atendimento, e ajudar a marcar/remarcar consultas.`,
    ``,
    `REGRAS INEGOCIÁVEIS:`,
    `- NUNCA dê conselho, diagnóstico ou orientação médica/clínica. Se perguntarem sobre sintomas, exames ou tratamento, diga com cordialidade que o profissional avalia na consulta e ofereça agendar.`,
    `- NUNCA invente preços, horários ou disponibilidade que não estejam listados abaixo. Se não souber, diga que vai confirmar com a equipe.`,
    `- Seja breve e natural (é WhatsApp): 1 a 3 frases, tom humano.`,
    `- Se o paciente pedir humano, estiver irritado, ou for assunto delicado/fora do escopo, diga gentilmente que a equipe assume.`,
    ``,
    `PROCEDIMENTOS E VALORES:`,
    procs,
  ];
  if (progs) linhas.push(``, `PLANOS/PROGRAMAS:`, progs);
  linhas.push(``, `HORÁRIO DE ATENDIMENTO: ${dias}, das ${k.agcfg.horaInicio} às ${k.agcfg.horaFim}.`);
  if (k.ia.tom) linhas.push(``, `TOM DE VOZ: ${k.ia.tom}`);
  if (k.ia.instrucoes) linhas.push(``, `INSTRUÇÕES EXTRAS DA CLÍNICA: ${k.ia.instrucoes}`);
  if (k.ia.agendar) {
    linhas.push(
      ``,
      `AGENDAMENTO: você pode marcar. Estes são os horários LIVRES (não ofereça outros):`,
      k.disponibilidade || '(sem horários livres nos próximos dias)',
      `Quando — e SÓ quando — o paciente confirmar um horário específico desta lista, inclua no FINAL da sua resposta, em uma linha separada, o marcador exato:`,
      `[[AGENDAR: AAAA-MM-DD HH:MM | procedimento]]`,
      `Não mostre esse marcador como texto normal nem o explique; ele é processado pelo sistema. Confirme ao paciente de forma natural que vai reservar o horário.`,
    );
  }
  return linhas.join('\n');
}

// Calcula horários livres dos próximos dias úteis (compacto p/ o prompt).
function montarDisponibilidade(agcfg: any, ags: any[]): string {
  const dur = agcfg.slotDuracao || 60;
  const diasUteis = agcfg.diasUteis || [1,2,3,4,5];
  const ocupados = new Set((ags || [])
    .filter((a: any) => a && a.status !== 'Cancelado')
    .map((a: any) => `${a.data} ${a.hora}`));
  const [hi, mi] = String(agcfg.horaInicio || '08:00').split(':').map(Number);
  const [hf] = String(agcfg.horaFim || '18:00').split(':').map(Number);
  const out: string[] = [];
  let diasListados = 0;
  const base = new Date();
  for (let i = 1; i <= 21 && diasListados < 7; i++) {
    const d = new Date(base.getTime() + i * 86400000);
    if (!diasUteis.includes(d.getDay())) continue;
    const ds = d.toISOString().substring(0, 10);
    const livres: string[] = [];
    for (let min = hi * 60 + mi; min + dur <= hf * 60 && livres.length < 4; min += dur) {
      const hh = String(Math.floor(min / 60)).padStart(2, '0');
      const mm = String(min % 60).padStart(2, '0');
      const slot = `${hh}:${mm}`;
      if (!ocupados.has(`${ds} ${slot}`)) livres.push(slot);
    }
    if (livres.length) { out.push(`- ${ds}: ${livres.join(', ')}`); diasListados++; }
  }
  return out.join('\n');
}

// Cria um agendamento (PENDENTE por padrão) na coleção blindada.
async function criarAgendamentoPendente(supa: any, owner: string, p: any): Promise<void> {
  const id = 'ag_ia_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
  const status = p.modo === 'direto' ? 'Confirmado' : 'Pendente';
  const ag = {
    id, data: p.data, hora: p.hora, duracao: 60,
    pacienteNome: p.pacienteNome, whatsapp: p.whatsapp,
    procedimento: p.procedimento || '', profissionalId: null,
    status, obs: 'Criado pela secretária IA', tipoAtividade: 'Consultório',
    crmIdx: null, pacIdx: null, crmId: null, pacId: null, _viaIa: true,
  };
  await supa.from('clinica_agendamentos').insert({
    id, owner_id: owner, profissional_id: null, data: ag, updated_at: new Date().toISOString(),
  });
}

// Chama o LLM no servidor (Groq formato OpenAI; Claude formato Anthropic).
async function chamarLLMServer(llm: any, groqKey: string, system: string, messages: any[]): Promise<any> {
  try {
    if (llm && llm.provider === 'claude') {
      if (!llm.claudeKey) return { error: 'sem chave Claude' };
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': llm.claudeKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: llm.claudeModel || 'claude-haiku-4-5-20251001', max_tokens: 400, system, messages }),
      });
      if (!res.ok) return { error: 'Claude ' + res.status + ': ' + (await res.text()).substring(0, 120) };
      const j = await res.json();
      const texto = (j.content?.[0]?.text || '').trim();
      return texto ? { ok: true, texto } : { error: 'resposta vazia' };
    }
    // Provedores compatíveis com OpenAI: Groq, OpenRouter ou personalizado.
    let url: string, key: string, model: string;
    const extraHeaders: any = {};
    if (llm && llm.provider === 'openrouter') {
      url = 'https://openrouter.ai/api/v1/chat/completions';
      key = llm.openrouterKey || '';
      model = llm.openrouterModel || 'anthropic/claude-3.5-haiku';
      extraHeaders['X-Title'] = 'Maestria de Consultorio';
    } else if (llm && llm.provider === 'custom') {
      url = llm.customUrl || '';
      key = llm.customKey || '';
      model = llm.customModel || '';
      if (!url || !model) return { error: 'provedor personalizado incompleto' };
    } else { // groq
      url = 'https://api.groq.com/openai/v1/chat/completions';
      key = groqKey;
      model = (llm && llm.groqModel) || 'llama-3.3-70b-versatile';
    }
    if (!key) return { error: 'sem chave do motor de IA' };
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key, ...extraHeaders },
      body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, ...messages], temperature: 0.4, max_tokens: 400 }),
    });
    if (!res.ok) return { error: 'LLM ' + res.status + ': ' + (await res.text()).substring(0, 120) };
    const j = await res.json();
    const texto = (j.choices?.[0]?.message?.content || '').trim();
    return texto ? { ok: true, texto } : { error: 'resposta vazia' };
  } catch (e) { return { error: (e as Error).message }; }
}

// Envia WhatsApp pelo provedor ativo do dono (Z-API ou Cloud API).
async function enviarWhatsAppServer(supa: any, owner: string, rawPhone: string, text: string): Promise<any> {
  const provider = await lerAppData(supa, owner, 'wa_provider', 'zapi');
  const phone = String(rawPhone || '').replace(/\D/g, '');
  try {
    if (provider === 'cloud') {
      const c = await lerAppData(supa, owner, 'wa_cloud_config', null);
      if (!c || !c.phoneNumberId || !c.accessToken) return { ok: false, error: 'cloud não configurado' };
      const to = phone.startsWith('55') ? phone : '55' + phone;
      const res = await fetch(`https://graph.facebook.com/v21.0/${c.phoneNumberId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + c.accessToken },
        body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } }),
      });
      const d = await res.json().catch(() => ({}));
      return (res.ok && d.messages) ? { ok: true } : { ok: false, error: (d.error && d.error.message) || ('HTTP ' + res.status) };
    }
    // Z-API
    const z = await lerAppData(supa, owner, 'zapi_config', null);
    if (!z || !z.instanceId || !z.token) return { ok: false, error: 'z-api não configurado' };
    const headers: any = { 'Content-Type': 'application/json' };
    if (z.clientToken) headers['Client-Token'] = z.clientToken;
    const res = await fetch(`https://api.z-api.io/instances/${z.instanceId}/token/${z.token}/send-text`, {
      method: 'POST', headers, body: JSON.stringify({ phone, message: text }),
    });
    const d = await res.json().catch(() => ({}));
    return (res.ok && (d.zaapId || d.messageId || d.id)) ? { ok: true } : { ok: false, error: d.error || ('HTTP ' + res.status) };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
