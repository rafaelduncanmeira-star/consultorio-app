// Guarda de VOCABULÁRIO — rode com: node --test
//
// Vários bugs desta revisão foram a mesma coisa: duas partes do produto
// falando línguas diferentes sobre o mesmo campo.
//
//   · o <select> do modal não tinha 'Parcial' → editar e salvar apagava o status
//   · o código comparava com 'Faltou', mas a agenda grava 'No-show' → o card do
//     CRM nunca voltava pra "Não marcou" quando o paciente faltava
//
// Os dois são invisíveis: nada quebra, o ramo simplesmente nunca roda. Este
// arquivo transforma a varredura que os encontrou num teste permanente.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const raiz = path.join(__dirname, '..');
const app  = fs.readFileSync(path.join(raiz, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(raiz, 'index.html'), 'utf8');
const webhook = fs.readFileSync(path.join(raiz, 'supabase/functions/wa-webhook/index.ts'), 'utf8');

// Comparações que NÃO são vocabulário de domínio. Cada entrada precisa de
// motivo — se você está adicionando uma linha aqui, confirme antes que o valor
// realmente vem de fora do app.
const LEGITIMAS = new Map([
  ['Chart === "undefined"',       'typeof — biblioteca externa pode não ter carregado'],
  ['rev === "number"',            'typeof'],
  ['message === "string"',        'typeof'],
  ['waitUntil === "function"',    'typeof'],
  ['status === "verified"',       'estado de fator MFA — vocabulário do Supabase Auth'],
  ['nextLevel === "aal2"',        'nível de garantia — vocabulário do Supabase Auth'],
  ['status === "null"',           'guarda deliberada: string "null" vinda de dado legado'],
  ['status === "undefined"',      'idem'],
  ['role === "system-ok"',        'papel interno das bolhas do chat do copiloto'],
  ['status === "CONNECTED"',      'estado da instância — vocabulário do Z-API'],
  ['value === "CONNECTED"',       'idem'],
  ['object === "whatsapp_business_account"', 'tipo do payload — vocabulário da Meta'],
  ['visibilityState === "visible"', 'estado da aba — vocabulário do navegador (Page Visibility API)'],
  ['state === "installed"',        'estado do worker — vocabulário da Service Worker API'],
  ['update === "function"',        'typeof — método pode não existir em navegador antigo'],
]);

// Campos genéricos demais pra essa análise dizer algo útil.
const CAMPOS_IGNORADOS = /^(length|type|code|name|id|nodeName|tagName|method|provider|remetente|tipo)$/;

function comparacoesSuspeitas() {
  const tudo = app + '\n' + webhook;

  // Vocabulário conhecido: tudo que o código GRAVA num campo…
  const gravados = new Map();
  const anota = (campo, valor) => {
    if (!gravados.has(campo)) gravados.set(campo, new Set());
    gravados.get(campo).add(valor);
  };
  // Extração ESTREITA de propósito: só o literal colado no `:` ou no `=`.
  // Tentei alargar pra pegar ternários e o resultado foi pior — com quase tudo
  // contando como "gravado", o teste parava de acusar até os bugs reais.
  // Falso positivo pontual entra em LEGITIMAS com o motivo; perder o sinal, não.
  for (const m of tudo.matchAll(/\b([a-zA-Z_]\w*)\s*:\s*'([^']{1,40})'/g)) anota(m[1], m[2]);
  for (const m of tudo.matchAll(/\.([a-zA-Z_]\w*)\s*=\s*'([^']{1,40})'/g)) anota(m[1], m[2]);
  // Ternário como valor: `campo: cond ? 'a' : 'b'` — os dois lados contam.
  for (const m of tudo.matchAll(/\b([a-zA-Z_]\w*)\s*:[^\n]*\?[^\n]*?:\s*'([^']{1,40})'/g)) anota(m[1], m[2]);

  // …e tudo que a interface oferece.
  const daInterface = new Set();
  for (const m of html.matchAll(/<option(?:\s+value="([^"]*)")?[^>]*>([^<]*)</g)) {
    const v = (m[1] !== undefined ? m[1] : m[2]).trim();
    if (v) daInterface.add(v);
  }
  for (const m of html.matchAll(/'([^']{2,40})'/g)) daInterface.add(m[1]);

  const suspeitas = [];
  // Cobre igualdade E desigualdade: dois dos três pontos do bug do 'Faltou'
  // eram `a.status !== 'Faltou'`, e uma varredura só de `===` deixava passar.
  for (const m of tudo.matchAll(/\.([a-zA-Z_]\w*)\s*[!=]==?\s*'([^']{2,40})'/g)) {
    const [, campo, valor] = m;
    if (CAMPOS_IGNORADOS.test(campo)) continue;
    if ((gravados.get(campo) || new Set()).has(valor)) continue;
    if (daInterface.has(valor)) continue;
    suspeitas.push(`${campo} === ${JSON.stringify(valor)}`);   // normaliza !== como ===
  }
  return [...new Set(suspeitas)];
}

