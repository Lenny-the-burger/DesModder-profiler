/**
 * One part of a shader in detail: its LaTeX with the parts inside it
 * highlighted by what they add, its stats split by category, and the parts
 * it is made of. Shown in the menu and beside the flame graph.
 */
import type ShaderInspector from ".";
import {
  ColoredMath,
  Highlight,
  MathPart,
  highlightLatex,
} from "./ColoredMath";
import {
  breakdown,
  categoriesOf,
  categoryColor,
  withAlpha,
} from "./categories";
import { fmt, latexToText } from "./text";
import {
  METRICS,
  Metric,
  SpanNode,
  dominant,
  localStats,
  metricValue,
  nodeLatex,
} from "./tree";
import { Component, jsx } from "#DCGView";
import { Button, For, If } from "#components";
import { format } from "#i18n";

/** Breadcrumbs past this many are shortened. */
const MAX_CRUMBS = 7;

interface Pick {
  node: SpanNode;
  path: string[];
}

const pct = (part: number, whole: number) =>
  whole > 0 ? `${Math.round((100 * part) / whole)}%` : "–";

/** What to call a node of the shader's tree. */
export function nodeName(node: SpanNode): string {
  switch (node.kind) {
    case "shader":
      return format("shader-inspector-node-shader");
    case "part":
      return format(`shader-inspector-part-${node.part ?? "color"}`);
    case "untraced":
      return format("shader-inspector-untraced");
    case "frame":
      return latexToText(nodeLatex(node) ?? "") || "…";
  }
}

export function metricText(metric: Metric, value: number) {
  return format(`shader-inspector-unit-${metric}`, { value: fmt(value) });
}

