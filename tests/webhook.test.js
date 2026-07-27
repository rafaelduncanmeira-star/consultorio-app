// Testes da Edge Function wa-webhook — rode com: node --test
// Exercitam o código REAL recortado do index.ts (ver tests/_extrairTs.js),
// com type-stripping nativo do Node. A agenda que a secretária de IA oferece
// ao paciente é calculada lá, não no app.js.

const { test } = require('node:test');
const assert = require('node:assert');
const { carregarTs } = require('./_extrairTs.js');

const wa = carregarTs(['const:TZ_CLINICA', '_dataLocal', '_dowLocal', 'montarDisponibilidade']);

const CFG = {
  horaInicio: '07:00', horaFim: '20:00', slotDuracao: 60,
  almocoInicio: '12:00', almocoFim: '13:30', diasUteis: [1, 2, 3, 4, 5],
};

// montarDisponibilidade olha os próximos 21 dias a partir de amanhã, então o
// teste precisa mirar num dia útil real do futuro em vez de uma data fixa.
function proximosUteis(n) {
  const base = new Date(), dias = [];
  for (let i = 1; i <= 21 && dias.length < n; i++) {
    const d = new Date(base.getTime() + i * 86400000);
    if (CFG.diasUteis.includes(wa._dowLocal(d))) dias.push(wa._dataLocal(d));
  }
  return dias;
}
const slotsDe = (r, ds) => [...r.livres].filter(s => s.startsWith(ds)).map(s => s.slice(11)).sort();

test('montarDisponibilidade: dia útil sem nada marcado oferece a grade inteira', () => {
  const [dia] = proximosUteis(1);
  const s = slotsDe(wa.montarDisponibilidade(CFG, [], []), dia);
  assert.deepStrictEqual(s, ['07:00', '08:00', '09:00', '10:00', '11:00',
                             '14:00', '15:00', '16:00', '17:00', '18:00', '19:00']);
});

// O almoço padrão é 12:00–13:30 com slot de 60min. 13:00–14:00 invade meia hora
// dele: tem de ficar de fora (a regra é sobreposição, não contenção).
test('montarDisponibilidade: slot que invade parte do almoço não é oferecido', () => {
  const [dia] = proximosUteis(1);
  const s = slotsDe(wa.montarDisponibilidade(CFG, [], []), dia);
  assert.ok(!s.includes('12:00'), '12:00 cai inteiro no almoço');
  assert.ok(!s.includes('13:00'), '13:00–14:00 come 30min do almoço');
  assert.ok(s.includes('14:00'), '14:00 já está fora do almoço');
});

// O ACHADO: bloqueio tem hora, mas a hora era ignorada — bastava a data bater
// pro dia inteiro sumir. Quem bloqueava a tarde de quinta pra um congresso via
// a IA responder que não havia NADA na quinta, com a manhã toda livre.
test('montarDisponibilidade: bloqueio de tarde não apaga a manhã livre', () => {
  const [dia] = proximosUteis(1);
  const bloq = [{ id: 'b1', motivo: 'Congresso', dataInicio: dia, horaInicio: '14:00', dataFim: dia, horaFim: '16:00' }];
  const s = slotsDe(wa.montarDisponibilidade(CFG, [], bloq), dia);
  assert.deepStrictEqual(s, ['07:00', '08:00', '09:00', '10:00', '11:00', '16:00', '17:00', '18:00', '19:00'],
    'só 14:00 e 15:00 se sobrepõem ao bloqueio');
});

test('montarDisponibilidade: bloqueio sem hora segue valendo o dia inteiro', () => {
  const [dia] = proximosUteis(1);
  const bloq = [{ id: 'b1', motivo: 'Feriado', dataInicio: dia, dataFim: dia }];
  assert.deepStrictEqual(slotsDe(wa.montarDisponibilidade(CFG, [], bloq), dia), [],
    'sem horaInicio/horaFim o padrão é 00:00–23:59');
});

