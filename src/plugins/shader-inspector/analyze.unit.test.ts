import {
  DesmosShader,
  analyzeMaterial,
  analyzeShader,
  formatLoops,
  recompileReason,
} from "./analyze";

const shader = (
  source: string,
  shaderUniforms: number[] = [],
  costEstimate = 1
): DesmosShader => ({ source, shaderUniforms, costEstimate });

// What Desmos emits for hsv(sum_{i=1}^{n} sum_{j=1}^{n} sin(ix+jy),1,1).
const nestedSum = `float _34;float _35;float _39;float _40;float _45;float _47;float _48;float _50;
if((1.0)>(_DCG_SC_0)){
_50=(0.0);
}else{
_35=(0.0);
for(_34=(1.0);_34<=(_DCG_SC_0);_34++) {
if((1.0)>(_DCG_SC_1)){
_47=(0.0);
}else{
_40=(0.0);
for(_39=(1.0);_39<=(_DCG_SC_1);_39++) {
_45=(_40+(sin(((((_34*x))+((_39*y)))))));
if (_39<(_DCG_SC_1)) {
_40=_45;
} else {
_47=_45;
}
}
}
_48=(_35+_47);
if (_34<(_DCG_SC_0)) {
_35=_48;
} else {
_50=_48;
}
}
}
return (dcg_hsv(_50,(1.0),(1.0)));`;

describe("analyzeShader", () => {
  test("reads nested sums with uniform bounds", () => {
    const info = analyzeShader(shader(nestedSum, [10, 20]));
    expect(info.loops).toEqual([
      { terms: 10, children: [{ terms: 20, children: [] }] },
    ]);
    expect(formatLoops(info.loops)).toBe("10 × 20");
    expect(info.loopIterations).toBe(10 + 10 * 20);
  });

  test("handles empty and sibling loops", () => {
    const src =
      "for(_1=(1.0);_1<=(3.0);_1++) {for(_2=(5.0);_2<=(1.0);_2++) {}for(_3=(1.0);_3<=(2.0);_3++) {}}";
    const info = analyzeShader(shader(src));
    expect(formatLoops(info.loops)).toBe("3 × (0 + 2)");
    expect(info.loopIterations).toBe(3 + 0 + 6);
  });

  test("counts list slots and numbers written into lists", () => {
    const src =
      "vec3[2] _C0=buildList(vec3(_DCG_SC_0,_DCG_SC_1,_DCG_SC_2),vec3(0.5,-1.0,_DCG_SC_3));\nfloat[3] _C1=buildList(_DCG_SC_4,0.25,1.0);\nreturn 1.0;";
    const info = analyzeShader(shader(src, [1, 2, 3, 4, 5]));
    expect(info.lists).toEqual([
      { type: "vec3", length: 2, uniforms: 4, literals: 2 },
      { type: "float", length: 3, uniforms: 1, literals: 2 },
    ]);
  });
});

describe("analyzeMaterial", () => {
  test("restriction takes slots first, the color function gets the rest", () => {
    const r = shader("r", [1, 2, 3]);
    const c = shader("c", [4, 5, 6, 7]);
    const m = analyzeMaterial({ restriction: r, color: c }, 5);
    expect(m).toMatchObject({ uniforms: 7, overflow: 2, full: false });
    // The color function's last two values are part of the program.
    const changed = analyzeMaterial(
      { restriction: r, color: shader("c", [4, 5, 6, 8]) },
      5
    );
    expect(changed.key).not.toBe(m.key);
    const inBudget = analyzeMaterial(
      { restriction: r, color: shader("c", [9, 5, 6, 7]) },
      5
    );
    expect(inBudget.key).toBe(m.key);
  });

  test("flags a shader that filled the budget alone", () => {
    const m = analyzeMaterial({ color: shader("c", [1, 2, 3]) }, 3);
    expect(m).toMatchObject({ overflow: 0, full: true });
  });
});

describe("recompileReason", () => {
  const budget = 3;
  test("uniform value changes don't recompile", () => {
    const before = { color: shader("x*_DCG_SC_0", [1]) };
    const after = { color: shader("x*_DCG_SC_0", [2]) };
    expect(recompileReason(before, after, budget)).toBeUndefined();
  });

  test("numbers changing in a full shader were baked", () => {
    const before = {
      color: shader("_DCG_SC_0+_DCG_SC_1+_DCG_SC_2+0.5", [1, 2, 3]),
    };
    const after = {
      color: shader("_DCG_SC_0+_DCG_SC_1+_DCG_SC_2+0.7", [1, 2, 3]),
    };
    expect(recompileReason(before, after, budget)).toBe("baked");
  });

  test("numbers changing with slots to spare were typed", () => {
    const before = { color: shader("x*2.0", []) };
    const after = { color: shader("x*3.0", []) };
    expect(recompileReason(before, after, budget)).toBe("constant");
  });

  test("overflow between restriction and color is baked", () => {
    const r = shader("r", [1, 2]);
    const before = { restriction: r, color: shader("c", [1, 2]) };
    const after = { restriction: r, color: shader("c", [1, 9]) };
    expect(recompileReason(before, after, budget)).toBe("baked");
  });

  test("list length changes", () => {
    const before = { color: shader("float[2] _C0=buildList(1.0,2.0);") };
    const after = { color: shader("float[3] _C0=buildList(1.0,2.0,3.0);") };
    expect(recompileReason(before, after, budget)).toBe("list-length");
  });

  test("different code is a structure change", () => {
    const before = { color: shader("return x;") };
    const after = { color: shader("return y;") };
    expect(recompileReason(before, after, budget)).toBe("structure");
  });
});
