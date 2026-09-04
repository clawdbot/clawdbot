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
import { closeOpenClawStateDatabaseByPath } from "../../../../src/state/openclaw-state-db.js";
import { runQaGatewayFixture, stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { proveHotReloadBrowserSettings } from "./gateway-config-hot-reload-browser.js";
import { proveHotReloadChannels } from "./gateway-config-hot-reload-channels.js";
import {
  connectHotReloadClient,
  startHotReloadUpstreams,
  waitForHotReloadFact,
  type HotReloadConnection,
} from "./gateway-config-hot-reload-fixtures.js";
import { proveHotReloadBrowserLaunch } from "./gateway-config-hot-reload-launch.js";
import { proveHotReloadNodePolicies } from "./gateway-config-hot-reload-nodes.js";
import { prepareGatewayPairingFixture } from "./gateway-config-hot-reload-pairing.js";
import { proveHotReloadPluginPolicy } from "./gateway-config-hot-reload-plugin-policy.js";
import { proveHotReloadPolicyAdmission } from "./gateway-config-hot-reload-policy-admission.js";
import { proveHotReloadPolicy } from "./gateway-config-hot-reload-policy.js";
import { proveHotReloadRequests } from "./gateway-config-hot-reload-requests.js";
import { startHotReloadAttachmentRetention } from "./gateway-config-hot-reload-retention.js";
import { proveHotReloadSecurity } from "./gateway-config-hot-reload-security.js";
import { proveHotReloadServicePolicy } from "./gateway-config-hot-reload-service-policy.js";
import { proveHotReloadTerminalDeferredRestart } from "./gateway-config-hot-reload-terminal-deferred.js";
import {
  proveHotReloadTerminalLifecycle,
  proveHotReloadTerminalStartup,
  writeHotReloadTerminalCatalog,
} from "./gateway-config-hot-reload-terminal.js";
import { proveHotReloadWatchPolicy } from "./gateway-config-hot-reload-watch.js";
import { createQaScriptEvidenceWriter } from "./script-evidence.js";

const SCENARIO_ID = "gateway-config-hot-reload";
const SOURCE_PATH = "test/e2e/qa-lab/runtime/gateway-config-hot-reload-runtime.ts";
const MODEL = "mock-openai/gpt-5.6-luna";
const SESSION_KEY = "agent:qa:main";
type Evidence = { prefix: string; observation: string; bootId: string; samePid: boolean };
type ConfigResult = { hash: string; config: OpenClawConfig };
class GatewayContinuityError extends Error {}

async function runProof(repoRoot: string, outputDir: string, appendLog: (text: string) => void) {
  const evidence: Evidence[] = [];
  const failures: Array<{ prefix: string; message: string }> = [];
  const metadataProbes: Array<{ phase: string; modelCount: number; commandCount: number }> = [];
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
  let passedChecks = 0;
  let channels: Awaited<ReturnType<typeof proveHotReloadChannels>> | undefined;
  let security: Awaited<ReturnType<typeof proveHotReloadSecurity>> | undefined;
  let retention: Awaited<ReturnType<typeof startHotReloadAttachmentRetention>> | undefined;
  const pluginPolicyAbort = new AbortController();
  let pluginPolicy: Promise<void> | undefined;
  await runQaGatewayFixture(
    async () => {
      await fs.access(path.join(repoRoot, "dist/control-ui/index.html"));
      pairingFixture = await prepareGatewayPairingFixture(temporaryRoot);
      const catalogPath = await writeHotReloadTerminalCatalog(temporaryRoot);
      const browserExecutable = await fs.realpath(chromium.executablePath());
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
        enabledPluginIds: ["browser", "canvas", "diffs", "openai"],
        transportBaseUrl: fixture.baseUrl,
        runtimeEnvPatch: {
          ...pairingFixture.runtimeEnvPatch,
          OPENCLAW_NO_RESPAWN: "1",
          OPENCLAW_SKIP_CANVAS_HOST: undefined,
          OPENCLAW_APNS_RELAY_ALLOW_HTTP: "true",
          OPENCLAW_APNS_RELAY_BASE_URL: undefined,
          OPENCLAW_APNS_RELAY_TIMEOUT_MS: undefined,
          GH_TOKEN: undefined,
          GITHUB_TOKEN: undefined,
          SHELL: "/bin/sh",
          DISPLAY: process.env.DISPLAY,
        },
        mutateConfig: (cfg) => ({
          ...cfg,
          attachments: { ...cfg.attachments, ttlHours: 24 },
          agents: {
            ...cfg.agents,
            defaults: { ...cfg.agents?.defaults, utilityModel: MODEL },
            entries: {
              ...cfg.agents?.entries,
              qa: {
                ...cfg.agents?.entries?.qa,
                tools: {
                  ...cfg.agents?.entries?.qa?.tools,
                  alsoAllow: ["agents_list", "browser", "diffs"],
                },
              },
            },
          },
          browser: {
            ...cfg.browser,
            enabled: true,
            headless: true,
            noSandbox: true,
            executablePath: browserExecutable,
            defaultProfile: "openclaw",
            ssrfPolicy: { allowedHostnames: [new URL(fixture.baseUrl).hostname] },
            tabCleanup: { enabled: false },
          },
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
            terminal: { enabled: false, shell: "/bin/sh" },
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
      assert.equal(
        activeGateway.runtimeEnv.OPENCLAW_SKIP_CANVAS_HOST,
        undefined,
        "Canvas hot reload proof requires the Canvas host",
      );
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
          rpc<{ noop: true } | { sentinel: { payload: { stats: { requiresRestart: unknown } } } }>(
            "config.patch",
            {
              baseHash: snapshot.hash,
              raw: JSON.stringify(change),
              replacePaths,
            },
          );
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
        if ("noop" in result) {
          assert.equal(result.noop, true);
        } else if (result.sentinel.payload.stats.requiresRestart !== false) {
          throw new GatewayContinuityError("Hot setting requested a restart");
        }
        return result;
      };
      const checkContinuity = async () => {
        try {
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
        } catch (error) {
          throw new GatewayContinuityError("Gateway continuity lost", { cause: error });
        }
      };
      const proveGroup = async (prefix: string, run: () => Promise<void>) => {
        await checkContinuity();
        try {
          await run();
        } catch (error) {
          if (error instanceof GatewayContinuityError) {
            throw error;
          }
          // Independent settings still get exercised, but any boot/socket loss ends the proof.
          await checkContinuity();
          const message = error instanceof Error ? error.message : String(error);
          failures.push({ prefix, message });
          appendLog(`FAIL ${prefix}: ${message}\n`);
          process.stdout.write(`FAIL ${prefix}: ${message}\n`);
        }
      };
      const verifyContinuity = async (prefix: string, observation: string) => {
        await checkContinuity();
        assert.ifError(asyncErrors[0]);
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
      const probeMetadata = async (phase: string) => {
        const metadata = await rpc<{
          models?: unknown[];
          commands?: unknown[];
          swarmEnabled: boolean;
        }>("chat.metadata", { agentId: "qa" });
        const models = metadata.models;
        assert(models?.length, `${phase}: model picker must be available`);
        assert.equal(typeof metadata.swarmEnabled, "boolean");
        const observation = {
          phase,
          modelCount: models.length,
          commandCount: metadata.commands?.length ?? 0,
        };
        metadataProbes.push(observation);
        appendLog(`PASS chat.metadata ${JSON.stringify(observation)}\n`);
      };

      const terminalProof = {
        gateway: activeGateway,
        primary,
        rpc,
        patch,
        http,
        verifyContinuity,
        proveGroup,
      };
      retention = await startHotReloadAttachmentRetention({
        gateway: activeGateway,
        patch,
        verifyContinuity,
        appendLog,
      });
      void retention.completion.catch(() => {});
      await proveHotReloadTerminalStartup(terminalProof);

      await proveHotReloadRequests({
        gateway: activeGateway,
        primary,
        fixture,
        rpc,
        patch,
        verifyContinuity,
        http,
        probeMetadata,
        proveGroup,
      });

      browser = await chromium.launch({ headless: true });
      await proveHotReloadTerminalLifecycle({ ...terminalProof, browser, outputDir });

      // Node identities and relay grants are generated for this isolated fixture only.
      const nodeIdentity = loadOrCreateDeviceIdentity({
        path: path.join(temporaryRoot, "state/openclaw.sqlite"),
        identityKey: "browser-node",
      });
      let node: HotReloadConnection | undefined;
      await proveGroup("gateway.nodes.browser", async () => {
        await patch({
          gateway: { nodes: { pairing: { autoApproveLocal: true, sshVerify: false } } },
        });
        const browserInvocations: string[] = [];
        const browserNode = await connectHotReloadClient(activeGateway, {
          identity: nodeIdentity,
          onEvent: (event) => {
            if (event.event !== "node.invoke.request") {
              return;
            }
            const request = event.payload as { id: string; nodeId: string; command: string };
            browserInvocations.push(request.command);
            void browserNode.client
              .request("node.invoke.result", {
                id: request.id,
                nodeId: request.nodeId,
                ok: true,
                payloadJSON: JSON.stringify({ result: { fixture: "node-browser" } }),
              })
              .catch((error: unknown) => asyncErrors.push(error));
          },
        });
        node = browserNode;
        connections.push(browserNode);
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
        assert.equal(
          browserNode.closes,
          0,
          "Initial node surface approval closed its authenticated socket",
        );
        for (const mode of ["auto", "off", "auto"] as const) {
          await patch({ gateway: { nodes: { browser: { mode } } } });
          const before = browserInvocations.length;
          const request = rpc<{ fixture?: string; tabs?: unknown[] }>("browser.request", {
            method: "GET",
            path: "/tabs",
          });
          if (mode === "off") {
            const result = await request;
            assert(Array.isArray(result.tabs));
            assert.equal(result.fixture, undefined);
            assert.equal(browserInvocations.length, before);
          } else {
            assert.equal((await request).fixture, "node-browser");
          }
        }
        await verifyContinuity(
          "gateway.nodes.browser",
          "Real node RPC routing switched to host-only and back; node stayed connected",
        );
      });

      await proveGroup("gateway.push.apns.relay", async () => {
        assert(node, "Browser node fixture did not connect");
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
      });

      await proveGroup("gateway.nodes.pairing", async () => {
        assert(node, "Browser node fixture did not connect");
        assert(pairingFixture, "SSH fixture was not prepared");
        await patch(
          {
            gateway: {
              nodes: {
                pairing: { autoApproveLocal: false, autoApproveCidrs: [], sshVerify: false },
              },
            },
          },
          ["gateway.nodes.pairing.autoApproveCidrs", "gateway.nodes.pairing.sshVerify.cidrs"],
        );
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
      });

      await proveHotReloadNodePolicies({
        gateway: activeGateway,
        temporaryRoot,
        rpc,
        patch,
        verifyContinuity,
        proveGroup,
      });

      await proveHotReloadWatchPolicy({
        gateway: activeGateway,
        temporaryRoot,
        rpc,
        patch,
        verifyContinuity,
        proveGroup,
      });

      await proveGroup("Control UI browser fixture", async () => {
        await patch(
          {
            gateway: {
              nodes: {
                pairing: { autoApproveLocal: true, autoApproveCidrs: [], sshVerify: false },
              },
            },
          },
          ["gateway.nodes.pairing.autoApproveCidrs", "gateway.nodes.pairing.sshVerify.cidrs"],
        );
        assert(browser, "Control UI browser must be running");
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
          proveGroup,
        });
      });

      await proveHotReloadBrowserLaunch({
        gateway: activeGateway,
        temporaryRoot,
        rpc,
        patch,
        verifyContinuity,
        proveGroup,
      });

      await proveGroup("gateway.controlUi.sessionObserver", async () => {
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
      });

      await proveGroup("config file watcher and config.apply", async () => {
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
        const applied = await rpc<{
          sentinel: { payload: { stats: { requiresRestart: boolean } } };
        }>("config.apply", { baseHash: snapshot.hash, raw: JSON.stringify(authored) });
        assert.equal(applied.sentinel.payload.stats.requiresRestart, false);
        assert.equal((await http("/v1/responses")).status, 405);
        await verifyContinuity(
          "config file watcher and config.apply",
          "Deleting/recreating HTTP endpoint config took effect on the existing listener",
        );
      });

      await checkContinuity();
      await proveHotReloadPolicy({
        gateway: activeGateway,
        temporaryRoot,
        outputDir,
        rpc,
        patch,
        http,
        proveGroup,
        verifyContinuity,
      });
      await proveHotReloadPolicyAdmission({
        gateway: activeGateway,
        temporaryRoot,
        outputDir,
        turn,
        rpc,
        patch,
        proveGroup,
        verifyContinuity,
      });
      pluginPolicy = proveHotReloadPluginPolicy({
        gateway: activeGateway,
        unaffectedNode: node,
        temporaryRoot,
        outputDir,
        fixtureBaseUrl: fixture.baseUrl,
        rpc,
        patch,
        http,
        proveGroup,
        verifyContinuity,
        appendLog,
        signal: pluginPolicyAbort.signal,
      });
      // Join this owner below; real cleanup intervals overlap independent Gateway fixtures.
      void pluginPolicy.catch(() => {});
      channels = await proveHotReloadChannels({ repoRoot, outputDir, appendLog });
      failures.push(...channels.failures);
      security = await proveHotReloadSecurity({ repoRoot, outputDir, appendLog });
      failures.push(...security.failures);
      const terminalDeferred = await proveHotReloadTerminalDeferredRestart({
        repoRoot,
        outputDir,
        appendLog,
      });
      failures.push(...terminalDeferred.failures);
      const servicePolicy = await proveHotReloadServicePolicy({ repoRoot, outputDir, appendLog });
      failures.push(...servicePolicy.failures);
      await pluginPolicy;
      await proveGroup("attachments.ttlHours", () => retention!.completion);
      await checkContinuity();
      passedChecks =
        evidence.length +
        channels.evidence.length +
        security.evidence.length +
        terminalDeferred.evidence.length +
        servicePolicy.evidence.length;
      // Positive control: startup-owned Control UI routing must replace the boot.
      const beforeControl = await rpc<ConfigResult>("config.get");
      const control = await rpc<{ sentinel: { payload: { stats: { requiresRestart: boolean } } } }>(
        "config.patch",
        {
          baseHash: beforeControl.hash,
          raw: JSON.stringify({ gateway: { controlUi: { enabled: false } } }),
        },
      );
      assert.equal(control.sentinel.payload.stats.requiresRestart, true);
      await waitForHotReloadFact("startup-only restart closes existing socket", () =>
        primary.closes > 0 ? true : undefined,
      );
      await waitForHotReloadFact("startup-only replacement boot", () =>
        primary.hellos > 1 && primary.bootId !== bootId ? true : undefined,
      );
      assert.equal((await http("/chat/qa")).status, 404);
      summary = {
        passed: failures.length === 0,
        failures,
        evidence,
        metadataProbes,
        channels,
        security,
        terminalDeferred,
        servicePolicy,
        counts: {
          passed: passedChecks,
          failed: failures.length,
          primary: evidence.length,
          channels: channels.evidence.length,
          security: security.evidence.length,
          terminalDeferred: terminalDeferred.evidence.length,
          servicePolicy: servicePolicy.evidence.length,
        },
        startupOnlyControl: {
          prefix: "gateway.controlUi.enabled",
          closedPersistentSocket: true,
          originalBootId: bootId,
          replacementBootId: primary.bootId,
        },
        simulatedUpstreams: [
          "OpenAI provider",
          "OpenAI speech API (synthetic WAV)",
          "GitHub API transport",
          "favicon HTTPS transport",
          "APNs relay (no Apple delivery)",
          "CLI session catalog",
          "browser and Canvas nodes",
          "SSH remote identity command with real isolated sshd",
        ],
      };
    },
    async () => {
      pluginPolicyAbort.abort();
      await pluginPolicy?.catch(() => {});
      await retention?.stop();
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
    async () => {
      // Child cleanup does not own this parent identity store or its live WAL.
      closeOpenClawStateDatabaseByPath(path.join(temporaryRoot, "state", "openclaw.sqlite"));
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    },
  );
  return { summary, passedChecks, failures };
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
    const { summary, passedChecks, failures } = await runProof(repoRoot, outputDir, (text) =>
      writer.appendLog(text),
    );
    const summaryPath = path.join(outputDir, "gateway-config-hot-reload-summary.json");
    await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
    const artifactFiles = new Set(await fs.readdir(outputDir));
    const passed = failures.length === 0;
    await writer.write({
      status: passed ? "pass" : "fail",
      durationMs: Date.now() - started,
      details: `${passedChecks} operation and config-admission checks passed across the primary, channel, security, deferred-restart, and service-policy Gateway fixtures; startup-only positive controls restarted${passed ? "" : `; failures: ${failures.map(({ prefix }) => prefix).join(", ")}`}`,
      artifacts: [
        { kind: "summary", filePath: summaryPath },
        ...[
          "security",
          "channels",
          "terminal-deferred",
          "service-policy",
          "policy",
          "policy-admission",
          "plugin-policy",
        ].map((name) => ({
          kind: "summary",
          filePath: path.join(outputDir, `gateway-config-hot-reload-${name}.json`),
        })),
        ...["control-ui-hot-reload.webm", "terminal-hot-reload.webm"]
          .filter((name) => artifactFiles.has(name))
          .map((name) => ({ kind: "video", filePath: path.join(outputDir, name) })),
        ...[
          "environment-teal",
          "environment-amber",
          "external-embed-0",
          "external-embed-1",
          "external-embed-2",
          "embed-strict",
          "embed-scripts",
          "embed-trusted",
          "terminal-enabled",
          "terminal-disabled",
          "terminal-reenabled",
        ]
          .filter((name) => artifactFiles.has(`${name}.png`))
          .map((name) => ({ kind: "screenshot", filePath: path.join(outputDir, `${name}.png`) })),
      ],
    });
    if (!passed) {
      process.stderr.write(writer.logText());
      process.exitCode = 1;
    }
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
