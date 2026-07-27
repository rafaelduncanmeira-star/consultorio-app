// Testes do ciclo de lembretes por WhatsApp — rode com: node --test
// Exercitam o rodarCicloLembretes REAL do app.js. Aqui a saída não é uma tela:
// é mensagem que chega no celular do paciente. Mandar duas vezes é visível
// pra ele, não pra quem programou.

const { test } = require('node:test');
const assert = require('node:assert');
const { carregar } = require('./_extrair.js');

const AGENDA = [
  { id: 'a1', data: '2026-08-04', hora: '09:00', pacienteNome: 'Ana',   whatsapp: '11987654321', status: 'Confirmado' },
  { id: 'a2', data: '2026-08-04', hora: '10:00', pacienteNome: 'Bruno', whatsapp: '11987654322', status: 'Confirmado' },
  { id: 'a3', data: '2026-08-04', hora: '11:00', pacienteNome: 'Célia', whatsapp: '11987654323', status: 'Confirmado' },
];

// `aoEnviar(ag, estadoPersistido)` roda a cada envio: é onde o teste espia o
// que JÁ está salvo no momento em que a próxima mensagem vai sair.
function cenario({ agenda = AGENDA, aoEnviar, falharEm = [], cfg = {} } = {}) {
  const store = { agendamentos: JSON.parse(JSON.stringify(agenda)), lembretes_config: {} };
  const enviados = [];

  const DB = {
    get: (k) => JSON.parse(JSON.stringify(store[k] || [])),
    set: (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); return Promise.resolve(true); },
    getObj: (k, def) => (k in store ? store[k] : def),
    setObj: (k, v) => { store[k] = v; },
  };

  const sandbox = {
    DB, JSON, Date, Promise, String,
    // Trava de reentrância do ciclo. Precisa vir do sandbox: no node:vm um `let`
    // de módulo não vira propriedade do contexto, então a função não o enxerga.
    _cicloLembretesRodando: false,
    setTimeout: (fn) => { fn(); return 1; },          // sem throttle real no teste
    console: { log() {}, warn() {} },
    _waConnected: () => true,
    _auditLog: () => {},
    _formatarMensagemLembrete: (ag) => `Oi ${ag.pacienteNome}`,
    _enviarLembreteZapi: async (ag) => {
      enviados.push(ag.id);
      if (aoEnviar) aoEnviar(ag, store.agendamentos);
      return falharEm.includes(ag.id) ? { error: 'numero invalido' } : { ok: true };
    },
    getLembretesConfig: () => ({ ativo: true, horasAntes: 24, mensagem: '', ultimoEnvio: null, ...cfg }),
    _agendamentosParaLembrar: () => DB.get('agendamentos').filter(a => !a._lembreteEnviado && a.whatsapp),
    _ymd: () => '2026-08-03',
  };
  const carregado = carregar(['_marcarLembretesRodaramHoje', 'rodarCicloLembretes'], sandbox);
  // `carregado` É o contexto do vm (o carregar copia os globais), então
  // reatribuir um stub nele muda o que a função enxerga — o `sandbox` local
  // daqui é só o molde e não teria efeito nenhum.
  return { rodarCicloLembretes: carregado.rodarCicloLembretes, store, enviados, sandbox: carregado };
}

const marcado = (store, id) => !!(store.agendamentos.find(a => a.id === id) || {})._lembreteEnviado;

test('lembretes: manda uma mensagem por paciente elegível', async () => {
  const c = cenario();
  const r = await c.rodarCicloLembretes();
  assert.deepStrictEqual(c.enviados, ['a1', 'a2', 'a3']);
  assert.strictEqual(r.enviados, 3);
  assert.strictEqual(r.erros, 0);
});

