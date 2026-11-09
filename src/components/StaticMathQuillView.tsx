import { DStaticMathquillView, MathQuillConfig } from "./desmosComponents";
import { Component, jsx } from "#DCGView";

export default class StaticMathquillView extends Component<{
  latex: string;
  config?: MathQuillConfig;
}> {
  template() {
    return (
      <DStaticMathquillView
        latex={() => this.props.latex()}
        // MathQuill renders nothing for LaTeX with a matrix unless told to.
        config={() => ({ matrices: true, ...this.props.config?.() })}
      />
    );
  }
}
