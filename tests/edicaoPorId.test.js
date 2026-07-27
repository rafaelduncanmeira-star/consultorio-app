// Edição/ação resolvida por ID, não por índice congelado — rode com: node --test
//
// O índice é calculado quando a lista é RENDERIZADA e usado quando a pessoa
// CLICA. Entre um e outro a coleção pode mudar: outra aba do app, o copiloto
// registrando um atendimento (que entra com unshift e desloca tudo), um pull.
// A partir daí o índice aponta pro registro de outro paciente.
//
// O saveCrm já resolvia por id, com o motivo escrito no código. As outras
// telas, não — e a pior era o modal de forma de pagamento, que congelava o
// índice num dataset do DOM enquanto esperava a pessoa escolher Pix ou Cartão.

const { test } = require('node:test');
const assert = require('node:assert');
const { carregar } = require('./_extrair.js');

function ambiente(pacientes) {
  const banco = { pacientes: JSON.parse(JSON.stringify(pacientes)) };
  const toasts = [];
  const modal = { style: {}, dataset: {} };
  const s = carregar(['_acharPacPorRef', 'updatePacStatus', 'openModalPagtoReal',
                      'confirmarPagtoReal'], {
    JSON, Array, Object, Math, String, parseInt, RegExp,
    DB: {
      get: () => JSON.parse(JSON.stringify(banco.pacientes)),
      set: (k, v) => { banco[k] = JSON.parse(JSON.stringify(v)); },
    },
    document: { getElementById: (id) => (id === 'modal-pgto-real' ? modal : null) },
    toast: (t) => toasts.push(t),
    BRL: (v) => 'R$ ' + v,
    renderPacientes: () => {}, renderDashboard: () => {},
  });
  return { ...s, banco, toasts, modal,
           inserirNoTopo: (p) => banco.pacientes.unshift(p) };
}

const ANA   = { id: 'pac_ana',   nome: 'Ana',   valor: 300, statusPgto: 'Pendente', pagamento: 'A receber' };
const BRUNO = { id: 'pac_bruno', nome: 'Bruno', valor: 900, statusPgto: 'Pendente', pagamento: 'Pix' };

test('updatePacStatus: marca o atendimento certo depois de a lista deslocar', () => {
  const a = ambiente([ANA, BRUNO]);
  // A tela renderizou com Ana no índice 0. Agora chega um atendimento novo pelo
  // topo — é exatamente o que savePaciente e o copiloto fazem (unshift).
  a.inserirNoTopo({ id: 'pac_novo', nome: 'Carla', valor: 100, statusPgto: 'Pendente', pagamento: 'Pix' });
  a.updatePacStatus('pac_ana', 'Isento');
  const porNome = Object.fromEntries(a.banco.pacientes.map(p => [p.nome, p.statusPgto]));
  assert.strictEqual(porNome['Ana'], 'Isento');
  assert.strictEqual(porNome['Carla'], 'Pendente', 'quem entrou no índice 0 não pode ser tocado');
  assert.strictEqual(porNome['Bruno'], 'Pendente');
});

test('updatePacStatus: registro que sumiu avisa em vez de lançar', () => {
  const a = ambiente([ANA]);
  a.banco.pacientes = [];
  assert.doesNotThrow(() => a.updatePacStatus('pac_ana', 'Pago'),
    'sem guarda, `entrada.pagamento` lançava — e o onchange do <select> engolia a exceção');
  assert.match(a.toasts.join(' '), /não está mais na lista/);
});

test('modal de forma de pagamento: confirma no paciente certo, não na posição', () => {
  const a = ambiente([ANA, BRUNO]);
  // Ana está "A receber" → o fluxo abre o modal e espera a escolha.
  a.updatePacStatus('pac_ana', 'Pago');
  assert.strictEqual(a.modal.dataset.ref, 'pac_ana', 'o dataset guarda o id, não a posição');
  assert.strictEqual(a.banco.pacientes[0].statusPgto, 'Pendente', 'ainda não gravou nada');

  // A pessoa demora escolhendo Pix ou Cartão. Nesse intervalo chega outro
  // atendimento pelo topo e a posição da Ana muda.
  a.inserirNoTopo({ id: 'pac_novo', nome: 'Carla', valor: 100, statusPgto: 'Pendente', pagamento: 'Pix' });
  a.confirmarPagtoReal('Pix');

  const porNome = Object.fromEntries(a.banco.pacientes.map(p => [p.nome, p]));
  assert.strictEqual(porNome['Ana'].statusPgto, 'Pago');
  assert.strictEqual(porNome['Ana'].pagamento, 'Pix');
  assert.strictEqual(porNome['Carla'].statusPgto, 'Pendente',
    'com o índice congelado, era a Carla que virava Paga — e com a forma de pagamento trocada');
  assert.strictEqual(porNome['Carla'].pagamento, 'Pix');
});

test('modal de forma de pagamento: alvo excluído não grava em ninguém', () => {
  const a = ambiente([ANA, BRUNO]);
  a.updatePacStatus('pac_ana', 'Pago');
  a.banco.pacientes = [BRUNO];        // Ana foi excluída em outro aparelho
  assert.doesNotThrow(() => a.confirmarPagtoReal('Cartão'));
  assert.strictEqual(a.banco.pacientes[0].statusPgto, 'Pendente', 'o Bruno não pode herdar o pagamento');
  assert.match(a.toasts.join(' '), /Nada foi alterado/);
});

test('_acharPacPorRef: aceita id e, pra registro legado, o índice', () => {
  const { _acharPacPorRef } = ambiente([ANA, BRUNO]);
  const data = [ANA, BRUNO];
  assert.strictEqual(_acharPacPorRef(data, 'pac_bruno'), 1);
  assert.strictEqual(_acharPacPorRef(data, 0), 0, 'índice é a reserva pra registro sem id');
  assert.strictEqual(_acharPacPorRef(data, 'pac_sumiu'), -1);
  assert.strictEqual(_acharPacPorRef(data, 9), -1, 'índice fora da faixa não pode virar 0');
});

// As telas precisam PASSAR o id — resolver por id não adianta se o HTML
// continuar carimbando a posição no onclick.
test('as telas de atendimentos passam o id nos botões, não o índice', () => {
  const { fonte } = require('./_extrair.js');
  const semCom = fonte.replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(semCom, /editRow\('pacientes',\$\{i(dx)?\}\)/,
    'índice congelado no HTML aponta pro registro errado assim que a lista muda');
  assert.doesNotMatch(semCom, /deleteRow\('pacientes',\$\{i(dx)?\}\)/);
  assert.doesNotMatch(semCom, /pgtoSelect\([^,]+,\s*i(dx)?\)/);
});
