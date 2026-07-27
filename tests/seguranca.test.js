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

// ---------- _foneE164BR × _zapiPhoneCandidates: os dois provedores têm de concordar ----------
// A Cloud API fazia `startsWith('55') ? phone : '55' + phone`, que confunde DDI
// com o DDD 55 (Santa Maria/RS). O Z-API já normalizava certo. Resultado: o
// mesmo paciente recebia (ou não) dependendo do provedor configurado.
const FONES = [
  ['11987654321',   '5511987654321', 'celular SP sem DDI'],
  ['5511987654321', '5511987654321', 'celular SP com DDI'],
  ['55987654321',   '5555987654321', 'celular DDD 55 sem DDI — 55 é o DDD'],
  ['5555987654321', '5555987654321', 'celular DDD 55 com DDI'],
  ['5532201234',    '555532201234',  'fixo DDD 55 sem DDI'],
  ['555532201234',  '555532201234',  'fixo DDD 55 com DDI'],
];

test('_foneE164BR: monta 55 + DDD + número sem confundir DDI com DDD', () => {
  const { _foneE164BR } = carregar('_foneE164BR', { String });
  for (const [entrada, esperado, desc] of FONES) {
    assert.strictEqual(_foneE164BR(entrada), esperado, `${desc}: ${entrada}`);
  }
  assert.strictEqual(_foneE164BR(''), '');
  assert.strictEqual(_foneE164BR(null), '');
});

test('_foneE164BR concorda com o 1º candidato do Z-API', () => {
  const s = carregar(['_foneE164BR', '_zapiPhoneCandidates'], { String, RegExp });
  for (const [entrada, , desc] of FONES) {
    assert.strictEqual(s._foneE164BR(entrada), s._zapiPhoneCandidates(entrada)[0],
      `${desc}: os dois provedores não podem discordar do mesmo telefone`);
  }
});

// ---------- mfaVerificarSeNecessario: o portão de 2FA tem de falhar FECHADO ----------
// Este é o ÚNICO portão de 2FA do app — o RLS não checa AAL. Então devolver
// "pode entrar" quando a verificação falha é o mesmo que não ter 2FA.
function supaMfa({ aal, aalErr, factors, factorsErr, verifyErr } = {}) {
  return { auth: { mfa: {
    getAuthenticatorAssuranceLevel: async () => ({ data: aalErr ? null : aal, error: aalErr || null }),
    listFactors: async () => ({ data: factorsErr ? null : { totp: factors || [] }, error: factorsErr || null }),
    challenge: async () => ({ data: { id: 'ch1' }, error: null }),
    verify: async () => ({ data: {}, error: verifyErr || null }),
  } } };
}
const carregaMfa = (supa) => carregar('mfaVerificarSeNecessario', { _supa: supa, Promise });

test('mfa: listar fatores falhando NÃO pode liberar o login', async () => {
  const { mfaVerificarSeNecessario } = carregaMfa(supaMfa({
    aal: { currentLevel: 'aal1', nextLevel: 'aal2' },
    factorsErr: { message: 'network' },
  }));
  const r = await mfaVerificarSeNecessario();
  assert.ok(!r.ok, 'uma falha de rede não pode virar "entra sem segunda etapa"');
  assert.ok(r.error, 'tem de devolver erro pro chamador barrar');
});

test('mfa: não conseguir ler o nível exigido também barra', async () => {
  const { mfaVerificarSeNecessario } = carregaMfa(supaMfa({ aalErr: { message: 'timeout' } }));
  const r = await mfaVerificarSeNecessario();
  assert.ok(!r.ok);
  assert.ok(r.error);
});

test('mfa: conta que exige 2FA e não tem fator verificado é barrada', async () => {
  const { mfaVerificarSeNecessario } = carregaMfa(supaMfa({
    aal: { currentLevel: 'aal1', nextLevel: 'aal2' },
    factors: [{ id: 'f1', status: 'unverified' }],   // cadastro abandonado
  }));
  const r = await mfaVerificarSeNecessario();
  assert.ok(!r.ok, 'fator não verificado não vale como segunda etapa');
  assert.ok(r.error);
});

