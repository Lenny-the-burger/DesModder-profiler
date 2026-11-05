/** Display helpers for the profiler UI. Pure, so they can be unit tested. */
import { ExpressionRow } from "./aggregate";

/** Format a duration in ms compactly: "0.42 ms", "12.3 ms", "152 ms", "2.31 s". */
export function formatMs(ms: number): string {
  if (!isFinite(ms) || ms <= 0) return "0 ms";
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  if (ms >= 100) return `${ms.toFixed(0)} ms`;
  if (ms >= 10) return `${ms.toFixed(1)} ms`;
  if (ms >= 0.01) return `${ms.toFixed(2)} ms`;
  return "<0.01 ms";
}

const GREEK = new Set([
  "alpha",
  "beta",
  "gamma",
  "delta",
  "epsilon",
  "zeta",
  "eta",
  "theta",
  "iota",
  "kappa",
  "lambda",
  "mu",
  "nu",
  "xi",
  "pi",
  "rho",
  "sigma",
  "tau",
  "upsilon",
  "phi",
  "chi",
  "psi",
  "omega",
  "Gamma",
  "Delta",
  "Theta",
  "Lambda",
  "Xi",
  "Pi",
  "Sigma",
  "Upsilon",
  "Phi",
  "Psi",
  "Omega",
]);

/**
 * Convert a compiler symbol name back to LaTeX: `p_ipeProj` -> `p_{ipeProj}`,
 * `theta_1` -> `\theta_{1}`.
 */
export function symbolToLatex(symbol: string): string {
  const i = symbol.indexOf("_");
  const head = i === -1 ? symbol : symbol.slice(0, i);
  const sub = i === -1 ? undefined : symbol.slice(i + 1);
  const headLatex = GREEK.has(head) ? `\\${head}` : head;
  return sub === undefined ? headLatex : `${headLatex}_{${sub}}`;
}

/** The categories shown in the stacked bars, in display order. */
export const SEGMENTS = [
  "parse",
  "compile",
  "graph",
  "draw",
  "shader",
] as const;
export type Segment = (typeof SEGMENTS)[number];

/** Split an expression's CPU time into the displayed categories. */
export function segmentsOf(row: ExpressionRow): Record<Segment, number> {
  return {
    parse: row.parse,
    compile: row.analysis,
    graph: row.graph,
    draw: row.canvas + row.cpuDraw,
    shader: row.setProgram,
  };
}

/** Width of a bar segment as a CSS percentage of `max`, at least visible if nonzero. */
export function barPercent(value: number, max: number): number {
  if (max <= 0 || value <= 0) return 0;
  return Math.max(0.5, (100 * value) / max);
}
