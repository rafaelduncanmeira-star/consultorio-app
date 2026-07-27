// Efeitos da mudança de status no CRM — rode com: node --test
//
// Trocar o status de um contato dispara ações que gravam: propor agendamento
// ("Marcou"), propor registrar atendimento ("Atendeu"), cancelar agendamentos
// futuros ("Não marcou"). As duas primeiras passam por um confirm(), que fica
// aberto o tempo que a pessoa levar pra decidir — e o CRM recebe leads por
// realtime nesse intervalo, deslocando o array.

const { test } = require('node:test');
const assert = require('node:assert');
const { carregar, fonte } = require('./_extrair.js');

function ambiente(crm, { responder = true } = {}) {
  const banco = { crm: JSON.parse(JSON.stringify(crm)), agendamentos: [] };
  const chamadas = [];
  const pendentes = [];
  const s = carregar('_aplicarEfeitosMudancaStatusCrm', {
    JSON, Array, Object, Date,
    DB: {
      get: (k) => JSON.parse(JSON.stringify(banco[k] || [])),
      set: (k, v) => { banco[k] = JSON.parse(JSON.stringify(v)); },
    },
    _ymd: () => '2026-08-05',
    confirm: () => responder,
    // Guarda o callback em vez de agendar: o teste dispara na hora que quiser,
    // que é justamente o ponto — simular a espera do confirm.
    setTimeout: (fn) => { pendentes.push(fn); },
    convertCrmToAtendido: (ref) => chamadas.push(['convertCrmToAtendido', ref]),
    openNovoAgendamento: (o) => chamadas.push(['openNovoAgendamento', o]),
    toast: () => {}, renderAgenda: () => {}, renderCrm: () => {},
    document: { getElementById: () => ({ classList: { contains: () => false } }) },
  });
  return { aplicar: s._aplicarEfeitosMudancaStatusCrm, banco, chamadas,
           decidir: () => pendentes.forEach(f => f()),
           chegarLead: (c) => banco.crm.unshift(c) };
}

const ANA   = { id: 'crm_ana',   nome: 'Ana',   whatsapp: '11999990000', status: 'Marcou' };
const BRUNO = { id: 'crm_bruno', nome: 'Bruno', whatsapp: '11888880000', status: 'Marcou' };

test('Atendeu: registra o atendimento do contato certo mesmo com lead novo no meio', () => {
  const a = ambiente([ANA, BRUNO]);
  a.aplicar(0, 'Marcou', 'Atendeu');          // Ana está no índice 0
  a.chegarLead({ id: 'crm_novo', nome: 'Carla', status: 'Contato feito' }); // realtime
  a.decidir();                                 // só agora a pessoa clica OK
  assert.deepStrictEqual(a.chamadas.length, 1);
  const [, ref] = a.chamadas[0];
  assert.strictEqual(ref, 'crm_ana',
    'com o índice, o modal abria com o nome, o WhatsApp e o profissional de outro contato — e já vem com statusPgto Pago');
});

test('Marcou: a proposta de agendamento carrega o id do contato', () => {
  const a = ambiente([{ ...ANA, status: 'Em negociação' }, BRUNO]);
  a.aplicar(0, 'Em negociação', 'Marcou');
  a.chegarLead({ id: 'crm_novo', nome: 'Carla', status: 'Contato feito' });
  a.decidir();
  const [nome, opts] = a.chamadas[0];
  assert.strictEqual(nome, 'openNovoAgendamento');
  assert.strictEqual(opts.crmId, 'crm_ana');
  assert.strictEqual(opts.pacienteNome, 'Ana');
});

test('status igual não dispara efeito nenhum', () => {
  const a = ambiente([ANA]);
  a.aplicar(0, 'Atendeu', 'Atendeu');
  a.decidir();
  assert.deepStrictEqual(a.chamadas, []);
});

test('recusar no confirm não grava nada', () => {
  const a = ambiente([ANA, BRUNO], { responder: false });
  a.aplicar(0, 'Marcou', 'Atendeu');
  a.decidir();
  assert.deepStrictEqual(a.chamadas, []);
});

// Guarda contra a reincidência: os três caminhos que registram atendimento a
// partir do CRM têm de passar o id.
test('nenhum caminho chama convertCrmToAtendido com índice cru', () => {
  const semCom = fonte.replace(/\/\/[^\n]*/g, '');
  const refs = [...semCom.matchAll(/convertCrmToAtendido\(([^)]*)\)/g)].map(m => m[1].trim());
  assert.ok(refs.length >= 2, 'a premissa: existem chamadas a inspecionar');
  for (const r of refs) {
    assert.doesNotMatch(r, /^(idx|i|crmIdx)$/,
      `convertCrmToAtendido(${r}) usa índice — ele apodrece durante o confirm`);
  }
});
