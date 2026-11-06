import type Profiler from ".";
import "./FlameGraph.less";
import { FlameCanvas } from "./FlameCanvas";
import {
  FlameGrouping,
  FlameMetric,
  FlameNode,
  flameSource,
  FlameSource,
  flameSelf,
  latexToText,
  matchedTime,
  resolvePath,
  symbolToText,
} from "./flame";
import { FlameRect } from "./flame-layout";
import { formatMs, symbolToLatex } from "./format";
import { Summary } from "./aggregate";
import {
  Component,
  DCGView,
  MountedComponent,
  jsx,
  unmountFromNode,
} from "#DCGView";
import {
  Button,
  For,
  If,
  SegmentedControl,
  StaticMathQuillView,
} from "#components";
import { format } from "#i18n";

const GROUPINGS: FlameGrouping[] = ["phase", "expression"];
const METRICS: FlameMetric[] = ["cpu", "gpu"];

/** Owns the flame graph overlay: its state, DOM, and canvas. */
export class FlameGraphController {
  grouping: FlameGrouping = "phase";
  metric: FlameMetric = "cpu";
  /** Keys from the root to the zoomed node. */
  zoomKeys: string[] = [];
  selectedKeys: string[] | undefined;
  hovered: FlameRect | undefined;
  query = "";

  private mountPoint: HTMLElement | undefined;
  private view: MountedComponent | undefined;
  private canvas: FlameCanvas | undefined;
  /** Trees of the current summary, kept so switching views is quick. */
  private source: { summary: Summary; trees: FlameSource } | undefined;

  constructor(readonly profiler: Profiler) {}

  get isOpen() {
    return this.mountPoint !== undefined;
  }

  open() {
    if (this.mountPoint) return;
    if (this.metric === "gpu" && !this.hasGpuData()) this.metric = "cpu";
    this.mountPoint = document.createElement("div");
    this.mountPoint.className = "dsm-flame-mount";
    document.body.appendChild(this.mountPoint);
    this.view = DCGView.mountToNode(FlameGraphView, this.mountPoint, {
      fg: () => this,
    });
    document.addEventListener("keydown", this.onKeyDown, true);
  }

  close() {
    if (!this.mountPoint) return;
    document.removeEventListener("keydown", this.onKeyDown, true);
    this.canvas?.destroy();
    this.canvas = undefined;
    unmountFromNode(this.mountPoint);
    this.mountPoint.remove();
    this.mountPoint = undefined;
    this.view = undefined;
    this.hovered = undefined;
  }

  /** Called when new data arrives or settings change. */
  refresh() {
    if (!this.isOpen) return;
    this.view?.update();
    this.renderCanvas();
  }

  attachCanvas(host: HTMLElement) {
    this.canvas?.destroy();
    this.canvas = new FlameCanvas(host, {
      onHover: (rect) => {
        this.hovered = rect;
        this.view?.update();
      },
      onClick: (rect) => this.zoomTo(rect.keys),
    });
    this.renderCanvas();
  }

  private renderCanvas() {
    this.canvas?.setState({
      chain: this.chain(),
      matches: this.matcher(),
      selected: this.selectedKeys,
    });
  }

  getTree(): FlameNode {
    const summary = this.profiler.getSummary();
    if (this.source?.summary !== summary) {
      const trees = flameSource(this.profiler.profile, summary, {
        root: (metric) => format(`profiler-flame-root-${metric}`),
        phase: (phase) =>
          format(
            phase === "other"
              ? "profiler-flame-other-worker"
              : `profiler-segment-${phase}`
          ),
        expression: (id) => this.expressionName(id),
        definition: (symbol, kind) =>
          kind === "fn" ? `${symbolToText(symbol)}()` : symbolToText(symbol),
        unattributed: format("profiler-unattributed"),
        shaderWait: format("profiler-flame-shader-wait"),
      });
      this.source = { summary, trees };
    }
    return this.source.trees.tree({
      grouping: this.grouping,
      metric: this.metric,
    });
  }

  private expressionName(id: string) {
    const latex = this.profiler.expressionLatex(id);
    const n = this.profiler.expressionNumber(id);
    if (latex === undefined)
      return format("profiler-unknown-expression", { id });
    const text = latexToText(latex);
    return n === undefined ? text : `${n}: ${text}`;
  }

  /** Root first, zoomed node last. */
  chain(): FlameNode[] {
    return resolvePath(this.getTree(), this.zoomKeys);
  }

