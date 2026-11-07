/**
 * The parts of the expressions behind a shader, as a tree: the shader, its
 * restriction and color parts, then the parse nodes each was compiled from.
 * A definition used by an expression nests under the place that uses it.
 * Each node knows what it adds to the shader by itself (`self`) and with
 * everything under it (`total`).
 */
import { analyzeShader, ListInfo } from "./analyze";
import type { CostCategory, ShaderSourceInfo, WorkerLoop } from "./worker";
import type {
  InspectedShader,
  Origin,
  ResolveSource,
  ShaderPart,
} from "./report";

export type Metric = "cost" | "uniforms" | "glsl" | "loops";
export const METRICS: Metric[] = ["cost", "uniforms", "glsl", "loops"];

/** What a uniform slot holds. */
export type SlotKind = "single" | "list" | "baked";
export const SLOT_KINDS: SlotKind[] = ["single", "list", "baked"];

export interface Stats {
  cost: Partial<Record<CostCategory, number>>;
  slots: Partial<Record<SlotKind, number>>;
  /** Characters of GLSL. */
  chars: number;
  /** Times a loop body runs per pixel, for loops that start here. */
  loopSteps: number;
}

export type SpanNodeKind = "shader" | "part" | "frame" | "untraced";

export interface NodeLoop {
  kind: WorkerLoop["kind"];
  terms: number;
  bodyCost: number;
  runs: number;
}

export interface SpanNode {
  /** Unique among siblings; a path of keys identifies a node. */
  key: string;
  kind: SpanNodeKind;
  part?: ShaderPart;
  /** The expression the node is part of. */
  origin: Origin;
  /** Statement LaTeX, and where the node is in it. */
  input?: string;
  start?: number;
  end?: number;
  self: Stats;
  total: Stats;
  /** Sums, products and list operations that start at this node. */
  loops: NodeLoop[];
  lists: ListInfo[];
  children: SpanNode[];
}

const emptyStats = (): Stats => ({
  cost: {},
  slots: {},
  chars: 0,
  loopSteps: 0,
});

function addStats(into: Stats, from: Stats) {
  for (const [k, v] of Object.entries(from.cost) as [CostCategory, number][])
    into.cost[k] = (into.cost[k] ?? 0) + v;
  for (const [k, v] of Object.entries(from.slots) as [SlotKind, number][])
    into.slots[k] = (into.slots[k] ?? 0) + v;
  into.chars += from.chars;
  into.loopSteps += from.loopSteps;
}

const sum = (r: Partial<Record<string, number>>) =>
  Object.values(r).reduce((a: number, b) => a + (b ?? 0), 0);

export function metricValue(stats: Stats, metric: Metric): number {
  switch (metric) {
    case "cost":
      return sum(stats.cost);
    case "uniforms":
      return sum(stats.slots);
    case "glsl":
      return stats.chars;
    case "loops":
      return stats.loopSteps;
  }
}

/** The LaTeX of a node, if it is part of an expression. */
export function nodeLatex(node: SpanNode): string | undefined {
  if (node.input === undefined) return undefined;
  return node.input.slice(node.start, node.end);
}

export function newNode(
  key: string,
  kind: SpanNodeKind,
  origin: Origin,
  extra: Partial<SpanNode> = {}
): SpanNode {
  return {
    key,
    kind,
    origin,
    self: emptyStats(),
    total: emptyStats(),
    loops: [],
    lists: [],
    children: [],
    ...extra,
  };
}

