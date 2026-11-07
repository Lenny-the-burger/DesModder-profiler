/**
 * Reading Desmos's 3D shaders: how many uniform slots they use, what is baked
 * into their source, how much their loops run, and why a shader had to be
 * recompiled.
 *
 * The facts this relies on, from Desmos's compiler and 3D renderer:
 *
 * - Values that can change without editing (sliders, assignments) become
 *   `uniform float _DCG_SC_n`, one slot per number. A list uses one slot per
 *   number in it (a point takes 3). Numbers typed directly into an expression
 *   are written into the source instead.
 * - A surface's restriction and color function share one budget of
 *   `maxFragmentUniformComponents - 85` slots, restriction first.
 *   `maxFragmentUniformComponents` is `min(512, MAX_FRAGMENT_UNIFORM_COMPONENTS)`,
 *   so the budget is at most 427.
 * - Values past the budget are written into the source as numbers. Changing
 *   them changes the source, which needs a new shader program.
 * - Programs are cached by source. Anything else that changes the source
 *   (a piecewise condition that only depends on sliders flipping, a list
 *   changing length, an edit) also needs a new program.
 */

export interface DesmosShader {
  source: string;
  shaderUniforms: number[];
  costEstimate: number;
  dependencies?: string[];
}

/** Uniform slots the surface material reserves for itself. */
export const SURFACE_RESERVED_UNIFORMS = 85;
/** Desmos never uses more than this many fragment uniform components. */
export const MAX_FRAGMENT_UNIFORM_COMPONENTS = 512;
export const COST_LIMIT = 10000;
export const MAX_LOOP_TERMS = 1000;
export const MAX_LIST_LENGTH = 100;

export function surfaceBudget(maxFragmentUniformComponents: number) {
  return Math.max(0, maxFragmentUniformComponents - SURFACE_RESERVED_UNIFORMS);
}

export interface ListInfo {
  /** GLSL element type, such as `float` or `vec3`. */
  type: string;
  length: number;
  /** Uniform slots it uses. */
  uniforms: number;
  /** Numbers written into the source instead of using a slot. */
  literals: number;
}

export interface LoopInfo {
  /** Times the loop body runs, if the bounds could be read. */
  terms: number | undefined;
  children: LoopInfo[];
}

export interface ShaderInfo {
  uniforms: number;
  cost: number;
  lists: ListInfo[];
  /** Top-level loops (sums and products), with the loops nested inside. */
  loops: LoopInfo[];
  /** Loop iterations per pixel, counting every nested loop. */
  loopIterations: number;
}

const NUMBER = /^-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i;
const UNIFORM = /^_DCG_SC_(\d+)$/;

/** The value of a loop bound as GLSL prints it: a number or a uniform. */
function boundValue(text: string, uniforms: number[]): number | undefined {
  const t = text
    .trim()
    .replace(/^\((.*)\)$/, "$1")
    .trim();
  if (NUMBER.test(t)) return parseFloat(t);
  const m = UNIFORM.exec(t);
  if (m) return uniforms[Number(m[1])];
  return undefined;
}

/** How many times `for(i=lo;i<=hi;i++)` runs. */
export function loopTerms(lo: number | undefined, hi: number | undefined) {
  if (lo === undefined || hi === undefined) return undefined;
  if (!isFinite(lo) || !isFinite(hi)) return undefined;
  return Math.max(0, Math.floor(hi - lo) + 1);
}

const LOOP_HEADER = /for\((\w+)=([^;]*);\1<=([^;]*);\1\+\+\)\s*\{/y;

function parseLoops(source: string, uniforms: number[]): LoopInfo[] {
  const roots: LoopInfo[] = [];
  const open: { loop: LoopInfo; depth: number }[] = [];
  let depth = 0;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "f") {
      LOOP_HEADER.lastIndex = i;
      const m = LOOP_HEADER.exec(source);
      if (m) {
        const loop: LoopInfo = {
          terms: loopTerms(
            boundValue(m[2], uniforms),
            boundValue(m[3], uniforms)
          ),
          children: [],
        };
        (open.length ? open[open.length - 1].loop.children : roots).push(loop);
        depth++;
        open.push({ loop, depth });
        i = LOOP_HEADER.lastIndex - 1;
        continue;
      }
    }
    if (c === "{") depth++;
    else if (c === "}") {
      if (open.length && open[open.length - 1].depth === depth) open.pop();
      depth--;
    }
  }
  return roots;
}

/** Loop iterations per pixel, counting each nested loop's runs. */
export function iterations(loops: LoopInfo[], outer = 1): number {
  let total = 0;
  for (const loop of loops) {
    if (loop.terms === undefined) return NaN;
    const runs = outer * loop.terms;
    total += runs + iterations(loop.children, runs);
  }
  return total;
}

/** A loop nest as text, like "100 × 100" or "10 × (5 + 3)". */
export function formatLoops(loops: LoopInfo[]): string {
  return loops.map(formatLoop).join(" + ");
}

