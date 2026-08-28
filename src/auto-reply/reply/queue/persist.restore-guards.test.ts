import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import {
  attachToolAllowlistIntersection,
  readToolAllowlistIntersection,
} from "../../../agents/tool-policy.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  followupQueueEntryContainsPrompt,
  replaceFollowupQueueEntries,
} from "../../../infra/followup-queue-sqlite.js";
import * as followupQueueSqlite from "../../../infra/followup-queue-sqlite.js";
import { defaultRuntime } from "../../../runtime.js";
import { resolveGlobalSet } from "../../../shared/global-singleton.js";
import {
  assertExpectedRevisionHash,
  SkillProposalRevisionChangedError,
} from "../../../skills/workshop/service-evaluation.js";
import { kickFollowupDrainIfIdle, rememberFollowupDrainCallback } from "./drain.js";
import { enqueueFollowupRun, parkSteerCandidate } from "./enqueue.js";
import {
  clearFollowupQueuesRestoredFlagForTest,
  clearRestoredPendingDrainKeysForTest,
  peekRestoredPendingDrainKeys,
  persistFollowupQueues,
  resolveRestoredFollowupQueueRecoveryKey,
  restoreFollowupQueues,
  setRestoredFollowupQueuesListener,
} from "./persist.js";
import {
  FOLLOWUP_PERSIST_TEST_KEY as TEST_KEY,
  FOLLOWUP_PERSIST_TEST_SETTINGS as SETTINGS,
  createFollowupPersistTestItem as makeFollowupRun,
  createFollowupPersistTestRun as makeRun,
  readFollowupPersistQueueEntry as readPersistedQueueEntry,
  writeFollowupPersistWorkspaceSkill as writeWorkspaceSkill,
} from "./persist.test-helpers.js";
import { tryScheduleRestoredFollowupQueueDrain } from "./restored-drain.js";
import { FOLLOWUP_QUEUES, clearFollowupQueue, getFollowupQueue } from "./state.js";
import type { FollowupRun, QueueSettings } from "./types.js";

