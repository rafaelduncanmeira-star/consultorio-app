// Fluxo de caixa — rode com: node --test
//
// O CLAUDE.md fixa: caixa = `recebido`, competência = `faturado`, e _resumoFin
// é a fonte única. `faturado` é pago+parcial+pendente — Isento fica FORA, porque
// é serviço prestado que o médico decidiu não cobrar.
//
// Esta tela somava `p.valor` de todo mundo. A coluna "Regime de Competência"
// divergia do faturado que o Dashboard mostra pro mesmo mês, e a coluna de
// caixa projetava entrada de dinheiro a partir de uma isenção — dinheiro que,
// por definição, nunca vai chegar.

const { test } = require('node:test');
const assert = require('node:assert');
const { carregar } = require('./_extrair.js');

function rodar(pacs, mes) {
  let html = '';
  const el = { set innerHTML(v) { html = v; }, get innerHTML() { return html; } };
  const s = carregar(['renderFluxoCaixa', '_ymd', 'getMes'], {
    JSON, Array, Object, Date, Math, String, Number,
    DB: { get: () => JSON.parse(JSON.stringify(pacs)) },
    document: { getElementById: (id) => (id === 'fluxo-caixa-body' ? el : null) },
    BRL: (v) => '«' + Math.round(v * 100) / 100 + '»',
  });
  s.renderFluxoCaixa(mes);
  return html;
}

// Extrai os números de uma linha do mês pedido, POR POSIÇÃO de coluna:
// [competência, caixa, diferença]. Ler só os «» que aparecem não serve —
// célula zerada renderiza "—" e some, deslocando os índices: um teste meu
// passou lendo a coluna de caixa achando que era a de competência.
function linhaDoMes(html, rotulo) {
  const alvo = html.split('<tr').find(l => l.includes(rotulo));
  assert.ok(alvo, `linha de ${rotulo} não encontrada`);
  const celulas = alvo.split('<td').slice(2); // [0] é o pedaço antes do 1º td, [1] é o mês
  assert.strictEqual(celulas.length, 3, 'a tabela tem mês + 3 colunas numéricas');
  return celulas.map(c => {
    const m = c.match(/«(-?[\d.]+)»/);
    return m ? parseFloat(m[1]) : 0;
  });
}

const BASE = [
  { data: '2026-07-05', valor: 300, statusPgto: 'Pago' },
  { data: '2026-07-10', valor: 200, statusPgto: 'Pendente' },
];

test('fluxo de caixa: consulta isenta não entra na competência', () => {
  const semIsento = linhaDoMes(rodar(BASE, '2026-07'), 'Jul/2026');
  const comIsento = linhaDoMes(
    rodar([...BASE, { data: '2026-07-15', valor: 400, statusPgto: 'Isento' }], '2026-07'),
    'Jul/2026');
  assert.deepStrictEqual(comIsento, semIsento,
    'isento é serviço não cobrado — _resumoFin o mantém fora de faturado, esta tela também tem de manter');
});

test('fluxo de caixa: competência do mês bate com o faturado de _resumoFin', () => {
  const pacs = [...BASE, { data: '2026-07-15', valor: 400, statusPgto: 'Isento' }];
  const { _resumoFin, _centavos } = carregar(['_resumoFin', '_centavos'], { Array, Math, Number });
  const faturado = _resumoFin(pacs).faturado;
  const [competencia] = linhaDoMes(rodar(pacs, '2026-07'), 'Jul/2026');
  assert.strictEqual(competencia, faturado,
    `a tela mostra ${competencia} e a fonte única diz ${faturado}`);
});

test('fluxo de caixa: parcelado continua distribuído pelos meses', () => {
  const pacs = [{ data: '2026-07-05', valor: 900, statusPgto: 'Pago', parcelas: 3,
                  recebimentos: [
                    { numero: 1, mes: '2026-07', valor: 300, recebido: true },
                    { numero: 2, mes: '2026-08', valor: 300, recebido: false },
                    { numero: 3, mes: '2026-09', valor: 300, recebido: false }] }];
  const html = rodar(pacs, '2026-07');
  assert.strictEqual(linhaDoMes(html, 'Jul/2026')[1], 300, 'caixa de julho é só a 1ª parcela');
  assert.strictEqual(linhaDoMes(html, 'Ago/2026')[1], 300, 'agosto recebe a 2ª em CAIXA');
  assert.strictEqual(linhaDoMes(html, 'Ago/2026')[0], 0, 'e nada em competência: a consulta foi em julho');
  assert.strictEqual(linhaDoMes(html, 'Jul/2026')[0], 900, 'competência inteira no mês da consulta');
});
