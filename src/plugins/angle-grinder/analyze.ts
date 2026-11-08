/**
 * Finding what in a graph can change, what can't, and which expressions end
 * up in shaders.
 *
 * Why this matters, from Desmos's compiler: every constant carries a
 * "mobility". Numbers typed into an expression are Cold, a value that went
 * through an assignment `a = …` is at least Unknown, and a slider is Hot.
 * Folding two constants keeps the higher mobility. A shader writes Cold
 * values into its source and gives every other value a uniform slot, of
 * which a surface has at most 427. So a list that never changes still costs
 * a slot per number, only because it has a name. Cold values also let the
 * compiler drop `+0` and `·1` and fold more, which lowers the shader's cost.
 *
 * Everything here works on the parsed latex of each expression, using the
 * text mode AST.
 */
import type { GraphState } from "../../../graph-state";
import type { Config } from "../../../text-mode-core";
import { Aug, parseRootLatex } from "../../../text-mode-core";

type Node = Aug.Latex.AnyRootOrChild;
type Child = Aug.Latex.AnyChild;

/**
 * Names Desmos never lets a graph define, because they are the coordinates a
 * graph is drawn over.
 */
const COORDINATES = new Set(["x", "y", "z", "r", "theta", "rho", "phi"]);
/**
 * Free names a surface or curve can be drawn over. Used only to find the
 * expressions that can end up in a shader, so it errs on including more.
 */
const PIXEL_NAMES = new Set([...COORDINATES, "u", "v", "t"]);

export interface ExprInfo {
  id: string;
  latex: string;
  root: Node;
  /** The symbol this expression defines, if it is a definition. */
  defines?: string;
  isFunction: boolean;
  /**
   * A variable set to a plain number or point, which Desmos treats as a
   * slider or a draggable point.
   */
  isSlider: boolean;
  /** Free names it reads, including functions it calls. */
  deps: Set<string>;
  /** Variables its actions update. */
  updates: Set<string>;
}

export interface GraphAnalysis {
  exprs: ExprInfo[];
  byId: Map<string, ExprInfo>;
  /** Expression defining each symbol. Symbols defined twice are left out. */
  definitions: Map<string, ExprInfo>;
  /** Variables Desmos treats as sliders or draggable points. */
  sliders: string[];
  /** Variables changed by actions or the ticker. These always vary. */
  updated: Set<string>;
  /**
   * Every `with`, `for`, derivative and integral. They rebind globals of the
   * names they bind inside the definitions their bodies read.
   */
  binders: Binder[];
  /** Free names of regressions; these are the regression's parameters. */
  regressionNames: Set<string>;
  /** Expressions whose latex Desmos's parser could not read. */
  unparsed: string[];
}

/** Calls `f` on each child node with the names bound around that child. */
export function forEachChild(
  node: Node,
  bound: ReadonlySet<string>,
  f: (child: Child, bound: ReadonlySet<string>) => void
) {
  const withNames = (names: Aug.Latex.Identifier[]) => {
    if (names.length === 0) return bound;
    const s = new Set(bound);
    for (const n of names) s.add(n.symbol);
    return s;
  };
  switch (node.type) {
    case "Constant":
    case "Identifier":
      return;
    case "Equation":
    case "Regression":
      f(node.left, bound);
      f(node.right, bound);
      return;
    case "Assignment":
      f(node.right, bound);
      return;
    case "FunctionDefinition":
      f(node.definition, withNames(node.argSymbols));
      return;
    case "Visualization":
      node.args.forEach((a) => f(a, bound));
      return;
    case "FunctionCall":
      node.args.forEach((a) => f(a, bound));
      return;
    case "Integral":
      f(node.start, bound);
      f(node.end, bound);
      f(node.integrand, withNames([node.differential]));
      return;
    case "Derivative":
      // The variable is read (the derivative is evaluated at its value), but
      // replacing it inside would differentiate a constant.
      f(node.arg, withNames([node.variable]));
      return;
    case "Prime":
      f(node.arg, bound);
      return;
    case "List":
    case "Seq":
      node.args.forEach((a) => f(a, bound));
      return;
    case "Range":
      node.start.forEach((a) => f(a, bound));
      node.end.forEach((a) => f(a, bound));
      return;
    case "ListAccess":
      f(node.list, bound);
      f(node.index, bound);
      return;
    case "DotAccess":
      f(node.object, bound);
      // The property's name is a method, not a variable.
      if (node.property.type === "FunctionCall")
        node.property.args.forEach((a) => f(a, bound));
      return;
    case "OrderedPairAccess":
      f(node.point, bound);
      return;
    case "UpdateRule":
      f(node.expression, bound);
      return;
    case "AssignmentExpression":
      f(node.expression, bound);
      return;
    case "ListComprehension": {
      node.assignments.forEach((a) => f(a.expression, bound));
      for (const p of node.parameters) {
        f(p.bounds[0], bound);
        f(p.bounds[1], bound);
      }
      const inner = withNames([
        ...node.assignments.map((a) => a.variable),
        ...node.parameters.map((p) => p.identifier),
      ]);
      f(node.expr, inner);
      return;
    }
    case "Substitution":
      node.assignments.forEach((a) => f(a.expression, bound));
      f(node.body, withNames(node.assignments.map((a) => a.variable)));
      return;
    case "Piecewise":
      if (node.condition !== true) f(node.condition, bound);
      f(node.consequent, bound);
      f(node.alternate, bound);
      return;
    case "Restriction":
      if (node.condition !== true) f(node.condition, bound);
      return;
    case "RepeatedOperator":
      f(node.start, bound);
      f(node.end, bound);
      f(node.expression, withNames([node.index]));
      return;
    case "BinaryOperator":
    case "Or":
    case "Comparator":
      f(node.left, bound);
      f(node.right, bound);
      return;
    case "Negative":
    case "Norm":
    case "Factorial":
      f(node.arg, bound);
      return;
    case "ComparatorChain":
      node.args.forEach((a) => f(a, bound));
  }
}

