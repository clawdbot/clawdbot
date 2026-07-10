// Covers live model extra-probe builders, matchers, and route skip lists.
import { describe, expect, it } from "vitest";
import {
  buildLiveModelFileProbeContext,
  buildLiveModelFileProbeRetryContext,
  buildLiveModelImageProbeContext,
  fileProbeTextMatches,
  imageProbeTextMatches,
  isLiveModelProbeEnabled,
  LIVE_MODEL_FILE_PROBE_TOKEN,
  modelSupportsImageInput,
  runLiveModelImageProbeWithRetry,
  shouldSkipLiveModelExtraProbes,
  shouldSkipLiveModelFileProbe,
  shouldSkipLiveModelImageProbe,
} from "./live-model-turn-probes.js";

function createImageProbeRunner(responses: string[]) {
  const attempts: Array<1 | 2> = [];
  return {
    attempts,
    run: async (attempt: 1 | 2) => {
      attempts.push(attempt);
      const response = responses[attempt - 1];
      if (response === undefined) {
        throw new Error(`Unexpected image probe attempt ${attempt}`);
      }
      return response;
    },
  };
}

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
    expect(context.messages[0]?.content).toBe(
      "Read this visible label and reply with only the value after LIVE_LABEL.\n\nLIVE_LABEL=opal",
    );
  });

  it("builds a stricter file read retry probe", () => {
    const context = buildLiveModelFileProbeRetryContext({});
    expect(context.messages[0]?.content).toBe(
      "The visible label value is:\n\nopal\n\nReply with exactly opal.",
    );
  });

  it("builds an image probe with native image content", () => {
    // The image probe must use native image blocks, not markdown or remote
    // URLs, so provider validation tests exercise multimodal input paths.
    const context = buildLiveModelImageProbeContext({});
    const content = context.messages[0]?.content;
    expect(Array.isArray(content)).toBe(true);
    if (!Array.isArray(content)) {
      throw new Error("Expected image probe content blocks");
    }
    expect(content[0]?.type).toBe("text");
    expect(content[1]?.type).toBe("image");
    expect(content[1]).toHaveProperty("mimeType", "image/png");
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
    // These routes are still useful for live text calls but have stale or
    // unreliable file-tool behavior, so extra probes skip them explicitly.
    expect(shouldSkipLiveModelFileProbe({ provider: "opencode-go", id: "glm-5" })).toBe(true);
    expect(shouldSkipLiveModelFileProbe({ provider: "google", id: "gemini-3.1-pro-preview" })).toBe(
      true,
    );
    expect(shouldSkipLiveModelFileProbe({ provider: "opencode-go", id: "minimax-m2.5" })).toBe(
      true,
    );
    expect(
      shouldSkipLiveModelFileProbe({ provider: "openrouter", id: "arcee-ai/trinity-mini" }),
    ).toBe(true);
    expect(
      shouldSkipLiveModelFileProbe({
        provider: "openrouter",
        id: "deepseek/deepseek-chat-v3.1",
      }),
    ).toBe(true);
    expect(
      shouldSkipLiveModelFileProbe({ provider: "openrouter", id: "minimax/minimax-m2.5" }),
    ).toBe(true);
    expect(
      shouldSkipLiveModelFileProbe({
        provider: "openrouter",
        id: "nvidia/llama-3.3-nemotron-super-49b-v1.5",
      }),
    ).toBe(true);
    expect(
      shouldSkipLiveModelFileProbe({
        provider: "openrouter",
        id: "nvidia/nemotron-nano-12b-v2-vl:free",
      }),
    ).toBe(true);
    expect(shouldSkipLiveModelFileProbe({ provider: "openrouter", id: "qwen/qwen3.5-9b" })).toBe(
      true,
    );
    expect(
      shouldSkipLiveModelFileProbe({
        provider: "openrouter",
        id: "tngtech/deepseek-r1t2-chimera",
      }),
    ).toBe(true);
    expect(shouldSkipLiveModelFileProbe({ provider: "openrouter", id: "z-ai/glm-4.7-flash" })).toBe(
      true,
    );
    expect(shouldSkipLiveModelFileProbe({ provider: "openrouter", id: "z-ai/glm-5" })).toBe(true);
    expect(shouldSkipLiveModelFileProbe({ provider: "openrouter", id: "z-ai/glm-5.1" })).toBe(true);
    expect(shouldSkipLiveModelFileProbe({ provider: "opencode-go", id: "kimi-k2.5" })).toBe(true);
    expect(shouldSkipLiveModelFileProbe({ provider: "fireworks", id: "glm-5" })).toBe(false);
  });

  it("skips known stale image probe routes", () => {
    expect(
      shouldSkipLiveModelImageProbe({
        provider: "fireworks",
        id: "accounts/fireworks/models/kimi-k2p5",
      }),
    ).toBe(true);
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
    expect(shouldSkipLiveModelImageProbe({ provider: "opencode", id: "kimi-k2.6" })).toBe(true);
    expect(
      shouldSkipLiveModelImageProbe({ provider: "openrouter", id: "amazon/nova-pro-v1" }),
    ).toBe(true);
    expect(
      shouldSkipLiveModelImageProbe({ provider: "openrouter", id: "bytedance-seed/seed-1.6" }),
    ).toBe(true);
    expect(shouldSkipLiveModelImageProbe({ provider: "fireworks", id: "glm-5" })).toBe(false);
  });

  it("matches expected probe replies", () => {
    expect(fileProbeTextMatches(`The value is ${LIVE_MODEL_FILE_PROBE_TOKEN}.`)).toBe(true);
    expect(fileProbeTextMatches("amber")).toBe(false);
    expect(imageProbeTextMatches("OK")).toBe(true);
    expect(imageProbeTextMatches("blue")).toBe(false);
    expect(imageProbeTextMatches('" or "Reply with exactly')).toBe(false);
  });

  it("retries one mismatched image reply and accepts only a matching retry", async () => {
    const { attempts, run } = createImageProbeRunner(["blue", "OK"]);
    const retries: string[] = [];

    await expect(
      runLiveModelImageProbeWithRetry({
        run,
        onRetry: (firstText) => retries.push(firstText),
      }),
    ).resolves.toBe("OK");
    expect(attempts).toEqual([1, 2]);
    expect(retries).toEqual(["blue"]);
  });

  it("does not retry an image reply that already matches", async () => {
    const { attempts, run } = createImageProbeRunner(["OK"]);
    const retries: string[] = [];

    await expect(
      runLiveModelImageProbeWithRetry({
        run,
        onRetry: (firstText) => retries.push(firstText),
      }),
    ).resolves.toBe("OK");
    expect(attempts).toEqual([1]);
    expect(retries).toEqual([]);
  });

  it("does not retry provider errors", async () => {
    const attempts: Array<1 | 2> = [];
    const retries: string[] = [];
    const run = async (attempt: 1 | 2): Promise<string> => {
      attempts.push(attempt);
      throw new Error("boom");
    };

    await expect(
      runLiveModelImageProbeWithRetry({
        run,
        onRetry: (firstText) => retries.push(firstText),
      }),
    ).rejects.toThrow("boom");
    expect(attempts).toEqual([1]);
    expect(retries).toEqual([]);
  });

  it("fails when the image retry also does not match", async () => {
    const { attempts, run } = createImageProbeRunner(["blue", '" or "Reply with exactly']);

    await expect(runLiveModelImageProbeWithRetry({ run, onRetry: () => {} })).rejects.toThrow(
      "image probe did not return ok after retry",
    );
    expect(attempts).toEqual([1, 2]);
  });

  it("does not turn a mismatched image reply into an empty-response skip", async () => {
    const { run } = createImageProbeRunner(["blue", ""]);

    await expect(runLiveModelImageProbeWithRetry({ run, onRetry: () => {} })).rejects.toThrow(
      "attempt 2: <empty>",
    );
  });

  it("fails after two empty image replies", async () => {
    const { attempts, run } = createImageProbeRunner(["", ""]);

    await expect(runLiveModelImageProbeWithRetry({ run, onRetry: () => {} })).rejects.toThrow(
      "attempt 1: <empty>; attempt 2: <empty>",
    );
    expect(attempts).toEqual([1, 2]);
  });

  it("fails when an empty image reply is followed by a mismatch", async () => {
    const { run } = createImageProbeRunner(["", "blue"]);

    await expect(runLiveModelImageProbeWithRetry({ run, onRetry: () => {} })).rejects.toThrow(
      "attempt 1: <empty>",
    );
  });

  it("redacts nonmatching image replies from failure diagnostics", async () => {
    const { run } = createImageProbeRunner(["first private reply", "second private reply"]);

    const error = await runLiveModelImageProbeWithRetry({ run, onRetry: () => {} }).catch(
      (cause: unknown) => String(cause),
    );
    expect(error).toContain("<non-matching response:");
    expect(error).not.toContain("private reply");
  });
});
