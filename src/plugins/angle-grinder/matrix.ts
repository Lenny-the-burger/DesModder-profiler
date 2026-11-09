/**
 * Working out matrix math in shaders number by number.
 *
 * A matrix with a list in a cell is a list of matrices, and everything
 * computed from it broadcasts. Desmos's cost estimate is hard on that, as
 * measured on a shadow test over 80 triangles (97155 to 9461):
 *
 * - Multiplying and indexing matrices charge for every cell, including the
 *   ones nothing reads.
 * - A broadcast doesn't share anything between uses, so each use of a value
 *   derived from a list reads the list again (56 reads per triangle where 12
 *   are enough).
 * - A value that doesn't depend on the list, like a direction to a light, is
 *   computed again for every element.
 *
 * So the math is expanded by hand into numbers, with only the cells that are
 * read. The cells the CPU can compute become lists of their own, read once
 * per element in a `for`. Values used more than once are passed as function
 * arguments, which Desmos computes once, and values that don't depend on the
 * element are passed into the function holding the loop:
 *
 *     G_h(q, X) = total([G_1(A[n], q, X) for n=[1...A.count]])
 *
 * The loop runs to `.count` rather than a typed-in length, which takes one
 * more uniform slot per element, so the result stays right if a list changes
 * length.
 *
 * Only what this file understands is rewritten; anything else leaves the
 * shader as it was.
 */
import type { Aug } from "../../../text-mode-core";
import { PIXEL_NAMES } from "./hot";
import type { Hoisted } from "./inline";
import { Value, mapChildren } from "./rewrite";
import { ELEMENTWISE } from "./unpack";

type Node = Aug.Latex.AnyRootOrChild;
type Child = Aug.Latex.AnyChild;

/** Longest list a shader takes. */
const MAX_SHADER_LIST = 100;

/** Reductions of one list that become a loop. */
const REDUCERS = new Set(["total", "mean", "min", "max"]);
/** Functions of numbers giving a color, which work element by element too. */
const COLORS = new Set(["hsv", "rgb"]);

export interface MatrixDefinitions {
  /** Right sides of the graph's variable definitions, by name. */
  variables: ReadonlyMap<string, Child>;
  /** The graph's functions, by name. */
  functions: ReadonlyMap<string, Aug.Latex.FunctionDefinition>;
}

export interface MatrixContext extends MatrixDefinitions {
  /** Values of the names the CPU computes. */
  values: ReadonlyMap<string, Value>;
  /** How many matrices each name the CPU computes holds. */
  lengths: ReadonlyMap<string, number>;
}

export type Fresh = () => { id: string; symbol: string };

const id = (symbol: string): Aug.Latex.Identifier => ({
  type: "Identifier",
  symbol,
});
const num = (value: number): Aug.Latex.Constant => ({
  type: "Constant",
  value,
});
const call = (symbol: string, args: Child[]): Child => ({
  type: "FunctionCall",
  callee: id(symbol),
  args,
});
const isNum = (n: Child, v: number) => n.type === "Constant" && n.value === v;

const bin = (
  name: Aug.Latex.BinaryOperator["name"],
  left: Child,
  right: Child
): Child => ({ type: "BinaryOperator", name, left, right });
const neg = (a: Child): Child =>
  isNum(a, 0) ? a : { type: "Negative", arg: a };
const add = (a: Child, b: Child) =>
  isNum(a, 0) ? b : isNum(b, 0) ? a : bin("Add", a, b);
const sub = (a: Child, b: Child) =>
  isNum(b, 0) ? a : isNum(a, 0) ? neg(b) : bin("Subtract", a, b);
const mul = (a: Child, b: Child) =>
  isNum(a, 0) || isNum(b, 0)
    ? num(0)
    : isNum(a, 1)
      ? b
      : isNum(b, 1)
        ? a
        : bin("Multiply", a, b);

/** The children of a node. */
function childrenOf(n: Node) {
  const out: Child[] = [];
  mapChildren(n, new Set(), (c) => {
    out.push(c);
    return c;
  });
  return out;
}

