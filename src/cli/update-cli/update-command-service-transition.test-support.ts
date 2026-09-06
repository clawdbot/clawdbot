import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi, type Mock } from "vitest";
import { readGatewayServiceState, resolveGatewayService } from "../../daemon/service.js";
import { defaultRuntime } from "../../runtime.js";
import { VERSION } from "../../version.js";
import { runDaemonRestart } from "../daemon-cli/lifecycle.js";
import * as startRepair from "../daemon-cli/start-repair.js";
import { runUpdatedInstallGatewayCommand } from "./update-command-service-command.js";
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
    configSnapshot: Mock;
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
          return true;
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
      if (scenario === "Git still serves previous build") {
        mocks.configSnapshot.mockResolvedValueOnce(undefined);
      }
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
          scenario !== "failed Git refresh retains original launcher"
          ? "ok"
          : "failed",
      );
      expect(mocks.configSnapshot).toHaveBeenCalledTimes(
        scenario === "Git still serves previous build" ? 1 : 0,
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

export function registerRestartOutcomeTests(
  getFixture: () => {
    root: string;
    mocks: Pick<
      InstallRootTransitionFixture["mocks"],
      "child" | "health" | "configSnapshot" | "capability"
    > & {
      restart: Mock<() => Promise<{ outcome: "completed" }>>;
      writeJson: Mock;
    };
  },
) {
  // Select the restart overload; Vitest otherwise infers the final start overload.
  const restartRepairOwner: {
    repairLoadedGatewayServiceForStart: (
      params: Omit<
        Parameters<typeof startRepair.repairLoadedGatewayServiceForStart>[0],
        "action"
      > & { action: "restart" },
    ) => Promise<{ result: "restarted"; message: string; loaded: boolean }>;
  } = startRepair;
  it.each([
    ["health", "restart-health-failed"],
    ["native refusal", "failed"],
    ["unexpected check", "failed"],
    ["retry refusal", "failed"],
    ["repair health", "failed"],
    ["repair retry health", "restart-health-failed"],
  ])(
    "carries the real lifecycle's serialized %s result through a child process",
    async (scenario, expected) => {
      const { root, mocks } = getFixture();
      const repairing = scenario.startsWith("repair ");
      if (repairing) {
        vi.spyOn(restartRepairOwner, "repairLoadedGatewayServiceForStart").mockResolvedValueOnce({
          result: "restarted",
          message: "Synthetic definition repair completed.",
          loaded: true,
        });
        mocks.configSnapshot.mockResolvedValueOnce(undefined);
        mocks.capability.mockResolvedValue({ kind: "writable" });
      }
      const exit = new Error("test lifecycle exit");
      vi.mocked(defaultRuntime.exit).mockImplementationOnce(() => {
        throw exit;
      });
      if (scenario === "native refusal") {
        mocks.restart.mockRejectedValueOnce(new Error("native owner refused"));
      } else if (scenario === "retry refusal") {
        mocks.restart
          .mockResolvedValueOnce({ outcome: "completed" })
          .mockRejectedValueOnce(new Error("later native refusal"));
      }
      mocks.health.mockResolvedValue({
        healthy: false,
        staleGatewayPids:
          scenario === "retry refusal" || scenario === "repair retry health" ? [4242] : [],
        runtime: { status: "stopped" },
        portUsage: { port: 19305, status: "free", listeners: [], hints: [] },
      });
      if (scenario === "unexpected check") {
        mocks.health.mockRejectedValueOnce(new Error("health observer crashed"));
      }
      const actual =
        await vi.importActual<typeof import("../../process/exec.js")>("../../process/exec.js");
      mocks.child.mockImplementationOnce(async (argv, options) => {
        await expect(
          runDaemonRestart({
            json: true,
            preserveDefinition: argv.includes("--preserve-definition"),
          }),
        ).rejects.toBe(exit);
        expect(mocks.writeJson).toHaveBeenCalledOnce();
        const serialized = JSON.stringify(mocks.writeJson.mock.lastCall?.[0]);
        await fs.writeFile(
          path.join(root, "dist", "index.js"),
          `process.stdout.write(${JSON.stringify(serialized)}); process.exitCode = 1;`,
        );
        return actual.runCommandWithTimeout(argv, options);
      });
      expect(
        await maybeRestartService({
          shouldRestart: true,
          result: { status: "ok", mode: "npm", root, steps: [], durationMs: 0 },
          opts: { json: false },
          refreshServiceEnv: false,
          serviceUpdateVerdict: {
            kind: "owned",
            root,
            refreshDefinition: repairing,
            fingerprint: "fixture",
          },
          serviceEnv: process.env,
          requireRunningServiceAfterRestart: repairing,
          gatewayPort: 19305,
          timeoutMs: 1000,
          nodeRunner: process.execPath,
        }),
      ).toBe(expected);
      expect(mocks.child).toHaveBeenCalledOnce();
    },
  );

  const healthFailure = {
    action: "restart",
    ok: false,
    result: "restart-health-failed",
    error: "Gateway is unhealthy",
  };
  const json = JSON.stringify(healthFailure);
  const success = JSON.stringify({ action: "restart", ok: true, result: "restarted" });
  it.each<{
    scenario: string;
    response?: Partial<
      Awaited<ReturnType<typeof import("../../process/exec.js").runCommandWithTimeout>>
    >;
    action?: "install" | "restart";
  }>([
    { scenario: "health" },
    { scenario: "missing", response: { stdout: "" } },
    { scenario: "malformed", response: { stdout: "{" } },
    { scenario: "mixed", response: { stdout: `log before result\n${json}` } },
    { scenario: "multiple", response: { stdout: `${json}\n${json}` } },
    {
      scenario: "wrong action",
      response: { stdout: JSON.stringify({ ...healthFailure, action: "install" }) },
    },
    {
      scenario: "wrong result",
      response: { stdout: JSON.stringify({ ...healthFailure, result: "unknown" }) },
    },
    { scenario: "wrong ok", response: { stdout: JSON.stringify({ ...healthFailure, ok: true }) } },
    {
      scenario: "missing error",
      response: { stdout: JSON.stringify({ ...healthFailure, error: undefined }) },
    },
    { scenario: "signal", response: { signal: "SIGTERM", termination: "signal" } },
    { scenario: "timeout", response: { termination: "timeout" } },
    { scenario: "truncated", response: { stdoutTruncatedBytes: 1 } },
    { scenario: "killed", response: { killed: true } },
    { scenario: "wrong exit", response: { code: 2 } },
    { scenario: "forced", response: { cleanup: "forced" } },
    { scenario: "uncertain", response: { cleanup: "uncertain" } },
    { scenario: "forced success", response: { cleanup: "forced", code: 0, stdout: success } },
    { scenario: "uncertain success", response: { cleanup: "uncertain", code: 0, stdout: success } },
    { scenario: "install", action: "install" },
  ])(
    "classifies only the complete owned restart health response ($scenario)",
    async ({ scenario, response, action = "restart" }) => {
      const { root, mocks } = getFixture();
      mocks.child.mockResolvedValueOnce({
        code: 1,
        stdout: json,
        stderr: "",
        signal: null,
        killed: false,
        termination: "exit",
        cleanup: "normal",
        ...response,
      });
      await expect(
        runUpdatedInstallGatewayCommand(
          {
            result: { root, mode: "npm" },
            opts: { json: false },
            invocationEnv: process.env,
            nodeRunner: process.execPath,
          },
          action,
          true,
        ),
      ).rejects.toMatchObject({
        name: scenario === "health" ? "GatewayRestartHealthError" : "Error",
      });
      expect(mocks.child.mock.lastCall?.[0]).toContain("--json");
    },
  );
}
