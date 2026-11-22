if (typeof pdfjsLib !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(console.error);
}

const DB_NAME = 'AlfaReaderDB', DB_VERSION = 1;
let dbInstance = null;

function openDB() {
  if (dbInstance) return Promise.resolve(dbInstance);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('notes')) db.createObjectStore('notes', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('drawings')) db.createObjectStore('drawings', { keyPath: 'key' });
    };
    req.onsuccess = () => { dbInstance = req.result; resolve(dbInstance); };
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(store, val) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(val);
    tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
  });
}
async function dbGet(store, key) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error);
  });
}
async function dbGetAll(store) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error);
  });
}
async function dbDelete(store, key) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
  });
}

let currentBook = null, pdfDoc = null, currentPage = 1, zoomFactor = 1.0;
let viewMode = 'original';
let navMode = localStorage.getItem('navMode') || 'tap-swipe';
let animMode = localStorage.getItem('animMode') || 'eink';
let drawTool = 'scroll';
let verticalObserver = null;

const kindleScreen = document.getElementById('kindleScreen');
const readerContainer = document.getElementById('readerContainer');
const singleStage = document.getElementById('singleStage');
const verticalView = document.getElementById('verticalView');
const pdfCanvas = document.getElementById('pdfCanvas'), pdfCtx = pdfCanvas.getContext('2d');
const drawCanvas = document.getElementById('drawCanvas'), drawCtx = drawCanvas.getContext('2d');

function togglePanel(panelId) {
  ['navPanel', 'stylePanel', 'audioPanel'].forEach((id) => {
    const el = document.getElementById(id);
    if (id === panelId) el.classList.toggle('hidden');
    else el.classList.add('hidden');
  });
}
document.getElementById('btnNavPanel').onclick = () => togglePanel('navPanel');
document.getElementById('btnStylePanel').onclick = () => togglePanel('stylePanel');
document.getElementById('btnAudioToggle').onclick = () => togglePanel('audioPanel');

document.getElementById('btnUpload').onclick = () => document.getElementById('fileInput').click();
document.getElementById('fileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const buffer = await file.arrayBuffer();
  const book = {
    id: 'book_' + Date.now(), name: file.name.replace(/\.pdf$/i, ''),
    data: buffer, currentPage: 1, totalPages: 0, addedAt: Date.now()
  };
  await dbPut('books', book);
  localStorage.setItem('lastBookId', book.id);
  await loadBook(book);
  e.target.value = '';
});

async function loadBook(book) {
  if (typeof pdfjsLib === 'undefined') {
    alert('No se pudo cargar el lector PDF. Revisa tu conexión y recarga la página.');
    return;
  }
  currentBook = book;
  pdfDoc = await pdfjsLib.getDocument({ data: book.data.slice(0) }).promise;
  currentBook.totalPages = pdfDoc.numPages;
  await dbPut('books', currentBook);
  currentPage = Math.min(Math.max(1, book.currentPage || 1), pdfDoc.numPages);

  document.getElementById('emptyState').classList.add('hidden');
  document.getElementById('footerBookName').textContent = currentBook.name;
  const scrubber = document.getElementById('pageScrubber');
  scrubber.max = pdfDoc.numPages;
  scrubber.disabled = false;

  localStorage.setItem('lastBookId', book.id);
  await renderReader();
}

async function updatePageHUD() {
  if (!pdfDoc) return;
  currentBook.currentPage = currentPage;
  await dbPut('books', currentBook);
  const pct = Math.round((currentPage / pdfDoc.numPages) * 100);
  document.getElementById('pageIndicator').textContent = `Pág. ${currentPage} de ${pdfDoc.numPages} • ${pct}%`;
  document.getElementById('progressFill').style.width = `${pct}%`;
  document.getElementById('pageScrubber').value = currentPage;
  document.getElementById('btnPrev').disabled = currentPage <= 1;
  document.getElementById('btnNext').disabled = currentPage >= pdfDoc.numPages;
  if (typeof loadPageNote === 'function') await loadPageNote();
}

