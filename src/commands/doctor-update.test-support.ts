// Shared fixtures for Doctor update prompts and managed-service recovery.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import type { PreManagedServiceStop } from "../cli/update-cli/update-command-service-maintenance.js";
import { mockSystemAccountHome } from "../daemon/service.test-helpers.js";
import type { UpdateRunResult } from "../infra/update-runner-types.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { maybeOfferUpdateBeforeDoctor } from "./doctor-update.js";

const mocks = vi.hoisted(() => ({
  createUpdateProgress: vi.fn(),
  gitMutationPolicy: vi.fn(),
  maybeRestartServiceAfterFailedMutableUpdate: vi.fn(),
  maybeStopManagedServiceBeforeMutableUpdate: vi.fn(),
  note: vi.fn(),
  readGatewayServiceState: vi.fn(),
  revalidateManagedGatewayServiceAfterUpdate: vi.fn(),
  restartUpdatedGateway: vi.fn(),
  stopGatewayService: vi.fn(),
  waitForHealthyRestart: vi.fn(),
  doctorCommand: vi.fn(),
  createUpdateConfigSnapshot: vi.fn(),
  createServiceConfigIO: vi.fn(),
  resolveGatewayService: vi.fn(),
  runCommandWithTimeout: vi.fn(),
  runGatewayUpdate: vi.fn(),
  triageCommand: vi.fn<typeof import("./triage.js").triageCommand>(),
}));

vi.mock("../cli/update-cli/progress.js", () => ({
  createUpdateProgress: mocks.createUpdateProgress,
}));

vi.mock("../daemon/gateway-entrypoint.js", () => ({
  resolveGatewayInstallEntrypoint: async (root: string) => `${root}/dist/index.js`,
}));
vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: mocks.runCommandWithTimeout,
}));

vi.mock("../infra/update-runner.js", () => ({
  runGatewayUpdate: mocks.runGatewayUpdate,
}));

vi.mock("../config/io.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/io.js")>()),
  createConfigIO: mocks.createServiceConfigIO,
}));

vi.mock("../cli/update-cli/managed-gateway-update.runtime.js", async () => ({
  ...(await vi.importActual<typeof import("../cli/update-cli/update-command-service.js")>(
    "../cli/update-cli/update-command-service.js",
  )),
  maybeRestartServiceAfterFailedMutableUpdate: mocks.maybeRestartServiceAfterFailedMutableUpdate,
  maybeStopManagedServiceBeforeMutableUpdate: mocks.maybeStopManagedServiceBeforeMutableUpdate,
  revalidateManagedGatewayServiceAfterUpdate: mocks.revalidateManagedGatewayServiceAfterUpdate,
}));

vi.mock("./doctor.js", () => ({ doctorCommand: mocks.doctorCommand }));
vi.mock("./triage.js", () => ({ triageCommand: mocks.triageCommand }));
vi.mock("../cli/daemon-cli.js", () => ({
  runDaemonInstall: vi.fn(),
  runDaemonRestart: vi.fn(),
}));
vi.mock("../cli/update-cli/update-command-config-snapshot.js", () => ({
  createUpdateConfigSnapshot: mocks.createUpdateConfigSnapshot,
}));
vi.mock("../cli/daemon-cli/restart-health.js", () => ({
  waitForGatewayHealthyRestart: mocks.waitForHealthyRestart,
  renderRestartDiagnostics: () => ["gateway not ready"],
  terminateStaleGatewayPids: vi.fn(),
}));
vi.mock("../cli/update-cli/update-command-launch-agent-recovery.js", () => ({
  recoverInstalledLaunchAgentAfterUpdate: async () => ({ attempted: false, recovered: false }),
}));

vi.mock("../daemon/service.js", () => ({
  readGatewayServiceState: mocks.readGatewayServiceState,
  resolveGatewayService: mocks.resolveGatewayService,
}));

vi.mock("../../packages/terminal-core/src/note.js", () => ({
  note: mocks.note,
}));

export function createManagedDoctorEnvironment(): NodeJS.ProcessEnv {
  const stateDir = path.join(os.homedir(), ".openclaw-work");
  return {
    OPENCLAW_PROFILE: "work",
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
  };
}

export async function runOffer(params?: {
  root?: string;
  confirm?: (p: { message: string; initialValue: boolean }) => Promise<boolean>;
  runtime?: RuntimeEnv;
}): Promise<Awaited<ReturnType<typeof maybeOfferUpdateBeforeDoctor>>> {
  const confirm = params?.confirm ?? vi.fn().mockResolvedValue(false);
  return await maybeOfferUpdateBeforeDoctor({
    runtime: params?.runtime ?? {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    },
    options: {},
    root: params?.root ?? "/repo/link",
    confirm,
    outro: vi.fn(),
  });
}

export function mockGitCheckout() {
  vi.spyOn(fs, "realpath").mockImplementation(async (candidate) => String(candidate));
  mocks.runCommandWithTimeout.mockImplementation(async (argv, options) => {
    if (argv[2] === "gateway" && argv[3] === "restart") {
      await mocks.restartUpdatedGateway(options.env);
    }
    return {
      stdout: "/repo/link\n",
      stderr: "",
      code: 0,
      killed: false,
      signal: null,
      termination: "exit",
      noOutputTimedOut: false,
    };
  });
}

