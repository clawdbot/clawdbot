// Comfy tests cover workflow-runtime bounded-read delegation.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildComfyImageGenerationProvider } from "./image-generation-provider.js";
import { buildComfyMusicGenerationProvider } from "./music-generation-provider.js";
import { buildComfyConfig } from "./test-helpers.js";
import { setComfyFetchGuardForTesting } from "./test-support.js";
import { buildComfyVideoGenerationProvider } from "./video-generation-provider.js";
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

type ComfyDeadlineCapability = "image" | "music" | "video";
type ComfyDeadlineMode = "local" | "cloud";
type TimedComfyResponse = {
  elapsedMs: number;
  response: Response;
};

function comfyJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function comfyOutputKind(capability: ComfyDeadlineCapability): "images" | "audio" | "gifs" {
  if (capability === "music") {
    return "audio";
  }
  return capability === "video" ? "gifs" : "images";
}

function comfyOutputResponse(
  capability: ComfyDeadlineCapability,
  contents = "generated",
): Response {
  const contentType =
    capability === "music" ? "audio/mpeg" : capability === "video" ? "video/mp4" : "image/png";
  return new Response(Buffer.from(contents), {
    status: 200,
    headers: { "content-type": contentType },
  });
}

function comfyCompletedHistory(
  capability: ComfyDeadlineCapability,
  promptId: string,
  filenames: string[],
): Record<string, unknown> {
  return {
    [promptId]: {
      outputs: {
        "9": {
          [comfyOutputKind(capability)]: filenames.map((filename) => ({
            filename,
            subfolder: "",
            type: "output",
          })),
        },
      },
    },
  };
}

function comfyDeadlineConfig(params: {
  capability: ComfyDeadlineCapability;
  mode?: ComfyDeadlineMode;
  configuredTimeoutMs?: number;
  referenceImage?: boolean;
}) {
  return buildComfyConfig({
    ...(params.mode === "cloud" ? { mode: "cloud", apiKey: "comfy-deadline-test-key" } : {}),
    [params.capability]: {
      workflow: {
        "6": { inputs: { text: "" } },
        ...(params.referenceImage ? { "7": { inputs: { image: "" } } } : {}),
        "9": { inputs: {} },
      },
      promptNodeId: "6",
      outputNodeId: "9",
      ...(params.referenceImage ? { inputImageNodeId: "7" } : {}),
      ...(params.configuredTimeoutMs === undefined
        ? {}
        : { timeoutMs: params.configuredTimeoutMs }),
    },
  });
}

async function runComfyDeadlineFixture(params: {
  capability: ComfyDeadlineCapability;
  cfg: ReturnType<typeof buildComfyConfig>;
  timeoutMs: number;
  referenceImage?: boolean;
}): Promise<unknown> {
  const request = {
    provider: "comfy",
    model: "workflow",
    prompt: "enforce one Comfy operation budget",
    cfg: params.cfg,
    timeoutMs: params.timeoutMs,
    ...(params.referenceImage
      ? {
          inputImages: [
            { buffer: Buffer.from("reference"), mimeType: "image/png", fileName: "reference.png" },
          ],
        }
      : {}),
  };
  switch (params.capability) {
    case "image":
      return await buildComfyImageGenerationProvider().generateImage(request);
    case "music":
      return await buildComfyMusicGenerationProvider().generateMusic(request);
    case "video":
      return await buildComfyVideoGenerationProvider().generateVideo(request);
  }
}

