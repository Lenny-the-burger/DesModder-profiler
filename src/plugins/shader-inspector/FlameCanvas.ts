/**
 * Canvas flame graph, the same as the profiler's: the zoomed node fills the
 * width, its ancestors get faded full-width rows above it, and each child's
 * width is its share of its parent.
 */

export interface FlameItem {
  /** Unique among siblings; a path of keys identifies an item. */
  key: string;
  name: string;
  value: number;
  fill: string;
  text: string;
  children: FlameItem[];
}

export interface FlameRect {
  /** In CSS pixels. */
  x: number;
  w: number;
  /** Row index from the top. */
  row: number;
  item: FlameItem;
  /** Keys from the root's children down to this item. */
  keys: string[];
  /** Drawn as an ancestor of the zoomed item (full width, faded). */
  ancestor: boolean;
}

/** Rects narrower than this (in px) are skipped, along with their children. */
const MIN_RECT_WIDTH = 0.5;
export const ROW_HEIGHT = 20;
const FONT = '11px "Helvetica Neue", Helvetica, Arial, sans-serif';
const TEXT_PAD = 4;
/** Don't try to draw labels in rects narrower than this. */
const MIN_LABEL_WIDTH = 24;

/** Lay out the tree zoomed into the last item of `chain` (root first). */
export function layoutFlame(chain: FlameItem[], width: number): FlameRect[] {
  const rects: FlameRect[] = [];
  const keysOf = (i: number) => chain.slice(1, i + 1).map((n) => n.key);
  for (let i = 0; i < chain.length - 1; i++)
    rects.push({
      x: 0,
      w: width,
      row: i,
      item: chain[i],
      keys: keysOf(i),
      ancestor: true,
    });
  const place = (
    item: FlameItem,
    x: number,
    w: number,
    row: number,
    keys: string[]
  ) => {
    if (w < MIN_RECT_WIDTH) return;
    rects.push({ x, w, row, item, keys, ancestor: false });
    const sum = item.children.reduce((s, c) => s + c.value, 0);
    const scale = Math.max(item.value, sum);
    if (scale <= 0) return;
    let cx = x;
    for (const child of item.children) {
      const cw = (w * child.value) / scale;
      place(child, cx, cw, row + 1, [...keys, child.key]);
      cx += cw;
    }
  };
  const zoomed = chain[chain.length - 1];
  if (zoomed)
    place(zoomed, 0, width, chain.length - 1, keysOf(chain.length - 1));
  return rects;
}

export interface FlameCanvasState {
  /** Root first, zoomed item last. */
  chain: FlameItem[];
  /** Keys of the selected item, to outline it. */
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
    private readonly callbacks: {
      onHover: (rect: FlameRect | undefined) => void;
      onClick: (rect: FlameRect) => void;
    }
  ) {
    this.canvas.className = "dsm-si-flame-canvas";
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
    this.hovered = undefined;
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
    const rows = this.rects.reduce((m, r) => Math.max(m, r.row + 1), 1);
    const height = rows * ROW_HEIGHT;
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
      const y = rect.row * ROW_HEIGHT;
      // 1px gap between neighbours and rows.
      const w = Math.max(rect.w - 1, 0.5);
      ctx.globalAlpha = rect.ancestor ? 0.45 : 1;
      ctx.fillStyle = rect.item.fill;
      ctx.fillRect(rect.x, y, w, ROW_HEIGHT - 1);
      ctx.globalAlpha = 1;
      if (rect.keys.join("\u0000") === selectedKey) {
        ctx.strokeStyle = "#222";
        ctx.lineWidth = 2;
        ctx.strokeRect(rect.x + 1, y + 1, w - 2, ROW_HEIGHT - 3);
      }
      if (rect === this.hovered) {
        ctx.fillStyle = "rgba(255, 255, 255, 0.3)";
        ctx.fillRect(rect.x, y, w, ROW_HEIGHT - 1);
      }
      if (w >= MIN_LABEL_WIDTH) {
        ctx.fillStyle = rect.ancestor ? "#444" : rect.item.text;
        ctx.fillText(
          fitText(ctx, rect.item.name, w - 2 * TEXT_PAD),
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
