import {
  deltaE,
  deltaERgb,
  hexToRgb,
  linearToSrgb,
  modalColor,
  rgbToOklab,
  srgbToLinear,
} from "./color";
import { quantize } from "./palette";
import type {
  Analysis,
  Cell,
  ClassifyParams,
  Diagonal,
  GridSamples,
  RGB,
} from "./types";

/**
 * A smooth estimate of what the base tile looks like at each point of the wall.
 *
 * Built from block medians rather than a fitted polynomial. A global quadratic
 * is tempting and was tried first, but it bends to fit the middle of the image
 * and then swings wide at the corners — on the reference photos it invented a
 * staircase of phantom white tiles along the bottom edge, because the surface
 * had drifted far enough from the real grout colour that ordinary background
 * read as "coloured". Block medians can only ever report a colour that actually
 * occurs nearby, so the estimate degrades gracefully instead of diverging.
 */
class BackgroundField {
  private readonly blocksX: number;
  private readonly blocksY: number;
  private readonly blockW: number;
  private readonly blockH: number;
  private readonly medians: RGB[];

  constructor(
    colors: RGB[],
    isBackground: boolean[],
    cols: number,
    rows: number,
    fallback: RGB,
  ) {
    const blocks = Math.max(1, Math.min(6, Math.round(Math.min(cols, rows) / 8)));
    this.blocksX = blocks;
    this.blocksY = blocks;
    this.blockW = cols / blocks;
    this.blockH = rows / blocks;

    const buckets: RGB[][] = Array.from(
      { length: blocks * blocks },
      () => [] as RGB[],
    );

    for (let i = 0; i < colors.length; i++) {
      if (!isBackground[i]) continue;
      const col = i % cols;
      const row = (i / cols) | 0;
      const bx = Math.min(blocks - 1, Math.floor(col / this.blockW));
      const by = Math.min(blocks - 1, Math.floor(row / this.blockH));
      buckets[by * blocks + bx].push(colors[i]);
    }

    this.medians = buckets.map((bucket) =>
      bucket.length >= 4 ? medianColor(bucket) : fallback,
    );

    // A block with too few background samples borrows from its neighbours,
    // so a figure-dense corner doesn't punch a hole in the estimate.
    for (let by = 0; by < blocks; by++) {
      for (let bx = 0; bx < blocks; bx++) {
        if (buckets[by * blocks + bx].length >= 4) continue;
        const pooled: RGB[] = [];
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = bx + dx;
            const ny = by + dy;
            if (nx < 0 || ny < 0 || nx >= blocks || ny >= blocks) continue;
            pooled.push(...buckets[ny * blocks + nx]);
          }
        }
        if (pooled.length >= 4) {
          this.medians[by * blocks + bx] = medianColor(pooled);
        }
      }
    }
  }

  at(col: number, row: number): RGB {
    const fx = (col + 0.5) / this.blockW - 0.5;
    const fy = (row + 0.5) / this.blockH - 0.5;

    const x0 = Math.max(0, Math.min(this.blocksX - 1, Math.floor(fx)));
    const y0 = Math.max(0, Math.min(this.blocksY - 1, Math.floor(fy)));
    const x1 = Math.min(this.blocksX - 1, x0 + 1);
    const y1 = Math.min(this.blocksY - 1, y0 + 1);

    const tx = Math.max(0, Math.min(1, fx - x0));
    const ty = Math.max(0, Math.min(1, fy - y0));

    const c00 = this.medians[y0 * this.blocksX + x0];
    const c10 = this.medians[y0 * this.blocksX + x1];
    const c01 = this.medians[y1 * this.blocksX + x0];
    const c11 = this.medians[y1 * this.blocksX + x1];

    const mix = (a: number, b: number, t: number) => a * (1 - t) + b * t;
    return {
      r: mix(mix(c00.r, c10.r, tx), mix(c01.r, c11.r, tx), ty),
      g: mix(mix(c00.g, c10.g, tx), mix(c01.g, c11.g, tx), ty),
      b: mix(mix(c00.b, c10.b, tx), mix(c01.b, c11.b, tx), ty),
    };
  }
}

