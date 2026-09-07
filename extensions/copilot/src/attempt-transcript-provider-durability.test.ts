import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupAttemptTranscriptJournalFixtures,
  createFixture,
  event,
} from "./attempt-transcript-journal.test-helpers.js";
import { buildSuspendableToolResultMessage } from "./event-bridge-transcript.js";

const commitPrefix = vi.hoisted(() => vi.fn());

vi.mock("./provider-transcript-commit.js", () => ({
  commitProviderSessionTranscriptPrefix: commitPrefix,
}));

afterEach(async () => {
  commitPrefix.mockReset();
  await cleanupAttemptTranscriptJournalFixtures();
});

async function persistMixedProviderGroup() {
  const fixture = await createFixture();
  await fixture.journal.persistInitialUser();
  fixture.session.emit(event("user.message", "initial-user", { content: "inspect both files" }));
  fixture.session.emit(
    event("assistant.message", "assistant-mixed", {
      content: "checking",
      messageId: "assistant-mixed",
      toolRequests: [
        {
          arguments: { first: 1, second: 2 },
          name: "exec",
          toolCallId: "exec-waiting",
        },
        { arguments: {}, name: "computer", toolCallId: "computer-1" },
      ],
    }),
  );
  fixture.session.emit(
    event("tool.execution_complete", "computer-result", {
      result: { content: "frame" },
      success: true,
      toolCallId: "computer-1",
    }),
  );
  const receipt = fixture.journal.recordProviderToolResult({
    role: "toolResult",
    toolCallId: "exec-waiting",
    toolName: "exec",
    content: [{ type: "text", text: "waiting" }],
    details: { status: "waiting" },
    isError: false,
  });
  await fixture.journal.barrier("mixed provider group");
  await expect(receipt).resolves.toBeUndefined();
  return fixture;
}

