/** Canvas renderer for the flame graph. Plain DOM, owned by FlameGraphView. */
import { FlameNode } from "./flame";
import { FlameRect, colorFor, layoutFlame, rowCount } from "./flame-layout";

export const ROW_HEIGHT = 20;
const FONT = '11px "Helvetica Neue", Helvetica, Arial, sans-serif';
const TEXT_PAD = 4;
/** Don't try to draw labels in rects narrower than this. */
const MIN_LABEL_WIDTH = 24;

export interface FlameCanvasCallbacks {
  onHover: (rect: FlameRect | undefined) => void;
  onClick: (rect: FlameRect) => void;
}

export interface FlameCanvasState {
  /** Root first, zoomed node last. */
  chain: FlameNode[];
  /** Nodes that don't match are dimmed; undefined means no search. */
  matches?: (node: FlameNode) => boolean;
  /** Keys of the selected node, to outline it. */
  selected?: string[];
}

export class FlameCanvas {
  private readonly canvas = document.createElement("canvas");
  private readonly ctx = this.canvas.getContext("2d")!;
  private readonly resizeObserver: ResizeObserver;
  private rects: FlameRect[] = [];
  private hovered: FlameRect | undefined;
  private state: FlameCanvasState | undefined;
  private width = 0;

  constructor(
    private readonly host: HTMLElement,
    private readonly callbacks: FlameCanvasCallbacks
  ) {
    this.canvas.className = "dsm-flame-canvas";
    host.appendChild(this.canvas);
    this.canvas.addEventListener("mousemove", this.onMouseMove);
    this.canvas.addEventListener("mouseleave", this.onMouseLeave);
    this.canvas.addEventListener("click", this.onClickCanvas);
    this.resizeObserver = new ResizeObserver(() => this.render());
    this.resizeObserver.observe(host);
  }

  destroy() {
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener("mousemove", this.onMouseMove);
    this.canvas.removeEventListener("mouseleave", this.onMouseLeave);
    this.canvas.removeEventListener("click", this.onClickCanvas);
    this.canvas.remove();
  }

  setState(state: FlameCanvasState) {
    this.state = state;
    this.render();
  }

  render() {
    const { state } = this;
    if (!state) return;
    const style = getComputedStyle(this.host);
    this.width = Math.floor(
      this.host.clientWidth -
        parseFloat(style.paddingLeft) -
        parseFloat(style.paddingRight)
    );
    if (this.width <= 0) return;
    this.rects = layoutFlame(state.chain, this.width);
    const height = Math.max(1, rowCount(this.rects)) * ROW_HEIGHT;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${height}px`;
    this.canvas.width = Math.round(this.width * dpr);
    this.canvas.height = Math.round(height * dpr);
    const { ctx } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, height);
    ctx.font = FONT;
    ctx.textBaseline = "middle";

    const selectedKey = state.selected?.join("\u0000");
    for (const rect of this.rects) {
      const dimmed =
        rect.ancestor || (state.matches ? !state.matches(rect.node) : false);
      const color = colorFor(rect.node, dimmed);
      const y = rect.row * ROW_HEIGHT;
      // 1px gap between neighbours and rows.
      const w = Math.max(rect.w - 1, 0.5);
      ctx.fillStyle = color.fill;
      ctx.fillRect(rect.x, y, w, ROW_HEIGHT - 1);
      if (rect.node.wackscope && !dimmed) {
        ctx.strokeStyle = "#6042a6";
        ctx.lineWidth = 1.5;
        ctx.setLineDash([3, 2]);
        ctx.strokeRect(rect.x + 0.75, y + 0.75, w - 1.5, ROW_HEIGHT - 2.5);
        ctx.setLineDash([]);
      }
      if (rect.keys.join("\u0000") === selectedKey && !rect.ancestor) {
        ctx.strokeStyle = "#222";
        ctx.lineWidth = 2;
        ctx.strokeRect(rect.x + 1, y + 1, w - 2, ROW_HEIGHT - 3);
      }
      if (rect === this.hovered) {
        ctx.fillStyle = "rgba(255, 255, 255, 0.25)";
        ctx.fillRect(rect.x, y, w, ROW_HEIGHT - 1);
      }
      if (w >= MIN_LABEL_WIDTH) {
        ctx.fillStyle = color.text;
        ctx.fillText(
          fitText(ctx, rect.node.name, w - 2 * TEXT_PAD),
          rect.x + TEXT_PAD,
          y + ROW_HEIGHT / 2
        );
      }
    }
  }

  private rectAt(ev: MouseEvent): FlameRect | undefined {
    const box = this.canvas.getBoundingClientRect();
    const x = ev.clientX - box.left;
    const row = Math.floor((ev.clientY - box.top) / ROW_HEIGHT);
    // Later rects are deeper; any rect on this row and x is the one.
    return this.rects.find((r) => r.row === row && x >= r.x && x < r.x + r.w);
  }

  private readonly onMouseMove = (ev: MouseEvent) => {
    const rect = this.rectAt(ev);
    if (rect === this.hovered) return;
    this.hovered = rect;
    this.canvas.style.cursor = rect ? "pointer" : "default";
    this.render();
    this.callbacks.onHover(rect);
  };

  private readonly onMouseLeave = () => {
    if (!this.hovered) return;
    this.hovered = undefined;
    this.render();
    this.callbacks.onHover(undefined);
  };

  private readonly onClickCanvas = (ev: MouseEvent) => {
    const rect = this.rectAt(ev);
    if (rect) this.callbacks.onClick(rect);
  };
}

/** Truncate `text` with an ellipsis so it fits in `width` px. */
function fitText(ctx: CanvasRenderingContext2D, text: string, width: number) {
  if (ctx.measureText(text).width <= width) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(text.slice(0, mid) + "…").width <= width) lo = mid;
    else hi = mid - 1;
  }
  return lo === 0 ? "" : text.slice(0, lo) + "…";
}
