// Testes de restauração de backup — rode com: node --test
// Exercitam o importarJSON REAL do app.js contra FileReader, DB e document
// falsos. Restaurar backup é a operação mais destrutiva do app: ela substitui
// coleção inteira. Errar aqui não dá aviso — dá perda.

const { test } = require('node:test');
const assert = require('node:assert');
const { carregar } = require('./_extrair.js');

// Ambiente falso mínimo pro importarJSON. `atraso` simula o tempo real que o
// envio das coleções blindadas leva (lotes de 200 registros).
function ambiente({ conteudo, confirmar = true, atraso = 0, falharEm = [] }) {
  const gravadas = [];
  const eventos = [];
  const input = { files: [{ name: 'backup.json' }], value: 'backup.json' };
  const statusEl = { textContent: '' };

  const DB = {
    set: (k, v) => {
      gravadas.push(k);
      const ok = !falharEm.includes(k);
      return atraso
        ? new Promise(r => setTimeout(() => { eventos.push('push:' + k); r(ok); }, atraso))
        : Promise.resolve((eventos.push('push:' + k), ok));
    },
  };

  const sandbox = {
    document: { getElementById: () => statusEl },
    FileReader: class {
      readAsText() { Promise.resolve().then(() => this.onload({ target: { result: conteudo } })); }
    },
    confirm: () => confirmar,
    alert: (m) => eventos.push('alert:' + String(m).slice(0, 30)),
    toast: () => {},
    setTimeout: (fn) => { eventos.push('reload-agendado'); fn(); return 1; },
    location: { reload: () => eventos.push('RELOAD') },
    JSON, Date, Promise, Array, Error, String, Object,
    BACKUP_KEYS: ['pacientes', 'crm', 'agendamentos', 'despesas', 'clinica_config'],
    _BLINDADAS: { pacientes: {}, crm: {}, agendamentos: {} },
    DB,
  };
  const { importarJSON } = carregar('importarJSON', sandbox);
  return { importarJSON, input, statusEl, gravadas, eventos };
}

const BACKUP_BOM = JSON.stringify({
  _meta: { exportadoEm: '2026-08-03T10:00:00Z' },
  pacientes: [{ id: 'p1', nome: 'Ana' }],
  crm: [{ id: 'c1' }],
  clinica_config: { nome: 'Clínica' },
});

// Espera as promises internas do importarJSON (FileReader + Promise.all).
const assentar = () => new Promise(r => setTimeout(r, 30));

test('importarJSON: restaura as seções reconhecidas do arquivo', async () => {
  const a = ambiente({ conteudo: BACKUP_BOM });
  a.importarJSON(a.input);
  await assentar();
  assert.deepStrictEqual(a.gravadas.sort(), ['clinica_config', 'crm', 'pacientes']);
  assert.match(a.statusEl.textContent, /Restaurado com sucesso/);
});

// O ACHADO: o reload era agendado num timer de 2s enquanto os envios ainda
// estavam voando. As coleções blindadas sobem em lotes; o que não terminasse
// ficava só no localStorage, e o pull seguinte trazia os dados VELHOS por cima
// — o backup "restaurado com sucesso" evaporava sozinho.
test('importarJSON: só recarrega DEPOIS que todo envio terminou', async () => {
  const a = ambiente({ conteudo: BACKUP_BOM, atraso: 20 });
  a.importarJSON(a.input);
  await assentar();
  const iReload = a.eventos.indexOf('RELOAD');
  assert.ok(iReload >= 0, 'o reload precisa acontecer');
  for (const k of ['pacientes', 'crm', 'clinica_config']) {
    assert.ok(a.eventos.indexOf('push:' + k) < iReload,
      `${k} ainda estava subindo quando a página recarregou`);
  }
});

test('importarJSON: envio que falhou NÃO recarrega e avisa quais seções', async () => {
  const a = ambiente({ conteudo: BACKUP_BOM, falharEm: ['pacientes'] });
  a.importarJSON(a.input);
  await assentar();
  assert.ok(!a.eventos.includes('RELOAD'),
    'recarregar aqui só apressa o pull a sobrescrever o que não subiu');
  assert.ok(a.eventos.some(e => e.startsWith('alert:')), 'o usuário tem de ser avisado');
  assert.match(a.statusEl.textContent, /pacientes/);
});

// Coleção blindada tem de ser lista. Gravar um objeto no lugar quebrava toda
// tela que faz .filter/.reduce em cima, e o app não abria mais.
test('importarJSON: recusa arquivo com objeto onde devia haver lista', async () => {
  const a = ambiente({ conteudo: JSON.stringify({ pacientes: { id: 'p1' } }) });
  a.importarJSON(a.input);
  await assentar();
  assert.deepStrictEqual(a.gravadas, [], 'nada pode ser gravado');
  assert.match(a.statusEl.textContent, /Formato inválido/);
  assert.ok(!a.eventos.includes('RELOAD'));
});

test('importarJSON: cancelar no confirm não grava nem recarrega', async () => {
  const a = ambiente({ conteudo: BACKUP_BOM, confirmar: false });
  a.importarJSON(a.input);
  await assentar();
  assert.deepStrictEqual(a.gravadas, []);
  assert.ok(!a.eventos.includes('RELOAD'));
  assert.match(a.statusEl.textContent, /cancelada/);
});

test('importarJSON: arquivo corrompido ou sem seção conhecida não destrói nada', async () => {
  for (const ruim of ['{isso não é json', JSON.stringify({ outra_coisa: [1] }), 'null']) {
    const a = ambiente({ conteudo: ruim });
    a.importarJSON(a.input);
    await assentar();
    assert.deepStrictEqual(a.gravadas, [], `entrada: ${ruim.slice(0, 20)}`);
    assert.match(a.statusEl.textContent, /Erro/);
  }
});

test('importarJSON: limpa o input em todos os caminhos (senão o mesmo arquivo não reabre)', async () => {
  for (const cenario of [{ conteudo: BACKUP_BOM }, { conteudo: 'lixo' }, { conteudo: BACKUP_BOM, confirmar: false }]) {
    const a = ambiente(cenario);
    a.importarJSON(a.input);
    await assentar();
    assert.strictEqual(a.input.value, '');
  }
});
