// Testes de programas/inscrições — rode com: node --test
//
// O elo marco → follow-up era um ÍNDICE gravado em disco (`followupIdx`). O
// array de follow-ups é substituído inteiro pelo pull, na ordem que o servidor
// devolve, e recompactado por qualquer exclusão. Registrar o marco marcava como
// feito o follow-up de outro paciente.

const { test } = require('node:test');
const assert = require('node:assert');
const { carregar, fonte, recortarFuncao } = require('./_extrair.js');

// Monta registrarMarco num sandbox com um "banco" em memória.
function montar(estado) {
  const banco = JSON.parse(JSON.stringify(estado));
  const s = carregar('registrarMarco', {
    JSON, Array, Object, Date, Math, console,
    DB: {
      get: (k) => JSON.parse(JSON.stringify(banco[k] || [])),
      set: (k, v) => { banco[k] = JSON.parse(JSON.stringify(v)); },
    },
    getProgramas: () => banco.programas || [],
    _ymd: () => '2026-07-27',
    _addDaysIso: (iso, n) => {
      const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n);
      return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    },
    _novoId: (p) => p + '_novo',
    _agId: () => 'ag_novo',
  });
  return { registrarMarco: s.registrarMarco, banco };
}

// Cenário: dois pacientes, dois follow-ups de programa. O follow-up do paciente
// A é o índice 0 na criação. Depois vem um pull e o servidor devolve na ordem
// inversa — o índice 0 passa a ser o do paciente B.
const cenario = (registro) => ({
  programas: [{ id: 'p1', tipo: 'Fixo', nome: 'Pós-op' }],
  inscricoes: [{
    id: 'ins_A', programaId: 'p1', pacienteNome: 'Ana',
    registros: [registro],
  }],
  followup: [
    // ordem do servidor: o de Bruno primeiro
    { id: 'fu_B', nome: 'Bruno', feito: false, programaInscricaoId: 'ins_B', marcoIdx: 0 },
    { id: 'fu_A', nome: 'Ana',   feito: false, programaInscricaoId: 'ins_A', marcoIdx: 0 },
  ],
  agendamentos: [],
});

test('registrarMarco: marca o follow-up do paciente certo depois de o pull reordenar', () => {
  const { registrarMarco, banco } = montar(cenario(
    { marcoIdx: 0, dataPrevista: '2026-07-20', dataReal: null, agendamentoId: null, followupId: 'fu_A' }
  ));
  registrarMarco('ins_A', 0);
  const porNome = Object.fromEntries(banco.followup.map(f => [f.nome, f.feito]));
  assert.strictEqual(porNome['Ana'], true, 'o follow-up da Ana é que tinha de ser marcado');
  assert.strictEqual(porNome['Bruno'], false, 'o do Bruno não pode ser tocado');
});

test('registrarMarco: inscrição antiga (só followupIdx) ainda encontra pelo par inscrição+marco', () => {
  // Registro no formato antigo: nenhum followupId, só o índice — que aqui
  // aponta pro Bruno depois da reordenação.
  const { registrarMarco, banco } = montar(cenario(
    { marcoIdx: 0, dataPrevista: '2026-07-20', dataReal: null, agendamentoId: null, followupIdx: 0 }
  ));
  registrarMarco('ins_A', 0);
  const porNome = Object.fromEntries(banco.followup.map(f => [f.nome, f.feito]));
  assert.strictEqual(porNome['Ana'], true, 'dado antigo tem de continuar funcionando');
  assert.strictEqual(porNome['Bruno'], false);
});

test('registrarMarco: sem follow-up correspondente não estraga nada', () => {
  const { registrarMarco, banco } = montar({
    programas: [{ id: 'p1', tipo: 'Fixo', nome: 'Pós-op' }],
    inscricoes: [{ id: 'ins_A', programaId: 'p1', pacienteNome: 'Ana',
                   registros: [{ marcoIdx: 0, dataReal: null, followupId: 'fu_sumiu' }] }],
    followup: [{ id: 'fu_B', nome: 'Bruno', feito: false, programaInscricaoId: 'ins_B', marcoIdx: 0 }],
    agendamentos: [],
  });
  registrarMarco('ins_A', 0);
  assert.strictEqual(banco.followup[0].feito, false, 'não pode marcar um follow-up alheio no chute');
  assert.strictEqual(banco.inscricoes[0].registros[0].dataReal, '2026-07-27', 'o marco em si foi registrado');
});

// Guarda contra reintrodução: nenhum ponto do código pode voltar a indexar o
// array de follow-ups por um número guardado.
test('nada indexa o array de follow-ups por índice gravado', () => {
  const semCom = fonte.replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(semCom, /followupIdx/,
    'índice gravado em disco não sobrevive ao pull nem a uma exclusão — use followupId');
});

