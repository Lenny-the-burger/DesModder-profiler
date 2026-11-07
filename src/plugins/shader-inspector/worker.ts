/**
 * Worker side of the shader inspector, hooked in by
 * `shader-inspector.replacements`.
 *
 * Every compiler instruction is tagged with the part of an expression it came
 * from: the parse node being compiled when it was created, as a frame holding
 * the node's place in its statement's LaTeX and the frame it was compiled
 * inside. Parse nodes compile their children, so frames nest like the parse
 * tree, and a definition inlined into another expression nests under the
 * place that uses it. Instructions made outside any parse node (later
 * transforms) inherit the tag of their first tagged argument.
 *
 * When a 3D shader is emitted, the frames of the values it puts in uniforms
 * and lists, of each instruction, and of the cost estimate are attached to
 * the shader as `dsmInfo`, which reaches the main thread with the shader.
 */

/** A parse node: where it is in its statement, and what it was compiled in. */
export interface Frame {
  /** Statement LaTeX, as a parse node's input span holds it. */
  input: string;
  start: number;
  end: number;
  parent: Frame | undefined;
}

type Source = Frame;

interface Instruction {
  type: number;
  args?: number[];
  callData?: { type?: string };
  mobility?: number;
  value?: unknown;
  symbol?: string;
  dsmSrc?: Source;
}

interface Chunk {
  instructions: Instruction[];
  getInstruction: (i: number) => Instruction | undefined;
}

interface Emitter {
  chunk: Chunk;
  __dsmSrc?: Source;
}

interface ParseNode {
  getInputSpan?: () =>
    | { input?: unknown; start?: unknown; end?: unknown }
    | undefined;
}

export type LoopKind = "sum" | "product" | "list";

/**
 * What an instruction's cost estimate is for, following Desmos's table of
 * costs: free (0), cheap (1), costly (5), heavy (more than 5, matrices),
 * reduction (5 per element of a list), list (1 per element written out), and
 * never (can't be in a shader).
 */
export type CostCategory =
  | "free"
  | "cheap"
  | "costly"
  | "heavy"
  | "reduction"
  | "list"
  | "never";

export const COST_CATEGORIES: CostCategory[] = [
  "never",
  "reduction",
  "list",
  "heavy",
  "costly",
  "cheap",
  "free",
];

/** Native functions whose cost scales with the length of a list. */
const REDUCTIONS = new Set([
  "mean",
  "total",
  "var",
  "varp",
  "stdev",
  "stdevp",
  "mad",
  "listMin",
  "listMax",
  "median",
  "argmin",
  "argmax",
  "gcd",
  "lcm",
  "sortPerm",
  "complexSortPerm",
  "elementsAt",
  "cov",
  "covp",
  "corr",
  "matrixTotal",
]);

const NATIVE_FUNCTION = 37;
const LIST = 38;

export function costCategory(
  instr: Instruction | undefined,
  cost: number
): CostCategory {
  if (!isFinite(cost)) return "never";
  if (instr?.type === LIST) return "list";
  if (instr?.type === NATIVE_FUNCTION && REDUCTIONS.has(instr.symbol ?? ""))
    return "reduction";
  if (cost <= 0) return "free";
  if (cost <= 1) return "cheap";
  if (cost <= 5) return "costly";
  return "heavy";
}

export interface WorkerLoop {
  kind: LoopKind;
  terms: number;
  /** Index into `frames`, or -1. */
  source: number;
  /** Cost of one run of the body. */
  bodyCost: number;
  children: WorkerLoop[];
}

/** Attached to each 3D shader as `dsmInfo`. */
export interface ShaderSourceInfo {
  /** LaTeX of each statement that contributed. */
  sources: string[];
  /**
   * Each part of an expression that contributed, as
   * [source, start, end, parent frame (-1 for none)]. Parents come first.
   */
  frames: [number, number, number, number][];
  /** Frame of each uniform, by uniform index (-1 if unknown). */
  uniforms: number[];
  /** Frame of each list constant `_Cn`, by n. */
  lists: number[];
  /** Frame of each instruction, by instruction index. */
  instructions: number[];
  /** Cost estimate contributed by each frame, as [frame, category, cost]. */
  cost: [number, CostCategory, number][];
  loops: WorkerLoop[];
}

interface EmitterRecord {
  uniforms: (Source | undefined)[];
  lists: (Source | undefined)[];
}

