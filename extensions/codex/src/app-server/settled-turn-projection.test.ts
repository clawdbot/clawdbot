import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it } from "vitest";
import { projectSettledCodexMessages } from "./settled-turn-projection.js";
import { attachUpstreamUserText } from "./upstream-prompt-provenance.js";

function message(value: unknown): AgentMessage {
  return value as AgentMessage;
}

function toolCall(id = "call-1"): AgentMessage {
  return message({
    role: "assistant",
    content: [
      { type: "thinking", thinking: "private reasoning" },
      { type: "toolCall", id, name: "message", arguments: { action: "send" } },
    ],
  });
}

function toolResult(
  id = "call-1",
  content: unknown = [{ type: "text", text: "Message sent." }],
): AgentMessage {
  return message({
    role: "toolResult",
    toolCallId: id,
    toolName: "message",
    content,
  });
}

const OVERLENGTH_CALL_ID = `${"a".repeat(82)}1`;

function projectedCallIds(messages: AgentMessage[]): string[] {
  return projectSettledCodexMessages(messages)
    .filter(
      (item): item is { call_id: string } =>
        typeof (item as { call_id?: unknown }).call_id === "string",
    )
    .map((item) => item.call_id);
}

function guardCasesFor(label: string, id: string) {
  return [
    {
      name: `missing result (${label})`,
      messages: [toolCall(id)],
      error: "incomplete tool transcript",
    },
    {
      name: `duplicate call id (${label})`,
      messages: [toolCall(id), toolCall(id), toolResult(id)],
      error: "duplicate tool call",
    },
    {
      name: `tool-name mismatch (${label})`,
      messages: [
        toolCall(id),
        message({
          role: "toolResult",
          toolCallId: id,
          toolName: "different",
          content: [{ type: "text", text: "done" }],
        }),
      ],
      error: "ambiguous tool transcript",
    },
  ];
}

