// Doctor repairs incident-scale Codex plugin state only after durable session convergence.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadExactSessionEntryReadOnly,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createPluginStateKeyedStore,
  getPluginStateCapacity,
  pluginStateDoctorEntriesInKeyRange,
  resetPluginStateStoreForTests,
} from "../plugin-state/plugin-state-store.js";
import { seedPluginStateEntriesForTests } from "../plugin-state/plugin-state-store.test-helpers.js";
import type { PluginDoctorStateMigration } from "../plugins/doctor-contract-registry.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";

const note = vi.hoisted(() => vi.fn());

vi.mock("../../packages/terminal-core/src/note.js", () => ({ note }));

vi.mock("../plugins/doctor-contract-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/doctor-contract-registry.js")>();
  const { loadBundledPluginPublicSurface } =
    await import("../plugin-sdk/test-helpers/public-surface-loader.js");
  const { stateMigrations } = await loadBundledPluginPublicSurface<{
    stateMigrations: PluginDoctorStateMigration[];
  }>({ pluginId: "codex", artifactBasename: "doctor-contract-api.js" });
  return {
    ...actual,
    listPluginDoctorStateMigrationEntries: () =>
      stateMigrations.map((migration) => ({ pluginId: "codex", migration })),
  };
});

import { noteSessionTranscriptHealth } from "./doctor-session-transcripts.js";

const BINDING_NAMESPACE = "app-server-thread-bindings";
const MANAGED_THREAD_NAMESPACE = "app-server-managed-threads";
const SESSION_BINDING_COUNT = 47_794;
const ADVISORY_MANAGED_THREAD_COUNT = 2_206;
const PLUGIN_STATE_CAPACITY = 50_000;

let incidentStateDir: string | undefined;

const stableKey = (sessionKey: string, agentId = "main") =>
  `session-key:${agentId}:${createHash("sha256").update(sessionKey).digest("base64url")}`;

afterEach(async () => {
  closeOpenClawAgentDatabasesForTest();
  resetPluginStateStoreForTests();
  vi.unstubAllEnvs();
  note.mockClear();
  if (incidentStateDir) {
    await fs.rm(incidentStateDir, { recursive: true, force: true });
    incidentStateDir = undefined;
  }
});

