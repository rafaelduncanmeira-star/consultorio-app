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
  const { _limparSensiveisProfissional } = carregar(['_podeVerFinanceiro', '_limparSensiveisProfissional'], {
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
    const { _limparSensiveisProfissional } = carregar(['_podeVerFinanceiro', '_limparSensiveisProfissional'], {
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

// ---------- renderBloqueiosList: XSS armazenado pelo motivo do bloqueio ----------
// A coleção `bloqueios` é um blob de app_data que QUALQUER membro da equipe
// pode gravar (o RLS só barra membro nas chaves financeiras). O motivo era
// injetado cru no innerHTML da tela do dono: um membro mal-intencionado — ou
// com a conta comprometida — executava script na sessão do dono, que é quem tem
// acesso a tudo. Rende também o id dentro do onclick, que pedia _jsArg.
test('renderBloqueiosList: motivo e horas passam por _esc, id por _jsArg', () => {
  const { recortarFuncao } = require('./_extrair.js');
  const src = recortarFuncao('renderBloqueiosList').replace(/\/\/[^\n]*/g, '');
  assert.match(src, /\$\{_esc\(b\.motivo\)\}/, 'motivo é texto livre digitado por gente');
  assert.match(src, /deleteBloqueio\('\$\{_jsArg\(b\.id\)\}'\)/,
    'argumento dentro de onclick pede _jsArg — encodeURIComponent não escapa aspa simples');
  assert.doesNotMatch(src, /\$\{b\.(motivo|horaInicio|horaFim)\b/,
    'nenhum campo do bloqueio pode ir cru pro innerHTML');
});

test('deleteBloqueio: decodifica o id que o _jsArg codificou', () => {
  const { recortarFuncao } = require('./_extrair.js');
  const src = recortarFuncao('deleteBloqueio');
  assert.match(src, /decodeURIComponent\(/,
    'sem o decode, id com caractere especial não casaria e o bloqueio não seria removido');
});

// O par _jsArg/_esc é a defesa; se o _jsArg parar de escapar aspa simples,
// todos os onclick do app ficam abertos de uma vez.
test('_jsArg: escapa a aspa simples que o encodeURIComponent deixa passar', () => {
  const { _jsArg } = carregar('_jsArg', { encodeURIComponent, String });
  const veneno = "x');alert(1);//";
  const saida = _jsArg(veneno);
  assert.ok(!saida.includes("'"), 'nenhuma aspa simples pode sobrar');
  assert.strictEqual(decodeURIComponent(saida), veneno, 'e o valor tem de voltar intacto');
  assert.strictEqual(_jsArg(null), '');
});

// ---------- _podeVerFinanceiro: a UI tem de seguir o RLS ----------
// O RLS (SETUP_SEGURANCA.sql) só deixa o DONO ler/gravar 'despesas' e 'metas*'.
// A sidebar liberava o financeiro pra qualquer currentRole === 'medico',
// inclusive médico MEMBRO de outra clínica: ele lançava a despesa, via a linha
// na tela e o push era recusado em silêncio. A tela mentia.
test('_podeVerFinanceiro: só o médico DONO da clínica', () => {
  const casos = [
    { papel: 'medico',       dono: null,     esperado: true,  nota: 'médico dono' },
    { papel: 'medico',       dono: 'outro',  esperado: false, nota: 'médico MEMBRO de outra clínica' },
    { papel: 'secretaria',   dono: null,     esperado: false, nota: 'secretária dona' },
    { papel: 'profissional', dono: 'outro',  esperado: false, nota: 'profissional membro' },
  ];
  for (const c of casos) {
    const { _podeVerFinanceiro } = carregar('_podeVerFinanceiro', {
      currentRole: c.papel, currentUser: { id: 'eu' }, currentDataOwner: c.dono,
    });
    assert.strictEqual(_podeVerFinanceiro(), c.esperado, c.nota);
  }
});

test('médico MEMBRO não guarda o financeiro da clínica no navegador', () => {
  const removidas = [];
  const { _limparSensiveisProfissional } = carregar(
    ['_podeVerFinanceiro', '_limparSensiveisProfissional'], {
      currentRole: 'medico',
      currentUser: { id: 'membro-1' },
      currentDataOwner: 'dono-1', // membro da equipe de outra pessoa
      localStorage: { removeItem: (k) => removidas.push(k) },
      Object,
    });
  _limparSensiveisProfissional();
  assert.deepStrictEqual(removidas.sort(), [
    'consult_despesas', 'consult_metas', 'consult_metas_proc', 'consult_metas_proc_valor',
  ].sort());
  assert.ok(!removidas.includes('consult_zapi_config'),
    'médico membro segue podendo enviar pela clínica — segredos são outra regra');
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
