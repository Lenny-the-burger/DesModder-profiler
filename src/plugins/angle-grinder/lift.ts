/**
 * Pass the definitions a function reads in as arguments.
 *
 * Desmos compiles a definition where it is read, and caches it for the rest of
 * the expression, but every function call (and every `with`, sum or `for`)
 * starts with an empty cache, because the names it binds could change what a
 * definition means. So a definition read in a function's body is compiled
 * again on every call. Measured: a definition read in a function called 10
 * times took 134 ms to compile, 30 ms when passed in as an argument (135 ms
 * and 9 ms with the calls nested in another function).
 *
 * A definition is passed in only when nothing it reads, through other
 * definitions, is a name the function binds: then it means the same at the
 * call as in the body. Functions called from somewhere their calls can't be
 * rewritten (the ticker, a prime, a method call, without calling them) are
 * left alone, and so is recursion.
 */
import type { Aug } from "../../../text-mode-core";
import { freeNames } from "./inline";
import { bindingsOf, mapChildren, substitute } from "./rewrite";

type Node = Aug.Latex.AnyRootOrChild;
type Child = Aug.Latex.AnyChild;

export interface LiftInput {
  /** The current tree of each expression, by id. */
  trees: ReadonlyMap<string, Node>;
  /** Whether a variable is worth passing in (it takes work to compile). */
  liftable: (symbol: string) => boolean;
  /** Functions called from latex that isn't in `trees`. */
  fixed: ReadonlySet<string>;
  /** A new name, unused in the graph. */
  fresh: () => string;
}

export interface LiftResult {
  /** The trees that changed, by id. */
  trees: Map<string, Node>;
  /** The variables passed in to each function, in argument order. */
  lifted: Map<string, string[]>;
}

const ident = (symbol: string): Aug.Latex.Identifier => ({
  type: "Identifier",
  symbol,
});

/** Every name bound anywhere in `n`, function parameters included. */
function allBindings(n: Node, out: Set<string>) {
  for (const s of bindingsOf(n)) out.add(s);
  mapChildren(n, new Set(), (c) => {
    allBindings(c, out);
    return c;
  });
}

/** Names `n` binds below its own bindings (not a function's parameters). */
function boundBelow(n: Node): Set<string> {
  const out = new Set<string>();
  mapChildren(n, new Set(), (c) => {
    allBindings(c, out);
    return c;
  });
  return out;
}

/**
 * Functions referenced other than by a plain call: as a value, under a prime,
 * or as a method.
 */
function oddUses(n: Node, fns: ReadonlySet<string>, out: Set<string>) {
  if (n.type === "Identifier" && fns.has(n.symbol)) out.add(n.symbol);
  if (n.type === "Prime") out.add(n.arg.callee.symbol);
  if (n.type === "DotAccess") {
    const p = n.property;
    out.add(p.type === "FunctionCall" ? p.callee.symbol : p.symbol);
  }
  mapChildren(n, new Set(), (c) => {
    oddUses(c, fns, out);
    return c;
  });
}

/** User functions called in `n`. */
function callees(n: Node, fns: ReadonlySet<string>, out = new Set<string>()) {
  if (n.type === "FunctionCall" && fns.has(n.callee.symbol))
    out.add(n.callee.symbol);
  mapChildren(n, new Set(), (c) => {
    callees(c, fns, out);
    return c;
  });
  return out;
}

/**
 * `n` with `extra` appended to the arguments of each call of a function;
 * `touched.value` is set if any call was.
 */
function addArguments<T extends Node>(
  n: T,
  extra: ReadonlyMap<string, readonly string[]>,
  touched: { value: boolean }
): T {
  const out = mapChildren(n, new Set(), (c) => addArguments(c, extra, touched));
  if (out.type === "FunctionCall") {
    const more = extra.get(out.callee.symbol);
    if (more && more.length > 0) {
      touched.value = true;
      return { ...out, args: [...out.args, ...more.map(ident)] };
    }
  }
  return out;
}

