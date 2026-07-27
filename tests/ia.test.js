// Testes da Secretária por IA (copiloto) — rode com: node --test
// Exercitam o código REAL recortado do app.js.

const { test } = require('node:test');
const assert = require('node:assert');
const { carregar } = require('./_extrair.js');

// ---------- _acharCrmPorNome: casar paciente com card do CRM ----------
// O copiloto usa isso pra mover o card quando agenda alguém. Duas armadilhas
// que estavam no código: `'x'.includes('')` é sempre true (contato sem nome
// casava com QUALQUER paciente e, por vir no topo do array, era o escolhido),
// e substring curta casa demais ("Ana" bate dentro de "Mariana").
const CRM = [
  { nome: '',              status: 'Lead' },   // contato sem nome
  { nome: 'Ana',           status: 'Lead' },
  { nome: 'Mariana Souza', status: 'Lead' },
  { nome: 'Bruno Alves',   status: 'Lead' },
];

test('_acharCrmPorNome: contato sem nome não casa com todo mundo', () => {
  const { _acharCrmPorNome } = carregar(['_nomeNorm', '_nomeCasaParcial', '_acharPorNome', '_acharCrmPorNome']);
  assert.strictEqual(_acharCrmPorNome(CRM, 'Carla Mendes'), -1,
    'Carla não está no CRM — o card vazio não pode ser marcado no lugar dela');
  assert.strictEqual(_acharCrmPorNome(CRM, 'Bruno Alves'), 3, 'e quem existe continua achando');
});

test('_acharCrmPorNome: nome idêntico ganha do parcial', () => {
  const { _acharCrmPorNome } = carregar(['_nomeNorm', '_nomeCasaParcial', '_acharPorNome', '_acharCrmPorNome']);
  assert.strictEqual(_acharCrmPorNome(CRM, 'Ana'), 1, 'exato vence "Mariana Souza"');
  assert.strictEqual(_acharCrmPorNome(CRM, '  aNa  '), 1, 'ignora caixa e espaço');
});

test('_acharCrmPorNome: parcial ambíguo devolve -1 em vez de chutar', () => {
  const { _acharCrmPorNome } = carregar(['_nomeNorm', '_nomeCasaParcial', '_acharPorNome', '_acharCrmPorNome']);
  const dois = [{ nome: 'Ana Paula' }, { nome: 'Ana Clara' }];
  assert.strictEqual(_acharCrmPorNome(dois, 'Ana'), -1,
    'escrever no contato errado é pior do que não escrever');
  assert.strictEqual(_acharCrmPorNome(dois, 'Ana Clara'), 1, 'com o nome inteiro, resolve');
});

test('_acharCrmPorNome: parcial único ainda funciona (sobrenome a mais)', () => {
  const { _acharCrmPorNome } = carregar(['_nomeNorm', '_nomeCasaParcial', '_acharPorNome', '_acharCrmPorNome']);
  assert.strictEqual(_acharCrmPorNome([{ nome: 'Bruno Alves' }], 'Bruno Alves Silva'), 0);
});

// "Ana" é substring de "Mariana", mas ninguém olhando a tela acharia que os
// dois nomes colidem. O casamento é por palavra inteira justamente pra isso.
test('_acharCrmPorNome: parcial casa por palavra, não por pedaço de palavra', () => {
  const { _acharCrmPorNome } = carregar(['_nomeNorm', '_nomeCasaParcial', '_acharPorNome', '_acharCrmPorNome']);
  assert.strictEqual(_acharCrmPorNome(CRM, 'Mariana'), 2,
    '"Ana" não pode disputar com "Mariana Souza"');
  assert.strictEqual(_acharCrmPorNome([{ nome: 'Ana' }], 'Mariana'), -1,
    'e no isolamento também não casa');
  assert.strictEqual(_acharCrmPorNome([{ nome: 'Ana Paula Souza' }], 'Paula'), 0,
    'palavra do meio conta');
});

// _acharPorNome com filtro é o que cancelar_agendamento e mover_agendamento
// usam. Antes era findIndex com includes(alvo): nome vazio (o LLM esquecendo de
// mandar) casava com o PRIMEIRO agendamento ativo da lista — e o copiloto
// cancelava ou movia a consulta de um paciente aleatório, avisando "feito" com
// o nome errado.
const AGS = [
  { pacienteNome: 'Ana Paula',   data: '2026-08-03', status: 'Confirmado' },
  { pacienteNome: 'Bruno Alves', data: '2026-08-04', status: 'Confirmado' },
  { pacienteNome: 'Bruno Alves', data: '2026-08-10', status: 'Cancelado' },
];

