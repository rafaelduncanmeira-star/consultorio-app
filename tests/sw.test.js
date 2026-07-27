// Testes do Service Worker — rode com: node --test
// Carregam o sw.js REAL num sandbox com self/caches/fetch falsos e disparam os
// handlers de verdade. O SW decide se o app abre ou não; sem teste, um erro
// aqui só aparece no celular do usuário, offline, sem console à mão.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SW = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');

// Lê o nome do cache do PRÓPRIO sw.js. Fixar 'consultorio-v3' aqui fazia os
// testes olharem uma gaveta diferente da que o SW usa — e o teste do erro 500
// passava sem exercitar nada quando a versão mudava.
const CACHE_NAME = /const CACHE_NAME\s*=\s*'([^']+)'/.exec(SW)[1];

// Cache falso: guarda por URL da request.
function cachesFalso(inicial = {}) {
  const stores = { [CACHE_NAME]: { ...inicial } };
  return {
    stores,
    api: {
      open: (nome) => { stores[nome] = stores[nome] || {}; return Promise.resolve({
        addAll: () => Promise.resolve(),
        put: (req, res) => { stores[nome][req.url || req] = res; return Promise.resolve(); },
      }); },
      keys: () => Promise.resolve(Object.keys(stores)),
      delete: (nome) => { delete stores[nome]; return Promise.resolve(true); },
      match: (req) => {
        const chave = req.url || req;
        for (const s of Object.values(stores)) if (chave in s) return Promise.resolve(s[chave]);
        return Promise.resolve(undefined);
      },
    },
  };
}

const resposta = (corpo, { ok = true, status = 200 } = {}) => ({
  corpo, ok, status, clone() { return { ...this, clonada: true }; },
});

// Monta o ambiente, roda o sw.js e devolve os handlers capturados.
function carregarSW({ cache = {}, aoBuscar } = {}) {
  const handlers = {};
  const c = cachesFalso(cache);
  const sandbox = {
    self: {
      addEventListener: (ev, fn) => { handlers[ev] = fn; },
      skipWaiting: () => {},
      clients: { claim: () => {} },
      location: { origin: 'https://app.exemplo.com' },
    },
    caches: c.api,
    fetch: aoBuscar || (() => Promise.reject(new Error('offline'))),
    URL, Promise, Response: { error: () => ({ tipo: 'erro-de-rede' }) },
  };
  vm.createContext(sandbox);
  vm.runInContext(SW, sandbox, { filename: 'sw.js' });
  return { handlers, stores: c.stores, sandbox };
}

// Dispara o handler de fetch e devolve o que o SW respondeu.
function pedir(sw, url, { metodo = 'GET', mode = 'no-cors' } = {}) {
  const req = { url, method: metodo, mode };
  let resposta;
  sw.handlers.fetch({ request: req, respondWith: (p) => { resposta = p; } });
  return resposta;
}

const APP_JS = 'https://app.exemplo.com/app.js';
const INDEX = 'https://app.exemplo.com/';

test('sw: resposta boa vai pro cache', async () => {
  const boa = resposta('conteudo novo');
  const sw = carregarSW({ aoBuscar: () => Promise.resolve(boa) });
  await pedir(sw, APP_JS);
  await new Promise(r => setImmediate(r)); // o put acontece fora da promise devolvida
  assert.ok(sw.stores[CACHE_NAME][APP_JS], 'devia ter guardado');
});

// O ACHADO: não havia checagem de res.ok. Uma página de erro servida durante um
// deploy era gravada no lugar do app.js, e a próxima abertura offline entregava
// esse lixo como se fosse o app — tela branca sem explicação.
test('sw: erro 500 NÃO pode ser gravado por cima do app.js em cache', async () => {
  const bom = resposta('app de verdade');
  const sw = carregarSW({
    cache: { [APP_JS]: bom },
    aoBuscar: () => Promise.resolve(resposta('<html>502 Bad Gateway</html>', { ok: false, status: 502 })),
  });
  await pedir(sw, APP_JS);
  await new Promise(r => setImmediate(r));
  assert.strictEqual(sw.stores[CACHE_NAME][APP_JS], bom,
    'o app bom tem de continuar no cache — erro de deploy não sobrescreve');
});

test('sw: resposta de erro ainda assim chega pra página (não engole o status)', async () => {
  const erro = resposta('nao encontrado', { ok: false, status: 404 });
  const sw = carregarSW({ aoBuscar: () => Promise.resolve(erro) });
  assert.strictEqual((await pedir(sw, APP_JS)).status, 404);
});

test('sw: offline com o arquivo em cache serve o cache', async () => {
  const guardado = resposta('app em cache');
  const sw = carregarSW({ cache: { [APP_JS]: guardado } });  // fetch rejeita
  assert.strictEqual(await pedir(sw, APP_JS), guardado);
});

// O outro achado: o fallback pro index.html valia pra QUALQUER pedido. Um .js
// ou uma imagem que faltasse no cache recebia HTML de volta — o navegador tenta
// executar HTML como script e a página quebra de um jeito bem mais confuso do
// que uma falha de rede honesta.
test('sw: offline sem cache — .js não recebe HTML no lugar', async () => {
  const shell = resposta('<html>shell</html>');
  const sw = carregarSW({ cache: { 'https://app.exemplo.com/index.html': shell } });
  const r = await pedir(sw, 'https://app.exemplo.com/nao-existe.js', { mode: 'no-cors' });
  assert.notStrictEqual(r, shell, 'devolver o shell como script quebra a página');
  assert.strictEqual(r.tipo, 'erro-de-rede', 'falha de rede honesta');
});