/** Whether `n` holds a matrix or reads a cell of one. */
export function usesMatrix(n: Node | undefined): boolean {
  if (!n) return false;
  if (n.type === "Matrix" || n.type === "MatrixAccess") return true;
  return childrenOf(n).some(usesMatrix);
}

/** Names `n` reads that a binding inside it doesn't cover. */
function readsIn(
  n: Node,
  out: Set<string>,
  bound: ReadonlySet<string> = new Set()
) {
  if (n.type === "Identifier" && !bound.has(n.symbol)) out.add(n.symbol);
  if (n.type === "FunctionCall" && !bound.has(n.callee.symbol))
    out.add(n.callee.symbol);
  mapChildren(n, bound, (c, b) => {
    readsIn(c, out, b);
    return c;
  });
}

/** Everything `symbol` reads, through the graph's definitions. */
function closureOf(defs: MatrixDefinitions, symbol: string) {
  const out = new Set<string>();
  const stack = [symbol];
  while (stack.length > 0) {
    const s = stack.pop()!;
    const right = defs.variables.get(s);
    const f = defs.functions.get(s);
    const reads = new Set<string>();
    if (right) readsIn(right, reads);
    if (f)
      readsIn(f.definition, reads, new Set(f.argSymbols.map((a) => a.symbol)));
    for (const r of reads)
      if (!out.has(r)) {
        out.add(r);
        stack.push(r);
      }
  }
  return out;
}

const isCoordinate = (defs: MatrixDefinitions, s: string) =>
  PIXEL_NAMES.has(s) && !defs.variables.has(s) && !defs.functions.has(s);

function readsPixel(defs: MatrixDefinitions, symbol: string) {
  return [...closureOf(defs, symbol)].some((s) => isCoordinate(defs, s));
}

/** Rows and columns of a matrix-valued expression, if it can be told. */
function matrixShape(
  n: Child,
  vars: ReadonlyMap<string, Child>,
  depth = 0
): [number, number] | undefined {
  if (depth > 32) return undefined;
  const of = (m: Child) => matrixShape(m, vars, depth + 1);
  switch (n.type) {
    case "Matrix":
      // A matrix in a cell makes a block matrix, of some other shape.
      if (n.rows.some((r) => r.some((c) => of(c) !== undefined)))
        return undefined;
      return [n.rows.length, n.rows[0]?.length ?? 0];
    case "Identifier": {
      const right = vars.get(n.symbol);
      return right && of(right);
    }
    case "Negative":
      return of(n.arg);
    case "BinaryOperator": {
      const l = of(n.left);
      const r = of(n.right);
      switch (n.name) {
        case "Add":
        case "Subtract":
          return l ?? r;
        case "Multiply":
          return l && r ? [l[0], r[1]] : (l ?? r);
        case "Divide":
        case "Exponent":
          return l;
        default:
          return undefined;
      }
    }
    default:
      return undefined;
  }
}

/** Names of the matrices that don't depend on the pixel. */
export function matrixNames(defs: MatrixDefinitions) {
  return [...defs.variables]
    .filter(
      ([s, right]) => matrixShape(right, defs.variables) && !readsPixel(defs, s)
    )
    .map(([s]) => s);
}

/** A value, taken apart. */
type Sym =
  | { k: "number"; v: Child }
  | { k: "point"; c: Child[] }
  | { k: "matrix"; rows: Child[][] };

const number = (v: Child): Sym => ({ k: "number", v });
const point = (c: Child[]): Sym => ({ k: "point", c });

class Unsupported extends Error {}
const no = (): never => {
  throw new Unsupported();
};

type Env = ReadonlyMap<string, Sym>;
const NO_ENV: Env = new Map();

type Kind = "var" | "inline" | "op";
type KindOf = (n: Child) => Kind;

class Scalarizer {
  readonly added: Hoisted[] = [];
  private readonly memo = new Map<string, Sym | "busy">();
  private readonly coords = new Map<string, Child>();
  /** Reads of an element of a list, one node per list. */
  private readonly reads = new Map<string, Child>();
  private readonly listOfRead = new Map<Child, string>();
  /** Definitions of the lists read, added when a loop reads them. */
  private readonly lists = new Map<string, Hoisted>();
  private readonly flagsOf = new WeakMap<
    Child,
    { element: boolean; pixel: boolean }
  >();