describe("projectSettledCodexMessages", () => {
  it("projects a canonical completed tool exchange without exposing reasoning", () => {
    expect(
      projectSettledCodexMessages([
        message({ role: "user", content: "Send the update." }),
        message({
          role: "assistant",
          content: [{ type: "text", text: "I’ll send it now." }],
        }),
        toolCall(),
        toolResult(),
      ]),
    ).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Send the update." }],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "I’ll send it now." }],
      },
      {
        type: "function_call",
        call_id: "call-1",
        name: "message",
        arguments: '{"action":"send"}',
      },
      {
        type: "function_call_output",
        call_id: "call-1",
        output: "Message sent.",
      },
    ]);
  });

  it("accepts Codex's enriched mirrored tool-result block", () => {
    expect(
      projectSettledCodexMessages([
        toolCall(),
        toolResult("call-1", [
          {
            type: "toolResult",
            toolCallId: "call-1",
            content: "Telegram delivery complete.",
          },
        ]),
      ]),
    ).toEqual([
      expect.objectContaining({ type: "function_call", call_id: "call-1" }),
      {
        type: "function_call_output",
        call_id: "call-1",
        output: "Telegram delivery complete.",
      },
    ]);
  });

  it("rewrites overlength call ids once per projection and keeps the pair deterministic", () => {
    const firstIds = projectedCallIds([
      toolCall(OVERLENGTH_CALL_ID),
      toolResult(OVERLENGTH_CALL_ID),
    ]);
    const secondIds = projectedCallIds([
      toolCall(OVERLENGTH_CALL_ID),
      toolResult(OVERLENGTH_CALL_ID),
    ]);

    expect(OVERLENGTH_CALL_ID).toHaveLength(83);
    expect(firstIds).toHaveLength(2);
    expect(firstIds[0]).toMatch(/^call_[A-Za-z0-9_-]{1,59}$/);
    expect(firstIds[0]?.length).toBeLessThanOrEqual(64);
    expect(firstIds[1]).toBe(firstIds[0]);
    expect(secondIds).toEqual(firstIds);
  });

  it("does not collide distinct overlength call ids within one projection", () => {
    const ids = projectedCallIds([
      toolCall(OVERLENGTH_CALL_ID),
      toolResult(OVERLENGTH_CALL_ID),
      toolCall(`${"a".repeat(82)}2`),
      toolResult(`${"a".repeat(82)}2`),
    ]);

    expect(ids).toHaveLength(4);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).toBe(ids[3]);
    expect(ids[0]).not.toBe(ids[2]);
  });

  it("rejects at the item limit without draining the rest of the history", () => {
    // settled-turn-context passes a generator that pulls message payloads
    // lazily, so the projection has to fail before the tail is read. Learning
    // every call id up front (to keep rewrites off replayed ids) must not cost
    // that laziness.
    let pulled = 0;
    function* history(): Generator<AgentMessage> {
      for (let index = 0; index < 400; index += 1) {
        pulled += 1;
        yield toolCall(`call-${index}`);
        pulled += 1;
        yield toolResult(`call-${index}`);
      }
      throw new Error("history was drained past the projection limit");
    }

    expect(() => projectSettledCodexMessages(history())).toThrow("exceeds the item limit");
    expect(pulled).toBeLessThan(400);
  });

  it("keeps a complete transcript when a raw id equals an overlength id's rewrite", () => {
    // The rewrite lands in the same call_ space that raw ids occupy, so a
    // transcript can legitimately carry both. Reserving passthrough ids keeps
    // that from being rejected as a duplicate -- the fail-closed turn this
    // whole rewrite exists to prevent.
    const [collidingId] = projectedCallIds([
      toolCall(OVERLENGTH_CALL_ID),
      toolResult(OVERLENGTH_CALL_ID),
    ]);
    expect(collidingId).toBeDefined();

    const ids = projectedCallIds([
      toolCall(OVERLENGTH_CALL_ID),
      toolResult(OVERLENGTH_CALL_ID),
      toolCall(collidingId as string),
      toolResult(collidingId as string),
    ]);

    expect(ids).toHaveLength(4);
    // The raw id is replayed verbatim; the overlength one moves out of its way.
    expect(ids[2]).toBe(collidingId);
    expect(ids[3]).toBe(collidingId);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[0]).not.toBe(collidingId);
    expect(ids[0]).toMatch(/^call_[A-Za-z0-9_-]{1,59}$/);
    expect(ids[0]?.length).toBeLessThanOrEqual(64);
  });

  it("passes a 64-character call id through untouched and rewrites at 65", () => {
    const atLimit = "b".repeat(64);
    const overLimit = "c".repeat(65);

    // The Responses contract is maxLength 64, so a 64-character id must stay
    // byte-identical: narrowing the gate to `< 64` would silently rewrite ids
    // that already replay correctly today.
    expect(projectedCallIds([toolCall(atLimit), toolResult(atLimit)])).toEqual([atLimit, atLimit]);

    const rewritten = projectedCallIds([toolCall(overLimit), toolResult(overLimit)]);
    expect(rewritten).toHaveLength(2);
    expect(rewritten[0]).not.toBe(overLimit);
    expect(rewritten[0]).toMatch(/^call_[A-Za-z0-9_-]{1,59}$/);
    expect(rewritten[0]?.length).toBeLessThanOrEqual(64);
    expect(rewritten[1]).toBe(rewritten[0]);
  });

  it("projects dotted namespaced tool names recorded from Codex MCP calls", () => {
    const name = "codex_apps.slack.slack_send";
    expect(
      projectSettledCodexMessages([
        message({
          role: "assistant",
          content: [{ type: "toolCall", id: "call-1", name, arguments: { channel: "C1" } }],
        }),
        message({
          role: "toolResult",
          toolCallId: "call-1",
          toolName: name,
          content: [{ type: "text", text: "Sent." }],
        }),
      ]),
    ).toEqual([
      { type: "function_call", call_id: "call-1", name, arguments: '{"channel":"C1"}' },
      { type: "function_call_output", call_id: "call-1", output: "Sent." },
    ]);
  });

  it("rejects tool names outside the projectable charset and names the offender", () => {
    expect(() =>
      projectSettledCodexMessages([
        message({
          role: "assistant",
          content: [{ type: "toolCall", id: "call-1", name: "bad tool", arguments: {} }],
        }),
        message({
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bad tool",
          content: [{ type: "text", text: "failed" }],
        }),
      ]),
    ).toThrow("invalid tool name: bad tool");
  });

  it("preserves failed tool-result status in the projected output", () => {
    expect(
      projectSettledCodexMessages([
        toolCall(),
        message({
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "message",
          isError: true,
          content: [{ type: "text", text: "Delivery failed." }],
        }),
      ]).at(-1),
    ).toEqual({
      type: "function_call_output",
      call_id: "call-1",
      output: "[Tool result status: error]\nDelivery failed.",
    });
  });

  it("preserves an empty failed tool result as failure evidence", () => {
    expect(
      projectSettledCodexMessages([
        toolCall(),
        message({
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "message",
          isError: true,
          content: [],
        }),
      ]).at(-1),
    ).toEqual({
      type: "function_call_output",
      call_id: "call-1",
      output: "[Tool result status: error]\nTool failed without textual output.",
    });
  });

  it("does not charge the synthetic failure marker against the source text limit", () => {
    const resultText = "x".repeat(64 * 1024);
    const output = projectSettledCodexMessages([
      toolCall(),
      message({
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "message",
        isError: true,
        content: [{ type: "text", text: resultText }],
      }),
    ]).at(-1) as { output?: string };

    expect(output.output).toBe(`[Tool result status: error]\n${resultText}`);
  });

  it("preserves exact whitespace in projected transcript text", () => {
    expect(
      projectSettledCodexMessages([
        message({ role: "user", content: "  user input\n" }),
        message({ role: "assistant", content: [{ type: "text", text: "\tassistant output\n" }] }),
        toolCall(),
        toolResult("call-1", [{ type: "text", text: "  tool output\n" }]),
      ]),
    ).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "  user input\n" }],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "\tassistant output\n" }],
      },
      expect.objectContaining({ type: "function_call", call_id: "call-1" }),
      {
        type: "function_call_output",
        call_id: "call-1",
        output: "  tool output\n",
      },
    ]);
  });

  it.each([
    { count: 205, text: "old", error: "exceeds the item limit" },
    { count: 9, text: "x".repeat(60 * 1024), error: "exceeds the byte limit" },
  ])("stops acquiring later payloads after $error", ({ count, text, error }) => {
    let laterReads = 0;
    const later = message({
      role: "user",
      get content() {
        laterReads += 1;
        return "must not acquire this later payload";
      },
    });
    const oldMessages = Array.from({ length: count }, () =>
      message({ role: "user", content: text }),
    );
    expect(() =>
      projectSettledCodexMessages([...oldMessages, later, toolCall(), toolResult()]),
    ).toThrow(error);
    expect(laterReads).toBe(0);
  });

  it("prefers the undecorated upstream user text", () => {
    expect(
      projectSettledCodexMessages([
        message({
          role: "user",
          content: "[Telegram metadata] decorated prompt",
          __openclaw: { upstreamUserText: "Send the Aurora notice to Erin." },
        }),
        toolCall(),
        toolResult(),
      ])[0],
    ).toEqual({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Send the Aurora notice to Erin." }],
    });
  });

  it("preserves upstream user text above the ordinary message limit", () => {
    const upstreamUserText = "x".repeat(64 * 1024 + 1);

    expect(
      projectSettledCodexMessages([
        attachUpstreamUserText(
          message({ role: "user", content: "[Telegram metadata] decorated prompt" }),
          upstreamUserText,
        ),
        toolCall(),
        toolResult(),
      ])[0],
    ).toEqual({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: upstreamUserText }],
    });
  });

  it("rejects upstream user text above the projection limit", () => {
    expect(() =>
      projectSettledCodexMessages([
        attachUpstreamUserText(
          message({ role: "user", content: "[Telegram metadata] decorated prompt" }),
          "x".repeat(512 * 1024 + 1),
        ),
        toolCall(),
        toolResult(),
      ]),
    ).toThrow("oversized upstream user text");
  });

  it("charges upstream user text against the aggregate byte limit", () => {
    expect(() =>
      projectSettledCodexMessages([
        attachUpstreamUserText(
          message({ role: "user", content: "decorated" }),
          "x".repeat(400 * 1024),
        ),
        message({ role: "user", content: "x".repeat(60 * 1024) }),
        message({ role: "user", content: "x".repeat(60 * 1024) }),
        toolCall(),
        toolResult(),
      ]),
    ).toThrow("exceeds the byte limit");
  });

  it("does not let provenance hide non-text user content", () => {
    expect(() =>
      projectSettledCodexMessages([
        message({
          role: "user",
          content: [
            { type: "text", text: "Send the notice." },
            { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
          ],
          __openclaw: { upstreamUserText: "Send the notice." },
        }),
        toolCall(),
        toolResult(),
      ]),
    ).toThrow("does not support user content image");
  });

  it.each([
    {
      name: "orphan result",
      messages: [toolResult()],
      error: "ambiguous tool transcript",
    },
    ...guardCasesFor("short id", "call-1"),
    ...guardCasesFor("overlength id", OVERLENGTH_CALL_ID),
  ])("fails closed for $name", ({ messages, error }) => {
    expect(() => projectSettledCodexMessages(messages)).toThrow(error);
  });

  it("preserves valid image tool results as bounded non-vision evidence", () => {
    expect(
      projectSettledCodexMessages([
        toolCall(),
        toolResult("call-1", [
          { type: "text", text: "Generated the requested asset." },
          { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        ]),
      ]).at(-1),
    ).toEqual({
      type: "function_call_output",
      call_id: "call-1",
      output: "Generated the requested asset.\n[Image tool result: image/png]",
    });
  });

  it("rejects oversized text instead of truncating it", () => {
    expect(() =>
      projectSettledCodexMessages([
        message({ role: "user", content: "x".repeat(64 * 1024 + 1) }),
        toolCall(),
        toolResult(),
      ]),
    ).toThrow("oversized user message");
  });

  it("rejects a complete transcript above the aggregate byte limit", () => {
    const messages = Array.from({ length: 9 }, () =>
      message({ role: "user", content: "x".repeat(60 * 1024) }),
    );
    expect(() => projectSettledCodexMessages([...messages, toolCall(), toolResult()])).toThrow(
      "exceeds the byte limit",
    );
  });
});
