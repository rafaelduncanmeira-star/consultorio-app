// Testes das melhorias de usabilidade (saudação, autocomplete, banner de mês
// vazio) — rode com: node --test. Exercitam o código REAL do app.js.

const { test } = require('node:test');
const assert = require('node:assert');
const { carregar } = require('./_extrair.js');

// ---------- toast: o aviso invisível que bloqueava a nav do celular ----------
// O toast é position:fixed, z-index 9999, e some só com opacity:0 — mas
// opacidade zero NÃO desliga clique. Ele fica no DOM interceptando toque em
// cima da #mob-bottom-nav (z-index 150), que ocupa os 58px de baixo. Depois do
// primeiro toast da sessão, o botão central da nav parava de responder.
function domFalso() {
  const criados = [];
  const novo = (tag) => {
    const el = {
      tag, id: '', type: '', textContent: '', innerHTML: '', disabled: false,
      onclick: null, filhos: [],
      style: { cssText: '', opacity: '', pointerEvents: '' },
      appendChild(f) { this.filhos.push(f); return f; },
    };
    criados.push(el);
    return el;
  };
  const porId = {};
  return {
    criados,
    document: {
      getElementById: (id) => porId[id] || null,
      createElement: (tag) => novo(tag),
      body: { appendChild: (el) => { if (el.id) porId[el.id] = el; return el; } },
    },
  };
}
const agenda = () => { const fns = []; return { setTimeout: (f) => { fns.push(f); return fns.length; }, clearTimeout: () => {}, disparar: () => fns.forEach(f => f()) }; };

test('toast: não pode interceptar clique — nasce e morre com pointer-events:none', () => {
  const dom = domFalso(), tempo = agenda();
  const { toast } = carregar('toast', { document: dom.document, ...tempo });
  toast('Salvo');
  const el = dom.criados[0];
  assert.match(el.style.cssText, /pointer-events:\s*none/,
    'sem isto o toast invisível cobre a nav inferior do celular pra sempre');
});

test('_toastUndo: o Desfazer some de verdade quando o toast expira', () => {
  const dom = domFalso(), tempo = agenda();
  const { _toastUndo } = carregar('_toastUndo', { document: dom.document, ...tempo });
  let restaurou = 0;
  _toastUndo('Agendamento excluído.', () => restaurou++);
  const el = dom.criados[0];
  const btn = el.filhos.find(f => f.textContent === 'Desfazer');
  assert.ok(btn, 'o botão existe enquanto o toast está visível');
  assert.match(el.style.cssText, /pointer-events:\s*auto/, 'visível, tem de aceitar clique');

  tempo.disparar(); // passa os 6 segundos
  assert.strictEqual(el.style.opacity, '0');
  assert.strictEqual(el.style.pointerEvents, 'none', 'invisível não pode receber toque');
  assert.strictEqual(btn.disabled, true);

  btn.onclick();
  assert.strictEqual(restaurou, 0, 'clique no Desfazer expirado não pode ressuscitar o registro');
});

test('_toastUndo: dois toques seguidos restauram uma vez só', () => {
  const dom = domFalso(), tempo = agenda();
  const { _toastUndo } = carregar('_toastUndo', { document: dom.document, ...tempo });
  let restaurou = 0;
  _toastUndo('Excluído.', () => restaurou++);
  const btn = dom.criados[0].filhos.find(f => f.textContent === 'Desfazer');
  btn.onclick();
  btn.onclick();
  btn.onclick();
  assert.strictEqual(restaurou, 1);
});

// ---------- _diasDesde: idade do card no Kanban ----------
// 'YYYY-MM-DD' é lido pelo JS como meia-noite UTC. Comparado com Date.now()
// (hora local), em UTC-3 isso somava o fuso à conta: das 21:00 em diante, o
// contato feito HOJE aparecia como "1d" e a cor do card pulava de verde pra
// amarelo sozinha. O bug só existe em fuso negativo — daí o TZ fixo aqui, sem
// ele o teste passaria numa máquina em UTC sem guardar nada. É o fuso do uso
// real do app.
process.env.TZ = 'America/Sao_Paulo';

