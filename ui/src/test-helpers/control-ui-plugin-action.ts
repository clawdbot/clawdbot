import { vi } from "vitest";
import type { ControlUiAction, ControlUiHost } from "../../../src/plugin-sdk/control-ui.js";
import type { ApplicationContext } from "../app/context.ts";

export function registerSessionPluginAction(
  context: Pick<ApplicationContext, "plugins">,
  action: ControlUiAction,
) {
  const lifetime = new AbortController();
  const open = vi.fn();
  const host = {
    signal: lifetime.signal,
    sessions: { open },
    agents: {},
    navigation: {},
    ui: {},
    components: {},
  } as unknown as ControlUiHost;
  const entry = {
    key: `review/${action.id}`,
    pluginId: "review",
    value: action,
    signal: lifetime.signal,
    host,
  };
  Object.assign(context.plugins, {
    registrations: vi.fn((kind) => (kind === "actions" ? [entry] : [])),
  });
  return { entry, lifetime, open };
}
