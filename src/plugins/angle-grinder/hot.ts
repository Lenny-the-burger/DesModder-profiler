/**
 * Rewrites for values that keep changing ("hot" values), which can't be typed
 * in. Measured on Desmos's compiler:
 *
 * - Anything that doesn't depend on the pixel is folded on the CPU, and each
 *   number of the result that isn't typed in takes a uniform slot. So
 *   `(p-C)·N`, with lists of points `C` and `N`, sends both lists: six
 *   numbers per element. `p·N - C·N` sends `N` and the folded `C·N`: four.
 *   Splitting a product like that is `distribute`.
 *
 * - `E with T=T+0x` rebinds `T` inside every definition `E` reads, which
 *   makes everything computed from `T` depend on the pixel, so it is computed
 *   in the shader from `T`'s one uniform slot instead of being folded into
 *   lists of slots. It costs the shader the work of computing those values
 *   per pixel. That is `pushToGpu`.
 *
 * - Desmos doesn't allow a `with` inside another `with`.
 */
import type { Aug } from "../../../text-mode-core";
import type { Value } from "./rewrite";
import { mapChildren } from "./rewrite";

type Node = Aug.Latex.AnyRootOrChild;
type Child = Aug.Latex.AnyChild;

/** Typed-in, changing but the same for every pixel, or per pixel. */
export enum Kind {
  Cold = 0,
  Hot = 1,
  Pixel = 2,
}

export interface Names {
  /** Variables with a value that doesn't depend on the pixel. */
  constants: ReadonlySet<string>;
  /** Of those, the ones written into this expression as typed-in numbers. */
  typedIn: ReadonlySet<string>;
  /** Every symbol the graph defines. */
  defined: ReadonlySet<string>;
}

/**
 * How `node` varies. Bound names (function parameters, indices, `with`) and
 * calls to the graph's functions count as per pixel, which is never wrong
 * here: it only stops a rewrite.
 */
export function kindOf(
  node: Node,
  names: Names,
  bound: ReadonlySet<string> = new Set()
): Kind {
  const ofName = (s: string, b: ReadonlySet<string>): Kind => {
    if (b.has(s)) return Kind.Pixel;
    if (names.typedIn.has(s)) return Kind.Cold;
    if (names.constants.has(s)) return Kind.Hot;
    // Undefined names are coordinates or built-in constants like `\pi`.
    if (!names.defined.has(s))
      return PIXEL_NAMES.has(s) ? Kind.Pixel : Kind.Cold;
    // Defined, but not the same for every pixel (or not a number at all).
    return Kind.Pixel;
  };
  let k = Kind.Cold;
  const visit = (n: Node, b: ReadonlySet<string>) => {
    if (k === Kind.Pixel) return;
    if (n.type === "Identifier") {
      k = Math.max(k, ofName(n.symbol, b));
      return;
    }
    if (n.type === "FunctionCall") {
      const callee = n.callee.symbol;
      // A variable called like a function is a product with it, and the
      // graph's own functions count as per pixel. Built-in functions are as
      // varying as their arguments.
      if (names.defined.has(callee) || b.has(callee))
        k = Math.max(k, ofName(callee, b));
    }
    if (bindsNames(n)) {
      k = Kind.Pixel;
      return;
    }
    mapChildren(n, b, (c, cb) => {
      visit(c, cb);
      return c;
    });
  };
  visit(node, bound);
  return k;
}

/** Names Desmos draws over; see analyze.ts. */
const PIXEL_NAMES = new Set([
  "x",
  "y",
  "z",
  "r",
  "theta",
  "rho",
  "phi",
  "u",
  "v",
  "t",
]);

function bindsNames(n: Node) {
  switch (n.type) {
    case "FunctionDefinition":
    case "Integral":
    case "Derivative":
    case "ListComprehension":
    case "Substitution":
    case "RepeatedOperator":
      return true;
    default:
      return false;
  }
}

interface Term {
  negative: boolean;
  node: Child;
}

/** The terms of a sum, with their signs. */
function termsOf(n: Child, negative = false, out: Term[] = []): Term[] {
  if (n.type === "BinaryOperator" && n.name === "Add") {
    termsOf(n.left, negative, out);
    termsOf(n.right, negative, out);
  } else if (n.type === "BinaryOperator" && n.name === "Subtract") {
    termsOf(n.left, negative, out);
    termsOf(n.right, !negative, out);
  } else if (n.type === "Negative") {
    termsOf(n.arg, !negative, out);
  } else out.push({ negative, node: n });
  return out;
}

/**
 * A sum of terms, built the way the parser builds `a-b+c`, and whether it is
 * negated: if every term is negative, the sum of their negations.
 */
function sumOf(terms: Term[]): Term {
  const allNegative = terms.every((t) => t.negative);
  const signed = allNegative
    ? terms.map((t) => ({ ...t, negative: false }))
    : terms;
  const ordered = [
    ...signed.filter((t) => !t.negative),
    ...signed.filter((t) => t.negative),
  ];
  let out: Child = ordered[0].node;
  for (const t of ordered.slice(1))
    out = {
      type: "BinaryOperator",
      name: t.negative ? "Subtract" : "Add",
      left: out,
      right: t.node,
    };
  return { negative: allNegative, node: out };
}

const product = (left: Child, right: Child): Child => ({
  type: "BinaryOperator",
  name: "Multiply",
  left,
  right,
});

/**
 * Split each product of a changing value and a sum that has both per-pixel
 * terms and changing terms, like `(p-C)·N`, into `p·N - C·N`, so the changing
 * part is folded into one value. `count` is how many were split. Whether that
 * takes fewer slots depends on the types (for numbers it doesn't), so the
 * caller measures it.
 */
