// Testes de restauração de backup — rode com: node --test
// Exercitam o importarJSON REAL do app.js contra FileReader, DB e document
// falsos. Restaurar backup é a operação mais destrutiva do app: ela substitui
// coleção inteira. Errar aqui não dá aviso — dá perda.

const { test } = require('node:test');
const assert = require('node:assert');
const { carregar } = require('./_extrair.js');

// Ambiente falso mínimo pro importarJSON. `atraso` simula o tempo real que o
// envio das coleções blindadas leva (lotes de 200 registros).
function ambiente({ conteudo, confirmar = true, atraso = 0, falharEm = [] }) {
  const gravadas = [];
  const eventos = [];
  const input = { files: [{ name: 'backup.json' }], value: 'backup.json' };
  const statusEl = { textContent: '' };

  const DB = {
    set: (k, v) => {
      gravadas.push(k);
      const ok = !falharEm.includes(k);
      return atraso
        ? new Promise(r => setTimeout(() => { eventos.push('push:' + k); r(ok); }, atraso))
        : Promise.resolve((eventos.push('push:' + k), ok));
    },
  };

  const sandbox = {
    document: { getElementById: () => statusEl },
    FileReader: class {
      readAsText() { Promise.resolve().then(() => this.onload({ target: { result: conteudo } })); }
    },
    confirm: () => confirmar,
    alert: (m) => eventos.push('alert:' + String(m).slice(0, 30)),
    toast: () => {},
    setTimeout: (fn) => { eventos.push('reload-agendado'); fn(); return 1; },
    location: { reload: () => eventos.push('RELOAD') },
    JSON, Date, Promise, Array, Error, String, Object, Set,
    localStorage: { setItem: (k, v) => { eventos.push('local:' + k); }, getItem: () => null, removeItem() {} },
    BACKUP_KEYS: ['pacientes', 'crm', 'agendamentos', 'despesas', 'clinica_config', 'audit_log'],
    _BLINDADAS: { pacientes: {}, crm: {}, agendamentos: {} },
    DB,
  };
  const { importarJSON } = carregar(
    ['const:BACKUP_FORMATO', 'const:_CHAVES_SO_LOCAIS', '_backupFormatoInvalido', 'importarJSON'], sandbox);
  return { importarJSON, input, statusEl, gravadas, eventos };
}

const BACKUP_BOM = JSON.stringify({
  _meta: { exportadoEm: '2026-08-03T10:00:00Z' },
  pacientes: [{ id: 'p1', nome: 'Ana' }],
  crm: [{ id: 'c1' }],
  clinica_config: { nome: 'Clínica' },
});

// Espera as promises internas do importarJSON (FileReader + Promise.all).
const assentar = () => new Promise(r => setTimeout(r, 30));

test('importarJSON: restaura as seções reconhecidas do arquivo', async () => {
  const a = ambiente({ conteudo: BACKUP_BOM });
  a.importarJSON(a.input);
  await assentar();
  assert.deepStrictEqual(a.gravadas.sort(), ['clinica_config', 'crm', 'pacientes']);
  assert.match(a.statusEl.textContent, /Restaurado com sucesso/);
});

// O ACHADO: o reload era agendado num timer de 2s enquanto os envios ainda
// estavam voando. As coleções blindadas sobem em lotes; o que não terminasse
// ficava só no localStorage, e o pull seguinte trazia os dados VELHOS por cima
// — o backup "restaurado com sucesso" evaporava sozinho.
test('importarJSON: só recarrega DEPOIS que todo envio terminou', async () => {
  const a = ambiente({ conteudo: BACKUP_BOM, atraso: 20 });
  a.importarJSON(a.input);
  await assentar();
  const iReload = a.eventos.indexOf('RELOAD');
  assert.ok(iReload >= 0, 'o reload precisa acontecer');
  for (const k of ['pacientes', 'crm', 'clinica_config']) {
    assert.ok(a.eventos.indexOf('push:' + k) < iReload,
      `${k} ainda estava subindo quando a página recarregou`);
  }
});

