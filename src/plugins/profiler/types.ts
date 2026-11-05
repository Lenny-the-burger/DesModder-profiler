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
}

export type SymbolKind = "id" | "fn";

/**
 * Cost of compiling one source symbol (a global identifier or a user function)
 * while compiling some statement. Because Desmos inlines definitions at the
 * use site, this is how the cost of a definition (including "wackscope"
 * definitions, which only work inside some binding scope) gets attributed
 * back to it.
 */
export interface SymbolStat {
  kind: SymbolKind;
  symbol: string;
  /** Number of times the definition was compiled (inlined). */
  compiles: number;
  /** Number of references resolved from an already-compiled scope entry. */
  hits: number;
  /** Time including nested symbols, in ms. */
  inclusive: number;
  /** Time excluding nested symbols, in ms. */
  self: number;
}

export interface StatementStat {
  /** Time in `analyzeSingleStatement` (compiling, including constant folding). */
  analysis: number;
  analysisCount: number;
  /** Time computing graph data (sampling, meshing, GLSL generation). */
  graph: number;
  graphCount: number;
  /** `evaluationState.defined_name` if the statement defines a symbol. */
  definedName?: string;
  /** Desmos's own error state for this statement (`evaluationState.error`). */
  isError?: boolean;
  /** Keyed by `${kind}:${symbol}`. */
  symbols: Record<string, SymbolStat>;
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
