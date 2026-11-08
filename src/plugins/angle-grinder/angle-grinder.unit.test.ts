import {
  buildConfigFromGlobals,
  parseRootLatex,
} from "../../../text-mode-core";
import {
  analyzeGraph,
  inlineCandidates,
  shaderExpressions,
  varyingSymbols,
} from "./analyze";
import {
  numberNode,
  printLatex,
  roundTrips,
  substitute,
  valueNode,
  Value,
} from "./rewrite";
import { diffOf, shortNumber } from "./diff";
import { Kind, Names, distribute, kindOf, pushToGpu } from "./hot";
import type { GraphState } from "../../../graph-state";
import "../../tests/run_calc_for_tests";

const Calc = window.Desmos.GraphingCalculator(
  document.getElementById("graph-container")!
);
const cfg = buildConfigFromGlobals(window.Desmos, Calc);

function graph(...latex: string[]): GraphState {
  const state: GraphState = {
    version: 11,
    randomSeed: "0",
    graph: { viewport: { xmin: -10, ymin: -10, xmax: 10, ymax: 10 } },
    expressions: {
      list: latex.map((l, i) => ({
        type: "expression" as const,
        id: String(i + 1),
        latex: l,
      })),
    },
  };
  return state;
}

function candidates(state: GraphState, varyingSliders: string[] = []) {
  const a = analyzeGraph(cfg, state);
  const varying = varyingSymbols(a, new Set(varyingSliders));
  return new Set(inlineCandidates(a, varying));
}

/** Substitute `values` (symbol -> latex) into `latex`. */
function sub(latex: string, values: Record<string, string>) {
  const map = new Map(
    Object.entries(values).map(([k, v]) => [k, parseRootLatex(cfg, v)])
  );
  const used = new Set<string>();
  const root = parseRootLatex(cfg, latex);
  return printLatex(
    cfg,
    substitute(root, map as Map<string, never>, used)
  ).replace(/\\left|\\right/g, "");
}

describe("what changes", () => {
  test("sliders vary only when chosen, and their dependents with them", () => {
    const s = graph("T=1", "a=T+1", "b=[1,2,3]", "c=b+2");
    expect(candidates(s, ["T"])).toEqual(new Set(["b", "c"]));
    expect(candidates(s, [])).toEqual(new Set(["T", "a", "b", "c"]));
  });

  test("action targets always vary", () => {
    const s = graph("n=1", "m=n+1", "n\\to n+1");
    expect(candidates(s, [])).toEqual(new Set());
  });

  test("ticker handlers count as actions", () => {
    const s = graph("n=1", "k=[1,2]");
    s.expressions.ticker = { handlerLatex: "n\\to n+1", open: true };
    expect(candidates(s, [])).toEqual(new Set(["k"]));
  });

  test("points of numbers are sliders", () => {
    const a = analyzeGraph(cfg, graph("P=(1,2,3)", "Q=(1,2)+P", "L=[1,2]"));
    expect(a.sliders).toEqual(["P"]);
  });

  test("functions are never inlined", () => {
    expect(candidates(graph("f(x)=x^2", "a=f(2)"))).toEqual(new Set(["a"]));
  });

  test("symbols defined twice are left alone", () => {
    expect(candidates(graph("a=1+1", "a=2+2", "b=[1]"))).toEqual(
      new Set(["b"])
    );
  });
});

describe("names rebound by with and for", () => {
  test("a definition read inside `with` that binds a name it reads", () => {
    // `a with k=100` is 101, so `a` can't be written as 6 there.
    const s = graph("k=5", "a=k+1", "b=a\\operatorname{with}k=100", "c=[2]");
    const c = candidates(s);
    expect(c.has("a")).toBe(false);
    expect(c.has("k")).toBe(false);
    expect(c.has("c")).toBe(true);
  });

  test("a definition read inside `for` that binds a name it reads", () => {
    const s = graph("k=5", "a=k+1", "b=[a\\operatorname{for}k=[1,2]]");
    expect(candidates(s).has("a")).toBe(false);
  });

  test("an unrelated `for` doesn't stop inlining", () => {
    const s = graph("k=5", "a=k+1", "b=[i^2\\operatorname{for}k=[1,2]]");
    expect(candidates(s)).toEqual(new Set(["k", "a", "b"]));
  });

  test("function parameters don't rebind globals", () => {
    // `f(2)` is 6: the parameter doesn't reach into `a`.
    const s = graph("k=5", "a=k+1", "f(k)=a");
    expect(candidates(s)).toEqual(new Set(["k", "a"]));
  });

  test("derivatives differentiate through definitions", () => {
    const s = graph("k=5", "a=k^2", "b=\\frac{d}{dk}a");
    expect(candidates(s).has("a")).toBe(false);
  });
});

