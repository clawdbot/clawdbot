// Plugin API lifecycle guard: registration-only methods stop working once
// register() returns, while runtime methods remain callable from hooks and tools.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildPluginApi } from "./api-builder.js";
import { isLateCallablePluginApiMethod } from "./api-lifecycle.js";
import { runPluginRegisterSyncInRegistry } from "./loader-module-runtime.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import type { PluginRuntime } from "./runtime/types.js";
import type { OpenClawPluginApi } from "./types.js";

function createPluginApi(handlers: Parameters<typeof buildPluginApi>[0]["handlers"] = {}) {
  return buildPluginApi({
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
}

function captureRegisteredPluginApi(handlers: Parameters<typeof buildPluginApi>[0]["handlers"]) {
  const api = createPluginApi(handlers);
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
  it("returns inert results for unwired runtime and scheduler handlers", async () => {
    const api = createPluginApi();
    const sessionKey = "agent:main:main";

    expect(api.emitAgentEvent({ runId: "run", stream: "lifecycle", data: {} })).toEqual({
      emitted: false,
      reason: "not wired",
    });
    expect(api.setRunContext({ runId: "run", namespace: "workflow", value: 1 })).toBe(false);
    expect(api.getRunContext({ runId: "run", namespace: "workflow" })).toBeUndefined();
    expect(
      api.registerSessionSchedulerJob({ id: "job", sessionKey, kind: "session-turn" }),
    ).toBeUndefined();
    await expect(api.enqueueNextTurnInjection({ sessionKey, text: "queued" })).resolves.toEqual({
      enqueued: false,
      id: "",
      sessionKey,
    });
    await expect(
      api.sendSessionAttachment({ sessionKey, files: [{ path: "/tmp/attachment.txt" }] }),
    ).resolves.toEqual({ ok: false, error: "not wired" });
    await expect(
      api.scheduleSessionTurn({ sessionKey, message: "wake", delayMs: 1_000 }),
    ).resolves.toBeUndefined();
    await expect(api.unscheduleSessionTurnsByTag({ sessionKey, tag: "wake" })).resolves.toEqual({
      removed: 0,
      failed: 0,
    });
  });

  it("keeps inherited handlers, undefined defaults, and one captured CLI lookup", () => {
    const reads: string[] = [];
    const registerCli = vi.fn<OpenClawPluginApi["registerCli"]>();
    const registerHook = vi.fn<OpenClawPluginApi["registerHook"]>();
    class InheritedHandlers {
      get registerCli() {
        reads.push("cli");
        return registerCli;
      }
      get registerTool() {
        reads.push("tool");
        return undefined;
      }
      get registerHook() {
        reads.push("hook");
        return registerHook;
      }
    }
    const api = createPluginApi(new InheritedHandlers());
    const hook: Parameters<OpenClawPluginApi["registerHook"]>[1] = () => {};
    const registrar: Parameters<OpenClawPluginApi["registerCli"]>[0] = () => {};

    const toolFactory = vi.fn(() => null);
    expect(api.registerTool(toolFactory)).toBeUndefined();
    expect(toolFactory).not.toHaveBeenCalled();
    expect(api.registerHook).toBe(registerHook);
    expect(api.registerCli).toBe(registerCli);
    api.registerHook("message_received", hook);
    expect(registerHook).toHaveBeenCalledExactlyOnceWith("message_received", hook);
    api.registerNodeCliFeature(registrar, { commands: ["camera"] });
    expect(registerCli).toHaveBeenCalledExactlyOnceWith(registrar, {
      commands: ["camera"],
      parentPath: ["nodes"],
    });
    expect(reads).toEqual(["cli", "tool", "hook"]);
  });

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

  it.each<[string, boolean]>([
    ["clearRunContext", true],
    ["emitAgentEvent", true],
    ["enqueueNextTurnInjection", true],
    ["getRunContext", true],
    ["sendSessionAttachment", true],
    ["scheduleSessionTurn", true],
    ["setRunContext", true],
    ["unscheduleSessionTurnsByTag", true],
    ["registerTool", false],
    ["registerSessionExtension", false],
    ["unknown", false],
    ["", false],
    ["constructor", false],
    ["toString", false],
    ["__proto__", false],
  ])("classifies late-call eligibility for %j as %s", (methodName, expected) => {
    expect(isLateCallablePluginApiMethod(methodName)).toBe(expected);
  });
});
