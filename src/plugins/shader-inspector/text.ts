/** Plain-text renderings of numbers and LaTeX. */

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
