import ShaderInspector, { SurfaceRow } from ".";
import "./ShaderInspectorView.less";
import { MAX_LOOP_TERMS, RECOMPILE_REASONS } from "./analyze";
import { LoopRow, Origin, PartReport, UniformGroup, usageOf } from "./report";
import { DetailView } from "./DetailView";
import { fmt, latexToText } from "./text";
import { Component, jsx } from "#DCGView";
import {
  Button,
  For,
  IconButton,
  If,
  StaticMathQuillView,
  Tooltip,
} from "#components";
import { format } from "#i18n";

/** A bar is made of segments, each a share of the whole. */
interface Segment {
  key: string;
  origin: Origin;
  /** Share of the bar's scale. */
  value: number;
  /** Drawn hatched: values written into the source past the limit. */
  over?: boolean;
  /** Unused room up to the limit. */
  free?: boolean;
  tooltip: string;
}

function shortLabel(si: ShaderInspector, origin: Origin) {
  if (origin === undefined) return format("shader-inspector-untraced");
  const latex = si.expressionLatex(origin);
  const text = latex ? latexToText(latex) : origin;
  return text.length > 40 ? text.slice(0, 39) + "…" : text;
}

/** Desmos's cost per instruction, as rows of the cost explanation. */
type CostRow = readonly [string, string];
const COST_ROWS: readonly CostRow[] = [
  ["0", "free"],
  ["1", "cheap"],
  ["5", "costly"],
  ["9–300", "heavy"],
  ["5 × n", "reduction"],
  ["n", "list"],
  ["∞", "never"],
];

/** How Desmos estimates a shader's cost, for the "?" next to it. */
function costHelp(limit: () => number) {
  return (
    <div class="dsm-si-help-box">
      <div class="dsm-si-help-intro">
        {() =>
          format("shader-inspector-cost-help-intro", { limit: fmt(limit()) })
        }
      </div>
      <div class="dsm-si-help-table">
        <For each={() => COST_ROWS} key={(r: CostRow) => r[1]}>
          {(r: () => CostRow) => (
            <div class="dsm-si-help-row">
              <span class="dsm-si-help-cost">{() => r()[0]}</span>
              <span>{() => format(`shader-inspector-cost-row-${r()[1]}`)}</span>
            </div>
          )}
        </For>
      </div>
      <div class="dsm-si-help-intro">
        {format("shader-inspector-cost-help-loops")}
      </div>
    </div>
  );
}

/** A segmented bar: each segment's width is its share of `scale`. */
function bar(
  si: ShaderInspector,
  segments: () => Segment[],
  scale: () => number,
  limit?: () => number | undefined
) {
  const pct = (v: number) => `${(100 * v) / Math.max(1e-9, scale())}%`;
  return (
    <div class="dsm-si-bar">
      <For each={segments} key={(s: Segment) => s.key}>
        {(s: () => Segment) => (
          // Desmos wraps a tooltip's child in its own element, so the width
          // goes on a span around the tooltip, which the segment fills.
          <span
            class="dsm-si-bar-slot"
            style={() => ({ width: pct(s().value) })}
          >
            <Tooltip tooltip={() => s().tooltip} gravity="s">
              <span
                class={() => ({
                  "dsm-si-bar-segment": true,
                  "dsm-si-bar-over": !!s().over,
                  "dsm-si-bar-free": !!s().free,
                })}
                style={() => ({
                  background: s().free ? "" : si.originColor(s().origin),
                })}
                onTap={() => {
                  const o = s().origin;
                  if (!s().free && o !== undefined) si.jumpTo(o);
                }}
              />
            </Tooltip>
          </span>
        )}
      </For>
      <If predicate={() => limit?.() !== undefined}>
        {() => (
          <span
            class="dsm-si-bar-limit"
            style={() => ({ left: pct(limit!()!) })}
          />
        )}
      </If>
    </div>
  );
}