describe("persistFollowupQueues restore guards", () => {
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

  it("round-trips toolsAllow, disableTools, and allowlist intersection across restore", () => {
    const intersection = [["exec"], ["exec", "message"]];
    const queue = getFollowupQueue(TEST_KEY, SETTINGS);
    queue.items.push({
      ...makeFollowupRun("restricted"),
      toolsAllow: attachToolAllowlistIntersection(["exec"], intersection),
      disableTools: true,
    });
    persistFollowupQueues();

    const persisted = readPersistedQueueEntry(TEST_KEY) as {
      items: Array<{
        toolsAllow?: string[];
        disableTools?: boolean;
        toolsAllowIntersection?: string[][];
      }>;
    };
    expect(persisted.items[0]?.toolsAllow).toEqual(["exec"]);
    expect(persisted.items[0]?.disableTools).toBe(true);
    expect(persisted.items[0]?.toolsAllowIntersection).toEqual(intersection);

    restorePersistedQueueForTest();

    const restored = FOLLOWUP_QUEUES.get(TEST_KEY)?.items[0];
    expect(restored?.toolsAllow).toEqual(["exec"]);
    expect(restored?.disableTools).toBe(true);
    expect(
      restored?.toolsAllow ? readToolAllowlistIntersection(restored.toolsAllow) : undefined,
    ).toEqual(intersection);
  });

  it("round-trips explicit skill selections across restore", () => {
    const workspaceDir = path.join(tmpDir, "workspace");
    const skillPath = writeWorkspaceSkill(workspaceDir, "calendar");
    setRuntimeConfigSnapshot({} as OpenClawConfig);
    const queue = getFollowupQueue(TEST_KEY, SETTINGS);
    queue.items.push({
      ...makeFollowupRun("skill-selected"),
      run: { ...makeRun(), workspaceDir },
      explicitSkillSelections: [
        { name: "calendar", path: skillPath, extra: "do-not-persist" } as {
          name: string;
          path: string;
          extra?: string;
        },
      ],
    });
    persistFollowupQueues();

    const persisted = readPersistedQueueEntry(TEST_KEY) as {
      items: Array<{ explicitSkillSelections?: Array<Record<string, unknown>> }>;
    };
    expect(persisted.items[0]?.explicitSkillSelections).toEqual([
      { name: "calendar", path: skillPath },
    ]);
    expect(persisted.items[0]?.explicitSkillSelections?.[0]).not.toHaveProperty("extra");

    restorePersistedQueueForTest();

    expect(FOLLOWUP_QUEUES.get(TEST_KEY)?.items[0]?.explicitSkillSelections).toEqual([
      { name: "calendar", path: skillPath },
    ]);
  });

  it("fail-closes follow-ups whose explicit skill selections cannot be revalidated", () => {
    const validRun = makeRun();
    replaceFollowupQueueEntries({
      entries: [
        [
          TEST_KEY,
          {
            items: [
              {
                prompt: "invalid-skill-selection",
                enqueuedAt: Date.now(),
                originatingChannel: "telegram",
                originatingTo: "12345",
                explicitSkillSelections: [{ name: "calendar" }],
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

    const errorSpy = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    try {
      restoreFollowupQueues();
      expect(FOLLOWUP_QUEUES.get(TEST_KEY)).toBeUndefined();
      expect(peekRestoredPendingDrainKeys().has(TEST_KEY)).toBe(false);
      expect(followupQueueEntryContainsPrompt(TEST_KEY, "invalid-skill-selection")).toBe(false);
      const logged = errorSpy.mock.calls
        .map((call) => (typeof call[0] === "string" ? call[0] : ""))
        .join("\n");
      expect(logged).toContain(TEST_KEY);
      expect(logged).not.toContain("invalid-skill-selection");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("never persists inline image payloads and fail-closes the marked follow-up on restore", () => {
    const queue = getFollowupQueue(TEST_KEY, SETTINGS);
    queue.items.push({
      ...makeFollowupRun("with-inline-image"),
      images: [{ type: "image", data: "RAW-IMAGE-PAYLOAD-NEVER-RETAIN", mimeType: "image/png" }],
      imageOrder: ["inline"],
    });
    queue.items.push(makeFollowupRun("text-only"));
    persistFollowupQueues();

    const persisted = readPersistedQueueEntry(TEST_KEY) as {
      items: Array<Record<string, unknown>>;
    };
    expect(persisted.items[0]).not.toHaveProperty("images");
    expect(persisted.items[0]).not.toHaveProperty("imageOrder");
    expect(persisted.items[0]?.inlineImagesElided).toBe(true);
    expect(JSON.stringify(persisted)).not.toContain("RAW-IMAGE-PAYLOAD-NEVER-RETAIN");

    const errorSpy = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    try {
      restorePersistedQueueForTest();
      expect(FOLLOWUP_QUEUES.get(TEST_KEY)?.items.map((item) => item.prompt)).toEqual([
        "text-only",
      ]);
      expect(followupQueueEntryContainsPrompt(TEST_KEY, "with-inline-image")).toBe(false);
      const logged = errorSpy.mock.calls
        .map((call) => (typeof call[0] === "string" ? call[0] : ""))
        .join("\n");
      expect(logged).toContain("inline image payloads are never retained");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("fail-closes legacy rows that still carry raw image payloads and scrubs them from SQLite", () => {
    replaceFollowupQueueEntries({
      entries: [
        [
          TEST_KEY,
          {
            items: [
              {
                prompt: "legacy-image-row",
                enqueuedAt: Date.now(),
                originatingChannel: "telegram",
                originatingTo: "12345",
                images: [{ type: "image", data: "LEGACY-IMAGE-PAYLOAD", mimeType: "image/png" }],
                run: makeRun(),
              },
              {
                prompt: "legacy-text-row",
                enqueuedAt: Date.now(),
                originatingChannel: "telegram",
                originatingTo: "12345",
                run: makeRun(),
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

    const errorSpy = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    try {
      restoreFollowupQueues();
      expect(FOLLOWUP_QUEUES.get(TEST_KEY)?.items.map((item) => item.prompt)).toEqual([
        "legacy-text-row",
      ]);
      expect(followupQueueEntryContainsPrompt(TEST_KEY, "legacy-image-row")).toBe(false);
      const persisted = readPersistedQueueEntry(TEST_KEY);
      expect(JSON.stringify(persisted ?? {})).not.toContain("LEGACY-IMAGE-PAYLOAD");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("fail-closes restored follow-ups older than the bounded retention window", () => {
    const queue = getFollowupQueue(TEST_KEY, SETTINGS);
    queue.items.push({
      ...makeFollowupRun("stale-followup"),
      // Comfortably older than FOLLOWUP_QUEUE_MAX_RESTORE_AGE_MS (48h).
      enqueuedAt: Date.now() - 30 * 24 * 60 * 60 * 1000,
    });
    queue.items.push(makeFollowupRun("fresh-followup"));
    persistFollowupQueues();

    const errorSpy = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    try {
      restorePersistedQueueForTest();
      expect(FOLLOWUP_QUEUES.get(TEST_KEY)?.items.map((item) => item.prompt)).toEqual([
        "fresh-followup",
      ]);
      expect(followupQueueEntryContainsPrompt(TEST_KEY, "stale-followup")).toBe(false);
      const logged = errorSpy.mock.calls
        .map((call) => (typeof call[0] === "string" ? call[0] : ""))
        .join("\n");
      expect(logged).toContain("bounded retention window");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("fail-closes follow-ups whose selected skill is gone after restart", () => {
    const workspaceDir = path.join(tmpDir, "workspace");
    const skillPath = writeWorkspaceSkill(workspaceDir, "calendar");
    setRuntimeConfigSnapshot({} as OpenClawConfig);
    const queue = getFollowupQueue(TEST_KEY, SETTINGS);
    queue.items.push({
      ...makeFollowupRun("moved-skill-selection"),
      run: { ...makeRun(), workspaceDir },
      explicitSkillSelections: [{ name: "calendar", path: skillPath }],
    });
    persistFollowupQueues();
    expect(followupQueueEntryContainsPrompt(TEST_KEY, "moved-skill-selection")).toBe(true);

    fs.rmSync(path.dirname(skillPath), { recursive: true, force: true });
    FOLLOWUP_QUEUES.delete(TEST_KEY);
    clearFollowupQueuesRestoredFlagForTest();

    const errorSpy = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    try {
      restoreFollowupQueues();
      expect(FOLLOWUP_QUEUES.get(TEST_KEY)).toBeUndefined();
      expect(peekRestoredPendingDrainKeys().has(TEST_KEY)).toBe(false);
      expect(followupQueueEntryContainsPrompt(TEST_KEY, "moved-skill-selection")).toBe(false);
      const logged = errorSpy.mock.calls
        .map((call) => (typeof call[0] === "string" ? call[0] : ""))
        .join("\n");
      expect(logged).toContain(TEST_KEY);
      expect(logged).not.toContain("moved-skill-selection");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("fail-closes follow-ups whose selected skill is disabled after restart", () => {
    const workspaceDir = path.join(tmpDir, "workspace");
    const skillPath = writeWorkspaceSkill(workspaceDir, "calendar");
    setRuntimeConfigSnapshot({} as OpenClawConfig);
    const queue = getFollowupQueue(TEST_KEY, SETTINGS);
    queue.items.push({
      ...makeFollowupRun("disabled-skill-selection"),
      run: { ...makeRun(), workspaceDir },
      explicitSkillSelections: [{ name: "calendar", path: skillPath }],
    });
    persistFollowupQueues();
    expect(followupQueueEntryContainsPrompt(TEST_KEY, "disabled-skill-selection")).toBe(true);

    FOLLOWUP_QUEUES.delete(TEST_KEY);
    clearFollowupQueuesRestoredFlagForTest();
    setRuntimeConfigSnapshot({
      skills: { entries: { calendar: { enabled: false } } },
    } as OpenClawConfig);

    const errorSpy = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    try {
      restoreFollowupQueues();
      expect(FOLLOWUP_QUEUES.get(TEST_KEY)).toBeUndefined();
      expect(peekRestoredPendingDrainKeys().has(TEST_KEY)).toBe(false);
      expect(followupQueueEntryContainsPrompt(TEST_KEY, "disabled-skill-selection")).toBe(false);
      const logged = errorSpy.mock.calls
        .map((call) => (typeof call[0] === "string" ? call[0] : ""))
        .join("\n");
      expect(logged).toContain(TEST_KEY);
      expect(logged).not.toContain("disabled-skill-selection");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("does not restore an accepted steer after consume settles to SQLite", () => {
    const followup = makeFollowupRun("accepted-steer");
    const parked = parkSteerCandidate(TEST_KEY, followup, SETTINGS, async () => undefined);
    expect(parked).toBeDefined();
    expect(FOLLOWUP_QUEUES.get(TEST_KEY)?.items).toHaveLength(1);
    expect(followupQueueEntryContainsPrompt(TEST_KEY, "accepted-steer")).toBe(true);

    parked!.consume();
    expect(
      FOLLOWUP_QUEUES.get(TEST_KEY)?.items.some((item) => item.prompt === "accepted-steer") ??
        false,
    ).toBe(false);
    expect(followupQueueEntryContainsPrompt(TEST_KEY, "accepted-steer")).toBe(false);

    restorePersistedQueueForTest();

    const restored = FOLLOWUP_QUEUES.get(TEST_KEY);
    expect(restored?.items.some((item) => item.prompt === "accepted-steer") ?? false).toBe(false);
    expect(followupQueueEntryContainsPrompt(TEST_KEY, "accepted-steer")).toBe(false);
  });

  it("persists the original queue cap after deferred steer overflow fallback", () => {
    const tight: QueueSettings = {
      mode: "steer",
      debounceMs: 500,
      cap: 2,
      dropPolicy: "summarize",
    };
    const parked = parkSteerCandidate(
      TEST_KEY,
      makeFollowupRun("steer-anchor"),
      tight,
      async () => undefined,
    );
    expect(parked).toBeDefined();
    expect(enqueueFollowupRun(TEST_KEY, makeFollowupRun("suffix-a"), tight, "none")).toBe(true);
    expect(enqueueFollowupRun(TEST_KEY, makeFollowupRun("suffix-b"), tight, "none")).toBe(true);

    parked!.fallback();

    expect(FOLLOWUP_QUEUES.get(TEST_KEY)?.cap).toBe(2);
    const persisted = readPersistedQueueEntry(TEST_KEY) as { cap?: number };
    expect(persisted.cap).toBe(2);

    restorePersistedQueueForTest();
    expect(FOLLOWUP_QUEUES.get(TEST_KEY)?.cap).toBe(2);
  });

  it("rolls back deferred overflow when SQLite persistence fails", () => {
    const tight: QueueSettings = {
      mode: "steer",
      debounceMs: 500,
      cap: 1,
      dropPolicy: "summarize",
    };
    const abandoned: string[] = [];
    const makeTracked = (prompt: string): FollowupRun => ({
      ...makeFollowupRun(prompt),
      turnAdoptionLifecycle: {
        onAdopted: async () => undefined,
        onAbandoned: () => {
          abandoned.push(prompt);
        },
        onSettled: () => undefined,
      },
    });
    const parked = parkSteerCandidate(
      TEST_KEY,
      makeTracked("steer-anchor"),
      tight,
      async () => undefined,
    );
    expect(parked).toBeDefined();
    expect(enqueueFollowupRun(TEST_KEY, makeTracked("suffix-a"), tight, "none")).toBe(true);
    expect(enqueueFollowupRun(TEST_KEY, makeTracked("suffix-b"), tight, "none")).toBe(true);
    expect(FOLLOWUP_QUEUES.get(TEST_KEY)?.items.map((item) => item.prompt)).toEqual([
      "steer-anchor",
      "suffix-a",
      "suffix-b",
    ]);

    const originalReplace = followupQueueSqlite.replaceFollowupQueueEntries;
    let injectedFailure = false;
    const replaceSpy = vi
      .spyOn(followupQueueSqlite, "replaceFollowupQueueEntries")
      .mockImplementation((params) => {
        const entry = params.entries.find(([entryKey]) => entryKey === TEST_KEY)?.[1] as
          | { items?: Array<{ prompt?: string }> }
          | undefined;
        const livePrompts = entry?.items?.map((item) => item.prompt) ?? [];
        if (!injectedFailure && !livePrompts.includes("suffix-a")) {
          injectedFailure = true;
          throw new Error("injected sqlite deferred-overflow failure");
        }
        originalReplace(params);
      });

    try {
      parked!.fallback();
      expect(injectedFailure).toBe(true);
      expect(FOLLOWUP_QUEUES.get(TEST_KEY)?.items.map((item) => item.prompt)).toEqual([
        "steer-anchor",
        "suffix-a",
        "suffix-b",
      ]);
      expect(abandoned).toEqual([]);
      expect(followupQueueEntryContainsPrompt(TEST_KEY, "suffix-a")).toBe(true);
      expect(followupQueueEntryContainsPrompt(TEST_KEY, "suffix-b")).toBe(true);

      FOLLOWUP_QUEUES.delete(TEST_KEY);
      clearFollowupQueuesRestoredFlagForTest();
      restoreFollowupQueues();
      expect(FOLLOWUP_QUEUES.get(TEST_KEY)?.items.map((item) => item.prompt)).toEqual([
        "steer-anchor",
        "suffix-a",
        "suffix-b",
      ]);
    } finally {
      replaceSpy.mockRestore();
    }
  });

  it("round-trips scheduledToolPolicy through persist+restore", () => {
    const run = makeRun();
    run.scheduledToolPolicy = { version: 1, mode: "trusted" };
    const queue = getFollowupQueue(TEST_KEY, SETTINGS);
    queue.items.push({
      ...makeFollowupRun("scheduled-turn"),
      toolsAllow: ["exec"],
      run,
    });
    persistFollowupQueues();

    const persisted = readPersistedQueueEntry(TEST_KEY) as {
      items: Array<{ run: { scheduledToolPolicy?: unknown } }>;
    };
    expect(persisted.items[0]?.run.scheduledToolPolicy).toEqual({ version: 1, mode: "trusted" });

    restorePersistedQueueForTest();

    const restored = FOLLOWUP_QUEUES.get(TEST_KEY)?.items[0];
    expect(restored?.prompt).toBe("scheduled-turn");
    expect(restored?.run.scheduledToolPolicy).toEqual({ version: 1, mode: "trusted" });
  });

  it("fail-closes restored follow-ups whose scheduledToolPolicy cannot be normalized", () => {
    const validRun = makeRun();
    replaceFollowupQueueEntries({
      entries: [
        [
          TEST_KEY,
          {
            items: [
              {
                prompt: "invalid-scheduled-policy",
                enqueuedAt: Date.now(),
                originatingChannel: "telegram",
                originatingTo: "12345",
                run: {
                  ...validRun,
                  scheduledToolPolicy: { version: 99, mode: "trusted" },
                },
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
    const restored = FOLLOWUP_QUEUES.get(TEST_KEY);
    expect(restored?.items.map((item) => item.prompt)).toEqual(["ordinary-turn"]);
    expect(restored?.items[0]?.run.scheduledToolPolicy).toBeUndefined();
    expect(followupQueueEntryContainsPrompt(TEST_KEY, "invalid-scheduled-policy")).toBe(false);
    expect(followupQueueEntryContainsPrompt(TEST_KEY, "ordinary-turn")).toBe(true);
  });

  it("round-trips session permission mode and root through persist+restore", () => {
    const run = makeRun();
    run.permissionMode = "workspace";
    run.sessionRoot = "/tmp/workspace/project";
    const queue = getFollowupQueue(TEST_KEY, SETTINGS);
    queue.items.push({
      ...makeFollowupRun("scoped-turn"),
      run,
    });
    queue.lastRun = run;
    persistFollowupQueues();

    const persisted = readPersistedQueueEntry(TEST_KEY) as {
      items: Array<{ run: { permissionMode?: unknown; sessionRoot?: unknown } }>;
      lastRun?: { permissionMode?: unknown; sessionRoot?: unknown };
    };
    expect(persisted.items[0]?.run.permissionMode).toBe("workspace");
    expect(persisted.items[0]?.run.sessionRoot).toBe("/tmp/workspace/project");
    expect(persisted.lastRun?.permissionMode).toBe("workspace");
    expect(persisted.lastRun?.sessionRoot).toBe("/tmp/workspace/project");

    restorePersistedQueueForTest();

    const restored = FOLLOWUP_QUEUES.get(TEST_KEY);
    expect(restored?.items[0]?.prompt).toBe("scoped-turn");
    expect(restored?.items[0]?.run.permissionMode).toBe("workspace");
    expect(restored?.items[0]?.run.sessionRoot).toBe("/tmp/workspace/project");
    expect(restored?.lastRun?.permissionMode).toBe("workspace");
    expect(restored?.lastRun?.sessionRoot).toBe("/tmp/workspace/project");
  });

  it("persists a root-only live session policy so restore fail-closes the half-pair", () => {
    const run = makeRun();
    run.sessionRoot = "/tmp/workspace/project";
    const queue = getFollowupQueue(TEST_KEY, SETTINGS);
    queue.items.push({
      ...makeFollowupRun("root-only-live"),
      run,
    });
    persistFollowupQueues();

    const persisted = readPersistedQueueEntry(TEST_KEY) as {
      items: Array<{ run: { permissionMode?: unknown; sessionRoot?: unknown } }>;
    };
    expect(persisted.items[0]?.run.permissionMode).toBeUndefined();
    expect(persisted.items[0]?.run.sessionRoot).toBe("/tmp/workspace/project");

    restorePersistedQueueForTest();

    expect(FOLLOWUP_QUEUES.get(TEST_KEY)?.items ?? []).toEqual([]);
    expect(followupQueueEntryContainsPrompt(TEST_KEY, "root-only-live")).toBe(false);
  });

  it("fail-closes restored follow-ups whose session permission pair is incomplete or invalid", () => {
    const validRun = makeRun();
    replaceFollowupQueueEntries({
      entries: [
        [
          TEST_KEY,
          {
            items: [
              {
                prompt: "mode-without-root",
                enqueuedAt: Date.now(),
                originatingChannel: "telegram",
                originatingTo: "12345",
                run: {
                  ...validRun,
                  permissionMode: "workspace",
                },
              },
              {
                prompt: "root-without-mode",
                enqueuedAt: Date.now(),
                originatingChannel: "telegram",
                originatingTo: "12345",
                run: {
                  ...validRun,
                  sessionRoot: "/tmp/workspace/project",
                },
              },
              {
                prompt: "invalid-mode",
                enqueuedAt: Date.now(),
                originatingChannel: "telegram",
                originatingTo: "12345",
                run: {
                  ...validRun,
                  // SAFETY: invalid persisted mode is intentionally outside the live union.
                  permissionMode: "bypass",
                  sessionRoot: "/tmp/workspace/project",
                } as unknown as typeof validRun,
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
    const restored = FOLLOWUP_QUEUES.get(TEST_KEY);
    expect(restored?.items.map((item) => item.prompt)).toEqual(["ordinary-turn"]);
    expect(restored?.items[0]?.run.permissionMode).toBeUndefined();
    expect(restored?.items[0]?.run.sessionRoot).toBeUndefined();
    expect(followupQueueEntryContainsPrompt(TEST_KEY, "mode-without-root")).toBe(false);
    expect(followupQueueEntryContainsPrompt(TEST_KEY, "root-without-mode")).toBe(false);
    expect(followupQueueEntryContainsPrompt(TEST_KEY, "invalid-mode")).toBe(false);
    expect(followupQueueEntryContainsPrompt(TEST_KEY, "ordinary-turn")).toBe(true);
  });

  it("round-trips Skill Workshop revision constraints through persist+restore", () => {
    const revision = {
      agentId: "main",
      workspaceDir: "/tmp/workspace",
      proposalId: "proposal-h1",
      expectedRevisionHash: "a".repeat(64),
    };
    const run = makeRun();
    run.skillWorkshopProposalRevision = revision;
    const queue = getFollowupQueue(TEST_KEY, SETTINGS);
    queue.items.push({
      ...makeFollowupRun("revise proposal"),
      run,
    });
    persistFollowupQueues();

    const persisted = readPersistedQueueEntry(TEST_KEY) as {
      items: Array<{ run: { skillWorkshopProposalRevision?: unknown } }>;
    };
    expect(persisted.items[0]?.run.skillWorkshopProposalRevision).toEqual(revision);

    restorePersistedQueueForTest();

    const restored = FOLLOWUP_QUEUES.get(TEST_KEY)?.items[0];
    expect(restored?.prompt).toBe("revise proposal");
    expect(restored?.run.skillWorkshopProposalRevision).toEqual(revision);
  });

  it("fail-closes restored follow-ups whose Skill Workshop revision constraint is invalid", () => {
    const validRun = makeRun();
    replaceFollowupQueueEntries({
      entries: [
        [
          TEST_KEY,
          {
            items: [
              {
                prompt: "invalid-workshop-revision",
                enqueuedAt: Date.now(),
                originatingChannel: "telegram",
                originatingTo: "12345",
                run: {
                  ...validRun,
                  skillWorkshopProposalRevision: {
                    agentId: "main",
                    workspaceDir: "/tmp/workspace",
                    proposalId: "proposal-h1",
                    expectedRevisionHash: "not-a-revision-hash",
                  },
                },
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
    const restored = FOLLOWUP_QUEUES.get(TEST_KEY);
    expect(restored?.items.map((item) => item.prompt)).toEqual(["ordinary-turn"]);
    expect(restored?.items[0]?.run.skillWorkshopProposalRevision).toBeUndefined();
    expect(followupQueueEntryContainsPrompt(TEST_KEY, "invalid-workshop-revision")).toBe(false);
    expect(followupQueueEntryContainsPrompt(TEST_KEY, "ordinary-turn")).toBe(true);
  });

  it("restores Skill Workshop revision turns as individually drained and rejects a stale hash", async () => {
    const revision = {
      agentId: "main",
      workspaceDir: "/tmp/workspace",
      proposalId: "proposal-h1",
      expectedRevisionHash: "a".repeat(64),
    };
    const drainSettings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 20 };
    const ordinary = makeFollowupRun("ordinary");
    const workshop = { ...makeFollowupRun("revise proposal"), run: { ...makeRun() } };
    workshop.run.skillWorkshopProposalRevision = revision;

    expect(enqueueFollowupRun(TEST_KEY, ordinary, drainSettings, "none", undefined, false)).toBe(
      true,
    );
    expect(enqueueFollowupRun(TEST_KEY, workshop, drainSettings, "none", undefined, false)).toBe(
      true,
    );

    restorePersistedQueueForTest();

    const restoredWorkshop = FOLLOWUP_QUEUES.get(TEST_KEY)?.items.find(
      (item) => item.prompt === "revise proposal",
    );
    expect(restoredWorkshop?.run.skillWorkshopProposalRevision).toEqual(revision);

    const prompts: string[] = [];
    rememberFollowupDrainCallback(TEST_KEY, async (item) => {
      prompts.push(item.prompt);
    });
    kickFollowupDrainIfIdle(TEST_KEY);
    await vi.waitFor(() => {
      expect(prompts).toEqual(["ordinary", "revise proposal"]);
    });

    expect(() =>
      assertExpectedRevisionHash(
        "b".repeat(64),
        restoredWorkshop?.run.skillWorkshopProposalRevision?.expectedRevisionHash,
      ),
    ).toThrow(SkillProposalRevisionChangedError);
  });

  it("shares restored pending drain keys with later bundled runtime copies", () => {
    const queue = getFollowupQueue(TEST_KEY, SETTINGS);
    queue.items.push(makeFollowupRun("split-runtime"));
    persistFollowupQueues();
    restorePersistedQueueForTest();
    expect(peekRestoredPendingDrainKeys().has(TEST_KEY)).toBe(true);

    restoreFollowupQueues();
    expect(peekRestoredPendingDrainKeys().has(TEST_KEY)).toBe(true);
    expect(resolveRestoredFollowupQueueRecoveryKey([TEST_KEY])).toBe(TEST_KEY);

    const otherCopy = resolveGlobalSet<string>(
      Symbol.for("openclaw.followupQueueRestoredPendingDrainKeys"),
      "close-and-restart",
    );
    expect(otherCopy.has(TEST_KEY)).toBe(true);
    expect([...otherCopy]).toEqual([...peekRestoredPendingDrainKeys()]);
  });

  it("drops overflow elision groups whose sources fail restore validation", () => {
    const validRun = {
      agentId: "main",
      sessionId: "sess-persist",
      sessionKey: TEST_KEY,
      sessionFile: "/tmp/sess.jsonl",
      workspaceDir: "/tmp/ws",
      provider: "anthropic",
      model: "claude",
      timeoutMs: 30000,
      blockReplyBreak: "message_end",
    };
    replaceFollowupQueueEntries({
      entries: [
        [
          TEST_KEY,
          {
            items: [
              {
                prompt: "live-item",
                enqueuedAt: Date.now(),
                originatingChannel: "telegram",
                originatingTo: "12345",
                run: validRun,
              },
            ],
            mode: "steer",
            droppedCount: 1,
            summaryLines: [],
            summaryElisions: [
              {
                contextKey: "route-a",
                count: 1,
                sources: [
                  {
                    prompt: "cross-queue-elision",
                    enqueuedAt: Date.now(),
                    originatingChannel: "telegram",
                    originatingTo: "12345",
                    run: { ...validRun, sessionKey: "agent:other:dm:elsewhere" },
                  },
                ],
                summaryLines: ["cross-queue-elision"],
              },
            ],
            lastEnqueuedAt: 1,
          },
        ],
      ],
    });
    restoreFollowupQueues();
    const restored = FOLLOWUP_QUEUES.get(TEST_KEY);
    expect(restored?.items.map((item) => item.prompt)).toEqual(["live-item"]);
    expect(restored?.summaryElisions).toEqual([]);
  });

  it("maps isolated heartbeat session keys back to restored queue keys", () => {
    const queue = getFollowupQueue(TEST_KEY, SETTINGS);
    queue.items.push(makeFollowupRun("restore-me"));
    persistFollowupQueues();
    FOLLOWUP_QUEUES.delete(TEST_KEY);
    clearRestoredPendingDrainKeysForTest();
    clearFollowupQueuesRestoredFlagForTest();
    restoreFollowupQueues();

    expect(resolveRestoredFollowupQueueRecoveryKey([TEST_KEY])).toBe(TEST_KEY);
    expect(resolveRestoredFollowupQueueRecoveryKey([`${TEST_KEY}:heartbeat`])).toBe(TEST_KEY);
    expect(resolveRestoredFollowupQueueRecoveryKey([`${TEST_KEY}:heartbeat:heartbeat`])).toBe(
      TEST_KEY,
    );
    expect(resolveRestoredFollowupQueueRecoveryKey(["agent:other:route"])).toBeUndefined();

    const scheduleNow = vi.fn();
    const scheduleAfterClear = vi.fn();
    const createRunFollowup = vi.fn(() => vi.fn(async () => {}));
    const scheduledKey = tryScheduleRestoredFollowupQueueDrain({
      candidates: [`${TEST_KEY}:heartbeat`],
      createRunFollowup,
      getActiveReplyOperation: () => undefined,
      scheduleAfterClear,
      scheduleNow,
    });
    expect(scheduledKey).toBe(TEST_KEY);
    expect(createRunFollowup).toHaveBeenCalledWith(TEST_KEY);
    expect(scheduleNow).toHaveBeenCalledWith(TEST_KEY, expect.any(Function));
    expect(scheduleAfterClear).not.toHaveBeenCalled();
    expect(peekRestoredPendingDrainKeys().has(TEST_KEY)).toBe(false);
  });

  it("defers restored drain until the active reply owner clears", () => {
    const queue = getFollowupQueue(TEST_KEY, SETTINGS);
    queue.items.push(makeFollowupRun("owned"));
    persistFollowupQueues();
    FOLLOWUP_QUEUES.delete(TEST_KEY);
    clearRestoredPendingDrainKeysForTest();
    clearFollowupQueuesRestoredFlagForTest();
    restoreFollowupQueues();

    const scheduleNow = vi.fn();
    const scheduleAfterClear = vi.fn();
    const operation = { sessionId: "sess-active" };
    expect(
      tryScheduleRestoredFollowupQueueDrain({
        candidates: [TEST_KEY],
        createRunFollowup: () => vi.fn(async () => {}),
        getActiveReplyOperation: () => operation,
        scheduleAfterClear,
        scheduleNow,
      }),
    ).toBe(TEST_KEY);
    expect(scheduleAfterClear).toHaveBeenCalledWith({
      operation,
      queueKey: TEST_KEY,
      runFollowup: expect.any(Function),
    });
    expect(scheduleNow).not.toHaveBeenCalled();
  });

  it("reconnects restored items and overflow sources to queue cancellation", () => {
    const queue = getFollowupQueue(TEST_KEY, SETTINGS);
    const item = makeFollowupRun("clear-after-restart");
    const summarySource = makeFollowupRun("summary-source");
    const elisionSource = makeFollowupRun("elision-source");
    queue.items.push(item);
    queue.summarySources.push(summarySource);
    queue.droppedCount = 1;
    queue.summaryLines = ["summarized"];
    queue.summaryElisions = [
      {
        contextKey: "main",
        count: 1,
        sources: [elisionSource],
        summaryLines: ["elided"],
        sourceRefs: new WeakMap(),
      },
    ];
    persistFollowupQueues();

    restorePersistedQueueForTest();

    const restored = FOLLOWUP_QUEUES.get(TEST_KEY);
    expect(restored).toBeDefined();
    const restoredItem = restored!.items[0];
    const restoredSummary = restored!.summarySources[0];
    const restoredElision = restored!.summaryElisions[0]?.sources[0];
    expect(restoredItem?.queueAbortSignal).toBe(restored!.abortController.signal);
    expect(restoredSummary?.queueAbortSignal).toBe(restored!.abortController.signal);
    expect(restoredElision?.queueAbortSignal).toBe(restored!.abortController.signal);
    expect(restoredItem?.queueAbortSignal?.aborted).toBe(false);

    clearFollowupQueue(TEST_KEY);
    expect(restoredItem?.queueAbortSignal?.aborted).toBe(true);
    expect(restoredSummary?.queueAbortSignal?.aborted).toBe(true);
    expect(restoredElision?.queueAbortSignal?.aborted).toBe(true);
  });

  it("rehydrates run.config from the live runtime snapshot on restore", () => {
    const liveConfig = {
      defaults: { agent: { provider: "anthropic-live", model: "claude-live" } },
    } as unknown as OpenClawConfig;
    setRuntimeConfigSnapshot(liveConfig);

    const queue = getFollowupQueue(TEST_KEY, SETTINGS);
    queue.items.push(makeFollowupRun("rehydrate"));
    queue.lastRun = makeRun();
    persistFollowupQueues();
    FOLLOWUP_QUEUES.delete(TEST_KEY);

    restoreFollowupQueues();
    const restored = FOLLOWUP_QUEUES.get(TEST_KEY);
    expect(restored).toBeDefined();
    const rerun = restored!.items[0]!.run;
    expect(rerun.config).toBe(liveConfig);
    expect(restored!.lastRun?.config).toBe(liveConfig);
    expect(rerun.skillsSnapshot).toBeUndefined();
    expect(rerun.extraSystemPrompt).toBeUndefined();
    expect(rerun.inputProvenance).toBeUndefined();
    expect(rerun.agentId).toBe("main");
    expect(rerun.sessionId).toBe("sess-persist");
    expect(rerun.workspaceDir).toBe("/tmp/ws");
    expect(rerun.provider).toBe("anthropic");
    expect(rerun.model).toBe("claude");
    expect(rerun.timeoutMs).toBe(30000);
    expect(rerun.blockReplyBreak).toBe("message_end");
  });

  it("picks up a refreshed snapshot across separate restore passes", () => {
    const oldConfig = { defaults: { agent: { model: "claude-old" } } } as unknown as OpenClawConfig;
    setRuntimeConfigSnapshot(oldConfig);
    const queue = getFollowupQueue(TEST_KEY, SETTINGS);
    queue.items.push(makeFollowupRun("first"));
    persistFollowupQueues();
    FOLLOWUP_QUEUES.delete(TEST_KEY);
    restoreFollowupQueues();
    expect(FOLLOWUP_QUEUES.get(TEST_KEY)!.items[0]?.run.config).toBe(oldConfig);

    FOLLOWUP_QUEUES.delete(TEST_KEY);
    const newConfig = {
      defaults: { agent: { model: "claude-new" } },
    } as unknown as OpenClawConfig;
    setRuntimeConfigSnapshot(newConfig);
    clearFollowupQueuesRestoredFlagForTest();
    restoreFollowupQueues();
    expect(FOLLOWUP_QUEUES.get(TEST_KEY)!.items[0]?.run.config).toBe(newConfig);
  });

  it("skips entries with missing or invalid items array", () => {
    replaceFollowupQueueEntries({
      entries: [
        ["agent:bad", { items: "not-an-array" }],
        [
          TEST_KEY,
          { items: [{ prompt: "ok", enqueuedAt: Date.now(), run: makeRun() }], mode: "steer" },
        ],
      ],
    });
    restoreFollowupQueues();
    expect(FOLLOWUP_QUEUES.get(TEST_KEY)?.items[0]?.prompt).toBe("ok");
    expect(FOLLOWUP_QUEUES.get("agent:bad")).toBeUndefined();
  });

  it("skips restored items with mismatched sessionKey or incomplete originating routes", () => {
    const mismatched = makeFollowupRun("mismatched-session");
    mismatched.run.sessionKey = "agent:other:dm:elsewhere";
    const incompleteRoute = makeFollowupRun("incomplete-route");
    incompleteRoute.originatingTo = undefined;
    const valid = makeFollowupRun("valid");

    replaceFollowupQueueEntries({
      entries: [
        [
          TEST_KEY,
          {
            items: [mismatched, incompleteRoute, valid],
            mode: "steer",
            debounceMs: 500,
            cap: 20,
            dropPolicy: "summarize",
          },
        ],
      ],
    });
    restoreFollowupQueues();

    const restored = FOLLOWUP_QUEUES.get(TEST_KEY);
    expect(restored?.items.map((item) => item.prompt)).toEqual(["valid"]);
    expect(restored?.items[0]?.originatingChannel).toBe("telegram");
    expect(restored?.items[0]?.originatingTo).toBe("12345");
  });
});
