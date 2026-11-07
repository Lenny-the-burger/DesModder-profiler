import { Inserter, PluginController } from "../PluginController";
import { ExpressionPanelFunc, MainPopupFunc } from "./ShaderInspectorView";
import {
  DesmosShader,
  MaterialInfo,
  MaterialShaders,
  RecompileReason,
  ShaderInfo,
  analyzeMaterial,
  analyzeShader,
  recompileReason,
  surfaceBudget,
} from "./analyze";
import {
  InspectedShader,
  Origin,
  ShaderPart,
  ShaderReport,
  shaderReport,
} from "./report";
import { ItemModel } from "#globals";

/** Errors Desmos gives when a shader would go over one of its limits. */
export const LIMIT_ERRORS = {
  "shared-calculator-error-color-function-exceeds-cost-limit": "color-cost",
  "shared-calculator-error-restriction-exceeds-cost-limit": "restriction-cost",
  "shared-calculator-error-inequality-exceeds-cost-limit": "inequality-cost",
  "shared-calculator-error-gpu-long-sum": "long-loop",
  "shared-calculator-error-gpu-long-product": "long-loop",
  "shared-calculator-error-gpu-variable-sum": "variable-loop",
  "shared-calculator-error-gpu-variable-product": "variable-loop",
  "shared-calculator-error-gpu-max-list-size": "list-size",
} as const;

export type LimitError = (typeof LIMIT_ERRORS)[keyof typeof LIMIT_ERRORS];

export interface LimitErrorRow {
  id: string;
  error: LimitError;
}

export interface SurfaceRow {
  /** The expression drawn with these shaders. */
  id: string;
  /** The expression defining its color function, if it has one. */
  colorId: string | undefined;
  /** Surfaces it draws (one per list element). */
  surfaces: number;
  /** Distinct shader programs among them. */
  programs: number;
  /** The surface using the most uniform slots. */
  material: MaterialInfo;
  /** Its shaders. */
  shaders: MaterialShaders;
  restriction: ShaderInfo | undefined;
  color: ShaderInfo | undefined;
  recompiles: number;
  reasons: Partial<Record<RecompileReason, number>>;
  lastReason: RecompileReason | undefined;
}

interface History {
  recompiles: number;
  reasons: Partial<Record<RecompileReason, number>>;
  lastReason: RecompileReason | undefined;
}

interface GraphSketch3d {
  branches?: { color?: string; restrictionShader?: DesmosShader }[];
}

interface Grapher3d {
  graphSketches: Record<string, GraphSketch3d | undefined>;
  maxFragmentUniformComponents?: number;
}

/** Colors for the expressions in a shader, in order of appearance. */
export const ORIGIN_COLORS = [
  "#2d70b3",
  "#fa7e19",
  "#388c46",
  "#6042a6",
  "#c74440",
  "#46a6a8",
  "#e3a51c",
  "#b5367a",
  "#8a6e4b",
  "#5e8a1f",
  "#3f3fbf",
  "#d46a6a",
];
/** Color for code that couldn't be traced to an expression. */
export const UNTRACED_COLOR = "#9a9a9a";

/** Keep parsed shaders for at most this many distinct sources. */
const MAX_CACHED_SHADERS = 500;

/**
 * Shows, for each 3D expression, how its shaders use Desmos's uniform budget
 * and cost limits, and counts how often they have to be recompiled and why.
 *
 * Everything is read from the main thread: the color function shaders from
 * `getAllShaders()` and restriction shaders from the 3D graph sketches.
 */
export default class ShaderInspector extends PluginController {
  static id = "shader-inspector" as const;
  static enabledByDefault = false;

  dispatchListenerID!: string;
  private sampleTimeout: ReturnType<typeof setTimeout> | undefined;

  rows: SurfaceRow[] = [];
  errors: LimitErrorRow[] = [];
  budget = 0;
  /** Recompiles counted since the graph loaded or the counts were reset. */
  totalRecompiles = 0;

  /** Each surface's shaders at the last update, by `id:branch`. */
  private lastShaders = new Map<string, MaterialShaders>();
  /** Programs in use at the last update. */
  private lastPrograms = new Set<string>();
  private readonly history = new Map<string, History>();
  private readonly parsed = new Map<string, ShaderInfo>();

  /** The surface whose shader is being inspected. */
  selectedId: string | undefined;
  showGlsl = false;
  /** The part whose cost explanation is open, if any. */
  costHelp: ShaderPart | undefined = undefined;
  private cachedReport: ShaderReport | undefined;

