import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi, type Mock } from "vitest";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../../config/config.js";
import { stampConfigWriteMetadata } from "../../config/io.meta.js";
import type { CallGatewayOptions } from "../../gateway/call.js";
import { gatewayHealthResponse } from "../../gateway/health-response.test-support.js";
import * as runtimeUtils from "../../utils.js";
import { VERSION } from "../../version.js";
import {
  maybeRestartService,
  maybeStopManagedServiceBeforeMutableUpdate,
  maybeRestartServiceAfterFailedMutableUpdate,
} from "./update-command-service.js";

export function readyRecoveryHealth(
  port: number,
  running: boolean,
): Awaited<
  ReturnType<typeof import("../daemon-cli/restart-health.js").waitForGatewayHealthyRestart>
> {
  return {
    healthy: true,
    staleGatewayPids: [],
    runtime: { status: running ? "running" : "stopped" },
    portUsage: { port, status: "busy", listeners: [], hints: [] },
  };
}

export async function writeRecoveryConfig(configPath: string, version: string) {
  await fs.writeFile(
    configPath,
    JSON.stringify(stampConfigWriteMetadata({ gateway: { port: 19001 } }, undefined, version)),
  );
  clearConfigCache();
  clearRuntimeConfigSnapshot();
}

export function registerRecoveryTests(params: {
  root: () => string;
  configPath: () => string;
  mocks: {
    health: Mock<typeof import("../daemon-cli/restart-health.js").waitForGatewayHealthyRestart>;
    capability: Mock<
      typeof import("../../daemon/systemd-definition-mutation.js").readSystemdDefinitionMutationCapability
    >;
    command: Mock<typeof import("../../daemon/systemd.js").readSystemdServiceExecStart>;
    child: Mock<typeof import("../../process/exec.js").runCommandWithTimeout>;
    error: Mock;
    restart: Mock;
    script: Mock;
    ports: Mock<typeof import("../../infra/ports-inspect.js").inspectPortUsage>;
    call: Mock<(opts: CallGatewayOptions) => Promise<unknown>>;
    configSnapshot: Mock<() => Promise<void>>;
    running: boolean;
    events: string[];
  };
}): void {
  it.each([
    { startup: "fast", readyAfterMs: 0, needsRecovery: false },
    { startup: "slow", readyAfterMs: 20_000, needsRecovery: false },
    { startup: "unready", readyAfterMs: Infinity, needsRecovery: true },
    { startup: "wrong version", readyAfterMs: 0, needsRecovery: true },
  ])(
    "verifies the $startup refresh before deciding on recovery",
    async ({ startup, readyAfterMs, needsRecovery }) => {
      const root = params.root();
      const mocks = params.mocks;
      let nowMs = 0;
      let recovering = false;
      vi.spyOn(performance, "now").mockImplementation(() => nowMs);
      vi.spyOn(runtimeUtils, "sleep").mockImplementation(async (ms) => {
        nowMs += ms;
      });
      mocks.capability.mockResolvedValue({ kind: "writable" });
      const before = await maybeStopManagedServiceBeforeMutableUpdate({
        updateInstallKind: "package",
        root,
        shouldRestart: true,
        jsonMode: true,
      });
      expect(before.serviceUpdateVerdict).toMatchObject({ kind: "owned", refreshDefinition: true });

      mocks.child.mockImplementation(async (args) => {
        if (args.includes("restart")) {
          recovering = true;
          mocks.events.push("recovery restart");
        } else {
          expect(args).toContain("install");
          mocks.events.push("refresh activation");
        }
        mocks.running = true;
        return {
          code: 0,
          stdout: "",
          stderr: "",
          signal: null,
          killed: false,
          termination: "exit",
        };
      });
      mocks.configSnapshot.mockResolvedValue(undefined);
      mocks.ports.mockImplementation(async (port) => {
        const ready = recovering || nowMs >= readyAfterMs;
        return {
          port,
          status: ready ? "busy" : "free",
          listeners: ready ? [{ pid: 4242, command: "openclaw-gateway" }] : [],
          hints: [],
        };
      });
      mocks.call.mockImplementation(async (opts) =>
        gatewayHealthResponse({
          server: {
            version: startup === "wrong version" && !recovering ? "2026.1.1" : VERSION,
            connId: "fixture",
          },
        })(opts),
      );
      const { waitForGatewayHealthyRestart } = await vi.importActual<
        typeof import("../daemon-cli/restart-health.js")
      >("../daemon-cli/restart-health.js");
      const healthResults: Awaited<ReturnType<typeof waitForGatewayHealthyRestart>>[] = [];
      mocks.health.mockImplementation(async (healthParams) => {
        const health = await waitForGatewayHealthyRestart(healthParams);
        healthResults.push(health);
        mocks.events.push(`health: ${health.waitOutcome}`);
        return health;
      });

      const activated = await maybeRestartService({
        channel: "stable",
        shouldRestart: true,
        result: {
          status: "ok",
          mode: "npm",
          root,
          steps: [],
          durationMs: 0,
          before: { version: "2026.1.1" },
          after: { version: VERSION },
        },
        opts: { json: true },
        refreshServiceEnv: true,
        serviceInstallEnv: process.env,
        serviceUpdateVerdict: before.serviceUpdateVerdict,
        serviceEnv: before.serviceEnv,
        gatewayPort: 19305,
        requireRunningServiceAfterRestart: true,
        timeoutMs: 1_000,
      });

      expect(activated).toBe(true);
      expect(mocks.events).toEqual([
        "native stop",
        "refresh activation",
        ...(needsRecovery
          ? [
              `health: ${startup === "wrong version" ? "version-mismatch" : "timeout"}`,
              "recovery restart",
            ]
          : []),
        "health: healthy",
      ]);
      expect(mocks.script).not.toHaveBeenCalled();
      expect(mocks.restart).not.toHaveBeenCalled();
      if (startup === "unready") {
        expect(healthResults[0]?.elapsedMs).toBeGreaterThanOrEqual(60_000);
      } else if (!needsRecovery) {
        expect(nowMs).toBeGreaterThanOrEqual(readyAfterMs + 5_500);
      }
    },
  );

  it.each(["healthy", "unready", "exited"] as const)(
    "failed-update recovery requires canonical readiness after start acceptance (%s)",
    async (outcome) => {
      const before = await maybeStopManagedServiceBeforeMutableUpdate({
        updateInstallKind: "package",
        root: params.root(),
        shouldRestart: true,
        jsonMode: true,
      });
      params.mocks.health.mockImplementation(async ({ port, expectedVersion }) => ({
        healthy: outcome === "healthy",
        staleGatewayPids: [],
        gatewayVersion: expectedVersion,
        runtime: { status: outcome === "exited" ? "stopped" : "running" },
        portUsage: {
          port,
          status: outcome === "healthy" ? "busy" : "free",
          listeners: [],
          hints: [],
        },
      }));
      await expect(
        maybeRestartServiceAfterFailedMutableUpdate({
          preManagedServiceStop: before,
          jsonMode: true,
          recovery: { serviceRestartSafe: true, version: VERSION, buildId: "restored-git-build" },
        }),
      ).resolves.toBe(outcome === "healthy" ? "healthy" : "failed");
      expect(params.mocks.health).toHaveBeenCalledWith(
        expect.objectContaining({
          expectedBuildId: "restored-git-build",
          requireRunningService: true,
        }),
      );
    },
  );
  it.each([
    "foreign",
    "metadata",
    "unit",
    "unavailable",
    "replacement root",
    "profile",
    "before activation",
    "after readiness",
  ])("revalidates stale-parent failed-update recovery after %s changes", async (change) => {
    const root = params.root();
    const configPath = params.configPath();
    const mocks = params.mocks;
    mocks.capability.mockResolvedValue({ kind: "writable" });
    const before = await maybeStopManagedServiceBeforeMutableUpdate({
      updateInstallKind: "package",
      root,
      shouldRestart: true,
      jsonMode: true,
    });
    expect(before.stopped).toBe(true);
    await writeRecoveryConfig(configPath, "9999.1.1");
    process.env.OPENCLAW_GATEWAY_PORT = "19999";
    const command = await mocks.command(process.env);
    if (!command) {
      throw new Error("missing fixture command");
    }
    if (change === "unavailable") {
      mocks.command.mockRejectedValue(new Error("manager unavailable"));
    } else {
      const foreign = path.join(root, "foreign");
      await fs.mkdir(path.join(foreign, "dist"), { recursive: true });
      await fs.writeFile(
        path.join(foreign, "package.json"),
        JSON.stringify({ name: "openclaw", version: VERSION }),
      );
      await fs.writeFile(path.join(foreign, "dist", "index.js"), "export {};\n");
      const replacement = {
        ...command,
        programArguments: [
          process.execPath,
          path.join(
            ["foreign", "replacement root"].includes(change) ? foreign : root,
            "dist",
            "index.js",
          ),
          "gateway",
          "--port",
          "19002",
        ],
        environment: {
          HOME: root,
          OPENCLAW_PROFILE: "default",
          OPENCLAW_STATE_DIR: path.dirname(configPath),
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_SYSTEMD_UNIT:
            change === "unit" ? "openclaw-other.service" : "openclaw-gateway.service",
          ...(change === "profile"
            ? {
                OPENCLAW_PROFILE: "second",
                OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway-second.service",
                OPENCLAW_STATE_DIR: path.join(root, ".openclaw-second"),
                OPENCLAW_CONFIG_PATH: path.join(root, ".openclaw-second", "openclaw.json"),
              }
            : {}),
        },
      };
      if (change === "after readiness") {
        mocks.health.mockImplementationOnce(async ({ port }) => {
          mocks.command.mockResolvedValue(replacement);
          return readyRecoveryHealth(port, true);
        });
      } else {
        mocks.command.mockResolvedValue(replacement);
        if (change === "before activation") {
          mocks.command.mockResolvedValueOnce(command);
        }
      }
    }
    mocks.events.push("update failed after definition changed");
    const recovered = await maybeRestartServiceAfterFailedMutableUpdate({
      recovery: { serviceRestartSafe: true, version: VERSION },
      preManagedServiceStop: before,
      jsonMode: true,
    });
    if (change === "metadata") {
      expect(mocks.child).toHaveBeenCalledOnce();
      expect(mocks.child.mock.calls[0]?.[0]).toContain("--preserve-definition");
      expect(mocks.restart).not.toHaveBeenCalled();
      expect(mocks.child.mock.calls[0]?.[1]).toMatchObject({ baseEnv: {} });
      expect(mocks.child.mock.calls[0]?.[1]).not.toHaveProperty("env.OPENCLAW_GATEWAY_PORT");
    } else if (change === "after readiness") {
      expect(recovered).toBe("failed");
      expect(mocks.child).toHaveBeenCalledOnce();
      expect(mocks.restart).not.toHaveBeenCalled();
      expect(mocks.error.mock.calls.flat().join("\n")).toContain(
        "ownership or manager identity changed",
      );
    } else {
      expect(mocks.child).not.toHaveBeenCalled();
      expect(mocks.restart).not.toHaveBeenCalled();
      expect(mocks.error.mock.calls.flat().join("\n")).toContain("Failed to restart");
      expect(mocks.events).toEqual(["native stop", "update failed after definition changed"]);
    }
  });
}
