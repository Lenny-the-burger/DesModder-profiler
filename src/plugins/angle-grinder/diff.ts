/**
 * Before and after LaTeX of a rewritten expression, with the variables that
 * were written in and the values they became marked, for showing the change.
 */
import type { Config } from "../../../text-mode-core";
import { Aug, identifierToString } from "../../../text-mode-core";

import { Value, printLatex, substitute, valueSize } from "./rewrite";

/** A marked variable, or the value written in its place. */
export interface MarkedPart {
  symbol: string;
  /** How many numbers its value has. */
  size: number;
}

/**
 * LaTeX where the `i`th marked part is wrapped in `\textcolor` with a color
 * encoding `i`, as `ColoredMath` expects.
 */
export interface MarkedLatex {
  latex: string;
  /** The same LaTeX without markers, to fall back on. */
  plain: string;
  parts: MarkedPart[];
}

/** What else was done to an expression, besides writing values in. */
export interface HotChanges {
  /** Products split so their changing part is folded into one value. */
  split: number;
  /** Variables rebound so what they feed is computed in the shader. */
  gpu: string[];
  /** Functions and definitions written out. */
  inlined: string[];
  /** Repeated parts moved into new definitions. */
  hoisted: number;
  /** Definitions folded into per-element lists. */
  affine: string[];
}

export interface ExpressionDiff extends HotChanges {
  id: string;
  before: MarkedLatex;
  after: MarkedLatex;
}

export const marker = (i: number) =>
  `#${(i + 1).toString(16).padStart(6, "0")}`;

/** Lists longer than this are shown with the middle left out. */
const SHOWN_LIST = 8;

/** A number for reading, to 6 significant digits. */
export function shortNumber(n: number): string {
  if (Number.isNaN(n)) return "\\operatorname{undefined}";
  if (n === Infinity) return "\\infty";
  if (n === -Infinity) return "-\\infty";
  const s = Number(n.toPrecision(6)).toString();
  const e = s.indexOf("e");
  if (e === -1) return s;
  return `${s.slice(0, e)}\\times10^{${Number(s.slice(e + 1))}}`;
}

function shortList(xs: number[]): string {
  const shown =
    xs.length <= SHOWN_LIST
      ? xs.map(shortNumber)
      : [
          ...xs.slice(0, 3).map(shortNumber),
          "...",
          shortNumber(xs[xs.length - 1]),
        ];
  return `\\left[${shown.join(",")}\\right]`;
}

/** A value for reading: rounded, with the middle of long lists left out. */
export function shortValue(v: Value): string {
  switch (v.type) {
    case "number":
      return shortNumber(v.value);
    case "list":
      return shortList(v.value);
    case "point":
      return `\\left(${v.value.map(shortNumber).join(",")}\\right)`;
    case "points":
      return `\\left(${v.value.map(shortList).join(",")}\\right)`;
  }
}

/**
 * Print `root` with each variable in `used` swapped for a placeholder, then
 * replace each placeholder with the marked LaTeX `show` gives for it.
 */
function marked(
  cfg: Config,
  root: Aug.Latex.AnyRootOrChild,
  used: readonly string[],
  values: ReadonlyMap<string, Value>,
  show: (symbol: string) => string
): MarkedLatex {
  const holders = new Map<string, Aug.Latex.AnyChild>();
  const printed = new Map<string, string>();
  used.forEach((s, i) => {
    const holder: Aug.Latex.Identifier = {
      type: "Identifier",
      symbol: `Z_dsmag${i}`,
    };
    holders.set(s, holder);
    printed.set(identifierToString(cfg, holder), s);
  });
  const text = printLatex(cfg, substitute(root, holders, new Set()));
  if (printed.size === 0) return { latex: text, plain: text, parts: [] };
  const pattern = new RegExp(
    [...printed.keys()]
      .map((p) => p.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&"))
      .join("|"),
    "g"
  );
  const parts: MarkedPart[] = [];
  const latex = text.replace(pattern, (p) => {
    const s = printed.get(p)!;
    const v = values.get(s);
    parts.push({ symbol: s, size: v ? valueSize(v) : 0 });
    return `\\textcolor{${marker(parts.length - 1)}}{${show(s)}}`;
  });
  const plain = text.replace(pattern, (p) => show(printed.get(p)!));
  return { latex, plain, parts };
}

/**
 * How `root` changes into `tree` with the variables in `used` replaced with
 * their `values`. `tree` is `root` after the rewrites in `hot`.
 */
export function diffOf(
  cfg: Config,
  id: string,
  root: Aug.Latex.AnyRootOrChild,
  used: Iterable<string>,
  values: ReadonlyMap<string, Value>,
  tree: Aug.Latex.AnyRootOrChild = root,
  changes: HotChanges = {
    split: 0,
    gpu: [],
    inlined: [],
    hoisted: 0,
    affine: [],
  }
): ExpressionDiff {
  const symbols = [...used].filter((s) => values.has(s));
  const name = (s: string) =>
    identifierToString(cfg, { type: "Identifier", symbol: s });
  return {
    id,
    ...changes,
    before: marked(cfg, root, symbols, values, name),
    after: marked(cfg, tree, symbols, values, (s) =>
      shortValue(values.get(s)!)
    ),
  };
}
