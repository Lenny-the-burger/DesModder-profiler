import { attributeLines, shaderReport, usageOf } from "./report";
import {
  createShaderTagger,
  foldOf,
  foldSource,
  ShaderSourceInfo,
} from "./worker";

type Instr = Parameters<typeof foldOf>[1];

const chunkOf = (instructions: Instr[]) => ({
  instructions,
  getInstruction: (i: number) => instructions[i],
});

describe("foldSource", () => {
  const chunk = chunkOf([
    { type: 1, mobility: 2, value: [[1, 2, 3]], dsmSrc: "points" },
    { type: 1, mobility: 1, value: [1, 2], dsmSrc: "indices" },
    { type: 8, args: [0, 1], dsmSrc: "inner" },
    { type: 8, args: [2], dsmSrc: "use" },
  ]);
  const fold = foldOf(chunk, chunk.instructions[3]);

  test("finds changeable constants through computed arguments", () => {
    expect(fold.inputs.map((i) => i.dsmSrc)).toEqual(["points", "indices"]);
  });

  test("a value computed from inputs is the folded instruction's", () => {
    expect(foldSource(fold, [[4, 5, 6]])).toBe("use");
    expect(foldSource(fold, [1, 2, 3])).toBe("use");
  });

  test("a coordinate of a point list is the point list's", () => {
    expect(foldSource(fold, [7])).toBe("points");
  });
});

describe("createShaderTagger", () => {
  const node = (input: string) => ({ getInputSpan: () => ({ input }) });

  test("tags instructions with the parse node being compiled", () => {
    const t = createShaderTagger();
    const chunk = chunkOf([]);
    const outer = t.enter(node("a=1"));
    const i0: Instr = { type: 1 };
    t.tag(chunk, i0);
    chunk.instructions.push(i0);
    const inner = t.enter(node("b=2"));
    const i1: Instr = { type: 8, args: [0] };
    t.tag(chunk, i1);
    t.exit(inner);
    const i2: Instr = { type: 8 };
    t.tag(chunk, i2);
    t.exit(outer);
    const i3: Instr = { type: 8, args: [0] };
    t.tag(chunk, i3);
    expect([i0, i1, i2, i3].map((i) => i.dsmSrc)).toEqual([
      "a=1",
      "b=2",
      "a=1",
      "a=1",
    ]);
  });

  test("a copy keeps the original's source", () => {
    const t = createShaderTagger();
    const chunk = chunkOf([]);
    t.enter(node("c=3"));
    const prev = t.copying({ type: 8, dsmSrc: "orig" });
    const copy: Instr = { type: 8 };
    t.tag(chunk, copy);
    t.copied(prev);
    expect(copy.dsmSrc).toBe("orig");
  });

  test("reports uniforms, lists and cost by source", () => {
    const t = createShaderTagger();
    const chunk = chunkOf([
      { type: 1, dsmSrc: "s" },
      { type: 8, dsmSrc: "f" },
    ]);
    const emitter = { chunk };
    t.constant(emitter, chunk.instructions[0]);
    t.uniform(emitter);
    t.constant(emitter, chunk.instructions[1]);
    t.list(emitter);
    t.cost(emitter, () => t.leaf(chunk, 0, 2) + t.leaf(chunk, 1, 3));
    const r = t.report(emitter)!;
    expect(r.sources).toEqual(["s", "f"]);
    expect(r.uniforms).toEqual([0]);
    expect(r.lists).toEqual([1]);
    expect(r.instructions).toEqual([0, 1]);
    expect(r.cost).toEqual([
      [0, 2],
      [1, 3],
    ]);
  });

  test("multiplies the cost inside nested loops", () => {
    const t = createShaderTagger();
    const chunk = chunkOf([{ type: 8, dsmSrc: "f" }]);
    const emitter = { chunk };
    t.cost(emitter, () =>
      t.loop(chunk, { type: 19, dsmSrc: "f" }, 10, () =>
        t.loop(
          chunk,
          { type: 19, callData: { type: "product" }, dsmSrc: "f" },
          5,
          () => t.leaf(chunk, 0, 1)
        )
      )
    );
    const r = t.report(emitter)!;
    expect(r.cost).toEqual([[0, 50]]);
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
  const resolve = (latex: string) => ({ "a=1": "1", "L=[1...3]": "2" })[latex];

  const info = (over: Partial<ShaderSourceInfo>): ShaderSourceInfo => ({
    sources: ["a=1", "L=[1...3]"],
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
  });
});