export function liftGlobals(input: LiftInput): LiftResult {
  const { trees, liftable, fixed, fresh } = input;
  const fns = new Map<
    string,
    { id: string; def: Aug.Latex.FunctionDefinition }
  >();
  /** What each definition reads directly, by the name it defines. */
  const reads = new Map<string, Set<string>>();
  for (const [id, t] of trees) {
    if (t.type === "FunctionDefinition") {
      fns.set(t.symbol.symbol, { id, def: t });
      reads.set(
        t.symbol.symbol,
        freeNames(t.definition, new Set(t.argSymbols.map((a) => a.symbol)))
      );
    } else if (t.type === "Assignment") {
      reads.set(t.left.symbol, freeNames(t.right));
    }
  }
  const names = new Set(fns.keys());

  // Functions whose calls can't all be rewritten, and recursion.
  const bad = new Set<string>([...fixed].filter((f) => names.has(f)));
  for (const t of trees.values()) oddUses(t, names, bad);
  const calls = new Map<string, Set<string>>();
  for (const [f, { def }] of fns) calls.set(f, callees(def.definition, names));
  for (const f of names) {
    const seen = new Set<string>();
    const stack = [...calls.get(f)!];
    while (stack.length) {
      const g = stack.pop()!;
      if (g === f) bad.add(f);
      if (seen.has(g)) continue;
      seen.add(g);
      stack.push(...(calls.get(g) ?? []));
    }
  }

  /** Everything a definition reads, through other definitions. */
  const closureOf = new Map<string, Set<string>>();
  const closure = (s: string) => {
    let out = closureOf.get(s);
    if (out) return out;
    closureOf.set(s, (out = new Set()));
    const stack = [...(reads.get(s) ?? [])];
    while (stack.length) {
      const r = stack.pop()!;
      if (out.has(r)) continue;
      out.add(r);
      stack.push(...(reads.get(r) ?? []));
    }
    return out;
  };

  // A name bound anywhere could be captured at a call; never pass those.
  const boundAnywhere = new Set<string>();
  for (const t of trees.values()) allBindings(t, boundAnywhere);

  const blockedOf = new Map<string, Set<string>>();
  for (const [f, { def }] of fns)
    blockedOf.set(
      f,
      new Set([...def.argSymbols.map((a) => a.symbol), ...boundBelow(def)])
    );
  const allowed = (f: string, g: string) => {
    if (!liftable(g) || boundAnywhere.has(g) || names.has(g)) return false;
    if (!reads.has(g)) return false;
    const blocked = blockedOf.get(f)!;
    if (blocked.has(g)) return false;
    for (const r of closure(g)) if (blocked.has(r)) return false;
    return true;
  };

  const lifted = new Map<string, Set<string>>();
  for (const [f, { def }] of fns) {
    if (bad.has(f)) continue;
    const params = new Set(def.argSymbols.map((a) => a.symbol));
    const direct = [...freeNames(def.definition, params)].filter((g) =>
      allowed(f, g)
    );
    lifted.set(f, new Set(direct));
  }
  // What a callee is passed has to be at the call, so the caller reads it too.
  for (let changed = true; changed; ) {
    changed = false;
    for (const [f, set] of lifted)
      for (const c of calls.get(f)!)
        for (const g of lifted.get(c) ?? [])
          if (!set.has(g) && allowed(f, g)) {
            set.add(g);
            changed = true;
          }
  }

  const order = new Map<string, string[]>();
  for (const [f, set] of lifted)
    if (set.size > 0) order.set(f, [...set].sort());

  const out = new Map<string, Node>();
  if (order.size === 0) return { trees: out, lifted: order };
  for (const [id, t] of trees) {
    const touched = { value: false };
    let next: Node = addArguments(t, order, touched);
    if (next.type === "FunctionDefinition") {
      const gs = order.get(next.symbol.symbol);
      if (gs) {
        touched.value = true;
        const params = gs.map(() => fresh());
        const rename = new Map<string, Child>(
          gs.map((g, i) => [g, ident(params[i])])
        );
        next = {
          ...next,
          argSymbols: [...next.argSymbols, ...params.map(ident)],
          definition: substitute(next.definition, rename, new Set()),
        };
      }
    }
    if (touched.value) out.set(id, next);
  }
  return { trees: out, lifted: order };
}
