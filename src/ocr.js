// Tesseract.js es gratuito y corre en el navegador: la imagen no sale de tu equipo.
// (Solo descarga una vez el modelo de idioma español y lo guarda en caché.)
async function preprocess(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(2, Math.max(1, 1800 / bmp.width));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) {
    const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    d[i] = d[i + 1] = d[i + 2] = g;
    sum += g;
  }
  // Si la captura es en modo oscuro, se invierte para que el texto sea oscuro sobre claro
  if (sum / (d.length / 4) < 110) {
    for (let i = 0; i < d.length; i += 4) { d[i] = d[i + 1] = d[i + 2] = 255 - d[i]; }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

export async function readImage(file, onProgress) {
  const canvas = await preprocess(file);
  const { createWorker } = await import('tesseract.js');
  const worker = await createWorker('spa', 1, {
    logger: (m) => onProgress?.(m.status, m.progress ?? 0),
  });
  try {
    const { data } = await worker.recognize(canvas);
    return data.text;
  } finally {
    await worker.terminate();
  }
}
