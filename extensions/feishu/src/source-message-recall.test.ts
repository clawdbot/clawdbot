import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getChannelRuntimeContext } from "openclaw/plugin-sdk/channel-runtime-context";
import {
  closeOpenClawStateDatabaseForTest,
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
  setMaxPluginStateEntriesPerPluginForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bindFeishuSourceMessageRun,
  isFeishuSourceMessageRecalled,
  recallFeishuSourceMessage,
} from "./source-message-recall.js";

const RECALL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const RECALL_MAX_ENTRIES = 2_000;

let stateDir = "";

function channelRuntime() {
  return createPluginRuntimeMock().channel;
}

function recallStore(accountId: string) {
  const accountNamespace = createHash("sha256").update(accountId).digest("hex");
  return createPluginStateSyncKeyedStoreForTests<{ recalledAt: number }>("feishu", {
    namespace: `feishu.source-message-recalls.${accountNamespace}`,
    maxEntries: RECALL_MAX_ENTRIES,
    defaultTtlMs: RECALL_TTL_MS,
  });
}

function sourceMessageKey(messageId: string): string {
  return createHash("sha256").update(messageId).digest("hex");
}

function recallRegistry(runtime: ReturnType<typeof channelRuntime>) {
  return getChannelRuntimeContext({
    channelRuntime: runtime,
    channelId: "feishu",
    accountId: "default",
    capability: "source-message-recall",
  }) as {
    loaded: boolean;
    states: Map<string, unknown>;
    store: { entries: () => unknown[] };
  };
}

beforeEach(async () => {
  stateDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-feishu-recall-")));
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  resetPluginStateStoreForTests();
});

afterEach(async () => {
  setMaxPluginStateEntriesPerPluginForTests(undefined);
  resetPluginStateStoreForTests();
  closeOpenClawStateDatabaseForTest();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await fs.rm(stateDir, { recursive: true, force: true });
});

