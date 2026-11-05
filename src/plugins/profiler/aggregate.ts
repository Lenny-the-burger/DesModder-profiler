/**
 * Pure aggregation of recorded profiler payloads into tables. Kept free of
 * Desmos/DesModder imports so it can be unit tested directly.
 */
import {
  CallNode,
  CallTree,
  ChangeSetProfile,
  FrameProfile,
  SymbolKind,
} from "./types";

/** Time in the nearest nested definitions, looking through parse nodes. */
function nestedDefinitionTime(tree: CallTree | undefined): number {
  let t = 0;
  for (const c of Object.values(tree ?? {}))
    t += c.kind === "node" ? nestedDefinitionTime(c.children) : c.time;
  return t;
}

/**
 * Time spent in a definition excluding the definitions it inlines. Parse
 * nodes inside it are part of its own body, so they count as self time.
 */
export function selfTime(node: CallNode): number {
  return Math.max(0, node.time - nestedDefinitionTime(node.children));
}

export interface ChangeSetSample {
  profile: ChangeSetProfile;
  /** Desmos's own coarse timing for the same change set. */
  updateAnalysis: number;
  graphAllChanges: number;
  timeInWorker: number;
}

export interface FrameSample extends FrameProfile {
  /** Desmos's own CPU time for the whole 3D frame, if known. */
  durationCPU?: number;
}

/** 2D canvas draw time of one redraw, in ms, keyed by sketch (expression) id. */
export type Redraw = Record<string, number>;

/**
 * One frame as the user sees it: a change set processed by the worker
 * together with the redraw that follows it, or a redraw on its own (panning,
 * rotating). Indices into the recording's arrays.
 */
export interface Update {
  changeSet?: number;
  frame?: number;
  redraw?: number;
}

export interface Recording {
  changeSets: ChangeSetSample[];
  /** 3D frames. */
  frames: FrameSample[];
  /** 2D redraws. */
  redraws: Redraw[];
  /** Frames in the order they happened. */
  updates: Update[];
}

export function emptyRecording(): Recording {
  return { changeSets: [], frames: [], redraws: [], updates: [] };
}

/**
 * Add a sample to the recording's timeline. A redraw joins the frame of the
 * change set that caused it; anything else starts a new frame.
 */
export function addToTimeline(
  rec: Recording,
  kind: keyof Update,
  index: number
) {
  const last = rec.updates[rec.updates.length - 1];
  if (
    kind !== "changeSet" &&
    last?.changeSet !== undefined &&
    last.frame === undefined &&
    last.redraw === undefined
  )
    last[kind] = index;
  else rec.updates.push({ [kind]: index });
}

export interface ExpressionRow {
  id: string;
  /** Worker time parsing the expression's LaTeX. */
  parse: number;
  /** Worker compile time, including folding constants. */
  analysis: number;
  /** Worker graph-data time (sampling, meshing, GLSL generation). */
  graph: number;
  /** Main-thread 2D canvas draw time. */
  canvas: number;
  /** 3D: CPU time issuing draws. */
  cpuDraw: number;
  /** 3D: GPU time (only if timer queries are available and enabled). */
  gpu: number;
  /** 3D: three.js program setup, including blocking shader compiles. */
  setProgram: number;
  /** 3D: time blocked waiting for shader compile/link. */
  shaderBlock: number;
  /** 3D: number of programs linked (new shader programs). */
  links: number;
  draws: number;
  /** Total of the disjoint CPU columns (parse, analysis, graph, canvas, cpuDraw, setProgram). */
  total: number;
  /** Median of `total` over the frames in which this expression did any work. */
  median: number;
  /** Number of frames in which this expression did any work. */
  samples: number;
  definedName?: string;
  isError: boolean;
}

export interface SourceRow {
  kind: SymbolKind;
  symbol: string;
  /** Expression id that defines this symbol, if known. */
  definedBy?: string;
  /** Number of times the definition was compiled (inlined), across all expressions. */
  compiles: number;
  hits: number;
  /** Self time summed across all expressions that inline this symbol. */
  self: number;
  inclusive: number;
  /** Number of distinct expressions that compiled this symbol. */
  usedBy: number;
  /**
   * The defining expression errors on its own, but the definition is
   * compiled inside other expressions ("wackscope").
   */
  wackscope: boolean;
}

export interface Overhead {
  /** Analysis time not attributable to any single statement. */
  analysis: number;
  /** Graph time not attributable to any single statement. */
  graph: number;
  /** Worker time outside parsing, analysis and graph (events, labels, statuses). */
  other: number;
  /** 3D frame CPU time outside any draw call or shader setup (scene upkeep, uploads). */
  render: number;
}