export function distribute<T extends Node>(
  root: T,
  names: Names
): { root: T; count: number } {
  let count = 0;
  const go = (n: Node, bound: ReadonlySet<string>): Node => {
    const m = mapChildren(n, bound, (c, b) => go(c, b) as Child);
    if (m.type !== "BinaryOperator" || m.name !== "Multiply") return m;
    const split = (sum: Child, factor: Child, factorFirst: boolean) => {
      if (kindOf(factor, names, bound) !== Kind.Hot) return undefined;
      const terms = termsOf(sum);
      if (terms.length < 2) return undefined;
      const pixel = terms.filter(
        (t) => kindOf(t.node, names, bound) === Kind.Pixel
      );
      const rest = terms.filter(
        (t) => kindOf(t.node, names, bound) !== Kind.Pixel
      );
      if (pixel.length === 0 || rest.length === 0) return undefined;
      if (!rest.some((t) => kindOf(t.node, names, bound) === Kind.Hot))
        return undefined;
      const times = (t: Term): Term => ({
        negative: t.negative,
        node: factorFirst ? product(factor, t.node) : product(t.node, factor),
      });
      count++;
      const total = sumOf([times(sumOf(pixel)), times(sumOf(rest))]);
      const out: Child = total.negative
        ? { type: "Negative", arg: total.node }
        : total.node;
      return out;
    };
    return split(m.left, m.right, false) ?? split(m.right, m.left, true) ?? m;
  };
  return { root: go(root, new Set()) as T, count };
}

function containsWith(n: Node): boolean {
  if (n.type === "Substitution") return true;
  let found = false;
  mapChildren(n, new Set(), (c) => {
    if (!found && containsWith(c)) found = true;
    return c;
  });
  return found;
}

/** `s + 0w`, shaped for the type of `s`'s value. */
function plusZero(s: string, v: Value, w: string): Child {
  const zero = product(
    { type: "Constant", value: 0 },
    { type: "Identifier", symbol: w }
  );
  const dims =
    v.type === "point" || v.type === "points" ? v.value.length : undefined;
  return {
    type: "BinaryOperator",
    name: "Add",
    left: { type: "Identifier", symbol: s },
    right: dims
      ? product(zero, {
          type: "Seq",
          parenWrapped: true,
          args: Array.from({ length: dims }, () => ({
            type: "Constant" as const,
            value: 1,
          })),
        })
      : zero,
  };
}

/**
 * `node with s=s+0w, …`, joined into `node`'s own `with` if it is one.
 * Undefined if `node` has a `with` further in, which can't hold another.
 */
function withPushed(node: Child, push: Aug.Latex.AssignmentExpression[]) {
  if (node.type === "Substitution") {
    if (containsWith(node.body) || node.assignments.some(containsWith))
      return undefined;
    const taken = new Set(node.assignments.map((a) => a.variable.symbol));
    if (push.some((p) => taken.has(p.variable.symbol))) return undefined;
    return { ...node, assignments: [...node.assignments, ...push] };
  }
  if (containsWith(node)) return undefined;
  const out: Aug.Latex.Substitution = {
    type: "Substitution",
    body: node,
    assignments: push,
  };
  return out;
}

export type ShaderPart = "color" | "restriction";

/**
 * Rebind each of `symbols` as `s=s+0w` around the part of `root` that a
 * shader computes, where `w` is a coordinate of that shader. For a color, the
 * definition's right side; for restrictions and inequalities, each side of
 * each comparison. Undefined if there's no place for it.
 */
export function pushToGpu<T extends Node>(
  root: T,
  part: ShaderPart,
  symbols: ReadonlyMap<string, Value>,
  w: string
): T | undefined {
  const push: Aug.Latex.AssignmentExpression[] = [...symbols].map(([s, v]) => ({
    type: "AssignmentExpression",
    variable: { type: "Identifier", symbol: s },
    expression: plusZero(s, v, w),
  }));
  if (part === "color") {
    if (root.type !== "Assignment") return undefined;
    const right = withPushed(root.right, push);
    return right ? { ...root, right } : undefined;
  }
  let failed = false;
  let changed = false;
  const side = (c: Child): Child => {
    // A number or a coordinate has nothing to compute.
    if (
      c.type === "Constant" ||
      (c.type === "Identifier" && PIXEL_NAMES.has(c.symbol))
    )
      return c;
    const out = withPushed(c, push);
    if (!out) {
      failed = true;
      return c;
    }
    changed = true;
    return out;
  };
  const comparisons = (n: Child): Child => {
    if (n.type === "Comparator")
      return { ...n, left: side(n.left), right: side(n.right) };
    if (n.type === "ComparatorChain") return { ...n, args: n.args.map(side) };
    if (n.type === "Or")
      return {
        ...n,
        left: comparisons(n.left) as Aug.Latex.Or["left"],
        right: comparisons(n.right) as Aug.Latex.Or["right"],
      };
    failed = true;
    return n;
  };
  let out: Node;
  if (root.type === "Comparator" || root.type === "ComparatorChain")
    out = comparisons(root);
  else {
    const go = (n: Node): Node => {
      if (n.type === "Restriction" && n.condition !== true)
        return {
          ...n,
          condition: comparisons(
            n.condition
          ) as Aug.Latex.Restriction["condition"],
        };
      return mapChildren(n, new Set(), (c) => go(c) as Child);
    };
    out = go(root);
  }
  return failed || !changed ? undefined : (out as T);
}
