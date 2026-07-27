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
  const abreChave = fonte.indexOf('{', m.index);
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
  const m = new RegExp('^const\\s+' + nome + '\\s*=\\s*([^;\\n]+);', 'm').exec(fonte);
  if (!m) throw new Error(`Constante não encontrada no app.js: ${nome}`);
  return `var ${nome} = ${m[1]};`;
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
