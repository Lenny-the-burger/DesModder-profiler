/**
 * Rendered LaTeX with parts of it highlighted. Each part is wrapped in
 * `\textcolor` with a color that encodes its index; once MathQuill has
 * rendered it, those colors become backgrounds and the parts become
 * clickable. If the wrapped LaTeX doesn't parse, it's shown plain.
 */
import { Component, jsx } from "#DCGView";
import { Switch } from "#components";

export interface MathPart {
  /** Background, or undefined to leave the part plain. */
  color: string | undefined;
  title: string;
  onPick: () => void;
}

export interface ColoredLatex {
  latex: string;
  /** The same LaTeX without highlights, to fall back on. */
  plain: string;
  parts: MathPart[];
}

/** Interior node of a highlight tree: a range of `input` and what's in it. */
export interface Highlight<T> {
  start: number;
  end: number;
  value: T;
  children: Highlight<T>[];
}

const marker = (i: number) => `#${(i + 1).toString(16).padStart(6, "0")}`;

/**
 * Wrap the ranges of `root`'s descendants in markers, skipping any that
 * overlap or stick out of their parent.
 */
export function highlightLatex<T>(
  input: string,
  root: Highlight<T>,
  part: (value: T) => MathPart | undefined
): ColoredLatex {
  const parts: MathPart[] = [];
  const emit = (h: Highlight<T>): string => {
    let out = "";
    let pos = h.start;
    const children = [...h.children].sort((a, b) => a.start - b.start);
    for (const c of children) {
      if (c.start < pos || c.end > h.end || c.end <= c.start) continue;
      out += input.slice(pos, c.start);
      const inner = emit(c);
      const p = part(c.value);
      if (p?.color !== undefined) {
        out += `\\textcolor{${marker(parts.length)}}{${inner}}`;
        parts.push(p);
      } else out += inner;
      pos = c.end;
    }
    return out + input.slice(pos, h.end);
  };
  return {
    latex: emit(root),
    plain: input.slice(root.start, root.end),
    parts,
  };
}

function render(el: HTMLElement, colored: ColoredLatex) {
  // MathQuill handles presses on the element it renders into to select the
  // math, so it goes in an inner element and this one takes presses first.
  const inner = document.createElement("span");
  el.appendChild(inner);
  const mq = window.Desmos.MathQuill.StaticMath(inner);
  mq.latex(colored.latex);
  if (mq.latex() === "" && colored.latex !== "") {
    mq.latex(colored.plain);
    return;
  }
  const partOf = new Map<Element, MathPart>();
  for (const node of inner.querySelectorAll<HTMLElement>(".dcg-mq-textcolor")) {
    const m = /color:\s*#([0-9a-f]{6})/i.exec(node.getAttribute("style") ?? "");
    const part = m ? colored.parts[parseInt(m[1], 16) - 1] : undefined;
    if (!part) continue;
    node.style.color = "";
    node.style.backgroundColor = part.color ?? "";
    node.classList.add("dsm-si-part");
    node.title = part.title;
    partOf.set(node, part);
  }
  const press = (e: Event) => {
    // Selecting read-only math isn't useful; picking the part under it is.
    e.preventDefault();
    e.stopPropagation();
    // Cancelling the pointer press means no mouse press follows it.
    if (e.type !== "pointerdown") return;
    const node = (e.target as Element | null)?.closest(".dsm-si-part");
    const part = node ? partOf.get(node) : undefined;
    part?.onPick();
  };
  for (const type of ["mousedown", "touchstart", "pointerdown"])
    el.addEventListener(type, press, { capture: true });
}

export class ColoredMath extends Component<{
  colored: () => ColoredLatex;
  /** Changes whenever the math or its colors do. */
  renderKey: () => string;
}> {
  template() {
    return (
      <Switch key={() => this.props.renderKey()}>
        {() => (
          <span
            class="dsm-si-colored-math"
            didMount={(el: HTMLElement) => render(el, this.props.colored())}
          />
        )}
      </Switch>
    );
  }
}
