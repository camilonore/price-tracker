import { doc, setDoc, deleteDoc, onSnapshot } from 'firebase/firestore';
import { productsCol } from './firebase.js';

const LOCAL_KEY = 'price-tracker:v1';
const MIGRATED_KEY = 'price-tracker:migrated';

export const todayISO = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};

// "Leche  Entera 1L" y "leche entera 1l" cuentan como el mismo producto
export const normalize = (s) =>
  s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

const ref = (id) => doc(productsCol, id);
const persist = (id, p) => setDoc(ref(id), { name: p.name, entries: p.entries, updated: p.updated || Date.now() });

/** Escucha la base de datos en tiempo real. */
export function subscribe(onData, onError) {
  return onSnapshot(
    productsCol,
    { includeMetadataChanges: true },
    (snap) => {
      const products = {};
      snap.forEach((d) => { products[d.id] = d.data(); });
      onData({ products }, { pending: snap.metadata.hasPendingWrites });
    },
    onError
  );
}

function applyPrice(p, price, date) {
  const previous = [...p.entries].sort((a, b) => a.date.localeCompare(b.date)).reverse().find((e) => e.date < date) || null;
  const sameDay = p.entries.find((e) => e.date === date);
  if (sameDay) sameDay.price = price;
  else p.entries.push({ date, price });
  p.entries.sort((a, b) => a.date.localeCompare(b.date));
  p.updated = Date.now();
  return { status: sameDay ? 'replaced' : 'added', previous };
}

/** Devuelve { id, status: 'new' | 'added' | 'replaced', previous, done } */
export function addPrice(data, name, price, date = todayISO()) {
  const id = normalize(name);
  if (!id) throw new Error('El nombre debe tener letras o números.');
  let p = data.products[id];
  const isNew = !p;
  if (isNew) p = data.products[id] = { name: name.trim().replace(/\s+/g, ' '), entries: [] };
  const r = applyPrice(p, price, date);
  return { id, status: isNew ? 'new' : r.status, previous: r.previous, done: persist(id, p) };
}

/** Agrega un precio a un producto ya existente, sin depender del nombre. */
export function addPriceToProduct(data, id, price, date = todayISO()) {
  const p = data.products[id];
  if (!p) throw new Error('Ese producto ya no existe.');
  const r = applyPrice(p, price, date);
  return { id, status: r.status, previous: r.previous, done: persist(id, p) };
}

export const removeProduct = (id) => deleteDoc(ref(id));
export const restoreProduct = (id, p) => persist(id, p);

export function removeEntry(data, id, date) {
  const p = data.products[id];
  if (!p) return Promise.resolve();
  const entries = p.entries.filter((e) => e.date !== date);
  if (!entries.length) return deleteDoc(ref(id));
  return persist(id, { ...p, entries, updated: Date.now() });
}

/** Sube un archivo de copia de seguridad. Une historiales por fecha. */
export async function importProducts(data, incoming) {
  let n = 0;
  for (const [id, p] of Object.entries(incoming)) {
    if (!p || !p.name || !Array.isArray(p.entries)) continue;
    const merged = new Map((data.products[id]?.entries || []).map((e) => [e.date, e.price]));
    p.entries.forEach((e) => merged.set(e.date, e.price));
    const entries = [...merged].map(([date, price]) => ({ date, price })).sort((a, b) => a.date.localeCompare(b.date));
    await persist(id, { name: p.name, entries, updated: Date.now() });
    n++;
  }
  return n;
}

/** Una sola vez: pasa a Firebase lo que ya tenías guardado en este navegador. */
export async function migrateLocal(data) {
  if (localStorage.getItem(MIGRATED_KEY)) return 0;
  let local;
  try { local = JSON.parse(localStorage.getItem(LOCAL_KEY)); } catch { local = null; }
  localStorage.setItem(MIGRATED_KEY, '1');
  if (!local?.products) return 0;
  return importProducts(data, local.products);
}
