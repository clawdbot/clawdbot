// Verifies session tool-result guard inserts, truncates, and repairs tool results.

import { expectDefined } from "@openclaw/normalization-core";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createOpenClawReadTool } from "./agent-tools.read.js";
import { createAssistantErrorTranscript } from "./assistant-error-transcript.js";
import { buildExecForegroundResult } from "./bash-tools.exec-support.js";
import { installSessionToolResultGuard } from "./session-tool-result-guard.js";
import { castAgentMessage } from "./test-helpers/agent-message-fixtures.js";
import { redactTranscriptMessage } from "./transcript-redact.js";

type AppendMessage = Parameters<SessionManager["appendMessage"]>[0];

const asAppendMessage = (message: unknown) => message as AppendMessage;

const toolCallMessage = asAppendMessage({
  role: "assistant",
  content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
});

function appendToolResultText(sm: SessionManager, text: string) {
  sm.appendMessage(toolCallMessage);
  sm.appendMessage(
    asAppendMessage({
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "read",
      content: [{ type: "text", text }],
      isError: false,
      timestamp: Date.now(),
    }),
  );
}

function appendAssistantToolCall(
  sm: SessionManager,
  params: { id: string; name: string; withArguments?: boolean },
) {
  // Builds pending tool calls with optional missing arguments for repair cases.
  const toolCall: {
    type: "toolCall";
    id: string;
    name: string;
    arguments?: Record<string, never>;
  } = {
    type: "toolCall",
    id: params.id,
    name: params.name,
  };
  if (params.withArguments !== false) {
    toolCall.arguments = {};
  }
  sm.appendMessage(
    asAppendMessage({
      role: "assistant",
      content: [toolCall],
    }),
  );
}

function getPersistedMessages(sm: SessionManager): AgentMessage[] {
  return sm
    .getEntries()
    .filter((e) => e.type === "message")
    .map((e) => (e as { message: AgentMessage }).message);
}

function expectPersistedRoles(sm: SessionManager, expectedRoles: AgentMessage["role"][]) {
  // Role-order assertions prove where synthetic toolResult messages were inserted.
  const messages = getPersistedMessages(sm);
  expect(messages.map((message) => message.role)).toEqual(expectedRoles);
  return messages;
}

function getToolResultText(messages: AgentMessage[]): string {
  const toolResult = messages.find((m) => m.role === "toolResult") as {
    content: Array<{ type: string; text: string }>;
  };
  if (toolResult === undefined) {
    throw new Error("expected toolResult message");
  }
  const textBlock = toolResult.content.find((b: { type: string }) => b.type === "text") as {
    text: string;
  };
  return textBlock.text;
}

