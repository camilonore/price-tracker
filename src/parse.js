/** Convierte "4.500", "4,500", "12.990,50", "4500" o "$ 4 500" en número. */
export function parsePriceToken(raw) {
  let s = String(raw).replace(/[^\d.,]/g, '');
  if (!s) return NaN;
  const hasDot = s.includes('.'), hasComma = s.includes(',');
  if (hasDot && hasComma) {
    const dec = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ',';
    const th = dec === '.' ? ',' : '.';
    s = s.split(th).join('').replace(dec, '.');
  } else if (hasDot || hasComma) {
    const sep = hasDot ? '.' : ',';
    const parts = s.split(sep);
    const last = parts[parts.length - 1];
    // "4.500" o "1.234.567" → miles; "4.5" o "4,50" → decimales
    if (parts.length > 2 || last.length === 3) s = parts.join('');
    else s = parts.join('.');
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : NaN;
}

const UNIT_AFTER = /^\s*(ml|l|lt|lts|g|gr|kg|kgs|cm|mm|m|und|unds|uds|x|%|pzs|oz|hz|pulgadas)\b/i;
const PRICE_RE = /(\$|S\$|COP)?\s*(\d{1,3}(?:[.,\s]\d{3})+(?:[.,]\d{1,2})?|\d{3,9}(?:[.,]\d{1,2})?)/g;
// líneas cuyos números NO son el precio del producto
const NOT_PRODUCT_PRICE = /(cuotas?|env[ií]o|c\/u|cada|por mes|mensual|desde)/i;
const NOISE = /(env[ií]o|gratis|cuotas|descuento|oferta|llega|vendido|calific|opiniones|stock|disponible|agregar|comprar|carrito|\biva\b|antes|ahora|\boff\b|%)/i;

export function findPrices(line) {
  const out = [];
  for (const m of line.matchAll(PRICE_RE)) {
    const hasSign = !!m[1];
    const token = m[2];
    const rest = line.slice(m.index + m[0].length);
    if (UNIT_AFTER.test(rest)) continue;
    const value = parsePriceToken(token);
    if (!Number.isFinite(value) || value < 100) continue;
    if (!hasSign && !/[.,\s]\d{3}/.test(token)) continue;
    out.push({ value, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

const letters = (s) => (s.match(/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/g) || []).length;

function cleanName(s) {
  // los nombres truncados terminan en "..." y lo que sigue suele ser basura del OCR
  const cut = s.search(/\.{2,}|…/);
  if (cut > 8) s = s.slice(0, cut);
  return s
    .replace(/[|_=~•·»«<>{}\[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\W\d]+(?=[A-Za-zÁÉÍÓÚÑ])/, '')
    .replace(/(\s+[A-ZÁÉÍÓÚÑ]{2,4}|\s+\d+\s?%)+\s*$/, '') // "EXE", "OFF", "2%" al final
    .trim();
}

function stripPrices(line, prices) {
  let t = line;
  [...prices].sort((a, b) => b.start - a.start).forEach((p) => { t = t.slice(0, p.start) + ' ' + t.slice(p.end); });
  return t;
}

/**
 * Del texto del OCR saca pares {name, price}.
 * - El nombre es la línea de texto más cercana (puede estar encima del precio).
 * - Si un mismo producto tiene varios precios (tachado y actual), se queda el menor.
 */
export function extractCandidates(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const groups = [];
  let cur = null;

  lines.forEach((line, i) => {
    const prices = NOT_PRODUCT_PRICE.test(line) ? [] : findPrices(line);
    const label = cleanName(stripPrices(line, findPrices(line)));
    const nameLike = letters(label) >= 6 && !NOISE.test(label);

    if (nameLike) {
      if (cur && !cur.prices.length && i - cur.last === 1 && cur.name.length < 90) {
        cur.name += ' ' + label; // el nombre ocupaba dos líneas
      } else {
        cur = { name: label, prices: [], last: i };
        groups.push(cur);
      }
      cur.last = i;
    }
    if (prices.length) {
      if (!cur || i - cur.last > 3) { cur = { name: '', prices: [], last: i }; groups.push(cur); }
      cur.prices.push(...prices.map((p) => p.value));
      cur.last = i;
    }
  });

  const seen = new Set();
  return groups
    .filter((g) => g.prices.length)
    .map((g) => ({ name: g.name.trim(), price: Math.min(...g.prices) }))
    .filter((c) => !seen.has(c.name + c.price) && seen.add(c.name + c.price));
}
