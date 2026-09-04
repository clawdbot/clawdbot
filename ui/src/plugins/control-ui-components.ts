import type {
  ControlUiComponentHandle,
  ControlUiComponents,
} from "../../../src/plugin-sdk/control-ui-components.js";
import type { RouteId } from "../app-routes.ts";
import type { ApplicationContext } from "../app/context.ts";
import { readGatewayOperatorAccess } from "../app/operator-access.ts";
import { icons } from "../components/icons.ts";

export function createControlUiComponents(options: {
  current: () => ApplicationContext<RouteId>;
  signal: AbortSignal;
  onError: (error: unknown) => void;
}): ControlUiComponents {
  function mount<P, E extends HTMLElement>(
    container: HTMLElement,
    initial: P,
    load: () => Promise<E>,
    apply: (element: E, props: P, current: () => ApplicationContext<RouteId>) => void,
    listen?: (element: E, props: () => P) => () => void,
  ): ControlUiComponentHandle<P> {
    options.current();
    options.signal.throwIfAborted();
    let props = initial;
    let element: E | undefined;
    let active = true;
    let unsubscribe: (() => void) | undefined;
    let unlisten: (() => void) | undefined;
    const current = () => {
      if (!active) {
        throw new Error("This plugin component has been disposed.");
      }
      options.signal.throwIfAborted();
      return options.current();
    };
    const refresh = () => {
      if (element && active) {
        apply(element, props, current);
      }
    };
    const dispose = () => {
      if (!active) {
        return;
      }
      active = false;
      options.signal.removeEventListener("abort", dispose);
      unsubscribe?.();
      unlisten?.();
      element?.remove();
    };
    options.signal.addEventListener("abort", dispose, { once: true });
    void load()
      .then((loaded) => {
        // Imports can finish after navigation or reload. The retired mount must
        // never reconnect a dialog, provider lease, or event callback.
        if (!active || options.signal.aborted) {
          return;
        }
        current();
        element = loaded;
        unlisten = listen?.(element, () => {
          current();
          return props;
        });
        refresh();
        container.append(element);
        const context = current();
        const stops = [context.gateway.subscribe(refresh), context.agents.subscribe(refresh)];
        unsubscribe = () => stops.forEach((stop) => stop());
      })
      .catch((error: unknown) => {
        if (active) {
          dispose();
          options.onError(error);
        }
      });
    return {
      update(next) {
        current();
        props = next;
        refresh();
      },
      dispose,
    };
  }

  return {
    mountDialog: (container, props) =>
      mount(
        container,
        props,
        async () => {
          await import("../components/modal-dialog.ts");
          return document.createElement("openclaw-modal-dialog");
        },
        (element, next) => {
          element.label = next.label;
          element.description = next.description ?? "";
          element.className = next.className ?? "";
          element.style.cssText = next.style ?? "";
          if (next.returnFocusTarget !== undefined) {
            element.setReturnFocusTarget(next.returnFocusTarget);
          }
          if (element.firstChild !== next.content) {
            element.replaceChildren(next.content);
          }
        },
        (element, getProps) => {
          const cancel = (event: Event) => {
            if (getProps().onCancel() === false) {
              event.preventDefault();
            }
          };
          element.addEventListener("modal-cancel", cancel);
          return () => element.removeEventListener("modal-cancel", cancel);
        },
      ),
    mountAgentPicker: (container, props) =>
      mount(
        container,
        props,
        async () => {
          await import("../components/agent-select-registration.ts");
          return document.createElement("openclaw-agent-select");
        },
        (element, next, current) => {
          const agents = current().agents.state.agentsList?.agents ?? [];
          element.options = next.options.map((option) => ({
            ...option,
            agent: agents.find((agent) => agent.id === option.agent?.id) ?? option.agent,
            icon: option.icon ? icons[option.icon] : undefined,
          }));
          element.value = next.value;
          element.placeholder = next.placeholder ?? "";
          element.accessibleLabel = next.accessibleLabel;
          element.menuLabel = next.menuLabel ?? "";
          element.disabled = next.disabled ?? false;
          element.onSelect = (value) => {
            current();
            next.onSelect(value);
          };
        },
      ),
    mountDashboard: (container, props) =>
      mount(
        container,
        props,
        async () => {
          await import("./control-ui-dashboard.ts");
          return document.createElement("openclaw-plugin-session-dashboard");
        },
        (element, next, current) => {
          const snapshot = current().gateway.snapshot;
          const access = readGatewayOperatorAccess(snapshot);
          element.session = next.session;
          element.client = snapshot.client;
          element.connected = snapshot.phase === "connected";
          element.canMutate = next.canMutate && access.canWrite;
          element.canGrant = next.canGrant && access.canGrantApprovals;
          element.presented = next.presented ?? true;
        },
      ),
  };
}
