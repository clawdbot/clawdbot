import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveDefaultSessionStorePath } from "../config/sessions/paths.js";
import {
  appendTranscriptMessage,
  deleteSessionEntryLifecycle,
  listSessionTranscriptInstances,
  recordSessionParticipant,
  replaceSessionEntry,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  loadArchivedSessions,
  loadMemorySessionMetadata,
  resolveMemorySessionTargets,
} from "./memory-core-host-engine-sessions.js";

describe("memory source sessions", () => {
  it.each(["default", "custom", "shared"])(
    "resolves metadata and deletion selectors in the %s session store",
    async (layout) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const storePath =
          layout === "default"
            ? resolveDefaultSessionStorePath("main")
            : path.join(
                state.root,
                "custom",
                layout === "shared" ? "sessions.sqlite" : "sessions.json",
              );
        await fs.mkdir(path.dirname(storePath), { recursive: true });
        const scope = { agentId: "main", storePath };
        const sessionId = `source-${"x".repeat(300)}`;
        const sessionKey = "agent:main:source-session";
        await upsertSessionEntryCore(
          { ...scope, sessionKey },
          {
            sessionId,
            sessionStartedAt: 1_000,
            updatedAt: 1_000,
            chatType: "group",
            hookExternalContentSource: "gmail",
          },
        );
        recordSessionParticipant(
          { ...scope, sessionKey },
          { identity: { type: "profile", id: "profile-source" } },
        );
        closeOpenClawAgentDatabasesForTest();

        expect(loadMemorySessionMetadata({ ...scope, sessionId, sessionKey })).toMatchObject({
          sessionId,
          sessionKey,
          hookExternalContentSource: "gmail",
          chatType: "group",
        });
        for (const selectors of [
          { sessionIds: [sessionId] },
          { sessionIds: [sessionKey] },
          { hookSources: ["gmail"] },
          { participants: ["profile-source"] },
        ]) {
          expect(resolveMemorySessionTargets({ ...scope, ...selectors })).toEqual([
            expect.objectContaining({ sessionId, sessionKey, resolution: "live" }),
          ]);
        }
        expect(
          resolveMemorySessionTargets({ ...scope, sessionIds: [sessionId], since: 2_000 }),
        ).toEqual([]);
        expect(
          resolveMemorySessionTargets({ ...scope, sessionIds: ["unknown"], since: 2_000 }),
        ).toEqual([expect.objectContaining({ sessionId: "unknown", resolution: "unresolved" })]);

        await appendTranscriptMessage(
          { ...scope, sessionId, sessionKey },
          { message: { role: "user", content: "Retain this source as an archive." } },
        );
        const deletion = await deleteSessionEntryLifecycle({
          ...scope,
          target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
          archiveTranscript: true,
        });
        closeOpenClawAgentDatabasesForTest();
        const archiveName = path.basename(deletion.archivedTranscripts[0]?.archivedPath ?? "");
        expect(loadArchivedSessions({ ...scope, sessionIds: [sessionKey] })).toEqual([
          expect.objectContaining({ sessionId, sessionKey }),
        ]);
        expect(loadArchivedSessions({ ...scope, archiveNames: [archiveName] })).toEqual([
          expect.objectContaining({ archiveName, sessionId, sessionKey }),
        ]);
        expect(resolveMemorySessionTargets({ ...scope, sessionIds: [sessionKey] })).toEqual([
          expect.objectContaining({ sessionId, sessionKey, resolution: "archived" }),
        ]);
        expect(resolveMemorySessionTargets({ ...scope, hookSources: ["gmail"] })).toEqual([]);
      });
    },
  );

  it("keeps another agent's live and archived sources out of a shared store selection", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storePath = path.join(state.root, "shared.sqlite");
      const mainScope = { agentId: "main", storePath };
      for (const agentId of ["main", "other"]) {
        const sessionId = `${agentId}-source`;
        const sessionKey = `agent:${agentId}:source`;
        const scope = { agentId, storePath, sessionId, sessionKey };
        await upsertSessionEntryCore(scope, {
          sessionId,
          updatedAt: 1_000,
          hookExternalContentSource: "gmail",
        });
        recordSessionParticipant(scope, {
          identity: { type: "profile", id: "same-participant" },
        });
        await appendTranscriptMessage(scope, { message: { role: "user", content: agentId } });
      }
      for (const selectors of [
        { hookSources: ["gmail"] },
        { participants: ["same-participant"] },
      ]) {
        expect(resolveMemorySessionTargets({ ...mainScope, ...selectors })).toEqual([
          expect.objectContaining({ sessionId: "main-source" }),
        ]);
      }
      expect(
        loadMemorySessionMetadata({
          ...mainScope,
          sessionId: "other-source",
          sessionKey: "agent:other:source",
        }),
      ).toBeUndefined();
      await deleteSessionEntryLifecycle({
        agentId: "other",
        storePath,
        target: { canonicalKey: "agent:other:source", storeKeys: ["agent:other:source"] },
        archiveTranscript: true,
      });
      expect(loadArchivedSessions({ ...mainScope, sessionIds: ["other-source"] })).toEqual([]);
    });
  });

  it("selects the exact recorded email source without conflating webhooks", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      for (const source of ["email", "webhook"] as const) {
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: `agent:main:${source}` },
          { sessionId: source, updatedAt: 1_000, hookExternalContentSource: source },
        );
      }
      closeOpenClawAgentDatabasesForTest();
      for (const source of ["email", "webhook"] as const) {
        expect(loadMemorySessionMetadata({ agentId: "main", sessionId: source })).toMatchObject({
          hookExternalContentSource: source,
        });
        expect(resolveMemorySessionTargets({ agentId: "main", hookSources: [source] })).toEqual([
          expect.objectContaining({ sessionId: source, hookExternalContentSource: source }),
        ]);
      }
      const emailScope = { agentId: "main", sessionKey: "agent:main:email" };
      await appendTranscriptMessage(
        { ...emailScope, sessionId: "email" },
        { message: { role: "user", content: "Retained email content." } },
      );
      await replaceSessionEntry(emailScope, { sessionId: "replacement", updatedAt: 2_000 });
      expect(loadMemorySessionMetadata({ agentId: "main", sessionId: "email" })).toMatchObject({
        hookExternalContentSource: null,
      });
      expect(resolveMemorySessionTargets({ agentId: "main", hookSources: ["webhook"] })).toEqual([
        expect.objectContaining({ sessionId: "webhook" }),
      ]);
      expect(
        listSessionTranscriptInstances({ agentId: "main" }).find(
          (instance) => instance.sessionId === "email",
        )?.entry.hookExternalContentSource,
      ).toBe("webhook");
    });
  });

  it("does not create an absent configured session store while inspecting sources", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storePath = path.join(state.root, "absent", "sessions.json");
      const scope = { agentId: "main", storePath, sessionId: "missing" };
      expect(loadMemorySessionMetadata(scope)).toBeUndefined();
      expect(loadArchivedSessions({ ...scope, sessionIds: ["missing"] })).toEqual([]);
      expect(resolveMemorySessionTargets({ ...scope, sessionIds: ["missing"] })).toEqual([
        expect.objectContaining({ sessionId: "missing", resolution: "unresolved" }),
      ]);
      await expect(fs.stat(path.dirname(storePath))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});
