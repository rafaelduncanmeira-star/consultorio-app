// ====================== SUPABASE ======================
const SUPA_URL = 'https://ipvztcqlawwslnkzmzzl.supabase.co';
const SUPA_KEY = 'sb_publishable_-AffRgArhzjeJioFgyzgng_bnSo2F4K';
let _supa = null;
let currentUser = null;
let currentRole = 'medico'; // default safe
let currentNome = 'Rafael Duncan';

function initSupabase() {
  try {
    if (window.supabase && window.supabase.createClient) {
      _supa = window.supabase.createClient(SUPA_URL, SUPA_KEY);
    }
  } catch(e) { console.warn('Supabase init error:', e); }
}

// Push uma chave ao Supabase (fire-and-forget)
async function cloudPush(key) {
  if (!_supa || !currentUser) return;
  const raw = localStorage.getItem('consult_' + key);
  if (raw === null) return;
  try {
    await _supa.from('app_data').upsert({ key, value: JSON.parse(raw) }, { onConflict: 'key' });
  } catch(e) { console.warn('cloudPush error', key, e.message); }
}

// Pull todas as chaves do Supabase → localStorage
async function cloudPull() {
  if (!_supa) return;
  try {
    const { data, error } = await _supa.from('app_data').select('key, value');
    if (error) throw error;
    if (data && data.length) {
      data.forEach(row => {
        localStorage.setItem('consult_' + row.key, JSON.stringify(row.value));
      });
      console.log(`cloudPull: ${data.length} chaves sincronizadas`);
    }
  } catch(e) { console.warn('cloudPull error:', e.message); }
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
    currentRole = profile?.role || 'secretaria';
    currentNome  = profile?.nome  || email.split('@')[0];
    // Sincroniza dados da nuvem
    await cloudPull();
    return { ok: true };
  } catch(e) { return { error: e.message }; }
}

// Logout
async function logoutUser() {
  if (_supa) await _supa.auth.signOut();
  currentUser = null;
  currentRole = 'medico';
  currentNome  = 'Rafael Duncan';
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
    currentRole = profile?.role || 'secretaria';
    currentNome  = profile?.nome  || session.user.email.split('@')[0];
    return true;
  } catch(e) { return false; }
}

// Traduz mensagens de erro do Supabase Auth
function _traduzirErroAuth(msg) {
  if (msg.includes('Invalid login credentials') || msg.includes('invalid_credentials')) return 'E-mail ou senha incorretos.';
  if (msg.includes('Email not confirmed')) return 'E-mail não confirmado. Verifique sua caixa de entrada.';
  if (msg.includes('Too many requests')) return 'Muitas tentativas. Aguarde alguns minutos.';
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

  // Sucesso
  _iniciarApp();
}

// Mostra o app e configura role
function _iniciarApp() {
  // Esconde login
  document.getElementById('login-page').style.display = 'none';
  // Atualiza sidebar
  _atualizarSidebar();
  // Aplica visibilidade de role
  _applyRole();
  // Inicializa ícones e dashboard
  if (window.lucide) lucide.createIcons();
  renderDashboard();
  saudacaoDiaria();
}

function _atualizarSidebar() {
  const nomeEl   = document.getElementById('sidebar-nome');
  const roleEl   = document.getElementById('sidebar-role');
  const avatarEl = document.getElementById('sidebar-avatar');
  if (nomeEl)   nomeEl.textContent   = currentNome;
  if (roleEl)   roleEl.textContent   = currentRole === 'medico' ? 'Médico' : 'Secretária';
  if (avatarEl) avatarEl.textContent = currentNome.charAt(0).toUpperCase();
}

// Páginas restritas à secretária
const _PAGES_FINANCEIRO = ['receita', 'despesas', 'relatorio', 'metas', 'precos', 'backup'];

function _applyRole() {
  if (currentRole === 'medico') {
    // Médico vê tudo
    _PAGES_FINANCEIRO.forEach(p => {
      const el = document.getElementById('nav-' + p);
      if (el) el.style.display = '';
    });
    return;
  }
  // Secretária: oculta financeiro
  _PAGES_FINANCEIRO.forEach(p => {
    const el = document.getElementById('nav-' + p);
    if (el) el.style.display = 'none';
  });
}

// ====================== ESTADO DA APP ======================
const DB = {
  get: (key) => JSON.parse(localStorage.getItem('consult_' + key) || '[]'),
  set: (key, val) => {
    localStorage.setItem('consult_' + key, JSON.stringify(val));
    cloudPush(key);
  },
  getObj: (key, def = {}) => JSON.parse(localStorage.getItem('consult_' + key) || JSON.stringify(def)),
  setObj: (key, val) => {
    localStorage.setItem('consult_' + key, JSON.stringify(val));
    cloudPush(key);
  },
};

let charts = {};
let editState = { col: null, idx: null, crmIdx: null, pacIdx: null };
let agendaView = 'diario';

// ====================== NAVEGAÇÃO ======================
function showPage(page) {
  // Bloqueia acesso financeiro para secretária
  if (currentRole !== 'medico' && _PAGES_FINANCEIRO.includes(page)) return;

  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('page-' + page).classList.add('active');
  document.getElementById('nav-' + page).classList.add('active');

  if (page === 'dashboard') renderDashboard();
  if (page === 'crm') renderCrm();
  if (page === 'pacientes') renderPacientes();
  if (page === 'followup') renderFollowup();
  if (page === 'agenda') { setAgendaView(agView); }
  if (page === 'receita') renderReceita();
  if (page === 'despesas') renderDespesas();
  if (page === 'precos') renderPrecos();
  if (page === 'relatorio') renderRelatorio('2026-05');
  if (page === 'metas') renderMetas();
  if (page === 'backup') renderBackup();
}

// ====================== MODAIS ======================
function openModal(id) {
  document.getElementById(id).style.display = 'flex';
  if (id === 'modal-metas') {
    const metas = DB.getObj('metas', { fat: 0, pac: 0, desp: 0 });
    document.getElementById('input-meta-fat').value = metas.fat || '';
    document.getElementById('input-meta-pac').value = metas.pac || '';
    document.getElementById('input-meta-desp').value = metas.desp || '';
  }
  if (id === 'modal-paciente') {
    popularProcedimentoSelect();
    // Reseta valor e atualiza hint
    const vEl = document.getElementById('pac-valor');
    if (vEl && !editState.idx && editState.crmIdx === null) vEl.value = '';
    atualizarValorSugerido();
  }
  if (id === 'modal-config-horarios') openModalConfigHorarios();
  if (id === 'modal-bloqueio')        openModalBloqueio();
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
      { nome: 'Consulta no consultório', valorPix: 1000, valorCartao: 1050, obs: '' },
      { nome: 'Retorno',                  valorPix: 0,    valorCartao: 0,    obs: 'Defina o valor' },
      { nome: 'Visita domiciliar',        valorPix: 800,  valorCartao: 800,  obs: '' },
      { nome: 'Visita domiciliar (paciente antigo)', valorPix: 1300, valorCartao: 1500, obs: '' },
      { nome: 'Hospitalar',               valorPix: 0,    valorCartao: 0,    obs: 'Defina o valor' },
      { nome: 'Telemedicina',             valorPix: 0,    valorCartao: 0,    obs: 'Defina o valor' },
    ];
    DB.set('procedimentos', arr);
    localStorage.setItem('consult_proc_seeded', '1');
  }
  return arr;
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
  sel.innerHTML = procs.map(p => `<option value="${p.nome}">${p.nome}</option>`).join('');
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
  // Mostra ambos os preços do procedimento como referência
  hint.innerHTML = `💡 ${p.nome}: PIX/Dinheiro <strong>${BRL(p.valorPix)}</strong> · Cartão <strong>${BRL(p.valorCartao)}</strong>`;
  // Só auto-preenche se o valor estiver vazio ou for igual ao outro preço (usuário ainda não ajustou)
  const sug = valorSugerido(sel.value, pag.value);
  const atual = parseFloat(valor.value) || 0;
  if (!atual || atual === p.valorPix || atual === p.valorCartao) {
    valor.value = sug || '';
  }
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
        <td style="font-weight:600;color:#0f172a;">${p.nome}${p.obs ? `<div style="font-size:11px;color:#94a3b8;font-weight:400;margin-top:2px;">${p.obs}</div>` : ''}</td>
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
  return `<select onchange="updateCrmStatus(${idx},this.value)" style="${s};border:none;border-radius:999px;padding:3px 10px;font-size:11.5px;font-weight:600;cursor:pointer;outline:none;-webkit-appearance:none;appearance:none;text-align:center;">${opts}</select>`;
}

function updateCrmStatus(idx, newStatus) {
  const data = DB.get('crm');
  const oldStatus = data[idx].status;
  data[idx].status = newStatus;
  DB.set('crm', data);
  renderCrm();
  // Atualiza banner de integração se Atendidos estiver aberto
  if (document.getElementById('page-pacientes') && document.getElementById('page-pacientes').classList.contains('active')) renderPacientes();

  // "Marcou" → propõe criar agendamento na agenda
  if (newStatus === 'Marcou' && oldStatus !== 'Marcou') {
    setTimeout(() => {
      if (confirm(`${data[idx].nome} marcou consulta — deseja agendar na agenda agora?`)) {
        openNovoAgendamento({
          pacienteNome: data[idx].nome,
          whatsapp: data[idx].whatsapp,
          procedimento: data[idx].tipo,
          crmIdx: idx,
        });
      }
    }, 100);
  }

  // "Atendeu" → propõe registrar atendimento em Atendidos
  if (newStatus === 'Atendeu' && oldStatus !== 'Atendeu' && !data[idx].converted) {
    setTimeout(() => {
      if (confirm(`Marcar "${data[idx].nome}" como Atendeu também cria o registro em Atendidos.\n\nRegistrar o atendimento agora?`)) {
        convertCrmToAtendido(idx);
      }
    }, 100);
  }
}

// Dropdown inline de status de pagamento (Atendidos)
function pgtoSelect(status, idx) {
  const val = (!status || status === 'null' || status === 'undefined') ? 'Pendente' : status;
  const styles = {
    'Pago':     'background:#d1fae5;color:#065f46',
    'Pendente': 'background:#fef3c7;color:#92400e',
    'Isento':   'background:#f1f5f9;color:#475569',
  };
  const s = styles[val] || styles['Pendente'];
  const opts = ['Pago','Pendente','Isento']
    .map(o => `<option value="${o}"${val===o?' selected':''}>${o}</option>`).join('');
  return `<select onchange="updatePacStatus(${idx},this.value)" style="${s};border:none;border-radius:999px;padding:3px 10px;font-size:11.5px;font-weight:600;cursor:pointer;outline:none;-webkit-appearance:none;appearance:none;text-align:center;">${opts}</select>`;
}

