import { homographyFromQuad, project } from "./homography";
import { edgeField, gridLineScore, type Bitmap } from "./sampling";
import type { Pt, Quad, SampleParams } from "./types";

/** Render the quad's contents into an axis-aligned buffer, undoing perspective. */
export function rectify(
  img: Bitmap,
  quad: Quad,
  outW: number,
  outH: number,
): Bitmap {
  const H = homographyFromQuad(quad);
  const out = new Uint8ClampedArray(outW * outH * 4);

  for (let y = 0; y < outH; y++) {
    const v = (y + 0.5) / outH;
    for (let x = 0; x < outW; x++) {
      const u = (x + 0.5) / outW;
      const p = project(H, u, v);

      const sx = Math.min(Math.max(Math.round(p.x), 0), img.width - 1);
      const sy = Math.min(Math.max(Math.round(p.y), 0), img.height - 1);

      const si = (sy * img.width + sx) * 4;
      const di = (y * outW + x) * 4;
      out[di] = img.data[si];
      out[di + 1] = img.data[si + 1];
      out[di + 2] = img.data[si + 2];
      out[di + 3] = 255;
    }
  }

  return { width: outW, height: outH, data: out };
}

/** Rough period from autocorrelation. Only ever a starting point for `fitComb`. */
function autocorrelationPeak(profile: Float64Array): number {
  const n = profile.length;

  let mean = 0;
  for (let i = 0; i < n; i++) mean += profile[i];
  mean /= n;

  const s = new Float64Array(n);
  for (let i = 0; i < n; i++) s[i] = profile[i] - mean;

  const minLag = 4;
  const maxLag = Math.floor(n / 4);
  if (maxLag <= minLag) return 0;

  let bestLag = 0;
  let bestVal = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < n; i++) sum += s[i] * s[i + lag];
    // Normalise by overlap so short lags aren't unfairly favoured.
    const v = sum / (n - lag);
    if (v > bestVal) {
      bestVal = v;
      bestLag = lag;
    }
  }

  return bestVal > 0 ? bestLag : 0;
}

function interpolate(profile: Float64Array, x: number): number {
  const n = profile.length;
  if (x <= 0) return profile[0];
  if (x >= n - 1) return profile[n - 1];
  const i = Math.floor(x);
  const t = x - i;
  return profile[i] * (1 - t) + profile[i + 1] * t;
}

type Comb = { period: number; phase: number; contrast: number; count: number };

/** Mean profile value sampled at `phase + k * period`, relative to the overall mean. */
function combContrast(
  profile: Float64Array,
  period: number,
  phase: number,
  mean: number,
): number {
  const n = profile.length;
  let start = phase;
  while (start < 0) start += period;

  let sum = 0;
  let count = 0;
  for (let x = start; x <= n - 1; x += period) {
    sum += interpolate(profile, x);
    count++;
  }
  return count > 0 ? sum / count / mean : 0;
}

/**
 * Fit an evenly spaced comb of grid lines to the profile.
 *
 * Autocorrelation alone gives an integer lag, and an integer lag is not good
 * enough: being 3% off on the pitch drifts a whole tile-and-a-half across a
 * 45-column wall. Searching period *and* phase together against the raw profile
 * recovers both to sub-pixel accuracy, and the phase is what lets us snap the
 * region onto real grout lines afterwards.
 */
function fitComb(profile: Float64Array, guess: number): Comb | null {
  const n = profile.length;
  if (guess < 4) return null;

  let mean = 0;
  for (let i = 0; i < n; i++) mean += profile[i];
  mean /= n;
  if (mean <= 1e-9) return null;

  let best: Comb | null = null;

  const lo = guess * 0.88;
  const hi = guess * 1.12;
  const pStep = Math.max(0.01, guess * 0.004);

  for (let p = lo; p <= hi; p += pStep) {
    const phaseStep = Math.max(0.1, p / 80);
    for (let phase = 0; phase < p; phase += phaseStep) {
      let sum = 0;
      let count = 0;
      for (let x = phase; x <= n - 1; x += p) {
        sum += interpolate(profile, x);
        count++;
      }
      if (count < 3) continue;

      const contrast = sum / count / mean;
      if (!best || contrast > best.contrast) {
        best = { period: p, phase, contrast, count };
      }
    }
  }

  return best;
}

/**
 * Pick the true pitch, guarding against the classic octave error.
 *
 * A grid of pitch p correlates just as happily at 2p, so the autocorrelation
 * peak is often double the truth. The test that settles it: sample a second
 * comb offset by half a period. If the pitch is right those points sit in the
 * middle of tiles and score near nothing; if the pitch is doubled they land on
 * the grout lines we skipped and score just as high as the first comb.
 */
function bestComb(profile: Float64Array): Comb | null {
  const p0 = autocorrelationPeak(profile);
  if (!p0) return null;

  let mean = 0;
  for (let i = 0; i < profile.length; i++) mean += profile[i];
  mean /= profile.length;
  if (mean <= 1e-9) return null;

  let comb = fitComb(profile, p0);
  if (!comb) return null;

  for (let attempt = 0; attempt < 3; attempt++) {
    if (comb.period / 2 < 5) break;

    const between = combContrast(
      profile,
      comb.period,
      comb.phase + comb.period / 2,
      mean,
    );
    if (between < comb.contrast * 0.62) break;

    const halved = fitComb(profile, comb.period / 2);
    if (!halved) break;
    comb = halved;
  }

  return comb;
}

