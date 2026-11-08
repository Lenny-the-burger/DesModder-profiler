import AngleGrinder, { SliderRow, Status } from ".";
import { MarkedMath } from "./MarkedMath";
import "./View.less";
import type { ExpressionDiff, MarkedPart } from "./diff";
import { ShaderChange, UNIFORM_BUDGET, shaderChanges, totals } from "./summary";
import { Component, jsx } from "#DCGView";
import {
  Button,
  Checkbox,
  For,
  If,
  StaticMathQuillView,
  Switch,
} from "#components";
import { format } from "#i18n";

interface Props {
  ag: () => AngleGrinder;
}

function resultOf(s: Status) {
  return s.type === "done" || s.type === "applied" ? s.result : undefined;
}

class SliderList extends Component<Props> {
  template() {
    const ag = () => this.props.ag();
    return (
      <div class="dsm-ag-section">
        <div class="dsm-ag-section-head">
          <span class="dsm-ag-heading">{format("angle-grinder-varying")}</span>
          <span
            class="dsm-ag-link"
            role="button"
            onTap={() => ag().freezeStill()}
          >
            {format("angle-grinder-freeze-still")}
          </span>
          <span class="dsm-ag-link" role="button" onTap={() => ag().varyAll()}>
            {format("angle-grinder-vary-all")}
          </span>
        </div>
        <div class="dsm-ag-help">{format("angle-grinder-varying-help")}</div>
        <If predicate={() => ag().sliders.length === 0}>
          {() => (
            <div class="dsm-ag-empty">{format("angle-grinder-no-sliders")}</div>
          )}
        </If>
        <div class="dsm-ag-sliders">
          <For each={() => ag().sliders} key={(r) => r.symbol}>
            {(row: () => SliderRow) => (
              <div class="dsm-ag-slider">
                <Checkbox
                  checked={() => ag().isVarying(row())}
                  disabled={() => row().updated || ag().running}
                  small={true}
                  ariaLabel={() => row().symbol}
                  onChange={(v: boolean) => ag().setVarying(row(), v)}
                >
                  <StaticMathQuillView latex={() => row().latex} />
                </Checkbox>
                <span
                  class="dsm-ag-tag"
                  role="button"
                  onTap={() => ag().jumpTo(row().id)}
                >
                  {() =>
                    row().updated
                      ? format("angle-grinder-tag-action")
                      : row().playing
                        ? format("angle-grinder-tag-playing")
                        : ""
                  }
                </span>
              </div>
            )}
          </For>
        </div>
      </div>
    );
  }
}

class Changes extends Component<Props> {
  template() {
    const ag = () => this.props.ag();
    const diffs = () => resultOf(ag().status)?.diffs ?? [];
    const title = (p: MarkedPart) =>
      format("angle-grinder-diff-part", { count: p.size });
    const pick = (p: MarkedPart) => ag().jumpToDefinition(p.symbol);
    return (
      <div class="dsm-ag-section">
        <div class="dsm-ag-section-head">
          <span class="dsm-ag-heading">
            {() => format("angle-grinder-changes", { count: diffs().length })}
          </span>
          <span
            class="dsm-ag-link"
            role="button"
            onTap={() => ag().toggleChanges()}
          >
            {() =>
              ag().showChanges
                ? format("angle-grinder-hide")
                : format("angle-grinder-show")
            }
          </span>
        </div>
        <If predicate={() => ag().showChanges}>
          {() => (
            <div class="dsm-ag-diffs">
              <div class="dsm-ag-help">
                {format("angle-grinder-changes-help")}
              </div>
              <For each={() => diffs()} key={(d) => d.id}>
                {(d: () => ExpressionDiff) => (
                  <div class="dsm-ag-diff">
                    <div
                      class="dsm-ag-diff-name"
                      role="button"
                      onTap={() => ag().jumpTo(d().id)}
                    >
                      {() =>
                        format("angle-grinder-shader-restriction", {
                          n: ag().expressionNumber(d().id),
                        })
                      }
                    </div>
                    <If predicate={() => d().split > 0}>
                      {() => (
                        <div class="dsm-ag-diff-note">
                          {() =>
                            format("angle-grinder-diff-split", {
                              count: d().split,
                            })
                          }
                        </div>
                      )}
                    </If>
                    <If predicate={() => d().gpu.length > 0}>
                      {() => (
                        <div class="dsm-ag-diff-note">
                          {() =>
                            format("angle-grinder-diff-gpu", {
                              names: d().gpu.join(", "),
                            })
                          }
                        </div>
                      )}
                    </If>
                    <div class="dsm-ag-diff-lines">
                      <div class="dsm-ag-diff-line dsm-ag-diff-before">
                        <span class="dsm-ag-diff-sign">−</span>
                        <MarkedMath
                          marked={() => d().before}
                          renderKey={() => `${d().id}:before`}
                          partClass={() => "dsm-ag-part-before"}
                          title={title}
                          onPick={pick}
                        />
                      </div>
                      <div class="dsm-ag-diff-line dsm-ag-diff-after">
                        <span class="dsm-ag-diff-sign">+</span>
                        <MarkedMath
                          marked={() => d().after}
                          renderKey={() => `${d().id}:after`}
                          partClass={() => "dsm-ag-part-after"}
                          title={title}
                          onPick={pick}
                        />
                      </div>
                    </div>
                  </div>
                )}
              </For>
            </div>
          )}
        </If>
      </div>
    );
  }
}