describe("substitution", () => {
  test("replaces free names", () => {
    expect(sub("c=a+b", { a: "2" })).toBe("c=2+b");
  });

  test("keeps names bound by functions, sums and comprehensions", () => {
    expect(sub("f(a)=a+b", { a: "2", b: "3" })).toBe("f(a)=a+3");
    expect(sub("c=\\sum_{a=1}^{b}a", { a: "2", b: "3" })).toBe(
      "c=\\sum_{a=1}^{3}a"
    );
    expect(sub("c=[a\\operatorname{for}a=[1,b]]", { a: "2", b: "3" })).toBe(
      "c=[a\\operatorname{for}a=[1,3]]"
    );
    expect(sub("c=a\\operatorname{with}a=b", { a: "2", b: "3" })).toBe(
      "c=a\\operatorname{with}a=3"
    );
  });

  test("a variable called like a function is a product", () => {
    expect(sub("c=a(x+1)", { a: "2" })).toBe("c=2\\cdot (x+1)");
  });

  test("leaves method names alone", () => {
    expect(sub("c=L.\\operatorname{count}+L.x", { L: "[1,2]" })).toBe(
      "c=[1,2].\\operatorname{count}+[1,2].x"
    );
  });

  test("reports which names it replaced", () => {
    const used = new Set<string>();
    const root = parseRootLatex(cfg, "c=a+b");
    expect(substitute(root, new Map(), used)).toEqual(root);
    expect(used.size).toBe(0);
  });
});

describe("values as latex", () => {
  const print = (n: number) =>
    printLatex(cfg, numberNode(n)).replace(/\\left|\\right/g, "");

  test("numbers Desmos reads back exactly", () => {
    for (const n of [0, 1, -2.5, 0.1, 1 / 3, 123456789.123, 1e-7, 2.5e21]) {
      const latex = printLatex(cfg, numberNode(n));
      expect(() => parseRootLatex(cfg, latex)).not.toThrow();
    }
    expect(print(1 / 3)).toBe(String(1 / 3));
    expect(print(-2.5)).toBe("-2.5");
    expect(print(1e-7)).toBe("1\\cdot 10^{-7}");
    expect(print(NaN)).toBe("\\frac{0}{0}");
    expect(print(Infinity)).toBe("\\infty");
  });

  test("lists of points are written as a point of lists", () => {
    const s = printLatex(
      cfg,
      valueNode({
        type: "points",
        value: [
          [1, 2],
          [3, 4],
          [5, 6],
        ],
      })
    ).replace(/\\left|\\right/g, "");
    expect(s).toBe("([1,2],[3,4],[5,6])");
  });

  test("expressions that print back the same way", () => {
    for (const l of ["a=[1,2,3]", "f(x)=\\sin(x)", "c=\\{x>1:2,3\\}"])
      expect(roundTrips(cfg, parseRootLatex(cfg, l))).toBe(true);
  });
});

describe("shader expressions", () => {
  test("follow what pixel expressions read, but not constants", () => {
    const s = graph(
      "L=[1,2,3]",
      "f(p)=p\\cdot L",
      "q=f(x)",
      "z=q",
      "M=L+1",
      "y_{1}=M"
    );
    const a = analyzeGraph(cfg, s);
    const ids = shaderExpressions(a, new Set(["L", "M", "y_1"])).map(
      (e) => e.id
    );
    expect(ids.sort()).toEqual(["2", "3", "4"]);
  });
});

describe("diffs", () => {
  const values = new Map<string, Value>([
    ["a", { type: "number", value: 0.1 + 0.2 }],
    ["L", { type: "list", value: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }],
    ["p", { type: "point", value: [1, -2e-12, 3] }],
  ]);
  test("marks the variables before and their values after", () => {
    const root = parseRootLatex(
      cfg,
      String.raw`z=a+\operatorname{total}(L)+p.x+a`
    );
    const d = diffOf(cfg, "1", root, ["a", "L", "p"], values);
    expect(d.before.parts.map((p) => p.symbol)).toEqual(["a", "L", "p", "a"]);
    expect(d.after.parts.map((p) => p.size)).toEqual([1, 10, 3, 1]);
    expect(d.before.plain).toBe(
      String.raw`z=a+\operatorname{total}\left(L\right)+p.x+a`
    );
    expect(d.after.plain).toBe(
      String.raw`z=0.3+\operatorname{total}\left(\left[1,2,3,...,10\right]\right)+\left(1,-2\times10^{-12},3\right).x+0.3`
    );
    expect(d.before.latex).toContain(String.raw`\textcolor{#000002}{L}`);
  });
  test("leaves bound names alone", () => {
    const root = parseRootLatex(cfg, "f(a)=a+L");
    const d = diffOf(cfg, "1", root, ["a", "L"], values);
    expect(d.before.parts.map((p) => p.symbol)).toEqual(["L"]);
  });
  test("short numbers", () => {
    expect(shortNumber(NaN)).toBe(String.raw`\operatorname{undefined}`);
    expect(shortNumber(-Infinity)).toBe(String.raw`-\infty`);
    expect(shortNumber(1234567.89)).toBe("1234570");
  });
});

