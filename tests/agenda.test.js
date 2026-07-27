// Testes do vocabulário de status da agenda — rode com: node --test
//
// O app grava 'No-show' (é a única opção do <select> na agenda), mas três
// pontos do código comparavam com 'Faltou' — um status que a interface nunca
// produziu. O mais grave: a sincronização reversa agendamento → CRM. O paciente
// não aparecia, a secretária marcava No-show, e o card do CRM continuava em
// "Marcou" pra sempre. O funil mostrava como convertido quem não veio.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { carregar, fonte } = require('./_extrair.js');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

// Os status que o <select> da agenda oferece — o vocabulário REAL do produto.
function statusDaAgenda() {
  for (const m of html.matchAll(/<select[^>]*>([\s\S]*?)<\/select>/g)) {
    const opts = [...m[1].matchAll(/<option value="([^"]+)"/g)].map(o => o[1]);
    if (opts.includes('Compareceu')) return opts;
  }
  return [];
}

test('agenda: o select oferece os status que o app espera', () => {
  const opts = statusDaAgenda();
  assert.ok(opts.length, 'o select de status da agenda tem de existir');
  for (const st of ['Pendente', 'Confirmado', 'Compareceu', 'Cancelado']) {
    assert.ok(opts.includes(st), `${st} deveria estar no select`);
  }
});

test('agenda: AG_FALTOU é exatamente o valor que o select grava', () => {
  const { AG_FALTOU } = carregar('const:AG_FALTOU');
  const opts = statusDaAgenda();
  assert.ok(opts.includes(AG_FALTOU),
    `AG_FALTOU é "${AG_FALTOU}" mas o select oferece: ${opts.join(', ')}`);
});

// O guarda contra a reincidência: nenhum ponto do código pode voltar a comparar
// com um literal que a interface não grava.
test('agenda: nada no código compara com o status fantasma "Faltou"', () => {
  const semComentarios = fonte.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(semComentarios, /['"]Faltou['"]/,
    'a interface nunca gravou "Faltou" — comparar com ele é ramo morto');
});

test('agenda: a reversão do CRM cobre falta E cancelamento', () => {
  const { recortarFuncao } = require('./_extrair.js');
  const src = recortarFuncao('updateAgStatus').replace(/\/\/[^\n]*/g, '');
  assert.match(src, /novo === 'Cancelado' \|\| novo === AG_FALTOU/,
    'sem a falta aqui, o card do CRM fica em "Marcou" mesmo com o paciente ausente');
  assert.match(src, /novo === 'Compareceu'/, 'e o caminho de comparecimento continua');
});

// Os outros dois pontos que usavam o literal errado.
test('agenda: lembrete e detecção de vínculos usam a constante', () => {
  for (const fn of ['_agendamentosParaLembrar', '_detectarVinculos']) {
    const { recortarFuncao } = require('./_extrair.js');
    const src = recortarFuncao(fn);
    assert.match(src, /AG_FALTOU/, `${fn} tem de usar a constante, não um literal`);
  }
});

// ---------- config parcial não pode derrubar a agenda ----------
// DB.getObj só usa o default quando a chave NÃO EXISTE: um agenda_config
// parcial passava inteiro. E o app faz `cfg.diasUteis.includes(...)` em oito
// lugares sem guarda — sem esse campo, a tela da agenda quebra toda vez que
// abre. Chega assim por importação de backup (importarJSON grava o objeto
// verbatim) ou arquivo editado à mão.
const carregaCfg = (salvo) => carregar(['const:AG_CONFIG_PADRAO', 'getAgConfig'], {
  DB: { getObj: (k, def) => (salvo === undefined ? def : salvo) },
  Array, Object,
});

test('getAgConfig: config parcial recebe os campos que faltam', () => {
  const { getAgConfig } = carregaCfg({ horaInicio: '08:00' });
  const cfg = getAgConfig();
  assert.strictEqual(cfg.horaInicio, '08:00', 'o que o usuário salvou continua valendo');
  assert.ok(Array.isArray(cfg.diasUteis) && cfg.diasUteis.length, 'diasUteis não pode faltar');
  assert.doesNotThrow(() => cfg.diasUteis.includes(1));
});

test('getAgConfig: objeto vazio ou lixo devolve a configuração padrão', () => {
  for (const ruim of [{}, null, 'nao e objeto', []]) {
    const { getAgConfig } = carregaCfg(ruim);
    const cfg = getAgConfig();
    assert.doesNotThrow(() => cfg.diasUteis.includes(1), `entrada ${JSON.stringify(ruim)}`);
    assert.strictEqual(cfg.slotsSemanais.length, 7);
  }
});

test('getAgConfig: diasUteis vazio ou fora do formato cai no padrão', () => {
  for (const ruim of [[], 'seg,ter', null, 5]) {
    const { getAgConfig } = carregaCfg({ diasUteis: ruim });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(getAgConfig().diasUteis)), [1, 2, 3, 4, 5],
      `diasUteis ${JSON.stringify(ruim)} não serve pra percorrer`);
  }
});

