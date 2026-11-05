import { Recording, summarize } from "./aggregate";
import {
  FlameLabels,
  FlameNode,
  buildFlameTree,
  flameSelf,
  latexToText,
  matchedTime,
  mergeCallTrees,
  resolvePath,
  symbolToText,
} from "./flame";
import { layoutFlame } from "./flame-layout";
import { CallTree, StatementStat, UNATTRIBUTED } from "./types";

const labels: FlameLabels = {
  root: (m) => `root-${m}`,
  phase: (p) => `phase-${p}`,
  expression: (id) => `expr-${id}`,
  definition: (s, k) => (k === "fn" ? `${s}()` : s),
  unattributed: "unattributed",
  shaderWait: "wait",
};

function stmt(partial: Partial<StatementStat>): StatementStat {
  return {
    parse: 0,
    analysis: 0,
    analysisCount: 1,
    graph: 0,
    graphCount: 0,
    isError: false,
    compileCalls: {},
    graphCalls: {},
    ...partial,
  };
}

const tree = (time: number, children?: CallTree): CallTree[string] => ({
  kind: "id",
  symbol: "a",
  count: 1,
  hits: 0,
  time,
  children,
});

// Expression 2 inlines `a` (which itself errors: a wackscope) twice,
// across two change sets.
const rec: Recording = {
  changeSets: [1, 2].map(() => ({
    updateAnalysis: 6,
    graphAllChanges: 3,
    timeInWorker: 12,
    profile: {
      statements: {
        "1": stmt({ analysis: 0.5, definedName: "a", isError: true }),
        "2": stmt({
          analysis: 4,
          graph: 2,
          compileCalls: { "id:a": tree(3) },
        }),
      },
    },
  })),
  frames: [
    {
      gpuTimer: true,
      objects: {
        "2": {
          draws: 1,
          cpuDraw: 0.5,
          gpu: 3,
          gpuSamples: 1,
          setProgram: 10,
          block: 8,
          links: 1,
        },
        [UNATTRIBUTED]: {
          draws: 1,
          cpuDraw: 0.2,
          gpu: 1,
          gpuSamples: 1,
          setProgram: 0,
          block: 0,
          links: 0,
        },
      },
    },
  ],
  sketches: {},
};
const summary = summarize(rec, UNATTRIBUTED);
const child = (n: FlameNode, key: string) =>
  n.children.find((c) => c.key === key)!;

describe("buildFlameTree", () => {
  test("by phase", () => {
    const root = buildFlameTree(
      rec,
      summary,
      { grouping: "phase", metric: "cpu" },
      labels
    );
    const compile = child(root, "compile");
    // 2 change sets × (0.5 + 4) per statement, plus 2 × 1.5 overhead.
    expect(compile.value).toBeCloseTo(12);
    const e2 = child(compile, "2");
    expect(e2).toMatchObject({ value: 8, kind: "expression" });
    // `a` merged across change sets, and known to be a wackscope.
    expect(child(e2, "id:a")).toMatchObject({
      value: 6,
      count: 2,
      definedBy: "1",
      wackscope: true,
    });
    expect(child(compile, UNATTRIBUTED).value).toBeCloseTo(3);
    const shader = child(root, "shader");
    expect(child(child(shader, "2"), "wait").value).toBe(8);
    expect(child(root, "other").value).toBeCloseTo(6);
    // Children are sorted, largest first.
    const values = root.children.map((c) => c.value);
    expect([...values].sort((a, b) => b - a)).toEqual(values);
    // Root is the sum of its children.
    expect(root.value).toBeCloseTo(values.reduce((a, b) => a + b, 0));
  });

  test("by expression", () => {
    const root = buildFlameTree(
      rec,
      summary,
      { grouping: "expression", metric: "cpu" },
      labels
    );
    const e2 = child(root, "2");
    expect(e2.value).toBeCloseTo(8 + 4 + 0.5 + 10);
    expect(child(e2, "compile").children[0].key).toBe("id:a");
    const un = child(root, UNATTRIBUTED);
    expect(child(un, "draw").value).toBeCloseTo(0.2);
  });

  test("GPU", () => {
    const root = buildFlameTree(
      rec,
      summary,
      { grouping: "phase", metric: "gpu" },
      labels
    );
    expect(root.value).toBe(4);
    expect(root.children.map((c) => c.key)).toEqual(["2", UNATTRIBUTED]);
  });
});

