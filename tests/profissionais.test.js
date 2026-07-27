// Select de profissional — rode com: node --test
//
// A lista de escolha traz só os ATIVOS, e isso está certo: ninguém deve
// atribuir trabalho novo a quem saiu da clínica. Mas o registro antigo continua
// sendo dele. Sem uma <option> pra ele, `sel.value = <id inativo>` não achava
// nada, o select ficava com selectedIndex -1 e o save gravava outra coisa:
//   · onde existe "— não atribuído —" (CRM), o vínculo era APAGADO;
//   · onde não existe (atendimento, agenda), caía no primeiro ativo e o
//     registro era TRANSFERIDO pra outro profissional.
// O segundo é o pior: abrir um atendimento antigo do médico que saiu, só pra
// corrigir uma observação, movia a receita e o repasse dele pra outra pessoa —
// e o profissional_id é também o que o RLS usa pra decidir quem enxerga a linha.

const { test } = require('node:test');
const assert = require('node:assert');
const { carregar } = require('./_extrair.js');

function selectFalso() {
  const el = { innerHTML: '', value: '' };
  Object.defineProperty(el, 'options', {
    get: () => [...String(el.innerHTML).matchAll(/<option value="([^"]*)"/g)]
      .map(m => ({ value: m[1] })),
  });
  // Espelha o navegador: atribuir valor que não existe entre as options deixa
  // o select "vazio" (selectedIndex -1), e é daí que sai o '' do FormData.
  let val = '';
  Object.defineProperty(el, 'value', {
    get: () => val,
    set: (v) => { val = el.options.some(o => o.value === String(v)) ? String(v) : ''; },
  });
  return el;
}

function ambiente(profs) {
  const sel = selectFalso();
  const s = carregar(['_esc', 'getProfissionaisAtivos', 'getProfissional', '_popularProfissionalSelect'], {
    String, Array, Object,
    document: { getElementById: () => sel },
    getProfissionais: () => profs,
  });
  return { sel, popular: s._popularProfissionalSelect };
}

const PROFS = [
  { id: 'prof_a', nome: 'Dra. Ana', ativo: true },
  { id: 'prof_b', nome: 'Dr. Bruno', ativo: false },   // saiu da clínica
];

test('registro do profissional inativo NÃO é transferido pro primeiro ativo', () => {
  const a = ambiente(PROFS);
  a.popular('prof_b', 'pac-profissional');   // sem "não atribuído"
  assert.strictEqual(a.sel.value, 'prof_b',
    'cair no profs[0] move a receita e o repasse do atendimento pra outra pessoa');
  assert.match(a.sel.innerHTML, /Dr\. Bruno \(inativo\)/, 'e a tela tem de dizer que ele está inativo');
});

test('registro do profissional inativo NÃO tem o vínculo apagado', () => {
  const a = ambiente(PROFS);
  a.popular('prof_b', 'crm-profissional', true);   // com "não atribuído"
  assert.strictEqual(a.sel.value, 'prof_b');
});

test('profissional removido de vez ainda preserva o id gravado', () => {
  const a = ambiente(PROFS);
  a.popular('prof_sumiu', 'pac-profissional');
  assert.strictEqual(a.sel.value, 'prof_sumiu',
    'perder o id é perder quem atendeu; melhor mostrar que o cadastro sumiu');
  assert.match(a.sel.innerHTML, /profissional removido/);
});

test('profissional ativo continua selecionado normalmente', () => {
  const a = ambiente(PROFS);
  a.popular('prof_a', 'pac-profissional');
  assert.strictEqual(a.sel.value, 'prof_a');
  assert.ok(!/inativo/.test(a.sel.innerHTML), 'não inventa opção quando não precisa');
});

test('registro novo sem profissional cai no primeiro ativo, como antes', () => {
  const a = ambiente(PROFS);
  a.popular(null, 'pac-profissional');
  assert.strictEqual(a.sel.value, 'prof_a');
});

test('registro novo sem profissional, onde é permitido, fica sem atribuição', () => {
  const a = ambiente(PROFS);
  a.popular(null, 'crm-profissional', true);
  assert.strictEqual(a.sel.value, '');
});

test('sem nenhum profissional ativo o select não inventa vínculo', () => {
  const a = ambiente([{ id: 'prof_b', nome: 'Dr. Bruno', ativo: false }]);
  a.popular(null, 'pac-profissional');
  assert.strictEqual(a.sel.value, '');
  assert.match(a.sel.innerHTML, /cadastre em Configurações/);
});