// Bloqueio de vários dias é um intervalo contínuo (mesma semântica do
// _isBloqueado do app.js): o dia do meio é integral, só as pontas têm recorte.
test('montarDisponibilidade: bloqueio de vários dias recorta só as pontas', () => {
  const [d1, d2, d3] = proximosUteis(3);
  const bloq = [{ id: 'b1', motivo: 'Férias', dataInicio: d1, horaInicio: '15:00', dataFim: d3, horaFim: '10:00' }];
  const r = wa.montarDisponibilidade(CFG, [], bloq);
  assert.deepStrictEqual(slotsDe(r, d1), ['07:00', '08:00', '09:00', '10:00', '11:00', '14:00'],
    'primeiro dia: livre até as 15:00 — 14:00–15:00 encosta no bloqueio mas não invade');
  assert.deepStrictEqual(slotsDe(r, d2), [], 'dia do meio: integral');
  assert.deepStrictEqual(slotsDe(r, d3), ['10:00', '11:00', '14:00', '15:00', '16:00', '17:00', '18:00', '19:00'],
    'último dia: livre a partir das 10:00');
});

// Compromisso de 90min tem de derrubar o slot seguinte, não só o que começa
// no mesmo minuto.
test('montarDisponibilidade: consulta longa bloqueia o slot que ela invade', () => {
  const [dia] = proximosUteis(1);
  const ags = [{ data: dia, hora: '08:00', duracao: 90, status: 'Confirmado' }];
  const s = slotsDe(wa.montarDisponibilidade(CFG, ags, []), dia);
  assert.ok(!s.includes('08:00'));
  assert.ok(!s.includes('09:00'), '08:00+90min vai até 09:30 e come o slot das 09:00');
  assert.ok(s.includes('10:00'));
});

test('montarDisponibilidade: agendamento cancelado não segura o horário', () => {
  const [dia] = proximosUteis(1);
  const ags = [{ data: dia, hora: '08:00', duracao: 60, status: 'Cancelado' }];
  assert.ok(slotsDe(wa.montarDisponibilidade(CFG, ags, []), dia).includes('08:00'));
});

// ---------- _foneChat: a chave da conversa tem de ser a MESMA dos dois lados ----------
// O webhook grava crm_messages.whatsapp; o app procura o chat por _normPhone.
// Regras diferentes = mensagem gravada numa chave que o app nunca procura, e o
// chat abre vazio no CRM. O webhook aceita telefone a partir de 10 dígitos,
// então número do DDD 55 sem o código do país está no alcance dele.
const { _foneChat } = carregarTs('_foneChat');

// Espelho da regra do app.js (_normPhone) — se as duas divergirem, o teste cai.
const _normPhoneApp = (raw) => {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.length >= 12 && d.startsWith('55')) d = d.slice(2);
  return d;
};

test('_foneChat: concorda com o _normPhone do app em todo formato de número', () => {
  const numeros = [
    ['5511987654321', 'celular SP com DDI'],
    ['5555987654321', 'celular DDD 55 com DDI'],
    ['555532201234',  'fixo DDD 55 com DDI'],
    ['55987654321',   'celular DDD 55 SEM DDI — o 55 aqui é DDD, não país'],
    ['5532201234',    'fixo DDD 55 SEM DDI'],
    ['11987654321',   'celular SP sem DDI'],
    ['+55 (11) 98765-4321', 'com máscara'],
  ];
  for (const [n, desc] of numeros) {
    assert.strictEqual(_foneChat(n), _normPhoneApp(n), `${desc}: ${n}`);
  }
});

test('_foneChat: tira o DDI só quando ele é DDI mesmo', () => {
  assert.strictEqual(_foneChat('5511987654321'), '11987654321', '13 dígitos: 55 é país');
  assert.strictEqual(_foneChat('55987654321'), '55987654321', '11 dígitos: 55 é DDD, tem de ficar');
  assert.strictEqual(_foneChat('5532201234'), '5532201234', '10 dígitos: 55 é DDD, tem de ficar');
});

test('_foneChat: entrada vazia ou lixo não explode', () => {
  for (const ruim of [null, undefined, '', 'abc']) {
    assert.strictEqual(_foneChat(ruim), '');
  }
});

test('montarDisponibilidade: sem agenda e sem bloqueio o texto do prompt não vem vazio', () => {
  const r = wa.montarDisponibilidade(CFG, [], []);
  assert.ok(r.texto.length > 0);
  assert.ok(r.livres.size > 0);
  // O texto do prompt lista no máximo 4 horários por dia, mas o Set de validação
  // do marcador AGENDAR tem de conter TODOS — senão a IA oferece um horário que
  // ela mesma vai recusar depois.
  const [dia] = proximosUteis(1);
  assert.ok(slotsDe(r, dia).length > 4, 'o Set não pode ser truncado como o texto');
});
