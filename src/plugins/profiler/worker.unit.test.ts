import { createWorkerProfiler } from "./worker";

/** A clock that only advances when told to. */
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function setup() {
  const clock = fakeClock();
  const p = createWorkerProfiler(clock.now);
  p.setFlags({ enabled: true, gpu: false });
  return { clock, p };
}

const result = (definedName?: string, error?: string) => [
  {
    stmtAnalysis: {
      evaluationState: { defined_name: definedName, error },
    },
  },
];

describe("worker profiler", () => {
  test("is inert while disabled", () => {
    const clock = fakeClock();
    const p = createWorkerProfiler(clock.now);
    p.beginAnalysis("1", "main");
    expect(p.enter("a", "id")).toBeUndefined();
    p.hit("a");
    p.endAnalysis("1", result("a"));
    expect(p.drainChangeSet()).toBeUndefined();
    expect(p.drainFrame()).toBeUndefined();
    expect(p.timeSetProgram(() => 5)).toBe(5);
  });

  test("records analysis and graph time per statement", () => {
    const { clock, p } = setup();
    p.beginAnalysis("1", "main");
    clock.advance(3);
    p.endAnalysis("1", result("a"));
    p.beginGraph("1");
    clock.advance(7);
    p.endGraph("1");
    const out = p.drainChangeSet()!;
    expect(out.statements["1"]).toMatchObject({
      analysis: 3,
      analysisCount: 1,
      graph: 7,
      graphCount: 1,
      definedName: "a",
      isError: false,
    });
    // Drained.
    expect(p.drainChangeSet()!.statements).toEqual({});
  });

  test("ignores non-main analysis passes", () => {
    const { clock, p } = setup();
    p.beginAnalysis("1", "regression");
    clock.advance(3);
    p.endAnalysis("1", result());
    expect(p.drainChangeSet()!.statements).toEqual({});
  });

  test("records error state", () => {
    const { p } = setup();
    p.beginAnalysis("2", "main");
    p.endAnalysis("2", result("m", "Too many variables"));
    expect(p.drainChangeSet()!.statements["2"].isError).toBe(true);
  });

  test("splits inclusive and self time for nested symbols", () => {
    const { clock, p } = setup();
    p.beginAnalysis("1", "main");
    const outer = p.enter("f", "fn");
    clock.advance(1);
    const inner = p.enter("a", "id");
    clock.advance(4);
    p.exit(inner);
    clock.advance(2);
    p.exit(outer);
    // Second inlining of `a` in the same statement (e.g. wackscope).
    const again = p.enter("a", "id");
    clock.advance(5);
    p.exit(again);
    p.hit("a");
    p.endAnalysis("1", result());
    const tree = p.drainChangeSet()!.statements["1"].compileCalls;
    // `a` inside `f`, and `a` again at top level, are separate nodes.
    expect(tree).toEqual({
      "fn:f": {
        kind: "fn",
        symbol: "f",
        count: 1,
        hits: 0,
        time: 7,
        children: {
          "id:a": { kind: "id", symbol: "a", count: 1, hits: 0, time: 4 },
        },
      },
      "id:a": { kind: "id", symbol: "a", count: 1, hits: 1, time: 5 },
    });
  });

  test("merges repeated calls at the same path", () => {
    const { clock, p } = setup();
    p.beginAnalysis("1", "main");
    for (let i = 0; i < 3; i++) {
      const f = p.enter("f", "fn");
      const a = p.enter("a", "id");
      clock.advance(1);
      p.exit(a);
      p.exit(f);
    }
    p.endAnalysis("1", result());
    const tree = p.drainChangeSet()!.statements["1"].compileCalls;
    expect(tree["fn:f"].count).toBe(3);
    expect(tree["fn:f"].time).toBe(3);
    expect(tree["fn:f"].children!["id:a"].count).toBe(3);
  });

  test("keeps graph-phase calls separate from compile", () => {
    const { clock, p } = setup();
    p.beginGraph("1");
    const a = p.enter("a", "id");
    clock.advance(2);
    p.exit(a);
    p.endGraph("1");
    const stat = p.drainChangeSet()!.statements["1"];
    expect(stat.compileCalls).toEqual({});
    expect(stat.graphCalls["id:a"].time).toBe(2);
  });

  test("recovers when an exception skips an exit", () => {
    const { clock, p } = setup();
    p.beginAnalysis("1", "main");
    const outer = p.enter("f", "fn");
    p.enter("a", "id"); // never exited
    clock.advance(2);
    p.exit(outer);
    const next = p.enter("b", "id");
    clock.advance(1);
    p.exit(next);
    p.endAnalysis("1", result());
    const tree = p.drainChangeSet()!.statements["1"].compileCalls;
    expect(tree["fn:f"].count).toBe(1);
    expect(tree["fn:f"].time).toBe(2);
    // The abandoned `a` frame never completed.
    expect(tree["fn:f"].children!["id:a"].count).toBe(0);
    // `b` is not treated as nested in the abandoned `a` frame.
    expect(tree["id:b"].time).toBe(1);
  });

  test("attributes frame work to the tagged mesh", () => {
    const { clock, p } = setup();
    const mesh: { dsmId?: string } = {};
    p.tagSurface({ branchId: "12:3", surface: { mesh } });
    expect(mesh.dsmId).toBe("12");
    p.setDrawObject(mesh);
    p.timeSetProgram(() => clock.advance(4));
    p.setDrawObject(null);
    p.timeSetProgram(() => clock.advance(1));
    const frame = p.drainFrame()!;
    expect(frame.objects["12"].setProgram).toBe(4);
    expect(frame.objects["(unattributed)"].setProgram).toBe(1);
  });

  test("disabling drops partial data", () => {
    const { clock, p } = setup();
    p.beginAnalysis("1", "main");
    clock.advance(1);
    p.endAnalysis("1", result());
    p.setFlags({ enabled: false, gpu: false });
    p.setFlags({ enabled: true, gpu: false });
    expect(p.drainChangeSet()!.statements).toEqual({});
  });

  test("message hook reads flags before the original handler", () => {
    const p = createWorkerProfiler(() => 0);
    const seen: boolean[] = [];
    const scope = {
      onmessage: ((_ev: { data?: any }) => {
        seen.push(p.flags.enabled);
      }) as ((ev: { data?: any }) => any) | null,
    };
    p.installMessageHook(scope);
    scope.onmessage!({
      data: { dsmProfiler: { enabled: true, gpu: false } },
    });
    scope.onmessage!({ data: { dsmProfiler: undefined } });
    // Messages without the field (e.g. from a fake worker) leave flags alone.
    p.setFlags({ enabled: true, gpu: false });
    scope.onmessage!({ data: {} });
    expect(seen).toEqual([true, false, true]);
  });
});