/**
 * Names a node binds that also rebind globals inside the definitions its
 * body reads. With `k=5` and `a=k+1`, `a with k=100` is 101 and
 * `[a for k=[1,2]]` is `[2,3]`, and `d/dk a` differentiates through `a`.
 * Function parameters and sum indices don't: with `f(k)=a`, `f(2)` is 6.
 */
function dynamicBindings(node: Node): Aug.Latex.Identifier[] {
  switch (node.type) {
    case "Integral":
      return [node.differential];
    case "Derivative":
      return [node.variable];
    case "ListComprehension":
      return [
        ...node.assignments.map((a) => a.variable),
        ...node.parameters.map((p) => p.identifier),
      ];
    case "Substitution":
      return node.assignments.map((a) => a.variable);
    default:
      return [];
  }
}

/** The part of a node its dynamic bindings apply to. */
function bindingBody(node: Node): Node | undefined {
  switch (node.type) {
    case "Integral":
      return node.integrand;
    case "Derivative":
      return node.arg;
    case "ListComprehension":
      return node.expr;
    case "Substitution":
      return node.body;
    default:
      return undefined;
  }
}

/** A `with`, `for`, derivative or integral, and what its body reads. */
export interface Binder {
  /** Names it binds. */
  names: Set<string>;
  /** Free names its body reads, other than the ones it binds. */
  reads: Set<string>;
}

interface Scan {
  deps: Set<string>;
  updates: Set<string>;
  binders: Binder[];
}

function scan(
  root: Node,
  initiallyBound: ReadonlySet<string> = new Set()
): Scan {
  const out: Scan = { deps: new Set(), updates: new Set(), binders: [] };
  const visit = (node: Node, bound: ReadonlySet<string>) => {
    const dynamic = dynamicBindings(node);
    if (dynamic.length > 0) {
      const names = new Set(dynamic.map((b) => b.symbol));
      const body = bindingBody(node)!;
      out.binders.push({
        names,
        reads: scan(body, new Set([...bound, ...names])).deps,
      });
    }
    if (node.type === "Identifier") {
      if (!bound.has(node.symbol)) out.deps.add(node.symbol);
    } else if (node.type === "FunctionCall") {
      if (!bound.has(node.callee.symbol)) out.deps.add(node.callee.symbol);
    } else if (node.type === "Prime") {
      if (!bound.has(node.arg.callee.symbol))
        out.deps.add(node.arg.callee.symbol);
    } else if (node.type === "Derivative") {
      if (!bound.has(node.variable.symbol)) out.deps.add(node.variable.symbol);
    } else if (node.type === "UpdateRule") {
      out.updates.add(node.variable.symbol);
    }
    forEachChild(node, bound, visit);
  };
  visit(root, initiallyBound);
  return out;
}

function isNumberLiteral(n: Child): boolean {
  if (n.type === "Constant") return true;
  return n.type === "Negative" && n.arg.type === "Constant";
}

function isSliderDefinition(root: Node) {
  if (root.type !== "Assignment") return false;
  const r = root.right;
  if (isNumberLiteral(r)) return true;
  // A point of plain numbers can be dragged.
  return (
    r.type === "Seq" &&
    (r.args.length === 2 || r.args.length === 3) &&
    r.args.every(isNumberLiteral)
  );
}

