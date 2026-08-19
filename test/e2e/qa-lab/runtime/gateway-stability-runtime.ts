// QA evidence for live stability RPC, bounded retention, bundles, and support export.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import JSZip from "jszip";
import {
  emitDiagnosticEvent,
  resetDiagnosticEventsForTest,
} from "../../../../src/infra/diagnostic-events.js";
import { formatErrorMessage } from "../../../../src/infra/errors.js";
import {
  resetDiagnosticStabilityBundleForTest,
  writeDiagnosticStabilityBundleSync,
} from "../../../../src/logging/diagnostic-stability-bundle.js";
import {
  getDiagnosticStabilitySnapshot,
  resetDiagnosticStabilityRecorderForTest,
  startDiagnosticStabilityRecorder,
  stopDiagnosticStabilityRecorder,
} from "../../../../src/logging/diagnostic-stability.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../helpers/openclaw-test-instance.js";
import {
  type GatewayStabilityRuntimeOptions,
  parseGatewayStabilityRuntimeOptions,
} from "./gateway-stability-runtime-contract.js";
import { createQaScriptEvidenceWriter } from "./script-evidence.js";

const SOURCE_PATH = "test/e2e/qa-lab/runtime/gateway-stability-runtime.ts";
const SCENARIO_ID = "gateway-stability-runtime";
const SYNTHETIC_EVENT_COUNT = 1_205;
const PRIVATE_CHAT_ID = "qa-private-stability-chat";

type StabilitySnapshot = {
  capacity: number;
  count: number;
  dropped: number;
  events: Array<Record<string, unknown>>;
};

type StabilityBundleCliResult = {
  bundle: {
    reason: string;
    snapshot: StabilitySnapshot;
  };
};

type SupportExportCliResult = {
  path: string;
  bytes: number;
  manifest: {
    privacy: {
      payloadFree: boolean;
      rawLogsIncluded: boolean;
    };
  };
};

type GatewayStabilitySummary = {
  liveRpcCapacity: number;
  liveRpcCount: number;
  retainedCount: number;
  droppedCount: number;
  filteredEvents: number;
  bundleReason: string;
  supportArchive: string;
  supportBytes: number;
};

