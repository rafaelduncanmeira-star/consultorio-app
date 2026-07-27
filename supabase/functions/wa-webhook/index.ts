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
// Envs opcionais:
//   WA_VERIFY_TOKEN   — verify token do webhook da Meta (GET hub.challenge)
//   WA_WEBHOOK_SECRET — se definido, o POST exige ?s=<segredo> na URL
//                       (acrescente &s=... na URL colada no provedor).
//                       OBRIGATÓRIO para o modo AUTÔNOMO: a IA só responde/agenda
//                       em requisição autenticada. Sem o segredo, o webhook segue
//                       ingerindo leads/mensagens, mas NUNCA dispara resposta nem
//                       agendamento — impede que uma URL vazada gere custo de LLM
//                       ou agenda falsa.
//
// Blindagens da IA autônoma (ver "SECRETÁRIA POR IA" abaixo):
//   gating duplo (enabled+autonomo) · sem resposta a placeholders/eco ·
//   dedupe por id do provedor (tabela wa_eventos, opcional) · guard de
//   mensagem-mais-recente · rate limit por telefone · timeouts nos fetches ·
//   marcador AGENDAR validado contra a disponibilidade real · re-checagem
//   de ocupação antes de inserir · fuso horário da clínica.
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

  // Segredo opcional do POST (defina WA_WEBHOOK_SECRET e acrescente &s=... na URL)
  const secret = Deno.env.get('WA_WEBHOOK_SECRET');
  if (secret && url.searchParams.get('s') !== secret) {
    return json({ error: 'não autorizado' }, 403);
  }
  // A IA autônoma (gasto de LLM + criação de agendamentos) SÓ dispara em webhook
  // autenticado. Sem WA_WEBHOOK_SECRET definido E conferido, o endpoint continua
  // ingerindo leads/mensagens no CRM, mas nunca responde nem agenda sozinho —
  // assim uma URL vazada não vira torneira de custo nem porta pra agenda falsa.
  const autenticado = !!secret && url.searchParams.get('s') === secret;

  const owner = url.searchParams.get('owner');
  const prof  = url.searchParams.get('prof'); // opcional: número por profissional
  if (!owner) {
    return json({ error: 'Faltou ?owner=<user_id> na URL do webhook.' }, 400);
  }

  let p: any;
  try { p = await req.json(); } catch { return json({ error: 'corpo inválido' }, 400); }

  // Normaliza os dois provedores para uma LISTA de mensagens
  // (a Meta pode entregar várias mensagens num único POST).
  const norm = normalizarEntrada(p);
  if (!norm.ok) return json({ ok: true, skipped: norm.motivo });

  const supa = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  let armazenadas = 0;
  // Uma resposta POR TELEFONE. Um único POST pode trazer mensagens de vários
  // pacientes (a Meta entrega em lote); guardar só a "última" deixava todos os
  // outros remetentes do lote sem nenhuma resposta.
  const alvos = new Map<string, any>();

  for (const bruto of norm.msgs) {
    const phone = String(bruto.phone || '').replace(/\D/g, '');
    if (!phone || phone.length < 10) continue;

    // Dedupe por id do provedor (retries da Meta/Z-API reentregam o mesmo evento).
    // Usa a tabela wa_eventos se existir (SETUP_IA_AUTONOMA.sql); sem ela, segue sem dedupe.
    if (bruto.msgId) {
      const { error: dupErr } = await supa.from('wa_eventos').insert({ id: String(bruto.msgId), owner_id: owner });
      if (dupErr) {
        if (dupErr.code === '23505') continue;            // já processada — pula
        // 42P01 = tabela não existe → segue sem dedupe; outros erros idem.
      }
    }

    const nome     = bruto.nome || 'Contato WhatsApp';
    const mensagem = (bruto.mensagem && String(bruto.mensagem).trim()) || '[mensagem sem texto]';
    const phoneChat = phone.replace(/^55/, '');

    // 1) SEMPRE registra a mensagem recebida no histórico (crm_messages).
    const { data: msgRow, error: msgErr } = await supa.from('crm_messages').insert({
      user_id: owner, whatsapp: phoneChat, remetente: 'contato', mensagem,
    }).select('created_at').limit(1);
    if (msgErr) {
      console.log('[webhook] crm_messages:', msgErr.message);
      // Desfaz o dedupe: sem a mensagem gravada, um retry do provedor PRECISA
      // reprocessar. Sem isto o evento ficaria marcado como visto e a mensagem
      // se perderia de vez.
      if (bruto.msgId) await supa.from('wa_eventos').delete().eq('id', String(bruto.msgId));
      continue;
    }
    armazenadas++;
    const msgTs = (msgRow && msgRow[0] && msgRow[0].created_at) || null;

    // 2) Cria o card no CRM só se ainda não existir um lead desse número.
    const { data: existente } = await supa.from('crm_leads')
      .select('id').eq('user_id', owner).eq('whatsapp', phone).limit(1);
    if (!(existente && existente.length)) {
      const leadObj: any = {
        user_id: owner, nome, whatsapp: phone,
        primeira_mensagem: mensagem, canal: 'WhatsApp', processado: false,
      };
      if (prof) leadObj.profissional_id = prof;
      const { error } = await supa.from('crm_leads').insert(leadObj);
      if (error) console.log('[webhook] crm_leads:', error.message);
    }

    // Alvo da resposta deste telefone: msgTs é sempre o mais recente (o guard
    // de frescor tem de comparar contra a verdade), mas o TEXTO é o do último
    // conteúdo real — assim um áudio/figurinha no fim do lote não anula a
    // pergunta de texto que veio junto e ficaria sem resposta.
    const anterior = alvos.get(phone);
    const textoAlvo = (_ehPlaceholder(mensagem) && anterior && !_ehPlaceholder(anterior.mensagem))
      ? anterior.mensagem : mensagem;
    alvos.set(phone, { phone, phoneChat, nome, mensagem: textoAlvo, msgTs });
  }

  // 3) ── SECRETÁRIA POR IA (modo autônomo) ──
  // Uma resposta por telefone do lote, em background quando o runtime permite —
  // devolve 200 rápido e evita retry do provedor por timeout.
  if (alvos.size) {
    const tarefa = Promise.all([...alvos.values()].map((alvo) =>
      maybeAutoReply({ supa, owner, autenticado, ...alvo }).catch((e) =>
        console.log('[IA] erro em background:', (e as Error).message))));
    const rt: any = (globalThis as any).EdgeRuntime;
    if (rt && typeof rt.waitUntil === 'function') rt.waitUntil(tarefa);
    else await tarefa;
  }

  return json({ ok: true, stored: armazenadas });
});

