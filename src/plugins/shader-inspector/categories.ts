/** What each metric is split into, and the colors the views use for them. */
import { Metric, SLOT_KINDS, Stats } from "./tree";
import { COST_CATEGORIES } from "./worker";

export interface Category {
  key: string;
  color: string;
}

const COST_COLORS: Record<string, string> = {
  never: "#000000",
  reduction: "#6042a6",
  list: "#2d70b3",
  heavy: "#c74440",
  costly: "#fa7e19",
  cheap: "#388c46",
  free: "#b8bcc2",
};

const SLOT_COLORS: Record<string, string> = {
  single: "#2d70b3",
  list: "#388c46",
  baked: "#c74440",
};

export function categoriesOf(metric: Metric): Category[] {
  switch (metric) {
    case "cost":
      return COST_CATEGORIES.map((key) => ({ key, color: COST_COLORS[key] }));
    case "uniforms":
      return SLOT_KINDS.map((key) => ({ key, color: SLOT_COLORS[key] }));
    case "glsl":
      return [{ key: "chars", color: "#6042a6" }];
    case "loops":
      return [{ key: "steps", color: "#fa7e19" }];
  }
}

/** A node's stats for `metric`, by category. */
export function breakdown(
  stats: Stats,
  metric: Metric
): Partial<Record<string, number>> {
  switch (metric) {
    case "cost":
      return stats.cost;
    case "uniforms":
      return stats.slots;
    case "glsl":
      return { chars: stats.chars };
    case "loops":
      return { steps: stats.loopSteps };
  }
}

export function categoryColor(metric: Metric, key: string) {
  return categoriesOf(metric).find((c) => c.key === key)?.color ?? "#999";
}

/** `hex` mixed with white; `t` of 0 is `hex`, 1 is white. */
export function lighten(hex: string, t: number) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const ch = (shift: number) => {
    const c = (n >> shift) & 255;
    return Math.round(c + (255 - c) * t);
  };
  return `rgb(${ch(16)}, ${ch(8)}, ${ch(0)})`;
}

/** Dark text on light fills, white on dark ones. */
export function textOn(fill: string) {
  const m = /^rgb\((\d+), (\d+), (\d+)\)$/.exec(fill);
  const hex = /^#([0-9a-f]{6})$/i.exec(fill);
  let [r, g, b] = [128, 128, 128];
  if (m) [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
  else if (hex) {
    const n = parseInt(hex[1], 16);
    [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? "#222" : "#fff";
}

/** `hex` with transparency `alpha`. */
export function withAlpha(hex: string, alpha: number) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha.toFixed(2)})`;
}