/** Variables set by `\to` in any latex of the graph: actions, the ticker. */
function updatesInState(cfg: Config, state: GraphState, into: Set<string>) {
  const seen = new Set<string>();
  const visit = (v: unknown) => {
    if (typeof v === "string") {
      if (!v.includes("\\to") || seen.has(v)) return;
      seen.add(v);
      try {
        for (const u of scan(parseRootLatex(cfg, v)).updates) into.add(u);
      } catch {
        // Not latex, or latex Desmos can't parse. Fall back to the names
        // right before each arrow.
        const re = /([A-Za-z]|\\[a-zA-Z]+)(?:_\{?([A-Za-z0-9]+)\}?)?\s*\\to/g;
        for (const m of v.matchAll(re)) {
          const head = m[1].replace(/^\\/, "");
          into.add(m[2] ? `${head}_${m[2]}` : head);
        }
      }
    } else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === "object") Object.values(v).forEach(visit);
  };
  visit(state);
}

export function analyzeGraph(cfg: Config, state: GraphState): GraphAnalysis {
  const exprs: ExprInfo[] = [];
  const unparsed: string[] = [];
  const counts = new Map<string, number>();
  const binders: Binder[] = [];
  const regressionNames = new Set<string>();
  const updated = new Set<string>();

  for (const item of state.expressions.list) {
    if (item.type !== "expression") continue;
    const latex = item.latex ?? "";
    if (latex.trim() === "") continue;
    let root: Node;
    try {
      root = parseRootLatex(cfg, latex);
    } catch {
      unparsed.push(item.id);
      continue;
    }
    const s = scan(root);
    binders.push(...s.binders);
    for (const u of s.updates) updated.add(u);
    let defines: string | undefined;
    if (root.type === "Assignment" && !COORDINATES.has(root.left.symbol))
      defines = root.left.symbol;
    else if (root.type === "FunctionDefinition") defines = root.symbol.symbol;
    if (root.type === "Regression")
      for (const d of s.deps) regressionNames.add(d);
    if (defines) counts.set(defines, (counts.get(defines) ?? 0) + 1);
    exprs.push({
      id: item.id,
      latex,
      root,
      defines,
      isFunction: root.type === "FunctionDefinition",
      isSlider: isSliderDefinition(root),
      deps: s.deps,
      updates: s.updates,
    });
  }

  // Table columns define lists too. Their cells could be edited or dragged,
  // but they are not sliders; treat them as data that doesn't change.
  for (const item of state.expressions.list) {
    if (item.type !== "table") continue;
    for (const col of item.columns) {
      let head: Node;
      try {
        head = parseRootLatex(cfg, col.latex);
      } catch {
        continue;
      }
      if (head.type !== "Identifier" || COORDINATES.has(head.symbol)) continue;
      const deps = new Set<string>();
      for (const cell of col.values ?? []) {
        if (cell.trim() === "") continue;
        try {
          for (const d of scan(parseRootLatex(cfg, cell)).deps) deps.add(d);
        } catch {
          deps.add("\u0000unparsed");
        }
      }
      counts.set(head.symbol, (counts.get(head.symbol) ?? 0) + 1);
      exprs.push({
        id: `${item.id}:${col.id}`,
        latex: col.latex,
        root: head,
        defines: head.symbol,
        isFunction: false,
        isSlider: false,
        deps,
        updates: new Set(),
      });
    }
  }

  updatesInState(cfg, state, updated);

  const definitions = new Map<string, ExprInfo>();
  for (const e of exprs)
    if (e.defines && counts.get(e.defines) === 1) definitions.set(e.defines, e);

  const sliders = exprs
    .filter((e) => e.isSlider && e.defines && definitions.get(e.defines) === e)
    .map((e) => e.defines!);

  return {
    exprs,
    byId: new Map(exprs.map((e) => [e.id, e])),
    definitions,
    sliders,
    updated,
    binders,
    regressionNames,
    unparsed,
  };
}

function containsRestriction(node: Node): boolean {
  if (node.type === "Restriction") return true;
  let found = false;
  forEachChild(node, new Set(), (c) => {
    if (!found && containsRestriction(c)) found = true;
  });
  return found;
}

/**
 * Expressions whose shaders exist only while they are drawn: inequalities
 * and anything with a restriction. Color functions compile without that.
 */
export function drawnForShaders(a: GraphAnalysis): Set<string> {
  const out = new Set<string>();
  for (const e of a.exprs) {
    if (e.isFunction || e.id.includes(":")) continue;
    const r = e.root;
    if (
      r.type === "Comparator" ||
      r.type === "ComparatorChain" ||
      containsRestriction(r)
    )
      out.add(e.id);
  }
  return out;
}