test('importarJSON: envio que falhou NÃO recarrega e avisa quais seções', async () => {
  const a = ambiente({ conteudo: BACKUP_BOM, falharEm: ['pacientes'] });
  a.importarJSON(a.input);
  await assentar();
  assert.ok(!a.eventos.includes('RELOAD'),
    'recarregar aqui só apressa o pull a sobrescrever o que não subiu');
  assert.ok(a.eventos.some(e => e.startsWith('alert:')), 'o usuário tem de ser avisado');
  assert.match(a.statusEl.textContent, /pacientes/);
});

// Coleção blindada tem de ser lista. Gravar um objeto no lugar quebrava toda
// tela que faz .filter/.reduce em cima, e o app não abria mais.
test('importarJSON: recusa arquivo com objeto onde devia haver lista', async () => {
  const a = ambiente({ conteudo: JSON.stringify({ pacientes: { id: 'p1' } }) });
  a.importarJSON(a.input);
  await assentar();
  assert.deepStrictEqual(a.gravadas, [], 'nada pode ser gravado');
  assert.match(a.statusEl.textContent, /Formato inválido/);
  assert.ok(!a.eventos.includes('RELOAD'));
});

test('importarJSON: cancelar no confirm não grava nem recarrega', async () => {
  const a = ambiente({ conteudo: BACKUP_BOM, confirmar: false });
  a.importarJSON(a.input);
  await assentar();
  assert.deepStrictEqual(a.gravadas, []);
  assert.ok(!a.eventos.includes('RELOAD'));
  assert.match(a.statusEl.textContent, /cancelada/);
});

test('importarJSON: arquivo corrompido ou sem seção conhecida não destrói nada', async () => {
  for (const ruim of ['{isso não é json', JSON.stringify({ outra_coisa: [1] }), 'null']) {
    const a = ambiente({ conteudo: ruim });
    a.importarJSON(a.input);
    await assentar();
    assert.deepStrictEqual(a.gravadas, [], `entrada: ${ruim.slice(0, 20)}`);
    assert.match(a.statusEl.textContent, /Erro/);
  }
});

test('importarJSON: limpa o input em todos os caminhos (senão o mesmo arquivo não reabre)', async () => {
  for (const cenario of [{ conteudo: BACKUP_BOM }, { conteudo: 'lixo' }, { conteudo: BACKUP_BOM, confirmar: false }]) {
    const a = ambiente(cenario);
    a.importarJSON(a.input);
    await assentar();
    assert.strictEqual(a.input.value, '');
  }
});

// ---------- nenhuma coleção pode ficar de fora do backup ----------
// BACKUP_KEYS manda em QUATRO rotas: exportarJSON, o snapshot automático,
// restaurarSnapshot e importarJSON. Chave que falta ali não é salva por
// nenhuma delas — e o buraco só aparece no dia em que a pessoa precisa
// restaurar. `profissionais` ficou de fora: todo registro guarda
// `profissionalId`, então sem ela os ids apontam pro vazio (some a cor na
// agenda, o filtro fica sem opções, o repasse de cada um se perde), e
// restaurar o snapshot do dia anterior não desfazia uma exclusão por engano,
// porque o snapshot nunca teve a chave.

// Preferência de tela, não dado do consultório. Restaurar um backup não deve
// trocar a visualização (kanban/tabela) que a pessoa está usando agora.
const FORA_DO_BACKUP_DE_PROPOSITO = ['crm_view'];

