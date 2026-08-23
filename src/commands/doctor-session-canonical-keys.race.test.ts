import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  listCanonicalSessionRepairFacts,
  loadCanonicalSessionRepairEntries,
  loadExactSessionEntryReadOnly,
} from "../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import { repairCanonicalSessionKeys } from "./doctor-session-canonical-keys.js";
import { insertLegacySession } from "./doctor-session-canonical-keys.test-support.js";

afterEach(() => closeOpenClawAgentDatabasesForTest());

describe("doctor canonical session decision races", () => {
  it("rejects stale canonical facts after delivery evidence changes", async () => {
    await withStateDirEnv("openclaw-doctor-canonical-stale-fact-", async ({ stateDir }) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions.json");
      const storePath = resolveSessionStorePathCore(storeTemplate, { agentId: "main", env });
      const sessionKey = "agent:main:matrix:channel:!mixedcase:example.org";
      insertLegacySession({
        agentId: "main",
        entry: {
          delivery: normalizeSessionDeliveryState({
            context: { channel: "matrix", to: "!MixedCase:example.org" },
          }),
          sessionId: "stale-delivery-session",
          updatedAt: 10,
        },
        env,
        sessionKey,
        storePath,
      });
      const facts = listCanonicalSessionRepairFacts({ agentId: "main", env, storePath });
      const database = openOpenClawAgentDatabase({
        agentId: "main",
        env,
        path: resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main", env }).path,
      });
      const changedEntry = {
        delivery: normalizeSessionDeliveryState({
          context: { channel: "matrix", to: "!MIXEDCASE:example.org" },
        }),
        label: "concurrent unrelated metadata",
        sessionId: "stale-delivery-session",
        updatedAt: 10,
      };
      database.db
        .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
        .run(JSON.stringify(changedEntry), sessionKey);
      database.db
        .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?")
        .run(sessionKey);

      expect(
        listCanonicalSessionRepairFacts({ agentId: "main", env, storePath })[0]?.decisionToken,
      ).not.toBe(facts[0]?.decisionToken);
      expect(() =>
        loadCanonicalSessionRepairEntries({ agentId: "main", env, storePath }, facts),
      ).toThrow("Canonical session repair inputs changed during scan");
      expect(
        database.db
          .prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?")
          .get(sessionKey),
      ).toEqual({ entry_json: JSON.stringify(changedEntry) });

      const cfg = {
        agents: { list: [{ id: "main", default: true }] },
        session: { store: storeTemplate },
      } as OpenClawConfig;
      expect(await repairCanonicalSessionKeys({ apply: true, cfg, env })).toMatchObject({
        foundGroups: 1,
        repairedGroups: 1,
      });
      expect(
        loadExactSessionEntryReadOnly({
          agentId: "main",
          env,
          sessionKey: "agent:main:matrix:channel:!MIXEDCASE:example.org",
          storePath,
        })?.entry,
      ).toMatchObject({ label: "concurrent unrelated metadata" });
      expect(
        loadExactSessionEntryReadOnly({
          agentId: "main",
          env,
          sessionKey: "agent:main:matrix:channel:!MixedCase:example.org",
          storePath,
        }),
      ).toBeUndefined();
    });
  });
});
