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

// O dropdown precisa OFERECER todos os status que o app grava. Faltando
// 'Parcial', nenhuma <option> ficava selecionada, o <select> exibia a primeira
// ("Pago") e qualquer toque gravava por cima, destruindo o status sem volta.
test('pgtoSelect: Parcial existe e vem selecionado', () => {
  const { pgtoSelect } = carregar('pgtoSelect');
  const html = pgtoSelect('Parcial', 0);
  assert.match(html, /<option value="Parcial" selected>/,
    'Parcial precisa existir no dropdown E vir selecionado');
});

test('pgtoSelect: todo status gravado pelo app tem opção própria', () => {
  const { pgtoSelect } = carregar('pgtoSelect');
  for (const st of ['Pago', 'Parcial', 'Pendente', 'Isento']) {
    assert.match(pgtoSelect(st, 0), new RegExp(`<option value="${st}" selected>`),
      `${st} deveria vir selecionado`);
  }
});

test('pgtoSelect: status ausente cai em Pendente (e não em Pago)', () => {
  const { pgtoSelect } = carregar('pgtoSelect');
  for (const vazio of [null, undefined, '', 'null']) {
    assert.match(pgtoSelect(vazio, 0), /<option value="Pendente" selected>/);
  }
});

// A importação de planilha só pode produzir status que o resto do app entende.
// 'Parcelado' não existia em lugar nenhum: o lançamento entrava no bruto mas
// ficava fora de TODOS os baldes de _resumoFin — dinheiro invisível.
const STATUS_CANONICOS = ['Pago', 'Parcial', 'Pendente', 'Isento'];

test('impNormStatus: nunca inventa status fora do canônico', () => {
  const { impNormStatus } = carregar('impNormStatus');
  const entradas = ['pago', 'PAGO', 'recebido', 'parcelado', 'Parcial', 'pendente',
                    'isento', 'cortesia', '', null, undefined, 'qualquer coisa'];
  for (const e of entradas) {
    assert.ok(STATUS_CANONICOS.includes(impNormStatus(e)),
      `impNormStatus(${JSON.stringify(e)}) devolveu "${impNormStatus(e)}", fora do canônico`);
  }
});

test('impNormStatus: parcelado vira Parcial, cortesia vira Isento', () => {
  const { impNormStatus } = carregar('impNormStatus');
  assert.strictEqual(impNormStatus('Parcelado'), 'Parcial');
  assert.strictEqual(impNormStatus('parcelado em 3x'), 'Parcial');
  assert.strictEqual(impNormStatus('cortesia'), 'Isento');
  assert.strictEqual(impNormStatus('isento'), 'Isento');
  assert.strictEqual(impNormStatus('pago'), 'Pago');
  assert.strictEqual(impNormStatus(''), 'Pendente');
});

// TICKET MÉDIO em duas leituras. Retorno é gratuito por padrão, então dividir
// tudo pelo total de atendimentos derrubava o número pela metade sem aviso.
const MES_COM_RETORNOS = [
  { nome: 'Ana',   data: '2026-08-03', valor: 500 },  // consulta paga
  { nome: 'Bruno', data: '2026-08-05', valor: 500 },  // consulta paga
  { nome: 'Ana',   data: '2026-08-18', valor: 0   },  // retorno gratuito
  { nome: 'Bruno', data: '2026-08-20', valor: 0   },  // retorno gratuito
];

test('_ticketMedio: consulta paga não é diluída pelos retornos gratuitos', () => {
  const { _ticketMedio } = carregar('_ticketMedio');
  const t = _ticketMedio(MES_COM_RETORNOS);
  assert.strictEqual(t.porConsultaPaga, 500, 'preço praticado');
  assert.strictEqual(t.porAtendimento, 250, 'rendimento por cadeira ocupada');
  assert.strictEqual(t.qtdPagas, 2);
  assert.strictEqual(t.qtdGratuitos, 2);
});

test('_ticketMedio: sem gratuitos as duas leituras coincidem', () => {
  const { _ticketMedio } = carregar('_ticketMedio');
  const t = _ticketMedio([{ valor: 300 }, { valor: 500 }]);
  assert.strictEqual(t.porConsultaPaga, 400);
  assert.strictEqual(t.porAtendimento, 400);
  assert.strictEqual(t.qtdGratuitos, 0);
});

