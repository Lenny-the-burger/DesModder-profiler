/**
 * Rewrites that take apart points and small lists, which Desmos's cost
 * estimate charges for. Measured on its compiler:
 *
 * - Building a point costs 5 and reading `.x` from one costs 5, except when
 *   the point is written out as `(a,b,c)`: then `.x` is just `a`, for free.
 *   A piecewise of points is not written out, so `p.x` of `p = {c: (…), q}`
 *   costs 5 each time. `splitPoints` makes it a point of piecewises,
 *   `({c: …, q.x}, {c: …, q.y}, …)`. The condition is then written once per
 *   coordinate, and Desmos doesn't merge repeated parts, so only cheap
 *   conditions are split. A raymarcher stepping a point 23 times: 26.0k →
 *   18.6k.
 *
 * - Reading `L[n]` costs 5, `total`, `mean`, `min` and `max` of a list cost 5
 *   per element, and the elements of a point list cost 5 more per coordinate.
 *   With a list that doesn't change and a small, fixed loop over it, writing
 *   the loop out turns each `L[k]` into a number the CPU works out.
 *   `unrollLists` writes out sums and products with fixed bounds, and
 *   `total`, `mean`, `min` and `max` of a written-out list, a comprehension
 *   over `[1...N]` or a list broadcast element by element. A scene's ambient
 *   occlusion over helper lists of 4–8 boxes: 2218 → 992.
 *
 * Both are kept only where measuring shows less cost.
 */
import type { Aug } from "../../../text-mode-core";
import { containsWith } from "./hot";
import { freeNames } from "./inline";
import { Value, mapChildren, substitute } from "./rewrite";

type Node = Aug.Latex.AnyRootOrChild;
type Child = Aug.Latex.AnyChild;

/** Most elements a loop or list is written out to. */
export const MAX_UNROLL = 32;
/** Written-out trees bigger than this, in nodes, are left as they were. */
const MAX_NODES = 20000;
/** Conditions bigger than this, in nodes, aren't written once per coordinate. */
const MAX_SPLIT_CONDITION = 16;

export interface UnpackContext {
  /** Values of the names the CPU computes. */
  values: ReadonlyMap<string, Value>;
  /** Names whose values don't change. */
  fixed: ReadonlySet<string>;
  /** Right sides of the graph's variable definitions, by name. */
  variables: ReadonlyMap<string, Child>;
  /** The graph's functions, by name. */
  functions: ReadonlyMap<string, Aug.Latex.FunctionDefinition>;
}

const COORDS = ["x", "y", "z"] as const;
/** Names a shader reads per pixel without a definition. */
const PIXEL = new Set(["x", "y", "z", "u", "v"]);

/** Built-in functions that work on each element of a list on their own. */
export const ELEMENTWISE = new Set([
  "sin",
  "cos",
  "tan",
  "csc",
  "sec",
  "cot",
  "arcsin",
  "arccos",
  "arctan",
  "arccsc",
  "arcsec",
  "arccot",
  "sinh",
  "cosh",
  "tanh",
  "csch",
  "sech",
  "coth",
  "arcsinh",
  "arccosh",
  "arctanh",
  "arccsch",
  "arcsech",
  "arccoth",
  "exp",
  "ln",
  "log",
  "sqrt",
  "abs",
  "sign",
  "floor",
  "ceil",
  "round",
  "mod",
  "hypot",
  "distance",
  "erf",
]);

/** Reductions of one list that unrolling writes out. */
const REDUCTIONS = new Set(["total", "mean", "min", "max"]);
/**
 * With more than one argument these go element by element:
 * `\max([1,5],[3,2])` is `[3,5]`.
 */
const MIN_MAX = new Set(["min", "max"]);

const constant = (value: number): Aug.Latex.Constant => ({
  type: "Constant",
  value,
});
const identifier = (symbol: string): Aug.Latex.Identifier => ({
  type: "Identifier",
  symbol,
});
const binary = (
  name: Aug.Latex.BinaryOperator["name"],
  left: Child,
  right: Child
): Child => ({ type: "BinaryOperator", name, left, right });

function nodeCount(n: Node): number {
  let k = 1;
  mapChildren(n, new Set(), (c) => {
    k += nodeCount(c);
    return c;
  });
  return k;
}

