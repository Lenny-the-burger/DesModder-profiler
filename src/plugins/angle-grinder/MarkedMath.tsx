/**
 * Rendered LaTeX with its marked parts highlighted and clickable. Rendering
 * works as in the shader inspector's `ColoredMath`: each part is wrapped in
 * `\textcolor` with a color that encodes its index, and once MathQuill has
 * rendered it, those colors become backgrounds. If the marked LaTeX doesn't
 * parse, it's shown plain.
 */
import type { MarkedLatex, MarkedPart } from "./diff";
import { Component, jsx } from "#DCGView";
import { Switch } from "#components";

interface Props {
  marked: () => MarkedLatex;
  /** Changes whenever the math does. */
  renderKey: () => string;
  /** Class added to each part, which sets its background. */
  partClass: () => string;
  title: (part: MarkedPart) => string;
  onPick: (part: MarkedPart) => void;
}

function render(el: HTMLElement, props: Props) {
  const marked = props.marked();
  // MathQuill handles presses on the element it renders into to select the
  // math, so it goes in an inner element and this one takes presses first.
  const inner = document.createElement("span");
  el.appendChild(inner);
  const mq = window.Desmos.MathQuill.StaticMath(inner);
  mq.latex(marked.latex);
  if (mq.latex() === "" && marked.latex !== "") {
    mq.latex(marked.plain);
    return;
  }
  const partOf = new Map<Element, MarkedPart>();
  for (const node of inner.querySelectorAll<HTMLElement>(".dcg-mq-textcolor")) {
    const m = /color:\s*#([0-9a-f]{6})/i.exec(node.getAttribute("style") ?? "");
    const part = m ? marked.parts[parseInt(m[1], 16) - 1] : undefined;
    if (!part) continue;
    node.style.color = "";
    node.classList.add("dsm-ag-part", props.partClass());
    node.title = props.title(part);
    partOf.set(node, part);
  }
  // Long expressions scroll sideways; start with the first change in view.
  const first = partOf.keys().next().value as HTMLElement | undefined;
  const scroller = el.closest(".dsm-ag-diff-lines");
  if (first && scroller)
    requestAnimationFrame(() => {
      const offset =
        first.getBoundingClientRect().left -
        scroller.getBoundingClientRect().left;
      if (offset > scroller.clientWidth - 40)
        scroller.scrollLeft = Math.max(scroller.scrollLeft, offset - 40);
    });
  const press = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    // Cancelling the pointer press means no mouse press follows it.
    if (e.type !== "pointerdown") return;
    const node = (e.target as Element | null)?.closest(".dsm-ag-part");
    const part = node ? partOf.get(node) : undefined;
    if (part) props.onPick(part);
  };
  for (const type of ["mousedown", "touchstart", "pointerdown"])
    el.addEventListener(type, press, { capture: true });
}

export class MarkedMath extends Component<Props> {
  template() {
    return (
      <Switch key={() => this.props.renderKey()}>
        {() => (
          <span
            class="dsm-ag-marked-math"
            didMount={(el: HTMLElement) => render(el, this.props)}
          />
        )}
      </Switch>
    );
  }
}
