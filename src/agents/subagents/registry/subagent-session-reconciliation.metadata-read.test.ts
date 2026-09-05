import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { replaceSessionEntrySync } from "../../../config/sessions/session-accessor.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../../../config/sessions/session-accessor.sqlite-scope.js";
import { openOpenClawAgentDatabase } from "../../../state/openclaw-agent-db.js";
import { withEnvAsync } from "../../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../../test-utils/session-state-cleanup.js";
import {
  resolveStoredSubagentCapabilities,
  resolvePersistedSubagentToolPolicyEnvelope,
} from "../spawn/subagent-capabilities.js";
import { getSubagentDepthFromSessionStore } from "../spawn/subagent-depth.js";
import { resolveSubagentSessionCompletion } from "./subagent-session-reconciliation.js";

it("reads subagent lifecycle and policy metadata without decoding unrelated session payloads", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "subagent-point-read-"));
  await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
    try {
      const storePath = path.join(stateDir, "agents/main/sessions/sessions.json");
      const childSessionKey = "agent:main:subagent:target";
      for (let i = 0; i < 100; i++) {
        replaceSessionEntrySync(
          { storePath, sessionKey: `agent:main:subagent:other-${i}` },
          {
            sessionId: `other-${i}`,
            updatedAt: 1,
            skillsSnapshot: { prompt: `UNRELATED_PAYLOAD_${"x".repeat(4096)}`, skills: [] },
          },
        );
      }
      replaceSessionEntrySync(
        { storePath, sessionKey: childSessionKey },
        {
          sessionId: "target",
          updatedAt: 2000,
          startedAt: 1000,
          endedAt: 2000,
          status: "done",
          spawnDepth: 2,
          spawnedBy: "agent:main:main",
          inheritedToolPolicyVersion: 1,
          inheritedToolAllow: ["read"],
          inheritedToolDeny: ["exec"],
        },
      );
      const parse = vi.spyOn(JSON, "parse");
      let completion;
      try {
        completion = resolveSubagentSessionCompletion({
          childSessionKey,
          cfg: { session: { store: storePath } },
          fallbackEndedAt: 3000,
        });
        const options = { cfg: { session: { store: storePath } } };
        expect(getSubagentDepthFromSessionStore(childSessionKey, options)).toBe(2);
        expect(getSubagentDepthFromSessionStore("target", options)).toBe(2);
        expect(resolveStoredSubagentCapabilities(childSessionKey, options)).toMatchObject({
          depth: 2,
          canSpawn: true,
        });
        expect(resolvePersistedSubagentToolPolicyEnvelope(childSessionKey, options)).toMatchObject({
          spawnedBy: "agent:main:main",
          inheritedToolAllow: ["read"],
          inheritedToolDeny: ["exec"],
        });
        const unrelatedParses = parse.mock.calls.filter(
          ([value]) => typeof value === "string" && value.includes("UNRELATED_PAYLOAD_"),
        ).length;
        expect(unrelatedParses).toBe(0);
      } finally {
        parse.mockRestore();
      }
      expect(completion).toMatchObject({
        startedAt: 1000,
        endedAt: 2000,
        outcome: { status: "ok" },
      });
      const params = {
        childSessionKey,
        cfg: { session: { store: storePath } },
        fallbackEndedAt: 3000,
      };
      const storeCache = new Map();
      expect(resolveSubagentSessionCompletion({ ...params, storeCache })).toEqual(completion);
      replaceSessionEntrySync(
        { storePath, sessionKey: childSessionKey },
        {
          sessionId: "successor",
          updatedAt: 4000,
          status: "running",
        },
      );
      expect(resolveSubagentSessionCompletion(params)).toBeNull();
      expect(resolveSubagentSessionCompletion({ ...params, storeCache })).toEqual(completion);
      expect(
        resolveSubagentSessionCompletion({
          ...params,
          childSessionKey: "agent:main:subagent:missing",
        }),
      ).toBeNull();

      const database = openOpenClawAgentDatabase(
        toDatabaseOptions(resolveSqliteScope({ storePath, sessionKey: childSessionKey })),
      );
      database.db
        .prepare("UPDATE session_nodes SET entry_json = ?, entry_valid = 0 WHERE session_key = ?")
        .run('{"bad":true}', childSessionKey);
      expect(resolveSubagentSessionCompletion(params)).toBeNull();

      expect(getSubagentDepthFromSessionStore(childSessionKey, { cfg: params.cfg })).toBe(1);
      expect(
        resolvePersistedSubagentToolPolicyEnvelope(childSessionKey, { cfg: params.cfg }),
      ).toBeUndefined();

      for (const [requested, stored, matches] of [
        ["Agent:MAIN:telegram:group:ROOM", "agent:main:telegram:group:room", true],
        ["agent:main:matrix:group:!Room:server", "agent:main:matrix:group:!room:server", false],
        ["agent:main:signal:group:AbCdEf==", "agent:main:signal:group:abcdef==", false],
      ] as const) {
        replaceSessionEntrySync(
          { storePath, sessionKey: stored },
          {
            sessionId: stored,
            updatedAt: 2000,
            endedAt: 2000,
            status: "done",
          },
        );
        const resolved = resolveSubagentSessionCompletion({
          ...params,
          childSessionKey: requested,
        });
        expect(resolved?.outcome.status === "ok").toBe(matches);
      }
    } finally {
      await cleanupSessionStateForTest({ stateDir });
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});