/** Whether `n` reads any of `names` freely. */
function mentions(
  n: Node,
  names: ReadonlySet<string>,
  bound: ReadonlySet<string> = new Set()
): boolean {
  if (n.type === "Identifier")
    return names.has(n.symbol) && !bound.has(n.symbol);
  let found = false;
  mapChildren(n, bound, (c, b) => {
    if (!found && mentions(c, names, b)) found = true;
    return c;
  });
  return found;
}

/** Whether `n` holds a node of one of `types`. */
function holds(n: Node, types: ReadonlySet<string>): boolean {
  if (types.has(n.type)) return true;
  let found = false;
  mapChildren(n, new Set(), (c) => {
    if (!found && holds(c, types)) found = true;
    return c;
  });
  return found;
}

class Unpacker {
  private readonly scalarNames = new Map<string, boolean>();
  private readonly scalarFns = new Map<string, boolean>();
  private readonly readers = new Map<string, Set<string>>();
  private readonly shapes = new Map<string, boolean>();

  constructor(private readonly ctx: UnpackContext) {}

  /** Number of elements of a list whose length doesn't change. */
  listLength(symbol: string): number | undefined {
    if (!this.ctx.fixed.has(symbol) && !this.fixedShape(symbol, 0))
      return undefined;
    const v = this.ctx.values.get(symbol);
    if (v?.type === "list") return v.value.length;
    if (v?.type === "points") return v.value[0]?.length ?? 0;
    return undefined;
  }

  /**
   * Whether the list `symbol` keeps its length when its values change: it is
   * written out element by element, and anything changing in it is a number
   * or point, not something that sets a length.
   */
  private fixedShape(symbol: string, depth: number): boolean {
    const known = this.shapes.get(symbol);
    if (known !== undefined) return known;
    const def = this.ctx.variables.get(symbol);
    if (!def || depth > 8) return false;
    this.shapes.set(symbol, false);
    const ok = (n: Child): boolean => {
      switch (n.type) {
        case "Constant":
          return true;
        case "Identifier": {
          if (this.ctx.fixed.has(n.symbol)) return true;
          const v = this.ctx.values.get(n.symbol);
          if (v?.type === "number" || v?.type === "point") return true;
          return this.fixedShape(n.symbol, depth + 1);
        }
        case "List":
        case "ComparatorChain":
          return n.args.every(ok);
        case "Seq":
          return n.parenWrapped && n.args.every(ok);
        case "BinaryOperator":
        case "Comparator":
          return ok(n.left) && ok(n.right);
        case "Negative":
        case "Norm":
          return ok(n.arg);
        case "OrderedPairAccess":
          return ok(n.point);
        case "Piecewise":
          return (
            (n.condition === true || ok(n.condition)) &&
            ok(n.consequent) &&
            ok(n.alternate)
          );
        case "FunctionCall":
          return (
            (ELEMENTWISE.has(n.callee.symbol) ||
              (MIN_MAX.has(n.callee.symbol) && n.args.length > 1)) &&
            n.args.every(ok)
          );
        default:
          return false;
      }
    };
    const out = ok(def);
    this.shapes.set(symbol, out);
    return out;
  }

  /**
   * The value of `n`, if it is a number that doesn't change, like a slider
   * that stays put or the length of a list written out element by element.
   */
  numberOf(n: Child, depth = 0): number | undefined {
    if (depth > 8) return undefined;
    switch (n.type) {
      case "Constant":
        return n.value;
      case "Identifier": {
        const v = this.ctx.values.get(n.symbol);
        if (v?.type !== "number") return undefined;
        if (this.ctx.fixed.has(n.symbol)) return v.value;
        const def = this.ctx.variables.get(n.symbol);
        return def && this.numberOf(def, depth + 1) === v.value
          ? v.value
          : undefined;
      }
      case "Negative": {
        const a = this.numberOf(n.arg, depth);
        return a === undefined ? undefined : -a;
      }
      case "BinaryOperator": {
        const l = this.numberOf(n.left, depth);
        const r = this.numberOf(n.right, depth);
        if (l === undefined || r === undefined) return undefined;
        if (n.name === "Add") return l + r;
        if (n.name === "Subtract") return l - r;
        if (n.name === "Multiply") return l * r;
        return undefined;
      }
      case "DotAccess":
        if (
          n.object.type === "Identifier" &&
          n.property.type === "Identifier" &&
          n.property.symbol === "count"
        )
          return this.listLength(n.object.symbol);
        return undefined;
      case "FunctionCall":
        if (
          n.callee.symbol === "length" &&
          n.args.length === 1 &&
          n.args[0].type === "Identifier"
        )
          return this.listLength(n.args[0].symbol);
        return undefined;
      default:
        return undefined;
    }
  }

