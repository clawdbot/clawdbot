import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import type { SessionsResolveParams } from "../../packages/gateway-protocol/src/index.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { roleClient, rolePolicyConfig } from "./session-sharing.test-utils.js";
import { resolveSessionKeyFromResolveParams } from "./sessions-resolve.js";

const scope = { agentId: "main", sessionKey: "agent:main:target" };
const entry = { sessionId: "target-id", updatedAt: 1, label: "original" };
const cfg: OpenClawConfig = {
  agents: { ownership: "explicit", entries: { main: {} } },
};
const selectors: SessionsResolveParams[] = [
  { key: scope.sessionKey, agentId: "main" },
  { sessionId: entry.sessionId, agentId: "main" },
  { sessionId: entry.sessionId },
  { label: entry.label, agentId: "main" },
];

function resolve(p: SessionsResolveParams) {
  return resolveSessionKeyFromResolveParams({ cfg, client: null, p });
}

const resolved = { ok: true, key: scope.sessionKey, agentId: "main" };

describe("session resolution metadata", () => {
  it.each(selectors)("resolves %j without decoding unrelated saved prompts", async (p) => {
    await withOpenClawTestState({ label: "resolve-prompts" }, async () => {
      replaceSessionEntrySync(scope, entry);
      for (let index = 0; index < 3; index++) {
        replaceSessionEntrySync(
          { ...scope, sessionKey: `agent:main:sibling-${index}` },
          {
            sessionId: `sibling-${index}`,
            updatedAt: 1,
            skillsSnapshot: { prompt: "unrelated-resolve-prompt".repeat(1024), skills: [] },
          },
        );
      }
      const parse = vi.spyOn(JSON, "parse");
      try {
        expect(await resolve(p)).toEqual(resolved);
        expect(
          parse.mock.calls.filter(([json]) => json.includes("unrelated-resolve-prompt")),
        ).toHaveLength(0);
      } finally {
        parse.mockRestore();
      }
    });
  });

  it("observes same-timestamp external and tracked label/visibility changes", async () => {
    await withOpenClawTestState({ label: "resolve-freshness" }, async () => {
      const client = roleClient("view", "resolve-viewer");
      const roleCfg = { ...cfg, ...rolePolicyConfig() };
      const visible = { ...entry, visibility: "shared" as const };
      replaceSessionEntrySync(scope, visible);
      const lookup = (p: SessionsResolveParams) =>
        resolveSessionKeyFromResolveParams({ cfg: roleCfg, client, p });
      for (let repeat = 0; repeat < 2; repeat++) {
        expect(await lookup({ key: scope.sessionKey })).toEqual(resolved);
        expect(await lookup({ label: entry.label })).toEqual(resolved);
      }
      const external = new DatabaseSync(openOpenClawAgentDatabase(scope).path);
      try {
        const hidden = { ...visible, label: "external", visibility: "draft" };
        external
          .prepare("UPDATE session_nodes SET entry_json = ?, label = ? WHERE session_key = ?")
          .run(JSON.stringify(hidden), hidden.label, scope.sessionKey);
        expect(await lookup({ key: scope.sessionKey, allowMissing: true })).toEqual({
          ok: true,
          missing: true,
        });
        expect(await lookup({ label: hidden.label, allowMissing: true })).toEqual({
          ok: true,
          missing: true,
        });
        expect(await lookup({ label: entry.label, allowMissing: true })).toEqual({
          ok: true,
          missing: true,
        });
        const tracked = { ...visible, label: "tracked" };
        replaceSessionEntrySync(scope, tracked);
        expect(await lookup({ key: scope.sessionKey })).toEqual(resolved);
        expect(await lookup({ label: tracked.label })).toEqual(resolved);
        expect(await lookup({ label: hidden.label, allowMissing: true })).toEqual({
          ok: true,
          missing: true,
        });
      } finally {
        external.close();
      }
    });
  });

  it.each(["malformed", "nul", "mismatched-time", "mismatched-window"])(
    "preserves warm and cold lookup outcomes for %s rows",
    async (kind) => {
      await withOpenClawTestState({ label: "resolve-corruption" }, async () => {
        const siblingKey = "agent:main:sibling";
        replaceSessionEntrySync(scope, entry);
        replaceSessionEntrySync(
          { ...scope, sessionKey: siblingKey },
          { sessionId: "sibling", updatedAt: 1 },
        );
        expect(await resolve({ key: scope.sessionKey })).toEqual(resolved);
        const database = openOpenClawAgentDatabase(scope).db;
        if (kind === "malformed" || kind === "nul") {
          database
            .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
            .run(
              kind === "malformed" ? "{" : JSON.stringify(entry) + "\0trailing",
              scope.sessionKey,
            );
        } else if (kind === "mismatched-time") {
          database
            .prepare("UPDATE session_nodes SET updated_at = ? WHERE session_key = ?")
            .run(2, scope.sessionKey);
        } else {
          database
            .prepare("UPDATE session_nodes SET current_session_id = ? WHERE session_key = ?")
            .run("different", scope.sessionKey);
        }
        expect(await resolve({ key: scope.sessionKey, allowMissing: true })).toEqual(
          kind === "mismatched-window" ? resolved : { ok: true, missing: true },
        );
        expect(await resolve({ key: siblingKey })).toEqual({
          ok: true,
          key: siblingKey,
          agentId: "main",
        });
        closeOpenClawAgentDatabasesForTest();
        expect(await resolve({ key: scope.sessionKey, allowMissing: true })).toEqual({
          ok: true,
          missing: true,
        });
        expect(await resolve({ key: siblingKey, allowMissing: true })).toEqual({
          ok: true,
          missing: true,
        });
      });
    },
  );
});