describe("doctor incident-scale Codex binding repair", () => {
  it("repairs a full store of mixed stable bindings without losing current or uncertain ownership", async () => {
    incidentStateDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-doctor-incident-")),
    );
    vi.stubEnv("OPENCLAW_STATE_DIR", incidentStateDir);
    const env = process.env;
    const config: OpenClawConfig = {
      agents: { entries: { main: { default: true } } },
      plugins: { entries: { codex: { enabled: true } } },
    };

    const rows: Parameters<typeof seedPluginStateEntriesForTests>[0] = [];
    const retain = (key: string, sessionId: string, extra: Record<string, unknown> = {}) => {
      rows.push({
        pluginId: "codex",
        namespace: BINDING_NAMESPACE,
        key,
        value: {
          version: 1,
          state: "active",
          sessionId,
          binding: { threadId: `thread-${sessionId}`, cwd: "/workspace" },
          ...extra,
        },
      });
    };
    const currentOwners = (
      [
        ["main", "shared-live"],
        ["other", "shared-live"],
        ["current-a", "live-a"],
        ["current-b", "live-b"],
      ] as const
    ).map(([name, sessionId]) => ({ sessionKey: `agent:main:${name}`, sessionId }));
    const readCurrentOwners = () =>
      currentOwners.map(({ sessionKey }) => ({
        sessionKey,
        sessionId: loadExactSessionEntryReadOnly({ agentId: "main", env, sessionKey })?.entry
          .sessionId,
      }));
    // Old timestamps are pruned during seeding; these owners must still exist when Doctor runs.
    const updatedAt = Date.now();
    for (const { sessionKey, sessionId } of currentOwners) {
      await replaceSessionEntry({ agentId: "main", env, sessionKey }, { sessionId, updatedAt });
      retain(stableKey(sessionKey), sessionId);
    }
    expect(readCurrentOwners()).toEqual(currentOwners);
    // ID-only evidence cannot distinguish an orphan hash from either valid shared-ID owner.
    retain(stableKey("agent:main:ambiguous-old-key"), "shared-live");
    retain("session:main:live-a", "live-a");
    retain(stableKey("agent:missing:unknown", "missing"), "missing-owner");
    retain("session:main:leased", "leased", {
      lease: { token: "live-lease", expiresAt: Date.now() + 600_000 },
    });
    retain("session:main:supervised", "supervised", {
      binding: {
        threadId: "native-source",
        cwd: "/workspace",
        connectionScope: "supervision",
        supervisionSourceThreadId: "native-source",
      },
    });
    retain("session:main:pending", "pending", {
      binding: {
        threadId: "pending-source",
        cwd: "/workspace",
        pendingSupervisionBranch: { sourceThreadId: "pending-source" },
      },
    });
    retain("conversation:external-owner", "external-owner");
    retain("session:main:malformed", "malformed", { state: "unknown" });
    const retainedBindings = rows.slice();
    const orphanCount = SESSION_BINDING_COUNT - retainedBindings.length;
    for (let index = 0; index < orphanCount; index += 1) {
      const sessionId = index === 0 ? "live-b" : `incident-session-${index}`;
      rows.push({
        pluginId: "codex",
        namespace: BINDING_NAMESPACE,
        key:
          index > 0 && index < 73
            ? `session:main:${sessionId}`
            : stableKey(`agent:main:run:${index}`),
        value:
          index % 2 === 0
            ? {
                version: 1,
                state: "active",
                sessionId,
                binding: { threadId: `incident-thread-${index}`, cwd: "/workspace" },
              }
            : { version: 1, state: "cleared", sessionId, retired: true },
      });
    }
    for (let index = 0; index < ADVISORY_MANAGED_THREAD_COUNT; index += 1) {
      rows.push({
        pluginId: "codex",
        namespace: MANAGED_THREAD_NAMESPACE,
        key: `sha256:${index.toString(16).padStart(64, "0")}`,
        value: {
          version: 1,
          kind: "managed-thread",
          sourceHomeId: "incident-source-home",
          threadId: `managed-thread-${index}`,
        },
      });
    }
    seedPluginStateEntriesForTests(rows);

    expect(getPluginStateCapacity("codex", env)).toEqual({
      liveEntries: PLUGIN_STATE_CAPACITY,
      maxEntries: PLUGIN_STATE_CAPACITY,
    });

    const runActualDoctorRepair = () =>
      noteSessionTranscriptHealth({
        cfg: config,
        env,
        sessionDirs: [],
        sessionSqlite: true,
        shouldRepair: true,
      });

    await noteSessionTranscriptHealth({
      cfg: config,
      env,
      sessionDirs: [],
      sessionSqlite: true,
      shouldRepair: false,
    });
    expect(note.mock.calls.flat().join("\n")).toContain("orphaned session ownership");
    expect(getPluginStateCapacity("codex", env).liveEntries).toBe(PLUGIN_STATE_CAPACITY);
    note.mockClear();

    await runActualDoctorRepair();

    expect(readCurrentOwners()).toEqual(currentOwners);
    const bindingRows = ["session-key:", "session:", "conversation:"].flatMap((prefix) =>
      pluginStateDoctorEntriesInKeyRange({
        pluginId: "codex",
        namespace: BINDING_NAMESPACE,
        prefix,
        limit: 512,
        env,
      }),
    );
    expect(
      bindingRows
        .map((row) => ({ key: row.key, value: row.value }))
        .toSorted((a, b) => a.key.localeCompare(b.key)),
    ).toEqual(
      retainedBindings
        .map((row) => ({ key: row.key, value: row.value }))
        .toSorted((a, b) => a.key.localeCompare(b.key)),
    );
    expect(getPluginStateCapacity("codex", env)).toEqual({
      liveEntries: ADVISORY_MANAGED_THREAD_COUNT + retainedBindings.length,
      maxEntries: PLUGIN_STATE_CAPACITY,
    });
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining(`Removed ${orphanCount} orphaned Codex`),
      expect.any(String),
    );

    const managedThreads = createPluginStateKeyedStore<{ threadId: string }>("codex", {
      namespace: MANAGED_THREAD_NAMESPACE,
      maxEntries: 20_000,
      overflowPolicy: "evict-oldest",
      env,
    });
    const preservedRows = await managedThreads.entries();
    expect(preservedRows).toHaveLength(ADVISORY_MANAGED_THREAD_COUNT);
    expect(new Set(preservedRows.map((entry) => entry.value.threadId)).size).toBe(
      ADVISORY_MANAGED_THREAD_COUNT,
    );

    // Exercise the real cap instead of inferring recovered capacity from the row count.
    const bindings = createPluginStateKeyedStore<{ recovered: boolean }>("codex", {
      namespace: BINDING_NAMESPACE,
      maxEntries: PLUGIN_STATE_CAPACITY,
      overflowPolicy: "reject-new",
      env,
    });
    await bindings.register("conversation:recovered-headroom", { recovered: true });
    expect(await bindings.lookup("conversation:recovered-headroom")).toEqual({
      recovered: true,
    });
    await bindings.delete("conversation:recovered-headroom");

    note.mockClear();
    await runActualDoctorRepair();

    expect(getPluginStateCapacity("codex", env)).toEqual({
      liveEntries: ADVISORY_MANAGED_THREAD_COUNT + retainedBindings.length,
      maxEntries: PLUGIN_STATE_CAPACITY,
    });
    expect(await managedThreads.entries()).toHaveLength(ADVISORY_MANAGED_THREAD_COUNT);
    expect(note.mock.calls.flat().join("\n")).not.toContain("orphaned Codex");
  }, 120_000);
});
