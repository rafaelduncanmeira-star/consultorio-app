// Gravação de configuração — rode com: node --test
//
// Um blob de config guarda mais campos do que qualquer tela mostra. Quem grava
// tem de partir do que JÁ ESTÁ salvo e mexer só no que é seu; montar um objeto
// literal com os campos do formulário apaga em silêncio tudo o que outra tela
// escreveu ali.
//
// O caso real: `clinica_config` guarda também o `modo` da clínica ('completo'
// ou 'financeiro'), escolhido no cadastro e trocado por setAppMode. O
// saveClinicaConfig montava um literal com os 6 campos do formulário do
// consultório. Salvar o nome da clínica apagava o modo; getAppMode caía no
// padrão 'completo' e CRM, Follow-up, Programas e Agenda voltavam pra sidebar
// de quem tinha escolhido "Apenas Financeiro". E só aparecia na abertura
// seguinte do app — esta função não reaplica o papel —, então não havia como
// ligar o efeito ao ato de salvar.

const { test } = require('node:test');
const assert = require('node:assert');
const { carregar, fonte } = require('./_extrair.js');

function ambiente(salvo) {
  const store = { clinica_config: JSON.parse(JSON.stringify(salvo)) };
  const campos = {
    'clinica-nome': 'Dr. Rafael',
    'clinica-especialidade': 'Geriatria',
    'clinica-nome-clinica': 'Maestria',
    'clinica-cidade': 'Porto Alegre',
    'clinica-crm': '12345',
    'clinica-cor': '#3b82f6',
  };
  const s = carregar(['getClinicaConfig', 'saveClinicaConfig', 'getAppMode'], {
    Object, JSON,
    document: { getElementById: (id) => (id in campos ? { value: campos[id] } : null) },
    DB: {
      getObj: (k, def) => (k in store ? store[k] : def),
      setObj: (k, v) => { store[k] = v; },
    },
    applyClinicaConfig: () => {},
    toast: () => {},
    _auditLog: () => {},
  });
  return { ...s, store };
}

test('salvar o consultório não apaga o modo da clínica', () => {
  const a = ambiente({ nome: 'antigo', modo: 'financeiro' });
  a.saveClinicaConfig();
  assert.equal(a.store.clinica_config.modo, 'financeiro',
    'sem o modo, CRM/Agenda/Programas/Follow-up voltam pra sidebar de quem os escondeu');
  assert.equal(a.getAppMode(), 'financeiro');
});

test('os campos do formulário continuam sendo gravados', () => {
  const a = ambiente({ nome: 'antigo', modo: 'financeiro' });
  a.saveClinicaConfig();
  assert.equal(a.store.clinica_config.nome, 'Dr. Rafael');
  assert.equal(a.store.clinica_config.cor, '#3b82f6');
  assert.equal(a.store.clinica_config.cidade, 'Porto Alegre');
});

test('campo desconhecido de versão futura também sobrevive', () => {
  const a = ambiente({ modo: 'completo', logoUrl: 'x.png' });
  a.saveClinicaConfig();
  assert.equal(a.store.clinica_config.logoUrl, 'x.png',
    'a tela não pode ser dona de campo que ela nem conhece');
});

test('config vazia continua salvando sem inventar nada', () => {
  const a = ambiente({});
  a.saveClinicaConfig();
  assert.equal(a.store.clinica_config.nome, 'Dr. Rafael');
  assert.equal(a.getAppMode(), 'completo', 'sem modo gravado, o padrão vale');
});