describe("Feishu source-message recall persistence", () => {
  it("blocks replay after a fresh runtime starts", () => {
    const firstRuntime = channelRuntime();
    recallFeishuSourceMessage({
      channelRuntime: firstRuntime,
      accountId: "default",
      messageId: "om-restart",
    });

    expect(
      isFeishuSourceMessageRecalled({
        channelRuntime: channelRuntime(),
        accountId: "default",
        messageId: "om-restart",
      }),
    ).toBe(true);
  });

  it("expires persisted recalls after the ingress retention horizon", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T00:00:00.000Z"));
    const runtime = channelRuntime();
    recallFeishuSourceMessage({
      channelRuntime: runtime,
      accountId: "default",
      messageId: "om-expiring",
    });

    vi.advanceTimersByTime(RECALL_TTL_MS);

    expect(
      isFeishuSourceMessageRecalled({
        channelRuntime: runtime,
        accountId: "default",
        messageId: "om-expiring",
      }),
    ).toBe(false);
  });

  it("isolates identical source IDs by account", () => {
    recallFeishuSourceMessage({
      channelRuntime: channelRuntime(),
      accountId: "account-a",
      messageId: "om-shared",
    });

    expect(
      isFeishuSourceMessageRecalled({
        channelRuntime: channelRuntime(),
        accountId: "account-a",
        messageId: "om-shared",
      }),
    ).toBe(true);
    expect(
      isFeishuSourceMessageRecalled({
        channelRuntime: channelRuntime(),
        accountId: "account-b",
        messageId: "om-shared",
      }),
    ).toBe(false);
  });

  it("evicts the oldest persisted recall at capacity", () => {
    const store = recallStore("default");
    for (let index = 0; index < RECALL_MAX_ENTRIES; index += 1) {
      store.register(sourceMessageKey(`om-capacity-${index}`), { recalledAt: Date.now() });
    }
    const runtime = channelRuntime();
    recallFeishuSourceMessage({
      channelRuntime: runtime,
      accountId: "default",
      messageId: `om-capacity-${RECALL_MAX_ENTRIES}`,
    });

    expect(
      isFeishuSourceMessageRecalled({
        channelRuntime: runtime,
        accountId: "default",
        messageId: "om-capacity-0",
      }),
    ).toBe(false);
    const restartedRuntime = channelRuntime();
    expect(
      isFeishuSourceMessageRecalled({
        channelRuntime: restartedRuntime,
        accountId: "default",
        messageId: "om-capacity-0",
      }),
    ).toBe(false);
    expect(
      isFeishuSourceMessageRecalled({
        channelRuntime: restartedRuntime,
        accountId: "default",
        messageId: `om-capacity-${RECALL_MAX_ENTRIES}`,
      }),
    ).toBe(true);
  });

  it("does not abort active work when the durable write fails", async () => {
    const runtime = channelRuntime();
    const binding = bindFeishuSourceMessageRun({
      channelRuntime: runtime,
      accountId: "default",
      messageId: "om-write-failure",
    });
    resetPluginStateStoreForTests();
    await fs.rm(stateDir, { recursive: true, force: true });
    await fs.writeFile(stateDir, "not a directory");

    expect(() =>
      recallFeishuSourceMessage({
        channelRuntime: runtime,
        accountId: "default",
        messageId: "om-write-failure",
      }),
    ).toThrow("Failed to open the plugin state database");
    expect(binding?.abortSignal.aborted).toBe(false);
    const laterBinding = bindFeishuSourceMessageRun({
      channelRuntime: runtime,
      accountId: "default",
      messageId: "om-write-failure",
    });
    expect(laterBinding?.abortSignal.aborted).toBe(false);
  });

  it("does not abort active work when the plugin-wide row fuse rejects the recall", () => {
    setMaxPluginStateEntriesPerPluginForTests(1);
    const sibling = createPluginStateSyncKeyedStoreForTests("feishu", {
      namespace: "feishu.recall-fuse-test",
      maxEntries: 1,
    });
    sibling.register("occupied", { retained: true });
    const runtime = channelRuntime();
    const binding = bindFeishuSourceMessageRun({
      channelRuntime: runtime,
      accountId: "default",
      messageId: "om-fuse-failure",
    });

    expect(() =>
      recallFeishuSourceMessage({
        channelRuntime: runtime,
        accountId: "default",
        messageId: "om-fuse-failure",
      }),
    ).toThrow("exceeds the 1 live row limit");
    expect(binding?.abortSignal.aborted).toBe(false);
  });

  it("does not retain failed recall attempts in the runtime registry", () => {
    setMaxPluginStateEntriesPerPluginForTests(1);
    const sibling = createPluginStateSyncKeyedStoreForTests("feishu", {
      namespace: "feishu.recall-bounded-failure-test",
      maxEntries: 1,
    });
    sibling.register("occupied", { retained: true });
    const runtime = channelRuntime();
    expect(
      isFeishuSourceMessageRecalled({
        channelRuntime: runtime,
        accountId: "default",
        messageId: "om-prime-registry",
      }),
    ).toBe(false);

    for (let index = 0; index < 50; index += 1) {
      expect(() =>
        recallFeishuSourceMessage({
          channelRuntime: runtime,
          accountId: "default",
          messageId: `om-failed-${index}`,
        }),
      ).toThrow("exceeds the 1 live row limit");
    }
    expect(recallRegistry(runtime).states.size).toBe(0);
  });

  it("aborts current work and reloads durable truth after post-write sync fails", () => {
    const runtime = channelRuntime();
    const binding = bindFeishuSourceMessageRun({
      channelRuntime: runtime,
      accountId: "default",
      messageId: "om-post-write-read-failure",
    });
    const registry = recallRegistry(runtime);
    const entries = registry.store.entries;
    registry.store.entries = () => {
      registry.store.entries = entries;
      throw new Error("post-write entries failed");
    };

    expect(() =>
      recallFeishuSourceMessage({
        channelRuntime: runtime,
        accountId: "default",
        messageId: "om-post-write-read-failure",
      }),
    ).toThrow("post-write entries failed");
    expect(binding?.abortSignal.aborted).toBe(true);
    expect(registry.loaded).toBe(false);
    expect(
      isFeishuSourceMessageRecalled({
        channelRuntime: runtime,
        accountId: "default",
        messageId: "om-post-write-read-failure",
      }),
    ).toBe(true);
    expect(registry.loaded).toBe(true);
  });

  it("keeps in-process active-run cancellation unchanged", () => {
    const runtime = channelRuntime();
    const binding = bindFeishuSourceMessageRun({
      channelRuntime: runtime,
      accountId: "default",
      messageId: "om-active",
    });

    const result = recallFeishuSourceMessage({
      channelRuntime: runtime,
      accountId: "default",
      messageId: "om-active",
    });

    expect(result).toMatchObject({ recorded: true, abortedRuns: 1, alreadyRecalled: false });
    expect(binding?.abortSignal.aborted).toBe(true);
  });
});
