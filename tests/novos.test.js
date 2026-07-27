// "Paciente novo" — rode com: node --test
//
// A regra do médico (CLAUDE.md) é: novo = pessoa que NUNCA foi atendida antes.
// Ela tem duas leituras legítimas e as duas são usadas:
//   · _novosNoMes        — por PESSOA no mês (aquisição: CAC e ROI de marketing)
//   · _primeiroAtendimentoDe — por ATENDIMENTO (o DRE fatia o faturamento em
//     novos + recorrentes, e isso só soma 100% se a divisão for por atendimento)
// O que NÃO é legítimo é cada tela ter a sua cópia inline da segunda: o DRE e o
// relatório tinham, e as duas esqueciam a guarda de atendimento sem data.

const { test } = require('node:test');
const assert = require('node:assert');
const { carregar, fonte } = require('./_extrair.js');

const { _primeiroAtendimentoDe, _novosNoMes } = carregar(
  ['_primeiroAtendimentoDe', '_novosNoMes'],
  { getMes: (d) => (d ? d.substring(0, 7) : '') }
);

test('só a estreia da pessoa conta como novo', () => {
  const base = [
    { nome: 'Ana',  data: '2026-03-05', valor: 500 },
    { nome: 'Ana',  data: '2026-03-20', valor: 300 },
    { nome: 'Bruno', data: '2026-01-10', valor: 400 },
    { nome: 'Bruno', data: '2026-03-02', valor: 400 },
  ];
  const ehNovo = _primeiroAtendimentoDe(base);
  assert.deepStrictEqual(base.map(ehNovo), [true, false, true, false]);
});

test('atendimento SEM data não apaga a estreia do paciente', () => {
  // Um único registro sem data (importação, tela antiga) ia parar na frente da
  // ordenação por `(p.data || '')`: a "primeira data" da Ana virava undefined e
  // NENHUM atendimento dela batia mais. Ela aparecia como recorrente já na
  // consulta de estreia, e a linha "Novos pacientes" do PDF do contador saía
  // a menos — sem nada indicando que faltava alguém.
  const base = [
    { nome: 'Ana', data: '',           valor: 0   },
    { nome: 'Ana', data: '2026-03-05', valor: 500 },
    { nome: 'Ana', data: '2026-03-20', valor: 300 },
  ];
  const ehNovo = _primeiroAtendimentoDe(base);
  assert.equal(ehNovo(base[1]), true, 'a estreia real continua sendo a estreia');
  assert.equal(ehNovo(base[0]), false, 'registro sem data não é estreia de ninguém');
  assert.equal(ehNovo(base[2]), false);
});

test('registro sem nome nunca conta como novo', () => {
  const ehNovo = _primeiroAtendimentoDe([{ nome: '', data: '2026-03-05' }]);
  assert.equal(ehNovo({ nome: '', data: '2026-03-05' }), false);
  assert.equal(ehNovo({ nome: '   ', data: '2026-03-05' }), false);
});

test('nome que colide com propriedade herdada de Object não some', () => {
  // Com objeto literal, `'constructor' in {}` é true por herança: a checagem
  // `!(n in mapa)` pulava o registro e a comparação virava data === Function.
  const base = [{ nome: 'Constructor', data: '2026-03-05', valor: 100 }];
  assert.equal(_primeiroAtendimentoDe(base)(base[0]), true);
});

test('a divisão novos/recorrentes cobre TODOS os atendimentos do período', () => {
  // É o que sustenta o "100%" da linha Total do DRE.
  const base = [
    { nome: 'Ana',   data: '2026-03-05', valor: 500 },
    { nome: 'Ana',   data: '2026-03-20', valor: 300 },
    { nome: 'Bruno', data: '2026-03-02', valor: 400 },
    { nome: 'Ana',   data: '',           valor: 0   },
  ];
  const mes = base.filter(p => p.data && p.data.startsWith('2026-03'));
  const ehNovo = _primeiroAtendimentoDe(base);
  const novos = mes.filter(ehNovo), rec = mes.filter(p => !ehNovo(p));
  assert.equal(novos.length + rec.length, mes.length);
  const soma = (l) => l.reduce((s, p) => s + p.valor, 0);
  assert.equal(soma(novos) + soma(rec), soma(mes),
    'as duas fatias têm de somar o faturamento do período — senão o "100%" mente');
});

test('as duas leituras respondem perguntas diferentes, de propósito', () => {
  const base = [
    { nome: 'Ana', data: '2026-03-05', valor: 500 },
    { nome: 'Ana', data: '2026-03-20', valor: 300 },
  ];
  const ehNovo = _primeiroAtendimentoDe(base);
  // Aquisição: a Ana foi conquistada em março e rendeu 800 no mês.
  assert.equal(_novosNoMes(base, '2026-03').receita, 800);
  // DRE: só a consulta de estreia é "receita de novo"; o retorno é recorrente.
  assert.equal(base.filter(ehNovo).reduce((s, p) => s + p.valor, 0), 500);
});

test('nenhuma tela reimplementa a regra inline', () => {
  const inline = [];
  fonte.split('\n').forEach((l, i) => {
    if (/primeiraData|_primeiraData|primeiraDataPorNome/.test(l)) inline.push((i + 1) + ': ' + l.trim());
  });
  assert.deepStrictEqual(inline, [],
    'DRE e relatório têm de chamar _primeiroAtendimentoDe — cópia inline volta a divergir');
});
