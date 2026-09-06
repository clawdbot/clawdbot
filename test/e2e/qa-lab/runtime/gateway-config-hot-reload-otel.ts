import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createQaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import { GatewayClientRequestError } from "../../../../src/gateway/client.js";
import { runQaGatewayFixture, stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import {
  connectHotReloadClient,
  waitForHotReloadFact,
  type HotReloadConnection,
} from "./gateway-config-hot-reload-fixtures.js";
import { startLocalOtlpReceiver } from "./otel-test-support.js";

type Receiver = ReturnType<typeof startLocalOtlpReceiver>;
const HEADER = "x-openclaw-qa-generation";
const FLUSH_MS = 1_000;

export async function proveHotReloadOtel({
  repoRoot,
  outputDir,
  appendLog,
}: {
  repoRoot: string;
  outputDir: string;
  appendLog: (text: string) => void;
}) {
  const owner = createQaGatewayChild();
  const receiverA = startLocalOtlpReceiver([], [HEADER]);
  const receiverB = startLocalOtlpReceiver([], [HEADER]);
  const evidence: Array<{ prefix: string; observation: string; pid: number; bootId: string }> = [];
  const failures: Array<{ prefix: string; message: string }> = [];
  const observations: Array<Record<string, unknown>> = [];
  let connection: HotReloadConnection | undefined;
  const counts = () => [receiverA.capturedRequests.length, receiverB.capturedRequests.length];
  const preserveToDir = path.join(outputDir, "otel-gateway");
  await runQaGatewayFixture(
    async () => {
      const endpointA = `http://127.0.0.1:${await receiverA.listen()}`;
      const endpointB = `http://127.0.0.1:${await receiverB.listen()}`;
      const gateway = await owner.start({
        repoRoot,
        useRepoCli: true,
        command: {
          executablePath: process.execPath,
          argsPrefix: [path.join(repoRoot, "dist/index.js")],
          cwd: repoRoot,
          usePackagedPlugins: true,
        },
        providerMode: "mock-openai",
        primaryModel: "mock-openai/gpt-5.6-luna",
        providerBaseUrl: "http://127.0.0.1:1/v1",
        transportBaseUrl: "http://127.0.0.1:1",
        enabledPluginIds: ["diagnostics-otel", "diagnostics-prometheus"],
        controlUiEnabled: false,
        runtimeEnvPatch: { OPENCLAW_OTEL_PRELOADED: "0", OTEL_SDK_DISABLED: "false" },
        mutateConfig: (config) => ({
          ...config,
          logging: { level: "debug", consoleLevel: "warn" },
          diagnostics: {
            enabled: false,
            otel: {
              enabled: true,
              endpoint: endpointA,
              serviceName: "qa-otel-a",
              headers: { [HEADER]: "generation-a" },
              protocol: "http/protobuf",
              traces: true,
              metrics: true,
              logs: true,
              sampleRate: 1,
              flushIntervalMs: FLUSH_MS,
              captureContent: false,
            },
          },
        }),
      });
      connection = await connectHotReloadClient(gateway);
      const primary = connection;
      const { pid } = gateway;
      const { bootId } = primary;
      assert(pid && bootId);
      const rpc = <T>(method: string, params: unknown = {}) =>
        primary.client.request<T>(method, params, { timeoutMs: 40_000 });
      const patch = async (change: unknown) => {
        const { hash } = await rpc<{ hash: string }>("config.get");
        const apply = () =>
          rpc<{ sentinel: { payload: { stats: { requiresRestart: boolean } } } }>("config.patch", {
            baseHash: hash,
            raw: JSON.stringify(change),
          });
        const result = await apply().catch(async (error: unknown) => {
          if (
            !(error instanceof GatewayClientRequestError) ||
            !error.retryable ||
            typeof error.retryAfterMs !== "number" ||
            !error.message.startsWith("rate limit exceeded for config.patch")
          ) {
            throw error;
          }
          await delay(error.retryAfterMs);
          return apply();
        });
        assert.equal(result.sentinel.payload.stats.requiresRestart, false);
      };
      const readPrometheus = async () => {
        const response = await fetch(`${gateway.baseUrl}/api/diagnostics/prometheus`, {
          headers: { authorization: `Bearer ${gateway.token}` },
          signal: AbortSignal.timeout(10_000),
        });
        assert.equal(response.status, 200);
        const text = await response.text();
        return Number(
          text.match(/^openclaw_gateway_rpc_requests_total\{method="health"\} (\d+)$/m)?.[1] ?? 0,
        );
      };
      const health = async (times = 1) => {
        for (let index = 0; index < times; index += 1) {
          await rpc("health");
        }
      };
      const quiet = async (before: number[]) => {
        // Observe two real configured export intervals; this is a bounded negative witness.
        await health(3);
        await delay(FLUSH_MS * 2 + 200);
        assert.deepEqual(counts(), before, "A retired exporter still sent data");
      };
      const signals = async (
        receiver: Receiver,
        generation: string,
        serviceName: string,
        prefix: string,
      ) => {
        await health();
        await waitForHotReloadFact(`OTLP ${generation} traces, metrics, and logs`, () =>
          receiver.capturedSpans.some(
            (span) =>
              span.name === "openclaw.gateway.rpc.response" && span.serviceName === serviceName,
          ) &&
          receiver.capturedMetrics.some(
            (metric) => metric.name === `${prefix}gateway.rpc.requests`,
          ) &&
          ["traces", "metrics", "logs"].every((signal) =>
            receiver.capturedRequests.some(
              (request) =>
                request.headerValues?.[HEADER] === generation && request.signal === signal,
            ),
          )
            ? true
            : undefined,
        );
        const requests = receiver.capturedRequests.filter(
          (request) => request.headerValues?.[HEADER] === generation,
        );
        assert.deepEqual(
          new Set(requests.map((request) => request.signal)),
          new Set(["traces", "metrics", "logs"]),
        );
        assert(receiver.capturedRequests.every((request) => request.status === 200));
        observations.push({ generation, serviceName, metricPrefix: prefix, requests });
      };
      const record = async (prefix: string, observation: string) => {
        assert.equal((await rpc<{ pid: number }>("system.info")).pid, pid);
        assert.equal(primary.hellos, 1);
        assert.equal(primary.closes, 0);
        const fresh = await connectHotReloadClient(gateway);
        try {
          assert.equal(fresh.bootId, bootId);
        } finally {
          await fresh.client.stopAndWait();
        }
        evidence.push({ prefix, observation, pid, bootId });
        appendLog(`PASS ${prefix}: ${observation}\n`);
      };

      try {
        await quiet([0, 0]);
        assert.equal(await readPrometheus(), 0);
        await patch({ diagnostics: { enabled: true } });
        await signals(receiverA, "generation-a", "qa-otel-a", "openclaw.");
        await health(8);
        const retainedCounter = await readPrometheus();
        assert(retainedCounter >= 9);
        await record(
          "diagnostics.enabled.start",
          "Initially disabled diagnostics enabled on the same Gateway; real RPC traces, metrics, logs and Prometheus events appeared",
        );

        await patch({
          diagnostics: {
            otel: {
              endpoint: endpointB,
              headers: { [HEADER]: "generation-b" },
              serviceName: "qa-otel-b",
              metricNamePrefix: "qa_reload_b.",
            },
          },
        });
        const retiredA = receiverA.capturedRequests.length;
        await signals(receiverB, "generation-b", "qa-otel-b", "qa_reload_b.");
        assert.equal(receiverA.capturedRequests.length, retiredA);
        assert(
          (await readPrometheus()) > retainedCounter,
          "OTel replacement reset the unrelated Prometheus service",
        );
        await record(
          "diagnostics.otel.endpoint/headers/serviceName/metricNamePrefix",
          "Export moved A→B with the new synthetic header, service resource and metric prefix; collector A stopped, Prometheus cumulative counters survived",
        );

        await patch({
          diagnostics: {
            otel: { traces: false, logs: false, metricNamePrefix: "qa_metrics_only." },
          },
        });
        const traceCount = receiverB.capturedSpans.length;
        const logCount = receiverB.capturedLogRecords.length;
        await health();
        await waitForHotReloadFact("metrics-only generation", () =>
          receiverB.capturedMetrics.some(
            (metric) => metric.name === "qa_metrics_only.gateway.rpc.requests",
          )
            ? true
            : undefined,
        );
        assert.equal(receiverB.capturedSpans.length, traceCount);
        assert.equal(receiverB.capturedLogRecords.length, logCount);
        await record(
          "diagnostics.otel.traces/logs",
          "Trace and log export stopped while a new metrics-only generation continued exporting RPC counters",
        );

        await patch({ diagnostics: { otel: { enabled: false } } });
        const activeCounter = await readPrometheus();
        await quiet(counts());
        assert((await readPrometheus()) > activeCounter);
        await patch({
          diagnostics: {
            otel: {
              enabled: true,
              traces: true,
              logs: true,
              endpoint: endpointA,
              headers: { [HEADER]: "generation-c" },
              serviceName: "qa-otel-c",
              metricNamePrefix: "qa_reload_c.",
            },
          },
        });
        await signals(receiverA, "generation-c", "qa-otel-c", "qa_reload_c.");
        await record(
          "diagnostics.otel.enabled",
          "Exporter disabled without stopping Prometheus, then re-enabled at collector A with fresh signal providers",
        );

        await patch({ diagnostics: { enabled: false } });
        const disabledCounter = await readPrometheus();
        await quiet(counts());
        assert.equal(await readPrometheus(), disabledCounter);
        await patch({ diagnostics: { enabled: true } });
        const resumedMetricCount = receiverA.capturedMetrics.length;
        await health();
        await waitForHotReloadFact("diagnostics resumed", () =>
          receiverA.capturedMetrics.length > resumedMetricCount ? true : undefined,
        );
        assert((await readPrometheus()) > disabledCounter);
        await record(
          "diagnostics.enabled.resume",
          "Shared diagnostics disabled and re-enabled; both exporter traffic and retained Prometheus counters obeyed the dispatcher switch without reconnecting",
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push({ prefix: "diagnostics", message });
        appendLog(`FAIL diagnostics: ${message}\n`);
      }
    },
    () => connection?.client.stopAndWait(),
    () => stopQaGatewayFixture(owner, { preserveToDir }),
    async () => {
      const stopped = counts();
      await delay(FLUSH_MS * 2 + 200);
      assert.deepEqual(counts(), stopped, "Gateway shutdown left an exporter active");
    },
    () => receiverA.close(),
    () => receiverB.close(),
    async () => {
      await fs.mkdir(outputDir, { recursive: true });
      await fs.writeFile(
        path.join(outputDir, "gateway-config-hot-reload-otel.json"),
        `${JSON.stringify({ evidence, failures, observations }, null, 2)}\n`,
      );
    },
  );
  return { evidence, failures };
}
