// Reconexão do canal de leads — rode com: node --test
//
// O realtime é a ÚNICA porta por onde um lead do WhatsApp entra no CRM depois
// que o app já está aberto: o syncLeadsFromSupabase só rodava no login e no
// callback do canal. Se o canal caísse — notebook dormiu no almoço, wi-fi
// trocou de ponto —, os leads paravam de chegar e nada indicava isso. A
// recepção fica com o app aberto o dia inteiro e simplesmente não vê o paciente
// que mandou mensagem.
//
// E o subscribe() era chamado SEM callback de status, então nem uma inscrição
// que nunca chegou a valer (realtime desligado na tabela, RLS) aparecia.

const { test } = require('node:test');
const assert = require('node:assert');
const { carregar, recortarFuncao } = require('./_extrair.js');

function ambiente({ estadoCanal = 'joined' } = {}) {
  const eventos = [];
  let statusCb = null;
  const canal = {
    state: estadoCanal,
    on() { return canal; },
    subscribe(cb) { statusCb = cb; eventos.push('subscribe'); return canal; },
  };
  const s = carregar(['_rearmarLeadsRealtime', 'initLeadsRealtime', '_revisarCanalLeads'], {
    console: { warn() {}, log() {} },
    setTimeout: (fn) => { eventos.push('agendou-rearme'); return { fn }; },
    _supa: { channel: () => canal, removeChannel: () => Promise.resolve() },
    currentUser: { id: 'u1' },
    currentDataOwner: null,
    _leadsChannel: null,
    _leadsRearmarTimer: null,
    syncLeadsFromSupabase: () => { eventos.push('sync'); },
    // A revisão cuida também do canal da conversa aberta (mesma lacuna, e lá
    // não há varredura periódica nenhuma).
    _chatPhone: '11999990000', _chatSub: null,
    _subscribeChatRealtime: () => { eventos.push('chat-subscribe'); },
  });
  return { ...s, eventos, canal, disparar: (st) => statusCb && statusCb(st) };
}

test('assinar (ou reassinar) varre os leads que chegaram durante a queda', () => {
  const a = ambiente();
  a.initLeadsRealtime();
  assert.ok(!a.eventos.includes('sync'), 'ainda não confirmou a inscrição');
  a.disparar('SUBSCRIBED');
  assert.ok(a.eventos.includes('sync'),
    'sem esta varredura, o lead que entrou durante a queda esperaria o PRÓXIMO lead — ou o próximo login');
});

test('erro e timeout do canal agendam reconexão', () => {
  for (const st of ['CHANNEL_ERROR', 'TIMED_OUT']) {
    const a = ambiente();
    a.initLeadsRealtime();
    a.disparar(st);
    assert.ok(a.eventos.includes('agendou-rearme'), `${st} tem de reconectar`);
  }
});

test('CLOSED NÃO reconecta — é o que chega quando somos nós fechando', () => {
  const a = ambiente();
  a.initLeadsRealtime();
  a.disparar('CLOSED');
  assert.ok(!a.eventos.includes('agendou-rearme'),
    'reagir ao CLOSED faz laço infinito: o próprio initLeadsRealtime remove o canal anterior');
});

test('reconexão não empilha timers', () => {
  const a = ambiente();
  a.initLeadsRealtime();
  a.disparar('CHANNEL_ERROR');
  a.disparar('CHANNEL_ERROR');
  a.disparar('TIMED_OUT');
  assert.strictEqual(a.eventos.filter(e => e === 'agendou-rearme').length, 1,
    'uma tentativa agendada por vez');
});

test('revisar canal: com o canal de pé, só varre — não reassina à toa', () => {
  const a = ambiente({ estadoCanal: 'joined' });
  a.initLeadsRealtime();
  const antes = a.eventos.filter(e => e === 'subscribe').length;
  a._revisarCanalLeads();
  assert.ok(a.eventos.includes('sync'));
  assert.strictEqual(a.eventos.filter(e => e === 'subscribe').length, antes,
    'canal saudável não precisa ser recriado');
});

test('revisar canal: canal morto é reassinado', () => {
  const a = ambiente({ estadoCanal: 'closed' });
  a.initLeadsRealtime();
  const antes = a.eventos.filter(e => e === 'subscribe').length;
  a._revisarCanalLeads();
  assert.ok(a.eventos.filter(e => e === 'subscribe').length > antes);
});

