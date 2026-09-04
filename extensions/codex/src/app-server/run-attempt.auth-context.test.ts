import path from "node:path";
import { initializeGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import { itemNotification } from "./protocol.test-helpers.js";
import {
  createParams,
  createStartedThreadHarness,
  mockCall,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";

setupRunAttemptTestHooks();

describe("runCodexAppServerAttempt authenticated hook context", () => {
  it("preserves authenticated channel context across prompt and compaction hooks", async () => {
    const beforePromptBuild = vi.fn(() => undefined);
    const beforeCompaction = vi.fn(() => undefined);
    const afterCompaction = vi.fn(() => undefined);
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "before_prompt_build", handler: beforePromptBuild },
        { hookName: "before_compaction", handler: beforeCompaction },
        { hookName: "after_compaction", handler: afterCompaction },
      ]),
    );
    const sessionFile = path.join(tempDir, "authenticated-compaction.jsonl");
    const workspaceDir = path.join(tempDir, "authenticated-compaction-workspace");
    const params = createParams(sessionFile, workspaceDir);
    params.sandboxSessionKey = "global";
    params.messageChannel = "telegram";
    params.messageProvider = "telegram";
    params.currentChannelId = "telegram:-100123";
    params.messageTo = "telegram:-100123";
    params.agentAccountId = "account-a";
    params.senderId = "sender-a";
    params.channelContext = {
      sender: { id: "stale-sender", profile: "sender-profile" },
      chat: { id: "stale-chat", thread: "chat-thread" },
    };
    const harness = createStartedThreadHarness();

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await harness.notify(
      itemNotification("item/started", { type: "contextCompaction", id: "compact-1" }),
    );
    await harness.notify(
      itemNotification("item/completed", { type: "contextCompaction", id: "compact-1" }),
    );
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;

    const expectedContext = {
      accountId: "account-a",
      channel: "telegram",
      sessionKey: "agent:main:session-1",
      messageProvider: "telegram",
      channelId: "-100123",
      chatId: "-100123",
      senderId: "sender-a",
      channelContext: {
        sender: { id: "sender-a", profile: "sender-profile" },
        chat: { id: "-100123", thread: "chat-thread" },
      },
    };
    for (const [hookName, hook] of [
      ["before_prompt_build", beforePromptBuild],
      ["before_compaction", beforeCompaction],
      ["after_compaction", afterCompaction],
    ] as const) {
      expect(hook).toHaveBeenCalledOnce();
      const [, hookContext] = mockCall(hook, hookName) as [unknown, Record<string, unknown>];
      expect(hookContext).toMatchObject(expectedContext);
    }
  });

  it("omits sender and chat identity from non-user prompt and compaction hooks", async () => {
    const beforePromptBuild = vi.fn(() => undefined);
    const beforeCompaction = vi.fn(() => undefined);
    const afterCompaction = vi.fn(() => undefined);
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "before_prompt_build", handler: beforePromptBuild },
        { hookName: "before_compaction", handler: beforeCompaction },
        { hookName: "after_compaction", handler: afterCompaction },
      ]),
    );
    const params = createParams(
      path.join(tempDir, "system-compaction.jsonl"),
      path.join(tempDir, "system-compaction-workspace"),
    );
    params.trigger = "heartbeat";
    params.messageChannel = "telegram";
    params.messageProvider = "telegram";
    params.currentChannelId = "telegram:-100123";
    params.agentAccountId = "account-a";
    params.senderId = "must-not-leak";
    params.channelContext = {
      sender: { id: "must-not-leak" },
      chat: { id: "must-not-leak" },
    };
    const harness = createStartedThreadHarness();

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await harness.notify(
      itemNotification("item/started", { type: "contextCompaction", id: "compact-1" }),
    );
    await harness.notify(
      itemNotification("item/completed", { type: "contextCompaction", id: "compact-1" }),
    );
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;

    for (const [hookName, hook] of [
      ["before_prompt_build", beforePromptBuild],
      ["before_compaction", beforeCompaction],
      ["after_compaction", afterCompaction],
    ] as const) {
      expect(hook).toHaveBeenCalledOnce();
      const [, hookContext] = mockCall(hook, hookName) as [unknown, Record<string, unknown>];
      expect(hookContext).toMatchObject({
        accountId: "account-a",
        channel: "telegram",
        trigger: "heartbeat",
      });
      expect(hookContext).not.toHaveProperty("senderId");
      expect(hookContext).not.toHaveProperty("chatId");
      expect(hookContext).not.toHaveProperty("channelContext");
    }
  });
});
