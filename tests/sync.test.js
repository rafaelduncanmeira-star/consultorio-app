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
    ['const:_OUTBOX_TETO', '_outboxGet', '_outboxAdd', '_outboxRemove', '_outboxPendente'],
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
    ['const:_OUTBOX_TETO', '_outboxGet', '_outboxAdd', '_outboxPendente'],
    { localStorage: ls, Date }
  );
  assert.strictEqual(_outboxPendente('x'), false);
  _outboxAdd('x', 'blob'); // não deve lançar
  assert.strictEqual(_outboxPendente('x'), true);
});

test('outbox: chaves diferentes não interferem entre si', () => {
  const ls = fakeLS();
  const { _outboxAdd, _outboxRemove, _outboxPendente } = carregar(
    ['const:_OUTBOX_TETO', '_outboxGet', '_outboxAdd', '_outboxRemove', '_outboxPendente'],
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

const mudo = { warn() {}, log() {} };

// ---------- Outbox: teto de tentativas ----------
const OUTBOX_FNS = ['const:_OUTBOX_TETO', '_outboxGet', '_outboxAdd', '_outboxRemove',
                    '_outboxPendente', '_outboxTravado', '_outboxResetTentativas'];

// Uma escrita que o servidor NUNCA vai aceitar (RLS) ficava presa na fila pra
// sempre. Como o pull pula chave pendente, o aparelho congelava naquela coleção:
// parava de receber o que os outros aparelhos gravavam, sem nenhum aviso.
test('outbox: para de bloquear o pull depois do teto de tentativas', () => {
  const ls = fakeLS();
  const s = carregar(OUTBOX_FNS, { localStorage: ls, Date, JSON });
  for (let i = 1; i < s._OUTBOX_TETO; i++) {
    s._outboxAdd('pacientes', 'blindada');
    assert.strictEqual(s._outboxPendente('pacientes'), true,
      `tentativa ${i}: ainda é plausível entregar, o pull deve esperar`);
    assert.strictEqual(s._outboxTravado('pacientes'), false);
  }
  s._outboxAdd('pacientes', 'blindada'); // estoura o teto
  assert.strictEqual(s._outboxPendente('pacientes'), false, 'pull volta a rodar');
  assert.strictEqual(s._outboxTravado('pacientes'), true, 'mas segue anotado pra diagnóstico');
});

test('outbox: conta tentativas por chave, sem contaminar as outras', () => {
  const ls = fakeLS();
  const s = carregar(OUTBOX_FNS, { localStorage: ls, Date, JSON });
  s._outboxAdd('pacientes', 'blindada');
  s._outboxAdd('pacientes', 'blindada');
  s._outboxAdd('crm', 'blindada');
  assert.strictEqual(s._outboxGet().pacientes.tentativas, 2);
  assert.strictEqual(s._outboxGet().crm.tentativas, 1);
  s._outboxRemove('pacientes');
  assert.strictEqual(s._outboxGet().crm.tentativas, 1, 'remover uma não mexe na outra');
});

// Ficar sem rede não pode gastar o orçamento reservado pra detectar rejeição
// definitiva: ao voltar a conexão, todo mundo recomeça do zero.
test('outbox: voltar a conexão devolve o crédito de tentativas', () => {
  const ls = fakeLS();
  const s = carregar(OUTBOX_FNS, { localStorage: ls, Date, JSON });
  for (let i = 0; i <= s._OUTBOX_TETO; i++) s._outboxAdd('agendamentos', 'blindada');
  assert.strictEqual(s._outboxPendente('agendamentos'), false);
  s._outboxResetTentativas();
  assert.strictEqual(s._outboxPendente('agendamentos'), true, 'volta a bloquear o pull');
  assert.ok('agendamentos' in s._outboxGet(), 'e continua na fila pra ser reentregue');
});

// ---------- Carimbo do profissional ----------
// O RLS só aceita linha COM o profissional_id de quem está gravando. Registro
// sem etiqueta era recusado — e, no upsert em lote, levava a coleção junto.
test('_rowBlindada: profissional logado carimba registro sem etiqueta', () => {
  const { _rowBlindada } = carregar('_rowBlindada',
    { Date, currentRole: 'profissional', currentProfissionalId: 'prof_9' });
  const row = _rowBlindada({ id: 'p1', nome: 'Ana' }, 'dono_1');
  assert.strictEqual(row.profissional_id, 'prof_9');
  assert.strictEqual(row.data.profissionalId, 'prof_9', 'coluna e jsonb não podem divergir');
  assert.strictEqual(row.owner_id, 'dono_1');
});

test('_rowBlindada: etiqueta existente vence o profissional logado', () => {
  const { _rowBlindada } = carregar('_rowBlindada',
    { Date, currentRole: 'profissional', currentProfissionalId: 'prof_9' });
  assert.strictEqual(_rowBlindada({ id: 'p1', profissionalId: 'prof_1' }, 'dono_1').profissional_id, 'prof_1');
});

test('_rowBlindada: dono/secretária não ganham etiqueta inventada', () => {
  for (const papel of ['medico', 'secretaria']) {
    const { _rowBlindada } = carregar('_rowBlindada',
      { Date, currentRole: papel, currentProfissionalId: 'prof_9' });
    assert.strictEqual(_rowBlindada({ id: 'p1' }, 'dono_1').profissional_id, null,
      `${papel} grava sem profissional_id — é legítimo`);
  }
});

// ---------- Push: lote não é tudo-ou-nada ----------
// Stub do supabase-js: recusa qualquer lote que contenha uma linha "ruim".
function supaPush(recusar, reg) {
  return {
    from: () => ({
      upsert: (rows) => {
        reg.upserts.push(rows.map(r => r.id));
        const ruim = rows.find(r => recusar.includes(r.id));
        return Promise.resolve(ruim ? { error: { message: 'new row violates RLS' } } : { error: null });
      },
      delete: () => ({ in: (col, ids) => { reg.deletes.push([col, ids]); return Promise.resolve({ error: null }); } }),
    }),
  };
}

// Arrays criados dentro do node:vm têm outro Array.prototype — deepStrictEqual
// reprova por realm mesmo com o conteúdo idêntico. Normaliza antes de comparar.
const puro = v => JSON.parse(JSON.stringify(v));

const PUSH_FNS = ['const:_LOTE_BLINDADA', '_rowBlindada', '_quarentenar', '_pushBlindada'];
function sandboxPush(ls, reg, recusar = []) {
  return carregar(PUSH_FNS, {
    localStorage: ls, Date, JSON, Set, console: mudo,
    _supa: supaPush(recusar, reg), currentUser: { id: 'u1' }, currentDataOwner: null,
    currentRole: 'medico', currentProfissionalId: null,
  });
}

// O achado: upsert em lote é tudo-ou-nada. UMA linha recusada pelo RLS reprovava
// a coleção inteira — as outras centenas de linhas válidas não entravam, e a
// chave ficava pendurada no outbox bloqueando o pull.
test('_pushBlindada: linha recusada não derruba as boas do mesmo lote', async () => {
  const reg = { upserts: [], deletes: [] };
  const s = sandboxPush(fakeLS(), reg, ['ruim']);
  const ok = await s._pushBlindada('clinica_atendimentos', [],
    [{ id: 'boa1' }, { id: 'ruim' }, { id: 'boa2' }]);
  assert.strictEqual(ok, false, 'sobrou linha não entregue — a chave continua na fila');
  assert.deepStrictEqual(puro(reg.upserts[0]), ['boa1', 'ruim', 'boa2'], 'tenta o lote primeiro');
  assert.deepStrictEqual(puro(reg.upserts.slice(1)), [['boa1'], ['ruim'], ['boa2']],
    'lote reprovado → reenvia linha a linha pra salvar as boas');
});

test('_pushBlindada: a linha recusada vai pra quarentena, não some', async () => {
  const ls = fakeLS();
  const s = sandboxPush(ls, { upserts: [], deletes: [] }, ['ruim']);
  await s._pushBlindada('clinica_atendimentos', [], [{ id: 'boa1' }, { id: 'ruim', nome: 'Ana' }]);
  const q = JSON.parse(ls._store['consult__quarentena']);
  assert.strictEqual(q.length, 1);
  assert.strictEqual(q[0].chave, 'clinica_atendimentos:ruim');
  assert.strictEqual(q[0].registro.nome, 'Ana', 'o registro inteiro fica recuperável');
  assert.match(q[0].motivo, /RLS/);
  // Retentar não duplica (o outbox tenta várias vezes antes de estourar o teto).
  await s._pushBlindada('clinica_atendimentos', [], [{ id: 'ruim', nome: 'Ana' }]);
  assert.strictEqual(JSON.parse(ls._store['consult__quarentena']).length, 1);
});

test('_pushBlindada: tudo aceito devolve true e não quarentena nada', async () => {
  const ls = fakeLS();
  const reg = { upserts: [], deletes: [] };
  const s = sandboxPush(ls, reg);
  const ok = await s._pushBlindada('clinica_crm', [{ id: 'velho' }], [{ id: 'novo' }]);
  assert.strictEqual(ok, true);
  assert.strictEqual(reg.upserts.length, 1, 'um lote só, sem fallback linha a linha');
  assert.deepStrictEqual(puro(reg.deletes), [['id', ['velho']]], 'removido no diff por id');
  assert.strictEqual(ls.getItem('consult__quarentena'), null);
});

test('_pushBlindada: coleção maior que o lote é fatiada, sem deixar ninguém de fora', async () => {
  const reg = { upserts: [], deletes: [] };
  const s = sandboxPush(fakeLS(), reg);
  const n = s._LOTE_BLINDADA * 2 + 7;
  const arr = Array.from({ length: n }, (_, i) => ({ id: 'r' + i }));
  assert.strictEqual(await s._pushBlindada('clinica_atendimentos', [], arr), true);
  assert.strictEqual(reg.upserts.length, 3);
  assert.strictEqual(reg.upserts.reduce((t, l) => t + l.length, 0), n);
});

// ---------- Pull: paginação ----------
// Stub que respeita um teto de linhas por resposta, como o max-rows do PostgREST.
function supaPull(total, teto) {
  return {
    from: () => ({ select: () => ({ eq: () => ({ order: () => ({
      range: (de, ate) => {
        const fim = Math.min(ate + 1, de + teto, total);
        const data = [];
        for (let i = de; i < fim; i++) data.push({ data: { id: 'r' + i } });
        return Promise.resolve({ data, error: null });
      },
    }) }) }) }),
  };
}

// O achado: o select não tinha .range() nem .order(). Acima do max-rows o
// PostgREST devolvia um recorte SEM avisar, e o pull gravava esse recorte por
// cima do localStorage — o resto da coleção sumia da tela do usuário.
test('_lerTodasBlindada: pagina até o fim em vez de aceitar o corte do servidor', async () => {
  const s = carregar('_lerTodasBlindada', { _supa: supaPull(2350, 1000), console: mudo });
  const { data, error } = await s._lerTodasBlindada('clinica_atendimentos', 'u1');
  assert.ok(!error);
  assert.strictEqual(data.length, 2350);
  assert.strictEqual(data[0].data.id, 'r0');
  assert.strictEqual(data[2349].data.id, 'r2349');
});

// O teto do servidor pode ser menor que a página que pedimos — o avanço usa o
// que voltou de fato, não o tamanho pedido, senão pularíamos linhas.
test('_lerTodasBlindada: funciona com max-rows menor que a página pedida', async () => {
  const s = carregar('_lerTodasBlindada', { _supa: supaPull(1200, 300), console: mudo, Set });
  const { data } = await s._lerTodasBlindada('clinica_agendamentos', 'u1');
  assert.strictEqual(data.length, 1200);
  assert.strictEqual(new Set(data.map(r => r.data.id)).size, 1200, 'sem repetição nem buraco');
});

test('_lerTodasBlindada: coleção vazia e erro de banco não viram lista falsa', async () => {
  const vazio = carregar('_lerTodasBlindada', { _supa: supaPull(0, 1000), console: mudo });
  const r0 = await vazio._lerTodasBlindada('t', 'u1');
  assert.ok(!r0.error);
  assert.strictEqual(r0.data.length, 0);

  const quebrado = carregar('_lerTodasBlindada', {
    console: mudo,
    _supa: { from: () => ({ select: () => ({ eq: () => ({ order: () => ({
      range: () => Promise.resolve({ data: null, error: { message: 'permission denied' } }),
    }) }) }) }) },
  });
  const r = await quebrado._lerTodasBlindada('t', 'u1');
  assert.ok(r.error, 'erro tem de subir — devolver [] apagaria a coleção local');
  assert.strictEqual(r.data, undefined);
});
