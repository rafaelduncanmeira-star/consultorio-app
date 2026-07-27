// Tarefas do dia — rode com: node --test
//
// O backup automático e o ciclo de lembretes eram disparados apenas dentro do
// _iniciarApp — uma vez por CARREGAMENTO da página. Numa recepção o app fica
// aberto a semana inteira; é um PWA, é pra isso. Segunda de manhã os dois
// rodam. De terça em diante nenhum roda: ninguém é lembrado da consulta e
// nenhum backup é gravado, sem nada avisar — do ponto de vista do app está
// tudo normal.

const { test } = require('node:test');
const assert = require('node:assert');
const { carregar, recortarFuncao, fonte } = require('./_extrair.js');

function ambiente({ logado = true } = {}) {
  const chamadas = [];
  const timers = [];
  const s = carregar(['_tarefaBackupDiario', '_tarefaLembretes', '_rodarTarefasDoDia',
                      '_agendarTarefasDoDia'], {
    console: { warn() {}, log() {} },
    setInterval: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    _timerTarefasDoDia: null,
    currentUser: logado ? { id: 'u1' } : null,
    _checarAtualizacaoSW: () => { chamadas.push('versao'); },
    criarSnapshotDiario: () => { chamadas.push('backup'); return Promise.resolve({ skipped: true }); },
    rodarCicloLembretes: () => { chamadas.push('lembretes'); return Promise.resolve({ enviados: 0, erros: 0 }); },
    toast: () => {},
  });
  return { ...s, chamadas, timers };
}

test('a rodada do dia dispara as duas tarefas', () => {
  const a = ambiente();
  a._rodarTarefasDoDia();
  assert.deepStrictEqual(a.chamadas, ['versao', 'backup', 'lembretes']);
});

test('sem sessão, nada roda', () => {
  const a = ambiente({ logado: false });
  a._rodarTarefasDoDia();
  assert.deepStrictEqual(a.chamadas, ['versao'],
    'sem usuário não há nuvem pra gravar nem WhatsApp pra enviar — mas procurar '
    + 'versão nova não depende de sessão');
});

test('o agendador existe e não depende de recarregar a página', () => {
  const a = ambiente();
  a._agendarTarefasDoDia();
  assert.strictEqual(a.timers.length, 1, 'sem timer, as tarefas só rodam no carregamento');
  assert.ok(a.timers[0].ms >= 60000 && a.timers[0].ms <= 3600000,
    'intervalo tem de ser da ordem de minutos: a janela de lembrete é de horas');
});

test('agendar duas vezes não empilha timers', () => {
  const a = ambiente();
  a._agendarTarefasDoDia();
  a._agendarTarefasDoDia();
  assert.strictEqual(a.timers.length, 1,
    '_iniciarApp roda de novo quando a pessoa sai e entra');
});

test('as duas tarefas continuam se protegendo contra repetir no mesmo dia', () => {
  // É esta propriedade que torna seguro re-checar de 15 em 15 minutos.
  const ciclo = recortarFuncao('rodarCicloLembretes').replace(/\/\/[^\n]*/g, '');
  assert.match(ciclo, /cfg\.ultimoEnvio === hoje/,
    'sem esta guarda o agendador mandaria o mesmo lembrete a cada volta');
  const snap = recortarFuncao('criarSnapshotDiario').replace(/\/\/[^\n]*/g, '');
  assert.match(snap, /já existe snapshot de hoje/,
    'sem esta guarda o agendador regravaria o snapshot a cada volta');
});

test('_iniciarApp usa as MESMAS funções que o agendador', () => {
  const src = recortarFuncao('_iniciarApp').replace(/\/\/[^\n]*/g, '');
  assert.match(src, /_tarefaBackupDiario/);
  assert.match(src, /_tarefaLembretes/);
  assert.match(src, /_agendarTarefasDoDia\(\)/);
  assert.doesNotMatch(src, /criarSnapshotDiario\(\)/,
    'duplicar a chamada aqui faria as duas versões divergirem com o tempo');
});

test('voltar com a aba pra frente também re-checa', () => {
  const semCom = fonte.replace(/\/\/[^\n]*/g, '');
  assert.match(semCom, /visibilitychange[\s\S]{0,320}_rodarTarefasDoDia\(\)/,
    'máquina suspensa não dispara setInterval: o computador da recepção dorme na '
    + 'sexta e acorda na segunda com o timer parado no tempo');
});

// ---------- aviso repetido vira ruído ----------
// O agendador chama as tarefas a cada 15 minutos. Um erro PERMANENTE — o
// localStorage cheio, o provedor de WhatsApp fora do ar — repetiria o mesmo
// toast a cada volta, o dia inteiro. Aviso assim a pessoa aprende a fechar sem
// ler, e estes dois são justamente os que não podem virar ruído.
function ambienteAviso(resultados) {
  const toasts = [];
  let i = 0;
  const s = carregar(['_tarefaBackupDiario', '_tarefaLembretes'], {
    console: { warn() {}, log() {} },
    _ultimoAvisoBackup: '', _ultimoAvisoLembrete: '',
    criarSnapshotDiario: () => Promise.resolve(resultados[Math.min(i++, resultados.length - 1)]),
    rodarCicloLembretes: () => Promise.resolve(resultados[Math.min(i++, resultados.length - 1)]),
    toast: (t) => toasts.push(t),
  });
  return { ...s, toasts };
}

test('backup: o mesmo erro não é repetido a cada volta do agendador', async () => {
  const a = ambienteAviso([{ error: 'Sem espaço no navegador' }]);
  await a._tarefaBackupDiario();
  await a._tarefaBackupDiario();
  await a._tarefaBackupDiario();
  assert.strictEqual(a.toasts.length, 1,
    'de 15 em 15 minutos o dia inteiro, o aviso vira ruído e para de ser lido');
});

test('backup: motivo diferente volta a avisar', async () => {
  const a = ambienteAviso([{ error: 'Sem espaço no navegador' }, { error: 'Outra coisa' }]);
  await a._tarefaBackupDiario();
  await a._tarefaBackupDiario();
  assert.strictEqual(a.toasts.length, 2);
});

test('backup: depois de dar certo, o aviso volta a valer', async () => {
  const a = ambienteAviso([{ error: 'Sem espaço' }, { created: true, data: 'x' }, { error: 'Sem espaço' }]);
  await a._tarefaBackupDiario();   // avisa
  await a._tarefaBackupDiario();   // sucesso, zera
  await a._tarefaBackupDiario();   // volta a avisar
  assert.strictEqual(a.toasts.length, 2,
    'se voltou a falhar depois de funcionar, é informação nova');
});

test('lembretes: mesma regra para a falha de envio', async () => {
  const a = ambienteAviso([{ enviados: 0, erros: 2 }]);
  await a._tarefaLembretes();
  await a._tarefaLembretes();
  assert.strictEqual(a.toasts.length, 1);
  assert.match(a.toasts[0], /NÃO foram enviados/);
});

test('lembretes: sucesso sempre aparece (não é aviso repetido, é evento)', async () => {
  const a = ambienteAviso([{ enviados: 3, erros: 0 }]);
  await a._tarefaLembretes();
  await a._tarefaLembretes();
  assert.strictEqual(a.toasts.length, 2, 'cada envio bem-sucedido é um fato novo');
});
