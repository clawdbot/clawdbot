import { describe, expect, it } from "vitest";
import {
  buildLiveModelFileProbeContext,
  buildLiveModelFileProbeRetryContext,
  buildLiveModelImageProbeContext,
  extractAssistantText,
  fileProbeTextMatches,
  imageProbeTextMatches,
  isLiveModelProbeEnabled,
  LIVE_MODEL_FILE_PROBE_TOKEN,
  modelSupportsImageInput,
  shouldSkipLiveModelExtraProbes,
  shouldSkipLiveModelFileProbe,
  shouldSkipLiveModelImageProbe,
} from "./live-model-turn-probes.js";

describe("live model turn probes", () => {
  it("defaults probes on and accepts common opt-out values", () => {
    expect(isLiveModelProbeEnabled({}, "OPENCLAW_LIVE_MODEL_IMAGE_PROBE")).toBe(true);
    expect(
      isLiveModelProbeEnabled(
        { OPENCLAW_LIVE_MODEL_IMAGE_PROBE: "false" },
        "OPENCLAW_LIVE_MODEL_IMAGE_PROBE",
      ),
    ).toBe(false);
    expect(
      isLiveModelProbeEnabled(
        { OPENCLAW_LIVE_MODEL_IMAGE_PROBE: "1" },
        "OPENCLAW_LIVE_MODEL_IMAGE_PROBE",
      ),
    ).toBe(true);
  });

  it("builds a text file read probe", () => {
    const context = buildLiveModelFileProbeContext({ systemPrompt: "sys" });
    expect(context.systemPrompt).toBe("sys");
    expect(context.messages[0]?.content).toEqual(
      expect.stringContaining(`LIVE_FILE_TOKEN=${LIVE_MODEL_FILE_PROBE_TOKEN}`),
    );
  });

  it("builds a stricter file read retry probe", () => {
    const context = buildLiveModelFileProbeRetryContext({});
    expect(context.messages[0]?.content).toEqual(
      expect.stringContaining(`Reply with exactly ${LIVE_MODEL_FILE_PROBE_TOKEN}`),
    );
  });

  it("builds an image probe with native image content", () => {
    const context = buildLiveModelImageProbeContext({});
    expect(context.messages[0]?.content).toEqual([
      expect.objectContaining({ type: "text" }),
      expect.objectContaining({ type: "image", mimeType: "image/png" }),
    ]);
  });

  it("extracts assistant text blocks only", () => {
    expect(
      extractAssistantText({
        content: [
          { type: "thinking", thinking: "hidden" },
          { type: "text", text: " ok " },
          { type: "toolCall", id: "1", name: "noop", arguments: {} },
        ],
      }),
    ).toBe("ok");
  });

  it("detects image input support from model metadata", () => {
    expect(modelSupportsImageInput({ input: ["text", "image"] })).toBe(true);
    expect(modelSupportsImageInput({ input: ["text"] })).toBe(false);
  });

  it("skips known stale extra probe routes", () => {
    expect(
      shouldSkipLiveModelExtraProbes({
        provider: "openrouter",
        id: "amazon/nova-2-lite-v1",
      }),
    ).toBe(true);
    expect(
      shouldSkipLiveModelExtraProbes({
        provider: "openrouter",
        id: "amazon/nova-lite-v1",
      }),
    ).toBe(false);
  });

  it("skips known stale file probe routes", () => {
    expect(shouldSkipLiveModelFileProbe({ provider: "opencode-go", id: "glm-5" })).toBe(true);
    expect(shouldSkipLiveModelFileProbe({ provider: "google", id: "gemini-3-pro-preview" })).toBe(
      true,
    );
    expect(shouldSkipLiveModelFileProbe({ provider: "opencode-go", id: "mimo-v2-omni" })).toBe(
      true,
    );
    expect(shouldSkipLiveModelFileProbe({ provider: "opencode-go", id: "mimo-v2-pro" })).toBe(true);
    expect(shouldSkipLiveModelFileProbe({ provider: "opencode-go", id: "minimax-m2.5" })).toBe(
      true,
    );
    expect(shouldSkipLiveModelFileProbe({ provider: "opencode-go", id: "kimi-k2.5" })).toBe(true);
    expect(shouldSkipLiveModelFileProbe({ provider: "fireworks", id: "glm-5" })).toBe(false);
  });

  it("skips known stale image probe routes", () => {
    expect(
      shouldSkipLiveModelImageProbe({
        provider: "fireworks",
        id: "accounts/fireworks/models/kimi-k2p6",
      }),
    ).toBe(true);
    expect(shouldSkipLiveModelImageProbe({ provider: "opencode-go", id: "kimi-k2.5" })).toBe(true);
    expect(
      shouldSkipLiveModelImageProbe({
        provider: "google",
        id: "gemini-3.1-pro-preview-customtools",
      }),
    ).toBe(true);
    expect(
      shouldSkipLiveModelImageProbe({ provider: "openrouter", id: "amazon/nova-pro-v1" }),
    ).toBe(true);
    expect(shouldSkipLiveModelImageProbe({ provider: "fireworks", id: "glm-5" })).toBe(false);
  });

  it("matches expected probe replies", () => {
    expect(fileProbeTextMatches(`The value is ${LIVE_MODEL_FILE_PROBE_TOKEN}.`)).toBe(true);
    expect(fileProbeTextMatches("amber")).toBe(false);
    expect(imageProbeTextMatches("OK")).toBe(true);
    expect(imageProbeTextMatches("blue")).toBe(false);
  });
});