// ---------- ninguém mais pode gravar um blob de config por cima ----------
// Escrita válida é a que parte do valor atual (getX(), Object.assign, spread).
// Objeto literal montado na hora só vale quando a tela é DONA do blob inteiro —
// e cada caso desses entra aqui com o motivo escrito, nunca afrouxando a
// varredura (detector afrouxado deixa de acusar o bug real).
// A exceção é por FUNÇÃO, não por chave: exemtar a chave inteira deixaria de
// conferir os outros pontos que gravam o mesmo blob (o zapi_config, por
// exemplo, é escrito por três funções e só uma delas é um reset).
const DONOS_DO_BLOB = {
  saveConfigHorarios:
    'monta as 7 chaves do AG_CONFIG_PADRAO. Só o campo legado slotsConsultorioDia '
    + 'fica de fora, e de propósito: depois de salvar quem manda é o slotsSemanais '
    + '(a migração vive no getAgConfig).',
  saveLembretesConfig:
    'grava os 4 campos do blob, e relê o ultimoEnvio e a mensagem do valor atual '
    + 'antes de montar.',
  saveMetas:
    'recalcula fat/pac/desp inteiros a partir do formulário — são os 3 campos do '
    + 'blob. metas_proc e metas_proc_valor são mapas remontados por inteiro: '
    + 'procedimento tirado da tela TEM de sumir do mapa, então mesclar seria o bug.',
  saveMetasProc:
    'CÓDIGO MORTO hoje: nenhum botão abre o modal-metas-proc (os dois ⚙️ da tela '
    + 'de Metas abrem o modal-metas). Se ele voltar a ser ligado, vira bug na hora: '
    + 'ele grava 6 chaves fixas e o saveMetas grava 7 — a meta de "Programa" seria '
    + 'apagada, e o metas_proc_valor ficaria com valor de procedimento sem quantidade.',
  disconnectZapi:
    'zera a integração de propósito — é o reset, não uma edição parcial.',
};

function nomeDaFuncao(linhas, i) {
  for (let j = i; j >= 0; j--) {
    const m = linhas[j].match(/^(?:async )?function (\w+)/);
    if (m) return m[1];
  }
  return '(topo)';
}

function setObjNoFonte() {
  const linhas = fonte.split('\n');
  const achados = [];
  linhas.forEach((l, i) => {
    const m = l.match(/DB\.setObj\('(\w+)',\s*(.*)$/);
    if (m) achados.push({ linha: i + 1, chave: m[1], resto: m[2], i, fn: nomeDaFuncao(linhas, i) });
  });
  return { linhas, achados };
}

test('todo DB.setObj de config parte do valor que já está salvo', () => {
  const ESCALARES = new Set(['crm_view', 'wa_provider']); // guardam uma string, não um blob
  const { linhas, achados } = setObjNoFonte();
  const ruins = [];
  for (const { linha, chave, resto, i, fn } of achados) {
    if (ESCALARES.has(chave) || DONOS_DO_BLOB[fn]) continue;
    // Varre o corpo inteiro da função: a leitura que originou a variável pode
    // estar bem acima da gravação.
    let ini = 0;
    for (let j = i; j >= 0; j--) {
      if (/^(async )?function /.test(linhas[j])) { ini = j; break; }
    }
    const corpo = linhas.slice(ini, i).join('\n');
    const nomeVar = (resto.match(/^(\w+)\)/) || [])[1];
    const re = nomeVar && new RegExp('\\b' + nomeVar
      + '\\s*=\\s*(?:Object\\.assign\\(|\\{\\s*\\.\\.\\.|get\\w+\\(|DB\\.getObj\\()');
    if (!nomeVar || !re.test(corpo)) ruins.push(`${linha} (${fn}): ${linhas[i].trim()}`);
  }
  assert.deepStrictEqual(ruins, [],
    'objeto literal apaga em silêncio o campo que outra tela gravou no mesmo blob');
});

test('exceção de dono-do-blob que ficou órfã tem de sair da lista', () => {
  const { achados } = setObjNoFonte();
  const comEscrita = new Set(achados.map(a => a.fn));
  const orfas = Object.keys(DONOS_DO_BLOB).filter(k => !comEscrita.has(k));
  assert.deepStrictEqual(orfas, [],
    'exceção sem call site correspondente vira folclore e esconde o próximo caso');
});