function medianColor(colors: RGB[]): RGB {
  const pick = (get: (c: RGB) => number) => {
    const values = colors.map(get).sort((a, b) => a - b);
    const mid = values.length >> 1;
    return values.length % 2
      ? values[mid]
      : (values[mid - 1] + values[mid]) / 2;
  };
  return { r: pick((c) => c.r), g: pick((c) => c.g), b: pick((c) => c.b) };
}

/** Rescale a colour as if the local base tile were the global one. */
function relight(color: RGB, local: RGB, target: RGB): RGB {
  const scale = (c: number, l: number, t: number) => {
    const lin = srgbToLinear(l);
    if (lin < 1e-4) return c;
    const gain = Math.min(2, Math.max(0.5, srgbToLinear(t) / lin));
    return linearToSrgb(srgbToLinear(c) * gain);
  };
  return {
    r: scale(color.r, local.r, target.r),
    g: scale(color.g, local.g, target.g),
    b: scale(color.b, local.b, target.b),
  };
}

type CellColors = {
  median: RGB;
  mainA: RGB;
  mainB: RGB;
  antiA: RGB;
  antiB: RGB;
};

/**
 * A half-tile must beat the flat-tile reading on one diagonal *and* on only one
 * diagonal. A cell that merely straddles a vertical seam because the grid
 * drifted looks equally split on both diagonals, so the ratio test rejects it
 * while a genuine triangle — whose other diagonal cuts both halves evenly and
 * therefore reads as no split at all — sails through.
 */
const DIAGONAL_DOMINANCE = 1.5;

