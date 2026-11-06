/**
 * Build a flame graph tree from a recording. Pure: labels are supplied by the
 * caller, so this can be unit tested without Desmos.
 */
import { Recording, Summary } from "./aggregate";
import { mergeCallTrees } from "./calltree";
import { CallTree, SymbolKind, UNATTRIBUTED } from "./types";

/** Determines the color of a node. */
export type FlameCategory =
  | "root"
  | "parse"
  | "compile"
  | "graph"
  | "draw"
  | "shader"
  | "gpu"
  | "other"
  | "expression";

export type FlameNodeKind =
  | "root"
  | "phase"
  | "expression"
  | "definition"
  | "overhead"
  | "subexpression"
  | "detail";

export interface FlameNode {
  /** Unique among siblings; a path of keys identifies a node. */
  key: string;
  name: string;
  kind: FlameNodeKind;
  category: FlameCategory;
  /** Inclusive time, in ms. */
  value: number;
  /** For definitions: number of compiles merged into this node. */
  count?: number;
  /** Expression this node belongs to, if any. */
  exprId?: string;
  /** For pieces of an expression: their source LaTeX. */
  latex?: string;
  /** For definitions. */
  symbol?: string;
  symbolKind?: SymbolKind;
  definedBy?: string;
  wackscope?: boolean;
  /** Sorted by value, largest first. */
  children: FlameNode[];
}

export type FlameGrouping = "phase" | "expression";
export type FlameMetric = "cpu" | "gpu";

export interface FlameLabels {
  root: (metric: FlameMetric) => string;
  phase: (phase: Phase | "other") => string;
  expression: (id: string) => string;
  definition: (symbol: string, kind: SymbolKind) => string;
  unattributed: string;
  shaderWait: string;
}

type Phase = "parse" | "compile" | "graph" | "draw" | "shader";

const PHASES: Phase[] = ["parse", "compile", "graph", "draw", "shader"];

export { mergeCallTrees } from "./calltree";

/**
 * Drop empty children and sort the rest, largest first. Skips subtrees in
 * `done`, which are shared between trees and already finished.
 */
function finish(node: FlameNode, done?: WeakSet<FlameNode>): FlameNode {
  if (done?.has(node)) return node;
  node.children = node.children
    .filter((c) => c.value > 0)
    .map((c) => finish(c, done))
    .sort((a, b) => b.value - a.value);
  done?.add(node);
  return node;
}

function sumChildren(node: FlameNode): FlameNode {
  node.value = node.children.reduce((s, c) => s + Math.max(0, c.value), 0);
  return node;
}

export interface FlameView {
  grouping: FlameGrouping;
  metric: FlameMetric;
}

export function buildFlameTree(
  rec: Recording,
  summary: Summary,
  opts: FlameView,
  labels: FlameLabels
): FlameNode {
  return flameSource(rec, summary, labels).tree(opts);
}

/**
 * The trees of one recording, one per view, built on first use. The views
 * share the expensive part (merging call trees and turning them into nodes),
 * so switching views after the first is cheap.
 */
export interface FlameSource {
  tree: (view: FlameView) => FlameNode;
}

