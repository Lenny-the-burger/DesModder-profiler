import { PluginController } from "../PluginController";
import { FlameGraphController } from "./FlameGraph";
import { MainPopupFunc } from "./ProfilerView";
import {
  Recording,
  Redraw,
  Summary,
  addToTimeline,
  emptyRecording,
  summarize,
} from "./aggregate";
import {
  ChangeSetProfile,
  FrameProfile,
  ProfilerFlags,
  UNATTRIBUTED,
} from "./types";
import { DispatchedEvent } from "#globals";
import { ConfigItem } from "#plugins/index.ts";

/** Upper bound on stored 3D frames, so a long recording can't grow forever. */
const MAX_FRAMES = 20000;
/** How often the view refreshes while recording, in ms. */
const LIVE_UPDATE_MS = 500;
/** After "Profile graph load", keep the menu open this long after the first update. */
const HOLD_OPEN_SETTLE_MS = 1500;
/** ...but never longer than this, in case no update arrives. */
const HOLD_OPEN_MAX_MS = 20000;

export type ProfilerTab = "expressions" | "definitions";

interface ProfilerSettings {
  nodeBreakdown: boolean;
  gpuTiming: boolean;
}

/**
 * Per-expression profiler: worker compile and graph time, 2D canvas drawing,
 * and 3D draws, GPU time, and shader compiles, attributed to expressions and
 * to the definitions they inline.
 *
 * The worker side lives in `worker.ts` and is hooked in by
 * `profiler.replacements`.
 */
export default class Profiler extends PluginController<ProfilerSettings> {
  static id = "profiler" as const;
  static enabledByDefault = false;
  static config = [
    { type: "boolean", default: true, key: "nodeBreakdown" },
    { type: "boolean", default: true, key: "gpuTiming" },
  ] satisfies readonly ConfigItem[];

  dispatchListenerID!: string;

  /** Whether the profiler is recording. */
  recording = false;
  /** Use GPU timer queries for 3D draws. Adds a query per draw call. */
  get gpuTiming() {
    return this.settings.gpuTiming;
  }

  /**
   * Break expressions down into their pieces while compiling. Times every
   * parse node, which slows compiling down noticeably while recording.
   */
  get nodeBreakdown() {
    return this.settings.nodeBreakdown;
  }
  profile: Recording = emptyRecording();
  /** performance.now() when the current or last recording started/stopped. */
  recordingStart = 0;
  recordingEnd = 0;
  private cachedSummary: Summary | undefined;
  private liveTimer: ReturnType<typeof setInterval> | undefined;

  // ---- view state (kept here so it survives closing the popover) ----
  tab: ProfilerTab = "expressions";
  showAll = false;

  readonly flameGraph = new FlameGraphController(this);

  afterEnable() {
    this.dsm.pillboxMenus?.addPillboxButton({
      id: "dsm-profiler-menu",
      tooltip: "profiler-name",
      iconClass: "dsm-icon-pie-chart",
      popup: () => MainPopupFunc(this),
      // Reopening the menu is how you get back to the results.
      onOpen: () => this.stopRecording(),
    });
    this.dispatchListenerID = this.cc.dispatcher.register((e) => {
      if (e.type === "on-evaluator-changes") {
        this.onEvaluatorChanges(e);
      } else if (e.type === "set-blank") {
        this.onGraphLoaded();
      } else if (e.type === "set-state") {
        const opts = e.opts as
          | { fromTextMode?: boolean; dsmProfilerReload?: boolean }
          | undefined;
        if (!opts?.fromTextMode && !opts?.dsmProfilerReload)
          this.onGraphLoaded();
      }
    });
  }

  afterDisable() {
    this.flameGraph.close();
    this.setRecording(false);
    this.cc.dispatcher.unregister(this.dispatchListenerID);
    this.dsm.pillboxMenus?.removePillboxButton("dsm-profiler-menu");
  }

