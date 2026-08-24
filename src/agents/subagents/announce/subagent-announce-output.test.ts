// Subagent announce output tests cover transcript reads, completion extraction,
// compact stats, and wait-outcome text used in announce messages.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  testing,
  applySubagentWaitOutcome,
  buildCompactAnnounceStatsLine,
  buildChildCompletionFindings,
  dedupeLatestChildCompletionRows,
  readSubagentOutput,
} from "./subagent-announce-output.test-support.js";

type CallGateway = typeof import("../../../gateway/call.js").callGateway;
type GetRuntimeConfig = typeof import("./subagent-announce.runtime.js").getRuntimeConfig;
type ReadSessionEntry = typeof import("./subagent-announce.runtime.js").readSubagentSessionEntry;
type ReadSessionMessagesAsync =
  typeof import("./subagent-announce.runtime.js").readSessionMessagesAsync;
type ResolveAgentIdFromSessionKey =
  typeof import("./subagent-announce.runtime.js").resolveAgentIdFromSessionKey;
type ResolveStorePath = typeof import("./subagent-announce.runtime.js").resolveSessionStorePathCore;

function installOutputDeps(params: {
  messages: Array<unknown>;
  transcriptMessages?: Array<unknown>;
}) {
  const callGateway = vi.fn(async () => ({ messages: params.messages }));
  const readSessionMessagesAsync = vi.fn(async () => params.transcriptMessages ?? []);
  testing.setDepsForTest({
    callGateway: callGateway as unknown as CallGateway,
    readSessionMessagesAsync: readSessionMessagesAsync as unknown as ReadSessionMessagesAsync,
  });
  return { callGateway, readSessionMessagesAsync };
}

