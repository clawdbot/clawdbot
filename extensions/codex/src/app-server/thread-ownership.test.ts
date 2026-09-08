import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { createCodexTestBindingStore } from "./session-binding.test-helpers.js";

describe("Codex thread ownership across module copies", () => {
  it("orders ordinary mutation and adoption while another thread proceeds", async () => {
    const first = await import("./thread-ownership.js");
    vi.resetModules();
    const second = await import("./thread-ownership.js");
    expect(first.withCodexAppServerThreadMutation).not.toBe(
      second.withCodexAppServerThreadMutation,
    );
    const bindingStore = createCodexTestBindingStore();
    const identity = { kind: "session" as const, agentId: "main", sessionId: "shared-session" };
    const threadId = "shared-thread";
    await bindingStore.mutate(identity, {
      kind: "set",
      binding: { threadId, cwd: "/before" },
    });
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const events: string[] = [];
    const mutation = first.withCodexAppServerThreadMutation(threadId, async () => {
      events.push("mutation");
      entered.resolve();
      await release.promise;
      await bindingStore.mutate(identity, {
        kind: "set",
        binding: { threadId, cwd: "/after" },
      });
    });
    await entered.promise;
    const adoption = second.withExclusiveCodexAppServerThread({
      bindingStore,
      identity,
      threadId,
      run: async () => {
        events.push("adoption");
        return bindingStore.read(identity);
      },
    });
    const completed = Promise.all([mutation, adoption]);
    try {
      await second.withCodexAppServerThreadMutation("other-thread", async () => {
        events.push("other");
      });
      expect(events).toEqual(["mutation", "other"]);
    } finally {
      release.resolve();
      await completed;
    }
    expect(events).toEqual(["mutation", "other", "adoption"]);
    await expect(adoption).resolves.toMatchObject({ threadId, cwd: "/after" });
  });

  it("shares conversation activity ordering across module copies", async () => {
    const first = await import("./thread-ownership.js");
    vi.resetModules();
    const second = await import("./thread-ownership.js");
    expect(first.withCodexConversationThreadActivity).not.toBe(
      second.withCodexConversationThreadActivity,
    );
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const events: string[] = [];
    const active = first.withCodexConversationThreadActivity("conversation", async () => {
      events.push("active");
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const waiting = second.withCodexConversationThreadActivity("conversation", async () => {
      events.push("waiting");
    });
    const completed = Promise.all([active, waiting]);
    try {
      await second.withCodexConversationThreadActivity("other-conversation", async () => {
        events.push("other");
      });
      expect(events).toEqual(["active", "other"]);
    } finally {
      release.resolve();
      await completed;
    }
    expect(events).toEqual(["active", "other", "waiting"]);
  });
});
