import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { buildEmbeddedRunPayloads } from "./payloads.js";

describe("buildEmbeddedRunPayloads", () => {
  const errorJson =
    '{"type":"error","error":{"details":null,"type":"overloaded_error","message":"Overloaded"},"request_id":"req_011CX7DwS7tSvggaNHmefwWg"}';
  const errorJsonPretty = `{
  "type": "error",
  "error": {
    "details": null,
    "type": "overloaded_error",
    "message": "Overloaded"
  },
  "request_id": "req_011CX7DwS7tSvggaNHmefwWg"
}`;
  const makeAssistant = (overrides: Partial<AssistantMessage>): AssistantMessage =>
    ({
      stopReason: "error",
      errorMessage: errorJson,
      content: [{ type: "text", text: errorJson }],
      ...overrides,
    }) as AssistantMessage;

  it("suppresses raw API error JSON when the assistant errored", () => {
    const lastAssistant = makeAssistant({});
    const payloads = buildEmbeddedRunPayloads({
      assistantTexts: [errorJson],
      toolMetas: [],
      lastAssistant,
      sessionKey: "session:telegram",
      inlineToolResultsAllowed: false,
      verboseLevel: "off",
      reasoningLevel: "off",
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toBe(
      "The AI service is temporarily overloaded. Please try again in a moment.",
    );
    expect(payloads[0]?.isError).toBe(true);
    expect(payloads.some((payload) => payload.text === errorJson)).toBe(false);
  });

  it("suppresses pretty-printed error JSON that differs from the errorMessage", () => {
    const lastAssistant = makeAssistant({ errorMessage: errorJson });
    const payloads = buildEmbeddedRunPayloads({
      assistantTexts: [errorJsonPretty],
      toolMetas: [],
      lastAssistant,
      sessionKey: "session:telegram",
      inlineToolResultsAllowed: true,
      verboseLevel: "on",
      reasoningLevel: "off",
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toBe(
      "The AI service is temporarily overloaded. Please try again in a moment.",
    );
    expect(payloads.some((payload) => payload.text === errorJsonPretty)).toBe(false);
  });

  it("suppresses raw error JSON from fallback assistant text", () => {
    const lastAssistant = makeAssistant({ content: [{ type: "text", text: errorJsonPretty }] });
    const payloads = buildEmbeddedRunPayloads({
      assistantTexts: [],
      toolMetas: [],
      lastAssistant,
      sessionKey: "session:telegram",
      inlineToolResultsAllowed: false,
      verboseLevel: "off",
      reasoningLevel: "off",
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toBe(
      "The AI service is temporarily overloaded. Please try again in a moment.",
    );
    expect(payloads.some((payload) => payload.text?.includes("request_id"))).toBe(false);
  });

  it("suppresses raw error JSON even when errorMessage is missing", () => {
    const lastAssistant = makeAssistant({ errorMessage: undefined });
    const payloads = buildEmbeddedRunPayloads({
      assistantTexts: [errorJsonPretty],
      toolMetas: [],
      lastAssistant,
      sessionKey: "session:telegram",
      inlineToolResultsAllowed: false,
      verboseLevel: "off",
      reasoningLevel: "off",
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.isError).toBe(true);
    expect(payloads.some((payload) => payload.text?.includes("request_id"))).toBe(false);
  });

  it("does not suppress error-shaped JSON when the assistant did not error", () => {
    const payloads = buildEmbeddedRunPayloads({
      assistantTexts: [errorJsonPretty],
      toolMetas: [],
      lastAssistant: { stopReason: "end_turn" } as AssistantMessage,
      sessionKey: "session:telegram",
      inlineToolResultsAllowed: false,
      verboseLevel: "off",
      reasoningLevel: "off",
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toBe(errorJsonPretty.trim());
  });
});
