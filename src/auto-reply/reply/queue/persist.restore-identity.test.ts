import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { clearRuntimeConfigSnapshot } from "../../../config/runtime-snapshot.js";
import {
  followupQueueEntryContainsPrompt,
  replaceFollowupQueueEntries,
} from "../../../infra/followup-queue-sqlite.js";
import { defaultRuntime } from "../../../runtime.js";
import {
  clearFollowupQueuesRestoredFlagForTest,
  clearRestoredPendingDrainKeysForTest,
  hasPersistedFollowupQueues,
  peekRestoredPendingDrainKeys,
  persistFollowupQueues,
  restoreFollowupQueues,
  setRestoredFollowupQueuesListener,
} from "./persist.js";
import {
  FOLLOWUP_PERSIST_TEST_KEY as TEST_KEY,
  FOLLOWUP_PERSIST_TEST_SETTINGS as SETTINGS,
  createFollowupPersistTestItem as makeFollowupRun,
  createFollowupPersistTestRun as makeRun,
  readFollowupPersistQueueEntry as readPersistedQueueEntry,
} from "./persist.test-helpers.js";
import { FOLLOWUP_QUEUES, getFollowupQueue } from "./state.js";

describe("persistFollowupQueues restore identity", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let tmpDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tmpDir = tempDirs.make("openclaw-persist-test-");
    originalEnv = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    FOLLOWUP_QUEUES.clear();
    clearRestoredPendingDrainKeysForTest();
    clearFollowupQueuesRestoredFlagForTest();
    clearRuntimeConfigSnapshot();
  });

  afterEach(() => {
    FOLLOWUP_QUEUES.clear();
    clearFollowupQueuesRestoredFlagForTest();
    setRestoredFollowupQueuesListener(undefined);
    clearRuntimeConfigSnapshot();
    if (originalEnv === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalEnv;
    }
  });

  function restorePersistedQueueForTest() {
    FOLLOWUP_QUEUES.delete(TEST_KEY);
    clearFollowupQueuesRestoredFlagForTest();
    restoreFollowupQueues();
  }

  it("does not persist or restore raw channel identities or owner privilege", () => {
    const run = makeRun();
    run.senderId = "telegram-user-1";
    run.senderName = "Ada";
    run.senderUsername = "ada";
    run.senderE164 = "+15550000000";
    run.channelContext = { chat: { id: "12345", extra: "open-ended-identity" } };
    run.senderIsOwner = true;
    run.traceAuthorized = true;
    run.ownerNumbers = ["+15550000000"];
    const queue = getFollowupQueue(TEST_KEY, SETTINGS);
    queue.items.push({ ...makeFollowupRun("owner-turn"), run });
    queue.lastRun = run;
    persistFollowupQueues();

    const persisted = readPersistedQueueEntry(TEST_KEY) as {
      items: Array<{ run: Record<string, unknown> }>;
      lastRun?: Record<string, unknown>;
    };
    expect(persisted.items[0]?.run).not.toHaveProperty("senderId");
    expect(persisted.items[0]?.run).not.toHaveProperty("senderName");
    expect(persisted.items[0]?.run).not.toHaveProperty("senderUsername");
    expect(persisted.items[0]?.run).not.toHaveProperty("senderE164");
    expect(persisted.items[0]?.run).not.toHaveProperty("channelContext");
    expect(persisted.items[0]?.run).not.toHaveProperty("senderIsOwner");
    expect(persisted.items[0]?.run).not.toHaveProperty("traceAuthorized");
    expect(persisted.items[0]?.run).not.toHaveProperty("ownerNumbers");
    expect(JSON.stringify(persisted)).not.toContain("telegram-user-1");
    expect(JSON.stringify(persisted)).not.toContain("open-ended-identity");

    restorePersistedQueueForTest();

    const restored = FOLLOWUP_QUEUES.get(TEST_KEY);
    expect(restored?.items[0]?.run.senderId).toBeUndefined();
    expect(restored?.items[0]?.run.senderName).toBeUndefined();
    expect(restored?.items[0]?.run.senderUsername).toBeUndefined();
    expect(restored?.items[0]?.run.senderE164).toBeUndefined();
    expect(restored?.items[0]?.run.channelContext).toBeUndefined();
    expect(restored?.items[0]?.run.senderIsOwner).toBe(false);
    expect(restored?.items[0]?.run.traceAuthorized).toBe(false);
    expect(restored?.items[0]?.run.ownerNumbers).toEqual([]);
    expect(restored?.lastRun?.senderId).toBeUndefined();
    expect(restored?.lastRun?.channelContext).toBeUndefined();
    expect(restored?.lastRun?.senderIsOwner).toBe(false);
    expect(restored?.lastRun?.traceAuthorized).toBe(false);
    expect(restored?.lastRun?.ownerNumbers).toEqual([]);
    expect(restored?.items[0]?.originatingChannel).toBe("telegram");
    expect(restored?.items[0]?.originatingTo).toBe("12345");
  });

  it("marks restored identity-less collect entries for individual draining", () => {
    const collectSettings = { ...SETTINGS, mode: "collect" as const, debounceMs: 0 };
    const queue = getFollowupQueue(TEST_KEY, collectSettings);
    for (const senderId of ["user-1", "user-2"]) {
      const run = makeRun();
      run.senderId = senderId;
      run.senderName = senderId;
      queue.items.push({ ...makeFollowupRun(`from ${senderId}`), run });
    }
    persistFollowupQueues();

    const persisted = readPersistedQueueEntry(TEST_KEY) as {
      items: Array<{ run: Record<string, unknown>; disableCollectBatching?: boolean }>;
    };
    expect(persisted.items).toHaveLength(2);
    expect(persisted.items.every((item) => !item.run.senderId)).toBe(true);

    restorePersistedQueueForTest();

    const restored = FOLLOWUP_QUEUES.get(TEST_KEY)?.items ?? [];
    expect(restored).toHaveLength(2);
    expect(restored.map((item) => item.prompt)).toEqual(["from user-1", "from user-2"]);
    expect(restored.every((item) => item.disableCollectBatching === true)).toBe(true);
    expect(restored.every((item) => item.run.senderId === undefined)).toBe(true);
  });

  it("does not restore persisted exec elevation or exec overrides", () => {
    const run = makeRun();
    run.elevatedLevel = "full";
    run.execOverrides = { host: "gateway", security: "full", ask: "off" };
    run.bashElevated = { enabled: true, allowed: true, defaultLevel: "full" };
    const queue = getFollowupQueue(TEST_KEY, SETTINGS);
    queue.items.push({ ...makeFollowupRun("elevated-turn"), run });
    persistFollowupQueues();

    const persisted = readPersistedQueueEntry(TEST_KEY) as {
      items: Array<{ run: Record<string, unknown> }>;
    };
    expect(persisted.items[0]?.run).not.toHaveProperty("elevatedLevel");
    expect(persisted.items[0]?.run).not.toHaveProperty("execOverrides");
    expect(persisted.items[0]?.run).not.toHaveProperty("bashElevated");

    restorePersistedQueueForTest();

    const restored = FOLLOWUP_QUEUES.get(TEST_KEY)?.items[0]?.run;
    expect(restored?.elevatedLevel).toBeUndefined();
    expect(restored?.execOverrides).toBeUndefined();
    expect(restored?.bashElevated).toBeUndefined();
  });

  it("fences exec authority even if an older SQLite row still serialized it", () => {
    const validRun = makeRun();
    replaceFollowupQueueEntries({
      entries: [
        [
          TEST_KEY,
          {
            items: [
              {
                prompt: "stale-elevated",
                enqueuedAt: Date.now(),
                originatingChannel: "telegram",
                originatingTo: "12345",
                run: {
                  ...validRun,
                  elevatedLevel: "full",
                  execOverrides: { ask: "off" },
                  bashElevated: { enabled: true, allowed: true, defaultLevel: "on" },
                },
              },
            ],
            mode: "steer",
            lastEnqueuedAt: 1,
            droppedCount: 0,
            summaryLines: [],
          },
        ],
      ],
    });
    restoreFollowupQueues();
    const restored = FOLLOWUP_QUEUES.get(TEST_KEY)?.items[0]?.run;
    expect(restored?.elevatedLevel).toBeUndefined();
    expect(restored?.execOverrides).toBeUndefined();
    expect(restored?.bashElevated).toBeUndefined();
  });

  it("does not restore client-bound caps, tool bindings, or approval device ids", () => {
    const validRun = makeRun();
    replaceFollowupQueueEntries({
      entries: [
        [
          TEST_KEY,
          {
            items: [
              {
                prompt: "stale-client-bindings",
                enqueuedAt: Date.now(),
                originatingChannel: "telegram",
                originatingTo: "12345",
                run: {
                  ...validRun,
                  clientCaps: ["images"],
                  toolBindings: { search: { enabled: true } },
                  approvalReviewerDeviceId: "device-stale",
                },
              },
            ],
            mode: "steer",
            lastEnqueuedAt: 1,
            droppedCount: 0,
            summaryLines: [],
          },
        ],
      ],
    });
    restoreFollowupQueues();
    const restored = FOLLOWUP_QUEUES.get(TEST_KEY)?.items[0]?.run;
    expect(restored?.clientCaps).toBeUndefined();
    expect(restored?.toolBindings).toBeUndefined();
    expect(restored?.approvalReviewerDeviceId).toBeUndefined();
  });

  it("fail-closes role-dependent follow-ups instead of draining without member roles", () => {
    const roleRun = makeRun();
    roleRun.memberRoleIds = ["operator", "member"];
    roleRun.messageProvider = "discord";
    const safeRun = makeRun();
    const queue = getFollowupQueue(TEST_KEY, SETTINGS);
    queue.items.push({
      ...makeFollowupRun("discord-role-gated"),
      originatingChannel: "discord",
      originatingTo: "channel:ops",
      run: roleRun,
    });
    queue.items.push({
      ...makeFollowupRun("telegram-plain"),
      run: safeRun,
    });
    persistFollowupQueues();

    const persisted = readPersistedQueueEntry(TEST_KEY) as {
      items: Array<{
        prompt?: string;
        roleDependent?: true;
        run: Record<string, unknown>;
      }>;
    };
    const roleRow = persisted.items.find((item) => item.prompt === "discord-role-gated");
    const plainRow = persisted.items.find((item) => item.prompt === "telegram-plain");
    expect(roleRow?.roleDependent).toBe(true);
    expect(roleRow?.run).not.toHaveProperty("memberRoleIds");
    expect(plainRow?.roleDependent).toBeUndefined();

    restorePersistedQueueForTest();

    const restored = FOLLOWUP_QUEUES.get(TEST_KEY);
    expect(restored?.items.map((item) => item.prompt)).toEqual(["telegram-plain"]);
    expect(restored?.items[0]?.run.memberRoleIds).toBeUndefined();
    expect(followupQueueEntryContainsPrompt(TEST_KEY, "discord-role-gated")).toBe(false);
    expect(followupQueueEntryContainsPrompt(TEST_KEY, "telegram-plain")).toBe(true);
    expect(peekRestoredPendingDrainKeys().has(TEST_KEY)).toBe(true);
  });

  it("drops a leading role-dependent overflow source with its summary line", () => {
    const validRun = makeRun();
    const roleRun = { ...makeRun(), memberRoleIds: ["admins"] };
    replaceFollowupQueueEntries({
      entries: [
        [
          TEST_KEY,
          {
            items: [],
            mode: "steer",
            droppedCount: 2,
            summaryLines: ["role-gated-overflow-text", "safe-overflow-text"],
            summarySources: [
              {
                prompt: "role-gated-overflow-text",
                enqueuedAt: Date.now(),
                originatingChannel: "discord",
                originatingTo: "channel:ops",
                roleDependent: true,
                run: roleRun,
              },
              {
                prompt: "safe-overflow-text",
                enqueuedAt: Date.now(),
                originatingChannel: "telegram",
                originatingTo: "12345",
                run: validRun,
              },
            ],
            lastEnqueuedAt: 1,
          },
        ],
      ],
    });

    restoreFollowupQueues();

    const restored = FOLLOWUP_QUEUES.get(TEST_KEY);
    expect(restored?.summarySources.map((item) => item.prompt)).toEqual(["safe-overflow-text"]);
    expect(restored?.summaryLines).toEqual(["safe-overflow-text"]);
    expect(restored?.droppedCount).toBe(1);
    expect(followupQueueEntryContainsPrompt(TEST_KEY, "role-gated-overflow-text")).toBe(false);
    expect(followupQueueEntryContainsPrompt(TEST_KEY, "safe-overflow-text")).toBe(true);
  });

  it("does not wake a queue that only contained role-dependent work", () => {
    const roleRun = makeRun();
    roleRun.memberRoleIds = ["admins"];
    const queue = getFollowupQueue(TEST_KEY, SETTINGS);
    queue.items.push({
      ...makeFollowupRun("role-only"),
      originatingChannel: "discord",
      originatingTo: "channel:ops",
      run: roleRun,
    });
    persistFollowupQueues();
    expect(followupQueueEntryContainsPrompt(TEST_KEY, "role-only")).toBe(true);

    restorePersistedQueueForTest();

    expect(FOLLOWUP_QUEUES.get(TEST_KEY)).toBeUndefined();
    expect(peekRestoredPendingDrainKeys().has(TEST_KEY)).toBe(false);
    expect(followupQueueEntryContainsPrompt(TEST_KEY, "role-only")).toBe(false);
    expect(hasPersistedFollowupQueues()).toBe(false);
  });

  it("fail-closes legacy memberRoleIds rows that lack the roleDependent marker", () => {
    const validRun = makeRun();
    replaceFollowupQueueEntries({
      entries: [
        [
          TEST_KEY,
          {
            items: [
              {
                prompt: "legacy-role-row",
                enqueuedAt: Date.now(),
                originatingChannel: "discord",
                originatingTo: "channel:ops",
                run: {
                  ...validRun,
                  memberRoleIds: ["operator"],
                },
              },
            ],
            mode: "steer",
            lastEnqueuedAt: 1,
            droppedCount: 0,
            summaryLines: [],
          },
        ],
      ],
    });
    restoreFollowupQueues();
    expect(FOLLOWUP_QUEUES.get(TEST_KEY)).toBeUndefined();
    expect(peekRestoredPendingDrainKeys().has(TEST_KEY)).toBe(false);
    expect(followupQueueEntryContainsPrompt(TEST_KEY, "legacy-role-row")).toBe(false);
  });

  it("fail-closes canceled follow-ups instead of replaying them after restart", () => {
    const queue = getFollowupQueue(TEST_KEY, SETTINGS);
    queue.items.push({
      ...makeFollowupRun("canceled-after-ack-failure"),
      canceled: true,
    });
    persistFollowupQueues();
    expect(followupQueueEntryContainsPrompt(TEST_KEY, "canceled-after-ack-failure")).toBe(true);

    const persisted = readPersistedQueueEntry(TEST_KEY) as {
      items: Array<{ prompt?: string; canceled?: true }>;
    };
    expect(persisted.items[0]?.canceled).toBe(true);

    restorePersistedQueueForTest();

    expect(FOLLOWUP_QUEUES.get(TEST_KEY)).toBeUndefined();
    expect(peekRestoredPendingDrainKeys().has(TEST_KEY)).toBe(false);
    expect(followupQueueEntryContainsPrompt(TEST_KEY, "canceled-after-ack-failure")).toBe(false);
  });

  it("fail-closes delivered follow-ups instead of replaying them after restart", () => {
    const queue = getFollowupQueue(TEST_KEY, SETTINGS);
    queue.items.push({
      ...makeFollowupRun("delivered-before-omit-ack"),
      delivered: true,
    });
    persistFollowupQueues();
    expect(followupQueueEntryContainsPrompt(TEST_KEY, "delivered-before-omit-ack")).toBe(true);

    const persisted = readPersistedQueueEntry(TEST_KEY) as {
      items: Array<{ prompt?: string; delivered?: true }>;
    };
    expect(persisted.items[0]?.delivered).toBe(true);

    restorePersistedQueueForTest();

    expect(FOLLOWUP_QUEUES.get(TEST_KEY)).toBeUndefined();
    expect(peekRestoredPendingDrainKeys().has(TEST_KEY)).toBe(false);
    expect(followupQueueEntryContainsPrompt(TEST_KEY, "delivered-before-omit-ack")).toBe(false);
  });

  it("fail-closes canceled overflow summary sources instead of replaying them after restart", () => {
    const queue = getFollowupQueue(TEST_KEY, SETTINGS);
    queue.droppedCount = 1;
    queue.summaryLines = ["canceled-overflow-source"];
    queue.summarySources = [
      {
        ...makeFollowupRun("canceled-overflow-source"),
        canceled: true,
      },
    ];
    persistFollowupQueues();
    expect(followupQueueEntryContainsPrompt(TEST_KEY, "canceled-overflow-source")).toBe(true);

    restorePersistedQueueForTest();

    expect(FOLLOWUP_QUEUES.get(TEST_KEY)).toBeUndefined();
    expect(peekRestoredPendingDrainKeys().has(TEST_KEY)).toBe(false);
    expect(followupQueueEntryContainsPrompt(TEST_KEY, "canceled-overflow-source")).toBe(false);
  });

  it("fail-closes canceled overflow elision sources instead of replaying them after restart", () => {
    const queue = getFollowupQueue(TEST_KEY, SETTINGS);
    queue.droppedCount = 1;
    queue.summaryLines = [];
    queue.summaryElisions = [
      {
        contextKey: "route-a",
        count: 1,
        sources: [
          {
            ...makeFollowupRun("canceled-overflow-elision"),
            canceled: true,
          },
        ],
        summaryLines: ["canceled-overflow-elision"],
        sourceRefs: new WeakMap(),
      },
    ];
    persistFollowupQueues();
    expect(followupQueueEntryContainsPrompt(TEST_KEY, "canceled-overflow-elision")).toBe(true);

    restorePersistedQueueForTest();

    expect(FOLLOWUP_QUEUES.get(TEST_KEY)).toBeUndefined();
    expect(peekRestoredPendingDrainKeys().has(TEST_KEY)).toBe(false);
    expect(followupQueueEntryContainsPrompt(TEST_KEY, "canceled-overflow-elision")).toBe(false);
  });

  it("does not log queued prompts when fail-closing canceled follow-ups", () => {
    const secret = "canceled-fail-secret-token-do-not-log";
    const queue = getFollowupQueue(TEST_KEY, SETTINGS);
    queue.items.push({
      ...makeFollowupRun(secret),
      messageId: "tg-canceled-secret",
      canceled: true,
    });
    persistFollowupQueues();

    const errorSpy = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    try {
      FOLLOWUP_QUEUES.delete(TEST_KEY);
      clearFollowupQueuesRestoredFlagForTest();
      restoreFollowupQueues();

      const logged = errorSpy.mock.calls
        .map((call) => (typeof call[0] === "string" ? call[0] : ""))
        .join("\n");
      expect(logged).toContain(TEST_KEY);
      expect(logged).toContain("messageId=tg-canceled-secret");
      expect(logged).toContain("channel=telegram");
      expect(logged).not.toContain(secret);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("does not log queued prompts when fail-closing role-dependent follow-ups", () => {
    const secret = "role-fail-secret-token-do-not-log";
    const roleRun = makeRun();
    roleRun.memberRoleIds = ["operator"];
    const queue = getFollowupQueue(TEST_KEY, SETTINGS);
    queue.items.push({
      ...makeFollowupRun(secret),
      messageId: "tg-role-secret",
      originatingChannel: "discord",
      originatingTo: "channel:ops",
      run: roleRun,
    });
    persistFollowupQueues();

    const errorSpy = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    try {
      FOLLOWUP_QUEUES.delete(TEST_KEY);
      clearFollowupQueuesRestoredFlagForTest();
      restoreFollowupQueues();

      const logged = errorSpy.mock.calls
        .map((call) => (typeof call[0] === "string" ? call[0] : ""))
        .join("\n");
      expect(logged).toContain(TEST_KEY);
      expect(logged).toContain("messageId=tg-role-secret");
      expect(logged).toContain("channel=discord");
      expect(logged).not.toContain(secret);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("round-trips terminal reply expectation without restoring delegated authority", () => {
    const run = makeRun();
    run.terminalReplyExpectation = "required";
    const queue = getFollowupQueue(TEST_KEY, SETTINGS);
    queue.items.push({
      ...makeFollowupRun("required-reply"),
      run,
    });
    persistFollowupQueues();

    const persisted = readPersistedQueueEntry(TEST_KEY) as {
      items: Array<{
        delegatedAuthority?: true;
        run: {
          trustedInternalHandoff?: unknown;
          runtimePluginToolGrant?: unknown;
          terminalReplyExpectation?: unknown;
        };
      }>;
    };
    expect(persisted.items[0]?.delegatedAuthority).toBeUndefined();
    expect(persisted.items[0]?.run).not.toHaveProperty("trustedInternalHandoff");
    expect(persisted.items[0]?.run).not.toHaveProperty("runtimePluginToolGrant");
    expect(persisted.items[0]?.run.terminalReplyExpectation).toBe("required");

    restorePersistedQueueForTest();
    const restored = FOLLOWUP_QUEUES.get(TEST_KEY)?.items[0];
    expect(restored?.run.trustedInternalHandoff).toBeUndefined();
    expect(restored?.run.runtimePluginToolGrant).toBeUndefined();
    expect(restored?.run.terminalReplyExpectation).toBe("required");
  });

  it("fail-closes delegated-authority follow-ups instead of restoring copied claims", () => {
    const handoffRun = makeRun();
    handoffRun.trustedInternalHandoff = {
      kind: "subagent-completion",
      sourceSessionKey: "agent:child",
      targetSessionKey: "agent:parent",
      targetSessionId: "session-1",
      provider: "openai",
      model: "gpt-route",
    };
    const grantRun = makeRun();
    grantRun.runtimePluginToolGrant = {
      pluginId: "workboard",
      toolNames: ["workboard_complete"],
    };
    const queue = getFollowupQueue(TEST_KEY, SETTINGS);
    queue.items.push({
      ...makeFollowupRun("handoff-turn"),
      run: handoffRun,
    });
    queue.items.push({
      ...makeFollowupRun("grant-turn"),
      run: grantRun,
    });
    queue.items.push(makeFollowupRun("ordinary-turn"));
    persistFollowupQueues();

    const persisted = readPersistedQueueEntry(TEST_KEY) as {
      items: Array<{
        prompt?: string;
        delegatedAuthority?: true;
        run: Record<string, unknown>;
      }>;
    };
    const handoffRow = persisted.items.find((item) => item.prompt === "handoff-turn");
    const grantRow = persisted.items.find((item) => item.prompt === "grant-turn");
    const ordinaryRow = persisted.items.find((item) => item.prompt === "ordinary-turn");
    expect(handoffRow?.delegatedAuthority).toBe(true);
    expect(handoffRow?.run).not.toHaveProperty("trustedInternalHandoff");
    expect(grantRow?.delegatedAuthority).toBe(true);
    expect(grantRow?.run).not.toHaveProperty("runtimePluginToolGrant");
    expect(ordinaryRow?.delegatedAuthority).toBeUndefined();

    restorePersistedQueueForTest();
    expect(FOLLOWUP_QUEUES.get(TEST_KEY)?.items.map((item) => item.prompt)).toEqual([
      "ordinary-turn",
    ]);
    expect(followupQueueEntryContainsPrompt(TEST_KEY, "handoff-turn")).toBe(false);
    expect(followupQueueEntryContainsPrompt(TEST_KEY, "grant-turn")).toBe(false);
    expect(followupQueueEntryContainsPrompt(TEST_KEY, "ordinary-turn")).toBe(true);
  });

  it("fail-closes restored follow-ups whose trusted handoff or plugin grant is invalid", () => {
    const validRun = makeRun();
    replaceFollowupQueueEntries({
      entries: [
        [
          TEST_KEY,
          {
            items: [
              {
                prompt: "invalid-handoff",
                enqueuedAt: Date.now(),
                originatingChannel: "telegram",
                originatingTo: "12345",
                run: {
                  ...validRun,
                  trustedInternalHandoff: { kind: "unknown" },
                },
              },
              {
                prompt: "invalid-grant",
                enqueuedAt: Date.now(),
                originatingChannel: "telegram",
                originatingTo: "12345",
                run: {
                  ...validRun,
                  runtimePluginToolGrant: { pluginId: "workboard", toolNames: [""] },
                },
              },
              {
                prompt: "invalid-expectation",
                enqueuedAt: Date.now(),
                originatingChannel: "telegram",
                originatingTo: "12345",
                run: {
                  ...validRun,
                  terminalReplyExpectation: "maybe",
                },
              },
              {
                prompt: "invalid-provenance",
                enqueuedAt: Date.now(),
                originatingChannel: "telegram",
                originatingTo: "12345",
                run: {
                  ...validRun,
                  inputProvenance: { kind: "forged" },
                },
              },
              {
                prompt: "marked-delegated",
                enqueuedAt: Date.now(),
                originatingChannel: "telegram",
                originatingTo: "12345",
                delegatedAuthority: true,
                run: validRun,
              },
              {
                prompt: "ordinary-turn",
                enqueuedAt: Date.now(),
                originatingChannel: "telegram",
                originatingTo: "12345",
                run: validRun,
              },
            ],
            mode: "steer",
            lastEnqueuedAt: 1,
            droppedCount: 0,
            summaryLines: [],
          },
        ],
      ],
    });

    restoreFollowupQueues();
    expect(FOLLOWUP_QUEUES.get(TEST_KEY)?.items.map((item) => item.prompt)).toEqual([
      "ordinary-turn",
    ]);
    expect(followupQueueEntryContainsPrompt(TEST_KEY, "invalid-handoff")).toBe(false);
    expect(followupQueueEntryContainsPrompt(TEST_KEY, "invalid-grant")).toBe(false);
    expect(followupQueueEntryContainsPrompt(TEST_KEY, "invalid-expectation")).toBe(false);
    expect(followupQueueEntryContainsPrompt(TEST_KEY, "invalid-provenance")).toBe(false);
    expect(followupQueueEntryContainsPrompt(TEST_KEY, "marked-delegated")).toBe(false);
    expect(followupQueueEntryContainsPrompt(TEST_KEY, "ordinary-turn")).toBe(true);
  });

  it("strips invalid closed envelopes from restored lastRun instead of leaking them", () => {
    const validRun = makeRun();
    replaceFollowupQueueEntries({
      entries: [
        [
          TEST_KEY,
          {
            items: [
              {
                prompt: "ordinary-turn",
                enqueuedAt: Date.now(),
                originatingChannel: "telegram",
                originatingTo: "12345",
                run: validRun,
              },
            ],
            lastRun: {
              ...validRun,
              trustedInternalHandoff: { kind: "unknown" },
              runtimePluginToolGrant: { pluginId: "workboard", toolNames: [""] },
              terminalReplyExpectation: "maybe",
              inputProvenance: { kind: "forged", sourceSessionKey: "agent:foreign" },
            },
            mode: "steer",
            lastEnqueuedAt: 1,
            droppedCount: 0,
            summaryLines: [],
          },
        ],
      ],
    });

    restoreFollowupQueues();
    const restored = FOLLOWUP_QUEUES.get(TEST_KEY);
    expect(restored?.items.map((item) => item.prompt)).toEqual(["ordinary-turn"]);
    expect(restored?.lastRun?.trustedInternalHandoff).toBeUndefined();
    expect(restored?.lastRun?.runtimePluginToolGrant).toBeUndefined();
    expect(restored?.lastRun?.terminalReplyExpectation).toBeUndefined();
    expect(restored?.lastRun?.inputProvenance).toBeUndefined();
  });

  it("strips an incomplete session permission pair from restored lastRun instead of leaking it", () => {
    const validRun = makeRun();
    replaceFollowupQueueEntries({
      entries: [
        [
          TEST_KEY,
          {
            items: [
              {
                prompt: "ordinary-turn",
                enqueuedAt: Date.now(),
                originatingChannel: "telegram",
                originatingTo: "12345",
                run: validRun,
              },
            ],
            lastRun: {
              ...validRun,
              permissionMode: "workspace",
            },
            mode: "steer",
            lastEnqueuedAt: 1,
            droppedCount: 0,
            summaryLines: [],
          },
        ],
      ],
    });

    restoreFollowupQueues();
    const restored = FOLLOWUP_QUEUES.get(TEST_KEY);
    expect(restored?.items.map((item) => item.prompt)).toEqual(["ordinary-turn"]);
    expect(restored?.lastRun?.permissionMode).toBeUndefined();
    expect(restored?.lastRun?.sessionRoot).toBeUndefined();
  });

  it("strips raw source-session provenance from restored rows and rewrites SQLite", () => {
    const validRun = makeRun();
    replaceFollowupQueueEntries({
      entries: [
        [
          TEST_KEY,
          {
            items: [
              {
                prompt: "legacy-provenance",
                enqueuedAt: Date.now(),
                originatingChannel: "telegram",
                originatingTo: "12345",
                run: {
                  ...validRun,
                  inputProvenance: {
                    kind: "external_user",
                    sourceChannel: "telegram",
                    sourceSessionKey: "agent:main:dm:999",
                    originSessionId: "sess-foreign",
                  },
                },
              },
            ],
            lastRun: {
              ...validRun,
              inputProvenance: {
                kind: "inter_session",
                sourceTool: "sessions_send",
                sourceSessionKey: "agent:other:dm:1",
              },
            },
            mode: "steer",
            lastEnqueuedAt: 1,
            droppedCount: 0,
            summaryLines: [],
          },
        ],
      ],
    });

    restoreFollowupQueues();
    const restored = FOLLOWUP_QUEUES.get(TEST_KEY);
    expect(restored?.items[0]?.run.inputProvenance).toEqual({
      kind: "external_user",
      sourceChannel: "telegram",
    });
    expect(restored?.items[0]?.run.inputProvenance).not.toHaveProperty("sourceSessionKey");
    expect(restored?.items[0]?.run.inputProvenance).not.toHaveProperty("originSessionId");
    expect(restored?.lastRun?.inputProvenance).toEqual({
      kind: "inter_session",
      sourceTool: "sessions_send",
    });
    expect(restored?.lastRun?.inputProvenance).not.toHaveProperty("sourceSessionKey");

    const persisted = readPersistedQueueEntry(TEST_KEY) as {
      items: Array<{ run: { inputProvenance?: Record<string, unknown> } }>;
      lastRun?: { inputProvenance?: Record<string, unknown> };
    };
    expect(persisted.items[0]?.run.inputProvenance).toEqual({
      kind: "external_user",
      sourceChannel: "telegram",
    });
    expect(persisted.items[0]?.run.inputProvenance).not.toHaveProperty("sourceSessionKey");
    expect(persisted.items[0]?.run.inputProvenance).not.toHaveProperty("originSessionId");
    expect(persisted.lastRun?.inputProvenance).toEqual({
      kind: "inter_session",
      sourceTool: "sessions_send",
    });
    expect(persisted.lastRun?.inputProvenance).not.toHaveProperty("sourceSessionKey");
  });

  it("strips raw channel identities from restored rows and rewrites SQLite", () => {
    const validRun = makeRun();
    replaceFollowupQueueEntries({
      entries: [
        [
          TEST_KEY,
          {
            items: [
              {
                prompt: "legacy-identity",
                enqueuedAt: Date.now(),
                originatingChannel: "telegram",
                originatingTo: "12345",
                run: {
                  ...validRun,
                  senderId: "telegram-user-1",
                  senderName: "Ada",
                  senderUsername: "ada",
                  senderE164: "+15550000000",
                  channelContext: { chat: { id: "12345", extra: "open-ended-identity" } },
                },
              },
            ],
            lastRun: {
              ...validRun,
              senderId: "telegram-user-last",
              channelContext: { chat: { extra: "last-run-identity" } },
            },
            mode: "steer",
            lastEnqueuedAt: 1,
            droppedCount: 0,
            summaryLines: [],
          },
        ],
      ],
    });

    restoreFollowupQueues();
    const restored = FOLLOWUP_QUEUES.get(TEST_KEY);
    expect(restored?.items.map((item) => item.prompt)).toEqual(["legacy-identity"]);
    expect(restored?.items[0]?.run.senderId).toBeUndefined();
    expect(restored?.items[0]?.run.senderName).toBeUndefined();
    expect(restored?.items[0]?.run.senderUsername).toBeUndefined();
    expect(restored?.items[0]?.run.senderE164).toBeUndefined();
    expect(restored?.items[0]?.run.channelContext).toBeUndefined();
    expect(restored?.items[0]?.originatingChannel).toBe("telegram");
    expect(restored?.items[0]?.originatingTo).toBe("12345");
    expect(restored?.lastRun?.senderId).toBeUndefined();
    expect(restored?.lastRun?.channelContext).toBeUndefined();

    const persisted = readPersistedQueueEntry(TEST_KEY) as {
      items: Array<{ run: Record<string, unknown> }>;
      lastRun?: Record<string, unknown>;
    };
    expect(persisted.items[0]?.run).not.toHaveProperty("senderId");
    expect(persisted.items[0]?.run).not.toHaveProperty("senderName");
    expect(persisted.items[0]?.run).not.toHaveProperty("channelContext");
    expect(persisted.lastRun).not.toHaveProperty("senderId");
    expect(persisted.lastRun).not.toHaveProperty("channelContext");
    expect(JSON.stringify(persisted)).not.toContain("telegram-user-1");
    expect(JSON.stringify(persisted)).not.toContain("open-ended-identity");
    expect(JSON.stringify(persisted)).not.toContain("last-run-identity");
  });

  it("does not persist or restore handoff-derived source-session provenance", () => {
    const run = makeRun();
    run.inputProvenance = {
      kind: "inter_session",
      sourceTool: "subagent_announce",
      sourceSessionKey: "agent:should-not-persist",
      originSessionId: "sess-should-not-persist",
    };
    run.trustedInternalHandoff = {
      kind: "subagent-completion",
      sourceSessionKey: "agent:child",
      targetSessionKey: "agent:parent",
      targetSessionId: "session-1",
      provider: "openai",
      model: "gpt-route",
    };
    const queue = getFollowupQueue(TEST_KEY, SETTINGS);
    queue.items.push({
      ...makeFollowupRun("handoff-turn"),
      run,
    });
    persistFollowupQueues();

    const persisted = readPersistedQueueEntry(TEST_KEY) as {
      items: Array<{
        delegatedAuthority?: true;
        run: {
          inputProvenance?: Record<string, unknown>;
          trustedInternalHandoff?: Record<string, unknown>;
        };
      }>;
    };
    expect(persisted.items[0]?.delegatedAuthority).toBe(true);
    expect(persisted.items[0]?.run.inputProvenance).toEqual({
      kind: "inter_session",
      sourceTool: "subagent_announce",
    });
    expect(persisted.items[0]?.run.inputProvenance).not.toHaveProperty("sourceSessionKey");
    expect(persisted.items[0]?.run.inputProvenance).not.toHaveProperty("originSessionId");
    expect(persisted.items[0]?.run).not.toHaveProperty("trustedInternalHandoff");

    restorePersistedQueueForTest();
    expect(FOLLOWUP_QUEUES.get(TEST_KEY)?.items ?? []).toEqual([]);
    expect(followupQueueEntryContainsPrompt(TEST_KEY, "handoff-turn")).toBe(false);
  });

  it("strips currentInboundContext from restored rows and rewrites SQLite", () => {
    const validRun = makeRun();
    replaceFollowupQueueEntries({
      entries: [
        [
          TEST_KEY,
          {
            items: [
              {
                prompt: "legacy-inbound-context",
                enqueuedAt: Date.now(),
                currentInboundEventKind: "room_event",
                currentInboundContext: {
                  text: "participant-derived prompt body",
                  resumableText: "participant-derived prompt body",
                },
                originatingChannel: "telegram",
                originatingTo: "12345",
                run: validRun,
              },
            ],
            mode: "steer",
            lastEnqueuedAt: 1,
            droppedCount: 0,
            summaryLines: [],
          },
        ],
      ],
    });

    restoreFollowupQueues();
    const restored = FOLLOWUP_QUEUES.get(TEST_KEY)?.items[0];
    expect(restored?.prompt).toBe("legacy-inbound-context");
    expect(restored?.currentInboundEventKind).toBe("room_event");
    expect(restored?.currentInboundContext).toBeUndefined();

    const persisted = readPersistedQueueEntry(TEST_KEY) as {
      items: Array<{ currentInboundContext?: unknown }>;
    };
    expect(persisted.items[0]).not.toHaveProperty("currentInboundContext");
    expect(JSON.stringify(persisted)).not.toContain("participant-derived prompt body");
  });
});
