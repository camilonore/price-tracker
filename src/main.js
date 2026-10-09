import './style.css';
import '@fontsource-variable/bricolage-grotesque';
import '@fontsource-variable/figtree';
import Chart from 'chart.js/auto';
import { subscribe, importProducts, migrateLocal, addPrice, removeEntry, removeProduct, restoreProduct, todayISO } from './store.js';
import { parsePriceToken, extractCandidates } from './parse.js';
import { readImage } from './ocr.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 2, minimumFractionDigits: 0 });
const fmt = (n) => money.format(n);
const dateLong = (iso) => new Date(iso + 'T00:00').toLocaleDateString('es-CO', { day: 'numeric', month: 'short', year: 'numeric' });
const dateShort = (iso) => new Date(iso + 'T00:00').toLocaleDateString('es-CO', { day: 'numeric', month: 'short' });
const pct = (n) => (n > 0 ? '+' : '') + n.toFixed(1).replace('.', ',') + '%';

const state = { data: { products: {} }, ready: false, selected: null, query: '' };
let chart = null;

/* ---------- utilidades ---------- */
let toastTimer;
function toast(msg, action) {
  const t = $('#toast');
  t.textContent = msg;
  if (action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = action.label;
    b.addEventListener('click', () => { t.classList.remove('show'); action.onClick(); });
    t.append(b);
  }
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), action ? 8000 : 3800);
}

function syncError(err) {
  console.error(err);
  const denied = err?.code === 'permission-denied';
  setSync('error', denied ? 'Sin permiso en Firebase' : 'Error de Firebase');
  toast(denied
    ? 'Firebase rechazó el acceso. Revisa las reglas de Firestore (ver instrucciones).'
    : 'No se pudo sincronizar con Firebase: ' + (err?.message || err));
}

function setSync(kind, text) {
  const el = $('#sync');
  el.className = 'sync ' + kind;
  el.textContent = text;
}

function deleteProductWithUndo(id) {
  const p = state.data.products[id];
  if (!p) return;
  const copy = JSON.parse(JSON.stringify(p));
  removeProduct(id).catch(syncError);
  toast(`«${copy.name}» eliminado.`, { label: 'Deshacer', onClick: () => restoreProduct(id, copy).catch(syncError) });
}

const sortedProducts = () =>
  Object.entries(state.data.products).sort((a, b) => (b[1].updated || 0) - (a[1].updated || 0));

function deltaInfo(entries) {
  if (entries.length < 2) return null;
  const last = entries[entries.length - 1].price;
  const prev = entries[entries.length - 2].price;
  const diff = last - prev;
  return { diff, pct: prev ? (diff / prev) * 100 : 0 };
}

function describeSave(name, price, r) {
  if (r.status === 'new') return `«${name}» agregado a ${fmt(price)}.`;
  if (r.status === 'replaced') return `Precio de hoy actualizado: ${fmt(price)}.`;
  if (r.previous) {
    const d = price - r.previous.price;
    if (d === 0) return `«${name}» sigue en ${fmt(price)}.`;
    return `«${name}» ${d < 0 ? 'bajó' : 'subió'} ${fmt(Math.abs(d))} desde el ${dateShort(r.previous.date)}.`;
  }
  return `Precio de «${name}» guardado.`;
}

/* ---------- pestañas ---------- */
$$('.tab').forEach((tab) =>
  tab.addEventListener('click', () => {
    $$('.tab').forEach((t) => t.classList.toggle('is-active', t === tab));
    $$('.pane').forEach((p) => (p.hidden = p.dataset.pane !== tab.dataset.tab));
  })
);
const goTab = (name) => $(`.tab[data-tab="${name}"]`).click();

/* ---------- formulario manual ---------- */
const fDate = $('#f-date');
fDate.value = todayISO();
fDate.max = todayISO();

$('#form-manual').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('#f-name').value.trim();
  const price = parsePriceToken($('#f-price').value);
  if (!name) return toast('Escribe el nombre del producto.');
  if (!(price > 0)) return toast('El precio no es válido. Usa un formato como 4.500.');
  let r;
  try { r = addPrice(state.data, name, price, fDate.value || todayISO()); }
  catch (err) { return toast(err.message); }
  r.done.catch(syncError);
  state.selected = r.id;
  e.target.reset();
  fDate.value = todayISO();
  toast(describeSave(name, price, r));
  render();
  $('#f-name').focus();
});

/* ---------- captura de pantalla (OCR gratuito) ---------- */
const drop = $('#drop');
const fileImg = $('#file-img');
drop.addEventListener('click', (e) => { if (e.target !== fileImg) fileImg.click(); });
drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileImg.click(); } });
fileImg.addEventListener('change', () => fileImg.files[0] && handleImage(fileImg.files[0]));
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f) handleImage(f); });
document.addEventListener('paste', (e) => {
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
  if (item) { goTab('image'); handleImage(item.getAsFile()); }
});