// ------------------------------------------------------------
// Normaliza a entrada dos dois provedores.
// Retorna { ok:true, msgs:[{phone, nome, mensagem, msgId}] } ou { ok:false, motivo }.
function normalizarEntrada(p: any): any {
  // --- WhatsApp Cloud API (Meta): payload aninhado, possivelmente em lote ---
  if (p && (p.object === 'whatsapp_business_account' || Array.isArray(p.entry))) {
    const msgs: any[] = [];
    for (const entry of (p.entry || [])) {
      for (const change of (entry.changes || [])) {
        const value = change?.value;
        if (!value || !Array.isArray(value.messages)) continue; // statuses etc.
        const nomeContato = value?.contacts?.[0]?.profile?.name || '';
        for (const m of value.messages) {
          const texto =
            (m.text && m.text.body) ||
            (m.button && m.button.text) ||
            (m.interactive && (m.interactive.button_reply?.title || m.interactive.list_reply?.title)) ||
            (m.image ? '[imagem]' : '') || (m.audio ? '[áudio]' : '') ||
            (m.document ? '[documento]' : '') || (m.video ? '[vídeo]' : '') ||
            (m.location ? '[localização]' : '') ||
            (m.sticker ? '[figurinha]' : '') || (m.reaction ? '[reação]' : '') || '';
          msgs.push({ phone: String(m.from || ''), nome: nomeContato, mensagem: texto, msgId: m.id || null });
        }
      }
    }
    if (!msgs.length) return { ok: false, motivo: 'cloud: sem mensagens (status/entrega)' };
    return { ok: true, msgs };
  }

  // --- Z-API: payload plano ---
  if (p.fromMe === true || p.isGroup === true || p.isStatusReply === true || p.isNewsletter === true) {
    return { ok: false, motivo: 'própria/grupo/status' };
  }
  // Callbacks de status/entrega da Z-API não são mensagem de pessoa: exigem texto ou mídia.
  const temConteudo = !!((p.text && (p.text.message || p.text.body)) || p.body || p.message ||
    p.caption || p.image || p.audio || p.video || p.document || p.sticker);
  if (!temConteudo && (p.status || p.ack !== undefined || p.type === 'DeliveryCallback' || p.type === 'MessageStatusCallback')) {
    return { ok: false, motivo: 'z-api: callback de status' };
  }
  const phoneRaw = (p.phone ?? p.from ?? p.participantPhone ?? '').toString();
  const nome = p.senderName || p.chatName || p.pushName || p.notifyName || '';
  const mensagem =
    (p.text && (p.text.message || p.text.body)) ||
    p.body || p.message || p.caption ||
    (p.image ? '[imagem]' : '') || (p.audio ? '[áudio]' : '') ||
    (p.video ? '[vídeo]' : '') || (p.document ? '[documento]' : '') || '';
  if (!phoneRaw) return { ok: false, motivo: 'z-api: sem telefone' };
  // Dedupe: alguns eventos da Z-API não trazem id. Sintetiza uma chave estável
  // a partir de telefone + timestamp (`momment`), que o retry reentrega igual —
  // sem isso um retred vira resposta duplicada.
  const zTs = p.momment || p.momment_ || p.timestamp || null;
  const zid = p.messageId || p.id ||
    (zTs ? String(phoneRaw).replace(/\D/g, '') + ':' + zTs : null);
  return { ok: true, msgs: [{ phone: phoneRaw, nome, mensagem, msgId: zid }] };
}