/** Categories of the overview, in display order. */
export const OVERVIEW_CATEGORIES = [
  "parse",
  "compile",
  "graph",
  "draw",
  "shader",
  "other",
] as const;
export type OverviewCategory = (typeof OVERVIEW_CATEGORIES)[number];

export interface Overview {
  /** Number of frames (see `Update`). */
  frames: number;
  /** Mean CPU time per frame, across all threads, in ms. */
  average: number;
  /** Mean time per frame in each category; these sum to `average`. */
  categories: Record<OverviewCategory, number>;
}

export interface Summary {
  changeSets: number;
  frames: number;
  gpuTimer: boolean;
  expressions: ExpressionRow[];
  sources: SourceRow[];
  overhead: Overhead;
  overview: Overview;
  /** 3D work not tied to an expression (axes, post-processing, etc.). */
  unattributed3D?: ExpressionRow;
}

function emptyRow(id: string): ExpressionRow {
  return {
    id,
    parse: 0,
    analysis: 0,
    graph: 0,
    canvas: 0,
    cpuDraw: 0,
    gpu: 0,
    setProgram: 0,
    shaderBlock: 0,
    links: 0,
    draws: 0,
    total: 0,
    median: 0,
    samples: 0,
    isError: false,
  };
}

/**
 * Sum everything recorded. Totals (not means) are reported so that an
 * expensive change set is not diluted by cheap ones.
 */
export function summarize(rec: Recording, unattributedId: string): Summary {
  const rows = new Map<string, ExpressionRow>();
  const row = (id: string) => {
    let r = rows.get(id);
    if (!r) rows.set(id, (r = emptyRow(id)));
    return r;
  };

  interface SourceAcc extends Omit<SourceRow, "usedBy" | "wackscope"> {
    users: Set<string>;
  }
  const sources = new Map<string, SourceAcc>();
  const overhead: Overhead = { analysis: 0, graph: 0, other: 0, render: 0 };

  for (const cs of rec.changeSets) {
    let sumParse = 0;
    let sumAnalysis = 0;
    let sumGraph = 0;
    for (const [id, stat] of Object.entries(cs.profile.statements)) {
      const r = row(id);
      r.parse += stat.parse;
      r.analysis += stat.analysis;
      sumParse += stat.parse;
      r.graph += stat.graph;
      sumAnalysis += stat.analysis;
      sumGraph += stat.graph;
      // Error state and name come from the most recent analysis.
      if (stat.analysisCount > 0) {
        r.isError = !!stat.isError;
        r.definedName = stat.definedName;
      }
      const visit = (tree: CallTree, ancestors: Set<string>) => {
        for (const [key, node] of Object.entries(tree)) {
          // Pieces of expressions aren't definitions; look inside them.
          if (node.kind === "node") {
            if (node.children) visit(node.children, ancestors);
            continue;
          }
          let s = sources.get(key);
          if (!s) {
            s = {
              kind: node.kind,
              symbol: node.symbol,
              compiles: 0,
              hits: 0,
              self: 0,
              inclusive: 0,
              users: new Set(),
            };
            sources.set(key, s);
          }
          s.compiles += node.count;
          s.hits += node.hits;
          s.self += selfTime(node);
          // A definition nested inside itself (recursion through inlining)
          // would otherwise count the inner time twice.
          if (!ancestors.has(key)) s.inclusive += node.time;
          if (node.count > 0) s.users.add(id);
          if (node.children) {
            ancestors.add(key);
            visit(node.children, ancestors);
            ancestors.delete(key);
          }
        }
      };
      visit(stat.compileCalls, new Set());
      visit(stat.graphCalls, new Set());
    }
    overhead.analysis += Math.max(0, cs.updateAnalysis - sumAnalysis);
    overhead.graph += Math.max(0, cs.graphAllChanges - sumGraph);
    overhead.other += Math.max(
      0,
      cs.timeInWorker - cs.updateAnalysis - cs.graphAllChanges - sumParse
    );
  }

  for (const redraw of rec.redraws)
    for (const [id, ms] of Object.entries(redraw)) row(id).canvas += ms;

  let gpuTimer = false;
  for (const frame of rec.frames) {
    gpuTimer ||= frame.gpuTimer;
    overhead.render += frameRemainder(frame);
    for (const [id, o] of Object.entries(frame.objects)) {
      const r = row(id);
      r.cpuDraw += o.cpuDraw;
      r.gpu += o.gpu;
      r.setProgram += o.setProgram;
      r.shaderBlock += o.block;
      r.links += o.links;
      r.draws += o.draws;
    }
  }

  const idByName = new Map<string, string>();
  for (const r of rows.values()) {
    r.total =
      r.parse + r.analysis + r.graph + r.canvas + r.cpuDraw + r.setProgram;
    if (r.definedName !== undefined) idByName.set(r.definedName, r.id);
  }

  const sourceRows: SourceRow[] = [];
  for (const s of sources.values()) {
    // Symbols that were only ever cache hits carry no compile time.
    if (s.compiles === 0) continue;
    const definedBy = idByName.get(s.symbol);
    const definer = definedBy !== undefined ? rows.get(definedBy) : undefined;
    const usedElsewhere = [...s.users].some((u) => u !== definedBy);
    sourceRows.push({
      kind: s.kind,
      symbol: s.symbol,
      definedBy,
      compiles: s.compiles,
      hits: s.hits,
      self: s.self,
      inclusive: s.inclusive,
      usedBy: s.users.size,
      wackscope: !!definer?.isError && usedElsewhere,
    });
  }
  sourceRows.sort((a, b) => b.self - a.self);

  const overview = computeOverview(rec, unattributedId, rows);

  const unattributed3D = rows.get(unattributedId);
  rows.delete(unattributedId);
  const expressions = [...rows.values()].sort(
    (a, b) => b.median - a.median || b.total - a.total
  );

  return {
    changeSets: rec.changeSets.length,
    frames: rec.frames.length,
    gpuTimer,
    expressions,
    sources: sourceRows,
    overhead,
    overview,
    unattributed3D,
  };
}

