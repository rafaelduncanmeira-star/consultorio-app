// Saúde da sincronização — rode com: node --test
//
// Toda a blindagem do sync guarda o que o servidor recusa (outbox +
// quarentena) justamente pra nada sumir. Só que isso ia apenas pro
// console.warn: da tela, o médico não tinha como saber que um atendimento
// existe apenas no aparelho dele. Ele registra a consulta, vê na lista, e no
// celular ela não está — sem aviso em lugar nenhum. Pior quando o outbox
// estoura o teto: o pull volta a rodar e o registro some daqui também,
// sobrando só a cópia da quarentena, que ninguém olha.

const { test } = require('node:test');
const assert = require('node:assert');
const { carregar, fonte } = require('./_extrair.js');

function ambiente({ outbox = {}, quarentena = [] } = {}) {
  const mem = new Map();
  mem.set('consult__outbox', JSON.stringify(outbox));
  mem.set('consult__quarentena', JSON.stringify(quarentena));
  let html = '';
  const el = { set innerHTML(v) { html = v; }, get innerHTML() { return html; } };
  // Dois contêineres: o da tela de Backup e o de Configurações. O cartão tem de
  // preencher os dois — a tela de Backup é bloqueada pro profissional.
  const alvos = [el, { set innerHTML(v) { html = v; } }];
  const s = carregar(['const:_OUTBOX_TETO', 'const:_ROTULO_COLECAO', 'const:_BLINDADAS', '_outboxGet',
                      '_rotuloColecao', '_esc', '_pendenciasSync', 'renderSyncSaude'], {
    JSON, Object, Array, String, RegExp,
    localStorage: { getItem: (k) => (mem.has(k) ? mem.get(k) : null),
                    setItem: (k, v) => mem.set(k, v) },
    document: {
      getElementById: (id) => (id === 'backup-sync-saude' ? el : null),
      querySelectorAll: () => alvos,
    },
    console: { warn() {} },
  });
  return { ...s, get html() { return html; } };
}

test('sem pendências: diz que está tudo sincronizado', () => {
  const a = ambiente();
  a.renderSyncSaude();
  assert.match(a.html, /Tudo sincronizado/);
  assert.ok(!a.html.includes('não chegaram ao servidor'));
});

test('coleção na fila aparece com nome humano e contagem', () => {
  const a = ambiente({ outbox: { pacientes: { tipo: 'blindada', tentativas: 2 } } });
  a.renderSyncSaude();
  assert.match(a.html, /não chegaram ao servidor/);
  assert.match(a.html, /Atendidos/, 'a pessoa não sabe o que é "pacientes" — mostra o rótulo da tela');
  assert.match(a.html, /2 tentativa/);
  assert.ok(!a.html.includes('desistiu'), 'ainda não estourou o teto');
});

test('fila que estourou o teto avisa que o pull pode sobrescrever', () => {
  const { _OUTBOX_TETO } = ambiente();
  const a = ambiente({ outbox: { crm: { tipo: 'blindada', tentativas: _OUTBOX_TETO } } });
  a.renderSyncSaude();
  assert.match(a.html, /desistiu depois de/);
  assert.match(a.html, /pode sobrescrever/,
    'é o caso em que o registro some do aparelho também — tem de ser explícito');
});

test('quarentena mostra de quem é o registro e o motivo da recusa', () => {
  const a = ambiente({ quarentena: [
    { chave: 'clinica_atendimentos:pac_1', tabela: 'clinica_atendimentos',
      motivo: 'new row violates row-level security policy',
      registro: { nome: 'Ana Souza', valor: 1000 } },
  ] });
  a.renderSyncSaude();
  assert.match(a.html, /Ana Souza/);
  assert.match(a.html, /Atendidos/, 'o nome da TABELA não diz nada — traduz pro nome da tela');
  assert.match(a.html, /row-level security/);
});

test('o de-para de rótulo sai do _BLINDADAS, não de uma segunda lista', () => {
  const a = ambiente();
  // A tabela de `pacientes` se chama `clinica_atendimentos` — nenhum strip de
  // prefixo resolve isso; tem de vir do _BLINDADAS.
  assert.strictEqual(a._rotuloColecao('clinica_atendimentos'), 'Atendidos');
  assert.strictEqual(a._rotuloColecao('pacientes'), 'Atendidos');
  assert.strictEqual(a._rotuloColecao('clinica_crm'), 'CRM');
  assert.strictEqual(a._rotuloColecao('tabela_desconhecida'), 'tabela_desconhecida',
    'o que não souber traduzir, mostra como está — melhor que sumir');
});

test('quarentena escapa o que veio do servidor e do registro', () => {
  const a = ambiente({ quarentena: [
    { chave: 'x', tabela: 'clinica_crm', motivo: '<img src=x onerror=alert(1)>',
      registro: { nome: '<script>alert(2)</script>' } },
  ] });
  a.renderSyncSaude();
  assert.ok(!a.html.includes('<img src=x'), 'motivo vem do servidor — passa por _esc');
  assert.ok(!a.html.includes('<script>alert(2)'), 'nome vem do WhatsApp — passa por _esc');
  assert.match(a.html, /&lt;script&gt;/);
});

