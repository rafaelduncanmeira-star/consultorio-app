// Testes da Secretária por IA (copiloto) — rode com: node --test
// Exercitam o código REAL recortado do app.js.

const { test } = require('node:test');
const assert = require('node:assert');
const { carregar } = require('./_extrair.js');

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
  return carregar(['getIaConfig', '_iaMontarSystemPrompt'], {
    DB,
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
  const p = _iaMontarSystemPrompt();
  assert.match(p, /NUNCA dê conselho, diagnóstico ou orientação médica/i);
  assert.match(p, /NÃO confirme o agendamento como feito/i); // não fecha agenda sozinha
});

test('tom e instruções extras entram no prompt quando definidos', () => {
  const { _iaMontarSystemPrompt } = carregarPrompt({ enabled: true, tom: 'cordial e direto', instrucoes: 'só particular, sem convênio' });
  const p = _iaMontarSystemPrompt();
  assert.match(p, /TOM DE VOZ: cordial e direto/);
  assert.match(p, /INSTRUÇÕES EXTRAS DA CLÍNICA: só particular, sem convênio/);
});
