import { describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream } from "../../llm.js";
import type { AssistantMessage, Model, StreamFn } from "../../llm.js";
import type { AgentMessage } from "../../types.js";
import type { SessionTreeEntry } from "../types.js";
import { generateBranchSummary, prepareBranchEntries } from "./branch-summarization.js";

function createModel(contextWindow: number, maxTokens = 8000): Model & { contextWindow: number } {
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

function createResponse(
  model: Model,
  content: AssistantMessage["content"] = [{ type: "text", text: "Branch summary" }],
): AssistantMessage {
  return {
    role: "assistant",
    content,
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

function createResponseStream(model: Model, content?: AssistantMessage["content"]) {
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "done", reason: "stop", message: createResponse(model, content) });
  stream.end();
  return stream;
}

function createCapturingStream(model: Model, responseContent?: AssistantMessage["content"]) {
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
    return createResponseStream(model, responseContent);
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
  it("consumes the decorated stream before reading its result", async () => {
    const model = createModel(128_000);
    let consumed = false;
    const streamFn = vi.fn<StreamFn>(() => ({
      [Symbol.asyncIterator]() {
        return {
          async next() {
            consumed = true;
            return { done: true as const, value: undefined };
          },
        };
      },
      async result() {
        if (!consumed) {
          throw new Error("stream result read before iteration");
        }
        return createResponse(model);
      },
    }));

    await generateBranchSummary(
      [createMessageEntry({ role: "user", content: "summarize this branch", timestamp: 1 }, 0)],
      {
        model,
        apiKey: "test-key",
        signal: new AbortController().signal,
        streamFn,
      },
    );

    expect(consumed).toBe(true);
  });

  it.each([
    ["empty", []],
    ["whitespace-only", [{ type: "text" as const, text: " \n\t " }]],
    ["reasoning-only", [{ type: "thinking" as const, thinking: "internal reasoning" }]],
  ])("rejects %s model output before creating a summary", async (_name, content) => {
    const model = createModel(128_000);
    const streamFn = vi.fn<StreamFn>(() => createResponseStream(model, content));
    const entries = [
      createMessageEntry({ role: "user", content: "summarize this branch", timestamp: 1 }, 0),
    ];

    const result = await generateBranchSummary(entries, {
      model,
      apiKey: "test-key",
      signal: new AbortController().signal,
      streamFn,
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected invalid branch summary output to fail");
    }
    expect(result.error).toMatchObject({
      name: "BranchSummaryError",
      code: "summarization_failed",
      message: "Branch summary failed: model returned no summary text",
    });
  });

  it("preserves valid summary whitespace, preamble, and file metadata", async () => {
    const model = createModel(128_000);
    const summaryText = "  Branch summary body  \ncontinues ";
    const capture = createCapturingStream(model, [
      { type: "text", text: "  Branch summary body  " },
      { type: "text", text: "continues " },
    ]);
    const entries: SessionTreeEntry[] = [
      createMessageEntry({ role: "user", content: "inspect files", timestamp: 1 }, 0),
      createMessageEntry(
        createResponse(model, [
          { type: "thinking", thinking: "PRIVATE_BRANCH_REASONING" },
          { type: "text", text: "Visible branch answer" },
          { type: "toolCall", id: "read-1", name: "read", arguments: { path: "src/read.ts" } },
          {
            type: "toolCall",
            id: "write-1",
            name: "write",
            arguments: { path: "src/write.ts" },
          },
        ]),
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
    if (!result.ok) {
      throw result.error;
    }
    expect(result.value).toEqual({
      summary: `The user explored a different conversation branch before returning here.
Summary of that exploration:

${summaryText}

<read-files>
src/read.ts
</read-files>

<modified-files>
src/write.ts
</modified-files>`,
      readFiles: ["src/read.ts"],
      modifiedFiles: ["src/write.ts"],
    });
    expect(capture.readCapture().prompt).toContain("[Assistant]: Visible branch answer");
    expect(capture.readCapture().prompt).toContain(
      '[Assistant tool calls]: read(path="src/read.ts"); write(path="src/write.ts")',
    );
    expect(capture.readCapture().prompt).not.toContain("PRIVATE_BRANCH_REASONING");
  });

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

  it.each(["shell", "custom"] as const)(
    "preserves earlier branch context while excluding private %s activity",
    async (kind) => {
      const model = createModel(8192);
      const capture = createCapturingStream(model);
      const excludedMessage: AgentMessage =
        kind === "shell"
          ? {
              role: "bashExecution",
              command: "private command",
              output: `private output marker ${"x".repeat(80_000)}`,
              exitCode: 0,
              cancelled: false,
              truncated: false,
              timestamp: 2,
              excludeFromContext: true,
            }
          : {
              role: "custom",
              customType: "openclaw.operator-activity",
              content: `private output marker ${"x".repeat(80_000)}`,
              display: true,
              timestamp: 2,
              excludeFromContext: true,
            };
      const entries: SessionTreeEntry[] = [
        createMessageEntry(
          { role: "user", content: "important original request", timestamp: 1 },
          0,
        ),
        createMessageEntry(excludedMessage, 1),
        createMessageEntry({ role: "user", content: "continue branch", timestamp: 3 }, 2),
      ];

      const preparation = prepareBranchEntries(entries, 100);
      expect(preparation.messages).toMatchObject([
        { role: "user", content: "important original request" },
        { role: "user", content: "continue branch" },
      ]);
      expect(preparation.totalTokens).toBeLessThan(100);

      const visibleEntries = entries.map((entry, index) =>
        index === 1
          ? createMessageEntry({ ...excludedMessage, excludeFromContext: false }, index)
          : entry,
      );
      expect(prepareBranchEntries(visibleEntries, 100).messages).toMatchObject([
        { role: "user", content: "continue branch" },
      ]);

      const result = await generateBranchSummary(entries, {
        model,
        apiKey: "test-key",
        signal: new AbortController().signal,
        streamFn: capture.streamFn,
      });

      expect(result.ok).toBe(true);
      expect(capture.readCapture().prompt).toContain("important original request");
      expect(capture.readCapture().prompt).toContain("continue branch");
      expect(capture.readCapture().prompt).not.toContain("private command");
      expect(capture.readCapture().prompt).not.toContain("private output marker");
      expect(JSON.stringify(entries)).toContain("private output marker");
    },
  );

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
