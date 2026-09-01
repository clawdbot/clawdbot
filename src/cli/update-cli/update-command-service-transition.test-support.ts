import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, type Mock } from "vitest";
import { readGatewayServiceState, resolveGatewayService } from "../../daemon/service.js";
import { VERSION } from "../../version.js";
import {
  maybeRestartService,
  maybeStopManagedServiceBeforeMutableUpdate,
  revalidateManagedGatewayServiceAfterUpdate,
} from "./update-command-service.js";

type InstallRootTransitionFixture = {
  root: string;
  mocks: {
    running: boolean;
    events: string[];
    command: Mock<typeof import("../../daemon/systemd.js").readSystemdServiceExecStart>;
    capability: Mock<
      typeof import("../../daemon/systemd-definition-mutation.js").readSystemdDefinitionMutationCapability
    >;
    child: Mock<typeof import("../../process/exec.js").runCommandWithTimeout>;
    health: Mock<typeof import("../daemon-cli/restart-health.js").waitForGatewayHealthyRestart>;
    script: Mock;
  };
};

export function registerInstallRootTransitionTests(getFixture: () => InstallRootTransitionFixture) {
  it.each([
    { scenario: "retained source launcher", mode: "npm", allowed: true },
    { scenario: "removed pnpm package root", mode: "pnpm", allowed: true },
    { scenario: "same-version stale launcher after refresh", mode: "npm", allowed: true },
    { scenario: "failed Git refresh retains original launcher", mode: "git", allowed: true },
    { scenario: "Git already serves target build", mode: "git", allowed: true },
    { scenario: "Git still serves previous build", mode: "git", allowed: true },
    { scenario: "changed original launcher", mode: "npm", allowed: false },
    { scenario: "original sealed definition", mode: "npm", allowed: false },
    { scenario: "newly sealed definition", mode: "npm", allowed: false },
    { scenario: "unknown definition authority", mode: "npm", allowed: false },
    { scenario: "original unresolved launcher", mode: "npm", allowed: false },
    { scenario: "unrequested root transition", mode: "npm", allowed: false },
  ] as const)(
    "refreshes a verified installed root with $scenario",
    async ({ scenario, mode, allowed }) => {
      const { root, mocks } = getFixture();
      const replacementRoot = path.join(root, "replacement");
      const replacementEntry = path.join(replacementRoot, "dist", "index.js");
      await fs.mkdir(path.dirname(replacementEntry), { recursive: true });
      await fs.writeFile(
        path.join(replacementRoot, "package.json"),
        JSON.stringify({ name: "openclaw", version: VERSION }),
      );
      await fs.writeFile(replacementEntry, "export {};\n");
      mocks.capability.mockResolvedValue(
        scenario === "original sealed definition"
          ? { kind: "sealed", reason: "foreign-owner" }
          : { kind: "writable" },
      );
      if (scenario === "original unresolved launcher") {
        mocks.command.mockResolvedValue({
          programArguments: ["openclaw-wrapper", "gateway"],
          environment: { HOME: root },
        });
      }
      const before = await maybeStopManagedServiceBeforeMutableUpdate({
        updateInstallKind: mode === "npm" ? "git" : "package",
        root,
        shouldRestart: true,
        jsonMode: true,
      });
      expect(before.stopped).toBe(true);
      const command = await mocks.command(process.env);
      if (!command) {
        throw new Error("missing fixture command");
      }
      if (scenario === "removed pnpm package root") {
        await fs.rm(path.join(root, "package.json"));
        await fs.rm(path.join(root, "dist"), { recursive: true });
      } else if (scenario === "changed original launcher") {
        mocks.command.mockResolvedValue({
          ...command,
          programArguments: [...command.programArguments, "--verbose"],
        });
      }
      if (scenario === "newly sealed definition") {
        mocks.capability.mockResolvedValue({ kind: "sealed", reason: "foreign-owner" });
      } else if (scenario === "unknown definition authority") {
        mocks.capability.mockResolvedValue({ kind: "unknown", reason: "inspection-failed" });
      } else if (scenario === "original sealed definition") {
        mocks.capability.mockResolvedValue({ kind: "writable" });
      }

      const state = await readGatewayServiceState(resolveGatewayService(), {
        env: before.serviceEnv,
        requireEffective: true,
      });
      const pendingVerdict = revalidateManagedGatewayServiceAfterUpdate({
        state,
        root: replacementRoot,
        preManagedServiceStop: before,
        allowInstallRootChange: scenario !== "unrequested root transition",
      });
      if (scenario === "original unresolved launcher") {
        expect(await pendingVerdict).toMatchObject({ kind: "unresolved" });
        expect(mocks.child).not.toHaveBeenCalled();
        return;
      }
      if (!allowed) {
        await expect(pendingVerdict).rejects.toThrow("ownership or manager identity changed");
        expect(mocks.child).not.toHaveBeenCalled();
        return;
      }
      const verdict = await pendingVerdict;
      let servingBuildId = "previous-build";
      if (mode === "git") {
        mocks.health.mockImplementation(async ({ port, expectedBuildId }) => ({
          healthy: mocks.running && (!expectedBuildId || expectedBuildId === servingBuildId),
          staleGatewayPids: [],
          runtime: { status: mocks.running ? "running" : "stopped" },
          portUsage: { port, status: "busy", listeners: [], hints: [] },
        }));
        mocks.script.mockImplementation(async () => {
          mocks.events.push("restart managed service");
          mocks.running = true;
          servingBuildId = "target-build";
        });
      }
      mocks.child.mockImplementation(async (argv) => {
        expect(argv).toContain(replacementEntry);
        if (argv.includes("install")) {
          mocks.events.push("install verified replacement");
          if (scenario === "failed Git refresh retains original launcher") {
            return {
              code: 1,
              stdout: "",
              stderr: "service install failed before writing the definition",
              signal: null,
              killed: false,
              termination: "exit",
            };
          }
          if (scenario !== "same-version stale launcher after refresh") {
            mocks.command.mockResolvedValue({
              ...command,
              programArguments: [process.execPath, replacementEntry, "gateway", "--port", "19305"],
            });
          }
          if (scenario === "Git already serves target build") {
            servingBuildId = "target-build";
          }
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
      const activated = await maybeRestartService({
        shouldRestart: true,
        result: {
          status: "ok",
          mode,
          root: replacementRoot,
          before: { version: VERSION },
          after: { version: VERSION, ...(mode === "git" ? { buildId: "target-build" } : {}) },
          steps: [],
          durationMs: 0,
        },
        channel: mode === "git" ? "dev" : "stable",
        opts: { json: true },
        refreshServiceEnv: true,
        serviceUpdateVerdict: verdict,
        serviceEnv: state.env,
        restartScriptPath: mode === "git" ? path.join(root, "restart-service.sh") : undefined,
        gatewayPort: 19305,
        requireRunningServiceAfterRestart: true,
        timeoutMs: 1000,
      });
      expect(activated).toBe(
        scenario !== "same-version stale launcher after refresh" &&
          scenario !== "failed Git refresh retains original launcher",
      );
      expect(mocks.events).toEqual([
        "native stop",
        "install verified replacement",
        ...(scenario === "Git still serves previous build" ? ["restart managed service"] : []),
      ]);
      if (
        scenario === "Git already serves target build" ||
        scenario === "Git still serves previous build"
      ) {
        expect(mocks.health).toHaveBeenCalledWith(
          expect.objectContaining({ expectedBuildId: "target-build", requireRunningService: true }),
        );
      }
      expect(mocks.child.mock.calls.filter(([argv]) => argv.includes("install"))).toHaveLength(1);
    },
  );
}