test('os dois pontos que criam registro de marco gravam followupId', () => {
  for (const fn of ['inscreverEmPrograma', 'registrarMarco']) {
    const src = recortarFuncao(fn).replace(/\/\/[^\n]*/g, '');
    assert.match(src, /followupId:\s*fu\w*\.id/, `${fn} tem de guardar o id do follow-up`);
  }
});

// ---------- "já virou atendimento?" não pode confundir índice 0 com "não" ----------
// O atendimento novo entra na coleção com unshift, ou seja, no índice 0. A
// conversão gravava `a.pacIdx = 0` — falsy. A checagem `!a.pacIdx` lia isso
// como "nunca converteu" e reoferecia registrar o atendimento a cada toque no
// agendamento; cada "sim" criava outro atendimento e inflava o faturamento.
test('_agVirouAtendimento: índice 0 é vínculo, não ausência de vínculo', () => {
  const { _agVirouAtendimento } = carregar('_agVirouAtendimento', {});
  assert.strictEqual(_agVirouAtendimento({ pacIdx: 0 }), true,
    'zero é o índice do atendimento recém-criado — o caso mais comum de todos');
  assert.strictEqual(_agVirouAtendimento({ pacId: 'pac_x' }), true);
  assert.strictEqual(_agVirouAtendimento({ pacId: 'pac_x', pacIdx: 0 }), true);
  assert.strictEqual(_agVirouAtendimento({ pacIdx: 7 }), true);
});

test('_agVirouAtendimento: sem vínculo nenhum continua sendo "não"', () => {
  const { _agVirouAtendimento } = carregar('_agVirouAtendimento', {});
  for (const a of [{}, { pacIdx: null }, { pacId: null, pacIdx: null },
                   { pacId: '', pacIdx: undefined }, null, undefined]) {
    assert.strictEqual(_agVirouAtendimento(a), false, JSON.stringify(a));
  }
});

test('a conversão grava pacId — é ele o sinal de que virou atendimento', () => {
  const src = recortarFuncao('savePaciente').replace(/\/\/[^\n]*/g, '');
  assert.match(src, /a\.pacId\s*=\s*item\.id/, 'sem isto o helper perde o sinal confiável');
  assert.match(src, /a\.status\s*=\s*'Compareceu'/);
});

test('nenhum ponto volta a testar o vínculo com o falsy do índice', () => {
  const semCom = fonte.replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(semCom, /!\s*\w+\.pacIdx\b/,
    'pacIdx 0 é vínculo válido — teste com != null ou use _agVirouAtendimento');
});

// ---------- lançamento de programa não pode depender de texto livre ----------
// Seis telas classificavam um atendimento como lançamento de programa
// procurando '[Programa' dentro de `obs` — campo de TEXTO LIVRE, editável no
// modal de atendimento. Bastava o médico abrir o lançamento pra anotar alguma
// coisa e apagar aquele colchete (que parece lixo) para a receita mudar de
// seção sozinha: sumia da seção Programas do Relatório, saía da linha
// "assinatura" do PDF e passava a contar duas vezes no breakdown por
// procedimento. Nada avisava.
test('_ehLancamentoPrograma: reconhece pelo campo, não só pelo texto', () => {
  const { _ehLancamentoPrograma } = carregar('_ehLancamentoPrograma', { String });
  assert.strictEqual(_ehLancamentoPrograma({ programaInscricaoId: 'ins_1', obs: '' }), true,
    'obs apagada não pode desclassificar o lançamento');
  assert.strictEqual(_ehLancamentoPrograma({ programaInscricaoId: 'ins_1', obs: 'paciente pediu recibo' }), true);
  assert.strictEqual(_ehLancamentoPrograma({ obs: '[Programa Assinatura]' }), true,
    'dado antigo, que só tem a marca no texto, continua valendo');
  assert.strictEqual(_ehLancamentoPrograma({ obs: '[Programa Assinatura — Renovação]' }), true);
});

test('_ehLancamentoPrograma: atendimento comum continua fora', () => {
  const { _ehLancamentoPrograma } = carregar('_ehLancamentoPrograma', { String });
  for (const p of [{}, { obs: '' }, { obs: 'consulta de rotina' }, null, undefined,
                   { programaInscricaoId: null, obs: 'nada' }]) {
    assert.strictEqual(_ehLancamentoPrograma(p), false, JSON.stringify(p));
  }
});

