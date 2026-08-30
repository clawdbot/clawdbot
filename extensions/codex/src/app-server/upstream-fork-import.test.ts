import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getSessionEntry, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { readVisibleSessionTranscriptMessageEntries } from "openclaw/plugin-sdk/session-transcript-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toGenericTranscriptItem } from "../session-catalog-transcript-item.js";
import type { CodexSessionCatalogControl } from "../session-catalog-types.js";
import type { CodexThread, CodexThreadItem, CodexTurn } from "./protocol.js";
import { sessionBindingIdentity } from "./session-binding.js";
import { createCodexTestBindingStore } from "./session-binding.test-helpers.js";
import { importCodexThreadHistoryToTranscript } from "./transcript-mirror.js";
import { resolveCodexUpstreamForkBoundary } from "./upstream-fork-boundary.js";
import { forkCodexUpstreamSession } from "./upstream-session-fork.js";
import { createForkTestRuntime, forkResponse } from "./upstream-session-fork.test-support.js";

vi.mock("openclaw/plugin-sdk/session-catalog", async (importOriginal) => ({
  ...(await importOriginal()),
  deleteSessionUpstreamLink: vi.fn(),
  upsertSessionUpstreamLink: vi.fn(() => true),
}));

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});

function turn(id: string, texts: string[]): CodexTurn {
  const user: CodexThreadItem = {
    id: `${id}-user`,
    type: "userMessage",
    content: texts.map((text) => ({ type: "text", text, text_elements: [] })),
    title: null,
    status: null,
    name: null,
    tool: null,
    server: null,
    command: null,
    cwd: null,
    query: null,
    aggregatedOutput: null,
    text: "",
    changes: [],
  };
  return {
    id,
    status: "completed",
    items: [
      user,
      { ...user, id: `${id}-assistant`, type: "agentMessage", content: [], text: "Answer" },
    ],
  };
}

async function importHistory(turns: CodexTurn[], name?: string) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "codex-fork-import-")));
  roots.push(root);
  const target = {
    agentId: "main",
    sessionId: "imported-session",
    sessionKey: "agent:main:imported-session",
    storePath: path.join(root, "openclaw-agent.sqlite"),
  };
  await upsertSessionEntry({
    ...target,
    entry: {
      sessionFile: `sqlite:${target.agentId}:${target.sessionId}:${target.storePath}`,
      sessionId: target.sessionId,
      updatedAt: Date.now(),
      label: name,
    },
  });
  const thread: CodexThread = { id: "thread-source", projectId: null, name, turns };
  const imported = await importCodexThreadHistoryToTranscript({
    ...target,
    thread,
    throughTurnId: turns.at(-1)!.id,
  });
  const entries = await readVisibleSessionTranscriptMessageEntries(target);
  const users = entries.filter((entry) => entry.role === "user");
  const selected = users.at(-1);
  expect(selected).toBeDefined();
  const control = {
    readThread: vi.fn(async () => thread),
    listTurnPage: vi.fn<CodexSessionCatalogControl["listTurnPage"]>(async ({ cursor, limit }) => {
      const allTurns = thread.turns ?? [];
      const offset = Number(cursor ?? 0);
      const next = offset + (limit ?? 100);
      return {
        data: allTurns.slice(offset, next),
        ...(next < allTurns.length ? { nextCursor: String(next) } : {}),
      };
    }),
  } as unknown as CodexSessionCatalogControl;
  return {
    target,
    thread,
    control,
    imported,
    users,
    resolve: () =>
      resolveCodexUpstreamForkBoundary({
        ...target,
        threadId: thread.id,
        entryId: selected!.entryId,
        control,
      }),
  };
}

