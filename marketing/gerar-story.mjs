import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { writeFileSync } from 'fs';

const FONTS = 'C:/Users/Rafael Duncan/AppData/Roaming/Claude/local-agent-mode-sessions/skills-plugin/3590360c-9023-4c4f-920b-c32734218073/d9e9ec81-9018-4052-ac9f-a8d4c302c642/skills/canvas-design/canvas-fonts';
GlobalFonts.registerFromPath(`${FONTS}/InstrumentSerif-Regular.ttf`, 'Serif');
GlobalFonts.registerFromPath(`${FONTS}/GeistMono-Regular.ttf`, 'Mono');
GlobalFonts.registerFromPath(`${FONTS}/GeistMono-Bold.ttf`, 'MonoB');
GlobalFonts.registerFromPath(`${FONTS}/Italiana-Regular.ttf`, 'Italiana');

const W = 1080, H = 1920, cx = W/2;
const c = createCanvas(W, H);
const x = c.getContext('2d');

const bg = x.createLinearGradient(0, 0, W, H);
bg.addColorStop(0, '#0f1622'); bg.addColorStop(0.55, '#0b0f17'); bg.addColorStop(1, '#080b11');
x.fillStyle = bg; x.fillRect(0, 0, W, H);
const vg = x.createRadialGradient(cx, 560, 100, cx, 560, 900);
vg.addColorStop(0, 'rgba(16,185,129,0.06)'); vg.addColorStop(1, 'rgba(0,0,0,0)');
x.fillStyle = vg; x.fillRect(0, 0, W, H);

// marcadores topo
x.fillStyle = 'rgba(124,139,161,0.6)'; x.font = '20px Mono';
x.textAlign = 'left'; x.fillText('SISTEMA DE GESTÃO CLÍNICA', 100, 130);
x.textAlign = 'right'; x.fillText('Nº 01 — MMXXVI', W-100, 130);
x.strokeStyle = 'rgba(148,163,184,0.14)'; x.lineWidth = 1;
x.beginPath(); x.moveTo(100, 152); x.lineTo(W-100, 152); x.stroke();

// crista
function folha(fx, fy, ang, len, w, fill){ x.save(); x.translate(fx,fy); x.rotate(ang); x.fillStyle=fill; x.beginPath(); x.moveTo(0,0); x.quadraticCurveTo(w,-len*0.55,0,-len); x.quadraticCurveTo(-w,-len*0.55,0,0); x.fill(); x.restore(); }
const cy = 560;
const cg = x.createRadialGradient(cx, cy-10, 10, cx, cy-10, 280);
cg.addColorStop(0,'rgba(16,185,129,0.13)'); cg.addColorStop(1,'rgba(0,0,0,0)');
x.fillStyle = cg; x.fillRect(cx-300, cy-300, 600, 540);
const N = 9;
for (let i=0;i<N;i++){ const t=(i/(N-1))-0.5; const ang=t*Math.PI*0.95; const len=108-Math.abs(t)*44; const central=Math.abs(t)<0.06; const tom=central?'#34d399':(i%2===0?'rgba(203,213,225,0.92)':'rgba(148,163,184,0.7)'); folha(cx,cy,ang,len,20,tom); }
x.strokeStyle='rgba(148,163,184,0.5)'; x.lineWidth=3; x.lineCap='round';
x.beginPath(); x.moveTo(cx,cy); x.lineTo(cx,cy+48); x.stroke();

// wordmark com tracking
function tracked(txt, fontSpec, yy, track, fill){ x.font=fontSpec; x.textAlign='left'; x.fillStyle=fill; const ws=[...txt].map(ch=>x.measureText(ch).width+track); const tot=ws.reduce((a,b)=>a+b,0)-track; let px=cx-tot/2; [...txt].forEach((ch,i)=>{x.fillText(ch,px,yy); px+=ws[i];}); }
tracked('MAESTRIA', '116px Italiana', 738, 12, '#f4f7fa');
tracked('DE CONSULTÓRIO', '27px Mono', 786, 11, 'rgba(52,211,153,0.92)');

// batuta
x.save(); x.shadowColor='rgba(16,185,129,0.55)'; x.shadowBlur=24; x.strokeStyle='#10b981'; x.lineWidth=3.5; x.lineCap='round';
x.beginPath(); x.moveTo(200, 950); x.bezierCurveTo(390,905,580,1035,760,920); x.bezierCurveTo(840,872,876,905,900,910); x.stroke();
x.shadowBlur=18; x.fillStyle='#34d399'; x.beginPath(); x.arc(900,910,7,0,Math.PI*2); x.fill(); x.restore();

// tagline
x.textAlign='center'; x.fillStyle='#e6edf3'; x.font='78px Serif';
x.fillText('A gestão do consultório,', cx, 1200);
x.fillText('em perfeita harmonia.', cx, 1285);

// features empilhadas
x.fillStyle='rgba(148,163,184,0.82)'; x.font='27px Mono';
const feats=['FINANCEIRO','AGENDA','PACIENTES','RELATÓRIOS'];
feats.forEach((f,i)=> x.fillText(f, cx, 1420 + i*52));

// CTA
const ctaY=1660, ctaW=440, ctaH=68, ctaX=cx-ctaW/2, r=ctaH/2;
x.fillStyle='#10b981';
x.beginPath(); x.moveTo(ctaX+r,ctaY); x.arcTo(ctaX+ctaW,ctaY,ctaX+ctaW,ctaY+ctaH,r); x.arcTo(ctaX+ctaW,ctaY+ctaH,ctaX,ctaY+ctaH,r); x.arcTo(ctaX,ctaY+ctaH,ctaX,ctaY,r); x.arcTo(ctaX,ctaY,ctaX+ctaW,ctaY,r); x.closePath(); x.fill();
x.fillStyle='#05281d'; x.font='27px MonoB'; x.fillText('CADASTRO GRATUITO', cx, ctaY+44);

x.fillStyle='rgba(124,139,161,0.6)'; x.font='19px Mono';
x.fillText('maestriadeconsultorio.com', cx, 1810);

writeFileSync('instagram-story.png', c.toBuffer('image/png'));
console.log('OK instagram-story.png', W+'x'+H);
