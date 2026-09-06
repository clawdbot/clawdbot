import { describe, expect, it } from "vitest";
import { loadSessionEntry, replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createGatewaySession } from "./session-create-service.js";

describe("Gateway creation preparation", () => {
  it("retains the full adopted target while checking sibling labels", async () => {
    await withOpenClawTestState({ label: "gateway-create-snapshot" }, async () => {
      const create = (key: string, label: string) =>
        createGatewaySession({
          cfg: {},
          key,
          label,
          commandSource: "test",
          operatorRoleActor: { kind: "system" },
        });
      const first = await create("agent:main:target", "Original");
      expect(first.ok).toBe(true);
      const scope = { agentId: "main", sessionKey: "agent:main:target" };
      const initial = loadSessionEntry(scope);
      if (!initial) {
        throw new Error("Missing initial session");
      }
      const saved = {
        ...initial,
        skillsSnapshot: { prompt: "Saved skill prompt", skills: [] },
        systemPromptReport: {
          source: "run" as const,
          generatedAt: 1,
          systemPrompt: { chars: 1, projectContextChars: 0, nonProjectContextChars: 1 },
          injectedWorkspaceFiles: [],
          skills: { promptChars: 0, entries: [] },
          tools: { listChars: 0, schemaChars: 0, entries: [] },
        },
      };
      replaceSessionEntrySync(scope, saved);
      expect((await create("agent:main:sibling", "Taken")).ok).toBe(true);
      expect(await create(scope.sessionKey, "Renamed")).toMatchObject({
        ok: true,
        entry: { sessionId: saved.sessionId, label: "Renamed" },
      });
      expect(loadSessionEntry(scope)).toMatchObject({
        sessionId: saved.sessionId,
        label: "Renamed",
        skillsSnapshot: saved.skillsSnapshot,
        systemPromptReport: saved.systemPromptReport,
      });
      expect(await create(scope.sessionKey, "Taken")).toMatchObject({
        ok: false,
        error: { message: "label already in use: Taken" },
      });
      expect(loadSessionEntry(scope)).toMatchObject({
        sessionId: saved.sessionId,
        label: "Renamed",
        skillsSnapshot: saved.skillsSnapshot,
        systemPromptReport: saved.systemPromptReport,
      });
    });
  });
});
