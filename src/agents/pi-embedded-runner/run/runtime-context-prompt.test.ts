import { describe, expect, it, vi } from "vitest";
import {
  buildRuntimeContextSystemContext,
  queueRuntimeContextForNextTurn,
  resolveRuntimeContextPromptParts,
} from "./runtime-context-prompt.js";

describe("runtime context prompt submission", () => {
  it("keeps unchanged prompts as a normal user prompt", () => {
    expect(
      resolveRuntimeContextPromptParts({
        effectivePrompt: "visible ask",
        transcriptPrompt: "visible ask",
      }),
    ).toEqual({ prompt: "visible ask" });
  });

  it("moves hidden runtime context out of the visible prompt", () => {
    const effectivePrompt = [
      "visible ask",
      "",
      "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
      "secret runtime context",
      "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
    ].join("\n");

    expect(
      resolveRuntimeContextPromptParts({
        effectivePrompt,
        transcriptPrompt: "visible ask",
      }),
    ).toEqual({
      prompt: "visible ask",
      runtimeContext:
        "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nsecret runtime context\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
    });
  });

  it("preserves prompt additions as hidden runtime context", () => {
    expect(
      resolveRuntimeContextPromptParts({
        effectivePrompt: ["runtime prefix", "", "visible ask", "", "retry instruction"].join("\n"),
        transcriptPrompt: "visible ask",
      }),
    ).toEqual({
      prompt: "visible ask",
      runtimeContext: "runtime prefix\n\nretry instruction",
    });
  });

  it("uses a marker prompt for runtime-only events", () => {
    expect(
      resolveRuntimeContextPromptParts({
        effectivePrompt: "internal event",
        transcriptPrompt: "",
      }),
    ).toEqual({
      prompt: "",
      runtimeContext: "internal event",
      runtimeOnly: true,
      runtimeSystemContext: expect.stringContaining("internal event"),
    });
  });

  it("queues runtime context as a hidden next-turn custom message", async () => {
    const sentMessages: Array<{ content: string }> = [];
    const sendCustomMessage = vi.fn(async (message: { content: string }) => {
      sentMessages.push(message);
    });

    await queueRuntimeContextForNextTurn({
      session: { sendCustomMessage },
      runtimeContext: "secret runtime context",
    });

    expect(sendCustomMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "openclaw.runtime-context",
        content: "secret runtime context",
        display: false,
      }),
      { deliverAs: "nextTurn" },
    );
    expect(sentMessages[0]?.content).not.toContain(
      "OpenClaw runtime context for the immediately preceding user message.",
    );
    expect(sentMessages[0]?.content).not.toContain("not user-authored");
  });

  it("labels next-turn runtime context only when used as prompt-local system context", () => {
    const systemContext = buildRuntimeContextSystemContext("secret runtime context");

    expect(systemContext).toContain(
      "OpenClaw runtime context for the immediately preceding user message.",
    );
    expect(systemContext).toContain("not user-authored");
    expect(systemContext).toContain("secret runtime context");
  });

  it("labels runtime-only events as system context", async () => {
    const { buildRuntimeEventSystemContext } = await import("./runtime-context-prompt.js");

    expect(buildRuntimeEventSystemContext("internal event")).toContain("OpenClaw runtime event.");
    expect(buildRuntimeEventSystemContext("internal event")).toContain("not user-authored");
  });
});
