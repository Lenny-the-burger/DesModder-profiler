import {
  Recording,
  addToTimeline,
  emptyRecording,
  median,
  summarize,
} from "./aggregate";
import { CallNode, CallTree, StatementStat, UNATTRIBUTED } from "./types";

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

function call(
  symbol: string,
  partial: Partial<CallNode>,
  kind: "id" | "fn" = "id"
): CallTree {
  return {
    [`${kind}:${symbol}`]: {
      kind,
      symbol,
      count: 0,
      hits: 0,
      time: 0,
      ...partial,
    },
  };
}

describe("summarize", () => {
  // `a=b+1` is a wackscope: on its own it errors (b is undefined), but it is
  // compiled inside `f(b)=a` where b is bound.
  const rec: Recording = {
    changeSets: [
      {
        updateAnalysis: 10,
        graphAllChanges: 6,
        timeInWorker: 20,
        profile: {
          statements: {
            "1": stmt({ analysis: 1, definedName: "a", isError: true }),
            "2": stmt({
              analysis: 4,
              definedName: "f",
              compileCalls: call("a", { count: 1, time: 3 }),
            }),
            "3": stmt({
              analysis: 2,
              graph: 5,
              compileCalls: {
                ...call(
                  "f",
                  {
                    count: 2,
                    time: 2,
                    children: call("a", { count: 2, time: 1 }),
                  },
                  "fn"
                ),
                ...call("c", { hits: 3 }),
              },
            }),
          },
        },
      },
    ],
    frames: [
      {
        gpuTimer: true,
        objects: {
          "3": {
            draws: 2,
            cpuDraw: 0.5,
            gpu: 2,
            gpuSamples: 2,
            setProgram: 80,
            block: 79,
            links: 1,
          },
          [UNATTRIBUTED]: {
            draws: 1,
            cpuDraw: 0.1,
            gpu: 1,
            gpuSamples: 1,
            setProgram: 0,
            block: 0,
            links: 0,
          },
        },
      },
    ],
    redraws: [{ "2": 1.5 }],
    updates: [],
  };
  const s = summarize(rec, UNATTRIBUTED);

  test("rows by expression, sorted by median", () => {
    expect(s.expressions.map((r) => r.id)).toEqual(["3", "2", "1"]);
    expect(s.expressions[0]).toMatchObject({
      analysis: 2,
      graph: 5,
      setProgram: 80,
      shaderBlock: 79,
      gpu: 2,
      links: 1,
      total: 2 + 5 + 0.5 + 80,
    });
    expect(s.expressions[1]).toMatchObject({ canvas: 1.5, total: 5.5 });
    expect(s.gpuTimer).toBe(true);
  });

  test("unattributed 3D work is split out", () => {
    expect(s.unattributed3D).toMatchObject({ gpu: 1, draws: 1 });
  });

  test("overhead is what per-statement rows don't cover", () => {
    expect(s.overhead).toEqual({ analysis: 3, graph: 1, other: 4, render: 0 });
  });

  test("sources are summed across expressions", () => {
    const a = s.sources.find((r) => r.symbol === "a")!;
    expect(a).toMatchObject({
      compiles: 3,
      self: 4,
      usedBy: 2,
      definedBy: "1",
      wackscope: true,
    });
    const f = s.sources.find((r) => r.symbol === "f")!;
    expect(f).toMatchObject({ kind: "fn", definedBy: "2", wackscope: false });
    // Pure cache hits are hidden.
    expect(s.sources.find((r) => r.symbol === "c")).toBeUndefined();
  });

  test("a definition that errors but is not used elsewhere is not wackscope", () => {
    const only = summarize(
      {
        changeSets: [
          {
            updateAnalysis: 0,
            graphAllChanges: 0,
            timeInWorker: 0,
            profile: {
              statements: {
                "1": stmt({
                  definedName: "a",
                  isError: true,
                  compileCalls: call("a", { count: 1 }),
                }),
              },
            },
          },
        ],
        frames: [],
        redraws: [],
        updates: [],
      },
      UNATTRIBUTED
    );
    expect(only.sources[0].wackscope).toBe(false);
  });
});

describe("frames", () => {
  test("a redraw joins the frame of the change set before it", () => {
    const rec = emptyRecording();
    addToTimeline(rec, "changeSet", 0);
    addToTimeline(rec, "frame", 0);
    // Another redraw (rotating the view) is a frame of its own.
    addToTimeline(rec, "frame", 1);
    addToTimeline(rec, "changeSet", 1);
    addToTimeline(rec, "changeSet", 2);
    addToTimeline(rec, "redraw", 0);
    expect(rec.updates).toEqual([
      { changeSet: 0, frame: 0 },
      { frame: 1 },
      { changeSet: 1 },
      { changeSet: 2, redraw: 0 },
    ]);
  });

  test("median", () => {
    expect(median([])).toBe(0);
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  test("overview averages per frame, and medians per expression", () => {
    const changeSet = (analysis: number) => ({
      updateAnalysis: analysis + 1,
      graphAllChanges: 0,
      timeInWorker: analysis + 3,
      profile: { statements: { "1": stmt({ analysis, parse: 1 }) } },
    });
    const frame = (cpuDraw: number, durationCPU: number) => ({
      gpuTimer: false,
      durationCPU,
      objects: {
        "1": {
          draws: 1,
          cpuDraw,
          gpu: 0,
          gpuSamples: 0,
          setProgram: 0,
          block: 0,
          links: 0,
        },
      },
    });
    const rec: Recording = {
      ...emptyRecording(),
      changeSets: [changeSet(2), changeSet(10)],
      frames: [frame(1, 2), frame(1, 2), frame(1, 2)],
      updates: [
        { changeSet: 0, frame: 0 },
        { changeSet: 1, frame: 1 },
        { frame: 2 },
      ],
    };
    const s = summarize(rec, UNATTRIBUTED);
    // Frames: 1+2+1 parse+analysis+draw = 4, 1+10+1 = 12, then 1 draw only.
    expect(s.expressions[0]).toMatchObject({ median: 4, samples: 3 });
    expect(s.overview.frames).toBe(3);
    const c = s.overview.categories;
    expect(c.parse).toBeCloseTo(2 / 3);
    expect(c.compile).toBeCloseTo((3 + 11) / 3);
    expect(c.other).toBeCloseTo(2 / 3);
    // Draw includes 3D frame time outside any draw call.
    expect(c.draw).toBeCloseTo(2);
    expect(s.overhead.render).toBeCloseTo(3);
    expect(s.overview.average).toBeCloseTo(
      Object.values(c).reduce((a, b) => a + b, 0)
    );
  });
});
