import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { isTurnYieldAvailable, requestTurnYield } from "../plugin-sdk/tool-yield-runtime.js";
import { runPluginToolBodyWithTurnYieldLease } from "../plugins/runtime/tool-yield-context.js";
import { setPluginToolMeta } from "../plugins/tools.js";
import { applyPluginToolTurnYieldRuntime } from "./plugin-tool-yield.js";
import type { AnyAgentTool } from "./tools/common.js";
import { createTurnYieldController } from "./turn-yield-controller.js";

function createPluginTool(
  execute: AnyAgentTool["execute"],
  overrides: Partial<AnyAgentTool> = {},
): AnyAgentTool {
  const tool: AnyAgentTool = {
    name: "external_prompt",
    label: "External prompt",
    description: "Start an external interaction.",
    parameters: Type.Object({}),
    executionMode: "sequential",
    catalogMode: "direct-only",
    execute,
    ...overrides,
  };
  tool.execute = async (...args) =>
    await runPluginToolBodyWithTurnYieldLease({
      run: async () => await execute(...args),
    });
  setPluginToolMeta(tool, {
    pluginId: "external-prompt",
    optional: false,
    replaySafe: false,
    trustedLocalMedia: false,
  });
  return tool;
}

describe("plugin tool turn yield", () => {
  it("commits one request after a successful plugin tool result", async () => {
    const order: string[] = [];
    const result = {
      content: [{ type: "text" as const, text: "Interaction sent." }],
      details: { status: "pending", correlationId: "card-1" },
    };
    const tool = createPluginTool(async () => {
      order.push("execute");
      expect(isTurnYieldAvailable()).toBe(true);
      requestTurnYield("Waiting for card response");
      expect(isTurnYieldAvailable()).toBe(true);
      order.push("return");
      return result;
    });
    const onYield = vi.fn(async () => {
      order.push("yield");
    });
    const controller = createTurnYieldController({ sessionId: "session-1", onYield });
    const [wrapped] = applyPluginToolTurnYieldRuntime([tool], controller);

    await expect(wrapped?.execute("call-1", {})).resolves.toEqual({
      ...result,
      terminate: true,
    });

    expect(order).toEqual(["execute", "return", "yield"]);
    expect(onYield).toHaveBeenCalledOnce();
    expect(onYield).toHaveBeenCalledWith("Waiting for card response");
    expect(isTurnYieldAvailable()).toBe(false);
  });

  it("uses the sessions_yield default message and commits only once when nested", async () => {
    const onYield = vi.fn();
    const tool = createPluginTool(async () => {
      requestTurnYield("   ");
      requestTurnYield("ignored second request");
      return { content: [{ type: "text", text: "sent" }], details: { status: "pending" } };
    });
    const controller = createTurnYieldController({ sessionId: "session-1", onYield });
    const once = applyPluginToolTurnYieldRuntime([tool], controller);
    const twice = applyPluginToolTurnYieldRuntime(once, controller);

    await twice[0]?.execute("call-1", {});

    expect(onYield).toHaveBeenCalledOnce();
    expect(onYield).toHaveBeenCalledWith("Turn yielded.");
  });

  it("does not commit a request from a failed result or thrown execution", async () => {
    const onYield = vi.fn();
    const failedResult = {
      content: [{ type: "text" as const, text: "delivery failed" }],
      details: { status: "failed" },
    };
    const failedTool = createPluginTool(async () => {
      requestTurnYield("ignored");
      return failedResult;
    });
    const throwingTool = createPluginTool(
      async () => {
        requestTurnYield("ignored");
        throw new Error("delivery exploded");
      },
      { name: "throwing_prompt" },
    );

    const wrappedFailed = applyPluginToolTurnYieldRuntime(
      [failedTool],
      createTurnYieldController({ sessionId: "session-failed", onYield }),
    )[0];
    const wrappedThrowing = applyPluginToolTurnYieldRuntime(
      [throwingTool],
      createTurnYieldController({ sessionId: "session-throwing", onYield }),
    )[0];
    await expect(wrappedFailed?.execute("call-failed", {})).resolves.toBe(failedResult);
    await expect(wrappedThrowing?.execute("call-throw", {})).rejects.toThrow("delivery exploded");
    expect(onYield).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "sequential execution",
      overrides: { executionMode: "parallel" as const },
      expected: 'executionMode: "sequential"',
      withHandler: true,
    },
    {
      label: "direct catalog visibility",
      overrides: {},
      removeCatalogMode: true,
      expected: 'catalogMode: "direct-only"',
      withHandler: true,
    },
    {
      label: "runtime support",
      overrides: {},
      expected: "not supported by this runtime",
      withHandler: false,
    },
  ])(
    "fails explicitly without $label",
    async ({ overrides, removeCatalogMode, expected, withHandler }) => {
      const tool = createPluginTool(async () => {
        expect(isTurnYieldAvailable()).toBe(false);
        requestTurnYield("wait");
        return { content: [], details: {} };
      }, overrides);
      if (removeCatalogMode) {
        delete tool.catalogMode;
      }
      const wrapped = applyPluginToolTurnYieldRuntime(
        [tool],
        createTurnYieldController({
          sessionId: "session-1",
          onYield: withHandler ? vi.fn() : undefined,
        }),
      )[0];

      await expect(wrapped?.execute("call-1", {})).rejects.toThrow(expected);
    },
  );

  it("revokes detached work after the plugin tool settles", async () => {
    let releaseDetached: (() => void) | undefined;
    const detachedGate = new Promise<void>((resolve) => {
      releaseDetached = resolve;
    });
    let detachedRequest: Promise<void> | undefined;
    const tool = createPluginTool(async () => {
      detachedRequest = (async () => {
        await detachedGate;
        requestTurnYield("too late");
      })();
      return { content: [{ type: "text", text: "done" }], details: {} };
    });
    const wrapped = applyPluginToolTurnYieldRuntime(
      [tool],
      createTurnYieldController({ sessionId: "session-1", onYield: vi.fn() }),
    )[0];

    await wrapped?.execute("call-1", {});
    releaseDetached?.();

    await expect(detachedRequest).rejects.toThrow("requires an active plugin tool execution");
  });

  it("propagates a runtime commit failure from the yielding tool", async () => {
    const failure = new Error("runtime abort failed");
    const onYield = vi.fn(async () => {
      throw failure;
    });
    const yieldingTool = createPluginTool(async () => {
      requestTurnYield("wait");
      return { content: [{ type: "text", text: "sent" }], details: { status: "pending" } };
    });
    const [wrappedYielding] = applyPluginToolTurnYieldRuntime(
      [yieldingTool],
      createTurnYieldController({ sessionId: "session-1", onYield }),
    );

    await expect(wrappedYielding?.execute("call-yield", {})).rejects.toBe(failure);
    expect(onYield).toHaveBeenCalledOnce();
  });

  it("leaves non-plugin tools unchanged", () => {
    const coreTool: AnyAgentTool = {
      name: "core_tool",
      label: "Core tool",
      description: "Core tool",
      parameters: Type.Object({}),
      execute: vi.fn(async () => ({ content: [], details: {} })),
    };

    const [resolved] = applyPluginToolTurnYieldRuntime(
      [coreTool],
      createTurnYieldController({ sessionId: "session-1", onYield: vi.fn() }),
    );

    expect(resolved).toBe(coreTool);
  });
});