test('registro sem nome não vira "undefined" na tela', () => {
  const a = ambiente({ quarentena: [
    { chave: 'x', tabela: 'clinica_followup', motivo: 'erro', registro: {} },
  ] });
  a.renderSyncSaude();
  assert.match(a.html, /\(sem nome\)/);
  assert.ok(!a.html.includes('undefined'));
});

test('renderBackup mostra o cartão sempre que a tela abre', () => {
  const { recortarFuncao } = require('./_extrair.js');
  const src = recortarFuncao('renderBackup').replace(/\/\/[^\n]*/g, '');
  assert.match(src, /renderSyncSaude\(\)/,
    'de nada adianta o cartão existir se ninguém o desenha');
});

test('o cartão aparece também fora da tela de Backup', () => {
  const fs = require('node:fs'), path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const marcados = [...html.matchAll(/data-sync-saude/g)].length;
  assert.ok(marcados >= 2,
    'a tela de Backup está em _PAGES_FINANCEIRO: o profissional e o médico membro '
    + 'não a alcançam, e são justamente quem mais tem registro recusado pelo RLS');
  assert.match(html, /id="backup-sync-saude" data-sync-saude/);
  assert.match(html, /id="config-sync-saude" data-sync-saude/);
});

test('Configurações desenha o cartão ao abrir', () => {
  const { recortarFuncao } = require('./_extrair.js');
  const src = recortarFuncao('renderConfiguracoes').replace(/\/\/[^\n]*/g, '');
  assert.match(src, /renderSyncSaude\(\)/);
});

test('a página de Backup continua bloqueada pro profissional (a premissa)', () => {
  const { carregar } = require('./_extrair.js');
  const { _PAGES_FINANCEIRO } = carregar('const:_PAGES_FINANCEIRO', {});
  assert.ok(_PAGES_FINANCEIRO.includes('backup'),
    'se isto mudar, o segundo contêiner deixa de ser necessário — reveja');
});

test('tentar enviar agora zera as tentativas antes de drenar', () => {
  const { recortarFuncao } = require('./_extrair.js');
  const src = recortarFuncao('_tentarSincronizarAgora').replace(/\/\/[^\n]*/g, '');
  const iReset = src.indexOf('_outboxResetTentativas()');
  const iDrena = src.indexOf('_drenarOutbox()');
  assert.ok(iReset > 0 && iDrena > iReset,
    'o teto existe pra não martelar o servidor a cada pull, não pra ignorar um pedido explícito');
});

// ---------- o botão da própria tela de diagnóstico não pode morrer calado ----------
// _tentarSincronizarAgora é async e é chamada por um onclick, que não tem catch.
// O _drenarOutbox tem `finally` mas NÃO tem `catch`: uma exceção lá dentro
// (JSON corrompido no localStorage) sobe até aqui e a promise é rejeitada em
// silêncio — o toast "Enviando…" fica sendo a última coisa na tela e o botão
// parece morto. Justamente na tela que existe pra dizer o que está errado.
function ambienteBotao({ drenarLanca = false, filaDepois = {} } = {}) {
  const toasts = [];
  let redesenhou = 0;
  const s = carregar('_tentarSincronizarAgora', {
    Object,
    _supa: {}, currentUser: { id: 'u1' },
    _outboxResetTentativas: () => {},
    _drenarOutbox: async () => { if (drenarLanca) throw new Error('localStorage corrompido'); },
    _pendenciasSync: () => ({ fila: Object.keys(filaDepois).map(k => ({ key: k })) }),
    renderSyncSaude: () => { redesenhou++; },
    toast: (t) => toasts.push(t),
  });
  return { ...s, toasts, redesenhou: () => redesenhou };
}

test('botão: exceção no envio vira mensagem, não promise perdida', async () => {
  const a = ambienteBotao({ drenarLanca: true });
  await assert.doesNotReject(() => a._tentarSincronizarAgora());
  assert.match(a.toasts.join(' '), /Não consegui enviar agora/);
  assert.match(a.toasts.join(' '), /localStorage corrompido/, 'o motivo real ajuda a agir');
});

test('botão: mesmo falhando, a tela é redesenhada com o estado atual', async () => {
  const a = ambienteBotao({ drenarLanca: true, filaDepois: { pacientes: 1 } });
  await a._tentarSincronizarAgora();
  assert.strictEqual(a.redesenhou(), 1,
    'a pessoa precisa ver o que continua pendente depois da tentativa');
  assert.match(a.toasts.join(' '), /Ainda faltam 1/);
});

test('botão: caminho feliz avisa que terminou', async () => {
  const a = ambienteBotao({ filaDepois: {} });
  await a._tentarSincronizarAgora();
  assert.match(a.toasts.join(' '), /Tudo enviado/);
});

test('visibilitychange: falha na revisão do canal não derruba as tarefas do dia', () => {
  const { fonte } = require('./_extrair.js');
  const semCom = fonte.replace(/\/\/[^\n]*/g, '');
  assert.match(semCom, /try \{ _revisarCanalLeads\(\); \} catch/,
    'duas coisas independentes no mesmo handler não podem derrubar uma à outra');
});
