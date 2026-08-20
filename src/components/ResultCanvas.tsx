"use client";

import { useEffect, useRef, useState } from "react";
import type { VectorDoc } from "@/lib/types";

/**
 * Draws the vector document to a canvas rather than mounting thousands of SVG
 * nodes — a 60x60 wall can be several thousand shapes, and re-parsing that on
 * every slider tick makes the controls feel like mud.
 */
export function ResultCanvas({
  doc,
  underlay,
  underlayOpacity,
  outline,
}: {
  doc: VectorDoc;
  underlay?: HTMLCanvasElement | null;
  underlayOpacity: number;
  outline: boolean;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

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

    const pad = 24;
    const scale = Math.min(
      (size.w - pad * 2) / doc.width,
      (size.h - pad * 2) / doc.height,
    );
    const ox = (size.w - doc.width * scale) / 2;
    const oy = (size.h - doc.height * scale) / 2;

    ctx.save();
    ctx.translate(ox, oy);
    ctx.scale(scale, scale);

    // Transparency checkerboard, so "no background" is visibly different from white.
    if (!doc.background) {
      const cell = 16 / scale;
      ctx.fillStyle = "#18181b";
      ctx.fillRect(0, 0, doc.width, doc.height);
      ctx.fillStyle = "#202024";
      for (let y = 0; y * cell < doc.height; y++) {
        for (let x = 0; x * cell < doc.width; x++) {
          if ((x + y) % 2) continue;
          ctx.fillRect(x * cell, y * cell, cell, cell);
        }
      }
    } else {
      ctx.fillStyle = doc.background;
      ctx.fillRect(0, 0, doc.width, doc.height);
    }

    if (underlay && underlayOpacity > 0) {
      ctx.globalAlpha = underlayOpacity;
      ctx.drawImage(underlay, 0, 0, doc.width, doc.height);
      ctx.globalAlpha = 1;
    }

    const drawShapes = (shapes: VectorDoc["figures"][number]["shapes"]) => {
      for (const s of shapes) {
        ctx.fillStyle = s.fill;
        if (s.type === "rect") {
          ctx.fillRect(s.x, s.y, s.w, s.h);
        } else {
          ctx.beginPath();
          s.points.forEach((p, i) => {
            if (i === 0) ctx.moveTo(p.x, p.y);
            else ctx.lineTo(p.x, p.y);
          });
          ctx.closePath();
          ctx.fill();
        }
      }
    };

    drawShapes(doc.backgroundTiles);
    for (const fig of doc.figures) drawShapes(fig.shapes);

    if (outline) {
      ctx.strokeStyle = "rgba(56, 232, 178, 0.85)";
      ctx.lineWidth = 1.5 / scale;
      for (const fig of doc.figures) {
        for (const s of fig.shapes) {
          if (s.type === "rect") {
            ctx.strokeRect(s.x, s.y, s.w, s.h);
          } else {
            ctx.beginPath();
            s.points.forEach((p, i) => {
              if (i === 0) ctx.moveTo(p.x, p.y);
              else ctx.lineTo(p.x, p.y);
            });
            ctx.closePath();
            ctx.stroke();
          }
        }
      }
    }

    ctx.restore();
  }, [doc, size, underlay, underlayOpacity, outline]);

  return (
    <div ref={wrapRef} className="h-full w-full">
      <canvas ref={canvasRef} style={{ width: size.w, height: size.h }} />
    </div>
  );
}
