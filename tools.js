/* ---------- Estilos Kindle, Carcasa y Letras ---------- */
const reflowContentEl = document.getElementById('reflowContent');
const bezelToggle = document.getElementById('bezelToggle');

document.getElementById('themeSelect').onchange = (e) => {
  document.documentElement.setAttribute('data-theme', e.target.value);
  localStorage.setItem('readerTheme', e.target.value);
};

bezelToggle.onchange = (e) => {
  document.getElementById('kindleDevice').classList.toggle('no-bezel', !e.target.checked);
  localStorage.setItem('kindleBezel', e.target.checked ? '1' : '0');
  if (pdfDoc) renderReader();
};

document.getElementById('fontSelect').onchange = (e) => {
  reflowContentEl.style.fontFamily = e.target.value;
  localStorage.setItem('readerFont', e.target.value);
  if (navMode === 'vertical' && viewMode === 'reflow') renderReader();
};

document.getElementById('fontSizeRange').oninput = (e) => {
  document.getElementById('fontSizeVal').textContent = e.target.value;
  reflowContentEl.style.fontSize = `${e.target.value}px`;
  localStorage.setItem('readerFontSize', e.target.value);
  document.querySelectorAll('.v-page-slot .reflow-content').forEach((el) => el.style.fontSize = `${e.target.value}px`);
};

document.getElementById('lineHeightRange').oninput = (e) => {
  document.getElementById('lineHeightVal').textContent = e.target.value;
  reflowContentEl.style.lineHeight = e.target.value;
  localStorage.setItem('readerLineHeight', e.target.value);
  document.querySelectorAll('.v-page-slot .reflow-content').forEach((el) => el.style.lineHeight = e.target.value);
};

(function restoreStyles() {
  const theme = localStorage.getItem('readerTheme') || 'eink-day';
  document.documentElement.setAttribute('data-theme', theme);
  document.getElementById('themeSelect').value = theme;

  const bezel = localStorage.getItem('kindleBezel') !== '0';
  bezelToggle.checked = bezel;
  document.getElementById('kindleDevice').classList.toggle('no-bezel', !bezel);

  const font = localStorage.getItem('readerFont');
  if (font) { reflowContentEl.style.fontFamily = font; document.getElementById('fontSelect').value = font; }
  const size = localStorage.getItem('readerFontSize');
  if (size) { reflowContentEl.style.fontSize = `${size}px`; document.getElementById('fontSizeRange').value = size; document.getElementById('fontSizeVal').textContent = size; }
  const lh = localStorage.getItem('readerLineHeight');
  if (lh) { reflowContentEl.style.lineHeight = lh; document.getElementById('lineHeightRange').value = lh; document.getElementById('lineHeightVal').textContent = lh; }
})();

/* ---------- Dibujo, Subrayado y pdf-lib ---------- */
document.getElementById('btnDrawTools').onclick = (e) => {
  document.getElementById('drawToolbar').classList.toggle('hidden');
  e.target.classList.toggle('active');
};

function setDrawTool(tool, btnId) {
  drawTool = tool;
  ['toolScroll', 'toolHighlight', 'toolPen', 'toolEraser'].forEach((id) => document.getElementById(id).classList.remove('active'));
  document.getElementById(btnId).classList.add('active');
  document.querySelectorAll('.draw-canvas').forEach((c) => c.classList.toggle('drawing-active', tool !== 'scroll'));
}

document.getElementById('toolScroll').onclick = () => setDrawTool('scroll', 'toolScroll');
document.getElementById('toolHighlight').onclick = () => { document.getElementById('drawColor').value = '#fde047'; setDrawTool('highlight', 'toolHighlight'); };
document.getElementById('toolPen').onclick = () => { document.getElementById('drawColor').value = '#ef4444'; setDrawTool('pen', 'toolPen'); };
document.getElementById('toolEraser').onclick = () => setDrawTool('eraser', 'toolEraser');

