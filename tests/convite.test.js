// Convite de equipe — rode com: node --test
//
// O _checkInviteFromUrl limpa a URL assim que lê o convite, então o
// localStorage é o ÚNICO lugar onde o token existe. Apagá-lo antes de saber o
// resultado queimava um convite válido numa falha de rede: a pessoa convidada
// tinha de pedir outro link ao dono, sem entender por quê. Mesmo erro do
// `processado: true` dos leads, que já custou contato.

const { test } = require('node:test');
const assert = require('node:assert');
const { carregar, recortarFuncao, fonte } = require('./_extrair.js');

function ambiente(resposta) {
  const mem = new Map([['consult_pending_invite', 'tok_123']]);
  const toasts = [];
  const s = carregar('_acceptInviteIfPending', {
    console: { warn() {} },
    setTimeout: (fn) => { fn(); return 1; },
    localStorage: {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      removeItem: (k) => mem.delete(k),
      setItem: (k, v) => mem.set(k, v),
    },
    _supa: { rpc: async () => resposta },
    currentUser: { id: 'u1' }, currentRole: 'secretaria', currentProfissionalId: null,
    toast: (t) => toasts.push(t),
  });
  return { aceitar: s._acceptInviteIfPending, toasts,
           token: () => (mem.has('consult_pending_invite') ? mem.get('consult_pending_invite') : null) };
}

test('falha de rede PRESERVA o convite pra tentar de novo', async () => {
  const a = ambiente({ error: { message: 'Failed to fetch' } });
  await a.aceitar();
  assert.strictEqual(a.token(), 'tok_123',
    'a URL já foi limpa: apagar aqui queima um convite que continua válido');
  assert.match(a.toasts.join(' '), /tentar de novo/,
    'e a mensagem não pode mandar pedir outro link');
});

test('veredito do servidor descarta o convite', async () => {
  for (const motivo of ['convite expirado', 'e-mail não confere', 'convite já usado']) {
    const a = ambiente({ data: { error: motivo } });
    await a.aceitar();
    assert.strictEqual(a.token(), null,
      'insistir não muda nada, e guardar faria a mensagem reaparecer a cada login');
    assert.match(a.toasts.join(' '), new RegExp(motivo));
  }
});

test('aceite bem-sucedido descarta o convite', async () => {
  const a = ambiente({ data: { ok: true, role: 'profissional', profissional_id: 'prof_1' } });
  await a.aceitar();
  assert.strictEqual(a.token(), null);
  assert.match(a.toasts.join(' '), /entrou em uma equipe/);
});

test('sem convite pendente, não faz nada', async () => {
  const s = carregar('_acceptInviteIfPending', {
    localStorage: { getItem: () => null, removeItem: () => { throw new Error('não devia mexer'); } },
    _supa: { rpc: async () => { throw new Error('não devia chamar'); } },
    currentUser: { id: 'u1' }, console: { warn() {} },
  });
  await assert.doesNotReject(() => s._acceptInviteIfPending());
});

test('o token só existe no localStorage — a URL é limpa na leitura', () => {
  const src = recortarFuncao('_checkInviteFromUrl').replace(/\/\/[^\n]*/g, '');
  assert.match(src, /history\.replaceState/,
    'é isto que torna o descarte prematuro irreversível — a premissa do teste acima');
  assert.match(src, /setItem\('consult_pending_invite'/);
});