test('voltar a rede e trazer a aba pra frente disparam a revisão', () => {
  const { fonte } = require('./_extrair.js');
  const semCom = fonte.replace(/\/\/[^\n]*/g, '');
  assert.match(semCom, /addEventListener\('online'[\s\S]{0,120}_revisarCanalLeads/,
    'voltar a ter rede é o momento clássico de o canal estar morto');
  assert.match(semCom, /visibilitychange[\s\S]{0,200}_revisarCanalLeads/,
    'a aba volta pra frente depois do notebook dormir — é a outra metade');
});

test('o subscribe passa callback de status (a premissa de tudo acima)', () => {
  const src = recortarFuncao('initLeadsRealtime').replace(/\/\/[^\n]*/g, '');
  assert.match(src, /subscribe\(\(status\)/,
    'sem callback, nem uma inscrição que nunca valeu aparece em lugar nenhum');
});

// ---------- o canal da conversa aberta tem a mesma lacuna ----------
// Quando o canal do chat caía — notebook dormiu com a conversa aberta, wi-fi
// trocou de ponto —, as mensagens do paciente PARAVAM de aparecer e nada
// indicava isso: a secretária fica olhando um chat que parece parado enquanto o
// paciente escreve. Pior que no caso dos leads, porque aqui não havia nenhuma
// varredura periódica: as mensagens só eram carregadas na abertura do chat.
function ambienteChat({ estado = 'joined' } = {}) {
  const eventos = [];
  let statusCb = null;
  const canal = {
    state: estado,
    on() { return canal; },
    subscribe(cb) { statusCb = cb; eventos.push('subscribe'); return canal; },
  };
  const s = carregar(['_rearmarChatRealtime', '_subscribeChatRealtime'], {
    console: { warn() {} },
    setTimeout: (fn) => { eventos.push('agendou-rearme'); return { fn }; },
    _supa: { channel: () => canal, removeChannel: () => Promise.resolve() },
    currentUser: { id: 'u1' }, currentDataOwner: null,
    _chatSub: null, _chatPhone: '11999990000',
    _chatRearmarTimer: null, _chatJaAssinou: false,
    _appendChatMessage: () => {},
    _chatEnviadasLocal: new Set(),
    getIaConfig: () => ({ enabled: false }),
    iaSugerirNoChat: () => {},
    loadChatHistory: () => { eventos.push('recarregou'); },
  });
  return { ...s, eventos, disparar: (st) => statusCb && statusCb(st) };
}

test('chat: erro e timeout do canal agendam reconexão', () => {
  for (const st of ['CHANNEL_ERROR', 'TIMED_OUT']) {
    const a = ambienteChat();
    a._subscribeChatRealtime('11999990000');
    a.disparar(st);
    assert.ok(a.eventos.includes('agendou-rearme'), `${st} tem de reconectar`);
  }
});

test('chat: CLOSED não reconecta (somos nós trocando de canal)', () => {
  const a = ambienteChat();
  a._subscribeChatRealtime('11999990000');
  a.disparar('CLOSED');
  assert.ok(!a.eventos.includes('agendou-rearme'));
});

test('chat: a PRIMEIRA assinatura não recarrega a conversa', () => {
  const a = ambienteChat();
  a._subscribeChatRealtime('11999990000');
  a.disparar('SUBSCRIBED');
  assert.ok(!a.eventos.includes('recarregou'),
    'quem abriu o chat já chamou o loadChatHistory — repetir só piscaria a tela');
});

test('chat: REassinar recarrega, trazendo o que chegou durante a queda', () => {
  const a = ambienteChat();
  a._subscribeChatRealtime('11999990000');
  a.disparar('SUBSCRIBED');   // primeira
  a.disparar('SUBSCRIBED');   // reassinou depois de cair
  assert.ok(a.eventos.includes('recarregou'),
    'sem isto, a mensagem que chegou durante a queda só apareceria ao reabrir o chat');
});

test('revisar canal: conversa aberta com canal morto é reassinada', () => {
  const a = ambiente({ estadoCanal: 'closed' });
  a.initLeadsRealtime();
  a._revisarCanalLeads();
  assert.ok(a.eventos.includes('chat-subscribe'),
    'o chat não tem varredura periódica nenhuma — depende desta revisão');
});
