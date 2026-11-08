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
import { Definitions, hoistRepeats, inlineDefinitions } from "./inline";
import { foldAffine } from "./affine";
import { splitPoints, unrollLists } from "./unpack";
import type { Aug } from "../../../text-mode-core";
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

  test("lists with negative numbers typed in read back the same", () => {
    const root = parseRootLatex(cfg, String.raw`c=L\left[1\right]x`);
    const typed = substitute(
      root,
      new Map([["L", valueNode({ type: "list", value: [-0.1, 2] })]]),
      new Set()
    );
    expect(roundTrips(cfg, typed)).toBe(true);
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

describe("writing out and hoisting", () => {
  const r = String.raw;
  const fn = (latex: string) => {
    const f = parseRootLatex(cfg, latex);
    if (f.type !== "FunctionDefinition") throw new Error("not a function");
    return [f.symbol.symbol, f] as const;
  };
  const right = (latex: string) => {
    const d = parseRootLatex(cfg, latex);
    if (d.type !== "Assignment") throw new Error("not a definition");
    return [d.left.symbol, d.right] as const;
  };
  const defs: Definitions = {
    functions: new Map([
      fn(r`d(a)=\min(a-H)`),
      fn(r`g(a)=\sum_{n=1}^{3}a`),
      fn(r`k(a)=a\operatorname{with}T=2`),
      fn(r`w(a)=a+n`),
      fn(r`q(a)=q(a)`),
    ]),
    perPixel: new Map([right(r`A=\min(x-H)`), right(r`B=x+A`)]),
  };
  const inline = (latex: string) => {
    const out = inlineDefinitions(parseRootLatex(cfg, latex), defs);
    return { latex: printLatex(cfg, out.root), inlined: out.inlined.sort() };
  };
  test("writes calls out as their bodies", () => {
    expect(inline(r`c=d(x)+d(y)`)).toEqual({
      latex: r`c=\operatorname{min}\left(x-H\right)+\operatorname{min}\left(y-H\right)`,
      inlined: ["d"],
    });
  });
  test("writes out definitions read once, through each other", () => {
    expect(inline(r`c=B`)).toEqual({
      latex: r`c=x+\operatorname{min}\left(x-H\right)`,
      inlined: ["A", "B"],
    });
    // Read twice: computing it twice would cost more.
    expect(inline(r`c=A+A^{2}`).inlined).toEqual([]);
  });
  test("doesn't capture names or nest a with", () => {
    // `n` in the argument would be captured by the sum in `g`.
    expect(inline(r`c=g(n)`).inlined).toEqual([]);
    expect(inline(r`c=g(x)`).inlined).toEqual(["g"]);
    // `w` reads the global `n`, which the sum here binds.
    expect(inline(r`c=\sum_{n=1}^{3}w(x)`).inlined).toEqual([]);
    expect(inline(r`c=k(x)`).inlined).toEqual([]);
    expect(inline(r`c=q(x)`).latex).toContain("q");
  });

  const names: Names = {
    constants: new Set(["H", "T", "K"]),
    typedIn: new Set(["K"]),
    defined: new Set(["H", "T", "K"]),
  };
  const hoist = (latex: string) => {
    let i = 0;
    const out = hoistRepeats(parseRootLatex(cfg, latex), names, () => ({
      id: `n${++i}`,
      symbol: `G_rind${i}`,
    }));
    return {
      latex: printLatex(cfg, out.root),
      hoisted: out.hoisted.map((h) => printLatex(cfg, h.node)),
    };
  };
  test("moves repeated changing parts into definitions", () => {
    expect(hoist(r`c=\min(x-2H)+\min(y-2H)`)).toEqual({
      latex: r`c=\operatorname{min}\left(x-G_{rind1}\right)+\operatorname{min}\left(y-G_{rind1}\right)`,
      hoisted: [r`2\cdot H`],
    });
  });
  test("leaves single, typed-in and bound parts alone", () => {
    expect(hoist(r`c=\min(x-2H)+\min(y-3H)`).hoisted).toEqual([]);
    expect(hoist(r`c=\min(x-2K)+\min(y-2K)`).hoisted).toEqual([]);
    expect(hoist(r`c=\min(x-H)+\min(y-H)`).hoisted).toEqual([]);
    expect(hoist(r`c=\sum_{n=1}^{2}\min(x-nH)+\min(y-nH)`).hoisted).toEqual([]);
    expect(
      hoist(r`c=\left(\min(x-2H)+\min(y-2H)\right)\operatorname{with}T=1`)
        .hoisted
    ).toEqual([]);
  });
});

describe("folding affine values out of comprehensions", () => {
  const r = String.raw;
  const variables = new Map(
    [
      r`p=(x,y,z)`,
      r`c_{v}=\left(p-P\right)\left[n\right]`,
      r`d_{20}=c_{v}\cdot A\left[n\right]`,
      r`b_{V}=\frac{d_{20}D\left[n\right]}{E\left[n\right]}`,
      r`b_{W}=c_{v}\cdot B\left[n\right]`,
      r`b_{U}=1-b_{V}-b_{W}`,
      r`s=\sin(x)n`,
    ].map((l) => {
      const d = parseRootLatex(cfg, l);
      if (d.type !== "Assignment") throw new Error("not a definition");
      return [d.left.symbol, d.right] as const;
    })
  );
  const fold = (latex: string) => {
    let i = 0;
    const out = foldAffine(
      parseRootLatex(cfg, latex),
      latex.startsWith("c=") ? "color" : "restriction",
      { variables, functions: new Map() },
      () => ({ id: `n${++i}`, symbol: `G_rind${i}` })
    );
    return { ...out, latex: printLatex(cfg, out.root) };
  };
  test("folds affine values, looking through cheap sums", () => {
    const f = fold(
      r`c=\left[\min(b_{U},b_{V},b_{W})\operatorname{for}n=\left[1...80\right]\right]`
    );
    expect(f.folded).toEqual(["b_V", "b_W"]);
    // G_0, then G_x, G_y, G_z for each.
    expect(f.added).toHaveLength(8);
    expect(roundTrips(cfg, f.root)).toBe(true);
    for (const h of f.added)
      expect(
        roundTrips(cfg, {
          type: "Assignment",
          left: { type: "Identifier", symbol: h.symbol },
          right: h.node,
        })
      ).toBe(true);
    expect(f.latex).toContain(
      r`\operatorname{with}b_{V}=x\cdot G_{rind2}\left[n\right]+y\cdot G_{rind3}\left[n\right]+z\cdot G_{rind4}\left[n\right]+G_{rind1}\left[n\right]`
    );
    expect(printLatex(cfg, f.added[1].node)).toBe(
      r`\left[b_{V}\operatorname{with}x=1,y=0,z=0\operatorname{for}n=\left[1...80\right]\right]-G_{rind1}`
    );
  });
  test("folds whole lists when the shader broadcasts over them", () => {
    const f = fold(r`c=\min(b_{U},b_{V},b_{W})`);
    expect(f.folded).toEqual(["b_V", "b_W"]);
    expect(f.latex).toBe(
      r`c=\operatorname{min}\left(b_{U},b_{V},b_{W}\right)\operatorname{with}b_{V}=x\cdot G_{rind2}+y\cdot G_{rind3}+z\cdot G_{rind4}+G_{rind1},b_{W}=x\cdot G_{rind6}+y\cdot G_{rind7}+z\cdot G_{rind8}+G_{rind5}`
    );
    expect(printLatex(cfg, f.added[1].node)).toBe(
      r`\left(b_{V}\operatorname{with}x=1,y=0,z=0\right)-G_{rind1}`
    );
    expect(roundTrips(cfg, f.root)).toBe(true);
    // Each side of an inequality.
    expect(fold(r`z<b_{V}`).latex).toBe(
      r`z<\left(b_{V}\operatorname{with}b_{V}=x\cdot G_{rind2}+y\cdot G_{rind3}+z\cdot G_{rind4}+G_{rind1}\right)`
    );
  });
  test("leaves non-affine values, other lists and withs alone", () => {
    expect(
      fold(r`c=\left[s\operatorname{for}n=\left[1...80\right]\right]`).folded
    ).toEqual([]);
    expect(
      fold(r`c=\left[b_{V}\operatorname{for}n=\left[2...80\right]\right]`)
        .folded
    ).toEqual([]);
    expect(
      fold(r`c=\left[b_{V}\operatorname{for}n=\left[1...200\right]\right]`)
        .folded
    ).toEqual([]);
    expect(
      fold(
        r`c=\left[b_{V}\operatorname{for}n=\left[1...80\right]\right]\operatorname{with}T=1`
      ).folded
    ).toEqual([]);
  });
});

describe("taking points and short lists apart", () => {
  const r = String.raw;
  const plain = (s: string) => s.replace(/\\left|\\right/g, "");
  const split = (latex: string) => {
    const s = splitPoints(parseRootLatex(cfg, latex));
    return { latex: plain(printLatex(cfg, s.root)), count: s.count };
  };
  test("splits a piecewise of points by coordinate", () => {
    expect(
      split(r`f(t)=\left\{t.x<1:\left(t.x+1,t.y,2\right),t\right\}`)
    ).toEqual({
      latex: r`f(t)=(\{t.x<1:t.x+1,t.x\},\{t.x<1:t.y,t.y\},\{t.x<1:2,t.z\})`,
      count: 1,
    });
    expect(
      split(r`p=\left\{x<1:\left(1,x\right),y<2:\left(x,2\right),q\right\}`)
    ).toEqual({
      // The inner piecewise is split, then the outer. `{c:1,…}` prints as
      // `{c,…}`.
      latex: r`p=(\{x<1,y<2:x,q.x\},\{x<1:x,y<2:2,q.y\})`,
      count: 2,
    });
  });
  test("leaves numbers, costly conditions and other branches alone", () => {
    expect(split(r`p=\left\{x<1:2,3\right\}`).count).toBe(0);
    expect(split(r`p=\left\{g(x)<1:\left(1,2,3\right),q\right\}`).count).toBe(
      0
    );
    expect(
      split(r`p=\left\{x<1:\left(1,2,3\right),q+\left(1,1,1\right)\right\}`)
        .count
    ).toBe(0);
  });

  const values = new Map<string, Value>([
    ["L", { type: "list", value: [1, 2, 3] }],
    ["S", { type: "list", value: [4, 5, 6] }],
    ["N", { type: "number", value: 3 }],
    [
      "P",
      {
        type: "points",
        value: [
          [1, 2],
          [3, 4],
          [5, 6],
        ],
      },
    ],
    ["V", { type: "list", value: [7, 8] }],
    // A slider that changes.
    ["T", { type: "number", value: 7 }],
  ]);
  const unroll = (latex: string, ...defs: string[]) => {
    const variables = new Map<string, Aug.Latex.AnyChild>();
    const functions = new Map<string, Aug.Latex.FunctionDefinition>();
    for (const d of defs) {
      const root = parseRootLatex(cfg, d);
      if (root.type === "Assignment")
        variables.set(root.left.symbol, root.right);
      if (root.type === "FunctionDefinition")
        functions.set(root.symbol.symbol, root);
    }
    const u = unrollLists(parseRootLatex(cfg, latex), {
      values,
      fixed: new Set(["L", "S", "N", "P"]),
      variables,
      functions,
    });
    return { latex: plain(printLatex(cfg, u.root)), count: u.count };
  };
  test("writes out sums and products with fixed bounds", () => {
    expect(unroll(r`a=\sum_{n=1}^{N}L\left[n\right]x`).latex).toBe(
      r`a=L[1]\cdot x+L[2]\cdot x+L[3]\cdot x`
    );
    // A definition reading the index sees it through a with.
    expect(unroll(r`a=\prod_{n=1}^{2}qx`, r`q=L\left[n\right]`).latex).toBe(
      r`a=(q\cdot x\operatorname{with}n=1)\cdot (q\cdot x\operatorname{with}n=2)`
    );
    expect(unroll(r`a=\sum_{n=1}^{L.\operatorname{count}}n`).latex).toBe(
      r`a=1+2+3`
    );
  });
  test("writes out reductions of short lists", () => {
    expect(
      unroll(r`a=\operatorname{total}\left(\sin\left(xL\right)\right)`).latex
    ).toBe(
      r`a=\operatorname{sin}(x\cdot L[1])+\operatorname{sin}(x\cdot L[2])+\operatorname{sin}(x\cdot L[3])`
    );
    // Broadcasts stop at the shortest list, and go through functions.
    expect(
      unroll(
        r`a=\min\left(b\left(\left(x,y,z\right)-P,S\right)\right)`,
        r`b\left(p,s\right)=\left|p.x\right|-s`
      ).latex
    ).toBe(r`a=\operatorname{min}(b((x,y,z)-P[1],S[1]),b((x,y,z)-P[2],S[2]))`);
    // A max of several values goes element by element, a max of one list
    // takes the whole list.
    expect(
      unroll(
        r`a=\min\left(b\left(P\right)\right)`,
        r`b\left(p\right)=\max\left(p.x,1\right)`
      ).count
    ).toBe(1);
    expect(
      unroll(
        r`a=\min\left(b\left(P\right)\right)`,
        r`b\left(p\right)=\max\left(p.x\right)`
      ).count
    ).toBe(0);
    // Definitions a function's body reads see its parameters.
    expect(
      unroll(
        r`a=\operatorname{total}\left(b\left(L\right)\right)`,
        r`b\left(p\right)=q+1`,
        r`q=2p`
      ).latex
    ).toBe(r`a=b(L[1])+b(L[2])+b(L[3])`);
    expect(
      unroll(
        r`a=\operatorname{total}\left(b\left(L\right)\right)`,
        r`b\left(p\right)=q+1`,
        r`q=\operatorname{total}\left(p\right)`
      ).count
    ).toBe(0);
    expect(
      unroll(
        r`a=\operatorname{mean}\left(\left[xn\operatorname{for}n=\left[1...3\right]\right]\right)`
      ).latex
    ).toBe(r`a=\frac{x\cdot 1+x\cdot 2+x\cdot 3}{3}`);
    expect(unroll(r`a=\max\left(\left[x,y,2\right]\right)`).latex).toBe(
      r`a=\operatorname{max}(x,y,2)`
    );
  });
  test("unrolls changing lists only when their length is written out", () => {
    // V changes, but is written element by element.
    expect(
      unroll(r`a=\operatorname{total}\left(xV\right)`, r`V=\left[T,8\right]`)
        .latex
    ).toBe(r`a=x\cdot V[1]+x\cdot V[2]`);
    expect(
      unroll(r`a=\operatorname{total}\left(xV\right)`, r`V=\left[1...T\right]`)
        .count
    ).toBe(0);
  });
  test("leaves lists that change, long lists and whole-list uses alone", () => {
    expect(unroll(r`a=\operatorname{total}\left(xV\right)`).count).toBe(0);
    expect(
      unroll(
        r`a=\operatorname{total}\left(L\operatorname{length}\left(L\right)\right)`
      ).count
    ).toBe(0);
    expect(
      unroll(
        r`a=\operatorname{total}\left(f\left(L\right)\right)`,
        r`f\left(l\right)=l\operatorname{total}\left(l\right)`
      ).count
    ).toBe(0);
    expect(
      unroll(r`a=\operatorname{total}\left(xw\right)`, r`w=xL`).count
    ).toBe(0);
    expect(unroll(r`a=\sum_{n=1}^{100}nx`).count).toBe(0);
  });
});