function sessionsYieldTurn(message = "Waiting for subagent completion.") {
  // sessions_yield is requester control flow, not child output; fixtures keep
  // that wait turn adjacent to later assistant completions.
  return [
    {
      role: "assistant",
      stopReason: "toolUse",
      content: [
        { type: "text", text: message },
        {
          type: "toolCall",
          id: "call-yield",
          name: "sessions_yield",
          arguments: { message },
        },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "call-yield",
      toolName: "sessions_yield",
      content: [
        {
          type: "text",
          text: JSON.stringify({ status: "yielded", message }, null, 2),
        },
      ],
      details: { status: "yielded", message },
    },
  ];
}

describe("dedupeLatestChildCompletionRows", () => {
  it("prefers the newer generation when child runs share a creation timestamp", () => {
    const childSessionKey = "agent:main:subagent:reused";
    const older = {
      runId: "run-older",
      generation: 1,
      childSessionKey,
      task: "older",
      createdAt: 1_000,
      execution: {},
    };
    const newer = { ...older, runId: "run-newer", generation: 2, task: "newer" };

    expect(dedupeLatestChildCompletionRows([older, newer])).toStrictEqual([newer]);
  });
});

describe("buildCompactAnnounceStatsLine", () => {
  afterEach(() => {
    testing.setDepsForTest();
  });

  it("rolls one-decimal thousand token stats over to the million unit", async () => {
    testing.setDepsForTest({
      getRuntimeConfig: (() => ({ session: { store: "memory" } })) as GetRuntimeConfig,
      readSubagentSessionEntry: (() => ({
        sessionId: "child-session",
        updatedAt: 0,
        inputTokens: 999_999,
        outputTokens: 0,
        totalTokens: 999_999,
      })) as ReadSessionEntry,
      resolveAgentIdFromSessionKey: (() => "main") as ResolveAgentIdFromSessionKey,
      resolveSessionStorePathCore: (() => "/tmp/openclaw-session-store") as ResolveStorePath,
    });

    await expect(
      buildCompactAnnounceStatsLine({
        sessionKey: "agent:main:subagent:child",
      }),
    ).resolves.toBe("Stats: runtime n/a • tokens 1.0m (in 1.0m / out 0)");
  });

  it("reports unknown token usage when the session entry carries no usage data", async () => {
    testing.setDepsForTest({
      getRuntimeConfig: (() => ({ session: { store: "memory" } })) as GetRuntimeConfig,
      // No inputTokens/outputTokens/totalTokens: usage never landed on the entry.
      readSubagentSessionEntry: (() => ({
        sessionId: "child-session",
        updatedAt: 0,
      })) as ReadSessionEntry,
      resolveAgentIdFromSessionKey: (() => "main") as ResolveAgentIdFromSessionKey,
      resolveSessionStorePathCore: (() => "/tmp/openclaw-session-store") as ResolveStorePath,
    });

    await expect(
      buildCompactAnnounceStatsLine({
        sessionKey: "agent:main:subagent:child",
      }),
    ).resolves.toBe("Stats: runtime n/a • tokens unknown");
  });

  it("keeps a genuine zero-usage reading distinct from absent usage data", async () => {
    testing.setDepsForTest({
      getRuntimeConfig: (() => ({ session: { store: "memory" } })) as GetRuntimeConfig,
      // Fields present and zero: the child really did make no model call.
      readSubagentSessionEntry: (() => ({
        sessionId: "child-session",
        updatedAt: 0,
        inputTokens: 0,
        outputTokens: 0,
      })) as ReadSessionEntry,
      resolveAgentIdFromSessionKey: (() => "main") as ResolveAgentIdFromSessionKey,
      resolveSessionStorePathCore: (() => "/tmp/openclaw-session-store") as ResolveStorePath,
    });

    await expect(
      buildCompactAnnounceStatsLine({
        sessionKey: "agent:main:subagent:child",
      }),
    ).resolves.toBe("Stats: runtime n/a • tokens 0 (in 0 / out 0)");
  });

  it("reports a fresh total without inventing directional token counts", async () => {
    testing.setDepsForTest({
      getRuntimeConfig: (() => ({ session: { store: "memory" } })) as GetRuntimeConfig,
      readSubagentSessionEntry: (() => ({
        sessionId: "child-session",
        updatedAt: 0,
        totalTokens: 500,
        totalTokensFresh: true,
        totalTokensVersion: 1,
      })) as ReadSessionEntry,
      resolveAgentIdFromSessionKey: (() => "main") as ResolveAgentIdFromSessionKey,
      resolveSessionStorePathCore: (() => "/tmp/openclaw-session-store") as ResolveStorePath,
    });

    await expect(
      buildCompactAnnounceStatsLine({
        sessionKey: "agent:main:subagent:child",
      }),
    ).resolves.toBe("Stats: runtime n/a • tokens 500 prompt/cache");
  });
});

describe("readSubagentOutput", () => {
  afterEach(() => {
    testing.setDepsForTest();
  });

  it("does not treat a sessions_yield wait turn as subagent completion output", async () => {
    const deps = installOutputDeps({
      messages: sessionsYieldTurn(),
    });

    await expect(readSubagentOutput("agent:main:subagent:child")).resolves.toBeUndefined();
    expect(deps.callGateway).toHaveBeenCalledOnce();
  });

  it.each([
    { phase: "commentary", expected: undefined },
    { phase: "final_answer", expected: "Visible subagent answer" },
  ])("respects the phase of scalar $phase output", async ({ phase, expected }) => {
    installOutputDeps({
      messages: [{ role: "assistant", phase, content: "Visible subagent answer" }],
    });

    await expect(readSubagentOutput("agent:main:subagent:child")).resolves.toBe(expected);
  });

  it.each([
    {
      shape: "OpenAI top-level snake_case function call",
      assistant: {
        role: "assistant",
        content: "Waiting for child completion.",
        tool_calls: [{ type: "function", function: { name: "sessions_yield" } }],
      },
    },
    {
      shape: "top-level camelCase tool call",
      assistant: {
        role: "assistant",
        content: "Waiting for child completion.",
        toolCalls: [{ name: "sessions_yield" }],
      },
    },
    {
      shape: "nested content function call",
      assistant: {
        role: "assistant",
        content: [
          { type: "text", text: "Waiting for child completion." },
          { type: "function_call", function: { name: "sessions_yield" } },
        ],
      },
    },
  ])("does not expose a $shape yield turn as completion output", async ({ assistant }) => {
    installOutputDeps({
      messages: [assistant, { role: "tool", content: '{"status":"yielded"}' }],
    });

    await expect(readSubagentOutput("agent:main:subagent:child")).resolves.toBeUndefined();
  });

  it.each(["toolUse", "functionCall", "function_call"])(
    "does not synthesize output from provider-specific %s transcript blocks",
    async (type) => {
      installOutputDeps({
        messages: [{ role: "assistant", content: [{ type, name: "read" }] }],
      });

      await expect(readSubagentOutput("agent:main:subagent:child")).resolves.toBeUndefined();
    },
  );

  it.each(["toolUse", "functionCall", "function_call"])(
    "summarizes provider-specific %s transcript blocks after a timeout",
    async (type) => {
      installOutputDeps({
        messages: [{ role: "assistant", content: [{ type, name: "read" }] }],
      });

      await expect(
        readSubagentOutput("agent:main:subagent:child", { status: "timeout" }),
      ).resolves.toBe("1 tool call(s) made without visible output.");
    },
  );

  it.each(["toolCalls", "tool_calls"])("summarizes top-level %s after a timeout", async (field) => {
    installOutputDeps({
      messages: [{ role: "assistant", [field]: [{ name: "read" }, { name: "exec" }] }],
    });

    await expect(
      readSubagentOutput("agent:main:subagent:child", { status: "timeout" }),
    ).resolves.toBe("2 tool call(s) made without visible output.");
  });

  it("keeps an intentional silent reply ahead of timeout tool progress", async () => {
    installOutputDeps({
      messages: [
        { role: "assistant", content: [{ type: "toolCall", name: "read" }] },
        { role: "assistant", content: [{ type: "text", text: "NO_REPLY" }] },
      ],
    });

    await expect(
      readSubagentOutput("agent:main:subagent:child", { status: "timeout" }),
    ).resolves.toBe("NO_REPLY");
  });

  it("returns final assistant output that arrives after a sessions_yield wait turn", async () => {
    installOutputDeps({
      messages: [
        ...sessionsYieldTurn(),
        {
          role: "system",
          content: [{ type: "text", text: "Compaction" }],
          __openclaw: { kind: "compaction" },
        },
        {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "Created /tmp/final-deck.pptx" }],
        },
      ],
    });

    await expect(readSubagentOutput("agent:main:subagent:child")).resolves.toBe(
      "Created /tmp/final-deck.pptx",
    );
  });

  it("does not reuse assistant progress that issued a trailing tool call", async () => {
    installOutputDeps({
      messages: [
        {
          role: "assistant",
          stopReason: "toolUse",
          content: [
            { type: "text", text: "Mapped the code path." },
            { type: "toolCall", id: "call-read", name: "read", arguments: {} },
          ],
        },
        {
          role: "toolResult",
          content: "tool result should not become the child result",
        },
      ],
    });

    await expect(readSubagentOutput("agent:main:subagent:child")).resolves.toBeUndefined();
  });

  it("does not keep earlier visible progress across a trailing tool-only turn", async () => {
    installOutputDeps({
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Mapped the code path." }],
        },
        {
          role: "assistant",
          stopReason: "toolUse",
          content: [{ type: "toolCall", id: "call-read", name: "read", arguments: {} }],
        },
        {
          role: "toolResult",
          content: "tool result should not become the child result",
        },
      ],
    });

    await expect(readSubagentOutput("agent:main:subagent:child")).resolves.toBeUndefined();
  });

  it("returns a final assistant reply emitted after trailing tool activity", async () => {
    installOutputDeps({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Mapped the code path." },
            { type: "toolCall", id: "call-read", name: "read", arguments: {} },
          ],
        },
        { role: "toolResult", content: "tool result" },
        {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "The fix is complete." }],
        },
      ],
    });

    await expect(readSubagentOutput("agent:main:subagent:child")).resolves.toBe(
      "The fix is complete.",
    );
  });

  it("does not replay an older assistant reply after a newer user turn", async () => {
    installOutputDeps({
      messages: [
        { role: "assistant", content: [{ type: "text", text: "Completed the old task." }] },
        { role: "user", content: [{ type: "text", text: "Start the next task." }] },
      ],
    });

    await expect(readSubagentOutput("agent:main:subagent:child")).resolves.toBeUndefined();
  });

  it("does not treat a projected inter-session input as an assistant completion", async () => {
    installOutputDeps({
      messages: [
        { role: "assistant", content: [{ type: "text", text: "Completed the old task." }] },
        {
          role: "assistant",
          provenance: { kind: "inter_session", sourceSessionKey: "agent:main:main" },
          content: [{ type: "text", text: "Start the next task." }],
        },
      ],
    });

    await expect(readSubagentOutput("agent:main:subagent:child")).resolves.toBeUndefined();
  });

  it("does not synthesize output from tool calls in the latest user turn", async () => {
    installOutputDeps({
      messages: [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "old-call", name: "read", arguments: {} }],
        },
        { role: "user", content: [{ type: "text", text: "Start the next task." }] },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "current-call", name: "exec", arguments: {} }],
        },
      ],
    });

    await expect(readSubagentOutput("agent:main:subagent:child")).resolves.toBeUndefined();
  });

  it("resets timeout tool progress at the latest user turn", async () => {
    installOutputDeps({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "old-read", name: "read", arguments: {} },
            { type: "toolCall", id: "old-exec", name: "exec", arguments: {} },
          ],
        },
        { role: "user", content: [{ type: "text", text: "Start the next task." }] },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "current-call", name: "write", arguments: {} }],
        },
      ],
    });

    await expect(
      readSubagentOutput("agent:main:subagent:child", { status: "timeout" }),
    ).resolves.toBe("1 tool call(s) made without visible output.");
  });

  it("does not fall back to tool output when the last assistant turn is empty", async () => {
    installOutputDeps({
      messages: [
        {
          role: "toolResult",
          content: "tool output only",
        },
        {
          role: "assistant",
          stopReason: "stop",
          content: [],
        },
      ],
    });

    await expect(readSubagentOutput("agent:main:subagent:child")).resolves.toBeUndefined();
  });

  it("reads recovered output from the private SQLite transcript before gateway history", async () => {
    const deps = installOutputDeps({
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "stale visible output" }],
        },
      ],
      transcriptMessages: [
        {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "fresh recovered output" }],
        },
      ],
    });

    // Private transcript data is fresher for recovered runs and avoids exposing
    // stale gateway-visible history after an internal completion is persisted.
    await expect(
      readSubagentOutput("agent:main:subagent:child", undefined, {
        sessionTarget: {
          agentId: "main",
          sessionId: "child-session",
          sessionKey: "agent:main:subagent:child",
          storePath: "/tmp/openclaw/agents/main/sessions/sessions.json",
        },
      }),
    ).resolves.toBe("fresh recovered output");
    expect(deps.readSessionMessagesAsync).toHaveBeenCalledWith(
      {
        agentId: "main",
        sessionId: "child-session",
        sessionKey: "agent:main:subagent:child",
        storePath: "/tmp/openclaw/agents/main/sessions/sessions.json",
      },
      { mode: "recent", maxMessages: 100, maxBytes: 1024 * 1024 },
    );
    expect(deps.callGateway).not.toHaveBeenCalled();
  });

  it("does not read visible gateway history when a private transcript is empty", async () => {
    const deps = installOutputDeps({
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "stale visible output" }],
        },
      ],
      transcriptMessages: [],
    });

    await expect(
      readSubagentOutput("agent:main:subagent:child", undefined, {
        sessionTarget: {
          agentId: "main",
          sessionId: "child-session",
          sessionKey: "agent:main:subagent:child",
          storePath: "/tmp/openclaw/agents/main/sessions/sessions.json",
        },
      }),
    ).resolves.toBeUndefined();
    expect(deps.callGateway).not.toHaveBeenCalled();
  });
});