  private readonly params: string[] = [];
  private readonly loopVar: string;
  private length: number | undefined;

  constructor(
    private readonly ctx: MatrixContext,
    private readonly fresh: Fresh
  ) {
    this.loopVar = fresh().symbol;
  }

  private param(i: number) {
    while (this.params.length <= i) this.params.push(this.fresh().symbol);
    return this.params[i];
  }

  private coordinate(s: string) {
    let c = this.coords.get(s);
    if (!c) this.coords.set(s, (c = id(s)));
    return c;
  }

  /** Reading an element of a list, which is `hoist` if that is given. */
  private element(key: string, length: number, hoist?: Child) {
    if (length > MAX_SHADER_LIST) no();
    if (this.length !== undefined && this.length !== length) no();
    this.length = length;
    let read = this.reads.get(key);
    if (!read) {
      let symbol = key;
      if (hoist) {
        const f = this.fresh();
        ({ symbol } = f);
        this.lists.set(symbol, { ...f, node: hoist, folded: true });
      }
      read = {
        type: "ListAccess",
        list: id(symbol),
        index: id(this.loopVar),
      };
      this.reads.set(key, read);
      this.listOfRead.set(read, symbol);
    }
    return read;
  }

  /** What depends on the list element, and on the pixel. */
  private flags(n: Child) {
    let f = this.flagsOf.get(n);
    if (f) return f;
    f = { element: this.listOfRead.has(n), pixel: false };
    if ([...this.coords.values()].includes(n)) f.pixel = true;
    for (const c of childrenOf(n)) {
      const g = this.flags(c);
      f.element ||= g.element;
      f.pixel ||= g.pixel;
    }
    this.flagsOf.set(n, f);
    return f;
  }

  /** The value of a name the CPU computes. */
  private cpu(s: string): Sym {
    const v = this.ctx.values.get(s);
    if (v?.type === "number") return number(id(s));
    if (v?.type === "point")
      return point(
        v.value.map((_, i) => ({
          type: "OrderedPairAccess",
          point: id(s),
          index: "xyz"[i] as "x",
        }))
      );
    if (v?.type === "list") return number(this.element(s, v.value.length));
    if (v?.type === "points")
      return point(
        v.value.map((list, i) => {
          const c = "xyz"[i] as "x";
          return this.element(`${s}.${c}`, list.length, {
            type: "OrderedPairAccess",
            point: id(s),
            index: c,
          });
        })
      );
    const right = this.ctx.variables.get(s);
    const shape = right && matrixShape(right, this.ctx.variables);
    const length = this.ctx.lengths.get(s);
    if (!shape || length === undefined || length === 0) return no();
    const rows: Child[][] = [];
    for (let r = 1; r <= shape[0]; r++) {
      const row: Child[] = [];
      for (let c = 1; c <= shape[1]; c++) {
        const cell: Child = {
          type: "MatrixAccess",
          matrix: id(s),
          row: num(r),
          column: num(c),
        };
        row.push(
          length === 1 ? cell : this.element(`${s};${r};${c}`, length, cell)
        );
      }
      rows.push(row);
    }
    return { k: "matrix", rows };
  }

  private name(s: string, env: Env): Sym {
    const bound = env.get(s);
    if (bound) return bound;
    if (isCoordinate(this.ctx, s)) return number(this.coordinate(s));
    const right = this.ctx.variables.get(s);
    if (!right) return no();
    // A definition reached from a function sees the function's parameters.
    if (env.size > 0)
      for (const r of closureOf(this.ctx, s)) if (env.has(r)) no();
    if (!readsPixel(this.ctx, s)) return this.cpu(s);
    const known = this.memo.get(s);
    if (known === "busy") return no();
    if (known) return known;
    this.memo.set(s, "busy");
    const out = this.eval(right, NO_ENV);
    this.memo.set(s, out);
    return out;
  }

