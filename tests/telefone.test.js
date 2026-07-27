// Telefone do paciente por nome — rode com: node --test
//
// Duas telas precisam recuperar o WhatsApp a partir do nome: o botão 💬 da
// lista de pacientes (falarComPacienteNome) e o do follow-up
// (_openWhatsAppForFu). Faziam a mesma busca de jeitos diferentes — e o do
// follow-up comparava o nome CRU (`p.nome === fu.nome`).
//
// O nome chega digitado a cada visita, importado de planilha e vindo do perfil
// do WhatsApp: basta a grafia divergir entre o follow-up e o atendimento pra a
// busca não achar nada. O médico recebe "WhatsApp não cadastrado para X — edite
// o follow-up e adicione o número", com o número dele já cadastrado ali do
// lado. E redigita um telefone que o app já tinha.

const { test } = require('node:test');
const assert = require('node:assert');
const { carregar, fonte } = require('./_extrair.js');

function ambiente(colecoes) {
  return carregar('_telefoneDoPaciente', {
    String,
    DB: { get: (k) => colecoes[k] || [] },
    getAgendamentos: () => colecoes.agendamentos || [],
  });
}

test('acha o número mesmo com a grafia diferente', () => {
  const { _telefoneDoPaciente } = ambiente({
    pacientes: [{ nome: 'Maria Silva', whatsapp: '11999990000' }],
  });
  assert.strictEqual(_telefoneDoPaciente('maria silva '), '11999990000');
  assert.strictEqual(_telefoneDoPaciente('MARIA SILVA'), '11999990000');
});

test('a ordem das fontes é atendimento → CRM → agenda → follow-up', () => {
  const base = {
    pacientes: [{ nome: 'Ana', whatsapp: '1111' }],
    crm: [{ nome: 'Ana', whatsapp: '2222' }],
    agendamentos: [{ pacienteNome: 'Ana', whatsapp: '3333' }],
    followup: [{ nome: 'Ana', whatsapp: '4444' }],
  };
  assert.strictEqual(ambiente(base)._telefoneDoPaciente('ana'), '1111');
  assert.strictEqual(ambiente({ ...base, pacientes: [] })._telefoneDoPaciente('ana'), '2222');
  assert.strictEqual(ambiente({ ...base, pacientes: [], crm: [] })._telefoneDoPaciente('ana'), '3333');
  assert.strictEqual(
    ambiente({ ...base, pacientes: [], crm: [], agendamentos: [] })._telefoneDoPaciente('ana'), '4444');
});

test('registro do mesmo paciente SEM número não bloqueia o que tem', () => {
  const { _telefoneDoPaciente } = ambiente({
    pacientes: [{ nome: 'Ana', whatsapp: '' }, { nome: 'ana', whatsapp: '5555' }],
  });
  assert.strictEqual(_telefoneDoPaciente('Ana'), '5555');
});

test('nome vazio não casa com registro de nome vazio', () => {
  const { _telefoneDoPaciente } = ambiente({
    pacientes: [{ nome: '', whatsapp: '9999' }, { nome: '   ', whatsapp: '8888' }],
  });
  assert.strictEqual(_telefoneDoPaciente(''), '');
  assert.strictEqual(_telefoneDoPaciente('   '), '');
  assert.strictEqual(_telefoneDoPaciente(null), '');
});

test('ninguém mais busca paciente comparando nome cru', () => {
  const linhas = fonte.split('\n');
  const ruins = [];
  linhas.forEach((l, i) => {
    if (/\b\w+\.(?:nome|pacienteNome)\s*===\s*\w+\.(?:nome|pacienteNome)\b/.test(l)) {
      ruins.push((i + 1) + ': ' + l.trim().slice(0, 110));
    }
  });
  assert.deepStrictEqual(ruins, [],
    'identidade de paciente é o nome normalizado — comparar cru perde a pessoa');
});

test('as duas telas passaram a usar a mesma regra', () => {
  const { recortarFuncao } = require('./_extrair.js');
  for (const fn of ['falarComPacienteNome', '_openWhatsAppForFu']) {
    assert.match(recortarFuncao(fn), /_telefoneDoPaciente\(/,
      `${fn} tem de usar a regra única, senão as duas voltam a divergir`);
  }
});
