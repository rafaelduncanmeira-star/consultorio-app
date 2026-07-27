// Importação de planilha — rode com: node --test
//
// O exportarCSV cita campos com quebra de linha e duplica as aspas internas
// (`"` vira `""`), como manda o formato. O impParseCSV quebrava o texto por
// linha ANTES de olhar aspas — ou seja, o app não conseguia reimportar o que
// ele mesmo exportava.

const { test } = require('node:test');
const assert = require('node:assert');
const { carregar, recortarFuncao } = require('./_extrair.js');

// Realm do node:vm: o array volta com outro protótipo e o deepStrictEqual
// reprova por isso, não pelo conteúdo. Normaliza na saída.
const parse = (csv) => {
  const r = carregar('impParseCSV', { String, Object }).impParseCSV(csv);
  return r === null ? null : JSON.parse(JSON.stringify(r));
};

// Reproduz o que o exportarCSV grava para um valor.
function comoOExportGrava(v) {
  const s = v === undefined || v === null ? '' : String(v);
  return s.includes(';') || s.includes('"') || s.includes('\n')
    ? `"${s.replace(/"/g, '""')}"` : s;
}

test('ida e volta: observação de duas linhas continua sendo UM paciente', () => {
  const csv = 'nome;obs\n'
    + [comoOExportGrava('Ana Souza'), comoOExportGrava('linha1\nlinha2')].join(';') + '\n'
    + [comoOExportGrava('Bruno'), comoOExportGrava('ok')].join(';');
  const r = parse(csv);
  assert.strictEqual(r.rows.length, 2,
    'antes virava 3: a segunda linha da observação entrava como paciente novo');
  assert.strictEqual(r.rows[0].nome, 'Ana Souza');
  assert.strictEqual(r.rows[0].obs, 'linha1\nlinha2');
  assert.strictEqual(r.rows[1].nome, 'Bruno');
});

test('ida e volta: aspas dentro do texto sobrevivem', () => {
  const csv = 'nome;obs\n' + ['Bruno', comoOExportGrava('disse "ok" ontem')].join(';');
  assert.strictEqual(parse(csv).rows[0].obs, 'disse "ok" ontem',
    'o parser alternava o estado a cada aspa e descartava as duas');
});

test('ida e volta: ponto e vírgula dentro do campo não vira coluna nova', () => {
  const csv = 'nome;obs\n' + ['Ana', comoOExportGrava('trouxe exames; pediu retorno')].join(';');
  const r = parse(csv);
  assert.strictEqual(r.rows[0].obs, 'trouxe exames; pediu retorno');
  assert.strictEqual(r.rows.length, 1);
});

test('delimitador: vírgula continua sendo detectada', () => {
  const r = parse('nome,valor\nAna,1000\nBruno,500');
  assert.deepStrictEqual(r.headers, ['nome', 'valor']);
  assert.strictEqual(r.rows.length, 2);
  assert.strictEqual(r.rows[1].valor, '500');
});

test('delimitador: ponto e vírgula ganha no empate (padrão brasileiro)', () => {
  const r = parse('nome;obs\nAna;a,b,c');
  assert.deepStrictEqual(r.headers, ['nome', 'obs']);
  assert.strictEqual(r.rows[0].obs, 'a,b,c');
});

test('linhas em branco no meio não viram registro', () => {
  const r = parse('nome;valor\nAna;1\n\n\nBruno;2\n');
  assert.strictEqual(r.rows.length, 2);
});

test('arquivo sem dados devolve null (não quebra o assistente)', () => {
  assert.strictEqual(parse(''), null);
  assert.strictEqual(parse('   '), null);
  assert.strictEqual(parse('so;cabecalho'), null);
});

test('última linha sem quebra final é lida', () => {
  const r = parse('nome;valor\nAna;1\nBruno;2');
  assert.strictEqual(r.rows.length, 2, 'muito arquivo real termina sem \\n');
  assert.strictEqual(r.rows[1].nome, 'Bruno');
});

test('CRLF do Excel no Windows não deixa \\r grudado no valor', () => {
  const r = parse('nome;valor\r\nAna;1000\r\nBruno;500');
  assert.strictEqual(r.rows[0].valor, '1000');
  assert.strictEqual(r.rows[1].nome, 'Bruno');
});

// Premissa: se o exportarCSV mudar de regra, este arquivo precisa acompanhar.
test('o exportarCSV continua citando quebra de linha e aspas', () => {
  const src = recortarFuncao('exportarCSV').replace(/\/\/[^\n]*/g, '');
  assert.match(src, /includes\('\\n'\)/, 'é o que torna o campo multilinha possível');
  assert.match(src, /replace\(\/"\/g,\s*'""'\)/, 'e a aspa duplicada');
});
