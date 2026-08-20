import type { Pt, Quad } from "./types";

/**
 * Projective map from the unit square to an arbitrary convex quad.
 *
 * This is the whole reason the tool can handle photographs taken at an angle:
 * a flat grid of tiles seen by a pinhole camera is *exactly* a projective image
 * of a uniform lattice, so undoing one homography recovers a perfect grid.
 */
export type Homography = {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
  g: number;
  h: number;
};

/** Maps (0,0)->q[0], (1,0)->q[1], (1,1)->q[2], (0,1)->q[3]. */
export function homographyFromQuad(q: Quad): Homography {
  const [p0, p1, p2, p3] = q;

  const sx = p0.x - p1.x + p2.x - p3.x;
  const sy = p0.y - p1.y + p2.y - p3.y;

  // Degenerate case: the quad is a parallelogram, so the map is affine.
  if (Math.abs(sx) < 1e-9 && Math.abs(sy) < 1e-9) {
    return {
      a: p1.x - p0.x,
      b: p3.x - p0.x,
      c: p0.x,
      d: p1.y - p0.y,
      e: p3.y - p0.y,
      f: p0.y,
      g: 0,
      h: 0,
    };
  }

  const dx1 = p1.x - p2.x;
  const dx2 = p3.x - p2.x;
  const dy1 = p1.y - p2.y;
  const dy2 = p3.y - p2.y;

  const den = dx1 * dy2 - dx2 * dy1;
  if (Math.abs(den) < 1e-12) {
    // Collapsed quad — fall back to an identity-ish map rather than emitting NaNs.
    return { a: 1, b: 0, c: p0.x, d: 0, e: 1, f: p0.y, g: 0, h: 0 };
  }

  const g = (sx * dy2 - dx2 * sy) / den;
  const h = (dx1 * sy - sx * dy1) / den;

  return {
    a: p1.x - p0.x + g * p1.x,
    b: p3.x - p0.x + h * p3.x,
    c: p0.x,
    d: p1.y - p0.y + g * p1.y,
    e: p3.y - p0.y + h * p3.y,
    f: p0.y,
    g,
    h,
  };
}

/** Project a unit-square coordinate into source-image pixel space. */
export function project(H: Homography, u: number, v: number): Pt {
  const w = H.g * u + H.h * v + 1;
  return {
    x: (H.a * u + H.b * v + H.c) / w,
    y: (H.d * u + H.e * v + H.f) / w,
  };
}

/** Convenience for drawing overlays: the four corners plus interior grid lines. */
export function gridLines(
  H: Homography,
  cols: number,
  rows: number,
  segments = 8,
): { x: number; y: number }[][] {
  const lines: Pt[][] = [];

  for (let i = 0; i <= cols; i++) {
    const u = i / cols;
    const line: Pt[] = [];
    for (let s = 0; s <= segments; s++) line.push(project(H, u, s / segments));
    lines.push(line);
  }
  for (let j = 0; j <= rows; j++) {
    const v = j / rows;
    const line: Pt[] = [];
    for (let s = 0; s <= segments; s++) line.push(project(H, s / segments, v));
    lines.push(line);
  }

  return lines;
}
