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
