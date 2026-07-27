// localStorage cheio — rode com: node --test
//
// O _gravarSnapshot já abria espaço quando o navegador recusava por cota. A
// gravação que MAIS importa — a dos dados vivos, via DB.set — não abria: o
// setItem lançava no meio do save, e como quem chama é um onsubmit sem catch,
// o modal ficava aberto, nada era gravado, nada entrava na fila de envio e
// nenhuma mensagem aparecia. O atendimento que o médico acabou de digitar
// sumia, e digitar de novo dava no mesmo.
//
// Um consultório movimentado chega lá sem esforço: sete snapshots da clínica
// inteira + os dados vivos + o histórico do chat, tudo na mesma origem.

const { test } = require('node:test');
const assert = require('node:assert');
const { carregar, recortarFuncao, fonte } = require('./_extrair.js');

// localStorage com cota: aceita gravar enquanto couber, e o que "ocupa espaço"
// são os snapshots — apagá-los libera.
function storageComCota({ limite = 2 } = {}) {
  const dados = {};
  const ls = dados;
  const cabe = () => Object.keys(dados).filter(k => k.startsWith('consult__snapshot_')).length < limite;
  for (const [nome, fn] of Object.entries({
    getItem: (k) => (k in dados ? dados[k] : null),
    setItem: (k, v) => {
      if (!cabe() && !(k in dados)) { const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; }
      dados[k] = String(v);
    },
    removeItem: (k) => { delete dados[k]; },
  })) Object.defineProperty(ls, nome, { value: fn, enumerable: false });
  return ls;
}

function ambiente(opts) {
  const ls = storageComCota(opts);
  const avisos = [];
  const s = carregar(['const:SNAPSHOT_PREFIX', '_snapshotsLocais', '_gravarLocal', '_avisarSemEspaco'], {
    localStorage: ls, Object, Set, String, JSON,
    console: { warn() {} },
    toast: (m) => avisos.push(m),
    alert: (m) => avisos.push(m),
    _avisadoSemEspaco: new Set(),
  });
  return { ...s, ls, avisos };
}

test('gravação que não cabe descarta o backup local mais VELHO e passa', () => {
  const a = ambiente({ limite: 2 });
  a.ls.setItem('consult__snapshot_2026-08-01', 'velho');
  a.ls.setItem('consult__snapshot_2026-08-03', 'novo');
  assert.strictEqual(a._gravarLocal('consult_pacientes', '[{"nome":"Ana"}]'), true);
  assert.strictEqual(a.ls.getItem('consult_pacientes'), '[{"nome":"Ana"}]');
  assert.strictEqual(a.ls.getItem('consult__snapshot_2026-08-01'), null,
    'o de 01/08 é o mais velho — é ele que sai');
  assert.strictEqual(a.ls.getItem('consult__snapshot_2026-08-03'), 'novo',
    'o backup mais recente continua lá');
});

test('sem backup nenhum pra descartar, a gravação falha — mas devolve false', () => {
  const a = ambiente({ limite: 0 });
  assert.strictEqual(a._gravarLocal('consult__snapshot_x', 'x'), false,
    'devolver false é o que permite avisar; lançar aqui abortava o save inteiro');
});

test('o aviso de falta de espaço sai UMA vez por chave', () => {
  const a = ambiente();
  a._avisarSemEspaco('pacientes');
  a._avisarSemEspaco('pacientes');
  a._avisarSemEspaco('crm');
  assert.strictEqual(a.avisos.length, 2, 'repetir a cada tecla vira ruído que a pessoa fecha sem ler');
  assert.match(a.avisos[0], /pacientes/);
  assert.match(a.avisos[0], /Backup/, 'o aviso tem de dizer o que fazer pra liberar espaço');
});

test('nenhuma gravação do DB escreve direto no localStorage', () => {
  const src = recortarFuncao('_gravarLocal');
  const db = fonte.slice(fonte.indexOf('const DB = {'));
  const corpo = db.slice(0, db.indexOf('\n};'));
  assert.ok(!/localStorage\.setItem/.test(corpo),
    'setItem cru no DB.set volta a lançar no meio do save, sem gravar e sem avisar');
  assert.strictEqual((corpo.match(/_gravarLocal\(/g) || []).length, 3,
    'as três gravações (blindada, blob e objeto) passam pelo helper');
  assert.match(src, /catch/, 'o helper é o único ponto que trata a cota');
});

test('o push continua sendo enfileirado mesmo quando o local falha', () => {
  // Numa coleção blindada o push leva o `val` em MEMÓRIA — é a única chance de
  // o registro chegar a algum lugar quando o aparelho está sem espaço.
  const db = fonte.slice(fonte.indexOf('const DB = {'));
  const corpo = db.slice(0, db.indexOf('\n};'));
  const iGrava = corpo.indexOf('_gravarLocal');
  const iFila  = corpo.indexOf('_enfileirarPush');
  assert.ok(iGrava > -1 && iFila > iGrava,
    'a fila tem de ser alimentada DEPOIS da tentativa local, e independentemente dela');
  // O `if` da gravação local só pode ter UMA consequência: avisar. Qualquer
  // outra coisa (um return, um throw) aborta o envio pra nuvem junto.
  const usos = corpo.match(/if \(!_gravarLocal\([^\n]*\n/g) || [];
  assert.strictEqual(usos.length, 3);
  for (const u of usos) {
    assert.match(u, /\)\) _avisarSemEspaco\(key\);\s*$/,
      'falhar o local não pode abortar o envio pra nuvem: ' + u.trim());
  }
});
