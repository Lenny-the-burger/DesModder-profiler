/**
 * Worker-side profiler. Installed into the Desmos web worker through
 * `append.inline.ts`, and called from `profiler.replacements`.
 *
 * Every entry point must be cheap when disabled: the replacements are applied
 * whenever DesModder loads, regardless of whether the profiler is recording.
 */
import { mergeCallTrees } from "./calltree";
import {
  CallNode,
  CallTree,
  ChangeSetProfile,
  FrameProfile,
  ObjectFrameStat,
  ProfilerFlags,
  StatementStat,
  SymbolKind,
  UNATTRIBUTED,
} from "./types";

interface Span {
  input: string;
  start: number;
  end: number;
}

interface CompileFrame {
  start: number;
  /** Definition frames: the node, created eagerly. */
  node?: CallNode;
  /** Parse-node frames: the source span, and children collected so far. */
  span?: Span;
  children?: CallTree;
}

/**
 * Parse nodes that took less than this (and contain nothing kept) are
 * dropped, leaving their time in the parent's self time. Keeps trees small.
 */
const MIN_NODE_MS = 0.02;

interface PendingQuery {
  query: WebGLQuery;
  id: string;
}

/** Subset of EXT_disjoint_timer_query_webgl2 that we use. */
interface TimerExt {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}

const COMPLETION_STATUS_KHR = 0x91b1;

export type WorkerProfiler = ReturnType<typeof createWorkerProfiler>;

