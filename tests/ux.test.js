// Testes das melhorias de usabilidade (saudação, autocomplete, banner de mês
// vazio) — rode com: node --test. Exercitam o código REAL do app.js.

const { test } = require('node:test');
const assert = require('node:assert');
const { carregar } = require('./_extrair.js');

// ---------- _comTituloMedico: nunca duplica "Dr./Dra." ----------
test('_comTituloMedico adiciona "Dr." quando falta', () => {
  const { _comTituloMedico } = carregar('_comTituloMedico');
  assert.strictEqual(_comTituloMedico('Rafael'), 'Dr. Rafael');
  assert.strictEqual(_comTituloMedico('Ana Souza'), 'Dr. Ana Souza');
});

test('_comTituloMedico NÃO duplica quando o nome já tem o título', () => {
  const { _comTituloMedico } = carregar('_comTituloMedico');
  assert.strictEqual(_comTituloMedico('Dr. Teste'), 'Dr. Teste');
  assert.strictEqual(_comTituloMedico('Dra. Maria'), 'Dra. Maria');
  assert.strictEqual(_comTituloMedico('dr. minusculo'), 'dr. minusculo');
});

test('_comTituloMedico trata nome vazio/nulo sem quebrar', () => {
  const { _comTituloMedico } = carregar('_comTituloMedico');
  assert.strictEqual(_comTituloMedico(''), '');
  assert.strictEqual(_comTituloMedico(null), '');
});

// ---------- _primeiroNomeSemTitulo: a raiz do bug real "Dr. Dr. Teste" ----------
// Pegar a 1ª palavra ANTES de tirar o título transformava "Dr. Teste" em só
// "Dr." — daí _comTituloMedico("Dr.") não reconhecia o título (sem espaço
// depois) e prefixava de novo: "Dr. Dr.". Correção: tira o título primeiro.
test('_primeiroNomeSemTitulo remove o título antes de cortar a 1ª palavra', () => {
  const { _primeiroNomeSemTitulo } = carregar('_primeiroNomeSemTitulo');
  assert.strictEqual(_primeiroNomeSemTitulo('Dr. Teste'), 'Teste');
  assert.strictEqual(_primeiroNomeSemTitulo('Dra. Maria Silva'), 'Maria');
  assert.strictEqual(_primeiroNomeSemTitulo('Rafael Duncan'), 'Rafael');
});

test('_comTituloMedico(_primeiroNomeSemTitulo(...)) nunca duplica — regressão do bug real', () => {
  const { _comTituloMedico, _primeiroNomeSemTitulo } = carregar(['_comTituloMedico', '_primeiroNomeSemTitulo']);
  for (const nome of ['Dr. Teste', 'Dra. Ana', 'Rafael Duncan', 'Dr.Teste', 'Dr Teste']) {
    const resultado = _comTituloMedico(_primeiroNomeSemTitulo(nome));
    const qtdDr = (resultado.match(/dr\.?/gi) || []).length;
    assert.strictEqual(qtdDr, 1, `"${nome}" → "${resultado}" tem título duplicado`);
  }
});

test('_comTituloMedico não confunde nomes reais que começam com "dr" (Drico, Dracena)', () => {
  const { _comTituloMedico } = carregar('_comTituloMedico');
  assert.strictEqual(_comTituloMedico('Drico Silva'), 'Dr. Drico Silva');
  assert.strictEqual(_comTituloMedico('Dracena Souza'), 'Dr. Dracena Souza');
});

// ---------- _mesMaisRecenteComDados: banner "sem lançamentos neste mês" ----------
function carregarMes(pacientes, despesas) {
  return carregar(['_mesMaisRecenteComDados', 'getMes'], {
    DB: { get: (k) => (k === 'pacientes' ? pacientes : k === 'despesas' ? despesas : []) },
  });
}

test('_mesMaisRecenteComDados acha o mês mais recente, ignorando o mês atual', () => {
  const { _mesMaisRecenteComDados } = carregarMes(
    [{ data: '2026-05-10' }, { data: '2026-03-01' }],
    [{ data: '2026-05-20' }]
  );
  assert.strictEqual(_mesMaisRecenteComDados('2026-07'), '2026-05');
});

test('_mesMaisRecenteComDados retorna null quando não há dado em lugar nenhum', () => {
  const { _mesMaisRecenteComDados } = carregarMes([], []);
  assert.strictEqual(_mesMaisRecenteComDados('2026-07'), null);
});

test('_mesMaisRecenteComDados ignora o próprio mês excluído mesmo com dado nele', () => {
  const { _mesMaisRecenteComDados } = carregarMes([{ data: '2026-07-01' }, { data: '2026-04-01' }], []);
  assert.strictEqual(_mesMaisRecenteComDados('2026-07'), '2026-04');
});

// ---------- _agIndiceContatos: autocomplete do agendamento ----------
function carregarIndice(pacientes, crm) {
  return carregar('_agIndiceContatos', { DB: { get: (k) => (k === 'pacientes' ? pacientes : k === 'crm' ? crm : []) } });
}

test('_agIndiceContatos prioriza o atendimento mais recente do paciente', () => {
  const { _agIndiceContatos } = carregarIndice([
    { nome: 'Ana Lima', data: '2026-01-01', whatsapp: '81900000001', tipo: 'Consulta' },
    { nome: 'Ana Lima', data: '2026-06-01', whatsapp: '81900000002', tipo: 'Retorno' },
  ], []);
  const idx = _agIndiceContatos();
  const c = idx.get('ana lima');
  assert.strictEqual(c.whatsapp, '81900000002');
  assert.strictEqual(c.procedimento, 'Retorno');
});

test('_agIndiceContatos cobre leads do CRM que ainda não são pacientes', () => {
  const { _agIndiceContatos } = carregarIndice([], [
    { nome: 'Bruno Sá', whatsapp: '81988887777', tipo: '1ª vez' },
  ]);
  const idx = _agIndiceContatos();
  assert.strictEqual(idx.get('bruno sá').whatsapp, '81988887777');
});

test('_agIndiceContatos: paciente tem prioridade sobre CRM quando os dois têm o mesmo nome', () => {
  const { _agIndiceContatos } = carregarIndice(
    [{ nome: 'Carla Reis', data: '2026-02-01', whatsapp: '81911112222', tipo: 'Consulta' }],
    [{ nome: 'Carla Reis', whatsapp: '81900009999', tipo: 'Lead antigo' }]
  );
  const idx = _agIndiceContatos();
  assert.strictEqual(idx.get('carla reis').whatsapp, '81911112222');
});
