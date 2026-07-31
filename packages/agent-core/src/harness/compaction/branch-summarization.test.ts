import { describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream } from "../../llm.js";
import type { AssistantMessage, Model, StreamFn } from "../../llm.js";
import type { AgentMessage } from "../../types.js";
import type { SessionTreeEntry } from "../types.js";
import { generateBranchSummary, prepareBranchEntries } from "./branch-summarization.js";

function createModel(contextWindow: number, maxTokens = 8000): Model {
  return {
    id: "branch-summary-model",
    name: "Branch Summary Model",
    api: "test-api",
    provider: "test-provider",
    baseUrl: "https://example.test",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
  };
}

function createMessageEntry(message: AgentMessage, index: number): SessionTreeEntry {
  return {
    type: "message",
    id: `entry-${index}`,
    parentId: index === 0 ? null : `entry-${index - 1}`,
    timestamp: new Date(message.timestamp).toISOString(),
    message,
  };
}

function createResponse(model: Model): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "Branch summary" }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
  };
}

function createCapturingStream(model: Model) {
  let prompt = "";
  let systemPrompt = "";
  let maxOutputTokens: number | undefined;
  const streamFn = vi.fn<StreamFn>((_model, context, options) => {
    const userMessage = context.messages[0];
    if (!userMessage || userMessage.role !== "user") {
      throw new Error("expected a user message containing the branch summary prompt");
    }
    prompt =
      typeof userMessage.content === "string"
        ? userMessage.content
        : userMessage.content.map((block) => (block.type === "text" ? block.text : "")).join("");
    systemPrompt = context.systemPrompt ?? "";
    maxOutputTokens = options?.maxTokens;
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "done", reason: "stop", message: createResponse(model) });
    stream.end();
    return stream;
  });
  return {
    streamFn,
    readCapture: () => ({ prompt, systemPrompt, maxOutputTokens }),
  };
}

function createLongBranchEntries(count: number): SessionTreeEntry[] {
  return Array.from({ length: count }, (_, index) =>
    createMessageEntry(
      { role: "user", content: `turn-${index} ${"x".repeat(3500)}`, timestamp: index + 1 },
      index,
    ),
  );
}

describe("branch summarization", () => {
  it("retains failed tool results when preparing a branch", () => {
    const entries: SessionTreeEntry[] = [
      createMessageEntry({ role: "user", content: "run deployment", timestamp: 1 }, 0),
      createMessageEntry(
        {
          role: "toolResult",
          toolCallId: "deploy-call",
          toolName: "deploy",
          content: [{ type: "text", text: "ERROR: deployment timed out" }],
          details: { privateDiagnostic: "never send internal metadata" },
          isError: true,
          timestamp: 2,
        },
        1,
      ),
    ];

    const preparation = prepareBranchEntries(entries);

    expect(preparation.messages.map((message) => message.role)).toEqual(["user", "toolResult"]);
  });

  it("summarizes tool failures without exposing private result details", async () => {
    const model = createModel(128_000);
    const capture = createCapturingStream(model);
    const entries: SessionTreeEntry[] = [
      createMessageEntry({ role: "user", content: "run deployment", timestamp: 1 }, 0),
      createMessageEntry(
        {
          role: "toolResult",
          toolCallId: "deploy-call",
          toolName: "deploy",
          content: [{ type: "text", text: "ERROR: deployment timed out" }],
          details: { privateDiagnostic: "never send internal metadata" },
          isError: true,
          timestamp: 2,
        },
        1,
      ),
    ];

    const result = await generateBranchSummary(entries, {
      model,
      apiKey: "test-key",
      signal: new AbortController().signal,
      streamFn: capture.streamFn,
    });

    expect(result.ok).toBe(true);
    expect(capture.readCapture().prompt).toContain("ERROR: deployment timed out");
    expect(capture.readCapture().prompt).not.toContain("never send internal metadata");
    expect(capture.readCapture().maxOutputTokens).toBe(2048);
  });

  it("bounds history when the default reservation exceeds a small context window", async () => {
    const model = createModel(8192);
    const capture = createCapturingStream(model);

    const result = await generateBranchSummary(createLongBranchEntries(12), {
      model,
      apiKey: "test-key",
      signal: new AbortController().signal,
      streamFn: capture.streamFn,
    });

    const { prompt, systemPrompt, maxOutputTokens } = capture.readCapture();
    expect(result.ok).toBe(true);
    expect(prompt).toContain("turn-11");
    expect(prompt).not.toContain("turn-0");
    expect(maxOutputTokens).toBe(2048);
    expect(
      Math.ceil((prompt.length + systemPrompt.length) / 4) + (maxOutputTokens ?? 0),
    ).toBeLessThanOrEqual(model.contextWindow);
  });

  it("preserves usable caller reservations larger than half the context window", async () => {
    const model = createModel(8192);
    const capture = createCapturingStream(model);

    const result = await generateBranchSummary(createLongBranchEntries(12), {
      model,
      apiKey: "test-key",
      signal: new AbortController().signal,
      reserveTokens: 6144,
      streamFn: capture.streamFn,
    });

    expect(result.ok).toBe(true);
    expect(capture.readCapture().prompt).toContain("turn-11");
    expect(capture.readCapture().prompt).not.toContain("turn-9");
    expect(capture.readCapture().maxOutputTokens).toBe(2048);
  });

  it("scales output headroom to narrow model contexts and model output caps", async () => {
    const model = createModel(4096, 512);
    const capture = createCapturingStream(model);

    const result = await generateBranchSummary(createLongBranchEntries(8), {
      model,
      apiKey: "test-key",
      signal: new AbortController().signal,
      streamFn: capture.streamFn,
    });

    const { prompt, systemPrompt, maxOutputTokens } = capture.readCapture();
    expect(result.ok).toBe(true);
    expect(maxOutputTokens).toBe(512);
    expect(prompt).not.toContain("turn-0");
    expect(
      Math.ceil((prompt.length + systemPrompt.length) / 4) + (maxOutputTokens ?? 0),
    ).toBeLessThanOrEqual(model.contextWindow);
  });
});
