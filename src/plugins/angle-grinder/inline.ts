/**
 * Rewrites that let values a shader reads more than once share uniform slots.
 * Measured on Desmos's compiler, two reads of the same variable share slots
 * only when they are in the same expression, and only reads of the variable
 * itself: each call of a function, each separate definition and each
 * separately written `2H` gets its own copy of the slots.
 *
 * - `inlineDefinitions` writes calls of the graph's functions, and
 *   definitions computed per pixel that are read once, into the expression,
 *   so what they read is read in one expression. `d(x)+d(y)+d(z)` with
 *   `d(a)=\min(a-H)` takes three copies of `H`, the written-out form one.
 *
 * - `hoistRepeats` moves parts that change but are the same for every pixel,
 *   like `2H`, and that are written more than once, into new definitions, so
 *   they are read as one variable.
 *
 * Both are kept only where measuring shows fewer slots or less cost.
 */
import type { Aug } from "../../../text-mode-core";
import { Kind, Names, containsWith, kindOf } from "./hot";
import { bindingsOf, mapChildren, substitute } from "./rewrite";

type Node = Aug.Latex.AnyRootOrChild;
type Child = Aug.Latex.AnyChild;

export interface Definitions {
  /** The graph's functions, by name. */
  functions: ReadonlyMap<string, Aug.Latex.FunctionDefinition>;
  /** Right sides of definitions computed per pixel, by name. */
  perPixel: ReadonlyMap<string, Child>;
}

/** How deep calls are written out, which also stops recursion. */
const MAX_DEPTH = 8;
/** Written-out trees bigger than this, in nodes, are left as they were. */
const MAX_NODES = 20000;

/** Free names of `n`, functions it calls included. */
export function freeNames(
  n: Node,
  bound: ReadonlySet<string> = new Set(),
  out = new Set<string>()
): Set<string> {
  if (n.type === "Identifier") {
    if (!bound.has(n.symbol)) out.add(n.symbol);
    return out;
  }
  if (n.type === "FunctionCall" && !bound.has(n.callee.symbol))
    out.add(n.callee.symbol);
  mapChildren(n, bound, (c, b) => {
    freeNames(c, b, out);
    return c;
  });
  return out;
}

/** Every name a binding node in `n` binds. */
function boundInside(n: Node, out = new Set<string>()): Set<string> {
  for (const s of bindingsOf(n)) out.add(s);
  mapChildren(n, new Set(), (c) => {
    boundInside(c, out);
    return c;
  });
  return out;
}

function nodeCount(n: Node): number {
  let k = 1;
  mapChildren(n, new Set(), (c) => {
    k += nodeCount(c);
    return c;
  });
  return k;
}

const intersects = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
  [...a].some((s) => b.has(s));

/** Free references to each name in `n`. */
function referenceCounts(n: Node): Map<string, number> {
  const out = new Map<string, number>();
  const go = (m: Node, bound: ReadonlySet<string>) => {
    if (m.type === "Identifier") {
      if (!bound.has(m.symbol)) out.set(m.symbol, (out.get(m.symbol) ?? 0) + 1);
      return;
    }
    mapChildren(m, bound, (c, b) => {
      go(c, b);
      return c;
    });
  };
  go(n, new Set());
  return out;
}

/**
 * Write the graph's function calls in `root` out as their bodies, and the
 * per-pixel definitions it reads once as their right sides, as far as that
 * goes. Calls and definitions are left alone where writing them out would
 * capture a name, or put a `with` where one could end up inside another.
 * `inlined` names what was written out.
 */