function updatePacStatus(idx, newStatus) {
  const data = DB.get('pacientes');
  data[idx].statusPgto = newStatus;
  DB.set('pacientes', data);
  renderPacientes();
  renderDashboard();
  // Se a página Receita estiver aberta, re-renderiza pra atualizar KPIs/quebras
  if (document.getElementById('page-receita')?.classList.contains('active')) renderReceita();
}

function deleteRow(col, idx) {
  if (!confirm('Excluir este registro?')) return;
  const data = DB.get(col);
  data.splice(idx, 1);
  DB.set(col, data);
  const renders = { crm: renderCrm, pacientes: renderPacientes, followup: renderFollowup, agenda: renderAgenda, despesas: renderDespesas };
  if (renders[col]) renders[col]();
}

function editRow(col, idx) {
  const data = DB.get(col);
  const r = data[idx];
  editState = { col, idx };

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
    form.obs.value = r.obs || '';
  } else if (col === 'pacientes') {
    popularProcedimentoSelect();
    // Se o tipo registrado não está mais no catálogo, adiciona como opção legada para não perder
    const procs = getProcedimentos();
    if (r.tipo && !procs.some(p => p.nome === r.tipo)) {
      const sel = document.getElementById('pac-procedimento');
      if (sel) sel.insertAdjacentHTML('beforeend', `<option value="${r.tipo}">${r.tipo} (legado)</option>`);
    }
    form.data.value = r.data || '';
    form.tipo.value = r.tipo || '';
    form.nome.value = r.nome || '';
    form.valor.value = r.valor || '';
    form.pagamento.value = r.pagamento || '';
    form.statusPgto.value = r.statusPgto || '';
    form.obs.value = r.obs || '';
    atualizarValorSugerido();
  } else if (col === 'followup') {
    form.nome.value = r.nome || '';
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
  const item = { data: fd.get('data'), hora: fd.get('hora'), nome: fd.get('nome'), whatsapp: fd.get('whatsapp'), idade: fd.get('idade'), canal: fd.get('canal'), tipo: fd.get('tipo'), status: fd.get('status'), obs: fd.get('obs') };
  const data = DB.get('crm');
  if (editState.col === 'crm' && editState.idx !== null) { data[editState.idx] = item; } else { data.unshift(item); }
  DB.set('crm', data);
  closeModal('modal-crm');
  renderCrm();
}

function filterCrmStatus(val) {
  const rows = document.querySelectorAll('#crm-tbody tr[data-search]');
  rows.forEach(row => {
    if (!val || row.getAttribute('data-status') === val) row.style.display = '';
    else row.style.display = 'none';
  });
}

function renderCrm() {
  // Normaliza registros antigos com status null/undefined
  let data = DB.get('crm');
  let changed = false;
  data = data.map(r => {
    if (!r.status || r.status === 'null' || r.status === 'undefined') {
      changed = true;
      return { ...r, status: 'Contato feito' };
    }
    return r;
  });
  if (changed) DB.set('crm', data);
  const tbody = document.getElementById('crm-tbody');
  if (!data.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="text-center py-12 text-gray-400">Nenhum contato registrado.<br><span class="text-sm">Clique em "+ Novo Contato" para começar.</span></td></tr>';
    document.getElementById('funil-contatos').textContent = 0;
    document.getElementById('funil-negoc').textContent = 0;
    document.getElementById('funil-marc').textContent = 0;
    document.getElementById('funil-atend').textContent = 0;
    document.getElementById('funil-conv').textContent = '0%';
    return;
  }
  tbody.innerHTML = data.map((r, i) => `
    <tr data-search="${r.nome} ${r.canal} ${r.status}" data-status="${r.status}" class="border-b border-gray-50 hover:bg-gray-50">
      <td class="px-4 py-3 text-gray-600">${formatDate(r.data)}</td>
      <td class="px-4 py-3 font-medium text-gray-900">${r.nome}</td>
      <td class="px-4 py-3">
        ${r.whatsapp ? `<a href="https://wa.me/55${r.whatsapp.replace(/\D/g,'')}" target="_blank" class="text-green-600 hover:underline">${r.whatsapp}</a>` : '-'}
      </td>
      <td class="px-4 py-3 text-gray-600">${r.canal}</td>
      <td class="px-4 py-3 text-gray-600">${r.tipo}</td>
      <td class="px-4 py-3">${statusSelect(r.status, i)}</td>
      <td class="px-4 py-3" style="white-space:nowrap;">
        <button onclick="editRow('crm',${i})" class="text-blue-400 hover:text-blue-600 text-xs mr-2" title="Editar dados">✏️</button>
        <button onclick="deleteRow('crm',${i})" class="text-red-400 hover:text-red-600 text-xs" title="Excluir">🗑️</button>
      </td>
    </tr>`).join('');

  // Funil
  const contatos = data.length;
  const negoc = data.filter(r => r.status === 'Em negociação' || r.status === 'Marcou' || r.status === 'Atendeu').length;
  const marc = data.filter(r => r.status === 'Marcou' || r.status === 'Atendeu').length;
  const atend = data.filter(r => r.status === 'Atendeu').length;
  document.getElementById('funil-contatos').textContent = contatos;
  document.getElementById('funil-negoc').textContent = negoc;
  document.getElementById('funil-marc').textContent = marc;
  document.getElementById('funil-atend').textContent = atend;
  document.getElementById('funil-conv').textContent = contatos ? PCT((atend / contatos) * 100) : '0%';
}

// ====================== INTEGRAÇÃO CRM → ATENDIDOS ======================
function renderCrmPendentesAtendidos() {
  const crm = DB.get('crm');
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
              <span style="font-weight:600;color:#0f172a;">${c.nome}</span>
              <span style="color:#64748b;font-size:12px;margin-left:10px;">${c.tipo || ''} · ${c.canal || ''} · ${formatDate(c.data)}</span>
            </div>
            <button onclick="convertCrmToAtendido(${c._idx})" style="background:#10b981;color:#fff;border:none;border-radius:7px;padding:7px 16px;font-weight:600;font-size:13px;cursor:pointer;">
              ✓ Registrar Atendimento
            </button>
          </div>`).join('')}
      </div>
    </div>`;
}

function convertCrmToAtendido(crmIdx) {
  const crm = DB.get('crm');
  const c = crm[crmIdx];
  if (!c) return;
  editState = { col: null, idx: null, crmIdx };
  const modal = document.getElementById('modal-paciente');
  const form = modal.querySelector('form');
  const today = new Date().toISOString().split('T')[0];
  popularProcedimentoSelect();
  form.data.value = today;
  form.nome.value = c.nome || '';
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

  const key = localStorage.getItem('consult_gemini_key');
  if (!key) { toast('Configure a chave da MaestrIA (⚙️ no chat) primeiro'); return; }

  document.getElementById('wa-step-paste').style.display = 'none';
  document.getElementById('wa-step-loading').style.display = 'block';

  const hoje = new Date().toISOString().split('T')[0];
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
        <div style="color:#64748b;font-weight:600;">Nome:</div><div>${waExtracted.nome || '<em style="color:#cbd5e1;">não identificado</em>'}</div>
        <div style="color:#64748b;font-weight:600;">WhatsApp:</div><div>${waExtracted.whatsapp || '<em style="color:#cbd5e1;">não identificado</em>'}</div>
        <div style="color:#64748b;font-weight:600;">Idade:</div><div>${waExtracted.idade || '<em style="color:#cbd5e1;">—</em>'}</div>
        <div style="color:#64748b;font-weight:600;">Canal:</div><div>${waExtracted.canal}</div>
        <div style="color:#64748b;font-weight:600;">Tipo:</div><div>${waExtracted.tipo}</div>
        <div style="color:#64748b;font-weight:600;">Status:</div><div>${waExtracted.status}</div>
        <div style="color:#64748b;font-weight:600;">Resumo:</div><div style="font-style:italic;color:#475569;">${waExtracted.obs || '—'}</div>
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
  const cutoffStr = cutoff.toISOString().split('T')[0];
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
              <span style="font-weight:600;color:#0f172a;">${p.nome}</span>
              <span style="color:#64748b;font-size:12px;margin-left:10px;">Consulta: ${formatDate(p.data)} · ${p.tipo}</span>
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
  form.dataContato.value = ajustado.toISOString().split('T')[0];
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
  const item = { data: fd.get('data'), nome: fd.get('nome'), tipo: fd.get('tipo'), valor: parseFloat(fd.get('valor')) || 0, pagamento: fd.get('pagamento'), statusPgto: fd.get('statusPgto'), obs: fd.get('obs') };
  const data = DB.get('pacientes');
  if (editState.col === 'pacientes' && editState.idx !== null) {
    data[editState.idx] = item;
  } else {
    data.unshift(item);
  }
  DB.set('pacientes', data);

  // Se veio de um agendamento, fecha o agendamento (marca como Compareceu + pacIdx)
  if (editState.agId) {
    const ags = DB.get('agendamentos');
    const a = ags.find(x => x.id === editState.agId);
    if (a) {
      a.status = 'Compareceu';
      a.pacIdx = data.indexOf(item) >= 0 ? data.indexOf(item) : 0;
      DB.set('agendamentos', ags);
    }
  }

  // Marcar CRM como convertido quando vem de conversão
  if (editState.crmIdx !== null && editState.crmIdx !== undefined) {
    const crm = DB.get('crm');
    if (crm[editState.crmIdx]) { crm[editState.crmIdx].converted = true; crm[editState.crmIdx].status = 'Atendeu'; }
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
}

// Toast simples (notificação flutuante)
function toast(msg, ms = 3500) {
  let t = document.getElementById('app-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'app-toast';
    t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#0f172a;color:#fff;padding:12px 20px;border-radius:10px;font-size:13.5px;font-weight:500;box-shadow:0 10px 30px rgba(0,0,0,0.25);z-index:9999;opacity:0;transition:opacity 0.25s;max-width:90vw;text-align:center;';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.opacity = '1';
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.style.opacity = '0'; }, ms);
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
    tbody.innerHTML = '<tr><td colspan="7" class="text-center py-12 text-gray-400">Nenhuma consulta registrada.</td></tr>';
    return;
  }
  tbody.innerHTML = data.map((r, i) => `
    <tr data-search="${r.nome} ${r.tipo}" data-status="${r.statusPgto === 'Pago' ? 'Ativo' : 'Inativo'}" class="border-b border-gray-50 hover:bg-gray-50">
      <td class="px-4 py-3 text-gray-600">${formatDate(r.data)}</td>
      <td class="px-4 py-3 font-medium text-gray-900">${r.nome}</td>
      <td class="px-4 py-3 text-gray-600">${r.tipo}</td>
      <td class="px-4 py-3 font-semibold text-gray-900">${BRL(r.valor)}</td>
      <td class="px-4 py-3 text-gray-600">${r.pagamento}</td>
      <td class="px-4 py-3">${pgtoSelect(r.statusPgto, i)}</td>
      <td class="px-4 py-3" style="white-space:nowrap;">
        <button onclick="editRow('pacientes',${i})" class="text-blue-400 hover:text-blue-600 text-xs mr-2" title="Editar">✏️</button>
        <button onclick="deleteRow('pacientes',${i})" class="text-red-400 hover:text-red-600 text-xs" title="Excluir">🗑️</button>
      </td>
    </tr>`).join('');
}

