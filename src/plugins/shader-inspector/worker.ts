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
  mobility?: number;
  value?: unknown;
  symbol?: string;
  /** Loops: the index variable. */
  callData?: { type?: string; indexSymbol?: string };
  /** Broadcasts: what they broadcast over. */
  context?: { type?: string; callData?: { inputListSymbols?: string[] } };
  /** Blocks: where they end. */
  endIndex?: number;
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

/** Names of operations, by opcode. Native functions go by their name. */
const OP_NAMES: Partial<Record<number, string>> = {
  8: "+",
  9: "-",
  10: "*",
  11: "/",
  12: "^",
  13: "^",
  14: "-x",
  56: "x^2",
  25: "=",
  26: "<",
  27: ">",
  28: "<=",
  29: ">=",
  31: "or",
  32: "and",
  33: "piecewise",
  38: "list",
  39: "L[i]",
  40: "L[i]",
  41: "L[i]",
  15: "point",
  16: "point.x",
};

/** What an instruction does, as the inspector lists it. */
export function opName(instr: Instruction | undefined): string {
  if (!instr) return "?";
  if (instr.type === NATIVE_FUNCTION) return `${instr.symbol ?? "?"}()`;
  return OP_NAMES[instr.type] ?? `op ${instr.type}`;
}

/** A variable's LaTeX as plain text: `p_{rojRes}` reads `projRes`. */
const plainName = (latex: string) =>
  latex.replace(/_\{([^{}]*)\}/g, "$1").replace(/[\\_{}]/g, "");

const IDENTIFIER =
  /^(?:\[a-zA-Z]+|[a-zA-Z])(?:_\{[a-zA-Z0-9]+\}|_[a-zA-Z0-9])?$/;
/** Frames to climb looking for a list's name. */
const MAX_NAME_DEPTH = 4;
/** Values a list with no name is shown by. */
const PREVIEW_VALUES = 3;

/**
 * The name of the list a frame is part of: the variable it is, or the one it
 * is the definition of.
 */
export function listName(frame: Frame | undefined): string | undefined {
  for (let f = frame, i = 0; f && i < MAX_NAME_DEPTH; f = f.parent, i++) {
    const text = f.input.slice(f.start, f.end).trim();
    if (IDENTIFIER.test(text)) return plainName(text);
    const def = /^(.*?)=/.exec(f.input);
    const lhs = def?.[1].trim();
    // Only the list's own frame: the statement around a use of it is some
    // other expression's definition.
    if (
      i === 0 &&
      lhs !== undefined &&
      IDENTIFIER.test(lhs) &&
      (f.start === 0 || f.start === def![0].length)
    )
      return plainName(lhs);
  }
  return undefined;
}

const previewNumber = (v: unknown) =>
  typeof v === "number"
    ? String(Math.round(v * 1000) / 1000)
    : typeof v === "object" &&
        v !== null &&
        typeof (v as { n?: unknown }).n === "number" &&
        typeof (v as { d?: unknown }).d === "number"
      ? String(
          Math.round(((v as { n: number }).n / (v as { d: number }).d) * 1000) /
            1000
        )
      : undefined;

/** A list with no name, by its first few values: `[0, 1, 2, ...]`. */
export function listPreview(
  instr: Instruction | undefined
): string | undefined {
  if (instr?.type !== 1 || !Array.isArray(instr.value)) return undefined;
  const values = instr.value.slice(0, PREVIEW_VALUES).map(previewNumber);
  if (values.length === 0 || values.some((v) => v === undefined))
    return undefined;
  const more = instr.value.length > PREVIEW_VALUES ? ", ..." : "";
  return `[${values.join(", ")}${more}]`;
}

const LIST_ACCESS = new Set([39, 40, 41]);

/**
 * What a loop runs over, as it reads in the expression: the variable of a sum,
 * product or list comprehension, or the lists a broadcast goes through.
 */
export function loopSymbols(
  instr: Instruction,
  chunk?: Chunk,
  index?: number
): string[] {
  const raw =
    instr.type === 19
      ? [instr.callData?.indexSymbol]
      : instr.context?.type === "list-comprehension"
        ? (instr.context.callData?.inputListSymbols ?? [])
        : [];
  const names = raw
    .filter((s): s is string => typeof s === "string" && !s.startsWith("_"))
    .map(plainName);
  if (names.length > 0 || instr.type !== 23 || !chunk || index === undefined)
    return names;
  // A broadcast reads each list it goes through at its index.
  const end = instr.endIndex ?? -1;
  const lists = new Set<string>();
  for (let i = index + 1; i < end; i++) {
    const access = chunk.getInstruction(i);
    if (!access || !LIST_ACCESS.has(access.type)) continue;
    if (access.args?.[1] !== index) continue;
    const list = chunk.getInstruction(access.args[0]);
    const name = listName(list?.dsmSrc) ?? listPreview(list);
    if (name !== undefined) lists.add(name);
  }
  return [...lists];
}

export interface WorkerLoop {
  /** Unique within its shader. */
  id: number;
  kind: LoopKind;
  terms: number;
  /** Variables it runs over; none for broadcasting a list. */
  symbols: string[];
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
  /**
   * Cost estimate contributed by each frame, split by operation and the loop
   * it runs in, as [frame, category, cost, operation, loop id (-1 for none),
   * instructions, cost of one run].
   */
  cost: CostEntry[];
  loops: WorkerLoop[];
}

export type CostEntry = [
  frame: number,
  category: CostCategory,
  cost: number,
  op: string,
  loop: number,
  count: number,
  base: number,
];

interface CostTally {
  category: CostCategory;
  op: string;
  loop: number;
  count: number;
  base: number;
  cost: number;
}

interface EmitterRecord {
  uniforms: (Source | undefined)[];
  lists: (Source | undefined)[];
}

interface CostCollection {
  chunk: Chunk;
  bySource: Map<Source | undefined, Map<string, CostTally>>;
  roots: WorkerLoop[];
  loops: number;
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
        loops: 0,
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
      let tallies = c.bySource.get(src);
      if (!tallies) c.bySource.set(src, (tallies = new Map()));
      const category = costCategory(instr, cost);
      const op = opName(instr);
      const loop = top?.loop.id ?? -1;
      const key = `${category}|${op}|${loop}`;
      let t = tallies.get(key);
      if (!t)
        tallies.set(
          key,
          (t = { category, op, loop, count: 0, base: 0, cost: 0 })
        );
      t.count++;
      t.base += cost;
      t.cost += cost * (top?.multiplier ?? 1);
      return cost;
    },
    /** The body of a loop or broadcast, run `terms` times. */
    loop(
      chunk: Chunk,
      instr: Instruction,
      terms: number,
      body: () => number,
      /** Where the loop starts. */
      index?: number
    ) {
      const c = costs;
      if (!c || c.chunk !== chunk) return body();
      const loop: WorkerLoop = {
        id: c.loops++,
        symbols: loopSymbols(instr, chunk, index),
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
      for (const [s, tallies] of cost?.bySource ?? [])
        for (const t of tallies.values())
          costs.push([
            id(s),
            t.category,
            t.cost,
            t.op,
            t.loop,
            t.count,
            t.base,
          ]);
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
