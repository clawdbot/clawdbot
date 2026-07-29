// Plugin API lifecycle guard: registration-only methods stop working once
// register() returns, runtime-phase methods keep working from hooks.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildPluginApi } from "./api-builder.js";
import type { PluginNextTurnInjection } from "./host-hooks.js";
import { runPluginRegisterSync } from "./loader-module-runtime.js";
import type { PluginRuntime } from "./runtime/types.js";
import type { OpenClawPluginApi } from "./types.js";

function captureRegisteredPluginApi(handlers: Parameters<typeof buildPluginApi>[0]["handlers"]) {
  const api = buildPluginApi({
    id: "late-call-fixture",
    name: "Late Call Fixture",
    source: "test",
    registrationMode: "full",
    config: {} as OpenClawConfig,
    runtime: {} as PluginRuntime,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    resolvePath: (input) => input,
    handlers,
  });
  let captured: OpenClawPluginApi | undefined;
  runPluginRegisterSync((pluginApi) => {
    captured = pluginApi;
  }, api);
  return expectDefined(captured, "captured plugin api");
}

describe("plugin api lifecycle", () => {
  it("keeps next-turn injections callable after registration", async () => {
    const injections: PluginNextTurnInjection[] = [];
    const api = captureRegisteredPluginApi({
      enqueueNextTurnInjection: async (injection) => {
        injections.push(injection);
        return { enqueued: true, id: "injection-1", sessionKey: injection.sessionKey };
      },
    });

    const result = await api.session.workflow.enqueueNextTurnInjection({
      sessionKey: "agent:main:main",
      text: "resume approval workflow",
    });

    expect(result).toEqual({ enqueued: true, id: "injection-1", sessionKey: "agent:main:main" });
    expect(injections).toHaveLength(1);
  });

  it("blocks registration-phase methods after registration", () => {
    const registered: string[] = [];
    const api = captureRegisteredPluginApi({
      registerSessionExtension: (extension) => {
        registered.push(extension.namespace);
      },
    });

    api.session.state.registerSessionExtension({ namespace: "workflow", description: "workflow" });
    expect(registered).toEqual([]);
  });
});