function formatLoop(loop: LoopInfo): string {
  const terms = loop.terms === undefined ? "?" : String(loop.terms);
  if (loop.children.length === 0) return terms;
  const inner = formatLoops(loop.children);
  return loop.children.length > 1
    ? `${terms} × (${inner})`
    : `${terms} × ${inner}`;
}

const LIST_DECL = /(\w+)\[(\d+)\] _C\d+=buildList\(/g;

function parseLists(source: string): ListInfo[] {
  const lists: ListInfo[] = [];
  LIST_DECL.lastIndex = 0;
  let m;
  while ((m = LIST_DECL.exec(source))) {
    // The arguments run to the matching close paren.
    let depth = 1;
    let j = LIST_DECL.lastIndex;
    for (; j < source.length && depth > 0; j++) {
      if (source[j] === "(") depth++;
      else if (source[j] === ")") depth--;
    }
    const args = source.slice(LIST_DECL.lastIndex, j - 1);
    lists.push({
      type: m[1],
      length: Number(m[2]),
      uniforms: (args.match(/_DCG_SC_\d+/g) ?? []).length,
      literals: (args.match(/(^|[(,])-?\d/g) ?? []).length,
    });
    LIST_DECL.lastIndex = j;
  }
  return lists;
}

export function analyzeShader(shader: DesmosShader): ShaderInfo {
  const loops = parseLoops(shader.source, shader.shaderUniforms);
  return {
    uniforms: shader.shaderUniforms.length,
    cost: shader.costEstimate,
    lists: parseLists(shader.source),
    loops,
    loopIterations: iterations(loops),
  };
}

export interface MaterialShaders {
  restriction?: DesmosShader;
  color?: DesmosShader;
}

export interface MaterialInfo {
  /** Slots the restriction and color function ask for together. */
  uniforms: number;
  budget: number;
  /**
   * Values written into the source because the shared budget ran out, after
   * each shader got its own slots. Changing any of these recompiles.
   */
  overflow: number;
  /**
   * A shader used the whole budget on its own, so more of its values were
   * already written into its source and can't be counted.
   */
  full: boolean;
  /** Identifies the shader program: equal keys share one program. */
  key: string;
}

/**
 * Combine a surface's restriction and color function the way the renderer
 * does: the restriction takes its slots first, the color function gets what
 * is left, and the rest are written in as numbers.
 */
export function analyzeMaterial(
  shaders: MaterialShaders,
  budget: number
): MaterialInfo {
  const parts = [shaders.restriction, shaders.color];
  let used = 0;
  let uniforms = 0;
  let overflow = 0;
  let full = false;
  const key: string[] = [];
  for (const s of parts) {
    if (!s) {
      key.push("");
      continue;
    }
    const n = s.shaderUniforms.length;
    const fits = Math.min(n, budget - used);
    used += fits;
    uniforms += n;
    overflow += n - fits;
    if (n >= budget) full = true;
    key.push(s.source, s.shaderUniforms.slice(fits).join(","));
  }
  return { uniforms, budget, overflow, full, key: key.join("\u0000") };
}

export type RecompileReason =
  /** Numbers written into the source changed, because it ran out of slots. */
  | "baked"
  /** A number typed into an expression changed. */
  | "constant"
  /** A list in the shader changed length. */
  | "list-length"
  /** The shader's structure changed: an edit, or a piecewise branch flipping. */
  | "structure";

export const RECOMPILE_REASONS: readonly RecompileReason[] = [
  "baked",
  "list-length",
  "structure",
  "constant",
];

const NUMBERS = /-?\b\d+\.?\d*(e[-+]?\d+)?\b/gi;

function listSignature(source: string) {
  return parseLists(source)
    .map((l) => `${l.type}[${l.length}]`)
    .join(",");
}

function shaderChange(
  before: DesmosShader | undefined,
  after: DesmosShader | undefined,
  budget: number
): RecompileReason | undefined {
  if (!before && !after) return undefined;
  if (!before || !after) return "structure";
  if (before.source === after.source) return undefined;
  if (listSignature(before.source) !== listSignature(after.source))
    return "list-length";
  const skeleton = (s: string) => s.replace(NUMBERS, "#");
  if (skeleton(before.source) !== skeleton(after.source)) return "structure";
  return after.shaderUniforms.length >= budget ? "baked" : "constant";
}

/** Why a surface's shader program changed between two updates. */
export function recompileReason(
  before: MaterialShaders,
  after: MaterialShaders,
  budget: number
): RecompileReason | undefined {
  const a = analyzeMaterial(before, budget);
  const b = analyzeMaterial(after, budget);
  if (a.key === b.key) return undefined;
  const reasons = [
    shaderChange(before.restriction, after.restriction, budget),
    shaderChange(before.color, after.color, budget),
  ];
  for (const r of RECOMPILE_REASONS) if (reasons.includes(r)) return r;
  // Only values past the shared budget changed.
  return "baked";
}
