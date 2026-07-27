// Despesas por categoria — rode com: node --test
//
// O <select> de categoria do modal de despesa é agrupado por <optgroup>. O que
// ele GRAVA é a opção — "Aluguel", "Salários", "Contador" —, não o rótulo do
// grupo — "Estrutura", "Pessoal", "Profissional". O gráfico do Dashboard e a
// tabela do relatório filtravam por uma lista fixa com os RÓTULOS:
//
//   ['Estrutura','Pessoal','Marketing','Materiais','Profissional','Impostos','Outros']
//
// Só quatro deles são também opções do select. Aluguel, salário, contador,
// utilidades, equipamentos — as maiores linhas de um consultório — não caíam em
// balde nenhum. O gráfico mostrava fatias somando uma fração do total real, e a
// tabela do relatório calculava o percentual sobre o total VERDADEIRO, então as
// linhas não somavam 100% e nada explicava a diferença.
//
// A tela de Despesas já tinha sido corrigida ("antes era lista hardcoded que
// filtrava silenciosamente Aluguel/Salários/Utilidades"); as outras duas não.

const { test } = require('node:test');
const assert = require('node:assert');
const { carregar, fonte, recortarFuncao } = require('./_extrair.js');

const { _despesasPorCategoria } = carregar('_despesasPorCategoria', { Map, Array, String });
const puro = (x) => JSON.parse(JSON.stringify(x));

test('as categorias vêm dos lançamentos, não de uma lista fixa', () => {
  const r = _despesasPorCategoria([
    { categoria: 'Aluguel',  valor: 4000 },
    { categoria: 'Salários', valor: 9000 },
    { categoria: 'Marketing', valor: 1000 },
  ]);
  assert.deepStrictEqual(puro(r), [
    { cat: 'Salários', val: 9000 },
    { cat: 'Aluguel',  val: 4000 },
    { cat: 'Marketing', val: 1000 },
  ]);
});

test('o total das categorias fecha com o total das despesas', () => {
  const desps = [
    { categoria: 'Aluguel', valor: 4000 }, { categoria: 'Salários', valor: 9000 },
    { categoria: 'Contador', valor: 800 }, { categoria: 'Equipamentos', valor: 1200 },
    { categoria: 'Impostos', valor: 2000 },
  ];
  const total = desps.reduce((s, d) => s + d.valor, 0);
  const soma  = _despesasPorCategoria(desps).reduce((s, c) => s + c.val, 0);
  assert.strictEqual(soma, total,
    'percentual calculado sobre o total real com numerador incompleto nunca soma 100%');
});

test('mesma categoria digitada com espaço é o mesmo balde', () => {
  const r = _despesasPorCategoria([
    { categoria: 'Aluguel',   valor: 1000 },
    { categoria: ' Aluguel ', valor: 500 },
  ]);
  assert.deepStrictEqual(puro(r), [{ cat: 'Aluguel', val: 1500 }]);
});

test('despesa sem categoria cai em Outros, não some', () => {
  const r = _despesasPorCategoria([{ valor: 300 }, { categoria: '', valor: 200 }]);
  assert.deepStrictEqual(puro(r), [{ cat: 'Outros', val: 500 }]);
});

test('categoria com valor zero não polui o gráfico', () => {
  const r = _despesasPorCategoria([{ categoria: 'Limpeza', valor: 0 }, { categoria: 'Aluguel', valor: 10 }]);
  assert.deepStrictEqual(puro(r), [{ cat: 'Aluguel', val: 10 }]);
});

test('lista vazia não quebra', () => {
  assert.deepStrictEqual(puro(_despesasPorCategoria([])), []);
  assert.deepStrictEqual(puro(_despesasPorCategoria(null)), []);
});

test('nenhuma tela mantém a lista fixa de rótulos de grupo', () => {
  const ruins = [];
  fonte.split('\n').forEach((l, i) => {
    if (/'Estrutura'\s*,\s*'Pessoal'/.test(l)) ruins.push((i + 1) + ': ' + l.trim().slice(0, 110));
  });
  assert.deepStrictEqual(ruins, [],
    'os rótulos dos <optgroup> não são valores gravados — filtrar por eles perde quase tudo');
});

