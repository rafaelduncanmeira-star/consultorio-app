import { createCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas';
import { writeFileSync } from 'fs';

const FONTS = 'C:/Users/Rafael Duncan/AppData/Roaming/Claude/local-agent-mode-sessions/skills-plugin/3590360c-9023-4c4f-920b-c32734218073/d9e9ec81-9018-4052-ac9f-a8d4c302c642/skills/canvas-design/canvas-fonts';
GlobalFonts.registerFromPath(`${FONTS}/InstrumentSerif-Regular.ttf`, 'Serif');
GlobalFonts.registerFromPath(`${FONTS}/InstrumentSerif-Italic.ttf`, 'SerifIt');
GlobalFonts.registerFromPath(`${FONTS}/GeistMono-Regular.ttf`, 'Mono');
GlobalFonts.registerFromPath(`${FONTS}/GeistMono-Bold.ttf`, 'MonoB');
GlobalFonts.registerFromPath(`${FONTS}/Italiana-Regular.ttf`, 'Italiana');

const S = 1080;
const c = createCanvas(S, S);
const x = c.getContext('2d');

// ---- Fundo: azul-noite carbônico com vinheta ----
const bg = x.createLinearGradient(0, 0, S, S);
bg.addColorStop(0, '#0f1622');
bg.addColorStop(0.55, '#0b0f17');
bg.addColorStop(1, '#080b11');
x.fillStyle = bg;
x.fillRect(0, 0, S, S);
// vinheta radial sutil
const vg = x.createRadialGradient(S/2, S*0.42, 80, S/2, S*0.42, S*0.75);
vg.addColorStop(0, 'rgba(16,185,129,0.06)');
vg.addColorStop(1, 'rgba(0,0,0,0)');
x.fillStyle = vg; x.fillRect(0, 0, S, S);

// ---- Pauta musical: linhas horizontais finas, esmeralda quase invisível ----
x.save();
x.strokeStyle = 'rgba(148,163,184,0.06)';
x.lineWidth = 1;
for (let i = 0; i < 5; i++) {
  const yy = 470 + i * 13;
  x.beginPath(); x.moveTo(120, yy); x.lineTo(S - 120, yy); x.stroke();
}
x.restore();

// ---- Gesto de batuta: arco esmeralda fino com brilho ----
x.save();
x.shadowColor = 'rgba(16,185,129,0.55)';
x.shadowBlur = 22;
x.strokeStyle = '#10b981';
x.lineWidth = 3;
x.lineCap = 'round';
x.beginPath();
x.moveTo(190, 638);
x.bezierCurveTo(360, 600, 540, 712, 720, 612);
x.bezierCurveTo(820, 556, 868, 596, 900, 600);
x.stroke();
// ponta da batuta (a "nota")
x.shadowBlur = 18;
x.fillStyle = '#34d399';
x.beginPath(); x.arc(900, 600, 6.5, 0, Math.PI * 2); x.fill();
x.restore();

// ---- Marcadores clínicos nos cantos (disciplina imaginária) ----
x.fillStyle = 'rgba(124,139,161,0.65)';
x.font = '18px Mono';
x.textAlign = 'left';
x.fillText('SISTEMA DE GESTÃO CLÍNICA', 96, 96);
x.textAlign = 'right';
x.fillText('Nº 01 — MMXXVI', S - 96, 96);
// linha fina sob o topo
x.strokeStyle = 'rgba(148,163,184,0.14)'; x.lineWidth = 1;
x.beginPath(); x.moveTo(96, 116); x.lineTo(S-96, 116); x.stroke();

// ---- Crista/símbolo: leque de folhas estilizado (eco do logo) ----
function folha(cx, cy, ang, len, w, fill) {
  x.save();
  x.translate(cx, cy); x.rotate(ang);
  x.fillStyle = fill;
  x.beginPath();
  x.moveTo(0, 0);
  x.quadraticCurveTo(w, -len*0.55, 0, -len);
  x.quadraticCurveTo(-w, -len*0.55, 0, 0);
  x.fill();
  x.restore();
}
const cx = S/2, cy = 300;
// brilho de foco atrás da crista
const cg = x.createRadialGradient(cx, cy-10, 10, cx, cy-10, 230);
cg.addColorStop(0, 'rgba(16,185,129,0.12)');
cg.addColorStop(1, 'rgba(0,0,0,0)');
x.fillStyle = cg; x.fillRect(cx-260, cy-260, 520, 460);

const folhasN = 9;
for (let i = 0; i < folhasN; i++) {
  const t = (i/(folhasN-1)) - 0.5;          // -0.5..0.5
  const ang = t * Math.PI * 0.95;
  const len = 92 - Math.abs(t) * 38;
  // folha central recebe acento esmeralda (amarra o verde da marca)
  const central = Math.abs(t) < 0.06;
  const tom = central ? '#34d399' : (i % 2 === 0 ? 'rgba(203,213,225,0.92)' : 'rgba(148,163,184,0.7)');
  folha(cx, cy, ang, len, 17, tom);
}
// caule
x.strokeStyle = 'rgba(148,163,184,0.5)'; x.lineWidth = 2.5; x.lineCap='round';
x.beginPath(); x.moveTo(cx, cy); x.lineTo(cx, cy + 40); x.stroke();

// ---- Wordmark (com tracking manual para elegância de joalheria) ----
function tracked(txt, fontSpec, size, yy, track, fill) {
  x.font = fontSpec;
  x.textAlign = 'left';
  x.fillStyle = fill;
  const widths = [...txt].map(ch => x.measureText(ch).width + track);
  const total = widths.reduce((a, b) => a + b, 0) - track;
  let px = cx - total / 2;
  [...txt].forEach((ch, i) => { x.fillText(ch, px, yy); px += widths[i]; });
}
tracked('MAESTRIA', '92px Italiana', 92, 432, 10, '#f4f7fa');
tracked('DE CONSULTÓRIO', '23px Mono', 23, 470, 9, 'rgba(52,211,153,0.92)');
x.textAlign = 'center';

// ---- Tagline (serif elegante, grande) ----
x.fillStyle = '#e6edf3';
x.font = '60px Serif';
x.fillText('A gestão do consultório,', cx, 770);
x.fillText('em perfeita harmonia.', cx, 832);

// ---- Etiquetas de recurso (mono, sistemáticas) ----
x.fillStyle = 'rgba(148,163,184,0.8)';
x.font = '21px Mono';
x.fillText('FINANCEIRO   ·   AGENDA   ·   PACIENTES   ·   RELATÓRIOS', cx, 906);

// ---- CTA / rodapé ----
// cápsula
const ctaY = 968, ctaW = 360, ctaH = 56, ctaX = cx - ctaW/2;
x.fillStyle = '#10b981';
const r = ctaH/2;
x.beginPath();
x.moveTo(ctaX+r, ctaY); x.arcTo(ctaX+ctaW, ctaY, ctaX+ctaW, ctaY+ctaH, r);
x.arcTo(ctaX+ctaW, ctaY+ctaH, ctaX, ctaY+ctaH, r); x.arcTo(ctaX, ctaY+ctaH, ctaX, ctaY, r);
x.arcTo(ctaX, ctaY, ctaX+ctaW, ctaY, r); x.closePath(); x.fill();
x.fillStyle = '#05281d';
x.font = '23px MonoB';
x.textAlign = 'center';
x.fillText('CADASTRO GRATUITO', cx, ctaY + 37);

// rodapé domínio
x.fillStyle = 'rgba(124,139,161,0.6)';
x.font = '17px Mono';
x.fillText('maestriadeconsultorio.com', cx, S - 34);

writeFileSync('instagram-post.png', c.toBuffer('image/png'));
console.log('OK instagram-post.png', S + 'x' + S);