export class DetailView extends Component<{
  si: () => ShaderInspector;
  inFlame: boolean;
}> {
  si = () => this.props.si();
  chain = () => this.si().detailChain();
  node = () => {
    const c = this.chain();
    return c[c.length - 1];
  };
  path = () =>
    this.chain()
      .slice(1)
      .map((n) => n.key);
  metric = () => this.si().metric;

  template() {
    return (
      <div class="dsm-si-detail-view">
        <If predicate={() => this.node() === undefined}>
          {() => (
            <div class="dsm-si-empty">{format("shader-inspector-gone")}</div>
          )}
        </If>
        <If predicate={() => this.node() !== undefined}>
          {() => (
            <div>
              {this.crumbs()}
              {this.heading()}
              {this.metricTiles()}
              {this.stats()}
              {this.breakdownList()}
              {this.extras()}
              {this.partsList()}
              {this.buttons()}
            </div>
          )}
        </If>
      </div>
    );
  }

  /**
   * The path to the node. Long ones keep their ends; the gap between them
   * goes to the deepest part it hides.
   */
  crumbItems() {
    const items = this.chain().map((node, i) => ({ node, i, gap: false }));
    if (items.length <= MAX_CRUMBS) return items;
    const tail = items.slice(-(MAX_CRUMBS - 3));
    const hidden = items[items.length - tail.length - 1];
    return [...items.slice(0, 2), { ...hidden, gap: true }, ...tail];
  }

  crumbs() {
    return (
      <div class="dsm-si-crumbs">
        <For
          each={() => this.crumbItems()}
          key={({ node, i }: { node: SpanNode; i: number }) =>
            `${i}:${node.key}`
          }
        >
          {(c: () => { node: SpanNode; i: number; gap?: boolean }) => (
            <span class="dsm-si-crumb-wrap">
              <If predicate={() => c().i > 0}>
                {() => <span class="dsm-si-crumb-sep">›</span>}
              </If>
              <span
                class={() => ({
                  "dsm-si-crumb": true,
                  "dsm-si-crumb-current": c().i === this.chain().length - 1,
                })}
                role="button"
                tabindex="0"
                onTap={() => this.si().navigate(this.path().slice(0, c().i))}
              >
                {() => (c().gap ? "…" : nodeName(c().node))}
              </span>
            </span>
          )}
        </For>
      </div>
    );
  }

  /** The node's LaTeX with what's inside it highlighted. */
  colored() {
    const node = this.node();
    const metric = this.metric();
    const base = this.path();
    const highlights = (n: SpanNode, path: string[]): Highlight<Pick> => ({
      start: n.start ?? 0,
      end: n.end ?? 0,
      value: { node: n, path },
      children: n.children
        .filter((c) => c.kind === "frame" && c.input === n.input)
        .map((c) => highlights(c, [...path, c.key])),
    });
    const root = highlights(node, base);
    // Single-category metrics shade by how much each part adds.
    let max = 0;
    const walk = (h: Highlight<Pick>) => {
      for (const c of h.children) {
        max = Math.max(max, metricValue(localStats(c.value.node), metric));
        walk(c);
      }
    };
    walk(root);
    const single = categoriesOf(metric).length === 1;
    return highlightLatex(node.input ?? "", root, ({ node: n, path }) => {
      const local = localStats(n);
      const value = metricValue(local, metric);
      if (!(value > 0)) return undefined;
      const key = dominant(breakdown(local, metric));
      const color = categoryColor(metric, key ?? "");
      const part: MathPart = {
        color: withAlpha(
          color,
          single ? 0.12 + 0.5 * (value / Math.max(max, 1)) : 0.3
        ),
        title: `${latexToText(nodeLatex(n) ?? "")}: ${metricText(metric, value)}`,
        onPick: () => this.si().navigate(path),
      };
      return part;
    });
  }

  heading() {
    return (
      <div class="dsm-si-detail-heading">
        <If predicate={() => this.node().kind === "frame"}>
          {() => (
            <div>
              <div class="dsm-si-detail-math">
                <ColoredMath
                  colored={() => this.colored()}
                  renderKey={() =>
                    `${this.path().join("\u0000")}|${this.metric()}`
                  }
                />
              </div>
              <div class="dsm-si-caption">
                {format("shader-inspector-detail-hint")}
              </div>
            </div>
          )}
        </If>
        <If predicate={() => this.node().kind !== "frame"}>
          {() => (
            <div class="dsm-si-detail-name">{() => nodeName(this.node())}</div>
          )}
        </If>
      </div>
    );
  }

  /** Each metric's total; picking one shows it. */
  metricTiles() {
    return (
      <div class="dsm-si-metric-tiles">
        <For each={() => METRICS} key={(m: Metric) => m}>
          {(m: () => Metric) => (
            <div
              class={() => ({
                "dsm-si-tile": true,
                "dsm-si-metric-tile": true,
                "dsm-selected": this.metric() === m(),
              })}
              role="button"
              tabindex="0"
              onTap={() => this.si().setMetric(m())}
            >
              <div class="dsm-si-tile-value">
                {() => fmt(metricValue(this.node().total, m()))}
              </div>
              <div class="dsm-si-tile-label">
                {() => format(`shader-inspector-metric-${m()}`)}
              </div>
            </div>
          )}
        </For>
      </div>
    );
  }

  stats() {
    return (
      <div class="dsm-si-line">
        {() => {
          const chain = this.chain();
          const node = this.node();
          const m = this.metric();
          const value = metricValue(node.total, m);
          const root = metricValue(chain[0].total, m);
          const parent = chain[chain.length - 2];
          const own = metricValue(localStats(node), m);
          const parts = [metricText(m, value)];
          if (chain.length > 1)
            parts.push(
              format("shader-inspector-of-shader", {
                percent: pct(value, root),
              })
            );
          if (parent && parent !== chain[0])
            parts.push(
              format("shader-inspector-of-parent", {
                percent: pct(value, metricValue(parent.total, m)),
              })
            );
          if (node.children.length > 0)
            parts.push(format("shader-inspector-itself", { value: fmt(own) }));
          return parts.join(" · ");
        }}
      </div>
    );
  }

  breakdownList() {
    const rows = () => {
      const total = breakdown(this.node().total, this.metric());
      const sum = metricValue(this.node().total, this.metric());
      return categoriesOf(this.metric())
        .filter((c) => (total[c.key] ?? 0) > 0)
        .map((c) => ({ ...c, value: total[c.key] ?? 0, sum }));
    };
    return (
      <If
        predicate={() =>
          categoriesOf(this.metric()).length > 1 && rows().length > 0
        }
      >
        {() => (
          <div class="dsm-si-legend">
            <For each={rows} key={(r: { key: string }) => r.key}>
              {(
                r: () => {
                  key: string;
                  color: string;
                  value: number;
                  sum: number;
                }
              ) => (
                <div class="dsm-si-legend-row">
                  <span
                    class="dsm-si-swatch"
                    style={() => ({ background: r().color })}
                  />
                  <span class="dsm-si-legend-name">
                    {() =>
                      format(`shader-inspector-cat-${this.metric()}-${r().key}`)
                    }
                  </span>
                  <span class="dsm-si-legend-value">
                    {() => `${fmt(r().value)} (${pct(r().value, r().sum)})`}
                  </span>
                </div>
              )}
            </For>
          </div>
        )}
      </If>
    );
  }

  /** Loops and lists that start at this node. */
  extras() {
    return (
      <div>
        <For
          each={() => this.node().loops.map((l, i) => ({ ...l, i }))}
          key={(l: { i: number }) => l.i}
        >
          {(l: () => SpanNode["loops"][number]) => (
            <div class="dsm-si-line">
              {() =>
                format("shader-inspector-detail-loop", {
                  kind: format(`shader-inspector-loop-kind-${l().kind}`),
                  terms: fmt(l().terms),
                  body: fmt(l().bodyCost),
                  runs: fmt(l().runs),
                })
              }
            </div>
          )}
        </For>
        <If predicate={() => this.node().lists.length > 0}>
          {() => (
            <div class="dsm-si-line">
              {() =>
                format("shader-inspector-detail-lists", {
                  lists: this.node()
                    .lists.map((l) => `${l.type}[${l.length}]`)
                    .join(", "),
                })
              }
            </div>
          )}
        </If>
      </div>
    );
  }

  partsList() {
    const rows = () => {
      const m = this.metric();
      const node = this.node();
      const total = metricValue(node.total, m);
      return node.children
        .map((c) => ({ node: c, value: metricValue(c.total, m), total }))
        .filter((r) => r.value > 0)
        .sort((a, b) => b.value - a.value);
    };
    return (
      <If predicate={() => rows().length > 0}>
        {() => (
          <div class="dsm-si-section">
            <div class="dsm-si-section-head">
              <span>{format("shader-inspector-parts")}</span>
            </div>
            <For each={rows} key={(r: { node: SpanNode }) => r.node.key}>
              {(r: () => { node: SpanNode; value: number; total: number }) => (
                <div
                  class="dsm-si-part-row"
                  role="button"
                  tabindex="0"
                  onTap={() =>
                    this.si().navigate([...this.path(), r().node.key])
                  }
                >
                  <span
                    class="dsm-si-swatch"
                    style={() => ({
                      background: this.si().originColor(r().node.origin),
                    })}
                  />
                  <span class="dsm-si-part-name">
                    {() => nodeName(r().node)}
                  </span>
                  <If
                    predicate={() =>
                      r().node.kind === "frame" &&
                      r().node.input !== this.node().input
                    }
                  >
                    {() => (
                      <span class="dsm-si-part-from">
                        {format("shader-inspector-inlined")}
                      </span>
                    )}
                  </If>
                  <span class="dsm-si-part-value">
                    {() => `${fmt(r().value)} (${pct(r().value, r().total)})`}
                  </span>
                  <span class="dsm-si-part-meter">
                    <span
                      class="dsm-si-part-meter-fill"
                      style={() => ({
                        width: pct(r().value, r().total),
                        background: this.si().originColor(r().node.origin),
                      })}
                    />
                  </span>
                </div>
              )}
            </For>
          </div>
        )}
      </If>
    );
  }

  buttons() {
    return (
      <div class="dsm-si-detail-buttons">
        <If predicate={() => this.node().origin !== undefined}>
          {() => (
            <Button
              color="light-gray"
              onTap={() => {
                const o = this.node().origin;
                if (o !== undefined) this.si().jumpTo(o);
              }}
            >
              {format("shader-inspector-go-to")}
            </Button>
          )}
        </If>
        <If predicate={() => !this.props.inFlame()}>
          {() => (
            <Button color="light-gray" onTap={() => this.si().flame.open()}>
              {format("shader-inspector-open-flame")}
            </Button>
          )}
        </If>
      </div>
    );
  }
}
