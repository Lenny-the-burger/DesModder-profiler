/**
 * Worker side of the shader inspector, hooked in by
 * `shader-inspector.replacements`.
 *
 * Every compiler instruction is tagged with the expression it came from: the
 * LaTeX of the parse node being compiled when it was created. Inlined
 * definitions compile their own parse nodes, so their instructions get their
 * own LaTeX. Instructions made outside any parse node (later transforms)
 * inherit the tag of their first tagged argument.
 *
 * When a 3D shader is emitted, the tags of the values it puts in uniforms and
 * lists, of each instruction, and of the cost estimate are attached to the
 * shader as `dsmInfo`, which reaches the main thread with the shader.
 */

/** Statement LaTeX, as a parse node's input span holds it. */
type Source = string;

interface Instruction {
  type: number;
  args?: number[];
  callData?: { type?: string };
  mobility?: number;
  value?: unknown;
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
  getInputSpan?: () => { input?: unknown } | undefined;
}

export type LoopKind = "sum" | "product" | "list";

export interface WorkerLoop {
  kind: LoopKind;
  terms: number;
  /** Index into `sources`, or -1. */
  source: number;
  /** Cost of one run of the body. */
  bodyCost: number;
  children: WorkerLoop[];
}

/** Attached to each 3D shader as `dsmInfo`. */
export interface ShaderSourceInfo {
  /** LaTeX of each expression that contributed. */
  sources: string[];
  /** Source of each uniform, by uniform index (-1 if unknown). */
  uniforms: number[];
  /** Source of each list constant `_Cn`, by n. */
  lists: number[];
  /** Source of each instruction, by instruction index. */
  instructions: number[];
  /** Cost estimate contributed by each source, as [source, cost]. */
  cost: [number, number][];
  loops: WorkerLoop[];
}

interface EmitterRecord {
  uniforms: (Source | undefined)[];
  lists: (Source | undefined)[];
}

interface CostCollection {
  chunk: Chunk;
  bySource: Map<Source | undefined, number>;
  roots: WorkerLoop[];
  stack: { loop: WorkerLoop; multiplier: number; source?: Source }[];
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
  let current: Source | undefined;
  /** Source of the instruction being copied, if any. */
  let copySource: Source | undefined;
  /** The fold about to push a constant, if any. */
  let folded: Fold | undefined;
  const records = new WeakMap<Emitter, EmitterRecord>();
  const loopSources = new WeakMap<WorkerLoop, Source | undefined>();
  let costs: CostCollection | undefined;
  let lastCost: CostCollection | undefined;

  function record(emitter: Emitter) {
    let r = records.get(emitter);
    if (!r) records.set(emitter, (r = { uniforms: [], lists: [] }));
    return r;
  }

  function sourceOf(node: ParseNode): Source | undefined {
    const input = node?.getInputSpan?.()?.input;
    return typeof input === "string" && input !== "" ? input : undefined;
  }

  return {
    /** Compiling a parse node starts. Returns what to pass to `exit`. */
    enter(node: ParseNode) {
      const prev = current;
      current = sourceOf(node) ?? current;
      return prev;
    },
    exit(prev: Source | undefined) {
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
      const src = chunk.getInstruction(index)?.dsmSrc;
      c.bySource.set(
        src,
        (c.bySource.get(src) ?? 0) + cost * (top?.multiplier ?? 1)
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

    /** What to attach to the finished shader. */
    report(emitter: Emitter): ShaderSourceInfo | undefined {
      const { chunk } = emitter;
      if (!chunk) return undefined;
      const sources: string[] = [];
      const ids = new Map<Source, number>();
      const id = (s: Source | undefined) => {
        if (s === undefined) return -1;
        let n = ids.get(s);
        if (n === undefined) ids.set(s, (n = sources.push(s) - 1));
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
      return {
        sources,
        uniforms: r.uniforms.map(id),
        lists: r.lists.map(id),
        instructions: chunk.instructions.map((i) => id(i?.dsmSrc)),
        cost: cost
          ? [...cost.bySource].map(([s, c]) => [id(s), c] as [number, number])
          : [],
        loops: cost ? loops(cost.roots) : [],
      };
    },
  };
}

export type ShaderTagger = ReturnType<typeof createShaderTagger>;
