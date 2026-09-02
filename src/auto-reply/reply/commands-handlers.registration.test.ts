import { describe, expect, it, vi } from "vitest";

const observation = vi.hoisted(() => ({ imports: 0, loads: 0 }));

vi.mock("./commands-handlers.runtime.js", async (importOriginal) => {
  observation.imports++;
  const actual = await importOriginal<typeof import("./commands-handlers.runtime.js")>();
  return {
    ...actual,
    loadCommandHandlers: () => {
      observation.loads++;
      return actual.loadCommandHandlers();
    },
  };
});

describe("command handler registration", () => {
  it("lazily dispatches the real handlers with plugin precedence and one cached list", async () => {
    vi.resetModules();
    const { registerPluginCommandInRegistry } =
      await import("../../plugins/command-registration.js");
    const { createEmptyPluginRegistry } = await import("../../plugins/registry-empty.js");
    const { withPluginRuntimeRegistryScope } =
      await import("../../plugins/runtime/gateway-request-scope.js");
    const { buildCommandTestParams } = await import("./commands.test-harness.js");
    const { handleCommands } = await import("./commands-core.js");
    const registry = createEmptyPluginRegistry();

    const dispatch = (body: string, suppressed = false) => {
      const params = buildCommandTestParams(
        body,
        { commands: { text: true } },
        { SenderId: "registry-sender", CommandInterpretationSuppressed: suppressed },
      );
      params.skillCommands = [];
      expect(params.command.isAuthorizedSender).toBe(true);
      expect(params.command.senderIsOwner).toBe(false);
      return withPluginRuntimeRegistryScope(registry, () => handleCommands(params));
    };

    expect(observation).toEqual({ imports: 0, loads: 0 });
    expect(await dispatch("/name", true)).toEqual({ shouldContinue: true });
    expect(observation).toEqual({ imports: 0, loads: 0 });
    expect(await dispatch("/name")).toMatchObject({
      shouldContinue: false,
      reply: { text: "Naming is not available for this session." },
    });
    expect(observation).toEqual({ imports: 1, loads: 1 });

    const plugin = vi.fn(() => ({ text: "registry plugin reply", continueAgent: true }));
    expect(
      registerPluginCommandInRegistry(registry, "registry-test", {
        name: "login",
        description: "Exercise command precedence",
        handler: plugin,
      }),
    ).toEqual({ ok: true });

    // A handled result still wins when it asks the agent to continue afterward.
    expect(await dispatch("/login")).toMatchObject({
      shouldContinue: true,
      reply: { text: "registry plugin reply" },
    });
    expect(plugin).toHaveBeenCalledTimes(1);
    // This plugin declines arguments; the real built-in must reach its owner gate.
    expect(await dispatch("/login ignored")).toMatchObject({
      shouldContinue: false,
      reply: {
        text: "Only a configured OpenClaw owner/admin can start provider login from this channel.",
      },
    });
    expect(plugin).toHaveBeenCalledTimes(1);
    expect(observation).toEqual({ imports: 1, loads: 1 });

    const { loadCommandHandlers } = await import("./commands-handlers.runtime.js");
    const handlers = loadCommandHandlers();
    const nextHandlers = loadCommandHandlers();
    expect(new Set(handlers).size).toBe(handlers.length);
    expect(nextHandlers).toEqual(handlers);
    expect(nextHandlers).not.toBe(handlers);
  });
});
