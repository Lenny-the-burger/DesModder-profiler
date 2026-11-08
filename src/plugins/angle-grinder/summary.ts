/** Numbers the angle grinder shows about a graph's shaders. */
import type { Measurement, ShaderStat } from "./lab";

/** Uniform slots a surface's restriction and color function share. */
export const UNIFORM_BUDGET = 427;

/** Shader cost Desmos allows before it gives up on a shader. */
export const COST_LIMIT = 10000;

export interface Totals {
  shaders: number;
  uniforms: number;
  /** Shaders that ask for more uniform slots than there are. */
  atLimit: number;
  /** Shaders Desmos rejects as too complicated. */
  overCost: number;
  maxCost: number;
}

export function totals(m: Measurement): Totals {
  return {
    shaders: m.shaders.length,
    uniforms: m.shaders.reduce((n, s) => n + s.uniforms, 0),
    atLimit: m.shaders.filter((s) => s.uniforms > UNIFORM_BUDGET).length,
    overCost: m.shaders.filter((s) => s.cost > COST_LIMIT).length,
    maxCost: Math.max(0, ...m.shaders.map((s) => s.cost)),
  };
}

export interface ShaderChange {
  /** Expression the shader comes from. */
  id: string;
  part: "color" | "restriction";
  before: ShaderStat | undefined;
  after: ShaderStat | undefined;
}

/**
 * One row per expression and part. A list of surfaces has a restriction
 * shader per surface; the one using the most slots stands for them all.
 */
export function shaderChanges(
  before: Measurement,
  after: Measurement
): ShaderChange[] {
  const rows = new Map<string, ShaderChange>();
  const add = (s: ShaderStat, which: "before" | "after") => {
    const [part, id] = s.key.split(":") as ["color" | "restriction", string];
    const key = `${part}:${id}`;
    let row = rows.get(key);
    if (!row)
      rows.set(key, (row = { id, part, before: undefined, after: undefined }));
    const cur = row[which];
    if (!cur || s.uniforms > cur.uniforms) row[which] = s;
  };
  for (const s of before.shaders) add(s, "before");
  for (const s of after.shaders) add(s, "after");
  return [...rows.values()].sort(
    (a, b) =>
      (b.before?.uniforms ?? 0) - (a.before?.uniforms ?? 0) ||
      (b.after?.uniforms ?? 0) - (a.after?.uniforms ?? 0)
  );
}
