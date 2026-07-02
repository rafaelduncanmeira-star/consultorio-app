// Testes da camada de sync (outbox + merge de conflito) — rode com: node --test
// Exercitam o código REAL recortado do app.js (ver tests/_extrair.js).

const { test } = require('node:test');
const assert = require('node:assert');
const { carregar } = require('./_extrair.js');

// localStorage falso compartilhável entre as funções extraídas.
function fakeLS(inicial = {}) {
  const store = { ...inicial };
  return {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    _store: store,
  };
}

// ---------- Outbox: fila de escritas não confirmadas ----------
test('outbox: add/pendente/remove funcionam e persistem no localStorage', () => {
  const ls = fakeLS();
  const { _outboxAdd, _outboxRemove, _outboxPendente } = carregar(
    ['_outboxGet', '_outboxAdd', '_outboxRemove', '_outboxPendente'],
    { localStorage: ls, Date }
  );
  assert.strictEqual(_outboxPendente('despesas'), false);
  _outboxAdd('despesas', 'blob');
  assert.strictEqual(_outboxPendente('despesas'), true);
  const salvo = JSON.parse(ls._store['consult__outbox']);
  assert.strictEqual(salvo.despesas.tipo, 'blob');
  _outboxRemove('despesas');
  assert.strictEqual(_outboxPendente('despesas'), false);
});

test('outbox: JSON corrompido no localStorage não quebra (recomeça vazio)', () => {
  const ls = fakeLS({ 'consult__outbox': '{corrompido' });
  const { _outboxPendente, _outboxAdd } = carregar(
    ['_outboxGet', '_outboxAdd', '_outboxPendente'],
    { localStorage: ls, Date }
  );
  assert.strictEqual(_outboxPendente('x'), false);
  _outboxAdd('x', 'blob'); // não deve lançar
  assert.strictEqual(_outboxPendente('x'), true);
});

test('outbox: chaves diferentes não interferem entre si', () => {
  const ls = fakeLS();
  const { _outboxAdd, _outboxRemove, _outboxPendente } = carregar(
    ['_outboxGet', '_outboxAdd', '_outboxRemove', '_outboxPendente'],
    { localStorage: ls, Date }
  );
  _outboxAdd('despesas', 'blob');
  _outboxAdd('agendamentos', 'blindada');
  _outboxRemove('despesas');
  assert.strictEqual(_outboxPendente('despesas'), false);
  assert.strictEqual(_outboxPendente('agendamentos'), true);
});

// ---------- Merge de conflito entre aparelhos ----------
test('merge: mantém versão local e ANEXA itens que só existem no servidor', () => {
  const { _mesclarArraysPorId } = carregar('_mesclarArraysPorId', { Set });
  const servidor = [
    { id: 'a', descricao: 'Aluguel', valor: 100 },
    { id: 'c', descricao: 'Criado no celular', valor: 50 },
  ];
  const local = [
    { id: 'a', descricao: 'Aluguel EDITADO', valor: 120 }, // edição local vence
    { id: 'b', descricao: 'Criado no PC', valor: 30 },
  ];
  const out = JSON.parse(JSON.stringify(_mesclarArraysPorId(servidor, local)));
  assert.deepStrictEqual(out, [
    { id: 'a', descricao: 'Aluguel EDITADO', valor: 120 },
    { id: 'b', descricao: 'Criado no PC', valor: 30 },
    { id: 'c', descricao: 'Criado no celular', valor: 50 }, // nada se perde
  ]);
});

test('merge: recusa (null) quando algum item não tem id — merge sem id é inseguro', () => {
  const { _mesclarArraysPorId } = carregar('_mesclarArraysPorId', { Set });
  assert.strictEqual(_mesclarArraysPorId([{ id: 'a' }], [{ descricao: 'sem id' }]), null);
  assert.strictEqual(_mesclarArraysPorId([{ nome: 'sem id' }], [{ id: 'b' }]), null);
});

test('merge: recusa (null) quando os valores não são arrays (config/objetos)', () => {
  const { _mesclarArraysPorId } = carregar('_mesclarArraysPorId', { Set });
  assert.strictEqual(_mesclarArraysPorId({ tema: 'claro' }, { tema: 'escuro' }), null);
  assert.strictEqual(_mesclarArraysPorId([{ id: 'a' }], 'não-array'), null);
});

test('merge: arrays idênticos passam ilesos (pull recém-feito não duplica)', () => {
  const { _mesclarArraysPorId } = carregar('_mesclarArraysPorId', { Set });
  const arr = [{ id: 'a', v: 1 }, { id: 'b', v: 2 }];
  const out = JSON.parse(JSON.stringify(_mesclarArraysPorId(arr, arr)));
  assert.deepStrictEqual(out, arr);
});