  private scalar(n: Child, env: Env): Child {
    const v = this.eval(n, env);
    return v.k === "number" ? v.v : no();
  }

  private map(a: Sym, f: (c: Child) => Child): Sym {
    switch (a.k) {
      case "number":
        return number(f(a.v));
      case "point":
        return point(a.c.map(f));
      case "matrix":
        return { k: "matrix", rows: a.rows.map((r) => r.map(f)) };
    }
  }

  /** `f` of matching cells of two values of the same shape. */
  private zip(a: Sym, b: Sym, f: (x: Child, y: Child) => Child): Sym {
    if (a.k === "number" && b.k === "number") return number(f(a.v, b.v));
    if (a.k === "point" && b.k === "point" && a.c.length === b.c.length)
      return point(a.c.map((c, i) => f(c, b.c[i])));
    if (
      a.k === "matrix" &&
      b.k === "matrix" &&
      a.rows.length === b.rows.length &&
      a.rows[0].length === b.rows[0].length
    )
      return {
        k: "matrix",
        rows: a.rows.map((r, i) => r.map((c, j) => f(c, b.rows[i][j]))),
      };
    return no();
  }

  private multiply(a: Sym, b: Sym): Sym {
    if (a.k === "number") return this.map(b, (c) => mul(a.v, c));
    if (b.k === "number") return this.map(a, (c) => mul(c, b.v));
    if (a.k === "point" && b.k === "point") {
      if (a.c.length !== b.c.length) return no();
      return number(
        a.c.map((c, i) => mul(c, b.c[i])).reduce((x, y) => add(x, y))
      );
    }
    if (a.k === "matrix" && b.k === "matrix") {
      if (a.rows[0].length !== b.rows.length) return no();
      return {
        k: "matrix",
        rows: a.rows.map((row) =>
          b.rows[0].map((_, j) =>
            row.map((c, i) => mul(c, b.rows[i][j])).reduce((x, y) => add(x, y))
          )
        ),
      };
    }
    return no();
  }

  private cross(a: Sym, b: Sym): Sym {
    if (a.k !== "point" || b.k !== "point") return no();
    if (a.c.length !== 3 || b.c.length !== 3) return no();
    const [p, q] = [a.c, b.c];
    const at = (i: number, j: number) => sub(mul(p[i], q[j]), mul(p[j], q[i]));
    return point([at(1, 2), at(2, 0), at(0, 1)]);
  }

  private binary(n: Aug.Latex.BinaryOperator, env: Env): Sym {
    const l = this.eval(n.left, env);
    const r = this.eval(n.right, env);
    switch (n.name) {
      case "Add":
        return this.zip(l, r, add);
      case "Subtract":
        return this.zip(l, r, sub);
      case "Multiply":
        return this.multiply(l, r);
      case "CrossMultiply":
        return this.cross(l, r);
      case "Divide":
        if (r.k !== "number") return no();
        return this.map(l, (c) => bin("Divide", c, r.v));
      case "Exponent":
        if (l.k !== "number" || r.k !== "number") return no();
        return number(bin("Exponent", l.v, r.v));
    }
  }

  private functionCall(n: Aug.Latex.FunctionCall, env: Env): Sym {
    const s = n.callee.symbol;
    if (!env.has(s)) {
      const f = this.ctx.functions.get(s);
      if (f) {
        if (f.argSymbols.length !== n.args.length) return no();
        const inner = new Map<string, Sym>();
        f.argSymbols.forEach((p, i) =>
          inner.set(p.symbol, this.eval(n.args[i], env))
        );
        return this.eval(f.definition, inner);
      }
      if (this.ctx.variables.has(s)) return no();
      if (REDUCERS.has(s) && n.args.length === 1) {
        const body = this.scalar(n.args[0], env);
        return this.flags(body).element ? number(this.loop(s, body)) : no();
      }
      if (ELEMENTWISE.has(s) || COLORS.has(s) || REDUCERS.has(s))
        return number(
          call(
            s,
            n.args.map((a) => this.scalar(a, env))
          )
        );
    }
    return no();
  }

