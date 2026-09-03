// Real Gateway config writes and observable HTTP/RPC behavior, with named local upstream fixtures.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import { loadOrCreateDeviceIdentity } from "../../../../src/infra/device-identity.js";
import { runQaGatewayFixture, stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { proveHotReloadBrowserSettings } from "./gateway-config-hot-reload-browser.js";
import {
  connectHotReloadClient,
  startHotReloadUpstreams,
  waitForHotReloadFact,
  type HotReloadConnection,
} from "./gateway-config-hot-reload-fixtures.js";
import { prepareGatewayPairingFixture } from "./gateway-config-hot-reload-pairing.js";
import { proveHotReloadRequests } from "./gateway-config-hot-reload-requests.js";
import { createQaScriptEvidenceWriter } from "./script-evidence.js";

const SCENARIO_ID = "gateway-config-hot-reload";
const SOURCE_PATH = "test/e2e/qa-lab/runtime/gateway-config-hot-reload-runtime.ts";
const MODEL = "mock-openai/gpt-5.6-luna";
const SESSION_KEY = "agent:qa:main";
type Evidence = { prefix: string; observation: string; bootId: string; samePid: boolean };
type ConfigResult = { hash: string; config: OpenClawConfig };

async function writeCatalogFixture(root: string): Promise<string> {
  const directory = path.join(root, "catalog-plugin");
  await fs.mkdir(directory);
  await fs.writeFile(
    path.join(directory, "package.json"),
    JSON.stringify({
      name: "qa-hot-reload-shell",
      version: "1.0.0",
      type: "module",
      openclaw: { extensions: ["./index.mjs"] },
    }),
  );
  await fs.writeFile(
    path.join(directory, "openclaw.plugin.json"),
    JSON.stringify({
      id: "qa-hot-reload-shell",
      name: "Hot reload synthetic CLI catalog",
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    }),
  );
  await fs.writeFile(
    path.join(directory, "index.mjs"),
    `export default {
    id: "qa-hot-reload-shell",
    name: "Hot reload synthetic CLI catalog",
    register(api) {
      api.registerSessionCatalog({
        id: "qa-hot-reload-shell", label: "Synthetic shell CLI", supportsProcessHomeIsolation: true,
        list: async () => [], read: async () => ({ items: [] }),
        startTerminalSession: async ({ cwd }) => ({ kind: "local", argv: ["/bin/sh"], cwd, title: "Synthetic CLI" }),
      });
    },
  };`,
  );
  return directory;
}

async function runProof(repoRoot: string, outputDir: string, appendLog: (text: string) => void) {
  const evidence: Evidence[] = [];
  const gatewayOwner = createQaGatewayChild();
  const mock = await startQaMockOpenAiServer();
  const fixture = await startHotReloadUpstreams(mock.baseUrl);
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-hot-reload-"));
  const connections: HotReloadConnection[] = [];
  let gateway: QaGatewayChild | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let pairingFixture: Awaited<ReturnType<typeof prepareGatewayPairingFixture>> | undefined;
  const asyncErrors: unknown[] = [];
  let summary: unknown;
  await runQaGatewayFixture(
    async () => {
      await fs.access(path.join(repoRoot, "dist/control-ui/index.html"));
      pairingFixture = await prepareGatewayPairingFixture(temporaryRoot);
      const catalogPath = await writeCatalogFixture(temporaryRoot);
      const preload = pathToFileURL(
        path.join(repoRoot, "test/e2e/qa-lab/runtime/gateway-config-hot-reload-upstream.mjs"),
      );
      preload.searchParams.set("fixture", fixture.baseUrl);
      gateway = await gatewayOwner.start({
        repoRoot,
        useRepoCli: true,
        command: {
          executablePath: process.execPath,
          argsPrefix: ["--import", preload.href, path.join(repoRoot, "dist/index.js")],
          argsSuffix: ["--bind", "lan"],
          cwd: repoRoot,
          usePackagedPlugins: true,
        },
        providerMode: "mock-openai",
        providerBaseUrl: `${fixture.baseUrl}/v1`,
        primaryModel: MODEL,
        alternateModel: "mock-openai/gpt-5.6-luna-alt",
        controlUiEnabled: true,
        enabledPluginIds: ["browser"],
        transportBaseUrl: fixture.baseUrl,
        runtimeEnvPatch: {
          ...pairingFixture.runtimeEnvPatch,
          OPENCLAW_NO_RESPAWN: "1",
          OPENCLAW_APNS_RELAY_ALLOW_HTTP: "true",
          OPENCLAW_APNS_RELAY_BASE_URL: undefined,
          OPENCLAW_APNS_RELAY_TIMEOUT_MS: undefined,
          GH_TOKEN: undefined,
          GITHUB_TOKEN: undefined,
          SHELL: "/bin/sh",
        },
        mutateConfig: (cfg) => ({
          ...cfg,
          agents: { ...cfg.agents, defaults: { ...cfg.agents?.defaults, utilityModel: MODEL } },
          browser: { ...cfg.browser, enabled: false },
          plugins: {
            ...cfg.plugins,
            allow: [...(cfg.plugins?.allow ?? []), "qa-hot-reload-shell"],
            load: {
              ...cfg.plugins?.load,
              paths: [...(cfg.plugins?.load?.paths ?? []), catalogPath],
            },
            entries: { ...cfg.plugins?.entries, "qa-hot-reload-shell": { enabled: true } },
          },
          gateway: {
            ...cfg.gateway,
            bind: "lan",
            reload: { mode: "hybrid" },
            terminal: { enabled: true, shell: "/bin/sh" },
            controlUi: {
              ...cfg.gateway?.controlUi,
              allowedOrigins: [`http://127.0.0.1:${cfg.gateway?.port}`],
            },
            nodes: {
              ...cfg.gateway?.nodes,
              commands: { allow: ["browser.proxy"] },
              pairing: { autoApproveLocal: true, sshVerify: false },
            },
          },
        }),
      });
      const activeGateway = gateway;
      const primary = await connectHotReloadClient(activeGateway);
      connections.push(primary);
      const pid = activeGateway.pid;
      const bootId = primary.bootId;
      assert(bootId && pid, "Gateway must expose its boot and process identities");
      const rpc = <T>(method: string, params: unknown = {}) =>
        primary.client.request<T>(method, params, { timeoutMs: 40_000 });
      const patch = async (change: unknown, replacePaths?: string[]) => {
        const snapshot = await rpc<ConfigResult>("config.get");
        const apply = () =>
          rpc<{
            sentinel: { payload: { stats: { requiresRestart: boolean } } };
          }>("config.patch", {
            baseHash: snapshot.hash,
            raw: JSON.stringify(change),
            replacePaths,
          });
        const result = await apply().catch(async (error: unknown) => {
          const response = error as {
            retryable?: boolean;
            retryAfterMs?: number;
            message?: string;
          };
          if (
            !response.retryable ||
            typeof response.retryAfterMs !== "number" ||
            !response.message?.startsWith("rate limit exceeded for config.patch")
          ) {
            throw error;
          }
          appendLog(`Honoring config.patch retry-after ${response.retryAfterMs}ms\n`);
          await delay(response.retryAfterMs);
          return apply();
        });
        assert.equal(
          result.sentinel.payload.stats.requiresRestart,
          false,
          "Hot setting requested a restart",
        );
        return result;
      };
      const verifyContinuity = async (prefix: string, observation: string) => {
        assert.equal(activeGateway.pid, pid);
        assert.equal(primary.hellos, 1, "Persistent WebSocket reconnected");
        assert.equal(primary.closes, 0, "Persistent WebSocket closed");
        await rpc("health");
        const fresh = await connectHotReloadClient(activeGateway);
        try {
          assert.equal(fresh.bootId, bootId, "Gateway restarted inside the same PID");
        } finally {
          await fresh.client.stopAndWait({ timeoutMs: 2_000 });
        }
        assert.equal(asyncErrors.length, 0, String(asyncErrors[0] ?? ""));
        evidence.push({ prefix, observation, bootId, samePid: true });
        appendLog(`PASS ${prefix}: ${observation}\n`);
        process.stdout.write(`PASS ${prefix}: ${observation}\n`);
      };
      const http = async (route: string, body?: unknown) => {
        const response = await fetch(`${activeGateway.baseUrl}${route}`, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            authorization: `Bearer ${activeGateway.token}`,
            "content-type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(40_000),
        });
        return { status: response.status, headers: response.headers, text: await response.text() };
      };
      const turn = async (message: string, sessionKey = SESSION_KEY) => {
        const started = await rpc<{ runId: string }>("chat.send", {
          sessionKey,
          message,
          deliver: false,
          idempotencyKey: randomUUID(),
        });
        const completed = await rpc<{ status: string }>("agent.wait", {
          runId: started.runId,
          timeoutMs: 30_000,
        });
        assert.equal(completed.status, "ok");
        return started.runId;
      };

      await proveHotReloadRequests({
        gateway: activeGateway,
        primary,
        fixture,
        rpc,
        patch,
        verifyContinuity,
        http,
      });

      // Node identities and relay grants are generated for this isolated fixture only.
      const nodeIdentity = loadOrCreateDeviceIdentity({
        path: path.join(temporaryRoot, "state/openclaw.sqlite"),
        identityKey: "browser-node",
      });
      const browserInvocations: string[] = [];
      const node = await connectHotReloadClient(activeGateway, {
        identity: nodeIdentity,
        onEvent: (event) => {
          if (event.event !== "node.invoke.request") {
            return;
          }
          const request = event.payload as { id: string; nodeId: string; command: string };
          browserInvocations.push(request.command);
          void node.client
            .request("node.invoke.result", {
              id: request.id,
              nodeId: request.nodeId,
              ok: true,
              payloadJSON: JSON.stringify({ result: { fixture: "node-browser" } }),
            })
            .catch((error: unknown) => asyncErrors.push(error));
        },
      });
      connections.push(node);
      const pendingSurface = await rpc<{ pending: Array<{ requestId: string; nodeId: string }> }>(
        "node.pair.list",
      );
      const surfaceRequest = pendingSurface.pending.find(
        (request) => request.nodeId === nodeIdentity.deviceId,
      );
      assert(surfaceRequest, "New browser node must have a visible surface approval request");
      await rpc("node.pair.approve", { requestId: surfaceRequest.requestId });
      await waitForHotReloadFact("approved browser node registration", async () => {
        const { nodes } = await rpc<{
          nodes: Array<{ nodeId: string; connected: boolean; commands?: string[] }>;
        }>("node.list");
        return nodes.find(
          (registered) =>
            registered.nodeId === nodeIdentity.deviceId &&
            registered.connected &&
            registered.commands?.includes("browser.proxy"),
        );
      });
      assert.equal(node.closes, 0, "Initial node surface approval closed its authenticated socket");
      for (const mode of ["auto", "off", "auto"] as const) {
        await patch({ gateway: { nodes: { browser: { mode } } } });
        const before = browserInvocations.length;
        const request = rpc<{ fixture: string }>("browser.request", {
          method: "GET",
          path: "/tabs",
        });
        if (mode === "off") {
          await assert.rejects(request, /browser control is disabled/);
          assert.equal(browserInvocations.length, before);
        } else {
          assert.equal((await request).fixture, "node-browser");
        }
      }
      await verifyContinuity(
        "gateway.nodes.browser",
        "Real node RPC routing switched to host-only and back; node stayed connected",
      );

      const gatewayIdentity = await rpc<{ deviceId: string }>("gateway.identity.get");
      for (const relay of ["relay-a", "relay-b"]) {
        const baseUrl = `${fixture.baseUrl}/${relay}`;
        await patch({ gateway: { push: { apns: { relay: { baseUrl, timeoutMs: 2_000 } } } } });
        await node.client.request("node.event", {
          event: "push.apns.register",
          payloadJSON: JSON.stringify({
            transport: "relay",
            relayHandle: randomUUID(),
            sendGrant: randomUUID(),
            installationId: randomUUID(),
            gatewayDeviceId: gatewayIdentity.deviceId,
            topic: "ai.openclaw.qa",
            environment: "sandbox",
            distribution: "official",
            relayOrigin: baseUrl,
          }),
        });
        const push = await rpc<{ ok: boolean }>("push.test", {
          nodeId: nodeIdentity.deviceId,
          title: "Hot reload proof",
          body: "Synthetic local relay",
        });
        assert.equal(push.ok, true);
        assert.equal(fixture.relayRequests.at(-1)?.route, `/${relay}/v1/push/send`);
        assert.equal(fixture.relayRequests.at(-1)?.signed, true);
      }
      fixture.setRelayDelay(1_500);
      await patch({ gateway: { push: { apns: { relay: { timeoutMs: 1_000 } } } } });
      await assert.rejects(rpc("push.test", { nodeId: nodeIdentity.deviceId }), /timeout|abort/i);
      await patch({ gateway: { push: { apns: { relay: { timeoutMs: 2_000 } } } } });
      assert.equal(
        (await rpc<{ ok: boolean }>("push.test", { nodeId: nodeIdentity.deviceId })).ok,
        true,
      );
      fixture.setRelayDelay(0);
      await verifyContinuity(
        "gateway.push.apns.relay",
        "Signed pushes reached two simulated relay origins; updated timeout aborted and then recovered",
      );

      await patch({
        gateway: {
          nodes: { pairing: { autoApproveLocal: false, autoApproveCidrs: [], sshVerify: false } },
        },
      });
      const pendingIdentity = loadOrCreateDeviceIdentity({
        path: path.join(temporaryRoot, "state/openclaw.sqlite"),
        identityKey: "pending-node",
      });
      await assert.rejects(
        connectHotReloadClient(activeGateway, { identity: pendingIdentity }),
        /pairing|NOT_PAIRED/i,
      );
      const pending = await rpc<{ pending: Array<{ deviceId: string }> }>("device.pair.list");
      assert(pending.pending.some((row) => row.deviceId === pendingIdentity.deviceId));
      assert.equal(node.closes, 0);
      await patch({ gateway: { nodes: { pairing: { autoApproveLocal: true } } } });
      const nextIdentity = loadOrCreateDeviceIdentity({
        path: path.join(temporaryRoot, "state/openclaw.sqlite"),
        identityKey: "next-node",
      });
      const nextNode = await connectHotReloadClient(activeGateway, { identity: nextIdentity });
      connections.push(nextNode);
      const pairingObservation = await pairingFixture.run({
        gateway: activeGateway,
        operator: primary.client,
        patchConfig: patch,
        existingNode: node,
      });
      await verifyContinuity(
        "gateway.nodes.pairing",
        `Local policy revoked/restored fresh node admission. ${pairingObservation}`,
      );

      browser = await chromium.launch({ headless: true });
      await proveHotReloadBrowserSettings({
        browser,
        gateway: activeGateway,
        outputDir,
        fixture,
        rpc,
        patch,
        turn,
        verifyContinuity,
        http,
      });

      await rpc("sessions.subscribe", {});
      await rpc("sessions.observer.visibility", { visible: true });
      for (const enabled of [false, true, false]) {
        await patch({ gateway: { controlUi: { sessionObserver: enabled } } });
        const sessionKey = `agent:qa:observer-${randomUUID()}`;
        const cursor = primary.events.length;
        const suffix = randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase();
        const runId = await turn(
          `Emit commentary SLACK-QA-COMMENTARY-${suffix}, run exactly \`grep 'SLACK-QA-TOOL-${suffix}' /dev/null || sleep 5\`, then finish with SLACK-QA-COMMENTARY-DONE-${suffix}.`,
          sessionKey,
        );
        const observed = () =>
          primary.events.slice(cursor).some((event) => {
            const digest = event.payload as { runId?: string; headline?: string } | undefined;
            return (
              event.event === "session.observer" &&
              digest?.runId === runId &&
              digest.headline?.includes(`SLACK-QA-COMMENTARY-${suffix}`)
            );
          });
        if (enabled) {
          await waitForHotReloadFact("session observer output", () =>
            observed() ? true : undefined,
          );
        } else {
          assert.equal(observed(), false);
        }
      }
      await verifyContinuity(
        "gateway.controlUi.sessionObserver",
        "The same connected subscriber received observer output only for runs admitted while enabled",
      );

      // The file watcher and full apply use the same owner, including section deletion.
      await patch({ gateway: { http: { endpoints: { responses: { enabled: true } } } } });
      assert.equal((await http("/v1/models")).status, 200);
      const authored = JSON.parse(
        await fs.readFile(activeGateway.configPath, "utf8"),
      ) as OpenClawConfig;
      authored.gateway!.http = undefined;
      await fs.writeFile(activeGateway.configPath, JSON.stringify(authored));
      await waitForHotReloadFact("watched HTTP deletion", async () =>
        (await http("/v1/models")).status === 404 ? true : undefined,
      );
      const snapshot = await rpc<ConfigResult>("config.get");
      authored.gateway!.http = { endpoints: { responses: { enabled: true } } };
      const applied = await rpc<{ sentinel: { payload: { stats: { requiresRestart: boolean } } } }>(
        "config.apply",
        { baseHash: snapshot.hash, raw: JSON.stringify(authored) },
      );
      assert.equal(applied.sentinel.payload.stats.requiresRestart, false);
      assert.equal((await http("/v1/responses")).status, 405);
      await verifyContinuity(
        "config file watcher and config.apply",
        "Deleting/recreating HTTP endpoint config took effect on the existing listener",
      );

      // Positive control: startup-owned terminal enablement must replace the boot.
      const beforeControl = await rpc<ConfigResult>("config.get");
      const control = await rpc<{ sentinel: { payload: { stats: { requiresRestart: boolean } } } }>(
        "config.patch",
        {
          baseHash: beforeControl.hash,
          raw: JSON.stringify({ gateway: { terminal: { enabled: false } } }),
        },
      );
      assert.equal(control.sentinel.payload.stats.requiresRestart, true);
      await waitForHotReloadFact("startup-only restart closes existing socket", () =>
        primary.closes > 0 ? true : undefined,
      );
      await waitForHotReloadFact("startup-only replacement boot", () =>
        primary.hellos > 1 && primary.bootId !== bootId ? true : undefined,
      );
      await assert.rejects(
        rpc("terminal.open", { agentId: "qa", cols: 80, rows: 24 }),
        /terminal is disabled/,
      );
      summary = {
        passed: true,
        evidence,
        startupOnlyControl: {
          prefix: "gateway.terminal.enabled",
          closedPersistentSocket: true,
          originalBootId: bootId,
          replacementBootId: primary.bootId,
        },
        simulatedUpstreams: [
          "OpenAI provider",
          "GitHub API transport",
          "favicon HTTPS transport",
          "APNs relay (no Apple delivery)",
          "CLI session catalog",
          "browser node",
          "SSH remote identity command with real isolated sshd",
        ],
      };
    },
    () => {
      if (gateway) {
        appendLog(gateway.logs());
      }
    },
    () => browser?.close(),
    async () => {
      await Promise.all(
        connections.map((connection) => connection.client.stopAndWait({ timeoutMs: 2_000 })),
      );
    },
    () => stopQaGatewayFixture(gatewayOwner),
    () => pairingFixture?.close(),
    () => fixture.close(),
    () => mock.stop(),
    () => fs.rm(temporaryRoot, { recursive: true, force: true }),
  );
  return { summary, evidence };
}

