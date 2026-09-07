import { channel } from "node:diagnostics_channel";
import fs from "node:fs/promises";
import { createServer, get } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_AGENT_WORKSPACE_DIR } from "../agents/workspace-default.js";
import { listRecommendedToolInstalls } from "../plugins/recommended-tool-installs.js";
import type { SetupInferenceDetection } from "./setup-inference.js";

const blockingWorkerUrl = new URL(
  `data:text/javascript,${encodeURIComponent(`
    import { parentPort, workerData } from "node:worker_threads";
    if (workerData.started) {
      Atomics.add(new Int32Array(workerData.started), 0, 1);
    }
    parentPort.postMessage({ type: "partial", detection: workerData.partialDetection });
    const deadline = Date.now() + workerData.blockMs;
    while (Date.now() < deadline) {}
    parentPort.postMessage({ type: "result", detection: workerData.detection });
    parentPort.close();
  `)}`,
);

const silentBlockingWorkerUrl = new URL(
  `data:text/javascript,${encodeURIComponent(`
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {}
  `)}`,
);

function emptyDetection(): SetupInferenceDetection {
  return {
    candidates: [],
    unavailableCandidates: [],
    manualProviders: [],
    authOptions: [],
    prepareOptions: [],
    recommendedInstalls: listRecommendedToolInstalls(),
    workspace: DEFAULT_AGENT_WORKSPACE_DIR,
    setupComplete: false,
  };
}

function detectedCodex(): SetupInferenceDetection {
  return {
    ...emptyDetection(),
    candidates: [
      {
        kind: "codex-cli",
        modelRef: "openai/gpt-5.5",
        label: "Codex",
        detail: "logged in",
        credentials: true,
        recommended: false,
      },
    ],
  };
}

const servers = new Set<ReturnType<typeof createServer>>();
const tempHomes = new Set<string>();

beforeEach(() => {
  vi.resetModules();
});

async function loadDetectionModule() {
  return await import("./setup-inference-detection.js");
}

async function requestHealth(url: string): Promise<{ body: string; statusCode: number }> {
  return await new Promise((resolve, reject) => {
    const request = get(url, { agent: false, headers: { connection: "close" } }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => resolve({ body, statusCode: response.statusCode ?? 0 }));
    });
    request.on("error", reject);
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all([
    ...[...servers].map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
    ...[...tempHomes].map((home) => fs.rm(home, { recursive: true, force: true })),
  ]);
  servers.clear();
  tempHomes.clear();
});

