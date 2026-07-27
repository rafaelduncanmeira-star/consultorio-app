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
