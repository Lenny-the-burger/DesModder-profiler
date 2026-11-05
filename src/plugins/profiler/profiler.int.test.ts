import { Calc as CalcType } from "#globals";
import { clean, testWithPage } from "#tests";

/** Only available inside evaluate() callbacks. */
declare let Calc: CalcType;
declare let DSM: Window["DSM"];

const POPUP = ".dcg-popover-interior.dsm-profiler-menu";
const BUTTON = "[data-buttonid='dsm-profiler-menu']";

describe("Profiler", () => {
  testWithPage("Menu opens and closes", async (driver) => {
    await driver.enablePlugin("profiler");
    await driver.click(BUTTON);
    await driver.assertSelector(POPUP);
    await driver.assertSelector(".dsm-profiler-record");
    await driver.click(BUTTON);
    await driver.assertSelectorNot(POPUP);

    await driver.clean();
    return clean;
  });

  testWithPage("Record button switches to Stop while open", async (driver) => {
    await driver.enablePlugin("profiler");
    await driver.click(BUTTON);
    await driver.assertSelector(POPUP);
    const label = async () =>
      await driver.$eval(".dsm-profiler-record", (e) =>
        (e as HTMLElement).innerText.trim()
      );
    expect(await label()).toBe("Record");
    await driver.click(".dsm-profiler-record");
    await driver.waitForFunction(
      () =>
        document.querySelector(".dsm-profiler-record")?.textContent?.trim() ===
        "Stop"
    );
    await driver.click(".dsm-profiler-record");
    expect(await label()).toBe("Record");

    await driver.click(BUTTON);
    await driver.clean();
    return clean;
  });

  testWithPage("Attributes cost per expression", async (driver) => {
    await driver.enablePlugin("profiler");
    await driver.evaluate(() => DSM.profiler!.startRecording());
    // `a` is a wackscope: it errors on its own, but works inside `f(b,c)`.
    await driver.evaluate(() =>
      Calc.setExpressions([
        { id: "1", latex: "a=b+c" },
        { id: "2", latex: "f(b,c)=a" },
        { id: "3", latex: "y=f\\left(x,1\\right)" },
      ])
    );
    await driver.waitForFunction(() => {
      const s = DSM.profiler!.getSummary();
      return s.expressions.some((r) => r.id === "3" && r.graph > 0);
    });
    const summary = await driver.evaluate(() => {
      const profiler = DSM.profiler!;
      profiler.stopRecording();
      return profiler.getSummary();
    });
    const row = (id: string) => summary.expressions.find((r) => r.id === id);
    expect(row("1")?.isError).toBe(true);
    expect(row("1")?.definedName).toBe("a");
    expect(row("3")?.isError).toBe(false);
    expect(row("3")?.canvas).toBeGreaterThan(0);
    const a = summary.sources.find((r) => r.symbol === "a");
    expect(a).toMatchObject({ kind: "id", definedBy: "1", wackscope: true });
    expect(a!.compiles).toBeGreaterThan(0);
    const f = summary.sources.find((r) => r.symbol === "f");
    expect(f).toMatchObject({ kind: "fn", definedBy: "2", wackscope: false });

    // Not recording: nothing more is collected.
    await driver.evaluate(() => Calc.setExpression({ id: "4", latex: "y=x" }));
    await driver.waitForFunction(
      () => Calc.expressionAnalysis["4"] !== undefined
    );
    const after = await driver.evaluate(
      () => DSM.profiler!.getSummary().expressions.length
    );
    expect(after).toBe(summary.expressions.length);

    await driver.clean();
    return clean;
  });
});
