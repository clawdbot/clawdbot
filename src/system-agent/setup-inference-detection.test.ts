import { createServer, get } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SetupInferenceDetection } from "./setup-inference.js";

const blockingWorkerUrl = new URL(
  `data:text/javascript,${encodeURIComponent(`
    import { parentPort, workerData } from "node:worker_threads";
    parentPort.postMessage({ type: "partial", detection: workerData.partialDetection });
    const deadline = Date.now() + workerData.blockMs;
    while (Date.now() < deadline) {}
    parentPort.postMessage({ type: "result", detection: workerData.detection });
    parentPort.close();
  `)}`,
);

function emptyDetection(): SetupInferenceDetection {
  return {
    candidates: [],
    unavailableCandidates: [],
    manualProviders: [],
    authOptions: [],
    recommendedInstalls: [],
    workspace: "/tmp/work",
    setupComplete: false,
  };
}

const servers = new Set<ReturnType<typeof createServer>>();

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
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
  servers.clear();
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
    const fallback = emptyDetection();

    const pendingStartedAt = performance.now();
    const pending = detectSetupInferenceIsolated({
      workerUrl: blockingWorkerUrl,
      workerData: {
        blockMs: 10_000,
        detection: emptyDetection(),
        partialDetection: fallback,
      },
      timeoutMs: 100,
    });
    const startedAt = performance.now();
    const response = await requestHealth(`http://127.0.0.1:${address.port}/health`);
    const elapsedMs = performance.now() - startedAt;

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ ok: true, status: "live" });
    expect(elapsedMs).toBeLessThan(500);
    await expect(pending).resolves.toEqual(fallback);
    expect(performance.now() - pendingStartedAt).toBeLessThan(1_000);
  });

  it("coalesces concurrent detections behind one bounded worker", async () => {
    const { detectSetupInferenceIsolated } = await loadDetectionModule();
    const fallback = vi.fn(async () => emptyDetection());
    const options = {
      workerUrl: blockingWorkerUrl,
      workerData: {
        blockMs: 10_000,
        detection: emptyDetection(),
        partialDetection: emptyDetection(),
      },
      timeoutMs: 50,
      fallback,
    };

    const [first, second] = await Promise.all([
      detectSetupInferenceIsolated(options),
      detectSetupInferenceIsolated(options),
    ]);

    expect(first).toEqual(emptyDetection());
    expect(second).toEqual(emptyDetection());
    expect(fallback).toHaveBeenCalledOnce();
  });
});
