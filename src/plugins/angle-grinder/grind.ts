/**
 * Rewriting a graph so Desmos compiles cheaper shaders from it, keeping what
 * it draws the same. The result is plain graph state that works without
 * DesModder.
 *
 * Three passes, each measured by compiling the result in an offscreen
 * calculator:
 *
 * 1. Values that don't change are typed into the expressions that end up in
 *    shaders, so the shader gets them as literals instead of uniform slots.
 * 2. Products of a changing value and a sum are split when that folds the
 *    changing part into fewer numbers (see `distribute`).
 * 3. Shaders still out of uniform slots compute what they need from the
 *    sliders themselves, if that stays under the cost limit (see `pushToGpu`).
 */
import type { GraphState } from "../../../graph-state";
import type { Config } from "../../../text-mode-core";
import { identifierToString, Aug } from "../../../text-mode-core";

import {
  ExprInfo,
  GraphAnalysis,
  analyzeGraph,
  drawnForShaders,
  inlineCandidates,
  reboundSymbols,
  shaderExpressions,
  varyingSymbols,
} from "./analyze";
import { ExpressionDiff, diffOf } from "./diff";
import { Names, ShaderPart, distribute, pushToGpu } from "./hot";
import { Lab, Measurement, ShaderStat } from "./lab";
import {
  Value,
  printLatex,
  roundTrips,
  substitute,
  valueNode,
  valueSize,
} from "./rewrite";
import { COST_LIMIT, UNIFORM_BUDGET } from "./summary";

type Node = Aug.Latex.AnyRootOrChild;

/** Values with more numbers than this are left as variables. */
export const MAX_INLINE_NUMBERS = 3000;

/** Most single variables tried when moving work to the GPU, per shader. */
const MAX_PUSH_TRIALS = 6;

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
    trials: string[];
  };
  state: GraphState;
  /** Variables whose values were written into expressions. */
  inlined: string[];
  /** Expressions that changed. */
  rewritten: string[];
  /** Expressions with products split. */
  split: string[];
  /** Expressions that compute changing values in the shader. */
  pushed: string[];
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

/** The expression a shader comes from, and which part of it. */
function shaderSource(s: ShaderStat): { id: string; part: ShaderPart } {
  const [part, id] = s.key.split(":") as [ShaderPart, string];
  return { id, part };
}

/** Shader stats by key. */
const byKey = (m: Measurement) => new Map(m.shaders.map((s) => [s.key, s]));

const atCap = (s: ShaderStat) => s.uniforms >= UNIFORM_BUDGET;

/** How an expression is rewritten. */
interface Edit {
  /** The parsed expression, after the rewrites for changing values. */
  tree: Node;
  /** Whether values are typed in. */
  typeIn: boolean;
  split: number;
  gpu: string[];
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
  const trials: string[] = [];

