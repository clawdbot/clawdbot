import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { noteStateIntegrity } from "./doctor-state-integrity.js";

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

describe("doctor state integrity ordering", () => {
  it("orders equal-time SQLite recovery warnings by session key", async () => {
    await withStateDirEnv("openclaw-doctor-state-order-", async ({ stateDir }) => {
      const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions.json");
      const storePath = storeTemplate.replace("{agentId}", "main");
      const cfg = {
        agents: { list: [{ id: "main", default: true }] },
        session: { store: storeTemplate },
      } as OpenClawConfig;
      for (const suffix of ["zeta", "alpha", "middle", "beta"]) {
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: `agent:main:subagent:${suffix}`, storePath },
          {
            abortedLastRun: true,
            sessionId: `session-${suffix}`,
            subagentRecovery: {
              automaticAttempts: 2,
              lastAttemptAt: 10,
              lastRunId: `run-${suffix}`,
              wedgedAt: 20,
              wedgedReason: "deterministic recovery warning",
            },
            updatedAt: 30,
          },
        );
      }
      const notes: string[] = [];
      const confirmRuntimeRepair = vi.fn(async (_params: { message: string }) => false);

      await noteStateIntegrity(cfg, {
        confirmRuntimeRepair,
        note: (message, title) => {
          if (title === "State integrity") {
            notes.push(String(message));
          }
        },
      });

      expect(notes.join("\n")).toContain(
        "Examples: agent:main:subagent:alpha, agent:main:subagent:beta, agent:main:subagent:middle",
      );
      expect(
        confirmRuntimeRepair.mock.calls
          .map(([prompt]) => prompt.message)
          .filter((message) => message.startsWith("Clear stale aborted recovery flags")),
      ).toEqual(["Clear stale aborted recovery flags for 4 wedged subagent sessions?"]);
    });
  });
});
