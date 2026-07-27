// Testes do vocabulário de status da agenda — rode com: node --test
//
// O app grava 'No-show' (é a única opção do <select> na agenda), mas três
// pontos do código comparavam com 'Faltou' — um status que a interface nunca
// produziu. O mais grave: a sincronização reversa agendamento → CRM. O paciente
// não aparecia, a secretária marcava No-show, e o card do CRM continuava em
// "Marcou" pra sempre. O funil mostrava como convertido quem não veio.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { carregar, fonte } = require('./_extrair.js');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

// Os status que o <select> da agenda oferece — o vocabulário REAL do produto.
function statusDaAgenda() {
  for (const m of html.matchAll(/<select[^>]*>([\s\S]*?)<\/select>/g)) {
    const opts = [...m[1].matchAll(/<option value="([^"]+)"/g)].map(o => o[1]);
    if (opts.includes('Compareceu')) return opts;
  }
  return [];
}

test('agenda: o select oferece os status que o app espera', () => {
  const opts = statusDaAgenda();
  assert.ok(opts.length, 'o select de status da agenda tem de existir');
  for (const st of ['Pendente', 'Confirmado', 'Compareceu', 'Cancelado']) {
    assert.ok(opts.includes(st), `${st} deveria estar no select`);
  }
});

test('agenda: AG_FALTOU é exatamente o valor que o select grava', () => {
  const { AG_FALTOU } = carregar('const:AG_FALTOU');
  const opts = statusDaAgenda();
  assert.ok(opts.includes(AG_FALTOU),
    `AG_FALTOU é "${AG_FALTOU}" mas o select oferece: ${opts.join(', ')}`);
});

// O guarda contra a reincidência: nenhum ponto do código pode voltar a comparar
// com um literal que a interface não grava.
test('agenda: nada no código compara com o status fantasma "Faltou"', () => {
  const semComentarios = fonte.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(semComentarios, /['"]Faltou['"]/,
    'a interface nunca gravou "Faltou" — comparar com ele é ramo morto');
});

test('agenda: a reversão do CRM cobre falta E cancelamento', () => {
  const { recortarFuncao } = require('./_extrair.js');
  const src = recortarFuncao('updateAgStatus').replace(/\/\/[^\n]*/g, '');
  assert.match(src, /novo === 'Cancelado' \|\| novo === AG_FALTOU/,
    'sem a falta aqui, o card do CRM fica em "Marcou" mesmo com o paciente ausente');
  assert.match(src, /novo === 'Compareceu'/, 'e o caminho de comparecimento continua');
});

// Os outros dois pontos que usavam o literal errado.
test('agenda: lembrete e detecção de vínculos usam a constante', () => {
  for (const fn of ['_agendamentosParaLembrar', '_detectarVinculos']) {
    const { recortarFuncao } = require('./_extrair.js');
    const src = recortarFuncao(fn);
    assert.match(src, /AG_FALTOU/, `${fn} tem de usar a constante, não um literal`);
  }
});
