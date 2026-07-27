// Testes do resumo financeiro (caixa × competência) — rode com: node --test
// Exercitam o código REAL recortado do app.js (ver tests/_extrair.js).

const { test } = require('node:test');
const assert = require('node:assert');
const { carregar } = require('./_extrair.js');

// Lançamentos de exemplo cobrindo os 4 status.
const PACS = [
  { statusPgto: 'Pago',     valor: 1000 },
  { statusPgto: 'Pago',     valor: 500 },
  { statusPgto: 'Parcial',  valor: 7200 },  // assinatura: valor cheio, parcialmente paga
  { statusPgto: 'Pendente', valor: 300 },
  { statusPgto: 'Isento',   valor: 200 },   // cortesia: não é receita
];

test('_resumoFin: buckets fecham com o bruto (Parcial não some)', () => {
  const { _resumoFin } = carregar(['_centavos', '_resumoFin']);
  const r = _resumoFin(PACS);
  assert.strictEqual(r.pago, 1500);
  assert.strictEqual(r.parcial, 7200);
  assert.strictEqual(r.pendente, 300);
  assert.strictEqual(r.isento, 200);
  assert.strictEqual(r.bruto, 9200);
  // A regra de ouro: recebido + a receber + isento === bruto
  assert.strictEqual(r.recebido + r.aReceber + r.isento, r.bruto);
});

test('_resumoFin: caixa é só Pago; competência é Pago+Parcial+Pendente', () => {
  const { _resumoFin } = carregar(['_centavos', '_resumoFin']);
  const r = _resumoFin(PACS);
  assert.strictEqual(r.recebido, 1500);          // CAIXA
  assert.strictEqual(r.aReceber, 7500);          // Parcial(7200) + Pendente(300)
  assert.strictEqual(r.faturado, 9000);          // COMPETÊNCIA (bruto − isento)
  assert.strictEqual(r.faturado, r.bruto - r.isento);
});

// A regra de ouro com valores REAIS, com centavos. O teste acima usa números
// redondos e por isso passava mesmo quando os baldes divergiam do bruto:
// somar float acumula resíduo, e com 60 lançamentos a diferença chegava a
// 1e-10. Não aparecia na tela (o BRL corta em 2 casas), mas a invariante
// documentada é uma comparação exata — e o teste dava confiança que não tinha.
test('_resumoFin: a regra de ouro fecha com valores em centavos', () => {
  const { _resumoFin } = carregar(['_centavos', '_resumoFin']);
  const comCentavos = [
    { statusPgto: 'Pago',     valor: 1234.56 },
    { statusPgto: 'Pago',     valor: 78.91 },
    { statusPgto: 'Parcial',  valor: 0.1 },
    { statusPgto: 'Parcial',  valor: 0.2 },
    { statusPgto: 'Pendente', valor: 300.03 },
    { statusPgto: 'Isento',   valor: 99.99 },
  ];
  const r = _resumoFin(comCentavos);
  assert.strictEqual(r.recebido + r.aReceber + r.isento, r.bruto);
  assert.strictEqual(r.parcial, 0.3, '0.1 + 0.2 tem de dar 0.3, não 0.30000000000000004');
  assert.strictEqual(r.faturado, r.bruto - r.isento);
});

// Varredura com centenas de lançamentos aleatórios. A tolerância é MEIO CENTAVO,
// não zero: `recebido + aReceber + isento` é uma soma de floats feita fora da
// função, e nenhum arredondamento interno torna isso bit a bit idêntico ao
// bruto. Exigir === aqui seria exigir o impossível — a garantia real, e a única
// que importa pra contabilidade, é fechar ao centavo. Sem o _centavos na saída
// a diferença passava de 1e-10; se alguém tirar o arredondamento, o teste do
// balde individual (0.1 + 0.2 === 0.3) cai primeiro.
test('_resumoFin: os baldes fecham com o bruto ao centavo, em qualquer volume', () => {
  const { _resumoFin } = carregar(['_centavos', '_resumoFin']);
  const status = ['Pago', 'Parcial', 'Pendente', 'Isento'];
  // Sequência determinística — teste que muda de resultado a cada rodada não serve.
  let semente = 42;
  const proximo = () => (semente = (semente * 1103515245 + 12345) % 2147483648) / 2147483648;
  let pior = 0;
  for (let caso = 0; caso < 300; caso++) {
    const n = 5 + Math.floor(proximo() * 80);
    const pacs = Array.from({ length: n }, () => ({
      statusPgto: status[Math.floor(proximo() * 4)],
      valor: Math.round(proximo() * 500000) / 100,
    }));
    const r = _resumoFin(pacs);
    const dif = Math.abs((r.recebido + r.aReceber + r.isento) - r.bruto);
    pior = Math.max(pior, dif);
    assert.ok(dif < 0.005,
      `caso ${caso} com ${n} lançamentos: diferença de ${dif} entre os baldes e o bruto`);
  }
  assert.ok(pior < 0.005, `pior diferença observada: ${pior}`);
});