/**
 * Symbols that can change: the varying sliders, everything actions update,
 * regression parameters, and everything defined from those.
 */
export function varyingSymbols(a: GraphAnalysis, varyingSliders: Set<string>) {
  const varying = new Set<string>([...a.updated, ...a.regressionNames]);
  for (const s of a.sliders) if (varyingSliders.has(s)) varying.add(s);
  // Symbols defined more than once are errors in Desmos, but treat them as
  // varying to be safe.
  for (const e of a.exprs)
    if (e.defines && a.definitions.get(e.defines) !== e) varying.add(e.defines);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [sym, e] of a.definitions) {
      if (varying.has(sym)) continue;
      for (const d of e.deps)
        if (varying.has(d)) {
          varying.add(sym);
          changed = true;
          break;
        }
    }
  }
  return varying;
}

/**
 * Symbols whose value can be written into an expression: defined once, never
 * varying, not a function, and not rebound anywhere (see `reboundSymbols`).
 * Whether the value can be written as numbers is decided later by evaluating
 * it.
 */
export function inlineCandidates(a: GraphAnalysis, varying: Set<string>) {
  const rebound = reboundSymbols(a);
  const out: string[] = [];
  for (const [sym, e] of a.definitions) {
    if (e.isFunction || varying.has(sym) || rebound.has(sym)) continue;
    out.push(sym);
  }
  return out;
}

/**
 * Symbols that mean something else somewhere: a definition read from inside
 * a `with` or `for` (or derivative, or integral) whose value depends on a
 * name that binds, and a bound name read by such a definition.
 */
export function reboundSymbols(a: GraphAnalysis) {
  const closures = new Map<string, Set<string>>();
  /** Every name `sym`'s definition reads, through other definitions. */
  const closure = (sym: string): Set<string> => {
    let c = closures.get(sym);
    if (c) return c;
    c = new Set();
    closures.set(sym, c);
    const stack = [sym];
    while (stack.length) {
      const s = stack.pop()!;
      const def = a.definitions.get(s);
      if (!def) continue;
      for (const d of def.deps)
        if (!c.has(d)) {
          c.add(d);
          stack.push(d);
        }
    }
    return c;
  };
  const out = new Set<string>();
  for (const b of a.binders) {
    const reached = new Set<string>();
    for (const r of b.reads) {
      if (a.definitions.has(r)) reached.add(r);
      for (const d of closure(r)) if (a.definitions.has(d)) reached.add(d);
    }
    for (const sym of reached) {
      const def = a.definitions.get(sym)!;
      for (const d of def.deps) if (b.names.has(d)) out.add(d);
      for (const d of closure(sym))
        if (b.names.has(d)) {
          out.add(sym);
          break;
        }
    }
  }
  return out;
}

/**
 * Expressions that can end up in a shader: the ones drawn over pixel
 * coordinates, everything they read that isn't a constant, and every function
 * they call. Inlining anywhere else has no effect on the GPU.
 */
export function shaderExpressions(
  a: GraphAnalysis,
  constants: ReadonlySet<string>
): ExprInfo[] {
  const pixel = new Set<ExprInfo>();
  // An expression reads pixel coordinates if a free name is a coordinate
  // that the graph doesn't define, or it reads such an expression.
  const readsPixels = (e: ExprInfo, seen = new Set<ExprInfo>()): boolean => {
    if (seen.has(e)) return false;
    seen.add(e);
    for (const d of e.deps) {
      const def = a.definitions.get(d);
      if (!def) {
        if (PIXEL_NAMES.has(d)) return true;
        continue;
      }
      if (!def.isFunction && readsPixels(def, seen)) return true;
    }
    return false;
  };
  for (const e of a.exprs) {
    if (e.id.includes(":")) continue; // table columns
    if (e.updates.size > 0) continue; // actions run on the CPU
    if (e.defines && constants.has(e.defines)) continue;
    if (readsPixels(e)) pixel.add(e);
  }
  // Follow what they read, through functions and non-constant definitions.
  const out = new Set<ExprInfo>();
  const stack = [...pixel];
  while (stack.length) {
    const e = stack.pop()!;
    if (out.has(e)) continue;
    out.add(e);
    for (const d of e.deps) {
      const def = a.definitions.get(d);
      if (!def || def.id.includes(":")) continue;
      if (!def.isFunction && constants.has(d)) continue;
      if (def.updates.size > 0) continue;
      stack.push(def);
    }
  }
  return a.exprs.filter((e) => out.has(e));
}
