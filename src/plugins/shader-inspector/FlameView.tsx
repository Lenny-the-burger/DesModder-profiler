/**
 * The shader as a flame graph: one bar per part of an expression, as wide as
 * what it adds for the chosen metric, under the part it is in. Picking a bar
 * zooms into it and shows it in the detail view beside the graph.
 */
import type ShaderInspector from ".";
import "./FlameView.less";
import { FlameCanvas, FlameItem, FlameRect } from "./FlameCanvas";
import { DetailView, metricText, nodeName } from "./DetailView";
import { repeatsText } from "./text";
import { lighten, textOn } from "./categories";
import { METRICS, Metric, SpanNode, metricValue } from "./tree";
import { ShaderReport } from "./report";
import {
  Component,
  DCGView,
  MountedComponent,
  jsx,
  unmountFromNode,
} from "#DCGView";
import { If, SegmentedControl } from "#components";
import { format } from "#i18n";

export class FlameGraphController {
  hovered: FlameRect | undefined;
  private mountPoint: HTMLElement | undefined;
  private view: MountedComponent | undefined;
  private canvas: FlameCanvas | undefined;
  private cached:
    | { report: ShaderReport; metric: Metric; item: FlameItem }
    | undefined;

  constructor(readonly si: ShaderInspector) {}

  get isOpen() {
    return this.mountPoint !== undefined;
  }

  open() {
    if (this.mountPoint !== undefined || !this.si.report()) return;
    this.mountPoint = document.createElement("div");
    this.mountPoint.className = "dsm-si-flame-mount";
    document.body.appendChild(this.mountPoint);
    // Desmos closes the menu on a pointerdown anywhere outside it, which is
    // everywhere in the flame graph. This runs after the graph's own handlers.
    document.addEventListener("pointerdown", this.onPointerDown);
    this.view = DCGView.mountToNode(FlameView, this.mountPoint, {
      fg: () => this,
    });
    document.addEventListener("keydown", this.onKeyDown, true);
  }

  /**
   * Close the flame graph. Closed by the user, the menu goes on showing the
   * part picked in the graph.
   */
  close(byUser = false) {
    if (!this.mountPoint) return;
    document.removeEventListener("keydown", this.onKeyDown, true);
    document.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas?.destroy();
    this.canvas = undefined;
    unmountFromNode(this.mountPoint);
    this.mountPoint.remove();
    this.mountPoint = undefined;
    this.view = undefined;
    this.hovered = undefined;
    if (byUser) this.si.showPicked();
  }

  private readonly onPointerDown = (ev: PointerEvent) => {
    if (ev.target instanceof Node && this.mountPoint?.contains(ev.target))
      ev.stopPropagation();
  };

  /** Called when the report, path or metric change. */
  refresh() {
    if (!this.isOpen) return;
    if (!this.si.report()) {
      this.close();
      return;
    }
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
      onClick: (rect) => this.si.navigate(rect.keys),
    });
    this.renderCanvas();
  }

  private renderCanvas() {
    const root = this.item();
    if (!root) return;
    this.canvas?.setState({
      chain: this.chain(root),
      selected: this.si.detailPath,
    });
  }

  /** The report's tree as flame graph items for the current metric. */
  item(): FlameItem | undefined {
    const report = this.si.report();
    if (!report) return undefined;
    const { metric } = this.si;
    if (this.cached?.report !== report || this.cached.metric !== metric)
      this.cached = {
        report,
        metric,
        item: this.toItem(report.tree, metric, 0),
      };
    return this.cached.item;
  }

  private toItem(node: SpanNode, metric: Metric, depth: number): FlameItem {
    const base =
      node.kind === "frame" || node.kind === "untraced"
        ? this.si.originColor(node.origin)
        : "#b8bcc2";
    // Nested parts of the same expression get lighter shades of its color.
    const fill = lighten(base, node.kind === "frame" ? (depth % 4) * 0.13 : 0);
    return {
      key: node.key,
      name: nodeName(node),
      value: metricValue(node.total, metric),
      note: metric === "cost" ? repeatsText(node.total) : undefined,
      fill,
      text: textOn(fill),
      children: node.children
        .filter((c) => metricValue(c.total, metric) > 0)
        .map((c) => this.toItem(c, metric, depth + 1)),
    };
  }

  /** Root first, along the detail path as far as it has any of the metric. */
  chain(root: FlameItem): FlameItem[] {
    const chain = [root];
    let item = root;
    for (const k of this.si.detailPath) {
      const next = item.children.find((c) => c.key === k);
      if (!next) break;
      chain.push(next);
      item = next;
    }
    return chain;
  }

  private readonly onKeyDown = (ev: KeyboardEvent) => {
    if (ev.key !== "Escape") return;
    ev.stopPropagation();
    const path = this.si.detailPath;
    if (path.length > 0) this.si.navigate(path.slice(0, -1));
    else this.close(true);
  };
}

class FlameView extends Component<{ fg: () => FlameGraphController }> {
  fg = () => this.props.fg();
  si = () => this.fg().si;

  template() {
    return (
      <div
        class="dsm-si-flame-backdrop"
        onTap={(e: Event) => {
          if (e.target === e.currentTarget) this.fg().close(true);
        }}
      >
        <div
          class="dsm-si-flame-panel"
          role="dialog"
          aria-label={format("shader-inspector-flame-title")}
        >
          <div class="dsm-si-flame-header">
            <div class="dsm-si-flame-title">
              {format("shader-inspector-flame-title")}
            </div>
            <div class="dsm-si-flame-segmented">
              <SegmentedControl
                names={() =>
                  METRICS.map((m) => format(`shader-inspector-metric-${m}`))
                }
                selectedIndex={() => METRICS.indexOf(this.si().metric)}
                setSelectedIndex={(i) => this.si().setMetric(METRICS[i])}
                ariaGroupLabel={format("shader-inspector-flame-metric")}
              />
            </div>
            <span
              class="dsm-si-flame-close dcg-icon-remove"
              role="button"
              tabindex="0"
              aria-label={format("shader-inspector-flame-close")}
              onTap={() => this.fg().close(true)}
            />
          </div>
          <div class="dsm-si-flame-body">
            <div class="dsm-si-flame-main">
              <div
                class="dsm-si-flame-host"
                didMount={(el: HTMLElement) => this.fg().attachCanvas(el)}
              />
              <If predicate={() => (this.fg().item()?.value ?? 0) <= 0}>
                {() => (
                  <div class="dsm-si-flame-empty">
                    {format("shader-inspector-flame-empty")}
                  </div>
                )}
              </If>
              <div class="dsm-si-flame-hover">
                {() => {
                  const h = this.fg().hovered;
                  if (!h) return format("shader-inspector-flame-hint");
                  const root = this.fg().item()?.value ?? 0;
                  const share =
                    root > 0
                      ? ` (${Math.round((100 * h.item.value) / root)}%)`
                      : "";
                  const note = h.item.note ? ` = ${h.item.note}` : "";
                  return `${h.item.name}: ${metricText(this.si().metric, h.item.value)}${note}${share}`;
                }}
              </div>
            </div>
            <div class="dsm-si-flame-side dsm-shader-inspector-menu">
              <DetailView si={() => this.si()} inFlame={true} />
            </div>
          </div>
        </div>
      </div>
    );
  }
}
