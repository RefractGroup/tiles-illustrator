import { homographyFromQuad, project, type Homography } from "./homography";
import type { CellSample, GridSamples, RGB, SampleParams } from "./types";

/** Minimal, DOM-free stand-in for ImageData so this file stays testable off-browser. */
export type Bitmap = {
  width: number;
  height: number;
  data: Uint8ClampedArray;
};

/** Bilinear sample, clamped at the edges. Writes into `out` to avoid allocating per point. */
function sampleBilinear(img: Bitmap, x: number, y: number, out: Float32Array) {
  const { width, height, data } = img;

  const fx = Math.min(Math.max(x, 0), width - 1);
  const fy = Math.min(Math.max(y, 0), height - 1);

  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);

  const tx = fx - x0;
  const ty = fy - y0;

  const i00 = (y0 * width + x0) * 4;
  const i10 = (y0 * width + x1) * 4;
  const i01 = (y1 * width + x0) * 4;
  const i11 = (y1 * width + x1) * 4;

  for (let c = 0; c < 3; c++) {
    const top = data[i00 + c] * (1 - tx) + data[i10 + c] * tx;
    const bot = data[i01 + c] * (1 - tx) + data[i11 + c] * tx;
    out[c] = top * (1 - ty) + bot * ty;
  }
}

function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  values.sort((a, b) => a - b);
  const mid = values.length >> 1;
  return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
}

/** How many sample points per cell axis. 9x9 = 81 points, plenty at any realistic tile size. */
const N = 9;

/** Points within this distance of a diagonal are ignored when measuring half-tiles. */
const SEAM_BAND = 0.16;

/**
 * Read every cell of the lattice out of the photo.
 *
 * Per cell we take the *median* of a central patch rather than the mean: grout lines,
 * specular highlights and chipped corners are outliers, and a median ignores them.
 * We also median each of the four diagonal halves, which is what makes half-tile
 * (triangle) detection possible later without a second pass over the image.
 */
export function sampleGrid(img: Bitmap, params: SampleParams): GridSamples {
  const { cols, rows, inset } = params;
  const H = homographyFromQuad(params.quad);

  const cells: CellSample[] = [];
  const rgb = new Float32Array(3);

  // Precompute the cell-local offsets and which halves each one belongs to.
  const offsets: { s: number; t: number; main: 0 | 1 | -1; anti: 0 | 1 | -1 }[] =
    [];
  for (let a = 0; a < N; a++) {
    for (let b = 0; b < N; b++) {
      // s,t sweep the inset region, in cell-local coords where -0.5..0.5 spans the cell.
      const s = ((a + 0.5) / N - 0.5) * inset;
      const t = ((b + 0.5) / N - 0.5) * inset;

      const dMain = t - s; // main diagonal runs TL->BR, i.e. the line t = s
      const dAnti = t + s; // anti diagonal runs TR->BL, i.e. the line t = -s

      offsets.push({
        s,
        t,
        main:
          Math.abs(dMain) < SEAM_BAND * inset ? 0 : dMain < 0 ? 1 : -1,
        anti:
          Math.abs(dAnti) < SEAM_BAND * inset ? 0 : dAnti < 0 ? 1 : -1,
      });
    }
  }

  const du = 1 / cols;
  const dv = 1 / rows;

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const cu = (col + 0.5) * du;
      const cv = (row + 0.5) * dv;

      const all: number[][] = [[], [], []];
      const mainA: number[][] = [[], [], []];
      const mainB: number[][] = [[], [], []];
      const antiA: number[][] = [[], [], []];
      const antiB: number[][] = [[], [], []];
      let outsideCount = 0;

      for (const o of offsets) {
        const p = project(H, cu + o.s * du, cv + o.t * dv);
        if (
          p.x < 0 ||
          p.y < 0 ||
          p.x > img.width - 1 ||
          p.y > img.height - 1
        ) {
          outsideCount++;
        }
        sampleBilinear(img, p.x, p.y, rgb);

        for (let c = 0; c < 3; c++) {
          all[c].push(rgb[c]);
          if (o.main === 1) mainA[c].push(rgb[c]);
          else if (o.main === -1) mainB[c].push(rgb[c]);
          if (o.anti === 1) antiA[c].push(rgb[c]);
          else if (o.anti === -1) antiB[c].push(rgb[c]);
        }
      }

      const median = toRgb(all.map(medianOf));

      cells.push({
        col,
        row,
        median,
        mainA: toRgb(mainA.map(medianOf)),
        mainB: toRgb(mainB.map(medianOf)),
        antiA: toRgb(antiA.map(medianOf)),
        antiB: toRgb(antiB.map(medianOf)),
        // Clamped samples repeat the edge pixel, which reads as a solid tile
        // that isn't there. Better to admit the cell is unknown.
        outside: outsideCount > offsets.length * 0.25,
      });
    }
  }

  return { cols, rows, cells };
}