  /** Every name the definitions and functions `n` reads read, through others. */
  private readsThrough(n: Node, symbol: string): boolean {
    const start = freeNames(n);
    start.delete(symbol);
    for (const name of start) {
      let r = this.readers.get(name);
      if (!r) {
        r = new Set();
        const stack = [name];
        while (stack.length) {
          const s = stack.pop()!;
          const v = this.ctx.variables.get(s);
          const f = this.ctx.functions.get(s);
          const body = v ?? f?.definition;
          if (!body) continue;
          const bound = new Set(f?.argSymbols.map((a) => a.symbol) ?? []);
          for (const d of freeNames(body, bound))
            if (!r.has(d)) {
              r.add(d);
              stack.push(d);
            }
        }
        this.readers.set(name, r);
      }
      if (r.has(symbol)) return true;
    }
    return false;
  }

  /**
   * `body` with `index` set to `k`. Definitions it reads that read `index`
   * see it through a `with`, which can't go inside another `with`.
   */
  private instance(
    body: Child,
    index: string,
    k: number,
    insideWith: boolean
  ): Child | undefined {
    const direct = substitute(body, new Map([[index, constant(k)]]), new Set());
    if (!this.readsThrough(body, index)) return direct;
    if (insideWith || containsWith(body)) return undefined;
    return {
      type: "Substitution",
      body: direct,
      assignments: [
        {
          type: "AssignmentExpression",
          variable: identifier(index),
          expression: constant(k),
        },
      ],
    };
  }

  /**
   * Whether `symbol` is a single number or point, not a list. `bound` are
   * single values in scope, like the parameters of the function being read:
   * definitions see those too.
   */
  private scalarName(symbol: string, bound: ReadonlySet<string>): boolean {
    if (bound.has(symbol)) return true;
    const v = this.ctx.values.get(symbol);
    if (v) return v.type === "number" || v.type === "point";
    const def = this.ctx.variables.get(symbol);
    if (!def) return PIXEL.has(symbol);
    const key = [symbol, ...[...bound].sort()].join("\u0000");
    const known = this.scalarNames.get(key);
    if (known !== undefined) return known;
    this.scalarNames.set(key, false);
    const out = this.scalar(def, bound);
    this.scalarNames.set(key, out);
    return out;
  }

  /** Whether `n` is a single number or point, never a list. */
  scalar(n: Child, bound: ReadonlySet<string>): boolean {
    const all = (cs: Child[], b = bound) => cs.every((c) => this.scalar(c, b));
    switch (n.type) {
      case "Constant":
        return true;
      case "Identifier":
        return this.scalarName(n.symbol, bound);
      case "FunctionCall": {
        const name = n.callee.symbol;
        if (bound.has(name)) return false;
        if (REDUCTIONS.has(name) && n.args.length === 1) return true;
        if (ELEMENTWISE.has(name) || MIN_MAX.has(name)) return all(n.args);
        const f = this.ctx.functions.get(name);
        if (!f || f.argSymbols.length !== n.args.length) return false;
        if (!all(n.args)) return false;
        const params = f.argSymbols.map((a) => a.symbol);
        const key = [name, ...[...bound].sort()].join("\u0000");
        let known = this.scalarFns.get(key);
        if (known === undefined) {
          this.scalarFns.set(key, false);
          known = this.scalar(f.definition, new Set([...bound, ...params]));
          this.scalarFns.set(key, known);
        }
        return known;
      }
      case "ListAccess":
        return this.scalar(n.index, bound);
      case "DotAccess":
        return (
          n.property.type === "Identifier" && n.property.symbol === "count"
        );
      case "Substitution":
        return (
          n.assignments.every((a) => this.scalar(a.expression, bound)) &&
          this.scalar(
            n.body,
            new Set([...bound, ...n.assignments.map((a) => a.variable.symbol)])
          )
        );
      case "RepeatedOperator":
        return this.scalar(n.expression, new Set([...bound, n.index.symbol]));
      case "Seq":
        return n.parenWrapped && all(n.args);
      case "BinaryOperator":
        return all([n.left, n.right]);
      case "Negative":
      case "Norm":
        return this.scalar(n.arg, bound);
      case "OrderedPairAccess":
        return this.scalar(n.point, bound);
      case "Piecewise":
        return (
          (n.condition === true || this.scalar(n.condition, bound)) &&
          all([n.consequent, n.alternate])
        );
      case "Comparator":
        return all([n.left, n.right]);
      case "ComparatorChain":
        return all(n.args);
      default:
        return false;
    }
  }

