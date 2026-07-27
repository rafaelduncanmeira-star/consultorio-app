// Alertas proativos do Dashboard — rode com: node --test
//
// O alerta "pacientes sem retorno há +6 meses" agrupava as consultas pelo nome
// CRU, enquanto o resto do app (_novosNoMes, _primeiroAtendimentoDe e a própria
// tela de Retenção, de onde a regra foi copiada) agrupa pelo nome normalizado.
// E é assim que o nome chega: digitado à mão a cada visita, importado de
// planilha, vindo do perfil do WhatsApp. "Maria Silva", "maria silva" e
// "Maria Silva " viravam três pacientes — a visita recente ficava em UMA das
// grafias e as outras apareciam como sumidas. O médico via no Dashboard um
// paciente que atendeu semana passada listado como "sem retorno há +6 meses",
// e a tela de Retenção dizia o contrário sobre a mesma pessoa.

const { test } = require('node:test');
const assert = require('node:assert');
const { carregar, recortarFuncao, fonte } = require('./_extrair.js');

// A função é grande e desenha muita coisa; o que interessa é o bloco 5.
// Recorta o trecho e roda só ele, com os mesmos helpers do app.
function sumidosDe(pacientes, hoje = '2026-08-03') {
  const corpo = recortarFuncao('renderAlertasProativos');
  const ini = corpo.indexOf('const seisStr = _ymd(_addMeses');
  const fim = corpo.indexOf('.map(v => v.nome);', ini) + '.map(v => v.nome);'.length;
  assert.ok(ini > 0 && fim > ini, 'o bloco dos pacientes sumidos mudou de forma');
  const trecho = corpo.slice(ini, fim);

  const s = carregar(['_ymd', '_addMeses'], {
    Date, Map, Array, String, Object,
    todos: pacientes,
  });
  const vm = require('node:vm');
  vm.runInContext(trecho + '\nglobalThis.__sumidos = sumidos;', s, { filename: 'recorte' });
  return s.__sumidos;
}

test('grafias diferentes do mesmo nome são o mesmo paciente', () => {
  const sumidos = sumidosDe([
    { nome: 'Maria Silva',   data: '2025-01-10' },
    { nome: 'maria silva ',  data: '2026-07-28' },   // veio semana passada
  ]);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sumidos)), [],
    'a visita recente vale para a pessoa, não para a grafia');
});

test('quem some de verdade continua sendo listado', () => {
  const sumidos = sumidosDe([
    { nome: 'João Souza', data: '2025-06-01' },
    { nome: 'Ana Lima',   data: '2026-07-30' },
  ]);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sumidos)), ['João Souza']);
});

test('a grafia mostrada é a da visita mais recente', () => {
  const sumidos = sumidosDe([
    { nome: 'JOÃO SOUZA', data: '2024-01-01' },   // mesmas letras, só a caixa muda
    { nome: 'João Souza', data: '2025-06-01' },
  ]);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sumidos)), ['João Souza']);
});

test('registro sem nome ou sem data não entra na conta', () => {
  const sumidos = sumidosDe([
    { nome: '',           data: '2024-01-01' },
    { nome: '   ',        data: '2024-01-01' },
    { nome: 'Sem Data' },
  ]);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sumidos)), []);
});

test('nome que colide com propriedade herdada de Object não some', () => {
  // Com objeto literal, ultimaVisita['constructor'] já vinha "preenchido" por
  // herança e o paciente nunca era registrado.
  const sumidos = sumidosDe([{ nome: 'Constructor', data: '2024-01-01' }]);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sumidos)), ['Constructor']);
});

test('as duas telas que respondem "sem retorno há 6 meses" usam a mesma chave', () => {
  // A de Retenção agrupa com (p.nome || '').toLowerCase().trim(); o alerta do
  // Dashboard tem de agrupar igual — o comentário no código já prometia isso.
  const alerta = recortarFuncao('renderAlertasProativos');
  const bloco = alerta.slice(alerta.indexOf('const seisStr = _ymd(_addMeses'));
  assert.match(bloco, /\(p\.nome \|\| ''\)\.toLowerCase\(\)\.trim\(\)/,
    'nome cru como chave faz o mesmo paciente contar mais de uma vez');
  assert.match(bloco, /new Map\(\)/, 'mapa de nome→data é Map, nunca objeto literal');
  assert.ok(fonte.includes("const seisStr = _ymd(_addMeses(new Date(), -6));"),
    'o corte dos 6 meses continua sendo o mesmo texto nas duas telas');
});
