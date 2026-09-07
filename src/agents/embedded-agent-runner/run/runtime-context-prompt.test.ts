// Producer context stays separate from literal user and hook text.
import { describe, expect, it } from "vitest";
import { stripInternalMetadataForDisplay } from "../../../auto-reply/reply/display-text-sanitize.js";
import type { Context, UserMessage } from "../../../llm/types.js";
import {
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  stripInternalRuntimeContext,
} from "../../internal-runtime-context.js";
import {
  buildCurrentInboundPrompt,
  buildRuntimeContextCustomMessage,
  resolveRuntimeContextPromptParts,
  prependRuntimeContextForModel,
} from "./runtime-context-prompt.js";

describe("runtime context prompt submission", () => {
  it.each([
    "visible ask",
    "  keep literal whitespace  ",
    `Quote ${INTERNAL_RUNTIME_CONTEXT_BEGIN} literally.`,
  ])("does not derive provenance from prompt text: %s", (prompt) => {
    expect(
      resolveRuntimeContextPromptParts({ effectivePrompt: prompt, transcriptPrompt: prompt }),
    ).toEqual({ prompt });
  });

  it.each(["Hook summary: Hello", "Hello", "System event"])(
    "keeps repeated hook text while carrying explicit source context: %s",
    (hook) => {
      const fragments = [{ kind: "conversation-data" as const, text: "System event" }];
      const modelPrompt = `${hook}\n\nHello\n\n${hook}`;
      expect(
        resolveRuntimeContextPromptParts({
          effectivePrompt: modelPrompt,
          transcriptPrompt: "Hello",
          fragments,
        }),
      ).toEqual({ prompt: "Hello", modelPrompt, runtimeContext: "System event" });
    },
  );

  it("keeps a heartbeat task active with its separate transcript marker", () => {
    expect(
      resolveRuntimeContextPromptParts({
        effectivePrompt: "Check the deployment.",
        transcriptPrompt: "[OpenClaw heartbeat poll]",
      }),
    ).toEqual({ prompt: "[OpenClaw heartbeat poll]", modelPrompt: "Check the deployment." });
  });

  it("requires producer context for runtime-only system context", () => {
    const fragments = [
      { kind: "runtime-instruction" as const, text: "Continue the background task." },
    ];
    const parts = resolveRuntimeContextPromptParts({
      effectivePrompt: "",
      transcriptPrompt: "",
      fragments,
    });
    expect(parts.prompt).toBe("Continue the OpenClaw runtime event.");
    expect(parts.runtimeOnly).toBe(true);
    expect(
      resolveRuntimeContextPromptParts({ effectivePrompt: "ordinary input", transcriptPrompt: "" }),
    ).toEqual({ prompt: "ordinary input" });
  });

  it("keeps suppressed-persistence prompts active", () => {
    expect(
      resolveRuntimeContextPromptParts({
        effectivePrompt: "Room event",
        transcriptPrompt: "",
        allowRuntimeOnly: false,
      }),
    ).toEqual({ prompt: "Room event" });
  });

  it("joins context for plain runtimes using their requested separator and replay text", () => {
    expect(
      buildCurrentInboundPrompt({
        context: { text: "Current message:", promptJoiner: " " },
        prompt: "Hello",
      }),
    ).toBe("Current message: Hello");
    expect(
      buildCurrentInboundPrompt({
        context: { text: "Room backlog", resumableText: "Current room event" },
        prompt: "Hello",
        preferResumableText: true,
      }),
    ).toBe("Current room event\n\nHello");
    expect(buildCurrentInboundPrompt({ context: { text: "  " }, prompt: "Hello" })).toBe("Hello");
  });

  it("carries producer provenance in hidden custom messages and hides their display", () => {
    const text = "Conversation info: channel=telegram";
    const fragments = [{ kind: "conversation-data" as const, text }];
    const message = buildRuntimeContextCustomMessage(text, fragments)!;
    expect(message).toMatchObject({
      role: "custom",
      customType: "openclaw.runtime-context",
      display: false,
      details: { source: "openclaw-runtime-context", runtimeContextCarrier: true, fragments },
    });
    expect(stripInternalMetadataForDisplay(message.content)).toBe("");
    expect(buildRuntimeContextCustomMessage(" ")).toBeUndefined();
  });
});

describe("per-request runtime instructions", () => {
  it.each([false, true])("preserves carrier position and parts (array=%s)", (arrayContent) => {
    const body =
      "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nCurrent facts\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>";
    const image = { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" };
    const carrier: UserMessage = {
      role: "user",
      timestamp: 2,
      runtimeContextCarrier: true,
      content: arrayContent ? [{ type: "text", text: body }, image] : body,
    };
    const messages: Context["messages"] = [
      { role: "user", content: "Question", timestamp: 1 },
      carrier,
      { role: "user", content: "Steering", timestamp: 3 },
    ];
    const nested =
      "Date B\n<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nRuntime event\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>";
    const projected = prependRuntimeContextForModel(messages, nested);
    const expected = `<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\n${nested}\n\nCurrent facts\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>`;
    expect(projected).toEqual([
      messages[0],
      { ...carrier, content: arrayContent ? [{ type: "text", text: expected }, image] : expected },
      messages[2],
    ]);
    expect(stripInternalRuntimeContext(expected)).toBe("");
    expect(messages[1]).toBe(carrier);
    expect(carrier.content).toEqual(arrayContent ? [{ type: "text", text: body }, image] : body);
    expect(prependRuntimeContextForModel(messages, nested)).toEqual(projected);
  });

  it("creates a transient carrier when the current turn has no other facts", () => {
    const messages: Context["messages"] = [{ role: "user", content: "Question", timestamp: 1 }];
    expect(prependRuntimeContextForModel(messages, "Date A")).toEqual([
      messages[0],
      {
        role: "user",
        timestamp: 1,
        runtimeContextCarrier: true,
        content:
          "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nDate A\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
      },
    ]);
    expect(messages).toHaveLength(1);
    expect(prependRuntimeContextForModel(messages, "")).toBe(messages);
  });
});