describe("Copilot provider transcript durability", () => {
  it("commits one canonical assistant/result group for an outer waiting result", async () => {
    commitPrefix.mockImplementation(
      async (
        _hostCapabilities: unknown,
        { entries }: { entries: Array<{ message: AgentMessage }> },
      ) => ({
        kind: "committed",
        results: entries.map((entry, index) => ({
          anchor: { entryId: `event-${index}`, idempotencyKey: `key-${index}`, messageSeq: index },
          message: entry.message,
        })),
      }),
    );
    const { journal, session } = await createFixture();
    await journal.persistInitialUser();
    session.emit(event("user.message", "initial-user", { content: "pause" }));
    session.emit(
      event("assistant.message", "assistant-waiting", {
        content: "",
        messageId: "assistant-waiting",
        toolRequests: [{ arguments: {}, name: "exec", toolCallId: "exec-waiting-1" }],
      }),
    );

    const waitingMessage = buildSuspendableToolResultMessage({
      providerResult: { resultType: "success", textResultForLlm: "waiting" },
      result: {
        content: [{ type: "text", text: "outer result" }],
        details: { runId: "run-waiting-1", status: "waiting" },
      },
      startedAt: 2,
      toolCallId: "exec-waiting-1",
      toolName: "exec",
    });
    expect(waitingMessage.details).toEqual({
      runId: "run-waiting-1",
      status: "waiting",
    });
    expect(waitingMessage.details).not.toHaveProperty("details");
    expect(
      buildSuspendableToolResultMessage({
        providerResult: { resultType: "success", textResultForLlm: "done" },
        result: { content: [{ type: "text", text: "done" }] },
        startedAt: 2,
        toolCallId: "exec-complete-1",
        toolName: "exec",
      }),
    ).not.toHaveProperty("details");
    const receipt = journal.recordProviderToolResult(waitingMessage);
    session.emit(
      event("tool.execution_complete", "sdk-duplicate", {
        result: { content: "waiting" },
        success: true,
        toolCallId: "exec-waiting-1",
      }),
    );

    expect(commitPrefix).not.toHaveBeenCalled();
    await journal.barrier("waiting result");
    await expect(receipt).resolves.toBeUndefined();
    expect(commitPrefix).toHaveBeenCalledOnce();
    expect(commitPrefix.mock.calls[0]?.[1].assertCurrent).toEqual(expect.any(Function));
    expect(
      commitPrefix.mock.calls[0]?.[1].entries.map(
        (entry: { message: AgentMessage }) => entry.message.role,
      ),
    ).toEqual(["assistant", "toolResult"]);
    const committedResult = commitPrefix.mock.calls[0]?.[1].entries.at(-1)?.message;
    expect(committedResult).toMatchObject({
      details: { runId: "run-waiting-1", status: "waiting" },
      role: "toolResult",
    });
    expect(committedResult?.details).not.toHaveProperty("details");
    expect(journal.snapshot().messagesSnapshot.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
    ]);
  });

  it("commits concurrent completions in the assistant's declared order", async () => {
    commitPrefix.mockImplementation(
      async (
        _hostCapabilities: unknown,
        { entries }: { entries: Array<{ message: AgentMessage }> },
      ) => ({
        kind: "committed",
        results: entries.map((entry, index) => ({
          anchor: { entryId: `event-${index}` },
          message: entry.message,
        })),
      }),
    );
    const { journal, session } = await createFixture();
    await journal.persistInitialUser();
    session.emit(event("user.message", "initial-user", { content: "pause" }));
    session.emit(
      event("assistant.message", "assistant-mixed", {
        content: "",
        messageId: "assistant-mixed",
        toolRequests: [
          { arguments: {}, name: "exec", toolCallId: "exec-waiting" },
          { arguments: {}, name: "computer", toolCallId: "computer-1" },
        ],
      }),
    );
    session.emit(
      event("tool.execution_complete", "computer-result", {
        result: { content: "frame" },
        success: true,
        toolCallId: "computer-1",
      }),
    );
    const receipt = journal.recordProviderToolResult({
      role: "toolResult",
      toolCallId: "exec-waiting",
      toolName: "exec",
      content: [{ type: "text", text: "waiting" }],
      details: { status: "waiting" },
      isError: false,
    });
    await journal.barrier("mixed group");
    await expect(receipt).resolves.toBeUndefined();

    expect(commitPrefix).toHaveBeenCalledOnce();
    expect(
      commitPrefix.mock.calls[0]?.[1].entries.map(
        (entry: { message: AgentMessage }) => entry.message.role,
      ),
    ).toEqual(["assistant", "toolResult", "toolResult"]);
    expect(
      commitPrefix.mock.calls[0]?.[1].entries.map((entry: { message: AgentMessage }) =>
        entry.message.role === "toolResult" ? entry.message.toolCallId : "assistant",
      ),
    ).toEqual(["assistant", "exec-waiting", "computer-1"]);
    const commit = commitPrefix.mock.calls[0]?.[1];
    const prepared = commit.entries.map((entry: { message: AgentMessage }) => entry.message);
    expect(commit.validatePreparedPrefix(prepared)).toBe(true);
    expect(
      commit.validatePreparedPrefix(
        prepared.map((message: AgentMessage) =>
          message.role === "toolResult"
            ? { ...message, content: [{ type: "text", text: "redacted" }] }
            : message,
        ),
      ),
    ).toBe(true);
    expect(commit.validatePreparedPrefix(prepared.slice(0, -1))).toBe(false);
    expect(commit.validatePreparedPrefix([prepared[0], prepared[2], prepared[1]])).toBe(false);
    const changedAssistantId = structuredClone(prepared);
    const assistant = changedAssistantId[0];
    if (assistant?.role === "assistant") {
      const call = assistant.content.find((part) => part.type === "toolCall");
      if (call?.type === "toolCall") {
        call.id = "changed-call";
      }
    }
    expect(commit.validatePreparedPrefix(changedAssistantId)).toBe(false);
    const changedResultId = structuredClone(prepared);
    const result = changedResultId[1];
    if (result?.role === "toolResult") {
      result.toolCallId = "changed-call";
    }
    expect(commit.validatePreparedPrefix(changedResultId)).toBe(false);
  });

  describe.each(["committed", "replayed"] as const)("%s provider payload", (kind) => {
    it.each([
      [
        "assistant content",
        (messages: AgentMessage[]) => {
          const assistant = messages.find((message) => message.role === "assistant");
          if (assistant?.role === "assistant") {
            const text = assistant.content.find((part) => part.type === "text");
            if (text?.type === "text") {
              text.text = "rewritten";
            }
          }
          return messages;
        },
      ],
      [
        "tool result content",
        (messages: AgentMessage[]) => {
          const result = messages.find(
            (message) => message.role === "toolResult" && message.toolCallId === "exec-waiting",
          );
          if (result?.role === "toolResult") {
            result.content = [{ type: "text", text: "rewritten" }];
          }
          return messages;
        },
      ],
      [
        "tool arguments",
        (messages: AgentMessage[]) => {
          const assistant = messages.find((message) => message.role === "assistant");
          if (assistant?.role === "assistant") {
            const call = assistant.content.find(
              (part) => part.type === "toolCall" && part.id === "exec-waiting",
            );
            if (call?.type === "toolCall") {
              call.arguments = { first: 9, second: 2 };
            }
          }
          return messages;
        },
      ],
      [
        "tool identity",
        (messages: AgentMessage[]) => {
          const result = messages.find(
            (message) => message.role === "toolResult" && message.toolCallId === "exec-waiting",
          );
          if (result?.role === "toolResult") {
            result.toolCallId = "changed-call";
          }
          return messages;
        },
      ],
      ["message order", (messages: AgentMessage[]) => [messages[0]!, messages[2]!, messages[1]!]],
    ])("resolves durability but invalidates replay after %s drift", async (_label, mutate) => {
      commitPrefix.mockImplementation(
        async (
          _hostCapabilities: unknown,
          { entries }: { entries: Array<{ message: AgentMessage }> },
        ) => ({
          kind,
          results: mutate(entries.map((entry) => entry.message)).map((message, index) => ({
            anchor: { entryId: `event-${index}` },
            message,
          })),
        }),
      );

      const { journal } = await persistMixedProviderGroup();

      expect(journal.snapshot().replayInvalid).toBe(true);
    });
  });

  it.each(["committed", "replayed"] as const)(
    "keeps %s provider replay valid for cloned key order and private metadata",
    async (kind) => {
      commitPrefix.mockImplementation(
        async (
          _hostCapabilities: unknown,
          { entries }: { entries: Array<{ message: AgentMessage }> },
        ) => ({
          kind,
          results: entries.map((entry, index) => {
            const message = structuredClone(entry.message);
            const reordered =
              message.role === "assistant"
                ? ({
                    __openclaw: { privateReceipt: "ignored" },
                    ...message,
                    content: message.content.map((part) =>
                      part.type === "toolCall" && part.id === "exec-waiting"
                        ? { ...part, arguments: { second: 2, first: 1 } }
                        : structuredClone(part),
                    ),
                  } as AgentMessage)
                : ({
                    __openclaw: { privateReceipt: "ignored" },
                    ...message,
                    ...(message.role === "toolResult"
                      ? { details: { privateReceipt: "ignored" } }
                      : {}),
                  } as AgentMessage);
            return { anchor: { entryId: `event-${index}` }, message: reordered };
          }),
        }),
      );

      const { journal } = await persistMixedProviderGroup();

      expect(journal.snapshot().replayInvalid).toBe(false);
    },
  );

  it("rejects a malformed provider replay message", async () => {
    commitPrefix.mockResolvedValue({
      kind: "replayed",
      results: [{ anchor: { entryId: "malformed" }, message: { role: "toolResult" } }],
    });
    const { journal, session } = await createFixture();
    await journal.persistInitialUser();
    session.emit(event("user.message", "initial-user", { content: "pause" }));
    session.emit(
      event("assistant.message", "assistant-malformed", {
        content: "",
        messageId: "assistant-malformed",
        toolRequests: [{ arguments: {}, name: "exec", toolCallId: "exec-malformed" }],
      }),
    );
    const receipt = journal
      .recordProviderToolResult({
        role: "toolResult",
        toolCallId: "exec-malformed",
        toolName: "exec",
        content: [{ type: "text", text: "waiting" }],
        details: { status: "waiting" },
        isError: false,
      })
      .catch((error: unknown) => error);

    await expect(journal.barrier("malformed replay")).rejects.toThrow(
      "replayed an invalid message",
    );
    await expect(receipt).resolves.toBeInstanceOf(Error);
  });

  it("rejects every late provider receipt with the original commit failure", async () => {
    const failure = new Error("injected provider commit failure");
    commitPrefix.mockRejectedValue(failure);
    const { journal, session } = await createFixture();
    await journal.persistInitialUser();
    session.emit(event("user.message", "initial-user", { content: "pause" }));
    session.emit(
      event("assistant.message", "assistant-failed", {
        content: "",
        messageId: "assistant-failed",
        toolRequests: [{ arguments: {}, name: "exec", toolCallId: "exec-failed" }],
      }),
    );
    const receipt = journal.recordProviderToolResult({
      role: "toolResult",
      toolCallId: "exec-failed",
      toolName: "exec",
      content: [{ type: "text", text: "waiting" }],
      details: { status: "waiting" },
      isError: false,
    });
    const rejectedReceipt = receipt.catch((error: unknown) => error);

    await expect(journal.barrier("final response")).rejects.toThrow(
      "injected provider commit failure",
    );
    await expect(rejectedReceipt).resolves.toBe(failure);
    const lateMessage = {
      role: "toolResult" as const,
      toolCallId: "exec-failed",
      toolName: "exec",
      content: [{ type: "text" as const, text: "late waiting" }],
      details: { status: "waiting" },
      isError: false,
    };
    await expect(
      Promise.all([
        journal.recordProviderToolResult(lateMessage).catch((error: unknown) => error),
        journal.recordProviderToolResult(lateMessage).catch((error: unknown) => error),
      ]),
    ).resolves.toEqual([failure, failure]);
    expect(commitPrefix).toHaveBeenCalledOnce();
  });
});