describe("Comfy canonical workflow operation deadline", () => {
  const fetchGuard = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    setComfyFetchGuardForTesting(fetchGuard);
  });

  afterEach(() => {
    setComfyFetchGuardForTesting(null);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each<ComfyDeadlineCapability>(["image", "music", "video"])(
    "lets explicit %s request budgets override capability plugin configuration",
    async (capability) => {
      const promptId = `${capability}-deadline-1`;
      fetchGuard
        .mockResolvedValueOnce({
          response: comfyJsonResponse({ prompt_id: promptId }),
          release: vi.fn(async () => {}),
        })
        .mockResolvedValueOnce({
          response: comfyJsonResponse(comfyCompletedHistory(capability, promptId, ["result.bin"])),
          release: vi.fn(async () => {}),
        })
        .mockResolvedValueOnce({
          response: comfyOutputResponse(capability),
          release: vi.fn(async () => {}),
        });

      await runComfyDeadlineFixture({
        capability,
        cfg: comfyDeadlineConfig({ capability, configuredTimeoutMs: 9_000 }),
        timeoutMs: 1_250,
      });

      expect(fetchGuard.mock.calls.map(([request]) => request.timeoutMs)).toEqual([
        1_250, 1_250, 1_250,
      ]);
    },
  );

  it.each([
    {
      label: "local upload, submit, history, and every output download",
      capability: "image" as const,
      mode: "local" as const,
      referenceImage: true,
      expectedTimeouts: [600, 400, 250, 150, 50],
      stages: () => [
        { elapsedMs: 200, response: comfyJsonResponse({ name: "reference.png" }) },
        { elapsedMs: 150, response: comfyJsonResponse({ prompt_id: "local-budget-1" }) },
        {
          elapsedMs: 100,
          response: comfyJsonResponse(
            comfyCompletedHistory("image", "local-budget-1", ["first.png", "second.png"]),
          ),
        },
        { elapsedMs: 100, response: comfyOutputResponse("image", "first") },
        { elapsedMs: 60, response: comfyOutputResponse("image", "second") },
      ],
    },
    {
      label: "cloud submit, status poll, history, and output download",
      capability: "video" as const,
      mode: "cloud" as const,
      referenceImage: false,
      expectedTimeouts: [600, 400, 200, 50],
      stages: () => [
        { elapsedMs: 200, response: comfyJsonResponse({ prompt_id: "cloud-budget-1" }) },
        { elapsedMs: 200, response: comfyJsonResponse({ status: "completed" }) },
        {
          elapsedMs: 150,
          response: comfyJsonResponse(
            comfyCompletedHistory("video", "cloud-budget-1", ["generated.mp4"]),
          ),
        },
        { elapsedMs: 100, response: comfyOutputResponse("video") },
      ],
    },
  ])("keeps $label inside one absolute budget", async (scenario) => {
    const stages: TimedComfyResponse[] = scenario.stages();
    const releases: ReturnType<typeof vi.fn>[] = [];
    fetchGuard.mockImplementation(async () => {
      const stage = stages.shift();
      if (!stage) {
        throw new Error("Comfy workflow unexpectedly retried a guarded request");
      }
      vi.setSystemTime(Date.now() + stage.elapsedMs);
      const release = vi.fn(async () => {});
      releases.push(release);
      return { response: stage.response, release };
    });

    await expect(
      runComfyDeadlineFixture({
        capability: scenario.capability,
        cfg: comfyDeadlineConfig({
          capability: scenario.capability,
          mode: scenario.mode,
          referenceImage: scenario.referenceImage,
        }),
        timeoutMs: 600,
        referenceImage: scenario.referenceImage,
      }),
    ).rejects.toThrow("Comfy workflow did not finish within 1s");

    expect(fetchGuard.mock.calls.map(([request]) => request.timeoutMs)).toEqual(
      scenario.expectedTimeouts,
    );
    expect(releases).toHaveLength(scenario.expectedTimeouts.length);
    for (const release of releases) {
      expect(release).toHaveBeenCalledOnce();
    }
  });

  it("bounds a successful JSON body with the same operation budget", async () => {
    let interval: ReturnType<typeof setInterval> | undefined;
    let canceled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          let chunkCount = 0;
          interval = setInterval(() => {
            chunkCount += 1;
            if (chunkCount === 12) {
              controller.enqueue(new TextEncoder().encode("{}"));
              controller.close();
              clearInterval(interval);
              return;
            }
            controller.enqueue(new TextEncoder().encode(" "));
          }, 20);
        },
        cancel() {
          canceled = true;
          clearInterval(interval);
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    const release = vi.fn(async () => {});
    fetchGuard.mockResolvedValueOnce({ response, release });

    const read = readJsonResponseForTest({
      url: "http://127.0.0.1:8188/prompt",
      timeoutMs: 100,
      auditContext: "comfy-image-generate",
      errorPrefix: "Comfy workflow submit failed",
    });
    const outcome = read.then(
      (value) => ({ status: "fulfilled" as const, value }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    await vi.advanceTimersByTimeAsync(240);

    await expect(outcome).resolves.toMatchObject({
      status: "rejected",
      error: { message: "Comfy workflow did not finish within 1s" },
    });
    expect(canceled).toBe(true);
    expect(release).toHaveBeenCalledOnce();
  });

  it("prioritizes an expired workflow over a guarded timeout while draining HTTP 503", async () => {
    const guardTimeout = Object.assign(new Error("request timed out"), { name: "TimeoutError" });
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          timeoutId = setTimeout(() => controller.error(guardTimeout), 100);
        },
        cancel() {
          clearTimeout(timeoutId);
        },
      }),
      { status: 503, headers: { "content-type": "application/json" } },
    );
    const release = vi.fn(async () => {});
    fetchGuard.mockResolvedValueOnce({ response, release });

    const read = readJsonResponseForTest({
      url: "http://127.0.0.1:8188/prompt",
      timeoutMs: 100,
      auditContext: "comfy-image-generate",
      errorPrefix: "Comfy workflow submit failed",
    });
    const outcome = read.then(
      (value) => ({ status: "fulfilled" as const, value }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    await vi.advanceTimersByTimeAsync(100);

    await expect(outcome).resolves.toMatchObject({
      status: "rejected",
      error: { message: "Comfy workflow did not finish within 1s" },
    });
    expect(release).toHaveBeenCalledOnce();
    expect(fetchGuard).toHaveBeenCalledOnce();
  });

  it("normalizes a real-clock guarded connection timeout to the shipped workflow error", async () => {
    vi.useRealTimers();
    const timeoutMs = 25;
    fetchGuard.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, timeoutMs + 10));
      const error = new Error("request timed out");
      error.name = "TimeoutError";
      throw error;
    });

    await expect(
      readJsonResponseForTest({
        url: "http://127.0.0.1:8188/prompt",
        timeoutMs,
        auditContext: "comfy-image-generate",
        errorPrefix: "Comfy workflow submit failed",
      }),
    ).rejects.toThrow("Comfy workflow did not finish within 1s");

    expect(fetchGuard).toHaveBeenCalledOnce();
  });
});
