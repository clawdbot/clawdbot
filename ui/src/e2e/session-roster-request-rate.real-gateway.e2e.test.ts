import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import {
  connectGatewayClient,
  disconnectGatewayClient,
} from "../../../src/gateway/test-helpers.e2e.ts";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const EVENT_COUNT = 42;
const EVENT_INTERVAL_MS = 70;
const SETTLE_MS = 1_500;
const MAX_REQUESTS_PER_QUERY = 4;
const MIN_REQUEST_GAP_MS = 950;

type SessionListTrace = {
  atMs: number;
  params: unknown;
  query: string;
};

type ScenarioTrace = {
  burstEndedAtMs: number;
  eventCount: number;
  eventIntervalMs: number;
  name: string;
  requests: SessionListTrace[];
};

let instance: OpenClawTestInstance | undefined;
const suite = createControlUiE2eSuite({
  name: "Control UI session roster request rate with a real Gateway",
  startServerBeforeBrowser: true,
  async startServer() {
    const owner = await createOpenClawTestInstance({
      name: "control-ui-session-roster-request-rate",
      config: {
        agents: {
          ownership: "explicit",
          entries: {
            main: { name: "Main" },
            research: { name: "Research" },
          },
        },
        gateway: { controlUi: { enabled: true } },
      },
    });
    instance = owner;
    try {
      await owner.startGateway();
      return { baseUrl: `http://127.0.0.1:${owner.port}/`, close: () => owner.cleanup() };
    } catch (error) {
      await runQaGatewayFixture(
        async () => {
          throw error;
        },
        () => owner.cleanup(),
      );
      throw error;
    }
  },
});

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function groupByQuery(requests: SessionListTrace[]): Map<string, SessionListTrace[]> {
  const grouped = new Map<string, SessionListTrace[]>();
  for (const request of requests) {
    const entries = grouped.get(request.query) ?? [];
    entries.push(request);
    grouped.set(request.query, entries);
  }
  return grouped;
}

function countByQuery(requests: SessionListTrace[]): Record<string, number> {
  return Object.fromEntries(
    [...groupByQuery(requests)].map(([query, entries]) => [query, entries.length]),
  );
}

function peakRequestsInWindow(requests: SessionListTrace[], windowMs: number): number {
  let peak = 0;
  let start = 0;
  for (const [end, request] of requests.entries()) {
    let windowStart = requests[start];
    while (windowStart && request.atMs - windowStart.atMs >= windowMs) {
      start += 1;
      windowStart = requests[start];
    }
    peak = Math.max(peak, end - start + 1);
  }
  return peak;
}

function queryRequestGaps(requests: SessionListTrace[]): number[] {
  return [...groupByQuery(requests).values()].flatMap((entries) =>
    entries.slice(1).flatMap((entry, index) => {
      const previous = entries[index];
      return previous ? [entry.atMs - previous.atMs] : [];
    }),
  );
}

async function waitForControlUiDocument(url: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = await fetch(url);
    await response.arrayBuffer();
    if (response.status === 200) {
      return;
    }
    await delay(250);
  }
  throw new Error(`Control UI did not become ready at ${new URL(url).origin}`);
}