test('_resumoFin: lista vazia não quebra', () => {
  const { _resumoFin } = carregar(['_centavos', '_resumoFin']);
  const r = _resumoFin([]);
  assert.deepStrictEqual(
    { recebido: r.recebido, aReceber: r.aReceber, faturado: r.faturado, bruto: r.bruto },
    { recebido: 0, aReceber: 0, faturado: 0, bruto: 0 });
});

test('_lucroFin: lucro caixa usa recebido; lucro competência usa faturado', () => {
  const { _resumoFin, _lucroFin } = carregar(['_centavos', '_resumoFin', '_lucroFin']);
  const r = _resumoFin(PACS);
  const l = _lucroFin(r, 1000); // despesas do período
  assert.strictEqual(l.caixa, 500);          // 1500 − 1000
  assert.strictEqual(l.competencia, 8000);   // 9000 − 1000
  // a diferença entre os regimes é exatamente o que ainda não entrou no caixa
  assert.strictEqual(l.competencia - l.caixa, r.aReceber);
});

test('_lucroFin: margens não estouram com receita zero', () => {
  const { _resumoFin, _lucroFin } = carregar(['_centavos', '_resumoFin', '_lucroFin']);
  const l = _lucroFin(_resumoFin([]), 500);
  assert.strictEqual(l.margemCaixa, 0);
  assert.strictEqual(l.margemCompetencia, 0);
});

// O dropdown precisa OFERECER todos os status que o app grava. Faltando
// 'Parcial', nenhuma <option> ficava selecionada, o <select> exibia a primeira
// ("Pago") e qualquer toque gravava por cima, destruindo o status sem volta.
test('pgtoSelect: Parcial existe e vem selecionado', () => {
  const { pgtoSelect } = carregar('pgtoSelect');
  const html = pgtoSelect('Parcial', 0);
  assert.match(html, /<option value="Parcial" selected>/,
    'Parcial precisa existir no dropdown E vir selecionado');
});

test('pgtoSelect: todo status gravado pelo app tem opção própria', () => {
  const { pgtoSelect } = carregar('pgtoSelect');
  for (const st of ['Pago', 'Parcial', 'Pendente', 'Isento']) {
    assert.match(pgtoSelect(st, 0), new RegExp(`<option value="${st}" selected>`),
      `${st} deveria vir selecionado`);
  }
});

test('pgtoSelect: status ausente cai em Pendente (e não em Pago)', () => {
  const { pgtoSelect } = carregar('pgtoSelect');
  for (const vazio of [null, undefined, '', 'null']) {
    assert.match(pgtoSelect(vazio, 0), /<option value="Pendente" selected>/);
  }
});

// A importação de planilha só pode produzir status que o resto do app entende.
// 'Parcelado' não existia em lugar nenhum: o lançamento entrava no bruto mas
// ficava fora de TODOS os baldes de _resumoFin — dinheiro invisível.
const STATUS_CANONICOS = ['Pago', 'Parcial', 'Pendente', 'Isento'];

test('impNormStatus: nunca inventa status fora do canônico', () => {
  const { impNormStatus } = carregar('impNormStatus');
  const entradas = ['pago', 'PAGO', 'recebido', 'parcelado', 'Parcial', 'pendente',
                    'isento', 'cortesia', '', null, undefined, 'qualquer coisa'];
  for (const e of entradas) {
    assert.ok(STATUS_CANONICOS.includes(impNormStatus(e)),
      `impNormStatus(${JSON.stringify(e)}) devolveu "${impNormStatus(e)}", fora do canônico`);
  }
});