function attachDrawEvents(targetCanvas, getPageNumFn) {
  const ctx = targetCanvas.getContext('2d');
  let drawing = false, points = [], snapshot = null;

  function getPt(e) {
    const rect = targetCanvas.getBoundingClientRect();
    return { x: (e.clientX - rect.left) * (targetCanvas.width / rect.width), y: (e.clientY - rect.top) * (targetCanvas.height / rect.height) };
  }

  targetCanvas.addEventListener('pointerdown', (e) => {
    if (drawTool === 'scroll' || !currentBook) return;
    e.stopPropagation();
    drawing = true; targetCanvas.setPointerCapture(e.pointerId);
    points = [getPt(e)];
    snapshot = ctx.getImageData(0, 0, targetCanvas.width, targetCanvas.height);
  });

  targetCanvas.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    points.push(getPt(e));
    ctx.putImageData(snapshot, 0, 0);
    ctx.save(); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const color = document.getElementById('drawColor').value;
    if (drawTool === 'highlight') { ctx.globalAlpha = 0.38; ctx.strokeStyle = color; ctx.lineWidth = 26; }
    else if (drawTool === 'pen') { ctx.globalAlpha = 1.0; ctx.strokeStyle = color; ctx.lineWidth = 4; }
    else if (drawTool === 'eraser') { ctx.globalCompositeOperation = 'destination-out'; ctx.lineWidth = 34; }
    ctx.beginPath(); ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.stroke(); ctx.restore();
  });

  async function endStroke() {
    if (!drawing) return;
    drawing = false; snapshot = null;
    if (currentBook) {
      await dbPut('drawings', { key: `${currentBook.id}_${getPageNumFn()}`, dataUrl: targetCanvas.toDataURL('image/png') });
    }
  }
  targetCanvas.addEventListener('pointerup', endStroke);
  targetCanvas.addEventListener('pointercancel', endStroke);
}

attachDrawEvents(drawCanvas, () => currentPage);

async function loadPageDrawingInto(targetCanvas, pageNum) {
  const ctx = targetCanvas.getContext('2d');
  ctx.clearRect(0, 0, targetCanvas.width, targetCanvas.height);
  if (!currentBook) return;
  const saved = await dbGet('drawings', `${currentBook.id}_${pageNum}`);
  if (saved && saved.dataUrl) {
    const img = new Image();
    img.onload = () => ctx.drawImage(img, 0, 0, targetCanvas.width, targetCanvas.height);
    img.src = saved.dataUrl;
  }
}

document.getElementById('btnClearPage').onclick = async () => {
  if (!currentBook) return;
  drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
  const slotCanvas = verticalView.querySelector(`[data-page="${currentPage}"] .draw-canvas`);
  if (slotCanvas) slotCanvas.getContext('2d').clearRect(0, 0, slotCanvas.width, slotCanvas.height);
  await dbDelete('drawings', `${currentBook.id}_${currentPage}`);
};

document.getElementById('btnExportPdf').onclick = async () => {
  if (!currentBook || typeof PDFLib === 'undefined') return;
  const pdfDocOut = await PDFLib.PDFDocument.load(currentBook.data.slice(0));
  const allDrawings = await dbGetAll('drawings'), prefix = `${currentBook.id}_`;
  for (const item of allDrawings) {
    if (!item.key.startsWith(prefix)) continue;
    const pageNum = parseInt(item.key.slice(prefix.length), 10);
    if (!pageNum || pageNum > pdfDocOut.getPageCount()) continue;
    const pngBytes = await fetch(item.dataUrl).then((r) => r.arrayBuffer());
    const pngImg = await pdfDocOut.embedPng(pngBytes);
    const page = pdfDocOut.getPage(pageNum - 1);
    const { width, height } = page.getSize();
    page.drawImage(pngImg, { x: 0, y: 0, width, height });
  }
  const outBytes = await pdfDocOut.save();
  const blob = new Blob([outBytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = `${currentBook.name}_Anotado.pdf`; a.click();
  URL.revokeObjectURL(url);
};

/* ---------- Ondas Alfa (Web Audio API) ---------- */
let audioCtx = null, masterGain = null, audioNodes = [], isAudioPlaying = false;

function createBrownNoiseBuffer(ctx) {
  const bufferSize = ctx.sampleRate * 3, buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate), data = buffer.getChannelData(0);
  let lastOut = 0;
  for (let i = 0; i < bufferSize; i++) {
    const white = Math.random() * 2 - 1;
    data[i] = (lastOut + 0.02 * white) / 1.02; lastOut = data[i]; data[i] *= 3.2;
  }
  return buffer;
}

function stopAudio() {
  audioNodes.forEach((n) => { try { if (n.stop) n.stop(); n.disconnect(); } catch (_) {} });
  audioNodes = []; isAudioPlaying = false;
  document.getElementById('btnPlayAudio').textContent = '▶ Iniciar Ondas Alfa';
  document.getElementById('audioStatus').textContent = 'En pausa';
  document.getElementById('btnAudioToggle').classList.remove('active');
}

async function startAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') await audioCtx.resume();
  stopAudio();
  masterGain = audioCtx.createGain();
  masterGain.gain.value = parseFloat(document.getElementById('volumeRange').value);
  masterGain.connect(audioCtx.destination);
  audioNodes.push(masterGain);

  const mode = document.getElementById('audioModeSelect').value;
  if (mode === 'binaural') {
    const oscL = audioCtx.createOscillator(), oscR = audioCtx.createOscillator();
    const panL = audioCtx.createStereoPanner(), panR = audioCtx.createStereoPanner(), toneGain = audioCtx.createGain();
    oscL.frequency.value = 200; oscR.frequency.value = 210; panL.pan.value = -1; panR.pan.value = 1; toneGain.gain.value = 0.25;
    oscL.connect(panL).connect(toneGain); oscR.connect(panR).connect(toneGain); toneGain.connect(masterGain);
    oscL.start(); oscR.start(); audioNodes.push(oscL, oscR, panL, panR, toneGain);
    document.getElementById('audioStatus').textContent = 'Activo: Binaural 10 Hz (Audífonos)';
  } else {
    const noise = audioCtx.createBufferSource(); noise.buffer = createBrownNoiseBuffer(audioCtx); noise.loop = true;
    const filter = audioCtx.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 380;
    const noiseGain = audioCtx.createGain(); noiseGain.gain.value = 0.45;
    noise.connect(filter).connect(noiseGain).connect(masterGain); noise.start();
    audioNodes.push(noise, filter, noiseGain);
    if (mode === 'isochronic') {
      const carrier = audioCtx.createOscillator(); carrier.frequency.value = 180;
      const pulseGain = audioCtx.createGain(); pulseGain.gain.value = 0.08;
      const lfo = audioCtx.createOscillator(); lfo.frequency.value = 10;
      const lfoDepth = audioCtx.createGain(); lfoDepth.gain.value = 0.08;
      lfo.connect(lfoDepth).connect(pulseGain.gain); carrier.connect(pulseGain).connect(masterGain);
      carrier.start(); lfo.start(); audioNodes.push(carrier, pulseGain, lfo, lfoDepth);
      document.getElementById('audioStatus').textContent = 'Activo: Isocrónico 10 Hz + Lluvia';
    } else document.getElementById('audioStatus').textContent = 'Activo: Lluvia suave';
  }
  isAudioPlaying = true;
  document.getElementById('btnPlayAudio').textContent = '⏹ Detener Audio';
  document.getElementById('btnAudioToggle').classList.add('active');
}