test('backup: toda coleção gravada pelo app está em BACKUP_KEYS', () => {
  const { fonte, carregar } = require('./_extrair.js');
  const { BACKUP_KEYS } = carregar('const:BACKUP_KEYS', {});
  const gravadas = new Set(
    [...fonte.matchAll(/DB\.set(?:Obj)?\('([a-z_0-9]+)'/g)].map(m => m[1])
  );
  const faltando = [...gravadas]
    .filter(k => !BACKUP_KEYS.includes(k) && !FORA_DO_BACKUP_DE_PROPOSITO.includes(k))
    .sort();
  assert.deepStrictEqual(faltando, [],
    'estas coleções o app grava mas nenhum backup salva');
});

test('backup: as exceções ainda existem (não viraram órfãs)', () => {
  const { fonte } = require('./_extrair.js');
  for (const k of FORA_DO_BACKUP_DE_PROPOSITO) {
    assert.match(fonte, new RegExp(`DB\\.set(?:Obj)?\\('${k}'`),
      `${k} não é mais gravado — tire da lista de exceções em vez de deixar mentindo`);
  }
});

test('backup: internos de sincronização NÃO podem entrar no backup', () => {
  const { carregar } = require('./_extrair.js');
  const { BACKUP_KEYS } = carregar('const:BACKUP_KEYS', {});
  for (const k of ['_outbox', '_quarentena', '_revs']) {
    assert.ok(!BACKUP_KEYS.includes(k),
      `${k} é estado de sincronização — restaurar isso reenvia ou requarentena coisa velha`);
  }
});

// ---------- formato do arquivo restaurado ----------
// Arquivo com o tipo trocado numa coleção era GRAVADO assim mesmo. Toda tela
// que faz .filter/.reduce em cima quebra na hora de abrir — e como o dado ruim
// já está no localStorage, o app não volta a abrir até limpar o navegador. A
// checagem existia, mas só para as coleções blindadas: despesas,
// procedimentos, programas, profissionais e bloqueios passavam batido, e são
// percorridos exatamente do mesmo jeito.
const puro = (x) => JSON.parse(JSON.stringify(x));
const carregaFormato = () => require('./_extrair.js').carregar(
  ['const:BACKUP_KEYS', 'const:BACKUP_FORMATO', '_backupFormatoInvalido'],
  { Array, Object });

// Pelo caminho REAL do usuário: arquivo com despesas como objeto. Antes a
// validação só olhava as coleções blindadas, então isto era gravado — e a tela
// de Despesas (que faz .filter/.reduce) quebrava toda vez que abrisse.
test('importarJSON: recusa objeto em coleção NÃO blindada (despesas)', async () => {
  const a = ambiente({ conteudo: JSON.stringify({
    _meta: { exportadoEm: '2026-08-03T10:00:00Z' },
    pacientes: [{ id: 'p1' }],
    despesas: { aluguel: 2000 },
  }) });
  a.importarJSON(a.input);
  await assentar();
  assert.deepStrictEqual(puro(a.gravadas), [], 'nada pode ser gravado quando o formato está errado');
  assert.match(a.statusEl.textContent, /Formato inválido.*despesas/);
  assert.ok(!a.eventos.includes('RELOAD'), 'e não recarrega');
});

// ---------- chaves que existem só neste aparelho ----------
// audit_log e chat_history são as ÚNICAS chaves do backup que o app grava com
// localStorage.setItem cru — elas não sincronizam de propósito. Mas restaurar e
// importar as gravavam com DB.set/cloudPush, criando uma linha delas no
// app_data; a partir daí todo cloudPull, em todo aparelho, a cada abertura,
// sobrescrevia o log e o histórico locais com aquele retrato congelado. O
// médico perdia repetidamente o registro do que foi feito desde a restauração.
test('local-only: são exatamente as chaves que o app nunca grava com DB.set', () => {
  const { fonte } = require('./_extrair.js');
  const { BACKUP_KEYS, _CHAVES_SO_LOCAIS } = carregar(
    ['const:BACKUP_KEYS', 'const:_CHAVES_SO_LOCAIS'], { Set });
  const semDbSet = BACKUP_KEYS.filter(k =>
    !new RegExp("DB\\.set(?:Obj)?\\('" + k + "'").test(fonte));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(semDbSet)), [..._CHAVES()],
    'chave que o app nunca sincroniza tem de estar declarada como local — e vice-versa');
  function _CHAVES() { return _CHAVES_SO_LOCAIS; }
});