export function analyze(
  samples: GridSamples,
  params: ClassifyParams,
): Analysis {
  const { cells: raw, cols, rows } = samples;

  const colors: CellColors[] = raw.map((c) => ({
    median: c.median,
    mainA: c.mainA,
    mainB: c.mainB,
    antiA: c.antiA,
    antiB: c.antiB,
  }));

  const usable = colors.filter((_, i) => !raw[i].outside);
  const globalBackground = modalColor(
    (usable.length ? usable : colors).map((c) => c.median),
  );

  // Two rounds: the first background mask is biased by the lighting it is
  // trying to measure, so re-deriving it from a flattened image tightens it.
  let field: BackgroundField | null = null;
  if (params.normalizeLighting) {
    for (let round = 0; round < 2; round++) {
      const loose = Math.max(params.bgThreshold, 9);
      const mask = colors.map((c, i) => {
        if (raw[i].outside) return false;
        const reference = field ? field.at(raw[i].col, raw[i].row) : globalBackground;
        return deltaERgb(c.median, reference) < loose;
      });
      field = new BackgroundField(
        colors.map((c) => c.median),
        mask,
        cols,
        rows,
        globalBackground,
      );
    }
  }

  const referenceFor = (i: number): RGB =>
    field ? field.at(raw[i].col, raw[i].row) : globalBackground;

  /**
   * Classification measures each cell against its *local* base tile rather than
   * rescaling the cell and comparing globally. Same information, but a bad
   * estimate can then only shift the reference a little — it can't amplify an
   * ordinary tile into a bright phantom one.
   */
  const isColored = (c: RGB, i: number) =>
    deltaE(rgbToOklab(c), rgbToOklab(referenceFor(i))) > params.bgThreshold;

  type Draft =
    | { kind: "empty" }
    | { kind: "square"; color: RGB }
    | {
        kind: "split";
        diagonal: Diagonal;
        first: RGB | null;
        second: RGB | null;
      };

  const drafts: Draft[] = colors.map((c, i) => {
    if (raw[i].outside) return { kind: "empty" };

    if (params.allowSplits) {
      const dMain = deltaERgb(c.mainA, c.mainB);
      const dAnti = deltaERgb(c.antiA, c.antiB);

      const mainWins = dMain >= dAnti;
      const strong = mainWins ? dMain : dAnti;
      const weak = mainWins ? dAnti : dMain;
      const halfA = mainWins ? c.mainA : c.antiA;
      const halfB = mainWins ? c.mainB : c.antiB;

      if (
        strong > params.splitThreshold &&
        strong > weak * DIAGONAL_DOMINANCE
      ) {
        const first = isColored(halfA, i) ? halfA : null;
        const second = isColored(halfB, i) ? halfB : null;

        if (
          first &&
          second &&
          deltaERgb(first, second) < params.splitThreshold
        ) {
          return { kind: "square", color: c.median };
        }
        if (first || second) {
          return {
            kind: "split",
            diagonal: mainWins ? "main" : "anti",
            first,
            second,
          };
        }
        return { kind: "empty" };
      }
    }

    return isColored(c.median, i)
      ? { kind: "square", color: c.median }
      : { kind: "empty" };
  });

  // --- Palette ---------------------------------------------------------------
  //
  // Clustering *is* done on relit colours: the same physical tile photographed
  // in shadow and in light must land in one bucket, or the palette fills up
  // with near-duplicates and the wall looks blotchy.

  const swatchSources: RGB[] = [];
  const slots: { draft: number; field: "color" | "first" | "second" }[] = [];

  drafts.forEach((d, i) => {
    const flatten = (c: RGB) =>
      field ? relight(c, referenceFor(i), globalBackground) : c;

    if (d.kind === "square") {
      swatchSources.push(flatten(d.color));
      slots.push({ draft: i, field: "color" });
    } else if (d.kind === "split") {
      if (d.first) {
        swatchSources.push(flatten(d.first));
        slots.push({ draft: i, field: "first" });
      }
      if (d.second) {
        swatchSources.push(flatten(d.second));
        slots.push({ draft: i, field: "second" });
      }
    }
  });

  let palette: RGB[] = [];
  let paletteCounts: number[] = [];
  const resolved = drafts.map((d) => ({ ...d }) as Draft);

  if (params.paletteSize > 0 && swatchSources.length > 0) {
    const q = quantize(swatchSources, params.paletteSize);

    palette = q.palette.map((c, i) => {
      const override = params.paletteOverrides[i];
      const parsed = override ? hexToRgb(override) : null;
      return parsed ?? c;
    });
    paletteCounts = q.counts;

    slots.forEach((slot, i) => {
      const color = palette[q.assign[i]];
      const target = resolved[slot.draft];
      if (target.kind === "square" && slot.field === "color") {
        target.color = color;
      } else if (target.kind === "split") {
        if (slot.field === "first") target.first = color;
        else if (slot.field === "second") target.second = color;
      }
    });
  } else if (field) {
    // No quantisation, but still even out the lighting per cell.
    slots.forEach((slot, i) => {
      const target = resolved[slot.draft];
      const color = swatchSources[i];
      if (target.kind === "square" && slot.field === "color") {
        target.color = color;
      } else if (target.kind === "split") {
        if (slot.field === "first") target.first = color;
        else if (slot.field === "second") target.second = color;
      }
    });
  }

  const cells: Cell[] = resolved.map((d, i) => {
    const { col, row } = raw[i];
    if (d.kind === "square") return { kind: "square", col, row, color: d.color };
    if (d.kind === "split") {
      return {
        kind: "split",
        col,
        row,
        diagonal: d.diagonal,
        first: d.first,
        second: d.second,
      };
    }
    return { kind: "empty", col, row };
  });

  return {
    cols,
    rows,
    cells,
    background: globalBackground,
    palette,
    paletteCounts,
    emptyCount: cells.filter((c) => c.kind === "empty").length,
    squareCount: cells.filter((c) => c.kind === "square").length,
    splitCount: cells.filter((c) => c.kind === "split").length,
  };
}