class Results extends Component<Props> {
  template() {
    const ag = () => this.props.ag();
    const result = () => resultOf(ag().status)!;
    const before = () => totals(result().before);
    const after = () => totals(result().after);
    return (
      <div class="dsm-ag-section">
        <table class="dsm-ag-totals">
          <tr>
            <td>{format("angle-grinder-uniforms")}</td>
            <td>{() => before().uniforms}</td>
            <td>→</td>
            <td class="dsm-ag-after">{() => after().uniforms}</td>
          </tr>
          <tr>
            <td>
              {() =>
                format("angle-grinder-at-limit", { budget: UNIFORM_BUDGET })
              }
            </td>
            <td>{() => before().atLimit}</td>
            <td>→</td>
            <td class="dsm-ag-after">{() => after().atLimit}</td>
          </tr>
          <tr>
            <td>{format("angle-grinder-max-cost")}</td>
            <td>{() => before().maxCost}</td>
            <td>→</td>
            <td class="dsm-ag-after">{() => after().maxCost}</td>
          </tr>
        </table>
        <div class="dsm-ag-shaders">
          <For
            each={() => shaderChanges(result().before, result().after)}
            key={(c) => `${c.part}:${c.id}`}
          >
            {(c: () => ShaderChange) => (
              <div
                class="dsm-ag-shader"
                role="button"
                onTap={() => ag().jumpTo(c().id)}
              >
                <span class="dsm-ag-shader-name">
                  {() =>
                    format(
                      c().part === "color"
                        ? "angle-grinder-shader-color"
                        : "angle-grinder-shader-restriction",
                      { n: ag().expressionNumber(c().id) }
                    )
                  }
                </span>
                <span class="dsm-ag-shader-nums">
                  {() =>
                    `${c().before?.uniforms ?? "–"} → ${c().after?.uniforms ?? "–"}`
                  }
                </span>
              </div>
            )}
          </For>
        </div>
        <If predicate={() => result().inlined.length > 0}>
          {() => (
            <div class="dsm-ag-note">
              {() =>
                format("angle-grinder-summary", {
                  values: result().inlined.length,
                  expressions: result().diffs.filter(
                    (d) => d.before.parts.length > 0
                  ).length,
                })
              }
            </div>
          )}
        </If>
        <If predicate={() => result().split.length > 0}>
          {() => (
            <div class="dsm-ag-note">
              {() =>
                format("angle-grinder-split-summary", {
                  count: result().split.length,
                })
              }
            </div>
          )}
        </If>
        <If predicate={() => result().pushed.length > 0}>
          {() => (
            <div class="dsm-ag-note">
              {() =>
                format("angle-grinder-push-summary", {
                  count: result().pushed.length,
                })
              }
            </div>
          )}
        </If>
        <If predicate={() => result().diffs.length > 0}>
          {() => <Changes ag={ag} />}
        </If>
        <If predicate={() => result().skipped.length > 0}>
          {() => (
            <div class="dsm-ag-note">
              {() =>
                format("angle-grinder-skipped", {
                  count: result().skipped.length,
                })
              }
            </div>
          )}
        </If>
        <If predicate={() => result().newErrors.size > 0}>
          {() => (
            <div class="dsm-ag-warning">
              {() =>
                format("angle-grinder-new-errors", {
                  count: result().newErrors.size,
                })
              }
            </div>
          )}
        </If>
      </div>
    );
  }
}

export class AngleGrinderView extends Component<Props> {
  template() {
    const ag = () => this.props.ag();
    return (
      <div class="dcg-popover-interior dsm-angle-grinder">
        <div class="dcg-popover-title">{format("angle-grinder-name")}</div>
        <div class="dsm-ag-help">{format("angle-grinder-intro")}</div>
        <SliderList ag={ag} />
        <div class="dsm-ag-actions">
          <Button
            color="blue"
            disabled={() => ag().running}
            onTap={() => {
              ag()
                .run()
                .catch(() => {});
            }}
          >
            {() =>
              ag().status.type === "running"
                ? format("angle-grinder-running")
                : format("angle-grinder-run")
            }
          </Button>
          <span class="dsm-ag-step">
            {() => {
              const s = ag().status;
              return s.type === "running"
                ? format(`angle-grinder-step-${s.step}`)
                : "";
            }}
          </span>
        </div>
        <Switch key={() => ag().status.type}>
          {() => {
            switch (ag().status.type) {
              case "done":
                return (
                  <div>
                    <Results ag={ag} />
                    <div class="dsm-ag-actions">
                      <Button color="blue" onTap={() => ag().apply()}>
                        {format("angle-grinder-apply")}
                      </Button>
                    </div>
                    <div class="dsm-ag-help">
                      {format("angle-grinder-apply-help")}
                    </div>
                  </div>
                );
              case "applied":
                return (
                  <div>
                    <Results ag={ag} />
                    <div class="dsm-ag-note">
                      {format("angle-grinder-applied")}
                    </div>
                    <div class="dsm-ag-actions">
                      <Button color="light-gray" onTap={() => ag().restore()}>
                        {format("angle-grinder-restore")}
                      </Button>
                    </div>
                  </div>
                );
              case "error":
                return (
                  <div class="dsm-ag-warning">
                    {() => {
                      const s = ag().status;
                      return s.type === "error" ? s.message : "";
                    }}
                  </div>
                );
              default:
                return <span />;
            }
          }}
        </Switch>
      </div>
    );
  }
}

export function MainPopupFunc(ag: AngleGrinder) {
  return <AngleGrinderView ag={() => ag} />;
}
