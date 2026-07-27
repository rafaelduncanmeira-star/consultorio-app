// Chat do CRM — rode com: node --test
//
// A conversa é identificada pelo TELEFONE. Guardar um índice do CRM junto não
// funciona: a coleção recebe leads por realtime e cada um entra com unshift,
// deslocando tudo. O índice congelado quando o chat abriu passava a apontar pro
// card de OUTRO contato — e esta conversa exibia a primeira mensagem de outro
// paciente como se fosse dele. Numa clínica, é dado de saúde na tela errada.

const { test } = require('node:test');
const assert = require('node:assert');
const { carregar, fonte, recortarFuncao } = require('./_extrair.js');

const CRM = [
  { id: 'c_ana',   nome: 'Ana',   whatsapp: '11999990000', obs: 'Primeira msg: dor no joelho' },
  { id: 'c_bruno', nome: 'Bruno', whatsapp: '11888880000', obs: 'Primeira msg: renovar receita' },
];

function ambiente(crm) {
  return carregar(['_normPhone', '_crmPorTelefone'], {
    String, Array, JSON,
    DB: { get: () => JSON.parse(JSON.stringify(crm)) },
  });
}

test('acha o card do contato pelo telefone', () => {
  const { _crmPorTelefone, _normPhone } = ambiente(CRM);
  assert.strictEqual(_crmPorTelefone(_normPhone('11999990000')).nome, 'Ana');
  assert.strictEqual(_crmPorTelefone(_normPhone('5511888880000')).nome, 'Bruno',
    'o número pode chegar com DDI — a chave é a forma normalizada');
});

test('lead novo entrando no topo não troca o dono da conversa', () => {
  const { _crmPorTelefone, _normPhone } = ambiente(
    [{ id: 'c_novo', nome: 'Carla', whatsapp: '11777770000', obs: 'Primeira msg: consulta' }, ...CRM]);
  assert.strictEqual(_crmPorTelefone(_normPhone('11999990000')).nome, 'Ana',
    'com índice congelado, a conversa da Ana passava a mostrar a mensagem da Carla');
});

test('telefone sem card no CRM devolve null, não o primeiro da lista', () => {
  const { _crmPorTelefone } = ambiente(CRM);
  assert.strictEqual(_crmPorTelefone('11000000000'), null);
  assert.strictEqual(_crmPorTelefone(''), null);
});

test('nada no chat guarda índice do CRM', () => {
  const semCom = fonte.replace(/\/\/[^\n]*/g, '');
  assert.ok(!semCom.includes('_chatIdx'),
    'índice de CRM congelado apodrece a cada lead que chega');
  const src = recortarFuncao('loadChatHistory').replace(/\/\/[^\n]*/g, '');
  assert.match(src, /_crmPorTelefone\(_chatPhone\)/,
    'o card do contato tem de ser resolvido pela identidade da conversa');
});

// A regressão que este nome convidava já aconteceu uma vez: o card de lembretes
// foi "consertado" de volta pra uma checagem só de Z-API.
test('nenhuma variável de conexão se chama zapiOk', () => {
  const semCom = fonte.replace(/\/\/[^\n]*/g, '');
  assert.ok(!/\bzapiOk\b/.test(semCom),
    'o valor vem de _waConnected e cobre os dois provedores — o nome tem de dizer isso');
});