// Mensagens que são só placeholder de mídia — não alimentam resposta automática
// (responder "[áudio]" gera conversa sem sentido e abre porta pra loop de eco).
function _ehPlaceholder(txt: string): boolean {
  return /^\[[^\]]+\]$/.test((txt || '').trim());
}

// ------------------------------------------------------------
// SECRETÁRIA POR IA — MODO AUTÔNOMO (responde sozinha).
// Gated por ia_config.enabled + ia_config.autonomo (ambos no app, OFF por padrão).
async function maybeAutoReply(ctx: any): Promise<void> {
  const { supa, owner, phone, phoneChat, nome, mensagem, msgTs, autenticado } = ctx;
  try {
    const ia = await lerAppData(supa, owner, 'ia_config', null);
    // Toggle MESTRE + autônomo: desligar a IA no card desliga TUDO.
    if (!ia || !ia.enabled || !ia.autonomo) return;

    // Só responde em webhook autenticado (WA_WEBHOOK_SECRET conferido). Fecha a
    // porta pra URL vazada disparar LLM/agendamento em nome de um atacante.
    if (!autenticado) {
      console.log('[IA] webhook sem segredo conferido — resposta automática desativada (defina WA_WEBHOOK_SECRET).');
      return;
    }

    // Não responde placeholder de mídia (áudio/imagem/status) — evita loop e ruído.
    if (_ehPlaceholder(mensagem)) return;

    // Rate limit por telefone: no máx. 6 respostas do bot em 10min e 60 em 24h.
    // Fusível de custo contra flood/spam (e contra qualquer loop imprevisto).
    const dezMin = new Date(Date.now() - 10 * 60000).toISOString();
    const umDia  = new Date(Date.now() - 24 * 3600000).toISOString();
    const { count: c10 } = await supa.from('crm_messages')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', owner).eq('whatsapp', phoneChat)
      .eq('remetente', 'consultorio').gte('created_at', dezMin);
    if ((c10 || 0) >= 6) { console.log('[IA] rate limit 10min:', phoneChat); return; }
    const { count: c24 } = await supa.from('crm_messages')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', owner).eq('whatsapp', phoneChat)
      .eq('remetente', 'consultorio').gte('created_at', umDia);
    if ((c24 || 0) >= 60) { console.log('[IA] rate limit 24h:', phoneChat); return; }

    // Fusível GLOBAL por dono: teto diário de respostas do bot somando TODOS os
    // telefones. Sem ele, um atacante rotacionando números fura o limite por
    // telefone e estoura o custo de LLM. (Conta envios manuais também — é um
    // teto de segurança, não um alvo operacional; deixe folgado.)
    const { count: cDiaDono } = await supa.from('crm_messages')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', owner).eq('remetente', 'consultorio').gte('created_at', umDia);
    if ((cDiaDono || 0) >= 300) { console.log('[IA] teto diário do dono atingido'); return; }

    // Histórico recente da conversa
    const { data: histRaw } = await supa.from('crm_messages')
      .select('remetente,mensagem,created_at')
      .eq('user_id', owner).eq('whatsapp', phoneChat)
      .order('created_at', { ascending: false }).limit(16);
    const historico = (histRaw || []).reverse();

    // Guard de frescor POR TIMESTAMP: se já existe mensagem do paciente MAIS
    // NOVA que a que estamos respondendo, deixa a invocação dela responder.
    // (Comparar por timestamp, e não por texto, evita resposta dupla mesmo
    // quando o paciente manda o mesmo texto duas vezes — ex.: "oi" e "oi".)
    if (msgTs) {
      const { count: maisNovas } = await supa.from('crm_messages')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', owner).eq('whatsapp', phoneChat)
        .eq('remetente', 'contato').gt('created_at', msgTs);
      if ((maisNovas || 0) > 0) {
        console.log('[IA] mensagem mais nova na fila — pulando esta'); return;
      }
    }

    // Conhecimento da clínica (defaults alinhados aos do app)
    const proc  = await lerAppData(supa, owner, 'procedimentos', []);
    const prog  = await lerAppData(supa, owner, 'programas', []);
    // Defaults IDÊNTICOS aos de getAgConfig() no app (app.js) — inclusive o
    // almoço. Divergir fazia a IA oferecer 12:00/13:00 para clínicas que nunca
    // salvaram a configuração, horários que a agenda do app nunca ofereceria.
    const agcfg = await lerAppData(supa, owner, 'agenda_config',
      { horaInicio: '07:00', horaFim: '20:00', slotDuracao: 60,
        almocoInicio: '12:00', almocoFim: '13:30', diasUteis: [1, 2, 3, 4, 5] });
    const clin  = await lerAppData(supa, owner, 'clinica_config', {});
    const bloqs = await lerAppData(supa, owner, 'bloqueios', []);

    // Disponibilidade real (só se a IA pode agendar)
    let disponibilidade: { texto: string; livres: Set<string> } = { texto: '', livres: new Set() };
    if (ia.agendar) {
      // montarDisponibilidade varre de amanhã até 21 dias à frente; lê só isso.
      const agora = new Date();
      const de  = _dataLocal(agora);
      const ate = _dataLocal(new Date(agora.getTime() + 22 * 86400000));
      const ags = await lerAgendamentos(supa, owner, de, ate);
      disponibilidade = montarDisponibilidade(agcfg, ags, bloqs);
    }

    const system = montarSystemPromptServer({ ia, proc, prog, agcfg, clin, disponibilidade: disponibilidade.texto });
    const messages = normalizarHistorico(historico);
    if (!messages.length) return;

    // LLM (Groq por padrão; Claude/OpenRouter/personalizado se configurado)
    const llm = await lerAppData(supa, owner, 'llm_config', { provider: 'groq' });
    const groqKey = await lerAppData(supa, owner, 'gemini_key_secure', '');
    const r = await chamarLLMServer(llm, groqKey, system, messages);
    if (!r.ok) { console.log('[IA] LLM erro:', r.error); return; }
    let texto = r.texto;

    // Marcador de agendamento — extrai o 1º, remove TODOS (inclusive truncados)
    // e só agenda se o slot estiver na lista de livres que NÓS calculamos
    // (o paciente pode tentar induzir a IA a marcar horário arbitrário).
    // `agendou`: null = a IA não tentou marcar · false = tentou e foi recusado
    // · true = agendamento realmente criado. O texto enviado depende disso.
    let agendou: boolean | null = null;
    if (ia.agendar) {
      // Nome do procedimento com `.+?` (não `[^\]]+`) pra não truncar em um `]`
      // interno (ex.: "Botox [premium]"); ancorado no `]]` de fechamento.
      const m = texto.match(/\[\[AGENDAR:\s*(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})\s*(?:\|\s*(.+?))?\]\]/);
      // Remove marcadores completos e também um marcador truncado (sem fechamento).
      texto = texto.replace(/\[\[AGENDAR[\s\S]*?\]\]/g, '').replace(/\[\[AGENDAR[\s\S]*$/g, '').trim();
      if (m) {
        const slot = `${m[1]} ${m[2].padStart(5, '0')}`;
        if (!disponibilidade.livres.has(slot)) {
          console.log('[IA] marcador fora da disponibilidade — ignorado:', slot);
          agendou = false;
        } else {
          agendou = await criarAgendamentoSeguro(supa, owner, {
            data: m[1], hora: m[2].padStart(5, '0'), procedimento: (m[3] || '').trim(),
            pacienteNome: nome || 'Paciente WhatsApp', whatsapp: phone,
            duracao: agcfg.slotDuracao || 60,
            modo: ia.agendarModo || 'pendente',
          });
          if (!agendou) console.log('[IA] agendamento não criado (slot ocupado ou erro de insert)');
        }
      }
    }

    // ALINHAR O TEXTO AO QUE REALMENTE ACONTECEU.
    // O prompt manda a IA escrever "vou reservar seu horário" junto do marcador.
    // Se a reserva foi recusada (slot fora da lista de livres, ou ocupado entre
    // o cálculo e o insert), mandar essa frase é PIOR que não responder: o
    // paciente vai à clínica num horário que não existe. Nunca envie a promessa
    // sem a reserva correspondente.
    if (agendou === false) {
      texto = 'Esse horário não está mais disponível. Vou pedir para a equipe falar com você para encontrar outro, tudo bem?';
    } else if (agendou === true && !texto) {
      // A IA respondeu SÓ o marcador: o agendamento existe e, sem isto, o
      // paciente ficaria sem nenhum retorno (e o histórico sem turno de
      // assistant, fazendo a IA repetir a oferta no turno seguinte).
      texto = 'Anotei seu horário! A equipe confirma com você em breve.';
    }
    if (!texto) return;

    // Envia pelo provedor ativo (server-side)
    const env = await enviarWhatsAppServer(supa, owner, phone, texto);
    if (!env.ok) { console.log('[IA] envio falhou:', env.error); return; }

    // Registra a resposta no CRM (a secretária vê tudo)
    const { error: insErr } = await supa.from('crm_messages').insert({
      user_id: owner, whatsapp: phoneChat, remetente: 'consultorio', mensagem: texto,
    });
    if (insErr) console.log('[IA] resposta enviada mas não registrada:', insErr.message);
  } catch (e) {
    console.log('[IA] erro inesperado:', (e as Error).message);
  }
}

// Histórico → mensagens do LLM: junta turnos consecutivos do mesmo papel e
// remove assistant inicial (APIs como a da Anthropic rejeitam esses formatos).
function normalizarHistorico(historico: any[]): any[] {
  const out: any[] = [];
  for (const m of historico) {
    const role = m.remetente === 'consultorio' ? 'assistant' : 'user';
    const content = (m.mensagem || '').trim();
    if (!content) continue;
    if (out.length && out[out.length - 1].role === role) {
      out[out.length - 1].content += '\n' + content;
    } else {
      out.push({ role, content });
    }
  }
  while (out.length && out[0].role === 'assistant') out.shift();
  return out;
}

// Lê uma chave de app_data (configs/conhecimento) pelo owner.
async function lerAppData(supa: any, owner: string, key: string, def: any): Promise<any> {
  const { data } = await supa.from('app_data').select('value').eq('user_id', owner).eq('key', key).limit(1);
  return (data && data[0] && data[0].value != null) ? data[0].value : def;
}

// Lê agendamentos (coleção blindada: 1 linha por registro).
// Limitado À JANELA que a disponibilidade realmente usa. Sem recorte, o
// PostgREST corta no `max_rows` do projeto (1000 por padrão) e — como não havia
// ORDER BY — o corte devolvia as linhas mais ANTIGAS, jogando fora justamente a
// agenda futura: o bot passava a oferecer horários já ocupados.
async function lerAgendamentos(supa: any, owner: string, de: string, ate: string): Promise<any[]> {
  const { data, error } = await supa.from('clinica_agendamentos')
    .select('data')
    .eq('owner_id', owner)
    .gte('data->>data', de)
    .lte('data->>data', ate)
    .order('data->>data', { ascending: true })
    .limit(2000);
  if (error) { console.log('[IA] lerAgendamentos:', error.message); return []; }
  return (data || []).map((r: any) => r.data).filter(Boolean);
}

// Monta o prompt do servidor (espelha o do app + data atual + marcador).
function montarSystemPromptServer(k: any): string {
  const nomeClin = (k.clin && k.clin.nome) || 'a clínica';
  const ia = k.ia || {};
  const fmtBRL = (v: number) => 'R$ ' + Number(v || 0).toLocaleString('pt-BR');
  const procs = (k.proc || []).filter((p: any) => p.valorPix || p.valorCartao).map((p: any) => {
    const partes = [];
    if (p.valorPix) partes.push(`PIX/dinheiro ${fmtBRL(p.valorPix)}`);
    if (p.valorCartao) partes.push(`cartão ${fmtBRL(p.valorCartao)}`);
    return `- ${p.nome}: ${partes.join(' · ') || 'sob consulta'}${p.obs ? ' (' + p.obs + ')' : ''}`;
  }).join('\n') || '- (nenhum procedimento com valor cadastrado)';
  const progs = (k.prog || []).filter((p: any) => p.ativo !== false)
    .map((p: any) => `- ${p.nome} (${p.tipo})${p.precoAVista ? ' — à vista ' + fmtBRL(p.precoAVista) : ''}`).join('\n');
  const diasNomes = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
  const dias = (k.agcfg.diasUteis || []).map((d: number) => diasNomes[d]).filter(Boolean).join(', ') || 'dias úteis';
  const agora = new Date();
  const hoje = _dataLocal(agora);
  const diaSemana = diasNomes[_dowLocal(agora)];

  const quemSou = ia.nomeAssistente
    ? `Você se chama ${ia.nomeAssistente} e é a assistente virtual de ${nomeClin}`
    : `Você é a assistente virtual de ${nomeClin}`;

  const linhas = [
    `${quemSou}, atendendo pacientes pelo WhatsApp. Hoje é ${diaSemana}, ${hoje}.`,
    `Seu papel é APENAS: tirar dúvidas sobre valores, horários e informações de atendimento, e ajudar a marcar/remarcar consultas.`,
    ``,
    `REGRAS INEGOCIÁVEIS:`,
    `- NUNCA dê conselho, diagnóstico ou orientação médica/clínica. Se perguntarem sobre sintomas, exames ou tratamento, diga com cordialidade que o profissional avalia na consulta e ofereça agendar.`,
    `- NUNCA invente preços, horários ou disponibilidade que não estejam listados abaixo. Se não souber, diga que vai confirmar com a equipe.`,
    `- Seja breve e natural (é WhatsApp): 1 a 3 frases, tom humano.`,
    `- Se o paciente pedir humano, estiver irritado, ou for assunto delicado/fora do escopo, diga gentilmente que a equipe assume.`,
  ];
  if (ia.apresentarComoIA !== false) {
    linhas.push(`- Na primeira resposta da conversa, apresente-se como assistente virtual da clínica. Se perguntarem se você é um robô/IA, confirme com naturalidade e simpatia — nunca finja ser humana.`);
  }
  if (ia.naoResponder) {
    linhas.push(`- NUNCA responda sobre os temas a seguir; diga que a equipe vai assumir a conversa: ${ia.naoResponder}`);
  }
  linhas.push(``, `PROCEDIMENTOS E VALORES:`, procs);
  if (progs) linhas.push(``, `PLANOS/PROGRAMAS:`, progs);
  linhas.push(``, `HORÁRIO DE ATENDIMENTO: ${dias}, das ${k.agcfg.horaInicio} às ${k.agcfg.horaFim}.`);
  if (ia.endereco)   linhas.push(``, `ENDEREÇO: ${ia.endereco}`);
  if (ia.convenios)  linhas.push(``, `CONVÊNIOS: ${ia.convenios}`);
  if (ia.pagamentos) linhas.push(``, `FORMAS DE PAGAMENTO: ${ia.pagamentos}`);
  if (ia.tom)        linhas.push(``, `TOM DE VOZ: ${ia.tom}`);
  if (ia.instrucoes) linhas.push(``, `INSTRUÇÕES EXTRAS DA CLÍNICA: ${ia.instrucoes}`);
  if (ia.agendar) {
    linhas.push(
      ``,
      `AGENDAMENTO: você pode marcar. Estes são os horários LIVRES (não ofereça outros):`,
      k.disponibilidade || '(sem horários livres nos próximos dias)',
      `Quando — e SÓ quando — o paciente confirmar um horário específico desta lista, inclua no FINAL da sua resposta, em uma linha separada, o marcador exato:`,
      `[[AGENDAR: AAAA-MM-DD HH:MM | procedimento]]`,
      `Não mostre esse marcador como texto normal nem o explique; ele é processado pelo sistema. Diga ao paciente que o horário será reservado e a equipe confirmará.`,
    );
  }
  return linhas.join('\n');
}

// ── Fuso horário da clínica ──
// A Edge Function roda em UTC; a clínica está no Brasil (UTC-3). Sem isso,
// à noite o "hoje" pulava pro dia seguinte e os dias da semana desalinhavam.
// TODO: tornar configurável por clínica (Manaus/Cuiabá são UTC-4).
const TZ_CLINICA = 'America/Sao_Paulo';

// Data local YYYY-MM-DD no fuso da clínica.
function _dataLocal(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ_CLINICA, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

// Dia da semana (0=domingo..6=sábado) no fuso da clínica.
function _dowLocal(d: Date): number {
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: TZ_CLINICA, weekday: 'short' }).format(d);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd);
}

