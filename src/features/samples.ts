// Built-in sample pictures (public/samples). Used for practice, references, remakes, palettes and ASCII art.
import { h } from '../ui/dom';
import { button } from '../ui/controls';
import { openDialog } from '../ui/dialog';

export interface Sample { id: string; name: string; file: string; desc: string; tags: string }

export const SAMPLES: Sample[] = [
  { id: 'alpine-meadow', name: 'Alpine meadow (gouache)', file: 'alpine-meadow-gouache.jpg', desc: 'Painterly mountain valley with pines, a river and wildflowers.', tags: 'landscape painting' },
  { id: 'mountain-lake', name: 'Mountain lake (watercolour)', file: 'mountain-lake-watercolour.jpg', desc: 'Sunset watercolour of purple peaks reflected in a lake.', tags: 'landscape watercolour' },
  { id: 'still-life', name: 'Still life with fruit', file: 'still-life.svg', desc: 'Classic study: fruit bowl, grapes and a blue jug - great for practising light and shadow.', tags: 'still life' },
  { id: 'ocean-sunset', name: 'Ocean sunset', file: 'ocean-sunset.svg', desc: 'Glowing sky gradients and water reflections.', tags: 'landscape sky' },
  { id: 'night-city', name: 'Night city', file: 'night-city.svg', desc: 'Moonlit skyline with lit windows - good for perspective and glow practice.', tags: 'city night' },
  { id: 'sunflowers', name: 'Sunflowers in a vase', file: 'sunflowers.svg', desc: 'Bold flowers on blue - lovely for palette extraction and flat colour.', tags: 'flowers still life' },
  { id: 'abstract', name: 'Abstract shapes', file: 'abstract-shapes.svg', desc: 'Simple flat shapes - perfect for trying the fill tool, paint by numbers and ASCII art.', tags: 'abstract' },
];

export const sampleUrl = (s: Sample) => `${import.meta.env.BASE_URL}samples/${s.file}`;

/** Load a sample as an ImageBitmap (SVGs are rasterised at their natural size). */
export async function loadSample(idOrSample: string | Sample): Promise<ImageBitmap> {
  const s = typeof idOrSample === 'string' ? SAMPLES.find((x) => x.id === idOrSample) : idOrSample;
  if (!s) throw new Error(`Unknown sample. Available: ${SAMPLES.map((x) => x.id).join(', ')}`);
  const blob = await (await fetch(sampleUrl(s))).blob();
  if (!s.file.endsWith('.svg')) return createImageBitmap(blob);
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth || 1600; c.height = img.naturalHeight || 1200;
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    return createImageBitmap(c);
  } finally { URL.revokeObjectURL(url); }
}

/** Gallery dialog. Resolves with the chosen sample (or null). */
export function pickSample(title = 'Sample pictures', subtitle = 'Pick a picture to practise with.'): Promise<{ sample: Sample; bitmap: ImageBitmap } | null> {
  return new Promise((resolve) => {
    let result: { sample: Sample; bitmap: ImageBitmap } | null = null;
    const d = openDialog(title, { width: 860, icon: 'image', subtitle });
    const grid = h('div', { class: 'sample-grid' });
    for (const s of SAMPLES) {
      const card = h('button', { class: 'sample-card', type: 'button', tip: { title: s.name, desc: s.desc } },
        h('img', { src: sampleUrl(s), alt: s.name, loading: 'lazy', draggable: false }),
        h('span', { class: 'sample-name' }, s.name),
        h('span', { class: 'sample-desc' }, s.desc));
      card.addEventListener('click', async () => {
        card.classList.add('loading');
        try { result = { sample: s, bitmap: await loadSample(s) }; d.close(); } catch { card.classList.remove('loading'); }
      });
      grid.append(card);
    }
    d.body.append(grid);
    d.footer.append(button('Cancel', { onClick: () => d.close() }));
    d.onClose = () => resolve(result);
  });
}
