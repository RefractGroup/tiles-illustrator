"use client";

import { useCallback, useDeferredValue, useMemo, useRef, useState } from "react";
import { analyze } from "@/lib/classify";
import { luminance, rgbToHex } from "@/lib/color";
import { toFigmaScript, toJson, toSvg } from "@/lib/exporters";
import { autoFit, fullImageQuad, rectify, refineQuad } from "@/lib/grid";
import { edgeField, sampleGrid, type Bitmap } from "@/lib/sampling";
import { buildDoc, countShapes } from "@/lib/shapes";
import type { ClassifyParams, EmitParams, Quad } from "@/lib/types";
import { ResultCanvas } from "./ResultCanvas";
import { SourceCanvas } from "./SourceCanvas";
import { Button, Panel, Segmented, Slider, Stat, Stepper, Toggle } from "./ui";

const MAX_EDGE = 1800;

const SAMPLES = [
  { name: "Simple shapes", src: "/samples/tiles-simple-shapes.jpg" },
  { name: "Tiled wall", src: "/samples/tiles-wall.jpg" },
  { name: "Half tiles", src: "/samples/tiles-half-tiles.jpg" },
];

type Loaded = {
  name: string;
  canvas: HTMLCanvasElement;
  bitmap: Bitmap;
  /** Blurred edge strength, reused by every grid-alignment pass. */
  edges: Float32Array;
};

async function loadImage(src: Blob | string, name: string): Promise<Loaded> {
  const blob =
    typeof src === "string" ? await (await fetch(src)).blob() : src;
  const bmp = await createImageBitmap(blob);

  const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();

  const data = ctx.getImageData(0, 0, w, h);
  const bitmap: Bitmap = { width: w, height: h, data: data.data };
  return { name, canvas, bitmap, edges: edgeField(bitmap) };
}

