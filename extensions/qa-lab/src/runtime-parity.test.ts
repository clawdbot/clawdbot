// Qa Lab tests cover runtime parity classification behavior.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { resolveStorePath, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import {
  appendSqliteTrajectoryRuntimeEvents,
  formatSqliteSessionFileMarker,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stableHash } from "./parity-shared.js";
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
  heartbeatIsolatedBaseSessionKey?: string;
  messages: Array<Record<string, unknown>>;
  sessionId: string;
  sessionKey: string;
  tempRoot?: string;
  trajectoryEvents?: Array<{
    data?: Record<string, unknown>;
    type: string;
  }>;
  updatedAt?: number;
}) {
  const tempRoot = params.tempRoot ?? (await tempDirs.makeTempDir("openclaw-qa-runtime-parity-"));
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
      updatedAt: params.updatedAt ?? 100,
      ...(params.heartbeatIsolatedBaseSessionKey
        ? { heartbeatIsolatedBaseSessionKey: params.heartbeatIsolatedBaseSessionKey }
        : {}),
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
  if (params.trajectoryEvents?.length) {
    appendSqliteTrajectoryRuntimeEvents(
      { agentId: "qa", env, sessionId: params.sessionId, storePath },
      params.trajectoryEvents.map((event, index) => ({
        traceSchema: "openclaw-trajectory",
        schemaVersion: 1,
        traceId: params.sessionId,
        source: "runtime",
        type: event.type,
        ts: new Date(index + 1).toISOString(),
        seq: index + 1,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        runId: "run-1",
        data: event.data,
      })),
    );
  }
  return tempRoot;
}

