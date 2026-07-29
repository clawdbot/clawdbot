// Verifies OpenRouter model scan filtering, metadata normalization, and timeouts.
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { withFetchPreconnect } from "../test-utils/fetch-mock.js";
import { scanOpenRouterModels } from "./model-scan.js";

function createFetchFixture(payload: unknown): typeof fetch {
  // scanOpenRouterModels accepts an injected fetch so tests stay offline while
  // exercising OpenRouter's catalog response shape.
  return withFetchPreconnect(
    async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
}

describe("scanOpenRouterModels", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("lists free models without probing", async () => {
    const fetchImpl = createFetchFixture({
      data: [
        {
          id: "acme/free-by-pricing",
          name: "Free By Pricing",
          context_length: 16_384,
          max_completion_tokens: 1024,
          supported_parameters: ["tools", "tool_choice", "temperature"],
          modality: "text",
          pricing: { prompt: "0", completion: "0", request: "0", image: "0" },
          created_at: 1_700_000_000,
        },
        {
          id: "acme/free-by-suffix:free",
          name: "Free By Suffix",
          context_length: 8_192,
          supported_parameters: [],
          modality: "text",
          pricing: { prompt: "0", completion: "0" },
        },
        {
          id: "acme/paid",
          name: "Paid",
          context_length: 4_096,
          supported_parameters: ["tools"],
          modality: "text",
          pricing: { prompt: "0.000001", completion: "0.000002" },
        },
      ],
    });

    const results = await scanOpenRouterModels({
      fetchImpl,
      probe: false,
    });

    expect(results.map((entry) => entry.id)).toEqual([
      "acme/free-by-pricing",
      "acme/free-by-suffix:free",
    ]);

    const [byPricing] = results;
    if (byPricing === undefined) {
      throw new Error("Expected pricing-based model result.");
    }
    expect(byPricing.supportsToolsMeta).toBe(true);
    expect(byPricing.supportedParametersCount).toBe(3);
    expect(byPricing.isFree).toBe(true);
    expect(byPricing.tool.skipped).toBe(true);
    expect(byPricing.image.skipped).toBe(true);
  });

  it("drops out-of-range OpenRouter created_at timestamps", async () => {
    const fetchImpl = createFetchFixture({
      data: [
        {
          id: "acme/free-invalid-created:free",
          name: "Free Invalid Created",
          context_length: 16_384,
          supported_parameters: [],
          modality: "text",
          created_at: 8_640_000_000_000_001,
        },
      ],
    });

    const [result] = await scanOpenRouterModels({
      fetchImpl,
      probe: false,
    });

    expect(result?.createdAtMs).toBeNull();
  });

  it("cancels catalog error response bodies", async () => {
    const response = new Response("unavailable", { status: 503 });
    const cancel = vi.spyOn(response.body!, "cancel").mockResolvedValue(undefined);
    const fetchImpl = withFetchPreconnect(async () => response);

    await expect(scanOpenRouterModels({ fetchImpl, probe: false })).rejects.toThrow(/HTTP 503/);

    expect(cancel).toHaveBeenCalledOnce();
  });

  it("bounds an oversized catalog success body and cancels the stream", async () => {
    // The success body is provider-controlled and runtime-fetched. A faulty or
    // hostile provider can stream an effectively unbounded JSON document; the
    // read must stop at the byte cap, cancel the upstream stream, and surface a
    // clear overflow error instead of buffering the whole payload into memory.
    const cancel = vi.fn(async () => undefined);
    let pullCount = 0;
    const chunk = new Uint8Array(64 * 1024).fill(0x20); // 64 KiB of spaces
    const fetchImpl = withFetchPreconnect(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              // Valid JSON array prefix so the body would parse if ever read in full.
              controller.enqueue(new TextEncoder().encode('{"data":['));
            },
            pull(controller) {
              pullCount += 1;
              controller.enqueue(chunk);
            },
            cancel,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    await expect(scanOpenRouterModels({ fetchImpl, probe: false })).rejects.toThrow(
      /OpenRouter \/models response too large/,
    );

    // The reader stopped early instead of draining an unbounded stream, and
    // cancelled the upstream body once the byte cap was crossed.
    expect(cancel).toHaveBeenCalledOnce();
    expect(pullCount).toBeGreaterThan(0);
    expect(pullCount).toBeLessThan(16 * 1024 * 1024); // nowhere near draining forever
  });

  it("rejects a malformed catalog success body", async () => {
    const fetchImpl = withFetchPreconnect(
      async () =>
        new Response("not json at all", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    await expect(scanOpenRouterModels({ fetchImpl, probe: false })).rejects.toThrow(
      /OpenRouter \/models response is malformed JSON/,
    );
  });

  it("requires an API key when probing", async () => {
    const fetchImpl = createFetchFixture({ data: [] });
    await withEnvAsync({ OPENROUTER_API_KEY: undefined }, async () => {
      await expect(
        scanOpenRouterModels({
          fetchImpl,
          probe: true,
          apiKey: "",
        }),
      ).rejects.toThrow(/Missing OpenRouter API key/);
    });
  });

  it("applies the scan timeout before the OpenRouter catalog responds", async () => {
    vi.useFakeTimers();
    const fetchImpl: typeof fetch = async (_input, init) =>
      await new Promise<Response>((_resolve, reject) => {
        const signal = typeof init === "object" && init ? init.signal : undefined;
        if (signal?.aborted) {
          reject(new Error("catalog aborted"));
          return;
        }
        signal?.addEventListener("abort", () => reject(new Error("catalog aborted")), {
          once: true,
        });
      });

    const scan = expect(
      scanOpenRouterModels({
        fetchImpl,
        probe: false,
        timeoutMs: 1,
      }),
    ).rejects.toThrow(/catalog aborted/);

    await vi.advanceTimersByTimeAsync(1);
    await scan;
  });

  it("keeps the catalog timeout active while reading a streaming body", async () => {
    vi.useFakeTimers();
    const timeoutMs = 20;
    const chunkIntervalMs = 5;
    const encoder = new TextEncoder();
    let chunkCount = 0;
    let abortCount = 0;

    const fetchImpl = withFetchPreconnect(async (_input, init) => {
      const signal = typeof init === "object" && init ? init.signal : undefined;
      if (!signal) {
        throw new Error("Expected catalog request signal");
      }
      let interval: ReturnType<typeof setInterval> | undefined;
      let completionTimer: ReturnType<typeof setTimeout> | undefined;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('{"data":['));
            interval = setInterval(() => {
              chunkCount += 1;
              controller.enqueue(encoder.encode(" "));
            }, chunkIntervalMs);
            completionTimer = setTimeout(() => {
              clearInterval(interval);
              controller.enqueue(encoder.encode("]}"));
              controller.close();
            }, timeoutMs + chunkIntervalMs);
            signal.addEventListener(
              "abort",
              () => {
                abortCount += 1;
                clearInterval(interval);
                clearTimeout(completionTimer);
                controller.error(signal.reason);
              },
              { once: true },
            );
          },
          cancel() {
            clearInterval(interval);
            clearTimeout(completionTimer);
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const scan = expect(
      scanOpenRouterModels({ fetchImpl, probe: false, timeoutMs }),
    ).rejects.toThrow(/aborted/i);

    await vi.advanceTimersByTimeAsync(timeoutMs - 1);
    expect(chunkCount).toBe(3);
    expect(abortCount).toBe(0);

    await vi.advanceTimersByTimeAsync(chunkIntervalMs + 1);
    await scan;
    expect(abortCount).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("caps oversized scan timeouts before scheduling catalog aborts", async () => {
    // Timer APIs cannot safely schedule above the platform max; cap before
    // creating the catalog abort timeout.
    const timeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockReturnValue(1 as unknown as ReturnType<typeof setTimeout>);
    vi.spyOn(globalThis, "clearTimeout").mockImplementation(() => undefined);
    const fetchImpl = createFetchFixture({ data: [] });

    await scanOpenRouterModels({
      fetchImpl,
      probe: false,
      timeoutMs: MAX_TIMER_TIMEOUT_MS + 1_000_000,
    });

    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
  });

  it("does not match provider filters across provider id variants", async () => {
    // Provider filters are literal OpenRouter owner ids. Do not normalize z.ai
    // into z-ai here or scans will include unintended rows.
    const fetchImpl = createFetchFixture({
      data: [
        {
          id: "z.ai/glm-5",
          name: "GLM-5",
          context_length: 128_000,
          supported_parameters: [],
          modality: "text",
          pricing: { prompt: "0", completion: "0" },
        },
        {
          id: "openai/gpt-5",
          name: "GPT-5",
          context_length: 128_000,
          supported_parameters: [],
          modality: "text",
          pricing: { prompt: "0", completion: "0" },
        },
      ],
    });

    const results = await scanOpenRouterModels({
      fetchImpl,
      probe: false,
      providerFilter: "z-ai",
    });

    expect(results.map((entry) => entry.id)).toEqual([]);
  });
});