  private condition(n: Child, env: Env): Child {
    if (n.type !== "Comparator") return no();
    return {
      ...n,
      left: this.scalar(n.left, env),
      right: this.scalar(n.right, env),
    };
  }

  private eval(n: Child, env: Env): Sym {
    switch (n.type) {
      case "Constant":
        return number(n);
      case "Identifier":
        return this.name(n.symbol, env);
      case "Negative":
        return this.map(this.eval(n.arg, env), neg);
      case "BinaryOperator":
        return this.binary(n, env);
      case "FunctionCall":
        return this.functionCall(n, env);
      case "Seq": {
        if (!n.parenWrapped || (n.args.length !== 2 && n.args.length !== 3))
          return no();
        return point(n.args.map((a) => this.scalar(a, env)));
      }
      case "Matrix":
        return {
          k: "matrix",
          rows: n.rows.map((r) => r.map((c) => this.scalar(c, env))),
        };
      case "MatrixAccess": {
        const m = this.eval(n.matrix, env);
        if (m.k !== "matrix") return no();
        if (n.row.type !== "Constant" || n.column.type !== "Constant")
          return no();
        return number(m.rows[n.row.value - 1]?.[n.column.value - 1] ?? no());
      }
      case "OrderedPairAccess": {
        const p = this.eval(n.point, env);
        if (p.k !== "point") return no();
        return number(p.c["xyz".indexOf(n.index)] ?? no());
      }
      case "Norm": {
        const a = this.eval(n.arg, env);
        if (a.k === "number") return number({ type: "Norm", arg: a.v });
        if (a.k !== "point") return no();
        return number({
          type: "Norm",
          arg: { type: "Seq", parenWrapped: true, args: a.c },
        });
      }
      case "Piecewise": {
        return number({
          ...n,
          condition:
            n.condition === true
              ? true
              : (this.condition(n.condition, env) as typeof n.condition),
          consequent: this.scalar(n.consequent, env),
          alternate: this.scalar(n.alternate, env),
        });
      }
      default:
        return no();
    }
  }

  private render(n: Child, map: Map<Child, Child>, kind: KindOf): Child {
    const known = map.get(n);
    if (known) return known;
    if (kind(n) === "inline") return n;
    return mapChildren(n, new Set(), (c) => this.render(c, map, kind));
  }

  /**
   * `root` as an expression where each value used more than once is computed
   * once, as a function argument. Each function computes the values that need
   * only earlier ones and passes them on to the next, and the last computes
   * `root`.
   */
  private chain(root: Child, kind: KindOf): Child {
    const uses = new Map<Child, number>();
    const visit = (n: Child) => {
      const c = uses.get(n) ?? 0;
      uses.set(n, c + 1);
      if (c === 0 && kind(n) === "op") childrenOf(n).forEach(visit);
    };
    visit(root);

    const shared = new Set<Child>();
    let boundVars = false;
    for (const [n, c] of uses) {
      if (c < 2) continue;
      if (kind(n) === "op") shared.add(n);
      else if (kind(n) === "var") boundVars = true;
    }
    if (shared.size === 0 && !boundVars) return root;

    const levels = new Map<Child, number>();
    const level = (n: Child): number => {
      if (kind(n) !== "op") return 0;
      let l = levels.get(n);
      if (l === undefined) {
        l = Math.max(0, ...childrenOf(n).map(level));
        if (shared.has(n)) l++;
        levels.set(n, l);
      }
      return l;
    };
    const at: Child[][] = [[]];
    for (const n of shared) {
      const l = level(n);
      while (at.length <= l) at.push([]);
      at[l].push(n);
    }
    const last = at.length - 1;

    /** What computing `n` reads: variables and values computed earlier. */
    const readsOf = (n: Child, out: Set<Child>) => {
      const seen = new Set<Child>();
      const go = (m: Child, top: boolean) => {
        if (seen.has(m)) return;
        seen.add(m);
        const k = kind(m);
        if (k === "inline") return;
        if (k === "var" || (!top && shared.has(m))) out.add(m);
        else childrenOf(m).forEach((c) => go(c, false));
      };
      go(n, true);
    };

    const params: Child[][] = [];
    const lastReads = new Set<Child>();
    readsOf(root, lastReads);
    params[last + 1] = [...lastReads];
    for (let l = last; l >= 1; l--) {
      const here = new Set(at[l]);
      const reads = new Set(params[l + 1].filter((v) => !here.has(v)));
      for (const s of at[l]) readsOf(s, reads);
      params[l] = [...reads];
    }

    const symbols: string[] = [];
    for (let l = 1; l <= last + 1; l++) symbols[l] = this.fresh().symbol;
    for (let l = last + 1; l >= 1; l--) {
      if (params[l].length === 0) return no();
      const map = new Map<Child, Child>();
      params[l].forEach((v, i) => map.set(v, id(this.param(i))));
      const body =
        l === last + 1
          ? this.render(root, map, kind)
          : call(
              symbols[l + 1],
              params[l + 1].map((v) => map.get(v) ?? this.render(v, map, kind))
            );
      this.added.push({
        id: `${symbols[l]}-def`,
        symbol: symbols[l],
        node: body,
        params: params[l].map((_, i) => this.param(i)),
        folded: true,
      });
    }
    return call(symbols[1], params[1]);
  }

