// Root-owned integration combines the real Gateway with public telemetry plugin surfaces.
import { once } from "node:events";
import { performance } from "node:perf_hooks";
import { beforeEach, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createLazyCoreHandlers } from "../src/gateway/server-methods/lazy-core-handlers.js";
import {
  connectOk,
  getGatewayTestPort,
  installGatewayTestHooks,
  onceMessage,
  resetTestPluginRegistry,
  rpcReq,
  setTestPluginRegistry,
  startTestGatewayServer,
  trackConnectChallengeNonce,
} from "../src/gateway/test-helpers.js";
import {
  emitTrustedDiagnosticEventWithPrivateData,
  onTrustedInternalDiagnosticEvent,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "../src/infra/diagnostic-events.js";
import type {
  OpenClawPluginService,
  OpenClawPluginServiceContext,
} from "../src/plugin-sdk/plugin-entry.js";
import { createTestPluginApi } from "../src/plugin-sdk/plugin-test-api.js";
import { createEmptyPluginRegistry } from "../src/plugins/registry-empty.js";
import { createDeferredCore } from "../src/shared/deferred.js";
import { withEnvAsync } from "../src/test-utils/env.js";
import { startLocalOtlpReceiver } from "./e2e/qa-lab/runtime/otel-test-support.js";

installGatewayTestHooks({ scope: "suite" });

beforeEach(() => {
  vi.clearAllMocks();
});

async function sendTraceRequest(ws: WebSocket, id: string, traceparent: string) {
  const response = onceMessage<{ type: "res"; id: string; ok: boolean }>(
    ws,
    (value) => value.type === "res" && value.id === id,
  );
  ws.send(JSON.stringify({ type: "req", id, method: "test.trace", params: {}, traceparent }));
  return await response;
}

it("exports first ACK before handler settlement through real authenticated WebSocket traffic", async () => {
  await withEnvAsync(
    {
      // Scope inherited SDK/proxy options, including credentials, TLS files, and exporter flags.
      // withEnvAsync restores the exact prior values after all owned resources close.
      ...Object.fromEntries(
        Object.keys(process.env)
          .filter(
            (key) =>
              key.startsWith("OTEL_") ||
              key.startsWith("OPENCLAW_PROXY_") ||
              /^(?:https?|all|no)_proxy$/i.test(key) ||
              key === "NODE_USE_ENV_PROXY",
          )
          .map((key) => [key, undefined]),
      ),
      OPENCLAW_OTEL_PRELOADED: "0",
      OTEL_SDK_DISABLED: "false",
      OTEL_NODE_RESOURCE_DETECTORS: "none",
    },
    async () => {
      const [{ createDiagnosticsOtelService }, { default: prometheusPlugin }] = await Promise.all([
        import("../extensions/diagnostics-otel/runtime-api.js"),
        import("../extensions/diagnostics-prometheus/index.js"),
      ]);
      const receiver = startLocalOtlpReceiver();
      const familyReached = createDeferredCore<number>();
      const releaseFamily = createDeferredCore();
      const releaseHandler = createDeferredCore();
      const otel = createDiagnosticsOtelService();
      let server: Awaited<ReturnType<typeof startTestGatewayServer>> | undefined;
      let ws: WebSocket | undefined;
      let unsubscribe: (() => void) | undefined;
      let serviceContext: OpenClawPluginServiceContext | undefined;
      let prometheus: OpenClawPluginService | undefined;
      const cleanupFailures: unknown[] = [];
      try {
        const receiverPort = await receiver.listen();
        const registry = createEmptyPluginRegistry();
        registry.gatewayHandlers = createLazyCoreHandlers({
          methods: ["test.trace"],
          loadHandlers: async () => {
            familyReached.resolve(performance.now());
            await releaseFamily.promise;
            return {
              "test.trace": async ({ req, respond }) => {
                respond(true, { accepted: true });
                if (req.id === "held-rpc-proof") {
                  await releaseHandler.promise;
                  respond(true, { complete: true });
                }
              },
            };
          },
        });
        const services: OpenClawPluginService[] = [];
        prometheusPlugin.register(
          createTestPluginApi({
            registerService: (service) => {
              services.push(service);
            },
            registerHttpRoute: (route) => {
              registry.httpRoutes.push({
                ...route,
                match: route.match ?? "exact",
                pluginId: "diagnostics-prometheus",
                source: "synthetic-rpc-proof",
              });
            },
          }),
        );
        prometheus = services[0];
        if (!prometheus) {
          throw new Error("Prometheus plugin did not register its service");
        }
        const stateDir = process.env.OPENCLAW_STATE_DIR;
        if (!stateDir) {
          throw new Error("Gateway test hooks did not create an isolated state directory");
        }
        const events: Extract<DiagnosticEventPayload, { type: "gateway.rpc" }>[] = [];
        unsubscribe = onTrustedInternalDiagnosticEvent(
          (event) => {
            if (event.type === "gateway.rpc") {
              events.push(event);
            }
          },
          { include: ["gateway.rpc"] },
        );
        const endpoint = `http://127.0.0.1:${receiverPort}`;
        serviceContext = {
          config: {
            diagnostics: {
              enabled: true,
              otel: {
                enabled: true,
                serviceName: "synthetic-rpc-exporter-proof",
                protocol: "http/protobuf",
                endpoint,
                tracesEndpoint: `${endpoint}/v1/traces`,
                metricsEndpoint: `${endpoint}/v1/metrics`,
                traces: true,
                metrics: true,
                logs: false,
                sampleRate: 1,
                flushIntervalMs: 1000,
              },
            },
          },
          stateDir,
          logger: { info() {}, warn() {}, error() {}, debug() {} },
          // Source-harness capability: package installation and official provenance are separate proof.
          internalDiagnostics: {
            emit: emitTrustedDiagnosticEventWithPrivateData,
            onEvent: onTrustedInternalDiagnosticEvent,
          },
        };
        const token = "synthetic-rpc-exporter-proof-token";
        const port = await getGatewayTestPort();
        const firstTraceId = "11111111111111111111111111111111";
        const firstTraceparent = `00-${firstTraceId}-1111111111111111-01`;
        const secondTraceId = "22222222222222222222222222222222";
        const rpcSpans = () =>
          receiver.capturedSpans.filter((span) => span.name.startsWith("openclaw.gateway.rpc."));
        const scrape = async () => {
          const response = await fetch(`http://127.0.0.1:${port}/api/diagnostics/prometheus`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(10_000),
          });
          expect(response.status).toBe(200);
          return await response.text();
        };
        const waitForDispatch = async (traceId: string) => {
          await vi.waitFor(
            () =>
              expect(
                events.some(
                  (event) => event.phase === "dispatch" && event.trace?.traceId === traceId,
                ),
              ).toBe(true),
            { timeout: 10_000 },
          );
          await waitForDiagnosticEventsDrained();
        };
        setTestPluginRegistry(registry);
        server = await startTestGatewayServer(port, {
          auth: { mode: "token", token },
          bind: "loopback",
          controlUiEnabled: false,
        });
        await prometheus.start(serviceContext);
        await otel.start(serviceContext);
        ws = new WebSocket(`ws://127.0.0.1:${port}`);
        trackConnectChallengeNonce(ws);
        await once(ws, "open", { signal: AbortSignal.timeout(10_000) });
        await connectOk(ws, { token, traceparent: firstTraceparent });
        const denied = await fetch(`http://127.0.0.1:${port}/api/diagnostics/prometheus`, {
          signal: AbortSignal.timeout(10_000),
        });
        expect(denied.status).toBe(401);
        await denied.arrayBuffer();

        const firstResponse = sendTraceRequest(ws, "held-rpc-proof", firstTraceparent);
        const familyStartedAt = await Promise.race([
          familyReached.promise,
          firstResponse.then(() => {
            throw new Error("response sent before handler family preparation");
          }),
        ]);
        await waitForDiagnosticEventsDrained();
        const preparing = await scrape();
        expect(preparing).toContain('openclaw_gateway_rpc_requests_total{method="other"} 1');
        expect(preparing).not.toContain(
          'openclaw_gateway_rpc_first_response_seconds_count{method="other"}',
        );
        expect(preparing).not.toContain(
          'openclaw_gateway_rpc_handler_seconds_count{method="other"}',
        );
        const familyHeldMs = performance.now() - familyStartedAt;
        releaseFamily.resolve();
        expect(await firstResponse).toMatchObject({ ok: true });
        await waitForDiagnosticEventsDrained();
        const acknowledged = await scrape();
        expect(acknowledged).toContain('openclaw_gateway_rpc_requests_total{method="other"} 1');
        expect(acknowledged).toContain(
          'openclaw_gateway_rpc_first_response_seconds_count{method="other"} 1',
        );
        expect(acknowledged).not.toContain(
          'openclaw_gateway_rpc_handler_seconds_count{method="other"}',
        );
        await vi.waitFor(
          () =>
            expect(
              rpcSpans()
                .filter((span) => span.traceId === firstTraceId)
                .map((span) => span.name),
            ).toEqual(["openclaw.gateway.rpc.response"]),
          { timeout: 10_000 },
        );

        expect(
          await sendTraceRequest(
            ws,
            "concurrent-rpc-proof",
            `00-${secondTraceId}-2222222222222222-01`,
          ),
        ).toMatchObject({ ok: true });
        await waitForDispatch(secondTraceId);
        expect(
          events.some(
            (event) => event.phase === "handler" && event.trace?.traceId === firstTraceId,
          ),
        ).toBe(false);
        releaseHandler.resolve();
        await waitForDispatch(firstTraceId);
        const settled = await scrape();
        for (const metric of ["first_response", "handler", "admission", "queue_wait"]) {
          expect(settled).toContain(
            `openclaw_gateway_rpc_${metric}_seconds_count{method="other"} 2`,
          );
        }
        const measured = events.filter((event) => event.method === "other");
        for (const [metric, phase] of [
          ["first_response", "response"],
          ["handler", "handler"],
        ] as const) {
          const totalMs = measured.reduce(
            (sum, event) => sum + (event.phase === phase ? event.durationMs : 0),
            0,
          );
          const sample = settled
            .split("\n")
            .find((line) =>
              line.startsWith(`openclaw_gateway_rpc_${metric}_seconds_sum{method="other"} `),
            );
          expect(Number(sample?.split(" ").at(-1))).toBeCloseTo(totalMs / 1000, 6);
        }
        for (const traceId of [firstTraceId, secondTraceId]) {
          const observations = events.filter((event) => event.trace?.traceId === traceId);
          const handler = observations.find((event) => event.phase === "handler");
          const response = observations.find((event) => event.phase === "response");
          if (handler?.phase !== "handler" || response?.phase !== "response") {
            throw new Error("missing real request timing observations");
          }
          if (traceId === firstTraceId) {
            expect(handler.admissionMs).toBeGreaterThanOrEqual(familyHeldMs);
          }
          expect(handler.admissionMs).toBeLessThanOrEqual(response.durationMs);
          expect(handler.admissionMs + handler.durationMs).toBeGreaterThanOrEqual(
            response.durationMs,
          );
        }

        // Arbitrary method names share one bucket; this exercises retention through real ingress.
        // The exporter unit test separately saturates the hard 2048-series cap and verifies drops.
        expect(await rpcReq(ws, "private-rpc-proof-0", {})).toMatchObject({ ok: false });
        await vi.waitFor(
          () =>
            expect(
              events.filter((event) => event.method === "unknown" && event.phase === "dispatch"),
            ).toHaveLength(1),
          { timeout: 10_000 },
        );
        await waitForDiagnosticEventsDrained();
        const unknownSeries = (body: string) =>
          body
            .split("\n")
            .filter(
              (line) =>
                line.startsWith("openclaw_gateway_rpc_") && line.includes('method="unknown"'),
            )
            .map((line) => line.slice(0, line.lastIndexOf(" ")))
            .toSorted();
        const initialUnknown = unknownSeries(await scrape());
        for (let index = 1; index <= 64; index++) {
          expect(await rpcReq(ws, `private-rpc-proof-${index}`, {})).toMatchObject({ ok: false });
        }
        await vi.waitFor(
          () =>
            expect(
              events.filter((event) => event.method === "unknown" && event.phase === "dispatch"),
            ).toHaveLength(65),
          { timeout: 10_000 },
        );
        await waitForDiagnosticEventsDrained();
        const flooded = await scrape();
        expect(flooded).toContain('openclaw_gateway_rpc_requests_total{method="unknown"} 65');
        expect(unknownSeries(flooded)).toEqual(initialUnknown);
        expect(flooded).not.toMatch(
          /private-rpc-proof|held-rpc-proof|concurrent-rpc-proof|11111111111111111111111111111111|22222222222222222222222222222222/,
        );
        await otel.stop?.(serviceContext);
        for (const [traceId, parentSpanId] of [
          [firstTraceId, "1111111111111111"],
          [secondTraceId, "2222222222222222"],
        ]) {
          const spans = rpcSpans().filter((span) => span.traceId === traceId);
          expect(spans.map((span) => span.name).toSorted()).toEqual([
            "openclaw.gateway.rpc.dispatch",
            "openclaw.gateway.rpc.handler",
            "openclaw.gateway.rpc.response",
          ]);
          expect(spans.every((span) => span.parentSpanId === parentSpanId)).toBe(true);
          for (const span of spans) {
            const phase = span.name.slice("openclaw.gateway.rpc.".length);
            const event = events.find(
              (observed) => observed.trace?.traceId === traceId && observed.phase === phase,
            );
            expect(span.endTimeMs).toBe(event?.ts);
          }
        }
        expect(receiver.capturedMetrics.map((metric) => metric.name)).toEqual(
          expect.arrayContaining([
            "openclaw.gateway.rpc.requests",
            "openclaw.gateway.rpc.first_response_ms",
            "openclaw.gateway.rpc.handler_ms",
            "openclaw.gateway.rpc.admission_ms",
            "openclaw.gateway.rpc.queue_wait_ms",
            "openclaw.gateway.rpc.outcomes",
          ]),
        );
        expect(JSON.stringify(rpcSpans().map((span) => span.attributes))).not.toMatch(
          /private-rpc-proof|held-rpc-proof|concurrent-rpc-proof/,
        );
      } finally {
        releaseFamily.resolve();
        releaseHandler.resolve();
        // Drain real requests before flushing exporters, and leave the receiver alive for that flush.
        // Attempt every owner cleanup even if an earlier close fails during a failed assertion.
        for (const cleanup of [
          () => ws?.terminate(),
          () => server?.close(),
          () => waitForDiagnosticEventsDrained(),
          () => unsubscribe?.(),
          () => serviceContext && otel.stop?.(serviceContext),
          () => serviceContext && prometheus?.stop?.(serviceContext),
          () => receiver.close(),
          () => resetTestPluginRegistry(),
        ]) {
          try {
            await cleanup();
          } catch (error) {
            cleanupFailures.push(error);
          }
        }
      }
      // An assertion failure propagates unchanged after every cleanup has been attempted.
      if (cleanupFailures.length > 0) {
        throw new AggregateError(cleanupFailures, "RPC exporter proof cleanup failed");
      }
    },
  );
}, 120_000);