function parseCliJson<T>(
  label: string,
  result: Awaited<ReturnType<OpenClawTestInstance["cli"]>>,
  parse: (value: unknown) => T = (value) => value as T,
): T {
  if (result.code !== 0) {
    throw new Error(
      `${label} failed with exit ${String(result.code)}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  try {
    return parse(JSON.parse(result.stdout) as unknown);
  } catch (error) {
    throw new Error(
      `${label} returned invalid JSON: ${formatErrorMessage(error)}\n${result.stdout}`,
      { cause: error },
    );
  }
}

async function readZipEntries(file: string): Promise<Record<string, string>> {
  const zip = await JSZip.loadAsync(await fs.readFile(file));
  const entries: Record<string, string> = {};
  for (const [name, entry] of Object.entries(zip.files)) {
    if (!entry.dir) {
      entries[name] = await entry.async("string");
    }
  }
  return entries;
}

function createWriter(options: GatewayStabilityRuntimeOptions) {
  return createQaScriptEvidenceWriter({
    artifactBase: options.artifactBase,
    logFileName: "gateway-stability-runtime.log",
    primaryModel: "gateway/diagnostics-stability",
    providerMode: "mock-openai",
    repoRoot: options.repoRoot,
    target: {
      id: SCENARIO_ID,
      title: "Gateway stability runtime and bundle",
      sourcePath: SOURCE_PATH,
      docsRefs: ["docs/gateway/diagnostics.md", "docs/cli/gateway.md"],
      codeRefs: [
        SOURCE_PATH,
        "src/gateway/server-methods/diagnostics.ts",
        "src/logging/diagnostic-stability.ts",
        "src/logging/diagnostic-stability-bundle.ts",
        "src/cli/gateway-cli/register.ts",
      ],
    },
  });
}

function resetStabilityState(): void {
  stopDiagnosticStabilityRecorder();
  resetDiagnosticStabilityRecorderForTest();
  resetDiagnosticEventsForTest();
  resetDiagnosticStabilityBundleForTest();
}

function writeBoundedStabilityBundle(stateDir: string) {
  resetStabilityState();
  startDiagnosticStabilityRecorder();
  for (let index = 0; index < SYNTHETIC_EVENT_COUNT; index += 1) {
    emitDiagnosticEvent({
      type: "webhook.received",
      channel: "gateway",
      updateType: "qa-stability",
      chatId: `${PRIVATE_CHAT_ID}-${index}`,
    });
  }
  const snapshot = getDiagnosticStabilitySnapshot({ limit: 1000 });
  assert.equal(snapshot.capacity, 1000);
  assert.equal(snapshot.count, 1000);
  assert.equal(snapshot.events.length, 1000);
  assert.equal(snapshot.dropped, SYNTHETIC_EVENT_COUNT - snapshot.capacity);
  assert.equal(JSON.stringify(snapshot).includes(PRIVATE_CHAT_ID), false);

  const result = writeDiagnosticStabilityBundleSync({
    reason: "qa_gateway_stability",
    stateDir,
  });
  if (result.status !== "written") {
    throw new Error(`expected stability bundle write, got ${result.status}`);
  }
  stopDiagnosticStabilityRecorder();
  resetDiagnosticStabilityRecorderForTest();
  resetDiagnosticEventsForTest();
  return { path: result.path, snapshot };
}

export async function runGatewayStabilityRuntime(options: GatewayStabilityRuntimeOptions) {
  await fs.mkdir(options.artifactBase, { recursive: true });
  const writer = createWriter(options);
  const startedAt = Date.now();
  let instance: OpenClawTestInstance | undefined;
  try {
    instance = await createOpenClawTestInstance({
      name: "qa-gateway-stability",
      config: {
        diagnostics: { enabled: true },
      },
    });
    await instance.startGateway();

    const liveSnapshot = parseCliJson<StabilitySnapshot>(
      "gateway stability live RPC",
      await instance.cli(
        [
          "gateway",
          "stability",
          "--limit",
          "10",
          "--url",
          instance.url,
          "--token",
          instance.gatewayToken,
          "--timeout",
          "10000",
          "--json",
        ],
        { timeoutMs: 120_000 },
      ),
    );
    assert.equal(liveSnapshot.capacity, 1000);
    assert.ok(liveSnapshot.count <= liveSnapshot.capacity);
    assert.ok(liveSnapshot.events.length <= 10);

    const bounded = writeBoundedStabilityBundle(instance.stateDir);
    const persistedArtifact = path.join(options.artifactBase, "gateway-stability-bundle.json");
    await fs.copyFile(bounded.path, persistedArtifact);

    const bundleResult = parseCliJson<StabilityBundleCliResult>(
      "gateway stability persisted bundle",
      await instance.cli(
        [
          "gateway",
          "stability",
          "--bundle",
          "latest",
          "--limit",
          "3",
          "--type",
          "webhook.received",
          "--json",
        ],
        { timeoutMs: 120_000 },
      ),
    );
    assert.equal(bundleResult.bundle.reason, "qa_gateway_stability");
    assert.equal(bundleResult.bundle.snapshot.capacity, 1000);
    assert.equal(bundleResult.bundle.snapshot.count, 1000);
    assert.equal(bundleResult.bundle.snapshot.events.length, 3);
    assert.equal(JSON.stringify(bundleResult).includes(PRIVATE_CHAT_ID), false);

    const supportArchive = path.join(options.artifactBase, "gateway-stability-support.zip");
    const exportResult = parseCliJson<SupportExportCliResult>(
      "gateway stability export",
      await instance.cli(
        [
          "gateway",
          "stability",
          "--bundle",
          "latest",
          "--export",
          "--output",
          supportArchive,
          "--url",
          instance.url,
          "--token",
          instance.gatewayToken,
          "--timeout",
          "10000",
          "--json",
        ],
        { timeoutMs: 120_000 },
      ),
    );
    assert.equal(path.resolve(exportResult.path), path.resolve(supportArchive));
    assert.ok(exportResult.bytes > 0);
    assert.equal(exportResult.manifest.privacy.payloadFree, true);
    assert.equal(exportResult.manifest.privacy.rawLogsIncluded, false);

    const archiveEntries = await readZipEntries(supportArchive);
    assert.ok(archiveEntries["stability/latest.json"]);
    const archiveText = Object.values(archiveEntries).join("\n");
    assert.equal(archiveText.includes(PRIVATE_CHAT_ID), false);
    assert.equal(archiveText.includes(instance.gatewayToken), false);
    assert.equal(archiveText.includes(instance.stateDir), false);

    const summary: GatewayStabilitySummary = {
      liveRpcCapacity: liveSnapshot.capacity,
      liveRpcCount: liveSnapshot.count,
      retainedCount: bounded.snapshot.count,
      droppedCount: bounded.snapshot.dropped,
      filteredEvents: bundleResult.bundle.snapshot.events.length,
      bundleReason: bundleResult.bundle.reason,
      supportArchive: path.basename(supportArchive),
      supportBytes: exportResult.bytes,
    };
    const summaryPath = path.join(options.artifactBase, "gateway-stability-summary.json");
    await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    writer.appendLog(
      `gateway-stability: live=${liveSnapshot.count}/${liveSnapshot.capacity} retained=${bounded.snapshot.count} dropped=${bounded.snapshot.dropped}\n`,
    );
    return await writer.write({
      artifacts: [
        { kind: "summary", filePath: summaryPath },
        { kind: "summary", filePath: persistedArtifact },
        { kind: "archive", filePath: supportArchive },
      ],
      details: `live RPC capacity=${liveSnapshot.capacity}; retained=${bounded.snapshot.count}; dropped=${bounded.snapshot.dropped}; bundle export passed`,
      durationMs: Math.max(1, Date.now() - startedAt),
      status: "pass",
    });
  } catch (error) {
    const details = formatErrorMessage(error);
    writer.appendLog(`gateway-stability: ${details}\n`);
    return await writer.write({
      details,
      durationMs: Math.max(1, Date.now() - startedAt),
      status: "fail",
    });
  } finally {
    resetStabilityState();
    await instance?.cleanup();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runGatewayStabilityRuntime(parseGatewayStabilityRuntimeOptions(process.argv.slice(2)))
    .then((evidence) => {
      const status = evidence.entries[0]?.result.status;
      process.stdout.write(`gateway-stability-runtime: ${status}\n`);
      process.exitCode = status === "pass" ? 0 : 1;
    })
    .catch((error: unknown) => {
      process.stderr.write(`gateway-stability-runtime: ${formatErrorMessage(error)}\n`);
      process.exitCode = 1;
    });
}