test('nenhuma comparação com valor que o app nunca grava (ramo morto)', () => {
  const novas = comparacoesSuspeitas().filter(c => !LEGITIMAS.has(c));
  assert.deepStrictEqual(novas, [],
    'Estas comparações usam um valor que nada no app grava nem oferece na interface.\n' +
    'Provavelmente são ramos que NUNCA rodam — foi assim com \'Faltou\' vs \'No-show\'.\n' +
    'Se for vocabulário externo (Supabase, Meta, Z-API) ou typeof, acrescente em\n' +
    'LEGITIMAS com o motivo. Se não for, é bug.\n\nSuspeitas: ' + novas.join(' · '));
});

// A lista de exceções não pode envelhecer sozinha: se uma entrada deixar de
// existir no código, ela some daqui também.
test('a lista de exceções não guarda entrada morta', () => {
  const atuais = new Set(comparacoesSuspeitas());
  const orfas = [...LEGITIMAS.keys()].filter(k => !atuais.has(k));
  assert.deepStrictEqual(orfas, [],
    'estas exceções não correspondem mais a nada no código — remova de LEGITIMAS');
});

// Todo status de pagamento que o app grava tem de existir no <select> do modal.
// Foi a falta de 'Parcial' que apagava o status ao salvar.
test('todo status de pagamento gravado existe no select do modal', () => {
  const m = /<select class="select" name="statusPgto">([\s\S]*?)<\/select>/.exec(html);
  assert.ok(m, 'o select de status de pagamento tem de existir');
  const oferecidos = [...m[1].matchAll(/<option>([^<]+)</g)].map(o => o[1].trim());
  const gravados = [...app.matchAll(/statusPgto:\s*'([^']+)'/g)].map(x => x[1]);
  for (const st of new Set(gravados)) {
    assert.ok(oferecidos.includes(st),
      `o app grava statusPgto '${st}', mas o select só oferece: ${oferecidos.join(', ')}`);
  }
});

// ---------- status do CRM produzido por LLM ----------
// O Kanban agrupa por igualdade: `data.filter(r => r.status === col.status)`.
// Card com status fora das cinco colunas não cai em NENHUMA — some da tela. E
// quem produz esse campo é o LLM (extração de conversa colada do WhatsApp e
// ação criar_crm do copiloto), que inventa rótulo.
const { carregar } = require('./_extrair.js');

test('_statusCrmCanonico: só passa status que existe como coluna do Kanban', () => {
  const { _statusCrmCanonico, KANBAN_COLUNAS } =
    carregar(['const:KANBAN_COLUNAS', '_statusCrmCanonico']);
  for (const col of KANBAN_COLUNAS) {
    assert.strictEqual(_statusCrmCanonico(col.status), col.status, `${col.status} é coluna válida`);
  }
});

test('_statusCrmCanonico: rótulo inventado pelo LLM cai na primeira coluna', () => {
  const { _statusCrmCanonico } = carregar(['const:KANBAN_COLUNAS', '_statusCrmCanonico']);
  for (const inventado of ['Novo', 'Lead', 'Primeiro contato', 'contato feito', '', null, undefined]) {
    assert.strictEqual(_statusCrmCanonico(inventado), 'Contato feito',
      `"${inventado}" não é coluna — o card ficaria invisível no Kanban`);
  }
});

