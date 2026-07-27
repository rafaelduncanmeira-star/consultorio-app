// Extrator de funções do app.js para teste — SEM dependências externas.
// Lê o código-fonte real do app.js, recorta uma função pelo nome (casando chaves)
// e a avalia num sandbox isolado (node:vm) com globals "de browser" stubados.
// Assim os testes exercitam o MESMO código que roda em produção, sem precisar
// carregar o app.js inteiro (que dispara init, listeners, Supabase, etc.).

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP_JS = path.join(__dirname, '..', 'app.js');
const fonte = fs.readFileSync(APP_JS, 'utf8');

// Recorta o texto de `[async] function <nome>(...) { ... }` casando as chaves.
// O `async` faz parte do recorte: sem ele o corpo era avaliado como função
// comum e todo `await` dentro dela virava erro de sintaxe.
function recortarFuncao(nome) {
  const assinatura = new RegExp('(?:async\\s+)?function\\s+' + nome + '\\s*\\(');
  const m = assinatura.exec(fonte);
  if (!m) throw new Error(`Função não encontrada no app.js: ${nome}`);
  // Pula a LISTA DE PARÂMETROS antes de procurar o corpo. Um parâmetro com
  // valor padrão de objeto — `function f(a, opts = {})` — tem chave própria, e
  // o `indexOf('{')` cru parava nela: o recorte virava só a assinatura, e o
  // teste morria com "Unexpected end of input" em vez de dizer o que houve.
  let par = 0, fechaParams = -1;
  for (let i = m.index + m[0].length - 1; i < fonte.length; i++) {
    if (fonte[i] === '(') par++;
    else if (fonte[i] === ')') { par--; if (par === 0) { fechaParams = i; break; } }
  }
  if (fechaParams === -1) throw new Error(`Parâmetros não fecharam para: ${nome}`);
  const abreChave = fonte.indexOf('{', fechaParams);
  if (abreChave === -1) throw new Error(`Corpo não encontrado para: ${nome}`);
  let profundidade = 0;
  for (let i = abreChave; i < fonte.length; i++) {
    const c = fonte[i];
    if (c === '{') profundidade++;
    else if (c === '}') {
      profundidade--;
      if (profundidade === 0) return fonte.slice(m.index, i + 1);
    }
  }
  throw new Error(`Chaves não fecharam para: ${nome}`);
}

// Recorta uma constante de módulo (`const NOME = <valor>;`) — pro teste usar o
// MESMO valor do app em vez de repetir o número e passar a mentir quando ele mudar.
// Reemitida como `var` de propósito: num contexto do node:vm, `const`/`let` ficam
// no escopo léxico e NÃO viram propriedade do sandbox — o teste não conseguiria lê-la.
function recortarConst(nome) {
  const m = new RegExp('^const\\s+' + nome + '\\s*=\\s*', 'm').exec(fonte);
  if (!m) throw new Error(`Constante não encontrada no app.js: ${nome}`);
  const ini = m.index + m[0].length;
  // Valor pode ser objeto/array de VÁRIAS linhas — vai até o `;` que fecha,
  // contando chaves e colchetes. A versão anterior parava na primeira quebra de
  // linha e simplesmente não achava constantes multilinha.
  let prof = 0, fim = -1;
  for (let i = ini; i < fonte.length; i++) {
    const c = fonte[i];
    if (c === '{' || c === '[') prof++;
    else if (c === '}' || c === ']') prof--;
    else if (c === ';' && prof === 0) { fim = i; break; }
  }
  if (fim === -1) throw new Error(`Valor da constante não terminou: ${nome}`);
  return `var ${nome} = ${fonte.slice(ini, fim)};`;
}

// Avalia uma ou mais funções num sandbox compartilhado. `globais` permite
// stubar dependências (DB, localStorage, currentRole, etc.).
// Nome prefixado com `const:` é recortado como constante, não como função.
function carregar(nomes, globais = {}) {
  const sandbox = Object.assign({}, globais);
  const codigo = (Array.isArray(nomes) ? nomes : [nomes])
    .map(n => n.startsWith('const:') ? recortarConst(n.slice(6)) : recortarFuncao(n))
    .join('\n');
  vm.createContext(sandbox);
  vm.runInContext(codigo + '\n', sandbox, { filename: 'app.js (recorte)' });
  return sandbox;
}

module.exports = { recortarFuncao, carregar, fonte };
