// Comfy tests cover workflow-runtime bounded-read delegation.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setComfyFetchGuardForTesting } from "./test-support.js";
import { readJsonResponseForTest } from "./workflow-runtime.js";

describe("readJsonResponse bounded read (readProviderJsonResponse delegation)", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    setComfyFetchGuardForTesting(null);
    vi.restoreAllMocks();
  });

  it("cancels oversized JSON body via the 16 MiB provider cap", async () => {
    const ONE_MIB = 1024 * 1024;
    const TOTAL_CHUNKS = 32;
    const chunk = new Uint8Array(ONE_MIB);

    let bytesPulled = 0;
    let canceled = false;
    const oversizedJson = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (bytesPulled >= TOTAL_CHUNKS * ONE_MIB) {
            controller.close();
            return;
          }
          bytesPulled += chunk.length;
          controller.enqueue(chunk);
        },
        cancel() {
          canceled = true;
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );

    const release = vi.fn(async () => {});
    fetchMock.mockResolvedValueOnce({ response: oversizedJson, release });
    setComfyFetchGuardForTesting(fetchMock);

    await expect(
      readJsonResponseForTest({
        url: "http://127.0.0.1:9999/test",
        init: { method: "GET" },
        timeoutMs: 10_000,
        auditContext: "comfy-test",
        errorPrefix: "Comfy test failed",
      }),
    ).rejects.toThrow(/JSON response exceeds 16777216 bytes/);

    expect(canceled).toBe(true);
    expect(bytesPulled).toBeLessThan(TOTAL_CHUNKS * ONE_MIB);
    expect(release).toHaveBeenCalledOnce();
  });

  it("rejects oversized body with correct error prefix", async () => {
    const ONE_MIB = 1024 * 1024;
    const chunk = new Uint8Array(ONE_MIB);

    let bytesPulled = 0;
    let canceled = false;
    const oversizedJson = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (bytesPulled >= 32 * ONE_MIB) {
            controller.close();
            return;
          }
          bytesPulled += chunk.length;
          controller.enqueue(chunk);
        },
        cancel() {
          canceled = true;
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );

    const release = vi.fn(async () => {});
    fetchMock.mockResolvedValueOnce({ response: oversizedJson, release });
    setComfyFetchGuardForTesting(fetchMock);

    await expect(
      readJsonResponseForTest({
        url: "http://127.0.0.1:9999/test",
        init: { method: "GET" },
        timeoutMs: 10_000,
        auditContext: "comfy-test",
        errorPrefix: "Comfy test failed",
      }),
    ).rejects.toThrow(/^Comfy test failed: JSON response exceeds 16777216 bytes/);

    expect(canceled).toBe(true);
    expect(bytesPulled).toBeLessThan(32 * ONE_MIB);
  });

  it("parses small valid JSON body (negative control)", async () => {
    const smallBody = { status: "ok" };

    const release = vi.fn(async () => {});
    fetchMock.mockResolvedValueOnce({
      response: new Response(JSON.stringify(smallBody), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
      release,
    });
    setComfyFetchGuardForTesting(fetchMock);

    const result = await readJsonResponseForTest<{ status: string }>({
      url: "http://127.0.0.1:9999/test",
      init: { method: "GET" },
      timeoutMs: 10_000,
      auditContext: "comfy-test",
      errorPrefix: "Comfy test failed",
    });

    expect(result.status).toBe("ok");
    expect(release).toHaveBeenCalledOnce();
  });

  it("parses valid JSON with expected comfy response shape (happy path)", async () => {
    const comfyResponse = { prompt_id: "abc-123" };

    const release = vi.fn(async () => {});
    fetchMock.mockResolvedValueOnce({
      response: new Response(JSON.stringify(comfyResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
      release,
    });
    setComfyFetchGuardForTesting(fetchMock);

    const result = await readJsonResponseForTest<{ prompt_id: string }>({
      url: "http://127.0.0.1:9999/test",
      init: { method: "GET" },
      timeoutMs: 10_000,
      auditContext: "comfy-test",
      errorPrefix: "Comfy test failed",
    });

    expect(result.prompt_id).toBe("abc-123");
    expect(release).toHaveBeenCalledOnce();
  });

  it("propagates HTTP error status before reading body", async () => {
    const release = vi.fn(async () => {});
    fetchMock.mockResolvedValueOnce({
      response: new Response(null, { status: 500, statusText: "Internal Server Error" }),
      release,
    });
    setComfyFetchGuardForTesting(fetchMock);

    await expect(
      readJsonResponseForTest({
        url: "http://127.0.0.1:9999/test",
        init: { method: "GET" },
        timeoutMs: 10_000,
        auditContext: "comfy-test",
        errorPrefix: "Comfy test failed",
      }),
    ).rejects.toThrow(/Comfy test failed/);

    expect(release).toHaveBeenCalledOnce();
  });
});