// O ACHADO: as marcas de "já enviei" só eram gravadas DEPOIS do laço inteiro.
// O ciclo dispara sozinho 5s após abrir o app e leva ~1s por paciente — basta
// fechar o app no meio pra perder o registro de tudo que já saiu. No próximo
// ciclo, os mesmos pacientes recebem a mesma mensagem outra vez.
test('lembretes: quem já recebeu está gravado ANTES do próximo envio', async () => {
  const vistos = [];
  const c = cenario({
    aoEnviar: (ag, persistido) => {
      vistos.push({
        enviando: ag.id,
        jaGravados: persistido.filter(a => a._lembreteEnviado).map(a => a.id),
      });
    },
  });
  await c.rodarCicloLembretes();

  assert.deepStrictEqual(vistos[1].jaGravados, ['a1'],
    'ao enviar pro Bruno, o envio da Ana já tem de estar salvo');
  assert.deepStrictEqual(vistos[2].jaGravados, ['a1', 'a2'],
    'ao enviar pra Célia, Ana e Bruno já têm de estar salvos');
});

// A prova do cenário real: o app é fechado no meio do ciclo.
test('lembretes: fechar o app no meio não faz o paciente receber de novo', async () => {
  const c = cenario({
    aoEnviar: (ag) => { if (ag.id === 'a3') throw new Error('app fechado'); },
  });
  await c.rodarCicloLembretes().catch(() => {});   // o ciclo morre no 3º envio

  assert.ok(marcado(c.store, 'a1'), 'Ana recebeu e ficou registrada');
  assert.ok(marcado(c.store, 'a2'), 'Bruno recebeu e ficou registrado');

  // Ciclo seguinte: só quem ainda não recebeu pode receber.
  const c2 = cenario({ agenda: c.store.agendamentos });
  await c2.rodarCicloLembretes();
  assert.deepStrictEqual(c2.enviados, ['a3'],
    'Ana e Bruno não podem receber a mesma mensagem duas vezes');
});

test('lembretes: falha de envio grava o erro e não bloqueia os outros', async () => {
  const c = cenario({ falharEm: ['a2'] });
  const r = await c.rodarCicloLembretes();
  assert.deepStrictEqual(c.enviados, ['a1', 'a2', 'a3'], 'um número ruim não aborta o ciclo');
  assert.strictEqual(r.enviados, 2);
  assert.strictEqual(r.erros, 1);
  assert.ok(!marcado(c.store, 'a2'), 'quem não recebeu não pode ficar marcado');
  assert.strictEqual(c.store.agendamentos.find(a => a.id === 'a2')._lembreteErro, 'numero invalido');
});

// Erro que o provedor lança em vez de devolver não pode derrubar o ciclo:
// os pacientes seguintes ficariam sem lembrete nenhum.
test('lembretes: envio que lança exceção não impede os próximos pacientes', async () => {
  const c = cenario({
    aoEnviar: (ag) => { if (ag.id === 'a1') throw new Error('rede caiu'); },
  });
  const r = await c.rodarCicloLembretes();
  assert.deepStrictEqual(c.enviados, ['a1', 'a2', 'a3']);
  assert.strictEqual(r.enviados, 2);
  assert.ok(!marcado(c.store, 'a1'));
  assert.ok(marcado(c.store, 'a2') && marcado(c.store, 'a3'));
});

test('lembretes: ciclo que já rodou hoje é pulado (não reenvia)', async () => {
  const c = cenario({ cfg: { ultimoEnvio: '2026-08-03' } });   // HOJE, no _ymd do teste
  const r = await c.rodarCicloLembretes();
  assert.deepStrictEqual(c.enviados, [], 'nenhuma mensagem pode sair');
  assert.strictEqual(r.skipped, 'já rodou hoje');
});

test('lembretes: "forçar envio" ignora a trava do dia, mas respeita quem já recebeu', async () => {
  const c = cenario({ cfg: { ultimoEnvio: '2026-08-03' } });
  await c.rodarCicloLembretes(true);
  assert.deepStrictEqual(c.enviados, ['a1', 'a2', 'a3'], 'forçado roda mesmo tendo rodado hoje');

  const c2 = cenario({ agenda: c.store.agendamentos, cfg: { ultimoEnvio: '2026-08-03' } });
  await c2.rodarCicloLembretes(true);
  assert.deepStrictEqual(c2.enviados, [],
    'forçar duas vezes não pode mandar a mesma mensagem de novo');
});