suite.define(() => {
  it("bounds each normalized roster query during session lifecycle event bursts", async () => {
    if (!instance) {
      throw new Error("Gateway fixture is not running");
    }
    const owner = instance;
    const emitter = await connectGatewayClient({
      url: owner.url,
      token: owner.gatewayToken,
      role: "operator",
      scopes: ["operator.admin", "operator.read", "operator.write"],
    });
    const mainKeys = Array.from({ length: 12 }, (_, index) => `agent:main:storm-${index}`);
    const researchKeys = Array.from({ length: 12 }, (_, index) => `agent:research:storm-${index}`);
    try {
      for (const [agentId, keys] of [
        ["main", mainKeys],
        ["research", researchKeys],
      ] as const) {
        for (const [index, key] of keys.entries()) {
          await emitter.request("sessions.create", {
            agentId,
            key,
            label: `${agentId} storm ${index}`,
          });
        }
      }

      await waitForControlUiDocument(suite.server.baseUrl);
      const url = new URL("sessions", suite.server.baseUrl);
      url.hash = `token=${encodeURIComponent(owner.gatewayToken)}`;

      await suite.withPage(
        {
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { height: 900, width: 1_280 },
        },
        async ({ page }) => {
          const startedAt = performance.now();
          const requests: SessionListTrace[] = [];
          let browserSockets = 0;
          page.on("websocket", (socket) => {
            browserSockets += 1;
            socket.on("framesent", ({ payload }) => {
              try {
                const frame = JSON.parse(payload.toString()) as {
                  method?: unknown;
                  params?: unknown;
                  type?: unknown;
                };
                if (frame.type !== "req" || frame.method !== "sessions.list") {
                  return;
                }
                requests.push({
                  atMs: Math.round(performance.now() - startedAt),
                  params: frame.params,
                  query: stableJson(frame.params),
                });
              } catch {
                // Ignore non-JSON WebSocket traffic; the Gateway protocol frames are JSON.
              }
            });
          });

          const response = await page.goto(url.toString());
          expect(response?.status()).toBe(200);
          await waitForControlUiGatewayReady(page);
          await page.locator("openclaw-sessions-page").waitFor();
          await page.waitForTimeout(SETTLE_MS);
          requests.length = 0;

          const scenarios: ScenarioTrace[] = [];
          const runBurst = async (name: string, keys: readonly string[]) => {
            const firstRequest = requests.length;
            const burstStartedAt = performance.now();
            for (let index = 0; index < EVENT_COUNT; index += 1) {
              const key = keys[index % keys.length];
              await emitter.request("sessions.patch", {
                key,
                label: `${name}-${index}`,
              });
              const nextAt = burstStartedAt + (index + 1) * EVENT_INTERVAL_MS;
              await delay(Math.max(0, nextAt - performance.now()));
            }
            const burstEndedAtMs = Math.round(performance.now() - startedAt);
            await page.waitForTimeout(SETTLE_MS);
            if (name !== "unrelated-research-sessions") {
              await page
                .locator("openclaw-sessions-page")
                .getByText(`${name}-${EVENT_COUNT - 1}`, { exact: true })
                .waitFor();
            }
            scenarios.push({
              burstEndedAtMs,
              eventCount: EVENT_COUNT,
              eventIntervalMs: EVENT_INTERVAL_MS,
              name,
              requests: requests.slice(firstRequest),
            });
          };

          await runBurst("one-hot-main-session", mainKeys.slice(0, 1));
          await runBurst("many-main-sessions", mainKeys);
          await runBurst("unrelated-research-sessions", researchKeys);

          const artifact = {
            browserSockets,
            generatedAt: new Date().toISOString(),
            scenarios: scenarios.map((scenario) => ({
              ...scenario,
              peakRequestsInOneSecond: peakRequestsInWindow(scenario.requests, 1_000),
              requestCount: scenario.requests.length,
              requestsByQuery: countByQuery(scenario.requests),
            })),
          };
          await writeFile(
            path.join(suite.artifactDir, "sessions-list-request-timeline.json"),
            `${JSON.stringify(artifact, null, 2)}\n`,
          );

          await page.screenshot({ path: path.join(suite.artifactDir, "sessions-roster.png") });
          expect(browserSockets).toBe(1);
          for (const scenario of scenarios) {
            const counts = Object.values(countByQuery(scenario.requests));
            if (scenario.name === "unrelated-research-sessions") {
              expect(scenario.requests, scenario.name).toEqual([]);
              continue;
            }
            const trailingCounts = Object.values(
              countByQuery(
                scenario.requests.filter((request) => request.atMs >= scenario.burstEndedAtMs),
              ),
            );
            expect(
              trailingCounts.every((count) => count <= 1),
              scenario.name,
            ).toBe(true);
            expect(counts.length, scenario.name).toBeGreaterThan(0);
            expect(Math.max(...counts), scenario.name).toBeLessThanOrEqual(MAX_REQUESTS_PER_QUERY);
            expect(Math.min(...queryRequestGaps(scenario.requests)), scenario.name).toBeGreaterThan(
              MIN_REQUEST_GAP_MS,
            );
          }
        },
      );
    } finally {
      await disconnectGatewayClient(emitter);
    }
  });
});