document.getElementById('btnPlayAudio').onclick = () => isAudioPlaying ? stopAudio() : startAudio();
document.getElementById('audioModeSelect').onchange = () => { if (isAudioPlaying) startAudio(); };
document.getElementById('volumeRange').oninput = (e) => {
  if (masterGain && audioCtx) masterGain.gain.setTargetAtTime(parseFloat(e.target.value), audioCtx.currentTime, 0.05);
};

/* ---------- Apuntes ---------- */
let noteTimer = null;
document.getElementById('btnNotesPanel').onclick = (e) => {
  document.getElementById('notesPanel').classList.toggle('hidden');
  e.target.classList.toggle('active');
};

async function loadPageNote() {
  if (!currentBook) return;
  document.getElementById('notePageLabel').textContent = `Apuntes - Pág. ${currentPage}`;
  const saved = await dbGet('notes', `${currentBook.id}_${currentPage}`);
  document.getElementById('noteTextarea').value = saved ? saved.text : '';
  document.getElementById('noteSaveStatus').textContent = 'Guardado';
}

document.getElementById('noteTextarea').addEventListener('input', (e) => {
  if (!currentBook) return;
  document.getElementById('noteSaveStatus').textContent = 'Guardando...';
  clearTimeout(noteTimer);
  noteTimer = setTimeout(async () => {
    await dbPut('notes', { key: `${currentBook.id}_${currentPage}`, text: e.target.value });
    document.getElementById('noteSaveStatus').textContent = 'Guardado';
  }, 400);
});

document.getElementById('btnExportNotes').onclick = async () => {
  if (!currentBook) return;
  const allNotes = await dbGetAll('notes'), prefix = `${currentBook.id}_`;
  const bookNotes = allNotes.filter((n) => n.key.startsWith(prefix) && n.text.trim())
    .map((n) => ({ page: parseInt(n.key.slice(prefix.length), 10), text: n.text })).sort((a, b) => a.page - b.page);
  let md = `# Apuntes: ${currentBook.name}\n\n`;
  if (!bookNotes.length) md += '_(No hay apuntes todavía)_\n';
  for (const n of bookNotes) md += `## Página ${n.page}\n${n.text}\n\n---\n\n`;
  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = `${currentBook.name}_Apuntes.md`; a.click();
  URL.revokeObjectURL(url);
};