test('lembretes: desativado não manda nada', async () => {
  const c = cenario({ cfg: { ativo: false } });
  const r = await c.rodarCicloLembretes();
  assert.deepStrictEqual(c.enviados, []);
  assert.strictEqual(r.skipped, 'desativado');
});

// ---------- remarcar tem de rearmar o lembrete ----------
// _agendamentosParaLembrar filtra `!ag._lembreteEnviado`. Um agendamento que já
// recebeu lembrete e depois foi REMARCADO nunca mais entra num ciclo: a única
// mensagem que o paciente recebeu aponta pro dia errado, e nenhuma outra vem.
// Três telas remarcam — modal, arrastar na agenda e copiloto — e só o modal
// rearmava.
const { carregar: _carregar, recortarFuncao: _recF, fonte: _fonte } = require('./_extrair.js');

test('_limparLembreteSeRemarcou: rearma quando data ou hora mudou', () => {
  const { _limparLembreteSeRemarcou } = _carregar('_limparLembreteSeRemarcou', {});
  const base = () => ({ data: '2026-08-05', hora: '10:00',
                        _lembreteEnviado: '2026-08-04T13:00:00Z', _lembreteErro: 'x' });

  const mudouData = base(); mudouData.data = '2026-08-12';
  assert.strictEqual(_limparLembreteSeRemarcou(mudouData, '2026-08-05', '10:00'), true);
  assert.strictEqual(mudouData._lembreteEnviado, undefined);
  assert.strictEqual(mudouData._lembreteErro, undefined);

  const mudouHora = base(); mudouHora.hora = '16:00';
  _limparLembreteSeRemarcou(mudouHora, '2026-08-05', '10:00');
  assert.strictEqual(mudouHora._lembreteEnviado, undefined, 'mudar só a hora também invalida');
});

test('_limparLembreteSeRemarcou: não rearma quando nada mudou', () => {
  const { _limparLembreteSeRemarcou } = _carregar('_limparLembreteSeRemarcou', {});
  const ag = { data: '2026-08-05', hora: '10:00', _lembreteEnviado: 'ts' };
  assert.strictEqual(_limparLembreteSeRemarcou(ag, '2026-08-05', '10:00'), false);
  assert.strictEqual(ag._lembreteEnviado, 'ts',
    'salvar sem mexer no horário não pode fazer o paciente receber o lembrete duas vezes');
});