test('mfa: com fator verificado, pede o código', async () => {
  const { mfaVerificarSeNecessario } = carregaMfa(supaMfa({
    aal: { currentLevel: 'aal1', nextLevel: 'aal2' },
    factors: [{ id: 'f-antigo', status: 'unverified' }, { id: 'f-bom', status: 'verified' }],
  }));
  const r = await mfaVerificarSeNecessario();
  assert.strictEqual(r.needsCode, true);
  assert.strictEqual(r.factorId, 'f-bom', 'escolhe o verificado, não o primeiro da lista');
});

test('mfa: código errado não passa; código certo passa', async () => {
  const base = { aal: { currentLevel: 'aal1', nextLevel: 'aal2' }, factors: [{ id: 'f1', status: 'verified' }] };
  const ruim = carregaMfa(supaMfa({ ...base, verifyErr: { message: 'invalid' } }));
  assert.ok((await ruim.mfaVerificarSeNecessario('000000')).error);
  const bom = carregaMfa(supaMfa(base));
  assert.strictEqual((await bom.mfaVerificarSeNecessario('123456')).ok, true);
});

test('mfa: quem não usa 2FA entra normalmente', async () => {
  const { mfaVerificarSeNecessario } = carregaMfa(supaMfa({
    aal: { currentLevel: 'aal1', nextLevel: 'aal1' },
  }));
  const r = await mfaVerificarSeNecessario();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.noMfa, true);
});

// O segundo furo estava no CHAMADOR: mfaVerificarSeNecessario já devolvia
// { error } quando não conseguia ler o nível exigido, mas os dois pontos de
// entrada só olhavam `needsCode` — o erro era ignorado e o app iniciava em
// aal1. Como esses trechos mexem em DOM e sessão, o guarda é no código-fonte.
test('login e checkSession barram quando o 2FA não pôde ser confirmado', () => {
  const { fonte } = require('./_extrair.js');
  // Todo trecho que chama o portão tem de tratar mfaCheck.error logo em seguida.
  const chamadas = [...fonte.matchAll(/mfaVerificarSeNecessario\([^)]*\)/g)];
  assert.ok(chamadas.length >= 2, 'esperava os dois pontos de entrada');
  for (const m of chamadas) {
    const depois = fonte.slice(m.index, m.index + 700);
    if (/^\s*async function/.test(depois)) continue;     // a definição, não uma chamada
    if (!/mfaCheck/.test(depois)) continue;              // chamada com código (fluxo do modal)
    assert.match(depois, /mfaCheck\.error/,
      'o resultado de erro do portão de 2FA não pode ser ignorado');
    assert.match(depois, /signOut\(\)/,
      'sessão em aal1 tem de ser derrubada, não deixada de pé');
  }
});

// ---------- resolveDataOwner: o dono não pode ser adotado como membro ----------
// Se a consulta que descobre "tenho clínica própria?" falha, o código antigo
// concluía QUE NÃO TEM — e adotava o vínculo de equipe. O dono passava a ver a
// clínica de outra pessoa na tela e a gravar os registros novos lá dentro.
function supaOwner({ appData, appDataErr, atend, atendErr, membroDe }) {
  const resposta = (data, error) => Promise.resolve({ data, error: error || null });
  return {
    from: (tabela) => ({
      select: () => ({
        eq: () => ({
          limit: () => {
            if (tabela === 'app_data') return resposta(appDataErr ? null : (appData || []), appDataErr);
            if (tabela === 'clinica_atendimentos') return resposta(atendErr ? null : (atend || []), atendErr);
            if (tabela === 'team_members') return resposta(membroDe ? [{ owner_id: membroDe, role: 'secretaria' }] : []);
            return resposta([]);
          },
          eq: () => ({ limit: () => resposta([]) }),
        }),
      }),
    }),
  };
}
function rodarOwner(supa) {
  const s = carregar(['_temClinicaPropria', 'resolveDataOwner'], {
    _supa: supa, currentUser: { id: 'eu' },
    currentDataOwner: null, currentTeamRole: null, currentProfissionalId: null,
    currentRole: 'medico', console: { warn() {}, log() {} }, Promise,
  });
  return s.resolveDataOwner().then(() => s);
}

test('resolveDataOwner: erro ao checar a clínica própria não entrega o dono a outra clínica', async () => {
  const s = await rodarOwner(supaOwner({ appDataErr: { message: 'network' }, membroDe: 'outro-dono' }));
  assert.strictEqual(s.currentDataOwner, 'eu', 'na dúvida, fica com a própria clínica');
  assert.strictEqual(s.currentTeamRole, 'owner');
});