export function inlineDefinitions<T extends Node>(
  root: T,
  defs: Definitions
): { root: T; inlined: string[] } {
  const inlined = new Set<string>();
  const safeBody = (body: Child, siteBound: ReadonlySet<string>) =>
    !containsWith(body) && !intersects(freeNames(body), siteBound);

  const calls = (
    n: Node,
    bound: ReadonlySet<string>,
    stack: string[]
  ): Node => {
    if (n.type === "FunctionCall" && !bound.has(n.callee.symbol)) {
      const name = n.callee.symbol;
      const f = defs.functions.get(name);
      const args = n.args.map((a) => calls(a, bound, stack) as Child);
      if (
        f &&
        stack.length < MAX_DEPTH &&
        !stack.includes(name) &&
        f.argSymbols.length === args.length
      ) {
        const params = new Set(f.argSymbols.map((p) => p.symbol));
        const body = f.definition;
        const free = freeNames(body, params);
        const argNames = new Set<string>();
        for (const a of args) freeNames(a, new Set(), argNames);
        if (
          !containsWith(body) &&
          !args.some(containsWith) &&
          !intersects(free, bound) &&
          !intersects(argNames, boundInside(body))
        ) {
          const map = new Map(
            f.argSymbols.map((p, i) => [p.symbol, args[i]] as const)
          );
          inlined.add(name);
          return calls(substitute(body, map, new Set()), bound, [
            ...stack,
            name,
          ]);
        }
      }
      return { ...n, args };
    }
    return mapChildren(n, bound, (c, b) => calls(c, b, stack) as Child);
  };

  let tree: Node = calls(root, new Set(), []);
  // Definitions read once, written out until there are none left.
  for (let round = 0; round < MAX_DEPTH; round++) {
    const counts = referenceCounts(tree);
    const once = new Set(
      [...counts]
        .filter(([s, k]) => k === 1 && defs.perPixel.has(s))
        .map(([s]) => s)
    );
    if (once.size === 0) break;
    let changed = false;
    const refs = (n: Node, bound: ReadonlySet<string>): Node => {
      if (n.type === "Identifier") {
        if (bound.has(n.symbol) || !once.has(n.symbol)) return n;
        const right = defs.perPixel.get(n.symbol)!;
        if (!safeBody(right, bound)) return n;
        inlined.add(n.symbol);
        changed = true;
        return right;
      }
      return mapChildren(n, bound, (c, b) => refs(c, b) as Child);
    };
    tree = calls(refs(tree, new Set()), new Set(), []);
    if (!changed) break;
  }
  if (inlined.size === 0 || nodeCount(tree) > MAX_NODES)
    return { root, inlined: [] };
  return { root: tree as T, inlined: [...inlined] };
}

export interface Hoisted {
  /** The new definition's expression id. */
  id: string;
  symbol: string;
  node: Child;
  /** Parameters, if this defines a function. */
  params?: string[];
  /** Part of a value folded out of a comprehension, not a repeat. */
  folded?: boolean;
}

/** Nodes that can be a definition's right side. */
function isValue(n: Child) {
  switch (n.type) {
    case "Identifier":
    case "Constant":
    case "Comparator":
    case "ComparatorChain":
    case "Or":
    case "Restriction":
    case "AssignmentExpression":
    case "UpdateRule":
      return false;
    case "Seq":
      return n.parenWrapped;
    default:
      return true;
  }
}

/**
 * Move each part of `root` that is the same for every pixel, isn't typed in,
 * and is written more than once, into a new definition named by `fresh`.
 * Parts inside a `with` are left alone.
 */
export function hoistRepeats<T extends Node>(
  root: T,
  names: Names,
  fresh: () => { id: string; symbol: string }
): { root: T; hoisted: Hoisted[] } {
  const counts = new Map<string, number>();
  const walk = (
    n: Node,
    bound: ReadonlySet<string>,
    f: (c: Child, key: string) => Child | undefined
  ): Node =>
    mapChildren(n, bound, (c, b) => {
      if (c.type === "Substitution") return c;
      if (isValue(c) && kindOf(c, names, b) === Kind.Hot) {
        const key = JSON.stringify(c);
        return f(c, key) ?? c;
      }
      return walk(c, b, f) as Child;
    });
  walk(root, new Set(), (_, key) => {
    counts.set(key, (counts.get(key) ?? 0) + 1);
    return undefined;
  });
  const hoisted = new Map<string, Hoisted>();
  const out = walk(root, new Set(), (c, key) => {
    if ((counts.get(key) ?? 0) < 2) return undefined;
    let h = hoisted.get(key);
    if (!h) hoisted.set(key, (h = { ...fresh(), node: c }));
    return { type: "Identifier", symbol: h.symbol };
  });
  return { root: out as T, hoisted: [...hoisted.values()] };
}
