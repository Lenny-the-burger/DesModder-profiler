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
  shaderUniforms: unknown[];
  maxUniforms: number;
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
const BROADCAST_RESULT = 48;
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
};

const TUPLE = 15;
const SLOT = 16;

/** LaTeX operators by how they read, loosest binding first. */
const SUMS: [RegExp, string][] = [
  [/^\+/, "a+b"],
  [/^-/, "a-b"],
];
const PRODUCTS: [RegExp, string][] = [
  [/^\\cdot(?![a-zA-Z])/, "a·b"],
  [/^\\times(?![a-zA-Z])/, "a×b"],
];

/**
 * The operator a piece of LaTeX applies last, as written: `a\cdot b` is `a·b`
 * and `\left|v\right|` is `|a|`.
 */
export function rootOperator(latex: string): string | undefined {
  const s = latex.trim();
  let depth = 0;
  let sum: string | undefined;
  let product: string | undefined;
  /** Whether the outermost group closes before the end. */
  let closedEarly = false;
  for (let i = 0; i < s.length; i++) {
    const rest = s.slice(i);
    const bracket = /^(?:\\(left|right)(?![a-zA-Z])\s*(?:\\.|.)|([{}]))/.exec(
      rest
    );
    if (bracket) {
      depth += bracket[1] === "left" || bracket[2] === "{" ? 1 : -1;
      if (depth === 0 && i + bracket[0].length < s.length) closedEarly = true;
      i += bracket[0].length - 1;
      continue;
    }
    if (depth !== 0) continue;
    // A sign at the start, or after another operator, isn't a sum.
    const before = s.slice(0, i).trimEnd();
    const binary = before !== "" && !/[+\-=,(]$|\\cdot$|\\times$/.test(before);
    for (const [re, name] of SUMS) if (binary && re.test(rest)) sum = name;
    for (const [re, name] of PRODUCTS) if (re.test(rest)) product = name;
  }
  if (sum ?? product) return sum ?? product;
  if (!closedEarly && s.startsWith("\\left|")) return "|a|";
  return undefined;
}

/**
 * What an instruction does, as the inspector lists it. Desmos works on points
 * one coordinate at a time, so reading or making a point is named after the
 * operation written in its source, like `x/y/z for a·b`.
 */
export function opName(instr: Instruction | undefined, frame?: Frame): string {
  if (!instr) return "?";
  if (instr.type === NATIVE_FUNCTION) return `${instr.symbol ?? "?"}()`;
  if (instr.type === SLOT || instr.type === TUPLE) {
    const what = instr.type === SLOT ? "x/y/z" : "make point";
    const op = frame && rootOperator(frame.input.slice(frame.start, frame.end));
    return op
      ? `${what} for ${op}`
      : instr.type === SLOT
        ? "x/y/z of point"
        : what;
  }
  return OP_NAMES[instr.type] ?? `op ${instr.type}`;
}

/** A variable's LaTeX as plain text: `p_{rojRes}` reads `projRes`. */
const plainName = (latex: string) =>
  latex.replace(/_\{([^{}]*)\}/g, "$1").replace(/[\\_{}]/g, "");

const IDENTIFIER =
  /^(?:\[a-zA-Z]+|[a-zA-Z])(?:_\{[a-zA-Z0-9]+\}|_[a-zA-Z0-9])?$/;
/** Frames to climb looking for a list's name. */
const MAX_NAME_DEPTH = 8;
/** Values a list with no name is shown by. */
const PREVIEW_VALUES = 3;

/**
 * The name of the list a frame holds: the variable it is, or the one whose
 * whole definition it is. A function's whole body gives what the call to it
 * gives, so the name is where it is called.
 */
export function listName(frame: Frame | undefined): string | undefined {
  for (let f = frame, i = 0; f && i < MAX_NAME_DEPTH; f = f.parent, i++) {
    const text = f.input.slice(f.start, f.end).trim();
    if (IDENTIFIER.test(text)) return plainName(text);
    const def = /^(.*?)=/.exec(f.input);
    if (!def) return undefined;
    // Only the whole definition: a part of one is something else.
    const whole =
      f.input.slice(f.end).trim() === "" &&
      (f.start === 0 || f.input.slice(def[0].length, f.start).trim() === "");
    if (!whole) return undefined;
    const lhs = def[1].trim();
    if (IDENTIFIER.test(lhs)) return plainName(lhs);
    if (!lhs.includes("(")) return undefined;
  }
  return undefined;
}

const toNumber = (v: unknown): number | undefined =>
  typeof v === "number"
    ? v
    : typeof v === "object" &&
        v !== null &&
        typeof (v as { n?: unknown }).n === "number" &&
        typeof (v as { d?: unknown }).d === "number"
      ? (v as { n: number }).n / (v as { d: number }).d
      : undefined;

/** The numbers in a constant list, if it is one. */
export function listValues(
  instr: Instruction | undefined
): number[] | undefined {
  if (instr?.type !== 1 || !Array.isArray(instr.value)) return undefined;
  const values = instr.value.map(toNumber);
  if (values.length === 0 || values.some((v) => v === undefined))
    return undefined;
  return values as number[];
}

/** A list with no name, by its first few values: `[0, 1, 2, ...]`. */
export function previewValues(values: number[]) {
  const shown = values
    .slice(0, PREVIEW_VALUES)
    .map((v) => String(Math.round(v * 1000) / 1000));
  const more = values.length > PREVIEW_VALUES ? ", ..." : "";
  return `[${shown.join(", ")}${more}]`;
}

const LIST_ACCESS = new Set([39, 40, 41]);

export const sameValues = (a: number[], b: number[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/** What to call a list with no name: by default, its first few values. */
export type NameValues = (values: number[]) => string;

/**
 * Stands in for a list with no name, so the main thread can name it after a
 * variable with the same values.
 */
export const LIST_TOKEN = "\u0000list:";

/**
 * What a loop runs over, as it reads in the expression: the variable of a sum,
 * product or list comprehension, or the lists a broadcast goes through.
 */
export function loopSymbols(
  instr: Instruction,
  chunk?: Chunk,
  index?: number,
  nameValues: NameValues = previewValues
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
    for (const name of listLabels(chunk, access.args[0], nameValues))
      lists.add(name);
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
  /**
   * Changing values written into the source because the shader had no slots
   * left: the frame of each single value, and how many of each list's.
   */
  baked?: { singles: number[]; lists: number[] };
  /** Frame of each instruction, by instruction index. */
  instructions: number[];
  /**
   * Cost estimate contributed by each frame, split by operation and the loop
   * it runs in, as [frame, category, cost, operation, loop id (-1 for none),
   * instructions, cost of one run].
   */
  cost: CostEntry[];
  loops: WorkerLoop[];
  /** Values of each list `LIST_TOKEN` + index stands for. */
  listValues?: number[][];
}

/**
 * What a list in a chunk reads as: its variable, what the broadcast it comes
 * from runs over, or its first few values.
 */
export function listLabels(
  chunk: Chunk,
  index: number,
  nameValues: NameValues = previewValues
): string[] {
  const list = chunk.getInstruction(index);
  if (list?.type === BROADCAST_RESULT) {
    // The result of a broadcast goes by what the broadcast runs over.
    const end = list.args?.[0];
    const start =
      end === undefined ? undefined : chunk.getInstruction(end)?.args?.[0];
    const broadcast =
      start === undefined ? undefined : chunk.getInstruction(start);
    if (start !== undefined && broadcast?.type === 23) {
      const over = loopSymbols(broadcast, chunk, start, nameValues);
      if (over.length > 0) return over;
    }
  }
  const name = listName(list?.dsmSrc);
  if (name !== undefined) return [name];
  const values = listValues(list);
  return values ? [nameValues(values)] : [];
}

/** What a reduction costs per element, and which argument is its list. */
const REDUCTION_COST: Partial<Record<string, { each: number; arg: number }>> = {
  matrixTotal: { each: 16, arg: 0 },
  elementsAt: { each: 5, arg: 1 },
};

/** The list a reduction goes through, as a loop of its elements. */
export function reductionElements(
  chunk: Chunk,
  instr: Instruction | undefined,
  cost: number,
  nameValues: NameValues = previewValues
): Elements | undefined {
  if (instr?.type !== NATIVE_FUNCTION || !REDUCTIONS.has(instr.symbol ?? ""))
    return undefined;
  const { each, arg } = REDUCTION_COST[instr.symbol ?? ""] ?? {
    each: 5,
    arg: 0,
  };
  const terms = cost / each;
  if (!(terms > 0) || !isFinite(terms)) return undefined;
  const list = instr.args?.[arg];
  const symbols = list === undefined ? [] : listLabels(chunk, list, nameValues);
  return { terms, symbols };
}

/** The elements of a list an operation goes through. */
export interface Elements {
  terms: number;
  symbols: string[];
}

export type CostEntry = [
  frame: number,
  category: CostCategory,
  cost: number,
  op: string,
  loop: number,
  count: number,
  base: number,
  /** For list reductions: the list's elements, each costing the same. */
  elements?: Elements,
];

interface CostTally {
  category: CostCategory;
  op: string;
  loop: number;
  elements: Elements | undefined;
  count: number;
  base: number;
  cost: number;
}

interface EmitterRecord {
  uniforms: (Source | undefined)[];
  lists: (Source | undefined)[];
  /** Values written in because the shader had no slots left, by source. */
  bakedSingles: (Source | undefined)[];
  /** How many of each list's values were written in that way. */
  bakedLists: number[];
  /** Written-in values not yet known to be single values or in a list. */
  pending: (Source | undefined)[];
}

interface CostCollection {
  chunk: Chunk;
  bySource: Map<Source | undefined, Map<string, CostTally>>;
  roots: WorkerLoop[];
  loops: number;
  stack: { loop: WorkerLoop; multiplier: number }[];
  /** Values of the lists with no name, which `LIST_TOKEN` + index stand for. */
  listValues: number[][];
  nameValues: NameValues;
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
    if (!r)
      records.set(
        emitter,
        (r = {
          uniforms: [],
          lists: [],
          bakedSingles: [],
          bakedLists: [],
          pending: [],
        })
      );
    return r;
  }

  /** Written-in values before the next constant were single values. */
  function flushPending(r: EmitterRecord) {
    r.bakedSingles.push(...r.pending);
    r.pending = [];
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
      flushPending(record(emitter));
      emitter.__dsmSrc = instr?.dsmSrc;
    },
    uniform(emitter: Emitter) {
      record(emitter).uniforms.push(emitter.__dsmSrc);
    },
    /**
     * The emitter prints a number as a uniform or as a literal. A changing
     * one (mobility above Cold) is a literal only because the shader has no
     * slots left.
     */
    printed(emitter: Emitter, mobility: number) {
      if (mobility > 0 && emitter.shaderUniforms.length >= emitter.maxUniforms)
        record(emitter).pending.push(emitter.__dsmSrc);
    },
    list(emitter: Emitter) {
      // A list prints its values, then itself.
      const r = record(emitter);
      r.lists.push(emitter.__dsmSrc);
      r.bakedLists[r.lists.length - 1] = r.pending.length;
      r.pending = [];
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
        listValues: [],
        nameValues: (values) => {
          const c = costs!;
          let i = c.listValues.findIndex((v) => sameValues(v, values));
          if (i < 0) i = c.listValues.push(values) - 1;
          return `${LIST_TOKEN}${i}`;
        },
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
      const op = opName(instr, src);
      const loop = top?.loop.id ?? -1;
      const elements = reductionElements(chunk, instr, cost, c.nameValues);
      const key = `${category}|${op}|${loop}|${elements ? `${elements.terms}:${elements.symbols.join(",")}` : ""}`;
      let t = tallies.get(key);
      if (!t)
        tallies.set(
          key,
          (t = { category, op, loop, elements, count: 0, base: 0, cost: 0 })
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
        symbols: loopSymbols(instr, chunk, index, c.nameValues),
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
      flushPending(r);
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
            ...(t.elements ? [t.elements] : []),
          ] as CostEntry);
      return {
        sources,
        frames,
        uniforms: r.uniforms.map(id),
        lists: r.lists.map(id),
        baked: {
          singles: r.bakedSingles.map(id),
          lists: r.lists.map((_, k) => r.bakedLists[k] ?? 0),
        },
        instructions: chunk.instructions.map((i) => id(i?.dsmSrc)),
        cost: costs,
        loops: cost ? loops(cost.roots) : [],
        listValues: cost?.listValues ?? [],
      };
    },
  };
}

export type ShaderTagger = ReturnType<typeof createShaderTagger>;