export class ShaderInspectorView extends Component<{
  si: () => ShaderInspector;
}> {
  si = () => this.props.si();
  report = () => this.si().report();

  template() {
    return (
      <div class="dcg-popover-interior dsm-shader-inspector-menu">
        <div class="dsm-si-title-row">
          <If predicate={() => this.si().selectedId !== undefined}>
            {() => (
              <Tooltip tooltip={format("shader-inspector-back")} gravity="s">
                <Button
                  color="light-gray"
                  class="dsm-si-back"
                  onTap={() =>
                    this.si().detailOpen
                      ? this.si().closeDetail()
                      : this.si().select(undefined)
                  }
                >
                  ‹
                </Button>
              </Tooltip>
            )}
          </If>
          <div class="dcg-popover-title">{format("shader-inspector-name")}</div>
          <Tooltip tooltip={format("shader-inspector-pin")} gravity="s">
            <IconButton
              iconClass="dsm-icon-bookmark"
              onTap={() => this.si().togglePinned()}
              btnClass={() => ({
                "dsm-si-pin": true,
                "dsm-selected": this.si().isPinned(),
              })}
            />
          </Tooltip>
        </div>
        <If predicate={() => this.si().selectedId === undefined}>
          {() => this.picker()}
        </If>
        <If
          predicate={() =>
            this.si().selectedId !== undefined && !this.si().detailOpen
          }
        >
          {() => this.detail()}
        </If>
        <If
          predicate={() =>
            this.si().selectedId !== undefined && this.si().detailOpen
          }
        >
          {() => (
            <div class="dsm-si-detail">
              <DetailView si={() => this.si()} inFlame={false} />
            </div>
          )}
        </If>
      </div>
    );
  }

  // ---- shader list ----

  picker() {
    return (
      <div>
        <div class="dsm-si-summary">
          <Tooltip
            tooltip={format("shader-inspector-budget-tooltip")}
            gravity="s"
          >
            <span>
              {() =>
                format("shader-inspector-budget", { budget: this.si().budget })
              }
            </span>
          </Tooltip>
          <span class="dsm-si-total">
            {() =>
              format("shader-inspector-total-recompiles", {
                count: this.si().totalRecompiles,
              })
            }
          </span>
          <Button
            color="light-gray"
            class="dsm-si-reset"
            onTap={() => this.si().resetCounts()}
          >
            {format("shader-inspector-reset")}
          </Button>
        </div>
        <If predicate={() => this.si().errors.length > 0}>
          {() => (
            <div class="dsm-si-errors">
              <For
                each={() => this.si().errors}
                key={(e: SurfaceRow) => `${e.id}:${e.error}`}
              >
                {(e: () => SurfaceRow) => this.errorRow(e)}
              </For>
            </div>
          )}
        </If>
        <If
          predicate={() =>
            this.si().rows.length === 0 && this.si().errors.length === 0
          }
        >
          {() => (
            <div class="dsm-si-empty">{format("shader-inspector-empty")}</div>
          )}
        </If>
        <If predicate={() => this.si().rows.length > 0}>
          {() => (
            <div class="dsm-si-hint">{format("shader-inspector-pick")}</div>
          )}
        </If>
        <div class="dsm-si-rows">
          <For each={() => this.si().rows} key={(r: SurfaceRow) => r.id}>
            {(row: () => SurfaceRow) => this.pickerRow(row)}
          </For>
        </div>
      </div>
    );
  }

  label(id: () => string | undefined, jump = true) {
    return (
      <span
        class="dsm-si-label"
        onTap={(e: Event) => {
          const target = id();
          if (!jump || target === undefined) return;
          e.stopPropagation();
          this.si().jumpTo(target);
        }}
      >
        <If
          predicate={() => {
            const target = id();
            return (
              target !== undefined &&
              this.si().expressionLatex(target) !== undefined
            );
          }}
        >
          {() => (
            <StaticMathQuillView
              latex={() => this.si().expressionLatex(id()!) ?? ""}
            />
          )}
        </If>
        <If
          predicate={() => {
            const target = id();
            return (
              target === undefined ||
              this.si().expressionLatex(target) === undefined
            );
          }}
        >
          {() => (
            <span class="dsm-si-missing">
              {() =>
                id() === undefined ? format("shader-inspector-untraced") : id()
              }
            </span>
          )}
        </If>
      </span>
    );
  }

  errorRow(e: () => SurfaceRow) {
    return (
      <div
        class="dsm-si-row dsm-si-pickable dsm-si-bad"
        role="button"
        tabindex="0"
        onTap={() => this.si().select(e().id)}
      >
        {this.label(() => e().id, false)}
        <div class="dsm-si-line">
          {() => format(`shader-inspector-error-${e().error}`)}
        </div>
        <If predicate={() => !!(e().color ?? e().restriction)}>
          {() => (
            <div class="dsm-si-line dsm-si-dim">
              {() =>
                format("shader-inspector-cost-short", {
                  cost: fmt((e().color ?? e().restriction)!.cost),
                })
              }
            </div>
          )}
        </If>
      </div>
    );
  }

  pickerRow(row: () => SurfaceRow) {
    const m = () => row().material;
    return (
      <div
        class={() => ({
          "dsm-si-row": true,
          "dsm-si-pickable": true,
          "dsm-si-bad": row().recompiles > 0 || m().overflow > 0 || m().full,
        })}
        role="button"
        tabindex="0"
        onTap={() => this.si().select(row().id)}
      >
        {this.label(() => row().id, false)}
        <div class="dsm-si-meter">
          <span
            class={() => ({
              "dsm-si-meter-fill": true,
              "dsm-si-meter-over": m().overflow > 0 || m().full,
            })}
            style={() => ({
              width: `${Math.min(100, (100 * m().uniforms) / Math.max(1, m().budget))}%`,
            })}
          />
        </div>
        <div class="dsm-si-line">
          {() =>
            [
              format("shader-inspector-uniforms", {
                used: m().uniforms,
                budget: m().budget,
              }),
              ...[row().restriction, row().color]
                .filter((s): s is NonNullable<typeof s> => s !== undefined)
                .map((s) =>
                  format("shader-inspector-cost-short", { cost: fmt(s.cost) })
                ),
              row().recompiles > 0
                ? format("shader-inspector-recompiles-short", {
                    count: row().recompiles,
                  })
                : "",
            ]
              .filter((s) => s !== "")
              .join(" · ")
          }
        </div>
      </div>
    );
  }

  // ---- one shader ----

  detail() {
    return (
      <div class="dsm-si-detail">
        <If predicate={() => this.report() === undefined}>
          {() => (
            <div class="dsm-si-empty">{format("shader-inspector-gone")}</div>
          )}
        </If>
        <If predicate={() => this.report() !== undefined}>
          {() => (
            <div>
              <div class="dsm-si-heading">
                {this.label(() => this.report()?.id)}
              </div>
              <If
                predicate={() => this.si().selectedRow()?.error !== undefined}
              >
                {() => (
                  <div class="dsm-si-error-banner">
                    <div>
                      {() =>
                        format(
                          `shader-inspector-error-${this.si().selectedRow()?.error ?? "color-cost"}`
                        )
                      }
                    </div>
                    <div class="dsm-si-dim">
                      {() =>
                        format(
                          this.hasShader()
                            ? "shader-inspector-error-rejected"
                            : "shader-inspector-error-no-shader"
                        )
                      }
                    </div>
                  </div>
                )}
              </If>
              <If predicate={() => this.hasShader()}>
                {() => this.shaderDetail()}
              </If>
            </div>
          )}
        </If>
      </div>
    );
  }

  hasShader() {
    return (this.report()?.parts.length ?? 0) > 0;
  }

  shaderDetail() {
    const errored = () => this.si().selectedRow()?.error !== undefined;
    return (
      <div>
        <div class="dsm-si-heading-buttons">
          <Button color="light-gray" onTap={() => this.si().openDetail([])}>
            {format("shader-inspector-open-detail-shader")}
          </Button>
          <Button color="light-gray" onTap={() => this.si().flame.open()}>
            {format("shader-inspector-open-flame")}
          </Button>
        </div>
        <If predicate={() => this.report()!.colorId !== undefined}>
          {() => (
            <div class="dsm-si-line dsm-si-dim">
              {format("shader-inspector-color-function")}
              {this.label(() => this.report()!.colorId)}
            </div>
          )}
        </If>
        <If predicate={() => !this.traced()}>
          {() => (
            <div class="dsm-si-warning">
              {format("shader-inspector-untraced-shader")}
            </div>
          )}
        </If>
        {this.overview()}
        {this.uniformSection()}
        <For each={() => this.report()!.parts} key={(p: PartReport) => p.part}>
          {(p: () => PartReport) => this.costSection(p)}
        </For>
        <If predicate={() => this.allLoops().length > 0}>
          {() => this.loopSection()}
        </If>
        {this.glslSection()}
        <If predicate={() => !errored()}>{() => this.recompileSection()}</If>
      </div>
    );
  }

  traced() {
    return this.report()?.parts.every((p) => p.traced) ?? true;
  }

  allLoops() {
    return this.report()?.parts.flatMap((p) => p.loops) ?? [];
  }

  overview() {
    const r = () => this.report()!;
    const tiles = () => {
      const report = r();
      const m = report.material;
      const maxCost = Math.max(0, ...report.parts.map((p) => p.cost));
      const costLimit = report.parts[0]?.costLimit ?? 1;
      const chars = report.parts.reduce((n, p) => n + p.chars, 0);
      const steps = report.parts.reduce((n, p) => n + p.loopSteps, 0);
      const row = this.si().selectedRow();
      // Recompiles and programs only count shaders Desmos kept.
      const kept = row?.error === undefined;
      const tiles = [
        {
          key: "slots",
          label: format("shader-inspector-tile-slots"),
          value: `${fmt(m.uniforms)} / ${fmt(m.budget)}`,
          bad: m.overflow > 0 || m.full,
        },
        {
          key: "cost",
          label: format("shader-inspector-tile-cost"),
          value: `${fmt(maxCost)} / ${fmt(costLimit)}`,
          bad: maxCost > costLimit * 0.8,
        },
        {
          key: "steps",
          label: format("shader-inspector-tile-steps"),
          value: fmt(steps),
          bad: false,
        },
        {
          key: "chars",
          label: format("shader-inspector-tile-chars"),
          value: fmt(chars),
          bad: false,
        },
        {
          key: "recompiles",
          label: format("shader-inspector-tile-recompiles"),
          value: fmt(row?.recompiles ?? 0),
          bad: (row?.recompiles ?? 0) > 0,
        },
        {
          key: "programs",
          label: format("shader-inspector-tile-programs"),
          value: `${fmt(report.programs)} / ${fmt(report.surfaces)}`,
          bad: false,
        },
      ];
      return kept
        ? tiles
        : tiles.filter((t) => t.key !== "recompiles" && t.key !== "programs");
    };
    return (
      <div class="dsm-si-tiles">
        <For each={tiles} key={(t: { key: string }) => t.key}>
          {(t: () => { label: string; value: string; bad: boolean }) => (
            <div
              class={() => ({
                "dsm-si-tile": true,
                "dsm-si-tile-bad": t().bad,
              })}
            >
              <div class="dsm-si-tile-value">{() => t().value}</div>
              <div class="dsm-si-tile-label">{() => t().label}</div>
            </div>
          )}
        </For>
      </div>
    );
  }

  // ---- uniforms ----

  groupTooltip(g: UniformGroup) {
    const what = g.list
      ? format("shader-inspector-group-list", {
          list: `${g.list.type}[${g.list.length}]`,
          slots: g.slots + g.baked,
        })
      : format("shader-inspector-group-single", { count: g.slots + g.baked });
    const baked =
      g.baked > 0
        ? " · " + format("shader-inspector-overflow", { count: g.baked })
        : "";
    return `${shortLabel(this.si(), g.origin)}: ${what}${baked}`;
  }

  groupSegments(groups: UniformGroup[], prefix: string): Segment[] {
    const out: Segment[] = [];
    groups.forEach((g, i) => {
      const tooltip = this.groupTooltip(g);
      if (g.slots > 0)
        out.push({
          key: `${prefix}${i}`,
          origin: g.origin,
          value: g.slots,
          tooltip,
        });
      if (g.baked > 0)
        out.push({
          key: `${prefix}${i}b`,
          origin: g.origin,
          value: g.baked,
          over: true,
          tooltip,
        });
    });
    return out;
  }

  uniformSection() {
    const r = () => this.report()!;
    const singlesTotal = () =>
      r().singles.reduce((n, g) => n + g.slots + g.baked, 0);
    const total = () =>
      singlesTotal() + r().lists.reduce((n, g) => n + g.slots + g.baked, 0);
    const scale = () => Math.max(r().material.budget, total(), 1);
    const segments = () => {
      const segs = [
        ...this.groupSegments(r().singles, "s"),
        ...this.groupSegments(r().lists, "l"),
      ];
      // Baked values sit past the limit: move them to the end.
      const ok = segs.filter((s) => !s.over);
      const over = segs.filter((s) => s.over);
      const free = r().material.budget - ok.reduce((n, s) => n + s.value, 0);
      return [
        ...ok,
        ...(free > 0
          ? [
              {
                key: "free",
                origin: undefined,
                free: true,
                value: free,
                tooltip: format("shader-inspector-free", { count: free }),
              },
            ]
          : []),
        ...over,
      ];
    };
    const zoomWidth = () => (100 * singlesTotal()) / scale();
    return (
      <div class="dsm-si-section">
        <div class="dsm-si-section-head">
          <span>{format("shader-inspector-section-uniforms")}</span>
          <span class="dsm-si-dim">
            {() =>
              format("shader-inspector-uniforms-head", {
                used: [...r().singles, ...r().lists].reduce(
                  (n, g) => n + g.slots,
                  0
                ),
                budget: r().material.budget,
                baked: [...r().singles, ...r().lists].reduce(
                  (n, g) => n + g.baked,
                  0
                ),
              })
            }
          </span>
        </div>
        {bar(this.si(), segments, scale, () => r().material.budget)}
        <If predicate={() => r().singles.length > 0 && r().lists.length > 0}>
          {() => (
            <div>
              <div
                class="dsm-si-zoom-connector"
                style={() => ({
                  "clip-path": `polygon(0 0, ${Math.max(0.5, zoomWidth())}% 0, 100% 100%, 0 100%)`,
                })}
              />
              {bar(
                this.si(),
                () => this.groupSegments(r().singles, "z"),
                singlesTotal
              )}
              <div class="dsm-si-caption">
                {() =>
                  format("shader-inspector-singles", { count: singlesTotal() })
                }
              </div>
            </div>
          )}
        </If>
        <div class="dsm-si-legend">
          <For
            each={() => this.uniformLegend()}
            key={(l: { key: string }) => l.key}
          >
            {(l: () => { origin: Origin; text: string; bad: boolean }) =>
              this.legendRow(
                () => "uniforms",
                () => l().origin,
                () => l().text,
                () => l().bad
              )
            }
          </For>
        </div>
      </div>
    );
  }

  uniformLegend() {
    const r = this.report()!;
    const by = new Map<
      Origin,
      { singles: number; lists: string[]; slots: number; baked: number }
    >();
    for (const g of [...r.singles, ...r.lists]) {
      let e = by.get(g.origin);
      if (!e)
        by.set(g.origin, (e = { singles: 0, lists: [], slots: 0, baked: 0 }));
      e.slots += g.slots + g.baked;
      e.baked += g.baked;
      if (g.list) e.lists.push(`${g.list.type}[${g.list.length}]`);
      else e.singles += g.slots + g.baked;
    }
    return [...by]
      .sort((a, b) => b[1].slots - a[1].slots)
      .map(([origin, e], i) => {
        const parts: string[] = [];
        if (e.lists.length > 0) parts.push(groupNames(e.lists));
        if (e.singles > 0)
          parts.push(
            format("shader-inspector-group-single", { count: e.singles })
          );
        let text = `${fmt(e.slots)} · ${parts.join(", ")}`;
        if (e.baked > 0)
          text +=
            " · " + format("shader-inspector-overflow", { count: e.baked });
        return { key: `${i}:${origin}`, origin, text, bad: e.baked > 0 };
      });
  }

  /**
   * A legend row, which opens to show what its expression adds and buttons to
   * see it in detail or go to it.
   */
  legendRow(
    section: () => string,
    origin: () => Origin,
    text: () => string,
    bad?: () => boolean
  ) {
    const key = () => `${section()}:${origin()}`;
    const open = () => this.si().expanded === key();
    return (
      <div
        class={() => ({ "dsm-si-legend-item": true, "dsm-si-open": open() })}
      >
        <div
          class={() => ({
            "dsm-si-legend-row": true,
            "dsm-si-legend-toggle": true,
            "dsm-si-bad-text": !!bad?.(),
          })}
          role="button"
          tabindex="0"
          onTap={() => this.si().toggleExpanded(key())}
        >
          <span class="dsm-si-chevron">{() => (open() ? "▾" : "▸")}</span>
          <span
            class="dsm-si-swatch"
            style={() => ({ background: this.si().originColor(origin()) })}
          />
          {this.label(origin, false)}
          <span class="dsm-si-legend-value">{text}</span>
        </div>
        <If predicate={open}>
          {() => (
            <div class="dsm-si-expanded">
              <div class="dsm-si-line">
                {() => {
                  const o = origin();
                  return o === undefined
                    ? format("shader-inspector-untraced-detail")
                    : usageSummary(this.si(), o);
                }}
              </div>
              <div class="dsm-si-detail-buttons">
                <Button
                  color="light-gray"
                  onTap={() => this.si().openDetail(this.si().pathOf(origin()))}
                >
                  {format("shader-inspector-open-detail")}
                </Button>
                <If predicate={() => origin() !== undefined}>
                  {() => (
                    <Button
                      color="light-gray"
                      onTap={() => {
                        const o = origin();
                        if (o !== undefined) this.si().jumpTo(o);
                      }}
                    >
                      {format("shader-inspector-go-to")}
                    </Button>
                  )}
                </If>
              </div>
            </div>
          )}
        </If>
      </div>
    );
  }

  // ---- cost ----

  costSection(p: () => PartReport) {
    const segments = (): Segment[] =>
      p().costShares.map((s, i) => ({
        key: `${i}`,
        origin: s.origin,
        value: s.cost,
        tooltip: `${shortLabel(this.si(), s.origin)}: ${fmt(s.cost)}`,
      }));
    const scale = () => Math.max(p().costLimit, p().cost, 1);
    return (
      <div class="dsm-si-section">
        <div class="dsm-si-section-head">
          <span class="dsm-si-head-with-help">
            {() => format(`shader-inspector-section-cost-${p().part}`)}
            <Tooltip tooltip={format("shader-inspector-cost-help")} gravity="s">
              <span
                class={() => ({
                  "dsm-si-help": true,
                  "dsm-selected": this.si().costHelp === p().part,
                })}
                role="button"
                onTap={() => this.si().toggleCostHelp(p().part)}
              >
                ?
              </span>
            </Tooltip>
          </span>
          <span
            class={() => ({
              "dsm-si-dim": true,
              "dsm-si-bad-text": p().cost > p().costLimit,
            })}
          >
            {() => `${fmt(p().cost)} / ${fmt(p().costLimit)}`}
          </span>
        </div>
        <If predicate={() => this.si().costHelp === p().part}>
          {() => costHelp(() => p().costLimit)}
        </If>
        {bar(this.si(), segments, scale, () => p().costLimit)}
        <div class="dsm-si-legend">
          <For
            each={() => p().costShares}
            key={(s: { origin: Origin }) => `${s.origin}`}
          >
            {(s: () => { origin: Origin; cost: number }) =>
              this.legendRow(
                () => `cost-${p().part}`,
                () => s().origin,
                () =>
                  `${fmt(s().cost)} (${Math.round((100 * s().cost) / Math.max(1, p().cost))}%)`
              )
            }
          </For>
        </div>
      </div>
    );
  }

  // ---- loops ----

  loopSection() {
    return (
      <div class="dsm-si-section">
        <div class="dsm-si-section-head">
          <span>{format("shader-inspector-section-loops")}</span>
          <span class="dsm-si-dim">
            {() =>
              format("shader-inspector-steps", {
                steps: fmt(this.allLoops().reduce((n, l) => n + l.runs, 0)),
              })
            }
          </span>
        </div>
        <For
          each={() => this.allLoops().map((l, i) => ({ l, i }))}
          key={(x: { i: number }) => x.i}
        >
          {(x: () => { l: LoopRow }) => this.loopRow(() => x().l)}
        </For>
        <div class="dsm-si-caption">
          {format("shader-inspector-loops-caption", {
            limit: fmt(MAX_LOOP_TERMS),
          })}
        </div>
      </div>
    );
  }

  loopRow(l: () => LoopRow) {
    const limited = () => l().kind !== "list";
    return (
      <div
        class="dsm-si-loop"
        style={() => ({ "padding-left": `${l().depth * 14}px` })}
      >
        <div class="dsm-si-loop-head">
          <span class="dsm-si-loop-kind">
            {() =>
              l().kind === "sum" ? "Σ" : l().kind === "product" ? "Π" : "[ ]"
            }
          </span>
          <span
            class="dsm-si-swatch"
            style={() => ({ background: this.si().originColor(l().origin) })}
          />
          {this.label(() => l().origin)}
        </div>
        <If predicate={limited}>
          {() => (
            <Tooltip
              tooltip={() =>
                format("shader-inspector-loop-terms-tooltip", {
                  terms: fmt(l().terms),
                  limit: fmt(MAX_LOOP_TERMS),
                })
              }
              gravity="s"
            >
              <div class="dsm-si-meter">
                <span
                  class={() => ({
                    "dsm-si-meter-fill": true,
                    "dsm-si-meter-over": l().terms > MAX_LOOP_TERMS * 0.8,
                  })}
                  style={() => ({
                    width: `${Math.min(100, (100 * l().terms) / MAX_LOOP_TERMS)}%`,
                    background: this.si().originColor(l().origin),
                  })}
                />
              </div>
            </Tooltip>
          )}
        </If>
        <div class="dsm-si-line dsm-si-dim">
          {() =>
            format(
              l().kind === "list"
                ? "shader-inspector-loop-list"
                : "shader-inspector-loop",
              {
                terms: fmt(l().terms),
                body: fmt(l().bodyCost),
                cost: fmt(l().terms * l().bodyCost),
                runs: fmt(l().runs),
              }
            )
          }
        </div>
      </div>
    );
  }

  // ---- GLSL ----

  glslSection() {
    const r = () => this.report()!;
    const lines = () => r().parts.flatMap((p) => p.lines);
    const shares = () => {
      const by = new Map<Origin, { lines: number; chars: number }>();
      for (const l of lines()) {
        let e = by.get(l.origin);
        if (!e) by.set(l.origin, (e = { lines: 0, chars: 0 }));
        e.lines++;
        e.chars += l.text.length + 1;
      }
      return [...by]
        .sort((a, b) => b[1].chars - a[1].chars)
        .map(([origin, e]) => ({ origin, ...e }));
    };
    const chars = () => shares().reduce((n, s) => n + s.chars, 0);
    const segments = (): Segment[] =>
      shares().map((s, i) => ({
        key: `${i}`,
        origin: s.origin,
        value: s.chars,
        tooltip: `${shortLabel(this.si(), s.origin)}: ${format(
          "shader-inspector-glsl-share",
          { lines: s.lines, chars: fmt(s.chars) }
        )}`,
      }));
    const helpers = () => [...new Set(r().parts.flatMap((p) => p.helpers))];
    return (
      <div class="dsm-si-section">
        <div class="dsm-si-section-head">
          <span>{format("shader-inspector-section-glsl")}</span>
          <span class="dsm-si-dim">
            {() =>
              format("shader-inspector-glsl-share", {
                lines: lines().length,
                chars: fmt(chars()),
              })
            }
          </span>
        </div>
        {bar(this.si(), segments, () => Math.max(1, chars()))}
        <div class="dsm-si-legend">
          <For each={shares} key={(s: { origin: Origin }) => `${s.origin}`}>
            {(s: () => { origin: Origin; lines: number; chars: number }) =>
              this.legendRow(
                () => "glsl",
                () => s().origin,
                () =>
                  format("shader-inspector-glsl-share", {
                    lines: s().lines,
                    chars: fmt(s().chars),
                  })
              )
            }
          </For>
        </div>
        <If predicate={() => helpers().length > 0}>
          {() => (
            <div class="dsm-si-line dsm-si-dim">
              {() =>
                format("shader-inspector-helpers", {
                  helpers: helpers().join(", "),
                })
              }
            </div>
          )}
        </If>
        <div class="dsm-si-caption">
          {format("shader-inspector-glsl-caption")}
        </div>
        <Button
          color="light-gray"
          class="dsm-si-code-toggle"
          onTap={() => this.si().toggleGlsl()}
        >
          {() =>
            format(
              this.si().showGlsl
                ? "shader-inspector-hide-code"
                : "shader-inspector-show-code"
            )
          }
        </Button>
        <If predicate={() => this.si().showGlsl}>
          {() => (
            <div class="dsm-si-code">
              <For
                each={() => lines().map((l, i) => ({ ...l, i }))}
                key={(l: { i: number }) => l.i}
              >
                {(l: () => { text: string; origin: Origin }) => (
                  <div
                    class="dsm-si-code-line"
                    style={() => ({
                      "border-left-color": this.si().originColor(l().origin),
                    })}
                  >
                    {() => l().text}
                  </div>
                )}
              </For>
            </div>
          )}
        </If>
      </div>
    );
  }

  // ---- recompiles ----

  recompileSection() {
    const row = () => this.si().selectedRow();
    const reasons = () =>
      RECOMPILE_REASONS.filter((r) => row()?.reasons[r]).map((r) => ({
        r,
        n: row()!.reasons[r]!,
      }));
    return (
      <div class="dsm-si-section">
        <div class="dsm-si-section-head">
          <span>{format("shader-inspector-section-recompiles")}</span>
          <span class="dsm-si-dim">
            {() =>
              format("shader-inspector-total-recompiles", {
                count: row()?.recompiles ?? 0,
              })
            }
          </span>
        </div>
        <If predicate={() => reasons().length === 0}>
          {() => (
            <div class="dsm-si-line dsm-si-dim">
              {format("shader-inspector-no-recompiles")}
            </div>
          )}
        </If>
        <For each={reasons} key={(x: { r: string }) => x.r}>
          {(x: () => { r: string; n: number }) => (
            <div class="dsm-si-reason">
              <div class="dsm-si-line dsm-si-bad-text">
                {() =>
                  format(`shader-inspector-reason-${x().r}`, { count: x().n })
                }
              </div>
              <div class="dsm-si-line dsm-si-dim">
                {() => format(`shader-inspector-reason-${x().r}-tooltip`)}
              </div>
            </div>
          )}
        </For>
      </div>
    );
  }
}