test('local-only: o pull não aplica linha dessas chaves', () => {
  const { fonte } = require('./_extrair.js');
  const { recortarFuncao } = require('./_extrair.js');
  const corpo = recortarFuncao('cloudPull');
  const guarda = corpo.indexOf('_CHAVES_SO_LOCAIS');
  const grava  = corpo.indexOf("localStorage.setItem('consult_' + row.key");
  assert.ok(guarda > -1, 'sem a guarda, uma linha antiga volta por cima do log a cada abertura');
  assert.ok(guarda < grava, 'a guarda tem de vir ANTES da gravação');
  assert.ok(fonte.length > 0);
});

test('local-only: restaurar e importar gravam sem empurrar pra nuvem', () => {
  const { recortarFuncao } = require('./_extrair.js');
  for (const fn of ['restaurarSnapshot', 'impHandleJSON']) {
    let corpo;
    try { corpo = recortarFuncao(fn); } catch (e) { continue; }
    if (!corpo.includes('cloudPush') && !corpo.includes('DB.set')) continue;
    assert.ok(corpo.includes('_CHAVES_SO_LOCAIS'),
      `${fn} grava e empurra: precisa pular as chaves locais, senão cria a linha no app_data`);
  }
});

test('local-only: importar grava o log SEM criar linha na nuvem', async () => {
  const a = ambiente({ conteudo: JSON.stringify({
    _meta: { exportadoEm: '2026-08-03T10:00:00Z' },
    pacientes: [{ id: 'p1', nome: 'Ana' }],
    audit_log: [{ acao: 'criou' }],
  }) });
  a.importarJSON(a.input);
  await assentar();
  assert.ok(!a.gravadas.includes('audit_log'),
    'DB.set aqui cria a linha no app_data, e o pull passa a devolver este retrato por cima do log real');
  assert.ok(a.eventos.includes('local:consult_audit_log'), 'mas o log TEM de ser restaurado localmente');
  assert.ok(a.gravadas.includes('pacientes'), 'as demais seções continuam subindo');
});

test('formato: o mapa cobre todas as chaves do backup', () => {
  const { BACKUP_KEYS, BACKUP_FORMATO } = carregaFormato();
  // Realm do node:vm: o array volta com outro protótipo e o deepStrictEqual
  // reprova por isso, não pelo conteúdo. Normaliza antes de comparar.
  const semFormato = JSON.parse(JSON.stringify(BACKUP_KEYS.filter(k => !BACKUP_FORMATO[k])));
  assert.deepStrictEqual(semFormato, [],
    'chave sem formato declarado passa sem validação nenhuma');
});