describe("buildChildCompletionFindings", () => {
  it("hard-bounds each child result and the aggregate parent prompt", () => {
    const findings = buildChildCompletionFindings(
      Array.from({ length: 8 }, (_, index) => ({
        childSessionKey: `agent:main:subagent:${index}`,
        task: `worker ${index}`,
        createdAt: index,
        completion: { resultText: "🚀".repeat(60_000) },
        execution: { outcome: { status: "ok" as const } },
      })),
    );

    expect(findings).toBeDefined();
    expect(findings!.length).toBeLessThanOrEqual(4_096);
    expect(findings).toContain("status: ok");
    expect(findings).toContain("[child result truncated]");
    expect(findings).toContain("additional child completion result");
    expect(findings).toContain("</prompt-data>");
    for (const character of findings ?? "") {
      const code = character.charCodeAt(0);
      expect(character.length > 1 || code < 0xd800 || code > 0xdfff).toBe(true);
    }
  });

  it("bounds a single child result's escaped output with a visible marker", () => {
    const findings = buildChildCompletionFindings([
      {
        childSessionKey: "agent:main:subagent:angle-dense",
        task: "angle-dense result",
        createdAt: 1,
        completion: { resultText: `${"<".repeat(6_000)}-tail` },
        execution: { outcome: { status: "ok" } },
      },
    ]);

    const block = findings?.match(/<prompt-data>\n([\s\S]*?)\n<\/prompt-data>/)?.[1];
    expect(block).toBeDefined();
    expect(block!.length).toBeLessThanOrEqual(512);
    expect(block!.endsWith("[child result truncated]")).toBe(true);
  });

  it("sanitizes child results before applying their escaped output budget", () => {
    const findings = buildChildCompletionFindings([
      {
        childSessionKey: "agent:main:subagent:control-prefix",
        task: "control-prefixed result",
        createdAt: 1,
        completion: { resultText: `${"\u0000".repeat(700)}useful child result` },
        execution: { outcome: { status: "ok" } },
      },
    ]);

    expect(findings).toContain("useful child result");
    expect(findings).not.toContain("[child result truncated]");
  });

  it("retains a later actionable failure when earlier children exceed the remaining budget", () => {
    // Bounding each child's escaped output (this fix) shrank a single
    // oversized child from ~4x the 512-char budget down to ~512, so it now
    // takes 7 oversized successes (not 2) to pressure the 4096-char
    // aggregate cap in buildChildCompletionFindings.
    const findings = buildChildCompletionFindings([
      ...Array.from({ length: 7 }, (_, index) => ({
        childSessionKey: `agent:main:subagent:success-${index}`,
        task: `large result ${index + 1}`,
        createdAt: index + 1,
        completion: { resultText: "<".repeat(100_000) },
        execution: { outcome: { status: "ok" as const } },
      })),
      {
        childSessionKey: "agent:main:subagent:failure",
        task: "later actionable failure",
        createdAt: 8,
        completion: { resultText: "Permission required." },
        execution: {
          outcome: { status: "error", error: "Writable session authorization required." },
        },
      },
    ]);

    expect(findings!.length).toBeLessThanOrEqual(4_096);
    expect(findings).toContain("large result 1");
    expect(findings).toContain("later actionable failure");
    expect(findings).toContain("status: error: Writable session authorization required.");
    expect(findings).toContain("additional child completion results omitted");
  });

  it("prioritizes an oversized failed completion over a competing oversized success", () => {
    // 6 oversized successes alone just fit the 4096-char aggregate cap; an
    // oversized failure appended after them must still win its slot,
    // displacing the lowest-priority (chronologically last) success.
    const findings = buildChildCompletionFindings([
      ...Array.from({ length: 6 }, (_, index) => ({
        childSessionKey: `agent:main:subagent:success-${index}`,
        task: `large result ${index + 1}`,
        createdAt: index + 1,
        completion: { resultText: "<".repeat(100_000) },
        execution: { outcome: { status: "ok" as const } },
      })),
      {
        childSessionKey: "agent:main:subagent:failure",
        task: "later oversized failure",
        createdAt: 100,
        completion: { resultText: "<".repeat(100_000) },
        execution: {
          outcome: { status: "error", error: "Writable session authorization required." },
        },
      },
    ]);

    expect(findings!.length).toBeLessThanOrEqual(4_096);
    expect(findings).toContain("later oversized failure");
    expect(findings).toContain("status: error: Writable session authorization required.");
    expect(findings).not.toContain("large result 6");
    expect(findings).toContain("[1 additional child completion result omitted");
  });

  it("keeps escaped child data and oversized failure metadata inside the same hard cap", () => {
    const findings = buildChildCompletionFindings([
      {
        childSessionKey: "agent:main:subagent:child",
        label: "L".repeat(20_000),
        task: "child task",
        createdAt: 1,
        completion: { resultText: "<".repeat(100_000) },
        execution: { outcome: { status: "error", error: "E".repeat(20_000) } },
      },
    ]);

    expect(findings).toBeDefined();
    expect(findings!.length).toBeLessThanOrEqual(4_096);
    expect(findings).toContain("status: error:");
    expect(findings).toContain("&lt;");
    expect(findings).toContain("[child result truncated]");
    expect(findings).toContain("</prompt-data>");
  });

  it("does not convert ANNOUNCE_SKIP child completions into no-output findings", () => {
    const findings = buildChildCompletionFindings([
      {
        childSessionKey: "agent:main:subagent:silent",
        task: "silent task",
        createdAt: 1,
        completion: { resultText: "ANNOUNCE_SKIP" },
        execution: { outcome: { status: "ok" } },
      },
    ]);

    expect(findings).toBeUndefined();
  });

  it("keeps failed ANNOUNCE_SKIP child completions visible", () => {
    const findings = buildChildCompletionFindings([
      {
        childSessionKey: "agent:main:subagent:silent",
        task: "silent task",
        createdAt: 1,
        completion: { resultText: "ANNOUNCE_SKIP" },
        execution: { outcome: { status: "error", error: "boom" } },
      },
    ]);

    expect(findings).toContain("status: error: boom");
    expect(findings).toContain("ANNOUNCE_SKIP");
  });

  it("uses the canonical captured child completion text", () => {
    const findings = buildChildCompletionFindings([
      {
        childSessionKey: "agent:main:subagent:child",
        task: "child task",
        createdAt: 1,
        completion: { resultText: "final child output" },
        execution: { outcome: { status: "ok" } },
      },
    ]);

    expect(findings).toContain("final child output");
    expect(findings).not.toContain("(no output)");
  });

  it("does not recover result text from delivery metadata after completion text is cleared", () => {
    const findings = buildChildCompletionFindings([
      {
        childSessionKey: "agent:main:subagent:child",
        task: "child task",
        createdAt: 1,
        completion: { resultText: null },
        execution: { outcome: { status: "ok" } },
      },
    ]);

    expect(findings).toContain("(no output)");
  });

  it("uses captured fallback output when a resumed completion returns NO_REPLY", () => {
    const findings = buildChildCompletionFindings([
      {
        childSessionKey: "agent:main:subagent:child",
        task: "child task",
        createdAt: 1,
        completion: {
          resultText: "NO_REPLY",
          fallbackResultText: "findings captured before the wake",
        },
        execution: { outcome: { status: "ok" } },
      },
    ]);

    expect(findings).toContain("findings captured before the wake");
    expect(findings).not.toContain("NO_REPLY");
  });

  it.each([
    {
      name: "visible",
      terminalReply: { disposition: "visible", text: "authoritative final output" } as const,
      resultText: "older captured output",
      expected: "authoritative final output",
    },
    {
      name: "silent",
      terminalReply: { disposition: "silent" } as const,
      resultText: "NO_REPLY",
      expected: undefined,
    },
    {
      name: "empty",
      terminalReply: { disposition: "empty" } as const,
      resultText: null,
      expected: undefined,
    },
  ])(
    "keeps producer-owned $name terminal evidence authoritative over older fallback",
    ({ terminalReply, resultText, expected }) => {
      const findings = buildChildCompletionFindings([
        {
          childSessionKey: "agent:main:subagent:child",
          task: "child task",
          createdAt: 1,
          completion: {
            required: true,
            resultText,
            fallbackResultText: "older captured fallback",
            terminalReply,
          },
          execution: { outcome: { status: "ok" } },
        },
      ]);

      if (expected === undefined) {
        expect(findings).toBeUndefined();
      } else {
        expect(findings).toContain(expected);
        expect(findings).not.toContain("older captured output");
      }
    },
  );

  it.each(["silent", "empty"] as const)(
    "treats %s terminal evidence without retained text as an intentional non-result",
    (disposition) => {
      const findings = buildChildCompletionFindings([
        {
          childSessionKey: "agent:main:subagent:child",
          task: "child task",
          createdAt: 1,
          completion: {
            resultText: disposition === "silent" ? "NO_REPLY" : null,
            terminalReply: { disposition },
          },
          execution: { outcome: { status: "ok" } },
        },
      ]);

      expect(findings).toBeUndefined();
    },
  );

  it.each(["ANNOUNCE_SKIP", "REPLY_SKIP", "HEARTBEAT_OK"])(
    "does not override an intentional %s completion with fallback output",
    (resultText) => {
      const findings = buildChildCompletionFindings([
        {
          childSessionKey: "agent:main:subagent:silent",
          task: "silent task",
          createdAt: 1,
          completion: {
            resultText,
            fallbackResultText: "stale findings",
          },
          execution: { outcome: { status: "ok" } },
        },
      ]);

      expect(findings).toBeUndefined();
    },
  );

  it("numbers findings contiguously after skipped silent completions", () => {
    const findings = buildChildCompletionFindings([
      {
        childSessionKey: "agent:main:subagent:silent",
        task: "silent task",
        createdAt: 1,
        completion: { resultText: "ANNOUNCE_SKIP" },
        execution: { outcome: { status: "ok" } },
      },
      {
        childSessionKey: "agent:main:subagent:visible",
        task: "visible task",
        createdAt: 2,
        completion: { resultText: "actual output" },
        execution: { outcome: { status: "ok" } },
      },
    ]);

    expect(findings).toContain("1. visible task");
    expect(findings).not.toContain("2. visible task");
  });

  it("orders same-timestamp child completions by stable session identity", () => {
    const laterKey = {
      childSessionKey: "agent:main:subagent:z",
      task: "Z task",
      createdAt: 1_000,
      completion: { resultText: "Z result" },
      execution: { endedAt: 2_000, outcome: { status: "ok" as const } },
    };
    const earlierKey = {
      ...laterKey,
      childSessionKey: "agent:main:subagent:a",
      task: "A task",
      completion: { resultText: "A result" },
    };

    const forward = buildChildCompletionFindings([laterKey, earlierKey]);
    const reverse = buildChildCompletionFindings([earlierKey, laterKey]);

    expect(forward).toBe(reverse);
    expect(forward).toMatch(/1\. A task[\s\S]*2\. Z task/);
  });
});

