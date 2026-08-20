export type RGB = { r: number; g: number; b: number };
export type Lab = { L: number; a: number; b: number };

/** A point in source-image pixel space. */
export type Pt = { x: number; y: number };

/** Corners of the tiled region, in order: top-left, top-right, bottom-right, bottom-left. */
export type Quad = [Pt, Pt, Pt, Pt];

/**
 * Which diagonal a half-tile is cut along.
 * `main` runs top-left -> bottom-right, `anti` runs top-right -> bottom-left.
 */
export type Diagonal = "main" | "anti";

/** Raw per-cell measurements taken from the photo. Independent of any thresholds. */
export type CellSample = {
  col: number;
  row: number;
  /** Median colour of the cell's central inset. */
  median: RGB;
  /** Median of the {TL,TR,BR} half (above the main diagonal). */
  mainA: RGB;
  /** Median of the {TL,BR,BL} half (below the main diagonal). */
  mainB: RGB;
  /** Median of the {TL,TR,BL} half (above the anti diagonal). */
  antiA: RGB;
  /** Median of the {TR,BR,BL} half (below the anti diagonal). */
  antiB: RGB;
  /** The cell reads mostly from outside the photo, so its colour means nothing. */
  outside: boolean;
};

export type GridSamples = {
  cols: number;
  rows: number;
  cells: CellSample[];
};

/** A cell after classification and palette snapping. */
export type Cell =
  | { kind: "empty"; col: number; row: number }
  | { kind: "square"; col: number; row: number; color: RGB }
  | {
      kind: "split";
      col: number;
      row: number;
      diagonal: Diagonal;
      /** Above the diagonal. `null` means that half is background. */
      first: RGB | null;
      /** Below the diagonal. `null` means that half is background. */
      second: RGB | null;
    };

export type Analysis = {
  cols: number;
  rows: number;
  cells: Cell[];
  /** Detected grout / base-tile colour, after illumination correction. */
  background: RGB;
  /** Quantised palette actually used by the cells, most-used first. */
  palette: RGB[];
  /** Cell counts per palette entry, parallel to `palette`. */
  paletteCounts: number[];
  emptyCount: number;
  squareCount: number;
  splitCount: number;
};

/** An emitted vector primitive on the ideal lattice. */
export type Shape =
  | { type: "rect"; x: number; y: number; w: number; h: number; fill: string }
  | { type: "poly"; points: Pt[]; fill: string };

/** A connected clump of non-background tiles — one of the little figures. */
export type Figure = {
  id: number;
  name: string;
  shapes: Shape[];
  /** Bounding box in lattice cell units. */
  bounds: { col: number; row: number; cols: number; rows: number };
  cellCount: number;
};

export type VectorDoc = {
  width: number;
  height: number;
  cols: number;
  rows: number;
  background: string | null;
  backgroundTiles: Shape[];
  figures: Figure[];
  palette: string[];
};

export type SampleParams = {
  quad: Quad;
  cols: number;
  rows: number;
  /** Fraction of the cell used for colour sampling, 0..1. Smaller avoids grout lines. */
  inset: number;
};

export type ClassifyParams = {
  /** OKLab ΔE above which a cell counts as coloured rather than background. */
  bgThreshold: number;
  /** OKLab ΔE between two halves above which a cell is treated as a half-tile. */
  splitThreshold: number;
  allowSplits: boolean;
  /** Correct for uneven lighting / vignetting before classifying. */
  normalizeLighting: boolean;
  /** Number of palette colours. 0 disables quantisation (keeps sampled colours). */
  paletteSize: number;
  /** Hex overrides applied after quantisation, keyed by palette index. */
  paletteOverrides: Record<number, string>;
};

export type EmitParams = {
  /** Lattice pitch in output units. */
  tileSize: number;
  /** Grout gap in output units, subtracted from each tile. */
  gap: number;
  /** How to render the untouched base tiles. */
  backgroundMode: "none" | "flat" | "tiles";
  /** Merge runs of same-colour squares into single rectangles. */
  mergeRuns: boolean;
  /** Group touching tiles into one figure per clump. */
  groupFigures: boolean;
  /** Drop clumps smaller than this many cells. */
  minFigureCells: number;
};
