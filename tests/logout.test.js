// Logout — rode com: node --test
//
// O logout apagava o localStorage e trocava de tela, mas a PÁGINA continuava a
// mesma. Todo estado de módulo do usuário anterior seguia vivo: o histórico da
// MaestrIA (que é lido do localStorage uma vez, na carga do script, e carrega
// nome de paciente, valores e "quem deve"), a conversa de WhatsApp aberta, os
// canais de realtime assinados no owner antigo, os buffers de importação.
// Numa recepção — onde o app fica aberto a semana toda e trocar de conta é
// rotina — o próximo a entrar via o que o anterior tinha, e a primeira
// pergunta dele mandava aquele histórico pro LLM.

const { test } = require('node:test');
const assert = require('node:assert');
const { carregar, fonte } = require('./_extrair.js');

function ambiente({ outboxPendente = {}, confirmar = true } = {}) {
  const store = { consult_pacientes: '[]', consult_chat_history: '[]', outra_coisa: 'fica' };
  const eventos = [];
  const s = carregar(['logoutUser'], {
    console: { warn() {}, log() {} },
    confirm: () => { eventos.push('confirm'); return confirmar; },
    location: { reload: () => eventos.push('reload') },
    // As chaves precisam ser propriedades ENUMERÁVEIS: o logout varre com
    // Object.keys(localStorage), como o navegador expõe de verdade.
    localStorage: (() => {
      const ls = store;
      for (const [nome, fn] of Object.entries({
        getItem: (k) => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); },
        removeItem: (k) => { delete store[k]; },
      })) Object.defineProperty(ls, nome, { value: fn, enumerable: false });
      return ls;
    })(),
    _drenarOutbox: async () => { eventos.push('drenar'); },
    _outboxGet: () => outboxPendente,
    _auditLog: () => { eventos.push('audit'); },
    _signOutIntencional: async () => { eventos.push('signout'); },
    chatHistory: [{ role: 'user', text: 'quanto a Maria Silva me deve?' }],
    currentUser: { id: 'u1' }, currentRole: 'medico', currentNome: 'Dr. A',
    currentDataOwner: 'u1', currentTeamRole: 'owner', currentProfissionalId: null,
    _agFiltroProf: 'prof_1',
  });
  return { sandbox: s, store, eventos, logoutUser: s.logoutUser };
}

test('o logout recarrega a página', async () => {
  const a = ambiente();
  await a.logoutUser();
  assert.ok(a.eventos.includes('reload'),
    'sem reload, todo estado de módulo do usuário anterior sobrevive pro próximo login');
});

test('o histórico da MaestrIA some da MEMÓRIA, não só do localStorage', async () => {
  // `chatHistory` é inicializado na carga do script. Apagar a chave não
  // esvazia a variável: o próximo usuário abria o chat e via a conversa do
  // anterior — e a primeira pergunta dele reenviava tudo aquilo pro LLM.
  const a = ambiente();
  await a.logoutUser();
  // (comparação por tamanho: array criado dentro do node:vm tem outro protótipo)
  assert.equal(a.sandbox.chatHistory.length, 0);
  assert.equal(a.store.consult_chat_history, undefined);
});

test('drena o outbox ANTES de apagar o localStorage', async () => {
  const a = ambiente();
  await a.logoutUser();
  assert.ok(a.eventos.indexOf('drenar') < a.eventos.indexOf('signout'),
    'escrita que ainda não subiu morre no wipe — a última chance é antes');
  assert.equal(a.store.consult_pacientes, undefined);
  assert.equal(a.store.outra_coisa, 'fica', 'só as chaves consult_* são apagadas');
});

test('se o usuário desiste da confirmação, nada é apagado nem recarregado', async () => {
  const a = ambiente({ outboxPendente: { pacientes: 1 }, confirmar: false });
  await a.logoutUser();
  assert.equal(a.store.consult_pacientes, '[]');
  assert.deepStrictEqual(a.eventos.filter(e => e === 'reload'), []);
  assert.equal(a.sandbox.chatHistory.length, 1, 'a sessão continua — o histórico é dele');
});

test('o wipe do localStorage é seguido de reload no fonte', () => {
  const corpo = fonte.slice(fonte.indexOf('async function logoutUser'));
  const fim = corpo.indexOf('\n}\n');
  const trecho = corpo.slice(0, fim);
  const wipe = trecho.indexOf("startsWith('consult_')");
  assert.ok(wipe > -1);
  assert.ok(trecho.indexOf('location.reload()') > wipe,
    'trocar de tela sem recarregar deixa o app rodando com o estado do usuário anterior');
});