  onEvaluatorChanges(e: DispatchedEvent) {
    if (e.type !== "on-evaluator-changes") return;
    const profile = (e.timingData as { dsmProfile?: ChangeSetProfile })
      .dsmProfile;
    if (!this.recording || !profile) return;
    const index =
      this.profile.changeSets.push({
        profile,
        updateAnalysis: e.timingData.updateAnalysis,
        graphAllChanges: e.timingData.graphAllChanges,
        timeInWorker: e.timingData.timeInWorker,
      }) - 1;
    addToTimeline(this.profile, "changeSet", index);
    this.cachedSummary = undefined;
    this.releaseHold?.();
  }

  /**
   * A different graph was opened (or the graph was replaced). The old
   * results no longer describe it, so drop them. A recording in progress
   * keeps going, so it captures the new graph's load.
   */
  onGraphLoaded() {
    this.profile = emptyRecording();
    this.currentRedraw = undefined;
    this.cachedSummary = undefined;
    if (this.recording) this.recordingStart = performance.now();
    else this.recordingStart = this.recordingEnd = 0;
    this.flameGraph.close();
    this.cc.updateViews();
  }

  /** Sent to the worker with every message (see profiler.replacements). */
  workerFlags(): ProfilerFlags {
    return {
      enabled: this.recording,
      gpu: this.recording && this.gpuTiming,
      nodes: this.recording && this.nodeBreakdown,
    };
  }

  private setRecording(recording: boolean) {
    this.recording = recording;
    this.cachedSummary = undefined;
    clearInterval(this.liveTimer);
    this.liveTimer = undefined;
    if (recording) {
      // Data arrives from the worker, canvas draws, and 3D frames, none of
      // which update views on their own. Refresh periodically instead of on
      // every frame.
      this.liveTimer = setInterval(() => {
        this.cc.updateViews();
        this.flameGraph.refresh();
      }, LIVE_UPDATE_MS);
    }
  }

  startRecording() {
    this.profile = emptyRecording();
    this.recordingStart = performance.now();
    this.setRecording(true);
    this.cc.updateViews();
    this.flameGraph.refresh();
  }

  stopRecording() {
    if (!this.recording) return;
    this.recordingEnd = performance.now();
    this.setRecording(false);
    this.cc.updateViews();
    this.flameGraph.refresh();
  }

  toggleRecording() {
    if (this.recording) {
      this.stopRecording();
      return;
    }
    this.startRecording();
    // Get out of the way while recording, unless pinned open. Opening the
    // menu again stops the recording.
    this.dsm.pillboxMenus?.closeMenu();
  }

  /** Start recording, then reload the graph to profile a cold load. */
  recordGraphLoad() {
    this.startRecording();
    this.holdMenuOpenDuringLoad();
    const oldUnsavedChanges = this.cc._hasUnsavedChanges;
    // Desmos passes the options through to the dispatched `set-state`
    // event, which is how `onGraphLoaded` knows not to wipe this recording.
    const opts = { allowUndo: true, dsmProfilerReload: true };
    this.calc.setState(this.calc.getState(), opts);
    this.cc._hasUnsavedChanges = oldUnsavedChanges;
  }

  private releaseHold: (() => void) | undefined;

  /**
   * Reloading the graph shifts the layout, and Desmos closes a popover when
   * its anchor moves. Pin the menu until the reload has been evaluated and the
   * layout has settled, so results appear as they come in.
   */
  private holdMenuOpenDuringLoad() {
    const pm = this.dsm.pillboxMenus;
    if (!pm || this.releaseHold) return;
    const wasPinned = pm.pillboxMenuPinned;
    pm.pillboxMenuPinned = true;
    let done = false;
    const release = () => {
      if (done) return;
      done = true;
      clearTimeout(failsafe);
      this.releaseHold = undefined;
      // Only undo our own pin; respect the user toggling it meanwhile.
      if (pm.pillboxMenuPinned) pm.pillboxMenuPinned = wasPinned;
      pm.updateMenuView();
    };
    const failsafe = setTimeout(release, HOLD_OPEN_MAX_MS);
    this.releaseHold = () => setTimeout(release, HOLD_OPEN_SETTLE_MS);
  }

