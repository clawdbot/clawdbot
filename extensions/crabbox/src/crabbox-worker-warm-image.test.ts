import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkerProfile, WorkerProvider } from "openclaw/plugin-sdk/plugin-entry";
import { createPluginStateSyncKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { SpawnResult } from "openclaw/plugin-sdk/process-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { operationLeaseId, operationSlug, parseCrabboxProfile } from "./crabbox-worker-profile.js";
import { createCrabboxWorkerProvider } from "./crabbox-worker-provider.js";

const OPERATION_ID = `provision:v2:${"0".repeat(64)}`;
const LEASE_ID = operationLeaseId(OPERATION_ID);
const CHECKPOINT_ID = "chk_profile_warm";
const PROFILE = {
  provider: "aws",
  class: "standard",
  ttl: "24h",
  idleTimeout: "60m",
  warmImage: true,
};
const WALLPAPER_PATH = fileURLToPath(
  new URL("../assets/openclaw-worker-wallpaper.png", import.meta.url),
);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

type CommandRunner = NonNullable<Parameters<typeof createCrabboxWorkerProvider>[0]["runCommand"]>;
type CommandCall = { argv: string[]; options: Parameters<CommandRunner>[1] };

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

function createWarmProvider(
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
      if (argv[1] === "inspect") {
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
        return commandResult({
          stdout: JSON.stringify({
            id: CHECKPOINT_ID,
            kind: "aws-ebs-snapshot",
            leaseId: argv[argv.indexOf("--id") + 1],
            workdir: "/workspace",
            native: { imageId: "snap_test", state: "pending" },
          }),
        });
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
  return { provider, calls, stateDir, warn };
}

function openWarmImageStore() {
  return createPluginStateSyncKeyedStoreForTests<{
    checkpointId: string;
    kind: string;
    state: "pending" | "available";
    createdAtMs: number;
    lastUsedAtMs: number;
  }>("crabbox", { namespace: "warm-images", maxEntries: 128, overflowPolicy: "evict-oldest" });
}

async function provisionWarmProfile(
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

async function captureWarmImage(
  provider: WorkerProvider,
  profile: WorkerProfile = PROFILE,
  operationId = OPERATION_ID,
  machineClass?: string,
) {
  const lease = await provisionWarmProfile(provider, profile, operationId, machineClass);
  await provider.destroy({ leaseId: lease.leaseId, profile });
}

describe("Crabbox profile warm images", () => {
  it("reuses captured images across managers, setup environment values, and setup environment order", async () => {
    const profile = { ...PROFILE, setup: "install-node", setupEnv: ["WARM_B", "WARM_A"] };
    vi.stubEnv("WARM_A", "first-secret");
    vi.stubEnv("WARM_B", "second-secret");
    const initial = createWarmProvider();
    await captureWarmImage(initial.provider, profile);
    expect(initial.calls.filter(({ argv }) => argv[2] === "create")).toHaveLength(1);

    const identical = createWarmProvider(undefined, initial.stateDir);
    await captureWarmImage(identical.provider, {
      ...profile,
      setupEnv: [...profile.setupEnv],
    });
    expect(identical.calls.some(({ argv }) => argv[2] === "create")).toBe(false);

    vi.stubEnv("WARM_A", "changed-secret");
    const changedValues = createWarmProvider(undefined, initial.stateDir);
    await captureWarmImage(changedValues.provider, profile);
    expect(changedValues.calls.some(({ argv }) => argv[2] === "create")).toBe(false);

    const reordered = createWarmProvider(undefined, initial.stateDir);
    await captureWarmImage(reordered.provider, { ...profile, setupEnv: ["WARM_A", "WARM_B"] });
    expect(reordered.calls.some(({ argv }) => argv[2] === "create")).toBe(false);
  });

  it("captures distinct images when setup, machine class, desktop, provider, or setup environment names change", async () => {
    const profile = { ...PROFILE, setup: "install-node", setupEnv: ["WARM_B", "WARM_A"] };
    vi.stubEnv("WARM_A", "first-secret");
    vi.stubEnv("WARM_B", "second-secret");
    const { provider, calls } = createWarmProvider();
    await captureWarmImage(provider, profile);

    for (const [index, changed] of [
      { ...profile, setup: "install-other-node" },
      { ...profile, class: "fast" },
      { ...profile, desktop: true },
      { ...profile, provider: "hetzner" },
      { ...profile, setupEnv: ["WARM_A"] },
    ].entries()) {
      calls.length = 0;
      await captureWarmImage(provider, changed, `provision:v2:${String(index + 1).repeat(64)}`);
      expect(calls.filter(({ argv }) => argv[2] === "create")).toHaveLength(1);
    }
  });

  it("keeps warm images disabled by default and rejects non-boolean opt-ins", () => {
    const { warmImage, ...withoutWarmImage } = PROFILE;
    expect(warmImage).toBe(true);
    expect(parseCrabboxProfile(withoutWarmImage).warmImage).toBe(false);
    expect(() => parseCrabboxProfile({ ...PROFILE, warmImage: "yes" })).toThrow(
      "Crabbox profile warmImage must be a boolean",
    );
  });

  it("never invokes checkpoint commands when warm images are disabled", async () => {
    const { provider, calls } = createWarmProvider();
    const profile = { ...PROFILE, warmImage: false };
    const lease = await provisionWarmProfile(provider, profile);

    await provider.destroy({ leaseId: lease.leaseId, profile });

    expect(calls.some(({ argv }) => argv[1] === "checkpoint")).toBe(false);
    expect(calls.at(-1)?.argv[1]).toBe("stop");
  });

  it("scrubs every worker identity and workspace before capturing an enrolled lease", async () => {
    const { provider, calls } = createWarmProvider();
    const lease = await provisionWarmProfile(provider);
    calls.length = 0;

    await provider.destroy({ leaseId: lease.leaseId, profile: PROFILE });

    expect(calls.map(({ argv }) => argv.slice(1, argv[1] === "checkpoint" ? 3 : 2))).toEqual([
      ["run"],
      ["checkpoint", "create"],
      ["stop"],
    ]);
    const scrub = calls[0];
    expect(scrub?.argv).toContain("--script-stdin");
    expect(scrub?.options.input).toContain("$HOME/.openclaw/cloud-workers");
    expect(scrub?.options.input).toContain("kill -TERM");
    expect(scrub?.options.input).toContain("kill -KILL");
    expect(scrub?.options.input).toContain('rm -rf "$worker_root"');
    // Capture phases ride a full crabbox run/snapshot round trip; 60s starves
    // them under coordinator latency (live-measured on AWS 2026-08-26).
    expect(scrub?.options.timeoutMs).toBe(180_000);
    expect(calls[1]?.options.timeoutMs).toBe(180_000);
    const home = tempDirs.make("openclaw-crabbox-warm-scrub-");
    const workspace = path.join(
      home,
      ".openclaw",
      "cloud-workers",
      LEASE_ID,
      "node-host",
      "gateway",
      "workspaces",
      "session",
    );
    const npmCache = path.join(home, ".npm", "cached-package");
    const bin = path.join(home, "bin");
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(path.dirname(npmCache), { recursive: true });
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "ps"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    fs.writeFileSync(path.join(workspace, "private.txt"), "session workspace bytes");
    fs.writeFileSync(npmCache, "reusable npm package");
    execFileSync("/bin/sh", ["-c", String(scrub?.options.input)], {
      env: { ...process.env, HOME: home, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` },
    });
    expect(fs.existsSync(path.join(home, ".openclaw", "cloud-workers"))).toBe(false);
    expect(fs.readFileSync(npmCache, "utf8")).toBe("reusable npm package");
    expect(calls[1]?.argv.slice(1)).toEqual([
      "checkpoint",
      "create",
      "--provider",
      "aws",
      "--id",
      LEASE_ID,
      "--mode",
      "native",
      "--wait=false",
      "--json",
    ]);
    calls.length = 0;
    await provisionWarmProfile(provider, PROFILE, `provision:v2:${"2".repeat(64)}`);
    expect(calls.some(({ argv }) => argv[2] === "inspect")).toBe(true);
    expect(calls.find(({ argv }) => argv[2] === "fork")?.argv[3]).toBe(CHECKPOINT_ID);
    expect(calls.some(({ argv }) => argv[1] === "warmup")).toBe(false);
  });

  it.each([
    { action: "run", name: "scrub fails", result: { code: 7, stderr: "scrub failed" } },
    {
      action: "run",
      name: "scrub times out",
      result: { code: null, killed: true, termination: "timeout" as const },
    },
    { action: "create", name: "capture fails", result: { code: 7, stderr: "snapshot failed" } },
    {
      action: "create",
      name: "capture times out",
      result: { code: null, killed: true, termination: "timeout" as const },
    },
    {
      action: "create",
      name: "an older Crabbox rejects JSON output",
      result: { code: 2, stderr: "flag provided but not defined: -json" },
    },
    { action: "create", name: "capture returns malformed JSON", result: { stdout: "{" } },
  ])("warns once and still stops the enrolled lease when $name", async ({ action, result }) => {
    let tearingDown = false;
    const { provider, calls, warn } = createWarmProvider(({ argv }) => {
      if (tearingDown && (argv[1] === action || argv[2] === action)) {
        return commandResult(result);
      }
      return undefined;
    });
    const lease = await provisionWarmProfile(provider);
    tearingDown = true;

    await expect(
      provider.destroy({ leaseId: lease.leaseId, profile: PROFILE }),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledOnce();
    expect(calls.at(-1)?.argv[1]).toBe("stop");

    tearingDown = false;
    calls.length = 0;
    await captureWarmImage(provider);
    expect(calls.some(({ argv }) => argv[1] === "warmup")).toBe(true);
    expect(calls.filter(({ argv }) => argv[2] === "create")).toHaveLength(1);
  });

  it("never captures a half-configured lease during failed provisioning cleanup", async () => {
    const { provider, calls } = createWarmProvider(({ argv, options }) =>
      argv[1] === "run" && options.input === "install-node"
        ? commandResult({ code: 7, stderr: "setup failed" })
        : undefined,
    );

    await expect(
      provisionWarmProfile(provider, { ...PROFILE, setup: "install-node" }),
    ).rejects.toThrow("Crabbox setup failed");

    expect(calls.some(({ argv }) => argv[1] === "checkpoint")).toBe(false);
    expect(calls.at(-1)?.argv[1]).toBe("stop");
  });

  it("captures and restores placement overrides under their actual machine-class image key", async () => {
    const { provider, calls } = createWarmProvider();
    await captureWarmImage(provider, PROFILE, OPERATION_ID, "fast");

    calls.length = 0;
    await provisionWarmProfile(provider, PROFILE, `provision:v2:${"1".repeat(64)}`);
    expect(calls.some(({ argv }) => argv[1] === "warmup")).toBe(true);
    expect(calls.some(({ argv }) => argv[2] === "fork")).toBe(false);

    const nextOperation = `provision:v2:${"2".repeat(64)}`;
    calls.length = 0;
    await provisionWarmProfile(provider, PROFILE, nextOperation, "fast");
    const fork = calls.find(({ argv }) => argv[2] === "fork")?.argv;
    expect(fork?.[fork.indexOf("--lease-id") + 1]).toBe(operationLeaseId(nextOperation));
    expect(fork?.[fork.indexOf("--class") + 1]).toBe("fast");
  });

  it("captures the persisted effective machine class after a Gateway restart rearms heartbeat", async () => {
    const initial = createWarmProvider();
    const lease = await provisionWarmProfile(initial.provider, PROFILE, OPERATION_ID, "fast");
    initial.provider.dispose();

    const restarted = createWarmProvider(undefined, initial.stateDir);
    await restarted.provider.inspect({ leaseId: lease.leaseId, profile: PROFILE });
    await restarted.provider.destroy({ leaseId: lease.leaseId, profile: PROFILE });

    expect(restarted.calls.filter(({ argv }) => argv[2] === "create")).toHaveLength(1);

    restarted.calls.length = 0;
    await provisionWarmProfile(restarted.provider, PROFILE, `provision:v2:${"1".repeat(64)}`);
    expect(restarted.calls.some(({ argv }) => argv[1] === "warmup")).toBe(true);
    expect(restarted.calls.some(({ argv }) => argv[2] === "fork")).toBe(false);

    restarted.calls.length = 0;
    await provisionWarmProfile(
      restarted.provider,
      PROFILE,
      `provision:v2:${"2".repeat(64)}`,
      "fast",
    );
    const fork = restarted.calls.find(({ argv }) => argv[2] === "fork")?.argv;
    expect(fork?.[fork.indexOf("--class") + 1]).toBe("fast");
  });

  it("never snapshots an inspected lease whose effective machine class is unknown", async () => {
    const { provider, calls } = createWarmProvider();
    const lease = { leaseId: LEASE_ID, profile: PROFILE };

    await provider.inspect(lease);
    await provider.destroy(lease);

    expect(calls.some(({ argv }) => argv[1] === "checkpoint")).toBe(false);
    expect(calls.at(-1)?.argv[1]).toBe("stop");
  });

  it("forks an available image into the exact operation-owned lease before normal enrollment", async () => {
    const { provider, calls } = createWarmProvider();
    await captureWarmImage(provider);
    calls.length = 0;

    await expect(provisionWarmProfile(provider)).resolves.toMatchObject({
      leaseId: LEASE_ID,
      node: { deviceId: "device-1" },
    });

    expect(calls.some(({ argv }) => argv[1] === "warmup")).toBe(false);
    expect(calls.find(({ argv }) => argv[2] === "fork")?.argv.slice(1)).toEqual([
      "checkpoint",
      "fork",
      CHECKPOINT_ID,
      "--provider",
      "aws",
      "--lease-id",
      LEASE_ID,
      "--class",
      "standard",
      "--slug",
      operationSlug(OPERATION_ID),
      "--json",
    ]);
    expect(calls.some(({ argv }) => argv[1] === "inspect")).toBe(true);
    expect(calls.some(({ argv, options }) => argv[1] === "run" && options.input)).toBe(true);
  });

  it.each([
    { name: "the fork fails", result: { code: 7, stderr: "snapshot unavailable" } },
    {
      name: "an older Crabbox rejects fixed lease IDs",
      result: { code: 2, stderr: "unknown flag: --lease-id" },
    },
    { name: "the fork returns malformed JSON", result: { stdout: "{" } },
  ])("falls back to cold warmup with the same fixed lease when $name", async ({ result }) => {
    const { provider, calls, warn } = createWarmProvider(({ argv }) =>
      argv[2] === "fork" ? commandResult(result) : undefined,
    );
    await captureWarmImage(provider);
    calls.length = 0;

    await expect(provisionWarmProfile(provider)).resolves.toMatchObject({ leaseId: LEASE_ID });

    const fork = calls.find(({ argv }) => argv[2] === "fork")?.argv;
    const warmup = calls.find(({ argv }) => argv[1] === "warmup")?.argv;
    expect(fork?.[fork.indexOf("--lease-id") + 1]).toBe(LEASE_ID);
    expect(warmup?.[warmup.indexOf("--lease-id") + 1]).toBe(LEASE_ID);
    expect(warn).toHaveBeenCalledOnce();
  });

  it.each([
    { providerState: "available", expectedCommand: "fork", retained: true },
    { providerState: "missing", expectedCommand: "warmup", retained: false },
    { providerState: undefined, expectedCommand: "warmup", retained: false },
  ])(
    "verifies pending images and uses $expectedCommand when provider state is $providerState",
    async ({ providerState, expectedCommand, retained }) => {
      const { provider, calls } = createWarmProvider(({ argv }) =>
        argv[2] === "inspect"
          ? commandResult({
              stdout: JSON.stringify({
                localState: "available",
                ...(providerState ? { providerState } : {}),
                nextAction: providerState === "available" ? "fork" : "delete",
              }),
            })
          : undefined,
      );
      await captureWarmImage(provider);
      calls.length = 0;

      const lease = await provisionWarmProfile(provider);

      expect(
        calls.some(({ argv }) => argv[1] === expectedCommand || argv[2] === expectedCommand),
      ).toBe(true);
      if (retained) {
        await provider.destroy({ leaseId: lease.leaseId, profile: PROFILE });
        expect(calls.some(({ argv }) => argv[2] === "create")).toBe(false);
      } else {
        expect(calls.some(({ argv }) => argv[2] === "delete")).toBe(true);
        await provider.destroy({ leaseId: lease.leaseId, profile: PROFILE });
        expect(calls.filter(({ argv }) => argv[2] === "create")).toHaveLength(1);
      }
    },
  );

  it("deletes the provider snapshot before forgetting an image unused for fourteen days", async () => {
    const { provider, calls } = createWarmProvider();
    await captureWarmImage(provider);
    const expiredAt = Date.now() + 14 * 24 * 60 * 60 * 1_000;
    vi.spyOn(Date, "now").mockReturnValue(expiredAt);
    calls.length = 0;

    await provisionWarmProfile(provider);

    expect(calls.find(({ argv }) => argv[2] === "delete")?.argv.slice(1)).toEqual([
      "checkpoint",
      "delete",
      CHECKPOINT_ID,
    ]);
    expect(calls.some(({ argv }) => argv[1] === "warmup")).toBe(true);
    expect(calls.some(({ argv }) => argv[2] === "fork")).toBe(false);
  });

  it("deletes the least-recently-used provider snapshot before admitting a 129th image", async () => {
    const { provider, calls } = createWarmProvider();
    const store = openWarmImageStore();
    const now = Date.now();
    for (let index = 0; index < 128; index += 1) {
      store.register(`image-${index}`, {
        checkpointId: `chk_image_${index}`,
        kind: "aws-ebs-snapshot",
        state: "available",
        createdAtMs: now,
        lastUsedAtMs: now - (index === 42 ? 1_000 : 0),
      });
    }

    await captureWarmImage(provider);

    const deleted = calls.findIndex(({ argv }) => argv[2] === "delete");
    const created = calls.findIndex(({ argv }) => argv[2] === "create");
    expect(calls[deleted]?.argv.slice(1)).toEqual(["checkpoint", "delete", "chk_image_42"]);
    expect(deleted).toBeLessThan(created);
    expect(store.lookup("image-42")).toBeUndefined();
    expect(store.lookup("image-0")?.checkpointId).toBe("chk_image_0");
    expect(store.entries()).toHaveLength(128);
  });

  it("replaces an abandoned empty reservation after a manager restart", async () => {
    const initial = createWarmProvider();
    await captureWarmImage(initial.provider);
    const store = openWarmImageStore();
    const [image] = store.entries();
    if (!image) {
      throw new Error("Expected a captured warm image");
    }
    store.register(image.key, {
      ...image.value,
      checkpointId: "",
      createdAtMs: Date.now() - 360_001,
    });

    const restarted = createWarmProvider(undefined, initial.stateDir);
    await captureWarmImage(restarted.provider);

    expect(restarted.calls.filter(({ argv }) => argv[2] === "create")).toHaveLength(1);
    expect(restarted.calls.some(({ argv }) => argv[2] === "delete")).toBe(false);
    expect(store.lookup(image.key)?.checkpointId).toBe(CHECKPOINT_ID);
  });

  it("reserves one capture when enrolled leases with the same profile stop concurrently", async () => {
    let releaseScrub!: () => void;
    const scrubBlocked = new Promise<void>((resolve) => {
      releaseScrub = resolve;
    });
    let capturing = false;
    const { provider, calls } = createWarmProvider(async ({ argv }) => {
      if (capturing && argv[1] === "run") {
        await scrubBlocked;
      }
      return undefined;
    });
    const first = await provisionWarmProfile(provider);
    const secondOperationId = `provision:v2:${"1".repeat(64)}`;
    const second = await provisionWarmProfile(provider, PROFILE, secondOperationId);
    capturing = true;

    const firstDestroy = provider.destroy({ leaseId: first.leaseId, profile: PROFILE });
    await vi.waitFor(() =>
      expect(
        calls.some(
          ({ argv, options }) =>
            argv[1] === "run" && options.input?.toString().includes("kill -TERM"),
        ),
      ).toBe(true),
    );
    const secondDestroy = provider.destroy({ leaseId: second.leaseId, profile: PROFILE });
    await secondDestroy;
    releaseScrub();
    await firstDestroy;

    expect(calls.filter(({ argv }) => argv[2] === "create")).toHaveLength(1);
    expect(calls.filter(({ argv }) => argv[1] === "stop")).toHaveLength(2);
  });
});