async function captureRuntimeParityWithMockRequests(params: {
  messages?: Array<Record<string, unknown>>;
  requests: Array<Record<string, unknown>>;
  scenarioResult?: Parameters<typeof captureRuntimeParityCell>[0]["scenarioResult"];
  trajectoryEvents?: Array<{
    data?: Record<string, unknown>;
    type: string;
  }>;
}) {
  const parentPrompt = "Delegate one bounded QA task to a subagent.";
  const tempRoot = await seedRuntimeParityTranscript({
    sessionId: "mock-runtime-parity",
    sessionKey: "agent:qa:mock-runtime-parity",
    messages: params.messages ?? [{ role: "user", content: parentPrompt }],
    trajectoryEvents: params.trajectoryEvents,
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

  it("captures native tool execution from the canonical SQLite trajectory", async () => {
    const cell = await captureRuntimeParityWithMockRequests({
      messages: [],
      requests: [],
      trajectoryEvents: [
        {
          type: "tool.call",
          data: {
            toolCallId: "search-1",
            name: "web_search",
            arguments: { query: "OpenClaw runtime parity fixed query" },
          },
        },
        {
          type: "tool.result",
          data: {
            toolCallId: "search-1",
            name: "web_search",
            status: "completed",
            isError: false,
            result: {
              status: "completed",
              query: "OpenClaw runtime parity fixed query",
            },
          },
        },
      ],
    });

    expect(cell.toolCalls).toEqual([expect.objectContaining({ tool: "web_search" })]);
    expect(cell.toolCalls[0]?.errorClass).toBeUndefined();
    expect(cell.providerPlanToolCalls).toEqual([]);
  });

  it("merges trajectory-only calls without duplicating transcript calls", async () => {
    const tempRoot = await seedRuntimeParityTranscript({
      sessionId: "mixed-runtime-tools",
      sessionKey: "agent:qa:mixed-runtime-tools",
      messages: [
        { role: "user", content: "Read the file, run the command, then search." },
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "read-1",
              name: "read",
              arguments: { path: "README.md" },
            },
            {
              type: "toolCall",
              id: "exec-1",
              name: "exec",
              arguments: { command: "pwd" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "read-1",
          toolName: "read",
          content: [{ type: "text", text: "README contents" }],
        },
      ],
      trajectoryEvents: [
        {
          type: "tool.result",
          data: {
            toolCallId: "exec-1",
            name: "exec",
            success: true,
            contentItems: [{ type: "text", text: "/workspace" }],
          },
        },
        {
          type: "tool.call",
          data: {
            toolCallId: "search-1",
            name: "web_search",
            arguments: { query: "OpenClaw runtime parity fixed query" },
          },
        },
        {
          type: "tool.result",
          data: {
            toolCallId: "search-1",
            name: "web_search",
            status: "completed",
            result: { status: "completed" },
          },
        },
      ],
    });

    const cell = await captureRuntimeParityCell({
      runtime: "codex",
      gateway: { tempRoot },
      scenarioResult: { status: "pass" },
      wallClockMs: 10,
    });

    expect(cell.toolCalls.map((toolCall) => toolCall.tool)).toEqual(["read", "exec", "web_search"]);
    expect(cell.toolCalls[0]?.errorClass).toBeUndefined();
    expect(cell.toolCalls[1]?.errorClass).toBeUndefined();
    expect(cell.toolCalls[1]?.argsHash).toBe(stableHash({ command: "pwd" }));
  });

  it("keeps distinct same-tool calls with identical arguments", async () => {
    const tempRoot = await seedRuntimeParityTranscript({
      sessionId: "distinct-web-searches",
      sessionKey: "agent:qa:distinct-web-searches",
      messages: [
        { role: "user", content: "Search for both QA markers." },
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              name: "web_search",
              arguments: { query: "same marker" },
            },
          ],
        },
        {
          role: "toolResult",
          toolName: "web_search",
          content: [{ type: "text", text: "result A" }],
        },
      ],
      trajectoryEvents: [
        {
          type: "tool.call",
          data: {
            toolCallId: "search-b",
            name: "web_search",
            arguments: { query: "same marker" },
          },
        },
        {
          type: "tool.result",
          data: {
            toolCallId: "search-b",
            name: "web_search",
            status: "completed",
            result: { status: "completed", query: "same marker" },
          },
        },
      ],
    });

    const cell = await captureRuntimeParityCell({
      runtime: "codex",
      gateway: { tempRoot },
      scenarioResult: { status: "pass" },
      wallClockMs: 10,
    });

    expect(cell.toolCalls.map((toolCall) => toolCall.tool)).toEqual(["web_search", "web_search"]);
    expect(cell.toolCalls[0]?.argsHash).toBe(cell.toolCalls[1]?.argsHash);
  });

  it("skips newer trajectory-only heartbeat sessions", async () => {
    const now = Date.now();
    const tempRoot = await seedRuntimeParityTranscript({
      sessionId: "web-search-session",
      sessionKey: "agent:qa:web-search-session",
      messages: [],
      updatedAt: now - 1_000,
      trajectoryEvents: [
        {
          type: "tool.call",
          data: {
            toolCallId: "search-1",
            name: "web_search",
            arguments: { query: "release marker" },
          },
        },
        {
          type: "tool.result",
          data: {
            toolCallId: "search-1",
            name: "web_search",
            status: "completed",
            result: { status: "completed" },
          },
        },
      ],
    });
    await seedRuntimeParityTranscript({
      tempRoot,
      sessionId: "heartbeat-session",
      sessionKey: "agent:qa:main:heartbeat",
      heartbeatIsolatedBaseSessionKey: "agent:qa:main",
      messages: [],
      updatedAt: now,
      trajectoryEvents: [
        {
          type: "tool.call",
          data: {
            toolCallId: "heartbeat-1",
            name: "web_search",
            arguments: { query: "heartbeat background search" },
          },
        },
        {
          type: "tool.result",
          data: {
            toolCallId: "heartbeat-1",
            name: "web_search",
            success: true,
            result: { status: "completed" },
          },
        },
      ],
    });

    const cell = await captureRuntimeParityCell({
      runtime: "codex",
      gateway: { tempRoot },
      scenarioResult: { status: "pass" },
      wallClockMs: 10,
    });

    expect(cell.toolCalls.map((toolCall) => toolCall.tool)).toEqual(["web_search"]);
    expect(cell.toolCalls[0]?.argsHash).toBe(stableHash({ query: "release marker" }));
  });

  it("captures fixture-owned evidence across multiple root sessions", async () => {
    const now = Date.now();
    const tempRoot = await seedRuntimeParityTranscript({
      sessionId: "session-status-happy",
      sessionKey: "agent:qa:runtime-tool:session_status:happy",
      messages: [{ role: "user", content: "tool search qa check target=session_status" }],
      updatedAt: now - 1_000,
      trajectoryEvents: [
        {
          type: "tool.call",
          data: {
            toolCallId: "session-status-1",
            name: "session_status",
            arguments: {},
          },
        },
        {
          type: "tool.result",
          data: {
            toolCallId: "session-status-1",
            name: "session_status",
            status: "completed",
            result: { status: "completed" },
          },
        },
      ],
    });
    await seedRuntimeParityTranscript({
      tempRoot,
      sessionId: "session-status-failure",
      sessionKey: "agent:qa:runtime-tool:session_status:failure",
      messages: [
        {
          role: "user",
          content: "tool search qa failure target=session_status",
        },
      ],
      updatedAt: now,
    });
    await seedRuntimeParityTranscript({
      tempRoot,
      sessionId: "unrelated-newer-root",
      sessionKey: "agent:qa:unrelated-newer-root",
      messages: [{ role: "user", content: "Unrelated setup." }],
      updatedAt: now + 1_000,
    });

    const cell = await captureRuntimeParityCell({
      runtime: "codex",
      gateway: { tempRoot },
      scenarioResult: {
        status: "pass",
        steps: [
          {
            status: "pass",
            details: [
              "RUNTIME_PARITY_SESSION_KEY=agent:qa:runtime-tool:session_status:happy",
              "RUNTIME_PARITY_SESSION_KEY=agent:qa:runtime-tool:session_status:failure",
            ].join("\n"),
          },
        ],
      },
      wallClockMs: 10,
    });

    expect(cell.transcriptBytes).toContain("target=session_status");
    expect(cell.transcriptBytes).toContain("failure target=session_status");
    expect(cell.transcriptBytes).not.toContain("Unrelated setup.");
    expect(cell.toolCalls).toEqual([expect.objectContaining({ tool: "session_status" })]);

    const missingCell = await captureRuntimeParityCell({
      runtime: "codex",
      gateway: { tempRoot },
      scenarioResult: {
        status: "fail",
        details: "RUNTIME_PARITY_SESSION_KEY=agent:qa:runtime-tool:missing:happy",
      },
      wallClockMs: 10,
    });
    expect(missingCell.transcriptBytes).toBe("");
    expect(missingCell.toolCalls).toEqual([]);
  });
  it("keeps an explicitly identified orphan result separate", async () => {
    const tempRoot = await seedRuntimeParityTranscript({
      sessionId: "orphan-trajectory-result",
      sessionKey: "agent:qa:orphan-trajectory-result",
      messages: [],
      trajectoryEvents: [
        {
          type: "tool.call",
          data: {
            toolCallId: "read-pending",
            name: "read",
            arguments: { path: "README.md" },
          },
        },
        {
          type: "tool.result",
          data: {
            toolCallId: "read-orphan",
            name: "read",
            success: true,
            contentItems: [{ type: "text", text: "orphan result" }],
          },
        },
      ],
    });

    const cell = await captureRuntimeParityCell({
      runtime: "codex",
      gateway: { tempRoot },
      scenarioResult: { status: "pass" },
      wallClockMs: 10,
    });

    expect(cell.toolCalls.map((toolCall) => toolCall.errorClass)).toEqual([
      "tool-result-missing",
      undefined,
    ]);
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

  it("keeps planned mock calls diagnostic instead of promoting them to runtime calls", async () => {
    const cell = await captureRuntimeParityWithMockRequests({
      requests: [{ plannedToolName: "read_file", plannedToolArgs: { path: "README.md" } }],
    });

    expect(cell.toolCalls).toEqual([]);
    expect(cell.providerPlanToolCalls).toHaveLength(1);
    expect(cell.providerPlanToolCalls?.[0]).toMatchObject({
      tool: "read_file",
      errorClass: "tool-result-missing",
    });
  });

  it("records resolved mock calls as provider-plan evidence", async () => {
    const cell = await captureRuntimeParityWithMockRequests({
      requests: [
        { plannedToolName: "read_file", plannedToolArgs: { path: "README.md" } },
        { toolOutput: JSON.stringify({ ok: true }) },
      ],
    });

    expect(cell.toolCalls).toEqual([]);
    expect(cell.providerPlanToolCalls).toHaveLength(1);
    expect(cell.providerPlanToolCalls?.[0]?.errorClass).toBeUndefined();

    const result = await runRuntimeParityScenario({
      scenarioId: "resolved-tool",
      runCell: async (runtime) => ({
        status: "pass",
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
        status: "pass",
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

  it("does not classify planned-only provider evidence as a runtime failure", async () => {
    const cell = await captureRuntimeParityWithMockRequests({
      requests: [{ plannedToolName: "read_file", plannedToolArgs: { path: "README.md" } }],
    });

    const result = await runRuntimeParityScenario({
      scenarioId: "planned-only-tool",
      runCell: async (runtime) => ({
        status: "pass",
        cell: { ...cell, runtime },
      }),
    });

    expect(result.drift).toBe("none");
    expect(isRuntimeParityResultPass(result)).toBe(true);
  });

  it("treats matching controlled tool errors as equivalent results", async () => {
    const result = await runRuntimeParityScenario({
      scenarioId: "matching-tool-errors",
      runCell: async (runtime) => ({
        status: "pass",
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
        status: runtime === "codex" ? "fail" : "pass",
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
      driftDetails: "runtime-pair cell status differs (pass vs fail)",
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
      messages: [
        { role: "user", content: "Generate the QA image." },
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
      ],
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

  it("keeps multiple image provider plans from invalidating one proven runtime call", async () => {
    const cell = await captureRuntimeParityWithMockRequests({
      requests: [
        { plannedToolName: "image_generate", plannedToolArgs: { prompt: "first" } },
        { plannedToolName: "image_generate", plannedToolArgs: { prompt: "second" } },
      ],
      messages: [
        { role: "user", content: "Generate the QA image." },
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "image-call",
              name: "image_generate",
              arguments: { prompt: "runtime" },
            },
          ],
        },
      ],
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
    expect(cell.providerPlanToolCalls).toHaveLength(2);
  });

  it("requires call-linked passed step evidence for terminal image results", async () => {
    const proven = await captureRuntimeParityWithMockRequests({
      requests: [{ plannedToolName: "image_generate", plannedToolArgs: { prompt: "same" } }],
      messages: [
        { role: "user", content: "Generate the QA image." },
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
      ],
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
      requests: [{ plannedToolName: "image_generate", plannedToolArgs: { prompt: "same" } }],
      messages: [
        { role: "user", content: "Generate the QA image." },
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
      ],
      scenarioResult: {
        status: "pass",
        steps: [{ status: "pass", details: "MEDIA:/tmp/unrelated-screenshot.png" }],
      },
    });
    const failed = await captureRuntimeParityWithMockRequests({
      requests: [{ plannedToolName: "image_generate", plannedToolArgs: { prompt: "same" } }],
      messages: [
        { role: "user", content: "Generate the QA image." },
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
      ],
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

  it("preserves incomplete image provider plans as diagnostic evidence", async () => {
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

    expect(cell.toolCalls).toEqual([]);
    expect(cell.providerPlanToolCalls?.map((toolCall) => toolCall.errorClass)).toEqual([
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

    expect(cell.toolCalls.map((toolCall) => toolCall.errorClass)).toEqual([
      undefined,
      "tool-result-missing",
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

    expect(cell.toolCalls).toEqual([]);
    expect(cell.providerPlanToolCalls).toHaveLength(2);
    expect(cell.providerPlanToolCalls?.map((toolCall) => toolCall.tool)).toEqual([
      "sessions_spawn",
      "sessions_spawn",
    ]);
    expect(cell.providerPlanToolCalls?.map((toolCall) => toolCall.errorClass)).toEqual([
      undefined,
      "tool-result-missing",
    ]);
  });
});