describe("isolated setup inference detection", () => {
  it("keeps HTTP responsive while a detection worker is synchronously blocked", async () => {
    const { detectSetupInferenceIsolated } = await loadDetectionModule();
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true,"status":"live"}');
    });
    servers.add(server);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        resolve();
      });
    });
    const address = server.address() as AddressInfo;
    const fallback = detectedCodex();

    const pendingStartedAt = performance.now();
    const pending = detectSetupInferenceIsolated({
      workerUrl: blockingWorkerUrl,
      workerData: {
        blockMs: 30_000,
        detection: emptyDetection(),
        partialDetection: fallback,
      },
      // Generous timeout: the partial must arrive before the deadline even on a
      // loaded CI runner, or the empty-timeout path rejects and this flakes.
      timeoutMs: 3_000,
      fallbackEnv: {},
    });
    const startedAt = performance.now();
    const response = await requestHealth(`http://127.0.0.1:${address.port}/health`);
    const elapsedMs = performance.now() - startedAt;

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ ok: true, status: "live" });
    expect(elapsedMs).toBeLessThan(500);
    const detection = await pending;
    expect(detection).toMatchObject({
      candidates: fallback.candidates,
      unavailableCandidates: fallback.unavailableCandidates,
      manualProviders: fallback.manualProviders,
      authOptions: fallback.authOptions,
      recommendedInstalls: fallback.recommendedInstalls,
      workspace: fallback.workspace,
      setupComplete: fallback.setupComplete,
    });
    expect(detection.prepareOptions ?? []).toEqual([]);
    expect(performance.now() - pendingStartedAt).toBeLessThan(10_000);
  });

  it("rejects an empty timeout with an actionable typed error", async () => {
    const { detectSetupInferenceIsolated } = await loadDetectionModule();

    await expect(
      detectSetupInferenceIsolated({
        workerUrl: silentBlockingWorkerUrl,
        timeoutMs: 50,
        fallbackEnv: {},
      }),
    ).rejects.toMatchObject({
      name: "SetupInferenceDetectionTimeoutError",
      message:
        "AI access detection did not finish after 0.05s. " +
        "This Gateway may still be checking — try again.",
    });
  });

  it("returns partial candidates when detection times out", async () => {
    const { detectSetupInferenceIsolated } = await loadDetectionModule();
    const partial = detectedCodex();

    const detection = await detectSetupInferenceIsolated({
      workerUrl: blockingWorkerUrl,
      workerData: {
        blockMs: 30_000,
        detection: emptyDetection(),
        partialDetection: partial,
      },
      // Generous timeout: the partial must beat the deadline on loaded CI
      // runners, or the empty-timeout rejection makes this flake.
      timeoutMs: 3_000,
      fallbackEnv: {},
    });

    expect(detection).toEqual(partial);
  });

  it("returns ambient API keys when detection times out", async () => {
    const { detectSetupInferenceIsolated } = await loadDetectionModule();

    const detection = await detectSetupInferenceIsolated({
      workerUrl: blockingWorkerUrl,
      workerData: {
        blockMs: 10_000,
        detection: emptyDetection(),
        partialDetection: emptyDetection(),
      },
      timeoutMs: 50,
      fallbackEnv: {
        OPENAI_API_KEY: "test-openai-key",
        ANTHROPIC_API_KEY: "test-anthropic-key",
      },
    });

    expect(detection.candidates).toEqual([
      {
        kind: "openai-api-key",
        brandId: "openai",
        modelRef: "openai/gpt-5.6-sol",
        label: "OpenAI API key",
        detail: "OPENAI_API_KEY set",
        credentials: true,
        recommended: false,
      },
      {
        kind: "anthropic-api-key",
        brandId: "anthropic",
        modelRef: "anthropic/claude-opus-5",
        label: "Anthropic API key",
        detail: "ANTHROPIC_API_KEY set",
        credentials: true,
        recommended: false,
      },
    ]);
  });

  it("returns stored CLI credentials when detection times out", async () => {
    const { detectSetupInferenceIsolated } = await loadDetectionModule();
    const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-detect-")));
    tempHomes.add(home);
    const authPath = path.join(home, ".codex", "auth.json");
    await fs.mkdir(path.dirname(authPath), { recursive: true });
    await fs.writeFile(
      authPath,
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { access_token: "codex-access", refresh_token: "codex-refresh" },
      }),
      "utf8",
    );

    const detection = await detectSetupInferenceIsolated({
      workerUrl: blockingWorkerUrl,
      workerData: {
        blockMs: 10_000,
        detection: emptyDetection(),
        partialDetection: emptyDetection(),
      },
      timeoutMs: 50,
      fallbackEnv: { HOME: home },
    });

    expect(detection.candidates).toEqual([
      {
        kind: "codex-cli",
        brandId: "openai",
        modelRef: "openai/gpt-5.6-sol",
        label: "Codex",
        detail: "credential file found",
        credentials: true,
        recommended: false,
      },
    ]);
  });

  it("waits for timed-out worker shutdown before running a fresh detection", async () => {
    const { detectSetupInferenceIsolated } = await loadDetectionModule();
    let releaseShutdown: (() => void) | undefined;
    const shutdownGate = new Promise<void>((resolve) => {
      releaseShutdown = resolve;
    });
    const unrelatedWorker = new Worker(silentBlockingWorkerUrl);
    const capturedWorkers: Worker[] = [];
    const workerChannel = channel("worker_threads");
    const captureWorker = (message: unknown) => {
      // SAFETY: Node publishes { worker: this } synchronously from the Worker constructor.
      capturedWorkers.push((message as { worker: Worker }).worker);
    };
    let detection: Promise<SetupInferenceDetection> | undefined;
    let retry: Promise<SetupInferenceDetection> | undefined;
    let gatedWorker: Worker | undefined;
    try {
      // Observe only this synchronous construction, not another worker's later shutdown.
      workerChannel.subscribe(captureWorker);
      try {
        detection = detectSetupInferenceIsolated({
          workerUrl: silentBlockingWorkerUrl,
          timeoutMs: 50,
          fallbackEnv: {},
        });
      } finally {
        workerChannel.unsubscribe(captureWorker);
      }
      expect(capturedWorkers).toHaveLength(1);
      const detectorWorker = capturedWorkers[0]!;
      const terminate = detectorWorker.terminate.bind(detectorWorker);
      vi.spyOn(detectorWorker, "terminate").mockImplementationOnce(async () => {
        gatedWorker = detectorWorker;
        const code = await terminate();
        await shutdownGate;
        return code;
      });
      const unrelatedShutdown = unrelatedWorker.terminate();
      expect(gatedWorker).toBeUndefined();
      await expect(detection).rejects.toThrow("AI access detection did not finish");
      await unrelatedShutdown;
      expect(unrelatedWorker.threadId).toBe(-1);
      expect(gatedWorker).toBe(capturedWorkers[0]);

      let retrySettled = false;
      const fresh = detectedCodex();
      retry = detectSetupInferenceIsolated({
        workerUrl: blockingWorkerUrl,
        workerData: {
          blockMs: 0,
          detection: fresh,
          partialDetection: emptyDetection(),
        },
        timeoutMs: 5_000,
        fallbackEnv: {},
      }).then((result) => {
        retrySettled = true;
        return result;
      });
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20);
      });

      expect(retrySettled).toBe(false);
      releaseShutdown?.();
      await expect(retry).resolves.toEqual(fresh);
    } finally {
      releaseShutdown?.();
      const settled = Promise.allSettled([detection, retry]);
      await Promise.all([unrelatedWorker, ...capturedWorkers].map((worker) => worker.terminate()));
      await settled;
    }
  });

  it("returns successful worker results unchanged", async () => {
    const { detectSetupInferenceIsolated } = await loadDetectionModule();
    const detected = detectedCodex();

    const detection = await detectSetupInferenceIsolated({
      workerUrl: blockingWorkerUrl,
      workerData: {
        blockMs: 0,
        detection: detected,
        partialDetection: emptyDetection(),
      },
      timeoutMs: 5_000,
      fallbackEnv: {},
    });

    expect(detection).toEqual(detected);
  });

  it("coalesces concurrent detections behind one bounded worker", async () => {
    const { detectSetupInferenceIsolated } = await loadDetectionModule();
    const started = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const detected = detectedCodex();
    const options = {
      workerUrl: blockingWorkerUrl,
      workerData: {
        blockMs: 100,
        detection: detected,
        partialDetection: emptyDetection(),
        started,
      },
      timeoutMs: 5_000,
      fallbackEnv: {},
    };

    const [first, second] = await Promise.all([
      detectSetupInferenceIsolated(options),
      detectSetupInferenceIsolated(options),
    ]);

    expect(first).toEqual(detected);
    expect(second).toEqual(detected);
    expect(Atomics.load(new Int32Array(started), 0)).toBe(1);
  });

  it("serializes different owners and reruns detection for the second owner", async () => {
    const { detectSetupInferenceIsolated } = await loadDetectionModule();
    const started = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const firstDetection = detectedCodex();
    const secondDetection = {
      ...emptyDetection(),
      workspace: "/tmp/research",
    };

    const first = detectSetupInferenceIsolated({
      agentId: "main",
      workerUrl: blockingWorkerUrl,
      workerData: {
        blockMs: 100,
        detection: firstDetection,
        partialDetection: emptyDetection(),
        started,
      },
      timeoutMs: 5_000,
      fallbackEnv: {},
    });
    const second = detectSetupInferenceIsolated({
      agentId: "research",
      workerUrl: blockingWorkerUrl,
      workerData: {
        blockMs: 0,
        detection: secondDetection,
        partialDetection: emptyDetection(),
        started,
      },
      timeoutMs: 5_000,
      fallbackEnv: {},
    });

    await expect(first).resolves.toEqual(firstDetection);
    await expect(second).resolves.toEqual(secondDetection);
    expect(Atomics.load(new Int32Array(started), 0)).toBe(2);
  });
});