export function flameSource(
  rec: Recording,
  summary: Summary,
  labels: FlameLabels
): FlameSource {
  // Merge each statement's call trees across change sets.
  const compileCalls = new Map<string, CallTree>();
  const graphCalls = new Map<string, CallTree>();
  for (const cs of rec.changeSets)
    for (const [id, stat] of Object.entries(cs.profile.statements)) {
      if (!compileCalls.has(id)) compileCalls.set(id, {});
      if (!graphCalls.has(id)) graphCalls.set(id, {});
      mergeCallTrees(compileCalls.get(id)!, stat.compileCalls);
      mergeCallTrees(graphCalls.get(id)!, stat.graphCalls);
    }

  const sourceInfo = new Map(
    summary.sources.map((s) => [`${s.kind}:${s.symbol}`, s])
  );
  const rows = new Map(summary.expressions.map((r) => [r.id, r]));

  // The same pieces show up across expressions and compiles.
  const texts = new Map<string, string>();
  const text = (latex: string) => {
    let t = texts.get(latex);
    if (t === undefined) texts.set(latex, (t = latexToText(latex)));
    return t;
  };

  const finished = new WeakSet<FlameNode>();
  // Call subtrees by phase and expression, shared by every view.
  const callNodes = new Map<string, FlameNode[]>();
  const callsOf = (category: "compile" | "graph", id: string) => {
    const key = `${category}:${id}`;
    let nodes = callNodes.get(key);
    if (!nodes) {
      const calls = (category === "compile" ? compileCalls : graphCalls).get(
        id
      );
      nodes = callsToNodes(calls, category, id).map((n) => finish(n, finished));
      callNodes.set(key, nodes);
    }
    return nodes;
  };

  const callsToNodes = (
    tree: CallTree | undefined,
    category: FlameCategory,
    exprId: string
  ): FlameNode[] =>
    Object.entries(tree ?? {}).map(([key, call]) => {
      const info = sourceInfo.get(key);
      if (call.kind === "node")
        return {
          key,
          name: text(call.symbol),
          kind: "subexpression",
          category,
          value: call.time,
          count: call.count,
          exprId,
          latex: call.symbol,
          children: callsToNodes(call.children, category, exprId),
        };
      return {
        key,
        name: labels.definition(call.symbol, call.kind),
        kind: "definition",
        category,
        value: call.time,
        count: call.count,
        exprId,
        symbol: call.symbol,
        symbolKind: call.kind,
        definedBy: info?.definedBy,
        wackscope: info?.wackscope,
        children: callsToNodes(call.children, category, exprId),
      };
    });

  /** The cost of one expression in one phase, with its inlined definitions. */
  const phaseOfExpression = (
    phase: Phase,
    id: string,
    key: string,
    name: string,
    kind: FlameNodeKind
  ): FlameNode | undefined => {
    const row = rows.get(id);
    if (!row) return undefined;
    const base = { key, name, kind, category: phase, exprId: id };
    switch (phase) {
      case "parse":
        return { ...base, value: row.parse, children: [] };
      case "compile":
        return {
          ...base,
          value: row.analysis,
          children: callsOf("compile", id),
        };
      case "graph":
        return {
          ...base,
          value: row.graph,
          children: callsOf("graph", id),
        };
      case "draw":
        return { ...base, value: row.canvas + row.cpuDraw, children: [] };
      case "shader":
        return {
          ...base,
          value: row.setProgram,
          children:
            row.shaderBlock > 0
              ? [
                  {
                    key: "wait",
                    name: labels.shaderWait,
                    kind: "detail",
                    category: "shader",
                    value: row.shaderBlock,
                    exprId: id,
                    children: [],
                  },
                ]
              : [],
        };
    }
  };

  const un3d = summary.unattributed3D;
  const overheadLeaf = (
    key: string,
    name: string,
    category: FlameCategory,
    value: number
  ): FlameNode => ({
    key,
    name,
    kind: "overhead",
    category,
    value,
    children: [],
  });

  const ids = summary.expressions.map((r) => r.id);

  const build = (opts: FlameView): FlameNode => {
    let root: FlameNode;
    if (opts.metric === "gpu") {
      root = {
        key: "root",
        name: labels.root("gpu"),
        kind: "root",
        category: "root",
        value: 0,
        children: [
          ...summary.expressions.map(
            (r): FlameNode => ({
              key: r.id,
              name: labels.expression(r.id),
              kind: "expression",
              category: "gpu",
              value: r.gpu,
              exprId: r.id,
              children: [],
            })
          ),
          overheadLeaf(
            UNATTRIBUTED,
            labels.unattributed,
            "other",
            un3d?.gpu ?? 0
          ),
        ],
      };
    } else if (opts.grouping === "phase") {
      const overhead: Record<Phase, number> = {
        parse: 0,
        compile: summary.overhead.analysis,
        graph: summary.overhead.graph,
        draw: (un3d?.cpuDraw ?? 0) + summary.overhead.render,
        shader: un3d?.setProgram ?? 0,
      };
      root = {
        key: "root",
        name: labels.root("cpu"),
        kind: "root",
        category: "root",
        value: 0,
        children: [
          ...PHASES.map((phase) =>
            sumChildren({
              key: phase,
              name: labels.phase(phase),
              kind: "phase",
              category: phase,
              value: 0,
              children: [
                ...ids.flatMap(
                  (id) =>
                    phaseOfExpression(
                      phase,
                      id,
                      id,
                      labels.expression(id),
                      "expression"
                    ) ?? []
                ),
                overheadLeaf(
                  UNATTRIBUTED,
                  labels.unattributed,
                  "other",
                  overhead[phase]
                ),
              ],
            })
          ),
          overheadLeaf(
            "other",
            labels.phase("other"),
            "other",
            summary.overhead.other
          ),
        ],
      };
    } else {
      root = {
        key: "root",
        name: labels.root("cpu"),
        kind: "root",
        category: "root",
        value: 0,
        children: [
          ...ids.map((id) =>
            sumChildren({
              key: id,
              name: labels.expression(id),
              kind: "expression",
              category: "expression",
              value: 0,
              exprId: id,
              children: PHASES.flatMap(
                (phase) =>
                  phaseOfExpression(
                    phase,
                    id,
                    phase,
                    labels.phase(phase),
                    "phase"
                  ) ?? []
              ),
            })
          ),
          sumChildren({
            key: UNATTRIBUTED,
            name: labels.unattributed,
            kind: "overhead",
            category: "other",
            value: 0,
            children: [
              overheadLeaf(
                "compile",
                labels.phase("compile"),
                "compile",
                summary.overhead.analysis
              ),
              overheadLeaf(
                "graph",
                labels.phase("graph"),
                "graph",
                summary.overhead.graph
              ),
              overheadLeaf(
                "draw",
                labels.phase("draw"),
                "draw",
                (un3d?.cpuDraw ?? 0) + summary.overhead.render
              ),
              overheadLeaf(
                "shader",
                labels.phase("shader"),
                "shader",
                un3d?.setProgram ?? 0
              ),
              overheadLeaf(
                "other",
                labels.phase("other"),
                "other",
                summary.overhead.other
              ),
            ],
          }),
        ],
      };
    }
    return finish(sumChildren(root), finished);
  };

  const trees = new Map<string, FlameNode>();
  return {
    tree(view) {
      // Grouping only applies to CPU time.
      const key = view.metric === "gpu" ? "gpu" : `cpu:${view.grouping}`;
      let tree = trees.get(key);
      if (!tree) trees.set(key, (tree = build(view)));
      return tree;
    },
  };
}

