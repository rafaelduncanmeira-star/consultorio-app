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
    criarSnapshotDiario: () => { chamadas.push('backup'); return Promise.resolve({ skipped: true }); },
    rodarCicloLembretes: () => { chamadas.push('lembretes'); return Promise.resolve({ enviados: 0, erros: 0 }); },
    toast: () => {},
  });
  return { ...s, chamadas, timers };
}

test('a rodada do dia dispara as duas tarefas', () => {
  const a = ambiente();
  a._rodarTarefasDoDia();
  assert.deepStrictEqual(a.chamadas, ['backup', 'lembretes']);
});

test('sem sessão, nada roda', () => {
  const a = ambiente({ logado: false });
  a._rodarTarefasDoDia();
  assert.deepStrictEqual(a.chamadas, [],
    'sem usuário não há nuvem pra gravar nem WhatsApp pra enviar');
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
