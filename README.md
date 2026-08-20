# Tiles Illustrator

Turns a photograph of a tile mosaic into exact vector geometry, ready to paste
into Figma.

```bash
pnpm dev
```

## What it does differently

This is not an image tracer. Running these photos through potrace or vtracer
gives you wobbly bézier blobs that follow the JPEG noise around each tile — the
opposite of what you want.

Instead the tool exploits the one thing that is true of every mosaic: **it is
already a grid**. So it measures the grid, reads one colour per cell, and
re-emits the whole thing on a perfect lattice. Every square is a real square at
an integer coordinate, because it was never traced in the first place — it was
reconstructed.

## Pipeline

1. **Fit the region.** Four draggable corners define the tiled area. A
   homography maps them to the unit square, which is exact rather than
   approximate: a flat grid seen by a camera *is* a projective image of a
   uniform lattice, so undoing one homography recovers a perfect grid even from
   a photo taken at an angle.
2. **Measure the pitch.** The grout lines show up as a periodic signal in the
   luminance gradient. Autocorrelation finds a rough period; a comb fit then
   recovers period *and* phase to sub-pixel accuracy. The phase matters — it is
   what lets the region be trimmed to a whole number of tiles, so the cell pitch
   and the cell count agree instead of drifting apart across the image.
3. **Snap the corners.** Eight degrees of freedom, hill-climbing on how strongly
   the grid lines sit on a blurred edge field. This absorbs whatever perspective
   the first measurement missed.
4. **Read each cell.** The median of a central patch, so grout, chips and
   specular highlights are outliers rather than contributions. Each of the four
   diagonal halves is measured too, which is what makes half-tiles detectable.
5. **Flatten the lighting.** Every one of these photos has a vignette. A field
   of block medians estimates the base tile colour across the wall, and each
   cell is judged against its *local* base tile rather than a global one.
6. **Classify and quantise.** Cells become empty, a full square, or a diagonal
   half. Colours cluster with k-means in OKLab, so a red and an orange stay
   apart while two near-identical greys merge.
7. **Emit.** Touching tiles are grouped into figures, same-colour runs can be
   merged into single rectangles, and the result is written as `<rect>` and
   `<polygon>`.

## Getting it into Figma

**Copy SVG for Figma**, then ⌘V on the canvas. Figma's importer maps `<rect>` to
real Rectangle nodes, `<polygon>` to Vector nodes, and `<g>` to Groups — so each
tile arrives as an editable object with a proper width and height, and each
little figure arrives as its own named group.

**Copy Figma plugin script** produces JavaScript that builds the same document
through the Plugin API. Slower to set up, but the node types and layer names are
guaranteed rather than inferred by an importer. Run it in a plugin console, or
hand it to the Figma MCP's `use_figma` tool.

## Notes on tuning

- **Colour threshold** is the one control that matters. Glass tiles photographed
  over white grout can be genuinely close to the background; lower it to pull
  pale tiles in, raise it if grout starts registering as artwork.
- **Detect half tiles** is worth turning off for mosaics built only from whole
  squares — on a soft-focus photo it will occasionally read a blurred edge as a
  diagonal.
- **Onion skin** in the result view fades the perspective-corrected source in
  under the reconstruction. It is the fastest way to spot a grid that is off by
  a tile.

## Layout

```
src/lib/
  homography.ts   unit square <-> quad projective map
  grid.ts         pitch/phase measurement, region trimming, corner refinement
  sampling.ts     per-cell medians, diagonal halves, edge field
  classify.ts     lighting field, background, half-tile detection, palette
  palette.ts      OKLab k-means
  shapes.ts       rectangle merging, figure grouping, geometry emission
  exporters.ts    SVG, Figma plugin script, JSON
  color.ts        sRGB / OKLab conversions
```

The `src/lib` modules have no DOM dependency beyond an `ImageData`-shaped
`{ width, height, data }`, so the pipeline can be driven headlessly.