function download(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function TilesIllustrator() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const [quad, setQuad] = useState<Quad>(fullImageQuad(100, 100));
  const [cols, setCols] = useState(24);
  const [rows, setRows] = useState(24);
  const [inset, setInset] = useState(0.55);

  const [classifyParams, setClassifyParams] = useState<ClassifyParams>({
    bgThreshold: 9,
    splitThreshold: 22,
    allowSplits: true,
    normalizeLighting: true,
    paletteSize: 20,
    paletteOverrides: {},
  });

  const [emitParams, setEmitParams] = useState<EmitParams>({
    tileSize: 32,
    gap: 2,
    backgroundMode: "flat",
    mergeRuns: false,
    groupFigures: true,
    minFigureCells: 1,
  });

  const [view, setView] = useState<"source" | "result">("source");
  const [showGrid, setShowGrid] = useState(true);
  const [onion, setOnion] = useState(0);
  const [outline, setOutline] = useState(false);
  const [showCode, setShowCode] = useState(false);

  const open = useCallback(
    async (src: Blob | string, name: string) => {
      setBusy("Loading image");
      try {
        const next = await loadImage(src, name);
        setLoaded(next);
        setView("source");

        setBusy("Finding the grid");
        const fit = autoFit(
          next.bitmap,
          fullImageQuad(next.bitmap.width, next.bitmap.height),
          inset,
          next.edges,
        );
        setQuad(fit.quad);
        setCols(fit.cols);
        setRows(fit.rows);
      } finally {
        setBusy(null);
      }
    },
    [inset],
  );

  const sampleParams = useMemo(
    () => ({ quad, cols, rows, inset }),
    [quad, cols, rows, inset],
  );

  // Corner drags fire fast; deferring keeps the handles at 60fps and lets the
  // heavier reconstruction land a frame or two later.
  const deferredSampleParams = useDeferredValue(sampleParams);
  const deferredClassify = useDeferredValue(classifyParams);

  const samples = useMemo(() => {
    if (!loaded) return null;
    return sampleGrid(loaded.bitmap, deferredSampleParams);
  }, [loaded, deferredSampleParams]);

  const analysis = useMemo(() => {
    if (!samples) return null;
    return analyze(samples, deferredClassify);
  }, [samples, deferredClassify]);

  const doc = useMemo(() => {
    if (!analysis) return null;
    return buildDoc(analysis, emitParams);
  }, [analysis, emitParams]);

  const underlay = useMemo(() => {
    if (!loaded || onion === 0) return null;
    const w = 800;
    const h = Math.max(1, Math.round((w * rows) / cols));
    const rect = rectify(loaded.bitmap, deferredSampleParams.quad, w, h);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas
      .getContext("2d")!
      .putImageData(new ImageData(new Uint8ClampedArray(rect.data), w, h), 0, 0);
    return canvas;
  }, [loaded, deferredSampleParams.quad, cols, rows, onion]);

  const svg = useMemo(
    () => (doc ? toSvg(doc, { title: loaded?.name ?? "Tiles" }) : ""),
    [doc, loaded?.name],
  );

  const shapeCount = doc ? countShapes(doc) : 0;

  const runAsync = (label: string, fn: () => void) => {
    setBusy(label);
    // Yield a frame so the busy state paints before the synchronous work starts.
    setTimeout(() => {
      try {
        fn();
      } finally {
        setBusy(null);
      }
    }, 16);
  };

  const snapGrid = () => {
    if (!loaded) return;
    runAsync("Aligning grid", () => {
      setQuad(
        refineQuad(loaded.bitmap, { quad, cols, rows, inset }, loaded.edges),
      );
    });
  };

  const detectGrid = () => {
    if (!loaded) return;
    runAsync("Detecting tile size", () => {
      // Re-measure inside whatever region is currently selected, then trim it
      // to whole tiles and polish — same path the initial load takes.
      const fit = autoFit(loaded.bitmap, quad, inset, loaded.edges);
      setQuad(fit.quad);
      setCols(fit.cols);
      setRows(fit.rows);
    });
  };

  const copy = async (label: string, text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 1800);
  };

  const baseName = (loaded?.name ?? "tiles")
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[^a-z0-9]+/gi, "-")
    .toLowerCase();

  return (
    <div className="flex h-dvh flex-col bg-zinc-950 text-zinc-100">
      <header className="flex shrink-0 items-center gap-4 border-b border-white/8 px-4 py-2.5">
        <div className="flex items-baseline gap-2">
          <h1 className="text-[13px] font-semibold tracking-tight">
            Tiles Illustrator
          </h1>
          <span className="text-[11px] text-zinc-600">
            photo → perfect vector grid
          </span>
        </div>

        <div className="ml-auto flex items-center gap-2">
          {SAMPLES.map((s) => (
            <button
              key={s.src}
              type="button"
              onClick={() => void open(s.src, s.name)}
              className={`rounded-md px-2.5 py-1 text-[11px] transition ${
                loaded?.name === s.name
                  ? "bg-white/10 text-zinc-100"
                  : "text-zinc-500 hover:text-zinc-200"
              }`}
            >
              {s.name}
            </button>
          ))}

          <div className="mx-1 h-4 w-px bg-white/10" />

          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void open(f, f.name);
              e.target.value = "";
            }}
          />
          <Button onClick={() => fileRef.current?.click()}>Open image…</Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <main
          className="relative flex min-w-0 flex-1 flex-col"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const f = e.dataTransfer.files?.[0];
            if (f) void open(f, f.name);
          }}
        >
          <div className="flex shrink-0 items-center gap-3 border-b border-white/8 px-4 py-2">
            <div className="w-56">
              <Segmented
                value={view}
                onChange={setView}
                options={[
                  { value: "source", label: "Source & grid" },
                  { value: "result", label: "Vector result" },
                ]}
              />
            </div>

            {view === "source" ? (
              <label className="flex items-center gap-2 text-[11px] text-zinc-500">
                <input
                  type="checkbox"
                  checked={showGrid}
                  onChange={(e) => setShowGrid(e.target.checked)}
                  className="accent-emerald-400"
                />
                Grid overlay
              </label>
            ) : (
              <>
                <label className="flex items-center gap-2 text-[11px] text-zinc-500">
                  <span>Onion skin</span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={onion}
                    onChange={(e) => setOnion(Number(e.target.value))}
                    className="slider w-24"
                  />
                </label>
                <label className="flex items-center gap-2 text-[11px] text-zinc-500">
                  <input
                    type="checkbox"
                    checked={outline}
                    onChange={(e) => setOutline(e.target.checked)}
                    className="accent-emerald-400"
                  />
                  Show outlines
                </label>
              </>
            )}

            <div className="ml-auto flex items-center gap-3 font-mono text-[11px] text-zinc-600">
              {doc ? (
                <>
                  <span>
                    {cols}×{rows}
                  </span>
                  <span>{doc.figures.length} figures</span>
                  <span>{shapeCount.toLocaleString()} shapes</span>
                </>
              ) : null}
            </div>
          </div>

          <div className="relative min-h-0 flex-1 bg-[#0b0b0d]">
            {loaded && view === "source" ? (
              <SourceCanvas
                source={loaded.canvas}
                quad={quad}
                cols={cols}
                rows={rows}
                onQuadChange={setQuad}
                showGrid={showGrid}
              />
            ) : null}

            {doc && view === "result" ? (
              <ResultCanvas
                doc={doc}
                underlay={underlay}
                underlayOpacity={onion / 100}
                outline={outline}
              />
            ) : null}

            {!loaded && !busy ? (
              <div className="flex h-full flex-col items-center justify-center gap-6 px-8 text-center">
                <div className="max-w-md">
                  <h2 className="text-[15px] font-medium text-zinc-200">
                    Drop a photo of a tile mosaic
                  </h2>
                  <p className="mt-2 text-[13px] leading-relaxed text-zinc-500">
                    The grid gets measured off the grout lines, every tile is
                    read as one colour, and the result comes back out as exact
                    squares and triangles — not a trace.
                  </p>
                </div>

                <div className="flex flex-wrap items-center justify-center gap-3">
                  {SAMPLES.map((s) => (
                    <button
                      key={s.src}
                      type="button"
                      onClick={() => void open(s.src, s.name)}
                      className="group overflow-hidden rounded-lg border border-white/10 transition hover:border-white/30"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={s.src}
                        alt={s.name}
                        className="h-24 w-32 object-cover opacity-80 transition group-hover:opacity-100"
                      />
                      <span className="block px-2 py-1.5 text-[11px] text-zinc-400 group-hover:text-zinc-200">
                        {s.name}
                      </span>
                    </button>
                  ))}
                </div>

                <Button onClick={() => fileRef.current?.click()}>
                  Choose a file
                </Button>
              </div>
            ) : null}

            {busy ? (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <div className="rounded-full border border-white/10 bg-black/80 px-4 py-2 text-[12px] text-zinc-300 backdrop-blur">
                  {busy}…
                </div>
              </div>
            ) : null}
          </div>

          {showCode ? (
            <div className="h-64 shrink-0 overflow-auto border-t border-white/8 bg-black/50">
              <pre className="p-4 font-mono text-[11px] leading-relaxed text-zinc-400">
                {svg.length > 60000
                  ? `${svg.slice(0, 60000)}\n\n… truncated for display (${svg.length.toLocaleString()} chars total). Use Copy or Download for the full file.`
                  : svg}
              </pre>
            </div>
          ) : null}
        </main>

        <aside className="w-[300px] shrink-0 overflow-y-auto border-l border-white/8 bg-zinc-950">
          <Panel
            title="Grid"
            action={
              <div className="flex gap-1">
                <Button variant="ghost" onClick={detectGrid} title="Estimate tile count from the grout period">
                  Detect
                </Button>
                <Button variant="ghost" onClick={snapGrid} title="Nudge the corners to minimise per-tile colour spread">
                  Snap
                </Button>
              </div>
            }
          >
            <Stepper label="Columns" value={cols} min={2} max={240} onChange={setCols} />
            <Stepper label="Rows" value={rows} min={2} max={240} onChange={setRows} />
            <Slider
              label="Sample area"
              value={inset}
              min={0.2}
              max={0.92}
              step={0.01}
              onChange={setInset}
              format={(v) => `${Math.round(v * 100)}%`}
              hint="How much of each tile to read. Lower it if grout is bleeding into the colours."
            />
            <Button
              onClick={() =>
                loaded &&
                setQuad(fullImageQuad(loaded.bitmap.width, loaded.bitmap.height))
              }
            >
              Reset corners
            </Button>
          </Panel>

          <Panel title="Reading the tiles">
            <Toggle
              label="Flatten lighting"
              checked={classifyParams.normalizeLighting}
              onChange={(v) =>
                setClassifyParams((p) => ({ ...p, normalizeLighting: v }))
              }
              hint="Removes the photo's vignette before matching colours."
            />
            <Slider
              label="Colour threshold"
              value={classifyParams.bgThreshold}
              min={2}
              max={40}
              step={0.5}
              onChange={(v) =>
                setClassifyParams((p) => ({ ...p, bgThreshold: v }))
              }
              hint="How far from the base tile a colour must be to count as part of a figure."
            />
            <Toggle
              label="Detect half tiles"
              checked={classifyParams.allowSplits}
              onChange={(v) =>
                setClassifyParams((p) => ({ ...p, allowSplits: v }))
              }
              hint="Diagonally cut tiles become real triangles."
            />
            {classifyParams.allowSplits ? (
              <Slider
                label="Half-tile threshold"
                value={classifyParams.splitThreshold}
                min={4}
                max={50}
                step={0.5}
                onChange={(v) =>
                  setClassifyParams((p) => ({ ...p, splitThreshold: v }))
                }
              />
            ) : null}
          </Panel>

          <Panel
            title="Palette"
            action={
              analysis && Object.keys(classifyParams.paletteOverrides).length ? (
                <Button
                  variant="ghost"
                  onClick={() =>
                    setClassifyParams((p) => ({ ...p, paletteOverrides: {} }))
                  }
                >
                  Reset
                </Button>
              ) : null
            }
          >
            <Slider
              label="Colours"
              value={classifyParams.paletteSize}
              min={0}
              max={48}
              onChange={(v) =>
                setClassifyParams((p) => ({
                  ...p,
                  paletteSize: v,
                  paletteOverrides: {},
                }))
              }
              format={(v) => (v === 0 ? "off (as sampled)" : String(v))}
            />

            {analysis && analysis.palette.length > 0 ? (
              <div className="grid grid-cols-6 gap-1.5">
                {analysis.palette.map((c, i) => {
                  const hex = rgbToHex(c);
                  return (
                    <label
                      key={i}
                      className="group relative aspect-square cursor-pointer rounded"
                      style={{ background: hex }}
                      title={`${hex} — ${analysis.paletteCounts[i]} tiles`}
                    >
                      <input
                        type="color"
                        value={hex}
                        onChange={(e) =>
                          setClassifyParams((p) => ({
                            ...p,
                            paletteOverrides: {
                              ...p.paletteOverrides,
                              [i]: e.target.value,
                            },
                          }))
                        }
                        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                      />
                      <span
                        className="pointer-events-none absolute inset-x-0 bottom-0 text-center text-[8px] font-medium opacity-0 transition group-hover:opacity-100"
                        style={{
                          color: luminance(c) > 0.4 ? "#000" : "#fff",
                        }}
                      >
                        {analysis.paletteCounts[i]}
                      </span>
                    </label>
                  );
                })}
              </div>
            ) : null}
          </Panel>

          <Panel title="Vector output">
            <Slider
              label="Tile size"
              value={emitParams.tileSize}
              min={4}
              max={120}
              onChange={(v) => setEmitParams((p) => ({ ...p, tileSize: v }))}
              format={(v) => `${v} px`}
            />
            <Slider
              label="Grout gap"
              value={emitParams.gap}
              min={0}
              max={Math.max(1, Math.round(emitParams.tileSize / 3))}
              step={0.5}
              onChange={(v) => setEmitParams((p) => ({ ...p, gap: v }))}
              format={(v) => `${v} px`}
            />
            <Segmented
              label="Base tiles"
              value={emitParams.backgroundMode}
              onChange={(v) =>
                setEmitParams((p) => ({ ...p, backgroundMode: v }))
              }
              options={[
                { value: "none", label: "None" },
                { value: "flat", label: "Flat" },
                { value: "tiles", label: "Every tile" },
              ]}
            />
            <Toggle
              label="Merge same-colour runs"
              checked={emitParams.mergeRuns}
              onChange={(v) => setEmitParams((p) => ({ ...p, mergeRuns: v }))}
              hint="Fewer, larger rectangles. Off keeps one shape per physical tile."
            />
            <Toggle
              label="Group each figure"
              checked={emitParams.groupFigures}
              onChange={(v) =>
                setEmitParams((p) => ({ ...p, groupFigures: v }))
              }
              hint="Touching tiles become one named group in Figma."
            />
            <Slider
              label="Min figure size"
              value={emitParams.minFigureCells}
              min={1}
              max={12}
              onChange={(v) =>
                setEmitParams((p) => ({ ...p, minFigureCells: v }))
              }
              format={(v) => (v === 1 ? "keep all" : `${v} tiles`)}
            />
          </Panel>

          {analysis && doc ? (
            <Panel title="Reconstruction">
              <Stat
                label="Base tile"
                value={rgbToHex(analysis.background)}
              />
              <Stat
                label="Coloured tiles"
                value={`${(analysis.squareCount + analysis.splitCount).toLocaleString()} / ${(analysis.cols * analysis.rows).toLocaleString()}`}
              />
              <Stat label="Half tiles" value={analysis.splitCount.toLocaleString()} />
              <Stat label="Figures" value={String(doc.figures.length)} />
              <Stat
                label="Vector shapes"
                value={shapeCount.toLocaleString()}
              />
              <Stat
                label="Canvas"
                value={`${doc.width} × ${doc.height}`}
              />
              {shapeCount > 8000 ? (
                <p className="text-[11px] leading-snug text-amber-500/80">
                  That is a lot of nodes for one Figma frame. Merging runs or
                  dropping the base tiles will thin it out.
                </p>
              ) : null}
            </Panel>
          ) : null}

          <Panel
            title="Export"
            action={
              <Button variant="ghost" onClick={() => setShowCode((v) => !v)}>
                {showCode ? "Hide SVG" : "View SVG"}
              </Button>
            }
          >
            <Button
              variant="primary"
              onClick={() => void copy("svg", svg)}
              disabled={!doc}
            >
              {copied === "svg" ? "Copied — paste in Figma" : "Copy SVG for Figma"}
            </Button>
            <p className="-mt-1 text-[11px] leading-snug text-zinc-600">
              Paste straight onto the Figma canvas. Rectangles arrive as real
              rectangles, half tiles as vectors, each figure as a named group.
            </p>

            <div className="flex gap-2">
              <Button
                onClick={() =>
                  download(`${baseName}.svg`, svg, "image/svg+xml")
                }
                disabled={!doc}
              >
                Download SVG
              </Button>
              <Button
                onClick={() =>
                  analysis &&
                  doc &&
                  download(
                    `${baseName}.json`,
                    toJson(analysis, doc),
                    "application/json",
                  )
                }
                disabled={!doc}
              >
                JSON
              </Button>
            </div>

            <Button
              onClick={() =>
                doc &&
                void copy(
                  "figma",
                  toFigmaScript(doc, `${loaded?.name ?? "Tiles"} — vectors`),
                )
              }
              disabled={!doc}
            >
              {copied === "figma"
                ? "Copied plugin script"
                : "Copy Figma plugin script"}
            </Button>
            <p className="-mt-1 text-[11px] leading-snug text-zinc-600">
              For native Figma nodes with exact layer names — run it in a plugin
              console or hand it to the Figma MCP.
            </p>
          </Panel>
        </aside>
      </div>
    </div>
  );
}
