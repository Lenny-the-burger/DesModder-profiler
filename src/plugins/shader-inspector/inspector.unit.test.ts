import { attributeLines, shaderReport, usageOf, withListNames } from "./report";
import {
  codeOf,
  localStats,
  metricValue,
  nodeLatex,
  opsIn,
  resolvePath,
} from "./tree";
import { opText, repeatsText } from "./text";
import {
  createShaderTagger,
  costCategory,
  foldOf,
  foldSource,
  Frame,
  LIST_TOKEN,
  listName,
  loopSymbols,
  opName,
  rootOperator,
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

describe("rootOperator", () => {
  test("is the operator applied last, outside any brackets", () => {
    expect(rootOperator("a_{v}\\cdot b_{v}")).toBe("a·b");
    expect(rootOperator("p_{v}-p_{1}")).toBe("a-b");
    expect(rootOperator("\\left(a-b\\right)\\times c")).toBe("a×b");
    expect(rootOperator("a\\cdot b+c")).toBe("a+b");
    expect(rootOperator("-a\\cdot b")).toBe("a·b");
    expect(rootOperator("\\left|v\\right|")).toBe("|a|");
    expect(rootOperator("\\left|a\\right|\\left|b\\right|")).toBe(undefined);
    expect(rootOperator("\\left(p_{2}-p_{1}\\right)\\left[n\\right]")).toBe(
      undefined
    );
  });
});

describe("opName", () => {
  test("names reading and making points after the operation written", () => {
    const dot = fr("d=a\\cdot b", 2);
    expect(opName({ type: 16 }, dot)).toBe("x/y/z for a·b");
    expect(opName({ type: 15 }, fr("c=p-q", 2))).toBe("make point for a-b");
    expect(opName({ type: 16 }, fr("k.x", 0))).toBe("x/y/z of point");
    expect(opName({ type: 37, symbol: "tan" }, dot)).toBe("tan()");
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
      [1, "free", 0, "op 1", -1, 1, 0],
      [0, "cheap", 1, "+", -1, 1, 1],
    ]);
  });

  test("multiplies the cost inside nested loops", () => {
    const t = createShaderTagger();
    const f = fr("f");
    const chunk = chunkOf([{ type: 8, dsmSrc: f }]);
    const emitter = { chunk };
    t.cost(emitter, () =>
      t.loop(
        chunk,
        { type: 19, callData: { indexSymbol: "i" }, dsmSrc: f },
        10,
        () =>
          t.loop(
            chunk,
            {
              type: 19,
              callData: { type: "product", indexSymbol: "_trapIdx" },
              dsmSrc: f,
            },
            5,
            () => t.leaf(chunk, 0, 1)
          )
      )
    );
    const r = t.report(emitter)!;
    expect(r.cost).toEqual([[0, "cheap", 50, "+", 1, 1, 1]]);
    expect(r.loops).toEqual([
      {
        id: 0,
        kind: "sum",
        terms: 10,
        symbols: ["i"],
        source: 0,
        bodyCost: 1,
        children: [
          {
            id: 1,
            kind: "product",
            terms: 5,
            symbols: [],
            source: 0,
            bodyCost: 1,
            children: [],
          },
        ],
      },
    ]);
  });

  test("names a broadcast by the lists it reads", () => {
    const chunk = chunkOf([
      { type: 1, value: [1, 2, 3, 4, 5], dsmSrc: fr("l", 0, 1) },
      { type: 1, value: [0, 1, 2, 3], dsmSrc: fr("a+[0,1,2,3]", 2, 11) },
      { type: 1, value: [1, 2], dsmSrc: fr("m=[1,2]", 2, 7) },
      { type: 23, context: { type: "implicit" }, endIndex: 8 },
      { type: 41, args: [0, 3] },
      { type: 41, args: [1, 3] },
      { type: 41, args: [2, 3] },
      { type: 8, args: [4, 5] },
      { type: 24 },
    ]);
    expect(loopSymbols(chunk.instructions[3], chunk, 3)).toEqual([
      "l",
      "[0, 1, 2, ...]",
      "m",
    ]);
  });

  test("names a list made by a function after what it is assigned to", () => {
    const def = "n=u(P)";
    const call = fr(def, 2, 6, fr(def));
    const body = fr("u(x)=\\frac{x}{2}", 5, 16, call);
    expect(listName(body)).toBe("n");
    // A part of a definition isn't the variable.
    expect(listName(fr("c=total(L)+1", 2, 10, fr("c=total(L)+1")))).toBe(
      undefined
    );
  });

  test("counts a reduction's elements like a loop", () => {
    const t = createShaderTagger();
    const f = fr("f");
    const chunk = chunkOf([
      { type: 1, value: [1, 2, 3], dsmSrc: fr("l", 0, 1) },
      {
        type: 23,
        context: {
          type: "list-comprehension",
          callData: { inputListSymbols: ["n"] },
        },
        endIndex: 3,
      },
      { type: 41, args: [0, 1] },
      { type: 24, args: [1, 2] },
      { type: 48, args: [3] },
      { type: 37, symbol: "total", args: [4], dsmSrc: f },
      { type: 37, symbol: "total", args: [0], dsmSrc: f },
    ]);
    const emitter = { chunk };
    t.cost(emitter, () => t.leaf(chunk, 5, 500) + t.leaf(chunk, 6, 15));
    const r = t.report(emitter)!;
    expect(r.cost).toEqual([
      [
        0,
        "reduction",
        500,
        "total()",
        -1,
        1,
        500,
        { terms: 100, symbols: ["n"] },
      ],
      [0, "reduction", 15, "total()", -1, 1, 15, { terms: 3, symbols: ["l"] }],
    ]);
  });

  test("groups the cost by operation and loop", () => {
    const t = createShaderTagger();
    const f = fr("f");
    const chunk = chunkOf([
      { type: 37, symbol: "tan", dsmSrc: f },
      { type: 37, symbol: "tan", dsmSrc: f },
      { type: 8, dsmSrc: f },
    ]);
    const emitter = { chunk };
    const comprehension = {
      type: 23,
      context: {
        type: "list-comprehension",
        callData: { inputListSymbols: ["n"] },
      },
      dsmSrc: f,
    };
    t.cost(
      emitter,
      () =>
        t.loop(chunk, comprehension, 100, () =>
          [0, 1, 2].reduce((c, i) => c + t.leaf(chunk, i, i < 2 ? 5 : 1), 0)
        ) + t.leaf(chunk, 0, 5)
    );
    const r = t.report(emitter)!;
    expect(r.loops[0].symbols).toEqual(["n"]);
    expect(r.cost).toEqual([
      [0, "costly", 1000, "tan()", 0, 2, 10],
      [0, "cheap", 100, "+", 0, 1, 1],
      [0, "costly", 5, "tan()", -1, 1, 5],
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
          [0, "cheap", 1, "+", -1, 1, 1],
          [3, "costly", 5, "sin()", -1, 1, 5],
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
    // The GLSL from the sum is the lines of the parts in it, in order.
    expect(codeOf(sum).map((l) => l.text)).toEqual([
      "_1=(_DCG_SC_0);",
      "_2=sin(_1);",
    ]);
    // What `a` adds, counting the definition inlined into it.
    expect(localStats(a).slots).toEqual({ single: 1 });
    expect(
      resolvePath(report.tree, ["color", sum.key, a.key, one.key]).length
    ).toBe(5);
  });

  test("splits the cost by loop and operation", () => {
    const shader = {
      source: "return 1.0;",
      shaderUniforms: [],
      costEstimate: 1510,
      dsmInfo: info({
        sources: ["f"],
        frames: [[0, 0, 1, -1]],
        cost: [
          [0, "costly", 1500, "tan()", 0, 3, 15],
          [0, "costly", 10, "tan()", -1, 2, 10],
        ],
        loops: [
          {
            id: 0,
            kind: "list",
            terms: 100,
            symbols: ["n"],
            source: 0,
            bodyCost: 15,
            children: [],
          },
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
      resolve: () => "3",
    });
    const stats = report.tree.total;
    expect(opsIn(stats, "costly").map(opText)).toEqual([
      "tan() (×100: n) (×3)",
      "tan() (×2)",
    ]);
    expect(repeatsText(stats)).toBe("15 × 100 (n) + 10");
  });

  test("names a list after a variable with the same values", () => {
    const loop = (symbols: string[]) => ({
      id: 0,
      kind: "list" as const,
      terms: 5,
      symbols,
      source: -1,
      bodyCost: 1,
      children: [],
    });
    const shader = {
      source: "return 1.0;",
      shaderUniforms: [],
      costEstimate: 5,
      dsmInfo: info({
        loops: [loop([`${LIST_TOKEN}0`]), loop([`${LIST_TOKEN}1`])],
        listValues: [
          [1, 2, 3, 4, 5],
          [5, 4, 3, 2, 1],
        ],
      }),
    };
    const named = withListNames(shader, (v) => (v[0] === 1 ? "l" : undefined));
    expect(named.dsmInfo!.loops.map((l) => l.symbols)).toEqual([
      ["l"],
      ["[5, 4, 3, ...]"],
    ]);
  });

  test("keeps nested loops apart", () => {
    const loop = {
      key: "color:1",
      runs: 1000,
      loops: [
        { terms: 100, symbols: ["m"] },
        { terms: 10, symbols: ["n"] },
      ],
    };
    const op = {
      category: "costly" as const,
      op: "tan()",
      loop,
      count: 1,
      base: 5,
      cost: 5000,
    };
    expect(opText(op)).toBe("tan() (×100: m) (×10: n)");
    expect(
      repeatsText({
        cost: {},
        ops: { k: op },
        slots: {},
        chars: 0,
        loopSteps: 0,
      })
    ).toBe("5 × 100 (m) × 10 (n)");
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
        cost: [[2, "costly", 5, "sin()", -1, 1, 5]],
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