  const lab = Lab.create();
  try {
    progress("measure");
    const draw = drawnForShaders(a);
    const measure = async (s: GraphState) => {
      await lab.load(s, draw);
      return lab.measure();
    };
    const before = await measure(state);

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
    const typedInNames = new Set(literals.keys());

    const edits = new Map<string, Edit>();
    const usedBy = new Map<string, Set<string>>();
    /** The latex of an edit, with values typed in if it has them. */
    const print = (id: string, edit: Edit) => {
      if (!edit.typeIn) return printLatex(cfg, edit.tree);
      const used = new Set<string>();
      const out = printLatex(cfg, substitute(edit.tree, literals, used));
      usedBy.set(id, used);
      return out;
    };
    /** Latex of every edited expression. */
    const allLatex = (extra?: ReadonlyMap<string, Edit>) => {
      const out = new Map<string, string>();
      for (const [id, e] of edits)
        if (!extra?.has(id)) out.set(id, print(id, e));
      for (const [id, e] of extra ?? []) out.set(id, print(id, e));
      return out;
    };

    progress("rewrite");
    const skipped: Skipped[] = [];
    const targets = shaderExpressions(a, constants);
    for (const e of targets) {
      const used = new Set<string>();
      substitute(e.root, literals, used);
      if (used.size === 0) continue;
      if (!roundTrips(cfg, e.root)) {
        skipped.push({ id: e.id, reason: "round-trip" });
        continue;
      }
      edits.set(e.id, { tree: e.root, typeIn: true, split: 0, gpu: [] });
    }

    progress("verify");
    let after = await measure(withLatex(state, allLatex()));
    let newErrors = newErrorsOf(before, after);
    // Put back expressions that gained an error, and the rewritten
    // expressions those read, until no expression has a new error. If that
    // doesn't find the cause, put everything back.
    for (let round = 0; round < 4 && newErrors.size > 0; round++) {
      const revert = new Map<string, string>();
      for (const [id, msg] of newErrors) {
        if (edits.has(id)) revert.set(id, msg);
        for (const dep of readsFrom(a, id))
          if (edits.has(dep)) revert.set(dep, msg);
      }
      if (revert.size === 0 || round === 3)
        for (const id of edits.keys())
          revert.set(id, newErrors.values().next().value!);
      for (const [id, msg] of revert) {
        edits.delete(id);
        skipped.push({ id, reason: "new-error", detail: msg });
      }
      if (revert.size === 0) break;
      after = await measure(withLatex(state, allLatex()));
      newErrors = newErrorsOf(before, after);
    }

    /** Ids of the expressions each shader reads, itself included. */
    const closureOf = new Map<string, Set<string>>();
    const closure = (id: string) => {
      let c = closureOf.get(id);
      if (!c) closureOf.set(id, (c = new Set([id, ...readsFrom(a, id)])));
      return c;
    };
    const namesFor = (edit: Edit | undefined): Names => ({
      constants,
      typedIn: edit?.typeIn ? typedInNames : new Set(),
      defined: new Set(a.definitions.keys()),
    });
    const editOf = (e: ExprInfo): Edit =>
      edits.get(e.id) ?? { tree: e.root, typeIn: false, split: 0, gpu: [] };

    progress("distribute");
    {
      const tried = new Map<string, Edit>();
      for (const e of targets) {
        if (e.id.includes(":") || !roundTrips(cfg, e.root)) continue;
        const edit = editOf(e);
        const d = distribute(edit.tree, namesFor(edit));
        if (d.count === 0) continue;
        const next = { ...edit, tree: d.root, split: edit.split + d.count };
        // The split tree has to print and read back as built.
        const printed = edit.typeIn
          ? substitute(d.root, literals, new Set())
          : d.root;
        if (!roundTrips(cfg, printed)) continue;
        tried.set(e.id, next);
      }
      if (tried.size > 0) {
        const m = await measure(withLatex(state, allLatex(tried)));
        trials.push(`distribute ${[...tried.keys()].join(",")}`);
        const errs = newErrorsOf(before, m);
        const was = byKey(after);
        const now = byKey(m);
        const keep = new Map<string, Edit>();
        for (const [id, edit] of tried) {
          if (errs.has(id)) continue;
          let better = false;
          let worse = false;
          for (const [key, s] of was) {
            if (!closure(shaderSource(s).id).has(id)) continue;
            const n = now.get(key);
            if (!n || errs.has(shaderSource(s).id)) {
              worse = true;
              continue;
            }
            if (n.uniforms > s.uniforms) worse = true;
            else if (
              n.cost > s.cost &&
              !(atCap(s) && !atCap(n) && n.cost <= COST_LIMIT)
            )
              worse = true;
            if (n.uniforms < s.uniforms || n.cost < s.cost) better = true;
          }
          if (better && !worse) keep.set(id, edit);
        }
        if (keep.size > 0) {
          const snapshot = new Map(edits);
          for (const [id, edit] of keep) edits.set(id, edit);
          const m2 =
            keep.size === tried.size
              ? m
              : await measure(withLatex(state, allLatex()));
          if (newErrorsOf(before, m2).size > newErrors.size) {
            // The kept splits fail together; keep none of them.
            edits.clear();
            for (const [id, edit] of snapshot) edits.set(id, edit);
          } else after = m2;
        }
      }
    }

    progress("push");
    {
      const pushable = new Set(
        [...a.updated, ...a.sliders.filter((s) => varying.has(s))].filter((s) =>
          values.has(s)
        )
      );
      const rebound = reboundSymbols(a);
      /** Per shader source expression, the sets of variables to try. */
      const plans = new Map<
        string,
        { part: ShaderPart; w: string; sets: string[][] }
      >();
      for (const s of after.shaders) {
        if (!atCap(s)) continue;
        const { id, part } = shaderSource(s);
        if (plans.has(id)) continue;
        const e = a.byId.get(id);
        if (!e || e.id.includes(":")) continue;
        if (part === "color" && !e.defines) continue;
        if (!roundTrips(cfg, e.root)) continue;
        const reads = new Set<string>();
        for (const cid of closure(id))
          for (const d of a.byId.get(cid)?.deps ?? []) reads.add(d);
        const w = ["x", "y", "z", "u", "v"].find(
          (c) => reads.has(c) && !a.definitions.has(c)
        );
        if (!w) continue;
        const syms = [...reads].filter(
          (r) => pushable.has(r) && !rebound.has(r)
        );
        if (syms.length === 0) continue;
        const sets = [syms];
        if (syms.length > 1)
          for (const s1 of syms.slice(0, MAX_PUSH_TRIALS)) sets.push([s1]);
        plans.set(id, { part, w, sets });
      }

      /** Every name `sym`'s definition reads, through other definitions. */
      const readsOf = new Map<string, Set<string>>();
      const reads = (sym: string) => {
        let out = readsOf.get(sym);
        if (out) return out;
        readsOf.set(sym, (out = new Set()));
        const stack = [sym];
        while (stack.length) {
          for (const d of a.definitions.get(stack.pop()!)?.deps ?? [])
            if (!out.has(d)) {
              out.add(d);
              stack.push(d);
            }
        }
        return out;
      };
      /**
       * Definitions the shader of `id` will compute per pixel once `set` is
       * rebound, with values typed into them: what they read that doesn't
       * change would otherwise take uniform slots in the shader.
       */
      const perPixel = (id: string, set: string[]) => {
        const out = new Map<string, Edit>();
        for (const cid of closure(id)) {
          const e = a.byId.get(cid);
          if (!e?.defines || e.isFunction || cid === id || cid.includes(":"))
            continue;
          if (!set.some((s) => s === e.defines || reads(e.defines!).has(s)))
            continue;
          const used = new Set<string>();
          substitute(e.root, literals, used);
          if (used.size === 0 || !roundTrips(cfg, e.root)) continue;
          out.set(cid, { ...editOf(e), typeIn: true });
        }
        return out;
      };

      interface Outcome {
        edit: Edit;
        extras: Map<string, Edit>;
        stats: ShaderStat[];
      }
      const outcomes = new Map<string, Outcome[]>();
      const rounds = Math.max(
        0,
        ...[...plans.values()].map((p) => p.sets.length)
      );
      for (let r = 0; r < rounds; r++) {
        const tried = new Map<string, Edit>();
        const extrasOf = new Map<string, Map<string, Edit>>();
        for (const [id, plan] of plans) {
          const set = plan.sets[r];
          if (!set) continue;
          const edit = editOf(a.byId.get(id)!);
          const tree = pushToGpu(
            edit.tree,
            plan.part,
            new Map(set.map((s) => [s, values.get(s)!])),
            plan.w
          );
          if (!tree) continue;
          const next = { ...edit, tree, gpu: set };
          const printed = edit.typeIn
            ? substitute(tree, literals, new Set())
            : tree;
          if (!roundTrips(cfg, printed)) continue;
          tried.set(id, next);
          extrasOf.set(id, perPixel(id, set));
        }
        if (tried.size === 0) continue;
        const all = new Map(tried);
        for (const extras of extrasOf.values())
          for (const [eid, e] of extras) if (!all.has(eid)) all.set(eid, e);
        const m = await measure(withLatex(state, allLatex(all)));
        trials.push(
          `push ${[...tried].map(([id, e]) => `${id}:${e.gpu.join("+")}`).join(",")}`
        );
        const errs = newErrorsOf(before, m);
        for (const [id, edit] of tried) {
          const stats = m.shaders.filter((s) => shaderSource(s).id === id);
          trials.push(
            `  ${id}:${edit.gpu.join("+")} -> ${
              errs.get(id) ??
              stats.map((s) => `u${s.uniforms} c${s.cost}`).join(" ")
            }`
          );
          if (errs.has(id)) continue;
          if (stats.length === 0) continue;
          if (stats.some((s) => atCap(s) || s.cost > COST_LIMIT)) continue;
          let list = outcomes.get(id);
          if (!list) outcomes.set(id, (list = []));
          list.push({ edit, extras: extrasOf.get(id)!, stats });
        }
      }
      const chosen = new Map<string, Outcome>();
      for (const [id, list] of outcomes) {
        const cost = (o: Outcome) => o.stats.reduce((n, s) => n + s.cost, 0);
        list.sort((x, y) => cost(x) - cost(y));
        chosen.set(id, list[0]);
      }
      if (chosen.size > 0) {
        const snapshot = new Map(edits);
        const apply = (ids: Iterable<string>) => {
          edits.clear();
          for (const [id, e] of snapshot) edits.set(id, e);
          for (const id of ids) {
            const o = chosen.get(id)!;
            edits.set(id, o.edit);
            for (const [eid, e] of o.extras)
              if (!edits.get(eid)?.typeIn) edits.set(eid, e);
          }
        };
        apply(chosen.keys());
        let m = await measure(withLatex(state, allLatex()));
        const errs = newErrorsOf(before, m);
        if (errs.size > newErrors.size) {
          // Keep only the shaders whose expressions didn't gain an error.
          const good = [...chosen].filter(
            ([id, o]) =>
              !errs.has(id) && ![...o.extras.keys()].some((e) => errs.has(e))
          );
          apply(good.map(([id]) => id));
          m = await measure(withLatex(state, allLatex()));
          if (newErrorsOf(before, m).size > newErrors.size) {
            apply([]);
            m = await measure(withLatex(state, allLatex()));
          }
        }
        after = m;
      }
    }

    newErrors = newErrorsOf(before, after);
    const latex = allLatex();
    const out = withLatex(state, latex);

    const inlined = new Set<string>();
    for (const [id, edit] of edits)
      if (edit.typeIn) for (const s of usedBy.get(id) ?? []) inlined.add(s);
    const diffs: ExpressionDiff[] = [];
    for (const e of a.exprs) {
      const edit = edits.get(e.id);
      if (!edit) continue;
      diffs.push(
        diffOf(
          cfg,
          e.id,
          e.root,
          edit.typeIn ? (usedBy.get(e.id) ?? []) : [],
          values,
          edit.tree,
          { split: edit.split, gpu: edit.gpu }
        )
      );
    }
    // Constants shader expressions still read, and why they stay variables.
    const leftovers: Record<string, string> = {};
    const candidates = new Set(inlineCandidates(a, varying));
    for (const e of targets)
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
        candidates: candidates.size,
        evaluated: values.size,
        literals: literals.size,
        targets: targets.map((e) => e.id),
        varying: [...varying],
        trials,
      },
      state: out,
      inlined: [...inlined],
      rewritten: [...latex.keys()],
      split: [...edits].filter(([, e]) => e.split > 0).map(([id]) => id),
      pushed: [...edits].filter(([, e]) => e.gpu.length > 0).map(([id]) => id),
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