test('impNormStatus: parcelado vira Parcial, cortesia vira Isento', () => {
  const { impNormStatus } = carregar('impNormStatus');
  assert.strictEqual(impNormStatus('Parcelado'), 'Parcial');
  assert.strictEqual(impNormStatus('parcelado em 3x'), 'Parcial');
  assert.strictEqual(impNormStatus('cortesia'), 'Isento');
  assert.strictEqual(impNormStatus('isento'), 'Isento');
  assert.strictEqual(impNormStatus('pago'), 'Pago');
  assert.strictEqual(impNormStatus(''), 'Pendente');
});

// TICKET MÉDIO em duas leituras. Retorno é gratuito por padrão, então dividir
// tudo pelo total de atendimentos derrubava o número pela metade sem aviso.
const MES_COM_RETORNOS = [
  { nome: 'Ana',   data: '2026-08-03', valor: 500 },  // consulta paga
  { nome: 'Bruno', data: '2026-08-05', valor: 500 },  // consulta paga
  { nome: 'Ana',   data: '2026-08-18', valor: 0   },  // retorno gratuito
  { nome: 'Bruno', data: '2026-08-20', valor: 0   },  // retorno gratuito
];

test('_ticketMedio: consulta paga não é diluída pelos retornos gratuitos', () => {
  const { _ticketMedio } = carregar('_ticketMedio');
  const t = _ticketMedio(MES_COM_RETORNOS);
  assert.strictEqual(t.porConsultaPaga, 500, 'preço praticado');
  assert.strictEqual(t.porAtendimento, 250, 'rendimento por cadeira ocupada');
  assert.strictEqual(t.qtdPagas, 2);
  assert.strictEqual(t.qtdGratuitos, 2);
});

test('_ticketMedio: sem gratuitos as duas leituras coincidem', () => {
  const { _ticketMedio } = carregar('_ticketMedio');
  const t = _ticketMedio([{ valor: 300 }, { valor: 500 }]);
  assert.strictEqual(t.porConsultaPaga, 400);
  assert.strictEqual(t.porAtendimento, 400);
  assert.strictEqual(t.qtdGratuitos, 0);
});

test('_ticketMedio: lista vazia e só-gratuitos não dividem por zero', () => {
  const { _ticketMedio } = carregar('_ticketMedio');
  const vazio = _ticketMedio([]);
  assert.strictEqual(vazio.porConsultaPaga, 0);
  assert.strictEqual(vazio.porAtendimento, 0);
  const soGratis = _ticketMedio([{ valor: 0 }, { valor: 0 }]);
  assert.strictEqual(soGratis.porConsultaPaga, 0, 'sem consulta paga, não é NaN');
  assert.strictEqual(soGratis.porAtendimento, 0);
});

// PACIENTE NOVO = nunca foi atendido antes (primeiro atendimento cai no mês).
// O bug: qualquer atendimento de quem um dia veio do CRM contava como aquisição
// nova do mês, então retorno de paciente antigo inflava CAC e ROI.
const BASE = [
  { nome: 'Ana',      data: '2026-05-10', valor: 400 },  // 1ª vez em maio
  { nome: 'Ana',      data: '2026-08-04', valor: 0   },  // retorno em agosto
  { nome: 'Bruno',    data: '2026-08-12', valor: 500 },  // 1ª vez em agosto
  { nome: '  bruno ', data: '2026-08-20', valor: 0   },  // retorno no mesmo mês
  { nome: 'Célia',    data: '2026-08-15', valor: 300 },  // 1ª vez em agosto
  { nome: '',         data: '2026-08-15', valor: 999 },  // sem nome: ignorar
];

test('_novosNoMes: retorno de paciente antigo NÃO conta como novo', () => {
  const { _novosNoMes } = carregar(['_novosNoMes', 'getMes']);
  const r = _novosNoMes(BASE, '2026-08');
  assert.strictEqual(r.quantidade, 2, 'só Bruno e Célia estrearam em agosto');
  assert.ok(!r.atendimentos.some(p => (p.nome || '').trim() === 'Ana'),
    'Ana estreou em maio — o retorno dela em agosto não é aquisição');
});

