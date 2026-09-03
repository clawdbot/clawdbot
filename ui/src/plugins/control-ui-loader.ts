import type { ControlUiDisposer, ControlUiPlugin } from "../../../src/plugin-sdk/control-ui.js";
import type { RouteId } from "../app-route-paths.ts";
import type { ApplicationContext } from "../app/context.ts";
import { createControlUiPluginHost } from "./control-ui-host.ts";
import type { ControlUiPluginOwner, ControlUiPluginRuntime } from "./control-ui-runtime.ts";
// Native mounts must be defined before activation can publish their registrations.
import "./control-ui-view.runtime.ts";

function assetUrl(descriptor: ControlUiPluginOwner["descriptor"], path: string): string {
  const url = new URL(path, window.location.href);
  const prefix = `/__openclaw__/plugins/control-ui/${encodeURIComponent(descriptor.pluginId)}/${encodeURIComponent(descriptor.revision)}/`;
  if (url.origin !== window.location.origin || !url.pathname.startsWith(prefix)) {
    throw new Error("Native plugin assets must be served by this Control UI Gateway.");
  }
  return url.href;
}

export async function initializeControlUiPlugin(
  getContext: () => ApplicationContext<RouteId>,
  runtime: ControlUiPluginRuntime,
  owner: Omit<ControlUiPluginOwner, "host">,
  styles: HTMLLinkElement[],
  dispose: ControlUiDisposer,
): Promise<ControlUiPluginOwner | undefined> {
  if (!runtime.isCurrent(owner)) {
    return undefined;
  }
  const { descriptor, abort } = owner;
  const complete: ControlUiPluginOwner = Object.assign(owner, {
    host: createControlUiPluginHost(getContext, runtime, owner),
  });
  const url = assetUrl(descriptor, descriptor.entryUrl);
  for (const path of descriptor.styles) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.media = "not all";
    link.href = assetUrl(descriptor, path);
    const loaded = new Promise<void>((resolve, reject) => {
      link.addEventListener("load", () => resolve(), { once: true, signal: abort.signal });
      link.addEventListener(
        "error",
        () => reject(new Error(`Could not load plugin stylesheet: ${descriptor.pluginId}`)),
        { once: true, signal: abort.signal },
      );
      abort.signal.addEventListener(
        "abort",
        () => reject(new Error("Plugin UI activation ended.")),
        { once: true },
      );
    });
    document.head.append(link);
    complete.disposers.add(() => link.remove());
    styles.push(link);
    await loaded;
  }
  const module: { default?: ControlUiPlugin } = await import(/* @vite-ignore */ url);
  if (!runtime.isCurrent(owner)) {
    dispose();
    return undefined;
  }
  if (module.default?.id !== descriptor.pluginId || typeof module.default.activate !== "function") {
    throw new Error("Native UI entry must export its matching defineControlUiPlugin definition.");
  }
  const stop = await module.default.activate(complete.host);
  if (stop) {
    complete.disposers.add(stop);
  }
  if (!runtime.isCurrent(owner)) {
    // An initializer can finish after its deadline has already disposed the owner.
    dispose();
    return undefined;
  }
  return complete;
}
