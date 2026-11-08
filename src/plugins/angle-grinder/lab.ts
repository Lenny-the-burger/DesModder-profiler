/**
 * An offscreen 3D calculator for evaluating values and measuring the shaders
 * a graph compiles to, without touching the graph on screen.
 */
import type { GraphState } from "../../../graph-state";
import type { Value } from "./rewrite";

interface Helper {
  numericValue?: number;
  listValue?: number[];
  unobserveAll: () => void;
}

interface Shader {
  source: string;
  shaderUniforms: number[];
  costEstimate: number;
}

interface LabCalc {
  setState: (state: GraphState) => void;
  getState: () => GraphState;
  HelperExpression: (e: { latex: string }) => Helper;
  destroy: () => void;
  expressionAnalysis: Record<
    string,
    { isError?: boolean; errorMessage?: string } | undefined
  >;
  controller: {
    getAllShaders: () => Record<string, Shader | undefined>;
    grapher3d?: {
      graphSketches?: Record<
        string,
        { branches?: { restrictionShader?: Shader }[] } | undefined
      >;
    };
  };
}

export interface ShaderStat {
  /** `color:<expression id>` or `restriction:<expression id>:<branch>` */
  key: string;
  uniforms: number;
  cost: number;
}

export interface Measurement {
  shaders: ShaderStat[];
  /** Error message of each expression that has one, by id. */
  errors: Map<string, string>;
}

const sleep = async (ms: number) =>
  await new Promise((resolve) => setTimeout(resolve, ms));

/** `state` with no slider playing and the ticker stopped. */
export function stopped(state: GraphState): GraphState {
  const copy: GraphState = JSON.parse(JSON.stringify(state));
  for (const item of copy.expressions.list)
    if (item.type === "expression" && item.slider?.isPlaying)
      item.slider.isPlaying = false;
  if (copy.expressions.ticker) copy.expressions.ticker.playing = false;
  return copy;
}

/** Sliders that are playing in `state`. */
export function playingSliders(state: GraphState) {
  return new Set(
    state.expressions.list
      .filter((e) => e.type === "expression" && e.slider?.isPlaying)
      .map((e) => e.id)
  );
}

export class Lab {
  private constructor(
    private readonly calc: LabCalc,
    private readonly el: HTMLElement
  ) {}

  static create(): Lab {
    const el = document.createElement("div");
    el.style.cssText =
      "position:fixed;left:-10000px;top:0;width:400px;height:300px;visibility:hidden";
    document.body.appendChild(el);
    const { Desmos } = window as unknown as {
      Desmos: { Calculator3D: (el: HTMLElement, opts: object) => LabCalc };
    };
    return new Lab(Desmos.Calculator3D(el, {}), el);
  }

  destroy() {
    this.calc.destroy();
    this.el.remove();
  }

  /**
   * Load `state` with every slider and the ticker stopped, so values are
   * read at the moment `state` was taken, and wait for Desmos to evaluate
   * and compile it.
   */
  async load(state: GraphState, timeout = 180000) {
    this.calc.setState(stopped(state));
    await this.settle(timeout);
  }

  /**
   * Wait until the evaluator has answered a helper created now, which comes
   * after everything already queued.
   */
  async settle(timeout = 180000) {
    const h = this.calc.HelperExpression({ latex: "1" });
    await this.waitFor([h], timeout);
    h.unobserveAll();
    // The 3D grapher picks up the new sketches on the next frames.
    await sleep(300);
  }

  private async waitFor(helpers: Helper[], timeout: number) {
    const start = performance.now();
    while (helpers.some((h) => h.numericValue === undefined)) {
      if (performance.now() - start > timeout)
        throw new Error("Timed out waiting for the calculator to evaluate");
      await sleep(50);
    }
  }

  async evaluate(latexes: string[], timeout = 180000): Promise<Helper[]> {
    const helpers = latexes.map((latex) =>
      this.calc.HelperExpression({ latex })
    );
    await this.waitFor(helpers, timeout);
    for (const h of helpers) h.unobserveAll();
    return helpers;
  }

  /**
   * The value of each variable, if it is a number, a list of numbers, a
   * point, or a list of points. `latexOf` gives the latex of a symbol.
   */
  async values(
    symbols: string[],
    latexOf: (symbol: string) => string
  ): Promise<Map<string, Value>> {
    const out = new Map<string, Value>();
    // Seven helpers per symbol: the value itself, then points. `[p].x` is a
    // list only when `p` is one point, `L.x` is a list when `L` is a list of
    // points, and `.z` tells 3D points from 2D ones. Points have to be ruled
    // out first: a single point also reports its coordinates as `listValue`.
    const PER = 7;
    const probes: string[] = [];
    for (const s of symbols) {
      const l = latexOf(s);
      probes.push(l);
      for (const c of ["x", "y", "z"])
        probes.push(`\\left[${l}\\right].${c}`, `${l}.${c}`);
    }
    const helpers = await this.evaluate(probes);
    symbols.forEach((s, i) => {
      const [self, ...h] = helpers.slice(i * PER, i * PER + PER);
      const one = [h[0], h[2], h[4]].map((x) => x.listValue);
      const many = [h[1], h[3], h[5]].map((x) => x.listValue);
      if (one[0]?.length === 1 && one[1]?.length === 1) {
        const coords = one[2]?.length === 1 ? one : one.slice(0, 2);
        out.set(s, { type: "point", value: coords.map((c) => c![0]) });
      } else if (
        many[0] &&
        many[1] &&
        many[0].length > 0 &&
        many[0].length === many[1].length
      ) {
        const coords =
          many[2] && many[2].length === many[0].length
            ? many
            : many.slice(0, 2);
        out.set(s, { type: "points", value: coords.map((c) => [...c!]) });
      } else if (Array.isArray(self.listValue)) {
        // An empty list could be a list of points; leave those alone.
        if (self.listValue.length > 0)
          out.set(s, { type: "list", value: [...self.listValue] });
      } else if (self.numericValue !== undefined && !isNaN(self.numericValue)) {
        out.set(s, { type: "number", value: self.numericValue });
      }
    });
    return out;
  }

  measure(): Measurement {
    const shaders: ShaderStat[] = [];
    const all = this.calc.controller.getAllShaders();
    for (const [id, s] of Object.entries(all))
      if (s)
        shaders.push({
          key: `color:${id}`,
          uniforms: s.shaderUniforms.length,
          cost: s.costEstimate,
        });
    const sketches = this.calc.controller.grapher3d?.graphSketches ?? {};
    for (const [id, sketch] of Object.entries(sketches))
      sketch?.branches?.forEach((b, i) => {
        const s = b.restrictionShader;
        if (s)
          shaders.push({
            key: `restriction:${id}:${i}`,
            uniforms: s.shaderUniforms.length,
            cost: s.costEstimate,
          });
      });
    const errors = new Map<string, string>();
    for (const [id, a] of Object.entries(this.calc.expressionAnalysis))
      if (a?.isError) errors.set(id, a.errorMessage ?? "error");
    return { shaders, errors };
  }
}
