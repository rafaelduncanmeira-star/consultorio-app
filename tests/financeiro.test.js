// Testes do resumo financeiro (caixa × competência) — rode com: node --test
// Exercitam o código REAL recortado do app.js (ver tests/_extrair.js).

const { test } = require('node:test');
const assert = require('node:assert');
const { carregar } = require('./_extrair.js');

// Lançamentos de exemplo cobrindo os 4 status.
const PACS = [
  { statusPgto: 'Pago',     valor: 1000 },
  { statusPgto: 'Pago',     valor: 500 },
  { statusPgto: 'Parcial',  valor: 7200 },  // assinatura: valor cheio, parcialmente paga
  { statusPgto: 'Pendente', valor: 300 },
  { statusPgto: 'Isento',   valor: 200 },   // cortesia: não é receita
];

test('_resumoFin: buckets fecham com o bruto (Parcial não some)', () => {
  const { _resumoFin } = carregar('_resumoFin');
  const r = _resumoFin(PACS);
  assert.strictEqual(r.pago, 1500);
  assert.strictEqual(r.parcial, 7200);
  assert.strictEqual(r.pendente, 300);
  assert.strictEqual(r.isento, 200);
  assert.strictEqual(r.bruto, 9200);
  // A regra de ouro: recebido + a receber + isento === bruto
  assert.strictEqual(r.recebido + r.aReceber + r.isento, r.bruto);
});

test('_resumoFin: caixa é só Pago; competência é Pago+Parcial+Pendente', () => {
  const { _resumoFin } = carregar('_resumoFin');
  const r = _resumoFin(PACS);
  assert.strictEqual(r.recebido, 1500);          // CAIXA
  assert.strictEqual(r.aReceber, 7500);          // Parcial(7200) + Pendente(300)
  assert.strictEqual(r.faturado, 9000);          // COMPETÊNCIA (bruto − isento)
  assert.strictEqual(r.faturado, r.bruto - r.isento);
});

test('_resumoFin: lista vazia não quebra', () => {
  const { _resumoFin } = carregar('_resumoFin');
  const r = _resumoFin([]);
  assert.deepStrictEqual(
    { recebido: r.recebido, aReceber: r.aReceber, faturado: r.faturado, bruto: r.bruto },
    { recebido: 0, aReceber: 0, faturado: 0, bruto: 0 });
});

test('_lucroFin: lucro caixa usa recebido; lucro competência usa faturado', () => {
  const { _resumoFin, _lucroFin } = carregar(['_resumoFin', '_lucroFin']);
  const r = _resumoFin(PACS);
  const l = _lucroFin(r, 1000); // despesas do período
  assert.strictEqual(l.caixa, 500);          // 1500 − 1000
  assert.strictEqual(l.competencia, 8000);   // 9000 − 1000
  // a diferença entre os regimes é exatamente o que ainda não entrou no caixa
  assert.strictEqual(l.competencia - l.caixa, r.aReceber);
});

test('_lucroFin: margens não estouram com receita zero', () => {
  const { _resumoFin, _lucroFin } = carregar(['_resumoFin', '_lucroFin']);
  const l = _lucroFin(_resumoFin([]), 500);
  assert.strictEqual(l.margemCaixa, 0);
  assert.strictEqual(l.margemCompetencia, 0);
});
