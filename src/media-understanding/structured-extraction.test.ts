// Covers the shared structured-extraction path every image-capable provider
// without a bespoke hook is hydrated with. Instruction placement itself is
// proven at the completion boundary in image.test.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveDefaultAgentDir } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/types.js";
import type { StructuredExtractionRequest } from "./types.js";

const mocks = vi.hoisted(() => ({
  completeImagesWithModel: vi.fn(),
}));

vi.mock("./image.js", () => ({
  completeImagesWithModel: mocks.completeImagesWithModel,
}));

const { extractStructuredWithImageModelCore } = await import("./structured-extraction.js");

function imageInput() {
  return {
    type: "image" as const,
    buffer: Buffer.from("image-bytes"),
    fileName: "receipt.png",
    mime: "image/png",
  };
}

function baseRequest(overrides: Partial<StructuredExtractionRequest> = {}) {
  return {
    input: [imageInput()],
    instructions: "Extract vendor and total.",
    provider: "anthropic",
    model: "claude-sonnet-5",
    timeoutMs: 30_000,
    cfg: {},
    agentDir: "/tmp/openclaw-agent",
    ...overrides,
  } satisfies StructuredExtractionRequest;
}

function requireCompletionRequest(): Record<string, unknown> {
  const call = mocks.completeImagesWithModel.mock.calls[0];
  if (!call) {
    throw new Error("expected completeImagesWithModel call");
  }
  return call[0] as Record<string, unknown>;
}

beforeEach(() => {
  mocks.completeImagesWithModel.mockReset();
  mocks.completeImagesWithModel.mockResolvedValue({
    text: '{"vendor":"ACME","total":42}',
    model: "claude-sonnet-5",
  });
});

describe("extractStructuredWithImageModelCore", () => {
  it("pins the instructions to the system channel and keeps text inputs as user content", async () => {
    const authStore = { version: 1, profiles: {} } as StructuredExtractionRequest["authStore"];
    const result = await extractStructuredWithImageModelCore(
      baseRequest({
        input: [{ type: "text", text: " Prefer the printed total. " }, imageInput()],
        schemaName: "receipt.evidence",
        jsonSchema: { type: "object", properties: { total: { type: "number" } } },
        profile: "work",
        preferredProfile: "preferred-work",
        authStore,
      }),
    );

    expect(mocks.completeImagesWithModel).toHaveBeenCalledTimes(1);
    const request = requireCompletionRequest();
    expect(request.promptDelivery).toBe("system-required");
    expect(request.userText).toEqual(["Prefer the printed total."]);
    expect(request.images).toEqual([
      { buffer: Buffer.from("image-bytes"), fileName: "receipt.png", mime: "image/png" },
    ]);
    expect(request).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-5",
      timeoutMs: 30_000,
      agentDir: "/tmp/openclaw-agent",
      profile: "work",
      preferredProfile: "preferred-work",
      authStore,
    });
    const prompt = String(request.prompt);
    expect(prompt).toContain("Extract vendor and total.");
    expect(prompt).toContain("Do not include secrets such as passwords, API keys, tokens");
    expect(prompt).toContain("Schema name: receipt.evidence");
    expect(prompt).toContain('"total":{"type":"number"}');
    expect(prompt).toContain("Return valid JSON only");
    expect(prompt).not.toContain("Prefer the printed total.");
    expect(result).toEqual({
      text: '{"vendor":"ACME","total":42}',
      model: "claude-sonnet-5",
      provider: "anthropic",
      contentType: "json",
      parsed: { vendor: "ACME", total: 42 },
    });
  });

  it("returns text without parsing when jsonMode is false", async () => {
    mocks.completeImagesWithModel.mockResolvedValueOnce({
      text: "ACME, 42",
      model: "claude-sonnet-5",
    });

    const result = await extractStructuredWithImageModelCore(baseRequest({ jsonMode: false }));

    expect(String(requireCompletionRequest().prompt)).toContain(
      "Return the extraction as concise text.",
    );
    expect(result).toEqual({
      text: "ACME, 42",
      model: "claude-sonnet-5",
      provider: "anthropic",
      contentType: "text",
    });
  });

  it.each([
    { name: "model id", overrides: { model: "  " }, message: "requires model id" },
    { name: "instructions", overrides: { instructions: " " }, message: "requires instructions" },
    {
      name: "image input",
      overrides: { input: [{ type: "text" as const, text: "only text" }] },
      message: "requires at least one image input",
    },
  ])("rejects a request missing its $name before completing", async ({ overrides, message }) => {
    await expect(extractStructuredWithImageModelCore(baseRequest(overrides))).rejects.toThrow(
      message,
    );
    expect(mocks.completeImagesWithModel).not.toHaveBeenCalled();
  });

  it("reports invalid JSON as a controlled error", async () => {
    mocks.completeImagesWithModel.mockResolvedValueOnce({ text: "not json", model: "m" });

    await expect(extractStructuredWithImageModelCore(baseRequest())).rejects.toThrow(
      "Structured extraction returned invalid JSON: anthropic",
    );
  });

  it("defaults an empty agentDir to the configured default agent directory", async () => {
    // The dispatcher hands "" through when the caller omits agentDir; the shared
    // runtime keys prepared-model owners by it, so "" would match none. Bespoke
    // extractors are not on this path and keep receiving "" unchanged.
    await extractStructuredWithImageModelCore(baseRequest({ agentDir: "" }));

    expect(requireCompletionRequest().agentDir).toBe(resolveDefaultAgentDir({} as OpenClawConfig));
  });

  it("accepts a JSON reply wrapped in a Markdown fence", async () => {
    mocks.completeImagesWithModel.mockResolvedValue({
      text: '```json\n{"vendor":"ACME","total":42}\n```',
      model: "claude-sonnet-5",
    });

    const result = await extractStructuredWithImageModelCore(baseRequest());

    expect(result.parsed).toEqual({ vendor: "ACME", total: 42 });
  });

  it("still reports a reply with no JSON in it as a controlled error", async () => {
    mocks.completeImagesWithModel.mockResolvedValue({
      text: "I could not read the receipt.",
      model: "claude-sonnet-5",
    });

    await expect(extractStructuredWithImageModelCore(baseRequest())).rejects.toThrow(
      "Structured extraction returned invalid JSON: anthropic",
    );
  });

  it("validates parsed JSON against the requested schema", async () => {
    mocks.completeImagesWithModel.mockResolvedValueOnce({
      text: '{"total":"forty-two"}',
      model: "m",
    });

    await expect(
      extractStructuredWithImageModelCore(
        baseRequest({
          jsonSchema: {
            type: "object",
            properties: { total: { type: "number" } },
            required: ["total"],
          },
        }),
      ),
    ).rejects.toThrow("Structured extraction JSON did not match schema: anthropic");
  });
});
