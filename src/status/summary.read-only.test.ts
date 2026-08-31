import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { getAgentLocalStatuses } from "../commands/status.agent-local.js";
import { clearRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import {
  replaceSessionEntry,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  createDirectOutboundTestAdapter,
  createOutboundTestPlugin,
  createTestRegistry,
} from "../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getStatusSummary } from "./summary.js";

describe("getStatusSummary read-only session access", () => {
  const previousRegistry = getActivePluginRegistry();
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  beforeEach(() => {
    const telegram = createOutboundTestPlugin({
      id: "telegram",
      outbound: createDirectOutboundTestAdapter({ channel: "telegram" }),
      messaging: {
        targetPrefixes: ["telegram"],
        inferTargetChatType: ({ to }) => {
          return /^(?:telegram:)?\d+$/.test(to) ? "direct" : undefined;
        },
      },
    });
    telegram.config = {
      ...telegram.config,
      resolveAllowFrom: ({ cfg }) => cfg.channels?.telegram?.allowFrom ?? [],
    };
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "telegram", plugin: telegram, source: "test" }]),
    );
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
  });

  afterAll(() => {
    if (previousRegistry) {
      setActivePluginRegistry(previousRegistry);
    }
  });

  it("does not create the heartbeat session database while checking its route", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-status-heartbeat-"));
    const databasePath = path.join(tempDir, "openclaw-agent.sqlite");

    try {
      const summary = await getStatusSummary({
        includeChannelSummary: false,
        config: { session: { store: databasePath } },
      });

      expect(summary.heartbeat.agents[0]?.waitingForRoute).toBe(true);
      expect(fs.existsSync(databasePath)).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.each([undefined, "owner"])(
    "resolves the configured owner DM without writing session state for target %s",
    async (target) => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-status-owner-"));
      const databasePath = path.join(tempDir, "openclaw-agent.sqlite");

      try {
        const summary = await getStatusSummary({
          includeChannelSummary: false,
          config: {
            ...(target ? { agents: { defaults: { heartbeat: { target } } } } : {}),
            commands: { ownerAllowFrom: ["telegram:123"] },
            channels: { telegram: { allowFrom: ["123"] } },
            session: { store: databasePath },
          },
        });

        expect(summary.heartbeat.agents[0]?.waitingForRoute).toBe(false);
        expect(fs.existsSync(databasePath)).toBe(false);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );

  it.each(["sessions.json", "shared.sqlite"])(
    "reports each agent's activity and reads each physical session store once for %s",
    async (fileName) => {
      const tempDir = tempDirs.make("openclaw-status-session-stores-");
      const storePath = path.join(tempDir, fileName);
      const config = {
        agents: {
          defaults: { systemAgent: { agentId: "main" } },
          list: [{ id: "main", default: true }, { id: "ops" }],
        },
        session: { store: storePath },
      };

      try {
        for (const agentId of ["main", "ops"]) {
          const logicalPath = resolveSessionStorePathCore(config.session.store, { agentId });
          await replaceSessionEntry(
            { agentId, sessionKey: `agent:${agentId}:main`, storePath: logicalPath },
            { sessionId: `${agentId}-session`, updatedAt: agentId === "main" ? 10 : 20 },
          );
        }
        closeOpenClawAgentDatabasesForTest();

        const expectedPaths = ["main", "ops"].map(
          (agentId) => resolveSqliteTargetFromSessionStorePath(storePath, { agentId }).path,
        );
        const uniquePaths = [...new Set(expectedPaths)];
        const listEntries = vi.spyOn(sessionAccessor, "listSessionEntriesReadOnly");
        const now = vi.spyOn(Date, "now").mockReturnValue(100);
        try {
          const summary = await getStatusSummary({ includeChannelSummary: false, config });

          expect(summary.sessions.count).toBe(2);
          expect(summary.sessions.paths).toEqual(uniquePaths);
          expect(
            summary.sessions.byAgent.map((agent) => [
              agent.agentId,
              agent.path,
              agent.count,
              agent.recent.map((session) => [session.agentId, session.key]),
            ]),
          ).toEqual([
            ["main", expectedPaths[0], 1, [["main", "agent:main:main"]]],
            ["ops", expectedPaths[1], 1, [["ops", "agent:ops:main"]]],
          ]);
          expect(listEntries).toHaveBeenCalledTimes(uniquePaths.length);

          listEntries.mockClear();
          const local = await getAgentLocalStatuses(config);
          expect(local.totalSessions).toBe(2);
          expect(
            local.agents.map((agent) => [
              agent.id,
              agent.sessionsCount,
              agent.lastUpdatedAt,
              agent.lastActiveAgeMs,
            ]),
          ).toEqual([
            ["main", 1, 10, 90],
            ["ops", 1, 20, 80],
          ]);
          expect(listEntries).toHaveBeenCalledTimes(uniquePaths.length);
          expect(uniquePaths.every((databasePath) => fs.existsSync(databasePath))).toBe(true);
        } finally {
          listEntries.mockRestore();
          now.mockRestore();
        }
      } finally {
        closeOpenClawAgentDatabasesForTest();
        closeOpenClawStateDatabaseForTest();
      }
    },
  );

  it("does not reread ambient config while projecting prepared session runtime state", async () => {
    await withOpenClawTestState(
      { prefix: "openclaw-status-prepared-config-", layout: "split" },
      async (state) => {
        const storePath = state.path("sessions.json");
        const config = { session: { store: storePath } };
        await state.writeConfig({ session: {} });
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: "agent:main:main", storePath },
          { sessionId: "prepared-config", updatedAt: 10 },
        );
        closeOpenClawAgentDatabasesForTest();
        clearRuntimeConfigSnapshot();
        const readFileSync = vi.spyOn(fs, "readFileSync");
        try {
          await getStatusSummary({ includeChannelSummary: false, config });
          expect(
            readFileSync.mock.calls.filter(([file]) => file === state.configPath),
          ).toHaveLength(0);
        } finally {
          readFileSync.mockRestore();
        }
      },
    );
  });
});