function toRgb([r, g, b]: number[]): RGB {
  return { r, g, b };
}

/**
 * Blurred edge strength for the whole image. Grout lines light up as ridges.
 *
 * The blur is what makes this usable as an optimisation target: a raw gradient
 * of a two-pixel seam is a spike that a search can step straight over, whereas
 * a softened one gives a smooth hill to climb from a third of a tile away.
 */
export function edgeField(img: Bitmap): Float32Array {
  const { width: w, height: h, data } = img;

  const lum = new Float32Array(w * h);
  for (let i = 0, p = 0; i < lum.length; i++, p += 4) {
    lum[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  }

  const mag = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const gx = lum[y * w + x + 1] - lum[y * w + x - 1];
      const gy = lum[(y + 1) * w + x] - lum[(y - 1) * w + x];
      mag[y * w + x] = Math.sqrt(gx * gx + gy * gy);
    }
  }

  let cur = mag;
  const tmp = new Float32Array(w * h);
  for (let pass = 0; pass < 2; pass++) {
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const a = cur[y * w + (x > 0 ? x - 1 : 0)];
        const b = cur[y * w + x];
        const c = cur[y * w + (x < w - 1 ? x + 1 : w - 1)];
        tmp[y * w + x] = (a + b + c) / 3;
      }
    }
    for (let y = 0; y < h; y++) {
      const up = (y > 0 ? y - 1 : 0) * w;
      const down = (y < h - 1 ? y + 1 : h - 1) * w;
      for (let x = 0; x < w; x++) {
        out[y * w + x] = (tmp[up + x] + tmp[y * w + x] + tmp[down + x]) / 3;
      }
    }
    cur = out;
  }

  return cur;
}

function sampleField(
  field: Float32Array,
  w: number,
  h: number,
  x: number,
  y: number,
): number {
  const fx = Math.min(Math.max(x, 0), w - 1);
  const fy = Math.min(Math.max(y, 0), h - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, w - 1);
  const y1 = Math.min(y0 + 1, h - 1);
  const tx = fx - x0;
  const ty = fy - y0;

  const top = field[y0 * w + x0] * (1 - tx) + field[y0 * w + x1] * tx;
  const bot = field[y1 * w + x0] * (1 - tx) + field[y1 * w + x1] * tx;
  return top * (1 - ty) + bot * ty;
}

/**
 * How strongly the candidate grid lines sit on top of real grout lines. Higher
 * is better; this is the objective `refineQuad` maximises.
 *
 * Two plausible-looking alternatives were tried against a hand-measured lattice
 * on all three reference photos, and both lost:
 *
 * - Minimising colour spread inside each cell rewards *shrinking* the region,
 *   because smaller cells read a smaller patch and so vary less, with no
 *   alignment gained. The optimiser finds that shortcut every time.
 * - A ridge filter across each line looks polarity-agnostic but fires hard on
 *   ordinary colour steps whenever the sample sits slightly off the edge, so it
 *   drifts toward the tile artwork instead of the grout.
 *
 * Sampling a blurred edge field along the lines has neither failure mode: it is
 * maximal exactly when the lines lie on seams, and every seam in these images
 * is a tile boundary.
 */
export function gridLineScore(
  img: Bitmap,
  field: Float32Array,
  params: SampleParams,
): number {
  const { cols, rows } = params;
  const H = homographyFromQuad(params.quad);
  const { width: w, height: h } = img;

  // Keep the work bounded on very fine mosaics.
  const colStride = Math.max(1, Math.ceil(cols / 64));
  const rowStride = Math.max(1, Math.ceil(rows / 64));

  let total = 0;
  let count = 0;

  for (let i = 0; i <= cols; i += colStride) {
    const u = i / cols;
    for (let j = 0; j < rows; j += rowStride) {
      const p = project(H, u, (j + 0.5) / rows);
      total += sampleField(field, w, h, p.x, p.y);
      count++;
    }
  }

  for (let j = 0; j <= rows; j += rowStride) {
    const v = j / rows;
    for (let i = 0; i < cols; i += colStride) {
      const p = project(H, (i + 0.5) / cols, v);
      total += sampleField(field, w, h, p.x, p.y);
      count++;
    }
  }

  return count ? total / count : 0;
}

/** Sample a single point in unit-square space. Used by the UI for the magnifier loupe. */
export function projectUnit(H: Homography, u: number, v: number) {
  return project(H, u, v);
}
