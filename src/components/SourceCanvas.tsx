"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { gridLines, homographyFromQuad } from "@/lib/homography";
import type { Pt, Quad } from "@/lib/types";

const HANDLE_LABELS = ["TL", "TR", "BR", "BL"];
const HIT_RADIUS = 22;

export function SourceCanvas({
  source,
  quad,
  cols,
  rows,
  onQuadChange,
  showGrid,
}: {
  source: HTMLCanvasElement;
  quad: Quad;
  cols: number;
  rows: number;
  onQuadChange: (q: Quad) => void;
  showGrid: boolean;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [dragging, setDragging] = useState<number | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ w: Math.floor(width), h: Math.floor(height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const view = useCallback(() => {
    const scale = Math.min(
      size.w / source.width,
      size.h / source.height,
    );
    return {
      scale,
      ox: (size.w - source.width * scale) / 2,
      oy: (size.h - source.height * scale) / 2,
    };
  }, [size.w, size.h, source.width, source.height]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.w === 0 || size.h === 0) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(size.w * dpr);
    canvas.height = Math.floor(size.h * dpr);

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);

    const { scale, ox, oy } = view();
    const toScreen = (p: Pt) => ({ x: ox + p.x * scale, y: oy + p.y * scale });

    ctx.drawImage(
      source,
      ox,
      oy,
      source.width * scale,
      source.height * scale,
    );

    const corners = quad.map(toScreen);

    // Dim everything outside the selected region so the working area reads clearly.
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, size.w, size.h);
    ctx.moveTo(corners[0].x, corners[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(corners[i].x, corners[i].y);
    ctx.closePath();
    ctx.fillStyle = "rgba(9, 9, 11, 0.62)";
    ctx.fill("evenodd");
    ctx.restore();

    if (showGrid && cols > 0 && rows > 0) {
      const H = homographyFromQuad(quad);
      const lines = gridLines(H, cols, rows, 10);
      const density = Math.max(cols, rows);
      ctx.lineWidth = 1;
      ctx.strokeStyle = `rgba(56, 232, 178, ${density > 60 ? 0.22 : density > 30 ? 0.34 : 0.5})`;
      ctx.beginPath();
      for (const line of lines) {
        line.forEach((p, i) => {
          const s = toScreen(p);
          if (i === 0) ctx.moveTo(s.x, s.y);
          else ctx.lineTo(s.x, s.y);
        });
      }
      ctx.stroke();
    }

    // Region outline.
    ctx.beginPath();
    ctx.moveTo(corners[0].x, corners[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(corners[i].x, corners[i].y);
    ctx.closePath();
    ctx.strokeStyle = "rgba(56, 232, 178, 0.9)";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    corners.forEach((c, i) => {
      const active = dragging === i || hovered === i;
      ctx.beginPath();
      ctx.arc(c.x, c.y, active ? 9 : 6.5, 0, Math.PI * 2);
      ctx.fillStyle = active ? "#38e8b2" : "#0a0a0a";
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#38e8b2";
      ctx.stroke();

      ctx.font =
        "600 10px ui-monospace, SFMono-Regular, Menlo, monospace";
      ctx.fillStyle = "rgba(255,255,255,0.75)";
      ctx.textAlign = "center";
      ctx.fillText(HANDLE_LABELS[i], c.x, c.y - 14);
    });
  }, [source, quad, cols, rows, size, showGrid, dragging, hovered, view]);

  const pointerToImage = (e: React.PointerEvent): Pt => {
    const rect = e.currentTarget.getBoundingClientRect();
    const { scale, ox, oy } = view();
    return {
      x: (e.clientX - rect.left - ox) / scale,
      y: (e.clientY - rect.top - oy) / scale,
    };
  };

  const nearestHandle = (e: React.PointerEvent): number | null => {
    const rect = e.currentTarget.getBoundingClientRect();
    const { scale, ox, oy } = view();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    let best: number | null = null;
    let bestDist = HIT_RADIUS;
    quad.forEach((p, i) => {
      const d = Math.hypot(ox + p.x * scale - sx, oy + p.y * scale - sy);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    });
    return best;
  };

  return (
    <div ref={wrapRef} className="relative h-full w-full">
      <canvas
        ref={canvasRef}
        style={{ width: size.w, height: size.h }}
        className={
          dragging !== null
            ? "cursor-grabbing"
            : hovered !== null
              ? "cursor-grab"
              : "cursor-default"
        }
        onPointerDown={(e) => {
          const h = nearestHandle(e);
          if (h === null) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          setDragging(h);
        }}
        onPointerMove={(e) => {
          if (dragging === null) {
            setHovered(nearestHandle(e));
            return;
          }
          const p = pointerToImage(e);
          const next = quad.map((q) => ({ ...q })) as Quad;
          next[dragging] = {
            x: Math.max(-source.width, Math.min(source.width * 2, p.x)),
            y: Math.max(-source.height, Math.min(source.height * 2, p.y)),
          };
          onQuadChange(next);
        }}
        onPointerUp={(e) => {
          if (dragging !== null) {
            e.currentTarget.releasePointerCapture(e.pointerId);
            setDragging(null);
          }
        }}
        onPointerLeave={() => setHovered(null)}
      />
      <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-white/10 bg-black/70 px-3 py-1 text-[11px] text-zinc-400 backdrop-blur">
        Drag the four corners onto the outermost grout lines
      </div>
    </div>
  );
}