export function mockManagedService(params: {
  verdict:
    | { kind: "owned"; refreshDefinition: boolean; fingerprint: string }
    | { kind: "unresolved"; fingerprint: string }
    | { kind: "foreign" }
    | { kind: "unavailable"; message: string };
  running?: boolean;
  env?: NodeJS.ProcessEnv;
  stopUnresolved?: boolean;
  autoStartRecovery?: PreManagedServiceStop["windowsTaskAutoStartRecovery"];
}) {
  const running = params.running ?? true;
  const owned = params.verdict.kind === "owned";
  const serviceEnv = params.env ?? createManagedDoctorEnvironment();
  mocks.maybeStopManagedServiceBeforeMutableUpdate.mockImplementation(
    async ({ phase }: { phase: "inspect" | "prepare" }) => {
      const stopped = phase === "prepare" && running && (owned || params.stopUnresolved === true);
      if (stopped) {
        await mocks.stopGatewayService({ env: serviceEnv, stdout: process.stdout });
      }
      return {
        stopped,
        inspected: true,
        runtimeInspected: true,
        running,
        serviceEnv,
        serviceUpdateVerdict: params.verdict,
        ...(phase === "prepare" ? { windowsTaskAutoStartRecovery: params.autoStartRecovery } : {}),
        ...(params.verdict.kind === "unavailable"
          ? { serviceMutationAllowed: false, serviceMutationSkipMessage: params.verdict.message }
          : {}),
      };
    },
  );
}

export function mockUpdateResult(result: Omit<UpdateRunResult, "steps" | "durationMs">) {
  mocks.runGatewayUpdate.mockImplementation(
    async ({ beforeGitMutation }: { beforeGitMutation?: (target: object) => Promise<unknown> }) => {
      mocks.gitMutationPolicy(await beforeGitMutation?.({}));
      return { ...result, steps: [], durationMs: 0 } satisfies UpdateRunResult;
    },
  );
}

export function installDoctorUpdateTestHooks(): void {
  const originalStdinIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const originalStdoutIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const originalServiceRepairPolicy = process.env.OPENCLAW_SERVICE_REPAIR_POLICY;

  beforeEach(async () => {
    mocks.createUpdateProgress.mockReset();
    mocks.createUpdateProgress.mockReturnValue({ progress: {}, stop: vi.fn() });
    mocks.gitMutationPolicy.mockReset();
    mockSystemAccountHome();
    mocks.maybeRestartServiceAfterFailedMutableUpdate.mockReset();
    mocks.maybeStopManagedServiceBeforeMutableUpdate.mockReset();
    mocks.note.mockReset();
    mocks.readGatewayServiceState.mockReset();
    mocks.revalidateManagedGatewayServiceAfterUpdate.mockReset();
    mocks.restartUpdatedGateway.mockReset();
    mocks.stopGatewayService.mockReset();
    mocks.resolveGatewayService.mockReset();
    mocks.runCommandWithTimeout.mockReset();
    mocks.runGatewayUpdate.mockReset();
    mocks.triageCommand.mockReset().mockResolvedValue(undefined);
    mocks.resolveGatewayService.mockReturnValue({
      restart: vi.fn(),
      start: vi.fn(),
      isLoaded: async () => false,
    });
    mocks.readGatewayServiceState.mockResolvedValue({ env: createManagedDoctorEnvironment() });
    mocks.revalidateManagedGatewayServiceAfterUpdate.mockImplementation(
      async ({ preManagedServiceStop }) => preManagedServiceStop.serviceUpdateVerdict,
    );
    mocks.waitForHealthyRestart.mockReset().mockResolvedValue({
      healthy: true,
      runtime: { status: "running" },
      staleGatewayPids: [],
      gatewayVersion: "2026.4.24",
    });
    mocks.doctorCommand.mockReset();
    mocks.createUpdateConfigSnapshot.mockReset().mockResolvedValue(undefined);
    mocks.createServiceConfigIO
      .mockReset()
      .mockReturnValue({ readBestEffortConfig: async () => ({}) });
    vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    mocks.maybeStopManagedServiceBeforeMutableUpdate.mockResolvedValue({
      stopped: false,
      inspected: true,
      runtimeInspected: true,
      running: false,
      serviceUpdateVerdict: { kind: "absent" },
    });
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: true,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    if (originalStdinIsTtyDescriptor) {
      Object.defineProperty(process.stdin, "isTTY", originalStdinIsTtyDescriptor);
    } else {
      delete (process.stdin as Partial<typeof process.stdin>).isTTY;
    }
    if (originalStdoutIsTtyDescriptor) {
      Object.defineProperty(process.stdout, "isTTY", originalStdoutIsTtyDescriptor);
    } else {
      delete (process.stdout as Partial<typeof process.stdout>).isTTY;
    }
    if (originalServiceRepairPolicy === undefined) {
      delete process.env.OPENCLAW_SERVICE_REPAIR_POLICY;
    } else {
      process.env.OPENCLAW_SERVICE_REPAIR_POLICY = originalServiceRepairPolicy;
    }
  });
}

export { mocks };
