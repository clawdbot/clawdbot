import { afterEach, describe, expect, it, vi } from "vitest";
import { summarizePdfViaStrategyService } from "./strategy-service-client.js";

describe("summarizePdfViaStrategyService", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("posts multipart data to the configured service and returns the summary payload", async () => {
    vi.stubEnv("STRATEGY_SERVICE_URL", "http://127.0.0.1:8011");
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          doc_id: "doc-123",
          model: "deepseek/deepseek-v3.2",
          engine: "cloudflare-ai",
          summary: "PDF summary",
          annotations_cached: true,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await summarizePdfViaStrategyService({
      filename: "test.pdf",
      mimeType: "application/pdf",
      bytes: new Uint8Array([1, 2, 3]),
    });

    expect(result.summary).toBe("PDF summary");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.1:8011/pdf/summarize");
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBeInstanceOf(FormData);
  });
});
