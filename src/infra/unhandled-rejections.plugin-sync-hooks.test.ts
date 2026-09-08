import { describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "../agents/runtime/index.js";
import { createHookRunner } from "../plugins/hooks.js";
import { createMockPluginRegistry } from "../plugins/hooks.test-helpers.js";
import { spawnNodeEvalSync } from "../test-utils/node-process.js";

const syncHookNames = ["tool_result_persist", "before_message_write"] as const;
type SyncHookName = (typeof syncHookNames)[number];

function createToolResultMessage(text: string, details?: Record<string, unknown>): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: "call_1",
    content: [{ type: "text", text }],
    isError: false,
    ...(details ? { details } : {}),
  } as AgentMessage;
}

function createLogger() {
  return {
    warn: vi.fn<(message: string) => void>(),
    error: vi.fn<(message: string) => void>(),
  };
}

function runSyncHook(params: {
  hookName: SyncHookName;
  runner: ReturnType<typeof createHookRunner>;
  message: AgentMessage;
}) {
  return runSyncHookEvent({ ...params, event: { message: params.message } });
}

function runSyncHookEvent(params: {
  hookName: SyncHookName;
  runner: ReturnType<typeof createHookRunner>;
  event: { message: AgentMessage };
}) {
  return params.hookName === "tool_result_persist"
    ? params.runner.runToolResultPersist(params.event, {})
    : params.runner.runBeforeMessageWrite(params.event, {});
}

