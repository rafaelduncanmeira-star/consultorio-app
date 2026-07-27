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
  const { rodarCicloLembretes } = carregar('rodarCicloLembretes', sandbox);
  return { rodarCicloLembretes, store, enviados };
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
