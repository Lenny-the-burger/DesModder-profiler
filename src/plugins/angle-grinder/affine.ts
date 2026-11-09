/**
 * Folding work that is affine in the pixel out of shaders.
 *
 * In `[B for n=[1...N]]`, a shader computes `B` for every element and every
 * pixel. When something `B` reads is affine in the coordinates, like a
 * barycentric coordinate `b = ((p-p_1)·A)/d` with `A`, `d` per element, it
 * equals `x·G_x[n] + y·G_y[n] + z·G_z[n] + G_0[n]` for lists `G` that don't
 * depend on the pixel, so Desmos computes them once on the CPU and the shader
 * does three products per element. The lists come from Desmos itself, as
 * `G_0 = [b with x=0,y=0,z=0 for n=[1...N]]` and
 * `G_x = [b with x=1,y=0,z=0 for n=[1...N]] - G_0`, so nothing about `b` has
 * to be worked out here except that it is affine.
 *
 * A definition `b` that `B` reads is replaced for this expression only, with
 * `[B with b=… for n=[1...N]]`: `with` rebinds `b` inside every definition
 * `B` reads. It costs four numbers per element for each folded value, so it
 * is for shaders over the cost limit.
 */
import type { Aug } from "../../../text-mode-core";
import { PIXEL_NAMES, ShaderPart, containsWith, withAround } from "./hot";
import type { Hoisted } from "./inline";
import { bindingsOf, mapChildren } from "./rewrite";

type Node = Aug.Latex.AnyRootOrChild;
type Child = Aug.Latex.AnyChild;

/** Longest list a shader takes. */
const MAX_SHADER_LIST = 100;

export interface GraphDefinitions {
  /** Right sides of the graph's variable definitions, by name. */
  variables: ReadonlyMap<string, Child>;
  /** Bodies of the graph's functions, with their parameters, by name. */
  functions: ReadonlyMap<string, Aug.Latex.FunctionDefinition>;
}

/** How a value depends on the coordinates. */
enum Dep {
  None = 0,
  Affine = 1,
  Other = 2,
}

const join = (ks: Dep[]) => Math.max(Dep.None, ...ks) as Dep;

const id = (symbol: string): Aug.Latex.Identifier => ({
  type: "Identifier",
  symbol,
});
const num = (value: number): Aug.Latex.Constant => ({
  type: "Constant",
  value,
});
const bin = (
  name: Aug.Latex.BinaryOperator["name"],
  left: Child,
  right: Child
): Child => ({ type: "BinaryOperator", name, left, right });

/**
 * Dependence on the coordinates, through the graph's definitions. `local` are
 * names bound inside the comprehension body, which can't be moved out of it;
 * the comprehension's own variable is a constant per element.
 */
class Analysis {
  private readonly memo = new Map<string, Dep>();
  /** Coordinates each definition reads, through other definitions. */
  readonly coordsOf = new Map<string, Set<string>>();

  constructor(
    private readonly defs: GraphDefinitions,
    private readonly coords: ReadonlySet<string>,
    /** Names that are constant here, like the comprehension's variable. */
    private readonly fixed: ReadonlySet<string>
  ) {}

  ofName(s: string): Dep {
    if (this.fixed.has(s)) return Dep.None;
    const known = this.memo.get(s);
    if (known !== undefined) return known;
    const right = this.defs.variables.get(s);
    if (!right) return this.coords.has(s) ? Dep.Affine : Dep.None;
    // A definition reading itself is an error; call it not affine.
    this.memo.set(s, Dep.Other);
    const k = this.of(right, new Set());
    this.memo.set(s, k);
    return k;
  }

  /** The coordinates `n` reads. */
  coordsIn(n: Node, out = new Set<string>(), seen = new Set<string>()) {
    const visit = (m: Node, bound: ReadonlySet<string>) => {
      const names: string[] = [];
      if (m.type === "Identifier") names.push(m.symbol);
      if (m.type === "FunctionCall") names.push(m.callee.symbol);
      for (const s of names) {
        if (bound.has(s) || seen.has(s) || this.fixed.has(s)) continue;
        seen.add(s);
        const right = this.defs.variables.get(s);
        const f = this.defs.functions.get(s);
        if (right) visit(right, new Set());
        else if (f)
          visit(f.definition, new Set(f.argSymbols.map((a) => a.symbol)));
        else if (this.coords.has(s)) out.add(s);
      }
      mapChildren(m, bound, (c, b) => {
        visit(c, b);
        return c;
      });
    };
    visit(n, new Set());
    return out;
  }

