import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  loadSessionEntryReadOnly,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { reconcileSessionTranscriptIndexes } from "../config/sessions/session-transcript-reconcile.js";
import {
  closeOpenClawAgentDatabasesForTest,
  isOpenClawAgentDatabaseOpen,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  ensureProfileForEmail,
  setDisplayName,
  syncGitHubIdentity,
} from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createSessionCatalogGitHubLinker,
  projectSessionCatalogSourceActor,
  readSessionTranscriptCatalogPage,
  readSessionTranscriptCatalogTitle,
} from "./session-transcript-runtime.js";

const source = { pluginId: "session-share", sourceDomain: "source-node" };
const scope = { agentId: "main", sessionKey: "agent:main:shared", sessionId: "shared-session" };
const read = (limit: number, cursor?: string) =>
  readSessionTranscriptCatalogPage({ ...scope, ...source, limit, cursor });

async function seed(messages: unknown[]) {
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  for (const [index, message] of messages.entries()) {
    await appendTranscriptMessage(scope, {
      eventId: `message-${index}`,
      message,
      now: 1000 + index,
    });
  }
}

describe("native transcript catalog SDK", () => {
  it("pages the visible display projection newest-first, including reasoning and tools, without opening a writer", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await seed([
        { role: "user", content: "Visible question" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Reasoning" },
            { type: "toolCall", id: "call", name: "read", arguments: { path: "README.md" } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call",
          toolName: "read",
          content: [{ type: "text", text: "Tool result" }],
        },
        { role: "assistant", content: [{ type: "text", text: "Answer" }] },
        { role: "assistant", content: "NO_REPLY" },
      ]);
      const databasePath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      const before = fs.readFileSync(databasePath);
      const first = await read(2);
      expect(first.items.map((item) => [item.type, item.text])).toEqual([
        ["agentMessage", "Answer"],
        ["toolResult", "Tool result"],
      ]);
      const second = await read(1, first.nextCursor);
      expect(second.items).toMatchObject([
        { type: "toolCall", text: expect.stringContaining("README.md") },
      ]);
      const third = await read(2, second.nextCursor);
      expect(third.items.map((item) => [item.type, item.text])).toEqual([
        ["reasoning", "Reasoning"],
        ["userMessage", "Visible question"],
      ]);
      expect(third.nextCursor).toBeUndefined();
      expect(isOpenClawAgentDatabaseOpen(databasePath)).toBe(false);
      expect(fs.readFileSync(databasePath)).toEqual(before);
    });
  });

  it("redacts before clipping text and derives the same human title as local sessions", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await seed([
        { role: "user", content: "A useful session title" },
        {
          role: "assistant",
          content: `Authorization: Bearer synthetic-secret-token\n${"x".repeat(9000)}`,
        },
      ]);
      const page = await read(1);
      expect(page.items[0]).toMatchObject({ type: "agentMessage", truncated: true });
      expect(page.items[0]?.text).not.toContain("synthetic-secret-token");
      expect(page.items[0]?.text?.length).toBeLessThanOrEqual(6000);
      const entry = loadSessionEntryReadOnly(scope);
      if (!entry) {
        throw new Error("missing fixture entry");
      }
      expect(readSessionTranscriptCatalogTitle({ ...scope, entry })).toBe("A useful session title");
      expect(
        readSessionTranscriptCatalogTitle({
          ...scope,
          entry: { ...entry, label: "Named", displayName: "Display" },
        }),
      ).toBe("Named");
    });
  });

  it("keeps older-item cursors stable across append and rejects malformed or foreign cursors", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await seed(["one", "two", "three"].map((content) => ({ role: "user", content })));
      const first = await read(2);
      await appendTranscriptMessage(scope, {
        eventId: "message-3",
        message: { role: "user", content: "four" },
      });
      const next = await read(2, first.nextCursor);
      expect(next.items.map((item) => item.text)).toEqual(["one"]);
      await expect(read(2, "not-a-cursor")).rejects.toThrow("Invalid session transcript cursor");
      for (const limit of [0, 201, 1.5, Number.NaN]) {
        await expect(read(limit)).rejects.toThrow("limit must be an integer");
      }
      await upsertSessionEntryCore(
        { ...scope, sessionKey: "agent:main:other" },
        { sessionId: "other-session", updatedAt: 1 },
      );
      await expect(
        readSessionTranscriptCatalogPage({
          ...source,
          agentId: "main",
          sessionKey: "agent:main:other",
          limit: 2,
          cursor: first.nextCursor,
        }),
      ).rejects.toThrow("no longer matches");
      await appendTranscriptEvent(scope, {
        type: "leaf",
        id: "rewind",
        parentId: "message-3",
        targetId: "message-0",
      });
      // The source writer owns rewind reconciliation; catalog reads cannot rebuild it.
      await reconcileSessionTranscriptIndexes({ agentId: scope.agentId });
      expect((await read(2)).items.map((item) => item.text)).toEqual(["one"]);
      await expect(read(2, first.nextCursor)).rejects.toThrow("no longer matches");
      for (const [eventId, parentId] of [
        ["replacement-two", "message-0"],
        ["replacement-three", "replacement-two"],
      ] as const) {
        await appendTranscriptMessage(scope, {
          eventId,
          parentId,
          message: { role: "user", content: eventId },
        });
      }
      // Equal-length branch replacements must not reuse the old ordinal as an anchor.
      await expect(read(2, first.nextCursor)).rejects.toThrow("no longer matches");
    });
  });

  it("exports portable senders and creators, linking only verified numeric GitHub identities on opt-in", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const github = syncGitHubIdentity({
        identity: { accountId: 12345, login: "portable-user", name: "Portable User" },
        authenticationAlias: { kind: "github-login", login: "portable-user" },
      });
      const local = ensureProfileForEmail("local@example.test");
      setDisplayName(local.id, "Local User");
      const observation = {
        type: "observation",
        pluginId: "fixture",
        accountId: null,
        senderKind: "human",
        id: "external-user",
      };
      await seed([
        {
          role: "user",
          content: "GitHub",
          __openclaw: { senderIdentity: { type: "profile", id: github.id } },
        },
        {
          role: "user",
          content: "Local",
          __openclaw: { senderIdentity: { type: "profile", id: local.id } },
        },
        {
          role: "user",
          content: "Observed",
          __openclaw: { senderIdentity: observation, senderName: "Observed User" },
        },
      ]);
      const page = await read(10);
      expect(page.items.map((item) => item.sender)).toEqual([
        { identity: observation, label: "Observed User" },
        {
          identity: {
            type: "remote",
            pluginId: source.pluginId,
            domain: source.sourceDomain,
            idKind: "profile",
            id: local.id,
          },
          label: "Local User",
        },
        {
          identity: {
            type: "remote",
            pluginId: source.pluginId,
            domain: source.sourceDomain,
            idKind: "github-account",
            id: "12345",
          },
          label: "Portable User",
        },
      ]);
      const sender = page.items[2]?.sender;
      if (!sender) {
        throw new Error("missing GitHub sender");
      }
      const linker = createSessionCatalogGitHubLinker();
      expect(linker.linkParticipant(sender)).toMatchObject({
        identity: { type: "profile", id: github.id },
        label: "Portable User",
      });
      const unmatched = {
        ...sender,
        identity: {
          type: "remote" as const,
          pluginId: "fixture",
          domain: "elsewhere",
          idKind: "github-account",
          id: "999",
        },
      };
      expect(linker.linkParticipant(unmatched)).toEqual(unmatched);
      expect(linker.resolveOwner("github:PORTABLE-USER")).toMatchObject({
        type: "human",
        id: github.id,
        identity: { type: "profile", id: github.id },
      });
      expect(linker.resolveOwner(`profile:${local.id}`)).toMatchObject({
        id: local.id,
        label: "Local User",
      });
      expect(linker.resolveOwner("github:missing")).toBeUndefined();
      const newlyVerified = syncGitHubIdentity({
        identity: { accountId: 999, login: "newly-verified", name: "Newly Verified" },
        authenticationAlias: { kind: "github-login", login: "newly-verified" },
      });
      expect(linker.linkParticipant(unmatched)).toEqual(unmatched);
      expect(linker.resolveOwner("github:newly-verified")).toBeUndefined();
      const nextPageLinker = createSessionCatalogGitHubLinker();
      expect(nextPageLinker.linkParticipant(unmatched)).toMatchObject({
        identity: { type: "profile", id: newlyVerified.id },
      });
      expect(nextPageLinker.resolveOwner("github:newly-verified")).toMatchObject({
        id: newlyVerified.id,
      });
      expect(
        projectSessionCatalogSourceActor({
          ...source,
          actor: { type: "human", source: "profile", id: github.id },
        }),
      ).toMatchObject({ type: "human", identity: sender.identity, label: "Portable User" });
      expect(
        projectSessionCatalogSourceActor({
          ...source,
          actor: { type: "human", source: "channel", id: github.id },
        })?.identity,
      ).toBeUndefined();
      expect(
        projectSessionCatalogSourceActor({
          ...source,
          actor: { type: "agent", id: "main", label: "Main" },
        }),
      ).toEqual({ type: "agent", id: "main", label: "Main" });
    });
  });

  it("does not create missing source session storage", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      await expect(read(1)).rejects.toThrow("Session not found");
      expect(fs.existsSync(state.agentDir())).toBe(false);
    });
  });
});