test('_acharPorNome: sem nome não cancela a consulta de um estranho', () => {
  const { _acharPorNome } = carregar(['_nomeNorm', '_nomeCasaParcial', '_acharPorNome']);
  for (const vazio of ['', null, undefined, '   ']) {
    assert.strictEqual(_acharPorNome(AGS, vazio, 'pacienteNome', a => a.status !== 'Cancelado'), -1,
      `nome ${JSON.stringify(vazio)} não pode casar com o primeiro da agenda`);
  }
});

test('_acharPorNome: o filtro exclui cancelado antes de decidir', () => {
  const { _acharPorNome } = carregar(['_nomeNorm', '_nomeCasaParcial', '_acharPorNome']);
  const ativo = a => a.status !== 'Cancelado';
  assert.strictEqual(_acharPorNome(AGS, 'Bruno Alves', 'pacienteNome', ativo), 1,
    'sem o filtro, os dois Bruno seriam ambíguos e nada seria cancelado');
  assert.strictEqual(_acharPorNome(AGS, 'Ana Paula', 'pacienteNome', ativo), 0);
});

// Homônimo exato é dúvida igual: "cancela a da Ana" com duas consultas da Ana
// não pode ser resolvido pela ordem do array, que não significa nada pro
// usuário — nem por data mais próxima, que ele não pediu.
test('_acharPorNome: dois registros com o MESMO nome exato devolvem -1', () => {
  const { _acharPorNome } = carregar(['_nomeNorm', '_nomeCasaParcial', '_acharPorNome']);
  const homonimos = [{ nome: 'Ana Paula' }, { nome: 'Ana Paula' }];
  assert.strictEqual(_acharPorNome(homonimos, 'Ana Paula', 'nome'), -1);
  assert.strictEqual(_acharPorNome([{ nome: 'Ana Paula' }], 'Ana Paula', 'nome'), 0,
    'um só continua resolvendo');
});

test('_acharPorNome: filtro por data separa dois agendamentos do mesmo paciente', () => {
  const { _acharPorNome } = carregar(['_nomeNorm', '_nomeCasaParcial', '_acharPorNome']);
  const dois = [
    { pacienteNome: 'Ana', data: '2026-08-03', status: 'Confirmado' },
    { pacienteNome: 'Ana', data: '2026-08-09', status: 'Confirmado' },
  ];
  const ativo = a => a.status !== 'Cancelado';
  assert.strictEqual(_acharPorNome(dois, 'Ana', 'pacienteNome', ativo), -1, 'sem data, ambíguo');
  assert.strictEqual(
    _acharPorNome(dois, 'Ana', 'pacienteNome', a => ativo(a) && a.data === '2026-08-09'), 1);
});

test('_acharCrmPorNome: busca vazia, lista vazia e nome curto não casam nada', () => {
  const { _acharCrmPorNome } = carregar(['_nomeNorm', '_nomeCasaParcial', '_acharPorNome', '_acharCrmPorNome']);
  for (const vazio of ['', null, undefined, '   ']) {
    assert.strictEqual(_acharCrmPorNome(CRM, vazio), -1);
  }
  assert.strictEqual(_acharCrmPorNome(null, 'Ana'), -1);
  assert.strictEqual(_acharCrmPorNome([{ nome: 'Ana Paula' }], 'An'), -1,
    'duas letras casariam com meio CRM');
});

// ---------- _iaHistoricoToMessages: mapeia papéis p/ o LLM ----------
test('histórico vira mensagens com role correto', () => {
  const { _iaHistoricoToMessages } = carregar('_iaHistoricoToMessages');
  const out = _iaHistoricoToMessages([
    { remetente: 'contato',     mensagem: 'Oi, quanto é a consulta?' },
    { remetente: 'consultorio', mensagem: 'Olá! É R$1000.' },
  ]);
  // JSON normaliza protótipos (out vem do sandbox vm, de outro realm)
  assert.deepStrictEqual(JSON.parse(JSON.stringify(out)), [
    { role: 'user',      content: 'Oi, quanto é a consulta?' },
    { role: 'assistant', content: 'Olá! É R$1000.' },
  ]);
});

