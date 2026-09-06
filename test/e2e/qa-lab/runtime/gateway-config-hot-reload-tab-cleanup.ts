// Real elapsed-time proof owns one Gateway and external Chromium across all three phases.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import {
  createQaGatewayChild,
  startQaMockOpenAiServer,
  type QaGatewayChild,
} from "../../../../extensions/qa-lab/api.js";
import { runQaGatewayFixture, stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { createHotReloadExternalBrowser } from "./gateway-config-hot-reload-external-browser.js";
import {
  connectHotReloadClient,
  startHotReloadUpstreams,
  type HotReloadConnection,
} from "./gateway-config-hot-reload-fixtures.js";
import { createQaScriptEvidenceWriter } from "./script-evidence.js";

const SCENARIO_ID = "gateway-config-hot-reload-tab-cleanup";
const SOURCE_PATH = "test/e2e/qa-lab/runtime/gateway-config-hot-reload-tab-cleanup.ts";
const MODEL = "mock-openai/gpt-5.6-luna";
const SESSION_KEY = "agent:qa:hot-reload-plugin";
// Production cadence and cap: two disabled witnesses plus an enabled sweep can take 940s.
const SWEEP_MS = 5 * 60_000;
const TAB_CAP = 8;
const CLEANUP_PROFILE = "cleanup-proof";
type BrowserTabs = { tabs: Array<{ targetId: string; url: string }> };
type BrowserStatus = { pid: number | null; running: boolean; attachOnly: boolean };
type ToolResult = {
  isError?: boolean;
  details: { targetId?: string; ok?: boolean };
};

async function runProof(repoRoot: string, appendLog: (text: string) => void) {
  const gatewayOwner = createQaGatewayChild();
  let mockOwner: Awaited<ReturnType<typeof startQaMockOpenAiServer>> | undefined;
  let fixtureOwner: Awaited<ReturnType<typeof startHotReloadUpstreams>> | undefined;
  let temporaryRoot: string | undefined;
  let externalOwner: ReturnType<typeof createHotReloadExternalBrowser> | undefined;
  const observations: Array<Record<string, unknown>> = [];
  let gateway: QaGatewayChild | undefined;
  let primary: HotReloadConnection | undefined;
  const log = (text: string) => {
    appendLog(`${text}\n`);
    process.stdout.write(`${text}\n`);
  };
  await runQaGatewayFixture(
    async () => {
      assert.equal(
        process.env.OPENCLAW_TESTBOX,
        "1",
        "Tab cleanup proof requires a disposable Testbox",
      );
      temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tab-cleanup-reload-"));
      const mock = (mockOwner = await startQaMockOpenAiServer());
      const fixture = (fixtureOwner = await startHotReloadUpstreams(mock.baseUrl));
      externalOwner = createHotReloadExternalBrowser(temporaryRoot);
      const external = await externalOwner.start();
      gateway = await gatewayOwner.start({
        repoRoot,
        useRepoCli: true,
        command: {
          executablePath: process.execPath,
          argsPrefix: [path.join(repoRoot, "dist/index.js")],
          cwd: repoRoot,
          usePackagedPlugins: true,
        },
        providerMode: "mock-openai",
        providerBaseUrl: `${mock.baseUrl}/v1`,
        transportBaseUrl: fixture.baseUrl,
        primaryModel: MODEL,
        enabledPluginIds: ["browser"],
        mutateConfig: (cfg) => ({
          ...cfg,
          agents: {
            ...cfg.agents,
            entries: {
              ...cfg.agents?.entries,
              qa: { ...cfg.agents?.entries?.qa, tools: { alsoAllow: ["browser"] } },
            },
          },
          browser: {
            enabled: true,
            headless: true,
            noSandbox: true,
            executablePath: chromium.executablePath(),
            ssrfPolicy: { allowedHostnames: [new URL(fixture.baseUrl).hostname] },
            tabCleanup: { enabled: false },
            // Managed opens have a separate eight-page cap. Attach-only isolates periodic cleanup.
            profiles: { [CLEANUP_PROFILE]: { cdpUrl: external.cdpUrl, attachOnly: true } },
          },
          gateway: { ...cfg.gateway, reload: { mode: "hybrid" } },
        }),
      });
      const activeGateway = gateway;
      const connection = await connectHotReloadClient(activeGateway);
      primary = connection;
      const pid = activeGateway.pid;
      const bootId = connection.bootId;
      assert(pid && bootId, "Gateway must expose its boot and process identities");
      const rpc = <T>(method: string, params: unknown = {}) =>
        connection.client.request<T>(method, params, { timeoutMs: 40_000 });
      const patch = async (enabled: boolean) => {
        const snapshot = await rpc<{ hash: string }>("config.get");
        const result = await rpc<
          { noop: true } | { sentinel: { payload: { stats: { requiresRestart: boolean } } } }
        >("config.patch", {
          baseHash: snapshot.hash,
          raw: JSON.stringify({ browser: { tabCleanup: { enabled } } }),
        });
        if ("noop" in result) {
          assert.equal(result.noop, true);
        } else {
          assert.equal(result.sentinel.payload.stats.requiresRestart, false);
        }
      };
      const browser = async (args: Record<string, unknown>) => {
        const response = await fetch(`${activeGateway.baseUrl}/tools/invoke`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${activeGateway.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            tool: "browser",
            sessionKey: SESSION_KEY,
            args: { target: "host", profile: CLEANUP_PROFILE, ...args },
          }),
          signal: AbortSignal.timeout(40_000),
        });
        const text = await response.text();
        assert.equal(response.status, 200, text);
        const { result } = JSON.parse(text) as { result: ToolResult };
        assert.notEqual(result.isError, true, text);
        assert.notEqual(result.details.ok, false, text);
        return result;
      };
      const browserRequest = <T>(route: string) =>
        rpc<T>("browser.request", {
          target: "host",
          method: "GET",
          path: route,
          query: { profile: CLEANUP_PROFILE },
          timeoutMs: 30_000,
        });
      const opened: string[] = [];
      const ownedTabs = async () => {
        const { tabs } = await browserRequest<BrowserTabs>("/tabs");
        return tabs
          .filter((tab) => opened.includes(tab.targetId))
          .map((tab) => tab.targetId)
          .toSorted();
      };
      const openTab = async () => {
        const result = await browser({
          action: "open",
          url: `${fixture.baseUrl}/widget?cleanup-proof=${opened.length}`,
        });
        assert(result.details.targetId);
        opened.push(result.details.targetId);
      };
      for (let index = 0; index <= TAB_CAP; index += 1) {
        await openTab();
      }
      const status = await browserRequest<BrowserStatus>("/");
      assert(status.running && status.attachOnly);
      assert.equal(status.pid, null, "Gateway must not own the external Chromium process");
      const expectedRetained = opened.slice(1).toSorted();
      for (const [phase, enabled] of [false, true, false].entries()) {
        await patch(enabled);
        if (phase === 2) {
          await openTab();
        }
        const expected =
          phase === 1 ? expectedRetained : opened.slice(phase === 2 ? 1 : 0).toSorted();
        const started = Date.now();
        let nextLog = started;
        let retained: string[] = [];
        log(
          `Browser tab cleanup phase ${phase + 1}: enabled=${enabled}, observing real five-minute sweep`,
        );
        while (Date.now() - started < SWEEP_MS + 30_000) {
          retained = await ownedTabs();
          await external.verifyAlive();
          if (enabled && retained.length === TAB_CAP) {
            break;
          }
          if (!enabled) {
            assert.deepEqual(retained, expected, "Disabled cleanup removed a tracked tab");
            if (Date.now() - started >= SWEEP_MS + 5_000) {
              break;
            }
          }
          if (Date.now() >= nextLog) {
            log(
              `Browser tab cleanup phase ${phase + 1}: ${retained.length} tracked tabs after ${Math.floor((Date.now() - started) / 1_000)}s`,
            );
            nextLog = Date.now() + 30_000;
          }
          await delay(5_000);
        }
        assert.deepEqual(retained, expected);
        assert.equal(activeGateway.pid, pid);
        assert.equal(connection.hellos, 1, "Persistent WebSocket reconnected");
        assert.equal(connection.closes, 0, "Persistent WebSocket closed");
        await rpc("health");
        const fresh = await connectHotReloadClient(activeGateway);
        try {
          assert.equal(fresh.bootId, bootId, "Gateway restarted inside the same PID");
        } finally {
          await fresh.client.stopAndWait({ timeoutMs: 2_000 });
        }
        observations.push({
          enabled,
          elapsedMs: Date.now() - started,
          trackedTabs: retained.length,
          browserPid: external.pid,
          gatewayPid: pid,
          bootId,
          socketHellos: connection.hellos,
          socketCloses: connection.closes,
        });
        log(
          `PASS browser.tabCleanup phase ${phase + 1}: enabled=${enabled}, ${retained.length} tracked tabs; Gateway boot/socket, external Chromium PID, CDP connection and unowned witness page unchanged`,
        );
      }
    },
    () => {
      if (gateway) {
        appendLog(gateway.logs());
      }
    },
    () => primary?.client.stopAndWait({ timeoutMs: 2_000 }),
    () => stopQaGatewayFixture(gatewayOwner),
    () => externalOwner?.close(),
    () => fixtureOwner?.close(),
    () => mockOwner?.stop(),
    () => temporaryRoot && fs.rm(temporaryRoot, { recursive: true, force: true }),
  );
  return observations;
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
      title: "Gateway tab cleanup hot reload",
      sourcePath: SOURCE_PATH,
      docsRefs: ["docs/gateway/configuration.md", "docs/tools/browser.md"],
      codeRefs: [SOURCE_PATH, "extensions/browser/src/browser/session-tab-cleanup.ts"],
    },
  });
  const started = Date.now();
  try {
    const observations = await runProof(repoRoot, (text) => writer.appendLog(text));
    await fs.mkdir(outputDir, { recursive: true });
    const summaryPath = path.join(outputDir, `${SCENARIO_ID}.json`);
    await fs.writeFile(summaryPath, `${JSON.stringify(observations, null, 2)}\n`);
    await writer.write({
      status: "pass",
      durationMs: Date.now() - started,
      details:
        "Disabled→enabled→disabled cleanup retained 9→8→9 tracked tabs on the real five-minute cadence with one Gateway boot/socket and one external Chromium owner",
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
