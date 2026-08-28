// Plugin API lifecycle guard: registration-only methods stop working once
// register() returns, while runtime methods remain callable from hooks and tools.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildPluginApi } from "./api-builder.js";
import { runPluginRegisterSyncInRegistry } from "./loader-module-runtime.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
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
  runPluginRegisterSyncInRegistry(
    (pluginApi) => {
      captured = pluginApi;
    },
    api,
    createEmptyPluginRegistry(),
    "late-call-fixture",
  );
  return expectDefined(captured, "captured plugin api");
}

describe("plugin api lifecycle", () => {
  it("keeps both next-turn injection APIs callable after registration", async () => {
    const enqueueNextTurnInjection = vi.fn(async (injection) => ({
      enqueued: true,
      id: `injection-${injection.text}`,
      sessionKey: injection.sessionKey,
    }));
    const api = captureRegisteredPluginApi({ enqueueNextTurnInjection });

    const groupedResult = await api.session.workflow.enqueueNextTurnInjection({
      sessionKey: "agent:main:main",
      text: "grouped",
    });
    const flatResult = await api.enqueueNextTurnInjection({
      sessionKey: "agent:main:main",
      text: "flat",
    });

    expect(groupedResult).toEqual({
      enqueued: true,
      id: "injection-grouped",
      sessionKey: "agent:main:main",
    });
    expect(flatResult).toEqual({
      enqueued: true,
      id: "injection-flat",
      sessionKey: "agent:main:main",
    });
    expect(enqueueNextTurnInjection).toHaveBeenCalledTimes(2);
  });

  it("blocks registration-phase methods after registration", () => {
    const registerSessionExtension = vi.fn();
    const api = captureRegisteredPluginApi({ registerSessionExtension });

    const result = api.session.state.registerSessionExtension({
      namespace: "workflow",
      description: "workflow",
    });

    expect(result).toBeUndefined();
    expect(registerSessionExtension).not.toHaveBeenCalled();
  });

  it("keeps plugin-owned session state access callable after registration", async () => {
    const getSessionExtension = vi.fn(() => ({ checkpoint: "PR117" }));
    const setSessionExtension = vi.fn(async ({ value }) => value);
    const clearSessionExtension = vi.fn(async () => {});
    const api = captureRegisteredPluginApi({
      getSessionExtension,
      setSessionExtension,
      clearSessionExtension,
    });

    expect(
      api.session.state.getSessionExtension({
        sessionKey: "agent:main:main",
        namespace: "workflow",
      }),
    ).toEqual({ checkpoint: "PR117" });
    await expect(
      api.session.state.setSessionExtension({
        sessionKey: "agent:main:main",
        namespace: "workflow",
        value: { checkpoint: "PR118" },
      }),
    ).resolves.toEqual({ checkpoint: "PR118" });
    await expect(
      api.session.state.clearSessionExtension({
        sessionKey: "agent:main:main",
        namespace: "workflow",
      }),
    ).resolves.toBeUndefined();
  });
});
