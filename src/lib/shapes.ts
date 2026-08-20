import { rgbToHex } from "./color";
import type {
  Analysis,
  Cell,
  EmitParams,
  Figure,
  Pt,
  Shape,
  VectorDoc,
} from "./types";

const EMPTY = 0;
const SQUARE = 1;
const SPLIT = 2;

/** Geometry of one cell's tile face, after the grout gap is taken off. */
function faceOf(col: number, row: number, tileSize: number, gap: number) {
  const half = gap / 2;
  return {
    x0: col * tileSize + half,
    y0: row * tileSize + half,
    x1: (col + 1) * tileSize - half,
    y1: (row + 1) * tileSize - half,
  };
}

function trianglePoints(
  col: number,
  row: number,
  tileSize: number,
  gap: number,
  diagonal: "main" | "anti",
  side: "first" | "second",
): Pt[] {
  const { x0, y0, x1, y1 } = faceOf(col, row, tileSize, gap);
  const TL = { x: x0, y: y0 };
  const TR = { x: x1, y: y0 };
  const BR = { x: x1, y: y1 };
  const BL = { x: x0, y: y1 };

  if (diagonal === "main") {
    // Cut runs TL -> BR.
    return side === "first" ? [TL, TR, BR] : [TL, BR, BL];
  }
  // Cut runs TR -> BL.
  return side === "first" ? [TL, TR, BL] : [TR, BR, BL];
}

/**
 * Greedy maximal-rectangle merge over same-colour squares.
 *
 * Runs left-to-right then grows downward while the whole row-run still matches,
 * which is the standard tile-map merge. It turns a figure's 4x3 red torso from
 * twelve rectangles into one, and it never merges across a colour change or
 * across a half-tile.
 */
type Block = { col: number; row: number; w: number; h: number; fill: string };

function mergeSquares(
  cols: number,
  rows: number,
  kinds: Uint8Array,
  keys: (string | null)[],
  fills: (string | null)[],
  member: (index: number) => boolean,
  visited: Uint8Array,
): Block[] {
  const out: Block[] = [];

  const ok = (col: number, row: number, key: string) => {
    if (col < 0 || row < 0 || col >= cols || row >= rows) return false;
    const i = row * cols + col;
    return (
      kinds[i] === SQUARE && !visited[i] && member(i) && keys[i] === key
    );
  };

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const i = row * cols + col;
      if (kinds[i] !== SQUARE || visited[i] || !member(i)) continue;

      const key = keys[i]!;

      let w = 1;
      while (ok(col + w, row, key)) w++;

      let h = 1;
      grow: while (row + h < rows) {
        for (let k = 0; k < w; k++) {
          if (!ok(col + k, row + h, key)) break grow;
        }
        h++;
      }

      for (let dy = 0; dy < h; dy++) {
        for (let dx = 0; dx < w; dx++) visited[(row + dy) * cols + col + dx] = 1;
      }

      out.push({ col, row, w, h, fill: fills[i]! });
    }
  }

  return out;
}

/** Flood fill over touching non-background cells. Diagonal contact counts — a figure's
 *  triangular feet often only meet the body at a corner. */
function connectedComponents(
  cols: number,
  rows: number,
  kinds: Uint8Array,
): { ids: Int32Array; count: number } {
  const ids = new Int32Array(cols * rows).fill(-1);
  let next = 0;
  const stack: number[] = [];

  for (let start = 0; start < ids.length; start++) {
    if (kinds[start] === EMPTY || ids[start] !== -1) continue;

    const id = next++;
    ids[start] = id;
    stack.push(start);

    while (stack.length) {
      const i = stack.pop()!;
      const col = i % cols;
      const row = (i / cols) | 0;

      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nc = col + dx;
          const nr = row + dy;
          if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
          const j = nr * cols + nc;
          if (kinds[j] === EMPTY || ids[j] !== -1) continue;
          ids[j] = id;
          stack.push(j);
        }
      }
    }
  }

  return { ids, count: next };
}