describe("changing values", () => {
  const names: Names = {
    constants: new Set(["C", "N", "T", "K", "P"]),
    typedIn: new Set(["K"]),
    defined: new Set(["C", "N", "T", "K", "P", "p", "f"]),
  };
  const kind = (latex: string) => kindOf(parseRootLatex(cfg, latex), names);
  const split = (latex: string) => {
    const d = distribute(parseRootLatex(cfg, latex), names);
    return { latex: printLatex(cfg, d.root), count: d.count };
  };
  test("kinds", () => {
    expect(kind("2K+1")).toBe(Kind.Cold);
    expect(kind(String.raw`\sin(T)K`)).toBe(Kind.Hot);
    expect(kind("T+x")).toBe(Kind.Pixel);
    // Defined but not a constant: per pixel.
    expect(kind("p")).toBe(Kind.Pixel);
    // The graph's own functions count as per pixel.
    expect(kind("f(T)")).toBe(Kind.Pixel);
    expect(kind(String.raw`\pi T`)).toBe(Kind.Hot);
  });
  test("splits a changing product off a per-pixel sum", () => {
    expect(split(String.raw`\left(p-C\right)\cdot N`)).toEqual({
      latex: String.raw`p\cdot N-C\cdot N`,
      count: 1,
    });
    expect(split(String.raw`N\cdot\left(p+C\right)`).latex).toBe(
      String.raw`N\cdot p+N\cdot C`
    );
    expect(split(String.raw`\left(C-p\right)\cdot N`).latex).toBe(
      String.raw`C\cdot N-p\cdot N`
    );
    expect(split(String.raw`\left(-p-C\right)\cdot N`).latex).toBe(
      String.raw`-\left(p\cdot N+C\cdot N\right)`
    );
  });
  test("inside functions, parameters are per pixel", () => {
    expect(split(String.raw`g(a)=\left(a-C\right)\cdot N`).latex).toBe(
      String.raw`g\left(a\right)=a\cdot N-C\cdot N`
    );
  });
  test("leaves products alone when nothing changing would fold", () => {
    expect(split(String.raw`\left(p-K\right)\cdot N`).count).toBe(0);
    expect(split(String.raw`\left(p-x\right)\cdot N`).count).toBe(0);
    expect(split(String.raw`\left(T-C\right)\cdot N`).count).toBe(0);
    expect(split(String.raw`\left(p-C\right)\cdot x`).count).toBe(0);
  });
  test("split products print and read back the same", () => {
    const d = distribute(
      parseRootLatex(
        cfg,
        String.raw`c=\max\left(\left(p-C\right)\cdot N\right)`
      ),
      names
    );
    expect(roundTrips(cfg, d.root)).toBe(true);
  });

  const values = new Map<string, Value>([
    ["T", { type: "number", value: 1 }],
    ["P", { type: "point", value: [1, 2, 3] }],
  ]);
  const push = (
    latex: string,
    part: "color" | "restriction",
    syms: string[]
  ) => {
    const tree = pushToGpu(
      parseRootLatex(cfg, latex),
      part,
      new Map(syms.map((s) => [s, values.get(s)!])),
      "x"
    );
    return tree && printLatex(cfg, tree);
  };
  test("rebinds changing variables around a color", () => {
    expect(push(String.raw`c=\min(x-H)`, "color", ["T"])).toBe(
      String.raw`c=\operatorname{min}\left(x-H\right)\operatorname{with}T=T+0\cdot x`
    );
    expect(push(String.raw`c=\min(x-H)`, "color", ["P"])).toBe(
      String.raw`c=\operatorname{min}\left(x-H\right)\operatorname{with}P=P+0\cdot x\cdot \left(1,1,1\right)`
    );
  });
  test("joins an existing with, but never nests one", () => {
    expect(push(String.raw`c=a\operatorname{with}a=x`, "color", ["T"])).toBe(
      String.raw`c=a\operatorname{with}a=x,T=T+0\cdot x`
    );
    expect(
      push(String.raw`c=(a\operatorname{with}a=x)+1`, "color", ["T"])
    ).toBeUndefined();
    expect(
      push(String.raw`c=a\operatorname{with}T=x`, "color", ["T"])
    ).toBeUndefined();
  });
  test("rebinds each side of restrictions and inequalities", () => {
    expect(push(String.raw`z=0\left\{H>x\right\}`, "restriction", ["T"])).toBe(
      String.raw`z=0\cdot \left\{\left(H\operatorname{with}T=T+0\cdot x\right)>x\right\}`
    );
    expect(push(String.raw`z<H`, "restriction", ["T"])).toBe(
      String.raw`z<\left(H\operatorname{with}T=T+0\cdot x\right)`
    );
    expect(push(String.raw`z=0`, "restriction", ["T"])).toBeUndefined();
  });
});
