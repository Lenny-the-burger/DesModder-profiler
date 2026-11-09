/**
 * Writing values into expressions as typed-in numbers.
 */
import type { Config } from "../../../text-mode-core";
import {
  Aug,
  latexTreeToString,
  parseRootLatexWithMatrices as parseRootLatex,
} from "../../../text-mode-core";

type Node = Aug.Latex.AnyRootOrChild;
type Child = Aug.Latex.AnyChild;

/** A value that can be written as typed-in numbers. */
export type Value =
  | { type: "number"; value: number }
  | { type: "list"; value: number[] }
  | { type: "point"; value: number[] }
  /** A list of points, by coordinate. */
  | { type: "points"; value: number[][] };

export function valueSize(v: Value) {
  switch (v.type) {
    case "number":
      return 1;
    case "list":
    case "point":
      return v.value.length;
    case "points":
      return v.value.reduce((n, c) => n + c.length, 0);
  }
}

/** A number as latex Desmos reads back to the same double. */
export function numberNode(v: number): Child {
  if (Number.isNaN(v))
    return {
      type: "BinaryOperator",
      name: "Divide",
      left: { type: "Constant", value: 0 },
      right: { type: "Constant", value: 0 },
    };
  if (v < 0 || Object.is(v, -0))
    return { type: "Negative", arg: numberNode(-v) };
  if (v === Infinity) return { type: "Identifier", symbol: "infty" };
  const s = v.toString();
  const e = s.indexOf("e");
  if (e === -1) return { type: "Constant", value: v };
  return {
    type: "BinaryOperator",
    name: "Multiply",
    left: { type: "Constant", value: Number(s.slice(0, e)) },
    right: {
      type: "BinaryOperator",
      name: "Exponent",
      left: { type: "Constant", value: 10 },
      right: numberNode(Number(s.slice(e + 1))),
    },
  };
}

export function valueNode(v: Value): Child {
  switch (v.type) {
    case "number":
      return numberNode(v.value);
    case "list":
      return { type: "List", args: v.value.map(numberNode) };
    case "point":
      return { type: "Seq", parenWrapped: true, args: v.value.map(numberNode) };
    case "points":
      // A point of lists is a list of points, and is a lot shorter to write.
      return {
        type: "Seq",
        parenWrapped: true,
        args: v.value.map((c) => ({ type: "List", args: c.map(numberNode) })),
      };
  }
}

export function bindingsOf(node: Node): string[] {
  switch (node.type) {
    case "FunctionDefinition":
      return node.argSymbols.map((s) => s.symbol);
    case "Integral":
      return [node.differential.symbol];
    case "Derivative":
      return [node.variable.symbol];
    case "ListComprehension":
      return [
        ...node.assignments.map((a) => a.variable.symbol),
        ...node.parameters.map((p) => p.identifier.symbol),
      ];
    case "Substitution":
      return node.assignments.map((a) => a.variable.symbol);
    case "RepeatedOperator":
      return [node.index.symbol];
    default:
      return [];
  }
}

/**
 * Rebuild `node` with each child replaced by `f` of it, given the names bound
 * around that child. The children are the ones `forEachChild` in analyze.ts
 * visits: a function's name in a call or a prime, a derivative's variable, a
 * method's name and the names a node binds are left as they are.
 */