test('resolveDataOwner: quem tem clínica própria não vira membro, mesmo em equipe', async () => {
  const s = await rodarOwner(supaOwner({ appData: [{ key: 'clinica_config' }], membroDe: 'outro-dono' }));
  assert.strictEqual(s.currentDataOwner, 'eu');
  assert.strictEqual(s.currentTeamRole, 'owner');
});

// O blob do app_data é APAGADO depois que a coleção migra pra tabela blindada.
// Checar só o app_data fazia um dono antigo parecer "sem clínica".
test('resolveDataOwner: clínica que só tem atendimentos na tabela blindada conta', async () => {
  const s = await rodarOwner(supaOwner({ appData: [], atend: [{ id: 'a1' }], membroDe: 'outro-dono' }));
  assert.strictEqual(s.currentDataOwner, 'eu', 'atendimento gravado É clínica própria');
});

test('resolveDataOwner: quem realmente não tem clínica adota a equipe', async () => {
  const s = await rodarOwner(supaOwner({ appData: [], atend: [], membroDe: 'dono-real' }));
  assert.strictEqual(s.currentDataOwner, 'dono-real');
  assert.strictEqual(s.currentTeamRole, 'member');
});

test('resolveDataOwner: sem clínica e sem equipe, é dono de si mesmo', async () => {
  const s = await rodarOwner(supaOwner({ appData: [], atend: [] }));
  assert.strictEqual(s.currentDataOwner, 'eu');
  assert.strictEqual(s.currentTeamRole, 'owner');
});

// ---------- perfil ilegível não pode virar "primeiro login" ----------
// Os dois caminhos de login liam profiles com o error descartado. Falha de
// leitura ficava indistinguível de "não existe perfil" — e nesse ramo o papel
// vem do user_metadata (que o próprio usuário controla via auth.updateUser, e
// cujo padrão aqui é 'medico') e é GRAVADO por cima do perfil real. Uma falha
// de rede promovia o usuário, de forma permanente.
test('login: erro de leitura do perfil não pode cair no ramo de primeiro login', () => {
  const { fonte } = require('./_extrair.js');
  // Ancora no destructuring, que e onde o error apareceria — comecar no
  // from('profiles') deixaria justamente essa parte de fora do trecho.
  // Só os dois de login: `profile` (singular) lendo role+nome. O
  // `const { data: profiles }` da listagem de equipe nao entra aqui.
  const trechos = [...fonte.matchAll(/const \{ data: profile\b[\s\S]{0,900}/g)]
    .filter(m => m[0].includes("'role, nome'"));
  assert.ok(trechos.length >= 2, 'esperava os dois pontos de login');
  for (const t of trechos) {
    const bloco = t[0];
    assert.match(bloco, /error:\s*errPerfil/,
      'o error da consulta de perfil tem de ser lido');
    assert.match(bloco, /PGRST116/,
      'só "linha inexistente" (PGRST116) é primeiro login; o resto é falha de leitura');
    // O upsert que grava o papel do metadata não pode ser alcançado por erro.
    const posGuarda = bloco.indexOf('PGRST116');
    const posUpsert = bloco.indexOf("upsert({ id: currentUser.id");
    assert.ok(posUpsert === -1 || posGuarda < posUpsert,
      'a guarda tem de vir ANTES do upsert que grava o papel');
  }
});

test('login: o papel padrão do metadata é privilegiado — por isso a guarda importa', () => {
  const { fonte } = require('./_extrair.js');
  // Se um dia o padrão deixar de ser 'medico', este teste avisa que o risco mudou.
  assert.match(fonte, /meta\.role \|\| 'medico'/,
    'o ramo de primeiro login assume medico quando o metadata não diz nada');
});

// ---------- listarMembros / listarConvites: lista vazia por erro é mentira ----------
// A tela de Equipe cai no estado "compartilhe seu consultório" quando as listas
// vêm vazias. Com o error descartado, uma falha de conexão produzia exatamente
// esse estado — o dono podia concluir que perdeu a equipe, ou reconvidar quem
// já está dentro. É a mesma tela que serve pra CONFERIR papéis depois da falha
// de privilégio, então mentir aqui atrapalha justamente a verificação.
function supaLista(resposta) {
  const cadeia = { select: () => cadeia, eq: () => cadeia, in: () => cadeia,
                   order: () => Promise.resolve(resposta), then: (f) => Promise.resolve(resposta).then(f) };
  return { from: () => cadeia };
}

test('listarConvites: erro devolve null (não uma lista vazia)', async () => {
  const { listarConvites } = carregar('listarConvites', {
    _supa: supaLista({ data: null, error: { message: 'network' } }),
    currentUser: { id: 'eu' }, console: { warn() {} }, Promise,
  });
  assert.strictEqual(await listarConvites(), null);
});

test('listarConvites: sem convite nenhum devolve lista vazia (isso é verdade)', async () => {
  const { listarConvites } = carregar('listarConvites', {
    _supa: supaLista({ data: [], error: null }),
    currentUser: { id: 'eu' }, console: { warn() {} }, Promise,
  });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(await listarConvites())), []);
});