test('_novosNoMes: mesma pessoa 2x no mês conta 1, mas soma a receita', () => {
  const { _novosNoMes } = carregar(['_novosNoMes', 'getMes']);
  const r = _novosNoMes(BASE, '2026-08');
  assert.strictEqual(r.quantidade, 2);          // Bruno (2 atendimentos) + Célia
  assert.strictEqual(r.receita, 800);           // 500 + 0 (Bruno) + 300 (Célia)
});

test('_novosNoMes: mês da estreia conta a própria estreia', () => {
  const { _novosNoMes } = carregar(['_novosNoMes', 'getMes']);
  const r = _novosNoMes(BASE, '2026-05');
  assert.strictEqual(r.quantidade, 1);
  assert.strictEqual(r.receita, 400);
});

test('_novosNoMes: base vazia e mês sem estreia não quebram', () => {
  const { _novosNoMes } = carregar(['_novosNoMes', 'getMes']);
  assert.strictEqual(_novosNoMes([], '2026-08').quantidade, 0);
  assert.strictEqual(_novosNoMes(BASE, '2026-07').quantidade, 0);
  assert.strictEqual(_novosNoMes(null, '2026-08').receita, 0);
});

// IMPORTAÇÃO DE DATA. O `instanceof Date` estava DEPOIS do String(s), então
// nunca era verdade: a data que o SheetJS entrega como objeto Date virava o
// texto "Mon Aug 03 2026 ...", não casava com nenhum formato e voltava ''.
// Como impExecute descarta linha sem data, um .xlsx com coluna de data de
// verdade importava ZERO linhas — e a tela dizia que estavam todas "sem data".
const IMP_DATA = ['_ymd', 'impNormDate'];
// O sandbox do node:vm tem realm próprio: sem passar o MESMO Date do teste,
// o `s instanceof Date` lá dentro compara com outro construtor e dá falso.
const impData = () => carregar(IMP_DATA, { String, Date, parseInt, isNaN });

test('impNormDate: Date do SheetJS não pode voltar vazia', () => {
  const { impNormDate } = impData();
  assert.strictEqual(impNormDate(new Date(2026, 7, 3)), '2026-08-03');
});

// SheetJS monta a data em hora local (new Date(ano, mes, dia)). Usar
// toISOString aí devolveria o dia ANTERIOR em fuso negativo — o erro que o
// _ymd existe pra evitar. Planilha gerada com UTC:true chega em meia-noite UTC
// e aí a leitura UTC é a certa. As duas têm de cair no mesmo dia.
test('impNormDate: data local e data ancorada em UTC caem no mesmo dia', () => {
  const { impNormDate } = impData();
  assert.strictEqual(impNormDate(new Date(2026, 7, 3)), '2026-08-03', 'meia-noite local');
  assert.strictEqual(impNormDate(new Date(Date.UTC(2026, 7, 3))), '2026-08-03', 'meia-noite UTC');
  // Virada de ano é onde o deslocamento de fuso aparece primeiro.
  assert.strictEqual(impNormDate(new Date(2026, 0, 1)), '2026-01-01');
  assert.strictEqual(impNormDate(new Date(Date.UTC(2026, 0, 1))), '2026-01-01');
});

test('impNormDate: formatos de texto e serial do Excel seguem funcionando', () => {
  const { impNormDate } = impData();
  assert.strictEqual(impNormDate('03/08/2026'), '2026-08-03', 'DD/MM/YYYY');
  assert.strictEqual(impNormDate('3-8-2026'), '2026-08-03', 'DD-M-YYYY sem zero à esquerda');
  assert.strictEqual(impNormDate('2026-08-03'), '2026-08-03', 'já no formato final');
  assert.strictEqual(impNormDate(46237), '2026-08-03', 'serial do Excel');
});

test('impNormDate: vazio, lixo e Date inválida devolvem string vazia', () => {
  const { impNormDate } = impData();
  for (const ruim of ['', null, undefined, 'quinta-feira', new Date('nao-e-data')]) {
    assert.strictEqual(impNormDate(ruim), '', `entrada ${String(ruim)}`);
  }
});