// ---------- _iaMontarSystemPrompt: cérebro + guardrails ----------
function carregarPrompt(iaCfg) {
  const DB = {
    getObj: (k, def) => ({
      clinica_config: { nome: 'Clínica Teste' },
      ia_config: iaCfg,
      agenda_config: { horaInicio: '08:00', horaFim: '18:00', diasUteis: [1, 2, 3, 4, 5] },
    }[k] ?? def),
  };
  return carregar(['getIaConfig', 'const:AG_CONFIG_PADRAO', 'getAgConfig', '_ymd', '_iaMontarSystemPrompt'], {
    DB, Array, Object,
    BRL: (v) => 'R$' + v,
    getProcedimentos: () => [
      { nome: 'Consulta', valorPix: 1000, valorCartao: 1050, obs: '' },
      { nome: 'Retorno',  valorPix: 0,    valorCartao: 0,    obs: 'Defina' }, // sem preço → fora
    ],
    getProgramas: () => [],
  });
}

test('prompt traz nome da clínica, procedimentos com preço e horário', () => {
  const { _iaMontarSystemPrompt } = carregarPrompt({ enabled: true, tom: '', instrucoes: '' });
  const p = _iaMontarSystemPrompt();
  assert.match(p, /Clínica Teste/);
  assert.match(p, /Consulta: PIX\/dinheiro R\$1000 · cartão R\$1050/);
  assert.doesNotMatch(p, /Retorno/);              // procedimento sem valor não entra
  assert.match(p, /08:00 às 18:00/);
});

test('prompt SEMPRE contém o guardrail de não dar conselho médico', () => {
  const { _iaMontarSystemPrompt } = carregarPrompt({ enabled: true, tom: '', instrucoes: '' });
  assert.match(_iaMontarSystemPrompt(), /NUNCA dê conselho, diagnóstico ou orientação médica/i);
});

// A regra de agendamento agora acompanha a configuração — e, sobretudo, tem de
// ser a MESMA que o wa-webhook manda (é ele que roda). O preview mostrava
// "não confirme" mesmo com o agendamento ligado, e o servidor não dizia nada
// sobre agendar quando estava desligado. Ver tests/webhook.test.js.
test('prompt: com agendamento desligado (padrão), proíbe dizer que marcou', () => {
  const { _iaMontarSystemPrompt } = carregarPrompt({ enabled: true, agendar: false, tom: '', instrucoes: '' });
  const p = _iaMontarSystemPrompt();
  assert.match(p, /NÃO marca consultas/i);
  assert.match(p, /NUNCA diga que agendou/i);
});

test('prompt: com agendamento ligado, o preview para de proibir o que a IA faz', () => {
  const { _iaMontarSystemPrompt } = carregarPrompt({ enabled: true, agendar: true, tom: '', instrucoes: '' });
  const p = _iaMontarSystemPrompt();
  assert.match(p, /PODE marcar consultas/i);
  assert.doesNotMatch(p, /NÃO marca consultas/i, 'as duas regras não podem coexistir');
});

test('tom e instruções extras entram no prompt quando definidos', () => {
  const { _iaMontarSystemPrompt } = carregarPrompt({ enabled: true, tom: 'cordial e direto', instrucoes: 'só particular, sem convênio' });
  const p = _iaMontarSystemPrompt();
  assert.match(p, /TOM DE VOZ: cordial e direto/);
  assert.match(p, /INSTRUÇÕES EXTRAS DA CLÍNICA: só particular, sem convênio/);
});

// ---------- Personalização v2 ----------
test('nome da assistente e transparência (não fingir ser humana) entram no prompt', () => {
  const { _iaMontarSystemPrompt } = carregarPrompt({ enabled: true, nomeAssistente: 'Sofia', apresentarComoIA: true });
  const p = _iaMontarSystemPrompt();
  assert.match(p, /Você se chama Sofia/);
  assert.match(p, /nunca finja ser humana/i);
});

