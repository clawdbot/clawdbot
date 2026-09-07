// The initial/hourly maintenance owner needs its own real-time QA budget.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createQaGatewayChild,
  startQaMockOpenAiServer,
  type QaGatewayChild,
} from "../../../../extensions/qa-lab/api.js";
import { runQaGatewayFixture, stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import {
  connectHotReloadClient,
  type HotReloadConnection,
} from "./gateway-config-hot-reload-fixtures.js";
import { startHotReloadAttachmentRetention } from "./gateway-config-hot-reload-retention.js";
import { createQaScriptEvidenceWriter } from "./script-evidence.js";

const SCENARIO_ID = "gateway-config-hot-reload-attachment-retention";
const SOURCE_PATH = "test/e2e/qa-lab/runtime/gateway-config-hot-reload-attachment-retention.ts";
const MODEL = "mock-openai/gpt-5.6-luna";

async function runProof(repoRoot: string, appendLog: (text: string) => void) {
  const owner = createQaGatewayChild();
  let mock: Awaited<ReturnType<typeof startQaMockOpenAiServer>> | undefined;
  let gateway: QaGatewayChild | undefined;
  let connection: HotReloadConnection | undefined;
  let retention: Awaited<ReturnType<typeof startHotReloadAttachmentRetention>> | undefined;
  const evidence: Array<Record<string, unknown>> = [];
  await runQaGatewayFixture(
    async () => {
      assert.equal(
        process.env.OPENCLAW_TESTBOX,
        "1",
        "Retention proof requires a disposable Testbox",
      );
      mock = await startQaMockOpenAiServer();
      gateway = await owner.start({
        repoRoot,
        useRepoCli: true,
        command: {
          executablePath: process.execPath,
          argsPrefix: [path.join(repoRoot, "dist/index.js")],
          cwd: repoRoot,
          usePackagedPlugins: true,
        },
        providerMode: "mock-openai",
        primaryModel: MODEL,
        providerBaseUrl: `${mock.baseUrl}/v1`,
        transportBaseUrl: mock.baseUrl,
        controlUiEnabled: false,
        mutateConfig: (cfg) => ({
          ...cfg,
          attachments: { ...cfg.attachments, ttlHours: 24 },
          gateway: { ...cfg.gateway, reload: { mode: "hybrid" } },
        }),
      });
      const activeGateway = gateway;
      const primary = (connection = await connectHotReloadClient(activeGateway));
      const pid = activeGateway.pid;
      const bootId = primary.bootId;
      assert(pid && bootId, "Gateway must expose its boot and process identities");
      const rpc = <T>(method: string, params: unknown = {}) =>
        primary.client.request<T>(method, params, { timeoutMs: 40_000 });
      const patch = async (change: unknown) => {
        const snapshot = await rpc<{ hash: string }>("config.get");
        const result = await rpc<{
          sentinel: { payload: { stats: { requiresRestart: boolean } } };
        }>("config.patch", { baseHash: snapshot.hash, raw: JSON.stringify(change) });
        assert.equal(result.sentinel.payload.stats.requiresRestart, false);
      };
      const started = Date.now();
      retention = await startHotReloadAttachmentRetention({
        gateway: activeGateway,
        patch,
        appendLog,
        verifyContinuity: async (prefix, observation) => {
          assert.equal(activeGateway.pid, pid);
          assert.equal((await rpc<{ pid: number }>("system.info")).pid, pid);
          assert.equal(primary.hellos, 1, "Persistent WebSocket reconnected");
          assert.equal(primary.closes, 0, "Persistent WebSocket closed");
          const fresh = await connectHotReloadClient(activeGateway);
          try {
            assert.equal(fresh.bootId, bootId, "Gateway restarted inside the same PID");
          } finally {
            await fresh.client.stopAndWait({ timeoutMs: 2_000 });
          }
          evidence.push({
            prefix,
            observation,
            elapsedMs: Date.now() - started,
            pid,
            bootId,
            socketHellos: primary.hellos,
            socketCloses: primary.closes,
          });
          appendLog(`PASS ${prefix}: ${observation}\n`);
        },
      });
      await retention.completion;
    },
    () => retention?.stop(),
    () => {
      if (gateway) {
        appendLog(gateway.logs());
      }
    },
    () => connection?.client.stopAndWait({ timeoutMs: 2_000 }),
    () => stopQaGatewayFixture(owner),
    () => mock?.stop(),
  );
  return evidence;
}

async function main() {
  const repoRoot = process.cwd();
  const argv = process.argv.slice(2);
  assert(
    argv.length === 2 && argv[0] === "--output-dir" && argv[1],
    "Usage: --output-dir <artifact directory>",
  );
  const outputDir = path.resolve(repoRoot, argv[1]);
  const writer = createQaScriptEvidenceWriter({
    artifactBase: outputDir,
    logFileName: `${SCENARIO_ID}.log`,
    primaryModel: MODEL,
    providerMode: "mock-openai",
    repoRoot,
    target: {
      id: SCENARIO_ID,
      title: "Gateway attachment retention hot reload",
      sourcePath: SOURCE_PATH,
      docsRefs: ["docs/gateway/configuration.md"],
      codeRefs: [SOURCE_PATH, "src/gateway/server-maintenance.ts"],
    },
  });
  const started = Date.now();
  try {
    const evidence = await runProof(repoRoot, (text) => writer.appendLog(text));
    await fs.mkdir(outputDir, { recursive: true });
    const summaryPath = path.join(outputDir, `${SCENARIO_ID}.json`);
    await fs.writeFile(summaryPath, `${JSON.stringify(evidence, null, 2)}\n`);
    await writer.write({
      status: "pass",
      durationMs: Date.now() - started,
      details:
        "TTL 24h→2h adopted by real initial/hourly maintenance: expired file removed and fresh file preserved on the original Gateway PID, boot and WebSocket",
      artifacts: [{ kind: "summary", filePath: summaryPath }],
    });
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    writer.appendLog(details);
    await writer.write({ status: "fail", durationMs: Date.now() - started, details });
    process.stderr.write(writer.logText());
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  });
}