  /** Dependence of `n`, where `local` names vary in ways not known here. */
  of(n: Node, local: ReadonlySet<string>): Dep {
    const depends = () =>
      this.coordsIn(n).size > 0 || freeIn(n, local) ? Dep.Other : Dep.None;
    switch (n.type) {
      case "Constant":
        return Dep.None;
      case "Identifier":
        if (local.has(n.symbol)) return Dep.Other;
        return this.ofName(n.symbol);
      case "BinaryOperator": {
        const l = this.of(n.left, local);
        const r = this.of(n.right, local);
        switch (n.name) {
          case "Add":
          case "Subtract":
            return join([l, r]);
          case "Multiply":
          case "CrossMultiply":
            if (l === Dep.None || r === Dep.None) return join([l, r]);
            return Dep.Other;
          case "Divide":
            return r === Dep.None ? l : Dep.Other;
          default:
            return l === Dep.None && r === Dep.None ? Dep.None : Dep.Other;
        }
      }
      case "Negative":
        return this.of(n.arg, local);
      case "Seq":
        if (!n.parenWrapped) return depends();
        return join(n.args.map((a) => this.of(a, local)));
      case "ListAccess": {
        if (this.of(n.index, local) !== Dep.None) return Dep.Other;
        return this.of(n.list, local);
      }
      case "OrderedPairAccess":
        return this.of(n.point, local);
      default:
        return depends();
    }
  }
}

/** Whether `n` reads any of `names` freely. */
function freeIn(n: Node, names: ReadonlySet<string>): boolean {
  if (names.size === 0) return false;
  let found = false;
  const visit = (m: Node, bound: ReadonlySet<string>) => {
    if (found) return;
    if (m.type === "Identifier" && names.has(m.symbol) && !bound.has(m.symbol))
      found = true;
    mapChildren(m, bound, (c, b) => {
      visit(c, b);
      return c;
    });
  };
  visit(n, new Set());
  return found;
}

/**
 * Whether a definition is cheap to compute from what it reads: sums of
 * names and numbers. Those are left for the shader, and what they read is
 * folded instead (`1-b_V-b_W` from folded `b_V` and `b_W`).
 */
function cheap(n: Child): boolean {
  switch (n.type) {
    case "Constant":
    case "Identifier":
      return true;
    case "Negative":
      return cheap(n.arg);
    case "BinaryOperator":
      if (n.name === "Add" || n.name === "Subtract")
        return cheap(n.left) && cheap(n.right);
      if (n.name === "Multiply")
        return (
          (n.left.type === "Constant" && cheap(n.right)) ||
          (n.right.type === "Constant" && cheap(n.left))
        );
      return false;
    default:
      return false;
  }
}

/** `[1...N]` with `N` a number a shader can take a list of. */
function oneTo(n: Child): number | undefined {
  if (n.type !== "Range" || n.start.length !== 1 || n.end.length !== 1)
    return undefined;
  const [s] = n.start;
  const [e] = n.end;
  if (s.type !== "Constant" || s.value !== 1 || e.type !== "Constant")
    return undefined;
  if (!Number.isInteger(e.value) || e.value < 1 || e.value > MAX_SHADER_LIST)
    return undefined;
  return e.value;
}

/** Names bound by binding nodes anywhere inside `n`. */
function boundIn(n: Node, out = new Set<string>()) {
  for (const s of bindingsOf(n)) out.add(s);
  mapChildren(n, new Set(), (c) => {
    boundIn(c, out);
    return c;
  });
  return out;
}

export type Fresh = () => { id: string; symbol: string };

/**
 * Definitions `body` reads to fold, outermost first: an affine one that isn't
 * cheap is folded, anything else is looked into. Comprehensions are skipped
 * when `skipComprehensions`, since names in them can depend on its variable.
 */
function chooseFolds(
  body: Node,
  a: Analysis,
  defs: GraphDefinitions,
  skip: ReadonlySet<string>,
  skipComprehensions: boolean
): string[] {
  const chosen: string[] = [];
  const seen = new Set<string>(skip);
  const look = (m: Node, bound: ReadonlySet<string>) => {
    if (skipComprehensions && m.type === "ListComprehension") return;
    if (m.type === "Identifier" && !bound.has(m.symbol)) {
      const s = m.symbol;
      const right = defs.variables.get(s);
      if (!right || seen.has(s)) return;
      seen.add(s);
      const k = a.ofName(s);
      if (k === Dep.None) return;
      if (k === Dep.Affine && !cheap(right)) {
        chosen.push(s);
        return;
      }
      look(right, new Set());
      return;
    }
    if (m.type === "FunctionCall" && !bound.has(m.callee.symbol)) {
      const f = defs.functions.get(m.callee.symbol);
      if (f && !seen.has(m.callee.symbol)) {
        seen.add(m.callee.symbol);
        look(f.definition, new Set(f.argSymbols.map((p) => p.symbol)));
      }
    }
    mapChildren(m, bound, (c, b) => {
      look(c, b);
      return c;
    });
  };
  look(body, new Set());
  return chosen;
}

