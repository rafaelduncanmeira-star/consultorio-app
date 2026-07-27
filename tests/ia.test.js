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
