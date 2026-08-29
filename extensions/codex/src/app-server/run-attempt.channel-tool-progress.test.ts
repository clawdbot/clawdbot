import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { itemNotification } from "./protocol.test-helpers.js";
import {
  createParams,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";

setupRunAttemptTestHooks();

describe("Codex channel tool progress", () => {
  it("keeps raw command detail behind the channel commandText policy", async () => {
    const harness = createStartedThreadHarness();
    const params = createParams(
      path.join(tempDir, "channel-command-privacy-session.jsonl"),
      path.join(tempDir, "channel-command-privacy-workspace"),
    );
    const onAgentEvent = vi.fn();
    const onToolResult = vi.fn();
    params.config = {
      channels: {
        telegram: {
          streaming: { mode: "progress", progress: { commandText: "status" } },
        },
      },
    };
    params.messageChannel = "telegram";
    params.toolProgressDetail = "raw";
    params.verboseLevel = "full";
    params.onAgentEvent = onAgentEvent;
    params.onToolResult = onToolResult;

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await harness.notify(
      itemNotification("item/started", {
        type: "commandExecution",
        id: "private-command-1",
        command: "printf raw-command-must-stay-private",
        cwd: params.workspaceDir,
        status: "inProgress",
      }),
    );

    expect(onToolResult).toHaveBeenCalledWith({ text: "🛠️ Bash" });
    const toolStart = onAgentEvent.mock.calls
      .map(([event]) => event)
      .find(
        (event) =>
          event.stream === "tool" &&
          event.data?.phase === "start" &&
          event.data?.toolCallId === "private-command-1",
      );
    expect(toolStart?.data?.args).toEqual({
      command: "printf raw-command-must-stay-private",
      cwd: params.workspaceDir,
    });
    expect(toolStart?.data?.meta).toContain("raw-command-must-stay-private");

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
  });

  it("keeps every tool source available to channel policy and verbose callbacks", async () => {
    const harness = createStartedThreadHarness();
    const params = createParams(
      path.join(tempDir, "channel-tool-progress-session.jsonl"),
      path.join(tempDir, "channel-tool-progress-workspace"),
    );
    const onAgentEvent = vi.fn();
    const onToolResult = vi.fn();
    params.messageChannel = "telegram";
    params.verboseLevel = "on";
    params.onAgentEvent = onAgentEvent;
    params.onToolResult = onToolResult;

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");

    const cases = [
      {
        label: "native command",
        toolCallId: "command-1",
        name: "bash",
        drive: async () => {
          await harness.notify(
            itemNotification("item/started", {
              type: "commandExecution",
              id: "command-1",
              command: "printf private-command",
              cwd: params.workspaceDir,
              status: "inProgress",
            }),
          );
          await harness.notify(
            itemNotification("item/completed", {
              type: "commandExecution",
              id: "command-1",
              command: "printf private-command",
              cwd: params.workspaceDir,
              status: "completed",
              aggregatedOutput: "done",
              exitCode: 0,
              durationMs: 1,
            }),
          );
        },
      },
      {
        label: "native file change",
        toolCallId: "patch-1",
        name: "apply_patch",
        drive: async () => {
          const item = {
            type: "fileChange",
            id: "patch-1",
            changes: [{ path: "proof.txt", kind: "update" }],
          };
          await harness.notify(itemNotification("item/started", { ...item, status: "inProgress" }));
          await harness.notify(
            itemNotification("item/completed", { ...item, status: "completed" }),
          );
        },
      },
      {
        label: "native web search",
        toolCallId: "search-1",
        name: "web_search",
        drive: async () => {
          const item = {
            type: "webSearch",
            id: "search-1",
            query: "OpenClaw repository",
            action: { type: "search", query: "OpenClaw repository" },
          };
          await harness.notify(itemNotification("item/started", { ...item, status: "inProgress" }));
          await harness.notify(
            itemNotification("item/completed", { ...item, status: "completed", durationMs: 1 }),
          );
        },
      },
      {
        label: "native MCP call",
        toolCallId: "mcp-1",
        name: "progressproof.parity_probe",
        drive: async () => {
          const item = {
            type: "mcpToolCall",
            id: "mcp-1",
            server: "progressproof",
            tool: "parity_probe",
            arguments: { marker: "telegram-progress" },
          };
          await harness.notify(itemNotification("item/started", { ...item, status: "inProgress" }));
          await harness.notify(
            itemNotification("item/completed", {
              ...item,
              status: "completed",
              result: { content: [{ type: "text", text: "ok" }] },
              durationMs: 1,
            }),
          );
        },
      },
      {
        label: "OpenClaw dynamic tool",
        toolCallId: "dynamic-1",
        name: "agents_list",
        drive: async () => {
          await harness.handleServerRequest({
            id: "request-dynamic-1",
            method: "item/tool/call",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              callId: "dynamic-1",
              namespace: null,
              tool: "agents_list",
              arguments: {},
            },
          });
        },
      },
    ];

    for (const testCase of cases) {
      const resultCount = onToolResult.mock.calls.length;
      await testCase.drive();
      const toolEvents = onAgentEvent.mock.calls
        .map(([event]) => event)
        .filter(
          (event) =>
            event.stream === "tool" &&
            event.data?.toolCallId === testCase.toolCallId &&
            event.data?.name === testCase.name,
        );

      expect(toolEvents, testCase.label).toHaveLength(2);
      expect(
        toolEvents.map((event) => event.data?.phase),
        `${testCase.label} lifecycle`,
      ).toEqual(["start", "result"]);
      for (const event of toolEvents) {
        expect(event.data, testCase.label).not.toHaveProperty("hideFromChannelProgress");
      }
      expect(onToolResult.mock.calls.length, `${testCase.label} verbose callback`).toBe(
        resultCount + 1,
      );
    }

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
  });
});
