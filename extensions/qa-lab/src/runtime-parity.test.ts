// Qa Lab tests cover runtime parity classification behavior.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import {
  formatSqliteSessionFileMarker,
  resolveStorePath,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureRuntimeParityCell,
  isRuntimeParityResultPass,
  resolveRuntimeParityUsagePolicy,
  runRuntimeParityScenario,
  type RuntimeId,
  type RuntimeParityCell,
  type RuntimeParityToolCall,
} from "./runtime-parity.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

const tempDirs = createTempDirHarness();

afterEach(async () => {
  vi.unstubAllGlobals();
  await tempDirs.cleanup();
});

async function seedRuntimeParityTranscript(params: {
  messages: Array<Record<string, unknown>>;
  sessionId: string;
  sessionKey: string;
}) {
  const tempRoot = await tempDirs.makeTempDir("openclaw-qa-runtime-parity-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(tempRoot, "state") };
  const storePath = resolveStorePath(undefined, { agentId: "qa", env });
  await upsertSessionEntry({
    agentId: "qa",
    env,
    sessionKey: params.sessionKey,
    storePath,
    entry: {
      sessionId: params.sessionId,
      sessionFile: formatSqliteSessionFileMarker({
        agentId: "qa",
        sessionId: params.sessionId,
        storePath,
      }),
      updatedAt: 100,
    },
  });
  for (const [index, message] of params.messages.entries()) {
    await appendSessionTranscriptMessageByIdentity({
      agentId: "qa",
      env,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      storePath,
      now: index + 1,
      message: message as never,
    });
  }
  return tempRoot;
}

async function captureRuntimeParityWithMockRequests(params: {
  messages?: Array<Record<string, unknown>>;
  requests: Array<Record<string, unknown>>;
  scenarioResult?: Parameters<typeof captureRuntimeParityCell>[0]["scenarioResult"];
}) {
  const parentPrompt = "Delegate one bounded QA task to a subagent.";
  const tempRoot = await seedRuntimeParityTranscript({
    sessionId: "mock-runtime-parity",
    sessionKey: "agent:qa:mock-runtime-parity",
    messages: params.messages ?? [{ role: "user", content: parentPrompt }],
  });
  const requests = params.requests.map((request) => ({
    prompt: parentPrompt,
    allInputText: parentPrompt,
    ...request,
  }));
  const server = createServer((request, response) => {
    if (request.url !== "/debug/requests") {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(requests));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  try {
    return await captureRuntimeParityCell({
      runtime: "openclaw",
      gateway: { tempRoot },
      mockBaseUrl: `http://127.0.0.1:${address.port}`,
      scenarioResult: params.scenarioResult ?? { status: "pass" },
      wallClockMs: 10,
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function makeRuntimeParityCell(
  runtime: RuntimeId,
  toolCalls: RuntimeParityToolCall[],
): RuntimeParityCell {
  return {
    runtime,
    transcriptBytes: '{"message":{"role":"assistant","content":"done"}}\n',
    toolCalls,
    finalText: "done",
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
    },
    wallClockMs: 10,
    bootStateLines: [],
  };
}

describe("runtime parity", () => {
  it("cancels a failed mock-request response before falling back to transcript calls", async () => {
    const parentPrompt = "Delegate one bounded QA task to a subagent.";
    const tempRoot = await seedRuntimeParityTranscript({
      sessionId: "mock-runtime-parity-failure",
      sessionKey: "agent:qa:mock-runtime-parity-failure",
      messages: [{ role: "user", content: parentPrompt }],
    });
    const cancel = vi.fn(() => {
      throw new Error("cancel failed");
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new ReadableStream<Uint8Array>({ cancel }), {
            status: 503,
          }),
      ),
    );

    const cell = await captureRuntimeParityCell({
      runtime: "openclaw",
      gateway: { tempRoot },
      mockBaseUrl: "http://127.0.0.1:43123",
      scenarioResult: { status: "pass" },
      wallClockMs: 10,
    });

    expect(cancel).toHaveBeenCalledOnce();
    expect(cell.toolCalls).toEqual([]);
  });

  it("captures tool results from the canonical SQLite session transcript", async () => {
    const tempRoot = await seedRuntimeParityTranscript({
      sessionId: "capability-flip",
      sessionKey: "agent:qa:capability-flip",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Capability flip image check" }],
        },
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-image-1",
              name: "image_generate",
              arguments: { prompt: "QA lighthouse" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-image-1",
          toolName: "image_generate",
          content: [{ type: "text", text: "Image generation started" }],
        },
      ],
    });

    const cell = await captureRuntimeParityCell({
      runtime: "openclaw",
      gateway: { tempRoot },
      scenarioResult: { status: "pass" },
      wallClockMs: 10,
    });

    expect(cell.transcriptBytes).toContain('"role":"toolResult"');
    expect(cell.toolCalls).toHaveLength(1);
    expect(cell.toolCalls[0]).toMatchObject({ tool: "image_generate" });
    expect(cell.toolCalls[0]?.errorClass).toBeUndefined();
  });

  it("keeps a retry pass diagnostic from failing the captured cell", async () => {
    const cell = await captureRuntimeParityCell({
      runtime: "openclaw",
      gateway: {
        tempRoot: `/tmp/openclaw-qa-runtime-parity-missing-${process.pid}`,
      },
      scenarioResult: {
        status: "pass",
        details: "ok | passed on retry; first attempt: timed out after 20000ms",
      },
      wallClockMs: 10,
    });

    expect(cell.runtimeErrorClass).toBeUndefined();
  });

  it("still classifies terminal scenario failure diagnostics", async () => {
    const cell = await captureRuntimeParityCell({
      runtime: "openclaw",
      gateway: {
        tempRoot: `/tmp/openclaw-qa-runtime-parity-missing-${process.pid}`,
      },
      scenarioResult: {
        status: "fail",
        details: "timed out after 20000ms",
      },
      wallClockMs: 10,
    });

    expect(cell.runtimeErrorClass).toBe("timeout");
  });

  it("marks planned mock tool calls without outputs as missing tool results", async () => {
    const cell = await captureRuntimeParityWithMockRequests({
      requests: [{ plannedToolName: "read_file", plannedToolArgs: { path: "README.md" } }],
    });

    expect(cell.toolCalls).toHaveLength(1);
    expect(cell.toolCalls[0]).toMatchObject({
      tool: "read_file",
      errorClass: "tool-result-missing",
    });
  });

  it("keeps resolved mock tool calls eligible for no-drift parity", async () => {
    const cell = await captureRuntimeParityWithMockRequests({
      requests: [
        { plannedToolName: "read_file", plannedToolArgs: { path: "README.md" } },
        { toolOutput: JSON.stringify({ ok: true }) },
      ],
    });

    expect(cell.toolCalls).toHaveLength(1);
    expect(cell.toolCalls[0]?.errorClass).toBeUndefined();

    const result = await runRuntimeParityScenario({
      scenarioId: "resolved-tool",
      runCell: async (runtime) => ({
        scenarioStatus: "pass",
        cell: { ...cell, runtime },
      }),
    });

    expect(result.drift).toBe("none");
    expect(result.runtimeParityUsage).toEqual({
      expectation: "assistant-message-required",
    });
  });

  it("preserves explicit usage-not-applicable metadata on parity results", async () => {
    const result = await runRuntimeParityScenario({
      scenarioId: "local-fixture",
      runtimeParityUsage: {
        expectation: "not-applicable",
        reason: " Local fixture only; no assistant turn runs. ",
      },
      runCell: async (runtime) => ({
        scenarioStatus: "pass",
        cell: makeRuntimeParityCell(runtime, []),
      }),
    });

    expect(result.runtimeParityUsage).toEqual({
      expectation: "not-applicable",
      reason: "Local fixture only; no assistant turn runs.",
    });
  });

  it("defaults malformed usage metadata to assistant-message-required", () => {
    expect(resolveRuntimeParityUsagePolicy({ expectation: "not-applicable" })).toEqual({
      expectation: "assistant-message-required",
    });
    expect(
      resolveRuntimeParityUsagePolicy({ expectation: "not-applicable", reason: "   " }),
    ).toEqual({ expectation: "assistant-message-required" });
  });

  it("classifies planned-only matching tool calls as failure-mode", async () => {
    const cell = await captureRuntimeParityWithMockRequests({
      requests: [{ plannedToolName: "read_file", plannedToolArgs: { path: "README.md" } }],
    });

    const result = await runRuntimeParityScenario({
      scenarioId: "planned-only-tool",
      runCell: async (runtime) => ({
        scenarioStatus: "pass",
        cell: { ...cell, runtime },
      }),
    });

    expect(result).toMatchObject({
      drift: "failure-mode",
      driftDetails: "at least one runtime planned a tool call without a tool result",
    });
  });

  it("treats matching controlled tool errors as equivalent results", async () => {
    const result = await runRuntimeParityScenario({
      scenarioId: "matching-tool-errors",
      runCell: async (runtime) => ({
        scenarioStatus: "pass",
        cell: {
          ...makeRuntimeParityCell(runtime, [
            {
              tool: "web_search",
              argsHash: "same-args",
              resultHash: runtime === "openclaw" ? "validation-error" : "provider-error",
              errorClass: "tool-result-error",
            },
          ]),
          ...(runtime === "codex" ? { runtimeErrorClass: "tool-error" } : {}),
        },
      }),
    });

    expect(result.drift).toBe("none");
    expect(isRuntimeParityResultPass(result)).toBe(true);
  });

  it("does not mask runtime cell scenario failures behind drift", async () => {
    const result = await runRuntimeParityScenario({
      scenarioId: "failed-cell-with-drift",
      runCell: async (runtime) => ({
        scenarioStatus: runtime === "codex" ? "fail" : "pass",
        cell: makeRuntimeParityCell(runtime, [
          {
            tool: "web_search",
            argsHash: "same-args",
            resultHash: runtime === "codex" ? "failed-result" : "ok-result",
          },
        ]),
      }),
    });

    expect(result).toMatchObject({
      drift: "failure-mode",
      driftDetails: "scenario status differs (pass vs fail)",
    });
    expect(isRuntimeParityResultPass(result)).toBe(false);
  });

  it("prefers transcript tool results when mock debug rows repeat an incomplete call", async () => {
    const cell = await captureRuntimeParityWithMockRequests({
      requests: [
        { plannedToolName: "image_generate", plannedToolArgs: { prompt: "same" } },
        { plannedToolName: "image_generate", plannedToolArgs: { prompt: "same" } },
      ],
      messages: [
        { role: "user", content: "Delegate one bounded QA task to a subagent." },
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "image-call",
              name: "image_generate",
              arguments: { prompt: "same" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "image-call",
          toolName: "image_generate",
          content: [{ type: "text", text: "Image generation started" }],
        },
      ],
    });

    expect(cell.toolCalls).toEqual([expect.objectContaining({ tool: "image_generate" })]);
    expect(cell.toolCalls[0]?.errorClass).toBeUndefined();
  });

  it("accepts a fresh scenario MEDIA result for terminal image tools", async () => {
    const cell = await captureRuntimeParityWithMockRequests({
      requests: [{ plannedToolName: "image_generate", plannedToolArgs: { prompt: "same" } }],
      scenarioResult: {
        status: "pass",
        steps: [
          {
            status: "pass",
            details: "QA-CAPABILITY-1234\nimage_generate=true\nMEDIA:/tmp/qa-image.png",
          },
        ],
      },
    });

    expect(cell.toolCalls[0]?.errorClass).toBeUndefined();
  });

  it("requires call-linked passed step evidence for terminal image results", async () => {
    const proven = await captureRuntimeParityWithMockRequests({
      requests: [{ plannedToolName: "image_generate" }],
      scenarioResult: {
        status: "pass",
        steps: [
          {
            status: "pass",
            details: "QA-CAPABILITY-1234\nimage_generate=true\nMEDIA:/tmp/qa-image.png",
          },
        ],
      },
    });
    const unrelated = await captureRuntimeParityWithMockRequests({
      requests: [{ plannedToolName: "image_generate" }],
      scenarioResult: {
        status: "pass",
        steps: [{ status: "pass", details: "MEDIA:/tmp/unrelated-screenshot.png" }],
      },
    });
    const failed = await captureRuntimeParityWithMockRequests({
      requests: [{ plannedToolName: "image_generate" }],
      scenarioResult: {
        status: "pass",
        steps: [
          {
            status: "fail",
            details: "image_generate=true\nMEDIA:/tmp/failed-image.png",
          },
        ],
      },
    });

    expect(proven.toolCalls[0]?.errorClass).toBeUndefined();
    expect(unrelated.toolCalls[0]?.errorClass).toBe("tool-result-missing");
    expect(failed.toolCalls[0]?.errorClass).toBe("tool-result-missing");
  });

  it("preserves a missing image result when MEDIA may belong to another call", async () => {
    const cell = await captureRuntimeParityWithMockRequests({
      requests: [
        { plannedToolName: "image_generate", plannedToolArgs: { prompt: "first" } },
        { toolOutput: JSON.stringify({ ok: true }) },
        { plannedToolName: "image_generate", plannedToolArgs: { prompt: "second" } },
      ],
      scenarioResult: {
        status: "pass",
        steps: [
          {
            status: "pass",
            details: "image_generate=true\nMEDIA:/tmp/qa-image.png",
          },
        ],
      },
    });

    expect(cell.toolCalls.map((toolCall) => toolCall.errorClass)).toEqual([
      undefined,
      "tool-result-missing",
    ]);
  });

  it("preserves missing image results when capture sources disagree on call count", async () => {
    const cell = await captureRuntimeParityWithMockRequests({
      requests: [{ plannedToolName: "image_generate", plannedToolArgs: { prompt: "first" } }],
      messages: [
        { role: "user", content: "Delegate one bounded QA task to a subagent." },
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "first-image",
              name: "image_generate",
              arguments: { prompt: "first" },
            },
            {
              type: "toolCall",
              id: "second-image",
              name: "image_generate",
              arguments: { prompt: "second" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "first-image",
          toolName: "image_generate",
          content: [{ type: "text", text: "Image generation started" }],
        },
      ],
      scenarioResult: {
        status: "pass",
        steps: [
          {
            status: "pass",
            details: "image_generate=true\nMEDIA:/tmp/qa-image.png",
          },
        ],
      },
    });

    expect(cell.toolCalls).toEqual([
      expect.objectContaining({ errorClass: "tool-result-missing" }),
    ]);
  });

  it("scopes process-global mock requests to the parent session prompt", async () => {
    const cell = await captureRuntimeParityWithMockRequests({
      messages: [
        { role: "user", content: "Delegate one bounded QA task to a subagent." },
        {
          role: "user",
          content: "Continue the bounded QA task with the retained child result.",
        },
      ],
      requests: [
        {
          prompt: "Fanout worker alpha: inspect the QA workspace and finish with exactly ALPHA-OK.",
          allInputText:
            "Delegate one bounded QA task to a subagent. Fanout worker alpha: inspect the QA workspace and finish with exactly ALPHA-OK.",
          plannedToolName: "read",
        },
        {
          prompt: "Delegate one bounded QA task to a subagent.",
          allInputText: "Delegate one bounded QA task to a subagent.",
          plannedToolName: "sessions_spawn",
        },
        {
          prompt: "Continue the bounded QA task with the retained child result.",
          allInputText:
            "Delegate one bounded QA task to a subagent. Continue the bounded QA task with the retained child result.",
          plannedToolName: "sessions_spawn",
        },
        {
          prompt: undefined,
          allInputText: "Inspect the QA workspace and return one concise protocol note.",
          plannedToolName: "read",
        },
        {
          prompt: "Delegate one bounded QA task to a subagent.",
          allInputText: "Delegate one bounded QA task to a subagent. Tool result: child accepted.",
          toolOutput: "child accepted",
        },
      ],
    });

    expect(cell.toolCalls).toHaveLength(2);
    expect(cell.toolCalls.map((toolCall) => toolCall.tool)).toEqual([
      "sessions_spawn",
      "sessions_spawn",
    ]);
    expect(cell.toolCalls.map((toolCall) => toolCall.errorClass)).toEqual([
      undefined,
      "tool-result-missing",
    ]);
  });
});