function groupNames(names: string[]) {
  const counts = new Map<string, number>();
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  return [...counts].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join(", ");
}

/** Under an expression in the list: what it adds to the inspected shader. */
/** What an expression adds to the inspected shader, in a line. */
function usageSummary(si: ShaderInspector, id: string) {
  const report = si.report();
  if (!report) return "";
  const u = usageOf(report, id);
  const parts: string[] = [];
  if (u.slots > 0)
    parts.push(
      format("shader-inspector-panel-slots", { count: u.slots }) +
        (u.lists.length > 0
          ? ` (${groupNames(u.lists.map((l) => `${l.type}[${l.length}]`))})`
          : "")
    );
  if (u.baked > 0)
    parts.push(format("shader-inspector-overflow", { count: u.baked }));
  if (u.cost > 0)
    parts.push(format("shader-inspector-cost-short", { cost: fmt(u.cost) }));
  for (const l of u.loops)
    parts.push(
      `${l.kind === "sum" ? "Σ" : l.kind === "product" ? "Π" : "[ ]"} ${fmt(l.terms)}`
    );
  if (u.chars > 0)
    parts.push(format("shader-inspector-panel-chars", { count: fmt(u.chars) }));
  if (parts.length === 0)
    parts.push(
      format(
        id === report.id
          ? "shader-inspector-panel-owner"
          : "shader-inspector-panel-none"
      )
    );
  return parts.join(" · ");
}

export class ExpressionPanel extends Component<{
  si: () => ShaderInspector;
  id: () => string;
}> {
  si = () => this.props.si();

  text() {
    return usageSummary(this.si(), this.props.id());
  }

  template() {
    return (
      <div
        class="dsm-si-expression-panel"
        onTap={(e: Event) => {
          e.stopPropagation();
          this.si().openMenu();
        }}
      >
        <span
          class="dsm-si-swatch"
          style={() => ({
            background: this.si().originColor(this.props.id()),
          })}
        />
        <span>{() => this.text()}</span>
      </div>
    );
  }
}

export function MainPopupFunc(si: ShaderInspector) {
  return <ShaderInspectorView si={() => si} />;
}

export function ExpressionPanelFunc(si: ShaderInspector, id: string) {
  return <ExpressionPanel si={() => si} id={() => id} />;
}