export function buildDoc(analysis: Analysis, emit: EmitParams): VectorDoc {
  const { cols, rows, cells } = analysis;
  const { tileSize, gap } = emit;

  const kinds = new Uint8Array(cols * rows);
  const keys: (string | null)[] = new Array(cols * rows).fill(null);
  const fills: (string | null)[] = new Array(cols * rows).fill(null);
  const byIndex: Cell[] = new Array(cols * rows);

  for (const cell of cells) {
    const i = cell.row * cols + cell.col;
    byIndex[i] = cell;
    if (cell.kind === "square") {
      kinds[i] = SQUARE;
      const hex = rgbToHex(cell.color);
      keys[i] = hex;
      fills[i] = hex;
    } else if (cell.kind === "split") {
      kinds[i] = SPLIT;
    }
  }

  const rectShape = (
    col: number,
    row: number,
    w: number,
    h: number,
    fill: string,
  ): Shape => {
    const half = gap / 2;
    return {
      type: "rect",
      x: col * tileSize + half,
      y: row * tileSize + half,
      w: w * tileSize - gap,
      h: h * tileSize - gap,
      fill,
    };
  };

  const splitShapes = (cell: Cell): Shape[] => {
    if (cell.kind !== "split") return [];
    const out: Shape[] = [];
    if (cell.first) {
      out.push({
        type: "poly",
        points: trianglePoints(
          cell.col,
          cell.row,
          tileSize,
          gap,
          cell.diagonal,
          "first",
        ),
        fill: rgbToHex(cell.first),
      });
    }
    if (cell.second) {
      out.push({
        type: "poly",
        points: trianglePoints(
          cell.col,
          cell.row,
          tileSize,
          gap,
          cell.diagonal,
          "second",
        ),
        fill: rgbToHex(cell.second),
      });
    }
    return out;
  };

  // --- Figures ---------------------------------------------------------------

  const { ids, count } = connectedComponents(cols, rows, kinds);

  const cellCounts = new Array(count).fill(0);
  for (let i = 0; i < ids.length; i++) if (ids[i] >= 0) cellCounts[ids[i]]++;

  const keep = new Set<number>();
  for (let id = 0; id < count; id++) {
    if (cellCounts[id] >= emit.minFigureCells) keep.add(id);
  }

  const groupIds = emit.groupFigures ? [...keep].sort((a, b) => a - b) : [-1];
  const figures: Figure[] = [];

  const visited = new Uint8Array(cols * rows);

  for (const gid of groupIds) {
    const member = (i: number) =>
      gid === -1 ? ids[i] >= 0 && keep.has(ids[i]) : ids[i] === gid;

    const shapes: Shape[] = [];

    if (emit.mergeRuns) {
      const merged = mergeSquares(cols, rows, kinds, keys, fills, member, visited);
      for (const m of merged) {
        shapes.push(rectShape(m.col, m.row, m.w, m.h, m.fill));
      }
    } else {
      for (let i = 0; i < kinds.length; i++) {
        if (kinds[i] !== SQUARE || !member(i)) continue;
        const cell = byIndex[i];
        if (cell.kind !== "square") continue;
        shapes.push(rectShape(cell.col, cell.row, 1, 1, rgbToHex(cell.color)));
      }
    }

    for (let i = 0; i < kinds.length; i++) {
      if (kinds[i] !== SPLIT || !member(i)) continue;
      shapes.push(...splitShapes(byIndex[i]));
    }

    if (shapes.length === 0) continue;

    let minCol = cols;
    let minRow = rows;
    let maxCol = -1;
    let maxRow = -1;
    let n = 0;
    for (let i = 0; i < ids.length; i++) {
      if (!member(i)) continue;
      const col = i % cols;
      const row = (i / cols) | 0;
      if (col < minCol) minCol = col;
      if (row < minRow) minRow = row;
      if (col > maxCol) maxCol = col;
      if (row > maxRow) maxRow = row;
      n++;
    }

    figures.push({
      id: figures.length,
      name: "",
      shapes,
      bounds: {
        col: minCol,
        row: minRow,
        cols: maxCol - minCol + 1,
        rows: maxRow - minRow + 1,
      },
      cellCount: n,
    });
  }

  // Reading order, so layer names in Figma match how the eye scans the wall.
  figures.sort(
    (a, b) => a.bounds.row - b.bounds.row || a.bounds.col - b.bounds.col,
  );
  figures.forEach((f, i) => {
    f.id = i;
    f.name = emit.groupFigures
      ? `Figure ${String(i + 1).padStart(2, "0")}`
      : "Tiles";
  });

  // --- Base tiles ------------------------------------------------------------

  const backgroundTiles: Shape[] = [];
  const bgHex = rgbToHex(analysis.background);

  if (emit.backgroundMode === "tiles") {
    for (let i = 0; i < kinds.length; i++) {
      const cell = byIndex[i];
      const dropped = ids[i] >= 0 && !keep.has(ids[i]);

      if (kinds[i] === EMPTY || dropped) {
        const col = i % cols;
        const row = (i / cols) | 0;
        backgroundTiles.push(rectShape(col, row, 1, 1, bgHex));
      } else if (kinds[i] === SPLIT && cell.kind === "split") {
        // The uncoloured half of a half-tile is still a real tile on the wall.
        if (!cell.first) {
          backgroundTiles.push({
            type: "poly",
            points: trianglePoints(
              cell.col,
              cell.row,
              tileSize,
              gap,
              cell.diagonal,
              "first",
            ),
            fill: bgHex,
          });
        }
        if (!cell.second) {
          backgroundTiles.push({
            type: "poly",
            points: trianglePoints(
              cell.col,
              cell.row,
              tileSize,
              gap,
              cell.diagonal,
              "second",
            ),
            fill: bgHex,
          });
        }
      }
    }
  }

  return {
    width: cols * tileSize,
    height: rows * tileSize,
    cols,
    rows,
    background:
      emit.backgroundMode === "flat"
        ? bgHex
        : emit.backgroundMode === "tiles"
          ? null
          : null,
    backgroundTiles,
    figures,
    palette: analysis.palette.map(rgbToHex),
  };
}

export function countShapes(doc: VectorDoc): number {
  return (
    doc.backgroundTiles.length +
    doc.figures.reduce((n, f) => n + f.shapes.length, 0) +
    (doc.background ? 1 : 0)
  );
}
