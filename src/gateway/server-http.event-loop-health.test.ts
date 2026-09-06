import { get } from "node:http";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { AUTH_NONE, withGatewayServer } from "./server-http.test-harness.js";
import { createGatewayEventLoopHealthMonitor } from "./server/event-loop-health.js";

async function readJson(url: string): Promise<Record<string, unknown>> {
  const { statusCode, body: responseBody } = await new Promise<{
    statusCode: number | undefined;
    body: string;
  }>((resolve, reject) => {
    const request = get(url, { agent: false }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      response.once("end", () => {
        resolve({ statusCode: response.statusCode, body });
      });
    });
    request.once("error", reject);
  });
  expect(statusCode).toBe(200);
  return JSON.parse(responseBody);
}

const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

describe("Gateway HTTP event-loop sampling", () => {
  it("retains a blocked request interval when readiness is read before the sampler resumes", async () => {
    const monitor = createGatewayEventLoopHealthMonitor();
    const startedAt = Date.now();
    let blockNextRead = false;
    let blockedMs = 0;
    try {
      await withGatewayServer({
        prefix: "event-loop-http-owner",
        resolvedAuth: AUTH_NONE,
        overrides: {
          getReadiness: () => {
            if (blockNextRead) {
              blockNextRead = false;
              const start = performance.now();
              while (performance.now() - start < 1_200) {
                // Reproduce synchronous request work before the overdue timer can run.
              }
              blockedMs = performance.now() - start;
              const beforePendingSample = monitor.snapshot();
              for (let index = 0; index < 100; index++) {
                expect(monitor.snapshot()).toBe(beforePendingSample);
              }
            }
            return {
              ready: true,
              failing: [],
              uptimeMs: Date.now() - startedAt,
              eventLoop: monitor.snapshot(),
            };
          },
        },
        run: async (server) => {
          await new Promise<void>((resolve) => {
            server.listen(0, "127.0.0.1", resolve);
          });
          try {
            const address = server.address();
            if (!address || typeof address === "string") {
              throw new Error("expected a TCP listener");
            }
            const url = `http://127.0.0.1:${address.port}/readyz`;
            await delay(1_100);
            const initial = await readJson(url);
            expect(initial.ready).toBe(true);
            blockNextRead = true;
            await readJson(url);
            expect(blockedMs).toBeGreaterThanOrEqual(1_200);
            await delay(100);
            const after = await readJson(url);
            expect(after).toMatchObject({
              ready: true,
              eventLoop: {
                degraded: true,
                reasons: expect.arrayContaining(["event_loop_delay"]),
                delayMaxMs: expect.any(Number),
              },
            });
            expect((after.eventLoop as { delayMaxMs: number }).delayMaxMs).toBeGreaterThanOrEqual(
              1_000,
            );
            await delay(1_100);
            const recovered = await readJson(url);
            expect(recovered).toMatchObject({ ready: true, eventLoop: { degraded: false } });
          } finally {
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => {
              server.close((error) => (error ? reject(error) : resolve()));
            });
          }
        },
      });
    } finally {
      monitor.stop();
    }
    expect(monitor.snapshot()).toBeUndefined();
  });
});