describe("helpers", () => {
  test("mergeCallTrees merges nested paths", () => {
    const target: CallTree = { "id:a": tree(1, { "id:a": tree(1) }) };
    mergeCallTrees(target, { "id:a": tree(2, { "id:a": tree(1) }) });
    expect(target["id:a"].time).toBe(3);
    expect(target["id:a"].count).toBe(2);
    expect(target["id:a"].children!["id:a"].time).toBe(2);
  });

  test("resolvePath stops at missing keys", () => {
    const root = buildFlameTree(
      rec,
      summary,
      { grouping: "phase", metric: "cpu" },
      labels
    );
    expect(resolvePath(root, ["compile", "2"]).map((n) => n.key)).toEqual([
      "root",
      "compile",
      "2",
    ]);
    expect(resolvePath(root, ["compile", "nope", "2"])).toHaveLength(2);
  });

  test("flameSelf and matchedTime", () => {
    const leaf = (key: string, value: number): FlameNode => ({
      key,
      name: key,
      kind: "definition",
      category: "compile",
      value,
      children: [],
    });
    const node: FlameNode = {
      ...leaf("x", 10),
      children: [leaf("a", 3), { ...leaf("b", 4), children: [leaf("a", 1)] }],
    };
    expect(flameSelf(node)).toBe(3);
    // Nested matches inside a match aren't double counted.
    expect(matchedTime(node, (n) => n.name === "a")).toBe(4);
    expect(matchedTime(node, (n) => n.name === "x")).toBe(10);
  });

  test.each([
    [
      "p_{rojRes}=c_{amPipeIO}\\left(v_{erts}\\right)",
      "projRes=camPipeIO(verts)",
    ],
    ["\\operatorname{polygon}\\left(a\\right)", "polygon(a)"],
    ["y=\\frac{1}{x}", "y=(1)/(x)"],
    ["\\left\\{x<1:2\\right\\}", "{x<1:2}"],
    ["a\\cdot\\sin\\left(x\\right)", "a * sin(x)"],
    ["a\\to a+1", "a -> a+1"],
    ["\\theta_{1}=\\tau", "theta1=tau"],
    ["x\\operatorname{with}a=1", "x with a=1"],
    [
      "\\left[i\\operatorname{for}i=\\left[1...3\\right]\\right]",
      "[i for i=[1...3]]",
    ],
    ["\\token{3}+1", "#+1"],
    [
      "1-\\frac{p_{oly}-p_{oly}.\\min}{p_{oly}.\\max}",
      "1-(poly-poly.min)/(poly.max)",
    ],
    ["\\frac{1}{\\sqrt{\\frac{a}{2}}}", "(1)/(sqrt((a)/(2)))"],
    ["a\\ b", "a b"],
  ])("latexToText(%p)", (latex, text) => {
    expect(latexToText(latex)).toBe(text);
  });

  test.each([
    ["p_rojRes", "projRes"],
    ["f", "f"],
    ["a_1", "a1"],
  ])("symbolToText(%p)", (symbol, text) => {
    expect(symbolToText(symbol)).toBe(text);
  });
});

describe("layoutFlame", () => {
  const root = buildFlameTree(
    rec,
    summary,
    { grouping: "phase", metric: "cpu" },
    labels
  );

  test("root spans the width; children are proportional", () => {
    const rects = layoutFlame([root], 1000);
    expect(rects[0]).toMatchObject({ x: 0, w: 1000, row: 0, keys: [] });
    const compile = rects.find((r) => r.row === 1 && r.node.key === "compile")!;
    expect(compile.w).toBeCloseTo((1000 * compile.node.value) / root.value);
    const a = rects.find((r) => r.node.key === "id:a")!;
    expect(a.keys).toEqual(["compile", "2", "id:a"]);
    expect(a.row).toBe(3);
  });

  test("zoomed node is full width, ancestors above it", () => {
    const chain = resolvePath(root, ["compile", "2"]);
    const rects = layoutFlame(chain, 500);
    expect(rects.filter((r) => r.ancestor).map((r) => r.node.key)).toEqual([
      "root",
      "compile",
    ]);
    const zoomed = rects.find((r) => !r.ancestor)!;
    expect(zoomed).toMatchObject({ x: 0, w: 500, row: 2 });
    const a = rects.find((r) => r.node.key === "id:a")!;
    expect(a.w).toBeCloseTo(500 * (6 / 8));
  });
});
