// Arranque e drenagem da fila — rode com: node --test
//
// Cadeia confirmada no código: uma coleção com JSON corrompido no localStorage
// (gravação cortada por falta de espaço, por exemplo) fazia o JSON.parse dentro
// do _drenarOutbox lançar. A exceção subia por _drenarOutbox → cloudPull (que
// chamava a drenagem FORA do próprio try) → DOMContentLoaded (sem catch): o
// _iniciarApp nunca rodava e o app simplesmente NÃO ABRIA. A única saída era
// limpar o navegador, levando junto tudo que ainda não tinha sincronizado.

const { test } = require('node:test');
const assert = require('node:assert');
const { carregar, recortarFuncao, fonte } = require('./_extrair.js');

function ambiente({ blobs = {}, outbox = {} } = {}) {
  const enviadas = [];
  const refila = [];
  const s = carregar(['const:_OUTBOX_TETO', '_drenarOutbox'], {
    JSON, Object, console: { warn() {}, log() {} },
    _drenandoOutbox: false,
    _supa: {}, currentUser: { id: 'u1' },
    _outboxGet: () => outbox,
    _outboxRemove: (k) => enviadas.push(k),
    _outboxAdd: (k, t) => refila.push(k),
    _BLINDADAS: { pacientes: { tabela: 'clinica_atendimentos' }, crm: { tabela: 'clinica_crm' } },
    localStorage: { getItem: (k) => (k in blobs ? blobs[k] : null) },
    _pushBlindada: async () => true,
    cloudPush: async () => {},
  });
  return { ...s, enviadas, refila };
}

test('chave corrompida não derruba a drenagem das outras', async () => {
  const a = ambiente({
    blobs: { consult_pacientes: '[{"id":"p1"}', consult_crm: '[{"id":"c1"}]' }, // 1ª truncada
    outbox: { pacientes: { tipo: 'blindada' }, crm: { tipo: 'blindada' } },
  });
  await assert.doesNotReject(() => a._drenarOutbox());
  assert.deepStrictEqual(a.enviadas, ['crm'], 'a chave boa tem de ser entregue mesmo assim');
  assert.deepStrictEqual(a.refila, ['pacientes'], 'a corrompida volta pra fila, não some');
});

test('chave ilegível NÃO é apagada — dado ilegível ainda é dado do usuário', () => {
  const src = recortarFuncao('_drenarOutbox').replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(src, /removeItem/,
    'apagar aqui seria exatamente a perda que a fila existe pra impedir');
  assert.match(src, /catch \(e\)[\s\S]{0,200}_outboxAdd\(/,
    'a chave problemática continua na fila e visível no cartão de sincronização');
});

test('cloudPull drena DENTRO do próprio try', () => {
  const src = recortarFuncao('cloudPull').replace(/\/\/[^\n]*/g, '');
  const iTry = src.indexOf('try {');
  const iDrena = src.indexOf('_drenarOutbox()');
  assert.ok(iTry > 0 && iDrena > iTry,
    'fora do try, uma exceção na drenagem rejeitava o cloudPull inteiro');
});

test('o app abre mesmo com a sincronização inicial falhando', () => {
  const semCom = fonte.replace(/\/\/[^\n]*/g, '');
  // O bloco do arranque: cloudPull + realtime dentro de try, _iniciarApp fora.
  const m = /try \{\s*await cloudPull\(\);[\s\S]{0,400}?\} catch \(e\) \{[\s\S]{0,300}?\}\s*_iniciarApp\(\);/
    .exec(semCom);
  assert.ok(m,
    'sem isto, exceção na sincronização deixa o _iniciarApp sem rodar: a pessoa '
    + 'fica olhando uma tela que nunca monta, com os dados dela intactos e inalcançáveis');
  assert.match(m[0], /toast\(/, 'e precisa dizer que está trabalhando só com o aparelho');
});

// ---------- um render que lança não pode levar o resto junto ----------
// _iniciarApp era uma sequência solta de chamadas. O primeiro passo que
// lançasse levava todos os seguintes, e o app ficava meio montado sem nada na
// tela explicando.
function arranque({ quebrar = [] } = {}) {
  const rodou = [];
  const toasts = [];
  const timers = [];
  const stub = (nome) => () => {
    rodou.push(nome);
    if (quebrar.includes(nome)) throw new Error('boom em ' + nome);
  };
  const s = carregar('_iniciarApp', {
    console: { warn() {}, log() {} },
    currentUser: { id: 'u1' }, currentRole: 'medico',
    document: { getElementById: () => ({ style: {} }) },
    window: {},
    localStorage: { getItem: () => null },
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    toast: (t) => toasts.push(t),
    _applyRole: stub('_applyRole'),
    _atualizarSidebar: stub('_atualizarSidebar'),
    applyClinicaConfig: stub('applyClinicaConfig'),
    _reorderDashboardSections: stub('_reorderDashboardSections'),
    renderDashboard: stub('renderDashboard'),
    saudacaoDiaria: stub('saudacaoDiaria'),
    _mobSync: stub('_mobSync'),
    checkAchievements: () => {},
    _tarefaBackupDiario: () => {}, _tarefaLembretes: () => {},
    _agendarTarefasDoDia: stub('_agendarTarefasDoDia'),
    mostrarOnboarding: () => {},
  });
  s._iniciarApp();
  return { rodou, toasts };
}

test('arranque: o gate de permissões roda ANTES de qualquer render', () => {
  const a = arranque();
  assert.strictEqual(a.rodou[0], '_applyRole',
    'com o gate depois da sidebar, uma exceção na sidebar deixava o profissional '
    + 'vendo as seções financeiras que o RLS esconde dele');
});

test('arranque: dashboard quebrado não desarma backup nem lembretes', () => {
  const a = arranque({ quebrar: ['renderDashboard'] });
  assert.ok(a.rodou.includes('_agendarTarefasDoDia'),
    'o render é o passo com mais conta e mais chance de tropeçar num dado esquisito; '
    + 'um erro ali desarmava o agendador pela sessão inteira');
  assert.ok(a.rodou.includes('_mobSync'), 'e os passos seguintes também continuam');
});

test('arranque: falha no primeiro passo não impede os demais', () => {
  const a = arranque({ quebrar: ['_applyRole'] });
  for (const p of ['_atualizarSidebar', 'renderDashboard', '_agendarTarefasDoDia']) {
    assert.ok(a.rodou.includes(p), `${p} tem de rodar mesmo assim`);
  }
});

test('arranque: o que falhou é dito na tela, com nome', () => {
  const a = arranque({ quebrar: ['renderDashboard', 'saudacaoDiaria'] });
  assert.match(a.toasts.join(' '), /Parte da tela não carregou/);
  assert.match(a.toasts.join(' '), /dashboard/);
  assert.match(a.toasts.join(' '), /saudação/);
});

test('arranque: sem falha, nenhum alarme', () => {
  const a = arranque();
  assert.deepStrictEqual(a.toasts, []);
});