async function renderReader(direction = null) {
  if (!pdfDoc) return;
  if (navMode === 'vertical') {
    singleStage.classList.add('hidden');
    verticalView.classList.remove('hidden');
    await setupVerticalScroll();
  } else {
    verticalView.classList.add('hidden');
    if (verticalObserver) { verticalObserver.disconnect(); verticalObserver = null; }
    singleStage.classList.remove('hidden');
    await renderSinglePage(direction);
  }
  await updatePageHUD();
}

async function renderSinglePage(direction) {
  const page = await pdfDoc.getPage(currentPage);
  if (viewMode === 'original') {
    document.getElementById('originalView').classList.remove('hidden');
    document.getElementById('reflowView').classList.add('hidden');
    await renderPdfToCanvases(page, pdfCanvas, drawCanvas, currentPage);
  } else {
    document.getElementById('originalView').classList.add('hidden');
    document.getElementById('reflowView').classList.remove('hidden');
    await renderReflowText(page, document.getElementById('reflowContent'));
  }
  readerContainer.scrollTop = 0;

  singleStage.classList.remove('anim-eink', 'anim-slide-next', 'anim-slide-prev', 'anim-curl-next', 'anim-curl-prev');
  void singleStage.offsetWidth;
  if (direction && animMode !== 'none') {
    if (animMode === 'eink') singleStage.classList.add('anim-eink');
    else if (animMode === 'slide') singleStage.classList.add(direction > 0 ? 'anim-slide-next' : 'anim-slide-prev');
    else if (animMode === 'curl') singleStage.classList.add(direction > 0 ? 'anim-curl-next' : 'anim-curl-prev');
  }
}

async function renderPdfToCanvases(page, targetPdfCanvas, targetDrawCanvas, pageNum) {
  const unscaled = page.getViewport({ scale: 1 });
  const containerWidth = Math.max(280, readerContainer.clientWidth - 40);
  const finalScale = Math.min(1.6, containerWidth / unscaled.width) * zoomFactor;
  const viewport = page.getViewport({ scale: finalScale });
  const dpr = window.devicePixelRatio || 1;

  targetPdfCanvas.width = Math.floor(viewport.width * dpr);
  targetPdfCanvas.height = Math.floor(viewport.height * dpr);
  targetPdfCanvas.style.width = `${Math.floor(viewport.width)}px`;
  targetPdfCanvas.style.height = `${Math.floor(viewport.height)}px`;

  await page.render({
    canvasContext: targetPdfCanvas.getContext('2d'),
    viewport,
    transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null
  }).promise;

  targetDrawCanvas.width = Math.floor(unscaled.width * 2);
  targetDrawCanvas.height = Math.floor(unscaled.height * 2);
  targetDrawCanvas.classList.toggle('drawing-active', drawTool !== 'scroll');
  if (typeof loadPageDrawingInto === 'function') await loadPageDrawingInto(targetDrawCanvas, pageNum);
}

async function renderReflowText(page, container) {
  const textContent = await page.getTextContent();
  container.innerHTML = '';
  let paragraphs = [], currentPara = '', lastY = null;
  for (const item of textContent.items) {
    const y = item.transform[5];
    if (lastY !== null && Math.abs(lastY - y) > 16 && currentPara.trim()) {
      paragraphs.push(currentPara.trim());
      currentPara = '';
    }
    currentPara += item.str + ' ';
    lastY = y;
  }
  if (currentPara.trim()) paragraphs.push(currentPara.trim());
  if (!paragraphs.length) paragraphs.push('(Página escaneada como imagen. Usa la Vista Original).');
  for (const text of paragraphs) {
    const p = document.createElement('p');
    p.textContent = text;
    container.appendChild(p);
  }
}

