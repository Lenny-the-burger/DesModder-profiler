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
  phase: (phase: "compile" | "graph" | "draw" | "shader" | "other") => string;
  expression: (id: string) => string;
  definition: (symbol: string, kind: SymbolKind) => string;
  unattributed: string;
  shaderWait: string;
}

type Phase = "compile" | "graph" | "draw" | "shader";

export { mergeCallTrees } from "./calltree";

function finish(node: FlameNode): FlameNode {
  node.children = node.children
    .filter((c) => c.value > 0)
    .map(finish)
    .sort((a, b) => b.value - a.value);
  return node;
}

function sumChildren(node: FlameNode): FlameNode {
  node.value = node.children.reduce((s, c) => s + Math.max(0, c.value), 0);
  return node;
}

export function buildFlameTree(
  rec: Recording,
  summary: Summary,
  opts: { grouping: FlameGrouping; metric: FlameMetric },
  labels: FlameLabels
): FlameNode {
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
          name: latexToText(call.symbol),
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
    const row = summary.expressions.find((r) => r.id === id);
    if (!row) return undefined;
    const base = { key, name, kind, category: phase, exprId: id };
    switch (phase) {
      case "compile":
        return {
          ...base,
          value: row.analysis,
          children: callsToNodes(compileCalls.get(id), "compile", id),
        };
      case "graph":
        return {
          ...base,
          value: row.graph,
          children: callsToNodes(graphCalls.get(id), "graph", id),
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
      compile: summary.overhead.analysis,
      graph: summary.overhead.graph,
      draw: un3d?.cpuDraw ?? 0,
      shader: un3d?.setProgram ?? 0,
    };
    const phases: Phase[] = ["compile", "graph", "draw", "shader"];
    root = {
      key: "root",
      name: labels.root("cpu"),
      kind: "root",
      category: "root",
      value: 0,
      children: [
        ...phases.map((phase) =>
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
    const phases: Phase[] = ["compile", "graph", "draw", "shader"];
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
            children: phases.flatMap(
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
              un3d?.cpuDraw ?? 0
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
  return finish(sumChildren(root));
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