async function handleImage(file) {
  if (!file.type.startsWith('image/')) return toast('Ese archivo no es una imagen.');
  const prev = $('#ocr-preview');
  prev.src = URL.createObjectURL(file);
  prev.hidden = false;
  $('#ocr-results').hidden = true;
  const status = $('#ocr-status');
  status.hidden = false;
  const bar = $('#ocr-bar'), msg = $('#ocr-msg');
  bar.style.width = '4%';
  msg.textContent = 'Preparando lector…';
  try {
    const text = await readImage(file, (s, p) => {
      const labels = { 'loading tesseract core': 'Cargando lector…', 'loading language traineddata': 'Descargando idioma (solo la primera vez)…', 'initializing api': 'Iniciando…', 'recognizing text': 'Leyendo la imagen…' };
      msg.textContent = labels[s] || 'Procesando…';
      bar.style.width = Math.max(4, Math.round(p * 100)) + '%';
    });
    status.hidden = true;
    showCandidates(text);
  } catch (err) {
    console.error(err);
    msg.textContent = 'No se pudo leer la imagen. Revisa tu conexión (la primera vez descarga el idioma) o usa el modo manual.';
    bar.style.width = '0%';
  }
}

function showCandidates(text) {
  const list = $('#ocr-list');
  const cands = extractCandidates(text);
  $('#ocr-raw').textContent = text.trim() || '(sin texto)';
  $('#ocr-results').hidden = false;
  if (!cands.length) {
    list.innerHTML = '<li class="empty-note">No encontré precios. Prueba con una captura más nítida y con zoom, o escríbelo en la pestaña Manual.</li>';
    $('#ocr-save').hidden = true;
    return;
  }
  $('#ocr-save').hidden = false;
  list.innerHTML = cands.map((c, i) => `
    <li class="ocr-row">
      <input type="checkbox" checked aria-label="Incluir" data-i="${i}" />
      <textarea class="o-name" rows="2" placeholder="Escribe el nombre del producto" aria-label="Nombre">${esc(c.name)}</textarea>
      <label class="o-price-wrap">Precio <input class="o-price" value="${esc(String(c.price).replace('.', ','))}" inputmode="decimal" aria-label="Precio" /></label>
    </li>`).join('');
  $$('.o-name', list).forEach((ta) => {
    const grow = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 2 + 'px'; };
    ta.addEventListener('input', grow);
    grow();
  });
}

$('#ocr-save').addEventListener('click', () => {
  let saved = 0, skipped = 0, last;
  $$('.ocr-row').forEach((row) => {
    if (!$('input[type=checkbox]', row).checked) return;
    const name = $('.o-name', row).value.trim();
    const price = parsePriceToken($('.o-price', row).value);
    if (!name || !(price > 0)) { skipped++; return; }
    try { const r = addPrice(state.data, name, price); r.done.catch(syncError); last = r.id; saved++; }
    catch { skipped++; }
  });
  if (last) state.selected = last;
  toast(saved ? `${saved} precio${saved > 1 ? 's' : ''} guardado${saved > 1 ? 's' : ''}${skipped ? `, ${skipped} sin nombre o precio` : ''}.` : 'Completa nombre y precio de al menos una fila.');
  if (saved) { $('#ocr-results').hidden = true; $('#ocr-preview').hidden = true; fileImg.value = ''; }
  render();
});

/* ---------- voz (Web Speech API del navegador, gratis) ---------- */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
$('#btn-voice').addEventListener('click', () => {
  const msg = $('#voice-msg');
  if (!SR) { msg.textContent = 'Tu navegador no soporta dictado. Usa Chrome o Edge.'; return; }
  const rec = new SR();
  rec.lang = 'es-CO';
  rec.interimResults = false;
  const btn = $('#btn-voice');
  btn.disabled = true;
  btn.textContent = 'Escuchando…';
  msg.textContent = '';
  rec.onresult = (ev) => {
    const text = ev.results[0][0].transcript;
    const nums = [...text.matchAll(/\d[\d.,]*/g)];
    if (!nums.length) { msg.textContent = `Escuché «${text}», pero no entendí el precio. Di el precio con cifras.`; return; }
    const last = nums[nums.length - 1];
    const name = (text.slice(0, last.index) + text.slice(last.index + last[0].length)).replace(/pesos?|\$/gi, '').trim();
    $('#f-name').value = name;
    $('#f-price').value = last[0].replace(/[.,]$/, '');
    goTab('manual');
    toast(`Escuché «${text}». Revisa y guarda.`);
  };
  rec.onerror = (e) => { msg.textContent = e.error === 'not-allowed' ? 'Permite el acceso al micrófono para dictar.' : 'No se pudo escuchar. Intenta de nuevo.'; };
  rec.onend = () => { btn.disabled = false; btn.textContent = 'Dictar'; };
  rec.start();
});