// ====================== FOLLOW-UP ======================
function saveFollowup(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const data = DB.get('followup');
  const existFeito = (editState.col === 'followup' && editState.idx !== null) ? (data[editState.idx].feito || false) : false;
  const item = { nome: fd.get('nome'), ultConsulta: fd.get('ultConsulta'), dataContato: fd.get('dataContato'), tipoContato: fd.get('tipoContato'), feito: existFeito, dataReav: fd.get('dataReav'), obs: fd.get('obs') };
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

function renderFollowup() {
  renderAtendidosSemFollowup();
  const data = DB.get('followup');
  const today = new Date().toISOString().split('T')[0];
  const tbody = document.getElementById('followup-tbody');
  const alertas = document.getElementById('alertas-container');

  const vencidos = data.filter(r => !r.feito && r.dataContato && r.dataContato <= today);

  if (vencidos.length > 0) {
    alertas.innerHTML = `
      <div class="bg-orange-50 border border-orange-200 rounded-xl p-4 flex items-start gap-3 mb-4">
        <span class="text-2xl">⚠️</span>
        <div>
          <div class="font-semibold text-orange-800">${vencidos.length} follow-up(s) pendente(s) hoje</div>
          <div class="text-sm text-orange-700 mt-1">${vencidos.map(r => r.nome).join(', ')}</div>
        </div>
      </div>`;
  } else {
    alertas.innerHTML = '';
  }

  if (!data.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="text-center py-12 text-gray-400">Nenhum follow-up registrado.</td></tr>';
    return;
  }

  tbody.innerHTML = data.map((r, i) => {
    const atrasado = !r.feito && r.dataContato && r.dataContato < today;
    return `
    <tr class="border-b border-gray-50 hover:bg-gray-50 ${atrasado ? 'bg-orange-50' : ''}">
      <td class="px-4 py-3 font-medium text-gray-900">${r.nome}</td>
      <td class="px-4 py-3 text-gray-600">${formatDate(r.ultConsulta)}</td>
      <td class="px-4 py-3 text-gray-600 ${atrasado ? 'text-orange-600 font-semibold' : ''}">${formatDate(r.dataContato)}</td>
      <td class="px-4 py-3 text-gray-600">${r.tipoContato}</td>
      <td class="px-4 py-3">
        <input type="checkbox" ${r.feito ? 'checked' : ''} onchange="toggleFollowupFeito(${i})" class="w-4 h-4 accent-green-600 cursor-pointer" />
      </td>
      <td class="px-4 py-3 text-gray-600">${formatDate(r.dataReav)}</td>
      <td class="px-4 py-3">${statusBadge(r.feito ? 'Feito' : 'Pendente')}</td>
      <td class="px-4 py-3" style="white-space:nowrap;">
        <button onclick="editRow('followup',${i})" class="text-blue-400 hover:text-blue-600 text-xs mr-2" title="Editar">✏️</button>
        <button onclick="deleteRow('followup',${i})" class="text-red-400 hover:text-red-600 text-xs" title="Excluir">🗑️</button>
      </td>
    </tr>`;
  }).join('');
}

// ====================== AGENDA ======================
// ====================== AGENDA — NÍVEL 3 ======================
// Modelo:
//   consult_agendamentos: [{ id, data, hora, duracao, pacienteNome, whatsapp, procedimento, status, obs, crmIdx, pacIdx }]
//   consult_agenda_config: { horaInicio, horaFim, slotDuracao, almocoInicio, almocoFim, diasUteis: [1..5] }
//   consult_bloqueios: [{ id, motivo, dataInicio, horaInicio, dataFim, horaFim }]

let agView = 'semana';            // 'dia' | 'semana' | 'mes'
let agAnchor = new Date();        // data de referência para a view

function _agId() { return 'ag_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6); }

function getAgConfig() {
  return DB.getObj('agenda_config', {
    horaInicio: '07:00', horaFim: '20:00', slotDuracao: 60,
    almocoInicio: '12:00', almocoFim: '13:30',
    diasUteis: [1, 2, 3, 4, 5],
  });
}
function getAgendamentos() { return DB.get('agendamentos'); }
function getBloqueios()    { return DB.get('bloqueios'); }

// Helpers de tempo
function _toMin(hhmm) { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; }
function _toHHMM(min) { return String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0'); }
function _ymd(d) { return d.toISOString().split('T')[0]; }
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
function _temConflito(dataStr, hora, duracao, ignorarId = null) {
  const ags = getAgendamentos();
  const ini = _toMin(hora);
  const fim = ini + duracao;
  return ags.find(a => {
    if (a.id === ignorarId) return false;
    if (a.data !== dataStr) return false;
    if (a.status === 'Cancelado') return false;
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
    // Pula slot que cai integralmente dentro do almoço
    if (almIni !== null && almFim !== null && m >= almIni && (m + slot) <= almFim) continue;
    slots.push(_toHHMM(m));
  }
  return slots;
}

function setAgendaView(v) {
  agView = v;
  ['dia', 'semana', 'mes'].forEach(view => {
    const btn = document.getElementById('btn-ag-' + view);
    if (btn) btn.classList.toggle('active', view === v);
  });
  renderAgenda();
}

function agendaNavegar(dir) {
  if (agView === 'dia') agAnchor = _addDays(agAnchor, dir);
  else if (agView === 'semana') agAnchor = _addDays(agAnchor, dir * 7);
  else { const x = new Date(agAnchor); x.setMonth(x.getMonth() + dir); agAnchor = x; }
  renderAgenda();
}
function agendaHoje() { agAnchor = new Date(); renderAgenda(); }

// ===== Modais =====
function openNovoAgendamento(prefill = {}) {
  editState = { col: null, idx: null, crmIdx: prefill.crmIdx || null, pacIdx: null, agId: null };
  const modal = document.getElementById('modal-agendamento');
  const form = modal.querySelector('form');
  form.reset();
  // Popula select de procedimentos
  const sel = document.getElementById('ag-procedimento');
  const procs = getProcedimentos();
  sel.innerHTML = procs.map(p => `<option value="${p.nome}">${p.nome}</option>`).join('');
  // Pré-preenche
  form.data.value = prefill.data || _ymd(new Date());
  form.hora.value = prefill.hora || '09:00';
  form.duracao.value = prefill.duracao || getAgConfig().slotDuracao || 60;
  if (prefill.pacienteNome) form.pacienteNome.value = prefill.pacienteNome;
  if (prefill.whatsapp) form.whatsapp.value = prefill.whatsapp;
  if (prefill.procedimento && procs.some(p => p.nome === prefill.procedimento)) form.procedimento.value = prefill.procedimento;
  form.status.value = 'Confirmado';
  document.querySelector('#modal-agendamento .modal-title').textContent = 'Novo Agendamento';
  document.getElementById('ag-conflito-aviso').style.display = 'none';
  modal.style.display = 'flex';
}

function editAgendamento(id) {
  const ags = getAgendamentos();
  const a = ags.find(x => x.id === id);
  if (!a) return;
  editState = { col: null, idx: null, crmIdx: a.crmIdx ?? null, pacIdx: a.pacIdx ?? null, agId: id };
  const modal = document.getElementById('modal-agendamento');
  const form = modal.querySelector('form');
  const sel = document.getElementById('ag-procedimento');
  const procs = getProcedimentos();
  // Garante que o procedimento dele esteja no select
  let opts = procs.map(p => `<option value="${p.nome}">${p.nome}</option>`).join('');
  if (a.procedimento && !procs.some(p => p.nome === a.procedimento)) opts += `<option value="${a.procedimento}">${a.procedimento} (legado)</option>`;
  sel.innerHTML = opts;
  form.data.value = a.data;
  form.hora.value = a.hora;
  form.duracao.value = a.duracao || 60;
  form.pacienteNome.value = a.pacienteNome || '';
  form.whatsapp.value = a.whatsapp || '';
  form.procedimento.value = a.procedimento || '';
  form.status.value = a.status || 'Confirmado';
  form.obs.value = a.obs || '';
  document.querySelector('#modal-agendamento .modal-title').textContent = 'Editar Agendamento';
  document.getElementById('ag-conflito-aviso').style.display = 'none';
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
    status: fd.get('status') || 'Confirmado',
    obs: (fd.get('obs') || '').trim(),
    crmIdx: editState.crmIdx ?? null,
    pacIdx: editState.pacIdx ?? null,
  };

  // Verifica conflito
  const conflito = _temConflito(item.data, item.hora, item.duracao, editState.agId);
  if (conflito && item.status !== 'Cancelado') {
    const aviso = document.getElementById('ag-conflito-aviso');
    aviso.style.display = 'block';
    aviso.innerHTML = `⚠️ Conflito com agendamento de <strong>${conflito.pacienteNome}</strong> às ${conflito.hora} (${conflito.duracao} min). Mude o horário ou cancele para continuar.`;
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
  if (idx >= 0) ags[idx] = item; else ags.push(item);
  DB.set('agendamentos', ags);

  // Marca CRM como convertido se veio de lá
  if (item.crmIdx !== null && item.crmIdx !== undefined && item.status === 'Confirmado') {
    const crm = DB.get('crm');
    if (crm[item.crmIdx]) { crm[item.crmIdx].status = 'Marcou'; crm[item.crmIdx].converted = false; DB.set('crm', crm); }
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
  if (!confirm('Excluir este agendamento?')) return;
  const ags = getAgendamentos().filter(a => a.id !== id);
  DB.set('agendamentos', ags);
  renderAgenda();
}

function updateAgStatus(id, novo) {
  const ags = getAgendamentos();
  const a = ags.find(x => x.id === id);
  if (!a) return;
  a.status = novo;
  DB.set('agendamentos', ags);
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
  // Dias da semana
  const dias = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
  document.getElementById('cfg-dias').innerHTML = dias.map((nome, i) => {
    const ativo = cfg.diasUteis.includes(i);
    return `<label style="display:flex;align-items:center;gap:6px;padding:6px 10px;border:1.5px solid ${ativo ? '#10b981' : '#e2e8f0'};border-radius:8px;cursor:pointer;background:${ativo ? '#ecfdf5' : '#fff'};font-size:12.5px;font-weight:600;color:${ativo ? '#065f46' : '#64748b'};">
      <input type="checkbox" name="dia-${i}" ${ativo ? 'checked' : ''} style="cursor:pointer;" />
      ${nome}
    </label>`;
  }).join('');
}

function saveConfigHorarios(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const diasUteis = [];
  for (let i = 0; i < 7; i++) if (fd.get('dia-' + i)) diasUteis.push(i);
  const cfg = {
    horaInicio: fd.get('horaInicio'),
    horaFim: fd.get('horaFim'),
    almocoInicio: fd.get('almocoInicio') || null,
    almocoFim: fd.get('almocoFim') || null,
    slotDuracao: parseInt(fd.get('slotDuracao')) || 60,
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
          <strong>${b.motivo}</strong>
          <div style="color:#78350f;font-size:11px;">${formatDate(b.dataInicio)} ${b.horaInicio || ''} → ${formatDate(b.dataFim)} ${b.horaFim || ''}</div>
        </div>
        <button onclick="deleteBloqueio('${b.id}')" style="background:none;border:none;color:#991b1b;cursor:pointer;font-size:14px;">🗑️</button>
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

function deleteBloqueio(id) {
  if (!confirm('Remover este bloqueio?')) return;
  DB.set('bloqueios', getBloqueios().filter(b => b.id !== id));
  renderBloqueiosList();
  renderAgenda();
}

// ===== Render principal =====
function renderAgenda() {
  // Atualiza KPIs
  _renderAgendaKPIs();

  // Label do período
  const labelEl = document.getElementById('ag-periodo-label');
  if (labelEl) labelEl.textContent = _labelPeriodo();

  const cont = document.getElementById('ag-container');
  if (!cont) return;

  if (agView === 'mes') cont.innerHTML = _viewMes();
  else if (agView === 'semana') cont.innerHTML = _viewSemana();
  else cont.innerHTML = _viewDia();
}

function _labelPeriodo() {
  if (agView === 'dia') {
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
  const ags = getAgendamentos();
  // Filtra agendamentos no período da view
  let ini, fim;
  if (agView === 'dia')        { ini = new Date(agAnchor); fim = new Date(agAnchor); }
  else if (agView === 'semana'){ ini = _startOfWeek(agAnchor); fim = _addDays(ini, 6); }
  else { ini = new Date(agAnchor.getFullYear(), agAnchor.getMonth(), 1); fim = new Date(agAnchor.getFullYear(), agAnchor.getMonth() + 1, 0); }
  const iniStr = _ymd(ini), fimStr = _ymd(fim);
  const ativos = ags.filter(a => a.data >= iniStr && a.data <= fimStr);

  const confirmados = ativos.filter(a => a.status === 'Confirmado').length;
  const compareceram = ativos.filter(a => a.status === 'Compareceu').length;
  const noshow = ativos.filter(a => a.status === 'No-show').length;
  const total = confirmados + compareceram + noshow; // exclui cancelados

  // Ocupação = slots usados ÷ slots disponíveis no período
  let slotsDispo = 0;
  for (let d = new Date(ini); d <= fim; d = _addDays(d, 1)) {
    slotsDispo += _slotsDoDia(_ymd(d)).length;
  }
  const slotsUsados = ativos.filter(a => a.status !== 'Cancelado').length;
  const ocup = slotsDispo ? (slotsUsados / slotsDispo) * 100 : 0;

  // Receita perdida = no-shows × ticket médio do procedimento
  const procs = getProcedimentos();
  let perdida = 0;
  ativos.filter(a => a.status === 'No-show').forEach(a => {
    const p = procs.find(x => x.nome === a.procedimento);
    perdida += p ? (p.valorPix || p.valorCartao || 0) : 0;
  });

  setText('ag-confirmados', confirmados);
  setText('ag-confirmados-sub', `${ativos.length} total no período`);
  setText('ag-compareceram', compareceram);
  setText('ag-compareceram-sub', total ? `${PCT((compareceram / total) * 100)} compareceram` : 'sem comparecimentos');
  setText('ag-noshow', noshow);
  setText('ag-noshow-sub', total ? `${PCT((noshow / total) * 100)} no-show` : '—');
  setText('ag-ocup', PCT(ocup));
  setText('ag-ocup-sub', `${slotsUsados} de ${slotsDispo} slots`);
  setText('ag-perdida', BRL(perdida));
}

function _viewMes() {
  const ano = agAnchor.getFullYear(); const mes = agAnchor.getMonth();
  const primeiro = new Date(ano, mes, 1);
  const inicio = _addDays(primeiro, -((primeiro.getDay() + 6) % 7));
  const ags = getAgendamentos();
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
      const lbl = `${a.hora} ${a.pacienteNome}`;
      return `<div class="cal-evt ${cls}" onclick="event.stopPropagation();editAgendamento('${a.id}')" title="${a.pacienteNome} — ${a.procedimento || ''}">${lbl}</div>`;
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

function _viewWeekOrDay(numDias) {
  const cfg = getAgConfig();
  const ini = numDias === 7 ? _startOfWeek(agAnchor) : new Date(agAnchor);
  const ags = getAgendamentos();
  const bloqs = getBloqueios();
  const hojeStr = _ymd(new Date());

  const slot = cfg.slotDuracao;
  const iniMin = _toMin(cfg.horaInicio);
  const fimMin = _toMin(cfg.horaFim);
  const slotsHoras = [];
  for (let m = iniMin; m + slot <= fimMin; m += slot) slotsHoras.push(_toHHMM(m));

  // Cabeçalho
  let head = '<div class="week-head"></div>';
  for (let i = 0; i < numDias; i++) {
    const d = _addDays(ini, i);
    const ds = _ymd(d);
    const today = ds === hojeStr;
    const naoUtil = !cfg.diasUteis.includes(d.getDay());
    head += `<div class="week-head ${today ? 'today' : ''}" style="${naoUtil ? 'color:#cbd5e1;' : ''}">${DIAS[d.getDay()]}<br><span style="font-size:13px;color:${today ? '#065f46' : '#0f172a'};font-weight:800;">${d.getDate()}/${String(d.getMonth() + 1).padStart(2, '0')}</span></div>`;
  }

  // Linhas de slot
  let rows = '';
  slotsHoras.forEach(hora => {
    rows += `<div class="week-slot-time">${hora}</div>`;
    for (let i = 0; i < numDias; i++) {
      const d = _addDays(ini, i);
      const ds = _ymd(d);
      const naoUtil = !cfg.diasUteis.includes(d.getDay());
      const bloqueado = _isBloqueado(ds, hora, slot);
      // Eventos que começam neste slot
      const eventos = ags.filter(a => a.data === ds && a.hora === hora);
      const cls = ['week-slot', naoUtil && 'fora', bloqueado && 'bloqueado'].filter(Boolean).join(' ');
      const onclick = (naoUtil || bloqueado) ? '' : `onclick="openNovoAgendamento({data:'${ds}', hora:'${hora}'})"`;
      const evtHtml = eventos.map(a => {
        const ec = (a.status || 'confirmado').toLowerCase().replace('no-show', 'noshow');
        return `<div class="week-evt ${ec}" onclick="event.stopPropagation();editAgendamento('${a.id}')" title="${a.pacienteNome} — ${a.procedimento || ''} (${a.duracao}min)"><strong>${a.pacienteNome}</strong><br><span style="font-size:10px;opacity:0.8;">${a.procedimento || '—'}</span></div>`;
      }).join('');
      rows += `<div class="${cls}" ${onclick}>${evtHtml}</div>`;
    }
  });

  const gridStyle = numDias === 1 ? 'grid-template-columns: 60px 1fr;' : '';
  return `<div style="padding:14px;">
    <div class="week-grid" style="${gridStyle}">${head}${rows}</div>
  </div>`;
}

// (renderAgenda agora está acima — Nível 3)

// ====================== DESPESAS ======================
function saveDespesa(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const item = { data: fd.get('data'), descricao: fd.get('descricao'), categoria: fd.get('categoria'), tipo: fd.get('tipo'), valor: parseFloat(fd.get('valor')) || 0, formaPgto: fd.get('formaPgto') };
  const data = DB.get('despesas');
  if (editState.col === 'despesas' && editState.idx !== null) { data[editState.idx] = item; } else { data.unshift(item); }
  DB.set('despesas', data);
  closeModal('modal-despesa');
  renderDespesas();
}

// ====================== RECEITA ======================
function renderReceita() {
  const mesEl = document.getElementById('rec-mes-filter');
  const buscaEl = document.getElementById('rec-busca');
  const statusEl = document.getElementById('rec-status-filter');
  const pgtoEl = document.getElementById('rec-pgto-filter');
  if (!mesEl) return;
  const mes = mesEl.value;
  const busca = (buscaEl?.value || '').toLowerCase().trim();
  const fStatus = statusEl?.value || '';
  const fPgto = pgtoEl?.value || '';

  let pacs = DB.get('pacientes');
  if (mes !== 'todos') pacs = pacs.filter(p => getMes(p.data) === mes);
  // Mantém índice original pra editar/excluir corretamente
  const todosOriginais = DB.get('pacientes');
  const indices = pacs.map(p => todosOriginais.indexOf(p));

  // ===== KPIs (sempre sobre todo o período selecionado, ignorando filtros de tabela) =====
  const recebido = pacs.filter(p => p.statusPgto === 'Pago').reduce((s, p) => s + (p.valor || 0), 0);
  const aReceber = pacs.filter(p => p.statusPgto === 'Pendente').reduce((s, p) => s + (p.valor || 0), 0);
  const isento  = pacs.filter(p => p.statusPgto === 'Isento').reduce((s, p) => s + (p.valor || 0), 0);
  const bruto   = pacs.reduce((s, p) => s + (p.valor || 0), 0);
  const ticket  = pacs.length ? bruto / pacs.length : 0;

  setText('rec-recebido', BRL(recebido));
  setText('rec-recebido-sub', `${pacs.filter(p => p.statusPgto === 'Pago').length} atendimentos pagos`);
  setText('rec-areceber', BRL(aReceber));
  setText('rec-areceber-sub', `${pacs.filter(p => p.statusPgto === 'Pendente').length} pendente(s)`);
  setText('rec-isento', BRL(isento));
  setText('rec-isento-sub', `${pacs.filter(p => p.statusPgto === 'Isento').length} atendimento(s)`);
  setText('rec-bruto', BRL(bruto));
  setText('rec-bruto-sub', `Ticket médio: ${BRL(ticket)} · ${pacs.length} atendimento(s)`);

  // ===== Quebra por forma de pagamento =====
  const formas = ['PIX','Cartão crédito','Cartão débito','Dinheiro','A receber'];
  const formasStats = formas.map(f => {
    const lista = pacs.filter(p => p.pagamento === f);
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
      const pctTotal = bruto ? (s.total / bruto) * 100 : 0;
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

  // ===== Quebra por procedimento =====
  const procMap = {};
  pacs.forEach(p => {
    const k = p.tipo || '(sem procedimento)';
    if (!procMap[k]) procMap[k] = { qtd: 0, total: 0 };
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
            <div style="font-size:12.5px;font-weight:600;color:#0f172a;">${s.nome} <span style="color:#94a3b8;font-weight:400;font-size:11.5px;">(${s.qtd})</span></div>
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
      <td style="font-weight:600;color:#0f172a;">${p.nome}</td>
      <td style="color:#475569;">${p.tipo || '—'}</td>
      <td style="text-align:right;font-weight:700;color:#0f172a;">${BRL(p.valor)}</td>
      <td style="color:#475569;">${p.pagamento || '—'}</td>
      <td>${pgtoSelect(p.statusPgto, idx)}</td>
      <td style="white-space:nowrap;">
        <button onclick="editRow('pacientes',${idx})" class="text-blue-400 hover:text-blue-600 text-xs mr-2" title="Editar">✏️</button>
        <button onclick="deleteRow('pacientes',${idx})" class="text-red-400 hover:text-red-600 text-xs" title="Excluir">🗑️</button>
      </td>
    </tr>`).join('');
  // Rodapé com totais filtrados
  const totFiltrado = linhasFiltradas.reduce((s, { p }) => s + (p.valor || 0), 0);
  if (tfoot) {
    tfoot.innerHTML = `
      <tr style="background:#f8fafc;border-top:2px solid #e2e8f0;">
        <td colspan="3" style="font-weight:700;color:#475569;padding:12px 16px;">Total filtrado (${linhasFiltradas.length} de ${pacs.length})</td>
        <td style="text-align:right;font-weight:800;color:#0f172a;font-size:14px;">${BRL(totFiltrado)}</td>
        <td colspan="3"></td>
      </tr>`;
  }
}

function renderDespesas() {
  const data = DB.get('despesas');
  const pacs = DB.get('pacientes');
  const tbody = document.getElementById('desp-tbody');

  const totalDesp = data.reduce((s, r) => s + r.valor, 0);
  const totalRec = pacs.filter(p => p.statusPgto === 'Pago').reduce((s, r) => s + r.valor, 0);
  const lucro = totalRec - totalDesp;
  const margem = totalRec ? (lucro / totalRec) * 100 : 0;

  document.getElementById('pl-receita').textContent = BRL(totalRec);
  document.getElementById('pl-despesas').textContent = BRL(totalDesp);
  document.getElementById('pl-lucro').textContent = BRL(lucro);
  document.getElementById('pl-margem').textContent = PCT(margem);

  // Por categoria
  const cats = ['Estrutura','Pessoal','Marketing','Materiais','Profissional','Impostos','Outros'];
  const catTotais = cats.map(c => ({ cat: c, val: data.filter(r => r.categoria === c).reduce((s, r) => s + r.valor, 0) }));
  document.getElementById('desp-categorias').innerHTML = catTotais.filter(c => c.val > 0).map(c => `
    <div class="flex items-center justify-between">
      <span class="text-sm text-gray-700">${c.cat}</span>
      <div class="flex items-center gap-3">
        <div class="w-24 bg-gray-100 rounded-full h-1.5">
          <div class="bg-red-400 h-1.5 rounded-full" style="width:${totalDesp ? Math.min((c.val / totalDesp) * 100, 100) : 0}%"></div>
        </div>
        <span class="text-sm font-semibold text-gray-900 w-20 text-right">${BRL(c.val)}</span>
      </div>
    </div>`).join('') || '<div class="text-gray-400 text-sm text-center py-4">Sem despesas registradas</div>';

  // Chart
  destroyChart('chart-desp-cat');
  const ctx = document.getElementById('chart-desp-cat').getContext('2d');
  const nzCats = catTotais.filter(c => c.val > 0);
  if (nzCats.length) {
    charts['chart-desp-cat'] = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: nzCats.map(c => c.cat),
        datasets: [{ data: nzCats.map(c => c.val), backgroundColor: ['#ef4444','#f97316','#eab308','#22c55e','#3b82f6','#8b5cf6','#6b7280'], borderWidth: 0 }]
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
      <td class="px-4 py-3 text-gray-900">${r.descricao}</td>
      <td class="px-4 py-3 text-gray-600">${r.categoria}</td>
      <td class="px-4 py-3"><span class="badge ${r.tipo === 'Fixo' ? 'bg-blue-100 text-blue-700' : 'bg-orange-100 text-orange-700'}">${r.tipo}</span></td>
      <td class="px-4 py-3 font-semibold text-red-600">${BRL(r.valor)}</td>
      <td class="px-4 py-3 text-gray-600">${r.formaPgto}</td>
      <td class="px-4 py-3" style="white-space:nowrap;">
        <button onclick="editRow('despesas',${i})" class="text-blue-400 hover:text-blue-600 text-xs mr-2" title="Editar">✏️</button>
        <button onclick="deleteRow('despesas',${i})" class="text-red-400 hover:text-red-600 text-xs" title="Excluir">🗑️</button>
      </td>
    </tr>`).join('');
}

// ====================== DASHBOARD ======================
// ====================== TOGGLE DE SEÇÕES DO DASHBOARD ======================
const SECTION_LABELS = {
  insights:   '🧠 Insights da MaestrIA',
  retencao:   '💎 Retenção e LTV',
  marketing:  '📣 Aquisição e Marketing',
  financeiro: '💰 Inteligência Financeira',
  graficos:   '📈 Tendências e Gráficos',
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
  Object.keys(SECTION_LABELS).forEach(id => {
    const section = document.querySelector(`[data-section="${id}"]`);
    if (!section) return;
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

  // Barra inferior com chips das ocultas (clica pra reativar)
  const bar = document.getElementById('sections-hidden-bar');
  const listEl = document.getElementById('sections-hidden-list');
  if (!bar || !listEl) return;
  if (!hidden.length) {
    bar.style.display = 'none';
  } else {
    bar.style.display = 'block';
    listEl.innerHTML = hidden.map(id =>
      `<button class="btn-section-chip" onclick="toggleSection('${id}')" title="Mostrar de novo">${SECTION_LABELS[id]} <span style="opacity:0.6;">+</span></button>`
    ).join('');
  }
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
      key: d.toISOString().substring(0, 7),
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
  const canaisLista = ['Indicação médica','Indicação paciente','Google','Instagram','WhatsApp','Doctoralia','Outros'];
  const receitaPorCanal = canaisLista.map(c => {
    const nomesCanal = crm.filter(r => r.canal === c && r.status === 'Atendeu').map(r => (r.nome || '').toLowerCase().trim());
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
          <span>${ins.titulo || ''}</span>
        </div>
        <div style="font-size:12.5px;color:#334155;line-height:1.4;">${ins.descricao || ''}</div>
        ${ins.acao ? `<div style="font-size:11px;color:${c.titulo};font-weight:600;margin-top:8px;">→ ${ins.acao}</div>` : ''}
      </div>`;
  }).join('');

  // Atualiza timestamp
  const tsEl = document.getElementById('insights-timestamp');
  if (tsEl && ts) {
    const d = new Date(ts);
    const agora = new Date();
    const diffH = (agora - d) / (1000 * 60 * 60);
    if (diffH < 1) tsEl.textContent = 'Gerado há menos de 1h';
    else if (diffH < 24) tsEl.textContent = `Gerado há ${Math.floor(diffH)}h`;
    else tsEl.textContent = `Gerado em ${d.toLocaleDateString('pt-BR')}`;
  }
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

  const key = localStorage.getItem('consult_gemini_key');
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
    const prompt = `Você é a MaestrIA, analista do consultório do Dr. Rafael (geriatria).
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
  const hojeStr = new Date().toISOString().split('T')[0];
  const noventaDiasAtras = new Date(); noventaDiasAtras.setDate(noventaDiasAtras.getDate() - 90);
  const noventaStr = noventaDiasAtras.toISOString().split('T')[0];

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
  const seisStr = seisMeses.toISOString().split('T')[0];
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
          <div style="font-weight:600;color:#0f172a;font-size:13.5px;">${p.nome}</div>
          <div style="font-size:11.5px;color:#94a3b8;margin-top:2px;">Última: ${formatDate(p.ultData)} · ${p.totalConsultas} consulta${p.totalConsultas > 1 ? 's' : ''} · LTV ${BRL(p.receita)}</div>
        </div>
        <div style="display:flex;align-items:center;gap:10px;">
          <div style="font-size:11px;font-weight:700;color:#dc2626;background:#fee2e2;padding:3px 9px;border-radius:999px;">${p.diasFora}d</div>
          <button onclick="criarFollowupReativacao('${encodeURIComponent(p.nome)}','${p.ultData}')" style="background:#3b82f6;color:#fff;border:none;border-radius:6px;padding:5px 11px;font-size:11.5px;font-weight:600;cursor:pointer;">📞 Reativar</button>
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

  // Canais — agrupa CRM e calcula métricas
  const canais = ['Indicação médica','Indicação paciente','Google','Instagram','WhatsApp','Doctoralia','Outros'];
  const stats = canais.map(c => {
    const lista = crm.filter(r => r.canal === c);
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

  // Pacientes novos do mês atendidos via CRM
  const crmAtendMes = crm.filter(c => c.status === 'Atendeu' && c.converted);
  const pacsNovosNomes = new Set(crmAtendMes.map(c => (c.nome || '').toLowerCase().trim()));
  const pacsDoMes = pacs.filter(p => getMes(p.data) === mesAtual);
  const novosNoMes = pacsDoMes.filter(p => pacsNovosNomes.has((p.nome || '').toLowerCase().trim()));
  const novosCount = new Set(novosNoMes.map(p => (p.nome || '').toLowerCase().trim())).size;
  const receitaNovos = novosNoMes.reduce((s, p) => s + (p.valor || 0), 0);

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
          <td style="font-weight:600;color:#0f172a;">${s.canal}</td>
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

// Cria follow-up de reativação pré-preenchido
function criarFollowupReativacao(nomeEnc, ultData) {
  const nome = decodeURIComponent(nomeEnc);
  const modal = document.getElementById('modal-followup');
  const form = modal.querySelector('form');
  const amanha = new Date(); amanha.setDate(amanha.getDate() + 1);
  const ajustado = proximoDiaUtil(amanha);
  form.nome.value = nome;
  form.ultConsulta.value = ultData;
  form.dataContato.value = ajustado.toISOString().split('T')[0];
  form.tipoContato.value = 'WhatsApp';
  form.dataReav.value = '';
  form.obs.value = 'Reativação — paciente sem consulta há mais de 6 meses';
  editState = { col: null, idx: null, crmIdx: null, pacIdx: null };
  modal.querySelector('.modal-title').textContent = 'Reativar Paciente';
  modal.style.display = 'flex';
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
  const hojeMes = hoje.toISOString().substring(0, 7);
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

  // ===== DRE =====
  const inad = pacs.filter(p => p.statusPgto === 'Pendente').reduce((s, p) => s + (p.valor || 0), 0);
  const isento = pacs.filter(p => p.statusPgto === 'Isento').reduce((s, p) => s + (p.valor || 0), 0);
  const receitaLiq = fat - inad - isento;

  // Separa impostos das demais despesas
  const despImpostos = despsMes.filter(d => d.categoria === 'Impostos').reduce((s, d) => s + (d.valor || 0), 0);
  const despsOperacionais = despsMes.filter(d => d.categoria !== 'Impostos');
  const despFixas = despsOperacionais.filter(d => d.tipo === 'Fixo').reduce((s, d) => s + (d.valor || 0), 0);
  const despVar   = despsOperacionais.filter(d => d.tipo === 'Variável').reduce((s, d) => s + (d.valor || 0), 0);
  const despsOutras = despsOperacionais.filter(d => d.tipo !== 'Fixo' && d.tipo !== 'Variável').reduce((s, d) => s + (d.valor || 0), 0);

  const receitaPosImp = receitaLiq - despImpostos;
  const cargaTrib = receitaLiq ? (despImpostos / receitaLiq) * 100 : 0;
  const despOpTotal = despFixas + despVar + despsOutras;
  const despTotal = despOpTotal + despImpostos;
  const lucroLiq = receitaPosImp - despOpTotal;
  const margem = receitaLiq ? (lucroLiq / receitaLiq) * 100 : 0;

  setText('fin-receita-liq', BRL(receitaLiq));
  setText('fin-receita-liq-sub', `Bruta ${BRL(fat)} − Pendente ${BRL(inad)}${isento > 0 ? ' − Isento ' + BRL(isento) : ''}`);

  const linhaDRE = (lbl, val, isSubtracao, isResultado, cor) => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;${isResultado ? 'border-top:2px solid #e2e8f0;margin-top:4px;padding-top:12px;' : 'border-bottom:1px dashed #f1f5f9;'}">
      <div style="font-size:12.5px;color:${isResultado ? '#0f172a' : '#475569'};font-weight:${isResultado ? '700' : '500'};">${lbl}</div>
      <div style="font-size:13px;font-weight:${isResultado ? '800' : '600'};color:${cor || (isSubtracao ? '#ef4444' : '#0f172a')};">${isSubtracao ? '−' : ''} ${BRL(Math.abs(val))}</div>
    </div>`;

  document.getElementById('fin-dre').innerHTML =
    linhaDRE('Receita Bruta', fat, false, false) +
    linhaDRE('(−) Pendentes (inadimplência)', inad, true, false) +
    (isento > 0 ? linhaDRE('(−) Isentos / Cortesias', isento, true, false) : '') +
    linhaDRE('= Receita Líquida', receitaLiq, false, false, '#0f172a') +
    linhaDRE(`(−) Impostos${cargaTrib ? ` (carga ${PCT(cargaTrib)})` : ''}`, despImpostos, true, false) +
    linhaDRE('= Receita após impostos', receitaPosImp, false, false, '#0f172a') +
    linhaDRE('(−) Despesas Fixas', despFixas, true, false) +
    linhaDRE('(−) Despesas Variáveis', despVar, true, false) +
    (despsOutras > 0 ? linhaDRE('(−) Outras', despsOutras, true, false) : '') +
    linhaDRE(`= Lucro Líquido (margem ${PCT(margem)})`, lucroLiq, false, true, lucroLiq >= 0 ? '#10b981' : '#ef4444');

  // ===== Receita por tipo de consulta =====
  const tipos = ['1ª vez','Consulta','Retorno','Cortesia','Domiciliar','Hospitalar'];
  const tiposStats = tipos.map(t => {
    const lista = pacs.filter(p => p.tipo === t);
    const total = lista.reduce((s, p) => s + (p.valor || 0), 0);
    const ticket = lista.length ? total / lista.length : 0;
    return { tipo: t, qtd: lista.length, total, ticket };
  }).filter(s => s.qtd > 0).sort((a, b) => b.total - a.total);

  const tiposEl = document.getElementById('fin-tipos');
  if (!tiposStats.length) {
    tiposEl.innerHTML = '<div style="text-align:center;color:#94a3b8;font-size:13px;padding:20px;">Sem consultas registradas neste mês</div>';
  } else {
    const max = Math.max(...tiposStats.map(s => s.total), 1);
    const corPorTipo = {
      '1ª vez': '#3b82f6', 'Consulta': '#10b981', 'Retorno': '#8b5cf6',
      'Cortesia': '#94a3b8', 'Domiciliar': '#f59e0b', 'Hospitalar': '#ef4444',
    };
    tiposEl.innerHTML = tiposStats.map(s => {
      const pctBar = (s.total / max) * 100;
      const cor = corPorTipo[s.tipo] || '#64748b';
      return `
        <div style="margin-bottom:12px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px;">
            <div style="font-size:12.5px;font-weight:600;color:#0f172a;">${s.tipo} <span style="color:#94a3b8;font-weight:400;font-size:11.5px;">(${s.qtd})</span></div>
            <div style="font-size:12.5px;font-weight:700;color:#0f172a;">${BRL(s.total)} <span style="font-size:10.5px;color:#94a3b8;font-weight:500;">· ticket ${BRL(s.ticket)}</span></div>
          </div>
          <div style="height:6px;background:#f1f5f9;border-radius:999px;overflow:hidden;">
            <div style="height:100%;width:${pctBar}%;background:${cor};border-radius:999px;transition:width 0.5s;"></div>
          </div>
        </div>`;
    }).join('');
  }

  // ===== Burn rate (média despesa fixa últimos 3 meses) =====
  const ultimos3Meses = [];
  for (let i = 1; i <= 3; i++) {
    const d = new Date(ano, mesIdx - i + 1, 1);
    ultimos3Meses.push(d.toISOString().substring(0, 7));
  }
  const burnAmostras = ultimos3Meses.map(m =>
    desps.filter(d => getMes(d.data) === m && d.tipo === 'Fixo').reduce((s, d) => s + (d.valor || 0), 0)
  );
  const burnComDado = burnAmostras.filter(v => v > 0);
  const burn = burnComDado.length ? burnComDado.reduce((s, v) => s + v, 0) / burnComDado.length : despFixas;
  setText('fin-burn', BRL(burn));
  setText('fin-burn-sub', burnComDado.length
    ? `Média de ${burnComDado.length} mês(es) anteriores`
    : 'Usando mês atual como base');

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

  if (burn > 0 && caixaEstimado > 0) {
    const runwayMeses = caixaEstimado / burn;
    const cor = runwayMeses >= 6 ? '#10b981' : runwayMeses >= 3 ? '#f59e0b' : '#ef4444';
    const el = document.getElementById('fin-runway');
    if (el) { el.textContent = runwayMeses.toFixed(1) + ' meses'; el.style.color = cor; }
    setText('fin-runway-sub', `Caixa estimado: ${BRL(caixaEstimado)}`);
  } else if (caixaEstimado <= 0) {
    const el = document.getElementById('fin-runway');
    if (el) { el.textContent = '⚠️ Negativo'; el.style.color = '#ef4444'; }
    setText('fin-runway-sub', `Caixa estimado: ${BRL(caixaEstimado)}`);
  } else {
    setText('fin-runway', '— meses');
    setText('fin-runway-sub', 'Lance despesas fixas para calcular');
  }
}

function renderDashboard(mes = '2026-05') {
  const pacs = DB.get('pacientes').filter(p => getMes(p.data) === mes);
  const desps = DB.get('despesas').filter(d => getMes(d.data) === mes);
  const crm = DB.get('crm').filter(c => getMes(c.data) === mes);
  const agenda = DB.get('agenda').filter(a => getMes(a.data) === mes);

  const fat = pacs.reduce((s, p) => s + p.valor, 0);
  const totalDesp = desps.reduce((s, d) => s + d.valor, 0);
  const lucro = fat - totalDesp;
  const margem = fat ? (lucro / fat) * 100 : 0;
  const ticket = pacs.length ? fat / pacs.length : 0;
  const inad = pacs.filter(p => p.statusPgto === 'Pendente').reduce((s, p) => s + p.valor, 0);
  const inadPct = fat ? (inad / fat) * 100 : 0;

  const totVagas = agenda.reduce((s, a) => s + a.vagas, 0);
  const totOcup = agenda.reduce((s, a) => s + a.ocupadas, 0);
  const ocup = totVagas ? (totOcup / totVagas) * 100 : 0;
  const noshow = agenda.reduce((s, a) => s + a.noshow, 0);
  const noshowPct = totVagas ? (noshow / totVagas) * 100 : 0;

  const atend = crm.filter(c => c.status === 'Atendeu').length;
  const conv = crm.length ? (atend / crm.length) * 100 : 0;

  setText('kpi-fat', BRL(fat));
  setText('kpi-fat-sub', fat ? `${pacs.filter(p => p.statusPgto === 'Pago').length} pagos` : 'Sem lançamentos');
  setText('kpi-lucro', BRL(lucro));
  setText('kpi-margem', `Margem: ${PCT(margem)}`);
  setText('kpi-pac', pacs.length);
  setText('kpi-ticket', `Ticket médio: ${BRL(ticket)}`);
  setText('kpi-ocup', PCT(ocup));
  const bar = document.getElementById('kpi-ocup-bar');
  if (bar) bar.style.width = Math.min(ocup, 100) + '%';
  setText('kpi-noshow', `No-show: ${PCT(noshowPct)}`);
  setText('kpi-desp', BRL(totalDesp));
  setText('kpi-inad', PCT(inadPct));
  setText('kpi-inad-val', `${BRL(inad)} em aberto`);
  setText('kpi-conv', PCT(conv));
  setText('kpi-conv-sub', `${atend} de ${crm.length} contatos`);

  // Pacote 3 — Retenção e LTV (independe do mês: usa todo o histórico)
  renderRetencao();
  // Pacote 2 — Aquisição e Marketing (CAC/ROI usam mês atual; canais/funil usam histórico)
  renderMarketing(mes);
  // Pacote 1 — Inteligência financeira (projeção/DRE/runway)
  renderFinanceiro(mes);
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
  const mesNomes = { '2026-05': 'Maio/2026', '2026-04': 'Abril/2026', '2026-03': 'Março/2026' };
  document.getElementById('dash-mes').textContent = mesNomes[val] || val;
  renderDashboard(val);
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

  const fat        = pacs.reduce((s, p) => s + p.valor, 0);
  const totalDesp  = desps.reduce((s, d) => s + d.valor, 0);
  const lucro      = fat - totalDesp;
  const margem     = fat ? (lucro / fat) * 100 : 0;
  const ticket     = pacs.length ? fat / pacs.length : 0;
  const atend      = crm.filter(c => c.status === 'Atendeu').length;
  const conv       = crm.length ? (atend / crm.length) * 100 : 0;

  // Procedimentos
  const procMap = {};
  pacs.forEach(p => {
    const k = p.tipo || '(sem procedimento)';
    if (!procMap[k]) procMap[k] = { qtd: 0, total: 0 };
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

  // Novos vs recorrentes
  const inicioDoMes = mes + '-01';
  const nomesAnteriores = new Set(todosPacs.filter(p => p.data < inicioDoMes).map(p => (p.nome || '').toLowerCase().trim()));
  const pacsNovos = pacs.filter(p => !nomesAnteriores.has((p.nome || '').toLowerCase().trim()));
  const pacsRec   = pacs.filter(p =>  nomesAnteriores.has((p.nome || '').toLowerCase().trim()));
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
  const brl = (v) => 'R$ ' + (v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<title>Relatório ${mesLabel} — Dr. Rafael Duncan</title>
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
      <h1>Dr. Rafael Duncan</h1>
      <p>Geriatria · Relatório Mensal de Gestão</p>
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
      <div class="sub">Ticket médio ${brl(ticket)}</div>
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
          <tr><td>Ticket médio</td><td class="r">${brl(ticket)}</td><td class="r gray">—</td></tr>
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
        ${procStats.map(s => `<tr><td>${s.nome}</td><td class="r">${s.qtd}</td><td class="r">${brl(s.total)}</td><td class="r gray">${pct(s.pct)}</td><td class="r gray">${brl(s.ticket)}</td></tr>`).join('')}
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
        <tr><td>${formatDate(p.data)}</td><td>${p.nome}</td><td>${p.tipo||'—'}</td><td class="r">${brl(p.valor)}</td><td>${p.pagamento||'—'}</td><td class="${p.statusPgto==='Pago'?'green':p.statusPgto==='Pendente'?'red-t':'gray'}">${p.statusPgto}</td></tr>`).join('')}
        <tr class="total"><td colspan="3">Total</td><td class="r">${brl(fat)}</td><td colspan="2">${pacs.length} atendimento(s)</td></tr>
      </tbody>
    </table>
  </div>` : ''}

  <!-- FOOTER -->
  <div class="footer">
    <p>Dr. Rafael Duncan · Geriatria · Consultório App</p>
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

function renderRelatorio(mes) {
  const pacs = DB.get('pacientes').filter(p => getMes(p.data) === mes);
  const desps = DB.get('despesas').filter(d => getMes(d.data) === mes);
  const crm = DB.get('crm').filter(c => getMes(c.data) === mes);
  const metas = DB.getObj('metas', { fat: 0, pac: 0, desp: 0 });
  const todosPacs = DB.get('pacientes');

  const fat = pacs.reduce((s, p) => s + p.valor, 0);
  const totalDesp = desps.reduce((s, d) => s + d.valor, 0);
  const lucro = fat - totalDesp;
  const margem = fat ? (lucro / fat) * 100 : 0;
  const atend = crm.filter(c => c.status === 'Atendeu').length;
  const conv = crm.length ? (atend / crm.length) * 100 : 0;
  const ticket = pacs.length ? fat / pacs.length : 0;

  const statusIcon = (real, meta, inverted = false) => {
    if (!meta) return '—';
    const ok = inverted ? real <= meta : real >= meta;
    return ok ? '<span class="text-green-600">✅ Meta</span>' : '<span class="text-red-500">❌ Abaixo</span>';
  };

  // ===== Quebra por procedimento =====
  const procMap = {};
  pacs.forEach(p => {
    const k = p.tipo || '(sem procedimento)';
    if (!procMap[k]) procMap[k] = { qtd: 0, total: 0 };
    procMap[k].qtd++;
    procMap[k].total += (p.valor || 0);
  });
  const procStats = Object.entries(procMap).map(([nome, v]) => ({ nome, ...v, ticket: v.qtd ? v.total / v.qtd : 0, pct: fat ? (v.total / fat) * 100 : 0 })).sort((a, b) => b.total - a.total);

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
  // "Recorrente" = paciente com pelo menos 1 atendimento ANTES do mês selecionado
  const inicioDoMes = mes + '-01';
  const nomesAnteriores = new Set(
    todosPacs.filter(p => p.data < inicioDoMes).map(p => (p.nome || '').toLowerCase().trim())
  );
  const pacsNovos = pacs.filter(p => !nomesAnteriores.has((p.nome || '').toLowerCase().trim()));
  const pacsRecorrentes = pacs.filter(p => nomesAnteriores.has((p.nome || '').toLowerCase().trim()));
  const fatNovos = pacsNovos.reduce((s, p) => s + (p.valor || 0), 0);
  const fatRecorrentes = pacsRecorrentes.reduce((s, p) => s + (p.valor || 0), 0);
  // Conta pacientes únicos
  const novosUnicos = new Set(pacsNovos.map(p => (p.nome || '').toLowerCase().trim())).size;
  const recUnicos = new Set(pacsRecorrentes.map(p => (p.nome || '').toLowerCase().trim())).size;

  document.getElementById('relatorio-content').innerHTML = `
    <div class="chart-card">
      <h3 class="font-bold text-gray-800 mb-4 text-base">1. Resultado Financeiro</h3>
      <table class="w-full text-sm">
        <thead><tr class="border-b"><th class="text-left py-2 text-gray-600">Indicador</th><th class="text-right py-2 text-gray-600">Realizado</th><th class="text-right py-2 text-gray-600">Meta</th><th class="text-right py-2 text-gray-600">% Meta</th><th class="text-right py-2 text-gray-600">Status</th></tr></thead>
        <tbody>
          <tr class="border-b border-gray-50"><td class="py-2 text-gray-700">Faturamento</td><td class="py-2 text-right font-semibold">${BRL(fat)}</td><td class="py-2 text-right text-gray-500">${BRL(metas.fat)}</td><td class="py-2 text-right">${metas.fat ? PCT((fat/metas.fat)*100) : '—'}</td><td class="py-2 text-right">${statusIcon(fat, metas.fat)}</td></tr>
          <tr class="border-b border-gray-50"><td class="py-2 text-gray-700">Despesas Totais</td><td class="py-2 text-right font-semibold text-red-600">${BRL(totalDesp)}</td><td class="py-2 text-right text-gray-500">${BRL(metas.desp)}</td><td class="py-2 text-right">${metas.desp ? PCT((totalDesp/metas.desp)*100) : '—'}</td><td class="py-2 text-right">${statusIcon(totalDesp, metas.desp, true)}</td></tr>
          <tr class="border-b border-gray-50"><td class="py-2 font-semibold text-gray-800">Lucro Líquido</td><td class="py-2 text-right font-bold text-green-600">${BRL(lucro)}</td><td class="py-2 text-right text-gray-500">—</td><td class="py-2 text-right">—</td><td class="py-2 text-right">—</td></tr>
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
          <tr class="border-b border-gray-50"><td class="py-2 text-gray-700">Ticket médio</td><td class="py-2 text-right font-semibold">${BRL(ticket)}</td><td class="py-2 text-right text-gray-500">—</td><td class="py-2 text-right">—</td><td class="py-2 text-right">—</td></tr>
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
              <td class="py-2 text-gray-700">${s.nome}</td>
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
    </div>`;
}

function updateRelatorio(val) { renderRelatorio(val); }

// ====================== METAS ======================
function saveMetas(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  DB.setObj('metas', { fat: parseFloat(fd.get('metaFat')) || 0, pac: parseInt(fd.get('metaPac')) || 0, desp: parseFloat(fd.get('metaDesp')) || 0 });
  closeModal('modal-metas');
  renderMetas();
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
    const fat = pacs.reduce((s, p) => s + p.valor, 0);
    const desp = desps.reduce((s, d) => s + d.valor, 0);
    const lucro = fat - desp;
    const margem = fat ? (lucro / fat) * 100 : 0;
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
      <td style="font-weight:500;color:#0f172a;">${p.nome}</td>
      <td style="color:#64748b;">${formatDate(p.data)}</td>
      <td><span class="badge badge-blue">${p.tipo}</span></td>
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
  const today  = new Date().toISOString().split('T')[0];
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
  const mesAnt   = new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1).toISOString().substring(0,7);
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
  return `Você é a MaestrIA, assistente inteligente do consultório de geriatria do Dr. Rafael Duncan.
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

  const key = localStorage.getItem('consult_gemini_key');
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

  if (tipo === 'criar_paciente') {
    const arr = DB.get('pacientes'); arr.unshift(dados); DB.set('pacientes', arr);
    appendChatMsg('system-ok', `✅ Atendimento de ${dados.nome} registrado — ${BRL(dados.valor)}`);
    if (document.getElementById('page-pacientes').classList.contains('active')) renderPacientes();
    renderDashboard();

  } else if (tipo === 'criar_crm') {
    const arr = DB.get('crm'); arr.unshift(dados); DB.set('crm', arr);
    appendChatMsg('system-ok', `✅ ${dados.nome} adicionado ao CRM`);
    if (document.getElementById('page-crm').classList.contains('active')) renderCrm();

  } else if (tipo === 'criar_followup') {
    const arr = DB.get('followup'); arr.unshift({ ...dados, feito: false }); DB.set('followup', arr);
    appendChatMsg('system-ok', `✅ Follow-up de ${dados.nome} criado para ${formatDate(dados.dataContato)}`);
    if (document.getElementById('page-followup').classList.contains('active')) renderFollowup();

  } else if (tipo === 'criar_despesa') {
    const arr = DB.get('despesas'); arr.unshift(dados); DB.set('despesas', arr);
    appendChatMsg('system-ok', `✅ Despesa "${dados.descricao}" de ${BRL(dados.valor)} registrada`);
    if (document.getElementById('page-despesas').classList.contains('active')) renderDespesas();

  } else if (tipo === 'atualizar_status_crm') {
    const arr = DB.get('crm');
    const alvo = (dados.nome || '').toLowerCase().trim();
    const idx = alvo ? arr.findIndex(c => (c.nome || '').toLowerCase().includes(alvo)) : -1;
    if (idx >= 0) {
      arr[idx].status = dados.novoStatus; DB.set('crm', arr);
      appendChatMsg('system-ok', `✅ ${arr[idx].nome} → "${dados.novoStatus}"`);
      if (document.getElementById('page-crm').classList.contains('active')) renderCrm();
    } else {
      appendChatMsg('system-ok', `⚠️ Não achei "${dados.nome}" no CRM. Quer que eu crie esse contato? Me passe os dados.`);
    }

  } else if (tipo === 'criar_agendamento') {
    const id = _agId();
    const item = {
      id,
      data: dados.data || new Date().toISOString().split('T')[0],
      hora: dados.hora || '08:00',
      duracao: parseInt(dados.duracao) || getAgConfig().slotDuracao || 60,
      pacienteNome: (dados.pacienteNome || dados.nome || '').trim(),
      whatsapp: dados.whatsapp || '',
      procedimento: dados.procedimento || '',
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
    appendChatMsg('system-ok', `✅ ${item.pacienteNome} agendado para ${item.data} às ${item.hora} (${item.procedimento || 'sem procedimento'})`);
    if (document.getElementById('page-agenda').classList.contains('active')) renderAgenda();

  } else if (tipo === 'cancelar_agendamento') {
    const ags = getAgendamentos();
    const alvo = (dados.pacienteNome || dados.nome || '').toLowerCase().trim();
    const idx = ags.findIndex(a =>
      (a.pacienteNome||'').toLowerCase().includes(alvo) &&
      a.status !== 'Cancelado' &&
      (!dados.data || a.data === dados.data)
    );
    if (idx >= 0) {
      const nome = ags[idx].pacienteNome;
      const dt   = ags[idx].data;
      ags[idx].status = 'Cancelado';
      DB.set('agendamentos', ags);
      appendChatMsg('system-ok', `✅ Agendamento de ${nome} em ${dt} cancelado`);
      if (document.getElementById('page-agenda').classList.contains('active')) renderAgenda();
    } else {
      appendChatMsg('system-ok', `⚠️ Não achei agendamento ativo para "${dados.pacienteNome || dados.nome}". Verifique na agenda.`);
    }

  } else if (tipo === 'mover_agendamento') {
    const ags = getAgendamentos();
    const alvo = (dados.pacienteNome || dados.nome || '').toLowerCase().trim();
    const idx = ags.findIndex(a =>
      (a.pacienteNome||'').toLowerCase().includes(alvo) &&
      a.status !== 'Cancelado'
    );
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
      appendChatMsg('system-ok', `⚠️ Não achei agendamento ativo para "${dados.pacienteNome || dados.nome}".`);
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
    const alvo = (dados.nome || '').toLowerCase().trim();
    const idx = alvo ? arr.findIndex(p => (p.nome||'').toLowerCase().includes(alvo)) : -1;
    if (idx >= 0) {
      if (dados.novoStatus) arr[idx].statusPgto = dados.novoStatus;
      if (dados.valor)      arr[idx].valor = parseFloat(dados.valor);
      if (dados.pagamento)  arr[idx].pagamento = dados.pagamento;
      DB.set('pacientes', arr);
      appendChatMsg('system-ok', `✅ Pagamento de ${arr[idx].nome} atualizado → ${dados.novoStatus || 'atualizado'}`);
      if (document.getElementById('page-pacientes').classList.contains('active')) renderPacientes();
      renderDashboard();
    } else {
      appendChatMsg('system-ok', `⚠️ Não achei "${dados.nome}" nos atendidos.`);
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
    const key = localStorage.getItem('consult_gemini_key');
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
        const hora = new Date().getHours();
        const saudacao = hora < 12 ? 'Bom dia' : hora < 18 ? 'Boa tarde' : 'Boa noite';
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
  localStorage.setItem('consult_gemini_key', key);
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
  const existingKey = localStorage.getItem('consult_gemini_key') || '';
  document.getElementById('gemini-key-input').value = existingKey;
}

// ====================== INIT ======================
// ====================== BACKUP ======================

const BACKUP_KEYS = ['pacientes','crm','despesas','followup','agendamentos','bloqueios','procedimentos','agenda_config','metas','chat_history'];

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
}

function exportarJSON() {
  const dados = {};
  BACKUP_KEYS.forEach(k => {
    const raw = localStorage.getItem('consult_' + k);
    if (raw) dados[k] = JSON.parse(raw);
  });
  dados._meta = {
    versao: '1.0',
    exportadoEm: new Date().toISOString(),
    app: 'Consultório App',
  };
  const blob = new Blob([JSON.stringify(dados, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  const hoje = new Date().toISOString().split('T')[0];
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
  const hoje = new Date().toISOString().split('T')[0];
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
  reader.onload = (e) => {
    try {
      const dados = JSON.parse(e.target.result);
      if (!dados || typeof dados !== 'object') throw new Error('Arquivo inválido');

      const chavesTrocar = BACKUP_KEYS.filter(k => dados[k] !== undefined);
      if (!chavesTrocar.length) throw new Error('Nenhum dado reconhecido no arquivo');

      const exportadoEm = dados._meta?.exportadoEm ? new Date(dados._meta.exportadoEm).toLocaleString('pt-BR') : 'data desconhecida';
      if (!confirm(`Restaurar backup de ${exportadoEm}?\n\nIsso vai substituir:\n${chavesTrocar.join(', ')}\n\nSeus dados atuais serão apagados. Confirma?`)) {
        status.textContent = 'Importação cancelada.';
        input.value = '';
        return;
      }

      chavesTrocar.forEach(k => DB.set(k, dados[k]));
      status.textContent = `✅ Restaurado com sucesso! (${chavesTrocar.length} seções)`;
      toast('✅ Backup restaurado! Recarregando…', 2000);
      setTimeout(() => location.reload(), 2000);
    } catch(err) {
      status.textContent = `❌ Erro: ${err.message}`;
      toast('❌ Arquivo inválido ou corrompido.', 3000);
    }
    input.value = '';
  };
  reader.readAsText(file);
}

function limparTodosDados() {
  if (!confirm('⚠️ Tem certeza? Isso apaga TODOS os dados do consultório permanentemente.\n\nFaça um backup antes de continuar!')) return;
  if (!confirm('Segunda confirmação: apagar tudo mesmo?')) return;
  BACKUP_KEYS.forEach(k => localStorage.removeItem('consult_' + k));
  toast('Todos os dados foram apagados.', 2500);
  setTimeout(() => location.reload(), 2500);
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
  const labels = Array.from({length: diasNoMes}, (_, i) => i + 1);

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
        x: { grid: { display: false }, ticks: { font: { size: 10 }, maxTicksLimit: 10 } },
        y: { ticks: { font: { size: 10 }, callback: v => 'R$' + (v/1000).toFixed(0) + 'k' }, grid: { color: '#f1f5f9' } },
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
        x: { grid: { display: false }, ticks: { font: { size: 11 } } },
        y: { beginAtZero: true, ticks: { font: { size: 10 }, stepSize: 1 }, grid: { color: '#f1f5f9' } },
      },
    },
  });
}

async function saudacaoDiaria() {
  const key = localStorage.getItem('consult_gemini_key');
  if (!key) return;
  const hoje = new Date().toISOString().split('T')[0];
  const ultimaSaudacao = localStorage.getItem('consult_saudacao_dia');
  if (ultimaSaudacao === hoje) return; // já saudou hoje

  // Espera 1.5s para o app carregar antes de abrir a Sofia
  await new Promise(r => setTimeout(r, 1500));

  const ctx = buildContext();
  const hora = new Date().getHours();
  const saudacao = hora < 12 ? 'Bom dia' : hora < 18 ? 'Boa tarde' : 'Boa noite';

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

  appendChatMsg('sofia', `${saudacao}, Dr. Rafael! 👋 ${resumo}. Como posso ajudar?`);
  localStorage.setItem('consult_saudacao_dia', hoje);
}

document.addEventListener('DOMContentLoaded', async () => {
  // Inicializa Supabase
  initSupabase();

  // Fecha modais ao clicar fora
  document.querySelectorAll('.modal-overlay').forEach(el => {
    el.addEventListener('click', (e) => { if (e.target === el) el.style.display = 'none'; });
  });

  // Verifica sessão existente
  const temSessao = await checkSession();

  if (temSessao) {
    // Já logado: sincroniza e abre o app
    await cloudPull();
    _iniciarApp();
  } else {
    // Mostra tela de login (já visível por padrão)
    // Foca o campo e-mail
    const emailEl = document.getElementById('login-email');
    if (emailEl) setTimeout(() => emailEl.focus(), 100);
  }
});
