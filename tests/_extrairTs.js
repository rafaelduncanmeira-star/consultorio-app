// Extrator de funções da Edge Function (TypeScript) — irmão do _extrair.js.
//
// Por que existe: a agenda que a secretária de IA oferece ao paciente é
// calculada no wa-webhook, não no app.js. Testar só o app.js deixava a metade
// que fala com o paciente sem nenhuma cobertura.
//
// Como funciona: recorta as funções pedidas do index.ts, escreve num arquivo
// .ts temporário e deixa o Node fazer o type-stripping nativo (v22.6+). Nada
// de reimplementar a lógica no teste — o que roda aqui é o texto real do
// arquivo que vai pro Supabase. O `import` do supabase-js (specifier `jsr:`,
// que o Node não resolve) fica de fora porque só recortamos as funções.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const INDEX_TS = path.join(__dirname, '..', 'supabase', 'functions', 'wa-webhook', 'index.ts');
const fonte = fs.readFileSync(INDEX_TS, 'utf8');

// Acha a chave que abre o CORPO. Não dá pra pegar a primeira `{` depois do
// nome: um tipo de retorno inline (`): { texto: string; livres: Set<string> }`)
// vem antes, e casar por ela recorta só a assinatura. A regra aqui é que a
// chave do corpo é a última da linha da assinatura — vale pra todo o index.ts,
// e um recorte errado não passa silenciosamente: o require() do .ts estoura.
function _abreCorpo(desde) {
  for (let i = desde; i < fonte.length; i++) {
    if (fonte[i] !== '{') continue;
    const fimLinha = fonte.indexOf('\n', i);
    if (fimLinha === -1 || !fonte.slice(i + 1, fimLinha).trim()) return i;
  }
  return -1;
}

function recortarFuncao(nome) {
  const assinatura = new RegExp('(?:async\\s+)?function\\s+' + nome + '\\s*[(<]');
  const m = assinatura.exec(fonte);
  if (!m) throw new Error(`Função não encontrada no index.ts: ${nome}`);
  const abreChave = _abreCorpo(m.index);
  if (abreChave === -1) throw new Error(`Corpo não encontrado para: ${nome}`);
  let profundidade = 0;
  for (let i = abreChave; i < fonte.length; i++) {
    if (fonte[i] === '{') profundidade++;
    else if (fonte[i] === '}' && --profundidade === 0) return fonte.slice(m.index, i + 1);
  }
  throw new Error(`Chaves não fecharam para: ${nome}`);
}

function recortarConst(nome) {
  const m = new RegExp('^const\\s+' + nome + '\\s*(?::[^=\\n]+)?=\\s*([^;\\n]+);', 'm').exec(fonte);
  if (!m) throw new Error(`Constante não encontrada no index.ts: ${nome}`);
  return `const ${nome} = ${m[1]};`;
}

let seq = 0;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-webhook-'));
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} });

// Nome prefixado com `const:` é recortado como constante, não como função.
// Devolve o módulo com as funções pedidas já exportadas.
function carregarTs(nomes) {
  const lista = Array.isArray(nomes) ? nomes : [nomes];
  const trechos = lista.map(n => n.startsWith('const:') ? recortarConst(n.slice(6)) : recortarFuncao(n));
  const exportar = lista.filter(n => !n.startsWith('const:'));
  const arquivo = path.join(dir, `recorte${seq++}.ts`);
  fs.writeFileSync(arquivo, trechos.join('\n\n') + `\n\nmodule.exports = { ${exportar.join(', ')} };\n`);
  return require(arquivo);
}

module.exports = { carregarTs, recortarFuncao, fonte };
