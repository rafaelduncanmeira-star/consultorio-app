// Prazo das chamadas de rede — rode com: node --test
//
// O fetch() do navegador não tem prazo. Provedor que aceita a conexão TCP e
// nunca responde deixa a promise pendurada para sempre: não resolve, não
// rejeita, e nenhum catch/finally roda. Não é falha teórica — o wa-webhook
// já se protege com AbortSignal.timeout. No app o estrago é pior porque a
// página continua viva depois: a trava de reentrância do ciclo de lembretes
// fica presa em `true` e nenhum paciente é lembrado de novo naquela sessão;
// o input do chat da IA fica desabilitado até recarregar.

const { test } = require('node:test');
const assert = require('node:assert');
const { carregar, recortarFuncao, fonte } = require('./_extrair.js');

function ambiente() {
  let fetchArgs = null;
  let resolverFetch = null;
  const timers = new Map();
  let proximo = 1;
  const s = carregar(['_fetchComPrazo', 'const:_PRAZO_REDE', 'const:_PRAZO_REDE_CURTO'], {
    AbortController,
    fetch: (url, opts) => {
      fetchArgs = { url, opts };
      return new Promise((res, rej) => { resolverFetch = { res, rej }; });
    },
    setTimeout: (fn, ms) => { const id = proximo++; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
  });
  return {
    ...s,
    timers,
    get fetchArgs() { return fetchArgs; },
    get resolverFetch() { return resolverFetch; },
    // dispara o timer pendente como o navegador faria ao vencer o prazo
    vencerPrazo() {
      const [id, t] = [...timers.entries()][0];
      timers.delete(id);
      t.fn();
    },
  };
}

test('requisição pendurada rejeita quando o prazo vence — não fica eterna', async () => {
  const a = ambiente();
  const p = a._fetchComPrazo('https://exemplo/x', { method: 'POST' });
  let assentou = false;
  p.then(() => { assentou = true; }, () => { assentou = true; });
  await Promise.resolve();
  assert.equal(assentou, false, 'antes do prazo a promise segue pendente');

  a.vencerPrazo();   // o AbortController aborta o fetch
  await assert.rejects(p, /Tempo esgotado/,
    'passado o prazo a chamada TEM de rejeitar — senão o finally do chamador nunca roda');
});

test('o prazo é armado com o valor pedido e o sinal chega ao fetch', () => {
  const a = ambiente();
  a._fetchComPrazo('https://exemplo/x', { method: 'POST' }, 4321);
  assert.equal([...a.timers.values()][0].ms, 4321);
  assert.ok(a.fetchArgs.opts.signal, 'o fetch precisa receber o signal, senão o abort não corta nada');
  assert.equal(a.fetchArgs.opts.method, 'POST', 'as opções originais têm de ser preservadas');
});

test('sem prazo explícito usa o padrão, e o curto é menor que ele', () => {
  const a = ambiente();
  a._fetchComPrazo('https://exemplo/x');
  assert.equal([...a.timers.values()][0].ms, a._PRAZO_REDE);
  assert.ok(a._PRAZO_REDE_CURTO < a._PRAZO_REDE);
  assert.ok(a._PRAZO_REDE_CURTO > 0);
});

test('resposta dentro do prazo passa limpa e o timer é desarmado', async () => {
  const a = ambiente();
  const p = a._fetchComPrazo('https://exemplo/x');
  a.resolverFetch.res({ ok: true, marca: 42 });
  const res = await p;
  assert.equal(res.marca, 42);
  assert.equal(a.timers.size, 0, 'timer pendurado por 30s a cada chamada é vazamento');
});

test('erro de rede real preserva a mensagem original', async () => {
  const a = ambiente();
  const p = a._fetchComPrazo('https://exemplo/x');
  a.resolverFetch.rej(new Error('Failed to fetch'));
  await assert.rejects(p, /Failed to fetch/,
    'só o abort vira "tempo esgotado"; queda de wi-fi tem de continuar dizendo o que foi');
});

test('nenhuma chamada a servidor de terceiro usa fetch() cru', () => {
  // O único fetch cru legítimo é o de dentro do próprio helper — tira ele fora
  // em vez de afrouxar o detector (detector afrouxado deixa de acusar bug real).
  // (troca por linhas em branco, não por vazio, pra o número da linha acusada
  // continuar batendo com o app.js)
  const src = fonte.replace(recortarFuncao('_fetchComPrazo'),
                            m => '\n'.repeat(m.split('\n').length - 1));
  const nus = [];
  src.split('\n').forEach((linha, i) => {
    const m = linha.match(/(?<![\w.])fetch\s*\(\s*[`'"]?(https?:|\$\{|url\b)/);
    if (m) nus.push((i + 1) + ': ' + linha.trim().slice(0, 90));
  });
  assert.deepStrictEqual(nus, [],
    'toda chamada externa passa por _fetchComPrazo — fetch cru fica pendurado para sempre');
});
