import { html, nothing, render } from "lit";
import { AsyncDirective } from "lit/async-directive.js";
import { directive, type ElementPart } from "lit/directive.js";
import type { ControlUiHost } from "openclaw/plugin-sdk/control-ui";
import { workboardHost } from "../host.ts";

type Components = ControlUiHost["components"];
type DialogProps = Parameters<Components["mountDialog"]>[1];
type PickerProps = Parameters<Components["mountAgentPicker"]>[1];
type DashboardProps = Parameters<Components["mountDashboard"]>[1];
type ComponentInput =
  | { kind: "dialog"; props: Omit<DialogProps, "content">; content: unknown }
  | { kind: "picker"; props: PickerProps }
  | { kind: "dashboard"; props: DashboardProps };

class HostComponent extends AsyncDirective {
  private container?: HTMLElement;
  private content?: HTMLElement;
  private input?: ComponentInput;
  private kind?: ComponentInput["kind"];
  private disposeMount?: () => void;
  private updateMount?: (input: ComponentInput) => void;

  render(_input: ComponentInput) {
    return nothing;
  }

  override update(part: ElementPart, [input]: [ComponentInput]) {
    // SAFETY: This private directive is used only on the div containers in the templates below.
    this.container = part.element as HTMLElement;
    this.input = input;
    this.synchronize();
    return nothing;
  }

  private synchronize() {
    const input = this.input;
    const container = this.container;
    if (!input || !container) {
      return;
    }
    if (this.kind !== input.kind) {
      this.disposeMount?.();
      this.disposeMount = undefined;
      this.updateMount = undefined;
      this.kind = input.kind;
    }
    if (input.kind === "dialog") {
      this.content ??= document.createElement("div");
      this.content.style.display = "contents";
      // The plugin owns this Lit root; the host owns only the dialog that contains it.
      render(input.content, this.content);
    }
    if (this.updateMount) {
      this.updateMount(input);
      return;
    }
    const components = workboardHost().components;
    switch (input.kind) {
      case "dialog": {
        const content = this.content!;
        const handle = components.mountDialog(container, { ...input.props, content });
        this.disposeMount = handle.dispose;
        this.updateMount = (next) => {
          if (next.kind === "dialog") {
            handle.update({ ...next.props, content });
          }
        };
        break;
      }
      case "picker": {
        const handle = components.mountAgentPicker(container, input.props);
        this.disposeMount = handle.dispose;
        this.updateMount = (next) => {
          if (next.kind === "picker") {
            handle.update(next.props);
          }
        };
        break;
      }
      case "dashboard": {
        const handle = components.mountDashboard(container, input.props);
        this.disposeMount = handle.dispose;
        this.updateMount = (next) => {
          if (next.kind === "dashboard") {
            handle.update(next.props);
          }
        };
        break;
      }
    }
  }

  protected override disconnected() {
    this.disposeMount?.();
    this.disposeMount = undefined;
    this.updateMount = undefined;
    if (this.content) {
      render(nothing, this.content);
    }
  }

  protected override reconnected() {
    this.synchronize();
  }
}

const mountHostComponent = directive(HostComponent);

export function renderDialog(props: Omit<DialogProps, "content">, content: unknown) {
  return html`<div
    style="display: contents"
    ${mountHostComponent({ kind: "dialog", props, content })}
  ></div>`;
}

export function renderAgentPicker(props: PickerProps, className = "") {
  return html`<div class=${className} ${mountHostComponent({ kind: "picker", props })}></div>`;
}

export function renderDashboard(props: DashboardProps) {
  return html`<div
    class="workboard-card-dashboard"
    ${mountHostComponent({ kind: "dashboard", props })}
  ></div>`;
}
