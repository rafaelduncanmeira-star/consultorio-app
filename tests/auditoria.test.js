// Histórico de alterações — rode com: node --test
//
// O closeModal zera o editState (é ele que impede o próximo "+ Novo" de gravar
// por cima do registro editado). O savePaciente e o saveDespesa chamavam o
// closeModal e SÓ DEPOIS montavam a linha do histórico lendo `editState.idx` —
// que a essa altura era sempre null. Resultado: toda edição entrava no
// histórico como criação. A alteração ficava invisível e ainda aparecia um
// cadastro que nunca aconteceu; para uma consulta editada, a linha original de
// criação continuava lá, então o histórico mostrava dois "Cadastrou" e nenhum
// "Editou". É exatamente o registro que a clínica consulta pra entender por que
// o valor de um atendimento mudou.

const { test } = require('node:test');
const assert = require('node:assert');
const { fonte, recortarFuncao } = require('./_extrair.js');

// Recorta o trecho da função que vem DEPOIS do primeiro closeModal.
function depoisDoCloseModal(nome) {
  const corpo = recortarFuncao(nome);
  const i = corpo.indexOf('closeModal(');
  assert.ok(i > 0, `${nome} deveria fechar o modal`);
  return corpo.slice(i);
}

for (const fn of ['savePaciente', 'saveDespesa']) {
  test(`${fn}: nada lê editState depois do closeModal`, () => {
    const depois = depoisDoCloseModal(fn).replace(/\/\/[^\n]*/g, '');
    assert.ok(!/\beditState\b/.test(depois),
      'o closeModal já zerou o editState — ler dali sempre devolve o estado limpo');
  });

  test(`${fn}: o histórico distingue edição de criação`, () => {
    const corpo = recortarFuncao(fn).replace(/\/\/[^\n]*/g, '');
    assert.match(corpo, /const foiEdicao = \w+ >= 0/,
      'o sinal tem de ser capturado no ramo que a função realmente tomou');
    assert.match(corpo, /_auditLog\(foiEdicao \? 'editou' : 'criou'/);
    // E capturado ANTES do closeModal, senão o problema volta.
    assert.ok(corpo.indexOf('const foiEdicao') < corpo.indexOf('closeModal('),
      'capturar depois do closeModal é o próprio bug');
  });
}

test('o sinal de edição vem do ramo tomado, não do editState', () => {
  // Se o registro que estava sendo editado sumiu (excluído em outro aparelho),
  // as duas funções caem no ramo de inserção — e aí foi criação MESMO. Ler
  // editState.idx diria "editou" para um registro que acabou de nascer.
  for (const fn of ['savePaciente', 'saveDespesa']) {
    const corpo = recortarFuncao(fn);
    assert.ok(!/_auditLog\(editState\./.test(corpo), fn);
  }
});

test('nenhuma outra tela monta o histórico a partir do editState', () => {
  const linhas = fonte.split('\n');
  const ruins = [];
  linhas.forEach((l, i) => {
    if (/_auditLog\([^)]*editState\./.test(l)) ruins.push((i + 1) + ': ' + l.trim().slice(0, 100));
  });
  assert.deepStrictEqual(ruins, [],
    'editState é limpo pelo closeModal: o histórico tem de sair do que a função fez');
});
