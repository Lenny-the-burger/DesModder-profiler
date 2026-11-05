import { barPercent, formatMs, symbolToLatex } from "./format";

describe("formatMs", () => {
  test.each([
    [0, "0 ms"],
    [0.001, "<0.01 ms"],
    [0.4242, "0.42 ms"],
    [12.34, "12.3 ms"],
    [152.4, "152 ms"],
    [2312, "2.31 s"],
  ])("%p -> %p", (ms, out) => {
    expect(formatMs(ms)).toBe(out);
  });
});

describe("symbolToLatex", () => {
  test.each([
    ["a", "a"],
    ["p_ipeProj", "p_{ipeProj}"],
    ["theta", "\\theta"],
    ["theta_1", "\\theta_{1}"],
    ["M_ag", "M_{ag}"],
  ])("%p -> %p", (sym, latex) => {
    expect(symbolToLatex(sym)).toBe(latex);
  });
});

describe("barPercent", () => {
  test("scales and keeps tiny nonzero values visible", () => {
    expect(barPercent(5, 10)).toBe(50);
    expect(barPercent(0, 10)).toBe(0);
    expect(barPercent(0.0001, 10)).toBe(0.5);
    expect(barPercent(1, 0)).toBe(0);
  });
});