test('listarMembros: erro devolve null; equipe vazia devolve lista vazia', async () => {
  const comErro = carregar('listarMembros', {
    _supa: supaLista({ data: null, error: { message: 'rls' } }),
    currentUser: { id: 'eu' }, currentDataOwner: null, console: { warn() {} }, Promise,
  });
  assert.strictEqual(await comErro.listarMembros(), null);

  const vazio = carregar('listarMembros', {
    _supa: supaLista({ data: [], error: null }),
    currentUser: { id: 'eu' }, currentDataOwner: null, console: { warn() {} }, Promise,
  });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(await vazio.listarMembros())), []);
});

test('renderEquipeCard: distingue lista vazia de lista que não pôde ser lida', () => {
  const { recortarFuncao } = require('./_extrair.js');
  const src = recortarFuncao('renderEquipeCard').replace(/\/\/[^\n]*/g, '');
  assert.match(src, /membros === null \|\| convites === null/,
    'sem esta distinção a tela mostra "compartilhe seu consultório" pra quem já tem equipe');
});

// ---------- os dois arquivos SQL não podem discordar do accept_invite ----------
// accept_invite é definido em SETUP_EQUIPE.sql e redefinido em
// SETUP_EQUIPE_PROFISSIONAL.sql. Como os dois usam `create or replace`, rodar o
// primeiro depois do segundo REVERTE as correções. Duas delas eram graves:
// sem a checagem de e-mail, qualquer um que recebesse o link (mandado por
// WhatsApp, que é encaminhável) entrava na clínica; e o `update profiles set
// role` trancava o dono fora do próprio financeiro.
test('SETUP_EQUIPE.sql: accept_invite não pode reverter as correções de segurança', () => {
  const fs = require('node:fs'), path = require('node:path');
  const sql = fs.readFileSync(path.join(__dirname, '..', 'SETUP_EQUIPE.sql'), 'utf8');
  const fn = sql.slice(sql.indexOf('create or replace function accept_invite'));
  assert.ok(fn.length > 0, 'a função tem de estar no arquivo');
  assert.doesNotMatch(fn, /update\s+profiles\s+set\s+role/,
    'sobrescrever profiles.role tranca o dono fora da própria clínica');
  assert.match(fn, /auth\.email\(\)/,
    'o convite é nominal: sem checar o e-mail, o link entra em qualquer mão');
});

test('SETUP_EQUIPE.sql: avisa que sobrescreve o que arquivos posteriores restringem', () => {
  const fs = require('node:fs'), path = require('node:path');
  const sql = fs.readFileSync(path.join(__dirname, '..', 'SETUP_EQUIPE.sql'), 'utf8');
  const cabecalho = sql.slice(0, 1400);
  assert.match(cabecalho, /SETUP_SEGURANCA/, 'a ordem de execução tem de estar no topo');
  assert.match(cabecalho, /REVERTE|reverte/, 'o risco de re-rodar tem de estar explícito');
});

// ---------- migração não pode chutar o dono do registro ----------
// _migrarIds roda a CADA cloudPull e carimba inscrições/follow-ups sem
// profissionalId. Usava _profDoPaciente, que cai no profissional LOGADO quando
// não acha o paciente. Numa clínica com vários profissionais, o primeiro a
// abrir o app levava pra si todos os registros sem dono — e como o RLS das
// coleções blindadas filtra por profissional_id, os outros perdiam de vista os
// próprios pacientes.
const PACS_PROF = [
  { nome: 'Ana Lima',  profissionalId: 'prof_A' },
  { nome: 'Bruno Sá',  profissionalId: 'prof_B' },
  { nome: 'Sem Dono' },                              // paciente sem profissional
];
const carregaEstrito = () => carregar('_profDoPacienteEstrito', {
  DB: { get: () => PACS_PROF }, currentProfissionalId: 'prof_LOGADO',
});

