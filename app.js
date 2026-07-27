// ====================== DEMO DATA LOADER (uso manual via console) ======================
// Uso: abra DevTools (F12) → Console → digite: loadDemoData()
// Popula uma semana realista de Geriatria + sincroniza no Supabase
window.loadDemoData = async function loadDemoData() {
  if (!confirm('Isso vai SUBSTITUIR todos os seus dados atuais por uma simulação de uma semana. Tem certeza?')) return;
  try {
    const r = await fetch('demo-data.json');
    if (!r.ok) throw new Error('Não achei demo-data.json (status ' + r.status + ')');
    const dump = await r.json();

    console.log('🔄 Carregando simulação...');
    Object.entries(dump).forEach(([k, v]) => {
      localStorage.setItem('consult_' + k, JSON.stringify(v));
    });
    // Limpa flag de seed de programas pra forçar carregar os templates
    localStorage.removeItem('consult_progs_seeded_v2');
    // Re-migra as coleções blindadas pra tabela por linha no próximo load
    try { Object.values(_BLINDADAS).forEach(c => localStorage.removeItem(c.flag)); } catch(e) {}

    console.log('☁️ Sincronizando com Supabase...');
    const chaves = Object.keys(dump);
    for (const k of chaves) {
      await cloudPush(k);
    }

    console.log('✅ Pronto! Recarregando...');
    setTimeout(() => location.reload(), 800);
  } catch(e) {
    alert('Erro: ' + e.message);
    console.error(e);
  }
};

// ====================== DARK MODE / TEMA ======================
function applyDarkMode(dark) {
  document.body.classList.toggle('dark', !!dark);
  // Atualiza theme-color meta pra status bar mobile
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = dark ? '#0d1117' : '#10b981';
  // Atualiza estado dos botões no card de Configurações (se aberto)
  _atualizarBotoesTema(dark);
}

function setTema(tema) {
  const dark = tema === 'escuro';
  applyDarkMode(dark);
  localStorage.setItem('consult_dark_mode', dark ? '1' : '0');
}

function _atualizarBotoesTema(dark) {
  const claro = document.getElementById('tema-claro-btn');
  const escuro = document.getElementById('tema-escuro-btn');
  if (!claro || !escuro) return;
  if (dark) {
    escuro.style.background = '#0f172a'; escuro.style.color = '#fff';
    claro.style.background = 'transparent'; claro.style.color = '';
  } else {
    claro.style.background = '#fff'; claro.style.color = '#0f172a';
    claro.style.boxShadow = '0 1px 2px rgba(0,0,0,0.06)';
    escuro.style.background = 'transparent'; escuro.style.color = '';
    escuro.style.boxShadow = 'none';
  }
}

// Aplica preferência salva no carregamento — antes do app inicializar
(function _applyDarkOnLoad() {
  const pref = localStorage.getItem('consult_dark_mode');
  if (pref === '1') {
    // Aguarda DOMContentLoaded pra body existir
    if (document.body) applyDarkMode(true);
    else document.addEventListener('DOMContentLoaded', () => applyDarkMode(true), { once: true });
  }
})();

// ====================== RESILIÊNCIA A CDN FORA DO AR ======================
// O app carrega Chart.js/Tailwind/etc de CDNs. Se um CDN falhar (rede
// corporativa, queda do jsdelivr, offline), o Dashboard INTEIRO quebrava com
// "Chart is not defined". Stub inofensivo: os gráficos ficam em branco, mas
// todas as páginas continuam funcionando.
// (checagem imediata: os <script src> dos CDNs são síncronos e vêm antes
// do app.js — se Chart não existe agora, o CDN falhou de vez.)
if (typeof window.Chart === 'undefined') {
  console.warn('Chart.js não carregou (CDN indisponível) — gráficos desativados nesta sessão.');
  window.Chart = class ChartStub {
    constructor() {}
    destroy() {}
    update() {}
    resize() {}
  };
}

// ====================== PWA (Service Worker + Install Prompt) ======================
let _deferredInstallPrompt = null;

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(err => console.warn('SW register fail:', err));
  });
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  _deferredInstallPrompt = e;
  // Mostra o botão flutuante de instalar
  const btn = document.getElementById('pwa-install-btn');
  if (btn) btn.style.display = '';
});

window.addEventListener('appinstalled', () => {
  _deferredInstallPrompt = null;
  const btn = document.getElementById('pwa-install-btn');
  if (btn) btn.style.display = 'none';
  if (typeof toast === 'function') toast('🎉 App instalado! Abra pelo ícone na tela inicial.');
});

async function pwaInstall() {
  if (!_deferredInstallPrompt) {
    // iOS Safari: instrução manual
    if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) {
      alert('Para instalar no iOS:\n\n1. Toque no botão Compartilhar (□↑) na barra do Safari\n2. Role e toque em "Adicionar à Tela de Início"\n3. Confirme tocando em "Adicionar"');
    } else {
      alert('Use o menu do navegador (⋮) e selecione "Instalar aplicativo" ou "Adicionar à tela inicial".');
    }
    return;
  }
  _deferredInstallPrompt.prompt();
  const { outcome } = await _deferredInstallPrompt.userChoice;
  _deferredInstallPrompt = null;
  const btn = document.getElementById('pwa-install-btn');
  if (btn) btn.style.display = 'none';
}

// ====================== SUPABASE ======================
const SUPA_URL = 'https://ipvztcqlawwslnkzmzzl.supabase.co';
const SUPA_KEY = 'sb_publishable_-AffRgArhzjeJioFgyzgng_bnSo2F4K';
let _supa = null;
let currentUser = null;
let currentRole = null; // só é setado após login bem-sucedido
let currentNome = '';
// "Dono" dos dados que o usuário está visualizando.
// Default = currentUser.id (sua própria clínica). Se o usuário é membro
// da equipe de outra pessoa, vira o user_id do dono.
let currentDataOwner = null;
let currentTeamRole  = null; // 'owner' (você é o dono) ou 'member'
let currentProfissionalId = null; // se o login for de um profissional, qual (Tijolo 2)

let _recoveryFlow = false; // true quando o usuário chegou via link de recuperação de senha

function initSupabase() {
  try {
    if (window.supabase && window.supabase.createClient) {
      _supa = window.supabase.createClient(SUPA_URL, SUPA_KEY);
      // Detecta retorno pelo link de recuperação de senha
      _supa.auth.onAuthStateChange((event) => {
        if (event === 'PASSWORD_RECOVERY') {
          _recoveryFlow = true;
          // Mostra a tela de login com o form de nova senha
          const lp = document.getElementById('login-page');
          if (lp) lp.style.display = 'flex';
          if (typeof setLoginTab === 'function') setLoginTab('nova-senha');
        }
      });
    }
  } catch(e) { console.warn('Supabase init error:', e); }
}

// ============ OUTBOX — fila de escritas não confirmadas (offline/rejeitadas) ============
// Toda escrita que o Supabase NÃO confirmou fica anotada aqui, por chave. O pull
// pula chaves pendentes (a edição local vence até ser entregue) e a fila é
// drenada ao voltar a conexão e no início de cada cloudPull. Antes, uma edição
// offline era engolida em silêncio e apagada pelo pull seguinte.
// Teto de tentativas. Sem ele, uma escrita que o servidor NUNCA vai aceitar
// (RLS, constraint) fica presa na fila pra sempre — e como o pull pula chave
// pendente, o aparelho congela naquela coleção: nada mais entra, nada sai.
const _OUTBOX_TETO = 5;

function _outboxGet() { try { return JSON.parse(localStorage.getItem('consult__outbox') || '{}'); } catch(e) { return {}; } }
function _outboxAdd(key, tipo) {
  const o = _outboxGet();
  const ant = o[key];
  o[key] = { tipo, ts: new Date().toISOString(), tentativas: ((ant && ant.tentativas) || 0) + 1 };
  localStorage.setItem('consult__outbox', JSON.stringify(o));
}
function _outboxRemove(key) {
  const o = _outboxGet();
  if (key in o) { delete o[key]; localStorage.setItem('consult__outbox', JSON.stringify(o)); }
}
function _outboxTravado(key) {
  const e = _outboxGet()[key];
  return !!e && (e.tentativas || 0) >= _OUTBOX_TETO;
}
// Bloqueia o pull só enquanto a entrega ainda é plausível. Passado o teto, a
// entrada continua anotada (diagnóstico) mas deixa de bloquear: melhor voltar a
// receber do servidor do que ficar cego. O que foi recusado linha a linha está
// guardado na quarentena (consult__quarentena), então nada some sem registro.
function _outboxPendente(key) {
  const e = _outboxGet()[key];
  return !!e && (e.tentativas || 0) < _OUTBOX_TETO;
}
// Falha de rede não deve gastar o orçamento de tentativas: ao voltar a conexão,
// todo mundo ganha crédito novo (o que era RLS volta a estourar o teto sozinho).
function _outboxResetTentativas() {
  const o = _outboxGet();
  let mudou = false;
  for (const k of Object.keys(o)) { if (o[k].tentativas) { o[k].tentativas = 0; mudou = true; } }
  if (mudou) localStorage.setItem('consult__outbox', JSON.stringify(o));
}

let _drenandoOutbox = false;
async function _drenarOutbox() {
  if (_drenandoOutbox || !_supa || !currentUser) return;
  _drenandoOutbox = true;
  try {
    for (const [key, info] of Object.entries(_outboxGet())) {
      // Já estourou o teto: não adianta martelar o servidor a cada pull.
      if ((info.tentativas || 0) >= _OUTBOX_TETO) continue;
      if (info.tipo === 'blindada') {
        const cfg = _BLINDADAS[key];
        const arr = JSON.parse(localStorage.getItem('consult_' + key) || '[]');
        // Só upsert (oldArr=[] ⇒ sem deletes): não dá pra saber o que OUTRO
        // aparelho criou enquanto estávamos offline — apagar seria pior.
        const ok = cfg ? await _pushBlindada(cfg.tabela, [], arr) : true;
        if (ok) _outboxRemove(key); else _outboxAdd(key, 'blindada');
      } else {
        await cloudPush(key); // remove/re-enfileira sozinho
      }
    }
  } finally { _drenandoOutbox = false; }
}
// Voltou a conexão → re-entrega o que ficou pendente (1.5s pro socket assentar).
window.addEventListener('online', () => { _outboxResetTentativas(); setTimeout(_drenarOutbox, 1500); });

// ============ Concorrência otimista nos blobs (coluna rev — SETUP_SYNC.sql) ============
// Sem a coluna no banco, o app cai no upsert simples (comportamento antigo).
let _revSuportado = true;
function _revsGet() { try { return JSON.parse(localStorage.getItem('consult__revs') || '{}'); } catch(e) { return {}; } }
function _revsSet(key, rev) {
  const r = _revsGet(); r[key] = rev;
  localStorage.setItem('consult__revs', JSON.stringify(r));
}

// Mescla dois arrays por id (conflito entre dois aparelhos): mantém a ordem e as
// versões LOCAIS (o usuário acabou de editar) e ANEXA itens que só existem no
// servidor (criados no outro aparelho). Deleção local pode "voltar" — aceito:
// ressuscitar um item é mais seguro que perder um lançamento criado no outro
// aparelho. Só é segura quando TODO item tem id; senão devolve null.
function _mesclarArraysPorId(serverArr, localArr) {
  if (!Array.isArray(serverArr) || !Array.isArray(localArr)) return null;
  const comId = a => a.every(r => r && typeof r === 'object' && r.id);
  if (!comId(serverArr) || !comId(localArr)) return null;
  const locais = new Set(localArr.map(r => r.id));
  return [...localArr, ...serverArr.filter(r => !locais.has(r.id))];
}

// Push uma chave ao Supabase — usa o owner da equipe atual. Falha ⇒ outbox.
async function cloudPush(key) {
  if (!_supa || !currentUser) return;
  const owner = currentDataOwner || currentUser.id;
  const raw = localStorage.getItem('consult_' + key);
  // Não há nada local pra enviar. Se a chave estava na fila, tem de sair dela:
  // entrada zumbi nunca é entregue e, como o pull pula chave pendente, aquela
  // chave parava de ser baixada do servidor pra sempre.
  if (raw === null) { _outboxRemove(key); return; }
  try {
    const ok = await _pushComRev(owner, key, JSON.parse(raw));
    if (ok) _outboxRemove(key); else _outboxAdd(key, 'blob');
  } catch(e) {
    console.warn('cloudPush error', key, e.message);
    _outboxAdd(key, 'blob');
  }
}

// Escrita com controle de versão: detecta quando OUTRO aparelho gravou a mesma
// chave desde o nosso último sync (antes: last-write-wins silencioso, um lado
// perdia tudo) e mescla arrays por id em vez de sobrescrever. true = confirmado.
async function _pushComRev(owner, key, value, tentativa = 0) {
  if (!_revSuportado) {
    const { error } = await _supa.from('app_data').upsert(
      { user_id: owner, key, value }, { onConflict: 'user_id,key' });
    if (error) console.warn('cloudPush rejeitado', key, error.message);
    return !error;
  }
  const seen = _revsGet()[key];
  if (typeof seen === 'number') {
    // Caminho feliz: ninguém mexeu desde o último sync → 1 request, como antes.
    const { data, error } = await _supa.from('app_data')
      .update({ value, rev: seen + 1 })
      .eq('user_id', owner).eq('key', key).eq('rev', seen)
      .select('rev');
    if (error) {
      if (error.code === '42703') { _revSuportado = false; return _pushComRev(owner, key, value); }
      console.warn('cloudPush rejeitado', key, error.message);
      return false;
    }
    if (data && data.length) { _revsSet(key, seen + 1); return true; }
    // 0 linhas: a rev mudou no servidor (outro aparelho gravou) ou a linha sumiu.
  }
  const { data: rows, error: e2 } = await _supa.from('app_data')
    .select('value, rev').eq('user_id', owner).eq('key', key).limit(1);
  if (e2) {
    if (e2.code === '42703') { _revSuportado = false; return _pushComRev(owner, key, value); }
    console.warn('cloudPush rejeitado', key, e2.message);
    return false;
  }
  if (!rows || !rows.length) {
    const { error: e3 } = await _supa.from('app_data').upsert(
      { user_id: owner, key, value, rev: 0 }, { onConflict: 'user_id,key' });
    if (e3) { console.warn('cloudPush rejeitado', key, e3.message); return false; }
    _revsSet(key, 0);
    return true;
  }
  if (tentativa >= 3) { console.warn('cloudPush: conflito persistente em', key); return false; }
  // CONFLITO: mescla arrays por id; objetos/sem-id, a edição local vence (LWW,
  // como antes — mas agora detectado e sem perder itens de array).
  const mesclado = _mesclarArraysPorId(rows[0].value, value);
  if (mesclado) {
    localStorage.setItem('consult_' + key, JSON.stringify(mesclado)); // UI pega no próximo render
    console.warn('cloudPush: conflito em', key, '— mesclado por id');
  }
  _revsSet(key, rows[0].rev);
  return _pushComRev(owner, key, mesclado || value, tentativa + 1);
}

// Pull todas as chaves do Supabase → localStorage — usa o owner da equipe atual
async function cloudPull() {
  if (!_supa || !currentUser) return;
  const owner = currentDataOwner || currentUser.id;
  // Entrega primeiro o que ficou pendente (offline/rejeitado) — senão o pull
  // sobrescreveria a edição local que nunca chegou ao servidor.
  await _drenarOutbox();
  try {
    let { data, error } = await _supa.from('app_data')
      .select('key, value, rev')
      .eq('user_id', owner);
    if (error && error.code === '42703') {
      // Coluna rev ainda não existe (SETUP_SYNC.sql não rodou) — segue sem ela.
      _revSuportado = false;
      ({ data, error } = await _supa.from('app_data').select('key, value').eq('user_id', owner));
    }
    if (error) throw error;
    if (data && data.length) {
      let aplicadas = 0;
      data.forEach(row => {
        // Chave com escrita local não confirmada: local vence até drenar.
        if (_outboxPendente(row.key)) return;
        localStorage.setItem('consult_' + row.key, JSON.stringify(row.value));
        if (typeof row.rev === 'number') _revsSet(row.key, row.rev);
        aplicadas++;
      });
      console.log(`cloudPull: ${aplicadas} chaves sincronizadas`);
    }
  } catch(e) { console.warn('cloudPull error:', e.message); }
  _migrarIds(); // Fase 1: garante ids estáveis após cada carga (idempotente)
  await _sincronizarBlindadas(); // Fase 2/3: migra (dono) + puxa as coleções blindadas da tabela (filtrado por RLS)
  _limparSensiveisProfissional(); // financeiro/config da clínica não fica no navegador do profissional
}

// Profissional não deve ver o financeiro nem as metas da clínica (nem via F12).
// Remove essas chaves do localStorage dele após cada carga.
function _limparSensiveisProfissional() {
  const souMembro = currentUser && (currentDataOwner || currentUser.id) !== currentUser.id;
  // Snapshots contêm a clínica INTEIRA (pacientes+finanças+chaves) — nenhum
  // membro deve guardá-los no navegador (o RLS novo também os bloqueia).
  if (souMembro) {
    Object.keys(localStorage)
      .filter(k => k.startsWith('consult__snapshot_'))
      .forEach(k => localStorage.removeItem(k));
  }
  const limpar = new Set();
  // Financeiro da clínica: o RLS não entrega 'despesas'/'metas*' a NENHUM membro
  // — nem ao médico membro. O que sobrar aqui é lixo local (digitação que nunca
  // vai poder ser salva, ou resto de outra conta no mesmo navegador) e a tela
  // mostraria isso como se fosse o financeiro da clínica. Quem é dono da própria
  // conta manda no próprio financeiro, mesmo que a UI dele não exiba a seção —
  // a exceção é o profissional, que nunca vê financeiro nem sendo dono.
  if ((souMembro && !_podeVerFinanceiro()) || currentRole === 'profissional') {
    ['despesas', 'metas', 'metas_proc', 'metas_proc_valor'].forEach(k => limpar.add(k));
  }
  // Segredos de integração: profissional não envia pela clínica — não
  // precisa (nem deve) ter os tokens do dono no localStorage.
  if (currentRole === 'profissional') {
    ['zapi_config', 'wa_cloud_config', 'llm_config', 'gemini_key_secure'].forEach(k => limpar.add(k));
  }
  limpar.forEach(k => localStorage.removeItem('consult_' + k));
}

// ============ BLINDAGEM Fase 2 — coleções sensíveis em tabela por linha (RLS) ============
// Cada coleção vai numa tabela própria: cada registro = 1 linha (id, owner_id,
// profissional_id, data jsonb). RLS no servidor garante que profissional só lê
// as linhas dele. DB.get continua síncrono (cache em localStorage).
// Só entram aqui coleções cuja TABELA já exista no banco.
const _BLINDADAS = {
  pacientes:    { tabela: 'clinica_atendimentos', flag: 'consult_atend_migrado' },
  agendamentos: { tabela: 'clinica_agendamentos', flag: 'consult_ag_migrado' },
  crm:          { tabela: 'clinica_crm',          flag: 'consult_crm_migrado' },
  inscricoes:   { tabela: 'clinica_inscricoes',   flag: 'consult_ins_migrado' },
  followup:     { tabela: 'clinica_followup',     flag: 'consult_fu_migrado' },
};

function _rowBlindada(rec, owner) {
  // O RLS só deixa um profissional gravar linha COM o profissional_id dele.
  // Registro que nasceu sem etiqueta (importação, tela antiga, followup de
  // terceiro) era recusado em silêncio e — pior — derrubava o lote inteiro
  // junto. Carimba antes de subir, e carimba também dentro do jsonb pra
  // coluna e registro não divergirem.
  const prof = rec.profissionalId
    || ((currentRole === 'profissional' && currentProfissionalId) ? currentProfissionalId : null);
  const registro = (prof && !rec.profissionalId) ? { ...rec, profissionalId: prof } : rec;
  return { id: rec.id, owner_id: owner, profissional_id: prof, data: registro, updated_at: new Date().toISOString() };
}

// Registro que o servidor recusou individualmente fica guardado aqui em vez de
// evaporar. Nunca apagamos dado por causa de uma rejeição — sem isso, quando o
// outbox estoura o teto e o pull volta a rodar, a linha recusada sumiria do
// aparelho sem deixar rastro.
function _quarentenar(tabela, linha, motivo) {
  try {
    const q = JSON.parse(localStorage.getItem('consult__quarentena') || '[]');
    const chave = tabela + ':' + linha.id;
    const i = q.findIndex(x => x.chave === chave);
    const item = { chave, tabela, motivo, ts: new Date().toISOString(), registro: linha.data };
    if (i >= 0) q[i] = item; else q.push(item);
    localStorage.setItem('consult__quarentena', JSON.stringify(q.slice(-300)));
    console.warn('_pushBlindada: linha recusada e posta em quarentena —', chave, '—', motivo);
  } catch(e) { console.warn('_quarentenar', e.message); }
}

const _LOTE_BLINDADA = 200;

// Upsert das linhas atuais + delete das removidas (diff por id). Scope-safe:
// um profissional só mexe nas linhas dele (RLS bloqueia o resto no servidor).
async function _pushBlindada(tabela, oldArr, newArr) {
  if (!_supa || !currentUser) return false;
  const owner = currentDataOwner || currentUser.id;
  try {
    const comId = (newArr || []).filter(r => r && r.id);
    let todasEntraram = true;
    if (comId.length) {
      const linhas = comId.map(r => _rowBlindada(r, owner));
      // Em lotes: um upsert único com a coleção inteira estoura o payload e,
      // sobretudo, é tudo-ou-nada — UMA linha recusada pelo RLS reprovava a
      // coleção completa, inclusive as centenas de linhas que estavam válidas.
      for (let i = 0; i < linhas.length; i += _LOTE_BLINDADA) {
        const lote = linhas.slice(i, i + _LOTE_BLINDADA);
        // supabase-js NÃO lança em erro de banco (RLS, constraint...) — retorna {error}.
        // Sem esta checagem, uma gravação rejeitada passava por "sucesso" e a
        // migração apagava o blob => perda total da coleção. Checar SEMPRE.
        const { error } = await _supa.from(tabela).upsert(lote, { onConflict: 'id' });
        if (!error) continue;
        // Lote reprovado: reenvia linha a linha pra salvar as boas e isolar a má.
        console.warn('_pushBlindada lote', tabela, error.message, '— reenviando linha a linha');
        for (const linha of lote) {
          const { error: e1 } = await _supa.from(tabela).upsert([linha], { onConflict: 'id' });
          if (e1) { todasEntraram = false; _quarentenar(tabela, linha, e1.message); }
        }
      }
    }
    const novos = new Set(comId.map(r => r.id));
    const removidos = (oldArr || []).filter(r => r && r.id && !novos.has(r.id)).map(r => r.id);
    for (let i = 0; i < removidos.length; i += _LOTE_BLINDADA) {
      const { error } = await _supa.from(tabela).delete().in('id', removidos.slice(i, i + _LOTE_BLINDADA));
      if (error) { console.warn('_pushBlindada delete', tabela, error.message); todasEntraram = false; }
    }
    return todasEntraram;
  } catch(e) { console.warn('_pushBlindada', tabela, e.message); return false; }
}

// Lê TODAS as linhas da coleção, paginando. O PostgREST corta a resposta no
// max-rows do projeto (1000 por padrão) e não avisa: acima disso o pull trazia
// um recorte e gravava esse recorte por cima do localStorage — o resto da
// coleção simplesmente desaparecia da tela. Ordem por id (chave primária) pra
// paginação estável, e o avanço usa o que voltou de fato, então funciona
// qualquer que seja o teto configurado no servidor.
async function _lerTodasBlindada(tabela, owner) {
  const PAG = 1000, TETO = 100000;
  const linhas = [];
  for (let de = 0; de < TETO; ) {
    const { data, error } = await _supa.from(tabela)
      .select('data').eq('owner_id', owner)
      .order('id', { ascending: true }).range(de, de + PAG - 1);
    if (error) return { error };
    const n = (data || []).length;
    if (!n) break;
    linhas.push(...data);
    de += n;
  }
  return { data: linhas };
}

// Pull filtrado por RLS → escreve consult_<key> (só o que o usuário pode ver).
async function _pullBlindada(key, cfg) {
  if (!_supa || !currentUser) return;
  // Escrita local ainda não confirmada nesta coleção: local vence até drenar
  // (senão o pull apagaria a edição feita offline).
  if (_outboxPendente(key)) { console.warn('_pullBlindada: outbox pendente em', key, '— pull adiado'); return; }
  const owner = currentDataOwner || currentUser.id;
  try {
    const { data, error } = await _lerTodasBlindada(cfg.tabela, owner);
    if (error) { console.warn('_pullBlindada', cfg.tabela, error.message); return; }
    const arr = (data || []).map(row => row.data).filter(Boolean)
      .sort((a, b) => (b.data || '').localeCompare(a.data || ''));
    const atual = JSON.parse(localStorage.getItem('consult_' + key) || '[]');
    // Flag "membro já sincronizou linhas ao menos uma vez" (separada da flag de
    // migração do dono). Sem ela, o membro NUNCA aceitava um pull vazio e ficava
    // com registros-fantasma que o dono já apagou.
    const msyncFlag = 'consult_' + key + '_msync';
    // Anti-zeramento: nunca troca dados locais por um pull VAZIO quando quem
    // olha é o DONO (dono com local não-vazio deveria sempre ter linhas na
    // tabela — vazio indica migração perdida/RLS quebrado, não "apagou tudo").
    if (arr.length === 0 && atual.length > 0) {
      const souDono = (currentDataOwner || currentUser.id) === currentUser.id;
      if (souDono) {
        // A auto-cura só vale enquanto este aparelho NUNCA leu linha nenhuma
        // desta coleção na tabela — aí um vazio de fato sugere migração perdida.
        // Depois que ele já leu, vazio é deleção real feita em outro aparelho:
        // re-marcar a migração fazia o push seguinte RESSUSCITAR tudo no servidor,
        // desfazendo a exclusão que o usuário tinha acabado de fazer no celular.
        if (localStorage.getItem(msyncFlag) !== '1') {
          console.warn('_pullBlindada: pull vazio com dados locais (' + key + ') — mantendo local e re-marcando migração');
          localStorage.removeItem(cfg.flag); // força re-migração no próximo ciclo (auto-cura)
          return;
        }
        console.warn('_pullBlindada: coleção zerada no servidor (' + key + ') — refletindo a exclusão');
      }
      // Membro: só confia num vazio DEPOIS de já ter sincronizado linhas uma vez
      // (evita apagar local por glitch de RLS/timing no 1º load). A partir daí,
      // vazio = deleção real do dono e é refletido.
      if (localStorage.getItem(msyncFlag) !== '1') return;
    }
    localStorage.setItem('consult_' + key, JSON.stringify(arr));
    if (arr.length > 0) localStorage.setItem(msyncFlag, '1');
  } catch(e) { console.warn('_pullBlindada', cfg.tabela, e.message); }
}

// Migração única (só o dono): "pacote" → tabela e remove o blob do app_data
// (pra ele não vazar mais no cloudPull dos membros). Só apaga o blob se o envio deu certo.
async function _migrarBlindada(key, cfg) {
  if (!_supa || !currentUser) return;
  if (localStorage.getItem(cfg.flag) === '1') return;
  if ((currentDataOwner || currentUser.id) !== currentUser.id) return; // membro não migra
  try {
    let arr = JSON.parse(localStorage.getItem('consult_' + key) || '[]');
    // Local VAZIO não prova que não há nada a migrar: pode ser aparelho novo,
    // logo após logout, ou um cloudPull que falhou. Antes o blob era apagado
    // assim mesmo e a coleção inteira sumia do servidor sem NUNCA ter sido
    // copiada pra tabela — perda total e silenciosa. Nesse caso a fonte da
    // verdade é o próprio blob: migra a partir dele e repõe o local.
    if (!arr.length) {
      const { data, error } = await _supa.from('app_data').select('value')
        .eq('user_id', currentUser.id).eq('key', key).limit(1);
      if (error) { console.warn('_migrarBlindada: blob ilegível —', key, '— nada apagado'); return; }
      const blob = (data && data[0] && data[0].value) || [];
      if (!Array.isArray(blob) || !blob.length) { localStorage.setItem(cfg.flag, '1'); return; }
      console.warn('_migrarBlindada: local vazio mas blob tem', blob.length, 'registros —', key, '— recuperando do blob');
      arr = blob;
      localStorage.setItem('consult_' + key, JSON.stringify(arr));
    }
    const ok = await _pushBlindada(cfg.tabela, [], arr);
    if (!ok) { console.warn('migração blindada falhou —', key, '— blob preservado'); return; }
    await _supa.from('app_data').delete().eq('user_id', currentUser.id).eq('key', key);
    localStorage.setItem(cfg.flag, '1');
  } catch(e) { console.warn('_migrarBlindada', key, e.message); }
}

// Roda migração + pull de todas as coleções blindadas (chamado no fim do cloudPull).
async function _sincronizarBlindadas() {
  for (const [key, cfg] of Object.entries(_BLINDADAS)) {
    await _migrarBlindada(key, cfg);
    await _pullBlindada(key, cfg);
  }
}

// ====================== EQUIPE: CONVITES E MEMBROS ======================

// Cria um convite e retorna o link de aceite
async function criarConvite(email, role, profissionalId) {
  if (!_supa || !currentUser) return { error: 'Não autenticado.' };
  if (currentTeamRole !== 'owner') return { error: 'Apenas o dono da equipe pode convidar.' };
  try {
    const payload = { owner_id: currentUser.id, email: email.toLowerCase().trim(), role };
    if (role === 'profissional' && profissionalId) payload.profissional_id = profissionalId;
    const { data, error } = await _supa.from('team_invites')
      .insert(payload)
      .select()
      .single();
    if (error) return { error: error.message };
    const link = `${location.origin}${location.pathname}?invite=${data.token}`;
    return { ok: true, invite: data, link };
  } catch(e) { return { error: e.message }; }
}

// Rótulo amigável de um papel da equipe (médico/secretária/profissional)
function _papelLabel(role) {
  return role === 'medico' ? 'médico(a)' : role === 'profissional' ? 'profissional' : 'secretária';
}

// Lista convites pendentes (do dono)
async function listarConvites() {
  if (!_supa || !currentUser) return [];
  try {
    const { data } = await _supa.from('team_invites')
      .select('*')
      .eq('owner_id', currentUser.id)
      .order('created_at', { ascending: false });
    return data || [];
  } catch(e) { return []; }
}

// Lista membros da equipe (do dono)
async function listarMembros() {
  if (!_supa || !currentUser) return [];
  try {
    const owner = currentDataOwner || currentUser.id;
    const { data: members } = await _supa.from('team_members')
      .select('member_id, role, created_at')
      .eq('owner_id', owner);
    if (!members || !members.length) return [];
    // Busca os perfis dos membros
    const ids = members.map(m => m.member_id);
    const { data: profiles } = await _supa.from('profiles')
      .select('id, nome, role')
      .in('id', ids);
    return members.map(m => {
      const p = (profiles || []).find(x => x.id === m.member_id);
      return { ...m, nome: p?.nome || '(sem nome)' };
    });
  } catch(e) { return []; }
}

// Remove um membro da equipe
async function removerMembro(memberId) {
  if (!_supa || !currentUser) return { error: 'Não autenticado.' };
  if (!confirm('Tem certeza que deseja remover este membro da equipe?')) return { cancelled: true };
  try {
    const { error } = await _supa.from('team_members')
      .delete()
      .eq('owner_id', currentUser.id)
      .eq('member_id', memberId);
    if (error) return { error: error.message };
    return { ok: true };
  } catch(e) { return { error: e.message }; }
}

// Cancela um convite pendente
async function cancelarConvite(inviteId) {
  if (!_supa) return;
  try {
    await _supa.from('team_invites').delete().eq('id', inviteId);
  } catch(e) { console.warn(e); }
}

// Copia link de convite pro clipboard
function _copyLinkConvite(link) {
  navigator.clipboard.writeText(link).then(() => {
    if (typeof toast === 'function') toast('🔗 Link copiado! Envie pelo WhatsApp ou email.');
  });
}

// Verifica URL: ?invite=TOKEN → guarda em localStorage pra aceitar após login
function _checkInviteFromUrl() {
  const params = new URLSearchParams(location.search);
  const token = params.get('invite');
  if (token) {
    localStorage.setItem('consult_pending_invite', token);
    // Limpa a URL pra não ficar exposto
    history.replaceState({}, '', location.pathname);
  }
}

// Mostra o banner "Você foi convidado!" na tela de login e prepara o cadastro.
// Chamado quando há convite pendente E a pessoa ainda não está logada.
async function _mostrarBannerConvite() {
  const token = localStorage.getItem('consult_pending_invite');
  const banner = document.getElementById('login-invite-banner');
  if (!token || !banner || !_supa) return;
  try {
    const { data, error } = await _supa.rpc('peek_invite', { invite_token: token });
    if (error || !data || !data.valid) {
      // Token inválido/expirado — limpa pra não confundir
      if (data && !data.valid) localStorage.removeItem('consult_pending_invite');
      return;
    }
    const papel = _papelLabel(data.role);
    const txt = document.getElementById('login-invite-text');
    if (txt) txt.innerHTML = `<strong>${_esc(data.ownerNome)}</strong> convidou você para a equipe como <strong>${papel}</strong>.<br>Crie sua conta abaixo (ou entre, se já tiver) para aceitar.`;
    banner.style.display = '';

    // Vai direto pra aba "Criar conta" (a maioria dos convidados é novo)
    setLoginTab('cadastro');

    // Pré-preenche o e-mail do convite e bloqueia (o aceite valida por e-mail)
    const emailEl = document.getElementById('signup-email');
    if (emailEl && data.email) { emailEl.value = data.email; }

    // Esconde seletores de função/modo — o convite já define isso
    const roleWrap = document.getElementById('signup-role-wrap');
    const modoWrap = document.getElementById('signup-modo-wrap');
    const note     = document.getElementById('signup-invite-note');
    if (roleWrap) roleWrap.style.display = 'none';
    if (modoWrap) modoWrap.style.display = 'none';
    if (note) {
      const extra = data.role === 'secretaria' ? 'Sem acesso ao financeiro.' : data.role === 'profissional' ? 'Você verá só a sua própria agenda e pacientes.' : '';
      note.innerHTML = `Você entrará como <strong>${papel}</strong> na equipe de ${_esc(data.ownerNome)}. ${extra}`;
      note.style.display = '';
    }
    // Força o role do signup pro valor do convite
    const roleSel = document.getElementById('signup-role');
    if (roleSel) roleSel.value = data.role;
  } catch(e) { console.warn('peek_invite:', e.message); }
}

// Aceita um convite pendente (chamado após signup/login)
async function _acceptInviteIfPending() {
  if (!_supa || !currentUser) return;
  const token = localStorage.getItem('consult_pending_invite');
  if (!token) return;
  localStorage.removeItem('consult_pending_invite');
  try {
    // Aceite via função SECURITY DEFINER (valida token + insere membro
    // + marca aceito, tudo server-side, sem expor tokens de terceiros)
    const { data, error } = await _supa.rpc('accept_invite', { invite_token: token });
    if (error) {
      console.warn('accept_invite RPC error:', error.message);
      if (typeof toast === 'function') {
        setTimeout(() => toast('⚠️ Não foi possível aceitar o convite. Peça um novo link.', 4000), 1500);
      }
      return;
    }
    if (data && data.error) {
      console.warn('accept_invite:', data.error);
      if (typeof toast === 'function') {
        setTimeout(() => toast('⚠️ ' + data.error, 4000), 1500);
      }
      return;
    }
    if (data && data.ok) {
      currentRole = data.role || currentRole;
      if (data.profissional_id) currentProfissionalId = data.profissional_id;
      if (typeof toast === 'function') {
        setTimeout(() => toast('✅ Você entrou em uma equipe! Agora vê os dados compartilhados.', 4000), 1500);
      }
    }
  } catch(e) { console.warn('_acceptInviteIfPending:', e.message); }
}

// Resolve quem é o "dono" dos dados que esse user está vendo:
// - Se é membro de uma equipe → owner_id do dono
// - Caso contrário → ele mesmo (currentUser.id)
async function resolveDataOwner() {
  if (!_supa || !currentUser) return;
  try {
    // Quem tem clínica PRÓPRIA (já gravou dados em app_data) sempre vê a própria,
    // mesmo sendo também membro de outra equipe. Sem isto, aceitar um convite de
    // outra clínica trancava o dono fora da sua (resolveDataOwner adotava o
    // vínculo de equipe por cima da própria conta). Só quem NÃO tem clínica
    // própria adota o papel de membro.
    const { data: propria } = await _supa.from('app_data')
      .select('key').eq('user_id', currentUser.id).limit(1);
    const temClinicaPropria = !!(propria && propria.length);

    const { data } = await _supa.from('team_members')
      .select('owner_id, role')
      .eq('member_id', currentUser.id)
      .limit(1);
    if (!temClinicaPropria && data && data.length) {
      currentDataOwner = data[0].owner_id;
      currentTeamRole  = 'member';
      currentRole      = data[0].role || currentRole; // role na equipe
      // Vínculo com profissional (defensivo: coluna só existe após o SQL do Tijolo 2)
      const r2 = await _supa.from('team_members').select('profissional_id')
        .eq('member_id', currentUser.id).eq('owner_id', currentDataOwner).limit(1);
      if (!r2.error && r2.data && r2.data.length) currentProfissionalId = r2.data[0].profissional_id || null;
    } else {
      currentDataOwner = currentUser.id;
      currentTeamRole  = 'owner';
      currentProfissionalId = null;
    }
  } catch(e) {
    console.warn('resolveDataOwner error:', e.message);
    currentDataOwner = currentUser.id;
    currentTeamRole  = 'owner';
  }
}

// Login com e-mail/senha
async function loginUser(email, password) {
  if (!_supa) return { error: 'Supabase não carregou. Recarregue a página.' };
  try {
    const { data, error } = await _supa.auth.signInWithPassword({ email, password });
    if (error) return { error: _traduzirErroAuth(error.message) };
    currentUser = data.user;
    // Busca role do perfil
    const { data: profile } = await _supa.from('profiles').select('role, nome').eq('id', currentUser.id).single();
    if (!profile) {
      // Primeiro login após signup com confirmação por email — cria perfil a partir do metadata
      const meta = currentUser.user_metadata || {};
      const nomeMeta = meta.nome || email.split('@')[0];
      const roleMeta = meta.role || 'medico';
      await _supa.from('profiles').upsert({ id: currentUser.id, nome: nomeMeta, role: roleMeta });
      currentRole = roleMeta;
      currentNome = nomeMeta;
      localStorage.setItem('consult_onboarding_pending', '1');
    } else {
      currentRole = profile.role || 'secretaria';
      currentNome  = profile.nome  || email.split('@')[0];
    }
    // Aceita convite pendente (se houver token na URL/localStorage)
    await _acceptInviteIfPending();
    // Resolve dono dos dados (própria conta ou equipe que ele é membro)
    await resolveDataOwner();
    _auditLog('login', 'sistema', `Entrou no sistema`);
    // Sincroniza dados da nuvem
    await cloudPull();
    // Inicia Realtime para leads do WhatsApp
    initLeadsRealtime();
    // Verifica leads pendentes que chegaram offline
    syncLeadsFromSupabase();
    return { ok: true };
  } catch(e) { return { error: e.message }; }
}

// Cadastro de novo usuário
async function signUpUser(email, password, nome, role) {
  if (!_supa) return { error: 'Supabase não carregou. Recarregue a página.' };
  try {
    const { data, error } = await _supa.auth.signUp({
      email, password,
      options: { data: { nome, role } }
    });
    if (error) return { error: _traduzirErroAuth(error.message) };
    if (!data.user) return { error: 'Não foi possível criar a conta. Tente novamente.' };

    // Cria perfil. Se o Supabase exigir confirmação por email, a sessão ainda não existe — o perfil será criado no primeiro login.
    if (data.session) {
      currentUser = data.user;
      const { error: pErr } = await _supa.from('profiles').upsert({ id: data.user.id, nome, role });
      if (pErr) console.warn('Erro criando perfil:', pErr.message);
      currentRole = role;
      currentNome = nome;
      localStorage.setItem('consult_onboarding_pending', '1');
      // Aceita convite pendente se houver token na URL
      await _acceptInviteIfPending();
      await resolveDataOwner();
      initLeadsRealtime();
      return { ok: true, needsConfirmation: false };
    }
    return { ok: true, needsConfirmation: true };
  } catch(e) { return { error: e.message }; }
}

// Toggle entre os estados do login: 'entrar' | 'cadastro' | 'recuperar' | 'nova-senha'
function setLoginTab(tab) {
  const tEnt = document.getElementById('login-tab-entrar');
  const tCad = document.getElementById('login-tab-cadastro');
  const fEnt = document.getElementById('login-form-entrar');
  const fCad = document.getElementById('login-form-cadastro');
  const fRec = document.getElementById('login-form-recuperar');
  const fNova= document.getElementById('login-form-nova-senha');
  const tabsWrap = (tEnt && tEnt.parentElement) ? tEnt.parentElement : null;
  const errEl = document.getElementById('login-error');
  const okEl  = document.getElementById('login-success');
  if (errEl) errEl.style.display = 'none';
  if (okEl)  okEl.style.display = 'none';

  // Esconde todos os forms
  [fEnt, fCad, fRec, fNova].forEach(f => { if (f) f.style.display = 'none'; });

  // As tabs Entrar/Criar conta só aparecem nos estados normais
  if (tabsWrap) tabsWrap.style.display = (tab === 'recuperar' || tab === 'nova-senha') ? 'none' : '';

  if (tab === 'cadastro') {
    tCad.style.color = '#0f172a'; tCad.style.borderBottomColor = '#0f172a';
    tEnt.style.color = '#94a3b8'; tEnt.style.borderBottomColor = 'transparent';
    if (fCad) fCad.style.display = '';
  } else if (tab === 'recuperar') {
    if (fRec) fRec.style.display = '';
    setTimeout(() => document.getElementById('recuperar-email')?.focus(), 100);
  } else if (tab === 'nova-senha') {
    if (fNova) fNova.style.display = '';
    setTimeout(() => document.getElementById('nova-senha')?.focus(), 100);
  } else {
    tEnt.style.color = '#0f172a'; tEnt.style.borderBottomColor = '#0f172a';
    tCad.style.color = '#94a3b8'; tCad.style.borderBottomColor = 'transparent';
    if (fEnt) fEnt.style.display = '';
  }
}

// Envia email de recuperação de senha
async function doRecuperarSenha() {
  const email = (document.getElementById('recuperar-email').value || '').trim();
  const btn   = document.getElementById('recuperar-btn');
  const errEl = document.getElementById('login-error');
  const okEl  = document.getElementById('login-success');
  errEl.style.display = 'none'; okEl.style.display = 'none';

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errEl.textContent = 'Digite um e-mail válido.';
    errEl.style.display = 'block';
    return;
  }
  if (!_supa) { errEl.textContent = 'Conexão indisponível. Recarregue a página.'; errEl.style.display = 'block'; return; }

  btn.textContent = 'Enviando…'; btn.disabled = true;
  try {
    const redirectTo = location.origin + location.pathname;
    const { error } = await _supa.auth.resetPasswordForEmail(email, { redirectTo });
    if (error) {
      errEl.textContent = _traduzirErroAuth(error.message);
      errEl.style.display = 'block';
    } else {
      okEl.innerHTML = `✅ Se existe uma conta com <strong>${_esc(email)}</strong>, enviamos um link de recuperação. Verifique sua caixa de entrada (e o spam).`;
      okEl.style.display = 'block';
    }
  } catch(e) {
    errEl.textContent = e.message;
    errEl.style.display = 'block';
  } finally {
    btn.textContent = 'Enviar link de recuperação';
    btn.disabled = false;
  }
}

// Salva a nova senha (após clicar no link de recuperação do email)
async function doNovaSenha() {
  const s1 = document.getElementById('nova-senha').value || '';
  const s2 = document.getElementById('nova-senha-conf').value || '';
  const btn = document.getElementById('nova-senha-btn');
  const errEl = document.getElementById('login-error');
  const okEl  = document.getElementById('login-success');
  errEl.style.display = 'none'; okEl.style.display = 'none';

  if (s1.length < 8) { errEl.textContent = 'A senha precisa de no mínimo 8 caracteres.'; errEl.style.display = 'block'; return; }
  if (s1 !== s2)     { errEl.textContent = 'As senhas não conferem.'; errEl.style.display = 'block'; return; }
  if (!_supa) { errEl.textContent = 'Conexão indisponível.'; errEl.style.display = 'block'; return; }

  btn.textContent = 'Salvando…'; btn.disabled = true;
  try {
    const { error } = await _supa.auth.updateUser({ password: s1 });
    if (error) {
      errEl.textContent = _traduzirErroAuth(error.message);
      errEl.style.display = 'block';
      btn.textContent = 'Salvar nova senha'; btn.disabled = false;
      return;
    }
    okEl.innerHTML = '✅ Senha alterada! Entrando…';
    okEl.style.display = 'block';
    _auditLog('configurou', 'sistema', 'Redefiniu a senha via recuperação');
    // A sessão já está ativa após o updateUser — inicia o app
    setTimeout(() => location.reload(), 1500);
  } catch(e) {
    errEl.textContent = e.message;
    errEl.style.display = 'block';
    btn.textContent = 'Salvar nova senha'; btn.disabled = false;
  }
}

// Handler do botão Criar conta
async function doSignup() {
  const nome     = (document.getElementById('signup-nome').value || '').trim();
  const email    = (document.getElementById('signup-email').value || '').trim();
  const password =  document.getElementById('signup-password').value || '';
  const role     =  document.getElementById('signup-role').value || 'medico';
  const modo     =  document.getElementById('signup-modo')?.value || 'completo';
  const btn      =  document.getElementById('signup-btn');
  const errEl    =  document.getElementById('login-error');
  const okEl     =  document.getElementById('login-success');

  errEl.style.display = 'none'; okEl.style.display = 'none';

  if (!nome || !email || !password) {
    errEl.textContent = 'Preencha todos os campos.';
    errEl.style.display = 'block';
    return;
  }
  if (password.length < 8) {
    errEl.textContent = 'A senha precisa de no mínimo 8 caracteres.';
    errEl.style.display = 'block';
    return;
  }

  btn.textContent = 'Criando…';
  btn.disabled = true;
  const result = await signUpUser(email, password, nome, role);
  btn.textContent = 'Criar conta gratuita';
  btn.disabled = false;

  // Salva o modo escolhido (em clinica_config, que sincroniza)
  if (!result || !result.error) {
    const cfg = getClinicaConfig();
    cfg.modo = modo;
    DB.setObj('clinica_config', cfg);
  }

  if (result && result.error) {
    errEl.textContent = result.error;
    errEl.style.display = 'block';
    return;
  }

  if (result.needsConfirmation) {
    okEl.innerHTML = `✅ Conta criada! Verifique seu e-mail (<strong>${_esc(email)}</strong>) para confirmar antes de entrar.`;
    okEl.style.display = 'block';
    setLoginTab('entrar');
    document.getElementById('login-email').value = email;
    return;
  }

  // Login automático bem-sucedido
  // Se entrou numa equipe (via convite), baixa os dados do dono antes de abrir o app
  if (currentDataOwner && currentDataOwner !== currentUser?.id) {
    await cloudPull();
    if (typeof syncLeadsFromSupabase === 'function') syncLeadsFromSupabase();
  }
  _iniciarApp();
  // Só mostra onboarding pra quem NÃO veio de convite (dono de clínica nova)
  if (!(currentDataOwner && currentDataOwner !== currentUser?.id)) {
    setTimeout(() => mostrarOnboarding(), 400);
  }
}

// Logout
async function logoutUser() {
  // O logout apaga TODO o consult_* — inclusive o outbox. Escrita que ainda não
  // chegou ao servidor morre aí, em silêncio: some do aparelho e nunca existiu
  // na nuvem. Última chance de entregar, e se sobrar algo quem decide é o usuário.
  try { await _drenarOutbox(); } catch(e) { console.warn('logout: drenar outbox —', e.message); }
  const pendentes = Object.keys(_outboxGet());
  if (pendentes.length && !confirm(
      'Estas alterações ainda não foram salvas na nuvem:\n\n  ' + pendentes.join(', ') +
      '\n\nSair agora vai descartá-las neste aparelho. Sair mesmo assim?')) return;

  _auditLog('logout', 'sistema', `Saiu do sistema`);
  if (_supa) await _supa.auth.signOut();
  currentUser = null;
  currentRole = null;
  currentNome  = '';
  currentDataOwner = null;
  currentTeamRole  = null;
  currentProfissionalId = null;
  _agFiltroProf = '';
  // Limpa todas as chaves consult_* do localStorage (evita cross-pollination entre usuários)
  Object.keys(localStorage).filter(k => k.startsWith('consult_')).forEach(k => localStorage.removeItem(k));
  document.getElementById('login-page').style.display = 'flex';
  document.getElementById('login-email').value = '';
  document.getElementById('login-password').value = '';
  document.getElementById('login-btn').textContent = 'Entrar';
  document.getElementById('login-btn').disabled = false;
  document.getElementById('login-error').style.display = 'none';
}

// Verifica sessão existente
async function checkSession() {
  if (!_supa) return false;
  try {
    const { data: { session } } = await _supa.auth.getSession();
    if (!session) return false;
    currentUser = session.user;
    const { data: profile } = await _supa.from('profiles').select('role, nome').eq('id', currentUser.id).single();
    if (!profile) {
      const meta = currentUser.user_metadata || {};
      const nomeMeta = meta.nome || session.user.email.split('@')[0];
      const roleMeta = meta.role || 'medico';
      await _supa.from('profiles').upsert({ id: currentUser.id, nome: nomeMeta, role: roleMeta });
      currentRole = roleMeta;
      currentNome = nomeMeta;
      localStorage.setItem('consult_onboarding_pending', '1');
    } else {
      currentRole = profile.role || 'secretaria';
      currentNome  = profile.nome  || session.user.email.split('@')[0];
    }
    await resolveDataOwner();
    return true;
  } catch(e) { return false; }
}

// Traduz mensagens de erro do Supabase Auth
function _traduzirErroAuth(msg) {
  if (msg.includes('Invalid login credentials') || msg.includes('invalid_credentials')) return 'E-mail ou senha incorretos.';
  if (msg.includes('Email not confirmed')) return 'E-mail não confirmado. Verifique sua caixa de entrada.';
  if (msg.includes('Too many requests')) return 'Muitas tentativas. Aguarde alguns minutos.';
  if (msg.includes('already registered') || msg.includes('User already registered')) return 'Este e-mail já está cadastrado. Use a aba "Entrar".';
  if (msg.includes('Password should be at least')) return 'A senha precisa de no mínimo 8 caracteres.';
  if (msg.toLowerCase().includes('invalid email')) return 'E-mail inválido.';
  if (msg.includes('Signups not allowed')) return 'Cadastro temporariamente desabilitado. Contate o administrador.';
  if (msg.includes('For security purposes') || msg.includes('after')) return 'Aguarde alguns segundos antes de tentar de novo.';
  if (msg.includes('same as the old') || msg.includes('should be different')) return 'A nova senha precisa ser diferente da anterior.';
  if (msg.includes('Auth session missing') || msg.includes('session_not_found')) return 'Link de recuperação expirado. Solicite um novo.';
  return msg;
}

// Página de login: handler do botão Entrar
async function doLogin() {
  const email    = (document.getElementById('login-email').value || '').trim();
  const password =  document.getElementById('login-password').value || '';
  const btn      =  document.getElementById('login-btn');
  const errEl    =  document.getElementById('login-error');

  if (!email || !password) {
    errEl.textContent = 'Preencha e-mail e senha.';
    errEl.style.display = 'block';
    return;
  }

  btn.textContent = 'Entrando…';
  btn.disabled = true;
  errEl.style.display = 'none';

  const result = await loginUser(email, password);

  if (result && result.error) {
    errEl.textContent = result.error;
    errEl.style.display = 'block';
    btn.textContent = 'Entrar';
    btn.disabled = false;
    return;
  }

  // Sucesso — verifica se precisa de 2FA
  const mfaCheck = await mfaVerificarSeNecessario();
  if (mfaCheck.needsCode) {
    const ok = await pedir2FACodigo();
    if (!ok) {
      // Cancelou 2FA — força novo login
      errEl.textContent = 'Verificação 2FA cancelada. Faça login novamente.';
      errEl.style.display = 'block';
      btn.textContent = 'Entrar'; btn.disabled = false;
      return;
    }
  }
  _iniciarApp();
}

// Mostra modal de boas-vindas (após signup ou primeiro login)
function mostrarOnboarding() {
  if (localStorage.getItem('consult_onboarding_done')) return;
  const modal = document.getElementById('modal-onboarding');
  if (!modal) return;
  const saudacao = document.getElementById('onb-saudacao');
  if (saudacao && currentNome) {
    const formatado = currentRole === 'medico' ? `Dr(a). ${currentNome}` : currentNome;
    saudacao.textContent = `Olá, ${formatado}! Tudo pronto para começar.`;
  }
  modal.style.display = 'flex';
}

function closeOnboarding() {
  const modal = document.getElementById('modal-onboarding');
  if (!modal) return;
  const noShow = document.getElementById('onb-no-show');
  if (noShow && noShow.checked) {
    localStorage.setItem('consult_onboarding_done', '1');
  }
  localStorage.removeItem('consult_onboarding_pending');
  modal.style.display = 'none';
}

// Mostra o app e configura role
function _iniciarApp() {
  // GUARD: só inicia se houver sessão válida (impede bypass via console)
  if (!currentUser || !currentRole) {
    document.getElementById('login-page').style.display = 'flex';
    console.warn('_iniciarApp bloqueado: faça login antes.');
    return;
  }
  // Esconde login
  document.getElementById('login-page').style.display = 'none';
  // Atualiza sidebar
  _atualizarSidebar();
  // Aplica visibilidade de role
  _applyRole();
  // Inicializa ícones e dashboard
  if (window.lucide) lucide.createIcons();
  applyClinicaConfig();
  _reorderDashboardSections();
  renderDashboard();
  saudacaoDiaria();
  setTimeout(() => checkAchievements(), 1000); // verifica conquistas após render
  setTimeout(() => criarSnapshotDiario().then(r => r.created && console.log('🗂️ Backup automático criado:', r.data)), 3000);
  setTimeout(() => rodarCicloLembretes().then(r => {
    if (r.enviados > 0) toast(`📲 ${r.enviados} lembrete(s) WhatsApp enviado(s).`, 4000);
  }), 5000);
  // Sincroniza UI mobile com página inicial
  _mobSync('dashboard');
  // Mostra modal de boas-vindas se for primeiro acesso
  if (localStorage.getItem('consult_onboarding_pending')) {
    setTimeout(() => mostrarOnboarding(), 500);
  }
}

// Reordena as seções do Dashboard segundo a prioridade do médico:
// 1º Inteligência Financeira  2º Gráficos Operacionais  3º Receita Recorrente …
function _reorderDashboardSections() {
  const dashboard = document.getElementById('page-dashboard');
  if (!dashboard) return;
  const ordem = ['financeiro', 'graficos-operacionais', 'mrr', 'procedimentos',
                 'retencao', 'marketing', 'graficos', 'funil-ultimas'];
  const sections = ordem
    .map(name => dashboard.querySelector(`[data-section="${name}"]`))
    .filter(Boolean);
  if (!sections.length) return;
  // Pega o pai da primeira seção (mesmo pai pra todas)
  const parent = sections[0].parentNode;
  // Reanexa na ordem desejada — appendChild remove do lugar atual e insere no fim
  sections.forEach(el => parent.appendChild(el));
}

// Evita "Dr. Dr. Fulano": se o nome já foi cadastrado com o título (comum —
// gente digita "Dr. Fulano" no próprio cadastro), não duplica o prefixo.
// "dr"/"dra" só conta como título se seguido de "." ou espaço — protege nomes
// reais que começam com essas letras (Drico, Dracena, Draylson...). O regex é
// repetido nas duas funções (não um const module-level) de propósito — os
// testes extraem cada função isoladamente (ver tests/_extrair.js).
function _comTituloMedico(nome) {
  const n = (nome || '').trim();
  if (!n) return n;
  const tituloRe = /^dr\.\s*|^dr\s+|^dra\.\s*|^dra\s+/i;
  return tituloRe.test(n) ? n : `Dr. ${n}`;
}

// Primeiro nome, SEM título — precisa tirar "Dr./Dra." antes de cortar pela
// primeira palavra, senão "Dr. Teste" vira só "Dr." e um _comTituloMedico()
// depois duplica pra "Dr. Dr." (bug real que apareceu na saudação do dashboard).
function _primeiroNomeSemTitulo(nomeCompleto) {
  const n = (nomeCompleto || '').trim();
  const tituloRe = /^dr\.\s*|^dr\s+|^dra\.\s*|^dra\s+/i;
  const semTitulo = n.replace(tituloRe, '').trim();
  return (semTitulo || n).split(' ')[0] || '';
}

function _saudacaoPorHora() {
  const h = new Date().getHours();
  return h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
}

// Escreve a data por extenso logo abaixo de um <input type="date">.
function _atualizarDataExtenso(inp) {
  const hint = inp._extensoHint;
  if (!hint) return;
  if (!inp.value) { hint.textContent = ''; return; }
  const d = new Date(inp.value + 'T12:00:00');
  hint.textContent = isNaN(d) ? '' : d.toLocaleDateString('pt-BR', { weekday: 'short', day: 'numeric', month: 'long' });
}

// Liga o "por extenso" em todo input[type=date] da página (uma vez, no boot).
// Modais setam .value via JS (não dispara 'input'), então observamos a
// ABERTURA do modal (mudança de style) pra recalcular com o valor já preenchido.
function _iniciarDatasExtenso() {
  const anexar = (inp) => {
    if (inp._extensoHint) return;
    const hint = document.createElement('div');
    hint.style.cssText = 'font-size:10.5px;color:#94a3b8;margin-top:3px;';
    inp.insertAdjacentElement('afterend', hint);
    inp._extensoHint = hint;
    inp.addEventListener('input', () => _atualizarDataExtenso(inp));
  };
  const refrescar = (root) => (root || document).querySelectorAll('input[type="date"]').forEach(inp => {
    anexar(inp);
    _atualizarDataExtenso(inp);
  });
  document.querySelectorAll('.modal-overlay').forEach(modal => {
    new MutationObserver(() => { if (modal.style.display !== 'none') refrescar(modal); })
      .observe(modal, { attributes: true, attributeFilter: ['style'] });
  });
  refrescar(document);
}

function _atualizarSidebar() {
  const eMedico = currentRole === 'medico';
  const nomeFormatado = eMedico ? _comTituloMedico(currentNome) : currentNome;
  const ehMembro = currentTeamRole === 'member';
  // Etiqueta verdadeira do papel (antes mostrava "Secretária" pra QUALQUER não-médico,
  // escondendo que a pessoa era na verdade "Profissional").
  const papelLabel = currentRole === 'medico' ? 'Médico'
                   : currentRole === 'profissional' ? 'Profissional'
                   : 'Secretária';

  // Footer da sidebar (avatar + nome + role)
  const nomeEl   = document.getElementById('sidebar-nome');
  const roleEl   = document.getElementById('sidebar-role');
  const avatarEl = document.getElementById('sidebar-avatar');
  if (nomeEl)   nomeEl.textContent = nomeFormatado;
  if (roleEl)   roleEl.textContent = papelLabel + (ehMembro ? ' · 👥 Em equipe' : '');
  if (avatarEl) avatarEl.textContent = currentNome.charAt(0).toUpperCase();

  // Header da sidebar (logo)
  const headerNome = document.getElementById('sidebar-header-nome');
  const headerEsp  = document.getElementById('sidebar-header-esp');
  if (headerNome) headerNome.textContent = nomeFormatado;
  if (headerEsp)  headerEsp.textContent  = eMedico ? 'Geriatria' : papelLabel;

  // Nível de maestria
  _atualizarSidebarMaestria();
}

// Páginas restritas à secretária
const _PAGES_FINANCEIRO = ['receita', 'despesas', 'relatorio', 'metas', 'precos', 'backup'];

// Páginas escondidas no modo "Apenas Financeiro"
const _PAGES_OPERACIONAL = ['crm', 'followup', 'programas', 'agenda'];

function getAppMode() {
  // Modo da clínica: 'completo' (default) | 'financeiro'
  return getClinicaConfig().modo || 'completo';
}

function setAppMode(modo) {
  const cfg = getClinicaConfig();
  cfg.modo = modo;
  DB.setObj('clinica_config', cfg);
  _applyRole();            // re-aplica visibilidade da sidebar
  _aplicarModoUI();        // ajusta rótulos/seções
  _auditLog('configurou', 'sistema', `Mudou para modo ${modo === 'financeiro' ? 'Apenas Financeiro' : 'Operação Completa'}`);
  // Se a página atual ficou escondida, volta pro Dashboard
  const ativo = document.querySelector('.page.active');
  if (ativo && modo === 'financeiro') {
    const pid = ativo.id.replace('page-', '');
    if (_PAGES_OPERACIONAL.includes(pid)) showPage('dashboard');
  }
}

// O financeiro é do DONO da clínica. O RLS (SETUP_SEGURANCA.sql) só deixa o
// próprio dono ler e gravar 'despesas' e 'metas*' — nem médico membro entra.
// A sidebar, porém, liberava o financeiro pra qualquer currentRole === 'medico',
// inclusive médico MEMBRO da equipe de outra pessoa: ele abria Despesas, lançava
// o gasto, via a linha aparecer na tela — e o push era recusado em silêncio.
// A tela mentia. Aqui a UI passa a seguir a mesma regra que já está no banco.
function _podeVerFinanceiro() {
  if (currentRole !== 'medico') return false;
  return !currentUser || (currentDataOwner || currentUser.id) === currentUser.id;
}

function _applyRole() {
  // Sem sessão: esconde toda a sidebar (defesa extra contra bypass)
  if (!currentRole) {
    document.querySelectorAll('.nav-item').forEach(el => el.style.display = 'none');
    document.body.classList.add('role-no-fin');
    return;
  }
  // Blindagem financeira do Dashboard: só o médico DONO vê cards/seções
  // financeiras (Faturamento, Lucro, Despesas, Inteligência Financeira, DRE,
  // MRR, Análise). Ninguém mais vê — nem que renderDashboard reexiba.
  const veFinanceiro = _podeVerFinanceiro();
  document.body.classList.toggle('role-no-fin', !veFinanceiro);
  // Garante que itens não-financeiros estão visíveis
  document.querySelectorAll('.nav-item').forEach(el => el.style.display = '');
  _PAGES_FINANCEIRO.forEach(p => {
    const el = document.getElementById('nav-' + p);
    if (el) el.style.display = veFinanceiro ? '' : 'none';
  });
  // Modo "Apenas Financeiro" — esconde CRM/Follow-Up/Programas/Agenda
  if (getAppMode() === 'financeiro') {
    _PAGES_OPERACIONAL.forEach(p => {
      const el = document.getElementById('nav-' + p);
      if (el) el.style.display = 'none';
      const mob = document.getElementById('mob-nav-' + p);
      if (mob) mob.style.display = 'none';
    });
  } else {
    _PAGES_OPERACIONAL.forEach(p => {
      const mob = document.getElementById('mob-nav-' + p);
      if (mob) mob.style.display = '';
    });
  }
  // Esconde headers de seção que ficaram sem itens visíveis
  _ajustarSecoesSidebar();
}

// Esconde um header de seção (.nav-section) se todos os nav-items seguintes estão ocultos
function _ajustarSecoesSidebar() {
  document.querySelectorAll('.nav-section').forEach(sec => {
    let temVisivel = false;
    let n = sec.nextElementSibling;
    while (n && n.classList.contains('nav-item')) {
      if (n.style.display !== 'none') { temVisivel = true; break; }
      n = n.nextElementSibling;
    }
    sec.style.display = temVisivel ? '' : 'none';
  });
}

// Ajustes de UI específicos do modo (rótulos de seção, etc.)
function _aplicarModoUI() {
  // Destaca o botão do modo ativo em Configurações
  const modo = getAppMode();
  const comp = document.getElementById('modo-completo-btn');
  const fin  = document.getElementById('modo-financeiro-btn');
  if (comp && fin) {
    const ativo   = '#7c3aed';
    const inativo = '#e2e8f0';
    comp.style.borderColor = modo === 'completo'   ? ativo : inativo;
    comp.style.background   = modo === 'completo'   ? '#faf5ff' : '#fff';
    fin.style.borderColor   = modo === 'financeiro' ? ativo : inativo;
    fin.style.background     = modo === 'financeiro' ? '#faf5ff' : '#fff';
  }
}

// ====================== HELPERS DE SEGURANÇA ======================
// Escapa string para inserção segura em innerHTML (evita XSS armazenado)
function _esc(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// Argumento seguro para string JS dentro de atributo HTML (onclick="f('...')").
// encodeURIComponent NÃO escapa a aspa simples: um nome vindo do WhatsApp como
// x'*fetch(...)*' fechava a string e executava. O %27 é restaurado intacto pelo
// decodeURIComponent do outro lado, então nomes com apóstrofo (D'Ávila) seguem
// funcionando. Use SEMPRE isto — nunca encodeURIComponent puro — em onclick.
function _jsArg(s) {
  return encodeURIComponent(s == null ? '' : String(s)).replace(/'/g, '%27');
}

// Normaliza telefone BR para a forma local (sem DDI 55) — a MESMA usada pelo
// webhook como chave do chat. Sem isso, contato salvo com "+55" ganhava chave
// diferente e duplicava lead / abria chat vazio.
// Cuidado: DDD 55 existe (região de Santa Maria-RS) — só removemos o 55
// inicial quando o número tem 12+ dígitos (DDI + DDD + número).
function _normPhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.length >= 12 && d.startsWith('55')) d = d.slice(2);
  return d;
}

// Link wa.me correto (evita 5555... quando o cadastro já tinha o DDI).
function _waMeLink(raw, texto) {
  const n = _normPhone(raw);
  return `https://wa.me/55${n}${texto ? '?text=' + encodeURIComponent(texto) : ''}`;
}

// Gemini key — agora isolada por user_id via Supabase (sai do localStorage exposto)
function getGeminiKey() {
  // Tenta DB (vai pro Supabase via app_data) e, se não tiver, faz fallback temporário pra localStorage antigo
  const fromDb = JSON.parse(localStorage.getItem('consult_gemini_key_secure') || 'null');
  if (fromDb) return fromDb;
  // Migração: se ainda existe a chave antiga em texto plano, move pro novo formato e apaga
  const legado = localStorage.getItem('consult_gemini_key');
  if (legado) {
    localStorage.setItem('consult_gemini_key_secure', JSON.stringify(legado));
    if (typeof cloudPush === 'function') cloudPush('gemini_key_secure');
    localStorage.removeItem('consult_gemini_key');
    return legado;
  }
  return '';
}
function setGeminiKey(key) {
  localStorage.setItem('consult_gemini_key_secure', JSON.stringify(key || ''));
  if (typeof cloudPush === 'function') cloudPush('gemini_key_secure');
}

// ====================== ESTADO DA APP ======================

// Fila serial POR CHAVE. Sem ela, duas gravações seguidas na mesma coleção
// ("excluir" e logo o "desfazer") viravam dois pushes concorrentes e o servidor
// podia confirmar na ordem trocada — o estado final da nuvem ficava sendo o do
// meio, não o que está na tela. O `old` de cada push é lido no momento da
// chamada (localStorage é síncrono), então cada diff continua correto.
const _filaPush = {};
function _enfileirarPush(key, tarefa) {
  const atual = (_filaPush[key] || Promise.resolve()).then(tarefa, tarefa);
  _filaPush[key] = atual.catch(() => {});
  return atual;
}

const DB = {
  get: (key) => JSON.parse(localStorage.getItem('consult_' + key) || '[]'),
  // Devolve Promise<boolean>: true = o servidor confirmou. Quase todo mundo
  // chama sem await (a UI não espera a nuvem) — mas quem precisa saber se a
  // gravação chegou ANTES de dar o passo seguinte irreversível pode esperar.
  set: (key, val) => {
    // Blindagem: coleções sensíveis sincronizam na tabela por linha (não no "pacote único")
    const cfg = _BLINDADAS[key];
    if (cfg) {
      const old = JSON.parse(localStorage.getItem('consult_' + key) || '[]');
      localStorage.setItem('consult_' + key, JSON.stringify(val));
      // Falhou (offline/RLS)? Vai pra outbox — o pull não sobrescreve e a fila
      // re-entrega quando a conexão voltar.
      return _enfileirarPush(key, () => _pushBlindada(cfg.tabela, old, val)
        .then(ok => { if (ok) _outboxRemove(key); else _outboxAdd(key, 'blindada'); return ok; })
        .catch(() => { _outboxAdd(key, 'blindada'); return false; }));
    }
    localStorage.setItem('consult_' + key, JSON.stringify(val));
    // cloudPush já enfileira sozinho quando falha — sair da fila é a confirmação.
    return _enfileirarPush(key, () => cloudPush(key)
      .then(() => !(key in _outboxGet())).catch(() => false));
  },
  getObj: (key, def = {}) => JSON.parse(localStorage.getItem('consult_' + key) || JSON.stringify(def)),
  setObj: (key, val) => {
    localStorage.setItem('consult_' + key, JSON.stringify(val));
    return _enfileirarPush(key, () => cloudPush(key)
      .then(() => !(key in _outboxGet())).catch(() => false));
  },
};

// ============ IDs ESTÁVEIS — Fase 1 da blindagem (aditivo, não muda comportamento) ============
function _novoId(pref) { return (pref || 'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

// Resolve paciente/contato por id (preferido) com fallback pro índice (compat).
function _pacientePorRef(pacId, pacIdx) {
  const pacs = DB.get('pacientes');
  if (pacId) { const p = pacs.find(x => x.id === pacId); if (p) return p; }
  return (pacIdx != null && pacs[pacIdx]) ? pacs[pacIdx] : null;
}
function _crmPorRef(crmId, crmIdx) {
  const crm = DB.get('crm');
  if (crmId) { const c = crm.find(x => x.id === crmId); if (c) return c; }
  return (crmIdx != null && crm[crmIdx]) ? crm[crmIdx] : null;
}
// Profissional "dono" de um paciente (pra etiquetar programas/inscrições):
// pega o profissional de um atendimento dele; senão o profissional logado; senão null.
function _profDoPaciente(nome) {
  const chave = (nome || '').toLowerCase().trim();
  const p = DB.get('pacientes').find(x => (x.nome || '').toLowerCase().trim() === chave && x.profissionalId);
  return (p && p.profissionalId) || (typeof currentProfissionalId !== 'undefined' ? currentProfissionalId : null) || null;
}

// Acha UM contato do CRM pelo nome. Duas armadilhas que já morderam aqui:
//
// 1. `'qualquer coisa'.includes('')` é SEMPRE true. Contato salvo sem nome
//    casava com todo mundo — e, por estar no começo do array, era o primeiro
//    encontrado. Agendar a Carla marcava o card vazio como "Marcou" e o card
//    da Carla continuava parado.
// 2. Substring curta casa demais: "Ana" bate dentro de "Mariana".
//
// Regra: nome idêntico ganha. Só cai pro parcial com nome de verdade dos dois
// lados, e apenas quando há UM candidato — na dúvida devolve -1, porque
// escrever no contato errado é pior que não escrever.
function _nomeNorm(s) { return (s || '').toLowerCase().trim(); }

// Casamento PARCIAL por palavra inteira. Substring solta casa demais: "Ana" cai
// dentro de "Mariana" e cria uma ambiguidade que não existe pra ninguém olhando
// a tela. Com fronteira de palavra, "Bruno Alves Silva" ainda acha "Bruno
// Alves" e "Mariana" não colide com "Ana".
function _nomeCasaParcial(a, b) {
  if (a.length < 3 || b.length < 3) return false;
  const dentro = (hay, needle) => {
    const i = hay.indexOf(needle);
    if (i < 0) return false;
    return (i === 0 || hay[i - 1] === ' ')
        && (i + needle.length === hay.length || hay[i + needle.length] === ' ');
  };
  return dentro(a, b) || dentro(b, a);
}

// Acha UM registro pelo nome. `filtro` restringe os candidatos (ex.: agendamento
// não cancelado). Nome idêntico ganha; parcial só quando há um único candidato
// — na dúvida devolve -1, porque escrever no registro errado é pior que não
// escrever. Nome vazio nunca casa: `'qualquer coisa'.includes('')` é sempre
// true, e era assim que um registro sem nome virava coringa universal.
function _acharPorNome(lista, nome, campo, filtro) {
  const alvo = _nomeNorm(nome);
  if (!alvo) return -1;
  const arr = lista || [];
  const vale = (c, i) => c && (!filtro || filtro(c, i));
  // Homônimo exato também é dúvida. Duas consultas da "Ana" e um "cancela a da
  // Ana" sem data: findIndex escolheria pela ordem do array, que não quer dizer
  // nada pro usuário. Melhor devolver -1 e deixar ele dizer a data.
  const exatos = [];
  arr.forEach((c, i) => { if (vale(c, i) && _nomeNorm(c[campo]) === alvo) exatos.push(i); });
  if (exatos.length) return exatos.length === 1 ? exatos[0] : -1;
  const cands = [];
  arr.forEach((c, i) => { if (vale(c, i) && _nomeCasaParcial(_nomeNorm(c[campo]), alvo)) cands.push(i); });
  return cands.length === 1 ? cands[0] : -1;
}

function _acharCrmPorNome(crm, nome) { return _acharPorNome(crm, nome, 'nome'); }

// Migração idempotente: garante id em pacientes/crm e converte vínculos
// por índice (pacIdx/crmIdx) em vínculos por id (pacId/crmId), mantendo os
// índices em paralelo. Roda no init; só grava quando há algo a preencher.
function _migrarIds() {
  try {
    const pacs = DB.get('pacientes'); let mp = false;
    pacs.forEach(p => {
      if (!p.id) { p.id = _novoId('pac'); mp = true; }
      // Conserta o que a importação de planilha gravou na chave ERRADA: 'status'
      // em vez de 'statusPgto' (e o 'Parcelado', que não existe no app). Sem
      // isto, quem já importou continua com a receita fora de todos os KPIs.
      // Conservador de propósito: só age se statusPgto está AUSENTE e o valor
      // em 'status' é reconhecidamente um status de pagamento. Atendimento não
      // usa 'status' pra mais nada (isso é coisa de CRM e de agendamento).
      if (p.statusPgto == null && p.status != null) {
        const conv = { 'Pago': 'Pago', 'Parcial': 'Parcial', 'Parcelado': 'Parcial',
                       'Pendente': 'Pendente', 'Isento': 'Isento' }[p.status];
        if (conv) { p.statusPgto = conv; delete p.status; mp = true; }
      }
    });
    if (mp) DB.set('pacientes', pacs);
    const crm = DB.get('crm'); let mc = false;
    crm.forEach(c => { if (!c.id) { c.id = _novoId('crm'); mc = true; } });
    if (mc) DB.set('crm', crm);
    const ags = DB.get('agendamentos'); let ma = false;
    ags.forEach(a => {
      if (!a.id) { a.id = _novoId('ag'); ma = true; } // sem id ficava FORA da sync blindada
      if (a.pacId == null && a.pacIdx != null && pacs[a.pacIdx]) { a.pacId = pacs[a.pacIdx].id; ma = true; }
      if (a.crmId == null && a.crmIdx != null && crm[a.crmIdx]) { a.crmId = crm[a.crmIdx].id; ma = true; }
    });
    if (ma) DB.set('agendamentos', ags);
    const ins = DB.get('inscricoes'); let mi = false;
    ins.forEach(i => {
      if (!i.id) { i.id = _novoId('ins'); mi = true; } // idem agendamentos
      if (i.pacId == null && i.pacIdx != null && pacs[i.pacIdx]) { i.pacId = pacs[i.pacIdx].id; mi = true; }
      if (i.profissionalId == null) { const pid = _profDoPaciente(i.pacienteNome); if (pid) { i.profissionalId = pid; mi = true; } }
    });
    if (mi) DB.set('inscricoes', ins);
    // Despesas: id habilita o merge por id em conflito de sync entre aparelhos.
    const desps = DB.get('despesas'); let md = false;
    desps.forEach(d => { if (!d.id) { d.id = _novoId('desp'); md = true; } });
    if (md) DB.set('despesas', desps);
    const fus = DB.get('followup'); let mf = false;
    fus.forEach(f => {
      if (!f.id) { f.id = _novoId('fu'); mf = true; }
      if (f.profissionalId == null) { const pid = _profDoPaciente(f.nome); if (pid) { f.profissionalId = pid; mf = true; } }
    });
    if (mf) DB.set('followup', fus);
  } catch(e) { console.warn('_migrarIds:', e.message); }
}

let charts = {};
let editState = { col: null, idx: null, crmIdx: null, pacIdx: null };
let agendaView = 'diario';

// ====================== NAVEGAÇÃO + MOBILE ======================
const _MOB_TITLES = {
  dashboard:      'Dashboard',   crm: 'CRM',      pacientes: 'Atendidos',
  followup:       'Follow-Up',   programas: 'Programas',
  agenda:         'Agenda',      receita: 'Receita',
  despesas:       'Despesas',    precos: 'Preços',  relatorio: 'Relatório',
  metas:          'Metas',       backup: 'Backup',  configuracoes: 'Configurações'
};
// CTA config per page (label → modal to open, or null to hide)
const _MOB_CTA = {
  dashboard:  { label: '+ Novo',      modal: 'modal-paciente' },
  pacientes:  { label: '+ Consulta',  modal: 'modal-paciente' },
  crm:        { label: '+ Contato',   modal: 'modal-crm'      },
  agenda:     { label: '+ Horário',   modal: 'modal-agenda'   },
  despesas:   { label: '+ Despesa',   modal: 'modal-despesa'  },
  precos:     { label: '+ Preço',     modal: 'modal-preco'    },
};
// Bottom nav pages (buttons that exist in mob bottom nav)
const _MOB_NAV_PAGES = ['dashboard','agenda','pacientes'];

function _mobSync(page) {
  // Title
  const titleEl = document.getElementById('mob-page-title');
  if (titleEl) titleEl.textContent = _MOB_TITLES[page] || page;

  // CTA button
  const cta = document.getElementById('mob-cta-btn');
  if (cta) {
    const cfg = _MOB_CTA[page];
    if (cfg) {
      cta.textContent = cfg.label;
      cta.onclick = () => openModal(cfg.modal);
      cta.style.display = '';
    } else {
      cta.style.display = 'none';
    }
  }

  // Bottom nav active state
  document.querySelectorAll('.mob-nav-btn').forEach(b => b.classList.remove('active'));
  const mobBtn = document.getElementById('mob-nav-' + page);
  if (mobBtn) mobBtn.classList.add('active');
}

function toggleMobileSidebar() {
  const aside   = document.getElementById('sidebar-aside');
  const overlay = document.getElementById('mob-overlay');
  if (!aside) return;
  const isOpen = aside.classList.contains('mob-open');
  aside.classList.toggle('mob-open', !isOpen);
  if (overlay) overlay.style.display = isOpen ? 'none' : 'block';
}

function closeMobileSidebar() {
  const aside   = document.getElementById('sidebar-aside');
  const overlay = document.getElementById('mob-overlay');
  if (aside) aside.classList.remove('mob-open');
  if (overlay) overlay.style.display = 'none';
}

function showPage(page) {
  // GUARD: bloqueia navegação sem sessão (impede bypass via console)
  if (!currentUser || !currentRole) {
    document.getElementById('login-page').style.display = 'flex';
    return;
  }
  // Bloqueia acesso financeiro pra quem não é o médico DONO (secretária,
  // profissional e médico membro de outra clínica — ver _podeVerFinanceiro)
  if (!_podeVerFinanceiro() && _PAGES_FINANCEIRO.includes(page)) return;
  // Bloqueia páginas operacionais no modo "Apenas Financeiro"
  if (getAppMode() === 'financeiro' && _PAGES_OPERACIONAL.includes(page)) { page = 'dashboard'; }

  // Close sidebar on mobile when navigating
  closeMobileSidebar();

  // Reset scroll position on every page change
  const _mc = document.getElementById('main-content');
  if (_mc) _mc.scrollTop = 0;
  window.scrollTo(0, 0);

  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('page-' + page).classList.add('active');
  document.getElementById('nav-' + page).classList.add('active');

  // Sync mobile UI
  _mobSync(page);

  if (page === 'dashboard') renderDashboard();
  if (page === 'crm') renderCrm();
  if (page === 'pacientes') renderPacientes();
  if (page === 'followup') renderFollowup();
  if (page === 'agenda') {
    setAgendaView(agView);
    // Agendamentos criados pela IA (server-side) só existiam localmente após
    // relogar. Ao abrir a Agenda, puxa a coleção em background e re-renderiza.
    if (_supa && currentUser && typeof _pullBlindada === 'function') {
      _pullBlindada('agendamentos', _BLINDADAS.agendamentos)
        .then(() => { if (document.getElementById('page-agenda')?.classList.contains('active')) renderAgenda(); })
        .catch(() => {});
    }
  }
  if (page === 'receita') renderReceita();
  if (page === 'despesas') renderDespesas();
  if (page === 'precos') renderPrecos();
  if (page === 'relatorio') renderRelatorio(_ymd(new Date()).substring(0, 7));
  if (page === 'metas') { renderMetas(); renderMetasProc(); }
  if (page === 'backup') renderBackup();
  if (page === 'configuracoes') renderConfiguracoes();
  if (page === 'programas') renderProgramas();
}

// ====================== MODAIS ======================
function openModal(id) {
  document.getElementById(id).style.display = 'flex';
  if (id === 'modal-metas') {
    const metas  = DB.getObj('metas', { fat: 0, pac: 0, desp: 0 });
    const mp     = DB.getObj('metas_proc', {});
    const mpVal  = DB.getObj('metas_proc_valor', {});
    const procs  = getProcedimentos();
    const chaves = ['1ª vez','Consulta','Retorno','Domiciliar','Hospitalar','Telemedicina','Programa'];
    const ids    = ['1vez','consulta','retorno','domiciliar','hospitalar','telemedicina','programa'];

    chaves.forEach((tipo, i) => {
      const qtdEl = document.getElementById(`mm-${ids[i]}-qtd`);
      const valEl = document.getElementById(`mm-${ids[i]}-val`);
      if (qtdEl) qtdEl.value = mp[tipo] || '';
      if (valEl) {
        const valorSalvo = mpVal[tipo];
        if (tipo === 'Programa') {
          // Sugere ticket médio mensal (MRR) dos programas Assinatura ativos
          const progs = getProgramas().filter(p => p.ativo !== false && p.tipo === 'Assinatura');
          let mrrMed = 0;
          if (progs.length) {
            const mrrs = progs.map(p => (p.precoAVista || 0) / _vigenciaDias(p.vigencia) * 30);
            mrrMed = Math.round(mrrs.reduce((a,b)=>a+b,0) / mrrs.length);
          }
          valEl.value = valorSalvo || mrrMed || '';
        } else {
          const proc = procs.find(p => p.nome === tipo) || procs.find(p => _metaCategoria(p.nome) === tipo);
          valEl.value = valorSalvo || (proc ? proc.valorPix : '') || '';
        }
      }
    });
    document.getElementById('input-meta-desp').value = metas.desp || '';
    atualizarPreviewMetas();
  }
  if (id === 'modal-paciente') {
    popularProcedimentoSelect();
    _popularProfissionalSelect(currentProfissionalId || _agFiltroProf || null, 'pac-profissional');
    // Reseta valor e atualiza hint
    const vEl = document.getElementById('pac-valor');
    if (vEl && !editState.idx && editState.crmIdx === null) vEl.value = '';
    atualizarValorSugerido();
  }
  if (id === 'modal-crm' && !editState.col) {
    _popularProfissionalSelect(null, 'crm-profissional', true);
    // Auto-preenche data e hora com o momento atual para novos contatos
    const now  = new Date();
    const form = document.querySelector('#modal-crm form');
    if (form) {
      const dateEl = form.querySelector('[name="data"]');
      const timeEl = form.querySelector('[name="hora"]');
      if (dateEl) {
        const yyyy = now.getFullYear();
        const mm   = String(now.getMonth() + 1).padStart(2, '0');
        const dd   = String(now.getDate()).padStart(2, '0');
        dateEl.value = `${yyyy}-${mm}-${dd}`;
      }
      if (timeEl) {
        const hh  = String(now.getHours()).padStart(2, '0');
        const min = String(now.getMinutes()).padStart(2, '0');
        timeEl.value = `${hh}:${min}`;
      }
    }
  }
  if (id === 'modal-config-horarios') openModalConfigHorarios();
  if (id === 'modal-bloqueio')        openModalBloqueio();
  if (id === 'modal-metas-proc' && window._openMetasProc) window._openMetasProc();
}
function closeModal(id) {
  document.getElementById(id).style.display = 'none';
  const form = document.querySelector(`#${id} form`);
  if (form) form.reset();
  editState = { col: null, idx: null, crmIdx: null, pacIdx: null };
  const titles = {
    'modal-crm': 'Novo Contato',
    'modal-paciente': 'Nova Consulta',
    'modal-followup': 'Novo Follow-Up',
    'modal-agenda': 'Registrar Dia de Agenda',
    'modal-despesa': 'Nova Despesa'
  };
  if (titles[id]) {
    const titleEl = document.querySelector(`#${id} .modal-title`);
    if (titleEl) titleEl.textContent = titles[id];
  }
}

// ====================== TABELA DE PREÇOS ======================
function getProcedimentos() {
  let arr = DB.get('procedimentos');
  // Seed inicial na primeira execução
  if (!arr.length && !localStorage.getItem('consult_proc_seeded')) {
    arr = [
      { nome: 'Primeira consulta',        valorPix: 1000, valorCartao: 1050, obs: 'Paciente novo (1ª vez)' },
      { nome: 'Consulta no consultório', valorPix: 1000, valorCartao: 1050, obs: '' },
      { nome: 'Retorno',                  valorPix: 0,    valorCartao: 0,    obs: 'Defina o valor' },
      { nome: 'Visita domiciliar',        valorPix: 800,  valorCartao: 800,  obs: '' },
      { nome: 'Visita domiciliar (paciente antigo)', valorPix: 1300, valorCartao: 1500, obs: '' },
      { nome: 'Hospitalar',               valorPix: 0,    valorCartao: 0,    obs: 'Defina o valor' },
      { nome: 'Telemedicina',             valorPix: 0,    valorCartao: 0,    obs: 'Defina o valor' },
    ];
    DB.set('procedimentos', arr);
    localStorage.setItem('consult_proc_seeded', '1');
    localStorage.setItem('consult_proc_1vez', '1');
  }
  // Migração (uma vez): adiciona "Primeira consulta" pra quem já tinha a lista antiga.
  // É o procedimento que alimenta a meta de "1ª vez".
  if (arr.length && !localStorage.getItem('consult_proc_1vez') &&
      !arr.some(p => /1[aª°]?\s*vez|primeira/i.test(p.nome || ''))) {
    const base = arr.find(p => /consulta/i.test(p.nome || '')) || { valorPix: 0, valorCartao: 0 };
    arr.unshift({ nome: 'Primeira consulta', valorPix: base.valorPix || 0, valorCartao: base.valorCartao || 0, obs: 'Paciente novo (1ª vez)' });
    DB.set('procedimentos', arr);
    localStorage.setItem('consult_proc_1vez', '1');
  }
  return arr;
}

// Mapeia o nome de um procedimento para a CATEGORIA usada nas metas
// (ex.: "Consulta no consultório" → 'Consulta', "Primeira consulta" → '1ª vez').
// Antes a meta comparava o nome exato e só batia em alguns casos.
function _metaCategoria(tipo) {
  const s = (tipo || '').toLowerCase();
  if (/1[aª°]?\s*vez|primeira|primeiro/.test(s)) return '1ª vez';
  if (/retorno|reavalia/.test(s))                return 'Retorno';
  if (/domicil/.test(s))                         return 'Domiciliar';
  if (/hospital/.test(s))                        return 'Hospitalar';
  if (/telemed|online|remot|v[ií]deo/.test(s))   return 'Telemedicina';
  if (/programa|assinatura/.test(s))             return 'Programa';
  return 'Consulta';
}

// ====================== PROFISSIONAIS (CLÍNICA) ======================
// Modelo: consult_profissionais: [{ id, nome, tipo, especialidade, cor, ativo }]
// Base do "Plano Clínica": cada agendamento/receita é etiquetado por profissional.
const _PROF_CORES = ['#10b981','#3b82f6','#8b5cf6','#f59e0b','#ec4899','#14b8a6','#ef4444','#0ea5e9','#65a30d','#d946ef'];

function getProfissionais() {
  let arr = DB.get('profissionais');
  if (!arr.length && !localStorage.getItem('consult_prof_seeded')) {
    arr = [{ id: 'prof_titular', nome: 'Titular', tipo: 'Médico', especialidade: '', cor: _PROF_CORES[0], ativo: true }];
    DB.set('profissionais', arr);
    localStorage.setItem('consult_prof_seeded', '1');
  }
  return arr;
}
function getProfissionaisAtivos() { return getProfissionais().filter(p => p.ativo !== false); }
function getProfissional(id) { return getProfissionais().find(p => p.id === id) || null; }
function _corProfissional(id) { const p = getProfissional(id); return p ? p.cor : '#94a3b8'; }
function _profId() { return 'prof_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5); }

function renderProfissionais() {
  const el = document.getElementById('config-profissionais-lista');
  if (!el) return;
  const profs = getProfissionais();
  if (!profs.length) {
    el.innerHTML = '<div style="color:#94a3b8;font-size:13px;padding:10px 0;">Nenhum profissional. Clique em “+ Profissional”.</div>';
    return;
  }
  el.innerHTML = profs.map(p => `
    <div style="display:flex;align-items:center;gap:11px;padding:10px 0;border-bottom:1px solid #f1f5f9;">
      <span style="width:14px;height:14px;border-radius:4px;background:${p.cor};flex-shrink:0;"></span>
      <div style="flex:1;min-width:0;">
        <div style="font-weight:600;color:#0f172a;font-size:13.5px;">${_esc(p.nome)}${p.ativo===false?' <span style="color:#94a3b8;font-weight:400;font-size:11px;">(inativo)</span>':''}</div>
        <div style="font-size:11.5px;color:#64748b;">${_esc(p.tipo||'—')}${p.especialidade?' · '+_esc(p.especialidade):''} · 💰 ${_repasseLabel(p)}</div>
      </div>
      <button onclick="editarProfissional('${p.id}')" title="Editar" style="background:none;border:none;color:#3b82f6;cursor:pointer;font-size:13px;">✏️</button>
      <button onclick="excluirProfissional('${p.id}')" title="Remover" style="background:none;border:none;color:#ef4444;cursor:pointer;font-size:13px;">🗑️</button>
    </div>`).join('');
}

// Rótulo curto do repasse (lista de profissionais)
function _repasseLabel(prof) {
  const r = (prof && prof.repasse) || { tipo: 'percentual', valor: 100 };
  if (r.tipo === 'fixo')    return `${BRL(r.valor || 0)}/atend.`;
  if (r.tipo === 'aluguel') return `aluguel ${BRL(r.valor || 0)}/mês`;
  return `${r.valor || 0}% pra ele`;
}

// Calcula a divisão da receita de um profissional num período
function _calcRepasse(prof, receita, qtd) {
  if (!prof) return { profGanho: 0, clinicaGanho: receita, label: '—' };
  const r = prof.repasse || { tipo: 'percentual', valor: 100 };
  if (r.tipo === 'fixo')    { const g = (r.valor || 0) * qtd; return { profGanho: g, clinicaGanho: receita - g, label: `${BRL(r.valor || 0)}/atend.` }; }
  if (r.tipo === 'aluguel') { const c = (r.valor || 0);       return { profGanho: receita - c, clinicaGanho: c, label: `aluguel ${BRL(r.valor || 0)}` }; }
  const g = receita * ((r.valor || 0) / 100); return { profGanho: g, clinicaGanho: receita - g, label: `${r.valor || 0}%` };
}

function novoProfissional()     { _abrirModalProfissional(null); }
function editarProfissional(id) { _abrirModalProfissional(id); }

function _abrirModalProfissional(id) {
  const p = id ? getProfissional(id) : null;
  const form = document.querySelector('#modal-profissional form');
  if (!form) return;
  form.reset();
  form.id.value = id || '';
  form.nome.value = p ? p.nome : '';
  form.tipo.value = p ? (p.tipo || 'Médico') : 'Médico';
  form.especialidade.value = p ? (p.especialidade || '') : '';
  form.ativo.checked = p ? p.ativo !== false : true;
  const cor = p ? p.cor : _PROF_CORES[getProfissionais().length % _PROF_CORES.length];
  document.getElementById('prof-cor-input').value = cor;
  document.getElementById('prof-cor-swatches').innerHTML = _PROF_CORES.map(c =>
    `<button type="button" data-cor="${c}" onclick="_selecionarCor('${c}')" class="prof-cor-sw" style="width:28px;height:28px;border-radius:8px;background:${c};border:3px solid ${c === cor ? '#0f172a' : 'transparent'};cursor:pointer;padding:0;"></button>`
  ).join('');
  const rep = (p && p.repasse) || { tipo: 'percentual', valor: 100 };
  form.repasseTipo.value = rep.tipo || 'percentual';
  form.repasseValor.value = (rep.valor != null ? rep.valor : '');
  _repasseLabelUpdate();
  document.querySelector('#modal-profissional .modal-title').textContent = id ? 'Editar profissional' : 'Novo profissional';
  document.getElementById('modal-profissional').style.display = 'flex';
}

function _selecionarCor(c) {
  const inp = document.getElementById('prof-cor-input');
  if (inp) inp.value = c;
  document.querySelectorAll('#prof-cor-swatches .prof-cor-sw').forEach(b => {
    b.style.borderColor = b.dataset.cor === c ? '#0f172a' : 'transparent';
  });
}

function _repasseLabelUpdate() {
  const tipo = document.getElementById('prof-repasse-tipo')?.value;
  const hint = document.getElementById('prof-repasse-hint');
  const inp  = document.getElementById('prof-repasse-valor');
  if (!hint) return;
  if (tipo === 'percentual')   { hint.innerHTML = 'Ex.: <b>70</b> → o profissional fica com <b>70%</b> e a clínica com 30% da receita dele.'; if (inp) inp.placeholder = '70'; }
  else if (tipo === 'fixo')    { hint.innerHTML = 'Ex.: <b>150</b> → o profissional recebe <b>R$ 150 por atendimento</b>; a clínica fica com o resto.'; if (inp) inp.placeholder = '150'; }
  else                         { hint.innerHTML = 'Ex.: <b>2000</b> → a clínica recebe <b>R$ 2.000/mês</b> de aluguel e o profissional fica com o resto.'; if (inp) inp.placeholder = '2000'; }
}

function salvarProfissional(e) {
  e.preventDefault();
  const form = e.target;
  const nome = (form.nome.value || '').trim();
  if (!nome) { alert('Informe o nome.'); return; }
  const id  = form.id.value || _profId();
  const obj = {
    id, nome,
    tipo: form.tipo.value || '',
    especialidade: (form.especialidade.value || '').trim(),
    cor: document.getElementById('prof-cor-input').value || _PROF_CORES[0],
    ativo: form.ativo.checked,
    repasse: { tipo: form.repasseTipo.value || 'percentual', valor: parseFloat(form.repasseValor.value) || 0 },
  };
  const profs = getProfissionais();
  const idx = profs.findIndex(p => p.id === id);
  if (idx >= 0) profs[idx] = { ...profs[idx], ...obj }; else profs.push(obj);
  DB.set('profissionais', profs);
  closeModal('modal-profissional');
  renderProfissionais();
  if (typeof toast === 'function') toast('✅ Profissional salvo.');
}

function excluirProfissional(id) {
  const p = getProfissional(id);
  if (!p) return;
  if (!confirm(`Remover "${p.nome}"?\n\nOs agendamentos dele não são apagados — apenas ficam sem profissional.`)) return;
  DB.set('profissionais', getProfissionais().filter(x => x.id !== id));
  renderProfissionais();
}

// ====================== ONBOARDING DA CLÍNICA (Tijolo 5) ======================
// Checklist guiado pra uma clínica nova começar sem se perder.
function _irParaConfig(elId) {
  const el = document.getElementById(elId);
  if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); try { el.focus(); } catch(e) {} }
}
function _dismissOnboarding() {
  localStorage.setItem('consult_onboard_dismiss', '1');
  renderOnboardingClinica();
}
function _onboardingPassos() {
  const clinica = getClinicaConfig();
  const profs   = getProfissionaisAtivos();
  return [
    { ok: !!((clinica.nomeClinica || '').trim() || (clinica.nome || '').trim()),
      label: 'Dê um nome à clínica', dica: 'Aparece nos relatórios e no topo.',
      acao: "_irParaConfig('clinica-nome-clinica')", btn: 'Configurar' },
    { ok: profs.length >= 2,
      label: 'Cadastre seus profissionais', dica: `${profs.length} cadastrado(s) — clínica precisa de 2+.`,
      acao: 'novoProfissional()', btn: '+ Profissional' },
    { ok: profs.length > 0 && profs.every(p => p.repasse && p.repasse.valor != null),
      label: 'Defina o repasse de cada profissional', dica: 'Quanto cada um leva / a clínica fica.',
      acao: "_irParaConfig('config-profissionais-lista')", btn: 'Revisar' },
    { ok: localStorage.getItem('consult_onboard_convidou') === '1',
      label: 'Convide sua equipe', dica: 'Secretária e profissionais com login próprio.',
      acao: 'openModalConvite()', btn: 'Convidar' },
    { ok: _waConnected(), opcional: true,
      label: 'Conecte o WhatsApp', dica: 'Opcional — contatos caem sozinhos no CRM.',
      acao: "_irParaConfig('zapi-enabled-toggle')", btn: 'Conectar' },
  ];
}
function renderOnboardingClinica() {
  const el = document.getElementById('onboarding-clinica');
  if (!el) return;
  if (localStorage.getItem('consult_onboard_dismiss') === '1') { el.innerHTML = ''; return; }
  const passos = _onboardingPassos();
  const obrig  = passos.filter(p => !p.opcional);
  const feitos = obrig.filter(p => p.ok).length;
  if (feitos === obrig.length) { el.innerHTML = ''; return; } // tudo pronto → some
  const pct = Math.round((feitos / obrig.length) * 100);
  el.innerHTML = `
  <div class="chart-card" style="margin-bottom:20px;border:1px solid #bfdbfe;background:linear-gradient(180deg,#f0f7ff,#ffffff);">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px;">
      <div style="font-size:15px;font-weight:700;color:#0f172a;">🚀 Primeiros passos da clínica</div>
      <button onclick="_dismissOnboarding()" style="background:none;border:none;color:#94a3b8;font-size:11.5px;cursor:pointer;">dispensar</button>
    </div>
    <div style="font-size:12.5px;color:#64748b;margin-bottom:8px;">${feitos} de ${obrig.length} concluídos</div>
    <div style="height:6px;background:#e2e8f0;border-radius:999px;overflow:hidden;margin-bottom:14px;"><div style="height:100%;width:${pct}%;background:#3b82f6;transition:width .3s;"></div></div>
    ${passos.map(p => `
      <div style="display:flex;align-items:center;gap:11px;padding:8px 0;border-bottom:1px solid #eef2f7;">
        <span style="font-size:16px;flex-shrink:0;">${p.ok ? '✅' : '⬜'}</span>
        <div style="flex:1;min-width:0;">
          <div style="font-size:13px;font-weight:600;color:${p.ok ? '#94a3b8' : '#0f172a'};${p.ok ? 'text-decoration:line-through;' : ''}">${p.label}${p.opcional ? ' <span style="font-weight:400;color:#94a3b8;">(opcional)</span>' : ''}</div>
          <div style="font-size:11px;color:#94a3b8;">${_esc(p.dica)}</div>
        </div>
        ${p.ok ? '' : `<button onclick="${p.acao}" class="btn-ghost" style="font-size:11.5px;padding:5px 11px;white-space:nowrap;">${p.btn}</button>`}
      </div>`).join('')}
  </div>`;
}

// ====================== PROGRAMAS DE ACOMPANHAMENTO ======================
//
// Modelo:
//   consult_programas: [{ id, nome, tipo:'Fixo'|'Contínuo', descricao,
//                         marcos: [{ dias, descricao, tipoAtividade, duracao }],
//                         intervaloDias, camposClinicos: [{ nome, unidade }], ativo }]
//   consult_inscricoes: [{ id, programaId, pacienteNome, pacienteWhatsapp, pacIdx,
//                          dataInicio, status:'Ativo'|'Pausado'|'Concluído',
//                          registros: [{ marcoIdx, dataPrevista, dataReal, agendamentoId,
//                                        followupIdx, valoresClinicos, obs }],
//                          obs }]
// Helper: converte vigência de Assinatura em dias
function _vigenciaDias(vigencia) {
  if (vigencia === 'Mensal')     return 30;
  if (vigencia === 'Trimestral') return 90;
  if (vigencia === 'Semestral')  return 180;
  if (vigencia === 'Anual')      return 365;
  return 365;
}

function getProgramas() {
  let arr = DB.get('programas');
  // Recompõe seeds se: (a) flag v2 não existe OU (b) array está vazio
  // (a 2ª condição cobre o caso de backup antigo sem programas)
  if (!arr.length || !localStorage.getItem('consult_progs_seeded_v2')) {
    arr = [
      {
        id: 'pg_compagni',
        nome: 'Programa Compagni',
        tipo: 'Assinatura',
        descricao: 'Concierge medicine anual — cuidado longitudinal com consultas ilimitadas e prioridade total',
        vigencia: 'Anual',
        beneficios: [
          'Consultas presenciais ilimitadas',
          'Telemedicina ilimitada',
          'Prioridade na agenda (acesso em até 24h)',
          'Emissão de receitas, laudos e pedidos de exames',
          'Renovação e revisão de prescrições crônicas',
          'Pequenos procedimentos inclusos',
          'Encaminhamentos e segunda opinião',
        ],
        precoAVista: 6480,
        descontoAVista: 0,
        parcelas: [{ n: 6, valor: 1200 }],
        consultaAvulsa: 1500,
        politicas: 'Cancelamento com mínimo 24h de antecedência. Após 5 atendimentos realizados, não há devolução do valor. O plano não pode ser pausado.',
        ativo: true,
      },
      {
        id: 'pg_attento_semestral',
        nome: 'Programa Attento Semestral',
        tipo: 'Assinatura',
        descricao: 'Cuidado domiciliar para pacientes frágeis — 6 meses com visitas + telemedicina ilimitada',
        vigencia: 'Semestral',
        beneficios: [
          'Monitoramento online multiprofissional',
          'Telemedicina ilimitada',
          '2 visitas domiciliares inclusas',
          'Emissão de receitas, laudos e pedidos de exames',
          'Consultas e visitas extras com 50% de desconto',
          'Suporte e orientação a cuidadores',
        ],
        precoAVista: 5292,
        descontoAVista: 0,
        parcelas: [{ n: 6, valor: 980 }],
        consultaAvulsa: 750,
        politicas: 'Consulta extra domiciliar: R$1.500 / consultório: R$750. Cancelamento com aviso prévio por escrito.',
        ativo: true,
      },
      {
        id: 'pg_attento_anual',
        nome: 'Programa Attento Anual',
        tipo: 'Assinatura',
        descricao: 'Cuidado domiciliar para pacientes frágeis — 12 meses com visitas + telemedicina ilimitada',
        vigencia: 'Anual',
        beneficios: [
          'Monitoramento online multiprofissional',
          'Telemedicina ilimitada',
          '4 visitas domiciliares inclusas',
          'Emissão de receitas, laudos e pedidos de exames',
          'Consultas e visitas extras com 50% de desconto',
          'Suporte e orientação a cuidadores',
        ],
        precoAVista: 8820,
        descontoAVista: 0,
        parcelas: [{ n: 10, valor: 980 }],
        consultaAvulsa: 750,
        politicas: 'Consulta extra domiciliar: R$1.500 / consultório: R$750. Cancelamento com aviso prévio por escrito.',
        ativo: true,
      },
      {
        id: 'pg_confidenza',
        nome: 'Programa Confidenza Semestral',
        tipo: 'Assinatura',
        descricao: 'Acompanhamento semestral híbrido com consultas presenciais e online',
        vigencia: 'Semestral',
        beneficios: [
          '2 consultas online inclusas',
          '2 consultas presenciais inclusas',
          'Monitoramento via WhatsApp entre consultas',
          'Plano de cuidados individualizado',
          'Encaminhamentos inclusos',
        ],
        precoAVista: 2600,
        descontoAVista: 0,
        parcelas: [{ n: 6, valor: 477.18 }],
        consultaAvulsa: 1000,
        politicas: 'Cancelamento com 24h de antecedência. As consultas devem ser utilizadas em até 1 ano após a contratação. Consultas adicionais: R$1.000.',
        ativo: true,
      },
      {
        id: 'pg_confidenza_mensal',
        nome: 'Programa Confidenza Mensal',
        tipo: 'Assinatura',
        descricao: 'Assinatura mensal com acesso direto ao médico e consultas online ilimitadas',
        vigencia: 'Mensal',
        beneficios: [
          'Contato direto com o médico (sem intermediários)',
          'Consultas online ilimitadas',
          'Consultas presenciais e domiciliares com 50% de desconto',
          'Prioridade no agendamento',
          'Acompanhamento contínuo personalizado',
        ],
        precoAVista: 600,
        descontoAVista: 0,
        parcelas: [],
        consultaAvulsa: null,
        politicas: 'Renovação automática. Para cancelamento, solicitar com até 1 dia útil de antecedência ao término da vigência.',
        ativo: true,
      },
      {
        id: 'pg_mentore',
        nome: 'Programa Mentore',
        tipo: 'Assinatura',
        descricao: 'Programa intensivo trimestral de 12 semanas com avaliação clínica completa e acompanhamento semanal',
        vigencia: 'Trimestral',
        beneficios: [
          '12 semanas de acompanhamento intensivo',
          '7 consultas presenciais ou online',
          'Dossiê de saúde personalizado',
          'Monitoramento semanal via WhatsApp',
          'Suporte pelo número particular do médico',
          'Avaliação clínica completa (estilo de vida, neuropsicológica, laboratorial e medicamentosa)',
          'Plano de cuidados detalhado',
        ],
        precoAVista: 6480,
        descontoAVista: 0,
        parcelas: [{ n: 6, valor: 1200 }],
        consultaAvulsa: 1500,
        politicas: 'Após 5 semanas de programa, não há devolução do valor. Cancelamento por escrito. Possibilidade de pausar por até 3 meses (por motivo de saúde ou viagem).',
        ativo: true,
      },
      {
        id: 'pg_posop',
        nome: 'Pós-operatório 6 meses',
        tipo: 'Fixo',
        descricao: 'Acompanhamento padrão após cirurgia eletiva',
        marcos: [
          { dias: 7,   descricao: 'Retorno 7 dias',   tipoAtividade: 'Consultório', duracao: 30 },
          { dias: 30,  descricao: 'Retorno 30 dias',  tipoAtividade: 'Consultório', duracao: 50 },
          { dias: 90,  descricao: 'Retorno 90 dias',  tipoAtividade: 'Consultório', duracao: 50 },
          { dias: 180, descricao: 'Alta',             tipoAtividade: 'Consultório', duracao: 30 },
        ],
        intervaloDias: null,
        camposClinicos: [
          { nome: 'PA', unidade: 'mmHg' },
          { nome: 'Peso', unidade: 'kg' },
        ],
        ativo: true,
      },
      {
        id: 'pg_hipertensao',
        nome: 'Acompanhamento Hipertensão',
        tipo: 'Contínuo',
        descricao: 'Controle pressórico periódico',
        marcos: [],
        intervaloDias: 90,
        camposClinicos: [
          { nome: 'PA', unidade: 'mmHg' },
          { nome: 'Peso', unidade: 'kg' },
          { nome: 'Frequência cardíaca', unidade: 'bpm' },
        ],
        ativo: true,
      },
      {
        id: 'pg_diabetes',
        nome: 'Acompanhamento Diabetes',
        tipo: 'Contínuo',
        descricao: 'Controle glicêmico periódico',
        marcos: [],
        intervaloDias: 90,
        camposClinicos: [
          { nome: 'Glicemia jejum', unidade: 'mg/dL' },
          { nome: 'HbA1c', unidade: '%' },
          { nome: 'Peso', unidade: 'kg' },
        ],
        ativo: true,
      },
      {
        id: 'pg_avc',
        nome: 'Pós-AVC',
        tipo: 'Fixo',
        descricao: 'Reavaliação após acidente vascular',
        marcos: [
          { dias: 15,  descricao: 'Reavaliação 15d', tipoAtividade: 'Consultório', duracao: 50 },
          { dias: 45,  descricao: 'Reavaliação 45d', tipoAtividade: 'Consultório', duracao: 50 },
          { dias: 90,  descricao: 'Reavaliação 90d', tipoAtividade: 'Consultório', duracao: 50 },
          { dias: 180, descricao: 'Reavaliação 6m',  tipoAtividade: 'Consultório', duracao: 50 },
          { dias: 365, descricao: 'Reavaliação 12m', tipoAtividade: 'Consultório', duracao: 50 },
        ],
        intervaloDias: null,
        camposClinicos: [
          { nome: 'PA', unidade: 'mmHg' },
          { nome: 'Escala NIHSS', unidade: 'pts' },
        ],
        ativo: true,
      },
    ];
    DB.set('programas', arr);
    localStorage.setItem('consult_progs_seeded_v2', '1');
  }
  return arr;
}
function getInscricoes() { return DB.get('inscricoes'); }

// Helper de data
function _addDaysIso(isoDate, dias) {
  const d = new Date(isoDate + 'T12:00:00');
  d.setDate(d.getDate() + dias);
  return _ymd(d);
}

// Cria inscrição + agendamentos + follow-ups automaticamente
// Gera o cronograma completo de follow-ups para uma inscrição em programa de Assinatura.
// Estratégia varia por vigência — pacientes de assinaturas longas (Anual/Semestral) recebem
// check-ins regulares; mensais recebem só boas-vindas + renovação.
function _gerarCronogramaFollowups(ins, prog, dataInicio, dataFim) {
  if (!prog || prog.tipo !== 'Assinatura') return [];
  const nome = ins.pacienteNome;
  const tipoBase = { nome, tipoContato: 'WhatsApp', feito: false,
                     dataReav: dataFim, programaInscricaoId: ins.id,
                     profissionalId: ins.profissionalId || null };
  const fus = [];
  const vigDias = _vigenciaDias(prog.vigencia);

  function addFu(dias, etiqueta, ultConsultaOverride) {
    const dataContato = _addDaysIso(dataInicio, dias);
    // Só agenda se a data ainda está dentro da vigência (ou no máximo no dia do venc)
    if (dataContato > dataFim) return;
    fus.push({
      id: _novoId('fu'),
      ...tipoBase,
      ultConsulta: ultConsultaOverride || dataInicio,
      dataContato,
      obs: etiqueta,
    });
  }

  if (prog.vigencia === 'Mensal') {
    // 7 dias: boas-vindas | 25 dias: renovação (5 dias antes do fim)
    addFu(7,  `Check-in inicial · ${prog.nome}`);
    addFu(Math.max(vigDias - 5, 15), `Renovar ${prog.nome}`);
  } else if (prog.vigencia === 'Trimestral') {
    // 7d boas-vindas · 45d meio · 80d renovação (10d antes)
    addFu(7,  `Boas-vindas · ${prog.nome}`);
    addFu(45, `Check-in intermediário · ${prog.nome}`);
    addFu(vigDias - 10, `Renovar ${prog.nome}`);
  } else if (prog.vigencia === 'Semestral') {
    // 7d, 60d, 120d, renovação 30d antes do fim
    addFu(7,   `Boas-vindas · ${prog.nome}`);
    addFu(60,  `Check-in 2 meses · ${prog.nome}`);
    addFu(120, `Check-in 4 meses · ${prog.nome}`);
    addFu(vigDias - 30, `Renovar ${prog.nome}`);
  } else {
    // Anual (365d): 7d, 90d, 180d (meio), 270d, renovação 30d antes
    addFu(7,   `Boas-vindas · ${prog.nome}`);
    addFu(90,  `Check-in trimestral · ${prog.nome}`);
    addFu(180, `Check-in semestral · ${prog.nome}`);
    addFu(270, `Check-in 9 meses · ${prog.nome}`);
    addFu(vigDias - 30, `Renovar ${prog.nome}`);
  }
  return fus;
}

function inscreverEmPrograma(programaId, pacienteRef, dataInicio, horaPadrao = '08:00', pagamentoOpts = {}) {
  const prog = getProgramas().find(p => p.id === programaId);
  if (!prog) { alert('Programa não encontrado.'); return null; }
  // pacienteRef pode ser { nome, whatsapp, pacIdx }
  const nome     = pacienteRef.nome;
  const whatsapp = pacienteRef.whatsapp || '';
  const pacIdx   = (pacienteRef.pacIdx != null) ? pacienteRef.pacIdx : null;
  const profId   = _profDoPaciente(nome); // dono do programa (blindagem)

  const inscricao = {
    id: 'ins_' + Date.now() + '_' + Math.floor(Math.random()*1000),
    programaId, pacienteNome: nome, pacienteWhatsapp: whatsapp, pacIdx,
    profissionalId: profId,
    dataInicio, status: 'Ativo',
    registros: [], obs: ''
  };

  // ── Programa tipo Assinatura ──
  if (prog.tipo === 'Assinatura') {
    const formaPagamento = pagamentoOpts.formaPagamento || 'À vista';
    const nParcelas      = pagamentoOpts.nParcelas || null;
    let valorTotal;
    if (formaPagamento === 'À vista') {
      valorTotal = prog.precoAVista || 0;
    } else {
      const opt = (prog.parcelas || []).find(p => p.n === nParcelas);
      valorTotal = opt ? opt.n * opt.valor : (prog.precoAVista || 0);
    }
    const dataFim = _addDaysIso(dataInicio, _vigenciaDias(prog.vigencia));
    inscricao.dataFim        = dataFim;
    inscricao.formaPagamento = formaPagamento;
    inscricao.nParcelas      = nParcelas;
    inscricao.valorTotal     = valorTotal;

    // Lançamento financeiro
    const pacs = DB.get('pacientes');
    pacs.push({
      id: _novoId('pac'), profissionalId: profId,
      nome, whatsapp, data: dataInicio,
      procedimento: prog.nome,
      tipoAtividade: 'Consultório',
      valor: valorTotal,
      statusPgto: formaPagamento === 'À vista' ? 'Pago' : 'Parcial',
      obs: '[Programa Assinatura]',
      pacIdx,
    });
    DB.set('pacientes', pacs);

    // Cronograma completo de follow-ups durante a vigência da assinatura
    const fus = DB.get('followup');
    const cronograma = _gerarCronogramaFollowups(
      { ...inscricao, pacienteNome: nome, pacienteWhatsapp: whatsapp },
      prog, dataInicio, dataFim
    );
    DB.set('followup', [...fus, ...cronograma]);

    const inscricoes = DB.get('inscricoes');
    inscricoes.push(inscricao);
    DB.set('inscricoes', inscricoes);
    return inscricao;
  }

  // ── Programas Fixo / Contínuo ──
  // Para Fixo: usa os marcos do template. Para Contínuo: cria 1 marco inicial.
  const marcos = prog.tipo === 'Fixo' && prog.marcos.length
    ? prog.marcos
    : [{ dias: prog.intervaloDias || 90, descricao: prog.nome, tipoAtividade: 'Consultório', duracao: 50 }];

  const ags = DB.get('agendamentos');
  const fus = DB.get('followup');

  marcos.forEach((m, idx) => {
    const dataPrev = _addDaysIso(dataInicio, m.dias);
    const agId = (typeof _agId === 'function') ? _agId() : ('ag_' + Date.now() + '_' + idx);
    const ag = {
      id: agId, data: dataPrev, hora: horaPadrao, duracao: m.duracao || 50,
      pacienteNome: nome, whatsapp, profissionalId: profId,
      procedimento: m.descricao, status: 'Confirmado',
      tipoAtividade: m.tipoAtividade || 'Consultório',
      obs: `[Programa: ${prog.nome}] marco ${idx+1}${prog.tipo==='Fixo'?'/'+marcos.length:''}`,
      programaInscricaoId: inscricao.id, marcoIdx: idx,
      crmIdx: null, pacIdx,
    };
    ags.push(ag);

    const fuObj = {
      id: _novoId('fu'), profissionalId: profId,
      nome, ultConsulta: dataInicio,
      dataContato: _addDaysIso(dataPrev, -2),
      tipoContato: 'WhatsApp', feito: false,
      dataReav: dataPrev,
      obs: `Confirmar ${m.descricao} — ${prog.nome}`,
      programaInscricaoId: inscricao.id, marcoIdx: idx,
    };
    fus.push(fuObj);

    inscricao.registros.push({
      marcoIdx: idx, dataPrevista: dataPrev, dataReal: null,
      agendamentoId: agId, followupIdx: fus.length - 1,
      valoresClinicos: {}, obs: ''
    });
  });

  DB.set('agendamentos', ags);
  DB.set('followup', fus);

  // Lançamento financeiro do pacote (se programa Fixo/Contínuo tem preço definido)
  if (prog.precoAVista && prog.precoAVista > 0) {
    const formaPagamento = pagamentoOpts.formaPagamento || 'À vista';
    const nParcelas      = pagamentoOpts.nParcelas || null;
    let valorTotal = prog.precoAVista;
    if (formaPagamento === 'Parcelado') {
      const opt = (prog.parcelas || []).find(p => p.n === nParcelas);
      if (opt) valorTotal = opt.n * opt.valor;
    }
    inscricao.formaPagamento = formaPagamento;
    inscricao.nParcelas      = nParcelas;
    inscricao.valorTotal     = valorTotal;
    const pacs = DB.get('pacientes');
    pacs.push({
      id: _novoId('pac'), profissionalId: profId,
      nome, whatsapp, data: dataInicio,
      procedimento: prog.nome,
      tipoAtividade: 'Consultório',
      valor: valorTotal,
      statusPgto: formaPagamento === 'À vista' ? 'Pago' : 'Parcial',
      obs: `[Programa ${prog.tipo}]`,
      pacIdx,
    });
    DB.set('pacientes', pacs);
  }

  const inscricoes = DB.get('inscricoes');
  inscricoes.push(inscricao);
  DB.set('inscricoes', inscricoes);
  setTimeout(() => checkAchievements(), 300);
  return inscricao;
}

// Renova uma inscrição de Assinatura
function renovarInscricao(id) {
  const ins = getInscricoes().find(i => i.id === id);
  if (!ins) return;
  const prog = getProgramas().find(p => p.id === ins.programaId);
  if (!prog || prog.tipo !== 'Assinatura') return;

  // Popula modal
  document.getElementById('renovar-id').value = id;
  const infoEl = document.getElementById('renovar-info');
  if (infoEl) {
    infoEl.innerHTML = `<strong>${_esc(ins.pacienteNome)}</strong> · ${_esc(prog.nome)}<br>
      Vencimento atual: <strong>${formatDate(ins.dataFim || '—')}</strong><br>
      Novo vencimento após renovação: <strong>${formatDate(_addDaysIso(ins.dataFim || ins.dataInicio, _vigenciaDias(prog.vigencia)))}</strong>`;
  }
  // Habilita/desabilita opção "Parcelado" conforme disponibilidade
  const formaSel = document.getElementById('renovar-forma');
  const optParcelado = formaSel?.querySelector('option[value="Parcelado"]');
  const temParcelas = Array.isArray(prog.parcelas) && prog.parcelas.length > 0;
  if (optParcelado) {
    optParcelado.disabled = !temParcelas;
    optParcelado.textContent = temParcelas ? 'Parcelado' : 'Parcelado (não disponível)';
  }
  // Se a opção atual é Parcelado mas não tem parcelas, força À vista
  if (formaSel && formaSel.value === 'Parcelado' && !temParcelas) {
    formaSel.value = 'À vista';
  }
  // Popula selects de parcelamento
  _atualizarRenovacao();
  openModal('modal-renovar');
}

function _atualizarRenovacao() {
  const id  = document.getElementById('renovar-id').value;
  const ins = getInscricoes().find(i => i.id === id);
  if (!ins) return;
  const prog = getProgramas().find(p => p.id === ins.programaId);
  if (!prog) return;
  const forma = document.getElementById('renovar-forma').value;
  const wrapParcelas = document.getElementById('renovar-parcelas-wrap');
  const selParcelas  = document.getElementById('renovar-parcelas-sel');
  const valEl        = document.getElementById('renovar-valor-total');

  const parcelasDisponiveis = Array.isArray(prog.parcelas) && prog.parcelas.length > 0;

  if (forma === 'Parcelado' && parcelasDisponiveis) {
    wrapParcelas.style.display = '';
    selParcelas.innerHTML = prog.parcelas.map(p =>
      `<option value="${p.n}">${p.n}x ${BRL(p.valor)} (total ${BRL(p.n * p.valor)})</option>`
    ).join('');
    const nSel = parseInt(selParcelas.value) || prog.parcelas[0].n;
    const opt  = prog.parcelas.find(p => p.n === nSel) || prog.parcelas[0];
    if (opt && valEl) valEl.textContent = `Valor total: ${BRL(opt.n * opt.valor)}`;
  } else {
    // À vista (ou Parcelado quando não há parcelas — fallback seguro)
    wrapParcelas.style.display = 'none';
    if (valEl) valEl.textContent = `Valor total: ${BRL(prog.precoAVista || 0)} (à vista)`;
    // Se o usuário tinha selecionado Parcelado sem opção, reseta pra À vista
    const formaSel = document.getElementById('renovar-forma');
    if (formaSel && formaSel.value === 'Parcelado' && !parcelasDisponiveis) {
      formaSel.value = 'À vista';
    }
  }
}

function saveRenovacao(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const id = fd.get('inscricaoId');
  const inscricoes = DB.get('inscricoes');
  const ins = inscricoes.find(i => i.id === id);
  if (!ins) return;
  const prog = getProgramas().find(p => p.id === ins.programaId);
  if (!prog) return;

  const formaPagamento = fd.get('formaPagamento');
  const nParcelas      = parseInt(fd.get('nParcelas')) || null;
  let valorTotal;
  if (formaPagamento === 'À vista') {
    valorTotal = prog.precoAVista || 0;
  } else {
    const opt = (prog.parcelas || []).find(p => p.n === nParcelas);
    valorTotal = opt ? opt.n * opt.valor : (prog.precoAVista || 0);
  }

  const novaDataFim = _addDaysIso(ins.dataFim || ins.dataInicio, _vigenciaDias(prog.vigencia));
  ins.dataFim        = novaDataFim;
  ins.status         = 'Ativo';
  ins.formaPagamento = formaPagamento;
  ins.nParcelas      = nParcelas;
  ins.valorTotal     = valorTotal;
  DB.set('inscricoes', inscricoes);

  // Atualiza/cria follow-ups do programa
  // — Estratégia: remove os pendentes/futuros desta inscrição e recria o cronograma
  //   completo a partir da nova data de início (data atual da renovação)
  const fusOriginal = DB.get('followup');
  const fusManter = fusOriginal.filter(f =>
    f.programaInscricaoId !== ins.id || f.feito
  );
  const hoje = _ymd(new Date());
  const novosFus = _gerarCronogramaFollowups(ins, prog, hoje, novaDataFim);
  DB.set('followup', [...fusManter, ...novosFus]);

  // Novo lançamento financeiro
  const pacs = DB.get('pacientes');
  pacs.push({
    id: _novoId('pac'), profissionalId: ins.profissionalId || null,
    nome: ins.pacienteNome, whatsapp: ins.pacienteWhatsapp || '',
    data: _ymd(new Date()),
    procedimento: prog.nome + ' (Renovação)',
    tipoAtividade: 'Consultório',
    valor: valorTotal,
    statusPgto: formaPagamento === 'À vista' ? 'Pago' : 'Parcial',
    obs: '[Programa Assinatura — Renovação]',
    pacIdx: ins.pacIdx,
  });
  DB.set('pacientes', pacs);

  closeModal('modal-renovar');
  // Atualiza qualquer página visível que dependa dos dados
  if (document.getElementById('page-programas')?.classList.contains('active')) renderProgramas();
  if (document.getElementById('page-dashboard')?.classList.contains('active')) renderDashboard();
  if (document.getElementById('page-followup')?.classList.contains('active')) renderFollowup();
  if (document.getElementById('page-pacientes')?.classList.contains('active')) renderPacientes();
  _auditLog('editou', 'inscricao', `Renovou ${prog.nome} de ${ins.pacienteNome} até ${formatDate(novaDataFim)}`);
  toast(`✅ Programa renovado para ${ins.pacienteNome} até ${formatDate(novaDataFim)}`);
}

// Registra a realização de um marco e dispara o próximo (programa contínuo)
function registrarMarco(inscricaoId, marcoIdx, valoresClinicos = {}, obs = '') {
  const inscricoes = DB.get('inscricoes');
  const ins = inscricoes.find(i => i.id === inscricaoId);
  if (!ins) return;
  const reg = ins.registros[marcoIdx];
  if (!reg) return;
  reg.dataReal = _ymd(new Date());
  reg.valoresClinicos = valoresClinicos || {};
  reg.obs = obs || '';

  // Atualiza agendamento correspondente
  if (reg.agendamentoId) {
    const ags = DB.get('agendamentos');
    const ag = ags.find(a => a.id === reg.agendamentoId);
    if (ag) { ag.status = 'Compareceu'; DB.set('agendamentos', ags); }
  }
  // Marca o follow-up como feito
  if (reg.followupIdx != null) {
    const fus = DB.get('followup');
    if (fus[reg.followupIdx]) { fus[reg.followupIdx].feito = true; DB.set('followup', fus); }
  }

  const prog = getProgramas().find(p => p.id === ins.programaId);
  // Programa Contínuo: cria automaticamente o próximo marco
  if (prog && prog.tipo === 'Contínuo' && marcoIdx === ins.registros.length - 1) {
    const dataNova = _addDaysIso(reg.dataReal, prog.intervaloDias || 90);
    const ags = DB.get('agendamentos');
    const fus = DB.get('followup');
    const novoIdx = ins.registros.length;
    const agId = (typeof _agId === 'function') ? _agId() : ('ag_' + Date.now() + '_' + novoIdx);
    ags.push({
      id: agId, data: dataNova, hora: '08:00', duracao: 50,
      pacienteNome: ins.pacienteNome, whatsapp: ins.pacienteWhatsapp || '', profissionalId: ins.profissionalId || null,
      procedimento: prog.nome, status: 'Confirmado',
      tipoAtividade: 'Consultório',
      obs: `[Programa: ${prog.nome}] marco ${novoIdx+1}`,
      programaInscricaoId: ins.id, marcoIdx: novoIdx,
      crmIdx: null, pacIdx: ins.pacIdx,
    });
    fus.push({
      id: _novoId('fu'), profissionalId: ins.profissionalId || null,
      nome: ins.pacienteNome, ultConsulta: reg.dataReal,
      dataContato: _addDaysIso(dataNova, -2),
      tipoContato: 'WhatsApp', feito: false, dataReav: dataNova,
      obs: `Confirmar próximo marco — ${prog.nome}`,
      programaInscricaoId: ins.id, marcoIdx: novoIdx,
    });
    DB.set('agendamentos', ags);
    DB.set('followup', fus);
    ins.registros.push({
      marcoIdx: novoIdx, dataPrevista: dataNova, dataReal: null,
      agendamentoId: agId, followupIdx: fus.length - 1,
      valoresClinicos: {}, obs: ''
    });
  }

  // Fixo: se todos os marcos preenchidos, conclui
  if (prog && prog.tipo === 'Fixo' && ins.registros.every(r => r.dataReal)) {
    ins.status = 'Concluído';
  }

  DB.set('inscricoes', inscricoes);
}

// Retorna o próximo marco pendente de uma inscrição (ou null se concluída)
function _proximoMarco(ins) {
  return ins.registros.find(r => !r.dataReal) || null;
}

// Retorna a aderência de uma inscrição (registros realizados até hoje / esperados até hoje)
function _aderenciaInscricao(ins) {
  const hoje = _ymd(new Date());
  const esperados = ins.registros.filter(r => r.dataPrevista <= hoje).length;
  const realizados = ins.registros.filter(r => r.dataReal).length;
  return esperados ? (realizados / esperados) * 100 : 100;
}

// Retorna a inscrição correspondente a um agendamento (se houver)
function _inscricaoDoAg(ag) {
  if (!ag.programaInscricaoId) return null;
  return getInscricoes().find(i => i.id === ag.programaInscricaoId) || null;
}

// ====================== UI: PÁGINA PROGRAMAS ======================
let _progTab = 'pacientes';
function setProgramasTab(tab) {
  _progTab = tab;
  document.getElementById('prog-tab-pacientes').classList.toggle('prog-tab-active', tab === 'pacientes');
  document.getElementById('prog-tab-templates').classList.toggle('prog-tab-active', tab === 'templates');
  document.getElementById('prog-conteudo-pacientes').style.display = tab === 'pacientes' ? '' : 'none';
  document.getElementById('prog-conteudo-templates').style.display = tab === 'templates' ? '' : 'none';
  renderProgramas();
}

function renderProgramas() {
  const progs = getProgramas();
  const inscricoes = getInscricoes();
  const ativas = inscricoes.filter(i => i.status === 'Ativo');
  const hoje = _ymd(new Date());

  // KPIs
  const totalAtivos = ativas.length;
  const aderencias = ativas.map(i => _aderenciaInscricao(i));
  const aderMedia = aderencias.length ? aderencias.reduce((s,x)=>s+x,0) / aderencias.length : 0;
  const atrasados = ativas.filter(i => {
    const prox = _proximoMarco(i);
    return prox && prox.dataPrevista < hoje;
  }).length;
  const concluidos = inscricoes.filter(i => i.status === 'Concluído').length;

  // MRR: soma (valorTotal / vigenciaDias) * 30 para cada assinatura ativa
  const mrr = ativas.reduce((sum, ins) => {
    const p = progs.find(x => x.id === ins.programaId);
    if (!p || p.tipo !== 'Assinatura' || !ins.valorTotal) return sum;
    return sum + (ins.valorTotal / _vigenciaDias(p.vigencia)) * 30;
  }, 0);

  const kpis = document.getElementById('prog-kpis');
  if (kpis) {
    kpis.innerHTML = `
      <div class="chart-card" style="padding:14px 18px;">
        <div style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;">Inscritos ativos</div>
        <div style="font-size:24px;font-weight:800;color:#0f172a;margin-top:4px;">${totalAtivos}</div>
      </div>
      <div class="chart-card" style="padding:14px 18px;">
        <div style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;">Aderência média</div>
        <div style="font-size:24px;font-weight:800;color:${aderMedia>=80?'#15803d':aderMedia>=50?'#a16207':'#b91c1c'};margin-top:4px;">${PCT(aderMedia)}</div>
      </div>
      <div class="chart-card" style="padding:14px 18px;">
        <div style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;">Atrasados</div>
        <div style="font-size:24px;font-weight:800;color:${atrasados>0?'#dc2626':'#0f172a'};margin-top:4px;">${atrasados}</div>
      </div>
      <div class="chart-card" style="padding:14px 18px;">
        <div style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;">Concluídos</div>
        <div style="font-size:24px;font-weight:800;color:#0f172a;margin-top:4px;">${concluidos}</div>
      </div>
      <div class="chart-card" style="padding:14px 18px;">
        <div style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;">MRR (Assinaturas)</div>
        <div style="font-size:24px;font-weight:800;color:#7c3aed;margin-top:4px;">${BRL(mrr)}</div>
      </div>`;
  }

  // Aba: Pacientes inscritos
  const elPac = document.getElementById('prog-conteudo-pacientes');
  if (elPac) {
    if (!inscricoes.length) {
      elPac.innerHTML = `<div class="chart-card" style="text-align:center;padding:48px 24px;color:#94a3b8;">
        Nenhum paciente inscrito. <button class="btn-primary" style="margin-left:12px;" onclick="openModalInscrever()">+ Inscrever paciente</button>
      </div>`;
    } else {
      elPac.innerHTML = `<div class="chart-card" style="padding:0;overflow:hidden;">
        <table class="data-table">
          <thead><tr><th>Paciente</th><th>Programa</th><th>Progresso / Validade</th><th>Próximo marco / Dias restantes</th><th>Status</th><th>Ações</th></tr></thead>
          <tbody>
            ${inscricoes.map(i => _rowInscricao(i, hoje, progs)).join('')}
          </tbody>
        </table></div>`;
    }
  }

  // Aba: Templates
  const elTpl = document.getElementById('prog-conteudo-templates');
  if (elTpl) {
    if (!progs.length) {
      elTpl.innerHTML = `<div class="chart-card" style="text-align:center;padding:48px 24px;color:#94a3b8;">
        Nenhum template. <button class="btn-primary" style="margin-left:12px;" onclick="openModalTemplatePrograma()">+ Novo template</button>
      </div>`;
    } else {
      elTpl.innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px;">
        ${progs.map(p => {
          const inscritos = inscricoes.filter(i => i.programaId === p.id).length;
          const tipoCor = p.tipo === 'Fixo' ? '#1d4ed8' : p.tipo === 'Contínuo' ? '#15803d' : '#7c3aed';
          const tipoBg  = p.tipo === 'Fixo' ? '#eff6ff' : p.tipo === 'Contínuo' ? '#f0fdf4' : '#f5f3ff';
          let detalhes = '';
          if (p.tipo === 'Fixo') detalhes = `${(p.marcos||[]).length} marco(s)`;
          else if (p.tipo === 'Contínuo') detalhes = `A cada ${p.intervaloDias} dias`;
          else if (p.tipo === 'Assinatura') detalhes = `${_esc(p.vigencia)} · ${BRL(p.precoAVista||0)} à vista`;
          return `<div class="chart-card" style="padding:18px;">
            <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:8px;">
              <div style="font-size:14px;font-weight:700;color:#0f172a;">${_esc(p.nome)}</div>
              <span style="font-size:10px;font-weight:700;color:${tipoCor};background:${tipoBg};padding:2px 7px;border-radius:999px;">${_esc(p.tipo)}</span>
            </div>
            <div style="font-size:12px;color:#64748b;margin-bottom:10px;min-height:32px;">${_esc(p.descricao || '—')}</div>
            <div style="font-size:11.5px;color:#475569;margin-bottom:10px;">
              ${detalhes} · ${inscritos} inscrito(s)
            </div>
            <div style="display:flex;gap:6px;">
              <button onclick="openModalTemplatePrograma('${p.id}')" style="flex:1;background:#f1f5f9;border:none;border-radius:6px;padding:6px 10px;font-size:11.5px;font-weight:600;color:#475569;cursor:pointer;">Editar</button>
              <button onclick="openModalInscrever('${p.id}')" style="flex:1;background:#3b82f6;color:#fff;border:none;border-radius:6px;padding:6px 10px;font-size:11.5px;font-weight:600;cursor:pointer;">Inscrever</button>
            </div>
          </div>`;
        }).join('')}
      </div>`;
    }
  }
}

function _rowInscricao(ins, hoje, progs) {
  const prog = progs.find(p => p.id === ins.programaId);
  const progNome = prog ? prog.nome : '—';
  const corStatus = ins.status === 'Ativo' ? '#15803d' : ins.status === 'Pausado' ? '#a16207' : ins.status === 'Expirado' ? '#dc2626' : '#64748b';

  // ── Tipo Assinatura ──
  if (prog && prog.tipo === 'Assinatura') {
    const dataFim = ins.dataFim || '—';
    const diasRestantes = ins.dataFim
      ? Math.round((new Date(ins.dataFim + 'T12:00:00') - new Date(hoje + 'T12:00:00')) / 86400000)
      : null;
    const corDias = diasRestantes != null && diasRestantes < 30 ? '#dc2626' : '#475569';
    const pesoDias = diasRestantes != null && diasRestantes < 30 ? 'font-weight:700;' : '';
    // Auto-marca como Expirado se passou
    if (ins.status === 'Ativo' && ins.dataFim && ins.dataFim < hoje) {
      ins.status = 'Expirado';
    }
    return `<tr>
      <td style="font-weight:600;">${_esc(ins.pacienteNome)}</td>
      <td>
        ${_esc(progNome)}
        <span style="font-size:10px;font-weight:700;color:#7c3aed;background:#f5f3ff;padding:2px 6px;border-radius:999px;margin-left:4px;">Assinatura</span>
      </td>
      <td>
        <div style="font-size:12px;color:#475569;">Validade: <strong>${formatDate(dataFim)}</strong></div>
        <div style="font-size:11.5px;color:#94a3b8;">${ins.formaPagamento || ''}${ins.nParcelas ? ` · ${ins.nParcelas}x` : ''} · ${BRL(ins.valorTotal || 0)}</div>
      </td>
      <td>
        ${diasRestantes != null
          ? `<span style="color:${corDias};${pesoDias}">${diasRestantes < 0 ? 'Vencida há ' + Math.abs(diasRestantes) + 'd' : diasRestantes + ' dias restantes'}</span>`
          : '<span style="color:#94a3b8;">—</span>'}
      </td>
      <td><span style="color:${corStatus};font-weight:600;font-size:12px;">${ins.status}</span></td>
      <td style="white-space:nowrap;">
        ${ins.status !== 'Cancelado' ? `<button onclick="renovarInscricao('${ins.id}')" style="background:#7c3aed;color:#fff;border:none;border-radius:6px;padding:4px 9px;font-size:11px;font-weight:600;cursor:pointer;margin-right:4px;">🔄 Renovar</button>` : ''}
        ${ins.status === 'Ativo' ? `<button onclick="cancelarInscricaoAssinatura('${ins.id}')" title="Cancelar" style="background:#fef2f2;color:#b91c1c;border:none;border-radius:6px;padding:4px 7px;font-size:11px;cursor:pointer;">✕ Cancelar</button>` : ''}
        <button onclick="excluirInscricao('${ins.id}')" title="Excluir" style="background:#fef2f2;color:#b91c1c;border:none;border-radius:6px;padding:4px 7px;font-size:11px;cursor:pointer;margin-left:2px;">🗑️</button>
      </td>
    </tr>`;
  }

  // ── Tipos Fixo / Contínuo ──
  const totalMarcos = ins.registros.length;
  const realizados  = ins.registros.filter(r => r.dataReal).length;
  const pct = totalMarcos ? (realizados / totalMarcos) * 100 : 0;
  const prox = _proximoMarco(ins);
  const atrasado = prox && prox.dataPrevista < hoje;

  return `<tr>
    <td style="font-weight:600;">${_esc(ins.pacienteNome)}</td>
    <td>${_esc(progNome)}</td>
    <td>
      <div style="display:flex;align-items:center;gap:6px;">
        <div style="flex:1;height:6px;background:#f1f5f9;border-radius:3px;overflow:hidden;min-width:60px;">
          <div style="height:100%;width:${pct.toFixed(1)}%;background:${pct>=80?'#16a34a':pct>=40?'#3b82f6':'#94a3b8'};"></div>
        </div>
        <span style="font-size:11.5px;color:#64748b;white-space:nowrap;">${realizados}/${totalMarcos}</span>
      </div>
    </td>
    <td>${prox ? `<span style="color:${atrasado?'#dc2626':'#475569'};${atrasado?'font-weight:700;':''}">${atrasado?'⚠️ ':''}${formatDate(prox.dataPrevista)}</span>` : '<span style="color:#94a3b8;">—</span>'}</td>
    <td><span style="color:${corStatus};font-weight:600;font-size:12px;">${ins.status}</span></td>
    <td style="white-space:nowrap;">
      ${prox && ins.status === 'Ativo' ? `<button onclick="openModalRegistrarMarco('${ins.id}',${prox.marcoIdx})" style="background:#10b981;color:#fff;border:none;border-radius:6px;padding:4px 9px;font-size:11px;font-weight:600;cursor:pointer;margin-right:4px;">✓ Registrar</button>` : ''}
      ${ins.status === 'Ativo' ? `<button onclick="pausarInscricao('${ins.id}')" title="Pausar" style="background:#fef3c7;color:#a16207;border:none;border-radius:6px;padding:4px 7px;font-size:11px;cursor:pointer;">⏸</button>` : ''}
      ${ins.status === 'Pausado' ? `<button onclick="reativarInscricao('${ins.id}')" title="Reativar" style="background:#dbeafe;color:#1d4ed8;border:none;border-radius:6px;padding:4px 7px;font-size:11px;cursor:pointer;">▶</button>` : ''}
      <button onclick="excluirInscricao('${ins.id}')" title="Excluir" style="background:#fef2f2;color:#b91c1c;border:none;border-radius:6px;padding:4px 7px;font-size:11px;cursor:pointer;margin-left:2px;">🗑️</button>
    </td>
  </tr>`;
}

function cancelarInscricaoAssinatura(id) {
  if (!confirm('Cancelar esta assinatura?')) return;
  const inscricoes = DB.get('inscricoes');
  const ins = inscricoes.find(i => i.id === id);
  if (!ins) return;
  ins.status = 'Cancelado';
  DB.set('inscricoes', inscricoes);
  renderProgramas();
  toast('Assinatura cancelada');
}

// === Modais ===
function openModalInscrever(programaPreId) {
  const progs = getProgramas().filter(p => p.ativo !== false);
  const sel = document.getElementById('ins-programa');
  sel.innerHTML = progs.map(p => `<option value="${_esc(p.id)}">${_esc(p.nome)} (${p.tipo})</option>`).join('');
  if (programaPreId) sel.value = programaPreId;
  document.getElementById('ins-data-inicio').value = _ymd(new Date());
  document.getElementById('ins-paciente-nome').value = '';
  document.getElementById('ins-paciente-whats').value = '';
  // datalist com pacientes
  const pacs = DB.get('pacientes');
  const nomes = [...new Set(pacs.map(p => p.nome).filter(Boolean))];
  document.getElementById('ins-pacientes-list').innerHTML = nomes.map(n => `<option value="${_esc(n)}">`).join('');
  _atualizarInfoPrograma();
  sel.onchange = _atualizarInfoPrograma;
  openModal('modal-inscrever');
}
function _atualizarInfoPrograma() {
  const id = document.getElementById('ins-programa').value;
  const prog = getProgramas().find(p => p.id === id);
  const info = document.getElementById('ins-prog-info');
  const pagWrap = document.getElementById('ins-pagamento-wrap');
  if (!prog || !info) return;

  if (prog.tipo === 'Fixo') {
    info.innerHTML = `<strong>${_esc(prog.nome)}</strong> · ${prog.marcos.length} marcos: ${prog.marcos.map(m => m.dias + 'd').join(', ')}`;
    if (pagWrap) pagWrap.style.display = 'none';
  } else if (prog.tipo === 'Contínuo') {
    info.innerHTML = `<strong>${_esc(prog.nome)}</strong> · Contínuo a cada ${prog.intervaloDias} dias`;
    if (pagWrap) pagWrap.style.display = 'none';
  } else if (prog.tipo === 'Assinatura') {
    info.innerHTML = `<strong>${_esc(prog.nome)}</strong> · Vigência: ${_esc(prog.vigencia)} · À vista: ${BRL(prog.precoAVista || 0)}`;
    if (pagWrap) {
      pagWrap.style.display = '';
      // Popula selects
      const formaEl = document.getElementById('ins-forma-pgto');
      if (formaEl) formaEl.value = 'À vista';
      _atualizarPagamentoInscrever(prog);
    }
  }
}
function _atualizarPagamentoInscrever(progOverride) {
  const id = document.getElementById('ins-programa').value;
  const prog = progOverride || getProgramas().find(p => p.id === id);
  if (!prog || prog.tipo !== 'Assinatura') return;
  const formaEl = document.getElementById('ins-forma-pgto');
  const forma = formaEl?.value;
  const parcelasWrap = document.getElementById('ins-parcelas-wrap');
  const parcelasSel  = document.getElementById('ins-parcelas-sel');
  const valEl        = document.getElementById('ins-valor-total');
  const parcelasDisp = Array.isArray(prog.parcelas) && prog.parcelas.length > 0;

  // Desabilita "Parcelado" se programa não permite
  const optParc = formaEl?.querySelector('option[value="Parcelado"]');
  if (optParc) {
    optParc.disabled = !parcelasDisp;
    optParc.textContent = parcelasDisp ? 'Parcelado' : 'Parcelado (não disponível)';
  }
  // Auto-fallback se selecionou Parcelado mas não tem parcelas
  if (formaEl && forma === 'Parcelado' && !parcelasDisp) {
    formaEl.value = 'À vista';
  }
  const formaAtual = formaEl?.value;

  if (formaAtual === 'Parcelado' && parcelasDisp) {
    if (parcelasWrap) parcelasWrap.style.display = '';
    if (parcelasSel) {
      parcelasSel.innerHTML = prog.parcelas.map(p =>
        `<option value="${p.n}">${p.n}x ${BRL(p.valor)} (total ${BRL(p.n * p.valor)})</option>`
      ).join('');
    }
    const nSel = parseInt(parcelasSel?.value) || prog.parcelas[0].n;
    const opt  = prog.parcelas.find(p => p.n === nSel) || prog.parcelas[0];
    if (valEl) valEl.textContent = opt ? `Valor total: ${BRL(opt.n * opt.valor)}` : '';
  } else {
    if (parcelasWrap) parcelasWrap.style.display = 'none';
    if (valEl) valEl.textContent = `Valor total: ${BRL(prog.precoAVista || 0)} (à vista)`;
  }
}
function saveInscricao(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const programaId = fd.get('programaId');
  const nome = (fd.get('pacienteNome') || '').trim();
  if (!nome) { alert('Informe o nome do paciente'); return; }
  const whatsapp = fd.get('pacienteWhatsapp') || '';
  const dataInicio = fd.get('dataInicio');
  // Tenta encontrar pacIdx
  const pacs = DB.get('pacientes');
  const pacIdx = pacs.findIndex(p => p.nome === nome);

  // Dados de pagamento (para Assinatura)
  const prog = getProgramas().find(p => p.id === programaId);
  let pagamentoOpts = {};
  if (prog && prog.tipo === 'Assinatura') {
    const formaPagamento = fd.get('formaPagamento') || 'À vista';
    const nParcelas = formaPagamento === 'Parcelado' ? (parseInt(fd.get('nParcelas')) || null) : null;
    pagamentoOpts = { formaPagamento, nParcelas };
  }

  const ins = inscreverEmPrograma(programaId, { nome, whatsapp, pacIdx: pacIdx >= 0 ? pacIdx : null }, dataInicio, '08:00', pagamentoOpts);
  if (ins) {
    closeModal('modal-inscrever');
    renderProgramas();
    const msg = prog && prog.tipo === 'Assinatura'
      ? `✅ ${nome} inscrito(a) no programa de assinatura. Lançamento financeiro e follow-up de renovação criados.`
      : `✅ ${nome} inscrito(a). Agendamentos e follow-ups criados automaticamente.`;
    toast(msg);
  }
}

let _marcoBuffer = [];
let _camposBuffer = [];
let _beneficiosBuffer = [];
let _parcelasBuffer = [];
function openModalTemplatePrograma(id) {
  const progs = getProgramas();
  const p = id ? progs.find(x => x.id === id) : null;
  document.getElementById('tpl-id').value = p ? p.id : '';
  document.getElementById('tpl-nome').value = p ? p.nome : '';
  document.getElementById('tpl-descricao').value = p ? (p.descricao || '') : '';
  document.getElementById('tpl-tipo').value = p ? p.tipo : 'Fixo';
  document.getElementById('tpl-intervalo').value = p ? (p.intervaloDias || 90) : 90;
  _marcoBuffer = p && p.marcos ? p.marcos.map(m => ({...m})) : [{ dias: 7, descricao: 'Retorno 7 dias', tipoAtividade: 'Consultório', duracao: 30 }];
  _camposBuffer = p && p.camposClinicos ? p.camposClinicos.map(c => ({...c})) : [];
  _beneficiosBuffer = p && p.beneficios ? [...p.beneficios] : [];
  _parcelasBuffer   = p && p.parcelas   ? p.parcelas.map(x => ({...x})) : [];
  // Preenche preço (comum a todos os tipos)
  const avEl = document.getElementById('tpl-preco-avista');
  if (avEl) avEl.value = p && p.precoAVista ? p.precoAVista : '';
  // Campos específicos de Assinatura
  if (p && p.tipo === 'Assinatura') {
    const vigEl = document.getElementById('tpl-vigencia');
    if (vigEl) vigEl.value = p.vigencia || 'Anual';
    const caEl = document.getElementById('tpl-consulta-avulsa');
    if (caEl) caEl.value = p.consultaAvulsa || '';
    const polEl = document.getElementById('tpl-politicas');
    if (polEl) polEl.value = p.politicas || '';
  } else {
    // Limpa campos de Assinatura
    const caEl = document.getElementById('tpl-consulta-avulsa');
    if (caEl) caEl.value = '';
    const polEl = document.getElementById('tpl-politicas');
    if (polEl) polEl.value = '';
  }
  _atualizarTipoPrograma();
  _renderMarcoBuffer();
  _renderCamposBuffer();
  _renderBeneficiosBuffer();
  _renderParcelasBuffer();
  openModal('modal-template-programa');
}
function _atualizarTipoPrograma() {
  const tipo = document.getElementById('tpl-tipo').value;
  document.getElementById('tpl-intervalo-wrap').style.display = tipo === 'Contínuo' ? '' : 'none';
  document.getElementById('tpl-marcos-wrap').style.display = tipo === 'Fixo' ? '' : 'none';
  const asnWrap = document.getElementById('tpl-assinatura-wrap');
  if (asnWrap) asnWrap.style.display = tipo === 'Assinatura' ? '' : 'none';
  const asnExtra = document.getElementById('tpl-assinatura-extra-wrap');
  if (asnExtra) asnExtra.style.display = tipo === 'Assinatura' ? '' : 'none';
  const camposWrap = document.getElementById('tpl-campos-wrap');
  if (camposWrap) camposWrap.style.display = tipo !== 'Assinatura' ? '' : 'none';

  // Ajusta label do preço e exibe consulta avulsa apenas para Assinatura
  const precoLabel = document.getElementById('tpl-preco-label');
  const precoInput = document.getElementById('tpl-preco-avista');
  const consAvWrap = document.getElementById('tpl-consulta-avulsa-wrap');
  if (precoLabel) {
    if (tipo === 'Assinatura') precoLabel.textContent = 'Preço à vista (R$)';
    else if (tipo === 'Contínuo') precoLabel.textContent = 'Preço por consulta (R$)';
    else precoLabel.textContent = 'Preço do pacote (R$)';
  }
  if (precoInput) {
    if (tipo === 'Assinatura') precoInput.placeholder = '6480';
    else if (tipo === 'Contínuo') precoInput.placeholder = '300';
    else precoInput.placeholder = '1500';
  }
  if (consAvWrap) consAvWrap.style.display = tipo === 'Assinatura' ? '' : 'none';
}
function _renderBeneficiosBuffer() {
  const cont = document.getElementById('tpl-beneficios');
  if (!cont) return;
  cont.innerHTML = _beneficiosBuffer.map((b, idx) => `
    <div style="display:grid;grid-template-columns:1fr 30px;gap:6px;align-items:center;margin-bottom:4px;">
      <input type="text" value="${_esc(b)}" oninput="_beneficiosBuffer[${idx}]=this.value" class="input" placeholder="Ex: Consultas ilimitadas" />
      <button type="button" onclick="_beneficiosBuffer.splice(${idx},1);_renderBeneficiosBuffer();" style="background:none;border:none;color:#dc2626;cursor:pointer;font-size:14px;">×</button>
    </div>
  `).join('');
}
function _addBeneficioTpl() {
  _beneficiosBuffer.push('');
  _renderBeneficiosBuffer();
}
function _renderParcelasBuffer() {
  const cont = document.getElementById('tpl-parcelas');
  if (!cont) return;
  cont.innerHTML = _parcelasBuffer.map((p, idx) => `
    <div style="display:grid;grid-template-columns:80px 120px 30px;gap:6px;align-items:center;margin-bottom:4px;">
      <input type="number" min="1" value="${p.n}" onchange="_parcelasBuffer[${idx}].n=parseInt(this.value)||1" class="input" placeholder="Nº parcelas" />
      <input type="number" min="0" step="0.01" value="${p.valor}" onchange="_parcelasBuffer[${idx}].valor=parseFloat(this.value)||0" class="input" placeholder="Valor (R$)" />
      <button type="button" onclick="_parcelasBuffer.splice(${idx},1);_renderParcelasBuffer();" style="background:none;border:none;color:#dc2626;cursor:pointer;font-size:14px;">×</button>
    </div>
  `).join('');
}
function _addParcelaTpl() {
  _parcelasBuffer.push({ n: 12, valor: 0 });
  _renderParcelasBuffer();
}
function _renderMarcoBuffer() {
  const cont = document.getElementById('tpl-marcos');
  cont.innerHTML = _marcoBuffer.map((m, idx) => `
    <div style="display:grid;grid-template-columns:70px 1fr 110px 80px 30px;gap:6px;align-items:center;">
      <input type="number" min="1" value="${m.dias}" onchange="_marcoBuffer[${idx}].dias=parseInt(this.value)||1" class="input" placeholder="dias" />
      <input type="text" value="${_esc(m.descricao)}" oninput="_marcoBuffer[${idx}].descricao=this.value" class="input" placeholder="Descrição" />
      <select onchange="_marcoBuffer[${idx}].tipoAtividade=this.value" class="select">
        <option value="Consultório" ${m.tipoAtividade==='Consultório'?'selected':''}>Consultório</option>
        <option value="Visita Domiciliar" ${m.tipoAtividade==='Visita Domiciliar'?'selected':''}>Domiciliar</option>
        <option value="Visita Hospitalar" ${m.tipoAtividade==='Visita Hospitalar'?'selected':''}>Hospitalar</option>
        <option value="Outro" ${m.tipoAtividade==='Outro'?'selected':''}>Outro</option>
      </select>
      <input type="number" min="10" step="5" value="${m.duracao||50}" onchange="_marcoBuffer[${idx}].duracao=parseInt(this.value)||50" class="input" placeholder="min" />
      <button type="button" onclick="_marcoBuffer.splice(${idx},1);_renderMarcoBuffer();" style="background:none;border:none;color:#dc2626;cursor:pointer;font-size:14px;">×</button>
    </div>
  `).join('');
}
function _addMarcoTpl() {
  const ultimo = _marcoBuffer[_marcoBuffer.length-1];
  const proxDias = ultimo ? ultimo.dias + 30 : 7;
  _marcoBuffer.push({ dias: proxDias, descricao: `Retorno ${proxDias} dias`, tipoAtividade: 'Consultório', duracao: 50 });
  _renderMarcoBuffer();
}
function _renderCamposBuffer() {
  const cont = document.getElementById('tpl-campos');
  cont.innerHTML = _camposBuffer.map((c, idx) => `
    <div style="display:grid;grid-template-columns:1fr 140px 30px;gap:6px;align-items:center;">
      <input type="text" value="${_esc(c.nome)}" oninput="_camposBuffer[${idx}].nome=this.value" class="input" placeholder="Ex: PA, Peso…" />
      <input type="text" value="${_esc(c.unidade||'')}" oninput="_camposBuffer[${idx}].unidade=this.value" class="input" placeholder="Unidade" />
      <button type="button" onclick="_camposBuffer.splice(${idx},1);_renderCamposBuffer();" style="background:none;border:none;color:#dc2626;cursor:pointer;font-size:14px;">×</button>
    </div>
  `).join('');
}
function _addCampoClinicoTpl() {
  _camposBuffer.push({ nome: '', unidade: '' });
  _renderCamposBuffer();
}
function saveTemplatePrograma(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const id = fd.get('programaId') || ('pg_' + Date.now());
  const tipo = fd.get('tipo');
  // Campos de preço comuns a todos os tipos
  const precoAVista = parseFloat(fd.get('precoAVista')) || 0;
  const parcelas = _parcelasBuffer.filter(p => p.n && p.valor);

  let programa;
  if (tipo === 'Assinatura') {
    programa = {
      id, nome: fd.get('nome'),
      tipo, descricao: fd.get('descricao') || '',
      vigencia: fd.get('vigencia') || 'Anual',
      beneficios: _beneficiosBuffer.filter(b => b.trim()),
      precoAVista,
      descontoAVista: 0,
      parcelas,
      consultaAvulsa: parseFloat(fd.get('consultaAvulsa')) || 0,
      politicas: fd.get('politicas') || '',
      ativo: true,
    };
  } else {
    programa = {
      id, nome: fd.get('nome'),
      tipo, descricao: fd.get('descricao') || '',
      marcos: tipo === 'Fixo' ? _marcoBuffer.filter(m => m.descricao).sort((a,b)=>a.dias-b.dias) : [],
      intervaloDias: tipo === 'Contínuo' ? (parseInt(fd.get('intervaloDias'))||90) : null,
      camposClinicos: _camposBuffer.filter(c => c.nome),
      precoAVista,
      parcelas,
      ativo: true,
    };
  }
  const progs = getProgramas();
  const idx = progs.findIndex(p => p.id === id);
  if (idx >= 0) progs[idx] = programa; else progs.push(programa);
  DB.set('programas', progs);
  closeModal('modal-template-programa');
  renderProgramas();
  toast(`✅ Programa "${programa.nome}" salvo`);
  _auditLog(idx >= 0 ? 'editou' : 'criou', 'programa', `${idx >= 0 ? 'Editou' : 'Criou'} programa ${programa.nome} (${tipo})`);
}

function openModalRegistrarMarco(inscricaoId, marcoIdx) {
  const ins = getInscricoes().find(i => i.id === inscricaoId);
  if (!ins) return;
  const prog = getProgramas().find(p => p.id === ins.programaId);
  if (!prog) return;
  const reg = ins.registros[marcoIdx];
  const marco = prog.tipo === 'Fixo' ? prog.marcos[reg.marcoIdx] : { descricao: prog.nome };
  document.getElementById('rm-inscricao').value = inscricaoId;
  document.getElementById('rm-marco-idx').value = marcoIdx;
  document.getElementById('rm-info').innerHTML = `<strong>${_esc(ins.pacienteNome)}</strong> · ${_esc(prog.nome)} · ${_esc(marco.descricao)}<br><span style="font-size:11px;color:#16a34a;">Previsto: ${formatDate(reg.dataPrevista)}</span>`;
  const cont = document.getElementById('rm-campos-clinicos');
  cont.innerHTML = (prog.camposClinicos || []).map(c => `
    <div><label style="font-size:11.5px;color:#475569;">${_esc(c.nome)} ${c.unidade ? `<span style="color:#94a3b8;">(${_esc(c.unidade)})</span>` : ''}</label>
      <input type="text" class="input" name="clin_${_esc(c.nome)}" placeholder="Ex: 130/85" /></div>
  `).join('') || '<div style="font-size:12px;color:#94a3b8;">Sem campos clínicos definidos no template.</div>';
  document.getElementById('rm-obs').value = '';
  openModal('modal-registrar-marco');
}
function saveRegistroMarco(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const inscricaoId = fd.get('inscricaoId');
  const marcoIdx = parseInt(fd.get('marcoIdx'));
  const obs = fd.get('obs') || '';
  // Coleta valores clínicos
  const valoresClinicos = {};
  for (const [k, v] of fd.entries()) {
    if (k.startsWith('clin_') && v) valoresClinicos[k.replace('clin_','')] = v;
  }
  registrarMarco(inscricaoId, marcoIdx, valoresClinicos, obs);
  closeModal('modal-registrar-marco');
  renderProgramas();
  toast('✅ Marco registrado');
}

function pausarInscricao(id) {
  const inscricoes = getInscricoes();
  const ins = inscricoes.find(i => i.id === id);
  if (!ins) return;
  ins.status = 'Pausado';
  DB.set('inscricoes', inscricoes);
  renderProgramas();
}
function reativarInscricao(id) {
  const inscricoes = getInscricoes();
  const ins = inscricoes.find(i => i.id === id);
  if (!ins) return;
  ins.status = 'Ativo';
  DB.set('inscricoes', inscricoes);
  renderProgramas();
}
function excluirInscricao(id) {
  const inscricoes = getInscricoes();
  const ins = inscricoes.find(i => i.id === id);
  if (!ins) return;
  // Analisa o que será removido
  const ags = DB.get('agendamentos').filter(a => a.programaInscricaoId === id && a.status !== 'Compareceu').length;
  const fus = DB.get('followup').filter(f => f.programaInscricaoId === id && !f.feito).length;
  const prog = getProgramas().find(p => p.id === ins.programaId);
  const nomeProg = prog?.nome || 'programa';

  // Confirmação dupla com info detalhada
  const msg = `⚠️ Excluir inscrição de ${ins.pacienteNome} no ${nomeProg}?\n\nSerão removidos:\n  • A inscrição (status: ${ins.status})\n  • ${ags} agendamento(s) futuro(s) vinculado(s)\n  • ${fus} follow-up(s) pendente(s) vinculado(s)\n\nA receita financeira já lançada permanece.\n\nPara confirmar, digite EXCLUIR:`;
  const resp = prompt(msg);
  if (resp !== 'EXCLUIR') {
    if (resp !== null) toast('Exclusão cancelada — texto não confere.', 2500);
    return;
  }

  // Remove agendamentos não realizados (status != Compareceu)
  const agsLimpos = DB.get('agendamentos').filter(a => a.programaInscricaoId !== id || a.status === 'Compareceu');
  DB.set('agendamentos', agsLimpos);
  // Remove follow-ups pendentes
  const fusLimpos = DB.get('followup').filter(f => f.programaInscricaoId !== id || f.feito);
  DB.set('followup', fusLimpos);
  // Remove inscrição
  const filtradas = inscricoes.filter(i => i.id !== id);
  DB.set('inscricoes', filtradas);
  renderProgramas();
  toast('Inscrição excluída');
}

// Retorna o valor sugerido pra um procedimento dado a forma de pagamento
function valorSugerido(nomeProc, pagamento) {
  const procs = getProcedimentos();
  const p = procs.find(x => x.nome === nomeProc);
  if (!p) return null;
  // PIX, Dinheiro e A receber → valor PIX (sem taxa). Cartão → valor Cartão.
  const isCartao = pagamento && pagamento.toLowerCase().includes('cartão');
  return isCartao ? p.valorCartao : p.valorPix;
}

function popularProcedimentoSelect() {
  const sel = document.getElementById('pac-procedimento');
  if (!sel) return;
  const procs = getProcedimentos();
  const valAtual = sel.value;
  sel.innerHTML = procs.map(p => `<option value="${_esc(p.nome)}">${_esc(p.nome)}</option>`).join('');
  if (valAtual && procs.some(p => p.nome === valAtual)) sel.value = valAtual;
}

function atualizarValorSugerido() {
  const sel = document.getElementById('pac-procedimento');
  const pag = document.getElementById('pac-pagamento');
  const valor = document.getElementById('pac-valor');
  const hint = document.getElementById('pac-valor-hint');
  if (!sel || !pag || !valor || !hint) return;
  const procs = getProcedimentos();
  const p = procs.find(x => x.nome === sel.value);
  if (!p) { hint.textContent = ''; return; }
  hint.innerHTML = `💡 ${_esc(p.nome)}: PIX/Dinheiro <strong>${BRL(p.valorPix)}</strong> · Cartão <strong>${BRL(p.valorCartao)}</strong>`;
  const sug = valorSugerido(sel.value, pag.value);
  const atual = parseFloat(valor.value) || 0;
  if (!atual || atual === p.valorPix || atual === p.valorCartao) {
    valor.value = sug || '';
  }
  // Mostra/oculta campo de parcelas conforme forma de pagamento
  const parcelasRow = document.getElementById('pac-parcelas-row');
  if (parcelasRow) {
    const isCredito = (pag.value === 'Cartão crédito');
    parcelasRow.style.display = isCredito ? 'block' : 'none';
    if (!isCredito) { const ps = document.getElementById('pac-parcelas'); if (ps) ps.value = '1'; }
  }
  atualizarPreviewParcelas();
}

function atualizarPreviewParcelas() {
  const valorEl = document.getElementById('pac-valor');
  const parcelasEl = document.getElementById('pac-parcelas');
  const previewEl = document.getElementById('pac-parcelas-preview');
  if (!valorEl || !parcelasEl || !previewEl) return;
  const valor = parseFloat(valorEl.value) || 0;
  const n = parseInt(parcelasEl.value) || 1;
  if (n <= 1 || !valor) { previewEl.textContent = ''; return; }
  const parcela = valor / n;
  previewEl.textContent = `= ${n}× de ${BRL(parcela)}`;
}

function renderPrecos() {
  const tbody = document.getElementById('precos-tbody');
  const procs = getProcedimentos();
  if (!procs.length) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#94a3b8;padding:48px;">Nenhum procedimento cadastrado. Clique em "+ Novo Procedimento".</td></tr>';
    return;
  }
  tbody.innerHTML = procs.map((p, i) => {
    const diff = p.valorCartao - p.valorPix;
    const diffPct = p.valorPix ? (diff / p.valorPix) * 100 : 0;
    return `
      <tr>
        <td style="font-weight:600;color:#0f172a;">${_esc(p.nome)}${p.obs ? `<div style="font-size:11px;color:#94a3b8;font-weight:400;margin-top:2px;">${_esc(p.obs)}</div>` : ''}</td>
        <td style="text-align:right;font-weight:600;color:#10b981;">${BRL(p.valorPix)}</td>
        <td style="text-align:right;font-weight:600;color:#3b82f6;">${BRL(p.valorCartao)}</td>
        <td style="text-align:center;color:${diff > 0 ? '#3b82f6' : diff < 0 ? '#ef4444' : '#94a3b8'};font-size:12px;">${diff === 0 ? '—' : (diff > 0 ? '+' : '') + BRL(diff) + (diffPct ? ` (${diffPct.toFixed(1)}%)` : '')}</td>
        <td style="white-space:nowrap;">
          <button onclick="editProc(${i})" class="text-blue-400 hover:text-blue-600 text-xs mr-2" title="Editar">✏️</button>
          <button onclick="deleteProc(${i})" class="text-red-400 hover:text-red-600 text-xs" title="Excluir">🗑️</button>
        </td>
      </tr>`;
  }).join('');
}

function openModalProc() {
  editState = { col: null, idx: null, crmIdx: null, pacIdx: null };
  document.querySelector('#modal-proc .modal-title').textContent = 'Novo Procedimento';
  document.querySelector('#modal-proc form').reset();
  document.getElementById('modal-proc').style.display = 'flex';
}

function editProc(idx) {
  const procs = getProcedimentos();
  const p = procs[idx];
  if (!p) return;
  editState = { col: 'procedimentos', idx, crmIdx: null, pacIdx: null };
  const form = document.querySelector('#modal-proc form');
  form.nome.value = p.nome;
  form.valorPix.value = p.valorPix;
  form.valorCartao.value = p.valorCartao;
  form.obs.value = p.obs || '';
  document.querySelector('#modal-proc .modal-title').textContent = 'Editar Procedimento';
  document.getElementById('modal-proc').style.display = 'flex';
}

function deleteProc(idx) {
  const procs = getProcedimentos();
  const p = procs[idx];
  if (!p) return;
  if (!confirm(`Excluir o procedimento "${p.nome}"?\n\nAtendimentos já registrados com esse nome continuarão valendo, mas ele sairá do dropdown.`)) return;
  procs.splice(idx, 1);
  DB.set('procedimentos', procs);
  renderPrecos();
  toast('Procedimento excluído');
}

function saveProc(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const item = {
    nome: (fd.get('nome') || '').trim(),
    valorPix: parseFloat(fd.get('valorPix')) || 0,
    valorCartao: parseFloat(fd.get('valorCartao')) || 0,
    obs: (fd.get('obs') || '').trim(),
  };
  if (!item.nome) { toast('Informe o nome do procedimento'); return; }
  const procs = getProcedimentos();
  if (editState.col === 'procedimentos' && editState.idx !== null) {
    procs[editState.idx] = item;
  } else {
    // Evita duplicado
    if (procs.some(p => p.nome.toLowerCase() === item.nome.toLowerCase())) {
      toast('Já existe um procedimento com esse nome');
      return;
    }
    procs.push(item);
  }
  DB.set('procedimentos', procs);
  closeModal('modal-proc');
  renderPrecos();
  toast(`Procedimento "${item.nome}" salvo`);
}

// ====================== HELPERS ======================
const BRL = (v) => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const PCT = (v) => Number(v || 0).toFixed(1) + '%';
const DIAS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const MESES = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];

function formatDate(str) {
  if (!str) return '-';
  const [y, m, d] = str.split('-');
  return `${d}/${m}/${y}`;
}

function getMes(dateStr) { return dateStr ? dateStr.substring(0, 7) : ''; }

// TICKET MÉDIO em DUAS leituras, porque respondem perguntas diferentes:
//  · porConsultaPaga — "quanto vale uma consulta": só atendimentos com valor,
//    que é o preço efetivamente praticado.
//  · porAtendimento  — "quanto rende cada vez que alguém senta na cadeira":
//    divide por TUDO, inclusive os gratuitos.
// Retorno é gratuito por padrão (o procedimento 'Retorno' nasce com valor 0),
// então usar só a segunda leitura derrubava o número sem o médico perceber:
// 10 consultas de R$ 500 + 10 retornos grátis apareciam como "ticket R$ 250".
// "Paga" = valor > 0, ou seja o que foi COBRADO (não o que já entrou no caixa
// — para isso existe o regime de caixa em _resumoFin).
function _ticketMedio(pacs) {
  const lista = pacs || [];
  const bruto = lista.reduce((s, p) => s + (p.valor || 0), 0);
  const pagas = lista.filter(p => (p.valor || 0) > 0);
  const brutoPagas = pagas.reduce((s, p) => s + (p.valor || 0), 0);
  return {
    porAtendimento:  lista.length ? bruto / lista.length : 0,
    porConsultaPaga: pagas.length ? brutoPagas / pagas.length : 0,
    qtdAtendimentos: lista.length,
    qtdPagas:        pagas.length,
    qtdGratuitos:    lista.length - pagas.length,
  };
}

// PACIENTE NOVO = pessoa que NUNCA foi atendida antes neste consultório, ou
// seja: o PRIMEIRO atendimento dela em toda a base cai no mês pedido.
// (Definição do médico. Antes o app contava como "novo" qualquer atendimento
// de quem um dia tinha vindo do CRM — então um retorno de paciente antigo
// entrava como aquisição do mês e inflava CAC e ROI da verba de marketing.)
// Identidade por nome normalizado: é a única que existe hoje na coleção.
function _novosNoMes(pacs, mes) {
  const chave = p => (p.nome || '').toLowerCase().trim();
  const primeira = new Map(); // nome → data do 1º atendimento em toda a base
  for (const p of (pacs || [])) {
    const n = chave(p);
    if (!n || !p.data) continue;
    const atual = primeira.get(n);
    if (!atual || p.data < atual) primeira.set(n, p.data);
  }
  const atendimentos = (pacs || []).filter(p => {
    const n = chave(p);
    return n && p.data && getMes(p.data) === mes && getMes(primeira.get(n)) === mes;
  });
  return {
    atendimentos,
    quantidade: new Set(atendimentos.map(chave)).size,
    receita: atendimentos.reduce((s, p) => s + (p.valor || 0), 0),
  };
}

// Resumo financeiro PADRONIZADO — uma única definição p/ todas as telas (Receita,
// Dashboard, DRE, Relatório, PDF, Metas) baterem entre si. Distingue os DOIS
// regimes: CAIXA (o que já entrou) e COMPETÊNCIA (o que foi faturado/prestado).
// O status 'Parcial' (assinaturas com valor cheio, parcialmente pagas) entra em
// "a receber" — antes sumia de todo KPI de realizado/a-receber e ainda inflava o
// bruto, deixando "recebido + a receber + isento" sem fechar com o bruto.
function _resumoFin(pacs) {
  const soma = (f) => (pacs || []).filter(f).reduce((s, p) => s + (p.valor || 0), 0);
  const pago     = soma(p => p.statusPgto === 'Pago');
  const parcial  = soma(p => p.statusPgto === 'Parcial');
  const pendente = soma(p => p.statusPgto === 'Pendente');
  const isento   = soma(p => p.statusPgto === 'Isento');
  const bruto    = (pacs || []).reduce((s, p) => s + (p.valor || 0), 0);
  return {
    pago, parcial, pendente, isento, bruto,
    recebido: pago,                       // CAIXA: só o que entrou de fato
    aReceber: parcial + pendente,         // ainda a receber (inclui o resto do parcial)
    faturado: pago + parcial + pendente,  // COMPETÊNCIA: serviço prestado (= bruto − isento)
  };
}

// Lucro nos dois regimes, a partir do resumo + total de despesas do período.
function _lucroFin(resumo, totalDesp) {
  const caixa       = resumo.recebido - totalDesp;
  const competencia = resumo.faturado - totalDesp;
  return {
    caixa, competencia,
    margemCaixa:       resumo.recebido ? (caixa / resumo.recebido) * 100 : 0,
    margemCompetencia: resumo.faturado ? (competencia / resumo.faturado) * 100 : 0,
  };
}

// Se a data cair em sábado (6) ou domingo (0), empurra para a próxima segunda
function proximoDiaUtil(d) {
  const dt = new Date(d);
  const dow = dt.getDay();
  if (dow === 6) dt.setDate(dt.getDate() + 2); // sáb → seg
  else if (dow === 0) dt.setDate(dt.getDate() + 1); // dom → seg
  return dt;
}

function statusBadge(s) {
  if (!s || s === 'null' || s === 'undefined') s = 'Contato feito';
  const map = {
    'Marcou': 'badge-green', 'Atendeu': 'badge-blue', 'Em negociação': 'badge-yellow',
    'Não marcou': 'badge-red', 'Contato feito': 'badge-gray',
    'Pago': 'badge-green', 'Pendente': 'badge-yellow', 'Isento': 'badge-gray',
    'Ativo': 'badge-green', 'Inativo': 'badge-gray',
    'Feito': 'badge-green',
  };
  return `<span class="badge ${map[s] || 'badge-gray'}">${s}</span>`;
}

// Dropdown inline de status para o CRM (sem abrir modal)
function statusSelect(status, idx) {
  const val = (!status || status === 'null' || status === 'undefined') ? 'Contato feito' : status;
  const styles = {
    'Contato feito':  'background:#f1f5f9;color:#475569',
    'Em negociação':  'background:#fef3c7;color:#92400e',
    'Marcou':         'background:#d1fae5;color:#065f46',
    'Atendeu':        'background:#dbeafe;color:#1e40af',
    'Não marcou':     'background:#fee2e2;color:#991b1b',
  };
  const s = styles[val] || styles['Contato feito'];
  const opts = ['Contato feito','Em negociação','Marcou','Atendeu','Não marcou']
    .map(o => `<option value="${o}"${val===o?' selected':''}>${o}</option>`).join('');
  return `<select onchange="updateCrmStatus('${idx}',this.value)" style="${s};border:none;border-radius:999px;padding:3px 10px;font-size:11.5px;font-weight:600;cursor:pointer;outline:none;-webkit-appearance:none;appearance:none;text-align:center;">${opts}</select>`;
}

function updateCrmStatus(ref, newStatus) {
  const data = DB.get('crm');
  // ref: id estável (string) ou índice (número) — resolve por id no momento.
  const idx = (typeof ref === 'string') ? data.findIndex(x => x.id === ref) : ref;
  if (idx < 0 || !data[idx]) return;
  const oldStatus = data[idx].status;
  data[idx].status = newStatus;
  if (oldStatus !== newStatus) {
    data[idx]._statusSince = new Date().toISOString();
  }
  DB.set('crm', data);
  renderCrm();
  // Atualiza banner de integração se Atendidos estiver aberto
  if (document.getElementById('page-pacientes') && document.getElementById('page-pacientes').classList.contains('active')) renderPacientes();
  // Dispara efeitos do workflow (proposta de agendamento, atendimento, etc.)
  _aplicarEfeitosMudancaStatusCrm(idx, oldStatus, newStatus);
}

// Centraliza os efeitos colaterais de mudança de status de um contato CRM.
// Chamado tanto pelo dropdown da lista quanto pelo kanban (drag/drop e botão →).
function _aplicarEfeitosMudancaStatusCrm(idx, oldStatus, newStatus) {
  if (oldStatus === newStatus) return;
  const data = DB.get('crm');
  const c = data[idx];
  if (!c) return;

  // "Marcou" → propõe criar agendamento, SE não tem agendamento futuro vinculado
  if (newStatus === 'Marcou') {
    const today = _ymd(new Date());
    // Vínculo por ID estável primeiro; o índice congelado (crmIdx) apodrece
    // quando a lista é reordenada/apagada e apontava pro contato ERRADO.
    const jaTemAg = DB.get('agendamentos').some(a =>
      (c.id && a.crmId === c.id) ||
      ((a.pacienteNome || '').toLowerCase().trim() === (c.nome || '').toLowerCase().trim() &&
       (a.data || '') >= today && a.status !== 'Cancelado')
    );
    if (jaTemAg) return; // não importuna se já agendado
    setTimeout(() => {
      if (confirm(`${c.nome} marcou consulta — deseja agendar na agenda agora?`)) {
        openNovoAgendamento({
          pacienteNome: c.nome,
          whatsapp: c.whatsapp,
          procedimento: c.tipo,
          crmIdx: idx,
          crmId: c.id,   // vínculo estável (índice pode reordenar durante o confirm)
        });
      }
    }, 100);
    return;
  }

  // "Atendeu" → propõe registrar atendimento em Atendidos
  if (newStatus === 'Atendeu' && !c.converted) {
    setTimeout(() => {
      if (confirm(`Marcar "${c.nome}" como Atendeu também cria o registro em Atendidos.\n\nRegistrar o atendimento agora?`)) {
        convertCrmToAtendido(idx);
      }
    }, 100);
    return;
  }

  // "Não marcou" → marca agendamentos futuros vinculados como Cancelado (se existirem)
  if (newStatus === 'Não marcou') {
    const ags = DB.get('agendamentos');
    const today = _ymd(new Date());
    // Cancela SÓ o que é comprovadamente deste contato: id estável ou nome.
    // (a.crmIdx congelado já cancelou agendamento de paciente errado.)
    const idsCancelar = ags.filter(a =>
      ((c.id && a.crmId === c.id) || (a.pacienteNome || '').toLowerCase().trim() === (c.nome || '').toLowerCase().trim()) &&
      (a.data || '') >= today &&
      a.status !== 'Compareceu' && a.status !== 'Cancelado'
    );
    if (idsCancelar.length > 0) {
      idsCancelar.forEach(a => { a.status = 'Cancelado'; });
      DB.set('agendamentos', ags);
      toast(`${idsCancelar.length} agendamento(s) cancelado(s)`);
      if (document.getElementById('page-agenda')?.classList.contains('active')) renderAgenda();
    }
  }
}

// Dropdown inline de status de pagamento (Atendidos)
function pgtoSelect(status, idx) {
  const val = (!status || status === 'null' || status === 'undefined') ? 'Pendente' : status;
  // 'Parcial' é gravado por toda inscrição parcelada em programa
  // (inscreverEmPrograma) e contado por _resumoFin. Sem ele na lista, nenhuma
  // <option> ficava selecionada, o <select> exibia a PRIMEIRA ("Pago") sobre a
  // pílula âmbar de pendente — e qualquer toque no dropdown gravava um status
  // real por cima, destruindo o 'Parcial' sem volta.
  const styles = {
    'Pago':     'background:#d1fae5;color:#065f46',
    'Parcial':  'background:#dbeafe;color:#1e40af',
    'Pendente': 'background:#fef3c7;color:#92400e',
    'Isento':   'background:#f1f5f9;color:#475569',
  };
  const s = styles[val] || styles['Pendente'];
  const opts = ['Pago','Parcial','Pendente','Isento']
    .map(o => `<option value="${o}"${val===o?' selected':''}>${o}</option>`).join('');
  return `<select onchange="updatePacStatus(${idx},this.value)" style="${s};border:none;border-radius:999px;padding:3px 10px;font-size:11.5px;font-weight:600;cursor:pointer;outline:none;-webkit-appearance:none;appearance:none;text-align:center;">${opts}</select>`;
}

function updatePacStatus(idx, newStatus) {
  const data = DB.get('pacientes');
  const entrada = data[idx];

  // Se estava "A receber" e agora vai ser "Pago", perguntar a forma real de pagamento
  if (newStatus === 'Pago' && entrada.pagamento === 'A receber') {
    openModalPagtoReal(idx, newStatus);
    return; // espera o modal confirmar
  }

  entrada.statusPgto = newStatus;
  DB.set('pacientes', data);

  // Toast de feedback
  const val = BRL(entrada.valor || 0);
  const labels = { 'Pago': '✅ Pago', 'Pendente': '🕐 Pendente', 'Isento': '🎁 Isento' };
  toast(`${labels[newStatus] || newStatus} · ${entrada.nome} · ${val}`);

  renderPacientes();
  renderDashboard();
  if (document.getElementById('page-receita')?.classList.contains('active')) renderReceita();
}

// Modal rápido para capturar forma de pagamento real quando "A receber" → "Pago"
function openModalPagtoReal(idx, newStatus) {
  document.getElementById('modal-pgto-real').style.display = 'flex';
  document.getElementById('modal-pgto-real').dataset.idx = idx;
  document.getElementById('modal-pgto-real').dataset.status = newStatus;
}

function confirmarPagtoReal(forma) {
  const modal = document.getElementById('modal-pgto-real');
  const idx    = parseInt(modal.dataset.idx);
  const newStatus = modal.dataset.status;
  modal.style.display = 'none';

  const data = DB.get('pacientes');
  data[idx].statusPgto = newStatus;
  if (forma) data[idx].pagamento = forma; // atualiza forma de pagamento real
  DB.set('pacientes', data);

  const val = BRL(data[idx].valor || 0);
  toast(`✅ Pago via ${forma || 'A receber'} · ${data[idx].nome} · ${val} registrado!`);

  renderPacientes();
  renderDashboard();
  if (document.getElementById('page-receita')?.classList.contains('active')) renderReceita();
}

// Detecta vínculos do registro a ser excluído
function _detectarVinculos(col, item) {
  const vinculos = [];
  if (col === 'pacientes') {
    const nome = (item.nome || '').toLowerCase().trim();
    const wa = (item.whatsapp || '').replace(/\D/g, '');
    // Inscrições em programa
    const inscr = DB.get('inscricoes').filter(i =>
      (i.pacienteNome || '').toLowerCase().trim() === nome ||
      (wa && (i.pacienteWhatsapp || '').replace(/\D/g, '') === wa)
    );
    if (inscr.length) vinculos.push(`${inscr.length} inscrição(ões) em programa de assinatura`);
    // Follow-ups
    const fus = DB.get('followup').filter(f => (f.nome || '').toLowerCase().trim() === nome);
    if (fus.length) vinculos.push(`${fus.length} follow-up(s) ativo(s)`);
    // Agendamentos futuros
    const today = _ymd(new Date());
    const ags = DB.get('agendamentos').filter(a =>
      (a.pacienteNome || '').toLowerCase().trim() === nome &&
      (a.data || '') >= today && a.status !== 'Compareceu' && a.status !== 'Faltou'
    );
    if (ags.length) vinculos.push(`${ags.length} agendamento(s) futuro(s)`);
    // Outras consultas do mesmo paciente
    const outras = DB.get('pacientes').filter((p, i) => i !== _vinculosIdx
      && (p.nome || '').toLowerCase().trim() === nome).length;
    if (outras > 0) vinculos.push(`${outras} outra(s) consulta(s) deste mesmo paciente`);
  } else if (col === 'crm') {
    const nome = (item.nome || '').toLowerCase().trim();
    if (item.converted) vinculos.push('marcado como "Atendeu" — já virou paciente');
    const pacs = DB.get('pacientes').filter(p => (p.nome || '').toLowerCase().trim() === nome);
    if (pacs.length) vinculos.push(`${pacs.length} consulta(s) registrada(s) para este contato`);
  }
  return vinculos;
}
let _vinculosIdx = null;

function deleteRow(col, ref) {
  const data = DB.get(col);
  // ref pode ser índice (número) OU id estável (string). CRM recebe inserções
  // via realtime que reordenam o array — resolver por id no MOMENTO da ação
  // evita apagar o contato ERRADO quando a lista mudou entre render e clique.
  const idx = (typeof ref === 'string') ? data.findIndex(x => x.id === ref) : ref;
  const item = data[idx];
  if (!item) return;
  _vinculosIdx = idx;
  const vinculos = _detectarVinculos(col, item);
  _vinculosIdx = null;

  // Se não tem vínculos: confirmação simples
  if (!vinculos.length) {
    if (!confirm(`Excluir "${item.nome || item.descricao || 'este registro'}"?`)) return;
  } else {
    // Confirmação dupla: lista vínculos e exige escrever a palavra "EXCLUIR"
    const lista = vinculos.map(v => '  • ' + v).join('\n');
    const msg = `⚠️ ATENÇÃO: Este registro tem vínculos importantes!\n\n"${item.nome}" possui:\n${lista}\n\nExcluir apaga só este registro — os vínculos continuam na base mas ficarão órfãos.\n\nPara confirmar, digite EXCLUIR:`;
    const resp = prompt(msg);
    if (resp !== 'EXCLUIR') {
      if (resp !== null) toast('Exclusão cancelada — texto não confere.', 2500);
      return;
    }
  }

  data.splice(idx, 1);
  DB.set(col, data);
  const renders = { crm: renderCrm, pacientes: renderPacientes, followup: renderFollowup, agenda: renderAgenda, despesas: renderDespesas };
  if (renders[col]) renders[col]();
  _auditLog('excluiu', col, `Excluiu ${col}: ${item.nome || item.descricao || '(sem nome)'}`);
  _toastUndo(`"${item.nome || item.descricao || 'Registro'}" excluído.`, () => {
    const atual = DB.get(col);
    atual.splice(Math.min(idx, atual.length), 0, item);
    DB.set(col, atual);
    if (renders[col]) renders[col]();
    _auditLog('restaurou', col, `Desfez exclusão de ${col}: ${item.nome || item.descricao || '(sem nome)'}`);
  });
}

function editRow(col, ref) {
  const data = DB.get(col);
  // ref: índice (número) OU id estável (string) — ver deleteRow. Resolver por id
  // impede editar o registro errado quando o array reordenou (lead via realtime).
  const idx = (typeof ref === 'string') ? data.findIndex(x => x.id === ref) : ref;
  const r = data[idx];
  if (!r) return;
  editState = { col, idx, id: r.id ?? null };

  const modalMap = { crm: 'modal-crm', pacientes: 'modal-paciente', followup: 'modal-followup', agenda: 'modal-agenda', despesas: 'modal-despesa' };
  const titleMap = { crm: 'Editar Contato', pacientes: 'Editar Consulta', followup: 'Editar Follow-Up', agenda: 'Editar Dia', despesas: 'Editar Despesa' };
  const modalId = modalMap[col];
  const modal = document.getElementById(modalId);
  const titleEl = modal.querySelector('.modal-title');
  if (titleEl) titleEl.textContent = titleMap[col];

  const form = modal.querySelector('form');

  if (col === 'crm') {
    form.data.value = r.data || '';
    form.hora.value = r.hora || '';
    form.nome.value = r.nome || '';
    form.whatsapp.value = r.whatsapp || '';
    form.idade.value = r.idade || '';
    form.canal.value = r.canal || '';
    form.tipo.value = r.tipo || '';
    form.status.value = r.status || '';
    _popularProfissionalSelect(r.profissionalId, 'crm-profissional', true);
    form.obs.value = r.obs || '';
  } else if (col === 'pacientes') {
    popularProcedimentoSelect();
    // Se o tipo registrado não está mais no catálogo, adiciona como opção legada para não perder
    const procs = getProcedimentos();
    if (r.tipo && !procs.some(p => p.nome === r.tipo)) {
      const sel = document.getElementById('pac-procedimento');
      if (sel) sel.insertAdjacentHTML('beforeend', `<option value="${_esc(r.tipo)}">${_esc(r.tipo)} (legado)</option>`);
    }
    form.data.value = r.data || '';
    form.tipo.value = r.tipo || '';
    form.nome.value = r.nome || '';
    if (form.whatsapp) form.whatsapp.value = r.whatsapp || '';
    _popularProfissionalSelect(r.profissionalId, 'pac-profissional');
    form.valor.value = r.valor || '';
    form.pagamento.value = r.pagamento || '';
    form.statusPgto.value = r.statusPgto || '';
    form.obs.value = r.obs || '';
    atualizarValorSugerido();
  } else if (col === 'followup') {
    form.nome.value = r.nome || '';
    if (form.whatsapp) form.whatsapp.value = r.whatsapp || '';
    form.ultConsulta.value = r.ultConsulta || '';
    form.dataContato.value = r.dataContato || '';
    form.tipoContato.value = r.tipoContato || '';
    form.dataReav.value = r.dataReav || '';
    form.obs.value = r.obs || '';
  } else if (col === 'agenda') {
    form.data.value = r.data || '';
    form.vagas.value = r.vagas || '';
    form.ocupadas.value = r.ocupadas || '';
    form.noshow.value = r.noshow || '';
    form.receita.value = r.receita || '';
    form.obs.value = r.obs || '';
  } else if (col === 'despesas') {
    form.data.value = r.data || '';
    form.categoria.value = r.categoria || '';
    form.descricao.value = r.descricao || '';
    form.tipo.value = r.tipo || '';
    form.valor.value = r.valor || '';
    form.formaPgto.value = r.formaPgto || '';
  }

  modal.style.display = 'flex';
}

function filterTable(col, val) {
  const rows = document.querySelectorAll(`#${col}-tbody tr[data-search]`);
  rows.forEach(row => {
    const text = row.getAttribute('data-search').toLowerCase();
    row.style.display = text.includes(val.toLowerCase()) ? '' : 'none';
  });
}

function destroyChart(id) {
  if (charts[id]) { charts[id].destroy(); delete charts[id]; }
}

// ====================== CRM ======================
function saveCrm(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const item = { data: fd.get('data'), hora: fd.get('hora'), nome: fd.get('nome'), whatsapp: fd.get('whatsapp'), idade: fd.get('idade'), canal: fd.get('canal'), tipo: fd.get('tipo'), status: fd.get('status'), obs: fd.get('obs'), profissionalId: fd.get('profissionalId') || null };
  const data = DB.get('crm');
  // Bloqueia duplicata por WhatsApp (normalizado — com ou sem DDI 55)
  const cleanPhone = _normPhone(item.whatsapp);
  // Resolve o alvo da edição por ID no momento do save (não pelo índice
  // congelado ao abrir o modal): se um lead chegou via realtime nesse meio-tempo,
  // o índice antigo apontaria pro contato errado.
  const editIdx = (editState.col === 'crm')
    ? (editState.id ? data.findIndex(c => c.id === editState.id) : (editState.idx ?? -1))
    : -1;
  if (cleanPhone) {
    const dupIdx = data.findIndex((c, i) => i !== editIdx && c.whatsapp && _normPhone(c.whatsapp) === cleanPhone);
    if (dupIdx >= 0) {
      const dupNome = data[dupIdx].nome || '(sem nome)';
      if (!confirm(`Já existe um contato com este WhatsApp: "${dupNome}".\n\nDeseja criar mesmo assim?`)) return;
    }
  }
  item.id = (editIdx >= 0 && data[editIdx] && data[editIdx].id) || _novoId('crm'); // id estável (Fase 1)
  if (editIdx >= 0) { data[editIdx] = item; } else { data.unshift(item); }
  DB.set('crm', data);
  closeModal('modal-crm');
  renderCrm();
}

function filterCrmStatus(val) {
  // Delegated to unified filterCrmAll
  filterCrmAll();
}

function renderCrm() {
  // Normaliza registros antigos com status null/undefined
  let data = DB.get('crm');
  let changed = false;
  data = data.map(r => {
    let nr = r;
    // Garante id estável em TODA linha — as ações (editar/excluir/status/chat)
    // resolvem por id, não por índice (que apodrece com lead via realtime).
    if (!nr.id) { nr = { ...nr, id: _novoId('crm') }; changed = true; }
    if (!nr.status || nr.status === 'null' || nr.status === 'undefined') {
      nr = { ...nr, status: 'Contato feito' }; changed = true;
    }
    return nr;
  });
  if (changed) DB.set('crm', data);

  const tbody = document.getElementById('crm-tbody');
  if (!data.length) {
    if (tbody) tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#94a3b8;padding:48px;">Nenhum contato registrado. <button class="btn-primary" style="margin-left:12px;" onclick="openModal(\'modal-crm\')">+ Novo</button></td></tr>';
    _atualizarFunilCrm([]);
    return;
  }

  if (tbody) {
    // Ordena desc por data + hora antes de paginar
    const sorted = data.map((r, originalIdx) => ({ ...r, _origIdx: originalIdx }))
                       .sort((a,b) => ((b.data||'') + (b.hora||'')).localeCompare((a.data||'') + (a.hora||'')));
    const info = _paginate('crm', sorted);
    tbody.innerHTML = info.slice.map(r => {
      const i = r._origIdx;
      return `
      <tr data-search="${_esc(r.nome)} ${_esc(r.canal||'')} ${_esc(r.status||'')} ${_esc(r.tipo||'')}" data-status="${_esc(r.status)}">
        <td>${formatDate(r.data)}</td>
        <td style="font-weight:600;color:#0f172a;">${_esc(r.nome)}</td>
        <td>${r.whatsapp ? (_waConnected()
          ? `<button onclick="openCrmChat('${r.id}')" style="background:none;border:none;cursor:pointer;color:#10b981;font-weight:600;font-size:13px;padding:0;font-family:'Inter',sans-serif;">💬 ${_esc(r.whatsapp)}</button>`
          : `<a href="https://wa.me/55${_normPhone(r.whatsapp)}" target="_blank" style="color:#10b981;font-weight:600;text-decoration:none;">💬 ${_esc(r.whatsapp)}</a>`) : '—'}</td>
        <td style="color:#475569;">${_esc(r.canal||'—')}</td>
        <td style="color:#475569;">${_esc(r.tipo||'—')}</td>
        <td>${statusSelect(r.status, r.id)}</td>
        <td style="white-space:nowrap;">
          <button onclick="editRow('crm','${r.id}')" title="Editar" style="background:none;border:none;cursor:pointer;font-size:14px;padding:2px 4px;">✏️</button>
          <button onclick="deleteRow('crm','${r.id}')" title="Excluir" style="background:none;border:none;cursor:pointer;font-size:14px;padding:2px 4px;">🗑️</button>
        </td>
      </tr>`;
    }).join('');
    // Paginador
    const pgEl = document.getElementById('crm-paginator');
    if (pgEl) pgEl.innerHTML = _paginatorHtml('crm', info);
  }

  _atualizarFunilCrm(data);

  // Restaura view preferida (kanban ou lista)
  const savedView = DB.getObj('crm_view', 'lista');
  setCrmView(savedView);

  // Restaura preferência do funil colapsado, se o usuário escolheu manualmente
  const userForced = localStorage.getItem('consult_funil_collapsed_userset');
  if (userForced) {
    aplicarFunilCollapse(localStorage.getItem('consult_funil_collapsed') === '1');
  }
}

// ====================== CRM KANBAN ======================
const KANBAN_COLUNAS = [
  { status: 'Contato feito', label: '📞 Contato feito', cor: '#3b82f6', headerBg: '#dbeafe' },
  { status: 'Em negociação', label: '💬 Em negociação',  cor: '#8b5cf6', headerBg: '#ede9fe' },
  { status: 'Marcou',        label: '📅 Marcou',          cor: '#f59e0b', headerBg: '#fef3c7' },
  { status: 'Atendeu',       label: '✅ Atendeu',         cor: '#10b981', headerBg: '#d1fae5' },
  { status: 'Não marcou',    label: '❌ Não marcou',       cor: '#94a3b8', headerBg: '#f1f5f9' },
];

let _crmKanbanFiltro = '';
let _kanbanDragIdx   = null;

let _kanbanTimerInterval = null;
function setCrmView(view) {
  const lista  = document.getElementById('crm-lista-view');
  const kanban = document.getElementById('crm-kanban-view');
  const tabL   = document.getElementById('crm-tab-lista');
  const tabK   = document.getElementById('crm-tab-kanban');
  if (!lista || !kanban) return;
  lista.style.display  = view === 'lista'  ? '' : 'none';
  kanban.style.display = view === 'kanban' ? 'block' : 'none';
  if (tabL) tabL.classList.toggle('active', view === 'lista');
  if (tabK) tabK.classList.toggle('active', view === 'kanban');
  if (view === 'kanban') {
    renderKanban(_crmKanbanFiltro);
    // Auto-atualiza cronômetros a cada 60s enquanto o kanban estiver visível
    if (_kanbanTimerInterval) clearInterval(_kanbanTimerInterval);
    _kanbanTimerInterval = setInterval(() => {
      const kbView = document.getElementById('crm-kanban-view');
      if (kbView && kbView.style.display !== 'none' && document.getElementById('page-crm')?.classList.contains('active')) {
        renderKanban(_crmKanbanFiltro);
      } else {
        clearInterval(_kanbanTimerInterval);
        _kanbanTimerInterval = null;
      }
    }, 60000);
  } else {
    if (_kanbanTimerInterval) { clearInterval(_kanbanTimerInterval); _kanbanTimerInterval = null; }
  }
  DB.setObj('crm_view', view);
  // Sincroniza estado do funil — auto-colapsa em kanban, expande em lista
  // (a menos que o usuário tenha forçado um estado)
  const userForced = localStorage.getItem('consult_funil_collapsed_userset');
  if (!userForced) {
    aplicarFunilCollapse(view === 'kanban');
  }
}

function toggleFunilCrm() {
  const body = document.getElementById('funil-body');
  if (!body) return;
  const isCollapsed = body.style.display === 'none';
  aplicarFunilCollapse(!isCollapsed);
  localStorage.setItem('consult_funil_collapsed', !isCollapsed ? '1' : '0');
  localStorage.setItem('consult_funil_collapsed_userset', '1');
}

function aplicarFunilCollapse(collapse) {
  const body = document.getElementById('funil-body');
  const chev = document.getElementById('funil-chevron');
  const card = document.getElementById('funil-card');
  const sub  = document.getElementById('funil-subtitle');
  if (!body) return;
  if (collapse) {
    body.style.display = 'none';
    if (chev) chev.style.transform = 'rotate(-90deg)';
    if (card) card.style.padding = '14px 24px';
    if (sub)  sub.textContent = 'Clique para expandir';
  } else {
    body.style.display = '';
    if (chev) chev.style.transform = 'rotate(0deg)';
    if (card) card.style.padding = '14px 24px';
    if (sub)  sub.textContent = 'Da prospecção ao atendimento — taxas entre cada etapa';
  }
}

function filterCrmAll(val) {
  // Store current search value
  if (val !== undefined) _crmKanbanFiltro = val;
  const searchVal  = _crmKanbanFiltro || '';
  const statusVal  = (document.getElementById('crm-status-filter') || {}).value || '';
  const kanbanView = (document.getElementById('crm-kanban-view') || {}).style?.display !== 'none';

  if (kanbanView) {
    renderKanban(searchVal);
  } else {
    // Filter lista rows
    const rows = document.querySelectorAll('#crm-tbody tr[data-search]');
    rows.forEach(row => {
      const text   = (row.getAttribute('data-search') || '').toLowerCase();
      const status = row.getAttribute('data-status') || '';
      const matchText   = !searchVal  || text.includes(searchVal.toLowerCase());
      const matchStatus = !statusVal  || status === statusVal;
      row.style.display = matchText && matchStatus ? '' : 'none';
    });
  }
}

function renderKanban(filtro) {
  if (filtro !== undefined) _crmKanbanFiltro = filtro;
  const container = document.getElementById('crm-kanban-view');
  if (!container) return;

  let data           = DB.get('crm');
  // Garante id estável em toda linha (idem renderCrm) — as ações do kanban
  // resolvem por id, não por índice (que reordena com lead via realtime).
  if (data.some(r => !r.id)) {
    data = data.map(r => r.id ? r : { ...r, id: _novoId('crm') });
    DB.set('crm', data);
  }
  const termo        = (_crmKanbanFiltro || '').toLowerCase().trim();
  const statusFiltro = (document.getElementById('crm-status-filter') || {}).value || '';

  const colsHtml = KANBAN_COLUNAS.map(col => {
    const cards = data
      .map((r, i) => ({ ...r, _idx: i }))
      .filter(r => r.status === col.status)
      .filter(r => !termo || (r.nome + ' ' + (r.canal||'') + ' ' + (r.tipo||'')).toLowerCase().includes(termo))
      .filter(r => !statusFiltro || r.status === statusFiltro);

    return `
      <div class="kanban-col" style="border-top-color:${col.cor};"
           ondragover="event.preventDefault();this.classList.add('kanban-drop-target')"
           ondragleave="this.classList.remove('kanban-drop-target')"
           ondrop="_kanbanDrop(event,'${col.status.replace(/'/g,"\\'")}',this)">

        <div style="padding:11px 14px;display:flex;align-items:center;justify-content:space-between;background:${col.headerBg};border-bottom:1px solid rgba(0,0,0,0.07);">
          <span style="font-size:12.5px;font-weight:700;color:#0f172a;">${col.label}</span>
          <span style="font-size:11px;font-weight:700;background:${col.cor}22;color:${col.cor};padding:2px 9px;border-radius:999px;">${cards.length}</span>
        </div>

        <div class="kanban-col-body">
          ${cards.length === 0
            ? `<div style="text-align:center;padding:28px 10px;color:#94a3b8;font-size:12px;">Sem contatos</div>`
            : cards.map(r => _kanbanCardHtml(r, col)).join('')}
        </div>

        ${col.status === 'Contato feito' ? `
          <div style="padding:8px 10px;border-top:1px solid #e2e8f0;">
            <button onclick="openModal('modal-crm')"
              style="width:100%;background:transparent;border:1px dashed #cbd5e1;border-radius:8px;padding:7px;font-size:12px;color:#94a3b8;cursor:pointer;font-family:'Inter',sans-serif;transition:all 0.15s;"
              onmouseover="this.style.borderColor='#10b981';this.style.color='#10b981'"
              onmouseout="this.style.borderColor='#cbd5e1';this.style.color='#94a3b8'">
              + Novo contato
            </button>
          </div>` : ''}
      </div>`;
  }).join('');

  const dotsHtml = KANBAN_COLUNAS.map((col, i) =>
    `<div class="kanban-dot${i === 0 ? ' active' : ''}" onclick="_kanbanScrollTo(${i})" title="${col.label}"></div>`
  ).join('');

  container.innerHTML = `
    <div class="kanban-wrap">
      <div class="kanban-fade-l hidden" id="kanban-fade-l"></div>
      <div class="kanban-fade-r hidden" id="kanban-fade-r"></div>
      <button class="kanban-arrow kanban-arrow-left hidden" id="kanban-arr-left"  onclick="_kanbanNav(-1)">&#8249;</button>
      <div class="kanban-board" id="kanban-board-scroll" onscroll="_kanbanOnScroll()">
        ${colsHtml}
      </div>
      <button class="kanban-arrow kanban-arrow-right hidden" id="kanban-arr-right" onclick="_kanbanNav(1)">&#8250;</button>
      <div class="kanban-dots" id="kanban-dots" style="display:none;">${dotsHtml}</div>
    </div>`;

  // Calcula estado inicial das setas após o browser ter feito o layout
  requestAnimationFrame(() => requestAnimationFrame(_kanbanOnScroll));
}

/* ── Retorna largura real de uma coluna + gap ── */
function _kanbanColW() {
  const board = document.getElementById('kanban-board-scroll');
  if (!board) return 208;
  const col = board.querySelector('.kanban-col');
  return col ? col.offsetWidth + 13 : 208;
}

function _kanbanNav(dir) {
  const board = document.getElementById('kanban-board-scroll');
  if (!board) return;
  board.scrollBy({ left: dir * _kanbanColW(), behavior: 'smooth' });
}

function _kanbanScrollTo(idx) {
  const board = document.getElementById('kanban-board-scroll');
  if (!board) return;
  board.scrollTo({ left: idx * _kanbanColW(), behavior: 'smooth' });
}

function _kanbanOnScroll() {
  const board = document.getElementById('kanban-board-scroll');
  if (!board) return;
  const sl        = board.scrollLeft;
  const maxScroll = board.scrollWidth - board.clientWidth;
  const hasScroll = maxScroll > 8;

  // Elementos de UI
  const leftArr  = document.getElementById('kanban-arr-left');
  const rightArr = document.getElementById('kanban-arr-right');
  const fadeL    = document.getElementById('kanban-fade-l');
  const fadeR    = document.getElementById('kanban-fade-r');
  const dotsEl   = document.getElementById('kanban-dots');

  if (!hasScroll) {
    // Tela larga o suficiente: sem scroll → esconde tudo
    if (leftArr)  leftArr.classList.add('hidden');
    if (rightArr) rightArr.classList.add('hidden');
    if (fadeL)    fadeL.classList.add('hidden');
    if (fadeR)    fadeR.classList.add('hidden');
    if (dotsEl)   dotsEl.style.display = 'none';
    return;
  }

  // Há scroll — mostra controles conforme posição
  if (dotsEl) dotsEl.style.display = '';

  const atStart = sl < 8;
  const atEnd   = sl >= maxScroll - 8;

  if (leftArr)  leftArr.classList.toggle('hidden',  atStart);
  if (rightArr) rightArr.classList.toggle('hidden',  atEnd);
  if (fadeL)    fadeL.classList.toggle('hidden',  atStart);
  if (fadeR)    fadeR.classList.toggle('hidden',  atEnd);

  // Atualiza dot ativo
  const idx = Math.round(sl / _kanbanColW());
  document.querySelectorAll('.kanban-dot').forEach((d, i) =>
    d.classList.toggle('active', i === idx)
  );
}

// Renderiza badge com tempo na coluna atual
// Fallback inteligente: se nunca foi movido (_statusSince ausente), usa r.data como base
// para não mostrar "0s" em contatos antigos do legacy.
function _kanbanTempoColuna(r, col) {
  const desde = r._statusSince || (r.data ? r.data + 'T' + (r.hora || '12:00') : null);
  if (!desde) return '';
  const ms = Date.now() - new Date(desde).getTime();
  if (ms < 0) return '';
  const min = Math.floor(ms / 60000);
  const h   = Math.floor(min / 60);
  const d   = Math.floor(h / 24);
  let label, cor, bg;
  if (d >= 1) {
    label = d === 1 ? '1 dia' : `${d} dias`;
  } else if (h >= 1) {
    label = h === 1 ? '1h' : `${h}h`;
  } else if (min >= 1) {
    label = `${min} min`;
  } else {
    label = 'agora';
  }
  // Limiares de alerta — variam por coluna (lead frio vs. atendido)
  const limiteAmarelo = col.status === 'Contato feito' ? 1 : col.status === 'Em negociação' ? 2 : 3;
  const limiteVermelho = col.status === 'Contato feito' ? 3 : col.status === 'Em negociação' ? 5 : 7;
  if (d >= limiteVermelho) { cor = '#991b1b'; bg = '#fee2e2'; }
  else if (d >= limiteAmarelo) { cor = '#92400e'; bg = '#fef3c7'; }
  else { cor = '#1e40af'; bg = '#dbeafe'; }
  // Tooltip com data/hora completa
  const ts = new Date(desde).toLocaleString('pt-BR', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' });
  return `<div title="Está nesta coluna desde ${ts}" style="display:inline-flex;align-items:center;gap:4px;background:${bg};color:${cor};font-size:10.5px;font-weight:700;padding:2px 8px;border-radius:999px;margin-bottom:8px;">
    ⏱ ${label}
  </div>`;
}

function _kanbanCardHtml(r, col) {
  const idx      = r._idx;
  const colIdx   = KANBAN_COLUNAS.findIndex(c => c.status === r.status);
  const nextCol  = KANBAN_COLUNAS[colIdx + 1];
  const badge    = _canalBadge(r.canal);
  const dias     = _diasDesde(r.data);
  const _zapiOn = _waConnected();
  const _prof   = r.profissionalId ? getProfissional(r.profissionalId) : null;
  const whatsBtn = r.whatsapp
    ? (_zapiOn
        ? `<button onclick="openCrmChat('${r.id}')"
              style="display:inline-flex;align-items:center;gap:5px;font-size:11.5px;color:#10b981;font-weight:600;
                     background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;padding:4px 9px;
                     cursor:pointer;margin-bottom:9px;font-family:'Inter',sans-serif;">
              💬 ${_esc(r.whatsapp)}
           </button>`
        : `<a href="https://wa.me/55${_normPhone(r.whatsapp)}" target="_blank"
              style="display:inline-flex;align-items:center;gap:5px;font-size:11.5px;color:#10b981;font-weight:600;
                     background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;padding:4px 9px;
                     text-decoration:none;margin-bottom:9px;">
              💬 ${_esc(r.whatsapp)}
           </a>`)
    : '';

  const nextLabel = nextCol ? nextCol.label.replace(/^[^\s]+\s/, '') : ''; // strip emoji

  return `
    <div class="kanban-card"
         draggable="true"
         ondragstart="_kanbanDragStart(event,'${r.id}')"
         ondragend="document.querySelectorAll('.kanban-card').forEach(c=>c.classList.remove('kanban-dragging'))">

      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:6px;margin-bottom:6px;">
        <div style="font-size:13px;font-weight:700;color:#0f172a;line-height:1.3;">${_esc(r.nome)}</div>
        ${badge}
      </div>

      ${(r.tipo && r.tipo.trim().toLowerCase() !== col.status.toLowerCase())
          ? `<div style="font-size:11.5px;color:#475569;margin-bottom:2px;">${_esc(r.tipo)}</div>`
          : ''}
      <div style="font-size:11px;color:#94a3b8;margin-bottom:6px;">
        ${formatDate(r.data)} · <span style="font-weight:600;color:${dias.cor};">${dias.texto}</span>
      </div>
      ${_prof ? `<div style="margin-bottom:6px;"><span style="display:inline-flex;align-items:center;gap:4px;background:${_prof.cor}1a;color:${_prof.cor};border-radius:999px;padding:1px 9px;font-size:10.5px;font-weight:700;"><span style="width:7px;height:7px;border-radius:50%;background:${_prof.cor};"></span>${_esc(_prof.nome)}</span></div>` : ''}
      ${_kanbanTempoColuna(r, col)}
      ${whatsBtn}

      <div style="border-top:1px solid #f1f5f9;padding-top:8px;">

        <!-- Linha 1: botão de avançar (largura total) -->
        ${nextCol ? `
          <button onclick="moverKanbanCard('${r.id}','${nextCol.status.replace(/'/g,"\\'")}',event)"
            style="width:100%;background:${col.cor}18;color:${col.cor};border:1px solid ${col.cor}35;border-radius:6px;padding:5px 8px;font-size:11.5px;font-weight:700;cursor:pointer;font-family:'Inter',sans-serif;margin-bottom:6px;transition:background 0.15s;text-align:center;"
            onmouseover="this.style.background='${col.cor}30'"
            onmouseout="this.style.background='${col.cor}18'">
            → ${nextLabel}
          </button>`
        : `<div style="font-size:11px;color:#10b981;font-weight:700;margin-bottom:6px;">✅ Concluído</div>`}

        <!-- Linha 2: ações secundárias -->
        <div style="display:flex;align-items:center;gap:5px;justify-content:flex-end;">
          ${r.status === 'Marcou' ? `
            <button onclick="convertCrmToAtendidoKanban('${r.id}',event)"
              title="Registrar atendimento"
              style="background:#f0fdf4;color:#166534;border:1px solid #bbf7d0;border-radius:6px;padding:4px 9px;font-size:11px;font-weight:700;cursor:pointer;font-family:'Inter',sans-serif;">
              ✓ Atendeu
            </button>` : ''}

          <button onclick="editRow('crm','${r.id}')" title="Editar"
            style="background:#f8fafc;color:#64748b;border:1px solid #e2e8f0;border-radius:6px;padding:4px 7px;font-size:11px;cursor:pointer;">✏️</button>

          <button onclick="deleteRow('crm','${r.id}')" title="Excluir"
            style="background:#fff1f2;color:#dc2626;border:1px solid #fecdd3;border-radius:6px;padding:4px 7px;font-size:11px;cursor:pointer;">🗑️</button>
        </div>
      </div>
    </div>`;
}

function _canalBadge(canal) {
  const map = {
    'Indicação médica':   '#eff6ff:#1d4ed8',
    'Indicação paciente': '#f0fdf4:#15803d',
    'Google':             '#fff7ed:#c2410c',
    'Instagram':          '#fdf4ff:#7e22ce',
    'WhatsApp':           '#f0fdf4:#15803d',
    'Doctoralia':         '#eff6ff:#1e40af',
    'Outros':             '#f8fafc:#475569',
  };
  const [bg, color] = (map[canal] || '#f8fafc:#475569').split(':');
  const short = (canal || '').replace('Indicação ','Ind. ');
  return `<span style="font-size:10px;font-weight:700;background:${bg};color:${color};padding:2px 7px;border-radius:4px;white-space:nowrap;flex-shrink:0;">${short}</span>`;
}

function _diasDesde(dataStr) {
  // 'YYYY-MM-DD' sem hora é lido pelo JS como meia-noite UTC. Comparar isso com
  // Date.now() (que é hora local) somava o fuso à conta: em UTC-3, a partir das
  // 21:00 todo card ganhava um dia inteiro — contato feito à noite já aparecia
  // como "1d", e os limiares de cor (verde/amarelo/vermelho) andavam junto.
  // Ancorar os DOIS lados ao meio-dia local faz a conta cair sempre no dia certo.
  const d = new Date(String(dataStr || '').slice(0, 10) + 'T12:00:00');
  if (isNaN(d.getTime())) return { texto: '—', cor: '#94a3b8' };
  const hoje = new Date(); hoje.setHours(12, 0, 0, 0);
  const diff = Math.round((hoje - d) / 86400000);
  if (diff <= 0) return { texto: 'hoje',        cor: '#10b981' };
  if (diff <= 3) return { texto: `${diff}d`,     cor: '#10b981' };
  if (diff <= 14)return { texto: `${diff}d`,     cor: '#f59e0b' };
  return           { texto: `${diff}d atrás`,    cor: '#ef4444' };
}

function moverKanbanCard(ref, novoStatus, evt) {
  if (evt) evt.stopPropagation();
  const data = DB.get('crm');
  // ref: id estável (string) ou índice (número) — resolve por id no momento
  // da ação (o array pode ter reordenado por um lead via realtime/drag).
  const idx = (typeof ref === 'string') ? data.findIndex(x => x.id === ref) : ref;
  if (idx < 0 || !data[idx]) return;
  const statusAnterior = data[idx].status;
  data[idx].status = novoStatus;
  // Registra o momento da mudança para o cronômetro
  if (statusAnterior !== novoStatus) {
    data[idx]._statusSince = new Date().toISOString();
  }
  DB.set('crm', data);
  const labelMap = {
    'Em negociação': '💬', 'Marcou': '📅', 'Atendeu': '✅', 'Não marcou': '❌', 'Contato feito': '📞'
  };
  toast(`${labelMap[novoStatus] || ''} ${novoStatus} · ${data[idx].nome}`);
  renderKanban();
  // Atualiza funil no topo
  _atualizarFunilCrm(data);
  // Dispara efeitos do workflow (mesma lógica que o dropdown da lista)
  _aplicarEfeitosMudancaStatusCrm(idx, statusAnterior, novoStatus);
}

function _atualizarFunilCrm(data) {
  if (!data) data = DB.get('crm');
  // Etapas inclusivas (downstream): cada nível inclui os de baixo
  const total = data.length;
  const negoc = data.filter(r => ['Em negociação','Marcou','Atendeu'].includes(r.status)).length;
  const marc  = data.filter(r => ['Marcou','Atendeu'].includes(r.status)).length;
  const atend = data.filter(r => r.status === 'Atendeu').length;

  // Card resumo
  const convEl = document.getElementById('funil-conv');
  if (convEl) convEl.textContent = total ? PCT((atend / total) * 100) : '0%';

  // Funil visual
  const bars = document.getElementById('funil-bars');
  if (!bars) return;
  if (!total) {
    bars.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-muted);font-size:13px;">Cadastre contatos pra ver o funil em ação.</div>';
    return;
  }
  const etapas = [
    { label: 'Contato feito',   valor: total, cor: '#3b82f6', bg:'#dbeafe' },
    { label: 'Em negociação',   valor: negoc, cor: '#8b5cf6', bg:'#ede9fe' },
    { label: 'Marcou consulta', valor: marc,  cor: '#f59e0b', bg:'#fef3c7' },
    { label: 'Atendeu',         valor: atend, cor: '#10b981', bg:'#d1fae5' },
  ];
  bars.innerHTML = etapas.map((e, i) => {
    const pct = total ? (e.valor / total) * 100 : 0;
    const widthBar = total ? (e.valor / total) * 100 : 0;
    let conversao = '';
    if (i > 0 && etapas[i-1].valor > 0) {
      const taxa = (e.valor / etapas[i-1].valor) * 100;
      conversao = `<span style="font-size:10.5px;color:${taxa >= 50 ? '#10b981' : taxa >= 25 ? '#f59e0b' : '#dc2626'};font-weight:700;margin-left:8px;">↓ ${taxa.toFixed(0)}% passou</span>`;
    }
    return `
      <div>
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">
          <div style="display:flex;align-items:center;gap:8px;">
            <span style="font-size:12.5px;font-weight:600;color:var(--text-primary);">${e.label}</span>
            ${conversao}
          </div>
          <div style="display:flex;align-items:baseline;gap:6px;">
            <span style="font-size:17px;font-weight:800;color:${e.cor};">${e.valor}</span>
            <span style="font-size:11px;color:var(--text-muted);font-weight:600;">${pct.toFixed(0)}%</span>
          </div>
        </div>
        <div style="height:10px;background:var(--border-light);border-radius:999px;overflow:hidden;">
          <div style="height:100%;width:${widthBar}%;background:${e.cor};border-radius:999px;transition:width 0.5s ease;box-shadow:0 0 0 1px ${e.bg} inset;"></div>
        </div>
      </div>`;
  }).join('');
}

function convertCrmToAtendidoKanban(ref, evt) {
  if (evt) evt.stopPropagation();
  moverKanbanCard(ref, 'Atendeu');
  // trigger the same convert modal/action — passa o id (resolvido na hora),
  // pra não registrar atendimento do contato ERRADO depois dos 80ms.
  setTimeout(() => convertCrmToAtendido(ref), 80);
}

function _kanbanDragStart(evt, ref) {
  _kanbanDragIdx = ref; // id estável (não índice) — ver _kanbanDrop
  evt.target.classList.add('kanban-dragging');
  evt.dataTransfer.effectAllowed = 'move';
}

function _kanbanDrop(evt, novoStatus, colEl) {
  evt.preventDefault();
  colEl.classList.remove('kanban-drop-target');
  if (_kanbanDragIdx === null) return;
  const data = DB.get('crm');
  const idx = (typeof _kanbanDragIdx === 'string')
    ? data.findIndex(x => x.id === _kanbanDragIdx) : _kanbanDragIdx;
  if (idx >= 0 && data[idx] && data[idx].status !== novoStatus) {
    moverKanbanCard(_kanbanDragIdx, novoStatus);
  }
  _kanbanDragIdx = null;
}

// ====================== INTEGRAÇÃO CRM → ATENDIDOS ======================
function renderCrmPendentesAtendidos() {
  let crm = DB.get('crm');
  // Garante id estável (as ações resolvem por id) mesmo se esta página abrir
  // antes de renderCrm/renderKanban.
  if (crm.some(r => !r.id)) {
    crm = crm.map(r => r.id ? r : { ...r, id: _novoId('crm') });
    DB.set('crm', crm);
  }
  const pendentes = crm.map((c, i) => ({ ...c, _idx: i })).filter(c => (c.status === 'Marcou' || c.status === 'Atendeu') && !c.converted);
  const container = document.getElementById('crm-pendentes-atendidos');
  if (!container) return;
  if (!pendentes.length) { container.innerHTML = ''; return; }

  container.innerHTML = `
    <div style="background:#f0fdf4;border:1.5px solid #86efac;border-radius:12px;padding:16px 20px;margin-bottom:20px;">
      <div style="font-weight:700;color:#15803d;margin-bottom:12px;display:flex;align-items:center;gap:8px;">
        <span style="font-size:18px;">📋</span>
        <span>${pendentes.length} paciente(s) com consulta marcada no CRM — registre o atendimento</span>
      </div>
      <div style="display:flex;flex-direction:column;gap:8px;">
        ${pendentes.map(c => `
          <div style="display:flex;align-items:center;justify-content:space-between;background:#fff;border-radius:8px;padding:10px 14px;border:1px solid #d1fae5;">
            <div>
              <span style="font-weight:600;color:#0f172a;">${_esc(c.nome)}</span>
              <span style="color:#64748b;font-size:12px;margin-left:10px;">${_esc(c.tipo || '')} · ${_esc(c.canal || '')} · ${formatDate(c.data)}</span>
            </div>
            <button onclick="convertCrmToAtendido('${c.id}')" style="background:#10b981;color:#fff;border:none;border-radius:7px;padding:7px 16px;font-weight:600;font-size:13px;cursor:pointer;">
              ✓ Registrar Atendimento
            </button>
          </div>`).join('')}
      </div>
    </div>`;
}

function convertCrmToAtendido(ref) {
  const crm = DB.get('crm');
  // ref: id estável (string) ou índice (número).
  const crmIdx = (typeof ref === 'string') ? crm.findIndex(x => x.id === ref) : ref;
  const c = crm[crmIdx];
  if (!c) return;
  editState = { col: null, idx: null, crmIdx, crmId: c.id ?? null };
  const modal = document.getElementById('modal-paciente');
  const form = modal.querySelector('form');
  const today = _ymd(new Date());
  popularProcedimentoSelect();
  form.data.value = today;
  form.nome.value = c.nome || '';
  if (form.whatsapp) form.whatsapp.value = c.whatsapp || '';
  _popularProfissionalSelect(c.profissionalId || currentProfissionalId || null, 'pac-profissional');
  // Tenta usar o tipo do CRM se ele existir no catálogo; se não, deixa o primeiro
  const procs = getProcedimentos();
  form.tipo.value = procs.some(p => p.nome === c.tipo) ? c.tipo : (procs[0]?.nome || '');
  form.valor.value = '';
  form.pagamento.value = 'PIX';
  form.statusPgto.value = 'Pago';
  form.obs.value = '';
  atualizarValorSugerido();
  modal.querySelector('.modal-title').textContent = 'Registrar Atendimento';
  modal.style.display = 'flex';
}

// ====================== IMPORTAR CONTATO DO WHATSAPP ======================
let waExtracted = null;
let waImageDataUrl = null; // base64 da imagem colada (se houver)

function openImportarWA() {
  resetImportWA();
  document.getElementById('modal-importar-wa').style.display = 'flex';
  setTimeout(() => document.getElementById('wa-textarea').focus(), 50);
}

function closeImportarWA() {
  document.getElementById('modal-importar-wa').style.display = 'none';
  resetImportWA();
}

function resetImportWA() {
  document.getElementById('wa-textarea').value = '';
  document.getElementById('wa-step-paste').style.display = 'block';
  document.getElementById('wa-step-loading').style.display = 'none';
  document.getElementById('wa-step-preview').style.display = 'none';
  document.getElementById('wa-image-preview').style.display = 'none';
  document.getElementById('wa-image-thumb').src = '';
  waExtracted = null;
  waImageDataUrl = null;
}

// Captura imagem colada (Ctrl+V)
function handleWAPaste(e) {
  const items = (e.clipboardData || e.originalEvent?.clipboardData)?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type && item.type.startsWith('image/')) {
      e.preventDefault();
      const blob = item.getAsFile();
      lerImagemWA(blob);
      return;
    }
  }
  // Se não tiver imagem, o paste normal de texto acontece
}

function handleWAFile(e) {
  const file = e.target.files?.[0];
  if (file) lerImagemWA(file);
}

function lerImagemWA(blob) {
  const reader = new FileReader();
  reader.onload = (ev) => {
    waImageDataUrl = ev.target.result;
    document.getElementById('wa-image-thumb').src = waImageDataUrl;
    document.getElementById('wa-image-preview').style.display = 'block';
  };
  reader.readAsDataURL(blob);
}

function removerImagemWA() {
  waImageDataUrl = null;
  document.getElementById('wa-image-preview').style.display = 'none';
  document.getElementById('wa-image-thumb').src = '';
}

async function processarImportWA() {
  const texto = document.getElementById('wa-textarea').value.trim();
  const temImagem = !!waImageDataUrl;

  if (!texto && !temImagem) { toast('Cole texto ou uma imagem para analisar'); return; }
  if (!temImagem && texto.length < 20) { toast('Conversa muito curta — cole mais contexto ou um print'); return; }

  const key = getGeminiKey();
  if (!key) { toast('Configure a chave da MaestrIA (⚙️ no chat) primeiro'); return; }

  document.getElementById('wa-step-paste').style.display = 'none';
  document.getElementById('wa-step-loading').style.display = 'block';

  const hoje = _ymd(new Date());
  const promptBase = `Você é assistente de uma clínica de geriatria. Analise a conversa do WhatsApp ${temImagem ? '(imagem em anexo, possivelmente um print)' : 'abaixo'} e extraia os dados do contato.

${temImagem ? '' : `Conversa:\n"""\n${texto}\n"""\n`}${temImagem && texto ? `Contexto adicional do usuário: "${texto}"\n` : ''}
Responda APENAS com JSON válido (sem markdown, sem comentários) neste formato:
{
  "nome": "nome completo do paciente ou contato (string)",
  "whatsapp": "telefone formatado (XX) XXXXX-XXXX ou string vazia",
  "idade": "idade em anos como número, ou null se não mencionada",
  "canal": "um destes: Indicação médica, Indicação paciente, Google, Instagram, WhatsApp, Doctoralia, Outros",
  "tipo": "um destes: 1ª vez, Consulta, Retorno, Cortesia, Domiciliar, Hospitalar",
  "status": "um destes: Contato feito, Em negociação, Marcou, Não marcou",
  "obs": "resumo de 1 frase do que o contato quer (string)"
}

Regras:
- Se a pessoa só pediu informação, status = "Contato feito"
- Se está discutindo valores/horários sem confirmar, status = "Em negociação"
- Se já confirmou data/horário, status = "Marcou"
- Se desistiu/não respondeu adequadamente, status = "Não marcou"
- Para pacientes idosos (geriatria) novos, tipo = "1ª vez"
- Se o contato é um filho falando da mãe/pai, use o nome do idoso quando mencionado
- Canal "Indicação médica" se mencionou nome de médico; "Indicação paciente" se outro paciente indicou; "WhatsApp" se origem não-clara
${temImagem ? '- O nome do contato no print costuma estar no topo (header da conversa). Use-o se nenhum outro nome for mencionado.\n- Telefones podem estar visíveis no header ou nas próprias mensagens.' : ''}`;

  // Monta mensagem (multimodal se houver imagem)
  const userContent = temImagem
    ? [
        { type: 'text', text: promptBase },
        { type: 'image_url', image_url: { url: waImageDataUrl } }
      ]
    : promptBase;

  // Modelo: visão para imagem, rápido para texto
  const modelo = temImagem ? 'meta-llama/llama-4-scout-17b-16e-instruct' : 'llama-3.1-8b-instant';

  try {
    const body = {
      model: modelo,
      messages: [{ role: 'user', content: userContent }],
      temperature: 0.2,
      max_tokens: 500
    };
    if (!temImagem) body.response_format = { type: 'json_object' }; // visão nem sempre aceita json_object

    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const errTxt = await res.text();
      throw new Error('API ' + res.status + ': ' + errTxt.substring(0, 120));
    }
    const json = await res.json();
    let raw = json.choices?.[0]?.message?.content || '{}';
    // Modelo de visão pode envolver em ```json ... ``` — limpa
    const m = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (m) raw = m[1];
    // Pega só o primeiro objeto JSON
    const jm = raw.match(/\{[\s\S]*\}/);
    if (jm) raw = jm[0];
    const dados = JSON.parse(raw);

    waExtracted = {
      data: hoje,
      hora: new Date().toTimeString().substring(0, 5),
      nome: dados.nome || '',
      whatsapp: dados.whatsapp || '',
      idade: dados.idade || '',
      canal: dados.canal || 'WhatsApp',
      tipo: dados.tipo || '1ª vez',
      status: dados.status || 'Contato feito',
      obs: dados.obs || ''
    };

    const preview = document.getElementById('wa-preview-content');
    preview.innerHTML = `
      <div style="display:grid;grid-template-columns:90px 1fr;gap:6px 12px;">
        <div style="color:#64748b;font-weight:600;">Nome:</div><div>${waExtracted.nome ? _esc(waExtracted.nome) : '<em style="color:#cbd5e1;">não identificado</em>'}</div>
        <div style="color:#64748b;font-weight:600;">WhatsApp:</div><div>${waExtracted.whatsapp ? _esc(waExtracted.whatsapp) : '<em style="color:#cbd5e1;">não identificado</em>'}</div>
        <div style="color:#64748b;font-weight:600;">Idade:</div><div>${waExtracted.idade ? _esc(waExtracted.idade) : '<em style="color:#cbd5e1;">—</em>'}</div>
        <div style="color:#64748b;font-weight:600;">Canal:</div><div>${_esc(waExtracted.canal)}</div>
        <div style="color:#64748b;font-weight:600;">Tipo:</div><div>${_esc(waExtracted.tipo)}</div>
        <div style="color:#64748b;font-weight:600;">Status:</div><div>${_esc(waExtracted.status)}</div>
        <div style="color:#64748b;font-weight:600;">Resumo:</div><div style="font-style:italic;color:#475569;">${waExtracted.obs ? _esc(waExtracted.obs) : '—'}</div>
      </div>
      <div style="margin-top:10px;padding-top:10px;border-top:1px dashed #bbf7d0;font-size:11.5px;color:#15803d;">💡 Você pode ajustar tudo depois clicando no ✏️ da linha no CRM</div>`;

    document.getElementById('wa-step-loading').style.display = 'none';
    document.getElementById('wa-step-preview').style.display = 'block';
  } catch (e) {
    document.getElementById('wa-step-loading').style.display = 'none';
    document.getElementById('wa-step-paste').style.display = 'block';
    toast('Erro ao analisar: ' + e.message);
  }
}

function confirmarImportWA() {
  if (!waExtracted) return;
  const arr = DB.get('crm');
  arr.unshift(waExtracted);
  DB.set('crm', arr);
  closeImportarWA();
  renderCrm();
  toast(`✅ ${waExtracted.nome || 'Contato'} adicionado ao CRM como "${waExtracted.status}"`);
}

// ====================== INTEGRAÇÃO ATENDIDOS → FOLLOW-UP ======================
function renderAtendidosSemFollowup() {
  const pacs = DB.get('pacientes');
  const followups = DB.get('followup');
  // Mapa: nome → data mais recente de follow-up (baseado em ultConsulta)
  const ultFupPorNome = {};
  followups.forEach(f => {
    const key = (f.nome || '').toLowerCase().trim();
    if (!key) return;
    const d = f.ultConsulta || '';
    if (!ultFupPorNome[key] || d > ultFupPorNome[key]) ultFupPorNome[key] = d;
  });
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 60);
  const cutoffStr = _ymd(cutoff);
  const semFollowup = pacs.map((p, i) => ({ ...p, _idx: i })).filter(p => {
    if (p.data < cutoffStr) return false;            // consulta antiga demais
    if (p.followupCreated) return false;             // já criamos via banner
    const key = (p.nome || '').toLowerCase().trim();
    const ultFup = ultFupPorNome[key];
    // Só esconde se já existe follow-up cobrindo esta consulta (ou posterior)
    if (ultFup && ultFup >= p.data) return false;
    return true;
  });
  const container = document.getElementById('atendidos-sem-followup');
  if (!container) return;
  if (!semFollowup.length) { container.innerHTML = ''; return; }

  const visibles = semFollowup.slice(0, 5);
  container.innerHTML = `
    <div style="background:#eff6ff;border:1.5px solid #93c5fd;border-radius:12px;padding:16px 20px;margin-bottom:20px;">
      <div style="font-weight:700;color:#1d4ed8;margin-bottom:12px;display:flex;align-items:center;gap:8px;">
        <span style="font-size:18px;">📞</span>
        <span>${semFollowup.length} paciente(s) atendidos sem follow-up nos últimos 60 dias</span>
      </div>
      <div style="display:flex;flex-direction:column;gap:8px;">
        ${visibles.map(p => `
          <div style="display:flex;align-items:center;justify-content:space-between;background:#fff;border-radius:8px;padding:10px 14px;border:1px solid #bfdbfe;">
            <div>
              <span style="font-weight:600;color:#0f172a;">${_esc(p.nome)}</span>
              <span style="color:#64748b;font-size:12px;margin-left:10px;">Consulta: ${formatDate(p.data)} · ${_esc(p.tipo)}</span>
            </div>
            <button onclick="convertAtendidoToFollowup(${p._idx})" style="background:#3b82f6;color:#fff;border:none;border-radius:7px;padding:7px 16px;font-weight:600;font-size:13px;cursor:pointer;">
              + Criar Follow-Up
            </button>
          </div>`).join('')}
        ${semFollowup.length > 5 ? `<div style="text-align:center;color:#64748b;font-size:13px;padding:4px;">e mais ${semFollowup.length - 5} paciente(s)...</div>` : ''}
      </div>
    </div>`;
}

function convertAtendidoToFollowup(pacIdx) {
  const pacs = DB.get('pacientes');
  const p = pacs[pacIdx];
  if (!p) return;
  const modal = document.getElementById('modal-followup');
  const form = modal.querySelector('form');
  const nextWeek = new Date(); nextWeek.setDate(nextWeek.getDate() + 7);
  const ajustado = proximoDiaUtil(nextWeek);
  form.nome.value = p.nome || '';
  form.ultConsulta.value = p.data || '';
  form.dataContato.value = _ymd(ajustado);
  form.tipoContato.value = 'WhatsApp';
  form.dataReav.value = '';
  form.obs.value = '';
  editState = { col: null, idx: null, crmIdx: null, pacIdx };
  modal.querySelector('.modal-title').textContent = 'Criar Follow-Up';
  modal.style.display = 'flex';
}

// ====================== PACIENTES ======================
function savePaciente(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const valorTotal = parseFloat(fd.get('valor')) || 0;
  if (valorTotal < 0) { alert('Valor não pode ser negativo.'); return; }
  const pagamento  = fd.get('pagamento');
  const parcelas   = pagamento === 'Cartão crédito' ? (parseInt(fd.get('parcelas')) || 1) : 1;
  const dataConsulta = fd.get('data') || _ymd(new Date());

  // Gera recebimentos futuros se parcelado
  let recebimentos = null;
  if (parcelas > 1) {
    // Divide em CENTAVOS e joga a sobra na última parcela: arredondar todas
    // por igual fazia a soma não fechar com o total (1000 em 3x virava 999,99)
    // e a coluna "Diferença" da previsão de recebimentos exibir "R$ -0".
    recebimentos = [];
    const totalCent = Math.round(valorTotal * 100);
    const baseCent  = Math.floor(totalCent / parcelas);
    const sobraCent = totalCent - baseCent * parcelas;
    const [ano, mes, dia] = dataConsulta.split('-').map(Number);
    for (let i = 0; i < parcelas; i++) {
      const d = new Date(ano, mes - 1 + i, 1);
      const mesStr = _ymd(d).substring(0, 7);
      const cent = baseCent + (i === parcelas - 1 ? sobraCent : 0);
      recebimentos.push({ numero: i + 1, mes: mesStr, valor: cent / 100, recebido: i === 0 });
    }
  }

  const item = {
    data: dataConsulta,
    nome: fd.get('nome'),
    whatsapp: (fd.get('whatsapp') || '').trim(),
    profissionalId: fd.get('profissionalId') || null,
    tipo: fd.get('tipo'),
    valor: valorTotal,
    pagamento,
    parcelas,
    recebimentos,
    statusPgto: fd.get('statusPgto'),
    obs: fd.get('obs')
  };
  const data = DB.get('pacientes');
  // id estável: preserva no editar, gera no criar
  item.id = (editState.col === 'pacientes' && editState.idx !== null && data[editState.idx] && data[editState.idx].id) || _novoId('pac');
  if (editState.col === 'pacientes' && editState.idx !== null) {
    data[editState.idx] = item;
  } else {
    data.unshift(item);
  }
  DB.set('pacientes', data);

  // Se veio de um agendamento, fecha o agendamento (marca como Compareceu + vínculo)
  if (editState.agId) {
    const ags = DB.get('agendamentos');
    const a = ags.find(x => x.id === editState.agId);
    if (a) {
      a.status = 'Compareceu';
      a.pacIdx = data.indexOf(item) >= 0 ? data.indexOf(item) : 0;
      a.pacId  = item.id;   // vínculo por id (Fase 1)
      DB.set('agendamentos', ags);
    }
  }

  // Marcar CRM como convertido quando vem de conversão
  if (editState.crmId || editState.crmIdx !== null && editState.crmIdx !== undefined) {
    const crm = DB.get('crm');
    // Prefere o id estável; índice congelado só como fallback (pode ter
    // reordenado por um lead via realtime durante o modal aberto).
    const alvo = editState.crmId
      ? crm.find(c => c.id === editState.crmId)
      : crm[editState.crmIdx];
    if (alvo) { alvo.converted = true; alvo.status = 'Atendeu'; }
    DB.set('crm', crm);
  } else {
    // Auto-vincular: registro manual sem usar banner — procura CRM pelo nome
    const crm = DB.get('crm');
    const key = (item.nome || '').toLowerCase().trim();
    const matches = crm
      .map((c, i) => ({ c, i }))
      .filter(({ c }) =>
        (c.nome || '').toLowerCase().trim() === key &&
        !c.converted &&
        ['Contato feito', 'Em negociação', 'Marcou'].includes(c.status)
      );
    if (matches.length === 1) {
      crm[matches[0].i].converted = true;
      crm[matches[0].i].status = 'Atendeu';
      DB.set('crm', crm);
      toast(`Contato "${item.nome}" do CRM vinculado automaticamente como Atendeu`);
    } else if (matches.length > 1) {
      toast(`⚠️ ${matches.length} contatos no CRM com nome "${item.nome}" — ajuste o status manualmente`);
    }
  }
  closeModal('modal-paciente');
  renderPacientes();
  setTimeout(() => checkAchievements(), 300);
  _auditLog(editState.idx != null ? 'editou' : 'criou', 'paciente',
    `${editState.idx != null ? 'Editou' : 'Cadastrou'} consulta de ${item.nome} (${item.tipo}, ${BRL(item.valor)})`);

  // MELHORIA-02: avisa se o procedimento não tem preço cadastrado na Tabela de Preços
  if (item.tipo) {
    const proc = getProcedimentos().find(p => p.nome === item.tipo);
    if (proc && !proc.valorPix && !proc.valorCartao) {
      setTimeout(() => toast(`💡 "${item.tipo}" está sem preço na Tabela de Preços. Cadastre para o valor sugerido aparecer automático.`, 5000), 600);
    } else if (!proc) {
      setTimeout(() => toast(`💡 "${item.tipo}" não está na Tabela de Preços. Considere cadastrar.`, 5000), 600);
    }
  }
}

// Toast simples (notificação flutuante)
function toast(msg, ms = 3500) {
  let t = document.getElementById('app-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'app-toast';
    document.body.appendChild(t);
  }
  // pointer-events:none é obrigatório. O toast é fixed, z-index 9999, e some
  // só com opacity:0 — mas opacidade zero NÃO desliga clique. Sem isto o
  // elemento continuava no DOM interceptando toque bem em cima da nav inferior
  // do mobile (#mob-bottom-nav, z-index 150): depois do primeiro toast da
  // sessão, o botão central da nav parava de responder. Aqui não há nada
  // clicável dentro do toast, então fica desligado sempre.
  t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#0f172a;color:#fff;padding:12px 20px;border-radius:10px;font-size:13.5px;font-weight:500;box-shadow:0 10px 30px rgba(0,0,0,0.25);z-index:9999;opacity:0;transition:opacity 0.25s;max-width:90vw;text-align:center;pointer-events:none;';
  t.textContent = msg;
  t.style.opacity = '1';
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.style.opacity = '0'; }, ms);
}

// Toast com botão "Desfazer" — usado nas exclusões pra tirar o medo de apagar
// (some sempre existiu confirm() nativo, mas engano acontece; ter 6s pra
// reverter sem precisar redigitar tudo de novo muda a experiência).
function _toastUndo(msg, restaurarFn, ms = 6000) {
  let t = document.getElementById('app-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'app-toast';
    document.body.appendChild(t);
  }
  // Aqui o toast PRECISA receber clique (o botão Desfazer), então ele nasce
  // clicável e é desligado quando some — senão fica um "Desfazer" invisível
  // sobre a nav inferior do mobile, e um toque ali ressuscita o registro
  // apagado minutos depois, sem o usuário entender o que aconteceu.
  t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#0f172a;color:#fff;padding:10px 10px 10px 18px;border-radius:10px;font-size:13.5px;font-weight:500;box-shadow:0 10px 30px rgba(0,0,0,0.25);z-index:9999;opacity:0;transition:opacity 0.25s;max-width:90vw;display:flex;align-items:center;gap:14px;pointer-events:auto;';
  t.innerHTML = '';
  const span = document.createElement('span');
  span.textContent = msg;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = 'Desfazer';
  btn.style.cssText = 'background:#10b981;color:#fff;border:none;border-radius:6px;padding:6px 12px;font-size:12.5px;font-weight:700;cursor:pointer;white-space:nowrap;flex-shrink:0;';
  // Uma restauração só. O botão continua no DOM depois do clique e dois
  // toques seguidos chamavam restaurarFn duas vezes.
  let usado = false;
  const esconder = () => {
    usado = true;
    t.style.opacity = '0';
    t.style.pointerEvents = 'none';
    btn.disabled = true;
    clearTimeout(t._timer);
  };
  btn.onclick = () => {
    if (usado) return;
    esconder();
    restaurarFn();
  };
  t.appendChild(span);
  t.appendChild(btn);
  t.style.opacity = '1';
  clearTimeout(t._timer);
  t._timer = setTimeout(esconder, ms);
}

function filterPacStatus(val) {
  const rows = document.querySelectorAll('#pac-tbody tr[data-search]');
  rows.forEach(row => {
    if (!val || row.getAttribute('data-status') === val) row.style.display = '';
    else row.style.display = 'none';
  });
}

function renderPacientes() {
  renderCrmPendentesAtendidos();
  const data = DB.get('pacientes');
  const tbody = document.getElementById('pac-tbody');
  if (!data.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="text-center py-12 text-gray-400">Nenhuma consulta registrada.</td></tr>';
    const pgEl = document.getElementById('pac-paginator');
    if (pgEl) pgEl.innerHTML = '';
    return;
  }
  // Ordena desc por data antes de paginar
  const sorted = data.map((r, originalIdx) => ({ ...r, _origIdx: originalIdx }))
                     .sort((a, b) => (b.data || '').localeCompare(a.data || ''));
  const info = _paginate('pacientes', sorted);
  tbody.innerHTML = info.slice.map(r => {
    const i = r._origIdx;
    return `
    <tr data-search="${_esc(r.nome)} ${_esc(r.tipo)}" data-status="${r.statusPgto === 'Pago' ? 'Ativo' : 'Inativo'}" class="border-b border-gray-50 hover:bg-gray-50">
      <td class="px-4 py-3 text-gray-600">${formatDate(r.data)}</td>
      <td class="px-4 py-3 font-medium text-gray-900">${_esc(r.nome)}</td>
      <td class="px-4 py-3 text-gray-600">${_esc(r.tipo)}</td>
      <td class="px-4 py-3 font-semibold text-gray-900">${BRL(r.valor)}</td>
      <td class="px-4 py-3 text-gray-600">${_esc(r.pagamento)}</td>
      <td class="px-4 py-3">${pgtoSelect(r.statusPgto, i)}</td>
      <td class="px-4 py-3">
        <button onclick="abrirPerfilPaciente('${_jsArg(r.nome)}')" style="background:#f1f5f9;border:none;border-radius:6px;padding:4px 9px;font-size:11.5px;cursor:pointer;color:#475569;font-weight:600;" title="Ver perfil completo" onmouseover="this.style.background='#e2e8f0'" onmouseout="this.style.background='#f1f5f9'">👤 Ver</button>
      </td>
      <td class="px-4 py-3" style="white-space:nowrap;">
        <button onclick="editRow('pacientes',${i})" class="text-blue-400 hover:text-blue-600 text-xs mr-2" title="Editar">✏️</button>
        <button onclick="deleteRow('pacientes',${i})" class="text-red-400 hover:text-red-600 text-xs" title="Excluir">🗑️</button>
      </td>
    </tr>`;
  }).join('');
  // Paginador (só aparece se >50)
  const pgEl = document.getElementById('pac-paginator');
  if (pgEl) pgEl.innerHTML = _paginatorHtml('pacientes', info);
}

// ====================== FOLLOW-UP ======================
function saveFollowup(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const data = DB.get('followup');
  const editIns = (editState.col === 'followup' && editState.idx !== null) ? data[editState.idx] : null;
  const existFeito = editIns ? (editIns.feito || false) : false;
  const item = { nome: fd.get('nome'), whatsapp: (fd.get('whatsapp') || '').trim(), ultConsulta: fd.get('ultConsulta'), dataContato: fd.get('dataContato'), tipoContato: fd.get('tipoContato'), feito: existFeito, dataReav: fd.get('dataReav'), obs: fd.get('obs') };
  // Blindagem: id estável + dono profissional (preserva no editar)
  item.id = (editIns && editIns.id) || _novoId('fu');
  item.profissionalId = (editIns && editIns.profissionalId) || _profDoPaciente(fd.get('nome')) || null;
  if (editState.col === 'followup' && editState.idx !== null) { data[editState.idx] = item; } else { data.unshift(item); }
  DB.set('followup', data);
  // Marcar paciente como followup criado
  if (editState.pacIdx !== null && editState.pacIdx !== undefined) {
    const pacs = DB.get('pacientes');
    if (pacs[editState.pacIdx]) { pacs[editState.pacIdx].followupCreated = true; }
    DB.set('pacientes', pacs);
  }
  closeModal('modal-followup');
  renderFollowup();
}

function toggleFollowupFeito(i) {
  const data = DB.get('followup');
  data[i].feito = !data[i].feito;
  DB.set('followup', data);
  renderFollowup();
}

let _followupTab = 'regular'; // 'regular' | 'programa'

function setFollowupTab(tab) {
  _followupTab = tab;
  const tR = document.getElementById('fu-tab-regular');
  const tP = document.getElementById('fu-tab-programa');
  if (tR && tP) {
    if (tab === 'regular') {
      tR.style.color = '#0f172a'; tR.style.borderBottomColor = '#10b981';
      tP.style.color = '#94a3b8'; tP.style.borderBottomColor = 'transparent';
    } else {
      tP.style.color = '#0f172a'; tP.style.borderBottomColor = '#3b82f6';
      tR.style.color = '#94a3b8'; tR.style.borderBottomColor = 'transparent';
    }
  }
  renderFollowup();
}

function renderFollowup() {
  // Só renderiza o banner "atendidos sem follow-up" na aba Regular
  if (_followupTab === 'regular') renderAtendidosSemFollowup();
  else { const b = document.getElementById('atendidos-sem-followup'); if (b) b.innerHTML = ''; }

  const all = DB.get('followup');
  const today = _ymd(new Date());
  const tbody = document.getElementById('followup-tbody');
  const alertas = document.getElementById('alertas-container');

  // Separa regular vs programa e atualiza contadores
  const regularAll  = all.filter(r => !r.programaInscricaoId);
  const programaAll = all.filter(r =>  r.programaInscricaoId);
  const cR = document.getElementById('fu-count-regular');
  const cP = document.getElementById('fu-count-programa');
  if (cR) cR.textContent = regularAll.length;
  if (cP) cP.textContent = programaAll.length;

  // Aplica filtro por programa (só na aba programa)
  let data = _followupTab === 'programa' ? programaAll.slice() : regularAll.slice();
  const filtroProg = document.getElementById('fu-filtro-programa')?.value || '';
  const inscricoes = getInscricoes();
  const programas  = getProgramas();
  if (_followupTab === 'programa' && filtroProg) {
    const insDoProg = inscricoes.filter(i => i.programaId === filtroProg).map(i => i.id);
    data = data.filter(r => insDoProg.includes(r.programaInscricaoId));
  }

  // Ordena: pendentes (mais urgentes primeiro) → feitos no final
  data.sort((a, b) => {
    if (a.feito !== b.feito) return a.feito ? 1 : -1;
    return (a.dataContato || '').localeCompare(b.dataContato || '');
  });

  // Mapeia índice original pra edit/delete
  const dataIdx = data.map(r => all.indexOf(r));

  // Render do filtro de programas (só na aba programa)
  const filtroWrap = document.getElementById('fu-filtros-wrap');
  if (filtroWrap) {
    if (_followupTab === 'programa') {
      const progsComInscr = programas.filter(p => inscricoes.some(i => i.programaId === p.id));
      filtroWrap.innerHTML = `
        <div style="display:flex;gap:10px;margin-bottom:14px;align-items:center;flex-wrap:wrap;">
          <select id="fu-filtro-programa" onchange="renderFollowup()" class="select" style="min-width:240px;font-size:13px;">
            <option value="">Todos os programas</option>
            ${progsComInscr.map(p => `<option value="${p.id}" ${p.id === filtroProg ? 'selected':''}>${_esc(p.nome)}</option>`).join('')}
          </select>
          <span style="font-size:11.5px;color:#94a3b8;">${data.length} follow-up(s) • ordenado por urgência</span>
        </div>`;
    } else {
      filtroWrap.innerHTML = '';
    }
  }

  const vencidos = data.filter(r => !r.feito && r.dataContato && r.dataContato <= today);

  if (vencidos.length > 0) {
    const labelAba = _followupTab === 'programa' ? 'de programa' : 'regulares';
    alertas.innerHTML = `
      <div class="bg-orange-50 border border-orange-200 rounded-xl p-4 flex items-start gap-3 mb-4">
        <span class="text-2xl">⚠️</span>
        <div>
          <div class="font-semibold text-orange-800">${vencidos.length} follow-up(s) ${labelAba} pendente(s) hoje</div>
          <div class="text-sm text-orange-700 mt-1">${vencidos.map(r => _esc(r.nome)).join(', ')}</div>
        </div>
      </div>`;
  } else {
    alertas.innerHTML = '';
  }

  if (!data.length) {
    const msg = _followupTab === 'programa'
      ? 'Nenhum follow-up de programa. Inscreva um paciente em um Programa de Acompanhamento na aba Programas.'
      : 'Nenhum follow-up regular registrado.';
    tbody.innerHTML = `<tr><td colspan="7" class="text-center py-12 text-gray-400">${msg}</td></tr>`;
    return;
  }

  tbody.innerHTML = data.map((r, localI) => {
    const i = dataIdx[localI];
    const atrasado = !r.feito && r.dataContato && r.dataContato < today;
    const hoje = !r.feito && r.dataContato === today;
    // Etapa (etiqueta extraída do obs) + badge de programa
    let etiqueta = r.obs || '';
    let badgeProg = '';
    if (r.programaInscricaoId) {
      const ins  = inscricoes.find(x => x.id === r.programaInscricaoId);
      const prog = ins ? programas.find(p => p.id === ins.programaId) : null;
      const nomeProg = prog ? prog.nome : 'Programa';
      badgeProg = `<div style="font-size:10.5px;color:#1d4ed8;font-weight:600;background:#dbeafe;display:inline-block;padding:1px 8px;border-radius:999px;margin-top:3px;">🔁 ${_esc(nomeProg)}</div>`;
      // Extrai etiqueta (parte antes do '·' ou nome do programa)
      const m = (r.obs || '').match(/^([^·]+)·/);
      etiqueta = m ? m[1].trim() : (r.obs || '').replace(`Renovar ${nomeProg}`, 'Renovar') || '—';
    }
    // Indicador de dias
    let diasIndic = '';
    if (!r.feito && r.dataContato) {
      const diff = Math.round((new Date(r.dataContato + 'T12:00') - new Date(today + 'T12:00')) / 86400000);
      if (diff < 0) diasIndic = `<span style="color:#dc2626;font-weight:700;">atrasado ${Math.abs(diff)}d</span>`;
      else if (diff === 0) diasIndic = `<span style="color:#f59e0b;font-weight:700;">hoje</span>`;
      else if (diff <= 7) diasIndic = `<span style="color:#0f172a;font-weight:600;">em ${diff}d</span>`;
      else diasIndic = `<span style="color:#64748b;">em ${diff}d</span>`;
    } else if (r.feito) {
      diasIndic = `<span style="color:#10b981;font-weight:600;">✓ feito</span>`;
    }
    const bg = atrasado ? 'bg-orange-50' : hoje ? 'bg-amber-50' : '';
    return `
    <tr class="border-b border-gray-50 hover:bg-gray-50 ${bg}" data-fu-row="${i}">
      <td class="px-4 py-3">
        <div style="font-weight:600;color:#0f172a;">${_esc(r.nome)}</div>
        ${badgeProg}
      </td>
      <td class="px-4 py-3 text-gray-700" style="font-size:12.5px;">${_esc(etiqueta)}</td>
      <td class="px-4 py-3 text-gray-600">${formatDate(r.ultConsulta) || '—'}</td>
      <td class="px-4 py-3">
        <div style="color:${atrasado ? '#dc2626' : hoje ? '#d97706' : '#475569'};font-weight:${atrasado || hoje ? '700' : '500'};">${formatDate(r.dataContato)}</div>
        <div style="font-size:11px;margin-top:1px;">${diasIndic}</div>
      </td>
      <td class="px-4 py-3 text-gray-600">${_esc(r.tipoContato)}</td>
      <td class="px-4 py-3 text-center">
        <input type="checkbox" ${r.feito ? 'checked' : ''} onchange="toggleFollowupFeito(${i})" class="w-4 h-4 accent-green-600 cursor-pointer" title="${r.feito ? 'Desmarcar' : 'Marcar como feito'}" />
      </td>
      <td class="px-4 py-3" style="white-space:nowrap;">
        ${r.nome && (r.tipoContato || '').includes('WhatsApp') ? `<button onclick="_openWhatsAppForFu(${i})" title="Abrir WhatsApp" style="background:#dcfce7;color:#16a34a;border:none;border-radius:6px;padding:4px 9px;font-size:12px;cursor:pointer;margin-right:4px;">💬</button>` : ''}
        <button onclick="editRow('followup',${i})" class="text-blue-400 hover:text-blue-600 text-xs mr-2" title="Editar">✏️</button>
        <button onclick="deleteRow('followup',${i})" class="text-red-400 hover:text-red-600 text-xs" title="Excluir">🗑️</button>
      </td>
    </tr>`;
  }).join('');
}

// Abre WhatsApp com mensagem pré-formatada para o follow-up
function _openWhatsAppForFu(idx) {
  const fu = DB.get('followup')[idx];
  if (!fu) return;
  // Tenta achar o telefone do paciente
  const pac = DB.get('pacientes').find(p => p.nome === fu.nome && p.whatsapp);
  const crm = DB.get('crm').find(c => c.nome === fu.nome && c.whatsapp);
  const ins = DB.get('inscricoes').find(i => i.id === fu.programaInscricaoId);
  const wa = (fu.whatsapp || pac?.whatsapp || crm?.whatsapp || ins?.pacienteWhatsapp || '').replace(/\D/g, '');
  if (!wa) { alert('WhatsApp não cadastrado para ' + fu.nome + '.\n\nClique no ✏️ pra editar este follow-up e adicionar o número.'); return; }
  const msg = `Olá ${(fu.nome || '').split(' ')[0]}! ${fu.obs || ''}`.trim();
  // Roteia pelo CRM (se automação ligada) ou WhatsApp externo (se desligada)
  falarComPaciente(fu.nome, wa, msg);
}

// ====================== AGENDA ======================
// ====================== AGENDA — NÍVEL 3 ======================
// Modelo:
//   consult_agendamentos: [{ id, data, hora, duracao, pacienteNome, whatsapp, procedimento, status, obs, crmIdx, pacIdx }]
//   consult_agenda_config: { horaInicio, horaFim, slotDuracao, almocoInicio, almocoFim, diasUteis: [1..5] }
//   consult_bloqueios: [{ id, motivo, dataInicio, horaInicio, dataFim, horaFim }]

// No celular, 7 colunas da Semana espremem cada dia a quase nada — Dia (1
// coluna larga) é utilizável de cara. Desktop mantém Semana (visão padrão).
function _isMobileViewport() { return typeof window !== 'undefined' && window.innerWidth > 0 && window.innerWidth <= 768; }
let agView = _isMobileViewport() ? 'dia' : 'semana';  // 'dia' | 'semana' | 'mes' | 'profissionais'
let agAnchor = new Date();        // data de referência para a view
let _agFiltroProf = '';           // '' = todos; senão id do profissional p/ filtrar a agenda

// Agendamentos visíveis na tela conforme o filtro de profissional ativo.
// (Só afeta a EXIBIÇÃO — salvar/conflito/arrastar usam getAgendamentos() cru.)
function _agsVisiveis() {
  const all = getAgendamentos();
  return _agFiltroProf ? all.filter(a => (a.profissionalId || '') === _agFiltroProf) : all;
}

function _agId() { return 'ag_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6); }

function getAgConfig() {
  return DB.getObj('agenda_config', {
    horaInicio: '07:00', horaFim: '20:00', slotDuracao: 60,
    almocoInicio: '12:00', almocoFim: '13:30',
    diasUteis: [1, 2, 3, 4, 5],
    // slotsSemanais[0]=Dom … [6]=Sáb — slots de consultório por dia
    slotsSemanais: [0, 5, 0, 5, 5, 0, 0],
  });
}
function getAgendamentos() { return DB.get('agendamentos'); }
function getBloqueios()    { return DB.get('bloqueios'); }

// Helpers de tempo
function _toMin(hhmm) { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; }
function _toHHMM(min) { return String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0'); }
// Formata Date como YYYY-MM-DD usando componentes LOCAIS (não UTC).
// Bug original: toISOString() retorna UTC e shift uma data 1 dia pra trás em fusos negativos
// (ex.: '2026-05-20 00:00 GMT-3' viraria '2026-05-19' no toISOString).
function _ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function _addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function _startOfWeek(d) { const x = new Date(d); const dow = x.getDay(); const diff = (dow === 0 ? 6 : dow - 1); x.setDate(x.getDate() - diff); return x; }
function _isSameDay(a, b) { return _ymd(a) === _ymd(b); }

// Verifica se a data/hora está dentro de bloqueio (qualquer parte do slot conta)
function _isBloqueado(dataStr, horaInicio, duracaoMin) {
  const bloqs = getBloqueios();
  const slotIni = new Date(dataStr + 'T' + horaInicio);
  const slotFim = new Date(slotIni.getTime() + duracaoMin * 60000);
  return bloqs.some(b => {
    const bIni = new Date(b.dataInicio + 'T' + (b.horaInicio || '00:00'));
    const bFim = new Date(b.dataFim + 'T' + (b.horaFim || '23:59'));
    return slotIni < bFim && slotFim > bIni;
  });
}

// Verifica conflito com outro agendamento (mesmo paciente/horário ou sobreposição)
function _temConflito(dataStr, hora, duracao, ignorarId = null, profissionalId = undefined) {
  const ags = getAgendamentos();
  const ini = _toMin(hora);
  const fim = ini + duracao;
  return ags.find(a => {
    if (a.id === ignorarId) return false;
    if (a.data !== dataStr) return false;
    if (a.status === 'Cancelado') return false;
    // Clínica multi-profissional: horários de profissionais DIFERENTES podem
    // coexistir (salas separadas). Só é conflito quando é o mesmo profissional
    // ou quando algum dos dois não tem profissional definido (conservador).
    if (profissionalId && a.profissionalId && a.profissionalId !== profissionalId) return false;
    const aIni = _toMin(a.hora);
    const aFim = aIni + (a.duracao || 60);
    return ini < aFim && fim > aIni;
  });
}

// Gera os slots disponíveis de um dia segundo a config
function _slotsDoDia(dataStr) {
  const cfg = getAgConfig();
  const d = new Date(dataStr + 'T12:00:00');
  const dow = d.getDay();
  if (!cfg.diasUteis.includes(dow)) return [];

  const ini = _toMin(cfg.horaInicio);
  const fim = _toMin(cfg.horaFim);
  const slot = cfg.slotDuracao || 60;
  const almIni = cfg.almocoInicio ? _toMin(cfg.almocoInicio) : null;
  const almFim = cfg.almocoFim ? _toMin(cfg.almocoFim) : null;

  const slots = [];
  for (let m = ini; m + slot <= fim; m += slot) {
    // Pula slot que ENCOSTA no almoço — sobreposição, não contenção. Com a
    // config padrão (almoço 12:00–13:30, slot de 60min) a regra de contenção
    // deixava passar o 13:00–14:00, que come meia hora do almoço.
    // (Função sem chamador hoje; a agenda que a IA oferece sai do wa-webhook,
    // que já usa a regra certa. Alinhado pra ninguém herdar a regra fraca.)
    if (almIni !== null && almFim !== null && m < almFim && almIni < (m + slot)) continue;
    slots.push(_toHHMM(m));
  }
  return slots;
}

function setAgendaView(v) {
  agView = v;
  renderAgenda(); // já sincroniza as abas ativas
}

function agendaNavegar(dir) {
  if (agView === 'dia' || agView === 'profissionais') agAnchor = _addDays(agAnchor, dir);
  else if (agView === 'semana') agAnchor = _addDays(agAnchor, dir * 7);
  else { const x = new Date(agAnchor); x.setMonth(x.getMonth() + dir); agAnchor = x; }
  renderAgenda();
}
function agendaHoje() { agAnchor = new Date(); renderAgenda(); }

// Filtro de profissional na agenda (Tijolo 2). No login de um profissional,
// isto vem travado na agenda dele (Leva B).
function setAgFiltroProf(id) { _agFiltroProf = id || ''; renderAgenda(); }

function _popularFiltroProfAgenda() {
  const sel  = document.getElementById('ag-filtro-prof');
  const wrap = document.getElementById('ag-filtro-prof-wrap');
  if (!sel) return;
  const profs = getProfissionaisAtivos();
  // Profissional logado (Leva B) → filtro travado na dele e escondido
  const travado = currentRole === 'profissional' && currentProfissionalId;
  if (travado) _agFiltroProf = currentProfissionalId;
  if (wrap) wrap.style.display = (!travado && profs.length > 1) ? 'inline-flex' : 'none';
  sel.innerHTML = `<option value="">Todos</option>` + profs.map(p => `<option value="${p.id}">${_esc(p.nome)}</option>`).join('');
  sel.value = _agFiltroProf || '';
}

// ===== Modais =====
// Infere duração padrão pelo nome do procedimento
function _inferirDuracao(nomeProc) {
  if (!nomeProc) return null;
  const n = nomeProc.toLowerCase();
  if (n.includes('primeira') || n.includes('inicial') || n.includes('1ª') || n.includes('novo')) return 80;
  if (n.includes('retorno') || n.includes('seguimento') || n.includes('revisão') || n.includes('revisao')) return 50;
  // Tenta ler da tabela de preços se tiver campo duração
  const procs = getProcedimentos();
  const p = procs.find(x => x.nome === nomeProc);
  if (p && p.duracao) return parseInt(p.duracao);
  return null;
}

// Popula um <select> de profissional (default: o do modal de agendamento).
// permitirVazio=true adiciona a opção "não atribuído" (usado no CRM).
function _popularProfissionalSelect(selectedId, elId, permitirVazio) {
  const sel = document.getElementById(elId || 'ag-profissional');
  if (!sel) return;
  const profs = getProfissionaisAtivos();
  let html = permitirVazio ? '<option value="">— não atribuído —</option>' : '';
  html += profs.length
    ? profs.map(p => `<option value="${p.id}">${_esc(p.nome)}</option>`).join('')
    : (permitirVazio ? '' : '<option value="">(cadastre em Configurações)</option>');
  sel.innerHTML = html;
  if (selectedId && profs.some(p => p.id === selectedId)) sel.value = selectedId;
  else if (permitirVazio) sel.value = '';
  else if (profs.length) sel.value = profs[0].id;
}

// Índice nome→contato pra autocompletar o agendamento (pacientes primeiro —
// telefone/procedimento mais confiáveis —, depois CRM cobre quem ainda é lead).
function _agIndiceContatos() {
  const idx = new Map();
  DB.get('pacientes').slice()
    .sort((a, b) => (b.data || '').localeCompare(a.data || ''))
    .forEach(p => {
      const chave = (p.nome || '').toLowerCase().trim();
      if (chave && !idx.has(chave)) {
        idx.set(chave, { nome: p.nome, whatsapp: p.whatsapp || '', procedimento: p.tipo || '', profissionalId: p.profissionalId || null });
      }
    });
  DB.get('crm').forEach(c => {
    const chave = (c.nome || '').toLowerCase().trim();
    if (chave && !idx.has(chave)) {
      idx.set(chave, { nome: c.nome, whatsapp: c.whatsapp || '', procedimento: c.tipo || '', profissionalId: c.profissionalId || null });
    }
  });
  return idx;
}

function _agPopularDatalist() {
  const dl = document.getElementById('ag-pacientes-list');
  if (!dl) return;
  dl.innerHTML = Array.from(_agIndiceContatos().values())
    .map(c => `<option value="${_esc(c.nome)}">`).join('');
}

// Ao digitar/selecionar um nome já conhecido, preenche WhatsApp/procedimento/
// profissional sozinho — evita redigitar (e errar) dados que já existem no
// CRM ou nos atendidos. Só preenche campos ainda VAZIOS (não pisa em edição manual).
function _agAutocompletarContato() {
  const modal = document.getElementById('modal-agendamento');
  const form = modal.querySelector('form');
  const chave = (form.pacienteNome.value || '').toLowerCase().trim();
  const c = _agIndiceContatos().get(chave);
  if (!c) return;
  if (!form.whatsapp.value && c.whatsapp) form.whatsapp.value = c.whatsapp;
  if (!form.procedimento.value && c.procedimento) {
    const procs = getProcedimentos();
    if (procs.some(p => p.nome === c.procedimento)) {
      form.procedimento.value = c.procedimento;
      form.duracao.value = _inferirDuracao(c.procedimento) || form.duracao.value;
    }
  }
  if (c.profissionalId && form.profissionalId && Array.from(form.profissionalId.options).some(o => o.value === c.profissionalId)) {
    form.profissionalId.value = c.profissionalId;
  }
}

function openNovoAgendamento(prefill = {}) {
  editState = { col: null, idx: null, crmIdx: prefill.crmIdx ?? null, crmId: prefill.crmId ?? null, pacIdx: null, agId: null };
  const modal = document.getElementById('modal-agendamento');
  const form = modal.querySelector('form');
  form.reset();
  // Popula select de procedimentos
  const sel = document.getElementById('ag-procedimento');
  const procs = getProcedimentos();
  sel.innerHTML = procs.map(p => `<option value="${_esc(p.nome)}">${_esc(p.nome)}</option>`).join('');
  _popularProfissionalSelect(prefill.profissionalId || _agFiltroProf || null);
  _agPopularDatalist();
  form.pacienteNome.oninput = _agAutocompletarContato;
  // Pré-preenche
  form.data.value = prefill.data || _ymd(new Date());
  form.hora.value = prefill.hora || '09:00';
  if (prefill.pacienteNome) form.pacienteNome.value = prefill.pacienteNome;
  if (prefill.whatsapp) form.whatsapp.value = prefill.whatsapp;
  if (prefill.procedimento && procs.some(p => p.nome === prefill.procedimento)) form.procedimento.value = prefill.procedimento;
  // Duração: prefill > inferir pelo procedimento > config padrão
  form.duracao.value = prefill.duracao || _inferirDuracao(form.procedimento.value) || getAgConfig().slotDuracao || 60;
  // Atualiza duração ao trocar procedimento
  form.procedimento.onchange = () => { form.duracao.value = _inferirDuracao(form.procedimento.value) || form.duracao.value; };
  form.status.value = 'Confirmado';
  document.querySelector('#modal-agendamento .modal-title').textContent = 'Novo Agendamento';
  document.getElementById('ag-conflito-aviso').style.display = 'none';
  const btnExcluir = document.getElementById('ag-excluir-btn');
  if (btnExcluir) btnExcluir.style.display = 'none';   // nada pra excluir num agendamento novo
  modal.style.display = 'flex';
}

function editAgendamento(id) {
  const ags = getAgendamentos();
  const a = ags.find(x => x.id === id);
  if (!a) return;
  editState = { col: null, idx: null, crmIdx: a.crmIdx ?? null, crmId: a.crmId ?? null, pacIdx: a.pacIdx ?? null, agId: id };
  const modal = document.getElementById('modal-agendamento');
  const form = modal.querySelector('form');
  const sel = document.getElementById('ag-procedimento');
  const procs = getProcedimentos();
  // Garante que o procedimento dele esteja no select
  let opts = procs.map(p => `<option value="${_esc(p.nome)}">${_esc(p.nome)}</option>`).join('');
  if (a.procedimento && !procs.some(p => p.nome === a.procedimento)) opts += `<option value="${_esc(a.procedimento)}">${_esc(a.procedimento)} (legado)</option>`;
  sel.innerHTML = opts;
  _popularProfissionalSelect(a.profissionalId);
  _agPopularDatalist();
  form.pacienteNome.oninput = _agAutocompletarContato;
  form.data.value = a.data;
  form.hora.value = a.hora;
  form.duracao.value = a.duracao || 60;
  form.pacienteNome.value = a.pacienteNome || '';
  form.whatsapp.value = a.whatsapp || '';
  form.procedimento.value = a.procedimento || '';
  form.status.value = a.status || 'Confirmado';
  form.obs.value = a.obs || '';
  _setTipoAtividade(a.tipoAtividade || 'Consultório');
  document.querySelector('#modal-agendamento .modal-title').textContent = 'Editar Agendamento';
  document.getElementById('ag-conflito-aviso').style.display = 'none';
  const btnExcluir = document.getElementById('ag-excluir-btn');
  if (btnExcluir) btnExcluir.style.display = '';   // só aparece ao editar um existente
  modal.style.display = 'flex';
}

function saveAgendamento(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const id = editState.agId || _agId();
  const item = {
    id,
    data: fd.get('data'),
    hora: fd.get('hora'),
    duracao: parseInt(fd.get('duracao')) || 60,
    pacienteNome: (fd.get('pacienteNome') || '').trim(),
    whatsapp: (fd.get('whatsapp') || '').trim(),
    procedimento: fd.get('procedimento') || '',
    profissionalId: fd.get('profissionalId') || null,
    status: fd.get('status') || 'Confirmado',
    obs: (fd.get('obs') || '').trim(),
    tipoAtividade: fd.get('tipoAtividade') || 'Consultório',
    crmIdx: editState.crmIdx ?? null,
    pacIdx: editState.pacIdx ?? null,
    // vínculos por id (Fase 1) — prefere o id estável; só cai no índice
    // congelado (crmIdx) se não houver id (que pode apontar pro contato errado
    // após a lista reordenar por um lead via realtime).
    crmId: editState.crmId ?? ((editState.crmIdx != null && DB.get('crm')[editState.crmIdx]) ? DB.get('crm')[editState.crmIdx].id : null),
    pacId: (editState.pacIdx != null && DB.get('pacientes')[editState.pacIdx]) ? DB.get('pacientes')[editState.pacIdx].id : null,
  };

  // Verifica conflito (ciente do profissional — Dr. A e Dr. B podem atender em paralelo)
  const conflito = _temConflito(item.data, item.hora, item.duracao, editState.agId, item.profissionalId || undefined);
  if (conflito && item.status !== 'Cancelado') {
    const aviso = document.getElementById('ag-conflito-aviso');
    aviso.style.display = 'block';
    aviso.innerHTML = `⚠️ Conflito com agendamento de <strong>${_esc(conflito.pacienteNome)}</strong> às ${_esc(conflito.hora)} (${conflito.duracao} min). Mude o horário ou cancele para continuar.`;
    return;
  }
  // Verifica bloqueio
  if (_isBloqueado(item.data, item.hora, item.duracao) && item.status !== 'Cancelado') {
    const aviso = document.getElementById('ag-conflito-aviso');
    aviso.style.display = 'block';
    aviso.innerHTML = `🚫 Este horário está em bloqueio. Remova o bloqueio ou escolha outro horário.`;
    return;
  }

  const ags = getAgendamentos();
  const idx = ags.findIndex(x => x.id === id);
  // Preserva campos de sistema do registro antigo (vínculo com programa,
  // marca da IA...) — editar não pode apagá-los.
  if (idx >= 0) {
    const antigo = ags[idx];
    ags[idx] = { ...antigo, ...item };
    // MAS: se a data ou a hora mudou (remarcação), o lembrete já enviado
    // não vale mais — rearma para que o novo horário receba um novo lembrete.
    if (antigo.data !== item.data || antigo.hora !== item.hora) {
      delete ags[idx]._lembreteEnviado;
      delete ags[idx]._lembreteErro;
    }
  } else ags.push(item);
  DB.set('agendamentos', ags);

  // Marca CRM como convertido se veio de lá (por id; fallback índice — Fase 1b)
  if ((item.crmId != null || (item.crmIdx !== null && item.crmIdx !== undefined)) && item.status === 'Confirmado') {
    const crm = DB.get('crm');
    const c = (item.crmId && crm.find(x => x.id === item.crmId)) || (item.crmIdx != null ? crm[item.crmIdx] : null);
    if (c) { c.status = 'Marcou'; c.converted = false; DB.set('crm', crm); }
  }

  closeModal('modal-agendamento');

  // Se status = "Compareceu" e ainda não virou paciente → propõe registrar atendimento
  if (item.status === 'Compareceu' && !item.pacIdx) {
    setTimeout(() => {
      if (confirm(`${item.pacienteNome} compareceu — deseja registrar o atendimento agora?`)) {
        _registrarAtendimentoDeAgendamento(item);
      }
    }, 200);
  }

  renderAgenda();
}

// Exclui (remove de vez) o agendamento aberto no modal de edição.
function excluirAgendamento() {
  if (!editState.agId) { closeModal('modal-agendamento'); return; }
  const ags  = getAgendamentos();
  const a    = ags.find(x => x.id === editState.agId);
  if (!a) { closeModal('modal-agendamento'); return; }
  const nome = a.pacienteNome || 'este agendamento';
  if (!confirm(`Excluir o agendamento de "${nome}"?\n\nEle será removido da agenda.`)) return;
  DB.set('agendamentos', ags.filter(x => x.id !== editState.agId));
  closeModal('modal-agendamento');
  renderAgenda();
  _toastUndo(`🗑️ Agendamento de "${nome}" excluído.`, () => {
    const atual = getAgendamentos();
    if (!atual.some(x => x.id === a.id)) atual.push(a);
    DB.set('agendamentos', atual);
    renderAgenda();
  });
}

function _gcalFmt(dateStr, timeStr) {
  // dateStr "YYYY-MM-DD", timeStr "HH:MM" → "YYYYMMDDTHHmmSS"
  const d = (dateStr || '').replace(/-/g, '');
  const t = (timeStr || '00:00').replace(':', '') + '00';
  return `${d}T${t}`;
}

function abrirGoogleCalendar() {
  const form = document.querySelector('#modal-agendamento form');
  if (!form) return;
  const fd = new FormData(form);
  const data = fd.get('data');
  const hora = fd.get('hora');
  const duracao = parseInt(fd.get('duracao')) || 60;
  const paciente = (fd.get('pacienteNome') || '').trim();
  const proc = fd.get('procedimento') || '';
  const wpp = (fd.get('whatsapp') || '').trim();
  const obs = (fd.get('obs') || '').trim();
  if (!data || !hora || !paciente) {
    toast('Preencha data, hora e paciente antes de exportar.', 2500);
    return;
  }
  // Calcula fim
  const [hh, mm] = hora.split(':').map(Number);
  const totalMin = hh * 60 + mm + duracao;
  const fimH = String(Math.floor(totalMin / 60) % 24).padStart(2, '0');
  const fimM = String(totalMin % 60).padStart(2, '0');
  const inicio = _gcalFmt(data, hora);
  const fim = _gcalFmt(data, `${fimH}:${fimM}`);

  const titulo = `${proc ? proc + ' — ' : ''}${paciente}`;
  const detalhes = [
    paciente && `Paciente: ${paciente}`,
    proc && `Procedimento: ${proc}`,
    wpp && `WhatsApp: ${wpp}`,
    obs && `Obs: ${obs}`,
    '',
    '— Criado via Consultório App',
  ].filter(Boolean).join('\n');

  const url = 'https://calendar.google.com/calendar/render?action=TEMPLATE'
    + '&text=' + encodeURIComponent(titulo)
    + '&dates=' + inicio + '/' + fim
    + '&details=' + encodeURIComponent(detalhes)
    + '&ctz=America/Sao_Paulo';
  window.open(url, '_blank');
  toast('📅 Abrindo Google Calendar em nova aba…', 2000);
}

function deleteAgendamento(id) {
  const antes = getAgendamentos();
  const a = antes.find(x => x.id === id);
  if (!confirm('Excluir este agendamento?')) return;
  DB.set('agendamentos', antes.filter(x => x.id !== id));
  renderAgenda();
  if (a) {
    _toastUndo(`Agendamento de "${a.pacienteNome || 'contato'}" excluído.`, () => {
      const atual = getAgendamentos();
      if (!atual.some(x => x.id === a.id)) atual.push(a);
      DB.set('agendamentos', atual);
      renderAgenda();
    });
  }
}

function updateAgStatus(id, novo) {
  const ags = getAgendamentos();
  const a = ags.find(x => x.id === id);
  if (!a) return;
  a.status = novo;
  DB.set('agendamentos', ags);

  // Sincronização reversa: agendamento → CRM (por id; fallback índice — Fase 1b)
  if (a.crmId != null || (a.crmIdx !== null && a.crmIdx !== undefined)) {
    const crm = DB.get('crm');
    const c = (a.crmId && crm.find(x => x.id === a.crmId)) || (a.crmIdx != null ? crm[a.crmIdx] : null);
    if (c) {
      let novoCrm = null;
      if (novo === 'Compareceu') novoCrm = 'Atendeu';
      else if (novo === 'Cancelado' || novo === 'Faltou') novoCrm = 'Não marcou';
      else if (novo === 'Confirmado' && c.status !== 'Marcou') novoCrm = 'Marcou';
      if (novoCrm && c.status !== novoCrm) {
        c.status = novoCrm;
        c._statusSince = new Date().toISOString();
        DB.set('crm', crm);
        if (document.getElementById('page-crm')?.classList.contains('active')) renderCrm();
      }
    }
  }

  if (novo === 'Compareceu' && !a.pacIdx) {
    if (confirm(`${a.pacienteNome} compareceu — registrar o atendimento agora?`)) {
      _registrarAtendimentoDeAgendamento(a);
    }
  }
  renderAgenda();
}

function _registrarAtendimentoDeAgendamento(a) {
  // Abre o modal de paciente pré-preenchido a partir do agendamento
  editState = { col: null, idx: null, crmIdx: a.crmIdx ?? null, pacIdx: null, agId: a.id };
  const modal = document.getElementById('modal-paciente');
  const form = modal.querySelector('form');
  popularProcedimentoSelect();
  const procs = getProcedimentos();
  form.data.value = a.data;
  form.nome.value = a.pacienteNome;
  if (form.whatsapp) form.whatsapp.value = a.whatsapp || '';
  _popularProfissionalSelect(a.profissionalId || currentProfissionalId || null, 'pac-profissional');
  form.tipo.value = procs.some(p => p.nome === a.procedimento) ? a.procedimento : (procs[0]?.nome || '');
  form.valor.value = '';
  form.pagamento.value = 'PIX';
  form.statusPgto.value = 'Pago';
  form.obs.value = a.obs || '';
  atualizarValorSugerido();
  modal.querySelector('.modal-title').textContent = 'Registrar Atendimento';
  modal.style.display = 'flex';
}

// ===== Configuração de horários =====
function openModalConfigHorarios() {
  const cfg = getAgConfig();
  const form = document.querySelector('#modal-config-horarios form');
  form.horaInicio.value = cfg.horaInicio;
  form.horaFim.value = cfg.horaFim;
  form.almocoInicio.value = cfg.almocoInicio || '';
  form.almocoFim.value = cfg.almocoFim || '';
  form.slotDuracao.value = cfg.slotDuracao;

  // Migra configs antigas que usavam slotsConsultorioDia único
  const semanalSalvo = cfg.slotsSemanais
    || (cfg.slotsConsultorioDia ? [0, cfg.slotsConsultorioDia, cfg.slotsConsultorioDia, cfg.slotsConsultorioDia, cfg.slotsConsultorioDia, cfg.slotsConsultorioDia, 0]
    : [0, 5, 0, 5, 5, 0, 0]);

  // Tabela per-day
  const diasNomes = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
  const slotsCont = document.getElementById('cfg-slots-semana');
  slotsCont.innerHTML = diasNomes.map((nome, i) => {
    const val = semanalSalvo[i] || 0;
    const barW = Math.round((val / 10) * 100);
    return `<div style="display:grid;grid-template-columns:34px 1fr 80px;align-items:center;gap:8px;">
      <span style="font-size:12px;font-weight:600;color:#166534;">${nome}</span>
      <div style="height:8px;background:#dcfce7;border-radius:4px;overflow:hidden;">
        <div id="cfg-bar-${i}" style="height:100%;width:${barW}%;background:#16a34a;border-radius:4px;transition:width .2s;"></div>
      </div>
      <div style="display:flex;align-items:center;gap:4px;">
        <input type="number" id="cfg-slot-dia-${i}" name="slotDia-${i}" value="${val}" min="0" max="20"
          style="width:46px;padding:2px 4px;border:1.5px solid #bbf7d0;border-radius:6px;font-size:13px;font-weight:700;color:#166534;text-align:center;background:#fff;"
          oninput="_cfgSlotsUpdate()" />
        <span style="font-size:11px;color:#4ade80;">slots</span>
      </div>
    </div>`;
  }).join('');
  _cfgSlotsUpdate();

  // Dias da semana (checkboxes existentes)
  document.getElementById('cfg-dias').innerHTML = diasNomes.map((nome, i) => {
    const ativo = cfg.diasUteis.includes(i);
    return `<label style="display:flex;align-items:center;gap:6px;padding:6px 10px;border:1.5px solid ${ativo ? '#10b981' : '#e2e8f0'};border-radius:8px;cursor:pointer;background:${ativo ? '#ecfdf5' : '#fff'};font-size:12.5px;font-weight:600;color:${ativo ? '#065f46' : '#64748b'};">
      <input type="checkbox" name="dia-${i}" ${ativo ? 'checked' : ''} style="cursor:pointer;" />
      ${nome}
    </label>`;
  }).join('');
}

function _cfgSlotsUpdate() {
  let total = 0;
  for (let i = 0; i < 7; i++) {
    const inp = document.getElementById(`cfg-slot-dia-${i}`);
    if (!inp) continue;
    const v = parseInt(inp.value) || 0;
    total += v;
    const bar = document.getElementById(`cfg-bar-${i}`);
    if (bar) bar.style.width = Math.round((v / 10) * 100) + '%';
  }
  const resumo = document.getElementById('cfg-slots-resumo');
  if (resumo) resumo.textContent = `Semana: ${total} slots · Mês: ~${total * 4} slots`;
}

function saveConfigHorarios(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const diasUteis = [];
  for (let i = 0; i < 7; i++) if (fd.get('dia-' + i)) diasUteis.push(i);
  // Coleta slots por dia
  const slotsSemanais = [];
  for (let i = 0; i < 7; i++) slotsSemanais.push(parseInt(fd.get('slotDia-' + i)) || 0);
  const cfg = {
    horaInicio: fd.get('horaInicio'),
    horaFim: fd.get('horaFim'),
    almocoInicio: fd.get('almocoInicio') || null,
    almocoFim: fd.get('almocoFim') || null,
    slotDuracao: parseInt(fd.get('slotDuracao')) || 60,
    slotsSemanais,
    diasUteis: diasUteis.length ? diasUteis : [1,2,3,4,5],
  };
  DB.setObj('agenda_config', cfg);
  closeModal('modal-config-horarios');
  renderAgenda();
  toast('Configuração salva');
}

// ===== Bloqueios =====
function openModalBloqueio() {
  document.querySelector('#modal-bloqueio form').reset();
  document.querySelector('#modal-bloqueio form').dataInicio.value = _ymd(new Date());
  document.querySelector('#modal-bloqueio form').dataFim.value = _ymd(new Date());
  renderBloqueiosList();
}

function renderBloqueiosList() {
  const lista = getBloqueios().sort((a, b) => (a.dataInicio + a.horaInicio).localeCompare(b.dataInicio + b.horaInicio));
  const el = document.getElementById('bloq-list');
  if (!el) return;
  if (!lista.length) { el.innerHTML = '<div style="font-size:12px;color:#94a3b8;text-align:center;padding:8px;">Nenhum bloqueio ativo</div>'; return; }
  el.innerHTML = `<div style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;margin-bottom:6px;">Bloqueios ativos</div>` +
    lista.map(b => `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:6px 8px;background:#fef3c7;border-radius:6px;margin-bottom:4px;font-size:12px;">
        <div>
          <strong>${_esc(b.motivo)}</strong>
          <div style="color:#78350f;font-size:11px;">${formatDate(b.dataInicio)} ${_esc(b.horaInicio || '')} → ${formatDate(b.dataFim)} ${_esc(b.horaFim || '')}</div>
        </div>
        <button onclick="deleteBloqueio('${_jsArg(b.id)}')" style="background:none;border:none;color:#991b1b;cursor:pointer;font-size:14px;">🗑️</button>
      </div>`).join('');
}

function saveBloqueio(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const item = {
    id: _agId(),
    motivo: fd.get('motivo'),
    dataInicio: fd.get('dataInicio'),
    horaInicio: fd.get('horaInicio') || '00:00',
    dataFim: fd.get('dataFim'),
    horaFim: fd.get('horaFim') || '23:59',
  };
  if (item.dataFim < item.dataInicio) { toast('Data fim antes do início'); return; }
  const bloqs = getBloqueios();
  bloqs.push(item);
  DB.set('bloqueios', bloqs);
  e.target.reset();
  document.querySelector('#modal-bloqueio form').dataInicio.value = _ymd(new Date());
  document.querySelector('#modal-bloqueio form').dataFim.value = _ymd(new Date());
  renderBloqueiosList();
  renderAgenda();
  toast('Bloqueio criado');
}

function deleteBloqueio(idEnc) {
  const id = decodeURIComponent(idEnc);
  if (!confirm('Remover este bloqueio?')) return;
  DB.set('bloqueios', getBloqueios().filter(b => b.id !== id));
  renderBloqueiosList();
  renderAgenda();
}

// ===== Drag-and-drop de agendamentos =====
let _agDragId = null;

function _agDragStart(e, id) {
  _agDragId = id;
  e.dataTransfer.effectAllowed = 'move';
  // Visual: opacidade reduzida durante o arrasto
  setTimeout(() => { if (e.target) e.target.style.opacity = '0.4'; }, 0);
}

function _agDragEnd(e) {
  if (e.target) e.target.style.opacity = '';
}

function _agDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  e.currentTarget.classList.add('ag-drop-hover');
}

function _agDragLeave(e) {
  e.currentTarget.classList.remove('ag-drop-hover');
}

function _agDrop(e, ds, hora) {
  e.preventDefault();
  e.stopPropagation();
  e.currentTarget.classList.remove('ag-drop-hover');
  if (!_agDragId) return;
  const ags = getAgendamentos();
  const idx = ags.findIndex(a => a.id === _agDragId);
  if (idx === -1) { _agDragId = null; return; }
  // Só re-renderiza se realmente mudou algo
  if (ags[idx].data === ds && ags[idx].hora === hora) { _agDragId = null; return; }
  // Mesmas validações do modal: arrastar não pode furar conflito nem bloqueio.
  const dur = ags[idx].duracao || 60;
  const conflito = _temConflito(ds, hora, dur, ags[idx].id, ags[idx].profissionalId || undefined);
  if (conflito) { toast(`⚠️ Conflito com ${conflito.pacienteNome} às ${conflito.hora}`); _agDragId = null; return; }
  if (typeof _isBloqueado === 'function' && _isBloqueado(ds, hora, dur)) {
    toast('⚠️ Esse horário está bloqueado na agenda'); _agDragId = null; return;
  }
  ags[idx].data = ds;
  ags[idx].hora = hora;
  DB.set('agendamentos', ags);
  _agDragId = null;
  renderAgenda();
}

// Drop no quadro de profissionais: além de mover hora, REATRIBUI o profissional
// da coluna em que soltou (arrastar do Dr. A pro Dr. B troca o responsável).
function _agDropProf(e, ds, hora, profId) {
  e.preventDefault();
  e.stopPropagation();
  e.currentTarget.classList.remove('ag-drop-hover');
  if (!_agDragId) return;
  const ags = getAgendamentos();
  const idx = ags.findIndex(a => a.id === _agDragId);
  if (idx === -1) { _agDragId = null; return; }
  const novoProf = profId || null;
  if (ags[idx].data === ds && ags[idx].hora === hora && (ags[idx].profissionalId || null) === novoProf) { _agDragId = null; return; }
  // Mesmas validações do modal (considerando o NOVO profissional da coluna).
  const durP = ags[idx].duracao || 60;
  const conflitoP = _temConflito(ds, hora, durP, ags[idx].id, novoProf || undefined);
  if (conflitoP) { toast(`⚠️ Conflito com ${conflitoP.pacienteNome} às ${conflitoP.hora}`); _agDragId = null; return; }
  if (typeof _isBloqueado === 'function' && _isBloqueado(ds, hora, durP)) {
    toast('⚠️ Esse horário está bloqueado na agenda'); _agDragId = null; return;
  }
  ags[idx].data = ds;
  ags[idx].hora = hora;
  ags[idx].profissionalId = novoProf;
  DB.set('agendamentos', ags);
  _agDragId = null;
  renderAgenda();
}

// ===== Render principal =====
function renderAgenda() {
  // Filtro de profissional (sincroniza dropdown + trava se for login de profissional)
  _popularFiltroProfAgenda();
  // Reflete o agView atual nas abas (cobre o default mobile 'dia' e qualquer
  // mudança de agView que não passou por setAgendaView).
  ['dia', 'semana', 'mes', 'profissionais'].forEach(view => {
    const btn = document.getElementById('btn-ag-' + view);
    if (btn) btn.classList.toggle('active', view === agView);
  });
  // Atualiza KPIs
  _renderAgendaKPIs();

  // Label do período
  const labelEl = document.getElementById('ag-periodo-label');
  if (labelEl) labelEl.textContent = _labelPeriodo();

  const cont = document.getElementById('ag-container');
  if (!cont) return;

  // Banner de reservas da IA aguardando confirmação (status Pendente).
  // Sem isso, a IA marcava e o dono nunca via — pior que não marcar.
  let bannerIa = document.getElementById('ag-pendentes-ia');
  const pendentesIa = DB.get('agendamentos').filter(a => a.status === 'Pendente');
  if (pendentesIa.length) {
    if (!bannerIa) {
      bannerIa = document.createElement('div');
      bannerIa.id = 'ag-pendentes-ia';
      cont.parentNode.insertBefore(bannerIa, cont);
    }
    bannerIa.innerHTML = `<div style="background:#fef3c7;border:1.5px solid #f59e0b;border-radius:12px;padding:12px 16px;margin-bottom:14px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
      <span style="font-size:18px;">🤖</span>
      <span style="font-size:13px;color:#92400e;font-weight:600;">${pendentesIa.length} horário(s) reservado(s) pela secretária IA aguardando sua confirmação</span>
      <span style="font-size:12px;color:#b45309;">— ${pendentesIa.slice(0, 3).map(a => `${_esc(a.pacienteNome || '?')} ${formatDate(a.data)} ${_esc(a.hora)}`).join(' · ')}${pendentesIa.length > 3 ? '…' : ''}. Clique no evento amarelo para confirmar ou cancelar.</span>
    </div>`;
  } else if (bannerIa) {
    bannerIa.remove();
  }

  if (agView === 'mes') cont.innerHTML = _viewMes();
  else if (agView === 'semana') cont.innerHTML = _viewSemana();
  else if (agView === 'profissionais') cont.innerHTML = _viewProfissionais();
  else cont.innerHTML = _viewDia();
}

function _labelPeriodo() {
  if (agView === 'dia' || agView === 'profissionais') {
    return DIAS[agAnchor.getDay()] + ', ' + agAnchor.getDate() + ' ' + MESES[agAnchor.getMonth()] + ' ' + agAnchor.getFullYear();
  }
  if (agView === 'semana') {
    const ini = _startOfWeek(agAnchor);
    const fim = _addDays(ini, 6);
    return ini.getDate() + ' ' + MESES[ini.getMonth()] + ' – ' + fim.getDate() + ' ' + MESES[fim.getMonth()] + ' ' + fim.getFullYear();
  }
  return MESES[agAnchor.getMonth()] + ' ' + agAnchor.getFullYear();
}

function _renderAgendaKPIs() {
  const ags = _agsVisiveis();
  // Filtra agendamentos no período da view
  let ini, fim;
  if (agView === 'dia' || agView === 'profissionais') { ini = new Date(agAnchor); fim = new Date(agAnchor); }
  else if (agView === 'semana'){ ini = _startOfWeek(agAnchor); fim = _addDays(ini, 6); }
  else { ini = new Date(agAnchor.getFullYear(), agAnchor.getMonth(), 1); fim = new Date(agAnchor.getFullYear(), agAnchor.getMonth() + 1, 0); }
  const iniStr = _ymd(ini), fimStr = _ymd(fim);
  const ativos = ags.filter(a => a.data >= iniStr && a.data <= fimStr);

  const confirmados  = ativos.filter(a => a.status === 'Confirmado').length;
  const compareceram = ativos.filter(a => a.status === 'Compareceu').length;
  const noshow       = ativos.filter(a => a.status === 'No-show').length;
  const total        = confirmados + compareceram + noshow;

  // Ocupação: só conta consultas no consultório vs. slots configurados por dia
  const cfg2 = getAgConfig();
  const slotsSemanais = cfg2.slotsSemanais
    || (cfg2.slotsConsultorioDia ? Array(7).fill(0).map((_, i) => (cfg2.diasUteis.includes(i) ? cfg2.slotsConsultorioDia : 0)) : [0,5,0,5,5,0,0]);
  let slotsDispo = 0;
  for (let d = new Date(ini); d <= fim; d = _addDays(d, 1)) {
    slotsDispo += slotsSemanais[d.getDay()] || 0;
  }
  const slotsUsados = ativos.filter(a => a.status !== 'Cancelado' && (!a.tipoAtividade || a.tipoAtividade === 'Consultório')).length;
  const ocup = slotsDispo ? (slotsUsados / slotsDispo) * 100 : 0;

  // Receita perdida = no-shows × ticket médio do procedimento
  const procs = getProcedimentos();
  let perdida = 0;
  ativos.filter(a => a.status === 'No-show').forEach(a => {
    const p = procs.find(x => x.nome === a.procedimento);
    perdida += p ? (p.valorPix || p.valorCartao || 0) : 0;
  });

  const cancelados   = ativos.filter(a => a.status === 'Cancelado').length;
  const totalAgendados = ativos.length;        // tudo no período
  const naoCancelados  = totalAgendados - cancelados;

  // "Agendados" = total de agendamentos no período (não só status 'Confirmado')
  setText('ag-confirmados', totalAgendados);
  setText('ag-confirmados-sub', cancelados > 0
    ? `${naoCancelados} ativos · ${cancelados} cancelado(s)`
    : (confirmados > 0 ? `${confirmados} a confirmar` : 'no período'));
  setText('ag-compareceram', compareceram);
  setText('ag-compareceram-sub', total ? `${PCT((compareceram / total) * 100)} compareceram` : 'sem comparecimentos');
  setText('ag-noshow', noshow);
  setText('ag-noshow-sub', total ? `${PCT((noshow / total) * 100)} no-show` : '—');
  setText('ag-ocup', PCT(ocup));
  setText('ag-ocup-sub', `${slotsUsados} de ${slotsDispo} slots no consultório`);
  setText('ag-perdida', BRL(perdida));

  // Resumo de 1 linha pro toggle mobile (os cards completos ficam colapsados).
  setText('ag-kpi-resumo-mobile', `${totalAgendados} agendado(s) · ${compareceram} compareceu(ram) · ${PCT(ocup)} ocupação`);
}

// Expande/recolhe os KPIs completos da agenda no celular (por padrão vêm
// colapsados num resumo de 1 linha — o calendário é o que importa primeiro).
function _toggleAgKpisMobile() {
  const grid = document.getElementById('ag-kpis-grid');
  const icon = document.getElementById('ag-kpi-toggle-icon');
  if (!grid) return;
  const expandido = grid.classList.toggle('ag-kpis-expanded');
  if (icon) icon.textContent = expandido ? '▴' : '▾';
}

function _viewMes() {
  const ano = agAnchor.getFullYear(); const mes = agAnchor.getMonth();
  const primeiro = new Date(ano, mes, 1);
  const inicio = _addDays(primeiro, -((primeiro.getDay() + 6) % 7));
  const ags = _agsVisiveis();
  const bloqs = getBloqueios();
  const hojeStr = _ymd(new Date());
  const cfg = getAgConfig();

  const cabec = ['SEG','TER','QUA','QUI','SEX','SÁB','DOM'].map(d => `<div class="cal-head">${d}</div>`).join('');
  const dias = [];
  for (let i = 0; i < 42; i++) {
    const d = _addDays(inicio, i);
    const ds = _ymd(d);
    const outside = d.getMonth() !== mes;
    const today = ds === hojeStr;
    const naoUtil = !cfg.diasUteis.includes(d.getDay());
    const bloqDay = bloqs.some(b => ds >= b.dataInicio && ds <= b.dataFim);
    const events = ags.filter(a => a.data === ds).sort((a, b) => a.hora.localeCompare(b.hora));
    const evtHtml = events.slice(0, 3).map(a => {
      const cls = (a.status || 'confirmado').toLowerCase().replace('no-show', 'noshow');
      const lbl = `${_esc(a.hora)} ${_esc(a.pacienteNome)}`;
      return `<div class="cal-evt ${cls}" onclick="event.stopPropagation();editAgendamento('${a.id}')" title="${_esc(a.pacienteNome)} — ${_esc(a.procedimento || '')}">${lbl}</div>`;
    }).join('');
    const more = events.length > 3 ? `<div class="cal-more">+${events.length - 3} mais</div>` : '';
    const classes = ['cal-day', outside && 'outside', today && 'today', bloqDay && 'has-blockage'].filter(Boolean).join(' ');
    dias.push(`<div class="${classes}" onclick="agAnchor=new Date('${ds}T12:00:00');setAgendaView('dia');">
      <div class="cal-day-num">${d.getDate()}${naoUtil && !outside ? ' <span style="color:#cbd5e1;font-size:9px;">·</span>' : ''}</div>
      ${evtHtml}${more}
    </div>`);
  }
  return `<div style="padding:14px;">
    <div class="cal-grid">${cabec}${dias.join('')}</div>
  </div>`;
}

function _viewSemana() { return _viewWeekOrDay(7); }
function _viewDia()    { return _viewWeekOrDay(1); }

// Cores e estilos por tipo de atividade
const _TIPO_STYLE = {
  'Consultório':      { bg:'#eff6ff', color:'#1d4ed8', border:'#3b82f6', icon:'🏥' },
  'Visita Domiciliar':{ bg:'#fff7ed', color:'#9a3412', border:'#f97316', icon:'🏠' },
  'Visita Hospitalar':{ bg:'#fdf4ff', color:'#7e22ce', border:'#a855f7', icon:'🏨' },
  'Outro':            { bg:'#f8fafc', color:'#475569', border:'#94a3b8', icon:'📌' },
};

function _setTipoAtividade(tipo) {
  document.getElementById('ag-tipo-hidden').value = tipo;
  document.querySelectorAll('.ag-tipo-btn').forEach(btn => {
    const t = btn.dataset.tipo;
    const s = _TIPO_STYLE[t] || _TIPO_STYLE['Outro'];
    if (t === tipo) {
      btn.style.border = `2px solid ${s.border}`;
      btn.style.background = s.bg;
      btn.style.color = s.color;
    } else {
      btn.style.border = '2px solid #e2e8f0';
      btn.style.background = '#f8fafc';
      btn.style.color = '#64748b';
    }
  });
  // Duração: domiciliar/hospitalar não têm slot padrão
  const durEl = document.querySelector('#modal-agendamento [name="duracao"]');
  if (durEl && (tipo === 'Visita Domiciliar' || tipo === 'Visita Hospitalar')) {
    durEl.value = durEl.value || 60;
  }
}

function _viewWeekOrDay(numDias) {
  const cfg    = getAgConfig();
  const ini    = numDias === 7 ? _startOfWeek(agAnchor) : new Date(agAnchor);
  const ags    = _agsVisiveis();
  const hojeStr = _ymd(new Date());

  const SNAP    = 10;
  const iniMin  = _toMin(cfg.horaInicio);
  const fimMin  = _toMin(cfg.horaFim);
  const totalMin = fimMin - iniMin;
  // PX_MIN dinâmico: cabe o dia inteiro sem scroll (alvo ~620px)
  const targetH = Math.max(window.innerHeight - 300, 400);
  const PX_MIN  = targetH / totalMin;
  const totalH  = totalMin * PX_MIN;

  // ── Cabeçalho ──────────────────────────────────────────────
  let headHtml = `<div style="width:52px;flex-shrink:0;background:#fafafa;border-bottom:2px solid #e5e7eb;border-right:1px solid #e5e7eb;"></div>`;
  for (let i = 0; i < numDias; i++) {
    const d     = _addDays(ini, i);
    const ds    = _ymd(d);
    const today = ds === hojeStr;
    const naoUtil = !cfg.diasUteis.includes(d.getDay());
    headHtml += `<div class="week-head ${today ? 'today' : ''}" style="flex:1;${naoUtil ? 'color:#cbd5e1;' : ''}">${DIAS[d.getDay()]}<br><span style="font-size:13px;color:${today ? '#065f46' : '#0f172a'};font-weight:800;">${d.getDate()}/${String(d.getMonth() + 1).padStart(2, '0')}</span></div>`;
  }

  // ── Eixo de horas ──────────────────────────────────────────
  let timeAxis = `<div style="position:relative;width:52px;flex-shrink:0;border-right:1px solid #e5e7eb;">`;
  for (let m = iniMin; m <= fimMin; m += 60) {
    const top = (m - iniMin) * PX_MIN;
    timeAxis += `<div style="position:absolute;top:${top}px;right:7px;transform:translateY(-50%);font-size:10px;color:#9ca3af;white-space:nowrap;line-height:1;">${_toHHMM(m)}</div>`;
  }
  timeAxis += `</div>`;

  // ── Colunas de dias ────────────────────────────────────────
  let dayCols = '';
  for (let i = 0; i < numDias; i++) {
    const d       = _addDays(ini, i);
    const ds      = _ymd(d);
    const naoUtil = !cfg.diasUteis.includes(d.getDay());

    // Linhas de hora (guias visuais)
    let guides = '';
    for (let m = iniMin; m <= fimMin; m += 60) {
      const top = (m - iniMin) * PX_MIN;
      guides += `<div style="position:absolute;top:${top}px;left:0;right:0;height:1px;background:#e5e7eb;pointer-events:none;z-index:0;"></div>`;
    }
    for (let m = iniMin + 30; m < fimMin; m += 60) {
      const top = (m - iniMin) * PX_MIN;
      guides += `<div style="position:absolute;top:${top}px;left:0;right:0;height:1px;background:#f3f4f6;pointer-events:none;z-index:0;"></div>`;
    }

    // Drop targets (10 em 10 minutos)
    let drops = '';
    for (let m = iniMin; m < fimMin; m += SNAP) {
      const top      = (m - iniMin) * PX_MIN;
      const h        = SNAP * PX_MIN;
      const hora     = _toHHMM(m);
      const bloq     = _isBloqueado(ds, hora, SNAP);
      const disabled = naoUtil || bloq;
      const bgBloq   = bloq ? 'background:repeating-linear-gradient(45deg,transparent,transparent 4px,rgba(251,191,36,0.08) 4px,rgba(251,191,36,0.08) 8px);' : '';
      drops += `<div
        style="position:absolute;top:${top}px;left:0;right:0;height:${h}px;z-index:1;cursor:${disabled ? 'not-allowed' : 'pointer'};${bgBloq}"
        class="week-slot-micro${disabled ? ' fora' : ''}"
        ${!disabled ? `onclick="openNovoAgendamento({data:'${ds}', hora:'${hora}'})"` : ''}
        ondragover="_agDragOver(event)"
        ondragleave="_agDragLeave(event)"
        ondrop="_agDrop(event,'${ds}','${hora}')"></div>`;
    }

    // Eventos
    const dayAgs = ags.filter(a => a.data === ds);
    let evts = '';
    dayAgs.forEach(a => {
      const startMin = _toMin(a.hora);
      const dur      = parseInt(a.duracao) || 60;
      const top      = (startMin - iniMin) * PX_MIN;
      const height   = Math.max(dur * PX_MIN - 2, 18);
      const tipo     = a.tipoAtividade || 'Consultório';
      const ts       = _TIPO_STYLE[tipo] || _TIPO_STYLE['Consultório'];
      const ec       = (a.status || 'confirmado').toLowerCase().replace('no-show', 'noshow');
      const showDur  = height >= 30;
      const isCancelado = ec === 'cancelado';
      const profObj  = a.profissionalId ? getProfissional(a.profissionalId) : null;
      const corProf  = profObj ? profObj.cor : null;
      const profNome = profObj ? (profObj.nome || '').split(' ')[0] : '';
      const borda    = isCancelado ? '#d1d5db' : (corProf || ts.border);
      evts += `<div class="week-evt ${ec}"
        style="position:absolute;top:${top}px;left:3px;right:3px;height:${height}px;z-index:3;overflow:hidden;
               cursor:grab;background:${isCancelado ? '#f5f5f5' : ts.bg};
               color:${isCancelado ? '#9ca3af' : ts.color};border-left:4px solid ${borda};"
        draggable="true"
        ondragstart="_agDragStart(event,'${a.id}')"
        ondragend="_agDragEnd(event)"
        onclick="event.stopPropagation();editAgendamento('${a.id}')"
        title="${ts.icon} ${_esc(a.pacienteNome)} — ${_esc(a.procedimento || tipo)} (${dur}min)${profNome ? ' · ' + _esc(profObj.nome) : ''}">
        <strong style="font-size:10.5px;">${ts.icon} ${_esc(a.pacienteNome)}</strong>
        ${showDur ? `<br><span style="font-size:9px;opacity:0.75;">${_esc(a.procedimento || tipo)} · ${dur}min${profNome ? ' · <span style="color:'+borda+';font-weight:700;">'+_esc(profNome)+'</span>' : ''}</span>` : ''}
      </div>`;
    });

    dayCols += `<div style="flex:1;position:relative;height:${totalH}px;border-right:1px solid #e5e7eb;background:${naoUtil ? '#fafafa' : '#fff'};">${guides}${drops}${evts}</div>`;
  }

  return `<div style="padding:14px;">
    <div style="border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
      <div style="display:flex;background:#fafafa;border-bottom:2px solid #e5e7eb;">${headHtml}</div>
      <div style="display:flex;">
        ${timeAxis}
        <div style="display:flex;flex:1;">${dayCols}</div>
      </div>
    </div>
  </div>`;
}

// ===== Quadro de profissionais (1 dia, 1 coluna por profissional) =====
function _viewProfissionais() {
  const cfg     = getAgConfig();
  const ags     = getAgendamentos();
  const dayStr  = _ymd(agAnchor);
  const naoUtil = !cfg.diasUteis.includes(agAnchor.getDay());

  const SNAP     = 10;
  const iniMin   = _toMin(cfg.horaInicio);
  const fimMin   = _toMin(cfg.horaFim);
  const totalMin = fimMin - iniMin;
  const targetH  = Math.max(window.innerHeight - 300, 400);
  const PX_MIN   = targetH / totalMin;
  const totalH   = totalMin * PX_MIN;

  const dayAgs = ags.filter(a => a.data === dayStr);
  const todosProfs = getProfissionaisAtivos();
  // Filtro ativo → quadro mostra só a coluna daquele profissional
  const profs  = _agFiltroProf ? todosProfs.filter(p => p.id === _agFiltroProf) : todosProfs;
  const ehDaColuna = (a, colId) => {
    const pid = a.profissionalId || null;
    if (colId === null) return !pid || !todosProfs.some(p => p.id === pid); // genuinamente sem dono
    return pid === colId;
  };

  const colunas = profs.map(p => ({ id: p.id, nome: p.nome, cor: p.cor }));
  // Coluna "Sem profissional" só sem filtro (com filtro, foco em 1 profissional)
  if (!_agFiltroProf && dayAgs.some(a => ehDaColuna(a, null))) colunas.push({ id: null, nome: 'Sem profissional', cor: '#94a3b8' });
  if (!colunas.length) {
    return `<div style="padding:48px 20px;text-align:center;color:#94a3b8;font-size:13px;">Cadastre profissionais em <strong>Configurações → Profissionais da clínica</strong> para usar o quadro.</div>`;
  }
  const COLW = 150;
  const minW = 52 + colunas.length * COLW;

  // Cabeçalho
  let headHtml = `<div style="width:52px;flex-shrink:0;background:#fafafa;border-bottom:2px solid #e5e7eb;border-right:1px solid #e5e7eb;"></div>`;
  colunas.forEach(c => {
    const n = dayAgs.filter(a => ehDaColuna(a, c.id) && a.status !== 'Cancelado').length;
    headHtml += `<div style="flex:1;min-width:${COLW}px;text-align:center;padding:8px 4px;border-bottom:3px solid ${c.cor};border-right:1px solid #e5e7eb;">
      <div style="display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:700;color:#0f172a;"><span style="width:9px;height:9px;border-radius:3px;background:${c.cor};flex-shrink:0;"></span>${_esc(c.nome)}</div>
      <div style="font-size:10.5px;color:#94a3b8;font-weight:600;margin-top:1px;">${n} agend.</div></div>`;
  });

  // Eixo de horas
  let timeAxis = `<div style="position:relative;width:52px;flex-shrink:0;border-right:1px solid #e5e7eb;">`;
  for (let m = iniMin; m <= fimMin; m += 60) {
    const top = (m - iniMin) * PX_MIN;
    timeAxis += `<div style="position:absolute;top:${top}px;right:7px;transform:translateY(-50%);font-size:10px;color:#9ca3af;white-space:nowrap;line-height:1;">${_toHHMM(m)}</div>`;
  }
  timeAxis += `</div>`;

  // Colunas
  let cols = '';
  colunas.forEach(c => {
    let guides = '';
    for (let m = iniMin; m <= fimMin; m += 60) { const top=(m-iniMin)*PX_MIN; guides += `<div style="position:absolute;top:${top}px;left:0;right:0;height:1px;background:#e5e7eb;pointer-events:none;z-index:0;"></div>`; }
    for (let m = iniMin+30; m < fimMin; m += 60) { const top=(m-iniMin)*PX_MIN; guides += `<div style="position:absolute;top:${top}px;left:0;right:0;height:1px;background:#f3f4f6;pointer-events:none;z-index:0;"></div>`; }

    let drops = '';
    for (let m = iniMin; m < fimMin; m += SNAP) {
      const top = (m-iniMin)*PX_MIN, h = SNAP*PX_MIN, hora = _toHHMM(m);
      const bloq = _isBloqueado(dayStr, hora, SNAP);
      const disabled = naoUtil || bloq;
      const bgBloq = bloq ? 'background:repeating-linear-gradient(45deg,transparent,transparent 4px,rgba(251,191,36,0.08) 4px,rgba(251,191,36,0.08) 8px);' : '';
      const profArg = c.id ? `, profissionalId:'${c.id}'` : '';
      drops += `<div style="position:absolute;top:${top}px;left:0;right:0;height:${h}px;z-index:1;cursor:${disabled?'not-allowed':'pointer'};${bgBloq}" class="week-slot-micro${disabled?' fora':''}" ${!disabled?`onclick="openNovoAgendamento({data:'${dayStr}', hora:'${hora}'${profArg}})"`:''} ondragover="_agDragOver(event)" ondragleave="_agDragLeave(event)" ondrop="_agDropProf(event,'${dayStr}','${hora}',${c.id?`'${c.id}'`:'null'})"></div>`;
    }

    let evts = '';
    dayAgs.filter(a => ehDaColuna(a, c.id)).forEach(a => {
      const startMin = _toMin(a.hora);
      const dur = parseInt(a.duracao) || 60;
      const top = (startMin - iniMin) * PX_MIN;
      const height = Math.max(dur * PX_MIN - 2, 18);
      const tipo = a.tipoAtividade || 'Consultório';
      const ts = _TIPO_STYLE[tipo] || _TIPO_STYLE['Consultório'];
      const ec = (a.status||'confirmado').toLowerCase().replace('no-show','noshow');
      const isCancelado = ec === 'cancelado';
      const showDur = height >= 30;
      const borda = isCancelado ? '#d1d5db' : c.cor;
      evts += `<div class="week-evt ${ec}" style="position:absolute;top:${top}px;left:3px;right:3px;height:${height}px;z-index:3;overflow:hidden;cursor:grab;background:${isCancelado?'#f5f5f5':ts.bg};color:${isCancelado?'#9ca3af':ts.color};border-left:4px solid ${borda};" draggable="true" ondragstart="_agDragStart(event,'${a.id}')" ondragend="_agDragEnd(event)" onclick="event.stopPropagation();editAgendamento('${a.id}')" title="${ts.icon} ${_esc(a.pacienteNome)} — ${_esc(a.procedimento||tipo)} (${dur}min)">
        <strong style="font-size:10.5px;">${ts.icon} ${_esc(a.pacienteNome)}</strong>
        ${showDur ? `<br><span style="font-size:9px;opacity:0.75;">${_esc(a.hora)} · ${_esc(a.procedimento||tipo)}</span>` : ''}
      </div>`;
    });

    cols += `<div style="flex:1;min-width:${COLW}px;position:relative;height:${totalH}px;border-right:1px solid #e5e7eb;background:${naoUtil?'#fafafa':'#fff'};">${guides}${drops}${evts}</div>`;
  });

  return `<div style="padding:14px;">
    <div style="border:1px solid #e5e7eb;border-radius:8px;overflow-x:auto;">
      <div style="display:flex;background:#fafafa;border-bottom:2px solid #e5e7eb;min-width:${minW}px;">${headHtml}</div>
      <div style="display:flex;min-width:${minW}px;">
        ${timeAxis}
        <div style="display:flex;flex:1;">${cols}</div>
      </div>
    </div>
  </div>`;
}

// (renderAgenda agora está acima — Nível 3)

// ====================== DESPESAS ======================
function saveDespesa(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const valorDesp = parseFloat(fd.get('valor')) || 0;
  if (valorDesp < 0) { alert('Valor não pode ser negativo.'); return; }
  const item = { data: fd.get('data'), descricao: fd.get('descricao'), categoria: fd.get('categoria'), tipo: fd.get('tipo'), valor: valorDesp, formaPgto: fd.get('formaPgto') };
  const data = DB.get('despesas');
  if (editState.col === 'despesas' && editState.idx !== null) {
    item.id = (data[editState.idx] && data[editState.idx].id) || _novoId('desp'); // id estável sobrevive à edição
    data[editState.idx] = item;
  } else { item.id = _novoId('desp'); data.unshift(item); }
  DB.set('despesas', data);
  closeModal('modal-despesa');
  renderDespesas();
  // Atualiza dashboard se estiver visível (despesas afetam lucro/burn/runway)
  if (document.getElementById('page-dashboard')?.classList.contains('active')) renderDashboard();
  _auditLog(editState.idx != null ? 'editou' : 'criou', 'despesa', `${editState.idx != null ? 'Editou' : 'Lançou'} despesa: ${item.descricao} (${BRL(item.valor)})`);
}

// ====================== RECEITA ======================
const _MESES_FULL = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

// Popula qualquer select de mês com os últimos 24 meses até hoje (ordem decrescente).
// Se includeTodos=true, adiciona opção "Todos" no final.
function _populateMesSelect(id, { includeTodos = false, selected = null } = {}) {
  const el = document.getElementById(id);
  if (!el) return;
  const prevVal = selected ?? el.value;
  const hoje = new Date();
  const opts = [];
  for (let i = 0; i < 24; i++) {
    const d = new Date(hoje.getFullYear(), hoje.getMonth() - i, 1);
    const key = _ymd(d).substring(0, 7);
    const label = `${_MESES_FULL[d.getMonth()]} ${d.getFullYear()}`;
    opts.push(`<option value="${key}">${label}</option>`);
  }
  if (includeTodos) opts.push('<option value="todos">Todos</option>');
  el.innerHTML = opts.join('');
  el.value = prevVal && Array.from(el.options).some(o => o.value === prevVal) ? prevVal : _ymd(hoje).substring(0, 7);
}

function _populateRecMesFilter() { _populateMesSelect('rec-mes-filter', { includeTodos: true }); }

function renderReceita() {
  _populateRecMesFilter();
  const mesEl = document.getElementById('rec-mes-filter');
  const buscaEl = document.getElementById('rec-busca');
  const statusEl = document.getElementById('rec-status-filter');
  const pgtoEl = document.getElementById('rec-pgto-filter');
  if (!mesEl) return;
  const mes = mesEl.value;
  const busca = (buscaEl?.value || '').toLowerCase().trim();
  const fStatus = statusEl?.value || '';
  const fPgto = pgtoEl?.value || '';

  // Carrega UMA vez — mesma instância para indexOf funcionar corretamente
  const todosOriginais = DB.get('pacientes');
  let pacs = todosOriginais;
  if (mes !== 'todos') pacs = todosOriginais.filter(p => getMes(p.data) === mes);
  const indices = pacs.map(p => todosOriginais.indexOf(p));

  // ===== KPIs (sempre sobre todo o período selecionado, ignorando filtros de tabela) =====
  const _rf = _resumoFin(pacs);
  const recebido = _rf.recebido;         // CAIXA
  const aReceber = _rf.aReceber;         // Pendente + Parcial (antes o Parcial sumia)
  const isento  = _rf.isento;
  const bruto   = _rf.bruto;
  const ticket  = pacs.length ? bruto / pacs.length : 0;

  setText('rec-recebido', BRL(recebido));
  setText('rec-recebido-sub', `${pacs.filter(p => p.statusPgto === 'Pago').length} atendimentos pagos`);
  setText('rec-areceber', BRL(aReceber));
  setText('rec-areceber-sub', `${pacs.filter(p => p.statusPgto === 'Pendente' || p.statusPgto === 'Parcial').length} pendente(s)/parcial(is)`);
  setText('rec-isento', BRL(isento));
  setText('rec-isento-sub', `${pacs.filter(p => p.statusPgto === 'Isento').length} atendimento(s)`);
  setText('rec-bruto', BRL(bruto));
  // Mostra as duas leituras; a segunda só quando existe atendimento gratuito
  // (sem gratuitos os números são idênticos e repetir vira ruído).
  const _tk = _ticketMedio(pacs);
  setText('rec-bruto-sub', `Ticket médio: ${BRL(_tk.porConsultaPaga)} por consulta paga`
    + (_tk.qtdGratuitos ? ` · ${BRL(_tk.porAtendimento)} por atendimento (${_tk.qtdGratuitos} gratuito(s))` : '')
    + ` · ${_tk.qtdAtendimentos} atendimento(s)`);

  // ===== Quebra por forma de pagamento (só pagos) =====
  const pagosPorForma = pacs.filter(p => p.statusPgto === 'Pago');
  const formas = ['PIX','Cartão crédito','Cartão débito','Dinheiro','A receber'];
  const formasStats = formas.map(f => {
    const lista = pagosPorForma.filter(p => p.pagamento === f);
    return { forma: f, qtd: lista.length, total: lista.reduce((s, p) => s + (p.valor || 0), 0) };
  }).filter(s => s.qtd > 0).sort((a, b) => b.total - a.total);

  const formasEl = document.getElementById('rec-formas');
  if (!formasStats.length) {
    formasEl.innerHTML = '<div style="text-align:center;color:#94a3b8;font-size:13px;padding:20px;">Sem dados</div>';
  } else {
    const max = Math.max(...formasStats.map(s => s.total), 1);
    const cores = { 'PIX': '#10b981', 'Cartão crédito': '#3b82f6', 'Cartão débito': '#06b6d4', 'Dinheiro': '#f59e0b', 'A receber': '#94a3b8' };
    formasEl.innerHTML = formasStats.map(s => {
      const pctBar = (s.total / max) * 100;
      const pctTotal = recebido ? (s.total / recebido) * 100 : 0;
      const cor = cores[s.forma] || '#64748b';
      return `
        <div style="margin-bottom:10px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
            <div style="font-size:12.5px;font-weight:600;color:#0f172a;">${s.forma} <span style="color:#94a3b8;font-weight:400;font-size:11.5px;">(${s.qtd})</span></div>
            <div style="font-size:12.5px;font-weight:700;color:#0f172a;">${BRL(s.total)} <span style="font-size:10.5px;color:#94a3b8;font-weight:500;">${PCT(pctTotal)}</span></div>
          </div>
          <div style="height:6px;background:#f1f5f9;border-radius:999px;overflow:hidden;">
            <div style="height:100%;width:${pctBar}%;background:${cor};border-radius:999px;"></div>
          </div>
        </div>`;
    }).join('');
  }

  // ===== Quebra por procedimento (distingue programas) =====
  const procMap = {};
  pacs.forEach(p => {
    let k;
    if ((p.obs || '').includes('[Programa')) {
      k = p.procedimento || 'Programa de assinatura';
    } else {
      k = p.tipo || p.procedimento || '(sem procedimento)';
    }
    if (!procMap[k]) procMap[k] = { qtd: 0, total: 0, isProg: (p.obs||'').includes('[Programa') };
    procMap[k].qtd++;
    procMap[k].total += (p.valor || 0);
  });
  const procsStats = Object.entries(procMap).map(([nome, v]) => ({ nome, ...v })).sort((a, b) => b.total - a.total);

  const procsEl = document.getElementById('rec-procs');
  if (!procsStats.length) {
    procsEl.innerHTML = '<div style="text-align:center;color:#94a3b8;font-size:13px;padding:20px;">Sem dados</div>';
  } else {
    const max = Math.max(...procsStats.map(s => s.total), 1);
    procsEl.innerHTML = procsStats.map(s => {
      const pctBar = (s.total / max) * 100;
      const ticketProc = s.qtd ? s.total / s.qtd : 0;
      return `
        <div style="margin-bottom:10px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
            <div style="font-size:12.5px;font-weight:600;color:#0f172a;">${_esc(s.nome)} <span style="color:#94a3b8;font-weight:400;font-size:11.5px;">(${s.qtd})</span></div>
            <div style="font-size:12.5px;font-weight:700;color:#0f172a;">${BRL(s.total)} <span style="font-size:10.5px;color:#94a3b8;font-weight:500;">· ${BRL(ticketProc)}</span></div>
          </div>
          <div style="height:6px;background:#f1f5f9;border-radius:999px;overflow:hidden;">
            <div style="height:100%;width:${pctBar}%;background:#10b981;border-radius:999px;"></div>
          </div>
        </div>`;
    }).join('');
  }

  // ===== Tabela detalhada (aplica filtros) =====
  const linhasFiltradas = pacs.map((p, i) => ({ p, idx: indices[i] })).filter(({ p }) => {
    if (busca && !((p.nome || '').toLowerCase().includes(busca))) return false;
    if (fStatus && p.statusPgto !== fStatus) return false;
    if (fPgto && p.pagamento !== fPgto) return false;
    return true;
  });

  const tbody = document.getElementById('rec-tbody');
  const tfoot = document.getElementById('rec-tfoot');
  if (!linhasFiltradas.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#94a3b8;padding:48px;">Nenhum atendimento no período/filtro.</td></tr>';
    if (tfoot) tfoot.innerHTML = '';
    return;
  }
  // Ordena por data desc
  linhasFiltradas.sort((a, b) => (b.p.data || '').localeCompare(a.p.data || ''));
  tbody.innerHTML = linhasFiltradas.map(({ p, idx }) => `
    <tr>
      <td style="color:#475569;">${formatDate(p.data)}</td>
      <td style="font-weight:600;color:#0f172a;">${_esc(p.nome)}</td>
      <td style="color:#475569;">${_esc(p.tipo || '—')}</td>
      <td style="text-align:right;font-weight:700;color:#0f172a;">${BRL(p.valor)}</td>
      <td style="color:#475569;">${_esc(p.pagamento || '—')}</td>
      <td>${pgtoSelect(p.statusPgto, idx)}</td>
      <td style="white-space:nowrap;">
        <button onclick="editRow('pacientes',${idx})" class="text-blue-400 hover:text-blue-600 text-xs mr-2" title="Editar">✏️</button>
        <button onclick="deleteRow('pacientes',${idx})" class="text-red-400 hover:text-red-600 text-xs" title="Excluir">🗑️</button>
      </td>
    </tr>`).join('');
  // Rodapé com totais filtrados — discrimina Pago / Pendente / Isento
  const totPago     = linhasFiltradas.filter(({p}) => p.statusPgto === 'Pago').reduce((s, {p}) => s + (p.valor || 0), 0);
  const totPendente = linhasFiltradas.filter(({p}) => p.statusPgto === 'Pendente').reduce((s, {p}) => s + (p.valor || 0), 0);
  const totFiltrado = linhasFiltradas.reduce((s, { p }) => s + (p.valor || 0), 0);
  if (tfoot) {
    tfoot.innerHTML = `
      <tr style="background:#f8fafc;border-top:2px solid #e2e8f0;">
        <td colspan="2" style="font-weight:600;color:#475569;padding:10px 16px;font-size:12px;">
          ${linhasFiltradas.length} de ${pacs.length} atendimentos
        </td>
        <td style="padding:10px 12px;text-align:right;">
          ${totPago > 0 ? `<span style="background:#d1fae5;color:#065f46;padding:3px 8px;border-radius:6px;font-size:11.5px;font-weight:700;">✅ ${BRL(totPago)} pago</span>` : ''}
          ${totPendente > 0 ? `<span style="background:#fef3c7;color:#92400e;padding:3px 8px;border-radius:6px;font-size:11.5px;font-weight:700;margin-left:4px;">🕐 ${BRL(totPendente)} pendente</span>` : ''}
        </td>
        <td style="text-align:right;font-weight:800;color:#0f172a;font-size:14px;padding:10px 16px;">${BRL(totFiltrado)}</td>
        <td colspan="3"></td>
      </tr>`;
  }

  // Renderiza fluxo de caixa
  renderFluxoCaixa(mes === 'todos' ? _ymd(new Date()).substring(0, 7) : mes);
}

function renderDespesas() {
  const data = DB.get('despesas');
  const pacs = DB.get('pacientes');
  const tbody = document.getElementById('desp-tbody');

  const totalDesp = data.reduce((s, r) => s + r.valor, 0);
  // === MÉTRICAS PADRONIZADAS ===
  // Faturamento bruto = soma de TUDO emitido (independe de pagamento) — métrica usada em Dashboard/Relatório
  // Receita realizada = soma do que foi efetivamente PAGO — base para lucro contábil
  const faturamentoBruto = pacs.reduce((s, p) => s + (p.valor || 0), 0);
  const receitaRealizada = pacs.filter(p => p.statusPgto === 'Pago').reduce((s, r) => s + (r.valor || 0), 0);
  // Idem Relatório: inclui o Parcial (era só Pendente e divergia da Receita).
  const aReceber         = _resumoFin(pacs).aReceber;
  const lucro  = receitaRealizada - totalDesp;
  const margem = receitaRealizada ? (lucro / receitaRealizada) * 100 : 0;

  // P&L: mostra ambas as métricas — lucro é calculado sobre a realizada (faz sentido contábil)
  const elReceita = document.getElementById('pl-receita');
  if (elReceita) {
    elReceita.innerHTML = `${BRL(receitaRealizada)}
      <div style="font-size:11px;color:#94a3b8;font-weight:500;margin-top:2px;">Bruto emitido: ${BRL(faturamentoBruto)}${aReceber > 0 ? ` · A receber: ${BRL(aReceber)}` : ''}</div>`;
  }
  document.getElementById('pl-despesas').textContent = BRL(totalDesp);
  document.getElementById('pl-lucro').textContent = BRL(lucro);
  document.getElementById('pl-margem').textContent = PCT(margem);

  // Por categoria — agrupa pelas categorias REAIS existentes nas despesas
  // (antes era lista hardcoded que filtrava silenciosamente Aluguel/Salários/Utilidades)
  const catMap = {};
  data.forEach(r => {
    const c = (r.categoria || 'Outros').trim();
    catMap[c] = (catMap[c] || 0) + (r.valor || 0);
  });
  // Ordena desc por valor
  const catTotais = Object.entries(catMap)
    .map(([cat, val]) => ({ cat, val }))
    .sort((a, b) => b.val - a.val);

  document.getElementById('desp-categorias').innerHTML = catTotais.length
    ? catTotais.map(c => {
        const pct = totalDesp ? (c.val / totalDesp) * 100 : 0;
        return `
        <div class="flex items-center justify-between" style="padding:3px 0;">
          <div style="display:flex;align-items:center;gap:8px;">
            <span class="text-sm text-gray-700">${_esc(c.cat)}</span>
            <span style="font-size:10.5px;color:#94a3b8;">${pct.toFixed(0)}%</span>
          </div>
          <div class="flex items-center gap-3">
            <div class="w-24 bg-gray-100 rounded-full h-1.5">
              <div class="bg-red-400 h-1.5 rounded-full" style="width:${Math.min(pct, 100)}%"></div>
            </div>
            <span class="text-sm font-semibold text-gray-900 w-20 text-right">${BRL(c.val)}</span>
          </div>
        </div>`;
      }).join('')
    : '<div class="text-gray-400 text-sm text-center py-4">Sem despesas registradas</div>';

  // Chart — paleta com cores suficientes
  destroyChart('chart-desp-cat');
  const ctx = document.getElementById('chart-desp-cat').getContext('2d');
  const paleta = ['#ef4444','#f97316','#eab308','#22c55e','#3b82f6','#8b5cf6','#ec4899','#14b8a6','#6b7280','#f59e0b'];
  if (catTotais.length) {
    charts['chart-desp-cat'] = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: catTotais.map(c => c.cat),
        datasets: [{
          data: catTotais.map(c => c.val),
          backgroundColor: catTotais.map((_, i) => paleta[i % paleta.length]),
          borderWidth: 0
        }]
      },
      options: { plugins: { legend: { position: 'bottom', labels: { font: { size: 11 } } } }, cutout: '65%' }
    });
  }

  if (!data.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="text-center py-12 text-gray-400">Nenhuma despesa registrada.</td></tr>';
    return;
  }
  tbody.innerHTML = data.map((r, i) => `
    <tr class="border-b border-gray-50 hover:bg-gray-50">
      <td class="px-4 py-3 text-gray-600">${formatDate(r.data)}</td>
      <td class="px-4 py-3 text-gray-900">${_esc(r.descricao)}</td>
      <td class="px-4 py-3 text-gray-600">${_esc(r.categoria)}</td>
      <td class="px-4 py-3"><span class="badge ${r.tipo === 'Fixo' ? 'bg-blue-100 text-blue-700' : 'bg-orange-100 text-orange-700'}">${_esc(r.tipo)}</span></td>
      <td class="px-4 py-3 font-semibold text-red-600">${BRL(r.valor)}</td>
      <td class="px-4 py-3 text-gray-600">${_esc(r.formaPgto)}</td>
      <td class="px-4 py-3" style="white-space:nowrap;">
        <button onclick="editRow('despesas',${i})" class="text-blue-400 hover:text-blue-600 text-xs mr-2" title="Editar">✏️</button>
        <button onclick="deleteRow('despesas',${i})" class="text-red-400 hover:text-red-600 text-xs" title="Excluir">🗑️</button>
      </td>
    </tr>`).join('');
}

// ====================== DASHBOARD ======================
// ====================== TOGGLE DE SEÇÕES DO DASHBOARD ======================
const SECTION_LABELS = {
  procedimentos:          '📊 Receita por Procedimento',
  insights:               '🧠 Insights da MaestrIA',
  retencao:               '💎 Retenção e LTV',
  marketing:              '📣 Aquisição e Marketing',
  financeiro:             '💰 Inteligência Financeira',
  graficos:               '📈 Tendências e Gráficos',
  'graficos-operacionais':'📊 Gráficos Operacionais',
  'funil-ultimas':        '🔽 Funil e Últimas Consultas',
};

function getHiddenSections() {
  return JSON.parse(localStorage.getItem('consult_dash_hidden') || '[]');
}

function setHiddenSections(arr) {
  localStorage.setItem('consult_dash_hidden', JSON.stringify(arr));
}

function toggleSection(id) {
  const hidden = getHiddenSections();
  const idx = hidden.indexOf(id);
  if (idx >= 0) hidden.splice(idx, 1); else hidden.push(id);
  setHiddenSections(hidden);
  applySectionVisibility();
}

function applySectionVisibility() {
  const hidden = getHiddenSections();
  // Aplica para TODAS as seções com data-section (não depende de SECTION_LABELS)
  document.querySelectorAll('[data-section]').forEach(section => {
    const id = section.getAttribute('data-section');
    const body = section.querySelector(`[data-section-body="${id}"]`);
    const btn = section.querySelector('.btn-section-toggle');
    if (hidden.includes(id)) {
      if (body) body.style.display = 'none';
      if (btn) { btn.textContent = '+'; btn.title = 'Mostrar seção'; }
      section.style.marginBottom = '12px';
    } else {
      if (body) body.style.display = '';
      if (btn) { btn.textContent = '−'; btn.title = 'Ocultar seção'; }
      section.style.marginBottom = '24px';
    }
  });

  // Seções ocultas: cabeçalho permanece visível com botão "+" para reativar
}

// ====================== PACOTE 5: GRÁFICOS DE TENDÊNCIA ======================
function renderGraficos(mes) {
  const todosPacs = DB.get('pacientes');
  const todosDesps = DB.get('despesas');
  const crm = DB.get('crm');

  // ===== Linha 12 meses (faturamento × lucro × despesas) =====
  const [anoStr, mesStr] = mes.split('-');
  const ano = parseInt(anoStr, 10);
  const mesIdx = parseInt(mesStr, 10) - 1;
  const meses12 = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(ano, mesIdx - i, 1);
    meses12.push({
      key: _ymd(d).substring(0, 7),
      label: `${MESES[d.getMonth()]}/${String(d.getFullYear()).slice(2)}`
    });
  }
  const fatPorMes  = meses12.map(m => todosPacs.filter(p => getMes(p.data) === m.key).reduce((s, p) => s + (p.valor || 0), 0));
  const despPorMes = meses12.map(m => todosDesps.filter(d => getMes(d.data) === m.key).reduce((s, d) => s + (d.valor || 0), 0));
  const lucroPorMes = fatPorMes.map((f, i) => f - despPorMes[i]);

  destroyChart('chart-12meses');
  const ctx12 = document.getElementById('chart-12meses')?.getContext('2d');
  if (ctx12) {
    charts['chart-12meses'] = new Chart(ctx12, {
      type: 'line',
      data: {
        labels: meses12.map(m => m.label),
        datasets: [
          { label: 'Faturamento', data: fatPorMes, borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.1)', tension: 0.3, borderWidth: 2.5, fill: true, pointRadius: 3, pointHoverRadius: 5 },
          { label: 'Despesas', data: despPorMes, borderColor: '#ef4444', backgroundColor: 'rgba(239,68,68,0.05)', tension: 0.3, borderWidth: 2, fill: false, pointRadius: 3, pointHoverRadius: 5 },
          { label: 'Lucro', data: lucroPorMes, borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.08)', tension: 0.3, borderWidth: 2, fill: false, pointRadius: 3, pointHoverRadius: 5, borderDash: [4, 3] },
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 14, font: { size: 11.5 } } },
          tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${BRL(ctx.parsed.y)}` } }
        },
        scales: {
          y: { beginAtZero: true, ticks: { font: { size: 10.5 }, callback: v => 'R$ ' + (v/1000).toFixed(0) + 'k' }, grid: { color: '#f1f5f9' } },
          x: { ticks: { font: { size: 10.5 } }, grid: { display: false } }
        }
      }
    });
  }

  // ===== Donut: receita por canal de origem =====
  // Cruza CRM (com canal) e pacientes (com receita) por nome
  const pacReceita = {};
  todosPacs.forEach(p => {
    const k = (p.nome || '').toLowerCase().trim();
    if (!k) return;
    pacReceita[k] = (pacReceita[k] || 0) + (p.valor || 0);
  });
  const canaisLista = Array.from(new Set(crm.map(r => (r.canal || 'Outros').trim()).filter(Boolean)));
  const receitaPorCanal = canaisLista.map(c => {
    const nomesCanal = crm.filter(r => (r.canal || 'Outros').trim() === c && r.status === 'Atendeu').map(r => (r.nome || '').toLowerCase().trim());
    return nomesCanal.reduce((s, n) => s + (pacReceita[n] || 0), 0);
  });
  const totalReceita = receitaPorCanal.reduce((s, v) => s + v, 0);
  // Filtra canais com 0
  const canaisComReceita = canaisLista.map((c, i) => ({ canal: c, valor: receitaPorCanal[i] })).filter(c => c.valor > 0);

  destroyChart('chart-canal-receita');
  const ctxCanal = document.getElementById('chart-canal-receita')?.getContext('2d');
  if (ctxCanal) {
    if (!canaisComReceita.length) {
      ctxCanal.font = '13px Inter';
      ctxCanal.fillStyle = '#94a3b8';
      ctxCanal.textAlign = 'center';
      ctxCanal.fillText('Sem receita atribuída a canais ainda', ctxCanal.canvas.width / 2, ctxCanal.canvas.height / 2);
    } else {
      const cores = ['#10b981','#3b82f6','#f59e0b','#8b5cf6','#06b6d4','#ec4899','#64748b'];
      charts['chart-canal-receita'] = new Chart(ctxCanal, {
        type: 'doughnut',
        data: {
          labels: canaisComReceita.map(c => c.canal),
          datasets: [{ data: canaisComReceita.map(c => c.valor), backgroundColor: cores.slice(0, canaisComReceita.length), borderWidth: 2, borderColor: '#fff' }]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          cutout: '60%',
          plugins: {
            legend: { position: 'right', labels: { boxWidth: 12, font: { size: 11 }, padding: 8 } },
            tooltip: { callbacks: { label: (ctx) => {
              const pct = totalReceita ? ((ctx.parsed / totalReceita) * 100).toFixed(1) : 0;
              return `${ctx.label}: ${BRL(ctx.parsed)} (${pct}%)`;
            } } }
          }
        }
      });
    }
  }

  // ===== Bar: faturamento por dia da semana =====
  const dias = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
  const fatPorDia = [0, 0, 0, 0, 0, 0, 0];
  const qtdPorDia = [0, 0, 0, 0, 0, 0, 0];
  todosPacs.forEach(p => {
    if (!p.data) return;
    const d = new Date(p.data + 'T12:00:00'); // meio-dia evita problema de timezone
    const dow = d.getDay();
    fatPorDia[dow] += (p.valor || 0);
    qtdPorDia[dow]++;
  });

  destroyChart('chart-diasem');
  const ctxDia = document.getElementById('chart-diasem')?.getContext('2d');
  if (ctxDia) {
    // Cores: cinza pra fim de semana (raro em geriatria), verde pros úteis
    const cores = dias.map((_, i) => (i === 0 || i === 6) ? '#cbd5e1' : '#10b981');
    charts['chart-diasem'] = new Chart(ctxDia, {
      type: 'bar',
      data: {
        labels: dias,
        datasets: [{ data: fatPorDia, backgroundColor: cores, borderRadius: 6, barThickness: 'flex', maxBarThickness: 40 }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (ctx) => {
            const ticket = qtdPorDia[ctx.dataIndex] ? fatPorDia[ctx.dataIndex] / qtdPorDia[ctx.dataIndex] : 0;
            return [`Faturamento: ${BRL(ctx.parsed.y)}`, `Atendimentos: ${qtdPorDia[ctx.dataIndex]}`, `Ticket: ${BRL(ticket)}`];
          } } }
        },
        scales: {
          y: { beginAtZero: true, ticks: { font: { size: 10.5 }, callback: v => 'R$ ' + (v/1000).toFixed(1) + 'k' }, grid: { color: '#f1f5f9' } },
          x: { ticks: { font: { size: 11 } }, grid: { display: false } }
        }
      }
    });
  }
}

// ====================== PACOTE 5: INSIGHTS DA MAESTRIA ======================
const INSIGHTS_CACHE_KEY = 'consult_insights_cache';
const INSIGHTS_TTL_HORAS = 24; // re-geração automática após 24h

function carregarInsightsCache() {
  try { return JSON.parse(localStorage.getItem(INSIGHTS_CACHE_KEY) || 'null'); } catch { return null; }
}

function salvarInsightsCache(insights) {
  localStorage.setItem(INSIGHTS_CACHE_KEY, JSON.stringify({ insights, ts: new Date().toISOString() }));
}

function renderInsightCards(insights, ts) {
  const cores = {
    'oportunidade': { bg:'#eff6ff', border:'#3b82f6', titulo:'#1e40af', icone:'💡' },
    'alerta':       { bg:'#fef3c7', border:'#f59e0b', titulo:'#92400e', icone:'⚠️' },
    'critico':      { bg:'#fee2e2', border:'#ef4444', titulo:'#991b1b', icone:'🚨' },
    'parabens':     { bg:'#f0fdf4', border:'#10b981', titulo:'#15803d', icone:'🎉' },
    'info':         { bg:'#f1f5f9', border:'#64748b', titulo:'#334155', icone:'ℹ️' },
  };
  const cont = document.getElementById('insights-cards');
  if (!cont) return;
  if (!insights || !insights.length) {
    cont.innerHTML = '<div class="kpi-card" style="padding:16px 18px;border-left:3px solid #cbd5e1;grid-column:1/-1;"><div style="font-size:12px;color:#94a3b8;">Sem insights ainda — clique em <strong>🔄 Atualizar</strong></div></div>';
    return;
  }
  cont.innerHTML = insights.slice(0, 3).map(ins => {
    const c = cores[ins.tipo] || cores.info;
    return `
      <div class="kpi-card" style="padding:14px 16px;background:${c.bg};border-left:3px solid ${c.border};">
        <div style="font-size:11px;font-weight:700;color:${c.titulo};text-transform:uppercase;letter-spacing:0.05em;margin-bottom:6px;display:flex;align-items:center;gap:6px;">
          <span>${c.icone}</span>
          <span>${_esc(ins.titulo || '')}</span>
        </div>
        <div style="font-size:12.5px;color:#334155;line-height:1.4;">${_esc(ins.descricao || '')}</div>
        ${ins.acao ? `<div style="font-size:11px;color:${c.titulo};font-weight:600;margin-top:8px;">→ ${_esc(ins.acao)}</div>` : ''}
      </div>`;
  }).join('');

  // Insights da IA foram movidos pra fora do dashboard — função mantida para uso futuro
}

async function gerarInsightsSofia(force = false) {
  // Tenta usar cache se ainda válido e não foi forçado
  const cache = carregarInsightsCache();
  if (!force && cache && cache.ts) {
    const idadeH = (new Date() - new Date(cache.ts)) / (1000 * 60 * 60);
    if (idadeH < INSIGHTS_TTL_HORAS) {
      renderInsightCards(cache.insights, cache.ts);
      return;
    }
  }

  const key = getGeminiKey();
  if (!key) {
    renderInsightCards([{ tipo:'info', titulo:'Configure a MaestrIA', descricao:'Clique no botão flutuante no canto inferior direito e configure a chave da MaestrIA para gerar insights automáticos.', acao:'' }]);
    return;
  }

  const btn = document.getElementById('btn-refresh-insights');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Analisando...'; }

  // Render placeholder durante carregamento
  const cont = document.getElementById('insights-cards');
  if (cont && force) {
    cont.innerHTML = Array(3).fill(0).map(() => `
      <div class="kpi-card" style="padding:14px 16px;background:#f8fafc;border-left:3px solid #cbd5e1;">
        <div style="height:12px;background:#e2e8f0;border-radius:4px;margin-bottom:8px;width:60%;"></div>
        <div style="height:9px;background:#f1f5f9;border-radius:4px;margin-bottom:4px;"></div>
        <div style="height:9px;background:#f1f5f9;border-radius:4px;width:80%;"></div>
      </div>`).join('');
  }

  try {
    const ctx = buildContext();
    const _clinica = getClinicaConfig();
    const _nomeDr  = _clinica.nome || currentNome || 'do médico';
    const _esp     = _clinica.especialidade || 'medicina';
    const prompt = `Você é a MaestrIA, analista do consultório de ${_esp.toLowerCase()} de ${currentRole==='medico' ? 'Dr(a). '+_nomeDr : _nomeDr}.
Analise os dados abaixo e gere EXATAMENTE 5 insights acionáveis e específicos sobre o consultório.
Cada insight DEVE ter: tipo (uma de: "oportunidade", "alerta", "critico", "parabens", "info"), titulo (máx 5 palavras), descricao (1-2 frases com NÚMEROS REAIS dos dados), acao (sugestão de até 8 palavras, obrigatória).

DADOS DO CONSULTÓRIO:
Financeiro:
- Mês ${ctx.mesAtual}: R$${ctx.faturamento.toFixed(0)} faturado | Meta R$${ctx.metaFat} (${ctx.pctMeta}% atingido)
- Projeção fim do mês: R$${ctx.projecaoMes} | Mês anterior: R$${ctx.faturamentoAnt.toFixed(0)} (variação ${ctx.variacaoMes}%)
- Despesas: R$${ctx.despesas.toFixed(0)} | Lucro: R$${ctx.lucro.toFixed(0)}
- Ticket médio: R$${ctx.ticketMedio} | Procedimentos: ${ctx.procBreakdown}

Pacientes:
- Atendidos: ${ctx.pacientesMes} (${ctx.pagos} pagos, ${ctx.pendentes} pendentes)
- Total pendente (inadimplência): R$${ctx.totalPendente.toFixed(0)} — quem deve: ${ctx.pacPendentesLista}
- No-shows esse mês: ${ctx.noShowsMes}

Agenda:
- Hoje: ${ctx.agendaHoje}
- Amanhã: ${ctx.agendaAmanha}
- Próximos 7 dias: ${ctx.agendaSemana}

CRM e Follow-up:
- ${ctx.crmMarcouPendente} contatos marcaram consulta mas ainda não foram atendidos (${ctx.crmMarcados})
- Follow-ups vencidos hoje: ${ctx.followupHoje} (${ctx.followupPendenteNomes || 'nenhum'})
- Todos pendentes: ${ctx.followupLista}

CRITÉRIOS:
- Se lucro negativo → "critico"
- Se meta >100% → "parabens"
- Se no-shows >2 → alerta de no-show com cálculo de receita perdida
- Se inadimplência >0 → alerta com nomes e valores
- Se follow-ups vencidos >0 → sempre gere um alerta
- Se CRM marcados pendentes >0 → oportunidade de conversão
- Cite SEMPRE os números reais. Nunca invente dados.

Responda APENAS com JSON válido:
{"insights": [
  {"tipo":"...","titulo":"...","descricao":"...","acao":"..."},
  {"tipo":"...","titulo":"...","descricao":"...","acao":"..."},
  {"tipo":"...","titulo":"...","descricao":"...","acao":"..."},
  {"tipo":"...","titulo":"...","descricao":"...","acao":"..."},
  {"tipo":"...","titulo":"...","descricao":"...","acao":"..."}
]}`;

    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 900,
        response_format: { type: 'json_object' }
      })
    });
    if (!res.ok) throw new Error('API ' + res.status);
    const json = await res.json();
    const raw = json.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(raw);
    const insights = Array.isArray(parsed.insights) ? parsed.insights : [];
    if (!insights.length) throw new Error('Resposta vazia');

    salvarInsightsCache(insights);
    renderInsightCards(insights, new Date().toISOString());
  } catch (e) {
    console.error('Insights MaestrIA:', e);
    renderInsightCards([{ tipo:'info', titulo:'Erro ao gerar insights', descricao:`Não consegui consultar a MaestrIA agora. ${e.message}`, acao:'Tente novamente em alguns segundos' }]);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🔄 Atualizar'; }
  }
}

// ====================== PACOTE 3: RETENÇÃO E LTV ======================
function renderRetencao() {
  const todos = DB.get('pacientes');
  if (!todos.length) {
    setText('ret-taxa', '—');  setText('ret-ltv', 'R$ 0');
    setText('ret-ativos', '0'); setText('ret-freq', '— dias');
    setText('ret-abandonados-count', '0');
    document.getElementById('ret-abandonados-list').innerHTML =
      '<div style="padding:32px;text-align:center;color:#94a3b8;font-size:13px;">Sem dados ainda — registre algumas consultas</div>';
    return;
  }

  // Agrupa por paciente (nome normalizado)
  const porPaciente = {};
  todos.forEach(p => {
    const key = (p.nome || '').toLowerCase().trim();
    if (!key) return;
    if (!porPaciente[key]) porPaciente[key] = { nome: p.nome, consultas: [], receitaTotal: 0 };
    porPaciente[key].consultas.push(p);
    porPaciente[key].receitaTotal += (p.valor || 0);
  });

  const pacientesUnicos = Object.values(porPaciente);
  pacientesUnicos.forEach(p => p.consultas.sort((a, b) => a.data.localeCompare(b.data)));

  // ===== Taxa de retorno em 90 dias =====
  // De quem teve a 1ª consulta há mais de 90 dias, quantos voltaram dentro de 90 dias?
  const hojeStr = _ymd(new Date());
  const noventaDiasAtras = new Date(); noventaDiasAtras.setDate(noventaDiasAtras.getDate() - 90);
  const noventaStr = _ymd(noventaDiasAtras);

  const elegiveis = pacientesUnicos.filter(p => p.consultas[0].data <= noventaStr);
  const retornaram = elegiveis.filter(p => {
    if (p.consultas.length < 2) return false;
    const primeira = new Date(p.consultas[0].data);
    const segunda = new Date(p.consultas[1].data);
    const diffDias = (segunda - primeira) / (1000 * 60 * 60 * 24);
    return diffDias <= 90;
  });
  const taxaRetorno = elegiveis.length ? (retornaram.length / elegiveis.length) * 100 : 0;
  setText('ret-taxa', PCT(taxaRetorno));
  setText('ret-taxa-sub', `${retornaram.length} de ${elegiveis.length} pacientes elegíveis`);

  // ===== LTV médio =====
  const receitaTotalGeral = pacientesUnicos.reduce((s, p) => s + p.receitaTotal, 0);
  const ltv = pacientesUnicos.length ? receitaTotalGeral / pacientesUnicos.length : 0;
  setText('ret-ltv', BRL(ltv));
  setText('ret-ltv-sub', `${pacientesUnicos.length} pacientes únicos · ${todos.length} consultas`);

  // ===== Pacientes ativos (últimos 6 meses) =====
  const seisMeses = new Date(); seisMeses.setMonth(seisMeses.getMonth() - 6);
  const seisStr = _ymd(seisMeses);
  const ativos = pacientesUnicos.filter(p => p.consultas[p.consultas.length - 1].data >= seisStr);
  const pctAtivos = pacientesUnicos.length ? (ativos.length / pacientesUnicos.length) * 100 : 0;
  setText('ret-ativos', ativos.length);
  setText('ret-ativos-sub', `${PCT(pctAtivos)} da base · ${pacientesUnicos.length - ativos.length} inativos`);

  // ===== Frequência média (intervalo médio entre consultas) =====
  const intervalos = [];
  pacientesUnicos.forEach(p => {
    for (let i = 1; i < p.consultas.length; i++) {
      const d1 = new Date(p.consultas[i - 1].data);
      const d2 = new Date(p.consultas[i].data);
      const dias = (d2 - d1) / (1000 * 60 * 60 * 24);
      if (dias > 0 && dias < 730) intervalos.push(dias); // ignora outliers > 2 anos
    }
  });
  const freqMedia = intervalos.length ? Math.round(intervalos.reduce((s, n) => s + n, 0) / intervalos.length) : 0;
  setText('ret-freq', freqMedia ? `${freqMedia} dias` : '— dias');

  // ===== Lista de pacientes abandonados (>6 meses sem consulta) =====
  const abandonados = pacientesUnicos
    .filter(p => p.consultas[p.consultas.length - 1].data < seisStr)
    .map(p => {
      const ult = p.consultas[p.consultas.length - 1];
      const diasFora = Math.floor((new Date(hojeStr) - new Date(ult.data)) / (1000 * 60 * 60 * 24));
      return { nome: p.nome, ultData: ult.data, diasFora, totalConsultas: p.consultas.length, receita: p.receitaTotal };
    })
    .sort((a, b) => b.receita - a.receita); // prioriza quem deu mais receita histórica

  setText('ret-abandonados-count', abandonados.length);
  const lista = document.getElementById('ret-abandonados-list');
  if (!abandonados.length) {
    lista.innerHTML = '<div style="padding:32px;text-align:center;color:#94a3b8;font-size:13px;">Sem pacientes abandonados — todos em dia 🎉</div>';
  } else {
    lista.innerHTML = abandonados.slice(0, 15).map(p => `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 20px;border-bottom:1px solid #f8fafc;">
        <div style="flex:1;">
          <div style="font-weight:600;color:#0f172a;font-size:13.5px;">${_esc(p.nome)}</div>
          <div style="font-size:11.5px;color:#94a3b8;margin-top:2px;">Última: ${formatDate(p.ultData)} · ${p.totalConsultas} consulta${p.totalConsultas > 1 ? 's' : ''} · LTV ${BRL(p.receita)}</div>
        </div>
        <div style="display:flex;align-items:center;gap:10px;">
          <div style="font-size:11px;font-weight:700;color:#dc2626;background:#fee2e2;padding:3px 9px;border-radius:999px;">${p.diasFora}d</div>
          <button onclick="criarFollowupReativacao('${_jsArg(p.nome)}','${_jsArg(p.ultData)}')" style="background:#3b82f6;color:#fff;border:none;border-radius:6px;padding:5px 11px;font-size:11.5px;font-weight:600;cursor:pointer;">📞 Reativar</button>
        </div>
      </div>`).join('') +
      (abandonados.length > 15 ? `<div style="padding:10px;text-align:center;color:#94a3b8;font-size:11.5px;">e mais ${abandonados.length - 15} paciente(s)...</div>` : '');
  }
}

// Helper para setText sem repetir document.getElementById
function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

// ====================== PACOTE 2: AQUISIÇÃO E MARKETING ======================
function renderMarketing(mesAtual) {
  const crm = DB.get('crm');
  const pacs = DB.get('pacientes');
  const desps = DB.get('despesas');

  // Cruza CRM ↔ Pacientes por nome (lowercase trim)
  const pacReceitaPorNome = {};
  pacs.forEach(p => {
    const k = (p.nome || '').toLowerCase().trim();
    if (!k) return;
    pacReceitaPorNome[k] = (pacReceitaPorNome[k] || 0) + (p.valor || 0);
  });

  // Canais — agrupa pelos canais REAIS presentes no CRM (não lista fixa)
  const canaisSet = new Set(crm.map(r => (r.canal || 'Outros').trim()).filter(Boolean));
  const stats = Array.from(canaisSet).map(c => {
    const lista = crm.filter(r => (r.canal || 'Outros').trim() === c);
    const atend = lista.filter(r => r.status === 'Atendeu');
    const receita = atend.reduce((s, r) => {
      const k = (r.nome || '').toLowerCase().trim();
      return s + (pacReceitaPorNome[k] || 0);
    }, 0);
    const conv = lista.length ? (atend.length / lista.length) * 100 : 0;
    return { canal: c, contatos: lista.length, atendeu: atend.length, conv, receita };
  }).filter(s => s.contatos > 0);

  // Ordena por receita desc
  stats.sort((a, b) => b.receita - a.receita);

  // === CAC e ROI (mês atual) ===
  const despMktMes = desps
    .filter(d => getMes(d.data) === mesAtual && d.categoria === 'Marketing')
    .reduce((s, d) => s + (d.valor || 0), 0);

  // Pacientes novos do mês = quem foi atendido pela PRIMEIRA vez neste mês.
  // (O filtro antigo varria o histórico inteiro do CRM apesar do nome "Mes":
  // bastava a pessoa ter vindo do CRM algum dia e qualquer retorno dela
  // contava como aquisição nova — CAC e ROI do mês saíam errados.)
  const _novos = _novosNoMes(pacs, mesAtual);
  const novosCount   = _novos.quantidade;
  const receitaNovos = _novos.receita;

  const cac = (despMktMes > 0 && novosCount > 0) ? despMktMes / novosCount : 0;
  setText('mkt-cac', despMktMes > 0 ? BRL(cac) : 'R$ 0');
  setText('mkt-cac-sub', despMktMes > 0
    ? `${BRL(despMktMes)} ÷ ${novosCount} paciente${novosCount === 1 ? '' : 's'} novo${novosCount === 1 ? '' : 's'}`
    : 'Sem despesa de Marketing no mês');

  if (despMktMes > 0) {
    const roi = receitaNovos / despMktMes;
    setText('mkt-roi', roi.toFixed(1) + 'x');
    setText('mkt-roi-sub', `${BRL(receitaNovos)} de receita ÷ ${BRL(despMktMes)}`);
  } else {
    setText('mkt-roi', '—');
    setText('mkt-roi-sub', 'Lance despesa de Marketing para calcular');
  }

  // === Melhor canal por receita ===
  if (stats.length && stats[0].receita > 0) {
    setText('mkt-top-canal', stats[0].canal);
    setText('mkt-top-canal-sub', `${BRL(stats[0].receita)} · ${PCT(stats[0].conv)} de conversão`);
  } else {
    setText('mkt-top-canal', '—');
    setText('mkt-top-canal-sub', 'Sem receita atribuída a canal ainda');
  }

  // === Conversão total CRM ===
  const totalContatos = crm.length;
  const totalAtend = crm.filter(c => c.status === 'Atendeu').length;
  const convTotal = totalContatos ? (totalAtend / totalContatos) * 100 : 0;
  setText('mkt-conv-total', PCT(convTotal));
  setText('mkt-conv-total-sub', `${totalAtend} de ${totalContatos} contatos`);

  // === Tabela ROI por canal ===
  const tbody = document.getElementById('mkt-canais-tbody');
  if (!stats.length) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#94a3b8;padding:32px;">Sem contatos no CRM ainda</td></tr>';
  } else {
    const maxReceita = Math.max(...stats.map(s => s.receita), 1);
    tbody.innerHTML = stats.map(s => {
      const corConv = s.conv >= 60 ? '#10b981' : s.conv >= 30 ? '#f59e0b' : '#ef4444';
      const pctBar = (s.receita / maxReceita) * 100;
      return `
        <tr>
          <td style="font-weight:600;color:#0f172a;">${_esc(s.canal)}</td>
          <td style="text-align:center;color:#475569;">${s.contatos}</td>
          <td style="text-align:center;color:#475569;">${s.atendeu}</td>
          <td style="text-align:center;"><span style="color:${corConv};font-weight:700;">${PCT(s.conv)}</span></td>
          <td style="text-align:right;font-weight:700;color:#0f172a;">
            ${BRL(s.receita)}
            <div style="height:4px;background:#f1f5f9;border-radius:999px;margin-top:4px;overflow:hidden;">
              <div style="height:100%;width:${pctBar}%;background:linear-gradient(90deg,#10b981,#34d399);border-radius:999px;"></div>
            </div>
          </td>
        </tr>`;
    }).join('');
  }

  // === Funil visual ===
  const contatos = crm.length;
  const negociacao = crm.filter(c => ['Em negociação','Marcou','Atendeu'].includes(c.status)).length;
  const marcou = crm.filter(c => ['Marcou','Atendeu'].includes(c.status)).length;
  const atendeu = crm.filter(c => c.status === 'Atendeu').length;

  const etapas = [
    { label: 'Contato feito',  count: contatos,    cor: '#3b82f6' },
    { label: 'Em negociação',  count: negociacao,  cor: '#8b5cf6' },
    { label: 'Marcou',         count: marcou,      cor: '#f59e0b' },
    { label: 'Atendeu',        count: atendeu,     cor: '#10b981' },
  ];

  const funilEl = document.getElementById('mkt-funil');
  if (!contatos) {
    funilEl.innerHTML = '<div style="text-align:center;color:#94a3b8;font-size:12.5px;padding:20px;">Sem contatos no CRM ainda</div>';
  } else {
    funilEl.innerHTML = etapas.map((e, i) => {
      const pctTotal = (e.count / contatos) * 100;
      const dropPct = i > 0 && etapas[i - 1].count > 0
        ? ((etapas[i - 1].count - e.count) / etapas[i - 1].count) * 100
        : 0;
      return `
        <div>
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">
            <div style="font-size:12px;font-weight:600;color:#0f172a;">${e.label}</div>
            <div style="font-size:11.5px;color:#64748b;"><strong style="color:#0f172a;">${e.count}</strong> · ${PCT(pctTotal)}</div>
          </div>
          <div style="height:18px;background:#f1f5f9;border-radius:6px;overflow:hidden;">
            <div style="height:100%;width:${pctTotal}%;background:${e.cor};border-radius:6px;transition:width 0.5s;"></div>
          </div>
          ${i > 0 && dropPct > 0 ? `<div style="font-size:10.5px;color:#ef4444;margin-top:3px;">↓ ${PCT(dropPct)} de queda da etapa anterior</div>` : ''}
        </div>`;
    }).join('');
  }
}

// Cria follow-up de reativação automaticamente (salva direto, sem modal)
function criarFollowupReativacao(nomeEnc, ultData) {
  const nome = decodeURIComponent(nomeEnc);

  // Verifica se já existe follow-up pendente para esse paciente
  const followups = DB.get('followup');
  const jaExiste = followups.some(f => (f.nome||'').toLowerCase().trim() === nome.toLowerCase().trim() && !f.feito);
  if (jaExiste) {
    toast(`Follow-up de ${nome} já existe na lista!`);
    return;
  }

  // Calcula próximo dia útil
  const amanha = new Date(); amanha.setDate(amanha.getDate() + 1);
  const ajustado = proximoDiaUtil(amanha);
  const dataContato = _ymd(ajustado);

  // Cria o follow-up direto
  const item = {
    nome,
    ultConsulta: ultData,
    dataContato,
    tipoContato: 'WhatsApp',
    feito: false,
    dataReav: '',
    obs: 'Reativação — paciente sem consulta há mais de 6 meses'
  };
  followups.unshift(item);
  DB.set('followup', followups);

  toast(`✅ Follow-up criado para ${nome} — contato em ${dataContato}`);

  // Atualiza dashboard se estiver nele
  if (document.getElementById('page-dashboard').classList.contains('active')) {
    renderDashboard();
  }
  // Atualiza follow-up se estiver aberto
  if (document.getElementById('page-followup').classList.contains('active')) {
    renderFollowup();
  }
}

// ====================== PACOTE 1: INTELIGÊNCIA FINANCEIRA ======================
function diasUteisNoMes(ano, mesIdx) {
  // mesIdx: 0-11
  const ultDia = new Date(ano, mesIdx + 1, 0).getDate();
  let count = 0;
  for (let d = 1; d <= ultDia; d++) {
    const dow = new Date(ano, mesIdx, d).getDay();
    if (dow !== 0 && dow !== 6) count++;
  }
  return count;
}

function diasUteisAtePassado(ano, mesIdx, ateDia) {
  let count = 0;
  for (let d = 1; d <= ateDia; d++) {
    const dow = new Date(ano, mesIdx, d).getDay();
    if (dow !== 0 && dow !== 6) count++;
  }
  return count;
}

function renderFinanceiro(mes) {
  const pacs = DB.get('pacientes').filter(p => getMes(p.data) === mes);
  const desps = DB.get('despesas');
  const despsMes = desps.filter(d => getMes(d.data) === mes);
  const metas = DB.getObj('metas', {});
  const [anoStr, mesStr] = mes.split('-');
  const ano = parseInt(anoStr, 10);
  const mesIdx = parseInt(mesStr, 10) - 1;

  const hoje = new Date();
  const hojeMes = _ymd(hoje).substring(0, 7);
  const ehMesAtual = mes === hojeMes;

  // ===== Projeção do mês =====
  const fat = pacs.reduce((s, p) => s + (p.valor || 0), 0);
  let projecao = fat;
  let projecaoLabel = 'Mês fechado';
  if (ehMesAtual) {
    const diaHoje = hoje.getDate();
    const diasUteisTotal = diasUteisNoMes(ano, mesIdx);
    const diasUteisDecorridos = diasUteisAtePassado(ano, mesIdx, diaHoje);
    if (diasUteisDecorridos > 0) {
      projecao = (fat / diasUteisDecorridos) * diasUteisTotal;
      projecaoLabel = `Pace: ${diasUteisDecorridos}/${diasUteisTotal} dias úteis decorridos`;
    } else {
      projecao = 0;
      projecaoLabel = 'Mês ainda não começou';
    }
  }
  setText('fin-proj', BRL(projecao));
  setText('fin-proj-sub', projecaoLabel);
  if (metas.fat) {
    const pctMeta = (projecao / metas.fat) * 100;
    const corBar = pctMeta >= 100 ? '#10b981' : pctMeta >= 80 ? '#f59e0b' : '#ef4444';
    const bar = document.getElementById('fin-proj-bar');
    if (bar) {
      bar.style.width = Math.min(pctMeta, 100) + '%';
      bar.style.background = corBar;
    }
    setText('fin-proj-meta', `${PCT(pctMeta)} da meta de ${BRL(metas.fat)}`);
  } else {
    const bar = document.getElementById('fin-proj-bar');
    if (bar) bar.style.width = '0%';
    setText('fin-proj-meta', 'Configure a meta de faturamento');
  }

  // ===== DRE (dois regimes: CAIXA e COMPETÊNCIA) =====
  const _rfDre = _resumoFin(pacs);
  const inad = _rfDre.pendente;          // pendente (inadimplência)
  const isento = _rfDre.isento;
  const recebidoDre = _rfDre.recebido;   // CAIXA (Pago)
  const faturado    = _rfDre.faturado;   // COMPETÊNCIA (Pago+Parcial+Pendente)

  // Separa impostos das demais despesas
  const despImpostos = despsMes.filter(d => d.categoria === 'Impostos').reduce((s, d) => s + (d.valor || 0), 0);
  const despsOperacionais = despsMes.filter(d => d.categoria !== 'Impostos');
  const despFixas = despsOperacionais.filter(d => d.tipo === 'Fixo').reduce((s, d) => s + (d.valor || 0), 0);
  const despVar   = despsOperacionais.filter(d => d.tipo === 'Variável').reduce((s, d) => s + (d.valor || 0), 0);
  const despsOutras = despsOperacionais.filter(d => d.tipo !== 'Fixo' && d.tipo !== 'Variável').reduce((s, d) => s + (d.valor || 0), 0);

  const despOpTotal = despFixas + despVar + despsOutras;
  const despTotal = despOpTotal + despImpostos;
  const cargaTrib = faturado ? (despImpostos / faturado) * 100 : 0;
  // Lucro nos dois regimes (após TODAS as despesas, inclusive impostos).
  const _luc = _lucroFin(_rfDre, despTotal);
  const lucroCaixa = _luc.caixa;             // recebido − despesas
  const lucroComp  = _luc.competencia;       // faturado − despesas

  // Headline: mostra o faturado (competência) com o recebido (caixa) no subtítulo.
  setText('fin-receita-liq', BRL(faturado));
  setText('fin-receita-liq-sub', `Recebido (caixa) ${BRL(recebidoDre)} · a receber ${BRL(_rfDre.aReceber)}${isento > 0 ? ' · isento ' + BRL(isento) : ''}`);

  const linhaDRE = (lbl, val, isSubtracao, isResultado, cor) => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;${isResultado ? 'border-top:2px solid #e2e8f0;margin-top:4px;padding-top:12px;' : 'border-bottom:1px dashed #f1f5f9;'}">
      <div style="font-size:12.5px;color:${isResultado ? '#0f172a' : '#475569'};font-weight:${isResultado ? '700' : '500'};">${lbl}</div>
      <div style="font-size:13px;font-weight:${isResultado ? '800' : '600'};color:${cor || (isSubtracao ? '#ef4444' : '#0f172a')};">${isSubtracao ? '−' : ''} ${BRL(Math.abs(val))}</div>
    </div>`;

  document.getElementById('fin-dre').innerHTML =
    linhaDRE('Receita Faturada (competência)', faturado, false, false) +
    linhaDRE('• dos quais Recebido (caixa)', recebidoDre, false, false, '#10b981') +
    linhaDRE('• ainda A Receber (pendente + parcial)', _rfDre.aReceber, false, false, '#f59e0b') +
    (isento > 0 ? linhaDRE('(fora) Isentos / Cortesias', isento, false, false, '#94a3b8') : '') +
    linhaDRE(`(−) Impostos${cargaTrib ? ` (carga ${PCT(cargaTrib)})` : ''}`, despImpostos, true, false) +
    linhaDRE('(−) Despesas Fixas', despFixas, true, false) +
    linhaDRE('(−) Despesas Variáveis', despVar, true, false) +
    (despsOutras > 0 ? linhaDRE('(−) Outras', despsOutras, true, false) : '') +
    linhaDRE(`= Lucro Líquido CAIXA (margem ${PCT(_luc.margemCaixa)})`, lucroCaixa, false, true, lucroCaixa >= 0 ? '#10b981' : '#ef4444') +
    linhaDRE(`= Lucro Líquido COMPETÊNCIA (margem ${PCT(_luc.margemCompetencia)})`, lucroComp, false, true, lucroComp >= 0 ? '#0ea5e9' : '#ef4444');

  // ===== Receita por tipo de consulta — agrupa pelos tipos REAIS dos atendimentos =====
  // (antes era lista fixa que filtrava silenciosamente procedimentos com outros nomes)
  const tiposMap = {};
  pacs.forEach(p => {
    if ((p.obs || '').includes('[Programa')) return; // programas têm seção própria
    const t = (p.tipo || '(sem tipo)').trim();
    if (!tiposMap[t]) tiposMap[t] = { qtd: 0, total: 0 };
    tiposMap[t].qtd++;
    tiposMap[t].total += (p.valor || 0);
  });
  const tiposStats = Object.entries(tiposMap)
    .map(([tipo, v]) => ({ tipo, qtd: v.qtd, total: v.total, ticket: v.qtd ? v.total / v.qtd : 0 }))
    .sort((a, b) => b.total - a.total);

  const tiposEl = document.getElementById('fin-tipos');
  if (!tiposStats.length) {
    tiposEl.innerHTML = '<div style="text-align:center;color:#94a3b8;font-size:13px;padding:20px;">Sem consultas registradas neste mês</div>';
  } else {
    const max = Math.max(...tiposStats.map(s => s.total), 1);
    const paleta = ['#3b82f6','#10b981','#8b5cf6','#f59e0b','#ef4444','#06b6d4','#ec4899','#64748b'];
    tiposEl.innerHTML = tiposStats.map((s, i) => {
      const pctBar = (s.total / max) * 100;
      const cor = paleta[i % paleta.length];
      return `
        <div style="margin-bottom:12px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px;">
            <div style="font-size:12.5px;font-weight:600;color:#0f172a;">${_esc(s.tipo)} <span style="color:#94a3b8;font-weight:400;font-size:11.5px;">(${s.qtd})</span></div>
            <div style="font-size:12.5px;font-weight:700;color:#0f172a;">${BRL(s.total)} <span style="font-size:10.5px;color:#94a3b8;font-weight:500;">· ticket ${BRL(s.ticket)}</span></div>
          </div>
          <div style="height:6px;background:#f1f5f9;border-radius:999px;overflow:hidden;">
            <div style="height:100%;width:${pctBar}%;background:${cor};border-radius:999px;transition:width 0.5s;"></div>
          </div>
        </div>`;
    }).join('');
  }

  // ===== Burn rate (média despesa fixa dos meses ANTERIORES) =====
  // Corrigido: i começa em 1 e usa (mesIdx - i) → meses estritamente anteriores ao atual
  const todosDespsBurn = DB.get('despesas');
  const ultimos3Meses = [];
  for (let i = 1; i <= 3; i++) {
    const d = new Date(ano, mesIdx - i, 1);
    ultimos3Meses.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  const burnAmostras = ultimos3Meses.map(m =>
    todosDespsBurn.filter(d => getMes(d.data) === m && d.tipo === 'Fixo').reduce((s, d) => s + (d.valor || 0), 0)
  );
  const burnComDado = burnAmostras.filter(v => v > 0);
  const burn = burnComDado.length ? burnComDado.reduce((s, v) => s + v, 0) / burnComDado.length : despFixas;
  setText('fin-burn', BRL(burn));
  setText('fin-burn-sub', burnComDado.length
    ? `Média de ${burnComDado.length} mês(es) anterior${burnComDado.length > 1 ? 'es' : ''}`
    : 'Baseado nas despesas fixas do mês atual');

  // ===== Runway (caixa estimado ÷ burn) =====
  // Caixa estimado = soma de (receita líquida - despesas) de todos os meses anteriores ao atual
  const todosPacs = DB.get('pacientes');
  const todosDesps = DB.get('despesas');
  let caixaEstimado = 0;
  // Agrupa por mês
  const mesesUnicos = new Set();
  todosPacs.forEach(p => mesesUnicos.add(getMes(p.data)));
  todosDesps.forEach(d => mesesUnicos.add(getMes(d.data)));
  mesesUnicos.forEach(m => {
    if (!m || m >= mes) return; // só meses passados
    const r = todosPacs.filter(p => getMes(p.data) === m && p.statusPgto === 'Pago').reduce((s, p) => s + (p.valor || 0), 0);
    const d = todosDesps.filter(de => getMes(de.data) === m).reduce((s, de) => s + (de.valor || 0), 0);
    caixaEstimado += (r - d);
  });
  // Soma também o que já entrou no mês atual (pago)
  const recebidoMesAtual = pacs.filter(p => p.statusPgto === 'Pago').reduce((s, p) => s + (p.valor || 0), 0);
  caixaEstimado += recebidoMesAtual - despTotal;

  // Há histórico financeiro real? (algum atendimento pago OU alguma despesa lançada)
  const temHistorico = todosPacs.some(p => p.statusPgto === 'Pago') || todosDesps.length > 0;
  const elRun = document.getElementById('fin-runway');

  if (!temHistorico || burn <= 0) {
    // Consultório novo / sem dados → estado neutro (sem alarme vermelho)
    if (elRun) { elRun.textContent = '—'; elRun.style.color = '#94a3b8'; }
    setText('fin-runway-sub', 'Lance receitas e despesas para calcular');
  } else if (caixaEstimado > 0) {
    const runwayMeses = caixaEstimado / burn;
    const cor = runwayMeses >= 6 ? '#10b981' : runwayMeses >= 3 ? '#f59e0b' : '#ef4444';
    if (elRun) { elRun.textContent = runwayMeses.toFixed(1) + ' meses'; elRun.style.color = cor; }
    setText('fin-runway-sub', `Caixa estimado: ${BRL(caixaEstimado)}`);
  } else {
    // Caixa negativo COM histórico real = alerta legítimo
    if (elRun) { elRun.textContent = '⚠️ Negativo'; elRun.style.color = '#ef4444'; }
    setText('fin-runway-sub', `Caixa estimado: ${BRL(caixaEstimado)}`);
  }
}

function renderProcBreakdown(pacs) {
  const el = document.getElementById('dash-proc-breakdown');
  if (!el) return;

  const corPorTipo = {
    '1ª vez':      { bg: '#dbeafe', cor: '#1d4ed8', icon: '🆕' },
    'Consulta':    { bg: '#d1fae5', cor: '#065f46', icon: '🩺' },
    'Retorno':     { bg: '#ede9fe', cor: '#5b21b6', icon: '🔄' },
    'Domiciliar':  { bg: '#fef3c7', cor: '#92400e', icon: '🏠' },
    'Hospitalar':  { bg: '#fee2e2', cor: '#991b1b', icon: '🏥' },
    'Telemedicina':{ bg: '#e0f2fe', cor: '#0c4a6e', icon: '💻' },
    'Cortesia':    { bg: '#f1f5f9', cor: '#475569', icon: '🎁' },
  };

  if (!pacs.length) {
    el.innerHTML = '<div style="text-align:center;color:#94a3b8;font-size:13px;padding:20px;">Sem consultas registradas neste mês</div>';
    return;
  }

  // Agrupa por tipo: qtd + receita
  const mapa = {};
  pacs.forEach(p => {
    const k = p.tipo || 'Consulta';
    if (!mapa[k]) mapa[k] = { qtd: 0, total: 0 };
    mapa[k].qtd++;
    mapa[k].total += (p.valor || 0);
  });

  const fat = pacs.reduce((s, p) => s + (p.valor || 0), 0);
  const sorted = Object.entries(mapa).sort((a, b) => b[1].total - a[1].total);

  el.innerHTML = `
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <thead>
        <tr style="border-bottom:2px solid #f1f5f9;">
          <th style="text-align:left;padding:8px 12px;color:#64748b;font-weight:600;font-size:11.5px;">Procedimento</th>
          <th style="text-align:center;padding:8px 12px;color:#64748b;font-weight:600;font-size:11.5px;">Qtd</th>
          <th style="text-align:right;padding:8px 12px;color:#64748b;font-weight:600;font-size:11.5px;">Receita</th>
          <th style="text-align:right;padding:8px 12px;color:#64748b;font-weight:600;font-size:11.5px;">% do mês</th>
          <th style="text-align:right;padding:8px 12px;color:#64748b;font-weight:600;font-size:11.5px;">Ticket</th>
        </tr>
      </thead>
      <tbody>
        ${sorted.map(([tipo, s]) => {
          const c = corPorTipo[tipo] || { bg:'#f1f5f9', cor:'#374151', icon:'📋' };
          const pct = fat ? (s.total / fat) * 100 : 0;
          const ticket = s.qtd ? s.total / s.qtd : 0;
          const barW = Math.round(pct);
          return `
            <tr style="border-bottom:1px solid #f8fafc;">
              <td style="padding:9px 12px;">
                <div style="display:flex;align-items:center;gap:7px;">
                  <div style="width:24px;height:24px;background:${c.bg};border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:12px;flex-shrink:0;">${c.icon}</div>
                  <span style="font-weight:600;color:#0f172a;font-size:13px;">${tipo}</span>
                </div>
              </td>
              <td style="padding:9px 12px;text-align:center;">
                <span style="background:${c.bg};color:${c.cor};padding:2px 9px;border-radius:999px;font-size:12px;font-weight:700;">${s.qtd}</span>
              </td>
              <td style="padding:9px 12px;text-align:right;font-weight:700;color:#0f172a;">${BRL(s.total)}</td>
              <td style="padding:9px 12px;text-align:right;">
                <div style="display:flex;align-items:center;justify-content:flex-end;gap:6px;">
                  <div style="width:48px;height:5px;background:#f1f5f9;border-radius:999px;overflow:hidden;">
                    <div style="height:100%;width:${barW}%;background:${c.cor};border-radius:999px;opacity:0.7;"></div>
                  </div>
                  <span style="color:#64748b;font-size:12px;">${pct.toFixed(1)}%</span>
                </div>
              </td>
              <td style="padding:9px 12px;text-align:right;color:#64748b;font-size:12.5px;">${BRL(ticket)}</td>
            </tr>`;
        }).join('')}
      </tbody>
      <tfoot>
        <tr style="border-top:2px solid #e2e8f0;background:#f8fafc;">
          <td style="padding:9px 12px;font-weight:700;color:#0f172a;">Total</td>
          <td style="padding:9px 12px;text-align:center;font-weight:700;color:#0f172a;">${pacs.length}</td>
          <td style="padding:9px 12px;text-align:right;font-weight:800;color:#10b981;">${BRL(fat)}</td>
          <td style="padding:9px 12px;text-align:right;color:#64748b;font-size:12px;">100%</td>
          <td style="padding:9px 12px;text-align:right;font-weight:700;color:#0f172a;">${BRL(fat / pacs.length)}</td>
        </tr>
      </tfoot>
    </table>`;
}

// ====================== MRR / RECEITA RECORRENTE ======================
function _mrrDeInscricao(ins, prog) {
  // MRR de uma inscrição = preçoÀVista / vigênciaDias * 30
  if (!prog || prog.tipo !== 'Assinatura') return 0;
  const dias = _vigenciaDias(prog.vigencia);
  if (!dias || !prog.precoAVista) return 0;
  return (prog.precoAVista / dias) * 30;
}

function _vencimentoInscricao(ins, prog) {
  if (!prog || prog.tipo !== 'Assinatura') return null;
  // Prioridade: dataFim explícito (atualizado na renovação) → fallback dataInicio + vigência
  if (ins.dataFim) return ins.dataFim;
  if (ins.dataInicio) return _addDaysIso(ins.dataInicio, _vigenciaDias(prog.vigencia));
  return null;
}

function renderDashboardMRR(mes) {
  const sec = document.getElementById('dash-mrr-section');
  if (!sec) return;

  const inscricoes = getInscricoes();
  const programas  = getProgramas();
  const today = _ymd(new Date());

  // Considera ativas: status Ativo + vencimento futuro (ou sem vencimento, p/ não-Assinatura — ignoradas)
  let mrr = 0;
  const tipoCount = { Assinatura: 0, Fixo: 0, 'Contínuo': 0 };
  let subsAtivas = 0;
  let subsVencendo = 0;
  let receitaVencendo = 0;
  const ativasAssinatura = [];

  inscricoes.forEach(ins => {
    if (ins.status !== 'Ativo') return;
    const prog = programas.find(p => p.id === ins.programaId);
    if (!prog) return;
    if (prog.tipo === 'Assinatura') {
      const venc = _vencimentoInscricao(ins, prog);
      if (venc && venc < today) return; // já venceu, não conta como ativa
      ativasAssinatura.push({ ins, prog, venc });
      subsAtivas++;
      mrr += _mrrDeInscricao(ins, prog);
      // Vencendo nos próximos 30 dias
      const em30 = _addDaysIso(today, 30);
      if (venc && venc <= em30) {
        subsVencendo++;
        receitaVencendo += prog.precoAVista || 0;
      }
    }
    tipoCount[prog.tipo] = (tipoCount[prog.tipo] || 0) + 1;
  });

  // Novas no mês
  const novasMes = inscricoes.filter(i => {
    const prog = programas.find(p => p.id === i.programaId);
    return prog && prog.tipo === 'Assinatura' && (i.dataInicio || '').startsWith(mes);
  });
  const receitaNovas = novasMes.reduce((s, i) => {
    const prog = programas.find(p => p.id === i.programaId);
    return s + (prog ? (prog.precoAVista || 0) : 0);
  }, 0);

  // Esconde a seção se não houver nenhum programa ativo nem inscrição
  if (!ativasAssinatura.length && !novasMes.length) {
    sec.style.display = 'none';
    return;
  }
  sec.style.display = '';

  setText('dash-mrr', BRL(Math.round(mrr)));
  setText('dash-arr', BRL(Math.round(mrr * 12)));
  setText('dash-subs-ativas', subsAtivas);

  // Breakdown por vigência (Mensal/Trimestral/Semestral/Anual)
  const porVigencia = {};
  ativasAssinatura.forEach(({ prog }) => {
    porVigencia[prog.vigencia] = (porVigencia[prog.vigencia] || 0) + 1;
  });
  const ordem = ['Mensal','Trimestral','Semestral','Anual'];
  const breakdown = ordem.filter(v => porVigencia[v]).map(v => `${porVigencia[v]} ${v.toLowerCase()}`).join(' · ') || 'Concierge medicine';
  setText('dash-subs-breakdown', breakdown);

  setText('dash-subs-novas', novasMes.length);
  setText('dash-subs-novas-receita', novasMes.length ? `${BRL(receitaNovas)} em receita` : 'Nenhuma nova inscrição');

  setText('dash-subs-vencendo', subsVencendo);
  setText('dash-subs-vencendo-receita', subsVencendo ? `${BRL(receitaVencendo)} a renovar` : 'Tudo em dia ✓');

  // Cor do card "A vencer" muda conforme criticidade
  const vencCard = document.getElementById('dash-subs-vencendo')?.closest('.kpi-card');
  if (vencCard) {
    vencCard.style.borderLeftColor = subsVencendo === 0 ? '#10b981' : subsVencendo <= 2 ? '#f59e0b' : '#ef4444';
  }

  // Banner detalhado de renovações próximas
  renderRenovacoesBanner(ativasAssinatura, today);
}

// Banner do Dashboard com lista das próximas renovações + botões de ação
function renderRenovacoesBanner(ativasAssinatura, today) {
  const banner = document.getElementById('dash-renovacoes-banner');
  if (!banner) return;

  // Filtra vencendo até 30 dias + ordena por proximidade
  const em30 = _addDaysIso(today, 30);
  const lista = ativasAssinatura
    .filter(x => x.venc && x.venc <= em30)
    .map(x => ({ ...x, diasRestantes: Math.ceil((new Date(x.venc) - new Date(today)) / 86400000) }))
    .sort((a, b) => a.diasRestantes - b.diasRestantes);

  if (!lista.length) {
    banner.style.display = 'none';
    banner.innerHTML = '';
    return;
  }

  // Cor do banner baseada na mais crítica
  const minDias = lista[0].diasRestantes;
  const corBorda = minDias <= 7 ? '#ef4444' : minDias <= 15 ? '#f59e0b' : '#3b82f6';
  const corBg    = minDias <= 7 ? '#fef2f2' : minDias <= 15 ? '#fffbeb' : '#eff6ff';
  const icone    = minDias <= 7 ? '🚨' : minDias <= 15 ? '⚠️' : '🔔';
  const titulo   = minDias <= 7 ? 'Renovações urgentes' : minDias <= 15 ? 'Renovações próximas' : 'Atenção: renovações em até 30 dias';

  banner.style.display = '';
  banner.innerHTML = `
    <div style="background:${corBg};border:1px solid ${corBorda}40;border-left:4px solid ${corBorda};border-radius:10px;padding:16px 18px;">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;">
        <span style="font-size:18px;">${icone}</span>
        <div style="flex:1;">
          <div style="font-size:14px;font-weight:700;color:#0f172a;">${titulo} <span style="background:#fff;color:${corBorda};font-size:11px;padding:1px 8px;border-radius:999px;font-weight:700;margin-left:4px;">${lista.length}</span></div>
          <div style="font-size:11.5px;color:#64748b;margin-top:1px;">Assinaturas vencendo nos próximos 30 dias — entre em contato e renove a tempo</div>
        </div>
        <button onclick="this.parentNode.parentNode.style.display='none';document.getElementById('dash-renovacoes-banner').style.display='none';" title="Fechar"
          style="background:none;border:none;color:#94a3b8;font-size:18px;cursor:pointer;padding:0 6px;">×</button>
      </div>
      <div style="display:flex;flex-direction:column;gap:6px;max-height:280px;overflow-y:auto;">
        ${lista.map(({ ins, prog, diasRestantes, venc }) => {
          const ehUrgente   = diasRestantes <= 7;
          const corDias     = diasRestantes <= 0 ? '#dc2626' : diasRestantes <= 7 ? '#ef4444' : diasRestantes <= 15 ? '#f59e0b' : '#3b82f6';
          const labelDias   = diasRestantes <= 0 ? `Vencido há ${Math.abs(diasRestantes)}d` : diasRestantes === 1 ? 'Vence amanhã' : `${diasRestantes} dias`;
          const waLink      = ins.pacienteWhatsapp ? _waMeLink(ins.pacienteWhatsapp, 'Olá ' + ins.pacienteNome.split(' ')[0] + '! Seu programa ' + prog.nome + ' vence em ' + formatDate(venc) + '. Gostaria de renovar?') : '';
          return `
            <div style="display:flex;align-items:center;gap:12px;padding:9px 12px;background:#fff;border:1px solid #e2e8f0;border-radius:8px;">
              <div style="flex:1;min-width:0;">
                <div style="font-size:13px;font-weight:600;color:#0f172a;">${_esc(ins.pacienteNome)}</div>
                <div style="font-size:11.5px;color:#64748b;margin-top:1px;">${_esc(prog.nome)} · Vence em ${formatDate(venc)}</div>
              </div>
              <span style="background:${corDias}15;color:${corDias};font-size:11px;font-weight:700;padding:3px 9px;border-radius:999px;white-space:nowrap;">${labelDias}</span>
              ${waLink ? `<a href="${waLink}" target="_blank" rel="noopener" title="Avisar pelo WhatsApp"
                style="background:#25d36615;color:#075e54;border:none;border-radius:6px;padding:5px 10px;font-size:11px;font-weight:600;text-decoration:none;display:inline-flex;align-items:center;gap:4px;">💬 Avisar</a>` : ''}
              <button onclick="renovarInscricao('${ins.id}')"
                style="background:${ehUrgente ? '#dc2626' : '#7c3aed'};color:#fff;border:none;border-radius:6px;padding:5px 11px;font-size:11.5px;font-weight:700;cursor:pointer;white-space:nowrap;">🔄 Renovar</button>
            </div>`;
        }).join('')}
      </div>
    </div>`;
}

// Mês (YYYY-MM) mais recente com QUALQUER lançamento (paciente ou despesa),
// diferente de `excluirMes`. Usado pro banner "sem dados neste mês".
function _mesMaisRecenteComDados(excluirMes) {
  const meses = new Set();
  DB.get('pacientes').forEach(p => { if (p.data) meses.add(getMes(p.data)); });
  DB.get('despesas').forEach(d => { if (d.data) meses.add(getMes(d.data)); });
  const lista = Array.from(meses).filter(m => m && m !== excluirMes).sort();
  return lista.length ? lista[lista.length - 1] : null;
}

function renderDashboard(mes) {
  _populateMesSelect('dash-mes-filter', { selected: mes });
  mes = document.getElementById('dash-mes-filter')?.value || _ymd(new Date()).substring(0, 7);
  const pacs  = DB.get('pacientes').filter(p => getMes(p.data) === mes);
  const desps = DB.get('despesas').filter(d => getMes(d.data) === mes);
  const crm   = DB.get('crm').filter(c => getMes(c.data) === mes);
  const agenda = DB.get('agenda').filter(a => getMes(a.data) === mes);

  // Banner "sem lançamentos neste mês" — sem isso, um mês recém-começado (ou
  // um filtro esquecido em outro mês) mostra tudo R$0 e parece app quebrado.
  const bannerVazio = document.getElementById('dash-mes-vazio-banner');
  if (bannerVazio) {
    const mesAlt = (!pacs.length && !desps.length) ? _mesMaisRecenteComDados(mes) : null;
    if (mesAlt) {
      const [ay, am] = mesAlt.split('-').map(Number);
      const [my, mm] = mes.split('-').map(Number);
      bannerVazio.style.display = 'block';
      bannerVazio.innerHTML = `<div style="background:#eff6ff;border:1.5px solid #bfdbfe;border-radius:12px;padding:14px 18px;margin-bottom:20px;display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
        <span style="font-size:18px;">📅</span>
        <span style="font-size:13px;color:#1e40af;flex:1;min-width:220px;"><strong>Nenhum lançamento em ${_esc(_MESES_FULL[mm - 1])} ${my} ainda.</strong> O último mês com dados foi ${_esc(_MESES_FULL[am - 1])} ${ay}.</span>
        <button class="btn-ghost" style="background:#fff;" onclick="updateDashboard('${mesAlt}')">Ver ${_esc(_MESES_FULL[am - 1])} ${ay}</button>
      </div>`;
    } else {
      bannerVazio.style.display = 'none';
    }
  }

  // Padronização de métricas (idem renderDespesas e renderRelatorio):
  // - fat = faturamento bruto (tudo emitido) — usado para KPI principal
  // - receitaRealizada = só pagos — base de lucro contábil
  const fat              = pacs.reduce((s, p) => s + p.valor, 0); // bruto
  const receitaRealizada = pacs.filter(p => p.statusPgto === 'Pago').reduce((s, p) => s + (p.valor || 0), 0);
  const totalDesp = desps.reduce((s, d) => s + d.valor, 0);
  const lucro     = receitaRealizada - totalDesp; // ALINHADO com Despesas (lucro sobre realizado)
  const margem    = receitaRealizada ? (lucro / receitaRealizada) * 100 : 0;
  const ticket    = pacs.length ? fat / pacs.length : 0;
  const inad      = pacs.filter(p => p.statusPgto === 'Pendente').reduce((s, p) => s + p.valor, 0);
  const inadPct   = fat ? (inad / fat) * 100 : 0;

  // ===== Comparativo mês anterior =====
  const [anoN, mesN] = mes.split('-').map(Number);
  const prevDate  = new Date(anoN, mesN - 2, 1);
  const prevMes   = _ymd(prevDate).substring(0, 7);
  const prevLabel = MESES[prevDate.getMonth()];
  const prevPacs   = DB.get('pacientes').filter(p => getMes(p.data) === prevMes);
  const prevDesps  = DB.get('despesas').filter(d => getMes(d.data) === prevMes);
  const prevAgenda = DB.get('agenda').filter(a => getMes(a.data) === prevMes);
  const prevCrm    = DB.get('crm').filter(c => getMes(c.data) === prevMes);
  const prevFat    = prevPacs.reduce((s, p) => s + p.valor, 0);
  const prevRec    = prevPacs.filter(p => p.statusPgto === 'Pago').reduce((s, p) => s + (p.valor || 0), 0);
  const prevDesp   = prevDesps.reduce((s, d) => s + d.valor, 0);
  const prevPacN   = prevPacs.length;
  const prevLucro  = prevRec - prevDesp; // lucro sobre realizado (consistente)
  const prevTotVagas = prevAgenda.reduce((s, a) => s + a.vagas, 0);
  const prevTotOcup  = prevAgenda.reduce((s, a) => s + a.ocupadas, 0);
  const prevOcup     = prevTotVagas ? (prevTotOcup / prevTotVagas) * 100 : 0;
  const prevAtend    = prevCrm.filter(c => c.status === 'Atendeu').length;
  const prevConv     = prevCrm.length ? (prevAtend / prevCrm.length) * 100 : 0;

  // Helper: HTML de variação (↑/↓/—) com cor semântica
  function varHtml(curr, prev, invertido = false) {
    if (!prev) return `<span style="font-size:11px;color:#94a3b8;">— sem dado anterior</span>`;
    const pct    = ((curr - prev) / prev) * 100;
    const absPct = Math.abs(pct);
    const fmtStr = absPct.toFixed(1); // ex: "0.0", "1.2", "12.5"
    // Neutro se variação < 1% OU se o valor formatado seria "0.0" (evita "↑ 0.0%")
    if (absPct < 1 || fmtStr === '0.0') {
      return `<span style="font-size:11.5px;font-weight:600;color:#64748b;">= estável</span> <span style="font-size:10.5px;color:#94a3b8;">vs ${prevLabel}</span>`;
    }
    const positivo = invertido ? pct < 0 : pct > 0; // despesas: subir é ruim
    const cor  = positivo ? '#10b981' : '#ef4444';
    const seta = pct > 0 ? '↑' : '↓';
    return `<span style="font-size:11.5px;font-weight:700;color:${cor};">${seta} ${fmtStr}%</span> <span style="font-size:10.5px;color:#94a3b8;">vs ${prevLabel}</span>`;
  }

  const totVagas  = agenda.reduce((s, a) => s + a.vagas, 0);
  const totOcup   = agenda.reduce((s, a) => s + a.ocupadas, 0);
  const ocup      = totVagas ? (totOcup / totVagas) * 100 : 0;
  const noshow    = agenda.reduce((s, a) => s + a.noshow, 0);
  const noshowPct = totVagas ? (noshow / totVagas) * 100 : 0;

  const atend = crm.filter(c => c.status === 'Atendeu').length;
  const conv  = crm.length ? (atend / crm.length) * 100 : 0;

  // ===== Popula KPIs =====
  setText('kpi-fat', BRL(fat));

  // Trend faturamento: variação real vs mês anterior (nunca "↑ 0%")
  const trendEl = document.getElementById('kpi-fat-trend');
  if (trendEl) trendEl.innerHTML = varHtml(fat, prevFat);

  // Sub-linha faturamento: pagos + inadimplência (se houver)
  const nPagos = pacs.filter(p => p.statusPgto === 'Pago').length;
  let fatSub = fat ? `${nPagos} pago${nPagos !== 1 ? 's' : ''}` : 'Sem lançamentos';
  if (inadPct > 0) fatSub += ` · <span style="color:#f59e0b;font-weight:600;">${inadPct.toFixed(1)}% inadimp.</span>`;
  const fatSubEl = document.getElementById('kpi-fat-sub');
  if (fatSubEl) fatSubEl.innerHTML = fatSub;

  setText('kpi-lucro', BRL(lucro));
  setText('kpi-margem', `Margem: ${PCT(margem)}`);
  setText('kpi-pac', pacs.length);
  const _tkDash = _ticketMedio(pacs);
  setText('kpi-ticket', _tkDash.qtdGratuitos
    ? `${BRL(_tkDash.porConsultaPaga)} por consulta paga · ${BRL(_tkDash.porAtendimento)} geral`
    : BRL(_tkDash.porConsultaPaga));

  // Sub-linha pacientes: variação real
  const pacSubEl = document.getElementById('kpi-pac-sub');
  if (pacSubEl) pacSubEl.innerHTML = varHtml(pacs.length, prevPacN);

  setText('kpi-ocup', PCT(ocup));
  const bar = document.getElementById('kpi-ocup-bar');
  if (bar) bar.style.width = Math.min(ocup, 100) + '%';
  // Cor dinâmica da barra: verde >75%, amarelo >50%, vermelho <50%
  if (bar) bar.style.background = ocup >= 75 ? 'linear-gradient(90deg,#10b981,#34d399)' : ocup >= 50 ? 'linear-gradient(90deg,#f59e0b,#fcd34d)' : 'linear-gradient(90deg,#ef4444,#fca5a5)';
  // Cor dinâmica: valor + ícone (verde ≥75%, âmbar ≥50%, vermelho <50%)
  const ocupEl   = document.getElementById('kpi-ocup');
  const ocupIcon = document.getElementById('kpi-ocup-icon');
  if (ocupEl)   ocupEl.style.color       = ocup >= 75 ? '#10b981' : ocup >= 50 ? '#f59e0b' : '#ef4444';
  if (ocupIcon) {
    ocupIcon.className = 'kpi-icon ' + (ocup >= 75 ? 'green' : ocup >= 50 ? 'amber' : 'red');
  }
  setText('kpi-noshow', `No-show: ${PCT(noshowPct)}`);

  // Lucro Líquido: trend vs mês anterior
  const lucroTrendEl = document.getElementById('kpi-lucro-trend');
  if (lucroTrendEl) lucroTrendEl.innerHTML = varHtml(lucro, prevLucro);

  // Despesas: variação real (invertido=true: subir é ruim)
  setText('kpi-desp', BRL(totalDesp));
  const despSubEl = document.getElementById('kpi-desp-sub');
  if (despSubEl) despSubEl.innerHTML = varHtml(totalDesp, prevDesp, true);

  // Inadimplência: exibida no sub-texto do card de Faturamento (kpi-fat-sub acima)

  setText('kpi-conv', PCT(conv));
  setText('kpi-conv-sub', `${atend} de ${crm.length} contatos`);

  // Ocupação: trend vs mês anterior
  const ocupTrendEl = document.getElementById('kpi-ocup-trend');
  if (ocupTrendEl) ocupTrendEl.innerHTML = varHtml(ocup, prevOcup);

  // Conversão CRM: trend vs mês anterior
  const convTrendEl = document.getElementById('kpi-conv-trend');
  if (convTrendEl) convTrendEl.innerHTML = varHtml(conv, prevConv);

  // MRR / Receita Recorrente (programas de assinatura)
  renderDashboardMRR(mes);
  // Breakdown por procedimento
  renderProcBreakdown(pacs);
  // Pacote 3 — Retenção e LTV (independe do mês: usa todo o histórico)
  renderRetencao();
  // Pacote 2 — Aquisição e Marketing (CAC/ROI usam mês atual; canais/funil usam histórico)
  renderMarketing(mes);
  // Pacote 1 — Inteligência financeira (projeção/DRE/runway)
  renderFinanceiro(mes);
  // Timestamp de última atualização
  const tsEl = document.getElementById('dash-last-update');
  if (tsEl) {
    const agora = new Date();
    const hhmm  = agora.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    tsEl.textContent = `Atualizado às ${hhmm}`;
  }
  // Saudação (era texto fixo "Bom dia, Dr. Rafael" — errado à tarde/noite e
  // com nome de exemplo hardcoded).
  const saudEl = document.getElementById('dash-saudacao');
  if (saudEl) {
    const primeiroNome = _primeiroNomeSemTitulo(currentNome);
    const tratamento = currentRole === 'medico' ? _comTituloMedico(primeiroNome) : primeiroNome;
    saudEl.textContent = tratamento ? `${_saudacaoPorHora()}, ${tratamento}` : _saudacaoPorHora();
  }

  // Sprint 4 — Alertas proativos automáticos (sem IA)
  renderAlertasProativos({ fat, totalDesp, lucro, ocup, noshowPct, inadPct, inad, conv, crm, pacs, mes });

  // Pacote 5 — Insights Sofia (carrega do cache; só chama API se botão for clicado)
  const cacheInsights = carregarInsightsCache();
  if (cacheInsights) renderInsightCards(cacheInsights.insights, cacheInsights.ts);
  // Pacote 5 — Gráficos de tendência
  renderGraficos(mes);
  // Pacote 5.3 — Novos gráficos
  renderChartReceitaMeta();
  renderChartOcupacao();
  // Aplica preferência de visibilidade (ocultar/mostrar)
  applySectionVisibility();

  // Chart canais
  destroyChart('chart-canais');
  const canais = ['Ind. médica','Ind. paciente','Google','Instagram','WhatsApp','Doctoralia','Outros'];
  const canaisKeys = ['Indicação médica','Indicação paciente','Google','Instagram','WhatsApp','Doctoralia','Outros'];
  const canalData = canaisKeys.map(c => DB.get('crm').filter(r => r.canal === c).length);
  const ctx1 = document.getElementById('chart-canais');
  if (!ctx1) return;
  const ctx1c = ctx1.getContext('2d');
  if (canalData.some(v => v > 0)) {
    charts['chart-canais'] = new Chart(ctx1c, {
      type: 'bar',
      data: {
        labels: canais,
        datasets: [{ data: canalData, backgroundColor: ['#10b981','#34d399','#3b82f6','#8b5cf6','#f59e0b','#ef4444','#94a3b8'], borderRadius: 8, borderSkipped: false }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { beginAtZero: true, ticks: { stepSize: 1, font: { size: 11 } }, grid: { color: '#f1f5f9' } },
          x: { ticks: { font: { size: 11 } }, grid: { display: false } }
        }
      }
    });
  } else {
    ctx1c.fillStyle = '#cbd5e1'; ctx1c.textAlign = 'center'; ctx1c.font = '13px Inter';
    ctx1c.fillText('Adicione contatos no CRM para ver dados', ctx1.width/2, ctx1.height/2);
  }

  // Chart despesas dashboard
  destroyChart('chart-despesas');
  const cats = ['Estrutura','Pessoal','Marketing','Materiais','Profissional','Impostos','Outros'];
  const catData = cats.map(c => desps.filter(d => d.categoria === c).reduce((s, d) => s + d.valor, 0));
  const ctx2 = document.getElementById('chart-despesas');
  if (!ctx2) return;
  const ctx2c = ctx2.getContext('2d');
  if (catData.some(v => v > 0)) {
    charts['chart-despesas'] = new Chart(ctx2c, {
      type: 'doughnut',
      data: {
        labels: cats,
        datasets: [{ data: catData, backgroundColor: ['#ef4444','#f97316','#eab308','#10b981','#3b82f6','#8b5cf6','#94a3b8'], borderWidth: 0, hoverOffset: 6 }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom', labels: { font: { size: 11 }, padding: 12, boxWidth: 10 } } },
        cutout: '68%'
      }
    });
  } else {
    ctx2c.fillStyle = '#cbd5e1'; ctx2c.textAlign = 'center'; ctx2c.font = '13px Inter';
    ctx2c.fillText('Sem despesas registradas', ctx2.width/2, ctx2.height/2);
  }

  renderFunilDashboard();
  renderUltimasConsultas();
}

function updateDashboard(val) {
  const [y, m] = val.split('-');
  const label = `${_MESES_FULL[parseInt(m,10)-1]}/${y}`;
  // dash-mes foi consolidado em dash-subtitulo — só atualiza se existir
  const oldEl = document.getElementById('dash-mes');
  if (oldEl) oldEl.textContent = label;
  // Atualiza subtítulo com nome da clínica + mês selecionado
  const subEl = document.getElementById('dash-subtitulo');
  if (subEl) {
    const cfg = typeof getClinicaConfig === 'function' ? getClinicaConfig() : {};
    const partes = [cfg.nomeClinica, cfg.especialidade].filter(Boolean);
    subEl.textContent = (partes.length ? partes.join(' · ') + ' · ' : '') + label.replace('/', ' de ');
  }
  renderDashboard(val);
}

// ====================== SPRINT 4: ALERTAS PROATIVOS ======================
function renderAlertasProativos({ fat, totalDesp, lucro, ocup, noshowPct, inadPct, inad, conv, crm, pacs, mes }) {
  const container = document.getElementById('alertas-proativos-cards');
  if (!container) return;

  const metas  = DB.getObj('metas', { fat: 0, pac: 0, desp: 0 });
  const alertas = [];

  // ── 1. No-show alto (≥ 20%) ──
  if (noshowPct >= 20) {
    alertas.push({
      tipo: 'danger',
      icone: '📵',
      titulo: `No-show alto: ${PCT(noshowPct)} este mês`,
      descricao: 'Taxa de ausência acima de 20%. Ative lembretes automáticos por WhatsApp 24h antes das consultas.'
    });
  }

  // ── 2. Ocupação baixa (> 0% agenda registrada, mas < 60%) ──
  if (ocup > 0 && ocup < 60) {
    const cor = ocup < 40 ? 'danger' : 'warning';
    alertas.push({
      tipo: cor,
      icone: '📅',
      titulo: `Ocupação baixa: ${PCT(ocup)}`,
      descricao: ocup < 40
        ? 'Agenda muito subutilizada. Verifique horários disponíveis e acione reativação de pacientes.'
        : 'Agenda abaixo de 60%. Considere abrir encaixes ou contatar pacientes inativos.'
    });
  }

  // ── 3. Meta de faturamento em risco ──
  if (metas.fat > 0 && fat > 0) {
    const [anoN, mesN] = mes.split('-').map(Number);
    const hoje    = new Date();
    // Usar data do mês filtrado, não necessariamente hoje
    const diasTotal   = new Date(anoN, mesN, 0).getDate();
    const diaRef      = (anoN === hoje.getFullYear() && mesN === hoje.getMonth() + 1)
                          ? hoje.getDate()
                          : diasTotal; // mês passado = completo
    const progressoReal    = fat / metas.fat * 100;
    const progressoEsperado = (diaRef / diasTotal) * 100;
    if (diaRef >= 10 && progressoReal < progressoEsperado * 0.70) {
      alertas.push({
        tipo: 'danger',
        icone: '🎯',
        titulo: `Meta em risco: ${progressoReal.toFixed(0)}% atingido`,
        descricao: `${BRL(fat)} faturado de ${BRL(metas.fat)} meta. Ritmo atual está 30%+ abaixo do necessário para bater a meta.`
      });
    }
  }

  // ── 4. Inadimplência alta (≥ 15%) ──
  if (inadPct >= 15) {
    alertas.push({
      tipo: 'warning',
      icone: '💸',
      titulo: `Inadimplência: ${PCT(inadPct)} (${BRL(inad)})`,
      descricao: `Pagamentos pendentes acima de 15% do faturamento. Entre em contato com os pacientes devedores antes do fechamento do mês.`
    });
  }

  // ── 5. Pacientes sumidos (última visita > 6 meses atrás) ──
  const todos = DB.get('pacientes');
  const seisMesesAtras = new Date();
  seisMesesAtras.setMonth(seisMesesAtras.getMonth() - 6);
  const ultimaVisita = {};
  todos.forEach(p => {
    if (!p.nome) return;
    const d = new Date(p.data);
    if (!ultimaVisita[p.nome] || d > ultimaVisita[p.nome]) ultimaVisita[p.nome] = d;
  });
  const sumidos = Object.entries(ultimaVisita)
    .filter(([, d]) => d < seisMesesAtras)
    .map(([nome]) => nome);
  if (sumidos.length > 0) {
    const preview = sumidos.slice(0, 3).join(', ') + (sumidos.length > 3 ? ` e mais ${sumidos.length - 3}` : '');
    alertas.push({
      tipo: 'info',
      icone: '👤',
      titulo: `${sumidos.length} paciente${sumidos.length > 1 ? 's' : ''} sem retorno há +6 meses`,
      descricao: `${preview}. Oportunidade de reativação: um contato proativo pode recuperar esses pacientes.`
    });
  }

  // ── 6. Conversão CRM baixa (< 40% com mínimo 5 contatos) ──
  if (crm.length >= 5 && conv < 40) {
    const atend = crm.filter(c => c.status === 'Atendeu').length;
    alertas.push({
      tipo: 'warning',
      icone: '📊',
      titulo: `Conversão CRM baixa: ${PCT(conv)}`,
      descricao: `Apenas ${atend} de ${crm.length} contatos converteram em consulta. Revise o processo de follow-up no funil.`
    });
  }

  // Atualiza contador no header
  const cnt = document.getElementById('analise-count-alertas');
  if (cnt) {
    if (alertas.length === 0) {
      cnt.textContent = 'Tudo em ordem';
      cnt.style.color = '#10b981';
    } else {
      cnt.textContent = `${alertas.length} ${alertas.length === 1 ? 'alerta' : 'alertas'}`;
      cnt.style.color = '#f59e0b';
    }
    cnt.style.fontWeight = '600';
  }

  // ── Renderiza ──
  if (alertas.length === 0) {
    container.innerHTML = `
      <div style="display:flex;align-items:center;gap:12px;padding:14px 18px;background:#f0fdf4;border-radius:10px;border:1px solid #bbf7d0;">
        <span style="font-size:22px;">✅</span>
        <div>
          <div style="font-size:13px;font-weight:700;color:#166534;">Tudo sob controle</div>
          <div style="font-size:12px;color:#15803d;margin-top:2px;">Nenhum alerta crítico identificado para este período.</div>
        </div>
      </div>`;
    return;
  }

  const cores = {
    danger:  { bg: '#fff1f2', border: '#ef4444', titleColor: '#9f1239', bodyBorder: 'rgba(239,68,68,0.15)' },
    warning: { bg: '#fffbeb', border: '#f59e0b', titleColor: '#78350f', bodyBorder: 'rgba(245,158,11,0.15)' },
    info:    { bg: '#eff6ff', border: '#3b82f6', titleColor: '#1e3a8a', bodyBorder: 'rgba(59,130,246,0.15)' }
  };

  container.innerHTML = alertas.map(a => {
    const c = cores[a.tipo] || cores.info;
    return `
      <div style="display:flex;align-items:flex-start;gap:12px;padding:14px 18px;background:${c.bg};border-radius:10px;border:1px solid ${c.bodyBorder};border-left:3px solid ${c.border};">
        <span style="font-size:20px;flex-shrink:0;line-height:1.4;">${a.icone}</span>
        <div style="flex:1;">
          <div style="font-size:13px;font-weight:700;color:${c.titleColor};">${_esc(a.titulo)}</div>
          <div style="font-size:12px;color:#64748b;margin-top:3px;line-height:1.5;">${_esc(a.descricao)}</div>
        </div>
      </div>`;
  }).join('');
}

// ====================== RELATÓRIO ======================
// Taxas estimadas de mercado (Brasil 2026) — usadas pra calcular "receita perdida em taxas"
const TAXA_PAGAMENTO = {
  'PIX': 0,
  'Dinheiro': 0,
  'A receber': 0,
  'Cartão débito': 0.02,    // ~2%
  'Cartão crédito': 0.035,  // ~3.5%
};

function gerarPDF(mes) {
  const pacs   = DB.get('pacientes').filter(p => getMes(p.data) === mes);
  const desps  = DB.get('despesas').filter(d => getMes(d.data) === mes);
  const crm    = DB.get('crm').filter(c => getMes(c.data) === mes);
  const metas  = DB.getObj('metas', { fat: 0, pac: 0, desp: 0 });
  const todosPacs = DB.get('pacientes');

  const _rfPdf     = _resumoFin(pacs);
  const fat        = _rfPdf.bruto;
  const totalDesp  = desps.reduce((s, d) => s + d.valor, 0);
  // Lucro em regime de CAIXA (recebido − despesas) — igual ao Relatório na tela.
  // Antes usava o bruto e divergia do número que aparece no app.
  const lucro      = _rfPdf.recebido - totalDesp;
  const margem     = _rfPdf.recebido ? (lucro / _rfPdf.recebido) * 100 : 0;
  const ticket     = pacs.length ? fat / pacs.length : 0;
  const _tkPdf     = _ticketMedio(pacs);
  const atend      = crm.filter(c => c.status === 'Atendeu').length;
  const conv       = crm.length ? (atend / crm.length) * 100 : 0;

  // Procedimentos — agora distingue atendimentos avulsos de programas de assinatura
  const procMap = {};
  pacs.forEach(p => {
    let k;
    if ((p.obs || '').includes('[Programa')) {
      // Lançamento de programa: usa o nome do programa (ex: "Programa Compagni")
      k = p.procedimento || 'Programa de assinatura';
    } else {
      k = p.tipo || p.procedimento || '(sem procedimento)';
    }
    if (!procMap[k]) procMap[k] = { qtd: 0, total: 0, isProg: (p.obs||'').includes('[Programa') };
    procMap[k].qtd++; procMap[k].total += (p.valor || 0);
  });
  const procStats = Object.entries(procMap)
    .map(([nome, v]) => ({ nome, ...v, ticket: v.qtd ? v.total / v.qtd : 0, pct: fat ? (v.total / fat) * 100 : 0 }))
    .sort((a, b) => b.total - a.total);

  // Mix pagamento
  const formasStats = ['PIX','Cartão crédito','Cartão débito','Dinheiro','A receber'].map(f => {
    const lista = pacs.filter(p => p.pagamento === f);
    const total = lista.reduce((s, p) => s + (p.valor || 0), 0);
    const taxa  = TAXA_PAGAMENTO[f] || 0;
    return { forma: f, qtd: lista.length, total, taxa, taxaValor: total * taxa, pct: fat ? (total / fat) * 100 : 0 };
  }).filter(s => s.qtd > 0).sort((a, b) => b.total - a.total);
  const totalTaxas = formasStats.reduce((s, f) => s + f.taxaValor, 0);

  // Novos vs recorrentes — "novo" = 1º atendimento do paciente em toda a base
  const _primeiraData = {};
  [...todosPacs].sort((a, b) => (a.data || '').localeCompare(b.data || '')).forEach(p => {
    const n = (p.nome || '').toLowerCase().trim();
    if (n && !(n in _primeiraData)) _primeiraData[n] = p.data;
  });
  const _ehNovo = p => p.data === _primeiraData[(p.nome || '').toLowerCase().trim()];
  const pacsNovos = pacs.filter(_ehNovo);
  const pacsRec   = pacs.filter(p => !_ehNovo(p));
  const novosUnicos = new Set(pacsNovos.map(p => (p.nome || '').toLowerCase().trim())).size;
  const recUnicos   = new Set(pacsRec.map(p =>   (p.nome || '').toLowerCase().trim())).size;
  const fatNovos    = pacsNovos.reduce((s, p) => s + (p.valor || 0), 0);
  const fatRec      = pacsRec.reduce((s, p)   => s + (p.valor || 0), 0);

  // Despesas por categoria
  const despCat = {};
  desps.forEach(d => {
    const k = d.categoria || 'Outros';
    despCat[k] = (despCat[k] || 0) + (d.valor || 0);
  });
  const despCatRows = Object.entries(despCat).sort((a, b) => b[1] - a[1]);

  const mesLabel = mes ? new Date(mes + '-15').toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' }) : mes;
  const agora    = new Date().toLocaleString('pt-BR');

  const pct = (v) => isFinite(v) ? v.toFixed(1) + '%' : '—';
  const brl = BRL; // formatação global: sem centavos, com separador de milhar

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<title>Relatório ${mesLabel} — ${_esc(getClinicaConfig().nome || currentNome || 'Consultório')}</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: 'Segoe UI', Arial, sans-serif; font-size: 12px; color: #1e293b; background:#fff; padding: 0; }
  .page { padding: 36px 44px; }
  /* Header */
  .header { display:flex; justify-content:space-between; align-items:flex-start; border-bottom: 3px solid #10b981; padding-bottom: 18px; margin-bottom: 28px; }
  .header-left h1 { font-size: 22px; font-weight: 800; color: #0f172a; letter-spacing: -0.5px; }
  .header-left p  { font-size: 12px; color: #64748b; margin-top: 3px; }
  .header-right   { text-align:right; }
  .header-right .mes { font-size: 18px; font-weight: 700; color: #10b981; }
  .header-right .gen { font-size: 10px; color: #94a3b8; margin-top: 4px; }
  /* KPI cards */
  .kpis { display:grid; grid-template-columns: repeat(4,1fr); gap: 12px; margin-bottom: 28px; }
  .kpi { background:#f8fafc; border-radius: 10px; padding: 14px 16px; border-left: 3px solid #10b981; }
  .kpi.red  { border-left-color: #ef4444; }
  .kpi.blue { border-left-color: #3b82f6; }
  .kpi.amber{ border-left-color: #f59e0b; }
  .kpi label { font-size: 9.5px; font-weight: 700; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.07em; display:block; margin-bottom: 4px; }
  .kpi .val  { font-size: 20px; font-weight: 800; color: #0f172a; }
  .kpi .sub  { font-size: 10px; color: #64748b; margin-top: 2px; }
  /* Sections */
  .section { margin-bottom: 24px; }
  .section h2 { font-size: 13px; font-weight: 700; color: #0f172a; margin-bottom: 10px; padding-bottom: 6px; border-bottom: 1px solid #e2e8f0; }
  /* Tables */
  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  th { text-align: left; padding: 7px 10px; color: #64748b; font-weight: 600; border-bottom: 2px solid #e2e8f0; background: #f8fafc; }
  th.r, td.r { text-align: right; }
  td { padding: 7px 10px; border-bottom: 1px solid #f1f5f9; color: #334155; }
  tr.total td { font-weight: 700; background: #f0fdf4; border-top: 2px solid #10b981; color: #0f172a; }
  tr.sub-total td { font-weight: 600; background: #fef9ec; }
  .green { color: #16a34a; } .red-t { color: #dc2626; } .gray { color: #94a3b8; }
  /* 2-col grid */
  .two-col { display:grid; grid-template-columns:1fr 1fr; gap: 20px; margin-bottom: 24px; }
  /* Footer */
  .footer { margin-top: 32px; padding-top: 14px; border-top: 1px solid #e2e8f0; display:flex; justify-content:space-between; align-items:center; }
  .footer p { font-size: 9.5px; color: #94a3b8; }
  /* Print */
  @media print {
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .page { padding: 20px 28px; }
    .no-break { page-break-inside: avoid; }
    h2 { page-break-after: avoid; }
  }
  @page { margin: 10mm; size: A4; }
</style>
</head>
<body>
<div class="page">

  <!-- HEADER -->
  <div class="header">
    <div class="header-left">
      <h1>${_esc(getClinicaConfig().nome ? (currentRole==='medico'?_comTituloMedico(getClinicaConfig().nome):getClinicaConfig().nome) : currentNome ? (currentRole==='medico'?_comTituloMedico(currentNome):currentNome) : 'Consultório')}</h1>
      <p>${_esc(getClinicaConfig().especialidade || 'Medicina')} · Relatório Mensal de Gestão${getClinicaConfig().crm ? ' · '+_esc(getClinicaConfig().crm) : ''}</p>
    </div>
    <div class="header-right">
      <div class="mes">${mesLabel.charAt(0).toUpperCase() + mesLabel.slice(1)}</div>
      <div class="gen">Gerado em ${agora}</div>
    </div>
  </div>

  <!-- KPIs -->
  <div class="kpis">
    <div class="kpi">
      <label>Faturamento</label>
      <div class="val">${brl(fat)}</div>
      <div class="sub">${metas.fat ? pct((fat/metas.fat)*100) + ' da meta' : 'Meta não definida'}</div>
    </div>
    <div class="kpi red">
      <label>Despesas</label>
      <div class="val">${brl(totalDesp)}</div>
      <div class="sub">${pct(fat ? (totalDesp/fat)*100 : 0)} do faturamento</div>
    </div>
    <div class="kpi ${lucro >= 0 ? '' : 'red'}">
      <label>Lucro Líquido</label>
      <div class="val ${lucro < 0 ? 'red-t' : ''}">${brl(lucro)}</div>
      <div class="sub">Margem ${pct(margem)}</div>
    </div>
    <div class="kpi blue">
      <label>Atendimentos</label>
      <div class="val">${pacs.length}</div>
      <div class="sub">Ticket médio ${brl(_tkPdf.porConsultaPaga)} por consulta paga</div>
    </div>
  </div>

  <!-- RESULTADO FINANCEIRO + ATENDIMENTO -->
  <div class="two-col">
    <div class="section no-break">
      <h2>1. Resultado Financeiro</h2>
      <table>
        <thead><tr><th>Indicador</th><th class="r">Realizado</th><th class="r">Meta</th><th class="r">%</th></tr></thead>
        <tbody>
          <tr><td>Faturamento bruto</td><td class="r">${brl(fat)}</td><td class="r gray">${brl(metas.fat)}</td><td class="r">${metas.fat ? pct((fat/metas.fat)*100) : '—'}</td></tr>
          <tr><td>Despesas totais</td><td class="r red-t">${brl(totalDesp)}</td><td class="r gray">${brl(metas.desp)}</td><td class="r">${metas.desp ? pct((totalDesp/metas.desp)*100) : '—'}</td></tr>
          <tr class="total"><td>Lucro líquido</td><td class="r ${lucro<0?'red-t':'green'}">${brl(lucro)}</td><td class="r">—</td><td class="r">${pct(margem)}</td></tr>
          ${totalTaxas > 0 ? `<tr><td>Taxas estimadas</td><td class="r red-t">− ${brl(totalTaxas)}</td><td class="r">—</td><td class="r gray">${pct(fat ? (totalTaxas/fat)*100 : 0)}</td></tr>` : ''}
          ${despCatRows.map(([cat, val]) => `<tr><td class="gray">&nbsp;&nbsp;↳ ${cat}</td><td class="r gray">${brl(val)}</td><td class="r">—</td><td class="r gray">${pct(totalDesp ? (val/totalDesp)*100 : 0)}</td></tr>`).join('')}
        </tbody>
      </table>
    </div>
    <div class="section no-break">
      <h2>2. Indicadores de Atendimento</h2>
      <table>
        <thead><tr><th>Indicador</th><th class="r">Realizado</th><th class="r">Meta</th></tr></thead>
        <tbody>
          <tr><td>Pacientes atendidos</td><td class="r">${pacs.length}</td><td class="r gray">${metas.pac || '—'}</td></tr>
          <tr><td>Novos pacientes</td><td class="r">${novosUnicos}</td><td class="r gray">—</td></tr>
          <tr><td>Recorrentes</td><td class="r">${recUnicos}</td><td class="r gray">—</td></tr>
          <tr><td>Ticket médio <span class="gray">(consulta paga)</span></td><td class="r">${brl(_tkPdf.porConsultaPaga)}</td><td class="r gray">—</td></tr>
          ${_tkPdf.qtdGratuitos ? `<tr><td>Ticket médio <span class="gray">(por atendimento)</span></td><td class="r">${brl(_tkPdf.porAtendimento)}</td><td class="r gray">—</td></tr>` : ''}
          <tr><td>Conversão CRM</td><td class="r">${pct(conv)}</td><td class="r gray">60%</td></tr>
          <tr><td>Contatos no CRM</td><td class="r">${crm.length}</td><td class="r gray">—</td></tr>
        </tbody>
      </table>
    </div>
  </div>

  <!-- RECEITA POR PROCEDIMENTO -->
  ${procStats.length ? `
  <div class="section no-break">
    <h2>3. Receita por Procedimento</h2>
    <table>
      <thead><tr><th>Procedimento</th><th class="r">Qtd</th><th class="r">Receita</th><th class="r">% do mês</th><th class="r">Ticket</th></tr></thead>
      <tbody>
        ${procStats.map(s => `<tr><td>${s.isProg ? '🔁 ' : ''}${_esc(s.nome)}${s.isProg ? ' <span style="background:#eff6ff;color:#1d4ed8;font-size:9px;padding:1px 5px;border-radius:999px;font-weight:600;">assinatura</span>' : ''}</td><td class="r">${s.qtd}</td><td class="r">${brl(s.total)}</td><td class="r gray">${pct(s.pct)}</td><td class="r gray">${brl(s.ticket)}</td></tr>`).join('')}
        <tr class="total"><td>Total</td><td class="r">${pacs.length}</td><td class="r">${brl(fat)}</td><td class="r">100%</td><td class="r">${brl(ticket)}</td></tr>
      </tbody>
    </table>
  </div>` : ''}

  <!-- MIX DE PAGAMENTO -->
  ${formasStats.length ? `
  <div class="section no-break">
    <h2>4. Mix de Pagamento e Taxas</h2>
    <table>
      <thead><tr><th>Forma</th><th class="r">Qtd</th><th class="r">Receita</th><th class="r">% do mês</th><th class="r">Taxa est.</th><th class="r">Perda</th></tr></thead>
      <tbody>
        ${formasStats.map(s => `<tr><td>${s.forma}</td><td class="r">${s.qtd}</td><td class="r">${brl(s.total)}</td><td class="r gray">${pct(s.pct)}</td><td class="r gray">${s.taxa ? (s.taxa*100).toFixed(1)+'%' : '—'}</td><td class="r ${s.taxaValor > 0 ? 'red-t' : 'gray'}">${s.taxaValor > 0 ? '− '+brl(s.taxaValor) : '—'}</td></tr>`).join('')}
        <tr class="total"><td>Total</td><td class="r">${pacs.length}</td><td class="r">${brl(fat)}</td><td class="r">100%</td><td class="r">—</td><td class="r red-t">${totalTaxas > 0 ? '− '+brl(totalTaxas) : '—'}</td></tr>
      </tbody>
    </table>
  </div>` : ''}

  <!-- NOVOS VS RECORRENTES -->
  <div class="section no-break">
    <h2>5. Novos vs Recorrentes</h2>
    <table>
      <thead><tr><th>Categoria</th><th class="r">Pacientes únicos</th><th class="r">Atendimentos</th><th class="r">Receita</th><th class="r">% receita</th></tr></thead>
      <tbody>
        <tr><td>🆕 Novos pacientes</td><td class="r">${novosUnicos}</td><td class="r">${pacsNovos.length}</td><td class="r">${brl(fatNovos)}</td><td class="r gray">${pct(fat ? (fatNovos/fat)*100 : 0)}</td></tr>
        <tr><td>🔄 Recorrentes</td><td class="r">${recUnicos}</td><td class="r">${pacsRec.length}</td><td class="r">${brl(fatRec)}</td><td class="r gray">${pct(fat ? (fatRec/fat)*100 : 0)}</td></tr>
        <tr class="total"><td>Total</td><td class="r">${novosUnicos+recUnicos}</td><td class="r">${pacs.length}</td><td class="r">${brl(fat)}</td><td class="r">100%</td></tr>
      </tbody>
    </table>
  </div>

  <!-- LISTA COMPLETA -->
  ${pacs.length ? `
  <div class="section">
    <h2>6. Lista Completa de Atendimentos</h2>
    <table>
      <thead><tr><th>Data</th><th>Paciente</th><th>Procedimento</th><th class="r">Valor</th><th>Pagamento</th><th>Status</th></tr></thead>
      <tbody>
        ${pacs.sort((a,b) => (b.data||'').localeCompare(a.data||'')).map(p => `
        <tr><td>${formatDate(p.data)}</td><td>${_esc(p.nome)}</td><td>${_esc(p.tipo||'—')}</td><td class="r">${brl(p.valor)}</td><td>${_esc(p.pagamento||'—')}</td><td class="${p.statusPgto==='Pago'?'green':p.statusPgto==='Pendente'?'red-t':'gray'}">${_esc(p.statusPgto)}</td></tr>`).join('')}
        <tr class="total"><td colspan="3">Total</td><td class="r">${brl(fat)}</td><td colspan="2">${pacs.length} atendimento(s)</td></tr>
      </tbody>
    </table>
  </div>` : ''}

  ${(() => {
    const inscricoes = getInscricoes();
    const programas  = getProgramas();
    const today = _ymd(new Date());

    // Assinaturas ativas no mês
    const ativas = inscricoes.filter(i => {
      if (i.status !== 'Ativo') return false;
      const prog = programas.find(p => p.id === i.programaId);
      if (!prog || prog.tipo !== 'Assinatura') return false;
      const venc = _vencimentoInscricao(i, prog);
      return !venc || venc >= mes + '-01';
    });
    if (!ativas.length) return '';

    // Novas inscrições no mês
    const novasMes = inscricoes.filter(i => (i.dataInicio || '').startsWith(mes));
    const cancelMes = inscricoes.filter(i => i.status === 'Cancelado' && (i.dataFim || '').startsWith(mes));

    // MRR total
    let mrr = 0;
    ativas.forEach(i => {
      const prog = programas.find(p => p.id === i.programaId);
      mrr += _mrrDeInscricao(i, prog);
    });

    // Vencendo nos próximos 30 dias a partir de hoje
    const em30 = _addDaysIso(today, 30);
    const vencendo = ativas.filter(i => {
      const prog = programas.find(p => p.id === i.programaId);
      const venc = _vencimentoInscricao(i, prog);
      return venc && venc >= today && venc <= em30;
    });

    // Taxa de retenção do mês: (ativas - novas) / ativas_mes_anterior (estimativa)
    const retencao = ativas.length > 0
      ? ((ativas.length - novasMes.length) / Math.max(ativas.length, 1) * 100).toFixed(0)
      : 0;

    // Breakdown por programa
    const porProg = {};
    ativas.forEach(i => {
      const prog = programas.find(p => p.id === i.programaId);
      const key  = prog ? prog.nome : 'Desconhecido';
      if (!porProg[key]) porProg[key] = { qtd: 0, mrr: 0, prog };
      porProg[key].qtd++;
      porProg[key].mrr += _mrrDeInscricao(i, prog);
    });

    return `
  <div class="section no-break" style="break-before:auto;">
    <h2>7. Programas de Acompanhamento</h2>
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px;">
      <div class="kpi blue"><label>Assinaturas Ativas</label><div class="value">${ativas.length}</div></div>
      <div class="kpi"><label>MRR</label><div class="value">${brl(Math.round(mrr))}</div></div>
      <div class="kpi"><label>Novas no Mês</label><div class="value">${novasMes.length}</div></div>
      <div class="kpi ${cancelMes.length > 0 ? 'red' : ''}"><label>Cancelamentos</label><div class="value">${cancelMes.length}</div></div>
    </div>
    <table>
      <thead><tr><th>Programa</th><th class="r">Inscritos</th><th class="r">MRR do programa</th></tr></thead>
      <tbody>
        ${Object.entries(porProg).sort((a,b) => b[1].mrr - a[1].mrr).map(([nome, d]) =>
          `<tr><td>${_esc(nome)}</td><td class="r">${d.qtd}</td><td class="r">${brl(Math.round(d.mrr))}</td></tr>`
        ).join('')}
        <tr class="total"><td>Total</td><td class="r">${ativas.length}</td><td class="r">${brl(Math.round(mrr))}</td></tr>
      </tbody>
    </table>
    ${vencendo.length ? `
    <div style="margin-top:12px;padding:8px 12px;background:#fffbeb;border:1px solid #fde68a;border-radius:6px;font-size:11px;color:#92400e;">
      ⚠️ <strong>${vencendo.length} renovação(ões)</strong> prevista(s) nos próximos 30 dias · ${vencendo.map(i => _esc(i.pacienteNome)).join(', ')}
    </div>` : `
    <div style="margin-top:12px;padding:8px 12px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;font-size:11px;color:#166534;">
      ✅ Nenhuma renovação pendente nos próximos 30 dias.
    </div>`}
  </div>`;
  })()}

  <!-- FOOTER -->
  <div class="footer">
    <p>${_esc(getClinicaConfig().nome || currentNome || 'Consultório')} · ${_esc(getClinicaConfig().especialidade || 'Medicina')} · Consultório App</p>
    <p>Gerado em ${agora} · Documento confidencial</p>
  </div>

</div>
<script>window.onload = () => { window.print(); }<\/script>
</body>
</html>`;

  const win = window.open('', '_blank');
  win.document.write(html);
  win.document.close();
}

// ====================== RELATÓRIO ANUAL ======================
function gerarRelatorioAnual() {
  const hoje = new Date();
  const ano  = hoje.getFullYear();
  const allPacs  = DB.get('pacientes');
  const allDesps = DB.get('despesas');
  const allCrm   = DB.get('crm');
  const allFu    = DB.get('followup');
  const inscricoes = getInscricoes();
  const programas  = getProgramas();
  const clinica = getClinicaConfig();
  const meses = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];

  // Estatísticas por mês
  const dadosMes = meses.map((nome, i) => {
    const mes = `${ano}-${String(i+1).padStart(2,'0')}`;
    const pacs = allPacs.filter(p => getMes(p.data) === mes);
    const desps = allDesps.filter(d => getMes(d.data) === mes);
    const fat = pacs.reduce((s,p) => s + (p.valor||0), 0);
    const desp = desps.reduce((s,d) => s + (d.valor||0), 0);
    // Lucro no MESMO regime das demais telas (caixa: recebido − despesas).
    // Calcular sobre o bruto fazia o anual mostrar, para o mesmo mês, um lucro
    // bem maior que o Dashboard, o Relatório e o PDF.
    const lucro = _resumoFin(pacs).recebido - desp;

    // Inscrições novas no mês
    const novas = inscricoes.filter(i => (i.dataInicio||'').startsWith(mes));
    // Cancelamentos no mês
    const canc  = inscricoes.filter(i => i.status === 'Cancelado' && (i.dataFim||'').startsWith(mes));

    // MRR ativo ao final desse mês
    const fimMes = `${mes}-31`;
    const ativosNoFim = inscricoes.filter(i => {
      if (i.status === 'Cancelado') return false;
      if ((i.dataInicio||'') > fimMes) return false;
      const prog = programas.find(p => p.id === i.programaId);
      if (!prog || prog.tipo !== 'Assinatura') return false;
      const venc = _vencimentoInscricao(i, prog);
      return !venc || venc >= mes + '-01';
    });
    let mrr = 0;
    ativosNoFim.forEach(i => {
      const prog = programas.find(p => p.id === i.programaId);
      mrr += _mrrDeInscricao(i, prog);
    });

    return { mes, nome, pacs, fat, desp, lucro, novas, canc, ativosNoFim, mrr };
  });

  // Totais
  const totFat   = dadosMes.reduce((s,d) => s + d.fat, 0);
  const totDesp  = dadosMes.reduce((s,d) => s + d.desp, 0);
  const totLucro = totFat - totDesp;
  const totPacs  = dadosMes.reduce((s,d) => s + d.pacs.length, 0);
  const margem   = totFat ? (totLucro/totFat)*100 : 0;
  const ticketMedio = totPacs ? totFat/totPacs : 0;

  // Programas
  const totNovas = dadosMes.reduce((s,d) => s + d.novas.length, 0);
  const totCanc  = dadosMes.reduce((s,d) => s + d.canc.length, 0);
  const churnAnual = totNovas ? (totCanc / totNovas) * 100 : 0;
  const mrrFinal = dadosMes[hoje.getMonth()]?.mrr || 0;
  const mrrInicio = dadosMes.find(d => d.mrr > 0)?.mrr || 0;
  const crescimentoMrr = mrrInicio ? ((mrrFinal - mrrInicio) / mrrInicio * 100) : 0;

  // LTV estimado: ticket médio × tempo médio de vida (em meses)
  // Assumindo retenção média de 12 meses se não há dados
  const tempoMedioMeses = totCanc > 0 ? 12 / churnAnual * 100 / 12 * 12 : 24;
  const ltv = ticketMedio * (tempoMedioMeses / 6); // estimativa conservadora

  // Pacientes únicos no ano
  const pacUnicos = new Set();
  allPacs.forEach(p => {
    if ((p.data||'').startsWith(String(ano))) pacUnicos.add((p.nome||'').toLowerCase());
  });

  // Conversão CRM anual
  const crmAno = allCrm.filter(c => (c.data||'').startsWith(String(ano)));
  const crmAtendidos = crmAno.filter(c => c.status === 'Atendeu').length;
  const convAnual = crmAno.length ? (crmAtendidos/crmAno.length)*100 : 0;

  // Top 5 procedimentos
  const procMap = {};
  allPacs.filter(p => (p.data||'').startsWith(String(ano))).forEach(p => {
    const k = p.tipo || '(sem)';
    if (!procMap[k]) procMap[k] = { qtd: 0, total: 0 };
    procMap[k].qtd++;
    procMap[k].total += (p.valor||0);
  });
  const topProcs = Object.entries(procMap).sort((a,b) => b[1].total - a[1].total).slice(0,5);

  // Top 5 programas
  const progMap = {};
  inscricoes.filter(i => (i.dataInicio||'').startsWith(String(ano))).forEach(i => {
    const prog = programas.find(p => p.id === i.programaId);
    const k = prog ? prog.nome : 'Desconhecido';
    if (!progMap[k]) progMap[k] = { qtd: 0, mrr: 0 };
    progMap[k].qtd++;
    progMap[k].mrr += _mrrDeInscricao(i, prog);
  });
  const topProgs = Object.entries(progMap).sort((a,b) => b[1].mrr - a[1].mrr).slice(0,5);

  const brl = BRL;
  const pct = v => isFinite(v) ? v.toFixed(1) + '%' : '—';
  const nomeMed = clinica.nome || currentNome || 'Consultório';
  const tratamento = currentRole === 'medico' ? _comTituloMedico(nomeMed) : nomeMed;
  const agora = new Date().toLocaleString('pt-BR');

  const maxFat = Math.max(...dadosMes.map(d => d.fat), 1);
  const maxMrr = Math.max(...dadosMes.map(d => d.mrr), 1);

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<title>Relatório Anual ${ano} — ${_esc(nomeMed)}</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:'Segoe UI',Arial,sans-serif; font-size:12px; color:#1e293b; background:#fff; }
  .page { padding:36px 44px; }
  .header { display:flex; justify-content:space-between; align-items:flex-start; border-bottom:3px solid #3b82f6; padding-bottom:18px; margin-bottom:28px; }
  .header-left h1 { font-size:22px; font-weight:800; color:#0f172a; letter-spacing:-0.5px; }
  .header-left p { font-size:12px; color:#64748b; margin-top:3px; }
  .header-right { text-align:right; }
  .header-right .ano { font-size:24px; font-weight:800; color:#3b82f6; letter-spacing:-0.5px; }
  .header-right .gen { font-size:10px; color:#94a3b8; margin-top:4px; }
  .kpis { display:grid; grid-template-columns:repeat(5,1fr); gap:10px; margin-bottom:24px; }
  .kpi { background:#f8fafc; border-radius:10px; padding:12px 14px; border-left:3px solid #3b82f6; }
  .kpi.green { border-left-color:#10b981; } .kpi.red { border-left-color:#ef4444; } .kpi.amber { border-left-color:#f59e0b; } .kpi.purple { border-left-color:#8b5cf6; }
  .kpi label { font-size:9px; font-weight:700; color:#94a3b8; text-transform:uppercase; letter-spacing:0.07em; display:block; margin-bottom:3px; }
  .kpi .value { font-size:17px; font-weight:800; color:#0f172a; letter-spacing:-0.5px; }
  .kpi .sub { font-size:9.5px; color:#64748b; margin-top:2px; }
  .section { margin-bottom:22px; page-break-inside:avoid; }
  .section h2 { font-size:13px; font-weight:700; color:#0f172a; margin-bottom:10px; padding-bottom:6px; border-bottom:1px solid #e2e8f0; }
  table { width:100%; border-collapse:collapse; font-size:11px; }
  th { text-align:left; padding:7px 8px; background:#f1f5f9; color:#475569; font-weight:600; border-bottom:1px solid #e2e8f0; font-size:10px; text-transform:uppercase; letter-spacing:0.04em; }
  td { padding:7px 8px; border-bottom:1px solid #f1f5f9; color:#334155; }
  td.r, th.r { text-align:right; }
  .total { font-weight:700; background:#f0fdf4; color:#065f46; }
  .total td { border-bottom:none; }
  .bar-chart { display:flex; align-items:flex-end; gap:6px; height:90px; padding:8px 0; border-bottom:1px solid #e2e8f0; margin-bottom:8px; }
  .bar { flex:1; background:linear-gradient(to top,#3b82f6,#60a5fa); border-radius:3px 3px 0 0; position:relative; min-height:2px; }
  .bar.green { background:linear-gradient(to top,#10b981,#34d399); }
  .bar.gray { background:#e2e8f0; }
  .bar-label { font-size:9.5px; text-align:center; color:#64748b; margin-top:4px; }
  .bar-value { position:absolute; top:-14px; left:50%; transform:translateX(-50%); font-size:8.5px; color:#475569; white-space:nowrap; }
  .legend { display:flex; gap:18px; font-size:10.5px; color:#64748b; }
  .legend span::before { content:''; display:inline-block; width:10px; height:10px; border-radius:3px; margin-right:5px; vertical-align:middle; }
  .legend .l-fat::before { background:#3b82f6; }
  .legend .l-mrr::before { background:#10b981; }
  .footer { text-align:center; padding:20px 0 10px; border-top:1px solid #e2e8f0; font-size:10px; color:#94a3b8; margin-top:30px; }
  @media print {
    body { font-size:10.5px; }
    .page { padding:20px 28px; }
    .section { page-break-inside:avoid; }
  }
</style>
</head>
<body>
<div class="page">
  <div class="header">
    <div class="header-left">
      <h1>${_esc(tratamento)}</h1>
      <p>${_esc(clinica.especialidade || 'Medicina')} · Relatório Anual de Gestão${clinica.crm ? ' · '+_esc(clinica.crm) : ''}</p>
    </div>
    <div class="header-right">
      <div class="ano">${ano}</div>
      <div class="gen">Gerado em ${agora}</div>
    </div>
  </div>

  <!-- KPIs principais -->
  <div class="kpis">
    <div class="kpi green"><label>Faturamento</label><div class="value">${brl(totFat)}</div><div class="sub">${totPacs} atendimentos</div></div>
    <div class="kpi green"><label>Lucro</label><div class="value">${brl(totLucro)}</div><div class="sub">Margem ${pct(margem)}</div></div>
    <div class="kpi"><label>Pacientes únicos</label><div class="value">${pacUnicos.size}</div><div class="sub">Ticket ${brl(ticketMedio)}</div></div>
    <div class="kpi purple"><label>MRR atual</label><div class="value">${brl(Math.round(mrrFinal))}</div><div class="sub">${pct(crescimentoMrr)} no ano</div></div>
    <div class="kpi amber"><label>Conv. CRM</label><div class="value">${pct(convAnual)}</div><div class="sub">${crmAtendidos}/${crmAno.length} contatos</div></div>
  </div>

  <!-- Gráfico de faturamento mensal -->
  <div class="section">
    <h2>1. Evolução Mensal do Faturamento</h2>
    <div class="bar-chart">
      ${dadosMes.map(d => {
        const h = Math.round((d.fat / maxFat) * 80);
        return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;">
          <div class="bar" style="height:${h}px;width:100%;${d.fat === 0 ? 'background:#e2e8f0;' : ''}">
            ${d.fat > 0 ? `<span class="bar-value">${(d.fat/1000).toFixed(0)}k</span>` : ''}
          </div>
        </div>`;
      }).join('')}
    </div>
    <div style="display:grid;grid-template-columns:repeat(12,1fr);gap:6px;">
      ${dadosMes.map(d => `<div class="bar-label">${d.nome}</div>`).join('')}
    </div>
  </div>

  <!-- Tabela mensal completa -->
  <div class="section">
    <h2>2. Detalhamento Mensal</h2>
    <table>
      <thead>
        <tr><th>Mês</th><th class="r">Pacientes</th><th class="r">Faturamento</th><th class="r">Despesas</th><th class="r">Lucro</th><th class="r">Margem</th></tr>
      </thead>
      <tbody>
        ${dadosMes.map(d => {
          const m = d.fat ? (d.lucro/d.fat*100) : 0;
          return `<tr><td><strong>${d.nome}/${String(ano).slice(-2)}</strong></td>
            <td class="r">${d.pacs.length || '—'}</td>
            <td class="r">${d.fat ? brl(d.fat) : '—'}</td>
            <td class="r">${d.desp ? brl(d.desp) : '—'}</td>
            <td class="r" style="color:${d.lucro>0?'#10b981':d.lucro<0?'#ef4444':'#94a3b8'};">${d.fat ? brl(d.lucro) : '—'}</td>
            <td class="r">${d.fat ? pct(m) : '—'}</td></tr>`;
        }).join('')}
        <tr class="total"><td>Total ${ano}</td><td class="r">${totPacs}</td><td class="r">${brl(totFat)}</td><td class="r">${brl(totDesp)}</td><td class="r">${brl(totLucro)}</td><td class="r">${pct(margem)}</td></tr>
      </tbody>
    </table>
  </div>

  ${totNovas > 0 || mrrFinal > 0 ? `
  <!-- Programas anuais -->
  <div class="section">
    <h2>3. Programas de Acompanhamento — Visão Anual</h2>
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:14px;">
      <div class="kpi purple"><label>MRR Final</label><div class="value">${brl(Math.round(mrrFinal))}</div></div>
      <div class="kpi green"><label>Novas no ano</label><div class="value">${totNovas}</div></div>
      <div class="kpi red"><label>Cancelamentos</label><div class="value">${totCanc}</div></div>
      <div class="kpi amber"><label>Churn anual</label><div class="value">${pct(churnAnual)}</div></div>
    </div>

    <!-- Gráfico MRR mensal -->
    <div style="font-size:10.5px;font-weight:600;color:#475569;margin:14px 0 6px;">Evolução do MRR ao longo do ano</div>
    <div class="bar-chart" style="height:60px;">
      ${dadosMes.map(d => {
        const h = Math.round((d.mrr / maxMrr) * 50);
        return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;">
          <div class="bar green" style="height:${h}px;width:100%;${d.mrr === 0 ? 'background:#e2e8f0;' : ''}">
            ${d.mrr > 0 ? `<span class="bar-value">${(d.mrr/1000).toFixed(1)}k</span>` : ''}
          </div>
        </div>`;
      }).join('')}
    </div>
    <div style="display:grid;grid-template-columns:repeat(12,1fr);gap:6px;margin-bottom:14px;">
      ${dadosMes.map(d => `<div class="bar-label">${d.nome}</div>`).join('')}
    </div>

    ${topProgs.length ? `
    <table>
      <thead><tr><th>Programa</th><th class="r">Inscritos no ano</th><th class="r">MRR gerado</th></tr></thead>
      <tbody>
        ${topProgs.map(([nome, d]) => `<tr><td>${_esc(nome)}</td><td class="r">${d.qtd}</td><td class="r">${brl(Math.round(d.mrr))}</td></tr>`).join('')}
      </tbody>
    </table>` : ''}
  </div>` : ''}

  ${topProcs.length ? `
  <!-- Top procedimentos -->
  <div class="section">
    <h2>${totNovas > 0 || mrrFinal > 0 ? '4' : '3'}. Top 5 Procedimentos do Ano</h2>
    <table>
      <thead><tr><th>Procedimento</th><th class="r">Atendimentos</th><th class="r">Faturamento</th><th class="r">% do total</th></tr></thead>
      <tbody>
        ${topProcs.map(([nome, d]) => `<tr><td>${_esc(nome)}</td><td class="r">${d.qtd}</td><td class="r">${brl(d.total)}</td><td class="r">${pct(totFat ? d.total/totFat*100 : 0)}</td></tr>`).join('')}
      </tbody>
    </table>
  </div>` : ''}

  <div class="footer">
    <p>${_esc(tratamento)} · ${_esc(clinica.especialidade || 'Medicina')} · Consultório App</p>
    <p>Documento confidencial · Gerado em ${agora}</p>
  </div>
</div>
<script>window.onload = () => { window.print(); }<\/script>
</body>
</html>`;

  const win = window.open('', '_blank');
  win.document.write(html);
  win.document.close();
}

function renderRelatorio(mes) {
  _populateMesSelect('relatorio-mes-sel', { selected: mes });
  mes = document.getElementById('relatorio-mes-sel')?.value || _ymd(new Date()).substring(0, 7);
  const pacs = DB.get('pacientes').filter(p => getMes(p.data) === mes);
  const desps = DB.get('despesas').filter(d => getMes(d.data) === mes);
  const crm = DB.get('crm').filter(c => getMes(c.data) === mes);
  const metas = DB.getObj('metas', { fat: 0, pac: 0, desp: 0 });
  const todosPacs = DB.get('pacientes');

  // Métricas padronizadas (Dashboard, Despesas e Relatório agora batem)
  const fat              = pacs.reduce((s, p) => s + (p.valor || 0), 0); // bruto emitido
  const receitaRealizada = pacs.filter(p => p.statusPgto === 'Pago').reduce((s, p) => s + (p.valor || 0), 0);
  // Via _resumoFin p/ incluir o Parcial, como a Receita e o DRE já fazem. Ficou
  // de fora da unificação e mostrava só o Pendente: o Relatório dizia "A receber
  // R$ 800" enquanto a tela de Receita dizia R$ 17.800 no mesmo mês.
  const aReceber         = _resumoFin(pacs).aReceber;
  const totalDesp = desps.reduce((s, d) => s + d.valor, 0);
  const lucro  = receitaRealizada - totalDesp; // lucro sobre realizado (consistente com Despesas)
  const margem = receitaRealizada ? (lucro / receitaRealizada) * 100 : 0;
  const atend  = crm.filter(c => c.status === 'Atendeu').length;
  const conv   = crm.length ? (atend / crm.length) * 100 : 0;
  const ticket = pacs.length ? fat / pacs.length : 0;
  const _tkRel = _ticketMedio(pacs);

  const statusIcon = (real, meta, inverted = false) => {
    if (!meta) return '—';
    const ok = inverted ? real <= meta : real >= meta;
    return ok ? '<span class="text-green-600">✅ Meta</span>' : '<span class="text-red-500">❌ Abaixo</span>';
  };

  // ===== Quebra por procedimento (distingue programas) =====
  const procMap = {};
  pacs.forEach(p => {
    let k;
    if ((p.obs || '').includes('[Programa')) {
      k = p.procedimento || 'Programa de assinatura';
    } else {
      k = p.tipo || p.procedimento || '(sem procedimento)';
    }
    if (!procMap[k]) procMap[k] = { qtd: 0, total: 0, isProg: (p.obs||'').includes('[Programa') };
    procMap[k].qtd++;
    procMap[k].total += (p.valor || 0);
  });
  const procStats = Object.entries(procMap).map(([nome, v]) => ({ nome, ...v, ticket: v.qtd ? v.total / v.qtd : 0, pct: fat ? (v.total / fat) * 100 : 0 })).sort((a, b) => b.total - a.total);

  // ===== Receita por profissional (Tijolo 3) =====
  const _profsList = getProfissionais();
  const profMap = {};
  pacs.forEach(p => {
    const k = p.profissionalId || '__sem__';
    if (!profMap[k]) profMap[k] = { qtd: 0, total: 0 };
    profMap[k].qtd++;
    profMap[k].total += (p.valor || 0);
  });
  const profStats = Object.entries(profMap).map(([id, v]) => {
    const prof = id === '__sem__' ? null : _profsList.find(x => x.id === id);
    const split = _calcRepasse(prof, v.total, v.qtd);
    return { nome: prof ? prof.nome : 'Sem profissional', cor: prof ? prof.cor : '#94a3b8',
             qtd: v.qtd, total: v.total, ticket: v.qtd ? v.total / v.qtd : 0,
             regra: split.label, profGanho: split.profGanho, clinicaGanho: split.clinicaGanho };
  }).sort((a, b) => b.total - a.total);
  const totalProfGanho = profStats.reduce((s, x) => s + x.profGanho, 0);
  const totalClinica   = profStats.reduce((s, x) => s + x.clinicaGanho, 0);
  const mostrarProfSection = _profsList.length > 1 || pacs.some(p => p.profissionalId);

  // ===== Mix de pagamento + taxa estimada =====
  const formas = ['PIX', 'Cartão crédito', 'Cartão débito', 'Dinheiro', 'A receber'];
  const formasStats = formas.map(f => {
    const lista = pacs.filter(p => p.pagamento === f);
    const total = lista.reduce((s, p) => s + (p.valor || 0), 0);
    const taxa = TAXA_PAGAMENTO[f] || 0;
    return { forma: f, qtd: lista.length, total, taxa, taxaValor: total * taxa, pct: fat ? (total / fat) * 100 : 0 };
  }).filter(s => s.qtd > 0).sort((a, b) => b.total - a.total);
  const totalTaxas = formasStats.reduce((s, f) => s + f.taxaValor, 0);
  const pctCartao = fat ? (formasStats.filter(f => f.forma.includes('Cartão')).reduce((s, f) => s + f.total, 0) / fat) * 100 : 0;
  const pctPix = fat ? ((formasStats.find(f => f.forma === 'PIX')?.total || 0) / fat) * 100 : 0;

  // ===== Novos vs recorrentes =====
  // Um atendimento é "novo" se é o PRIMEIRO atendimento do paciente em toda a base
  // (1ª vez na vida). Os demais — inclusive no mesmo mês — são "recorrentes".
  const primeiraDataPorNome = {};
  [...todosPacs].sort((a, b) => (a.data || '').localeCompare(b.data || '')).forEach(p => {
    const n = (p.nome || '').toLowerCase().trim();
    if (n && !(n in primeiraDataPorNome)) primeiraDataPorNome[n] = p.data;
  });
  const ehNovo = p => p.data === primeiraDataPorNome[(p.nome || '').toLowerCase().trim()];
  const pacsNovos = pacs.filter(ehNovo);
  const pacsRecorrentes = pacs.filter(p => !ehNovo(p));
  const fatNovos = pacsNovos.reduce((s, p) => s + (p.valor || 0), 0);
  const fatRecorrentes = pacsRecorrentes.reduce((s, p) => s + (p.valor || 0), 0);
  // Conta pacientes únicos
  const novosUnicos = new Set(pacsNovos.map(p => (p.nome || '').toLowerCase().trim())).size;
  const recUnicos = new Set(pacsRecorrentes.map(p => (p.nome || '').toLowerCase().trim())).size;

  // ===== Ocupação do consultório =====
  const cfgRel = getAgConfig();
  const slotsSemanaisRel = cfgRel.slotsSemanais
    || (cfgRel.slotsConsultorioDia
        ? Array(7).fill(0).map((_, i) => cfgRel.diasUteis.includes(i) ? cfgRel.slotsConsultorioDia : 0)
        : [0, 5, 0, 5, 5, 0, 0]);
  // Soma slots disponíveis para cada dia do mês
  let slotsMesDisp = 0;
  const mesAno = mes.split('-');
  const diasNoMes = new Date(parseInt(mesAno[0]), parseInt(mesAno[1]), 0).getDate();
  for (let d = 1; d <= diasNoMes; d++) {
    const dt = new Date(parseInt(mesAno[0]), parseInt(mesAno[1]) - 1, d);
    slotsMesDisp += slotsSemanaisRel[dt.getDay()] || 0;
  }
  const todasAgs = getAgendamentos().filter(a => getMes(a.data) === mes);
  const agsConsult = todasAgs.filter(a => !a.tipoAtividade || a.tipoAtividade === 'Consultório');
  const agsConfirmados = agsConsult.filter(a => a.status === 'Confirmado').length;
  const agsCompareceu  = agsConsult.filter(a => a.status === 'Compareceu').length;
  const agsNoShow      = agsConsult.filter(a => a.status === 'No-show').length;
  const agsCancelado   = agsConsult.filter(a => a.status === 'Cancelado').length;
  const slotsMesUsados = agsConfirmados + agsCompareceu + agsNoShow; // não cancela slot
  const taxaOcup = slotsMesDisp ? (slotsMesUsados / slotsMesDisp) * 100 : 0;
  const taxaNoShow = slotsMesUsados ? (agsNoShow / slotsMesUsados) * 100 : 0;

  // ===== Breakdown por tipo de atividade (agenda) =====
  const tiposAtiv = ['Consultório', 'Visita Domiciliar', 'Visita Hospitalar', 'Outro'];
  const tipoIcons = { 'Consultório': '🏥', 'Visita Domiciliar': '🏠', 'Visita Hospitalar': '🏨', 'Outro': '📌' };
  const tipoStats = tiposAtiv.map(tipo => {
    const lista = todasAgs.filter(a => (a.tipoAtividade || 'Consultório') === tipo);
    return {
      tipo, icon: tipoIcons[tipo],
      total: lista.length,
      confirmado: lista.filter(a => a.status === 'Confirmado').length,
      compareceu: lista.filter(a => a.status === 'Compareceu').length,
      noshow:     lista.filter(a => a.status === 'No-show').length,
      cancelado:  lista.filter(a => a.status === 'Cancelado').length,
    };
  }).filter(t => t.total > 0);
  const totalAgs = todasAgs.length;

  // ===== Despesas por categoria =====
  const CATS_DESP = ['Estrutura','Pessoal','Marketing','Materiais','Profissional','Impostos','Outros'];
  const catStats = CATS_DESP.map(c => {
    const val = desps.filter(d => d.categoria === c).reduce((s, d) => s + d.valor, 0);
    return { cat: c, val, pct: totalDesp ? (val / totalDesp) * 100 : 0 };
  }).filter(c => c.val > 0).sort((a, b) => b.val - a.val);
  const fixas  = desps.filter(d => d.tipo === 'Fixo').reduce((s, d) => s + d.valor, 0);
  const varRel = desps.filter(d => d.tipo === 'Variável').reduce((s, d) => s + d.valor, 0);

  // ===== Programas de Acompanhamento (no mês) =====
  const inscricoesAll = getInscricoes();
  const inscricoesAtivas = inscricoesAll.filter(i => i.status === 'Ativo');
  const marcosPrevistosMes = inscricoesAll.flatMap(i => i.registros.filter(r => getMes(r.dataPrevista) === mes));
  const marcosFeitosMes    = marcosPrevistosMes.filter(r => r.dataReal && getMes(r.dataReal) === mes);
  const cumprimentoPct     = marcosPrevistosMes.length ? (marcosFeitosMes.length / marcosPrevistosMes.length) * 100 : 0;
  // Aderência por programa + receita de programas
  const progsAll = getProgramas();
  // MRR total das assinaturas ativas
  let mrrTotal = 0;
  inscricoesAtivas.forEach(i => {
    const prog = progsAll.find(p => p.id === i.programaId);
    if (prog && prog.tipo === 'Assinatura' && typeof _mrrDeInscricao === 'function') {
      mrrTotal += _mrrDeInscricao(i, prog);
    }
  });
  // Faturamento de programas LANÇADO neste mês (receitas reais)
  const lancamentosProgramaMes = pacs.filter(p => (p.obs || '').includes('[Programa'));
  const faturamentoProgsBruto    = lancamentosProgramaMes.reduce((s, p) => s + (p.valor || 0), 0);
  const faturamentoProgsRecebido = lancamentosProgramaMes.filter(p => p.statusPgto === 'Pago').reduce((s, p) => s + (p.valor || 0), 0);
  // Novas inscrições no mês
  const novasInscricoesMes = inscricoesAll.filter(i => getMes(i.dataInicio) === mes);

  const aderPorPrograma = progsAll.map(p => {
    const ins = inscricoesAll.filter(i => i.programaId === p.id);
    const insAtivas = ins.filter(i => i.status === 'Ativo');
    const previstos = ins.flatMap(i => i.registros.filter(r => getMes(r.dataPrevista) === mes));
    const feitos    = previstos.filter(r => r.dataReal);
    // Receita do programa lançada neste mês
    const recMes = lancamentosProgramaMes.filter(pac => pac.procedimento === p.nome).reduce((s, pac) => s + (pac.valor || 0), 0);
    // MRR contribuído por este programa
    let mrrProg = 0;
    if (p.tipo === 'Assinatura' && typeof _mrrDeInscricao === 'function') {
      insAtivas.forEach(i => { mrrProg += _mrrDeInscricao(i, p); });
    }
    return { nome: p.nome, tipo: p.tipo, ativos: insAtivas.length,
             previstos: previstos.length, feitos: feitos.length,
             pct: previstos.length ? (feitos.length/previstos.length)*100 : 0,
             recMes, mrrProg };
  }).filter(p => p.ativos > 0 || p.previstos > 0 || p.recMes > 0);

  document.getElementById('relatorio-content').innerHTML = `
    <div class="chart-card">
      <h3 class="font-bold text-gray-800 mb-4 text-base">1. Resultado Financeiro</h3>
      <table class="w-full text-sm">
        <thead><tr class="border-b"><th class="text-left py-2 text-gray-600">Indicador</th><th class="text-right py-2 text-gray-600">Realizado</th><th class="text-right py-2 text-gray-600">Meta</th><th class="text-right py-2 text-gray-600">% Meta</th><th class="text-right py-2 text-gray-600">Status</th></tr></thead>
        <tbody>
          <tr class="border-b border-gray-50"><td class="py-2 text-gray-700">Faturamento bruto <span style="font-size:10.5px;color:#94a3b8;font-weight:400;">(tudo emitido)</span></td><td class="py-2 text-right font-semibold">${BRL(fat)}</td><td class="py-2 text-right text-gray-500">${BRL(metas.fat)}</td><td class="py-2 text-right">${metas.fat ? PCT((fat/metas.fat)*100) : '—'}</td><td class="py-2 text-right">${statusIcon(fat, metas.fat)}</td></tr>
          <tr class="border-b border-gray-50"><td class="py-2 text-gray-700">Receita realizada <span style="font-size:10.5px;color:#94a3b8;font-weight:400;">(só pagos)</span></td><td class="py-2 text-right font-semibold text-green-700">${BRL(receitaRealizada)}</td><td class="py-2 text-right text-gray-500">—</td><td class="py-2 text-right text-gray-600">${fat ? PCT((receitaRealizada/fat)*100) : '—'} do bruto</td><td class="py-2 text-right">—</td></tr>
          ${aReceber > 0 ? `<tr class="border-b border-gray-50"><td class="py-2 text-gray-700">A receber <span style="font-size:10.5px;color:#94a3b8;font-weight:400;">(pendente + parcial)</span></td><td class="py-2 text-right font-semibold text-amber-600">${BRL(aReceber)}</td><td class="py-2 text-right text-gray-500">—</td><td class="py-2 text-right text-gray-600">${PCT((aReceber/fat)*100)}</td><td class="py-2 text-right">—</td></tr>` : ''}
          <tr class="border-b border-gray-50"><td class="py-2 text-gray-700">Despesas Totais</td><td class="py-2 text-right font-semibold text-red-600">${BRL(totalDesp)}</td><td class="py-2 text-right text-gray-500">${BRL(metas.desp)}</td><td class="py-2 text-right">${metas.desp ? PCT((totalDesp/metas.desp)*100) : '—'}</td><td class="py-2 text-right">${statusIcon(totalDesp, metas.desp, true)}</td></tr>
          <tr class="border-b border-gray-50"><td class="py-2 font-semibold text-gray-800">Lucro Líquido <span style="font-size:10.5px;color:#94a3b8;font-weight:400;">(realizada − despesas)</span></td><td class="py-2 text-right font-bold ${lucro<0?'text-red-600':'text-green-600'}">${BRL(lucro)}</td><td class="py-2 text-right text-gray-500">—</td><td class="py-2 text-right">—</td><td class="py-2 text-right">—</td></tr>
          <tr><td class="py-2 text-gray-700">Margem Líquida</td><td class="py-2 text-right font-semibold">${PCT(margem)}</td><td class="py-2 text-right text-gray-500">—</td><td class="py-2 text-right">—</td><td class="py-2 text-right">—</td></tr>
        </tbody>
      </table>
    </div>
    <div class="chart-card">
      <h3 class="font-bold text-gray-800 mb-4 text-base">2. Indicadores de Atendimento</h3>
      <table class="w-full text-sm">
        <thead><tr class="border-b"><th class="text-left py-2 text-gray-600">Indicador</th><th class="text-right py-2 text-gray-600">Realizado</th><th class="text-right py-2 text-gray-600">Meta</th><th class="text-right py-2 text-gray-600">% Meta</th><th class="text-right py-2 text-gray-600">Status</th></tr></thead>
        <tbody>
          <tr class="border-b border-gray-50"><td class="py-2 text-gray-700">Pacientes atendidos</td><td class="py-2 text-right font-semibold">${pacs.length}</td><td class="py-2 text-right text-gray-500">${metas.pac || '—'}</td><td class="py-2 text-right">${metas.pac ? PCT((pacs.length/metas.pac)*100) : '—'}</td><td class="py-2 text-right">${statusIcon(pacs.length, metas.pac)}</td></tr>
          <tr class="border-b border-gray-50"><td class="py-2 text-gray-700">Taxa de conversão CRM</td><td class="py-2 text-right font-semibold">${PCT(conv)}</td><td class="py-2 text-right text-gray-500">60%</td><td class="py-2 text-right">${PCT((conv/60)*100)}</td><td class="py-2 text-right">${statusIcon(conv, 60)}</td></tr>
          <tr class="border-b border-gray-50"><td class="py-2 text-gray-700">Ticket médio <span style="font-size:10.5px;color:#94a3b8;font-weight:400;">(consulta paga)</span></td><td class="py-2 text-right font-semibold">${BRL(_tkRel.porConsultaPaga)}</td><td class="py-2 text-right text-gray-500">—</td><td class="py-2 text-right">—</td><td class="py-2 text-right">—</td></tr>
          ${_tkRel.qtdGratuitos ? `<tr class="border-b border-gray-50"><td class="py-2 text-gray-700">Ticket médio <span style="font-size:10.5px;color:#94a3b8;font-weight:400;">(por atendimento)</span></td><td class="py-2 text-right font-semibold">${BRL(_tkRel.porAtendimento)}</td><td class="py-2 text-right text-gray-500">—</td><td class="py-2 text-right">—</td><td class="py-2 text-right">—</td></tr>` : ''}
          <tr><td class="py-2 text-gray-700">Contatos no CRM</td><td class="py-2 text-right font-semibold">${crm.length}</td><td class="py-2 text-right text-gray-500">—</td><td class="py-2 text-right">—</td><td class="py-2 text-right">—</td></tr>
        </tbody>
      </table>
    </div>

    <div class="chart-card">
      <h3 class="font-bold text-gray-800 mb-4 text-base">3. Receita por procedimento</h3>
      ${procStats.length ? `
      <table class="w-full text-sm">
        <thead><tr class="border-b"><th class="text-left py-2 text-gray-600">Procedimento</th><th class="text-right py-2 text-gray-600">Qtd</th><th class="text-right py-2 text-gray-600">Receita</th><th class="text-right py-2 text-gray-600">% do mês</th><th class="text-right py-2 text-gray-600">Ticket</th></tr></thead>
        <tbody>
          ${procStats.map(s => `
            <tr class="border-b border-gray-50">
              <td class="py-2 text-gray-700">${s.isProg ? '🔁 ' : ''}${_esc(s.nome)}${s.isProg ? ' <span style="background:#eff6ff;color:#1d4ed8;font-size:10px;padding:1px 6px;border-radius:999px;margin-left:4px;font-weight:600;">assinatura</span>' : ''}</td>
              <td class="py-2 text-right">${s.qtd}</td>
              <td class="py-2 text-right font-semibold">${BRL(s.total)}</td>
              <td class="py-2 text-right text-gray-600">${PCT(s.pct)}</td>
              <td class="py-2 text-right text-gray-600">${BRL(s.ticket)}</td>
            </tr>`).join('')}
          <tr style="background:#f8fafc;border-top:2px solid #e2e8f0;">
            <td class="py-2 font-bold text-gray-800">Total</td>
            <td class="py-2 text-right font-bold">${pacs.length}</td>
            <td class="py-2 text-right font-bold">${BRL(fat)}</td>
            <td class="py-2 text-right">100%</td>
            <td class="py-2 text-right font-bold">${BRL(ticket)}</td>
          </tr>
        </tbody>
      </table>` : '<p class="text-gray-400 text-sm">Nenhum atendimento neste mês.</p>'}
    </div>

    ${mostrarProfSection ? `
    <div class="chart-card">
      <h3 class="font-bold text-gray-800 mb-4 text-base">👥 Receita por profissional <span style="font-size:11px;font-weight:500;color:#94a3b8;">— com repasse</span></h3>
      <div style="overflow-x:auto;">
      <table class="w-full text-sm" style="min-width:560px;">
        <thead><tr class="border-b">
          <th class="text-left py-2 text-gray-600">Profissional</th>
          <th class="text-right py-2 text-gray-600">Atend.</th>
          <th class="text-right py-2 text-gray-600">Receita</th>
          <th class="text-right py-2 text-gray-600">Regra</th>
          <th class="text-right py-2 text-gray-600">Profissional leva</th>
          <th class="text-right py-2 text-gray-600">Clínica fica</th>
        </tr></thead>
        <tbody>
          ${profStats.map(s => `
            <tr class="border-b border-gray-50">
              <td class="py-2 text-gray-700"><span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${s.cor};margin-right:7px;vertical-align:middle;"></span>${_esc(s.nome)}</td>
              <td class="py-2 text-right">${s.qtd}</td>
              <td class="py-2 text-right font-semibold">${BRL(s.total)}</td>
              <td class="py-2 text-right text-gray-500" style="font-size:12px;">${_esc(s.regra)}</td>
              <td class="py-2 text-right font-semibold" style="color:#1d4ed8;">${BRL(s.profGanho)}</td>
              <td class="py-2 text-right font-semibold" style="color:#15803d;">${BRL(s.clinicaGanho)}</td>
            </tr>`).join('')}
          <tr style="background:#f8fafc;border-top:2px solid #e2e8f0;">
            <td class="py-2 font-bold text-gray-800">Total</td>
            <td class="py-2 text-right font-bold">${pacs.length}</td>
            <td class="py-2 text-right font-bold">${BRL(fat)}</td>
            <td class="py-2 text-right"></td>
            <td class="py-2 text-right font-bold" style="color:#1d4ed8;">${BRL(totalProfGanho)}</td>
            <td class="py-2 text-right font-bold" style="color:#15803d;">${BRL(totalClinica)}</td>
          </tr>
        </tbody>
      </table>
      </div>
      <div style="margin-top:12px;display:flex;gap:10px;flex-wrap:wrap;">
        <div style="flex:1;min-width:160px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:10px 14px;">
          <div style="font-size:10.5px;color:#1d4ed8;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;">Repasse aos profissionais</div>
          <div style="font-size:18px;font-weight:800;color:#1e40af;margin-top:2px;">${BRL(totalProfGanho)}</div>
        </div>
        <div style="flex:1;min-width:160px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:10px 14px;">
          <div style="font-size:10.5px;color:#15803d;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;">Fica com a clínica</div>
          <div style="font-size:18px;font-weight:800;color:#166534;margin-top:2px;">${BRL(totalClinica)}</div>
        </div>
      </div>
    </div>` : ''}

    <div class="chart-card">
      <h3 class="font-bold text-gray-800 mb-4 text-base">4. Mix de pagamento e taxas</h3>
      ${formasStats.length ? `
      <table class="w-full text-sm">
        <thead><tr class="border-b"><th class="text-left py-2 text-gray-600">Forma</th><th class="text-right py-2 text-gray-600">Qtd</th><th class="text-right py-2 text-gray-600">Receita</th><th class="text-right py-2 text-gray-600">% do mês</th><th class="text-right py-2 text-gray-600">Taxa est.</th><th class="text-right py-2 text-gray-600">Perda em taxas</th></tr></thead>
        <tbody>
          ${formasStats.map(s => `
            <tr class="border-b border-gray-50">
              <td class="py-2 text-gray-700">${s.forma}</td>
              <td class="py-2 text-right">${s.qtd}</td>
              <td class="py-2 text-right font-semibold">${BRL(s.total)}</td>
              <td class="py-2 text-right text-gray-600">${PCT(s.pct)}</td>
              <td class="py-2 text-right text-gray-500">${s.taxa ? (s.taxa * 100).toFixed(1) + '%' : '—'}</td>
              <td class="py-2 text-right ${s.taxaValor > 0 ? 'text-red-500' : 'text-gray-400'}">${s.taxaValor > 0 ? '− ' + BRL(s.taxaValor) : '—'}</td>
            </tr>`).join('')}
          <tr style="background:#f8fafc;border-top:2px solid #e2e8f0;">
            <td class="py-2 font-bold text-gray-800">Total</td>
            <td class="py-2 text-right font-bold">${pacs.length}</td>
            <td class="py-2 text-right font-bold">${BRL(fat)}</td>
            <td class="py-2 text-right font-bold">100%</td>
            <td class="py-2 text-right text-gray-500">—</td>
            <td class="py-2 text-right font-bold ${totalTaxas > 0 ? 'text-red-600' : 'text-gray-400'}">${totalTaxas > 0 ? '− ' + BRL(totalTaxas) : '—'}</td>
          </tr>
        </tbody>
      </table>
      <div style="margin-top:12px;padding:10px 14px;background:${pctCartao > 50 ? '#fef3c7' : '#f0fdf4'};border-radius:8px;font-size:12.5px;color:${pctCartao > 50 ? '#92400e' : '#15803d'};">
        💡 ${pctPix.toFixed(0)}% do faturamento veio via PIX/Dinheiro (zero taxa). ${pctCartao.toFixed(0)}% veio via cartão${totalTaxas > 0 ? ` — equivalente a ${BRL(totalTaxas)} pagos em taxas (estimativa: débito 2%, crédito 3.5%)` : ''}.
      </div>` : '<p class="text-gray-400 text-sm">Sem atendimentos neste mês.</p>'}
    </div>

    <div class="chart-card">
      <h3 class="font-bold text-gray-800 mb-4 text-base">5. Novos vs Pacientes recorrentes</h3>
      ${pacs.length ? `
      <table class="w-full text-sm">
        <thead><tr class="border-b"><th class="text-left py-2 text-gray-600">Categoria</th><th class="text-right py-2 text-gray-600">Pacientes únicos</th><th class="text-right py-2 text-gray-600">Atendimentos</th><th class="text-right py-2 text-gray-600">Receita</th><th class="text-right py-2 text-gray-600">% do mês</th></tr></thead>
        <tbody>
          <tr class="border-b border-gray-50">
            <td class="py-2 text-gray-700">🆕 Novos (1ª vez no sistema)</td>
            <td class="py-2 text-right">${novosUnicos}</td>
            <td class="py-2 text-right">${pacsNovos.length}</td>
            <td class="py-2 text-right font-semibold">${BRL(fatNovos)}</td>
            <td class="py-2 text-right text-gray-600">${PCT(fat ? (fatNovos / fat) * 100 : 0)}</td>
          </tr>
          <tr class="border-b border-gray-50">
            <td class="py-2 text-gray-700">🔄 Recorrentes (já vieram antes)</td>
            <td class="py-2 text-right">${recUnicos}</td>
            <td class="py-2 text-right">${pacsRecorrentes.length}</td>
            <td class="py-2 text-right font-semibold text-green-700">${BRL(fatRecorrentes)}</td>
            <td class="py-2 text-right text-gray-600">${PCT(fat ? (fatRecorrentes / fat) * 100 : 0)}</td>
          </tr>
        </tbody>
      </table>
      <div style="margin-top:12px;padding:10px 14px;background:#eff6ff;border-radius:8px;font-size:12.5px;color:#1e40af;">
        💡 ${fat ? PCT((fatRecorrentes / fat) * 100) : '0%'} do faturamento veio de pacientes que já estavam na base — ${fatRecorrentes >= fatNovos ? 'sinal de boa retenção 👏' : 'oportunidade para fortalecer follow-up e fidelização'}.
      </div>` : '<p class="text-gray-400 text-sm">Sem atendimentos neste mês.</p>'}
    </div>

    <div class="chart-card">
      <h3 class="font-bold text-gray-800 mb-4 text-base">6. Ocupação do Consultório</h3>
      ${slotsMesDisp > 0 ? `
      <table class="w-full text-sm mb-3">
        <thead><tr class="border-b"><th class="text-left py-2 text-gray-600">Indicador</th><th class="text-right py-2 text-gray-600">Valor</th></tr></thead>
        <tbody>
          <tr class="border-b border-gray-50"><td class="py-2 text-gray-700">Slots disponíveis no mês</td><td class="py-2 text-right font-semibold">${slotsMesDisp}</td></tr>
          <tr class="border-b border-gray-50"><td class="py-2 text-gray-700">Slots ocupados</td><td class="py-2 text-right font-semibold">${slotsMesUsados}</td></tr>
          <tr class="border-b border-gray-50"><td class="py-2 text-gray-700">Compareceram</td><td class="py-2 text-right text-green-600 font-semibold">${agsCompareceu}</td></tr>
          <tr class="border-b border-gray-50"><td class="py-2 text-gray-700">Confirmados (pendente)</td><td class="py-2 text-right text-blue-600">${agsConfirmados}</td></tr>
          <tr class="border-b border-gray-50"><td class="py-2 text-gray-700">No-show</td><td class="py-2 text-right text-red-500">${agsNoShow}</td></tr>
          <tr class="border-b border-gray-50"><td class="py-2 text-gray-700">Cancelados</td><td class="py-2 text-right text-gray-400">${agsCancelado}</td></tr>
          <tr style="background:#f0fdf4;"><td class="py-2 font-bold text-green-800">Taxa de Ocupação</td><td class="py-2 text-right font-bold text-green-700 text-base">${PCT(taxaOcup)}</td></tr>
        </tbody>
      </table>
      <div style="background:#e2e8f0;border-radius:6px;height:10px;margin-bottom:10px;overflow:hidden;">
        <div style="height:100%;width:${Math.min(taxaOcup,100).toFixed(1)}%;background:${taxaOcup>=80?'#16a34a':taxaOcup>=50?'#f59e0b':'#ef4444'};border-radius:6px;transition:width .4s;"></div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <div style="padding:8px 12px;background:${taxaOcup>=80?'#f0fdf4':taxaOcup>=50?'#fefce8':'#fef2f2'};border-radius:8px;font-size:12px;color:${taxaOcup>=80?'#15803d':taxaOcup>=50?'#92400e':'#b91c1c'};flex:1;min-width:180px;">
          📊 Ocupação: ${PCT(taxaOcup)} ${taxaOcup>=80?'— agenda bem preenchida 💪':taxaOcup>=50?'— há espaço para crescer':'— agenda com baixa ocupação'}
        </div>
        ${agsNoShow > 0 ? `<div style="padding:8px 12px;background:#fef2f2;border-radius:8px;font-size:12px;color:#b91c1c;flex:1;min-width:180px;">
          ⚠️ No-show: ${PCT(taxaNoShow)} das consultas — considere confirmação ativa por WhatsApp
        </div>` : ''}
      </div>` : `
      <p class="text-gray-400 text-sm">Configure os slots por dia em <strong>Agenda → ⚙️ Configurar Agenda</strong> para ver a taxa de ocupação.</p>`}
    </div>

    ${tipoStats.length ? `
    <div class="chart-card">
      <h3 class="font-bold text-gray-800 mb-4 text-base">7. Atividades da Agenda por tipo</h3>
      <table class="w-full text-sm">
        <thead><tr class="border-b"><th class="text-left py-2 text-gray-600">Tipo</th><th class="text-right py-2 text-gray-600">Total</th><th class="text-right py-2 text-gray-600">Compareceu</th><th class="text-right py-2 text-gray-600">No-show</th><th class="text-right py-2 text-gray-600">Cancelado</th><th class="text-right py-2 text-gray-600">% agenda</th></tr></thead>
        <tbody>
          ${tipoStats.map(t => `
            <tr class="border-b border-gray-50">
              <td class="py-2 text-gray-700">${t.icon} ${_esc(t.tipo)}</td>
              <td class="py-2 text-right font-semibold">${t.total}</td>
              <td class="py-2 text-right text-green-600">${t.compareceu}</td>
              <td class="py-2 text-right text-red-500">${t.noshow || '—'}</td>
              <td class="py-2 text-right text-gray-400">${t.cancelado || '—'}</td>
              <td class="py-2 text-right text-gray-500">${PCT(totalAgs ? (t.total / totalAgs) * 100 : 0)}</td>
            </tr>`).join('')}
          <tr style="background:#f8fafc;border-top:2px solid #e2e8f0;">
            <td class="py-2 font-bold text-gray-800">Total</td>
            <td class="py-2 text-right font-bold">${totalAgs}</td>
            <td class="py-2 text-right font-bold text-green-600">${todasAgs.filter(a=>a.status==='Compareceu').length}</td>
            <td class="py-2 text-right font-bold text-red-500">${todasAgs.filter(a=>a.status==='No-show').length || '—'}</td>
            <td class="py-2 text-right font-bold text-gray-400">${todasAgs.filter(a=>a.status==='Cancelado').length || '—'}</td>
            <td class="py-2 text-right font-bold">100%</td>
          </tr>
        </tbody>
      </table>
    </div>` : ''}

    ${catStats.length ? `
    <div class="chart-card">
      <h3 class="font-bold text-gray-800 mb-4 text-base">${tipoStats.length ? '8' : '7'}. Despesas por categoria</h3>
      <table class="w-full text-sm mb-3">
        <thead><tr class="border-b"><th class="text-left py-2 text-gray-600">Categoria</th><th class="text-right py-2 text-gray-600">Total</th><th class="text-right py-2 text-gray-600">% das despesas</th></tr></thead>
        <tbody>
          ${catStats.map(c => `
            <tr class="border-b border-gray-50">
              <td class="py-2 text-gray-700">${c.cat}</td>
              <td class="py-2 text-right font-semibold text-red-600">${BRL(c.val)}</td>
              <td class="py-2 text-right">
                <div style="display:flex;align-items:center;gap:6px;justify-content:flex-end;">
                  <div style="width:60px;height:6px;background:#f1f5f9;border-radius:3px;overflow:hidden;">
                    <div style="height:100%;width:${c.pct.toFixed(1)}%;background:#ef4444;border-radius:3px;"></div>
                  </div>
                  <span>${PCT(c.pct)}</span>
                </div>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
      <div style="display:flex;gap:8px;">
        <div style="flex:1;padding:8px 12px;background:#f0fdf4;border-radius:8px;font-size:12px;color:#15803d;">
          🔒 Fixas: <strong>${BRL(fixas)}</strong> (${PCT(totalDesp ? (fixas/totalDesp)*100 : 0)})
        </div>
        <div style="flex:1;padding:8px 12px;background:#fff7ed;border-radius:8px;font-size:12px;color:#9a3412;">
          📈 Variáveis: <strong>${BRL(varRel)}</strong> (${PCT(totalDesp ? (varRel/totalDesp)*100 : 0)})
        </div>
      </div>
    </div>` : ''}

    ${(aderPorPrograma.length || inscricoesAtivas.length || faturamentoProgsBruto > 0) ? `
    <div class="chart-card">
      <h3 class="font-bold text-gray-800 mb-4 text-base">9. Programas de Acompanhamento</h3>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:14px;">
        <div style="background:#eff6ff;border-radius:8px;padding:10px 14px;">
          <div style="font-size:10.5px;font-weight:700;color:#1d4ed8;text-transform:uppercase;">Inscritos ativos</div>
          <div style="font-size:18px;font-weight:800;color:#0f172a;margin-top:2px;">${inscricoesAtivas.length}</div>
        </div>
        <div style="background:#f0fdf4;border-radius:8px;padding:10px 14px;">
          <div style="font-size:10.5px;font-weight:700;color:#15803d;text-transform:uppercase;">MRR</div>
          <div style="font-size:18px;font-weight:800;color:#0f172a;margin-top:2px;">${BRL(Math.round(mrrTotal))}</div>
        </div>
        <div style="background:#fefce8;border-radius:8px;padding:10px 14px;">
          <div style="font-size:10.5px;font-weight:700;color:#a16207;text-transform:uppercase;">Receita no mês</div>
          <div style="font-size:18px;font-weight:800;color:#0f172a;margin-top:2px;">${BRL(faturamentoProgsBruto)}</div>
          <div style="font-size:10px;color:#a16207;margin-top:1px;">${BRL(faturamentoProgsRecebido)} pagos · ${lancamentosProgramaMes.length} lançamentos</div>
        </div>
        <div style="background:#ede9fe;border-radius:8px;padding:10px 14px;">
          <div style="font-size:10.5px;font-weight:700;color:#5b21b6;text-transform:uppercase;">Novas no mês</div>
          <div style="font-size:18px;font-weight:800;color:#0f172a;margin-top:2px;">${novasInscricoesMes.length}</div>
        </div>
        ${marcosPrevistosMes.length > 0 ? `
        <div style="background:${cumprimentoPct>=80?'#f0fdf4':cumprimentoPct>=50?'#fefce8':'#fef2f2'};border-radius:8px;padding:10px 14px;">
          <div style="font-size:10.5px;font-weight:700;color:${cumprimentoPct>=80?'#15803d':cumprimentoPct>=50?'#a16207':'#b91c1c'};text-transform:uppercase;">% Cumprimento marcos</div>
          <div style="font-size:18px;font-weight:800;color:#0f172a;margin-top:2px;">${PCT(cumprimentoPct)}</div>
          <div style="font-size:10px;color:#64748b;margin-top:1px;">${marcosFeitosMes.length}/${marcosPrevistosMes.length}</div>
        </div>` : ''}
      </div>
      <table class="w-full text-sm">
        <thead><tr class="border-b"><th class="text-left py-2 text-gray-600">Programa</th><th class="text-right py-2 text-gray-600">Tipo</th><th class="text-right py-2 text-gray-600">Ativos</th><th class="text-right py-2 text-gray-600">MRR</th><th class="text-right py-2 text-gray-600">Receita no mês</th><th class="text-right py-2 text-gray-600">Aderência</th></tr></thead>
        <tbody>
          ${aderPorPrograma.map(p => `
            <tr class="border-b border-gray-50">
              <td class="py-2 text-gray-700">${_esc(p.nome)}</td>
              <td class="py-2 text-right text-gray-500">${_esc(p.tipo)}</td>
              <td class="py-2 text-right">${p.ativos}</td>
              <td class="py-2 text-right font-semibold text-blue-700">${p.mrrProg > 0 ? BRL(Math.round(p.mrrProg)) : '—'}</td>
              <td class="py-2 text-right font-semibold text-green-700">${p.recMes > 0 ? BRL(p.recMes) : '—'}</td>
              <td class="py-2 text-right font-semibold" style="color:${p.previstos ? (p.pct>=80?'#15803d':p.pct>=50?'#a16207':'#b91c1c') : '#94a3b8'};">${p.previstos ? PCT(p.pct) + ' (' + p.feitos + '/' + p.previstos + ')' : '—'}</td>
            </tr>`).join('')}
          <tr style="background:#f8fafc;border-top:2px solid #e2e8f0;">
            <td class="py-2 font-bold text-gray-800" colspan="2">Total</td>
            <td class="py-2 text-right font-bold">${inscricoesAtivas.length}</td>
            <td class="py-2 text-right font-bold text-blue-700">${BRL(Math.round(mrrTotal))}</td>
            <td class="py-2 text-right font-bold text-green-700">${BRL(faturamentoProgsBruto)}</td>
            <td class="py-2 text-right text-gray-500">—</td>
          </tr>
        </tbody>
      </table>
    </div>` : ''}
`;
}

function updateRelatorio(val) { renderRelatorio(val); }

// ====================== METAS ======================
function atualizarPreviewMetas() {
  const chaves = ['1ª vez','Consulta','Retorno','Domiciliar','Hospitalar','Telemedicina','Programa'];
  const ids    = ['1vez','consulta','retorno','domiciliar','hospitalar','telemedicina','programa'];
  let totalFat = 0, totalPac = 0;

  chaves.forEach((tipo, i) => {
    const qtd = parseInt(document.getElementById(`mm-${ids[i]}-qtd`)?.value) || 0;
    const val = parseFloat(document.getElementById(`mm-${ids[i]}-val`)?.value) || 0;
    const subtotal = qtd * val;
    totalFat += subtotal;
    totalPac += qtd;
    const el = document.getElementById(`mm-${ids[i]}-total`);
    if (el) el.textContent = subtotal > 0 ? BRL(subtotal) : '—';
  });

  const fatEl = document.getElementById('mm-total-fat');
  const pacEl = document.getElementById('mm-total-pac-label');
  if (fatEl) fatEl.textContent = BRL(totalFat);
  if (pacEl) pacEl.textContent = `${totalPac} paciente${totalPac !== 1 ? 's' : ''}/mês`;
}

function saveMetas(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const chaves = ['1ª vez','Consulta','Retorno','Domiciliar','Hospitalar','Telemedicina','Programa'];
  const ids    = ['1vez','consulta','retorno','domiciliar','hospitalar','telemedicina','programa'];

  // Lê qtd e valor por procedimento
  const mp = {}, mpVal = {};
  let totalFat = 0, totalPac = 0;
  chaves.forEach((tipo, i) => {
    const qtd = parseInt(fd.get(`meta_${ids[i]}`)) || 0;
    const val = parseFloat(fd.get(`valor_${ids[i]}`)) || 0;
    if (qtd > 0) { mp[tipo] = qtd; mpVal[tipo] = val; }
    totalFat += qtd * val;
    totalPac += qtd;
  });

  // Salva metas integradas
  DB.setObj('metas', {
    fat:  totalFat,
    pac:  totalPac,
    desp: parseFloat(fd.get('metaDesp')) || 0
  });
  DB.setObj('metas_proc', mp);
  DB.setObj('metas_proc_valor', mpVal);

  closeModal('modal-metas');
  renderMetas();
  renderMetasProc();
  toast('✅ Metas salvas!');
  checkAchievements();
}

function renderMetas() {
  const metas = DB.getObj('metas', { fat: 0, pac: 0, desp: 0 });
  document.getElementById('meta-fat-val').textContent = BRL(metas.fat);
  document.getElementById('meta-pac-val').textContent = metas.pac;
  document.getElementById('meta-ticket-val').textContent = metas.pac && metas.fat ? BRL(metas.fat / metas.pac) : BRL(0);

  const mesesNomes = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
  const tbody = document.getElementById('metas-tbody');

  if (!metas.fat && !metas.pac) {
    tbody.innerHTML = '';
    document.getElementById('metas-total').innerHTML = '<td colspan="9" class="px-4 py-3 text-gray-400 text-center">Configure suas metas clicando em ⚙️ Editar Metas</td>';
    return;
  }

  const allPacs = DB.get('pacientes');
  const allDesps = DB.get('despesas');

  let totalFat = 0, totalPac = 0, totalLucro = 0;

  tbody.innerHTML = Array.from({ length: 12 }, (_, i) => {
    const mes = `2026-${String(i + 1).padStart(2, '0')}`;
    const pacs = allPacs.filter(p => getMes(p.data) === mes);
    const desps = allDesps.filter(d => getMes(d.data) === mes);
    const fat = pacs.reduce((s, p) => s + p.valor, 0);   // bruto: compara com a meta de faturamento
    const desp = desps.reduce((s, d) => s + d.valor, 0);
    // Lucro em regime de CAIXA (recebido − despesas), pra bater com Dashboard/
    // Relatório. Antes usava o bruto e mostrava um lucro diferente pro mesmo mês.
    const recebidoMes = _resumoFin(pacs).recebido;
    const lucro = recebidoMes - desp;
    const margem = recebidoMes ? (lucro / recebidoMes) * 100 : 0;
    const pctMeta = metas.fat ? (fat / metas.fat) * 100 : 0;

    totalFat += fat; totalPac += pacs.length; totalLucro += lucro;

    const statusColor = fat >= metas.fat * 0.8 ? (fat >= metas.fat ? 'text-green-600' : 'text-yellow-600') : 'text-red-500';
    const statusLabel = fat >= metas.fat ? '✅' : (fat > 0 ? '⚠️' : '—');

    return `
      <tr class="border-b border-gray-50 hover:bg-gray-50">
        <td class="px-4 py-3 text-gray-700 font-medium">${mesesNomes[i]}</td>
        <td class="px-4 py-3 text-right font-semibold ${fat > 0 ? 'text-gray-900' : 'text-gray-400'}">${fat > 0 ? BRL(fat) : '—'}</td>
        <td class="px-4 py-3 text-right text-gray-500">${BRL(metas.fat)}</td>
        <td class="px-4 py-3 text-right ${statusColor}">${fat > 0 ? PCT(pctMeta) : '—'}</td>
        <td class="px-4 py-3 text-right ${pacs.length > 0 ? 'text-gray-900' : 'text-gray-400'}">${pacs.length > 0 ? pacs.length : '—'}</td>
        <td class="px-4 py-3 text-right text-gray-500">${metas.pac}</td>
        <td class="px-4 py-3 text-right ${lucro > 0 ? 'text-green-600' : lucro < 0 ? 'text-red-500' : 'text-gray-400'}">${fat > 0 ? BRL(lucro) : '—'}</td>
        <td class="px-4 py-3 text-right ${margem > 0 ? 'text-gray-700' : 'text-gray-400'}">${fat > 0 ? PCT(margem) : '—'}</td>
        <td class="px-4 py-3 text-center">${statusLabel}</td>
      </tr>`;
  }).join('');

  document.getElementById('metas-total').innerHTML = `
    <td class="px-4 py-3 font-bold text-gray-800">TOTAL 2026</td>
    <td class="px-4 py-3 text-right font-bold text-gray-900">${BRL(totalFat)}</td>
    <td class="px-4 py-3 text-right font-semibold text-gray-500">${BRL(metas.fat * 12)}</td>
    <td class="px-4 py-3 text-right font-semibold ${totalFat >= metas.fat * 12 ? 'text-green-600' : 'text-gray-700'}">${metas.fat ? PCT((totalFat / (metas.fat * 12)) * 100) : '—'}</td>
    <td class="px-4 py-3 text-right font-bold text-gray-900">${totalPac}</td>
    <td class="px-4 py-3 text-right font-semibold text-gray-500">${metas.pac * 12}</td>
    <td class="px-4 py-3 text-right font-bold ${totalLucro >= 0 ? 'text-green-600' : 'text-red-500'}">${BRL(totalLucro)}</td>
    <td class="px-4 py-3 text-right">—</td>
    <td class="px-4 py-3 text-center">—</td>`;
}

// ====================== METAS POR PROCEDIMENTO ======================
function saveMetasProc(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const mp = {
    '1ª vez':      parseInt(fd.get('meta_1vez'))        || 0,
    'Consulta':    parseInt(fd.get('meta_consulta'))    || 0,
    'Retorno':     parseInt(fd.get('meta_retorno'))     || 0,
    'Domiciliar':  parseInt(fd.get('meta_domiciliar'))  || 0,
    'Hospitalar':  parseInt(fd.get('meta_hospitalar'))  || 0,
    'Telemedicina':parseInt(fd.get('meta_telemedicina'))|| 0,
  };
  DB.setObj('metas_proc', mp);
  closeModal('modal-metas-proc');
  renderMetasProc();
}

function renderMetasProc() {
  const el = document.getElementById('metas-proc-grid');
  if (!el) return;

  const mp = DB.getObj('metas_proc', {});
  const allPacs = DB.get('pacientes');
  const mesAtual = _ymd(new Date()).substring(0, 7);

  const corPorTipo = {
    '1ª vez':      { bg:'#dbeafe', cor:'#1d4ed8', icon:'🆕' },
    'Consulta':    { bg:'#d1fae5', cor:'#065f46', icon:'🩺' },
    'Retorno':     { bg:'#ede9fe', cor:'#5b21b6', icon:'🔄' },
    'Domiciliar':  { bg:'#fef3c7', cor:'#92400e', icon:'🏠' },
    'Hospitalar':  { bg:'#fee2e2', cor:'#991b1b', icon:'🏥' },
    'Telemedicina':{ bg:'#e0f2fe', cor:'#0c4a6e', icon:'💻' },
    'Programa':    { bg:'#eff6ff', cor:'#1d4ed8', icon:'🔁' },
  };

  // Inscrições para a linha "Programa"
  const allIns = getInscricoes();
  function inscricoesNoMes(mes) {
    return allIns.filter(i => (i.dataInicio || '').startsWith(mes)).length;
  }

  const tipos = Object.keys(corPorTipo);
  const temMeta = tipos.some(t => (mp[t] || 0) > 0);

  if (!temMeta) {
    el.innerHTML = '<div style="text-align:center;color:#94a3b8;font-size:13px;padding:32px;">Clique em ⚙️ Editar para definir metas por procedimento</div>';
    // Preenche modal
    window._openMetasProc = () => {
      tipos.forEach(t => {
        const key = t.replace('ª','').replace(' ','_').toLowerCase();
        const id = `mp-${key === '1_vez' ? '1vez' : key}`;
        const input = document.getElementById(id);
        if (input) input.value = mp[t] || '';
      });
    };
    return;
  }

  const mesesNomes = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
  const tiposAtivos = tipos.filter(t => (mp[t] || 0) > 0);

  // Monta colunas: só meses que têm dado OU até o mês atual
  const [anoAtual, mesIdxAtual] = mesAtual.split('-').map(Number);
  const colunas = Array.from({ length: mesIdxAtual }, (_, i) => {
    const mes = `${anoAtual}-${String(i + 1).padStart(2, '0')}`;
    return { mes, label: mesesNomes[i], isAtual: mes === mesAtual };
  });

  el.innerHTML = `
    <div style="overflow-x:auto;">
      <table style="width:100%;border-collapse:collapse;font-size:12.5px;">
        <thead>
          <tr style="border-bottom:2px solid #f1f5f9;">
            <th style="text-align:left;padding:9px 12px;color:#64748b;font-weight:600;font-size:11.5px;min-width:140px;">Procedimento</th>
            <th style="text-align:center;padding:9px 12px;color:#64748b;font-weight:600;font-size:11.5px;">Meta/mês</th>
            ${colunas.map(c => `<th style="text-align:center;padding:9px 10px;color:${c.isAtual ? '#0f172a' : '#64748b'};font-weight:${c.isAtual ? '700' : '600'};font-size:11.5px;${c.isAtual ? 'background:#f0fdf4;' : ''}">${c.label}${c.isAtual ? ' ▶' : ''}</th>`).join('')}
            <th style="text-align:center;padding:9px 12px;color:#64748b;font-weight:600;font-size:11.5px;">Total</th>
          </tr>
        </thead>
        <tbody>
          ${tiposAtivos.map(tipo => {
            const meta = mp[tipo] || 0;
            const c = corPorTipo[tipo];
            const isProg = tipo === 'Programa';
            const totAnual = isProg
              ? allIns.filter(i => (i.dataInicio || '').startsWith(String(anoAtual))).length
              : allPacs.filter(p => getMes(p.data).startsWith(String(anoAtual)) && _metaCategoria(p.tipo) === tipo).length;
            return `
              <tr style="border-bottom:1px solid #f8fafc;">
                <td style="padding:9px 12px;">
                  <div style="display:flex;align-items:center;gap:7px;">
                    <div style="width:22px;height:22px;background:${c.bg};border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:11px;flex-shrink:0;">${c.icon}</div>
                    <span style="font-weight:600;color:#0f172a;">${tipo}</span>
                  </div>
                </td>
                <td style="padding:9px 12px;text-align:center;">
                  <span style="background:${c.bg};color:${c.cor};padding:2px 9px;border-radius:999px;font-size:12px;font-weight:700;">${meta}</span>
                </td>
                ${colunas.map(col => {
                  const real = isProg
                    ? inscricoesNoMes(col.mes)
                    : allPacs.filter(p => getMes(p.data) === col.mes && _metaCategoria(p.tipo) === tipo).length;
                  const pct = meta ? (real / meta) * 100 : 0;
                  const cor = real === 0 ? '#d1d5db' : real >= meta ? '#10b981' : real >= meta * 0.7 ? '#f59e0b' : '#ef4444';
                  const bg  = col.isAtual ? '#f0fdf4' : '';
                  const label = real === 0 ? '<span style="color:#d1d5db;">—</span>' : `<strong style="color:${cor};">${real}</strong><span style="color:#94a3b8;font-size:10.5px;"> /${meta}</span>`;
                  return `<td style="padding:9px 10px;text-align:center;${bg ? 'background:' + bg + ';' : ''}">${label}</td>`;
                }).join('')}
                <td style="padding:9px 12px;text-align:center;font-weight:700;color:#0f172a;">${totAnual}</td>
              </tr>`;
          }).join('')}
        </tbody>
        <tfoot>
          <tr style="border-top:2px solid #e2e8f0;background:#f8fafc;">
            <td style="padding:9px 12px;font-weight:700;color:#0f172a;" colspan="2">Total consultas</td>
            ${colunas.map(col => {
              const total = allPacs.filter(p => getMes(p.data) === col.mes).length;
              const bg = col.isAtual ? 'background:#f0fdf4;' : '';
              return `<td style="padding:9px 10px;text-align:center;font-weight:700;color:#0f172a;${bg}">${total || '—'}</td>`;
            }).join('')}
            <td style="padding:9px 12px;text-align:center;font-weight:800;color:#10b981;">${allPacs.filter(p => getMes(p.data).startsWith(String(anoAtual))).length}</td>
          </tr>
        </tfoot>
      </table>
    </div>`;

  // Preenche campos do modal ao abrir
  window._openMetasProc = () => {
    tipos.forEach(t => {
      const key = t.replace('ª','').replace(' ','_').toLowerCase();
      const id = `mp-${key === '1_vez' ? '1vez' : key}`;
      const input = document.getElementById(id);
      if (input) input.value = mp[t] || '';
    });
  };
}

// ====================== FLUXO DE CAIXA ======================
function renderFluxoCaixa(mesAtual) {
  const el = document.getElementById('fluxo-caixa-body');
  if (!el) return;

  const pacs = DB.get('pacientes');
  const hoje = mesAtual || _ymd(new Date()).substring(0, 7);
  const [anoH, mesH] = hoje.split('-').map(Number);

  // Monta mapa de recebimentos por mês (parcelas + à vista)
  const mapaRecebimentos = {};

  pacs.forEach(p => {
    if (!p.data) return;
    if (p.recebimentos && p.recebimentos.length > 0) {
      // Parcelado: distribui pelas parcelas
      p.recebimentos.forEach(r => {
        if (!mapaRecebimentos[r.mes]) mapaRecebimentos[r.mes] = { previsto: 0, competencia: 0 };
        mapaRecebimentos[r.mes].previsto += r.valor;
      });
    } else {
      // À vista: entra no mês da consulta
      const mes = getMes(p.data);
      if (!mapaRecebimentos[mes]) mapaRecebimentos[mes] = { previsto: 0, competencia: 0 };
      mapaRecebimentos[mes].previsto += (p.valor || 0);
    }
    // Regime de competência: sempre no mês da consulta
    const mes = getMes(p.data);
    if (!mapaRecebimentos[mes]) mapaRecebimentos[mes] = { previsto: 0, competencia: 0 };
    mapaRecebimentos[mes].competencia += (p.valor || 0);
  });

  // Mostra os próximos 6 meses a partir do mês atual
  const mesesNomes = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
  const linhas = [];
  for (let i = -1; i <= 5; i++) {
    const d = new Date(anoH, mesH - 1 + i, 1);
    const key = _ymd(d).substring(0, 7);
    const nome = `${mesesNomes[d.getMonth()]}/${d.getFullYear()}`;
    const dados = mapaRecebimentos[key] || { previsto: 0, competencia: 0 };
    const diff = dados.previsto - dados.competencia;
    const isAtual = key === hoje;
    linhas.push({ key, nome, ...dados, diff, isAtual });
  }

  el.innerHTML = linhas.map(l => `
    <tr style="${l.isAtual ? 'background:#f0fdf4;font-weight:600;' : ''}">
      <td style="padding:10px 16px;font-size:13px;color:${l.isAtual ? '#065f46' : '#374151'};">
        ${l.isAtual ? '▶ ' : ''}${l.nome}
      </td>
      <td style="padding:10px 16px;text-align:right;font-size:13px;color:#0f172a;">${l.competencia > 0 ? BRL(l.competencia) : '<span style="color:#cbd5e1;">—</span>'}</td>
      <td style="padding:10px 16px;text-align:right;font-size:13px;color:${l.previsto > 0 ? '#059669' : '#94a3b8'};">${l.previsto > 0 ? BRL(l.previsto) : '<span style="color:#cbd5e1;">—</span>'}</td>
      <td style="padding:10px 16px;text-align:right;font-size:12px;color:${l.diff > 0 ? '#f59e0b' : l.diff < 0 ? '#3b82f6' : '#94a3b8'};">${l.diff !== 0 ? (l.diff > 0 ? '+' : '') + BRL(l.diff) : '—'}</td>
    </tr>`).join('');
}

// ====================== FUNIL DASHBOARD ======================
function renderFunilDashboard() {
  const crm = DB.get('crm');
  const steps = [
    { label: 'Contatos', count: crm.length, color: '#3b82f6' },
    { label: 'Em negociação', count: crm.filter(r => ['Em negociação','Marcou','Atendeu'].includes(r.status)).length, color: '#8b5cf6' },
    { label: 'Marcaram', count: crm.filter(r => ['Marcou','Atendeu'].includes(r.status)).length, color: '#f59e0b' },
    { label: 'Atenderam', count: crm.filter(r => r.status === 'Atendeu').length, color: '#10b981' },
  ];
  const max = steps[0].count || 1;
  const container = document.getElementById('funil-list');
  if (!container) return;
  container.innerHTML = steps.map(s => `
    <div style="display:flex;align-items:center;gap:12px;">
      <div style="width:80px;font-size:12px;color:#64748b;font-weight:500;flex-shrink:0;">${s.label}</div>
      <div style="flex:1;height:8px;background:#f1f5f9;border-radius:999px;overflow:hidden;">
        <div style="height:100%;width:${max ? (s.count/max*100) : 0}%;background:${s.color};border-radius:999px;transition:width 0.5s;"></div>
      </div>
      <div style="width:28px;text-align:right;font-size:13px;font-weight:700;color:#1e293b;">${s.count}</div>
    </div>`).join('');
}

function renderUltimasConsultas() {
  const pacs = DB.get('pacientes').slice(0, 5);
  const tbody = document.getElementById('dash-ultimas-tbody');
  if (!tbody) return;
  if (!pacs.length) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#94a3b8;padding:32px;">Nenhuma consulta registrada</td></tr>';
    return;
  }
  tbody.innerHTML = pacs.map(p => `
    <tr>
      <td style="font-weight:500;color:#0f172a;">${_esc(p.nome)}</td>
      <td style="color:#64748b;">${formatDate(p.data)}</td>
      <td><span class="badge badge-blue">${_esc(p.tipo)}</span></td>
      <td style="font-weight:600;color:#0f172a;">${BRL(p.valor)}</td>
      <td>${statusBadge(p.statusPgto)}</td>
    </tr>`).join('');
}

// ====================== MAESTRIA — IA ASSISTENTE ======================
let chatHistory = JSON.parse(localStorage.getItem('consult_chat_history') || '[]');

function saveChatHistory() {
  // Guarda só as últimas 100 mensagens para não encher o storage
  const trimmed = chatHistory.slice(-100);
  localStorage.setItem('consult_chat_history', JSON.stringify(trimmed));
}

function clearChatHistory() {
  if (!confirm('Apagar todo o histórico da MaestrIA?')) return;
  chatHistory = [];
  localStorage.removeItem('consult_chat_history');
  document.getElementById('chat-body').innerHTML = '';
  appendChatMsg('sofia', 'Histórico apagado. Como posso ajudar?');
}

function buildContext() {
  const pacs   = DB.get('pacientes');
  const crm    = DB.get('crm');
  const desps  = DB.get('despesas');
  const fup    = DB.get('followup');
  const metas  = DB.getObj('metas', {});
  const ags    = getAgendamentos();
  const procs  = getProcedimentos();
  const today  = _ymd(new Date());
  const mesAtual = today.substring(0, 7);

  const pacMes  = pacs.filter(p => getMes(p.data) === mesAtual);
  const despMes = desps.filter(d => getMes(d.data) === mesAtual);
  const fat     = pacMes.reduce((s, p) => s + p.valor, 0);
  const desp    = despMes.reduce((s, d) => s + d.valor, 0);
  const marcou  = crm.filter(c => c.status === 'Marcou' && !c.converted);
  const fupHoje = fup.filter(f => !f.feito && f.dataContato && f.dataContato <= today);

  // Agenda: hoje, amanhã e próximos 7 dias
  const amanha   = _ymd(_addDays(new Date(), 1));
  const proxDate = _ymd(_addDays(new Date(), 7));
  const agHoje   = ags.filter(a => a.data === today  && a.status !== 'Cancelado').sort((a,b) => a.hora.localeCompare(b.hora));
  const agAmanha = ags.filter(a => a.data === amanha && a.status !== 'Cancelado').sort((a,b) => a.hora.localeCompare(b.hora));
  const agSemana = ags.filter(a => a.data > today && a.data <= proxDate && a.status !== 'Cancelado').sort((a,b) => a.data.localeCompare(b.data) || a.hora.localeCompare(b.hora));

  // Financeiro: mês anterior para comparação
  const mesAnt   = _ymd(new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1)).substring(0, 7);
  const pacAnt   = pacs.filter(p => getMes(p.data) === mesAnt);
  const fatAnt   = pacAnt.reduce((s, p) => s + p.valor, 0);

  // Projeção: ritmo atual × dias restantes
  const diaAtual   = new Date().getDate();
  const diasNoMes  = new Date(new Date().getFullYear(), new Date().getMonth()+1, 0).getDate();
  const projecao   = diaAtual > 0 ? Math.round((fat / diaAtual) * diasNoMes) : 0;

  // Inadimplência: lista detalhada de pendentes
  const pacPendentes = pacs.filter(p => p.statusPgto === 'Pendente')
    .slice(0, 10)
    .map(p => `${p.nome} (${BRL(p.valor)}, ${formatDate(p.data)})`);
  const totalPendente = pacs.filter(p => p.statusPgto === 'Pendente').reduce((s,p) => s + (p.valor||0), 0);

  // Breakdown por procedimento no mês
  const procBreak = {};
  pacMes.forEach(p => { const k = p.tipo||'Outros'; procBreak[k] = (procBreak[k]||0) + 1; });
  const procBreakStr = Object.entries(procBreak).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`${k}:${v}`).join(', ') || 'sem dados';

  // No-shows no mês
  const noShowsMes = ags.filter(a => a.status === 'No-show' && getMes(a.data) === mesAtual).length;

  // Ticket médio
  const ticketMedio = pacMes.length ? (fat / pacMes.length) : 0;

  // Histórico do paciente buscado (últimas 5 consultas de cada nome único para consultas nominais)
  // Armazena lista completa de pacs para busca nominal
  const todosPacientes = pacs.slice(0, 50).map(p => `${p.nome}|${p.data}|${p.tipo}|${BRL(p.valor)}|${p.statusPgto}`).join('; ');

  return {
    hoje: today, amanha, mesAtual, mesAnt,
    faturamento: fat, despesas: desp, lucro: fat - desp,
    faturamentoAnt: fatAnt,
    variacaoMes: fatAnt ? (((fat - fatAnt) / fatAnt) * 100).toFixed(1) : 'N/A',
    projecaoMes: projecao,
    metaFat: metas.fat || 0,
    metaPac: metas.pac || 0,
    pctMeta: metas.fat ? ((fat / metas.fat) * 100).toFixed(1) : 0,
    pacientesMes: pacMes.length,
    pagos: pacMes.filter(p => p.statusPgto === 'Pago').length,
    pendentes: pacMes.filter(p => p.statusPgto === 'Pendente').length,
    totalPendente,
    pacPendentesLista: pacPendentes.join(' | ') || 'nenhum',
    ticketMedio: Math.round(ticketMedio),
    procBreakdown: procBreakStr,
    noShowsMes,
    crmTotal: crm.length,
    crmMarcouPendente: marcou.length,
    followupHoje: fupHoje.length,
    followupPendenteNomes: fupHoje.map(f => f.nome).join(', '),
    followupLista: fup.filter(f => !f.feito).slice(0,10).map(f => `${f.nome} (vence ${f.dataContato})`).join(' | ') || 'nenhum',
    crmMarcados: marcou.map(c => c.nome).join(', ') || 'nenhum',
    agendaHoje: agHoje.length ? agHoje.map(a => `${a.hora} ${a.pacienteNome} (${a.procedimento||'—'}) [${a.status}]`).join(' | ') : 'vazia',
    agendaAmanha: agAmanha.length ? agAmanha.map(a => `${a.hora} ${a.pacienteNome} (${a.procedimento||'—'})`).join(' | ') : 'vazia',
    agendaSemana: agSemana.slice(0,15).length ? agSemana.slice(0,15).map(a => `${a.data} ${a.hora} ${a.pacienteNome} (${a.procedimento||'—'})`).join(' | ') : 'vazia',
    procedimentos: procs.length ? procs.map(p => `${p.nome}: PIX R$${p.valorPix||0}/Cartão R$${p.valorCartao||0}`).join(' | ') : 'nenhum cadastrado',
    todosPacientes,
  };
}

function buildSystemPrompt(ctx) {
  const clinica = getClinicaConfig();
  const nomeDr  = clinica.nome || currentNome || 'do médico';
  const tratamento = currentRole === 'medico' ? `Dr(a). ${nomeDr}` : nomeDr;
  const esp     = clinica.especialidade || 'medicina';
  const local   = clinica.cidade ? ` em ${clinica.cidade}` : '';
  return `Você é a MaestrIA, assistente inteligente do consultório de ${esp.toLowerCase()} de ${tratamento}${local}.
Fala em português brasileiro, direta, amigável, OBJETIVA E CONCISA.

⚠️ NÃO USE markdown decorativo (sem **negrito**, sem títulos com #, sem listas com -). O chat mostra texto puro.

FORMATO OBRIGATÓRIO quando o usuário pede para registrar/criar/agendar algo:
Escreva UMA frase curta + o bloco action. NADA MAIS.

Exemplo CORRETO:
Usuário: "registra consulta da Dona Ana hoje, PIX, 1000, pago"
MaestrIA: Registrando consulta da Dona Ana.
\`\`\`action
{"tipo":"criar_paciente","dados":{"nome":"Ana","data":"${ctx.hoje}","tipo":"Consulta","valor":1000,"pagamento":"PIX","statusPgto":"Pago","obs":""}}
\`\`\`

Exemplo ERRADO (NUNCA faça isso):
MaestrIA: Paciente atendido: Nome: Ana, Valor: 1000... Ação registrada: ✅
(isso é errado porque NÃO executa nada — é só texto)


SITUAÇÃO ATUAL (${ctx.hoje}):
FINANCEIRO:
- Mês ${ctx.mesAtual}: faturamento R$${ctx.faturamento.toFixed(0)} | meta R$${ctx.metaFat} (${ctx.pctMeta}%) | projeção fim do mês R$${ctx.projecaoMes}
- Mês anterior (${ctx.mesAnt}): R$${ctx.faturamentoAnt.toFixed(0)} | variação: ${ctx.variacaoMes}%
- Despesas: R$${ctx.despesas.toFixed(0)} | Lucro líquido: R$${ctx.lucro.toFixed(0)}
- Ticket médio: R$${ctx.ticketMedio} | Procedimentos: ${ctx.procBreakdown}
- Inadimplência: ${ctx.pendentes} pendentes | Total em aberto: R$${ctx.totalPendente.toFixed(0)} | Quem deve: ${ctx.pacPendentesLista}

PACIENTES:
- Atendidos no mês: ${ctx.pacientesMes} (${ctx.pagos} pagos, ${ctx.pendentes} pendentes) | No-shows: ${ctx.noShowsMes}
- Meta pacientes: ${ctx.metaPac} | Histórico recente: ${ctx.todosPacientes}

AGENDA:
- Hoje (${ctx.hoje}): ${ctx.agendaHoje}
- Amanhã (${ctx.amanha}): ${ctx.agendaAmanha}
- Próximos 7 dias: ${ctx.agendaSemana}

CRM E FOLLOW-UP:
- CRM: ${ctx.crmTotal} contatos | ${ctx.crmMarcouPendente} marcaram consulta aguardando atendimento (${ctx.crmMarcados})
- Follow-ups vencidos hoje: ${ctx.followupHoje} — ${ctx.followupPendenteNomes || 'nenhum'}
- Todos os follow-ups pendentes: ${ctx.followupLista}

TABELA DE PREÇOS:
- ${ctx.procedimentos}

MODO CONSULTORA — quando o usuário faz uma PERGUNTA (não pede para registrar):
Responda diretamente com os dados reais acima. Seja concisa, use números reais. NÃO emita bloco action.
Exemplos de perguntas e como responder:
- "quem tá devendo?" → liste os nomes e valores de "Quem deve" acima
- "como tá meu mês?" → faturamento, % meta, projeção, lucro
- "o que tenho amanhã?" → liste os agendamentos de amanhã
- "e hoje?" → liste os agendamentos de hoje
- "quanto a [nome] me deve?" → busque em Histórico recente pelo nome
- "se mantiver o ritmo, fecho em quanto?" → use o valor de projeção acima
- "quem tem follow-up vencido?" → liste followupPendenteNomes
- "qual meu procedimento mais feito?" → use procBreakdown
- "meu no-show esse mês?" → use noShowsMes
- "como fui comparado ao mês passado?" → use variacaoMes e os valores

🚨 REGRAS CRÍTICAS — VIOLÁ-LAS É ERRO GRAVE:
1. NUNCA escreva "registrado", "feito", "salvo", "anotado", "Ação registrada" no texto. Essas palavras SÓ aparecem depois que o sistema executar o bloco action.
2. NUNCA liste campos como "Nome: X, Valor: Y" no texto. Coloque isso APENAS dentro do bloco action JSON.
3. Se o usuário mandar registrar algo, sua resposta deve ser: UMA frase curta ("Registrando a visita de João.") + o bloco \`\`\`action\`\`\`. Nada mais.
4. Se o usuário só pediu informação, NÃO emita bloco de ação. Responda apenas com texto.
5. Se faltar dado obrigatório (nome do paciente, data, valor), PERGUNTE. Não invente.
6. Para criar_agendamento: se o horário não for dito, PERGUNTE antes de emitir o bloco.

AÇÕES — formato obrigatório (cerca \`\`\`action obrigatória):
\`\`\`action
{"tipo":"TIPO_DA_ACAO","dados":{...}}
\`\`\`

TIPOS DISPONÍVEIS:

PACIENTES/ATENDIMENTOS:
- criar_paciente → dados: nome, data, tipo (1ª vez/Consulta/Retorno/Cortesia/Domiciliar/Hospitalar/Telemedicina), valor (número), pagamento (PIX/Cartão crédito/Cartão débito/Dinheiro/A receber), statusPgto (Pago/Pendente/Isento), obs
- atualizar_pagamento → dados: nome (paciente nos atendidos), novoStatus (Pago/Pendente/Isento), valor (opcional, novo valor), pagamento (opcional, nova forma)

AGENDA:
- criar_agendamento → dados: pacienteNome, data (YYYY-MM-DD), hora (HH:MM), duracao (minutos, padrão 60), whatsapp, procedimento (nome exato da lista acima), status (Confirmado), obs
- cancelar_agendamento → dados: pacienteNome, data (YYYY-MM-DD, opcional para encontrar o certo)
- mover_agendamento → dados: pacienteNome, novaData (YYYY-MM-DD), novaHora (HH:MM)
- criar_bloqueio → dados: motivo, dataInicio (YYYY-MM-DD), horaInicio (HH:MM), dataFim (YYYY-MM-DD), horaFim (HH:MM)

CRM:
- criar_crm → dados: nome, data, hora, whatsapp, idade, canal (Indicação médica/Indicação paciente/Google/Instagram/WhatsApp/Doctoralia/Outros), tipo, status (Contato feito/Em negociação/Marcou/Atendeu/Não marcou), obs
- atualizar_status_crm → dados: nome (DEVE existir no CRM acima), novoStatus

FINANCEIRO/ADMIN:
- criar_followup → dados: nome, ultConsulta (YYYY-MM-DD), dataContato (YYYY-MM-DD), tipoContato (WhatsApp/Ligação/E-mail), dataReav, obs
- criar_despesa → dados: data, descricao, categoria (Estrutura/Pessoal/Marketing/Materiais/Profissional/Impostos/Outros), tipo (Fixo/Variável), valor (número), formaPgto (PIX/Débito/Crédito/Boleto/Dinheiro)
- criar_procedimento → dados: nome, valorPix (número), valorCartao (número)
- definir_meta → dados: fat (número, meta faturamento), pac (número, meta pacientes)

REGRAS:
- Se a data não for dita, use hoje: ${ctx.hoje}
- Valores monetários: extraia do texto ("mil e cinquenta" = 1050, "oitocentos" = 800)
- Se o valor não for mencionado, consulte a lista de procedimentos acima e use o valorPix do procedimento correspondente
- Se a forma de pagamento não for mencionada, use PIX como padrão
- Se o statusPgto não for mencionado, use Pago como padrão
- Para cancelar/mover: use o nome exato ou parte do nome do paciente que aparece na agenda
- Após emitir um bloco de ação, escreva APENAS uma frase curta confirmando. O sistema mostrará o ✅ depois.`;
}

async function sendAIMessage() {
  const input = document.getElementById('chat-input-el');
  const msg = input.value.trim();
  if (!msg) return;

  const key = getGeminiKey();
  if (!key) {
    appendChatMsg('sofia', 'Preciso da chave para funcionar. Clique em ⚙️ acima.');
    return;
  }

  appendChatMsg('user', msg);
  chatHistory.push({ role: 'user', text: msg, ts: new Date().toISOString() });
  saveChatHistory();
  input.value = '';
  const typing = appendChatMsg('sofia', '...', true);

  try {
    const ctx = buildContext();
    // Monta histórico no formato OpenAI/Groq
    const messages = [{ role: 'system', content: buildSystemPrompt(ctx) }];
    chatHistory.forEach(h => messages.push({ role: h.role === 'sofia' ? 'assistant' : 'user', content: h.text }));
    messages.push({ role: 'user', content: msg });

    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages,
        temperature: 0.3,
        max_tokens: 700
      })
    });

    const json = await res.json();
    if (json.error) { typing.textContent = '❌ ' + (json.error.message || 'Erro na API. Verifique sua chave.'); return; }

    const fullReply = json.choices?.[0]?.message?.content || 'Não entendi, pode repetir?';
    // Aceita action com ```action```, ```json``` ou JSON solto contendo "tipo" e "dados"
    let actionMatch = fullReply.match(/```(?:action|json)\s*\n([\s\S]*?)\n```/);
    let actionJSON = actionMatch ? actionMatch[1] : null;
    if (!actionJSON) {
      // Tenta pegar JSON inline com {"tipo":..., "dados":...}
      const inline = fullReply.match(/\{[^{}]*"tipo"\s*:\s*"[^"]+"\s*,\s*"dados"\s*:\s*\{[\s\S]*?\}\s*\}/);
      if (inline) actionJSON = inline[0];
    }
    // Limpa o texto: remove fences, JSON solto, markdown bold/headers e linhas tipo "**Ação:**"
    let cleanReply = fullReply
      .replace(/```(?:action|json)?[\s\S]*?```/g, '')
      .replace(/\{[^{}]*"tipo"\s*:\s*"[^"]+"\s*,\s*"dados"\s*:\s*\{[\s\S]*?\}\s*\}/g, '')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/^#+\s*/gm, '')
      .replace(/^\s*(Ação|Action|JSON)\s*:\s*$/gim, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (!cleanReply) cleanReply = 'Pronto.';

    // Detecta alucinação: Sofia diz "registrado/feito" mas não emitiu action
    const palavrasAcao = /registr(ei|ado|ando)|salv(ei|o|ando)|anot(ei|ado|ando)|ação registrada|foi registrad/i;
    if (!actionJSON && palavrasAcao.test(cleanReply)) {
      cleanReply = cleanReply.replace(palavrasAcao, match => `[${match}?]`);
      cleanReply += '\n\n⚠️ Parece que não executei nenhuma ação de fato. Repita o pedido mais direto, ex: "registra visita do João, valor 1500, PIX, pago".';
    }

    typing.textContent = cleanReply;
    // Adiciona o timestamp na bolha da Sofia
    const ts = document.createElement('div');
    ts.style.cssText = 'font-size:10px;opacity:0.55;margin-top:4px;';
    ts.textContent = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    typing.appendChild(ts);
    typing.classList.remove('typing');
    chatHistory.push({ role: 'sofia', text: cleanReply, ts: new Date().toISOString() });
    saveChatHistory();

    if (actionJSON) {
      try {
        const action = JSON.parse(actionJSON.trim());
        executeAIAction(action);
      } catch(e) {
        console.error('Erro ao parsear action:', e, actionJSON);
        appendChatMsg('system-ok', '⚠️ Sofia tentou executar uma ação mas o formato veio errado. Tente reformular o pedido.');
      }
    }

  } catch(e) {
    typing.textContent = '❌ Erro de conexão. Verifique a internet e a chave API.';
  }

  const body = document.getElementById('chat-body');
  body.scrollTop = body.scrollHeight;
}

function executeAIAction(action) {
  const { tipo, dados } = action;
  if (!tipo || !dados) return;

  // `dados` vem do LLM e era espalhado direto no registro. Sem nome, o registro
  // fica invisível na lista E vira coringa na busca por nome (contato sem nome
  // casava com qualquer paciente). Melhor recusar e pedir de novo do que gravar
  // um fantasma que só aparece quando estraga outra coisa.
  // Vale principalmente pras ações DESTRUTIVAS: sem nome, a busca de
  // agendamento casava com o primeiro da lista e cancelava/movia a consulta de
  // um paciente aleatório, avisando "feito" com o nome errado.
  const PRECISA_NOME = ['criar_paciente', 'criar_crm', 'criar_followup', 'criar_agendamento',
                        'cancelar_agendamento', 'mover_agendamento',
                        'atualizar_status_crm', 'atualizar_pagamento'];
  if (PRECISA_NOME.includes(tipo)) {
    const nome = String(dados.pacienteNome || dados.nome || '').trim();
    if (!nome) {
      appendChatMsg('system-ok', '⚠️ Faltou o nome — não registrei nada. Me diga de quem é.');
      return;
    }
  }

  if (tipo === 'criar_paciente') {
    const arr = DB.get('pacientes'); arr.unshift({ ...dados, id: _novoId('pac'), profissionalId: currentProfissionalId || null }); DB.set('pacientes', arr);
    appendChatMsg('system-ok', `✅ Atendimento de ${dados.nome} registrado — ${BRL(dados.valor)}`);
    if (document.getElementById('page-pacientes').classList.contains('active')) renderPacientes();
    renderDashboard();

  } else if (tipo === 'criar_crm') {
    const arr = DB.get('crm'); arr.unshift({ ...dados, id: _novoId('crm'), profissionalId: currentProfissionalId || null }); DB.set('crm', arr);
    appendChatMsg('system-ok', `✅ ${dados.nome} adicionado ao CRM`);
    if (document.getElementById('page-crm').classList.contains('active')) renderCrm();

  } else if (tipo === 'criar_followup') {
    const arr = DB.get('followup'); arr.unshift({ ...dados, feito: false, id: _novoId('fu'), profissionalId: (currentProfissionalId || _profDoPaciente(dados.nome) || null) }); DB.set('followup', arr);
    appendChatMsg('system-ok', `✅ Follow-up de ${dados.nome} criado para ${formatDate(dados.dataContato)}`);
    if (document.getElementById('page-followup').classList.contains('active')) renderFollowup();

  } else if (tipo === 'criar_despesa') {
    const arr = DB.get('despesas'); arr.unshift(dados); DB.set('despesas', arr);
    appendChatMsg('system-ok', `✅ Despesa "${dados.descricao}" de ${BRL(dados.valor)} registrada`);
    if (document.getElementById('page-despesas').classList.contains('active')) renderDespesas();

  } else if (tipo === 'atualizar_status_crm') {
    const arr = DB.get('crm');
    const idx = _acharCrmPorNome(arr, dados.nome);
    if (idx >= 0) {
      arr[idx].status = dados.novoStatus; DB.set('crm', arr);
      appendChatMsg('system-ok', `✅ ${arr[idx].nome} → "${dados.novoStatus}"`);
      if (document.getElementById('page-crm').classList.contains('active')) renderCrm();
    } else {
      // Vale tanto pra "não existe" quanto pra "existe mais de um parecido":
      // nos dois casos não dá pra gravar sem arriscar o contato errado.
      appendChatMsg('system-ok', `⚠️ Não achei um contato único chamado "${dados.nome}" no CRM. Confira o nome exato, ou me passe os dados que eu crio.`);
    }

  } else if (tipo === 'criar_agendamento') {
    const id = _agId();
    const item = {
      id,
      data: dados.data || _ymd(new Date()),
      hora: dados.hora || '08:00',
      duracao: parseInt(dados.duracao) || getAgConfig().slotDuracao || 60,
      pacienteNome: (dados.pacienteNome || dados.nome || '').trim(),
      whatsapp: dados.whatsapp || '',
      procedimento: dados.procedimento || '',
      profissionalId: currentProfissionalId || null,
      status: dados.status || 'Confirmado',
      obs: dados.obs || '',
      crmIdx: null, pacIdx: null,
    };
    const conflito = _temConflito(item.data, item.hora, item.duracao, null);
    if (conflito && item.status !== 'Cancelado') {
      appendChatMsg('system-ok', `⚠️ Conflito de horário: já tem ${conflito.pacienteNome} às ${conflito.hora}. Escolha outro horário.`);
      return;
    }
    if (_isBloqueado(item.data, item.hora, item.duracao)) {
      appendChatMsg('system-ok', `🚫 Horário bloqueado nesse período. Escolha outro horário.`);
      return;
    }
    const ags = getAgendamentos(); ags.push(item); DB.set('agendamentos', ags);

    // Atualiza CRM: se o paciente estava como Lead/Contato feito/Em negociação → muda para Marcou
    const nomeAlvo = item.pacienteNome.toLowerCase().trim();
    if (nomeAlvo) {
      const crm = DB.get('crm');
      const crmIdx = _acharCrmPorNome(crm, nomeAlvo);
      if (crmIdx >= 0 && !['Marcou','Atendeu'].includes(crm[crmIdx].status)) {
        crm[crmIdx].status = 'Marcou';
        DB.set('crm', crm);
        item.crmIdx = crmIdx;
        appendChatMsg('system-ok', `✅ ${item.pacienteNome} agendado para ${item.data} às ${item.hora} · CRM atualizado para "Marcou"`);
      } else {
        appendChatMsg('system-ok', `✅ ${item.pacienteNome} agendado para ${item.data} às ${item.hora} (${item.procedimento || 'sem procedimento'})`);
      }
    } else {
      appendChatMsg('system-ok', `✅ ${item.pacienteNome} agendado para ${item.data} às ${item.hora} (${item.procedimento || 'sem procedimento'})`);
    }
    if (document.getElementById('page-agenda').classList.contains('active')) renderAgenda();

  } else if (tipo === 'cancelar_agendamento') {
    const ags = getAgendamentos();
    const idx = _acharPorNome(ags, dados.pacienteNome || dados.nome, 'pacienteNome',
      a => a.status !== 'Cancelado' && (!dados.data || a.data === dados.data));
    if (idx >= 0) {
      const nome = ags[idx].pacienteNome;
      const dt   = ags[idx].data;
      ags[idx].status = 'Cancelado';
      DB.set('agendamentos', ags);

      // Atualiza CRM: reverte "Marcou" → "Em negociação"
      const crm = DB.get('crm');
      const crmIdx = _acharCrmPorNome(crm, nome);
      if (crmIdx >= 0 && crm[crmIdx].status === 'Marcou') {
        crm[crmIdx].status = 'Em negociação';
        DB.set('crm', crm);
        appendChatMsg('system-ok', `✅ Agendamento de ${nome} em ${dt} cancelado · CRM revertido para "Em negociação"`);
        if (document.getElementById('page-crm').classList.contains('active')) renderCrm();
      } else {
        appendChatMsg('system-ok', `✅ Agendamento de ${nome} em ${dt} cancelado`);
      }
      if (document.getElementById('page-agenda').classList.contains('active')) renderAgenda();
    } else {
      appendChatMsg('system-ok', `⚠️ Não achei UM agendamento ativo para "${dados.pacienteNome || dados.nome}". Se houver mais de um, me diga a data.`);
    }

  } else if (tipo === 'mover_agendamento') {
    const ags = getAgendamentos();
    const idx = _acharPorNome(ags, dados.pacienteNome || dados.nome, 'pacienteNome',
      a => a.status !== 'Cancelado');
    if (idx >= 0) {
      const novaData = dados.novaData || ags[idx].data;
      const novaHora = dados.novaHora || ags[idx].hora;
      const conflito = _temConflito(novaData, novaHora, ags[idx].duracao, ags[idx].id);
      if (conflito) {
        appendChatMsg('system-ok', `⚠️ Conflito no novo horário: já tem ${conflito.pacienteNome} às ${conflito.hora}. Tente outro horário.`);
        return;
      }
      const nomeAnt = ags[idx].pacienteNome;
      ags[idx].data = novaData;
      ags[idx].hora = novaHora;
      DB.set('agendamentos', ags);
      appendChatMsg('system-ok', `✅ Consulta de ${nomeAnt} movida para ${novaData} às ${novaHora}`);
      if (document.getElementById('page-agenda').classList.contains('active')) renderAgenda();
    } else {
      appendChatMsg('system-ok', `⚠️ Não achei UM agendamento ativo para "${dados.pacienteNome || dados.nome}". Se houver mais de um, confira o nome completo na agenda.`);
    }

  } else if (tipo === 'criar_bloqueio') {
    const item = {
      id: 'blq_' + Date.now(),
      motivo: dados.motivo || 'Bloqueio',
      dataInicio: dados.dataInicio,
      horaInicio: dados.horaInicio || '00:00',
      dataFim: dados.dataFim || dados.dataInicio,
      horaFim: dados.horaFim || '23:59',
    };
    const blqs = getBloqueios(); blqs.push(item); DB.set('bloqueios', blqs);
    appendChatMsg('system-ok', `✅ Bloqueio "${item.motivo}" criado de ${item.dataInicio} ${item.horaInicio} até ${item.dataFim} ${item.horaFim}`);
    if (document.getElementById('page-agenda').classList.contains('active')) renderAgenda();

  } else if (tipo === 'atualizar_pagamento') {
    const arr = DB.get('pacientes');
    const idx = _acharPorNome(arr, dados.nome, 'nome');
    if (idx >= 0) {
      if (dados.novoStatus) arr[idx].statusPgto = dados.novoStatus;
      if (dados.valor)      arr[idx].valor = parseFloat(dados.valor);
      if (dados.pagamento)  arr[idx].pagamento = dados.pagamento;
      DB.set('pacientes', arr);
      appendChatMsg('system-ok', `✅ Pagamento de ${arr[idx].nome} atualizado → ${dados.novoStatus || 'atualizado'}`);
      if (document.getElementById('page-pacientes').classList.contains('active')) renderPacientes();
      renderDashboard();
    } else {
      appendChatMsg('system-ok', `⚠️ Não achei UM atendimento de "${dados.nome}". Se houver mais de um, ajuste direto na tela de Atendidos.`);
    }

  } else if (tipo === 'criar_procedimento') {
    const procs = getProcedimentos();
    const existIdx = procs.findIndex(p => p.nome.toLowerCase() === (dados.nome||'').toLowerCase());
    const item = {
      id: existIdx >= 0 ? procs[existIdx].id : ('proc_' + Date.now()),
      nome: dados.nome,
      valorPix: parseFloat(dados.valorPix) || 0,
      valorCartao: parseFloat(dados.valorCartao) || parseFloat(dados.valorPix) || 0,
    };
    if (existIdx >= 0) procs[existIdx] = item; else procs.push(item);
    DB.set('procedimentos', procs);
    appendChatMsg('system-ok', `✅ Procedimento "${item.nome}" ${existIdx >= 0 ? 'atualizado' : 'criado'} — PIX ${BRL(item.valorPix)} / Cartão ${BRL(item.valorCartao)}`);
    if (document.getElementById('page-precos').classList.contains('active')) renderPrecos();

  } else if (tipo === 'definir_meta') {
    const metas = DB.getObj('metas', {});
    if (dados.fat !== undefined) metas.fat = parseFloat(dados.fat);
    if (dados.pac !== undefined) metas.pac = parseInt(dados.pac);
    DB.setObj('metas', metas);
    const partes = [];
    if (dados.fat !== undefined) partes.push(`Faturamento: ${BRL(dados.fat)}`);
    if (dados.pac !== undefined) partes.push(`Pacientes: ${dados.pac}`);
    appendChatMsg('system-ok', `✅ Meta atualizada — ${partes.join(' | ')}`);
    renderDashboard();
  }
}

function appendChatMsg(role, text, isTyping = false) {
  const body = document.getElementById('chat-body');
  const div = document.createElement('div');
  div.className = `chat-bubble ${role}${isTyping ? ' typing' : ''}`;
  div.textContent = text;
  // Adiciona timestamp nas mensagens reais
  if (!isTyping && (role === 'user' || role === 'sofia')) {
    const ts = document.createElement('div');
    ts.style.cssText = 'font-size:10px;opacity:0.55;margin-top:4px;';
    ts.textContent = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    div.appendChild(ts);
  }
  body.appendChild(div);
  body.scrollTop = body.scrollHeight;
  return div;
}

function quickMsg(text) {
  document.getElementById('chat-input-el').value = text;
  sendAIMessage();
}

function toggleChat() {
  const panel = document.getElementById('chat-panel');
  const isOpen = panel.style.display !== 'none';
  panel.style.display = isOpen ? 'none' : 'flex';
  if (!isOpen) {
    const key = getGeminiKey();
    if (key) {
      document.getElementById('gemini-setup').style.display = 'none';
      document.getElementById('chat-main').style.display = 'flex';

      const body = document.getElementById('chat-body');
      body.innerHTML = '';

      if (chatHistory.length > 0) {
        // Restaura histórico salvo
        chatHistory.forEach(h => {
          const div = document.createElement('div');
          div.className = `chat-bubble ${h.role === 'user' ? 'user' : h.role === 'system-ok' ? 'system-ok' : 'sofia'}`;
          div.textContent = h.text;
          if (h.ts) {
            const tsel = document.createElement('div');
            tsel.style.cssText = 'font-size:10px;opacity:0.55;margin-top:4px;';
            const d = new Date(h.ts);
            tsel.textContent = d.toLocaleDateString('pt-BR', { day:'2-digit', month:'2-digit' }) + ' ' + d.toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit' });
            div.appendChild(tsel);
          }
          body.appendChild(div);
        });
        body.scrollTop = body.scrollHeight;
        // Mostra alertas do dia se houver
        const ctx = buildContext();
        const alertas = [];
        if (ctx.followupHoje > 0) alertas.push(`📞 ${ctx.followupHoje} follow-up(s) vencido(s) hoje`);
        if (ctx.crmMarcouPendente > 0) alertas.push(`📋 ${ctx.crmMarcouPendente} marcado(s) sem atendimento`);
        if (alertas.length) setTimeout(() => appendChatMsg('sofia', '⚠️ Lembretes de hoje:\n' + alertas.join('\n')), 400);
      } else {
        const ctx = buildContext();
        const saudacao = _saudacaoPorHora();
        const msgs = [];
        if (ctx.followupHoje > 0) msgs.push(`📞 ${ctx.followupHoje} follow-up(s) vencido(s) hoje`);
        if (ctx.crmMarcouPendente > 0) msgs.push(`📋 ${ctx.crmMarcouPendente} paciente(s) marcados sem registro de atendimento`);
        const alertas = msgs.length ? '\n\n⚠️ ' + msgs.join('\n⚠️ ') : '';
        setTimeout(() => appendChatMsg('sofia', `${saudacao}! 👋 Sou a MaestrIA. Posso registrar atendimentos, despesas, follow-ups e responder qualquer dúvida sobre o consultório.${alertas}\n\nComo posso ajudar?`), 200);
      }
    } else {
      document.getElementById('gemini-setup').style.display = 'flex';
      document.getElementById('chat-main').style.display = 'none';
    }
  }
}

function saveGeminiKey() {
  const key = document.getElementById('gemini-key-input').value.trim();
  if (!key) return;
  setGeminiKey(key);
  document.getElementById('gemini-setup').style.display = 'none';
  document.getElementById('chat-main').style.display = 'flex';
  chatHistory = [];
  setTimeout(() => appendChatMsg('sofia', '🎉 Chave configurada! Agora pode me perguntar qualquer coisa ou pedir pra registrar atendimentos, despesas e follow-ups. Sou a MaestrIA, sua assistente de consultório.'), 200);
}

// ---- Voz ----
let recognition = null;
let isListening = false;

function toggleVoiceInput() {
  if (isListening) {
    stopVoice();
  } else {
    startVoice();
  }
}

function startVoice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    appendChatMsg('sofia', '❌ Reconhecimento de voz não disponível. Use o Google Chrome.');
    return;
  }

  recognition = new SR();
  recognition.lang = 'pt-BR';
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  const btn = document.getElementById('mic-btn');
  const input = document.getElementById('chat-input-el');

  btn.textContent = '⏹️';
  btn.classList.add('mic-recording');
  isListening = true;
  input.placeholder = '🔴 Ouvindo...';

  recognition.onresult = (e) => {
    const transcript = Array.from(e.results).map(r => r[0].transcript).join('');
    input.value = transcript;
    if (e.results[e.results.length - 1].isFinal) {
      stopVoice();
      if (transcript.trim()) sendAIMessage();
    }
  };

  recognition.onerror = (e) => {
    const msgs = { 'no-speech': 'Nenhuma fala detectada.', 'not-allowed': 'Permissão de microfone negada.', 'network': 'Erro de rede.' };
    appendChatMsg('sofia', '❌ ' + (msgs[e.error] || 'Erro no microfone: ' + e.error));
    stopVoice();
  };

  recognition.onend = () => { if (isListening) stopVoice(); };

  recognition.start();
}

function stopVoice() {
  isListening = false;
  if (recognition) { try { recognition.stop(); } catch(e) {} recognition = null; }
  const btn = document.getElementById('mic-btn');
  if (btn) { btn.textContent = '🎤'; btn.classList.remove('mic-recording'); }
  const input = document.getElementById('chat-input-el');
  if (input) input.placeholder = 'Digite ou fale…';
}

function openChatSettings() {
  document.getElementById('gemini-setup').style.display = 'flex';
  document.getElementById('chat-main').style.display = 'none';
  const existingKey = getGeminiKey() || '';
  document.getElementById('gemini-key-input').value = existingKey;
}

// ====================== PERFIL DO PACIENTE ======================

function buscaGlobal(query) {
  const el = document.getElementById('sidebar-search-results');
  if (!el) return;

  const q = (query || '').toLowerCase().trim();
  if (!q || q.length < 2) { el.style.display = 'none'; return; }

  // Coleta nomes únicos de pacientes, CRM e agenda
  const nomes = new Set();
  DB.get('pacientes').forEach(p => { if (p.nome) nomes.add(p.nome); });
  DB.get('crm').forEach(c => { if (c.nome) nomes.add(c.nome); });
  getAgendamentos().forEach(a => { if (a.pacienteNome) nomes.add(a.pacienteNome); });

  const matches = Array.from(nomes)
    .filter(n => n.toLowerCase().includes(q))
    .sort()
    .slice(0, 8);

  if (!matches.length) { el.style.display = 'none'; return; }

  const todosAtend = DB.get('pacientes');
  el.innerHTML = matches.map(nome => {
    const pacs = todosAtend.filter(p => (p.nome||'').toLowerCase().trim() === nome.toLowerCase().trim())
      .sort((a, b) => b.data.localeCompare(a.data));
    const sub = pacs.length
      ? `${pacs.length} consulta${pacs.length !== 1 ? 's' : ''} · última: ${formatDate(pacs[0].data)}`
      : 'Sem atendimento registrado';
    const initials = nome.split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase();
    return `
      <div onclick="abrirPerfilPaciente('${_jsArg(nome)}')"
           style="display:flex;align-items:center;gap:10px;padding:9px 12px;cursor:pointer;border-bottom:1px solid rgba(255,255,255,0.05);transition:background 0.15s;"
           onmouseover="this.style.background='rgba(255,255,255,0.07)'"
           onmouseout="this.style.background='transparent'">
        <div style="width:28px;height:28px;background:#1e293b;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:#10b981;flex-shrink:0;">${_esc(initials)}</div>
        <div>
          <div style="font-size:12.5px;font-weight:600;color:#f1f5f9;">${_esc(nome)}</div>
          <div style="font-size:10.5px;color:#94a3b8;">${sub}</div>
        </div>
      </div>`;
  }).join('');

  el.style.display = 'block';
}

// Adiciona/edita o WhatsApp de um paciente direto pelo perfil.
// Grava em TODAS as consultas e follow-ups com aquele nome (mantém consistente).
function _editarWhatsPerfil(nomeEnc) {
  const nome = decodeURIComponent(nomeEnc);
  const chave = nome.toLowerCase().trim();
  const atual = (DB.get('pacientes').find(p => (p.nome||'').toLowerCase().trim() === chave && p.whatsapp)?.whatsapp)
             || (DB.get('followup').find(f => (f.nome||'').toLowerCase().trim() === chave && f.whatsapp)?.whatsapp) || '';
  const novo = prompt(`WhatsApp de ${nome} (com DDD):`, atual);
  if (novo === null) return; // cancelou
  const num = novo.replace(/\D/g, '');
  const pacs = DB.get('pacientes');
  let mudou = false;
  pacs.forEach(p => { if ((p.nome||'').toLowerCase().trim() === chave) { p.whatsapp = num; mudou = true; } });
  if (mudou) DB.set('pacientes', pacs);
  const fus = DB.get('followup');
  let mudouF = false;
  fus.forEach(f => { if ((f.nome||'').toLowerCase().trim() === chave) { f.whatsapp = num; mudouF = true; } });
  if (mudouF) DB.set('followup', fus);
  if (typeof renderFollowup === 'function' && document.getElementById('page-followup')?.classList.contains('active')) renderFollowup();
  abrirPerfilPaciente(nomeEnc); // re-renderiza o perfil com o número novo
}

function abrirPerfilPaciente(nomeEnc) {
  const nome = decodeURIComponent(nomeEnc);

  // Fecha busca
  const searchEl = document.getElementById('sidebar-search-results');
  if (searchEl) searchEl.style.display = 'none';
  const searchInput = document.getElementById('sidebar-search');
  if (searchInput) searchInput.value = '';

  // Coleta dados por módulo
  const pacs = DB.get('pacientes')
    .filter(p => (p.nome||'').toLowerCase().trim() === nome.toLowerCase().trim())
    .sort((a, b) => b.data.localeCompare(a.data));
  const followups = DB.get('followup')
    .filter(f => (f.nome||'').toLowerCase().trim() === nome.toLowerCase().trim());
  const crm = DB.get('crm')
    .filter(c => (c.nome||'').toLowerCase().trim() === nome.toLowerCase().trim());
  const agenda = getAgendamentos()
    .filter(a => (a.pacienteNome||'').toLowerCase().trim() === nome.toLowerCase().trim())
    .sort((a, b) => b.data.localeCompare(a.data));

  // KPIs
  const ltv      = pacs.reduce((s, p) => s + (p.valor || 0), 0);
  const totalCons = pacs.length;
  const ultima    = pacs.length ? pacs[0].data : null;
  const ticket    = totalCons ? ltv / totalCons : 0;

  // Header
  const initials = nome.split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase();
  const avatarEl = document.getElementById('perfil-avatar');
  const nomeEl   = document.getElementById('perfil-nome');
  const subEl    = document.getElementById('perfil-sub');
  if (avatarEl) avatarEl.textContent = initials;
  if (nomeEl)   nomeEl.textContent   = nome;

  // Subtítulo: 1ª visita + status CRM
  const primeiraCons = pacs.length ? pacs[pacs.length - 1].data : null;
  const crmStatus    = crm.length ? crm[crm.length - 1].status : null;
  const subParts = [];
  if (primeiraCons) subParts.push(`1ª visita: ${formatDate(primeiraCons)}`);
  if (crmStatus)    subParts.push(`CRM: ${crmStatus}`);
  if (subEl) subEl.textContent = subParts.join(' · ') || 'Sem dados';

  // WhatsApp: pega de qualquer fonte (consulta, CRM, agenda, follow-up) + botão de ação
  const whats = (pacs.find(p => p.whatsapp)?.whatsapp) || (crm.find(c => c.whatsapp)?.whatsapp)
             || (agenda.find(a => a.whatsapp)?.whatsapp) || (followups.find(f => f.whatsapp)?.whatsapp) || '';
  const whatsEl = document.getElementById('perfil-whats');
  if (whatsEl) {
    if (whats) {
      const zapiOk = _waConnected();
      whatsEl.innerHTML =
        `<button onclick="falarComPacienteNome('${_jsArg(nome)}')" style="display:inline-flex;align-items:center;gap:6px;background:#dcfce7;color:#16a34a;border:none;border-radius:7px;padding:5px 12px;font-size:12.5px;font-weight:600;cursor:pointer;">💬 ${_esc(whats)}</button>` +
        `<button onclick="_editarWhatsPerfil('${_jsArg(nome)}')" style="background:none;border:none;color:#94a3b8;font-size:11.5px;cursor:pointer;margin-left:8px;">editar</button>` +
        `<div style="font-size:10.5px;color:#94a3b8;margin-top:3px;">${zapiOk ? '↪ responde pelo CRM' : '↪ abre o WhatsApp'}</div>`;
    } else {
      whatsEl.innerHTML =
        `<button onclick="_editarWhatsPerfil('${_jsArg(nome)}')" style="background:#f0fdf4;border:1px dashed #86efac;color:#16a34a;border-radius:7px;padding:5px 12px;font-size:12px;font-weight:600;cursor:pointer;">➕ Adicionar WhatsApp</button>`;
    }
  }

  // KPI elements
  setText('perfil-ltv',        BRL(ltv));
  setText('perfil-total-cons', totalCons);
  setText('perfil-ultima',     ultima ? formatDate(ultima) : '—');
  setText('perfil-ticket',     BRL(ticket));

  // Tab: Consultas
  const tabCons = document.getElementById('perfil-tab-consultas');
  if (tabCons) {
    if (!pacs.length) {
      tabCons.innerHTML = '<div style="text-align:center;color:#94a3b8;padding:32px;font-size:13px;">Nenhuma consulta registrada.</div>';
    } else {
      tabCons.innerHTML = `
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead>
            <tr style="border-bottom:2px solid #f1f5f9;">
              <th style="text-align:left;padding:8px 0;color:#64748b;font-weight:600;font-size:11.5px;">Data</th>
              <th style="text-align:left;padding:8px 0;color:#64748b;font-weight:600;font-size:11.5px;">Tipo</th>
              <th style="text-align:right;padding:8px 0;color:#64748b;font-weight:600;font-size:11.5px;">Valor</th>
              <th style="text-align:left;padding:8px 0;color:#64748b;font-weight:600;font-size:11.5px;">Pagamento</th>
              <th style="text-align:center;padding:8px 0;color:#64748b;font-weight:600;font-size:11.5px;">Status</th>
            </tr>
          </thead>
          <tbody>
            ${pacs.map(p => `
              <tr style="border-bottom:1px solid #f8fafc;">
                <td style="padding:9px 0;color:#374151;">${formatDate(p.data)}</td>
                <td style="padding:9px 0;"><span style="background:#dbeafe;color:#1d4ed8;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600;">${_esc(p.tipo)}</span></td>
                <td style="padding:9px 0;text-align:right;font-weight:700;color:#0f172a;">${BRL(p.valor)}</td>
                <td style="padding:9px 0;color:#64748b;font-size:12px;">${_esc(p.pagamento)}</td>
                <td style="padding:9px 0;text-align:center;">${statusBadge(p.statusPgto)}</td>
              </tr>`).join('')}
          </tbody>
          <tfoot>
            <tr style="border-top:2px solid #e2e8f0;background:#f8fafc;">
              <td colspan="2" style="padding:9px 0;font-weight:700;color:#0f172a;">Total (${totalCons} consulta${totalCons !== 1 ? 's' : ''})</td>
              <td style="padding:9px 0;text-align:right;font-weight:800;color:#10b981;">${BRL(ltv)}</td>
              <td colspan="2"></td>
            </tr>
          </tfoot>
        </table>`;
    }
  }

  // Tab: Follow-Up
  const tabFup = document.getElementById('perfil-tab-followup');
  if (tabFup) {
    if (!followups.length) {
      tabFup.innerHTML = '<div style="text-align:center;color:#94a3b8;padding:32px;font-size:13px;">Nenhum follow-up para este paciente.</div>';
    } else {
      tabFup.innerHTML = `
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead><tr style="border-bottom:2px solid #f1f5f9;">
            <th style="text-align:left;padding:8px 0;color:#64748b;font-weight:600;font-size:11.5px;">Data Contato</th>
            <th style="text-align:left;padding:8px 0;color:#64748b;font-weight:600;font-size:11.5px;">Tipo</th>
            <th style="text-align:left;padding:8px 0;color:#64748b;font-weight:600;font-size:11.5px;">Observação</th>
            <th style="text-align:center;padding:8px 0;color:#64748b;font-weight:600;font-size:11.5px;">Status</th>
          </tr></thead>
          <tbody>
            ${followups.map(f => `
              <tr style="border-bottom:1px solid #f8fafc;">
                <td style="padding:9px 0;color:#374151;">${formatDate(f.dataContato)}</td>
                <td style="padding:9px 0;color:#64748b;">${_esc(f.tipoContato || '—')}</td>
                <td style="padding:9px 0;color:#64748b;font-size:12px;">${_esc(f.obs || '—')}</td>
                <td style="padding:9px 0;text-align:center;">${statusBadge(f.feito ? 'Feito' : 'Pendente')}</td>
              </tr>`).join('')}
          </tbody>
        </table>`;
    }
  }

  // Tab: CRM
  const tabCrm = document.getElementById('perfil-tab-crm');
  if (tabCrm) {
    if (!crm.length) {
      tabCrm.innerHTML = '<div style="text-align:center;color:#94a3b8;padding:32px;font-size:13px;">Paciente não encontrado no CRM.</div>';
    } else {
      tabCrm.innerHTML = crm.map(c => `
        <div style="border:1px solid #f1f5f9;border-radius:10px;padding:14px 16px;margin-bottom:10px;">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;">
            <span style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.06em;">${_esc(c.canal || '—')}</span>
            ${statusBadge(c.status || '—')}
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:5px;font-size:12px;color:#374151;">
            <div>📅 ${formatDate(c.data)}</div>
            ${c.whatsapp ? `<div>📱 ${_esc(c.whatsapp)}</div>` : ''}
            ${c.idade    ? `<div>🎂 ${_esc(c.idade)} anos</div>` : ''}
            ${c.tipo     ? `<div>🩺 ${_esc(c.tipo)}</div>` : ''}
          </div>
          ${c.obs ? `<div style="margin-top:8px;font-size:12px;color:#64748b;font-style:italic;">${_esc(c.obs)}</div>` : ''}
        </div>`).join('');
    }
  }

  // Tab: Agenda
  const tabAg = document.getElementById('perfil-tab-agenda');
  if (tabAg) {
    if (!agenda.length) {
      tabAg.innerHTML = '<div style="text-align:center;color:#94a3b8;padding:32px;font-size:13px;">Nenhum agendamento encontrado.</div>';
    } else {
      const today = _ymd(new Date());
      tabAg.innerHTML = `
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead><tr style="border-bottom:2px solid #f1f5f9;">
            <th style="text-align:left;padding:8px 0;color:#64748b;font-weight:600;font-size:11.5px;">Data / Hora</th>
            <th style="text-align:left;padding:8px 0;color:#64748b;font-weight:600;font-size:11.5px;">Procedimento</th>
            <th style="text-align:center;padding:8px 0;color:#64748b;font-weight:600;font-size:11.5px;">Status</th>
          </tr></thead>
          <tbody>
            ${agenda.map(a => `
              <tr style="border-bottom:1px solid #f8fafc;${a.data >= today ? 'background:#f0fdf4;' : ''}">
                <td style="padding:9px 0;color:#374151;font-weight:${a.data >= today ? '600' : '400'};">${formatDate(a.data)} ${a.hora}</td>
                <td style="padding:9px 0;color:#64748b;">${_esc(a.procedimento || '—')}</td>
                <td style="padding:9px 0;text-align:center;">${statusBadge(a.status || 'Confirmado')}</td>
              </tr>`).join('')}
          </tbody>
        </table>`;
    }
  }

  // Ativa aba Consultas
  switchPerfilTab('consultas', document.querySelector('#modal-perfil .perfil-tab'));

  // Abre modal
  document.getElementById('modal-perfil').style.display = 'flex';
}

function switchPerfilTab(tab, btn) {
  ['consultas', 'followup', 'crm', 'agenda'].forEach(t => {
    const el = document.getElementById('perfil-tab-' + t);
    if (el) el.style.display = t === tab ? 'block' : 'none';
  });
  document.querySelectorAll('#modal-perfil .perfil-tab').forEach(b => {
    b.style.borderBottomColor = 'transparent';
    b.style.color = '#94a3b8';
  });
  if (btn) {
    btn.style.borderBottomColor = '#0f172a';
    btn.style.color = '#0f172a';
  }
}

// ====================== INIT ======================
// ====================== BACKUP ======================

// ====================== PAGINAÇÃO ======================
// Helper genérico — paginação só aparece se data.length > pageSize
const _pageState = {}; // { 'pacientes': 0, 'crm': 0 }
const _pageSize  = { default: 50 };

function _paginate(key, data) {
  const size = parseInt(localStorage.getItem('consult_page_size_'+key)) || _pageSize.default;
  let page = _pageState[key] || 0;
  const total = data.length;
  const totalPages = Math.max(1, Math.ceil(total / size));
  if (page >= totalPages) page = totalPages - 1;
  if (page < 0) page = 0;
  _pageState[key] = page;
  const inicio = page * size;
  const fim = Math.min(inicio + size, total);
  return {
    page, totalPages, total, size, inicio, fim,
    slice: data.slice(inicio, fim),
    needsControls: total > size,
  };
}

function _paginatorHtml(key, info) {
  if (!info.needsControls) return '';
  const opts = [25, 50, 100, 200].map(n =>
    `<option value="${n}" ${n === info.size ? 'selected' : ''}>${n}/pág</option>`
  ).join('');
  const prevDis = info.page === 0 ? 'disabled' : '';
  const nextDis = info.page >= info.totalPages - 1 ? 'disabled' : '';
  return `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-top:1px solid #f1f5f9;background:#fafbfc;font-size:12px;color:#64748b;">
      <div>Mostrando <strong>${info.inicio + 1}-${info.fim}</strong> de <strong>${info.total}</strong></div>
      <div style="display:flex;gap:8px;align-items:center;">
        <select onchange="_changePageSize('${key}', this.value)" class="select" style="width:90px;font-size:12px;padding:4px 8px;">${opts}</select>
        <button onclick="_goToPage('${key}', 0)" ${prevDis} class="pg-btn" title="Primeira">«</button>
        <button onclick="_goToPage('${key}', ${info.page - 1})" ${prevDis} class="pg-btn" title="Anterior">‹</button>
        <span style="padding:0 8px;color:#0f172a;font-weight:600;">${info.page + 1}/${info.totalPages}</span>
        <button onclick="_goToPage('${key}', ${info.page + 1})" ${nextDis} class="pg-btn" title="Próxima">›</button>
        <button onclick="_goToPage('${key}', ${info.totalPages - 1})" ${nextDis} class="pg-btn" title="Última">»</button>
      </div>
    </div>`;
}

function _goToPage(key, page) {
  _pageState[key] = page;
  // Refresh da tabela correspondente
  if (key === 'pacientes' && typeof renderPacientes === 'function') renderPacientes();
  if (key === 'crm' && typeof renderCrm === 'function') renderCrm();
}

function _changePageSize(key, size) {
  localStorage.setItem('consult_page_size_'+key, size);
  _pageState[key] = 0;
  _goToPage(key, 0);
}

// ====================== LEMBRETES WHATSAPP AUTOMÁTICOS ======================
// Envia mensagem 24h antes da consulta. Usa Z-API quando configurado.
// Roda no carregamento do app (1x/dia). Marca cada agendamento como notificado
// para evitar duplicados. Configurável e desativável.

function getLembretesConfig() {
  return DB.getObj('lembretes_config', {
    ativo: true,
    horasAntes: 24,
    mensagem: 'Olá {nome}! Lembrete do seu agendamento amanhã ({data}) às {hora} — {procedimento}. Confirma a presença? 😊',
    ultimoEnvio: null,
  });
}

function saveLembretesConfig() {
  const cfg = {
    ativo:      document.getElementById('lemb-ativo')?.checked ?? true,
    horasAntes: parseInt(document.getElementById('lemb-horas')?.value) || 24,
    mensagem:   document.getElementById('lemb-msg')?.value || getLembretesConfig().mensagem,
    ultimoEnvio: getLembretesConfig().ultimoEnvio,
  };
  DB.setObj('lembretes_config', cfg);
  toast('✅ Lembretes salvos.');
  _auditLog('configurou', 'lembretes', cfg.ativo ? 'Ativou lembretes automáticos' : 'Desativou lembretes automáticos');
}

function _formatarMensagemLembrete(ag, template) {
  const d = new Date(ag.data + 'T12:00:00');
  const dataFmt = d.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' });
  return (template || '')
    .replace(/\{nome\}/g, (ag.pacienteNome || '').split(' ')[0])
    .replace(/\{nomeCompleto\}/g, ag.pacienteNome || '')
    .replace(/\{data\}/g, dataFmt)
    .replace(/\{hora\}/g, ag.hora || '')
    .replace(/\{procedimento\}/g, ag.procedimento || 'consulta')
    .replace(/\{duracao\}/g, (ag.duracao || 50) + ' min');
}

// Número BR no formato internacional que a Cloud API exige: 55 + DDD + número.
// `startsWith('55') ? phone : '55' + phone` NÃO serve: quem é do DDD 55 (região
// de Santa Maria/RS) tem número que já começa com 55 sem ter DDI nenhum, e o
// teste de prefixo achava que o DDI estava lá. O celular 55 98765-4321 saía
// como 55987654321 — que o WhatsApp lê como DDD 98 — e a mensagem ia pra outro
// número ou pra lugar nenhum. O corte só vale a partir de 12 dígitos, mesma
// regra do _normPhone e do _zapiPhoneCandidates.
function _foneE164BR(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (!d) return '';
  return '55' + ((d.length >= 12 && d.startsWith('55')) ? d.slice(2) : d);
}

// Gera os formatos possíveis de um número BR para o Z-API, em ordem de tentativa.
// Resolve a ambiguidade do 9º dígito: o WhatsApp pode ter registrado o número
// COM ou SEM o 9, então devolvemos os dois candidatos pra tentar em sequência.
function _zapiPhoneCandidates(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('55') && d.length >= 12) d = d.slice(2);   // normaliza removendo o 55
  const ddd  = d.slice(0, 2);
  const rest = d.slice(2);
  const out = [];
  if (rest.length === 9 && rest.charAt(0) === '9') {
    out.push('55' + ddd + rest);              // como veio (com o 9)
    out.push('55' + ddd + rest.slice(1));     // sem o 9
  } else if (rest.length === 8 && /[6-9]/.test(rest.charAt(0))) {
    out.push('55' + ddd + rest);              // como veio (sem o 9) — formato que o Z-API costuma entregar
    out.push('55' + ddd + '9' + rest);        // alternativa: adiciona o 9
  } else {
    out.push('55' + d);                        // fixo ou já completo
  }
  return [...new Set(out)];
}

// Envia texto via Z-API tentando os formatos de número em sequência.
// Só re-tenta o próximo formato se o erro for "NOT_FOUND" (nada foi enviado),
// evitando qualquer risco de mensagem duplicada.
async function _zapiSendText(cfg, rawPhone, text) {
  const cands = _zapiPhoneCandidates(rawPhone);
  // Só envia o header Client-Token se houver um token de segurança da conta.
  // (Mandar o token da instância aqui faz o Z-API rejeitar com "client-token is not configured".)
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.clientToken) headers['Client-Token'] = cfg.clientToken;
  let lastErr = 'número inválido';
  for (const phone of cands) {
    try {
      const res = await fetch(
        `https://api.z-api.io/instances/${cfg.instanceId}/token/${cfg.token}/send-text`,
        { method: 'POST', headers, body: JSON.stringify({ phone, message: text }) }
      );
      const data = await res.json().catch(() => ({}));
      if (res.ok && (data.zaapId || data.messageId || data.id)) return { ok: true, phone };
      lastErr = data.error || data.message ||
        (data.value != null ? JSON.stringify(data.value) : '') || ('HTTP ' + res.status);
      // Erro que NÃO é de número não encontrado (ex.: client-token) → não adianta trocar o formato
      if (!/NOT_?FOUND|not.?found|exist|inv[aá]lid/i.test(lastErr)) break;
    } catch(e) { lastErr = e.message; break; }
  }
  return { ok: false, error: lastErr };
}

// ====================== WHATSAPP CLOUD API (Meta, oficial) ======================
// Envia mensagem de SESSÃO (texto livre). Só é entregue dentro da janela de 24h
// após o paciente escrever; fora dela a Meta exige template (ver _cloudSendTemplate).
async function _cloudSendText(cfg, rawPhone, text) {
  const phone = String(rawPhone || '').replace(/\D/g, '');
  if (!phone) return { ok: false, error: 'número inválido' };
  const to = _foneE164BR(phone);   // 55 + DDD + número (ver _foneE164BR)
  try {
    const res = await fetch(`https://graph.facebook.com/v21.0/${cfg.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.accessToken },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { preview_url: false, body: text } }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.messages && data.messages[0]) return { ok: true, phone: to };
    return { ok: false, error: (data.error && (data.error.message || data.error.type)) || ('HTTP ' + res.status) };
  } catch (e) { return { ok: false, error: e.message }; }
}

// Envia TEMPLATE aprovado (mensagem proativa fora da janela de 24h).
// bodyParams preenche as variáveis {{1}}, {{2}}… do corpo, em ordem.
async function _cloudSendTemplate(cfg, rawPhone, templateName, langCode, bodyParams) {
  const phone = String(rawPhone || '').replace(/\D/g, '');
  if (!phone) return { ok: false, error: 'número inválido' };
  const to = _foneE164BR(phone);
  const components = (bodyParams && bodyParams.length)
    ? [{ type: 'body', parameters: bodyParams.map(v => ({ type: 'text', text: String(v) })) }]
    : [];
  try {
    const res = await fetch(`https://graph.facebook.com/v21.0/${cfg.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.accessToken },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'template',
        template: { name: templateName, language: { code: langCode || 'pt_BR' }, components } }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.messages && data.messages[0]) return { ok: true, phone: to };
    return { ok: false, error: (data.error && (data.error.message || data.error.type)) || ('HTTP ' + res.status) };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ── Dispatcher único de SESSÃO (chat do CRM): roteia pro provedor ativo. ──
// Todos os pontos de envio do app passam por aqui — trocar de provedor não
// exige mexer em cada call site.
async function _waSendText(rawPhone, text) {
  if (getWaProvider() === 'cloud') return await _cloudSendText(getCloudConfig(), rawPhone, text);
  return await _zapiSendText(getZapiConfig(), rawPhone, text);
}

// Envia 1 lembrete (proativo) pelo provedor ativo.
// Cloud API: usa template aprovado se configurado; senão tenta texto (só entrega
// dentro da janela de 24h). Z-API: texto livre, como antes.
async function _enviarLembreteZapi(ag, mensagem) {
  if (!_waConnected()) return { error: 'WhatsApp não configurado' };
  const fone = (ag.whatsapp || '').replace(/\D/g, '');
  if (!fone || fone.length < 10) return { error: 'WhatsApp inválido' };
  if (getWaProvider() === 'cloud') {
    const c = getCloudConfig();
    if (c.templateLembrete) return await _cloudSendTemplate(c, fone, c.templateLembrete, c.templateLang, [mensagem]);
    return await _cloudSendText(c, fone, mensagem);
  }
  return await _zapiSendText(getZapiConfig(), fone, mensagem);
}

// Encontra agendamentos elegíveis (na janela de N horas, não realizados, não notificados)
function _agendamentosParaLembrar(horasAntes) {
  const agora = new Date();
  const alvo = new Date(agora.getTime() + horasAntes * 3600000);
  const alvoData = _ymd(alvo);
  // Janela: tudo no dia "alvoData" que ainda não foi notificado
  return DB.get('agendamentos').filter(ag =>
    ag.data === alvoData &&
    ag.status !== 'Compareceu' &&
    ag.status !== 'Faltou' &&
    ag.status !== 'Cancelado' &&
    !ag._lembreteEnviado &&
    ag.whatsapp
  );
}

// Roda o ciclo (chamado 1x por dia automaticamente)
async function rodarCicloLembretes(forcado = false) {
  const cfg = getLembretesConfig();
  if (!cfg.ativo && !forcado) return { skipped: 'desativado' };

  // Já rodou hoje? Pula (a menos que forçado)
  const hoje = _ymd(new Date());
  if (!forcado && cfg.ultimoEnvio === hoje) return { skipped: 'já rodou hoje' };

  const ags = _agendamentosParaLembrar(cfg.horasAntes);
  if (!ags.length) {
    cfg.ultimoEnvio = hoje;
    DB.setObj('lembretes_config', cfg);
    return { enviados: 0, msg: 'nenhum agendamento elegível' };
  }

  // Vale pra QUALQUER provedor ativo (Z-API ou Cloud API) — o envio em
  // _enviarLembreteZapi já roteia pelo provedor certo.
  if (!_waConnected()) {
    return { error: 'WhatsApp não está conectado. Configure em Configurações para enviar lembretes automáticos.' };
  }

  let sucesso = 0, erro = 0;
  for (const ag of ags) {
    const msg = _formatarMensagemLembrete(ag, cfg.mensagem);
    let r;
    try { r = await _enviarLembreteZapi(ag, msg); }
    catch (e) { r = { error: (e && e.message) || 'falha no envio' }; }

    // Marca IMEDIATAMENTE, antes do próximo envio. Guardar isso pro fim do laço
    // significava que interromper o ciclo no meio perdia o registro de tudo que
    // JÁ TINHA SIDO ENVIADO — e o ciclo seguinte mandava a mesma mensagem de
    // novo pros mesmos pacientes. O ciclo dispara sozinho 5s depois de abrir o
    // app e leva ~1s por paciente, então basta fechar o app enquanto ele roda.
    // Relê a coleção a cada volta pra não sobrescrever o que o pull trouxe.
    const todosAgs = DB.get('agendamentos');
    const idx = todosAgs.findIndex(a => a.id === ag.id);
    if (idx >= 0) {
      if (r && r.ok) {
        todosAgs[idx]._lembreteEnviado = new Date().toISOString();
        sucesso++;
      } else {
        todosAgs[idx]._lembreteErro = (r && r.error) || 'desconhecido';
        erro++;
      }
      DB.set('agendamentos', todosAgs);
    }
    // Throttle pra evitar rate limit
    await new Promise(r => setTimeout(r, 800));
  }
  cfg.ultimoEnvio = hoje;
  DB.setObj('lembretes_config', cfg);

  if (sucesso > 0) _auditLog('configurou', 'lembretes', `Enviou ${sucesso} lembretes WhatsApp${erro > 0 ? ' (' + erro + ' falharam)' : ''}`);
  return { enviados: sucesso, erros: erro };
}

function renderLembretesCard() {
  const card = document.getElementById('card-lembretes');
  if (!card) return;
  const cfg = getLembretesConfig();
  const zapi = getZapiConfig();
  const zapiOk = zapi.enabled && zapi.instanceId && zapi.token;

  // Preenche campos
  const a = document.getElementById('lemb-ativo'); if (a) a.checked = cfg.ativo;
  const h = document.getElementById('lemb-horas'); if (h) h.value = cfg.horasAntes;
  const m = document.getElementById('lemb-msg');   if (m) m.value = cfg.mensagem;

  // Status indicator
  const status = document.getElementById('lemb-status');
  if (status) {
    if (!zapiOk) status.innerHTML = '<span style="color:#dc2626;">⚠️ Z-API não conectado — lembretes não serão enviados</span>';
    else if (!cfg.ativo) status.innerHTML = '<span style="color:#94a3b8;">Inativo</span>';
    else status.innerHTML = `<span style="color:#10b981;font-weight:600;">✓ Ativo</span> · último envio: ${cfg.ultimoEnvio || 'nunca'}`;
  }
}

// ====================== AUDIT LOG (HISTÓRICO DE ALTERAÇÕES) ======================
// Registra quem fez o quê e quando no sistema. Mantém últimas 500 entradas.
const MAX_AUDIT_ENTRIES = 500;

function _auditLog(acao, entidade, descricao, detalhes) {
  try {
    const log = JSON.parse(localStorage.getItem('consult_audit_log') || '[]');
    const entry = {
      ts: new Date().toISOString(),
      autor: (typeof currentNome !== 'undefined' && currentNome) ? currentNome : '—',
      autorRole: (typeof currentRole !== 'undefined' && currentRole) ? currentRole : '—',
      acao,            // 'criou' | 'editou' | 'excluiu' | 'configurou' | 'login' | 'logout'
      entidade,        // 'paciente' | 'crm' | 'agendamento' | 'inscricao' | ...
      descricao,       // texto humano: "Cadastrou João Silva — Consulta"
      detalhes: detalhes || null,
    };
    log.unshift(entry);
    // Mantém últimas N entradas
    if (log.length > MAX_AUDIT_ENTRIES) log.length = MAX_AUDIT_ENTRIES;
    localStorage.setItem('consult_audit_log', JSON.stringify(log));
  } catch(e) { console.warn('audit log fail:', e.message); }
}

function getAuditLog() {
  try { return JSON.parse(localStorage.getItem('consult_audit_log') || '[]'); }
  catch { return []; }
}

function limparAuditLog() {
  if (!confirm('Limpar todo o histórico de alterações? Esta ação não pode ser desfeita.')) return;
  localStorage.removeItem('consult_audit_log');
  renderAuditLog();
  toast('Histórico de alterações limpo.');
}

function renderAuditLog() {
  const el = document.getElementById('audit-log-list');
  if (!el) return;
  const log = getAuditLog();
  if (!log.length) {
    el.innerHTML = '<div style="text-align:center;padding:32px;color:#94a3b8;font-size:13px;">Nenhuma alteração registrada ainda.</div>';
    return;
  }
  const corPorAcao = {
    'criou':      { bg:'#d1fae5', cor:'#065f46', icon:'+' },
    'editou':     { bg:'#dbeafe', cor:'#1d4ed8', icon:'✎' },
    'excluiu':    { bg:'#fee2e2', cor:'#991b1b', icon:'×' },
    'configurou': { bg:'#fef3c7', cor:'#92400e', icon:'⚙' },
    'login':      { bg:'#f1f5f9', cor:'#475569', icon:'→' },
    'logout':     { bg:'#f1f5f9', cor:'#475569', icon:'←' },
  };
  el.innerHTML = log.slice(0, 100).map(e => {
    const c = corPorAcao[e.acao] || corPorAcao.editou;
    const d = new Date(e.ts);
    const hora = d.toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit' });
    const data = d.toLocaleDateString('pt-BR', { day:'2-digit', month:'short' });
    return `
      <div style="display:flex;gap:12px;padding:10px 14px;border-bottom:1px solid #f1f5f9;align-items:flex-start;">
        <div style="width:28px;height:28px;background:${c.bg};color:${c.cor};border-radius:6px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;flex-shrink:0;margin-top:1px;">${c.icon}</div>
        <div style="flex:1;min-width:0;">
          <div style="font-size:12.5px;color:#0f172a;line-height:1.4;">${_esc(e.descricao)}</div>
          <div style="font-size:11px;color:#94a3b8;margin-top:2px;">
            ${_esc(e.autor)} · ${e.autorRole === 'medico' ? '🩺' : '📋'} · ${data} às ${hora}
          </div>
        </div>
      </div>`;
  }).join('');
}

// ====================== 2FA (MFA TOTP) ======================
// Usa o sistema MFA nativo do Supabase Auth (TOTP — Google Authenticator, Authy, etc.)

async function mfaListarFatores() {
  if (!_supa) return null;
  try {
    const { data, error } = await _supa.auth.mfa.listFactors();
    if (error) return { error: error.message };
    return data;
  } catch(e) { return { error: e.message }; }
}

async function mfaCadastrar() {
  if (!_supa || !currentUser) return { error: 'Sem sessão.' };
  try {
    const { data, error } = await _supa.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Consultório App' });
    if (error) return { error: error.message };
    return { factorId: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret, uri: data.totp.uri };
  } catch(e) { return { error: e.message }; }
}

async function mfaVerificarPrimeiroCodigo(factorId, code) {
  if (!_supa) return { error: 'Sem conexão.' };
  try {
    const challenge = await _supa.auth.mfa.challenge({ factorId });
    if (challenge.error) return { error: challenge.error.message };
    const verify = await _supa.auth.mfa.verify({ factorId, challengeId: challenge.data.id, code });
    if (verify.error) return { error: verify.error.message };
    return { ok: true };
  } catch(e) { return { error: e.message }; }
}

async function mfaDesativar(factorId) {
  if (!_supa) return { error: 'Sem conexão.' };
  try {
    const { error } = await _supa.auth.mfa.unenroll({ factorId });
    if (error) return { error: error.message };
    return { ok: true };
  } catch(e) { return { error: e.message }; }
}

// Verifica AAL — se requer 2FA, faz challenge
async function mfaVerificarSeNecessario(code) {
  if (!_supa) return { error: 'Sem conexão.' };
  try {
    const { data: aalData } = await _supa.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aalData.nextLevel === aalData.currentLevel) return { ok: true, noMfa: true };
    if (aalData.nextLevel === 'aal2') {
      const factors = await _supa.auth.mfa.listFactors();
      const totp = factors.data?.totp?.[0];
      if (!totp) return { ok: true, noMfa: true };
      if (!code) return { needsCode: true, factorId: totp.id };
      const challenge = await _supa.auth.mfa.challenge({ factorId: totp.id });
      if (challenge.error) return { error: challenge.error.message };
      const verify = await _supa.auth.mfa.verify({ factorId: totp.id, challengeId: challenge.data.id, code });
      if (verify.error) return { error: 'Código incorreto.' };
      return { ok: true };
    }
    return { ok: true };
  } catch(e) { return { error: e.message }; }
}

// ====================== BACKUP AUTOMÁTICO DIÁRIO ======================
// Tira um snapshot por dia no localStorage + sincroniza pro Supabase via cloudPush.
// Mantém os últimos 7 dias. Permite restaurar qualquer dia sem perder dados.

const MAX_SNAPSHOTS = 7;          // mantém 1 semana de backups
const SNAPSHOT_PREFIX = '_snapshot_';  // chave: consult__snapshot_YYYY-MM-DD

async function criarSnapshotDiario() {
  // SÓ O DONO cria snapshot: o blob contém a clínica inteira (pacientes,
  // finanças, chaves de API). Criado por um membro, ele subia pro app_data e
  // vazava tudo pra equipe — furando a blindagem e o financeiro escondido.
  if (!currentUser || (currentDataOwner || currentUser.id) !== currentUser.id) {
    return { skipped: true, reason: 'snapshot é responsabilidade do dono' };
  }
  const hoje = _ymd(new Date());
  const chave = SNAPSHOT_PREFIX + hoje;

  // Já existe snapshot de hoje? Pula.
  if (localStorage.getItem('consult_' + chave)) return { skipped: true, reason: 'já existe snapshot de hoje' };

  // Monta o snapshot
  const snapshot = { _meta: { criadoEm: new Date().toISOString(), data: hoje, automatico: true } };
  BACKUP_KEYS.forEach(k => {
    const raw = localStorage.getItem('consult_' + k);
    if (raw) snapshot[k] = JSON.parse(raw);
  });

  // Salva local + sincroniza com Supabase
  localStorage.setItem('consult_' + chave, JSON.stringify(snapshot));
  if (typeof cloudPush === 'function') await cloudPush(chave);

  // Limpa snapshots antigos (mantém últimos N)
  await _limparSnapshotsAntigos();

  return { created: true, data: hoje, chave };
}

async function _limparSnapshotsAntigos() {
  const datas = Object.keys(localStorage)
    .filter(k => k.startsWith('consult_' + SNAPSHOT_PREFIX))
    .map(k => k.substring(('consult_' + SNAPSHOT_PREFIX).length))
    .sort()
    .reverse();
  const aRemover = datas.slice(MAX_SNAPSHOTS);
  for (const data of aRemover) {
    const k = SNAPSHOT_PREFIX + data;
    localStorage.removeItem('consult_' + k);
    // Remove do Supabase também
    if (_supa && currentUser) {
      const owner = currentDataOwner || currentUser.id;
      try { await _supa.from('app_data').delete().eq('user_id', owner).eq('key', k); }
      catch(e) { console.warn('erro removendo snapshot ' + data, e.message); }
    }
  }
}

function listarSnapshots() {
  return Object.keys(localStorage)
    .filter(k => k.startsWith('consult_' + SNAPSHOT_PREFIX))
    .map(k => {
      const data = k.substring(('consult_' + SNAPSHOT_PREFIX).length);
      try {
        const snap = JSON.parse(localStorage.getItem(k));
        return {
          data,
          chave: k.substring('consult_'.length),
          criadoEm: snap._meta?.criadoEm,
          automatico: snap._meta?.automatico,
          tamanhoKB: Math.round(localStorage.getItem(k).length / 1024),
          pacientes: snap.pacientes?.length || 0,
          inscricoes: snap.inscricoes?.length || 0,
        };
      } catch { return { data, chave: k.substring('consult_'.length), erro: true }; }
    })
    .sort((a, b) => b.data.localeCompare(a.data));
}

async function restaurarSnapshot(data) {
  const chave = SNAPSHOT_PREFIX + data;
  const raw = localStorage.getItem('consult_' + chave);
  if (!raw) { alert('Snapshot não encontrado.'); return; }
  const snap = JSON.parse(raw);
  if (!confirm(`Restaurar backup de ${data}?\n\nSeus dados atuais serão substituídos. Esta ação não pode ser desfeita.`)) return;

  const falhas = [];
  for (const k of BACKUP_KEYS) {
    if (snap[k] === undefined) continue;
    const cfg = _BLINDADAS[k];
    if (cfg) {
      // Coleção blindada: mora em tabela própria. cloudPush grava só o blob
      // morto do app_data, então o restore era um NO-OP SILENCIOSO justamente
      // nas coleções que importam (atendimentos, agenda, CRM, inscrições,
      // followup) — e o pull seguinte devolvia os dados velhos por cima.
      const old = JSON.parse(localStorage.getItem('consult_' + k) || '[]');
      localStorage.setItem('consult_' + k, JSON.stringify(snap[k]));
      const ok = await _pushBlindada(cfg.tabela, old, snap[k]);
      if (!ok) { falhas.push(k); _outboxAdd(k, 'blindada'); }
    } else {
      localStorage.setItem('consult_' + k, JSON.stringify(snap[k]));
      if (typeof cloudPush === 'function') await cloudPush(k);
    }
  }
  if (falhas.length) {
    alert('Backup restaurado NESTE APARELHO, mas estas coleções não subiram para a nuvem: '
      + falhas.join(', ') + '.\n\nElas ficaram na fila de envio. Mantenha o app aberto com internet até sincronizar.');
  } else {
    toast('✅ Backup de ' + data + ' restaurado! Recarregando…', 2000);
  }
  setTimeout(() => location.reload(), 2000);
}

async function excluirSnapshot(data) {
  if (!confirm(`Excluir backup de ${data}? Esta ação não pode ser desfeita.`)) return;
  const chave = SNAPSHOT_PREFIX + data;
  localStorage.removeItem('consult_' + chave);
  if (_supa && currentUser) {
    const owner = currentDataOwner || currentUser.id;
    try { await _supa.from('app_data').delete().eq('user_id', owner).eq('key', chave); } catch(e) {}
  }
  toast('Backup excluído.');
  renderBackup();
}

const BACKUP_KEYS = [
  // Dados operacionais
  'pacientes','crm','despesas','followup','agendamentos','bloqueios',
  // Configurações
  'procedimentos','agenda_config','metas','metas_proc','metas_proc_valor',
  // Programas (cuidado longitudinal e assinaturas)
  'programas','inscricoes',
  // Personalização do consultório
  'clinica_config',
  // Integrações
  'zapi_config','wa_cloud_config','wa_provider','lembretes_config','ia_config','llm_config',
  // Gamificação
  'maestria',
  // Auditoria
  'audit_log',
  // Histórico do chat (não-crítico, mas útil)
  'chat_history'
];

// ====================== CONFIGURAÇÕES / Z-API ======================

function getZapiConfig() {
  return DB.getObj('zapi_config', { enabled: false, instanceId: '', token: '', clientToken: '' });
}

// ====================== WHATSAPP — SELEÇÃO DE PROVEDOR ======================
// O app não fica preso a um provedor: 'zapi' (gateway pago) ou 'cloud'
// (WhatsApp Cloud API oficial da Meta — atendimento grátis, sem risco de ban).
// Default 'zapi' p/ não mexer em quem já está conectado. Só um fica ativo.
function getWaProvider() {
  const p = DB.getObj('wa_provider', 'zapi');
  return p === 'cloud' ? 'cloud' : 'zapi';
}
function setWaProvider(p) { DB.setObj('wa_provider', p === 'cloud' ? 'cloud' : 'zapi'); }

// Config da Cloud API (Meta). phoneNumberId + accessToken vêm do painel da Meta.
// templateLembrete/templateLang: template aprovado p/ lembrete proativo (fora 24h).
function getCloudConfig() {
  return DB.getObj('wa_cloud_config', { enabled: false, phoneNumberId: '', accessToken: '', templateLembrete: '', templateLang: 'pt_BR' });
}

// True quando o provedor ATIVO está totalmente configurado (vale p/ os dois).
function _waConnected() {
  if (getWaProvider() === 'cloud') {
    const c = getCloudConfig();
    return !!(c.enabled && c.phoneNumberId && c.accessToken);
  }
  const z = getZapiConfig();
  return !!(z.enabled && z.instanceId && z.token);
}

// ====================== 🎼 SISTEMA DE MAESTRIA (GAMIFICAÇÃO) ======================

const ACHIEVEMENTS = [
  { id: 'primeiro_compasso',   icon: '🎵', nome: 'Primeiro Compasso',    desc: 'Cadastrou o primeiro paciente' },
  { id: 'ritmo_financeiro',    icon: '📊', nome: 'Ritmo Financeiro',     desc: 'Definiu uma meta de faturamento' },
  { id: 'harmonia_digital',    icon: '💬', nome: 'Harmonia Digital',     desc: 'Conectou o WhatsApp via Z-API' },
  { id: 'melodia_recorrente',  icon: '🔁', nome: 'Melodia Recorrente',   desc: 'Inscreveu o primeiro paciente em um programa' },
  { id: 'batuta_de_ouro',      icon: '🎯', nome: 'Batuta de Ouro',       desc: 'Atingiu 100% da meta de faturamento em um mês' },
  { id: 'turne_domiciliar',    icon: '🏠', nome: 'Tournée Domiciliar',   desc: 'Registrou 5 visitas domiciliares' },
  { id: 'orquestra_completa',  icon: '⭐', nome: 'Orquestra Completa',   desc: 'Usou todas as 8 seções do sistema' },
  { id: 'fidelidade_de_palco', icon: '💎', nome: 'Fidelidade de Palco',  desc: '6 meses diferentes com faturamento' },
  { id: 'compositor',          icon: '🎼', nome: 'Compositor',            desc: 'Criou um template de programa próprio' },
  { id: 'estreia_estelar',     icon: '🚀', nome: 'Estreia Estelar',      desc: 'Primeiro mês com MRR acima de R$ 1.000' },
];

const NIVEIS = [
  { nivel: 1, titulo: 'Aprendiz',    icone: '🎵', min: 0  },
  { nivel: 2, titulo: 'Músico',      icone: '🎸', min: 1  },
  { nivel: 3, titulo: 'Solista',     icone: '🎻', min: 3  },
  { nivel: 4, titulo: 'Concertista', icone: '🎹', min: 5  },
  { nivel: 5, titulo: 'Sinfônico',   icone: '🎺', min: 7  },
  { nivel: 6, titulo: 'Regente',     icone: '🎼', min: 9  },
  { nivel: 7, titulo: 'Maestro',     icone: '🏆', min: 10 },
];

function getMaestriaData() {
  return DB.getObj('maestria', { desbloqueados: [] });
}

function getNivelAtual(qtdDesbloqueados) {
  let nivel = NIVEIS[0];
  for (const n of NIVEIS) { if (qtdDesbloqueados >= n.min) nivel = n; else break; }
  return nivel;
}

function getProximoNivel(nivelAtual) {
  return NIVEIS.find(n => n.nivel === nivelAtual.nivel + 1) || null;
}

// Verifica e desbloqueia conquistas automaticamente
function checkAchievements() {
  const data    = getMaestriaData();
  const already = new Set(data.desbloqueados.map(d => d.id));
  const novos   = [];

  function unlock(id) {
    if (already.has(id)) return;
    const ach = ACHIEVEMENTS.find(a => a.id === id);
    if (!ach) return;
    already.add(id);
    data.desbloqueados.push({ id, ts: new Date().toISOString() });
    novos.push(ach);
  }

  // 🎵 Primeiro Compasso
  if (DB.get('pacientes').length >= 1) unlock('primeiro_compasso');

  // 📊 Ritmo Financeiro
  const metas = DB.getObj('metas', {});
  if ((metas.fat || 0) > 0) unlock('ritmo_financeiro');

  // 💬 Harmonia Digital
  const zapiCfg = getZapiConfig();
  if (zapiCfg.enabled && zapiCfg.instanceId && zapiCfg.token) unlock('harmonia_digital');

  // 🔁 Melodia Recorrente
  if (getInscricoes().length >= 1) unlock('melodia_recorrente');

  // 🎯 Batuta de Ouro — algum mês com faturamento >= meta
  if ((metas.fat || 0) > 0) {
    const allPacs = DB.get('pacientes');
    const mesesComMeta = {};
    allPacs.forEach(p => {
      const m = getMes(p.data);
      mesesComMeta[m] = (mesesComMeta[m] || 0) + (p.valor || 0);
    });
    if (Object.values(mesesComMeta).some(fat => fat >= metas.fat)) unlock('batuta_de_ouro');
  }

  // 🏠 Tournée Domiciliar — 5+ domiciliares
  const domiciliares = DB.get('pacientes').filter(p => (p.tipo || '') === 'Domiciliar').length;
  if (domiciliares >= 5) unlock('turne_domiciliar');

  // ⭐ Orquestra Completa — dados em todas as seções
  const temAgenda   = DB.get('agendamentos').length > 0;
  const temCrm      = DB.get('crm').length > 0;
  const temDespesas = DB.get('despesas').length > 0;
  const temFollowup = DB.get('followup').length > 0;
  const temProg     = getInscricoes().length > 0;
  const temPacs     = DB.get('pacientes').length > 0;
  if (temAgenda && temCrm && temDespesas && temFollowup && temProg && temPacs) unlock('orquestra_completa');

  // 💎 Fidelidade de Palco — 6 meses com faturamento
  const mesesFat = new Set(DB.get('pacientes').filter(p => p.valor > 0).map(p => getMes(p.data)));
  if (mesesFat.size >= 6) unlock('fidelidade_de_palco');

  // 🎼 Compositor — criou template próprio (não é dos seeds originais)
  const seedIds = ['pg_compagni','pg_attento_semestral','pg_attento_anual','pg_confidenza',
    'pg_confidenza_mensal','pg_mentore','pg_posop','pg_hipertensao','pg_diabetes','pg_avc'];
  const progProprios = getProgramas().filter(p => !seedIds.includes(p.id));
  if (progProprios.length >= 1) unlock('compositor');

  // 🚀 Estreia Estelar — MRR > R$ 1.000
  const inscAtivas = getInscricoes().filter(i => i.status === 'Ativo');
  let mrrTotal = 0;
  inscAtivas.forEach(i => {
    const prog = getProgramas().find(p => p.id === i.programaId);
    mrrTotal += _mrrDeInscricao(i, prog);
  });
  if (mrrTotal >= 1000) unlock('estreia_estelar');

  // Persiste e notifica
  if (novos.length) {
    DB.setObj('maestria', data);
    _atualizarSidebarMaestria();
    // Exibe toast das novas conquistas (uma por vez, com delay)
    novos.forEach((ach, i) => {
      setTimeout(() => _toastConquista(ach), i * 2200);
    });
  }
}

// Toasts de conquista ATIVOS na tela agora — várias podem desbloquear juntas
// (ex.: ao carregar dados de demonstração) e, sem empilhar, caíam todas na
// MESMA posição e ficavam ilegíveis, sobrepostas.
let _toastsConquistaAtivos = [];

function _toastConquista(ach) {
  const el = document.createElement('div');
  // No celular, bottom-right cobria o conteúdo (calendário, tabelas) e a
  // barra de navegação. Ali o toast some rápido, no topo, fora do caminho.
  const mob = _isMobileViewport();
  const offset = _toastsConquistaAtivos.length * (mob ? 52 : 76); // altura do toast anterior + respiro
  el.style.cssText = mob
    ? `position:fixed;top:${58 + offset}px;left:10px;right:10px;z-index:9999;background:#0f172a;color:#fff;
       border-radius:10px;padding:9px 12px;display:flex;align-items:center;gap:9px;
       box-shadow:0 6px 20px rgba(0,0,0,0.3);animation:slideInRight 0.3s ease;transition:opacity 0.5s;`
    : `position:fixed;bottom:${80 + offset}px;right:24px;z-index:9999;background:#0f172a;color:#fff;
       border-radius:12px;padding:14px 18px;display:flex;align-items:center;gap:12px;
       box-shadow:0 8px 30px rgba(0,0,0,0.25);max-width:320px;animation:slideInRight 0.4s ease;transition:opacity 0.5s;`;
  el.innerHTML = mob
    ? `<span style="font-size:20px;line-height:1;flex-shrink:0;">${ach.icon}</span>
       <div style="min-width:0;">
         <div style="font-size:9px;font-weight:700;color:#10b981;text-transform:uppercase;letter-spacing:0.06em;">🎼 Conquista</div>
         <div style="font-size:12px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${_esc(ach.nome)}</div>
       </div>`
    : `<span style="font-size:28px;line-height:1;">${ach.icon}</span>
       <div>
         <div style="font-size:10px;font-weight:700;color:#10b981;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:2px;">🎼 Conquista desbloqueada!</div>
         <div style="font-size:13.5px;font-weight:700;">${_esc(ach.nome)}</div>
         <div style="font-size:11.5px;color:#94a3b8;margin-top:1px;">${_esc(ach.desc)}</div>
       </div>`;
  document.body.appendChild(el);
  _toastsConquistaAtivos.push(el);
  const dur = mob ? 2000 : 3500;
  setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => {
      el.remove();
      _toastsConquistaAtivos = _toastsConquistaAtivos.filter(x => x !== el);
    }, 600);
  }, dur);
}

function _atualizarSidebarMaestria() {
  const data = getMaestriaData();
  const qtd  = data.desbloqueados.length;
  const nivel = getNivelAtual(qtd);
  const prox  = getProximoNivel(nivel);

  const el = document.getElementById('sidebar-maestria');
  if (!el) return;

  const pctBar = prox ? Math.round(((qtd - nivel.min) / (prox.min - nivel.min)) * 100) : 100;
  el.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:5px;">
      <span style="font-size:10.5px;font-weight:700;color:#a5b4cb;letter-spacing:0.06em;">
        ${nivel.icone} ${nivel.titulo.toUpperCase()}
      </span>
      <span style="font-size:10px;color:#94a3b8;font-weight:600;">${qtd}/${ACHIEVEMENTS.length}</span>
    </div>
    <div style="height:4px;background:#1e293b;border-radius:999px;overflow:hidden;">
      <div style="height:100%;width:${pctBar}%;background:linear-gradient(90deg,#10b981,#34d399);border-radius:999px;transition:width 0.6s ease;box-shadow:0 0 6px rgba(16,185,129,0.4);"></div>
    </div>`;
}

// ====================== CONFIGURAÇÕES DO CONSULTÓRIO ======================
function getClinicaConfig() {
  return DB.getObj('clinica_config', {
    nome: '', especialidade: '', nomeClinica: '', cidade: '', crm: '', cor: '#10b981'
  });
}

function saveClinicaConfig() {
  const cfg = {
    nome:         (document.getElementById('clinica-nome')?.value || '').trim(),
    especialidade:(document.getElementById('clinica-especialidade')?.value || '').trim(),
    nomeClinica:  (document.getElementById('clinica-nome-clinica')?.value || '').trim(),
    cidade:       (document.getElementById('clinica-cidade')?.value || '').trim(),
    crm:          (document.getElementById('clinica-crm')?.value || '').trim(),
    cor:           document.getElementById('clinica-cor')?.value || '#10b981',
  };
  DB.setObj('clinica_config', cfg);
  applyClinicaConfig(cfg);
  toast('✅ Configurações salvas!');
  _auditLog('configurou', 'clinica', `Atualizou configurações do consultório`);
}

function applyClinicaConfig(cfg) {
  if (!cfg) cfg = getClinicaConfig();
  const nomeMed   = cfg.nome || currentNome || '';
  const esp       = cfg.especialidade || '';
  const nomeClini = cfg.nomeClinica || (nomeMed ? `Consultório ${nomeMed}` : 'Consultório');
  const cor       = cfg.cor || '#10b981';

  // Sidebar
  const hNome = document.getElementById('sidebar-header-nome');
  const hEsp  = document.getElementById('sidebar-header-esp');
  if (hNome && nomeMed) hNome.textContent = currentRole === 'medico' ? _comTituloMedico(nomeMed) : nomeMed;
  if (hEsp  && esp)     hEsp.textContent  = esp;

  // Dashboard subtítulo
  const subEl = document.getElementById('dash-subtitulo');
  const parts = [nomeClini, esp].filter(Boolean);
  if (subEl && parts.length) subEl.textContent = parts.join(' · ') + ' · ' + _mesAtualLabel();

  // Login page
  const loginNomeEl = document.querySelector('#login-page [style*="font-size:18px"]');
  if (loginNomeEl && nomeClini) loginNomeEl.textContent = nomeClini;
  const loginSubEl  = document.querySelector('#login-page [style*="font-size:12.5px"][style*="color:#9ca3af"]');
  if (loginSubEl && esp) loginSubEl.textContent = esp;

  // Cor de destaque (variável CSS) — aplica nas bordas esquerda dos KPIs principais
  document.documentElement.style.setProperty('--accent', cor);
}

function _mesAtualLabel() {
  return new Date().toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
}

function renderConfiguracoes() {
  // Onboarding guiado + profissionais da clínica
  renderOnboardingClinica();
  renderProfissionais();
  // Clinica config
  const clinica = getClinicaConfig();
  const fields = { 'clinica-nome': clinica.nome, 'clinica-especialidade': clinica.especialidade,
    'clinica-nome-clinica': clinica.nomeClinica, 'clinica-cidade': clinica.cidade,
    'clinica-crm': clinica.crm };
  Object.entries(fields).forEach(([id, val]) => {
    const el = document.getElementById(id);
    if (el) el.value = val || '';
  });
  const corEl = document.getElementById('clinica-cor');
  if (corEl) corEl.value = clinica.cor || '#10b981';

  // Z-API config
  const cfg = getZapiConfig();
  const toggle = document.getElementById('zapi-enabled-toggle');
  if (toggle) toggle.checked = cfg.enabled;
  const idEl = document.getElementById('zapi-instance-id');
  if (idEl) idEl.value = cfg.instanceId || '';
  const tokenEl = document.getElementById('zapi-token');
  if (tokenEl) tokenEl.value = cfg.token || '';
  const ctEl = document.getElementById('zapi-client-token');
  if (ctEl) ctEl.value = cfg.clientToken || '';
  _applyZapiUI(cfg.enabled, !!(cfg.instanceId && cfg.token));
  // Monta a URL pronta do webhook (com o user_id do dono dos dados embutido)
  const waEl = document.getElementById('wa-webhook-url');
  if (waEl) {
    const owner = currentDataOwner || (currentUser && currentUser.id);
    waEl.textContent = owner
      ? `${SUPA_URL}/functions/v1/wa-webhook?owner=${owner}`
      : '— (entre na sua conta para gerar)';
  }
  _montarWebhookProfUI(); // número por profissional (clínica)

  // WhatsApp Cloud API (Meta) — carrega campos e estado do toggle
  const cloudCfg = getCloudConfig();
  const cloudTog = document.getElementById('cloud-enabled-toggle');
  const cloudOn  = getWaProvider() === 'cloud' && cloudCfg.enabled;
  if (cloudTog) cloudTog.checked = cloudOn;
  const cpid = document.getElementById('cloud-phone-id'); if (cpid) cpid.value = cloudCfg.phoneNumberId    || '';
  const ctok = document.getElementById('cloud-token');    if (ctok) ctok.value = cloudCfg.accessToken      || '';
  const ctpl = document.getElementById('cloud-template'); if (ctpl) ctpl.value = cloudCfg.templateLembrete || '';
  _applyCloudUI(cloudOn, !!(cloudCfg.phoneNumberId && cloudCfg.accessToken));
  const cwh = document.getElementById('cloud-webhook-url');
  if (cwh) {
    const ownerC = currentDataOwner || (currentUser && currentUser.id);
    cwh.textContent = ownerC ? `${SUPA_URL}/functions/v1/wa-webhook?owner=${ownerC}` : '—';
  }

  // Secretária por IA — carrega campos e estado
  const iaCfg = getIaConfig();
  const iaTog = document.getElementById('ia-enabled-toggle');
  if (iaTog) iaTog.checked = !!iaCfg.enabled;
  const iaNome= document.getElementById('ia-nome');          if (iaNome) iaNome.value = iaCfg.nomeAssistente || '';
  const iaApr = document.getElementById('ia-apresentar');    if (iaApr) iaApr.checked = iaCfg.apresentarComoIA !== false;
  const iaTom = document.getElementById('ia-tom');           if (iaTom) iaTom.value = iaCfg.tom || '';
  const iaEnd = document.getElementById('ia-endereco');      if (iaEnd) iaEnd.value = iaCfg.endereco || '';
  const iaConv= document.getElementById('ia-convenios');     if (iaConv) iaConv.value = iaCfg.convenios || '';
  const iaPag = document.getElementById('ia-pagamentos');    if (iaPag) iaPag.value = iaCfg.pagamentos || '';
  const iaIns = document.getElementById('ia-instrucoes');    if (iaIns) iaIns.value = iaCfg.instrucoes || '';
  const iaNao = document.getElementById('ia-nao-responder'); if (iaNao) iaNao.value = iaCfg.naoResponder || '';
  const iaAuto= document.getElementById('ia-auto-sugerir');  if (iaAuto) iaAuto.checked = iaCfg.autoSugerir !== false;
  const iaAut = document.getElementById('ia-autonomo');      if (iaAut) iaAut.checked = !!iaCfg.autonomo;
  const iaAg  = document.getElementById('ia-agendar');       if (iaAg)  iaAg.checked = !!iaCfg.agendar;
  const iaAgM = document.getElementById('ia-agendar-modo');  if (iaAgM) iaAgM.value = iaCfg.agendarModo || 'pendente';
  // Motor de IA
  const llmCfg = getLlmConfig();
  const iaProv = document.getElementById('ia-llm-provider'); if (iaProv) iaProv.value = llmCfg.provider || 'groq';
  const iaCK   = document.getElementById('ia-claude-key');   if (iaCK) iaCK.value = llmCfg.claudeKey || '';
  const iaORK  = document.getElementById('ia-openrouter-key');   if (iaORK) iaORK.value = llmCfg.openrouterKey || '';
  const iaORM  = document.getElementById('ia-openrouter-model'); if (iaORM) iaORM.value = llmCfg.openrouterModel || '';
  const iaCU   = document.getElementById('ia-custom-url');   if (iaCU) iaCU.value = llmCfg.customUrl || '';
  const iaCK2  = document.getElementById('ia-custom-key');   if (iaCK2) iaCK2.value = llmCfg.customKey || '';
  const iaCM   = document.getElementById('ia-custom-model'); if (iaCM) iaCM.value = llmCfg.customModel || '';
  _iaProviderChange(llmCfg.provider || 'groq');
  _applyIaUI(!!iaCfg.enabled);

  // Galeria de conquistas
  renderConquistas();

  // Card de equipe (multi-usuário)
  renderEquipeCard();

  // Card 2FA
  render2FACard();

  // Histórico de alterações
  renderAuditLog();

  // Lembretes WhatsApp
  renderLembretesCard();

  // Sincroniza estado dos botões de tema com a preferência atual
  _atualizarBotoesTema(document.body.classList.contains('dark'));

  // Destaca o modo de uso ativo
  _aplicarModoUI();
}

// ====================== UI: 2FA ======================
let _mfa_pending_factor_id = null;
let _mfa_pending_resolve   = null;

async function render2FACard() {
  const status = document.getElementById('2fa-status');
  const action = document.getElementById('2fa-action');
  if (!status || !action) return;
  const fatores = await mfaListarFatores();
  if (!fatores || fatores.error) {
    status.textContent = 'Não disponível no momento';
    action.innerHTML = '';
    return;
  }
  const ativos = (fatores.totp || []).filter(f => f.status === 'verified');
  if (ativos.length > 0) {
    status.innerHTML = `<span style="color:#10b981;font-weight:600;">✓ Ativo</span> · ${ativos.length} dispositivo${ativos.length > 1 ? 's' : ''} autenticado${ativos.length > 1 ? 's' : ''}`;
    action.innerHTML = `<button onclick="desativar2FA('${ativos[0].id}')" class="btn-ghost" style="font-size:12px;color:#dc2626;">Desativar</button>`;
  } else {
    status.innerHTML = `<span style="color:#94a3b8;">Inativo</span> · proteja sua conta com um app autenticador`;
    action.innerHTML = `<button onclick="iniciar2FA()" class="btn-primary" style="background:#d97706;">🔐 Ativar 2FA</button>`;
  }
}

async function iniciar2FA() {
  const result = await mfaCadastrar();
  if (result.error) {
    alert('Erro: ' + result.error);
    return;
  }
  _mfa_pending_factor_id = result.factorId;
  document.getElementById('2fa-qrcode').src = result.qrCode;
  document.getElementById('2fa-secret').textContent = result.secret;
  document.getElementById('2fa-code-input').value = '';
  document.getElementById('2fa-error').style.display = 'none';
  openModal('modal-2fa-setup');
}

async function confirmar2FA() {
  const code = (document.getElementById('2fa-code-input').value || '').replace(/\D/g, '');
  const errEl = document.getElementById('2fa-error');
  const btn = document.getElementById('btn-confirmar-2fa');
  if (code.length !== 6) {
    errEl.textContent = 'Digite os 6 dígitos.';
    errEl.style.display = '';
    return;
  }
  btn.textContent = 'Verificando…'; btn.disabled = true;
  const result = await mfaVerificarPrimeiroCodigo(_mfa_pending_factor_id, code);
  btn.textContent = 'Ativar 2FA'; btn.disabled = false;
  if (result.error) {
    errEl.textContent = 'Código incorreto: ' + result.error;
    errEl.style.display = '';
    return;
  }
  closeModal('modal-2fa-setup');
  toast('🔐 2FA ativado com sucesso!');
  render2FACard();
}

async function desativar2FA(factorId) {
  if (!confirm('Desativar autenticação em 2 fatores?\n\nSua conta ficará protegida apenas pela senha.')) return;
  const result = await mfaDesativar(factorId);
  if (result.error) { alert('Erro: ' + result.error); return; }
  toast('2FA desativado.');
  render2FACard();
}

async function confirmar2FAChallenge() {
  const code = (document.getElementById('2fa-challenge-input').value || '').replace(/\D/g, '');
  const errEl = document.getElementById('2fa-challenge-error');
  if (code.length !== 6) {
    errEl.textContent = 'Digite os 6 dígitos.';
    errEl.style.display = '';
    return;
  }
  const result = await mfaVerificarSeNecessario(code);
  if (result.error || result.needsCode) {
    errEl.textContent = result.error || 'Código incorreto.';
    errEl.style.display = '';
    document.getElementById('2fa-challenge-input').value = '';
    return;
  }
  closeModal('modal-2fa-challenge');
  if (_mfa_pending_resolve) { _mfa_pending_resolve(true); _mfa_pending_resolve = null; }
}

function cancelar2FAChallenge() {
  closeModal('modal-2fa-challenge');
  if (_mfa_pending_resolve) { _mfa_pending_resolve(false); _mfa_pending_resolve = null; }
  // logout pra não deixar sessão pendurada com aal1
  if (_supa) _supa.auth.signOut().catch(()=>{});
}

// Promete que o usuário completou 2FA — chamado no login se necessário
function pedir2FACodigo() {
  return new Promise(resolve => {
    _mfa_pending_resolve = resolve;
    document.getElementById('2fa-challenge-input').value = '';
    document.getElementById('2fa-challenge-error').style.display = 'none';
    openModal('modal-2fa-challenge');
    setTimeout(() => document.getElementById('2fa-challenge-input')?.focus(), 200);
  });
}

// ====================== UI: EQUIPE ======================
function openModalConvite() {
  document.getElementById('convite-email').value = '';
  document.getElementById('convite-role').value = 'secretaria';
  document.getElementById('convite-form-wrap').style.display = '';
  document.getElementById('convite-link-wrap').style.display = 'none';
  _conviteRoleChange(); // esconde o seletor de profissional (role padrão = secretária)
  openModal('modal-convite');
}

// Mostra/esconde o seletor de profissional conforme a função escolhida
function _conviteRoleChange() {
  const role = document.getElementById('convite-role')?.value;
  const wrap = document.getElementById('convite-prof-wrap');
  const sel  = document.getElementById('convite-profissional');
  if (!wrap || !sel) return;
  if (role === 'profissional') {
    const profs = getProfissionaisAtivos();
    sel.innerHTML = profs.length
      ? profs.map(p => `<option value="${p.id}">${_esc(p.nome)}</option>`).join('')
      : '<option value="">(cadastre um profissional em Configurações)</option>';
    wrap.style.display = '';
  } else {
    wrap.style.display = 'none';
  }
}

async function gerarConvite() {
  const email = (document.getElementById('convite-email').value || '').trim();
  const role  = document.getElementById('convite-role').value;
  if (!email) { alert('Informe o e-mail.'); return; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { alert('E-mail inválido.'); return; }
  let profissionalId = null;
  if (role === 'profissional') {
    profissionalId = document.getElementById('convite-profissional')?.value || '';
    if (!profissionalId) { alert('Selecione qual profissional (ou cadastre um em Configurações).'); return; }
  }
  const result = await criarConvite(email, role, profissionalId);
  if (result.error) { alert('Erro: ' + result.error + '\n\n(Se falar de "profissional_id", rode o SQL SETUP_EQUIPE_PROFISSIONAL.sql no Supabase primeiro.)'); return; }
  localStorage.setItem('consult_onboard_convidou', '1'); // marca passo do onboarding
  // Mostra o link gerado
  document.getElementById('convite-form-wrap').style.display = 'none';
  document.getElementById('convite-link-wrap').style.display = '';
  document.getElementById('convite-link-text').textContent = result.link;
  // Botão WhatsApp
  const wa = document.getElementById('btn-convite-wa');
  if (wa) {
    const papel = role === 'medico' ? 'médico(a)' : role === 'profissional' ? 'profissional' : 'secretária';
    const msg = `Olá! Você foi convidado(a) para acessar o sistema do consultório como ${papel}. Acesse o link para entrar: ${result.link}`;
    wa.onclick = () => window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, '_blank');
  }
}

async function renderEquipeCard() {
  const subtitleEl = document.getElementById('equipe-subtitle');
  const btnEl      = document.getElementById('btn-novo-convite');
  const membrosEl  = document.getElementById('equipe-membros');
  const convitesEl = document.getElementById('equipe-convites');
  if (!subtitleEl || !membrosEl || !convitesEl) return;

  // Caso 1: usuário é membro (não dono)
  if (currentTeamRole === 'member') {
    if (btnEl) btnEl.style.display = 'none';
    // Busca o nome do dono
    try {
      const { data: ownerProfile } = await _supa.from('profiles').select('nome').eq('id', currentDataOwner).single();
      const nomeDono = ownerProfile?.nome || 'o titular';
      subtitleEl.innerHTML = `Você é <strong>${_papelLabel(currentRole)}</strong> na equipe de <strong>${_esc(nomeDono)}</strong>`;
    } catch(e) {
      subtitleEl.textContent = 'Você é membro de uma equipe compartilhada';
    }
    membrosEl.innerHTML = '';
    convitesEl.innerHTML = `
      <div style="padding:14px 16px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;font-size:12.5px;color:#1d4ed8;">
        ℹ️ Você está acessando dados compartilhados. Para sair da equipe, peça ao titular para te remover.
      </div>`;
    return;
  }

  // Caso 2: usuário é dono — mostra membros + convites
  if (btnEl) btnEl.style.display = '';
  const membros  = await listarMembros();
  const convites = await listarConvites();
  const pendentes = convites.filter(c => !c.accepted_at);

  if (!membros.length && !pendentes.length) {
    subtitleEl.textContent = 'Compartilhe o consultório com sua secretária ou outro médico';
    membrosEl.innerHTML = `
      <div style="text-align:center;padding:28px 16px;color:#94a3b8;font-size:13px;">
        Você ainda não compartilhou seu consultório. Convide a primeira pessoa! 👆
      </div>`;
    convitesEl.innerHTML = '';
    return;
  }

  subtitleEl.textContent = `${membros.length} ${membros.length === 1 ? 'membro' : 'membros'} ativos${pendentes.length ? ' · '+pendentes.length+' convite(s) pendente(s)' : ''}`;

  // Membros ativos
  membrosEl.innerHTML = membros.length ? `
    <div style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;">Membros ativos</div>
    <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:16px;">
      ${membros.map(m => `
        <div style="display:flex;align-items:center;gap:12px;padding:10px 14px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;">
          <div style="width:32px;height:32px;background:#dbeafe;color:#1d4ed8;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;flex-shrink:0;">${_esc((m.nome[0] || '?').toUpperCase())}</div>
          <div style="flex:1;min-width:0;">
            <div style="font-size:13px;font-weight:600;color:#0f172a;">${_esc(m.nome)}</div>
            <div style="font-size:11.5px;color:#64748b;">${m.role === 'medico' ? '🩺 Médico(a)' : '📋 Secretária'} · desde ${new Date(m.created_at).toLocaleDateString('pt-BR')}</div>
          </div>
          <button onclick="_handleRemoverMembro('${m.member_id}')" class="btn-ghost" style="font-size:11.5px;color:#dc2626;padding:5px 10px;">Remover</button>
        </div>`).join('')}
    </div>` : '';

  // Convites pendentes
  convitesEl.innerHTML = pendentes.length ? `
    <div style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;">Convites pendentes</div>
    <div style="display:flex;flex-direction:column;gap:6px;">
      ${pendentes.map(c => {
        const link = `${location.origin}${location.pathname}?invite=${c.token}`;
        const expira = new Date(c.expires_at).toLocaleDateString('pt-BR');
        return `
          <div style="display:flex;align-items:center;gap:12px;padding:10px 14px;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;">
            <div style="font-size:18px;">⏳</div>
            <div style="flex:1;min-width:0;">
              <div style="font-size:13px;font-weight:600;color:#0f172a;">${_esc(c.email)}</div>
              <div style="font-size:11.5px;color:#92400e;">${c.role === 'medico' ? 'Médico(a)' : 'Secretária'} · expira em ${expira}</div>
            </div>
            <button onclick="_copyLinkConvite('${link}')" class="btn-ghost" style="font-size:11.5px;padding:5px 10px;">📋 Copiar link</button>
            <button onclick="_handleCancelarConvite('${c.id}')" class="btn-ghost" style="font-size:11.5px;color:#dc2626;padding:5px 10px;">×</button>
          </div>`;
      }).join('')}
    </div>` : '';
}

async function _handleRemoverMembro(memberId) {
  const result = await removerMembro(memberId);
  if (result.error) { alert('Erro: ' + result.error); return; }
  if (result.cancelled) return;
  toast('Membro removido');
  renderEquipeCard();
}

async function _handleCancelarConvite(inviteId) {
  if (!confirm('Cancelar este convite? O link enviado não funcionará mais.')) return;
  await cancelarConvite(inviteId);
  toast('Convite cancelado');
  renderEquipeCard();
}

function renderConquistas() {
  const data  = getMaestriaData();
  const desbSet = new Set(data.desbloqueados.map(d => d.id));
  const qtd   = desbSet.size;
  const total = ACHIEVEMENTS.length;
  const nivel = getNivelAtual(qtd);
  const prox  = getProximoNivel(nivel);

  // Badge nível
  const badge = document.getElementById('maestria-nivel-badge');
  if (badge) badge.textContent = `${nivel.icone} ${nivel.titulo}`;

  // Barra geral
  const pct = Math.round((qtd / total) * 100);
  const bar = document.getElementById('maestria-bar');
  const lbl = document.getElementById('maestria-progresso-label');
  const pctEl= document.getElementById('maestria-pct');
  if (bar)   bar.style.width = pct + '%';
  if (lbl)   lbl.textContent = `${qtd} de ${total} conquistas desbloqueadas`;
  if (pctEl) pctEl.textContent = pct + '%';

  // Grade de badges
  const grid = document.getElementById('conquistas-grid');
  if (!grid) return;
  grid.innerHTML = ACHIEVEMENTS.map(ach => {
    const desbloqueado = desbSet.has(ach.id);
    const ts = data.desbloqueados.find(d => d.id === ach.id)?.ts;
    const dataLabel = ts ? new Date(ts).toLocaleDateString('pt-BR') : '';
    return `
    <div title="${_esc(ach.desc)}${dataLabel ? ' · ' + dataLabel : ''}"
      style="display:flex;flex-direction:column;align-items:center;gap:6px;padding:14px 8px;
        background:${desbloqueado ? '#f0fdf4' : '#f8fafc'};
        border:1.5px solid ${desbloqueado ? '#bbf7d0' : '#e2e8f0'};
        border-radius:10px;text-align:center;transition:all 0.2s;cursor:default;
        ${desbloqueado ? '' : 'opacity:0.45;filter:grayscale(1);'}">
      <span style="font-size:28px;line-height:1;">${ach.icon}</span>
      <div style="font-size:10.5px;font-weight:700;color:${desbloqueado ? '#065f46' : '#94a3b8'};line-height:1.2;">${_esc(ach.nome)}</div>
      ${desbloqueado && dataLabel ? `<div style="font-size:9.5px;color:#94a3b8;">${dataLabel}</div>` : ''}
    </div>`;
  }).join('');

  // Próximo nível
  if (prox) {
    const faltam = prox.min - qtd;
    grid.insertAdjacentHTML('afterend', `
      <div style="margin-top:14px;padding:10px 14px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;font-size:12px;color:#1d4ed8;text-align:center;">
        ${prox.icone} Faltam <strong>${faltam} conquista${faltam !== 1 ? 's' : ''}</strong> para chegar ao nível <strong>${prox.titulo}</strong>
      </div>`);
  } else {
    grid.insertAdjacentHTML('afterend', `
      <div style="margin-top:14px;padding:10px 14px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;font-size:12px;color:#166534;text-align:center;">
        🏆 Parabéns! Você atingiu o nível máximo — <strong>Maestro</strong>!
      </div>`);
  }
}

// Copia a URL pronta do webhook do WhatsApp pro clipboard
function _copyWebhookUrl() {
  const owner = currentDataOwner || (currentUser && currentUser.id);
  if (!owner) { alert('Entre na sua conta primeiro.'); return; }
  const url = `${SUPA_URL}/functions/v1/wa-webhook?owner=${owner}`;
  navigator.clipboard.writeText(url).then(() => {
    if (typeof toast === 'function') toast('✅ Link copiado! Cole no webhook do Z-API.');
  }).catch(() => alert('Copie manualmente:\n' + url));
}

// ── Número por profissional (Tijolo 4B) ──
function _montarWebhookProfUI() {
  const block = document.getElementById('wa-prof-block');
  const sel   = document.getElementById('wa-prof-select');
  if (!block || !sel) return;
  const profs = getProfissionaisAtivos();
  // Só mostra se houver 2+ profissionais (clínica)
  block.style.display = profs.length > 1 ? '' : 'none';
  if (profs.length > 1) {
    sel.innerHTML = profs.map(p => `<option value="${p.id}">${_esc(p.nome)}</option>`).join('');
    _renderWebhookProf();
  }
}
function _webhookUrlProf() {
  const owner = currentDataOwner || (currentUser && currentUser.id);
  const pid   = document.getElementById('wa-prof-select')?.value;
  if (!owner || !pid) return '';
  return `${SUPA_URL}/functions/v1/wa-webhook?owner=${owner}&prof=${pid}`;
}
function _renderWebhookProf() {
  const el = document.getElementById('wa-prof-url');
  if (el) el.textContent = _webhookUrlProf() || '—';
}
function _copyWebhookUrlProf() {
  const url = _webhookUrlProf();
  if (!url) { alert('Selecione um profissional.'); return; }
  navigator.clipboard.writeText(url).then(() => {
    if (typeof toast === 'function') toast('✅ Link do profissional copiado!');
  }).catch(() => alert('Copie manualmente:\n' + url));
}

function _zapiToggleChange(enabled) {
  const cfg = getZapiConfig();
  cfg.enabled = enabled;
  DB.setObj('zapi_config', cfg);
  if (enabled) {
    setWaProvider('zapi');
    // Provedor único ativo: desliga a Cloud API se estava ligada.
    const c = getCloudConfig();
    if (c.enabled) { c.enabled = false; DB.setObj('wa_cloud_config', c); }
    const ct = document.getElementById('cloud-enabled-toggle'); if (ct) ct.checked = false;
    _applyCloudUI(false, !!(c.phoneNumberId && c.accessToken));
  }
  _applyZapiUI(enabled, !!(cfg.instanceId && cfg.token));
}

// ── Handlers da WhatsApp Cloud API (Meta) — espelham os do Z-API ──
function _cloudToggleChange(enabled) {
  const cfg = getCloudConfig();
  cfg.enabled = enabled;
  DB.setObj('wa_cloud_config', cfg);
  if (enabled) {
    setWaProvider('cloud');
    // Provedor único ativo: desliga o Z-API se estava ligado.
    const z = getZapiConfig();
    if (z.enabled) { z.enabled = false; DB.setObj('zapi_config', z); }
    const zt = document.getElementById('zapi-enabled-toggle'); if (zt) zt.checked = false;
    _applyZapiUI(false, !!(z.instanceId && z.token));
  } else {
    setWaProvider('zapi');
  }
  _applyCloudUI(enabled, !!(cfg.phoneNumberId && cfg.accessToken));
}

function _applyCloudUI(enabled, hasCredentials) {
  const label  = document.getElementById('cloud-toggle-label');
  const track  = document.getElementById('cloud-track');
  const thumb  = document.getElementById('cloud-thumb');
  const fields = document.getElementById('cloud-fields');
  if (label)  label.textContent = enabled ? 'Ativado' : 'Desativado';
  if (track)  track.classList.toggle('on', enabled);
  if (thumb)  thumb.classList.toggle('on', enabled);
  if (fields) fields.style.display = enabled ? '' : 'none';
}

function saveCloudConfig() {
  const phoneId  = (document.getElementById('cloud-phone-id')?.value || '').trim();
  const token    = (document.getElementById('cloud-token')?.value    || '').trim();
  const template = (document.getElementById('cloud-template')?.value  || '').trim();
  const statusEl = document.getElementById('cloud-status');
  if (!phoneId || !token) {
    if (statusEl) { statusEl.textContent = '⚠️ Preencha Phone Number ID e Access Token'; statusEl.style.color = '#f59e0b'; }
    return;
  }
  const cfg = getCloudConfig();
  cfg.phoneNumberId    = phoneId;
  cfg.accessToken      = token;
  cfg.templateLembrete = template;
  DB.setObj('wa_cloud_config', cfg);
  if (statusEl) { statusEl.textContent = '✅ Salvo!'; statusEl.style.color = '#10b981'; }
  _applyCloudUI(cfg.enabled, true);
  setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 4000);
}

async function testCloudConnection() {
  const cfg = getCloudConfig();
  const statusEl = document.getElementById('cloud-status');
  if (!cfg.phoneNumberId || !cfg.accessToken) {
    if (statusEl) { statusEl.textContent = '⚠️ Salve as credenciais primeiro'; statusEl.style.color = '#f59e0b'; }
    return;
  }
  if (statusEl) { statusEl.textContent = '⏳ Testando…'; statusEl.style.color = '#64748b'; }
  try {
    // GET no número: valida o token e retorna o número verificado.
    const res = await fetch(`https://graph.facebook.com/v21.0/${cfg.phoneNumberId}?fields=display_phone_number,verified_name`, {
      headers: { 'Authorization': 'Bearer ' + cfg.accessToken }
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.id) {
      if (statusEl) { statusEl.textContent = '✅ Conectado! ' + (data.display_phone_number || ''); statusEl.style.color = '#10b981'; }
    } else {
      const err = (data.error && data.error.message) || ('HTTP ' + res.status);
      if (statusEl) { statusEl.textContent = '❌ ' + err; statusEl.style.color = '#dc2626'; }
    }
  } catch (e) {
    if (statusEl) { statusEl.textContent = '❌ ' + (e.message || 'falha de rede/CORS'); statusEl.style.color = '#dc2626'; }
  }
}

// ── Handlers da config da Secretária por IA (Configurações) ──
function _iaToggleChange(enabled) {
  const cfg = getIaConfig();
  cfg.enabled = enabled;
  DB.setObj('ia_config', cfg);
  _applyIaUI(enabled);
}

function _applyIaUI(enabled) {
  const label  = document.getElementById('ia-toggle-label');
  const track  = document.getElementById('ia-track');
  const thumb  = document.getElementById('ia-thumb');
  const fields = document.getElementById('ia-fields');
  if (label)  label.textContent = enabled ? 'Ativado' : 'Desativado';
  if (track)  track.classList.toggle('on', enabled);
  if (thumb)  thumb.classList.toggle('on', enabled);
  if (fields) fields.style.display = enabled ? '' : 'none';
}

function _iaProviderChange(provider) {
  const mostrar = (id, on) => { const el = document.getElementById(id); if (el) el.style.display = on ? '' : 'none'; };
  mostrar('ia-claude-key-wrap', provider === 'claude');
  mostrar('ia-openrouter-wrap', provider === 'openrouter');
  mostrar('ia-custom-wrap',     provider === 'custom');
}

// Lê os campos do formulário da IA num objeto ia_config (sem salvar).
// Usado pelo Playground e pelo "ver cérebro" pra refletir edições ao vivo.
function _iaFormOverrides() {
  const g = id => (document.getElementById(id)?.value || '').trim();
  const ck = id => !!document.getElementById(id)?.checked;
  return {
    nomeAssistente: g('ia-nome'),
    apresentarComoIA: ck('ia-apresentar'),
    tom: g('ia-tom'),
    endereco: g('ia-endereco'),
    convenios: g('ia-convenios'),
    pagamentos: g('ia-pagamentos'),
    instrucoes: g('ia-instrucoes'),
    naoResponder: g('ia-nao-responder'),
  };
}

function saveIaConfig() {
  const cfg = Object.assign(getIaConfig(), _iaFormOverrides());
  cfg.autoSugerir = !!document.getElementById('ia-auto-sugerir')?.checked;
  cfg.autonomo    = !!document.getElementById('ia-autonomo')?.checked;
  cfg.agendar     = !!document.getElementById('ia-agendar')?.checked;
  cfg.agendarModo = document.getElementById('ia-agendar-modo')?.value || 'pendente';
  DB.setObj('ia_config', cfg);
  // Motor de IA (Groq / Claude / OpenRouter / personalizado)
  const llm = getLlmConfig();
  llm.provider        = document.getElementById('ia-llm-provider')?.value || 'groq';
  llm.claudeKey       = (document.getElementById('ia-claude-key')?.value || '').trim();
  llm.openrouterKey   = (document.getElementById('ia-openrouter-key')?.value || '').trim();
  llm.openrouterModel = (document.getElementById('ia-openrouter-model')?.value || '').trim() || 'anthropic/claude-3.5-haiku';
  llm.customUrl       = (document.getElementById('ia-custom-url')?.value || '').trim();
  llm.customKey       = (document.getElementById('ia-custom-key')?.value || '').trim();
  llm.customModel     = (document.getElementById('ia-custom-model')?.value || '').trim();
  DB.setObj('llm_config', llm);
  const statusEl = document.getElementById('ia-status');
  if (statusEl) { statusEl.textContent = '✅ Salvo!'; statusEl.style.color = '#10b981'; setTimeout(() => { statusEl.textContent = ''; }, 4000); }
}

function _applyZapiUI(enabled, hasCredentials) {
  const label  = document.getElementById('zapi-toggle-label');
  const track  = document.getElementById('zapi-track');
  const thumb  = document.getElementById('zapi-thumb');
  const fields = document.getElementById('zapi-fields');
  const badge  = document.getElementById('zapi-connected-badge');
  const info   = document.getElementById('zapi-info-card');
  if (label)  label.textContent = enabled ? 'Ativado' : 'Desativado';
  if (track)  track.classList.toggle('on', enabled);
  if (thumb)  thumb.classList.toggle('on', enabled);
  if (fields) fields.style.display = enabled ? '' : 'none';
  if (badge)  badge.style.display  = (enabled && hasCredentials) ? '' : 'none';
  if (info)   info.style.display   = (enabled && hasCredentials) ? '' : 'none';
}

// Tolera o erro mais comum: colar a URL inteira do Z-API
// (ex.: https://api.z-api.io/instances/XXXX/token/YYYY/...) em vez de só o ID.
// Extrai o Instance ID e o Token de onde quer que tenham sido colados.
function _parseZapiCreds(instanceRaw, tokenRaw) {
  let instanceId = (instanceRaw || '').trim();
  let token      = (tokenRaw || '').trim();
  // URL completa colada no campo Instance ID (a URL é a fonte canônica do par id+token)
  const m = instanceId.match(/instances\/([^/\s?]+)(?:\/token\/([^/?\s]+))?/i);
  if (m) {
    instanceId = m[1];
    if (m[2]) token = m[2];
  }
  // URL colada também no campo Token
  const tm = token.match(/token\/([^/?\s]+)/i);
  if (tm) token = tm[1];
  return { instanceId, token };
}

function saveZapiConfig() {
  const rawInstance = (document.getElementById('zapi-instance-id')?.value   || '').trim();
  const rawToken    = (document.getElementById('zapi-token')?.value         || '').trim();
  const clientToken = (document.getElementById('zapi-client-token')?.value   || '').trim();
  const statusEl    = document.getElementById('zapi-status');
  const { instanceId, token } = _parseZapiCreds(rawInstance, rawToken);
  if (!instanceId || !token) {
    if (statusEl) { statusEl.textContent = '⚠️ Preencha Instance ID e Token'; statusEl.style.color = '#f59e0b'; }
    return;
  }
  const cfg = getZapiConfig();
  cfg.instanceId  = instanceId;
  cfg.token       = token;
  cfg.clientToken = clientToken;
  DB.setObj('zapi_config', cfg);
  // Reflete os valores limpos nos campos (caso tenham sido extraídos de uma URL)
  const idEl = document.getElementById('zapi-instance-id'); if (idEl) idEl.value = instanceId;
  const tkEl = document.getElementById('zapi-token');       if (tkEl) tkEl.value = token;
  const extraiu = (rawInstance !== instanceId);
  if (statusEl) {
    statusEl.textContent = extraiu ? '✅ Salvo! (extraí o ID e o token da URL)' : '✅ Salvo!';
    statusEl.style.color = '#10b981';
  }
  _applyZapiUI(cfg.enabled, true);
  setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 4000);
  checkAchievements();
}

async function testZapiConnection() {
  const cfg = getZapiConfig();
  const statusEl = document.getElementById('zapi-status');
  if (!cfg.instanceId || !cfg.token) {
    if (statusEl) { statusEl.textContent = '⚠️ Salve as credenciais primeiro'; statusEl.style.color = '#f59e0b'; }
    return;
  }
  if (statusEl) { statusEl.textContent = '⏳ Testando…'; statusEl.style.color = '#64748b'; }
  try {
    // Só manda Client-Token se a conta tiver token de segurança configurado
    const headers = {};
    if (cfg.clientToken) headers['Client-Token'] = cfg.clientToken;
    const res  = await fetch(`https://api.z-api.io/instances/${cfg.instanceId}/token/${cfg.token}/status`, { headers });
    const data = await res.json().catch(() => ({}));
    const ok   = data.connected || data.status === 'CONNECTED' || data.value === 'CONNECTED';
    if (ok) {
      if (statusEl) { statusEl.textContent = '✅ Conectado!'; statusEl.style.color = '#10b981'; }
      const lbl = document.getElementById('zapi-phone-label');
      if (lbl && data.phone) lbl.textContent = '· ' + data.phone;
    } else if (data.error || (typeof data.message === 'string' && /token/i.test(data.message))) {
      // Erro de credencial/segurança — geralmente falta o "token de segurança da conta"
      if (statusEl) { statusEl.textContent = '❌ ' + (data.error || data.message); statusEl.style.color = '#ef4444'; }
    } else {
      if (statusEl) { statusEl.textContent = '❌ Não conectado — abra o Z-API e leia o QR Code'; statusEl.style.color = '#ef4444'; }
    }
  } catch(e) {
    if (statusEl) { statusEl.textContent = '❌ Erro de conexão: ' + e.message; statusEl.style.color = '#ef4444'; }
  }
}

function disconnectZapi() {
  if (!confirm('Desconectar o WhatsApp? As mensagens salvas não serão apagadas.')) return;
  DB.setObj('zapi_config', { enabled: false, instanceId: '', token: '', clientToken: '' });
  renderConfiguracoes();
}

// ====================== CHAT PANEL ======================

let _chatPhone = null;
let _chatIdx   = null;
let _chatSub   = null;

function openCrmChat(ref) {
  const data = DB.get('crm');
  const idx = (typeof ref === 'string') ? data.findIndex(x => x.id === ref) : ref;
  const r = data[idx];
  if (!r) return;
  abrirChatPorTelefone(r.nome, r.whatsapp, idx);
}

// Abre o chat interno (CRM) por telefone — funciona pra contatos do CRM E
// pra pacientes/follow-ups que não estão no funil.
function abrirChatPorTelefone(nome, whatsapp, crmIdx) {
  // Normaliza pra forma local (sem DDI) — a MESMA chave que o webhook grava em
  // crm_messages. Contato salvo com +55 abria um chat vazio e as respostas do
  // paciente nunca apareciam.
  const wa = _normPhone(whatsapp);
  if (!wa) { alert('WhatsApp não cadastrado.'); return; }
  // Se não veio um índice de CRM, tenta achar um contato com esse número
  if (crmIdx === undefined || crmIdx === null) {
    const i = DB.get('crm').findIndex(c => _normPhone(c.whatsapp) === wa);
    crmIdx = i >= 0 ? i : null;
  }
  _chatPhone = wa;
  _chatIdx   = crmIdx;

  const nameEl  = document.getElementById('chat-contact-name');
  const phoneEl = document.getElementById('chat-contact-phone');
  if (nameEl)  nameEl.textContent  = nome || '—';
  if (phoneEl) phoneEl.textContent = whatsapp || wa;

  const zapiOk     = _waConnected();
  const inputArea  = document.getElementById('chat-input-area');
  const noZapiMsg  = document.getElementById('chat-no-zapi');
  const statusEl   = document.getElementById('chat-wa-status');
  if (inputArea) inputArea.style.display = zapiOk ? 'flex' : 'none';
  const iaBtn = document.getElementById('chat-ia-btn');
  if (iaBtn) iaBtn.style.display = getIaConfig().enabled ? '' : 'none';
  if (noZapiMsg) noZapiMsg.style.display = zapiOk ? 'none' : '';
  if (statusEl)  {
    statusEl.textContent = zapiOk ? '● WhatsApp' : 'sem integração';
    statusEl.style.color = zapiOk ? '#10b981' : '#94a3b8';
  }

  document.getElementById('crm-chat-panel')?.classList.add('open');
  document.getElementById('crm-chat-panel-overlay')?.classList.add('open');

  loadChatHistory(_chatPhone);
  _subscribeChatRealtime(_chatPhone);
}

// Roteia o contato pelo MELHOR canal:
//  • Z-API (CRM) ligado  → abre o chat interno (responde pelo sistema, registra a conversa)
//  • Z-API desligado     → cai pro WhatsApp externo (wa.me)
function falarComPaciente(nome, whatsapp, mensagem) {
  const wa = String(whatsapp || '').replace(/\D/g, '');
  if (!wa) { alert('WhatsApp não cadastrado para ' + (nome || 'este paciente') + '.'); return; }
  const zapiOk = _waConnected();
  if (zapiOk) {
    abrirChatPorTelefone(nome, whatsapp);
    if (mensagem) { const inp = document.getElementById('chat-input-text'); if (inp) { inp.value = mensagem; inp.focus(); } }
  } else {
    // Usa o helper único (_normPhone + DDI) — evita 5555… e não quebra números
    // de DDD 55 (Santa Maria-RS) que começam com "55" sem serem DDI.
    window.open(_waMeLink(whatsapp, mensagem), '_blank');
  }
}

// Versão que descobre o WhatsApp do paciente pelo nome (usada no perfil)
function falarComPacienteNome(nomeEnc) {
  const nome  = decodeURIComponent(nomeEnc);
  const chave = nome.toLowerCase().trim();
  const wa = (DB.get('pacientes').find(p => (p.nome||'').toLowerCase().trim()===chave && p.whatsapp)?.whatsapp)
          || (DB.get('crm').find(c => (c.nome||'').toLowerCase().trim()===chave && c.whatsapp)?.whatsapp)
          || (getAgendamentos().find(a => (a.pacienteNome||'').toLowerCase().trim()===chave && a.whatsapp)?.whatsapp)
          || (DB.get('followup').find(f => (f.nome||'').toLowerCase().trim()===chave && f.whatsapp)?.whatsapp) || '';
  falarComPaciente(nome, wa);
}

function closeCrmChat() {
  document.getElementById('crm-chat-panel')?.classList.remove('open');
  document.getElementById('crm-chat-panel-overlay')?.classList.remove('open');
  _chatPhone = null;
  _chatIdx   = null;
  if (_chatSub && _supa) { _supa.removeChannel(_chatSub); _chatSub = null; }
}

async function loadChatHistory(phone) {
  const container = document.getElementById('chat-messages');
  if (!container) return;
  container.innerHTML = '<div style="text-align:center;color:#94a3b8;font-size:12px;padding:24px;">Carregando…</div>';
  if (!_supa) {
    container.innerHTML = '<div style="text-align:center;color:#94a3b8;font-size:12.5px;padding:32px;">Sem conexão com o servidor</div>';
    return;
  }
  try {
    if (!currentUser) { container.innerHTML = '<div style="text-align:center;color:#94a3b8;font-size:12.5px;padding:32px;">Sem sessão</div>'; return; }
    const owner = currentDataOwner || currentUser.id;
    const { data, error } = await _supa
      .from('crm_messages')
      .select('*')
      .eq('user_id', owner)
      .eq('whatsapp', phone)
      .order('created_at', { ascending: true })
      .limit(100);
    if (error) throw error;
    if (!data || data.length === 0) {
      // Fallback p/ contatos antigos: a 1ª mensagem ficava só no obs do card
      const c = (_chatIdx != null) ? DB.get('crm')[_chatIdx] : null;
      const m = c && c.obs && c.obs.match(/^Primeira msg:\s*([\s\S]+)/);
      if (m && m[1].trim()) {
        _renderChatMessages(container, [{
          remetente: 'contato', mensagem: m[1].trim(),
          created_at: (c.data || '') + 'T' + (c.hora || '00:00')
        }]);
        return;
      }
      container.innerHTML = '<div style="text-align:center;color:#94a3b8;font-size:12.5px;padding:40px 20px;">Nenhuma mensagem ainda.<br><span style="font-size:11.5px;">As mensagens do WhatsApp aparecerão aqui.</span></div>';
      return;
    }
    _renderChatMessages(container, data);
  } catch(e) {
    container.innerHTML = '<div style="text-align:center;color:#94a3b8;font-size:12.5px;padding:32px;">Erro ao carregar mensagens</div>';
  }
}

function _renderChatMessages(container, msgs) {
  container.innerHTML = msgs.map(m => {
    const isOut = m.remetente === 'consultorio';
    const time  = new Date(m.created_at).toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit' });
    return `<div class="chat-msg-wrap ${isOut ? 'out' : 'in'}">
      <div class="chat-bubble ${isOut ? 'out' : 'in'}">${_esc(m.mensagem).replace(/\n/g,'<br>')}</div>
      <div class="chat-ts">${time}</div>
    </div>`;
  }).join('');
  container.scrollTop = container.scrollHeight;
}

function _appendChatMessage(m, pending) {
  const container = document.getElementById('chat-messages');
  if (!container) return null;
  // Remove empty state
  if (container.children.length === 1 && container.children[0].style.textAlign === 'center') {
    container.innerHTML = '';
  }
  const isOut = m.remetente === 'consultorio';
  const time  = new Date(m.created_at || Date.now()).toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit' });
  const el    = document.createElement('div');
  el.className = `chat-msg-wrap ${isOut ? 'out' : 'in'}`;
  if (pending) el.style.opacity = '0.5';
  el.innerHTML = `<div class="chat-bubble ${isOut ? 'out' : 'in'}">${_esc(m.mensagem).replace(/\n/g,'<br>')}</div>
    <div class="chat-ts">${pending ? 'enviando…' : time}</div>`;
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
  return el;
}

// Textos que ESTE navegador acabou de enviar (pra não duplicar o eco do realtime).
const _chatEnviadasLocal = new Set();

function _subscribeChatRealtime(phone) {
  if (!_supa) return;
  if (_chatSub) { _supa.removeChannel(_chatSub); }
  _chatSub = _supa
    .channel('chat-msgs-' + phone)
    .on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'crm_messages',
      filter: `whatsapp=eq.${phone}`
    }, payload => {
      if (_chatPhone !== phone || !payload.new) return;
      const m = payload.new;
      if (m.remetente !== 'consultorio') {
        _appendChatMessage(m);
        // Copiloto: ao chegar mensagem do paciente, já prepara uma sugestão.
        const _ia = getIaConfig();
        if (_ia.enabled && _ia.autoSugerir) iaSugerirNoChat(true);
      } else if (!_chatEnviadasLocal.has(m.mensagem)) {
        // Resposta 'consultorio' vinda do SERVIDOR (secretária IA autônoma ou
        // outro aparelho) — precisa aparecer aqui, senão a secretária responde
        // em cima sem saber que o paciente já foi atendido.
        _appendChatMessage(m);
      }
    })
    .subscribe();
}

// ====================== 🤖 SECRETÁRIA POR IA (copiloto) ======================
// Modo COPILOTO: a IA SUGERE a resposta; a secretária revisa e envia (nunca
// envia sozinha). Roda no navegador, reusando o Groq já configurado
// (getGeminiKey). O conhecimento vem automaticamente do app: procedimentos/
// preços, programas, horários e nome da clínica. Guardrail: nada de conselho
// médico. O modo autônomo (responder sozinho) é uma evolução futura deste código.

function getIaConfig() {
  return DB.getObj('ia_config', {
    enabled: false, autoSugerir: true, autonomo: false, agendar: false, agendarModo: 'pendente',
    // Personalização (tudo opcional):
    nomeAssistente: '',      // ex.: "Sofia" — a IA se apresenta com esse nome
    apresentarComoIA: true,  // assume que é assistente virtual (recomendado/ético)
    tom: '',                 // tom de voz
    instrucoes: '',          // instruções livres
    endereco: '',            // endereço da clínica
    convenios: '',           // convênios aceitos (ou "só particular")
    pagamentos: '',          // formas de pagamento
    naoResponder: '',        // temas que a IA deve recusar e passar pra humano
  });
}

// ── Camada de LLM plugável — use QUALQUER provedor ──
// 'groq' (grátis, já configurado) · 'claude' (Anthropic) · 'openrouter'
// (vários modelos numa chave só) · 'custom' (qualquer endpoint compatível
// com OpenAI: você cola URL + chave + modelo). Default 'groq'.
function getLlmConfig() {
  return DB.getObj('llm_config', {
    provider: 'groq',
    groqModel: 'llama-3.3-70b-versatile',
    claudeKey: '',
    claudeModel: 'claude-haiku-4-5-20251001',
    openrouterKey: '',
    openrouterModel: 'anthropic/claude-3.5-haiku',
    customUrl: '',
    customKey: '',
    customModel: '',
  });
}

// Chamada unificada de chat. Recebe { system, messages:[{role,content}] }.
// Retorna { ok, texto } ou { error }. Abstrai as diferenças de Groq e Claude.
async function _llmChat({ system, messages, temperature = 0.4, maxTokens = 400 }) {
  const cfg = getLlmConfig();
  try {
    if (cfg.provider === 'claude') {
      if (!cfg.claudeKey) return { error: 'no-key-claude' };
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': cfg.claudeKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: cfg.claudeModel || 'claude-haiku-4-5-20251001',
          max_tokens: maxTokens,
          temperature,
          system,
          messages,
        }),
      });
      if (!res.ok) { const t = await res.text(); return { error: 'Claude ' + res.status + ': ' + t.substring(0, 120) }; }
      const json = await res.json();
      const texto = (json.content?.[0]?.text || '').trim();
      return texto ? { ok: true, texto } : { error: 'resposta vazia' };
    }
    // Provedores compatíveis com OpenAI: Groq, OpenRouter ou personalizado.
    // (system entra como 1ª mensagem; só muda URL/chave/modelo/headers.)
    let url, key, model, extraHeaders = {};
    if (cfg.provider === 'openrouter') {
      url = 'https://openrouter.ai/api/v1/chat/completions';
      key = cfg.openrouterKey;
      model = cfg.openrouterModel || 'anthropic/claude-3.5-haiku';
      extraHeaders = { 'X-Title': 'Maestria de Consultorio' };
    } else if (cfg.provider === 'custom') {
      url = cfg.customUrl;
      key = cfg.customKey;
      model = cfg.customModel;
      if (!url)   return { error: 'configure a URL do provedor' };
      if (!model) return { error: 'configure o modelo' };
    } else { // groq (default)
      url = 'https://api.groq.com/openai/v1/chat/completions';
      key = getGeminiKey();
      model = cfg.groqModel || 'llama-3.3-70b-versatile';
    }
    if (!key) return { error: 'no-key' };
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}`, ...extraHeaders },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: system }, ...messages],
        temperature,
        max_tokens: maxTokens,
      }),
    });
    if (!res.ok) { const t = await res.text(); return { error: 'API ' + res.status + ': ' + t.substring(0, 120) }; }
    const json = await res.json();
    const texto = (json.choices?.[0]?.message?.content || '').trim();
    return texto ? { ok: true, texto } : { error: 'resposta vazia' };
  } catch (e) { return { error: e.message }; }
}

// Monta o "cérebro" da IA a partir dos dados que já existem no app.
// `overrides` permite o Playground testar valores do formulário AO VIVO,
// sem precisar salvar (passa o ia_config em edição).
function _iaMontarSystemPrompt(overrides) {
  const clin = DB.getObj('clinica_config', {});
  const nomeClin = clin.nome || 'a clínica';
  const cfg = Object.assign({}, getIaConfig(), overrides || {});

  const procs = getProcedimentos()
    .filter(p => (p.valorPix || p.valorCartao))
    .map(p => {
      const partes = [];
      if (p.valorPix)    partes.push(`PIX/dinheiro ${BRL(p.valorPix)}`);
      if (p.valorCartao) partes.push(`cartão ${BRL(p.valorCartao)}`);
      return `- ${p.nome}: ${partes.join(' · ') || 'sob consulta'}${p.obs ? ' (' + p.obs + ')' : ''}`;
    }).join('\n') || '- (nenhum procedimento com valor cadastrado)';

  const progs = (typeof getProgramas === 'function' ? getProgramas() : [])
    .filter(p => p.ativo !== false)
    .map(p => `- ${p.nome} (${p.tipo})${p.precoAVista ? ' — à vista ' + BRL(p.precoAVista) : ''}`)
    .join('\n');

  const ag = getAgConfig();
  const diasNomes = ['domingo','segunda','terça','quarta','quinta','sexta','sábado'];
  const dias = (ag.diasUteis || []).map(d => diasNomes[d]).filter(Boolean).join(', ') || 'dias úteis';
  const hoje = new Date();
  const hojeStr = _ymd(hoje);
  const diaSemana = diasNomes[hoje.getDay()];

  const quemSou = cfg.nomeAssistente
    ? `Você se chama ${cfg.nomeAssistente} e é a assistente virtual de ${nomeClin}`
    : `Você é a assistente virtual de ${nomeClin}`;

  const linhas = [
    `${quemSou}, atendendo pacientes pelo WhatsApp. Hoje é ${diaSemana}, ${hojeStr}.`,
    `Seu papel é APENAS: tirar dúvidas sobre valores, horários e informações de atendimento, e ajudar a marcar/remarcar consultas.`,
    ``,
    `REGRAS INEGOCIÁVEIS:`,
    `- NUNCA dê conselho, diagnóstico ou orientação médica/clínica. Se perguntarem sobre sintomas, exames, tratamento ou "o que eu tenho", responda com cordialidade que isso o profissional avalia na consulta e ofereça agendar.`,
    `- NUNCA invente preços, horários ou informações que não estejam listados abaixo. Se não souber, diga que vai confirmar com a equipe.`,
    `- Seja breve e natural (é WhatsApp): 1 a 3 frases, sem textão, tom humano.`,
    `- NÃO confirme o agendamento como feito — quem fecha na agenda é a equipe. Você pode propor horários e perguntar a preferência.`,
    `- Se o paciente pedir para falar com humano, estiver irritado, ou for assunto delicado/fora do escopo, sugira gentilmente que a equipe assume.`,
  ];
  if (cfg.apresentarComoIA !== false) {
    linhas.push(`- Se perguntarem se você é um robô/IA, confirme com naturalidade e simpatia — nunca finja ser humana.`);
  }
  if (cfg.naoResponder) {
    linhas.push(`- NUNCA responda sobre: ${cfg.naoResponder}. Nesses casos, diga que a equipe vai assumir.`);
  }
  linhas.push(``, `PROCEDIMENTOS E VALORES:`, procs);
  if (progs) { linhas.push(``, `PLANOS/PROGRAMAS:`, progs); }
  linhas.push(``, `HORÁRIO DE ATENDIMENTO: ${dias}, das ${ag.horaInicio} às ${ag.horaFim}.`);
  if (cfg.endereco)   linhas.push(``, `ENDEREÇO: ${cfg.endereco}`);
  if (cfg.convenios)  linhas.push(``, `CONVÊNIOS: ${cfg.convenios}`);
  if (cfg.pagamentos) linhas.push(``, `FORMAS DE PAGAMENTO: ${cfg.pagamentos}`);
  if (cfg.tom)        linhas.push(``, `TOM DE VOZ: ${cfg.tom}`);
  if (cfg.instrucoes) linhas.push(``, `INSTRUÇÕES EXTRAS DA CLÍNICA: ${cfg.instrucoes}`);
  return linhas.join('\n');
}

// Converte o histórico do chat em mensagens no formato do LLM.
function _iaHistoricoToMessages(hist) {
  return (hist || []).map(m => ({
    role: m.remetente === 'consultorio' ? 'assistant' : 'user',
    content: m.mensagem || ''
  }));
}

// Gera uma resposta sugerida com base no histórico recente da conversa atual.
async function _iaSugerirResposta() {
  if (!_chatPhone || !_supa) return { error: 'sem conversa' };
  const owner = currentDataOwner || (currentUser && currentUser.id);
  let hist = [];
  try {
    const { data, error } = await _supa.from('crm_messages')
      .select('remetente,mensagem,created_at')
      .eq('user_id', owner).eq('whatsapp', _chatPhone)
      .order('created_at', { ascending: false }).limit(16);
    if (error) throw error;
    hist = (data || []).reverse();
  } catch(e) { return { error: e.message }; }
  if (!hist.length) return { error: 'sem histórico' };

  return await _llmChat({
    system: _iaMontarSystemPrompt(),
    messages: _iaHistoricoToMessages(hist),
    temperature: 0.4,
    maxTokens: 300,
  });
}

// ====================== 🧪 PLAYGROUND DA IA (testar sem WhatsApp) ======================
// Conversa de simulação: usa os campos do FORMULÁRIO (mesmo sem salvar), não
// grava nada, não envia WhatsApp. Serve pra você calibrar a personalidade e
// ver como a IA responde ANTES de liberar pra valer.
let _iaPgHist = []; // [{role:'user'|'assistant', content}]

function _iaPlaygroundReset() {
  _iaPgHist = [];
  const box = document.getElementById('ia-pg-msgs');
  if (box) box.innerHTML = '<div style="color:#94a3b8;text-align:center;font-size:12px;padding:8px;">Escreva como se fosse o paciente e veja a IA responder — usando os campos acima (mesmo sem salvar).</div>';
}

function _iaPgBubble(role, texto, cinza) {
  const box = document.getElementById('ia-pg-msgs');
  if (!box) return null;
  if (box.querySelector('div[style*="text-align:center"]')) box.innerHTML = '';
  const paciente = role === 'user';
  const el = document.createElement('div');
  el.style.cssText = `max-width:82%;align-self:${paciente ? 'flex-end' : 'flex-start'};background:${paciente ? '#dcfce7' : '#f3e8ff'};color:${cinza ? '#94a3b8' : '#0f172a'};padding:8px 11px;border-radius:12px;line-height:1.4;white-space:pre-wrap;`;
  el.textContent = texto;
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
  return el;
}

async function _iaPlaygroundSend() {
  const input = document.getElementById('ia-pg-input');
  const texto = (input?.value || '').trim();
  if (!texto) return;
  input.value = '';
  _iaPgBubble('user', texto);
  _iaPgHist.push({ role: 'user', content: texto });
  const carregando = _iaPgBubble('assistant', '…', true);
  // Monta o prompt com os valores do formulário AO VIVO (overrides sem salvar).
  const r = await _llmChat({
    system: _iaMontarSystemPrompt(_iaFormOverrides()),
    messages: _iaPgHist.slice(-16),
    temperature: 0.5,
    maxTokens: 300,
  });
  if (r.ok) {
    if (carregando) carregando.textContent = r.texto;
    else _iaPgBubble('assistant', r.texto);
    _iaPgHist.push({ role: 'assistant', content: r.texto });
  } else {
    const msg = (r.error === 'no-key' || r.error === 'no-key-claude')
      ? '⚠️ Configure a chave do motor de IA acima e salve.'
      : '⚠️ Erro: ' + r.error;
    if (carregando) { carregando.textContent = msg; carregando.style.color = '#dc2626'; }
  }
}

// Mostra num alerta legível TUDO que a IA "sabe" (o prompt de sistema montado
// com os campos atuais). Tira o medo de "o que ela vai falar?".
function _iaVerCerebro() {
  const prompt = _iaMontarSystemPrompt(_iaFormOverrides());
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.style.display = 'flex';
  ov.innerHTML = `<div class="modal" style="max-width:640px;">
    <div style="padding:20px 22px 12px;display:flex;align-items:center;justify-content:space-between;">
      <div style="font-size:16px;font-weight:700;">🧠 O que a IA sabe</div>
      <button onclick="this.closest('.modal-overlay').remove()" style="background:#f1f5f9;border:none;border-radius:8px;width:30px;height:30px;cursor:pointer;font-size:16px;">✕</button>
    </div>
    <div style="padding:0 22px 8px;font-size:12px;color:#64748b;">Isto é exatamente a "cabeça" que a IA recebe. Nada além disso é inventado — se algo estiver errado aqui, ajuste os campos ou o cadastro de procedimentos/horários.</div>
    <pre style="margin:12px 22px 22px;padding:14px;background:#0f172a;color:#e2e8f0;border-radius:10px;font-size:11.5px;line-height:1.55;white-space:pre-wrap;max-height:60vh;overflow:auto;">${_esc(prompt)}</pre>
  </div>`;
  ov.addEventListener('click', e => { if (e.target === ov) ov.remove(); });
  document.body.appendChild(ov);
}

// Botão "✨ Sugerir": preenche o input com a sugestão p/ a secretária revisar.
// auto=true → chamada automática ao chegar mensagem (não atropela texto digitado).
async function iaSugerirNoChat(auto) {
  const cfg = getIaConfig();
  if (!cfg.enabled) { if (!auto) toast('Ative a secretária por IA em Configurações'); return; }
  const input = document.getElementById('chat-input-text');
  const btn   = document.getElementById('chat-ia-btn');
  const hint  = document.getElementById('chat-ia-hint');
  if (!input) return;
  if (auto && input.value.trim()) return; // já há algo digitado: não sobrescreve
  if (btn) { btn.disabled = true; btn.textContent = '✨…'; }
  const r = await _iaSugerirResposta();
  if (btn) { btn.disabled = false; btn.textContent = '✨ Sugerir'; }
  if (r.error) {
    if (!auto) {
      if (r.error === 'no-key' || r.error === 'no-key-claude') toast('Configure a chave do motor de IA em Configurações primeiro');
      else toast('IA: ' + r.error);
    }
    return;
  }
  input.value = r.texto;
  input.focus();
  if (hint) hint.style.display = '';
}

async function sendChatMessage() {
  const input  = document.getElementById('chat-input-text');
  const text   = (input?.value || '').trim();
  if (!text || !_chatPhone) return;
  if (!_waConnected()) return;
  const _iaHint = document.getElementById('chat-ia-hint'); if (_iaHint) _iaHint.style.display = 'none';

  input.value    = '';
  input.disabled = true;

  // Otimista: mostra na tela como "enviando…" (cinza) até o Z-API confirmar
  const pendingEl = _appendChatMessage({ remetente: 'consultorio', mensagem: text, created_at: new Date().toISOString() }, true);
  // Marca como envio local pra não duplicar quando o eco do realtime voltar.
  _chatEnviadasLocal.add(text);
  setTimeout(() => _chatEnviadasLocal.delete(text), 30000);

  try {
    const r = await _waSendText(_chatPhone, text);
    if (!r.ok) throw new Error(r.error);
    // Confirmado: tira o estado "enviando…" e marca a hora real
    if (pendingEl) {
      pendingEl.style.opacity = '1';
      const ts = pendingEl.querySelector('.chat-ts');
      if (ts) ts.textContent = new Date().toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit' });
    }
    // Persiste no Supabase (sob o dono dos dados, p/ a secretária também ver)
    if (_supa && currentUser) {
      await _supa.from('crm_messages').insert({
        user_id: currentDataOwner || currentUser.id, whatsapp: _chatPhone, remetente: 'consultorio', mensagem: text
      });
    }
  } catch(e) {
    // Marca a mensagem como NÃO enviada (vermelha) e mostra o motivo real do Z-API
    if (pendingEl) {
      pendingEl.style.opacity = '1';
      const bubble = pendingEl.querySelector('.chat-bubble');
      if (bubble) { bubble.style.background = '#fee2e2'; bubble.style.color = '#b91c1c'; }
      const ts = pendingEl.querySelector('.chat-ts');
      if (ts) { ts.textContent = '⚠ não enviada'; ts.style.color = '#dc2626'; }
    }
    const err = String(e.message || '');
    let dica;
    if (/NOT_?FOUND/i.test(err)) {
      dica = 'O WhatsApp não localizou esse número (já tentei com e sem o 9º dígito).\n\n' +
             '• Confirme que o número tem WhatsApp ativo.\n' +
             '• Se o envio falhar para TODOS os contatos, clique em "Testar conexão" em ' +
             'Configurações → WhatsApp para checar as credenciais do Z-API.';
    } else if (/token/i.test(err)) {
      dica = 'Parece faltar o "Token de segurança da conta". Pegue no painel do Z-API (menu Segurança) ' +
             'e cole em Configurações → WhatsApp → Token de segurança da conta.';
    } else {
      dica = 'Verifique o número e a conexão do Z-API em Configurações → WhatsApp.';
    }
    alert('⚠️ A mensagem NÃO foi enviada.\n\nMotivo do Z-API: ' + err + '\n\n' + dica);
  } finally {
    input.disabled = false;
    input.focus();
  }
}

// ====================== REALTIME: LEADS DO WHATSAPP ======================

let _leadsChannel = null;

function initLeadsRealtime() {
  if (!_supa || !currentUser) return;
  // Remove canal anterior (evita "cannot add callbacks after subscribe")
  if (_leadsChannel) {
    _supa.removeChannel(_leadsChannel).catch(() => {});
    _leadsChannel = null;
  }
  const owner = currentDataOwner || currentUser.id;
  _leadsChannel = _supa
    .channel('new-wa-leads-' + owner)
    .on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'crm_leads',
      filter: `user_id=eq.${owner}`
    }, () => {
      syncLeadsFromSupabase();
    });
  _leadsChannel.subscribe();
}

async function syncLeadsFromSupabase() {
  if (!_supa || !currentUser) return;
  try {
    const owner = currentDataOwner || currentUser.id;
    const { data, error } = await _supa
      .from('crm_leads')
      .select('*')
      .eq('user_id', owner)
      .eq('processado', false)
      .order('created_at', { ascending: true });
    if (error || !data || data.length === 0) return;

    const crm = DB.get('crm');
    const ids = [];
    let novos = 0;

    data.forEach(lead => {
      // Webhook grava o lead COM DDI 55; contatos manuais ficam sem — sem
      // normalizar os dois lados, o mesmo paciente virava card duplicado.
      const cleanPhone = _normPhone(lead.whatsapp);
      const existe = crm.some(c => c.whatsapp && _normPhone(c.whatsapp) === cleanPhone);
      if (!existe) {
        const d = new Date(lead.created_at);
        crm.unshift({
          data:      _ymd(d),
          id:        _novoId('crm'),                       // id estável (Fase 1)
          hora:      `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`,
          nome:      lead.nome || 'Contato WhatsApp',
          whatsapp:  cleanPhone, // já normalizado (sem DDI) pelo _normPhone
          canal:     'WhatsApp',
          tipo:      '',
          status:    'Contato feito',
          profissionalId: lead.profissional_id || null,   // roteamento por número (Tijolo 4B)
          obs:       lead.primeira_mensagem ? `Primeira msg: ${lead.primeira_mensagem}` : ''
        });
        novos++;
      }
      ids.push(lead.id);
    });

    if (ids.length > 0) {
      // `processado: true` é um caminho sem volta: o lead nunca mais volta neste
      // select. Marcar antes de confirmar a gravação do CRM perdia o contato de
      // vez quando o push era recusado (RLS) ou o aparelho estava offline.
      const gravou = await DB.set('crm', crm);
      if (novos > 0 && document.getElementById('page-crm')?.classList.contains('active')) {
        renderCrm();
      }
      if (!gravou) {
        console.warn('[WhatsApp] CRM não chegou ao servidor — leads seguem pendentes pro próximo ciclo');
        return;
      }
      const { error: eMarca } = await _supa.from('crm_leads').update({ processado: true }).in('id', ids);
      if (eMarca) { console.warn('[WhatsApp] leads não marcados como processados:', eMarca.message); return; }
      console.log(`[WhatsApp] ${novos} novo(s) lead(s) incorporado(s) ao CRM`);
    }
  } catch(e) {
    console.warn('syncLeadsFromSupabase error:', e.message);
  }
}

function renderBackup() {
  const resumo = document.getElementById('backup-resumo');
  if (!resumo) return;
  const items = [
    { icon:'🧑‍⚕️', label:'Atendidos',    count: DB.get('pacientes').length },
    { icon:'📋', label:'CRM',           count: DB.get('crm').length },
    { icon:'💸', label:'Despesas',       count: DB.get('despesas').length },
    { icon:'📅', label:'Agendamentos',   count: DB.get('agendamentos').length },
  ];
  resumo.innerHTML = items.map(it => `
    <div class="kpi-card" style="text-align:center;padding:18px 12px;">
      <div style="font-size:28px;margin-bottom:4px;">${it.icon}</div>
      <div style="font-size:26px;font-weight:800;color:#0f172a;">${it.count}</div>
      <div style="font-size:11px;color:#94a3b8;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;margin-top:2px;">${it.label}</div>
    </div>`).join('');

  // Lista de snapshots automáticos
  const snapList = document.getElementById('backup-snapshots-list');
  if (snapList) {
    const snapshots = listarSnapshots();
    if (!snapshots.length) {
      snapList.innerHTML = `<div style="text-align:center;padding:32px 16px;color:#94a3b8;font-size:13px;">
        Ainda não há backups automáticos. Será criado automaticamente após o próximo login.
      </div>`;
    } else {
      const hoje = _ymd(new Date());
      snapList.innerHTML = snapshots.map(s => {
        const ehHoje = s.data === hoje;
        const dataLabel = new Date(s.data + 'T12:00:00').toLocaleDateString('pt-BR', { weekday:'short', day:'2-digit', month:'short' });
        return `
        <div style="display:flex;align-items:center;gap:14px;padding:12px 16px;background:#f8fafc;border:1px solid #e2e8f0;border-left:3px solid ${ehHoje ? '#10b981' : '#cbd5e1'};border-radius:8px;">
          <div style="width:38px;height:38px;background:${ehHoje ? '#d1fae5' : '#f1f5f9'};color:${ehHoje ? '#065f46' : '#64748b'};border-radius:8px;display:flex;align-items:center;justify-content:center;flex-shrink:0;">
            <i data-lucide="archive" style="width:18px;height:18px;"></i>
          </div>
          <div style="flex:1;min-width:0;">
            <div style="font-size:13.5px;font-weight:700;color:#0f172a;text-transform:capitalize;">${dataLabel}${ehHoje ? ' · hoje' : ''}</div>
            <div style="font-size:11.5px;color:#64748b;margin-top:2px;">
              ${s.pacientes} pacientes · ${s.inscricoes} inscrições · ${s.tamanhoKB} KB
              ${s.automatico ? ' · 🤖 automático' : ''}
            </div>
          </div>
          <button onclick="restaurarSnapshot('${s.data}')" class="btn-ghost" style="font-size:11.5px;padding:6px 12px;">↺ Restaurar</button>
          <button onclick="excluirSnapshot('${s.data}')" title="Excluir backup" style="background:none;border:none;color:#cbd5e1;cursor:pointer;font-size:18px;padding:2px 8px;" onmouseover="this.style.color='#dc2626'" onmouseout="this.style.color='#cbd5e1'">×</button>
        </div>`;
      }).join('');
      if (window.lucide) lucide.createIcons();
    }
  }
}

function exportarJSON() {
  const dados = {};
  BACKUP_KEYS.forEach(k => {
    const raw = localStorage.getItem('consult_' + k);
    if (raw) dados[k] = JSON.parse(raw);
  });
  dados._meta = {
    versao: '2.0',  // bump: agora inclui programas, inscrições, maestria, clinica_config
    exportadoEm: new Date().toISOString(),
    exportadoPor: (typeof currentNome !== 'undefined' && currentNome) ? currentNome : 'anon',
    app: 'Consultório App',
    chaves: BACKUP_KEYS.length,
  };
  const blob = new Blob([JSON.stringify(dados, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  const hoje = _ymd(new Date());
  a.href = url; a.download = `consultorio-backup-${hoje}.json`;
  a.click(); URL.revokeObjectURL(url);
  toast('✅ Backup exportado com sucesso!', 2500);
}

function exportarCSV(chave) {
  const dados = DB.get(chave);
  if (!dados.length) { toast('Nenhum dado para exportar.', 2000); return; }

  // Cabeçalhos dinâmicos baseados nas chaves do primeiro item
  const cols = Object.keys(dados[0]);
  const linhas = [cols.join(';')];
  dados.forEach(row => {
    linhas.push(cols.map(c => {
      const v = row[c] !== undefined && row[c] !== null ? String(row[c]) : '';
      return v.includes(';') || v.includes('"') || v.includes('\n') ? `"${v.replace(/"/g,'""')}"` : v;
    }).join(';'));
  });

  const bom  = '﻿'; // BOM para Excel abrir UTF-8 corretamente
  const blob = new Blob([bom + linhas.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  const hoje = _ymd(new Date());
  a.href = url; a.download = `${chave}-${hoje}.csv`;
  a.click(); URL.revokeObjectURL(url);
  toast(`✅ ${dados.length} registros exportados!`, 2500);
}

function importarJSON(input) {
  const file = input.files[0];
  if (!file) return;
  const status = document.getElementById('backup-import-status');
  status.textContent = `Lendo ${file.name}…`;
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const dados = JSON.parse(e.target.result);
      if (!dados || typeof dados !== 'object') throw new Error('Arquivo inválido');

      const chavesTrocar = BACKUP_KEYS.filter(k => dados[k] !== undefined);
      if (!chavesTrocar.length) throw new Error('Nenhum dado reconhecido no arquivo');

      // Coleção blindada TEM de ser array. Arquivo editado à mão com um objeto
      // no lugar era gravado assim mesmo, e toda tela que faz .filter/.reduce
      // em cima quebrava — o app não abria mais até limpar o navegador.
      const invalidas = chavesTrocar.filter(k => _BLINDADAS[k] && !Array.isArray(dados[k]));
      if (invalidas.length) throw new Error('Formato inválido (esperava lista) em: ' + invalidas.join(', '));

      const exportadoEm = dados._meta?.exportadoEm ? new Date(dados._meta.exportadoEm).toLocaleString('pt-BR') : 'data desconhecida';
      if (!confirm(`Restaurar backup de ${exportadoEm}?\n\nIsso vai substituir:\n${chavesTrocar.join(', ')}\n\nSeus dados atuais serão apagados. Confirma?`)) {
        status.textContent = 'Importação cancelada.';
        return;
      }

      // ESPERA o envio terminar antes de recarregar. As coleções blindadas
      // sobem em lotes de 200; recarregar num timer de 2s cortava o envio no
      // meio. O que ficava pra trás só existia no localStorage, e o pull
      // seguinte trazia os dados VELHOS por cima — o backup "restaurado com
      // sucesso" evaporava. Pior: como o push faz upsert e só depois delete,
      // o corte no meio deixava o servidor com uma mistura dos dois estados.
      // (restaurarSnapshot já espera — aqui era a única porta que não esperava.)
      status.textContent = 'Restaurando e enviando para a nuvem…';
      const oks = await Promise.all(chavesTrocar.map(k => DB.set(k, dados[k])));
      const falhas = chavesTrocar.filter((_, i) => oks[i] === false);
      if (falhas.length) {
        status.textContent = `⚠️ Restaurado neste aparelho, mas não subiu: ${falhas.join(', ')}`;
        alert('Backup restaurado NESTE APARELHO, mas estas seções não chegaram à nuvem: '
          + falhas.join(', ') + '.\n\nElas ficaram na fila de envio. Mantenha o app aberto '
          + 'com internet até sincronizar — não recarregue nem feche agora.');
        return; // recarregar aqui só apressaria o pull a sobrescrever o que faltou
      }
      status.textContent = `✅ Restaurado com sucesso! (${chavesTrocar.length} seções)`;
      toast('✅ Backup restaurado! Recarregando…', 2000);
      setTimeout(() => location.reload(), 2000);
    } catch(err) {
      status.textContent = `❌ Erro: ${err.message}`;
      toast('❌ Arquivo inválido ou corrompido.', 3000);
    } finally {
      input.value = '';
    }
  };
  reader.readAsText(file);
}

async function limparTodosDados() {
  // Apagar a CLÍNICA INTEIRA é prerrogativa do dono — membro não pode
  // (o RLS novo também bloqueia o delete no servidor; isto é a 1ª barreira).
  if (currentUser && (currentDataOwner || currentUser.id) !== currentUser.id) {
    toast('Apenas o dono da clínica pode apagar todos os dados.');
    return;
  }
  // Oferece backup antes
  if (confirm('Recomendamos exportar um backup ANTES de apagar tudo.\n\nQuer baixar o backup agora? (OK = baixar, Cancelar = pular)')) {
    exportarJSON();
    await new Promise(r => setTimeout(r, 800));
  }
  // Confirmação forte: digitar APAGAR
  const resp = prompt('⚠️ ATENÇÃO: isso apaga PERMANENTEMENTE todos os dados do consultório (atendidos, CRM, agenda, despesas, programas, etc.) — no aparelho E na nuvem.\n\nEsta ação NÃO pode ser desfeita.\n\nPara confirmar, digite APAGAR:');
  if (resp !== 'APAGAR') {
    if (resp !== null) toast('Cancelado — texto não confere.', 2500);
    return;
  }

  toast('Apagando dados…', 2000);

  // 1) Apaga localStorage (chaves de dados + snapshots)
  Object.keys(localStorage)
    .filter(k => k.startsWith('consult_'))
    .filter(k => k !== 'consult_dark_mode' && k !== 'consult_onboarding_done') // preserva preferências de UI
    .forEach(k => localStorage.removeItem(k));

  // 2) Apaga na nuvem (Supabase) — senão o cloudPull rebaixa tudo no reload
  const naoApagou = [];
  if (_supa && currentUser) {
    const owner = currentDataOwner || currentUser.id;
    const alvos = [
      ['app_data',     'user_id'],
      ['crm_leads',    'user_id'],
      ['crm_messages', 'user_id'],
      // As 5 coleções blindadas vivem em TABELAS PRÓPRIAS e ficavam de fora:
      // o usuário via "tudo apagado", o reload repopulava do servidor, e os
      // dados de saúde continuavam no Supabase indefinidamente (LGPD).
      ...Object.values(_BLINDADAS).map(cfg => [cfg.tabela, 'owner_id']),
    ];
    for (const [tabela, coluna] of alvos) {
      try {
        const { error } = await _supa.from(tabela).delete().eq(coluna, owner);
        if (error) { naoApagou.push(tabela); console.warn('limparTodosDados', tabela, error.message); }
      } catch(e) { naoApagou.push(tabela); console.warn('limparTodosDados', tabela, e.message); }
    }
  }

  _auditLog('excluiu', 'sistema', 'Apagou TODOS os dados do consultório');
  // Nunca afirmar que apagou tudo se alguma tabela resistiu — é justamente a
  // afirmação falsa que cria o problema de LGPD.
  if (naoApagou.length) {
    alert('Os dados foram apagados deste aparelho, mas NÃO foi possível apagar na nuvem: '
      + naoApagou.join(', ') + '.\n\nOs dados continuam no servidor. Tente de novo com internet estável.');
  } else {
    toast('✅ Todos os dados foram apagados.', 2500);
  }
  setTimeout(() => location.reload(), 2000);
}

// ====================== IMPORTAR PLANILHA ======================

// Sinônimos de colunas por campo — cobre iClinic, Doctoralia, Nuvem Saúde,
// MedKey, Tasy, MV, Nexodata, Dr. Consulta, Amplimed, sistemas em inglês, etc.
const IMP_CAMPOS = [
  {
    key:'nome', label:'Nome do paciente', req:true,
    syns:[
      'paciente','nome','patient','name','nome completo','nome do paciente',
      'nome paciente','patient name','full name','nome_paciente','paciente nome',
      'nome do cliente','cliente','beneficiario','beneficiário','titular',
    ],
  },
  {
    key:'data', label:'Data da consulta', req:true,
    syns:[
      'data','date','data da consulta','data do atendimento','data consulta',
      'dt consulta','dt. consulta','appointment date','data agendamento',
      'data visita','data_consulta','data_atendimento','data do agendamento',
      'data marcada','dt atendimento','dt. atendimento','data realizacao',
      'data realização','data procedimento','data do procedimento',
      'inicio','início','start','start date','appointment','scheduled date',
    ],
  },
  {
    key:'tipo', label:'Tipo de consulta', req:false,
    syns:[
      'tipo','type','procedimento','procedure','tipo de consulta',
      'tipo de atendimento','tipo atendimento','classificação','classificacao',
      'especialidade','specialty','motivo','motivo da consulta','servico',
      'serviço','service','appointment type','visit type','modalidade',
      'categoria','categoria do atendimento','tipo_consulta',
    ],
  },
  {
    key:'valor', label:'Valor (R$)', req:false,
    syns:[
      'valor','value','preço','preco','honorarios','honorários','fee',
      'valor pago','valor total','valor da consulta','total','amount',
      'total pago','preco consulta','preço consulta','valor consulta',
      'valor cobrado','valor recebido','receita','preco do atendimento',
      'preço do atendimento','valor_consulta','custo','cost','price',
    ],
  },
  {
    key:'status', label:'Status pagamento', req:false,
    syns:[
      'status','situacao','situação','pagamento','pago','payment',
      'status financeiro','financeiro','situação pagamento','status pagamento',
      'status_pagamento','situacao_financeira','quitado','liquidado',
      'status do pagamento','payment status','financial status','recebido',
      'cobrança','cobranca','status cobrança',
    ],
  },
  {
    key:'whatsapp', label:'WhatsApp / Telefone', req:false,
    syns:[
      'celular','whatsapp','telefone','fone','tel','phone','mobile',
      'contato','telefone celular','ddd + celular','cel','telefone1',
      'telefone 1','tel1','tel celular','fone celular','phone number',
      'mobile number','numero celular','número celular','celular_paciente',
      'telefone_paciente','contact','numero','número',
    ],
  },
];

let _impRawData = [];
let _impHeaders = [];

/* ── Abre modal e reseta estado ── */
function impAbrir() {
  _impRawData = [];
  _impHeaders = [];
  impGoStep(1);
  openModal('modal-imp-planilha');
}

/* ── Troca de step com animação do stepper ── */
function impGoStep(n) {
  [1, 2, 3].forEach(i => {
    const stepEl = document.getElementById(`imp-step-${i}`);
    if (stepEl) stepEl.classList.toggle('active', i === n);

    const dot = document.getElementById(`imp-dot-${i}`);
    if (dot) {
      dot.classList.remove('active','done');
      if (i < n)  dot.classList.add('done');
      if (i === n) dot.classList.add('active');
    }

    const line = document.getElementById(`imp-line-${i}`);
    if (line) line.classList.toggle('done', i < n);
  });
}

/* ── Detecta mapeamento automático ── */
function impDetectMapping(headers) {
  const norm = s => s.toLowerCase().trim().replace(/[^\w\sáàâãéèêíîóôõúûçÁÀÂÃÉÈÊÍÎÓÔÕÚÛÇ]/g,'').replace(/\s+/g,' ').trim();
  const mapping = {};
  IMP_CAMPOS.forEach(campo => {
    const found = headers.find(h => campo.syns.includes(norm(h)));
    mapping[campo.key] = found || '';
  });
  return mapping;
}

/* ── Parser CSV inteligente (vírgula ou ponto-e-vírgula, aspas) ── */
function impParseCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return null;

  const first = lines[0];
  const delim = (first.match(/;/g)||[]).length >= (first.match(/,/g)||[]).length ? ';' : ',';

  const parseLine = line => {
    const res = []; let inQ = false; let cur = '';
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { inQ = !inQ; }
      else if (ch === delim && !inQ) { res.push(cur.trim()); cur = ''; }
      else { cur += ch; }
    }
    res.push(cur.trim());
    return res;
  };

  const headers = parseLine(lines[0]);
  const rows = lines.slice(1)
    .map(l => { const v = parseLine(l); const o = {}; headers.forEach((h,i) => o[h] = v[i]||''); return o; })
    .filter(r => Object.values(r).some(v => v));

  return { headers, rows };
}

/* ── Parser XLSX via SheetJS ── */
function impParseXLSX(buffer) {
  if (!window.XLSX) { toast('⚠️ Biblioteca XLSX não carregou. Recarregue a página.', 4000); return null; }
  const wb = XLSX.read(buffer, { type:'array', cellDates:true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval:'' });
  const headers = rows.length ? Object.keys(rows[0]) : [];
  return { headers, rows };
}

/* ── Recebe arquivo (input ou drop) ── */
function impHandleFile(file) {
  if (!file) return;
  const ext = file.name.split('.').pop().toLowerCase();
  if (!['csv','xlsx','xls'].includes(ext)) {
    toast('⚠️ Use um arquivo .xlsx, .xls ou .csv', 3000); return;
  }

  const reader = new FileReader();
  reader.onload = e => {
    let parsed;
    try {
      if (ext === 'csv') {
        // Tenta UTF-8; se tiver caracteres estranhos, tenta re-ler como latin1
        parsed = impParseCSV(e.target.result);
      } else {
        parsed = impParseXLSX(new Uint8Array(e.target.result));
      }
    } catch(err) {
      toast('❌ Erro ao ler arquivo: ' + err.message, 4000); return;
    }

    if (!parsed || !parsed.rows.length) {
      toast('⚠️ Arquivo vazio ou sem dados reconhecidos', 3000); return;
    }

    _impHeaders = parsed.headers;
    _impRawData = parsed.rows;
    impBuildStep2(file.name);
    impGoStep(2);
  };

  if (ext === 'csv') reader.readAsText(file, 'UTF-8');
  else               reader.readAsArrayBuffer(file);
}

/* ── Constrói o Step 2 (mapeamento + prévia) ── */
function impBuildStep2(filename) {
  const total   = _impRawData.length;
  const mapping = impDetectMapping(_impHeaders);
  const detected = IMP_CAMPOS.filter(c => mapping[c.key]).length;

  // Info bar
  document.getElementById('imp-file-info').innerHTML = `
    <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:12px 18px;display:flex;align-items:center;gap:12px;margin-bottom:22px;">
      <span style="font-size:28px;">📄</span>
      <div style="flex:1;">
        <div style="font-size:13.5px;font-weight:700;color:#0f172a;">${filename}</div>
        <div style="font-size:12px;color:#059669;margin-top:2px;">${total} linhas · ${_impHeaders.length} colunas · ${detected} campos detectados automaticamente</div>
      </div>
    </div>`;

  // Mapping table
  const rowsHtml = IMP_CAMPOS.map(campo => {
    const sel = mapping[campo.key];
    const opts = `<option value="">— ignorar —</option>` +
      _impHeaders.map(h => `<option value="${h.replace(/"/g,'&quot;')}"${h === sel ? ' selected' : ''}>${h}</option>`).join('');
    return `
      <tr>
        <td style="font-size:13px;font-weight:${campo.req?'600':'400'};color:#0f172a;">
          ${campo.label}${campo.req ? ' <span style="color:#ef4444;font-size:11px;">obrigatório</span>' : ''}
        </td>
        <td>
          <select id="imp-map-${campo.key}" class="select" style="width:100%;font-size:12.5px;" onchange="impRefreshPreview()">
            ${opts}
          </select>
        </td>
        <td style="font-size:11.5px;white-space:nowrap;color:${sel?'#059669':'#94a3b8'};" id="imp-map-ok-${campo.key}">
          ${sel ? '✓ auto' : campo.req ? '⚠️ selecione' : 'opcional'}
        </td>
      </tr>`;
  }).join('');

  document.getElementById('imp-mapping-area').innerHTML = `
    <div style="margin-bottom:20px;">
      <div style="font-size:14px;font-weight:700;color:#0f172a;margin-bottom:4px;">Mapeamento de colunas</div>
      <div style="font-size:12.5px;color:#64748b;margin-bottom:14px;">O app detectou os campos automaticamente. Ajuste se necessário.</div>
      <table class="imp-map-table">
        <thead><tr><th>Campo do app</th><th>Coluna da planilha</th><th></th></tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>`;

  impRefreshPreview();

  const btn = document.getElementById('imp-btn-executar');
  if (btn) btn.textContent = `Importar ${total} registros →`;
}

/* ── Lê mapeamento atual dos selects ── */
function impGetMapping() {
  const m = {};
  IMP_CAMPOS.forEach(c => { const el = document.getElementById(`imp-map-${c.key}`); m[c.key] = el ? el.value : ''; });
  return m;
}

/* ── Atualiza prévia (chamada ao mudar qualquer select) ── */
function impRefreshPreview() {
  const m = impGetMapping();

  // Atualiza indicadores de status
  IMP_CAMPOS.forEach(c => {
    const el = document.getElementById(`imp-map-ok-${c.key}`);
    if (!el) return;
    if (m[c.key]) { el.textContent = '✓'; el.style.color = '#059669'; }
    else { el.textContent = c.req ? '⚠️ selecione' : 'opcional'; el.style.color = c.req ? '#f59e0b' : '#94a3b8'; }
  });

  const cols = IMP_CAMPOS.filter(c => m[c.key]);
  const prev = _impRawData.slice(0, 6);

  if (!cols.length || !prev.length) {
    document.getElementById('imp-preview-area').innerHTML = ''; return;
  }

  const thead = cols.map(c =>
    `<th style="padding:7px 10px;font-size:11px;color:#64748b;font-weight:600;text-align:left;border-bottom:1px solid #e2e8f0;white-space:nowrap;">${c.label}</th>`
  ).join('');

  const tbody = prev.map(row =>
    `<tr>${cols.map(c => `<td style="padding:7px 10px;font-size:12px;color:#0f172a;border-bottom:1px solid #f1f5f9;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${row[m[c.key]] || '—'}</td>`).join('')}</tr>`
  ).join('');

  document.getElementById('imp-preview-area').innerHTML = `
    <div style="margin-bottom:20px;">
      <div style="font-size:13px;font-weight:700;color:#0f172a;margin-bottom:10px;">Prévia (6 primeiras linhas)</div>
      <div style="overflow-x:auto;border:1px solid #e2e8f0;border-radius:8px;">
        <table style="width:100%;border-collapse:collapse;">
          <thead><tr style="background:#f8fafc;">${thead}</tr></thead>
          <tbody>${tbody}</tbody>
        </table>
      </div>
    </div>`;
}

/* ── Normaliza data (DD/MM/YYYY, serial Excel, YYYY-MM-DD) ── */
function impNormDate(s) {
  if (!s) return '';
  // Date object (SheetJS com cellDates:true) — TEM de ser testado ANTES do
  // String(), senão o instanceof nunca é verdade e a data cai como texto
  // "Mon Aug 03 2026 ...", que não casa com nenhum formato e vira ''.
  if (s instanceof Date) {
    if (isNaN(s.getTime())) return '';
    // Nada de toISOString: o SheetJS monta a data em hora LOCAL
    // (new Date(ano, mes, dia)), e em fuso negativo o toISOString devolveria o
    // dia ANTERIOR — o mesmo erro que o _ymd existe pra evitar.
    // Planilha gerada com UTC:true chega ancorada em meia-noite UTC; nesse caso
    // a leitura UTC é que está certa.
    const meiaNoiteLocal = s.getHours() === 0 && s.getMinutes() === 0 && s.getSeconds() === 0;
    const meiaNoiteUTC   = s.getUTCHours() === 0 && s.getUTCMinutes() === 0 && s.getUTCSeconds() === 0;
    return (meiaNoiteLocal || !meiaNoiteUTC) ? _ymd(s) : s.toISOString().slice(0, 10);
  }
  s = String(s).trim();
  // Excel serial
  if (/^\d{5}$/.test(s)) {
    const d = new Date(Date.UTC(1899,11,30) + parseInt(s)*86400000);
    return d.toISOString().slice(0,10);
  }
  // DD/MM/YYYY ou DD-MM-YYYY
  const m1 = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (m1) return `${m1[3]}-${m1[2].padStart(2,'0')}-${m1[1].padStart(2,'0')}`;
  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0,10);
  return '';
}

/* ── Normaliza valor monetário ── */
// Antes, TODO ponto era tratado como separador de milhar. Com isso "1234.56"
// virava 123456 — cem vezes maior, sem nenhum aviso. E não era formato exótico:
// é exatamente o que o exportarCSV deste app escreve (String(1234.56)), então
// exportar e reimportar o próprio arquivo inflava o faturamento em 100x.
//
// Regra agora: quando os dois separadores aparecem, o da DIREITA é o decimal
// ("1.234,56" e "1,234.56" caem certo). Só vírgula = decimal, como sempre (pt-BR).
// Só ponto = decimal apenas se for um único ponto deixando 1 ou 2 casas
// ("1234.56"); "1.500" e "1.234.567" seguem sendo milhar.
//
// Ambiguidade que sobra, e é insolúvel sem saber a origem do arquivo: "1,234"
// pode ser 1234 (milhar en-US) ou 1,234 (decimal pt-BR). Fica na leitura pt-BR,
// que é a do usuário deste app.
function impNormValor(s) {
  if (!s && s !== 0) return 0;
  if (typeof s === 'number') return Math.round(s * 100) / 100;
  let t = String(s).replace(/[^\d.,-]/g, '').trim();
  if (!t) return 0;
  const negativo = t.startsWith('-');
  t = t.replace(/-/g, '');

  const virg = t.lastIndexOf(',');
  const ponto = t.lastIndexOf('.');
  let dec = -1;
  if (virg >= 0 && ponto >= 0) {
    dec = Math.max(virg, ponto);
  } else if (virg >= 0) {
    dec = virg;
  } else if (ponto >= 0) {
    const casas = t.length - ponto - 1;
    if (t.indexOf('.') === ponto && casas >= 1 && casas <= 2) dec = ponto;
  }

  const inteiro = (dec >= 0 ? t.slice(0, dec) : t).replace(/[.,]/g, '');
  const frac    = dec >= 0 ? t.slice(dec + 1).replace(/[.,]/g, '') : '';
  const n = parseFloat((inteiro || '0') + (frac ? '.' + frac : ''));
  if (isNaN(n)) return 0;
  return Math.round((negativo ? -n : n) * 100) / 100;
}

/* ── Normaliza status de pagamento ── */
function impNormStatus(s) {
  const lc = (s||'').toLowerCase();
  // Só pode devolver status CANÔNICOS (os mesmos de _resumoFin e do dropdown).
  // 'Parcelado' não existia em lugar nenhum do app: o valor caía fora de todos
  // os baldes de pagamento e o dinheiro ficava invisível.
  if (/isent|cortesia|gratui|free/.test(lc)) return 'Isento';
  if (/pago|recebi|paid|quit|ok|sim|yes/.test(lc)) return 'Pago';
  if (/parcel/.test(lc)) return 'Parcial';
  return 'Pendente';
}

/* ── Normaliza tipo de consulta ── */
function impNormTipo(s) {
  const lc = (s||'').toLowerCase();
  if (/1[aª°]?\s*vez|primeira|first|new|inicial/.test(lc)) return '1ª vez';
  if (/retorno|return|follow|sequencia|continuação/.test(lc)) return 'Retorno';
  if (/domicil/.test(lc)) return 'Domiciliar';
  if (/telemed|online|remota|virtual/.test(lc)) return 'Telemedicina';
  return s ? s : 'Consulta';
}

/* ── Executa a importação ── */
function impExecute() {
  const m = impGetMapping();

  if (!m.nome) { toast('⚠️ Selecione a coluna com o nome do paciente', 3000); return; }
  if (!m.data) { toast('⚠️ Selecione a coluna com a data da consulta',  3000); return; }

  const existentes = DB.get('pacientes');

  // Índice de chaves existentes (nome+data) para dedup
  const existSet = new Set(existentes.map(p => `${p.nome.toLowerCase().trim()}|${p.data}`));

  let nImportados = 0, nPulados = 0, nSemNome = 0, nSemData = 0;
  const novos = [];

  _impRawData.forEach(row => {
    const nome = String(row[m.nome] || '').trim();
    if (!nome) { nSemNome++; return; }

    const data = impNormDate(row[m.data] || '');
    if (!data) { nSemData++; return; }

    const key = `${nome.toLowerCase()}|${data}`;
    if (existSet.has(key)) { nPulados++; return; }

    existSet.add(key); // evita dups dentro do próprio arquivo
    novos.push({
      nome,
      data,
      tipo:     impNormTipo(m.tipo     ? row[m.tipo]     : ''),
      valor:    impNormValor(m.valor   ? row[m.valor]   : 0),
      // statusPgto (NÃO 'status'): é a chave que todo o financeiro lê. Gravando
      // 'status', a receita importada entrava no bruto mas ficava fora de
      // pago/parcial/pendente/isento — "Recebido R$ 0" com faturamento cheio.
      statusPgto: impNormStatus(m.status ? row[m.status] : ''),
      // _normPhone, NÃO slice(-11): "pegar os últimos 11 dígitos" só funciona
      // pra celular. Fixo com DDI tem 12 dígitos (55 + DDD + 8), e cortar os
      // últimos 11 deixava um "5" solto na frente — 551133334444 virava
      // 51133334444. O app então lia isso como DDD 51 e o botão de WhatsApp
      // abria conversa com um número de OUTRO estado. Além de nunca casar com
      // o contato do CRM, que é indexado por _normPhone.
      whatsapp: m.whatsapp ? _normPhone(row[m.whatsapp]) : '',
      obs:      'Importado de planilha',
    });
    nImportados++;
  });

  if (novos.length) {
    DB.set('pacientes', [...existentes, ...novos]);
    BACKUP_KEYS.includes('pacientes') || null;
  }

  // Monta tela de resultado
  const cards = [
    { n: nImportados, label: 'consultas importadas',  bg: '#d1fae5', cor: '#059669', cort: '#065f46' },
    { n: nPulados,    label: 'duplicatas ignoradas',   bg: '#fef3c7', cor: '#d97706', cort: '#92400e' },
    ...(nSemNome || nSemData ? [{ n: nSemNome + nSemData, label: 'linhas inválidas', bg: '#fee2e2', cor: '#dc2626', cort: '#991b1b' }] : []),
  ].map(c => `
    <div style="background:${c.bg};border-radius:14px;padding:18px 28px;text-align:center;min-width:120px;">
      <div style="font-size:34px;font-weight:800;color:${c.cor};">${c.n}</div>
      <div style="font-size:11.5px;color:${c.cort};font-weight:600;margin-top:2px;">${c.label}</div>
    </div>`).join('');

  document.getElementById('imp-result-area').innerHTML = `
    <div style="text-align:center;padding:16px 0 8px;">
      <div style="font-size:48px;margin-bottom:10px;">${nImportados ? '✅' : '⚠️'}</div>
      <div style="font-size:19px;font-weight:800;color:#0f172a;margin-bottom:18px;">
        ${nImportados ? 'Importação concluída!' : 'Nenhum registro novo importado'}
      </div>
      <div style="display:flex;gap:14px;justify-content:center;flex-wrap:wrap;margin-bottom:20px;">${cards}</div>
      ${nImportados ? `<div style="font-size:13px;color:#64748b;">Acesse <strong>Atendidos</strong> para ver os ${nImportados} registros importados.</div>` : ''}
      ${nSemNome ? `<div style="font-size:12px;color:#94a3b8;margin-top:8px;">${nSemNome} linha(s) puladas por não ter nome do paciente</div>` : ''}
      ${nSemData ? `<div style="font-size:12px;color:#94a3b8;">${nSemData} linha(s) puladas por data não reconhecida</div>` : ''}
    </div>`;

  impGoStep(3);
  if (nImportados) {
    renderBackup();
    toast(`✅ ${nImportados} consultas importadas com sucesso!`, 3500);
  }
}

// ====================== PACOTE 5.3 — GRÁFICOS + SAUDAÇÃO PROATIVA ======================

let _chartReceitaMeta = null;
let _chartOcupacao = null;

function renderChartReceitaMeta() {
  const canvas = document.getElementById('chart-receita-meta');
  if (!canvas) return;
  const pacs = DB.get('pacientes');
  const metas = DB.getObj('metas', {});
  const hoje = new Date();
  const ano = hoje.getFullYear();
  const mes = hoje.getMonth();
  const diasNoMes = new Date(ano, mes + 1, 0).getDate();
  const meta = metas.fat || 0;

  // Receita acumulada dia a dia no mês
  const acumulado = [];
  let soma = 0;
  for (let d = 1; d <= diasNoMes; d++) {
    const ds = `${ano}-${String(mes+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const dia = pacs.filter(p => p.data === ds).reduce((s,p) => s + (p.valor||0), 0);
    soma += dia;
    acumulado.push(d <= hoje.getDate() ? soma : null);
  }

  // Projeção: ritmo atual extrapolado ao fim do mês
  const diaAtual = hoje.getDate();
  const ritmo = diaAtual > 0 ? soma / diaAtual : 0;
  const projecao = Array.from({length: diasNoMes}, (_, i) => {
    const d = i + 1;
    if (d < diaAtual) return null;
    if (d === diaAtual) return soma;
    return Math.round(ritmo * d);
  });

  // Linha de meta (horizontal)
  const metaLinha = Array(diasNoMes).fill(meta);
  // Labels: mostra só dias 1, 7, 14, 21, 28 e último dia (padrão semanal)
  const mesNome = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'][mes];
  const labelsDias = [1, 7, 14, 21, 28, diasNoMes].filter((d, i, a) => a.indexOf(d) === i && d <= diasNoMes);
  const labels = Array.from({length: diasNoMes}, (_, i) => {
    const d = i + 1;
    return labelsDias.includes(d) ? `${d}/${mesNome}` : '';
  });

  if (_chartReceitaMeta) _chartReceitaMeta.destroy();
  _chartReceitaMeta = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Receita acumulada',
          data: acumulado,
          borderColor: '#10b981',
          backgroundColor: 'rgba(16,185,129,0.08)',
          fill: true,
          tension: 0.3,
          pointRadius: 0,
          borderWidth: 2.5,
          spanGaps: false,
        },
        {
          label: 'Projeção',
          data: projecao,
          borderColor: '#10b981',
          borderDash: [5, 4],
          borderWidth: 1.5,
          pointRadius: 0,
          fill: false,
          tension: 0.3,
          spanGaps: false,
        },
        {
          label: 'Meta',
          data: metaLinha,
          borderColor: '#f59e0b',
          borderDash: [6, 3],
          borderWidth: 1.5,
          pointRadius: 0,
          fill: false,
        },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: true, position: 'bottom', labels: { boxWidth: 10, font: { size: 10 } } },
        tooltip: {
          callbacks: {
            label: ctx => ctx.dataset.label + ': ' + BRL(ctx.parsed.y || 0),
          }
        }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { font: { size: 10 }, maxRotation: 0, autoSkip: false },
          title: { display: true, text: `Dias de ${mesNome}`, font: { size: 10 }, color: '#94a3b8', padding: { top: 4 } }
        },
        y: {
          ticks: { font: { size: 10 }, callback: v => 'R$' + (v/1000).toFixed(0) + 'k' },
          grid: { color: '#f1f5f9' },
          title: { display: true, text: 'Receita acumulada (R$)', font: { size: 10 }, color: '#94a3b8' }
        },
      },
    },
  });
}

function renderChartOcupacao() {
  const canvas = document.getElementById('chart-ocupacao');
  if (!canvas) return;
  const ags = getAgendamentos();
  const nomeDias = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
  // Conta agendamentos por dia da semana (excluindo cancelados)
  const contagem = [0,0,0,0,0,0,0];
  const semanas  = [0,0,0,0,0,0,0]; // quantas semanas tiveram esse weekday nos dados
  const datasVistas = new Set();
  ags.filter(a => a.status !== 'Cancelado').forEach(a => {
    const d = new Date(a.data + 'T12:00:00');
    const dow = d.getDay();
    contagem[dow]++;
    datasVistas.add(a.data + '_' + dow);
  });
  // Calcula média: total / nº de semanas distintas que apareceram
  const semDist = [0,0,0,0,0,0,0];
  datasVistas.forEach(k => { const dow = parseInt(k.split('_')[1]); semDist[dow]++; });
  const media = contagem.map((c, i) => semDist[i] > 0 ? +(c / semDist[i]).toFixed(1) : 0);

  // Reordena Seg→Dom (índices 1,2,3,4,5,6,0)
  const ordem = [1,2,3,4,5,6,0];
  const labels = ordem.map(i => nomeDias[i]);
  const dados  = ordem.map(i => media[i]);
  const cores  = ordem.map(i => i === 0 || i === 6 ? 'rgba(148,163,184,0.5)' : 'rgba(59,130,246,0.7)');

  if (_chartOcupacao) _chartOcupacao.destroy();
  _chartOcupacao = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Média consultas',
        data: dados,
        backgroundColor: cores,
        borderRadius: 6,
        borderSkipped: false,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: {
          grid: { display: false },
          ticks: { font: { size: 11 } },
          title: { display: true, text: 'Dia da semana (média histórica)', font: { size: 10 }, color: '#94a3b8', padding: { top: 4 } }
        },
        y: {
          beginAtZero: true,
          ticks: { font: { size: 10 }, stepSize: 1 },
          grid: { color: '#f1f5f9' },
          title: { display: true, text: 'Média de consultas/semana', font: { size: 10 }, color: '#94a3b8' }
        },
      },
    },
  });
}

async function saudacaoDiaria() {
  const key = getGeminiKey();
  if (!key) return;
  const hoje = _ymd(new Date());
  const ultimaSaudacao = localStorage.getItem('consult_saudacao_dia');
  if (ultimaSaudacao === hoje) return; // já saudou hoje

  // Espera 1.5s para o app carregar antes de abrir a Sofia
  await new Promise(r => setTimeout(r, 1500));

  const ctx = buildContext();
  const saudacao = _saudacaoPorHora();

  // Monta um resumo local sem chamar a API
  const partes = [];
  if (ctx.agendaHoje !== 'vazia') {
    const n = ctx.agendaHoje.split('|').length;
    partes.push(`${n} agendamento${n > 1 ? 's' : ''} hoje`);
  } else {
    partes.push('agenda vazia hoje');
  }
  if (ctx.followupHoje > 0) partes.push(`${ctx.followupHoje} follow-up${ctx.followupHoje > 1 ? 's' : ''} vencido${ctx.followupHoje > 1 ? 's' : ''}`);
  if (ctx.pendentes > 0)    partes.push(`${ctx.pendentes} pagamento${ctx.pendentes > 1 ? 's' : ''} pendente${ctx.pendentes > 1 ? 's' : ''}`);
  if (ctx.metaFat > 0)      partes.push(`meta ${ctx.pctMeta}% atingida`);

  const resumo = partes.length ? partes.join(' · ') : 'tudo tranquilo por aqui';

  // Abre o chat e mostra a saudação
  const panel = document.getElementById('chat-panel');
  const setup  = document.getElementById('gemini-setup');
  const main   = document.getElementById('chat-main');
  if (!panel || !setup || !main) return;
  panel.style.display = 'flex';
  setup.style.display = 'none';
  main.style.display  = 'flex';

  const _trat = currentRole === 'medico' ? `Dr(a). ${getClinicaConfig().nome || currentNome || ''}`.trim() : (getClinicaConfig().nome || currentNome || '');
  appendChatMsg('sofia', `${saudacao}${_trat ? ', ' + _trat : ''}! 👋 ${resumo}. Como posso ajudar?`);
  localStorage.setItem('consult_saudacao_dia', hoje);
}

document.addEventListener('DOMContentLoaded', async () => {
  // Inicializa Supabase
  initSupabase();

  // Captura token de convite da URL (?invite=TOKEN) antes de qualquer coisa
  _checkInviteFromUrl();

  // Fluxo de recuperação de senha: o link do email volta com #type=recovery.
  // Não faz auto-login — mostra o form de nova senha.
  if (location.hash.includes('type=recovery') || _recoveryFlow) {
    _recoveryFlow = true;
    document.getElementById('login-page').style.display = 'flex';
    setLoginTab('nova-senha');
    return;
  }

  // Fecha modais ao clicar fora
  document.querySelectorAll('.modal-overlay').forEach(el => {
    el.addEventListener('click', (e) => { if (e.target === el) el.style.display = 'none'; });
  });

  // Data por extenso ao lado de todo input[type=date] — o formato nativo
  // (dd/mm vs mm/dd conforme o navegador/SO) é ambíguo; "qui, 3 de julho" não deixa dúvida.
  _iniciarDatasExtenso();

  // Verifica sessão existente
  const temSessao = await checkSession();

  if (temSessao) {
    // Já logado: verifica se precisa 2FA antes de qualquer outra coisa
    const mfaCheck = await mfaVerificarSeNecessario();
    if (mfaCheck.needsCode) {
      const ok = await pedir2FACodigo();
      if (!ok) {
        // Logout forçado e mostra tela de login
        await _supa.auth.signOut().catch(()=>{});
        document.getElementById('login-page').style.display = 'flex';
        const emailEl = document.getElementById('login-email');
        if (emailEl) setTimeout(() => emailEl.focus(), 100);
        return;
      }
    }
    // 2FA ok — aceita convite pendente, resolve owner, sincroniza
    await _acceptInviteIfPending();
    await resolveDataOwner();
    await cloudPull();
    initLeadsRealtime();
    syncLeadsFromSupabase();
    _iniciarApp();
  } else {
    // Mostra tela de login (já visível por padrão)
    // Se há convite pendente, mostra banner + leva pro cadastro
    if (localStorage.getItem('consult_pending_invite')) {
      _mostrarBannerConvite();
    } else {
      const emailEl = document.getElementById('login-email');
      if (emailEl) setTimeout(() => emailEl.focus(), 100);
    }
  }
});