// Todo caminho que cria contato no CRM precisa gerar id: o _pushBlindada filtra
// por id, então registro sem id NÃO sobe pro servidor — fica só no aparelho.
test('todo caminho de criação no CRM gera id estável', () => {
  // A extração do WhatsApp montava o objeto sem id — os outros quatro caminhos
  // do CRM já geravam o id na criação.
  const ini = app.indexOf('waExtracted = {');
  assert.ok(ini > 0, 'o objeto do contato extraído tem de existir');
  const bloco = app.slice(ini, ini + 700);
  assert.match(bloco, /id:\s*_novoId\('crm'\)/,
    'contato extraído do WhatsApp sem id não é enviado ao servidor');
  assert.match(bloco, /status:\s*_statusCrmCanonico\(/,
    'o status vindo do LLM tem de ser validado antes de virar card');
});

// ---------- todo registro de coleção blindada nasce com id ----------
// _pushBlindada filtra por id: `newArr.filter(r => r && r.id)`. Registro criado
// sem id NÃO sobe pro servidor — fica só naquele aparelho, e some quando o
// usuário troca de dispositivo. Aconteceu duas vezes: no contato extraído do
// WhatsApp e no follow-up de reativação.
const BLINDADAS_COL = ['pacientes', 'agendamentos', 'crm', 'inscricoes', 'followup'];

test('_pushBlindada continua exigindo id (a premissa deste teste)', () => {
  const { recortarFuncao } = require('./_extrair.js');
  const src = recortarFuncao('_pushBlindada');
  assert.match(src, /filter\(r => r && r\.id\)/,
    'se isto mudar, o raciocínio dos testes abaixo precisa ser revisto');
});

test('criarFollowupReativacao gera id e dono', () => {
  const { recortarFuncao } = require('./_extrair.js');
  const src = recortarFuncao('criarFollowupReativacao').replace(/\/\/[^\n]*/g, '');
  assert.match(src, /id:\s*_novoId\('fu'\)/, 'sem id o follow-up não chega ao servidor');
  assert.match(src, /profissionalId:/, 'sem dono ele fica fora do recorte por profissional');
  assert.match(src, /_profDoPacienteEstrito/,
    'atribuição automática não pode chutar o profissional logado');
});

// A garantia REAL não é varrer os caminhos de criação um a um — varredura
// estática não distingue "objeto novo" de "registro existente devolvido por
// .find() no desfazer da exclusão", e erra dos dois lados. A garantia é o
// DB.set carimbar o id de quem chegar sem ele, antes de gravar. Aí não importa
// quantas telas novas apareçam: nenhuma consegue criar registro invisível.
//
// Antes disso, o conserto vinha só do _migrarIds — que roda dentro do
// cloudPull, ou seja, na CARGA do app. Entre criar o registro e recarregar,
// ele não existia pro servidor.

// DB é um objeto literal: recorta como constante e roda contra um
// localStorage e um _pushBlindada de mentira.
function montarDB() {
  const { carregar } = require('./_extrair.js');
  const mem = new Map();
  const empurrado = [];
  const sandbox = carregar(['const:_BLINDADAS', 'const:DB', '_novoId'], {
    JSON, Array, Object, Date, Math,
    localStorage: {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => mem.set(k, v),
    },
    _enfileirarPush: (k, fn) => fn(),
    _pushBlindada: (tabela, old, novo) => { empurrado.push({ tabela, novo }); return Promise.resolve(true); },
    _outboxRemove: () => {}, _outboxAdd: () => {}, _outboxGet: () => ({}),
    cloudPush: () => Promise.resolve(),
  });
  return { DB: sandbox.DB, BLINDADAS: sandbox._BLINDADAS, empurrado,
           lido: (k) => JSON.parse(mem.get('consult_' + k) || '[]') };
}

test('_BLINDADAS: toda coleção blindada tem prefixo de id', () => {
  const { BLINDADAS } = montarDB();
  for (const col of BLINDADAS_COL) {
    assert.ok(BLINDADAS[col], `${col} deveria estar em _BLINDADAS`);
    assert.ok(BLINDADAS[col].pref, `sem pref o DB.set não sabe carimbar ${col}`);
  }
});

test('DB.set carimba id em registro que chega sem ele', async () => {
  for (const col of BLINDADAS_COL) {
    const { DB, BLINDADAS, empurrado, lido } = montarDB();
    await DB.set(col, [{ nome: 'sem id' }, { id: 'ja_tinha', nome: 'com id' }]);
    const salvo = lido(col);
    assert.ok(salvo[0].id, `${col}: registro sem id continuou sem id`);
    assert.match(salvo[0].id, new RegExp('^' + BLINDADAS[col].pref + '_'),
      `${col}: prefixo do id fora do padrão do _migrarIds`);
    assert.strictEqual(salvo[1].id, 'ja_tinha', `${col}: id existente não pode ser trocado`);
    // E o que subiu pro servidor tem de ser o array JÁ carimbado — senão o
    // filter(r => r && r.id) do _pushBlindada descarta o registro do mesmo jeito.
    assert.strictEqual(empurrado.length, 1, `${col}: deveria ter empurrado uma vez`);
    assert.ok(empurrado[0].novo.every(r => r.id), `${col}: subiu registro sem id`);
  }
});

test('DB.set não carimba coleção que não é blindada', async () => {
  const { DB, lido } = montarDB();
  await DB.set('despesas', [{ descricao: 'aluguel' }]);
  assert.strictEqual(lido('despesas')[0].id, undefined,
    'despesas vai no blob e não passa pelo filtro por id — carimbar aqui seria ruído');
});

// ---------- forma de pagamento: vocabulário único ----------
// O <select> do modal, o TAXA_PAGAMENTO e as três tabelas de "Mix de pagamento"
// (Receita, DRE e relatório) usam a mesma lista de cinco formas e filtram com
// `p.pagamento === f`. Valor fora dela some da tabela sem erro nenhum, e as
// linhas passam a somar menos que o próprio Total. O copiloto gravava o que o
// LLM mandasse — "pix", "Cartão Crédito " — direto no registro.
const { carregar: _carrega } = require('./_extrair.js');

test('pagamento: a lista do código é a mesma do <select> do modal', () => {
  const html = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'index.html'), 'utf8');
  const { FORMAS_PAGAMENTO } = _carrega('const:FORMAS_PAGAMENTO', {});
  const bloco = html.slice(html.indexOf('name="pagamento"'));
  const opcoes = [...bloco.slice(0, bloco.indexOf('</select>')).matchAll(/<option>([^<]+)<\/option>/g)]
    .map(m => m[1]);
  assert.deepStrictEqual(opcoes, JSON.parse(JSON.stringify(FORMAS_PAGAMENTO)),
    'select e código divergindo é a definição do problema');
});