async function setupVerticalScroll() {
  verticalView.innerHTML = '';
  if (verticalObserver) verticalObserver.disconnect();

  const firstPage = await pdfDoc.getPage(1);
  const unscaled = firstPage.getViewport({ scale: 1 });
  const containerWidth = Math.max(280, readerContainer.clientWidth - 40);
  const fitW = Math.floor(Math.min(unscaled.width * 1.6, containerWidth) * zoomFactor);
  const estH = Math.floor(fitW * (unscaled.height / unscaled.width));

  for (let i = 1; i <= pdfDoc.numPages; i++) {
    const slot = document.createElement('div');
    slot.className = 'v-page-slot' + (viewMode === 'reflow' ? ' reflow-slot' : '');
    slot.dataset.page = i;
    if (viewMode === 'original') {
      slot.style.width = `${fitW}px`;
      slot.style.height = `${estH}px`;
    }
    slot.innerHTML = `<span class="v-page-badge">Pág. ${i}</span>`;
    verticalView.appendChild(slot);
  }

  verticalObserver = new IntersectionObserver(async (entries) => {
    for (const entry of entries) {
      const slot = entry.target;
      const pNum = parseInt(slot.dataset.page, 10);
      if (entry.isIntersecting && !slot.dataset.rendered) {
        slot.dataset.rendered = '1';
        const page = await pdfDoc.getPage(pNum);
        if (viewMode === 'original') {
          slot.style.height = 'auto';
          const wrap = document.createElement('div');
          wrap.className = 'canvas-wrapper';
          const pCan = document.createElement('canvas'); pCan.className = 'pdf-canvas';
          const dCan = document.createElement('canvas'); dCan.className = 'draw-canvas';
          wrap.append(pCan, dCan);
          slot.prepend(wrap);
          if (typeof attachDrawEvents === 'function') attachDrawEvents(dCan, () => pNum);
          await renderPdfToCanvases(page, pCan, dCan, pNum);
        } else {
          const div = document.createElement('div');
          div.className = 'reflow-content';
          div.style.fontFamily = document.getElementById('fontSelect').value;
          div.style.fontSize = `${document.getElementById('fontSizeRange').value}px`;
          div.style.lineHeight = document.getElementById('lineHeightRange').value;
          await renderReflowText(page, div);
          slot.prepend(div);
        }
      }
    }
  }, { root: readerContainer, rootMargin: '500px 0px' });

  document.querySelectorAll('.v-page-slot').forEach((s) => verticalObserver.observe(s));
  const targetSlot = verticalView.querySelector(`[data-page="${currentPage}"]`);
  if (targetSlot) targetSlot.scrollIntoView();
}

let scrollDetectTimer = null;
readerContainer.addEventListener('scroll', () => {
  if (navMode !== 'vertical' || !pdfDoc) return;
  clearTimeout(scrollDetectTimer);
  scrollDetectTimer = setTimeout(() => {
    const slots = verticalView.querySelectorAll('.v-page-slot');
    const midY = readerContainer.getBoundingClientRect().top + readerContainer.clientHeight * 0.35;
    for (const s of slots) {
      const rect = s.getBoundingClientRect();
      if (rect.top <= midY && rect.bottom >= midY) {
        const p = parseInt(s.dataset.page, 10);
        if (p !== currentPage) { currentPage = p; updatePageHUD(); }
        break;
      }
    }
  }, 150);
});

function goToPage(pageNum, direction = 0) {
  if (!pdfDoc) return;
  const target = Math.min(Math.max(1, pageNum), pdfDoc.numPages);
  if (target === currentPage && navMode !== 'vertical') return;
  currentPage = target;
  if (navMode === 'vertical') {
    const slot = verticalView.querySelector(`[data-page="${currentPage}"]`);
    if (slot) slot.scrollIntoView({ behavior: 'smooth' });
    updatePageHUD();
  } else {
    renderSinglePage(direction);
    updatePageHUD();
  }
}

function flashTapHint(side) {
  const el = document.getElementById(side === 'left' ? 'tapHintLeft' : 'tapHintRight');
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 220);
}

document.getElementById('btnPrev').onclick = () => goToPage(currentPage - 1, -1);
document.getElementById('btnNext').onclick = () => goToPage(currentPage + 1, 1);
document.getElementById('pageScrubber').addEventListener('change', (e) => {
  const p = parseInt(e.target.value, 10);
  goToPage(p, p > currentPage ? 1 : -1);
});

let touchStartX = 0, touchStartY = 0, touchStartTime = 0;
readerContainer.addEventListener('pointerdown', (e) => {
  if (drawTool !== 'scroll' || e.target.closest('button, input, select')) return;
  touchStartX = e.clientX; touchStartY = e.clientY; touchStartTime = Date.now();
});

