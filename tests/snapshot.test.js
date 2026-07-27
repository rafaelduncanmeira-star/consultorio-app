// Testes do backup automático diário — rode com: node --test
// Rodam o criarSnapshotDiario REAL contra um localStorage falso com COTA, que
// é o que o navegador tem de verdade. O backup é a rede de segurança de tudo
// mais; quando ele para de acontecer, ninguém percebe até precisar dele.

const { test } = require('node:test');
const assert = require('node:assert');
const { carregar } = require('./_extrair.js');

// localStorage com limite de bytes, como o do navegador. As chaves precisam ser
// propriedades ENUMERÁVEIS do próprio objeto: o app varre com
// `Object.keys(localStorage)` pra achar os snapshots. Um fake que guarda os
// dados num `store` separado faz essa varredura devolver vazio, e o teste passa
// a exercitar um caminho que não existe.
function lsComCota(limiteBytes = Infinity, inicial = {}) {
  const ls = { ...inicial };
  const tamanho = () => Object.keys(ls).reduce((t, k) => t + k.length + String(ls[k]).length, 0);
  const metodo = (nome, fn) => Object.defineProperty(ls, nome, { value: fn, enumerable: false });
  metodo('getItem', (k) => (k in ls ? ls[k] : null));
  metodo('removeItem', (k) => { delete ls[k]; });
  metodo('setItem', (k, v) => {
    const anterior = ls[k];
    ls[k] = String(v);
    if (tamanho() > limiteBytes) {
      if (anterior === undefined) delete ls[k]; else ls[k] = anterior;
      const e = new Error('QuotaExceededError');
      e.name = 'QuotaExceededError';
      throw e;
    }
  });
  return { store: ls, api: ls };
}

const FNS = ['_ymd', '_snapshotsLocais', '_gravarSnapshot', '_limparSnapshotsAntigos', 'criarSnapshotDiario'];

function cenario({ limite = Infinity, inicial = {}, dados = {} } = {}) {
  const ls = lsComCota(limite, {
    consult_pacientes: JSON.stringify([{ id: 'p1', nome: 'Ana' }]),
    ...dados, ...inicial,
  });
  const sandbox = {
    localStorage: ls.api, JSON, Date, Math, Object, Error, Promise, String,
    console: { warn() {}, log() {} },
    currentUser: { id: 'dono' }, currentDataOwner: null,
    _supa: null,
    cloudPush: async () => {},
    MAX_SNAPSHOTS: 7,
    SNAPSHOT_PREFIX: '_snapshot_',
    BACKUP_KEYS: ['pacientes', 'crm', 'despesas'],
  };
  const fns = carregar(FNS, sandbox);
  return { ...fns, ls };
}

const chavesSnap = (ls) => Object.keys(ls.store).filter(k => k.startsWith('consult__snapshot_')).sort();

test('snapshot: cria o backup do dia com as coleções conhecidas', async () => {
  const c = cenario();
  const r = await c.criarSnapshotDiario();
  assert.ok(r.created);
  const chave = 'consult__snapshot_' + c._ymd(new Date());
  const snap = JSON.parse(c.ls.store[chave]);
  assert.deepStrictEqual(snap.pacientes, [{ id: 'p1', nome: 'Ana' }]);
  assert.ok(snap._meta.automatico);
});

test('snapshot: não refaz o backup se já existe o de hoje', async () => {
  const c = cenario();
  await c.criarSnapshotDiario();
  const r2 = await c.criarSnapshotDiario();
  assert.ok(r2.skipped);
});

// O ACHADO: a poda rodava DEPOIS do setItem. Bastava o localStorage encher uma
// vez pro setItem lançar, a poda nunca rodar e o backup automático parar PARA
// SEMPRE — sem nada na tela, porque o chamador não tinha catch. E o app nunca
// mais conseguia liberar espaço sozinho.
test('snapshot: com o navegador cheio, descarta backup velho e grava o de hoje', async () => {
  const antigos = {};
  for (const d of ['2020-01-01', '2020-01-02', '2020-01-03']) {
    antigos['consult__snapshot_' + d] = 'x'.repeat(400);
  }
  const c = cenario({ limite: 1400, inicial: antigos });
  const r = await c.criarSnapshotDiario();

  assert.ok(r.created, 'o backup de hoje TEM de existir mesmo com o navegador cheio');
  const hoje = 'consult__snapshot_' + c._ymd(new Date());
  assert.ok(hoje in c.ls.store);
  assert.ok(!('consult__snapshot_2020-01-01' in c.ls.store), 'o mais velho é o primeiro a sair');
});

test('snapshot: sem espaço e sem backup velho pra descartar, avisa em vez de estourar', async () => {
  const c = cenario({ limite: 10 });   // não cabe nem o snapshot vazio
  const r = await c.criarSnapshotDiario();
  assert.ok(r.error, 'tem de devolver erro, não lançar');
  assert.match(r.error, /espaço/i);
  assert.deepStrictEqual(chavesSnap(c.ls), [], 'nada meia-boca gravado');
});

// Uma chave corrompida derrubava o backup INTEIRO: o JSON.parse lançava e a
// promise morria sem catch. Melhor um backup com um buraco do que nenhum.
test('snapshot: coleção corrompida sai do backup, o resto é salvo', async () => {
  const c = cenario({ dados: { consult_crm: '{isso não é json' } });
  const r = await c.criarSnapshotDiario();
  assert.ok(r.created, 'o backup não pode morrer por causa de uma chave ruim');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r.ilegiveis)), ['crm']);  // realm do vm
  const snap = JSON.parse(c.ls.store['consult__snapshot_' + c._ymd(new Date())]);
  assert.ok(snap.pacientes, 'o que estava legível foi salvo');
  assert.ok(!('crm' in snap));
});

test('snapshot: membro da equipe não cria backup da clínica inteira', async () => {
  const ls = lsComCota();
  const s = carregar(FNS, {
    localStorage: ls.api, JSON, Date, Math, Object, Error, Promise, String,
    console: { warn() {}, log() {} },
    currentUser: { id: 'membro' }, currentDataOwner: 'dono',   // é membro
    _supa: null, cloudPush: async () => {},
    MAX_SNAPSHOTS: 7, SNAPSHOT_PREFIX: '_snapshot_', BACKUP_KEYS: ['pacientes'],
  });
  const r = await s.criarSnapshotDiario();
  assert.ok(r.skipped);
  assert.deepStrictEqual(chavesSnap(ls), []);
});

test('_limparSnapshotsAntigos: mantém os N mais recentes e descarta o resto', async () => {
  const inicial = {};
  for (let d = 1; d <= 10; d++) {
    inicial['consult__snapshot_2026-08-' + String(d).padStart(2, '0')] = '{}';
  }
  const c = cenario({ inicial });
  await c._limparSnapshotsAntigos(3);
  assert.deepStrictEqual(chavesSnap(c.ls), [
    'consult__snapshot_2026-08-08',
    'consult__snapshot_2026-08-09',
    'consult__snapshot_2026-08-10',
  ], 'os 3 mais novos ficam');
});
