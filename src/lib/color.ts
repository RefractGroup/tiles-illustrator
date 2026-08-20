import type { Lab, RGB } from "./types";

export function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

export function linearToSrgb(v: number): number {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return clamp255(c * 255);
}

export function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/** Björn Ottosson's OKLab. Perceptually uniform, so plain Euclidean distance is meaningful. */
export function rgbToOklab(c: RGB): Lab {
  const r = srgbToLinear(c.r);
  const g = srgbToLinear(c.g);
  const b = srgbToLinear(c.b);

  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;

  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);

  return {
    L: 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  };
}

export function oklabToRgb(c: Lab): RGB {
  const l_ = c.L + 0.3963377774 * c.a + 0.2158037573 * c.b;
  const m_ = c.L - 0.1055613458 * c.a - 0.0638541728 * c.b;
  const s_ = c.L - 0.0894841775 * c.a - 1.291485548 * c.b;

  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  return {
    r: linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  };
}

/** OKLab distance, scaled x100 so the numbers read on a familiar ΔE-ish scale. */
export function deltaE(a: Lab, b: Lab): number {
  const dL = a.L - b.L;
  const da = a.a - b.a;
  const db = a.b - b.b;
  return Math.sqrt(dL * dL + da * da + db * db) * 100;
}

export function deltaERgb(a: RGB, b: RGB): number {
  return deltaE(rgbToOklab(a), rgbToOklab(b));
}

export function rgbToHex(c: RGB): string {
  const h = (v: number) =>
    Math.round(clamp255(v)).toString(16).padStart(2, "0");
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

export function hexToRgb(hex: string): RGB | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let s = m[1];
  if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  return {
    r: parseInt(s.slice(0, 2), 16),
    g: parseInt(s.slice(2, 4), 16),
    b: parseInt(s.slice(4, 6), 16),
  };
}

/** Relative luminance, for deciding whether to put light or dark text on a swatch. */
export function luminance(c: RGB): number {
  return (
    0.2126 * srgbToLinear(c.r) +
    0.7152 * srgbToLinear(c.g) +
    0.0722 * srgbToLinear(c.b)
  );
}

/**
 * The modal colour of a set, found with a coarse OKLab histogram.
 * More reliable than a mean or median when one colour dominates but has spread —
 * which is exactly the case for grout and base tiles under uneven light.
 */
export function modalColor(colors: RGB[]): RGB {
  if (colors.length === 0) return { r: 255, g: 255, b: 255 };

  const LBIN = 0.06;
  const ABIN = 0.025;
  const bins = new Map<string, number[]>();

  for (let i = 0; i < colors.length; i++) {
    const lab = rgbToOklab(colors[i]);
    const key = `${Math.round(lab.L / LBIN)}|${Math.round(lab.a / ABIN)}|${Math.round(lab.b / ABIN)}`;
    const bucket = bins.get(key);
    if (bucket) bucket.push(i);
    else bins.set(key, [i]);
  }

  let best: number[] = [];
  for (const bucket of bins.values()) {
    if (bucket.length > best.length) best = bucket;
  }

  // Average the winning bin in linear light so the result isn't gamma-biased.
  let r = 0;
  let g = 0;
  let b = 0;
  for (const i of best) {
    r += srgbToLinear(colors[i].r);
    g += srgbToLinear(colors[i].g);
    b += srgbToLinear(colors[i].b);
  }
  const n = best.length;
  return {
    r: linearToSrgb(r / n),
    g: linearToSrgb(g / n),
    b: linearToSrgb(b / n),
  };
}