/* ---------- lista de productos ---------- */
$('#search').addEventListener('input', (e) => { state.query = e.target.value.toLowerCase(); renderList(); });

function renderList() {
  const prods = sortedProducts();
  $('#count').textContent = prods.length;
  $('#product-names').innerHTML = prods.map(([, p]) => `<option value="${esc(p.name)}">`).join('');
  const shown = prods.filter(([, p]) => p.name.toLowerCase().includes(state.query));
  const ul = $('#product-list');
  if (!prods.length) { ul.innerHTML = '<li class="empty-note">Aún no hay productos. Agrega el primero arriba.</li>'; return; }
  if (!shown.length) { ul.innerHTML = '<li class="empty-note">Ningún producto coincide.</li>'; return; }
  ul.innerHTML = shown.map(([id, p]) => {
    const last = p.entries[p.entries.length - 1];
    const d = deltaInfo(p.entries);
    const cls = !d || d.diff === 0 ? 'flat' : d.diff < 0 ? 'down' : 'up';
    return `<li class="prod-item"><button class="prod ${id === state.selected ? 'is-active' : ''}" data-id="${esc(id)}">
      <span class="prod-name">${esc(p.name)}</span>
      <span class="prod-price">${fmt(last.price)}</span>
      <span class="chip ${cls}">${d ? pct(d.pct) : 'nuevo'}</span>
    </button><button class="trash" data-del="${esc(id)}" aria-label="Eliminar ${esc(p.name)}" title="Eliminar">🗑</button></li>`;
  }).join('');
  $$('.prod', ul).forEach((b) => b.addEventListener('click', () => { state.selected = b.dataset.id; render(); }));
  $$('.trash', ul).forEach((b) => b.addEventListener('click', () => deleteProductWithUndo(b.dataset.del)));
}

/* ---------- detalle y gráfica ---------- */
function renderDetail() {
  const box = $('#detail');
  if (chart) { chart.destroy(); chart = null; }
  const p = state.data.products[state.selected];
  if (!state.ready) { box.innerHTML = '<div class="empty"><p>Cargando tus productos…</p></div>'; return; }
  if (!p) {
    box.innerHTML = `<div class="empty">
      <h2>Tu gráfica aparecerá aquí</h2>
      <p>Guarda un producto con su precio. Cuando lo vuelvas a anotar otro día, verás cómo cambió.</p>
    </div>`;
    return;
  }
  const e = p.entries;
  const last = e[e.length - 1];
  const min = e.reduce((a, b) => (b.price < a.price ? b : a));
  const max = e.reduce((a, b) => (b.price > a.price ? b : a));
  const d = deltaInfo(e);
  const first = e[0];
  const total = e.length > 1 ? ((last.price - first.price) / first.price) * 100 : null;
  const cls = !d || d.diff === 0 ? 'flat' : d.diff < 0 ? 'down' : 'up';
  const verdict = last.price === min.price && e.length > 1 ? 'Está en su precio más bajo registrado.' : last.price === max.price && e.length > 1 ? 'Está en su precio más alto registrado.' : '';

  box.innerHTML = `
    <div class="d-head">
      <div>
        <h2 class="d-name">${esc(p.name)}</h2>
        <div class="d-price">${fmt(last.price)}</div>
        <p class="d-sub">${d ? `<span class="chip ${cls}">${d.diff === 0 ? 'Sin cambio' : (d.diff < 0 ? '↓ ' : '↑ ') + fmt(Math.abs(d.diff)) + ' (' + pct(d.pct) + ')'}</span> frente al registro anterior. ` : 'Primer registro. '}${verdict}</p>
      </div>
      <button class="btn ghost danger" id="del-product" type="button">Eliminar producto</button>
    </div>
    <div class="chart-wrap"><canvas id="chart" role="img" aria-label="Gráfica del precio de ${esc(p.name)}"></canvas></div>
    <dl class="stats">
      <div><dt>Más bajo</dt><dd>${fmt(min.price)}</dd><small>${dateLong(min.date)}</small></div>
      <div><dt>Más alto</dt><dd>${fmt(max.price)}</dd><small>${dateLong(max.date)}</small></div>
      <div><dt>Cambio total</dt><dd>${total === null ? '—' : pct(total)}</dd><small>desde ${dateLong(first.date)}</small></div>
      <div><dt>Registros</dt><dd>${e.length}</dd><small>último ${dateLong(last.date)}</small></div>
    </dl>
    <details class="history">
      <summary>Historial de precios</summary>
      <table>
        <thead><tr><th>Fecha</th><th class="num">Precio</th><th class="num">Cambio</th><th></th></tr></thead>
        <tbody>
        ${[...e].reverse().map((row, i, arr) => {
          const before = arr[i + 1];
          const diff = before ? row.price - before.price : null;
          const c = diff === null || diff === 0 ? 'flat' : diff < 0 ? 'down' : 'up';
          return `<tr><td>${dateLong(row.date)}</td><td class="num">${fmt(row.price)}</td>
            <td class="num">${diff === null ? '—' : `<span class="chip ${c}">${diff === 0 ? '0' : (diff > 0 ? '+' : '−') + fmt(Math.abs(diff))}</span>`}</td>
            <td class="num"><button class="x" data-date="${row.date}" aria-label="Borrar registro del ${dateLong(row.date)}">✕</button></td></tr>`;
        }).join('')}
        </tbody>
      </table>
    </details>`;

  $('#del-product').addEventListener('click', () => deleteProductWithUndo(state.selected));
  $$('.x', box).forEach((b) => b.addEventListener('click', () => {
    const id = state.selected, date = b.dataset.date;
    const copy = JSON.parse(JSON.stringify(state.data.products[id]));
    removeEntry(state.data, id, date).catch(syncError);
    toast(`Registro del ${dateLong(date)} eliminado.`, { label: 'Deshacer', onClick: () => restoreProduct(id, copy).catch(syncError) });
  }));
  drawChart(e);
}

