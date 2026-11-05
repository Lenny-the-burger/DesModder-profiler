/**
 * Pure aggregation of recorded profiler payloads into tables. Kept free of
 * Desmos/DesModder imports so it can be unit tested directly.
 */
import { ChangeSetProfile, FrameProfile, SymbolKind } from "./types";

export interface ChangeSetSample {
  profile: ChangeSetProfile;
  /** Desmos's own coarse timing for the same change set. */
  updateAnalysis: number;
  graphAllChanges: number;
  timeInWorker: number;
}

export interface SketchTiming {
  ms: number;
  count: number;
}

export interface Recording {
  changeSets: ChangeSetSample[];
  frames: FrameProfile[];
  /** 2D canvas draw time, keyed by sketch (expression) id. */
  sketches: Record<string, SketchTiming>;
}

export function emptyRecording(): Recording {
  return { changeSets: [], frames: [], sketches: {} };
}

export interface ExpressionRow {
  id: string;
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
  /** Total of the disjoint CPU columns (analysis, graph, canvas, cpuDraw, setProgram). */
  total: number;
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
  /** Worker time outside analysis and graph (events, labels, intersections). */
  other: number;
}

export interface Summary {
  changeSets: number;
  frames: number;
  gpuTimer: boolean;
  expressions: ExpressionRow[];
  sources: SourceRow[];
  overhead: Overhead;
  /** 3D work not tied to an expression (axes, post-processing, etc.). */
  unattributed3D?: ExpressionRow;
}

function emptyRow(id: string): ExpressionRow {
  return {
    id,
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
  const overhead: Overhead = { analysis: 0, graph: 0, other: 0 };

  for (const cs of rec.changeSets) {
    let sumAnalysis = 0;
    let sumGraph = 0;
    for (const [id, stat] of Object.entries(cs.profile.statements)) {
      const r = row(id);
      r.analysis += stat.analysis;
      r.graph += stat.graph;
      sumAnalysis += stat.analysis;
      sumGraph += stat.graph;
      // Error state and name come from the most recent analysis.
      if (stat.analysisCount > 0) {
        r.isError = !!stat.isError;
        r.definedName = stat.definedName;
      }
      for (const [key, sym] of Object.entries(stat.symbols)) {
        let s = sources.get(key);
        if (!s) {
          s = {
            kind: sym.kind,
            symbol: sym.symbol,
            compiles: 0,
            hits: 0,
            self: 0,
            inclusive: 0,
            users: new Set(),
          };
          sources.set(key, s);
        }
        s.compiles += sym.compiles;
        s.hits += sym.hits;
        s.self += sym.self;
        s.inclusive += sym.inclusive;
        if (sym.compiles > 0) s.users.add(id);
      }
    }
    overhead.analysis += Math.max(0, cs.updateAnalysis - sumAnalysis);
    overhead.graph += Math.max(0, cs.graphAllChanges - sumGraph);
    overhead.other += Math.max(
      0,
      cs.timeInWorker - cs.updateAnalysis - cs.graphAllChanges
    );
  }

  for (const [id, t] of Object.entries(rec.sketches)) row(id).canvas += t.ms;

  let gpuTimer = false;
  for (const frame of rec.frames) {
    gpuTimer ||= frame.gpuTimer;
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
    r.total = r.analysis + r.graph + r.canvas + r.cpuDraw + r.setProgram;
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

  const unattributed3D = rows.get(unattributedId);
  rows.delete(unattributedId);
  const expressions = [...rows.values()].sort((a, b) => b.total - a.total);

  return {
    changeSets: rec.changeSets.length,
    frames: rec.frames.length,
    gpuTimer,
    expressions,
    sources: sourceRows,
    overhead,
    unattributed3D,
  };
}
