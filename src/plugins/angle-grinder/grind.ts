/**
 * Rewriting a graph so Desmos compiles cheaper shaders from it, keeping what
 * it draws the same. The result is plain graph state that works without
 * DesModder.
 */
import type { GraphState } from "../../../graph-state";
import type { Config } from "../../../text-mode-core";
import { identifierToString, Aug } from "../../../text-mode-core";

import {
  GraphAnalysis,
  analyzeGraph,
  drawnForShaders,
  inlineCandidates,
  shaderExpressions,
  varyingSymbols,
} from "./analyze";
import { ExpressionDiff, diffOf } from "./diff";
import { Lab, Measurement } from "./lab";
import {
  Value,
  printLatex,
  roundTrips,
  substitute,
  valueNode,
  valueSize,
} from "./rewrite";

/** Values with more numbers than this are left as variables. */
export const MAX_INLINE_NUMBERS = 3000;

export interface GrindOptions {
  /** Sliders and draggable points that should keep varying. */
  varyingSliders: Set<string>;
}

export interface Skipped {
  id: string;
  reason: "round-trip" | "new-error";
  detail?: string;
}

export interface GrindResult {
  debug: {
    leftovers: Record<string, string>;
    candidates: number;
    evaluated: number;
    literals: number;
    targets: string[];
    varying: string[];
  };
  state: GraphState;
  /** Variables whose values were written into expressions. */
  inlined: string[];
  /** Expressions that changed. */
  rewritten: string[];
  /** How each changed expression changed, in graph order. */
  diffs: ExpressionDiff[];
  /** The expression defining each written-in variable. */
  definedIn: Map<string, string>;
  skipped: Skipped[];
  before: Measurement;
  after: Measurement;
  /** Errors the output has that the input didn't, by expression id. */
  newErrors: Map<string, string>;
}

export function sliderSymbols(cfg: Config, state: GraphState) {
  const a = analyzeGraph(cfg, state);
  return { sliders: a.sliders, updated: a.updated };
}

/** Ids of the expressions `id` reads from, directly or not. */
function readsFrom(a: GraphAnalysis, id: string) {
  const out = new Set<string>();
  const start = a.byId.get(id);
  if (!start) return out;
  const stack = [start];
  while (stack.length) {
    const e = stack.pop()!;
    for (const d of e.deps) {
      const def = a.definitions.get(d);
      if (!def || out.has(def.id)) continue;
      out.add(def.id);
      stack.push(def);
    }
  }
  return out;
}

function newErrorsOf(before: Measurement, after: Measurement) {
  const out = new Map<string, string>();
  for (const [id, msg] of after.errors)
    if (before.errors.get(id) !== msg) out.set(id, msg);
  return out;
}

function withLatex(state: GraphState, latex: ReadonlyMap<string, string>) {
  const copy: GraphState = JSON.parse(JSON.stringify(state));
  for (const item of copy.expressions.list)
    if (item.type === "expression" && latex.has(item.id))
      item.latex = latex.get(item.id)!;
  return copy;
}

export async function grind(
  cfg: Config,
  state: GraphState,
  opts: GrindOptions,
  progress: (step: string) => void = () => {}
): Promise<GrindResult> {
  progress("analyze");
  const a: GraphAnalysis = analyzeGraph(cfg, state);
  const varying = varyingSymbols(a, opts.varyingSliders);
  const latexOf = (symbol: string) =>
    identifierToString(cfg, { type: "Identifier", symbol });

  const lab = Lab.create();
  try {
    progress("measure");
    const draw = drawnForShaders(a);
    await lab.load(state, draw);
    const before = lab.measure();

    progress("evaluate");
    const defined = [...a.definitions.values()]
      .filter((e) => !e.isFunction)
      .map((e) => e.defines!);
    const values = await lab.values(defined, latexOf);
    const constants = new Set(values.keys());

    const literals = new Map<string, Aug.Latex.AnyChild>();
    for (const s of inlineCandidates(a, varying)) {
      const v: Value | undefined = values.get(s);
      if (!v || valueSize(v) > MAX_INLINE_NUMBERS) continue;
      literals.set(s, valueNode(v));
    }

    progress("rewrite");
    const latex = new Map<string, string>();
    const skipped: Skipped[] = [];
    const usedBy = new Map<string, Set<string>>();
    const roots = new Map<string, Aug.Latex.AnyRootOrChild>();
    for (const e of shaderExpressions(a, constants)) {
      const used = new Set<string>();
      const root = substitute(e.root, literals, used);
      if (root === e.root || used.size === 0) continue;
      if (!roundTrips(cfg, e.root)) {
        skipped.push({ id: e.id, reason: "round-trip" });
        continue;
      }
      latex.set(e.id, printLatex(cfg, root));
      usedBy.set(e.id, used);
      roots.set(e.id, e.root);
    }

    progress("verify");
    let out = withLatex(state, latex);
    await lab.load(out, draw);
    let after = lab.measure();
    let newErrors = newErrorsOf(before, after);
    // Put back expressions that gained an error, and the rewritten
    // expressions those read, until no expression has a new error. If that
    // doesn't find the cause, put everything back.
    for (let round = 0; round < 4 && newErrors.size > 0; round++) {
      const revert = new Map<string, string>();
      for (const [id, msg] of newErrors) {
        if (latex.has(id)) revert.set(id, msg);
        for (const dep of readsFrom(a, id))
          if (latex.has(dep)) revert.set(dep, msg);
      }
      if (revert.size === 0 || round === 3)
        for (const id of latex.keys())
          revert.set(id, newErrors.values().next().value!);
      for (const [id, msg] of revert) {
        latex.delete(id);
        skipped.push({ id, reason: "new-error", detail: msg });
      }
      if (revert.size === 0) break;
      out = withLatex(state, latex);
      await lab.load(out, draw);
      after = lab.measure();
      newErrors = newErrorsOf(before, after);
    }

    const diffs: ExpressionDiff[] = [];
    for (const e of a.exprs)
      if (latex.has(e.id))
        diffs.push(
          diffOf(cfg, e.id, roots.get(e.id)!, usedBy.get(e.id)!, values)
        );
    const inlined = new Set<string>();
    for (const id of latex.keys())
      for (const s of usedBy.get(id) ?? []) inlined.add(s);
    // Constants shader expressions still read, and why they stay variables.
    const leftovers: Record<string, string> = {};
    const candidates = new Set(inlineCandidates(a, varying));
    for (const e of shaderExpressions(a, constants))
      for (const d of e.deps) {
        if (!constants.has(d) || literals.has(d)) continue;
        const v = values.get(d)!;
        leftovers[d] = varying.has(d)
          ? "varying"
          : !candidates.has(d)
            ? "rebound"
            : valueSize(v) > MAX_INLINE_NUMBERS
              ? `too-big:${valueSize(v)}`
              : "other";
      }
    return {
      debug: {
        leftovers,
        candidates: inlineCandidates(a, varying).length,
        evaluated: values.size,
        literals: literals.size,
        targets: shaderExpressions(a, constants).map((e) => e.id),
        varying: [...varying],
      },
      state: out,
      inlined: [...inlined],
      rewritten: [...latex.keys()],
      diffs,
      definedIn: new Map(
        [...inlined].map((s) => [s, a.definitions.get(s)!.id])
      ),
      skipped,
      before,
      after,
      newErrors,
    };
  } finally {
    lab.destroy();
  }
}
