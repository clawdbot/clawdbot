import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createQaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../../packages/gateway-protocol/src/client-info.js";
import { createExecTool } from "../../../../src/agents/bash-tools.exec-run.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../../src/config/runtime-snapshot.js";
import { GatewayClient } from "../../../../src/gateway/client.js";
import { loadOrCreateDeviceIdentity } from "../../../../src/infra/device-identity.js";
import { closeOpenClawStateDatabaseForTest } from "../../../../src/state/openclaw-state-db.js";
import { runQaGatewayFixture, stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import {
  TEST_TIMEOUT_MS,
  WAIT_OPTIONS,
  approvePairing,
  createChildEnv,
  readNode,
  startNodeProcess,
  stopChild,
  waitForNode,
  type CapturedChild,
  type GatewayHandle,
} from "./gateway-node-mcp.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function quotePath(value: string): string {
  return process.platform === "win32" ? `"${value}"` : `'${value.replaceAll("'", "'\\''")}'`;
}

it(
  "exec routes real commands only to an eligible selected node",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const repoRoot = process.cwd();
    const root = tempDirs.make("openclaw-node-exec-routing-");
    const owner = createQaGatewayChild();
    const children: CapturedChild[] = [];
    const canvasClients: GatewayClient[] = [];
    const probe = path.join(root, "probe.mjs");
    await fs.writeFile(
      probe,
      [
        'import fs from "node:fs";',
        'import os from "node:os";',
        'import path from "node:path";',
        "const home = os.homedir();",
        "const marker = process.argv[2];",
        'fs.appendFileSync(path.join(home, "exec-proof.txt"), `${marker}\\n`);',
        "console.log(JSON.stringify({ home, marker }));",
      ].join("\n"),
    );
    const requests = vi.spyOn(GatewayClient.prototype, "request");
    const command = (marker: string) =>
      `${quotePath(process.execPath)} ${quotePath(probe)} ${marker}`;
    const effects = (home: string) => fs.readFile(path.join(home, "exec-proof.txt"), "utf8");
    const nodeInvokes = () => requests.mock.calls.filter(([method]) => method === "node.invoke");

    async function startExecutor(gateway: GatewayHandle, label: string) {
      const nodeRoot = path.join(root, label);
      const home = path.join(nodeRoot, "home");
      const state = path.join(nodeRoot, "state");
      const tmp = path.join(nodeRoot, "tmp");
      const config = path.join(nodeRoot, "openclaw.json");
      await Promise.all([home, state, tmp].map((dir) => fs.mkdir(dir, { recursive: true })));
      await fs.writeFile(
        config,
        JSON.stringify({
          gateway: { mode: "local" },
          plugins: { enabled: false },
          nodeHost: { browserProxy: { enabled: false }, skills: { enabled: false } },
        }),
      );
      const env = createChildEnv({
        home,
        tempDir: tmp,
        extra: {
          OPENCLAW_HOME: home,
          OPENCLAW_STATE_DIR: state,
          OPENCLAW_CONFIG_PATH: config,
          OPENCLAW_GATEWAY_TOKEN: gateway.token,
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_SKIP_PROVIDERS: "1",
        },
      });
      const port = Number(new URL(gateway.baseUrl).port);
      const first = startNodeProcess(port, env);
      children.push(first);
      const nodeId = await approvePairing(gateway, "device");
      await stopChild(first);
      const child = startNodeProcess(port, env);
      children.push(child);
      await approvePairing(gateway, "node", nodeId);
      const node = await waitForNode(gateway, nodeId);
      if (!node.displayName) {
        throw new Error("Node fixture omitted its display name");
      }
      return { nodeId, displayName: node.displayName, home, child };
    }

    await runQaGatewayFixture(
      async () => {
        const gateway = await owner.start({
          repoRoot,
          command: {
            executablePath: process.execPath,
            argsPrefix: ["dist/index.js"],
            cwd: repoRoot,
            usePackagedPlugins: true,
          },
          transportBaseUrl: "http://127.0.0.1",
          controlUiEnabled: false,
          runtimeEnvPatch: {
            OPENCLAW_SKIP_CHANNELS: "1",
            OPENCLAW_SKIP_PROVIDERS: "1",
            OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
          },
          mutateConfig: (cfg) => ({
            ...cfg,
            plugins: { enabled: false },
            gateway: {
              ...cfg.gateway,
              nodes: {
                ...cfg.gateway?.nodes,
                commands: { allow: ["system.run", "system.run.prepare", "canvas.present"] },
                pairing: { autoApproveLocal: false, sshVerify: false },
              },
            },
          }),
        });
        const callerHome = path.join(root, "caller");
        const callerState = path.join(callerHome, "state");
        const callerConfig = path.join(callerHome, "openclaw.json");
        await fs.mkdir(callerState, { recursive: true });
        await fs.writeFile(callerConfig, JSON.stringify(gateway.cfg));
        vi.stubEnv("HOME", callerHome);
        vi.stubEnv("OPENCLAW_HOME", callerHome);
        vi.stubEnv("OPENCLAW_STATE_DIR", callerState);
        vi.stubEnv("OPENCLAW_CONFIG_PATH", callerConfig);
        vi.stubEnv("OPENCLAW_GATEWAY_URL", undefined);
        vi.stubEnv("OPENCLAW_GATEWAY_PORT", new URL(gateway.baseUrl).port);
        vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", gateway.token);
        setRuntimeConfigSnapshot(gateway.cfg);
        const makeExec = (node?: string) =>
          createExecTool({
            host: "node",
            mode: "full",
            node,
            config: gateway.cfg,
            cwd: root,
            allowBackground: false,
            notifyOnExit: false,
          });
        const exec = makeExec();
        const first = await startExecutor(gateway, "first");
        const inventory = (await gateway.call("node.list", {})) as {
          nodes: Array<{ nodeId: string; caps: string[]; commands: string[] }>;
        };
        const executor = inventory.nodes.find((node) => node.nodeId === first.nodeId);
        expect(executor?.commands).toContain("system.run");
        expect(executor?.caps).not.toContain("canvas");

        const run = async (marker: string, target: typeof first, node?: string) => {
          requests.mockClear();
          const result = await exec.execute(marker, { command: command(marker), node });
          expect(result.details).toMatchObject({
            status: "completed",
            exitCode: 0,
            nodeId: target.nodeId,
          });
          const text = result.content.find((item) => item.type === "text")?.text;
          expect(text).toContain(`Node: ${target.nodeId}`);
          expect(text).toContain(JSON.stringify({ home: target.home, marker }));
          expect(nodeInvokes().map(([, params]) => params)).toEqual([
            expect.objectContaining({ nodeId: target.nodeId, command: "system.run.prepare" }),
            expect.objectContaining({ nodeId: target.nodeId, command: "system.run" }),
          ]);
        };
        await run("sole", first);
        expect(await effects(first.home)).toBe("sole\n");

        const canvasIdentity = loadOrCreateDeviceIdentity({
          path: path.join(root, "canvas.sqlite"),
        });
        const startCanvas = () => {
          const client = new GatewayClient({
            url: gateway.wsUrl,
            token: gateway.token,
            clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
            clientDisplayName: first.displayName,
            mode: GATEWAY_CLIENT_MODES.NODE,
            role: "node",
            scopes: [],
            platform: process.platform,
            caps: ["canvas"],
            commands: ["canvas.present"],
            deviceIdentity: canvasIdentity,
          });
          canvasClients.push(client);
          client.start();
          return client;
        };
        const unpairedCanvas = startCanvas();
        expect(await approvePairing(gateway, "device")).toBe(canvasIdentity.deviceId);
        await unpairedCanvas.stopAndWait();
        startCanvas();
        await approvePairing(gateway, "node", canvasIdentity.deviceId);
        await expect
          .poll(() => readNode(gateway, canvasIdentity.deviceId), WAIT_OPTIONS)
          .toMatchObject({ connected: true });
        await run("mixed", first);
        expect(await effects(first.home)).toBe("sole\nmixed\n");

        requests.mockClear();
        await expect(
          makeExec(first.displayName).execute("ambiguous-binding", {
            command: command("ambiguous-binding"),
          }),
        ).rejects.toThrow(/ambiguous node/);
        expect(nodeInvokes()).toEqual([]);
        expect(await effects(first.home)).toBe("sole\nmixed\n");

        const second = await startExecutor(gateway, "second");
        requests.mockClear();
        await expect(exec.execute("ambiguous", { command: command("ambiguous") })).rejects.toThrow(
          /multiple executable nodes/,
        );
        expect(nodeInvokes()).toEqual([]);
        expect(await effects(first.home)).toBe("sole\nmixed\n");
        await expect(effects(second.home)).rejects.toMatchObject({ code: "ENOENT" });

        await run("explicit", second, second.nodeId);
        expect(await effects(first.home)).toBe("sole\nmixed\n");
        expect(await effects(second.home)).toBe("explicit\n");
        await stopChild(second.child);
        await expect
          .poll(() => readNode(gateway, second.nodeId), WAIT_OPTIONS)
          .toMatchObject({ connected: false });
        for (const [name, tool, node] of [
          ["explicit-offline", exec, second.nodeId],
          ["bound-offline", makeExec(second.nodeId), undefined],
          ["bound-mismatch", makeExec(second.nodeId), first.nodeId],
        ] as const) {
          requests.mockClear();
          await expect(tool.execute(name, { command: command(name), node })).rejects.toThrow(
            /not eligible|exec node not allowed/,
          );
          expect(nodeInvokes()).toEqual([]);
          expect(await effects(first.home)).toBe("sole\nmixed\n");
          expect(await effects(second.home)).toBe("explicit\n");
        }
        await run("remaining", first);
        expect(await effects(first.home)).toBe("sole\nmixed\nremaining\n");
      },
      async () => {
        const results = await Promise.allSettled([
          ...canvasClients.map((client) => client.stopAndWait()),
          ...children.map((child) => stopChild(child)),
        ]);
        const errors = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (errors.length) {
          throw new AggregateError(errors, "Node routing fixture cleanup failed");
        }
      },
      () => stopQaGatewayFixture(owner),
      () => requests.mockRestore(),
      () => closeOpenClawStateDatabaseForTest(),
      () => clearRuntimeConfigSnapshot(),
      () => vi.unstubAllEnvs(),
    );
  },
);