export function mapChildren<T extends Node>(
  node: T,
  bound: ReadonlySet<string>,
  f: (child: Child, bound: ReadonlySet<string>) => Child
): T {
  const names = bindingsOf(node);
  const inner = names.length > 0 ? new Set([...bound, ...names]) : bound;
  // `f` keeps the kind of node where the tree needs it (conditions, points).
  const c = <C extends Child>(x: C, b: ReadonlySet<string> = bound) =>
    f(x, b) as C;
  const m: Node = node;
  let out: Node;
  switch (m.type) {
    case "Constant":
    case "Identifier":
      return node;
    case "FunctionCall":
      out = { ...m, args: m.args.map((a) => c(a)) };
      break;
    case "Equation":
    case "Regression":
      out = { ...m, left: c(m.left), right: c(m.right) };
      break;
    case "Assignment":
      out = { ...m, right: c(m.right) };
      break;
    case "FunctionDefinition":
      out = { ...m, definition: c(m.definition, inner) };
      break;
    case "Visualization":
      out = { ...m, args: m.args.map((a) => c(a)) };
      break;
    case "Integral":
      out = {
        ...m,
        start: c(m.start),
        end: c(m.end),
        integrand: c(m.integrand, inner),
      };
      break;
    case "Derivative":
      out = { ...m, arg: c(m.arg, inner) };
      break;
    case "Prime":
      out = { ...m, arg: { ...m.arg, args: m.arg.args.map((a) => c(a)) } };
      break;
    case "List":
    case "Seq":
      out = { ...m, args: m.args.map((a) => c(a)) };
      break;
    case "Range":
      out = {
        ...m,
        start: m.start.map((a) => c(a)),
        end: m.end.map((a) => c(a)),
      };
      break;
    case "ListAccess":
      out = { ...m, list: c(m.list), index: c(m.index) };
      break;
    case "Matrix":
      out = { ...m, rows: m.rows.map((r) => r.map((x) => c(x))) };
      break;
    case "MatrixAccess":
      out = {
        ...m,
        matrix: c(m.matrix),
        row: c(m.row),
        column: c(m.column),
      };
      break;
    case "DotAccess":
      out = {
        ...m,
        object: c(m.object),
        property:
          m.property.type === "FunctionCall"
            ? { ...m.property, args: m.property.args.map((a) => c(a)) }
            : m.property,
      };
      break;
    case "OrderedPairAccess":
      out = { ...m, point: c(m.point) };
      break;
    case "UpdateRule":
      out = { ...m, expression: c(m.expression) };
      break;
    case "AssignmentExpression":
      out = { ...m, expression: c(m.expression) };
      break;
    case "ListComprehension":
      out = {
        ...m,
        expr: c(m.expr, inner),
        assignments: m.assignments.map((a) => ({
          ...a,
          expression: c(a.expression),
        })),
        parameters: m.parameters.map((p) => ({
          ...p,
          bounds: [c(p.bounds[0]), c(p.bounds[1])] as [Child, Child],
        })),
      };
      break;
    case "Substitution":
      out = {
        ...m,
        body: c(m.body, inner),
        assignments: m.assignments.map((a) => ({
          ...a,
          expression: c(a.expression),
        })),
      };
      break;
    case "Piecewise":
      out = {
        ...m,
        condition: m.condition === true ? true : c(m.condition),
        consequent: c(m.consequent),
        alternate: c(m.alternate),
      };
      break;
    case "Restriction":
      out = {
        ...m,
        condition: m.condition === true ? true : c(m.condition),
      };
      break;
    case "RepeatedOperator":
      out = {
        ...m,
        start: c(m.start),
        end: c(m.end),
        expression: c(m.expression, inner),
      };
      break;
    case "BinaryOperator":
      out = { ...m, left: c(m.left), right: c(m.right) };
      break;
    case "Or":
      out = { ...m, left: c(m.left), right: c(m.right) };
      break;
    case "Comparator":
      out = { ...m, left: c(m.left), right: c(m.right) };
      break;
    case "Negative":
    case "Norm":
    case "Factorial":
      out = { ...m, arg: c(m.arg) };
      break;
    case "ComparatorChain":
      out = { ...m, args: m.args.map((a) => c(a)) };
      break;
  }
  return out as T;
}

/**
 * Rebuild `node`, replacing each free identifier that has a value in
 * `values` with that value. The names replaced are added to `used`.
 */
export function substitute<T extends Node>(
  node: T,
  values: ReadonlyMap<string, Child>,
  used: Set<string>
): T {
  const go = (n: Node, bound: ReadonlySet<string>): Node => {
    if (n.type === "Identifier") {
      const v = !bound.has(n.symbol) ? values.get(n.symbol) : undefined;
      if (!v) return n;
      used.add(n.symbol);
      return v;
    }
    if (n.type === "FunctionCall") {
      const v = !bound.has(n.callee.symbol)
        ? values.get(n.callee.symbol)
        : undefined;
      if (v) {
        // `a(b)` with a variable `a` is a product.
        const args = n.args.map((a) => go(a, bound) as Child);
        used.add(n.callee.symbol);
        return {
          type: "BinaryOperator",
          name: "Multiply",
          left: v,
          right:
            args.length === 1
              ? args[0]
              : { type: "Seq", parenWrapped: true, args },
        };
      }
    }
    return mapChildren(n, bound, (c, b) => go(c, b) as Child);
  };
  return go(node, new Set()) as T;
}

/** Structural equality of two parsed trees. */
/**
 * A negated number as the number itself: in a list, `-0.1` reads back as one
 * constant, elsewhere as a negation.
 */
function folded(x: unknown): unknown {
  if (
    typeof x === "object" &&
    x !== null &&
    (x as { type?: unknown }).type === "Negative"
  ) {
    const { arg } = x as { arg: unknown };
    if (
      typeof arg === "object" &&
      arg !== null &&
      (arg as { type?: unknown }).type === "Constant"
    )
      return { type: "Constant", value: -(arg as { value: number }).value };
  }
  return x;
}

function sameTree(a0: unknown, b0: unknown): boolean {
  const a = folded(a0);
  const b = folded(b0);
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number")
    return Number.isNaN(a) && Number.isNaN(b);
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka)
    if (
      !sameTree(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k]
      )
    )
      return false;
  return true;
}

/**
 * Whether printing `latex`'s tree and parsing it again gives the same tree.
 * The tree leaves out a few things Desmos's parser keeps, so an expression is
 * only rewritten when nothing is lost.
 */
export function roundTrips(cfg: Config, root: Node) {
  try {
    return sameTree(parseRootLatex(cfg, latexTreeToString(cfg, root)), root);
  } catch {
    return false;
  }
}

export function printLatex(cfg: Config, root: Node) {
  return latexTreeToString(cfg, root);
}
