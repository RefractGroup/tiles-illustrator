import { deltaE, linearToSrgb, oklabToRgb, rgbToOklab, srgbToLinear } from "./color";
import type { Lab, RGB } from "./types";

/** Deterministic PRNG, so the same photo always yields the same palette. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type PaletteResult = {
  /** Cluster centres, most-used first. */
  palette: RGB[];
  counts: number[];
  /** Index into `palette` for each input colour. */
  assign: number[];
};

/**
 * k-means in OKLab.
 *
 * Clustering in OKLab rather than RGB matters here: the tiles are strongly
 * saturated, and RGB distance would happily merge a red and an orange while
 * splitting two near-identical greys.
 */
export function quantize(colors: RGB[], k: number): PaletteResult {
  if (colors.length === 0 || k <= 0) {
    return { palette: [], counts: [], assign: [] };
  }

  const labs = colors.map(rgbToOklab);
  const n = labs.length;
  const K = Math.min(k, n);

  const rand = mulberry32(0x7113_5000);

  // k-means++ seeding: spread the initial centres out, weighted by squared distance.
  const centres: Lab[] = [labs[Math.floor(rand() * n)]];
  const best = new Float64Array(n).fill(Infinity);

  while (centres.length < K) {
    const c = centres[centres.length - 1];
    let total = 0;
    for (let i = 0; i < n; i++) {
      const d = deltaE(labs[i], c);
      const sq = d * d;
      if (sq < best[i]) best[i] = sq;
      total += best[i];
    }

    if (total <= 0) break;
    let target = rand() * total;
    let pick = n - 1;
    for (let i = 0; i < n; i++) {
      target -= best[i];
      if (target <= 0) {
        pick = i;
        break;
      }
    }
    centres.push(labs[pick]);
  }

  const assign = new Int32Array(n).fill(-1);

  for (let iter = 0; iter < 40; iter++) {
    let moved = false;

    for (let i = 0; i < n; i++) {
      let bestIdx = 0;
      let bestDist = Infinity;
      for (let c = 0; c < centres.length; c++) {
        const d = deltaE(labs[i], centres[c]);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = c;
        }
      }
      if (assign[i] !== bestIdx) {
        assign[i] = bestIdx;
        moved = true;
      }
    }

    const sumL = new Float64Array(centres.length);
    const sumA = new Float64Array(centres.length);
    const sumB = new Float64Array(centres.length);
    const count = new Int32Array(centres.length);

    for (let i = 0; i < n; i++) {
      const c = assign[i];
      sumL[c] += labs[i].L;
      sumA[c] += labs[i].a;
      sumB[c] += labs[i].b;
      count[c]++;
    }

    for (let c = 0; c < centres.length; c++) {
      if (count[c] === 0) continue;
      centres[c] = {
        L: sumL[c] / count[c],
        a: sumA[c] / count[c],
        b: sumB[c] / count[c],
      };
    }

    if (!moved) break;
  }

  // Drop empty clusters, then order by popularity so the palette UI reads sensibly.
  const counts = new Array(centres.length).fill(0);
  for (let i = 0; i < n; i++) counts[assign[i]]++;

  const order = centres
    .map((_, i) => i)
    .filter((i) => counts[i] > 0)
    .sort((a, b) => counts[b] - counts[a]);

  const remap = new Map<number, number>();
  order.forEach((oldIdx, newIdx) => remap.set(oldIdx, newIdx));

  return {
    palette: order.map((i) => oklabToRgb(centres[i])),
    counts: order.map((i) => counts[i]),
    assign: Array.from(assign, (a) => remap.get(a) ?? 0),
  };
}

export function nearestPaletteIndex(color: RGB, palette: RGB[]): number {
  const lab = rgbToOklab(color);
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const d = deltaE(lab, rgbToOklab(palette[i]));
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/** Average a set of colours in linear light, which avoids the usual gamma darkening. */
export function averageLinear(colors: RGB[]): RGB {
  if (colors.length === 0) return { r: 0, g: 0, b: 0 };
  let r = 0;
  let g = 0;
  let b = 0;
  for (const c of colors) {
    r += srgbToLinear(c.r);
    g += srgbToLinear(c.g);
    b += srgbToLinear(c.b);
  }
  const n = colors.length;
  return {
    r: linearToSrgb(r / n),
    g: linearToSrgb(g / n),
    b: linearToSrgb(b / n),
  };
}
