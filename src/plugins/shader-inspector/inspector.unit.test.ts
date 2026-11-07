import { attributeLines, shaderReport, usageOf } from "./report";
import { localStats, metricValue, nodeLatex, resolvePath } from "./tree";
import {
  createShaderTagger,
  costCategory,
  foldOf,
  foldSource,
  Frame,
  ShaderSourceInfo,
} from "./worker";

type Instr = Parameters<typeof foldOf>[1];

const chunkOf = (instructions: Instr[]) => ({
  instructions,
  getInstruction: (i: number) => instructions[i],
});

const fr = (
  input: string,
  start = 0,
  end = input.length,
  parent?: Frame
): Frame => ({ input, start, end, parent });

describe("foldSource", () => {
  const points = fr("points");
  const indices = fr("indices");
  const use = fr("use");
  const chunk = chunkOf([
    { type: 1, mobility: 2, value: [[1, 2, 3]], dsmSrc: points },
    { type: 1, mobility: 1, value: [1, 2], dsmSrc: indices },
    { type: 8, args: [0, 1], dsmSrc: fr("inner") },
    { type: 8, args: [2], dsmSrc: use },
  ]);
  const fold = foldOf(chunk, chunk.instructions[3]);

  test("finds changeable constants through computed arguments", () => {
    expect(fold.inputs.map((i) => i.dsmSrc)).toEqual([points, indices]);
  });

  test("a value computed from inputs is the folded instruction's", () => {
    expect(foldSource(fold, [[4, 5, 6]])).toBe(use);
    expect(foldSource(fold, [1, 2, 3])).toBe(use);
  });

  test("a coordinate of a point list is the point list's", () => {
    expect(foldSource(fold, [7])).toBe(points);
  });
});

describe("costCategory", () => {
  test("follows Desmos's cost table", () => {
    expect(costCategory({ type: 8 }, 1)).toBe("cheap");
    expect(costCategory({ type: 37, symbol: "sin" }, 5)).toBe("costly");
    expect(costCategory({ type: 37, symbol: "mean" }, 5)).toBe("reduction");
    expect(costCategory({ type: 37, symbol: "det" }, 28)).toBe("heavy");
    expect(costCategory({ type: 38 }, 3)).toBe("list");
    expect(costCategory({ type: 47 }, 0)).toBe("free");
    expect(costCategory({ type: 55 }, Infinity)).toBe("never");
  });
});

describe("createShaderTagger", () => {
  const node = (input: string, start?: number, end?: number) => ({
    getInputSpan: () => ({ input, start, end }),
  });

  test("tags instructions with the parse node being compiled", () => {
    const t = createShaderTagger();
    const chunk = chunkOf([]);
    const outer = t.enter(node("a=b+1", 2, 5));
    const i0: Instr = { type: 1 };
    t.tag(chunk, i0);
    chunk.instructions.push(i0);
    const inner = t.enter(node("b=2", 2, 3));
    const i1: Instr = { type: 8, args: [0] };
    t.tag(chunk, i1);
    t.exit(inner);
    const i2: Instr = { type: 8 };
    t.tag(chunk, i2);
    t.exit(outer);
    const i3: Instr = { type: 8, args: [0] };
    t.tag(chunk, i3);
    expect(i0.dsmSrc).toEqual(fr("a=b+1", 2, 5));
    expect(i1.dsmSrc).toEqual(fr("b=2", 2, 3, i0.dsmSrc));
    expect(i2.dsmSrc).toBe(i0.dsmSrc);
    expect(i3.dsmSrc).toBe(i0.dsmSrc);
  });

  test("a copy keeps the original's source", () => {
    const t = createShaderTagger();
    const chunk = chunkOf([]);
    t.enter(node("c=3"));
    const orig = fr("orig");
    const prev = t.copying({ type: 8, dsmSrc: orig });
    const copy: Instr = { type: 8 };
    t.tag(chunk, copy);
    t.copied(prev);
    expect(copy.dsmSrc).toBe(orig);
  });

  test("reports uniforms, lists and cost by frame", () => {
    const t = createShaderTagger();
    const outer = fr("f=s+1");
    const inner = fr("s=1", 2, 3, outer);
    const chunk = chunkOf([
      { type: 1, dsmSrc: inner },
      { type: 8, dsmSrc: outer },
    ]);
    const emitter = { chunk };
    t.constant(emitter, chunk.instructions[0]);
    t.uniform(emitter);
    t.constant(emitter, chunk.instructions[1]);
    t.list(emitter);
    t.cost(emitter, () => t.leaf(chunk, 0, 0) + t.leaf(chunk, 1, 1));
    const r = t.report(emitter)!;
    expect(r.sources).toEqual(["f=s+1", "s=1"]);
    expect(r.frames).toEqual([
      [0, 0, 5, -1],
      [1, 2, 3, 0],
    ]);
    expect(r.uniforms).toEqual([1]);
    expect(r.lists).toEqual([0]);
    expect(r.instructions).toEqual([1, 0]);
    expect(r.cost).toEqual([
      [1, "free", 0],
      [0, "cheap", 1],
    ]);
  });

  test("multiplies the cost inside nested loops", () => {
    const t = createShaderTagger();
    const f = fr("f");
    const chunk = chunkOf([{ type: 8, dsmSrc: f }]);
    const emitter = { chunk };
    t.cost(emitter, () =>
      t.loop(chunk, { type: 19, dsmSrc: f }, 10, () =>
        t.loop(
          chunk,
          { type: 19, callData: { type: "product" }, dsmSrc: f },
          5,
          () => t.leaf(chunk, 0, 1)
        )
      )
    );
    const r = t.report(emitter)!;
    expect(r.cost).toEqual([[0, "cheap", 50]]);
    expect(r.loops).toEqual([
      {
        kind: "sum",
        terms: 10,
        source: 0,
        bodyCost: 1,
        children: [
          { kind: "product", terms: 5, source: 0, bodyCost: 1, children: [] },
        ],
      },
    ]);
  });
});