interface CostCollection {
  chunk: Chunk;
  bySource: Map<Source | undefined, Map<CostCategory, number>>;
  roots: WorkerLoop[];
  stack: { loop: WorkerLoop; multiplier: number }[];
}

/** Instructions to look through for where a folded value came from. */
const MAX_FOLD_SEARCH = 64;

function isChangeable(instr: Instruction | undefined) {
  return instr?.type === 1 && (instr.mobility ?? 0) > 0;
}

/** What a fold is about to push a constant for. */
export interface Fold {
  /** Source of the popped instruction. */
  own: Source | undefined;
  /** Changeable constants it was computed from, nearest first. */
  inputs: Instruction[];
}

export function foldOf(chunk: Chunk, last: Instruction): Fold {
  const inputs: Instruction[] = [];
  const seen = new Set<number>();
  const queue = [...(last.args ?? [])];
  while (queue.length > 0 && seen.size < MAX_FOLD_SEARCH) {
    const a = queue.shift()!;
    if (seen.has(a)) continue;
    seen.add(a);
    const instr = chunk.instructions[a];
    if (!instr) continue;
    if (isChangeable(instr)) {
      if (instr.dsmSrc !== undefined) inputs.push(instr);
      continue;
    }
    queue.push(...(instr.args ?? []));
  }
  return { own: last.dsmSrc, inputs };
}

const isNumbers = (v: unknown): v is number[] =>
  Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "number");
const isPoints = (v: unknown): v is unknown[] =>
  Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "object");

/**
 * The expression a folded constant belongs to. Usually the one the folded
 * instruction came from, but a list of numbers taken out of a list of points
 * of the same length (one coordinate of each, so it can go in a shader) is
 * still the point list.
 */
export function foldSource(fold: Fold, value: unknown): Source | undefined {
  if (isNumbers(value)) {
    const points = fold.inputs.find(
      (i) => isPoints(i.value) && i.value.length === value.length
    );
    if (points) return points.dsmSrc;
  }
  return fold.own;
}