test('todo lançamento de programa carimba o vínculo', () => {
  const { recortarFuncao } = require('./_extrair.js');
  const inscr = recortarFuncao('inscreverEmPrograma').replace(/\/\/[^\n]*/g, '');
  // Quatro no total: os DOIS lançamentos financeiros (assinatura e fixo/contínuo)
  // mais o agendamento e o follow-up de cada marco, que já usavam o campo.
  assert.strictEqual((inscr.match(/programaInscricaoId: inscricao\.id/g) || []).length, 4);
  // O que importa aqui é que os dois `pacs.push` carimbam.
  const lancamentos = inscr.split('pacs.push(').slice(1)
    .map(t => t.slice(0, t.indexOf('});')));
  assert.strictEqual(lancamentos.length, 2, 'assinatura e fixo/contínuo');
  for (const l of lancamentos) {
    assert.match(l, /programaInscricaoId: inscricao\.id/,
      'lançamento financeiro sem o vínculo volta a depender do texto de obs');
  }
  const renov = recortarFuncao('saveRenovacao').replace(/\/\/[^\n]*/g, '');
  assert.match(renov, /programaInscricaoId: ins\.id/, 'a renovação também gera um lançamento');
});

test('nenhuma tela volta a classificar programa pelo texto de obs', () => {
  const semCom = fonte.replace(/\/\/[^\n]*/g, '');
  // O próprio _ehLancamentoPrograma contém essa leitura (é a reserva pro dado
  // antigo) — tira a função da varredura antes de procurar.
  const semHelper = semCom.replace(/function _ehLancamentoPrograma[\s\S]*?\n}/, '');
  const crus = [...semHelper.matchAll(/\(p\.obs\s*\|\|\s*''\)\.includes\('\[Programa'\)/g)];
  assert.deepStrictEqual(crus.map(m => m[0]), [],
    'obs é editável pelo médico — o vínculo tem de ser campo');
});

// ---------- o aviso de renovação tem de olhar o VENCIMENTO ----------
// O cronograma de assinatura nasce em duas situações e elas não são iguais:
//   · criarInscricao passa (dataInicio, dataInicio + vigência) — os dois batem;
//   · saveRenovacao passa (HOJE, vencimentoAntigo + vigência) — não batem.
// Ancorar o "Renovar" em dataInicio + vigência só acerta o primeiro caso. Quem
// renova 60 dias antes de vencer — o normal, porque se renova quando se fala
// com o paciente — recebia o aviso 90 dias antes do vencimento real, e o desvio
// se acumulava a cada ciclo. Quem renovava atrasado ficava sem antecedência
// nenhuma.
function cronograma(inicio, fim, vigencia = 'Anual') {
  const { _gerarCronogramaFollowups } = carregar(
    ['_ymd', '_addDaysIso', '_vigenciaDias', '_novoId', '_gerarCronogramaFollowups'],
    { Date, Math, String });
  return _gerarCronogramaFollowups(
    { id: 'ins1', pacienteNome: 'Ana', profissionalId: null },
    { tipo: 'Assinatura', nome: 'Compagni', vigencia },
    inicio, fim);
}
const renovar = (fus) => fus.find(f => f.obs.startsWith('Renovar'));

test('assinatura nova: o "Renovar" cai 30 dias antes do vencimento', () => {
  const fus = cronograma('2026-01-01', '2027-01-01');
  assert.strictEqual(renovar(fus).dataContato, '2026-12-02');
});

test('renovação antecipada: o "Renovar" continua colado no vencimento novo', () => {
  // Vencia em 2026-03-01; renovou 60 dias antes (2026-01-01).
  // Novo vencimento = 2027-03-01, então o aviso é 2027-01-30 — não 2026-12-02.
  const fus = cronograma('2026-01-01', '2027-03-01');
  assert.strictEqual(renovar(fus).dataContato, '2027-01-30',
    'ancorar em dataInicio+vigência avisaria 90 dias cedo demais');
});

test('renovação atrasada ainda deixa o aviso dentro do período', () => {
  // Venceu e só renovou depois: o novo vencimento está a menos de 30 dias.
  const fus = cronograma('2026-01-01', '2026-01-20');
  assert.strictEqual(renovar(fus).dataContato, '2026-01-01',
    'aviso já vencido vale HOJE — descartar deixaria a renovação sem lembrete');
});

test('o "Renovar" nunca é descartado por cair fora da janela', () => {
  for (const vig of ['Mensal', 'Trimestral', 'Semestral', 'Anual']) {
    const fus = cronograma('2026-01-01', '2026-01-10', vig);
    assert.ok(renovar(fus), `${vig}: sem o aviso, a assinatura vence em silêncio`);
  }
});