async function main() {
  const repoRoot = process.cwd();
  const argv = process.argv.slice(2);
  const outputFlag = argv.indexOf("--output-dir");
  assert(
    outputFlag === 0 && argv.length === 2 && argv[1],
    "Usage: --output-dir <artifact directory>",
  );
  const outputDir = path.resolve(repoRoot, argv[1]);
  await fs.mkdir(outputDir, { recursive: true });
  const writer = createQaScriptEvidenceWriter({
    artifactBase: outputDir,
    logFileName: `${SCENARIO_ID}.log`,
    primaryModel: MODEL,
    providerMode: "mock-openai",
    repoRoot,
    target: {
      id: SCENARIO_ID,
      title: "Gateway config hot reload",
      sourcePath: SOURCE_PATH,
      docsRefs: ["docs/gateway/configuration.md"],
      codeRefs: [SOURCE_PATH, "src/gateway/config-reload-plan.ts"],
    },
  });
  const started = Date.now();
  try {
    const { summary, evidence } = await runProof(repoRoot, outputDir, (text) =>
      writer.appendLog(text),
    );
    const summaryPath = path.join(outputDir, "gateway-config-hot-reload-summary.json");
    await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
    await writer.write({
      status: "pass",
      durationMs: Date.now() - started,
      details: `${evidence.length} settings checks retained the original Gateway boot and WebSocket; startup-only positive control restarted`,
      artifacts: [
        { kind: "summary", filePath: summaryPath },
        ...[
          "environment-teal",
          "environment-amber",
          "embed-strict",
          "embed-scripts",
          "embed-trusted",
        ].map((name) => ({ kind: "screenshot", filePath: path.join(outputDir, `${name}.png`) })),
      ],
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