test('endereço, convênios, pagamentos e temas proibidos aparecem quando preenchidos', () => {
  const { _iaMontarSystemPrompt } = carregarPrompt({
    enabled: true,
    endereco: 'Rua A, 100 — Recife',
    convenios: 'Só particular',
    pagamentos: 'PIX e cartão 3x',
    naoResponder: 'resultados de exame',
  });
  const p = _iaMontarSystemPrompt();
  assert.match(p, /ENDEREÇO: Rua A, 100 — Recife/);
  assert.match(p, /CONVÊNIOS: Só particular/);
  assert.match(p, /FORMAS DE PAGAMENTO: PIX e cartão 3x/);
  assert.match(p, /NUNCA responda sobre: resultados de exame/);
});

test('prompt informa a data de hoje (a IA sabe que dia é)', () => {
  const { _iaMontarSystemPrompt, _ymd } = carregarPrompt({ enabled: true });
  const p = _iaMontarSystemPrompt();
  assert.ok(p.includes(_ymd(new Date())), 'prompt deve conter a data local de hoje');
});

test('overrides do formulário têm precedência sobre o salvo (playground ao vivo)', () => {
  const { _iaMontarSystemPrompt } = carregarPrompt({ enabled: true, tom: 'salvo' });
  const p = _iaMontarSystemPrompt({ tom: 'do formulário' });
  assert.match(p, /TOM DE VOZ: do formulário/);
  assert.doesNotMatch(p, /TOM DE VOZ: salvo/);
});

// ---------- o copiloto não pode vincular agendamento por índice ----------
// O caminho `criar_agendamento` do copiloto gravava `item.crmIdx = crmIdx`
// DEPOIS do DB.set do agendamento. Dois problemas de uma vez:
//
//  1. DB.set serializa um INSTANTÂNEO. Mexer no `item` depois não chega ao
//     localStorage — o aparelho fica sem o vínculo e o servidor, às vezes, com
//     ele. As duas pontas discordam sobre o mesmo agendamento.
//  2. O vínculo era o índice do array do CRM. Um lead novo chegando por
//     realtime reordena a coleção: o agendamento passa a apontar pro contato de
//     OUTRA pessoa, e é o status dela que muda quando este agendamento for
//     confirmado ou cancelado depois.
const _fonteIA = require('./_extrair.js').fonte;
const _blocoCriarAg = (() => {
  const ini = _fonteIA.indexOf("} else if (tipo === 'criar_agendamento') {");
  const fim = _fonteIA.indexOf("} else if (tipo === 'cancelar_agendamento') {", ini);
  assert.ok(ini > 0 && fim > ini, 'o ramo criar_agendamento do copiloto tem de existir');
  return _fonteIA.slice(ini, fim).replace(/\/\/[^\n]*/g, '');
})();

test('copiloto: o agendamento criado guarda o id do contato, não o índice', () => {
  assert.match(_blocoCriarAg, /item\.crmId\s*=/,
    'sem o vínculo por id o agendamento não sabe qual contato do CRM é o dele');
  assert.doesNotMatch(_blocoCriarAg, /item\.crmIdx\s*=/,
    'índice do CRM apodrece: qualquer lead novo por realtime reordena o array');
});