test('pagamento: a tabela de taxas cobre exatamente as cinco formas', () => {
  const s = _carrega(['const:FORMAS_PAGAMENTO', 'const:TAXA_PAGAMENTO'], {});
  assert.deepStrictEqual(Object.keys(s.TAXA_PAGAMENTO).sort(),
    [...s.FORMAS_PAGAMENTO].sort(),
    'forma sem taxa declarada entra como 0% e some da estimativa de custo de cartão');
});

test('_pagamentoCanonico conserta caixa e espaço, e não chuta o resto', () => {
  const { _pagamentoCanonico } = _carrega(
    ['const:FORMAS_PAGAMENTO', '_pagamentoCanonico'], { String });
  assert.strictEqual(_pagamentoCanonico('pix'), 'PIX');
  assert.strictEqual(_pagamentoCanonico('  DINHEIRO '), 'Dinheiro');
  assert.strictEqual(_pagamentoCanonico('Cartão Crédito'), 'Cartão crédito');
  assert.strictEqual(_pagamentoCanonico('boleto'), '',
    'inventar a forma seria afirmar como o paciente pagou');
  assert.strictEqual(_pagamentoCanonico(''), '');
  assert.strictEqual(_pagamentoCanonico(null), '');
});

test('nenhuma tela reescreve a lista de formas de pagamento à mão', () => {
  const { fonte } = require('./_extrair.js');
  const linhas = fonte.split('\n');
  const ruins = [];
  linhas.forEach((l, i) => {
    if (l.includes('const FORMAS_PAGAMENTO')) return;
    if (/'Cartão crédito'\s*,\s*'Cartão débito'/.test(l)) ruins.push((i + 1) + ': ' + l.trim().slice(0, 100));
  });
  assert.deepStrictEqual(ruins, [],
    'cópia inline diverge — foi assim que o Mix de pagamento e o select se desencontraram');
});

test('editRow guarda forma de pagamento fora do vocabulário como opção legada', () => {
  const { recortarFuncao } = require('./_extrair.js');
  const src = recortarFuncao('editRow');
  // O mecanismo é o mesmo de todos os outros <select> do modal
  // (_opcaoLegadaSeFaltar): sem a opção, o select fica com selectedIndex -1 e o
  // save devolve '' — a forma de pagamento é APAGADA.
  const i = src.indexOf('_opcaoLegadaSeFaltar(form.pagamento');
  assert.ok(i > 0, 'forma de pagamento fora do vocabulário some ao abrir e salvar');
  assert.ok(i < src.indexOf("form.pagamento.value = r.pagamento"),
    'a opção tem de ser acrescentada ANTES da atribuição');
});
