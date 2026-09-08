import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { inspect } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as launchctl from "../../daemon/launchd-exec.js";
import * as services from "../../daemon/service.js";
import {
  createMockGatewayService,
  mockSystemAccountHome,
} from "../../daemon/service.test-helpers.js";
import * as systemctl from "../../daemon/systemd-exec.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import { commitUpdateRecoveryTerminal } from "../../infra/update-run-recovery-terminal.js";
import { rawDataToString } from "../../infra/ws.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import * as healthProbe from "../daemon-cli/restart-health.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import { resumePendingUpdateCommand } from "./update-command-pending-replay.js";
import { retireSupersededUpdateCommandPair } from "./update-command-retirement.js";
import { createRetirementFixture } from "./update-command-retirement.test-support.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});
it("retries terminal cleanup only after fresh native and authenticated serving readiness", async () => {
  const home = await fs.realpath(dirs.make("retirement-ready-retry-"));
  const root = path.join(home, "state");
  const control = path.join(home, "control");
  await fs.mkdir(root);
  await fs.mkdir(control);
  vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
  mockSystemAccountHome();
  const liveRoot = path.join(root, "node_modules", "openclaw");
  const definition = path.join(root, "gateway.service");
  await fs.writeFile(definition, "original native service\n");
  let running = true,
    enabled = true,
    servedBoot = "selected-boot";
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => {
    server.once("listening", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("No serving port");
  }
  let connections = 0;
  server.on("connection", (socket) => {
    connections++;
    socket.send(
      JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "fixture", ts: Date.now() },
      }),
    );
    socket.on("message", (data) => {
      const frame = JSON.parse(rawDataToString(data)) as { id: string; method: string };
      socket.send(
        JSON.stringify({
          type: "res",
          id: frame.id,
          ok: true,
          payload:
            frame.method === "connect"
              ? {
                  type: "hello-ok",
                  protocol: 4,
                  server: { version: "3.0.0", bootId: servedBoot, connId: "cleanup-fixture" },
                  features: { methods: ["health"], events: ["shutdown"] },
                  snapshot: {
                    presence: [],
                    health: {},
                    stateVersion: { presence: 1, health: 1 },
                    uptimeMs: 1,
                  },
                  auth: { role: "operator", scopes: ["operator.read"] },
                  policy: { maxPayload: 524288, maxBufferedBytes: 1048576, tickIntervalMs: 30000 },
                }
              : { ok: true },
        }),
      );
    });
  });
  try {
    await withEnvAsync(
      {
        HOME: root,
        USERPROFILE: root,
        OPENCLAW_HOME: undefined,
        OPENCLAW_STATE_DIR: root,
        OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
        OPENCLAW_PROFILE: undefined,
        OPENCLAW_UPDATE_RUN_HANDOFF: undefined,
        OPENCLAW_SERVICE_MARKER: undefined,
        OPENCLAW_SERVICE_KIND: undefined,
      },
      async () => {
        const start = vi.fn(
          async (
            args: Parameters<ReturnType<typeof services.resolveGatewayService>["start"]>[0],
          ) => {
            args.assertCurrent?.();
            running = true;
          },
        );
        const stop = vi.fn(async () => {
          throw new Error("No unowned stop");
        });
        vi.spyOn(services, "resolveGatewayService").mockReturnValue(
          createMockGatewayService({
            readCommand: async () => ({
              programArguments: [
                process.execPath,
                path.join(liveRoot, "dist", "index.js"),
                "gateway",
              ],
              sourcePath: definition,
            }),
            readRuntime: async () => ({
              status: running ? "running" : "stopped",
              ...(running ? { pid: process.pid } : {}),
              systemd: { unit: "openclaw-gateway.service", managerUid: 2001 },
            }),
            isLoaded: async () => process.platform !== "darwin" || running,
            isEnabled: async () => enabled,
            start,
            stop,
          }),
        );
        const enable = async () => {
          enabled = true;
          return { code: 0, stdout: "", stderr: "", termination: "exit" as const };
        };
        vi.spyOn(launchctl, "execLaunchctl").mockImplementation(async (args) => {
          expect(args[0]).toBe("enable");
          return await enable();
        });
        vi.spyOn(systemctl, "execSystemctlUser").mockImplementation(async (_env, args) => {
          expect(args[0]).toBe("enable");
          return await enable();
        });
        const config = {
          gateway: { port: address.port, auth: { mode: "token", token: "fixture-only-token" } },
        };
        const generation = (version: string, existing: boolean) =>
          withUpdateCommandExecutor(randomUUID(), async (executor) => {
            const fence = await executor.enter(liveRoot);
            const f = await createRetirementFixture(root, version, existing, fence, {
              config,
              suppress: async () => {
                enabled = false;
              },
              stop: async () => {
                running = false;
              },
            });
            const observed = await f.activate();
            await f.restoreNative();
            f.record = commitUpdateRecoveryTerminal(
              f.record,
              { status: "succeeded", package: observed, assertReady: fence.assertCurrent },
              fence,
              f.options,
            );
            const decision = f.record.package!.descriptor.retention;
            if (decision?.state !== "selected") {
              throw new Error("No selected pair");
            }
            expect(await f.owner.retain(decision)).toMatchObject({ status: "verified" });
            return f;
          });
        const a = await generation("2.0.0", false);
        const b = await generation("3.0.0", true);
        const old = a.reload(),
          selected = b.reload();
        const selectedCopies = new Map<string, Buffer>();
        for (const ref of [
          selected.preimages!.ref,
          selected.checkpoint!.ref,
          ...selected.afterImages!.map((image) => image.afterUpdate.ref),
        ]) {
          for (const file of await fs.readdir(path.dirname(ref.manifestPath), {
            recursive: true,
            withFileTypes: true,
          })) {
            if (file.isFile()) {
              const name = path.join(file.parentPath, file.name);
              selectedCopies.set(name, await fs.readFile(name));
            }
          }
        }
        const remove = fs.rm.bind(fs);
        let cut = false;
        const interruption = vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
          if (!cut && target === path.dirname(old.checkpoint!.ref.manifestPath)) {
            cut = true;
            throw new Error("checkpoint interrupted");
          }
          await remove(target, options);
        });
        await expect(
          withUpdateCommandExecutor(b.run.runId, async (executor) => {
            const fence = await executor.enter(liveRoot);
            await retireSupersededUpdateCommandPair({
              fence,
              options: b.options,
              getRecord: () => selected,
              onRecord() {
                throw new Error("Cannot change selected history");
              },
              assertReady: () => fence.assertCurrent(),
            });
          }),
        ).rejects.toThrow();
        interruption.mockRestore();
        expect(cut).toBe(true);
        const pending = a.reload();
        expect(pending.effects.at(-1)).toMatchObject({ kind: "retirement", state: "intent" });
        const health = {
          healthy: true,
          runtime: { status: "running" as const, pid: process.pid },
          gatewayVersion: "3.0.0",
          gatewayBuildId: null,
          gatewayBootId: "selected-boot",
          staleGatewayPids: [],
          activatedPluginErrors: [],
          channelProbeErrors: [],
          portUsage: {
            port: address.port,
            status: "busy" as const,
            listeners: [{ pid: process.pid }],
            hints: [],
          },
        };
        vi.spyOn(healthProbe, "waitForGatewayHealthyRestart").mockResolvedValue(health);
        vi.spyOn(healthProbe, "inspectGatewayRestart").mockResolvedValue(health);
        let readyz = 503;
        vi.spyOn(healthProbe, "waitForGatewayHttpReadiness").mockImplementation(async () => ({
          healthz: 200,
          readyz,
        }));
        const retry = () => resumePendingUpdateCommand({ opts: { json: true }, root: liveRoot });
        const starts = start.mock.calls.length;
        await expect(retry()).rejects.toThrow(/readiness/);
        expect(connections).toBe(1);
        expect(a.reload()).toEqual(pending);
        readyz = 200;
        servedBoot = "wrong-boot";
        await expect(retry()).rejects.toThrow();
        expect(a.reload()).toEqual(pending);
        servedBoot = "selected-boot";
        const result = await retry().catch((error: unknown) => error);
        expect(result, inspect(result, { depth: 12 })).toBe(true);
        expect(a.reload().effects.at(-1)).toMatchObject({
          effectId: pending.effects.at(-1)!.effectId,
          kind: "retirement",
          state: "observed",
        });
        expect(b.reload()).toEqual(selected);
        for (const [file, bytes] of selectedCopies) {
          expect(await fs.readFile(file)).toEqual(bytes);
        }
        expect(start).toHaveBeenCalledTimes(starts);
        expect(stop).not.toHaveBeenCalled();
        expect(connections).toBe(3);
        expect(await retry()).toBe(false);
      },
    );
  } finally {
    for (const socket of server.clients) {
      socket.terminate();
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