describe("applySubagentWaitOutcome", () => {
  it("treats blocked ok wait snapshots as errors", () => {
    const applied = applySubagentWaitOutcome({
      wait: {
        status: "ok",
        startedAt: 100,
        endedAt: 150,
        livenessState: "blocked",
        error: "Context overflow: prompt too large for the model.",
      },
      outcome: undefined,
    });

    expect(applied.outcome).toEqual({
      status: "error",
      error: "Context overflow: prompt too large for the model.",
      startedAt: 100,
      endedAt: 150,
      elapsedMs: 50,
    });
  });

  it("treats abandoned ok wait snapshots as incomplete failures", () => {
    const applied = applySubagentWaitOutcome({
      wait: {
        status: "ok",
        startedAt: 100,
        endedAt: 150,
        livenessState: "abandoned",
      },
      outcome: undefined,
    });

    expect(applied.outcome).toEqual({
      status: "error",
      error: "Agent run ended before producing a complete result.",
      startedAt: 100,
      endedAt: 150,
      elapsedMs: 50,
    });
  });

  it("keeps provider hard timeouts stronger than blocked wait metadata", () => {
    const applied = applySubagentWaitOutcome({
      wait: {
        status: "error",
        startedAt: 100,
        endedAt: 150,
        livenessState: "blocked",
        timeoutPhase: "provider",
        providerStarted: true,
        error: "model timed out",
      },
      outcome: undefined,
    });

    expect(applied.outcome).toEqual({
      status: "timeout",
      startedAt: 100,
      endedAt: 150,
      elapsedMs: 50,
    });
  });

  it.each(["rpc", "superseded"] as const)(
    "keeps explicit %s cancellation distinct from timeout outcomes",
    (stopReason) => {
      const applied = applySubagentWaitOutcome({
        wait: {
          status: "timeout",
          startedAt: 100,
          endedAt: 150,
          stopReason,
        },
        outcome: undefined,
      });

      expect(applied.outcome).toEqual({
        status: "error",
        error: "subagent run terminated",
        startedAt: 100,
        endedAt: 150,
        elapsedMs: 50,
      });
    },
  );

  it("treats aborted ok wait snapshots as terminated subagent errors", () => {
    const applied = applySubagentWaitOutcome({
      wait: {
        status: "ok",
        startedAt: 100,
        endedAt: 150,
        stopReason: "aborted",
      },
      outcome: undefined,
    });

    expect(applied.outcome).toEqual({
      status: "error",
      error: "subagent run terminated",
      startedAt: 100,
      endedAt: 150,
      elapsedMs: 50,
    });
  });

  it.each(["restart", "aborted"] as const)(
    "keeps %s stop reasons as cancellation even when liveness is blocked",
    (stopReason) => {
      // classifySubagentTerminalOutcome must win over the generic classifier
      // here: blocked liveness alone would read as a failure, but an explicit
      // restart/aborted stop reason owns the outcome (openclaw#125407).
      const applied = applySubagentWaitOutcome({
        wait: {
          status: "ok",
          startedAt: 100,
          endedAt: 150,
          stopReason,
          livenessState: "blocked",
          error: "Context overflow: prompt too large for the model.",
        },
        outcome: undefined,
      });

      expect(applied.outcome).toEqual({
        status: "error",
        error: "subagent run terminated",
        startedAt: 100,
        endedAt: 150,
        elapsedMs: 50,
      });
    },
  );

  it("keeps the failure cause on pending-error timeout wait snapshots", () => {
    const applied = applySubagentWaitOutcome({
      wait: {
        status: "timeout",
        startedAt: 100,
        endedAt: 150,
        pendingError: true,
        error: "model returned an unrecoverable tool-call sequence",
      },
      outcome: undefined,
    });

    expect(applied.outcome).toEqual({
      status: "timeout",
      error: "model returned an unrecoverable tool-call sequence",
      startedAt: 100,
      endedAt: 150,
      elapsedMs: 50,
    });
  });

  it("leaves genuine budget timeouts without a cause", () => {
    const applied = applySubagentWaitOutcome({
      wait: {
        status: "timeout",
        startedAt: 100,
        endedAt: 150,
      },
      outcome: undefined,
    });

    expect(applied.outcome).toEqual({
      status: "timeout",
      startedAt: 100,
      endedAt: 150,
      elapsedMs: 50,
    });
  });

  it("ignores wait error text when the run did not end in a pending error", () => {
    const applied = applySubagentWaitOutcome({
      wait: {
        status: "timeout",
        startedAt: 100,
        endedAt: 150,
        error: "waited too long",
      },
      outcome: undefined,
    });

    expect(applied.outcome).toEqual({
      status: "timeout",
      startedAt: 100,
      endedAt: 150,
      elapsedMs: 50,
    });
  });
});
