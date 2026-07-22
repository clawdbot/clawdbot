// Verifies Claude CLI model diagnostics stay listener-gated and memory-bounded.
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPrivateData,
} from "../../infra/diagnostic-events.js";
import type { CliOutput } from "../cli-output.js";
import { createClaudeCliModelCallDiagnostics } from "./model-call-diagnostics.js";
import type { PreparedCliRunContext } from "./types.js";

const CONTENT_LIMIT_BYTES = 128 * 1024;

function createContext(): PreparedCliRunContext {
  return {
    backendResolved: { id: "claude-cli", modelProvider: "anthropic" },
    contextWindowInfo: undefined,
    normalizedModel: "claude-test",
    params: {
      config: {
        diagnostics: {
          enabled: true,
          otel: {
            enabled: true,
            traces: true,
            captureContent: true,
          },
        },
      },
      runId: "claude-diagnostics-test",
      sessionId: "session-test",
    },
  } as PreparedCliRunContext;
}

describe("Claude CLI model-call diagnostics", () => {
  beforeEach(() => {
    resetDiagnosticEventsForTest();
  });

  afterEach(() => {
    resetDiagnosticEventsForTest();
  });

  it("does not create diagnostics without an active event listener", () => {
    expect(
      createClaudeCliModelCallDiagnostics({
        context: createContext(),
        prompt: "hello",
        transport: "stdio",
      }),
    ).toBeUndefined();
  });

  it("bounds large prompt and assistant content during a burst", async () => {
    let completedPrivateData: DiagnosticEventPrivateData | undefined;
    const stop = onTrustedInternalDiagnosticEvent((event, _metadata, privateData) => {
      if (event.type === "model.call.completed") {
        completedPrivateData = privateData;
      }
    });
    const largeText = "€".repeat(256 * 1024);
    const diagnostics = expectDefined(
      createClaudeCliModelCallDiagnostics({
        context: createContext(),
        prompt: largeText,
        systemPrompt: largeText,
        transport: "stdio",
      }),
      "Claude CLI diagnostics",
    );

    diagnostics.emitStarted();
    for (let index = 0; index < 250; index += 1) {
      diagnostics.observeAssistantMessage({
        content: [{ type: "text", text: `${index}:${largeText}` }],
      });
    }
    diagnostics.emitCompleted({ text: "done" } as CliOutput);
    await waitForDiagnosticEventsDrained();
    stop();

    const modelContent = expectDefined(completedPrivateData?.modelContent, "model content");
    const inputJson = JSON.stringify(modelContent.inputMessages);
    const outputJson = JSON.stringify(modelContent.outputMessages);
    expect(Buffer.byteLength(inputJson, "utf8")).toBeLessThanOrEqual(CONTENT_LIMIT_BYTES + 256);
    expect(Buffer.byteLength(modelContent.systemPrompt ?? "", "utf8")).toBeLessThanOrEqual(
      CONTENT_LIMIT_BYTES,
    );
    expect(Buffer.byteLength(outputJson, "utf8")).toBeLessThanOrEqual(CONTENT_LIMIT_BYTES);
    expect(outputJson).toContain("...(truncated)");
  });

  it("bounds serialized escaped content across many envelopes", async () => {
    let outputMessages: unknown;
    const stop = onTrustedInternalDiagnosticEvent((event, _metadata, privateData) => {
      if (event.type === "model.call.completed") {
        outputMessages = privateData.modelContent?.outputMessages;
      }
    });
    const diagnostics = expectDefined(
      createClaudeCliModelCallDiagnostics({
        context: createContext(),
        prompt: "hello",
        transport: "stdio",
      }),
      "Claude CLI diagnostics",
    );

    diagnostics.emitStarted();
    for (let index = 0; index < 199; index += 1) {
      diagnostics.observeAssistantMessage({ content: `part-${index}:\u0000`.repeat(100) });
    }
    diagnostics.emitCompleted({ text: "done" } as CliOutput);
    await waitForDiagnosticEventsDrained();
    stop();

    expect(Buffer.byteLength(JSON.stringify(outputMessages), "utf8")).toBeLessThanOrEqual(
      CONTENT_LIMIT_BYTES,
    );
  });

  it("caps assistant envelope count and records truncation", async () => {
    let outputMessages: unknown;
    const stop = onTrustedInternalDiagnosticEvent((event, _metadata, privateData) => {
      if (event.type === "model.call.completed") {
        outputMessages = privateData.modelContent?.outputMessages;
      }
    });
    const diagnostics = expectDefined(
      createClaudeCliModelCallDiagnostics({
        context: createContext(),
        prompt: "hello",
        transport: "stdio",
      }),
      "Claude CLI diagnostics",
    );

    diagnostics.emitStarted();
    for (let index = 0; index < 250; index += 1) {
      diagnostics.observeAssistantMessage({ content: `message-${index}` });
    }
    diagnostics.emitCompleted({ text: "done" } as CliOutput);
    await waitForDiagnosticEventsDrained();
    stop();

    expect(outputMessages).toHaveLength(200);
    expect(JSON.stringify(outputMessages)).toContain("...(truncated)");
  });

  it("records truncation when the item budget ends inside an envelope", async () => {
    let outputMessages: unknown;
    const stop = onTrustedInternalDiagnosticEvent((event, _metadata, privateData) => {
      if (event.type === "model.call.completed") {
        outputMessages = privateData.modelContent?.outputMessages;
      }
    });
    const diagnostics = expectDefined(
      createClaudeCliModelCallDiagnostics({
        context: createContext(),
        prompt: "hello",
        transport: "stdio",
      }),
      "Claude CLI diagnostics",
    );

    diagnostics.emitStarted();
    for (let index = 0; index < 197; index += 1) {
      diagnostics.observeAssistantMessage({ content: `message-${index}` });
    }
    diagnostics.observeAssistantMessage({
      content: [
        { type: "text", text: "captured-a" },
        { type: "text", text: "captured-b" },
        { type: "text", text: "dropped-c" },
      ],
    });
    diagnostics.emitCompleted({ text: "done" } as CliOutput);
    await waitForDiagnosticEventsDrained();
    stop();

    expect(outputMessages).toHaveLength(199);
    expect(JSON.stringify(outputMessages)).toContain("captured-b");
    expect(JSON.stringify(outputMessages)).not.toContain("dropped-c");
    expect(JSON.stringify(outputMessages)).toContain("...(truncated)");
  });

  it("keeps fallback response text when prior non-text envelopes fill the limit", async () => {
    let outputMessages: unknown;
    const stop = onTrustedInternalDiagnosticEvent((event, _metadata, privateData) => {
      if (event.type === "model.call.completed") {
        outputMessages = privateData.modelContent?.outputMessages;
      }
    });
    const diagnostics = expectDefined(
      createClaudeCliModelCallDiagnostics({
        context: createContext(),
        prompt: "hello",
        transport: "stdio",
      }),
      "Claude CLI diagnostics",
    );

    diagnostics.emitStarted();
    for (let index = 0; index < 200; index += 1) {
      diagnostics.observeAssistantMessage({
        content: [{ type: "thinking", thinking: `reason-${index}` }],
      });
    }
    diagnostics.emitCompleted({ text: "final visible answer" } as CliOutput);
    await waitForDiagnosticEventsDrained();
    stop();

    expect(outputMessages).toHaveLength(200);
    expect(JSON.stringify(outputMessages)).toContain("final visible answer");
    expect(JSON.stringify(outputMessages)).toContain("...(truncated)");
  });

  it("keeps fallback response text when non-text content fills the byte budget", async () => {
    let outputMessages: unknown;
    const stop = onTrustedInternalDiagnosticEvent((event, _metadata, privateData) => {
      if (event.type === "model.call.completed") {
        outputMessages = privateData.modelContent?.outputMessages;
      }
    });
    const diagnostics = expectDefined(
      createClaudeCliModelCallDiagnostics({
        context: createContext(),
        prompt: "hello",
        transport: "stdio",
      }),
      "Claude CLI diagnostics",
    );

    diagnostics.emitStarted();
    diagnostics.observeAssistantMessage({
      content: [{ type: "thinking", thinking: "€".repeat(256 * 1024) }],
    });
    diagnostics.emitCompleted({ text: "final visible answer" } as CliOutput);
    await waitForDiagnosticEventsDrained();
    stop();

    const outputJson = JSON.stringify(outputMessages);
    expect(outputJson).toContain("final visible answer");
    expect(outputJson).toContain("...(truncated)");
    expect(Buffer.byteLength(outputJson, "utf8")).toBeLessThanOrEqual(CONTENT_LIMIT_BYTES + 512);
  });

  it("keeps the fallback reserve after empty text content", async () => {
    let outputMessages: unknown;
    const stop = onTrustedInternalDiagnosticEvent((event, _metadata, privateData) => {
      if (event.type === "model.call.completed") {
        outputMessages = privateData.modelContent?.outputMessages;
      }
    });
    const diagnostics = expectDefined(
      createClaudeCliModelCallDiagnostics({
        context: createContext(),
        prompt: "hello",
        transport: "stdio",
      }),
      "Claude CLI diagnostics",
    );

    diagnostics.emitStarted();
    diagnostics.observeAssistantMessage({ content: "" });
    diagnostics.observeAssistantMessage({
      content: Array.from({ length: 200 }, (_, index) => ({
        type: "thinking",
        thinking: `reason-${index}`,
      })),
    });
    diagnostics.emitCompleted({ text: "final visible answer" } as CliOutput);
    await waitForDiagnosticEventsDrained();
    stop();

    const outputJson = JSON.stringify(outputMessages);
    expect(outputJson).toContain("final visible answer");
    expect(outputJson).toContain("...(truncated)");
  });

  it("bounds text probing after the capture budget is exhausted", async () => {
    let outputMessages: unknown;
    const stop = onTrustedInternalDiagnosticEvent((event, _metadata, privateData) => {
      if (event.type === "model.call.completed") {
        outputMessages = privateData.modelContent?.outputMessages;
      }
    });
    const diagnostics = expectDefined(
      createClaudeCliModelCallDiagnostics({
        context: createContext(),
        prompt: "hello",
        transport: "stdio",
      }),
      "Claude CLI diagnostics",
    );

    diagnostics.emitStarted();
    diagnostics.observeAssistantMessage({
      content: Array.from({ length: 198 }, (_, index) => ({
        type: "thinking",
        thinking: `reason-${index}`,
      })),
    });
    diagnostics.observeAssistantMessage({
      content: [
        ...Array.from({ length: 10_000 }, () => ({ type: "thinking", thinking: "later" })),
        { type: "text", text: "outside-probe-window" },
      ],
    });
    diagnostics.emitCompleted({ text: "final visible answer" } as CliOutput);
    await waitForDiagnosticEventsDrained();
    stop();

    const outputJson = JSON.stringify(outputMessages);
    expect(outputJson).toContain("final visible answer");
    expect(outputJson).not.toContain("outside-probe-window");
  });

  it("counts the truncation marker within the output item limit", async () => {
    let outputMessages: unknown;
    const stop = onTrustedInternalDiagnosticEvent((event, _metadata, privateData) => {
      if (event.type === "model.call.completed") {
        outputMessages = privateData.modelContent?.outputMessages;
      }
    });
    const diagnostics = expectDefined(
      createClaudeCliModelCallDiagnostics({
        context: createContext(),
        prompt: "hello",
        transport: "stdio",
      }),
      "Claude CLI diagnostics",
    );

    diagnostics.emitStarted();
    diagnostics.observeAssistantMessage({
      content: Array.from({ length: 201 }, (_, index) => ({
        type: "text",
        text: `part-${index}`,
      })),
    });
    diagnostics.emitCompleted({ text: "done" } as CliOutput);
    await waitForDiagnosticEventsDrained();
    stop();

    const messages = outputMessages as Array<{ content?: unknown[] }>;
    const itemCount = messages.reduce((sum, message) => sum + (message.content?.length ?? 0), 0);
    expect(itemCount).toBe(200);
    expect(JSON.stringify(messages)).toContain("...(truncated)");
  });
});
