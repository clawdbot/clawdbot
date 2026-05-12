import { afterEach, describe, expect, it, vi } from "vitest";
import * as pdfNativeProviders from "./pdf-native-providers.js";

vi.mock("../../plugins/provider-runtime.js", () => ({
  normalizeProviderTransportWithPlugin: (params: { context?: { baseUrl?: string } }) =>
    params.context?.baseUrl ? { baseUrl: params.context.baseUrl } : undefined,
}));

const TEST_PDF_INPUT = { base64: "dGVzdA==", filename: "doc.pdf" } as const;

function makeAnthropicAnalyzeParams(
  overrides: Partial<{
    apiKey: string;
    modelId: string;
    prompt: string;
    pdfs: Array<{ base64: string; filename: string }>;
    maxTokens: number;
    baseUrl: string;
  }> = {},
) {
  return {
    apiKey: "test-key",
    modelId: "claude-opus-4-6",
    prompt: "test",
    pdfs: [TEST_PDF_INPUT],
    ...overrides,
  };
}

function makeGeminiAnalyzeParams(
  overrides: Partial<{
    apiKey: string;
    modelId: string;
    prompt: string;
    pdfs: Array<{ base64: string; filename: string }>;
    baseUrl: string;
  }> = {},
) {
  return {
    apiKey: "test-key",
    modelId: "gemini-2.5-pro",
    prompt: "test",
    pdfs: [TEST_PDF_INPUT],
    ...overrides,
  };
}

