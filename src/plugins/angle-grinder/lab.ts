/**
 * An offscreen calculator for evaluating values and measuring the shaders a
 * graph compiles to, and the evaluator's time on it, without touching the
 * graph on screen.
 */
import type { GraphState } from "../../../graph-state";
import type { Value } from "./rewrite";
import { COST_LIMIT } from "./summary";

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

/** A uniform limit no shader reaches. */
const UNLIMITED_UNIFORMS = 1e7;

interface Grapher3D {
  maxFragmentUniformComponents?: number;
  getMaxFragmentUniformComponents: () => number;
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
    getAllShaders?: () => Record<string, Shader | undefined>;
    dispatcher: {
      register: (cb: (e: DispatchedEvent) => void) => string;
      unregister: (id: string) => void;
    };
    getGrapher3d?: () => Grapher3D | undefined;
    grapher3d?: {
      graphSketches?: Record<
        string,
        { branches?: { restrictionShader?: Shader }[] } | undefined
      >;
    };
  };
}

interface DispatchedEvent {
  type: string;
  timingData?: { timeInWorker?: number };
}

type LabConstructor = (el: HTMLElement, opts: object) => LabCalc;

export interface ShaderStat {
  /** `color:<expression id>` or `restriction:<expression id>:<branch>` */
  key: string;
  uniforms: number;
  cost: number;
}

export interface Measurement {
  /** Every shader, including ones Desmos would reject for their cost. */
  shaders: ShaderStat[];
  /** Error message of each expression that has one, by id. */
  errors: Map<string, string>;
  /**
   * Time the evaluator worker spent on the load (compiling, evaluating and
   * computing graphs), in ms.
   */
  workerMs: number;
}

/** The end of the error message of a shader over the cost limit. */
export const TOO_COSTLY = "is too complicated";

const sleep = async (ms: number) =>
  await new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `state` with no slider playing and the ticker stopped, and every
 * expression hidden except the ones in `draw`.
 */
export function stopped(
  state: GraphState,
  draw?: ReadonlySet<string>
): GraphState {
  const copy: GraphState = JSON.parse(JSON.stringify(state));
  for (const item of copy.expressions.list) {
    if (item.type !== "expression") continue;
    if (item.slider?.isPlaying) item.slider.isPlaying = false;
    if (draw && !draw.has(item.id)) item.hidden = true;
  }
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
  private calc: LabCalc | undefined;
  private workerMs = 0;

  private constructor(private readonly el: HTMLElement) {}

  static create(): Lab {
    const el = document.createElement("div");
    el.style.cssText =
      "position:fixed;left:-10000px;top:0;width:400px;height:300px;visibility:hidden";
    document.body.appendChild(el);
    return new Lab(el);
  }

  destroy() {
    this.calc?.destroy();
    this.calc = undefined;
    this.el.remove();
  }

  private get loaded(): LabCalc {
    if (!this.calc) throw new Error("Nothing is loaded in the lab");
    return this.calc;
  }

  /**
   * Load `state` with every slider and the ticker stopped, so values are
   * read at the moment `state` was taken, and wait for Desmos to evaluate
   * and compile it. Each load gets a new calculator.
   *
   * The calculator keeps shaders over the cost limit (Desmos's own
   * `ignoreCostEstimate` option), so they can be measured and made cheaper;
   * `measure` reports the error Desmos would show for them. It also counts
   * every uniform slot a shader asks for, past the 427 Desmos gives it.
   *
   * Only expressions in `draw` are drawn. Every calculator on the page shares
   * one evaluator worker, and meshing a heavy surface can keep it busy for
   * minutes, during which neither the lab nor the graph on screen gets
   * anything evaluated. Color functions compile without being drawn; only
   * restrictions and inequalities need their surface drawn.
   */
  async load(state: GraphState, draw?: ReadonlySet<string>, timeout = 180000) {
    this.calc?.destroy();
    const { Desmos } = window as unknown as {
      Desmos: {
        Calculator3D?: LabConstructor;
        GraphingCalculator?: LabConstructor;
        Geometry?: LabConstructor;
      };
    };
    const { product } = state.graph;
    const make =
      product === "graphing-3d" || state.graph.threeDMode
        ? Desmos.Calculator3D
        : product === "geometry-calculator"
          ? (Desmos.Geometry ?? Desmos.GraphingCalculator)
          : Desmos.GraphingCalculator;
    if (!make) throw new Error("No calculator for this kind of graph");
    // No expression list: the lab never shows one, and drawing it while the
    // calculator is still being built can ask for the evaluator before it
    // exists ("reading 'evaluationProgressById'").
    this.calc = make(this.el, {
      ignoreCostEstimate: true,
      expressions: false,
    });
    // Desmos gives a shader at most 427 slots and writes the rest into its
    // source, so its uniform list stops at 427. With the limit raised (the
    // worker reads it from the grapher), the list has every slot the shader
    // asks for. The lab never draws, so no program is built from it.
    const grapher = this.calc.controller.getGrapher3d?.();
    if (grapher) {
      grapher.maxFragmentUniformComponents = UNLIMITED_UNIFORMS;
      grapher.getMaxFragmentUniformComponents = () => UNLIMITED_UNIFORMS;
    }
    let worker = 0;
    const { dispatcher } = this.calc.controller;
    const listener = dispatcher.register((e) => {
      if (e.type === "on-evaluator-changes")
        worker += e.timingData?.timeInWorker ?? 0;
    });
    try {
      this.calc.setState(stopped(state, draw));
      await this.settle(timeout);
    } finally {
      dispatcher.unregister(listener);
    }
    this.workerMs = worker;
  }

  /**
   * Wait until the evaluator has answered a helper created now, which comes
   * after everything already queued.
   */
  async settle(timeout = 180000) {
    const h = this.loaded.HelperExpression({ latex: "1" });
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
      this.loaded.HelperExpression({ latex })
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
    const all = this.loaded.controller.getAllShaders?.() ?? {};
    for (const [id, s] of Object.entries(all))
      if (s)
        shaders.push({
          key: `color:${id}`,
          uniforms: s.shaderUniforms.length,
          cost: s.costEstimate,
        });
    const sketches = this.loaded.controller.grapher3d?.graphSketches ?? {};
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
    for (const [id, a] of Object.entries(this.loaded.expressionAnalysis))
      if (a?.isError) errors.set(id, a.errorMessage ?? "error");
    // What Desmos reports when it isn't told to ignore the cost.
    for (const s of shaders)
      if (s.cost > COST_LIMIT) {
        const [part, id] = s.key.split(":");
        if (!errors.has(id)) errors.set(id, `${part} ${TOO_COSTLY}`);
      }
    return { shaders, errors, workerMs: this.workerMs };
  }
}
