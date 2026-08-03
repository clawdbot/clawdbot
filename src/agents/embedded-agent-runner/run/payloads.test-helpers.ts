// Payload test helpers provide stable defaults and assertion helpers for the
// embedded run reply payload builder.
import { expect } from "vitest";
import { buildEmbeddedRunPayloads } from "./payloads.js";

type BuildPayloadParams = Parameters<typeof buildEmbeddedRunPayloads>[0];
type RunPayloads = ReturnType<typeof buildEmbeddedRunPayloads>;

export function buildPayloads(overrides: Partial<BuildPayloadParams> = {}) {
  // Defaults mirror a quiet interactive session so tests opt into cron,
  // verbose, tool-result, or current-assistant behavior explicitly.
  return buildEmbeddedRunPayloads({
    assistantTexts: [],
    toolMetas: [],
    lastAssistant: undefined,
    currentAssistant:
      overrides.currentAssistant === undefined
        ? overrides.lastAssistant
        : overrides.currentAssistant,
    isCronTrigger: false,
    sessionKey: "session:telegram",
    inlineToolResultsAllowed: false,
    verboseLevel: "off",
    reasoningLevel: "off",
    toolResultFormat: "plain",
    ...overrides,
  });
}

export function expectSinglePayloadText(
  payloads: RunPayloads,
  text: string,
  expectedError?: boolean,
): void {
  expect(payloads).toHaveLength(1);
  expect(payloads[0]?.text).toBe(text);
  if (typeof expectedError === "boolean") {
    expect(payloads[0]?.isError).toBe(expectedError);
  }
}

export function expectSingleToolErrorPayload(
  payloads: RunPayloads,
  params: { title: string; detail?: string; absentDetail?: string },
): void {
  // Tool error payloads intentionally omit raw details unless the case opts in;
  // absentDetail catches accidental leakage in compact modes.
  expect(payloads).toHaveLength(1);
  expect(payloads[0]?.isError).toBe(true);
  expect(payloads[0]?.text).toContain(params.title);
  if (typeof params.detail === "string") {
    expect(payloads[0]?.text).toContain(params.detail);
  }
  if (typeof params.absentDetail === "string") {
    expect(payloads[0]?.text).not.toContain(params.absentDetail);
  }
}