readerContainer.addEventListener('pointerup', (e) => {
  if (drawTool !== 'scroll' || !pdfDoc || e.target.closest('button, input, select')) return;
  if (window.getSelection && window.getSelection().toString().length > 0) return;
  const dx = e.clientX - touchStartX, dy = e.clientY - touchStartY, dt = Date.now() - touchStartTime;

  if ((navMode === 'swipe' || navMode === 'tap-swipe') &&
      Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.4 && dt < 600) {
    if (dx < 0) goToPage(currentPage + 1, 1);
    else goToPage(currentPage - 1, -1);
    return;
  }

  if (Math.abs(dx) < 12 && Math.abs(dy) < 12 && dt < 350) {
    const rect = readerContainer.getBoundingClientRect();
    const relX = (e.clientX - rect.left) / rect.width;
    if ((navMode === 'tap' || navMode === 'tap-swipe') && relX < 0.28) {
      flashTapHint('left'); goToPage(currentPage - 1, -1);
    } else if ((navMode === 'tap' || navMode === 'tap-swipe') && relX > 0.72) {
      flashTapHint('right'); goToPage(currentPage + 1, 1);
    } else if (relX >= 0.28 && relX <= 0.72) {
      kindleScreen.classList.toggle('hud-hidden');
      togglePanel(null);
    }
  }
});

window.addEventListener('keydown', (e) => {
  if (document.activeElement.tagName === 'TEXTAREA') return;
  if (e.key === 'ArrowRight') goToPage(currentPage + 1, 1);
  if (e.key === 'ArrowLeft') goToPage(currentPage - 1, -1);
});

document.getElementById('navModeSelect').value = navMode;
document.getElementById('navModeSelect').onchange = (e) => {
  navMode = e.target.value; localStorage.setItem('navMode', navMode); renderReader();
};
document.getElementById('animModeSelect').value = animMode;
document.getElementById('animModeSelect').onchange = (e) => {
  animMode = e.target.value; localStorage.setItem('animMode', animMode);
};
document.getElementById('btnZoomIn').onclick = () => { zoomFactor = Math.min(2.4, zoomFactor + 0.2); renderReader(); };
document.getElementById('btnZoomOut').onclick = () => { zoomFactor = Math.max(0.6, zoomFactor - 0.2); renderReader(); };
document.getElementById('btnModeOriginal').onclick = (e) => {
  viewMode = 'original'; e.target.classList.add('active');
  document.getElementById('btnModeReflow').classList.remove('active'); renderReader();
};
document.getElementById('btnModeReflow').onclick = (e) => {
  viewMode = 'reflow'; e.target.classList.add('active');
  document.getElementById('btnModeOriginal').classList.remove('active'); renderReader();
};

document.getElementById('btnLibrary').onclick = async () => {
  await renderLibrary();
  document.getElementById('libraryModal').classList.remove('hidden');
};
document.getElementById('btnCloseLibrary').onclick = () => document.getElementById('libraryModal').classList.add('hidden');
async function renderLibrary() {
  const list = document.getElementById('libraryList'), books = await dbGetAll('books');
  list.innerHTML = '';
  if (!books.length) { list.innerHTML = '<li class="muted">No has subido ningún PDF todavía.</li>'; return; }
  books.sort((a, b) => b.addedAt - a.addedAt);
  for (const b of books) {
    const li = document.createElement('li'); li.className = 'library-item';
    const info = document.createElement('div'); info.className = 'library-item-info';
    info.innerHTML = `<strong>${b.name}</strong><span class="muted">Página ${b.currentPage || 1} de ${b.totalPages || '?'}</span>`;
    info.onclick = async () => { await loadBook(b); document.getElementById('libraryModal').classList.add('hidden'); };
    const delBtn = document.createElement('button'); delBtn.className = 'btn btn-danger'; delBtn.textContent = '🗑️';
    delBtn.onclick = async () => {
      await dbDelete('books', b.id);
      if (currentBook && currentBook.id === b.id) location.reload(); else renderLibrary();
    };
    li.append(info, delBtn); list.appendChild(li);
  }
}

window.addEventListener('DOMContentLoaded', async () => {
  try {
    const lastId = localStorage.getItem('lastBookId');
    if (lastId) { const book = await dbGet('books', lastId); if (book) await loadBook(book); }
  } catch (err) { console.error(err); }
});