test('as três telas de categoria usam a mesma regra', () => {
  // Nomes conferidos no fonte: a tela de Despesas, o gráfico do Dashboard e a
  // tabela do relatório. Nada de try/continue aqui — função que sumiu tem de
  // reprovar, senão o teste vira decoração.
  for (const fn of ['renderDespesas', 'renderDashboard', 'renderRelatorio']) {
    assert.match(recortarFuncao(fn), /_despesasPorCategoria\(/,
      `${fn} agrupa despesa por categoria e tem de usar a regra única`);
  }
});

test('o modal de despesa preserva valor fora do <select>', () => {
  const src = recortarFuncao('editRow');
  for (const campo of ['form.categoria', 'form.tipo', 'form.formaPgto']) {
    assert.ok(src.includes(`_opcaoLegadaSeFaltar(${campo}`),
      `${campo} sem a opção legada é apagado ao abrir e salvar a despesa`);
  }
});

// A mesma armadilha vale pra TODO <select> que o editRow preenche. O `tipo` do
// CRM é o mais fácil de disparar: o copiloto grava o que o médico ditou
// ("Telemedicina", "avaliação") e a especificação dele nem lista vocabulário
// pra esse campo — mas o select só tem seis opções. Abrir o contato pra
// corrigir o telefone e salvar apagava o tipo, e com ele o procedimento que o
// agendamento criado a partir do card ia herdar.
test('todo <select> preenchido pelo editRow recebe a opção legada antes', () => {
  // Campos do editRow que são <select> no index.html — conferido no HTML, não
  // chutado: se um deixar de ser select (ou virar select), o teste avisa.
  const html = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'index.html'), 'utf8');
  const src = recortarFuncao('editRow');
  const atribuicoes = [...src.matchAll(/form\.(\w+)\.value = r\.\w+/g)].map(m => m[1]);
  const selects = new Set([...html.matchAll(/<select[^>]*\sname="(\w+)"/g)].map(m => m[1]));
  const desprotegidos = atribuicoes
    .filter(c => selects.has(c))
    .filter(c => !src.includes(`_opcaoLegadaSeFaltar(form.${c}`));
  assert.deepStrictEqual(desprotegidos, [],
    'valor fora das <option> deixa selectedIndex -1 e o save devolve \'\' — o campo é apagado');
});

// Dublê de <select> com <option> estáticas, como as do index.html: ninguém
// reconstrói o innerHTML desses selects entre uma abertura e outra.
function selectComOpcoes(fixas) {
  const opts = fixas.map(v => ({ value: v, legado: false }));
  const sel = {
    get options() { return opts; },
    querySelectorAll: (q) => opts.filter(o => q.includes('data-legado') && o.legado)
      .map(o => ({ remove: () => opts.splice(opts.indexOf(o), 1) })),
    insertAdjacentHTML: (_p, h) => {
      const m = h.match(/value="([^"]*)"/);
      opts.push({ value: m[1], legado: /data-legado/.test(h) });
    },
  };
  return sel;
}

test('_opcaoLegadaSeFaltar só age quando a opção falta mesmo', () => {
  const { _opcaoLegadaSeFaltar } = carregar(['_esc', '_opcaoLegadaSeFaltar'], { Array, String });
  const sel = selectComOpcoes(['Aluguel']);
  _opcaoLegadaSeFaltar(sel, 'Aluguel');
  assert.deepStrictEqual(sel.options.map(o => o.value), ['Aluguel'],
    'opção que já existe não pode ser duplicada');
  _opcaoLegadaSeFaltar(sel, 'Estrutura');
  assert.deepStrictEqual(sel.options.map(o => o.value), ['Aluguel', 'Estrutura']);
  _opcaoLegadaSeFaltar(null, 'x');   // sem select, não explode
});

test('a legada do registro ANTERIOR não fica pendurada no <select>', () => {
  // As <option> destes selects vêm do index.html e nada as reconstrói. Sem
  // limpar, cada registro esquisito aberto deixava uma opção pra trás até
  // recarregar a página — e o médico podia escolher a "(legado)" de outro
  // registro num lançamento novo, gravando de propósito fora do vocabulário.
  const { _opcaoLegadaSeFaltar } = carregar(['_esc', '_opcaoLegadaSeFaltar'], { Array, String });
  const sel = selectComOpcoes(['Aluguel', 'Marketing']);
  _opcaoLegadaSeFaltar(sel, 'Estrutura');     // abriu a despesa A
  _opcaoLegadaSeFaltar(sel, 'Pessoal');       // abriu a despesa B
  assert.deepStrictEqual(sel.options.map(o => o.value), ['Aluguel', 'Marketing', 'Pessoal']);
  _opcaoLegadaSeFaltar(sel, 'Marketing');     // abriu uma despesa normal
  assert.deepStrictEqual(sel.options.map(o => o.value), ['Aluguel', 'Marketing'],
    'volta ao vocabulário puro quando o registro está em ordem');
});