  afterEnable() {
    this.dsm.pillboxMenus?.addPillboxButton({
      id: "dsm-shader-inspector-menu",
      tooltip: "shader-inspector-name",
      iconClass: "dsm-icon-magic",
      popup: () => MainPopupFunc(this),
    });
    this.dispatchListenerID = this.cc.dispatcher.register((e) => {
      if (e.type === "on-evaluator-changes") this.scheduleSample();
      else if (e.type === "set-state") {
        const opts = e.opts as { fromTextMode?: boolean } | undefined;
        if (opts?.fromTextMode) return;
        // A new graph: its shaders are new, not recompiles of the old ones.
        this.lastShaders.clear();
        this.lastPrograms.clear();
        this.resetCounts();
        this.scheduleSample();
      }
    });
    this.scheduleSample();
  }

  afterDisable() {
    clearTimeout(this.sampleTimeout);
    this.selectedId = undefined;
    this.cc.updateViews();
    this.cc.dispatcher.unregister(this.dispatchListenerID);
    this.dsm.pillboxMenus?.removePillboxButton("dsm-shader-inspector-menu");
  }

  /** The grapher has read the evaluator's changes by the next task. */
  private scheduleSample() {
    if (this.sampleTimeout !== undefined) return;
    this.sampleTimeout = setTimeout(() => {
      this.sampleTimeout = undefined;
      this.sample();
    }, 0);
  }

  resetCounts() {
    this.history.clear();
    this.totalRecompiles = 0;
    for (const row of this.rows) {
      row.recompiles = 0;
      row.reasons = {};
      row.lastReason = undefined;
    }
    this.updateView();
  }

  private grapher(): Grapher3d | undefined {
    return (this.cc as unknown as { grapher3d?: Grapher3d }).grapher3d;
  }

  private parse(shader: DesmosShader | undefined) {
    if (!shader) return undefined;
    let info = this.parsed.get(shader.source);
    if (!info) {
      if (this.parsed.size >= MAX_CACHED_SHADERS) this.parsed.clear();
      info = analyzeShader(shader);
      this.parsed.set(shader.source, info);
    }
    // Loop bounds can be uniforms, so their counts depend on current values.
    return info.loops.length > 0 ? analyzeShader(shader) : info;
  }

  /** Read every surface's shaders and update the rows. */
  sample() {
    const grapher = this.grapher();
    if (!grapher) return;
    const cc = this.cc as unknown as {
      getAllShaders: () => Record<string, DesmosShader | undefined>;
      getUniqueAssignmentMap: () => Map<string, string>;
    };
    const colorShaders = cc.getAllShaders();
    const assignments = cc.getUniqueAssignmentMap();
    this.budget = surfaceBudget(grapher.maxFragmentUniformComponents ?? 0);

    const shaders = new Map<string, MaterialShaders>();
    const programs = new Set<string>();
    const newPrograms = new Map<string, Set<string>>();
    const reasons = new Map<string, RecompileReason>();
    const rows: SurfaceRow[] = [];

    for (const [id, sketch] of Object.entries(grapher.graphSketches)) {
      const branches = sketch?.branches;
      if (!branches?.length) continue;
      let colorId: string | undefined;
      let worst: { info: MaterialInfo; shaders: MaterialShaders } | undefined;
      const keys = new Set<string>();
      branches.forEach((branch, i) => {
        const assigned =
          branch.color !== undefined
            ? assignments.get(branch.color)
            : undefined;
        const material: MaterialShaders = {
          restriction: branch.restrictionShader,
          color: assigned !== undefined ? colorShaders[assigned] : undefined,
        };
        if (!material.restriction && !material.color) return;
        if (material.color) colorId = assigned;
        const info = analyzeMaterial(material, this.budget);
        keys.add(info.key);
        programs.add(info.key);
        if (!worst || info.uniforms > worst.info.uniforms)
          worst = { info, shaders: material };

        const slot = `${id}:${i}`;
        shaders.set(slot, material);
        const before = this.lastShaders.get(slot);
        if (!before || this.lastPrograms.has(info.key)) return;
        const reason = recompileReason(before, material, this.budget);
        if (!reason) return;
        let set = newPrograms.get(id);
        if (!set) newPrograms.set(id, (set = new Set()));
        if (!set.has(info.key)) {
          set.add(info.key);
          reasons.set(`${id}\u0000${info.key}`, reason);
        }
      });
      if (!worst) continue;

      let h = this.history.get(id);
      if (!h)
        this.history.set(
          id,
          (h = { recompiles: 0, reasons: {}, lastReason: undefined })
        );
      for (const key of newPrograms.get(id) ?? []) {
        const reason = reasons.get(`${id}\u0000${key}`)!;
        h.recompiles++;
        h.reasons[reason] = (h.reasons[reason] ?? 0) + 1;
        h.lastReason = reason;
        this.totalRecompiles++;
      }

      rows.push({
        id,
        colorId,
        surfaces: branches.length,
        programs: keys.size,
        material: worst.info,
        shaders: worst.shaders,
        restriction: this.parse(worst.shaders.restriction),
        color: this.parse(worst.shaders.color),
        recompiles: h.recompiles,
        reasons: h.reasons,
        lastReason: h.lastReason,
      });
    }

    this.lastShaders = shaders;
    this.lastPrograms = programs;
    this.rows = rows.sort(compareRows);
    this.cachedReport = undefined;
    this.errors = this.limitErrors();
    this.updateView();
  }