  /** Whether `n` reads one of `lists`, or reads a definition that does. */
  private reaches(
    n: Child,
    lists: ReadonlySet<string>,
    bound: ReadonlySet<string>,
    viaDefinitions: boolean
  ): boolean {
    if (mentions(n, lists, bound)) return true;
    if (!viaDefinitions) return false;
    return [...lists].some((l) => !bound.has(l) && this.readsThrough(n, l));
  }

  /**
   * Whether `n`, reading the lists `lists`, works on each element on its own,
   * so that its `k`th element is `n` with each list `L` read as `L[k]`.
   *
   * At the top, the lists are the graph's, and a definition reading one
   * wouldn't see `L[k]`, so that isn't element by element. In a function's
   * body, the list is a parameter: definitions the body reads see the
   * argument too (`f(p)=q.x` with `q=2p` gives `2p.x`), and so are followed.
   */
  elementwise(
    n: Child,
    lists: ReadonlySet<string>,
    bound: ReadonlySet<string>,
    depth = 0,
    viaDefinitions = false
  ): boolean {
    if (!this.reaches(n, lists, bound, viaDefinitions))
      return this.scalar(n, bound);
    if (depth > 8) return false;
    const each = (cs: Child[]) =>
      cs.every((c) => this.elementwise(c, lists, bound, depth, viaDefinitions));
    switch (n.type) {
      case "Identifier": {
        if (lists.has(n.symbol) && !bound.has(n.symbol)) return true;
        const def = this.ctx.variables.get(n.symbol);
        return (
          viaDefinitions &&
          !!def &&
          this.elementwise(def, lists, bound, depth + 1, true)
        );
      }
      case "BinaryOperator":
        return each([n.left, n.right]);
      case "Negative":
      case "Norm":
        return each([n.arg]);
      case "Seq":
        return n.parenWrapped && each(n.args);
      case "OrderedPairAccess":
        return each([n.point]);
      case "Piecewise":
        return (
          (n.condition === true || each([n.condition])) &&
          each([n.consequent, n.alternate])
        );
      case "Comparator":
        return each([n.left, n.right]);
      case "ComparatorChain":
        return each(n.args);
      case "FunctionCall": {
        const name = n.callee.symbol;
        if (bound.has(name)) return false;
        if (ELEMENTWISE.has(name)) return each(n.args);
        if (MIN_MAX.has(name)) return n.args.length > 1 && each(n.args);
        const f = this.ctx.functions.get(name);
        if (!f || f.argSymbols.length !== n.args.length) return false;
        const params = f.argSymbols.map((a) => a.symbol);
        return n.args.every((arg, i) => {
          if (!this.reaches(arg, lists, bound, viaDefinitions))
            return this.scalar(arg, bound);
          if (!this.elementwise(arg, lists, bound, depth, viaDefinitions))
            return false;
          // In the body this parameter is the list; the others, and what is
          // in scope here, are single values.
          const inner = new Set([params[i], ...(viaDefinitions ? lists : [])]);
          const others = new Set(
            [...bound, ...params].filter((p) => p !== params[i])
          );
          return this.elementwise(f.definition, inner, others, depth + 1, true);
        });
      }
      default:
        return false;
    }
  }

