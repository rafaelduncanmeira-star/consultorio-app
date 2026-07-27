// Dono do aparelho — rode com: node --test
//
// O logout limpa o localStorage e recarrega. A sessão que CAI sozinha (senha
// trocada em outro aparelho, token revogado) não limpa nada, e de propósito: é
// ali que mora o outbox. O que sobra é a tela de login com os dados do anterior
// no aparelho — e numa recepção quem senta depois costuma ser outra pessoa.
//
// Entrando por cima:
//  · o _drenarOutbox do primeiro cloudPull manda os registros do anterior pro
//    servidor com o owner de QUEM ENTROU (cloudPush usa o owner atual):
//    prontuário de uma clínica gravado dentro da conta de outra;
//  · o pull não baixa as chaves que estão na fila, então a pessoa nova fica
//    olhando (e editando por cima) o consultório alheio.

const { test } = require('node:test');
const assert = require('node:assert');
const { carregar, fonte } = require('./_extrair.js');

function ambiente({ owner = 'clinicaB', dono = null, outbox = {}, confirmar = true } = {}) {
  const store = { consult_pacientes: '[{"nome":"Maria"}]', consult__outbox: '{}' };
  if (dono) store.consult__dono = dono;
  const eventos = [];
  const s = carregar(['const:_CHAVE_DONO', '_conferirDonoDoAparelho'], {
    currentUser: { id: owner },
    currentDataOwner: owner,
    confirm: (txt) => { eventos.push(txt); return confirmar; },
    _outboxGet: () => outbox,
    _signOutIntencional: async () => { eventos.push('signout'); },
    localStorage: (() => {
      const ls = store;
      for (const [nome, fn] of Object.entries({
        getItem: (k) => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); },
        removeItem: (k) => { delete store[k]; },
      })) Object.defineProperty(ls, nome, { value: fn, enumerable: false });
      return ls;
    })(),
  });
  return { ...s, store, eventos };
}

test('aparelho sem marca de dono é adotado sem perguntar nada', async () => {
  // É o estado de quem já usava o app antes desta versão — não pode virar susto.
  const a = ambiente({ owner: 'clinicaA' });
  assert.equal(await a._conferirDonoDoAparelho(), true);
  assert.equal(a.store.consult__dono, 'clinicaA');
  assert.deepStrictEqual(a.eventos, [], 'nada a confirmar: os dados já eram dele');
  assert.equal(a.store.consult_pacientes, '[{"nome":"Maria"}]');
});

test('mesmo dono entra direto e nada é apagado', async () => {
  const a = ambiente({ owner: 'clinicaA', dono: 'clinicaA' });
  assert.equal(await a._conferirDonoDoAparelho(), true);
  assert.equal(a.store.consult_pacientes, '[{"nome":"Maria"}]');
  assert.deepStrictEqual(a.eventos, []);
});

test('membro da mesma clínica não é tratado como outra conta', async () => {
  // A marca é o OWNER dos dados, não o usuário: duas secretárias da mesma
  // clínica compartilham o mesmo localStorage por definição.
  const a = ambiente({ owner: 'clinicaA', dono: 'clinicaA' });
  assert.equal(await a._conferirDonoDoAparelho(), true);
  assert.deepStrictEqual(a.eventos, []);
});

test('outra conta: avisa, lista o que não subiu e só entra com confirmação', async () => {
  const a = ambiente({ owner: 'clinicaB', dono: 'clinicaA', outbox: { pacientes: {}, crm: {} } });
  assert.equal(await a._conferirDonoDoAparelho(), true);
  assert.match(a.eventos[0], /OUTRA conta/);
  assert.match(a.eventos[0], /pacientes, crm/, 'o que não subiu tem de aparecer por nome');
  assert.equal(a.store.consult_pacientes, undefined, 'os dados da outra conta saem do aparelho');
  assert.equal(a.store.consult__dono, 'clinicaB', 'a marca é regravada DEPOIS do wipe');
});

test('recusando a confirmação, ninguém entra e nada é tocado', async () => {
  const a = ambiente({ owner: 'clinicaB', dono: 'clinicaA', outbox: { pacientes: {} }, confirmar: false });
  assert.equal(await a._conferirDonoDoAparelho(), false,
    'entrar assim subiria os registros da clínica A pra dentro da conta B');
  assert.equal(a.store.consult_pacientes, '[{"nome":"Maria"}]', 'o dado do outro continua intacto');
  assert.equal(a.store.consult__dono, 'clinicaA');
  assert.ok(a.eventos.includes('signout'), 'a sessão recusada não pode ficar de pé');
});

test('sem owner resolvido, não entra', async () => {
  const s = carregar(['const:_CHAVE_DONO', '_conferirDonoDoAparelho'], {
    currentUser: null, currentDataOwner: null,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  });
  assert.equal(await s._conferirDonoDoAparelho(), false);
});

test('nenhum cloudPull acontece antes do portão', () => {
  // O cloudPull é o ponto sem volta: ele DRENA o outbox (subindo os registros
  // do dono anterior pra conta de quem entrou) e aplica o pull por cima do
  // localStorage. Depois dele a mistura já existe no servidor.
  const linhas = fonte.split('\n');
  const ruins = [];
  linhas.forEach((l, i) => {
    if (!/await cloudPull\(\)/.test(l)) return;
    // Sobe até o começo da função (ou do handler) que contém esta chamada.
    let ini = 0;
    for (let j = i; j >= 0; j--) {
      if (/^(async )?function |^document\.addEventListener\(/.test(linhas[j])) { ini = j; break; }
    }
    const antes = linhas.slice(ini, i).join('\n');
    // No doSignup o portão fica dentro do signUpUser, que é aguardado antes.
    if (!antes.includes('_conferirDonoDoAparelho') && !antes.includes('signUpUser(')) {
      ruins.push((i + 1) + ': ' + l.trim());
    }
  });
  assert.deepStrictEqual(ruins, [],
    'cloudPull sem portão antes volta a misturar as duas contas no servidor');
});

test('o portão é chamado nos três caminhos de entrada', () => {
  const n = (fonte.match(/_conferirDonoDoAparelho\(\)/g) || []).length;
  // 1 definição + 3 chamadas (signInUser, signUpUser, restauração de sessão).
  assert.ok(n >= 4, `esperava a definição e 3 chamadas, achei ${n} ocorrências`);
});
