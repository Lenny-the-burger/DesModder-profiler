/** Plain-text renderings of numbers and LaTeX. */

export const fmt = (n: number) =>
  Number.isFinite(n) ? Math.round(n).toLocaleString() : "∞";

/** A rough plain-text rendering of LaTeX, for tooltips and the flame graph. */
export function latexToText(latex: string) {
  return latex
    .replace(/\\left|\\right/g, "")
    .replace(/\\operatorname\{([^}]*)\}/g, "$1")
    .replace(/\\(?:mathrm|text)\{([^}]*)\}/g, "$1")
    .replace(/_\{([^}]*)\}/g, "_$1")
    .replace(/\\cdot/g, "·")
    .replace(/\\(sum|prod)/g, (_, s: string) => (s === "sum" ? "Σ" : "Π"))
    .replace(/\\frac\{([^}]*)\}\{([^}]*)\}/g, "($1)/($2)")
    .replace(/\\([a-zA-Z]+)/g, "$1")
    .replace(/[{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
