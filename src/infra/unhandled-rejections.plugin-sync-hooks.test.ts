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
  return params.hookName === "tool_result_persist"
    ? params.runner.runToolResultPersist({ message: params.message }, {})
    : params.runner.runBeforeMessageWrite({ message: params.message }, {});
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
