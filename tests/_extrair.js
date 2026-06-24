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

// Recorta o texto de `function <nome>(...) { ... }` casando as chaves.
function recortarFuncao(nome) {
  const assinatura = new RegExp('function\\s+' + nome + '\\s*\\(');
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

// Avalia uma ou mais funções num sandbox compartilhado. `globais` permite
// stubar dependências (DB, localStorage, currentRole, etc.).
function carregar(nomes, globais = {}) {
  const sandbox = Object.assign({}, globais);
  const codigo = (Array.isArray(nomes) ? nomes : [nomes])
    .map(recortarFuncao)
    .join('\n');
  vm.createContext(sandbox);
  vm.runInContext(codigo + '\n', sandbox, { filename: 'app.js (recorte)' });
  return sandbox;
}

module.exports = { recortarFuncao, carregar, fonte };
