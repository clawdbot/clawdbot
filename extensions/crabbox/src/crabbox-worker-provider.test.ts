import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  type WorkerProfile,
  type WorkerProvider,
  WorkerProviderError,
} from "openclaw/plugin-sdk/plugin-entry";
import * as processRuntime from "openclaw/plugin-sdk/process-runtime";
import type { SpawnResult } from "openclaw/plugin-sdk/process-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as doctorRuntime from "./crabbox-worker-doctor-runtime.js";
import {
  findCrabboxBinary,
  operationLeaseId,
  parseCrabboxProfile,
  resolveCrabboxBinary,
} from "./crabbox-worker-profile.js";
import { createCrabboxWorkerProvider, resolveOpenClawRoot } from "./crabbox-worker-provider.js";
import {
  CRABBOX_LIFECYCLE_TIMEOUT_MS,
  CRABBOX_MACHINE_CATALOG_TIMEOUT_MS,
  resolveCrabboxProvisionBaseTimeoutMs,
} from "./crabbox-worker-timeouts.js";

const OPERATION_ID = `provision:v2:${"0".repeat(64)}`;
const LEASE_ID = "cbx_6071fc2062a6";
const HOST_KEY = [["ssh", "ed25519"].join("-"), "AAAA"].join(" ");
const OPENCLAW_ROOT = path.resolve(path.sep, "workspace", "openclaw");
const SIBLING_BINARY = path.resolve(OPENCLAW_ROOT, "../crabbox/bin/crabbox");
const WORKER_WALLPAPER_PATH = fileURLToPath(
  new URL("../assets/openclaw-worker-wallpaper.png", import.meta.url),
);
const INSPECT_FAILURE_PREFIX = "Crabbox inspect failed with exit code 2: ";
// These lifecycle cases opt out of capture; defaults and checkpoints have boundary coverage
// in the warm-image suite and the classless plugin lifecycle cases.
const CLASSLESS_PROFILE = { provider: "aws", ttl: "24h", idleTimeout: "60m" };
const PROFILE = { ...CLASSLESS_PROFILE, class: "standard", warmImage: false };
const NON_RUNNABLE_STATES = [
  "archived",
  "deleted",
  "deleting",
  "destroyed",
  "expired",
  "failed",
  "missing",
  "released",
  "stopped",
  "stopped_with_code",
  "terminated",
];
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());

type CrabboxWorkerProviderDependencies = NonNullable<
  Parameters<typeof createCrabboxWorkerProvider>[0]
>;
type CrabboxCommandRunner = NonNullable<CrabboxWorkerProviderDependencies["runCommand"]>;

function commandResult(overrides: Partial<SpawnResult> = {}): SpawnResult {
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

function classProfile(
  machineClass: string,
  primary: Record<string, unknown> = {},
  selectors: Record<string, unknown> = {},
) {
  return {
    class: machineClass,
    target: "linux",
    architecture: "amd64",
    primary: {
      type: "native-8vcpu-16gb",
      architecture: "amd64",
      vcpu: null,
      memory: null,
      ...primary,
    },
    fallbacks: [],
    ...selectors,
  };
}

function mappedCatalog(profiles: unknown[]) {
  return { disposition: "mapped", profiles };
}

function inspectJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: LEASE_ID,
    providerMetadata: { instanceProfileAttached: false },
    state: "running",
    host: "fallback.example.test",
    sshHost: "worker.example.test",
    sshPort: "2222",
    sshUser: "openclaw",
    sshKey: "/tmp/crabbox-worker-key",
    ready: true,
    ...overrides,
  });
}

function lifecycleLease(leaseId = LEASE_ID, profile: WorkerProfile = PROFILE) {
  return { leaseId, profile };
}

function providerWithRawRunner(
  runCommand: CrabboxCommandRunner,
  warn?: (message: string) => void,
  sleep: (milliseconds: number) => Promise<void> = async () => {},
): WorkerProvider {
  const provider = createCrabboxWorkerProvider({
    runCommand,
    openclawRoot: OPENCLAW_ROOT,
    pathEnv: "",
    isExecutable: (candidate) => candidate === SIBLING_BINARY,
    sleep,
    wallpaperPath: WORKER_WALLPAPER_PATH,
    ...(warn ? { warn } : {}),
  });
  return {
    ...provider,
    provision: (profile, operationId, options) =>
      provider.provision(profile, operationId, {
        ...options,
        beginNodeEnrollment:
          options?.beginNodeEnrollment ??
          (async () => ({
            mode: "connect" as const,
            setupCode: "secret-setup-value",
            setupId: "setup-id",
            openclawVersion: "2026.8.1",
            packageSpecs: ["openclaw@2026.8.1"],
            displayName: "Cloud worker test",
            waitForDeviceId: async () => "device-1",
          })),
      }),
  };
}

function providerWithRunner(
  runCommand: CrabboxCommandRunner,
  warn?: (message: string) => void,
  sleep?: (milliseconds: number) => Promise<void>,
) {
  return providerWithRawRunner(
    async (argv, options) => {
      if (argv[1] === "config" && argv[2] === "show") {
        return commandResult({ stdout: JSON.stringify({ aws: { instanceProfile: "" } }) });
      }
      return runCommand(argv, options);
    },
    warn,
    sleep,
  );
}

