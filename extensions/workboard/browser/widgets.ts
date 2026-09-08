import { nothing, render } from "lit";
import type { ControlUiHost, ControlUiWidget } from "openclaw/plugin-sdk/control-ui";
import {
  renderWorkboardBoardWidget,
  renderWorkboardCardWidget,
  renderWorkboardMiniWidget,
} from "./widgets/render.ts";
import { acquireWidgetRuntime, WorkboardWidgetModel } from "./widgets/runtime.ts";

export function createWorkboardWidget(
  activationHost: ControlUiHost,
  kind: "mini" | "card" | "board",
): ControlUiWidget["mount"] {
  const renderer =
    kind === "mini"
      ? renderWorkboardMiniWidget
      : kind === "card"
        ? renderWorkboardCardWidget
        : renderWorkboardBoardWidget;
  return (container, initialContext) => {
    let context = initialContext;
    let lease: ReturnType<typeof acquireWidgetRuntime> | null = null;
    const draw = () => {
      if (!context.presented || !lease) {
        return;
      }
      const model = new WorkboardWidgetModel(
        context.host,
        lease.runtime,
        context.props.widget.props ?? {},
        () => context.presented && lease !== null && !context.signal.aborted,
        () => context.props.canMutate && context.host.connection.canWrite,
      );
      render(renderer(model), container);
    };
    const sync = () => {
      // Every mount receives a scoped host; the activation owns shared reads and mutation state.
      if (context.presented && !lease) {
        lease = acquireWidgetRuntime(activationHost, draw);
      }
      if (!context.presented && lease) {
        lease.release();
        lease = null;
      }
      draw();
    };
    sync();
    return {
      update(next) {
        context = next;
        sync();
      },
      dispose() {
        lease?.release();
        lease = null;
        render(nothing, container);
      },
    };
  };
}
