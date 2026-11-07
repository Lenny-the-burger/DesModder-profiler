/** Plain-text renderings of numbers, LaTeX and costs. */
import { OpStat, Stats, loopText, repeatsOf } from "./tree";

export const fmt = (n: number) =>
  Number.isFinite(n) ? Math.round(n).toLocaleString() : "∞";

/**
 * LaTeX as readable plain text, for tooltips and the flame graph. Matches the
 * profiler's rendering, so expressions read the same in both.
 */
export function latexToText(latex: string): string {
  // Literal braces (piecewise) survive; structural braces are stripped below.
  const OPEN = "\u0001";
  const CLOSE = "\u0002";
  let s = latex.replace(/\\\{/g, OPEN).replace(/\\\}/g, CLOSE);
  s = s.replace(/\\token\{[^}]*\}/g, "#");
  s = s.replace(/\\left|\\right/g, "");
  s = s.replace(/\\to(?![a-zA-Z])/g, " -> ");
  s = s.replace(/\\cdot/g, " * ");
  s = s.replace(/\\operatorname\{(with|for)\}/g, " $1 ");
  s = s.replace(/\\operatorname\{([^}]*)\}/g, "$1");
  // Desmos-style names: `p_{rojRes}` reads as `projRes`.
  s = s.replace(/([A-Za-z0-9])_\{([^{}]+)\}/g, "$1$2");
  // Innermost first, so nested fractions and roots come out right.
  for (let prev = ""; prev !== s; ) {
    prev = s;
    s = s.replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, "($1)/($2)");
    s = s.replace(/\\sqrt\{([^{}]*)\}/g, "sqrt($1)");
  }
  s = s.replace(/\^\{([^{}]*)\}/g, "^$1");
  s = s.replace(/\\([a-zA-Z]+)/g, "$1");
  s = s.replace(/\\ */g, " ");
  s = s.replace(/[{}]/g, "");
  s = s.split(OPEN).join("{").split(CLOSE).join("}");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

/**
 * How the cost comes from what runs inside loops, like `6 × 100 (n) + 10`,
 * or `undefined` if none of it is in a loop.
 */
export function repeatsText(stats: Stats): string | undefined {
  const repeats = repeatsOf(stats);
  if (!repeats.some((r) => r.loop && r.loop.runs !== 1)) return undefined;
  return repeats
    .map(({ loop, base }) => {
      if (!loop) return fmt(base);
      const vars =
        loop.symbols.length > 0 ? ` (${loop.symbols.join(", ")})` : "";
      return `${fmt(base)} × ${fmt(loop.runs)}${vars}`;
    })
    .join(" + ");
}

/** An operation's row in the cost breakdown: `tan() (×100: n) (×3)`. */
export function opText(o: OpStat) {
  let s = o.op;
  if (o.loop && o.loop.runs !== 1) s += ` (${loopText(o.loop)})`;
  if (o.count > 1) s += ` (×${fmt(o.count)})`;
  return s;
}