export function createShaderTagger() {
  let current: Frame | undefined;
  /** Source of the instruction being copied, if any. */
  let copySource: Source | undefined;
  /** The fold about to push a constant, if any. */
  let folded: Fold | undefined;
  const records = new WeakMap<Emitter, EmitterRecord>();
  const loopSources = new WeakMap<WorkerLoop, Source | undefined>();
  let costs: CostCollection | undefined;
  let lastCost: CostCollection | undefined;
  /** The shader emitted last, which a cost limit error rejects. */
  let lastShader: unknown;

  function record(emitter: Emitter) {
    let r = records.get(emitter);
    if (!r) records.set(emitter, (r = { uniforms: [], lists: [] }));
    return r;
  }

  function frameOf(node: ParseNode): Frame | undefined {
    const span = node?.getInputSpan?.();
    const input = span?.input;
    if (typeof input !== "string" || input === "") return undefined;
    const start = typeof span?.start === "number" ? span.start : 0;
    const end = typeof span?.end === "number" ? span.end : input.length;
    return { input, start, end, parent: current };
  }

  return {
    /** Compiling a parse node starts. Returns what to pass to `exit`. */
    enter(node: ParseNode) {
      const prev = current;
      current = frameOf(node) ?? current;
      return prev;
    },
    exit(prev: Frame | undefined) {
      current = prev;
    },

    /** The compiler starts copying an instruction. */
    copying(instr: Instruction) {
      const prev = copySource;
      copySource = instr?.dsmSrc ?? copySource;
      return prev;
    },
    copied(prev: Source | undefined) {
      copySource = prev;
    },

    /** The last instruction is popped, usually to fold it to a constant. */
    popped(chunk: Chunk) {
      const last = chunk.instructions[chunk.instructions.length - 1];
      if (!last) return;
      folded = foldOf(chunk, last);
    },

    /** An instruction is pushed onto a chunk. */
    tag(chunk: Chunk, instr: Instruction) {
      const fold = folded;
      folded = undefined;
      if (!instr || instr.dsmSrc !== undefined) return;
      const src =
        (instr.type === 1 && fold
          ? foldSource(fold, instr.value)
          : undefined) ??
        copySource ??
        current;
      if (src !== undefined) {
        instr.dsmSrc = src;
        return;
      }
      for (const a of instr.args ?? []) {
        const src = chunk.instructions[a]?.dsmSrc;
        if (src !== undefined) {
          instr.dsmSrc = src;
          return;
        }
      }
    },

    /** The GLSL emitter prints a constant instruction. */
    constant(emitter: Emitter, instr: Instruction) {
      emitter.__dsmSrc = instr?.dsmSrc;
    },
    uniform(emitter: Emitter) {
      record(emitter).uniforms.push(emitter.__dsmSrc);
    },
    list(emitter: Emitter) {
      record(emitter).lists.push(emitter.__dsmSrc);
    },

    /** Run Desmos's cost estimate of the emitter's chunk, recording it. */
    cost(emitter: Emitter, estimate: () => number) {
      const outer = costs;
      costs = {
        chunk: emitter.chunk,
        bySource: new Map(),
        roots: [],
        stack: [],
      };
      try {
        return estimate();
      } finally {
        lastCost = costs;
        costs = outer;
      }
    },
    /** Cost of one instruction outside a block. */
    leaf(chunk: Chunk, index: number, cost: number) {
      const c = costs;
      if (!c || c.chunk !== chunk) return cost;
      const top = c.stack[c.stack.length - 1];
      const instr = chunk.getInstruction(index);
      const src = instr?.dsmSrc;
      let byCategory = c.bySource.get(src);
      if (!byCategory) c.bySource.set(src, (byCategory = new Map()));
      const category = costCategory(instr, cost);
      byCategory.set(
        category,
        (byCategory.get(category) ?? 0) + cost * (top?.multiplier ?? 1)
      );
      return cost;
    },
    /** The body of a loop or broadcast, run `terms` times. */
    loop(chunk: Chunk, instr: Instruction, terms: number, body: () => number) {
      const c = costs;
      if (!c || c.chunk !== chunk) return body();
      const loop: WorkerLoop = {
        kind:
          instr.type === 19
            ? instr.callData?.type === "product"
              ? "product"
              : "sum"
            : "list",
        terms,
        source: -1,
        bodyCost: 0,
        children: [],
      };
      loopSources.set(loop, instr.dsmSrc);
      const top = c.stack[c.stack.length - 1];
      (top ? top.loop.children : c.roots).push(loop);
      c.stack.push({ loop, multiplier: (top?.multiplier ?? 1) * terms });
      try {
        loop.bodyCost = body();
        return loop.bodyCost;
      } finally {
        c.stack.pop();
      }
    },

    /** A shader is finished. */
    finished<T>(shader: T): T {
      lastShader = shader;
      return shader;
    },
    /**
     * Desmos makes a cost limit error for the shader it just emitted. Keep the
     * shader on the error, so the inspector can show why it costs so much.
     */
    rejected<T extends object>(message: T): T {
      if (lastShader !== undefined)
        (message as T & { dsmShader?: unknown }).dsmShader = lastShader;
      lastShader = undefined;
      return message;
    },

    /** What to attach to the finished shader. */
    report(emitter: Emitter): ShaderSourceInfo | undefined {
      const { chunk } = emitter;
      if (!chunk) return undefined;
      const sources: string[] = [];
      const sourceIds = new Map<string, number>();
      const frames: ShaderSourceInfo["frames"] = [];
      const frameIds = new Map<Frame, number>();
      const id = (f: Frame | undefined): number => {
        if (f === undefined) return -1;
        const known = frameIds.get(f);
        if (known !== undefined) return known;
        const parent = id(f.parent);
        let s = sourceIds.get(f.input);
        if (s === undefined)
          sourceIds.set(f.input, (s = sources.push(f.input) - 1));
        const n = frames.push([s, f.start, f.end, parent]) - 1;
        frameIds.set(f, n);
        return n;
      };
      const r = record(emitter);
      const cost = lastCost?.chunk === chunk ? lastCost : undefined;
      const loops = (ls: WorkerLoop[]): WorkerLoop[] =>
        ls.map((l) => ({
          ...l,
          source: id(loopSources.get(l)),
          children: loops(l.children),
        }));
      const costs: ShaderSourceInfo["cost"] = [];
      for (const [s, byCategory] of cost?.bySource ?? [])
        for (const [category, c] of byCategory)
          costs.push([id(s), category, c]);
      return {
        sources,
        frames,
        uniforms: r.uniforms.map(id),
        lists: r.lists.map(id),
        instructions: chunk.instructions.map((i) => id(i?.dsmSrc)),
        cost: costs,
        loops: cost ? loops(cost.roots) : [],
      };
    },
  };
}

export type ShaderTagger = ReturnType<typeof createShaderTagger>;