  /** Re-render just the profiler menu (cheaper than updating every view). */
  refreshMenu() {
    this.dsm.pillboxMenus?.updateMenuView();
  }

  isPinned() {
    return this.dsm.pillboxMenus?.pillboxMenuPinned ?? false;
  }

  togglePinned() {
    this.dsm.pillboxMenus?.toggleMenuPinned();
  }

  /** Length of the current (or last) recording, in ms. */
  recordingDuration() {
    if (this.recordingStart === 0) return 0;
    return (
      (this.recording ? performance.now() : this.recordingEnd) -
      this.recordingStart
    );
  }

  hasData() {
    const p = this.profile;
    return (
      p.changeSets.length > 0 || p.frames.length > 0 || p.redraws.length > 0
    );
  }

  openFlameGraph() {
    this.flameGraph.open();
  }

  setTab(tab: ProfilerTab) {
    this.tab = tab;
    this.showAll = false;
    this.cc.updateViews();
  }

  setShowAll(showAll: boolean) {
    this.showAll = showAll;
    this.cc.updateViews();
  }

  is3d() {
    return this.cc.is3dProduct();
  }

  /** Called around each 2D sketch draw on the main thread. */
  timeSketch<T>(sketch: { id?: string } | undefined, draw: () => T): T {
    if (!this.recording || sketch?.id === undefined) return draw();
    const start = performance.now();
    try {
      return draw();
    } finally {
      const redraw = this.redrawInProgress();
      redraw[sketch.id] = (redraw[sketch.id] ?? 0) + performance.now() - start;
      this.cachedSummary = undefined;
    }
  }

  private currentRedraw: Redraw | undefined;

  /**
   * The 2D redraw the current sketch draw belongs to. Desmos draws every
   * sketch of a redraw synchronously, so a redraw ends at the next microtask.
   */
  private redrawInProgress(): Redraw {
    if (this.currentRedraw) return this.currentRedraw;
    const redraw: Redraw = {};
    this.currentRedraw = redraw;
    queueMicrotask(() => {
      if (this.currentRedraw === redraw) this.currentRedraw = undefined;
    });
    if (this.profile.redraws.length < MAX_FRAMES) {
      const index = this.profile.redraws.push(redraw) - 1;
      addToTimeline(this.profile, "redraw", index);
    }
    return redraw;
  }

  /** Called with each 3D redraw result from the worker. */
  onRedraw3dResult(
    payload:
      | {
          lastRenderInfo?: { dsmProfile?: FrameProfile; durationCPU?: number };
        }
      | undefined
  ) {
    const info = payload?.lastRenderInfo;
    const frame = info?.dsmProfile;
    if (!this.recording || !frame) return;
    if (this.profile.frames.length >= MAX_FRAMES) return;
    const index =
      this.profile.frames.push({ ...frame, durationCPU: info.durationCPU }) - 1;
    addToTimeline(this.profile, "frame", index);
    this.cachedSummary = undefined;
  }

  getSummary(): Summary {
    return (this.cachedSummary ??= summarize(this.profile, UNATTRIBUTED));
  }

  /** LaTeX of an expression, if it still exists and has any. */
  expressionLatex(id: string): string | undefined {
    const model = this.cc.getItemModel(id) as { latex?: string } | undefined;
    return model?.latex === "" ? undefined : model?.latex;
  }

  /** 1-based position of the item in the expression list, if it exists. */
  expressionNumber(id: string): number | undefined {
    const model = this.cc.getItemModel(id);
    return model ? model.index + 1 : undefined;
  }

  /** A short plain-text label for an expression id. */
  expressionLabel(id: string): string {
    const latex = this.expressionLatex(id);
    return latex ? `${id}: ${latex}` : id;
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
