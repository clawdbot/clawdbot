import path from "node:path";
import { describe, expect, it } from "vitest";
import { itemNotification } from "./protocol.test-helpers.js";
import {
  createParams,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";

setupRunAttemptTestHooks();

describe("Codex app-server notification bursts", () => {
  it("drains bound command output without one macrotask per notification", async () => {
    const harness = createStartedThreadHarness();
    const params = createParams(
      path.join(tempDir, "session-notification-burst.jsonl"),
      path.join(tempDir, "workspace-notification-burst"),
    );
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await harness.notify(
      itemNotification("item/started", {
        type: "commandExecution",
        id: "cmd-burst",
        command: "generate realistic output burst",
        cwd: params.workspaceDir,
        processId: null,
        source: "agent",
        status: "inProgress",
        commandActions: [],
        aggregatedOutput: null,
        exitCode: null,
        durationMs: null,
      }),
    );

    const notificationCount = 128;
    const handledOrder: number[] = [];
    const notifications = Array.from({ length: notificationCount }, (_, index) =>
      harness
        .notify({
          method: "item/commandExecution/outputDelta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "cmd-burst",
            delta: `${index.toString().padStart(3, "0")}:${"x".repeat(8_188)}`,
          },
        })
        .then(() => {
          handledOrder.push(index);
        }),
    );

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(handledOrder).toHaveLength(notificationCount);
    await Promise.all(notifications);
    expect(handledOrder).toEqual(Array.from({ length: notificationCount }, (_, index) => index));

    await harness.notify(
      itemNotification("item/completed", {
        type: "commandExecution",
        id: "cmd-burst",
        command: "generate realistic output burst",
        cwd: params.workspaceDir,
        processId: 42,
        source: "agent",
        status: "completed",
        commandActions: [],
        aggregatedOutput: null,
        exitCode: 0,
        durationMs: 20,
      }),
    );
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    const result = await run;
    expect(JSON.stringify(result.messagesSnapshot)).toContain('"toolCallId":"cmd-burst"');
  });
});
