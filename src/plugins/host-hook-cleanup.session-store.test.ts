// Verifies host hook cleanup behavior for session-store state.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearSessionStoreCacheForTest,
  loadSessionStore,
  saveSessionStore,
} from "../config/sessions/store.js";
import type { SessionEntry } from "../config/sessions/types.js";
import * as jsonFiles from "../infra/json-files.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { runPluginHostCleanup } from "./host-hook-cleanup.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";

describe("plugin host cleanup session stores", () => {
  let stateDir: string | undefined;
  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);

  afterEach(async () => {
    clearSessionStoreCacheForTest();
    envSnapshot.restore();
    if (stateDir) {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
    stateDir = undefined;
  });

  it("does not rewrite session stores when cleanup scans find no plugin-owned state", async () => {
    stateDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-host-cleanup-noop-"),
    );
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    const storePath = path.join(stateDir, "sessions.json");
    await saveSessionStore(
      storePath,
      {
        "agent:main:main": {
          sessionId: "session-id",
          updatedAt: Date.now(),
        } satisfies SessionEntry,
      },
      { skipMaintenance: true },
    );
    const writeSpy = vi.spyOn(jsonFiles, "writeTextAtomic");

    const result = await runPluginHostCleanup({
      cfg: { session: { store: storePath } },
      registry: createEmptyPluginRegistry(),
      pluginId: "noop-plugin",
      reason: "disable",
    });

    expect(result).toEqual({ cleanupCount: 0, failures: [] });
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("can defer persistent session-state cleanup to an atomic owner", async () => {
    stateDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-host-cleanup-deferred-"),
    );
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    const storePath = path.join(stateDir, "sessions.json");
    await saveSessionStore(
      storePath,
      {
        "agent:main:main": {
          sessionId: "session-id",
          updatedAt: Date.now(),
          pluginExtensions: {
            test: {
              state: { active: true },
            },
          },
        } satisfies SessionEntry,
      },
      { skipMaintenance: true },
    );

    const result = await runPluginHostCleanup({
      cfg: { session: { store: storePath } },
      registry: createEmptyPluginRegistry(),
      reason: "reset",
      sessionKey: "agent:main:main",
      skipPersistentSessionState: true,
    });

    expect(result).toEqual({ cleanupCount: 0, failures: [] });
    expect(
      loadSessionStore(storePath, { skipCache: true })["agent:main:main"]?.pluginExtensions,
    ).toEqual({
      test: {
        state: { active: true },
      },
    });
  });

  it("clears plugin-owned session state across resolved stores without touching unrelated rows", async () => {
    stateDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-host-cleanup-multistore-"),
    );
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    const firstStorePath = path.join(stateDir, "agent-a", "sessions.json");
    const secondStorePath = path.join(stateDir, "agent-b", "sessions.json");
    const beforeUpdatedAt = 100;
    const unrelatedUpdatedAt = Date.now();
    const firstEntry: SessionEntry = {
      sessionId: "shared-session",
      updatedAt: beforeUpdatedAt,
      pluginExtensions: {
        cleanup: { state: { active: true } },
        other: { state: { preserved: true } },
      },
      pluginNextTurnInjections: {
        cleanup: [
          {
            id: "remove",
            pluginId: "cleanup",
            text: "remove",
            placement: "append_context",
            createdAt: beforeUpdatedAt,
          },
        ],
      },
    };
    const secondEntry: SessionEntry = {
      sessionId: "shared-session",
      updatedAt: beforeUpdatedAt,
      pluginExtensions: {
        cleanup: { state: { active: true } },
      },
    };
    const unrelatedEntry: SessionEntry = {
      sessionId: "unrelated-session",
      updatedAt: unrelatedUpdatedAt,
      pluginExtensions: {
        cleanup: { state: { keep: true } },
      },
    };
    await saveSessionStore(
      firstStorePath,
      {
        "agent:a:main": firstEntry,
        "agent:a:unrelated": unrelatedEntry,
      },
      { skipMaintenance: true },
    );
    await saveSessionStore(
      secondStorePath,
      {
        "agent:b:other": secondEntry,
      },
      { skipMaintenance: true },
    );

    const result = await runPluginHostCleanup({
      cfg: { session: { store: firstStorePath } },
      registry: createEmptyPluginRegistry(),
      pluginId: "cleanup",
      reason: "disable",
      sessionKey: "shared-session",
      sessionStorePaths: [firstStorePath, secondStorePath],
    });

    expect(result).toEqual({ cleanupCount: 2, failures: [] });
    const firstStore = loadSessionStore(firstStorePath, { skipCache: true });
    const secondStore = loadSessionStore(secondStorePath, { skipCache: true });
    expect(firstStore["agent:a:main"]?.pluginExtensions).toEqual({
      other: { state: { preserved: true } },
    });
    expect(firstStore["agent:a:main"]?.pluginNextTurnInjections).toBeUndefined();
    expect(firstStore["agent:a:main"]?.updatedAt).toBeGreaterThan(beforeUpdatedAt);
    expect(firstStore["agent:a:unrelated"]).toEqual(unrelatedEntry);
    expect(secondStore["agent:b:other"]?.pluginExtensions).toBeUndefined();
    expect(secondStore["agent:b:other"]?.updatedAt).toBeGreaterThan(beforeUpdatedAt);
  });

  it("preserves locked sessions for every harness owned by a disabled plugin", async () => {
    stateDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-host-cleanup-locked-harness-"),
    );
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    const storePath = path.join(stateDir, "sessions.json");
    const updatedAt = 100;
    const registry = createEmptyPluginRegistry();
    for (const harnessId of ["fixture-harness-a", "fixture-harness-b"]) {
      registry.agentHarnesses.push({
        pluginId: "fixture-plugin",
        source: "test",
        harness: {
          id: harnessId,
          label: harnessId,
          supports: () => ({ supported: true }),
          runAttempt: async () => {
            throw new Error("unused test harness");
          },
        },
      });
    }
    registry.agentHarnesses.push({
      pluginId: "other-plugin",
      source: "test",
      harness: {
        id: "other-harness",
        label: "other-harness",
        supports: () => ({ supported: true }),
        runAttempt: async () => {
          throw new Error("unused test harness");
        },
      },
    });
    await saveSessionStore(
      storePath,
      {
        "agent:main:harness-a:locked": {
          sessionId: "locked-session-a",
          updatedAt,
          agentHarnessId: "fixture-harness-a",
          modelSelectionLocked: true,
          pluginExtensions: {
            "fixture-plugin": {
              supervision: {
                sourceThreadId: "native-thread-a",
                modelLocked: true,
              },
            },
          },
        } satisfies SessionEntry,
        "agent:main:harness-b:locked": {
          sessionId: "locked-session-b",
          updatedAt,
          agentHarnessId: "fixture-harness-b",
          modelSelectionLocked: true,
          pluginExtensions: {
            "fixture-plugin": {
              supervision: {
                sourceThreadId: "native-thread-b",
                modelLocked: true,
              },
            },
          },
        } satisfies SessionEntry,
        "agent:main:other-harness:locked": {
          sessionId: "other-locked-session",
          updatedAt,
          agentHarnessId: "other-harness",
          modelSelectionLocked: true,
          pluginExtensions: {
            "fixture-plugin": { transient: true },
          },
        } satisfies SessionEntry,
        "agent:main:ordinary": {
          sessionId: "ordinary-session",
          updatedAt,
          pluginExtensions: {
            "fixture-plugin": { transient: true },
          },
        } satisfies SessionEntry,
      },
      { skipMaintenance: true },
    );

    const result = await runPluginHostCleanup({
      cfg: { session: { store: storePath } },
      registry,
      pluginId: "fixture-plugin",
      reason: "disable",
      sessionStorePaths: [storePath],
    });

    expect(result).toEqual({ cleanupCount: 2, failures: [] });
    const store = loadSessionStore(storePath, { skipCache: true });
    expect(store["agent:main:harness-a:locked"]).toMatchObject({
      updatedAt,
      agentHarnessId: "fixture-harness-a",
      modelSelectionLocked: true,
      pluginExtensions: {
        "fixture-plugin": {
          supervision: { sourceThreadId: "native-thread-a", modelLocked: true },
        },
      },
    });
    expect(store["agent:main:harness-b:locked"]).toMatchObject({
      updatedAt,
      agentHarnessId: "fixture-harness-b",
      modelSelectionLocked: true,
      pluginExtensions: {
        "fixture-plugin": {
          supervision: { sourceThreadId: "native-thread-b", modelLocked: true },
        },
      },
    });
    expect(store["agent:main:other-harness:locked"]?.pluginExtensions).toBeUndefined();
    expect(store["agent:main:ordinary"]?.pluginExtensions).toBeUndefined();
  });
});
