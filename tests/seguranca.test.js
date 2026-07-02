// Testes da camada de segurança/blindagem — rode com: node --test
// Exercitam o código REAL recortado do app.js (ver tests/_extrair.js).

const { test } = require('node:test');
const assert = require('node:assert');
const { carregar } = require('./_extrair.js');

// ---------- _esc: escape de HTML (anti-XSS) ----------
test('_esc neutraliza tags e atributos perigosos', () => {
  const { _esc } = carregar('_esc');
  assert.strictEqual(_esc('<script>alert(1)</script>'),
    '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.strictEqual(_esc('<img src=x onerror=alert(1)>'),
    '&lt;img src=x onerror=alert(1)&gt;');
  assert.strictEqual(_esc(`"' & <>`), '&quot;&#39; &amp; &lt;&gt;');
});

test('_esc trata nulo/indefinido como string vazia', () => {
  const { _esc } = carregar('_esc');
  assert.strictEqual(_esc(null), '');
  assert.strictEqual(_esc(undefined), '');
});

test('_esc preserva texto normal (sem falso positivo)', () => {
  const { _esc } = carregar('_esc');
  assert.strictEqual(_esc('Maria de Souza'), 'Maria de Souza');
  assert.strictEqual(_esc('Dr. João — Cardiologia'), 'Dr. João — Cardiologia');
  assert.strictEqual(_esc(42), '42');
});

// ---------- _limparSensiveisProfissional: blindagem do financeiro + segredos ----------
test('profissional perde financeiro E segredos de integração no localStorage', () => {
  const removidas = [];
  const store = {
    consult_despesas: '[...]', consult_metas: '{...}',
    consult_metas_proc: '{}', consult_metas_proc_valor: '{}',
    consult_zapi_config: '{token}', consult_wa_cloud_config: '{token}',
    consult_llm_config: '{chaves}', consult_gemini_key_secure: '"g"',
    consult_pacientes: '[...]', // NÃO deve ser removido
  };
  const { _limparSensiveisProfissional } = carregar('_limparSensiveisProfissional', {
    currentRole: 'profissional',
    currentUser: { id: 'membro-1' },
    currentDataOwner: 'dono-1', // é MEMBRO da equipe de outra pessoa
    localStorage: {
      removeItem: (k) => { removidas.push(k); delete store[k]; },
    },
    Object, // Object.keys(localStorage) no snapshot-clean
  });
  _limparSensiveisProfissional();
  assert.deepStrictEqual(removidas.filter(k => k.startsWith('consult_')).sort(), [
    'consult_despesas', 'consult_metas', 'consult_metas_proc', 'consult_metas_proc_valor',
    'consult_zapi_config', 'consult_wa_cloud_config', 'consult_llm_config', 'consult_gemini_key_secure',
  ].sort());
  assert.ok('consult_pacientes' in store, 'dados clínicos não podem ser apagados');
});

test('médico e secretária mantêm o financeiro intacto', () => {
  for (const papel of ['medico', 'secretaria']) {
    const removidas = [];
    const { _limparSensiveisProfissional } = carregar('_limparSensiveisProfissional', {
      currentRole: papel,
      currentUser: { id: 'dono-1' },
      currentDataOwner: null, // é o próprio dono
      localStorage: { removeItem: (k) => removidas.push(k) },
      Object,
    });
    _limparSensiveisProfissional();
    assert.strictEqual(removidas.length, 0, `papel ${papel} não deveria perder financeiro`);
  }
});

// ---------- _profDoPaciente: resolução do dono do paciente (isolamento) ----------
test('_profDoPaciente acha o profissional pelo nome (case/espaço-insensível)', () => {
  const pacientes = [
    { nome: 'Ana Lima', profissionalId: 'prof-1' },
    { nome: 'Bruno Sá', profissionalId: 'prof-2' },
  ];
  const { _profDoPaciente } = carregar('_profDoPaciente', {
    DB: { get: () => pacientes },
    currentProfissionalId: 'prof-fallback',
  });
  assert.strictEqual(_profDoPaciente('  ana lima '), 'prof-1');
  assert.strictEqual(_profDoPaciente('BRUNO SÁ'), 'prof-2');
});

test('_profDoPaciente cai no profissional logado quando não encontra', () => {
  const { _profDoPaciente } = carregar('_profDoPaciente', {
    DB: { get: () => [] },
    currentProfissionalId: 'prof-logado',
  });
  assert.strictEqual(_profDoPaciente('Desconhecido'), 'prof-logado');
});