describe("report", () => {
  const resolve = (latex: string) =>
    ({ "a=1": "1", "L=[1...3]": "2", "c=a+\\sin(L)": "3" })[latex];

  const info = (over: Partial<ShaderSourceInfo>): ShaderSourceInfo => ({
    sources: ["a=1", "L=[1...3]"],
    frames: [
      [0, 0, 3, -1],
      [1, 0, 9, -1],
    ],
    uniforms: [],
    lists: [],
    instructions: [],
    cost: [],
    loops: [],
    ...over,
  });

  test("attributes lines through instructions and lists", () => {
    const shader = {
      source: [
        "float _3;",
        "float[3] _C0=buildList(_DCG_SC_1,_DCG_SC_2,_DCG_SC_3);",
        "_3=(_DCG_SC_0);",
        "_3*=2.0;",
        "return _3;",
      ].join("\n"),
      shaderUniforms: [1, 1, 2, 3],
      costEstimate: 1,
      dsmInfo: info({ instructions: [-1, -1, -1, 0], lists: [1] }),
    };
    expect(attributeLines(shader, "9", resolve).map((l) => l.origin)).toEqual([
      "9",
      "2",
      "1",
      "1",
      "9",
    ]);
  });

  test("groups uniforms and counts literals of a full shader as baked", () => {
    const shader = {
      source: [
        "float[4] _C0=buildList(_DCG_SC_1,_DCG_SC_2,7.0,8.0);",
        "return _DCG_SC_0+_C0[0];",
      ].join("\n"),
      shaderUniforms: [1, 1, 2],
      costEstimate: 1,
      dsmInfo: info({ uniforms: [0, 1, 1], lists: [1] }),
    };
    const report = shaderReport({
      id: "9",
      colorId: undefined,
      surfaces: 1,
      programs: 1,
      shaders: { color: shader },
      budget: 3,
      resolve,
    });
    expect(report.singles).toMatchObject([{ origin: "1", slots: 1 }]);
    expect(report.lists).toMatchObject([{ origin: "2", slots: 2, baked: 2 }]);
    expect(usageOf(report, "2")).toMatchObject({ slots: 2, baked: 2 });
    const [color] = report.tree.children;
    expect(color.total.slots).toEqual({ single: 1, list: 2, baked: 2 });
  });

  test("builds a tree of the parts of each expression", () => {
    const c = "c=a+\\sin(L)";
    const shader = {
      source: ["_1=(_DCG_SC_0);", "_2=sin(_1);", "return _2;"].join("\n"),
      shaderUniforms: [1],
      costEstimate: 6,
      dsmInfo: info({
        sources: [c, "a=1", "L=[1...3]"],
        frames: [
          [0, 2, 11, -1], // a+\sin(L)
          [0, 2, 3, 0], // a
          [1, 2, 3, 1], // 1, inlined from a=1
          [0, 4, 11, 0], // \sin(L)
        ],
        uniforms: [2],
        instructions: [-1, 2, 3],
        cost: [
          [0, "cheap", 1],
          [3, "costly", 5],
        ],
      }),
    };
    const report = shaderReport({
      id: "3",
      colorId: undefined,
      surfaces: 1,
      programs: 1,
      shaders: { color: shader },
      budget: 10,
      resolve,
    });
    const [sum] = report.tree.children[0].children;
    expect(nodeLatex(sum)).toBe("a+\\sin(L)");
    expect(metricValue(sum.total, "cost")).toBe(6);
    const [a, sin] = sum.children;
    expect(nodeLatex(a)).toBe("a");
    expect(nodeLatex(sin)).toBe("\\sin(L)");
    expect(sin.self.cost).toEqual({ costly: 5 });
    const [one] = a.children;
    expect(one.origin).toBe("1");
    expect(one.self.slots).toEqual({ single: 1 });
    // What `a` adds, counting the definition inlined into it.
    expect(localStats(a).slots).toEqual({ single: 1 });
    expect(
      resolvePath(report.tree, ["color", sum.key, a.key, one.key]).length
    ).toBe(5);
  });

  test("a part holding only one other part of its expression merges with it", () => {
    const c = "c=a+\\sin(L)";
    const shader = {
      source: "return 1.0;",
      shaderUniforms: [],
      costEstimate: 5,
      dsmInfo: info({
        sources: [c],
        frames: [
          [0, 0, 11, -1], // c=a+\sin(L)
          [0, 2, 11, 0], // a+\sin(L)
          [0, 4, 11, 1], // \sin(L)
        ],
        cost: [[2, "costly", 5]],
      }),
    };
    const report = shaderReport({
      id: "3",
      colorId: undefined,
      surfaces: 1,
      programs: 1,
      shaders: { color: shader },
      budget: 10,
      resolve,
    });
    const [statement] = report.tree.children[0].children;
    expect(nodeLatex(statement)).toBe(c);
    expect(statement.self.cost).toEqual({ costly: 5 });
    expect(statement.children).toEqual([]);
  });
});
