// Seeds de fábrica — rode com: node --test
//
// A regra do projeto é "nunca apagar dado com base em array local vazio", e o
// seed é o caso menos óbvio dela: ele não apaga, ele GRAVA — e o DB.set empurra
// o que gravou por cima da nuvem. O efeito é o mesmo.
//
// O getProgramas era o pior: recompunha os 5 templates de fábrica quando a flag
// `consult_progs_seeded_v2` faltasse OU o array estivesse vazio. Flag ausente é
// o estado NORMAL de qualquer aparelho novo — bastava o médico abrir o app no
// celular pra os programas dele (preço, marcos, campos clínicos, os que ele
// mesmo criou) serem trocados pelos de fábrica e empurrados pro servidor,
// sumindo de todos os aparelhos. As inscrições apontando pro programaId dele
// viravam órfãs.

const { test } = require('node:test');
const assert = require('node:assert');
const { carregar, fonte } = require('./_extrair.js');

function ambiente({ logado = true, pullOk = true, chavesNaNuvem = [], local = {} } = {}) {
  const store = Object.assign({}, local);
  const gravados = [];
  const s = carregar(['const:_PROF_CORES', '_contaNovaPara', 'getProgramas',
                      'getProcedimentos', 'getProfissionais'], {
    currentUser: logado ? { id: 'u1' } : null,
    _pullConcluido: pullOk,
    _chavesNaNuvem: new Set(chavesNaNuvem),
    console: { log() {}, warn() {} },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    DB: {
      get: (k) => JSON.parse(store['consult_' + k] || '[]'),
      set: (k, v) => { store['consult_' + k] = JSON.stringify(v); gravados.push(k); return Promise.resolve(true); },
    },
  });
  return { ...s, store, gravados };
}

const MEUS_PROGRAMAS = JSON.stringify([
  { id: 'pg_1770000000000', nome: 'Meu programa autoral', tipo: 'Fixo', precoAVista: 4200, ativo: true },
]);

test('aparelho novo NÃO troca os programas do médico pelos de fábrica', () => {
  // A nuvem devolveu a coleção; a flag local não existe porque o aparelho é novo.
  const a = ambiente({ chavesNaNuvem: ['programas'], local: { consult_programas: MEUS_PROGRAMAS } });
  const progs = a.getProgramas();
  assert.equal(progs.length, 1);
  assert.equal(progs[0].nome, 'Meu programa autoral');
  assert.deepStrictEqual(a.gravados, [], 'nada pode ser empurrado pra nuvem só por abrir a tela');
});

test('coleção esvaziada de propósito não ressuscita no outro aparelho', () => {
  // O médico apagou todos os programas no computador; `[]` é uma RESPOSTA da
  // nuvem, não ausência. Ressemear aqui devolveria os 5 templates pra ele.
  const a = ambiente({ chavesNaNuvem: ['programas'], local: { consult_programas: '[]' } });
  assert.deepStrictEqual(a.getProgramas(), []);
  assert.deepStrictEqual(a.gravados, []);
});

test('pull que falhou não semeia — vazio ali significa "não sei"', () => {
  const a = ambiente({ pullOk: false });
  assert.deepStrictEqual(a.getProgramas(), []);
  assert.deepStrictEqual(a.getProcedimentos(), []);
  assert.deepStrictEqual(a.getProfissionais(), []);
  assert.deepStrictEqual(a.gravados, [],
    'semear no escuro grava por cima do que o servidor tem e o aparelho ainda não leu');
});

test('conta nova de verdade recebe os seeds', () => {
  // Pull terminou sem erro e a conta não tem nenhuma dessas chaves.
  const a = ambiente({ pullOk: true, chavesNaNuvem: [] });
  assert.ok(a.getProgramas().length > 0, 'clínica nova precisa dos templates');
  assert.ok(a.getProcedimentos().length > 0, 'clínica nova precisa da tabela de preços');
  assert.equal(a.getProfissionais().length, 1);
  assert.equal(a.getProfissionais()[0].id, 'prof_titular');
  assert.deepStrictEqual([...new Set(a.gravados)].sort(),
    ['procedimentos', 'profissionais', 'programas']);
});

test('semeia uma vez só no mesmo aparelho', () => {
  const a = ambiente({ pullOk: true, chavesNaNuvem: [] });
  a.getProgramas();
  const antes = a.gravados.length;
  a.store.consult_programas = '[]';   // médico apagou tudo depois
  a.getProgramas();
  assert.equal(a.gravados.length, antes, 'a flag local já disse que esta conta foi semeada');
});

test('fora de sessão o seed continua valendo (simulação por console)', () => {
  const a = ambiente({ logado: false, pullOk: false });
  assert.ok(a.getProgramas().length > 0);
});

test('_contaNovaPara distingue as três respostas', () => {
  assert.equal(ambiente({ pullOk: false })._contaNovaPara('programas'), false, 'pull incompleto = não sei');
  assert.equal(ambiente({ pullOk: true, chavesNaNuvem: ['programas'] })._contaNovaPara('programas'), false);
  assert.equal(ambiente({ pullOk: true, chavesNaNuvem: [] })._contaNovaPara('programas'), true);
});

test('todo seed do app passa por _contaNovaPara', () => {
  const semGuarda = [];
  fonte.split('\n').forEach((l, i) => {
    if (/!localStorage\.getItem\('consult_\w*seed/.test(l) && !l.includes('_contaNovaPara')) {
      semGuarda.push((i + 1) + ': ' + l.trim());
    }
  });
  assert.deepStrictEqual(semGuarda, [],
    'seed sem a guarda grava por cima da nuvem no primeiro aparelho novo');
});

test('o cloudPull registra a chave ANTES de qualquer desvio', () => {
  // Se o _chavesNaNuvem.add ficasse depois do `if (_outboxPendente) return`,
  // uma chave com escrita local pendente sumiria do conjunto e o seed veria
  // "conta nunca teve isto" — justamente na chave que estava sendo editada.
  const corpo = fonte.slice(fonte.indexOf('async function cloudPull'));
  const trecho = corpo.slice(0, corpo.indexOf('console.log(`cloudPull'));
  assert.ok(trecho.indexOf('_chavesNaNuvem.add') < trecho.indexOf('_outboxPendente'),
    'a existência da chave tem de ser registrada antes do desvio do outbox');
});
