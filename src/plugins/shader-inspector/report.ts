/**
 * Turn a surface's shaders, and the per-expression details the worker attached
 * to them, into everything the inspector shows about one shader.
 */
import {
  COST_LIMIT,
  DesmosShader,
  ListInfo,
  MAX_LOOP_TERMS,
  MaterialInfo,
  MaterialShaders,
  analyzeMaterial,
  analyzeShader,
} from "./analyze";
import type { LoopKind, ShaderSourceInfo, WorkerLoop } from "./worker";

export type ShaderPart = "restriction" | "color";

export interface InspectedShader extends DesmosShader {
  dsmInfo?: ShaderSourceInfo;
  shaderFunctions?: {
    variadicFxns?: Record<string, unknown>;
    scalarFxns?: Iterable<string>;
  };
}

/**
 * Where something in a shader came from: an expression in the list, or
 * `undefined` when it couldn't be traced (Desmos's own transforms).
 */
export type Origin = string | undefined;

export interface UniformGroup {
  origin: Origin;
  part: ShaderPart;
  /** Slots it takes. */
  slots: number;
  /** Values past the budget, written into the source instead. */
  baked: number;
  /** The list it is, if it is one. */
  list?: ListInfo;
}

export interface CostShare {
  origin: Origin;
  cost: number;
}

export interface LoopRow {
  kind: LoopKind;
  origin: Origin;
  terms: number;
  /** Cost of one run of the body. */
  bodyCost: number;
  /** How many times the loop runs per pixel, counting the loops around it. */
  runs: number;
  depth: number;
}

export interface GlslLine {
  text: string;
  origin: Origin;
}

export interface PartReport {
  part: ShaderPart;
  /** The expression the shader belongs to. */
  owner: string;
  uniforms: number;
  cost: number;
  costLimit: number;
  costShares: CostShare[];
  loops: LoopRow[];
  loopSteps: number;
  lines: GlslLine[];
  chars: number;
  helpers: string[];
  /** Whether the worker sent per-expression details. */
  traced: boolean;
}

export interface ShaderReport {
  id: string;
  colorId: string | undefined;
  surfaces: number;
  programs: number;
  material: MaterialInfo;
  parts: PartReport[];
  /** Uniforms grouped by where they came from: single values first, then lists. */
  singles: UniformGroup[];
  lists: UniformGroup[];
  /** Every expression that contributes, in order of first appearance. */
  origins: Origin[];
}

/** Resolve the LaTeX the worker recorded to an expression id. */
export type ResolveSource = (latex: string) => string | undefined;

