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