  /** A loop over the lists `body` reads, as a function of what doesn't vary. */
  private loop(reducer: string | undefined, body: Child): Child {
    const kind: KindOf = (n) => {
      if (this.listOfRead.has(n)) return "var";
      const f = this.flags(n);
      if (f.element) return "op";
      return f.pixel ? "var" : "inline";
    };
    const entry = this.chain(body, kind);

    const invariants = new Set<Child>();
    const used = new Set<string>();
    const scan = (n: Child) => {
      const list = this.listOfRead.get(n);
      if (list !== undefined) used.add(list);
      else if (kind(n) === "var") invariants.add(n);
      else if (kind(n) === "op") childrenOf(n).forEach(scan);
    };
    scan(entry);
    if (used.size === 0) return no();
    for (const s of used) {
      const h = this.lists.get(s);
      if (h) {
        this.added.push(h);
        this.lists.delete(s);
      }
    }

    const args = [...invariants];
    const map = new Map<Child, Child>();
    args.forEach((v, i) => map.set(v, id(this.param(i))));
    const count: Child = {
      type: "DotAccess",
      object: id([...used][0]),
      property: id("count"),
    };
    const comprehension: Child = {
      type: "ListComprehension",
      expr: this.render(entry, map, kind),
      assignments: [
        {
          type: "AssignmentExpression",
          variable: id(this.loopVar),
          expression: { type: "Range", start: [num(1)], end: [count] },
        },
      ],
      bracketWrapped: true,
      parameters: [],
    };
    const looped = reducer ? call(reducer, [comprehension]) : comprehension;
    if (args.length === 0) return looped;
    const f = this.fresh();
    this.added.push({
      ...f,
      node: looped,
      params: args.map((_, i) => this.param(i)),
      folded: true,
    });
    return call(f.symbol, args);
  }

  run(root: Aug.Latex.Assignment): Aug.Latex.Assignment {
    let top = this.scalar(root.right, NO_ENV);
    if (this.flags(top).element) top = this.loop(undefined, top);
    const kind: KindOf = (n) => {
      if ([...this.coords.values()].includes(n)) return "var";
      return this.flags(n).pixel ? "op" : "inline";
    };
    return { ...root, right: this.chain(top, kind) };
  }
}

/**
 * The color definition `root` with its matrix math worked out number by
 * number, and the definitions that needs. `undefined` if it does something
 * this can't take apart.
 */
export function scalarize<T extends Node>(
  root: T,
  ctx: MatrixContext,
  fresh: Fresh
): { root: T; added: Hoisted[] } | undefined {
  if (root.type !== "Assignment") return undefined;
  const s = new Scalarizer(ctx, fresh);
  try {
    return { root: s.run(root) as T, added: s.added };
  } catch (e) {
    if (e instanceof Unsupported) return undefined;
    throw e;
  }
}