function failedNodeEnrollment(
  error: Error,
): NonNullable<Parameters<WorkerProvider["provision"]>[2]> {
  return {
    beginNodeEnrollment: async () => ({
      mode: "connect",
      setupCode: "secret-setup-value",
      setupId: "setup-id",
      openclawVersion: "2026.8.1",
      packageSpecs: ["openclaw@2026.8.1"],
      displayName: "Cloud worker test",
      waitForDeviceId: async () => {
        throw error;
      },
    }),
  };
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
      return true;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

describe("Crabbox worker provider", () => {
  it("reads large machine catalogs while preserving shapes, order, and configured defaults", async () => {
    const calls: string[][] = [];
    const provider = providerWithRunner(async (argv, options) => {
      calls.push(argv);
      return processRuntime.runCommandWithTimeout(
        [process.execPath, "-e", "process.stdin.pipe(process.stdout)"],
        {
          ...options,
          input: JSON.stringify([
            {
              provider: "unrelated",
              classCatalog: { metadata: "x".repeat(65_536) },
            },
            {
              provider: "aws",
              classCatalog: mappedCatalog(
                (
                  [
                    ["tiny", 8],
                    ["small", 16],
                    ["standard", 32],
                    ["fast", 64],
                    ["large", 96],
                    ["beast", 192],
                  ] as const
                ).map(([name, vcpu]) =>
                  classProfile(name, { vcpu, memory: { value: vcpu * 2, unit: "GiB" } }),
                ),
              ),
            },
            { provider: "machine0", classCatalog: { disposition: "unmapped", profiles: [] } },
          ]),
        },
      );
    });
    expect(provider.supportedExecutionModes).toEqual(["worker-turn", "remote-exec"]);
    expect(await provider.listMachineOptions?.(PROFILE)).toEqual([
      { id: "tiny", label: "Tiny", cpu: 8, memoryGb: 16 },
      { id: "small", label: "Small", cpu: 16, memoryGb: 32 },
      {
        id: "standard",
        label: "Standard",
        cpu: 32,
        memoryGb: 64,
        default: true,
      },
      { id: "fast", label: "Fast", cpu: 64, memoryGb: 128 },
      { id: "large", label: "Large", cpu: 96, memoryGb: 192 },
      { id: "beast", label: "Beast", cpu: 192, memoryGb: 384 },
    ]);
    expect(await provider.listMachineOptions?.({ ...PROFILE, class: "c7a.24xlarge" })).toEqual([
      { id: "tiny", label: "Tiny", cpu: 8, memoryGb: 16 },
      { id: "small", label: "Small", cpu: 16, memoryGb: 32 },
      { id: "standard", label: "Standard", cpu: 32, memoryGb: 64 },
      { id: "fast", label: "Fast", cpu: 64, memoryGb: 128 },
      { id: "large", label: "Large", cpu: 96, memoryGb: 192 },
      { id: "beast", label: "Beast", cpu: 192, memoryGb: 384 },
      {
        id: "c7a.24xlarge",
        label: "c7a.24xlarge",
        default: true,
      },
    ]);
    await provider.listMachineOptions?.(PROFILE);
    expect(await provider.listMachineOptions?.({ ...PROFILE, provider: "machine0" })).toEqual([]);
    expect(calls.filter((argv) => argv[1] === "providers")).toHaveLength(1);
  });

  it.each(["unmapped", "unknown", undefined])(
    "requires mapped disposition, ignoring %s catalogs and stray legacy classes",
    async (disposition) => {
      const provider = providerWithRunner(async () =>
        commandResult({
          stdout: JSON.stringify([
            {
              provider: "aws",
              classCatalog: { disposition, profiles: [classProfile("standard")] },
              classes: [{ class: "standard", vcpu: 8, memoryGb: 16 }],
            },
          ]),
        }),
      );
      expect(await provider.listMachineOptions?.({ ...PROFILE, class: "custom" })).toEqual([]);
    },
  );

  it("offers all canonical-only Machine0 classes with their primary resources", async () => {
    const provider = providerWithRunner(async () =>
      commandResult({
        stdout: JSON.stringify([
          {
            provider: "machine0",
            classCatalog: mappedCatalog([
              classProfile("tiny", { type: "large", vcpu: 2, memory: { value: 4, unit: "GB" } }),
              classProfile("small", { type: "xl", vcpu: 4, memory: { value: 8, unit: "GB" } }),
              classProfile("standard", { type: "xxl", vcpu: 8, memory: { value: 16, unit: "GB" } }),
              classProfile("fast", { type: "xxxl", vcpu: 16, memory: { value: 64, unit: "GB" } }),
              classProfile("large", { type: "4xl", vcpu: 32, memory: { value: 128, unit: "GB" } }),
              classProfile("beast", { type: "5xl", vcpu: 48, memory: { value: 192, unit: "GB" } }),
            ]),
          },
        ]),
      }),
    );
    expect(await provider.listMachineOptions?.({ ...PROFILE, provider: "machine0" })).toEqual([
      { id: "tiny", label: "Tiny", cpu: 2, memoryGb: 4 },
      { id: "small", label: "Small", cpu: 4, memoryGb: 8 },
      { id: "standard", label: "Standard", cpu: 8, memoryGb: 16, default: true },
      { id: "fast", label: "Fast", cpu: 16, memoryGb: 64 },
      { id: "large", label: "Large", cpu: 32, memoryGb: 128 },
      { id: "beast", label: "Beast", cpu: 48, memoryGb: 192 },
    ]);
  });

  it.each([
    { backend: "aws", type: "c7a.8xlarge", cpu: 32, memoryGb: 64, unit: "GiB" },
    { backend: "azure", type: "Standard_D32ads_v6", cpu: 32, memoryGb: 128, unit: "GiB" },
    { backend: "gcp", type: "c4-standard-32", cpu: 32, memoryGb: 120, unit: "GB" },
    { backend: "hetzner", type: "ccx33", cpu: 8, memoryGb: 32, unit: "GB" },
    { backend: "namespace-instance", type: "4x8", cpu: 4, memoryGb: 8, unit: "GB" },
    ...(
      [
        ["cloudflare", "standard-4"],
        ["digitalocean", "s-1vcpu-1gb"],
        ["linode", "g6-standard-1"],
        ["namespace-devbox", "S"],
        ["ovh", "b3-8"],
        ["phala", "tdx.small"],
        ["scaleway", "DEV1-S"],
        ["tencentcloud", "SA5.MEDIUM2"],
        ["vultr", "vc2-1c-1gb"],
      ] as const
    ).map(([backend, type]) => ({
      backend,
      type,
      cpu: undefined,
      memoryGb: undefined,
      unit: "GB",
    })),
  ])(
    "uses $backend canonical metadata without inferring native-type dimensions",
    async ({ backend, type, cpu, memoryGb, unit }) => {
      const provider = providerWithRunner(async () =>
        commandResult({
          stdout: JSON.stringify([
            {
              provider: backend,
              classCatalog: mappedCatalog([
                classProfile("standard", {
                  type,
                  vcpu: cpu ?? null,
                  memory: memoryGb ? { value: memoryGb, unit } : null,
                }),
              ]),
            },
          ]),
        }),
      );
      expect(await provider.listMachineOptions?.({ ...PROFILE, provider: backend })).toEqual([
        {
          id: "standard",
          label: "Standard",
          default: true,
          ...(cpu ? { cpu } : {}),
          ...(memoryGb ? { memoryGb } : {}),
        },
      ]);
    },
  );

  it.each([
    { value: 16, unit: "GB", memoryGb: 16 },
    { value: 16, unit: "GiB", memoryGb: 16 },
    { value: 16000, unit: "MB", memoryGb: undefined },
    { value: 16384, unit: "MiB", memoryGb: undefined },
    { value: 15.5, unit: "GB", memoryGb: undefined },
    { value: 0, unit: "GB", memoryGb: undefined },
    { value: 16, unit: "unknown", memoryGb: undefined },
  ])(
    "projects $value $unit using Crabbox's integer GB/GiB summary contract",
    async ({ value, unit, memoryGb }) => {
      const provider = providerWithRunner(async () =>
        commandResult({
          stdout: JSON.stringify([
            {
              provider: "aws",
              classCatalog: mappedCatalog([
                classProfile("standard", { vcpu: 8, memory: { value, unit } }),
              ]),
            },
          ]),
        }),
      );
      expect(await provider.listMachineOptions?.(PROFILE)).toEqual([
        {
          id: "standard",
          label: "Standard",
          cpu: 8,
          default: true,
          ...(memoryGb ? { memoryGb } : {}),
        },
      ]);
    },
  );

  it("preserves advertised order, defaults, and independently optional resources", async () => {
    const provider = providerWithRunner(async () =>
      commandResult({
        stdout: JSON.stringify([
          {
            provider: "aws",
            classCatalog: mappedCatalog([
              classProfile("standard", { vcpu: 128 }, { target: "windows", windowsMode: "normal" }),
              classProfile("standard", { vcpu: 64 }, { architecture: "arm64" }),
              classProfile("memory", { memory: { value: 16, unit: "GB" } }),
              classProfile(
                "standard",
                { vcpu: 8 },
                {
                  fallbacks: [
                    {
                      type: "fallback",
                      architecture: "amd64",
                      vcpu: 32,
                      memory: { value: 64, unit: "GB" },
                    },
                  ],
                },
              ),
              classProfile("unknown"),
              classProfile("standard", { vcpu: 99, memory: { value: 99, unit: "GB" } }),
            ]),
            classes: [{ class: "standard", vcpu: 128, memoryGb: 256 }],
          },
        ]),
      }),
    );
    expect(await provider.listMachineOptions?.(PROFILE)).toEqual([
      { id: "memory", label: "Memory", memoryGb: 16 },
      { id: "standard", label: "Standard", cpu: 8, default: true },
      { id: "unknown", label: "Unknown" },
    ]);
  });

  it.each(["class-00", "custom", undefined])(
    "bounds and filters catalogs with configured class %s",
    async (configuredClass) => {
      const invalidClass = "x".repeat(129);
      const profiles = [
        classProfile(invalidClass),
        ...Array.from({ length: 40 }, (_, index) =>
          classProfile(`class-${String(index).padStart(2, "0")}`, {
            vcpu: index === 0 ? 0 : index + 1,
            memory: { value: index === 0 ? 1.5 : (index + 1) * 2, unit: "GB" },
          }),
        ),
      ];
      const provider = providerWithRunner(async () =>
        commandResult({
          stdout: JSON.stringify([{ provider: "aws", classCatalog: mappedCatalog(profiles) }]),
        }),
      );

      const options = await provider.listMachineOptions?.({
        ...CLASSLESS_PROFILE,
        ...(configuredClass ? { class: configuredClass } : {}),
      });

      expect(options).toHaveLength(32);
      expect(options?.[0]).toEqual({
        id: "class-00",
        label: "Class-00",
        ...(configuredClass === "class-00" ? { default: true } : {}),
      });
      expect(options?.at(-1)).toEqual(
        configuredClass === "custom"
          ? { id: "custom", label: "custom", default: true }
          : { id: "class-31", label: "Class-31", cpu: 32, memoryGb: 64 },
      );
      expect(options?.some((option) => option.id === invalidClass)).toBe(false);
      expect(options?.filter((option) => option.default).map((option) => option.id)).toEqual(
        configuredClass ? [configuredClass] : [],
      );
    },
  );

  it("keeps machine-shape catalogs separate per resolved binary", async () => {
    const calls: { binary: string; argv: string[] }[] = [];
    const provider = providerWithRunner(async (argv) => {
      const binary = String(argv[0]);
      calls.push({ binary, argv });
      const vcpu = binary.endsWith("other-crabbox") ? 8 : 32;
      return commandResult({
        stdout: JSON.stringify([
          {
            provider: "aws",
            classCatalog: mappedCatalog([
              classProfile("standard", { vcpu, memory: { value: vcpu * 2, unit: "GB" } }),
            ]),
          },
        ]),
      });
    });

    const first = await provider.listMachineOptions?.({ ...PROFILE, binary: "/opt/crabbox" });
    const second = await provider.listMachineOptions?.({
      ...PROFILE,
      binary: "/opt/other-crabbox",
    });

    // A shared slot would hand the second profile the first binary's sizes.
    expect(first?.[0]).toMatchObject({ id: "standard", cpu: 32, memoryGb: 64 });
    expect(second?.[0]).toMatchObject({ id: "standard", cpu: 8, memoryGb: 16 });
    expect(calls.filter((call) => call.argv[1] === "providers")).toHaveLength(2);
  });

  it("bounds the catalog read well below the lifecycle timeout", async () => {
    let requestedTimeoutMs: number | undefined;
    const provider = providerWithRunner(async (argv, options) => {
      if (argv[1] === "providers") {
        requestedTimeoutMs = (options as { timeoutMs?: number } | undefined)?.timeoutMs;
        return commandResult({ code: null, killed: true, termination: "timeout" });
      }
      return commandResult({ stdout: "[]" });
    });

    // A hung binary must leave sizing unavailable without holding the picker
    // response for the full lifecycle budget.
    expect(await provider.listMachineOptions?.(PROFILE)).toEqual([]);
    expect(requestedTimeoutMs).toBe(CRABBOX_MACHINE_CATALOG_TIMEOUT_MS);
    expect(requestedTimeoutMs).toBeLessThan(CRABBOX_LIFECYCLE_TIMEOUT_MS);
  });

  it.each([
    {
      name: "throws synchronously",
      result: () => {
        throw new Error("missing binary");
      },
    },
    {
      name: "cannot start",
      result: () => Promise.reject(new Error("missing binary")),
    },
    {
      name: "exits non-zero",
      result: () => Promise.resolve(commandResult({ code: 2 })),
    },
    ...(["timeout", "no-output-timeout", "signal"] as const).map((termination) => ({
      name: `ends with ${termination}`,
      result: () => Promise.resolve(commandResult({ code: null, killed: true, termination })),
    })),
    {
      name: "returns junk JSON",
      result: () => Promise.resolve(commandResult({ stdout: "not-json" })),
    },
    {
      name: "returns a non-array catalog",
      result: () => Promise.resolve(commandResult({ stdout: "{}" })),
    },
  ])("retries discovery after providers $name and caches recovery", async ({ result }) => {
    const warn = vi.fn();
    const runCommand = vi
      .fn<CrabboxCommandRunner>()
      .mockImplementationOnce(result)
      .mockResolvedValue(
        commandResult({
          stdout: JSON.stringify([
            {
              provider: "hetzner",
              classCatalog: mappedCatalog([
                classProfile("tiny", { type: "ccx13", vcpu: 2, memory: { value: 8, unit: "GB" } }),
                classProfile("standard", {
                  type: "ccx33",
                  vcpu: 8,
                  memory: { value: 32, unit: "GB" },
                }),
              ]),
            },
          ]),
        }),
      );
    const provider = providerWithRawRunner(runCommand, warn);
    const profile = { ...PROFILE, provider: "hetzner" };

    expect(await provider.listMachineOptions?.(profile)).toEqual([]);
    expect(runCommand).toHaveBeenCalledTimes(1);
    const recovered = await provider.listMachineOptions?.(profile);
    expect(recovered).toEqual([
      { id: "tiny", label: "Tiny", cpu: 2, memoryGb: 8 },
      { id: "standard", label: "Standard", cpu: 8, memoryGb: 32, default: true },
    ]);
    expect(await provider.listMachineOptions?.(profile)).toEqual(recovered);
    expect(runCommand).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("coalesces overlapping catalog reads before and after a failed load", async () => {
    const failed = createDeferred<SpawnResult>();
    const healthy = createDeferred<SpawnResult>();
    const runCommand = vi
      .fn<CrabboxCommandRunner>()
      .mockReturnValueOnce(failed.promise)
      .mockReturnValue(healthy.promise);
    const warn = vi.fn();
    const provider = providerWithRawRunner(runCommand, warn);
    const first = provider.listMachineOptions?.(PROFILE);
    const second = provider.listMachineOptions?.(PROFILE);
    expect(runCommand).toHaveBeenCalledTimes(1);

    failed.resolve(commandResult({ code: 2 }));
    expect(await first).toEqual([]);
    const retry = provider.listMachineOptions?.(PROFILE);
    expect(await second).toEqual([]);
    const concurrentRetry = provider.listMachineOptions?.(PROFILE);
    expect(runCommand).toHaveBeenCalledTimes(2);
    healthy.resolve(
      commandResult({
        stdout: JSON.stringify([
          {
            provider: "aws",
            classCatalog: mappedCatalog([
              classProfile("standard", { vcpu: 32, memory: { value: 64, unit: "GB" } }),
            ]),
          },
        ]),
      }),
    );
    const expected = [{ id: "standard", label: "Standard", cpu: 32, memoryGb: 64, default: true }];
    expect(await retry).toEqual(expected);
    expect(await concurrentRetry).toEqual(expected);
    expect(await provider.listMachineOptions?.(PROFILE)).toEqual(expected);
    expect(runCommand).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls).toEqual([
      ["Crabbox machine shapes unavailable: Crabbox providers command failed (exit, code 2)"],
    ]);
  });

  it.each([
    {
      name: "returns an empty catalog",
      result: () => Promise.resolve(commandResult({ stdout: "[]" })),
    },
    {
      name: "omits the catalog",
      result: () =>
        Promise.resolve(commandResult({ stdout: JSON.stringify([{ provider: "aws" }]) })),
    },
    ...[
      { name: "returns empty profiles", metadata: { classCatalog: mappedCatalog([]) } },
      {
        name: "returns unusable profiles",
        metadata: {
          classCatalog: mappedCatalog([null, {}, classProfile(" "), classProfile("x".repeat(129))]),
        },
      },
      {
        name: "reports only legacy classes",
        metadata: { classes: [{ class: "standard", vcpu: 8, memoryGb: 16 }] },
      },
      {
        name: "omits mapped profiles",
        metadata: { classCatalog: { disposition: "mapped" } },
      },
      {
        name: "reports only non-default selectors",
        metadata: {
          classCatalog: mappedCatalog([
            classProfile("standard", { vcpu: 32 }, { target: "windows", windowsMode: "wsl2" }),
            classProfile("standard", { vcpu: 64 }, { architecture: "arm64" }),
            classProfile("standard", { vcpu: 96 }, { architecture: "mixed" }),
          ]),
        },
      },
    ].map(({ name, metadata }) => ({
      name,
      result: () =>
        Promise.resolve(
          commandResult({ stdout: JSON.stringify([{ provider: "aws", ...metadata }]) }),
        ),
    })),
    {
      name: "reports another provider",
      result: () =>
        Promise.resolve(
          commandResult({
            stdout: JSON.stringify([
              {
                provider: "gcp",
                classCatalog: mappedCatalog([classProfile("standard", { vcpu: 32 })]),
              },
            ]),
          }),
        ),
    },
  ])("caches no machine override when providers $name", async ({ result }) => {
    const warn = vi.fn();
    const runCommand = vi.fn(result);
    const provider = providerWithRunner(runCommand, warn);

    expect(await provider.listMachineOptions?.(PROFILE)).toEqual([]);
    expect(await provider.listMachineOptions?.(PROFILE)).toEqual([]);
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "non-PNG bytes",
      bytes: Buffer.from("not a PNG"),
      message: "Crabbox worker wallpaper is not a PNG",
    },
    {
      name: "wrong PNG dimensions",
      bytes: (() => {
        const bytes = fs.readFileSync(WORKER_WALLPAPER_PATH);
        bytes.writeUInt32BE(1023, 16);
        return bytes;
      })(),
      message: "Crabbox worker wallpaper must be 1024x576; got 1023x576",
    },
  ])("rejects $name during provider registration", ({ bytes, message }) => {
    const tempDir = tempDirs.make("openclaw-crabbox-wallpaper-");
    const wallpaperPath = path.join(tempDir, "wallpaper.png");
    fs.writeFileSync(wallpaperPath, bytes);
    expect(() => createCrabboxWorkerProvider({ wallpaperPath })).toThrow(message);
  });

  it.each([
    { name: "the direct-environment default", executionMode: undefined },
    { name: "an OpenClaw worker turn", executionMode: "worker-turn" },
    { name: "a Codex remote-exec turn", executionMode: "remote-exec" },
  ] as const)("returns the same enrolled node transport for $name", async ({ executionMode }) => {
    const calls: Array<{ argv: string[]; options: Parameters<CrabboxCommandRunner>[1] }> = [];
    let warmed = false;
    const provider = providerWithRunner(async (argv, options) => {
      calls.push({ argv, options });
      if (argv[1] === "warmup") {
        warmed = true;
        return commandResult({ stdout: `leased ${LEASE_ID} slug=test\n` });
      }
      if (argv.includes(LEASE_ID)) {
        return commandResult({
          stdout: inspectJson({ sshFallbackPorts: [22], sshHostKey: HOST_KEY }),
        });
      }
      return warmed
        ? commandResult({
            stdout: inspectJson({ sshFallbackPorts: [22], sshHostKey: HOST_KEY }),
          })
        : commandResult({ code: 4, stderr: `lease/server not found: ${argv.at(-2)}` });
    });

    const provision =
      executionMode === undefined
        ? provider.provision(PROFILE, OPERATION_ID)
        : provider.provision(PROFILE, OPERATION_ID, { executionMode });
    await expect(provision).resolves.toEqual({
      leaseId: LEASE_ID,
      node: { deviceId: "device-1" },
      sharedHost: false,
    });

    const enrollmentCall = calls.find(
      (call) => call.argv[1] === "run" && String(call.options.input).includes("--ephemeral"),
    );
    expect(enrollmentCall).toBeDefined();
    const setup = String(enrollmentCall?.options.input);
    const setupCodeCleared = "unset CRABBOX_WORKER_SETUP_CODE";
    expect(setup).toContain(setupCodeCleared);
    expect(setup.indexOf(setupCodeCleared)).toBeGreaterThan(setup.indexOf('>"$setup_code_file"'));
    expect(setup.indexOf(setupCodeCleared)).toBeLessThan(setup.indexOf("setsid -f sh -c"));
    if (executionMode === "remote-exec") {
      expect(setup).toContain("plugins inspect codex --json");
      expect(setup).toContain('require("node:child_process").spawnSync');
      expect(setup).toContain('[launcher,"--version"]');
      expect(setup).toContain("codex-cli ${runtime.version}");
      expect(setup).not.toContain("$state_dir/extensions/codex");
      expect(setup).toContain("set -- openclaw");
      expect(setup).toContain('set -- npx --yes --package "$package_spec" -- openclaw');
      expect(setup).toContain('OPENCLAW_STATE_DIR="$state_dir" "$@" plugins enable codex');
      expect(setup.match(/plugins inspect codex --json/g)).toHaveLength(1);
      expect(setup.match(/setsid -f sh -c/g)).toHaveLength(1);
      expect(setup.indexOf("plugins inspect codex --json")).toBeGreaterThan(
        setup.indexOf(setupCodeCleared),
      );
      expect(setup.indexOf("plugins enable codex")).toBeLessThan(
        setup.lastIndexOf("setsid -f sh -c"),
      );
    } else {
      expect(setup).not.toContain("plugins inspect codex");
    }
    expect(setup).not.toContain("plugins install");
    expect(setup).not.toContain("npm:@openclaw/codex");
    expect(setup).toContain("connect --target-file");
    expect(setup).toContain("--ephemeral");
    expect(setup).not.toContain("secret-setup-value");
    const commandArguments = calls.flatMap((call) => call.argv);
    for (const forbiddenArgument of ["remote-exec", "worker-turn", "ssh", "scp", "rsync"]) {
      expect(commandArguments).not.toContain(forbiddenArgument);
    }
  });

  it("rejects an unsupported execution mode before invoking Crabbox", async () => {
    const calls: string[][] = [];
    const provider = providerWithRunner(async (argv) => {
      calls.push(argv);
      return commandResult();
    });

    await expect(
      provider.provision(PROFILE, OPERATION_ID, { executionMode: "unsupported" as never }),
    ).rejects.toMatchObject({
      name: "WorkerProviderError",
      message: "Crabbox execution mode is unsupported",
    });
    expect(calls).toEqual([]);
  });

  it("resumes a bound node without replaying the consumed setup code", async () => {
    const calls: Array<{ argv: string[]; options: Parameters<CrabboxCommandRunner>[1] }> = [];
    const provider = providerWithRunner(async (argv, options) => {
      calls.push({ argv, options });
      return argv[1] === "inspect"
        ? commandResult({ stdout: inspectJson({ sshHostKey: HOST_KEY }) })
        : commandResult();
    });

    await expect(
      provider.provision({ ...PROFILE, desktop: true }, OPERATION_ID, {
        beginNodeEnrollment: async () => ({
          mode: "resume",
          deviceId: "device-bound",
          openclawVersion: "2026.8.1",
          packageSpecs: ["openclaw@2026.8.1"],
          displayName: "Bound worker",
          waitForDeviceId: async () => "device-bound",
        }),
      }),
    ).resolves.toMatchObject({
      node: { deviceId: "device-bound" },
      desktop: {
        protocol: "rfb",
        port: 5900,
        apps: [{ id: "browser" }, { id: "terminal" }],
      },
    });
    const desktopSetup = calls.find(
      (call) =>
        call.argv[1] === "run" && String(call.options.input).includes("openclaw-worker-browser"),
    )?.options.input;
    const desktopSetupText = String(desktopSetup);
    expect(desktopSetupText).toContain("worker_user=$(id -un)");
    expect(desktopSetupText).toContain('worker_home=$(getent passwd "$worker_uid"');
    expect(desktopSetupText).toContain(`worker-browser/${LEASE_ID}`);
    const desktopSetupLines = desktopSetupText.split("\n");
    for (const expectedLine of [
      '[ -r /var/lib/crabbox/desktop.env ] || { echo "Crabbox desktop environment is unavailable" >&2; exit 1; }',
      "grep -Fx 'CRABBOX_DESKTOP_ENV=xfce' /var/lib/crabbox/desktop.env >/dev/null || { echo \"Crabbox desktop environment is not XFCE\" >&2; exit 1; }",
      "grep -Fx 'DISPLAY=:99' /var/lib/crabbox/desktop.env >/dev/null || { echo \"Crabbox XFCE display is not :99\" >&2; exit 1; }",
      "export DISPLAY=:99",
    ]) {
      expect(desktopSetupLines.filter((line) => line === expectedLine)).toHaveLength(3);
    }
    expect(desktopSetupText).not.toContain(". /var/lib/crabbox/desktop.env");
    expect(desktopSetupText).not.toContain("/var/lib/crabbox/browser.env");
    expect(desktopSetupLines).not.toContain("export DISPLAY");
    expect(desktopSetupText).toContain(
      'mapfile -t session_pids < <(pgrep -u "$worker_uid" -x xfce4-session || true)',
    );
    expect(desktopSetupText).toContain("Expected exactly one worker-owned XFCE session");
    expect(desktopSetupText).toContain('session_pid="${session_pids[0]}"');
    expect(desktopSetupText).toContain('read_xfce_process_environment "$session_pid"');
    expect(desktopSetupText).toContain(
      'mapfile -t renderer_pids < <(pgrep -u "$worker_uid" -x xfdesktop || true)',
    );
    expect(desktopSetupText).toContain('renderer_pid="${renderer_pids[0]}"');
    expect(desktopSetupText).toContain('read_xfce_process_environment "$renderer_pid"');
    expect(desktopSetupText).toContain('exec 8<"/proc/$process_pid/environ"');
    for (const [name, target] of [
      ["DISPLAY", "process_display"],
      ["DBUS_SESSION_BUS_ADDRESS", "process_dbus"],
      ["XDG_RUNTIME_DIR", "process_runtime_dir"],
    ]) {
      expect(desktopSetupText).toContain(`${name}=*) ${target}="\${process_variable#*=}"`);
    }
    expect(desktopSetupText).toContain('[ "$process_display" = ":99" ]');
    expect(desktopSetupText).toContain('DBUS_SESSION_BUS_ADDRESS="$process_dbus"');
    expect(desktopSetupLines).toContain("unset XDG_RUNTIME_DIR");
    expect(desktopSetupText).toContain('XDG_RUNTIME_DIR="$process_runtime_dir"');
    expect(desktopSetupText).toContain('[ -n "$DBUS_SESSION_BUS_ADDRESS" ]');
    expect(desktopSetupText).not.toContain("SESSION_MANAGER");
    expect(desktopSetupText).toContain(
      '[ "$process_display" = "$DISPLAY" ] && [ "$process_dbus" = "$DBUS_SESSION_BUS_ADDRESS" ]',
    );
    expect(desktopSetupText).toContain(
      'case "$XDG_RUNTIME_DIR" in ""|/*) ;; *) echo "XFCE session has an invalid XDG_RUNTIME_DIR"',
    );
    expect(desktopSetupText).toContain("export DBUS_SESSION_BUS_ADDRESS");
    expect(desktopSetupText).toContain('[ -z "$XDG_RUNTIME_DIR" ] || export XDG_RUNTIME_DIR');
    for (const signal of ["TERM", "KILL"]) {
      expect(desktopSetupText).toContain(`pkill -${signal} -u "$worker_uid" -x xfdesktop || true`);
    }
    expect(desktopSetupText).toContain('pgrep -u "$worker_uid" -x xfdesktop >/dev/null || break');
    expect(desktopSetupText).toContain(
      'nohup xfdesktop >"$worker_home/.cache/openclaw/xfdesktop.log" 2>&1 </dev/null &',
    );
    expect(desktopSetupText).toMatch(
      /for _attempt in \$\(seq 1 \d+\); do bind_xfdesktop_renderer && break; sleep 0\.1; done/u,
    );
    expect(desktopSetupText).toContain(
      "XFCE desktop renderer did not converge on the worker session",
    );
    expect(desktopSetupText).not.toMatch(/(?:^|\n)\s*(?:\.|source)\s+[^\n]*\/proc\//u);
    expect(desktopSetupText).not.toMatch(/(?:^|\n)\s*eval(?:\s|$)/u);
    expect(desktopSetupText).not.toMatch(/(?:^|\n)\s*(?:\.|source)\s+[^\n]*\.env/u);
    expect(desktopSetupText).toContain(
      "nohup /usr/local/bin/crabbox-browser --remote-debugging-address=127.0.0.1",
    );
    expect(desktopSetupText).toMatch(/for required_command in [^\n;]*python3[^\n;]*; do/u);
    expect(desktopSetupText).toContain(
      "base64.b64decode(sys.stdin.buffer.read().strip(),validate=True)",
    );
    const wallpaperPayload =
      /<<'WORKER_WALLPAPER_B64_EOF'\n(?<payload>[A-Za-z0-9+/=]+)\nWORKER_WALLPAPER_B64_EOF/u.exec(
        desktopSetupText,
      )?.groups?.payload;
    expect(wallpaperPayload).toBeDefined();
    expect(
      Buffer.from(wallpaperPayload ?? "", "base64").equals(fs.readFileSync(WORKER_WALLPAPER_PATH)),
    ).toBe(true);
    expect(desktopSetupText).toContain("xrandr --listmonitors");
    expect(desktopSetupText).toContain('printf "/backdrop/screen0/monitor%s/workspace%s');
    expect(desktopSetupText).toContain(
      'wallpaper_path="$worker_home/.local/share/backgrounds/openclaw-worker.png"',
    );
    expect(desktopSetupText).toContain('for backdrop in "${backdrop_roots[@]}"; do');
    const sessionExportIndex = desktopSetupText.indexOf("export DBUS_SESSION_BUS_ADDRESS");
    const sessionExtractionIndex = desktopSetupText.indexOf(
      'read_xfce_process_environment "$session_pid"',
    );
    const terminateRendererIndex = desktopSetupText.indexOf(
      'pkill -TERM -u "$worker_uid" -x xfdesktop',
    );
    const killRendererIndex = desktopSetupText.indexOf('pkill -KILL -u "$worker_uid" -x xfdesktop');
    const launchRendererIndex = desktopSetupText.indexOf("nohup xfdesktop");
    const convergeRendererIndex = desktopSetupText.indexOf(
      'bind_xfdesktop_renderer || { echo "XFCE desktop renderer did not converge',
    );
    const firstXfconfIndex = desktopSetupText.indexOf("xfconf-query -c xfce4-desktop");
    const xrandrIndex = desktopSetupText.indexOf("xrandr --listmonitors");
    const lastImageIndex = desktopSetupText.indexOf('-p "$backdrop/last-image"');
    const saveRendererIndex = desktopSetupText.indexOf(
      'renderer_pid_before_reload="$renderer_pid"',
    );
    const reloadRendererIndex = desktopSetupText.indexOf("xfdesktop --reload");
    const verifyRendererIndex = desktopSetupText.indexOf(
      '[ "$renderer_pid" = "$renderer_pid_before_reload" ]',
    );
    expect(sessionExtractionIndex).toBeGreaterThan(-1);
    expect(sessionExportIndex).toBeGreaterThan(sessionExtractionIndex);
    expect(terminateRendererIndex).toBeGreaterThan(sessionExportIndex);
    expect(killRendererIndex).toBeGreaterThan(terminateRendererIndex);
    expect(launchRendererIndex).toBeGreaterThan(killRendererIndex);
    expect(convergeRendererIndex).toBeGreaterThan(launchRendererIndex);
    expect(firstXfconfIndex).toBeGreaterThan(convergeRendererIndex);
    expect(xrandrIndex).toBeGreaterThan(sessionExportIndex);
    expect(lastImageIndex).toBeGreaterThan(-1);
    expect(saveRendererIndex).toBeGreaterThan(lastImageIndex);
    expect(reloadRendererIndex).toBeGreaterThan(saveRendererIndex);
    expect(verifyRendererIndex).toBeGreaterThan(reloadRendererIndex);
    expect(desktopSetupText.slice(reloadRendererIndex, verifyRendererIndex)).toContain(
      "bind_xfdesktop_renderer",
    );
    expect(desktopSetupText).not.toMatch(/pkill -(?:TERM|KILL) -x xfdesktop/u);
    const setup = calls.find(
      (call) => call.argv[1] === "run" && String(call.options.input).includes("node run"),
    )?.options.input;
    expect(String(setup)).toContain("node run --ephemeral --display-name 'Bound worker'");
    expect(String(setup)).not.toContain("config set nodeHost.workerRuns.enabled");
    expect(String(setup)).not.toContain("setup-code");
    expect(calls.flatMap((call) => call.argv)).not.toContain("ssh");
    expect(calls.flatMap((call) => call.argv)).not.toContain("scp");
    expect(calls.flatMap((call) => call.argv)).not.toContain("rsync");
  });

  it.each([
    { name: "without forwarded environment", setupEnv: undefined, forwardedEnv: undefined },
    {
      name: "with only explicitly forwarded Gateway environment",
      setupEnv: ["OPENCLAW_WORKER_ARTIFACT_TOKEN", "CRABBOX_EMPTY_VALUE"],
      forwardedEnv: {
        OPENCLAW_WORKER_ARTIFACT_TOKEN: "fixture artifact #tag \"quoted\" \\path 'single'",
        CRABBOX_EMPTY_VALUE: "",
      },
    },
  ])(
    "runs profile setup $name without widening node enrollment",
    async ({ setupEnv, forwardedEnv }) => {
      vi.stubEnv("CRABBOX_ENV_ALLOW", "OPENCLAW_UNSELECTED_SECRET");
      vi.stubEnv("OPENCLAW_UNSELECTED_SECRET", "unselected-secret");
      for (const [name, value] of Object.entries(forwardedEnv ?? {})) {
        vi.stubEnv(name, value);
      }
      const calls: Array<{ argv: string[]; options: Parameters<CrabboxCommandRunner>[1] }> = [];
      const profileObservations = new Map<
        string,
        { directoryMode: number; fileMode: number; valuesMatch: boolean }
      >();
      const setup = "command -v node || install-node";
      let warmed = false;
      const provider = providerWithRunner(async (argv, options) => {
        calls.push({ argv, options });
        if (argv[1] === "warmup") {
          warmed = true;
          return commandResult({ stdout: `leased ${LEASE_ID} slug=test\n` });
        }
        if (argv[1] === "run") {
          const expectedEnv =
            options.input === setup
              ? forwardedEnv
              : { CRABBOX_WORKER_SETUP_CODE: "secret-setup-value" };
          const profileFlagIndex = argv.indexOf("--env-from-profile");
          const profilePath = profileFlagIndex < 0 ? undefined : argv[profileFlagIndex + 1];
          if (expectedEnv && profilePath) {
            const lines = fs.readFileSync(profilePath, "utf8").split("\n");
            profileObservations.set(profilePath, {
              directoryMode: fs.statSync(path.dirname(profilePath)).mode & 0o777,
              fileMode: fs.statSync(profilePath).mode & 0o777,
              valuesMatch: Object.entries(expectedEnv).every(([name, value]) =>
                lines.includes(
                  `${name}="${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`,
                ),
              ),
            });
          }
          return commandResult();
        }
        return warmed || argv.includes(LEASE_ID)
          ? commandResult({ stdout: inspectJson({ sshHostKey: HOST_KEY }) })
          : commandResult({ code: 4, stderr: `lease/server not found: ${argv.at(-2)}` });
      });

      const profile = { ...PROFILE, setup, ...(setupEnv ? { setupEnv } : {}) };
      await expect(provider.provision(profile, OPERATION_ID)).resolves.toMatchObject({
        leaseId: LEASE_ID,
      });
      const [setupCall, enrollmentCall] = calls.filter((call) => call.argv[1] === "run");
      for (const [call, expectedEnv] of [
        [setupCall, forwardedEnv],
        [enrollmentCall, { CRABBOX_WORKER_SETUP_CODE: "secret-setup-value" }],
      ] as const) {
        expect(call).toBeDefined();
        if (!call) {
          continue;
        }
        const profileFlagIndex = call.argv.indexOf("--env-from-profile");
        if (expectedEnv) {
          expect(profileFlagIndex).toBeGreaterThanOrEqual(0);
          const profilePath = call.argv[profileFlagIndex + 1];
          expect(profilePath).toBeDefined();
          if (!profilePath) {
            continue;
          }
          expect(profileObservations.get(profilePath)).toEqual({
            directoryMode: 0o700,
            fileMode: 0o600,
            valuesMatch: true,
          });
          expect(fs.existsSync(profilePath)).toBe(false);
          expect(fs.existsSync(path.dirname(profilePath))).toBe(false);
          for (const value of Object.values(expectedEnv).filter(Boolean)) {
            expect(call.argv.some((argument) => argument.includes(value))).toBe(false);
            expect(Object.values(call.options.env ?? {}).includes(value)).toBe(false);
          }
        } else {
          expect(profileFlagIndex).toBe(-1);
        }
        expect(
          call.argv.filter((argument, index, argv) => argv[index - 1] === "--allow-env"),
        ).toEqual(Object.keys(expectedEnv ?? {}));
        for (const name of Object.keys(expectedEnv ?? {})) {
          expect(Object.hasOwn(call.options.env ?? {}, name)).toBe(true);
          expect(call.options.env?.[name]).toBeUndefined();
        }
        expect(call.options.env).toStrictEqual({
          ...Object.fromEntries(Object.keys(expectedEnv ?? {}).map((name) => [name, undefined])),
          CRABBOX_ENV_ALLOW: ",",
        });
      }
      expect(setupCall?.argv.slice(1)).toEqual([
        "run",
        "--provider",
        "aws",
        "--network",
        "public",
        "--tailscale=false",
        "--id",
        LEASE_ID,
        "--keep=true",
        "--no-sync",
        ...Object.keys(forwardedEnv ?? {}).flatMap((name) => ["--allow-env", name]),
        ...(forwardedEnv
          ? [
              "--env-from-profile",
              setupCall?.argv[setupCall.argv.indexOf("--env-from-profile") + 1],
            ]
          : []),
        "--script-stdin",
      ]);
      expect(setupCall?.options.input).toBe(setup);
      expect(
        calls.filter((call) => call.argv[1] !== "run").every((call) => !call.options.env),
      ).toBe(true);
    },
  );

  it("rejects a missing profile setup environment variable before invoking Crabbox", async () => {
    const missingName = "OPENCLAW_MISSING_WORKER_ARTIFACT_TOKEN";
    vi.stubEnv(missingName, undefined);
    const runCommand = vi.fn<CrabboxCommandRunner>();
    const provider = providerWithRawRunner(runCommand);

    await expect(
      provider.provision(
        { ...PROFILE, setup: "install-node", setupEnv: [missingName] },
        OPERATION_ID,
      ),
    ).rejects.toMatchObject({
      code: "invalid_profile",
      message: expect.stringContaining(missingName),
    });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it.each([
    { name: "a newline", value: "fixture\nvalue" },
    { name: "a carriage return", value: "fixture\rvalue" },
    { name: "a backtick", value: "fixture`value" },
    { name: "command substitution", value: "fixture$(value)" },
  ])(
    "rejects profile setup environment containing $name without exposing its value",
    async ({ value }) => {
      const envName = "OPENCLAW_WORKER_ARTIFACT_TOKEN";
      vi.stubEnv(envName, value);
      const calls: string[][] = [];
      const provider = providerWithRunner(async (argv) => {
        calls.push(argv);
        return argv[1] === "inspect"
          ? commandResult({ stdout: inspectJson({ sshHostKey: HOST_KEY }) })
          : commandResult();
      });

      const error = await provider
        .provision({ ...PROFILE, setup: "install-node", setupEnv: [envName] }, OPERATION_ID)
        .catch((cause: unknown) => cause);

      expect(error).toMatchObject({
        code: "invalid_profile",
        message: `Crabbox setup environment value cannot be represented safely: ${envName}`,
      });
      expect(error instanceof Error && error.message.includes(value)).toBe(false);
      expect(calls.map((argv) => argv[1])).toEqual(["warmup", "inspect", "stop"]);
    },
  );

  it("waits for post-setup SSH readiness and returns the final endpoint", async () => {
    const calls: string[][] = [];
    let leaseInspections = 0;
    let resolveFinalInspect!: (result: SpawnResult) => void;
    let markFinalInspectStarted!: () => void;
    const finalInspect = new Promise<SpawnResult>((resolve) => {
      resolveFinalInspect = resolve;
    });
    const finalInspectStarted = new Promise<void>((resolve) => {
      markFinalInspectStarted = resolve;
    });
    const provider = providerWithRunner(async (argv) => {
      calls.push(argv);
      if (argv[1] === "warmup") {
        return commandResult();
      }
      if (argv[1] === "run") {
        return commandResult();
      }
      leaseInspections += 1;
      if (leaseInspections === 1) {
        return commandResult({
          stdout: inspectJson({
            sshFallbackPorts: [22],
            sshHost: "before-setup.example.test",
            sshHostKey: HOST_KEY,
          }),
        });
      }
      if (leaseInspections === 2) {
        return commandResult({
          stdout: inspectJson({
            ready: false,
            sshFallbackPorts: [22],
            sshHost: "restarting.example.test",
            sshHostKey: HOST_KEY,
          }),
        });
      }
      markFinalInspectStarted();
      return await finalInspect;
    });

    const provision = provider.provision({ ...PROFILE, setup: "install-node" }, OPERATION_ID);
    let settled = false;
    void provision.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await finalInspectStarted;
    expect(settled).toBe(false);
    resolveFinalInspect(
      commandResult({
        stdout: inspectJson({
          sshFallbackPorts: [22, 2222],
          sshHost: "after-setup.example.test",
          sshHostKey: "ssh-ed25519 BBBB",
          sshPort: "2200",
        }),
      }),
    );

    await expect(provision).resolves.toMatchObject({
      leaseId: LEASE_ID,
      node: { deviceId: "device-1" },
      sharedHost: false,
    });
    expect(calls.map((argv) => argv[1])).toEqual([
      "warmup",
      "inspect",
      "run",
      "inspect",
      "inspect",
      "run",
      "inspect",
    ]);
  });

  it("leaves a lease live when it disappears from post-setup inspection", async () => {
    const calls: string[][] = [];
    let inspections = 0;
    const provider = providerWithRunner(async (argv) => {
      calls.push(argv);
      if (argv[1] === "warmup") {
        return commandResult();
      }
      if (argv[1] === "run" || argv[1] === "stop") {
        return commandResult();
      }
      inspections += 1;
      return inspections === 1
        ? commandResult({ stdout: inspectJson({ sshHostKey: HOST_KEY }) })
        : commandResult({ code: 4, stderr: `lease/server not found: ${LEASE_ID}` });
    });

    await expect(
      provider.provision({ ...PROFILE, setup: "install-node" }, OPERATION_ID),
    ).rejects.toThrow("disappeared while waiting for SSH readiness");
    expect(calls.map((argv) => argv[1])).toEqual(["warmup", "inspect", "run", "inspect"]);
  });

  it("re-attests security on the fresh post-setup inspect before polling", async () => {
    const calls: string[][] = [];
    let inspections = 0;
    const provider = providerWithRunner(async (argv) => {
      calls.push(argv);
      if (argv[1] === "warmup") {
        return commandResult();
      }
      if (argv[1] === "run" || argv[1] === "stop") {
        return commandResult();
      }
      inspections += 1;
      return commandResult({
        stdout: inspectJson({
          providerMetadata: { instanceProfileAttached: inspections > 1 },
          ready: inspections === 1,
          sshHostKey: HOST_KEY,
        }),
      });
    });

    await expect(
      provider.provision({ ...PROFILE, setup: "install-node" }, OPERATION_ID),
    ).rejects.toMatchObject({
      code: "invalid_profile",
      message: "Crabbox AWS inspect must attest that no instance profile is attached",
    });
    expect(calls.map((argv) => argv[1])).toEqual(["warmup", "inspect", "run", "inspect", "stop"]);
  });

  it.each([
    {
      name: "fails",
      result: commandResult({ code: 7, stderr: "apt exploded" }),
      message: "Crabbox profile setup failed with exit code 7",
    },
    {
      name: "times out",
      result: commandResult({ code: null, killed: true, termination: "timeout" }),
      message: "Crabbox profile setup did not exit normally (timeout)",
    },
    {
      name: "cannot start",
      result: undefined,
      message: "Crabbox profile setup could not start",
    },
  ])(
    "stops the lease and removes its private env profile when setup $name",
    async ({ result, message }) => {
      const envName = "OPENCLAW_WORKER_ARTIFACT_TOKEN";
      vi.stubEnv(envName, "fixture-artifact-token");
      const calls: string[][] = [];
      let profilePath: string | undefined;
      let warmed = false;
      const provider = providerWithRunner(async (argv) => {
        calls.push(argv);
        if (argv[1] === "warmup") {
          warmed = true;
          return commandResult({ stdout: `leased ${LEASE_ID} slug=test\n` });
        }
        if (argv[1] === "run") {
          const candidateProfilePath = argv[argv.indexOf("--env-from-profile") + 1];
          expect(candidateProfilePath).toBeDefined();
          if (!candidateProfilePath) {
            throw new Error("missing Crabbox environment profile path");
          }
          profilePath = candidateProfilePath;
          expect(fs.existsSync(profilePath)).toBe(true);
          if (!result) {
            throw new Error("spawn unavailable");
          }
          return result;
        }
        if (argv[1] === "stop") {
          return commandResult();
        }
        return warmed || argv.includes(LEASE_ID)
          ? commandResult({ stdout: inspectJson({ sshHostKey: HOST_KEY }) })
          : commandResult({ code: 4, stderr: `lease/server not found: ${argv.at(-2)}` });
      });

      const provisioning = provider.provision(
        { ...PROFILE, setup: "install-node", setupEnv: [envName] },
        OPERATION_ID,
      );
      if (result) {
        await expect(provisioning).rejects.toMatchObject({
          code: "invalid_profile",
          message: expect.stringContaining(message),
        });
      } else {
        await expect(provisioning).rejects.toThrow(message);
      }
      expect(profilePath).toBeDefined();
      if (profilePath) {
        expect(fs.existsSync(profilePath)).toBe(false);
        expect(fs.existsSync(path.dirname(profilePath))).toBe(false);
      }
      expect(calls.at(-1)).toEqual([SIBLING_BINARY, "stop", "--provider", "aws", "--id", LEASE_ID]);
    },
  );

  it.each([
    { phase: "profile setup", setupAttempt: 1 },
    { phase: "desktop setup", setupAttempt: 2 },
    { phase: "node enrollment setup", setupAttempt: 3 },
  ])("identifies the failed $phase phase", async ({ phase, setupAttempt }) => {
    let attempts = 0;
    const provider = providerWithRunner(async (argv) => {
      if (argv[1] === "inspect") {
        return commandResult({ stdout: inspectJson() });
      }
      if (argv[1] === "run" && ++attempts === setupAttempt) {
        return commandResult({ code: 7, stderr: "setup command rejected" });
      }
      return commandResult();
    });

    await expect(
      provider.provision({ ...PROFILE, setup: "install-node", desktop: true }, OPERATION_ID),
    ).rejects.toMatchObject({
      code: "invalid_profile",
      message: `Crabbox ${phase} failed with exit code 7: setup command rejected`,
    });
  });

  it.skipIf(process.platform === "win32")(
    "preserves the actual node enrollment diagnosis after setup noise",
    async () => {
      const diagnosis =
        "Error: Codex remote-exec requires the exact official @openclaw/codex@2026.8.1 plugin to be installed by cloudWorkers profile setup";
      const home = tempDirs.make("crabbox-enrollment-");
      const bin = path.join(home, "bin");
      fs.mkdirSync(bin);
      fs.symlinkSync(process.execPath, path.join(bin, "node"));
      fs.writeFileSync(
        path.join(bin, "openclaw"),
        [
          "#!/bin/sh",
          'case "$*" in',
          '  --version) echo "OpenClaw 2026.8.1" ;;',
          '  "plugins inspect codex --json") echo \'{"ok":false}\'; exit 1 ;;',
          '  *) echo "unexpected command: $*" >&2; exit 99 ;;',
          "esac",
        ].join("\n"),
        { mode: 0o700 },
      );
      const calls: string[][] = [];
      const provider = providerWithRunner(async (argv, options) => {
        calls.push(argv);
        if (argv[1] === "status") {
          return commandResult({ stdout: inspectJson() });
        }
        if (argv[1] !== "run") {
          return commandResult();
        }
        const result = spawnSync("/bin/bash", [], {
          input: options.input,
          encoding: "utf8",
          timeout: 10_000,
          env: {
            HOME: home,
            PATH: `${bin}:/usr/bin:/bin`,
            CRABBOX_WORKER_SETUP_CODE: "fixture-setup",
          },
        });
        expect(result.status).toBe(1);
        return commandResult({
          code: result.status,
          stdout: "setup progress ".repeat(200),
          stderr: `workspace owner acquired\n${result.stderr}\nworkspace owner released\nremote command exited 1`,
        });
      });

      await expect(
        provider.provision({ ...PROFILE, provider: "machine0" }, OPERATION_ID, {
          executionMode: "remote-exec",
        }),
      ).rejects.toMatchObject({
        code: "invalid_profile",
        message: expect.stringContaining(diagnosis),
      });
      expect(calls.at(-1)?.[1]).toBe("stop");
      expect(
        fs.existsSync(path.join(home, ".openclaw", "cloud-workers", LEASE_ID, "node.pid")),
      ).toBe(false);
    },
  );

  it("preserves the allocated lease and both failures when setup cleanup times out", async () => {
    let releaseCommitted = false;
    const provider = providerWithRunner(async (argv) => {
      if (argv[1] === "inspect" || argv[1] === "status") {
        return commandResult({ stdout: inspectJson({ sshHostKey: HOST_KEY }) });
      }
      if (argv[1] === "run") {
        return commandResult({ code: 7, stderr: "node setup failed" });
      }
      if (argv[1] === "stop") {
        releaseCommitted = true;
        return commandResult({ code: null, killed: true, termination: "timeout" });
      }
      return commandResult();
    });

    const error = await provider
      .provision({ ...PROFILE, setup: "install-node" }, OPERATION_ID)
      .catch((cause: unknown) => cause);

    expect(WorkerProviderError.isCleanupIndeterminate(error)).toBe(true);
    if (!WorkerProviderError.isCleanupIndeterminate(error)) {
      throw new Error("expected indeterminate worker cleanup error");
    }
    expect(error).toMatchObject({
      leaseId: LEASE_ID,
      provisionError: { message: expect.stringContaining("node setup failed") },
      cleanupError: { message: expect.stringContaining("stop did not exit normally (timeout)") },
    });
    expect(error.errors).toEqual([error.provisionError, error.cleanupError]);
    expect(releaseCommitted).toBe(true);
  });

  it.each(["aws", "AWS"])(
    "rejects an effective %s instance profile only after stop confirms cleanup",
    async (backend) => {
      const calls: string[][] = [];
      const provider = providerWithRawRunner(async (argv) => {
        calls.push(argv);
        if (argv[1] === "config") {
          return commandResult({
            stdout: JSON.stringify({ aws: { instanceProfile: "worker-role" } }),
          });
        }
        if (argv[1] === "inspect") {
          return commandResult({ code: 4, stderr: `lease/server not found: ${LEASE_ID}` });
        }
        if (argv[1] === "stop") {
          return commandResult();
        }
        throw new Error(`unexpected Crabbox command: ${argv[1]}`);
      });

      await expect(
        provider.provision({ ...PROFILE, provider: backend }, OPERATION_ID),
      ).rejects.toMatchObject({
        code: "invalid_profile",
        message: "Crabbox AWS instance profile must be empty for cloud workers",
      });
      expect(calls.map((argv) => argv[1])).toEqual(["config", "inspect", "stop"]);
    },
  );

  it.each(["recognized", "unrecognized"])(
    "cleans a committed %s fixed lease before making an AWS profile rejection permanent",
    async (recognition) => {
      const calls: string[][] = [];
      let creates = 0;
      let inspectTimeout = true;
      let profileRejected = false;
      let live = false;
      const runCommand: CrabboxCommandRunner = async (argv) => {
        calls.push(argv);
        if (argv[1] === "config") {
          return commandResult({
            stdout: JSON.stringify({
              aws: { instanceProfile: profileRejected ? "worker-role" : "" },
            }),
          });
        }
        if (argv[1] === "warmup") {
          if (!live) {
            creates += 1;
            live = true;
          }
          return commandResult();
        }
        if (argv[1] === "inspect") {
          if (inspectTimeout) {
            inspectTimeout = false;
            return commandResult({ code: null, killed: true, termination: "timeout" });
          }
          return recognition === "unrecognized"
            ? commandResult({ code: 4, stderr: `lease/server not found: ${LEASE_ID}` })
            : commandResult({ stdout: inspectJson({ sshHostKey: HOST_KEY }) });
        }
        if (argv[1] === "stop") {
          live = false;
          return commandResult();
        }
        throw new Error(`unexpected Crabbox command: ${argv[1]}`);
      };

      await expect(
        providerWithRawRunner(runCommand).provision(PROFILE, OPERATION_ID),
      ).rejects.toThrow("inspect did not exit normally (timeout)");
      expect(live).toBe(true);
      profileRejected = true;

      await expect(
        providerWithRawRunner(runCommand).provision(PROFILE, OPERATION_ID),
      ).rejects.toMatchObject({
        code: "invalid_profile",
        message: "Crabbox AWS instance profile must be empty for cloud workers",
      });
      expect(creates).toBe(1);
      expect(live).toBe(false);
      expect(calls.map((argv) => argv[1])).toEqual([
        "config",
        "warmup",
        "inspect",
        "config",
        "inspect",
        "stop",
      ]);
      expect(calls.at(-1)).toEqual([SIBLING_BINARY, "stop", "--provider", "aws", "--id", LEASE_ID]);
    },
  );

  it("cleans the exact fixed ID after malformed reconciliation inspection", async () => {
    const calls: string[][] = [];
    let live = true;
    const provider = providerWithRawRunner(async (argv) => {
      calls.push(argv);
      if (argv[1] === "config") {
        return commandResult({
          stdout: JSON.stringify({ aws: { instanceProfile: "worker-role" } }),
        });
      }
      if (argv[1] === "inspect") {
        return commandResult({ stdout: "{" });
      }
      if (argv[1] === "stop") {
        live = false;
        return commandResult();
      }
      throw new Error(`unexpected Crabbox command: ${argv[1]}`);
    });

    await expect(provider.provision(PROFILE, OPERATION_ID)).rejects.toMatchObject({
      code: "invalid_profile",
      message: "Crabbox AWS instance profile must be empty for cloud workers",
    });
    expect(live).toBe(false);
    expect(calls.map((argv) => argv[1])).toEqual(["config", "inspect", "stop"]);
    expect(calls.at(-1)).toEqual([SIBLING_BINARY, "stop", "--provider", "aws", "--id", LEASE_ID]);
  });

  it.each(["inspect", "stop", "unrecognized stop"] as const)(
    "keeps AWS profile rejection transient while exact-ID %s is indeterminate",
    async (failurePoint) => {
      const calls: string[][] = [];
      let live = true;
      const provider = providerWithRawRunner(async (argv) => {
        calls.push(argv);
        if (argv[1] === "config") {
          return commandResult({
            stdout: JSON.stringify({ aws: { instanceProfile: "worker-role" } }),
          });
        }
        if (argv[1] === "inspect") {
          return failurePoint === "inspect"
            ? commandResult({ code: null, killed: true, termination: "timeout" })
            : failurePoint === "unrecognized stop"
              ? commandResult({ code: 4, stderr: `lease/server not found: ${LEASE_ID}` })
              : commandResult({ stdout: inspectJson({ sshHostKey: HOST_KEY }) });
        }
        if (argv[1] === "stop") {
          if (failurePoint !== "inspect") {
            return commandResult({ code: null, killed: true, termination: "timeout" });
          }
          live = false;
          return commandResult();
        }
        throw new Error(`unexpected Crabbox command: ${argv[1]}`);
      });

      const error = await provider
        .provision(PROFILE, OPERATION_ID)
        .catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toMatchObject({ code: "invalid_profile" });
      if (failurePoint === "stop") {
        expect(WorkerProviderError.isCleanupIndeterminate(error)).toBe(true);
        if (!WorkerProviderError.isCleanupIndeterminate(error)) {
          throw new Error("expected indeterminate worker cleanup error");
        }
        expect(error).toMatchObject({
          leaseId: LEASE_ID,
          provisionError: {
            message: "Crabbox AWS instance profile must be empty for cloud workers",
          },
          cleanupError: { message: expect.stringContaining("stop did not exit normally") },
        });
      } else {
        const message = error instanceof Error ? error.message : "";
        expect(message).toContain(
          `cleanup is indeterminate during ${failurePoint === "inspect" ? "inspect" : "stop"}`,
        );
        expect(message).toContain("Crabbox AWS instance profile must be empty for cloud workers");
        expect(message.length).toBeLessThanOrEqual(512);
      }
      expect(live).toBe(true);
      expect(calls.map((argv) => argv[1])).toEqual(
        failurePoint === "inspect" ? ["config", "inspect"] : ["config", "inspect", "stop"],
      );
    },
  );

  it("stops an AWS lease when provider metadata reports an instance profile", async () => {
    const calls: string[][] = [];
    let warmed = false;
    const provider = createCrabboxWorkerProvider({
      runCommand: async (argv) => {
        calls.push(argv);
        if (argv[1] === "config") {
          return commandResult({ stdout: JSON.stringify({ aws: { instanceProfile: "" } }) });
        }
        if (argv[1] === "warmup") {
          warmed = true;
          return commandResult({ stdout: `leased ${LEASE_ID} slug=test\n` });
        }
        if (argv[1] === "inspect") {
          return warmed || argv.includes(LEASE_ID)
            ? commandResult({
                stdout: inspectJson({
                  providerMetadata: { instanceProfileAttached: true },
                  sshHostKey: HOST_KEY,
                }),
              })
            : commandResult({
                code: 4,
                stderr: `lease/server not found: ${argv[argv.indexOf("--id") + 1]}`,
              });
        }
        return commandResult();
      },
      openclawRoot: OPENCLAW_ROOT,
      pathEnv: "",
      isExecutable: (candidate) => candidate === SIBLING_BINARY,
      sleep: async () => {},
      wallpaperPath: WORKER_WALLPAPER_PATH,
    });

    await expect(provider.provision(PROFILE, OPERATION_ID)).rejects.toMatchObject({
      code: "invalid_profile",
      message: "Crabbox AWS inspect must attest that no instance profile is attached",
    });
    expect(calls.some((argv) => argv[1] === "stop" && argv.includes(LEASE_ID))).toBe(true);
  });

  it.each([
    {
      state: "pending-metadata then ready-safe",
      inspections: [
        { providerMetadata: undefined, ready: false },
        {
          providerMetadata: { instanceProfileAttached: false },
          ready: true,
          sshHostKey: HOST_KEY,
        },
      ],
      expectedError: null,
      expectedCommands: ["warmup", "inspect", "inspect", "run", "inspect"],
    },
    {
      state: "pending-forbidden",
      inspections: [
        {
          providerMetadata: { instanceProfileAttached: true },
          ready: false,
        },
      ],
      expectedError: "Crabbox AWS inspect must attest that no instance profile is attached",
      expectedCommands: ["warmup", "inspect", "stop"],
    },
    {
      state: "ready-metadata-missing",
      inspections: [{ providerMetadata: undefined, ready: true, sshHostKey: HOST_KEY }],
      expectedError: "Crabbox AWS inspect must attest that no instance profile is attached",
      expectedCommands: ["warmup", "inspect", "stop"],
    },
  ])(
    "enforces AWS instance-profile attestation across the $state sequence",
    async ({ inspections, expectedError, expectedCommands }) => {
      const calls: string[][] = [];
      let inspectionIndex = 0;
      const provider = providerWithRunner(async (argv) => {
        calls.push(argv);
        if (argv[1] === "inspect") {
          const inspection = inspections[inspectionIndex] ?? inspections.at(-1);
          if (!inspection) {
            throw new Error("missing inspection fixture");
          }
          inspectionIndex += 1;
          return commandResult({ stdout: inspectJson(inspection) });
        }
        return commandResult();
      });

      const provision = provider.provision(PROFILE, OPERATION_ID);
      if (expectedError) {
        await expect(provision).rejects.toMatchObject({
          code: "invalid_profile",
          message: expectedError,
        });
      } else {
        await expect(provision).resolves.toMatchObject({ leaseId: LEASE_ID });
      }
      expect(calls.map((argv) => argv[1])).toEqual(expectedCommands);
    },
  );

  it.each([
    {
      field: "provider metadata",
      overrides: { providerMetadata: { instanceProfileAttached: "no" } },
    },
    { field: "Tailscale state", overrides: { tailscale: null } },
  ])("stops a fixed lease with malformed $field", async ({ overrides }) => {
    const calls: string[][] = [];
    const provider = providerWithRunner(async (argv) => {
      calls.push(argv);
      if (argv[1] === "stop") {
        return commandResult();
      }
      return commandResult({ stdout: inspectJson(overrides) });
    });

    await expect(provider.provision(PROFILE, OPERATION_ID)).rejects.toMatchObject({
      code: "invalid_profile",
      message: expect.stringMatching(/Crabbox inspect returned invalid/u),
    });
    expect(calls.map((argv) => argv[1])).toEqual(["warmup", "inspect", "stop"]);
    expect(calls.at(-1)).toEqual([SIBLING_BINARY, "stop", "--provider", "aws", "--id", LEASE_ID]);
  });

  it.each([
    ["invalid JSON", commandResult({ stdout: "{" }), "Crabbox inspect returned invalid JSON"],
    [
      "expected-id mismatch",
      commandResult({ stdout: inspectJson({ id: "cbx_ffffffffffff" }) }),
      "Crabbox inspect returned a different lease id",
    ],
  ])("stops a fixed lease on permanent %s", async (_name, inspectResult, message) => {
    const calls: string[][] = [];
    const provider = providerWithRunner(async (argv) => {
      calls.push(argv);
      if (argv[1] === "stop") {
        return commandResult();
      }
      return argv[1] === "inspect" ? inspectResult : commandResult();
    });

    await expect(provider.provision(PROFILE, OPERATION_ID)).rejects.toMatchObject({
      code: "invalid_profile",
      message,
    });
    expect(calls.map((argv) => argv[1])).toEqual(["warmup", "inspect", "stop"]);
    expect(calls.at(-1)).toEqual([SIBLING_BINARY, "stop", "--provider", "aws", "--id", LEASE_ID]);
  });

  it("stops a fixed lease that has Tailscale state", async () => {
    const calls: string[][] = [];
    const provider = providerWithRunner(async (argv) => {
      calls.push(argv);
      if (argv[1] === "inspect") {
        return commandResult({
          stdout: inspectJson({ sshHostKey: HOST_KEY, tailscale: { enabled: true } }),
        });
      }
      return commandResult();
    });

    await expect(provider.provision(PROFILE, OPERATION_ID)).rejects.toMatchObject({
      code: "invalid_profile",
      message: "Crabbox cloud worker lease must not have Tailscale enabled",
    });
    expect(calls.some((argv) => argv[1] === "warmup")).toBe(true);
    expect(calls.some((argv) => argv[1] === "stop" && argv.includes(LEASE_ID))).toBe(true);
  });

  it("rejects a blank profile setup command", async () => {
    const provider = providerWithRunner(async () => commandResult());
    await expect(provider.provision({ ...PROFILE, setup: "  " }, "provision:x")).rejects.toThrow(
      "Crabbox profile setup must be a non-empty command string",
    );
  });

  it.each([
    ["OPENCLAW_WORKER_ARTIFACT_TOKEN"],
    ["OPENCLAW_WORKER_ARTIFACT_TOKEN", "_SECOND_VALUE2"],
  ])("accepts valid profile setup environment names %j", (...setupEnv) => {
    expect(parseCrabboxProfile({ ...PROFILE, setup: "install-node", setupEnv })).toMatchObject({
      setup: "install-node",
      setupEnv,
    });
  });

  it.each([
    [`provision:v2:${"0".repeat(64)}`, "cbx_6071fc2062a6"],
    [`provision:v2:${"a".repeat(64)}`, "cbx_d75d2e596dde"],
  ])("derives canonical fixed lease id for %s", (operationId, expected) => {
    expect(operationLeaseId(operationId)).toBe(expected);
    expect(operationLeaseId(operationId)).toMatch(/^cbx_[a-f0-9]{12}$/u);
  });

  it("rejects a non-boolean desktop profile setting", async () => {
    const provider = providerWithRunner(async () => commandResult());
    await expect(provider.provision({ ...PROFILE, desktop: "yes" }, OPERATION_ID)).rejects.toThrow(
      "Crabbox profile desktop must be a boolean",
    );
  });

  it("rejects desktop profiles outside the supported provider set before allocation", async () => {
    const runCommand = vi.fn<CrabboxCommandRunner>();
    const provider = providerWithRunner(runCommand);

    await expect(
      provider.provision({ ...PROFILE, provider: "azure", desktop: true }, OPERATION_ID),
    ).rejects.toMatchObject({
      code: "invalid_profile",
      message: "Crabbox desktop profiles support only AWS and coordinator-backed Hetzner",
    });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "direct",
      config: { coordinator: "", brokerMode: "managed" },
    },
    {
      name: "registered",
      config: {
        coordinator: "https://coordinator.example.test",
        brokerMode: "registered",
      },
    },
  ])("rejects a $name Hetzner desktop profile before allocation", async ({ config }) => {
    const calls: string[][] = [];
    const provider = providerWithRawRunner(async (argv) => {
      calls.push(argv);
      if (argv[1] === "config" && argv[2] === "show") {
        return commandResult({ stdout: JSON.stringify(config) });
      }
      return commandResult();
    });

    await expect(
      provider.provision({ ...PROFILE, provider: "hetzner", desktop: true }, OPERATION_ID),
    ).rejects.toMatchObject({
      code: "invalid_profile",
      message: "Crabbox Hetzner desktop profiles require a managed coordinator",
    });
    expect(calls.map((argv) => argv[1])).toEqual(["config"]);
  });

  const provisionTimeoutCases = [
    { name: "normal without setup", profile: { ...PROFILE }, minutes: 67 },
    {
      name: "normal with setup",
      profile: { ...PROFILE, setup: "install-node" },
      minutes: 82,
    },
    { name: "desktop without setup", profile: { ...PROFILE, desktop: true }, minutes: 132 },
    {
      name: "desktop with setup",
      profile: { ...PROFILE, desktop: true, setup: "install-node" },
      minutes: 147,
    },
  ] satisfies Array<{ name: string; profile: WorkerProfile; minutes: number }>;
  it.each(provisionTimeoutCases)(
    "includes warmup, lifecycle, setup, and node enrollment for $name",
    ({ profile, minutes }) => {
      const provider = providerWithRunner(async () => commandResult());

      expect(provider.resolveProvisionTimeoutMs?.(profile)).toBe(minutes * 60_000);
    },
  );

  it.each([
    {
      name: "direct AWS",
      providerId: "aws",
      config: { aws: { instanceProfile: "" }, coordinator: "", brokerMode: "managed" },
    },
    {
      name: "coordinator-backed AWS",
      providerId: "aws",
      config: {
        aws: { instanceProfile: "" },
        coordinator: "https://coordinator.example.test",
        brokerMode: "managed",
      },
    },
    {
      name: "coordinator-backed Hetzner",
      providerId: "hetzner",
      config: {
        coordinator: "https://coordinator.example.test",
        brokerMode: "managed",
      },
    },
  ])("provisions a node-carried desktop through $name", async ({ config, providerId }) => {
    const calls: Array<{ argv: string[]; options: Parameters<CrabboxCommandRunner>[1] }> = [];
    const setupOrder: string[] = [];
    const provider = providerWithRawRunner(async (argv, options) => {
      calls.push({ argv, options });
      if (argv[1] === "config" && argv[2] === "show") {
        return commandResult({ stdout: JSON.stringify(config) });
      }
      if (argv[1] === "inspect" || argv[1] === "status") {
        return commandResult({ stdout: inspectJson({ sshHostKey: HOST_KEY }) });
      }
      if (argv[1] === "run" && String(options.input).includes("openclaw-worker-browser")) {
        setupOrder.push("desktop");
      }
      return commandResult();
    });

    await expect(
      provider.provision({ ...PROFILE, provider: providerId, desktop: true }, OPERATION_ID, {
        beginNodeEnrollment: async () => {
          setupOrder.push("enrollment");
          return {
            mode: "connect" as const,
            setupCode: "secret-setup-value",
            setupId: "setup-id",
            openclawVersion: "2026.8.1",
            packageSpecs: ["openclaw@2026.8.1"],
            displayName: "Cloud worker test",
            waitForDeviceId: async () => "device-1",
          };
        },
      }),
    ).resolves.toEqual({
      leaseId: LEASE_ID,
      node: { deviceId: "device-1" },
      sharedHost: false,
      desktop: {
        protocol: "rfb",
        port: 5900,
        passwordFilePath: "/var/lib/crabbox/vnc.password",
        apps: [
          {
            id: "browser",
            executablePath: "/usr/local/bin/openclaw-worker-browser",
            cdpPort: 9222,
          },
          {
            id: "terminal",
            executablePath: "/usr/local/bin/openclaw-worker-terminal",
          },
        ],
      },
    });
    expect(calls.find((call) => call.argv[1] === "warmup")).toEqual(
      expect.objectContaining({
        options: expect.objectContaining({ timeoutMs: 100 * 60_000 }),
      }),
    );
    expect(calls.find((call) => call.argv[1] === "warmup")?.argv.slice(-4)).toEqual([
      "--desktop",
      "--browser",
      "--desktop-env",
      "xfce",
    ]);
    expect(
      provider.resolveProvisionTimeoutMs?.({
        ...PROFILE,
        provider: providerId,
        desktop: true,
      }),
    ).toBe(132 * 60_000);
    expect(setupOrder).toEqual(["desktop", "enrollment"]);
  });

  it.each(["desktop setup", "enrollment preparation", "enrollment completion"] as const)(
    "stops the fixed desktop lease after permanent %s failure",
    async (failurePoint) => {
      const calls: string[][] = [];
      const provider = providerWithRunner(async (argv, options) => {
        calls.push(argv);
        if (argv[1] === "inspect") {
          return commandResult({ stdout: inspectJson({ sshHostKey: HOST_KEY }) });
        }
        if (
          failurePoint === "desktop setup" &&
          argv[1] === "run" &&
          String(options.input).includes("openclaw-worker-browser")
        ) {
          return commandResult({ code: 9, stderr: "desktop setup failed" });
        }
        return commandResult();
      });

      await expect(
        provider.provision({ ...PROFILE, desktop: true }, OPERATION_ID, {
          beginNodeEnrollment: async () => {
            if (failurePoint === "enrollment preparation") {
              throw new Error("enrollment preparation failed");
            }
            return {
              mode: "resume" as const,
              deviceId: "device-bound",
              openclawVersion: "2026.8.1",
              packageSpecs: ["openclaw@2026.8.1"],
              displayName: "Bound worker",
              waitForDeviceId: async () => {
                if (failurePoint === "enrollment completion") {
                  throw new Error("enrollment completion failed");
                }
                return "device-bound";
              },
            };
          },
        }),
      ).rejects.toThrow(failurePoint === "desktop setup" ? "setup failed" : failurePoint);
      expect(calls.at(-1)).toEqual([SIBLING_BINARY, "stop", "--provider", "aws", "--id", LEASE_ID]);
    },
  );

  it("collects redacted node evidence before stopping an unenrolled lease", async () => {
    const calls: Array<{ argv: string[]; options: Parameters<CrabboxCommandRunner>[1] }> = [];
    const pairingSecret = "pairing-secret-value-0123456789";
    const provider = providerWithRunner(async (argv, options) => {
      calls.push({ argv, options });
      if (argv[1] === "inspect" || argv[1] === "status") {
        return commandResult({ stdout: inspectJson({ sshHostKey: HOST_KEY }) });
      }
      if (argv[1] === "run" && String(options.input).includes("node.log tail:")) {
        return commandResult({
          stdout: [
            "package-spec=openclaw@2026.8.1 node-pid=alive node.log tail:",
            `gateway rejected websocket upgrade (HTTP 403): proxy_attribution_required token=${pairingSecret}`,
          ].join(" "),
        });
      }
      return commandResult();
    });

    const originalError = new Error("Worker node did not connect before the enrollment deadline");
    const error = await provider
      .provision(PROFILE, OPERATION_ID, failedNodeEnrollment(originalError))
      .catch((cause: unknown) => cause);

    expect(error).toMatchObject({
      cause: originalError,
      message: expect.stringContaining(
        "Worker node did not connect before the enrollment deadline; box evidence: package-spec=openclaw@2026.8.1 node-pid=alive node.log tail:",
      ),
    });
    const message = error instanceof Error ? error.message : "";
    expect(message).toContain("proxy_attribution_required");
    expect(message).not.toContain(pairingSecret);

    const diagnosticCall = calls.find(
      ({ argv, options }) => argv[1] === "run" && String(options.input).includes("node.log tail:"),
    );
    expect(diagnosticCall?.argv).toEqual([
      SIBLING_BINARY,
      "run",
      "--provider",
      "aws",
      "--network",
      "public",
      "--tailscale=false",
      "--id",
      LEASE_ID,
      "--keep=true",
      "--no-sync",
      "--script-stdin",
    ]);
    expect(diagnosticCall?.options.timeoutMs).toBe(60_000);
    expect(diagnosticCall?.options.env).toBeUndefined();
    expect(String(diagnosticCall?.options.input)).toContain(`cloud-workers/${LEASE_ID}`);
    expect(String(diagnosticCall?.options.input)).not.toContain("setup-code");
    expect(calls.slice(-2).map(({ argv }) => argv[1])).toEqual(["run", "stop"]);
  });

  it.each([
    {
      name: "exits unsuccessfully",
      result: commandResult({ code: 9, stderr: "SSH transport unavailable" }),
      reason: "Crabbox enrollment diagnostics failed with exit code 9: SSH transport unavailable",
    },
    {
      name: "times out",
      result: commandResult({ code: null, killed: true, termination: "timeout" }),
      reason: "Crabbox enrollment diagnostics did not exit normally (timeout)",
    },
    {
      name: "cannot start",
      result: undefined,
      reason: "Crabbox enrollment diagnostics could not start",
    },
  ])("preserves enrollment failure when evidence collection $name", async ({ result, reason }) => {
    const calls: string[][] = [];
    const provider = providerWithRunner(async (argv, options) => {
      calls.push(argv);
      if (argv[1] === "inspect" || argv[1] === "status") {
        return commandResult({ stdout: inspectJson({ sshHostKey: HOST_KEY }) });
      }
      if (argv[1] === "run" && String(options.input).includes("node.log tail:")) {
        if (!result) {
          throw new Error("spawn failed token=diagnostic-secret-value-0123456789");
        }
        return result;
      }
      return commandResult();
    });

    const originalError = new Error("Worker node did not connect before the enrollment deadline");
    await expect(
      provider.provision(PROFILE, OPERATION_ID, failedNodeEnrollment(originalError)),
    ).rejects.toMatchObject({
      cause: originalError,
      message: `${originalError.message}; box evidence unavailable: ${reason}`,
    });
    expect(calls.slice(-2).map((argv) => argv[1])).toEqual(["run", "stop"]);
  });

  it.each([
    {
      name: "a surrogate pair at the byte boundary",
      output: `${"x".repeat(2_033)}😀secret-tail`,
      expected: "x".repeat(2_033),
    },
    {
      name: "multibyte Unicode output",
      output: "😀".repeat(800),
      expected: "😀".repeat(508),
    },
  ])("bounds enrollment evidence for $name", async ({ output, expected }) => {
    const provider = providerWithRunner(async (argv, options) => {
      if (argv[1] === "inspect" || argv[1] === "status") {
        return commandResult({ stdout: inspectJson({ sshHostKey: HOST_KEY }) });
      }
      if (argv[1] === "run" && String(options.input).includes("node.log tail:")) {
        return commandResult({ stdout: output });
      }
      return commandResult();
    });

    const originalError = new Error("Worker node did not connect before the enrollment deadline");
    const error = await provider
      .provision(PROFILE, OPERATION_ID, failedNodeEnrollment(originalError))
      .catch((cause: unknown) => cause);
    const message = error instanceof Error ? error.message : "";
    const evidence = message.split("; ")[1] ?? "";

    expect(evidence).toBe(`box evidence: ${expected}`);
    expect(Buffer.byteLength(evidence, "utf8")).toBeLessThanOrEqual(2_048);
    expect(hasLoneSurrogate(message)).toBe(false);
  });

  it.each(["preparation", "completion", "diagnostics"] as const)(
    "preserves its fixed lease when the Gateway aborts enrollment %s",
    async (phase) => {
      const calls: string[][] = [];
      const controller = new AbortController();
      const provider = providerWithRunner(async (argv, options) => {
        calls.push(argv);
        if (
          phase === "diagnostics" &&
          argv[1] === "run" &&
          String(options.input).includes("node.log tail:")
        ) {
          controller.abort();
          return commandResult({ stdout: "package-spec=absent node-pid=dead-or-absent" });
        }
        return argv[1] === "inspect"
          ? commandResult({ stdout: inspectJson({ sshHostKey: HOST_KEY }) })
          : commandResult();
      });

      await expect(
        provider.provision(PROFILE, OPERATION_ID, {
          beginNodeEnrollment: async () => {
            if (phase === "preparation") {
              controller.abort();
              controller.signal.throwIfAborted();
            }
            return {
              mode: "resume" as const,
              deviceId: "device-bound",
              openclawVersion: "2026.8.1",
              packageSpecs: ["openclaw@2026.8.1"],
              displayName: "Bound worker",
              signal: controller.signal,
              waitForDeviceId: async () => {
                if (phase === "diagnostics") {
                  throw new Error("Worker node did not connect before the enrollment deadline");
                }
                controller.abort();
                controller.signal.throwIfAborted();
                return "device-bound";
              },
            };
          },
        }),
      ).rejects.toMatchObject({ name: "AbortError" });

      expect(calls.some((argv) => argv[1] === "stop")).toBe(false);
    },
  );

  it.each([
    {
      providerId: "aws",
      warmupTimeoutMs: 50 * 60_000,
      lifecycleTimeoutMs: 60_000,
      provisionTimeoutMs: 67 * 60_000,
    },
    {
      providerId: "hetzner",
      warmupTimeoutMs: 50 * 60_000,
      lifecycleTimeoutMs: 60_000,
      provisionTimeoutMs: 67 * 60_000,
    },
    {
      providerId: "machine0",
      warmupTimeoutMs: 50 * 60_000,
      lifecycleTimeoutMs: 5 * 60_000,
      provisionTimeoutMs: 80 * 60_000,
    },
  ])(
    "runs one fixed $providerId warmup, ignores its output, and inspects only the canonical id",
    async ({ providerId, warmupTimeoutMs, lifecycleTimeoutMs, provisionTimeoutMs }) => {
      const calls: Array<{ argv: string[]; options: Parameters<CrabboxCommandRunner>[1] }> = [];
      const provider = providerWithRunner(async (argv, options) => {
        calls.push({ argv, options });
        return argv[1] === "warmup"
          ? commandResult({ stdout: "warmup completed without a lease token\n" })
          : commandResult({ stdout: inspectJson({ sshHostKey: HOST_KEY }) });
      });
      const profile = { ...PROFILE, provider: providerId };
      const readinessAction = providerId === "machine0" ? "status" : "inspect";

      await expect(provider.provision(profile, OPERATION_ID)).resolves.toMatchObject({
        leaseId: LEASE_ID,
      });
      expect(calls).toHaveLength(4);
      expect(calls[0]?.argv).toEqual([
        SIBLING_BINARY,
        "warmup",
        "--provider",
        providerId,
        "--network",
        "public",
        "--tailscale=false",
        "--class",
        "standard",
        "--ttl",
        "24h",
        "--idle-timeout",
        "60m",
        "--lease-id",
        LEASE_ID,
        "--slug",
        expect.stringMatching(/^openclaw-[a-f0-9]{32}$/u),
        "--keep=true",
      ]);
      expect({
        warmupOptions: calls[0]?.options,
        provisionTimeoutMs: provider.resolveProvisionTimeoutMs?.(profile),
        provisionTimeoutWithSetupMs: provider.resolveProvisionTimeoutMs?.({
          ...profile,
          setup: "install-node",
        }),
      }).toEqual({
        warmupOptions: {
          timeoutMs: warmupTimeoutMs,
          maxOutputBytes: 65_536,
          killProcessTree: true,
        },
        provisionTimeoutMs,
        provisionTimeoutWithSetupMs: provisionTimeoutMs + 15 * 60_000,
      });
      expect(calls[1]?.argv).toEqual([
        SIBLING_BINARY,
        readinessAction,
        "--provider",
        providerId,
        "--network",
        "public",
        "--id",
        LEASE_ID,
        ...(providerId === "machine0" ? ["--wait", "--wait-timeout", "4m"] : []),
        "--json",
      ]);
      expect(calls[1]?.options.timeoutMs).toBe(lifecycleTimeoutMs);
      expect(calls[2]?.argv[1]).toBe("run");
      expect(String(calls[2]?.options.input)).toContain("openclaw@2026.8.1");
      expect(String(calls[2]?.options.input)).toContain(
        "'OpenClaw 2026.8.1'|'OpenClaw 2026.8.1 '*",
      );
      expect(String(calls[2]?.options.input)).toContain(
        'npx --yes --package "$package_spec" -- openclaw',
      );
      expect(String(calls[2]?.options.input)).toContain(
        "OpenClaw worker bootstrap could not install Gateway version 2026.8.1",
      );
      expect(String(calls[2]?.options.input)).toContain(
        'connect --target-file "$setup_code_file" --ephemeral',
      );
      expect(String(calls[2]?.options.input)).toContain("setsid -f sh -c");
      expect(String(calls[2]?.options.input)).not.toContain(
        "config set nodeHost.workerRuns.enabled",
      );
      expect(String(calls[2]?.options.input)).not.toContain("nohup");
      expect(String(calls[2]?.options.input)).not.toContain("secret-setup-value");
      expect(calls[2]?.options.env).toStrictEqual({
        CRABBOX_WORKER_SETUP_CODE: undefined,
        CRABBOX_ENV_ALLOW: ",",
      });
      expect(calls[2]?.options.env?.CRABBOX_ENV_ALLOW).toBe(",");
      expect(calls[2]?.argv).toEqual(
        expect.arrayContaining(["--allow-env", "CRABBOX_WORKER_SETUP_CODE"]),
      );
      expect(calls[2]?.argv.join(" ")).not.toContain("setup-code");
      expect(calls[3]?.argv[1]).toBe(readinessAction);
      expect(calls[3]?.options.timeoutMs).toBe(lifecycleTimeoutMs);

      const lease = lifecycleLease(LEASE_ID, profile);
      await expect(provider.inspect(lease)).resolves.toEqual({ status: "active" });
      await expect(provider.destroy(lease)).resolves.toBeUndefined();
      expect(calls.slice(4).map(({ argv, options }) => [argv[1], options.timeoutMs])).toEqual([
        ["inspect", lifecycleTimeoutMs],
        ["stop", lifecycleTimeoutMs],
      ]);
    },
  );

  it.each([
    { providerId: "aws", expectedIntervalMs: 2_000 },
    { providerId: "hetzner", expectedIntervalMs: 2_000 },
    { providerId: "machine0", expectedIntervalMs: 60_000 },
  ])(
    "paces $providerId readiness re-inspection at $expectedIntervalMs ms",
    async ({ providerId, expectedIntervalMs }) => {
      let inspections = 0;
      const delays: number[] = [];
      const provider = providerWithRunner(
        async (argv) => {
          if (argv[1] === "inspect" || argv[1] === "status") {
            inspections += 1;
            return commandResult({
              stdout: inspectJson({ ready: inspections > 1, sshHostKey: HOST_KEY }),
            });
          }
          return commandResult();
        },
        undefined,
        async (milliseconds) => {
          delays.push(milliseconds);
        },
      );

      await expect(
        provider.provision({ ...PROFILE, provider: providerId }, OPERATION_ID),
      ).resolves.toMatchObject({ leaseId: LEASE_ID });
      expect(delays).toEqual([expectedIntervalMs]);
    },
  );

  it("reserves separate Machine0 inspection and readiness windows after a near-max warmup", async () => {
    const profile = { ...PROFILE, provider: "machine0" };
    let elapsedMs = 0;
    const inspectTimeouts: number[] = [];
    const now = vi.spyOn(Date, "now").mockImplementation(() => elapsedMs);
    const provider = providerWithRunner(async (argv, options) => {
      if (argv[1] === "warmup") {
        elapsedMs = 50 * 60_000;
        return commandResult();
      }
      if (argv[1] === "inspect" || argv[1] === "status") {
        inspectTimeouts.push(options.timeoutMs);
        if (inspectTimeouts.length <= 2) {
          elapsedMs += 4 * 60_000;
        }
        return commandResult({
          stdout: inspectJson({ ready: inspectTimeouts.length > 1, sshHostKey: HOST_KEY }),
        });
      }
      return commandResult();
    });

    try {
      await expect(provider.provision(profile, OPERATION_ID)).resolves.toMatchObject({
        leaseId: LEASE_ID,
      });
      expect(inspectTimeouts.slice(0, 2)).toEqual([5 * 60_000, 5 * 60_000]);
    } finally {
      now.mockRestore();
    }
  });

  it("reserves the full Machine0 cleanup budget after late node enrollment failure", async () => {
    const profile = { ...PROFILE, provider: "machine0" };
    let elapsedMs = 0;
    let cleanupTimeoutMs = 0;
    const now = vi.spyOn(Date, "now").mockImplementation(() => elapsedMs);
    const provider = providerWithRunner(async (argv, options) => {
      if (argv[1] === "inspect" || argv[1] === "status") {
        return commandResult({ stdout: inspectJson({ sshHostKey: HOST_KEY }) });
      }
      if (argv[1] === "stop") {
        cleanupTimeoutMs = options.timeoutMs;
        elapsedMs += options.timeoutMs;
        return commandResult({ code: null, killed: true, termination: "timeout" });
      }
      return commandResult();
    });

    try {
      await expect(
        provider.provision(profile, OPERATION_ID, {
          beginNodeEnrollment: async () => ({
            mode: "resume" as const,
            deviceId: "device-bound",
            openclawVersion: "2026.8.1",
            packageSpecs: ["openclaw@2026.8.1"],
            displayName: "Bound worker",
            waitForDeviceId: async () => {
              elapsedMs = 75 * 60_000;
              throw new Error("node enrollment expired");
            },
          }),
        }),
      ).rejects.toMatchObject({ code: "cleanup_indeterminate", leaseId: LEASE_ID });

      expect(cleanupTimeoutMs).toBe(5 * 60_000);
      expect(provider.resolveProvisionTimeoutMs?.(profile)).toBe(elapsedMs);
    } finally {
      now.mockRestore();
    }
  });

  it.each(["standard", undefined])(
    "overrides configured class %s for one provision operation",
    async (configuredClass) => {
      const calls: string[][] = [];
      const provider = providerWithRunner(async (argv) => {
        calls.push(argv);
        return argv[1] === "warmup"
          ? commandResult()
          : commandResult({ stdout: inspectJson({ sshHostKey: HOST_KEY }) });
      });

      await provider.provision(
        { ...CLASSLESS_PROFILE, ...(configuredClass ? { class: configuredClass } : {}) },
        OPERATION_ID,
        {
          machineClass: "c7a.24xlarge",
        },
      );

      const warmup = calls.find((argv) => argv[1] === "warmup");
      expect(warmup?.slice(warmup.indexOf("--class"), warmup.indexOf("--class") + 2)).toEqual([
        "--class",
        "c7a.24xlarge",
      ]);
    },
  );

  it.each([null, 4, "", " ", "x".repeat(129)])(
    "rejects an invalid per-operation machine class before allocation (%j)",
    async (machineClass) => {
      const runCommand = vi.fn(async () => commandResult());
      const provider = providerWithRunner(runCommand);

      await expect(
        provider.provision(PROFILE, OPERATION_ID, { machineClass: machineClass as never }),
      ).rejects.toMatchObject({ code: "invalid_profile" });
      expect(runCommand).not.toHaveBeenCalled();
    },
  );

  it("replays a committed timed-out warmup through a fresh provider instance", async () => {
    const calls: string[][] = [];
    const live = new Set<string>();
    let creates = 0;
    let loseFirstReply = true;
    const runCommand: CrabboxCommandRunner = async (argv) => {
      calls.push(argv);
      const idFlag = argv.indexOf("--id");
      const leaseIdFlag = argv.indexOf("--lease-id");
      const id = argv[idFlag >= 0 ? idFlag + 1 : leaseIdFlag + 1] ?? "";
      if (argv[1] === "warmup") {
        if (!live.has(id)) {
          creates += 1;
          live.add(id);
        }
        if (loseFirstReply) {
          loseFirstReply = false;
          return commandResult({ code: null, killed: true, termination: "timeout" });
        }
        return commandResult();
      }
      if (argv[1] === "inspect") {
        return commandResult({ stdout: inspectJson({ id, sshHostKey: HOST_KEY }) });
      }
      if (argv[1] === "run") {
        return commandResult();
      }
      if (argv[1] === "stop") {
        live.delete(id);
        return commandResult();
      }
      throw new Error(`unexpected Crabbox command: ${argv[1]}`);
    };

    const desktopProfile = { ...PROFILE, desktop: true };
    await expect(
      providerWithRunner(runCommand).provision(desktopProfile, OPERATION_ID),
    ).rejects.toThrow("did not exit normally (timeout)");
    expect(calls.map((argv) => argv[1])).toEqual(["warmup"]);

    const restarted = providerWithRunner(runCommand);
    const lease = await restarted.provision(desktopProfile, OPERATION_ID);
    await restarted.destroy({ leaseId: lease.leaseId, profile: desktopProfile });

    expect(creates).toBe(1);
    expect(lease.leaseId).toBe(LEASE_ID);
    expect(lease.desktop).toMatchObject({
      protocol: "rfb",
      port: 5900,
      apps: [{ id: "browser" }, { id: "terminal" }],
    });
    expect(live.size).toBe(0);
    expect(calls.filter((argv) => argv[1] === "warmup")).toHaveLength(2);
    expect(calls.filter((argv) => argv[1] === "inspect")).toHaveLength(3);
    expect(calls.filter((argv) => argv[1] === "inspect")).toEqual(
      expect.arrayContaining([
        expect.arrayContaining(["--id", LEASE_ID]),
        expect.arrayContaining(["--id", LEASE_ID]),
        expect.arrayContaining(["--id", LEASE_ID]),
      ]),
    );
    expect(calls.at(-1)).toEqual([SIBLING_BINARY, "stop", "--provider", "aws", "--id", LEASE_ID]);
  });

  it("keeps a committed lease live after inspect timeout and adopts it on replay", async () => {
    const calls: string[][] = [];
    const live = new Set<string>();
    let creates = 0;
    let inspections = 0;
    const runCommand: CrabboxCommandRunner = async (argv) => {
      calls.push(argv);
      const idFlag = argv.indexOf("--id");
      const leaseIdFlag = argv.indexOf("--lease-id");
      const id = argv[idFlag >= 0 ? idFlag + 1 : leaseIdFlag + 1] ?? "";
      if (argv[1] === "warmup") {
        if (!live.has(id)) {
          creates += 1;
          live.add(id);
        }
        return commandResult();
      }
      if (argv[1] === "inspect") {
        inspections += 1;
        return inspections === 1
          ? commandResult({ code: null, killed: true, termination: "timeout" })
          : commandResult({ stdout: inspectJson({ id, sshHostKey: HOST_KEY }) });
      }
      if (argv[1] === "run") {
        return commandResult();
      }
      if (argv[1] === "stop") {
        live.delete(id);
        return commandResult();
      }
      throw new Error(`unexpected Crabbox command: ${argv[1]}`);
    };

    await expect(providerWithRunner(runCommand).provision(PROFILE, OPERATION_ID)).rejects.toThrow(
      "did not exit normally (timeout)",
    );
    expect(calls.map((argv) => argv[1])).toEqual(["warmup", "inspect"]);
    expect(live).toEqual(new Set([LEASE_ID]));

    const restarted = providerWithRunner(runCommand);
    const lease = await restarted.provision(PROFILE, OPERATION_ID);
    expect(lease.leaseId).toBe(LEASE_ID);
    expect(creates).toBe(1);
    expect(live).toEqual(new Set([LEASE_ID]));

    await restarted.destroy({ leaseId: lease.leaseId, profile: PROFILE });
    expect(live.size).toBe(0);
    expect(calls.map((argv) => argv[1])).toEqual([
      "warmup",
      "inspect",
      "warmup",
      "inspect",
      "run",
      "inspect",
      "stop",
    ]);
  });

  it.each([
    [
      "spawn failure",
      async (): Promise<SpawnResult> => {
        throw new Error("spawn failed");
      },
      "Crabbox inspect could not start",
    ],
    [
      "non-authoritative CLI failure",
      async (): Promise<SpawnResult> => commandResult({ code: 1, stderr: "provider unavailable" }),
      "Crabbox inspect failed with exit code 1",
    ],
  ])("leaves the fixed lease live after transient %s", async (_name, failure, message) => {
    const calls: string[][] = [];
    const provider = providerWithRunner(async (argv) => {
      calls.push(argv);
      if (argv[1] === "inspect") {
        return await failure();
      }
      if (argv[1] === "stop") {
        throw new Error("transient inspection must not stop the lease");
      }
      return commandResult();
    });

    const error = await provider.provision(PROFILE, OPERATION_ID).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ message: expect.stringContaining(message) });
    expect(error).not.toMatchObject({ code: "invalid_profile" });
    expect(calls.map((argv) => argv[1])).toEqual(["warmup", "inspect"]);
  });

  it("keeps authoritative absence after warmup retryable and un-stopped", async () => {
    const calls: string[][] = [];
    const provider = providerWithRunner(async (argv) => {
      calls.push(argv);
      if (argv[1] === "inspect") {
        return commandResult({ code: 4, stderr: `lease/server not found: ${LEASE_ID}` });
      }
      if (argv[1] === "stop") {
        throw new Error("authoritative absence must not tombstone the fixed ID");
      }
      return commandResult();
    });

    const error = await provider.provision(PROFILE, OPERATION_ID).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      message: "Crabbox warmup lease was not found during inspection",
    });
    expect(error).not.toMatchObject({ code: "invalid_profile" });
    expect(calls.map((argv) => argv[1])).toEqual(["warmup", "inspect"]);
  });

  it.each([
    [
      "unsupported backend",
      2,
      "provider=daytona does not support fixed idempotent lease IDs",
      "provider=daytona does not support fixed idempotent lease IDs",
    ],
    [
      "old CLI",
      2,
      "unknown flag: --lease-id",
      "Crabbox 0.41.1 or newer with fixed lease ID support is required",
    ],
    [
      "intent drift",
      4,
      "lease_id_conflict: lease is bound to another create intent",
      "lease_id_conflict",
    ],
    [
      "terminal reuse",
      4,
      "lease_id_conflict: fixed lease is terminal and cannot be replayed",
      "lease_id_conflict",
    ],
  ])("reports %s accurately before enrollment", async (_name, code, stderr, diagnosis) => {
    const runCommand = vi.fn<CrabboxCommandRunner>(async () => commandResult({ code, stderr }));
    const provider = providerWithRunner(runCommand);
    const beginNodeEnrollment = vi.fn();

    await expect(
      provider.provision({ ...CLASSLESS_PROFILE, provider: "daytona" }, OPERATION_ID, {
        beginNodeEnrollment,
      }),
    ).rejects.toMatchObject({
      code: "invalid_profile",
      message: expect.stringContaining(diagnosis),
    });
    expect(beginNodeEnrollment).not.toHaveBeenCalled();
    expect(runCommand).toHaveBeenCalledOnce();
    const argv = runCommand.mock.calls[0]?.[0];
    expect(argv).toEqual(expect.arrayContaining(["warmup", "--lease-id", LEASE_ID]));
    expect(argv).not.toContain("--class");
  });

  it("keeps unresolved direct AWS inventory convergence retryable", async () => {
    const calls: string[][] = [];
    const provider = providerWithRunner(async (argv) => {
      calls.push(argv);
      return commandResult({
        code: 4,
        stderr:
          "lease_id_conflict: fixed AWS lease has an unresolved launch attempt; retry after provider inventory converges",
      });
    });

    const error = await provider.provision(PROFILE, OPERATION_ID).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toMatchObject({ code: "invalid_profile" });
    expect(calls.map((argv) => argv[1])).toEqual(["warmup"]);
  });

  it("rejects legacy unleased provision state before invoking Crabbox", async () => {
    let invoked = false;
    const provider = providerWithRunner(async () => {
      invoked = true;
      return commandResult();
    });

    await expect(provider.provision(PROFILE, `provision:${"0".repeat(64)}`)).rejects.toMatchObject({
      code: "invalid_profile",
      message: expect.stringContaining("cannot be replayed safely"),
    });
    expect(invoked).toBe(false);
  });

  it("keeps readiness polling out of the setup timeout budget", async () => {
    const calls: string[][] = [];
    let nowMs = 1_000;
    let inspections = 0;
    const now = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const provider = createCrabboxWorkerProvider({
      runCommand: async (argv) => {
        calls.push(argv);
        if (argv[1] === "config") {
          return commandResult({ stdout: JSON.stringify({ aws: { instanceProfile: "" } }) });
        }
        if (argv[1] === "inspect") {
          inspections += 1;
          return commandResult({
            stdout: inspectJson({ ready: inspections > 1, sshHostKey: HOST_KEY }),
          });
        }
        return commandResult();
      },
      openclawRoot: OPENCLAW_ROOT,
      pathEnv: "",
      isExecutable: (candidate) => candidate === SIBLING_BINARY,
      sleep: async () => {
        nowMs += resolveCrabboxProvisionBaseTimeoutMs(PROFILE) + 1;
      },
      wallpaperPath: WORKER_WALLPAPER_PATH,
    });

    try {
      await expect(
        provider.provision({ ...PROFILE, setup: "install-node" }, OPERATION_ID),
      ).rejects.toThrow("exceeded its provider deadline");
    } finally {
      now.mockRestore();
    }
    expect(calls.map((argv) => argv[1])).toEqual(["config", "warmup", "inspect"]);
  });

  it("leaves the fixed lease live when readiness polling fails transiently", async () => {
    const calls: string[][] = [];
    let inspections = 0;
    const provider = providerWithRunner(async (argv) => {
      calls.push(argv);
      if (argv[1] === "inspect") {
        inspections += 1;
        return inspections === 1
          ? commandResult({ stdout: inspectJson({ ready: false }) })
          : commandResult({ code: 1, stderr: "readiness probe failed" });
      }
      return commandResult();
    });

    await expect(provider.provision(PROFILE, OPERATION_ID)).rejects.toThrow(
      "readiness probe failed",
    );
    expect(calls.map((argv) => argv[1])).toEqual(["warmup", "inspect", "inspect"]);
  });

  it.each([
    { profile: {}, message: "provider" },
    { profile: { ...PROFILE, provider: " " }, message: "provider" },
    ...[null, "", " ", 4].map((machineClass) => ({
      profile: { ...PROFILE, class: machineClass },
      message: "class",
    })),
    { profile: { ...PROFILE, warmImage: "yes" }, message: "warmImage must be a boolean" },
    { profile: { ...PROFILE, ttl: "" }, message: "ttl" },
    { profile: { ...PROFILE, ttl: "garbage" }, message: "positive Go duration" },
    { profile: { ...PROFILE, ttl: "0.1ns" }, message: "positive Go duration" },
    {
      profile: { ...PROFILE, ttl: "999999999999999999999h" },
      message: "positive Go duration",
    },
    { profile: { ...PROFILE, idleTimeout: false }, message: "idleTimeout" },
    { profile: { ...PROFILE, idleTimeout: "0s" }, message: "positive Go duration" },
    { profile: { ...PROFILE, binary: " " }, message: "binary" },
    { profile: { ...PROFILE, binary: "crabbox" }, message: "absolute path" },
    { profile: { ...PROFILE, setup: "install-node", setupEnv: "TOKEN" }, message: "array" },
    { profile: { ...PROFILE, setup: "install-node", setupEnv: null }, message: "array" },
    { profile: { ...PROFILE, setup: "install-node", setupEnv: [4] }, message: "valid" },
    { profile: { ...PROFILE, setup: "install-node", setupEnv: [""] }, message: "valid" },
    { profile: { ...PROFILE, setup: "install-node", setupEnv: ["1TOKEN"] }, message: "valid" },
    { profile: { ...PROFILE, setup: "install-node", setupEnv: ["BAD-NAME"] }, message: "valid" },
    {
      profile: { ...PROFILE, setup: "install-node", setupEnv: ["CRABBOX_ENV_ALLOW"] },
      message: "CRABBOX_ENV_ALLOW is reserved",
    },
    {
      profile: { ...PROFILE, setup: "install-node", setupEnv: ["TOKEN", "TOKEN"] },
      message: "duplicate",
    },
    {
      profile: {
        ...PROFILE,
        setup: "install-node",
        setupEnv: Array.from({ length: 17 }, (_, index) => `TOKEN_${index}`),
      },
      message: "at most 16",
    },
    { profile: { ...PROFILE, setupEnv: ["TOKEN"] }, message: "requires setup" },
    { profile: { ...PROFILE, typo: true }, message: "unknown" },
  ])("rejects an invalid profile ($message)", async ({ profile, message }) => {
    let invoked = false;
    const provider = providerWithRunner(async () => {
      invoked = true;
      return commandResult();
    });

    await expect(provider.provision(profile, "provision:invalid")).rejects.toThrow(message);
    await expect(
      provider.provision(profile, "provision:invalid", { machineClass: "fast" }),
    ).rejects.toMatchObject({
      code: "invalid_profile",
    });
    expect(invoked).toBe(false);
  });

  it("rejects a provider unknown to the Crabbox binary as an invalid profile", async () => {
    const provider = providerWithRunner(async () =>
      commandResult({ code: 2, stderr: 'unknown provider "missing-provider"' }),
    );

    await expect(
      provider.provision({ ...PROFILE, provider: "missing-provider" }, OPERATION_ID),
    ).rejects.toMatchObject({
      code: "invalid_profile",
    });
  });

  it("rejects a Crabbox backend without warmup support as an invalid profile", async () => {
    const provider = providerWithRunner(async (argv) => {
      if (argv[1] === "warmup") {
        return commandResult({ code: 2, stderr: "provider=wandb does not support warmup" });
      }
      return commandResult({
        code: 4,
        stderr: `wandb sandbox "${argv[argv.indexOf("--id") + 1]}" has no matching local ownership claim`,
      });
    });

    await expect(
      provider.provision({ ...PROFILE, provider: "wandb" }, OPERATION_ID),
    ).rejects.toMatchObject({
      code: "invalid_profile",
    });
  });

  it("rejects a Crabbox backend without persistent status as an invalid profile", async () => {
    const provider = providerWithRunner(async () =>
      commandResult({
        code: 2,
        stderr:
          "provider=windows-sandbox does not expose persistent status; close the Windows Sandbox window",
      }),
    );

    await expect(
      provider.provision({ ...PROFILE, provider: "windows-sandbox" }, OPERATION_ID),
    ).rejects.toMatchObject({
      code: "invalid_profile",
    });
  });

  it("rejects a machine class unsupported by the selected Crabbox backend", async () => {
    const provider = providerWithRunner(async (argv) => {
      if (argv[1] === "warmup") {
        return commandResult({
          code: 2,
          stderr: "--class is not supported for provider=vast; use --vast-gpu-name",
        });
      }
      return commandResult({
        code: 4,
        stderr: `lease/instance not found: ${argv[argv.indexOf("--id") + 1]}`,
      });
    });

    await expect(
      provider.provision({ ...PROFILE, provider: "vast" }, OPERATION_ID),
    ).rejects.toMatchObject({
      code: "invalid_profile",
    });
  });

  it("rejects a one-shot Crabbox backend as an invalid worker profile", async () => {
    const provider = providerWithRunner(async () =>
      commandResult({
        code: 2,
        stderr: "provider=mxc is one-shot and does not support status",
      }),
    );

    await expect(
      provider.provision({ ...PROFILE, provider: "mxc" }, OPERATION_ID),
    ).rejects.toMatchObject({
      code: "invalid_profile",
    });
  });

  it("routes lifecycle calls from the passed profile context", async () => {
    const binary = path.resolve(path.sep, "custom", "crabbox");
    const calls: string[][] = [];
    const provider = createCrabboxWorkerProvider({
      runCommand: async (argv) => {
        calls.push(argv);
        return argv[1] === "inspect" ? commandResult({ stdout: inspectJson() }) : commandResult();
      },
      openclawRoot: OPENCLAW_ROOT,
      pathEnv: "",
      isExecutable: () => false,
      wallpaperPath: WORKER_WALLPAPER_PATH,
    });
    const lease = lifecycleLease(LEASE_ID, { ...PROFILE, binary, provider: "coder" });

    await expect(provider.inspect(lease)).resolves.toStrictEqual({ status: "active" });
    await expect(provider.destroy(lease)).resolves.toBeUndefined();
    expect(calls).toEqual([
      [binary, "inspect", "--provider", "coder", "--network", "public", "--id", LEASE_ID, "--json"],
      [binary, "stop", "--provider", "coder", "--id", LEASE_ID],
    ]);
  });

  it.each([
    { idleTimeout: "1s", idleTimeoutMs: 1_000, intervalMs: 500, timeoutMs: 500 },
    { idleTimeout: "2s", idleTimeoutMs: 2_000, intervalMs: 1_000, timeoutMs: 1_000 },
    { idleTimeout: "5s", idleTimeoutMs: 5_000, intervalMs: 2_500, timeoutMs: 2_500 },
    { idleTimeout: "12s", idleTimeoutMs: 12_000, intervalMs: 5_000, timeoutMs: 6_000 },
    { idleTimeout: "30s", idleTimeoutMs: 30_000, intervalMs: 10_000, timeoutMs: 15_000 },
    { idleTimeout: "6m", idleTimeoutMs: 360_000, intervalMs: 60_000, timeoutMs: 150_000 },
    { idleTimeout: "45m", idleTimeoutMs: 2_700_000, intervalMs: 60_000, timeoutMs: 150_000 },
  ])(
    "heartbeats an active lease every $intervalMs ms for idleTimeout=$idleTimeout",
    async ({ idleTimeout, idleTimeoutMs, intervalMs, timeoutMs }) => {
      vi.useFakeTimers();
      const calls: string[][] = [];
      const heartbeatTimeouts: number[] = [];
      const profile = { ...PROFILE, idleTimeout };
      const provider = providerWithRunner(async (argv, options) => {
        calls.push(argv);
        if (argv[1] === "heartbeat") {
          heartbeatTimeouts.push(options.timeoutMs);
        }
        return argv[1] === "inspect"
          ? commandResult({ stdout: inspectJson({ sshHostKey: HOST_KEY }) })
          : commandResult();
      });
      const heartbeatCalls = () => calls.filter((argv) => argv[1] === "heartbeat");

      try {
        await expect(provider.provision(profile, OPERATION_ID)).resolves.toMatchObject({
          leaseId: LEASE_ID,
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(heartbeatCalls()).toEqual([
          [
            SIBLING_BINARY,
            "heartbeat",
            "--provider",
            "aws",
            "--id",
            LEASE_ID,
            "--idle-timeout",
            idleTimeout,
            "--json",
          ],
        ]);
        expect(heartbeatTimeouts).toEqual([timeoutMs]);

        await vi.advanceTimersByTimeAsync(intervalMs - 1);
        expect(heartbeatCalls()).toHaveLength(1);
        expect(intervalMs).toBeLessThan(idleTimeoutMs);
        await vi.advanceTimersByTimeAsync(1);
        expect(heartbeatCalls()).toHaveLength(2);
      } finally {
        await provider.destroy(lifecycleLease(LEASE_ID, profile));
        vi.useRealTimers();
      }
    },
  );

  it("aborts heartbeat before provider teardown and never reschedules it", async () => {
    vi.useFakeTimers();
    const calls: string[][] = [];
    let finishStop!: () => void;
    const stopPending = new Promise<void>((resolve) => {
      finishStop = resolve;
    });
    const provider = providerWithRunner(async (argv, options) => {
      calls.push(argv);
      if (argv[1] === "inspect") {
        return commandResult({ stdout: inspectJson() });
      }
      if (argv[1] === "heartbeat") {
        return await new Promise<SpawnResult>((resolve) => {
          options.signal?.addEventListener(
            "abort",
            () => resolve(commandResult({ code: null, termination: "signal" })),
            { once: true },
          );
        });
      }
      if (argv[1] === "stop") {
        await stopPending;
      }
      return commandResult();
    });
    const lease = lifecycleLease();

    try {
      await provider.inspect(lease);
      void vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(() =>
        expect(calls.filter((argv) => argv[1] === "heartbeat")).toHaveLength(1),
      );

      const destroy = provider.destroy(lease);
      await vi.waitFor(() => expect(calls.some((argv) => argv[1] === "stop")).toBe(true));
      await vi.advanceTimersByTimeAsync(180_000);
      expect(calls.filter((argv) => argv[1] === "heartbeat")).toHaveLength(1);
      finishStop();
      await destroy;
      await vi.advanceTimersByTimeAsync(180_000);
      expect(calls.filter((argv) => argv[1] === "heartbeat")).toHaveLength(1);
    } finally {
      finishStop();
      vi.useRealTimers();
    }
  });

  it("warns once and disables heartbeat when the Crabbox command is unavailable", async () => {
    vi.useFakeTimers();
    const calls: string[][] = [];
    const warnings: string[] = [];
    const provider = providerWithRunner(
      async (argv) => {
        calls.push(argv);
        if (argv[1] === "inspect") {
          return commandResult({ stdout: inspectJson() });
        }
        if (argv[1] === "heartbeat") {
          return commandResult({ code: 2, stderr: "unexpected argument heartbeat" });
        }
        return commandResult();
      },
      (message) => warnings.push(message),
    );
    const lease = lifecycleLease();

    try {
      await expect(provider.inspect(lease)).resolves.toStrictEqual({ status: "active" });
      await vi.advanceTimersByTimeAsync(0);
      await provider.inspect(lease);
      await vi.advanceTimersByTimeAsync(180_000);

      expect(calls.filter((argv) => argv[1] === "heartbeat")).toHaveLength(1);
      expect(warnings).toEqual([
        `Crabbox heartbeat is unavailable for worker lease ${LEASE_ID}; upgrade Crabbox to v0.44.0 or newer for \`crabbox heartbeat\`; cloud worker machines may be reaped after 60m of coordinator-idle time`,
      ]);
    } finally {
      await provider.destroy(lease);
      vi.useRealTimers();
    }
  });

  it("reports the measured heartbeat duration when the command times out", async () => {
    vi.useFakeTimers();
    const warnings: string[] = [];
    const provider = providerWithRunner(
      async (argv) => {
        if (argv[1] === "inspect") {
          return commandResult({ stdout: inspectJson() });
        }
        if (argv[1] === "heartbeat") {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 60_012);
          });
          return commandResult({ code: null, killed: true, termination: "timeout" });
        }
        return commandResult();
      },
      (message) => warnings.push(message),
    );
    const lease = lifecycleLease();

    try {
      await expect(provider.inspect(lease)).resolves.toStrictEqual({ status: "active" });
      await vi.advanceTimersByTimeAsync(60_012);

      expect(warnings).toEqual([
        "Crabbox heartbeat did not exit normally (timeout after 60012 ms); cloud worker machines may be reaped after 60m of coordinator-idle time",
      ]);
    } finally {
      await provider.destroy(lease);
      vi.useRealTimers();
    }
  });

  it("keeps heartbeat transport failures out of lifecycle operations and retries", async () => {
    vi.useFakeTimers();
    let heartbeatAttempts = 0;
    const warnings: string[] = [];
    const provider = providerWithRunner(
      async (argv) => {
        if (argv[1] === "inspect") {
          return commandResult({ stdout: inspectJson() });
        }
        if (argv[1] === "heartbeat" && heartbeatAttempts++ === 0) {
          throw new Error("transport unavailable");
        }
        return commandResult();
      },
      (message) => warnings.push(message),
    );
    const lease = lifecycleLease();

    try {
      await expect(provider.inspect(lease)).resolves.toStrictEqual({ status: "active" });
      await vi.advanceTimersByTimeAsync(0);
      expect(heartbeatAttempts).toBe(1);
      expect(warnings).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(heartbeatAttempts).toBe(2);
      expect(warnings).toHaveLength(1);
    } finally {
      await provider.destroy(lease);
      vi.useRealTimers();
    }
  });

  it("rejects non-Crabbox lifecycle lease ids before invoking the CLI", async () => {
    let invoked = false;
    const provider = providerWithRunner(async () => {
      invoked = true;
      return commandResult();
    });
    const lease = lifecycleLease("lease:not-crabbox");

    await expect(provider.inspect(lease)).rejects.toThrow("lease id is invalid");
    await expect(provider.destroy(lease)).rejects.toThrow("lease id is invalid");
    expect(invoked).toBe(false);
  });

  it.each([
    { state: "running", ready: true, expected: "active" },
    { state: "running", ready: false, expected: "active" },
    { state: "provisioning", ready: false, expected: "active" },
    ...NON_RUNNABLE_STATES.map((state) => ({ state, ready: false, expected: "unknown" })),
  ])(
    "maps inspect state $state ready=$ready to $expected without renewing lost leases",
    async ({ state, ready, expected }) => {
      vi.useFakeTimers();
      let inspection = inspectJson();
      const heartbeats = vi.fn();
      const provider = providerWithRunner(async (argv) => {
        if (argv[1] === "heartbeat") {
          heartbeats();
          return commandResult();
        }
        return commandResult({ stdout: inspection });
      });
      const lease = lifecycleLease();
      try {
        await expect(provider.inspect(lease)).resolves.toEqual({ status: "active" });
        await vi.advanceTimersByTimeAsync(0);
        expect(heartbeats).toHaveBeenCalledTimes(1);
        inspection = inspectJson({ state, ready });
        await expect(provider.inspect(lease)).resolves.toStrictEqual({ status: expected });
        await vi.advanceTimersByTimeAsync(60_000);
        expect(heartbeats).toHaveBeenCalledTimes(expected === "active" ? 2 : 1);
      } finally {
        await provider.destroy(lease);
        vi.useRealTimers();
      }
    },
  );

  it.each(NON_RUNNABLE_STATES)(
    "rejects non-runnable %s during provision even if SSH is ready",
    async (state) => {
      const calls: string[][] = [];
      const provider = providerWithRunner(async (argv) => {
        calls.push(argv);
        return argv[1] === "inspect"
          ? commandResult({ stdout: inspectJson({ state, ready: true }) })
          : commandResult();
      });
      await expect(provider.provision(CLASSLESS_PROFILE, OPERATION_ID)).rejects.toMatchObject({
        code: "invalid_profile",
        message: "Crabbox warmup lease entered a terminal state",
      });
      expect(calls.map((argv) => argv[1])).toEqual(["warmup", "inspect", "stop"]);
    },
  );

  it("maps lease recognition failures to unknown while observation failures still throw", async () => {
    const missing = providerWithRunner(async () =>
      commandResult({ code: 4, stderr: `lease/droplet not found: ${LEASE_ID}` }),
    );
    const authFailure = providerWithRunner(async () =>
      commandResult({
        code: 4,
        stderr: `credential profile not found while inspecting lease ${LEASE_ID}`,
      }),
    );
    const noLongerExists = providerWithRunner(async () =>
      commandResult({ code: 4, stderr: `unikraftcloud lease ${LEASE_ID} no longer exists` }),
    );
    const ambiguousVisibility = providerWithRunner(async () =>
      commandResult({
        code: 4,
        stderr: `nomad job for lease ${LEASE_ID} is missing or inaccessible`,
      }),
    );
    const cliMissing = providerWithRunner(async () => {
      throw new Error("spawn ENOENT");
    });

    const lease = lifecycleLease();
    await expect(missing.inspect(lease)).resolves.toStrictEqual({ status: "unknown" });
    await expect(noLongerExists.inspect(lease)).resolves.toStrictEqual({ status: "unknown" });
    await expect(authFailure.inspect(lease)).rejects.toThrow("inspect failed with exit code 4");
    await expect(ambiguousVisibility.inspect(lease)).rejects.toThrow(
      "inspect failed with exit code 4",
    );
    await expect(cliMissing.inspect(lease)).rejects.toThrow("inspect could not start");
  });

  it.each([
    { action: "warmup", termination: "exit", code: 5 },
    { action: "inspect", termination: "timeout", code: null },
  ] as const)(
    "preserves bounded, redacted terminal diagnostics for $action $termination failures",
    async ({ action, termination, code }) => {
      const secret = ["sk", "abcdefghijklmnop"].join("-");
      const terminalStderr = "Machine0 terminal stderr: provider quota exhausted";
      const terminalStdout = "Machine0 terminal stdout: quota window has not reset";
      const provider = providerWithRunner(async () =>
        commandResult({
          code,
          termination,
          killed: termination !== "exit",
          stderr: `provider warning ${secret}\n${terminalStderr}`,
          stdout: `${"provider progress ".repeat(90)}\n${terminalStdout}`,
        }),
      );
      const operation =
        action === "warmup"
          ? provider.provision({ ...PROFILE, provider: "machine0" }, OPERATION_ID)
          : provider.inspect(lifecycleLease());

      const error = await operation.catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(Error);
      const message = error instanceof Error ? error.message : "";
      const failurePrefix =
        action === "warmup"
          ? "Crabbox warmup failed with exit code 5: "
          : "Crabbox inspect did not exit normally (timeout): ";
      expect(message.startsWith(`${failurePrefix}... `)).toBe(true);
      expect(message).toContain(terminalStderr);
      expect(message).toContain(terminalStdout);
      expect(message).not.toContain(secret);
      expect(message).not.toMatch(/\s{2,}/u);
      expect(message.length).toBeLessThanOrEqual(failurePrefix.length + 512);
      expect(hasLoneSurrogate(message)).toBe(false);
    },
  );

  it.each(["stderr", "stdout"] as const)(
    "preserves UTF-16 boundaries and terminal detail from %s",
    async (stream) => {
      const terminalDetail = "😀 terminal failure";
      const provider = providerWithRunner(async () =>
        commandResult({
          code: 2,
          [stream]: `${"x".repeat(600)}😀${"y".repeat(507 - terminalDetail.length)}${terminalDetail}`,
        }),
      );

      const error = await provider.inspect(lifecycleLease()).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(Error);
      const message = error instanceof Error ? error.message : "";
      expect(message).toContain("😀 terminal failure");
      expect(message.length).toBeLessThanOrEqual(INSPECT_FAILURE_PREFIX.length + 512);
      expect(hasLoneSurrogate(message)).toBe(false);
    },
  );

  it("keeps a complete stdout boundary pair exactly at the bound", async () => {
    const detail = `${"x".repeat(510)}😀`;
    const provider = providerWithRunner(async () => commandResult({ code: 2, stdout: detail }));

    const error = await provider.inspect(lifecycleLease()).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    const message = error instanceof Error ? error.message : "";
    expect(message).toBe(`${INSPECT_FAILURE_PREFIX}${detail}`);
    expect(hasLoneSurrogate(message)).toBe(false);
  });

  it.each([
    {
      code: 5,
      stderr: `warning: could not inspect lease before release: coordinator GET http://127.0.0.1/v1/leases/${LEASE_ID}: http 404: not_found\ncoordinator accepted release for ${LEASE_ID}, but remote cleanup reported a cleanup failure or scheduled retry`,
    },
    { code: 4, stderr: `lease/server not found: ${LEASE_ID}` },
    { code: 4, stderr: `sandbox ${LEASE_ID} is not claimed by Crabbox` },
    { code: 4, stderr: `wandb sandbox "${LEASE_ID}" has no matching local ownership claim` },
    { code: 4, stderr: `unikraftcloud lease ${LEASE_ID} no longer exists` },
    ...["stopped", "released", "destroyed", "terminated"].map((state) => ({
      code: 4,
      stderr: `lease ${LEASE_ID} already ${state}`,
    })),
  ])("rejects unproven stop despite misleading prose: $stderr", async ({ code, stderr }) => {
    const calls: string[][] = [];
    const provider = providerWithRunner(async (argv) => {
      calls.push(argv);
      return commandResult({ code, stderr });
    });
    await expect(provider.destroy(lifecycleLease())).rejects.toThrow(
      `stop failed with exit code ${code}`,
    );
    expect(calls).toEqual([[SIBLING_BINARY, "stop", "--provider", "aws", "--id", LEASE_ID]]);
  });

  it("accepts producer-confirmed absence only after a normal successful stop", async () => {
    const calls: string[][] = [];
    const provider = providerWithRunner(async (argv) => {
      calls.push(argv);
      return commandResult();
    });
    await expect(provider.destroy(lifecycleLease())).resolves.toBeUndefined();
    await expect(provider.destroy(lifecycleLease())).resolves.toBeUndefined();
    expect(calls).toEqual([
      [SIBLING_BINARY, "stop", "--provider", "aws", "--id", LEASE_ID],
      [SIBLING_BINARY, "stop", "--provider", "aws", "--id", LEASE_ID],
    ]);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

describe("Crabbox binary resolution", () => {
  it("prefers explicit, then sibling, then PATH, then the bare command", () => {
    const toolsDir = path.resolve(path.sep, "tools");
    const pathBinary = path.join(toolsDir, "crabbox");
    const relativePathBinary = path.resolve("relative-tools", "crabbox");
    const explicitBinary = path.resolve(path.sep, "custom", "crabbox");

    expect(
      resolveCrabboxBinary({
        explicit: explicitBinary,
        openclawRoot: OPENCLAW_ROOT,
        isExecutable: () => false,
      }),
    ).toBe(explicitBinary);
    expect(
      resolveCrabboxBinary({
        openclawRoot: OPENCLAW_ROOT,
        pathEnv: toolsDir,
        isExecutable: (candidate) => candidate === SIBLING_BINARY || candidate === pathBinary,
      }),
    ).toBe(SIBLING_BINARY);
    expect(
      resolveCrabboxBinary({
        openclawRoot: OPENCLAW_ROOT,
        pathEnv: [path.resolve(path.sep, "not-executable"), toolsDir].join(path.delimiter),
        isExecutable: (candidate) => candidate === pathBinary,
      }),
    ).toBe(pathBinary);
    expect(
      resolveCrabboxBinary({
        openclawRoot: OPENCLAW_ROOT,
        pathEnv: "relative-tools",
        isExecutable: (candidate) => candidate === relativePathBinary,
      }),
    ).toBe(relativePathBinary);
    expect(
      resolveCrabboxBinary({
        openclawRoot: OPENCLAW_ROOT,
        pathEnv: path.resolve(path.sep, "not-executable"),
        isExecutable: () => false,
      }),
    ).toBe("crabbox");
  });

  it("distinguishes executable discovery from the dispatch fallback", () => {
    const explicitBinary = path.resolve(path.sep, "custom", "crabbox");

    expect(
      findCrabboxBinary({
        explicit: explicitBinary,
        openclawRoot: OPENCLAW_ROOT,
        isExecutable: () => false,
      }),
    ).toBeUndefined();
    expect(
      findCrabboxBinary({
        openclawRoot: OPENCLAW_ROOT,
        pathEnv: path.resolve(path.sep, "not-executable"),
        isExecutable: () => false,
      }),
    ).toBeUndefined();
  });

  it("derives the package root from source and bundled plugin roots", () => {
    expect(resolveOpenClawRoot(path.join(OPENCLAW_ROOT, "extensions", "crabbox"))).toBe(
      OPENCLAW_ROOT,
    );
    expect(resolveOpenClawRoot(path.join(OPENCLAW_ROOT, "dist", "extensions", "crabbox"))).toBe(
      OPENCLAW_ROOT,
    );
  });
});

describe("Crabbox version probe", () => {
  it.each([
    { output: "0.41.1\n", expected: { status: "supported", version: "0.41.1" } },
    { output: "crabbox 0.41.6\n", expected: { status: "supported", version: "0.41.6" } },
    { output: "0.40.9\n", expected: { status: "outdated", version: "0.40.9" } },
  ])("classifies $output", async ({ output, expected }) => {
    const run = vi
      .spyOn(processRuntime, "runCommandWithTimeout")
      .mockResolvedValue(commandResult({ stdout: output }));
    try {
      await expect(doctorRuntime.probeCrabboxVersion("/opt/crabbox")).resolves.toEqual(expected);
      expect(run).toHaveBeenCalledWith(
        ["/opt/crabbox", "--version"],
        expect.objectContaining({ timeoutMs: 2_000, killProcessTree: true }),
      );
    } finally {
      run.mockRestore();
    }
  });

  it("turns timeout into an indeterminate result", async () => {
    const run = vi
      .spyOn(processRuntime, "runCommandWithTimeout")
      .mockResolvedValue(commandResult({ code: 124, termination: "timeout" }));
    try {
      await expect(doctorRuntime.probeCrabboxVersion("/opt/crabbox")).resolves.toEqual({
        status: "indeterminate",
        reason: "version command timed out after 2000 ms",
      });
    } finally {
      run.mockRestore();
    }
  });
});