function drawChart(entries) {
  const ctx = $('#chart').getContext('2d');
  const css = getComputedStyle(document.documentElement);
  const accent = css.getPropertyValue('--accent').trim();
  const grad = ctx.createLinearGradient(0, 0, 0, 320);
  grad.addColorStop(0, 'rgba(36,71,245,.22)');
  grad.addColorStop(1, 'rgba(36,71,245,0)');
  const prices = entries.map((x) => x.price);
  const lo = Math.min(...prices), hi = Math.max(...prices);
  const pad = lo === hi ? lo * 0.1 || 1 : (hi - lo) * 0.2;
  chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: entries.map((x) => dateShort(x.date)),
      datasets: [{
        data: prices, borderColor: accent, backgroundColor: grad, fill: true, tension: 0.25, borderWidth: 3,
        pointRadius: 5, pointHoverRadius: 7, pointBackgroundColor: '#fff', pointBorderColor: accent, pointBorderWidth: 3,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        y: { min: Math.max(0, lo - pad), max: hi + pad, ticks: { callback: (v) => fmt(v), color: '#667085', maxTicksLimit: 6 }, grid: { color: '#E6EBF2' }, border: { display: false } },
        x: { ticks: { color: '#667085' }, grid: { display: false }, border: { color: '#D5DCE7' } },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#16202E', padding: 10, displayColors: false,
          titleFont: { family: 'Figtree Variable' }, bodyFont: { family: 'Figtree Variable', size: 14, weight: '600' },
          callbacks: { title: (i) => dateLong(entries[i[0].dataIndex].date), label: (i) => fmt(i.parsed.y) },
        },
      },
    },
  });
}

/* ---------- copia de seguridad ---------- */
$('#btn-export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(state.data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `precios-${todayISO()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});
$('#btn-import').addEventListener('click', () => $('#file-import').click());
$('#file-import').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const json = JSON.parse(await f.text());
    if (!json.products || typeof json.products !== 'object') throw new Error('formato');
    const n = await importProducts(state.data, json.products);
    toast(`Copia importada: ${n} producto${n === 1 ? '' : 's'}.`);
  } catch (err) { toast(err.message === 'formato' ? 'Ese archivo no es una copia válida.' : 'No se pudo importar: ' + err.message); }
  e.target.value = '';
});

function render() { renderList(); renderDetail(); }

let first = true;
setSync('', 'Conectando…');
render();
subscribe((data, meta) => {
  state.data = data;
  state.ready = true;
  if (!state.data.products[state.selected]) state.selected = sortedProducts()[0]?.[0] || null;
  setSync(meta.pending ? 'pending' : 'ok', meta.pending ? 'Guardando…' : 'Sincronizado');
  render();
  if (first) {
    first = false;
    migrateLocal(data).then((n) => n && toast(`Pasé ${n} producto${n === 1 ? '' : 's'} guardados en este navegador a Firebase.`)).catch(syncError);
  }
}, syncError);