test('_profDoPacienteEstrito: acha pelo histórico do paciente', () => {
  const { _profDoPacienteEstrito } = carregaEstrito();
  assert.strictEqual(_profDoPacienteEstrito('Ana Lima'), 'prof_A');
  assert.strictEqual(_profDoPacienteEstrito('  bruno sá '), 'prof_B', 'ignora caixa e espaço');
});

test('_profDoPacienteEstrito: NÃO cai no profissional logado', () => {
  const { _profDoPacienteEstrito } = carregaEstrito();
  for (const desconhecido of ['Zuleica', 'Sem Dono', '', null, undefined, '   ']) {
    assert.strictEqual(_profDoPacienteEstrito(desconhecido), null,
      `"${desconhecido}" não pode ser atribuído ao profissional que abriu o app`);
  }
});

// A versão não-estrita continua caindo no logado — e isso está certo na
// CRIAÇÃO de registro, onde quem cria é quem atende.
test('_profDoPaciente (não-estrito) mantém o fallback para quem está criando', () => {
  const { _profDoPaciente } = carregar('_profDoPaciente', {
    DB: { get: () => PACS_PROF }, currentProfissionalId: 'prof_LOGADO',
  });
  assert.strictEqual(_profDoPaciente('Zuleica'), 'prof_LOGADO');
  assert.strictEqual(_profDoPaciente('Ana Lima'), 'prof_A', 'histórico ainda ganha');
});