/** Find the chain of nodes from the root along a path of keys. */
export function resolvePath(root: FlameNode, keys: string[]): FlameNode[] {
  const out = [root];
  let node = root;
  for (const key of keys) {
    const next = node.children.find((c) => c.key === key);
    if (!next) break;
    out.push(next);
    node = next;
  }
  return out;
}

/** Self time: the part of a node not covered by its children. */
export function flameSelf(node: FlameNode): number {
  return Math.max(
    0,
    node.value - node.children.reduce((s, c) => s + c.value, 0)
  );
}

/** Total time of nodes whose name matches, not double-counting nested matches. */
export function matchedTime(
  node: FlameNode,
  matches: (n: FlameNode) => boolean
): number {
  if (matches(node)) return node.value;
  return node.children.reduce((s, c) => s + matchedTime(c, matches), 0);
}

/**
 * Flatten a LaTeX string into short readable text for labels:
 * `p_{rojRes}=c_{amPipeIO}\left(v_{erts}\right)` -> `p_rojRes=c_amPipeIO(v_erts)`.
 */
export function latexToText(latex: string): string {
  // Literal braces (piecewise) survive; structural braces are stripped below.
  const OPEN = "\u0001";
  const CLOSE = "\u0002";
  let s = latex.replace(/\\\{/g, OPEN).replace(/\\\}/g, CLOSE);
  s = s.replace(/\\token\{[^}]*\}/g, "#");
  s = s.replace(/\\left|\\right/g, "");
  s = s.replace(/\\to(?![a-zA-Z])/g, " -> ");
  s = s.replace(/\\cdot/g, " * ");
  s = s.replace(/\\operatorname\{(with|for)\}/g, " $1 ");
  s = s.replace(/\\operatorname\{([^}]*)\}/g, "$1");
  // Desmos-style names: `p_{rojRes}` reads as `projRes`.
  s = s.replace(/([A-Za-z0-9])_\{([^{}]+)\}/g, "$1$2");
  // Innermost first, so nested fractions and roots come out right.
  for (let prev = ""; prev !== s; ) {
    prev = s;
    s = s.replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, "($1)/($2)");
    s = s.replace(/\\sqrt\{([^{}]*)\}/g, "sqrt($1)");
  }
  s = s.replace(/\^\{([^{}]*)\}/g, "^$1");
  s = s.replace(/\\([a-zA-Z]+)/g, "$1");
  s = s.replace(/\\ */g, " ");
  s = s.replace(/[{}]/g, "");
  s = s.split(OPEN).join("{").split(CLOSE).join("}");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

/**
 * A compiler symbol as readable text, matching `latexToText`:
 * `p_rojRes` -> `projRes`, `f` -> `f`.
 */
export function symbolToText(symbol: string): string {
  return symbol.replace("_", "");
}