// O mapa não pode virar folclore: tem de bater com como o app REALMENTE lê.
test('formato: lista = DB.get · objeto = DB.getObj, conferido no fonte', () => {
  const { fonte } = require('./_extrair.js');
  const { BACKUP_FORMATO } = carregaFormato();
  const lidasLista = new Set([...fonte.matchAll(/DB\.get\('([a-z_0-9]+)'/g)].map(m => m[1]));
  const lidasObj   = new Set([...fonte.matchAll(/DB\.getObj\('([a-z_0-9]+)'/g)].map(m => m[1]));
  const erros = [];
  for (const [k, esperado] of Object.entries(BACKUP_FORMATO)) {
    if (lidasLista.has(k) && esperado !== 'lista') erros.push(`${k}: lido com DB.get mas marcado ${esperado}`);
    if (lidasObj.has(k)   && esperado !== 'objeto') erros.push(`${k}: lido com DB.getObj mas marcado ${esperado}`);
  }
  assert.deepStrictEqual(erros, []);
});

test('formato: recusa coleção que veio como objeto', () => {
  const { _backupFormatoInvalido } = carregaFormato();
  for (const k of ['despesas', 'procedimentos', 'programas', 'profissionais', 'bloqueios']) {
    assert.deepStrictEqual(puro(_backupFormatoInvalido({ [k]: {} }, [k])), [k],
      `${k} é percorrido com .filter/.reduce — objeto ali derruba a tela`);
    assert.deepStrictEqual(puro(_backupFormatoInvalido({ [k]: [] }, [k])), [],
      'lista vazia é válida: é o estado de quem ainda não cadastrou nada');
  }
});

test('formato: recusa configuração que veio como lista ou nula', () => {
  const { _backupFormatoInvalido } = carregaFormato();
  for (const ruim of [[], null, 'texto', 7]) {
    assert.deepStrictEqual(puro(_backupFormatoInvalido({ agenda_config: ruim }, ['agenda_config'])),
      ['agenda_config'], `agenda_config como ${JSON.stringify(ruim)} não é objeto`);
  }
  assert.deepStrictEqual(puro(_backupFormatoInvalido({ agenda_config: { horaInicio: '08:00' } }, ['agenda_config'])), []);
});

test('formato: chave ausente no arquivo não é julgada', () => {
  const { _backupFormatoInvalido } = carregaFormato();
  assert.deepStrictEqual(puro(_backupFormatoInvalido({}, [])), [],
    'backup parcial é legítimo — só as seções presentes são substituídas');
});

test('restaurarSnapshot: snapshot corrompido avisa em vez de não fazer nada', () => {
  const { recortarFuncao } = require('./_extrair.js');
  const src = recortarFuncao('restaurarSnapshot').replace(/\/\/[^\n]*/g, '');
  assert.match(src, /try \{ snap = JSON\.parse\(raw\); \}/,
    'parse solto dentro de async vira promise rejeitada em silêncio: o botão não faz nada');
  assert.match(src, /_backupFormatoInvalido/, 'e o formato tem de ser conferido antes de gravar');
});

// ---------- arquivo ilegível não pode congelar a tela ----------
// Sem onerror, um arquivo que o navegador não consegue ler (pen drive removido
// depois de escolhido, permissão negada) deixava o status em "Lendo…" PARA
// SEMPRE. Pior: o `input.value = ''` só acontece no fim do onload, que nunca
// chegava — e sem essa limpeza, escolher o MESMO arquivo de novo não dispara
// evento nenhum. A tela congela e nada que a pessoa faça parece ter efeito.
test('importarJSON: falha de leitura avisa e libera o seletor de arquivo', () => {
  const { carregar } = require('./_extrair.js');
  const toasts = [];
  const statusEl = { textContent: '' };
  const input = { files: [{ name: 'backup.json' }], value: 'backup.json' };
  class FR {
    readAsText() { this.onerror && this.onerror(); }
  }
  const { importarJSON } = carregar('importarJSON', {
    FileReader: FR, JSON, Object, Array,
    document: { getElementById: () => statusEl },
    toast: (t) => toasts.push(t),
    BACKUP_KEYS: [], _BLINDADAS: {}, DB: { set: () => Promise.resolve(true) },
  });
  importarJSON(input);
  assert.match(statusEl.textContent, /Não consegui ler o arquivo/,
    'o status não pode ficar preso em "Lendo…"');
  assert.strictEqual(input.value, '',
    'sem limpar, escolher o mesmo arquivo de novo não dispara evento nenhum');
});

test('todo FileReader do app tem onerror', () => {
  const { fonte } = require('./_extrair.js');
  const linhas = fonte.replace(/\/\/[^\n]*/g, '').split('\n');
  const semTratamento = [];
  linhas.forEach((l, i) => {
    if (!/new FileReader\(\)/.test(l)) return;
    const bloco = linhas.slice(i, i + 30).join('\n');
    if (!/onerror/.test(bloco)) semTratamento.push(i + 1);
  });
  assert.deepStrictEqual(semTratamento, [],
    'sem onerror o onload nunca dispara e a tela fica esperando para sempre, calada');
});