test('_migrarIds usa a versão estrita, não a que chuta', () => {
  const { recortarFuncao } = require('./_extrair.js');
  const src = recortarFuncao('_migrarIds').replace(/\/\/[^\n]*/g, '');
  assert.match(src, /_profDoPacienteEstrito\(/, 'a migração tem de usar a estrita');
  assert.doesNotMatch(src, /[^A-Za-z]_profDoPaciente\(/,
    'a versão que cai no profissional logado não pode voltar pra migração');
});

// ---------- botão travado para sempre ----------
// Estas funções desabilitam o botão ANTES de operações assíncronas e são
// chamadas direto de um onclick — que não tem catch. Qualquer exceção (rede
// caindo no meio do login, uma tela do _iniciarApp() quebrando ao renderizar)
// rejeitava a promise em silêncio e deixava "Entrando…" travado PARA SEMPRE,
// sem mensagem. A pessoa acha que errou a senha, tenta de novo, e o botão nem
// responde: só recarregando a página.
const { recortarFuncao: _rec } = require('./_extrair.js');

for (const [fn, rotulo] of [['doLogin', 'Entrar'], ['doSignup', 'Criar conta gratuita'],
                            ['confirmar2FA', 'Ativar 2FA'], ['iaSugerirNoChat', 'Sugerir']]) {
  test(`${fn}: o botão volta mesmo se o await lançar`, () => {
    const src = _rec(fn).replace(/\/\/[^\n]*/g, '');
    assert.match(src, /\bdisabled\s*=\s*true/, 'a premissa: a função trava o botão');
    assert.match(src, /\}\s*finally\s*\{[\s\S]*?disabled\s*=\s*false/,
      `${fn} precisa restaurar o botão num finally — só nos caminhos felizes não basta`);
    assert.match(src, new RegExp(`finally\\s*\\{[\\s\\S]*?${rotulo}`),
      'e restaurar também o texto, senão fica "Entrando…" num botão clicável');
  });
}

test('doLogin: exceção no meio do login derruba a sessão (falha fechado)', () => {
  const src = _rec('doLogin').replace(/\/\/[^\n]*/g, '');
  assert.match(src, /catch \(e\) \{[\s\S]*?signOut\(\)/,
    'não dá pra saber onde parou — seguir com a sessão pela metade é pior que pedir de novo');
  assert.match(src, /catch \(e\) \{[\s\S]*?errEl\.style\.display = 'block'/,
    'e a pessoa tem de ver uma mensagem, não um botão morto');
});

// ---------- o copiloto não pode recitar o que a tela esconde ----------
// _podeVerFinanceiro() é o gate do financeiro no app inteiro: sidebar, showPage
// e _applyRole consultam ele. O prompt do copiloto era a QUARTA porta e não
// consultava. Médico MEMBRO de outra clínica tem Faturamento, Lucro, DRE e
// Preços bloqueados na interface — e bastava perguntar "quem tá devendo?" no
// chat pra receber a lista com nomes e valores. O próprio prompt ensinava a IA
// a responder exatamente isso.
const CTX_BASE = {
  hoje: '2026-08-05', amanha: '2026-08-06', mesAtual: '2026-08', mesAnt: '2026-07',
  faturamento: 48000, despesas: 12000, lucro: 36000, faturamentoAnt: 41000,
  variacaoMes: '17.1', projecaoMes: 60000, metaFat: 50000, metaPac: 40, pctMeta: '96.0',
  pacientesMes: 38, pagos: 30, pendentes: 8, totalPendente: 7300,
  pacPendentesLista: 'Ana (R$ 1.000, 02/08) | Bruno (R$ 900, 03/08)',
  ticketMedio: 1263, procBreakdown: 'Consulta:30', noShowsMes: 2,
  crmTotal: 12, crmMarcouPendente: 3, crmMarcados: 'Ana', followupHoje: 1,
  followupPendenteNomes: 'Ana', followupLista: 'Ana (vence 2026-08-05)',
  agendaHoje: '09:00 Ana', agendaAmanha: 'vazia', agendaSemana: 'vazia',
  procedimentos: 'Consulta: PIX R$1000/Cartão R$1050',
  todosPacientes: 'Ana|2026-08-02|Consulta|R$ 1.000,00|Pendente',
};

const promptCom = (veFinanceiro) => require('./_extrair.js').carregar('buildSystemPrompt', {
  getClinicaConfig: () => ({ nome: 'Clínica X', especialidade: 'Geriatria', cidade: 'SP' }),
  currentNome: 'Fulano', currentRole: 'medico', String, Number, Math,
}).buildSystemPrompt({ ...CTX_BASE, veFinanceiro });

test('prompt: quem NÃO passa no gate não recebe financeiro nenhum', () => {
  const p = promptCom(false);
  // Valores da CLÍNICA. ("1050" solto não serve: o prompt usa esse número num
  // exemplo de como interpretar "mil e cinquenta" falado, que não é dado dela.)
  for (const vazado of ['48000', '36000', '12000', 'Quem deve', 'FINANCEIRO:',
                        'TABELA DE PREÇOS', 'PIX R$1000/Cartão R$1050', '7300',
                        'Bruno (R$ 900', 'R$ 1.000,00|Pendente']) {
    assert.ok(!p.includes(vazado), `vazou "${vazado}" pra quem a tela esconde o financeiro`);
  }
});

test('prompt: sem os dados, as instruções não mandam a IA respondê-los', () => {
  const p = promptCom(false);
  assert.ok(!p.includes('liste os nomes e valores'),
    'instruir sem ter o dado faz a IA inventar número — pior que recusar');
  assert.match(p, /não estão disponíveis no seu acesso/);
  assert.match(p, /NÃO invente valor/,
    'a regra de preencher valor mandava consultar a tabela de preços — que agora não está no prompt');
});

test('prompt: quem passa no gate continua recebendo tudo', () => {
  const p = promptCom(true);
  for (const esperado of ['FINANCEIRO:', 'Quem deve', 'TABELA DE PREÇOS',
                          'Lucro líquido', 'liste os nomes e valores']) {
    assert.ok(p.includes(esperado), `o dono perdeu "${esperado}" do prompt`);
  }
});

test('prompt: a agenda e o CRM continuam valendo para os dois', () => {
  for (const ve of [true, false]) {
    const p = promptCom(ve);
    assert.match(p, /AGENDA:/);
    assert.match(p, /CRM E FOLLOW-UP:/);
    assert.ok(p.includes('09:00 Ana'), 'agenda não é financeiro — profissional precisa dela');
  }
});

test('contexto: o histórico de consultas esconde valor e status de pagamento', () => {
  const src = require('./_extrair.js').fonte;
  const i = src.indexOf('const todosPacientes = pacs.slice(0, 50)');
  assert.ok(i > 0, 'a premissa: o histórico é montado aqui');
  const trecho = src.slice(i, i + 400);
  assert.match(trecho, /veFinanceiro\s*\n?\s*\?/,
    'sem o gate, cada linha do histórico leva o valor e o statusPgto junto');
});
