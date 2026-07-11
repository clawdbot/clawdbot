import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE } from "../../sessions/agent-harness-session-key.js";
import {
  applySessionEntryLifecycleMutation,
  clearSessionStoreCacheForTest,
  cleanupSessionLifecycleArtifacts,
  deleteSessionEntryLifecycle,
  loadSessionStore,
  rollbackAgentHarnessSessionEntryLifecycle,
  saveSessionStore,
  updateSessionStore,
} from "./store.js";
import type { SessionEntry } from "./types.js";

describe("agent harness session store invariant", () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-agent-harness-store-"));
    storePath = path.join(tempDir, "sessions.json");
  });

  afterEach(() => {
    clearSessionStoreCacheForTest();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it.each([
    { modelSelectionLocked: true, sessionId: "native-session", updatedAt: 1 },
    {
      modelSelectionLocked: true,
      agentHarnessId: "other",
      sessionId: "native-session",
      updatedAt: 1,
    },
    {
      modelSelectionLocked: true,
      agentHarnessId: "",
      sessionId: "native-session",
      updatedAt: 1,
    },
  ] satisfies SessionEntry[])(
    "rejects an invalid reserved row through public save",
    async (entry) => {
      const sessionKey = "agent:main:harness:codex:supervision:native-thread";

      await expect(
        saveSessionStore(storePath, { [sessionKey]: entry }, { skipMaintenance: true }),
      ).rejects.toThrow(AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE);

      expect(fs.existsSync(storePath)).toBe(false);
    },
  );

  it("loads and updates a pre-existing unlocked harness-prefixed session", async () => {
    const sessionKey = "agent:main:harness:notes";
    const entry: SessionEntry = {
      agentHarnessId: "openclaw",
      sessionId: "legacy-session",
      updatedAt: 1,
    };
    fs.writeFileSync(storePath, JSON.stringify({ [sessionKey]: entry }), "utf-8");

    expect(loadSessionStore(storePath, { skipCache: true })).toEqual({ [sessionKey]: entry });
    await updateSessionStore(
      storePath,
      (store) => {
        store[sessionKey] = { ...store[sessionKey], label: "Legacy notes" };
      },
      { skipMaintenance: true },
    );

    expect(loadSessionStore(storePath, { skipCache: true })[sessionKey]).toEqual({
      ...entry,
      label: "Legacy notes",
    });
  });

  it("allows an ordinary legacy model lock to adopt a transcript id", async () => {
    const sessionKey = "agent:main:legacy-model-lock";
    const entry = {
      modelSelectionLocked: true,
      updatedAt: 1,
    } as SessionEntry;
    await saveSessionStore(storePath, { [sessionKey]: entry }, { skipMaintenance: true });

    await updateSessionStore(
      storePath,
      (store) => {
        store[sessionKey] = { ...store[sessionKey], sessionId: "generated-session" };
      },
      { skipMaintenance: true },
    );

    expect(loadSessionStore(storePath, { skipCache: true })[sessionKey]).toEqual({
      ...entry,
      sessionId: "generated-session",
    });
  });

  it("rejects an invalid reserved lifecycle upsert before persistence", async () => {
    await saveSessionStore(
      storePath,
      { "agent:main:ordinary": { sessionId: "ordinary-session", updatedAt: 1 } },
      { skipMaintenance: true },
    );

    await expect(
      applySessionEntryLifecycleMutation({
        storePath,
        upserts: [
          {
            sessionKey: "agent:main:harness:codex:supervision:native-thread",
            entry: {
              agentHarnessId: "other",
              modelSelectionLocked: true,
              sessionId: "native-session",
              updatedAt: 1,
            },
          },
        ],
        skipMaintenance: true,
      }),
    ).rejects.toThrow(AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE);

    expect(loadSessionStore(storePath, { skipCache: true })).toEqual({
      "agent:main:ordinary": { sessionId: "ordinary-session", updatedAt: 1 },
    });
  });

  it("rejects a prefix-colliding harness owner through public save", async () => {
    const sessionKey = "agent:main:harness:foo:bar:native-thread";

    await expect(
      saveSessionStore(
        storePath,
        {
          [sessionKey]: {
            agentHarnessId: "foo:bar",
            modelSelectionLocked: true,
            sessionId: "native-session",
            updatedAt: 1,
          },
        },
        { skipMaintenance: true },
      ),
    ).rejects.toThrow(AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE);

    expect(fs.existsSync(storePath)).toBe(false);
  });

  it("persists a locked reserved lifecycle upsert owned by its matching harness", async () => {
    const sessionKey = "agent:main:harness:codex:supervision:native-thread";

    await expect(
      applySessionEntryLifecycleMutation({
        storePath,
        upserts: [
          {
            sessionKey,
            entry: {
              agentHarnessId: "codex",
              modelSelectionLocked: true,
              sessionId: "native-session",
              updatedAt: 1,
            },
          },
        ],
        skipMaintenance: true,
      }),
    ).resolves.toMatchObject({ afterCount: 1 });

    expect(loadSessionStore(storePath, { skipCache: true })[sessionKey]).toMatchObject({
      agentHarnessId: "codex",
      modelSelectionLocked: true,
      sessionId: "native-session",
    });
  });

  it("rejects removing or reassigning any durable model-selection lock", async () => {
    const sessionKey = "agent:main:ordinary-locked";
    const entry: SessionEntry = {
      agentHarnessId: "codex",
      modelSelectionLocked: true,
      sessionId: "locked-session",
      updatedAt: 1,
    };
    await saveSessionStore(storePath, { [sessionKey]: entry }, { skipMaintenance: true });

    await expect(
      updateSessionStore(
        storePath,
        (store) => {
          delete store[sessionKey];
        },
        { skipMaintenance: true },
      ),
    ).rejects.toThrow("Model-selection-locked sessions cannot be removed");
    await expect(
      updateSessionStore(
        storePath,
        (store) => {
          store[sessionKey] = { ...store[sessionKey], agentHarnessId: "other" };
        },
        { skipMaintenance: true },
      ),
    ).rejects.toThrow("Model-selection-locked sessions cannot be removed");
    await expect(
      updateSessionStore(
        storePath,
        (store) => {
          store[sessionKey] = { ...store[sessionKey], agentHarnessId: "codex-app-server" };
        },
        { skipMaintenance: true },
      ),
    ).rejects.toThrow("Agent harness-owned session identity is locked");
    await expect(
      updateSessionStore(
        storePath,
        (store) => {
          store[sessionKey] = { ...store[sessionKey], sessionId: "replacement-session" };
        },
        { skipMaintenance: true },
      ),
    ).rejects.toThrow("Agent harness-owned session identity is locked");

    expect(loadSessionStore(storePath, { skipCache: true })[sessionKey]).toEqual(entry);
  });

  it("keeps a reserved harness session id immutable and exclusive", async () => {
    const sessionKey = "agent:main:harness:codex:supervision:native-thread";
    const entry: SessionEntry = {
      agentHarnessId: "codex",
      modelSelectionLocked: true,
      sessionId: "native-session",
      updatedAt: 1,
    };
    await saveSessionStore(storePath, { [sessionKey]: entry }, { skipMaintenance: true });

    await expect(
      updateSessionStore(
        storePath,
        (store) => {
          store[sessionKey] = { ...store[sessionKey], sessionId: "replacement-session" };
        },
        { skipMaintenance: true },
      ),
    ).rejects.toThrow("Agent harness-owned session identity is locked");
    await expect(
      updateSessionStore(
        storePath,
        (store) => {
          store["agent:main:ordinary-alias"] = {
            sessionId: "native-session",
            updatedAt: 2,
          };
        },
        { skipMaintenance: true },
      ),
    ).rejects.toThrow("Agent harness-owned session identity is locked");

    expect(loadSessionStore(storePath, { skipCache: true })).toEqual({ [sessionKey]: entry });
  });

  it("keeps an ordinary-key harness lock exclusive by session id", async () => {
    const sessionKey = "agent:main:ordinary-locked";
    const entry: SessionEntry = {
      agentHarnessId: "codex",
      modelSelectionLocked: true,
      sessionId: "native-session",
      updatedAt: 1,
    };
    await saveSessionStore(storePath, { [sessionKey]: entry }, { skipMaintenance: true });

    await expect(
      updateSessionStore(
        storePath,
        (store) => {
          store["agent:main:ordinary-alias"] = {
            sessionId: "native-session",
            updatedAt: 2,
          };
        },
        { skipMaintenance: true },
      ),
    ).rejects.toThrow("Agent harness-owned session identity is locked");

    expect(loadSessionStore(storePath, { skipCache: true })).toEqual({ [sessionKey]: entry });
  });

  it("rejects duplicate ids across newly-created reserved rows", async () => {
    const entry: SessionEntry = {
      agentHarnessId: "codex",
      modelSelectionLocked: true,
      sessionId: "native-session",
      updatedAt: 1,
    };

    await expect(
      saveSessionStore(
        storePath,
        {
          "agent:main:harness:codex:supervision:first": entry,
          "agent:main:harness:codex:supervision:second": entry,
        },
        { skipMaintenance: true },
      ),
    ).rejects.toThrow("Agent harness-owned session identity is locked");
  });

  it("requires every reserved row to own a durable session id", async () => {
    await expect(
      saveSessionStore(
        storePath,
        {
          "agent:main:harness:codex:supervision:native-thread": {
            agentHarnessId: "codex",
            modelSelectionLocked: true,
            updatedAt: 1,
          } as SessionEntry,
        },
        { skipMaintenance: true },
      ),
    ).rejects.toThrow("Agent harness-owned session identity is locked");
  });

  it("fails closed instead of normalizing a malformed reserved row away", async () => {
    const sessionKey = "agent:main:harness:codex:supervision:native-thread";
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        [sessionKey]: {
          agentHarnessId: "codex",
          modelSelectionLocked: true,
          sessionId: "../unsafe-session",
        },
      }),
      "utf-8",
    );

    expect(() => loadSessionStore(storePath, { skipCache: true })).toThrow(
      `Invalid model-selection-locked session entry: ${sessionKey}`,
    );
    await expect(
      updateSessionStore(
        storePath,
        (store) => {
          store["agent:main:ordinary"] = { sessionId: "ordinary", updatedAt: 1 };
        },
        { skipMaintenance: true },
      ),
    ).rejects.toThrow(`Invalid model-selection-locked session entry: ${sessionKey}`);
    expect(JSON.parse(fs.readFileSync(storePath, "utf-8"))).toHaveProperty(sessionKey);
  });

  it.each([
    {
      name: "trimmed identity",
      entry: {
        agentHarnessId: "codex",
        modelSelectionLocked: true,
        sessionId: " native-session ",
        updatedAt: 1,
      },
    },
    {
      name: "trimmed runtime pair",
      entry: {
        agentHarnessId: "codex",
        modelSelectionLocked: true,
        sessionId: "native-session",
        updatedAt: 1,
        modelProvider: " openai ",
        model: " gpt-5.4 ",
      },
    },
    {
      name: "orphan runtime provider",
      entry: {
        agentHarnessId: "codex",
        modelSelectionLocked: true,
        sessionId: "native-session",
        updatedAt: 1,
        modelProvider: "openai",
      },
    },
  ])("fails closed instead of normalizing a locked $name on cold load", ({ entry }) => {
    const sessionKey = "agent:main:harness:codex:supervision:native-thread";
    const serialized = JSON.stringify({ [sessionKey]: entry });
    fs.writeFileSync(storePath, serialized, "utf-8");

    expect(() => loadSessionStore(storePath, { skipCache: true })).toThrow(
      `Invalid model-selection-locked session entry: ${sessionKey}`,
    );
    expect(fs.readFileSync(storePath, "utf-8")).toBe(serialized);
  });

  it("keeps canonical locked identity and runtime fields stable on cold load", () => {
    const sessionKey = "agent:main:harness:codex:supervision:native-thread";
    const entry: SessionEntry = {
      agentHarnessId: "codex",
      modelSelectionLocked: true,
      sessionId: "native-session",
      updatedAt: 1,
      modelProvider: "openai",
      model: "gpt-5.4",
    };
    const serialized = JSON.stringify({ [sessionKey]: entry });
    fs.writeFileSync(storePath, serialized, "utf-8");

    expect(loadSessionStore(storePath, { skipCache: true })).toEqual({ [sessionKey]: entry });
    expect(fs.readFileSync(storePath, "utf-8")).toBe(serialized);
  });

  it("retains unlocked harness-prefix compatibility normalization on cold load", () => {
    const sessionKey = "agent:main:harness:notes";
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        [sessionKey]: {
          agentHarnessId: "openclaw",
          sessionId: " legacy-session ",
          updatedAt: 1,
          modelProvider: " openai ",
          model: " gpt-5.4 ",
        },
      }),
      "utf-8",
    );

    expect(loadSessionStore(storePath, { skipCache: true })[sessionKey]).toEqual({
      agentHarnessId: "openclaw",
      sessionId: "legacy-session",
      updatedAt: 1,
      modelProvider: "openai",
      model: "gpt-5.4",
    });
  });

  it("fails closed on a cold-load alias of a reserved transcript identity", () => {
    const sessionKey = "agent:main:harness:codex:supervision:native-thread";
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        [sessionKey]: {
          agentHarnessId: "codex",
          modelSelectionLocked: true,
          sessionId: "native-session",
        },
        "agent:main:ordinary-alias": {
          sessionId: "native-session",
        },
      }),
      "utf-8",
    );

    expect(() => loadSessionStore(storePath, { skipCache: true })).toThrow(
      "Agent harness-owned session identity is locked",
    );
  });

  it("cannot poison the cache by mutating a locked row in a skipped write", async () => {
    const sessionKey = "agent:main:harness:codex:supervision:native-thread";
    const entry: SessionEntry = {
      agentHarnessId: "codex",
      modelSelectionLocked: true,
      sessionId: "native-session",
      updatedAt: 1,
    };
    await saveSessionStore(storePath, { [sessionKey]: entry }, { skipMaintenance: true });

    await expect(
      updateSessionStore(
        storePath,
        (store) => {
          delete store[sessionKey];
          return 0;
        },
        { skipMaintenance: true, skipSaveWhenResult: (result) => result === 0 },
      ),
    ).rejects.toThrow("Model-selection-locked sessions cannot be removed");
    await updateSessionStore(
      storePath,
      (store) => {
        store["agent:main:ordinary"] = { sessionId: "ordinary-session", updatedAt: 2 };
      },
      { skipMaintenance: true },
    );

    expect(loadSessionStore(storePath, { skipCache: true })).toEqual({
      [sessionKey]: entry,
      "agent:main:ordinary": { sessionId: "ordinary-session", updatedAt: 2 },
    });
  });

  it("rejects locked lifecycle cleanup before transcript side effects", async () => {
    const sessionKey = "agent:main:harness:codex:supervision:native-thread";
    const transcriptPath = path.join(tempDir, "native-session.jsonl");
    const entry: SessionEntry = {
      agentHarnessId: "codex",
      modelSelectionLocked: true,
      sessionFile: transcriptPath,
      sessionId: "native-session",
      updatedAt: 1,
    };
    await saveSessionStore(storePath, { [sessionKey]: entry }, { skipMaintenance: true });
    fs.writeFileSync(transcriptPath, '{"runId":"codex-supervision-marker"}\n', "utf-8");
    fs.utimesSync(transcriptPath, new Date(1), new Date(1));

    await expect(
      cleanupSessionLifecycleArtifacts({
        storePath,
        sessionKeySegmentPrefix: "harness:codex:supervision:",
        transcriptContentMarker: "codex-supervision-marker",
        orphanTranscriptMinAgeMs: 1,
        nowMs: Date.now(),
      }),
    ).rejects.toThrow("Model-selection-locked sessions cannot be removed");

    expect(fs.existsSync(transcriptPath)).toBe(true);
    expect(fs.readdirSync(tempDir).some((name) => name.includes(".jsonl.deleted."))).toBe(false);
    await updateSessionStore(
      storePath,
      (store) => {
        store["agent:main:ordinary"] = { sessionId: "ordinary-session", updatedAt: 2 };
      },
      { skipMaintenance: true },
    );
    expect(loadSessionStore(storePath, { skipCache: true })[sessionKey]).toEqual(entry);
  });

  it("allows only the dedicated exact harness-initialization rollback", async () => {
    const sessionKey = "agent:main:harness:codex:supervision:native-thread";
    const entry: SessionEntry = {
      agentHarnessId: "codex",
      modelSelectionLocked: true,
      sessionId: "native-session",
      updatedAt: 1,
    };
    const params = {
      archiveTranscript: false,
      expectedEntry: entry,
      expectedSessionId: entry.sessionId,
      expectedUpdatedAt: entry.updatedAt,
      storePath,
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
    };
    await saveSessionStore(storePath, { [sessionKey]: entry }, { skipMaintenance: true });

    await expect(deleteSessionEntryLifecycle(params)).rejects.toThrow(
      "Model-selection-locked sessions cannot be removed",
    );
    await expect(rollbackAgentHarnessSessionEntryLifecycle(params)).resolves.toMatchObject({
      deleted: true,
    });
    expect(loadSessionStore(storePath, { skipCache: true })[sessionKey]).toBeUndefined();
  });

  it("does not expose privileged rollback for an unlocked legacy prefix collision", async () => {
    const sessionKey = "agent:main:harness:notes";
    const entry: SessionEntry = {
      agentHarnessId: "openclaw",
      sessionId: "legacy-session",
      updatedAt: 1,
    };
    await saveSessionStore(storePath, { [sessionKey]: entry }, { skipMaintenance: true });

    await expect(
      rollbackAgentHarnessSessionEntryLifecycle({
        archiveTranscript: false,
        expectedEntry: entry,
        expectedSessionId: entry.sessionId,
        expectedUpdatedAt: entry.updatedAt,
        storePath,
        target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
      }),
    ).rejects.toThrow("Model-selection-locked sessions cannot be removed");
    expect(loadSessionStore(storePath, { skipCache: true })[sessionKey]).toEqual(entry);
  });

  it("does not treat reserved harness keys as relocatable aliases", async () => {
    const sourceKey = "agent:main:harness:codex:supervision:source-thread";
    const targetKey = "agent:main:harness:codex:supervision:other-thread";
    const entry: SessionEntry = {
      agentHarnessId: "codex",
      modelSelectionLocked: true,
      sessionId: "native-session",
      updatedAt: 1,
    };
    await saveSessionStore(storePath, { [sourceKey]: entry }, { skipMaintenance: true });

    await expect(
      saveSessionStore(storePath, { [targetKey]: entry }, { skipMaintenance: true }),
    ).rejects.toThrow("Model-selection-locked sessions cannot be removed");
    expect(loadSessionStore(storePath, { skipCache: true })[sourceKey]).toEqual(entry);
  });
});
