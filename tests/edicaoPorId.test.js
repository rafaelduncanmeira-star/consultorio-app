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

// ---------- mesma regra no Follow-up ----------
function ambienteFu(followup) {
  const banco = { followup: JSON.parse(JSON.stringify(followup)) };
  const toasts = [];
  const s = carregar(['_acharFuPorRef', 'toggleFollowupFeito'], {
    JSON, Array, Object,
    DB: {
      get: () => JSON.parse(JSON.stringify(banco.followup)),
      set: (k, v) => { banco[k] = JSON.parse(JSON.stringify(v)); },
    },
    toast: (t) => toasts.push(t),
    renderFollowup: () => {},
  });
  return { ...s, banco, toasts };
}

test('toggleFollowupFeito: marca o follow-up certo depois de a lista deslocar', () => {
  const a = ambienteFu([
    { id: 'fu_ana', nome: 'Ana', feito: false },
    { id: 'fu_bruno', nome: 'Bruno', feito: false },
  ]);
  // criar_followup pelo copiloto entra com unshift e desloca todos os índices.
  a.banco.followup.unshift({ id: 'fu_novo', nome: 'Carla', feito: false });
  a.toggleFollowupFeito('fu_ana');
  const porNome = Object.fromEntries(a.banco.followup.map(f => [f.nome, f.feito]));
  assert.strictEqual(porNome['Ana'], true);
  assert.strictEqual(porNome['Carla'], false, 'quem entrou no topo não pode ser marcado');
});

test('toggleFollowupFeito: registro que sumiu avisa em vez de lançar', () => {
  const a = ambienteFu([{ id: 'fu_ana', nome: 'Ana', feito: false }]);
  a.banco.followup = [];
  assert.doesNotThrow(() => a.toggleFollowupFeito('fu_ana'),
    'o onchange do checkbox engole a exceção: marcava na tela e não gravava nada');
  assert.match(a.toasts.join(' '), /não está mais na lista/);
});

test('a tela de follow-up passa o id nos botões, não o índice', () => {
  const { fonte } = require('./_extrair.js');
  const semCom = fonte.replace(/\/\/[^\n]*/g, '');
  for (const re of [/editRow\('followup',\$\{i\}\)/, /deleteRow\('followup',\$\{i\}\)/,
                    /toggleFollowupFeito\(\$\{i\}\)/, /_openWhatsAppForFu\(\$\{i\}\)/]) {
    assert.doesNotMatch(semCom, re, 'índice congelado no HTML aponta pro registro errado');
  }
});

// Varredura final da classe: nenhuma tela pode carimbar índice no onclick de
// coleção que tem id estável. Procedimentos são a exceção declarada — são
// chaveados por NOME (o seed nem tem id), então id ali não resolveria nada.
test('nenhuma coleção com id estável usa índice no onclick', () => {
  const { fonte } = require('./_extrair.js');
  const semCom = fonte.replace(/\/\/[^\n]*/g, '');
  const achados = [];
  for (const m of semCom.matchAll(/on(?:click|change)="(\w+)\((?:'([a-z]+)',)?\$\{(i|idx|localI)\}/g)) {
    const [, fn, col] = m;
    if (fn === 'editProc' || fn === 'deleteProc') continue; // chaveados por nome
    if (fn === '_kanbanScrollTo') continue;                 // posição de scroll, não registro
    achados.push(col ? `${fn}('${col}')` : fn);
  }
  assert.deepStrictEqual([...new Set(achados)].sort(), []);
});

// ---------- dispensar o modal clicando fora tem de limpar o estado ----------
// O closeModal reseta o formulário, o título e o editState. O handler de
// "clicar fora" só escondia o elemento, então tudo isso ficava para trás.
// Cenário: o médico abre ✏️ num atendimento, desiste e dispensa clicando fora
// (gesto que o app oferece de propósito). Depois clica em "+ Novo
// Atendimento" — o openModal não reseta nada. O modal reabre com os dados do
// paciente anterior, o título ainda diz "Editar Consulta", e o savePaciente
// continua enxergando editState.id: salvar SUBSTITUI o atendimento antigo em
// vez de criar um novo. O antigo some, e com ele a receita dele no mês.
test('clicar fora do modal passa pelo closeModal, não esconde na mão', () => {
  const { fonte } = require('./_extrair.js');
  const i = fonte.indexOf('Fecha modais ao clicar fora');
  assert.ok(i > 0, 'o handler de clicar fora tem de existir');
  // O bloco tem um comentário longo explicando o caso; corta no fim do forEach.
  const bloco = fonte.slice(i);
  const trecho = bloco.slice(0, bloco.indexOf('\n  });') + 6);
  assert.match(trecho, /closeModal\(el\.id\)/,
    'esconder o elemento na mão deixa editState apontando pro registro editado');
});

test('closeModal limpa o editState — é o que impede o save de virar update', () => {
  const s = carregar('closeModal', {
    document: {
      getElementById: () => ({ style: {} }),
      querySelector: () => null,
    },
    editState: { col: 'pacientes', idx: 3, id: 'pac_1' },
  });
  s.closeModal('modal-paciente');
  assert.strictEqual(s.editState.col, null);
  assert.strictEqual(s.editState.id, undefined,
    'sobrar id aqui faz o próximo "+ Novo Atendimento" gravar por cima do antigo');
});

test('o valor sugerido não trata o índice 0 como "sem edição"', () => {
  const { fonte } = require('./_extrair.js');
  assert.ok(!/if \(vEl && !editState\.idx/.test(fonte),
    'atendimento novo entra com unshift: o registro editado costuma ser o índice 0');
});
