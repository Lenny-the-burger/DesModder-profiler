import Profiler from ".";
import "./ProfilerView.less";
import { ExpressionRow, SourceRow, Summary } from "./aggregate";
import {
  SEGMENTS,
  Segment,
  barPercent,
  formatMs,
  segmentsOf,
  symbolToLatex,
} from "./format";
import { Component, jsx } from "#DCGView";
import {
  Button,
  Checkbox,
  For,
  IconButton,
  If,
  SegmentedControl,
  StaticMathQuillView,
  Tooltip,
} from "#components";
import { format } from "#i18n";

/** Rows shown before "Show all". */
const COLLAPSED_ROWS = 15;

const TABS = ["expressions", "definitions"] as const;

export class ProfilerView extends Component<{
  profiler: () => Profiler;
}> {
  p = () => this.props.profiler();
  summary = () => this.p().getSummary();

  template() {
    return (
      <div class="dcg-popover-interior dsm-profiler-menu">
        <div class="dsm-profiler-title-row">
          <div class="dcg-popover-title">{format("profiler-name")}</div>
          <Tooltip gravity="s" tooltip={format("profiler-pin-tooltip")}>
            <IconButton
              iconClass="dsm-icon-bookmark"
              onTap={() => this.p().togglePinned()}
              btnClass={() => ({
                "dsm-profiler-pin": true,
                "dsm-selected": this.p().isPinned(),
              })}
            />
          </Tooltip>
        </div>
        {this.controls()}
        <If predicate={() => !this.p().hasData()}>
          {() => (
            <div class="dsm-profiler-empty">
              {() =>
                format(
                  this.p().recording
                    ? "profiler-empty-recording"
                    : "profiler-empty"
                )
              }
            </div>
          )}
        </If>
        <If predicate={() => this.p().hasData()}>{() => this.results()}</If>
      </div>
    );
  }

  controls() {
    return (
      <div class="dsm-profiler-controls">
        <div class="dsm-profiler-buttons">
          <Button
            color={() => (this.p().recording ? "red" : "blue")}
            class="dsm-profiler-record"
            onTap={() => this.p().toggleRecording()}
          >
            <span
              class={() => ({
                "dsm-profiler-record-dot": true,
                "dsm-profiler-recording": this.p().recording,
              })}
            />
            {() =>
              format(this.p().recording ? "profiler-stop" : "profiler-record")
            }
          </Button>
          <Tooltip tooltip={format("profiler-record-load-tooltip")} gravity="s">
            <Button
              color="light-gray"
              class="dsm-profiler-record-load"
              onTap={() => this.p().recordGraphLoad()}
            >
              {format("profiler-record-load")}
            </Button>
          </Tooltip>
        </div>
        <div class="dsm-profiler-status">{() => this.statusText()}</div>
        <Tooltip tooltip={format("profiler-breakdown-tooltip")} gravity="s">
          <Checkbox
            checked={() => this.p().nodeBreakdown}
            onChange={(checked) => this.p().setNodeBreakdown(checked)}
            ariaLabel={() => format("profiler-breakdown")}
          >
            {() => format("profiler-breakdown")}
          </Checkbox>
        </Tooltip>
        <If predicate={() => this.p().is3d()}>
          {() => (
            <Tooltip tooltip={format("profiler-gpu-tooltip")} gravity="s">
              <Checkbox
                checked={() => this.p().gpuTiming}
                onChange={(checked) => this.p().setGpuTiming(checked)}
                ariaLabel={() => format("profiler-gpu")}
              >
                {() => format("profiler-gpu")}
              </Checkbox>
            </Tooltip>
          )}
        </If>
      </div>
    );
  }

  statusText() {
    const p = this.p();
    if (!p.recording && !p.hasData()) return "";
    const s = this.summary();
    const parts = [
      format("profiler-status-duration", {
        duration: formatMs(p.recordingDuration()),
      }),
      format("profiler-status-updates", { count: s.changeSets }),
    ];
    if (s.frames > 0)
      parts.push(format("profiler-status-frames", { count: s.frames }));
    return (
      (p.recording ? format("profiler-status-recording") + " · " : "") +
      parts.join(" · ")
    );
  }

  results() {
    return (
      <div class="dsm-profiler-results">
        <Button
          color="light-gray"
          class="dsm-profiler-open-flame"
          onTap={() => this.p().openFlameGraph()}
        >
          {format("profiler-open-flame")}
        </Button>
        <SegmentedControl
          names={() => TABS.map((t) => format(`profiler-tab-${t}`))}
          selectedIndex={() => TABS.indexOf(this.p().tab)}
          setSelectedIndex={(i) => this.p().setTab(TABS[i])}
          ariaGroupLabel={format("profiler-tabs-label")}
        />
        <If predicate={() => this.p().tab === "expressions"}>
          {() => this.expressionsTab()}
        </If>
        <If predicate={() => this.p().tab === "definitions"}>
          {() => this.definitionsTab()}
        </If>
        {this.unattributed()}
      </div>
    );
  }

  // ---- expressions tab ----

  expressionRows() {
    return this.summary().expressions.filter((r) => r.total > 0 || r.gpu > 0);
  }

  expressionsTab() {
    const rows = () => this.expressionRows();
    const visible = () =>
      this.p().showAll ? rows() : rows().slice(0, COLLAPSED_ROWS);
    const max = () =>
      Math.max(0, ...rows().map((r) => Math.max(r.total, r.gpu)));
    return (
      <div class="dsm-profiler-tab">
        {this.legend()}
        <If predicate={() => rows().length === 0}>
          {() => (
            <div class="dsm-profiler-empty">
              {format("profiler-no-expressions")}
            </div>
          )}
        </If>
        <div class="dsm-profiler-rows">
          <For each={visible} key={(r: ExpressionRow) => r.id}>
            {(row: () => ExpressionRow) => this.expressionRow(row, max)}
          </For>
        </div>
        {this.showAllToggle(() => rows().length)}
      </div>
    );
  }

  legend() {
    return (
      <div class="dsm-profiler-legend">
        <For each={() => [...SEGMENTS]} key={(s: Segment) => s}>
          {(seg: () => Segment) => (
            <Tooltip
              tooltip={() => format(`profiler-segment-${seg()}-tooltip`)}
              gravity="s"
            >
              <span class="dsm-profiler-legend-item">
                <span
                  class={() => `dsm-profiler-swatch dsm-profiler-${seg()}`}
                />
                {() => format(`profiler-segment-${seg()}`)}
              </span>
            </Tooltip>
          )}
        </For>
        <If predicate={() => this.summary().gpuTimer && this.p().gpuTiming}>
          {() => (
            <Tooltip
              tooltip={format("profiler-segment-gpu-tooltip")}
              gravity="s"
            >
              <span class="dsm-profiler-legend-item">
                <span class="dsm-profiler-swatch dsm-profiler-gpu" />
                {format("profiler-segment-gpu")}
              </span>
            </Tooltip>
          )}
        </If>
      </div>
    );
  }

  expressionRow(row: () => ExpressionRow, max: () => number) {
    return (
      <div
        class="dsm-profiler-row"
        role="button"
        tabindex="0"
        onTap={() => this.p().jumpTo(row().id)}
      >
        <div class="dsm-profiler-row-head">
          <span class="dsm-profiler-row-number">
            {() => {
              const n = this.p().expressionNumber(row().id);
              return n === undefined ? "" : `${n}`;
            }}
          </span>
          {this.exprLabel(
            () => this.p().expressionLatex(row().id),
            () => row().id
          )}
          <span class="dsm-profiler-row-time">
            {() => formatMs(row().total)}
          </span>
        </div>
        <Tooltip tooltip={() => this.breakdownTooltip(row())} gravity="s">
          <div class="dsm-profiler-bar">
            <For each={() => [...SEGMENTS]} key={(s: Segment) => s}>
              {(seg: () => Segment) => (
                <span
                  class={() => `dsm-profiler-bar-segment dsm-profiler-${seg()}`}
                  style={() => ({
                    width: `${barPercent(segmentsOf(row())[seg()], max())}%`,
                  })}
                />
              )}
            </For>
          </div>
        </Tooltip>
        <If predicate={() => row().gpu > 0}>
          {() => (
            <div class="dsm-profiler-bar dsm-profiler-bar-gpu">
              <span
                class="dsm-profiler-bar-segment dsm-profiler-gpu"
                style={() => ({ width: `${barPercent(row().gpu, max())}%` })}
              />
            </div>
          )}
        </If>
        <div class="dsm-profiler-badges">{() => this.badges(row())}</div>
      </div>
    );
  }

  exprLabel(latex: () => string | undefined, fallback: () => string) {
    return (
      <span class="dsm-profiler-row-label">
        <If predicate={() => latex() !== undefined}>
          {() => <StaticMathQuillView latex={() => latex() ?? ""} />}
        </If>
        <If predicate={() => latex() === undefined}>
          {() => (
            <span class="dsm-profiler-missing">
              {() => format("profiler-unknown-expression", { id: fallback() })}
            </span>
          )}
        </If>
      </span>
    );
  }

  breakdownTooltip(row: ExpressionRow) {
    const seg = segmentsOf(row);
    const parts = SEGMENTS.filter((s) => seg[s] > 0).map(
      (s) => `${format(`profiler-segment-${s}`)} ${formatMs(seg[s])}`
    );
    if (row.gpu > 0)
      parts.push(`${format("profiler-segment-gpu")} ${formatMs(row.gpu)}`);
    return parts.join(" · ");
  }

  badges(row: ExpressionRow) {
    const out: string[] = [];
    if (row.links > 0)
      out.push(format("profiler-badge-shader-compiles", { count: row.links }));
    if (row.shaderBlock > 0)
      out.push(
        format("profiler-badge-shader-wait", {
          duration: formatMs(row.shaderBlock),
        })
      );
    if (row.isError) out.push(format("profiler-badge-error"));
    return out.join(" · ");
  }

  // ---- definitions tab ----

  definitionsTab() {
    const rows = () => this.summary().sources.filter((r) => r.self > 0);
    const visible = () =>
      this.p().showAll ? rows() : rows().slice(0, COLLAPSED_ROWS);
    const max = () => Math.max(0, ...rows().map((r) => r.self));
    return (
      <div class="dsm-profiler-tab">
        <div class="dsm-profiler-explainer">
          {format("profiler-definitions-explainer")}
        </div>
        <If predicate={() => rows().length === 0}>
          {() => (
            <div class="dsm-profiler-empty">
              {format("profiler-no-definitions")}
            </div>
          )}
        </If>
        <div class="dsm-profiler-rows">
          <For each={visible} key={(r: SourceRow) => `${r.kind}:${r.symbol}`}>
            {(row: () => SourceRow) => this.definitionRow(row, max)}
          </For>
        </div>
        {this.showAllToggle(() => rows().length)}
      </div>
    );
  }

  definitionRow(row: () => SourceRow, max: () => number) {
    return (
      <div
        class={() => ({
          "dsm-profiler-row": true,
          "dsm-profiler-row-static": row().definedBy === undefined,
        })}
        role="button"
        tabindex="0"
        onTap={() => {
          const id = row().definedBy;
          if (id !== undefined) this.p().jumpTo(id);
        }}
      >
        <div class="dsm-profiler-row-head">
          <span class="dsm-profiler-row-label">
            <StaticMathQuillView
              latex={() =>
                symbolToLatex(row().symbol) +
                (row().kind === "fn" ? "\\left(\\right)" : "")
              }
            />
          </span>
          <If predicate={() => row().wackscope}>
            {() => (
              <Tooltip
                tooltip={format("profiler-wackscope-tooltip")}
                gravity="s"
              >
                <span class="dsm-profiler-pill">
                  {format("profiler-wackscope")}
                </span>
              </Tooltip>
            )}
          </If>
          <span class="dsm-profiler-row-time">
            {() => formatMs(row().self)}
          </span>
        </div>
        <Tooltip
          tooltip={() =>
            format("profiler-definition-tooltip", {
              self: formatMs(row().self),
              inclusive: formatMs(row().inclusive),
            })
          }
          gravity="s"
        >
          <div class="dsm-profiler-bar">
            <span
              class="dsm-profiler-bar-segment dsm-profiler-compile"
              style={() => ({ width: `${barPercent(row().self, max())}%` })}
            />
          </div>
        </Tooltip>
        <div class="dsm-profiler-badges">
          {() => {
            const r = row();
            const parts = [
              format("profiler-definition-uses", {
                compiles: r.compiles,
                exprs: r.usedBy,
              }),
            ];
            if (r.hits > 0)
              parts.push(format("profiler-definition-hits", { count: r.hits }));
            return parts.join(" · ");
          }}
        </div>
      </div>
    );
  }

  // ---- shared ----

  showAllToggle(count: () => number) {
    return (
      <If predicate={() => count() > COLLAPSED_ROWS}>
        {() => (
          <span
            class="dsm-profiler-link"
            role="button"
            tabindex="0"
            onTap={() => this.p().setShowAll(!this.p().showAll)}
          >
            {() =>
              this.p().showAll
                ? format("profiler-show-less")
                : format("profiler-show-all", { count: count() })
            }
          </span>
        )}
      </If>
    );
  }

  unattributed() {
    return (
      <Tooltip tooltip={format("profiler-unattributed-tooltip")} gravity="n">
        <div class="dsm-profiler-unattributed">
          {() => unattributedText(this.summary())}
        </div>
      </Tooltip>
    );
  }
}

function unattributedText(s: Summary) {
  const parts = [
    `${format("profiler-segment-compile")} ${formatMs(s.overhead.analysis)}`,
    `${format("profiler-segment-graph")} ${formatMs(s.overhead.graph)}`,
    `${format("profiler-other")} ${formatMs(s.overhead.other)}`,
  ];
  if (s.unattributed3D) {
    parts.push(`${format("profiler-3d")} ${formatMs(s.unattributed3D.total)}`);
    if (s.unattributed3D.gpu > 0)
      parts.push(
        `${format("profiler-segment-gpu")} ${formatMs(s.unattributed3D.gpu)}`
      );
  }
  return `${format("profiler-unattributed")}: ${parts.join(" · ")}`;
}

export function MainPopupFunc(profiler: Profiler): ProfilerView {
  return <ProfilerView profiler={() => profiler} />;
}