describe("fork boundaries from imported Codex history", () => {
  it.each([false, true])(
    "forks a named source without inheriting its unique local label (materialized: %s)",
    async (materialized) => {
      const turns = [turn("turn-1", ["one"]), turn("turn-2", ["edit me"])];
      const name = "Native fork verification";
      const history = await importHistory(turns, name);
      const sourceEntry = getSessionEntry(history.target);
      const sourceEntries = await readVisibleSessionTranscriptMessageEntries(history.target);
      const bindingStore = createCodexTestBindingStore();
      const identity = sessionBindingIdentity(history.target);
      const pending = {
        sourceThreadId: history.thread.id,
        connectionFingerprint: "fingerprint",
        lastTurnId: "turn-2",
      };
      await bindingStore.mutate(identity, {
        kind: "set",
        binding: {
          threadId: history.thread.id,
          cwd: "/tmp",
          connectionScope: "supervision",
          supervisionSourceThreadId: history.thread.id,
          preserveNativeModel: true,
          conversationSourceTransferComplete: true,
          pendingSupervisionBranch: pending,
        },
      });
      if (materialized) {
        await bindingStore.mutate(identity, {
          kind: "commit-pending-supervision-branch",
          expected: pending,
          threadId: "thread-canonical",
          patch: {
            appServerRuntimeFingerprint: "fingerprint",
            model: "gpt-5.6-luna",
            modelProvider: "openai",
          },
        });
      }
      const sourceBinding = await bindingStore.read(identity);
      const response = forkResponse();
      const namedResponse = { ...response, thread: { ...response.thread, name } };
      const nativeThreads = new Map<string, CodexThread>([
        [history.thread.id, history.thread],
        // Injected history is absent from the canonical thread's native projection.
        ["thread-canonical", { id: "thread-canonical", projectId: null, turns: [] }],
        [response.thread.id, { ...namedResponse.thread, turns: turns.slice(0, 1) }],
      ]);
      const sourceBefore = structuredClone(nativeThreads);
      const forkThread = vi.fn<CodexSessionCatalogControl["forkThread"]>(async () => namedResponse);
      const archiveThread = vi.fn<CodexSessionCatalogControl["archiveThread"]>(
        async () => undefined,
      );
      const control: CodexSessionCatalogControl = {
        ...history.control,
        connectionFingerprint: "fingerprint",
        withPinnedConnection: async (run) => await run(control),
        forkThread,
        archiveThread,
        readThread: async (threadId) => nativeThreads.get(threadId)!,
        listTurnPage: async ({ threadId }) => ({ data: nativeThreads.get(threadId)!.turns ?? [] }),
      };
      const runtime = createForkTestRuntime(history.target.storePath);
      const createSession = vi.mocked(runtime.agent.session.createSessionEntry);
      const targetKey = "agent:main:dashboard:forked";

      const result = await forkCodexUpstreamSession(
        {
          targetKey,
          source: { ...history.target, entryId: history.users.at(-1)!.entryId },
          upstream: {
            catalogId: "codex",
            hostId: "gateway:local",
            kind: "codex-app-server",
            threadId: history.thread.id,
            ref: { connectionFingerprint: "fingerprint" },
          },
        },
        {
          bindingStore,
          controlFactory: {
            forRequest: () => control,
            forUpstream: () => control,
            homesForAgent: () => [],
          },
          harnessRuntimeId: "codex",
          resolveConfig: () => ({ session: { store: history.target.storePath } }),
          runtime,
        },
      );
      const child = await createSession.mock.results[0]!.value;
      expect(result).toEqual({ status: "created", key: targetKey, editorText: "edit me" });

      expect(forkThread).toHaveBeenCalledExactlyOnceWith({
        threadId: history.thread.id,
        beforeTurnId: "turn-2",
        excludeTurns: true,
      });
      expect(child.entry.label).toBeUndefined();
      expect(createSession.mock.calls[0]?.[0]).not.toHaveProperty("label");
      expect(createSession.mock.calls[0]?.[0]).not.toHaveProperty("displayName");
      const childEntries = await readVisibleSessionTranscriptMessageEntries({
        ...history.target,
        sessionId: child.sessionId,
        sessionKey: child.key,
      });
      expect(childEntries.map((entry) => entry.role)).toEqual(["user", "assistant"]);
      expect(
        childEntries.filter((entry) => entry.role === "user").map((entry) => entry.message),
      ).toEqual([expect.objectContaining({ content: "one" })]);
      expect(await bindingStore.read(identity)).toEqual(sourceBinding);
      expect(getSessionEntry(history.target)).toEqual(sourceEntry);
      expect(getSessionEntry(history.target)?.label).toBe(name);
      expect(await readVisibleSessionTranscriptMessageEntries(history.target)).toEqual(
        sourceEntries,
      );
      expect(namedResponse.thread.name).toBe(name);
      expect(nativeThreads).toEqual(sourceBefore);
      expect(archiveThread).not.toHaveBeenCalled();
    },
  );

  it.each([
    { label: "surrounding whitespace", texts: ["  first question \n"] },
    { label: "multiple text blocks", texts: ["first block", "second block"] },
    { label: "per-message UTF-8 budget", texts: ["🦞".repeat(20_000)] },
  ])("matches unchanged imported $label", async ({ texts }) => {
    const history = await importHistory([turn("turn-1", texts), turn("turn-2", ["edit me"])]);

    await expect(history.resolve()).resolves.toEqual({
      ok: true,
      editorText: "edit me",
      boundary: {
        beforeTurnId: "turn-2",
        targetTurnId: "turn-2",
        retainedMarker: { turnId: "turn-1", userMessageCount: 1 },
      },
    });
  });

  it.each([
    { label: "message count", count: 105, text: "same question" },
    { label: "total UTF-8 bytes", count: 12, text: "🦞".repeat(16_000) },
  ])(
    "selects the original turn after the $label cap drops an identical-text prefix",
    async ({ count, text }) => {
      // Repeated text makes ordinal misalignment select the wrong valid turn rather than reject.
      const history = await importHistory(
        Array.from({ length: count }, (_, index) => turn(`turn-${index}`, [text])),
      );
      expect(history.imported.omittedMessages).toBeGreaterThan(0);
      expect(history.users.length).toBeLessThan(count);

      await expect(history.resolve()).resolves.toEqual({
        ok: true,
        editorText: text,
        boundary: {
          beforeTurnId: `turn-${count - 1}`,
          targetTurnId: `turn-${count - 1}`,
          retainedMarker: { turnId: `turn-${count - 2}`, userMessageCount: 1 },
        },
      });
    },
  );

  it("rejects upstream prefix drift after import even when message identities and target match", async () => {
    const turns = [turn("turn-1", ["original question"]), turn("turn-2", ["edit me"])];
    const history = await importHistory(turns);
    turns[0] = turn("turn-1", ["changed question"]);

    await expect(history.resolve()).resolves.toMatchObject({
      ok: false,
      code: "drift-mismatch",
    });
  });

  it("emits real catalog user text from native content alongside bounded attachment display", () => {
    const item = turn("turn-1", ["  Native user prompt  ", "second block"]).items[0]!;
    expect(toGenericTranscriptItem(item)).toMatchObject({
      type: "userMessage",
      text: "Native user prompt\nsecond block",
    });
    const attachment = {
      ...item,
      content: [{ type: "localImage", path: "/private/image.png" }],
    };
    expect(toGenericTranscriptItem(attachment).text).toBe("[Image attachment]");
  });
});
