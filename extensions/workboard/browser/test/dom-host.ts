import type { ControlUiHost } from "openclaw/plugin-sdk/control-ui";
import { vi } from "vitest";

/** The fixture exposes only the DOM-mount contract; host component internals have their own tests. */
export function installDomComponents(host: ControlUiHost): void {
  host.components.mountDialog = vi.fn((container, initial) => {
    const element = document.createElement("section");
    element.dataset.testDialog = "";
    let props = initial;
    const apply = (next: typeof initial) => {
      props = next;
      element.setAttribute("aria-label", next.label);
      element.setAttribute("aria-description", next.description ?? "");
      element.className = next.className ?? "";
      if (element.firstChild !== next.content) {
        element.replaceChildren(next.content);
      }
    };
    element.addEventListener("cancel", (event) => {
      if (props.onCancel() === false) {
        event.preventDefault();
      }
    });
    apply(initial);
    container.append(element);
    return { update: vi.fn(apply), dispose: vi.fn(() => element.remove()) };
  });
  host.components.mountAgentPicker = vi.fn((container, initial) => {
    const element = document.createElement("span");
    element.dataset.testAgentPicker = "";
    const apply = (props: typeof initial) => {
      Object.assign(element, props);
    };
    apply(initial);
    container.append(element);
    return { update: vi.fn(apply), dispose: vi.fn(() => element.remove()) };
  });
  host.components.mountDashboard = vi.fn((container, initial) => {
    const element = document.createElement("section");
    element.dataset.testDashboard = "";
    const apply = (props: typeof initial) => {
      Object.assign(element, props);
    };
    apply(initial);
    container.append(element);
    return { update: vi.fn(apply), dispose: vi.fn(() => element.remove()) };
  });
}
