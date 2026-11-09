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
import { FlameGraphController } from "./FlameView";
import { Metric, SpanNode, resolvePath } from "./tree";
import { latexToText } from "./text";
import { sameValues } from "./worker";
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

/** Which shader each limit error rejects, when Desmos made one. */
const ERROR_PARTS: Partial<Record<LimitError, keyof MaterialShaders>> = {
  "color-cost": "color",
  "restriction-cost": "restriction",
  "inequality-cost": "restriction",
};

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
  /**
   * The limit Desmos rejected this expression's shader for. Its shaders are
   * the ones Desmos made and then threw away, if it got that far.
   */
  error?: LimitError;
}

interface History {
  recompiles: number;
  reasons: Partial<Record<RecompileReason, number>>;
  lastReason: RecompileReason | undefined;
}

interface GraphSketch3d {
  branches?: {
    color?: string;
    restrictionShader?: DesmosShader;
    /** Restriction cost errors are on the branch, not the expression. */
    error?: unknown;
  }[];
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
  /** Expressions whose shader went over one of Desmos's limits. */
  errors: SurfaceRow[] = [];
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
  /** The legend row opened to show more, as `section:origin`. */
  expanded: string | undefined;
  /**
   * The part of the shader shown in detail, as keys from the root of the
   * report's tree. Shared by the menu's detail page and the flame graph.
   */
  detailPath: string[] = [];
  /** Whether the menu shows the detail page. */
  detailOpen = false;
  /** Whether the detail view shows the GLSL compiled from its part. */
  showDetailCode = false;
  /** What the detail view and flame graph measure. */
  metric: Metric = "cost";
  readonly flame = new FlameGraphController(this);
  private cachedReport: ShaderReport | undefined;
  private cachedRow: SurfaceRow | undefined;

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
        this.select(undefined);
        this.scheduleSample();
      }
    });
    this.scheduleSample();
  }

  afterDisable() {
    clearTimeout(this.sampleTimeout);
    this.flame.close();
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
          (h = {
            recompiles: 0,
            reasons: {},
            lastReason: undefined,
          })
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
    this.errors = this.limitErrors(grapher);
    // The surface being inspected is gone: back to the list.
    if (this.selectedId !== undefined && !this.selectedRow())
      this.select(undefined);
    this.updateView();
    this.flame.refresh();
  }

  private limitErrors(grapher: Grapher3d): SurfaceRow[] {
    const found: [string, unknown][] = [];
    for (const model of this.cc.getAllItemModels())
      found.push([
        model.id,
        (model as { formula?: { error?: unknown } }).formula?.error,
      ]);
    for (const [id, sketch] of Object.entries(grapher.graphSketches)) {
      const branch = sketch?.branches?.find((b) => b.error !== undefined);
      if (branch) found.push([id, branch.error]);
    }
    const out: SurfaceRow[] = [];
    const seen = new Set<string>();
    for (const [id, err] of found) {
      if (typeof err !== "object" || err === null) continue;
      const { key, dsmShader } = err as {
        key?: unknown;
        dsmShader?: DesmosShader;
      };
      if (typeof key !== "string" || !(key in LIMIT_ERRORS)) continue;
      const error = LIMIT_ERRORS[key as keyof typeof LIMIT_ERRORS];
      if (seen.has(id)) continue;
      seen.add(id);
      // The worker keeps the shader Desmos rejected on the error.
      const part = ERROR_PARTS[error];
      const shaders: MaterialShaders =
        part && typeof dsmShader?.source === "string"
          ? { [part]: dsmShader }
          : {};
      out.push({
        id,
        colorId: part === "color" ? id : undefined,
        surfaces: 1,
        programs: 0,
        material: analyzeMaterial(shaders, this.budget),
        shaders,
        restriction: this.parse(shaders.restriction),
        color: this.parse(shaders.color),
        recompiles: 0,
        reasons: {},
        lastReason: undefined,
        error,
      });
    }
    return out;
  }

  updateView() {
    if (this.dsm.pillboxMenus?.pillboxMenuOpen === "dsm-shader-inspector-menu")
      this.dsm.pillboxMenus.updateMenuView();
  }

  select(id: string | undefined) {
    if (id !== this.selectedId) {
      this.detailPath = [];
      this.detailOpen = false;
      this.expanded = undefined;
    }
    if (id === undefined) this.flame.close();
    this.selectedId = id;
    this.cachedReport = undefined;
    // The expression list shows what each expression adds to the shader.
    this.cc.updateViews();
    this.updateView();
  }

  selectedRow() {
    const id = this.selectedId;
    return (
      this.rows.find((r) => r.id === id) ?? this.errors.find((r) => r.id === id)
    );
  }

  /** Everything about the selected shader. */
  report(): ShaderReport | undefined {
    const row = this.selectedRow();
    if (!row) return undefined;
    if (this.cachedReport?.id === row.id && this.cachedRow === row)
      return this.cachedReport;
    this.cachedRow = row;
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
      nameList: this.listNamer(),
    });
    return this.cachedReport;
  }

  /** Root first, the node shown in detail last. */
  detailChain(): SpanNode[] {
    const report = this.report();
    return report ? resolvePath(report.tree, this.detailPath) : [];
  }

  /** Show a part of the shader in detail, by its keys from the root. */
  navigate(path: string[]) {
    this.detailPath = path;
    this.updateView();
    this.flame.refresh();
  }

  openDetail(path: string[]) {
    this.detailOpen = true;
    this.navigate(path);
  }

  /** Show the part picked in the flame graph on the detail page. */
  showPicked() {
    if (this.selectedId === undefined || this.detailPath.length === 0) return;
    this.detailOpen = true;
    this.updateView();
  }

  closeDetail() {
    this.detailOpen = false;
    this.updateView();
  }

  setMetric(metric: Metric) {
    this.metric = metric;
    // The hovered bar was measured in the old metric.
    this.flame.hovered = undefined;
    this.updateView();
    this.flame.refresh();
  }

  toggleDetailCode() {
    this.showDetailCode = !this.showDetailCode;
    this.updateView();
    this.flame.refresh();
  }

  toggleExpanded(key: string) {
    this.expanded = this.expanded === key ? undefined : key;
    this.updateView();
  }

  /** Keys to the first, outermost part of the tree from `origin`. */
  pathOf(origin: Origin): string[] {
    const report = this.report();
    if (!report) return [];
    const queue: [SpanNode, string[]][] = [[report.tree, []]];
    while (queue.length > 0) {
      const [node, path] = queue.shift()!;
      if (node.kind === "frame" && node.origin === origin) return path;
      for (const c of node.children) queue.push([c, [...path, c.key]]);
    }
    return [];
  }

  /** Map the LaTeX the worker recorded back to expression ids. */
  /** Names lists by the variables that hold the same values. */
  private listNamer() {
    const byLength = new Map<number, { name: string; values: number[] }[]>();
    const analysis = (
      this.calc as unknown as {
        expressionAnalysis: Record<
          string,
          { evaluation?: { type?: string; value?: unknown } } | undefined
        >;
      }
    ).expressionAnalysis;
    for (const m of this.cc.getAllItemModels()) {
      const { latex } = m as { latex?: string };
      const lhs = latex && /^([^=]+)=/.exec(latex)?.[1];
      if (
        !lhs ||
        !/^(?:\\[a-zA-Z]+|[a-zA-Z])(?:_\{?[a-zA-Z0-9]+\}?)?$/.test(lhs)
      )
        continue;
      const ev = analysis?.[m.id]?.evaluation;
      if (ev?.type !== "ListOfNumber" || !Array.isArray(ev.value)) continue;
      const values = ev.value as number[];
      let list = byLength.get(values.length);
      if (!list) byLength.set(values.length, (list = []));
      list.push({ name: latexToText(lhs), values });
    }
    return (values: number[]) =>
      byLength.get(values.length)?.find((l) => sameValues(l.values, values))
        ?.name;
  }

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
    const origins = this.report()?.origins ?? [];
    let i = origins.indexOf(origin);
    // Expressions only seen deep in the tree (a slider inside a definition)
    // still get a color of their own.
    if (i < 0) i = origins.length + hash(origin);
    return ORIGIN_COLORS[i % ORIGIN_COLORS.length];
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

function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

/** Problems first: recompiling, then over budget, then closest to it. */
function compareRows(a: SurfaceRow, b: SurfaceRow) {
  return (
    b.recompiles - a.recompiles ||
    b.material.overflow - a.material.overflow ||
    b.material.uniforms - a.material.uniforms
  );
}
