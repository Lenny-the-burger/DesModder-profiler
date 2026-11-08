import { PluginController } from "../PluginController";
import { MainPopupFunc } from "./View";
import { analyzeGraph } from "./analyze";
import { GrindResult, grind } from "./grind";
import { playingSliders } from "./lab";
import type { GraphState } from "../../../graph-state";
import {
  buildConfigFromGlobals,
  identifierToString,
} from "../../../text-mode-core";

export interface SliderRow {
  symbol: string;
  latex: string;
  /** The slider's expression. */
  id: string;
  /** Changed by an action or the ticker, so it always varies. */
  updated: boolean;
  playing: boolean;
}

export type Status =
  | { type: "idle" }
  | { type: "running"; step: string }
  | { type: "done"; result: GrindResult; input: GraphState }
  | { type: "applied"; result: GrindResult; source: GraphState }
  | { type: "error"; message: string };

/**
 * Rewrites a graph so Desmos compiles it faster (see lift.ts) and, in 3D,
 * compiles cheaper shaders from it. Values that
 * don't change are written into the expressions that end up in shaders as
 * typed-in numbers, which Desmos puts in the shader source instead of giving
 * each number a uniform slot. The result is plain graph state that works
 * without DesModder.
 */
export default class AngleGrinder extends PluginController {
  static id = "angle-grinder" as const;
  static enabledByDefault = false;

  status: Status = { type: "idle" };
  sliders: SliderRow[] = [];
  /** Sliders the user marked as fixed. Everything else keeps varying. */
  frozen = new Set<string>();
  /** Whether the list of changed expressions is open. */
  showChanges = false;

  private dispatchListenerID: string | null = null;
  /** Set while the plugin itself sets the graph's state. */
  private settingState = false;
  /** Bumped when another graph is loaded, so a grind of the old one is dropped. */
  private generation = 0;

  afterEnable() {
    this.dispatchListenerID = this.cc.dispatcher.register((e) => {
      if (e.type !== "set-state" || this.settingState) return;
      // After the dispatch, which views can't be updated in.
      setTimeout(() => this.graphReplaced());
    });
    this.dsm.pillboxMenus?.addPillboxButton({
      id: "dsm-angle-grinder-menu",
      tooltip: "angle-grinder-name",
      iconClass: "dsm-icon-compass2",
      popup: () => {
        this.refreshSliders();
        return MainPopupFunc(this);
      },
    });
  }

  afterDisable() {
    this.dsm.pillboxMenus?.removePillboxButton("dsm-angle-grinder-menu");
    if (this.dispatchListenerID !== null)
      this.cc.dispatcher.unregister(this.dispatchListenerID);
    this.dispatchListenerID = null;
  }

  /** Forget everything about the graph that was loaded before. */
  private graphReplaced() {
    this.generation++;
    this.status = { type: "idle" };
    this.frozen.clear();
    this.showChanges = false;
    this.refreshSliders();
    this.update();
  }

  /** Set the graph's state without it counting as another graph. */
  private setState(state: GraphState) {
    this.settingState = true;
    try {
      this.calc.setState(state, { allowUndo: true });
    } finally {
      this.settingState = false;
    }
  }

  private config() {
    return buildConfigFromGlobals(Desmos, this.calc);
  }

  update() {
    this.cc.updateViews();
  }

  /** Find the sliders, draggable points and action targets of the graph. */
  refreshSliders() {
    const state = this.calc.getState();
    const cfg = this.config();
    const a = analyzeGraph(cfg, state);
    const playing = playingSliders(state);
    const rows: SliderRow[] = [];
    for (const symbol of a.sliders) {
      const { id } = a.definitions.get(symbol)!;
      rows.push({
        symbol,
        latex: identifierToString(cfg, { type: "Identifier", symbol }),
        id,
        updated: a.updated.has(symbol),
        playing: playing.has(id),
      });
    }
    // Keep choices for sliders that are still there.
    this.frozen = new Set(
      [...this.frozen].filter((s) => rows.some((r) => r.symbol === s))
    );
    this.sliders = rows;
  }

  isVarying(row: SliderRow) {
    return row.updated || !this.frozen.has(row.symbol);
  }

  setVarying(row: SliderRow, varying: boolean) {
    if (row.updated) return;
    if (varying) this.frozen.delete(row.symbol);
    else this.frozen.add(row.symbol);
    this.update();
  }

  /** Freeze every slider that isn't playing or changed by an action. */
  freezeStill() {
    for (const r of this.sliders)
      if (!r.updated && !r.playing) this.frozen.add(r.symbol);
    this.update();
  }

  varyAll() {
    this.frozen.clear();
    this.update();
  }

  toggleChanges() {
    this.showChanges = !this.showChanges;
    this.update();
  }

  /** Jump to the expression defining a variable that was written in. */
  jumpToDefinition(symbol: string) {
    const s = this.status;
    const id =
      s.type === "done" || s.type === "applied"
        ? s.result.definedIn.get(symbol)
        : undefined;
    if (id !== undefined) this.jumpTo(id);
  }

  get running() {
    return this.status.type === "running";
  }

  async run() {
    if (this.running) return;
    const input = this.calc.getState();
    const { generation } = this;
    const varyingSliders = new Set(
      this.sliders.filter((r) => this.isVarying(r)).map((r) => r.symbol)
    );
    this.status = { type: "running", step: "analyze" };
    this.update();
    try {
      const result = await grind(
        this.config(),
        input,
        { varyingSliders },
        (step) => {
          if (generation !== this.generation) return;
          this.status = { type: "running", step };
          this.update();
        }
      );
      if (generation !== this.generation) return;
      this.status = { type: "done", result, input };
    } catch (e) {
      if (generation !== this.generation) return;
      this.status = {
        type: "error",
        message: e instanceof Error ? e.message : String(e),
      };
    }
    this.update();
  }

  /**
   * Put the rewritten expressions into the graph, as one undoable change.
   * Only expressions that still read as they did when grinding are changed,
   * and everything else (slider values, the camera) stays as it is now.
   */
  apply() {
    if (this.status.type !== "done") return;
    const { result, input } = this.status;
    const before = new Map<string, string>();
    for (const item of input.expressions.list)
      if (item.type === "expression") before.set(item.id, item.latex ?? "");
    const after = new Map<string, string>();
    for (const item of result.state.expressions.list)
      if (item.type === "expression") after.set(item.id, item.latex ?? "");

    const source = this.calc.getState();
    const next: GraphState = JSON.parse(JSON.stringify(source));
    for (const item of next.expressions.list) {
      if (item.type !== "expression" || !result.rewritten.includes(item.id))
        continue;
      if ((item.latex ?? "") !== before.get(item.id)) continue;
      item.latex = after.get(item.id);
    }
    // Definitions added for repeated parts.
    const present = new Set(next.expressions.list.map((item) => item.id));
    for (const item of result.state.expressions.list)
      if (result.added.includes(item.id) && !present.has(item.id))
        next.expressions.list.push(item);
    this.setState(next);
    this.status = { type: "applied", result, source };
    this.update();
  }

  /** Put the graph back the way it was before applying. */
  restore() {
    if (this.status.type !== "applied") return;
    this.setState(this.status.source);
    this.status = { type: "idle" };
    this.refreshSliders();
    this.update();
  }

  /** The number Desmos shows next to an expression. */
  expressionNumber(id: string) {
    const model = this.cc.getItemModel(id);
    return model ? String(model.index + 1) : "?";
  }

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