describe("installSessionToolResultGuard", () => {
  it("inserts synthetic toolResult before non-tool message when pending", () => {
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm);

    sm.appendMessage(toolCallMessage);
    sm.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "text", text: "error" }],
        stopReason: "error",
      }),
    );

    const messages = expectPersistedRoles(sm, ["assistant", "toolResult", "assistant"]);
    const synthetic = messages[1] as {
      toolCallId?: string;
      isError?: boolean;
      content?: Array<{ type?: string; text?: string }>;
    };
    expect(synthetic.toolCallId).toBe("call_1");
    expect(synthetic.isError).toBe(true);
    expect(synthetic.content?.[0]?.text).toContain("missing tool result");
  });

  it("flushes pending tool calls when asked explicitly", () => {
    const sm = SessionManager.inMemory();
    const guard = installSessionToolResultGuard(sm);

    sm.appendMessage(toolCallMessage);
    guard.flushPendingToolResults();

    expectPersistedRoles(sm, ["assistant", "toolResult"]);
  });

  it("uses configured text for synthetic tool results", () => {
    const sm = SessionManager.inMemory();
    const guard = installSessionToolResultGuard(sm, {
      missingToolResultText: "aborted",
    });

    sm.appendMessage(toolCallMessage);
    guard.flushPendingToolResults();

    expect(getToolResultText(getPersistedMessages(sm))).toBe("aborted");
  });

  it("clears pending tool calls without inserting synthetic tool results", () => {
    const sm = SessionManager.inMemory();
    const guard = installSessionToolResultGuard(sm);

    sm.appendMessage(toolCallMessage);
    guard.clearPendingToolResults();

    expectPersistedRoles(sm, ["assistant"]);
    expect(guard.getPendingIds()).toStrictEqual([]);
  });

  it("clears pending on user interruption when synthetic tool results are disabled", () => {
    const sm = SessionManager.inMemory();
    const guard = installSessionToolResultGuard(sm, {
      allowSyntheticToolResults: false,
    });

    sm.appendMessage(toolCallMessage);
    sm.appendMessage(
      asAppendMessage({
        role: "user",
        content: "interrupt",
        timestamp: Date.now(),
      }),
    );

    expectPersistedRoles(sm, ["assistant", "user"]);
    expect(guard.getPendingIds()).toStrictEqual([]);
  });

  it("does not add synthetic toolResult when a matching one exists", () => {
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm);

    sm.appendMessage(toolCallMessage);
    sm.appendMessage(
      asAppendMessage({
        role: "toolResult",
        toolCallId: "call_1",
        content: [{ type: "text", text: "ok" }],
        isError: false,
      }),
    );

    expectPersistedRoles(sm, ["assistant", "toolResult"]);
  });

  it("applies count-based truncation wording when persisting oversized tool results", () => {
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm);

    appendToolResultText(sm, "x".repeat(80_000));

    const text = getToolResultText(getPersistedMessages(sm));
    expect(text).toContain("more characters truncated");
    expect(text).toMatch(
      /\[\.\.\. \d+ more characters truncated; rerun with narrower args if needed\]$/,
    );
  });

  it("keeps the exec retention-loss disclosure through the session result cap", () => {
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm, { maxToolResultChars: 4_000 });
    const result = buildExecForegroundResult({
      outcome: {
        status: "completed",
        exitCode: 0,
        exitSignal: null,
        durationMs: 1,
        aggregated: "x".repeat(80_000),
        timedOut: false,
      },
      aggregateOutputDropped: true,
    });
    const content = result.content[0];
    if (!content || content.type !== "text") {
      throw new Error("expected text result");
    }

    appendToolResultText(sm, content.text);

    const text = getToolResultText(getPersistedMessages(sm));
    expect(text).toMatch(
      /^\[earlier output was discarded at the retention cap and cannot be recovered\]/,
    );
    expect(text).toMatch(/\[\.\.\. \d+ more characters truncated/);
  });

  it("honors tiny configured tool-result caps truthfully", () => {
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm, {
      maxToolResultChars: 120,
    });

    appendToolResultText(sm, "x".repeat(80_000));

    const text = getToolResultText(getPersistedMessages(sm));
    expect(text.length).toBeLessThanOrEqual(120);
    expect(text).toContain("truncated");
  });

  it("falls back to the default tool-result cap for non-finite configured caps", () => {
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm, {
      maxToolResultChars: Number.NaN,
    });

    appendToolResultText(sm, "x".repeat(80_000));

    const text = getToolResultText(getPersistedMessages(sm));
    expect(text.length).toBeLessThanOrEqual(16_000);
    expect(text).toContain("truncated");
  });

  it("backfills blank toolResult names from pending tool calls", () => {
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm);

    sm.appendMessage(toolCallMessage);
    sm.appendMessage(
      asAppendMessage({
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "   ",
        content: [{ type: "text", text: "ok" }],
        isError: false,
      }),
    );

    const messages = expectPersistedRoles(sm, ["assistant", "toolResult"]) as Array<{
      role: string;
      toolName?: string;
    }>;
    expect(messages[1]?.toolName).toBe("read");
  });

  it("preserves ordering with multiple tool calls and partial results", () => {
    const sm = SessionManager.inMemory();
    const guard = installSessionToolResultGuard(sm);

    sm.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [
          { type: "toolCall", id: "call_a", name: "one", arguments: {} },
          { type: "toolUse", id: "call_b", name: "two", arguments: {} },
        ],
      }),
    );
    sm.appendMessage(
      asAppendMessage({
        role: "toolResult",
        toolUseId: "call_a",
        content: [{ type: "text", text: "a" }],
        isError: false,
      }),
    );
    sm.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "text", text: "after tools" }],
      }),
    );

    const messages = expectPersistedRoles(sm, [
      "assistant", // tool calls
      "toolResult", // call_a real
      "toolResult", // synthetic for call_b
      "assistant", // text
    ]);
    expect((messages[2] as { toolCallId?: string }).toolCallId).toBe("call_b");
    expect(guard.getPendingIds()).toStrictEqual([]);
  });

  it("flushes pending on guard when no toolResult arrived", () => {
    const sm = SessionManager.inMemory();
    const guard = installSessionToolResultGuard(sm);

    sm.appendMessage(toolCallMessage);
    sm.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "text", text: "hard error" }],
        stopReason: "error",
      }),
    );
    expect(guard.getPendingIds()).toStrictEqual([]);
  });

  it("handles toolUseId on toolResult", () => {
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm);

    sm.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "toolUse", id: "use_1", name: "f", arguments: {} }],
      }),
    );
    sm.appendMessage(
      asAppendMessage({
        role: "toolResult",
        toolUseId: "use_1",
        content: [{ type: "text", text: "ok" }],
      }),
    );

    expectPersistedRoles(sm, ["assistant", "toolResult"]);
  });

  it("preserves opaque canonical tool-call ids while repairing result metadata", () => {
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm);

    sm.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: " opaque-call ", name: "read", arguments: {} }],
      }),
    );
    sm.appendMessage(
      asAppendMessage({
        role: "toolResult",
        toolCallId: " opaque-call ",
        content: [{ type: "text", text: "ok" }],
        isError: false,
      }),
    );

    const messages = expectPersistedRoles(sm, ["assistant", "toolResult"]);
    expect((messages[1] as { toolCallId?: string }).toolCallId).toBe(" opaque-call ");
  });

  it("drops malformed tool calls missing input before persistence", () => {
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm);

    sm.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "read" }],
      }),
    );

    const messages = getPersistedMessages(sm);
    expect(messages).toHaveLength(0);
  });

  it("drops malformed tool calls with invalid name tokens before persistence", () => {
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm);

    sm.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_bad_name",
            name: 'toolu_01mvznfebfuu <|tool_call_argument_begin|> {"command"',
            arguments: {},
          },
        ],
      }),
    );

    expect(getPersistedMessages(sm)).toHaveLength(0);
  });

  it("drops tool calls not present in allowedToolNames", () => {
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm, {
      allowedToolNames: ["read"],
    });

    sm.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "write", arguments: {} }],
      }),
    );

    expect(getPersistedMessages(sm)).toHaveLength(0);
  });

  it("flushes pending tool results when a sanitized assistant message is dropped", () => {
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm);

    appendAssistantToolCall(sm, { id: "call_1", name: "read" });
    appendAssistantToolCall(sm, { id: "call_2", name: "read", withArguments: false });

    expectPersistedRoles(sm, ["assistant", "toolResult"]);
  });

  it("does not synthesize older pending results before a new assistant tool-call turn", () => {
    const sm = SessionManager.inMemory();
    const guard = installSessionToolResultGuard(sm);

    appendAssistantToolCall(sm, { id: "call_1", name: "read" });
    appendAssistantToolCall(sm, { id: "call_2", name: "exec" });
    sm.appendMessage(
      asAppendMessage({
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: "real output" }],
        isError: false,
      }),
    );

    const messages = expectPersistedRoles(sm, ["assistant", "assistant", "toolResult"]);
    expect((messages[2] as { toolCallId?: string; isError?: boolean }).toolCallId).toBe("call_1");
    expect((messages[2] as { isError?: boolean }).isError).toBe(false);
    expect(JSON.stringify(messages)).not.toContain("missing tool result");
    expect(guard.getPendingIds()).toStrictEqual(["call_2"]);
  });

  it("clears pending when a sanitized assistant message is dropped and synthetic results are disabled", () => {
    const sm = SessionManager.inMemory();
    const guard = installSessionToolResultGuard(sm, {
      allowSyntheticToolResults: false,
      allowedToolNames: ["read"],
    });

    appendAssistantToolCall(sm, { id: "call_1", name: "read" });
    appendAssistantToolCall(sm, { id: "call_2", name: "write" });

    expectPersistedRoles(sm, ["assistant"]);
    expect(guard.getPendingIds()).toStrictEqual([]);
  });

  it("drops older pending ids before new tool calls when synthetic results are disabled", () => {
    const sm = SessionManager.inMemory();
    const guard = installSessionToolResultGuard(sm, {
      allowSyntheticToolResults: false,
    });

    sm.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
      }),
    );
    sm.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_2", name: "read", arguments: {} }],
      }),
    );

    expectPersistedRoles(sm, ["assistant", "assistant"]);
    expect(guard.getPendingIds()).toEqual(["call_2"]);
  });

  it("caps oversized tool result text during persistence", () => {
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm);

    appendToolResultText(sm, "x".repeat(500_000));

    const text = getToolResultText(getPersistedMessages(sm));
    expect(text.length).toBeLessThan(500_000);
    expect(text).toContain("truncated");
  });

  it("does not truncate tool results under the limit", () => {
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm);

    const originalText = "small tool result";
    appendToolResultText(sm, originalText);

    const text = getToolResultText(getPersistedMessages(sm));
    expect(text).toBe(originalText);
  });

  it("blocks persistence when before_message_write returns block=true", () => {
    const sm = SessionManager.inMemory();
    const blockedUserMessages: AgentMessage[] = [];
    installSessionToolResultGuard(sm, {
      beforeMessageWriteHook: () => ({ block: true }),
      onUserMessageBlocked: (message) => {
        blockedUserMessages.push(message);
      },
    });

    sm.appendMessage(
      asAppendMessage({
        role: "user",
        content: "hidden",
        timestamp: Date.now(),
      }),
    );

    expect(getPersistedMessages(sm)).toHaveLength(0);
    expect(blockedUserMessages).toHaveLength(1);
    expect(blockedUserMessages[0]).toMatchObject({ role: "user", content: "hidden" });
  });

  it("repairs a blocked real tool result before the next user message", () => {
    const sm = SessionManager.inMemory();
    const guard = installSessionToolResultGuard(sm, {
      beforeMessageWriteHook: ({ message }) =>
        message.role === "toolResult" && !message.isError ? { block: true } : undefined,
    });

    sm.appendMessage(toolCallMessage);
    expect(
      sm.appendMessage(
        asAppendMessage({
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "read",
          content: [{ type: "text", text: "blocked real result" }],
          isError: false,
        }),
      ),
    ).toBeUndefined();
    expect(guard.getPendingIds()).toStrictEqual(["call_1"]);

    sm.appendMessage(
      asAppendMessage({
        role: "user",
        content: "next user message",
        timestamp: Date.now(),
      }),
    );

    const messages = expectPersistedRoles(sm, ["assistant", "toolResult", "user"]);
    expect(messages[1]).toMatchObject({
      toolCallId: "call_1",
      toolName: "read",
      isError: true,
    });
    expect(guard.getPendingIds()).toStrictEqual([]);
  });

  it("applies before_message_write message mutations before persistence", () => {
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm, {
      beforeMessageWriteHook: ({ message }) => {
        if ((message as { role?: string }).role !== "toolResult") {
          return undefined;
        }
        return {
          message: castAgentMessage({
            ...(message as unknown as Record<string, unknown>),
            content: [{ type: "text", text: "rewritten by hook" }],
          }),
        };
      },
    });

    appendToolResultText(sm, "original");

    const text = getToolResultText(getPersistedMessages(sm));
    expect(text).toBe("rewritten by hook");
  });

  it.each(["added", "renamed", "removed", "error", "aborted"] as const)(
    "repairs only canonical calls after a hook leaves them %s",
    (change) => {
      const sm = SessionManager.inMemory();
      const guard = installSessionToolResultGuard(sm, {
        beforeMessageWriteHook: ({ message }) =>
          message.role === "assistant"
            ? {
                message: castAgentMessage({
                  ...message,
                  content:
                    change === "removed"
                      ? [{ type: "text", text: "no tool needed" }]
                      : [{ type: "toolCall", id: "canonical", name: "read", arguments: {} }],
                  stopReason: change === "error" || change === "aborted" ? change : "toolUse",
                }),
              }
            : undefined,
      });

      sm.appendMessage(
        change === "added"
          ? asAppendMessage({ role: "assistant", content: [{ type: "text", text: "checking" }] })
          : toolCallMessage,
      );
      guard.flushPendingToolResults();

      const results = getPersistedMessages(sm).filter((message) => message.role === "toolResult");
      expect(results).toEqual(
        change === "added" || change === "renamed"
          ? [expect.objectContaining({ toolCallId: "canonical", toolName: "read", isError: true })]
          : [],
      );
      expect(guard.getPendingIds()).toEqual([]);
    },
  );

  it("applies before_message_write redaction to tool-result details before persistence", () => {
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm, {
      beforeMessageWriteHook: ({ message }) => ({
        message: redactTranscriptMessage(message, {}),
      }),
    });

    sm.appendMessage(toolCallMessage);
    sm.appendMessage(
      asAppendMessage({
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: "result sk-abcdef1234567890xyz" }],
        details: {
          apiKey: "plainsecretvalue123",
          password: "hunter2",
          nested: { accessToken: ["nestedplainsecret123"] },
          safe: "visible",
        },
        isError: false,
        timestamp: Date.now(),
      }),
    );

    const messages = getPersistedMessages(sm);
    const toolResult = messages.find((m) => m.role === "toolResult") as unknown as {
      content: Array<{ text: string }>;
      details: {
        apiKey: string;
        password: string;
        nested: { accessToken: string[] };
        safe: string;
      };
    };
    const serializedToolResult = JSON.stringify(toolResult);
    expect(
      expectDefined(toolResult.content[0], "toolResult.content[0] test invariant").text,
    ).not.toContain("sk-abcdef1234567890xyz");
    expect(serializedToolResult).not.toContain("plainsecretvalue123");
    expect(serializedToolResult).not.toContain("hunter2");
    expect(serializedToolResult).not.toContain("nestedplainsecret123");
    expect(toolResult.details.apiKey).toBe("***");
    expect(toolResult.details.password).toBe("***");
    expect(toolResult.details.nested.accessToken[0]).toBe("***");
    expect(serializedToolResult).toContain("visible");
  });

  it("preserves correlation IDs while backfilling names through redaction", () => {
    const sm = SessionManager.inMemory();
    const guard = installSessionToolResultGuard(sm, {
      beforeMessageWriteHook: ({ message }) => ({ message: redactTranscriptMessage(message, {}) }),
    });
    const id = `call_fixture|fc-${"a".repeat(24)}`;
    appendAssistantToolCall(sm, { id, name: "read" });
    sm.appendMessage(
      asAppendMessage({
        role: "toolResult",
        toolCallId: id,
        toolName: "   ",
        content: [{ type: "text", text: "observed" }],
        isError: false,
      }),
    );
    guard.flushPendingToolResults();
    const messages = expectPersistedRoles(sm, ["assistant", "toolResult"]);
    expect(messages[1]).toMatchObject({ toolName: "read", isError: false });
    expect(messages[1]).toMatchObject({ toolCallId: id });
    expect(guard.getPendingIds()).toEqual([]);
  });

  it.each([false, true])(
    "keeps canonical synthetic IDs after transforms (blocked=%s)",
    (blocked) => {
      const sm = SessionManager.inMemory();
      const guard = installSessionToolResultGuard(sm, {
        transformMessageForPersistence: (message) => {
          if (message.role === "assistant") {
            return castAgentMessage({
              ...message,
              content: [{ type: "toolCall", id: "p:call_1", name: "read", arguments: {} }],
            });
          }
          return message.role === "toolResult"
            ? { ...message, toolCallId: `p:${message.toolCallId}` }
            : message;
        },
        beforeMessageWriteHook: ({ message }) =>
          message.role === "toolResult"
            ? blocked && !message.isError
              ? { block: true }
              : { message: { ...message, content: [{ type: "text", text: "safe failure" }] } }
            : undefined,
      });
      sm.appendMessage(toolCallMessage);
      if (blocked) {
        sm.appendMessage(
          asAppendMessage({
            role: "toolResult",
            toolCallId: "call_1",
            toolName: "read",
            content: [{ type: "text", text: "blocked" }],
            isError: false,
          }),
        );
      }
      guard.flushPendingToolResults();
      const messages = expectPersistedRoles(sm, ["assistant", "toolResult"]);
      expect(messages[1]).toMatchObject({
        toolCallId: "p:call_1",
        toolName: "read",
        isError: true,
        content: [{ type: "text", text: "safe failure" }],
      });
    },
  );

  it("backfills known names before both persistence hooks", () => {
    const sm = SessionManager.inMemory();
    const observed: string[] = [];
    installSessionToolResultGuard(sm, {
      transformToolResultForPersistence: (message) => {
        if (message.role === "toolResult") {
          observed.push(message.toolName);
        }
        return message;
      },
      beforeMessageWriteHook: ({ message }) => {
        if (message.role !== "toolResult") {
          return undefined;
        }
        observed.push(message.toolName);
        return message.toolName === "read"
          ? { message: { ...message, content: [{ type: "text", text: "hook applied" }] } }
          : undefined;
      },
    });
    sm.appendMessage(toolCallMessage);
    sm.appendMessage(
      asAppendMessage({
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "   ",
        content: [{ type: "text", text: "original" }],
        isError: false,
      }),
    );
    expect(observed).toEqual(["read", "read"]);
    expect(getToolResultText(getPersistedMessages(sm))).toBe("hook applied");
  });

  it("persists env reads only after owner-context redaction", async () => {
    const credential = "persisted-env-credential-1234567890";
    const text = `api_key: ${credential}`;
    const readTool = createOpenClawReadTool({
      name: "read",
      label: "read",
      description: "test read",
      parameters: Type.Object({ path: Type.String() }),
      execute: async () => ({
        content: [{ type: "text" as const, text }],
        details: { kind: "text", content: text },
      }),
    });
    const result = await readTool.execute("call_1", { path: ".env.production" });
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm, {
      beforeMessageWriteHook: ({ message }) => ({
        message: redactTranscriptMessage(message, {}),
      }),
    });

    sm.appendMessage(toolCallMessage);
    sm.appendMessage(
      asAppendMessage({
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: result.content,
        details: result.details,
        isError: false,
        timestamp: Date.now(),
      }),
    );

    expect(JSON.stringify(getPersistedMessages(sm))).not.toContain(credential);
  });

  it("applies before_message_write to synthetic tool-result flushes", () => {
    const sm = SessionManager.inMemory();
    const guard = installSessionToolResultGuard(sm, {
      beforeMessageWriteHook: ({ message }) => {
        if ((message as { role?: string }).role !== "toolResult") {
          return undefined;
        }
        return { block: true };
      },
    });

    sm.appendMessage(toolCallMessage);
    guard.flushPendingToolResults();

    const messages = getPersistedMessages(sm);
    expect(messages.map((m) => m.role)).toEqual(["assistant"]);
  });

  it("applies message persistence transform to user messages", () => {
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm, {
      transformMessageForPersistence: (message) =>
        (message as { role?: string }).role === "user"
          ? castAgentMessage({
              ...(message as unknown as Record<string, unknown>),
              provenance: { kind: "inter_session", sourceTool: "sessions_send" },
            })
          : message,
    });

    sm.appendMessage(
      asAppendMessage({
        role: "user",
        content: "forwarded",
        timestamp: Date.now(),
      }),
    );

    const persisted = sm.getEntries().find((e) => e.type === "message") as
      | { message?: Record<string, unknown> }
      | undefined;
    expect(persisted?.message?.role).toBe("user");
    expect(persisted?.message?.provenance).toEqual({
      kind: "inter_session",
      sourceTool: "sessions_send",
    });
  });

  it("suppresses only the next persisted user message when requested", () => {
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm, {
      suppressNextUserMessagePersistence: true,
    });

    sm.appendMessage(
      asAppendMessage({
        role: "user",
        content: "first",
        timestamp: Date.now(),
      }),
    );
    sm.appendMessage(
      asAppendMessage({
        role: "user",
        content: "second",
        timestamp: Date.now() + 1,
      }),
    );

    const persisted = getPersistedMessages(sm);
    expect(persisted.map((message) => message.role)).toEqual(["user"]);
    expect((persisted[0] as { content?: unknown } | undefined)?.content).toBe("second");
  });

  it("re-enables the next user write after the canonical entry is removed", () => {
    const sm = SessionManager.inMemory();
    const guard = installSessionToolResultGuard(sm, {
      suppressNextUserMessagePersistence: true,
    });

    guard.clearNextUserMessagePersistenceSuppression();
    sm.appendMessage(
      asAppendMessage({
        role: "user",
        content: "replacement",
        timestamp: Date.now(),
      }),
    );

    const persisted = getPersistedMessages(sm);
    expect(persisted).toHaveLength(1);
    expect((persisted[0] as { content?: unknown } | undefined)?.content).toBe("replacement");
  });

  it("retains terminal errors in nonpersistent sessions", async () => {
    const sm = SessionManager.inMemory();
    const owner = createAssistantErrorTranscript({ runId: "run-test" });
    installSessionToolResultGuard(sm, { assistantErrorTranscript: owner });
    sm.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "terminal failure",
        timestamp: Date.now(),
      }),
    );
    await owner.settle(true);
    expect(getPersistedMessages(sm)).toEqual([
      expect.objectContaining({ role: "assistant", errorMessage: "terminal failure" }),
    ]);
  });

  it("reports the exact persisted user entry id", () => {
    const sm = SessionManager.inMemory();
    const persisted: Array<{ entryId: string; message: AgentMessage }> = [];
    installSessionToolResultGuard(sm, {
      onUserMessagePersisted: (message, context) => {
        persisted.push({ entryId: context.entryId, message });
      },
    });

    const entryId = sm.appendMessage(
      asAppendMessage({ role: "user", content: "exact admission", timestamp: 1 }),
    );

    expect(persisted).toEqual([
      {
        entryId,
        message: expect.objectContaining({ role: "user", content: "exact admission" }),
      },
    ]);
  });

  it("still persists successful assistant messages when error suppression is on", () => {
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm, {
      assistantErrorTranscript: createAssistantErrorTranscript({ runId: "run-test" }),
    });

    sm.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: "ok response",
        stopReason: "stop",
        timestamp: Date.now(),
      }),
    );

    const persisted = getPersistedMessages(sm);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.role).toBe("assistant");
  });

  it("suppresses transcript-only assistant messages when requested", () => {
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm, {
      suppressTranscriptOnlyAssistantPersistence: true,
    });

    sm.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: "private room-event note",
        timestamp: Date.now(),
      }),
    );
    sm.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "message", arguments: {} }],
        timestamp: Date.now() + 1,
      }),
    );

    const persisted = getPersistedMessages(sm);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.role).toBe("assistant");
    expect(JSON.stringify(persisted[0])).toContain("call_1");
  });

  // When an assistant message with toolCalls is aborted, no synthetic toolResult
  // should be created. Creating synthetic results for aborted/incomplete tool calls
  // causes API 400 errors: "unexpected tool_use_id found in tool_result blocks".
  it("does NOT create synthetic toolResult for aborted assistant messages with toolCalls", () => {
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm);

    // Aborted assistant message with incomplete toolCall
    sm.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_aborted", name: "read", arguments: {} }],
        stopReason: "aborted",
      }),
    );

    // Next message triggers flush of pending tool calls
    sm.appendMessage(
      asAppendMessage({
        role: "user",
        content: "are you stuck?",
        timestamp: Date.now(),
      }),
    );

    // Should only have assistant + user, NO synthetic toolResult
    const messages = getPersistedMessages(sm);
    const roles = messages.map((m) => m.role);
    expect(roles).toEqual(["assistant", "user"]);
    expect(roles).not.toContain("toolResult");
  });

  it("does NOT create synthetic toolResult for errored assistant messages with toolCalls", () => {
    const sm = SessionManager.inMemory();
    const guard = installSessionToolResultGuard(sm);

    // Error assistant message with incomplete toolCall
    sm.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_error", name: "exec", arguments: {} }],
        stopReason: "error",
      }),
    );

    // Explicit flush should NOT create synthetic result for errored messages
    guard.flushPendingToolResults();

    const messages = getPersistedMessages(sm);
    const toolResults = messages.filter((m) => m.role === "toolResult");
    // No synthetic toolResults should exist for the errored call
    const syntheticForError = toolResults.filter(
      (m) => (m as { toolCallId?: string }).toolCallId === "call_error",
    );
    expect(syntheticForError).toHaveLength(0);
  });
});
