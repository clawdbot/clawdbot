import path from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkerProfile, WorkerProvider } from "openclaw/plugin-sdk/plugin-entry";
import {
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { SpawnResult } from "openclaw/plugin-sdk/process-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, vi } from "vitest";
import { operationLeaseId } from "./crabbox-worker-profile.js";
import { createCrabboxWorkerProvider } from "./crabbox-worker-provider.js";
import type { WarmImageRecord } from "./crabbox-worker-warm-image-store.js";

export const OPERATION_ID = `provision:v2:${"0".repeat(64)}`;
export const LEASE_ID = operationLeaseId(OPERATION_ID);
export const CHECKPOINT_ID = "chk_profile_warm";
export const CLASSLESS_PROFILE = { provider: "aws", ttl: "24h", idleTimeout: "60m" };
export const PROFILE = { ...CLASSLESS_PROFILE, class: "standard", warmImage: true };
const WALLPAPER_PATH = fileURLToPath(
  new URL("../assets/openclaw-worker-wallpaper.png", import.meta.url),
);
export const tempDirs: ReturnType<typeof useAutoCleanupTempDirTracker> =
  useAutoCleanupTempDirTracker(afterEach);
const providers = new Set<ReturnType<typeof createCrabboxWorkerProvider>>();
afterEach(() => {
  for (const provider of providers) {
    provider.dispose();
  }
  providers.clear();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetPluginStateStoreForTests();
});

type CommandRunner = NonNullable<Parameters<typeof createCrabboxWorkerProvider>[0]["runCommand"]>;
export type CommandCall = { argv: string[]; options: Parameters<CommandRunner>[1] };

export function commandResult(overrides: Partial<SpawnResult> = {}): SpawnResult {
  return {
    stdout: "",
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
    termination: "exit",
    ...overrides,
  };
}

export function checkpointResult(
  checkpointId: string,
  leaseId: string,
  nativeState: "pending" | "available",
): SpawnResult {
  return commandResult({
    stdout: JSON.stringify({
      id: checkpointId,
      kind: "aws-ebs-snapshot",
      leaseId,
      workdir: "/workspace",
      native: { imageId: "snap_test", state: nativeState },
    }),
  });
}

export function createWarmProvider(
  command?: (call: CommandCall) => SpawnResult | Promise<SpawnResult | undefined> | undefined,
  stateDir = tempDirs.make("openclaw-crabbox-warm-image-"),
) {
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  const calls: CommandCall[] = [];
  const warn = vi.fn();
  const provider = createCrabboxWorkerProvider({
    openclawRoot: path.resolve(path.sep, "workspace", "openclaw"),
    pathEnv: "",
    isExecutable: () => false,
    wallpaperPath: WALLPAPER_PATH,
    warn,
    sleep: async () => {},
    runCommand: async (argv, options) => {
      const call = { argv, options };
      calls.push(call);
      const override = await command?.(call);
      if (override) {
        return override;
      }
      if (argv[1] === "config") {
        return commandResult({ stdout: JSON.stringify({ aws: { instanceProfile: "" } }) });
      }
      if (argv[1] === "inspect" || argv[1] === "status") {
        return commandResult({
          stdout: JSON.stringify({
            id: argv[argv.indexOf("--id") + 1],
            state: "running",
            ready: true,
            providerMetadata: { instanceProfileAttached: false },
          }),
        });
      }
      if (argv[1] === "checkpoint" && argv[2] === "create") {
        return checkpointResult(CHECKPOINT_ID, argv[argv.indexOf("--id") + 1]!, "pending");
      }
      if (argv[1] === "checkpoint" && argv[2] === "inspect") {
        return commandResult({
          stdout: JSON.stringify({
            localState: "available",
            providerState: "available",
            nextAction: "fork",
          }),
        });
      }
      if (argv[1] === "checkpoint" && argv[2] === "fork") {
        return commandResult({
          stdout: JSON.stringify({
            checkpointId: argv[3],
            leaseId: argv[argv.indexOf("--lease-id") + 1],
            slug: argv[argv.indexOf("--slug") + 1],
            provider: argv[argv.indexOf("--provider") + 1],
            workdir: "/workspace",
          }),
        });
      }
      return commandResult();
    },
  });
  providers.add(provider);
  return { provider, calls, stateDir, warn };
}

export function openWarmImageStore() {
  return createPluginStateSyncKeyedStoreForTests<WarmImageRecord>("crabbox", {
    namespace: "warm-images",
    maxEntries: 128,
    overflowPolicy: "reject-new",
  });
}

export async function provisionWarmProfile(
  provider: WorkerProvider,
  profile: WorkerProfile = PROFILE,
  operationId = OPERATION_ID,
  machineClass?: string,
) {
  return provider.provision(profile, operationId, {
    ...(machineClass ? { machineClass } : {}),
    beginNodeEnrollment: async () => ({
      mode: "connect",
      setupCode: "setup-code",
      setupId: "setup-id",
      openclawVersion: "2026.8.1",
      packageSpecs: ["openclaw@2026.8.1"],
      displayName: "Warm cloud worker",
      waitForDeviceId: async () => "device-1",
    }),
  });
}

export async function captureWarmImage(
  provider: WorkerProvider,
  profile: WorkerProfile = PROFILE,
  operationId = OPERATION_ID,
  machineClass?: string,
) {
  const lease = await provisionWarmProfile(provider, profile, operationId, machineClass);
  await provider.destroy({ leaseId: lease.leaseId, profile });
}