  private limitErrors(): LimitErrorRow[] {
    const out: LimitErrorRow[] = [];
    for (const model of this.cc.getAllItemModels()) {
      const err = (model as { formula?: { error?: unknown } }).formula?.error;
      const key =
        typeof err === "object" && err !== null
          ? (err as { key?: unknown }).key
          : undefined;
      if (typeof key === "string" && key in LIMIT_ERRORS)
        out.push({
          id: model.id,
          error: LIMIT_ERRORS[key as keyof typeof LIMIT_ERRORS],
        });
    }
    return out;
  }

  private updateView() {
    if (this.dsm.pillboxMenus?.pillboxMenuOpen === "dsm-shader-inspector-menu")
      this.dsm.pillboxMenus.updateMenuView();
  }

  select(id: string | undefined) {
    this.selectedId = id;
    this.cachedReport = undefined;
    // The expression list shows what each expression adds to the shader.
    this.cc.updateViews();
    this.updateView();
  }

  selectedRow() {
    return this.rows.find((r) => r.id === this.selectedId);
  }

  /** Everything about the selected shader. */
  report(): ShaderReport | undefined {
    const row = this.selectedRow();
    if (!row) return undefined;
    if (this.cachedReport?.id === row.id) return this.cachedReport;
    this.cachedReport = shaderReport({
      id: row.id,
      colorId: row.colorId,
      surfaces: row.surfaces,
      programs: row.programs,
      shaders: row.shaders as {
        restriction?: InspectedShader;
        color?: InspectedShader;
      },
      budget: this.budget,
      resolve: this.resolver(),
    });
    return this.cachedReport;
  }

  /** Map the LaTeX the worker recorded back to expression ids. */
  private resolver() {
    const byLatex = new Map<string, string>();
    for (const m of this.cc.getAllItemModels()) {
      const { latex } = m as { latex?: string };
      if (latex && !byLatex.has(latex)) byLatex.set(latex, m.id);
    }
    const assignments = (
      this.cc as unknown as {
        getUniqueAssignmentMap: () => Map<string, string>;
      }
    ).getUniqueAssignmentMap();
    // Nodes made by Desmos (not parsed) carry just the identifier's name.
    return (latex: string) => byLatex.get(latex) ?? assignments.get(latex);
  }

  originColor(origin: Origin) {
    if (origin === undefined) return UNTRACED_COLOR;
    const i = this.report()?.origins.indexOf(origin) ?? -1;
    return i < 0 ? UNTRACED_COLOR : ORIGIN_COLORS[i % ORIGIN_COLORS.length];
  }

  /** Shown under each expression that is part of the inspected shader. */
  expressionPanel(model: ItemModel): Inserter {
    if (this.selectedId === undefined) return undefined;
    const report = this.report();
    if (!report?.origins.includes(model.id) && report?.id !== model.id)
      return undefined;
    return () => ExpressionPanelFunc(this, model.id);
  }

  isPinned() {
    return this.dsm.pillboxMenus?.pillboxMenuPinned ?? false;
  }

  togglePinned() {
    this.dsm.pillboxMenus?.toggleMenuPinned();
  }

  openMenu() {
    this.dsm.pillboxMenus?.toggleMenu("dsm-shader-inspector-menu", true);
  }

  toggleCostHelp(part: ShaderPart) {
    this.costHelp = this.costHelp === part ? undefined : part;
    this.updateView();
  }

  toggleGlsl() {
    this.showGlsl = !this.showGlsl;
    this.updateView();
  }

  expressionLatex(id: string): string | undefined {
    const model = this.cc.getItemModel(id) as { latex?: string } | undefined;
    return model?.latex === "" ? undefined : model?.latex;
  }

  /** Select an expression in the list and scroll to it. */
  jumpTo(id: string) {
    const model = this.cc.getItemModel(id);
    if (!model) return;
    if (model.type !== "folder" && model.folderId)
      this.cc.dispatch({
        type: "set-folder-collapsed",
        id: model.folderId,
        isCollapsed: false,
      });
    this.cc.dispatch({ type: "set-selected-id", id });
    this.cc.scrollSelectedItemIntoView();
  }
}

/** Problems first: recompiling, then over budget, then closest to it. */
function compareRows(a: SurfaceRow, b: SurfaceRow) {
  return (
    b.recompiles - a.recompiles ||
    b.material.overflow - a.material.overflow ||
    b.material.uniforms - a.material.uniforms
  );
}
