// Native PDF provider tests cover direct Anthropic and Gemini request shapes,
// base URL handling, and bounded API error reporting.
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTestTimeout } from "../../../test/helpers/promise.js";
import { mintSecretSentinel } from "../../secrets/sentinel.js";
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
    requestConfig: Parameters<typeof pdfNativeProviders.anthropicAnalyzePdf>[0]["requestConfig"];
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

  const jsonResponse = (payload: unknown, init?: ResponseInit): Response =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
      ...init,
    });

  const textResponse = (body: string, init?: ResponseInit): Response => new Response(body, init);

  const mockFetchResponse = (response: Response) => {
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
    vi.unstubAllEnvs();
  });

  it("anthropicAnalyzePdf sends correct request shape", async () => {
    const fetchMock = mockFetchResponse(
      jsonResponse({
        content: [{ type: "text", text: "Analysis of PDF" }],
      }),
    );

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
      { body: string; headers: Headers; signal: AbortSignal },
    ];
    expect(url).toContain("/v1/messages");
    expect(opts.headers.get("x-api-key")).toBe("test-key");
    expect(opts.signal).toBeInstanceOf(AbortSignal);
    expect(opts.signal.aborted).toBe(false);
    const body = JSON.parse(opts.body);
    expect(body.model).toBe("claude-opus-4-6");
    expect(body.messages[0].content).toHaveLength(2);
    expect(body.messages[0].content[0].type).toBe("document");
    expect(body.messages[0].content[0].source.media_type).toBe("application/pdf");
    expect(body.messages[0].content[1].type).toBe("text");
  });

  it("unwraps sentinel-backed native PDF headers only at the request handoff", async () => {
    const apiKey = mintSecretSentinel("native-pdf-api-secret", {
      label: "model-auth:anthropic",
    });
    const managedHeader = mintSecretSentinel("native-pdf-managed-secret", {
      label: "model-auth:anthropic",
    });
    const fetchMock = mockFetchResponse(
      jsonResponse({ content: [{ type: "text", text: "Analysis" }] }),
    );

    await pdfNativeProviders.anthropicAnalyzePdf(
      makeAnthropicAnalyzeParams({
        apiKey,
        requestConfig: { headers: { "X-Managed": `Bearer ${managedHeader}` } },
      }),
    );

    const [, opts] = firstFetchCall(fetchMock) as [string, { headers: Headers }];
    expect(opts.headers.get("x-api-key")).toBe("native-pdf-api-secret");
    expect(opts.headers.get("X-Managed")).toBe("Bearer native-pdf-managed-secret");
  });

  it("anthropicAnalyzePdf honors ANTHROPIC_BASE_URL when no base URL is configured", async () => {
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://anthropic-pdf-proxy.example/v1");
    const fetchMock = mockFetchResponse(
      jsonResponse({
        content: [{ type: "text", text: "Analysis of PDF" }],
      }),
    );

    await pdfNativeProviders.anthropicAnalyzePdf(makeAnthropicAnalyzeParams());

    const [url] = firstFetchCall(fetchMock) as [string];
    expect(url).toBe("https://anthropic-pdf-proxy.example/v1/messages");
  });

  it("anthropicAnalyzePdf throws on API error", async () => {
    mockFetchResponse(textResponse("invalid request", { status: 400, statusText: "Bad Request" }));

    await expect(
      pdfNativeProviders.anthropicAnalyzePdf(makeAnthropicAnalyzeParams()),
    ).rejects.toThrow("Anthropic PDF request failed");
  });

  it("bounds large Anthropic API error bodies", async () => {
    // Provider errors can contain large or sensitive payloads; surface a compact
    // diagnostic and cancel the stream once the cap is reached.
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`${"x".repeat(9_000)}tail-marker`));
      },
      cancel() {
        canceled = true;
      },
    });
    mockFetchResponse(
      new Response(body, {
        status: 400,
        statusText: "Bad Request",
      }),
    );

    const error = await pdfNativeProviders
      .anthropicAnalyzePdf(makeAnthropicAnalyzeParams())
      .catch((caught: unknown) => caught);

    if (!(error instanceof Error)) {
      throw new Error("expected Anthropic PDF request to throw an Error");
    }
    expect(error.message).toContain("Anthropic PDF request failed");
    expect(error.message).not.toContain("tail-marker");
    expect(error.message.length).toBeLessThan(500);
    expect(canceled).toBe(true);
  });

  it("cancels Anthropic API error bodies that exactly fill the byte cap", async () => {
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(8 * 1024)));
      },
      cancel() {
        canceled = true;
      },
    });
    mockFetchResponse(
      new Response(body, {
        status: 400,
        statusText: "Bad Request",
      }),
    );

    const error = await withTestTimeout(
      pdfNativeProviders
        .anthropicAnalyzePdf(makeAnthropicAnalyzeParams())
        .catch((caught: unknown) => caught),
      500,
      "timed out waiting for bounded error body",
    );

    if (!(error instanceof Error)) {
      throw new Error("expected Anthropic PDF request to throw an Error");
    }
    expect(error.message).toContain("Anthropic PDF request failed");
    expect(canceled).toBe(true);
  });

  it("anthropicAnalyzePdf throws when response has no text", async () => {
    mockFetchResponse(
      jsonResponse({
        content: [{ type: "text", text: "   " }],
      }),
    );

    await expect(
      pdfNativeProviders.anthropicAnalyzePdf(makeAnthropicAnalyzeParams()),
    ).rejects.toThrow("Anthropic PDF returned no text");
  });

  it("anthropicAnalyzePdf trusts the exact configured local provider origin", async () => {
    const fetchMock = mockFetchResponse(
      jsonResponse({
        content: [{ type: "text", text: "ok" }],
      }),
    );

    await expect(
      pdfNativeProviders.anthropicAnalyzePdf(
        makeAnthropicAnalyzeParams({ baseUrl: "http://127.0.0.1:11434" }),
      ),
    ).resolves.toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("anthropicAnalyzePdf honors explicit private-network denial for a configured local origin", async () => {
    const fetchMock = mockFetchResponse(
      jsonResponse({
        content: [{ type: "text", text: "ok" }],
      }),
    );

    await expect(
      pdfNativeProviders.anthropicAnalyzePdf(
        makeAnthropicAnalyzeParams({
          baseUrl: "http://127.0.0.1:11434",
          requestConfig: {
            request: { allowPrivateNetwork: false },
          },
        }),
      ),
    ).rejects.toThrow(/private|SSRF|blocked/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("anthropicAnalyzePdf does not carry exact-origin trust across redirects", async () => {
    const fetchMock = mockFetchResponse(
      new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1:4321/v1/messages" },
      }),
    );

    await expect(
      pdfNativeProviders.anthropicAnalyzePdf(
        makeAnthropicAnalyzeParams({ baseUrl: "http://127.0.0.1:11434" }),
      ),
    ).rejects.toThrow(/private|SSRF|blocked/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("anthropicAnalyzePdf allows off-origin private redirects with explicit opt-in", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1:4321/v1/messages" },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          content: [{ type: "text", text: "ok" }],
        }),
      );
    global.fetch = Object.assign(fetchMock, { preconnect: vi.fn() }) as typeof global.fetch;

    await expect(
      pdfNativeProviders.anthropicAnalyzePdf(
        makeAnthropicAnalyzeParams({
          baseUrl: "http://127.0.0.1:11434",
          requestConfig: {
            request: { allowPrivateNetwork: true },
          },
        }),
      ),
    ).resolves.toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("anthropicAnalyzePdf rejects oversized successful JSON responses", async () => {
    mockFetchResponse(
      jsonResponse({
        content: [{ type: "text", text: "x".repeat(17 * 1024 * 1024) }],
      }),
    );

    await expect(
      pdfNativeProviders.anthropicAnalyzePdf(makeAnthropicAnalyzeParams()),
    ).rejects.toThrow("JSON response exceeds");
  });

  it("geminiAnalyzePdf sends correct request shape", async () => {
    // Gemini API keys belong in headers here, not query strings that are more
    // likely to leak through logs and URL diagnostics.
    const fetchMock = mockFetchResponse(
      jsonResponse({
        candidates: [{ content: { parts: [{ text: "Gemini PDF analysis" }] } }],
      }),
    );

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
      { body: string; headers: Headers; signal: AbortSignal },
    ];
    expect(url).toContain("generateContent");
    expect(url).toContain("gemini-2.5-pro");
    expect(url).not.toContain("?key=");
    expect(opts.headers.get("x-goog-api-key")).toBe("test-key");
    expect(opts.signal).toBeInstanceOf(AbortSignal);
    expect(opts.signal.aborted).toBe(false);
    const body = JSON.parse(opts.body);
    expect(body.contents[0].parts).toHaveLength(2);
    expect(body.contents[0].parts[0].inline_data.mime_type).toBe("application/pdf");
    expect(body.contents[0].parts[1].text).toBe("Summarize this");
  });

  it("geminiAnalyzePdf throws on API error", async () => {
    mockFetchResponse(
      textResponse("server error", { status: 500, statusText: "Internal Server Error" }),
    );

    await expect(pdfNativeProviders.geminiAnalyzePdf(makeGeminiAnalyzeParams())).rejects.toThrow(
      "Gemini PDF request failed",
    );
  });

  it("geminiAnalyzePdf throws when no candidates returned", async () => {
    mockFetchResponse(jsonResponse({ candidates: [] }));

    await expect(pdfNativeProviders.geminiAnalyzePdf(makeGeminiAnalyzeParams())).rejects.toThrow(
      "Gemini PDF returned no candidates",
    );
  });

  it("anthropicAnalyzePdf supports multiple PDFs", async () => {
    const fetchMock = mockFetchResponse(
      jsonResponse({
        content: [{ type: "text", text: "Multi-doc analysis" }],
      }),
    );

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
    const fetchMock = mockFetchResponse(
      jsonResponse({
        content: [{ type: "text", text: "ok" }],
      }),
    );

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
    const fetchMock = mockFetchResponse(
      jsonResponse({
        candidates: [{ content: { parts: [{ text: "ok" }] } }],
      }),
    );

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
    const fetchMock = mockFetchResponse(
      jsonResponse({
        candidates: [{ content: { parts: [{ text: "ok" }] } }],
      }),
    );

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