  zoomTo(keys: string[]) {
    this.zoomKeys = keys;
    this.selectedKeys = keys.length > 0 ? keys : undefined;
    this.refresh();
  }

  setGrouping(grouping: FlameGrouping) {
    if (grouping === this.grouping) return;
    this.grouping = grouping;
    this.resetZoom();
  }

  setMetric(metric: FlameMetric) {
    if (metric === this.metric) return;
    this.metric = metric;
    this.resetZoom();
  }

  private resetZoom() {
    this.zoomKeys = [];
    this.selectedKeys = undefined;
    this.hovered = undefined;
    this.refresh();
  }

  setQuery(query: string) {
    this.query = query;
    this.refresh();
  }

  matcher(): ((n: FlameNode) => boolean) | undefined {
    const q = this.query.trim().toLowerCase();
    if (q === "") return undefined;
    return (n) =>
      n.name.toLowerCase().includes(q) ||
      (n.symbol?.toLowerCase().includes(q) ?? false);
  }

  hasGpuData() {
    const s = this.profiler.getSummary();
    return (
      s.expressions.some((r) => r.gpu > 0) || (s.unattributed3D?.gpu ?? 0) > 0
    );
  }

  /** The node shown in the details bar: hovered, else selected, else zoomed. */
  detailNode(): { node: FlameNode; parent: FlameNode | undefined } {
    const tree = this.getTree();
    const keys = this.hovered?.keys ?? this.selectedKeys ?? this.zoomKeys;
    const chain = resolvePath(tree, keys);
    return {
      node: chain[chain.length - 1],
      parent: chain[chain.length - 2],
    };
  }

  /**
   * LaTeX to render for a node in the details bar: the expression it belongs
   * to, or for a definition, the expression that defines it.
   */
  detailLatex(node: FlameNode): string | undefined {
    if (node.latex !== undefined) return node.latex;
    if (node.kind === "definition") {
      const defining =
        node.definedBy !== undefined
          ? this.profiler.expressionLatex(node.definedBy)
          : undefined;
      if (defining !== undefined) return defining;
      return node.symbol !== undefined
        ? symbolToLatex(node.symbol) +
            (node.symbolKind === "fn" ? "\\left(\\right)" : "")
        : undefined;
    }
    return node.exprId !== undefined
      ? this.profiler.expressionLatex(node.exprId)
      : undefined;
  }

  /** The expression a node can jump to, if any. */
  jumpTarget(node: FlameNode): string | undefined {
    if (node.kind === "definition") return node.definedBy;
    return node.exprId;
  }

  jumpTo(id: string) {
    this.profiler.jumpTo(id);
  }

  private readonly onKeyDown = (ev: KeyboardEvent) => {
    if (ev.key !== "Escape") return;
    ev.stopPropagation();
    if (this.query !== "") this.setQuery("");
    else if (this.zoomKeys.length > 0) this.zoomTo(this.zoomKeys.slice(0, -1));
    else this.close();
  };
}

const pct = (part: number, whole: number) =>
  whole > 0 ? `${((100 * part) / whole).toFixed(1)}%` : "–";

class FlameGraphView extends Component<{ fg: () => FlameGraphController }> {
  fg = () => this.props.fg();

  template() {
    return (
      <div
        class="dsm-flame-backdrop"
        onTap={(e: Event) => {
          if (e.target === e.currentTarget) this.fg().close();
        }}
      >
        <div
          class="dsm-flame-panel"
          role="dialog"
          aria-label={format("profiler-flame-title")}
        >
          {this.header()}
          {this.breadcrumbs()}
          <div
            class="dsm-flame-host"
            onMount={(el: HTMLElement) => this.fg().attachCanvas(el)}
          />
          <If predicate={() => this.fg().getTree().value <= 0}>
            {() => (
              <div class="dsm-flame-empty">
                {format("profiler-flame-empty")}
              </div>
            )}
          </If>
          {this.details()}
        </div>
      </div>
    );
  }