  /** The elements of the list `n`, if it is short and can be written out. */
  private elementsOf(n: Child, insideWith: boolean): Child[] | undefined {
    if (n.type === "List") {
      if (n.args.length === 0 || n.args.length > MAX_UNROLL) return undefined;
      return n.args.every((a) => this.scalar(a, new Set()))
        ? n.args
        : undefined;
    }
    if (n.type === "ListComprehension") {
      if (n.assignments.length !== 1 || n.parameters.length !== 0)
        return undefined;
      const [a] = n.assignments;
      const r = a.expression;
      if (r.type !== "Range" || r.start.length !== 1 || r.end.length !== 1)
        return undefined;
      const s = this.numberOf(r.start[0]);
      const e = this.numberOf(r.end[0]);
      if (s === undefined || e === undefined) return undefined;
      if (!Number.isInteger(s) || !Number.isInteger(e)) return undefined;
      const count = e - s + 1;
      if (count < 1 || count > MAX_UNROLL) return undefined;
      const index = a.variable.symbol;
      if (!this.scalar(n.expr, new Set([index]))) return undefined;
      const out: Child[] = [];
      for (let k = s; k <= e; k++) {
        const inst = this.instance(n.expr, index, k, insideWith);
        if (!inst) return undefined;
        out.push(inst);
      }
      return out;
    }
    // A list broadcast: the lists it reads, read one element at a time.
    const lists = new Set<string>();
    let count = Infinity;
    for (const s of freeNames(n)) {
      const len = this.listLength(s);
      if (len === undefined) continue;
      lists.add(s);
      count = Math.min(count, len);
    }
    if (lists.size === 0 || count < 1 || count > MAX_UNROLL) return undefined;
    if (!this.elementwise(n, lists, new Set())) return undefined;
    const out: Child[] = [];
    for (let k = 1; k <= count; k++) {
      const at = new Map<string, Child>();
      for (const s of lists)
        at.set(s, {
          type: "ListAccess",
          list: identifier(s),
          index: constant(k),
        });
      out.push(substitute(n, at, new Set()) as Child);
    }
    return out;
  }

  /** `n` with loops and reductions over short lists written out. */
  unroll(n: Child, insideWith: boolean): { node: Child; count: number } {
    let count = 0;
    const inner = n.type === "Substitution" || insideWith;
    const node = mapChildren(n, new Set(), (c) => {
      const r = this.unroll(c, inner);
      count += r.count;
      return r.node;
    });
    if (node.type === "RepeatedOperator") {
      const s = this.numberOf(node.start);
      const e = this.numberOf(node.end);
      if (
        s !== undefined &&
        e !== undefined &&
        Number.isInteger(s) &&
        Number.isInteger(e) &&
        e - s + 1 >= 1 &&
        e - s + 1 <= MAX_UNROLL
      ) {
        const terms: Child[] = [];
        for (let k = s; k <= e; k++) {
          const t = this.instance(node.expression, node.index.symbol, k, inner);
          if (!t) break;
          terms.push(t);
        }
        if (terms.length === e - s + 1) {
          const op = node.name === "Sum" ? "Add" : "Multiply";
          const out = terms.reduce((acc, t) => binary(op, acc, t));
          if (nodeCount(out) <= MAX_NODES)
            return { node: out, count: count + 1 };
        }
      }
    }
    if (
      node.type === "FunctionCall" &&
      REDUCTIONS.has(node.callee.symbol) &&
      node.args.length === 1
    ) {
      const els = this.elementsOf(node.args[0], inner);
      if (els && els.reduce((k, e) => k + nodeCount(e), 0) <= MAX_NODES) {
        const name = node.callee.symbol;
        const sum = () => els.reduce((acc, e) => binary("Add", acc, e));
        const out: Child =
          name === "total"
            ? sum()
            : name === "mean"
              ? binary("Divide", sum(), constant(els.length))
              : els.length === 1
                ? els[0]
                : { ...node, args: els };
        return { node: out, count: count + 1 };
      }
    }
    return { node, count };
  }
}

/** The branches a chain of piecewises ends in. */
function leavesOf(p: Aug.Latex.Piecewise): Child[] {
  const out = [p.consequent];
  if (p.alternate.type === "Piecewise") out.push(...leavesOf(p.alternate));
  else out.push(p.alternate);
  return out;
}