/** CPU time of a 3D frame not spent in any draw call or shader setup. */
function frameRemainder(frame: FrameSample): number {
  if (frame.durationCPU === undefined) return 0;
  let used = 0;
  for (const o of Object.values(frame.objects))
    used += o.cpuDraw + o.setProgram;
  return Math.max(0, frame.durationCPU - used);
}

/** The recording's frames; one per sample if no timeline was kept. */
function timeline(rec: Recording): Update[] {
  if (rec.updates.length > 0) return rec.updates;
  return [
    ...rec.changeSets.map((_, changeSet) => ({ changeSet })),
    ...rec.frames.map((_, frame) => ({ frame })),
    ...rec.redraws.map((_, redraw) => ({ redraw })),
  ];
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Per-frame averages by category, and each expression's median per frame
 * (written into `rows`).
 */
function computeOverview(
  rec: Recording,
  unattributedId: string,
  rows: Map<string, ExpressionRow>
): Overview {
  const totals: Record<OverviewCategory, number> = {
    parse: 0,
    compile: 0,
    graph: 0,
    draw: 0,
    shader: 0,
    other: 0,
  };
  const perExpression = new Map<string, number[]>();
  const updates = timeline(rec);
  for (const u of updates) {
    const inFrame = new Map<string, number>();
    const add = (id: string, t: number) => {
      if (t > 0) inFrame.set(id, (inFrame.get(id) ?? 0) + t);
    };
    const cs =
      u.changeSet !== undefined ? rec.changeSets[u.changeSet] : undefined;
    if (cs) {
      let parse = 0;
      for (const [id, stat] of Object.entries(cs.profile.statements)) {
        parse += stat.parse;
        add(id, stat.parse + stat.analysis + stat.graph);
      }
      totals.parse += parse;
      totals.compile += cs.updateAnalysis;
      totals.graph += cs.graphAllChanges;
      totals.other += Math.max(
        0,
        cs.timeInWorker - cs.updateAnalysis - cs.graphAllChanges - parse
      );
    }
    const redraw = u.redraw !== undefined ? rec.redraws[u.redraw] : undefined;
    if (redraw)
      for (const [id, ms] of Object.entries(redraw)) {
        totals.draw += ms;
        add(id, ms);
      }
    const frame = u.frame !== undefined ? rec.frames[u.frame] : undefined;
    if (frame) {
      for (const [id, o] of Object.entries(frame.objects)) {
        totals.draw += o.cpuDraw;
        totals.shader += o.setProgram;
        add(id, o.cpuDraw + o.setProgram);
      }
      totals.draw += frameRemainder(frame);
    }
    for (const [id, t] of inFrame) {
      if (id === unattributedId) continue;
      let list = perExpression.get(id);
      if (!list) perExpression.set(id, (list = []));
      list.push(t);
    }
  }
  for (const [id, list] of perExpression) {
    const r = rows.get(id);
    if (!r) continue;
    r.median = median(list);
    r.samples = list.length;
  }
  const n = Math.max(1, updates.length);
  const categories = { ...totals };
  let sum = 0;
  for (const c of OVERVIEW_CATEGORIES) {
    categories[c] /= n;
    sum += categories[c];
  }
  return { frames: updates.length, average: sum, categories };
}