// Relógio parado numa data/hora LOCAL (componentes, não string ISO): assim o
// instante acompanha o TZ acima em vez de depender do fuso da máquina.
function _relogio(ano, mes, dia, hora, min) {
  const fixo = new Date(ano, mes - 1, dia, hora, min, 0).getTime();
  class DataFixa extends Date {
    constructor(...a) { super(...(a.length ? a : [fixo])); }
    static now() { return fixo; }
  }
  return DataFixa;
}
const _ambiente = D => ({ Date: D, String, isNaN, Math });

test('_diasDesde: contato de hoje continua "hoje" às 21h (fuso não vira o dia)', () => {
  for (const [h, m] of [[9, 0], [18, 0], [20, 59], [21, 0], [23, 59]]) {
    const { _diasDesde } = carregar('_diasDesde', _ambiente(_relogio(2026, 8, 3, h, m)));
    assert.strictEqual(_diasDesde('2026-08-03').texto, 'hoje',
      `às ${h}:${m} o contato de hoje não pode virar "1d"`);
  }
});

test('_diasDesde: conta dias de calendário, não blocos de 24h', () => {
  // 23:59 de 03/08 olhando um contato de 01/08 = 2 dias de calendário.
  const { _diasDesde } = carregar('_diasDesde', _ambiente(_relogio(2026, 8, 3, 23, 59)));
  assert.strictEqual(_diasDesde('2026-08-01').texto, '2d');
  assert.strictEqual(_diasDesde('2026-07-20').texto, '14d');
  assert.strictEqual(_diasDesde('2026-07-19').texto, '15d atrás');
});

test('_diasDesde: data ausente ou lixo não vira "NaN d atrás" no card', () => {
  const { _diasDesde } = carregar('_diasDesde', _ambiente(_relogio(2026, 8, 3, 10, 0)));
  for (const ruim of [null, undefined, '', 'sem data']) {
    assert.strictEqual(_diasDesde(ruim).texto, '—', `entrada ${JSON.stringify(ruim)}`);
  }
});

test('_diasDesde: aceita timestamp completo, não só YYYY-MM-DD', () => {
  const { _diasDesde } = carregar('_diasDesde', _ambiente(_relogio(2026, 8, 3, 10, 0)));
  assert.strictEqual(_diasDesde('2026-08-01T22:15:00.000Z').texto, '2d');
});

// ---------- _comTituloMedico: nunca duplica "Dr./Dra." ----------
test('_comTituloMedico adiciona "Dr." quando falta', () => {
  const { _comTituloMedico } = carregar('_comTituloMedico');
  assert.strictEqual(_comTituloMedico('Rafael'), 'Dr. Rafael');
  assert.strictEqual(_comTituloMedico('Ana Souza'), 'Dr. Ana Souza');
});

test('_comTituloMedico NÃO duplica quando o nome já tem o título', () => {
  const { _comTituloMedico } = carregar('_comTituloMedico');
  assert.strictEqual(_comTituloMedico('Dr. Teste'), 'Dr. Teste');
  assert.strictEqual(_comTituloMedico('Dra. Maria'), 'Dra. Maria');
  assert.strictEqual(_comTituloMedico('dr. minusculo'), 'dr. minusculo');
});

test('_comTituloMedico trata nome vazio/nulo sem quebrar', () => {
  const { _comTituloMedico } = carregar('_comTituloMedico');
  assert.strictEqual(_comTituloMedico(''), '');
  assert.strictEqual(_comTituloMedico(null), '');
});

// ---------- _primeiroNomeSemTitulo: a raiz do bug real "Dr. Dr. Teste" ----------
// Pegar a 1ª palavra ANTES de tirar o título transformava "Dr. Teste" em só
// "Dr." — daí _comTituloMedico("Dr.") não reconhecia o título (sem espaço
// depois) e prefixava de novo: "Dr. Dr.". Correção: tira o título primeiro.
test('_primeiroNomeSemTitulo remove o título antes de cortar a 1ª palavra', () => {
  const { _primeiroNomeSemTitulo } = carregar('_primeiroNomeSemTitulo');
  assert.strictEqual(_primeiroNomeSemTitulo('Dr. Teste'), 'Teste');
  assert.strictEqual(_primeiroNomeSemTitulo('Dra. Maria Silva'), 'Maria');
  assert.strictEqual(_primeiroNomeSemTitulo('Rafael Duncan'), 'Rafael');
});