test('os três caminhos que remarcam chamam o mesmo rearme', () => {
  for (const fn of ['saveAgendamento', '_agDrop', '_agDropProf']) {
    const src = _recF(fn).replace(/\/\/[^\n]*/g, '');
    assert.match(src, /_limparLembreteSeRemarcou\(/, `${fn} remarca e precisa rearmar o lembrete`);
  }
  // O copiloto vive dentro do executeAIAction — confere no ramo.
  const bloco = _fonte.slice(_fonte.indexOf("tipo === 'mover_agendamento'"),
                            _fonte.indexOf("tipo === 'criar_bloqueio'"));
  assert.match(bloco, /_limparLembreteSeRemarcou\(/, 'mover pelo copiloto também remarca');
});

test('copiloto: mover agendamento respeita bloqueio da agenda', () => {
  const bloco = _fonte.slice(_fonte.indexOf("tipo === 'mover_agendamento'"),
                             _fonte.indexOf("tipo === 'criar_bloqueio'"))
                      .replace(/\/\/[^\n]*/g, '');
  assert.match(bloco, /_isBloqueado\(novaData, novaHora/,
    'o ramo vizinho (criar_agendamento) já validava — mover não pode furar o bloqueio');
  assert.match(bloco, /_temConflito\(/, 'e o conflito continua sendo checado');
});

// ---------- falha de envio precisa aparecer ----------
// `_lembreteErro` era gravado no agendamento e NUNCA lido. Com todos os envios
// recusados, o card continuava dizendo "✓ Ativo · último envio: hoje" e o
// disparo automático não emitia toast nenhum (só o sucesso emitia). O médico
// concluía que os pacientes foram avisados. Não foram — e ninguém aparece.
function ambienteCard(ags, cfg = {}) {
  let statusHtml = '', falhasHtml = '';
  const els = {
    'card-lembretes': {},
    'lemb-status': { set innerHTML(v) { statusHtml = v; } },
    'lemb-falhas': { set innerHTML(v) { falhasHtml = v; } },
    'lemb-ativo': {}, 'lemb-horas': {}, 'lemb-msg': {},
  };
  const s = _carregar(['_esc', 'renderLembretesCard'], {
    // O card passou a usar _waConnected (cobre Z-API E Cloud API), como já fazia
    // quem envia. Antes ele olhava só o Z-API e mentia nas duas direções.
    _waConnected: () => true,
    JSON, Array, Object, Date, String,
    document: { getElementById: (id) => els[id] || null },
    getLembretesConfig: () => ({ ativo: true, horasAntes: 24, mensagem: 'oi', ultimoEnvio: '2026-08-05', ...cfg }),
    getAgendamentos: () => JSON.parse(JSON.stringify(ags)),
    _ymd: () => '2026-08-05',
    formatDate: (d) => d,
  });
  s.renderLembretesCard();
  return { statusHtml, falhasHtml };
}

test('card: lembrete recusado aparece com paciente e motivo', () => {
  const { statusHtml, falhasHtml } = ambienteCard([
    { pacienteNome: 'Ana', data: '2026-08-06', hora: '10:00', status: 'Confirmado',
      _lembreteErro: 'numero invalido' },
  ]);
  assert.match(statusHtml, /Ativo/, 'a premissa: o card diz que está ativo');
  assert.match(falhasHtml, /1 lembrete\(s\) não entregue/);
  assert.match(falhasHtml, /Ana/);
  assert.match(falhasHtml, /numero invalido/);
});

test('card: sem falha, nada de alarme falso', () => {
  const { falhasHtml } = ambienteCard([
    { pacienteNome: 'Ana', data: '2026-08-06', status: 'Confirmado', _lembreteEnviado: 'ts' },
    { pacienteNome: 'Bruno', data: '2026-08-06', status: 'Confirmado' },
  ]);
  assert.strictEqual(falhasHtml, '');
});

test('card: falha já reenviada com sucesso some da lista', () => {
  const { falhasHtml } = ambienteCard([
    { pacienteNome: 'Ana', data: '2026-08-06', status: 'Confirmado',
      _lembreteErro: 'timeout', _lembreteEnviado: '2026-08-05T12:00:00Z' },
  ]);
  assert.strictEqual(falhasHtml, '', 'o erro fica no registro, mas o envio seguinte deu certo');
});

test('card: agendamento passado ou cancelado não vira alarme', () => {
  const { falhasHtml } = ambienteCard([
    { pacienteNome: 'Ana', data: '2026-07-01', status: 'Confirmado', _lembreteErro: 'x' },
    { pacienteNome: 'Bruno', data: '2026-08-09', status: 'Cancelado', _lembreteErro: 'x' },
  ]);
  assert.strictEqual(falhasHtml, '');
});

test('card: motivo e nome passam por _esc', () => {
  const { falhasHtml } = ambienteCard([
    { pacienteNome: '<script>x</script>', data: '2026-08-06', status: 'Confirmado',
      _lembreteErro: '<img src=x onerror=y>' },
  ]);
  assert.ok(!falhasHtml.includes('<script>x'), 'nome pode vir do perfil do WhatsApp');
  assert.ok(!falhasHtml.includes('<img src=x'), 'motivo vem do provedor');
});

test('ciclo: rodada 100% falha não bloqueia a retentativa do dia', () => {
  const src = _recF('rodarCicloLembretes').replace(/\/\/[^\n]*/g, '');
  assert.match(src, /if \(sucesso > 0 \|\| erro === 0\) _marcarLembretesRodaramHoje\(hoje\);/,
    'carimbar "já rodou hoje" depois de falhar tudo faz o paciente nunca ser avisado: '
    + 'no dia seguinte o agendamento já saiu da janela de lembrete');
});

// ---------- o ciclo não pode devolver a configuração de minutos atrás ----------
// O `cfg` do ciclo é lido ANTES do primeiro envio. O laço dorme 800ms por
// paciente e cada envio pode levar até 15s quando o provedor não responde: uma
// rodada com 10 agendamentos passa fácil de meio minuto, com a tela viva o
// tempo todo. Gravar aquele objeto no fim devolvia a mensagem antiga e RELIGAVA
// os lembretes que o médico tinha acabado de desligar — e desligar no meio de
// uma rodada é exatamente o que ele faz quando vê saindo mensagem errada.
test('ciclo: desligar os lembretes durante a rodada não é desfeito no fim', async () => {
  const c = cenario({ agenda: [
    { id: 'a1', pacienteNome: 'Ana', whatsapp: '11999990000', data: '2026-08-04', status: 'Confirmado' },
    { id: 'a2', pacienteNome: 'Bruno', whatsapp: '11888880000', data: '2026-08-04', status: 'Confirmado' },
  ] });
  // A configuração passa a viver no store, como no app.
  c.sandbox.getLembretesConfig = () => Object.assign(
    { ativo: true, horasAntes: 24, mensagem: 'texto antigo', ultimoEnvio: null },
    c.store.lembretes_config);
  // O médico abre Configurações no meio do laço e desliga.
  c.sandbox._enviarLembreteZapi = async (ag) => {
    c.enviados.push(ag.id);
    if (ag.id === 'a1') c.store.lembretes_config = { ativo: false, horasAntes: 24, mensagem: 'texto novo', ultimoEnvio: null };
    return { ok: true };
  };
  await c.rodarCicloLembretes();
  assert.strictEqual(c.store.lembretes_config.ativo, false,
    'o ciclo religou os lembretes que o médico desligou');
  assert.strictEqual(c.store.lembretes_config.mensagem, 'texto novo',
    'e devolveu a mensagem antiga por cima da que ele acabou de salvar');
  assert.strictEqual(c.store.lembretes_config.ultimoEnvio, '2026-08-03',
    'o campo que É do ciclo continua sendo carimbado');
});

test('disparo automático avisa a falha, como o do backup logo acima', () => {
  // A tarefa saiu de dentro do _iniciarApp e virou função nomeada, pra poder ser
  // reexecutada pelo agendador — o _iniciarApp roda uma vez por carregamento.
  const src = _recF('_tarefaLembretes').replace(/\/\/[^\n]*/g, '');
  assert.match(src, /r\.erros > 0[\s\S]{0,300}toast\(/,
    'só o sucesso gerava toast — falhar tudo não dizia nada na tela');
  assert.match(src, /\.catch\(/,
    'promise sem catch dentro de setTimeout some com o erro');
});

// ---------- duas rodadas sobrepostas mandariam a mesma mensagem duas vezes ----------
// O ciclo dorme 800ms entre cada paciente: uma rodada com 10 agendamentos leva
// mais de 8 segundos. E ele tem TRÊS gatilhos — a abertura do app, o intervalo
// de 15 minutos e a aba voltando pra frente. Sem trava, duas rodadas
// sobrepostas leem o mesmo agendamento como "não enviado" antes de qualquer uma
// marcar, e o paciente recebe a MESMA mensagem duas vezes. O _drenarOutbox já
// usava exatamente esta trava, pelo mesmo motivo.
test('ciclo: segunda chamada durante a primeira é recusada', async () => {
  const a = cenario({ agenda: [
    { id: 'a1', pacienteNome: 'Ana', whatsapp: '11999990000', data: '2026-08-04', status: 'Confirmado' },
    { id: 'a2', pacienteNome: 'Bruno', whatsapp: '11888880000', data: '2026-08-04', status: 'Confirmado' },
  ] });
  // Dispara a segunda rodada enquanto a primeira ainda está no meio do laço.
  let segunda = null;
  const primeira = a.rodarCicloLembretes();
  segunda = await a.rodarCicloLembretes();
  await primeira;
  assert.strictEqual(segunda.skipped, 'ciclo já em andamento');
  assert.deepStrictEqual(a.enviados, ['a1', 'a2'], 'cada paciente recebe uma vez só');
});

test('ciclo: a trava é liberada no fim, mesmo com falha de envio', async () => {
  const a = cenario({
    agenda: [{ id: 'a1', pacienteNome: 'Ana', whatsapp: '11999990000',
               data: '2026-08-04', status: 'Confirmado' }],
    falharEm: ['a1'],
  });
  await a.rodarCicloLembretes();
  // Se a trava tivesse ficado presa, esta segunda rodada seria recusada.
  const r = await a.rodarCicloLembretes();
  assert.notStrictEqual(r.skipped, 'ciclo já em andamento',
    'trava presa depois de uma falha impediria QUALQUER envio até recarregar a página');
});

test('a trava do ciclo segue o mesmo padrão do _drenarOutbox', () => {
  const src = _recF('rodarCicloLembretes').replace(/\/\/[^\n]*/g, '');
  assert.match(src, /if \(_cicloLembretesRodando\) return/);
  assert.match(src, /finally \{ _cicloLembretesRodando = false; \}/,
    'sem finally, uma exceção no meio deixaria a trava presa pra sempre');
});

// ---------- o card não pode olhar um provedor só ----------
// Quem ENVIA (rodarCicloLembretes) usa _waConnected, que cobre Z-API e Cloud
// API. O card olhava só o Z-API e mentia nas duas direções — e é o único lugar
// onde a pessoa confere se os lembretes estão de pé.
function cardCom(waOk) {
  let statusHtml = '';
  const els = { 'card-lembretes': {}, 'lemb-status': { set innerHTML(v) { statusHtml = v; } },
                'lemb-falhas': { set innerHTML(v) {} }, 'lemb-ativo': {}, 'lemb-horas': {}, 'lemb-msg': {} };
  _carregar(['_esc', 'renderLembretesCard'], {
    JSON, Array, Object, Date, String,
    _waConnected: () => waOk,
    document: { getElementById: (id) => els[id] || null },
    getLembretesConfig: () => ({ ativo: true, horasAntes: 24, mensagem: '', ultimoEnvio: '2026-08-05' }),
    getAgendamentos: () => [],
    _ymd: () => '2026-08-05', formatDate: (d) => d,
  }).renderLembretesCard();
  return statusHtml;
}

test('card: com WhatsApp conectado por QUALQUER provedor, diz Ativo', () => {
  assert.match(cardCom(true), /Ativo/,
    'clínica na Cloud API via "Z-API não conectado" para sempre, com tudo funcionando');
});

test('card: sem WhatsApp conectado, avisa sem citar provedor específico', () => {
  const html = cardCom(false);
  assert.match(html, /WhatsApp não conectado/);
  assert.ok(!html.includes('Z-API'), 'o aviso vale pros dois provedores');
});

test('card e envio usam a MESMA checagem de conexão', () => {
  const card = _recF('renderLembretesCard').replace(/\/\/[^\n]*/g, '');
  const ciclo = _recF('rodarCicloLembretes').replace(/\/\/[^\n]*/g, '');
  assert.match(card, /_waConnected\(\)/);
  assert.match(ciclo, /_waConnected\(\)/);
  assert.doesNotMatch(card, /getZapiConfig\(\)/,
    'duas checagens diferentes pra mesma coisa é como quase todo achado desta revisão começou');
});