test('sw: offline sem cache — navegação recebe o shell, que é o certo', async () => {
  const shell = resposta('<html>shell</html>');
  const sw = carregarSW({ cache: { './index.html': shell } });
  assert.strictEqual(await pedir(sw, INDEX, { mode: 'navigate' }), shell);
});

test('sw: POST e outra origem passam direto, sem o SW se meter', () => {
  const sw = carregarSW({ aoBuscar: () => Promise.resolve(resposta('x')) });
  assert.strictEqual(pedir(sw, APP_JS, { metodo: 'POST' }), undefined, 'POST não é interceptado');
  assert.strictEqual(pedir(sw, 'https://xyz.supabase.co/rest/v1/app_data'), undefined,
    'chamada ao Supabase não pode passar pelo cache do SW');
});

test('sw: activate apaga cache de versão anterior e mantém a atual', async () => {
  const sw = carregarSW();
  sw.stores['consultorio-versao-antiga'] = { velho: 1 };
  let espera;
  sw.handlers.activate({ waitUntil: (p) => { espera = p; } });
  await espera;
  assert.ok(!('consultorio-versao-antiga' in sw.stores), 'versão antiga tem de sair');
  assert.ok(CACHE_NAME in sw.stores, 'a atual fica');
});

// ---------- aviso de versão nova ----------
// O service worker é network-first e o skipWaiting já põe a versão nova no ar —
// mas só na PRÓXIMA navegação. Este app foi feito pra ficar aberto a semana
// inteira numa recepção: quem não recarrega segue rodando a versão antiga
// indefinidamente, inclusive depois de uma correção de dado, e nada avisava.
const { carregar: _carr, recortarFuncao: _rec2, fonte: _fnt } = require('./_extrair.js');

function ambienteSW() {
  const toasts = [];
  let ouvinteUpdate = null;
  const novo = { state: 'installing', _ouvintes: {},
    addEventListener(ev, fn) { this._ouvintes[ev] = fn; } };
  const reg = {
    installing: novo,
    addEventListener(ev, fn) { if (ev === 'updatefound') ouvinteUpdate = fn; },
    update: () => Promise.resolve(),
  };
  const s = _carr(['_observarAtualizacaoSW', '_checarAtualizacaoSW'], {
    _swRegistro: null, _avisouVersaoNova: false,
    navigator: { serviceWorker: { controller: {} } },
    toast: (t) => toasts.push(t),
    console: { warn() {} },
  });
  return { ...s, reg, novo, toasts, dispararUpdate: () => ouvinteUpdate && ouvinteUpdate() };
}

test('avisa quando uma versão nova termina de instalar', () => {
  const a = ambienteSW();
  a._observarAtualizacaoSW(a.reg);
  a.dispararUpdate();
  a.novo.state = 'installed';
  a.novo._ouvintes.statechange();
  assert.match(a.toasts.join(' '), /Versão nova disponível/);
  assert.match(a.toasts.join(' '), /recarregue/i, 'o aviso tem de dizer o que fazer');
});

test('não avisa na PRIMEIRA visita (não há o que atualizar)', () => {
  const toasts = [];
  let ouvinte = null;
  const novo = { state: 'installing', _o: {}, addEventListener(e, f) { this._o[e] = f; } };
  const reg = { installing: novo, addEventListener: (e, f) => { if (e === 'updatefound') ouvinte = f; } };
  const s = _carr('_observarAtualizacaoSW', {
    _swRegistro: null, _avisouVersaoNova: false,
    navigator: { serviceWorker: { controller: null } },  // ninguém no controle ainda
    toast: (t) => toasts.push(t),
  });
  s._observarAtualizacaoSW(reg);
  ouvinte();
  novo.state = 'installed';
  novo._o.statechange();
  assert.deepStrictEqual(toasts, [],
    'sem controller, é a primeira instalação — avisar ali só assusta');
});

test('avisa uma vez só, não a cada checagem', () => {
  const a = ambienteSW();
  a._observarAtualizacaoSW(a.reg);
  a.dispararUpdate();
  a.novo.state = 'installed';
  a.novo._ouvintes.statechange();
  a.novo._ouvintes.statechange();
  assert.strictEqual(a.toasts.length, 1);
});

test('a checagem periódica não estoura promise sem catch', () => {
  const s = _carr('_checarAtualizacaoSW', {
    _swRegistro: { update: () => Promise.reject(new Error('offline')) },
    console: { warn() {} },
  });
  assert.doesNotThrow(() => s._checarAtualizacaoSW(),
    'update() rejeita quando está offline, e isso roda a cada 15 minutos');
});

test('a checagem entra na rodada do dia, antes do guard de sessão', () => {
  const src = _rec2('_rodarTarefasDoDia').replace(/\/\/[^\n]*/g, '');
  const iCheca = src.indexOf('_checarAtualizacaoSW()');
  const iGuard = src.indexOf('if (!currentUser) return;');
  assert.ok(iCheca >= 0 && iCheca < iGuard,
    'procurar versão nova não depende de estar logado');
});