test('copiloto: o vínculo é resolvido ANTES de gravar o agendamento', () => {
  const posCrm = _blocoCriarAg.search(/item\.crmId\s*=/);
  const posSet = _blocoCriarAg.search(/DB\.set\('agendamentos'/);
  assert.ok(posSet > 0, 'o ramo tem de gravar o agendamento');
  assert.ok(posCrm > 0 && posCrm < posSet,
    'gravar primeiro e vincular depois perde o vínculo: DB.set serializa um instantâneo');
});

// ---------- número e status vindos do LLM não podem entrar crus ----------
// `dados` é gerado por um modelo a partir do que o médico DITOU. Dois estragos
// distintos, os dois silenciosos:
//
//  · valor como TEXTO. A soma de _resumoFin é `s + (p.valor || 0)`: com string
//    ela CONCATENA. 300 + "1.200,50" = "3001.200,50", e o _centavos disso é NaN.
//    Um único atendimento criado pelo copiloto zerava o financeiro inteiro.
//    parseFloat não salvava: para no primeiro ponto e devolve 1.2.
//  · status fora da lista canônica. O atendimento não cai em balde NENHUM de
//    _resumoFin — o dinheiro some de todos os relatórios sem erro nenhum.
function montarIA(banco = {}) {
  const { carregar } = require('./_extrair.js');
  const dados = { pacientes: [], crm: [], despesas: [], agendamentos: [], ...banco };
  const objs = { metas: {} };
  const msgs = [];
  const s = carregar(['const:STATUS_PGTO', 'const:FORMAS_PAGAMENTO', 'const:KANBAN_COLUNAS',
                      '_statusPgtoCanonico', '_pagamentoCanonico',
                      '_statusCrmCanonico', 'impNormValor', '_nomeNorm',
                      '_nomeCasaParcial', '_acharPorNome', '_acharCrmPorNome',
                      'executeAIAction'], {
    JSON, Array, Object, Date, Math, String, Number, parseFloat, parseInt, isNaN, console,
    DB: {
      get: (k) => JSON.parse(JSON.stringify(dados[k] || [])),
      set: (k, v) => { dados[k] = JSON.parse(JSON.stringify(v)); },
      getObj: (k, def) => (objs[k] === undefined ? def : JSON.parse(JSON.stringify(objs[k]))),
      setObj: (k, v) => { objs[k] = JSON.parse(JSON.stringify(v)); },
    },
    _novoId: (p) => p + '_novo',
    currentProfissionalId: null,
    _profDoPaciente: () => null,
    appendChatMsg: (_role, texto) => msgs.push(texto),
    BRL: (v) => 'R$ ' + v,
    formatDate: (d) => d,
    document: { getElementById: () => ({ classList: { contains: () => false } }) },
    renderDashboard: () => {}, renderPacientes: () => {}, renderCrm: () => {},
    renderFollowup: () => {}, renderDespesas: () => {}, renderPrecos: () => {},
    renderAgenda: () => {},
  });
  return { executeAIAction: s.executeAIAction, dados, objs, msgs };
}

test('copiloto: valor ditado em formato brasileiro vira número, não texto', () => {
  const { executeAIAction, dados } = montarIA();
  executeAIAction({ tipo: 'criar_paciente', dados: {
    nome: 'Ana', data: '2026-07-20', valor: '1.200,50', statusPgto: 'Pago' } });
  const p = dados.pacientes[0];
  assert.strictEqual(typeof p.valor, 'number', 'valor em texto faz a soma concatenar');
  assert.strictEqual(p.valor, 1200.5, 'parseFloat cru daria 1.2 — mil vezes menos');
});

test('copiloto: a soma financeira continua somando depois de um registro do LLM', () => {
  const { executeAIAction, dados } = montarIA({
    pacientes: [{ nome: 'Zé', data: '2026-07-01', valor: 300, statusPgto: 'Pago' }] });
  executeAIAction({ tipo: 'criar_paciente', dados: {
    nome: 'Ana', data: '2026-07-20', valor: '1.200,50', statusPgto: 'Pago' } });
  const soma = dados.pacientes.filter(p => p.statusPgto === 'Pago')
    .reduce((s, p) => s + (p.valor || 0), 0);
  assert.strictEqual(Math.round(soma * 100) / 100, 1500.5,
    `a soma virou ${JSON.stringify(soma)} — com string ela concatena e o _centavos disso é NaN`);
});

test('copiloto: status de pagamento inventado cai no canônico, não some do balde', () => {
  const { executeAIAction, dados } = montarIA();
  executeAIAction({ tipo: 'criar_paciente', dados: {
    nome: 'Ana', data: '2026-07-20', valor: 500, statusPgto: 'Quitado' } });
  const { STATUS_PGTO } = montarIA();
  assert.ok(['Pago','Parcial','Pendente','Isento'].includes(dados.pacientes[0].statusPgto),
    'status fora do canônico deixa o atendimento fora de TODOS os baldes de _resumoFin');
});

test('copiloto: despesa ditada também vira número', () => {
  const { executeAIAction, dados } = montarIA();
  executeAIAction({ tipo: 'criar_despesa', dados: { descricao: 'Aluguel', valor: 'R$ 2.500,00' } });
  assert.strictEqual(dados.despesas[0].valor, 2500);
});

test('copiloto: atualizar_pagamento recusa status inválido em vez de rebaixar', () => {
  const { executeAIAction, dados, msgs } = montarIA({
    pacientes: [{ nome: 'Ana', data: '2026-07-20', valor: 500, statusPgto: 'Pago' }] });
  executeAIAction({ tipo: 'atualizar_pagamento', dados: { nome: 'Ana', novoStatus: 'Quitado' } });
  assert.strictEqual(dados.pacientes[0].statusPgto, 'Pago',
    'cair no padrão aqui rebaixaria pra Pendente um atendimento já pago');
  assert.match(msgs.join(' '), /não é um status de pagamento/);
});

test('copiloto: atualizar_pagamento aceita zerar o valor (atendimento gratuito)', () => {
  const { executeAIAction, dados } = montarIA({
    pacientes: [{ nome: 'Ana', data: '2026-07-20', valor: 500, statusPgto: 'Pago' }] });
  executeAIAction({ tipo: 'atualizar_pagamento', dados: { nome: 'Ana', valor: 0, novoStatus: 'Isento' } });
  assert.strictEqual(dados.pacientes[0].valor, 0, '`if (dados.valor)` tratava zero como "não informado"');
  assert.strictEqual(dados.pacientes[0].statusPgto, 'Isento');
});

test('copiloto: atualizar_status_crm recusa etapa que não existe no funil', () => {
  const { executeAIAction, dados, msgs } = montarIA({
    crm: [{ id: 'c1', nome: 'Ana', status: 'Em negociação' }] });
  executeAIAction({ tipo: 'atualizar_status_crm', dados: { nome: 'Ana', novoStatus: 'Fechado' } });
  assert.strictEqual(dados.crm[0].status, 'Em negociação',
    'status fora das colunas faz o card sumir da tela e do funil');
  assert.match(msgs.join(' '), /não é uma etapa do funil/);
});

test('copiloto: atualizar_status_crm aceita etapa válida', () => {
  const { executeAIAction, dados } = montarIA({
    crm: [{ id: 'c1', nome: 'Ana', status: 'Em negociação' }] });
  executeAIAction({ tipo: 'atualizar_status_crm', dados: { nome: 'Ana', novoStatus: 'Marcou' } });
  assert.strictEqual(dados.crm[0].status, 'Marcou');
});

test('copiloto: meta ditada não vira NaN (que o JSON grava como null)', () => {
  const { executeAIAction, objs } = montarIA();
  executeAIAction({ tipo: 'definir_meta', dados: { fat: 'R$ 50.000,00', pac: '80 pacientes' } });
  assert.strictEqual(objs.metas.fat, 50000, 'parseFloat("R$ 50.000,00") é NaN → grava null → meta some');
  assert.strictEqual(objs.metas.pac, 80);
  assert.ok(Number.isFinite(objs.metas.fat) && Number.isFinite(objs.metas.pac));
});

// ---------- o copiloto não pode envenenar a tabela de preços ----------
// `criar_procedimento` não exigia nome e gravava `nome: dados.nome` cru. Um
// procedimento com nome undefined na coleção faz o PRÓPRIO criar_procedimento e
// o saveProc lançarem — os dois percorrem a lista comparando
// `p.nome.toLowerCase()`. A tela de Preços parava de salvar qualquer coisa, e
// só limpando o navegador voltava.
function montarProc(procs = []) {
  const banco = { procedimentos: JSON.parse(JSON.stringify(procs)) };
  const msgs = [];
  const s = require('./_extrair.js').carregar(
    ['const:STATUS_PGTO', 'const:FORMAS_PAGAMENTO', 'const:KANBAN_COLUNAS',
     '_statusPgtoCanonico', '_pagamentoCanonico', '_statusCrmCanonico',
     'impNormValor', '_nomeNorm', '_nomeCasaParcial', '_acharPorNome', '_acharCrmPorNome',
     'executeAIAction'], {
    JSON, Array, Object, Date, Math, String, Number, parseFloat, parseInt, isNaN, RegExp, console,
    DB: {
      get: (k) => JSON.parse(JSON.stringify(banco[k] || [])),
      set: (k, v) => { banco[k] = JSON.parse(JSON.stringify(v)); },
      getObj: (k, def) => def, setObj: () => {},
    },
    getProcedimentos: () => JSON.parse(JSON.stringify(banco.procedimentos)),
    _novoId: (p) => p + '_novo', currentProfissionalId: null, _profDoPaciente: () => null,
    appendChatMsg: (_r, t) => msgs.push(t), BRL: (v) => 'R$ ' + v, formatDate: (d) => d,
    document: { getElementById: () => ({ classList: { contains: () => false } }) },
    renderDashboard: () => {}, renderPacientes: () => {}, renderCrm: () => {},
    renderFollowup: () => {}, renderDespesas: () => {}, renderPrecos: () => {}, renderAgenda: () => {},
  });
  return { executeAIAction: s.executeAIAction, banco, msgs };
}

test('copiloto: recusa procedimento sem nome em vez de envenenar a lista', () => {
  const a = montarProc();
  a.executeAIAction({ tipo: 'criar_procedimento', dados: { valorPix: 500 } });
  assert.deepStrictEqual(a.banco.procedimentos, [],
    'procedimento com nome undefined trava o salvamento de todos os outros');
  assert.match(a.msgs.join(' '), /Faltou o nome/);
});

// O preço do procedimento vira a SUGESTÃO de valor de toda consulta futura
// daquele tipo — parseFloat("1.200,00") = 1.2 se propaga sozinho daí em diante.
test('copiloto: preço do procedimento passa pelo mesmo normalizador dos outros', () => {
  const a = montarProc();
  a.executeAIAction({ tipo: 'criar_procedimento', dados: { nome: 'Botox', valorPix: '1.200,00' } });
  assert.strictEqual(a.banco.procedimentos.length, 1);
  assert.strictEqual(a.banco.procedimentos[0].nome, 'Botox');
  assert.strictEqual(a.banco.procedimentos[0].valorPix, 1200);
});

test('copiloto: lista já envenenada não impede criar procedimento novo', () => {
  const a = montarProc([{ id: 'p1', valorPix: 0 }]);   // sem nome, de versão anterior
  assert.doesNotThrow(() =>
    a.executeAIAction({ tipo: 'criar_procedimento', dados: { nome: 'Retorno', valorPix: 0 } }));
  assert.strictEqual(a.banco.procedimentos.length, 2);
});

test('saveProc: procedimento sem nome na coleção não trava o salvamento', () => {
  // A guarda agora mora dentro do _nomeNorm, que é a mesma comparação usada
  // pelo copiloto. O que importa é que percorrer a coleção não lance por causa
  // de um registro sem nome — era isso que fazia a tela de Preços parar de
  // salvar de vez.
  const { _nomeNorm } = carregar('_nomeNorm');
  assert.strictEqual(_nomeNorm(undefined), '');
  assert.strictEqual(_nomeNorm(null), '');
  const src = require('./_extrair.js').recortarFuncao('saveProc').replace(/\/\/[^\n]*/g, '');
  assert.match(src, /_nomeNorm\(p\.nome\)/,
    'p.nome.toLowerCase() cru volta a lançar com um registro sem nome');
});

test('copiloto: bloqueio sem data não é gravado', () => {
  const a = montarProc();
  a.executeAIAction({ tipo: 'criar_bloqueio', dados: { motivo: 'Congresso' } });
  assert.deepStrictEqual(a.banco.bloqueios, undefined,
    'bloqueio sem dataInicio não barra horário nenhum e aparece como Invalid Date');
  assert.match(a.msgs.join(' '), /Faltou a data do bloqueio/);
});

// ---------- procedimento criado pelo copiloto não pode duplicar o que já existe ----------
// O LLM emite "Consulta " com espaço sobrando o tempo todo. A comparação era
// `.toLowerCase()` sem trim nos dois lados, então o procedimento existente não
// era reconhecido: nascia um segundo, visualmente idêntico na tabela de preços.
// E o nome guardado com o espaço não casa mais com nada — o valor sugerido do
// atendimento e os baldes de metas procuram o procedimento pelo nome EXATO.
// O guard do PRECISA_NOME já aparava o nome pra VALIDAR; o valor gravado é que
// continuava cru.
function criarProc(procsIniciais, dadosNome) {
  const { recortarFuncao } = require('./_extrair.js');
  const vm = require('node:vm');
  const corpo = recortarFuncao('executeAIAction');
  const ini = corpo.indexOf("} else if (tipo === 'criar_procedimento') {");
  const fim = corpo.indexOf("DB.set('procedimentos', procs);", ini)
            + "DB.set('procedimentos', procs);".length;
  assert.ok(ini > 0 && fim > ini, 'o bloco criar_procedimento mudou de forma');
  const trecho = corpo.slice(ini + "} else if (tipo === 'criar_procedimento') {".length, fim);

  const guardadas = { procedimentos: procsIniciais.map(p => ({ ...p })) };
  const s = carregar(['_nomeNorm'], {
    String, Date, Math, Number,
    dados: { nome: dadosNome, valorPix: '500', valorCartao: '' },
    getProcedimentos: () => guardadas.procedimentos,
    impNormValor: (v) => parseFloat(v) || 0,
    DB: { set: (k, v) => { guardadas[k] = v; } },
  });
  vm.runInContext(trecho, s, { filename: 'recorte' });
  return guardadas.procedimentos;
}

test('copiloto: procedimento com espaço sobrando atualiza o existente', () => {
  const procs = criarProc([{ id: 'p1', nome: 'Consulta', valorPix: 300, valorCartao: 320 }], 'Consulta ');
  assert.strictEqual(procs.length, 1, 'espaço sobrando criava um segundo "Consulta" na tabela de preços');
  assert.strictEqual(procs[0].id, 'p1', 'atualizar mantém o id do procedimento');
  assert.strictEqual(procs[0].valorPix, 500);
});

test('copiloto: o nome é guardado aparado', () => {
  const procs = criarProc([], '  Telemedicina  ');
  assert.strictEqual(procs[0].nome, 'Telemedicina',
    'nome com espaço não casa com o balde de metas nem com o valor sugerido');
});

test('copiloto: procedimento realmente novo continua sendo criado', () => {
  const procs = criarProc([{ id: 'p1', nome: 'Consulta' }], 'Domiciliar');
  assert.strictEqual(procs.length, 2);
  assert.strictEqual(procs[1].nome, 'Domiciliar');
});

test('as duas telas que gravam procedimento usam a mesma comparação de nome', () => {
  const { recortarFuncao } = require('./_extrair.js');
  const saveProc = recortarFuncao('saveProc');
  assert.match(saveProc, /_nomeNorm\(p\.nome\) === _nomeNorm\(item\.nome\)/,
    'comparar sem trim deixa passar o duplicado que o copiloto já criou');
});

// ---------- forma de pagamento ditada ----------
// O statusPgto já era canonizado ("fora da lista o dinheiro some dos
// relatórios"); a FORMA de pagamento não era. Ela alimenta as três tabelas de
// "Mix de pagamento" e a estimativa de taxa de cartão, todas filtrando com
// `p.pagamento === f`. Um "pix" minúsculo bastava pra o atendimento sumir de
// todas elas — e as linhas passarem a somar menos que o próprio Total.
function criarPac(dados) {
  const a = montarProc();
  a.executeAIAction({ tipo: 'criar_paciente', dados: { nome: 'Ana', data: '2026-08-03', valor: 500, ...dados } });
  return a;
}

test('copiloto: "pix" minúsculo entra como PIX', () => {
  const a = criarPac({ pagamento: 'pix' });
  assert.strictEqual(a.banco.pacientes[0].pagamento, 'PIX');
});

test('copiloto: espaço e caixa na forma de pagamento são corrigidos', () => {
  assert.strictEqual(criarPac({ pagamento: ' Cartão Crédito ' }).banco.pacientes[0].pagamento, 'Cartão crédito');
  assert.strictEqual(criarPac({ pagamento: 'DINHEIRO' }).banco.pacientes[0].pagamento, 'Dinheiro');
});

test('copiloto: forma desconhecida não é chutada — é avisada', () => {
  const a = criarPac({ pagamento: 'boleto' });
  assert.strictEqual(a.banco.pacientes[0].pagamento, 'boleto',
    'o médico ditou aquilo; trocar por uma das cinco inventaria como ele foi pago');
  assert.match(a.msgs.join(' '), /Não reconheci a forma de pagamento/,
    'sem aviso, o atendimento sumiria do Mix de pagamento em silêncio');
});

test('copiloto: sem forma de pagamento não inventa nem avisa', () => {
  const a = criarPac({});
  assert.strictEqual(a.banco.pacientes[0].pagamento, '');
  assert.ok(!/Não reconheci a forma/.test(a.msgs.join(' ')));
});