/** Number of coordinates of the points a piecewise picks between, if known. */
function pointArity(p: Aug.Latex.Piecewise): number | undefined {
  let arity: number | undefined;
  for (const l of leavesOf(p)) {
    if (l.type === "Seq" && l.parenWrapped) {
      if (l.args.length !== 2 && l.args.length !== 3) return undefined;
      if (arity !== undefined && arity !== l.args.length) return undefined;
      arity = l.args.length;
    } else if (
      l.type !== "Identifier" &&
      !(l.type === "Constant" && Number.isNaN(l.value))
    )
      return undefined;
  }
  return arity;
}

/** Coordinate `i` of a branch: a written-out point's, or `.x` of a name. */
function coordinate(l: Child, i: number): Child {
  if (l.type === "Seq") return l.args[i];
  if (l.type === "Identifier")
    return {
      type: "OrderedPairAccess",
      point: l,
      index: COORDS[i] as "x",
    };
  return l;
}

/** Coordinate `i` of what the piecewise chain `p` picks. */
function pick(p: Aug.Latex.Piecewise, i: number): Child {
  return {
    ...p,
    consequent: coordinate(p.consequent, i),
    alternate:
      p.alternate.type === "Piecewise"
        ? pick(p.alternate, i)
        : coordinate(p.alternate, i),
  };
}

/** The conditions of a piecewise chain. */
function conditionsOf(p: Aug.Latex.Piecewise): Child[] {
  const out: Child[] = p.condition === true ? [] : [p.condition];
  if (p.alternate.type === "Piecewise") out.push(...conditionsOf(p.alternate));
  return out;
}

/**
 * `root` with piecewises of points made points of piecewises, where their
 * conditions are cheap to write once per coordinate.
 */
export function splitPoints<T extends Node>(
  root: T
): { root: T; count: number } {
  let count = 0;
  const visit = (n: Node): Node => {
    const node = mapChildren(n, new Set(), (c) => visit(c) as Child);
    if (node.type !== "Piecewise") return node;
    const arity = pointArity(node);
    if (arity === undefined) return node;
    const conds = conditionsOf(node);
    if (
      conds.some(
        (c) =>
          nodeCount(c) > MAX_SPLIT_CONDITION ||
          holds(c, new Set(["FunctionCall", "RepeatedOperator"]))
      )
    )
      return node;
    count++;
    return {
      type: "Seq",
      parenWrapped: true,
      args: Array.from({ length: arity }, (_, i) => pick(node, i)),
    };
  };
  return { root: visit(root) as T, count };
}

/**
 * `root` with sums and products over fixed bounds, and `total`, `mean`,
 * `min` and `max` of short lists, written out.
 */
export function unrollLists<T extends Node>(
  root: T,
  ctx: UnpackContext
): { root: T; count: number } {
  const u = new Unpacker(ctx);
  let count = 0;
  const out = mapChildren(root, new Set(), (c) => {
    const r = u.unroll(c, root.type === "Substitution");
    count += r.count;
    return r.node;
  });
  return { root: out, count };
}

/**
 * `root` with each element `L[i]` of a list of points, at an index that isn't
 * a number written out, read as `(L_x[i],L_y[i],L_z[i])` from lists of its
 * coordinates. Reading `.x` of that is free, where `L[i].x` costs 5 more
 * than `L_x[i]`, and coordinates not read cost nothing. `coordinates(L, c)`
 * names the list of coordinate `c` of `L`.
 */
export function splitPointLists<T extends Node>(
  root: T,
  values: ReadonlyMap<string, Value>,
  coordinates: (list: string, coordinate: "x" | "y" | "z") => string
): { root: T; count: number } {
  let count = 0;
  const visit = (n: Node, bound: ReadonlySet<string>): Node => {
    const node = mapChildren(n, bound, (c, b) => visit(c, b) as Child);
    if (
      node.type !== "ListAccess" ||
      node.list.type !== "Identifier" ||
      bound.has(node.list.symbol) ||
      node.index.type === "Constant"
    )
      return node;
    const v = values.get(node.list.symbol);
    if (v?.type !== "points" || (v.value.length !== 2 && v.value.length !== 3))
      return node;
    const list = node.list.symbol;
    count++;
    return {
      type: "Seq",
      parenWrapped: true,
      args: COORDS.slice(0, v.value.length).map(
        (c): Child => ({
          type: "ListAccess",
          list: identifier(coordinates(list, c)),
          index: node.index,
        })
      ),
    };
  };
  return { root: visit(root, new Set()) as T, count };
}
