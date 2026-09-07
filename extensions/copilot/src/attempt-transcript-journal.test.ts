import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SessionEvent } from "@github/copilot-sdk";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/hook-runtime";
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { readSessionTranscriptEvents } from "openclaw/plugin-sdk/session-transcript-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupAttemptTranscriptJournalFixtures,
  createFixture,
  createJournalSession,
  emitReplayGroup,
  event,
  transcriptMessages,
} from "./attempt-transcript-journal.test-helpers.js";

afterEach(async () => {
  resetGlobalHookRunner();
  vi.restoreAllMocks();
  await cleanupAttemptTranscriptJournalFixtures();
});

describe("Copilot attempt transcript journal", () => {
  it("prepares standalone media after hooks without claiming user or tool-group media", async () => {
    const sourceText = "Artifacts ready\nMEDIA:./artifact.json";
    const rewrittenText = `${sourceText}\nMEDIA:./hook-only.json`;
    const prepareAssistantTranscriptMessage = vi.fn((message: AssistantMessage) => ({
      ...message,
      openclawDelivery: { mediaUrls: ["./artifact.json"] },
    }));
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_message_write",
          handler: (input: unknown) => {
            const message = (input as { message: AgentMessage }).message;
            return message.role === "assistant" &&
              message.content.some((part) => part.type === "text" && part.text === sourceText)
              ? { message: { ...message, content: [{ type: "text", text: rewrittenText }] } }
              : undefined;
          },
        },
      ]),
    );
    const { attempt, journal, recorder, session, target } = await createFixture();
    Object.assign(attempt, { prepareAssistantTranscriptMessage });
    recorder.resolveMessage.mockResolvedValue({ role: "user", content: sourceText, timestamp: 1 });
    await journal.persistInitialUser();
    session.emit(event("user.message", "initial-user", { content: sourceText }));
    session.emit(
      event("assistant.message", "tool-assistant", {
        content: "MEDIA:./tool-only.json",
        messageId: "tool-assistant",
        toolRequests: [{ arguments: {}, name: "read", toolCallId: "call-1" }],
      }),
    );
    session.emit(
      event("tool.execution_complete", "tool-result", {
        result: { content: "done" },
        success: true,
        toolCallId: "call-1",
      }),
    );
    session.emit(
      event("assistant.message", "final-assistant", {
        content: sourceText,
        messageId: "final-assistant",
      }),
    );
    await journal.barrier("media preparation");

    expect(prepareAssistantTranscriptMessage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ content: [{ type: "text", text: rewrittenText }] }),
      sourceText,
    );
    const persisted = transcriptMessages(await readSessionTranscriptEvents(target)).map(
      (row) => row.message,
    );
    expect(persisted.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
    ]);
    expect(persisted[0]).toMatchObject({ role: "user", content: sourceText });
    expect(persisted.slice(0, -1).some((message) => "openclawDelivery" in message)).toBe(false);
    expect(persisted.at(-1)).toMatchObject({
      content: [{ type: "text", text: rewrittenText }],
      openclawDelivery: { mediaUrls: ["./artifact.json"] },
      idempotencyKey: "copilot-sdk:sdk-session:final-assistant",
    });
    expect(journal.snapshot().messagesSnapshot).toEqual(persisted);
  });

  it("drains work appended after a barrier starts waiting", async () => {
    const { journal, session } = await createFixture();
    await journal.persistInitialUser();
    session.emit(event("user.message", "initial-user", { content: "inspect both files" }));
    session.emit(
      event("assistant.message", "assistant-before-barrier", {
        content: "first",
        messageId: "assistant-before-barrier",
      }),
    );

    const waiting = journal.barrier("concurrent event");
    queueMicrotask(() => {
      session.emit(
        event("assistant.message", "assistant-after-barrier", {
          content: "second",
          messageId: "assistant-after-barrier",
        }),
      );
    });
    await waiting;

    expect(journal.snapshot().messagesSnapshot.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "assistant",
    ]);
  });

  it("gives a queued tool completion one grace turn before failing the barrier", async () => {
    const { journal, session } = await createFixture();
    await journal.persistInitialUser();
    session.emit(event("user.message", "initial-user", { content: "inspect both files" }));
    session.emit(
      event("assistant.message", "assistant-tools", {
        content: "checking",
        messageId: "assistant-tools",
        toolRequests: [{ arguments: {}, name: "read", toolCallId: "call-1" }],
      }),
    );

    const waiting = journal.barrier("queued tool result");
    queueMicrotask(() => {
      session.emit(
        event("tool.execution_complete", "tool-result", {
          result: { content: "done" },
          success: true,
          toolCallId: "call-1",
        }),
      );
    });
    await waiting;

    expect(journal.snapshot().messagesSnapshot.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
    ]);
  });

  it("replaces the originally staged user when async resolution changes it", async () => {
    const { journal, recorder } = await createFixture();
    recorder.resolveMessage.mockResolvedValue({
      role: "user",
      content: "resolved user",
      timestamp: 2,
    });

    await journal.persistInitialUser();

    expect(journal.snapshot().messagesSnapshot).toMatchObject([
      { role: "user", content: "resolved user" },
    ]);
  });

  it("publishes the storage anchor without treating a replay as a fresh user append", async () => {
    const { journal, recorder } = await createFixture();

    await journal.persistInitialUser();

    const anchor = recorder.markRuntimePersisted.mock.calls[0]?.[1];
    expect(anchor).toBeDefined();
    expect(journal.snapshot().terminalAnchor).toEqual(anchor);
    expect(recorder.getAdmissionReceipt()).toEqual({
      ...anchor,
      logicalTurnId: "logical-turn-1",
      role: "user",
    });
    await journal.persistInitialUser();
    expect(recorder.markRuntimePersisted.mock.calls.map((call) => call[2])).toEqual([
      { appended: true },
      { appended: false },
    ]);
  });

  it.each(["unchanged", "sdk-rewrite", "hook-rewrite", "hook-metadata"] as const)(
    "keeps selected steering mentions only on unchanged committed text (%s)",
    async (rewrite) => {
      const { journal, recorder, session, target } = await createFixture();
      await journal.persistInitialUser();
      session.emit(event("user.message", "initial-user", { content: "inspect both files" }));
      const mentions = [{ profileId: "profile-taylor", start: 3, end: 10 }];
      const sourceMessage = {
        role: "user" as const,
        content: "Hi @Taylor",
        timestamp: 3,
        provenance: { kind: "external_user" as const },
        __openclaw: { humanMentions: mentions },
      };
      const sourceRecorder = {
        ...recorder,
        message: sourceMessage,
        resolveMessage: vi.fn(async () => sourceMessage),
        markRuntimePersisted: vi.fn(),
      };
      initializeGlobalHookRunner(
        createMockPluginRegistry([
          {
            hookName: "before_message_write",
            handler: (input: unknown) => {
              const message = (input as { message: AgentMessage }).message;
              if (rewrite === "hook-rewrite") {
                Object.assign(message, { content: "Changed @Taylor" });
              }
              if (rewrite === "hook-metadata") {
                Object.assign(message, {
                  __openclaw: {
                    humanMentions: [{ profileId: "profile-other", start: 3, end: 10 }],
                  },
                });
              }
              return { message };
            },
          },
        ]),
      );

      await journal.sendSdkUser(async () => "selected-steering", sourceRecorder);
      session.emit(
        event("user.message", "selected-steering", {
          content: rewrite === "sdk-rewrite" ? "Changed @Taylor" : sourceMessage.content,
        }),
      );
      await journal.waitForSdkUserPersisted("selected-steering");

      const persisted = transcriptMessages(await readSessionTranscriptEvents(target)).at(-1);
      const contentChanged = rewrite === "sdk-rewrite" || rewrite === "hook-rewrite";
      expect(persisted?.message).toMatchObject({
        role: "user",
        content: contentChanged ? "Changed @Taylor" : sourceMessage.content,
        provenance: sourceMessage.provenance,
      });
      if (contentChanged) {
        expect(persisted?.message).not.toHaveProperty("__openclaw.humanMentions");
      } else {
        expect(persisted?.message).toHaveProperty("__openclaw.humanMentions", mentions);
      }
      expect(sourceRecorder.markRuntimePersisted).toHaveBeenCalledExactlyOnceWith(
        persisted?.message,
        expect.objectContaining({ entryId: "selected-steering" }),
        { appended: true },
      );
    },
  );

  it("removes the originally staged user when its resolved replacement is blocked", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_message_write",
          handler: (input: unknown) =>
            (input as { message: AgentMessage }).message.role === "user"
              ? { block: true }
              : undefined,
        },
      ]),
    );
    const { journal, recorder } = await createFixture();
    recorder.resolveMessage.mockResolvedValue({
      role: "user",
      content: "blocked resolved user",
      timestamp: 2,
    });

    await journal.persistInitialUser();

    expect(journal.snapshot()).toMatchObject({ messagesSnapshot: [], replayInvalid: true });
    expect(recorder.markBlocked).toHaveBeenCalledOnce();
  });

  it("marks an already-blocked initial user replay-incomplete", async () => {
    const { journal, recorder } = await createFixture();
    recorder.markBlocked();

    await journal.persistInitialUser();

    expect(journal.snapshot()).toMatchObject({ messagesSnapshot: [], replayInvalid: true });
  });

  it("marks empty transformed user content replay-incomplete", async () => {
    const { journal, session } = await createFixture();
    await journal.persistInitialUser();
    session.emit(
      event("user.message", "transformed-empty-user", {
        content: "provider-visible original",
        transformedContent: "",
      }),
    );

    await journal.barrier("empty transformed user");

    expect(journal.snapshot().replayInvalid).toBe(true);
  });

  it("marks a mismatched initial SDK user replay-incomplete", async () => {
    const { journal, session } = await createFixture();
    await journal.persistInitialUser();
    session.emit(
      event("user.message", "mismatched-initial-user", { content: "provider saw different" }),
    );
    await journal.barrier("mismatched initial user");

    expect(journal.snapshot().replayInvalid).toBe(true);
  });

  it("marks non-interactive SDK user modes replay-incomplete", async () => {
    const { journal, session } = await createFixture();
    await journal.persistInitialUser();
    session.emit(
      event("user.message", "plan-user", {
        agentMode: "plan",
        content: "inspect both files",
      }),
    );
    await journal.barrier("plan user");

    expect(journal.snapshot().replayInvalid).toBe(true);
  });

  it("marks durable system and developer prompts replay-incomplete", async () => {
    for (const role of ["system", "developer"] as const) {
      const { journal, session } = await createFixture();
      await journal.persistInitialUser();
      session.emit(event("system.message", `${role}-message`, { content: "injected", role }));

      await journal.barrier(`${role} message`);

      expect(journal.snapshot().replayInvalid).toBe(true);
    }
  });

  it("marks durable skill injection replay-incomplete", async () => {
    const { journal, session } = await createFixture();
    await journal.persistInitialUser();
    session.emit(
      event("skill.invoked", "skill-invoked", {
        content: "full injected skill content",
        name: "example-skill",
        path: "/skills/example/SKILL.md",
      }),
    );
    await journal.barrier("skill invocation");

    expect(journal.snapshot().replayInvalid).toBe(true);
  });

  it("marks durable system notifications replay-incomplete", async () => {
    const { journal, session } = await createFixture();
    await journal.persistInitialUser();
    session.emit(
      event("system.notification", "system-notification", { content: "background task done" }),
    );
    await journal.barrier("system notification");

    expect(journal.snapshot().replayInvalid).toBe(true);
  });

  it("marks orphaned durable reasoning replay-incomplete at terminal flush", async () => {
    const { bridge, journal, session, target } = await createFixture();
    await journal.persistInitialUser();
    session.emit(
      event("assistant.reasoning", "orphaned-reasoning", {
        content: "durable thinking without a message",
        reasoningId: "reasoning-1",
      }),
    );
    bridge.flushTranscriptProjection();
    session.emit(
      event("assistant.message", "next-assistant", {
        content: "next turn",
        messageId: "next-assistant",
      }),
    );
    await journal.barrier("orphaned reasoning");

    expect(journal.snapshot().replayInvalid).toBe(true);
    const assistant = transcriptMessages(await readSessionTranscriptEvents(target)).find(
      (row) => row.message.role === "assistant",
    )?.message;
    expect(assistant).toMatchObject({
      content: [{ type: "text", text: "next turn" }],
    });
  });

  it("marks a hook-suppressed standalone assistant replay-incomplete", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_message_write",
          handler: (input: unknown) =>
            (input as { message: AgentMessage }).message.role === "assistant"
              ? { block: true }
              : undefined,
        },
      ]),
    );
    const { journal, session, target } = await createFixture();
    await journal.persistInitialUser();
    session.emit(event("user.message", "initial-user", { content: "inspect" }));
    session.emit(
      event("assistant.message", "blocked-assistant", {
        content: "provider-visible response",
        messageId: "blocked-assistant",
      }),
    );
    await journal.barrier("blocked assistant");

    expect(journal.snapshot().replayInvalid).toBe(true);
    expect(
      transcriptMessages(await readSessionTranscriptEvents(target)).map((row) => row.message.role),
    ).toEqual(["user"]);
  });

  it("marks replay incomplete when a hook rewrites provider-visible assistant content", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_message_write",
          handler: (input: unknown) => {
            const message = (input as { message: AgentMessage }).message;
            if (message.role !== "assistant") {
              return undefined;
            }
            const first = message.content[0];
            if (first?.type === "text") {
              first.text = "redacted";
            }
            return { message };
          },
        },
      ]),
    );
    const { journal, session } = await createFixture();
    await journal.persistInitialUser();
    session.emit(event("user.message", "initial-user", { content: "inspect" }));
    session.emit(
      event("assistant.message", "rewritten-content", {
        content: "provider-visible response",
        messageId: "rewritten-content",
      }),
    );
    await journal.barrier("rewritten content");

    expect(journal.snapshot().replayInvalid).toBe(true);
  });

  it("keeps replay valid for semantically equal hook payloads with reordered keys", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_message_write",
          handler: (input: unknown) => {
            const message = (input as { message: AgentMessage }).message;
            if (message.role !== "assistant") {
              return undefined;
            }
            return {
              message: {
                ...message,
                content: message.content.map((part) =>
                  part.type === "text" ? { type: "text" as const, text: part.text } : part,
                ),
              },
            };
          },
        },
      ]),
    );
    const { journal, session } = await createFixture();
    await journal.persistInitialUser();
    session.emit(event("user.message", "initial-user", { content: "inspect both files" }));
    session.emit(
      event("assistant.message", "same-content", {
        content: "same",
        messageId: "same-content",
      }),
    );
    await journal.barrier("same semantic content");

    expect(journal.snapshot().replayInvalid).toBe(false);
  });

  it("rejects structurally destructive singleton hook replacements", async () => {
    for (const replacement of [
      { role: "user", content: "changed role", timestamp: 2 } as AgentMessage,
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "injected", name: "read", arguments: {} }],
        provider: "github-copilot",
        model: "gpt-5",
        stopReason: "toolUse",
        timestamp: 2,
      } as AgentMessage,
    ]) {
      resetGlobalHookRunner();
      initializeGlobalHookRunner(
        createMockPluginRegistry([
          {
            hookName: "before_message_write",
            handler: (input: unknown) => {
              const message = (input as { message: AgentMessage }).message;
              if (message.role !== "assistant") {
                return undefined;
              }
              Object.assign(message, replacement);
              return { message };
            },
          },
        ]),
      );
      const { journal, session, target } = await createFixture();
      await journal.persistInitialUser();
      session.emit(event("user.message", "initial-user", { content: "inspect" }));
      session.emit(
        event("assistant.message", "rewritten-assistant", {
          content: "provider-visible response",
          messageId: "rewritten-assistant",
        }),
      );
      await journal.barrier("rewritten assistant");

      expect(journal.snapshot().replayInvalid).toBe(true);
      expect(
        transcriptMessages(await readSessionTranscriptEvents(target)).map(
          (row) => row.message.role,
        ),
      ).toEqual(["user"]);
    }
  });

  it("commits a hidden tool turn to SQLite in assistant request order", async () => {
    const { attempt, bridge, journal, recorder, session, target, tempDir } = await createFixture(
      "memory",
      new Map<string, "network">([["read", "network"]]),
    );
    const prepareAssistantTranscriptMessage = vi.fn((message: AssistantMessage) => message);
    Object.assign(attempt, { prepareAssistantTranscriptMessage });
    await journal.persistInitialUser();
    expect(recorder.markRuntimePersisted).toHaveBeenCalledOnce();

    const initialUser = event("user.message", "sdk-user", { content: "inspect both files" });
    session.emit(initialUser);
    session.emit(
      event("assistant.usage", "prior-usage", {
        apiCallId: "prior-call",
        inputTokens: 50,
        model: "gpt-5",
        outputTokens: 40,
      }),
    );
    const toolAssistant = event("assistant.message", "assistant-tools", {
      content: "checking",
      messageId: "assistant-tools-message",
      model: "gpt-5",
      toolRequests: [
        { arguments: { path: "a" }, name: "read", toolCallId: "call-a" },
        { arguments: { path: "b" }, name: "read", toolCallId: "call-b" },
      ],
    });
    session.emit(toolAssistant);
    session.emit(
      event("tool.execution_start", "start-a", { toolCallId: "call-a", toolName: "read" }),
    );
    session.emit(
      event("tool.execution_start", "start-b", { toolCallId: "call-b", toolName: "read" }),
    );
    session.emit(
      event("tool.execution_complete", "result-b", {
        result: { content: "B", detailedContent: "details B" },
        success: true,
        toolCallId: "call-b",
      }),
    );
    session.emit(
      event("user.message", "steering-user", {
        content: "steer after tools",
        delivery: "steering",
        source: "future-steering-source",
      }),
    );
    session.emit(
      event(
        "tool.execution_complete",
        "result-child",
        {
          result: { content: "child" },
          success: true,
          toolCallId: "child-call",
        },
        "child-1",
      ),
    );
    session.emit({
      ...event("tool.execution_complete", "ephemeral-result-a", {
        result: { content: "transient" },
        success: true,
        toolCallId: "call-a",
      }),
      ephemeral: true,
    } as SessionEvent);
    session.emit(
      event("tool.execution_complete", "result-a", {
        error: { message: "A failed" },
        success: false,
        toolCallId: "call-a",
      }),
    );
    const finalAssistant = event("assistant.message", "assistant-final", {
      content: "finished",
      messageId: "assistant-final-message",
      model: "gpt-5",
    });
    session.emit(finalAssistant);
    bridge.recordSendResult(finalAssistant);
    session.emit(event("session.idle", "idle", {}));
    await journal.barrier("test");

    const rows = transcriptMessages(await readSessionTranscriptEvents(target));
    expect(rows.map((row) => row.message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "toolResult",
      "user",
      "assistant",
    ]);
    expect(rows.map((row) => row.id).slice(1)).toEqual([
      "assistant-tools",
      "result-a",
      "result-b",
      "steering-user",
      "assistant-final",
    ]);
    expect(rows.map((row) => row.parentId).slice(1)).toEqual(
      rows.map((row) => row.id).slice(0, -1),
    );
    expect(rows.every((row) => row.message.display === false)).toBe(true);
    expect(prepareAssistantTranscriptMessage).not.toHaveBeenCalled();
    expect(rows[0]?.message.idempotencyKey).toBe("run-1:user");
    expect(rows[1]?.message).toMatchObject({ usage: { input: 0, output: 0 } });
    expect(rows[5]?.message).toMatchObject({
      content: [{ type: "text", text: "finished" }],
    });
    expect(rows[5]?.message.idempotencyKey).toBe("copilot-sdk:sdk-session:assistant-final");
    expect(rows[2]?.message).toMatchObject({
      isError: true,
      toolCallId: "call-a",
      content: [{ type: "text", text: "A failed" }],
      __openclaw: { resultContentSource: "network" },
    });
    expect(rows[5]?.message).toMatchObject({ __openclaw: { turnTainted: true } });
    expect(journal.snapshot()).toMatchObject({
      assistantTranscriptOwned: true,
      assistantTranscriptIdempotencyKey: "copilot-sdk:sdk-session:assistant-final",
      replayInvalid: false,
    });
    expect(journal.snapshot().messagesSnapshot.map((message) => message.role)).toEqual(
      rows.map((row) => row.message.role),
    );
    const files = await fs.readdir(tempDir, { recursive: true });
    expect(files.some((file) => file.endsWith(".jsonl"))).toBe(false);
  });

  it("groups assistant chunks from one API call before matching tool results", async () => {
    const { bridge, journal, session, target } = await createFixture();
    await journal.persistInitialUser();
    session.emit(event("user.message", "initial-user", { content: "inspect both files" }));
    session.emit(
      event("assistant.message", "assistant-chunk-a", {
        apiCallId: "api-call-1",
        content: "checking ",
        messageId: "assistant-chunk-a",
        reasoningText: "partial reasoning",
        toolRequests: [{ arguments: { path: "a" }, name: "read", toolCallId: "call-a" }],
      }),
    );
    session.emit(
      event("assistant.message", "assistant-chunk-b", {
        apiCallId: "api-call-1",
        content: "now",
        messageId: "assistant-chunk-b",
        reasoningText: "complete reasoning",
      }),
    );
    session.emit(
      event("tool.execution_complete", "result-a", {
        result: { content: "done" },
        success: true,
        toolCallId: "call-a",
      }),
    );
    await journal.barrier("grouped API call");

    const rows = transcriptMessages(await readSessionTranscriptEvents(target));
    expect(rows.map((row) => row.message.role)).toEqual(["user", "assistant", "toolResult"]);
    expect(rows[1]?.message).toMatchObject({
      content: [
        { type: "thinking", thinking: "complete reasoning" },
        { type: "text", text: "checking now" },
        { type: "toolCall", id: "call-a", name: "read", arguments: { path: "a" } },
      ],
      idempotencyKey: "copilot-sdk:sdk-session:assistant-chunk-a",
      stopReason: "toolUse",
    });
    expect(rows[2]?.message).toMatchObject({ toolCallId: "call-a", toolName: "read" });
    expect(journal.snapshot().terminalAnchor?.entryId).toBe(rows[2]?.id);
    expect(
      bridge.buildAssistantMessage({
        modelRef: { api: "openai-responses", id: "gpt-5", provider: "github-copilot" },
        now: () => 3,
      })?.content,
    ).toEqual([
      { type: "thinking", thinking: "complete reasoning" },
      { type: "text", text: "checking now" },
      { type: "toolCall", id: "call-a", name: "read", arguments: { path: "a" } },
    ]);
    expect(journal.snapshot().replayInvalid).toBe(false);
  });

  it("keeps the latest cumulative snapshot for one assistant message id", async () => {
    const { bridge, journal, session, target } = await createFixture();
    await journal.persistInitialUser();
    session.emit(event("user.message", "initial-user", { content: "inspect" }));
    session.emit(
      event("assistant.message", "assistant-snapshot-a", {
        apiCallId: "api-call-snapshot",
        content: "checking",
        messageId: "assistant-snapshot",
      }),
    );
    session.emit(
      event("assistant.message", "assistant-snapshot-b", {
        apiCallId: "api-call-snapshot",
        content: "checking now",
        messageId: "assistant-snapshot",
      }),
    );
    bridge.flushTranscriptProjection();
    await journal.barrier("cumulative assistant snapshot");

    const rows = transcriptMessages(await readSessionTranscriptEvents(target));
    expect(rows.map((row) => row.message.role)).toEqual(["user", "assistant"]);
    expect(rows.filter((row) => row.message.role === "assistant")).toHaveLength(1);
    expect(rows.at(-1)?.message).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "checking now" }],
    });
  });

  it("rejects cumulative assistant snapshots without an API call id", async () => {
    const { bridge, journal, session, target } = await createFixture();
    await journal.persistInitialUser();
    session.emit(event("user.message", "initial-user", { content: "inspect" }));
    session.emit(
      event("assistant.message", "assistant-snapshot-a", {
        content: "checking",
        messageId: "assistant-snapshot",
      }),
    );
    session.emit(
      event("assistant.message", "assistant-snapshot-b", {
        content: "checking now",
        messageId: "assistant-snapshot",
      }),
    );
    bridge.flushTranscriptProjection();
    await journal.barrier("cumulative assistant snapshot without API call id");

    const rows = transcriptMessages(await readSessionTranscriptEvents(target));
    expect(rows.map((row) => row.message.role)).toEqual(["user", "assistant"]);
    expect(rows.at(-1)?.message).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "checking" }],
    });
    expect(
      bridge.buildAssistantMessage({
        modelRef: { api: "openai-responses", id: "gpt-5", provider: "github-copilot" },
        now: () => 3,
      })?.content,
    ).toEqual([{ type: "text", text: "checking now" }]);
    expect(journal.snapshot().replayInvalid).toBe(true);
  });

  it("keeps ephemeral deltas out of the durable assistant row", async () => {
    const { journal, session, target } = await createFixture();
    await journal.persistInitialUser();
    session.emit(event("user.message", "initial-user", { content: "inspect both files" }));
    session.emit({
      ...event("assistant.message_delta", "ephemeral-text", {
        deltaContent: "stream-only text",
        messageId: "stream-only",
      }),
      ephemeral: true,
    } as SessionEvent);
    session.emit({
      ...event("assistant.reasoning_delta", "ephemeral-reasoning", {
        deltaContent: "stream-only reasoning",
        reasoningId: "stream-reasoning",
      }),
      ephemeral: true,
    } as SessionEvent);
    session.emit(
      event("assistant.message", "durable-assistant", {
        content: "visible",
        messageId: "durable-assistant",
      }),
    );
    await journal.barrier("ephemeral deltas");

    const assistant = transcriptMessages(await readSessionTranscriptEvents(target)).find(
      (row) => row.message.role === "assistant",
    )?.message;
    expect(assistant).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "visible" }],
    });
  });

  it("clears prior assistant ownership when the final durable projection is empty", async () => {
    const { bridge, journal, session } = await createFixture();
    await journal.persistInitialUser();
    session.emit(event("user.message", "initial-user", { content: "inspect both files" }));
    session.emit(
      event("assistant.message", "tool-assistant", {
        content: "checking",
        messageId: "tool-assistant",
        toolRequests: [{ arguments: {}, name: "read", toolCallId: "call-1" }],
      }),
    );
    session.emit(
      event("tool.execution_complete", "tool-result", {
        result: { content: "done" },
        success: true,
        toolCallId: "call-1",
      }),
    );
    session.emit({
      ...event("assistant.message_delta", "final-delta", {
        deltaContent: "streamed final",
        messageId: "final-message",
      }),
      ephemeral: true,
    } as SessionEvent);
    session.emit(
      event("assistant.message", "final-empty", {
        content: "",
        messageId: "final-message",
      }),
    );
    bridge.flushTranscriptProjection();
    await journal.barrier("empty final projection");

    expect(journal.snapshot()).toMatchObject({
      assistantTranscriptOwned: false,
      replayInvalid: true,
    });
    expect(
      bridge.buildAssistantMessage({
        modelRef: { api: "openai-responses", id: "gpt-5", provider: "github-copilot" },
        now: () => 3,
      })?.content,
    ).toEqual([{ type: "text", text: "streamed final" }]);
  });

  it("marks unprojected assistant provider round-trip state replay-incomplete", async () => {
    const { journal, session } = await createFixture();
    await journal.persistInitialUser();
    session.emit(event("user.message", "initial-user", { content: "inspect both files" }));
    session.emit(
      event("assistant.message", "assistant-provider-state", {
        apiCallId: "api-call-provider-state",
        content: "",
        messageId: "assistant-provider-state",
        reasoningWireField: "reasoning_content",
        serverTools: { provider: "openai", items: [{ type: "web_search" }] },
      }),
    );
    session.emit(
      event("assistant.usage", "assistant-provider-usage", {
        apiCallId: "api-call-provider-state",
        model: "gpt-5",
        outputTokens: 1,
      }),
    );
    await journal.barrier("provider round-trip state");

    expect(journal.snapshot().replayInvalid).toBe(true);
    expect(journal.snapshot().messagesSnapshot).toMatchObject([{ role: "user" }]);
  });

  it("marks citation-bearing assistant messages replay-incomplete", async () => {
    const { journal, session } = await createFixture();
    await journal.persistInitialUser();
    session.emit(event("user.message", "initial-user", { content: "inspect both files" }));
    session.emit(
      event("assistant.message", "assistant-citations", {
        content: "cited response",
        messageId: "assistant-citations",
        citations: {
          sources: [
            {
              id: "source-1",
              provider: "openai",
              title: "Example source",
              url: "https://example.com/source",
            },
          ],
          spans: [
            {
              endIndex: 5,
              references: [{ sourceId: "source-1" }],
              startIndex: 0,
            },
          ],
        },
      }),
    );
    await journal.barrier("citation-bearing assistant");

    expect(journal.snapshot()).toMatchObject({
      messagesSnapshot: [{ role: "user" }, { role: "assistant" }],
      replayInvalid: true,
    });
  });

  it("marks session-bound encrypted reasoning replay-incomplete", async () => {
    for (const [field, value] of [
      ["encryptedContent", "encrypted-openai-state"],
      ["reasoningOpaque", "opaque-anthropic-state"],
    ] as const) {
      const { journal, session } = await createFixture();
      await journal.persistInitialUser();
      session.emit(event("user.message", `initial-user-${field}`, { content: "inspect" }));
      session.emit(
        event("assistant.message", `assistant-${field}`, {
          apiCallId: `api-call-${field}`,
          content: "",
          messageId: `assistant-${field}`,
          [field]: value,
        }),
      );
      session.emit(
        event("assistant.usage", `assistant-usage-${field}`, {
          apiCallId: `api-call-${field}`,
          model: "gpt-5",
        }),
      );
      await journal.barrier(`session-bound ${field}`);

      expect(journal.snapshot().replayInvalid).toBe(true);
    }
  });

  it("marks custom tool calls replay-incomplete", async () => {
    const { journal, session } = await createFixture();
    await journal.persistInitialUser();
    session.emit(event("user.message", "initial-user", { content: "inspect" }));
    session.emit(
      event("assistant.message", "assistant-custom-tool", {
        content: "run custom tool",
        messageId: "assistant-custom-tool",
        toolRequests: [
          {
            arguments: { input: "value" },
            name: "custom_tool",
            toolCallId: "custom-call",
            type: "custom",
          },
        ],
      }),
    );
    session.emit(
      event("tool.execution_complete", "custom-result", {
        result: { content: "done" },
        success: true,
        toolCallId: "custom-call",
      }),
    );
    await journal.barrier("custom tool group");

    expect(journal.snapshot().replayInvalid).toBe(true);
  });

  it("marks user-requested tools replay-incomplete", async () => {
    const { journal, session } = await createFixture();
    await journal.persistInitialUser();
    session.emit(
      event("tool.user_requested", "user-tool-request", {
        arguments: { path: "a" },
        toolCallId: "user-call",
        toolName: "read",
      }),
    );
    session.emit(
      event("tool.execution_complete", "user-tool-result", {
        result: { content: "done" },
        success: true,
        toolCallId: "user-call",
      }),
    );
    await journal.barrier("user-requested tool");

    expect(journal.snapshot().replayInvalid).toBe(true);
  });

  it("preserves user-requested identity across an ephemeral completion", async () => {
    const { journal, session, target } = await createFixture();
    await journal.persistInitialUser();
    session.emit(
      event("tool.user_requested", "user-tool-request", {
        arguments: { path: "a" },
        toolCallId: "user-call",
        toolName: "read",
      }),
    );
    session.emit({
      ...event("tool.execution_complete", "ephemeral-user-tool-result", {
        result: { content: "partial" },
        success: true,
        toolCallId: "user-call",
      }),
      ephemeral: true,
    } as SessionEvent);
    session.emit(
      event("tool.execution_complete", "durable-user-tool-result", {
        result: { content: "done" },
        success: true,
        toolCallId: "user-call",
      }),
    );
    await journal.barrier("user-requested completion");

    expect(transcriptMessages(await readSessionTranscriptEvents(target))).toHaveLength(1);
    expect(journal.snapshot()).toMatchObject({ replayInvalid: true });
  });

  it("hides autopilot users while preserving unknown SDK source provenance", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_message_write",
          handler: (input: unknown) => {
            const replacement = { ...(input as { message: AgentMessage }).message };
            delete (replacement as { display?: boolean }).display;
            return { message: replacement };
          },
        },
      ]),
    );
    const { journal, session, target } = await createFixture();
    await journal.persistInitialUser();
    session.emit(event("user.message", "initial-user", { content: "inspect both files" }));
    session.emit(
      event("user.message", "autopilot-user", {
        content: "continue",
        attachments: [
          {
            type: "file",
            displayName: "notes.txt",
            mimeType: "text/plain",
            path: "/tmp/notes.txt",
          },
          {
            type: "blob",
            data: "c2VjcmV0LWJ5dGVz",
            displayName: "image.png",
            mimeType: "image/png",
          },
        ],
        isAutopilotContinuation: true,
        source: "future-source-kind",
      }),
    );
    session.emit(
      event("tool.execution_complete", "user-tool-result", {
        isUserRequested: true,
        result: { content: "user tool result" },
        success: true,
        toolCallId: "user-call",
      }),
    );
    session.emit(
      event("user.message", "skill-user", {
        content: "injected skill context",
        source: "skill-pdf",
      }),
    );
    session.emit(
      event("user.message", "unknown-user", {
        content: "unknown source context",
        source: "future-visible-source",
      }),
    );
    await journal.barrier("test");

    const rows = transcriptMessages(await readSessionTranscriptEvents(target));
    expect(rows).toHaveLength(4);
    expect(rows[1]?.message).toMatchObject({
      role: "user",
      content: "continue",
      display: false,
      __openclaw: {
        copilotSource: "future-source-kind",
        media: [{ path: "/tmp/notes.txt", contentType: "text/plain" }],
        copilotAttachments: [
          expect.objectContaining({ type: "file", path: "/tmp/notes.txt" }),
          expect.not.objectContaining({ data: expect.anything() }),
        ],
      },
    });
    expect(rows[2]?.message).toMatchObject({ display: false });
    expect(rows[3]?.message).not.toHaveProperty("display", false);
    expect(rows[3]?.message).toMatchObject({
      __openclaw: { copilotSource: "future-visible-source" },
    });
    expect(journal.snapshot().replayInvalid).toBe(true);
  });

  it("keeps a complete-group prefix when the next group is interrupted", async () => {
    const { journal, session, target } = await createFixture();
    await journal.persistInitialUser();
    session.emit(event("user.message", "initial-user", { content: "inspect both files" }));
    session.emit(
      event("assistant.message", "assistant-complete", {
        content: "first",
        messageId: "assistant-complete",
        toolRequests: [{ arguments: {}, name: "read", toolCallId: "call-complete" }],
      }),
    );
    session.emit(
      event("tool.execution_complete", "result-complete", {
        result: { content: "done" },
        success: true,
        toolCallId: "call-complete",
      }),
    );
    await journal.barrier("complete group");
    session.emit(
      event("assistant.message", "assistant-open", {
        content: "second",
        messageId: "assistant-open",
        toolRequests: [{ arguments: {}, name: "read", toolCallId: "call-open" }],
      }),
    );

    await expect(journal.barrier("abort")).rejects.toMatchObject({
      code: "transcript_persistence_failed",
    });
    const rows = transcriptMessages(await readSessionTranscriptEvents(target));
    expect(rows.map((row) => row.message.role)).toEqual(["user", "assistant", "toolResult"]);
    expect(rows.filter((row) => row.message.role === "assistant")).toHaveLength(1);
    expect(rows.filter((row) => row.message.role === "toolResult")).toHaveLength(1);
  });

  it("suppresses the complete group when one message is authoritatively blocked", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_message_write",
          handler: (input: unknown) =>
            (input as { message: AgentMessage }).message.role === "toolResult"
              ? { block: true }
              : undefined,
        },
      ]),
    );
    const { journal, session, target } = await createFixture();
    await journal.persistInitialUser();
    session.emit(event("user.message", "initial-user", { content: "inspect both files" }));
    session.emit(
      event("assistant.message", "assistant-blocked", {
        content: "checking",
        messageId: "assistant-blocked",
        toolRequests: [{ arguments: {}, name: "read", toolCallId: "call-blocked" }],
      }),
    );
    session.emit(
      event("tool.execution_complete", "result-blocked", {
        result: { content: "secret" },
        success: true,
        toolCallId: "call-blocked",
      }),
    );
    await journal.barrier("blocked group");

    const rows = transcriptMessages(await readSessionTranscriptEvents(target));
    expect(rows.map((row) => row.message.role)).toEqual(["user"]);
    expect(journal.snapshot()).toMatchObject({
      assistantTranscriptOwned: true,
      replayInvalid: true,
    });
  });

  it("does not rerun group hooks for an idempotent replay", async () => {
    const hook = vi.fn(() => undefined);
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_message_write", handler: hook }]),
    );
    const { attempt, journal, session, target } = await createFixture();
    await journal.persistInitialUser();
    emitReplayGroup(session);
    await journal.barrier("first commit");
    expect(hook).toHaveBeenCalledTimes(3);
    const existingMessages = transcriptMessages(await readSessionTranscriptEvents(target)).map(
      (row) => row.message,
    );

    const { session: replaySession, journal: replayJournal } = createJournalSession(
      attempt,
      existingMessages,
    );
    await replayJournal.persistInitialUser();
    emitReplayGroup(replaySession);
    await replayJournal.barrier("replay");

    expect(hook).toHaveBeenCalledTimes(3);
    expect(transcriptMessages(await readSessionTranscriptEvents(target))).toHaveLength(3);
    expect(replayJournal.snapshot().messagesSnapshot).toHaveLength(3);
  });

  it("rolls back the complete group when SQLite fails mid-group", async () => {
    const { journal, session, target, tempDir } = await createFixture();
    await journal.persistInitialUser();
    session.emit(event("user.message", "initial-user", { content: "inspect both files" }));
    const sqliteName = (await fs.readdir(tempDir, { recursive: true })).find((name) =>
      name.endsWith(".sqlite"),
    );
    if (!sqliteName) {
      throw new Error("expected the real SQLite transcript database");
    }
    const database = new DatabaseSync(path.join(tempDir, sqliteName));
    database.exec(`
      CREATE TRIGGER fail_copilot_tool_result
      BEFORE INSERT ON transcript_events
      WHEN NEW.event_json LIKE '%result-failed%'
      BEGIN
        SELECT RAISE(ABORT, 'injected mid-group failure');
      END;
    `);
    database.close();
    session.emit(
      event("assistant.message", "assistant-failed", {
        content: "checking",
        messageId: "assistant-failed",
        toolRequests: [{ arguments: {}, name: "read", toolCallId: "call-failed" }],
      }),
    );
    session.emit(
      event("tool.execution_complete", "result-failed", {
        result: { content: "never committed" },
        success: true,
        toolCallId: "call-failed",
      }),
    );

    await expect(journal.barrier("failed group")).rejects.toThrow("injected mid-group failure");
    expect(
      transcriptMessages(await readSessionTranscriptEvents(target)).map((row) => row.message.role),
    ).toEqual(["user"]);
  });
});
