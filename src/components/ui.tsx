"use client";

import type { ReactNode } from "react";

export function Panel({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="border-b border-white/8 px-4 py-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.09em] text-zinc-500">
          {title}
        </h2>
        {action}
      </div>
      <div className="flex flex-col gap-3.5">{children}</div>
    </section>
  );
}

export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  format,
  hint,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
  hint?: string;
}) {
  return (
    <label className="block">
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-[12px] text-zinc-300">{label}</span>
        <span className="font-mono text-[11px] tabular-nums text-zinc-500">
          {format ? format(value) : value}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="slider w-full"
      />
      {hint ? (
        <p className="mt-1 text-[11px] leading-snug text-zinc-600">{hint}</p>
      ) : null}
    </label>
  );
}

export function Stepper({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  const clamp = (v: number) => Math.max(min, Math.min(max, v));
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[12px] text-zinc-300">{label}</span>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => onChange(clamp(value - 1))}
          className="h-7 w-7 rounded-md border border-white/10 text-zinc-400 transition hover:border-white/25 hover:text-zinc-100"
          aria-label={`Decrease ${label}`}
        >
          −
        </button>
        <input
          type="number"
          value={value}
          min={min}
          max={max}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v)) onChange(clamp(Math.round(v)));
          }}
          className="h-7 w-14 rounded-md border border-white/10 bg-black/40 text-center font-mono text-[12px] tabular-nums text-zinc-100 outline-none focus:border-white/30"
        />
        <button
          type="button"
          onClick={() => onChange(clamp(value + 1))}
          className="h-7 w-7 rounded-md border border-white/10 text-zinc-400 transition hover:border-white/25 hover:text-zinc-100"
          aria-label={`Increase ${label}`}
        >
          +
        </button>
      </div>
    </div>
  );
}

export function Toggle({
  label,
  checked,
  onChange,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
}) {
  return (
    <div>
      <label className="flex cursor-pointer items-center justify-between gap-3">
        <span className="text-[12px] text-zinc-300">{label}</span>
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          onClick={() => onChange(!checked)}
          className={`relative h-[18px] w-[32px] shrink-0 rounded-full transition-colors ${
            checked ? "bg-emerald-500" : "bg-white/12"
          }`}
        >
          <span
            className={`absolute left-0 top-[2px] h-[14px] w-[14px] rounded-full bg-white transition-transform ${
              checked ? "translate-x-[16px]" : "translate-x-[2px]"
            }`}
          />
        </button>
      </label>
      {hint ? (
        <p className="mt-1 text-[11px] leading-snug text-zinc-600">{hint}</p>
      ) : null}
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label?: string;
}) {
  return (
    <div>
      {label ? (
        <div className="mb-1.5 text-[12px] text-zinc-300">{label}</div>
      ) : null}
      <div className="flex rounded-md border border-white/10 p-0.5">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            className={`flex-1 rounded px-2 py-1 text-[11px] font-medium transition ${
              value === o.value
                ? "bg-white/12 text-zinc-100"
                : "text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Button({
  children,
  onClick,
  variant = "default",
  disabled,
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "default" | "primary" | "ghost";
  disabled?: boolean;
  title?: string;
}) {
  const styles = {
    default:
      "border border-white/12 text-zinc-200 hover:border-white/25 hover:bg-white/5",
    primary:
      "bg-zinc-100 text-zinc-900 hover:bg-white font-medium border border-transparent",
    ghost: "text-zinc-400 hover:text-zinc-100 border border-transparent",
  }[variant];

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`rounded-md px-3 py-1.5 text-[12px] transition disabled:cursor-not-allowed disabled:opacity-40 ${styles}`}
    >
      {children}
    </button>
  );
}

export function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-[11px] text-zinc-500">{label}</span>
      <span className="font-mono text-[11px] tabular-nums text-zinc-300">
        {value}
      </span>
    </div>
  );
}