/**
 * For each of `chosen`, the assignment `s = x·G_x + y·G_y + … + G_0` and the
 * definitions of the `G`s, which are `wrap`ped (in the comprehension) and
 * read through `at` (indexed by its variable).
 */
function foldsOf(
  chosen: string[],
  a: Analysis,
  fresh: Fresh,
  wrap: (body: Child) => Child,
  at: (symbol: string) => Child
) {
  const assignments: Aug.Latex.AssignmentExpression[] = [];
  const added: Hoisted[] = [];
  const folded: string[] = [];
  for (const s of chosen) {
    const used = [...a.coordsIn(id(s))].sort();
    if (used.length === 0) continue;
    const withCoords = (one?: string): Child => ({
      type: "Substitution",
      body: id(s),
      assignments: used.map((c) => ({
        type: "AssignmentExpression",
        variable: id(c),
        expression: num(c === one ? 1 : 0),
      })),
    });
    const g0 = fresh();
    added.push({ ...g0, node: wrap(withCoords()), folded: true });
    // Built the way the parser builds a sum.
    let form: Child | undefined;
    for (const c of used) {
      const g = fresh();
      added.push({
        ...g,
        node: bin("Subtract", wrap(withCoords(c)), id(g0.symbol)),
        folded: true,
      });
      const term = bin("Multiply", id(c), at(g.symbol));
      form = form ? bin("Add", form, term) : term;
    }
    form = bin("Add", form!, at(g0.symbol));
    assignments.push({
      type: "AssignmentExpression",
      variable: id(s),
      expression: form,
    });
    folded.push(s);
  }
  return { assignments, added, folded };
}

/**
 * Fold the affine values `root`'s shader reads into lists computed on the
 * CPU: inside each `[B for n=[1...N]]`, per element, and if there are none of
 * those to fold, for the whole shader (where they are lists when the graph
 * broadcasts over lists). `part` is the part of `root` the shader computes.
 * `folded` names what was folded; `added` are the new definitions.
 */
export function foldAffine<T extends Node>(
  root: T,
  part: ShaderPart,
  defs: GraphDefinitions,
  fresh: Fresh
): { root: T; folded: string[]; added: Hoisted[] } {
  const coords = new Set(
    [...PIXEL_NAMES].filter(
      (c) => !defs.variables.has(c) && !defs.functions.has(c)
    )
  );
  const folded: string[] = [];
  const added: Hoisted[] = [];
  // The folded values are rebound with a `with`, which can't go inside
  // another.
  if (containsWith(root)) return { root, folded, added };

  const comprehension = (
    n: Aug.Latex.ListComprehension
  ): Aug.Latex.ListComprehension | undefined => {
    if (n.assignments.length !== 1 || n.parameters.length !== 0)
      return undefined;
    const [{ variable, expression: list }] = n.assignments;
    if (oneTo(list) === undefined) return undefined;
    const local = boundIn(n.expr);
    if (local.has(variable.symbol)) return undefined;
    const a = new Analysis(defs, coords, new Set([variable.symbol]));
    const chosen = chooseFolds(
      n.expr,
      a,
      defs,
      new Set([variable.symbol]),
      false
    );
    const f = foldsOf(
      chosen,
      a,
      fresh,
      (body) => ({
        type: "ListComprehension",
        expr: body,
        assignments: [{ ...n.assignments[0] }],
        bracketWrapped: true,
        parameters: [],
      }),
      (s) => ({ type: "ListAccess", list: id(s), index: id(variable.symbol) })
    );
    if (f.assignments.length === 0) return undefined;
    added.push(...f.added);
    folded.push(...f.folded);
    return {
      ...n,
      expr: { type: "Substitution", body: n.expr, assignments: f.assignments },
    };
  };

  const go = (m: Node, bound: ReadonlySet<string>): Node => {
    if (m.type === "ListComprehension" && bound.size === 0) {
      const out = comprehension(m);
      if (out) return out;
    }
    return mapChildren(m, bound, (c, b) => go(c, b) as Child);
  };
  const out = go(root, new Set()) as T;
  if (folded.length > 0) return { root: out, folded, added };

  // Nothing in comprehensions: fold for the whole shader.
  const a = new Analysis(defs, coords, new Set());
  const body = root.type === "Assignment" ? root.right : root;
  const f = foldsOf(
    chooseFolds(body, a, defs, new Set(), true),
    a,
    fresh,
    (b) => b,
    id
  );
  if (f.assignments.length === 0) return { root, folded, added };
  const placed = withAround(root, part, f.assignments);
  if (!placed) return { root, folded, added };
  return { root: placed, folded: f.folded, added: f.added };
}
