/** Pure layout and coloring for the flame graph, so it can be unit tested. */
import { FlameCategory, FlameNode } from "./flame";

export interface FlameRect {
  /** In CSS pixels. */
  x: number;
  w: number;
  /** Row index from the top. */
  row: number;
  node: FlameNode;
  /** Keys from the root's children down to this node. */
  keys: string[];
  /** Drawn as an ancestor of the zoomed node (full width, faded). */
  ancestor: boolean;
}

/** Rects narrower than this (in px) are skipped, along with their children. */
export const MIN_RECT_WIDTH = 0.5;

/**
 * Lay out the tree zoomed into the last node of `chain` (root first).
 * Ancestors of the zoomed node get full-width rows above it, like speedscope.
 */
export function layoutFlame(chain: FlameNode[], width: number): FlameRect[] {
  const rects: FlameRect[] = [];
  const keysOf = (i: number) => chain.slice(1, i + 1).map((n) => n.key);
  for (let i = 0; i < chain.length - 1; i++)
    rects.push({
      x: 0,
      w: width,
      row: i,
      node: chain[i],
      keys: keysOf(i),
      ancestor: true,
    });
  const zoomed = chain[chain.length - 1];
  const place = (
    node: FlameNode,
    x: number,
    w: number,
    row: number,
    keys: string[]
  ) => {
    if (w < MIN_RECT_WIDTH) return;
    rects.push({ x, w, row, node, keys, ancestor: false });
    const sum = node.children.reduce((s, c) => s + c.value, 0);
    // Children can't exceed the parent; timing noise could make them.
    const scale = Math.max(node.value, sum);
    if (scale <= 0) return;
    let cx = x;
    for (const child of node.children) {
      const cw = (w * child.value) / scale;
      place(child, cx, cw, row + 1, [...keys, child.key]);
      cx += cw;
    }
  };
  place(zoomed, 0, width, chain.length - 1, keysOf(chain.length - 1));
  return rects;
}

export function rowCount(rects: FlameRect[]): number {
  return rects.reduce((m, r) => Math.max(m, r.row + 1), 0);
}

/** Hue, saturation, and lightness range per category (Desmos's palette). */
const PALETTE: Record<FlameCategory, [number, number, number, number]> = {
  root: [215, 12, 80, 80],
  expression: [215, 18, 72, 84],
  compile: [210, 60, 52, 72],
  graph: [130, 40, 50, 68],
  draw: [27, 90, 58, 72],
  shader: [258, 40, 58, 74],
  gpu: [2, 55, 56, 72],
  other: [0, 0, 70, 80],
};

/** Stable small hash so a given name always gets the same shade. */
export function hashString(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export interface FlameColor {
  fill: string;
  text: string;
}

export function colorFor(node: FlameNode, dimmed: boolean): FlameColor {
  const [h, s, lMin, lMax] = PALETTE[node.category];
  const t = (hashString(node.key) % 1000) / 1000;
  // Definitions are lighter than the expression they belong to.
  const lift = node.kind === "definition" ? 6 : 0;
  const l = Math.min(92, lMin + (lMax - lMin) * t + lift);
  if (dimmed) return { fill: `hsl(${h}, ${s * 0.3}%, 90%)`, text: "#999" };
  return {
    fill: `hsl(${h}, ${s}%, ${l}%)`,
    text: l < 58 ? "#fff" : "#222",
  };
}