/** Mean absolute luminance gradient, projected onto each axis. Grout lines show as peaks. */
function gradientProfiles(img: Bitmap): {
  cols: Float64Array;
  rows: Float64Array;
} {
  const { width, height, data } = img;
  const lum = new Float64Array(width * height);
  for (let i = 0, p = 0; i < lum.length; i++, p += 4) {
    lum[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  }

  const colProfile = new Float64Array(width);
  const rowProfile = new Float64Array(height);

  for (let y = 0; y < height; y++) {
    for (let x = 1; x < width; x++) {
      const d = Math.abs(lum[y * width + x] - lum[y * width + x - 1]);
      colProfile[x] += d;
    }
  }
  for (let y = 1; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = Math.abs(lum[y * width + x] - lum[(y - 1) * width + x]);
      rowProfile[y] += d;
    }
  }

  return { cols: colProfile, rows: rowProfile };
}

export type GridEstimate = {
  cols: number;
  rows: number;
  /** The region trimmed to whole tiles. */
  quad: Quad;
  confident: boolean;
};

const PROFILE_SIZE = 1024;

/**
 * Measure the tile pitch inside the current region, then trim the region so it
 * spans a whole number of tiles.
 *
 * The trim is the important half. Forcing an integer column count across an
 * image whose edges cut through tiles guarantees the cell pitch is wrong by
 * that fraction, and the error accumulates until the far side of the grid is
 * reading the wrong tiles entirely. Snapping the boundary to detected grout
 * lines makes the count and the pitch consistent by construction.
 */
export function estimateGridSize(img: Bitmap, quad: Quad): GridEstimate {
  const rect = rectify(img, quad, PROFILE_SIZE, PROFILE_SIZE);
  const profiles = gradientProfiles(rect);

  const x = bestComb(profiles.cols);
  const y = bestComb(profiles.rows);

  if (!x || !y) {
    return { cols: 24, rows: 24, quad, confident: false };
  }

  const span = (c: Comb) => {
    const last = Math.floor((PROFILE_SIZE - 1 - c.phase) / c.period);
    const count = Math.max(1, Math.min(240, last));
    return {
      count,
      from: c.phase / PROFILE_SIZE,
      to: (c.phase + count * c.period) / PROFILE_SIZE,
    };
  };

  const sx = span(x);
  const sy = span(y);

  const H = homographyFromQuad(quad);
  const trimmed: Quad = [
    project(H, sx.from, sy.from),
    project(H, sx.to, sy.from),
    project(H, sx.to, sy.to),
    project(H, sx.from, sy.to),
  ];

  return {
    cols: sx.count,
    rows: sy.count,
    quad: trimmed,
    // A real grid line is several times brighter than the average column.
    confident: x.contrast > 1.35 && y.contrast > 1.35,
  };
}

/**
 * Full automatic fit: measure the pitch once, trim to whole tiles once, then
 * polish the corners.
 *
 * Measuring is deliberately *not* iterated. Each measurement trims to the
 * outermost grout line it can see, so running it repeatedly nibbles a column
 * off every pass and quietly walks the region inward.
 */
export function autoFit(
  img: Bitmap,
  quad: Quad,
  inset = 0.55,
  field?: Float32Array,
): GridEstimate {
  const measured = estimateGridSize(img, quad);

  return {
    ...measured,
    quad: refineQuad(
      img,
      {
        quad: measured.quad,
        cols: measured.cols,
        rows: measured.rows,
        inset,
      },
      field,
    ),
  };
}

/**
 * Nudge the four corners until the grid lines sit on the grout.
 *
 * Dragging corners by eye gets you close; this closes the last percent, which
 * matters because a grid that drifts even a third of a tile across the image
 * quietly corrupts colours near the far edge. Eight degrees of freedom means it
 * can also absorb the residual perspective the initial measurement missed.
 */
export function refineQuad(
  img: Bitmap,
  params: SampleParams,
  field?: Float32Array,
): Quad {
  const edges = field ?? edgeField(img);
  let quad = params.quad.map((p) => ({ ...p })) as Quad;

  const span =
    (Math.hypot(quad[1].x - quad[0].x, quad[1].y - quad[0].y) +
      Math.hypot(quad[2].x - quad[3].x, quad[2].y - quad[3].y) +
      Math.hypot(quad[3].x - quad[0].x, quad[3].y - quad[0].y) +
      Math.hypot(quad[2].x - quad[1].x, quad[2].y - quad[1].y)) /
    4;

  const score = (q: Quad) => gridLineScore(img, edges, { ...params, quad: q });
  let best = score(quad);

  // Start at roughly half a tile so a fractional-tile misfit is reachable.
  let step = (span / Math.max(params.cols, params.rows)) * 0.5;
  const minStep = Math.max(0.05, span * 0.0004);

  while (step > minStep) {
    let improvedThisLevel = false;

    for (let pass = 0; pass < 4; pass++) {
      let improved = false;

      for (let i = 0; i < 4; i++) {
        for (const axis of ["x", "y"] as const) {
          for (const dir of [1, -1]) {
            const trial = quad.map((p) => ({ ...p })) as Quad;
            trial[i][axis] += dir * step;

            const s = score(trial);
            if (s > best * (1 + 1e-5)) {
              best = s;
              quad = trial;
              improved = true;
              improvedThisLevel = true;
              break;
            }
          }
        }
      }

      if (!improved) break;
    }

    step *= improvedThisLevel ? 0.7 : 0.5;
  }

  return quad;
}

/** Default quad: the whole image. */
export function fullImageQuad(width: number, height: number): Quad {
  return [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ] as Quad;
}

export function quadCenter(quad: Quad): Pt {
  return {
    x: (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4,
    y: (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4,
  };
}