// IMPORTAÇÃO DE TELEFONE. A importação usava slice(-11) — "os últimos 11
// dígitos" — que só vale pra celular. Fixo com DDI tem 12 dígitos (55 + DDD +
// 8) e sobrava um "5" solto na frente. O número gravado não casava com o
// contato do CRM (indexado por _normPhone) e o _waMeLink montava um link pra
// DDD de outro estado.
test('importação de telefone: fixo com DDI não pode sobrar um 5 na frente', () => {
  const { _normPhone } = carregar('_normPhone');
  assert.strictEqual(_normPhone('551133334444'), '1133334444', 'fixo SP com DDI');
  assert.notStrictEqual(_normPhone('551133334444'), '51133334444', 'o slice(-11) dava isto');
  assert.strictEqual(_normPhone('+55 (11) 3333-4444'), '1133334444', 'com máscara');
});

test('importação de telefone: o link do WhatsApp aponta pro DDD certo', () => {
  const { _normPhone, _waMeLink } = carregar(['_normPhone', '_waMeLink'], { encodeURIComponent });
  // O que a importação grava é o que o _waMeLink vai ler depois.
  const gravado = _normPhone('551133334444');
  assert.strictEqual(_waMeLink(gravado), 'https://wa.me/551133334444');
});

// Os testes acima provam que _normPhone está certo — mas o bug era o PONTO DE
// CHAMADA: impExecute usava slice(-11) direto. impExecute mexe em DOM e toast,
// não dá pra rodar no sandbox, então aqui o guarda é no código-fonte mesmo.
// Sem isto, voltar o slice(-11) passaria pela suíte inteira sem reprovar nada.
test('impExecute: normaliza telefone com _normPhone, não com slice(-11)', () => {
  const { recortarFuncao } = require('./_extrair.js');
  // Sem os comentários: o próprio comentário da correção cita o slice(-11).
  const src = recortarFuncao('impExecute').replace(/\/\/[^\n]*/g, '');
  assert.match(src, /whatsapp:\s*m\.whatsapp\s*\?\s*_normPhone\(/,
    'o telefone importado tem de passar pelo _normPhone');
  assert.doesNotMatch(src, /slice\(-11\)/,
    'slice(-11) quebra fixo com DDI — 551133334444 vira 51133334444');
});

test('importação de telefone: celular e número sem DDI seguem inalterados', () => {
  const { _normPhone } = carregar('_normPhone');
  assert.strictEqual(_normPhone('5511987654321'), '11987654321', 'celular com DDI');
  assert.strictEqual(_normPhone('11987654321'), '11987654321', 'celular sem DDI');
  assert.strictEqual(_normPhone('1133334444'), '1133334444', 'fixo sem DDI');
  assert.strictEqual(_normPhone('555532201234'), '5532201234', 'fixo do DDD 55 com DDI');
  assert.strictEqual(_normPhone(''), '');
});

// IMPORTAÇÃO DE VALOR. Todo ponto era lido como separador de milhar, então
// "1234.56" virava 123456 — cem vezes maior, calado. E esse é o formato que o
// exportarCSV deste app escreve: exportar e reimportar inflava o faturamento.
test('impNormValor: ponto decimal não vira milhar (o bug dos 100x)', () => {
  const { impNormValor } = carregar('impNormValor');
  assert.strictEqual(impNormValor('1234.56'), 1234.56);
  assert.strictEqual(impNormValor('1.50'), 1.5);
  assert.strictEqual(impNormValor('0.99'), 0.99);
});

test('impNormValor: ponto de milhar continua sendo milhar', () => {
  const { impNormValor } = carregar('impNormValor');
  assert.strictEqual(impNormValor('1.500'), 1500, 'R$ 1.500 — três casas é milhar');
  assert.strictEqual(impNormValor('1.234.567'), 1234567, 'mais de um ponto é milhar');
});

test('impNormValor: com os dois separadores, o da direita é o decimal', () => {
  const { impNormValor } = carregar('impNormValor');
  assert.strictEqual(impNormValor('1.234,56'), 1234.56, 'pt-BR');
  assert.strictEqual(impNormValor('1,234.56'), 1234.56, 'en-US');
  assert.strictEqual(impNormValor('1.234.567,89'), 1234567.89);
  assert.strictEqual(impNormValor('R$ 1.234,56'), 1234.56, 'com símbolo e espaço');
});

test('impNormValor: vírgula sozinha segue decimal (leitura pt-BR)', () => {
  const { impNormValor } = carregar('impNormValor');
  assert.strictEqual(impNormValor('1234,56'), 1234.56);
  assert.strictEqual(impNormValor('1234,5'), 1234.5);
});

test('impNormValor: negativo, vazio e lixo não viram NaN', () => {
  const { impNormValor } = carregar('impNormValor');
  assert.strictEqual(impNormValor('-500,50'), -500.5);
  assert.strictEqual(impNormValor(''), 0);
  assert.strictEqual(impNormValor(null), 0);
  assert.strictEqual(impNormValor('grátis'), 0);
  assert.strictEqual(impNormValor(1234.567), 1234.57, 'número já vem arredondado a centavos');
});

// O ciclo fechado: o que o app exporta tem de voltar igual quando reimportado.
test('exportar e reimportar o próprio CSV preserva o valor', () => {
  const { impParseCSV, impNormValor } = carregar(['impParseCSV', 'impNormValor']);
  const registro = { nome: 'Ana', data: '2026-08-03', valor: 1234.56 };
  // Mesma serialização do exportarCSV: String(v), separador ';'
  const cols = Object.keys(registro);
  const csv = [cols.join(';'), cols.map(c => String(registro[c])).join(';')].join('\n');
  const lido = impParseCSV(csv);
  assert.strictEqual(impNormValor(lido.rows[0].valor), 1234.56,
    'exportar e reimportar não pode multiplicar o faturamento por 100');
});

// O status importado tem de fechar com _resumoFin — é o acoplamento que
// quebrava: importava, o bruto subia e "Recebido" continuava zerado.
test('importação alimenta os baldes de _resumoFin', () => {
  const { impNormStatus } = carregar('impNormStatus');
  const { _resumoFin } = carregar(['_centavos', '_resumoFin']);
  const importados = [
    { statusPgto: impNormStatus('pago'),      valor: 1000 },
    { statusPgto: impNormStatus('parcelado'), valor: 500 },
    { statusPgto: impNormStatus('pendente'),  valor: 300 },
    { statusPgto: impNormStatus('cortesia'),  valor: 200 },
  ];
  const r = _resumoFin(importados);
  assert.strictEqual(r.recebido + r.aReceber + r.isento, r.bruto, 'a regra de ouro tem de fechar');
  assert.strictEqual(r.recebido, 1000);
  assert.strictEqual(r.aReceber, 800);
});

// ---------- o <select> do modal precisa OFERECER todo status que o app grava ----------
// Mesmo bug que já foi corrigido no pgtoSelect (dropdown da tabela), mas o
// <select> estático do modal de atendimento ficou de fora: não tinha 'Parcial'.
// Atribuir um valor que não existe entre as <option> deixa selectedIndex = -1,
// o campo aparece em branco e o FormData devolve '' no save — o status é
// destruído. E valor com status fora do canônico fica FORA de todos os baldes
// de _resumoFin: o dinheiro some dos relatórios.
test('modal de atendimento: o select oferece os 4 status canônicos', () => {
  const fs = require('node:fs'), path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const m = /<select class="select" name="statusPgto">([\s\S]*?)<\/select>/.exec(html);
  assert.ok(m, 'o select de status tem de existir no modal');
  for (const st of ['Pago', 'Parcial', 'Pendente', 'Isento']) {
    assert.ok(m[1].includes('<option>' + st + '</option>'),
      `${st} falta no select — quem tem esse status perde ele ao salvar`);
  }
});

test('_statusPgtoCanonico: valor de fora vira Pendente, nunca Pago', () => {
  const { _statusPgtoCanonico } = carregar(['const:STATUS_PGTO', '_statusPgtoCanonico']);
  for (const st of ['Pago', 'Parcial', 'Pendente', 'Isento']) {
    assert.strictEqual(_statusPgtoCanonico(st), st, 'canônico passa intacto');
  }
  for (const ruim of ['', null, undefined, 'Parcelado', 'qualquer coisa']) {
    assert.strictEqual(_statusPgtoCanonico(ruim), 'Pendente',
      `${JSON.stringify(ruim)} não pode virar Pago — seria contar como recebido o que não entrou`);
  }
});

// O ciclo que destruía o dado: abrir um atendimento Parcial no modal e salvar.
test('editar um atendimento Parcial e salvar preserva o Parcial', () => {
  const { _statusPgtoCanonico, _resumoFin } = carregar(['const:STATUS_PGTO', '_statusPgtoCanonico', '_centavos', '_resumoFin']);
  // O select agora tem a opção, então o valor sobrevive ao ciclo abrir→salvar.
  const gravado = _statusPgtoCanonico('Parcial');
  assert.strictEqual(gravado, 'Parcial');
  // E continua entrando no balde certo.
  const r = _resumoFin([{ statusPgto: gravado, valor: 7200 }]);
  assert.strictEqual(r.aReceber, 7200);
  assert.strictEqual(r.recebido + r.aReceber + r.isento, r.bruto);
});

// ---------- o gráfico de 12 meses tem de falar a mesma língua das outras telas ----------
// O app tem quatro lugares que mostram lucro. P&L de Despesas, DRE e o card do
// Dashboard calculam `recebido − despesas` (a regra escrita: competência =
// faturado · caixa = recebido · lucro na tela = caixa − despesas). O gráfico de
// 12 meses somava `p.valor` de TODO mundo e chamava de "Faturamento" — contando
// o que foi isentado — e derivava o "Lucro" dessa soma. Ou seja: aparecia como
// lucro dinheiro que nunca foi recebido e dinheiro que o médico não vai cobrar.
test('gráfico de 12 meses: faturamento e lucro saem de _resumoFin/_lucroFin', () => {
  const { recortarFuncao } = require('./_extrair.js');
  const src = recortarFuncao('renderGraficos').replace(/\/\/[^\n]*/g, '');
  assert.match(src, /const fatPorMes\s*=\s*resumoPorMes\.map\(r => r\.faturado\)/,
    'a linha de Faturamento é o faturado — bruto conta o isento');
  assert.match(src, /_lucroFin\(r, despPorMes\[i\]\)\.caixa/,
    'o lucro do gráfico tem de ser a mesma conta do P&L, do DRE e do Dashboard');
});

test('_lucroFin: caixa desconta despesa do recebido, não do bruto', () => {
  const { _resumoFin, _lucroFin, _centavos } = carregar(
    ['_resumoFin', '_lucroFin', '_centavos'], { Array, Math, Number });
  const pacs = [
    { statusPgto: 'Pago',     valor: 1000 },
    { statusPgto: 'Pendente', valor: 500 },
    { statusPgto: 'Isento',   valor: 400 },
  ];
  const r = _resumoFin(pacs);
  assert.strictEqual(r.bruto, 1900, 'bruto inclui o isento');
  assert.strictEqual(r.faturado, 1500, 'faturado exclui o isento');
  assert.strictEqual(r.recebido, 1000, 'caixa é só o que entrou');
  assert.strictEqual(_centavos(_lucroFin(r, 300).caixa), 700,
    'com a conta antiga (bruto − despesa) daria 1600: R$ 900 de lucro que não existe');
});

// Um único registro sem `valor` transformava a soma inteira em NaN, e daí o
// Dashboard, o DRE e as metas mostravam "R$ NaN". Havia 17 somas sem o guarda
// — algumas duas linhas abaixo de outra que tinha.
test('nenhuma soma de valor fica sem o guarda de campo ausente', () => {
  const { fonte } = require('./_extrair.js');
  const semCom = fonte.replace(/\/\/[^\n]*/g, '');
  const nuas = [...semCom.matchAll(/=>\s*\w+\s*\+\s*\w+\.valor\s*,\s*0\)/g)].map(m => m[0]);
  assert.deepStrictEqual(nuas, [],
    'registro sem valor faz `s + undefined` = NaN e contamina a tela inteira');
});