// Calcula horários livres dos próximos dias (respeita duração dos compromissos,
// almoço e bloqueios). Retorna o texto pro prompt + o Set exato de slots livres
// (usado pra validar o marcador AGENDAR que a IA emitir).
function montarDisponibilidade(agcfg: any, ags: any[], bloqs: any[]): { texto: string; livres: Set<string> } {
  const dur = agcfg.slotDuracao || 60;
  const diasUteis = agcfg.diasUteis || [1, 2, 3, 4, 5];
  const toMin = (h: string) => { const [a, b] = String(h || '0:0').split(':').map(Number); return a * 60 + (b || 0); };

  // Ocupação expandida pela duração: um compromisso de 07:30+90min bloqueia
  // qualquer slot que se sobreponha ao intervalo [inicio, fim).
  const ocupados: { ds: string; ini: number; fim: number }[] = [];
  for (const a of (ags || [])) {
    if (!a || a.status === 'Cancelado' || !a.data || !a.hora) continue;
    const ini = toMin(a.hora);
    ocupados.push({ ds: a.data, ini, fim: ini + (Number(a.duracao) || 60) });
  }
  const ocupado = (ds: string, ini: number, fim: number) =>
    ocupados.some(o => o.ds === ds && ini < o.fim && o.ini < fim);

  // Bloqueio tem HORA, não só data (app.js:_isBloqueado usa as duas pontas).
  // Aqui a hora era ignorada: bastava a data cair no intervalo pro dia inteiro
  // sumir. Quem bloqueava as tardes de quinta pra um congresso via a IA
  // responder que não havia NADA na quinta — com a manhã toda livre.
  // O bloqueio é um intervalo contínuo de dataInicio+horaInicio até
  // dataFim+horaFim: dia do meio é integral, só as pontas têm recorte de hora.
  const bloqueado = (ds: string, ini: number, fim: number) =>
    (bloqs || []).some((b: any) => {
      if (!b || !b.dataInicio) return false;
      const dIni = b.dataInicio, dFim = b.dataFim || b.dataInicio;
      if (ds < dIni || ds > dFim) return false;
      const hIni = (ds === dIni) ? toMin(b.horaInicio || '00:00') : 0;
      const hFim = (ds === dFim) ? toMin(b.horaFim || '23:59') : 24 * 60;
      return ini < hFim && hIni < fim;
    });

  const ini = toMin(agcfg.horaInicio || '07:00');
  const fim = toMin(agcfg.horaFim || '20:00');
  const almIni = agcfg.almocoInicio ? toMin(agcfg.almocoInicio) : null;
  const almFim = agcfg.almocoFim ? toMin(agcfg.almocoFim) : null;

  const out: string[] = [];
  const livres = new Set<string>();
  let diasListados = 0;
  const base = new Date();
  for (let i = 1; i <= 21 && diasListados < 7; i++) {
    const d = new Date(base.getTime() + i * 86400000);
    if (!diasUteis.includes(_dowLocal(d))) continue;
    const ds = _dataLocal(d);
    const doDia: string[] = [];
    for (let min = ini; min + dur <= fim; min += dur) {
      if (almIni !== null && almFim !== null && min < almFim && almIni < min + dur) continue;
      if (bloqueado(ds, min, min + dur)) continue;
      if (ocupado(ds, min, min + dur)) continue;
      const slot = `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
      livres.add(`${ds} ${slot}`);
      if (doDia.length < 4) doDia.push(slot);
    }
    if (doDia.length) { out.push(`- ${ds}: ${doDia.join(', ')}`); diasListados++; }
  }
  return { texto: out.join('\n'), livres };
}

// Cria o agendamento com re-checagem de ocupação imediatamente antes do insert
// (dois pacientes confirmando o mesmo slot no mesmo minuto: só o 1º entra).
async function criarAgendamentoSeguro(supa: any, owner: string, p: any): Promise<boolean> {
  const dur = Number(p.duracao) || 60;
  const toMin = (h: string) => { const [a, b] = String(h || '0:0').split(':').map(Number); return a * 60 + (b || 0); };
  const ini = toMin(p.hora), fim = ini + dur;
  // Re-checa por SOBREPOSIÇÃO de intervalo no mesmo dia (não só início idêntico):
  // uma consulta de 90min às 08:00 tem de barrar um novo slot às 08:30. Só o
  // início igual deixava passar sobreposições parciais.
  const { data: doDia } = await supa.from('clinica_agendamentos')
    .select('data')
    .eq('owner_id', owner)
    .eq('data->>data', p.data)
    .neq('data->>status', 'Cancelado');
  const conflita = (doDia || []).some((r: any) => {
    const a = r.data; if (!a || !a.hora) return false;
    const aIni = toMin(a.hora), aFim = aIni + (Number(a.duracao) || 60);
    return ini < aFim && aIni < fim;
  });
  if (conflita) return false;

  const id = 'ag_ia_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
  const status = p.modo === 'direto' ? 'Confirmado' : 'Pendente';
  const ag = {
    id, data: p.data, hora: p.hora, duracao: dur,
    pacienteNome: p.pacienteNome, whatsapp: p.whatsapp,
    procedimento: p.procedimento || '', profissionalId: null,
    status, obs: 'Criado pela secretária IA', tipoAtividade: 'Consultório',
    crmIdx: null, pacIdx: null, crmId: null, pacId: null, _viaIa: true,
  };
  const { error } = await supa.from('clinica_agendamentos').insert({
    id, owner_id: owner, profissional_id: null, data: ag, updated_at: new Date().toISOString(),
  });
  if (error) { console.log('[IA] insert agendamento:', error.message); return false; }
  return true;
}

// Chama o LLM no servidor (Groq formato OpenAI; Claude formato Anthropic).
async function chamarLLMServer(llm: any, groqKey: string, system: string, messages: any[]): Promise<any> {
  try {
    const corte = AbortSignal.timeout(20000); // LLM pendurado não pode segurar o webhook
    if (llm && llm.provider === 'claude') {
      if (!llm.claudeKey) return { error: 'sem chave Claude' };
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: corte,
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
      signal: corte,
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
    const corte = AbortSignal.timeout(15000);
    if (provider === 'cloud') {
      const c = await lerAppData(supa, owner, 'wa_cloud_config', null);
      if (!c || !c.phoneNumberId || !c.accessToken) return { ok: false, error: 'cloud não configurado' };
      const to = phone.startsWith('55') ? phone : '55' + phone;
      const res = await fetch(`https://graph.facebook.com/v21.0/${c.phoneNumberId}/messages`, {
        method: 'POST',
        signal: corte,
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
      method: 'POST', signal: corte, headers, body: JSON.stringify({ phone, message: text }),
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