test('os check-ins continuam ancorados no início do período', () => {
  const fus = cronograma('2026-01-01', '2027-03-01');
  const boasVindas = fus.find(f => f.obs.startsWith('Boas-vindas'));
  assert.strictEqual(boasVindas.dataContato, '2026-01-08');
});

// ---------- o formulário de programa não pode carregar campo do anterior ----------
// A vigência mora dentro do bloco #tpl-assinatura-wrap, que só aparece quando o
// tipo é Assinatura — e ela só era reatribuída no ramo "editando uma
// Assinatura". Criar um programa logo depois de editar outro reabria o
// formulário com a vigência do anterior. E vigência define _vigenciaDias: o
// vencimento de toda inscrição, o aviso de renovação e o MRR. Um programa anual
// salvo como Mensal vence em 30 dias e cobra renovação no primeiro mês.
function abrirTemplate(programa) {
  const campos = {};
  const els = {};
  const el = (id) => (els[id] || (els[id] = { id, value: '', style: {}, textContent: '', placeholder: '' }));
  const { recortarFuncao } = require('./_extrair.js');
  const vm = require('node:vm');
  const corpo = recortarFuncao('openModalTemplatePrograma');
  const s = carregar([], {
    document: { getElementById: (id) => el(id), querySelector: () => null },
    getProgramas: () => (programa ? [programa] : []),
    _marcoBuffer: [], _camposBuffer: [], _beneficiosBuffer: [], _parcelasBuffer: [],
    _atualizarTipoPrograma: () => {}, _renderMarcoBuffer: () => {},
    _renderCamposBuffer: () => {}, _renderBeneficiosBuffer: () => {},
    _renderParcelasBuffer: () => {}, openModal: () => {},
    Array, Object, String,
  });
  vm.runInContext(corpo + '\nglobalThis.__abrir = openModalTemplatePrograma;', s, { filename: 'recorte' });
  s.__abrir(programa ? programa.id : null);
  Object.keys(els).forEach(k => { campos[k] = els[k].value; });
  return campos;
}

test('programa novo não herda a vigência do que foi editado antes', () => {
  const campos = abrirTemplate(null);
  assert.strictEqual(campos['tpl-vigencia'], 'Anual',
    'vigência define vencimento, aviso de renovação e MRR — herdar a do anterior erra os três');
});

test('programa novo não herda consulta avulsa nem políticas', () => {
  const campos = abrirTemplate(null);
  assert.strictEqual(campos['tpl-consulta-avulsa'], '');
  assert.strictEqual(campos['tpl-politicas'], '');
});

test('editar uma Assinatura carrega os campos dela', () => {
  const campos = abrirTemplate({ id: 'pg1', nome: 'X', tipo: 'Assinatura',
                                 vigencia: 'Trimestral', consultaAvulsa: 300, politicas: 'texto' });
  assert.strictEqual(campos['tpl-vigencia'], 'Trimestral');
  assert.strictEqual(campos['tpl-consulta-avulsa'], 300);
  assert.strictEqual(campos['tpl-politicas'], 'texto');
});

test('editar um programa Fixo zera os campos de Assinatura', () => {
  const campos = abrirTemplate({ id: 'pg2', nome: 'Y', tipo: 'Fixo' });
  assert.strictEqual(campos['tpl-vigencia'], 'Anual');
  assert.strictEqual(campos['tpl-consulta-avulsa'], '');
  assert.strictEqual(campos['tpl-politicas'], '');
});

test('todo campo que o save lê é inicializado ao abrir o formulário', () => {
  // Rede a mais, não a que pegou a vigência: esta acusa campo que o opener NÃO
  // TOCA em lugar nenhum. A vigência era tocada, só que dentro de um ramo — o
  // caso condicional é coberto pelos testes de comportamento acima, que são os
  // que reprovam a versão antiga.
  const { recortarFuncao } = require('./_extrair.js');
  const save  = recortarFuncao('saveTemplatePrograma');
  const abrir = recortarFuncao('openModalTemplatePrograma');
  const lidos = new Set([...save.matchAll(/fd\.get\('(\w+)'\)/g)].map(m => m[1]));
  // name= no HTML → id= no JS; o mapa cobre só onde os dois diferem.
  const idDoCampo = { programaId: 'tpl-id', precoAVista: 'tpl-preco-avista',
                      consultaAvulsa: 'tpl-consulta-avulsa', intervaloDias: 'tpl-intervalo' };
  const faltando = [...lidos].filter(nome => {
    const id = idDoCampo[nome] || ('tpl-' + nome);
    return !abrir.includes(`'${id}'`);
  });
  assert.deepStrictEqual(faltando, [],
    'campo lido no save e não inicializado ao abrir carrega o valor do programa anterior');
});
