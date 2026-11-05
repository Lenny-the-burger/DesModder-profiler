/**
 * Payloads shared between the worker-side profiler and the main-thread
 * aggregator. Everything here must be structured-clonable, since it travels
 * from the worker to the main thread inside Desmos's own messages
 * (`timingData` for change sets, `lastRenderInfo` for 3D frames).
 */

/** Flags sent from the main thread to the worker with every worker message. */
export interface ProfilerFlags {
  enabled: boolean;
  /** Use GPU timer queries for 3D draws (only if the extension exists). */
  gpu: boolean;
  /** Break expressions down into their parse nodes while compiling. */
  nodes: boolean;
}

/**
 * `id` and `fn` are inlined definitions; `node` is a piece of an expression
 * (a parse node), whose `symbol` is its source LaTeX.
 */
export type SymbolKind = "id" | "fn" | "node";

/**
 * One node of a merged call tree: the cost of compiling a source symbol (a
 * global identifier or a user function) at one position in the nesting of
 * inlined definitions. Because Desmos inlines definitions at the use site,
 * this is how the cost of a definition (including "wackscope" definitions,
 * which only work inside some binding scope) gets attributed back to it.
 *
 * Calls at the same path are merged, so the tree stays bounded by the number
 * of distinct nesting paths rather than the number of compiles.
 */
export interface CallNode {
  kind: SymbolKind;
  symbol: string;
  /** Number of times the definition was compiled (inlined) at this path. */
  count: number;
  /** References at this path resolved from an already-compiled scope entry. */
  hits: number;
  /** Time including children, in ms. */
  time: number;
  /** Keyed by `${kind}:${symbol}`. */
  children?: Record<string, CallNode>;
}

export type CallTree = Record<string, CallNode>;

export interface StatementStat {
  /** Time parsing the statement's LaTeX, before analysis. */
  parse: number;
  /**
   * Time in `analyzeSingleStatement` (compiling, including constant folding),
   * plus compiling click handlers and parametric domains afterwards.
   */
  analysis: number;
  analysisCount: number;
  /** Time computing graph data (sampling, meshing, GLSL generation). */
  graph: number;
  graphCount: number;
  /** `evaluationState.defined_name` if the statement defines a symbol. */
  definedName?: string;
  /** Desmos's own error state for this statement (`evaluationState.error`). */
  isError?: boolean;
  /** Definitions inlined while compiling (analysis), as a call tree. */
  compileCalls: CallTree;
  /** Definitions inlined while computing graph data, as a call tree. */
  graphCalls: CallTree;
}

/** One change set processed by the worker. */
export interface ChangeSetProfile {
  statements: Record<string, StatementStat>;
}

/** Per-expression cost during one 3D frame. */
export interface ObjectFrameStat {
  draws: number;
  /** CPU time spent issuing draw calls, in ms. */
  cpuDraw: number;
  /** GPU time from timer queries that resolved during this frame, in ms. */
  gpu: number;
  gpuSamples: number;
  /** three.js program lookup/creation on draw, in ms. Includes `block`. */
  setProgram: number;
  /** Time blocked waiting for the driver (compile status, info logs), in ms. */
  block: number;
  /** Number of programs linked. */
  links: number;
}

export interface FrameProfile {
  objects: Record<string, ObjectFrameStat>;
  /** Whether GPU timer queries are available on this context. */
  gpuTimer: boolean;
}

/** The id used for 3D work not attributable to any expression (axes, passes). */
export const UNATTRIBUTED = "(unattributed)";
