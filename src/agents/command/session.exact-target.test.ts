import fs from "node:fs";
import { expect, it, vi } from "vitest";
import { resolveInternalSessionEffectsIdentity } from "../../config/sessions/internal-session-key.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  isOpenClawAgentDatabaseOpen,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { resolveSession, resolveSessionKeyForRequestCore } from "./session.js";

it.each(["work", "dashboard:incognito-work"])(
  "resolves the exact %s session without enumerating unrelated rows",
  async (key) => {
    await withOpenClawTestState({ label: "command-exact-session" }, async (state) => {
      const storePath = state.path("sessions.sqlite");
      const sessionKey = `agent:main:${key}`;
      const incognito = key.startsWith("dashboard:incognito-");
      const cfg = {
        agents: { defaults: {} },
        session: { store: storePath, reset: { mode: "idle", idleMinutes: 60 } },
      } satisfies OpenClawConfig;
      const entry = {
        sessionId: "selected-session",
        updatedAt: Date.now(),
        sessionStartedAt: Date.now(),
        lastInteractionAt: Date.now(),
        thinkingLevel: "high",
        modelOverride: "gpt-5.6-luna",
        providerOverride: "openai",
        lifecycleRevision: "selected-revision",
        skillsSnapshot: { prompt: "selected prompt", skills: [] },
        ...(incognito ? { incognito: true as const } : {}),
      };
      await sessionAccessor.replaceSessionEntry({ sessionKey, storePath }, entry);
      const persisted = sessionAccessor.loadExactSessionEntryReadOnly({
        sessionKey,
        storePath,
      })?.entry;
      expect(persisted).toMatchObject({
        thinkingLevel: "high",
        modelOverride: "gpt-5.6-luna",
        providerOverride: "openai",
        lifecycleRevision: expect.any(String),
      });
      if (!incognito) {
        await sessionAccessor.replaceSessionEntry(
          { sessionKey: "agent:main:unrelated", storePath },
          { sessionId: "unrelated-session", updatedAt: Date.now() },
        );
      }
      const list = vi.spyOn(sessionAccessor, "listSessionEntriesReadOnly");
      try {
        const resolved = resolveSession({ cfg, sessionKey });
        expect(resolved).toMatchObject({
          sessionId: entry.sessionId,
          sessionKey,
          isNewSession: false,
          persistedThinking: "high",
          sessionEntry: persisted,
        });
        if (!resolved.sessionEntry?.skillsSnapshot) {
          throw new Error("expected the selected session's skills");
        }
        resolved.sessionEntry.skillsSnapshot.prompt = "caller-owned edit";
        expect(
          sessionAccessor.loadExactSessionEntryReadOnly({ sessionKey, storePath })?.entry
            .skillsSnapshot?.prompt,
        ).toBe("selected prompt");
        expect(list).not.toHaveBeenCalled();
        if (incognito) {
          expect(fs.existsSync(storePath)).toBe(false);
        }
      } finally {
        list.mockRestore();
      }
    });
  },
);

it("does not provision a missing incognito lookup or select a hidden run-owned entry", async () => {
  await withOpenClawTestState({ label: "command-private-session" }, async (state) => {
    const storePath = state.path("sessions.sqlite");
    const cfg = { agents: { defaults: {} }, session: { store: storePath } };
    const incognitoPath = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" });
    expect(
      resolveSessionKeyForRequestCore({ cfg, sessionKey: "agent:main:dashboard:incognito-missing" })
        .sessionEntry,
    ).toBeUndefined();
    expect(isOpenClawAgentDatabaseOpen(incognitoPath)).toBe(false);
    expect(fs.existsSync(storePath)).toBe(false);

    const hidden = resolveInternalSessionEffectsIdentity({ agentId: "main", runId: "hidden-run" });
    await sessionAccessor.replaceSessionEntry(
      { sessionKey: hidden.sessionKey, storePath },
      { sessionId: hidden.sessionId, updatedAt: Date.now() },
    );
    expect(
      resolveSessionKeyForRequestCore({ cfg, sessionKey: hidden.sessionKey }).sessionEntry,
    ).toBeUndefined();
  });
});