export function createWorkerProfiler(
  now: () => number = () => performance.now()
) {
  let flags: ProfilerFlags = { enabled: false, gpu: false, nodes: false };

  // ---- change set (2D and 3D evaluation) state ----
  let statements: Record<string, StatementStat> = {};
  /** Statement currently being analyzed or graphed. */
  let current: string | undefined;
  /** Root of the call tree for the current statement and phase. */
  let currentRoot: CallTree | undefined;
  let phaseStart = 0;
  /** Statement currently being parsed (outside any analysis phase). */
  let parsing: string | undefined;
  let parseStart = 0;
  const stack: CompileFrame[] = [];

  function statement(id: string) {
    return (statements[id] ??= {
      parse: 0,
      analysis: 0,
      analysisCount: 0,
      graph: 0,
      graphCount: 0,
      compileCalls: {},
      graphCalls: {},
    });
  }

  /** The node for `symbol` under the innermost open frame. */
  /** Where children of the innermost open frame go. */
  function siblings(): CallTree | undefined {
    const parent = stack[stack.length - 1];
    if (!parent) return currentRoot;
    if (parent.node) return (parent.node.children ??= {});
    return (parent.children ??= {});
  }

  function callNode(symbol: string, kind: SymbolKind): CallNode | undefined {
    if (currentRoot === undefined) return undefined;
    return (siblings()![`${kind}:${symbol}`] ??= {
      kind,
      symbol,
      count: 0,
      hits: 0,
      time: 0,
    });
  }

  function beginPhase(id: string | undefined, root?: "compile" | "graph") {
    current = id;
    currentRoot =
      id === undefined || root === undefined
        ? undefined
        : root === "compile"
          ? statement(id).compileCalls
          : statement(id).graphCalls;
    stack.length = 0;
    phaseStart = now();
  }

  function endPhase() {
    current = undefined;
    currentRoot = undefined;
    stack.length = 0;
  }

  // ---- 3D frame state ----
  let objects: Record<string, ObjectFrameStat> = {};
  let drawObject: string | undefined;
  let gpuTimer = false;
  let pending: PendingQuery[] = [];
  const timerExts = new WeakMap<object, TimerExt | null>();
  let glContext: WebGL2RenderingContext | undefined;

  function objectStat(id: string | undefined): ObjectFrameStat {
    return (objects[id ?? UNATTRIBUTED] ??= {
      draws: 0,
      cpuDraw: 0,
      gpu: 0,
      gpuSamples: 0,
      setProgram: 0,
      block: 0,
      links: 0,
    });
  }

  function timerExt(gl: WebGL2RenderingContext): TimerExt | null {
    let ext = timerExts.get(gl);
    if (ext === undefined) {
      ext = gl.getExtension(
        "EXT_disjoint_timer_query_webgl2"
      ) as TimerExt | null;
      timerExts.set(gl, ext);
    }
    return ext;
  }

  function resolveQueries() {
    const gl = glContext;
    if (!gl || pending.length === 0) return;
    const ext = timerExt(gl);
    if (!ext) return;
    const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
    const stillPending: PendingQuery[] = [];
    for (const p of pending) {
      if (!gl.getQueryParameter(p.query, gl.QUERY_RESULT_AVAILABLE)) {
        stillPending.push(p);
        continue;
      }
      if (!disjoint) {
        const stat = objectStat(p.id);
        stat.gpu += gl.getQueryParameter(p.query, gl.QUERY_RESULT) / 1e6;
        stat.gpuSamples++;
      }
      gl.deleteQuery(p.query);
    }
    pending = stillPending;
  }

  const profiler = {
    get flags() {
      return flags;
    },

    setFlags(next: ProfilerFlags | undefined) {
      const was = flags.enabled;
      flags = next ?? { enabled: false, gpu: false, nodes: false };
      if (was && !flags.enabled) {
        // Drop partial data so a later recording starts clean.
        statements = {};
        objects = {};
        endPhase();
      }
    },

    // ---- analysis / graph phases (called per statement) ----

    beginAnalysis(id: string, mode: string) {
      if (!flags.enabled) return;
      // Only the main analysis pass corresponds to the user's expressions;
      // regression passes re-analyze statements with a different frame.
      if (mode === "main") beginPhase(id, "compile");
      else beginPhase(undefined);
    },

    endAnalysis(
      id: string,
      results:
        | { stmtAnalysis?: { evaluationState?: Record<string, unknown> } }[]
        | undefined
    ) {
      if (!flags.enabled || current !== id) {
        endPhase();
        return;
      }
      const stat = statement(id);
      stat.analysis += now() - phaseStart;
      stat.analysisCount++;
      const state = results?.[0]?.stmtAnalysis?.evaluationState;
      if (state) {
        const name = state.defined_name;
        if (typeof name === "string") stat.definedName = name;
        stat.isError = state.error !== undefined;
      }
      endPhase();
    },

    /**
     * Desmos's pass after the main analysis, which compiles click handlers
     * and parametric domains one statement at a time. Counted as compile time
     * of the statement, but not as another compile.
     */
    beginPostAnalysis(id: string) {
      if (!flags.enabled) return;
      beginPhase(id, "compile");
    },

    endPostAnalysis(id: string) {
      if (!flags.enabled || current !== id) {
        endPhase();
        return;
      }
      statement(id).analysis += now() - phaseStart;
      endPhase();
    },

    // ---- parsing (called per statement, before analysis) ----

    beginParse(id: string) {
      if (!flags.enabled) return;
      parsing = id;
      parseStart = now();
    },

    endParse(id: string) {
      if (!flags.enabled || parsing !== id) return;
      statement(id).parse += now() - parseStart;
      parsing = undefined;
    },

    beginGraph(id: string) {
      if (!flags.enabled) return;
      beginPhase(id, "graph");
    },

    endGraph(id: string) {
      if (!flags.enabled || current !== id) {
        endPhase();
        return;
      }
      const stat = statement(id);
      stat.graph += now() - phaseStart;
      stat.graphCount++;
      endPhase();
    },

    // ---- compiler provenance (called per inlined definition) ----

    enter(symbol: string, kind: SymbolKind): CompileFrame | undefined {
      if (!flags.enabled) return undefined;
      const node = callNode(symbol, kind);
      if (!node) return undefined;
      const frame = { node, start: now() };
      stack.push(frame);
      return frame;
    },

    exit(frame: CompileFrame | undefined) {
      if (!frame) return;
      // Normally `frame` is on top. If an exception skipped some exits,
      // discard the frames above it so the stack stays consistent.
      const index = stack.lastIndexOf(frame);
      if (index === -1) return;
      stack.length = index;
      const elapsed = now() - frame.start;
      if (frame.node) {
        frame.node.count++;
        frame.node.time += elapsed;
        return;
      }
      const { span } = frame;
      if (!span || (elapsed < MIN_NODE_MS && !frame.children)) return;
      const target = siblings();
      if (!target) return;
      const node = (target[`node:${span.start}:${span.end}`] ??= {
        kind: "node",
        symbol: span.input.slice(span.start, span.end),
        count: 0,
        hits: 0,
        time: 0,
      });
      node.count++;
      node.time += elapsed;
      if (frame.children)
        mergeCallTrees((node.children ??= {}), frame.children);
    },

    /** Called around compiling each parse node (from `Ze`). */
    enterNode(parseNode: {
      getInputSpan?: () => Span | undefined;
    }): CompileFrame | undefined {
      if (!flags.enabled || !flags.nodes || currentRoot === undefined)
        return undefined;
      const span = parseNode?.getInputSpan?.();
      if (!span) return undefined;
      // Skip wrappers that cover exactly the same source as their parent.
      const top = stack[stack.length - 1];
      if (
        top?.span &&
        top.span.input === span.input &&
        top.span.start === span.start &&
        top.span.end === span.end
      )
        return undefined;
      const frame: CompileFrame = { span, start: now() };
      stack.push(frame);
      return frame;
    },

    hit(symbol: string) {
      if (!flags.enabled) return;
      const node = callNode(symbol, "id");
      if (node) node.hits++;
    },

    drainChangeSet(): ChangeSetProfile | undefined {
      if (!flags.enabled) return undefined;
      const out = { statements };
      statements = {};
      return out;
    },

    // ---- 3D rendering ----

    /** Tag a surface's mesh with its expression id (from `finalizeSurface`). */
    tagSurface(arg: { branchId?: unknown; surface?: { mesh?: unknown } }) {
      const mesh = arg?.surface?.mesh as { dsmId?: string } | undefined;
      if (!mesh || typeof arg.branchId !== "string") return;
      // branchId is either `${id}` or `${id}:${branchIndex}`
      mesh.dsmId = arg.branchId.replace(/:\d+$/, "");
    },

    setDrawObject(object: { dsmId?: string } | null | undefined) {
      drawObject = object?.dsmId;
    },

    timeSetProgram<T>(fn: () => T): T {
      if (!flags.enabled) return fn();
      const start = now();
      try {
        return fn();
      } finally {
        objectStat(drawObject).setProgram += now() - start;
      }
    },

    drainFrame(): FrameProfile | undefined {
      if (!flags.enabled) return undefined;
      resolveQueries();
      const out = { objects, gpuTimer };
      objects = {};
      return out;
    },

    /**
     * Wrap WebGL entry points so we can time draws, link counts, and blocking
     * waits on the driver. The wrappers check `flags.enabled` first, so this is
     * safe to install once and leave installed.
     */
    installWebGL(proto: WebGL2RenderingContext | undefined) {
      if (!proto || (proto as any).dsmProfilerInstalled) return;
      (proto as any).dsmProfilerInstalled = true;
      const wrap = (
        name: string,
        after: (
          gl: WebGL2RenderingContext,
          elapsed: number,
          args: any[]
        ) => void
      ) => {
        const original = (proto as any)[name];
        if (typeof original !== "function") return;
        (proto as any)[name] = function (
          this: WebGL2RenderingContext,
          ...args: any[]
        ) {
          if (!flags.enabled) return original.apply(this, args);
          const start = now();
          try {
            return original.apply(this, args);
          } finally {
            after(this, now() - start, args);
          }
        };
      };
      wrap("linkProgram", () => {
        objectStat(drawObject).links++;
      });
      wrap("getProgramParameter", (_gl, elapsed, args) => {
        // Polling COMPLETION_STATUS_KHR does not block; everything else
        // (LINK_STATUS etc.) waits for the driver to finish compiling.
        if (args[1] !== COMPLETION_STATUS_KHR)
          objectStat(drawObject).block += elapsed;
      });
      for (const name of [
        "getShaderParameter",
        "getShaderInfoLog",
        "getProgramInfoLog",
      ])
        wrap(name, (_gl, elapsed) => {
          objectStat(drawObject).block += elapsed;
        });

      for (const name of [
        "drawArrays",
        "drawElements",
        "drawArraysInstanced",
        "drawElementsInstanced",
      ]) {
        const original = (proto as any)[name];
        if (typeof original !== "function") continue;
        (proto as any)[name] = function (
          this: WebGL2RenderingContext,
          ...args: any[]
        ) {
          if (!flags.enabled) return original.apply(this, args);
          // eslint-disable-next-line @typescript-eslint/no-this-alias -- keep the context to resolve queries later
          glContext = this;
          const ext = flags.gpu ? timerExt(this) : null;
          gpuTimer = !!timerExt(this);
          const id = drawObject ?? UNATTRIBUTED;
          let query: WebGLQuery | null = null;
          if (ext) {
            query = this.createQuery();
            if (query) this.beginQuery(ext.TIME_ELAPSED_EXT, query);
          }
          const start = now();
          try {
            return original.apply(this, args);
          } finally {
            const stat = objectStat(id);
            stat.cpuDraw += now() - start;
            stat.draws++;
            if (ext && query) {
              this.endQuery(ext.TIME_ELAPSED_EXT);
              pending.push({ query, id });
            }
          }
        };
      }
    },

    /**
     * Read profiler flags from every message the main thread sends the worker.
     * Desmos's handler is `self.onmessage`, so wrap it to update flags first.
     */
    installMessageHook(scope: {
      onmessage: ((ev: { data?: any }) => any) | null;
    }) {
      const original = scope.onmessage;
      if (!original) return;
      scope.onmessage = function (this: unknown, ev: { data?: any }) {
        const data = ev?.data;
        if (data && typeof data === "object" && "dsmProfiler" in data)
          profiler.setFlags(data.dsmProfiler);
        return original.call(this, ev);
      };
    },
  };
  return profiler;
}
