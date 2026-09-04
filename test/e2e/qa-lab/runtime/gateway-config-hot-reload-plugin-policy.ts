import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { QaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import { loadOrCreateDeviceIdentity } from "../../../../src/infra/device-identity.js";
import { runQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { createHotReloadExternalBrowser } from "./gateway-config-hot-reload-external-browser.js";
import {
  connectHotReloadClient,
  waitForHotReloadFact,
  type HotReloadConnection,
} from "./gateway-config-hot-reload-fixtures.js";

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
  details: { targetId?: string; viewerUrl?: string; ok?: boolean };
};
type BrowserStatus = { pid: number | null; cdpUrl: string; running: boolean; attachOnly: boolean };
type BrowserTabs = { tabs: Array<{ targetId: string; url: string }> };
const CANVAS_ASSET = "/__openclaw__/a2ui/a2ui.bundle.js";
const SESSION_KEY = "agent:qa:hot-reload-plugin";
// These are the shipped cleanup cadence and cap, observed through real elapsed time and tabs.
const SWEEP_MS = 5 * 60_000;
const TAB_CAP = 8;
const CLEANUP_PROFILE = "cleanup-proof";

export async function proveHotReloadPluginPolicy({
  gateway,
  unaffectedNode,
  temporaryRoot,
  outputDir,
  fixtureBaseUrl,
  rpc,
  patch,
  http,
  proveGroup,
  verifyContinuity,
  appendLog,
  signal,
}: {
  gateway: QaGatewayChild;
  unaffectedNode: HotReloadConnection | undefined;
  temporaryRoot: string;
  outputDir: string;
  fixtureBaseUrl: string;
  rpc: <T>(method: string, params?: unknown) => Promise<T>;
  patch: (change: unknown, replacePaths?: string[]) => Promise<unknown>;
  http: (route: string, body?: unknown) => Promise<{ status: number; text: string }>;
  proveGroup: (prefix: string, run: () => Promise<void>) => Promise<void>;
  verifyContinuity: (prefix: string, observation: string) => Promise<void>;
  appendLog: (text: string) => void;
  signal: AbortSignal;
}) {
  const initial = (await rpc<{ config: OpenClawConfig }>("config.get")).config;
  const observations: Array<Record<string, unknown>> = [];
  const log = (text: string) => {
    appendLog(`${text}\n`);
    process.stdout.write(`${text}\n`);
  };
  const tool = async (name: string, args: unknown, sessionKey = SESSION_KEY) => {
    const response = await http("/tools/invoke", { tool: name, sessionKey, args });
    assert.equal(response.status, 200, response.text);
    const { result } = JSON.parse(response.text) as { result: ToolResult };
    assert.notEqual(result.isError, true, response.text);
    assert.notEqual(result.details.ok, false, response.text);
    return result;
  };
  const browser = (args: Record<string, unknown>, sessionKey?: string) =>
    tool("browser", { target: "host", profile: "openclaw", ...args }, sessionKey);
  const browserRequest = <T>(route: string, profile = "openclaw") =>
    rpc<T>("browser.request", {
      target: "host",
      method: "GET",
      path: route,
      query: { profile },
      timeoutMs: 30_000,
    });
  try {
    // Plugin generations can replace services. Finish Canvas changes before measuring Chrome continuity.
    await proveGroup("plugins.entries.canvas.config.host.enabled", async () => {
      assert(unaffectedNode, "Canvas continuity proof requires the approved browser-only node");
      const originalNode = {
        hellos: unaffectedNode.hellos,
        closes: unaffectedNode.closes,
        bootId: unaffectedNode.bootId,
      };
      const verifyUnaffectedNode = () => {
        assert.equal(unaffectedNode.hellos, originalNode.hellos, "Browser-only node reconnected");
        assert.equal(unaffectedNode.closes, originalNode.closes, "Browser-only node was closed");
        assert.equal(unaffectedNode.bootId, originalNode.bootId);
        return {
          unaffectedNodeHellos: unaffectedNode.hellos,
          unaffectedNodeCloses: unaffectedNode.closes,
        };
      };
      let node: HotReloadConnection | undefined;
      const host = initial.plugins?.entries?.canvas?.config?.host;
      const setEnabled = (enabled: boolean) =>
        patch({ plugins: { entries: { canvas: { config: { host: { enabled } } } } } });
      const routeState = async (enabled: boolean) => {
        const response = await waitForHotReloadFact("Canvas route publication", async () => {
          const current = await http(CANVAS_ASSET);
          return current.status === (enabled ? 200 : 404) ? current : undefined;
        });
        if (enabled) {
          assert(response.text.length > 1_000, "Canvas must serve the actual renderer bundle");
        }
        return response.status;
      };
      try {
        await setEnabled(false);
        await routeState(false);
        const identity = loadOrCreateDeviceIdentity({
          path: path.join(temporaryRoot, "state/openclaw.sqlite"),
          identityKey: "canvas-hot-reload-node",
        });
        const connected = await connectHotReloadClient(gateway, {
          identity,
          caps: ["canvas"],
          commands: [],
        });
        node = connected;
        const pending = await rpc<{
          pending: Array<{ requestId: string; nodeId: string }>;
        }>("node.pair.list");
        const request = pending.pending.find((entry) => entry.nodeId === identity.deviceId);
        assert(request, "New Canvas node must request approval for its declared capability");
        await rpc("node.pair.approve", { requestId: request.requestId });
        await waitForHotReloadFact("approved Canvas node", async () => {
          const { nodes } = await rpc<{
            nodes: Array<{ nodeId: string; connected: boolean; caps: string[] }>;
          }>("node.list");
          return nodes.find(
            (entry) =>
              entry.nodeId === identity.deviceId &&
              entry.connected &&
              entry.caps.includes("canvas"),
          );
        });
        const initialCanvasUrl = connected.pluginSurfaceUrls.canvas;
        assert.equal(initialCanvasUrl, undefined);
        observations.push({
          prefix: "plugins.entries.canvas.config.host.enabled",
          enabled: false,
          routeStatus: 404,
          nodeHellos: connected.hellos,
          nodeCloses: connected.closes,
          ...verifyUnaffectedNode(),
          hasCapabilityUrl: false,
        });
        const bootId = connected.bootId;
        let previousUrl: string | undefined;
        for (const enabled of [true, false, true]) {
          const hellos = connected.hellos;
          const closes = connected.closes;
          await setEnabled(enabled);
          await waitForHotReloadFact("Canvas capability reconnect", () =>
            connected.hellos > hellos && Boolean(connected.pluginSurfaceUrls.canvas) === enabled
              ? true
              : undefined,
          );
          assert.equal(connected.closes, closes + 1);
          assert.equal(connected.hellos, hellos + 1);
          assert.equal(connected.bootId, bootId);
          const status = await routeState(enabled);
          const scopedUrl: string | undefined = connected.pluginSurfaceUrls.canvas;
          if (scopedUrl) {
            assert.notEqual(scopedUrl, previousUrl);
            const asset: Response = await fetch(`${scopedUrl}${CANVAS_ASSET}`, {
              signal: AbortSignal.timeout(30_000),
            });
            assert.equal(asset.status, 200);
            assert((await asset.text()).length > 1_000);
            if (previousUrl) {
              const retired = await fetch(`${previousUrl}${CANVAS_ASSET}`, {
                signal: AbortSignal.timeout(30_000),
              });
              assert.notEqual(
                retired.status,
                200,
                "Re-enabled Canvas accepted the retired capability",
              );
              await retired.arrayBuffer();
            }
            previousUrl = scopedUrl;
          } else {
            assert(previousUrl);
            const revoked = await fetch(`${previousUrl}${CANVAS_ASSET}`, {
              signal: AbortSignal.timeout(30_000),
            });
            assert.notEqual(revoked.status, 200, "Disabled Canvas retained a working capability");
            await revoked.arrayBuffer();
          }
          observations.push({
            prefix: "plugins.entries.canvas.config.host.enabled",
            enabled,
            routeStatus: status,
            nodeHellos: connected.hellos,
            nodeCloses: connected.closes,
            ...verifyUnaffectedNode(),
            hasCapabilityUrl: Boolean(scopedUrl),
          });
        }
        await verifyContinuity(
          "plugins.entries.canvas.config.host.enabled",
          "A node admitted while Canvas was disabled reconnected on enable→disable→re-enable, gained→lost→regained working renderer URLs, and its old capability stopped working; the browser-only node kept its original connection",
        );
      } finally {
        await node?.client.stopAndWait({ timeoutMs: 2_000 });
        await patch({ plugins: { entries: { canvas: { config: { host: host ?? null } } } } }, [
          "plugins.entries.canvas.config.host",
        ]);
      }
    });

    await proveGroup("gateway.publicOrigin", async () => {
      try {
        for (const origin of [
          "https://diff-a.example.invalid",
          "https://diff-b.example.invalid",
          "https://diff-a.example.invalid",
        ]) {
          await patch({ gateway: { publicOrigin: origin } });
          const result = await tool("diffs", {
            before: "Before hot reload\n",
            after: "After hot reload\n",
            path: "hot-reload-proof.txt",
            title: "Synthetic hot reload diff",
            mode: "view",
          });
          assert(result.details.viewerUrl);
          assert.equal(new URL(result.details.viewerUrl).origin, origin);
          const viewer = await http(new URL(result.details.viewerUrl).pathname);
          assert.equal(viewer.status, 200, viewer.text);
          assert(viewer.text.includes("Synthetic hot reload diff"));
          assert(viewer.text.includes("hot-reload-proof.txt"));
          observations.push({
            prefix: "gateway.publicOrigin",
            origin,
            viewerStatus: viewer.status,
          });
        }
        await verifyContinuity(
          "gateway.publicOrigin",
          "Actual Diffs tool invocations emitted public origins A→B→A and the Gateway served each generated viewer artifact",
        );
      } finally {
        await patch({ gateway: { publicOrigin: initial.gateway?.publicOrigin ?? null } });
      }
    });

    await proveGroup("browser.snapshotDefaults", async () => {
      let targetId: string | undefined;
      try {
        const opened = await browser(
          { action: "open", url: `${fixtureBaseUrl}/widget?snapshot-proof=1` },
          `${SESSION_KEY}-snapshot`,
        );
        targetId = opened.details.targetId;
        assert(targetId);
        const status = await browserRequest<BrowserStatus>("/");
        assert(status.pid, "Snapshot proof must use the Gateway-owned Chromium process");
        for (const efficient of [false, true, false]) {
          await patch({ browser: { snapshotDefaults: efficient ? { mode: "efficient" } : null } });
          const snapshot = await browser({ action: "snapshot", targetId });
          const text = snapshot.content.map((item) => item.text ?? "").join("\n");
          assert(text.includes("Hot reload action"));
          assert.equal(text.includes("Synthetic embedded page"), !efficient);
          assert.equal((await browserRequest<BrowserStatus>("/")).pid, status.pid);
          observations.push({
            prefix: "browser.snapshotDefaults",
            mode: efficient ? "efficient" : "full",
            hasParagraph: text.includes("Synthetic embedded page"),
            hasButton: text.includes("Hot reload action"),
            browserPid: status.pid,
          });
        }
        await verifyContinuity(
          "browser.snapshotDefaults",
          "Actual Browser snapshots changed full→efficient→full: the paragraph disappeared and returned, the interactive button stayed visible, and Chromium kept the same PID and tab",
        );
      } finally {
        if (targetId) {
          await browser({ action: "close", targetId }, `${SESSION_KEY}-snapshot`);
        }
        await patch({ browser: { snapshotDefaults: initial.browser?.snapshotDefaults ?? null } }, [
          "browser.snapshotDefaults",
        ]);
      }
    });

    await proveGroup("browser.tabCleanup", async () => {
      const externalOwner = createHotReloadExternalBrowser(temporaryRoot);
      const opened: string[] = [];
      const ownedTabs = async () => {
        const { tabs } = await browserRequest<BrowserTabs>("/tabs", CLEANUP_PROFILE);
        return tabs
          .filter((tab) => opened.includes(tab.targetId))
          .map((tab) => tab.targetId)
          .toSorted();
      };
      const openTab = async () => {
        const result = await browser({
          profile: CLEANUP_PROFILE,
          action: "open",
          url: `${fixtureBaseUrl}/widget?cleanup-proof=${opened.length}`,
        });
        assert(result.details.targetId);
        opened.push(result.details.targetId);
      };
      await runQaGatewayFixture(
        async () => {
          const external = await externalOwner.start();
          // Managed opens have a separate eight-page cap. An attached profile isolates
          // the periodic policy while the Browser tool still owns every tracked tab.
          await patch({
            browser: {
              tabCleanup: { enabled: false },
              profiles: { [CLEANUP_PROFILE]: { cdpUrl: external.cdpUrl, attachOnly: true } },
            },
          });
          for (let index = 0; index <= TAB_CAP; index += 1) {
            await openTab();
          }
          const status = await browserRequest<BrowserStatus>("/", CLEANUP_PROFILE);
          assert(status.running && status.attachOnly);
          assert.equal(status.pid, null, "Gateway must not own the external Chromium process");
          const expectedRetained = opened.slice(1).toSorted();
          for (const [phase, enabled] of [false, true, false].entries()) {
            await patch({ browser: { tabCleanup: { enabled } } });
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
              signal.throwIfAborted();
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
              await delay(5_000, undefined, { signal });
            }
            assert.deepEqual(retained, expected);
            observations.push({
              prefix: "browser.tabCleanup",
              enabled,
              elapsedMs: Date.now() - started,
              trackedTabs: retained.length,
              browserPid: external.pid,
            });
            await verifyContinuity(
              "browser.tabCleanup",
              `Real sweep phase ${phase + 1}: enabled=${enabled}, ${retained.length} tracked tabs retained after ${Math.floor((Date.now() - started) / 1_000)}s; external Chromium PID, CDP connection and unowned witness page unchanged`,
            );
          }
        },
        async () => {
          if (opened.length) {
            for (const targetId of await ownedTabs()) {
              await browser({ action: "close", targetId, profile: CLEANUP_PROFILE });
            }
          }
        },
        async () => {
          await patch(
            {
              browser: {
                tabCleanup: initial.browser?.tabCleanup ?? null,
                profiles: {
                  [CLEANUP_PROFILE]: initial.browser?.profiles?.[CLEANUP_PROFILE] ?? null,
                },
              },
            },
            ["browser.tabCleanup", `browser.profiles.${CLEANUP_PROFILE}`],
          );
        },
        () => externalOwner.close(),
      );
    });
  } finally {
    await fs.writeFile(
      path.join(outputDir, "gateway-config-hot-reload-plugin-policy.json"),
      `${JSON.stringify(observations, null, 2)}\n`,
    );
  }
}
