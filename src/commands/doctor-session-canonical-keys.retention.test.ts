import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readSessionArchiveContentSync } from "../config/sessions/archive-compression.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import {
  loadExactSessionEntryReadOnly,
  loadTranscriptEvents,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { repairCanonicalSessionKeys } from "./doctor-session-canonical-keys.js";
import { insertLegacySession } from "./doctor-session-canonical-keys.test-support.js";

afterEach(() => closeOpenClawAgentDatabasesForTest());

describe("doctor canonical session-key retention repair", () => {
  it("copies only a cross-store winner and archives its stale same-store duplicate", async () => {
    await withStateDirEnv("openclaw-doctor-canonical-cross-store-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions.json");
      const mainStore = resolveStorePath(storeTemplate, { agentId: "main", env });
      const opsStore = resolveStorePath(storeTemplate, { agentId: "ops", env });
      const cfg = {
        agents: { list: [{ id: "main", default: true }, { id: "ops" }] },
        session: { mainKey: "shared", store: storeTemplate },
      } as OpenClawConfig;

      insertLegacySession({
        agentId: "ops",
        entry: { sessionId: "winner", updatedAt: 20 },
        env,
        eventText: "winner history",
        sessionKey: "agent:main:main",
        storePath: opsStore,
      });
      insertLegacySession({
        agentId: "ops",
        entry: { sessionId: "loser", updatedAt: 10 },
        env,
        eventText: "loser history",
        sessionKey: "agent:main:main ",
        storePath: opsStore,
      });

      const report = await repairCanonicalSessionKeys({ apply: true, cfg, env });

      expect(report).toMatchObject({
        foundGroups: 1,
        removedRows: 2,
        repairedGroups: 1,
        scannedStores: 1,
      });
      expect(
        loadExactSessionEntryReadOnly({
          agentId: "main",
          env,
          sessionKey: "agent:main:shared",
          storePath: mainStore,
        })?.entry.sessionId,
      ).toBe("winner");
      expect(
        loadExactSessionEntryReadOnly({
          agentId: "ops",
          env,
          sessionKey: "agent:main:main",
          storePath: opsStore,
        }),
      ).toBeUndefined();
      expect(
        loadExactSessionEntryReadOnly({
          agentId: "ops",
          env,
          sessionKey: "agent:main:main ",
          storePath: opsStore,
        }),
      ).toBeUndefined();
      await expect(
        loadTranscriptEvents({
          agentId: "main",
          env,
          sessionId: "winner",
          sessionKey: "agent:main:shared",
          storePath: mainStore,
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          message: expect.objectContaining({ content: "winner history" }),
        }),
      ]);
      await expect(
        loadTranscriptEvents({
          agentId: "main",
          env,
          sessionId: "loser",
          sessionKey: "agent:main:shared",
          storePath: mainStore,
        }),
      ).resolves.toEqual([]);
      const loserArchive = report.archivedTranscriptDirectories
        .flatMap((directory) =>
          fs
            .readdirSync(directory)
            .filter((name) => name.startsWith("loser.jsonl.deleted."))
            .map((name) => path.join(directory, name)),
        )
        .at(0);
      expect(loserArchive).toBeDefined();
      expect(readSessionArchiveContentSync(loserArchive as string)).toContain("loser history");
    });
  });
});