describe("sync-only plugin hooks", () => {
  it.each(syncHookNames)(
    "contains rejected %s handlers before the fatal rejection handler",
    (hookName) => {
      const method =
        hookName === "tool_result_persist" ? "runToolResultPersist" : "runBeforeMessageWrite";
      const result = spawnNodeEvalSync(
        `import { installUnhandledRejectionHandler } from "./src/infra/unhandled-rejections.ts";
       import { createHookRunner } from "./src/plugins/hooks.ts";
       import { createEmptyPluginRegistry } from "./src/plugins/registry-empty.ts";
       installUnhandledRejectionHandler();
       const registry = createEmptyPluginRegistry();
       registry.typedHooks.push({
         hookName: "${hookName}",
         pluginId: "rejected-sync-hook",
         source: "sync-only-regression",
         handler: () => Promise.reject(new Error("sync-hook-rejection")),
       });
       const warnings = [];
       const errors = [];
       const runner = createHookRunner(registry, {
         logger: { warn: (message) => warnings.push(message), error: (message) => errors.push(message) },
       });
       const message = { role: "toolResult", toolCallId: "call_1", content: [], isError: false };
       runner.${method}({ message }, {});
       await new Promise((resolve) => setImmediate(resolve));
       const expectedWarning = "[hooks] ${hookName} handler from rejected-sync-hook returned a Promise; this hook is synchronous and the result was ignored.";
       if (warnings.length !== 1 || warnings[0] !== expectedWarning || errors.length !== 0) {
         console.error(JSON.stringify({ warnings, errors }));
         process.exit(2);
       }
       console.log("sync hook rejection contained");`,
        { imports: ["tsx"], timeout: 20_000 },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("sync hook rejection contained");
      expect(result.stderr).not.toContain("Unhandled promise rejection");
    },
  );

  it.each(syncHookNames)("warns and ignores resolved %s handlers", (hookName) => {
    const logger = createLogger();
    const originalMessage = createToolResultMessage("original");
    const replacementMessage = createToolResultMessage("replacement");
    const runner = createHookRunner(
      createMockPluginRegistry([
        {
          hookName,
          pluginId: "resolved-sync-hook",
          handler: async () => ({ message: replacementMessage, block: true }),
        },
      ]),
      { logger },
    );

    const result = runSyncHook({ hookName, runner, message: originalMessage });

    expect(result).toEqual(
      hookName === "tool_result_persist" ? { message: originalMessage } : undefined,
    );
    expect(logger.warn.mock.calls).toEqual([
      [
        `[hooks] ${hookName} handler from resolved-sync-hook returned a Promise; this hook is synchronous and the result was ignored.`,
      ],
    ]);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it.each(syncHookNames)("composes synchronous %s results after fail-open errors", (hookName) => {
    const logger = createLogger();
    const originalMessage = createToolResultMessage("original");
    const replacementMessage = createToolResultMessage("replacement");
    const finalMessage = createToolResultMessage("final");
    const observer = vi.fn((event: unknown) => {
      expect((event as { message: AgentMessage }).message).toBe(replacementMessage);
      return { message: finalMessage };
    });
    const runner = createHookRunner(
      createMockPluginRegistry([
        {
          hookName,
          pluginId: "replacement-hook",
          priority: 30,
          handler: () => ({ message: replacementMessage }),
        },
        {
          hookName,
          pluginId: "failed-hook",
          priority: 20,
          handler: () => {
            throw new Error("sync-hook-failure");
          },
        },
        { hookName, pluginId: "observer-hook", priority: 10, handler: observer },
      ]),
      { logger },
    );

    expect(runSyncHook({ hookName, runner, message: originalMessage })).toEqual({
      message: finalMessage,
    });
    expect(observer).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(
      `[hooks] ${hookName} handler from failed-hook failed: Error: sync-hook-failure`,
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.each([
    ["tool_result_persist", "event"],
    ["before_message_write", "event"],
    ["tool_result_persist", "message"],
    ["before_message_write", "message"],
    ["before_message_write", "block"],
  ] as const)(
    "contains %s %s getter failures and continues composition",
    (hookName, getterName) => {
      const logger = createLogger();
      const originalMessage = createToolResultMessage("original");
      const finalMessage = createToolResultMessage("final");
      const event = { message: originalMessage };
      if (getterName === "event") {
        let reads = 0;
        Object.defineProperty(event, "hostile", {
          enumerable: true,
          get: () => {
            if (reads++ === 0) {
              throw new Error("event-getter-failure");
            }
            return true;
          },
        });
      }
      const failingHandler = vi.fn(() => {
        const result: { message?: AgentMessage; block?: boolean } = {};
        Object.defineProperty(result, getterName, {
          enumerable: true,
          get: () => {
            throw new Error(`${getterName}-getter-failure`);
          },
        });
        return result;
      });
      const runner = createHookRunner(
        createMockPluginRegistry([
          { hookName, pluginId: "getter", priority: 20, handler: failingHandler },
          {
            hookName,
            pluginId: "observer",
            priority: 10,
            handler: () => ({ message: finalMessage }),
          },
        ]),
        { logger },
      );

      expect(runSyncHookEvent({ hookName, runner, event })).toEqual({ message: finalMessage });
      expect(logger.error).toHaveBeenCalledWith(
        `[hooks] ${hookName} handler from getter failed: Error: ${getterName}-getter-failure`,
      );
      expect(failingHandler).toHaveBeenCalledTimes(getterName === "event" ? 0 : 1);
    },
  );

  it("does not read block from tool_result_persist results", () => {
    const replacementMessage = createToolResultMessage("replacement");
    let blockReads = 0;
    const result = { message: replacementMessage };
    Object.defineProperty(result, "block", {
      get: () => {
        blockReads += 1;
        throw new Error("tool-block-getter-failure");
      },
    });
    const runner = createHookRunner(
      createMockPluginRegistry([
        { hookName: "tool_result_persist", pluginId: "tool", handler: () => result },
      ]),
    );

    expect(
      runner.runToolResultPersist({ message: createToolResultMessage("original") }, {}),
    ).toEqual({ message: replacementMessage });
    expect(blockReads).toBe(0);
  });

  it.each(syncHookNames)(
    "fails closed on synchronous %s invocation errors and skips later handlers",
    (hookName) => {
      const cause = new Error("sync-hook-failure");
      const laterHandler = vi.fn();
      const runner = createHookRunner(
        createMockPluginRegistry([
          {
            hookName,
            pluginId: "failed",
            priority: 20,
            handler: () => {
              throw cause;
            },
          },
          { hookName, pluginId: "later", priority: 10, handler: laterHandler },
        ]),
        { failurePolicyByHook: { [hookName]: "fail-closed" } },
      );

      expect(() =>
        runSyncHook({ hookName, runner, message: createToolResultMessage("original") }),
      ).toThrow(
        expect.objectContaining({
          message: `[hooks] ${hookName} handler from failed failed: Error: sync-hook-failure`,
          cause,
        }),
      );
      expect(laterHandler).not.toHaveBeenCalled();
    },
  );

  it("preserves synchronous secret redaction and subsequent handler composition", () => {
    const logger = createLogger();
    const secret = ["fixture", "secret"].join("-");
    const originalMessage = createToolResultMessage(JSON.stringify({ value: secret }), {
      value: secret,
    });
    const observedMessages: AgentMessage[] = [];
    const runner = createHookRunner(
      createMockPluginRegistry([
        {
          hookName: "tool_result_persist",
          pluginId: "ignored-async-handler",
          priority: 30,
          handler: async () => ({ message: createToolResultMessage("ignored") }),
        },
        {
          hookName: "tool_result_persist",
          pluginId: "secret-redactor",
          priority: 20,
          handler: (event) => {
            const message = (event as { message: AgentMessage }).message;
            return {
              message: {
                ...message,
                content: [{ type: "text", text: JSON.stringify({ redacted: true }) }],
                details: { redacted: true },
              },
            };
          },
        },
        {
          hookName: "tool_result_persist",
          pluginId: "subsequent-handler",
          priority: 10,
          handler: (event) => {
            const message = (event as { message: AgentMessage }).message;
            observedMessages.push(message);
            return { message: { ...message, details: { redacted: true, observed: true } } };
          },
        },
      ]),
      { logger },
    );

    const result = runner.runToolResultPersist({ message: originalMessage }, {});

    expect(observedMessages).toHaveLength(1);
    expect(JSON.stringify(observedMessages[0])).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result?.message).toMatchObject({ details: { redacted: true, observed: true } });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("preserves synchronous message blocking and priority order", () => {
    const logger = createLogger();
    const calls: string[] = [];
    const runner = createHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_message_write",
          pluginId: "ignored-async-handler",
          priority: 30,
          handler: async () => {
            calls.push("async");
            return { block: false };
          },
        },
        {
          hookName: "before_message_write",
          pluginId: "message-blocker",
          priority: 20,
          handler: () => {
            calls.push("blocker");
            return { block: true };
          },
        },
        {
          hookName: "before_message_write",
          pluginId: "unreached-handler",
          priority: 10,
          handler: () => {
            calls.push("unreached");
          },
        },
      ]),
      { logger },
    );

    expect(
      runner.runBeforeMessageWrite({ message: createToolResultMessage("original") }, {}),
    ).toEqual({ block: true });
    expect(calls).toEqual(["async", "blocker"]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it.each(syncHookNames)("preserves fail-closed behavior for async %s handlers", (hookName) => {
    const logger = createLogger();
    const runner = createHookRunner(
      createMockPluginRegistry([
        {
          hookName,
          pluginId: "fail-closed-hook",
          handler: async () => undefined,
        },
      ]),
      { logger, failurePolicyByHook: { [hookName]: "fail-closed" } },
    );

    expect(() =>
      runSyncHook({ hookName, runner, message: createToolResultMessage("original") }),
    ).toThrow(
      `[hooks] ${hookName} handler from fail-closed-hook failed: Error: ` +
        `[hooks] ${hookName} handler from fail-closed-hook returned a Promise; ` +
        "this hook is synchronous and the result was ignored.",
    );
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });
});