const LIST_DECL = /^(\w+)\[(\d+)\] _C(\d+)=buildList\(/;
const ASSIGN = /^_(\d+)=/;
const LOOP = /^for\(_(\d+)=/;

function originOf(
  info: ShaderSourceInfo | undefined,
  index: number | undefined,
  owner: string,
  resolve: ResolveSource
): Origin {
  if (!info || index === undefined || index < 0) return owner;
  const latex = info.sources[index];
  return latex === undefined ? owner : (resolve(latex) ?? undefined);
}

/** Attribute each line of GLSL to the expression of the code on it. */
export function attributeLines(
  shader: InspectedShader,
  owner: string,
  resolve: ResolveSource
): GlslLine[] {
  const info = shader.dsmInfo;
  const lines = shader.source.split("\n").filter((l) => l.trim() !== "");
  let previous: Origin = owner;
  return lines.map((text) => {
    let m: RegExpExecArray | null;
    let origin: Origin = previous;
    if ((m = LIST_DECL.exec(text)))
      origin = originOf(info, info?.lists[Number(m[3])], owner, resolve);
    else if ((m = ASSIGN.exec(text) ?? LOOP.exec(text)))
      origin = originOf(info, info?.instructions[Number(m[1])], owner, resolve);
    else if (text.startsWith("return ") || /^(float|vec\d|bool) _/.test(text))
      origin = owner;
    previous = origin;
    return { text, origin };
  });
}

function loopRows(
  loops: WorkerLoop[],
  info: ShaderSourceInfo,
  owner: string,
  resolve: ResolveSource,
  outerRuns = 1,
  depth = 0,
  out: LoopRow[] = []
) {
  for (const l of loops) {
    const runs = outerRuns * l.terms;
    out.push({
      kind: l.kind,
      origin: originOf(info, l.source, owner, resolve),
      terms: l.terms,
      bodyCost: l.bodyCost,
      runs,
      depth,
    });
    loopRows(l.children, info, owner, resolve, runs, depth + 1, out);
  }
  return out;
}

function helpers(shader: InspectedShader) {
  const fns = shader.shaderFunctions;
  const names = new Set<string>();
  for (const k of Object.keys(fns?.variadicFxns ?? {})) names.add(k);
  for (const k of fns?.scalarFxns ?? []) names.add(String(k));
  return [...names].sort();
}

export function partReport(
  part: ShaderPart,
  shader: InspectedShader,
  owner: string,
  resolve: ResolveSource
): PartReport {
  const info = shader.dsmInfo;
  const parsed = analyzeShader(shader);
  const shares = new Map<Origin, number>();
  for (const [src, cost] of info?.cost ?? []) {
    if (!(cost > 0)) continue;
    const o = originOf(info, src, owner, resolve);
    shares.set(o, (shares.get(o) ?? 0) + cost);
  }
  const loops = info ? loopRows(info.loops, info, owner, resolve) : [];
  const lines = attributeLines(shader, owner, resolve);
  return {
    part,
    owner,
    uniforms: shader.shaderUniforms.length,
    cost: shader.costEstimate,
    costLimit: COST_LIMIT,
    costShares: [...shares]
      .map(([origin, cost]) => ({ origin, cost }))
      .sort((a, b) => b.cost - a.cost),
    loops,
    loopSteps: info
      ? loops.reduce((n, l) => n + l.runs, 0)
      : parsed.loopIterations,
    lines,
    chars: shader.source.length,
    helpers: helpers(shader),
    traced: !!info,
  };
}

/**
 * Group a shader's uniforms by where they came from. Consecutive single
 * values from the same expression merge; each list is its own group.
 */
function uniformGroups(
  part: ShaderPart,
  shader: InspectedShader,
  owner: string,
  resolve: ResolveSource,
  /** Slots this shader actually gets; the rest are baked. */
  fits: number,
  /**
   * The shader hit its uniform limit while being compiled, so the literals in
   * its lists are values that would have been uniforms.
   */
  full: boolean
) {
  const info = shader.dsmInfo;
  const { lists } = analyzeShader(shader);
  const singles = new Map<Origin, UniformGroup>();
  const listGroups: UniformGroup[] = [];
  // Lists use their uniforms in order, before any single value printed after
  // them; walk the uniform indices in the order the source uses them.
  const listOfUniform: (number | undefined)[] = [];
  const declLines = shader.source.split("\n");
  for (const line of declLines) {
    const m = LIST_DECL.exec(line);
    if (!m) continue;
    const k = Number(m[3]);
    for (const u of line.matchAll(/_DCG_SC_(\d+)/g))
      listOfUniform[Number(u[1])] = k;
  }
  const byList = new Map<number, UniformGroup>();
  const listGroup = (k: number) => {
    let g = byList.get(k);
    if (!g) {
      g = {
        origin: originOf(info, info?.lists[k], owner, resolve),
        part,
        slots: 0,
        baked: 0,
        list: lists[k],
      };
      byList.set(k, g);
      listGroups.push(g);
    }
    return g;
  };
  shader.shaderUniforms.forEach((_, i) => {
    const k = listOfUniform[i];
    const baked = i >= fits ? 1 : 0;
    if (k !== undefined) {
      const g = listGroup(k);
      g.slots += 1 - baked;
      g.baked += baked;
      return;
    }
    const origin = originOf(info, info?.uniforms[i], owner, resolve);
    let g = singles.get(origin);
    if (!g) singles.set(origin, (g = { origin, part, slots: 0, baked: 0 }));
    g.slots += 1 - baked;
    g.baked += baked;
  });
  if (full)
    lists.forEach((l, k) => {
      if (l.literals > 0) listGroup(k).baked += l.literals;
    });
  return { singles: [...singles.values()], lists: listGroups };
}

export function shaderReport(opts: {
  id: string;
  colorId: string | undefined;
  surfaces: number;
  programs: number;
  shaders: MaterialShaders & {
    restriction?: InspectedShader;
    color?: InspectedShader;
  };
  budget: number;
  resolve: ResolveSource;
}): ShaderReport {
  const { id, colorId, shaders, budget, resolve } = opts;
  const material = analyzeMaterial(shaders, budget);
  const parts: PartReport[] = [];
  const singles: UniformGroup[] = [];
  const lists: UniformGroup[] = [];
  let used = 0;
  const entries: [ShaderPart, InspectedShader | undefined, string][] = [
    ["restriction", shaders.restriction, id],
    ["color", shaders.color, colorId ?? id],
  ];
  for (const [part, shader, owner] of entries) {
    if (!shader) continue;
    parts.push(partReport(part, shader, owner, resolve));
    const fits = Math.max(
      0,
      Math.min(shader.shaderUniforms.length, budget - used)
    );
    used += fits;
    const groups = uniformGroups(
      part,
      shader,
      owner,
      resolve,
      fits,
      shader.shaderUniforms.length >= budget
    );
    singles.push(...groups.singles);
    lists.push(...groups.lists);
  }
  const origins: Origin[] = [];
  const see = (o: Origin) => {
    if (!origins.includes(o)) origins.push(o);
  };
  for (const g of [...singles, ...lists]) see(g.origin);
  for (const p of parts) {
    for (const s of p.costShares) see(s.origin);
    for (const l of p.lines) see(l.origin);
  }
  return {
    id,
    colorId,
    surfaces: opts.surfaces,
    programs: opts.programs,
    material,
    parts,
    singles,
    lists,
    origins,
  };
}

/** What one expression contributes to a shader, for its inline panel. */
export interface OriginUsage {
  slots: number;
  baked: number;
  lists: ListInfo[];
  cost: number;
  lines: number;
  loops: LoopRow[];
}

export function usageOf(report: ShaderReport, origin: Origin): OriginUsage {
  const u: OriginUsage = {
    slots: 0,
    baked: 0,
    lists: [],
    cost: 0,
    lines: 0,
    loops: [],
  };
  for (const g of [...report.singles, ...report.lists]) {
    if (g.origin !== origin) continue;
    u.slots += g.slots;
    u.baked += g.baked;
    if (g.list) u.lists.push(g.list);
  }
  for (const p of report.parts) {
    for (const s of p.costShares) if (s.origin === origin) u.cost += s.cost;
    for (const l of p.lines) if (l.origin === origin) u.lines++;
    for (const l of p.loops) if (l.origin === origin) u.loops.push(l);
  }
  return u;
}

export { MAX_LOOP_TERMS };