  header() {
    return (
      <div class="dsm-flame-header">
        <div class="dsm-flame-title">{format("profiler-flame-title")}</div>
        <If predicate={() => this.fg().metric === "cpu"}>
          {() => (
            <div class="dsm-flame-segmented">
              <SegmentedControl
                names={() =>
                  GROUPINGS.map((g) => format(`profiler-flame-group-${g}`))
                }
                selectedIndex={() => GROUPINGS.indexOf(this.fg().grouping)}
                setSelectedIndex={(i) => this.fg().setGrouping(GROUPINGS[i])}
                ariaGroupLabel={format("profiler-flame-group-label")}
              />
            </div>
          )}
        </If>
        <If predicate={() => this.fg().hasGpuData()}>
          {() => (
            <div class="dsm-flame-segmented">
              <SegmentedControl
                names={() => METRICS.map((m) => format(`profiler-flame-${m}`))}
                selectedIndex={() => METRICS.indexOf(this.fg().metric)}
                setSelectedIndex={(i) => this.fg().setMetric(METRICS[i])}
                ariaGroupLabel={format("profiler-flame-metric-label")}
              />
            </div>
          )}
        </If>
        <input
          class="dsm-flame-search"
          type="search"
          placeholder={format("profiler-flame-search")}
          aria-label={format("profiler-flame-search")}
          value={() => this.fg().query}
          onInput={(e: Event) =>
            this.fg().setQuery((e.target as HTMLInputElement).value)
          }
        />
        <span
          class="dsm-flame-close dcg-icon-remove"
          role="button"
          tabindex="0"
          aria-label={format("profiler-flame-close")}
          onTap={() => this.fg().close()}
        />
      </div>
    );
  }

  breadcrumbs() {
    return (
      <div class="dsm-flame-breadcrumbs">
        <For
          each={() =>
            this.fg()
              .chain()
              .map((node, i) => ({ node, i }))
          }
          key={({ node, i }: { node: FlameNode; i: number }) =>
            `${i}:${node.key}`
          }
        >
          {(crumb: () => { node: FlameNode; i: number }) => (
            <span class="dsm-flame-crumb-wrap">
              <If predicate={() => crumb().i > 0}>
                {() => <span class="dsm-flame-crumb-sep">›</span>}
              </If>
              <span
                class={() => ({
                  "dsm-flame-crumb": true,
                  "dsm-flame-crumb-current":
                    crumb().i === this.fg().chain().length - 1,
                })}
                role="button"
                tabindex="0"
                onTap={() =>
                  this.fg().zoomTo(this.fg().zoomKeys.slice(0, crumb().i))
                }
              >
                {() => crumb().node.name}
              </span>
            </span>
          )}
        </For>
        <If predicate={() => this.fg().matcher() !== undefined}>
          {() => (
            <span class="dsm-flame-match">
              {() => {
                const tree = this.fg().getTree();
                const t = matchedTime(tree, this.fg().matcher()!);
                return format("profiler-flame-matched", {
                  duration: formatMs(t),
                  percent: pct(t, tree.value),
                });
              }}
            </span>
          )}
        </If>
      </div>
    );
  }

  details() {
    const d = () => this.fg().detailNode();
    return (
      <div class="dsm-flame-details">
        <If predicate={() => this.fg().detailLatex(d().node) !== undefined}>
          {() => (
            <div class="dsm-flame-details-name dsm-flame-details-math">
              <StaticMathQuillView
                latex={() => this.fg().detailLatex(d().node) ?? ""}
              />
            </div>
          )}
        </If>
        <If predicate={() => this.fg().detailLatex(d().node) === undefined}>
          {() => (
            <div class="dsm-flame-details-name">{() => d().node.name}</div>
          )}
        </If>
        <div class="dsm-flame-details-stats">
          {() => {
            const { node, parent } = d();
            const total = this.fg().getTree().value;
            const parts = [
              formatMs(node.value),
              format("profiler-flame-of-total", {
                percent: pct(node.value, total),
              }),
            ];
            if (parent)
              parts.push(
                format("profiler-flame-of-parent", {
                  percent: pct(node.value, parent.value),
                })
              );
            if (node.children.length > 0)
              parts.push(
                format("profiler-flame-self", {
                  duration: formatMs(flameSelf(node)),
                })
              );
            if (node.count !== undefined && node.count > 0)
              parts.push(
                format("profiler-flame-compiled", { count: node.count })
              );
            if (node.wackscope) parts.push(format("profiler-wackscope"));
            return parts.join(" · ");
          }}
        </div>
        <If predicate={() => this.fg().jumpTarget(d().node) !== undefined}>
          {() => (
            <Button
              color="light-gray"
              class="dsm-flame-jump"
              onTap={() => {
                const id = this.fg().jumpTarget(d().node);
                if (id !== undefined) this.fg().jumpTo(id);
              }}
            >
              {() =>
                format(
                  d().node.kind === "definition"
                    ? "profiler-flame-jump-definition"
                    : "profiler-flame-jump-expression"
                )
              }
            </Button>
          )}
        </If>
      </div>
    );
  }
}