describe("native PDF provider API calls", () => {
  const priorFetch = global.fetch;

  const mockFetchResponse = (response: unknown) => {
    const fetchMock = vi.fn().mockResolvedValue(response);
    global.fetch = Object.assign(fetchMock, { preconnect: vi.fn() }) as typeof global.fetch;
    return fetchMock;
  };

  const firstFetchCall = (fetchMock: { mock: { calls: unknown[][] } }): unknown[] => {
    const call = fetchMock.mock.calls.at(0);
    if (!call) {
      throw new Error("expected fetch to be called");
    }
    return call;
  };

  afterEach(() => {
    global.fetch = priorFetch;
  });

  it("anthropicAnalyzePdf sends correct request shape", async () => {
    const fetchMock = mockFetchResponse({
      ok: true,
      json: async () => ({
        content: [{ type: "text", text: "Analysis of PDF" }],
      }),
    });

    const result = await pdfNativeProviders.anthropicAnalyzePdf(
      makeAnthropicAnalyzeParams({
        modelId: "claude-opus-4-6",
        prompt: "Summarize this document",
        maxTokens: 4096,
      }),
    );

    expect(result).toBe("Analysis of PDF");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = firstFetchCall(fetchMock) as [
      string,
      { body: string; signal: AbortSignal },
    ];
    expect(url).toContain("/v1/messages");
    expect(opts.signal).toBeInstanceOf(AbortSignal);
    expect(opts.signal.aborted).toBe(false);
    const body = JSON.parse(opts.body);
    expect(body.model).toBe("claude-opus-4-6");
    expect(body.messages[0].content).toHaveLength(2);
    expect(body.messages[0].content[0].type).toBe("document");
    expect(body.messages[0].content[0].source.media_type).toBe("application/pdf");
    expect(body.messages[0].content[1].type).toBe("text");
  });

  it("anthropicAnalyzePdf throws on API error", async () => {
    mockFetchResponse({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      text: async () => "invalid request",
    });

    await expect(
      pdfNativeProviders.anthropicAnalyzePdf(makeAnthropicAnalyzeParams()),
    ).rejects.toThrow("Anthropic PDF request failed");
  });

  it("anthropicAnalyzePdf throws when response has no text", async () => {
    mockFetchResponse({
      ok: true,
      json: async () => ({
        content: [{ type: "text", text: "   " }],
      }),
    });

    await expect(
      pdfNativeProviders.anthropicAnalyzePdf(makeAnthropicAnalyzeParams()),
    ).rejects.toThrow("Anthropic PDF returned no text");
  });

  it("geminiAnalyzePdf sends correct request shape", async () => {
    const fetchMock = mockFetchResponse({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: "Gemini PDF analysis" }] } }],
      }),
    });

    const result = await pdfNativeProviders.geminiAnalyzePdf(
      makeGeminiAnalyzeParams({
        modelId: "gemini-2.5-pro",
        prompt: "Summarize this",
      }),
    );

    expect(result).toBe("Gemini PDF analysis");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = firstFetchCall(fetchMock) as [
      string,
      { body: string; headers: Record<string, string>; signal: AbortSignal },
    ];
    expect(url).toContain("generateContent");
    expect(url).toContain("gemini-2.5-pro");
    expect(url).not.toContain("?key=");
    expect(opts.headers["x-goog-api-key"]).toBe("test-key");
    expect(opts.signal).toBeInstanceOf(AbortSignal);
    expect(opts.signal.aborted).toBe(false);
    const body = JSON.parse(opts.body);
    expect(body.contents[0].parts).toHaveLength(2);
    expect(body.contents[0].parts[0].inline_data.mime_type).toBe("application/pdf");
    expect(body.contents[0].parts[1].text).toBe("Summarize this");
  });

  it("geminiAnalyzePdf throws on API error", async () => {
    mockFetchResponse({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      text: async () => "server error",
    });

    await expect(pdfNativeProviders.geminiAnalyzePdf(makeGeminiAnalyzeParams())).rejects.toThrow(
      "Gemini PDF request failed",
    );
  });

  it("geminiAnalyzePdf throws when no candidates returned", async () => {
    mockFetchResponse({
      ok: true,
      json: async () => ({ candidates: [] }),
    });

    await expect(pdfNativeProviders.geminiAnalyzePdf(makeGeminiAnalyzeParams())).rejects.toThrow(
      "Gemini PDF returned no candidates",
    );
  });

  it("anthropicAnalyzePdf supports multiple PDFs", async () => {
    const fetchMock = mockFetchResponse({
      ok: true,
      json: async () => ({
        content: [{ type: "text", text: "Multi-doc analysis" }],
      }),
    });

    await pdfNativeProviders.anthropicAnalyzePdf(
      makeAnthropicAnalyzeParams({
        modelId: "claude-opus-4-6",
        prompt: "Compare these documents",
        pdfs: [
          { base64: "cGRmMQ==", filename: "doc1.pdf" },
          { base64: "cGRmMg==", filename: "doc2.pdf" },
        ],
      }),
    );

    const [, opts] = firstFetchCall(fetchMock) as [unknown, { body: string }];
    const body = JSON.parse(opts.body);
    expect(body.messages[0].content).toHaveLength(3);
    expect(body.messages[0].content[0].type).toBe("document");
    expect(body.messages[0].content[1].type).toBe("document");
    expect(body.messages[0].content[2].type).toBe("text");
  });

  it("anthropicAnalyzePdf uses custom base URL", async () => {
    const fetchMock = mockFetchResponse({
      ok: true,
      json: async () => ({
        content: [{ type: "text", text: "ok" }],
      }),
    });

    await pdfNativeProviders.anthropicAnalyzePdf(
      makeAnthropicAnalyzeParams({ baseUrl: "https://custom.example.com" }),
    );

    expect(firstFetchCall(fetchMock)[0]).toContain("https://custom.example.com/v1/messages");
  });

  it("anthropicAnalyzePdf requires apiKey", async () => {
    await expect(
      pdfNativeProviders.anthropicAnalyzePdf(makeAnthropicAnalyzeParams({ apiKey: "" })),
    ).rejects.toThrow("apiKey required");
  });

  it("geminiAnalyzePdf requires apiKey", async () => {
    await expect(
      pdfNativeProviders.geminiAnalyzePdf(makeGeminiAnalyzeParams({ apiKey: "" })),
    ).rejects.toThrow("apiKey required");
  });

  it("geminiAnalyzePdf does not duplicate /v1beta when baseUrl already includes it", async () => {
    const fetchMock = mockFetchResponse({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: "ok" }] } }],
      }),
    });

    await pdfNativeProviders.geminiAnalyzePdf(
      makeGeminiAnalyzeParams({
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      }),
    );

    const [url] = firstFetchCall(fetchMock);
    expect(url).toContain("/v1beta/models/");
    expect(url).not.toContain("/v1beta/v1beta");
  });

  it("geminiAnalyzePdf normalizes bare Google API hosts to a single /v1beta root", async () => {
    const fetchMock = mockFetchResponse({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: "ok" }] } }],
      }),
    });

    await pdfNativeProviders.geminiAnalyzePdf(
      makeGeminiAnalyzeParams({
        baseUrl: "https://generativelanguage.googleapis.com",
      }),
    );

    const [url] = firstFetchCall(fetchMock);
    expect(url).toContain("https://generativelanguage.googleapis.com/v1beta/models/");
    expect(url).not.toContain("/v1beta/v1beta");
  });
});