test('_comTituloMedico(_primeiroNomeSemTitulo(...)) nunca duplica — regressão do bug real', () => {
  const { _comTituloMedico, _primeiroNomeSemTitulo } = carregar(['_comTituloMedico', '_primeiroNomeSemTitulo']);
  for (const nome of ['Dr. Teste', 'Dra. Ana', 'Rafael Duncan', 'Dr.Teste', 'Dr Teste']) {
    const resultado = _comTituloMedico(_primeiroNomeSemTitulo(nome));
    const qtdDr = (resultado.match(/dr\.?/gi) || []).length;
    assert.strictEqual(qtdDr, 1, `"${nome}" → "${resultado}" tem título duplicado`);
  }
});

test('_comTituloMedico não confunde nomes reais que começam com "dr" (Drico, Dracena)', () => {
  const { _comTituloMedico } = carregar('_comTituloMedico');
  assert.strictEqual(_comTituloMedico('Drico Silva'), 'Dr. Drico Silva');
  assert.strictEqual(_comTituloMedico('Dracena Souza'), 'Dr. Dracena Souza');
});

// ---------- _mesMaisRecenteComDados: banner "sem lançamentos neste mês" ----------
function carregarMes(pacientes, despesas) {
  return carregar(['_mesMaisRecenteComDados', 'getMes'], {
    DB: { get: (k) => (k === 'pacientes' ? pacientes : k === 'despesas' ? despesas : []) },
  });
}

test('_mesMaisRecenteComDados acha o mês mais recente, ignorando o mês atual', () => {
  const { _mesMaisRecenteComDados } = carregarMes(
    [{ data: '2026-05-10' }, { data: '2026-03-01' }],
    [{ data: '2026-05-20' }]
  );
  assert.strictEqual(_mesMaisRecenteComDados('2026-07'), '2026-05');
});

test('_mesMaisRecenteComDados retorna null quando não há dado em lugar nenhum', () => {
  const { _mesMaisRecenteComDados } = carregarMes([], []);
  assert.strictEqual(_mesMaisRecenteComDados('2026-07'), null);
});

test('_mesMaisRecenteComDados ignora o próprio mês excluído mesmo com dado nele', () => {
  const { _mesMaisRecenteComDados } = carregarMes([{ data: '2026-07-01' }, { data: '2026-04-01' }], []);
  assert.strictEqual(_mesMaisRecenteComDados('2026-07'), '2026-04');
});

// ---------- _agIndiceContatos: autocomplete do agendamento ----------
function carregarIndice(pacientes, crm) {
  return carregar('_agIndiceContatos', { DB: { get: (k) => (k === 'pacientes' ? pacientes : k === 'crm' ? crm : []) } });
}

test('_agIndiceContatos prioriza o atendimento mais recente do paciente', () => {
  const { _agIndiceContatos } = carregarIndice([
    { nome: 'Ana Lima', data: '2026-01-01', whatsapp: '81900000001', tipo: 'Consulta' },
    { nome: 'Ana Lima', data: '2026-06-01', whatsapp: '81900000002', tipo: 'Retorno' },
  ], []);
  const idx = _agIndiceContatos();
  const c = idx.get('ana lima');
  assert.strictEqual(c.whatsapp, '81900000002');
  assert.strictEqual(c.procedimento, 'Retorno');
});

test('_agIndiceContatos cobre leads do CRM que ainda não são pacientes', () => {
  const { _agIndiceContatos } = carregarIndice([], [
    { nome: 'Bruno Sá', whatsapp: '81988887777', tipo: '1ª vez' },
  ]);
  const idx = _agIndiceContatos();
  assert.strictEqual(idx.get('bruno sá').whatsapp, '81988887777');
});

test('_agIndiceContatos: paciente tem prioridade sobre CRM quando os dois têm o mesmo nome', () => {
  const { _agIndiceContatos } = carregarIndice(
    [{ nome: 'Carla Reis', data: '2026-02-01', whatsapp: '81911112222', tipo: 'Consulta' }],
    [{ nome: 'Carla Reis', whatsapp: '81900009999', tipo: 'Lead antigo' }]
  );
  const idx = _agIndiceContatos();
  assert.strictEqual(idx.get('carla reis').whatsapp, '81911112222');
});