test('_ticketMedio: lista vazia e só-gratuitos não dividem por zero', () => {
  const { _ticketMedio } = carregar('_ticketMedio');
  const vazio = _ticketMedio([]);
  assert.strictEqual(vazio.porConsultaPaga, 0);
  assert.strictEqual(vazio.porAtendimento, 0);
  const soGratis = _ticketMedio([{ valor: 0 }, { valor: 0 }]);
  assert.strictEqual(soGratis.porConsultaPaga, 0, 'sem consulta paga, não é NaN');
  assert.strictEqual(soGratis.porAtendimento, 0);
});

// PACIENTE NOVO = nunca foi atendido antes (primeiro atendimento cai no mês).
// O bug: qualquer atendimento de quem um dia veio do CRM contava como aquisição
// nova do mês, então retorno de paciente antigo inflava CAC e ROI.
const BASE = [
  { nome: 'Ana',      data: '2026-05-10', valor: 400 },  // 1ª vez em maio
  { nome: 'Ana',      data: '2026-08-04', valor: 0   },  // retorno em agosto
  { nome: 'Bruno',    data: '2026-08-12', valor: 500 },  // 1ª vez em agosto
  { nome: '  bruno ', data: '2026-08-20', valor: 0   },  // retorno no mesmo mês
  { nome: 'Célia',    data: '2026-08-15', valor: 300 },  // 1ª vez em agosto
  { nome: '',         data: '2026-08-15', valor: 999 },  // sem nome: ignorar
];

test('_novosNoMes: retorno de paciente antigo NÃO conta como novo', () => {
  const { _novosNoMes } = carregar(['_novosNoMes', 'getMes']);
  const r = _novosNoMes(BASE, '2026-08');
  assert.strictEqual(r.quantidade, 2, 'só Bruno e Célia estrearam em agosto');
  assert.ok(!r.atendimentos.some(p => (p.nome || '').trim() === 'Ana'),
    'Ana estreou em maio — o retorno dela em agosto não é aquisição');
});

test('_novosNoMes: mesma pessoa 2x no mês conta 1, mas soma a receita', () => {
  const { _novosNoMes } = carregar(['_novosNoMes', 'getMes']);
  const r = _novosNoMes(BASE, '2026-08');
  assert.strictEqual(r.quantidade, 2);          // Bruno (2 atendimentos) + Célia
  assert.strictEqual(r.receita, 800);           // 500 + 0 (Bruno) + 300 (Célia)
});

test('_novosNoMes: mês da estreia conta a própria estreia', () => {
  const { _novosNoMes } = carregar(['_novosNoMes', 'getMes']);
  const r = _novosNoMes(BASE, '2026-05');
  assert.strictEqual(r.quantidade, 1);
  assert.strictEqual(r.receita, 400);
});

test('_novosNoMes: base vazia e mês sem estreia não quebram', () => {
  const { _novosNoMes } = carregar(['_novosNoMes', 'getMes']);
  assert.strictEqual(_novosNoMes([], '2026-08').quantidade, 0);
  assert.strictEqual(_novosNoMes(BASE, '2026-07').quantidade, 0);
  assert.strictEqual(_novosNoMes(null, '2026-08').receita, 0);
});

// O status importado tem de fechar com _resumoFin — é o acoplamento que
// quebrava: importava, o bruto subia e "Recebido" continuava zerado.
test('importação alimenta os baldes de _resumoFin', () => {
  const { impNormStatus } = carregar('impNormStatus');
  const { _resumoFin } = carregar('_resumoFin');
  const importados = [
    { statusPgto: impNormStatus('pago'),      valor: 1000 },
    { statusPgto: impNormStatus('parcelado'), valor: 500 },
    { statusPgto: impNormStatus('pendente'),  valor: 300 },
    { statusPgto: impNormStatus('cortesia'),  valor: 200 },
  ];
  const r = _resumoFin(importados);
  assert.strictEqual(r.recebido + r.aReceber + r.isento, r.bruto, 'a regra de ouro tem de fechar');
  assert.strictEqual(r.recebido, 1000);
  assert.strictEqual(r.aReceber, 800);
});