const LIST_DECL = /^(\w+)\[(\d+)\] _C(\d+)=buildList\(/;
const ASSIGN = /^_(\d+)=/;
const LOOP = /^for\(_(\d+)=/;

/** The list `_Cn` each uniform is in, by uniform index. */
export function listOfUniforms(shader: InspectedShader) {
  const listOf: (number | undefined)[] = [];
  for (const line of shader.source.split("\n")) {
    const m = LIST_DECL.exec(line);
    if (!m) continue;
    const k = Number(m[3]);
    for (const u of line.matchAll(/_DCG_SC_(\d+)/g)) listOf[Number(u[1])] = k;
  }
  return listOf;
}

/**
 * The frame each non-blank line of GLSL comes from: the frame of the
 * instruction or list it assigns. Declarations and the return belong to the
 * shader's own expression (-1); other lines continue the line before.
 */
export function lineFrames(shader: InspectedShader) {
  const info = shader.dsmInfo;
  const lines = shader.source.split("\n").filter((l) => l.trim() !== "");
  let previous = -1;
  return lines.map((text) => {
    let m: RegExpExecArray | null;
    let frame = previous;
    if ((m = LIST_DECL.exec(text))) frame = info?.lists[Number(m[3])] ?? -1;
    else if ((m = ASSIGN.exec(text) ?? LOOP.exec(text)))
      frame = info?.instructions[Number(m[1])] ?? -1;
    else if (text.startsWith("return ") || /^(float|vec\d|bool) _/.test(text))
      frame = -1;
    previous = frame;
    return { text, frame };
  });
}

/** Add one shader's parts to the tree under `partNode`. */
export function addShader(
  partNode: SpanNode,
  shader: InspectedShader,
  owner: string,
  resolve: ResolveSource,
  /** Slots this shader actually gets; the rest are baked. */
  fits: number,
  /** Whether the literals in its lists would have been uniforms. */
  full: boolean
) {
  const info: ShaderSourceInfo | undefined = shader.dsmInfo;
  const byFrame = new Map<number, SpanNode>();
  const originOfSource = (s: number) => {
    const latex = info?.sources[s];
    return latex === undefined ? owner : resolve(latex);
  };
  const untraced = () => {
    let n = partNode.children.find((c) => c.kind === "untraced");
    if (!n) partNode.children.push((n = newNode("?", "untraced", undefined)));
    return n;
  };
  const nodeOf = (f: number): SpanNode => {
    if (f < 0 || !info?.frames[f]) return f === -1 ? partNode : untraced();
    const known = byFrame.get(f);
    if (known) return known;
    const [s, start, end, parent] = info.frames[f];
    const parentNode = nodeOf(parent);
    const origin = originOfSource(s);
    const key = `${origin ?? info.sources[s]}:${start}-${end}`;
    let node = parentNode.children.find((c) => c.key === key);
    if (!node) {
      node = newNode(key, "frame", origin, {
        part: partNode.part,
        input: info.sources[s],
        start,
        end,
      });
      parentNode.children.push(node);
    }
    byFrame.set(f, node);
    return node;
  };
  const add = (n: SpanNode, f: (s: Stats) => void) => f(n.self);

  // Cost.
  for (const [f, category, cost] of info?.cost ?? [])
    if (cost > 0)
      add(nodeOf(f), (s) => {
        s.cost[category] = (s.cost[category] ?? 0) + cost;
      });

  // Uniforms.
  const { lists } = analyzeShader(shader);
  const listOf = listOfUniforms(shader);
  const slot = (f: number, kind: SlotKind, n = 1) =>
    add(nodeOf(f), (s) => {
      s.slots[kind] = (s.slots[kind] ?? 0) + n;
    });
  shader.shaderUniforms.forEach((_, i) => {
    const k = listOf[i];
    const f =
      k !== undefined ? (info?.lists[k] ?? -1) : (info?.uniforms[i] ?? -1);
    slot(f, i >= fits ? "baked" : k !== undefined ? "list" : "single");
  });
  lists.forEach((l, k) => {
    const f = info?.lists[k] ?? -1;
    nodeOf(f).lists.push(l);
    if (full && l.literals > 0) slot(f, "baked", l.literals);
  });

  // GLSL, a line at a time, counting the newline.
  for (const { text, frame } of lineFrames(shader))
    add(nodeOf(frame), (s) => {
      s.chars += text.length + 1;
    });

  // Loops.
  const walk = (ls: WorkerLoop[], outer: number) => {
    for (const l of ls) {
      const runs = outer * l.terms;
      const n = nodeOf(l.source);
      n.self.loopSteps += runs;
      n.loops.push({
        kind: l.kind,
        terms: l.terms,
        bodyCost: l.bodyCost,
        runs,
      });
      walk(l.children, runs);
    }
  };
  walk(info?.loops ?? [], 1);
}

const isEmpty = (s: Stats) =>
  sum(s.cost) === 0 && sum(s.slots) === 0 && s.chars === 0 && s.loopSteps === 0;

/**
 * A part of an expression that adds nothing itself and only holds one other
 * part of the same expression (`c=hsv(…)` holding `hsv(…)`) says nothing on
 * its own: it takes over what's in that part, keeping its own, wider LaTeX.
 * Parts holding another expression stay, as that's where it is used.
 */
function collapse(node: SpanNode) {
  for (;;) {
    const [only] = node.children;
    if (
      node.kind !== "frame" ||
      node.children.length !== 1 ||
      only.kind !== "frame" ||
      only.input !== node.input ||
      !isEmpty(node.self) ||
      node.loops.length > 0 ||
      node.lists.length > 0
    )
      break;
    node.self = only.self;
    node.children = only.children;
    node.loops = only.loops;
    node.lists = only.lists;
  }
}

/** Fill in `total` and sort children, biggest cost first. */
export function finishTree(node: SpanNode): Stats {
  collapse(node);
  node.total = emptyStats();
  addStats(node.total, node.self);
  for (const c of node.children) addStats(node.total, finishTree(c));
  node.children.sort(
    (a, b) =>
      (a.start ?? 0) - (b.start ?? 0) ||
      metricValue(b.total, "cost") - metricValue(a.total, "cost")
  );
  return node.total;
}

/** The nodes from `root` along `keys`, stopping where a key isn't found. */
export function resolvePath(root: SpanNode, keys: string[]): SpanNode[] {
  const chain = [root];
  let node = root;
  for (const k of keys) {
    const next = node.children.find((c) => c.key === k);
    if (!next) break;
    chain.push(next);
    node = next;
  }
  return chain;
}

/** The biggest entry of a breakdown, if any is above 0. */
export function dominant<K extends string>(
  r: Partial<Record<K, number>>
): K | undefined {
  let best: K | undefined;
  let bestValue = 0;
  for (const [k, v] of Object.entries(r) as [K, number][])
    if (v > bestValue) {
      best = k;
      bestValue = v;
    }
  return best;
}

/**
 * What a part of an expression adds to the shader, as the expression's own
 * LaTeX shows it: its own stats plus everything inlined from other
 * expressions under it, which don't appear in this LaTeX.
 */
export function localStats(node: SpanNode): Stats {
  const s = emptyStats();
  addStats(s, node.self);
  for (const c of node.children)
    if (c.input !== node.input) addStats(s, c.total);
  return s;
}