test('getAgConfig: config completa passa intacta', () => {
  const salva = { horaInicio: '09:00', horaFim: '19:00', slotDuracao: 30,
                  almocoInicio: '12:00', almocoFim: '13:00',
                  diasUteis: [1, 3, 5], slotsSemanais: [0, 4, 0, 4, 0, 4, 0] };
  const cfg = carregaCfg(salva).getAgConfig();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(cfg.diasUteis)), [1, 3, 5]);
  assert.strictEqual(cfg.slotDuracao, 30);
});

// ---------- navegar por mês não pode pular (nem travar) ----------
// `setMonth(getMonth() + n)` transborda quando o dia não existe no mês de
// destino, e a âncora da agenda nasce como HOJE — ou seja, com o dia do mês de
// hoje. Em 31/jan, ▶ ia parar em 3 de março: fevereiro sumia da navegação. No
// sentido inverso era pior: em 31/mar, ◀ voltava pra 3 de março e o botão
// parecia morto — clicar não saía do mês.
const { _addMeses } = carregar('_addMeses', { Date, Math });
const dia = (iso) => new Date(iso + 'T12:00:00');
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

test('_addMeses: avançar a partir de dia 31 não pula o mês curto', () => {
  assert.strictEqual(iso(_addMeses(dia('2026-01-31'), 1)), '2026-02-28',
    '31/jan + 1 mês é fevereiro, não março');
  assert.strictEqual(iso(_addMeses(dia('2024-01-31'), 1)), '2024-02-29', 'ano bissexto');
  assert.strictEqual(iso(_addMeses(dia('2026-08-31'), 1)), '2026-09-30');
  assert.strictEqual(iso(_addMeses(dia('2026-01-30'), 1)), '2026-02-28');
});

test('_addMeses: voltar a partir de dia 31 sai mesmo do mês', () => {
  assert.strictEqual(iso(_addMeses(dia('2026-03-31'), -1)), '2026-02-28',
    'o botão de mês anterior tem de sair de março');
  assert.strictEqual(iso(_addMeses(dia('2026-05-31'), -1)), '2026-04-30');
  assert.strictEqual(iso(_addMeses(dia('2026-07-31'), -1)), '2026-06-30');
});

test('_addMeses: um clique sempre muda exatamente um mês, em qualquer dia do ano', () => {
  for (let m = 0; m < 12; m++) {
    for (const d of [1, 15, 28, 29, 30, 31]) {
      const base = new Date(2026, m, 1);
      const ultimo = new Date(2026, m + 1, 0).getDate();
      if (d > ultimo) continue;
      base.setDate(d);
      for (const dir of [1, -1]) {
        const alvo = _addMeses(base, dir);
        const esperado = (m + dir + 12) % 12;
        assert.strictEqual(alvo.getMonth(), esperado,
          `${d}/${m + 1} com dir ${dir} caiu no mês ${alvo.getMonth() + 1}`);
      }
    }
  }
});

test('agendaNavegar: a view de mês usa o helper, não setMonth cru', () => {
  const { recortarFuncao } = require('./_extrair.js');
  const src = recortarFuncao('agendaNavegar');
  assert.match(src, /_addMeses\(agAnchor, dir\)/);
  assert.doesNotMatch(src, /setMonth/, 'setMonth cru aqui reintroduz o pulo de mês');
});

// As duas telas que dizem "sem retorno há 6 meses" (Retenção e os insights do
// Dashboard) tinham contas diferentes: uma comparava texto 'AAAA-MM-DD', a
// outra comparava Date (meia-noite UTC vs. hora local). Discordavam no dia
// exato do corte — o mesmo paciente aparecia numa tela e não na outra.
test('6 meses: as duas telas calculam o corte do mesmo jeito', () => {
  const semCom = fonte.replace(/\/\/[^\n]*/g, '');
  const cortes = [...semCom.matchAll(/const seisStr = ([^;]+);/g)].map(m => m[1].trim());
  assert.strictEqual(cortes.length, 2, 'deveria haver exatamente dois cortes de 6 meses');
  assert.strictEqual(cortes[0], cortes[1], `contas diferentes: ${cortes.join('  ≠  ')}`);
  assert.match(cortes[0], /_addMeses\(new Date\(\), -6\)/);
  assert.doesNotMatch(semCom, /setMonth\(/, 'setMonth cru transborda — use _addMeses');
});
